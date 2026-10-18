/**
 * Netarium - ui/toolbar.js
 */

import {
    API_URL,
    DEFAULT_DEVICE_HEIGHT,
    DEFAULT_DEVICE_WIDTH,
    DEVICE_TYPES
} from '../core/constants.js';

import { appState } from '../core/state.js';
import {
    resetResourceBaseline
} from '../core/resource-save.js';
import {
    clearPendingSave,
    confirmPendingSave,
    flushSaveQueue,
    getPendingSave,
    isSaveInFlight,
    hasPendingChanges,
    hasResourceConflict,
    saveDeviceProperties,
    scheduleSave,
    updateSaveButtonState
} from '../core/save-queue.js';
import { eventBus } from '../core/event-bus.js';
import { hasAnyDeviceDraftChanges } from '../core/device-drafts.js';
import {
    getCurrentPlacements,
    getDeviceForPlacement,
    isValidLinkObject,
    normalizeDevice,
    normalizeFloorPlan,
    normalizeLink,
    normalizePlacement,
    normalizeStatus,
    normalizeView,
    recalculateNextIds,
    allocateLocalId,
    toNullableNumber,
    toSaveDevice,
    toSaveLink,
    toSavePlacement,
    toSaveView
} from '../core/state.js';
import { normalizeCanvasNote, toSaveCanvasNote } from '../core/canvas-note-data.js';
import {
    restoreCurrentViewState,
    screenToWorld
} from '../canvas/pan-zoom.js';
import {
    apiFetch,
    getDownloadFilename,
    handleAuthExpired
} from '../core/api-client.js';
import {
    render
} from '../canvas/renderer.js';
import {
    clampPosition
} from '../canvas/drag-drop.js';
import {
    closeLinkPanel,
    closePanel,
    openPanel,
    hasUnappliedPanelChanges,
    hasUnappliedLinkPanelChanges
} from './property-panel.js';
import {
    showToast,
    showStatusMessage
} from './toast.js';
import {
    markDirty,
    renderStatusBar
} from './status-bar.js';
import {
    closeToolbarMenu,
    syncLinkModeButton
} from './toolbar-controls.js';
import { endLinkMode, resetLinkCreationState } from '../core/link-mode.js';
import { closeWorkspaceNavigation } from './workspace-navigation.js';
import { finishCanvasContextToolbar } from './canvas-context-toolbar.js';
import {
    isCurrentUserAdmin,
    requireAdminUiAction
} from './access-control.js';

export function applyRoleBasedUi() {
    const isAdmin =
        isCurrentUserAdmin();

    document
        .querySelectorAll(
            '.admin-only'
        )
        .forEach(element => {
            element.hidden = !isAdmin;
            element.disabled = !isAdmin;
        });

    updateSaveButtonState();
    eventBus.emit('ledger:selection-changed');

    eventBus.emit(
        'floor-plan:update-menu-visibility'
    );
}


/**
 * ズーム・パン用関数
 */


/**
 * データ読み込み
 */
