import { getRackDeviceMounts } from '../core/device-placement.js';
/**
 * Netarium - ui/workspace-navigation.js
 *
 * 表示中ビューの機器・接続をキーボードでも操作できる一覧。
 * 個別選択と一括設定のチェックは独立して扱う。
 */
import { appState, getCurrentPlacements, getCurrentView, getDeviceById } from '../core/state.js';
import { DEVICE_TYPES } from '../core/constants.js';
import { eventBus } from '../core/event-bus.js';
import { filterWorkspaceLinks, resolveWorkspaceLinks } from '../core/link-bulk-data.js';
import { excludeLegacyLink, resolveViewLegacyConflicts } from '../core/legacy-link-review.js';
import { legacyVlanEndpoints, legacyVlansForDevices, unmigratedVlanForLink } from '../core/legacy-link-vlans.js';
import { getPendingSave, isSaveInFlight } from '../core/save-queue.js';
import { deleteUnmigratedVlan } from '../modals/ledger-legacy-vlans.js';
import { hasUnappliedLinkPanelChanges } from './property-panel.js';
import { getLinkSystem, getLinkColor } from '../core/link-systems.js';
import { mappedResourceId, remapResourceSet } from '../core/resource-save.js';
import { getTopModalContainer } from '../core/modal-focus.js';
import { focusDevicePlacement, onLinkClick } from '../canvas/renderer.js';
import { getDeviceStatusDescription } from '../core/device-monitoring.js';
import { isCurrentUserAdmin, requireAdminUiAction } from './access-control.js';
import { getOpenBuildingId } from './building-view.js';
import { showToast } from './toast.js';
import { toggleLinkMode } from './toolbar.js';
import { openLinkBulkModal } from '../modals/link-bulk-modal.js';

let isNavOpen = false;
let activeTab = 'devices';
let selectionViewId = null;
let searchQuery = '';
let excludingLegacyLink = false;
let reviewingLegacyVlan = false;
let syncLegacyVlanReview = () => {};
const selectedLinkIds = new Set();

function syncSelection(links) {
    const viewId = appState.currentViewId == null ? null : Number(appState.currentViewId);
    if (viewId !== selectionViewId) {
        selectionViewId = viewId;
        selectedLinkIds.clear();
        searchQuery = '';
    }
    if (selectedLinkIds.size) {
        const available = new Set((links ?? resolveWorkspaceLinks(getCurrentView(), appState)).map(link => Number(link.id)));
        for (const id of selectedLinkIds) if (!available.has(id)) selectedLinkIds.delete(id);
    }
    // 閲覧権限へ変わった場合は以前の編集用選択を持ち越さない。
    if (!isCurrentUserAdmin() || appState.authExpired) selectedLinkIds.clear();
}

export function getWorkspaceSelectedLinkIds() {
    syncSelection();
    return [...selectedLinkIds];
}

function workspacePlacements(view) {
    if (view.view_type !== 'rack') return getCurrentPlacements();
    return [...new Map(getRackDeviceMounts(appState)
        .filter(mount => Number(mount.view_id) === Number(view.id) && getDeviceById(mount.device_id))
        .map(mount => [Number(mount.device_id), mount])).values()];
}

function workspaceLegacyVlans(view, placements = view && workspacePlacements(view)) {
    return view && appState.legacyLinkVlans.length
        ? legacyVlansForDevices(new Set(placements.map(row => Number(row.device_id))))
        : [];
}

export function toggleWorkspaceNavigation() {
    if (isNavOpen) closeWorkspaceNavigation();
    else openWorkspaceNavigation({ reviewLegacy: true });
}

