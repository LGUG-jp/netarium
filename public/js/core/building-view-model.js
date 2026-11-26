import { orderedFloors } from './building-hierarchy.js';
import { getFloorPlanCorners } from '../canvas/floor-plan-geometry.js';
import { linkPortNames, pairKey } from './connection-data.js';
import { DEFAULT_DEVICE_HEIGHT, DEFAULT_DEVICE_WIDTH } from './constants.js';
import { getRackDeviceMounts } from './device-placement.js';
import { floorRackPlacements } from './floor-rack-data.js';

export const IDENTITY_TRANSFORM = Object.freeze({ scale: 1, offset_x: 0, offset_y: 0, rotation: 0 });
const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;

const FLOOR_SPACING = 0.22;
const COMPARISON_WIDTH = 1000;
const COMPARISON_GAP = COMPARISON_WIDTH * 0.24;

export const isBuildingViewEnabled = building => building?.building_view_enabled === 1;
export const findEnabledBuilding = (data, id) =>
    id == null ? undefined : (data?.buildings || []).find(building => Number(building.id) === Number(id) && isBuildingViewEnabled(building));

const radians = degrees => degrees * (Math.PI / 180);
const bounds = () => ({ minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
const finitePoint = point => Number.isFinite(point.x) && Number.isFinite(point.y);
function extendBounds(box, point) {
    if (!finitePoint(point)) return;
    box.minX = Math.min(box.minX, point.x);
    box.maxX = Math.max(box.maxX, point.x);
    box.minY = Math.min(box.minY, point.y);
    box.maxY = Math.max(box.maxY, point.y);
}
const midpoint = (a, b) => a / 2 + b / 2;
const rectangle = (minX, minY, maxX, maxY) => [
    { x: minX, y: minY }, { x: maxX, y: minY }, { x: maxX, y: maxY }, { x: minX, y: maxY }
];

function median(values) {
    values.sort((a, b) => a - b);
    const middle = values.length >> 1;
    return values.length % 2 ? values[middle] : midpoint(values[middle - 1], values[middle]);
}

function placeholderCorners(layers) {
    const references = [];
    for (const layer of layers) {
        if (!layer.corners) continue;
        const points = transformedFloorCorners(layer);
        if (!points.every(finitePoint)) continue;
        const box = bounds();
        for (const point of points) extendBounds(box, point);
        const width = box.maxX - box.minX, height = box.maxY - box.minY;
        if (!(width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height))) continue;
        references.push({ x: midpoint(box.minX, box.maxX), y: midpoint(box.minY, box.maxY), width, height });
    }
    if (references.length) {
        // Typical bounds, not the union: one shifted or oversized drawing should not set the plate size.
        const x = median(references.map(reference => reference.x));
        const y = median(references.map(reference => reference.y));
        const w = median(references.map(reference => reference.width)) / 2;
        const h = median(references.map(reference => reference.height)) / 2;
        if (Number.isFinite(x - w) && Number.isFinite(x + w) && x - w < x + w &&
            Number.isFinite(y - h) && Number.isFinite(y + h) && y - h < y + h) {
            return rectangle(x - w, y - h, x + w, y + h);
        }
    }
    return rectangle(0, 0, 800, 600);
}

function sourcePlanCorners(plan) {
    if (!plan || !(finite(plan.image_width, 0) > 0 && finite(plan.image_height, 0) > 0 && finite(plan.scale, 0) > 0)) {
        return null;
    }
    const corners = Object.values(getFloorPlanCorners(plan));
    return corners.every(finitePoint) ? corners : null;
}

export function floorTransform(floor) {
    const scale = finite(floor.scale, 1);
    return { scale: scale > 0 ? scale : 1,
        offset_x: finite(floor.offset_x, 0), offset_y: finite(floor.offset_y, 0),
        rotation: finite(floor.rotation, 0) };
}

export function validFloorTransform(value) {
    return Object.values(value).every(Number.isFinite) && value.scale > 0 &&
        value.rotation >= -180 && value.rotation <= 180;
}

export function transformBuildingPoint(point, transform) {
    const angle = radians(transform.rotation);
    const c = Math.cos(angle), s = Math.sin(angle);
    return { x: transform.scale * (c * point.x - s * point.y) + transform.offset_x,
        y: transform.scale * (s * point.x + c * point.y) + transform.offset_y };
}

export const isPhysicalViewOnFloor = (view, floorId) =>
    view.view_type === 'floor' && Number(view.floor_id) === Number(floorId);

export function floorViewSelection(floor, views) {
    const isPhysical = view => isPhysicalViewOnFloor(view, floor.id);
    if (floor.representative_view_id != null) {
        const view = views.find(view => Number(view.id) === Number(floor.representative_view_id) && isPhysical(view)) ?? null;
        return { view, needsRepresentative: false };
    }
    let only = null;
    for (const view of views) {
        if (!isPhysical(view)) continue;
        if (only) return { view: null, needsRepresentative: true };
        only = view;
    }
    return { view: only, needsRepresentative: false };
}

export function buildingFloorLayers(data, buildingId) {
    const layers = orderedFloors(data, buildingId).map((floor, index) => {
        const { view, needsRepresentative } = floorViewSelection(floor, data.views);
        const plan = view && data.floorPlans.find(row => Number(row.view_id) === Number(view.id));
        const corners = sourcePlanCorners(plan);
        return { floor, view, needsRepresentative, plan: corners ? plan : null, corners, index, transform: floorTransform(floor) };
    });
    if (layers.some(layer => !layer.corners)) {
        const corners = placeholderCorners(layers);
        // Change the base geometry only; each saved floor transform remains editable.
        for (const layer of layers) {
            if (!layer.corners) layer.corners = corners;
        }
    }
    return layers;
}

function floorNumber(name) {
    const normalized = String(name ?? '').normalize('NFKC').toUpperCase().replace(/\s/g, '');
    const parts = /^(?:(\d+)(?:F|階)|B(\d+)F?|地下(\d+)階)$/.exec(normalized);
    if (!parts) return null;
    const level = Number(parts[1] ?? parts[2] ?? parts[3]);
    if (!Number.isSafeInteger(level) || level <= 0) return null;
    return parts[1] ? level : -level;
}

function floorIdsByNumber(layers) {
    const ids = new Map();
    for (const { floor } of layers) {
        const level = floorNumber(floor.name);
        if (level != null) ids.set(level, ids.has(level) ? null : Number(floor.id));
    }
    return ids;
}

export function buildingComparisonAnchors(primaryLayers, secondaryLayers) {
    const primary = floorIdsByNumber(primaryLayers);
    const secondary = floorIdsByNumber(secondaryLayers);
    let lowestAbove = Infinity, deepestBelow = 0;
    for (const [level, id] of primary) {
        if (id == null || secondary.get(level) == null) continue;
        if (level > 0) lowestAbove = Math.min(lowestAbove, level);
        else deepestBelow = Math.min(deepestBelow, level);
    }
    const level = lowestAbove !== Infinity ? lowestAbove : deepestBelow;
    return level
        ? { ids: [primary.get(level), secondary.get(level)], matched: true }
        : { ids: [primaryLayers.length ? Number(primaryLayers[0].floor.id) : null,
            secondaryLayers.length ? Number(secondaryLayers[0].floor.id) : null], matched: false };
}

/** Resolve devices in representative floor views without applying the building transform. */
export function buildingConnections(data, layers) {
    const devices = new Map();
    const locations = new Map();
    const groups = new Map();
    const systems = new Map((data.linkSystems || []).map(system => [Number(system.id), system]));
    const layersByView = new Map(layers.filter(layer => layer.view).map(layer => [Number(layer.view.id), layer]));
    if (!layersByView.size) return { devices, locations, groups, systems };

    const candidates = new Map();
    const addCandidate = (id, location) => {
        // A second placement invalidates the endpoint even if its coordinates coincide.
        candidates.set(id, candidates.has(id) ? null : location);
    };
    for (const placement of data.placements || []) {
        const layer = layersByView.get(Number(placement.view_id));
        if (layer) addCandidate(Number(placement.device_id), { layer, placement });
    }

    const rackViews = new Set((data.views || []).filter(view => view.view_type === 'rack').map(view => Number(view.id)));
    const mountedLocations = new Map();
    for (const placement of floorRackPlacements(data)) {
        const layer = layersByView.get(Number(placement.floor_view_id));
        const rackId = Number(placement.rack_view_id);
        if (!layer || !rackViews.has(rackId)) continue;
        const location = { layer, placement };
        const rackLocations = mountedLocations.get(rackId);
        if (rackLocations) rackLocations.push(location);
        else mountedLocations.set(rackId, [location]);
    }
    if (mountedLocations.size) {
        for (const mount of getRackDeviceMounts(data)) {
            const rackLocations = mountedLocations.get(Number(mount.view_id));
            if (!rackLocations) continue;
            const id = Number(mount.device_id);
            for (const location of rackLocations) addCandidate(id, location);
        }
    }

    for (const device of data.devices || []) {
        const id = Number(device.id);
        const candidate = candidates.get(id);
        if (!candidate) continue;
        const { layer, placement } = candidate;
        // Both canvas renderers position their equally sized symbols by the top-left corner.
        const point = {
            x: Number(placement.x) + DEFAULT_DEVICE_WIDTH / 2,
            y: Number(placement.y) + DEFAULT_DEVICE_HEIGHT / 2
        };
        if (!finitePoint(point)) continue;
        devices.set(id, { device, layer, point });
        const key = `${Number(layer.floor.id)}:${point.x}:${point.y}`;
        const location = locations.get(key);
        if (location) location.devices.push(device);
        else locations.set(key, { layer, point, devices: [device] });
    }

    const byPair = new Map();
    for (const link of data.links || []) {
        const from = devices.get(Number(link.from_id));
        const to = devices.get(Number(link.to_id));
        if (!from || !to || from.layer === to.layer) continue;
        const key = pairKey(link.from_id, link.to_id);
        const members = byPair.get(key);
        if (members) members.push(link);
        else byPair.set(key, [link]);
    }
    const ports = new Map((data.devicePorts || []).map(port => [Number(port.id), port.name]));
    for (const [key, links] of byPair) {
        links.sort((a, b) => Number(a.id) - Number(b.id));
        const first = links[0];
        const fromId = Math.min(first.from_id, first.to_id), toId = Math.max(first.from_id, first.to_id);
        const system_ids = [...new Set(links.map(link => link.system_id == null ? null : Number(link.system_id)))];
        groups.set(key, {
            from_id: fromId, to_id: toId,
            interBuilding: Number(devices.get(fromId).layer.floor.building_id) !==
                Number(devices.get(toId).layer.floor.building_id),
            link_ids: links.map(link => Number(link.id)),
            system_ids,
            system_id: system_ids.length === 1 ? system_ids[0] : null,
            members: links.map(link => ({ ...link, ...linkPortNames(link, ports) }))
        });
    }
    return { devices, locations, groups, systems };
}

export function transformedFloorCorners(layer, transform = layer.transform) {
    return layer.corners.map(point => transformBuildingPoint(point, transform));
}

export function alignBuildingFloor(target, reference) {
    if (!target?.plan || !reference?.plan || target === reference) return null;
    const [a, b, c, d] = target.corners;
    const [ra, rb, rc, rd] = transformedFloorCorners(reference);
    // 直交する辺の倍率の幾何平均を使い、縦横比は変えない。
    const scale = Math.sqrt(Math.hypot(rb.x - ra.x, rb.y - ra.y) / Math.hypot(b.x - a.x, b.y - a.y)) *
        Math.sqrt(Math.hypot(rd.x - ra.x, rd.y - ra.y) / Math.hypot(d.x - a.x, d.y - a.y));
    const angle = Math.atan2(rb.y - ra.y, rb.x - ra.x) - Math.atan2(b.y - a.y, b.x - a.x);
    const rotation = ((angle * 180 / Math.PI + 540) % 360) - 180;
    const center = transformBuildingPoint({ x: midpoint(a.x, c.x), y: midpoint(a.y, c.y) },
        { scale, rotation, offset_x: 0, offset_y: 0 });
    const transform = { scale, rotation, offset_x: midpoint(ra.x, rc.x) - center.x,
        offset_y: midpoint(ra.y, rc.y) - center.y };
    return validFloorTransform(transform) ? transform : null;
}

// One common XY origin and scale: never normalize each floor independently.
export function buildingSceneFrame(layers) {
    const box = bounds();
    for (const layer of layers) {
        for (const point of transformedFloorCorners(layer)) extendBounds(box, point);
    }
    if (box.minX === Infinity) return { x: 0, y: 0, span: 1000, levels: layers.length };
    return { x: midpoint(box.minX, box.maxX), y: midpoint(box.minY, box.maxY),
        span: Math.max(box.maxX - box.minX, box.maxY - box.minY, 1), levels: layers.length };
}

export function buildingComparisonFrame(stacks, anchorIds) {
    const stepZ = FLOOR_SPACING * COMPARISON_WIDTH;
    const buildings = new Map();
    let levels = 0;
    for (const [index, { id, layers }] of stacks.entries()) {
        levels = Math.max(levels, layers.length);
        const { x, y, span } = buildingSceneFrame(layers);
        const requestedId = anchorIds[index];
        const anchor = requestedId == null ? null : layers.find(layer => Number(layer.floor.id) === Number(requestedId));
        const anchorIndex = anchor?.index ?? layers[0]?.index ?? 0;
        buildings.set(Number(id), {
            x, y, scale: COMPARISON_WIDTH / span,
            offsetX: (index - 0.5) * (COMPARISON_WIDTH + COMPARISON_GAP),
            anchorIndex,
            // Keep the name just above the top floor, including when there are no floors.
            topZ: ((layers.at(-1)?.index ?? anchorIndex) - anchorIndex + 0.5) * stepZ
        });
    }
    return { x: 0, y: 0, span: 2 * COMPARISON_WIDTH + COMPARISON_GAP, levels, stepZ, buildings };
}

const comparisonPlacement = (frame, layer) => frame.buildings?.get(Number(layer.floor.building_id));

export function buildingFloorZ(layer, frame) {
    const placement = comparisonPlacement(frame, layer);
    return placement ? (layer.index - placement.anchorIndex) * frame.stepZ
        : (layer.index - (frame.levels - 1) / 2) * FLOOR_SPACING * frame.span;
}

function viewAxes(camera) {
    const angle = radians(camera.azimuth), tilt = radians(camera.elevation);
    return { c: Math.cos(angle), s: Math.sin(angle), sinTilt: Math.sin(tilt), cosTilt: Math.cos(tilt) };
}

function viewPoint(point, z, frame, { c, s, sinTilt, cosTilt }, placement) {
    const x = placement ? (point.x - placement.x) * placement.scale + placement.offsetX : point.x - frame.x;
    const y = placement ? (point.y - placement.y) * placement.scale : point.y - frame.y;
    return { x: c * x - s * y, y: (s * x + c * y) * sinTilt - z * cosTilt };
}

function fitExtent(length, span) {
    const padding = Math.min(24, length / 8);
    return (length - 2 * padding) / span;
}

export function fitBuildingCamera(layers, camera, frame, size, selectedId, selectedTransform, locations = []) {
    const box = bounds(), axes = viewAxes(camera);
    const projections = new Map();
    for (const layer of layers) {
        const z = buildingFloorZ(layer, frame);
        const transform = selectedId != null && Number(layer.floor.id) === Number(selectedId) ? selectedTransform : layer.transform;
        const placement = comparisonPlacement(frame, layer);
        projections.set(Number(layer.floor.id), { z, transform, placement });
        for (const point of transformedFloorCorners(layer, transform)) {
            extendBounds(box, viewPoint(point, z, frame, axes, placement));
        }
    }
    // 図面の外や仮プレートの外に配置された機器も初期表示から選択できるようにする。
    for (const { layer, point } of locations) {
        const { z, transform, placement } = projections.get(Number(layer.floor.id));
        extendBounds(box, viewPoint(transformBuildingPoint(point, transform), z, frame, axes, placement));
    }
    if (frame.buildings) {
        for (const { offsetX, topZ } of frame.buildings.values()) {
            extendBounds(box, viewPoint({ x: offsetX, y: 0 }, topZ, frame, axes));
        }
    }
    const hasBounds = box.minX !== Infinity;
    const scale = hasBounds ? Math.min(fitExtent(size.width, box.maxX - box.minX),
        fitExtent(size.height, box.maxY - box.minY)) : 0;
    return { ...camera, zoom: 1, panX: 0, panY: 0,
        fitScale: Number.isFinite(scale) && scale > 0 ? scale : defaultProjectionScale(frame, size),
        centerU: hasBounds ? midpoint(box.minX, box.maxX) : 0,
        centerV: hasBounds ? midpoint(box.minY, box.maxY) : 0 };
}

export function projectBuildingPoint(point, z, camera, frame, size, layer) {
    const projected = viewPoint(point, z, frame, viewAxes(camera), layer && comparisonPlacement(frame, layer));
    const scale = buildingProjectionScale(camera, frame, size);
    projected.x = size.width / 2 + (projected.x - (camera.centerU ?? 0)) * scale + (camera.panX ?? 0);
    projected.y = size.height / 2 + (projected.y - (camera.centerV ?? 0)) * scale + (camera.panY ?? 0);
    return projected;
}

function defaultProjectionScale(frame, size) {
    return Math.min(size.width, size.height) / frame.span;
}

export function buildingProjectionScale(camera, frame, size) {
    return (camera.fitScale ?? defaultProjectionScale(frame, size)) * camera.zoom;
}

export function buildingDragDelta(dx, dy, camera, frame, size) {
    const angle = radians(camera.azimuth), c = Math.cos(angle), s = Math.sin(angle);
    const scale = buildingProjectionScale(camera, frame, size);
    const x = dx / scale, y = dy / (scale * Math.sin(radians(camera.elevation)));
    return { x: c * x + s * y, y: -s * x + c * y };
}