export async function loadData() {
    try {
        if (
            appState.isRangeSelecting
        ) {
            appState.cancelActiveRangeSelection?.();
        }

        setBusy(true, '読み込み中...');

        const data = await apiFetch('load');

        appState.dataRevision =
            Number.isInteger(
                Number(data.revision)
            )
                ? Number(data.revision)
                : 0;

        appState.monitorRevision =
            Number.isInteger(
                Number(data.monitor_revision)
            )
                ? Number(data.monitor_revision)
                : 0;

        appState.appStatus.lastMonitoredAt =
            data.last_monitored_at || null;

        appState.views = Array.isArray(data.views)
            ? data.views.map(normalizeView)
            : [];

        appState.devices = Array.isArray(data.devices)
            ? data.devices.map(normalizeDevice)
            : [];

        appState.placements =
            Array.isArray(data.placements)
                ? data.placements.map(
                    normalizePlacement
                )
                : [];

        appState.linkSystems = Array.isArray(data.link_systems) ? data.link_systems : [];

        appState.links = Array.isArray(data.links)
            ? data.links
                .map(normalizeLink)
                .filter(isValidLinkObject)
            : [];

        appState.canvasNotes = Array.isArray(data.canvas_notes)
            ? data.canvas_notes.map(normalizeCanvasNote)
            : [];

        appState.floorPlans =
            Array.isArray(data.floor_plans)
                ? data.floor_plans
                    .map(normalizeFloorPlan)
                    .filter(floorPlan =>
                        Number.isInteger(
                            floorPlan.view_id
                        ) &&
                        floorPlan.view_id > 0
                    )
                : [];

        appState.deviceImages =
            Array.isArray(data.device_images)
                ? data.device_images
                : [];
        resetResourceBaseline(appState);
        clearPendingSave();
        eventBus.emit('resources:reloaded');

        appState.floorPlanAutoFittedViews.clear();

        appState.views.sort((a, b) => {
            const orderDifference =
                Number(a.sort_order) -
                Number(b.sort_order);

            return orderDifference !== 0
                ? orderDifference
                : Number(a.id) - Number(b.id);
        });

        const currentViewExists = appState.views.some(
            view =>
                Number(view.id) ===
                Number(appState.currentViewId)
        );

        if (!currentViewExists) {
            appState.currentViewId = appState.views.length > 0
                ? Number(appState.views[0].id)
                : null;
        }

        appState.selectedPlacementIds.clear();
        appState.selectedCanvasNoteId = null;
        appState.editingDeviceId = null;
        appState.editingLinkId = null;
        endLinkMode();
        appState.noteMode = false;

        await closePanel();
        await closeLinkPanel();

        recalculateNextIds();
        eventBus.emit('view:render-selector');
        restoreCurrentViewState();
        render();

        appState.appStatus.dirty = false;
        appState.appStatus.state = 'saved';
        appState.appStatus.lastError = null;
        appState.appStatus.lastSavedAt =
            data.saved_at || null;

        renderStatusBar();

        /*
        * 検索条件が残っている場合は、
        * 再読み込み後の最新機器データで
        * 検索結果を再作成する。
        */
        const deviceSearchInput =
            document.getElementById(
                'device-search-input'
            );

        if (
            deviceSearchInput &&
            deviceSearchInput.value.trim() !== ''
        ) {
            eventBus.emit(
                'device-search:render-results'
            );
        }



    } catch (err) {
        console.error(err);

        if (err.status === 401) return;
        showToast(
            `読み込みエラー: ${err.message}`,
            'error'
        );

    } finally {
        setBusy(false);
    }
}


/**
 * データ保存
 */

/**
 * データ保存
 */
export {
    clearPendingSave,
    confirmPendingSave,
    flushSaveQueue,
    getPendingSave,
    hasPendingChanges,
    saveDeviceProperties,
    scheduleSave,
    updateSaveButtonState
};

export async function saveData() {
    if (!requireAdminUiAction()) {
        return false;
    }
    if (appState.authExpired) {
        return false;
    }

    if (getPendingSave() !== null && !getPendingSave().maintenanceRejected && !isSaveInFlight()) {
        showToast('確定状況が未確認の保存があります。「保存状態を確認」を実行してください', 'warning');
        return false;
    }

    // 上部保存は確定済みの変更だけを送る。未適用の詳細入力は各画面で確定する。
    return await flushSaveQueue({ silent: false });
}




