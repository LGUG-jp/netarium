/**
 * Netarium - modals/view-manager-modal.js
 */

import {
    DEFAULT_DEVICE_HEIGHT,
    DEFAULT_DEVICE_WIDTH,
    DEFAULT_VIEW_SCALE,
    MAX_VIEWS
} from '../core/constants.js';

import { appState } from '../core/state.js';
import { eventBus } from '../core/event-bus.js';
import { rememberLastView } from '../core/last-view.js';
import { endLinkMode } from '../core/link-mode.js';
import { mappedResourceId } from '../core/resource-save.js';
import { chooseUnsavedChanges } from '../core/unsaved-changes-dialog.js';
import {
    isCurrentUserAdmin,
    requireAdminUiAction,
    requireNotPinging
} from '../ui/access-control.js';
import {
    syncLinkModeButton
} from '../ui/toolbar-controls.js';
import {
    getCurrentView,
    allocateLocalId,
    toSavePlacement,
    toSaveView
} from '../core/state.js';
import { normalizeViewLinkRoute } from '../core/connection-data.js';
import { toSaveCanvasNote } from '../core/canvas-note-data.js';
import { MAX_RACK_U, toSaveRackSettings, toSaveRackMount } from '../core/rack-layout.js';
import { getFloorRackDestination, toSaveFloorRackPlacement } from '../core/floor-rack-data.js';
import { clearFloorRackSelection } from '../canvas/floor-racks.js';
import {
    applyViewTransform,
    getCanvasVisibleCenter,
    restoreCurrentViewState,
    saveCurrentViewState
} from '../canvas/pan-zoom.js';
import { commitCanvasNoteText } from '../canvas/canvas-notes.js';
import {
    normalizeText,
    setInputValue
} from '../core/utils.js';
import {
    buildViewOptionLabel
} from '../core/view-format.js';
import {
    render
} from '../canvas/renderer.js';
import {
    closeLinkPanel,
    closePanel,
    hasUnappliedPanelChanges,
    hasUnappliedLinkPanelChanges
} from '../ui/property-panel.js';
import {
    showToast
} from '../ui/toast.js';
import { setInputError } from '../ui/field-errors.js';
import { updateFormLengthFeedback } from '../ui/length-feedback.js';
import {
    markDirty
} from '../ui/status-bar.js';
import {
    flushSaveQueue, scheduleSave, hasResourceConflict, reloadConflictedResource,
    hasResourceChanges, isSaveInFlight, waitForActiveResourceSave
} from '../core/save-queue.js';
import {
    registerModalClose,
    registerModalOpen
} from '../core/modal-focus.js';
import { openFloorPlanManager } from './floor-plan-modal.js';
import { syncViewCombobox } from '../ui/view-combobox.js';
import { openChangeHistory } from './change-history-modal.js';
import { buildHierarchyTree, flattenHierarchyTree, syncHierarchyExpansion, populateFloorSelect, viewHierarchyPath } from '../core/building-hierarchy.js';
import { renderHierarchyEditor, resolveHierarchyEditor, clearHierarchyEditor, hasHierarchyEditorDraft } from './building-hierarchy-editor.js';

let viewManagerSelectedId = null;
let hierarchySelection = null;
const collapsedHierarchy = new Set();
const hierarchyExpansion = { collapsed: collapsedHierarchy, knownBranches: new Set(), selectedPath: null };
let acceptedManagerSearch = '';
let viewManagerSnapshot = null;
let viewManagerFormGeneration = 0;
let viewManagerApplyGeneration = 0;
const viewFormIds = ['vm-name', 'vm-type', 'vm-sort-order', 'vm-memo', 'vm-total-u', 'vm-location', 'vm-floor-id'];
let floorRackReturn = null;

export function openFloorRackView(rackViewId) {
    if (getCurrentView()?.view_type !== 'floor' ||
        !(appState.floorRackPlacements || []).some(row => Number(row.floor_view_id) === Number(appState.currentViewId) &&
            Number(row.rack_view_id) === Number(rackViewId)) ||
        !appState.views.some(view => Number(view.id) === Number(rackViewId) && view.view_type === 'rack')) return false;
    return switchView(rackViewId, { fromFloor: true });
}

export async function showFloorRackPlacement(rackViewId, { fromManager = false } = {}) {
    const generation = viewManagerFormGeneration;
    if (fromManager && (!await resolveUnappliedViewForm() || generation !== viewManagerFormGeneration)) return false;
    const destination = getFloorRackDestination(appState, rackViewId);
    if (!destination || !appState.canvas) {
        showToast('ラックアイコンの配置先が見つかりません', 'warning');
        return false;
    }
    const viewId = Number(destination.view.id);
    const sameView = Number(appState.currentViewId) === viewId;
    if (!await switchView(viewId)) return false;
    if (sameView && (!await closePanel() || !await closeLinkPanel())) return false;
    if (fromManager && generation !== viewManagerFormGeneration) return false;
    const current = getFloorRackDestination(appState, rackViewId);
    if (Number(current?.view.id) !== Number(appState.currentViewId)) return false;
    const icon = appState.deviceLayer?.querySelector(`[data-rack-view-id="${Number(rackViewId)}"]`)
        ?.querySelector('.floor-rack-trigger');
    if (!icon) return false;

    if (fromManager) hideViewManager({ restoreFocus: false });
    eventBus.emit('placement-mode:exit');
    const center = getCanvasVisibleCenter();
    const state = appState.viewState;
    state.scale = Math.max(state.scale, DEFAULT_VIEW_SCALE);
    state.panX = center.x - (Number(current.placement.x) + DEFAULT_DEVICE_WIDTH / 2) * state.scale;
    state.panY = center.y - (Number(current.placement.y) + DEFAULT_DEVICE_HEIGHT / 2) * state.scale;
    applyViewTransform();
    icon.focus({ preventScroll: true });
    return true;
}

export function renderFloorRackReturn() {
    document.getElementById('floor-rack-return')?.remove?.();
    if (!floorRackReturn) return;
    const origin = appState.views.find(view => Number(view.id) === Number(floorRackReturn.floorId) && view.view_type === 'floor');
    if (!origin || Number(appState.currentViewId) !== Number(floorRackReturn.rackId)) {
        floorRackReturn = null; return;
    }
    const header = document.getElementById('rack-header');
    if (!header) return;
    const button = document.createElement('button');
    button.id = 'floor-rack-return'; button.type = 'button'; button.className = 'btn btn-secondary btn-sm';
    button.textContent = '← 元の物理配置図へ戻る';
    button.title = origin.name;
    button.addEventListener('click', async () => {
        const target = floorRackReturn;
        if (target && await switchView(target.floorId)) {
            if (appState.canvas) {
                appState.canvas.scrollLeft = target.scrollLeft;
                appState.canvas.scrollTop = target.scrollTop;
            }
        }
    });
    header.prepend(button);
}