export function openWorkspaceNavigation({ tab, reviewLegacy = false } = {}) {
    const panel = document.getElementById('workspace-nav-panel');
    const button = document.getElementById('palette-nav-btn');
    if (!panel) return;
    eventBus.emit('wiring:close');
    if (typeof window.closePlacePopover === 'function') window.closePlacePopover();
    const view = getOpenBuildingId() == null ? getCurrentView() : null;
    const showLegacy = reviewLegacy &&
        (resolveViewLegacyConflicts(view, appState).length > 0 || workspaceLegacyVlans(view).length > 0);
    if (showLegacy) activeTab = 'links';
    else if (tab === 'devices' || tab === 'links') activeTab = tab;
    isNavOpen = true;
    panel.hidden = false;
    button?.setAttribute('aria-expanded', 'true');
    button?.classList.add('active');
    renderWorkspaceNavigation();
    const legacySection = showLegacy && document.getElementById('workspace-nav-legacy');
    if (legacySection && !legacySection.hidden) {
        legacySection.open = true;
        legacySection.children[0].focus();
        return;
    }
    document.getElementById(`workspace-nav-tab-${activeTab}`)?.focus();
}

export function closeWorkspaceNavigation() {
    const panel = document.getElementById('workspace-nav-panel');
    const button = document.getElementById('palette-nav-btn');
    if (!panel) return;
    isNavOpen = false;
    panel.hidden = true;
    if (button) {
        button.setAttribute('aria-expanded', 'false');
        button.classList.remove('active');
        button.focus();
    }
    // 閉じている間はDOM要素を空にしてパフォーマンスを保持
    document.getElementById('workspace-nav-content')?.replaceChildren();
    syncLegacyVlanReview = () => {};
}

function element(tag, className = '', text = '') {
    const node = document.createElement(tag);
    node.className = className;
    if (text) node.textContent = text;
    return node;
}

function switchTab(tab, focus = false) {
    activeTab = tab;
    renderWorkspaceNavigation();
    if (focus) document.getElementById(`workspace-nav-tab-${tab}`)?.focus();
}

const legacyReasonLabel = {
    port_collision: '同じポートが複数の接続先で使われています',
    ambiguous_pair: '同じ機器間にまとめられない旧記録が複数あります',
    invalid_manual_route: '旧手動経路の座標を移行できませんでした'
};

function buildLegacySection() {
    const section = element('details', 'workspace-nav-legacy');
    section.id = 'workspace-nav-legacy';
    section.hidden = true;
    const summary = element('summary');
    summary.setAttribute('data-nav-focus', 'legacy-heading');
    const conflicts = element('section');
    const heading = element('h3', '', '移行保留の旧接続');
    const guide = element('p', 'workspace-nav-legacy-guide',
        'データ移行後、この旧接続の線は表示されていません。');
    conflicts.append(heading, guide, element('ul'));
    const vlans = element('section', 'workspace-nav-legacy-vlans');
    vlans.id = 'workspace-nav-legacy-vlans';
    section.append(summary, conflicts, vlans);
    return section;
}

async function confirmLegacyExclusion(row) {
    if (excludingLegacyLink || appState.authExpired || !requireAdminUiAction()) return;
    if (!window.confirm(`旧記録 #${row.legacy_link_id} を削除しますか？\n` +
        'この旧記録1件をDBから削除します。新しい接続は作成されず、既存の接続やポートは変わりません。\n' +
        '同じ機器間の共通接続も旧記録も残らない場合は、各ビューの手動経路も削除します。')) return;
    excludingLegacyLink = true;
    renderWorkspaceNavigation();
    try {
        const result = await excludeLegacyLink(row);
        if (result.audit_warning) showToast('旧記録を削除しましたが、監査ログを記録できませんでした', 'warning');
        else showToast('旧記録を削除しました', 'success');
    } catch (error) {
        showToast(error.maintenanceRejected
            ? '保守作業中は旧記録を削除できません。保守終了後にもう一度確認してください'
            : `旧記録を削除できませんでした: ${error.message}`, 'warning');
    } finally {
        excludingLegacyLink = false;
        renderWorkspaceNavigation();
    }
}

