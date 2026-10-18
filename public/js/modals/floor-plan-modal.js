/**
 * Netarium - modals/floor-plan-modal.js
 */

import { appState } from '../core/state.js';
import { eventBus } from '../core/event-bus.js';
import { endLinkMode } from '../core/link-mode.js';
import { mappedResourceId, syncResourceRevision } from '../core/resource-save.js';
import { flushSaveQueue, hasPendingChanges, hasResourceConflict, runResourceMutation, scheduleFloorPlanSave } from '../core/save-queue.js';
import { attachFloorPlanEditor, finishFloorPlanGesture, updateFloorPlanEditor } from '../canvas/floor-plan-editor.js';
import { calculateOriginFit } from '../canvas/origin-fit.js';
import {
    hideCanvasContextToolbar,
    showCanvasContextToolbar
} from '../ui/canvas-context-toolbar.js';
import {
    isCurrentUserAdmin,
    requireAdminUiAction
} from '../ui/access-control.js';
import {
    setBusy
} from '../ui/toolbar.js';
import {
    clampNumber,
    formatFileSize,
    formatStatusTime,
    setInputValue,
    setTextContent
} from '../core/utils.js';
import {
    applyViewTransform
} from '../canvas/pan-zoom.js';
import {
    apiFetch
} from '../core/api-client.js';
import {
    getCurrentFloorPlan,
    getCurrentView,
    normalizeFloorPlan
} from '../core/state.js';
import {
    render
} from '../canvas/renderer.js';
import {
    showToast
} from '../ui/toast.js';
import { setInputError } from '../ui/field-errors.js';
import {
    registerModalClose,
    registerModalOpen,
    syncCanvasViewControlsVisibility
} from '../core/modal-focus.js';
import {
    markConflict,
    markSaved,
    renderStatusBar
} from '../ui/status-bar.js';
import {
    buildViewOptionLabel
} from '../core/view-format.js';
import {
    openViewManager,
    switchView
} from './view-manager-modal.js';
import {
    confirmDataQualityNavigation,
    findDataQualityView,
    hideDataQualityForNavigation
} from './data-quality-modal.js';

// 図面管理を閉じた時だけ、起動元のビュー管理へ戻る。
let floorPlanManagerReturnViewId = null;
let adjustingViewId = null;
let opacityPreview = null;

eventBus.on('resources:ids-remapped', maps => {
    floorPlanManagerReturnViewId = mappedResourceId(maps.views, floorPlanManagerReturnViewId);
    adjustingViewId = mappedResourceId(maps.views, adjustingViewId);
});
eventBus.on('floor-plan:finish', () => finishFloorPlanAdjustMode('replace'));
eventBus.on('auth:expired', () => finishFloorPlanAdjustMode('replace'));
eventBus.on('resources:reloaded', () => {
    floorPlanManagerReturnViewId = null;
    finishFloorPlanAdjustMode('replace');
});
eventBus.on('resource:reloaded', ({ kind, id }) => {
    if (kind !== 'views') return;
    if (Number(id) === floorPlanManagerReturnViewId) floorPlanManagerReturnViewId = null;
    if (Number(id) === adjustingViewId) finishFloorPlanAdjustMode('replace');
});
eventBus.on('floor-plan:saved', ({ viewId }) => {
    if (Number(viewId) === Number(appState.currentViewId)) renderFloorPlanManager();
});
eventBus.on('save-state:changed', () => {
    if (appState.floorPlanAdjustMode && (!canAdjustFloorPlan() || hasResourceConflict('views', adjustingViewId))) {
        finishFloorPlanAdjustMode('replace');
    }
    updateFloorPlanSettingsButtons();
});

function canAdjustFloorPlan() {
    return isCurrentUserAdmin() && !appState.authExpired && !appState.isPinging &&
        !appState.isFloorPlanUpdating && !hasResourceConflict('views', appState.currentViewId);
}

function finishFloorPlanFileSave(data, viewId) {
    syncResourceRevision('views', viewId, data.view_revision);
    appState.dataRevision = Number(data.revision);
    if (hasPendingChanges() || ['unconfirmed', 'conflict'].includes(appState.appStatus.state)) {
        appState.appStatus.lastSavedAt = data.saved_at || new Date();
        renderStatusBar();
    } else markSaved(data.revision, data.saved_at || new Date());
}

