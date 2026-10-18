import { appState, getCurrentPlacements, getDeviceById } from '../core/state.js';
import { DEVICE_TYPES } from '../core/constants.js';
import { resetLinkCreationState, endLinkMode } from '../core/link-mode.js';
import { eventBus } from '../core/event-bus.js';
import { render } from '../canvas/renderer.js';
import { isCurrentUserAdmin, requireAdminUiAction } from './access-control.js';
import { hasResourceConflict } from '../core/save-queue.js';
import { syncLinkModeButton } from './toolbar-controls.js';
import { openWorkspaceNavigation } from './workspace-navigation.js';

const initializedListButtons = new WeakSet();

export function initWiringControls() {
    const list = document.getElementById('wiring-open-list');
    if (!list || initializedListButtons.has(list)) return;
    initializedListButtons.add(list);
    list.addEventListener('click', () => openWorkspaceNavigation({ tab: 'links' }));
}

export function closeWiringControls({ restoreFocus = true } = {}) {
    endLinkMode();
    syncLinkModeButton();
    render();
    if (restoreFocus) document.getElementById('linkBtn')?.focus();
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
    const reselect = element('button', 'wiring-reselect-source', 'btn btn-secondary btn-sm', '接続元を選び直す');
    reselect.type = 'button';
    reselect.addEventListener('click', () => {
        resetLinkCreationState();
        renderWiringControls();
        render();
        document.getElementById('linkBtn')?.focus();
    });
    content.append(source, fixedLabel, instruction, reselect);
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
    if (panel.hidden) return;
    const source = appState.linkSourceId == null ? null : getDeviceById(appState.linkSourceId);
    const isPlaced = source && getCurrentPlacements().some(row => Number(row.device_id) === Number(source.id));
    if (!isPlaced) resetLinkCreationState();
    if (!document.getElementById('wiring-instruction')) buildControls(content);
    const name = document.getElementById('wiring-source-name');
    name.textContent = isPlaced ? source.name || '(名称未設定)' : '未選択';
    name.title = name.textContent;
    name.classList.toggle('wiring-source-unselected', !isPlaced);
    const icon = document.getElementById('wiring-source-icon');
    icon.style.visibility = isPlaced ? 'visible' : 'hidden';
    if (isPlaced) icon.src = (DEVICE_TYPES[source.type] || DEVICE_TYPES.other).icon;
    else icon.removeAttribute('src');
    const ip = document.getElementById('wiring-source-ip');
    ip.textContent = isPlaced ? source.ip || '' : '';
    ip.title = ip.textContent;
    ip.hidden = !ip.textContent;
    const fixed = document.getElementById('wiring-source-fixed');
    fixed.checked = Boolean(appState.linkSourceFixed);
    fixed.disabled = !isPlaced || appState.authExpired || appState.isPinging || hasResourceConflict('views', appState.currentViewId);
    document.getElementById('wiring-source-fixed-label').classList.toggle('wiring-source-fixed-disabled', fixed.disabled);
    document.getElementById('wiring-reselect-source').disabled = !isPlaced;
    document.getElementById('wiring-instruction').textContent = !isPlaced
        ? '接続元の機器を選択してください'
        : appState.linkSourceFixed && appState.linkSourceConnected
            ? '次の接続先を選択してください' : '接続先の機器を選択してください';
}

eventBus.on('wiring:render', renderWiringControls);
eventBus.on('canvas:render-complete', renderWiringControls);
eventBus.on('ui:busy-ended', renderWiringControls);
eventBus.on('save-state:changed', renderWiringControls);
eventBus.on('resource:conflict', renderWiringControls);
eventBus.on('wiring:close', () => closeWiringControls({ restoreFocus: false }));
eventBus.on('resources:reloaded', () => closeWiringControls({ restoreFocus: false }));
eventBus.on('resources:ids-remapped', renderWiringControls);
eventBus.on('resource:reloaded', ({ kind, id }) => {
    if (kind === 'views' && Number(id) === Number(appState.currentViewId)) closeWiringControls({ restoreFocus: false });
    else renderWiringControls();
});
