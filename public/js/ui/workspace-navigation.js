import { getRackDeviceMounts } from '../core/device-placement.js';
/**
 * Netarium - ui/workspace-navigation.js
 *
 * 表示中ビューの機器・接続をキーボードでも操作できる一覧。
 * 個別選択と一括設定のチェックは独立して扱う。
 */
import { appState, getCurrentLinks, getCurrentPlacements, getCurrentView, getDeviceById } from '../core/state.js';
import { DEVICE_TYPES } from '../core/constants.js';
import { eventBus } from '../core/event-bus.js';
import { filterWorkspaceLinks } from '../core/link-bulk-data.js';
import { getLinkSystem, getLinkColor } from '../core/link-systems.js';
import { mappedResourceId, remapResourceSet } from '../core/resource-save.js';
import { getTopModalContainer } from '../core/modal-focus.js';
import { focusDevicePlacement, onLinkClick } from '../canvas/renderer.js';
import { getDeviceStatusDescription } from '../core/device-monitoring.js';
import { isCurrentUserAdmin } from './access-control.js';
import { openLinkBulkModal } from '../modals/link-bulk-modal.js';

let isNavOpen = false;
let activeTab = 'devices';
let selectionViewId = null;
let searchQuery = '';
const selectedLinkIds = new Set();

function syncSelection() {
    const viewId = appState.currentViewId == null ? null : Number(appState.currentViewId);
    if (viewId !== selectionViewId) {
        selectionViewId = viewId;
        selectedLinkIds.clear();
        searchQuery = '';
    }
    const available = new Set(getCurrentLinks().map(link => Number(link.id)));
    for (const id of selectedLinkIds) if (!available.has(id)) selectedLinkIds.delete(id);
    // 閲覧権限へ変わった場合は以前の編集用選択を持ち越さない。
    if (!isCurrentUserAdmin() || appState.authExpired) selectedLinkIds.clear();
}

export function getWorkspaceSelectedLinkIds() {
    syncSelection();
    return [...selectedLinkIds];
}

export function toggleWorkspaceNavigation() {
    if (isNavOpen) closeWorkspaceNavigation();
    else openWorkspaceNavigation();
}

export function openWorkspaceNavigation({ tab } = {}) {
    const panel = document.getElementById('workspace-nav-panel');
    const button = document.getElementById('palette-nav-btn');
    if (!panel) return;
    eventBus.emit('wiring:close');
    if (typeof window.closePlacePopover === 'function') window.closePlacePopover();
    if (tab === 'devices' || tab === 'links') activeTab = tab;
    isNavOpen = true;
    panel.hidden = false;
    button?.setAttribute('aria-expanded', 'true');
    button?.classList.add('active');
    renderWorkspaceNavigation();
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
    search.placeholder = '機器名・ラベル・ポート・VLAN・系統名';
    search.addEventListener('input', () => {
        searchQuery = search.value;
        renderWorkspaceNavigation();
    });
    searchLabel.appendChild(search);
    tools.appendChild(searchLabel);
    linkPanel.appendChild(tools);
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
        for (const link of filterWorkspaceLinks(getCurrentLinks(), searchQuery)) {
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

export function renderWorkspaceNavigation() {
    syncSelection();
    if (!isNavOpen) return;
    const content = document.getElementById('workspace-nav-content');
    if (!content) return;
    if (!getCurrentView()) {
        content.replaceChildren(element('p', 'workspace-nav-empty', '表示中のビューがありません'));
        return;
    }
    const focused = document.activeElement;
    const focusKey = content.contains(focused) ? focused?.getAttribute('data-nav-focus') : null;
    const scrollTop = content.scrollTop;
    if (!document.getElementById('workspace-nav-tab-devices')) {
        content.replaceChildren();
        buildControls(content);
    }
    const isRack = getCurrentView().view_type === 'rack';
    const placements = isRack
        ? [...new Map(getRackDeviceMounts(appState)
            .filter(mount => Number(mount.view_id) === Number(appState.currentViewId) &&
                getDeviceById(mount.device_id))
            .map(mount => [Number(mount.device_id), mount])).values()]
        : getCurrentPlacements();
    const links = getCurrentLinks();
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
    renderLinks(links, isCurrentUserAdmin() && !appState.authExpired);
    if (focusKey) {
        const item = content.querySelector(`[data-nav-focus="${focusKey}"]`);
        if (item) item.focus();
        else document.getElementById(`workspace-nav-tab-${activeTab}`)?.focus();
    }
    content.scrollTop = scrollTop;
}

export function initWorkspaceNavigation() {
    eventBus.on('canvas:render-complete', renderWorkspaceNavigation);
    eventBus.on('link-systems:changed', renderWorkspaceNavigation);
    eventBus.on('rack:changed', renderWorkspaceNavigation);
    eventBus.on('device-panel:opened', () => {
        if (getCurrentView()?.view_type === 'rack') renderWorkspaceNavigation();
    });
    eventBus.on('resources:ids-remapped', maps => {
        selectionViewId = mappedResourceId(maps.views, selectionViewId);
        remapResourceSet(selectedLinkIds, maps.links);
        const focused = document.activeElement;
        const key = focused?.getAttribute('data-nav-focus');
        if (key && key !== 'ledger') {
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