function readViewForm() {
    const fields = viewFormIds.map(id => String(document.getElementById(id)?.value ?? ''));
    fields.push(document.getElementById('vm-show-connections')?.checked === false ? '0' : '1');
    return fields;
}

function hasUnappliedViewForm() {
    const view = getViewManagerSelectedView();
    if (!view) return false;
    const settings = appState.rackSettings.find(row => Number(row.view_id) === Number(view.id));
    const values = [view.name, view.view_type, view.sort_order, view.memo,
        settings?.total_u ?? '', settings?.location ?? '', view.floor_id ?? '',
        Number(view.show_connections ?? 1) === 0 ? 0 : 1].map(value => String(value ?? ''));
    return readViewForm().some((value, index) => value !== values[index]);
}

export function updateViewManagerFormState() {
    appState.viewManagerFormDirty = hasUnappliedViewForm();
    updateViewManagerButtons();
}

async function resolveUnappliedViewForm() {
    const generation = viewManagerFormGeneration;
    if (!await resolveHierarchyEditor() || generation !== viewManagerFormGeneration) return false;
    if (!hasUnappliedViewForm()) return true;
    const choice = await chooseUnsavedChanges('未適用のビュー入力があります。どうしますか？');
    if (generation !== viewManagerFormGeneration) return false;
    if (choice === 'save') {
        if (!await applyViewForm()) return false;
        return generation === viewManagerFormGeneration && !hasUnappliedViewForm();
    }
    return choice === 'discard';
}

eventBus.on('resources:ids-remapped', maps => {
    viewManagerSelectedId = mappedResourceId(maps.views, viewManagerSelectedId);
    setInputValue('vm-id', viewManagerSelectedId ?? '');
    if (viewManagerSnapshot) {
        viewManagerSnapshot.views.forEach(view => { view.id = mappedResourceId(maps.views, view.id); });
        viewManagerSnapshot.placements.forEach(row => {
            row.id = mappedResourceId(maps.placements, row.id);
            row.device_id = mappedResourceId(maps.devices, row.device_id);
            row.view_id = mappedResourceId(maps.views, row.view_id);
        });
        viewManagerSnapshot.viewLinkRoutes = viewManagerSnapshot.viewLinkRoutes.map(row => normalizeViewLinkRoute({
            ...row, view_id: mappedResourceId(maps.views, row.view_id),
            device_a_id: mappedResourceId(maps.devices, row.device_a_id),
            device_b_id: mappedResourceId(maps.devices, row.device_b_id)
        }));
        viewManagerSnapshot.canvasNotes.forEach(note => {
            note.id = mappedResourceId(maps.canvas_notes, note.id);
            note.view_id = mappedResourceId(maps.views, note.view_id);
        });
        viewManagerSnapshot.rackSettings.forEach(row => { row.view_id = mappedResourceId(maps.views, row.view_id); });
        viewManagerSnapshot.floorRackPlacements.forEach(row => {
            row.floor_view_id = mappedResourceId(maps.views, row.floor_view_id);
            row.rack_view_id = mappedResourceId(maps.views, row.rack_view_id);
        });
        viewManagerSnapshot.rackMounts.forEach(row => {
            row.view_id = mappedResourceId(maps.views, row.view_id);
            row.device_id = mappedResourceId(maps.devices, row.device_id);
        });
        viewManagerSnapshot.rackShelves.forEach(row => {
            row.id = mappedResourceId(maps.rack_shelves, row.id);
            row.view_id = mappedResourceId(maps.views, row.view_id);
        });
        viewManagerSnapshot.rackShelfDevices.forEach(row => {
            row.shelf_id = mappedResourceId(maps.rack_shelves, row.shelf_id);
            row.device_id = mappedResourceId(maps.devices, row.device_id);
        });
        viewManagerSnapshot.currentViewId = mappedResourceId(maps.views, viewManagerSnapshot.currentViewId);
    }
    if (floorRackReturn) {
        floorRackReturn.floorId = mappedResourceId(maps.views, floorRackReturn.floorId);
        floorRackReturn.rackId = mappedResourceId(maps.views, floorRackReturn.rackId);
    }
    renderViewManagerList();
});

eventBus.on('resources:saved', () => {
    if (viewManagerSnapshot) viewManagerSnapshot = createViewManagerSnapshot();
});

eventBus.on('save-state:changed', updateViewManagerButtons);

eventBus.on('resources:reloaded', ({ source } = {}) => {
    if (source === 'hierarchy-editor') {
        viewManagerSnapshot = createViewManagerSnapshot();
        renderViewSelector(); render(); renderViewManagerList();
        return;
    }
    floorRackReturn = null;
    // 全再読込は既に確認済み。古いDOMを新モデルと比較して再確認しない。
    viewManagerFormGeneration++;
    viewManagerApplyGeneration++;
    appState.viewManagerFormDirty = false;
    hierarchySelection = null;
    clearHierarchyEditor();
    viewManagerSnapshot = null;
    viewManagerSelectedId = null;
    setInputValue('vm-id', '');
    const overlay = document.getElementById('view-manager-overlay');
    if (overlay && !overlay.hidden) {
        overlay.hidden = true;
        registerModalClose('view_manager');
    }
});

eventBus.on('hierarchy:changed', () => {
    renderViewSelector();
    render();
    if (!document.getElementById('view-manager-overlay')?.hidden) {
        renderViewManagerList();
        if (!hierarchySelection && !hasUnappliedViewForm()) loadSelectedViewIntoForm();
        viewManagerSnapshot = createViewManagerSnapshot();
    }
});

/**
 * ビュー管理
 */
