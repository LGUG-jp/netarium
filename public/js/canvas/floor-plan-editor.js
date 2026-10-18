import { appState } from '../core/state.js';
import { hasResourceConflict } from '../core/save-queue.js';
import { isCurrentUserAdmin } from '../ui/access-control.js';
import { eventBus } from '../core/event-bus.js';
import { screenToWorld } from './pan-zoom.js';
import { suppressCanvasClickOnce } from './interaction-state.js';

const LIMIT = 100000;
const CORNERS = ['nw', 'ne', 'se', 'sw'];
const LABELS = { nw: '左上', ne: '右上', se: '右下', sw: '左下' };
const ARROWS = new Set(['ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft']);
const HELP = '矢印キーで1移動、Shiftで10移動。四隅は矢印キーで倍率0.01変更、Shiftで0.1変更。上・右で拡大、下・左で縮小。Escapeで操作を取り消します。';
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const snapshot = plan => ({ x: Number(plan.x), y: Number(plan.y), scale: Number(plan.scale) });
let editor = null;
let gesture = null;
const documents = new WeakSet();

function dimensions(plan) {
    const width = Number(plan.image_width), height = Number(plan.image_height);
    if (!(width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height))) {
        throw new RangeError('図面の元画像サイズが必要です');
    }
    return { width, height };
}
function cornerGeometry(plan, corner) {
    if (!CORNERS.includes(corner)) throw new RangeError('図面の四隅を指定してください');
    const { width, height } = dimensions(plan);
    const west = corner.endsWith('w'), north = corner.startsWith('n');
    return { width, height, west, north,
        anchorX: Number(plan.x) + (west ? width * plan.scale : 0),
        anchorY: Number(plan.y) + (north ? height * plan.scale : 0) };
}

