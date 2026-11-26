import { appState, getCurrentPlacements, getDeviceById, resetLinkCreationState } from '../core/state.js';
import { DEVICE_TYPES } from '../core/constants.js';
import {
    endLinkMode, canEditLinkCreation, getLinkCreationTarget,
    getExistingLinkCreationConnections, cancelLinkCreationTarget, chooseLinkCreationTarget, submitLinkCreationTarget
} from '../core/link-mode.js';
import { eventBus } from '../core/event-bus.js';
import { render } from '../canvas/renderer.js';
import { isCurrentUserAdmin, requireAdminUiAction } from './access-control.js';
import { hasResourceConflict } from '../core/save-queue.js';
import { syncLinkModeButton } from './toolbar-controls.js';
import { openWorkspaceNavigation } from './workspace-navigation.js';
import { viewHierarchyPath } from '../core/building-hierarchy.js';
import { buildViewOptionLabel } from '../core/view-format.js';
import { describeLinkPorts, formatLinkEndpoint, openLinkPanel } from './property-panel.js';
import { mappedResourceId } from '../core/resource-save.js';

const el = id => document.getElementById(id);
let displayedSourceId = null;
let displayedTargetId = null;
let displayedOptions = '';
let displayedExisting = '';

const initializedListButtons = new WeakSet();

export function initWiringControls() {
    const list = document.getElementById('wiring-open-list');
    if (!list || initializedListButtons.has(list)) return;
    initializedListButtons.add(list);
    list.addEventListener('click', () => openWorkspaceNavigation({ tab: 'links', reviewLegacy: Boolean(appState.legacyLinkCreation) }));
    el('wiring-target-query')?.addEventListener('input', renderTargetSearch);
    el('wiring-target-device')?.addEventListener('change', syncChooseButton);
    el('wiring-target-choose')?.addEventListener('click', () => {
        if (!chooseLinkCreationTarget(el('wiring-target-device').value)) return;
        renderWiringControls();
        el(el('wiring-target-ports').hidden ? 'wiring-target-add' : 'wiring-from-port').focus();
    });
    el('wiring-target-cancel')?.addEventListener('click', () => {
        cancelLinkCreationTarget();
        render();
        el('wiring-target-query').focus();
    });
    el('wiring-target-form')?.addEventListener('submit', async event => {
        event.preventDefault();
        const needsPorts = !el('wiring-target-ports').hidden;
        const legacy = appState.legacyLinkCreation;
        const created = submitLinkCreationTarget(needsPorts ? el('wiring-from-port').value : '',
            needsPorts ? el('wiring-to-port').value : '');
        if (!created) return;
        if (legacy) syncLinkModeButton();
        render();
        el(legacy ? 'palette-nav-btn' : appState.linkSourceFixed ? 'wiring-target-query' : 'linkBtn')?.focus();
        await created;
        if (legacy) render();
    });
}

export function closeWiringControls({ restoreFocus = true } = {}) {
    const focusId = appState.legacyLinkCreation ? 'palette-nav-btn' : 'linkBtn';
    endLinkMode();
    syncLinkModeButton();
    render();
    if (restoreFocus) el(focusId)?.focus();
}

function element(tag, id, className = '', text = '') {
    const node = document.createElement(tag);
    node.id = id;
    node.className = className;
    node.textContent = text;
    return node;
}

function buildControls(content) {
    const source = element('div', 'wiring-source-info', 'wiring-source-info');
    const sourceRow = element('div', '', 'wiring-source-row');
    const icon = element('img', 'wiring-source-icon', 'wiring-source-icon');
    icon.width = 22;
    icon.height = 22;
    icon.alt = '';
    icon.setAttribute('aria-hidden', 'true');
    const details = element('div', '', 'wiring-source-details');
    details.append(element('strong', 'wiring-source-name'), element('span', 'wiring-source-ip', 'wiring-source-ip'));
    sourceRow.append(icon, details);
    source.append(element('span', '', 'wiring-source-label', '接続元'), sourceRow);
    const fixedLabel = element('label', 'wiring-source-fixed-label', 'wiring-source-fixed');
    const fixed = element('input', 'wiring-source-fixed');
    fixed.type = 'checkbox';
    fixed.addEventListener('change', () => {
        if (!requireAdminUiAction() || !appState.linkMode || appState.linkSourceId == null ||
            appState.authExpired || hasResourceConflict('views', appState.currentViewId)) {
            renderWiringControls();
            return;
        }
        appState.linkSourceFixed = fixed.checked;
        renderWiringControls();
    });
    fixedLabel.append(fixed, element('span', '', '', '接続元を固定して連続作成'));
    const instruction = element('p', 'wiring-instruction');
    instruction.setAttribute('role', 'status');
    instruction.setAttribute('aria-live', 'polite');
    const reselect = element('button', 'wiring-reselect-source', 'btn btn-secondary btn-sm', '選び直す');
    reselect.setAttribute('aria-label', '接続元を選び直す');
    reselect.type = 'button';
    reselect.addEventListener('click', () => {
        resetLinkCreationState();
        renderWiringControls();
        render();
        document.getElementById('linkBtn')?.focus();
    });
    sourceRow.append(reselect);
    content.append(source, fixedLabel, instruction);
}

