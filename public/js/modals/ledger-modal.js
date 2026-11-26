import { createLedgerBulkEdit } from './ledger-bulk-edit.js';
import { createLedgerDeviceSheet } from './ledger-device-sheet.js';
import { segmentCandidates } from '../core/ip-management.js';
/**
 * Netarium - modals/ledger-modal.js
 */

import {
    DEFAULT_DEVICE_HEIGHT,
    DEFAULT_DEVICE_WIDTH,
    DEFAULT_VIEW_PAN_X,
    DEFAULT_VIEW_PAN_Y,
    DEFAULT_VIEW_SCALE,
    DEVICE_TYPES
} from '../core/constants.js';
import { appState } from '../core/state.js';
import { eventBus } from '../core/event-bus.js';
import { validateDeviceValues } from '../core/device-validation.js';
import { getDeviceStatusLabel } from '../core/device-monitoring.js';
import { setInputError } from '../ui/field-errors.js';
import { bindLocationSuggestion } from '../ui/location-suggestions.js';
import { getPlacedDeviceIds, getDeviceDestinations, getRackDeviceMounts } from '../core/device-placement.js';
import { MAINTENANCE_EXPIRY_LABELS, classifyMaintenanceExpiry, getMaintenanceExpiryDate } from '../core/maintenance-expiry.js';
import { syncLedgerFilterPicker, closeLedgerFilterPickers } from '../ui/ledger-filter-picker.js';
import { populateFloorSelect, viewHierarchyPath } from '../core/building-hierarchy.js';
import { clearShareLinkFallback } from '../ui/share-link.js';
import { createDeviceTypePicker, closeDeviceTypePicker } from '../ui/device-type-picker.js';
import {
    isCurrentUserAdmin,
    requireAdminUiAction
} from '../ui/access-control.js';
import { doPing } from '../ui/toolbar.js';
import {
    enterPlacementMode
} from '../ui/placement-mode.js';
import {
    clampPosition
} from '../canvas/drag-drop.js';
import {
    apiFetch
} from '../core/api-client.js';
import {
    uniqueSortedValues
} from '../core/utils.js';
import {
    compareViews,
    getCurrentPlacements,
    getCurrentView,
    getDeviceById,
    getPlacementForDeviceInCurrentView,
    normalizeStatus
} from '../core/state.js';
import {
    render, focusDevicePlacement
} from '../canvas/renderer.js';
import {
    openPanel,
    deleteDeviceCompletely
} from '../ui/property-panel.js';
import {
    showToast, showStatusMessage
} from '../ui/toast.js';
import {
    markDirty
} from '../ui/status-bar.js';
import {
    flushSaveQueue, scheduleSave, updateSaveButtonState,
    hasResourceConflict, reloadConflictedResource, hasResourceChanges, isSaveInFlight,
    getPendingSave, waitForActiveResourceSave
} from '../core/save-queue.js';
import {
    getDeviceDraft, hasDeviceDraftChanges, commitDeviceDraft, commitDeviceDrafts, discardDeviceDraft
} from '../core/device-drafts.js';
import {
    openPlacementManager
} from './placement-modal.js';
import { openChangeHistory } from './change-history-modal.js';
import {
    confirmDataQualityNavigation,
    findDataQualityDevice,
    focusDataQualityTrigger,
    hideDataQualityForNavigation
} from './data-quality-modal.js';
import {
    registerModalClose,
    registerModalOpen
} from '../core/modal-focus.js';
import { closeBuildingView, getOpenBuildingId } from '../ui/building-view.js';

export const LEDGER_COLUMNS = [
    { key: 'select', label: '', stickyClass: 'ledger-sticky-check' },
    { key: 'id', label: 'ID', stickyClass: 'ledger-sticky-id' },
    { key: 'name', label: '名称', stickyClass: 'ledger-sticky-name' },
    { key: 'type', label: '種別' },
    { key: 'ip', label: 'IPアドレス' },
    { key: 'additional_ips', label: '追加IP' },
    { key: 'floor_id', label: '設置フロア' },
    { key: 'location', label: '設置場所' },
    { key: 'manufacturer', label: 'メーカー' },
    { key: 'model', label: '型番' },
    { key: 'asset_number', label: '管理番号' },
    { key: 'serial_number', label: 'シリアル番号' },
    { key: 'mac_address', label: 'MACアドレス' },
    { key: 'install_date', label: '導入年月' },
    { key: 'management_scheme', label: '接続方式' },
    { key: 'management_port', label: 'ポート' },
    { key: 'department', label: '担当部署' },
    { key: 'maintenance_vendor', label: '保守ベンダー' },
    { key: 'maintenance_expiry', label: '保守期限' },
    { key: 'status', label: '状態' },
    { key: 'last_checked_at', label: '最終確認' },
    { key: 'last_response_ms', label: '応答時間' },
    { key: 'last_error', label: 'エラー' },
    { key: 'memo', label: '備考' },
    { key: 'actions', label: '操作' }
];

const LEDGER_COLUMN_LABELS = new Map(LEDGER_COLUMNS.map(col => [col.key, col.label]));

function ledgerCellAriaLabel(device, key) {
    const deviceLabel = device.name || `ID ${device.id}`;
    const fieldLabel = LEDGER_COLUMN_LABELS.get(key) || key;
    return `${deviceLabel}の${fieldLabel}`;
}

export const LEDGER_PRESETS = {
    standard: ['select', 'id', 'name', 'type', 'ip', 'additional_ips', 'floor_id', 'location', 'status', 'actions'],
    placement: ['select', 'id', 'name', 'floor_id', 'location', 'actions'],
    asset: ['select', 'id', 'name', 'manufacturer', 'model', 'asset_number', 'serial_number', 'mac_address', 'install_date', 'actions'],
    maintenance: ['select', 'id', 'name', 'department', 'maintenance_vendor', 'maintenance_expiry', 'management_scheme', 'management_port', 'actions'],
    monitoring: ['select', 'id', 'name', 'ip', 'status', 'last_checked_at', 'last_response_ms', 'last_error', 'actions'],
    all: LEDGER_COLUMNS.map(c => c.key)
};

export const ledgerSelectedDeviceIds = new Set();
export let activeLedgerDeviceId = null;

let renderingLedgerTable = false;
let deletingSheetDevice = false;
let navigatingLedgerSheet = false;
let ledgerViewFilterIds = [];
let temporaryLedgerPreset = null;
let temporaryMaintenanceRange = null;

const {
    renderLedgerDeviceSheet, focusLedgerSheetField, triggerSheetImageUpload,
    commitSheetDraft, confirmSheetNavigation, confirmOpenPortsTab,
    isSheetTabBusy, openSheetConnection, clearSheetTabs, closeConfigMoreMenu, remapConfigDeviceId,
    getConfigLoadPromise, hasUnsavedSheetTabDraft, hasUnsavedPortDraft
} = createLedgerDeviceSheet({
    getActiveDeviceId: () => activeLedgerDeviceId,
    getAdjacentLedgerDeviceId,
    updateDraft,
    syncLedgerDraftButtons,
    showLedgerDestination,
    openDevice: openLedgerDetail
});
export { renderLedgerDeviceSheet, focusLedgerSheetField, triggerSheetImageUpload, getConfigLoadPromise, hasUnsavedPortDraft };

const LEDGER_FILTERS = [
    { key: 'viewIds', id: 'ledger-view-filter', label: '表示ビュー' },
    { key: 'buildingIds', id: 'ledger-building-filter', label: '建物' },
    { key: 'floorIds', id: 'ledger-floor-filter', label: 'フロア' },
    { key: 'status', id: 'ledger-status-filter', label: '状態' },
    { key: 'type', id: 'ledger-type-filter', label: '種別' },
    { key: 'ipPresence', id: 'ledger-ip-presence-filter', label: 'IP登録' },
    { key: 'placement', id: 'ledger-placement-filter', label: '配置状態' },
    { key: 'maintenanceExpiry', id: 'ledger-maintenance-expiry-filter', label: '保守期限' }
];

function selectedLedgerValues(id) {
    const select = document.getElementById(id);
    return Array.from(select?.selectedOptions || [], option => option.value).filter(Boolean);
}

function setLedgerSelectValues(id, values) {
    const select = document.getElementById(id);
    if (!select) return;
    const requested = new Set((Array.isArray(values) ? values : [values])
        .filter(value => value != null && value !== '').map(String));
    Array.from(select.options).forEach(option => { option.selected = requested.has(option.value); });
}

function setLedgerViewFilters(viewIds) {
    const nextIds = [...new Set(viewIds.map(Number))];
    setLedgerSelectValues('ledger-view-filter', nextIds);
    if (nextIds.length === ledgerViewFilterIds.length &&
        nextIds.every(id => ledgerViewFilterIds.includes(id))) return;
    ledgerViewFilterIds = nextIds;
    // 別のビューで選んだ機器を、一括編集へ持ち込まない。
    ledgerSelectedDeviceIds.clear();
}

function getLedgerFilteredViews() {
    const requested = selectedLedgerValues('ledger-view-filter').map(Number);
    const views = requested.map(id => appState.views.find(view => Number(view.id) === id)).filter(Boolean);
    const select = document.getElementById('ledger-view-filter');
    Array.from(select?.options || []).forEach(option => {
        const view = views.find(view => Number(view.id) === Number(option.value));
        if (view) option.textContent = `${view.name} (ID: ${view.id})`;
    });
    setLedgerViewFilters(views.map(view => Number(view.id)));
    if (views.length !== requested.length) {
        showStatusMessage('見つからないビューの条件を解除しました');
    }
    return views;
}

function updateLedgerViewFilterOptions(viewIds = selectedLedgerValues('ledger-view-filter')) {
    const views = new Map([...appState.views].sort(compareViews)
        .map(view => [String(view.id), `${view.name} (ID: ${view.id})`]));
    fillLedgerSelect('ledger-view-filter', [...views.keys()], id => views.get(id), false);
    const requested = (Array.isArray(viewIds) ? viewIds : [viewIds]).filter(id => id != null).map(String);
    const existing = requested.filter(id => views.has(id));
    setLedgerViewFilters(existing);
    if (existing.length !== requested.length) {
        showStatusMessage('見つからないビューの条件を解除しました');
    }
}