export function renderFloorPlan() {
    if (!appState.floorPlanLayer) return;
    if (appState.floorPlanAdjustMode &&
        (Number(appState.currentViewId) !== adjustingViewId || !canAdjustFloorPlan())) {
        finishFloorPlanAdjustMode('replace');
        return;
    }
    appState.floorPlanLayer.setAttribute('aria-hidden', String(!appState.floorPlanAdjustMode));
    const existing = appState.floorPlanLayer.querySelector('.floor-plan-image');
    if (appState.floorPlanAdjustMode && existing?.classList.contains('adjustable') &&
        existing.dataset.viewId === String(adjustingViewId)) {
        updateCurrentFloorPlanElement();
        return;
    }
    // 再描画で失われるcaptureと未確定gestureだけを取り消す。
    finishFloorPlanGesture();
    appState.floorPlanLayer.replaceChildren();
    const view = getCurrentView();
    const plan = getCurrentFloorPlan();
    if (!view || view.view_type !== 'floor' || !plan?.image_url) {
        updateFloorPlanMenuVisibility();
        return;
    }
    const image = document.createElement('img');
    image.className = 'floor-plan-image';
    image.dataset.viewId = String(plan.view_id);
    image.alt = '';
    image.draggable = false;
    image.src = plan.image_url;
    applyFloorPlanElementStyles(image, plan);
    appState.floorPlanLayer.appendChild(image);
    if (appState.floorPlanAdjustMode) {
        image.classList.add('adjustable');
        attachFloorPlanEditor(image, plan, {
            onPreview: plan => applyFloorPlanElementStyles(image, plan),
            onCommit: scheduleFloorPlanSave
        });
    }
    image.addEventListener('load', () => {
        // 古いビューのloadや調整後の画像loadでCanvasを動かさない。
        if (getCurrentFloorPlan() !== plan || appState.floorPlanAdjustMode ||
            appState.floorPlanAutoFittedViews.has(Number(plan.view_id))) return;
        appState.floorPlanAutoFittedViews.add(Number(plan.view_id));
        fitViewToFloorPlan(plan);
    }, { once: true });
    image.addEventListener('error', () => showToast('フロア図面を読み込めませんでした', 'error'), { once: true });
    updateFloorPlanMenuVisibility();
}

export function applyFloorPlanElementStyles(image, plan) {
    if (!image || !plan) return;
    image.style.transform = `translate(${plan.x}px, ${plan.y}px) scale(${plan.scale})`;
    image.hidden = !plan.is_visible && !appState.floorPlanAdjustMode;
    image.style.display = image.hidden ? 'none' : 'block';
    image.style.opacity = String(plan.opacity);
}

export function updateCurrentFloorPlanElement() {
    const plan = getCurrentFloorPlan();
    const image = appState.floorPlanLayer?.querySelector('.floor-plan-image');
    if (!plan || !image) return;
    applyFloorPlanElementStyles(image, plan);
    updateFloorPlanEditor(plan);
}

export function fitViewToFloorPlan(plan) {
    if (!appState.canvas || !plan) return;
    Object.assign(appState.viewState, calculateOriginFit(appState.canvas.getBoundingClientRect(),
        { minX: plan.x, minY: plan.y,
            maxX: plan.x + Math.max(1, plan.image_width * plan.scale),
            maxY: plan.y + Math.max(1, plan.image_height * plan.scale) }, appState.viewState));
    applyViewTransform();
}

export function updateFloorPlanMenuVisibility() {
    const button = document.getElementById('floor-plan-manage-btn');
    if (!button) return;
    button.hidden = !isCurrentUserAdmin() || getCurrentView()?.view_type !== 'floor';
    button.disabled = button.hidden || appState.isFloorPlanUpdating || appState.authExpired;
}

