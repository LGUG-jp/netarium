/**
 * Netarium - modals/view-manager-modal.js
 */

import {
    MAX_VIEWS
} from '../core/constants.js';

import { appState } from '../core/state.js';
import { eventBus } from '../core/event-bus.js';
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
    normalizeLink,
    toSaveLink,
    toSavePlacement,
    toSaveView
} from '../core/state.js';
import { toSaveCanvasNote } from '../core/canvas-note-data.js';
import {
    restoreCurrentViewState,
    saveCurrentViewState
} from '../canvas/pan-zoom.js';
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
    hasResourceChanges, isSaveInFlight
} from '../core/save-queue.js';
import {
    registerModalClose,
    registerModalOpen
} from '../core/modal-focus.js';
import { openFloorPlanManager } from './floor-plan-modal.js';
import { syncViewCombobox } from '../ui/view-combobox.js';

let viewManagerSelectedId = null;
let viewManagerSnapshot = null;
let viewManagerFormGeneration = 0;
let viewManagerApplyGeneration = 0;
const viewFormIds = ['vm-name', 'vm-facility', 'vm-floor', 'vm-type', 'vm-sort-order', 'vm-memo'];

function readViewForm() {
    return viewFormIds.map(id => String(document.getElementById(id)?.value ?? ''));
}

function hasUnappliedViewForm() {
    const view = getViewManagerSelectedView();
    if (!view) return false;
    const values = [view.name, view.facility, view.floor, view.view_type, view.sort_order, view.memo]
        .map(value => String(value ?? ''));
    return readViewForm().some((value, index) => value !== values[index]);
}

export function updateViewManagerFormState() {
    appState.viewManagerFormDirty = hasUnappliedViewForm();
    updateViewManagerButtons();
}

async function resolveUnappliedViewForm() {
    if (!hasUnappliedViewForm()) return true;
    const choice = await chooseUnsavedChanges('未適用のビュー入力があります。どうしますか？');
    if (choice === 'save') {
        const generation = viewManagerFormGeneration;
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
        viewManagerSnapshot.links.forEach(row => {
            row.id = mappedResourceId(maps.links, row.id);
            row.view_id = mappedResourceId(maps.views, row.view_id);
            row.from_id = mappedResourceId(maps.devices, row.from_id);
            row.to_id = mappedResourceId(maps.devices, row.to_id);
        });
        viewManagerSnapshot.canvasNotes.forEach(note => {
            note.id = mappedResourceId(maps.canvas_notes, note.id);
            note.view_id = mappedResourceId(maps.views, note.view_id);
        });
        viewManagerSnapshot.currentViewId = mappedResourceId(maps.views, viewManagerSnapshot.currentViewId);
    }
    renderViewManagerList();
});

eventBus.on('resources:saved', () => {
    if (viewManagerSnapshot) viewManagerSnapshot = createViewManagerSnapshot();
});

eventBus.on('save-state:changed', updateViewManagerButtons);

eventBus.on('resources:reloaded', () => {
    // 全再読込は既に確認済み。古いDOMを新モデルと比較して再確認しない。
    viewManagerFormGeneration++;
    viewManagerApplyGeneration++;
    appState.viewManagerFormDirty = false;
    viewManagerSnapshot = null;
    viewManagerSelectedId = null;
    setInputValue('vm-id', '');
    const overlay = document.getElementById('view-manager-overlay');
    if (overlay && !overlay.hidden) {
        overlay.hidden = true;
        registerModalClose('view_manager');
    }
});

/**
 * ビュー管理
 */
export function openViewManager() {
    if (!requireAdminUiAction()) {
        return;
    }
    const overlay =
        document.getElementById(
            'view-manager-overlay'
        );

    if (!overlay) {
        showToast(
            'ビュー管理画面が見つかりません',
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

    renderViewManagerList();
    loadSelectedViewIntoForm();
    registerModalOpen('view_manager', overlay, '#view-manager-search', { onClose: () => closeViewManager() });
}



export function renderViewSelector() {
    syncViewCombobox();
}


export { buildViewOptionLabel };




export function switchView(nextViewId) {
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

    if (
        Number(appState.currentViewId) ===
        normalizedId
    ) {
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
            finishSwitchView(normalizedId);
            return true;
        })();
    }

    closePanel();
    closeLinkPanel();
    finishSwitchView(normalizedId);
    return true;
}