function renderLegacyRoute(old, key, expanded) {
    const route = old.manual_route;
    const mode = old.route_mode === 'auto' ? '自動' : old.route_mode || '未設定';
    const overview = old.route_mode === 'manual'
        ? (route == null ? '手動・座標なし' : '手動経路あり')
        : mode;
    const coordinateCount = Array.isArray(route) ? `（座標${route.length}件）` : '';
    const container = element('div', '', `旧経路：${overview}${coordinateCount}`);
    if (route != null) {
        const disclosure = element('details');
        const summary = element('summary', '', '座標を表示（旧記録の始点からの順序）');
        summary.setAttribute('data-nav-focus', key);
        disclosure.open = expanded.has(key);
        disclosure.append(summary, element('code', 'workspace-nav-legacy-coordinates', JSON.stringify(route)));
        container.appendChild(disclosure);
    }
    return container;
}

function buildLegacyRow(row, view, canEdit, expanded) {
    const old = row.payload;
    const id = row.legacy_link_id;
    const endpoint = (id, port) => `${getDeviceById(id)?.name || `機器 #${id}`}${port ? `（${port}）` : ''}`;
    const pair = `${endpoint(old.from_id, old.from_port)} → ${endpoint(old.to_id, old.to_port)}`;
    const reason = Object.hasOwn(legacyReasonLabel, row.reason) ? legacyReasonLabel[row.reason] : row.reason;
    const system = old.system_id == null ? '未設定' : getLinkSystem(old.system_id)?.name ?? `#${old.system_id}`;
    const detailsKey = `legacy-details-${id}`;
    const summary = element('summary', 'workspace-nav-legacy-detail-label', '詳細');
    summary.setAttribute('aria-label', `詳細（旧接続 #${id}）`);
    summary.setAttribute('data-nav-focus', detailsKey);
    const disclosure = element('details');
    disclosure.open = expanded.has(detailsKey);
    const body = element('div', 'workspace-nav-legacy-body');
    const item = element('li');
    item.appendChild(element('strong', '', pair));
    body.append(
        element('p', '', `保留理由：${reason}`),
        element('p', '', `元ビュー：${view.name} (#${view.id}) / 旧接続ID：#${id}`),
        element('p', '', `未移行ポート（始点 → 終点）：${old.from_port || '未指定'} → ${old.to_port || '未指定'}`),
        element('p', '', `系統：${system} / VLAN：${old.vlan || '未設定'}`),
        element('p', '', `ラベル：${old.label || 'なし'}`),
        element('p', '', `備考：${old.memo || 'なし'}`),
        renderLegacyRoute(old, `legacy-route-${id}`, expanded)
    );
    if (canEdit) {
        const actions = element('div', 'workspace-nav-legacy-actions');
        for (const [label, style, key, action] of [
            ['新規接続する', 'btn-primary', `legacy-create-${id}`, () => toggleLinkMode({ legacyRow: row })],
            ['旧記録を削除する', 'btn-secondary', `legacy-${id}`, () => confirmLegacyExclusion(row)]
        ]) {
            const button = element('button', `btn ${style} btn-sm`, label);
            button.type = 'button';
            button.setAttribute('aria-label', `${label}（旧接続 #${id}）`);
            button.setAttribute('aria-disabled', String(excludingLegacyLink || reviewingLegacyVlan));
            button.setAttribute('data-nav-focus', key);
            button.addEventListener('click', () => {
                if (button.getAttribute('aria-disabled') !== 'true' && !reviewingLegacyVlan) return action();
            });
            actions.appendChild(button);
        }
        item.appendChild(actions);
    }
    disclosure.append(summary, body);
    item.appendChild(disclosure);
    return item;
}

