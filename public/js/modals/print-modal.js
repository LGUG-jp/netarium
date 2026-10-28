import { appState, getCurrentView, getCurrentFloorPlan } from '../core/state.js';
import { DEVICE_TYPES } from '../core/constants.js';
import { registerModalOpen, registerModalClose } from '../core/modal-focus.js';
import { buildPrintModel, createPrintSettings, viewportToPrintBounds, calculatePrintScale } from '../canvas/print-model.js';
import { renderPrintSheet, waitForPrintAssets } from '../canvas/print-renderer.js';
import { getLinkCrossingStyle } from '../core/link-display-settings.js';
import { commitCanvasNoteText } from '../canvas/canvas-notes.js';

const contentKeys = ['links', 'floorPlan', 'notes', 'deviceName', 'deviceType', 'ip', 'labels', 'title'];
let settings = createPrintSettings();
let viewport = null;
let previewGeneration = 0;
let printReady = false;

function clearPreview() {
    previewGeneration++;
    printReady = false;
    document.body.classList.remove('print-preview-active');
    const pageStyle = document.getElementById('print-page-style');
    if (pageStyle) pageStyle.textContent = '';
}

async function updatePrintPreview() {
    const view = getCurrentView();
    if (!view || !viewport) return;
    clearPreview();
    const generation = previewGeneration;
    const error = document.getElementById('print-preview-error');
    error.hidden = true;
    const button = document.getElementById('print-execute');
    button.disabled = true;
    const preview = document.getElementById('print-preview');
    const status = document.getElementById('print-preview-status');
    preview.setAttribute('aria-busy', 'true');
    status.textContent = 'プレビューを準備しています…';
    status.hidden = false;
    try {
        const model = buildPrintModel({
            view, devices: appState.devices, placements: appState.placements, links: appState.links,
            linkSystems: appState.linkSystems,
            rackSettings: appState.rackSettings, rackMounts: appState.rackMounts,
            rackShelves: appState.rackShelves, rackShelfDevices: appState.rackShelfDevices,
            views: appState.views, floorRackPlacements: appState.floorRackPlacements,
            notes: appState.canvasNotes, floorPlan: getCurrentFloorPlan(), viewport,
            crossingStyle: getLinkCrossingStyle()
        }, settings);
        const sheet = renderPrintSheet(model);
        document.getElementById('print-sheet-container').replaceChildren(sheet);
        document.getElementById('print-preview-orientation').textContent =
            `向き：${model.orientation === 'landscape' ? '横' : '縦'}${settings.orientation === 'auto' ? '（自動）' : ''}`;
        await waitForPrintAssets(sheet);
        if (generation !== previewGeneration) return;
        // SVG viewBoxが表示領域へ同じ比率でfitする。通常のviewState.scaleには代入しない。
        const rect = sheet.querySelector('svg').getBoundingClientRect();
        sheet.dataset.printScale = String(calculatePrintScale(model.bounds, rect.width, rect.height));
        document.getElementById('print-page-style').textContent =
            `@page { size: ${model.orientation}; margin: 0; }`;
        document.body.classList.add('print-preview-active');
        printReady = true;
        button.disabled = false;
        preview.setAttribute('aria-busy', 'false');
        status.textContent = '';
        status.hidden = true;
    } catch {
        if (generation !== previewGeneration) return;
        error.textContent = 'プレビューを準備できませんでした。画像の読み込みと印刷設定を確認して、もう一度お試しください。';
        error.hidden = false;
        preview.setAttribute('aria-busy', 'false');
        status.textContent = '';
        status.hidden = true;
    }
}


export function executePrint() {
    if (!printReady) return;
    window.print();
}

