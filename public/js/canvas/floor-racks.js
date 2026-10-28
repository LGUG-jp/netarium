import { appState, getCurrentView } from '../core/state.js';
import { eventBus } from '../core/event-bus.js';
import { isCurrentUserAdmin, requireAdminUiAction } from '../ui/access-control.js';
import { hasResourceConflict, scheduleSave } from '../core/save-queue.js';
import { markDirty } from '../ui/status-bar.js';
import { closePanel, closeLinkPanel } from '../ui/property-panel.js';
import { openFloorRackView } from '../modals/view-manager-modal.js';
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

export function clearFloorRackSelection() { selectedRackId = null; cancelDrag?.(); }
eventBus.on('resources:reloaded', () => { clearFloorRackSelection(); cancelDrag?.(); });
eventBus.on('resources:ids-remapped', maps => {
    if (selectedRackId != null) selectedRackId = Number(maps.views?.[selectedRackId] ?? selectedRackId);
});

export async function removeSelectedFloorRack() {
    const row = getSelectedFloorRackPlacement();
    if (!row || !requireAdminUiAction() || appState.authExpired || appState.appStatus.state === 'unconfirmed' ||
        hasResourceConflict('views', row.floor_view_id)) return false;
    const rack = appState.views.find(view => Number(view.id) === Number(row.rack_view_id));
    if (!window.confirm(`ラック「${rack?.name || ''}」の配置を外しますか？\nラックビュー・棚板・搭載機器は削除されません。`)) return false;
    if (!await closePanel() || !await closeLinkPanel()) return false;
    if (!getCurrentFloorRackPlacements().includes(row) || appState.appStatus.state === 'unconfirmed' ||
        hasResourceConflict('views', row.floor_view_id)) return false;
    appState.floorRackPlacements = appState.floorRackPlacements.filter(item => item !== row);
    clearFloorRackSelection();
    markDirty(); scheduleSave({ immediate: true, silent: true }); render();
    return true;
}

async function selectRack(row) {
    if (!await closePanel() || !await closeLinkPanel()) return false;
    if (!getCurrentFloorRackPlacements().includes(row)) return false;
    appState.selectedPlacementIds.clear();
    selectedRackId = Number(row.rack_view_id);
    eventBus.emit('canvas:selection-changed');
    return true;
}

function makeRackDraggable(element, row) {
    element.addEventListener('pointerdown', event => {
        if (event.button !== 0 || !isCurrentUserAdmin() || appState.authExpired || appState.isPinging ||
            appState.linkMode || appState.noteMode || appState.floorPlanAdjustMode || appState.appStatus.state === 'unconfirmed' ||
            hasResourceConflict('views', row.floor_view_id) || event.target.closest('button')) return;
        event.stopPropagation();
        cancelDrag?.();
        const start = { x: event.clientX, y: event.clientY, rowX: row.x, rowY: row.y };
        const scale = appState.viewState.scale;
        let moved = false, ended = false, ready = false;
        const onMove = move => {
            if (move.pointerId !== event.pointerId || ended) return;
            const dx = move.clientX - start.x, dy = move.clientY - start.y;
            if (!moved && Math.max(Math.abs(dx), Math.abs(dy)) <= 3) return;
            moved = true;
            if (!ready) return;
            if (!getCurrentFloorRackPlacements().includes(row) || hasResourceConflict('views', row.floor_view_id) || !isCurrentUserAdmin() || appState.authExpired) {
                finish(null); return;
            }
            Object.assign(row, clampPosition(Number(start.rowX) + dx / scale, Number(start.rowY) + dy / scale));
            element.style.left = `${row.x}px`; element.style.top = `${row.y}px`;
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
            if (moved) {
                suppressCanvasClickOnce();
                element.dataset.dragged = 'true';
                if (end?.type === 'pointerup' && ready) {
                    markDirty(); scheduleSave({ immediate: true, silent: true });
                } else Object.assign(row, { x: start.rowX, y: start.rowY });
                render();
            }
        };
        const onUp = end => { onMove(end); finish(end); };
        const onCancel = end => finish(end);
        cancelDrag = () => finish(null);
        refreshDrag = () => {
            const current = getCurrentFloorRackPlacements().find(item => Number(item.rack_view_id) === Number(row.rack_view_id));
            if (!current || hasResourceConflict('views', current.floor_view_id)) { finish(null); return; }
            row = current;
            element = appState.deviceLayer?.querySelector(`[data-rack-view-id="${row.rack_view_id}"]`) || element;
        };
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
        document.addEventListener('pointercancel', onCancel);
        selectRack(row).then(selected => { ready = selected && !ended; if (ready) element.classList.add('selected'); });
    });
}

export function renderFloorRacks() {
    for (const row of getCurrentFloorRackPlacements()) {
        const rack = appState.views.find(view => Number(view.id) === Number(row.rack_view_id) && view.view_type === 'rack');
        if (!rack) continue;
        const element = document.createElement('div');
        element.className = 'floor-rack';
        element.dataset.rackViewId = String(row.rack_view_id);
        element.classList.toggle('selected', getSelectedFloorRackPlacement() === row);
        element.style.left = `${row.x}px`; element.style.top = `${row.y}px`;
        element.style.width = `${DEFAULT_DEVICE_WIDTH}px`; element.style.height = `${DEFAULT_DEVICE_HEIGHT}px`;
        element.tabIndex = 0; element.setAttribute('role', 'link');
        element.setAttribute('aria-label', `ラック「${rack.name}」を開く`);
        const icon = document.createElement('img'); icon.src = FLOOR_RACK_ICON; icon.alt = ''; icon.draggable = false;
        const label = document.createElement('span'); label.className = 'device-name'; label.textContent = rack.name;
        element.title = `${rack.name}\nクリックでラックを開く${isCurrentUserAdmin() ? ' / ドラッグで移動' : ''}`;
        element.append(icon, label);
        element.addEventListener('click', event => {
            event.stopPropagation();
            if (appState.suppressNextClick || element.dataset.dragged) { appState.suppressNextClick = false; delete element.dataset.dragged; return; }
            if (appState.linkMode || appState.noteMode) return;
            if (isCurrentUserAdmin() && (event.ctrlKey || event.metaKey || event.shiftKey)) {
                selectRack(row).then(() => render()); return;
            }
            openFloorRackView(row.rack_view_id);
        });
        element.addEventListener('keydown', event => {
            if (event.target === element && (event.key === 'Enter' || event.key === ' ')) {
                event.preventDefault(); openFloorRackView(row.rack_view_id);
            }
        });
        if (isCurrentUserAdmin()) {
            const select = document.createElement('button'); select.type = 'button'; select.className = 'floor-rack-select';
            select.textContent = '選択'; select.title = '配置解除するラックを選択';
            select.disabled = appState.authExpired || appState.appStatus.state === 'unconfirmed' || hasResourceConflict('views', row.floor_view_id);
            select.addEventListener('click', event => { event.stopPropagation(); selectRack(row).then(() => { render(); document.getElementById('deleteSelectedBtn')?.focus(); }); });
            element.appendChild(select);
            makeRackDraggable(element, row);
        }
        appState.deviceLayer.appendChild(element);
    }
    refreshDrag?.();
}
