// 境界の型契約のみ検査する。ファイル全体の @ts-check を見送った理由は docs/development.md の #393 を参照。
import {
    appState, normalizeDevice, normalizeFloorPlan, normalizePlacement, normalizeView,
    toSaveDevice, toSavePlacement, toSaveView, recalculateNextIds, removeDevicesFromState, resetLinkCreationState,
    setReservedIdProvider
} from './state.js';
import { normalizeCanvasNote, toSaveCanvasNote } from './canvas-note-data.js';
import { toSaveRackSettings, toSaveRackMount, toSaveRackShelf as copyShelf, toSaveRackShelfDevice as copyShelfDevice } from './rack-layout.js';
import { floorRackPlacements, toSaveFloorRackPlacement } from './floor-rack-data.js';
import { eventBus } from './event-bus.js';
import { compareViewRoutes, normalizeViewLinkRoute, pairKey, viewRouteKey } from './connection-data.js';
import { resetConnectionBaseline, discardSavedDeviceConnections, reloadDeviceConnections, savedConnectionPairs } from './connection-save.js';
import { normalizeText, trimPhpText } from './utils.js';

/**
 * 保存変換の戻り値を再利用し、未注釈の種別フィールドだけ明示する。
 * ID は新規の仮 ID も含む number。整数・正数・revision の有効性は実行時に検証する。
 * @typedef {Omit<ReturnType<typeof toSaveDevice>, 'type'> & {type: string}} DeviceDto
 * @typedef {Omit<ReturnType<typeof toSaveView>, 'view_type'> & {view_type: 'topology' | 'floor' | 'rack'}} ViewDto
 * @typedef {ReturnType<typeof toSavePlacement>} PlacementDto
 * @typedef {ReturnType<typeof normalizeViewLinkRoute>} ViewLinkRouteDto
 * @typedef {ReturnType<typeof toSaveCanvasNote>} CanvasNoteDto
 * @typedef {ReturnType<typeof toSaveRackSettings>} RackSettingsDto
 * @typedef {Omit<ReturnType<typeof toSaveRackMount>, 'face' | 'width_slot' | 'depth'> & {face: string, width_slot: string, depth: string}} RackMountDto
 * @typedef {Omit<ReturnType<typeof copyShelf>, 'face' | 'depth'> & {face: string, depth: string}} RackShelfDto
 * @typedef {ReturnType<typeof copyShelfDevice>} RackShelfDeviceDto
 * @typedef {ReturnType<typeof toSaveFloorRackPlacement>} FloorRackPlacementDto
 * @typedef {Omit<Partial<DeviceDto>, 'id'> & {id: number | string, resource_revision?: number | string | null}} DeviceRow
 * @typedef {Omit<Partial<ViewDto>, 'id'> & {id: number | string, resource_revision?: number | string | null}} ViewRow
 */

/**
 * 読込時の snake_case と共有状態の camelCase を受け付ける。baseline 初期化では空データも有効。
 * @typedef {object} ResourceData
 * @property {DeviceRow[]} [devices]
 * @property {ViewRow[]} [views]
 * @property {PlacementDto[]} [placements]
 * @property {ViewLinkRouteDto[]} [viewLinkRoutes]
 * @property {ViewLinkRouteDto[]} [view_link_routes]
 * @property {CanvasNoteDto[]} [canvasNotes]
 * @property {CanvasNoteDto[]} [canvas_notes]
 * @property {RackSettingsDto[]} [rackSettings]
 * @property {RackSettingsDto[] | RackSettingsDto | null} [rack_settings]
 * @property {RackMountDto[]} [rackMounts]
 * @property {RackMountDto[]} [rack_mounts]
 * @property {RackShelfDto[]} [rackShelves]
 * @property {RackShelfDto[]} [rack_shelves]
 * @property {RackShelfDeviceDto[]} [rackShelfDevices]
 * @property {RackShelfDeviceDto[]} [rack_shelf_devices]
 * @property {FloorRackPlacementDto[]} [floorRackPlacements]
 * @property {FloorRackPlacementDto[]} [floor_rack_placements]
 * @property {{devices?: Map<number, unknown>, views?: Map<number, unknown>}} [resourceConflicts]
 */