function renderUnmigratedVlans(container, view, records, canEdit, onBusyChange) {
    container.hidden = !records.length;
    if (container.hidden) {
        container.replaceChildren();
        return () => {};
    }
    const list = element('ul');
    const links = new Map(appState.links.map(link => [Number(link.id), link]));
    const buttons = [];
    const canAct = () => isNavOpen && activeTab === 'links' && getOpenBuildingId() == null &&
        Number(getCurrentView()?.id) === Number(view.id) && !excludingLegacyLink &&
        !getPendingSave() && !isSaveInFlight() && !appState.isPinging && requireAdminUiAction();
    const sync = () => {
        for (const [button, remove] of buttons) {
            button.disabled = reviewingLegacyVlan || appState.authExpired || appState.isPinging ||
                Boolean(getPendingSave()) || isSaveInFlight() || (remove && hasUnappliedLinkPanelChanges());
        }
    };
    for (const record of records) {
        const id = Number(record.link_id);
        const link = links.get(id);
        if (!link) continue;
        const row = element('li');
        const endpoints = legacyVlanEndpoints(link).map(({ deviceName, portName }) =>
            portName ? `${deviceName}（${portName}）` : deviceName);
        row.append(element('strong', '', endpoints.join(' ↔ ')), element('p', '', `未移行VLAN：${record.vlan}`));
        if (canEdit) {
            const actions = element('div', 'workspace-nav-legacy-actions');
            for (const [label, style, remove] of [
                ['再設定する', 'btn-primary', false], ['未移行設定削除', 'btn-secondary', true],
            ]) {
                const button = element('button', `btn ${style} btn-sm`, label);
                button.type = 'button';
                button.setAttribute('aria-label', `${label}（共通接続 #${id}）`);
                button.setAttribute('data-nav-focus', `legacy-vlan-${remove ? 'delete' : 'edit'}-${id}`);
                buttons.push([button, remove]);
                button.addEventListener('click', async () => {
                    if (button.disabled || !canAct() || unmigratedVlanForLink(id) !== record) return;
                    if (remove) {
                        await deleteUnmigratedVlan(record, {
                            canAct: () => canAct() && !hasUnappliedLinkPanelChanges(),
                            onBusyChange,
                        });
                        return;
                    }
                    const current = appState.links.find(item => Number(item.id) === id);
                    if (!current) return;
                    await onLinkClick(current, { reveal: true });
                    if (Number(appState.editingLinkId) !== id) return;
                    if (window.innerWidth <= 900) closeWorkspaceNavigation();
                    const side = Number(current.from_id) < Number(current.to_id) ? 'from' : 'to';
                    document.getElementById(`lp-${side}-port`)?.focus();
                });
                actions.append(button);
            }
            row.append(actions);
        }
        list.append(row);
    }
    container.replaceChildren(
        element('h3', '', `未移行VLAN（${records.length}件）`),
        list,
    );
    sync();
    return sync;
}

function renderLegacyConflicts(view, rows, vlanRows, canEdit) {
    const section = document.getElementById('workspace-nav-legacy');
    const [summary, conflicts, vlans] = section.children;
    const list = conflicts.querySelector('ul');
    const count = rows.length + vlanRows.length;
    const viewId = String(view.id);
    const sameView = section.getAttribute('data-view-id') === viewId;
    if (!sameView || (count && section.hidden)) {
        section.open = count > 0;
        section.setAttribute('data-view-id', viewId);
    }
    section.hidden = !count;
    summary.textContent = `確認が必要な接続（${count}件）`;
    conflicts.hidden = !rows.length;
    const expanded = new Set();
    if (sameView && rows.length) {
        for (const details of list.querySelectorAll('details')) {
            if (details.open) expanded.add(details.children[0].getAttribute('data-nav-focus'));
        }
    }
    list.replaceChildren(...rows.map(row => buildLegacyRow(row, view, canEdit, expanded)));
    syncLegacyVlanReview = renderUnmigratedVlans(vlans, view, vlanRows, canEdit, busy => {
        reviewingLegacyVlan = busy;
        syncLegacyVlanReview();
        for (const action of list.querySelectorAll('.workspace-nav-legacy-actions button')) {
            action.setAttribute('aria-disabled', String(excludingLegacyLink || busy));
        }
    });
    return section;
}

function renderLegacyBadge(count) {
    const badge = document.getElementById('palette-nav-legacy-badge');
    if (!badge) return;
    const label = count ? `要確認 ${count}` : '';
    if (badge.textContent !== label) badge.textContent = label;
    badge.hidden = !count;
}