function syncSettings() {
    const rack = getCurrentView()?.view_type === 'rack';
    document.querySelectorAll('input[name="print-range"]').forEach(input => {
        input.checked = input.value === settings.range;
        input.disabled = rack;
    });
    document.querySelectorAll('input[name="print-orientation"]').forEach(input => {
        input.checked = input.value === settings.orientation;
    });
    for (const type of Object.keys(DEVICE_TYPES)) {
        document.getElementById(`print-type-${type}`).checked = settings.deviceTypes[type];
    }
    for (const key of contentKeys) document.getElementById(`print-${key}`).checked = settings[key];
    const notesInput = document.getElementById('print-notes');
    const notesLabel = notesInput?.parentElement?.querySelector('strong');
    if (notesLabel) notesLabel.textContent = rack ? 'ラックメモ' : 'キャンバスメモ';
    const planEnabled = getCurrentView()?.view_type === 'floor' && Boolean(getCurrentFloorPlan()?.image_url);
    const planInput = document.getElementById('print-floorPlan');
    planInput.disabled = !planEnabled;
    if (!planEnabled) planInput.checked = false;
    for (const key of ['links', 'labels']) {
        const input = document.getElementById(`print-${key}`);
        input.disabled = rack || (key === 'labels' && !settings.links);
        if (rack) input.checked = false;
    }
    const labelInput = document.getElementById('print-labels');
    labelInput.disabled = rack || !settings.links;
    if (!settings.links) labelInput.checked = false;
    document.getElementById('print-device-count').textContent =
        `${Object.values(settings.deviceTypes).filter(Boolean).length} / ${Object.keys(DEVICE_TYPES).length}種類を印刷`;
}

export async function openPrintModal() {
    commitCanvasNoteText();
    const overlay = document.getElementById('print-overlay');
    if (!overlay || !getCurrentView() || !appState.canvas) return;
    settings = createPrintSettings();
    syncSettings();
    viewport = viewportToPrintBounds(appState.canvas.getBoundingClientRect(), appState.viewState);
    overlay.hidden = false;
    registerModalOpen('print', overlay, 'input[name="print-range"]:checked', { onClose: closePrintModal });
    return updatePrintPreview();
}

export function closePrintModal() {
    const overlay = document.getElementById('print-overlay');
    if (overlay) overlay.hidden = true;
    document.getElementById('print-sheet-container')?.replaceChildren();
    clearPreview();
    viewport = null;
    registerModalClose('print');
}

export function initializePrintModal() {
    const overlay = document.getElementById('print-overlay');
    if (!overlay) return;
    const grid = document.getElementById('print-device-types');
    if (!grid) return;
    grid.replaceChildren();
    for (const [type, definition] of Object.entries(DEVICE_TYPES)) {
        const label = document.createElement('label');
        label.className = 'print-choice';
        const input = document.createElement('input');
        input.id = `print-type-${type}`;
        input.type = 'checkbox';
        const text = document.createElement('span');
        text.textContent = definition.label;
        label.append(input, text);
        grid.appendChild(label);
        input.addEventListener('change', () => {
            settings.deviceTypes[type] = input.checked;
            syncSettings();
            return updatePrintPreview();
        });
    }
    document.getElementById('print-execute')?.addEventListener('click', executePrint);
    document.getElementById('palette-print-btn')?.addEventListener('click', openPrintModal);
    for (const id of ['print-close', 'print-cancel']) {
        document.getElementById(id)?.addEventListener('click', closePrintModal);
    }
    for (const key of contentKeys) {
        document.getElementById(`print-${key}`).addEventListener('change', event => {
            settings[key] = event.target.checked;
            syncSettings();
            return updatePrintPreview();
        });
    }
    for (const [name, key] of [['print-range', 'range'], ['print-orientation', 'orientation']]) {
        document.querySelectorAll(`input[name="${name}"]`).forEach(input => {
            input.addEventListener('change', () => {
                if (!input.checked) return;
                settings[key] = input.value;
                return updatePrintPreview();
            });
        });
    }
    for (const [id, checked] of [['print-select-all', true], ['print-clear-all', false]]) {
        document.getElementById(id).addEventListener('click', () => {
            for (const type of Object.keys(DEVICE_TYPES)) settings.deviceTypes[type] = checked;
            syncSettings();
            return updatePrintPreview();
        });
    }
}