/**
 * @typedef {ResourceData & {devices: DeviceRow[], views: ViewRow[]}} ResourceSaveState
 * @typedef {object} ViewResourceDto
 * @property {ViewDto} view
 * @property {PlacementDto[]} placements
 * @property {ViewLinkRouteDto[]} view_link_routes
 * @property {CanvasNoteDto[]} canvas_notes
 * @property {FloorRackPlacementDto[]} floor_rack_placements
 * @property {RackSettingsDto | null} [rack_settings]
 * @property {RackMountDto[]} [rack_mounts]
 * @property {RackShelfDto[]} [rack_shelves]
 * @property {RackShelfDeviceDto[]} [rack_shelf_devices]
 * @typedef {{id: number, revision: number, device: DeviceDto}} DeviceBaseline
 * @typedef {{id: number, revision: number} & ViewResourceDto} ViewBaseline
 * @typedef {{devices: Map<number, DeviceBaseline>, views: Map<number, ViewBaseline>}} ResourceBaseline
 */

/**
 * create は版番号なし、update/delete は baseline の版番号を必須とする。
 * @template T
 * @typedef {({operation: 'create', id: number} & T) | ({operation: 'update', id: number, expected_revision: number} & T) | {operation: 'delete', id: number, expected_revision: number}} ResourceOperation
 */
/** @typedef {ResourceOperation<{device: DeviceDto}>} DeviceOperation */
/** @typedef {ResourceOperation<ViewResourceDto>} ViewOperation */
/** @typedef {{devices: DeviceOperation[], views: ViewOperation[]}} ResourceSaveDto */
/** @typedef {Readonly<Record<string, number>>} ResourceIdMap */

/** @param {ResourceData} data */
const rackSettings = data => data.rackSettings || (Array.isArray(data.rack_settings) ? data.rack_settings : data.rack_settings ? [data.rack_settings] : []);
/** @param {ResourceData} data */
const rackMounts = data => data.rackMounts || data.rack_mounts || [];
/** @param {ResourceData} data */
const rackShelves = data => data.rackShelves || data.rack_shelves || [];
/** @param {ResourceData} data */
const shelfDevices = data => data.rackShelfDevices || data.rack_shelf_devices || [];
/** @param {ResourceData} data @param {number | string} viewId */
const shelfMembers = (data, viewId) => {
    const ids = new Set(rackShelves(data).filter(row => Number(row.view_id) === Number(viewId)).map(row => Number(row.id)));
    return shelfDevices(data).filter(row => ids.has(Number(row.shelf_id)));
};
const rackDevices = resource => [...(resource?.rack_mounts || []), ...(resource?.rack_shelf_devices || [])];
/** @param {ResourceData} data @param {ViewRow} view @param {Set<number>} deleted */
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
    placements: row.placements, view_link_routes: row.view_link_routes, canvas_notes: row.canvas_notes || []
});

/** @template {{id: number | string}} T @param {T[]} rows @returns {T[]} */
const sorted = rows => rows.sort((a, b) => Number(a.id) - Number(b.id));
// 重複確認は送信時だけの承認。保存成否の照合・差分・競合判定には含めない。
/** @param {unknown} value */
const persistentJson = value => JSON.stringify(value, (key, item) => key === 'ip_conflicts_confirmed' ? undefined : item);
/** @param {unknown} a @param {unknown} b */
const equal = (a, b) => persistentJson(a) === persistentJson(b);
/** @template {{id: number | string}} T @param {T[]} rows @returns {Map<number, T>} */
const byId = rows => new Map(rows.map(row => [Number(row.id), row]));
const stateKey = kind => ({ canvas_notes: 'canvasNotes', rack_shelves: 'rackShelves' })[kind] || kind;
const viewChildKinds = ['placements', 'canvas_notes'];
/** @param {ResourceData} data */
const viewRoutes = data => data.viewLinkRoutes || data.view_link_routes || [];
const routeRefers = (row, ids) => ids.has(Number(row.device_a_id)) || ids.has(Number(row.device_b_id));
const orderTopology = (kind, rows) => kind === 'placements' ? sorted(rows) : rows.sort(compareViewRoutes);