function updateDraft(scope, id, field, value) {
    if (!isCurrentUserAdmin() || appState.isPinging) return;
    const draft = getDeviceDraft(scope, id);
    if (!draft) return;
    if (field === 'ip' && draft.ip !== value) {
        const candidates = segmentCandidates(String(value ?? '').trim(), appState.ipSegments || []);
        draft.ip_segment_id = candidates.length === 1 ? Number(candidates[0].id) : null;
        delete draft.ip_conflicts_confirmed;
    }
    draft[field] = value;
    eventBus.emit('device-drafts:changed');
}

function bindLedgerDraftInput(input, device, field) {
    input.dataset.deviceId = String(device.id);
    input.dataset.field = field;
    input.addEventListener('input', () => {
        input.title = input.value;
        const nextValue = ['management_port', 'floor_id'].includes(field)
            ? (input.validity?.badInput
                ? 'invalid'
                : (input.value === '' ? null : Number(input.value)))
            : input.value;
        updateDraft('ledger', Number(input.dataset.deviceId), field, nextValue);
        showLedgerFieldErrors(Number(input.dataset.deviceId));
    });
    if (input.tagName === 'SELECT') {
        input.addEventListener('change', () => updateDraft('ledger', Number(input.dataset.deviceId), field,
            field === 'floor_id' ? (input.value === '' ? null : Number(input.value)) : input.value));
    }
}

function showLedgerFieldErrors(id, focus = false) {
    const draft = getDeviceDraft('ledger', id);
    if (!draft) return true;
    const { errors } = validateDeviceValues(draft);
    let first = null;
    document.querySelectorAll('#ledger-table-body [data-field]').forEach(input => {
        if (Number(input.dataset.deviceId) !== Number(id)) return;
        let error = document.getElementById(`ledger-${id}-${input.dataset.field}-error`);
        if (!error) {
            error = document.createElement('div');
            error.id = `ledger-${id}-${input.dataset.field}-error`;
            error.className = 'form-error';
            input.closest('td')?.appendChild(error);
        }
        setInputError(input, error, errors[input.dataset.field]);
        if (errors[input.dataset.field] && !first) first = input;
    });
    if (focus && first) first.focus();
    return Object.keys(errors).length === 0;
}

function commitLedgerRow(id) {
    if (!hasDeviceDraftChanges('ledger', id)) return true;
    try {
        if (hasResourceConflict('devices', id)) {
            throw new Error('この機器は競合しています。個票の「競合を再読込」で確認してください');
        }
        if (!showLedgerFieldErrors(id, true)) {
            const draft = getDeviceDraft('ledger', id);
            if (draft) {
                const { errors } = validateDeviceValues(draft);
                const hidden = [];
                for (const [field, message] of Object.entries(errors)) {
                    if (!document.querySelector(`#ledger-table-body [data-device-id="${id}"][data-field="${field}"]`)) {
                        hidden.push(message);
                    }
                }
                if (hidden.length) {
                    showToast(`台帳の入力を確認してください: ${hidden.join(', ')}`, 'warning');
                }
            }
            return false;
        }
        if (commitDeviceDraft('ledger', id)) {
            markDirty();
            scheduleSave({ immediate: true, silent: true });
            render();
        }
        return true;
    } catch (err) {
        showToast(`台帳の入力を確認してください: ${err.message}`, 'warning');
        return false;
    }
}

function commitLedgerDrafts({ allowDiscardConflicted = false } = {}) {
    try {
        let valid = true;
        const hiddenErrors = [];
        const conflictDraftIds = [];
        const editableDraftIds = [];
        for (const device of appState.devices) {
            const changed = hasDeviceDraftChanges('ledger', device.id);
            if (changed && hasResourceConflict('devices', device.id)) {
                conflictDraftIds.push(Number(device.id));
                continue;
            }
            editableDraftIds.push(device.id);
            if (!changed) continue;
            const draft = getDeviceDraft('ledger', device.id);
            if (!draft) continue;
            // IP重複はcommitDeviceDraftsで全下書きを統合した候補集合に対して検証する。
            const { errors } = validateDeviceValues(draft);
            if (Object.keys(errors).length) {
                showLedgerFieldErrors(device.id, valid);
                valid = false;
                for (const [field, message] of Object.entries(errors)) {
                    const fieldInput = document.querySelector(`#ledger-table-body [data-device-id="${device.id}"][data-field="${field}"]`);
                    if (!fieldInput) {
                        const name = device.name || `ID ${device.id}`;
                        hiddenErrors.push(`${name}: ${message}`);
                    }
                }
            }
        }
        if (!valid) {
            if (hiddenErrors.length) {
                showToast(`台帳の入力を確認してください: ${hiddenErrors.join(' / ')}`, 'warning');
            }
            return false;
        }
        if (conflictDraftIds.length > 0) {
            if (!allowDiscardConflicted) {
                throw new Error('この機器は競合しています。個票の「競合を再読込」で確認してください');
            }
            if (!window.confirm('競合している機器の未確定入力があります。競合機器の入力を破棄して台帳を閉じますか？')) return false;
        }
        if (commitDeviceDrafts('ledger', editableDraftIds)) {
            markDirty();
            scheduleSave({ immediate: true, silent: true });
            render();
        }
        return conflictDraftIds;
    } catch (err) {
        showToast(`台帳の入力を確認してください: ${err.message}`, 'warning');
        return false;
    }
}


function isConfirmedLedgerDevice(id) {
    if (id === null || id === undefined) return false;
    const device = getDeviceById(id);
    return Boolean(device) && Number.isSafeInteger(Number(device.id)) && Number(device.id) > 0 &&
        Number.isSafeInteger(Number(device.resource_revision)) && Number(device.resource_revision) > 0;
}

function syncLedgerDraftButtons() {
    const saveBtn = document.getElementById('ledger-sheet-save-btn');
    if (saveBtn) {
        saveBtn.dataset.deviceId = activeLedgerDeviceId === null ? '' : String(activeLedgerDeviceId);
    }
    updateSaveButtonState();
    const tabBusy = isSheetTabBusy();
    const prevBtn = document.getElementById('ledger-sheet-prev-btn');
    if (prevBtn) {
        prevBtn.disabled = appState.authExpired || navigatingLedgerSheet || tabBusy || getAdjacentLedgerDeviceId(-1) === null;
    }
    const nextBtn = document.getElementById('ledger-sheet-next-btn');
    if (nextBtn) {
        nextBtn.disabled = appState.authExpired || navigatingLedgerSheet || tabBusy || getAdjacentLedgerDeviceId(1) === null;
    }
    const closeBtn = document.getElementById('close-ledger-detail-pane-btn');
    if (closeBtn) {
        closeBtn.disabled = navigatingLedgerSheet || tabBusy;
    }
    const deleteBtn = document.getElementById('ledger-sheet-delete-btn');
    if (deleteBtn) {
        deleteBtn.hidden = !isCurrentUserAdmin();
        deleteBtn.disabled = !isCurrentUserAdmin() || appState.authExpired || appState.isPinging ||
            deletingSheetDevice || tabBusy || activeLedgerDeviceId === null || isSaveInFlight() ||
            appState.appStatus.state === 'unconfirmed' || hasResourceConflict('devices', activeLedgerDeviceId);
    }
    const historyBtn = document.getElementById('ledger-sheet-history-btn');
    if (historyBtn) {
        const confirmed = isConfirmedLedgerDevice(activeLedgerDeviceId);
        historyBtn.hidden = !isCurrentUserAdmin();
        historyBtn.disabled = !isCurrentUserAdmin() || appState.authExpired || tabBusy || !confirmed;
        historyBtn.title = confirmed
            ? 'この機器の変更履歴を表示します'
            : '保存が完了してから変更履歴を表示できます';
    }
}
eventBus.on('device-drafts:changed', syncLedgerDraftButtons);
eventBus.on('save-state:changed', syncLedgerDraftButtons);
eventBus.on('auth:expired', syncLedgerDraftButtons);

export function getLedgerSelectedDeviceIds() {
    return Array.from(ledgerSelectedDeviceIds);
}
export const LEDGER_COLUMN_PRESET_KEY = 'netarium_ledger_column_preset';

export function getActiveLedgerPreset() {
    if (temporaryLedgerPreset) return temporaryLedgerPreset;
    try {
        const saved = localStorage.getItem(LEDGER_COLUMN_PRESET_KEY);
        if (saved && Object.prototype.hasOwnProperty.call(LEDGER_PRESETS, saved)) {
            return saved;
        }
    } catch (_) {}
    return 'standard';
}

export function setLedgerColumnPreset(presetKey) {
    temporaryLedgerPreset = null;
    const validKey = Object.prototype.hasOwnProperty.call(LEDGER_PRESETS, presetKey)
        ? presetKey
        : 'standard';
    try {
        localStorage.setItem(LEDGER_COLUMN_PRESET_KEY, validKey);
    } catch (_) {}

    const select = document.getElementById('ledger-column-preset');
    if (select && select.value !== validKey) {
        select.value = validKey;
    }

    renderLedgerTableHeader();
    renderLedgerTable();
}

if (typeof window !== 'undefined') {
    window.setLedgerColumnPreset = setLedgerColumnPreset;
}

