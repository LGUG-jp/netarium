import {
    appState, normalizeDevice, normalizeLink, normalizePlacement, normalizeView,
    toSaveDevice, toSaveLink, toSavePlacement, toSaveView, recalculateNextIds
} from './state.js';
import { normalizeCanvasNote, toSaveCanvasNote } from './canvas-note-data.js';
import { resetLinkCreationState } from './link-mode.js';
import { toSaveRackSettings, toSaveRackMount, toSaveRackShelf as copyShelf, toSaveRackShelfDevice as copyShelfDevice } from './rack-layout.js';
import { floorRackPlacements, toSaveFloorRackPlacement } from './floor-rack-data.js';

const rackSettings = data => data.rackSettings || (Array.isArray(data.rack_settings) ? data.rack_settings : data.rack_settings ? [data.rack_settings] : []);
const rackMounts = data => data.rackMounts || data.rack_mounts || [];
const rackShelves = data => data.rackShelves || data.rack_shelves || [];
const shelfDevices = data => data.rackShelfDevices || data.rack_shelf_devices || [];
const shelfMembers = (data, viewId) => {
    const ids = new Set(rackShelves(data).filter(row => Number(row.view_id) === Number(viewId)).map(row => Number(row.id)));
    return shelfDevices(data).filter(row => ids.has(Number(row.shelf_id)));
};
const rackDevices = resource => [...(resource?.rack_mounts || []), ...(resource?.rack_shelf_devices || [])];
const rackResource = (data, view, deleted = new Set()) => view.view_type === 'rack' ? {
    rack_settings: rackSettings(data).filter(row => Number(row.view_id) === Number(view.id)).map(toSaveRackSettings)[0] || null,
    rack_mounts: rackMounts(data).filter(row => Number(row.view_id) === Number(view.id) && !deleted.has(Number(row.device_id)))
        .map(toSaveRackMount).sort((a, b) => a.device_id - b.device_id),
    rack_shelves: rackShelves(data).filter(row => Number(row.view_id) === Number(view.id)).map(copyShelf).sort((a, b) => a.id - b.id),
    rack_shelf_devices: shelfMembers(data, view.id).filter(row => !deleted.has(Number(row.device_id)))
        .map(copyShelfDevice).sort((a, b) => a.device_id - b.device_id)
} : {};

const resourceFields = row => ({
    view: row.view,
    ...(row.view.view_type === 'rack' ? { rack_settings: row.rack_settings, rack_mounts: row.rack_mounts || [],
        rack_shelves: row.rack_shelves || [], rack_shelf_devices: row.rack_shelf_devices || [] } : {}),
    floor_rack_placements: row.floor_rack_placements || [],
    placements: row.placements, links: row.links, canvas_notes: row.canvas_notes || []
});

const sorted = rows => rows.sort((a, b) => Number(a.id) - Number(b.id));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const byId = rows => new Map(rows.map(row => [Number(row.id), row]));
const stateKey = kind => ({ canvas_notes: 'canvasNotes', rack_shelves: 'rackShelves' })[kind] || kind;
const viewChildKinds = ['placements', 'links', 'canvas_notes'];

