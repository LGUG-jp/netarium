/**
 * Netarium - ui/property-panel.js
 */

import { getSelectedFloorRackPlacement, removeSelectedFloorRack } from '../canvas/floor-racks.js';
import {
    DEVICE_TYPES
} from '../core/constants.js';

import { appState } from '../core/state.js';
import { eventBus } from '../core/event-bus.js';
import { getDeviceStatusLabel, getDeviceStatusDescription } from '../core/device-monitoring.js';
import { getLinkSystem } from '../core/link-systems.js';
import { populateLinkSystemPicker, closeLinkSystemPicker } from './link-system-picker.js';
import { validateDeviceValues } from '../core/device-validation.js';
import { setInputError } from './field-errors.js';
import { updateLengthFeedback, updateFormLengthFeedback } from './length-feedback.js';
import { bindLocationSuggestion } from './location-suggestions.js';
import { populateFloorSelect, viewHierarchyPath } from '../core/building-hierarchy.js';
import { createDeviceTypePicker, closeDeviceTypePicker } from './device-type-picker.js';
import { clearShareLinkFallback, copyShareLink } from './share-link.js';
import {
    closeToolbarMenu,
} from './toolbar-controls.js';
import {
    isCurrentUserAdmin,
    requireAdminUiAction
} from './access-control.js';
import {
    normalizeMacAddress,
    normalizeText,
    setInputValue,
    setTextContent
} from '../core/utils.js';
import {
    getCurrentLinkGroups,
    getCurrentView,
    allocateLocalId,
    getCurrentPlacements,
    getDeviceById,
    getPlacedViewsForDevice,
    getPlacementForDeviceInCurrentView,
    removeDevicesFromState,
    toSaveLink
} from '../core/state.js';
import { isValidPortVlan, normalizePortName, pairKey } from '../core/connection-data.js';
import { unmigratedVlanForLink } from '../core/legacy-link-vlans.js';
import { deleteUnmigratedVlan } from '../modals/ledger-legacy-vlans.js';
import {
    render
} from '../canvas/renderer.js';
import {
    getDeviceManagementUnavailableReason,
    getEditingDeviceManagementTarget
} from '../modals/management-modal.js';
import {
    showToast
} from './toast.js';
import {
    markDirty
} from './status-bar.js';
import { scheduleSave, getPendingSave, hasResourceConflict, reloadConflictedResource, hasResourceChanges, isSaveInFlight, saveConnectionBatch } from '../core/save-queue.js';
import { getDeviceDraft, commitDeviceDraft, discardDeviceDraft, discardDeviceDraftsForIds, hasDeviceDraftChanges } from '../core/device-drafts.js';
import { createDeviceIpEditor } from './device-ip-editor.js';
import { createIpDuplicateNotice } from './ip-duplicate-notice.js';
import { chooseUnsavedChanges } from '../core/unsaved-changes-dialog.js';
import {
    buildViewOptionLabel
} from '../core/view-format.js';
import {
    clampPosition
} from '../canvas/drag-drop.js';
import {
    renderDeviceImages
} from './device-images.js';

function updateAllLengthFeedback() {
    if (typeof document !== 'undefined') updateFormLengthFeedback();
}

if (typeof document !== 'undefined') {
    document.addEventListener('input', event => {
        const target = event.target;
        updateLengthFeedback(target);
        updatePanelDraft(event.target);
    });

    document.addEventListener('change', event => {
        const target = event.target;
        if (target?.id === 'p-management-scheme') {
            setInputValue('p-management-port', '');
        }
        updatePanelDraft(target);
    });
    document.addEventListener('click', async event => {
        const back = event.target?.closest?.('#lp-group-back');
        if (back) {
            const group = getEditingLinkGroup();
            if (group && await openLinkGroup(group)) document.getElementById('lp-group-title')?.focus();
            return;
        }
        if (event.target?.closest?.('#p-open-sheet-btn')) {
            await openDeviceSheetFromPanel();
            return;
        }
        const copyButton = event.target?.closest?.('#p-copy-link-btn');
        if (copyButton) {
            await copyShareLink({ viewId: appState.currentViewId, deviceId: appState.editingDeviceId }, copyButton);
            return;
        }
        if (event.target?.closest?.('#lp-delete-legacy-vlan-btn')) {
            await deleteEditingLinkLegacyVlan();
            return;
        }
        const button = event.target?.closest?.('#p-reload-conflict-btn, #lp-reload-conflict-btn');
        if (!button) return;
        const target = button.id === 'p-reload-conflict-btn' ? ['devices', appState.editingDeviceId] : linkPanelConflictTarget();
        if (target) await reloadConflictedResource(...target);
    });
}

let panelDisplayedValues = null;
let panelTargetGeneration = 0;
let linkPanelDisplayedValues = null;
let linkPanelPortDraft = null;
let linkPanelSubmission = null;
let linkPanelMutationBusy = false;
const linkSides = ['from', 'to'];
let devicePanelReadOnly = false;
let linkPanelReadOnly = false;
const panelFields = {
    name: 'p-name', type: 'p-type', ip: 'p-ip', floor_id: 'p-floor-id',
    location: 'p-location', manufacturer: 'p-manufacturer',
    model: 'p-model', asset_number: 'p-asset-number', serial_number: 'p-serial-number',
    mac_address: 'p-mac-address', memo: 'p-memo', install_date: 'p-install-date',
    management_scheme: 'p-management-scheme', management_port: 'p-management-port',
    department: 'p-department', maintenance_vendor: 'p-maintenance-vendor',
    maintenance_expiry: 'p-maintenance-expiry'
};
const linkFields = {
    label: 'lp-label', from_port: 'lp-from-port', to_port: 'lp-to-port',
    memo: 'lp-memo', system_id: 'lp-system'
};

function readPanelValues(fields) {
    return Object.fromEntries(Object.entries(fields).map(([field, id]) => [field, getTrimmedInputValue(id)]));
}

function updatePanelDraft(target) {
    if (!target?.id) return;
    if (target.id.startsWith('p-') && target.closest?.('#panel') && panelDisplayedValues) {
        const draft = getDeviceDraft('panel', appState.editingDeviceId);
        if (!draft) return;
        for (const [field, id] of Object.entries(panelFields)) {
            if (id !== target.id && !(target.id === 'p-management-scheme' && field === 'management_port')) continue;
            const value = getTrimmedInputValue(id);
            draft[field] = ['management_port', 'floor_id'].includes(field) ? (value === '' ? null : (/^\d+$/.test(value) ? Number(value) : value)) : value;
        }
        const errors = validateDeviceValues({ ...draft, ...readPanelValues(panelFields) }).errors;
        for (const [field, id] of Object.entries(panelFields)) {
            const input = document.getElementById(id);
            if (id === target.id || input?.getAttribute('aria-invalid') === 'true') {
                setInputError(input, document.getElementById(`${id}-error`), errors[field]);
            }
        }
        document.getElementById('p-additional-ips')?.querySelector('.device-ip-editor')?.validateIps();
        updatePanelSummaries(draft);
        eventBus.emit('device-drafts:changed');
    }
    if (target.id.startsWith('lp-') && target.closest?.('#link-panel')) {
        if (linkSides.some(side => target.id === `lp-${side}-port` || target.id === `lp-${side}-vlan-input`)) {
            const link = getCommonLink(appState.editingLinkId);
            refreshLinkPanelVlans(link);
        }
        eventBus.emit('device-drafts:changed');
    }
}

async function resolveUnappliedChanges(hasChanges, apply, discard) {
    if (!hasChanges()) return true;
    const choice = await chooseUnsavedChanges();
    if (choice === 'save') {
        return apply({ showMessage: false, rerender: false });
    }
    if (choice !== 'discard') return false;
    discard();
    return true;
}

async function openDeviceSheetFromPanel() {
    const deviceId = appState.editingDeviceId;
    const generation = panelTargetGeneration;
    const panel = document.getElementById('panel');
    const isCurrent = () => deviceId !== null && generation === panelTargetGeneration &&
        appState.editingDeviceId === deviceId && !appState.authExpired &&
        panel && !panel.hidden && !panel.classList.contains('hidden') && !!getDeviceById(deviceId);
    if (!isCurrent()) return false;
    if (!await resolveUnappliedChanges(hasUnappliedPanelChanges,
        options => isCurrent() && applyPanelValues(options),
        () => {
            if (!isCurrent()) return;
            discardDeviceDraft('panel', deviceId);
            panelDisplayedValues = null;
            openPanel(getDeviceById(deviceId));
        })) return false;
    if (!isCurrent()) return false;
    const { openLedgerDetail } = await import('../modals/ledger-modal.js');
    return openLedgerDetail(deviceId, { canOpen: () => isCurrent() && !hasUnappliedPanelChanges() });
}