export function renderLedgerTableHeader() {
    const thead = document.getElementById('ledger-table')?.querySelector('thead');
    if (!thead) return;

    const presetKey = getActiveLedgerPreset();
    const activeColumns = LEDGER_PRESETS[presetKey] || LEDGER_PRESETS.standard;
    const columns = LEDGER_COLUMNS.filter(c => activeColumns.includes(c.key));
    const table = document.getElementById('ledger-table');
    const colgroup = document.getElementById('ledger-table-columns');
    if (table && colgroup) {
        table.dataset.columnPreset = presetKey;
        colgroup.replaceChildren();
        table.style.minWidth = '';
        if (presetKey !== 'all') {
            // 桁数の決まった項目と操作列は必要幅を確保し、残りを項目別の比率で配分する。
            const fixedWidths = {
                select: '44px', id: '64px', type: '193px', ip: 'calc(15ch + 31px)', additional_ips: '64px',
                mac_address: 'calc(17ch + 31px)', install_date: 'calc(10ch + 31px)',
                maintenance_expiry: 'calc(10ch + 31px)', management_scheme: '125px',
                management_port: '95px', status: '100px', last_response_ms: '107px',
                last_error: '80px', actions: isCurrentUserAdmin() ? '174px' : '76px'
            };
            if (presetKey === 'monitoring') {
                fixedWidths.name = '160px';
                fixedWidths.last_checked_at = 'calc(19ch + 17px)';
                delete fixedWidths.last_error;
            }
            const weights = { name: 160, floor_id: 220, location: 140, asset_number: 128, serial_number: 144, last_checked_at: 162 };
            const flexible = columns.filter(col => !fixedWidths[col.key]);
            const totalWeight = flexible.reduce((sum, col) => sum + (weights[col.key] || 120), 0);
            const fixedSum = columns.filter(col => fixedWidths[col.key]).map(col => fixedWidths[col.key]).join(' + ');
            const minimumFlexible = totalWeight * (presetKey === 'monitoring' ? 160 : 60) /
                Math.min(...flexible.map(col => weights[col.key] || 120));
            table.style.minWidth = `calc(${fixedSum} + ${Math.ceil(minimumFlexible)}px)`;
            columns.forEach(col => {
                const element = document.createElement('col');
                element.style.width = fixedWidths[col.key] ||
                    `calc((100% - (${fixedSum})) * ${(weights[col.key] || 120) / totalWeight})`;
                colgroup.appendChild(element);
            });
        }
    }

    const tr = document.createElement('tr');
    columns.forEach(col => {
        const th = document.createElement('th');
        th.dataset.column = col.key;
        if (col.stickyClass) {
            th.className = col.stickyClass;
        }
        if (col.key === 'select') {
            const masterCheckbox = document.createElement('input');
            masterCheckbox.id = 'ledger-select-all';
            masterCheckbox.type = 'checkbox';
            masterCheckbox.setAttribute('aria-label', 'すべて選択');
            masterCheckbox.addEventListener('click', () => toggleAllLedgerCheckboxes(masterCheckbox));
            th.appendChild(masterCheckbox);
        } else {
            th.textContent = col.label;
        }
        tr.appendChild(th);
    });

    thead.replaceChildren(tr);
}

function clearTemporaryLedgerPreset() {
    if (!temporaryLedgerPreset) return;
    temporaryLedgerPreset = null;
    const select = document.getElementById('ledger-column-preset');
    if (select) select.value = getActiveLedgerPreset();
    renderLedgerTableHeader();
}

export function openLedger({ preserveFilters = false } = {}) {
    if (!preserveFilters) setLedgerViewFilters([]);
    showLedger({ preserveFilters });
}

function showLedger({ preserveFilters = false, filters = null, fromDashboard = false } = {}) {
    const overlay =
        document.getElementById(
            'ledger-overlay'
        );

    if (!overlay) {
        showToast(
            '機器台帳画面が見つかりません',
            'error'
        );
        return;
    }

    closeLedgerFilterPickers();
    if (!preserveFilters) {
        temporaryLedgerPreset = null;
        temporaryMaintenanceRange = null;
    }

    updateLedgerFilters();
    if (filters) {
        applyLedgerOpeningFilters(filters);
        if (fromDashboard) {
            temporaryMaintenanceRange = filters.maintenanceRange ?? null;
            if (temporaryMaintenanceRange || selectedLedgerValues('ledger-maintenance-expiry-filter').length) {
                temporaryLedgerPreset = 'maintenance';
            }
        }
    }

    const activePreset = getActiveLedgerPreset();
    const presetSelect = document.getElementById('ledger-column-preset');
    if (presetSelect) {
        presetSelect.value = activePreset;
    }

    renderLedgerTableHeader();
    renderLedgerTable();
    updateLedgerSelectionUI();

    overlay.hidden = false;
    registerModalOpen('ledger', overlay, '#ledger-search', { onClose: closeLedger });
    if (preserveFilters) document.getElementById('ledger-search')?.focus();
    if (filters) window.requestAnimationFrame(() => document.getElementById('ledger-search')?.focus());
    updateSaveButtonState();
}

export function openLedgerWithFilters(filters = {}) {
    showLedger({ filters });
}

function applyLedgerOpeningFilters(filters) {
    const search = document.getElementById('ledger-search');
    if (search) search.value = String(filters.keyword || '');
    const values = {
        'ledger-building-filter': filters.buildingId,
        'ledger-floor-filter': filters.floorId,
        'ledger-status-filter': filters.status,
        'ledger-type-filter': filters.type,
        'ledger-ip-presence-filter': filters.ipPresence,
        'ledger-placement-filter': filters.placement,
        'ledger-maintenance-expiry-filter': filters.maintenanceExpiry
    };
    Object.entries(values).forEach(([id, value]) => setLedgerSelectValues(id, value));
    updateLedgerViewFilterOptions(filters.viewId ?? []);
    appState.ledgerSearchHighlightDeviceId = null;
}


export async function closeLedger() {
    if (!closeLedgerBulkEdit()) return false;
    const conflictDraftIds = commitLedgerDrafts({ allowDiscardConflicted: true });
    if (!conflictDraftIds) return false;
    if (!await closeLedgerDetailPane()) return false;
    for (const id of conflictDraftIds) discardDeviceDraft('ledger', id);
    closeLedgerFilterPickers();
    closeDeviceTypePicker();
    temporaryMaintenanceRange = null;
    clearTemporaryLedgerPreset();
    const overlay = document.getElementById('ledger-overlay');
    if (overlay) overlay.hidden = true;
    registerModalClose('ledger');
    appState.ledgerSearchHighlightDeviceId = null;
    return true;
}

export function dismissLedgerPopups() {
    const closedDeviceType = closeDeviceTypePicker();
    const closedFilter = closeLedgerFilterPickers();
    const closedConfigMenu = closeConfigMoreMenu();
    return Boolean(closedDeviceType || closedFilter || closedConfigMenu);
}

export function getLedgerDeviceTypeLabel(
    type
) {
    const normalizedType =
        String(type || '');

    const labels = {
        router: 'ルーター',
        switch: DEVICE_TYPES.switch.label,
        l3_switch: DEVICE_TYPES.l3_switch.label,
        firewall: DEVICE_TYPES.firewall.label,
        ap: 'アクセスポイント',
        server: 'サーバー',
        pc: DEVICE_TYPES.pc.label,
        printer: 'プリンタ・複合機',
        other: 'その他'
    };

    return labels[normalizedType] ||
        normalizedType ||
        '未設定';
}


export function updateLedgerFilters() {
    updateLedgerViewFilterOptions();
    fillLedgerSelect('ledger-maintenance-expiry-filter', Object.keys(MAINTENANCE_EXPIRY_LABELS),
        key => MAINTENANCE_EXPIRY_LABELS[key], false);
    const buildings = new Map((appState.buildings || []).map(row => [String(row.id), row.name]));
    fillLedgerSelect('ledger-building-filter', ['unset', ...buildings.keys()],
        id => id === 'unset' ? '未設定' : buildings.get(id), false);
    const floors = new Map((appState.floors || []).map(row =>
        [String(row.id), viewHierarchyPath({ floor_id: row.id }, appState)]));
    fillLedgerSelect('ledger-floor-filter', ['unset', ...floors.keys()],
        id => id === 'unset' ? '未設定' : floors.get(id), false);

    const typeOrder = Object.keys(DEVICE_TYPES);
    const typeCandidates = [...new Set([
        ...uniqueSortedValues(appState.devices, 'type'),
        ...selectedLedgerValues('ledger-type-filter')
    ])];
    typeCandidates.sort((a, b) => {
        const aIndex = typeOrder.indexOf(a);
        const bIndex = typeOrder.indexOf(b);
        return (aIndex < 0 ? typeOrder.length : aIndex) -
            (bIndex < 0 ? typeOrder.length : bIndex) || a.localeCompare(b, 'ja');
    });
    fillLedgerSelect(
        'ledger-type-filter',
        typeCandidates,
        getLedgerDeviceTypeLabel
    );
}



function fillLedgerSelect(selectId, values, getLabel = null, preserveMissing = true) {
    const select = document.getElementById(selectId);
    if (!select) return;
    const selected = selectedLedgerValues(selectId);
    const candidates = preserveMissing ? [...new Set([...values, ...selected])] : values;
    select.replaceChildren();
    candidates.forEach(value => {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = getLabel ? getLabel(value) : value;
        option.selected = selected.includes(value);
        select.appendChild(option);
    });
}




export function getLedgerFilterValues() {
    const views = getLedgerFilteredViews();
    const filters = {
        keyword: document.getElementById('ledger-search')?.value.trim().toLocaleLowerCase('ja') || ''
    };
    LEDGER_FILTERS.forEach(({ key, id }) => {
        filters[key] = key === 'viewIds' ? views.map(view => Number(view.id)) : selectedLedgerValues(id);
    });
    return filters;
}


