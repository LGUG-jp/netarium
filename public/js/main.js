/**
 * Netarium - メインエントリーポイント (Main Entry Point)
 * ES Modules
 */

import { appState, state } from './core/state.js';
import { eventBus } from './core/event-bus.js';
import { initModalFocusTrap } from './core/modal-focus.js';
import { initializeHiddenTerminal } from './modals/hidden-terminal.js';
import { initializeLinkDisplaySettings } from './core/link-display-settings.js';
import { initCanvasContextToolbar } from './ui/canvas-context-toolbar.js';
import { initLinkRouteEditor } from './canvas/link-route-editor.js';
import { initCanvasNotes, finishCanvasNotes } from './canvas/canvas-notes.js';
import {
    closeLinkDisplaySettings,
    initializeLinkDisplayModal,
    openLinkDisplaySettings
} from './modals/link-display-modal.js';
import { initializePrintModal } from './modals/print-modal.js';
import { initializeLinkSystemsModal, openLinkSystems, closeLinkSystems } from './modals/link-systems-modal.js';
import { initializeLinkBulkModal } from './modals/link-bulk-modal.js';
import {
    initializePingResultsModal, openPingResults, closePingResults, downloadPingResultsCsv
} from './modals/ping-results-modal.js';
import { hasAnyDeviceDraftChanges } from './core/device-drafts.js';
import {
    addDevice,
    addSelectedDeviceType,
    applyRoleBasedUi,
    confirmPendingSave,
    exportBackupZip,
    getCurrentData,
    getPendingSave,
    loadData,
    pingSelected,
    reloadDataWithConfirmation,
    saveData,
    saveDeviceProperties,
    scheduleSave,
    flushSaveQueue,
    toggleLinkMode
} from './ui/toolbar.js';
import {
    closeToolbarMenu,
    closePlacePopover,
    syncLinkModeButton,
    togglePlacePopover
} from './ui/toolbar-controls.js';
import {
    clearPlacementQueue,
    enqueueSelectedUnplacedDevices,
    enterPlacementMode,
    exitPlacementMode,
    hidePlacementGhost,
    isPlacementModeActive,
    removeDeviceFromPlacementQueue,
    renderPlacementUnplacedList,
    setNextPlacementQueueDevice,
    setPlacementNewDeviceType,
    setPlacementUnplacedScope,
    switchPlacementTab,
    togglePlacementMode,
    updatePlacementGhost
} from './ui/placement-mode.js';
import {
    closeWorkspaceNavigation,
    initWorkspaceNavigation,
    openWorkspaceNavigation,
    renderWorkspaceNavigation,
    toggleWorkspaceNavigation
} from './ui/workspace-navigation.js';
import { closeWiringControls, initWiringControls } from './ui/wiring-controls.js';
import {
    applyLinkPanel,
    applyPanel,
    applyPlacementCoordinates,
    closeLinkPanel,
    closePanel,
    deleteDevice,
    deleteDeviceCompletely,
    deleteDeviceCompletelyFromPanel,
    deleteEditingLink,
    deleteSelected,
    hasAnyUnappliedChanges,
    hasUnappliedLinkPanelChanges,
    hasUnappliedPanelChanges,
    openLinkPanel,
    openPanel,
    openPlacementManagerFromPanel,
    revertLinkPanelValues,
    revertPanelValues,
    setDevicePanelReadOnly,
    setLinkPanelReadOnly,
    swapLinkPanelEndpoints,
    syncPanelIfOpen,
    updateDeviceManagementButtons,
    jumpToManagementSettings
} from './ui/property-panel.js';
import {
    closeLedger,
    clearLedgerSelection,
    openLedgerBulkEdit, closeLedgerBulkEdit, previewLedgerBulkEdit,
    backLedgerBulkEdit, confirmLedgerBulkEdit,
    closeLedgerDetailPane,
    closeLedgerPlaceViewModal,
    confirmPlaceDevicesToView,
    deleteSelectedLedgerDevicesCompletely,
    focusActiveDeviceOnCanvas,
    getLedgerSelectedDeviceIds,
    manageActiveDevicePlacements,
    openDashboardLedger,
    openDataQualityDeviceInLedger,
    openLedger,
    openLedgerWithFilters,
    openLedgerDetail,
    openLedgerPlaceViewModal,
    pingLedgerSelected,
    renderLedgerTable,
    resetLedgerFilters,
    saveLedger,
    saveLedgerSheet,
    setLedgerColumnPreset,
    toggleAllLedgerCheckboxes
} from './modals/ledger-modal.js';
import {
    addView,
    applyViewForm,
    closeViewManager,
    deleteSelectedView,
    duplicateSelectedView,
    openViewManager,
    openSelectedViewFloorPlan,
    renderViewSelector,
    renderViewManagerList,
    reloadSelectedViewConflict,
    switchView,
    updateViewManagerFormState,
    updateViewManagerButtons
} from './modals/view-manager-modal.js';
import { initViewCombobox } from './ui/view-combobox.js';
import {
    applyPlacementManager,
    closePlacementManager,
    openPlacementManager,
    renderPlacementManager
} from './modals/placement-modal.js';
import {
    closeDeviceSearchViewSelector,
    initializeDeviceSearch,
    renderDeviceSearchResults
} from './modals/device-search-modal.js';
import {
    chooseFloorPlanFile,
    commitFloorPlanOpacity,
    finishFloorPlanAdjustMode,
    previewFloorPlanOpacity,
    closeFloorPlanManager,
    deleteCurrentFloorPlan,
    fitViewToFloorPlan,
    openFloorPlanManager,
    openDataQualityFloorPlan,
    resetCurrentFloorPlanSettings,
    renderFloorPlan,
    toggleFloorPlanVisibility,
    toggleFloorPlanAdjustMode,
    updateFloorPlanMenuVisibility,
    updateFloorPlanSettingsButtons,
    uploadCurrentFloorPlan
} from './modals/floor-plan-modal.js';
import {
    closeManagementConnectionDialog,
    closeManagementSshHelpDialog,
    confirmManagementConnection,
    getManagementConnectionPortInput,
    openEditingDeviceManagement,
    openManagementSshHelpDialog,
    updateManagementConnectionPreview
} from './modals/management-modal.js';
import { openPingHelpDialog, closePingHelpDialog } from './modals/ping-help-modal.js';
import {
    closeDevicesCsvImport,
    commitDevicesCsvImport,
    downloadDevicesCsvTemplate,
    exportDevicesCsv,
    openDevicesCsvImport,
    previewDevicesCsvImport,
    renderDevicesCsvImportRows,
    resetDevicesCsvImportPreview,
    updateDevicesCsvImportButtons
} from './modals/csv-modal.js';
import {
    closeBackupRestore,
    commitBackupRestore,
    openBackupRestore,
    previewBackupRestore,
    resetBackupRestorePreview,
    updateBackupRestoreButtons
} from './modals/backup-modal.js';
import {
    closeDashboard,
    handleDashboardAction,
    hideDashboardForNavigation,
    inspectDashboardModel,
    openDashboard,
    refreshDashboard
} from './modals/dashboard-modal.js';
import {
    clearDataQualityFilters,
    closeDataQuality,
    openDataQuality,
    refreshDataQuality,
    renderDataQuality,
    selectDataQualitySeverity
} from './modals/data-quality-modal.js';
import {
    closeAccountManagement,
    initializeAccountManagement,
    openPasswordChange,
    openUserManagement,
    refreshUserList
} from './modals/account-modal.js';
import {
    applyViewTransform,
    onCanvasWheel,
    resetView,
    zoomAtCanvasCenter
} from './canvas/pan-zoom.js';
import {
    onCanvasPointerDown
} from './canvas/drag-drop.js';
import {
    fitViewToDevices,
    focusDevicePlacement,
    highlightDevicePlacement,
    onCanvasClick,
    renderLinks,
    showDeviceInPlacement
} from './canvas/renderer.js';
import {
    beginCanvasRangeSelection,
    onKeyDown,
    syncSelectedPlacementClasses,
    updateSelectionCount
} from './canvas/selection.js';
import {
    showToast
} from './ui/toast.js';
import {
    changeDeviceImageZoom,
    closeDeviceImageZoom,
    triggerDeviceImageUpload
} from './ui/device-images.js';
import {
    renderStatusBar
} from './ui/status-bar.js';
import {
    isCurrentUserAdmin
} from './ui/access-control.js';