export function openFloorPlanManager({ returnToViewManager = false } = {}) {
    if (!requireAdminUiAction() || appState.authExpired) return;
    const view = getCurrentView();
    if (view?.view_type !== 'floor') {
        showToast('フロア図面は物理・フロア配置図で管理してください', 'warning');
        return;
    }
    const overlay = document.getElementById('floor-plan-manager-overlay');
    if (!overlay) return;
    finishFloorPlanAdjustMode('replace');
    floorPlanManagerReturnViewId = returnToViewManager ? Number(view.id) : null;
    setTextContent('floor-plan-manager-view', buildViewOptionLabel(view));
    setInputValue('floor-plan-file', '');
    setFloorPlanFileError('');
    renderFloorPlanManager();
    overlay.hidden = false;
    registerModalOpen('floor_plan', overlay, getCurrentFloorPlan() ? '#floor-plan-drag-mode-btn' : '#floor-plan-upload-btn', { onClose: closeFloorPlanManager });
}

export function closeFloorPlanManager() {
    if (appState.isFloorPlanUpdating) return;
    const fileInput = document.getElementById('floor-plan-file');
    if ((fileInput?.files?.length || fileInput?.value) &&
        !window.confirm('選択した未アップロードのファイルを破棄して閉じますか？')) return false;
    const overlay = document.getElementById('floor-plan-manager-overlay');
    if (overlay) overlay.hidden = true;
    const returnToViewManager = floorPlanManagerReturnViewId !== null &&
        floorPlanManagerReturnViewId === Number(appState.currentViewId) &&
        Boolean(getCurrentView()) && isCurrentUserAdmin() && !appState.authExpired;
    floorPlanManagerReturnViewId = null;
    registerModalClose('floor_plan', { restoreFocus: !returnToViewManager });
    setInputValue('floor-plan-file', '');
    setFloorPlanFileError('');
    if (returnToViewManager) {
        // ビュー管理を閉じた時も、非表示の図面管理へフォーカスを戻さない。
        document.getElementById('floor-plan-manage-btn')?.focus();
        openViewManager();
    }
}

export function renderFloorPlanManager() {
    const plan = getCurrentFloorPlan();
    for (const id of ['floor-plan-information', 'floor-plan-settings', 'floor-plan-file-management']) {
        const element = document.getElementById(id);
        if (element) element.hidden = !plan;
    }
    const deleteButton = document.getElementById('floor-plan-delete-btn');
    if (deleteButton) deleteButton.hidden = !plan;
    const empty = document.getElementById('floor-plan-empty');
    if (empty) empty.hidden = Boolean(plan);
    const upload = document.getElementById('floor-plan-upload-btn');
    if (upload) {
        upload.textContent = plan ? '差し替え' : '図面を登録';
        upload.classList.toggle('btn-primary', !plan);
        upload.classList.toggle('btn-secondary', Boolean(plan));
    }
    if (plan) {
        setTextContent('floor-plan-file-name', plan.original_name || '-');
        const name = document.getElementById('floor-plan-file-name');
        if (name) name.title = plan.original_name;
        setTextContent('floor-plan-file-type', plan.mime_type === 'image/png' ? 'PNG' : 'JPEG');
        setTextContent('floor-plan-file-size', formatFileSize(plan.file_size));
        setTextContent('floor-plan-dimensions', `${plan.image_width} × ${plan.image_height} px`);
        setTextContent('floor-plan-updated-at', plan.updated_at ? formatStatusTime(plan.updated_at) : '-');
        const thumbnail = document.getElementById('floor-plan-thumbnail');
        const fallback = document.getElementById('floor-plan-thumbnail-fallback');
        if (thumbnail && thumbnail.getAttribute('src') !== plan.image_url) {
            thumbnail.hidden = true;
            if (fallback) fallback.hidden = false;
            thumbnail.onload = () => {
                thumbnail.hidden = false;
                if (fallback) fallback.hidden = true;
            };
            thumbnail.onerror = () => {
                thumbnail.hidden = true;
                if (fallback) fallback.hidden = false;
            };
            thumbnail.setAttribute('src', plan.image_url);
        }
        const visible = document.getElementById('floor-plan-visible');
        if (visible) visible.checked = plan.is_visible;
    }
    updateFloorPlanUploadButton();
    updateFloorPlanSettingsButtons();
}