export function getFilteredLedgerDevices() {
    const filters =
        getLedgerFilterValues();
    const placedIds = getPlacedDeviceIds(appState.placements, getRackDeviceMounts(appState));
    const viewIds = new Set(filters.viewIds);
    const viewDeviceIds = viewIds.size ? getPlacedDeviceIds(
        appState.placements.filter(placement => viewIds.has(Number(placement.view_id))),
        getRackDeviceMounts(appState).filter(mount => viewIds.has(Number(mount.view_id)))
    ) : null;

    const referenceDate = new Date();
    const floorsById = new Map((appState.floors || []).map(row => [Number(row.id), row]));
    const buildingIds = filters.buildingIds.length
        ? new Set((appState.buildings || []).map(row => String(row.id))) : null;
    const devices = appState.devices.filter(device => {
        if (viewDeviceIds && !viewDeviceIds.has(Number(device.id))) return false;
        const floor = device.floor_id == null ? null : floorsById.get(Number(device.floor_id));
        const floorId = floor ? String(floor.id) : 'unset';
        if (buildingIds) {
            const id = String(floor?.building_id);
            if (!filters.buildingIds.includes(buildingIds.has(id) ? id : 'unset')) return false;
        }
        if (filters.floorIds.length && !filters.floorIds.includes(floorId)) return false;
        const deviceStatus = normalizeStatus(device.status);
        const filterStatus = deviceStatus === 'checking' ? 'unknown' : deviceStatus;
        if (filters.status.length && !filters.status.includes(filterStatus)) return false;
        if (filters.type.length && !filters.type.includes(String(device.type || ''))) return false;

        const hasIp = String(device.ip || '').trim() !== '';
        if (filters.ipPresence.length && !filters.ipPresence.includes(hasIp ? 'registered' : 'empty')) return false;
        const isPlaced = placedIds.has(Number(device.id));
        if (filters.placement.length && !filters.placement.includes(isPlaced ? 'placed' : 'unplaced')) return false;
        if (filters.maintenanceExpiry.length &&
            !filters.maintenanceExpiry.includes(classifyMaintenanceExpiry(device.maintenance_expiry, referenceDate))) return false;

        if (!filters.keyword) {
            return true;
        }

        const searchable = [
            device.id,
            device.name,
            device.type,
            getLedgerDeviceTypeLabel(
                device.type
            ),
            device.ip,
            ...(device.additional_ips || []).flatMap(row => [row.ip, row.label]),
            viewHierarchyPath(device, appState),
            device.location,
            device.manufacturer,
            device.model,
            device.asset_number,
            device.serial_number,
            device.mac_address,
            device.memo,
            device.management_scheme,
            device.management_port,
            device.department,
            device.maintenance_vendor,
            device.install_date,
            device.maintenance_expiry
        ]
            .map(value =>
                String(value || '')
                    .toLocaleLowerCase(
                        'ja'
                    )
            )
            .join('\n');

        return searchable.includes(
            filters.keyword
        );
    });
    if (!temporaryMaintenanceRange && !filters.maintenanceExpiry.length) return devices;

    const dated = [];
    for (const device of devices) {
        const date = getMaintenanceExpiryDate(device.maintenance_expiry);
        if (temporaryMaintenanceRange) {
            const { start, end } = temporaryMaintenanceRange;
            if (!date || date < start || (end !== null && date > end)) continue;
        }
        dated.push({ device, date });
    }
    // 年月だけの期限は月末として比較し、未設定は末尾。同期限では元の機器順を保つ。
    return dated
        .sort((a, b) => (a.date ?? '9999-99-99').localeCompare(b.date ?? '9999-99-99'))
        .map(({ device }) => device);
}




export function getLedgerActiveFilterItems() {
    const filters = getLedgerFilterValues();
    const items = [];
    LEDGER_FILTERS.forEach(({ key, id, label }) => {
        const options = Array.from(document.getElementById(id)?.options || []);
        filters[key].forEach(value => {
            const option = options.find(option => option.value === String(value));
            items.push({ key, value, label: `${label}: ${option?.textContent || value}` });
        });
    });
    if (temporaryMaintenanceRange) {
        const { label } = temporaryMaintenanceRange;
        items.push({ key: 'maintenanceRange', value: label, label: `保守期限: ${label}` });
    }
    if (filters.keyword) items.push({ key: 'keyword', value: filters.keyword, label: `検索: ${filters.keyword}` });
    return items;
}


function changeLedgerMaintenanceExpiryFilter() {
    temporaryMaintenanceRange = null;
    renderLedgerTable();
}

export function renderLedgerActiveFilters() {
    LEDGER_FILTERS.forEach(({ key, id, label }) => {
        const select = document.getElementById(id);
        if (select) syncLedgerFilterPicker(select, label,
            key === 'maintenanceExpiry' ? changeLedgerMaintenanceExpiryFilter : renderLedgerTable);
    });
    const container =
        document.getElementById(
            'ledger-active-filters'
        );

    const list =
        document.getElementById(
            'ledger-active-filter-list'
        );

    const resetButton =
        document.getElementById(
            'ledger-filter-reset-btn'
        );

    if (!container || !list) {
        return;
    }

    const items =
        getLedgerActiveFilterItems();

    list.replaceChildren();

    items.forEach(item => {
        const chip =
            document.createElement(
                'span'
            );

        chip.className =
            'ledger-filter-chip';

        chip.textContent =
            item.label;
        const clear = document.createElement('button');
        clear.type = 'button';
        clear.textContent = '×';
        clear.setAttribute('aria-label', `${item.label} の条件を解除`);
        clear.title = `${item.label} の条件を解除`;
        clear.addEventListener('click', () => {
            if (item.key === 'keyword') {
                document.getElementById('ledger-search').value = '';
            } else if (item.key === 'maintenanceRange') {
                temporaryMaintenanceRange = null;
            } else {
                const { id } = LEDGER_FILTERS.find(filter => filter.key === item.key);
                const values = selectedLedgerValues(id).filter(value => value !== String(item.value));
                if (item.key === 'viewIds') setLedgerViewFilters(values);
                else setLedgerSelectValues(id, values);
            }
            renderLedgerTable();
            document.getElementById('ledger-search')?.focus();
        });
        chip.appendChild(clear);

        list.appendChild(chip);
    });

    container.hidden =
        items.length === 0;

    if (resetButton) {
        resetButton.disabled =
            items.length === 0;
    }
}


export function resetLedgerFilters() {
    closeLedgerFilterPickers();
    temporaryMaintenanceRange = null;
    setLedgerViewFilters([]);
    LEDGER_FILTERS.forEach(({ id }) => setLedgerSelectValues(id, []));
    const search = document.getElementById('ledger-search');
    if (search) search.value = '';

    appState.ledgerSearchHighlightDeviceId =
        null;

    renderLedgerTable();

    document
        .getElementById(
            'ledger-search'
        )
        ?.focus();
}


export function renderLedgerTable() {
    const tbody = document.getElementById('ledger-table-body');

    if (!tbody) {
        return;
    }
    if (!temporaryMaintenanceRange && !selectedLedgerValues('ledger-maintenance-expiry-filter').length) {
        clearTemporaryLedgerPreset();
    }

    const activeEl = typeof document !== 'undefined' ? document.activeElement : null;
    let focusedFieldInfo = null;
    if (activeEl && tbody.contains(activeEl)) {
        const deviceId = activeEl.dataset?.deviceId || activeEl.closest('tr')?.dataset?.deviceId;
        const field = activeEl.dataset?.field;
        if (deviceId && field) {
            focusedFieldInfo = {
                deviceId: String(deviceId),
                field: String(field),
                selectionStart: typeof activeEl.selectionStart === 'number' ? activeEl.selectionStart : null,
                selectionEnd: typeof activeEl.selectionEnd === 'number' ? activeEl.selectionEnd : null,
            };
        }
    }

    const filteredDevices = getFilteredLedgerDevices();

    renderingLedgerTable = true;
    try {
        closeDeviceTypePicker();
        tbody.replaceChildren();
        filteredDevices.forEach(device => {
            tbody.appendChild(createLedgerRow(device));
            if (hasDeviceDraftChanges('ledger', device.id)) showLedgerFieldErrors(device.id);
        });
    } finally {
        renderingLedgerTable = false;
    }

    if (focusedFieldInfo) {
        const targetRow = tbody.querySelector(`tr[data-device-id="${focusedFieldInfo.deviceId}"]`);
        if (targetRow) {
            const targetInput = targetRow.querySelector(`[data-field="${focusedFieldInfo.field}"]`);
            if (targetInput) {
                targetInput.focus();
                if (focusedFieldInfo.selectionStart !== null && typeof targetInput.setSelectionRange === 'function') {
                    try {
                        targetInput.setSelectionRange(focusedFieldInfo.selectionStart, focusedFieldInfo.selectionEnd);
                    } catch (_) {}
                }
            }
        }
    }

    const count = document.getElementById('ledger-count');

    if (count) {
        count.textContent =
            `${filteredDevices.length} / ${appState.devices.length}件`;
    }

    renderLedgerActiveFilters();
    updateLedgerSelectionUI();
}


export function createLedgerSelectCell(device) {
    const td = document.createElement('td');
    td.className = 'ledger-sticky-check';
    const label = document.createElement('label');
    label.className = 'ledger-select-cell-label';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'ledger-row-checkbox';
    checkbox.dataset.deviceId = String(device.id);
    checkbox.checked = ledgerSelectedDeviceIds.has(Number(device.id));
    checkbox.setAttribute(
        'aria-label',
        `${device.name || `ID ${device.id}`}を選択`
    );
    const syncSelection = () => {
        const id = Number(checkbox.dataset.deviceId);
        if (checkbox.checked) {
            ledgerSelectedDeviceIds.add(id);
        } else {
            ledgerSelectedDeviceIds.delete(id);
        }
        const row = td.closest('tr');
        if (row) {
            row.classList.toggle('ledger-row-selected', checkbox.checked);
        }
        updateLedgerSelectionUI();
    };
    checkbox.addEventListener('change', event => {
        event.stopPropagation();
        syncSelection();
    });
    td.addEventListener('click', event => {
        event.stopPropagation();
        if (event.target === td || !event.target.closest('label')) {
            checkbox.checked = !checkbox.checked;
            syncSelection();
        }
    });
    td.addEventListener('dblclick', event => {
        event.stopPropagation();
    });
    label.appendChild(checkbox);
    td.appendChild(label);
    return td;
}