export async function exportBackupZip() {
    if (!isCurrentUserAdmin()) {
        showToast(
            'この操作を実行する権限がありません',
            'warning'
        );
        return;
    }

    if (appState.isBackupExporting) {
        return;
    }

    if (appState.isSaving) {
        showToast(
            '保存処理中です。完了後に実行してください',
            'warning'
        );
        return;
    }

    if (appState.isPinging) {
        showToast(
            'Ping実行中です。完了後に実行してください',
            'warning'
        );
        return;
    }

    const csrfToken =
        window.APP_CONFIG?.csrfToken || '';

    if (!csrfToken) {
        showToast(
            'CSRFトークンを取得できません。画面を再読み込みしてください',
            'error'
        );
        return;
    }

    const button =
        document.getElementById(
            'backup-export-btn'
        );

    try {
        appState.isBackupExporting = true;

        if (button) {
            button.disabled = true;
        }

        setBusy(
            true,
            'バックアップ作成中...'
        );

        const response = await fetch(
            `${API_URL}?action=export_backup_zip`,
            {
                method: 'POST',
                headers: {
                    'Content-Type':
                        'application/json',
                    'X-CSRF-Token':
                        csrfToken
                },
                body: '{}',
                credentials: 'same-origin'
            }
        );

        const contentType = String(
            response.headers.get(
                'Content-Type'
            ) || ''
        ).toLowerCase();

        if (response.status === 401) {
            handleAuthExpired();
            return;
        }

        if (
            !response.ok ||
            contentType.includes(
                'application/json'
            )
        ) {
            let message =
                `構成情報の出力に失敗しました（HTTP ${response.status}）`;

            try {
                const data =
                    await response.json();

                message =
                    data.detail ||
                    data.error ||
                    message;
            } catch (err) {
                console.warn(
                    'エラー応答を解析できません',
                    err
                );
            }

            throw new Error(message);
        }

        const blob =
            await response.blob();

        if (blob.size <= 0) {
            throw new Error(
                'バックアップファイルが空です'
            );
        }

        const fallback =
            'netarium-config.zip';

        const filename =
            getDownloadFilename(
                response.headers.get(
                    'Content-Disposition'
                ),
                fallback
            );

        const objectUrl =
            URL.createObjectURL(blob);

        try {
            const link =
                document.createElement('a');

            link.href = objectUrl;
            link.download = filename;
            link.hidden = true;

            document.body.appendChild(link);
            link.click();
            link.remove();
        } finally {
            window.setTimeout(
                () => {
                    URL.revokeObjectURL(
                        objectUrl
                    );
                },
                1000
            );
        }

        closeToolbarMenu();

        const capacityWarning =
            response.headers.get(
                'X-Netarium-Capacity-Warning'
            ) === '1';

        if (capacityWarning) {
            showToast('構成情報を出力しました。容量上限に近いため、空き容量と復元条件を確認してください', 'warning');
        } else {
            showStatusMessage('構成情報を出力しました');
        }
    } catch (err) {
        console.error(err);

        showToast(
            err.message ||
            '構成情報の出力に失敗しました',
            'error'
        );
    } finally {
        appState.isBackupExporting = false;

        if (button) {
            button.disabled = false;
        }

        setBusy(false);
    }
}


/**
 * 選択機器Ping
 */

/**
 * 選択機器Ping
 */
export async function pingSelected() {

    if (appState.appStatus.dirty) {
        showToast(
            '保存待ちの変更があります。保存完了を待ち、保存失敗時は「保存」で再試行してください',
            'warning'
        );
        return;
    }

    const selectedDeviceIdsForPing =
        new Set(
            getCurrentPlacements()
                .filter(placement =>
                    appState.selectedPlacementIds.has(
                        Number(placement.id)
                    )
                )
                .map(placement =>
                    Number(
                        placement.device_id
                    )
                )
        );

    const targets = appState.devices
        .filter(device =>
            selectedDeviceIdsForPing.has(
                Number(device.id)
            )
        )
        .filter(device =>
            String(device.ip || '')
                .trim() !== ''
        )
        .map(device => ({
            id: Number(device.id),
            ip: String(device.ip).trim()
        }));

    if (targets.length === 0) {
        showToast(
            'IPアドレス設定済みの機器を選択してください',
            'warning'
        );
        return;
    }

    await doPing(targets);
}


/**
 * Ping実行共通処理
 */

/**
 * Ping実行共通処理
 */