function linkPanelConflictTarget() {
    const linkId = appState.editingLinkId;
    if (hasResourceConflict('links', linkId)) return ['links', linkId];
    if (linkId != null) {
        for (const side of linkSides) {
            const id = linkPanelPortDraft?.ports[side]?.id;
            if (id != null && hasResourceConflict('device_ports', id)) return ['device_ports', id];
        }
    }
    if (hasResourceConflict('views', appState.currentViewId)) return ['views', appState.currentViewId];
    return null;
}

function updatePanelConflictButtons() {
    if (typeof document === 'undefined') return;
    const deviceButton = document.getElementById('p-reload-conflict-btn');
    const linkButton = document.getElementById('lp-reload-conflict-btn');
    if (deviceButton) deviceButton.hidden = !hasResourceConflict('devices', appState.editingDeviceId);
    const linkConflict = linkPanelConflictTarget()?.[0];
    if (linkButton) {
        linkButton.hidden = !linkConflict;
        linkButton.textContent = linkConflict === 'links' ? '競合した接続を再読込'
            : linkConflict === 'device_ports' ? '競合したポートを再読込' : '競合したビューを再読込';
    }
    for (const { buttonId, kind, id, readOnly, hasChanges } of [
        { buttonId: 'p-apply-btn', kind: 'devices', id: appState.editingDeviceId, readOnly: devicePanelReadOnly, hasChanges: hasUnappliedPanelChanges },
        { buttonId: 'lp-apply-btn', kind: 'links', id: appState.editingLinkId, readOnly: linkPanelReadOnly, hasChanges: hasUnappliedLinkPanelChanges }
    ]) {
        const button = document.getElementById(buttonId);
        if (!button) continue;
        const hasTarget = (kind === 'devices' ? appState.editingDeviceId : appState.editingLinkId) !== null;
        const canRetry = hasTarget && !isSaveInFlight() && appState.appStatus.state !== 'unconfirmed' && hasResourceChanges(kind, id);
        const reason = appState.authExpired ? '認証が失効しているため適用できません'
            : (!isCurrentUserAdmin() || readOnly) ? '管理者権限が必要です'
            : hasResourceConflict(kind, id) || (kind === 'links' && linkConflict === 'device_ports') ? '競合対象を再読込してください'
            : kind === 'links' && linkPanelSaveBlocked() ? '先に保存処理を完了してください'
            : !hasChanges() && !canRetry ? '未適用の変更はありません' : '';
        button.disabled = reason !== '';
        button.setAttribute('aria-disabled', button.disabled ? 'true' : 'false');
        if (reason) button.title = reason;
        else button.removeAttribute('title');
    }
    const deleteVlan = document.getElementById('lp-delete-legacy-vlan-btn');
    if (deleteVlan) {
        const reason = linkPanelVlanDeleteBlockReason();
        deleteVlan.disabled = Boolean(reason);
        if (reason) deleteVlan.title = reason;
        else deleteVlan.removeAttribute('title');
    }
}

eventBus.on('resource:conflict', updatePanelConflictButtons);
eventBus.on('save-state:changed', () => {
    if (!linkPanelMutationBusy && linkPanelSubmission && !linkPanelSaveBlocked()) {
        linkPanelSubmission = null;
        setLinkPanelReadOnly(linkPanelReadOnly);
    } else {
        updatePanelConflictButtons();
    }
});
eventBus.on('device-drafts:changed', updatePanelConflictButtons);
eventBus.on('ip-management:changed', () => {
    if (typeof document === 'undefined' || appState.editingDeviceId == null) return;
    const panel = document.getElementById('panel');
    const device = getDeviceById(appState.editingDeviceId);
    if (panel && device && !panel.hidden && !panel.classList.contains('hidden')) populatePanelForm(device, panel);
});
eventBus.on('resource:reloaded', ({ kind, id, wasEditing }) => {
    if (typeof document === 'undefined') return;
    if (kind === 'devices' && Number(id) === Number(appState.editingDeviceId)) {
        panelDisplayedValues = null;
        discardDeviceDraft('panel', id);
        const device = getDeviceById(id);
        if (device) openPanel(device);
        else closePanel();
    }
    if (kind === 'links' || kind === 'device_ports' || kind === 'devices' ||
        (kind === 'views' && (Number(id) === Number(appState.currentViewId) || getCurrentView()?.view_type === 'floor'))) {
        if (kind === 'links' && wasEditing) linkPanelDisplayedValues = null;
        refreshOpenLinkPanel();
    }
    updatePanelConflictButtons();
});
eventBus.on('resources:saved', data => {
    if (linkPanelSubmission && getPendingSave()?.payload === linkPanelSubmission &&
        Number(appState.editingLinkId) === linkPanelSubmission.links[0].id) {
        linkPanelDisplayedValues = null;
    }
    if (data.links || data.device_ports || data.devices || data.views) refreshOpenLinkPanel();
});
eventBus.on('legacy-vlans:changed', refreshOpenLinkPanel);
eventBus.on('resources:reloaded', () => {
    panelDisplayedValues = null;
    linkPanelDisplayedValues = null;
    linkPanelPortDraft = null;
    linkPanelSubmission = null;
    if (appState.editingLinkGroupKey != null) closeLinkPanel();
    updatePanelConflictButtons();
});
eventBus.on('link-systems:changed', () => {
    if (typeof document === 'undefined') return;
    const selector = document.getElementById('lp-system');
    if (!selector) return;
    populateLinkSystemPicker(selector, selector.value, updatePanelDraft);
    refreshOpenLinkPanel();
});


/**
 * 五分類グループの要約表示更新
 */
export function updatePanelSummaries(device) {
    if (!device) return;

    setTextContent(
        'p-summary-basic',
        `${device.name || '(未設定)'} / ${device.ip || 'IP未設定'}`
    );

    const placementText = [viewHierarchyPath(device, appState), device.location]
        .filter(Boolean)
        .join(' ');
    setTextContent('p-summary-placement', placementText || '未登録');

    const assetText = [device.manufacturer, device.model, device.install_date]
        .filter(Boolean)
        .join(' ');
    setTextContent('p-summary-asset', assetText || '未登録');

    const schemeText = device.management_scheme
        ? device.management_scheme.toUpperCase() + (device.management_port ? `:${device.management_port}` : '')
        : '';
    const mgmtParts = [schemeText, device.department, device.maintenance_vendor, device.maintenance_expiry ? `期限:${device.maintenance_expiry}` : '']
        .filter(Boolean);
    setTextContent('p-summary-management', mgmtParts.join(' / ') || '未登録');
    updatePanelMonitoringSummary(getDeviceById(device.id) || device, device.memo);
}

function updatePanelMonitoringSummary(device, memo) {
    const statusText = getDeviceStatusLabel(device.status);
    const extraText = (memo ? '備考あり' : '備考なし') + ' / ' + statusText;
    setTextContent('p-summary-extra', extraText);
    const summary = document.getElementById('p-summary-extra');
    if (summary) summary.title = getDeviceStatusDescription(device);
}

/**
 * エラー表示の解除と設定
 */
export function clearAllPanelErrors() {
    if (typeof document === 'undefined') return;
    const panel = document.getElementById('panel');
    if (!panel) return;
    panel.querySelectorAll('.form-error').forEach(el => {
        el.textContent = '';
        el.hidden = true;
    });
    panel.querySelectorAll('[aria-invalid="true"]').forEach(el => {
        setInputError(el, document.getElementById(`${el.id}-error`), '');
    });
}

export function setFieldError(id, errorId, groupId, message, options = {}) {
    const { focus = true } = options;
    const input = document.getElementById(id);
    const errorEl = document.getElementById(errorId);
    const group = document.getElementById(groupId);

    if (group && !group.open) {
        group.open = true;
    }

    setInputError(input, errorEl, message);
    if (input) {
        if (focus && typeof input.focus === 'function') {
            input.focus();
        }
    }

}

