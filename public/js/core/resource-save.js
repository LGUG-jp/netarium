import {
    appState, normalizeDevice, normalizeLink, normalizePlacement, normalizeView,
    toSaveDevice, toSaveLink, toSavePlacement, toSaveView, recalculateNextIds
} from './state.js';
import { normalizeCanvasNote, toSaveCanvasNote } from './canvas-note-data.js';
import { resetLinkCreationState } from './link-mode.js';

const sorted = rows => rows.sort((a, b) => Number(a.id) - Number(b.id));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const byId = rows => new Map(rows.map(row => [Number(row.id), row]));
const stateKey = kind => kind === 'canvas_notes' ? 'canvasNotes' : kind;
const viewChildKinds = ['placements', 'links', 'canvas_notes'];

export function viewResource(data, view, deletedDevices = new Set()) {
    const id = Number(view.id);
    return {
        view: toSaveView(view),
        placements: sorted((data.placements || [])
            .filter(row => Number(row.view_id) === id && !deletedDevices.has(Number(row.device_id)))
            .map(toSavePlacement)),
        links: sorted((data.links || [])
            .filter(row => Number(row.view_id) === id &&
                !deletedDevices.has(Number(row.from_id)) && !deletedDevices.has(Number(row.to_id)))
            .map(toSaveLink)),
        canvas_notes: sorted((data.canvasNotes || data.canvas_notes || [])
            .filter(row => Number(row.view_id) === id).map(toSaveCanvasNote))
    };
}

export function createResourceBaseline(data) {
    return {
        devices: byId((data.devices || []).map(row => ({
            id: Number(row.id), revision: Number(row.resource_revision), device: toSaveDevice(row)
        }))),
        views: byId((data.views || []).map(row => ({
            id: Number(row.id), revision: Number(row.resource_revision), ...viewResource(data, row)
        })))
    };
}

let savedBaseline = createResourceBaseline({});
export function resetResourceBaseline(data) {
    savedBaseline = createResourceBaseline(data);
}

function expectedRevision(row) {
    if (!Number.isInteger(row.revision) || row.revision < 1) {
        throw new Error(`リソースID ${row.id} の保存版番号がありません。最新データを再読込してください`);
    }
    return row.revision;
}

export function buildResourceSave(data = appState, baseline = savedBaseline) {
    const devices = [];
    const views = [];
    const currentDevices = byId(data.devices);
    const currentViews = byId(data.views);
    const deletedDevices = new Set();
    for (const [id, before] of baseline.devices) {
        if (!currentDevices.has(id)) {
            deletedDevices.add(id);
            devices.push({ operation: 'delete', id, expected_revision: expectedRevision(before) });
        }
    }
    for (const row of data.devices) {
        const id = Number(row.id);
        const before = baseline.devices.get(id);
        const device = toSaveDevice(row);
        if (!before) devices.push({ operation: 'create', id, device });
        else if (!equal(before.device, device)) {
            devices.push({ operation: 'update', id, expected_revision: expectedRevision(before), device });
        }
    }
    for (const [id, before] of baseline.views) {
        if (!currentViews.has(id)) views.push({ operation: 'delete', id, expected_revision: expectedRevision(before) });
    }
    for (const row of data.views) {
        const id = Number(row.id);
        const before = baseline.views.get(id);
        const resource = viewResource(data, row);
        // 機器削除のcascadeだけなら、ビュー自体を保存対象にしない。
        const previous = before && {
            view: before.view,
            placements: before.placements.filter(p => !deletedDevices.has(p.device_id)),
            links: before.links.filter(link => !deletedDevices.has(link.from_id) && !deletedDevices.has(link.to_id)),
            canvas_notes: before.canvas_notes
        };
        if (!before) views.push({ operation: 'create', id, ...resource });
        else if (!equal(previous, resource)) {
            views.push({ operation: 'update', id, expected_revision: expectedRevision(before), ...resource });
        }
    }
    return { devices, views };
}