export async function doPing(targets) {
    if (!requireAdminUiAction() || appState.authExpired || appState.isPinging || targets.length === 0) {
        return;
    }
    if (isSaveInFlight() || appState.appStatus.dirty || hasPendingChanges() ||
        getPendingSave() || hasAnyDeviceDraftChanges() ||
        hasUnappliedPanelChanges() || hasUnappliedLinkPanelChanges()) {
        showToast('未適用の入力は各編集画面で適用してください。保存待ち・保存中の変更は保存完了を待ち、保存失敗時は「保存」で再試行してください', 'warning');
        return;
    }

    const normalizedTargets = targets.map(target => ({
        id: Number(target.id),
        ip: String(target.ip || '').trim()
    }));

    const targetIds = new Set(
        normalizedTargets
            .map(target => target.id)
            .filter(id => Number.isInteger(id) && id > 0)
    );

    const previousMonitoringState = new Map();

    appState.devices.forEach(device => {
        const deviceId = Number(device.id);

        if (!targetIds.has(deviceId)) {
            return;
        }

        previousMonitoringState.set(
            deviceId,
            {
                status: device.status,
                last_checked_at:
                    device.last_checked_at,
                last_response_ms:
                    device.last_response_ms,
                last_error:
                    device.last_error
            }
        );
    });

    let pingProgressTimer = null;
    let elapsedSeconds = 0;
    const targetCount = normalizedTargets.length;
    const startedAt = new Date();

    try {
        appState.isPinging = true;
        const progressMessage = () => `Ping実行中: ${targetCount}件・経過${elapsedSeconds}秒`;
        eventBus.emit('ping:updated', {
            message: progressMessage(), running: true, targets: normalizedTargets, startedAt
        });

        const busyLabel = document.getElementById('busy-label');
        pingProgressTimer = setInterval(() => {
            elapsedSeconds += 1;
            if (busyLabel) {
                busyLabel.textContent = progressMessage();
                busyLabel.title = busyLabel.textContent;
            }
            eventBus.emit('ping:updated', { message: progressMessage(), running: true });
        }, 1000);

        appState.devices.forEach(device => {
            if (targetIds.has(Number(device.id))) {
                device.status = 'checking';
                device.last_error = null;
                device.last_response_ms = null;
            }
        });

        render();
        eventBus.emit('ledger:render');
        setBusy(true, progressMessage());
        const data = await apiFetch('ping', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                revision: appState.dataRevision,
                targets: normalizedTargets
            })
        });

        const responseMonitorRevision =
            Number(data.monitor_revision);

        if (
            Number.isInteger(
                responseMonitorRevision
            ) &&
            responseMonitorRevision > 0
        ) {
            appState.monitorRevision =
                responseMonitorRevision;
        }

        if (data.last_monitored_at) {
            appState.appStatus.lastMonitoredAt =
                data.last_monitored_at;
        }

        const results = Array.isArray(data.results)
            ? data.results
            : [];

        /*
         * 結果をID単位で管理する。
         * 1台失敗しても、ほかの機器の結果には影響させない。
         */
        const resultById = new Map();

        results.forEach(result => {
            const id = Number(result.id);

            if (!Number.isInteger(id) || id <= 0) {
                return;
            }

            resultById.set(id, result);
        });

        appState.devices.forEach(device => {
            const deviceId = Number(device.id);

            if (!targetIds.has(deviceId)) {
                return;
            }

            const result = resultById.get(deviceId);

            if (!result) {
                device.status = 'unknown';
                device.last_checked_at = null;
                device.last_response_ms = null;
                device.last_error = 'Ping結果を取得できませんでした';
                return;
            }

            device.status = normalizeStatus(result.status);
            device.last_checked_at =
                result.checked_at ||
                result.last_checked_at ||
                null;
            device.last_response_ms =
                toNullableNumber(result.response_ms);
            device.last_error = result.error || null;
        });

        if (!appState.appStatus.dirty) {
            appState.appStatus.state = 'saved';
        }
        appState.appStatus.lastError = null;

        render();

        eventBus.emit('ping:updated', {
            running: false, results, completedAt: new Date(), error: null
        });

    } catch (err) {
        console.error(err);

        /*
         * API全体が失敗した場合だけ、確認中の対象を未確認へ戻す。
         * 既に結果が確定した機器や対象外の機器には触れない。
         */
        appState.devices.forEach(device => {
            const deviceId = Number(device.id);
            const previous =
                previousMonitoringState.get(
                    deviceId
                );

            if (!previous) {
                return;
            }

            device.status =
                previous.status;

            device.last_checked_at =
                previous.last_checked_at;

            device.last_response_ms =
                previous.last_response_ms;

            device.last_error =
                previous.last_error;
        });

        render();
        let message;
        if (err?.status === 504) {
            message = `Pingタイムアウト: ${err.message}`;
        } else if (err?.status === 409) {
            message = err.message?.includes('再読み込み')
                ? err.message
                : `${err.message || '競合が発生しました'}（画面を再読み込みしてください）`;
        } else if (!err?.status) {
            message = '通信が中断されました。監視結果を再読み込みして確認してください';
        } else {
            message = `Pingエラー: ${err.message}`;
        }
        eventBus.emit('ping:updated', {
            running: false, results: [], completedAt: new Date(), error: message
        });

    } finally {
        if (pingProgressTimer !== null) {
            clearInterval(pingProgressTimer);
            pingProgressTimer = null;
        }
        appState.isPinging = false;
        setBusy(false);
        eventBus.emit('ledger:render');
    }
}



