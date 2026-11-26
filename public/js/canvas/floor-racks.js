import { appState, getCurrentView } from '../core/state.js';
import { eventBus } from '../core/event-bus.js';
import { isCurrentUserAdmin, requireAdminUiAction } from '../ui/access-control.js';
import { hasResourceConflict, scheduleSave } from '../core/save-queue.js';
import { beginCanvasHistoryDrag, recordPlacementMove } from '../core/placement-history.js';
import { markDirty } from '../ui/status-bar.js';
import { closePanel, closeLinkPanel, hasAnyUnappliedChanges } from '../ui/property-panel.js';
import { openFloorRackView } from '../modals/view-manager-modal.js';
import { isPlacementModeActive } from '../ui/placement-mode.js';
import { finishCanvasNotes } from './canvas-notes.js';
import { clampPosition } from './drag-drop.js';
import { suppressCanvasClickOnce } from './interaction-state.js';
import { render } from './renderer.js';
import { DEFAULT_DEVICE_WIDTH, DEFAULT_DEVICE_HEIGHT } from '../core/constants.js';

export const FLOOR_RACK_ICON = 'assets/icons/toolbar/rack.svg';
let selectedRackId = null;
let cancelDrag = null;
let refreshDrag = null;

export function getCurrentFloorRackPlacements() {
    return getCurrentView()?.view_type === 'floor'
        ? (appState.floorRackPlacements || []).filter(row => Number(row.floor_view_id) === Number(appState.currentViewId)) : [];
}

export function getSelectedFloorRackPlacement() {
    if (appState.selectedPlacementIds.size) return null;
    return getCurrentFloorRackPlacements().find(row => Number(row.rack_view_id) === selectedRackId) || null;
}

function rackElement(rackId) {
    return appState.deviceLayer?.querySelector(`[data-rack-view-id="${rackId}"]`);
}

function syncRackSelection(element, selected) {
    element.classList.toggle('selected', selected);
    element.querySelector('.floor-rack-trigger')?.setAttribute('aria-pressed', String(selected));
    const open = element.querySelector('.floor-rack-open');
    if (open) open.hidden = !selected;
}

function setSelectedRack(id) {
    if (selectedRackId === id) return;
    const previous = selectedRackId == null ? null : rackElement(selectedRackId);
    if (previous) syncRackSelection(previous, false);
    selectedRackId = id;
    const current = id == null ? null : rackElement(id);
    if (current) syncRackSelection(current, true);
}

export function clearFloorRackSelection() {
    setSelectedRack(null);
    cancelDrag?.();
}
eventBus.on('resources:reloaded', clearFloorRackSelection);
eventBus.on('resource:reloaded', ({ kind, id }) => {
    if (kind === 'views') cancelDrag?.(Number(id));
});
eventBus.on('resources:ids-remapped', maps => {
    if (selectedRackId != null) selectedRackId = Number(maps.views?.[selectedRackId] ?? selectedRackId);
});

function canUseRackControls() {
    return !appState.linkMode && !appState.noteMode && !isPlacementModeActive() &&
        !appState.floorPlanAdjustMode && !appState.isRangeSelecting;
}

function canEditRackPlacement(row) {
    return canUseRackControls() && isCurrentUserAdmin() && !appState.authExpired && !appState.isPinging &&
        appState.appStatus.state !== 'unconfirmed' && !hasResourceConflict('views', row.floor_view_id);
}

export async function removeSelectedFloorRack() {
    const row = getSelectedFloorRackPlacement();
    if (!row || !requireAdminUiAction() || !canEditRackPlacement(row)) return false;
    const rack = appState.views.find(view => Number(view.id) === Number(row.rack_view_id));
    if (!window.confirm(`ラック「${rack?.name || ''}」の配置を外しますか？\nラックビュー・棚板・搭載機器は削除されません。`)) return false;
    if (!await closePanel() || !await closeLinkPanel()) return false;
    if (getSelectedFloorRackPlacement() !== row || !canEditRackPlacement(row)) return false;
    appState.floorRackPlacements = appState.floorRackPlacements.filter(item => item !== row);
    clearFloorRackSelection();
    markDirty(); scheduleSave({ immediate: true, silent: true }); render();
    return true;
}

function selectRack(row) {
    const finish = () => {
        if (!canUseRackControls() || !getCurrentFloorRackPlacements().includes(row) ||
            finishCanvasNotes('selection') === false) return false;
        appState.selectedPlacementIds.clear();
        setSelectedRack(Number(row.rack_view_id));
        eventBus.emit('canvas:selection-changed');
        return true;
    };

    const hasDraft = hasAnyUnappliedChanges();
    if (getSelectedFloorRackPlacement() === row && !hasDraft) return true;
    if (hasDraft) {
        return (async () => {
            if (!await closePanel() || !await closeLinkPanel()) return false;
            return finish();
        })();
    }
    closePanel();
    closeLinkPanel();
    return finish();
}