// 競合対象と、それを参照/削除する変更は保留する。独立した変更は保存できる。
export function buildSaveableResourceSave(data = appState, baseline = savedBaseline) {
    const payload = buildResourceSave(data, baseline);
    const blockedDevices = new Set(data.resourceConflicts?.devices?.keys() || []);
    const blockedViews = new Set(data.resourceConflicts?.views?.keys() || []);
    const references = resource => [
        ...(resource?.placements || []).map(row => Number(row.device_id)),
        ...(resource?.links || []).flatMap(row => [Number(row.from_id), Number(row.to_id)])
    ];
    let changed;
    do {
        changed = false;
        for (const operation of payload.views) {
            if (!blockedViews.has(operation.id) &&
                [...references(operation), ...references(baseline.views.get(operation.id))]
                    .some(id => blockedDevices.has(id))) {
                blockedViews.add(operation.id);
                changed = true;
            }
        }
        for (const operation of payload.views) {
            if (operation.operation === 'delete' || blockedViews.has(operation.id)) continue;
            const name = operation.view.name.trim().toLocaleLowerCase('ja');
            const dependsOnHeldRename = [...baseline.views].some(([id, row]) => {
                if (id === operation.id || row.view.name.trim().toLocaleLowerCase('ja') !== name) return false;
                const rename = payload.views.find(item => item.id === id);
                return !rename || blockedViews.has(id) ||
                    (rename.operation !== 'delete' && rename.view.name.trim().toLocaleLowerCase('ja') === name);
            });
            if (dependsOnHeldRename) {
                blockedViews.add(operation.id);
                changed = true;
            }
        }
        for (const operation of payload.devices) {
            if (operation.operation !== 'delete' || blockedDevices.has(operation.id)) continue;
            if ([...blockedViews].some(id =>
                references(baseline.views.get(id)).includes(operation.id) ||
                references(payload.views.find(row => row.id === id)).includes(operation.id))) {
                blockedDevices.add(operation.id);
                changed = true;
            }
        }
    } while (changed);
    return {
        devices: payload.devices.filter(row => !blockedDevices.has(row.id)),
        views: payload.views.filter(row => !blockedViews.has(row.id))
    };
}

export function resourceSaveValidationData(payload, baseline = savedBaseline) {
    const deleted = new Set(payload.devices.filter(row => row.operation === 'delete').map(row => row.id));
    const devices = new Map([...baseline.devices].map(([id, row]) => [id, row.device]));
    const views = new Map([...baseline.views].map(([id, row]) => [id, {
        view: row.view, placements: row.placements, links: row.links, canvas_notes: row.canvas_notes
    }]));
    for (const operation of payload.devices) {
        if (operation.operation === 'delete') devices.delete(operation.id);
        else devices.set(operation.id, operation.device);
    }
    for (const operation of payload.views) {
        if (operation.operation === 'delete') views.delete(operation.id);
        else views.set(operation.id, operation);
    }
    return {
        devices: [...devices.values()],
        views: [...views.values()].map(row => row.view),
        placements: [...views.values()].flatMap(row => row.placements)
            .filter(row => !deleted.has(Number(row.device_id))),
        links: [...views.values()].flatMap(row => row.links)
            .filter(row => !deleted.has(Number(row.from_id)) && !deleted.has(Number(row.to_id))),
        canvasNotes: [...views.values()].flatMap(row => row.canvas_notes)
    };
}

