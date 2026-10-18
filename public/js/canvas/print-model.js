import { DEFAULT_DEVICE_HEIGHT, DEFAULT_DEVICE_WIDTH, DEVICE_TYPES } from '../core/constants.js';
import { getLinkSystem, LINK_SYSTEM_COLORS } from '../core/link-systems.js';
import { resolveTopologyLinkRoutes } from './link-route-resolver.js';
import { createLinkDisplayMap } from './link-crossings.js';

const systemColors = new Map(LINK_SYSTEM_COLORS.map(entry => [entry.key, entry.color]));

export function createPrintSettings() {
    return {
        range: 'all', deviceTypes: Object.fromEntries(Object.keys(DEVICE_TYPES).map(type => [type, true])),
        links: true, floorPlan: true, notes: true,
        deviceName: true, deviceType: true, ip: true, labels: true, title: true,
        orientation: 'auto'
    };
}

export function viewportToPrintBounds(rect, viewState) {
    const { scale, panX, panY } = viewState;
    return {
        x: -panX / scale, y: -panY / scale,
        width: rect.width / scale, height: rect.height / scale
    };
}

// IP非表示でも機器中心を動かさず、配線の端点と配置を維持する。
export function printDeviceBounds(placement, hasIp) {
    const height = hasIp ? DEFAULT_DEVICE_HEIGHT : DEFAULT_DEVICE_HEIGHT - 16;
    return {
        x: Number(placement.x), y: Number(placement.y) + (DEFAULT_DEVICE_HEIGHT - height) / 2,
        width: DEFAULT_DEVICE_WIDTH, height
    };
}

function unionBounds(rects) {
    if (!rects.length) return { x: 0, y: 0, width: 200, height: 120 };
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const rect of rects) {
        left = Math.min(left, rect.x);
        top = Math.min(top, rect.y);
        right = Math.max(right, rect.x + rect.width);
        bottom = Math.max(bottom, rect.y + rect.height);
    }
    const padding = 16;
    return { x: left - padding, y: top - padding, width: Math.max(1, right - left) + padding * 2,
        height: Math.max(1, bottom - top) + padding * 2 };
}

/** 通常stateと保存キューには触れず、画面で使う情報だけを独立snapshotへ投影する。 */
export function buildPrintModel({ view, devices, placements, links, linkSystems = [], notes, floorPlan, viewport,
    crossingStyle = 'bridge', printedAt = new Date() }, settings) {
    const options = { ...settings, deviceTypes: { ...settings.deviceTypes } };
    const viewPlacements = placements.filter(item => Number(item.view_id) === Number(view.id));
    const viewLinks = links.filter(item => Number(item.view_id) === Number(view.id));
    const deviceById = new Map(devices.map(device => [Number(device.id), device]));
    const systemMap = new Map(linkSystems.map(system => [Number(system.id), system]));
    const nodes = [];
    const included = new Set();
    for (const placement of viewPlacements) {
        const device = deviceById.get(Number(placement.device_id));
        if (!device) continue;
        const type = Object.hasOwn(DEVICE_TYPES, device.type) ? device.type : 'other';
        if (!options.deviceTypes[type]) continue;
        const ip = options.ip ? String(device.ip || '') : '';
        const name = options.deviceName !== false ? String(device.name || '(名称未設定)') : '';
        const showDeviceType = options.deviceType !== false;
        nodes.push({ id: Number(placement.id), deviceId: Number(device.id), type,
            name, ip, showDeviceType,
            ...printDeviceBounds(placement, Boolean(ip)) });
        included.add(Number(device.id));
    }

    // 通常画面と同じ障害物・全リンクで経路を解決してからfilterする。
    // フィルタの切替で手動経路や自動経路の形が変わることを避ける。
    const routes = options.links ? resolveTopologyLinkRoutes(viewLinks, viewPlacements) : new Map();
    const printableLinks = options.links ? viewLinks.filter(link =>
        included.has(Number(link.from_id)) && included.has(Number(link.to_id)) && routes.has(Number(link.id))) : [];
    const printRoutes = new Map(printableLinks.map(link => [Number(link.id), routes.get(Number(link.id))]));
    const display = createLinkDisplayMap(printRoutes, crossingStyle);
    const wires = [];
    for (const link of printableLinks) {
        const linkId = Number(link.id);
        const route = printRoutes.get(linkId);
        const disp = display.get(linkId);
        if (!route || !disp) continue;
        wires.push({
            id: linkId, points: route.map(point => ({ ...point })),
            pathData: disp.pathData,
            color: systemColors.get(getLinkSystem(link.system_id, systemMap)?.color_key) || '#334155',
            labelPosition: { ...disp.labelPosition },
            label: options.labels ? String(link.label || '') : ''
        });
    }
    const printNotes = options.notes ? notes.filter(note => Number(note.view_id) === Number(view.id)).map(note => ({
        id: Number(note.id), text: String(note.text ?? ''), x: Number(note.x), y: Number(note.y),
        width: Number(note.width), height: Number(note.height), background_color: note.background_color,
        background_opacity: Number(note.background_opacity), text_color: note.text_color, font_size: Number(note.font_size)
    })) : [];
    const plan = options.floorPlan && view.view_type === 'floor' && floorPlan?.image_url &&
        Number(floorPlan.view_id) === Number(view.id) ? {
            imageUrl: floorPlan.image_url, x: Number(floorPlan.x), y: Number(floorPlan.y),
            width: Number(floorPlan.image_width) * Number(floorPlan.scale),
            height: Number(floorPlan.image_height) * Number(floorPlan.scale), opacity: Number(floorPlan.opacity)
        } : null;
    const rects = [...nodes, ...printNotes];
    for (const wire of wires) {
        for (const point of wire.points) rects.push({ ...point, width: 0, height: 0 });
        if (wire.label) {
            // SVGと同じ12px。全角を含む長いラベルにも余白を確保する。
            const width = [...wire.label].length * 12;
            const { x, y, orientation } = wire.labelPosition;
            rects.push({ x: orientation === 'vertical' ? x : x - width / 2,
                y: y - 14, width, height: 20 });
        }
    }
    const rawBounds = options.range === 'viewport' ? { ...viewport } : plan ?
        { x: plan.x, y: plan.y, width: plan.width, height: plan.height } : unionBounds(rects);
    const bounds = {
        x: Number.isFinite(rawBounds?.x) ? rawBounds.x : 0,
        y: Number.isFinite(rawBounds?.y) ? rawBounds.y : 0,
        width: Math.max(1, Number(rawBounds?.width) || 0),
        height: Math.max(1, Number(rawBounds?.height) || 0)
    };
    const orientation = options.orientation === 'auto' ?
        (bounds.width >= bounds.height ? 'landscape' : 'portrait') : options.orientation;
    const date = printedAt;
    const pad = number => String(number).padStart(2, '0');
    const title = options.title ? {
        name: String(view.name || ''), location: [view.facility, view.floor].filter(Boolean).join(' / '),
        time: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    } : null;
    return { settings: options, bounds, orientation, nodes, wires, notes: printNotes, floorPlan: plan, title,
        empty: !nodes.length && !wires.length && !printNotes.length && !plan };
}

export function calculatePrintScale(bounds, width, height) {
    const bw = Math.max(1, Number(bounds?.width) || 0);
    const bh = Math.max(1, Number(bounds?.height) || 0);
    return Math.min(width / bw, height / bh);
}
