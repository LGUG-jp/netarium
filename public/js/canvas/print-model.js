import { DEFAULT_DEVICE_HEIGHT, DEFAULT_DEVICE_WIDTH, DEVICE_TYPES } from '../core/constants.js';
import { getLinkSystem, LINK_SYSTEM_COLORS } from '../core/link-systems.js';
import { resolveTopologyLinkRoutes } from './link-route-resolver.js';
import { createLinkDisplayMap } from './link-crossings.js';
import { rackDisplaySlot, rackFaces, rackOccupiedFaces } from '../core/rack-layout.js';
import { RACK_NOTE_REGIONS, getRackNoteRegion } from '../core/canvas-note-data.js';

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

function rackDetailLines(text) {
    // 280px列・12px文字で全角や長いIPも省略せず折り返す。
    return String(text).split('\n').flatMap(line => {
        const chars = [...line];
        return Array.from({ length: Math.max(1, Math.ceil(chars.length / 21)) },
            (_, index) => chars.slice(index * 21, (index + 1) * 21).join(''));
    });
}

/** Fixed physical geometry: viewport and transient screen face never crop rack printing. */
export function buildRackPrintLayout(view, devices, rackSettings = [], rackMounts = [], options = createPrintSettings(), rackShelves = [], rackShelfDevices = []) {
    const settings = rackSettings.find(row => Number(row.view_id) === Number(view.id));
    const totalU = Number(settings?.total_u) || 42;
    const rowHeight = 32, faceWidth = 240, top = 32, gap = 48;
    const faces = ['front', 'rear'].map((face, index) => ({
        face, label: face === 'front' ? '前面' : '背面',
        x: 16 + index * (faceWidth + gap), y: top, width: faceWidth, height: totalU * rowHeight
    }));
    const rows = Array.from({ length: totalU }, (_, index) => ({
        u: totalU - index, y: top + index * rowHeight, height: rowHeight
    }));
    const deviceById = new Map(devices.map(device => [Number(device.id), device]));
    const blocks = [], blockedSlots = [], shelfDetails = [];
    let detailY = top;
    for (const mount of rackMounts.filter(row => Number(row.view_id) === Number(view.id))) {
        const device = deviceById.get(Number(mount.device_id));
        if (!device) continue;
        const type = Object.hasOwn(DEVICE_TYPES, device.type) ? device.type : 'other';
        if (!options.deviceTypes[type]) continue;
        for (const frame of faces) {
            if (!rackOccupiedFaces(mount).includes(frame.face)) continue;
            const slot = rackDisplaySlot(mount.width_slot, frame.face);
            const geometry = {
                x: frame.x + (slot === 'right' ? faceWidth / 2 : 0),
                y: top + (totalU - Number(mount.start_u) - Number(mount.height_u) + 1) * rowHeight,
                width: slot === 'full' ? faceWidth : faceWidth / 2, height: Number(mount.height_u) * rowHeight
            };
            if (!rackFaces(mount.face).includes(frame.face)) {
                blockedSlots.push({ ...geometry, face: frame.face, slot,
                    causeName: options.deviceName !== false ? String(device.name || '(名称未設定)') : '' });
                continue;
            }
            blocks.push({
                deviceId: Number(device.id), face: frame.face, slot, type,
                name: options.deviceName !== false ? String(device.name || '(名称未設定)') : '',
                ip: options.ip ? String(device.ip || '') : '',
                showDeviceType: options.deviceType !== false,
                startU: Number(mount.start_u), heightU: Number(mount.height_u), mountFace: mount.face,
                ...geometry
            });
        }
    }
    for (const shelf of rackShelves.filter(row => Number(row.view_id) === Number(view.id))) {
        const children = rackShelfDevices.filter(row => Number(row.shelf_id) === Number(shelf.id))
            .sort((a, b) => Number(a.sort_order) - Number(b.sort_order))
            .flatMap(member => {
                const device = deviceById.get(Number(member.device_id));
                if (!device) return [];
                const type = Object.hasOwn(DEVICE_TYPES, device.type) ? device.type : 'other';
                if (!options.deviceTypes[type]) return [];
                return [{ deviceId: Number(device.id), type, showDeviceType: options.deviceType !== false,
                    nameLines: options.deviceName !== false ? rackDetailLines(device.name || '(名称未設定)') : [],
                    ipLines: options.ip && device.ip ? rackDetailLines(device.ip) : [] }];
            });
        const count = children.length;
        if (children.length) {
            const headingLines = rackDetailLines(`${shelf.name} / ${count}台`);
            headingLines.push(`${shelf.start_u}〜${Number(shelf.start_u) + Number(shelf.height_u) - 1}U / ${shelf.face === 'rear' ? '背面' : '前面'}`);
            let childY = detailY + 10 + headingLines.length * 18;
            for (const child of children) {
                child.y = childY;
                child.height = Math.max(1, child.nameLines.length + child.ipLines.length + Number(child.showDeviceType)) * 18 + 8;
                childY += child.height;
            }
            shelfDetails.push({ shelfId: Number(shelf.id), x: faceWidth * 2 + gap + 48,
                y: detailY, width: 280, height: childY - detailY + 4, headingLines, children });
            detailY = childY + 16;
        }
        for (const frame of faces) {
            if (!rackOccupiedFaces(shelf).includes(frame.face)) continue;
            const geometry = { x: frame.x, y: top + (totalU - Number(shelf.start_u) - Number(shelf.height_u) + 1) * rowHeight,
                width: faceWidth, height: Number(shelf.height_u) * rowHeight };
            if (frame.face !== shelf.face) {
                blockedSlots.push({ ...geometry, face: frame.face, slot: 'full', causeName: shelf.name }); continue;
            }
            blocks.push({ shelfId: Number(shelf.id), deviceId: null, face: frame.face, slot: 'full', type: 'other',
                name: `${shelf.name} / ${count}台`, ip: '', showDeviceType: false,
                startU: Number(shelf.start_u), heightU: Number(shelf.height_u), mountFace: shelf.face, ...geometry });
        }
    }
    blocks.sort((a, b) => a.face.localeCompare(b.face) || a.y - b.y || a.x - b.x || a.deviceId - b.deviceId);
    return { totalU, rowHeight, faces, rows, blocks, blockedSlots, shelfDetails, location: String(settings?.location || ''),
        bounds: { x: 0, y: 0, width: faceWidth * 2 + gap + 32, height: top + totalU * rowHeight + 16 } };
}