export function updateFloorPlanSettingsButtons() {
    const disabled = !getCurrentFloorPlan() || !canAdjustFloorPlan();
    for (const id of ['floor-plan-drag-mode-btn', 'floor-plan-visible', 'floor-plan-opacity',
        'floor-plan-reset-btn']) {
        const control = document.getElementById(id);
        if (control) control.disabled = disabled;
    }
    const temporary = document.getElementById('floor-plan-temporary-visible');
    if (temporary) temporary.hidden = !appState.floorPlanAdjustMode || Boolean(getCurrentFloorPlan()?.is_visible);
}

export function toggleFloorPlanAdjustMode() {
    if (appState.floorPlanAdjustMode) return finishFloorPlanAdjustMode();
    if (!requireAdminUiAction() || !getCurrentFloorPlan() || !canAdjustFloorPlan()) return;
    eventBus.emit('canvas-note:finish');
    eventBus.emit('placement-mode:exit');
    endLinkMode();
    eventBus.emit('toolbar:sync-link-mode');
    floorPlanManagerReturnViewId = null;
    const overlay = document.getElementById('floor-plan-manager-overlay');
    if (overlay) overlay.hidden = true;
    registerModalClose('floor_plan', { restoreFocus: false });
    appState.selectedPlacementIds.clear();
    appState.editingLinkId = null;
    adjustingViewId = Number(appState.currentViewId);
    appState.floorPlanAdjustMode = true;
    appState.floorPlanAutoFittedViews.add(adjustingViewId);
    render();
    renderFloorPlan();
    syncFloorPlanAdjustModeUi();
    syncFloorPlanOpacity();
    appState.floorPlanLayer?.querySelector('.floor-plan-image')?.focus();
}

export function syncFloorPlanAdjustModeUi() {
    document.body.classList.toggle('floor-plan-adjusting', appState.floorPlanAdjustMode);
    if (appState.floorPlanAdjustMode) showCanvasContextToolbar('floor-plan', finishFloorPlanAdjustMode);
    else hideCanvasContextToolbar('floor-plan');
    updateFloorPlanSettingsButtons();
}

export function finishFloorPlanAdjustMode(reason = 'finish') {
    if (!appState.floorPlanAdjustMode) return;
    // 終了時はpointer操作を取消し、キー/sliderの確定分はキューに残す。
    finishFloorPlanGesture({ commit: reason === 'finish' });
    commitFloorPlanOpacity();
    appState.floorPlanAdjustMode = false;
    adjustingViewId = null;
    floorPlanManagerReturnViewId = null;
    syncFloorPlanAdjustModeUi();
    renderFloorPlan();
    syncCanvasViewControlsVisibility();
    if (reason === 'finish' || reason === 'escape') document.getElementById('floor-plan-manage-btn')?.focus();
}

function syncFloorPlanOpacity() {
    const plan = getCurrentFloorPlan();
    if (!plan) return;
    const percent = Math.round(plan.opacity * 100);
    setInputValue('floor-plan-opacity', percent);
    setTextContent('floor-plan-opacity-value', `${percent}%`);
}

export function previewFloorPlanOpacity() {
    const plan = getCurrentFloorPlan();
    if (!plan || !canAdjustFloorPlan()) return;
    opacityPreview ||= { plan, opacity: plan.opacity };
    plan.opacity = clampNumber(Number(document.getElementById('floor-plan-opacity')?.value) / 100, 0.1, 1);
    syncFloorPlanOpacity();
    updateCurrentFloorPlanElement();
}

export function commitFloorPlanOpacity() {
    if (!opacityPreview) return;
    const { plan, opacity } = opacityPreview;
    opacityPreview = null;
    if (!isCurrentUserAdmin() || appState.authExpired ||
        !appState.floorPlans.includes(plan) || hasResourceConflict('views', plan.view_id)) {
        plan.opacity = opacity;
        updateCurrentFloorPlanElement();
        return;
    }
    if (plan.opacity !== opacity) scheduleFloorPlanSave(plan);
}

export function toggleFloorPlanVisibility() {
    const plan = getCurrentFloorPlan();
    if (!plan || !canAdjustFloorPlan() || !requireAdminUiAction()) return;
    plan.is_visible = Boolean(document.getElementById('floor-plan-visible')?.checked);
    updateCurrentFloorPlanElement();
    scheduleFloorPlanSave(plan);
}