export function clearAllLinkPanelErrors() {
    if (typeof document === 'undefined') return;
    const panel = document.getElementById('link-panel');
    if (!panel) return;
    panel.querySelectorAll('.form-error').forEach(el => {
        el.textContent = '';
        el.hidden = true;
    });
    panel.querySelectorAll('[aria-invalid="true"]').forEach(el => {
        el.removeAttribute('aria-invalid');
        el.removeAttribute('aria-describedby');
        el.classList.remove('is-invalid');
    });
}

export function setLinkFieldError(id, errorId, message, options = {}) {
    const { focus = true } = options;
    const input = document.getElementById(id);
    const errorEl = document.getElementById(errorId);

    if (errorEl) {
        errorEl.textContent = `! ${message}`;
        errorEl.hidden = false;
    }

    if (input) {
        input.setAttribute('aria-invalid', 'true');
        input.setAttribute('aria-describedby', errorId);
        input.classList.add('is-invalid');
        if (focus && typeof input.focus === 'function') {
            input.focus();
        }
    }

}

/**
 * 未適用の入力変更を検出
 */
export function hasUnappliedPanelChanges() {
    const panel = document.getElementById('panel');
    if (!panel || panel.hidden || panel.classList.contains('hidden') || appState.editingDeviceId === null) return false;
    const current = readPanelValues(panelFields);
    return hasDeviceDraftChanges('panel', appState.editingDeviceId) ||
        Boolean(panelDisplayedValues && Object.keys(panelFields).some(field => current[field] !== panelDisplayedValues[field]));
}

export function hasUnappliedLinkPanelChanges() {
    const panel = document.getElementById('link-panel');
    if (!panel || panel.hidden || panel.classList.contains('hidden') || appState.editingLinkId === null) return false;
    const current = readPanelValues(linkFields);
    return Boolean(linkPanelDisplayedValues &&
        (Object.keys(linkFields).some(field => current[field] !== linkPanelDisplayedValues[field]) ||
            linkSides.some(side => hasVlanInputChange(side))));
}

export function hasAnyUnappliedChanges() {
    return hasUnappliedPanelChanges() || hasUnappliedLinkPanelChanges();
}

/**
 * 入力を元に戻す (DOM値のみ復元)
 */
export function revertPanelValues() {
    if (appState.editingDeviceId === null) return false;
    const device = getDeviceById(appState.editingDeviceId);
    if (!device) return false;
    if (hasUnappliedPanelChanges() && !window.confirm('未適用の入力を破棄して最後に確定した値に戻しますか？')) return false;
    discardDeviceDraft('panel', device.id);
    panelDisplayedValues = null;
    openPanel(device);
    return true;
}

export function revertLinkPanelValues() {
    if (linkPanelSaveBlocked()) return false;
    if (appState.editingLinkId === null) return false;
    const link = getCommonLink(appState.editingLinkId);
    if (!link) return false;
    if (hasUnappliedLinkPanelChanges() && !window.confirm('未適用の入力を破棄して最後に確定した値に戻しますか？')) return false;
    linkPanelDisplayedValues = null;
    populateLinkPanelForm(link, document.getElementById('link-panel'));
    return true;
}

function syncPlacementCoordinateInputs(placement, preserveDraft = false) {
    const inputs = ['x', 'y'].map(axis => [axis, document.getElementById(`p-coord-${axis}`)]);
    if (preserveDraft && inputs.some(([, input]) => input &&
        (input.value !== input.defaultValue || input.validity?.badInput))) return;
    for (const [axis, input] of inputs) {
        if (!input) continue;
        input.defaultValue = input.value = placement ? String(Math.round(placement[axis])) : '';
    }
}

/**
 * 配置座標の適用 (キーボード代替)
 */
export function applyPlacementCoordinates() {
    if (!requireAdminUiAction()) {
        return;
    }

    const coordError = document.getElementById('p-coord-error');
    if (coordError) {
        coordError.textContent = '';
        coordError.hidden = true;
    }

    if (appState.editingDeviceId === null) {
        showToast('編集対象の機器がありません', 'warning');
        return;
    }
    if (hasResourceConflict('views', appState.currentViewId)) {
        updatePanelConflictButtons();
        showToast('競合しているビューの配置は変更できません。対象を再読込してください', 'warning');
        return;
    }

    const placement = getPlacementForDeviceInCurrentView(appState.editingDeviceId);
    if (!placement) {
        const msg = '表示中のビューに対象機器が配置されていません';
        if (coordError) {
            coordError.textContent = `! ${msg}`;
            coordError.hidden = false;
        }
        return;
    }

    const xVal = Number(document.getElementById('p-coord-x')?.value);
    const yVal = Number(document.getElementById('p-coord-y')?.value);

    if (!Number.isFinite(xVal) || !Number.isFinite(yVal)) {
        const msg = '座標には有効な数値を入力してください';
        if (coordError) {
            coordError.textContent = `! ${msg}`;
            coordError.hidden = false;
        }
        return;
    }

    const clamped = clampPosition(Math.round(xVal), Math.round(yVal));
    placement.x = clamped.x;
    placement.y = clamped.y;

    syncPlacementCoordinateInputs(clamped);

    markDirty();
    scheduleSave({ immediate: true, silent: true });
    render();

}
/**
 * 編集パネル表示
 */
export function openPanel(device) {
    bindLocationSuggestion(document.getElementById('p-location'), 'location');
    const panel = document.getElementById('panel');

    if (linkPanelMutationBusy) return false;
    if (!panel || !device) {
        return false;
    }
    clearShareLinkFallback('p-copy-link-btn');

    if (Number(appState.editingDeviceId) === Number(device.id) && hasUnappliedPanelChanges()) {
        return true;
    }

    const needsDeviceConfirm = appState.editingDeviceId !== null && Number(appState.editingDeviceId) !== Number(device.id) && hasUnappliedPanelChanges();
    const needsLinkConfirm = hasUnappliedLinkPanelChanges();

    if (needsDeviceConfirm || needsLinkConfirm) {
        return (async () => {
            if (needsDeviceConfirm && !await resolveUnappliedChanges(hasUnappliedPanelChanges, applyPanelValues, () => discardDeviceDraft('panel', appState.editingDeviceId))) {
                return false;
            }
            if (needsLinkConfirm) {
                if (!await closeLinkPanel()) return false;
            } else {
                closeLinkPanel();
            }
            populatePanelForm(device, panel);
            return true;
        })();
    }

    closeLinkPanel();
    populatePanelForm(device, panel);
    return true;
}

function populatePanelForm(device, panel) {
    closeToolbarMenu();
    if (appState.editingDeviceId !== Number(device.id)) panelTargetGeneration++;
    appState.editingDeviceId = Number(device.id);
    device = getDeviceDraft('panel', device.id) || device;
    panel.classList.remove('hidden');
    panel.hidden = false;
    document.body.classList.add('panel-open');

    clearAllPanelErrors();

    setInputValue('p-name', device.name);
    createDeviceTypePicker({
        control: document.getElementById('p-type'), value: device.type,
        disabled: !isCurrentUserAdmin(),
        onChange: input => updatePanelDraft(input)
    });
    setInputValue('p-ip', device.ip);
    document.getElementById('p-ip-notice')?.remove();
    const notice = createIpDuplicateNotice({
        getRecord: () => getDeviceDraft('panel', appState.editingDeviceId),
        field: 'ip_segment_id', ipInput: document.getElementById('p-ip'),
        canEdit: () => appState.editingDeviceId !== null && isCurrentUserAdmin() && !appState.authExpired && !appState.isPinging &&
            !hasResourceConflict('devices', appState.editingDeviceId),
        onChange: () => eventBus.emit('device-drafts:changed')
    });
    notice.id = 'p-ip-notice';
    document.getElementById('p-ip')?.after(notice);
    document.getElementById('p-additional-ips')?.replaceChildren(createDeviceIpEditor({
        getDevice: () => getDeviceDraft('panel', appState.editingDeviceId),
        canEdit: () => appState.editingDeviceId !== null && isCurrentUserAdmin() && !appState.authExpired && !appState.isPinging &&
            !hasResourceConflict('devices', appState.editingDeviceId),
        onChange: () => eventBus.emit('device-drafts:changed')
    }));

    populateFloorSelect(document.getElementById('p-floor-id'), appState, device.floor_id);
    setInputValue('p-location', device.location);
    setInputValue('p-manufacturer', device.manufacturer);
    setInputValue('p-model', device.model);
    setInputValue('p-asset-number', device.asset_number);
    setInputValue('p-serial-number', device.serial_number);
    setInputValue('p-mac-address', device.mac_address);
    setInputValue('p-memo', device.memo);
    setInputValue('p-install-date', device.install_date);
    setInputValue('p-management-scheme', device.management_scheme || '');
    setInputValue('p-management-port', device.management_port != null ? device.management_port : '');
    setInputValue('p-department', device.department);
    setInputValue('p-maintenance-vendor', device.maintenance_vendor);
    setInputValue('p-maintenance-expiry', device.maintenance_expiry);
    panelDisplayedValues = readPanelValues(panelFields);
    updatePanelConflictButtons();

    syncPlacementCoordinateInputs(getPlacementForDeviceInCurrentView(device.id));

    setTextContent(
        'p-last-checked',
        device.last_checked_at || '-'
    );

    setTextContent(
        'p-response-ms',
        device.last_response_ms == null
            ? '-'
            : `${device.last_response_ms}ms`
    );

    setTextContent(
        'p-last-error',
        device.last_error || '-'
    );

    renderPanelPlacementSummary(device);
    updateDeviceManagementButtons();
    updatePanelSummaries(device);
    updateAllLengthFeedback();
    renderDeviceImages(device.id);

    setDevicePanelReadOnly(
        !isCurrentUserAdmin()
    );
    eventBus.emit('device-panel:opened', device);
    return true;
}