function printTitle(view, options, date, location = '') {
    const pad = number => String(number).padStart(2, '0');
    return options.title ? {
        name: String(view.name || ''), location: [view.facility, view.floor, location].filter(Boolean).join(' / '),
        time: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    } : null;
}

/** 通常stateと保存キューには触れず、画面で使う情報だけを独立snapshotへ投影する。 */
export function buildPrintModel({ view, devices, placements, links, linkSystems = [], notes, floorPlan, viewport,
    rackSettings = [], rackMounts = [], rackShelves = [], rackShelfDevices = [], views = [], floorRackPlacements = [],
    crossingStyle = 'bridge', printedAt = new Date() }, settings) {
    const options = { ...settings, deviceTypes: { ...settings.deviceTypes } };
    const printNotes = options.notes ? notes.filter(note => Number(note.view_id) === Number(view.id)).map(note => ({
        id: Number(note.id), text: String(note.text ?? ''), x: Number(note.x), y: Number(note.y),
        width: Number(note.width), height: Number(note.height), background_color: note.background_color,
        background_opacity: Number(note.background_opacity), text_color: note.text_color, font_size: Number(note.font_size)
    })) : [];
    if (view.view_type === 'rack') {
        const rack = buildRackPrintLayout(view, devices, rackSettings, rackMounts, options, rackShelves, rackShelfDevices);
        // 全件表示の右列フローを維持し、画面の領域順と見出しを印刷にも残す。
        let noteY = rack.shelfDetails.length ?
            Math.max(...rack.shelfDetails.map(detail => detail.y + detail.height)) + 12 : 32;
        const orderedNotes = RACK_NOTE_REGIONS.flatMap(region =>
            printNotes.filter(note => getRackNoteRegion(note).key === region.key));
        const rackNotes = orderedNotes.map(note => {
            const width = 280;
            const charsPerLine = Math.max(1, Math.floor((width - 20) / note.font_size));
            const lines = note.text.split('\n').reduce((count, line) => count + Math.max(1, Math.ceil([...line].length / charsPerLine)), 0);
            const height = Math.max(64, lines * note.font_size * 1.5 + 46);
            const projected = { ...note, regionLabel: getRackNoteRegion(note).label,
                x: rack.bounds.width + 16, y: noteY, width, height };
            noteY += height + 12;
            return projected;
        });
        const sideBlocks = [...rack.shelfDetails, ...rackNotes];
        const bounds = sideBlocks.length ? unionBounds([rack.bounds, ...sideBlocks]) : rack.bounds;
        const orientation = options.orientation === 'auto' ?
            (bounds.width >= bounds.height ? 'landscape' : 'portrait') : options.orientation;
        return { settings: options, bounds, orientation, rack, nodes: [], wires: [], notes: rackNotes, floorPlan: null,
            title: printTitle(view, options, printedAt, rack.location), empty: false };
    }
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
    if (view.view_type === 'floor') {
        for (const placement of floorRackPlacements.filter(row => Number(row.floor_view_id) === Number(view.id))) {
            const rack = views.find(row => Number(row.id) === Number(placement.rack_view_id) && row.view_type === 'rack');
            if (!rack) continue;
            nodes.push({ rackViewId: Number(rack.id), icon: 'assets/icons/toolbar/rack.svg',
                name: String(rack.name || ''), ip: '', showDeviceType: false,
                x: Number(placement.x), y: Number(placement.y), width: DEFAULT_DEVICE_WIDTH, height: DEFAULT_DEVICE_HEIGHT });
        }
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
    const title = printTitle(view, options, printedAt);
    return { settings: options, bounds, orientation, nodes, wires, notes: printNotes, floorPlan: plan, title,
        empty: !nodes.length && !wires.length && !printNotes.length && !plan };
}

export function calculatePrintScale(bounds, width, height) {
    const bw = Math.max(1, Number(bounds?.width) || 0);
    const bh = Math.max(1, Number(bounds?.height) || 0);
    return Math.min(width / bw, height / bh);
}