// 対角を固定したまま、倍率と左上座標の両方の制約を満たす区間へ射影する。
export function scaleFloorPlanFromCorner(plan, corner, requestedScale) {
    const g = cornerGeometry(plan, corner);
    let min = 0.05, max = 2;
    if (g.west) {
        min = Math.max(min, (g.anchorX - LIMIT) / g.width);
        max = Math.min(max, (g.anchorX + LIMIT) / g.width);
    }
    if (g.north) {
        min = Math.max(min, (g.anchorY - LIMIT) / g.height);
        max = Math.min(max, (g.anchorY + LIMIT) / g.height);
    }
    const scale = clamp(requestedScale, min, max);
    return { x: g.west ? g.anchorX - g.width * scale : g.anchorX,
        y: g.north ? g.anchorY - g.height * scale : g.anchorY, scale };
}
export function resizeFloorPlanFromCorner(plan, corner, point) {
    const g = cornerGeometry(plan, corner);
    const dx = (point.x - g.anchorX) * (g.west ? -1 : 1);
    const dy = (point.y - g.anchorY) * (g.north ? -1 : 1);
    // 同じ縦横比の対角線に最短距離で投影。元画像寸法には上限を設けない。
    const ratio = g.height / g.width;
    const scale = (dx / g.width + (dy / g.width) * ratio) / (1 + ratio * ratio);
    return scaleFloorPlanFromCorner(plan, corner, scale);
}
export function moveFloorPlan(plan, dx, dy) {
    return { x: clamp(Number(plan.x) + dx, -LIMIT, LIMIT),
        y: clamp(Number(plan.y) + dy, -LIMIT, LIMIT), scale: Number(plan.scale) };
}
function permitted() {
    return Boolean(editor && appState.floorPlanAdjustMode && isCurrentUserAdmin() &&
        !appState.authExpired && !appState.isPinging && !appState.isFloorPlanUpdating &&
        Number(appState.currentViewId) === Number(editor.plan.view_id) &&
        !hasResourceConflict('views', editor.plan.view_id));
}
function preview(values) {
    if (!editor) return;
    Object.assign(editor.plan, values);
    editor.onPreview?.(editor.plan);
    updateFloorPlanEditor(editor.plan);
}
export function updateFloorPlanEditor(floorPlan = editor?.plan) {
    if (!editor || !floorPlan || Number(floorPlan.view_id) !== Number(editor.plan.view_id)) return;
    const { width, height } = dimensions(floorPlan);
    const zoom = appState.viewState.scale;
    Object.assign(editor.frame.style, { left: `${floorPlan.x}px`, top: `${floorPlan.y}px`,
        width: `${width * floorPlan.scale * zoom}px`, height: `${height * floorPlan.scale * zoom}px`,
        transform: `scale(${1 / zoom})` });
    editor.frame.hidden = !appState.floorPlanAdjustMode;
    for (const handle of editor.handles) {
        const corner = handle.dataset.floorPlanCorner;
        handle.style.left = corner.endsWith('w') ? '0%' : '100%';
        handle.style.top = corner.startsWith('n') ? '0%' : '100%';
        handle.style.right = 'auto';
        handle.style.bottom = 'auto';
    }
}
export function finishFloorPlanGesture({ commit = false } = {}) {
    if (!gesture) return false;
    const pending = gesture;
    gesture = null;
    const allowed = permitted();
    const changed = ['x', 'y', 'scale'].some(key => editor.plan[key] !== pending.before[key]);
    if (!commit || !allowed) preview(pending.before);
    if (pending.pointerId != null && pending.target.hasPointerCapture?.(pending.pointerId)) {
        pending.target.releasePointerCapture(pending.pointerId);
    }
    if (commit && allowed && changed) editor.onCommit?.(editor.plan);
    return true;
}
export function cancelFloorPlanGesture() {
    return finishFloorPlanGesture();
}
function consume(event) {
    event.preventDefault();
    event.stopPropagation();
}
function startPointer(event, corner, target) {
    if (!permitted() || gesture || event.button !== 0 || event.isPrimary === false) return;
    consume(event);
    target.focus({ preventScroll: true });
    gesture = { before: snapshot(editor.plan), origin: screenToWorld(event.clientX, event.clientY),
        corner, pointerId: event.pointerId, target };
    try { target.setPointerCapture(event.pointerId); }
    catch { cancelFloorPlanGesture(); }
}
function pointerMove(event) {
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    consume(event);
    if (!permitted() || !gesture.target.isConnected) { cancelFloorPlanGesture(); return; }
    const point = screenToWorld(event.clientX, event.clientY);
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    const base = { ...editor.plan, ...gesture.before };
    const dx = point.x - gesture.origin.x, dy = point.y - gesture.origin.y;
    const cornerPoint = gesture.corner ? {
        x: base.x + (gesture.corner.endsWith('w') ? 0 : base.image_width * base.scale) + dx,
        y: base.y + (gesture.corner.startsWith('n') ? 0 : base.image_height * base.scale) + dy
    } : null;
    preview(gesture.corner ? resizeFloorPlanFromCorner(base, gesture.corner, cornerPoint)
        : moveFloorPlan(base, dx, dy));
}
function pointerEnd(event, commit) {
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    consume(event);
    if (commit) {
        pointerMove(event);
        suppressCanvasClickOnce();
    }
    finishFloorPlanGesture({ commit });
}
export function handleFloorPlanEditorKeydown(event) {
    if (event.key === 'Escape' && gesture) {
        consume(event);
        cancelFloorPlanGesture();
        return true;
    }
    const target = event.target;
    const corner = editor?.handles.find(handle => handle === target)?.dataset.floorPlanCorner;
    if (!editor || (target !== editor.image && !corner) || !ARROWS.has(event.key) ||
        event.ctrlKey || event.altKey || event.metaKey || !permitted() || gesture?.pointerId != null) return false;
    consume(event);
    if (!gesture) gesture = { before: snapshot(editor.plan), target, keys: new Set() };
    gesture.keys.add(event.key);
    const increasing = event.key === 'ArrowUp' || event.key === 'ArrowRight';
    if (corner) preview(scaleFloorPlanFromCorner(editor.plan, corner,
        editor.plan.scale + (increasing ? 1 : -1) * (event.shiftKey ? 0.1 : 0.01)));
    else {
        const step = event.shiftKey ? 10 : 1;
        preview(moveFloorPlan(editor.plan,
            event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0,
            event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0));
    }
    return true;
}
function initializeDocument(doc) {
    if (documents.has(doc)) return;
    documents.add(doc);
    doc.addEventListener('focusin', event => {
        if (!editor || event.target === editor.image || editor.handles.includes(event.target)) return;
        if (event.target !== doc.body) editor.focusKey = null;
    });
    doc.addEventListener('keydown', event => {
        if (event.key === 'Escape' && handleFloorPlanEditorKeydown(event)) event.stopImmediatePropagation();
    }, true);
    doc.addEventListener('keyup', event => {
        if (!gesture?.keys?.has(event.key)) return;
        consume(event);
        gesture.keys.delete(event.key);
        if (!gesture.keys.size) finishFloorPlanGesture({ commit: true });
    }, true);
    doc.defaultView?.addEventListener('blur', () => {
        finishFloorPlanGesture({ commit: gesture?.pointerId == null });
    });
}
function bindTarget(target, corner = null) {
    target.addEventListener('pointerdown', event => startPointer(event, corner, target));
    target.addEventListener('pointermove', pointerMove);
    target.addEventListener('pointerup', event => pointerEnd(event, true));
    target.addEventListener('pointercancel', event => pointerEnd(event, false));
    target.addEventListener('lostpointercapture', event => pointerEnd(event, false));
    target.addEventListener('keydown', handleFloorPlanEditorKeydown);
    target.addEventListener('focus', () => {
        if (editor && (editor.image === target || editor.handles.includes(target))) {
            editor.focusKey = corner || 'image';
        }
    });
    target.addEventListener('blur', () => {
        if (gesture?.keys && gesture.target === target) finishFloorPlanGesture({ commit: true });
    });
}
export function attachFloorPlanEditor(image, floorPlan, { onPreview, onCommit } = {}) {
    const doc = image.ownerDocument || document;
    const focused = editor && (doc.activeElement === editor.image ? 'image'
        : editor.handles.find(handle => doc.activeElement === handle)?.dataset.floorPlanCorner
            || (!editor.image.isConnected ? editor.focusKey : null));
    cancelFloorPlanGesture();
    editor?.frame.remove();
    const frame = doc.createElement('div');
    frame.className = 'floor-plan-editor-frame';
    const handles = CORNERS.map(corner => {
        const handle = doc.createElement('button');
        handle.type = 'button';
        handle.className = `floor-plan-editor-handle floor-plan-editor-${corner}`;
        handle.dataset.floorPlanCorner = corner;
        handle.setAttribute('aria-label', `図面の${LABELS[corner]}を拡大・縮小`);
        handle.setAttribute('aria-description', HELP);
        handle.title = `${LABELS[corner]}: ${HELP}`;
        frame.appendChild(handle);
        bindTarget(handle, corner);
        return handle;
    });
    editor = { image, plan: floorPlan, frame, handles, onPreview, onCommit };
    image.tabIndex = 0;
    image.setAttribute('aria-label', 'フロア図面を移動');
    image.setAttribute('aria-description', HELP);
    image.title = HELP;
    bindTarget(image);
    appState.floorPlanLayer.appendChild(frame);
    initializeDocument(doc);
    updateFloorPlanEditor(floorPlan);
    // 親がappendする前にも呼べる。画像のフォーカス復元だけは接続後に行う。
    if (focused) queueMicrotask(() => {
        if (editor?.image !== image || !appState.floorPlanAdjustMode) return;
        const target = focused === 'image' ? image : handles.find(handle => handle.dataset.floorPlanCorner === focused);
        if (target?.isConnected && (doc.activeElement === doc.body || !doc.activeElement?.isConnected)) {
            target.focus({ preventScroll: true });
        }
    });
}
eventBus.on('canvas:view-transformed', () => updateFloorPlanEditor());
eventBus.on('canvas:render-complete', () => {
    if (gesture && (!permitted() || !gesture.target.isConnected)) cancelFloorPlanGesture();
    updateFloorPlanEditor();
});
eventBus.on('resources:reloaded', cancelFloorPlanGesture);
eventBus.on('resource:reloaded', ({ kind, id }) => {
    if (kind === 'views' && Number(id) === Number(editor?.plan.view_id)) cancelFloorPlanGesture();
});