function finishSwitchView(normalizedId) {
    eventBus.emit('canvas-note:finish');
    eventBus.emit('floor-plan:finish');
    flushSaveQueue({ silent: true });

    if (
        appState.isRangeSelecting
    ) {
        appState.cancelActiveRangeSelection?.();
    }
    saveCurrentViewState();

    appState.currentViewId = normalizedId;

    appState.selectedPlacementIds.clear();
    appState.selectedCanvasNoteId = null;
    appState.noteMode = false;
    endLinkMode();

    syncLinkModeButton();

    restoreCurrentViewState();
    renderViewSelector();
    render();

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

        links: appState.links.map(link => ({
            ...link
        })),

        canvasNotes: appState.canvasNotes.map(note => ({ ...note })),

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
        links: appState.links.map(toSaveLink),
        canvas_notes: appState.canvasNotes.map(toSaveCanvasNote)
    });

    const snapshot = JSON.stringify({
        views:
            viewManagerSnapshot.views
                .map(toSaveView),

        placements:
            viewManagerSnapshot
                .placements
                .map(toSavePlacement),

        links:
            viewManagerSnapshot.links
                .map(toSaveLink),
        canvas_notes: viewManagerSnapshot.canvasNotes.map(toSaveCanvasNote)
    });

    return current !== snapshot;
}


export function renderViewManagerList() {
    const list =
        document.getElementById(
            'view-manager-list'
        );

    if (!list) {
        return;
    }

    const search =
        normalizeText(
            document.getElementById(
                'view-manager-search'
            )?.value
        )
            .trim()
            .toLocaleLowerCase('ja');

    const sortedViews = [...appState.views]
        .sort((a, b) => {
            const orderDifference =
                Number(a.sort_order) -
                Number(b.sort_order);

            return orderDifference !== 0
                ? orderDifference
                : Number(a.id) -
                    Number(b.id);
        })
        .filter(view => {
            if (!search) {
                return true;
            }

            const text = [
                view.name,
                view.facility,
                view.floor,
                view.view_type,
                view.memo
            ]
                .map(normalizeText)
                .join(' ')
                .toLocaleLowerCase('ja');

            return text.includes(search);
        });

    list.replaceChildren();

    sortedViews.forEach(view => {
        const button =
            document.createElement('button');

        button.type = 'button';
        button.className =
            'view-manager-list-item';

        button.dataset.viewId =
            String(view.id);

        button.setAttribute(
            'role',
            'option'
        );

        const selected =
            Number(view.id) ===
            Number(viewManagerSelectedId);

        button.classList.toggle(
            'selected',
            selected
        );

        button.setAttribute(
            'aria-selected',
            selected ? 'true' : 'false'
        );

        const typeLabel =
            view.view_type === 'floor'
                ? '物理'
                : '論理';

        const subText = [
            view.facility,
            view.floor,
            typeLabel
        ]
            .map(normalizeText)
            .filter(Boolean)
            .join(' / ');

        const name =
            document.createElement('strong');

        name.textContent =
            view.name ||
            `ビューID ${view.id}`;

        const detail =
            document.createElement('span');

        detail.textContent =
            subText ||
            `表示順 ${view.sort_order}`;

        button.appendChild(name);
        button.appendChild(detail);

        button.addEventListener(
            'click',
            async () => {
                let nextViewId = Number(button.dataset.viewId);
                if (Number(viewManagerSelectedId) === nextViewId) return;
                const generation = viewManagerFormGeneration;
                if (!await resolveUnappliedViewForm() || generation !== viewManagerFormGeneration) return;
                nextViewId = Number(view.id);
                if (!appState.views.some(item => Number(item.id) === nextViewId)) return;

                viewManagerSelectedId =
                    nextViewId;

                renderViewManagerList();
                loadSelectedViewIntoForm();
            }
        );



        list.appendChild(button);
    });

    const count =
        document.getElementById(
            'view-manager-count'
        );

    if (count) {
        count.textContent =
            `${appState.views.length} / ${MAX_VIEWS}件`;
    }

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
    for (const id of ['vm-name', 'vm-facility', 'vm-floor', 'vm-sort-order', 'vm-memo']) {
        setInputError(document.getElementById(id), document.getElementById(`${id}-error`), '');
    }
    const disabled = !view;

    form
        .querySelectorAll(
            'input, select, textarea, button'
        )
        .forEach(element => {
            element.disabled = disabled;
        });

    if (!view) {
        setInputValue('vm-id', '');
        setInputValue('vm-name', '');
        setInputValue('vm-facility', '');
        setInputValue('vm-floor', '');
        setInputValue('vm-type', 'topology');
        setInputValue('vm-sort-order', '0');
        setInputValue('vm-memo', '');
        
        appState.viewManagerFormDirty = false;
        return;
    }

    setInputValue('vm-id', view.id);
    setInputValue('vm-name', view.name);
    setInputValue(
        'vm-facility',
        view.facility
    );
    setInputValue('vm-floor', view.floor);
    setInputValue(
        'vm-type',
        view.view_type
    );
    setInputValue(
        'vm-sort-order',
        view.sort_order
    );
    setInputValue('vm-memo', view.memo);
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
    const [rawName, rawFacility, rawFloor, rawType, rawOrder, rawMemo] = submittedInputs;
    const values = {
        name: rawName.trim(),
        facility: rawFacility.trim(),
        floor: rawFloor.trim(),
        view_type: rawType === 'floor' ? 'floor' : 'topology',
        sort_order: Number(rawOrder),
        memo: rawMemo.trim()
    };
    for (const id of ['vm-name', 'vm-facility', 'vm-floor', 'vm-sort-order', 'vm-memo']) {
        setInputError(document.getElementById(id), document.getElementById(`${id}-error`), '');
    }
    const limits = [['name', 100, 'ビュー名', 'vm-name'], ['facility', 100, '施設名', 'vm-facility'],
        ['floor', 50, 'フロア', 'vm-floor'], ['memo', 1000, '備考', 'vm-memo']];
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

    const changed = JSON.stringify(toSaveView(view)) !== JSON.stringify(toSaveView({ ...view, ...values }));
    Object.assign(view, values);
    // 確定済みモデルと未適用DOM入力を分ける。通信中の入力は以後触らない。
    Object.values(values).forEach((value, index) => setInputValue(viewFormIds[index], value));
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


    return true;
}


