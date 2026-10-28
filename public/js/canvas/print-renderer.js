import { DEVICE_TYPES } from '../core/constants.js';

export const PRINT_DEVICE_TYPE_LABELS = Object.freeze({
    switch: 'L2SW',
    l3_switch: 'L3SW',
    router: 'RT',
    firewall: 'FW',
    ap: 'AP',
    server: 'SV',
    printer: 'PR',
    pc: 'PC',
    other: 'etc'
});

const SVG_NS = 'http://www.w3.org/2000/svg';
const HTML_NS = 'http://www.w3.org/1999/xhtml';
function svgElement(tag, attributes = {}) {
    const element = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
    return element;
}
function htmlElement(tag, className, text) {
    const element = document.createElementNS(HTML_NS, tag);
    element.setAttribute('class', className);
    if (text !== undefined) element.textContent = text;
    return element;
}
function foreignObject(rect, child) {
    const element = svgElement('foreignObject', { x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    element.appendChild(child);
    return element;
}

function rackText(svg, text, x, y, attributes = {}) {
    const node = svgElement('text', { x, y, 'font-size': 12, fill: '#0f172a', ...attributes });
    node.textContent = text;
    svg.appendChild(node);
}

function renderRack(svg, rack) {
    for (const frame of rack.faces) {
        rackText(svg, frame.label, frame.x + frame.width / 2, 21, { 'text-anchor': 'middle', 'font-size': 16 });
        svg.appendChild(svgElement('rect', { x: frame.x, y: frame.y, width: frame.width, height: frame.height,
            fill: '#ffffff', stroke: '#475569', 'stroke-width': 1 }));
        svg.appendChild(svgElement('line', { x1: frame.x + frame.width / 2, x2: frame.x + frame.width / 2,
            y1: frame.y, y2: frame.y + frame.height, stroke: '#cbd5e1' }));
        for (const row of rack.rows) {
            svg.appendChild(svgElement('line', { x1: frame.x, x2: frame.x + frame.width,
                y1: row.y, y2: row.y, stroke: '#cbd5e1' }));
        }
    }
    const centerX = rack.faces[0].x + rack.faces[0].width + 24;
    for (const row of rack.rows) {
        rackText(svg, String(row.u), centerX, row.y + row.height / 2,
            { 'text-anchor': 'middle', 'dominant-baseline': 'middle' });
    }
    for (const blocked of rack.blockedSlots) {
        const group = svgElement('g', { 'data-rack-blocked-face': blocked.face });
        const title = svgElement('title');
        title.textContent = `反対面の機器により占有${blocked.causeName ? `（${blocked.causeName}）` : ''}`;
        group.appendChild(title);
        group.appendChild(svgElement('rect', { x: blocked.x + 1, y: blocked.y + 1,
            width: blocked.width - 2, height: blocked.height - 2, fill: '#cbd5e1', stroke: '#64748b', 'stroke-dasharray': '3 2' }));
        rackText(group, '反対面により占有', blocked.x + 6, blocked.y + 16, { 'font-size': 10 });
        svg.appendChild(group);
    }
    for (const block of rack.blocks) {
        const group = svgElement('g', { 'data-device-id': block.deviceId, 'data-rack-face': block.face });
        const title = svgElement('title');
        const face = block.mountFace === 'both' ? '前後占有' : block.mountFace === 'rear' ? '背面' : '前面';
        const position = `${block.startU}〜${block.startU + block.heightU - 1}U / ${face}`;
        const type = block.showDeviceType ? PRINT_DEVICE_TYPE_LABELS[block.type] : '';
        title.textContent = [block.name, type, block.ip, position].filter(Boolean).join(' / ');
        group.appendChild(title);
        group.appendChild(svgElement('rect', { x: block.x + 1, y: block.y + 1,
            width: block.width - 2, height: block.height - 2, rx: 2, fill: '#e2e8f0',
            stroke: '#334155', 'stroke-width': 1 }));
        const shorten = value => {
            const max = Math.floor((block.width - 12) / 12);
            return [...value].length > max ? [...value].slice(0, max - 1).join('') + '…' : value;
        };
        const compact = block.height < 64 && Boolean(block.ip);
        rackText(group, shorten([block.name, type].filter(Boolean).join(' / ')), block.x + 6,
            block.y + (compact ? 10 : 13), { 'font-size': compact ? 10 : 12 });
        if (block.ip) rackText(group, block.ip, block.x + 6, block.y + (compact ? 23 : 32),
            { 'font-size': compact ? 9 : 10 });
        svg.appendChild(group);
    }
    for (const detail of rack.shelfDetails || []) {
        const group = svgElement('g', { 'data-rack-shelf-detail': detail.shelfId });
        group.appendChild(svgElement('rect', { x: detail.x, y: detail.y, width: detail.width,
            height: detail.height, fill: '#ffffff', stroke: '#64748b' }));
        detail.headingLines.forEach((line, index) =>
            rackText(group, line, detail.x + 10, detail.y + 22 + index * 18, { 'font-weight': 'bold' }));
        for (const child of detail.children) {
            const entry = svgElement('g', { 'data-device-id': child.deviceId });
            const lines = [...child.nameLines,
                ...(child.showDeviceType ? [PRINT_DEVICE_TYPE_LABELS[child.type]] : []), ...child.ipLines];
            lines.forEach((line, index) => rackText(entry, line, detail.x + 10, child.y + 14 + index * 18));
            group.appendChild(entry);
        }
        svg.appendChild(group);
    }
}

/** 印刷専用DOMだけを生成する。操作listenerや通常canvasへの参照は持たない。 */
export function renderPrintSheet(model) {
    const sheet = document.createElement('article');
    sheet.className = `print-sheet print-${model.orientation}`;
    if (model.title) {
        const header = document.createElement('header');
        header.className = 'print-sheet-title';
        if (model.title.name) header.appendChild(htmlElement('h3', '', model.title.name));
        if (model.title.location) header.appendChild(htmlElement('p', '', model.title.location));
        header.appendChild(htmlElement('p', '', model.title.time));
        sheet.appendChild(header);
    }
    const { x, y, width, height } = model.bounds;
    const svg = svgElement('svg', { viewBox: `${x} ${y} ${width} ${height}`,
        preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': '印刷対象の構成図' });
    svg.classList.add('print-diagram');
    if (model.rack) renderRack(svg, model.rack);
    if (model.floorPlan) {
        const plan = model.floorPlan;
        const image = htmlElement('img', 'print-floor-image');
        image.src = plan.imageUrl;
        image.alt = 'フロア図面';
        image.style.opacity = String(plan.opacity);
        svg.appendChild(foreignObject(plan, image));
    }
    for (const wire of model.wires) {
        const path = svgElement('path', { d: wire.pathData, fill: 'none', stroke: wire.color,
            'stroke-width': 2.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
        path.classList.add('print-wire');
        svg.appendChild(path);
        if (wire.label) {
            const position = wire.labelPosition;
            const label = svgElement('text', { x: position.x, y: position.y,
                'text-anchor': position.orientation === 'vertical' ? 'start' : 'middle',
                'dominant-baseline': position.orientation === 'vertical' ? 'middle' : 'auto',
                'font-size': 12, fill: '#334155' });
            label.textContent = wire.label;
            svg.appendChild(label);
        }
    }
    for (const note of model.notes) {
        const block = htmlElement('div', 'print-note');
        const background = htmlElement('div', 'print-note-background');
        background.style.backgroundColor = note.background_color;
        background.style.opacity = String(note.background_opacity);
        const text = htmlElement('div', 'print-note-text', note.text);
        text.style.color = note.text_color;
        text.style.fontSize = `${note.font_size}px`;
        block.appendChild(background);
        if (note.regionLabel) block.appendChild(htmlElement('h4', 'print-note-heading', note.regionLabel));
        block.appendChild(text);
        svg.appendChild(foreignObject(note, block));
    }
    for (const node of model.nodes) {
        const definition = DEVICE_TYPES[node.type] || DEVICE_TYPES.other;
        const card = htmlElement('div', 'print-device');
        const icon = htmlElement('img', 'print-device-icon');
        icon.src = node.icon || definition.icon;
        icon.alt = '';
        card.appendChild(icon);
        if (node.name) {
            const nameEl = htmlElement('div', 'print-device-name', node.name);
            nameEl.title = node.name;
            card.appendChild(nameEl);
        }
        if (node.ip) card.appendChild(htmlElement('div', 'print-device-ip', node.ip));
        if (node.showDeviceType !== false) {
            const typeLabel = PRINT_DEVICE_TYPE_LABELS[node.type] || definition.shortLabel || definition.label;
            card.appendChild(htmlElement('div', 'print-device-type', typeLabel));
        }
        svg.appendChild(foreignObject(node, card));
    }
    if (model.empty) {
        const text = svgElement('text', { x: x + width / 2, y: y + height / 2,
            'text-anchor': 'middle', 'font-size': 14, fill: '#666666' });
        text.textContent = '印刷対象がありません';
        svg.appendChild(text);
    }
    sheet.appendChild(svg);
    return sheet;
}

/** 画像の読込失敗時は空の図面を印刷させず、設定画面へエラーを返す。 */
export async function waitForPrintAssets(sheet) {
    await Promise.all([...sheet.querySelectorAll('img')].map(image => image.decode()));
    if (document.fonts) await document.fonts.ready;
}