export function setDevicePanelReadOnly(
    readOnly
) {
    const panel =
        document.getElementById('panel');

    if (!panel) {
        return;
    }

    panel
        .querySelectorAll(
            'input, textarea'
        )
        .forEach(element => {
            element.readOnly =
                readOnly;

            if (readOnly) {
                element.title =
                    '閲覧専用です';
            } else {
                element.removeAttribute(
                    'title'
                );
            }
        });

    panel
        .querySelectorAll('select, #p-type')
        .forEach(element => {
            element.disabled =
                readOnly;

            if (readOnly) {
                element.title =
                    '閲覧専用です';
            } else {
                element.removeAttribute(
                    'title'
                );
            }
        });
    devicePanelReadOnly = readOnly;
    if (readOnly) closeDeviceTypePicker();
    updatePanelConflictButtons();
}


export function updateDeviceManagementButtons() {
    const reason =
        getDeviceManagementUnavailableReason();

    const disabled =
        reason !== '';

    const button =
        document.getElementById(
            'p-open-management-btn'
        );

    if (!button) {
        return;
    }

    button.disabled =
        disabled;

    button.setAttribute(
        'aria-disabled',
        disabled
            ? 'true'
            : 'false'
    );

    if (reason) {
        button.title = reason;
    } else {
        button.removeAttribute(
            'title'
        );
    }
}


/**
 * 編集パネルの内容反映
 */
export function applyPanelValues(options = {}) {
    const {
        showMessage = true,
        rerender = true,
        focusError = showMessage
    } = options;
    if (!requireAdminUiAction()) return false;
    if (appState.editingDeviceId === null) {
        if (showMessage) {
            showToast(
                '編集対象の機器がありません',
                'warning'
            );
        }
        return false;
    }

    const device = getDeviceById(appState.editingDeviceId);
    if (!device) {
        if (showMessage) {
            showToast(
                '編集対象の機器が見つかりません',
                'warning'
            );
        }
        return false;
    }
    if (hasResourceConflict('devices', device.id)) {
        updatePanelConflictButtons();
        if (showMessage) showToast('この機器は競合しています。対象を再読込してください', 'warning');
        return false;
    }

    clearAllPanelErrors();

    const name = getTrimmedInputValue('p-name');
    let type = normalizeText(document.getElementById('p-type')?.value);
    const ip = getTrimmedInputValue('p-ip');
    const floorIdValue = getTrimmedInputValue('p-floor-id');
    const floor_id = floorIdValue === '' ? null : Number(floorIdValue);
    const location = getTrimmedInputValue('p-location');
    const manufacturer = getTrimmedInputValue('p-manufacturer');
    const model = getTrimmedInputValue('p-model');
    const assetNumber = getTrimmedInputValue('p-asset-number');
    const serialNumber = getTrimmedInputValue('p-serial-number');
    const macAddress = normalizeMacAddress(getTrimmedInputValue('p-mac-address'));
    const memo = getTrimmedInputValue('p-memo');
    const installDate = getTrimmedInputValue('p-install-date');
    const scheme = normalizeText(document.getElementById('p-management-scheme')?.value);
    const portStr = getTrimmedInputValue('p-management-port');
    const department = getTrimmedInputValue('p-department');
    const maintenanceVendor = getTrimmedInputValue('p-maintenance-vendor');
    const maintenanceExpiry = getTrimmedInputValue('p-maintenance-expiry');

    const result = validateDeviceValues({
        ...device, id: device.id, name, type, ip, floor_id, location, manufacturer, model,
        additional_ips: getDeviceDraft('panel', device.id)?.additional_ips || [],
        ip_segment_id: getDeviceDraft('panel', device.id)?.ip_segment_id ?? null,
        asset_number: assetNumber, serial_number: serialNumber, mac_address: macAddress,
        memo, install_date: installDate, management_scheme: scheme, management_port: portStr,
        department, maintenance_vendor: maintenanceVendor, maintenance_expiry: maintenanceExpiry
    });
    const groups = {
        name: 'basic', ip: 'basic', floor_id: 'placement', location: 'placement',
        manufacturer: 'asset', model: 'asset', asset_number: 'asset', serial_number: 'asset',
        mac_address: 'asset', install_date: 'asset', memo: 'extra'
    };
    const errors = Object.entries(result.errors);
    const addressInput = document.getElementById('p-additional-ips')?.querySelector('.device-ip-editor')?.validateIps({
        reveal: true, device: result.values
    });
    errors.forEach(([field, message], index) => {
        if (field === 'additional_ips') {
            const group = document.getElementById('p-group-basic');
            if (group) group.open = true;
            if (focusError && index === 0) addressInput?.focus();
            return;
        }
        const id = `p-${field.replaceAll('_', '-')}`;
        setFieldError(id, `${id}-error`, `p-group-${groups[field] || 'management'}`, message,
            { focus: focusError && index === 0 });
    });
    if (errors.length) {
        return false;
    }

    if (!DEVICE_TYPES[type]) {
        type = 'other';
    }

    const values = {
        name, type, ip, floor_id, location, manufacturer, model,
        asset_number: assetNumber, serial_number: serialNumber, mac_address: macAddress,
        memo, install_date: installDate, management_scheme: scheme,
        management_port: portStr !== '' ? Number(portStr) : null,
        department, maintenance_vendor: maintenanceVendor, maintenance_expiry: maintenanceExpiry
    };
    const draft = getDeviceDraft('panel', device.id);
    if (!draft) return false;
    const domValues = readPanelValues(panelFields);
    for (const [field, value] of Object.entries(values)) {
        if (!panelDisplayedValues || domValues[field] !== panelDisplayedValues[field]) {
            draft[field] = value;
        }
    }
    try {
        if (commitDeviceDraft('panel', device.id)) markDirty();
    } catch (error) {
        if (showMessage) showToast(error.message, 'warning');
        return false;
    }
    panelDisplayedValues = null;
    openPanel(device);
    scheduleSave({ immediate: true, silent: true });
    updatePanelConflictButtons();
    updatePanelSummaries(device);
    updateAllLengthFeedback();
    renderDeviceImages(device.id);

    if (rerender) render();


    return true;
}
export function closePanel() {
    const panel = document.getElementById('panel');

    if (!panel) {
        return true;
    }

    if (hasUnappliedPanelChanges()) {
        return (async () => {
            if (!await resolveUnappliedChanges(hasUnappliedPanelChanges, applyPanelValues, () => discardDeviceDraft('panel', appState.editingDeviceId))) return false;
            finishClosePanel(panel);
            return true;
        })();
    }

    finishClosePanel(panel);
    return true;
}