export function createLedgerManagementSchemeCell(device) {
    const td = document.createElement('td');
    const select = document.createElement('select');
    select.dataset.field = 'management_scheme';
    select.setAttribute('aria-label', ledgerCellAriaLabel(device, 'management_scheme'));
    select.disabled = !isCurrentUserAdmin();
    const options = [
        { value: '', label: '未設定' },
        { value: 'https', label: 'HTTPS' },
        { value: 'http', label: 'HTTP' },
        { value: 'ssh', label: 'SSH' },
    ];

    options.forEach(opt => {
        const option = document.createElement('option');
        option.value = opt.value;
        option.textContent = opt.label;
        if (String(device.management_scheme || '') === opt.value) {
            option.selected = true;
        }
        select.appendChild(option);
    });

    bindLedgerDraftInput(select, device, 'management_scheme');

    td.appendChild(select);
    return td;
}

export function createLedgerManagementPortCell(device) {
    const td = document.createElement('td');
    const input = document.createElement('input');
    input.dataset.field = 'management_port';
    input.setAttribute('aria-label', ledgerCellAriaLabel(device, 'management_port'));
    input.type = 'number';
    input.max = '65535';
    input.step = '1';
    input.value = device.management_port != null ? String(device.management_port) : '';
    input.readOnly = !isCurrentUserAdmin();
    if (input.readOnly) {
        input.title = '閲覧専用です';
    }

    bindLedgerDraftInput(input, device, 'management_port');

    td.appendChild(input);
    return td;
}

export function createLedgerRow(device) {
    device = getDeviceDraft('ledger', device.id) || device;
    const tr = document.createElement('tr');
    tr.dataset.deviceId = String(device.id);
    tr.addEventListener('focusout', event => {
        if (renderingLedgerTable) return;
        const nextRow = event.relatedTarget?.closest?.('#ledger-table-body tr[data-device-id]');
        if (nextRow && Number(nextRow.dataset.deviceId) === Number(tr.dataset.deviceId)) return;
        if (!commitLedgerRow(Number(tr.dataset.deviceId))) event.target?.focus?.();
    });

    if (
        Number(device.id) ===
        Number(appState.ledgerSearchHighlightDeviceId)
    ) {
        tr.classList.add('search-highlight');
    }

    if (ledgerSelectedDeviceIds.has(Number(device.id))) {
        tr.classList.add('ledger-row-selected');
    }

    if (activeLedgerDeviceId === Number(device.id)) {
        tr.classList.add('ledger-row-active');
    }

    const presetKey = getActiveLedgerPreset();
    const activeColumns = LEDGER_PRESETS[presetKey] || LEDGER_PRESETS.standard;
    const columns = LEDGER_COLUMNS.filter(c => activeColumns.includes(c.key));

    columns.forEach(col => {
        let cell;
        switch (col.key) {
            case 'select':
                cell = createLedgerSelectCell(device);
                break;
            case 'id':
                cell = createLedgerTextCell(device.id);
                cell.classList.add('ledger-sticky-id');
                break;
            case 'name':
                cell = createLedgerInputCell(device, 'name', 100);
                cell.classList.add('ledger-sticky-name');
                break;
            case 'type':
                cell = createLedgerTypeCell(device);
                break;
            case 'ip':
                cell = createLedgerInputCell(device, 'ip', 45);
                break;
            case 'additional_ips': {
                const count = device.additional_ips?.length || 0;
                cell = document.createElement('td');
                cell.textContent = count ? `${count}件` : '—';
                break;
            }
            case 'floor_id': {
                cell = document.createElement('td');
                const select = document.createElement('select');
                select.setAttribute('aria-label', ledgerCellAriaLabel(device, 'floor_id'));
                populateFloorSelect(select, appState, device.floor_id);
                select.disabled = !isCurrentUserAdmin();
                bindLedgerDraftInput(select, device, 'floor_id');
                cell.appendChild(select);
                break;
            }
            case 'location':
                cell = createLedgerInputCell(device, 'location', 150);
                break;
            case 'manufacturer':
                cell = createLedgerInputCell(device, 'manufacturer', 100);
                break;
            case 'model':
                cell = createLedgerInputCell(device, 'model', 100);
                break;
            case 'asset_number':
                cell = createLedgerInputCell(device, 'asset_number', 100);
                break;
            case 'serial_number':
                cell = createLedgerInputCell(device, 'serial_number', 100);
                break;
            case 'mac_address':
                cell = createLedgerInputCell(device, 'mac_address', 50);
                break;
            case 'install_date':
                cell = createLedgerInputCell(device, 'install_date', 10);
                break;
            case 'management_scheme':
                cell = createLedgerManagementSchemeCell(device);
                break;
            case 'management_port':
                cell = createLedgerManagementPortCell(device);
                break;
            case 'department':
                cell = createLedgerInputCell(device, 'department', 100);
                break;
            case 'maintenance_vendor':
                cell = createLedgerInputCell(device, 'maintenance_vendor', 100);
                break;
            case 'maintenance_expiry':
                cell = createLedgerInputCell(device, 'maintenance_expiry', 10);
                break;
            case 'status':
                cell = createLedgerStatusCell(device.status);
                break;
            case 'last_checked_at':
                cell = createLedgerTextCell(device.last_checked_at || '-');
                break;
            case 'last_response_ms':
                cell = createLedgerTextCell(device.last_response_ms == null ? '-' : `${device.last_response_ms} ms`);
                break;
            case 'last_error':
                cell = createLedgerErrorCell(device);
                break;
            case 'memo':
                cell = createLedgerTextareaCell(device, 'memo', 1000);
                break;
            case 'actions':
                cell = createLedgerPlacementActionCell(device);
                break;
            default:
                cell = createLedgerTextCell('');
        }
        cell.dataset.column = col.key;
        tr.appendChild(cell);
    });

    tr.addEventListener('click', async event => {
        if (
            event.target instanceof HTMLInputElement ||
            event.target instanceof HTMLSelectElement ||
            event.target instanceof HTMLTextAreaElement ||
            event.target instanceof HTMLButtonElement ||
            event.target.closest('button') ||
            event.target.closest('input') ||
            event.target.closest('select') ||
            event.target.closest('textarea') ||
            event.target.closest('details') ||
            event.target.closest('.ledger-sticky-check')
        ) {
            return;
        }
        await openLedgerDetail(Number(tr.dataset.deviceId));
    });

    tr.addEventListener('dblclick', async event => {
        if (
            event.target instanceof HTMLInputElement ||
            event.target instanceof HTMLSelectElement ||
            event.target instanceof HTMLTextAreaElement ||
            event.target.closest('button') ||
            event.target.closest('details') ||
            event.target.closest('.ledger-sticky-check')
        ) {
            return;
        }
        await openLedgerDetail(Number(tr.dataset.deviceId));
    });

    return tr;
}


export function createLedgerPlacementActionCell(
    device
) {
    const td = document.createElement('td');
    td.className = 'ledger-actions-cell';
    const actions = document.createElement('div');
    actions.className = 'ledger-row-actions';

    // 詳細ボタン（台帳内詳細ペインを開く）
    const detailBtn = document.createElement('button');
    detailBtn.type = 'button';
    detailBtn.className = 'btn btn-secondary btn-sm ledger-action-btn';
    detailBtn.textContent = '詳細';
    detailBtn.setAttribute('aria-label', `${device.name || `ID ${device.id}`}の詳細を開く`);
    detailBtn.addEventListener('click', async event => {
        event.stopPropagation();
        const targetId = Number(detailBtn.closest('tr')?.dataset.deviceId ?? device.id);
        if (!hasResourceConflict('devices', targetId) && !commitLedgerRow(targetId)) return;
        await openLedgerDetail(targetId);
    });
    actions.appendChild(detailBtn);

    if (isCurrentUserAdmin()) {
        const placementBtn = document.createElement('button');
        placementBtn.type = 'button';
        placementBtn.className = 'btn btn-secondary btn-sm ledger-action-btn';
        placementBtn.textContent = '表示ビュー';
        placementBtn.setAttribute('aria-label', `${device.name || `ID ${device.id}`}の表示ビューを選択`);
        placementBtn.dataset.deviceId = String(device.id);
        placementBtn.dataset.ledgerAction = 'placement';
        placementBtn.addEventListener('click', async event => {
            event.stopPropagation();
            if (!await confirmSheetNavigation()) return;
            await openPlacementManager(Number(placementBtn.dataset.deviceId));
        });
        actions.appendChild(placementBtn);
    }
    td.appendChild(actions);

    return td;
}




export function createLedgerTextCell(value) {
    const td = document.createElement('td');
    const text = String(value ?? '');
    const content = document.createElement('div');
    content.className = 'ledger-text-value';
    content.textContent = text;
    td.appendChild(content);
    td.title = text;
    return td;
}


export function createLedgerInputCell(device, key, maxLength) {
    const td = document.createElement('td');
    const input = document.createElement('input');

    const val = String(device[key] || '');
    input.type = 'text';
    input.value = val;
    input.dataset.originalValue = val.trim();
    input.dataset.maxLength = String(maxLength);
    input.dataset.field = key;
    input.setAttribute('aria-label', ledgerCellAriaLabel(device, key));

    /*
     * 一般ユーザーは台帳を閲覧専用にする。
     */
    input.readOnly =
        !isCurrentUserAdmin();

    if (input.readOnly) {
        input.title = val ? `${val} (閲覧専用)` : '閲覧専用です';
    } else {
        input.title = val;
    }

    bindLedgerDraftInput(input, device, key);
    bindLocationSuggestion(input, key);



    td.appendChild(input);
    return td;
}


export function createLedgerTextareaCell(device, key, maxLength) {
    const td = document.createElement('td');
    const textarea = document.createElement('textarea');

    const val = String(device[key] || '');
    textarea.value = val;
    textarea.dataset.maxLength = String(maxLength);
    textarea.rows = 2;
    textarea.dataset.field = key;
    textarea.setAttribute('aria-label', ledgerCellAriaLabel(device, key));

    textarea.readOnly =
        !isCurrentUserAdmin();

    if (textarea.readOnly) {
        textarea.title = val ? `${val} (閲覧専用)` : '閲覧専用です';
    } else {
        textarea.title = val;
    }

    bindLedgerDraftInput(textarea, device, key);

    td.appendChild(textarea);
    return td;
}