/**
 * @param {ResourceData} data
 * @param {ViewRow} view
 * @param {Set<number>} deletedDevices
 * @returns {ViewResourceDto}
 */
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
        view_link_routes: viewRoutes(data).filter(row => Number(row.view_id) === id && !routeRefers(row, deletedDevices))
            .map(normalizeViewLinkRoute).sort(compareViewRoutes),
        canvas_notes: sorted((data.canvasNotes || data.canvas_notes || [])
            .filter(row => Number(row.view_id) === id).map(toSaveCanvasNote))
    };
}

/** @param {ResourceData} data @returns {ResourceBaseline} */
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
setReservedIdProvider(kind => {
    if (kind === 'devices') return [...savedBaseline.devices.keys()];
    if (kind === 'views') return [...savedBaseline.views.keys()];
    if (kind === 'placements') return [...savedBaseline.views.values()].flatMap(v => (v.placements || []).map(row => Number(row.id)));
    if (kind === 'canvasNotes') return [...savedBaseline.views.values()].flatMap(v => (v.canvas_notes || []).map(row => Number(row.id)));
    if (kind === 'rackShelves') return [...savedBaseline.views.values()].flatMap(v => (v.rack_shelves || []).map(row => Number(row.id)));
    return [];
});
/** @param {ResourceData} data */
export function resetResourceBaseline(data) {
    savedBaseline = createResourceBaseline(data);
    resetConnectionBaseline(data);
}

/** @param {{id: number, revision: number}} row @returns {number} */
function expectedRevision(row) {
    if (!Number.isInteger(row.revision) || row.revision < 1) {
        throw new Error(`リソースID ${row.id} の保存版番号がありません。最新データを再読込してください`);
    }
    return row.revision;
}

/**
 * @param {ResourceSaveState} data
 * @param {ResourceBaseline} baseline
 * @returns {ResourceSaveDto}
 */
export function buildResourceSave(data = appState, baseline = savedBaseline) {
    return buildResourceDiff(data, baseline);
}

/** @param {ResourceSaveState} data @param {ResourceBaseline} baseline @param {Set<string>} [availablePairs] @returns {ResourceSaveDto} */
function buildResourceDiff(data, baseline, availablePairs) {
    /** @type {DeviceOperation[]} */
    const devices = [];
    /** @type {ViewOperation[]} */
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
        if (availablePairs) {
            const existingKeys = new Set((before?.view_link_routes || []).map(viewRouteKey));
            resource.view_link_routes = resource.view_link_routes.filter(route =>
                existingKeys.has(viewRouteKey(route)) || availablePairs.has(pairKey(route.device_a_id, route.device_b_id)));
        }
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
            view_link_routes: before.view_link_routes.filter(route => !routeRefers(route, deletedDevices)),
            canvas_notes: before.canvas_notes
        };
        if (!before) views.push({ operation: 'create', id, ...resource });
        else if (!equal(previous, resource)) {
            views.push({ operation: 'update', id, expected_revision: expectedRevision(before), ...resource });
        }
    }
    return { devices, views };
}

// ビューの配置更新は、送信する配置と保存済みの配置が参照するリソースの競合でも保留される。
export function hasViewPlacementConflict(viewId) {
    const id = Number(viewId);
    const { devices, views } = appState.resourceConflicts;
    if (views?.has(id)) return true;
    const saved = savedBaseline.views.get(id);
    return Boolean(
        (devices?.size && (appState.placements.some(row => Number(row.view_id) === id && devices.has(Number(row.device_id))) ||
            saved?.placements.some(row => devices.has(Number(row.device_id))))) ||
        (views?.size && (floorRackPlacements(appState).some(row => Number(row.floor_view_id) === id && views.has(Number(row.rack_view_id))) ||
            saved?.floor_rack_placements?.some(row => views.has(Number(row.rack_view_id)))))
    );
}

// 競合対象と、それを参照/削除する変更は保留する。独立した変更は保存できる。
/**
 * @param {ResourceSaveState} data
 * @param {ResourceBaseline} baseline
 * @returns {ResourceSaveDto}
 */
