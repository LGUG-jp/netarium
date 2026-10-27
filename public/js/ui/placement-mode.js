/**
 * Netarium - ui/placement-mode.js
 *
 * 機器配置モード（スタンプ方式・キュー方式）
 */

import {
    DEFAULT_DEVICE_HEIGHT,
    DEFAULT_DEVICE_WIDTH,
    DEVICE_TYPES
} from '../core/constants.js';

import {
    appState,
    getCurrentPlacements,
    allocateLocalId,
    getCurrentView,
    getDeviceById
} from '../core/state.js';
import { getPlacedDeviceIds, getRackDeviceMounts } from '../core/device-placement.js';

import {
    clampPosition
} from '../canvas/drag-drop.js';

import {
    screenToWorld
} from '../canvas/pan-zoom.js';

import {
    render
} from '../canvas/renderer.js';

import {
    isCurrentUserAdmin,
    requireAdminUiAction
} from './access-control.js';

import {
    closeLinkPanel,
    closePanel,
    hasUnappliedPanelChanges,
    hasUnappliedLinkPanelChanges
} from './property-panel.js';

import {
    showToast
} from './toast.js';

import {
    markDirty
} from './status-bar.js';
import { flushSaveQueue, scheduleSave } from '../core/save-queue.js';
import {
    normalizeText
} from '../core/utils.js';

import {
    getDefaultDeviceName
} from './toolbar.js';

import { eventBus } from '../core/event-bus.js';
import { endLinkMode } from '../core/link-mode.js';
import { FLOOR_RACK_ICON } from '../canvas/floor-racks.js';
import { hasResourceConflict } from '../core/save-queue.js';

let ghostClientPoint = null;

eventBus.on('placement-mode:exit', exitPlacementMode);
eventBus.on('placement-mode:view-changed', () => {
    if (placementState.tab === 'rack' || getCurrentView()?.view_type === 'rack') exitPlacementMode();
    else syncPlacementModeUi();
});
eventBus.on('canvas:render-complete', () => {
    if (placementState.active) {
        renderPlacementPalette();
    }
});
eventBus.on('canvas:view-transformed', () => {
    if (placementState.active && ghostClientPoint) {
        updatePlacementGhost(ghostClientPoint.x, ghostClientPoint.y);
    }
});
// 配置モード内部状態
export const placementState = {
    active: false,
    tab: 'new', // 'new' | 'unplaced' | 'rack'
    newDeviceType: null,
    selectedRackId: null,
    unplacedScope: 'current-view', // 'current-view' | 'all-views'
    unplacedSearchKeyword: '',
    selectedUnplacedIds: new Set(),
    queue: [] // [{ id, name, type, ip, facility, floor }]
};

eventBus.on('resources:ids-remapped', maps => {
    placementState.selectedUnplacedIds = new Set([...placementState.selectedUnplacedIds]
        .map(id => Number(maps.devices?.[id] ?? id)));
    placementState.queue.forEach(row => { row.id = Number(maps.devices?.[row.id] ?? row.id); });
    if (placementState.selectedRackId != null) {
        placementState.selectedRackId = Number(maps.views?.[placementState.selectedRackId] ?? placementState.selectedRackId);
    }
});

export function isPlacementModeActive() {
    return placementState.active;
}

export function getPlacementState() {
    return placementState;
}

/**
 * 配置モード開始
 */
export function enterPlacementMode(options = {}) {
    if (!requireAdminUiAction()) {
        return false;
    }
    if (appState.currentViewId === null) {
        showToast('表示中のビューがありません', 'warning');
        return false;
    }
    if (getCurrentView()?.view_type === 'rack') {
        showToast('ラックでは空きUから既存機器を搭載してください', 'warning');
        return false;
    }

    if (hasUnappliedPanelChanges() || hasUnappliedLinkPanelChanges()) {
        return (async () => {
            if (!await closePanel() || !await closeLinkPanel()) {
                return false;
            }
            return setupPlacementMode(options);
        })();
    }

    closePanel();
    closeLinkPanel();
    return setupPlacementMode(options);
}