export function openViewManager({ floorId } = {}) {
    if (!requireAdminUiAction()) {
        return;
    }
    const overlay =
        document.getElementById(
            'view-manager-overlay'
        );

    if (!overlay) {
        showToast(
            '建物・フロア・ビュー管理画面が見つかりません',
            'error'
        );
        return;
    }

    viewManagerSnapshot =
        createViewManagerSnapshot();

    appState.viewManagerFormDirty = false;

    const currentExists = appState.views.some(
        view =>
            Number(view.id) ===
            Number(appState.currentViewId)
    );

    viewManagerSelectedId =
        currentExists
            ? Number(appState.currentViewId)
            : (
                appState.views[0]
                    ? Number(appState.views[0].id)
                    : null
            );

    overlay.hidden = false;
    const viewForm = document.getElementById('view-manager-form');
    if (viewForm) viewForm.hidden = false;
    const embeddedEditor = document.getElementById('hierarchy-editor');
    if (embeddedEditor) embeddedEditor.hidden = true;
    hierarchySelection = null; clearHierarchyEditor();
    const rackPlacementButton = document.getElementById('vm-rack-go-to-placement');
    if (rackPlacementButton) {
        rackPlacementButton.onclick = () => showFloorRackPlacement(getViewManagerSelectedView()?.id, { fromManager: true });
    }
    for (const [id, kind] of [['hierarchy-add-building-btn', 'building'], ['hierarchy-add-floor-btn', 'floor']]) {
        const button = document.getElementById(id);
        if (button) button.onclick = async () => {
            const generation = viewManagerFormGeneration;
            if (!await resolveUnappliedViewForm() || generation !== viewManagerFormGeneration) return;
            const buildingId = hierarchySelection?.kind === 'building' ? hierarchySelection.id :
                appState.floors.find(floor => Number(floor.id) === Number(hierarchySelection?.id))?.building_id;
            selectHierarchyNode({ kind, building_id: buildingId });
        };
    }

    const floor = floorId == null ? null : appState.floors.find(row => Number(row.id) === Number(floorId));
    if (floor) {
        const search = document.getElementById('view-manager-search');
        if (search) search.value = '';
        selectHierarchyNode({ kind: 'floor', id: floor.id });
    } else {
        renderViewManagerList();
        loadSelectedViewIntoForm();
    }
    registerModalOpen('view_manager', overlay, floor ? '#hierarchy-representative_view_id' : '#view-manager-search',
        { onClose: () => closeViewManager() });
}



export function renderViewSelector() {
    rememberLastView(appState.currentViewId);
    syncViewCombobox();
}


export { buildViewOptionLabel };




export function switchView(nextViewId, { fromFloor = false } = {}) {
    if (!requireNotPinging()) {
        renderViewSelector();
        return false;
    }
    const normalizedId =
        Number(nextViewId);

    const exists = appState.views.some(
        view =>
            Number(view.id) ===
            normalizedId
    );

    if (!exists) {
        showToast(
            '指定されたビューが見つかりません',
            'warning'
        );
        renderViewSelector();
        return false;
    }

    const returnTarget = fromFloor && getCurrentView()?.view_type === 'floor' ? {
        floorId: Number(appState.currentViewId), rackId: normalizedId,
        scrollLeft: appState.canvas?.scrollLeft || 0, scrollTop: appState.canvas?.scrollTop || 0
    } : null;
    if (
        Number(appState.currentViewId) ===
        normalizedId
    ) {
        floorRackReturn = null;
        renderFloorRackReturn();
        return true;
    }

    if (hasUnappliedPanelChanges() || hasUnappliedLinkPanelChanges()) {
        return (async () => {
            if (!await closePanel()) {
                renderViewSelector();
                return false;
            }
            if (!await closeLinkPanel()) {
                renderViewSelector();
                return false;
            }
            return finishSwitchView(normalizedId, returnTarget);
        })();
    }

    closePanel();
    closeLinkPanel();
    return finishSwitchView(normalizedId, returnTarget);
}

function finishSwitchView(normalizedId, returnTarget) {
    if (getCurrentView()?.view_type === 'rack' && !commitCanvasNoteText()) {
        renderViewSelector();
        return false;
    }
    eventBus.emit('canvas-note:finish');
    eventBus.emit('floor-plan:finish');
    flushSaveQueue({ silent: true });

    if (
        appState.isRangeSelecting
    ) {
        appState.cancelActiveRangeSelection?.();
    }
    saveCurrentViewState();
    floorRackReturn = returnTarget;
    clearFloorRackSelection();

    appState.currentViewId = normalizedId;
    eventBus.emit('placement-mode:view-changed');

    appState.selectedPlacementIds.clear();
    appState.selectedCanvasNoteId = null;
    appState.noteMode = false;
    endLinkMode();

    syncLinkModeButton();

    restoreCurrentViewState();
    renderViewSelector();
    render();
    return true;

}


export function createViewManagerSnapshot() {
    return {
        views: appState.views.map(view => ({
            ...view
        })),

        placements:
            appState.placements.map(placement => ({
                ...placement
            })),

        viewLinkRoutes: appState.viewLinkRoutes.map(normalizeViewLinkRoute),

        canvasNotes: appState.canvasNotes.map(note => ({ ...note })),
        rackSettings: appState.rackSettings.map(row => ({ ...row })),
        rackMounts: appState.rackMounts.map(row => ({ ...row })),
        rackShelves: appState.rackShelves.map(row => ({ ...row })),
        rackShelfDevices: appState.rackShelfDevices.map(row => ({ ...row })),
        floorRackPlacements: (appState.floorRackPlacements || []).map(row => ({ ...row })),

        currentViewId:
            appState.currentViewId,

        appStatus: {
            dirty: appState.appStatus.dirty,
            state: appState.appStatus.state,
            lastSavedAt:
                appState.appStatus.lastSavedAt,
            lastError:
                appState.appStatus.lastError
        }
    };
}





export async function closeViewManager() {
    const overlay =
        document.getElementById(
            'view-manager-overlay'
        );

    if (!overlay || overlay.hidden) {
        return;
    }

    const generation = viewManagerFormGeneration;
    if (!await resolveUnappliedViewForm() || generation !== viewManagerFormGeneration) return;
    hideViewManager();
}

function hideViewManager({ restoreFocus = true } = {}) {
    const overlay = document.getElementById('view-manager-overlay');
    if (!overlay || overlay.hidden) return;
    hierarchySelection = null; clearHierarchyEditor();
    appState.viewManagerFormDirty = false;
    viewManagerFormGeneration++;

    overlay.hidden = true;
    registerModalClose('view_manager', { restoreFocus });
    viewManagerSnapshot = null;
    viewManagerSelectedId = null;
}


export function hasViewManagerChanges() {
    if (!viewManagerSnapshot) {
        return false;
    }

    const current = JSON.stringify({
        views: appState.views.map(toSaveView),
        placements:
            appState.placements.map(toSavePlacement),
        view_link_routes: appState.viewLinkRoutes,
        canvas_notes: appState.canvasNotes.map(toSaveCanvasNote),
        rack_settings: appState.rackSettings.map(toSaveRackSettings),
        rack_mounts: appState.rackMounts.map(toSaveRackMount),
        rack_shelves: appState.rackShelves,
        rack_shelf_devices: appState.rackShelfDevices,
        floor_rack_placements: (appState.floorRackPlacements || []).map(toSaveFloorRackPlacement)
    });

    const snapshot = JSON.stringify({
        views:
            viewManagerSnapshot.views
                .map(toSaveView),

        placements:
            viewManagerSnapshot
                .placements
                .map(toSavePlacement),

        view_link_routes: viewManagerSnapshot.viewLinkRoutes,
        canvas_notes: viewManagerSnapshot.canvasNotes.map(toSaveCanvasNote),
        rack_settings: viewManagerSnapshot.rackSettings.map(toSaveRackSettings),
        rack_mounts: viewManagerSnapshot.rackMounts.map(toSaveRackMount),
        rack_shelves: viewManagerSnapshot.rackShelves,
        rack_shelf_devices: viewManagerSnapshot.rackShelfDevices,
        floor_rack_placements: viewManagerSnapshot.floorRackPlacements.map(toSaveFloorRackPlacement)
    });

    return current !== snapshot;
}