export function registerStaticListeners() {
    document.getElementById('floor-plan-reset-btn')?.addEventListener('click', () => resetCurrentFloorPlanSettings());
    document.getElementById('floor-plan-finish-btn')?.addEventListener('click', () => finishFloorPlanAdjustMode());
    document.getElementById('lp-close-btn')?.addEventListener('click', () => closeLinkPanel());
    document.getElementById('lp-swap-btn')?.addEventListener('click', () => swapLinkPanelEndpoints());
    document.getElementById('lp-apply-btn')?.addEventListener('click', () => applyLinkPanel());
    document.getElementById('lp-revert-btn')?.addEventListener('click', () => revertLinkPanelValues());
    document.getElementById('lp-delete-btn')?.addEventListener('click', () => deleteEditingLink());
    document.getElementById('p-close-btn')?.addEventListener('click', () => closePanel());
    document.getElementById('p-open-management-btn')?.addEventListener('click', () => openEditingDeviceManagement());
    document.getElementById('p-jump-management-settings-btn')?.addEventListener('click', () => jumpToManagementSettings());
    document.getElementById('p-manage-placements-btn')?.addEventListener('click', () => openPlacementManagerFromPanel());
    document.getElementById('p-apply-coord-btn')?.addEventListener('click', () => applyPlacementCoordinates());
    document.getElementById('p-device-image-add-btn')?.addEventListener('click', () => triggerDeviceImageUpload());
    document.getElementById('p-ping-help-btn')?.addEventListener('click', () => openPingHelpDialog());
    document.getElementById('p-apply-btn')?.addEventListener('click', () => applyPanel());
    document.getElementById('p-revert-btn')?.addEventListener('click', () => revertPanelValues());
    document.getElementById('p-delete-btn')?.addEventListener('click', () => deleteDevice());
    document.getElementById('p-delete-complete-btn')?.addEventListener('click', () => deleteDeviceCompletelyFromPanel());
    document.getElementById('ping-help-close-btn')?.addEventListener('click', () => closePingHelpDialog());
    document.getElementById('close-device-image-zoom-btn')?.addEventListener('click', () => closeDeviceImageZoom());
    document.getElementById('device-image-zoom-previous')?.addEventListener('click', () => changeDeviceImageZoom(-1));
    document.getElementById('device-image-zoom-next')?.addEventListener('click', () => changeDeviceImageZoom(1));
    document.getElementById('status-confirm-save-btn')?.addEventListener('click', () => confirmPendingSave());
    document.getElementById('status-ping-results-btn')?.addEventListener('click', () => openPingResults());
    document.getElementById('palette-view-btn')?.addEventListener('click', () => {
        if (appState.linkMode) toggleLinkMode();
        exitPlacementMode();
        finishCanvasNotes();
    });
    document.getElementById('palette-place-btn')?.addEventListener('click', () => togglePlacementMode());
    document.getElementById('exit-placement-mode-btn')?.addEventListener('click', () => exitPlacementMode());
    document.getElementById('place-tab-btn-new')?.addEventListener('click', () => switchPlacementTab('new'));
    document.getElementById('place-tab-btn-unplaced')?.addEventListener('click', () => switchPlacementTab('unplaced'));
    document.getElementById('placement-queue-clear-btn')?.addEventListener('click', () => clearPlacementQueue());
    document.getElementById('place-scope-current')?.addEventListener('click', () => setPlacementUnplacedScope('current-view'));
    document.getElementById('place-scope-all')?.addEventListener('click', () => setPlacementUnplacedScope('all-views'));
    document.getElementById('placement-unplaced-search')?.addEventListener('input', () => renderPlacementUnplacedList());
    document.getElementById('placement-enqueue-btn')?.addEventListener('click', () => enqueueSelectedUnplacedDevices());
    document.getElementById('linkBtn')?.addEventListener('click', () => toggleLinkMode());
    document.getElementById('wiring-close-btn')?.addEventListener('click', () => closeWiringControls());
    document.getElementById('pingSelectedBtn')?.addEventListener('click', () => pingSelected());
    document.getElementById('palette-nav-btn')?.addEventListener('click', () => toggleWorkspaceNavigation());
    document.getElementById('close-workspace-navigation-btn')?.addEventListener('click', () => closeWorkspaceNavigation());
    document.getElementById('floor-plan-manage-btn')?.addEventListener('click', () => openFloorPlanManager());
    document.getElementById('dashboard-btn')?.addEventListener('click', () => openDashboard());
    document.getElementById('ledgerBtn')?.addEventListener('click', () => openLedger());
    document.getElementById('loadBtn')?.addEventListener('click', () => reloadDataWithConfirmation());
    document.getElementById('saveBtn')?.addEventListener('click', () => saveData());
    document.getElementById('help-btn')?.addEventListener('click', () => window.open('help.html', '_blank', 'noopener'));
    document.getElementById('view-manage-btn')?.addEventListener('click', () => openViewManager());
    document.getElementById('link-display-settings-btn')?.addEventListener('click', () => openLinkDisplaySettings());
    document.getElementById('link-systems-settings-btn')?.addEventListener('click', () => openLinkSystems());
    document.getElementById('data-quality-btn')?.addEventListener('click', () => openDataQuality());
    document.getElementById('backup-export-btn')?.addEventListener('click', () => exportBackupZip());
    document.getElementById('backup-restore-btn')?.addEventListener('click', () => openBackupRestore());
    document.getElementById('user-management-btn')?.addEventListener('click', () => openUserManagement());
    document.getElementById('password-change-btn')?.addEventListener('click', () => openPasswordChange());
    document.getElementById('close-account-management-btn')?.addEventListener('click', () => closeAccountManagement());
    document.getElementById('user-list-refresh-btn')?.addEventListener('click', () => refreshUserList());
    document.getElementById('close-backup-restore-btn')?.addEventListener('click', () => closeBackupRestore());
    document.getElementById('backup-restore-preview-btn')?.addEventListener('click', () => previewBackupRestore());
    document.getElementById('close-backup-restore-btn-2')?.addEventListener('click', () => closeBackupRestore());
    document.getElementById('backup-restore-commit-btn')?.addEventListener('click', () => commitBackupRestore());
    document.getElementById('close-devices-csv-import-btn')?.addEventListener('click', () => closeDevicesCsvImport());
    document.getElementById('devices-csv-preview-btn')?.addEventListener('click', () => previewDevicesCsvImport());
    document.getElementById('devices-csv-problems-only')?.addEventListener('change', () => renderDevicesCsvImportRows());
    document.getElementById('close-devices-csv-import-btn-2')?.addEventListener('click', () => closeDevicesCsvImport());
    document.getElementById('devices-csv-commit-btn')?.addEventListener('click', () => commitDevicesCsvImport());
    document.getElementById('dashboard-refresh-btn')?.addEventListener('click', () => refreshDashboard());
    document.getElementById('close-dashboard-btn')?.addEventListener('click', () => closeDashboard());
    document.getElementById('close-data-quality-btn')?.addEventListener('click', () => closeDataQuality());
    document.getElementById('select-data-quality-severity-btn')?.addEventListener('click', () => selectDataQualitySeverity('error'));
    document.getElementById('select-data-quality-severity-btn-2')?.addEventListener('click', () => selectDataQualitySeverity('warning'));
    document.getElementById('select-data-quality-severity-btn-3')?.addEventListener('click', () => selectDataQualitySeverity('info'));
    document.getElementById('select-data-quality-severity-btn-4')?.addEventListener('click', () => selectDataQualitySeverity(''));
    document.getElementById('data-quality-refresh-btn')?.addEventListener('click', () => refreshDataQuality());
    document.getElementById('data-quality-clear-filter-btn')?.addEventListener('click', () => clearDataQualityFilters());
    document.getElementById('close-device-search-view-selector-btn')?.addEventListener('click', () => closeDeviceSearchViewSelector());
    document.getElementById('close-device-search-view-selector-btn-2')?.addEventListener('click', () => closeDeviceSearchViewSelector());
    document.getElementById('close-floor-plan-manager-btn')?.addEventListener('click', () => closeFloorPlanManager());
    document.getElementById('floor-plan-drag-mode-btn')?.addEventListener('click', () => toggleFloorPlanAdjustMode());
    document.getElementById('floor-plan-upload-btn')?.addEventListener('click', () => chooseFloorPlanFile());
    document.getElementById('floor-plan-delete-btn')?.addEventListener('click', () => deleteCurrentFloorPlan());
    document.getElementById('close-ledger-btn')?.addEventListener('click', () => closeLedger());
    document.getElementById('ledger-search')?.addEventListener('input', () => renderLedgerTable());
    document.getElementById('ledger-filter-reset-btn')?.addEventListener('click', () => resetLedgerFilters());
    document.getElementById('ledger-csv-export-btn')?.addEventListener('click', () => exportDevicesCsv());
    document.getElementById('ledger-csv-import-btn')?.addEventListener('click', () => openDevicesCsvImport());
    document.getElementById('ledger-clear-selection-btn')?.addEventListener('click', () => clearLedgerSelection());
    document.getElementById('ledger-bulk-edit-btn')?.addEventListener('click', () => openLedgerBulkEdit());
    document.getElementById('ledger-ping-btn')?.addEventListener('click', () => pingLedgerSelected());
    document.getElementById('ledger-ping-results-btn')?.addEventListener('click', () => openPingResults());
    document.getElementById('ledger-bulk-place-btn')?.addEventListener('click', () => openLedgerPlaceViewModal());
    document.getElementById('ledger-delete-btn')?.addEventListener('click', () => deleteSelectedLedgerDevicesCompletely());
    document.getElementById('ledger-save-btn')?.addEventListener('click', () => saveLedger());
    document.getElementById('ledger-column-preset')?.addEventListener('change', event => setLedgerColumnPreset(event.currentTarget.value));
    document.getElementById('ledger-select-all')?.addEventListener('click', event => toggleAllLedgerCheckboxes(event.currentTarget));
    document.getElementById('close-ledger-bulk-edit-btn')?.addEventListener('click', () => closeLedgerBulkEdit());
    document.getElementById('close-ledger-bulk-edit-btn-2')?.addEventListener('click', () => closeLedgerBulkEdit());
    document.getElementById('ledger-bulk-edit-next')?.addEventListener('click', () => previewLedgerBulkEdit());
    document.getElementById('back-ledger-bulk-edit-btn')?.addEventListener('click', () => backLedgerBulkEdit());
    document.getElementById('ledger-bulk-edit-apply')?.addEventListener('click', () => confirmLedgerBulkEdit());
    document.getElementById('close-ledger-detail-pane-btn')?.addEventListener('click', () => closeLedgerDetailPane());
    document.getElementById('ledger-sheet-prev-btn')?.addEventListener('click', () => navigateLedgerDevice(-1));
    document.getElementById('ledger-sheet-next-btn')?.addEventListener('click', () => navigateLedgerDevice(1));
    document.getElementById('ledger-sheet-canvas-btn')?.addEventListener('click', () => focusActiveDeviceOnCanvas());
    document.getElementById('ledger-sheet-view-manage-btn')?.addEventListener('click', () => manageActiveDevicePlacements());
    document.getElementById('ledger-sheet-save-btn')?.addEventListener('click', () => saveLedgerSheet());
    document.getElementById('close-ledger-place-view-modal-btn')?.addEventListener('click', () => closeLedgerPlaceViewModal());
    document.getElementById('close-ledger-place-view-modal-btn-2')?.addEventListener('click', () => closeLedgerPlaceViewModal());
    document.getElementById('ledger-place-view-submit-btn')?.addEventListener('click', () => confirmPlaceDevicesToView());
    document.getElementById('close-link-display-settings-btn')?.addEventListener('click', () => closeLinkDisplaySettings());
    document.getElementById('close-management-connection-dialog-btn')?.addEventListener('click', () => closeManagementConnectionDialog());
    document.getElementById('management-connection-ssh-help-btn')?.addEventListener('click', () => openManagementSshHelpDialog());
    document.getElementById('close-management-connection-dialog-btn-2')?.addEventListener('click', () => closeManagementConnectionDialog());
    document.getElementById('management-connection-open-btn')?.addEventListener('click', () => confirmManagementConnection());
    document.getElementById('management-ssh-help-close-btn')?.addEventListener('click', () => closeManagementSshHelpDialog());
    document.getElementById('close-placement-manager-btn')?.addEventListener('click', () => closePlacementManager());
    document.getElementById('close-placement-manager-btn-2')?.addEventListener('click', () => closePlacementManager());
    document.getElementById('placement-manager-apply-btn')?.addEventListener('click', () => applyPlacementManager());
    document.getElementById('close-view-manager-btn')?.addEventListener('click', () => closeViewManager());
    document.getElementById('view-add-btn')?.addEventListener('click', () => addView());
    document.getElementById('view-duplicate-btn')?.addEventListener('click', () => duplicateSelectedView());
    document.getElementById('view-delete-btn')?.addEventListener('click', () => deleteSelectedView());
    document.getElementById('view-manager-form')?.addEventListener('submit', event => event.preventDefault());
    document.getElementById('vm-floor-plan-btn')?.addEventListener('click', () => openSelectedViewFloorPlan());
    document.getElementById('view-conflict-reload-btn')?.addEventListener('click', () => reloadSelectedViewConflict());
    document.getElementById('view-apply-btn')?.addEventListener('click', () => applyViewForm());
}