export function createPendingResourceSave(payload, baseline = savedBaseline, data = appState) {
    const deleted = new Set(payload.devices.filter(row => row.operation === 'delete').map(row => row.id));
    const affectedViewIds = new Set(payload.views.map(row => row.id));
    for (const [id, row] of baseline.views) {
        if (row.placements.some(p => deleted.has(p.device_id)) ||
            row.links.some(link => deleted.has(link.from_id) || deleted.has(link.to_id))) affectedViewIds.add(id);
    }
    const newIds = {
        devices: payload.devices.filter(row => row.operation === 'create').map(row => row.id),
        views: payload.views.filter(row => row.operation === 'create').map(row => row.id),
        placements: [],
        links: [],
        canvas_notes: []
    };
    for (const operation of payload.views) {
        if (operation.operation === 'delete') continue;
        const previous = baseline.views.get(operation.id);
        for (const kind of viewChildKinds) {
            const existing = new Set((previous?.[kind] || []).map(row => row.id));
            newIds[kind].push(...(operation[kind] || []).filter(row => !existing.has(row.id)).map(row => row.id));
        }
    }
    const snapshot = {
        devices: (data.devices || []).map(toSaveDevice),
        views: (data.views || []).map(toSaveView),
        placements: (data.placements || []).map(toSavePlacement),
        links: (data.links || []).map(toSaveLink),
        canvasNotes: (data.canvasNotes || data.canvas_notes || []).map(toSaveCanvasNote)
    };
    return {
        payload, affectedViewIds: [...affectedViewIds], snapshot, newIds,
        hasNewViewChildIds: viewChildKinds.some(kind => newIds[kind].length > 0)
    };
}

export function hasResourceChangesSince(pending, data = appState) {
    if (!pending?.snapshot) return false;
    for (const [kind, toSave] of [
        ['devices', toSaveDevice], ['views', toSaveView],
        ['placements', toSavePlacement], ['links', toSaveLink], ['canvasNotes', toSaveCanvasNote]
    ]) {
        const sent = byId(pending.snapshot[kind] || []);
        const rows = data[kind] || [];
        if (sent.size !== rows.length ||
            rows.some(row => !equal(toSave(row), sent.get(Number(row.id))))) return true;
    }
    return false;
}

export function inspectPendingResourceSave(pending, data) {
    const { payload } = pending;
    // 作成後のID対応表が失われた場合、内容一致による推測や再送はしない。
    if ([...payload.devices, ...payload.views].some(row => row.operation === 'create')) return 'unknown';
    const dbDevices = byId(data.devices || []);
    const dbViews = byId(data.views || []);
    let unchanged = true;
    let committed = true;
    for (const [operations, rows, isView] of [[payload.devices, dbDevices, false], [payload.views, dbViews, true]]) {
        for (const operation of operations) {
            const row = rows.get(operation.id);
            unchanged &&= !!row && Number(row.resource_revision) === operation.expected_revision;
            if (operation.operation === 'delete') committed &&= !row;
            else {
                const desired = isView
                    ? { view: operation.view, placements: operation.placements, links: operation.links,
                        canvas_notes: operation.canvas_notes || [] }
                    : operation.device;
                const actual = row && (isView ? viewResource(data, row) : toSaveDevice(row));
                committed &&= !!row && Number(row.resource_revision) > operation.expected_revision && equal(desired, actual);
            }
        }
    }
    if (unchanged) return 'retry';
    if (pending.hasNewViewChildIds) return 'unknown';
    return committed ? 'saved' : 'conflict';
}

export function confirmedResourceResult(pending, data) {
    const deletedDevices = pending.payload.devices.filter(row => row.operation === 'delete').map(row => row.id);
    const deletedViews = pending.payload.views.filter(row => row.operation === 'delete').map(row => row.id);
    const devices = new Set(pending.payload.devices.map(row => row.id));
    const views = new Set(pending.affectedViewIds);
    return {
        ...data,
        id_maps: {},
        devices: (data.devices || []).filter(row => devices.has(Number(row.id))),
        views: (data.views || []).filter(row => views.has(Number(row.id))),
        placements: (data.placements || []).filter(row => views.has(Number(row.view_id))),
        links: (data.links || []).filter(row => views.has(Number(row.view_id))),
        canvas_notes: (data.canvas_notes || data.canvasNotes || []).filter(row => views.has(Number(row.view_id))),
        deleted_device_ids: deletedDevices,
        deleted_view_ids: deletedViews,
        affected_view_ids: [...views]
    };
}

export function mappedResourceId(map, id) {
    return id == null ? id : Number(map?.[id] ?? id);
}
export function remapResourceSet(set, map) {
    const ids = [...set].map(id => mappedResourceId(map, id));
    set.clear();
    ids.forEach(id => set.add(id));
}