function setupPlacementMode(options) {
    eventBus.emit('canvas-note:finish');
    if (typeof window.closeToolbarMenu === 'function') {
        window.closeToolbarMenu();
    }
    if (typeof window.closeWorkspaceNavigation === 'function') {
        window.closeWorkspaceNavigation();
    }

    // 接続モード中なら解除
    endLinkMode();
    eventBus.emit('wiring:render');
    render();

    placementState.active = true;

    if (options.tab) {
        placementState.tab = options.tab;
    }
    if (placementState.tab === 'rack' && getCurrentView()?.view_type !== 'floor') placementState.tab = 'new';
    const rackTab = document.getElementById('place-tab-btn-rack');
    if (rackTab) {
        rackTab.hidden = getCurrentView()?.view_type !== 'floor';
        rackTab.onclick = () => switchPlacementTab('rack');
    }
    placementState.newDeviceType = options.deviceType && DEVICE_TYPES[options.deviceType]
        ? options.deviceType
        : null;
    if (options.unplacedScope) {
        placementState.unplacedScope = options.unplacedScope;
    }

    // 初期機器IDが渡された場合はキューへ投入
    if (options.initialDeviceIds) {
        placementState.tab = 'unplaced';
        addDevicesToPlacementQueue(options.initialDeviceIds);
    }

    // DOM UIの反映
    syncPlacementModeUi();
    switchPlacementTab(placementState.tab);

    return true;
}

/**
 * 配置モード終了
 */
export function exitPlacementMode() {
    if (!placementState.active) {
        return;
    }
    placementState.active = false;
    placementState.newDeviceType = null;
    placementState.selectedRackId = null;
    hidePlacementGhost();
    syncPlacementModeUi();
    return flushSaveQueue({ silent: true });
}

/**
 * 配置モード切替
 */
export async function togglePlacementMode() {
    if (placementState.active) {
        exitPlacementMode();
    } else {
        await enterPlacementMode();
    }
}

/**
 * タブ切り替え
 */
export function switchPlacementTab(tab) {
    if (!['new', 'unplaced', 'rack'].includes(tab) || (tab === 'rack' && getCurrentView()?.view_type !== 'floor')) return;
    placementState.tab = tab;

    const newTabBtn = document.getElementById('place-tab-btn-new');
    const unplacedTabBtn = document.getElementById('place-tab-btn-unplaced');
    const newContent = document.getElementById('place-content-new');
    const unplacedContent = document.getElementById('place-content-unplaced');
    const badge = document.getElementById('placement-mode-badge');

    if (newTabBtn) {
        newTabBtn.classList.toggle('is-active', tab === 'new');
        newTabBtn.setAttribute('aria-selected', tab === 'new' ? 'true' : 'false');
    }
    if (unplacedTabBtn) {
        unplacedTabBtn.classList.toggle('is-active', tab === 'unplaced');
        unplacedTabBtn.setAttribute('aria-selected', tab === 'unplaced' ? 'true' : 'false');
    }
    if (newContent) {
        newContent.hidden = tab !== 'new';
    }
    if (unplacedContent) {
        unplacedContent.hidden = tab !== 'unplaced';
    }
    const rackTab = document.getElementById('place-tab-btn-rack');
    if (rackTab) {
        rackTab.hidden = getCurrentView()?.view_type !== 'floor';
        rackTab.classList.toggle('is-active', tab === 'rack');
        rackTab.setAttribute('aria-selected', String(tab === 'rack'));
    }
    const rackContent = document.getElementById('place-content-rack');
    if (rackContent) rackContent.hidden = tab !== 'rack';
    if (badge) {
        badge.textContent = tab === 'rack' ? 'ラック' : tab === 'new' ? '新規' : '未配置';
    }

    if (ghostClientPoint) {
        updatePlacementGhost(ghostClientPoint.x, ghostClientPoint.y);
    } else {
        hidePlacementGhost();
    }

    renderPlacementPalette();
}

/**
 * 新規機器種別の選択
 */
export function setPlacementNewDeviceType(type) {
    if (!DEVICE_TYPES[type]) return;
    placementState.newDeviceType = type;

    const labelEl = document.getElementById('placement-current-type-label');
    if (labelEl) {
        labelEl.textContent = DEVICE_TYPES[type].shortLabel || DEVICE_TYPES[type].label;
    }

    const grid = document.getElementById('placement-type-grid');
    if (grid) {
        grid.querySelectorAll('.placement-type-btn').forEach(btn => {
            const isSelected = btn.dataset.type === type;
            btn.classList.toggle('is-selected', isSelected);
            btn.setAttribute('aria-checked', isSelected ? 'true' : 'false');
        });
    }

    if (ghostClientPoint) {
        updatePlacementGhost(ghostClientPoint.x, ghostClientPoint.y);
    }
}