function finishClosePanel(panel) {
    panelTargetGeneration++;
    closeDeviceTypePicker();
    discardDeviceDraft('panel', appState.editingDeviceId);
    clearAllPanelErrors();
    panel.classList.add('hidden');
    panel.hidden = true;
    appState.editingDeviceId = null;
    panelDisplayedValues = null;
    if (document.getElementById('link-panel')?.hidden) {
        document.body.classList.remove('panel-open');
    }
    updatePanelConflictButtons();
}

export function applyPanel() {
    if (!requireAdminUiAction()) {
        return false;
    }

    return applyPanelValues({
        showMessage: true,
        rerender: true
    });
}

function getCommonLink(id) {
    if (id == null) return null;
    return appState.links.find(row => Number(row.id) === Number(id)) ?? null;
}

function resolvePanelPort(link, side) {
    return link[`${side}_port_name`] ??
        appState.devicePorts.find(row => Number(row.id) === Number(link[`${side}_port_id`]))?.name ?? '';
}

function linkPanelSaveBlocked() {
    return linkPanelMutationBusy || Boolean(linkPanelSubmission && getPendingSave()?.payload === linkPanelSubmission);
}

function hasVlanInputChange(side) {
    const selection = linkPanelPortDraft?.ports[side];
    const input = document.getElementById(`lp-${side}-vlan-input`);
    return Boolean(selection && input && input.value !== selection.vlan);
}

function linkPanelPort(link, side, name) {
    return name ? appState.devicePorts.find(row => Number(row.device_id) === Number(link[`${side}_id`]) && row.name === name) : null;
}

function refreshLinkPanelVlans(link) {
    if (!link || typeof document === 'undefined') return;
    const pending = unmigratedVlanForLink(link.id);
    const pendingSection = document.getElementById('lp-legacy-vlan');
    if (pendingSection) pendingSection.hidden = !pending;
    setTextContent('lp-legacy-vlan-value', pending?.vlan ?? '');
    const admin = !linkPanelReadOnly && isCurrentUserAdmin() && !appState.authExpired;
    const busy = linkPanelSaveBlocked();
    const draft = linkPanelPortDraft;
    const saved = Number(link.resource_revision) > 0;
    // 作成直後に開いた接続は、初回保存の応答を受けてから VLAN を編集できる。
    if (draft && saved && !(draft.linkRevision > 0)) draft.linkRevision = link.resource_revision;
    const deleteButton = document.getElementById('lp-delete-legacy-vlan-btn');
    if (deleteButton) deleteButton.hidden = !pending || !admin;
    for (const side of linkSides) {
        const name = normalizePortName(getTrimmedInputValue(`lp-${side}-port`));
        const port = linkPanelPort(link, side, name);
        setTextContent(`lp-${side}-vlan`, !name ? '未指定' : port ? (port.vlan || '未設定') : '未登録');
        const editor = document.getElementById(`lp-${side}-vlan-editor`);
        const summary = document.getElementById(`lp-${side}-vlan-summary`);
        const input = document.getElementById(`lp-${side}-vlan-input`);
        if (!input || !editor) continue;
        const editable = Boolean(admin && draft);
        editor.hidden = !editable;
        if (summary) summary.hidden = editable;
        input.disabled = !editable || !name || !saved || busy;
        if (!editable) continue;
        const previous = draft.ports[side];
        if (previous?.name !== name || (!busy && !hasVlanInputChange(side))) {
            const vlan = port?.vlan || '';
            draft.ports[side] = { name, id: port?.id, revision: port?.resource_revision, vlan };
            input.value = vlan;
            setInputError(input, document.getElementById(`${input.id}-error`), '');
        }
    }
}

function linkPanelVlanDeleteBlockReason() {
    if (linkPanelSaveBlocked() || getPendingSave() || isSaveInFlight()) return '先に保存処理を完了してください';
    if (hasUnappliedLinkPanelChanges()) return '先に入力を適用するか、変更を取り消してください';
    return '';
}

async function deleteEditingLinkLegacyVlan() {
    const id = appState.editingLinkId;
    const record = unmigratedVlanForLink(id);
    const canAct = () => appState.editingLinkId === id && !linkPanelReadOnly && !linkPanelVlanDeleteBlockReason();
    if (!record || !canAct()) return false;
    let locked = false;
    const removed = await deleteUnmigratedVlan(record, {
        canAct,
        onBusyChange: busy => {
            if (busy || locked) setLinkPanelMutationBusy(busy);
            locked = busy;
        }
    });
    const trigger = document.getElementById('lp-delete-legacy-vlan-btn');
    if (removed && appState.editingLinkId === id &&
        (document.activeElement === trigger || document.activeElement === document.body)) {
        const link = getCommonLink(id);
        if (link) {
            const side = Number(link.from_id) < Number(link.to_id) ? 'from' : 'to';
            document.getElementById(`lp-${side}-port`)?.focus();
        }
    }
    return removed;
}

function setLinkPanelMutationBusy(busy) {
    linkPanelMutationBusy = busy;
    setLinkPanelReadOnly(linkPanelReadOnly);
    for (const id of ['lp-revert-btn', 'lp-delete-btn', 'lp-close-btn', 'lp-group-back']) {
        const button = document.getElementById(id);
        if (button) button.disabled = busy;
    }
}

export function describeLinkPorts(link, firstDeviceId) {
    const forward = Number(link.from_id) === Number(firstDeviceId);
    const first = resolvePanelPort(link, forward ? 'from' : 'to') || '未指定';
    const second = resolvePanelPort(link, forward ? 'to' : 'from') || '未指定';
    return `#${link.id}  ${first} ↔ ${second}`;
}

const linkDeviceName = id => getDeviceById(id)?.name || `機器 #${id}`;

function displayedLinkEndpointName(id) {
    if (id > 0) return linkDeviceName(id);
    const rack = appState.views.find(view => view.view_type === 'rack' && Number(view.id) === -id);
    return rack?.name || `ラック #${-id}`;
}

function describeRackLink(link) {
    const sides = Number(link.from_id) < Number(link.to_id) ? linkSides : ['to', 'from'];
    const endpoints = sides.map(side => `${linkDeviceName(link[`${side}_id`])}（${resolvePanelPort(link, side) || '未指定'}）`);
    return `#${link.id}  ${endpoints.join(' ↔ ')}`;
}

function getEditingLinkGroup() {
    return appState.editingLinkGroupKey == null ? null :
        getCurrentLinkGroups().find(group => group.display_key === appState.editingLinkGroupKey) ?? null;
}

// Keep the common link ID independent of the view/pair key used for route editing.
export function openLinkGroup(group) {
    if (!group?.link_ids.length) return false;
    return openLinkTarget(group.link_ids.length === 1 ? group.link_ids[0] : null, group);
}

export function openLinkPanel(link) {
    if (!link) return false;
    const id = Number(link.id);
    const group = getCurrentLinkGroups().find(row => row.link_ids.includes(id)) ?? null;
    return openLinkTarget(id, group);
}

function openLinkTarget(linkId, group) {
    const panel = document.getElementById('link-panel');
    if (!panel || (linkId != null && !getCommonLink(linkId))) return false;
    if (linkPanelMutationBusy) return false;
    if (linkId != null && Number(appState.editingLinkId) === Number(linkId) && hasUnappliedLinkPanelChanges()) {
        return true;
    }
    const finish = () => {
        const link = getCommonLink(linkId);
        if (linkId != null && !link) return false;
        appState.editingLinkGroupKey = group?.display_key ?? null;
        if (link) populateLinkPanelForm(link, panel, group);
        else {
            populateLinkGroupSummary(group, panel);
            document.getElementById('lp-group-title')?.focus();
        }
        return true;
    };
    const needsLinkConfirm = hasUnappliedLinkPanelChanges();
    const needsDeviceConfirm = hasUnappliedPanelChanges();
    if (needsLinkConfirm || needsDeviceConfirm) {
        return (async () => {
            if (needsLinkConfirm && !await resolveUnappliedChanges(hasUnappliedLinkPanelChanges, applyLinkPanel,
                () => { linkPanelDisplayedValues = null; })) return false;
            if (!await closePanel()) return false;
            return finish();
        })();
    }
    closePanel();
    return finish();
}