function registerApplicationEvents() {
    eventBus.on('resources:reloaded', () => {
        // 全読込は利用者が破棄を選んだ操作。古いフォームを新しいstateに残さない。
        if (document.getElementById('ledger-overlay')?.hidden === false) closeLedger();
        else if (document.getElementById('ledger-device-sheet-overlay')?.hidden === false) closeLedgerDetailPane();
    });
    eventBus.on(
        'canvas:render-floor-plan',
        renderFloorPlan
    );

    eventBus.on(
        'canvas:render-complete',
        () => {
            syncPanelIfOpen();
            updateSelectionCount();
            renderViewSelector();
            renderStatusBar();
            updateFloorPlanMenuVisibility();
        }
    );

    eventBus.on(
        'canvas:render-links',
        renderLinks
    );
    eventBus.on(
        'canvas:begin-range-selection',
        beginCanvasRangeSelection
    );
    eventBus.on(
        'canvas:selection-changed',
        () => {
            syncSelectedPlacementClasses();
            updateSelectionCount();
        }
    );

    eventBus.on(
        'toolbar:sync-link-mode',
        syncLinkModeButton
    );
    eventBus.on(
        'view:switch',
        switchView
    );
    eventBus.on(
        'floor-plan:fit',
        fitViewToFloorPlan
    );
    eventBus.on(
        'placement-manager:open',
        openPlacementManager
    );

    eventBus.on(
        'floor-plan:update-menu-visibility',
        updateFloorPlanMenuVisibility
    );
    eventBus.on(
        'view:render-selector',
        renderViewSelector
    );
    eventBus.on(
        'device-search:render-results',
        renderDeviceSearchResults
    );
    eventBus.on(
        'ledger:render',
        renderLedgerTable
    );
    eventBus.on('ledger:open-for-view', ({ viewId }) => openLedgerWithFilters({ viewId }));
    eventBus.on(
        'ledger:open-data-quality-device',
        openDataQualityDeviceInLedger
    );
    eventBus.on(
        'ledger:open-device-sheet',
        async payload => {
            const deviceId =
                typeof payload === 'object' && payload !== null
                    ? payload.deviceId
                    : payload;
            const field =
                typeof payload === 'object' && payload !== null
                    ? payload.field
                    : null;
            if (!await openLedgerDetail(deviceId)) return;
            if (field) {
                window.requestAnimationFrame(() => {
                    const inputEl =
                        document.querySelector(
                            `#ledger-device-sheet-overlay [data-field="${field}"]`
                        );
                    if (
                        inputEl instanceof
                        HTMLElement
                    ) {
                        inputEl.focus();
                        inputEl.scrollIntoView({
                            block: 'center',
                            inline: 'nearest'
                        });
                    }
                });
            }
        }
    );
    eventBus.on(
        'floor-plan:open-data-quality',
        openDataQualityFloorPlan
    );
    eventBus.on(
        'dashboard:hide-for-navigation',
        hideDashboardForNavigation
    );
    eventBus.on(
        'data-quality:render',
        renderDataQuality
    );
    eventBus.on(
        'ui:busy-ended',
        () => {
            applyRoleBasedUi();
            updateViewManagerButtons();
            updateFloorPlanSettingsButtons();
            updateDevicesCsvImportButtons();
            updateBackupRestoreButtons();
            updateDeviceManagementButtons();
            setDevicePanelReadOnly(
                !isCurrentUserAdmin()
            );
            setLinkPanelReadOnly(
                !isCurrentUserAdmin()
            );
        }
    );
}