function buildControls(content) {
    const tabs = element('div', 'workspace-nav-tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'ビュー内の機器と接続');
    const keys = ['devices', 'links'];
    keys.forEach((key, index) => {
        const button = element('button', 'workspace-nav-tab');
        button.id = `workspace-nav-tab-${key}`;
        button.type = 'button';
        button.setAttribute('role', 'tab');
        button.setAttribute('aria-controls', `workspace-nav-${key}`);
        button.addEventListener('click', () => switchTab(key));
        button.addEventListener('keydown', event => {
            let next;
            if (event.key === 'Home') next = 0;
            if (event.key === 'End') next = keys.length - 1;
            if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % keys.length;
            if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index + keys.length - 1) % keys.length;
            if (next === undefined) return;
            event.preventDefault();
            switchTab(keys[next], true);
        });
        tabs.appendChild(button);
    });
    content.appendChild(tabs);
    for (const key of keys) {
        const panel = element('div', 'workspace-nav-section');
        panel.id = `workspace-nav-${key}`;
        panel.setAttribute('role', 'tabpanel');
        panel.setAttribute('aria-labelledby', `workspace-nav-tab-${key}`);
        content.appendChild(panel);
    }
    const linkPanel = document.getElementById('workspace-nav-links');
    const tools = element('div', 'workspace-nav-tools');
    const searchLabel = element('label', '', '接続を検索');
    const search = element('input', 'form-input form-input-sm');
    search.id = 'workspace-nav-search';
    search.type = 'search';
    search.placeholder = '機器名・ラベル・ポート名・VLAN設定・系統名';
    const searchHint = element('small', 'is-muted', 'VLAN は接続の両端のポートが検索対象です。');
    searchHint.id = 'workspace-nav-search-hint';
    searchLabel.setAttribute('for', search.id);
    search.setAttribute('aria-describedby', searchHint.id);
    search.addEventListener('input', () => {
        searchQuery = search.value;
        renderWorkspaceNavigation();
    });
    searchLabel.appendChild(search);
    tools.append(searchLabel, searchHint);
    linkPanel.appendChild(tools);
    linkPanel.appendChild(buildLegacySection());
    const bulk = element('div', 'workspace-nav-bulk');
    bulk.id = 'workspace-nav-bulk';
    const actions = element('div', 'workspace-nav-bulk-actions');
    const clear = element('button', 'btn btn-secondary btn-sm', '選択解除');
    clear.type = 'button';
    clear.id = 'workspace-nav-clear-selection';
    clear.addEventListener('click', () => {
        selectedLinkIds.clear();
        renderWorkspaceNavigation();
    });
    const edit = element('button', 'btn btn-primary btn-sm', '一括設定');
    edit.type = 'button';
    edit.id = 'workspace-nav-bulk-open';
    edit.addEventListener('click', () => openLinkBulkModal(getWorkspaceSelectedLinkIds(), { getSelectedIds: getWorkspaceSelectedLinkIds }));
    actions.append(clear, edit);

    const allLabel = element('label', 'workspace-nav-select-all-label', 'すべて選択');
    const all = element('input');
    all.type = 'checkbox';
    all.id = 'workspace-nav-select-all';
    allLabel.prepend(all);
    all.addEventListener('change', () => {
        syncSelection();
        if (!isCurrentUserAdmin() || appState.authExpired) return;
        for (const link of filterWorkspaceLinks(resolveWorkspaceLinks(getCurrentView(), appState), searchQuery)) {
            if (all.checked) selectedLinkIds.add(Number(link.id));
            else selectedLinkIds.delete(Number(link.id));
        }
        renderWorkspaceNavigation();
    });
    bulk.append(actions, allLabel);
    linkPanel.appendChild(bulk);
    const status = element('p', 'workspace-nav-selection-status');
    status.id = 'workspace-nav-selection-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    linkPanel.appendChild(status);
    const list = element('div', 'workspace-nav-list');
    list.id = 'workspace-nav-link-list';
    list.setAttribute('role', 'list');
    linkPanel.appendChild(list);
}