function createLedgerErrorCell(device) {
    const td = document.createElement('td');
    if (!device.last_error) {
        td.textContent = '—';
        return td;
    }
    const details = document.createElement('details');
    details.className = 'ledger-error-details';
    const summary = document.createElement('summary');
    summary.className = 'btn btn-tertiary btn-sm';
    summary.tabIndex = 0;
    summary.textContent = '詳細';
    summary.setAttribute('aria-label', `${device.name || '（名称なし）'}のエラー詳細`);
    const text = document.createElement('p');
    text.textContent = String(device.last_error);
    details.append(summary, text);
    td.appendChild(details);
    return td;
}

export function createLedgerTypeCell(device) {
    const td = document.createElement('td');
    const { element, control } = createDeviceTypePicker({
        deviceId: device.id,
        value: device.type,
        disabled: !isCurrentUserAdmin() || appState.isPinging || appState.authExpired,
        onChange: input => updateDraft('ledger', Number(input.dataset.deviceId), 'type', input.value)
    });
    bindLedgerDraftInput(control, device, 'type');
    td.appendChild(element);
    return td;
}




export function createLedgerStatusCell(status) {
    const td = document.createElement('td');
    const badge = document.createElement('span');
    const normalizedStatus = normalizeStatus(status);

    badge.className =
        `ledger-status ledger-status-pill ledger-status-${normalizedStatus}`;

    const label = document.createElement('span');
    label.textContent = getDeviceStatusLabel(normalizedStatus);
    if (normalizedStatus === 'green' || normalizedStatus === 'red') {
        const symbol = document.createElement('span');
        symbol.setAttribute('aria-hidden', 'true');
        symbol.textContent = normalizedStatus === 'green' ? '✓' : '×';
        badge.appendChild(symbol);
    }
    badge.appendChild(label);

    td.appendChild(badge);
    return td;
}

/**
 * DB上の正式データをダウンロードする。
 *
 * apiFetch()はJSON専用なので使用しない。
 */

export async function saveLedger() {
    if (!requireAdminUiAction()) return false;
    if (!commitLedgerDrafts()) return false;
    const saved = await flushSaveQueue({ silent: false });
    if (saved) {
        updateLedgerFilters();
        renderLedgerTable();
    }
    return saved;
}

/**
 * 機器個票モーダルから編集内容をサーバーへ保存する
 */
export async function saveLedgerSheet() {
    if (!requireAdminUiAction() || activeLedgerDeviceId === null) return false;
    if (hasResourceConflict('devices', activeLedgerDeviceId)) {
        const id = activeLedgerDeviceId;
        const reloaded = await reloadConflictedResource('devices', id);
        if (reloaded && activeLedgerDeviceId === id) {
            const device = getDeviceById(id);
            if (device) renderLedgerDeviceSheet(device);
        }
        syncLedgerDraftButtons();
        return reloaded;
    }
    if (!commitSheetDraft()) return false;
    const saved = await flushSaveQueue({ silent: false });
    if (saved) {
        updateLedgerFilters();
        renderLedgerTable();
    }
    syncLedgerDraftButtons();
    return saved;
}


export async function selectDeviceFromLedger(
    deviceId
) {
    const device =
        getDeviceById(deviceId);

    if (!device) {
        return;
    }
    const mount = getRackDeviceMounts(appState).find(row => Number(row.device_id) === Number(deviceId));
    if (mount && (!getPlacementForDeviceInCurrentView(deviceId) || getCurrentView()?.view_type === 'rack')) {
        if (!await closeLedger()) return;
        eventBus.emit('rack:show-device', { deviceId: Number(deviceId), viewId: Number(mount.view_id) });
        return;
    }

    const placement =
        getPlacementForDeviceInCurrentView(
            deviceId
        );

    if (!placement) {
        showToast(
            'この機器は現在のビューに配置されていません',
            'warning'
        );
        return;
    }

    if (!await closeLedger()) return;
    if (!await openPanel(device)) return;

    appState.selectedPlacementIds.clear();
    appState.selectedPlacementIds.add(
        Number(placement.id)
    );


    render();
}


export function openLedgerForSearchedDevice(
    deviceId
) {
    appState.ledgerSearchHighlightDeviceId =
        Number(deviceId);

    const searchInput =
        document.getElementById(
            'ledger-search'
        );

    if (searchInput) {
        searchInput.value = '';
    }

    const buildingFilter =
        document.getElementById(
            'ledger-building-filter'
        );

    const floorFilter =
        document.getElementById(
            'ledger-floor-filter'
        );

    const statusFilter =
        document.getElementById(
            'ledger-status-filter'
        );

    const typeFilter =
        document.getElementById(
            'ledger-type-filter'
        );

    const ipPresenceFilter =
        document.getElementById(
            'ledger-ip-presence-filter'
        );

    const placementFilter =
        document.getElementById(
            'ledger-placement-filter'
        );

    if (buildingFilter) {
        buildingFilter.value = '';
    }

    if (floorFilter) {
        floorFilter.value = '';
    }

    if (statusFilter) {
        statusFilter.value = '';
    }

    if (typeFilter) {
        typeFilter.value = '';
    }

    if (ipPresenceFilter) {
        ipPresenceFilter.value = '';
    }

    if (placementFilter) {
        placementFilter.value = '';
    }
    setLedgerSelectValues('ledger-maintenance-expiry-filter', []);

    openLedger();

    window.requestAnimationFrame(
        () => {
            const row =
                document.querySelector(
                    `#ledger-table-body tr[data-device-id="${Number(
                        deviceId
                    )}"]`
                );

            if (!row) {
                return;
            }

            row.classList.add(
                'search-highlight'
            );

            row.scrollIntoView({
                block: 'center',
                inline: 'nearest'
            });

            window.setTimeout(
                () => {
                    row.classList.remove(
                        'search-highlight'
                    );
                },
                2400
            );
        }
    );
}



/**
 * 台帳の全選択チェックボックス切り替え
 */
export function toggleAllLedgerCheckboxes(
    masterCheckbox
) {
    if (appState.isPinging) {
        masterCheckbox.checked = false;
        return;
    }

    const checkboxes =
        document.querySelectorAll(
            '#ledger-table-body ' +
            '.ledger-row-checkbox'
        );

    checkboxes.forEach(checkbox => {
        checkbox.checked = masterCheckbox.checked;
        const id = Number(checkbox.dataset.deviceId);
        if (masterCheckbox.checked) {
            ledgerSelectedDeviceIds.add(id);
        } else {
            ledgerSelectedDeviceIds.delete(id);
        }
        const row = checkbox.closest('tr');
        if (row) {
            row.classList.toggle('ledger-row-selected', masterCheckbox.checked);
        }
    });

    updateLedgerSelectionUI();
}


/**
 * 機器台帳でチェックされた機器をまとめて完全削除する
 */
export async function deleteSelectedLedgerDevicesCompletely() {
    if (!requireAdminUiAction()) {
        return;
    }
    if (appState.authExpired || appState.appStatus?.state === 'unconfirmed' || isSaveInFlight()) {
        showToast('現在の状態では削除できません。保存やログイン状態を確認してください', 'warning');
        return;
    }
    const deviceIds = Array.from(ledgerSelectedDeviceIds);

    if (deviceIds.length === 0) {
        showToast('削除する機器を選択してください', 'warning');
        return;
    }

    if (activeLedgerDeviceId !== null && deviceIds.includes(activeLedgerDeviceId) && !await confirmSheetNavigation()) return;
    // 既存の完全削除関数をそのまま利用
    const deleted =
        await deleteDeviceCompletely(
            deviceIds
        );

    if (!deleted) {
        return;
    }

    ledgerSelectedDeviceIds.clear();
    if (activeLedgerDeviceId !== null && deviceIds.includes(activeLedgerDeviceId)) {
        await closeLedgerDetailPane();
    }

    // 削除後に台帳の表を再描画
    updateLedgerFilters();
    renderLedgerTable();
}



export async function openDataQualityDeviceInLedger(
    deviceId,
    options = {}
) {
    if (
        !await confirmDataQualityNavigation()
    ) {
        return;
    }

    const resolvedId =
        typeof deviceId === 'object' && deviceId !== null
            ? deviceId.deviceId
            : deviceId;
    const resolvedOptions =
        typeof deviceId === 'object' && deviceId !== null
            ? deviceId
            : options;

    const device =
        findDataQualityDevice(
            resolvedId
        );

    if (!device) {
        showToast(
            '対象機器が現在の画面データに見つかりません',
            'warning'
        );

        return;
    }

    hideDataQualityForNavigation();
    focusDataQualityTrigger();

    openLedgerForSearchedDevice(
        device.id
    );

    const shouldOpenSheet =
        Boolean(
            resolvedOptions?.openSheet ||
            resolvedOptions?.field
        );

    if (shouldOpenSheet) {
        window.requestAnimationFrame(async () => {
            if (!await openLedgerDetail(device.id)) return;

            if (resolvedOptions?.field) {
                window.requestAnimationFrame(() => {
                    focusLedgerSheetField(resolvedOptions.field);
                });
            }
        });
    }
}



/**
 * ダッシュボードから台帳を開く。
 */

/**
 * ダッシュボードから台帳を開く。
 */
export function openDashboardLedger(
    filters = {}
) {
    if (appState.isDashboardNavigating) {
        return;
    }

    appState.isDashboardNavigating = true;

    try {
        eventBus.emit(
            'dashboard:hide-for-navigation'
        );

        showLedger({ filters, fromDashboard: true });
        window.requestAnimationFrame(() => {
            appState.isDashboardNavigating = false;
        });
    } catch (error) {
        appState.isDashboardNavigating = false;
        throw error;
    }
}


