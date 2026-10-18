import { appState, getCurrentLinks, getCurrentPlacements, getCurrentView } from '../core/state.js';
import { render } from './renderer.js';
import { endLinkMode } from '../core/link-mode.js';
import { LINK_MANUAL_ROUTE_MAX_POINTS } from '../core/constants.js';
import { normalizeLinkRouteData } from '../core/link-route-data.js';
import { mappedResourceId } from '../core/resource-save.js';
import { hasResourceConflict, scheduleSave } from '../core/save-queue.js';
import { eventBus } from '../core/event-bus.js';
import { isCurrentUserAdmin, requireAdminUiAction } from '../ui/access-control.js';
import { markDirty } from '../ui/status-bar.js';
import { showToast, showStatusMessage } from '../ui/toast.js';
import { showCanvasContextToolbar, hideCanvasContextToolbar, initCanvasContextToolbar } from '../ui/canvas-context-toolbar.js';
import { exitPlacementMode } from '../ui/placement-mode.js';
import { syncLinkModeButton } from '../ui/toolbar-controls.js';
import { resolveTopologyLinkRoutes } from './link-route-resolver.js';
import { manualRouteFromPolyline, moveManualRouteSegment, addManualRouteDogleg, removeManualRouteBends } from './manual-link-route-edit.js';
import { suppressCanvasClickOnce } from './interaction-state.js';
import { screenToWorld } from './pan-zoom.js';
import { registerModalOpen, registerModalClose } from '../core/modal-focus.js';