/**
 * 未配置スコープ切り替え
 */
export function setPlacementUnplacedScope(scope) {
    if (scope !== 'current-view' && scope !== 'all-views') return;
    placementState.unplacedScope = scope;

    // スコープ外の機器が選択に残って意図せずキューに入るのを防ぐためクリア
    placementState.selectedUnplacedIds.clear();

    const currentBtn = document.getElementById('place-scope-current');
    const allBtn = document.getElementById('place-scope-all');
    if (currentBtn) {
        currentBtn.classList.toggle('is-active', scope === 'current-view');
        currentBtn.setAttribute('aria-pressed', String(scope === 'current-view'));
    }
    if (allBtn) {
        allBtn.classList.toggle('is-active', scope === 'all-views');
        allBtn.setAttribute('aria-pressed', String(scope === 'all-views'));
    }

    renderPlacementUnplacedList();
}

/**
 * UIの同期（ボタンのactive状態、パネル表示、bodyクラス）
 */
export function syncPlacementModeUi() {
    if (typeof document === 'undefined') return;

    const panel = document.getElementById('palette-place-panel');
    const placeBtn = document.getElementById('palette-place-btn');
    const viewBtn = document.getElementById('palette-view-btn');

    if (panel) {
        panel.hidden = !placementState.active;
    }
    const rackTab = document.getElementById('place-tab-btn-rack');
    if (rackTab) rackTab.hidden = !placementState.active || getCurrentView()?.view_type !== 'floor';

    if (placeBtn) {
        placeBtn.classList.toggle('active', placementState.active);
        placeBtn.setAttribute('aria-expanded', placementState.active ? 'true' : 'false');
        placeBtn.setAttribute('aria-pressed', placementState.active ? 'true' : 'false');
    }
    if (viewBtn) {
        const selecting = !placementState.active && !appState.linkMode && !appState.noteMode;
        viewBtn.classList.toggle('active', selecting);
        viewBtn.setAttribute('aria-pressed', selecting ? 'true' : 'false');
    }

    if (document.body) {
        document.body.classList.toggle('placement-mode', placementState.active);
    }

    const currentBtn = document.getElementById('place-scope-current');
    const allBtn = document.getElementById('place-scope-all');
    if (currentBtn) {
        currentBtn.classList.toggle('is-active', placementState.unplacedScope === 'current-view');
        currentBtn.setAttribute('aria-pressed', String(placementState.unplacedScope === 'current-view'));
    }
    if (allBtn) {
        allBtn.classList.toggle('is-active', placementState.unplacedScope === 'all-views');
        allBtn.setAttribute('aria-pressed', String(placementState.unplacedScope === 'all-views'));
    }

    eventBus.emit('toolbar:sync-link-mode');
}

/**
 * パレット全体の描画
 */
export function renderPlacementPalette() {
    if (typeof document === 'undefined') return;

    if (placementState.tab === 'rack') {
        renderPlacementRacks();
    } else if (placementState.tab === 'new') {
        renderPlacementNewTypes();
    } else {
        renderPlacementQueue();
        renderPlacementUnplacedList();
    }
}