function showLinkPanel(panel, group, { summary = false } = {}) {
    closeToolbarMenu();
    panel.classList.remove('hidden');
    panel.hidden = false;
    document.body.classList.add('panel-open');
    const showEndpoints = summary || group?.rack_projected;
    if (showEndpoints) {
        setTextContent('lp-group-endpoints', `${displayedLinkEndpointName(group.from_id)} ↔ ${displayedLinkEndpointName(group.to_id)}`);
    }
    for (const [id, hidden] of [
        ['lp-group-summary', !summary], ['lp-detail-id', summary], ['lp-detail-fields', summary], ['lp-detail-actions', summary],
        ['lp-group-endpoints', !showEndpoints], ['lp-group-back', summary || !(group?.link_ids.length > 1)]
    ]) {
        const element = document.getElementById(id);
        if (element) element.hidden = hidden;
    }
}

function populateLinkGroupSummary(group, panel) {
    appState.editingLinkId = null;
    linkPanelDisplayedValues = null;
    linkPanelPortDraft = null;
    closeLinkSystemPicker();
    clearAllLinkPanelErrors();
    showLinkPanel(panel, group, { summary: true });
    setTextContent('lp-group-title', `接続の明細（${group.link_ids.length}件）`);
    const list = document.getElementById('lp-group-connections');
    if (list) {
        const rows = group.link_ids.map(getCommonLink).filter(Boolean).map(link => [
            link.id, group.rack_projected ? describeRackLink(link) : describeLinkPorts(link, group.from_id)
        ]);
        if (rows.length !== list.children.length || rows.some(([id, text], index) =>
            String(id) !== list.children[index].dataset.linkId || text !== list.children[index].textContent)) {
            list.replaceChildren(...rows.map(([id, text]) => {
                const item = document.createElement('li');
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'btn btn-secondary btn-sm link-detail-choice';
                item.dataset.linkId = String(id);
                button.textContent = text;
                button.addEventListener('click', async () => {
                    const current = getEditingLinkGroup();
                    if (current?.link_ids.includes(Number(id)) && await openLinkTarget(id, current)) {
                        document.getElementById('lp-group-back')?.focus();
                    }
                });
                item.append(button);
                return item;
            }));
        }
    }
    setLinkPanelReadOnly(!isCurrentUserAdmin());
}

function refreshOpenLinkPanel() {
    if (typeof document === 'undefined') return;
    const panel = document.getElementById('link-panel');
    if (!panel || panel.hidden) return;
    const link = getCommonLink(appState.editingLinkId);
    if (hasUnappliedLinkPanelChanges()) {
        refreshLinkPanelVlans(link);
        return;
    }
    const group = link ?
        getCurrentLinkGroups().find(row => row.link_ids.includes(Number(link.id))) ?? null : getEditingLinkGroup();
    appState.editingLinkGroupKey = group?.display_key ?? null;
    if (link) populateLinkPanelForm(link, panel, group);
    else if (group?.link_ids.length > 1) populateLinkGroupSummary(group, panel);
    else {
        const remaining = group && getCommonLink(group.link_ids[0]);
        if (remaining) populateLinkPanelForm(remaining, panel, group);
        else finishCloseLinkPanel(panel);
    }
}

function populateLinkPanelForm(link, panel, group = getEditingLinkGroup()) {
    appState.editingLinkId = Number(link.id);
    showLinkPanel(panel, group);
    clearAllLinkPanelErrors();
    setTextContent('lp-detail-id', `接続 #${link.id}`);
    setTextContent('lp-from-device', linkDeviceName(link.from_id));
    setTextContent('lp-to-device', linkDeviceName(link.to_id));
    const fromEndpoint = document.getElementById('lp-from-endpoint');
    const toEndpoint = document.getElementById('lp-to-endpoint');
    if (fromEndpoint && toEndpoint) {
        if (Number(link.from_id) <= Number(link.to_id)) {
            if (fromEndpoint.nextElementSibling !== toEndpoint) fromEndpoint.after(toEndpoint);
        } else if (toEndpoint.nextElementSibling !== fromEndpoint) {
            toEndpoint.after(fromEndpoint);
        }
    }
    setInputValue('lp-label', link.label);
    populateLinkSystemPicker(document.getElementById('lp-system'), link.system_id, updatePanelDraft);
    setInputValue('lp-from-port', resolvePanelPort(link, 'from'));
    setInputValue('lp-to-port', resolvePanelPort(link, 'to'));
    linkPanelPortDraft = {
        linkRevision: link.resource_revision,
        legacyVlan: unmigratedVlanForLink(link.id)?.vlan,
        ports: {}
    };
    setInputValue('lp-memo', link.memo);
    linkPanelDisplayedValues = readPanelValues(linkFields);
    updatePanelConflictButtons();

    updateAllLengthFeedback();

    setLinkPanelReadOnly(
        !isCurrentUserAdmin()
    );
    return true;
}


export function setLinkPanelReadOnly(
    readOnly
) {
    const panel =
        document.getElementById(
            'link-panel'
        );

    if (!panel) {
        return;
    }

    panel
        .querySelectorAll(
            'input, textarea'
        )
        .forEach(element => {
            element.readOnly = readOnly || linkPanelSaveBlocked();

            if (readOnly) {
                element.title =
                    '閲覧専用です';
            } else {
                element.removeAttribute(
                    'title'
                );
            }
        });
    const systemSelect = document.getElementById('lp-system');
    if (systemSelect) {
        systemSelect.disabled = readOnly || linkPanelSaveBlocked();
        systemSelect.title = readOnly ? '閲覧専用です' : '';
    }
    for (const option of document.getElementById('lp-system-options')?.children || []) option.disabled = readOnly || linkPanelSaveBlocked();
    if (readOnly || linkPanelSaveBlocked()) closeLinkSystemPicker();
    linkPanelReadOnly = readOnly;
    refreshLinkPanelVlans(getCommonLink(appState.editingLinkId));
    updatePanelConflictButtons();
    eventBus.emit('link-route:selection-changed');
}


export function formatLinkEndpoint(device) {
    if (!device) {
        return '(機器が見つかりません)';
    }

    const name =
        normalizeText(device.name) ||
        `ID ${device.id}`;

    const ip =
        normalizeText(device.ip);

    return ip
        ? `${name} (${ip})`
        : name;
}

/**
 * リンク詳細パネルの内容反映
 */
export function applyLinkPanel(options = {}) {
    const {
        showMessage = true,
        rerender = true,
        focusError = showMessage
    } = options;
    const fieldErrorOpts = { focus: focusError };
    const reportError = (id, errorId, message) => setLinkFieldError(id, errorId, message, fieldErrorOpts);

    if (!requireAdminUiAction() || linkPanelReadOnly || appState.authExpired || linkPanelSaveBlocked()) {
        return false;
    }

    if (appState.editingLinkId === null) {
        if (showMessage) {
            showToast(
                '編集対象の接続がありません',
                'warning'
            );
        }
        return false;
    }

    const target = getCommonLink(appState.editingLinkId);

    if (!target) {
        if (showMessage) {
            showToast(
                '編集対象の接続が見つかりません',
                'warning'
            );
        }
        return false;
    }
    const conflict = linkPanelConflictTarget()?.[0];
    if (conflict === 'links' || conflict === 'device_ports') {
        updatePanelConflictButtons();
        if (showMessage) showToast('競合対象を再読込してください', 'warning');
        return false;
    }

    clearAllLinkPanelErrors();

    const label = getTrimmedInputValue('lp-label');
    const fromPort = getTrimmedInputValue('lp-from-port');
    const toPort = getTrimmedInputValue('lp-to-port');
    const memo = getTrimmedInputValue('lp-memo');
    const systemValue = getTrimmedInputValue('lp-system');
    const systemId = systemValue === '' ? null : Number(systemValue);
    if (systemId !== null && (!Number.isInteger(systemId) || systemId <= 0 || !getLinkSystem(systemId))) {
        reportError('lp-system', 'lp-system-error', '接続系統を選び直してください');
        return false;
    }

    if (Array.from(label).length > 100) {
        reportError('lp-label', 'lp-label-error', 'ラベルは100文字以内で入力してください');
        return false;
    }

    if (Array.from(fromPort).length > 50) {
        reportError('lp-from-port', 'lp-from-port-error', 'ポートは50文字以内で入力してください');
        return false;
    }

    if (Array.from(toPort).length > 50) {
        reportError('lp-to-port', 'lp-to-port-error', 'ポートは50文字以内で入力してください');
        return false;
    }

    if (Array.from(memo).length > 1000) {
        reportError('lp-memo', 'lp-memo-error', '備考は1000文字以内で入力してください');
        return false;
    }

    const ports = { from: fromPort, to: toPort };
    const fields = Object.fromEntries(Object.entries({ label, memo, system_id: systemValue })
        .filter(([field, value]) => value !== linkPanelDisplayedValues?.[field])
        .map(([field, value]) => [field, field === 'system_id' ? systemId : value]));
    const portChanged = side => normalizePortName(ports[side]) !== normalizePortName(linkPanelDisplayedValues?.[`${side}_port`]);
    const pending = unmigratedVlanForLink(target.id);
    const vlanChanged = linkSides.some(side => {
        if (!hasVlanInputChange(side)) return false;
        const value = document.getElementById(`lp-${side}-vlan-input`).value;
        return !isValidPortVlan(value) || value.replace(/^ +| +$/g, '') !== linkPanelPortDraft.ports[side].vlan;
    });
    if (vlanChanged || (pending && linkSides.some(side => normalizePortName(ports[side]) && portChanged(side)))) {
        return applyLinkPanelPortSettings(target, pending, ports, portChanged, fields, reportError);
    }

    const before = JSON.stringify(toSaveLink(target));
    for (const side of linkSides) {
        if (portChanged(side)) target[`${side}_port_name`] = ports[side];
    }
    Object.assign(target, fields);

    if (before !== JSON.stringify(toSaveLink(target))) markDirty();
    populateLinkPanelForm(target, document.getElementById('link-panel'));
    scheduleSave({ immediate: true, silent: true });
    updatePanelConflictButtons();
    if (rerender) render();

    return true;
}