function selectHierarchyNode(selection) {
    viewManagerFormGeneration++;
    hierarchySelection = selection;
    viewManagerSelectedId = selection?.kind === 'view' ? Number(selection.id) : null;
    if (selection?.kind === 'view') hierarchySelection = null;
    const form = document.getElementById('view-manager-form');
    const editor = document.getElementById('hierarchy-editor');
    const hierarchy = hierarchySelection && hierarchySelection.kind !== 'unclassified';
    if (form) form.hidden = Boolean(hierarchySelection);
    if (editor) {
        editor.hidden = !hierarchy;
        if (hierarchy) renderHierarchyEditor(editor, hierarchySelection, next => {
            hierarchySelection = next;
            viewManagerSnapshot = createViewManagerSnapshot();
            renderViewManagerList();
            if (!next) selectHierarchyNode({ kind: 'unclassified' });
        });
    }
    appState.viewManagerFormDirty = false;
    renderViewManagerList();
    if (!hierarchySelection) { clearHierarchyEditor(); loadSelectedViewIntoForm(); }
}

export function renderViewManagerList() {
    const list = document.getElementById('view-manager-list');
    if (!list) return;
    const searchInput = document.getElementById('view-manager-search');
    const search = normalizeText(searchInput?.value).trim().toLocaleLowerCase('ja');
    // フィルターで編集中の行を見失わないよう、未適用入力がある間は変更しない。
    if (search !== acceptedManagerSearch && (hasUnappliedViewForm() || hasHierarchyEditorDraft())) {
        if (searchInput) searchInput.value = acceptedManagerSearch;
        return;
    }
    acceptedManagerSearch = search;
    const matches = item => [item.row?.name, item.row?.memo,
        item.kind === 'view' ? viewHierarchyPath(item.row, appState) : '',
        item.kind === 'unclassified' ? '未分類ビュー' : ''].join(' ').toLocaleLowerCase('ja').includes(search);
    const filter = items => items.flatMap(item => {
        const children = filter(item.children);
        return !search || matches(item) || children.length ? [{ ...item, children: matches(item) ? item.children : children }] : [];
    });
    const selectedKey = hierarchySelection ? `${hierarchySelection.kind}${hierarchySelection.id == null ? '' : `:${hierarchySelection.id}`}` : `view:${viewManagerSelectedId}`;
    const tree = buildHierarchyTree(appState);
    syncHierarchyExpansion(tree, hierarchyExpansion, selectedKey);
    const unclassifiedCount = tree.find(item => item.kind === 'unclassified')?.children.length || 0;
    const entries = flattenHierarchyTree(filter(tree), search ? new Set() : collapsedHierarchy);
    list.replaceChildren();
    entries.forEach((item, index) => {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'view-manager-list-item';
        button.dataset.nodeKey = item.key;
        if (item.kind === 'view') button.dataset.viewId = String(item.row.id);
        button.style.paddingInlineStart = `${12 + item.depth * 18}px`;
        button.setAttribute('role', 'treeitem');
        button.setAttribute('aria-level', String(item.depth + 1));
        button.setAttribute('aria-selected', String(item.key === selectedKey));
        button.classList.toggle('selected', item.key === selectedKey);
        button.tabIndex = item.key === selectedKey || (!entries.some(entry => entry.key === selectedKey) && index === 0) ? 0 : -1;
        button.addEventListener('focus', () => {
            list.querySelectorAll('[role="treeitem"]').forEach(element => { element.tabIndex = element === button ? 0 : -1; });
        });
        const branch = item.kind !== 'view';
        if (branch) button.setAttribute('aria-expanded', String(!collapsedHierarchy.has(item.key) || Boolean(search)));
        const labelText = `${branch ? collapsedHierarchy.has(item.key) && !search ? '▸ ' : '▾ ' : ''}${item.kind === 'unclassified' ? `未分類ビュー（${unclassifiedCount}件）` : item.row?.name}${item.kind === 'view' &&
            appState.floors.some(floor => Number(floor.representative_view_id) === Number(item.row.id)) ? '（代表）' : ''}`;
        if (branch) {
            button.textContent = labelText;
        } else {
            button.classList.add('view-manager-view');
            const icon = document.createElement('img');
            const type = item.row.view_type;
            icon.className = 'view-manager-type-icon';
            icon.src = `assets/icons/toolbar/${type === 'rack' ? 'rack' : type === 'floor' ? 'floor-plan' : 'link'}.svg`;
            icon.alt = type === 'rack' ? 'ラック搭載図' : type === 'floor' ? '物理・フロア配置図' : '論理構成図';
            icon.width = 16; icon.height = 16;
            const label = document.createElement('span');
            label.className = 'view-manager-view-name';
            label.textContent = labelText;
            button.append(icon, label);
        }
        const focusKey = key => Array.from(list.querySelectorAll('[role="treeitem"]')).find(element => element.dataset.nodeKey === key)?.focus();
        const toggle = async () => {
            const generation = viewManagerFormGeneration;
            if (!await resolveUnappliedViewForm() || generation !== viewManagerFormGeneration) return;
            if (!search && collapsedHierarchy.has(item.key)) collapsedHierarchy.delete(item.key);
            else if (!search) collapsedHierarchy.add(item.key);
            renderViewManagerList(); focusKey(item.key);
        };
        button.addEventListener('click', async () => {
            if (item.key === selectedKey && branch) { await toggle(); return; }
            const generation = viewManagerFormGeneration;
            if (!await resolveUnappliedViewForm() || generation !== viewManagerFormGeneration) return;
            clearHierarchyEditor();
            selectHierarchyNode({ kind: item.kind, id: item.row?.id });
            focusKey(item.key);
        });
        button.addEventListener('keydown', async event => {
            const offset = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
            if (offset || event.key === 'Home' || event.key === 'End') {
                event.preventDefault();
                focusKey(entries[event.key === 'Home' ? 0 : event.key === 'End' ? entries.length - 1 : Math.max(0, Math.min(entries.length - 1, index + offset))].key);
            } else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
                event.preventDefault();
                if (branch && !search && ((event.key === 'ArrowRight') === collapsedHierarchy.has(item.key))) await toggle();
                else if (event.key === 'ArrowRight' && entries[index + 1]?.depth > item.depth) focusKey(entries[index + 1].key);
                else if (event.key === 'ArrowLeft') focusKey(entries.slice(0, index).reverse().find(entry => entry.depth < item.depth)?.key);
            }
        });
        list.appendChild(button);
    });
    const count = document.getElementById('view-manager-count');
    if (count) count.textContent = `${appState.views.length} / ${MAX_VIEWS}件`;
    updateViewManagerButtons();
}