export function resetCurrentFloorPlanSettings() {
    if (!getCurrentFloorPlan() || !canAdjustFloorPlan() || !requireAdminUiAction()) return;
    if (!confirm('図面の位置を原点（0, 0）、サイズを100%へ戻しますか？\n不透明度と表示/非表示は変更しません。')) return;
    finishFloorPlanGesture();
    const plan = getCurrentFloorPlan();
    plan.x = 0;
    plan.y = 0;
    plan.scale = 1;
    updateCurrentFloorPlanElement();
    scheduleFloorPlanSave(plan);
}

export function chooseFloorPlanFile() {
    if (!requireAdminUiAction() || appState.authExpired || appState.isFloorPlanUpdating) return;
    const input = document.getElementById('floor-plan-file');
    if (!input) return;
    input.value = '';
    setFloorPlanFileError('');
    input.click();
}

async function prepareFloorPlanFileMutation(view) {
    await flushSaveQueue({ silent: true });
    if (appState.authExpired || hasResourceConflict('views', view.id) || hasPendingChanges()) {
        showToast('保留中の保存を確認・再試行し、競合対象は再読込してから図面ファイルを変更してください', 'warning');
        return false;
    }
    return Number(getCurrentView()?.id) === Number(view.id);
}



function setFloorPlanFileError(message) {
    const input = document.getElementById('floor-plan-file');
    if (!input) return;
    let error = document.getElementById('floor-plan-file-error');
    if (!error) {
        error = document.createElement('div');
        error.id = 'floor-plan-file-error';
        error.className = 'form-error';
        error.hidden = true;
        error.setAttribute('aria-live', 'polite');
        input.insertAdjacentElement('afterend', error);
        input.addEventListener('change', () => setFloorPlanFileError(''));
    }
    setInputError(input, error, message);
    if (message) document.getElementById('floor-plan-upload-btn')?.focus();
}

export function updateFloorPlanUploadButton() {

    const uploadButton =
        document.getElementById(
            'floor-plan-upload-btn'
        );

    const deleteButton =
        document.getElementById(
            'floor-plan-delete-btn'
        );

    if (uploadButton) {
        uploadButton.disabled =
            appState.isFloorPlanUpdating || appState.authExpired || !isCurrentUserAdmin() ||
            hasResourceConflict('views', appState.currentViewId);
    }

    if (deleteButton) {
        deleteButton.disabled =
            appState.isFloorPlanUpdating || appState.authExpired || !isCurrentUserAdmin() ||
            hasResourceConflict('views', appState.currentViewId);
    }
}

// デコードせずヘッダー寸法を検査する。画像の真正性・向き補正はサーバー側で検査する。
async function validateFloorPlanDimensions(file) {
    const invalid = () => new Error('画像を読み込めません。PNGまたはJPEG画像を選択してください');
    const headerWindowSize = 64 * 1024;
    let windowStart = 0;
    let headerWindow = new Uint8Array(0);
    const readBytes = async (start, length) => {
        const end = Math.min(file.size, start + length);
        if (start < windowStart || end > windowStart + headerWindow.length) {
            windowStart = start;
            headerWindow = new Uint8Array(await file.slice(start, start + Math.max(headerWindowSize, length)).arrayBuffer());
        }
        return headerWindow.subarray(start - windowStart, end - windowStart);
    };
    const header = await readBytes(0, 24);
    let width, height;
    if (header.length >= 24 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => header[i] === byte)
        && header[12] === 73 && header[13] === 72 && header[14] === 68 && header[15] === 82) {
        const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
        width = view.getUint32(16);
        height = view.getUint32(20);
    } else if (header[0] === 255 && header[1] === 216) {
        let offset = 2;
        while (offset < file.size) {
            let marker = await readBytes(offset, 2);
            if (marker.length < 2 || marker[0] !== 255) throw invalid();
            while (marker[1] === 255) {
                // 同じ読込窓内のfill bytesは同期走査し、Blob読込・Promiseを1byteごとに発生させない。
                do {
                    offset++;
                } while (offset + 1 < windowStart + headerWindow.length
                    && headerWindow[offset + 1 - windowStart] === 255);
                marker = await readBytes(offset, 2);
                if (marker.length < 2) throw invalid();
            }
            offset += 2;
            if (marker[1] === 217 || marker[1] === 218 || marker[1] === 0) throw invalid();
            if (marker[1] === 1 || (marker[1] >= 208 && marker[1] <= 215)) continue;
            const bytes = await readBytes(offset, 7);
            if (bytes.length < 2) throw invalid();
            const length = (bytes[0] << 8) | bytes[1];
            if (length < 2 || offset + length > file.size) throw invalid();
            if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker[1])) {
                if (length < 8 || bytes.length < 7) throw invalid();
                height = (bytes[3] << 8) | bytes[4];
                width = (bytes[5] << 8) | bytes[6];
                break;
            }
            offset += length;
        }
    }
    if (!width || !height) throw invalid();
    const maxDimension = Math.max(1, Number(window.APP_CONFIG?.capacity?.floorPlanMaxDimension ?? 7000));
    const maxPixels = Math.max(1, Number(window.APP_CONFIG?.capacity?.floorPlanMaxPixels ?? 35000000));
    if (Math.max(width, height) > maxDimension || width * height > maxPixels) {
        throw new Error(`図面の入力は各辺${maxDimension}px・${maxPixels.toLocaleString()}画素以下にしてください（選択画像: ${width} × ${height} px）`);
    }
}