function applyLinkPanelPortSettings(target, pending, ports, portChanged, link, reportError) {
    const panel = document.getElementById('link-panel');
    const fail = (id, message) => {
        reportError(id, `${id}-error`, message);
        return false;
    };
    const draft = linkPanelPortDraft;
    if (!draft || Number(target.resource_revision) !== Number(draft.linkRevision) || pending?.vlan !== draft.legacyVlan) {
        const side = linkSides.find(side => hasVlanInputChange(side) || portChanged(side));
        const id = hasVlanInputChange(side) ? `lp-${side}-vlan-input` : `lp-${side}-port`;
        return fail(id, '接続の情報が変更されました。変更を取り消して最新の状態を確認してください');
    }
    const devicePorts = [];
    const newPorts = [];
    let reconfiguredVlan = false;
    for (const side of linkSides) {
        const name = normalizePortName(ports[side]);
        const nameChanged = portChanged(side);
        const vlanChanged = hasVlanInputChange(side);
        if (!nameChanged && !vlanChanged) continue;
        if (!name) {
            link[`${side}_port_id`] = null;
            continue;
        }
        const portInputId = `lp-${side}-port`;
        const vlanInputId = `lp-${side}-vlan-input`;
        const selected = draft.ports[side];
        const current = linkPanelPort(target, side, name);
        if (!selected || selected.name !== name || selected.id !== current?.id ||
            (vlanChanged && current && Number(selected.revision) !== Number(current.resource_revision))) {
            return fail(vlanChanged ? vlanInputId : portInputId, 'ポートの情報が変更されました。変更を取り消して最新の状態を確認してください');
        }
        const vlan = vlanChanged ? document.getElementById(vlanInputId).value : selected.vlan;
        if (vlanChanged && !isValidPortVlan(vlan)) {
            return fail(vlanInputId, 'VLAN設定は 1 行、200 文字以内で指定してください');
        }
        const changedVlan = vlanChanged && vlan.replace(/^ +| +$/g, '') !== selected.vlan;
        reconfiguredVlan ||= changedVlan || Boolean(current?.resource_revision > 0 && current.vlan &&
            current.id !== target[`${side}_port_id`]);
        if (current) {
            if (nameChanged) link[`${side}_port_id`] = selected.id;
            if (changedVlan) {
                devicePorts.push({ operation: 'update', id: selected.id, expected_revision: selected.revision, port: { vlan } });
            }
        } else {
            link[`${side}_port_name`] = name;
            newPorts.push({ device_id: Number(target[`${side}_id`]), name, vlan });
        }
    }
    if (!Object.keys(link).length && !devicePorts.length) {
        populateLinkPanelForm(target, panel);
        return true;
    }
    for (const port of newPorts) devicePorts.push({ operation: 'create', id: allocateLocalId('devicePorts'), port });
    const batch = {
        ...(pending && reconfiguredVlan ? { complete_legacy_vlan: Number(target.id) } : {}),
        device_ports: devicePorts,
        links: [{ operation: 'update', id: Number(target.id), expected_revision: Number(draft.linkRevision), link }]
    };
    return submitLinkPanelPortSettings(batch);
}

async function submitLinkPanelPortSettings(batch) {
    linkPanelSubmission = batch;
    setLinkPanelMutationBusy(true);
    try {
        return await saveConnectionBatch(batch);
    } finally {
        if (getPendingSave()?.payload !== batch) linkPanelSubmission = null;
        setLinkPanelMutationBusy(false);
    }
}


export function getTrimmedInputValue(id) {
    const element =
        document.getElementById(id);

    return element
        ? String(element.value || '').trim()
        : '';
}

/**
 * リンク詳細パネルを閉じる
 */

/**
 * リンク詳細パネルを閉じる
 */
export function closeLinkPanel() {
    if (linkPanelMutationBusy) return false;
    const panel =
        document.getElementById('link-panel');

    if (!panel) {
        appState.editingLinkGroupKey = null;
        return true;
    }

    if (hasUnappliedLinkPanelChanges()) {
        return (async () => {
            if (!await resolveUnappliedChanges(hasUnappliedLinkPanelChanges, applyLinkPanel, () => { linkPanelDisplayedValues = null; })) return false;
            finishCloseLinkPanel(panel);
            return true;
        })();
    }

    finishCloseLinkPanel(panel);
    return true;
}

function finishCloseLinkPanel(panel) {
    const wasSelected = appState.editingLinkId != null || appState.editingLinkGroupKey != null;
    closeLinkSystemPicker();
    clearAllLinkPanelErrors();
    panel.classList.add('hidden');
    panel.hidden = true;
    appState.editingLinkId = null;
    appState.editingLinkGroupKey = null;
    linkPanelDisplayedValues = null;
    linkPanelPortDraft = null;
    if (document.getElementById('panel')?.hidden) {
        document.body.classList.remove('panel-open');
    }
    updatePanelConflictButtons();
    eventBus.emit('link-route:selection-changed');
    if (wasSelected) eventBus.emit('canvas:render-links');
}

/**
 * 編集中のリンクを削除
 */

/**
 * 編集中のリンクを削除
 */
export function deleteEditingLink() {
    if (!requireAdminUiAction() || linkPanelReadOnly || appState.authExpired || linkPanelSaveBlocked()) {
        return;
    }
    if (appState.editingLinkId === null) {
        if (appState.editingLinkGroupKey != null) return;
        showToast(
            '削除対象の接続がありません',
            'warning'
        );
        return;
    }

    const link = getCommonLink(appState.editingLinkId);

    if (!link) {
        showToast(
            '削除対象の接続が見つかりません',
            'warning'
        );

        appState.editingLinkId = null;
        closeLinkPanel();
        render();
        return;
    }
    if (hasResourceConflict('links', link.id)) {
        updatePanelConflictButtons();
        showToast('競合している接続は削除できません。対象を再読込してください', 'warning');
        return;
    }

    const draftWarning = hasUnappliedLinkPanelChanges() ? '\n未適用の入力は破棄されます。' : '';
    const legacyVlanWarning = unmigratedVlanForLink(link.id)
        ? '\nこの接続の未移行VLANも削除されます。' : '';
    if (!confirm(`接続 #${link.id} を削除しますか？ この接続を表示するすべてのビューとポート台帳で接続が解除されます。ポート自体は削除されません。${draftWarning}${legacyVlanWarning}`)) {
        return;
    }

    appState.links = appState.links.filter(item => Number(item.id) !== Number(link.id));
    if (!link.resource_revision) {
        const pair = pairKey(link.from_id, link.to_id);
        if (!appState.links.some(row => pairKey(row.from_id, row.to_id) === pair) &&
            !appState.legacyLinkConflicts.some(row => pairKey(row.device_a_id, row.device_b_id) === pair)) {
            appState.viewLinkRoutes = appState.viewLinkRoutes.filter(row => pairKey(row.device_a_id, row.device_b_id) !== pair);
        }
    }

    markDirty();
    scheduleSave({ immediate: true, silent: true });
    appState.editingLinkId = null;
    linkPanelDisplayedValues = null;
    refreshOpenLinkPanel();
    render();

}