function renderDevices(placements, isRack) {
    const panel = document.getElementById('workspace-nav-devices');
    panel.replaceChildren();
    const tools = element('div', 'workspace-nav-tools');
    const ledger = element('button', 'btn btn-secondary btn-sm', '台帳で開く');
    ledger.id = 'workspace-nav-open-ledger';
    ledger.type = 'button';
    ledger.title = 'このビューの機器を台帳で開く';
    ledger.setAttribute('aria-label', ledger.title);
    ledger.setAttribute('data-nav-focus', 'ledger');
    ledger.disabled = !getCurrentView();
    ledger.addEventListener('click', () => {
        const view = getCurrentView();
        if (!view) return;
        closeWorkspaceNavigation();
        eventBus.emit('ledger:open-for-view', { viewId: Number(view.id) });
    });
    tools.appendChild(ledger);
    panel.appendChild(tools);
    if (!placements.length) {
        panel.appendChild(element('p', 'workspace-nav-empty', '表示中のビューに機器はありません'));
        return;
    }
    const list = element('div', 'workspace-nav-list');
    list.setAttribute('role', 'list');
    for (const placement of placements) {
        const device = getDeviceById(placement.device_id);
        if (!device) continue;
        const row = element('div');
        row.setAttribute('role', 'listitem');
        const button = element('button', 'workspace-nav-item workspace-nav-device-item');
        button.type = 'button';
        if (isRack) {
            button.setAttribute('data-rack-device-id', String(device.id));
            button.setAttribute('data-nav-focus', `rackdevice-${device.id}`);
            if (appState.editingDeviceId != null &&
                Number(appState.editingDeviceId) === Number(device.id)) button.classList.add('is-selected');
        } else {
            button.setAttribute('data-placement-id', String(placement.id));
            button.setAttribute('data-nav-focus', `device-${placement.id}`);
            if (appState.selectedPlacementIds.has(Number(placement.id))) button.classList.add('is-selected');
        }
        const info = element('div', 'workspace-nav-device-info');
        const title = element('div', 'workspace-nav-device-title', device.name || '(名称未設定)');
        const typeLabel = DEVICE_TYPES[device.type]?.label || 'その他';
        const ipText = device.ip ? device.ip : 'IPなし';
        const sub = element('div', 'workspace-nav-device-sub', `${typeLabel} | ${ipText}`);
        const statusDescription = getDeviceStatusDescription(device);
        button.title = statusDescription;
        button.setAttribute('aria-label', `${title.textContent} / ${typeLabel} / ${ipText} / ${statusDescription}`);
        info.append(title, sub);
        button.appendChild(info);
        button.addEventListener('click', async () => {
            if (window.innerWidth <= 900) closeWorkspaceNavigation();
            if (isRack) {
                const { showRackDevice } = await import('../canvas/rack-view.js');
                await showRackDevice({ viewId: Number(placement.view_id), deviceId: Number(device.id) });
                renderWorkspaceNavigation();
            } else {
                focusDevicePlacement(device, placement);
            }
        });
        row.appendChild(button);
        list.appendChild(row);
    }
    panel.appendChild(list);
}

