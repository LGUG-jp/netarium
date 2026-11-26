import { appState, recalculateNextIds } from './state.js';
import { isValidPortVlan, normalizeDevicePort, normalizeLink, normalizePortName, pairKey, viewRouteKey, toSaveLink } from './connection-data.js';
import { applyRemovedConnectionRoutes, confirmedConnectionRouteCleanup, isSavedConnectionDevice,
    mappedResourceId, remapResourceState, remapResourceUiState } from './resource-save.js';
import { trimPhpText } from './utils.js';

export const connectionKinds = ['device_ports', 'links'];
const stateKey = kind => kind === 'links' ? 'links' : 'devicePorts';
const normalize = kind => kind === 'links' ? normalizeLink : normalizeDevicePort;
const fields = (kind, row) => kind === 'links' ? toSaveLink(row) :
    { device_id: Number(row.device_id), name: String(row.name ?? ''), vlan: String(row.vlan ?? ''), memo: String(row.memo ?? '') };
const deviceIds = (kind, row) => kind === 'links' ? [Number(row.from_id), Number(row.to_id)] : [Number(row.device_id)];
const byId = rows => new Map(rows.map(row => [Number(row.id), row]));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const hasOperations = payload => connectionKinds.some(kind => payload[kind].length);
let baseline = { device_ports: new Map(), links: new Map() };

export function resetConnectionBaseline(data) {
    baseline = Object.fromEntries(connectionKinds.map(kind => [kind,
        byId((data[stateKey(kind)] || data[kind] || []).map(normalize(kind)))]));
}

function heldPairs() {
    return new Set(appState.legacyLinkConflicts.map(row => pairKey(row.device_a_id, row.device_b_id)));
}

export function savedConnectionPairs() {
    const pairs = heldPairs();
    for (const link of baseline.links.values()) pairs.add(pairKey(link.from_id, link.to_id));
    return pairs;
}

export function buildConnectionSave({ saveable = false } = {}) {
    const payload = { device_ports: [], links: [] };
    // A connection batch can release and reassign ports. Don't split it on a stale revision.
    if (saveable && connectionKinds.some(kind => appState.resourceConflicts[kind]?.size)) return payload;
    const devices = new Set(appState.devices.map(row => Number(row.id)));
    const currentPorts = byId(appState.devicePorts);
    const available = id => devices.has(id) && (!saveable || isSavedConnectionDevice(id));
    for (const kind of connectionKinds) {
        const current = byId(appState[stateKey(kind)]);
        for (const [id, row] of current) {
            if (!deviceIds(kind, row).every(available)) continue;
            const before = baseline[kind].get(id);
            const body = fields(kind, row);
            if (before && equal(fields(kind, before), body)) continue;
            if (kind === 'links') {
                // New ledger rows are written first, then resolved in the same batch by name.
                for (const side of ['from', 'to']) {
                    const idKey = `${side}_port_id`;
                    const localPort = currentPorts.get(body[idKey]);
                    if (localPort && !baseline.device_ports.has(Number(localPort.id))) {
                        body[`${side}_port_name`] = localPort.name;
                        delete body[idKey];
                    }
                }
            }
            payload[kind].push({ operation: before ? 'update' : 'create', id,
                ...(before ? { expected_revision: before.resource_revision } : {}),
                [kind === 'links' ? 'link' : 'port']: body });
        }
        for (const [id, before] of baseline[kind]) {
            if (!current.has(id) && deviceIds(kind, before).every(deviceId => devices.has(deviceId))) {
                payload[kind].push({ operation: 'delete', id, expected_revision: before.resource_revision });
            }
        }
    }
    return payload;
}

export function hasConnectionChanges(options) {
    return hasOperations(buildConnectionSave(options));
}

export function createPendingConnectionSave(payload, { isolated = false } = {}) {
    return { connection: true, isolated, payload, sent: Object.fromEntries(connectionKinds.map(kind => {
        const ids = new Set(payload[kind].filter(op => isolated ? op.operation === 'update' : op.operation !== 'delete')
            .map(op => Number(op.id)));
        return [kind, byId(appState[stateKey(kind)].filter(row => ids.has(Number(row.id))).map(row => ({ ...row })))];
    })) };
}

