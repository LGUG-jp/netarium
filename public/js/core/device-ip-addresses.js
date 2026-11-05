import { isValidIpv4 } from './utils.js';
import { appState } from './state.js';
import { classifiedIpRecords, segmentCandidates, segmentLabel } from './ip-management.js';
let nextClientKey = 1;

export function normalizeAdditionalIps(rows = []) {
    return rows.map((row, index) => ({
        id: row.id == null ? null : Number(row.id),
        ...(row.id == null ? { _client_key: row._client_key || `address-${nextClientKey++}` } : {}),
        segment_id: row.segment_id == null ? null : Number(row.segment_id),
        ip: String(row.ip ?? '').trim(), label: String(row.label ?? '').trim(), sort_order: index
    }));
}

export function getDeviceIpRowErrors(device) {
    const used = new Set(device.ip ? [device.ip] : []);
    return (device.additional_ips || []).map(row => {
        let error = null;
        if (!row.ip || !isValidIpv4(row.ip)) {
            error = { field: 'ip', message: '追加IPは有効なIPv4アドレスを入力してください' };
        } else if (Array.from(row.label || '').length > 100) {
            error = { field: 'label', message: '追加IPの用途は100文字以内で入力してください' };
        } else if (used.has(row.ip)) {
            error = { field: 'ip', message: `同じ機器内でIPアドレス ${row.ip} が重複しています` };
        }
        used.add(row.ip);
        return error;
    });
}

export function validateDeviceIps(device) {
    return getDeviceIpRowErrors(device).find(Boolean)?.message || null;
}

export function deviceIpRecords(device) {
    return [device.ip, ...(device.additional_ips || []).map(row => row.ip)].map(ip => String(ip ?? '').trim()).filter(Boolean);
}

// IPと機器ペアを比較し、並べ替え・用途変更・既存重複では確認しない。
export function newDeviceIpConflicts(before, after, segments = appState.ipSegments || []) {
    const pairs = devices => {
        const owners = new Map();
        for (const row of classifiedIpRecords(devices, segments)) {
            if (!owners.has(row.ip)) owners.set(row.ip, []);
            owners.get(row.ip).push(row);
        }
        const result = new Map();
        for (const [ip, rows] of owners) for (let a = 0; a < rows.length; a++) for (let b = a + 1; b < rows.length; b++) {
            if (rows[a].device_id === rows[b].device_id) continue;
            const spaceA = rows[a].address_space_id;
            const spaceB = rows[b].address_space_id;
            if (spaceA != null && spaceB != null && Number(spaceA) !== Number(spaceB)) continue;
            const ids = [rows[a].device_id, rows[b].device_id].sort((x, y) => x - y);
            const scope = spaceA != null && spaceB != null ? `space-${spaceA}` : 'unclassified';
            result.set(`${ip}:${scope}:${ids.join(':')}`, { ip, classified: scope !== 'unclassified',
                devices: ids.map(id => devices.find(device => Number(device.id) === id)) });
        }
        return result;
    };
    const existing = pairs(before);
    return [...pairs(after)].filter(([key]) => !existing.has(key)).map(([, conflict]) => conflict);
}

export function confirmDeviceIpChanges(before, after, confirm = message => window.confirm(message)) {
    const conflicts = newDeviceIpConflicts(before, after);
    if (!conflicts.length) return true;
    const describe = rows => rows.map(({ ip, devices }) => {
        const candidates = segmentCandidates(ip, appState.ipSegments || []);
        return `${ip}: ${devices.map(row => `機器ID ${row.id}「${row.name || '(名称未設定)'}」`).join(' / ')}\n空間・セグメント候補: ${candidates.length ? candidates.map(segment => segmentLabel(segment, appState.addressSpaces || [])).join('、') : '該当なし'}`;
    }).join('\n');
    const classified = conflicts.filter(row => row.classified);
    if (classified.length) throw new Error('同じアドレス空間内でIPアドレスが重複しています。所属またはIPを確認してください。\n' + describe(classified));
    if (!confirm('未分類のIPアドレスが他の機器と重複します。ネットワークの分離を確認して、未分類のまま保存しますか？\n' + describe(conflicts))) return false;
    for (const conflict of conflicts) for (const device of conflict.devices) device.ip_conflicts_confirmed = true;
    return true;
}
