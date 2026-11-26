import { normalizeLinkRouteData } from './link-route-data.js';
import { normalizeText } from './utils.js';
import { DEFAULT_DEVICE_HEIGHT, DEFAULT_DEVICE_WIDTH } from './constants.js';
import { getRackDeviceMounts } from './device-placement.js';
import { floorRackPlacements } from './floor-rack-data.js';

// LegacyLinkMigration::normalizePortName と同じ幅・空白の補正。大小文字や略称は変えない。
export function normalizePortName(name) {
    return String(name ?? '').replace(/[！-～]/g, char => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
        .replace(/[\p{Z}\u0009-\u000d\u0085]+/gu, ' ').replace(/^ +| +$/g, '');
}

// ConnectionSaveService::isValidPortVlan と同様に空白を除く前の入力を検証する。
export function isValidPortVlan(value) {
    return typeof value === 'string' && /^[^\p{Cc}\p{Cs}\p{Zl}\p{Zp}]{0,200}$/u.test(value);
}

function nullableId(value) {
    if (value == null) return null;
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id <= 0 ||
        (typeof value !== 'number' && (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)))) {
        throw new Error('接続系統とポートのIDは未設定または正の整数で指定してください');
    }
    return id;
}

export function normalizeLink(link) {
    return {
        id: Number(link.id),
        resource_revision: Number(link.resource_revision) || 0,
        from_id: Number(link.from_id),
        to_id: Number(link.to_id),
        from_port_id: nullableId(link.from_port_id),
        to_port_id: nullableId(link.to_port_id),
        system_id: nullableId(link.system_id),
        label: normalizeText(link.label),
        memo: normalizeText(link.memo)
    };
}

// A name is an explicit pending assignment, not a cached name for a port ID.
export function toSaveLink(link) {
    const { id, resource_revision, from_port_id, to_port_id, ...fields } = normalizeLink(link);
    return {
        ...fields,
        ...(link.from_port_name == null ? { from_port_id } : { from_port_name: link.from_port_name }),
        ...(link.to_port_name == null ? { to_port_id } : { to_port_name: link.to_port_name })
    };
}

export function normalizeDevicePort(port) {
    return {
        id: Number(port.id),
        resource_revision: Number(port.resource_revision) || 0,
        device_id: Number(port.device_id),
        name: normalizeText(port.name),
        vlan: normalizeText(port.vlan),
        memo: normalizeText(port.memo)
    };
}

export const pairKey = (a, b) => `${Math.min(a, b)}:${Math.max(a, b)}`;
export const viewRouteKey = route => `${Number(route.view_id)}:${pairKey(route.device_a_id, route.device_b_id)}`;
export const compareViewRoutes = (a, b) => a.device_a_id - b.device_a_id || a.device_b_id - b.device_b_id;

export function normalizeViewLinkRoute(route) {
    const { manual_route } = normalizeLinkRouteData({ route_mode: 'manual', manual_route: route.manual_route });
    const a = Number(route.device_a_id);
    const b = Number(route.device_b_id);
    return {
        view_id: Number(route.view_id),
        device_a_id: Math.min(a, b),
        device_b_id: Math.max(a, b),
        manual_route: a > b ? manual_route.reverse() : manual_route
    };
}

export function setViewLinkRoute(state, link, points) {
    const target = { view_id: link.view_id, device_a_id: link.from_id, device_b_id: link.to_id };
    const key = viewRouteKey(target);
    const route = points == null ? null : normalizeViewLinkRoute({ ...target, manual_route: points });
    state.viewLinkRoutes = state.viewLinkRoutes.filter(row => viewRouteKey(row) !== key);
    if (route) state.viewLinkRoutes.push(route);
}

export function connectionsFromData(data) {
    return {
        links: (data.links || []).map(normalizeLink),
        devicePorts: (data.device_ports || []).map(normalizeDevicePort),
        viewLinkRoutes: (data.view_link_routes || []).map(normalizeViewLinkRoute),
        legacyLinkConflicts: data.legacy_link_conflicts || [],
        legacyLinkVlans: data.legacy_link_vlans || []
    };
}

function hasXY(row) {
    return row.x != null && row.y != null && String(row.x).trim() !== '' && String(row.y).trim() !== '' &&
        Number.isFinite(Number(row.x)) && Number.isFinite(Number(row.y));
}

function currentFloorRackEndpoints(view, data) {
    const racks = new Map();
    if (view?.view_type !== 'floor') return racks;
    const placements = floorRackPlacements(data);
    if (!placements.length) return racks;
    const rackIds = new Set((data.views || []).filter(row => row.view_type === 'rack').map(row => Number(row.id)));
    // ラックの配置先は全ビューで 1 か所。現在ビュー外の重複でも端点を確定しない。
    const seen = new Set();
    for (const placement of placements) {
        const id = Number(placement.rack_view_id);
        if (!rackIds.has(id)) continue;
        if (racks.has(id)) racks.set(id, null);
        else if (Number(placement.floor_view_id) === Number(view.id)) {
            racks.set(id, !seen.has(id) && hasXY(placement) ? placement : null);
        }
        seen.add(id);
    }
    return racks;
}

/** ルーター内だけでラックビュー ID の符号を反転し、同じ番号の機器 ID と区別する。 */
export function getViewLinkRoutingPlacements(view, data, currentPlacements) {
    const racks = currentFloorRackEndpoints(view, data);
    if (!racks.size) return currentPlacements;
    const placements = [...currentPlacements];
    for (const [rackId, row] of racks) {
        if (row) placements.push({ device_id: -rackId, x: row.x, y: row.y,
            width: DEFAULT_DEVICE_WIDTH, height: DEFAULT_DEVICE_HEIGHT });
    }
    return placements;
}