export function remapResourceState(data, maps) {
    const id = (kind, value) => mappedResourceId(maps[kind], value);
    data.devices.forEach(row => { row.id = id('devices', row.id); });
    data.views.forEach(row => { row.id = id('views', row.id); });
    data.placements.forEach(row => {
        row.id = id('placements', row.id);
        row.device_id = id('devices', row.device_id);
        row.view_id = id('views', row.view_id);
    });
    data.links.forEach(row => {
        row.id = id('links', row.id);
        row.view_id = id('views', row.view_id);
        row.from_id = id('devices', row.from_id);
        row.to_id = id('devices', row.to_id);
    });
    (data.canvasNotes || data.canvas_notes || []).forEach(row => {
        row.id = id('canvas_notes', row.id);
        row.view_id = id('views', row.view_id);
    });
    if ('currentViewId' in data) data.currentViewId = id('views', data.currentViewId);
}

function remapResourceUiState(maps) {
    appState.floorPlans.forEach(row => { row.view_id = mappedResourceId(maps.views, row.view_id); });
    appState.deviceImages.forEach(row => { row.device_id = mappedResourceId(maps.devices, row.device_id); });
    for (const key of ['editingDeviceId', 'ledgerSearchHighlightDeviceId', 'linkSourceId']) {
        appState[key] = mappedResourceId(maps.devices, appState[key]);
    }
    appState.editingLinkId = mappedResourceId(maps.links, appState.editingLinkId);
    appState.selectedCanvasNoteId = mappedResourceId(maps.canvas_notes, appState.selectedCanvasNoteId);
    remapResourceSet(appState.selectedPlacementIds, maps.placements);
    remapResourceSet(appState.floorPlanAutoFittedViews, maps.views);
    appState.viewStates = new Map([...appState.viewStates].map(([id, value]) => [mappedResourceId(maps.views, id), value]));
    for (const kind of ['devices', 'views']) {
        const conflicts = appState.resourceConflicts?.[kind];
        if (!conflicts) continue;
        const entries = [...conflicts];
        conflicts.clear();
        for (const [id, conflict] of entries) {
            const mapped = mappedResourceId(maps[kind], id);
            conflicts.set(mapped, mapped === id ? conflict : { ...conflict, id: mapped });
        }
    }
}