function remapIncomingRows(result, pending) {
    // An isolated batch's temporary IDs never lived in shared state.
    const maps = Object.fromEntries(connectionKinds.map(kind => [kind, pending?.isolated ? {} : { ...result.id_maps[kind] }]));
    const stagedPayload = pending?.isolated ? null : pending?.payload;
    let needsRemap = !pending?.isolated;
    for (const kind of connectionKinds) {
        const incoming = new Set(result[kind].map(row => Number(row.id)));
        const creates = new Set((stagedPayload?.[kind] || []).filter(op => op.operation === 'create').map(op => Number(op.id)));
        let next = appState[stateKey(kind)].reduce((max, row) => Math.max(max, Number(row.id)), 0);
        for (const target of incoming) next = Math.max(next, target);
        for (const row of appState[stateKey(kind)]) {
            const id = Number(row.id);
            if (incoming.has(id) && !baseline[kind].has(id) && !creates.has(id)) {
                maps[kind][id] = ++next;
                needsRemap = true;
            }
        }
    }
    if (needsRemap) {
        remapResourceState(appState, maps);
        remapResourceUiState(maps);
    }
    return maps;
}

function mergeLinkDraft(local, sent, remote) {
    const result = { ...remote };
    for (const key of ['system_id', 'label', 'memo']) {
        if (local[key] !== sent[key]) result[key] = local[key];
    }
    for (const side of ['from', 'to']) {
        const keys = [`${side}_id`, `${side}_port_id`, `${side}_port_name`];
        if (keys.some(key => local[key] !== sent[key])) {
            for (const key of keys) if (Object.hasOwn(local, key)) result[key] = local[key];
        }
    }
    return result;
}

export function applyConnectionSaveResult(data, pending) {
    if (!Number.isInteger(Number(data?.revision)) || !data?.id_maps ||
        ![...connectionKinds, 'deleted_link_ids', 'deleted_device_port_ids', 'removed_view_link_routes', 'views']
            .every(kind => Array.isArray(data[kind])) ||
        !connectionKinds.every(kind => data[kind].every(row => Number(row.resource_revision) > 0))) {
        throw new Error('接続の保存応答が不完全です。保存状態を確認してください');
    }
    const completedVlanId = pending.payload.complete_legacy_vlan;
    if (completedVlanId != null && Number(data.completed_legacy_vlan_link_id) !== Number(completedVlanId)) {
        throw new Error('未移行VLANの再設定を確認できません。保存状態を確認してください');
    }
    const normalized = Object.fromEntries(connectionKinds.map(kind => [kind, data[kind].map(normalize(kind))]));
    const deleted = { links: new Set(data.deleted_link_ids.map(Number)), device_ports: new Set(data.deleted_device_port_ids.map(Number)) };
    const operationsByKind = {};
    for (const kind of connectionKinds) {
        const returned = new Set(normalized[kind].map(row => row.id));
        const operations = operationsByKind[kind] = new Map();
        for (const op of pending.payload[kind]) {
            const id = op.operation === 'create' ? Number(data.id_maps[kind]?.[op.id]) : Number(op.id);
            if (op.operation === 'delete' ? !deleted[kind].has(id) : !returned.has(id)) {
                throw new Error('接続の保存結果を確認できません。保存状態を確認してください');
            }
            operations.set(id, op);
        }
    }
    const oldPairs = new Set();
    for (const op of pending.payload.links) {
        const row = op.operation !== 'create' && baseline.links.get(Number(op.id));
        if (row) oldPairs.add(pairKey(row.from_id, row.to_id));
    }
    const maps = remapIncomingRows(data, pending);
    for (const kind of connectionKinds) {
        const operations = operationsByKind[kind];
        const local = byId(appState[stateKey(kind)]);
        const rows = new Map(local);
        for (const id of deleted[kind]) {
            baseline[kind].delete(id);
            if (pending.isolated) rows.delete(id);
        }
        for (const remote of normalized[kind]) {
            const id = remote.id;
            const before = baseline[kind].get(id);
            const operation = operations.get(id);
            const row = local.get(id);
            if (!operation && before && (!row || !equal(fields(kind, row), fields(kind, before)))) {
                // A returned port may only have been referenced, not written. It must not rebase a pending port edit.
                continue;
            }
            baseline[kind].set(id, remote);
            const sent = operation && pending.sent[kind].get(Number(operation.id));
            if (operation && !row && (!pending.isolated || sent)) continue; // Deleted locally while in flight.
            if (!sent) {
                rows.set(id, { ...remote });
                continue;
            }
            if (kind === 'links') {
                sent.from_port_id = mappedResourceId(maps.device_ports, sent.from_port_id);
                sent.to_port_id = mappedResourceId(maps.device_ports, sent.to_port_id);
                rows.set(id, mergeLinkDraft(row, sent, remote));
            } else {
                const next = { ...remote };
                for (const key of Object.keys(fields(kind, row))) if (row[key] !== sent[key]) next[key] = row[key];
                rows.set(id, next);
            }
        }
        appState[stateKey(kind)] = [...rows.values()];
    }
    discardLegacyVlans(deleted.links);
    if (completedVlanId != null) discardLegacyVlans(new Set([Number(completedVlanId)]));
    if (pending.isolated && deleted.links.has(Number(appState.editingLinkId))) appState.editingLinkId = null;
    const localPairs = new Set(appState.links.map(row => pairKey(row.from_id, row.to_id)));
    applyRemovedConnectionRoutes(data.removed_view_link_routes, data.views, localPairs);
    const remainingPairs = savedConnectionPairs();
    appState.viewLinkRoutes = appState.viewLinkRoutes.filter(row => {
        const key = pairKey(row.device_a_id, row.device_b_id);
        return !oldPairs.has(key) || remainingPairs.has(key) || localPairs.has(key);
    });
    recalculateNextIds();
    return maps;
}