/**
 * ダッシュボードから品質診断へ移動できるか確認する。
 */

export async function pingLedgerSelected() {
    if (!requireAdminUiAction() || appState.authExpired || appState.isPinging) return;
    const ids = [...ledgerSelectedDeviceIds];
    if (ids.length === 0) return;
    const targets = ids.map(id => ({
        id, ip: String(getDeviceById(id)?.ip || '').trim()
    }));
    await doPing(targets);
}

export function clearLedgerSelection() {
    if (appState.isPinging) return;
    ledgerSelectedDeviceIds.clear();
    renderLedgerTable();
}

eventBus.on('ui:busy-ended', updateLedgerSelectionUI);
eventBus.on('ledger:selection-changed', updateLedgerSelectionUI);
eventBus.on('save-state:changed', () => {
    if (document.getElementById('ledger-overlay')?.hidden === false) updateLedgerSelectionUI();
});

export function updateLedgerSelectionUI() {
    const validIds = new Set(appState.devices.map(device => Number(device.id)));
    for (const id of ledgerSelectedDeviceIds) {
        if (!validIds.has(id)) ledgerSelectedDeviceIds.delete(id);
    }
    const visibleIds = new Set(getFilteredLedgerDevices().map(device => Number(device.id)));
    const hiddenCount = [...ledgerSelectedDeviceIds].filter(id => !visibleIds.has(id)).length;
    const summary = document.getElementById('ledger-selection-summary');
    if (summary) {
        summary.textContent = `${ledgerSelectedDeviceIds.size}件選択中` +
            (hiddenCount ? `（表示外 ${hiddenCount}件）` : '');
    }
    const pingBtn = document.getElementById('ledger-ping-btn');
    if (pingBtn) {
        pingBtn.disabled = !isCurrentUserAdmin() || appState.authExpired ||
            appState.isPinging || isSaveInFlight() || ledgerSelectedDeviceIds.size === 0;
        pingBtn.textContent = `Ping（${ledgerSelectedDeviceIds.size}件）`;
    }
    const clearBtn = document.getElementById('ledger-clear-selection-btn');
    if (clearBtn) clearBtn.disabled = appState.isPinging || ledgerSelectedDeviceIds.size === 0;
    const bulkPlaceBtn = document.getElementById('ledger-bulk-place-btn');
    if (bulkPlaceBtn) {
        bulkPlaceBtn.disabled = !isCurrentUserAdmin() || appState.authExpired ||
            appState.isPinging || isSaveInFlight() || appState.appStatus?.state === 'unconfirmed' ||
            ledgerSelectedDeviceIds.size === 0;
    }
    const deleteBtn = document.getElementById('ledger-delete-btn');
    if (deleteBtn) {
        deleteBtn.disabled = !isCurrentUserAdmin() || appState.authExpired ||
            appState.isPinging || isSaveInFlight() || appState.appStatus?.state === 'unconfirmed' ||
            ledgerSelectedDeviceIds.size === 0;
    }
    const bulkEditBtn = document.getElementById('ledger-bulk-edit-btn');
    if (bulkEditBtn) {
        bulkEditBtn.disabled = !isCurrentUserAdmin() || appState.authExpired ||
            appState.isPinging || ledgerSelectedDeviceIds.size === 0;
    }
    const masterCheckbox = document.getElementById('ledger-select-all');
    if (masterCheckbox) {
        const rowCheckboxes = Array.from(document.querySelectorAll('#ledger-table-body .ledger-row-checkbox'));
        if (rowCheckboxes.length === 0) {
            masterCheckbox.checked = false;
            masterCheckbox.indeterminate = false;
        } else {
            const checkedCount = rowCheckboxes.filter(cb => cb.checked).length;
            masterCheckbox.checked = checkedCount === rowCheckboxes.length;
            masterCheckbox.indeterminate = checkedCount > 0 && checkedCount < rowCheckboxes.length;
        }
    }
}

let placeTargetDeviceIds = [];

const {
    openLedgerBulkEdit, closeLedgerBulkEdit, backLedgerBulkEdit,
    previewLedgerBulkEdit, confirmLedgerBulkEdit, remapBulkEditSessionIds
} = createLedgerBulkEdit({
    selectedDeviceIds: ledgerSelectedDeviceIds,
    closeDetailPane: () => closeLedgerDetailPane(),
    renderTable: () => renderLedgerTable()
});
export { openLedgerBulkEdit, closeLedgerBulkEdit, backLedgerBulkEdit, previewLedgerBulkEdit, confirmLedgerBulkEdit };

eventBus.on('resources:ids-remapped', maps => {
    ledgerViewFilterIds = ledgerViewFilterIds.map(id => Number(maps.views?.[id] ?? id));
    updateLedgerViewFilterOptions(ledgerViewFilterIds);
    const mapped = id => id == null ? id : Number(maps.devices?.[id] ?? id);
    const selected = [...ledgerSelectedDeviceIds].map(mapped);
    ledgerSelectedDeviceIds.clear();
    selected.forEach(id => ledgerSelectedDeviceIds.add(id));
    activeLedgerDeviceId = mapped(activeLedgerDeviceId);
    placeTargetDeviceIds = placeTargetDeviceIds.map(mapped);
    remapBulkEditSessionIds(mapped);
    remapConfigDeviceId(mapped);
    document.querySelectorAll('#ledger-table-body [data-device-id]').forEach(element => {
        element.dataset.deviceId = String(mapped(Number(element.dataset.deviceId)));
    });
    syncLedgerDraftButtons();
});

eventBus.on('resources:reloaded', ({ source } = {}) => {
    if (source !== 'hierarchy-editor') updateLedgerViewFilterOptions();
});
eventBus.on('resource:reloaded', () => {
    updateLedgerViewFilterOptions();
});
export async function openLedgerDetail(deviceId, { reveal = true, canOpen = () => true, tab, linkId, restoreFocusTo } = {}) {
    if (isSheetTabBusy() || !canOpen()) return false;
    if (Number(deviceId) !== activeLedgerDeviceId) {
        if (!await confirmSheetNavigation()) return false;
    } else if (tab === 'ports' && !await confirmOpenPortsTab()) {
        return false;
    }
    if (isSheetTabBusy() || !canOpen()) return false;
    const activeRow = document.activeElement?.closest?.('#ledger-table-body tr[data-device-id]');
    if (activeRow) {
        const activeRowId = Number(activeRow.dataset.deviceId);
        if (!hasResourceConflict('devices', activeRowId) && !commitLedgerRow(activeRowId)) return false;
    }
    const device = getDeviceById(deviceId);
    if (!device) return false;

    clearShareLinkFallback('ledger-sheet-copy-link-btn');
    activeLedgerDeviceId = Number(deviceId);

    const rows = document.querySelectorAll('#ledger-table-body tr');
    rows.forEach(tr => {
        tr.classList.toggle('ledger-row-active', Number(tr.dataset.deviceId) === activeLedgerDeviceId);
    });

    const overlay = document.getElementById('ledger-device-sheet-overlay');
    if (overlay && reveal) {
        if (overlay.hidden) {
            overlay.hidden = false;
            registerModalOpen('ledger-device-sheet', overlay, '.modal-close-btn', { onClose: closeLedgerDetailPane, restoreFocusTo });
        }
    }

    renderLedgerDeviceSheet(device, { tab });
    if (tab === 'ports' && linkId != null) await openSheetConnection(linkId);
    syncLedgerDraftButtons();
    return true;
}

function getAdjacentLedgerDeviceId(direction) {
    if (activeLedgerDeviceId === null) return null;
    const devices = document.getElementById('ledger-overlay')?.hidden === false
        ? getFilteredLedgerDevices()
        : appState.devices;
    const ids = devices.map(device => Number(device.id));
    const index = ids.indexOf(activeLedgerDeviceId);
    return index < 0 ? null : (ids[index + direction] ?? null);
}

export async function navigateLedgerDevice(direction) {
    if (navigatingLedgerSheet || isSheetTabBusy()) return false;
    const sourceId = activeLedgerDeviceId;
    const deviceId = getAdjacentLedgerDeviceId(direction);
    if (sourceId === null || deviceId === null) return false;
    navigatingLedgerSheet = true;
    syncLedgerDraftButtons();
    try {
        if (!await confirmSheetNavigation()) return false;
        if (appState.authExpired || activeLedgerDeviceId !== sourceId ||
            getAdjacentLedgerDeviceId(direction) !== deviceId ||
            !getDeviceById(sourceId) || !getDeviceById(deviceId)) {
            return false;
        }
        if (!await openLedgerDetail(deviceId)) return false;
        const body = document.getElementById('ledger-sheet-body');
        if (body) body.scrollTop = 0;
        return true;
    } finally {
        navigatingLedgerSheet = false;
        syncLedgerDraftButtons();
    }
}

export async function closeLedgerDetailPane() {
    if (isSheetTabBusy()) return false;
    if (!await confirmSheetNavigation()) return false;
    finishClosingLedgerDetailPane();
    return true;
}

export function refreshOpenLedgerAfterReload() {
    updateLedgerFilters();
    if (document.getElementById('ledger-overlay')?.hidden === false) renderLedgerTable();
    if (document.getElementById('ledger-device-sheet-overlay')?.hidden !== false) return;
    const device = activeLedgerDeviceId === null ? null : getDeviceById(activeLedgerDeviceId);
    if (device) renderLedgerDeviceSheet(device);
    else finishClosingLedgerDetailPane();
}

