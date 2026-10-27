import { appState, getCurrentCanvasNotes, getCurrentView, allocateLocalId } from '../core/state.js';
import { endLinkMode } from '../core/link-mode.js';
import { DEFAULT_CANVAS_NOTE, CANVAS_NOTE_LIMITS, RACK_NOTE_REGION_X, RACK_NOTE_REGIONS, getRackNoteRegion } from '../core/canvas-note-data.js';
import { eventBus } from '../core/event-bus.js';
import { hasResourceConflict, scheduleSave } from '../core/save-queue.js';
import { mappedResourceId } from '../core/resource-save.js';
import { isCurrentUserAdmin, requireAdminUiAction } from '../ui/access-control.js';
import { markDirty } from '../ui/status-bar.js';
import { closePanel, closeLinkPanel } from '../ui/property-panel.js';
import { exitPlacementMode, isPlacementModeActive } from '../ui/placement-mode.js';
import { syncLinkModeButton } from '../ui/toolbar-controls.js';
import { showCanvasContextToolbar, hideCanvasContextToolbar, finishCanvasContextToolbar } from '../ui/canvas-context-toolbar.js';
import { screenToWorld } from './pan-zoom.js';
import { suppressCanvasClickOnce } from './interaction-state.js';
import { syncConnectionHighlight } from './renderer.js';
import { replaceSelectedPlacementIds } from './selection.js';

let editing = null;
let drag = null;
let stylePreview = null;
let openColorId = null;
const initialized = new WeakSet();
const el = id => document.getElementById(id);
const selectedNote = () => getCurrentCanvasNotes().find(note => Number(note.id) === Number(appState.selectedCanvasNoteId));
const findNote = id => (appState.canvasNotes || []).find(note => Number(note.id) === Number(id));
const canEdit = note => Boolean(note && isCurrentUserAdmin() && !appState.authExpired && !appState.isPinging &&
    !hasResourceConflict('views', note.view_id));
const save = () => { markDirty(); scheduleSave({ immediate: true, silent: true }); };
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function closeColorDropdown(restoreFocus = false) {
    const id = openColorId;
    if (!id) return;
    openColorId = null;
    el(`${id}-options`).hidden = true;
    el(id).setAttribute('aria-expanded', 'false');
    if (restoreFocus) el(id).focus({ preventScroll: true });
}
function openColorDropdown(id, last = false) {
    if (!el(id) || el(id).disabled) return;
    closeColorDropdown();
    openColorId = id;
    const menu = el(`${id}-options`);
    menu.hidden = false;
    el(id).setAttribute('aria-expanded', 'true');
    const options = [...menu.querySelectorAll('[data-color]')];
    const selected = options.find(option => option.getAttribute('aria-checked') === 'true');
    (selected || options[last ? options.length - 1 : 0])?.focus({ preventScroll: true });
}
function initColorDropdown(id, field) {
    const trigger = el(id), menu = el(`${id}-options`);
    if (!trigger || !menu) return;
    const options = [...menu.querySelectorAll('[data-color]')];
    trigger.addEventListener('click', () => {
        if (openColorId === id) closeColorDropdown(true);
        else openColorDropdown(id);
    });
    trigger.addEventListener('keydown', event => {
        if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
        event.preventDefault();
        openColorDropdown(id, event.key === 'ArrowUp');
    });
    trigger.parentElement.addEventListener('focusout', event => {
        if (openColorId === id && !trigger.parentElement.contains(event.relatedTarget)) closeColorDropdown();
    });
    options.forEach((option, index) => {
        const choose = () => {
            closeColorDropdown(true);
            changeStyle(field, option.dataset.color, true);
        };
        option.addEventListener('click', choose);
        option.addEventListener('keydown', event => {
            if (event.key === 'Tab') { closeColorDropdown(); return; }
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                choose();
                return;
            }
            const delta = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 4, ArrowUp: -4 }[event.key];
            if (delta == null && !['Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
                : (index + delta + options.length) % options.length;
            options[next].focus({ preventScroll: true });
        });
    });
}