export function renderPlacementRacks() {
    const list = document.getElementById('placement-rack-list');
    if (!list) return;
    list.replaceChildren();
    const racks = appState.views.filter(view => view.view_type === 'rack');
    if (!racks.length) {
        const empty = document.createElement('p');
        empty.textContent = 'ビュー管理でラックを先に登録してください。';
        list.appendChild(empty);
    }
    for (const rack of racks) {
        const placed = (appState.floorRackPlacements || []).some(row => Number(row.rack_view_id) === Number(rack.id));
        const totalU = appState.rackSettings.find(row => Number(row.view_id) === Number(rack.id))?.total_u;
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'placement-rack-item';
        button.disabled = placed || appState.authExpired || appState.appStatus.state === 'unconfirmed' || hasResourceConflict('views', appState.currentViewId) ||
            hasResourceConflict('views', rack.id);
        button.classList.toggle('is-selected', Number(placementState.selectedRackId) === Number(rack.id));
        button.setAttribute('aria-pressed', String(Number(placementState.selectedRackId) === Number(rack.id)));
        const icon = document.createElement('img'); icon.src = FLOOR_RACK_ICON; icon.alt = '';
        const text = document.createElement('span');
        const name = document.createElement('strong'); name.textContent = rack.name;
        const detail = document.createElement('span'); detail.textContent = `${totalU ?? '—'}U / ${placed ? '配置済み' : '未配置'}`;
        text.append(name, detail); button.append(icon, text);
        button.addEventListener('click', () => {
            placementState.selectedRackId = Number(rack.id); renderPlacementRacks();
        });
        list.appendChild(button);
    }
}

/**
 * 新規機器種別グリッドの描画
 */
export function renderPlacementNewTypes() {
    const grid = document.getElementById('placement-type-grid');
    if (!grid) return;

    grid.replaceChildren();

    Object.entries(DEVICE_TYPES).forEach(([type, def]) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'placement-type-btn';
        btn.dataset.type = type;
        btn.setAttribute('role', 'radio');
        btn.setAttribute('aria-checked', placementState.newDeviceType === type ? 'true' : 'false');
        if (placementState.newDeviceType === type) {
            btn.classList.add('is-selected');
        }

        const icon = document.createElement('img');
        icon.src = def.icon;
        icon.alt = '';
        icon.draggable = false;

        const span = document.createElement('span');
        span.textContent = def.shortLabel || def.label;
        btn.appendChild(icon);
        btn.appendChild(span);

        btn.addEventListener('click', () => {
            setPlacementNewDeviceType(type);
        });

        grid.appendChild(btn);
    });

    const labelEl = document.getElementById('placement-current-type-label');
    if (labelEl) {
        const selectedDef = placementState.newDeviceType ? DEVICE_TYPES[placementState.newDeviceType] : null;
        labelEl.textContent = selectedDef
            ? (selectedDef.shortLabel || selectedDef.label)
            : '未選択（アイコンをクリック）';
    }
}

/**
 * 未配置機器候補の抽出
 */
export function getUnplacedCandidates(scope = placementState.unplacedScope) {
    if (appState.currentViewId === null) return [];

    const currentPlacements = getCurrentPlacements();
    const currentPlacedDeviceIds = new Set(
        currentPlacements.map(p => Number(p.device_id))
    );

    const allPlacedDeviceIds = getPlacedDeviceIds(appState.placements, getRackDeviceMounts(appState));

    const queueDeviceIds = new Set(
        placementState.queue.map(d => Number(d.id))
    );

    return appState.devices.filter(device => {
        const id = Number(device.id);
        // すでにキューに入っているものは除外
        if (queueDeviceIds.has(id)) {
            return false;
        }

        if (scope === 'all-views') {
            return !allPlacedDeviceIds.has(id);
        }

        // 'current-view'
        return !currentPlacedDeviceIds.has(id);
    });
}

/**
 * 未配置機器のスマート推奨判定
 */
export function getRecommendedUnplacedDevices(devices) {
    const currentView = getCurrentView();
    const viewFacility = normalizeText(currentView?.facility || '').trim().toLocaleLowerCase('ja');
    const viewFloor = normalizeText(currentView?.floor || '').trim().toLocaleLowerCase('ja');

    const recommended = [];
    const others = [];

    devices.forEach(device => {
        const devFacility = normalizeText(device.facility || '').trim().toLocaleLowerCase('ja');
        const devFloor = normalizeText(device.floor || '').trim().toLocaleLowerCase('ja');

        let isMatch = false;
        if (viewFacility && devFacility && viewFacility === devFacility) {
            if (viewFloor && devFloor) {
                isMatch = viewFloor === devFloor;
            } else {
                isMatch = true;
            }
        } else if (!viewFacility && viewFloor && devFloor && viewFloor === devFloor) {
            isMatch = true;
        }

        if (isMatch) {
            recommended.push(device);
        } else {
            others.push(device);
        }
    });

    return { recommended, others };
}

/**
 * 未配置機器リストの描画
 */