function finishClosingLedgerDetailPane() {
    closeDeviceTypePicker();
    clearSheetTabs();
    const body = document.getElementById('ledger-sheet-body');
    if (body) {
        body.dataset.activeTab = 'primary';
        delete body.dataset.deviceId;
    }
    activeLedgerDeviceId = null;
    const rows = document.querySelectorAll('#ledger-table-body tr');
    rows.forEach(tr => tr.classList.remove('ledger-row-active'));

    const overlay = document.getElementById('ledger-device-sheet-overlay');
    if (overlay) {
        overlay.hidden = true;
        registerModalClose('ledger-device-sheet');
    }

    // 診断へ戻ったときに、保存済みの変更を確認する。
    const dqOverlay = document.getElementById('data-quality-overlay');
    if (dqOverlay && !dqOverlay.hidden) {
        eventBus.emit('data-quality:render');
    }
    syncLedgerDraftButtons();
}
export async function deleteActiveLedgerDevice() {
    if (!requireAdminUiAction() || appState.authExpired || deletingSheetDevice || isSheetTabBusy() ||
        isSaveInFlight() || appState.appStatus.state === 'unconfirmed') return false;
    const deviceId = activeLedgerDeviceId;
    if (deviceId === null || hasResourceConflict('devices', deviceId)) return false;

    deletingSheetDevice = true;
    syncLedgerDraftButtons();
    try {
        while (hasDeviceDraftChanges('sheet', deviceId) || hasUnsavedSheetTabDraft()) {
            if (!await confirmSheetNavigation({ saveBeforeLeaving: true })) return false;
        }
        // 確認・保存中に別の個票へ移った場合や、保存中に追加下書きが発生した場合は削除へ進まない。
        if (activeLedgerDeviceId !== deviceId || !requireAdminUiAction() || appState.authExpired ||
            isSheetTabBusy() || isSaveInFlight() || appState.appStatus.state === 'unconfirmed' ||
            hasDeviceDraftChanges('sheet', deviceId) || hasUnsavedSheetTabDraft()) return false;
        const device = getDeviceById(deviceId);
        if (!device) return false;
        const deleted = await deleteDeviceCompletely([deviceId], { deviceName: device.name || `ID ${deviceId}` });
        if (!deleted) {
            if (activeLedgerDeviceId === deviceId) {
                renderLedgerDeviceSheet(device);
            }
            return false;
        }
        discardDeviceDraft('sheet', deviceId);
        discardDeviceDraft('ledger', deviceId);
        ledgerSelectedDeviceIds.delete(deviceId);
        if (activeLedgerDeviceId === deviceId) await closeLedgerDetailPane();
        updateLedgerFilters();
        renderLedgerTable();
        return true;
    } finally {
        deletingSheetDevice = false;
        syncLedgerDraftButtons();
    }
}


async function showLedgerDestination(deviceId, viewId) {
    if (!await confirmSheetNavigation({ saveBeforeLeaving: true }) || !commitLedgerDrafts()) return;
    const destination = getDeviceDestinations(deviceId, appState.placements, getRackDeviceMounts(appState), appState.views)
        .find(item => Number(item.view.id) === viewId);
    if (!destination) return;
    const { switchView } = await import('./view-manager-modal.js');
    if (getOpenBuildingId() != null && !await closeBuildingView()) return;
    if (!await switchView(viewId) || Number(appState.currentViewId) !== viewId) {
        if (activeLedgerDeviceId === deviceId) renderLedgerDeviceSheet(getDeviceById(deviceId));
        return;
    }
    if (!await closeLedger()) return;
    if (destination.kind === 'rack') {
        const { showRackDevice } = await import('../canvas/rack-view.js');
        await showRackDevice({ deviceId, viewId });
    } else {
        await focusDevicePlacement(getDeviceById(deviceId), destination.placement);
    }
}

export async function manageActiveDevicePlacements() {
    if (!requireAdminUiAction()) return;
    if (!activeLedgerDeviceId) return;
    if (!await confirmSheetNavigation()) return;
    await openPlacementManager(activeLedgerDeviceId);
}

async function openActiveDeviceRecordPanel(openPanel, label) {
    if (!requireAdminUiAction()) return false;
    if (!isConfirmedLedgerDevice(activeLedgerDeviceId)) {
        showToast(`保存が完了してから${label}を表示できます`, 'warning');
        return false;
    }
    const targetDeviceId = Number(activeLedgerDeviceId);
    const hadDraft = hasDeviceDraftChanges('sheet', targetDeviceId);
    if (!await confirmSheetNavigation({ saveBeforeLeaving: true })) return false;
    await waitForActiveResourceSave();
    if (Number(activeLedgerDeviceId) !== targetDeviceId) return false;
    if (appState.authExpired || hasResourceConflict('devices', targetDeviceId) ||
        hasResourceChanges('devices', targetDeviceId) || hasDeviceDraftChanges('sheet', targetDeviceId)) {
        showToast('機器の保存が完了していません。個票で保存状態を確認してください', 'warning');
        return false;
    }
    const latestDevice = getDeviceById(targetDeviceId);
    if (!isConfirmedLedgerDevice(latestDevice?.id)) return false;
    if (hadDraft && !hasDeviceDraftChanges('sheet', latestDevice.id)) {
        renderLedgerDeviceSheet(latestDevice);
    }
    return openPanel(latestDevice);
}

export async function openActiveDeviceHistory() {
    return openActiveDeviceRecordPanel(device => openChangeHistory({
        targetType: 'device', targetId: Number(device.id), targetName: device.name || ''
    }), '変更履歴');
}
export function openLedgerPlaceViewModal() {
    if (!requireAdminUiAction()) return;
    if (appState.authExpired || appState.appStatus?.state === 'unconfirmed' || isSaveInFlight()) {
        showToast('現在の状態では配置できません。保存やログイン状態を確認してください', 'warning');
        return;
    }
    const selectedIds = getLedgerSelectedDeviceIds();
    if (selectedIds.length === 0) {
        showToast('配置する機器を選択してください', 'warning');
        return;
    }
    placeTargetDeviceIds = selectedIds;
    showPlaceViewModal();
}


function showPlaceViewModal() {
    const overlay = document.getElementById('ledger-place-view-overlay');
    const summary = document.getElementById('ledger-place-view-summary');
    const tagsContainer = document.getElementById('ledger-place-device-tags');
    const viewSelect = document.getElementById('ledger-place-view-select');

    if (!overlay || !viewSelect) return;

    if (summary) {
        summary.innerHTML = `選択中の機器: <strong>${placeTargetDeviceIds.length}台</strong>`;
    }

    if (tagsContainer) {
        tagsContainer.replaceChildren();
        placeTargetDeviceIds.forEach(id => {
            const dev = getDeviceById(id);
            const tag = document.createElement('span');
            tag.className = 'ledger-place-device-tag';
            tag.textContent = dev ? (dev.name || `ID:${dev.id}`) : `ID:${id}`;
            tagsContainer.appendChild(tag);
        });
    }

    viewSelect.replaceChildren();
    (appState.views || []).filter(v => v.view_type !== 'rack').forEach(v => {
        const opt = document.createElement('option');
        opt.value = String(v.id);
        opt.textContent = `${v.name} (${v.view_type === 'floor' ? 'フロア図面' : '論理構成図'})`;
        if (Number(v.id) === Number(appState.currentViewId)) {
            opt.selected = true;
        }
        viewSelect.appendChild(opt);
    });
    overlay.hidden = false;
    registerModalOpen('ledger-place-view', overlay, '#ledger-place-view-select', { onClose: closeLedgerPlaceViewModal });
}

export function closeLedgerPlaceViewModal() {
    const overlay = document.getElementById('ledger-place-view-overlay');
    if (overlay) {
        overlay.hidden = true;
        registerModalClose('ledger-place-view');
    }
    placeTargetDeviceIds = [];
}

export async function confirmPlaceDevicesToView() {
    if (!requireAdminUiAction()) return;
    if (appState.authExpired || appState.appStatus?.state === 'unconfirmed' || isSaveInFlight()) {
        showToast('現在の状態では配置できません。保存やログイン状態を確認してください', 'warning');
        return;
    }
    const viewSelect = document.getElementById('ledger-place-view-select');
    if (!viewSelect || !viewSelect.value) {
        showToast('配置先のビューを選択してください', 'warning');
        return;
    }

    const targetViewId = Number(viewSelect.value);
    if (hasResourceConflict('views', targetViewId)) {
        showToast('配置先のビューが競合しています。対象を再読込してください', 'warning');
        return;
    }
    const targetView = (appState.views || []).find(v => Number(v.id) === targetViewId);
    if (!targetView) {
        showToast('配置先のビューが見つかりません', 'warning');
        return;
    }
    if (targetView.view_type === 'rack') {
        showToast('ラックの空きUから搭載位置を指定してください', 'warning');
        return;
    }
    const targetViewName = targetView ? targetView.name : `ビューID:${targetViewId}`;
    if (!await closeLedger()) return;

    const existingPlacements = (appState.placements || []).filter(p => Number(p.view_id) === targetViewId);
    const alreadyPlacedDeviceIds = new Set(existingPlacements.map(p => Number(p.device_id)));

    const toPlace = placeTargetDeviceIds.filter(id => !alreadyPlacedDeviceIds.has(Number(id)));

    if (toPlace.length === 0) {
        showToast(`選択された機器はすべて既に「${targetViewName}」に配置されています`, 'warning');
        closeLedgerPlaceViewModal();
        return;
    }

    if (Number(appState.currentViewId) !== targetViewId) {
        eventBus.emit('view:switch', targetViewId);
    }

    if (Number(appState.currentViewId) !== targetViewId) {
        return;
    }
    if (!await enterPlacementMode({
        tab: 'unplaced',
        initialDeviceIds: toPlace
    })) {
        return;
    }
    closeLedgerPlaceViewModal();

}

if (typeof window !== 'undefined') {
    window.navigateLedgerDevice = navigateLedgerDevice;
    window.closeLedgerDetailPane = closeLedgerDetailPane;
    window.manageActiveDevicePlacements = manageActiveDevicePlacements;
    window.openLedgerPlaceViewModal = openLedgerPlaceViewModal;
    window.closeLedgerPlaceViewModal = closeLedgerPlaceViewModal;
    window.confirmPlaceDevicesToView = confirmPlaceDevicesToView;
    window.openLedgerDetail = openLedgerDetail;
    window.getLedgerSelectedDeviceIds = getLedgerSelectedDeviceIds;
}