export function getViewManagerSelectedView() {
    return appState.views.find(
        view =>
            Number(view.id) ===
            Number(viewManagerSelectedId)
    ) || null;
}


export function loadSelectedViewIntoForm() {
    const view =
        getViewManagerSelectedView();

    const form =
        document.getElementById(
            'view-manager-form'
        );

    if (!form) {
        return;
    }

    viewManagerFormGeneration++;
    for (const id of viewFormIds) {
        setInputError(document.getElementById(id), document.getElementById(`${id}-error`), '');
    }
    const disabled = !view;
    const floorSelect = document.getElementById('vm-floor-id');
    populateFloorSelect(floorSelect, appState, view?.floor_id);

    form
        .querySelectorAll(
            'input, select, textarea, button'
        )
        .forEach(element => {
            element.disabled = disabled;
        });

    const displaySetting = document.getElementById('vm-connections-setting');
    const displayCheckbox = document.getElementById('vm-show-connections');
    const showSetting = Boolean(view) && view.view_type !== 'rack';
    if (displaySetting) displaySetting.hidden = !showSetting;
    if (displayCheckbox) {
        displayCheckbox.disabled = !showSetting;
        displayCheckbox.checked = Number(view?.show_connections ?? 1) !== 0;
    }

    if (!view) {
        setInputValue('vm-id', '');
        setInputValue('vm-name', '');
        setInputValue('vm-type', 'topology');
        setInputValue('vm-sort-order', '0');
        setInputValue('vm-memo', '');
        setInputValue('vm-total-u', '');
        setInputValue('vm-location', '');
        const rackFields = document.getElementById('vm-rack-fields');
        if (rackFields) rackFields.hidden = true;
        
        appState.viewManagerFormDirty = false;
        updateViewManagerButtons();
        return;
    }

    setInputValue('vm-id', view.id);
    setInputValue('vm-name', view.name);
    setInputValue(
        'vm-type',
        view.view_type
    );
    setInputValue(
        'vm-sort-order',
        view.sort_order
    );
    setInputValue('vm-memo', view.memo);
    const settings = appState.rackSettings.find(row => Number(row.view_id) === Number(view.id));
    setInputValue('vm-total-u', settings?.total_u ?? '');
    setInputValue('vm-location', settings?.location ?? '');
    const rackFields = document.getElementById('vm-rack-fields');
    if (rackFields) rackFields.hidden = view.view_type !== 'rack';
    const typeSelect = document.getElementById('vm-type');
    if (typeSelect) {
        typeSelect.disabled = view.view_type === 'rack';
        for (const option of typeSelect.options) option.disabled = option.value === 'rack' && view.view_type !== 'rack';
    }
    updateFormLengthFeedback(form);

    appState.viewManagerFormDirty = false;
    updateViewManagerButtons();
}


export async function applyViewForm() {
    if (!requireAdminUiAction()) {
        return false;
    }
    const view =
        getViewManagerSelectedView();

    if (!view) {
        showToast(
            '編集するビューを選択してください',
            'warning'
        );
        return false;
    }

    if (hasResourceConflict('views', view.id)) {
        showToast('このビューは競合しています。「このビューを再読込」で最新データを取得してください', 'warning');
        updateViewManagerButtons();
        return false;
    }
    const generation = viewManagerFormGeneration;
    const submittedInputs = readViewForm();
    const [rawName, rawType, rawOrder, rawMemo, rawTotalU, rawLocation, rawFloorId, rawShowConnections] = submittedInputs;
    const values = {
        name: rawName.trim(),
        view_type: ['floor', 'rack'].includes(rawType) ? rawType : 'topology',
        sort_order: Number(rawOrder),
        memo: rawMemo.trim()
    };
    for (const id of viewFormIds) {
        setInputError(document.getElementById(id), document.getElementById(`${id}-error`), '');
    }
    const limits = [['name', 100, 'ビュー名', 'vm-name'], ['memo', 1000, '備考', 'vm-memo']];
    if (!values.name) {
        setInputError(document.getElementById('vm-name'), document.getElementById('vm-name-error'), 'ビュー名を入力してください');
        document.getElementById('vm-name')?.focus();
        return false;
    }
    for (const [key, maximum, label, inputId] of limits) {
        if (Array.from(values[key]).length > maximum) {
            setInputError(document.getElementById(inputId), document.getElementById(`${inputId}-error`), `${label}は${maximum}文字以内で入力してください`);
            document.getElementById(inputId)?.focus();
            return false;
        }
    }
    if (!Number.isInteger(values.sort_order) || Math.abs(values.sort_order) > 999999) {
        setInputError(document.getElementById('vm-sort-order'), document.getElementById('vm-sort-order-error'), '表示順は-999999から999999の整数で入力してください');
        document.getElementById('vm-sort-order')?.focus();
        return false;
    }
    if (appState.views.some(item => Number(item.id) !== Number(view.id) &&
        normalizeText(item.name).trim().toLocaleLowerCase('ja') === values.name.toLocaleLowerCase('ja'))) {
        setInputError(document.getElementById('vm-name'), document.getElementById('vm-name-error'), '同じビュー名が既に存在します');
        document.getElementById('vm-name')?.focus();
        return false;
    }
    if ((view.view_type === 'rack') !== (values.view_type === 'rack')) {
        setInputError(document.getElementById('vm-type'), document.getElementById('vm-type-error'),
            '既存ビューとラックの種別は相互に変更できません。新しいビューを登録してください');
        return false;
    }
    let rackSettings = null;
    if (view.view_type === 'rack') {
        rackSettings = { view_id: Number(view.id), total_u: Number(rawTotalU), location: rawLocation.trim() };
        let error = '';
        if (!Number.isInteger(rackSettings.total_u) || rackSettings.total_u < 1 || rackSettings.total_u > MAX_RACK_U) {
            error = `総U数は1〜${MAX_RACK_U}の整数で入力してください`;
        } else if ([...appState.rackMounts, ...appState.rackShelves].some(row => Number(row.view_id) === Number(view.id) &&
            Number(row.start_u) + Number(row.height_u) - 1 > rackSettings.total_u)) {
            error = '搭載機器の範囲を切り捨てる総U数には変更できません';
        }
        if (error) {
            setInputError(document.getElementById('vm-total-u'), document.getElementById('vm-total-u-error'), error);
            document.getElementById('vm-total-u')?.focus();
            return false;
        }
        if (Array.from(rackSettings.location).length > 150) {
            setInputError(document.getElementById('vm-location'), document.getElementById('vm-location-error'),
                '設置場所は150文字以内で入力してください');
            document.getElementById('vm-location')?.focus();
            return false;
        }
    }
    const floorId = rawFloorId ? Number(rawFloorId) : null;
    if (floorId !== null && !appState.floors.some(floor => Number(floor.id) === floorId)) {
        setInputError(document.getElementById('vm-floor-id'), document.getElementById('vm-floor-id-error'), '所属フロアを選び直してください');
        return false;
    }

    const previousSettings = appState.rackSettings.find(row => Number(row.view_id) === Number(view.id));
    const showConnections = view.view_type === 'rack' ? toSaveView(view).show_connections : Number(rawShowConnections);
    const changed = JSON.stringify(toSaveView(view)) !== JSON.stringify(toSaveView({
        ...view, ...values, floor_id: floorId, show_connections: showConnections
    })) ||
        (rackSettings && JSON.stringify(previousSettings && toSaveRackSettings(previousSettings)) !== JSON.stringify(rackSettings));
    if (rackSettings) {
        if (previousSettings) Object.assign(previousSettings, rackSettings);
        else appState.rackSettings.push(rackSettings);
    }
    Object.assign(view, values);
    view.floor_id = floorId;
    view.show_connections = showConnections;
    if (view.view_type !== 'floor') {
        appState.floorRackPlacements = (appState.floorRackPlacements || []).filter(row => Number(row.floor_view_id) !== Number(view.id));
    }
    // 確定済みモデルと未適用DOM入力を分ける。通信中の入力は以後触らない。
    Object.values(values).forEach((value, index) => setInputValue(viewFormIds[index], value));
    if (rackSettings) {
        setInputValue('vm-total-u', rackSettings.total_u);
        setInputValue('vm-location', rackSettings.location);
    }
    const committedInputs = readViewForm();
    const applyGeneration = ++viewManagerApplyGeneration;
    appState.viewManagerFormDirty = false;
    if (changed) markDirty();
    renderViewManagerList();
    renderViewSelector();
    const saved = await flushSaveQueue({ silent: true });
    if (generation === viewManagerFormGeneration && applyGeneration === viewManagerApplyGeneration) {
        appState.viewManagerFormDirty = readViewForm().some((value, index) => value !== committedInputs[index]);
        updateViewManagerButtons();
    }
    if (!saved || hasResourceConflict('views', view.id)) return false;

    renderViewManagerList();
    renderViewSelector();
    if (Number(appState.currentViewId) === Number(view.id)) render();


    return true;
}


