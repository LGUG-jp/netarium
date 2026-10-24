import { appState } from './state.js';
import { switchView } from '../modals/view-manager-modal.js';
import { focusDevicePlacement } from '../canvas/renderer.js';
import { openLedgerDetail } from '../modals/ledger-modal.js';
import { showToast } from '../ui/toast.js';

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
    if (view) {
        const placement = placements.find(row => Number(row.view_id) === Number(view.id));
        return placement ? { kind: 'placement', view, device, placement } : null;
    }
    if (placements.length === 0) return { kind: 'ledger', device };
    const views = state.views.filter(row => placements.some(placement => Number(placement.view_id) === Number(row.id)));
    views.sort((a, b) => Number(a.sort_order) - Number(b.sort_order) || Number(a.id) - Number(b.id));
    if (!views.length) return null;
    return {
        kind: 'placement', view: views[0], device,
        placement: placements.find(row => Number(row.view_id) === Number(views[0].id))
    };
}

export async function openDirectLink(search) {
    const target = findDirectLinkTarget(parseDirectLink(search), appState);
    if (!target) {
        showToast('指定されたリンクを開けません。通常の画面から対象を確認してください', 'warning');
        return false;
    }
    if (target.kind === 'none') return true;
    if (target.kind === 'ledger') return openLedgerDetail(target.device.id);
    if (!await switchView(target.view.id)) return false;
    // A cancelled/asynchronous switch must never focus a different canvas.
    if (Number(appState.currentViewId) !== Number(target.view.id)) return false;
    if (target.kind === 'placement') return focusDevicePlacement(target.device, target.placement);
    return true;
}