function syncMode() {
    el('palette-note-btn')?.classList.toggle('active', Boolean(appState.noteMode));
    el('palette-note-btn')?.setAttribute('aria-pressed', String(Boolean(appState.noteMode)));
    appState.canvas?.classList.toggle('note-mode', Boolean(appState.noteMode));
    syncLinkModeButton();
}
export async function toggleCanvasNoteMode() {
    if (getCurrentView()?.view_type === 'rack') return;
    if (appState.noteMode) { finishCanvasNotes(); return; }
    if (!requireAdminUiAction() || appState.currentViewId == null || appState.authExpired || appState.isPinging ||
        hasResourceConflict('views', appState.currentViewId)) return;
    if (!await closePanel() || !await closeLinkPanel()) return;
    finishCanvasContextToolbar('replace');
    exitPlacementMode();
    eventBus.emit('wiring:close');
    window.closeWorkspaceNavigation?.();
    endLinkMode();
    appState.noteMode = true;
    syncMode();
    replaceSelectedPlacementIds([]);
    renderCanvasNotes();
}

export function commitCanvasNoteText() {
    if (!editing) return true;
    const draft = editing;
    const note = findNote(draft.id);
    if (note && (!isCurrentUserAdmin() || appState.authExpired)) {
        draft.textarea.readOnly = true;
        return false;
    }
    editing = null;
    if (note) {
        const text = draft.textarea.value;
        if (note.text !== text || draft.created) {
            note.text = text;
            save();
        }
    }
    renderCanvasNotes();
    return true;
}
function discardEditing() { editing = null; }
function cancelDrag() {
    const previous = drag;
    drag = null;
    if (previous?.element.hasPointerCapture?.(previous.pointerId)) {
        previous.element.releasePointerCapture(previous.pointerId);
    }
}
export function finishCanvasNotes(reason = 'finish') {
    closeColorDropdown();
    if (!appState.noteMode && appState.selectedCanvasNoteId == null && !editing && !drag && !stylePreview) return;
    const selectedId = appState.selectedCanvasNoteId;
    appState.selectedCanvasNoteId = null;
    if (!commitCanvasNoteText()) {
        appState.selectedCanvasNoteId = selectedId;
        return false;
    }
    cancelDrag();
    stylePreview = null;
    appState.noteMode = false;
    appState.selectedCanvasNoteId = null;
    hideCanvasContextToolbar('canvas-note');
    syncMode();
    syncConnectionHighlight();
    renderCanvasNotes();
    if (!['replace', 'selection', 'view', 'reload', 'permission'].includes(reason)) {
        appState.canvas?.setAttribute('tabindex', '-1');
        appState.canvas?.focus({ preventScroll: true });
    }
}
export async function selectCanvasNote(id) {
    const note = findNote(id);
    if (getCurrentView()?.view_type === 'rack') {
        const textarea = el('rack-notes-area')?.querySelector(`.rack-note-editor[data-note-id="${id}"]`) ||
            el('rack-notes-area')?.querySelector(`[data-note-id="${id}"]`);
        textarea?.focus({ preventScroll: true });
        return Boolean(textarea);
    }
    if (!note || Number(note.view_id) !== Number(appState.currentViewId)) return false;
    if (Number(appState.selectedCanvasNoteId) === Number(id)) return true;
    if (!await closePanel() || !await closeLinkPanel()) return false;
    if (!commitCanvasNoteText()) return false;
    closeColorDropdown();
    cancelDrag();
    stylePreview = null;
    hideCanvasContextToolbar('canvas-note');
    finishCanvasContextToolbar('replace');
    appState.editingDeviceId = null;
    appState.editingLinkId = null;
    appState.selectedCanvasNoteId = Number(note.id);
    if (canEdit(note)) showCanvasContextToolbar('canvas-note', finishCanvasNotes);
    replaceSelectedPlacementIds([]);
    renderCanvasNotes();
    const element = appState.noteLayer?.querySelector(`[data-note-id="${note.id}"]`);
    if (element && document.activeElement !== element) {
        element.focus({ preventScroll: true });
    }
    return true;
}
export function beginCanvasNoteText(created = false) {
    if (getCurrentView()?.view_type === 'rack') return false;
    const note = selectedNote();
    if (!canEdit(note)) return false;
    if (!commitCanvasNoteText()) return false;
    const element = appState.noteLayer?.querySelector(`[data-note-id="${note.id}"]`);
    if (!element) return false;
    const textarea = document.createElement('textarea');
    textarea.className = 'canvas-note-editor';
    textarea.setAttribute('aria-label', 'メモ本文');
    textarea.setAttribute('title', 'Ctrl+Enterで確定、Escで確定してメモモードを終了');
    textarea.value = note.text;
    textarea.spellcheck = false;
    editing = { id: Number(note.id), viewId: Number(note.view_id), textarea, created };
    element.querySelector('.canvas-note-text').replaceWith(textarea);
    textarea.addEventListener('blur', commitCanvasNoteText);
    textarea.focus({ preventScroll: true });
    return true;
}
export async function createCanvasNote(event) {
    if (!appState.noteMode || !requireAdminUiAction() || !canEdit({ view_id: appState.currentViewId })) return false;
    if (getCurrentView()?.view_type === 'rack') return false;
    const point = screenToWorld(event.clientX, event.clientY);
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
    if (!commitCanvasNoteText()) return false;
    const note = { ...DEFAULT_CANVAS_NOTE, id: allocateLocalId('canvasNotes'), view_id: Number(appState.currentViewId),
        x: Math.max(0, point.x), y: Math.max(0, point.y), text: '' };
    appState.canvasNotes.push(note);
    await selectCanvasNote(note.id);
    beginCanvasNoteText(true);
    return true;
}
export function deleteCanvasNote() {
    const note = selectedNote();
    if (!canEdit(note) || !requireAdminUiAction()) return false;
    if (!window.confirm('このメモを削除しますか？')) return false;
    discardEditing();
    cancelDrag();
    appState.canvasNotes = appState.canvasNotes.filter(row => Number(row.id) !== Number(note.id));
    finishCanvasNotes();
    save();
    return true;
}
function makeTrashIcon() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    polyline.setAttribute('points', '3 6 5 6 21 6');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2');
    svg.append(polyline, path);
    return svg;
}
export function deleteRackNote(id) {
    const note = findNote(id);
    if (!note || Number(note.view_id) !== Number(appState.currentViewId)) return false;
    if (!canEdit(note) || !requireAdminUiAction()) return false;
    if (!window.confirm('このラックメモを削除しますか？')) return false;
    if (editing?.id === Number(id)) {
        discardEditing();
    } else if (editing) {
        commitCanvasNoteText();
    }
    cancelDrag();
    appState.canvasNotes = appState.canvasNotes.filter(row => Number(row.id) !== Number(id));
    renderCanvasNotes();
    save();
    return true;
}
function applyNoteStyle(element, note) {
    element.style.left = `${note.x}px`;
    element.style.top = `${note.y}px`;
    element.style.width = `${note.width}px`;
    element.style.height = `${note.height}px`;
    element.style.fontSize = `${note.font_size}px`;
    element.style.color = note.text_color;
    const color = note.background_color;
    const rgb = [1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16));
    element.style.backgroundColor = `rgba(${rgb.join(', ')}, ${note.background_opacity})`;
}
function displayed(note) {
    return { ...note, ...(drag?.id === Number(note.id) ? drag.preview : {}),
        ...(stylePreview?.id === Number(note.id) ? stylePreview.values : {}) };
}
function makeNote(note) {
    const element = document.createElement('div');
    element.className = 'canvas-note';
    element.dataset.noteId = String(note.id);
    element.tabIndex = 0;
    element.setAttribute('role', 'group');
    element.setAttribute('aria-label', 'メモ');
    const header = document.createElement('div');
    header.className = 'canvas-note-header';
    header.textContent = 'メモ';
    header.title = 'ドラッグで移動';
    const text = document.createElement('div');
    text.className = 'canvas-note-text';
    const resize = document.createElement('button');
    resize.type = 'button';
    resize.className = 'canvas-note-resize';
    resize.setAttribute('aria-label', 'メモのサイズ変更（矢印キーで調整）');
    resize.title = 'ドラッグまたは矢印キーでサイズ変更';
    resize.addEventListener('keydown', event => resizeByKey(event, Number(element.dataset.noteId)));
    element.append(header, text, resize);
    element.addEventListener('click', async event => {
        event.stopPropagation();
        if (appState.suppressNextClick) { appState.suppressNextClick = false; return; }
        if (appState.linkMode || isPlacementModeActive() || appState.floorPlanAdjustMode) return;
        await selectCanvasNote(Number(element.dataset.noteId));
    });
    element.addEventListener('dblclick', async event => {
        event.stopPropagation();
        if (appState.linkMode || isPlacementModeActive() || appState.floorPlanAdjustMode || event.target.tagName === 'TEXTAREA') return;
        if (await selectCanvasNote(Number(element.dataset.noteId))) beginCanvasNoteText();
    });
    header.addEventListener('pointerdown', event => beginDrag(event, element, false));
    resize.addEventListener('pointerdown', event => beginDrag(event, element, true));
    return element;
}
function makeRackEditor(note, region) {
    const item = document.createElement('div');
    item.className = note ? 'rack-note-item' : 'rack-note-item rack-note-item-blank';
    const textarea = document.createElement('textarea');
    textarea.className = 'rack-note-editor';
    textarea.spellcheck = false;
    textarea.setAttribute('aria-label', `${region.label}の${note ? 'メモ本文' : '新しいメモ'}`);
    textarea.setAttribute('placeholder', note ? '' : `${region.label}のメモを入力`);
    textarea.addEventListener('pointerdown', event => event.stopPropagation());
    textarea.addEventListener('click', event => event.stopPropagation());
    if (note) {
        item.dataset.noteId = String(note.id);
        textarea.dataset.noteId = String(note.id);
    }
    const begin = () => {
        const id = Number(textarea.dataset.noteId);
        const current = findNote(id);
        if (!canEdit(current) || Number(current.view_id) !== Number(appState.currentViewId)) return;
        if (editing?.textarea !== textarea && !commitCanvasNoteText()) return;
        editing = { id, viewId: Number(current.view_id), textarea, direct: true };
    };
    textarea.addEventListener('focus', begin);
    textarea.addEventListener('input', () => {
        if (!canEdit({ view_id: appState.currentViewId })) return;
        if (!textarea.dataset.noteId) {
            if (!textarea.value.trim()) return;
            if (!commitCanvasNoteText()) return;
            const created = { ...DEFAULT_CANVAS_NOTE, id: allocateLocalId('canvasNotes'),
                view_id: Number(appState.currentViewId), text: '',
                ...(region.y ? { x: RACK_NOTE_REGION_X, y: region.y } : {}) };
            appState.canvasNotes.push(created);
            item.className = 'rack-note-item';
            item.dataset.noteId = String(created.id);
            textarea.dataset.noteId = String(created.id);
            textarea.setAttribute('aria-label', `${region.label}のメモ本文`);
            textarea.setAttribute('placeholder', '');
            editing = { id: Number(created.id), viewId: Number(created.view_id), textarea, direct: true, created: true };
            appendRackNoteDeleteButton(item, textarea, region);
            renderCanvasNotes();
        } else if (editing?.textarea !== textarea) {
            begin();
        }
    });
    textarea.addEventListener('blur', () => {
        if (editing?.textarea === textarea) commitCanvasNoteText();
    });
    item.appendChild(textarea);
    if (note) appendRackNoteDeleteButton(item, textarea, region);
    return item;
}
function appendRackNoteDeleteButton(item, textarea, region) {
    if (item.querySelector('.rack-note-delete-btn')) return;
    const noteId = Number(item.dataset.noteId);
    if (!noteId) return;
    const note = findNote(noteId);
    if (!note) return;
    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'rack-note-delete-btn';
    deleteBtn.setAttribute('aria-label', `${region.label}のメモを削除`);
    deleteBtn.title = 'メモを削除';
    deleteBtn.appendChild(makeTrashIcon());
    deleteBtn.disabled = !canEdit(note);
    deleteBtn.hidden = !isCurrentUserAdmin();
    deleteBtn.addEventListener('pointerdown', event => event.stopPropagation());
    deleteBtn.addEventListener('click', event => {
        event.stopPropagation();
        deleteRackNote(Number(item.dataset.noteId || textarea.dataset.noteId));
    });
    item.appendChild(deleteBtn);
}
function renderRackNotes() {
    const host = el('rack-notes-area');
    if (!host) return;
    if (host.dataset.viewId !== String(appState.currentViewId)) {
        host.replaceChildren();
        host.dataset.viewId = String(appState.currentViewId);
    }
    let regions = host.querySelector('.rack-note-regions');
    if (!regions) {
        const heading = host.querySelector('.rack-notes-heading') || document.createElement('h3');
        heading.className = 'rack-notes-heading';
        heading.textContent = 'メモ';
        regions = document.createElement('div');
        regions.className = 'rack-note-regions';
        if (!heading.parentElement) host.appendChild(heading);
        host.appendChild(regions);
        for (const region of RACK_NOTE_REGIONS) {
            const section = document.createElement('section');
            section.className = 'rack-note-region';
            section.dataset.region = region.key;
            section.setAttribute('aria-label', `${region.label}のメモ`);
            const title = document.createElement('h4');
            title.className = 'rack-note-region-heading';
            title.textContent = region.label;
            const list = document.createElement('div');
            list.className = 'rack-note-editors';
            section.append(title, list);
            regions.appendChild(section);
        }
    }
    const existing = new Map([...host.querySelectorAll('.rack-note-item')].filter(item => item.dataset.noteId)
        .map(item => [Number(item.dataset.noteId), item]));
    const notes = getCurrentCanvasNotes();
    for (const [index, region] of RACK_NOTE_REGIONS.entries()) {
        const list = regions.children[index].querySelector('.rack-note-editors');
        for (const note of notes.filter(note => getRackNoteRegion(note).key === region.key)) {
            const id = Number(note.id);
            let item = existing.get(id);
            if (!item) {
                item = makeRackEditor(note, region);
                list.appendChild(item);
            }
            if (item.parentElement !== list) list.appendChild(item);
            existing.delete(id);
            const editor = item.querySelector('.rack-note-editor');
            if (editing?.textarea !== editor) editor.value = note.text;
            editor.readOnly = !canEdit(note);
            editor.style.fontSize = `${note.font_size}px`;
            editor.style.color = note.text_color;
            const rgb = [1, 3, 5].map(offset => parseInt(note.background_color.slice(offset, offset + 2), 16));
            editor.style.backgroundColor = `rgba(${rgb.join(', ')}, ${note.background_opacity})`;
            const deleteBtn = item.querySelector('.rack-note-delete-btn');
            if (deleteBtn) {
                deleteBtn.disabled = !canEdit(note);
                deleteBtn.hidden = !isCurrentUserAdmin();
            }
        }
        let blank = [...list.children].find(item => !item.dataset.noteId);
        if (!blank) {
            blank = makeRackEditor(null, region);
            list.appendChild(blank);
        }
        const blankEditor = blank.querySelector('.rack-note-editor') || blank;
        blankEditor.readOnly = !canEdit({ view_id: appState.currentViewId });
        blank.hidden = blankEditor.readOnly;
        blankEditor.hidden = blankEditor.readOnly;
    }
    for (const item of existing.values()) item.remove();
}
export function renderCanvasNotes() {
    const layer = appState.noteLayer;
    if (!layer) return;
    const rack = getCurrentView()?.view_type === 'rack';
    if (editing && (!findNote(editing.id) || editing.viewId !== Number(appState.currentViewId))) discardEditing();
    if (rack) {
        appState.noteMode = false;
        appState.selectedCanvasNoteId = null;
        hideCanvasContextToolbar('canvas-note');
        syncMode();
        layer.replaceChildren();
        renderRackNotes();
        return;
    }
    el('rack-notes-area')?.replaceChildren();
    const notes = getCurrentCanvasNotes();
    if (appState.selectedCanvasNoteId != null &&
        (appState.selectedPlacementIds.size > 0 || appState.editingLinkId != null || appState.floorPlanAdjustMode)) {
        finishCanvasNotes('selection');
        return;
    }
    if (editing && (!findNote(editing.id) || editing.viewId !== Number(appState.currentViewId))) discardEditing();
    if (drag && (!canEdit(findNote(drag.id)) || drag.viewId !== Number(appState.currentViewId))) cancelDrag();
    if (appState.selectedCanvasNoteId != null && !selectedNote()) {
        appState.selectedCanvasNoteId = null;
        hideCanvasContextToolbar('canvas-note');
    }
    const existing = new Map([...layer.children].map(element => [Number(element.dataset.noteId), element]));
    for (const note of notes) {
        const id = Number(note.id);
        let element = existing.get(id);
        if (!element) { element = makeNote(note); layer.appendChild(element); }
        existing.delete(id);
        const selected = id === Number(appState.selectedCanvasNoteId);
        element.classList.toggle('selected', selected);
        element.classList.toggle('read-only', !canEdit(note));
        element.querySelector('.canvas-note-resize').hidden = !selected || !canEdit(note);
        element.querySelector('.canvas-note-header').hidden = !isCurrentUserAdmin();
        const editor = element.querySelector('.canvas-note-editor');
        if (editor && editing?.id !== id) {
            const text = document.createElement('div');
            text.className = 'canvas-note-text';
            editor.replaceWith(text);
        }
        const text = element.querySelector('.canvas-note-text');
        if (text && text.textContent !== note.text) text.textContent = note.text;
        if (editing?.id === id) editing.textarea.readOnly = !canEdit(note);
        applyNoteStyle(element, displayed(note));
    }
    for (const element of existing.values()) element.remove();
    updateControls();
}
function updateControls() {
    const note = selectedNote();
    if (!note) { closeColorDropdown(); return; }
    const current = displayed(note);
    for (const [id, field] of [['note-background-color', 'background_color'], ['note-opacity', 'background_opacity'],
        ['note-font-size', 'font_size'], ['note-text-color', 'text_color']]) {
        const input = el(id);
        if (!input) continue;
        input.disabled = !canEdit(note) || Boolean(drag);
        if (input.tagName === 'BUTTON') {
            const options = [...(el(`${id}-options`)?.querySelectorAll('[data-color]') || [])];
            input.value = current[field];
            const swatch = input.querySelector('.canvas-note-color-swatch');
            if (swatch) swatch.style.backgroundColor = current[field];
            for (const option of options) {
                option.disabled = input.disabled;
                option.setAttribute('aria-checked', String(option.dataset.color === current[field]));
            }
            const selected = options.find(option => option.dataset.color === current[field]);
            const label = `${field === 'background_color' ? '背景色' : '文字色'}: ${selected?.getAttribute('aria-label') || current[field]}`;
            input.setAttribute('aria-label', label);
            input.title = label;
        } else if (document.activeElement !== input) {
            input.value = String(field === 'background_opacity' ? Math.round(current[field] * 100) : current[field]);
        }
        if (input.disabled && openColorId === id) closeColorDropdown();
    }
    if (el('note-opacity-value')) el('note-opacity-value').textContent = `${Math.round(current.background_opacity * 100)}%`;
    if (el('note-delete-btn')) el('note-delete-btn').disabled = !canEdit(note) || Boolean(drag);
}
async function beginDrag(event, element, resize) {
    if (event.button !== 0 || appState.linkMode || isPlacementModeActive() || appState.floorPlanAdjustMode) return;
    event.stopPropagation();
    const id = Number(element.dataset.noteId);
    if (!canEdit(findNote(id))) return;
    event.preventDefault();
    let ended = false;
    const pendingEnd = end => { if (end.pointerId === event.pointerId) ended = true; };
    document.addEventListener('pointerup', pendingEnd, true);
    document.addEventListener('pointercancel', pendingEnd, true);
    try {
        if (!await selectCanvasNote(id) || ended) return;
        if (!commitCanvasNoteText()) return;
        const note = findNote(id);
        if (!canEdit(note)) return;
        cancelDrag();
        const origin = screenToWorld(event.clientX, event.clientY);
        drag = { id: Number(note.id), viewId: Number(note.view_id), pointerId: event.pointerId, element, resize, origin,
            start: { x: note.x, y: note.y, width: note.width, height: note.height }, preview: {}, moved: false };
        try { element.setPointerCapture(event.pointerId); } catch { /* documentで終了まで監視する。 */ }
        renderCanvasNotes();
    } finally {
        document.removeEventListener('pointerup', pendingEnd, true);
        document.removeEventListener('pointercancel', pendingEnd, true);
    }
}
function pointerMove(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!canEdit(findNote(drag.id))) { cancelDrag(); renderCanvasNotes(); return; }
    const point = screenToWorld(event.clientX, event.clientY);
    const dx = point.x - drag.origin.x, dy = point.y - drag.origin.y;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    event.preventDefault();
    drag.moved ||= Math.abs(dx) > 0 || Math.abs(dy) > 0;
    drag.preview = drag.resize ? {
        width: clamp(drag.start.width + dx, CANVAS_NOTE_LIMITS.minWidth, CANVAS_NOTE_LIMITS.maxWidth),
        height: clamp(drag.start.height + dy, CANVAS_NOTE_LIMITS.minHeight, CANVAS_NOTE_LIMITS.maxHeight)
    } : { x: Math.max(0, drag.start.x + dx), y: Math.max(0, drag.start.y + dy) };
    renderCanvasNotes();
}
function pointerEnd(event, cancelled) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!cancelled) pointerMove(event);
    if (!drag) return;
    const previous = drag;
    cancelDrag();
    const note = findNote(previous.id);
    if (!cancelled && previous.moved && canEdit(note)) {
        Object.assign(note, previous.preview);
        suppressCanvasClickOnce();
        save();
    }
    renderCanvasNotes();
}
function resizeByKey(event, id) {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    const note = findNote(id);
    if (!canEdit(note)) return;
    event.preventDefault();
    event.stopPropagation();
    const step = event.shiftKey ? 10 : 1;
    note.width = clamp(note.width + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0),
        CANVAS_NOTE_LIMITS.minWidth, CANVAS_NOTE_LIMITS.maxWidth);
    note.height = clamp(note.height + (event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0),
        CANVAS_NOTE_LIMITS.minHeight, CANVAS_NOTE_LIMITS.maxHeight);
    save();
    renderCanvasNotes();
}
function changeStyle(field, value, commit) {
    const note = selectedNote();
    if (!canEdit(note) || drag) return;
    if (field.endsWith('_color')) {
        if (!/^#[0-9a-f]{6}$/i.test(value)) return;
        value = value.toUpperCase();
    } else {
        value = Number(value);
        if (!Number.isFinite(value)) return;
        if (field === 'background_opacity') value = clamp(value / 100, CANVAS_NOTE_LIMITS.minOpacity, CANVAS_NOTE_LIMITS.maxOpacity);
        else value = clamp(value, CANVAS_NOTE_LIMITS.minFontSize, CANVAS_NOTE_LIMITS.maxFontSize);
    }
    stylePreview = { id: Number(note.id), values: { [field]: value } };
    if (commit) {
        stylePreview = null;
        if (note[field] !== value) { note[field] = value; save(); }
    }
    renderCanvasNotes();
}
export function handleCanvasNoteKeydown(event) {
    if (openColorId) {
        if (event.key === 'Escape') {
            event.preventDefault();
            closeColorDropdown(true);
            return true;
        }
        return false;
    }
    if (event.isComposing || event.keyCode === 229) return Boolean(editing);
    if (editing && (event.target === editing.textarea || document.activeElement === editing.textarea)) {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            const id = editing.id;
            commitCanvasNoteText();
            appState.noteLayer?.querySelector(`[data-note-id="${id}"]`)?.focus();
        } else if (event.key === 'Escape') {
            event.preventDefault();
            finishCanvasNotes();
        }
        // 入力中はCtrl+K等も含めてキャンバスショートカットへ渡さない。
        return true;
    }
    if (event.key === 'Escape' && (appState.noteMode || appState.selectedCanvasNoteId != null)) {
        event.preventDefault();
        finishCanvasNotes();
        return true;
    }
    const input = [event.target, document.activeElement].some(target => target &&
        (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.getAttribute?.('role') === 'combobox' || target.isContentEditable));
    if (input || event.target?.closest?.('.canvas-note-color-control') || !selectedNote()) return false;
    if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        deleteCanvasNote();
        return true;
    }
    if (event.key === 'Enter' && !event.target?.closest?.('#canvas-context-toolbar, .canvas-note-resize')) {
        event.preventDefault(); beginCanvasNoteText(); return true;
    }
    return false;
}
export function initCanvasNotes() {
    if (initialized.has(document)) return;
    initialized.add(document);
    el('palette-note-btn')?.addEventListener('click', toggleCanvasNoteMode);
    el('note-delete-btn')?.addEventListener('click', deleteCanvasNote);
    el('note-finish-btn')?.addEventListener('click', () => finishCanvasNotes());
    initColorDropdown('note-background-color', 'background_color');
    initColorDropdown('note-text-color', 'text_color');
    for (const [id, field] of [['note-opacity', 'background_opacity'], ['note-font-size', 'font_size']]) {
        el(id)?.addEventListener('input', event => changeStyle(field, event.target.value, false));
        el(id)?.addEventListener('change', event => changeStyle(field, event.target.value, true));
    }
    document.addEventListener('pointerdown', event => {
        if (openColorId && !el(openColorId).parentElement.contains(event.target)) closeColorDropdown();
    });
    document.addEventListener('pointermove', pointerMove);
    document.addEventListener('pointerup', event => pointerEnd(event, false));
    document.addEventListener('pointercancel', event => pointerEnd(event, true));
}
eventBus.on('canvas-note:finish', () => finishCanvasNotes('view'));
eventBus.on('resources:ids-remapped', maps => {
    if (editing) editing.id = mappedResourceId(maps.canvas_notes, editing.id);
    if (drag) drag.id = mappedResourceId(maps.canvas_notes, drag.id);
    if (stylePreview) stylePreview.id = mappedResourceId(maps.canvas_notes, stylePreview.id);
    for (const element of appState.noteLayer?.children || []) {
        element.dataset.noteId = String(mappedResourceId(maps.canvas_notes, Number(element.dataset.noteId)));
    }
    for (const item of el('rack-notes-area')?.querySelectorAll('.rack-note-item') || []) {
        if (item.dataset.noteId) item.dataset.noteId = String(mappedResourceId(maps.canvas_notes, Number(item.dataset.noteId)));
    }
    for (const editor of el('rack-notes-area')?.querySelectorAll('.rack-note-editor') || []) {
        if (editor.dataset.noteId) editor.dataset.noteId = String(mappedResourceId(maps.canvas_notes, Number(editor.dataset.noteId)));
    }
    if (editing) editing.viewId = mappedResourceId(maps.views, editing.viewId);
    if (drag) drag.viewId = mappedResourceId(maps.views, drag.viewId);
    const host = el('rack-notes-area');
    if (host?.dataset.viewId) host.dataset.viewId = String(mappedResourceId(maps.views, Number(host.dataset.viewId)));
});
function discardCanvasNotes() {
    discardEditing();
    finishCanvasNotes('reload');
    renderCanvasNotes();
}
eventBus.on('resources:reloaded', discardCanvasNotes);
eventBus.on('resource:reloaded', ({ kind, id }) => {
    if (kind === 'views' && Number(id) === Number(appState.currentViewId)) discardCanvasNotes();
});
eventBus.on('resource:conflict', () => { cancelDrag(); stylePreview = null; renderCanvasNotes(); });
eventBus.on('save-state:changed', renderCanvasNotes);
eventBus.on('canvas:view-transformed', () => {
    // 次のpointer位置は、その時点のpan / zoomからワールド座標へ変換する。
    renderCanvasNotes();
});