export async function addView(requestedType = null) {
    if (!requireAdminUiAction()) {
        return;
    }
    if (appState.views.length >= MAX_VIEWS) {
        showToast(
            `ビューは最大${MAX_VIEWS}件までです`,
            'warning'
        );
        return;
    }
    const generation = viewManagerFormGeneration;
    if (!await resolveUnappliedViewForm() || generation !== viewManagerFormGeneration ||
        !isCurrentUserAdmin() || appState.authExpired || appState.views.length >= MAX_VIEWS) return;

    const inheritedFloorId = hierarchySelection?.kind === 'floor' &&
        appState.floors.some(floor => Number(floor.id) === Number(hierarchySelection.id)) ? Number(hierarchySelection.id) : null;
    hierarchySelection = null; clearHierarchyEditor();
    const form = document.getElementById('view-manager-form');
    if (form) form.hidden = false;
    const editor = document.getElementById('hierarchy-editor');
    if (editor) editor.hidden = true;
    const id = allocateLocalId('views');
    const selectedType = requestedType ?? document.getElementById('vm-new-type')?.value;
    const viewType = ['floor', 'rack'].includes(selectedType) ? selectedType : 'topology';

    const sortOrder = appState.views.reduce(
        (max, view) =>
            Math.max(
                max,
                Number(view.sort_order) || 0
            ),
        0
    ) + 10;

    const view = {
        id,
        name: createUniqueViewName(
            viewType === 'rack' ? '新しいラック' : '新しいビュー'
        ),
        facility: '',
        floor: '',
        floor_id: inheritedFloorId,
        view_type: viewType,
        sort_order: sortOrder,
        memo: ''
    };

    appState.views.push(view);
    if (viewType === 'rack') appState.rackSettings.push({ view_id: id, total_u: 42, location: '' });

    markDirty();
    scheduleSave({ immediate: true, silent: true });
    viewManagerSelectedId = id;

    renderViewManagerList();
    loadSelectedViewIntoForm();
    renderViewSelector();

    document
        .getElementById('vm-name')
        ?.focus();
}


export function createUniqueViewName(baseName, suffix = '') {
    const usedNames = new Set(appState.views.map(view =>
        normalizeText(view.name).trim().toLocaleLowerCase('ja')));
    const base = Array.from(normalizeText(baseName).trim());
    for (let number = 1; ; number++) {
        const ending = `${suffix}${number === 1 ? '' : number}`;
        const candidate = base.slice(0, Math.max(0, 100 - Array.from(ending).length)).join('') + ending;
        if (!usedNames.has(candidate.toLocaleLowerCase('ja'))) return candidate;
    }
}


export async function duplicateSelectedView() {
    if (!requireAdminUiAction()) {
        return;
    }
    const generation = viewManagerFormGeneration;
    if (!await resolveUnappliedViewForm() || generation !== viewManagerFormGeneration) return;
    const source =
        getViewManagerSelectedView();

    if (!source) {
        showToast(
            '複製するビューを選択してください',
            'warning'
        );
        return;
    }

    if (appState.views.length >= MAX_VIEWS) {
        showToast(
            `ビューは最大${MAX_VIEWS}件までです`,
            'warning'
        );
        return;
    }

    const sourceSettings = appState.rackSettings.find(row => Number(row.view_id) === Number(source.id));
    if (source.view_type === 'rack' && !sourceSettings) {
        showToast('ラック設定がありません。最新データを再読込してください', 'error');
        return;
    }
    const newViewId = allocateLocalId('views');

    const duplicatedView = {
        ...toSaveView(source),
        id: newViewId,
        name: createUniqueViewName(source.name, ' のコピー'),
        sort_order:
            Number(source.sort_order) + 1
    };

    appState.views.push(duplicatedView);
    if (source.view_type === 'rack') {
        appState.rackSettings.push({ ...toSaveRackSettings(sourceSettings), view_id: newViewId });
    } else {

    appState.placements
        .filter(placement =>
            Number(placement.view_id) ===
            Number(source.id)
        )
        .forEach(placement => {
            const newPlacementId = allocateLocalId('placements');

            appState.placements.push({
                ...placement,
                id: newPlacementId,
                view_id: newViewId
            });
        });

    appState.viewLinkRoutes.push(...appState.viewLinkRoutes.filter(row => Number(row.view_id) === Number(source.id))
        .map(row => normalizeViewLinkRoute({ ...row, view_id: newViewId })));
    }
    appState.canvasNotes.filter(note => Number(note.view_id) === Number(source.id)).forEach(note => {
        appState.canvasNotes.push({
            ...toSaveCanvasNote(note),
            id: allocateLocalId('canvasNotes'),
            view_id: newViewId
        });
    });

    markDirty();
    scheduleSave({ immediate: true, silent: true });
    viewManagerSelectedId =
        newViewId;

    renderViewManagerList();
    loadSelectedViewIntoForm();
    renderViewSelector();

}