let session = null;
const initializedDocuments = new WeakSet();
const initializedButtons = new WeakSet();
const el = id => document.getElementById(id);
const copy = points => points.map(point => ({ x: point.x, y: point.y }));
const redraw = () => eventBus.emit('canvas:render-links');
const currentLink = () => session && getCurrentLinks().find(link => Number(link.id) === session.linkId);
const routeStamp = link => JSON.stringify([link.route_mode ?? 'auto', link.manual_route ?? []]);
function endpointStamp(link) {
    const placements = getCurrentPlacements();
    return JSON.stringify([link.from_id, link.to_id].map(id => {
        const p = placements.find(row => Number(row.device_id) === Number(id));
        return p ? [Number(id), p.x, p.y, p.width, p.height] : null;
    }));
}
function permitted(link) {
    return Boolean(link && isCurrentUserAdmin() && !appState.authExpired && !appState.isPinging &&
        !hasResourceConflict('views', link.view_id));
}
function resolved(link) {
    const route = resolveTopologyLinkRoutes(getCurrentLinks(), getCurrentPlacements()).get(Number(link.id));
    if (!route || route.length < 2) throw new Error('接続先の機器がないため経路を編集できません');
    manualRouteFromPolyline(route);
    return copy(route);
}
function report(error) { showToast(error.message, 'warning'); }
function available(operation) {
    if (!session || session.selected == null || session.drag || !permitted(currentLink())) return false;
    try { operation(session.points, session.selected); return true; } catch { return false; }
}
function setControlReason(id, reason) {
    const button = el(id);
    if (!button) return;
    button.disabled = reason !== '';
    button.setAttribute('aria-disabled', String(button.disabled));
    if (reason) button.title = reason;
    else button.removeAttribute('title');
}
function updateControls() {
    if (typeof document === 'undefined') return;
    const selected = getCurrentLinks().find(link => Number(link.id) === Number(appState.editingLinkId));
    const reason = !isCurrentUserAdmin() ? '管理者権限が必要です'
        : appState.authExpired ? '認証が失効しています'
        : appState.isPinging ? 'Pingの完了を待ってください'
        : appState.floorPlanAdjustMode ? '図面調整を終了してください'
        : !selected || !getCurrentView() ? '表示中の接続を選択してください'
        : hasResourceConflict('views', selected.view_id) ? '競合しているビューを再読込してください' : '';
    setControlReason('lp-route-edit-btn', reason);
    const operationReason = !session ? '経路調整を開始してください'
        : session.drag ? 'ドラッグを確定または中止してください'
        : session.selected == null ? '区間を選択してください' : reason;
    setControlReason('link-route-add-btn', available(addManualRouteDogleg) ? '' :
        operationReason || `折れ追加は${LINK_MANUAL_ROUTE_MAX_POINTS - 2}点以下の経路で行えます`);
    setControlReason('link-route-remove-btn', available(removeManualRouteBends) ? '' :
        operationReason || '直交性を保って削除できる折れがありません');
    setControlReason('lp-route-auto-btn', reason ||
        (selected?.route_mode !== 'manual' ? 'すでに自動経路です' : ''));
}
function cancelPreview() {
    if (!session?.drag) return;
    const drag = session.drag;
    session.drag = null;
    if (drag.svg.hasPointerCapture?.(drag.pointerId)) drag.svg.releasePointerCapture(drag.pointerId);
    session.points = drag.points;
    updateControls();
    redraw();
}
export function finishLinkRouteEdit(reason = 'finish') {
    if (!session) return;
    const { svg, drag } = session;
    session = null;
    if (drag?.svg.hasPointerCapture?.(drag.pointerId)) drag.svg.releasePointerCapture(drag.pointerId);
    svg?.setAttribute('aria-hidden', 'true');
    hideCanvasContextToolbar('link-route');
    updateControls();
    redraw();
    if (reason !== 'replace' && reason !== 'selection' && reason !== 'view') {
        const button = el('lp-route-edit-btn');
        if (button && !button.disabled && !button.hidden && !el('link-panel')?.hidden) button.focus();
        else {
            appState.canvas?.setAttribute('tabindex', '-1');
            appState.canvas?.focus({ preventScroll: true });
        }
    }
}
export function syncLinkRouteEditor() {
    if (session) {
        const link = currentLink();
        const placements = getCurrentPlacements();
        const endpointsPresent = link && [link.from_id, link.to_id].every(id => placements.some(p => Number(p.device_id) === Number(id)));
        if (Number(appState.currentViewId) !== session.viewId || !getCurrentView()) finishLinkRouteEdit('view');
        else if (!link || Number(appState.editingLinkId) !== session.linkId || !endpointsPresent) finishLinkRouteEdit('selection');
        else if (!permitted(link)) finishLinkRouteEdit('permission');
        else if (routeStamp(link) !== session.routeStamp || endpointStamp(link) !== session.endpointStamp) finishLinkRouteEdit('external-change');
    }
    updateControls();
}
function commit(points) {
    syncLinkRouteEditor();
    if (!session) return false;
    const link = currentLink();
    if (!permitted(link) || !requireAdminUiAction()) return false;
    const manual = manualRouteFromPolyline(points);
    const candidate = { ...link, route_mode: 'manual', manual_route: manual };
    const nextPoints = resolveTopologyLinkRoutes(
        getCurrentLinks().map(row => row === link ? candidate : row), getCurrentPlacements()
    ).get(session.linkId);
    if (!nextPoints) throw new Error('経路の接続先がありません');
    manualRouteFromPolyline(nextPoints);
    // 保存応答でオブジェクトが置換されるため、確定時に現在のIDから検索する。
    link.route_mode = 'manual';
    link.manual_route = manual;
    session.routeStamp = routeStamp(link);
    session.points = copy(nextPoints);
    if (session.selected != null) session.selected = Math.min(session.selected, session.points.length - 2);
    markDirty();
    scheduleSave({ immediate: true, silent: true });
    updateControls();
    redraw();
    return true;
}
export function startLinkRouteEdit() {
    if (!requireAdminUiAction()) return;
    if (appState.floorPlanAdjustMode) {
        showToast('図面調整を終了してから経路を編集してください', 'warning');
        return;
    }
    const link = getCurrentLinks().find(row => Number(row.id) === Number(appState.editingLinkId));
    if (!permitted(link) || !getCurrentView()) {
        showToast('表示中のビューで競合していない接続を選択してください', 'warning');
        return;
    }
    if (session?.linkId === Number(link.id) && session.viewId === Number(link.view_id)) { syncLinkRouteEditor(); return; }
    try {
        const data = normalizeLinkRouteData(link);
        const points = resolved(link);
        eventBus.emit('canvas-note:finish');
        exitPlacementMode();
        endLinkMode();
        syncLinkModeButton();
        render();
        finishLinkRouteEdit('replace');
        showCanvasContextToolbar('link-route', finishLinkRouteEdit);
        session = { linkId: Number(link.id), viewId: Number(link.view_id), points, selected: null,
            routeStamp: routeStamp(link), endpointStamp: endpointStamp(link), drag: null, svg: appState.currentSvg, focusIndex: null };
        if (data.route_mode === 'auto') {
            commit(points);
            showStatusMessage('自動経路を手動経路に切り替えました。変更は自動保存されます。斜線は直交化します');
        }
        updateControls();
        redraw();
    } catch (error) { report(error); }
}
export function getLinkRoutePreview() {
    return session?.drag ? { linkId: session.linkId, points: copy(session.points) } : null;
}
function transform(operation) {
    syncLinkRouteEditor();
    if (!session || session.selected == null || session.drag) return;
    try { commit(operation(session.points, session.selected)); } catch (error) { report(error); }
}
function returnToAuto() {
    syncLinkRouteEditor();
    const link = getCurrentLinks().find(row => Number(row.id) === Number(appState.editingLinkId));
    if (!permitted(link) || !getCurrentView() || appState.floorPlanAdjustMode ||
        link.route_mode !== 'manual' || !requireAdminUiAction()) return;
    if (!window.confirm('手動経路を破棄して自動経路へ戻しますか？')) return;
    cancelPreview();
    link.route_mode = 'auto';
    link.manual_route = [];
    markDirty();
    scheduleSave({ immediate: true, silent: true });
    if (session) finishLinkRouteEdit();
    else {
        updateControls();
        redraw();
    }
}
function pointerMove(event) {
    if (!session?.drag || event.pointerId !== session.drag.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    syncLinkRouteEditor();
    if (!session?.drag) return;
    const drag = session.drag;
    const point = screenToWorld(event.clientX, event.clientY);
    const axis = drag.horizontal ? 'y' : 'x';
    const delta = point[axis] - drag.origin[axis];
    try {
        session.points = moveManualRouteSegment(drag.points, drag.index, delta);
        drag.changed = delta !== 0;
        updateControls();
        redraw();
    } catch (error) { cancelPreview(); report(error); }
}
function pointerEnd(event, cancelled) {
    if (!session?.drag || event.pointerId !== session.drag.pointerId) return;
    event.preventDefault();
    // SVG rootへ届く合成clickだけを抑え、clickが発生しなくても次の操作まで残さない。
    if (!cancelled) suppressCanvasClickOnce();
    const points = copy(session.points), changed = session.drag.changed;
    cancelPreview();
    if (!cancelled && changed) {
        try { commit(points); } catch (error) { report(error); }
    }
}
function openLinkRouteHelp() {
    const overlay = el('link-route-help-overlay');
    if (!overlay || !overlay.hidden) return;
    cancelPreview();
    overlay.hidden = false;
    registerModalOpen('link_route_help', overlay, el('link-route-help-close-btn'), { onClose: closeLinkRouteHelp });
}
export function closeLinkRouteHelp() {
    const overlay = el('link-route-help-overlay');
    if (!overlay || overlay.hidden) return;
    overlay.hidden = true;
    registerModalClose('link_route_help');
}
export function initLinkRouteEditor() {
    initCanvasContextToolbar();
    for (const [id, action] of [
        ['lp-route-edit-btn', startLinkRouteEdit], ['link-route-add-btn', () => transform(addManualRouteDogleg)],
        ['link-route-remove-btn', () => transform(removeManualRouteBends)], ['lp-route-auto-btn', returnToAuto],
        ['link-route-finish-btn', () => finishLinkRouteEdit()],
        ['lp-route-help-btn', openLinkRouteHelp],
        ['link-route-help-close-btn', closeLinkRouteHelp]
    ]) {
        const button = el(id);
        if (button && !initializedButtons.has(button)) {
            initializedButtons.add(button);
            button.addEventListener('click', event => { event.stopPropagation(); action(); });
        }
    }
    if (!initializedDocuments.has(document)) {
        initializedDocuments.add(document);
        document.addEventListener('pointermove', pointerMove, true);
        document.addEventListener('pointerup', event => pointerEnd(event, false), true);
        document.addEventListener('pointercancel', event => pointerEnd(event, true), true);
        document.addEventListener('focusin', event => {
            if (session && event.target?.dataset?.routeSegment == null) session.focusIndex = null;
        });
    }
    updateControls();
}
eventBus.on('link-route:selection-changed', syncLinkRouteEditor);
eventBus.on('resources:reloaded', () => finishLinkRouteEdit('reload'));
eventBus.on('resource:reloaded', ({ kind, id }) => {
    if (session && kind === 'views' && Number(id) === session.viewId) finishLinkRouteEdit('reload');
    else updateControls();
});
eventBus.on('resource:conflict', syncLinkRouteEditor);
eventBus.on('save-state:changed', syncLinkRouteEditor);
eventBus.on('resources:ids-remapped', maps => {
    if (!session) return;
    session.viewId = mappedResourceId(maps.views, session.viewId);
    session.linkId = mappedResourceId(maps.links, session.linkId);
    // ID再採番だけでは端点の外部移動として扱わない。
    const stamp = JSON.parse(session.endpointStamp);
    session.endpointStamp = JSON.stringify(stamp.map(p => p && [mappedResourceId(maps.devices, p[0]), ...p.slice(1)]));
    syncLinkRouteEditor();
});

export function renderLinkRouteEditor(svg, routeMap) {
    svg.setAttribute('aria-hidden', session ? 'false' : 'true');
    if (!session) return;
    session.svg = svg;
    const points = session.drag ? session.points : routeMap.get(session.linkId);
    if (!points || points.length < 2) return;
    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    const renderedSession = session;
    group.setAttribute('class', 'link-route-editor');
    const focusedIndex = document.activeElement?.dataset?.routeSegment;
    if (focusedIndex != null) session.focusIndex = Number(focusedIndex);
    for (let index = 0; index < points.length - 1; index++) {
        const a = points[index], b = points[index + 1], horizontal = a.y === b.y;
        const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        hit.setAttribute('d', `M ${a.x} ${a.y} L ${b.x} ${b.y}`);
        hit.setAttribute('class', `link-route-segment${session.selected === index ? ' is-selected' : ''}`);
        hit.setAttribute('role', 'button'); hit.setAttribute('tabindex', '0');
        hit.setAttribute('aria-label', `区間${index + 1}・${horizontal ? '水平、上下' : '垂直、左右'}に移動。Shiftで10座標`);
        hit.setAttribute('aria-pressed', session.selected === index ? 'true' : 'false');
        hit.setAttribute('aria-describedby', 'link-route-help');
        hit.dataset.routeSegment = String(index);
        const select = () => { if (session !== renderedSession) return; session.selected = index; session.focusIndex = index; updateControls(); };
        hit.addEventListener('focus', select);
        hit.addEventListener('click', event => { event.stopPropagation(); if (session !== renderedSession) return; select(); redraw(); });
        const beginDrag = event => {
            event.stopPropagation(); event.preventDefault();
            if (event.button !== 0 || session !== renderedSession || session.drag || !permitted(currentLink()) || !requireAdminUiAction()) return;
            select(); hit.focus();
            session.drag = { pointerId: event.pointerId, points: copy(session.points), index, horizontal,
                origin: screenToWorld(event.clientX, event.clientY), svg, changed: false };
            try { svg.setPointerCapture?.(event.pointerId); } catch { /* document側の終端処理へ任せる。 */ }
            updateControls(); redraw();
        };
        hit.addEventListener('pointerdown', beginDrag);
        hit.addEventListener('keydown', event => {
            event.stopPropagation();
            if (session !== renderedSession) return;
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(); redraw(); return; }
            const axisKeys = horizontal ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight'];
            if (!axisKeys.includes(event.key)) return;
            event.preventDefault(); select();
            const delta = (event.key === axisKeys[0] ? -1 : 1) * (event.shiftKey ? 10 : 1);
            transform((route, selected) => moveManualRouteSegment(route, selected, delta));
        });
        group.appendChild(hit);
        const handle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        handle.setAttribute('cx', a.x / 2 + b.x / 2); handle.setAttribute('cy', a.y / 2 + b.y / 2);
        handle.setAttribute('r', '5');
        handle.setAttribute('class', `link-route-handle${session.selected === index ? ' is-selected' : ''}`);
        handle.setAttribute('aria-hidden', 'true');
        handle.addEventListener('pointerdown', beginDrag);
        handle.addEventListener('click', event => {
            event.stopPropagation();
            if (session !== renderedSession) return;
            select(); hit.focus(); redraw();
        });
        group.appendChild(handle);
    }
    for (const type of ['dblclick', 'contextmenu']) group.addEventListener(type, event => event.stopPropagation());
    svg.appendChild(group);
    if (session.focusIndex != null && !session.drag) {
        group.querySelector(`[data-route-segment="${session.focusIndex}"]`)?.focus({ preventScroll: true });
    }
}