/**
 * 表示中ビューから配置を外す。
 * 機器台帳自体は削除しない。
 */
export async function deleteSelected() {
    if (!requireAdminUiAction()) {
        return;
    }
    if (hasResourceConflict('views', appState.currentViewId)) {
        updatePanelConflictButtons();
        showToast('競合しているビューの配置は外せません。対象を再読込してください', 'warning');
        return;
    }
    if (getSelectedFloorRackPlacement()) return removeSelectedFloorRack();

    if (
        appState.selectedPlacementIds.size === 0
    ) {
        showToast(
            '外す機器配置を選択してください',
            'warning'
        );
        return;
    }

    const count =
        appState.selectedPlacementIds.size;

    if (
        !confirm(
            `${count}台をこのビューから外しますか?\n` +
            '機器台帳・共通接続・手動経路・他ビューの配置は保持されます。'
        )
    ) {
        return;
    }
    if (!await closePanel() || !await closeLinkPanel()) return;

    appState.placements = appState.placements.filter(
        placement =>
            !appState.selectedPlacementIds.has(
                Number(placement.id)
            )
    );

    markDirty();
    scheduleSave({ immediate: true, silent: true });
    appState.selectedPlacementIds.clear();
    render();

}


/**
 * パネル表示の同期
 */

/**
 * パネル表示の同期
 */
export function syncPanelIfOpen() {
    if (appState.editingDeviceId === null) {
        return;
    }

    const panel = document.getElementById('panel');

    if (!panel || panel.classList.contains('hidden') || panel.hidden) {
        return;
    }

    const device = appState.devices.find(
        device =>
            Number(device.id) ===
            Number(appState.editingDeviceId)
    );

    if (!device) {
        closePanel();
        return;
    }
    syncPlacementCoordinateInputs(getPlacementForDeviceInCurrentView(device.id), true);
    const draft = getDeviceDraft('panel', device.id);
    if (panelDisplayedValues) {
        const currentDom = readPanelValues(panelFields);
        const latestSource = draft || device;
        for (const [field, elementId] of Object.entries(panelFields)) {
            if (currentDom[field] !== panelDisplayedValues[field]) continue;
            const rawLatest = latestSource[field];
            const latestStr = rawLatest === null || rawLatest === undefined ? '' : String(rawLatest).trim();
            if (latestStr === panelDisplayedValues[field]) continue;
            if (field === 'type') {
                createDeviceTypePicker({
                    control: document.getElementById('p-type'),
                    value: latestSource.type,
                    disabled: !isCurrentUserAdmin(),
                    onChange: input => updatePanelDraft(input)
                });
            } else if (field === 'floor_id') {
                populateFloorSelect(document.getElementById('p-floor-id'), appState, latestSource.floor_id);
            } else {
                setInputValue(elementId, latestSource[field] ?? '');
            }
            panelDisplayedValues[field] = getTrimmedInputValue(elementId);
            if (field === 'ip') document.getElementById('p-ip-notice')?.refresh?.();
        }
    }
    updatePanelMonitoringSummary(device, draft?.memo ?? device.memo);

    const lastChecked = document.getElementById('p-last-checked');
    if (lastChecked) {
        lastChecked.textContent = device.last_checked_at || '-';
    }

    const responseMs = document.getElementById('p-response-ms');
    if (responseMs) {
        responseMs.textContent =
            device.last_response_ms !== null && device.last_response_ms !== undefined
                ? `${device.last_response_ms}ms`
                : '-';
    }

    const lastError = document.getElementById('p-last-error');
    if (lastError) {
        lastError.textContent = device.last_error || '-';
    }
}

/**
 * 次ID再計算
 */

export function renderPanelPlacementSummary(device) {
    const countElement =
        document.getElementById(
            'p-placement-count'
        );

    const listElement =
        document.getElementById(
            'p-placement-view-list'
        );

    if (
        !device ||
        !countElement ||
        !listElement
    ) {
        return;
    }

    const placedViews =
        getPlacedViewsForDevice(
            device.id
        );

    countElement.textContent =
        `${placedViews.length}件`;

    listElement.replaceChildren();

    if (placedViews.length === 0) {
        listElement.textContent =
            'どのビューにも配置されていません';
        return;
    }

    placedViews
        .slice(0, 4)
        .forEach(view => {
            const item =
                document.createElement('div');

            item.className =
                'device-placement-view-item';

            item.textContent =
                buildViewOptionLabel(view);

            listElement.appendChild(item);
        });

    if (placedViews.length > 4) {
        const more =
            document.createElement('div');

        more.className =
            'device-placement-view-item';

        more.textContent =
            `ほか${placedViews.length - 4}件`;

        listElement.appendChild(more);
    }
}


export async function openPlacementManagerFromPanel() {
    if (!requireAdminUiAction()) {
        return;
    }

    if (hasUnappliedPanelChanges() && !await resolveUnappliedChanges(hasUnappliedPanelChanges, applyPanelValues, () => {
        discardDeviceDraft('panel', appState.editingDeviceId);
        panelDisplayedValues = null;
        openPanel(getDeviceById(appState.editingDeviceId));
    })) return false;

    eventBus.emit(
        'placement-manager:open',
        appState.editingDeviceId
    );
}


/**
 * ==========================================
 * 機器台帳からの完全削除（全ビュー削除）
 * ==========================================
 */

export async function deleteDeviceCompletely(deviceIds, { deviceName = null } = {}) {
    if (!requireAdminUiAction()) {
        return false;
    }
    if (appState.authExpired || appState.appStatus?.state === 'unconfirmed' || isSaveInFlight()) {
        showToast('現在の状態では削除できません。保存やログイン状態を確認してください', 'warning');
        return false;
    }

    const targetIds = (deviceIds || [])
        .map(Number)
        .filter(id => Number.isInteger(id) && id > 0);

    if (targetIds.length === 0) {
        return false;
    }
    if (targetIds.some(id => hasResourceConflict('devices', id))) {
        updatePanelConflictButtons();
        showToast('競合している機器は削除できません。対象を再読込してください', 'warning');
        return false;
    }
    const targetSet = new Set(targetIds);
    if (!await closeLinkPanel()) return false;
    if (appState.editingDeviceId !== null && !targetSet.has(Number(appState.editingDeviceId)) && !await closePanel()) {
        return false;
    }

    const confirmed = confirm(
        (deviceName !== null && targetIds.length === 1
            ? `機器「${deviceName}」を完全削除しますか?\n\n`
            : `選択された ${targetIds.length}台の機器を完全削除しますか?\n\n`) +
        'すべてのビュー上の配置、および関連する接続・ポート・手動経路が永久に削除されます。'
    );

    if (!confirmed) {
        return false;
    }
    if (appState.editingDeviceId !== null && targetSet.has(Number(appState.editingDeviceId))) {
        discardDeviceDraft('panel', appState.editingDeviceId);
        panelDisplayedValues = null;
        await closePanel();
    }

    removeDevicesFromState(targetIds);
    discardDeviceDraftsForIds(targetIds);

    markDirty();
    scheduleSave({ immediate: true, silent: true });
    appState.selectedPlacementIds.clear();
    render();


    return true;
}

export function deleteDeviceCompletelyFromPanel() {
    if (!requireAdminUiAction()) {
        return;
    }
    if (appState.editingDeviceId === null) {
        showToast('削除対象の機器がありません', 'warning');
        return;
    }

    const device = getDeviceById(appState.editingDeviceId);
    if (!device) {
        showToast('削除対象の機器が見つかりません', 'warning');
        return;
    }

    return deleteDeviceCompletely([Number(device.id)]);
}

export function jumpToManagementSettings() {
    const group = document.getElementById('p-group-management');
    if (group) {
        group.open = true;
    }
    const target = document.getElementById('p-management-scheme');
    if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        target.focus();
    }
}