export function applyResourceSaveResult(result, pending) {
    if (!Number.isInteger(Number(result?.revision)) ||
        !result?.id_maps || typeof result.id_maps !== 'object' ||
        !['devices', 'views', 'placements', 'links', 'canvas_notes', 'deleted_device_ids', 'deleted_view_ids', 'affected_view_ids']
            .every(kind => Array.isArray(result[kind])) ||
        ![...result.devices, ...result.views].every(row => Number.isInteger(Number(row.resource_revision)) && Number(row.resource_revision) > 0)) {
        throw new Error('保存応答が不完全です。保存状態を確認してください');
    }
    for (const [kind, ids] of Object.entries(pending?.newIds || {})) {
        if (ids.some(id => !Number.isInteger(Number(result.id_maps[kind]?.[id])) || Number(result.id_maps[kind]?.[id]) <= 0)) {
            throw new Error('新規作成のID対応を受信できませんでした。最新データを再読込してください');
        }
    }
    const maps = Object.fromEntries(['devices', 'views', ...viewChildKinds]
        .map(kind => [kind, { ...result.id_maps[kind] }]));
    const snapshot = pending?.snapshot;
    if (snapshot) {
        // 保留中/応答待ちに追加した未送信仮IDも、採番IDとの衝突から退避する。
        for (const kind of ['devices', 'views', ...viewChildKinds]) {
            const rows = appState[stateKey(kind)];
            const persistedIds = ['devices', 'views'].includes(kind)
                ? [...savedBaseline[kind].keys()]
                : [...savedBaseline.views.values()].flatMap(row => row[kind].map(item => Number(item.id)));
            const sentIds = new Set([...persistedIds, ...(pending.newIds[kind] || [])]);
            const targets = new Set(Object.values(maps[kind]).map(Number));
            let nextId = 0;
            for (const id of targets) nextId = Math.max(nextId, id);
            for (const row of rows) nextId = Math.max(nextId, Number(row.id));
            for (const row of rows) {
                const id = Number(row.id);
                if (!sentIds.has(id) && targets.has(id)) maps[kind][id] = ++nextId;
            }
        }
    }
    remapResourceState(appState, maps);
    if (snapshot) remapResourceState(snapshot, maps);
    const changedDevices = new Set();
    const changedViews = new Set();
    const removedDevices = new Set();
    const removedViews = new Set();
    const saved = createResourceBaseline(result);
    if (snapshot) {
        const sentDeviceIds = new Set(pending.payload.devices.map(row => mappedResourceId(maps.devices, row.id)));
        const sentViewIds = new Set(pending.payload.views.map(row => mappedResourceId(maps.views, row.id)));
        const sentDeletedDeviceIds = new Set(pending.payload.devices
            .filter(row => row.operation === 'delete').map(row => mappedResourceId(maps.devices, row.id)));
        const sentDevices = byId(snapshot.devices);
        const sentViews = byId(snapshot.views);
        const currentDeviceIds = new Set(appState.devices.map(row => Number(row.id)));
        const currentViewIds = new Set(appState.views.map(row => Number(row.id)));
        for (const id of savedBaseline.devices.keys()) {
            if (!currentDeviceIds.has(id)) removedDevices.add(id);
        }
        for (const id of savedBaseline.views.keys()) {
            if (!currentViewIds.has(id)) removedViews.add(id);
        }
        for (const id of sentDevices.keys()) {
            if (!currentDeviceIds.has(id)) removedDevices.add(id);
        }
        for (const id of sentViews.keys()) {
            if (!currentViewIds.has(id)) removedViews.add(id);
        }
        for (const row of appState.devices) {
            if (!equal(toSaveDevice(row), sentDevices.get(Number(row.id))) ||
                (!sentDeviceIds.has(Number(row.id)) && !equal(toSaveDevice(row), savedBaseline.devices.get(Number(row.id))?.device))) {
                changedDevices.add(Number(row.id));
            }
        }
        for (const row of appState.views) {
            const sent = sentViews.get(Number(row.id));
            const baseline = savedBaseline.views.get(Number(row.id));
            if (!sent || !equal(viewResource(appState, row), viewResource(snapshot, sent)) ||
                (!sentViewIds.has(Number(row.id)) && baseline && !equal(viewResource(appState, row),
                    viewResource(baseline, baseline.view, sentDeletedDeviceIds)))) changedViews.add(Number(row.id));
        }
        for (const [id, remote] of saved.views) {
            const baseline = savedBaseline.views.get(id);
            if (sentViewIds.has(id) || !baseline || (!changedViews.has(id) && !removedViews.has(id))) continue;
            if (!equal(viewResource(baseline, baseline.view, sentDeletedDeviceIds),
                { view: remote.view, placements: remote.placements, links: remote.links, canvas_notes: remote.canvas_notes })) {
                appState.resourceConflicts.views.set(id, {
                    kind: 'views', id, name: remote.view.name,
                    message: '機器削除の保存中にビューの別の変更を検出しました。ビューを確認して再読込してください'
                });
            }
        }
    }
    remapResourceUiState(maps);

    const deletedDevices = new Set((result.deleted_device_ids || []).map(Number));
    const deletedViews = new Set((result.deleted_view_ids || []).map(Number));
    const deviceRows = byId((result.devices || []).map(normalizeDevice));
    const viewRows = byId((result.views || []).map(normalizeView));
    const merge = (rows, replacements, deleted, changed, removed) => {
        const merged = rows.filter(row => !deleted.has(Number(row.id))).map(row => {
            const replacement = replacements.get(Number(row.id));
            replacements.delete(Number(row.id));
            if (replacement && changed.has(Number(row.id))) {
                return { ...row, resource_revision: replacement.resource_revision };
            }
            return replacement || row;
        });
        return [...merged, ...[...replacements.values()].filter(row => !removed.has(Number(row.id)))];
    };
    appState.devices = merge(appState.devices, deviceRows, deletedDevices, changedDevices, removedDevices);
    appState.views = merge(appState.views, viewRows, deletedViews, changedViews, removedViews);
    const affectedViews = new Set([...(result.affected_view_ids || []), ...deletedViews, ...(result.views || []).map(row => row.id)].map(Number));
    const replaceTopology = new Set([...affectedViews].filter(id => deletedViews.has(id) || !changedViews.has(id)));
    const currentDeviceIds = new Set(appState.devices.map(row => Number(row.id)));
    const currentViewIds = new Set(appState.views.map(row => Number(row.id)));
    appState.placements = [
        ...appState.placements.filter(row => !replaceTopology.has(Number(row.view_id)) && !deletedDevices.has(Number(row.device_id))),
        ...(result.placements || []).filter(row => replaceTopology.has(Number(row.view_id)) &&
            currentViewIds.has(Number(row.view_id)) && currentDeviceIds.has(Number(row.device_id))).map(normalizePlacement)
    ];
    appState.links = [
        ...appState.links.filter(row => !replaceTopology.has(Number(row.view_id)) &&
            !deletedDevices.has(Number(row.from_id)) && !deletedDevices.has(Number(row.to_id))),
        ...(result.links || []).filter(row => replaceTopology.has(Number(row.view_id)) &&
            currentViewIds.has(Number(row.view_id)) && currentDeviceIds.has(Number(row.from_id)) &&
            currentDeviceIds.has(Number(row.to_id))).map(normalizeLink)
    ];
    appState.canvasNotes = [
        ...appState.canvasNotes.filter(row => !replaceTopology.has(Number(row.view_id))),
        ...result.canvas_notes.filter(row => replaceTopology.has(Number(row.view_id)) &&
            currentViewIds.has(Number(row.view_id))).map(normalizeCanvasNote)
    ];
    appState.deviceImages = appState.deviceImages.filter(row => !deletedDevices.has(Number(row.device_id)));
    const floorViewIds = new Set(appState.views.filter(row => row.view_type === 'floor').map(row => Number(row.id)));
    appState.floorPlans = appState.floorPlans.filter(row => floorViewIds.has(Number(row.view_id)));
    const placementIds = new Set(appState.placements.map(row => Number(row.id)));
    for (const id of appState.selectedPlacementIds) {
        if (!placementIds.has(id)) appState.selectedPlacementIds.delete(id);
    }
    if (deletedDevices.has(appState.editingDeviceId)) appState.editingDeviceId = null;
    if (deletedDevices.has(appState.linkSourceId)) resetLinkCreationState();
    if (!appState.links.some(row => Number(row.id) === appState.editingLinkId)) appState.editingLinkId = null;
    if (!appState.canvasNotes.some(row => Number(row.id) === Number(appState.selectedCanvasNoteId))) {
        appState.selectedCanvasNoteId = null;
    }
    for (const id of deletedViews) {
        appState.viewStates.delete(id);
        appState.floorPlanAutoFittedViews.delete(id);
    }
    if (!currentViewIds.has(appState.currentViewId)) appState.currentViewId = appState.views[0]?.id ?? null;
    for (const id of deletedDevices) savedBaseline.devices.delete(id);
    for (const id of deletedViews) savedBaseline.views.delete(id);
    for (const [id, row] of saved.devices) savedBaseline.devices.set(id, row);
    for (const [id, row] of saved.views) savedBaseline.views.set(id, row);
    recalculateNextIds();
    return maps;
}

