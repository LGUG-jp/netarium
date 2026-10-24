/**
 * Netarium - ui/property-panel.js
 */

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
    getCurrentLinks,
    getCurrentPlacements,
    getDeviceById,
    getPlacedViewsForDevice,
    getPlacementForDeviceInCurrentView,
    removeDevicesFromState,
    toSaveLink
} from '../core/state.js';
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
import { scheduleSave, hasResourceConflict, reloadConflictedResource, hasResourceChanges, isSaveInFlight } from '../core/save-queue.js';
import { getDeviceDraft, commitDeviceDraft, discardDeviceDraft, hasDeviceDraftChanges } from '../core/device-drafts.js';
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
        const copyButton = event.target?.closest?.('#p-copy-link-btn');
        if (copyButton) {
            await copyShareLink({ viewId: appState.currentViewId, deviceId: appState.editingDeviceId }, copyButton);
            return;
        }
        const button = event.target?.closest?.('#p-reload-conflict-btn, #lp-reload-conflict-btn');
        if (!button) return;
        const isDevice = button.id === 'p-reload-conflict-btn';
        const kind = isDevice ? 'devices' : 'views';
        const id = isDevice ? appState.editingDeviceId : appState.currentViewId;
        await reloadConflictedResource(kind, id);
    });
}

