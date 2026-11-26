import { appState, allocateLocalId, getCurrentPlacements, getCurrentView, getDeviceById, resetLinkCreationState } from './state.js';
import { normalizeLink, pairKey } from './connection-data.js';
import { eventBus } from './event-bus.js';
import { scheduleSave } from './save-queue.js';
import { assertLegacyLinkReviewable, saveLegacyLinkReplacement } from './legacy-link-review.js';
import { isCurrentUserAdmin, requireAdminUiAction } from '../ui/access-control.js';
import { markDirty } from '../ui/status-bar.js';
import { showToast } from '../ui/toast.js';

function canChooseEndpoint() {
    const view = getCurrentView();
    return appState.linkMode && view && (view.view_type !== 'rack' || appState.legacyLinkCreation) && !appState.authExpired;
}

function hasConnectionConflict() {
    return Boolean(appState.resourceConflicts.links?.size || appState.resourceConflicts.device_ports?.size);
}

export function canEditLinkCreation() {
    return Boolean(canChooseEndpoint() && isCurrentUserAdmin() && !appState.isPinging);
}

export function getLinkCreationTarget() {
    return appState.linkTargetId == null ? null : getDeviceById(appState.linkTargetId) ?? null;
}

export function getExistingLinkCreationConnections() {
    const target = getLinkCreationTarget();
    if (!target || appState.linkSourceId == null) return [];
    const pair = pairKey(appState.linkSourceId, target.id);
    return appState.links.filter(link => pairKey(link.from_id, link.to_id) === pair).sort((a, b) => a.id - b.id);
}

export function cancelLinkCreationTarget() {
    appState.linkTargetId = null;
}

export function chooseLinkCreationTarget(deviceId) {
    if (!canChooseEndpoint() || !requireAdminUiAction() || appState.linkSourceId == null ||
        !getDeviceById(appState.linkSourceId) || !getDeviceById(deviceId) ||
        Number(appState.linkSourceId) === Number(deviceId)) return false;
    if (appState.legacyLinkCreation && Number(deviceId) !== Number(appState.legacyLinkCreation.payload.to_id)) return false;
    appState.linkTargetId = Number(deviceId);
    return true;
}

function createConnection(deviceId, fromPort = '', toPort = '') {
    if (hasConnectionConflict()) {
        showToast('接続またはポートが競合しています。競合対象を再読込してください', 'warning');
        return false;
    }
    const link = normalizeLink({
        id: allocateLocalId('links'), from_id: appState.linkSourceId, to_id: deviceId
    });
    if (fromPort) link.from_port_name = fromPort;
    if (toPort) link.to_port_name = toPort;
    appState.links.push(link);
    const legacy = appState.legacyLinkCreation;
    const wasExplicit = appState.linkTargetId != null;
    if (legacy) endLinkMode();
    else {
        cancelLinkCreationTarget();
        if (appState.linkSourceFixed) appState.linkSourceConnected = true;
        else resetLinkCreationState();
    }
    markDirty();
    const saved = legacy ? saveLegacyLinkReplacement(link, legacy) : true;
    if (!legacy) {
        scheduleSave({ immediate: true, silent: true });
        if (wasExplicit || Number(getCurrentView()?.show_connections ?? 1) === 0) eventBus.emit('wiring:connection-created', link);
    }
    return saved;
}

export function submitLinkCreationTarget(fromPort, toPort) {
    const target = getLinkCreationTarget();
    if (!target || !canChooseEndpoint() || !requireAdminUiAction() || appState.linkSourceId == null ||
        !getDeviceById(appState.linkSourceId) || Number(appState.linkSourceId) === Number(target.id)) return false;
    const legacy = appState.legacyLinkCreation;
    if (legacy) {
        if (Number(appState.linkSourceId) !== Number(legacy.payload.from_id) ||
            Number(target.id) !== Number(legacy.payload.to_id)) return false;
        try {
            assertLegacyLinkReviewable(legacy);
        } catch (error) {
            showToast(error.message, 'warning');
            return false;
        }
    }
    const from = fromPort.trim(), to = toPort.trim();
    if ([from, to].some(port => Array.from(port).length > 50)) {
        showToast('ポート名は50文字以内で入力してください', 'warning');
        return false;
    }
    if (!from && !to && getExistingLinkCreationConnections().some(link => ['from', 'to'].every(side =>
        link[`${side}_port_name`] == null ? link[`${side}_port_id`] == null : !link[`${side}_port_name`].trim()
    ))) {
        showToast('両端のポートを指定していない接続が既にあります。少なくとも片側のポートを指定してください', 'warning');
        return false;
    }
    return createConnection(target.id, from, to);
}

export function handleLinkCreationClick(device) {
    if (!canChooseEndpoint() || !requireAdminUiAction()) return false;
    const id = Number(device.id);
    if (appState.legacyLinkCreation) return !getLinkCreationTarget() && chooseLinkCreationTarget(id);
    const placed = getCurrentPlacements();
    if (!placed.some(row => Number(row.device_id) === id) ||
        (appState.linkSourceId != null && !placed.some(row => Number(row.device_id) === Number(appState.linkSourceId)))) {
        showToast('このビューの接続元と接続先を選択してください', 'warning');
        return false;
    }
    if (appState.linkSourceId == null) {
        appState.linkSourceId = id;
        appState.linkSourceConnected = false;
        return true;
    }
    if (Number(appState.linkSourceId) === id) {
        showToast('同一機器同士は接続できません', 'warning');
        return false;
    }
    if (getLinkCreationTarget()) {
        showToast('選択中の接続先を確定するか、取り消してください', 'warning');
        return false;
    }
    const pair = pairKey(appState.linkSourceId, id);
    if (appState.links.some(link => pairKey(link.from_id, link.to_id) === pair)) {
        return chooseLinkCreationTarget(id);
    }
    return createConnection(id);
}
export function endLinkMode() {
    appState.linkMode = false;
    resetLinkCreationState();
}