export function buildSaveableResourceSave(data = appState, baseline = savedBaseline) {
    const payload = buildResourceDiff(data, baseline, data === appState ? savedConnectionPairs() : undefined);
    const blockedDevices = new Set(data.resourceConflicts?.devices?.keys() || []);
    const blockedViews = new Set(data.resourceConflicts?.views?.keys() || []);
    const references = resource => [
        ...(resource?.placements || []).map(row => Number(row.device_id)),
        ...(resource?.view_link_routes || []).flatMap(row => [Number(row.device_a_id), Number(row.device_b_id)]),
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
            row.view_link_routes.some(route => routeRefers(route, deleted)) ||
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
        viewLinkRoutes: viewRoutes(data).map(normalizeViewLinkRoute),
        canvasNotes: (data.canvasNotes || data.canvas_notes || []).map(toSaveCanvasNote),
        rackSettings: rackSettings(data).map(toSaveRackSettings),
        rackMounts: rackMounts(data).map(toSaveRackMount),
        rackShelves: rackShelves(data).map(copyShelf),
        floorRackPlacements: floorRackPlacements(data).map(toSaveFloorRackPlacement),
        rackShelfDevices: shelfDevices(data).map(copyShelfDevice)
    };
    const deferredRouteViews = payload.views.filter(operation => {
        if (operation.operation === 'delete') return false;
        const sentKeys = new Set(operation.view_link_routes.map(viewRouteKey));
        return snapshot.viewLinkRoutes.some(row => row.view_id === operation.id && !sentKeys.has(viewRouteKey(row)));
    }).map(operation => operation.id);
    return {
        addressIdentities: (data.devices || []).map(device => ({
            device_id: Number(device.id),
            keys: (device.additional_ips || []).map(row => row._client_key || null)
        })),
        payload, affectedViewIds: [...affectedViewIds], snapshot, newIds, deferredRouteViews,
        hasNewViewChildIds: [...viewChildKinds, 'rack_shelves'].some(kind => newIds[kind].length > 0)
    };
}

export function hasResourceChangesSince(pending, data = appState) {
    if (!pending?.snapshot) return false;
    for (const [kind, toSave] of [
        ['devices', toSaveDevice], ['views', toSaveView],
        ['placements', toSavePlacement], ['canvasNotes', toSaveCanvasNote]
    ]) {
        const sent = byId(pending.snapshot[kind] || []);
        const rows = data[kind] || [];
        if (sent.size !== rows.length ||
            rows.some(row => !equal(toSave(row), sent.get(Number(row.id))))) return true;
    }
    if (!equal(viewRoutes(data), pending.snapshot.viewLinkRoutes)) return true;
    if (!equal(floorRackPlacements(data).map(toSaveFloorRackPlacement), pending.snapshot.floorRackPlacements || [])) return true;
    if (!equal(rackSettings(data).map(toSaveRackSettings), pending.snapshot.rackSettings || []) ||
        !equal(rackMounts(data).map(toSaveRackMount), pending.snapshot.rackMounts || []) ||
        !equal(rackShelves(data).map(copyShelf), pending.snapshot.rackShelves || []) ||
        !equal(shelfDevices(data).map(copyShelfDevice), pending.snapshot.rackShelfDevices || [])) return true;
    return false;
}

const COMMITTED_DEVICE_TEXT_FIELDS = [
    'name', 'ip', 'location', 'manufacturer', 'model',
    'asset_number', 'serial_number', 'mac_address', 'memo', 'management_scheme',
    'department', 'maintenance_vendor', 'install_date', 'maintenance_expiry'
];

function matchesCommittedDevice(desired, row) {
    const { additional_ips: desiredIps = [], ...normalized } = desired;
    const { additional_ips: actualIps = [] } = row;
    const { additional_ips, ...actual } = toSaveDevice({ ...row, additional_ips: [] });
    for (const field of COMMITTED_DEVICE_TEXT_FIELDS) {
        normalized[field] = trimPhpText(normalized[field]);
    }
    if (!equal(normalized, actual)) return false;
    if (desiredIps.length !== actualIps.length) return false;
    for (let i = 0; i < desiredIps.length; i++) {
        const d = desiredIps[i];
        const a = actualIps[i];
        if (!d || !a) return false;
        if (d.id != null) {
            if (Number(a.id) !== Number(d.id)) return false;
        } else {
            const actualId = Number(a.id);
            if (!Number.isSafeInteger(actualId) || actualId <= 0) return false;
        }
        if (trimPhpText(d.ip) !== normalizeText(a.ip)) return false;
        if (trimPhpText(d.label) !== normalizeText(a.label)) return false;
        if (Number(d.sort_order ?? i) !== Number(a.sort_order ?? i)) return false;
        const dSeg = d.segment_id == null ? null : Number(d.segment_id);
        const aSeg = a.segment_id == null ? null : Number(a.segment_id);
        if (dSeg !== aSeg) return false;
    }
    return true;
}