/**
 * 初期化
 */
function init() {
    registerApplicationEvents();
    registerStaticListeners();
    initializeLinkDisplaySettings();
    initCanvasContextToolbar();

    appState.canvas = document.getElementById('canvas');
    appState.world = document.getElementById('world');
    appState.currentSvg = document.getElementById('link-layer');
    appState.deviceLayer = document.getElementById('device-layer');
    appState.floorPlanLayer = document.getElementById('floor-plan-layer');
    appState.noteLayer = document.getElementById('canvas-note-layer');
    appState.selectionBox =
        document.getElementById(
            'canvas-selection-box'
        );


    if (
        !appState.canvas ||
        !appState.world ||
        !appState.currentSvg ||
        !appState.deviceLayer ||
        !appState.noteLayer ||
        !appState.floorPlanLayer ||
        !appState.selectionBox
    ) {
        console.error(
            '描画領域の必要な要素が見つかりません'
        );

        showToast(
            '描画領域を初期化できません',
            'error'
        );

        return;
    }
    initLinkRouteEditor();
    initCanvasNotes();
    initializeHiddenTerminal();


    document.addEventListener(
        'keydown',
        onKeyDown,
        true
    );

    const managementConnectionPortInput =
        getManagementConnectionPortInput();

    if (managementConnectionPortInput) {
        managementConnectionPortInput.addEventListener(
            'input',
            updateManagementConnectionPreview
        );
    }

    const managementConnectionSchemeInputs =
        document.querySelectorAll(
            'input[name="management-connection-scheme"]'
        );

    managementConnectionSchemeInputs.forEach(
        input => {
            input.addEventListener(
                'change',
                updateManagementConnectionPreview
            );
        }
    );

    appState.canvas.addEventListener(
        'click',
        onCanvasClick
    );

    appState.canvas.addEventListener(
        'wheel',
        onCanvasWheel,
        { passive: false }
    );

    appState.canvas.addEventListener(
        'pointerdown',
        onCanvasPointerDown
    );

    appState.canvas.addEventListener(
        'pointermove',
        event => {
            if (isPlacementModeActive()) {
                updatePlacementGhost(event.clientX, event.clientY);
            }
        }
    );

    appState.canvas.addEventListener(
        'pointerleave',
        () => {
            if (isPlacementModeActive()) {
                hidePlacementGhost();
            }
        }
    );

    const canvasViewControls = document.getElementById('canvas-view-controls');
    if (canvasViewControls) {
        canvasViewControls.hidden = false;
    }

    document
        .getElementById('zoom-out-btn')
        ?.addEventListener(
            'click',
            () => zoomAtCanvasCenter(0.8)
        );

    document
        .getElementById('zoom-in-btn')
        ?.addEventListener(
            'click',
            () => zoomAtCanvasCenter(1.25)
        );

    document
        .getElementById('zoom-reset-btn')
        ?.addEventListener(
            'click',
            resetView
        );

    document
        .getElementById('zoom-fit-btn')
        ?.addEventListener(
            'click',
            fitViewToDevices
        );

    applyViewTransform();

    initViewCombobox(switchView);

    document
        .getElementById('p-ip')
        ?.addEventListener(
            'input',
            updateDeviceManagementButtons
        );

    document
        .getElementById(
            'view-manager-search'
        )
        ?.addEventListener(
            'input',
            renderViewManagerList
        );

    document
        .getElementById(
            'view-manager-form'
        )
        ?.addEventListener(
            'input',
            updateViewManagerFormState
        );



    document
        .querySelectorAll('.toolbar-menu')
        .forEach(menu => {
            menu.addEventListener('toggle', async event => {
                const target = event.currentTarget;
                if (
                    target instanceof HTMLDetailsElement &&
                    target.open
                ) {
                    if (!await closePanel() || !await closeLinkPanel()) {
                        target.open = false;
                        return;
                    }
                    document
                        .querySelectorAll('.toolbar-menu')
                        .forEach(other => {
                            if (other !== target && other.open) {
                                other.open = false;
                            }
                        });
                }
            });
        });

    document
        .querySelectorAll('.toolbar-menu button')
        .forEach(button => {
            if (button.closest('form')) {
                return;
            }

            button.addEventListener(
                'click',
                closeToolbarMenu
            );
        });

    document
        .getElementById(
            'placement-manager-search'
        )
        ?.addEventListener(
            'input',
            renderPlacementManager
        );


    window.addEventListener(
        'beforeunload',
        event => {
            const hasUnapplied = typeof window.hasAnyUnappliedChanges === 'function' && window.hasAnyUnappliedChanges();
            if (!appState.appStatus.dirty && !hasUnapplied) {
                return;
            }

            event.preventDefault();
            event.returnValue = '';
        }
    );

    initializeDeviceSearch();
    initializeAccountManagement();
    initializeLinkDisplayModal();
    initializePrintModal();
    initializeLinkSystemsModal();
    initializeLinkBulkModal();
    initializePingResultsModal();


    document.getElementById('floor-plan-file')?.addEventListener('change', uploadCurrentFloorPlan);
    document.getElementById('floor-plan-visible')?.addEventListener('change', toggleFloorPlanVisibility);
    const floorPlanOpacity = document.getElementById('floor-plan-opacity');
    floorPlanOpacity?.addEventListener('input', previewFloorPlanOpacity);
    for (const type of ['change', 'pointerup', 'keyup', 'blur']) {
        floorPlanOpacity?.addEventListener(type, commitFloorPlanOpacity);
    }

    document
        .getElementById(
            'devices-csv-import-file'
        )
        ?.addEventListener(
            'change',
            resetDevicesCsvImportPreview
        );


        document
            .getElementById(
                'backup-restore-file'
            )
            ?.addEventListener(
                'change',
                resetBackupRestorePreview
            );

        document
            .getElementById(
                'backup-restore-confirmation'
            )
            ?.addEventListener(
                'input',
                updateBackupRestoreButtons
            );


        document
            .getElementById(
                'dashboard-content'
            )
            ?.addEventListener(
                'click',
                event => {
                    const target =
                        event.target instanceof
                            Element
                            ? event.target.closest(
                                '[data-dashboard-action]'
                            )
                            : null;

                    if (
                        !target ||
                        target.hasAttribute(
                            'disabled'
                        )
                    ) {
                        return;
                    }

                    const action =
                        String(
                            target.dataset
                                .dashboardAction ||
                            ''
                        );

                    if (
                        action ===
                        'ledger-facility'
                    ) {
                        openDashboardLedger({
                            facility:
                                target.dataset
                                    .facility ||
                                ''
                        });

                        return;
                    }

                    if (
                        action ===
                        'ledger-floor'
                    ) {
                        openDashboardLedger({
                            facility:
                                target.dataset
                                    .facility ||
                                '',

                            floor:
                                target.dataset
                                    .floor ||
                                ''
                        });

                        return;
                    }

                    if (
                        action ===
                        'ledger-type'
                    ) {
                        openDashboardLedger({
                            type:
                                target.dataset
                                    .deviceType ||
                                ''
                        });

                        return;
                    }

                    handleDashboardAction(
                        action
                    );
                }
            );


    applyRoleBasedUi();
    syncLinkModeButton();
    initWorkspaceNavigation();
    initWiringControls();
    initModalFocusTrap();


    loadData();
}


