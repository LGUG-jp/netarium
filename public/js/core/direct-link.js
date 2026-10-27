import { appState } from './state.js';
import { switchView } from '../modals/view-manager-modal.js';
import { focusDevicePlacement } from '../canvas/renderer.js';
import { openLedgerDetail } from '../modals/ledger-modal.js';
import { showToast } from '../ui/toast.js';
import { getDeviceDestinations, getRackDeviceMounts } from './device-placement.js';

// Only IDs from the authenticated load response are eligible destinations.
export function parseDirectLink(search) {
    const params = new URLSearchParams(search);
    const result = {};
    for (const key of ['view', 'device']) {
        const values = params.getAll(key);
        if (values.length === 0) continue;
        if (values.length !== 1 || !/^[0-9]+$/.test(values[0])) return null;
        const id = Number(values[0]);
        if (!Number.isSafeInteger(id) || id <= 0) return null;
        result[key] = id;
    }
    return result;
}

export function findDirectLinkTarget(link, state) {
    if (!link) return null;
    if (link.view === undefined && link.device === undefined) return { kind: 'none' };
    const view = state.views.find(row => Number(row.id) === link.view);
    if (link.view !== undefined && !view) return null;
    if (link.device === undefined) return { kind: 'view', view };
    const device = state.devices.find(row => Number(row.id) === link.device);
    if (!device) return null;
    const placements = state.placements.filter(row => Number(row.device_id) === link.device);
    const mounts = getRackDeviceMounts(state).filter(row => Number(row.device_id) === link.device);
    const destinations = getDeviceDestinations(link.device, placements, mounts, state.views);
    const target = view ? destinations.find(item => Number(item.view.id) === Number(view.id)) :
        destinations.sort((a, b) => Number(a.view.sort_order) - Number(b.view.sort_order) || Number(a.view.id) - Number(b.view.id))[0];
    if (!target) return view || placements.length || mounts.length ? null : { kind: 'ledger', device };
    return target.kind === 'rack' ? { kind: 'rack', view: target.view, device, mount: target.mount } :
        { kind: 'placement', view: target.view, device, placement: target.placement };
}

export async function openDirectLink(search) {
    const target = findDirectLinkTarget(parseDirectLink(search), appState);
    if (!target) {
        showToast('指定されたリンクを開けません。通常の画面から対象を確認してください', 'warning');
        return false;
    }
    if (target.kind === 'none') return true;
    if (target.kind === 'ledger') return openLedgerDetail(target.device.id);
    if (target.kind === 'rack') {
        const { showRackDevice } = await import('../canvas/rack-view.js');
        return showRackDevice({ viewId: target.view.id, deviceId: target.device.id });
    }
    if (!await switchView(target.view.id)) return false;
    // A cancelled/asynchronous switch must never focus a different canvas.
    if (Number(appState.currentViewId) !== Number(target.view.id)) return false;
    if (target.kind === 'placement') return focusDevicePlacement(target.device, target.placement);
    return true;
}
