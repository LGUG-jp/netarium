import { appState, getDeviceById, toSaveDevice, validateDevicesForSave } from './state.js';
import { validateDeviceValues } from './device-validation.js';
import { hasDeviceDraftChangesForIds } from './device-drafts.js';
import { getPlacedDeviceIds, getRackDeviceMounts } from './device-placement.js';

export const BULK_DEVICE_FIELDS = [
    { key: 'facility', label: '施設' },
    { key: 'floor', label: 'フロア' },
    { key: 'location', label: '設置場所' },
    { key: 'department', label: '担当部署' },
    { key: 'maintenance_vendor', label: '保守ベンダー' },
    { key: 'maintenance_expiry', label: '保守期限', date: true },
    { key: 'manufacturer', label: 'メーカー' },
    { key: 'model', label: '型番' },
    { key: 'install_date', label: '導入年月日', date: true },
    { key: 'management_scheme', label: '接続方式', options: [
        { value: '', label: '未設定' },
        { value: 'https', label: 'HTTPS' },
        { value: 'http', label: 'HTTP' },
        { value: 'ssh', label: 'SSH' }
    ] },
    { key: 'management_port', label: 'ポート', type: 'number' }
];

function assertTargets(ids) {
    if (!ids.length) throw new Error('機器を選択してください');
    if (hasDeviceDraftChangesForIds(ids)) {
        throw new Error('対象機器に未適用の入力があります。台帳・個票・右パネルで適用または破棄してから、一括編集を開始してください');
    }
    return ids.map(id => {
        const device = getDeviceById(id);
        if (!device) throw new Error(`機器ID ${id} が見つかりません。一括編集を開き直してください`);
        if (appState.resourceConflicts?.devices?.has(id)) throw new Error(`機器ID ${id} は競合しています。対象機器を再読み込みしてください`);
        return device;
    });
}

export function startDeviceBulkEdit(selectedIds) {
    const ids = [...new Set(selectedIds.map(Number))];
    const devices = assertTargets(ids);
    return { ids, bases: devices.map(device => toSaveDevice(device)) };
}

export function summarizeBulkValues(session, key) {
    const values = new Set(session.bases.map(device => String(device[key] ?? '')));
    if (values.size === 1) return [...values][0] || '未設定';
    return values.has('') ? '複数の値（未設定を含む）' : '複数の値';
}

export function prepareDeviceBulkEdit(session, updates) {
    const keys = Object.keys(updates);
    if (!keys.length) throw new Error('変更する項目を選択してください');
    if (keys.some(key => !BULK_DEVICE_FIELDS.some(field => field.key === key))) {
        throw new Error('一括編集の対象外の項目が含まれています');
    }
    const devices = assertTargets(session.ids);
    const candidates = devices.map((device, index) => {
        const current = toSaveDevice(device);
        if (Object.keys(current).some(key => current[key] !== session.bases[index][key])) {
            throw new Error(`機器ID ${device.id} の属性が変更されています。一括編集を開き直してください`);
        }
        const { values, errors } = validateDeviceValues({ ...device, ...updates });
        if (Object.keys(errors).length) throw new Error(`機器ID ${device.id}: ${Object.values(errors).join('\n')}`);
        // 未選択項目は正規化の副作用も含めて変更しない。
        return { ...device, ...Object.fromEntries(keys.map(key => [key, values[key]])) };
    });
    const byId = new Map(candidates.map(device => [Number(device.id), device]));
    validateDevicesForSave(appState.devices.map(device => byId.get(Number(device.id)) || { ...device }));
    const placed = getPlacedDeviceIds(appState.placements, getRackDeviceMounts(appState));
    return {
        updates: Object.fromEntries(keys.map(key => [key, candidates[0][key]])),
        candidates,
        placedCount: keys.some(key => key === 'facility' || key === 'floor')
            ? session.ids.filter(id => placed.has(id)).length : 0
    };
}

export function applyDeviceBulkEdit(session, updates) {
    // 確認後も全対象を再検証し、1件でも不適用ならstateを変更しない。
    const plan = prepareDeviceBulkEdit(session, updates);
    let changed = false;
    for (const candidate of plan.candidates) {
        const current = getDeviceById(candidate.id);
        for (const key of Object.keys(plan.updates)) {
            if (current[key] !== candidate[key]) {
                current[key] = candidate[key];
                changed = true;
            }
        }
    }
    return changed;
}