export function renderPlacementUnplacedList() {
    const listContainer = document.getElementById('placement-unplaced-list');
    const currentCountEl = document.getElementById('place-scope-current-count');
    const allCountEl = document.getElementById('place-scope-all-count');

    // 件数バッジの更新
    const currentScopeCandidates = getUnplacedCandidates('current-view');
    const allScopeCandidates = getUnplacedCandidates('all-views');
    if (currentCountEl) currentCountEl.textContent = String(currentScopeCandidates.length);
    if (allCountEl) allCountEl.textContent = String(allScopeCandidates.length);

    if (!listContainer) return;

    listContainer.replaceChildren();

    const candidates = placementState.unplacedScope === 'all-views'
        ? allScopeCandidates
        : currentScopeCandidates;

    const keyword = normalizeText(
        document.getElementById('placement-unplaced-search')?.value || ''
    ).trim().toLocaleLowerCase('ja');

    const filtered = candidates.filter(device => {
        if (!keyword) return true;
        const text = [
            device.id,
            device.name,
            device.type,
            device.ip,
            device.facility,
            device.floor,
            device.model,
            device.asset_number
        ].map(normalizeText).join(' ').toLocaleLowerCase('ja');
        return text.includes(keyword);
    });

    if (filtered.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'workspace-nav-empty';
        empty.textContent = keyword ? '条件に一致する未配置機器はありません' : '未配置の機器はありません';
        listContainer.appendChild(empty);
        updateEnqueueButton();
        return;
    }

    const { recommended, others } = getRecommendedUnplacedDevices(filtered);

    // 推奨セクション
    if (recommended.length > 0) {
        const recTitle = document.createElement('div');
        recTitle.className = 'placement-group-title';
        recTitle.textContent = `推奨 (${recommended.length}台)`;
        listContainer.appendChild(recTitle);

        recommended.forEach(device => {
            listContainer.appendChild(createUnplacedItemElement(device, true));
        });
    }

    // その他セクション
    if (others.length > 0) {
        if (recommended.length > 0) {
            const othTitle = document.createElement('div');
            othTitle.className = 'placement-group-title';
            othTitle.textContent = `その他 (${others.length}台)`;
            listContainer.appendChild(othTitle);
        }

        others.forEach(device => {
            listContainer.appendChild(createUnplacedItemElement(device, false));
        });
    }

    updateEnqueueButton();
}

function createUnplacedItemElement(device, isRecommended) {
    const label = document.createElement('label');
    label.className = 'placement-unplaced-option';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = String(device.id);
    checkbox.checked = placementState.selectedUnplacedIds.has(Number(device.id));

    checkbox.addEventListener('change', () => {
        const id = Number(device.id);
        if (checkbox.checked) {
            placementState.selectedUnplacedIds.add(id);
        } else {
            placementState.selectedUnplacedIds.delete(id);
        }
        updateEnqueueButton();
    });

    const info = document.createElement('div');
    info.className = 'placement-unplaced-option-info';

    const title = document.createElement('div');
    title.className = 'placement-unplaced-option-title';
    title.textContent = device.name || '(名称未設定)';

    if (isRecommended) {
        const badge = document.createElement('span');
        badge.className = 'placement-recommend-badge';
        badge.textContent = '推奨';
        title.appendChild(badge);
    }

    const sub = document.createElement('div');
    sub.className = 'placement-unplaced-option-sub';
    const typeLabel = DEVICE_TYPES[device.type]?.label || 'その他';
    const ipText = device.ip ? `IP: ${device.ip}` : 'IPなし';
    const locText = [device.facility, device.floor].filter(Boolean).join(' / ');
    sub.textContent = [typeLabel, ipText, locText].filter(Boolean).join(' | ');

    info.appendChild(title);
    info.appendChild(sub);

    label.appendChild(checkbox);
    label.appendChild(info);

    return label;
}

function updateEnqueueButton() {
    const btn = document.getElementById('placement-enqueue-btn');
    if (btn) {
        btn.disabled = placementState.selectedUnplacedIds.size === 0;
        btn.textContent = placementState.selectedUnplacedIds.size > 0
            ? `配置待ちに追加 (${placementState.selectedUnplacedIds.size}台)`
            : '配置待ちに追加';
    }
}

/**
 * チェックした未配置機器をキューに追加
 */