function syncChooseButton() {
    el('wiring-target-choose').disabled = !canEditLinkCreation() || !el('wiring-target-device').value;
}

function findRemoteTargets(query) {
    const placedHere = new Set(getCurrentPlacements().map(row => Number(row.device_id)));
    const legacy = appState.legacyLinkCreation;
    const viewLabels = new Map(appState.views.map(view => [Number(view.id), buildViewOptionLabel(view)]));
    const placements = new Map();
    const add = (deviceId, viewId) => {
        const label = viewLabels.get(Number(viewId));
        if (!label) return;
        const id = Number(deviceId);
        if (!placements.has(id)) placements.set(id, new Set());
        if (legacy && Number(viewId) === Number(appState.currentViewId)) placedHere.add(id);
        placements.get(id).add(label);
    };
    for (const { device_id, view_id } of appState.placements) add(device_id, view_id);
    for (const { device_id, view_id } of appState.rackMounts) add(device_id, view_id);
    const shelves = new Map(appState.rackShelves.map(row => [Number(row.id), row.view_id]));
    for (const { device_id, shelf_id } of appState.rackShelfDevices) add(device_id, shelves.get(Number(shelf_id)));
    const words = query.normalize('NFKC').toLocaleLowerCase().trim().split(/\s+/u);
    return appState.devices.flatMap(device => {
        const id = Number(device.id);
        if (legacy ? id !== Number(legacy.payload.to_id) : placedHere.has(id)) return [];
        const views = placements.get(id);
        const placement = placedHere.has(id) ? '表示中のビュー' :
            views ? `他ビュー：${[...views].join('、')}` : '全ビュー未配置';
        const location = viewHierarchyPath(device, appState);
        const label = `${formatLinkEndpoint(device)} [#${id}]｜${placement}｜設置：${location}`;
        const haystack = `${label} ${device.location || ''} ${device.model || ''}`.normalize('NFKC').toLocaleLowerCase();
        return words.every(word => haystack.includes(word)) ? [[String(id), label]] : [];
    });
}

function renderTargetSearch() {
    const search = el('wiring-target-search');
    if (!search || search.hidden) return;
    const query = el('wiring-target-query');
    const select = el('wiring-target-device');
    const hasQuery = Boolean(query.value.trim());
    const options = hasQuery ? findRemoteTargets(query.value) : [];
    const stamp = JSON.stringify([hasQuery, options]);
    if (displayedOptions !== stamp) {
        const chosen = select.value;
        select.replaceChildren(
            element('option', '', '', options.length ? '接続先を選択' :
                hasQuery ? '該当する機器はありません' : '検索文字を入力してください'),
            ...options.map(([id, text]) => {
                const option = element('option', '', '', text);
                option.value = id;
                return option;
            })
        );
        select.children[0].value = '';
        select.value = chosen && options.some(([id]) => id === chosen) ? chosen : '';
        displayedOptions = stamp;
    }
    query.disabled = !canEditLinkCreation();
    select.disabled = query.disabled || !options.length;
    syncChooseButton();
}

function renderTargetForm(source, target = null) {
    const search = el('wiring-target-search');
    const form = el('wiring-target-form');
    if (!search || !form) return;
    const sourceId = source ? Number(source.id) : null;
    const targetId = target ? Number(target.id) : null;
    const legacy = appState.legacyLinkCreation;
    el('wiring-target-query-label').textContent = legacy ? '接続先の機器を検索' : '他ビュー・未配置の機器を検索';
    search.hidden = !source || Boolean(target);
    form.hidden = !target;
    if (displayedSourceId !== sourceId || displayedTargetId !== targetId) {
        if (displayedSourceId !== sourceId) {
            el('wiring-target-query').value = '';
            displayedOptions = '';
        }
        el('wiring-from-port').value = '';
        el('wiring-to-port').value = '';
        el('wiring-existing').open = false;
        displayedSourceId = sourceId;
        displayedTargetId = targetId;
    }
    if (!target) {
        renderTargetSearch();
        return;
    }
    el('wiring-target-name').textContent = target.name || `機器 #${target.id}`;
    const existing = getExistingLinkCreationConnections().map(link => [link.id, describeLinkPorts(link, sourceId)]);
    el('wiring-existing').hidden = !existing.length;
    el('wiring-target-ports').hidden = !legacy && !existing.length;
    const legacyPorts = el('wiring-legacy-ports');
    legacyPorts.hidden = !legacy;
    if (legacy) {
        legacyPorts.textContent = `未移行ポート（参考）：${legacy.payload.from_port || '未指定'} → ${legacy.payload.to_port || '未指定'}`;
    }
    el('wiring-existing-message').textContent = `既存接続 ${existing.length}件・詳細`;
    const list = el('wiring-existing-links');
    const stamp = JSON.stringify(existing);
    if (displayedExisting !== stamp) {
        list.replaceChildren(...existing.map(([id, text]) => {
            const row = element('li', '');
            const button = element('button', '', 'btn btn-secondary btn-sm link-detail-choice', text);
            button.type = 'button';
            button.addEventListener('click', async () => {
                const link = appState.links.find(row => Number(row.id) === Number(id));
                if (link && await openLinkPanel(link)) el('lp-label')?.focus();
            });
            row.append(button);
            return row;
        }));
        displayedExisting = stamp;
    }
    const disabled = !canEditLinkCreation();
    for (const id of ['wiring-from-port', 'wiring-to-port', 'wiring-target-add']) el(id).disabled = disabled;
}