function inspectPendingVlanCopy(pending, data) {
    const copy = pending.vlanCopy;
    const linkId = Number(copy.link_id);
    const sourceId = Number(copy.source_port_id);
    const destinationId = Number(copy.destination_port_id);
    const link = (data.links || []).find(row => Number(row.id) === linkId);
    const ports = data.device_ports || [];
    const source = ports.find(row => Number(row.id) === sourceId);
    const destination = ports.find(row => Number(row.id) === destinationId);
    const from = Number(link?.from_port_id);
    const to = Number(link?.to_port_id);
    const desiredVlan = pending.payload.device_ports.find(op => Number(op.id) === destinationId)?.port?.vlan;
    const destinationRevision = Number(destination?.resource_revision);
    const expectedRevision = Number(copy.destination_expected_revision);
    const conflicts = [];
    if (!((from === sourceId && to === destinationId) || (from === destinationId && to === sourceId))) {
        conflicts.push({ resource: 'links', id: linkId, name: link?.label });
    }
    if (Number(source?.resource_revision) !== Number(copy.source_expected_revision) || source?.vlan !== desiredVlan) {
        conflicts.push({ resource: 'device_ports', id: sourceId, name: source?.name });
    }
    if (!conflicts.length) {
        if (destinationRevision === expectedRevision) return { outcome: 'retry' };
        if (destinationRevision > expectedRevision && destination.vlan === desiredVlan) {
            // The intended value is present, but the load cannot tell which request wrote it.
            return { outcome: 'matched' };
        }
    }
    if (destinationRevision !== expectedRevision) {
        conflicts.push({ resource: 'device_ports', id: destinationId, name: destination?.name });
    }
    return { outcome: 'conflict', conflicts };
}