export async function uploadCurrentFloorPlan() {
    if (!requireAdminUiAction() || appState.authExpired) {
        return;
    }

    if (appState.isFloorPlanUpdating) {
        return;
    }

    const currentView =
        getCurrentView();

    const fileInput =
        document.getElementById(
            'floor-plan-file'
        );

    const file =
        fileInput?.files?.[0];
    setFloorPlanFileError('');

    if (
        !currentView ||
        currentView.view_type !==
            'floor'
    ) {
        showToast(
            'フロアビューを選択してください',
            'warning'
        );

        return;
    }

    if (!file) return;

    const allowedTypes = [
        'image/png',
        'image/jpeg'
    ];

    if (
        file.type &&
        !allowedTypes.includes(
            file.type
        )
    ) {
        setFloorPlanFileError('PNGまたはJPEG画像を選択してください');

        return;
    }

    const maxBytes =
        Number(
            window.APP_CONFIG?.capacity?.floorPlanMaxBytes
        ) || 30 * 1024 * 1024;

    if (
        file.size <= 0 ||
        file.size > maxBytes
    ) {
        setFloorPlanFileError(`図面ファイルは${Math.floor(maxBytes / (1024 * 1024))}MiB以下にしてください`);
        return;
    }
    appState.isFloorPlanUpdating = true;
    updateFloorPlanUploadButton();
    try {
        await validateFloorPlanDimensions(file);
    } catch (error) {
        setFloorPlanFileError(error.message);
        fileInput.value = '';
        return;
    } finally {
        appState.isFloorPlanUpdating = false;
        updateFloorPlanUploadButton();
    }
    if (Number(getCurrentView()?.id) !== Number(currentView.id)) return;

    const replacing =
        Boolean(
            getCurrentFloorPlan()
        );

    if (
        replacing &&
        !confirm(
            `「${getCurrentFloorPlan()?.original_name}」を「${file.name}」へ差し替えますか？\n` +
            '座標・倍率・不透明度・表示状態は引き継ぎます。保存寸法が変わる場合は「図面を調整」で位置・サイズを確認してください。原本は保存しません。'
        )
    ) {
        fileInput.value = '';
        return;
    }
    const formData =
        new FormData();

    formData.append(
        'view_id',
        String(currentView.id)
    );

    formData.append(
        'floor_plan',
        file
    );

    try {
        appState.isFloorPlanUpdating = true;
        setBusy(
            true,
            replacing
                ? '図面差し替え中...'
                : '図面登録中...'
        );

        updateFloorPlanUploadButton();

        if (!await prepareFloorPlanFileMutation(currentView)) return;

        const data = await runResourceMutation(async () => {
            const revision = appState.views.find(row => Number(row.id) === Number(currentView.id))?.resource_revision;
            formData.set('expected_revision', String(revision));
            const result = await apiFetch('upload_floor_plan', { method: 'POST', body: formData });
            finishFloorPlanFileSave(result, currentView.id);
            return result;
        });

        const floorPlan =
            normalizeFloorPlan(
                data.floor_plan
            );

        appState.floorPlans =
            appState.floorPlans.filter(
                item =>
                    Number(item.view_id) !==
                    Number(
                        floorPlan.view_id
                    )
            );

        appState.floorPlans.push(
            floorPlan
        );

        if (!replacing) appState.floorPlanAutoFittedViews.delete(Number(currentView.id));


        if (fileInput) {
            fileInput.value = '';
        }

        render();
        renderFloorPlanManager();

        const capacityWarnings =
            Array.isArray(data.capacity?.warnings)
                ? data.capacity.warnings
                : [];

        if (capacityWarnings.length > 0) {
            showToast(capacityWarnings.join('、'), 'warning');
        }

    } catch (err) {
        console.error(err);

        if (err.status === 409) {
            markConflict(
                err.message
            );
        }

        if (err.status === 401) return;
        showToast(
            `図面登録エラー: ${
                err.message
            }`,
            'error'
        );

    } finally {
        appState.isFloorPlanUpdating = false;
        setBusy(false);
        if (fileInput) fileInput.value = '';
        updateFloorPlanSettingsButtons();
        updateFloorPlanUploadButton();
        updateFloorPlanMenuVisibility();
    }
}


