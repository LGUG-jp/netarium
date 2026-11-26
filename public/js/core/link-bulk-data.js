import { appState, getCurrentView, getDeviceById, toSaveLink } from './state.js';
import { isCurrentUserAdmin } from '../ui/access-control.js';
import { mappedResourceId } from './resource-save.js';
import { getRackDeviceMounts } from './device-placement.js';
import { normalizePortName } from './connection-data.js';

export const BULK_LINK_FIELDS = [
    { key: 'system_id', label: '接続系統' },
    { key: 'label', label: 'ラベル', maxLength: 100 },
    { key: 'memo', label: '備考', maxLength: 1000 }
];

/** 共通接続の一覧・一括用。両端の配置を必要とする描画とは分離する。 */
export function resolveWorkspaceLinks(view, data) {
    if (!view) return [];
    const viewId = Number(view.id);
    const placements = view.view_type === 'rack' ? getRackDeviceMounts(data) : data.placements;
    const devices = new Set(placements.filter(row => Number(row.view_id) === viewId)
        .map(row => Number(row.device_id)));
    const portsById = new Map(data.devicePorts.map(port => [Number(port.id), port]));
    let portsByName;
    const portKey = (owner, name) => `${Number(owner)}:${name}`;
    const resolvePort = (owner, id, pendingName) => {
        // 保存 DTO と同様、空欄を含む明示的な名前指定を ID より優先する。
        if (pendingName != null) {
            const name = normalizePortName(pendingName);
            if (!name) return undefined;
            portsByName ??= new Map(data.devicePorts.map(port => [portKey(port.device_id, port.name), port]));
            return portsByName.get(portKey(owner, name)) ?? { name };
        }
        const port = id == null ? undefined : portsById.get(Number(id));
        return port && Number(port.device_id) === Number(owner) ? port : undefined;
    };
    return data.links.filter(link => devices.has(Number(link.from_id)) || devices.has(Number(link.to_id)))
        .map(link => {
            const from = resolvePort(link.from_id, link.from_port_id, link.from_port_name);
            const to = resolvePort(link.to_id, link.to_port_id, link.to_port_name);
            return {
                ...link,
                from_port: from?.name ?? '',
                to_port: to?.name ?? '',
                from_port_vlan: from?.vlan ?? '',
                to_port_vlan: to?.vlan ?? ''
            };
        });
}

export function filterWorkspaceLinks(links, query = '') {
    const words = String(query).trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return links;
    return links.filter(link => {
        const system = appState.linkSystems?.find(row => Number(row.id) === Number(link.system_id));
        const haystack = [link.label, getDeviceById(link.from_id)?.name, getDeviceById(link.to_id)?.name,
            link.from_port, link.to_port, link.from_port_vlan, link.to_port_vlan,
            system?.name || '未設定'].map(value => String(value ?? '')).join(' ').toLocaleLowerCase();
        return words.every(word => haystack.includes(word));
    });
}

function assertTargets(ids, viewId = appState.currentViewId) {
    if (!isCurrentUserAdmin() || appState.authExpired) throw new Error('この操作を実行する権限がありません');
    if (appState.isPinging) throw new Error('Ping実行中は編集できません');
    if (!getCurrentView() || Number(appState.currentViewId) !== Number(viewId)) throw new Error('表示中のビューが変更されています。一括設定を開き直してください');
    if (!ids.length) throw new Error('接続を選択してください');
    const current = new Map(resolveWorkspaceLinks(getCurrentView(), appState).map(link => [Number(link.id), link]));
    return ids.map(id => {
        const link = current.get(id);
        if (!link) throw new Error('対象の接続が削除または移動されています。一括設定を開き直してください');
        if (appState.resourceConflicts.links?.has(id)) throw new Error('この接続は競合しています。最新データを再読み込みしてください');
        return link;
    });
}

export function startLinkBulkEdit(selectedIds) {
    const ids = [...new Set([...selectedIds].map(Number))];
    const links = assertTargets(ids);
    return { viewId: Number(appState.currentViewId), ids, bases: links.map(toSaveLink), invalidated: false };
}

export function remapLinkBulkSession(session, maps) {
    session.viewId = mappedResourceId(maps.views, session.viewId);
    session.ids = session.ids.map(id => mappedResourceId(maps.links, id));
    session.bases.forEach(link => {
        link.from_id = mappedResourceId(maps.devices, link.from_id);
        link.to_id = mappedResourceId(maps.devices, link.to_id);
        if (Object.hasOwn(link, 'from_port_id')) link.from_port_id = mappedResourceId(maps.device_ports, link.from_port_id);
        if (Object.hasOwn(link, 'to_port_id')) link.to_port_id = mappedResourceId(maps.device_ports, link.to_port_id);
    });
}

export function prepareLinkBulkEdit(session, updates, selectedIds = session.ids) {
    if (session.invalidated) throw new Error('データが再読み込みされています。一括設定を開き直してください');
    const selection = new Set([...selectedIds].map(Number));
    if (selection.size !== session.ids.length || session.ids.some(id => !selection.has(id))) {
        throw new Error('選択した接続が変更されています。一括設定を開き直してください');
    }
    const links = assertTargets(session.ids, session.viewId);
    const keys = Object.keys(updates);
    if (!keys.length) throw new Error('変更する項目を選択してください');
    const values = {};
    for (const key of keys) {
        const field = BULK_LINK_FIELDS.find(row => row.key === key);
        if (!field) throw new Error('一括設定の対象外の項目が含まれています');
        if (key === 'system_id') {
            const value = updates[key];
            values[key] = value == null || value === '' ? null : Number(value);
            if (values[key] !== null && (!Number.isSafeInteger(values[key]) || values[key] <= 0 ||
                !appState.linkSystems?.some(system => Number(system.id) === values[key]))) {
                throw new Error('接続系統が見つかりません。選択し直してください');
            }
        } else {
            values[key] = String(updates[key] ?? '').trim();
            if ([...values[key]].length > field.maxLength) throw new Error(`${field.label}は${field.maxLength}文字以内で入力してください`);
        }
    }
    links.forEach((link, index) => {
        if (JSON.stringify(toSaveLink(link)) !== JSON.stringify(session.bases[index])) {
            throw new Error('対象の接続が変更されています。一括設定を開き直してください');
        }
    });
    return { links, values };
}

export function applyLinkBulkEdit(session, updates, selectedIds = session.ids) {
    // 全件の確認を完了してから、明示的に選んだ属性だけを変更する。
    const { links, values } = prepareLinkBulkEdit(session, updates, selectedIds);
    let changed = false;
    const targets = new Map(appState.links.map(row => [Number(row.id), row]));
    for (const { id } of links) {
        const link = targets.get(Number(id));
        for (const [key, value] of Object.entries(values)) {
            if (link[key] !== value) {
                link[key] = value;
                changed = true;
            }
        }
    }
    return changed;
}