export async function deleteSelectedView() {
    if (!requireAdminUiAction()) {
        return;
    }
    const view =
        getViewManagerSelectedView();

    if (!view) {
        showToast(
            '削除するビューを選択してください',
            'warning'
        );
        return;
    }
    if (view.view_type === 'rack' && [...appState.rackMounts, ...appState.rackShelves].some(row => Number(row.view_id) === Number(view.id))) {
        showToast('搭載機器が残るラックは削除できません。先にすべての機器を取り外してください', 'warning');
        return;
    }
    const generation = viewManagerFormGeneration;
    if (!await resolveUnappliedViewForm() || generation !== viewManagerFormGeneration) return;

    if (appState.views.length <= 1) {
        showToast(
            '最後の1ビューは削除できません',
            'warning'
        );
        return;
    }

    const placementCount =
        appState.placements.filter(
            placement =>
                Number(placement.view_id) ===
                Number(view.id)
        ).length;

    const routeCount = appState.viewLinkRoutes.filter(row => Number(row.view_id) === Number(view.id)).length;

    const noteCount = appState.canvasNotes.filter(note => Number(note.view_id) === Number(view.id)).length;

    const confirmed = confirm(
        `ビュー「${view.name}」を削除しますか?\n\n` +
        `配置: ${placementCount}件\n` +
        `手動経路: ${routeCount}件\n` +
        `メモ: ${noteCount}件\n\n` +
        '機器台帳と共通接続は削除されません。'
    );

    if (!confirmed) {
        return;
    }

    const deletedViewId =
        Number(view.id);

    if (Number(appState.currentViewId) === deletedViewId) eventBus.emit('canvas-note:finish');

    appState.views = appState.views.filter(
        item =>
            Number(item.id) !==
            deletedViewId
    );

    appState.rackSettings = appState.rackSettings.filter(row => Number(row.view_id) !== deletedViewId);
    appState.floorRackPlacements = (appState.floorRackPlacements || []).filter(row =>
        Number(row.floor_view_id) !== deletedViewId && Number(row.rack_view_id) !== deletedViewId);
    if (floorRackReturn && [floorRackReturn.floorId, floorRackReturn.rackId].includes(deletedViewId)) floorRackReturn = null;
    appState.placements = appState.placements.filter(
        placement =>
            Number(placement.view_id) !==
            deletedViewId
    );

    appState.viewLinkRoutes = appState.viewLinkRoutes.filter(row => Number(row.view_id) !== deletedViewId);

    appState.canvasNotes = appState.canvasNotes.filter(note => Number(note.view_id) !== deletedViewId);
    if (!appState.canvasNotes.some(note => Number(note.id) === Number(appState.selectedCanvasNoteId))) {
        appState.selectedCanvasNoteId = null;
    }

    markDirty();
    scheduleSave({ immediate: true, silent: true });
    appState.viewStates.delete(deletedViewId);

    if (
        Number(appState.currentViewId) ===
        deletedViewId
    ) {
        const firstView = [...appState.views]
            .sort((a, b) =>
                Number(a.sort_order) -
                Number(b.sort_order)
            )[0];

        appState.currentViewId = firstView
            ? Number(firstView.id)
            : null;

        appState.selectedPlacementIds.clear();
        appState.selectedCanvasNoteId = null;
        appState.noteMode = false;
        appState.editingDeviceId = null;
        appState.editingLinkId = null;

        await closePanel();
        await closeLinkPanel();
        restoreCurrentViewState();
    }

    const nextSelection = [...appState.views]
        .sort((a, b) =>
            Number(a.sort_order) -
            Number(b.sort_order)
        )[0];

    viewManagerSelectedId =
        nextSelection
            ? Number(nextSelection.id)
            : null;

    renderViewManagerList();
    loadSelectedViewIntoForm();
    renderViewSelector();
    render();

}


function isConfirmedView(view) {
    return Boolean(view) && Number.isSafeInteger(Number(view.id)) && Number(view.id) > 0 &&
        Number.isSafeInteger(Number(view.resource_revision)) && Number(view.resource_revision) > 0;
}