function renderLinks(links, canEdit) {
    const visible = filterWorkspaceLinks(links, searchQuery);
    const list = document.getElementById('workspace-nav-link-list');
    list.replaceChildren();
    if (!visible.length) list.appendChild(element('p', 'workspace-nav-empty', links.length ? '条件に一致する接続はありません' : '表示中のビューに接続はありません'));
    for (const link of visible) {
        const row = element('div', 'workspace-nav-link-row');
        row.setAttribute('role', 'listitem');
        if (canEdit) {
            const checkbox = element('input', 'workspace-nav-link-check');
            checkbox.type = 'checkbox';
            checkbox.checked = selectedLinkIds.has(Number(link.id));
            checkbox.setAttribute('aria-label', `接続 ${getDeviceById(link.from_id)?.name || link.from_id} → ${getDeviceById(link.to_id)?.name || link.to_id} を一括設定の対象にする`);
            checkbox.setAttribute('data-nav-focus', `check-${link.id}`);
            checkbox.addEventListener('change', () => {
                syncSelection();
                if (!isCurrentUserAdmin() || appState.authExpired) return;
                if (checkbox.checked) selectedLinkIds.add(Number(link.id));
                else selectedLinkIds.delete(Number(link.id));
                renderWorkspaceNavigation();
            });
            row.appendChild(checkbox);
        }
        const button = element('button', 'workspace-nav-item workspace-nav-link-item');
        button.type = 'button';
        button.setAttribute('data-link-id', String(link.id));
        button.setAttribute('data-nav-focus', `link-${link.id}`);
        if (Number(appState.editingLinkId) === Number(link.id)) button.classList.add('is-selected');
        button.appendChild(element('span', 'workspace-nav-link-endpoints', `${getDeviceById(link.from_id)?.name || link.from_id} → ${getDeviceById(link.to_id)?.name || link.to_id}`));
        const details = element('span', 'workspace-nav-link-details is-muted');
        const swatch = element('span', 'workspace-nav-system-swatch');
        swatch.setAttribute('aria-hidden', 'true');
        swatch.style.backgroundColor = getLinkColor(link);
        details.append(swatch, element('span', '', getLinkSystem(link.system_id)?.name || '未設定'));
        if (link.label) details.appendChild(element('span', '', link.label));
        button.appendChild(details);
        // buttonとcheckboxは兄弟要素。個別選択は一括設定の選択集合を変えない。
        button.addEventListener('click', () => {
            if (window.innerWidth <= 900) closeWorkspaceNavigation();
            return onLinkClick(link, { reveal: true });
        });
        row.appendChild(button);
        list.appendChild(row);
    }
    const visibleSelected = visible.filter(link => selectedLinkIds.has(Number(link.id))).length;
    const hiddenSelected = selectedLinkIds.size - visibleSelected;
    const status = document.getElementById('workspace-nav-selection-status');
    status.textContent = canEdit
        ? `表示 ${visible.length} / ${links.length}件・選択 ${selectedLinkIds.size}件（表示外 ${hiddenSelected}件）`
        : `表示 ${visible.length} / ${links.length}件`;
    const all = document.getElementById('workspace-nav-select-all');
    all.disabled = !canEdit || !visible.length;
    all.checked = visible.length > 0 && visibleSelected === visible.length;
    all.indeterminate = visibleSelected > 0 && visibleSelected < visible.length;
    document.getElementById('workspace-nav-clear-selection').disabled = !canEdit || !selectedLinkIds.size;
    document.getElementById('workspace-nav-bulk-open').disabled = !canEdit || !selectedLinkIds.size || appState.isPinging;
    document.getElementById('workspace-nav-bulk').hidden = !canEdit;
}

function syncWorkspaceNavigationSelection() {
    if (!isNavOpen || activeTab !== 'devices') return;
    const panel = document.getElementById('workspace-nav-devices');
    if (!panel) return;
    for (const button of panel.querySelectorAll('.workspace-nav-device-item[data-placement-id]')) {
        button.classList.toggle('is-selected', appState.selectedPlacementIds.has(Number(button.dataset.placementId)));
    }
}