export function inspectPendingConnectionSave(pending, data) {
    if (pending.vlanCopy) return inspectPendingVlanCopy(pending, data);
    if (connectionKinds.some(kind => pending.payload[kind].some(op => op.operation === 'create'))) return { outcome: 'unknown' };
    const completedVlanId = pending.payload.complete_legacy_vlan;
    if (completedVlanId != null && !Array.isArray(data.legacy_link_vlans)) return { outcome: 'unknown' };
    const vlanPending = completedVlanId != null &&
        data.legacy_link_vlans.some(row => Number(row.link_id) === Number(completedVlanId));
    let unchanged = true;
    let committed = true;
    const ports = byId((data.device_ports || []).map(normalizeDevicePort));
    for (const kind of connectionKinds) {
        const rows = byId((data[kind] || []).map(normalize(kind)));
        for (const op of pending.payload[kind]) {
            const row = rows.get(Number(op.id));
            const expectedRevision = Number(op.expected_revision);
            unchanged &&= !!row && row.resource_revision === expectedRevision;
            if (op.operation === 'delete') {
                committed &&= !row;
            } else {
                const desired = { ...(op.link || op.port) };
                if (kind === 'device_ports') {
                    if (Object.hasOwn(desired, 'name')) desired.name = normalizePortName(desired.name);
                    if (Object.hasOwn(desired, 'memo')) desired.memo = trimPhpText(desired.memo);
                    if (Object.hasOwn(desired, 'vlan')) {
                        const vlan = desired.vlan;
                        // Like the server, check the raw input before trimming only ASCII spaces.
                        if (!isValidPortVlan(vlan)) {
                            committed = false;
                        } else {
                            desired.vlan = vlan.replace(/^ +| +$/g, '');
                        }
                    }
                }
                if (op.link) {
                    if (Object.hasOwn(desired, 'label')) desired.label = trimPhpText(desired.label);
                    if (Object.hasOwn(desired, 'memo')) desired.memo = trimPhpText(desired.memo);
                }
                if (op.link && row) {
                    for (const side of ['from', 'to']) {
                        const nameKey = `${side}_port_name`;
                        if (!Object.hasOwn(desired, nameKey)) continue;
                        const port = ports.get(row[`${side}_port_id`]);
                        if (normalizePortName(desired[nameKey]) !== (port?.name ?? '')) committed = false;
                        delete desired[nameKey];
                        desired[`${side}_port_id`] = row[`${side}_port_id`];
                    }
                }
                const actual = row && fields(kind, row);
                const keys = Object.keys(desired);
                // VLAN 単独保存には接続の版を検証するだけの更新が含まれる。版が進んでいたら同じ端点とはみなさない。
                const guardedLink = kind === 'links' && keys.length === 0 && completedVlanId == null;
                const migrationLink = kind === 'links' && Number(op.id) === completedVlanId;
                committed &&= !!row && ((guardedLink || migrationLink) && row.resource_revision === expectedRevision ||
                    !guardedLink && row.resource_revision > expectedRevision) && keys.every(key => desired[key] === actual[key]);
            }
        }
    }
    if (completedVlanId != null) {
        unchanged &&= vlanPending;
        committed &&= !vlanPending;
    }
    return { outcome: unchanged ? 'retry' : committed ? 'saved' : 'conflict' };
}

export function confirmedConnectionResult(pending, data) {
    const result = { ...data, id_maps: {} };
    if (pending.payload.complete_legacy_vlan != null) result.completed_legacy_vlan_link_id = pending.payload.complete_legacy_vlan;
    const references = new Set();
    for (const kind of ['links', 'device_ports']) {
        const deletedKey = kind === 'links' ? 'deleted_link_ids' : 'deleted_device_port_ids';
        const operations = pending.payload[kind];
        const affected = new Set(operations.map(op => Number(op.id)));
        result[kind] = data[kind].filter(row => affected.has(Number(row.id)) || (kind === 'device_ports' && references.has(Number(row.id))));
        result[deletedKey] = operations.filter(op => op.operation === 'delete').map(op => op.id);
        if (kind === 'links') for (const link of result.links) {
            references.add(Number(link.from_port_id));
            references.add(Number(link.to_port_id));
        }
    }
    const remaining = new Set(data.links.map(link => pairKey(link.from_id, link.to_id)));
    for (const row of data.legacy_link_conflicts || []) remaining.add(pairKey(row.device_a_id, row.device_b_id));
    const removedPairs = new Set(pending.payload.links.map(op => baseline.links.get(Number(op.id))).filter(Boolean)
        .map(link => pairKey(link.from_id, link.to_id)).filter(pair => !remaining.has(pair)));
    return Object.assign(result, confirmedConnectionRouteCleanup(data, removedPairs));
}

function discardLegacyVlans(deletedLinks) {
    if (deletedLinks.size && appState.legacyLinkVlans.length) {
        appState.legacyLinkVlans = appState.legacyLinkVlans.filter(row => !deletedLinks.has(Number(row.link_id)));
    }
}