export function updateViewManagerButtons() {
    const selected =
        Boolean(
            getViewManagerSelectedView()
        );

    const addButton =
        document.getElementById(
            'view-add-btn'
        );

    const duplicateButton =
        document.getElementById(
            'view-duplicate-btn'
        );

    const deleteButton =
        document.getElementById(
            'view-delete-btn'
        );

    const applyButton =
        document.getElementById(
            'view-apply-btn'
        );

    const floorButton = document.getElementById('hierarchy-add-floor-btn');
    if (floorButton) floorButton.disabled = !appState.buildings.length;
    if (addButton) {
        addButton.disabled =
            appState.views.length >= MAX_VIEWS;
    }
    for (const type of ['topology', 'floor', 'rack']) {
        const button = document.getElementById(`view-add-${type}-btn`);
        if (button) button.disabled = !isCurrentUserAdmin() || appState.authExpired || appState.views.length >= MAX_VIEWS;
    }

    if (duplicateButton) {
        duplicateButton.disabled =
            !selected ||
            appState.views.length >= MAX_VIEWS;
    }
    if (duplicateButton) duplicateButton.textContent = '複製';

    if (deleteButton) {
        deleteButton.disabled =
            !selected ||
            appState.views.length <= 1;
    }

    if (applyButton) {
        const canApply = hasUnappliedViewForm() ||
            (!isSaveInFlight() && appState.appStatus.state !== 'unconfirmed' &&
                hasResourceChanges('views', viewManagerSelectedId));
        applyButton.disabled = !selected || !isCurrentUserAdmin() || appState.authExpired ||
            hasResourceConflict('views', viewManagerSelectedId) || !canApply;
    }
    const reloadButton = document.getElementById('view-conflict-reload-btn');
    if (reloadButton) {
        reloadButton.hidden = !selected || !hasResourceConflict('views', viewManagerSelectedId);
        reloadButton.disabled = reloadButton.hidden;
    }
    const historyButton = document.getElementById('view-history-btn');
    if (historyButton) {
        const currentSelected = getViewManagerSelectedView();
        const confirmed = isConfirmedView(currentSelected);
        historyButton.hidden = !isCurrentUserAdmin();
        historyButton.disabled = !confirmed || !isCurrentUserAdmin() || appState.authExpired;
        historyButton.title = confirmed
            ? 'このビューの変更履歴を表示します'
            : 'ビューの保存が完了すると変更履歴を表示できます';
    }
    const floorPlanActions = document.getElementById('vm-floor-plan-actions');
    const floorPlanButton = document.getElementById('vm-floor-plan-btn');
    const floorPlanStatus = document.getElementById('vm-floor-plan-status');
    const floorPlanHelp = document.getElementById('vm-floor-plan-help');
    const selectedView = getViewManagerSelectedView();
    const rackDestination = selectedView?.view_type === 'rack' ? getFloorRackDestination(appState, selectedView.id) : null;
    const rackPlacementText = document.getElementById('vm-rack-destination');
    if (rackPlacementText) rackPlacementText.textContent = rackDestination
        ? `${viewHierarchyPath(rackDestination.view, appState)} / ${rackDestination.view.name}` : '未配置';
    const rackPlacementButton = document.getElementById('vm-rack-go-to-placement');
    if (rackPlacementButton) rackPlacementButton.hidden = !rackDestination;

    const isFloor = Boolean(selectedView) && document.getElementById('vm-type')?.value === 'floor';
    const hasFloorPlan = isFloor && appState.floorPlans.some(plan => Number(plan.view_id) === Number(selectedView.id));
    const floorPlanBlockReason = getSelectedViewFloorPlanBlockReason();
    if (floorPlanActions) floorPlanActions.hidden = !isFloor;
    if (floorPlanButton) {
        floorPlanButton.disabled = Boolean(floorPlanBlockReason);
        floorPlanButton.textContent = hasFloorPlan ? '図面を管理' : '図面を登録';
    }
    if (floorPlanStatus) floorPlanStatus.hidden = !hasFloorPlan;
    if (floorPlanHelp) floorPlanHelp.textContent = isFloor ? floorPlanBlockReason : '';
}

function getSelectedViewFloorPlanBlockReason() {
    const view = getViewManagerSelectedView();
    if (!view) return '図面を登録するビューを選択してください。';
    if (!isCurrentUserAdmin() || appState.authExpired) return '管理者としてログインしてください。';
    if (document.getElementById('vm-type')?.value !== 'floor') {
        return '種別に「物理・フロア配置図」を選択してください。';
    }
    if (hasResourceConflict('views', view.id)) return 'このビューの競合を再読込して解消してください。';
    if (hasUnappliedViewForm()) return '入力を「適用」して保存を完了してください。';
    if (!(Number(view.resource_revision) > 0) || hasResourceChanges('views', view.id)) {
        return 'ビューの保存が完了すると図面を登録できます。';
    }
    return '';
}

export async function openSelectedViewFloorPlan() {
    if (!requireAdminUiAction()) return;
    const reason = getSelectedViewFloorPlanBlockReason();
    if (reason) {
        showToast(reason, 'warning');
        return;
    }
    const id = viewManagerSelectedId;
    const generation = viewManagerFormGeneration;
    if (!await switchView(id)) return;
    // ビュー切替の確認中に選択や入力が変わった場合、別の対象で図面管理を開かない。
    if (generation !== viewManagerFormGeneration || id !== viewManagerSelectedId ||
        Number(appState.currentViewId) !== Number(id) || getSelectedViewFloorPlanBlockReason()) return;
    // 図面調整では図面管理だけを隠すため、背後のビュー管理を残さない。
    hideViewManager({ restoreFocus: false });
    document.getElementById('floor-plan-manage-btn')?.focus();
    openFloorPlanManager({ returnToViewManager: true });
}

export async function openSelectedViewHistory() {
    if (!requireAdminUiAction()) return false;
    const view = getViewManagerSelectedView();
    if (!isConfirmedView(view)) {
        showToast('ビューの保存が完了すると変更履歴を表示できます', 'warning');
        return false;
    }
    const selectedId = Number(view.id);
    const hadUnapplied = hasUnappliedViewForm();
    if (!await resolveUnappliedViewForm()) return false;
    if (hadUnapplied && hasUnappliedViewForm()) {
        loadSelectedViewIntoForm();
    }
    await waitForActiveResourceSave();
    const latestView = getViewManagerSelectedView();
    if (!isConfirmedView(latestView) || Number(latestView.id) !== selectedId) return false;
    if (appState.authExpired || hasResourceConflict('views', selectedId) ||
        hasResourceChanges('views', selectedId) || hasUnappliedViewForm()) {
        showToast('ビューの保存が完了していません。建物・フロア・ビュー管理で保存状態と入力を確認してください', 'warning');
        return false;
    }
    await openChangeHistory({
        targetType: 'view',
        targetId: Number(latestView.id),
        targetName: latestView.name || ''
    });
    return true;
}

export async function reloadSelectedViewConflict() {
    if (!requireAdminUiAction() || !hasResourceConflict('views', viewManagerSelectedId)) return false;
    if (hasUnappliedViewForm() && !confirm('このビューの未適用入力を破棄して最新データを再読込しますか?')) return false;
    const id = viewManagerSelectedId;
    const generation = viewManagerFormGeneration;
    const inputs = readViewForm();
    if (!await reloadConflictedResource('views', id)) return false;
    renderViewManagerList();
    renderViewSelector();
    if (generation === viewManagerFormGeneration && Number(id) === Number(viewManagerSelectedId) &&
        readViewForm().every((value, index) => value === inputs[index])) loadSelectedViewIntoForm();
    return true;
}





export function validateViews() {
    if (appState.views.length < 1) {
        showToast(
            'ビューを最低1件登録してください',
            'warning'
        );
        return false;
    }

    if (appState.views.length > MAX_VIEWS) {
        showToast(
            `ビューは最大${MAX_VIEWS}件までです`,
            'warning'
        );
        return false;
    }

    const usedNames = new Set();

    for (const view of appState.views) {
        const name =
            normalizeText(view.name).trim();

        if (!name) {
            showToast(
                `ビューID ${view.id}: 名称を入力してください`,
                'warning'
            );
            return false;
        }

        const key =
            name.toLocaleLowerCase('ja');

        if (usedNames.has(key)) {
            showToast(
                `ビュー名「${name}」が重複しています`,
                'warning'
            );
            return false;
        }

        usedNames.add(key);
    }

    return true;
}
