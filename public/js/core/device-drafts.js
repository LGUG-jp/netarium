import { appState, getDeviceById, toSaveDevice, validateDevicesForSave } from './state.js';
import { eventBus } from './event-bus.js';
import { validateDeviceValues } from './device-validation.js';
import { resetDeviceMonitoringState } from './device-monitoring.js';

// 編集途中の値は確定済みstateと分け、別の保存要求へ混入させない。
const scopes = new Map();
const editableFields = Object.keys(toSaveDevice({})).filter(key => !['id', 'x', 'y'].includes(key));
const notify = () => eventBus.emit('device-drafts:changed');

function scopeDrafts(scope) {
    if (!scopes.has(scope)) scopes.set(scope, new Map());
    return scopes.get(scope);
}

export function getDeviceDraft(scope, id) {
    id = Number(id);
    const current = getDeviceById(id);
    if (!current) return null;
    const drafts = scopeDrafts(scope);
    if (!drafts.has(id)) drafts.set(id, { base: { ...current }, values: { ...current } });
    const entry = drafts.get(id);
    if (!changed(entry)) {
        Object.assign(entry.base, current);
        Object.assign(entry.values, current);
    }
    return drafts.get(id).values;
}

function changed(entry) {
    return editableFields.some(key => entry.values[key] !== entry.base[key]);
}

export function hasDeviceDraftChanges(scope, id) {
    const drafts = scopes.get(scope);
    if (!drafts) return false;
    if (id !== undefined) {
        const entry = drafts.get(Number(id));
        return !!entry && changed(entry);
    }
    return [...drafts.values()].some(changed);
}

export function hasAnyDeviceDraftChanges() {
    return [...scopes.keys()].some(scope => hasDeviceDraftChanges(scope));
}

export function hasDeviceDraftChangesForIds(ids) {
    return [...scopes.keys()].some(scope => ids.some(id => hasDeviceDraftChanges(scope, id)));
}


function candidateFor(id, entry) {
    const current = getDeviceById(id);
    if (!current) throw new Error('編集対象の機器が見つかりません。最新情報を確認してください');
    if (appState.resourceConflicts?.devices?.has(id)) {
        throw new Error('この機器は競合しています。入力内容を確認し、対象機器を再読み込みしてください');
    }
    const candidate = { ...current };
    for (const key of editableFields) {
        if (entry.values[key] === entry.base[key]) continue;
        if (current[key] !== entry.base[key] && current[key] !== entry.values[key]) {
            throw new Error('同じ機器の項目が別の編集画面で確定されています。入力内容を確認してください');
        }
        candidate[key] = entry.values[key];
    }
    // IP重複は全候補を組み立てた後の集合で判定し、交換・付け替えを許可する。
    const { values, errors } = validateDeviceValues(candidate);
    if (Object.keys(errors).length) {
        const error = new Error(Object.values(errors).join('\n'));
        error.fieldErrors = errors;
        throw error;
    }
    return values;
}

// 複数行の明示保存も、全件を検証してからstateへ反映する。
export function commitDeviceDrafts(scope, ids) {
    const drafts = scopes.get(scope);
    if (!drafts) return false;
    const targets = ids === undefined ? [...drafts.keys()] : ids.map(Number);
    const candidates = new Map();
    for (const id of targets) {
        const entry = drafts.get(id);
        if (entry && changed(entry)) candidates.set(id, candidateFor(id, entry));
    }
    if (candidates.size) {
        validateDevicesForSave(appState.devices.map(row => candidates.get(Number(row.id)) || { ...row }));
        for (const [id, candidate] of candidates) {
            const current = getDeviceById(id);
            const ipChanged = current.ip !== candidate.ip;
            Object.assign(current, candidate);
            if (ipChanged) resetDeviceMonitoringState(current);
        }
    }
    for (const id of targets) drafts.delete(id);
    notify();
    return candidates.size > 0;
}

export function commitDeviceDraft(scope, id) {
    return commitDeviceDrafts(scope, [id]);
}

export function discardDeviceDraft(scope, id) {
    scopes.get(scope)?.delete(Number(id));
    notify();
}

export function discardDeviceDrafts(scope) {
    if (scope === undefined) scopes.clear();
    else scopes.delete(scope);
    notify();
}

eventBus.on('resources:ids-remapped', maps => {
    for (const drafts of scopes.values()) {
        const entries = [...drafts.entries()];
        drafts.clear();
        for (const [id, entry] of entries) {
            const mapped = Number(maps.devices?.[id] ?? id);
            entry.base.id = mapped;
            entry.values.id = mapped;
            drafts.set(mapped, entry);
        }
    }
    notify();
});
eventBus.on('resources:reloaded', () => discardDeviceDrafts());
eventBus.on('resource:reloaded', ({ kind, id }) => {
    if (kind !== 'devices') return;
    for (const drafts of scopes.values()) drafts.delete(Number(id));
    notify();
});