export function renderWorkspaceNavigation() {
    const view = getOpenBuildingId() == null ? getCurrentView() : null;
    const legacyRows = resolveViewLegacyConflicts(view, appState);
    const placements = view && (isNavOpen || appState.legacyLinkVlans.length) ? workspacePlacements(view) : [];
    const vlanRows = workspaceLegacyVlans(view, placements);
    renderLegacyBadge(legacyRows.length + vlanRows.length);
    const links = isNavOpen ? resolveWorkspaceLinks(view, appState) : undefined;
    syncSelection(links);
    if (!isNavOpen) return;
    const content = document.getElementById('workspace-nav-content');
    if (!content) return;
    if (!view) {
        content.replaceChildren(element('p', 'workspace-nav-empty', '表示中のビューがありません'));
        syncLegacyVlanReview = () => {};
        return;
    }
    const focused = document.activeElement;
    const focusKey = content.contains(focused) ? focused?.getAttribute('data-nav-focus') : null;
    const scrollTop = content.scrollTop;
    if (!document.getElementById('workspace-nav-tab-devices')) {
        content.replaceChildren();
        buildControls(content);
    }
    const isRack = view.view_type === 'rack';
    for (const [key, label, count] of [['devices', '機器', placements.length], ['links', '接続', links.length]]) {
        const tab = document.getElementById(`workspace-nav-tab-${key}`);
        tab.textContent = `${label} (${count}${key === 'devices' ? '台' : '件'})`;
        tab.setAttribute('aria-selected', String(activeTab === key));
        tab.tabIndex = 0;
        document.getElementById(`workspace-nav-${key}`).hidden = activeTab !== key;
    }
    const search = document.getElementById('workspace-nav-search');
    if (search.value !== searchQuery) search.value = searchQuery;
    renderDevices(placements, isRack);
    const canEdit = isCurrentUserAdmin() && !appState.authExpired;
    const legacySection = renderLegacyConflicts(view, legacyRows, vlanRows, canEdit);
    renderLinks(links, canEdit);
    content.scrollTop = scrollTop;
    if (focusKey) {
        const inLegacy = focusKey.startsWith('legacy-');
        const item = inLegacy && legacySection.hidden ? null : content.querySelector(`[data-nav-focus="${focusKey}"]`);
        if (item) item.focus({ preventScroll: true });
        else if (inLegacy && !legacySection.hidden && activeTab === 'links') legacySection.children[0].focus();
        else document.getElementById(`workspace-nav-tab-${activeTab}`)?.focus();
    }
}

export function initWorkspaceNavigation() {
    eventBus.on('canvas:render-complete', renderWorkspaceNavigation);
    eventBus.on('canvas:selection-changed', syncWorkspaceNavigationSelection);
    eventBus.on('link-systems:changed', renderWorkspaceNavigation);
    eventBus.on('rack:changed', renderWorkspaceNavigation);
    eventBus.on('legacy-links:changed', renderWorkspaceNavigation);
    eventBus.on('legacy-vlans:changed', renderWorkspaceNavigation);
    eventBus.on('resources:saved', data => {
        if (data?.deleted_link_ids?.length || (appState.legacyLinkVlans.length && (data?.links?.length || data?.device_ports?.length))) {
            renderWorkspaceNavigation();
        }
    });
    for (const event of ['save-state:changed', 'device-drafts:changed', 'link-route:selection-changed']) {
        eventBus.on(event, () => syncLegacyVlanReview());
    }
    eventBus.on('auth:expired', renderWorkspaceNavigation);
    eventBus.on('ping:busy-changed', renderWorkspaceNavigation);
    eventBus.on('building-view:changed', renderWorkspaceNavigation);
    eventBus.on('device-panel:opened', () => {
        if (getCurrentView()?.view_type === 'rack') renderWorkspaceNavigation();
    });
    eventBus.on('resources:ids-remapped', maps => {
        selectionViewId = mappedResourceId(maps.views, selectionViewId);
        remapResourceSet(selectedLinkIds, maps.links);
        const focused = document.activeElement;
        const key = focused?.getAttribute('data-nav-focus');
        if (key && key !== 'ledger' && !key.startsWith('legacy-')) {
            const [kind, id] = key.split('-');
            const map = kind === 'device' ? maps.placements : kind === 'rackdevice' ? maps.devices : maps.links;
            focused.setAttribute('data-nav-focus', `${kind}-${mappedResourceId(map, Number(id))}`);
        }
        renderWorkspaceNavigation();
    });
    eventBus.on('resources:reloaded', () => {
        selectedLinkIds.clear();
        selectionViewId = null;
        renderWorkspaceNavigation();
    });
    eventBus.on('resource:reloaded', ({ kind, id }) => {
        if (kind === 'views' && Number(id) === selectionViewId) selectedLinkIds.clear();
        renderWorkspaceNavigation();
    });
    if (typeof document !== 'undefined') document.addEventListener('keydown', event => {
        // 開いているモーダルのEscapeが背後の一覧まで閉じないようにする。
        if (event.key === 'Escape' && isNavOpen && !getTopModalContainer()) closeWorkspaceNavigation();
    });
}
