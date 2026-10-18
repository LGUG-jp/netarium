import { DEVICE_TYPES } from '../core/constants.js';

export const PRINT_DEVICE_TYPE_LABELS = Object.freeze({
    switch: 'L2SW',
    l3_switch: 'L3SW',
    router: 'RT',
    firewall: 'FW',
    ap: 'AP',
    server: 'SV',
    printer: 'PR',
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
        block.append(background, text);
        svg.appendChild(foreignObject(note, block));
    }
    for (const node of model.nodes) {
        const definition = DEVICE_TYPES[node.type] || DEVICE_TYPES.other;
        const card = htmlElement('div', 'print-device');
        const icon = htmlElement('img', 'print-device-icon');
        icon.src = definition.icon;
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