export function renderWiringControls() {
    const panel = document.getElementById('wiring-controls');
    const content = document.getElementById('wiring-controls-content');
    if (!panel || !content) return;
    if (!isCurrentUserAdmin() && appState.linkMode) {
        endLinkMode();
        syncLinkModeButton();
        render();
    }
    panel.hidden = !appState.linkMode;
    document.getElementById('linkBtn')?.setAttribute('aria-expanded', String(!panel.hidden));
    if (panel.hidden) {
        renderTargetForm(null);
        return;
    }
    const source = appState.linkSourceId == null ? null : getDeviceById(appState.linkSourceId);
    const legacy = appState.legacyLinkCreation;
    const hasSource = source && (legacy || getCurrentPlacements().some(row => Number(row.device_id) === Number(source.id)));
    if (!hasSource) resetLinkCreationState();
    if (!document.getElementById('wiring-instruction')) buildControls(content);
    const name = document.getElementById('wiring-source-name');
    name.textContent = hasSource ? source.name || '(名称未設定)' : '未選択';
    name.title = name.textContent;
    name.classList.toggle('wiring-source-unselected', !hasSource);
    const icon = document.getElementById('wiring-source-icon');
    icon.style.visibility = hasSource ? 'visible' : 'hidden';
    if (hasSource) icon.src = (DEVICE_TYPES[source.type] || DEVICE_TYPES.other).icon;
    else icon.removeAttribute('src');
    const ip = document.getElementById('wiring-source-ip');
    ip.textContent = hasSource ? source.ip || '' : '';
    ip.title = ip.textContent;
    ip.hidden = !ip.textContent;
    const fixed = document.getElementById('wiring-source-fixed');
    fixed.checked = Boolean(appState.linkSourceFixed);
    fixed.disabled = !hasSource || appState.authExpired || appState.isPinging || hasResourceConflict('views', appState.currentViewId);
    const fixedLabel = el('wiring-source-fixed-label');
    fixedLabel.hidden = Boolean(legacy);
    fixedLabel.classList.toggle('wiring-source-fixed-disabled', fixed.disabled);
    const reselect = el('wiring-reselect-source');
    reselect.hidden = Boolean(legacy);
    reselect.disabled = !hasSource;
    const target = hasSource ? getLinkCreationTarget() : null;
    const instruction = el('wiring-instruction');
    instruction.hidden = Boolean(target);
    if (legacy && !target) {
        const oldTarget = getDeviceById(legacy.payload.to_id);
        instruction.textContent = `接続先の機器「${oldTarget?.name || `#${legacy.payload.to_id}`}」を選択してください`;
    } else {
        instruction.textContent = !hasSource
            ? '接続元の機器を選択してください'
            : target ? '' : appState.linkSourceFixed && appState.linkSourceConnected
                ? '次の接続先を選択してください' : '接続先の機器を選択してください';
    }
    renderTargetForm(hasSource ? source : null, target);
}

eventBus.on('wiring:connection-created', link => openLinkPanel(link));
eventBus.on('link-systems:changed', renderWiringControls);
eventBus.on('wiring:render', renderWiringControls);
eventBus.on('canvas:render-complete', renderWiringControls);
eventBus.on('ui:busy-ended', renderWiringControls);
eventBus.on('save-state:changed', renderWiringControls);
eventBus.on('resource:conflict', renderWiringControls);
eventBus.on('wiring:close', () => closeWiringControls({ restoreFocus: false }));
eventBus.on('resources:reloaded', () => closeWiringControls({ restoreFocus: false }));
eventBus.on('resources:ids-remapped', maps => {
    displayedSourceId = mappedResourceId(maps.devices, displayedSourceId);
    displayedTargetId = mappedResourceId(maps.devices, displayedTargetId);
    renderWiringControls();
});
eventBus.on('resource:reloaded', ({ kind, id }) => {
    if (kind === 'views' && Number(id) === Number(appState.currentViewId)) closeWiringControls({ restoreFocus: false });
    else renderWiringControls();
});