/**
 * グローバル公開（モジュール間の画面操作・既存コンシューマー向け）
 */
window.addDevice = addDevice;
window.confirmPendingSave = confirmPendingSave;
window.getPendingSave = getPendingSave;
window.togglePlacePopover = togglePlacePopover;
window.closePlacePopover = closePlacePopover;
window.enterPlacementMode = enterPlacementMode;
window.exitPlacementMode = exitPlacementMode;
window.finishCanvasNotes = finishCanvasNotes;
window.togglePlacementMode = togglePlacementMode;
window.switchPlacementTab = switchPlacementTab;
window.setPlacementNewDeviceType = setPlacementNewDeviceType;
window.setPlacementUnplacedScope = setPlacementUnplacedScope;
window.renderPlacementUnplacedList = renderPlacementUnplacedList;
window.enqueueSelectedUnplacedDevices = enqueueSelectedUnplacedDevices;
window.clearPlacementQueue = clearPlacementQueue;
window.removeDeviceFromPlacementQueue = removeDeviceFromPlacementQueue;
window.setNextPlacementQueueDevice = setNextPlacementQueueDevice;
window.isPlacementModeActive = isPlacementModeActive;
window.openWorkspaceNavigation = openWorkspaceNavigation;
window.toggleWorkspaceNavigation = toggleWorkspaceNavigation;
window.closeWorkspaceNavigation = closeWorkspaceNavigation;
window.renderWorkspaceNavigation = renderWorkspaceNavigation;
window.addSelectedDeviceType = addSelectedDeviceType;
window.addView = addView;
window.applyLinkPanel = applyLinkPanel;
window.applyPanel = applyPanel;
window.applyPlacementCoordinates = applyPlacementCoordinates;
window.hasAnyUnappliedChanges = () => hasAnyUnappliedChanges()
    || hasAnyDeviceDraftChanges()
    || appState.viewManagerFormDirty;