export async function addView() {
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
    if (!await resolveUnappliedViewForm() || generation !== viewManagerFormGeneration) return;

    const id = allocateLocalId('views');

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
            '新しいビュー'
        ),
        facility: '',
        floor: '',
        view_type: 'topology',
        sort_order: sortOrder,
        memo: ''
    };

    appState.views.push(view);

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

    const newViewId = allocateLocalId('views');

    const duplicatedView = {
        ...toSaveView(source),
        id: newViewId,
        name: createUniqueViewName(source.name, ' のコピー'),
        sort_order:
            Number(source.sort_order) + 1
    };

    appState.views.push(duplicatedView);

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

    appState.links
        .filter(link =>
            Number(link.view_id) ===
            Number(source.id)
        )
        .forEach(link => {
            appState.links.push(normalizeLink({
                ...link,
                id: allocateLocalId('links'),
                view_id: newViewId
            }));
        });

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
    const generation = viewManagerFormGeneration;
    if (!await resolveUnappliedViewForm() || generation !== viewManagerFormGeneration) return;
    const view =
        getViewManagerSelectedView();

    if (!view) {
        showToast(
            '削除するビューを選択してください',
            'warning'
        );
        return;
    }

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

    const linkCount =
        appState.links.filter(
            link =>
                Number(link.view_id) ===
                Number(view.id)
        ).length;

    const noteCount = appState.canvasNotes.filter(note => Number(note.view_id) === Number(view.id)).length;

    const confirmed = confirm(
        `ビュー「${view.name}」を削除しますか?\n\n` +
        `配置: ${placementCount}件\n` +
        `接続: ${linkCount}件\n` +
        `メモ: ${noteCount}件\n\n` +
        '機器台帳自体は削除されません。'
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

    appState.placements = appState.placements.filter(
        placement =>
            Number(placement.view_id) !==
            deletedViewId
    );

    appState.links = appState.links.filter(
        link =>
            Number(link.view_id) !==
            deletedViewId
    );

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

    if (addButton) {
        addButton.disabled =
            appState.views.length >= MAX_VIEWS;
    }

    if (duplicateButton) {
        duplicateButton.disabled =
            !selected ||
            appState.views.length >= MAX_VIEWS;
    }

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
    const floorPlanButton = document.getElementById('vm-floor-plan-btn');
    const floorPlanHelp = document.getElementById('vm-floor-plan-help');
    const floorPlanBlockReason = getSelectedViewFloorPlanBlockReason();
    if (floorPlanButton) floorPlanButton.disabled = Boolean(floorPlanBlockReason);
    if (floorPlanHelp) floorPlanHelp.textContent = floorPlanBlockReason ||
        'このビューの図面を登録・変更できます。';
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