export async function deleteCurrentFloorPlan() {
    if (!requireAdminUiAction() || appState.authExpired) {
        return;
    }

    if (appState.isFloorPlanUpdating) {
        return;
    }

    const currentView =
        getCurrentView();

    const floorPlan =
        getCurrentFloorPlan();

    if (!currentView || !floorPlan) {
        showToast(
            '削除するフロア図面がありません',
            'warning'
        );

        return;
    }

    if (
        !confirm(
            `「${floorPlan.original_name}」をこのビューから削除しますか？\n\n` +
            '機器、配置、接続は削除されません。\n' +
            'この操作は直ちに反映されます。'
        )
    ) {
        return;
    }

    try {
        appState.isFloorPlanUpdating = true;
        setBusy(
            true,
            '図面削除中...'
        );

        updateFloorPlanUploadButton();

        if (!await prepareFloorPlanFileMutation(currentView)) return;

        const data = await runResourceMutation(async () => {
            const result = await apiFetch('delete_floor_plan', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ view_id: Number(currentView.id),
                    expected_revision: appState.views.find(row => Number(row.id) === Number(currentView.id))?.resource_revision })
            });
            finishFloorPlanFileSave(result, currentView.id);
            return result;
        });

        appState.floorPlans =
            appState.floorPlans.filter(
                item =>
                    Number(item.view_id) !==
                    Number(
                        currentView.id
                    )
            );


        appState.floorPlanAutoFittedViews.delete(
            Number(currentView.id)
        );


        render();
        renderFloorPlanManager();


    } catch (err) {
        console.error(err);

        if (err.status === 409) {
            markConflict(
                err.message
            );
        }

        if (err.status === 401) return;
        showToast(
            `図面削除エラー: ${
                err.message
            }`,
            'error'
        );

    } finally {
        appState.isFloorPlanUpdating = false;
        setBusy(false);
        updateFloorPlanUploadButton();
        updateFloorPlanMenuVisibility();
    }
}



export async function openDataQualityFloorPlan(
    viewId
) {
    if (appState.appStatus?.dirty) {
        showToast(
            '保存待ちの変更があります。保存完了を待ち、保存失敗時は「保存」で再試行してください',
            'warning'
        );

        return;
    }
    if (
        !confirmDataQualityNavigation()
    ) {
        return;
    }
    if (!isCurrentUserAdmin()) {
        showToast(
            'フロア図面を管理する権限がありません',
            'warning'
        );

        return;
    }

    const view =
        findDataQualityView(
            viewId
        );

    if (!view) {
        showToast(
            '対象ビューが現在の画面データに見つかりません',
            'warning'
        );

        return;
    }

    if (
        String(view.view_type) !==
            'floor'
    ) {
        showToast(
            '対象はフロアビューではありません',
            'warning'
        );

        return;
    }

    if (
        Number(appState.currentViewId) !==
            Number(view.id)
    ) {
        if (!await switchView(
            Number(view.id)
        )) {
            return;
        }
    }
    hideDataQualityForNavigation();

    window.requestAnimationFrame(
        () => {
            openFloorPlanManager();
        }
    );
}