export function viewResource(data, view, deletedDevices = new Set()) {
    const id = Number(view.id);
    return {
        view: toSaveView(view),
        ...rackResource(data, view, deletedDevices),
        floor_rack_placements: floorRackPlacements(data).filter(row => Number(row.floor_view_id) === id)
            .map(toSaveFloorRackPlacement).sort((a, b) => a.rack_view_id - b.rack_view_id),
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
            ...(before.view.view_type === 'rack' ? {
                rack_settings: before.rack_settings,
                rack_mounts: before.rack_mounts.filter(row => !deletedDevices.has(row.device_id)),
                rack_shelves: before.rack_shelves || [],
                rack_shelf_devices: (before.rack_shelf_devices || []).filter(row => !deletedDevices.has(row.device_id))
            } : {}),
            floor_rack_placements: before.floor_rack_placements || [],
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
        ...(resource?.links || []).flatMap(row => [Number(row.from_id), Number(row.to_id)]),
        ...rackDevices(resource).map(row => Number(row.device_id))
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
            // A new rack device and its initial mount are one registration, even after a 409.
            if (operation.operation === 'create' && !blockedDevices.has(operation.id) &&
                payload.views.some(view => blockedViews.has(view.id) &&
                    rackDevices(view).some(mount => Number(mount.device_id) === operation.id))) {
                blockedDevices.add(operation.id);
                changed = true;
            }
            if (operation.operation !== 'delete' || blockedDevices.has(operation.id)) continue;
            if ([...blockedViews].some(id =>
                references(baseline.views.get(id)).includes(operation.id) ||
                references(payload.views.find(row => row.id === id)).includes(operation.id))) {
                blockedDevices.add(operation.id);
                changed = true;
            }
        }
        // 移設は元ラックと先ラックを一緒に保留し、片側だけ送信しない。
        for (const operation of payload.views) {
            if (blockedViews.has(operation.id)) continue;
            const ids = new Set([...rackDevices(operation),
                ...rackDevices(baseline.views.get(operation.id))].map(row => row.device_id));
            const shelfIds = new Set([...(operation.rack_shelves || []),
                ...(baseline.views.get(operation.id)?.rack_shelves || [])].map(row => row.id));
            if ([...blockedViews].some(id => [...rackDevices(baseline.views.get(id)),
                ...rackDevices(payload.views.find(row => row.id === id))].some(row => ids.has(row.device_id)) ||
                [...(baseline.views.get(id)?.rack_shelves || []), ...(payload.views.find(row => row.id === id)?.rack_shelves || [])]
                    .some(row => shelfIds.has(row.id)))) {
                blockedViews.add(operation.id);
                changed = true;
            }
        }
        // ラック参照の移設と本体削除は、参照元/先の競合と一緒に保留する。
        for (const operation of payload.views) {
            if (blockedViews.has(operation.id)) continue;
            const references = resource => (resource?.floor_rack_placements || []).map(row => Number(row.rack_view_id));
            const ids = new Set([operation.id, ...references(operation), ...references(baseline.views.get(operation.id))]);
            if ([...blockedViews].some(id => ids.has(id) ||
                [...references(baseline.views.get(id)), ...references(payload.views.find(row => row.id === id))]
                    .some(rackId => ids.has(rackId)))) {
                blockedViews.add(operation.id);
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
    const views = new Map([...baseline.views].map(([id, row]) => [id, resourceFields(row)]));
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
        canvasNotes: [...views.values()].flatMap(row => row.canvas_notes),
        rackSettings: [...views.values()].flatMap(row => row.rack_settings ? [row.rack_settings] : []),
        rackMounts: [...views.values()].flatMap(row => row.rack_mounts || []).filter(row => !deleted.has(Number(row.device_id))),
        rackShelves: [...views.values()].flatMap(row => row.rack_shelves || []),
        floorRackPlacements: [...views.values()].flatMap(row => row.floor_rack_placements || [])
            .filter(row => views.has(Number(row.rack_view_id))),
        rackShelfDevices: [...views.values()].flatMap(row => row.rack_shelf_devices || []).filter(row => !deleted.has(Number(row.device_id)))
    };
}

export function createPendingResourceSave(payload, baseline = savedBaseline, data = appState) {
    const deleted = new Set(payload.devices.filter(row => row.operation === 'delete').map(row => row.id));
    const affectedViewIds = new Set(payload.views.map(row => row.id));
    for (const [id, row] of baseline.views) {
        if (row.placements.some(p => deleted.has(p.device_id)) ||
            row.links.some(link => deleted.has(link.from_id) || deleted.has(link.to_id)) ||
            rackDevices(row).some(mount => deleted.has(mount.device_id))) affectedViewIds.add(id);
    }
    const deletedViews = new Set(payload.views.filter(row => row.operation === 'delete').map(row => row.id));
    for (const [id, row] of baseline.views) {
        if ((row.floor_rack_placements || []).some(ref => deletedViews.has(Number(ref.rack_view_id)))) affectedViewIds.add(id);
    }
    const newIds = {
        devices: payload.devices.filter(row => row.operation === 'create').map(row => row.id),
        views: payload.views.filter(row => row.operation === 'create').map(row => row.id),
        placements: [],
        links: [],
        canvas_notes: [],
        rack_shelves: []
    };
    for (const operation of payload.views) {
        if (operation.operation === 'delete') continue;
        const previous = baseline.views.get(operation.id);
        for (const kind of viewChildKinds) {
            const existing = new Set((previous?.[kind] || []).map(row => row.id));
            newIds[kind].push(...(operation[kind] || []).filter(row => !existing.has(row.id)).map(row => row.id));
        }
    }
    const existingShelfIds = new Set([...baseline.views.values()].flatMap(row => (row.rack_shelves || []).map(shelf => shelf.id)));
    for (const operation of payload.views) {
        newIds.rack_shelves.push(...(operation.rack_shelves || []).filter(row => !existingShelfIds.has(row.id)).map(row => row.id));
    }
    const snapshot = {
        devices: (data.devices || []).map(toSaveDevice),
        views: (data.views || []).map(toSaveView),
        placements: (data.placements || []).map(toSavePlacement),
        links: (data.links || []).map(toSaveLink),
        canvasNotes: (data.canvasNotes || data.canvas_notes || []).map(toSaveCanvasNote),
        rackSettings: rackSettings(data).map(toSaveRackSettings),
        rackMounts: rackMounts(data).map(toSaveRackMount),
        rackShelves: rackShelves(data).map(copyShelf),
        floorRackPlacements: floorRackPlacements(data).map(toSaveFloorRackPlacement),
        rackShelfDevices: shelfDevices(data).map(copyShelfDevice)
    };
    return {
        payload, affectedViewIds: [...affectedViewIds], snapshot, newIds,
        hasNewViewChildIds: [...viewChildKinds, 'rack_shelves'].some(kind => newIds[kind].length > 0)
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
    if (!equal(floorRackPlacements(data).map(toSaveFloorRackPlacement), pending.snapshot.floorRackPlacements || [])) return true;
    if (!equal(rackSettings(data).map(toSaveRackSettings), pending.snapshot.rackSettings || []) ||
        !equal(rackMounts(data).map(toSaveRackMount), pending.snapshot.rackMounts || []) ||
        !equal(rackShelves(data).map(copyShelf), pending.snapshot.rackShelves || []) ||
        !equal(shelfDevices(data).map(copyShelfDevice), pending.snapshot.rackShelfDevices || [])) return true;
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
                    ? resourceFields(operation)
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
        rack_settings: rackSettings(data).filter(row => views.has(Number(row.view_id))),
        rack_mounts: rackMounts(data).filter(row => views.has(Number(row.view_id))),
        rack_shelves: rackShelves(data).filter(row => views.has(Number(row.view_id))),
        floor_rack_placements: floorRackPlacements(data).filter(row => views.has(Number(row.floor_view_id))),
        rack_shelf_devices: shelfDevices(data).filter(row => rackShelves(data).some(shelf =>
            views.has(Number(shelf.view_id)) && Number(shelf.id) === Number(row.shelf_id))),
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
    rackSettings(data).forEach(row => { row.view_id = id('views', row.view_id); });
    rackMounts(data).forEach(row => {
        row.view_id = id('views', row.view_id);
        row.device_id = id('devices', row.device_id);
    });
    rackShelves(data).forEach(row => {
        row.id = id('rack_shelves', row.id); row.view_id = id('views', row.view_id);
    });
    shelfDevices(data).forEach(row => {
        row.shelf_id = id('rack_shelves', row.shelf_id); row.device_id = id('devices', row.device_id);
    });
    floorRackPlacements(data).forEach(row => {
        row.floor_view_id = id('views', row.floor_view_id);
        row.rack_view_id = id('views', row.rack_view_id);
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
    const affectsRack = [...result.views, ...appState.views.filter(row =>
        result.affected_view_ids.map(Number).includes(Number(row.id)))].some(row => row.view_type === 'rack');
    if (affectsRack && (!Array.isArray(result.rack_settings) || !Array.isArray(result.rack_mounts) ||
        (rackShelves(appState).length > 0 && (!Array.isArray(result.rack_shelves) || !Array.isArray(result.rack_shelf_devices))))) {
        throw new Error('ラックの保存応答が不完全です。保存状態を確認してください');
    }
    if (floorRackPlacements(appState).some(row => result.affected_view_ids.map(Number).includes(Number(row.floor_view_id))) &&
        !Array.isArray(result.floor_rack_placements)) {
        throw new Error('ラック配置の保存応答が不完全です。保存状態を確認してください');
    }
    for (const [kind, ids] of Object.entries(pending?.newIds || {})) {
        if (ids.some(id => !Number.isInteger(Number(result.id_maps[kind]?.[id])) || Number(result.id_maps[kind]?.[id]) <= 0)) {
            throw new Error('新規作成のID対応を受信できませんでした。最新データを再読込してください');
        }
    }
    const maps = Object.fromEntries(['devices', 'views', ...viewChildKinds, 'rack_shelves']
        .map(kind => [kind, { ...result.id_maps[kind] }]));
    const snapshot = pending?.snapshot;
    if (snapshot) {
        // 保留中/応答待ちに追加した未送信仮IDも、採番IDとの衝突から退避する。
        for (const kind of ['devices', 'views', ...viewChildKinds, 'rack_shelves']) {
            const rows = appState[stateKey(kind)] || [];
            const persistedIds = ['devices', 'views'].includes(kind)
                ? [...savedBaseline[kind].keys()]
                : [...savedBaseline.views.values()].flatMap(row => (row[kind] || []).map(item => Number(item.id)));
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
                resourceFields(remote))) {
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
    appState.floorRackPlacements = [
        ...floorRackPlacements(appState).filter(row => !replaceTopology.has(Number(row.floor_view_id)) &&
            currentViewIds.has(Number(row.floor_view_id)) && currentViewIds.has(Number(row.rack_view_id))),
        ...floorRackPlacements(result).filter(row => replaceTopology.has(Number(row.floor_view_id)) &&
            currentViewIds.has(Number(row.floor_view_id)) && currentViewIds.has(Number(row.rack_view_id))).map(toSaveFloorRackPlacement)
    ];
    appState.rackSettings = [
        ...appState.rackSettings.filter(row => !replaceTopology.has(Number(row.view_id))),
        ...rackSettings(result).filter(row => replaceTopology.has(Number(row.view_id)) && currentViewIds.has(Number(row.view_id))).map(toSaveRackSettings)
    ];
    appState.rackMounts = [
        ...appState.rackMounts.filter(row => !replaceTopology.has(Number(row.view_id)) && !deletedDevices.has(Number(row.device_id))),
        ...rackMounts(result).filter(row => replaceTopology.has(Number(row.view_id)) && currentViewIds.has(Number(row.view_id)) &&
            currentDeviceIds.has(Number(row.device_id))).map(toSaveRackMount)
    ];
    const replacedShelfIds = new Set(rackShelves(appState).filter(row => replaceTopology.has(Number(row.view_id))).map(row => Number(row.id)));
    appState.rackShelves = [
        ...rackShelves(appState).filter(row => !replaceTopology.has(Number(row.view_id))),
        ...rackShelves(result).filter(row => replaceTopology.has(Number(row.view_id)) && currentViewIds.has(Number(row.view_id))).map(copyShelf)
    ];
    const currentShelfIds = new Set(appState.rackShelves.map(row => Number(row.id)));
    const incomingShelfIds = new Set(rackShelves(result).filter(row => replaceTopology.has(Number(row.view_id))).map(row => Number(row.id)));
    appState.rackShelfDevices = [
        ...shelfDevices(appState).filter(row => !replacedShelfIds.has(Number(row.shelf_id)) &&
            currentShelfIds.has(Number(row.shelf_id)) && !deletedDevices.has(Number(row.device_id))),
        ...shelfDevices(result).filter(row => incomingShelfIds.has(Number(row.shelf_id)) &&
            currentDeviceIds.has(Number(row.device_id))).map(copyShelfDevice)
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

function reconcileRackReload(id, remote) {
    const localView = appState.views.find(row => Number(row.id) === id);
    const resources = [savedBaseline.views.get(id), localView && viewResource(appState, localView), remote.views.get(id)];
    const involved = new Set(resources.flatMap(rackDevices).map(row => Number(row.device_id)));
    const shelfIds = new Set(resources.flatMap(row => row?.rack_shelves || []).map(row => Number(row.id)));
    if (!involved.size && !shelfIds.size) return;
    const matches = (kind, row) => kind === 'rack_shelves' ? shelfIds.has(Number(row.id)) :
        involved.has(Number(row.device_id)) || (kind === 'rack_shelf_devices' && shelfIds.has(Number(row.shelf_id)));
    const kinds = ['rack_mounts', 'rack_shelves', 'rack_shelf_devices'];
    const subset = (resource, matching) => Object.fromEntries(kinds.map(kind =>
        [kind, (resource?.[kind] || []).filter(row => matches(kind, row) === matching)]));
    const remaining = resource => ({ ...resourceFields(resource), ...subset(resource, false) });
    for (const [viewId, before] of savedBaseline.views) {
        if (viewId === id || before.view.view_type !== 'rack') continue;
        const incoming = remote.views.get(viewId);
        const view = appState.views.find(row => Number(row.id) === viewId);
        const local = view && viewResource(appState, view);
        if (![before, incoming, local].some(resource => kinds.some(kind => (resource?.[kind] || []).some(row => matches(kind, row))))) continue;
        const localChanges = local && !equal(subset(local, true), subset(before, true));
        const safeRevision = incoming && equal(remaining(before), remaining(incoming));
        const oldShelfIds = new Set(rackShelves(appState).filter(row => Number(row.view_id) === viewId).map(row => Number(row.id)));
        appState.rackMounts = appState.rackMounts.filter(row => Number(row.view_id) !== viewId || !matches('rack_mounts', row));
        appState.rackShelves = rackShelves(appState).filter(row => Number(row.view_id) !== viewId || !matches('rack_shelves', row));
        const incomingMembers = (incoming?.rack_shelf_devices || []).filter(row => matches('rack_shelf_devices', row));
        const incomingMemberIds = new Set(incomingMembers.map(row => Number(row.device_id)));
        appState.rackShelfDevices = shelfDevices(appState).filter(row => !incomingMemberIds.has(Number(row.device_id)) &&
            (!oldShelfIds.has(Number(row.shelf_id)) || !matches('rack_shelf_devices', row)));
        if (view) {
            appState.rackMounts.push(...(incoming?.rack_mounts || []).filter(row => matches('rack_mounts', row)).map(toSaveRackMount));
            appState.rackShelves.push(...(incoming?.rack_shelves || []).filter(row => matches('rack_shelves', row)).map(copyShelf));
            appState.rackShelfDevices.push(...incomingMembers.map(copyShelfDevice));
        }
        if (safeRevision) {
            savedBaseline.views.set(viewId, incoming);
            if (view) view.resource_revision = incoming.revision;
        } else {
            for (const kind of kinds) before[kind] = [...subset(before, false)[kind], ...subset(incoming, true)[kind]]
                .sort((a, b) => Number(a.id ?? a.device_id) - Number(b.id ?? b.device_id));
        }
        if (!safeRevision || localChanges) {
            appState.resourceConflicts.views.set(viewId, {
                kind: 'views', id: viewId, name: view?.name || before.view.name,
                message: '移設先・元ラックに別の変更があります。このラックも確認して再読込してください'
            });
        }
    }
}

function reconcileFloorRackReload(id, remote) {
    const refs = resource => resource?.floor_rack_placements || [];
    const localView = appState.views.find(row => Number(row.id) === id);
    const involved = new Set([id, ...[savedBaseline.views.get(id), localView && viewResource(appState, localView), remote.views.get(id)]
        .flatMap(resource => refs(resource).map(row => Number(row.rack_view_id)))]);
    const matches = row => involved.has(Number(row.rack_view_id));
    const viewIds = new Set([...savedBaseline.views.keys(), ...appState.views.map(row => Number(row.id))]);
    for (const viewId of viewIds) {
        if (viewId === id) continue;
        const before = savedBaseline.views.get(viewId);
        const incoming = remote.views.get(viewId);
        const view = appState.views.find(row => Number(row.id) === viewId);
        const local = view && viewResource(appState, view);
        if (![before, incoming, local].some(resource => refs(resource).some(matches))) continue;
        const withoutRelated = resource => ({ ...resourceFields(resource),
            floor_rack_placements: refs(resource).filter(row => !matches(row)) });
        const safe = before && incoming && equal(withoutRelated(before), withoutRelated(incoming));
        const localChanges = !local || !before || !equal(local, resourceFields(before));
        appState.floorRackPlacements = floorRackPlacements(appState)
            .filter(row => Number(row.floor_view_id) !== viewId || !matches(row));
        if (view) appState.floorRackPlacements.push(...refs(incoming).filter(matches).map(toSaveFloorRackPlacement));
        if (safe && !localChanges) {
            savedBaseline.views.set(viewId, incoming);
            if (view) view.resource_revision = incoming.revision;
        } else {
            appState.resourceConflicts.views.set(viewId, { kind: 'views', id: viewId,
                name: view?.name || before?.view.name,
                message: 'ラック配置の参照元に別の変更があります。この物理配置図も確認して再読込してください' });
        }
    }
}

export function reloadResourceFromData(kind, id, data) {
    id = Number(id);
    const remote = createResourceBaseline(data);
    const row = (data[kind] || []).find(row => Number(row.id) === id);
    if (kind === 'views') reconcileFloorRackReload(id, remote);
    const normalize = kind === 'devices' ? normalizeDevice : normalizeView;
    const existed = appState[kind].some(row => Number(row.id) === id);
    const refers = item => Number(item.device_id) === id || Number(item.from_id) === id || Number(item.to_id) === id;
    const incoming = kind === 'views'
        ? ['placements', 'links'].flatMap(topologyKind => (data[topologyKind] || []).filter(item => Number(item.view_id) === id))
        : ['placements', 'links'].flatMap(topologyKind => (data[topologyKind] || []).filter(refers));
    const referenced = new Set(incoming.flatMap(item => item.device_id == null
        ? [Number(item.from_id), Number(item.to_id)] : [Number(item.device_id)]));
    for (const mount of rackMounts(data)) {
        if (kind === 'views' && Number(mount.view_id) === id) referenced.add(Number(mount.device_id));
    }
    if (kind === 'views') for (const member of shelfMembers(data, id)) referenced.add(Number(member.device_id));
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
    if (kind === 'views') reconcileRackReload(id, remote);
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
            ...links.flatMap(row => [Number(row.from_id), Number(row.to_id)]),
            ...rackMounts(data).filter(row => Number(row.view_id) === id).map(row => Number(row.device_id)),
            ...shelfMembers(data, id).map(row => Number(row.device_id))
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
        appState.floorRackPlacements = floorRackPlacements(appState).filter(ref => Number(ref.floor_view_id) !== id &&
            (row || Number(ref.rack_view_id) !== id));
        appState.floorRackPlacements.push(...floorRackPlacements(data).filter(ref => Number(ref.floor_view_id) === id)
            .map(toSaveFloorRackPlacement));
        const referencedRacks = new Set(floorRackPlacements(data).filter(ref => Number(ref.floor_view_id) === id)
            .map(ref => Number(ref.rack_view_id)));
        // 未取得のラックだけ既存の再読込経路で補い、既存リソースの未保存編集は維持する。
        for (const rackId of referencedRacks) {
            if (!appState.views.some(view => Number(view.id) === rackId) &&
                remote.views.get(rackId)?.view.view_type === 'rack') {
                reloadResourceFromData('views', rackId, data);
            }
        }
        appState.rackSettings = appState.rackSettings.filter(row => Number(row.view_id) !== id);
        appState.rackSettings.push(...rackSettings(data).filter(row => Number(row.view_id) === id).map(toSaveRackSettings));
        appState.rackMounts = appState.rackMounts.filter(row => Number(row.view_id) !== id);
        appState.rackMounts.push(...rackMounts(data).filter(row => Number(row.view_id) === id).map(toSaveRackMount));
        const oldShelfIds = new Set(rackShelves(appState).filter(row => Number(row.view_id) === id).map(row => Number(row.id)));
        const retainedShelfIds = new Set(rackShelves(appState).filter(row => Number(row.view_id) !== id).map(row => Number(row.id)));
        // 移設元の旧棚IDと移設先へ同期済みのIDは同じ。移設先の所属まで除去しない。
        appState.rackShelfDevices = shelfDevices(appState).filter(row =>
            !oldShelfIds.has(Number(row.shelf_id)) || retainedShelfIds.has(Number(row.shelf_id)));
        appState.rackShelves = rackShelves(appState).filter(row => Number(row.view_id) !== id);
        appState.rackShelves.push(...rackShelves(data).filter(row => Number(row.view_id) === id).map(copyShelf));
        appState.rackShelfDevices.push(...shelfMembers(data, id).map(copyShelfDevice));
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
                const rackRelated = [baseline, remoteView].some(resource => rackDevices(resource).some(refers));
                if (!related && !rackRelated) continue;
                if (!remoteView || !equal(baseline.view, remoteView.view) ||
                    !equal(baseline.canvas_notes, remoteView.canvas_notes) ||
                    !equal(baseline.rack_settings, remoteView.rack_settings) ||
                    !equal(baseline.floor_rack_placements, remoteView.floor_rack_placements) ||
                    !equal(baseline.rack_shelves, remoteView.rack_shelves) ||
                    !equal((baseline.rack_shelf_devices || []).filter(item => !refers(item)), (remoteView.rack_shelf_devices || []).filter(item => !refers(item))) ||
                    !equal((baseline.rack_mounts || []).filter(item => !refers(item)), (remoteView.rack_mounts || []).filter(item => !refers(item))) ||
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
            appState.rackMounts = appState.rackMounts.filter(item => !refers(item));
            appState.rackMounts.push(...rackMounts(data).filter(item => refers(item) &&
                appState.views.some(view => Number(view.id) === Number(item.view_id))).map(toSaveRackMount));
            for (const [viewId, baseline] of savedBaseline.views) {
                const remoteView = remote.views.get(viewId);
                const related = [...rackDevices(baseline), ...rackDevices(remoteView)].some(refers);
                if (!related) continue;
                baseline.rack_mounts = [...(baseline.rack_mounts || []).filter(item => !refers(item)),
                    ...(remoteView?.rack_mounts || []).filter(refers)].sort((a, b) => a.device_id - b.device_id);
                baseline.rack_shelf_devices = [...(baseline.rack_shelf_devices || []).filter(item => !refers(item)),
                    ...(remoteView?.rack_shelf_devices || []).filter(refers)].sort((a, b) => a.device_id - b.device_id);
                if (remoteView && !unrelatedChanges.has(viewId)) syncResourceRevision('views', viewId, remoteView.revision);
            }
            appState.rackShelfDevices = shelfDevices(appState).filter(item => !refers(item));
            const availableShelfIds = new Set(rackShelves(appState).map(shelf => Number(shelf.id)));
            appState.rackShelfDevices.push(...shelfDevices(data).filter(item => refers(item) &&
                availableShelfIds.has(Number(item.shelf_id))).map(copyShelfDevice));
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