export function enqueueSelectedUnplacedDevices() {
    if (placementState.selectedUnplacedIds.size === 0) return;

    addDevicesToPlacementQueue(Array.from(placementState.selectedUnplacedIds));
    placementState.selectedUnplacedIds.clear();

    renderPlacementPalette();
}

/**
 * 機器ID群を配置キューに追加
 */
export function addDevicesToPlacementQueue(deviceIds) {
    if (!deviceIds) return;

    const ids = Array.isArray(deviceIds) || deviceIds instanceof Set
        ? Array.from(deviceIds)
        : [deviceIds];

    const currentPlacements = getCurrentPlacements();
    const alreadyPlacedIds = new Set(currentPlacements.map(p => Number(p.device_id)));
    const existingQueueIds = new Set(placementState.queue.map(d => Number(d.id)));

    let addedCount = 0;

    ids.forEach(rawId => {
        const id = Number(rawId);
        if (!Number.isInteger(id) || id <= 0) return;
        if (alreadyPlacedIds.has(id)) return;
        if (existingQueueIds.has(id)) return;

        const device = getDeviceById(id);
        if (!device) return;

        placementState.queue.push({
            id: Number(device.id),
            name: device.name || '(名称未設定)',
            type: device.type || 'switch',
            ip: device.ip || '',
            facility: device.facility || '',
            floor: device.floor || ''
        });
        existingQueueIds.add(id);
        addedCount++;
    });

    if (addedCount > 0) {
        renderPlacementQueue();
        renderPlacementUnplacedList();
    }
}

/**
 * 配置待ちキューの描画
 */
export function renderPlacementQueue() {
    const countEl = document.getElementById('placement-queue-count');
    const clearBtn = document.getElementById('placement-queue-clear-btn');
    const nextEl = document.getElementById('placement-queue-next');
    const listEl = document.getElementById('placement-queue-list');

    if (countEl) countEl.textContent = String(placementState.queue.length);
    if (clearBtn) clearBtn.hidden = placementState.queue.length === 0;

    if (!nextEl || !listEl) return;

    nextEl.replaceChildren();
    listEl.replaceChildren();

    if (placementState.queue.length === 0) {
        const emptySpan = document.createElement('span');
        emptySpan.className = 'is-muted';
        emptySpan.textContent = '下の候補から選択してください';
        nextEl.appendChild(emptySpan);
        return;
    }

    // 先頭機器（次）
    const nextDevice = placementState.queue[0];
    const nextLabel = document.createElement('div');
    nextLabel.style.display = 'flex';
    nextLabel.style.alignItems = 'center';
    nextLabel.style.gap = '6px';
    nextLabel.style.flex = '1';
    nextLabel.style.minWidth = '0';

    const nextBadge = document.createElement('span');
    nextBadge.style.fontWeight = '700';
    nextBadge.textContent = '次:';

    const nextName = document.createElement('span');
    nextName.style.overflow = 'hidden';
    nextName.style.textOverflow = 'ellipsis';
    nextName.style.whiteSpace = 'nowrap';
    nextName.textContent = `${nextDevice.name} [${DEVICE_TYPES[nextDevice.type]?.label || nextDevice.type}]`;

    nextLabel.appendChild(nextBadge);
    nextLabel.appendChild(nextName);

    const nextRemoveBtn = document.createElement('button');
    nextRemoveBtn.type = 'button';
    nextRemoveBtn.className = 'btn-text-action';
    nextRemoveBtn.textContent = '×';
    nextRemoveBtn.title = '配置キューから外します。機器は削除しません';
    nextRemoveBtn.setAttribute('aria-label', `「${nextDevice.name}」をキューから外す`);
    nextRemoveBtn.addEventListener('click', e => {
        e.stopPropagation();
        removeDeviceFromPlacementQueue(nextDevice.id);
    });

    nextEl.appendChild(nextLabel);
    nextEl.appendChild(nextRemoveBtn);

    // 2台目以降
    for (let i = 1; i < placementState.queue.length; i++) {
        const device = placementState.queue[i];
        const item = document.createElement('div');
        item.className = 'placement-queue-item';
        item.title = 'クリックして次に配置する';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'placement-queue-item-name';
        nameSpan.textContent = `${i + 1}. ${device.name}`;

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'btn-text-action';
        removeBtn.textContent = '×';
        removeBtn.title = '配置キューから外します。機器は削除しません';
        removeBtn.setAttribute('aria-label', `「${device.name}」をキューから外す`);
        removeBtn.addEventListener('click', e => {
            e.stopPropagation();
            removeDeviceFromPlacementQueue(device.id);
        });

        item.appendChild(nameSpan);
        item.appendChild(removeBtn);

        item.addEventListener('click', () => {
            setNextPlacementQueueDevice(device.id);
        });

        listEl.appendChild(item);
    }
}