function makeRackDraggable(trigger, element, row) {
    trigger.addEventListener('pointerdown', event => {
        if (event.button !== 0 || !canEditRackPlacement(row)) return;
        event.stopPropagation();
        cancelDrag?.();
        const start = { x: event.clientX, y: event.clientY };
        const before = { x: Number(row.x), y: Number(row.y) };
        const endHistoryDrag = beginCanvasHistoryDrag();
        const scale = appState.viewState.scale;
        let moved = false, ended = false, ready = false;
        let renderRafId = null;
        const onMove = move => {
            if (move.pointerId !== event.pointerId || ended) return;
            const dx = move.clientX - start.x, dy = move.clientY - start.y;
            if (!moved && Math.max(Math.abs(dx), Math.abs(dy)) <= 3) return;
            if (!getCurrentFloorRackPlacements().includes(row) || !canEditRackPlacement(row)) {
                finish(null); return;
            }
            if (!moved) {
                moved = true;
                const selection = selectRack(row);
                if (selection instanceof Promise) {
                    selection.then(ok => { ready = ok && !ended; });
                } else {
                    ready = selection;
                }
            }
            if (!ready) return;
            Object.assign(row, clampPosition(before.x + dx / scale, before.y + dy / scale));
            element.style.left = `${row.x}px`; element.style.top = `${row.y}px`;
            if (renderRafId === null) {
                renderRafId = window.requestAnimationFrame(() => {
                    renderRafId = null;
                    eventBus.emit('canvas:render-links');
                });
            }
        };
        const finish = end => {
            if (end && end.pointerId !== event.pointerId) return;
            ended = true;
            if (cancelDrag === null) return;
            document.removeEventListener('pointermove', onMove);
            document.removeEventListener('pointerup', onUp);
            document.removeEventListener('pointercancel', onCancel);
            cancelDrag = null;
            refreshDrag = null;
            if (renderRafId !== null) {
                window.cancelAnimationFrame(renderRafId);
                renderRafId = null;
            }
            if (moved) {
                suppressCanvasClickOnce();
                element.dataset.dragged = 'true';
                const recorded = end?.type === 'pointerup' && ready &&
                    recordPlacementMove(row.floor_view_id, [{
                        rackViewId: Number(row.rack_view_id), before, after: { x: Number(row.x), y: Number(row.y) }
                    }]);
                if (recorded) {
                    markDirty(); scheduleSave({ immediate: true, silent: true });
                } else {
                    Object.assign(row, before);
                    element.style.left = `${row.x}px`; element.style.top = `${row.y}px`;
                }
                if (ready) eventBus.emit('canvas:render-links');
            }
            endHistoryDrag();
        };
        const onUp = end => { onMove(end); finish(end); };
        const onCancel = end => finish(end);
        cancelDrag = viewId => {
            if (viewId == null || Number(row.floor_view_id) === viewId) finish(null);
        };
        refreshDrag = () => {
            const current = getCurrentFloorRackPlacements().find(item => Number(item.rack_view_id) === Number(row.rack_view_id));
            if (!current || !canEditRackPlacement(current)) { finish(null); return; }
            row = current;
            element = rackElement(row.rack_view_id) || element;
        };
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
        document.addEventListener('pointercancel', onCancel);
    });
}

export function renderFloorRacks() {
    for (const row of getCurrentFloorRackPlacements()) {
        const rack = appState.views.find(view => Number(view.id) === Number(row.rack_view_id) && view.view_type === 'rack');
        if (!rack) continue;
        const element = document.createElement('div');
        element.className = 'floor-rack';
        element.dataset.rackViewId = String(row.rack_view_id);
        const selected = getSelectedFloorRackPlacement() === row;
        element.classList.toggle('selected', selected);
        element.style.left = `${row.x}px`; element.style.top = `${row.y}px`;
        element.style.width = `${DEFAULT_DEVICE_WIDTH}px`; element.style.height = `${DEFAULT_DEVICE_HEIGHT}px`;
        const trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.className = 'floor-rack-trigger';
        trigger.setAttribute('aria-label', `ラック「${rack.name}」を選択`);
        trigger.setAttribute('aria-pressed', String(selected));
        const description = 'ダブルクリック、または選択後のボタンでラックビューを開く';
        trigger.setAttribute('aria-description', description);
        trigger.title = `クリックで選択 / ${description}${isCurrentUserAdmin() ? ' / ドラッグで移動' : ''}`;
        const icon = document.createElement('img'); icon.src = FLOOR_RACK_ICON; icon.alt = ''; icon.draggable = false;
        const label = document.createElement('span'); label.className = 'device-name'; label.textContent = rack.name;
        trigger.append(icon, label);

        const open = document.createElement('button');
        open.type = 'button'; open.className = 'btn btn-secondary floor-rack-open';
        open.textContent = 'ラックビューを開く';
        open.setAttribute('aria-label', `ラックビューを開く：${rack.name}`);
        open.hidden = !selected;
        const openSelected = () => {
            if (canUseRackControls() && getSelectedFloorRackPlacement() === row) return openFloorRackView(row.rack_view_id);
        };
        open.addEventListener('click', event => {
            event.stopPropagation();
            return openSelected();
        });

        let doubleClickReady = false;
        trigger.addEventListener('pointerdown', event => {
            if (event.button !== 0 || !element.dataset.dragged) return;
            doubleClickReady = false;
            delete element.dataset.dragged;
        });
        trigger.addEventListener('click', async event => {
            event.stopPropagation();
            if (appState.suppressNextClick || element.dataset.dragged || !canUseRackControls()) {
                doubleClickReady = false;
                appState.suppressNextClick = false;
                delete element.dataset.dragged;
                return;
            }
            // ネイティブの連続クリックは、ドラッグを含まない最初の1回で選択する。
            if (event.detail > 1) return;
            doubleClickReady = false;
            if (await selectRack(row)) doubleClickReady = event.detail === 1;
        });
        trigger.addEventListener('dblclick', event => {
            event.stopPropagation();
            if (!doubleClickReady || appState.suppressNextClick || element.dataset.dragged) return;
            doubleClickReady = false;
            return openSelected();
        });
        if (isCurrentUserAdmin()) makeRackDraggable(trigger, element, row);
        element.append(trigger, open);
        appState.deviceLayer.appendChild(element);
    }
    refreshDrag?.();
}