let panelDisplayedValues = null;
let linkPanelDisplayedValues = null;
let linkPanelEndpointsSwapped = false;
let devicePanelReadOnly = false;
let linkPanelReadOnly = false;
const panelFields = {
    name: 'p-name', type: 'p-type', ip: 'p-ip', facility: 'p-facility',
    floor: 'p-floor', location: 'p-location', manufacturer: 'p-manufacturer',
    model: 'p-model', asset_number: 'p-asset-number', serial_number: 'p-serial-number',
    mac_address: 'p-mac-address', memo: 'p-memo', install_date: 'p-install-date',
    management_scheme: 'p-management-scheme', management_port: 'p-management-port',
    department: 'p-department', maintenance_vendor: 'p-maintenance-vendor',
    maintenance_expiry: 'p-maintenance-expiry'
};
const linkFields = {
    label: 'lp-label', from_port: 'lp-from-port', to_port: 'lp-to-port',
    vlan: 'lp-vlan', memo: 'lp-memo', system_id: 'lp-system'
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
            draft[field] = field === 'management_port' ? (value === '' ? null : (/^\d+$/.test(value) ? Number(value) : value)) : value;
        }
        const errors = validateDeviceValues({ ...draft, ...readPanelValues(panelFields) }, appState.devices).errors;
        for (const [field, id] of Object.entries(panelFields)) {
            const input = document.getElementById(id);
            if (id === target.id || input?.getAttribute('aria-invalid') === 'true') {
                setInputError(input, document.getElementById(`${id}-error`), errors[field]);
            }
        }
        updatePanelSummaries(draft);
        eventBus.emit('device-drafts:changed');
    }
    if (target.id.startsWith('lp-') && target.closest?.('#link-panel')) {
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

function updatePanelConflictButtons() {
    if (typeof document === 'undefined') return;
    const deviceButton = document.getElementById('p-reload-conflict-btn');
    const linkButton = document.getElementById('lp-reload-conflict-btn');
    if (deviceButton) deviceButton.hidden = !hasResourceConflict('devices', appState.editingDeviceId);
    if (linkButton) linkButton.hidden = !hasResourceConflict('views', appState.currentViewId);
    for (const { buttonId, kind, id, readOnly, hasChanges } of [
        { buttonId: 'p-apply-btn', kind: 'devices', id: appState.editingDeviceId, readOnly: devicePanelReadOnly, hasChanges: hasUnappliedPanelChanges },
        { buttonId: 'lp-apply-btn', kind: 'views', id: appState.currentViewId, readOnly: linkPanelReadOnly, hasChanges: hasUnappliedLinkPanelChanges }
    ]) {
        const button = document.getElementById(buttonId);
        if (!button) continue;
        const hasTarget = (kind === 'devices' ? appState.editingDeviceId : appState.editingLinkId) !== null;
        const canRetry = hasTarget && !isSaveInFlight() && appState.appStatus.state !== 'unconfirmed' && hasResourceChanges(kind, id);
        const reason = appState.authExpired ? '認証が失効しているため適用できません'
            : (!isCurrentUserAdmin() || readOnly) ? '管理者権限が必要です'
            : hasResourceConflict(kind, id) ? '競合対象を再読込してください'
            : !hasChanges() && !canRetry ? '未適用の変更はありません' : '';
        button.disabled = reason !== '';
        button.setAttribute('aria-disabled', button.disabled ? 'true' : 'false');
        if (reason) button.title = reason;
        else button.removeAttribute('title');
    }
    const swapButton = document.getElementById('lp-swap-btn');
    if (swapButton) {
        const reason = appState.authExpired ? '認証が失効しているため入れ替えできません'
            : (!isCurrentUserAdmin() || linkPanelReadOnly) ? '管理者権限が必要です'
            : appState.editingLinkId === null || !linkPanelDisplayedValues ? '接続を選択してください'
            : hasResourceConflict('views', appState.currentViewId) ? '競合対象を再読込してください' : '';
        swapButton.disabled = reason !== '';
        swapButton.setAttribute('aria-disabled', String(swapButton.disabled));
        if (reason) swapButton.title = reason;
        else swapButton.removeAttribute('title');
    }
}

eventBus.on('resource:conflict', updatePanelConflictButtons);
eventBus.on('save-state:changed', updatePanelConflictButtons);
eventBus.on('device-drafts:changed', updatePanelConflictButtons);
eventBus.on('resource:reloaded', ({ kind, id }) => {
    if (typeof document === 'undefined') return;
    if (kind === 'devices' && Number(id) === Number(appState.editingDeviceId)) {
        panelDisplayedValues = null;
        discardDeviceDraft('panel', id);
        const device = getDeviceById(id);
        if (device) openPanel(device);
        else closePanel();
    }
    if (kind === 'views' && Number(id) === Number(appState.currentViewId)) {
        linkPanelDisplayedValues = null;
        const link = getCurrentLinks().find(item => Number(item.id) === Number(appState.editingLinkId));
        if (link) openLinkPanel(link);
        else closeLinkPanel();
    }
    updatePanelConflictButtons();
});
eventBus.on('resources:reloaded', () => {
    panelDisplayedValues = null;
    linkPanelDisplayedValues = null;
    updatePanelConflictButtons();
});
eventBus.on('link-systems:changed', () => {
    if (typeof document === 'undefined') return;
    const selector = document.getElementById('lp-system');
    if (!selector) return;
    populateLinkSystemPicker(selector, selector.value, updatePanelDraft);
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

    const placementText = [device.facility, device.floor, device.location]
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
    return Boolean(linkPanelDisplayedValues && (linkPanelEndpointsSwapped ||
        Object.keys(linkFields).some(field => current[field] !== linkPanelDisplayedValues[field])));
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
    if (appState.editingLinkId === null) return false;
    const link = getCurrentLinks().find(item => Number(item.id) === Number(appState.editingLinkId));
    if (!link) return false;
    if (hasUnappliedLinkPanelChanges() && !window.confirm('未適用の入力を破棄して最後に確定した値に戻しますか？')) return false;
    linkPanelDisplayedValues = null;
    openLinkPanel(link);
    return true;
}

export function swapLinkPanelEndpoints() {
    if (!requireAdminUiAction() || linkPanelReadOnly || appState.authExpired ||
        !linkPanelDisplayedValues || hasResourceConflict('views', appState.currentViewId)) return false;
    const link = getCurrentLinks().find(item => Number(item.id) === Number(appState.editingLinkId));
    const fromPort = document.getElementById('lp-from-port');
    const toPort = document.getElementById('lp-to-port');
    if (!link || !fromPort || !toPort) return false;
    const value = fromPort.value;
    fromPort.value = toPort.value;
    toPort.value = value;
    linkPanelEndpointsSwapped = !linkPanelEndpointsSwapped;
    setTextContent('lp-from-device', formatLinkEndpoint(getDeviceById(
        linkPanelEndpointsSwapped ? link.to_id : link.from_id)));
    setTextContent('lp-to-device', formatLinkEndpoint(getDeviceById(
        linkPanelEndpointsSwapped ? link.from_id : link.to_id)));
    for (const id of ['lp-from-port', 'lp-to-port']) {
        setInputError(document.getElementById(id), document.getElementById(`${id}-error`), '');
    }
    updateAllLengthFeedback();
    eventBus.emit('device-drafts:changed');
    return true;
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

    setInputValue('p-coord-x', clamped.x);
    setInputValue('p-coord-y', clamped.y);

    markDirty();
    scheduleSave({ immediate: true, silent: true });
    render();

}
/**
 * 編集パネル表示
 */
export function openPanel(device) {
    for (const field of ['facility', 'floor', 'location']) {
        bindLocationSuggestion(document.getElementById(`p-${field}`), field);
    }
    const panel = document.getElementById('panel');

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

    setInputValue('p-facility', device.facility);
    setInputValue('p-floor', device.floor);
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

    const placement = getPlacementForDeviceInCurrentView(device.id);
    if (placement) {
        setInputValue('p-coord-x', Math.round(placement.x));
        setInputValue('p-coord-y', Math.round(placement.y));
    } else {
        setInputValue('p-coord-x', '');
        setInputValue('p-coord-y', '');
    }

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
    const facility = getTrimmedInputValue('p-facility');
    const floor = getTrimmedInputValue('p-floor');
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
        id: device.id, name, type, ip, facility, floor, location, manufacturer, model,
        asset_number: assetNumber, serial_number: serialNumber, mac_address: macAddress,
        memo, install_date: installDate, management_scheme: scheme, management_port: portStr,
        department, maintenance_vendor: maintenanceVendor, maintenance_expiry: maintenanceExpiry
    }, appState.devices);
    const groups = {
        name: 'basic', ip: 'basic', facility: 'placement', floor: 'placement', location: 'placement',
        manufacturer: 'asset', model: 'asset', asset_number: 'asset', serial_number: 'asset',
        mac_address: 'asset', install_date: 'asset', memo: 'extra'
    };
    const errors = Object.entries(result.errors);
    errors.forEach(([field, message], index) => {
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
        name, type, ip, facility, floor, location, manufacturer, model,
        asset_number: assetNumber, serial_number: serialNumber, mac_address: macAddress,
        memo, install_date: installDate, management_scheme: scheme,
        management_port: portStr !== '' ? Number(portStr) : null,
        department, maintenance_vendor: maintenanceVendor, maintenance_expiry: maintenanceExpiry
    };
    const draft = getDeviceDraft('panel', device.id);
    if (!draft) return false;
    const domValues = readPanelValues(panelFields);
    for (const [field, value] of Object.entries(values)) {
        if (!panelDisplayedValues || domValues[field] !== panelDisplayedValues[field] ||
            String(draft[field] ?? '') !== panelDisplayedValues[field]) {
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

/**
 * リンク詳細パネル表示
 */

/**
 * リンク詳細パネル表示
 */
export function openLinkPanel(link) {
    const panel = document.getElementById('link-panel');

    if (!panel || !link) {
        return false;
    }
    if (Number(appState.editingLinkId) === Number(link.id) && hasUnappliedLinkPanelChanges()) {
        return true;
    }

    const needsLinkConfirm = appState.editingLinkId !== null && Number(appState.editingLinkId) !== Number(link.id) && hasUnappliedLinkPanelChanges();
    const needsDeviceConfirm = hasUnappliedPanelChanges();

    if (needsLinkConfirm || needsDeviceConfirm) {
        return (async () => {
            if (needsLinkConfirm && !await resolveUnappliedChanges(hasUnappliedLinkPanelChanges, applyLinkPanel, () => { linkPanelDisplayedValues = null; })) {
                return false;
            }
            if (needsDeviceConfirm) {
                if (!await closePanel()) return false;
            } else {
                closePanel();
            }
            populateLinkPanelForm(link, panel);
            return true;
        })();
    }

    closePanel();
    populateLinkPanelForm(link, panel);
    return true;
}

function populateLinkPanelForm(link, panel) {
    linkPanelEndpointsSwapped = false;
    closeToolbarMenu();
    const fromDevice = appState.devices.find(
        device =>
            Number(device.id) ===
            Number(link.from_id)
    );
    const toDevice = appState.devices.find(
        device =>
            Number(device.id) ===
            Number(link.to_id)
    );
    appState.editingLinkId = Number(link.id);
    panel.classList.remove('hidden');
    panel.hidden = false;
    document.body.classList.add('panel-open');

    clearAllLinkPanelErrors();

    setTextContent(
        'lp-from-device',
        formatLinkEndpoint(fromDevice)
    );

    setTextContent(
        'lp-to-device',
        formatLinkEndpoint(toDevice)
    );

    setInputValue('lp-label', link.label);
    populateLinkSystemPicker(document.getElementById('lp-system'), link.system_id, updatePanelDraft);
    setInputValue(
        'lp-from-port',
        link.from_port
    );
    setInputValue(
        'lp-to-port',
        link.to_port
    );
    setInputValue('lp-vlan', link.vlan);
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
    const systemSelect = document.getElementById('lp-system');
    if (systemSelect) {
        systemSelect.disabled = readOnly;
        systemSelect.title = readOnly ? '閲覧専用です' : '';
    }
    for (const option of document.getElementById('lp-system-options')?.children || []) option.disabled = readOnly;
    if (readOnly) closeLinkSystemPicker();
    linkPanelReadOnly = readOnly;
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

    if (!requireAdminUiAction() || linkPanelReadOnly || appState.authExpired) {
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

    const link = getCurrentLinks().find(
        item =>
            Number(item.id) ===
            Number(appState.editingLinkId)
    );

    if (!link) {
        if (showMessage) {
            showToast(
                '編集対象の接続が見つかりません',
                'warning'
            );
        }
        return false;
    }
    if (hasResourceConflict('views', link.view_id)) {
        updatePanelConflictButtons();
        if (showMessage) showToast('この接続のビューは競合しています。対象を再読込してください', 'warning');
        return false;
    }

    clearAllLinkPanelErrors();

    const label = getTrimmedInputValue('lp-label');
    const fromPort = getTrimmedInputValue('lp-from-port');
    const toPort = getTrimmedInputValue('lp-to-port');
    const vlan = getTrimmedInputValue('lp-vlan');
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
        reportError('lp-from-port', 'lp-from-port-error', '接続元ポートは50文字以内で入力してください');
        return false;
    }

    if (Array.from(toPort).length > 50) {
        reportError('lp-to-port', 'lp-to-port-error', '接続先ポートは50文字以内で入力してください');
        return false;
    }

    if (Array.from(vlan).length > 100) {
        reportError('lp-vlan', 'lp-vlan-error', 'VLANは100文字以内で入力してください');
        return false;
    }

    if (Array.from(memo).length > 1000) {
        reportError('lp-memo', 'lp-memo-error', '備考は1000文字以内で入力してください');
        return false;
    }

    const before = JSON.stringify(toSaveLink(link));
    if (linkPanelEndpointsSwapped) {
        const fromId = link.from_id;
        link.from_id = link.to_id;
        link.to_id = fromId;
        if (link.route_mode === 'manual') link.manual_route.reverse();
    }

    const values = { label, from_port: fromPort, to_port: toPort, vlan, memo, system_id: systemValue };
    for (const [field, value] of Object.entries(values)) {
        if (!linkPanelDisplayedValues || value !== linkPanelDisplayedValues[field] ||
            (linkPanelEndpointsSwapped && (field === 'from_port' || field === 'to_port'))) link[field] = field === 'system_id' ? systemId : value;
    }

    const after = JSON.stringify(toSaveLink(link));
    if (before !== after) markDirty();
    linkPanelDisplayedValues = null;
    openLinkPanel(link);
    scheduleSave({ immediate: true, silent: true });
    updatePanelConflictButtons();
    if (rerender) render();

    return true;
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
    const panel =
        document.getElementById('link-panel');

    if (!panel) {
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
    closeLinkSystemPicker();
    clearAllLinkPanelErrors();
    panel.classList.add('hidden');
    panel.hidden = true;
    appState.editingLinkId = null;
    linkPanelDisplayedValues = null;
    if (document.getElementById('panel')?.hidden) {
        document.body.classList.remove('panel-open');
    }
    updatePanelConflictButtons();
    eventBus.emit('link-route:selection-changed');
}

/**
 * 編集中のリンクを削除
 */

/**
 * 編集中のリンクを削除
 */
export function deleteEditingLink() {
    if (!requireAdminUiAction()) {
        return;
    }
    if (appState.editingLinkId === null) {
        showToast(
            '削除対象の接続がありません',
            'warning'
        );
        return;
    }

    const link = getCurrentLinks().find(
        item =>
            Number(item.id) ===
            Number(appState.editingLinkId)
    );

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
    if (hasResourceConflict('views', link.view_id)) {
        updatePanelConflictButtons();
        showToast('競合しているビューの接続は削除できません。対象を再読込してください', 'warning');
        return;
    }

    if (!confirm('この接続を削除しますか?')) {
        return;
    }

    appState.links = appState.links.filter(
        item =>
            Number(item.id) !==
            Number(appState.editingLinkId)
    );

    markDirty();
    scheduleSave({ immediate: true, silent: true });
    appState.editingLinkId = null;
    closeLinkPanel();
    render();

}



export function deleteDevice() {
    if (
        appState.editingDeviceId !== null &&
        appState.selectedPlacementIds.size === 0
    ) {
        const placement =
            getPlacementForDeviceInCurrentView(
                appState.editingDeviceId
            );

        if (placement) {
            appState.selectedPlacementIds.add(
                Number(placement.id)
            );
        }
    }

    return deleteSelected();
}

/**
 * 表示中ビューから配置を外す。
 * 機器台帳自体は削除しない。
 */

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
            '機器台帳と他ビューの配置は削除されません。'
        )
    ) {
        return;
    }
    if (!await closePanel() || !await closeLinkPanel()) return;

    const removedPlacements =
        getCurrentPlacements().filter(
            placement =>
                appState.selectedPlacementIds.has(
                    Number(placement.id)
                )
        );

    const removedDeviceIds = new Set(
        removedPlacements.map(
            placement =>
                Number(
                    placement.device_id
                )
        )
    );

    appState.placements = appState.placements.filter(
        placement =>
            !appState.selectedPlacementIds.has(
                Number(placement.id)
            )
    );

    appState.links = appState.links.filter(link => {
        if (
            Number(link.view_id) !==
            Number(appState.currentViewId)
        ) {
            return true;
        }

        return (
            !removedDeviceIds.has(
                Number(link.from_id)
            ) &&
            !removedDeviceIds.has(
                Number(link.to_id)
            )
        );
    });

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
    const draft = getDeviceDraft('panel', device.id);
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

export async function deleteDeviceCompletely(deviceIds) {
    if (!requireAdminUiAction()) {
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

    const confirmed = confirm(
        `選択された ${targetIds.length}台の機器を完全削除しますか?\n\n` +
        'すべてのビュー上の配置、および関連するすべての接続が永久に削除されます。'
    );

    if (!confirmed) {
        return false;
    }
    if (!await closePanel() || !await closeLinkPanel()) return false;

    removeDevicesFromState(targetIds);

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
