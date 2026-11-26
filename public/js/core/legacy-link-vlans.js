import { apiFetch } from './api-client.js';
import { eventBus } from './event-bus.js';
import { getPendingSave, hasPendingChanges, isSaveInFlight, runResourceMutation } from './save-queue.js';
import { appState } from './state.js';
import { isCurrentUserAdmin } from '../ui/access-control.js';
import { markPending, markSaved } from '../ui/status-bar.js';

export function legacyVlansForDevices(deviceIds) {
    if (!appState.legacyLinkVlans.length || !deviceIds.size) return [];
    const linkIds = new Set(appState.links.filter(link => link.resource_revision > 0 &&
        (deviceIds.has(Number(link.from_id)) || deviceIds.has(Number(link.to_id)))).map(link => Number(link.id)));
    return appState.legacyLinkVlans.filter(row => linkIds.has(Number(row.link_id)));
}

export function legacyVlansForDevice(deviceId) {
    return legacyVlansForDevices(new Set([Number(deviceId)]));
}

export function unmigratedVlanForLink(id) {
    return appState.legacyLinkVlans.find(row => Number(row.link_id) === Number(id));
}

export function legacyVlanEndpoints(link) {
    return ['from', 'to'].map(side => {
        const deviceId = Number(link[`${side}_id`]);
        const portId = Number(link[`${side}_port_id`]);
        const device = appState.devices.find(row => Number(row.id) === deviceId);
        const port = portId > 0 ? appState.devicePorts.find(row => Number(row.id) === portId &&
            Number(row.device_id) === deviceId && row.resource_revision > 0) : null;
        return {
            deviceId, deviceName: device?.name ?? `機器 #${deviceId}`,
            portId: port ? portId : null, portName: port?.name ?? null,
            vlan: port?.vlan ?? null, revision: port ? Number(port.resource_revision) : null,
        };
    }).sort((a, b) => a.deviceId - b.deviceId);
}

export async function deleteLegacyLinkVlan(record, linkRevision, revision) {
    if (!isCurrentUserAdmin() || appState.authExpired) throw new Error('この操作を実行する権限がありません');
    if (isSaveInFlight()) throw new Error('保存が完了してから未移行VLANを削除してください');
    const linkId = Number(record.link_id);
    const requireCurrent = () => {
        if (getPendingSave() || hasPendingChanges()) throw new Error('先に未保存の変更を保存または取り消してください');
        const link = appState.links.find(row => Number(row.id) === linkId);
        if (appState.dataRevision !== revision || unmigratedVlanForLink(linkId) !== record ||
            !linkRevision || Number(link?.resource_revision) !== linkRevision) {
            throw new Error('未移行VLANまたは接続が更新されました。「読込」で最新データを確認してください');
        }
    };
    const payload = { link_id: linkId, expected_revision: revision, link_expected_revision: linkRevision };
    requireCurrent();
    return runResourceMutation(async () => {
        requireCurrent();
        const result = await apiFetch('complete_legacy_link_vlan', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        });
        if (result.ok !== true || Number(result.revision) !== revision + 1 || Number(result.link_id) !== linkId ||
            appState.dataRevision !== revision || !appState.legacyLinkVlans.includes(record)) {
            throw new Error('未移行VLANの削除結果を確認できません。「読込」で最新データを確認してください');
        }
        appState.legacyLinkVlans = appState.legacyLinkVlans.filter(row => row !== record);
        markSaved(result.revision, result.saved_at);
        if (hasPendingChanges()) markPending();
        eventBus.emit('legacy-vlans:changed');
        eventBus.emit('resources:saved', result);
        eventBus.emit('ledger:render');
        return result;
    });
}