window.hasUnappliedLinkPanelChanges = hasUnappliedLinkPanelChanges;
window.hasUnappliedPanelChanges = hasUnappliedPanelChanges;
window.revertLinkPanelValues = revertLinkPanelValues;
window.revertPanelValues = revertPanelValues;
window.swapLinkPanelEndpoints = swapLinkPanelEndpoints;
window.applyPlacementManager = applyPlacementManager;
window.applyViewForm = applyViewForm;
window.chooseFloorPlanFile = chooseFloorPlanFile;
window.finishFloorPlanAdjustMode = finishFloorPlanAdjustMode;
window.clearDataQualityFilters = clearDataQualityFilters;
window.closeBackupRestore = closeBackupRestore;
window.closeAccountManagement = closeAccountManagement;
window.closeLinkDisplaySettings = closeLinkDisplaySettings;
window.openPingResults = openPingResults;
window.closePingResults = closePingResults;
window.downloadPingResultsCsv = downloadPingResultsCsv;
window.closeDashboard = closeDashboard;
window.closeDataQuality = closeDataQuality;
window.closeDeviceSearchViewSelector = closeDeviceSearchViewSelector;
window.closeDevicesCsvImport = closeDevicesCsvImport;
window.closeFloorPlanManager = closeFloorPlanManager;
window.closeLedger = closeLedger;
window.clearLedgerSelection = clearLedgerSelection;
window.openLedgerBulkEdit = openLedgerBulkEdit;
window.closeLedgerBulkEdit = closeLedgerBulkEdit;
window.previewLedgerBulkEdit = previewLedgerBulkEdit;
window.backLedgerBulkEdit = backLedgerBulkEdit;
window.confirmLedgerBulkEdit = confirmLedgerBulkEdit;
window.closeLedgerDetailPane = closeLedgerDetailPane;
window.closeLedgerPlaceViewModal = closeLedgerPlaceViewModal;
window.confirmPlaceDevicesToView = confirmPlaceDevicesToView;
window.focusActiveDeviceOnCanvas = focusActiveDeviceOnCanvas;
window.manageActiveDevicePlacements = manageActiveDevicePlacements;
window.openLedgerDetail = openLedgerDetail;
window.openLedgerPlaceViewModal = openLedgerPlaceViewModal;
window.getLedgerSelectedDeviceIds = getLedgerSelectedDeviceIds;
window.closeLinkPanel = closeLinkPanel;
window.closeManagementConnectionDialog = closeManagementConnectionDialog;
window.closeManagementSshHelpDialog = closeManagementSshHelpDialog;
window.openManagementSshHelpDialog = openManagementSshHelpDialog;
window.openPingHelpDialog = openPingHelpDialog;
window.closePingHelpDialog = closePingHelpDialog;
window.closePanel = closePanel;
window.closePlacementManager = closePlacementManager;
window.closeViewManager = closeViewManager;
window.openSelectedViewFloorPlan = openSelectedViewFloorPlan;
window.commitBackupRestore = commitBackupRestore;
window.commitDevicesCsvImport = commitDevicesCsvImport;
window.confirmManagementConnection = confirmManagementConnection;
window.deleteCurrentFloorPlan = deleteCurrentFloorPlan;
window.deleteDevice = deleteDevice;
window.deleteDeviceCompletely = deleteDeviceCompletely;
window.deleteDeviceCompletelyFromPanel = deleteDeviceCompletelyFromPanel;
window.deleteEditingLink = deleteEditingLink;
window.deleteSelected = deleteSelected;
window.deleteSelectedLedgerDevicesCompletely = deleteSelectedLedgerDevicesCompletely;
window.deleteSelectedView = deleteSelectedView;
window.downloadDevicesCsvTemplate = downloadDevicesCsvTemplate;
window.duplicateSelectedView = duplicateSelectedView;
window.exportBackupZip = exportBackupZip;
window.exportDevicesCsv = exportDevicesCsv;
window.focusDevicePlacement = focusDevicePlacement;
window.getCurrentData = getCurrentData;
window.highlightDevicePlacement = highlightDevicePlacement;
window.jumpToManagementSettings = jumpToManagementSettings;
window.inspectDashboardModel = inspectDashboardModel;
window.loadData = loadData;
window.openBackupRestore = openBackupRestore;
window.openLinkDisplaySettings = openLinkDisplaySettings;
window.openLinkSystems = openLinkSystems;
window.closeLinkSystems = closeLinkSystems;
window.openPasswordChange = openPasswordChange;
window.openUserManagement = openUserManagement;
window.openDashboard = openDashboard;
window.openDataQuality = openDataQuality;
window.openDevicesCsvImport = openDevicesCsvImport;
window.openEditingDeviceManagement = openEditingDeviceManagement;
window.openFloorPlanManager = openFloorPlanManager;
window.openLedger = openLedger;
window.openPanel = openPanel;
window.openPlacementManager = openPlacementManager;
window.openPlacementManagerFromPanel = openPlacementManagerFromPanel;
window.openViewManager = openViewManager;
window.pingLedgerSelected = pingLedgerSelected;
window.pingSelected = pingSelected;
window.previewBackupRestore = previewBackupRestore;
window.previewDevicesCsvImport = previewDevicesCsvImport;
window.refreshDashboard = refreshDashboard;
window.refreshUserList = refreshUserList;
window.refreshDataQuality = refreshDataQuality;
window.reloadDataWithConfirmation = reloadDataWithConfirmation;
window.renderDevicesCsvImportRows = renderDevicesCsvImportRows;
window.renderLedgerTable = renderLedgerTable;
window.resetCurrentFloorPlanSettings = resetCurrentFloorPlanSettings;
window.resetLedgerFilters = resetLedgerFilters;
window.saveData = saveData;
window.saveLedger = saveLedger;
window.saveLedgerSheet = saveLedgerSheet;
window.reloadSelectedViewConflict = reloadSelectedViewConflict;
window.scheduleSave = scheduleSave;
window.flushSaveQueue = flushSaveQueue;
window.saveDeviceProperties = saveDeviceProperties;
window.selectDataQualitySeverity = selectDataQualitySeverity;
window.switchView = switchView;
window.setLedgerColumnPreset = setLedgerColumnPreset;
window.triggerDeviceImageUpload = triggerDeviceImageUpload;
window.closeDeviceImageZoom = closeDeviceImageZoom;
window.changeDeviceImageZoom = changeDeviceImageZoom;
window.toggleAllLedgerCheckboxes = toggleAllLedgerCheckboxes;
window.toggleFloorPlanAdjustMode = toggleFloorPlanAdjustMode;
window.toggleLinkMode = toggleLinkMode;
window.closeWiringControls = closeWiringControls;
window.uploadCurrentFloorPlan = uploadCurrentFloorPlan;
window.showDeviceInPlacement = showDeviceInPlacement;
window.showToast = showToast;
window.state = appState;
window.appState = appState;

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