/**
 * キューから特定機器を削除
 */
export function removeDeviceFromPlacementQueue(deviceId) {
    const id = Number(deviceId);
    placementState.queue = placementState.queue.filter(d => Number(d.id) !== id);
    renderPlacementQueue();
    renderPlacementUnplacedList();
}

/**
 * キュー内の機器を「次」に繰り上げ
 */
export function setNextPlacementQueueDevice(deviceId) {
    const id = Number(deviceId);
    const index = placementState.queue.findIndex(d => Number(d.id) === id);
    if (index > 0) {
        const [target] = placementState.queue.splice(index, 1);
        placementState.queue.unshift(target);
        renderPlacementQueue();
    }
}

/**
 * キューをクリア
 */
export function clearPlacementQueue() {
    placementState.queue = [];
    renderPlacementQueue();
    renderPlacementUnplacedList();
}

/**
 * ゴーストプレビューの更新
 */
export function updatePlacementGhost(clientX, clientY) {
    if (!placementState.active) {
        hidePlacementGhost();
        return;
    }

    ghostClientPoint = { x: clientX, y: clientY };

    if (placementState.tab === 'rack') {
        if (!placementState.selectedRackId) { hidePlacementGhost(); return; }
    } else if (placementState.tab === 'new') {
        if (!placementState.newDeviceType || !DEVICE_TYPES[placementState.newDeviceType]) {
            hidePlacementGhost();
            return;
        }
    } else {
        // 未配置キュー
        if (placementState.queue.length === 0) {
            hidePlacementGhost();
            return;
        }
    }

    const ghost = document.getElementById('placement-ghost');
    const ghostIcon = document.getElementById('placement-ghost-icon');
    const ghostLabel = document.getElementById('placement-ghost-label');
    if (!ghost || !appState.canvas) return;

    const worldPoint = screenToWorld(clientX, clientY);
    const pos = clampPosition(
        worldPoint.x - DEFAULT_DEVICE_WIDTH / 2,
        worldPoint.y - DEFAULT_DEVICE_HEIGHT / 2
    );

    ghost.style.left = `${pos.x}px`;
    ghost.style.top = `${pos.y}px`;
    ghost.hidden = false;

    if (placementState.tab === 'rack') {
        if (ghostIcon) ghostIcon.src = FLOOR_RACK_ICON;
        if (ghostLabel) ghostLabel.textContent = appState.views.find(view => Number(view.id) === Number(placementState.selectedRackId))?.name || '';
    } else if (placementState.tab === 'new') {
        const typeDef = DEVICE_TYPES[placementState.newDeviceType];
        if (ghostIcon) ghostIcon.src = typeDef.icon;
        if (ghostLabel) ghostLabel.textContent = typeDef.shortLabel || typeDef.label;
    } else {
        const nextDevice = placementState.queue[0];
        const typeDef = DEVICE_TYPES[nextDevice.type] || DEVICE_TYPES.other;
        if (ghostIcon) ghostIcon.src = typeDef.icon;
        if (ghostLabel) ghostLabel.textContent = nextDevice.name;
    }
}

/**
 * ゴーストプレビューを非表示
 */
export function hidePlacementGhost() {
    ghostClientPoint = null;
    const ghost = document.getElementById('placement-ghost');
    if (ghost) {
        ghost.hidden = true;
    }
}
/**
 * キャンバスクリック時の配置処理
 *
 * @param {MouseEvent} event
 * @returns {boolean} 配置処理をハンドリングしたかどうか
 */