/**
 * 機器種別ごとの初期名称
 */

/**
 * 機器種別ごとの初期名称
 */
export function getDefaultDeviceName(type) {
    const definition =
        DEVICE_TYPES[type] ||
        DEVICE_TYPES.other;

    const baseName = definition.label;

    const sameTypeCount = appState.devices.filter(
        device => device.type === type
    ).length;

    return `${baseName}${sameTypeCount + 1}`;
}



/**
 * 機器追加
 */

/**
 * 機器追加
 */
export async function addDevice(type = 'switch') {
    if (!requireAdminUiAction()) {
        return;
    }
    if (appState.currentViewId === null) {
        showToast(
            '機器を登録するビューがありません',
            'warning'
        );
        return;
    }

    if (!DEVICE_TYPES[type]) {
        type = 'switch';
    }

    if (!await closePanel() || !await closeLinkPanel()) {
        return;
    }

    const rect =
        appState.canvas.getBoundingClientRect();

    const center = screenToWorld(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2
    );

    const currentTypeCount =
        getCurrentPlacements().filter(
            placement => {
                const device =
                    getDeviceForPlacement(
                        placement
                    );

                return device?.type === type;
            }
        ).length;

    const offset =
        currentTypeCount * 12;

    const position = clampPosition(
        center.x -
            DEFAULT_DEVICE_WIDTH / 2 +
            offset,
        center.y -
            DEFAULT_DEVICE_HEIGHT / 2 +
            offset
    );

    const deviceId = allocateLocalId('devices');
    const placementId = allocateLocalId('placements');

    const device = {
        id: deviceId,
        name: getDefaultDeviceName(type),
        type,
        ip: '',

        /*
         * 互換用。描画には使用しない。
         */
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

    appState.selectedPlacementIds.clear();
    appState.selectedPlacementIds.add(
        placementId
    );


    render();
    await openPanel(device);
}

/**
 * ツールバーで選択した種別の機器を追加
 */

/**
 * ツールバーで選択した種別の機器を追加
 */
export function addSelectedDeviceType() {
    const select =
        document.getElementById('add-device-type');

    const type = select
        ? String(select.value)
        : 'switch';

    addDevice(type);
}



/**
 * リンク作成モード切替
 */
export function toggleLinkMode() {
    if (!appState.linkMode && (!requireAdminUiAction() || appState.authExpired ||
        hasResourceConflict('views', appState.currentViewId))) {
        return;
    }

    if (!appState.linkMode) {
        if (hasUnappliedPanelChanges() || hasUnappliedLinkPanelChanges()) {
            return (async () => {
                if (!await closePanel() || !await closeLinkPanel()) return;
                finishToggleLinkMode();
            })();
        }
        closePanel();
        closeLinkPanel();
    }

    finishToggleLinkMode();
}

function finishToggleLinkMode() {
    eventBus.emit('canvas-note:finish');
    appState.noteMode = false;
    appState.selectedCanvasNoteId = null;
    appState.linkMode = !appState.linkMode;
    resetLinkCreationState();

    if (appState.linkMode) {
        finishCanvasContextToolbar('replace');
        closeWorkspaceNavigation();
        eventBus.emit('placement-mode:exit');
        appState.selectedPlacementIds.clear();
    }

    syncLinkModeButton();


    render();
    document.getElementById('linkBtn')?.focus();
}


/**
 * 描画
 */

/**
 * ボタン等のbusy制御
 */
export function setBusy(
    busy,
    message = ''
) {
    const body = document.body;

    if (body) {
        body.classList.toggle(
            'busy',
            busy
        );
    }

    const busyLabel =
        document.getElementById(
            'busy-label'
        );

    if (busyLabel) {
        busyLabel.textContent =
            busy ? message : '';
        busyLabel.title = busyLabel.textContent;
    }

    const ids = [
        'btn-save',
        'saveBtn',
        'dashboard-refresh-btn',
        'ledger-ping-btn',
        'btn-ping-selected',
        'pingSelectedBtn',
        'btn-load',
        'loadBtn',
        'view-add-btn',
        'view-duplicate-btn',
        'view-delete-btn',
        'view-apply-btn',
        'placement-manager-apply-btn',
        'p-manage-placements-btn',
        'ledger-delete-btn',
        'ledger-save-btn',
        'ledger-csv-export-btn',
        'ledger-csv-import-btn',
        'devices-csv-preview-btn',
        'devices-csv-commit-btn',
        'backup-export-btn',
        'backup-restore-btn',
        'backup-restore-preview-btn',
        'backup-restore-commit-btn',
        'floor-plan-manage-btn',
        'floor-plan-upload-btn',
        'floor-plan-delete-btn',
        'floor-plan-visible',
        'floor-plan-opacity',
        'floor-plan-drag-mode-btn',
        'floor-plan-reset-btn'
    ];

    ids.forEach(id => {
        const element =
            document.getElementById(id);

        if (element) {
            element.disabled = busy;
        }
    });

    const busyFields =
        document.querySelectorAll(
            '#panel input, ' +
            '#panel select, ' +
            '#panel textarea, ' +
            '#link-panel input, ' +
            '#link-panel select, ' +
            '#lp-system, ' +
            '#link-panel textarea, ' +
            '#ledger-dialog input, ' +
            '#ledger-dialog select, ' +
            '#ledger-dialog .ledger-filter-trigger, ' +
            '.device-type-trigger, ' +
            '#ledger-dialog textarea, ' +
            '#view-manager-form input, ' +
            '#view-manager-form select, ' +
            '#view-manager-form textarea, ' +
            '#placement-manager-overlay input, ' +
            '#placement-manager-overlay select, ' +
            '#placement-manager-overlay textarea, ' +
            '#devices-csv-import-overlay input, ' +
            '#devices-csv-import-overlay button, ' +
            '#backup-restore-overlay input, ' +
            '#backup-restore-overlay button, ' +
            '#data-quality-overlay button, ' +
            '#floor-plan-manager-overlay input, ' +
            '#floor-plan-manager-overlay button'
        );

    busyFields.forEach(element => {
        if (busy) {
            /*
             * 同一busy期間中に複数回呼ばれても、
             * 元の状態を上書きしない。
             */
            if (
                !Object.prototype
                    .hasOwnProperty.call(
                        element.dataset,
                        'disabledBeforeBusy'
                    )
            ) {
                element.dataset
                    .disabledBeforeBusy =
                    element.disabled
                        ? 'true'
                        : 'false';
            }

            element.disabled = true;
            return;
        }

        if (
            !Object.prototype
                .hasOwnProperty.call(
                    element.dataset,
                    'disabledBeforeBusy'
                )
        ) {
            return;
        }

        const wasDisabled =
            element.dataset
                .disabledBeforeBusy ===
                'true';

        element.disabled =
            wasDisabled;

        delete element.dataset
            .disabledBeforeBusy;
    });

    if (!busy) {
        updateSaveButtonState();
        eventBus.emit('ui:busy-ended');
    } else {
        const saveBtn = document.getElementById('saveBtn');
        if (saveBtn) saveBtn.disabled = true;
    }
}


/**
 * 通知表示
 */

/**
 * デバッグ用: 現在データを取得
 */
export function getCurrentData() {
    return {
        currentViewId: appState.currentViewId,
        views: appState.views.map(toSaveView),
        devices: appState.devices.map(toSaveDevice),
        placements:
            appState.placements.map(toSavePlacement),
        links: appState.links.map(toSaveLink),
        canvas_notes: appState.canvasNotes.map(toSaveCanvasNote)
    };
}



export async function reloadDataWithConfirmation() {
    const hasUnapplied = typeof window.hasAnyUnappliedChanges === 'function' && window.hasAnyUnappliedChanges();
    if (
        (appState.appStatus.dirty || hasUnapplied) &&
        !confirm(
            '保存していない変更があります。\n' +
            '変更を破棄して再読み込みしますか?'
        )
    ) {
        return;
    }

    await loadData();
}

if (typeof eventBus !== 'undefined' && eventBus.on) {
    eventBus.on('save-state:changed', () => {
        updateSaveButtonState();
    });
}