export function discardSavedDeviceConnections(deletedDevices, result) {
    for (const kind of connectionKinds) {
        const removed = new Set((result[kind === 'links' ? 'deleted_link_ids' : 'deleted_device_port_ids'] || []).map(Number));
        for (const [id, row] of baseline[kind]) {
            if (removed.has(id) || deviceIds(kind, row).some(device => deletedDevices.has(device))) {
                baseline[kind].delete(id);
                appState.resourceConflicts[kind]?.delete(id);
                removed.add(id);
            }
        }
        if (kind === 'links') discardLegacyVlans(removed);
    }
}

function reloadConnections(data, select) {
    const remote = Object.fromEntries(connectionKinds.map(kind => [kind, (data[kind] || []).map(normalize(kind))]));
    const targetLinks = new Set();
    for (const [id, row] of baseline.links) {
        if (select('links', row)) targetLinks.add(id);
    }
    const incoming = Object.fromEntries(connectionKinds.map(kind => [kind, remote[kind].filter(row => select(kind, row))]));
    for (const row of incoming.links) targetLinks.add(row.id);
    discardLegacyVlans(targetLinks);
    if (Array.isArray(data.legacy_link_vlans)) {
        appState.legacyLinkVlans.push(...data.legacy_link_vlans.filter(row => targetLinks.has(Number(row.link_id))));
    }
    const needed = new Set(incoming.links.flatMap(link => [link.from_port_id, link.to_port_id]));
    incoming.device_ports.push(...remote.device_ports.filter(row => needed.has(row.id) &&
        !baseline.device_ports.has(row.id) && !select('device_ports', row)));
    const maps = remapIncomingRows({ ...incoming, id_maps: {} });
    for (const kind of connectionKinds) {
        for (const [id, row] of baseline[kind]) if (select(kind, row)) {
            baseline[kind].delete(id);
            appState.resourceConflicts[kind]?.delete(id);
        }
        const ids = new Set(incoming[kind].map(row => row.id));
        appState[stateKey(kind)] = appState[stateKey(kind)].filter(row => !select(kind, row) && !ids.has(Number(row.id)));
        for (const row of incoming[kind]) {
            baseline[kind].set(row.id, row);
            appState[stateKey(kind)].push({ ...row });
        }
    }
    if (!appState.links.some(row => Number(row.id) === Number(appState.editingLinkId))) appState.editingLinkId = null;
    recalculateNextIds();
    return maps;
}

export function reloadDeviceConnections(id, data) {
    const current = new Set(appState.devices.map(row => Number(row.id)));
    return reloadConnections({ ...data, links: (data.links || []).filter(row => deviceIds('links', row).every(id => current.has(id))) },
        (kind, row) => deviceIds(kind, row).includes(id));
}

export function reloadConnectionFromData(kind, id, data) {
    // A port deleted elsewhere may have been disconnected first. Refresh just the links
    // that still reference the deleted port locally, as well as the port itself.
    const linkIds = new Set();
    if (kind === 'links') linkIds.add(id);
    if (kind === 'device_ports' && !(data.device_ports || []).some(port => Number(port.id) === id)) {
        for (const link of appState.links) {
            if (link.from_port_id === id || link.to_port_id === id) linkIds.add(link.id);
        }
    }
    const oldPairs = new Set();
    for (const linkId of linkIds) {
        const link = baseline.links.get(linkId);
        if (link) oldPairs.add(pairKey(link.from_id, link.to_id));
    }
    const maps = reloadConnections(data, (key, row) =>
        (key === kind && Number(row.id) === id) || (key === 'links' && linkIds.has(row.id)));
    if (oldPairs.size) {
        const remaining = new Set((data.links || []).map(link => pairKey(link.from_id, link.to_id)));
        for (const row of data.legacy_link_conflicts || []) remaining.add(pairKey(row.device_a_id, row.device_b_id));
        const remoteRoutes = new Set((data.view_link_routes || []).map(viewRouteKey));
        const localPairs = new Set(appState.links.map(row => pairKey(row.from_id, row.to_id)));
        applyRemovedConnectionRoutes(appState.viewLinkRoutes.filter(row => {
            const pair = pairKey(row.device_a_id, row.device_b_id);
            return oldPairs.has(pair) && !remaining.has(pair) && !remoteRoutes.has(viewRouteKey(row));
        }), [], localPairs);
    }
    return maps;
}