function floorLinkEndpoints(view, data) {
    const endpoints = new Map();
    const devices = new Set((data.devices || []).map(row => Number(row.id)));
    const add = (id, endpoint) => {
        if (devices.has(id)) endpoints.set(id, endpoints.has(id) ? null : endpoint);
    };
    // 通常ビューへの複数配置は許容されるため、直接配置は現在ビュー内だけで競合を判定する。
    for (const placement of data.placements) {
        if (Number(placement.view_id) !== Number(view.id)) continue;
        const id = Number(placement.device_id);
        add(id, hasXY(placement) ? id : null);
    }
    const racks = currentFloorRackEndpoints(view, data);
    if (racks.size) {
        const mounts = getRackDeviceMounts(data);
        const seen = new Set();
        const duplicates = new Set();
        for (const mount of mounts) {
            const id = Number(mount.device_id);
            if (seen.has(id)) duplicates.add(id);
            seen.add(id);
        }
        for (const mount of mounts) {
            const rackId = Number(mount.view_id);
            const id = Number(mount.device_id);
            if (racks.has(rackId)) add(id, racks.get(rackId) && !duplicates.has(id) ? -rackId : null);
        }
    }
    return endpoints;
}

function viewLinkProjection(view, data) {
    if (!view || view.view_type === 'rack' || Number(view.show_connections ?? 1) === 0) return null;
    const viewId = Number(view.id);
    const endpoints = view.view_type === 'floor' ? floorLinkEndpoints(view, data) :
        new Map(data.placements.filter(row => Number(row.view_id) === viewId)
            .map(row => [Number(row.device_id), Number(row.device_id)]));
    const routes = new Map((data.viewLinkRoutes || []).filter(row => Number(row.view_id) === viewId)
        .map(row => [pairKey(row.device_a_id, row.device_b_id), row.manual_route]));
    return { viewId, endpoints, routes };
}

export function linkPortNames(link, ports) {
    return {
        from_port: link.from_port_name ?? ports.get(Number(link.from_port_id)) ?? '',
        to_port: link.to_port_name ?? ports.get(Number(link.to_port_id)) ?? ''
    };
}

export function resolveViewLinks(view, data) {
    const projection = viewLinkProjection(view, data);
    if (!projection) return [];
    const { viewId, endpoints, routes } = projection;
    const ports = new Map((data.devicePorts || []).map(row => [Number(row.id), row.name]));
    const links = [];
    for (const link of data.links) {
        const from = endpoints.get(Number(link.from_id));
        const to = endpoints.get(Number(link.to_id));
        if (from == null || to == null || (from === to && from < 0)) continue;
        const points = from < 0 || to < 0 ? undefined : routes.get(pairKey(from, to));
        links.push({
            ...link,
            view_id: viewId,
            ...linkPortNames(link, ports),
            route_mode: points ? 'manual' : 'auto',
            manual_route: points ? (from > to ? points.slice().reverse() : points) : []
        });
    }
    return links;
}

/** 描画専用。明細の編集には向きを維持した個別接続を使う。 */
export function resolveViewLinkGroups(view, data) {
    const projection = viewLinkProjection(view, data);
    if (!projection) return [];
    const { viewId, endpoints, routes } = projection;
    const groups = new Map();
    for (const link of data.links) {
        const from = endpoints.get(Number(link.from_id));
        const to = endpoints.get(Number(link.to_id));
        if (from == null || to == null || (from === to && from < 0)) continue;
        const key = pairKey(from, to);
        const group = groups.get(key);
        if (group) group.members.push(link);
        else groups.set(key, { from, to, members: [link] });
    }
    const ports = new Map((data.devicePorts || []).map(row => [Number(row.id), row.name]));
    return [...groups].map(([key, { from, to, members }]) => {
        const first = members[0];
        const rackProjected = from < 0 || to < 0;
        const systemIds = [...new Set(members.map(link => link.system_id == null ? null : Number(link.system_id)))];
        const points = rackProjected ? undefined : routes.get(key);
        const single = members.length === 1;
        const result = {
            display_key: `${viewId}:${key}`,
            link_ids: members.map(link => Number(link.id)).sort((a, b) => a - b),
            view_id: viewId,
            from_id: Math.min(from, to),
            to_id: Math.max(from, to),
            system_id: systemIds.length === 1 ? systemIds[0] : null,
            system_ids: systemIds,
            route_mode: points ? 'manual' : 'auto',
            manual_route: points ?? []
        };
        if (rackProjected) {
            return single ? { ...result, rack_projected: true, id: Number(first.id), label: first.label } :
                { ...result, rack_projected: true };
        }
        if (!single) return result;
        const { from_port, to_port } = linkPortNames(first, ports);
        const forward = from <= to;
        return {
            ...result,
            id: Number(first.id),
            from_port: forward ? from_port : to_port,
            to_port: forward ? to_port : from_port,
            from_port_id: forward ? first.from_port_id : first.to_port_id,
            to_port_id: forward ? first.to_port_id : first.from_port_id,
            label: first.label,
            memo: first.memo
        };
    }).sort((a, b) => a.from_id - b.from_id || a.to_id - b.to_id);
}

export function linkGroupLabel(group) {
    return group.link_ids.length > 1 ? `×${group.link_ids.length}` : group.label || '';
}