export function syncResourceRevision(kind, id, revision) {
    const value = Number(revision);
    if (!Number.isInteger(value) || value < 1) return;
    const row = appState[kind].find(row => Number(row.id) === Number(id));
    if (row) row.resource_revision = value;
    const baseline = savedBaseline[kind].get(Number(id));
    if (baseline) baseline.revision = value;
}

export function reloadResourceFromData(kind, id, data) {
    id = Number(id);
    const remote = createResourceBaseline(data);
    const row = (data[kind] || []).find(row => Number(row.id) === id);
    const normalize = kind === 'devices' ? normalizeDevice : normalizeView;
    const existed = appState[kind].some(row => Number(row.id) === id);
    const refers = item => Number(item.device_id) === id || Number(item.from_id) === id || Number(item.to_id) === id;
    const incoming = kind === 'views'
        ? ['placements', 'links'].flatMap(topologyKind => (data[topologyKind] || []).filter(item => Number(item.view_id) === id))
        : ['placements', 'links'].flatMap(topologyKind => (data[topologyKind] || []).filter(refers));
    const referenced = new Set(incoming.flatMap(item => item.device_id == null
        ? [Number(item.from_id), Number(item.to_id)] : [Number(item.device_id)]));
    const maps = { devices: {}, views: {}, placements: {}, links: {}, canvas_notes: {} };
    for (const collisionKind of ['devices', ...viewChildKinds]) {
        const rows = appState[stateKey(collisionKind)];
        const targets = new Set(collisionKind === 'devices' && kind === 'views' ? referenced :
            collisionKind === 'devices' ? [] :
                collisionKind === 'canvas_notes'
                    ? (kind === 'views' ? (data.canvas_notes || []).filter(item => Number(item.view_id) === id) : []).map(item => Number(item.id))
                    : incoming.filter(item => collisionKind === 'placements' ? item.device_id != null : item.device_id == null)
                        .map(item => Number(item.id)));
        const persisted = new Set(collisionKind === 'devices' ? savedBaseline.devices.keys() :
            [...savedBaseline.views.values()].flatMap(resource => resource[collisionKind].map(item => Number(item.id))));
        let nextId = 0;
        for (const item of rows) nextId = Math.max(nextId, Number(item.id));
        for (const item of data[collisionKind] || []) nextId = Math.max(nextId, Number(item.id));
        for (const item of rows) {
            const replaced = collisionKind !== 'devices' &&
                (kind === 'views' ? Number(item.view_id) === id : refers(item));
            if (!replaced && targets.has(Number(item.id)) && !persisted.has(Number(item.id))) {
                maps[collisionKind][item.id] = ++nextId;
            }
        }
    }
    remapResourceState(appState, maps);
    remapResourceUiState(maps);
    appState[kind] = appState[kind].filter(row => Number(row.id) !== id);
    if (row) appState[kind].push(normalize(row));
    savedBaseline[kind].delete(id);
    if (remote[kind].has(id)) savedBaseline[kind].set(id, remote[kind].get(id));
    if (kind === 'views') {
        appState.placements = appState.placements.filter(row => Number(row.view_id) !== id);
        appState.links = appState.links.filter(row => Number(row.view_id) !== id);
        appState.canvasNotes = appState.canvasNotes.filter(note => Number(note.view_id) !== id);
        const placements = (data.placements || []).filter(row => Number(row.view_id) === id);
        const links = (data.links || []).filter(row => Number(row.view_id) === id);
        const referenced = new Set([
            ...placements.map(row => Number(row.device_id)),
            ...links.flatMap(row => [Number(row.from_id), Number(row.to_id)])
        ]);
        // リモートの構成を復元するために必要な機器だけ補う。既存機器の入力は変更しない。
        for (const device of data.devices || []) {
            const deviceId = Number(device.id);
            if (referenced.has(deviceId) && !appState.devices.some(row => Number(row.id) === deviceId)) {
                appState.devices.push(normalizeDevice(device));
                savedBaseline.devices.set(deviceId, remote.devices.get(deviceId));
            }
        }
        appState.placements.push(...placements.map(normalizePlacement));
        appState.links.push(...links.map(normalizeLink));
        appState.canvasNotes.push(...(data.canvas_notes || []).filter(note => Number(note.view_id) === id).map(normalizeCanvasNote));
        appState.floorPlans = appState.floorPlans.filter(row => Number(row.view_id) !== id);
        appState.floorPlans.push(...(data.floor_plans || []).filter(row => Number(row.view_id) === id));
        if (!row) {
            appState.viewStates.delete(id);
            appState.floorPlanAutoFittedViews.delete(id);
            if (Number(appState.currentViewId) === id) appState.currentViewId = appState.views[0]?.id ?? null;
        }
    } else {
        if (!row || !existed) {
            // 機器の削除/復元による依存行だけ反映し、同じビューのその他の編集を残す。
            const unrelatedChanges = new Set();
            for (const [viewId, baseline] of savedBaseline.views) {
                const remoteView = remote.views.get(viewId);
                const related = [baseline, remoteView].some(resource =>
                    resource && (resource.placements.some(refers) || resource.links.some(refers)));
                if (!related) continue;
                if (!remoteView || !equal(baseline.view, remoteView.view) ||
                    !equal(baseline.canvas_notes, remoteView.canvas_notes) ||
                    ['placements', 'links'].some(topologyKind =>
                        !equal(baseline[topologyKind].filter(item => !refers(item)),
                            remoteView[topologyKind].filter(item => !refers(item))))) {
                    unrelatedChanges.add(viewId);
                    appState.resourceConflicts.views.set(viewId, {
                        kind: 'views', id: viewId, name: remoteView?.view.name || baseline.view.name,
                        message: '関連機器の再読込時にビューの別の変更を検出しました。ビューを確認して再読込してください'
                    });
                }
            }
            const currentDeviceIds = new Set(appState.devices.map(device => Number(device.id)));
            for (const topologyKind of ['placements', 'links']) {
                const normalizeTopology = topologyKind === 'placements' ? normalizePlacement : normalizeLink;
                const affected = new Set();
                for (const item of appState[topologyKind]) if (refers(item)) affected.add(Number(item.view_id));
                appState[topologyKind] = appState[topologyKind].filter(item => !refers(item));
                for (const item of data[topologyKind] || []) {
                    if (refers(item) && appState.views.some(view => Number(view.id) === Number(item.view_id)) &&
                        (topologyKind !== 'links' || (currentDeviceIds.has(Number(item.from_id)) &&
                            currentDeviceIds.has(Number(item.to_id))))) {
                        affected.add(Number(item.view_id));
                        appState[topologyKind].push(normalizeTopology(item));
                    }
                }
                for (const [viewId, baseline] of savedBaseline.views) {
                    if (baseline[topologyKind].some(refers)) affected.add(viewId);
                    const remoteView = remote.views.get(viewId);
                    baseline[topologyKind] = sorted([
                        ...baseline[topologyKind].filter(item => !refers(item)),
                        ...(remoteView?.[topologyKind] || []).filter(refers)
                    ]);
                    if (affected.has(viewId) && remoteView && !unrelatedChanges.has(viewId)) {
                        syncResourceRevision('views', viewId, remoteView.revision);
                    }
                }
            }
        }
        appState.deviceImages = appState.deviceImages.filter(item => Number(item.device_id) !== id);
        appState.deviceImages.push(...(data.device_images || []).filter(item => Number(item.device_id) === id));
        if (!row) {
            if (Number(appState.editingDeviceId) === id) appState.editingDeviceId = null;
            if (Number(appState.linkSourceId) === id) resetLinkCreationState();
        }
    }
    const placementIds = new Set(appState.placements.map(row => Number(row.id)));
    for (const selected of appState.selectedPlacementIds) {
        if (!placementIds.has(Number(selected))) appState.selectedPlacementIds.delete(selected);
    }
    if (!appState.links.some(row => Number(row.id) === Number(appState.editingLinkId))) appState.editingLinkId = null;
    if (!appState.canvasNotes.some(note => Number(note.id) === Number(appState.selectedCanvasNoteId))) {
        appState.selectedCanvasNoteId = null;
    }
    recalculateNextIds();
    return maps;
}