export function handleCanvasPlacementClick(event) {
    if (!placementState.active) return false;
    if (!requireAdminUiAction()) return false;
    if (appState.currentViewId === null) return false;
    if (getCurrentView()?.view_type === 'rack') return false;

    // クリック位置のワールド座標を計算
    const worldPoint = screenToWorld(event.clientX, event.clientY);
    const position = clampPosition(
        worldPoint.x - DEFAULT_DEVICE_WIDTH / 2,
        worldPoint.y - DEFAULT_DEVICE_HEIGHT / 2
    );

    if (placementState.tab === 'rack') {
        if (getCurrentView()?.view_type !== 'floor' || appState.authExpired || appState.appStatus.state === 'unconfirmed' ||
            hasResourceConflict('views', appState.currentViewId)) return true;
        const rack = appState.views.find(view => view.view_type === 'rack' && Number(view.id) === Number(placementState.selectedRackId));
        if (!rack) { showToast('配置するラックを選択してください', 'warning'); return true; }
        if (hasResourceConflict('views', rack.id)) return true;
        if ((appState.floorRackPlacements || []).some(row => Number(row.rack_view_id) === Number(rack.id))) {
            showToast('このラックは既に配置されています', 'warning'); renderPlacementRacks(); return true;
        }
        appState.floorRackPlacements.push({
            floor_view_id: Number(appState.currentViewId), rack_view_id: Number(rack.id), x: position.x, y: position.y
        });
        appState.selectedPlacementIds.clear();
        markDirty(); scheduleSave({ silent: true });
        exitPlacementMode(); render();
        return true;
    }

    if (placementState.tab === 'new') {
        if (!placementState.newDeviceType || !DEVICE_TYPES[placementState.newDeviceType]) {
            showToast('配置する機器種別をパレットから選択してください', 'warning');
            return true;
        }

        // スタンプ方式：新規機器作成＋配置
        const type = placementState.newDeviceType;
        const deviceId = allocateLocalId('devices');
        const placementId = allocateLocalId('placements');

        const device = {
            id: deviceId,
            name: getDefaultDeviceName(type),
            type,
            ip: '',
            x: 0,
            y: 0,
            status: 'unknown',
            last_checked_at: null,
            last_response_ms: null,
            last_error: null,
            facility: '',
            floor: '',
            location: '',
            manufacturer: '',
            model: '',
            asset_number: '',
            serial_number: '',
            mac_address: '',
            memo: '',
            management_scheme: '',
            management_port: null,
            department: '',
            maintenance_vendor: '',
            install_date: '',
            maintenance_expiry: ''
        };

        const placement = {
            id: placementId,
            device_id: deviceId,
            view_id: Number(appState.currentViewId),
            x: position.x,
            y: position.y
        };

        appState.devices.push(device);
        appState.placements.push(placement);

        markDirty();
        scheduleSave({ silent: true });
        appState.selectedPlacementIds.clear();
        appState.selectedPlacementIds.add(placementId);

        render();
        updatePlacementGhost(event.clientX, event.clientY);

        return true;
    }

    if (placementState.tab === 'unplaced') {
        // キュー方式：キュー先頭の機器を配置
        if (placementState.queue.length === 0) {
            showToast('配置待ちの機器がありません。パレットから選択してください', 'warning');
            return true;
        }

        const target = placementState.queue.shift();
        if (!getDeviceById(target.id)) {
            showToast(`「${target.name}」は削除されています`, 'warning');
            renderPlacementQueue();
            renderPlacementUnplacedList();
            hidePlacementGhost();
            return true;
        }
        const currentPlacements = getCurrentPlacements();

        // 二重配置防止
        if (currentPlacements.some(p => Number(p.device_id) === Number(target.id))) {
            showToast(`「${target.name}」は既にこのビューに配置されています`, 'warning');
            renderPlacementQueue();
            renderPlacementUnplacedList();
            return true;
        }

        const placementId = allocateLocalId('placements');
        const placement = {
            id: placementId,
            device_id: Number(target.id),
            view_id: Number(appState.currentViewId),
            x: position.x,
            y: position.y
        };

        appState.placements.push(placement);

        markDirty();
        scheduleSave({ silent: true });
        appState.selectedPlacementIds.clear();
        appState.selectedPlacementIds.add(placementId);

        render();
        renderPlacementQueue();
        renderPlacementUnplacedList();
        updatePlacementGhost(event.clientX, event.clientY);


        return true;
    }

    return false;
}