function matchesCommittedView(desired, data, row) {
    const actual = viewResource(data, row);
    // DTO 生成時にトリムされる項目も、照合では実際に保存された値を使う。
    actual.view.name = normalizeText(row.name);
    actual.view.memo = normalizeText(row.memo);
    if (actual.rack_settings) {
        const id = Number(row.id);
        actual.rack_settings.location = normalizeText(rackSettings(data).find(setting => Number(setting.view_id) === id)?.location);
        const names = new Map(rackShelves(data).filter(shelf => Number(shelf.view_id) === id)
            .map(shelf => [Number(shelf.id), normalizeText(shelf.name)]));
        for (const shelf of actual.rack_shelves) shelf.name = names.get(shelf.id);
    }
    return equal({
        ...desired,
        view: { ...desired.view, name: trimPhpText(desired.view.name), memo: trimPhpText(desired.view.memo) },
        ...(desired.rack_shelves ? {
            rack_shelves: desired.rack_shelves.map(shelf => ({ ...shelf, name: trimPhpText(shelf.name) }))
        } : {})
    }, actual);
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
                const desired = isView ? resourceFields(operation) : operation.device;
                const matched = row && (isView
                    ? matchesCommittedView(desired, data, row)
                    : matchesCommittedDevice(desired, row));
                committed &&= !!row && Number(row.resource_revision) > operation.expected_revision && matched;
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
        view_link_routes: viewRoutes(data).filter(row => views.has(Number(row.view_id))),
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

/**
 * @overload
 * @param {ResourceIdMap | null | undefined} map
 * @param {number | string} id
 * @returns {number}
 */
/**
 * @overload
 * @param {ResourceIdMap | null | undefined} map
 * @param {number | string | null | undefined} id
 * @returns {number | null | undefined}
 */
/**
 * null/undefined の選択状態は採番しない。対応表にない ID は数値化して保持する。
 * @param {ResourceIdMap | null | undefined} map
 * @param {number | string | null | undefined} id
 * @returns {number | null | undefined}
 */
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
    (data.links || []).forEach(row => {
        row.id = id('links', row.id);
        row.from_port_id = id('device_ports', row.from_port_id);
        row.to_port_id = id('device_ports', row.to_port_id);
        row.from_id = id('devices', row.from_id);
        row.to_id = id('devices', row.to_id);
    });
    (data.devicePorts || []).forEach(row => {
        row.id = id('device_ports', row.id);
        row.device_id = id('devices', row.device_id);
    });
    for (const row of viewRoutes(data)) {
        Object.assign(row, normalizeViewLinkRoute({ ...row, view_id: id('views', row.view_id),
            device_a_id: id('devices', row.device_a_id), device_b_id: id('devices', row.device_b_id) }));
    }
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

export function remapResourceUiState(maps) {
    appState.floorPlans.forEach(row => { row.view_id = mappedResourceId(maps.views, row.view_id); });
    appState.deviceImages.forEach(row => { row.device_id = mappedResourceId(maps.devices, row.device_id); });
    for (const key of ['editingDeviceId', 'ledgerSearchHighlightDeviceId', 'linkSourceId', 'linkTargetId']) {
        appState[key] = mappedResourceId(maps.devices, appState[key]);
    }
    appState.editingLinkId = mappedResourceId(maps.links, appState.editingLinkId);
    if (appState.editingLinkGroupKey != null) {
        const [viewId, first, second] = appState.editingLinkGroupKey.split(':').map(Number);
        // 負の表示端点はラックビュー ID。機器 ID の再採番とは別に扱う。
        const remapEndpoint = value => value < 0 ? -mappedResourceId(maps.views, -value) : mappedResourceId(maps.devices, value);
        appState.editingLinkGroupKey =
            `${mappedResourceId(maps.views, viewId)}:${pairKey(remapEndpoint(first), remapEndpoint(second))}`;
    }
    appState.selectedCanvasNoteId = mappedResourceId(maps.canvas_notes, appState.selectedCanvasNoteId);
    remapResourceSet(appState.selectedPlacementIds, maps.placements);
    remapResourceSet(appState.floorPlanAutoFittedViews, maps.views);
    appState.viewStates = new Map([...appState.viewStates].map(([id, value]) => [mappedResourceId(maps.views, id), value]));
    for (const kind of ['devices', 'views', 'links', 'device_ports']) {
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
        !['devices', 'views', 'placements', 'view_link_routes', 'canvas_notes', 'deleted_device_ids', 'deleted_view_ids', 'affected_view_ids']
            .every(kind => Array.isArray(result[kind])) ||
        ![...result.devices, ...result.views].every(row => Number.isInteger(Number(row.resource_revision)) && Number(row.resource_revision) > 0)) {
        throw new Error('保存応答が不完全です。保存状態を確認してください');
    }
    if (Array.isArray(result.buildings)) appState.buildings = result.buildings;
    if (Array.isArray(result.floors)) appState.floors = result.floors;
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
    const deferredRouteViews = new Set((pending?.deferredRouteViews || []).map(id => mappedResourceId(maps.views, id)));
    if (snapshot) remapResourceState(snapshot, maps);
    // 応答待ちの並べ替え・追加編集もサーバー採番した同じ子レコードを引き継ぐ。
    const addressIds = [];
    for (const identity of pending?.addressIdentities || []) {
        const deviceId = mappedResourceId(maps.devices, identity.device_id);
        const sent = snapshot?.devices.find(row => Number(row.id) === deviceId);
        const remote = result.devices.find(row => Number(row.id) === deviceId);
        if (!sent || !remote) continue;
        const canonical = remote.additional_ips || [];
        const ids = {};
        for (let index = 0; index < (sent.additional_ips || []).length; index++) {
            if (sent.additional_ips[index].id != null || !identity.keys[index]) continue;
            const savedAddress = canonical.find(row => Number(row.sort_order) === index);
            if (!savedAddress) continue;
            ids[identity.keys[index]] = Number(savedAddress.id);
            sent.additional_ips[index].id = Number(savedAddress.id);
        }
        const local = appState.devices.find(row => Number(row.id) === deviceId);
        for (const address of local?.additional_ips || []) {
            if (address.id == null && ids[address._client_key]) {
                address.id = ids[address._client_key];
                delete address._client_key;
            }
        }
        addressIds.push({ deviceId, localDeviceId: identity.device_id, ids });
    }
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
            if (deferredRouteViews.has(Number(row.id)) || !sent || !equal(viewResource(appState, row), viewResource(snapshot, sent)) ||
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
    eventBus.emit('device-addresses:identified', addressIds);

    const deletedDevices = new Set((result.deleted_device_ids || []).map(Number));
    const deletedViews = new Set((result.deleted_view_ids || []).map(Number));
    const deviceRows = byId((result.devices || []).map(normalizeDevice));
    const viewRows = byId((result.views || []).map(normalizeView));
    const merge = (rows, replacements, deleted, changed, removed, monitoring = false) => {
        const merged = rows.filter(row => !deleted.has(Number(row.id))).map(row => {
            const replacement = replacements.get(Number(row.id));
            replacements.delete(Number(row.id));
            if (replacement && changed.has(Number(row.id))) {
                const kept = { ...row, resource_revision: replacement.resource_revision };
                // 構成の追加入力は保持するが、同じ管理IPの監視結果はサーバーを正本とする。
                if (monitoring && row.ip === replacement.ip) {
                    kept.status = replacement.status;
                    kept.last_checked_at = replacement.last_checked_at;
                    kept.last_response_ms = replacement.last_response_ms;
                    kept.last_error = replacement.last_error;
                }
                return kept;
            }
            return replacement || row;
        });
        return [...merged, ...[...replacements.values()].filter(row => !removed.has(Number(row.id)))];
    };
    appState.devices = merge(appState.devices, deviceRows, deletedDevices, changedDevices, removedDevices, true);
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
    if (deletedDevices.size) {
        removeDevicesFromState([...deletedDevices]);
        discardSavedDeviceConnections(deletedDevices, result);
    }
    appState.viewLinkRoutes = [
        ...appState.viewLinkRoutes.filter(row => !replaceTopology.has(Number(row.view_id)) && !routeRefers(row, deletedDevices)),
        ...viewRoutes(result).filter(row => replaceTopology.has(Number(row.view_id)) &&
            currentViewIds.has(Number(row.view_id)) && currentDeviceIds.has(Number(row.device_a_id)) &&
            currentDeviceIds.has(Number(row.device_b_id))).map(normalizeViewLinkRoute)
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
    if (deletedDevices.size || deletedViews.size) {
        const retained = appState.legacyLinkConflicts.filter(row => !deletedViews.has(Number(row.view_id)) &&
            !routeRefers(row, deletedDevices));
        if (retained.length !== appState.legacyLinkConflicts.length) {
            appState.legacyLinkConflicts = retained;
            eventBus.emit('legacy-links:changed');
        }
    }
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

export function isSavedConnectionDevice(id) {
    return savedBaseline.devices.has(Number(id));
}

export function confirmedConnectionRouteCleanup(data, removedPairs) {
    const views = [];
    const removed_view_link_routes = [];
    if (!removedPairs.size) return { views, removed_view_link_routes };

    const remoteViews = byId(data.views);
    const remoteRoutes = new Set(data.view_link_routes.map(viewRouteKey));
    const planVersion = plan => plan && [Number(plan.revision), plan.created_at, plan.updated_at];
    for (const [id, before] of savedBaseline.views) {
        const removed = before.view_link_routes.filter(route =>
            removedPairs.has(pairKey(route.device_a_id, route.device_b_id)) && !remoteRoutes.has(viewRouteKey(route)));
        if (!removed.length) continue;
        removed_view_link_routes.push(...removed);

        const remote = remoteViews.get(id);
        const revision = Number(remote?.resource_revision);
        if (!Number.isSafeInteger(revision) || revision <= before.revision) continue;
        const removedKeys = new Set(removed.map(viewRouteKey));
        const expected = { ...resourceFields(before),
            view_link_routes: before.view_link_routes.filter(route => !removedKeys.has(viewRouteKey(route))) };
        // 図面もビュー世代を進める。未保存の座標ではなく図面の版を照合する。
        const localPlan = appState.floorPlans.find(row => Number(row.view_id) === id);
        const remotePlan = data.floor_plans.find(row => Number(row.view_id) === id);
        if (equal(planVersion(localPlan), planVersion(remotePlan)) && equal(expected, viewResource(data, remote))) {
            views.push({ id, previous_resource_revision: before.revision, resource_revision: revision });
        }
    }
    return { views, removed_view_link_routes };
}

export function applyRemovedConnectionRoutes(routes, viewRevisions, keepPairs = new Set()) {
    const keys = new Set(routes.map(viewRouteKey));
    appState.viewLinkRoutes = appState.viewLinkRoutes.filter(row =>
        !keys.has(viewRouteKey(row)) || keepPairs.has(pairKey(row.device_a_id, row.device_b_id)));
    for (const id of new Set(routes.map(row => Number(row.view_id)))) {
        const baseline = savedBaseline.views.get(id);
        if (!baseline) continue;
        baseline.view_link_routes = baseline.view_link_routes.filter(route => !keys.has(viewRouteKey(route)));
        const row = viewRevisions.find(row => Number(row.id) === id);
        if (row && baseline.revision === Number(row.previous_resource_revision) && !appState.resourceConflicts.views.has(id)) {
            syncResourceRevision('views', id, row.resource_revision);
        }
    }
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

function reconcileFloorRackReload(id, remote, incomingFloorPlans) {
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
        const localPlan = appState.floorPlans.find(plan => Number(plan.view_id) === viewId);
        const incomingPlan = incomingFloorPlans.find(plan => Number(plan.view_id) === viewId);
        // 関連ビューの図面はこの再読込では差し替えないため、表示中の図面に別の版を与えない。
        const samePlan = localPlan && incomingPlan
            ? equal(normalizeFloorPlan(localPlan), normalizeFloorPlan(incomingPlan))
            : !localPlan && !incomingPlan;
        const safe = before && incoming && samePlan && equal(withoutRelated(before), withoutRelated(incoming));
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
    if (Array.isArray(data.buildings)) appState.buildings = data.buildings;
    if (Array.isArray(data.floors)) appState.floors = data.floors;
    const remote = createResourceBaseline(data);
    const row = (data[kind] || []).find(row => Number(row.id) === id);
    if (kind === 'views') reconcileFloorRackReload(id, remote, data.floor_plans || []);
    const normalize = kind === 'devices' ? normalizeDevice : normalizeView;
    const existed = appState[kind].some(row => Number(row.id) === id);
    const refers = item => [item.device_id, item.device_a_id, item.device_b_id].some(value => Number(value) === id);
    const incoming = (data.placements || []).filter(item => kind === 'views' ? Number(item.view_id) === id : refers(item));
    const incomingRoutes = viewRoutes(data).filter(item => Number(item.view_id) === id);
    const referenced = new Set([...incoming.map(item => Number(item.device_id)),
        ...incomingRoutes.flatMap(item => [Number(item.device_a_id), Number(item.device_b_id)])]);
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
                    : incoming.map(item => Number(item.id)));
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
        appState.viewLinkRoutes = appState.viewLinkRoutes.filter(row => Number(row.view_id) !== id);
        appState.canvasNotes = appState.canvasNotes.filter(note => Number(note.view_id) !== id);
        const placements = (data.placements || []).filter(row => Number(row.view_id) === id);
        const referenced = new Set([
            ...placements.map(row => Number(row.device_id)),
            ...incomingRoutes.flatMap(row => [Number(row.device_a_id), Number(row.device_b_id)]),
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
        appState.viewLinkRoutes.push(...incomingRoutes.map(normalizeViewLinkRoute));
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
            Object.assign(maps, reloadDeviceConnections(id, data));
            // 機器の削除/復元による依存行だけ反映し、同じビューのその他の編集を残す。
            const unrelatedChanges = new Set();
            for (const [viewId, baseline] of savedBaseline.views) {
                const remoteView = remote.views.get(viewId);
                const related = [baseline, remoteView].some(resource =>
                    resource && (resource.placements.some(refers) || resource.view_link_routes.some(refers)));
                const rackRelated = [baseline, remoteView].some(resource => rackDevices(resource).some(refers));
                if (!related && !rackRelated) continue;
                if (!remoteView || !equal(baseline.view, remoteView.view) ||
                    !equal(baseline.canvas_notes, remoteView.canvas_notes) ||
                    !equal(baseline.rack_settings, remoteView.rack_settings) ||
                    !equal(baseline.floor_rack_placements, remoteView.floor_rack_placements) ||
                    !equal(baseline.rack_shelves, remoteView.rack_shelves) ||
                    !equal((baseline.rack_shelf_devices || []).filter(item => !refers(item)), (remoteView.rack_shelf_devices || []).filter(item => !refers(item))) ||
                    !equal((baseline.rack_mounts || []).filter(item => !refers(item)), (remoteView.rack_mounts || []).filter(item => !refers(item))) ||
                    ['placements', 'view_link_routes'].some(topologyKind =>
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
            for (const [topologyKind, stateProp, rows, normalizeTopology] of [
                ['placements', 'placements', data.placements || [], normalizePlacement],
                ['view_link_routes', 'viewLinkRoutes', viewRoutes(data), normalizeViewLinkRoute]
            ]) {
                const affected = new Set();
                for (const item of appState[stateProp]) if (refers(item)) affected.add(Number(item.view_id));
                appState[stateProp] = appState[stateProp].filter(item => !refers(item));
                for (const item of rows) {
                    if (refers(item) && appState.views.some(view => Number(view.id) === Number(item.view_id)) &&
                        (topologyKind === 'placements' || (currentDeviceIds.has(Number(item.device_a_id)) &&
                            currentDeviceIds.has(Number(item.device_b_id))))) {
                        affected.add(Number(item.view_id));
                        appState[stateProp].push(normalizeTopology(item));
                    }
                }
                for (const [viewId, baseline] of savedBaseline.views) {
                    if (baseline[topologyKind].some(refers)) affected.add(viewId);
                    const remoteView = remote.views.get(viewId);
                    baseline[topologyKind] = orderTopology(topologyKind, [
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
