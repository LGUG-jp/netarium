/**
 * Netarium - canvas/pan-zoom.js
 */

import {
    DEFAULT_VIEW_PAN_X,
    DEFAULT_VIEW_PAN_Y,
    DEFAULT_VIEW_SCALE
} from '../core/constants.js';

import {
    appState,
    getCurrentFloorPlan,
    getCurrentPlacements,
    getCurrentView
} from '../core/state.js';
import { fitViewToDevices } from './renderer.js';
import { calculateLinkRouteMidpoint } from './link-router.js';
import {
    clampNumber
} from '../core/utils.js';
import { eventBus } from '../core/event-bus.js';

export function applyViewTransform() {
    if (!appState.world) {
        return;
    }

    appState.world.style.transform =
        `translate(${appState.viewState.panX}px, ${appState.viewState.panY}px) ` +
        `scale(${appState.viewState.scale})`;
    const rackContent = document.getElementById('rack-content');
    if (getCurrentView()?.view_type === 'rack' && rackContent) {
        rackContent.style.zoom = String(appState.viewState.scale / DEFAULT_VIEW_SCALE);
    }

    const zoomLabel =
        document.getElementById('zoom-label');

    if (zoomLabel) {
        const displayPercent = Math.round(
            (appState.viewState.scale / DEFAULT_VIEW_SCALE) * 100
        );
        zoomLabel.textContent =
            `${displayPercent}%`;
    }

    if (appState.currentViewId !== null) {
        appState.viewStates.set(Number(appState.currentViewId), {
            scale: appState.viewState.scale,
            panX: appState.viewState.panX,
            panY: appState.viewState.panY
        });
    }
    eventBus.emit('canvas:view-transformed');
}


export function setScaleAtClientPoint(
    requestedScale,
    clientX,
    clientY
) {
    if (!appState.canvas) {
        return;
    }

    const newScale = clampNumber(
        requestedScale,
        appState.viewState.minScale,
        appState.viewState.maxScale
    );

    if (
        Math.abs(newScale - appState.viewState.scale) <
        0.0001
    ) {
        return;
    }
    if (getCurrentView()?.view_type === 'rack') {
        const content = document.getElementById('rack-content');
        const before = content?.getBoundingClientRect();
        const previousRatio = appState.viewState.scale / DEFAULT_VIEW_SCALE;
        appState.viewState.scale = newScale;
        applyViewTransform();
        if (before && content) {
            const after = content.getBoundingClientRect();
            const ratio = newScale / DEFAULT_VIEW_SCALE;
            appState.canvas.scrollLeft += after.left + (clientX - before.left) / previousRatio * ratio - clientX;
            appState.canvas.scrollTop += after.top + (clientY - before.top) / previousRatio * ratio - clientY;
        }
        return;
    }

    const rect = appState.canvas.getBoundingClientRect();

    const canvasX = clientX - rect.left;
    const canvasY = clientY - rect.top;

    const worldX =
        (canvasX - appState.viewState.panX) /
        appState.viewState.scale;

    const worldY =
        (canvasY - appState.viewState.panY) /
        appState.viewState.scale;

    appState.viewState.scale = newScale;

    appState.viewState.panX =
        canvasX - worldX * newScale;

    appState.viewState.panY =
        canvasY - worldY * newScale;

    applyViewTransform();
}


export function onCanvasWheel(event) {
    event.preventDefault();

    const factor =
        event.deltaY < 0
            ? 1.1
            : 1 / 1.1;

    setScaleAtClientPoint(
        appState.viewState.scale * factor,
        event.clientX,
        event.clientY
    );
}


export function zoomAtCanvasCenter(factor) {
    if (!appState.canvas) {
        return;
    }

    const rect = appState.canvas.getBoundingClientRect();

    setScaleAtClientPoint(
        appState.viewState.scale * factor,
        rect.left + rect.width / 2,
        rect.top + rect.height / 2
    );
}



function getCanvasVisibleRect() {
    const canvasRect = appState.canvas.getBoundingClientRect();
    let visibleLeft = 0;
    let visibleRight = canvasRect.width;

    if (typeof document !== 'undefined') {
        const navPanel = document.getElementById('workspace-nav-panel');
        if (navPanel && !navPanel.hidden && !navPanel.classList.contains('hidden')) {
            const navRect = navPanel.getBoundingClientRect();
            if (navRect.right > canvasRect.left && navRect.right < canvasRect.right) {
                visibleLeft = Math.max(visibleLeft, navRect.right - canvasRect.left);
            }
        }

        const panel = document.getElementById('panel');
        if (panel && !panel.hidden && !panel.classList.contains('hidden')) {
            const panelRect = panel.getBoundingClientRect();
            if (panelRect.left > canvasRect.left && panelRect.left < canvasRect.right) {
                visibleRight = Math.min(visibleRight, panelRect.left - canvasRect.left);
            }
        }

        const linkPanel = document.getElementById('link-panel');
        if (linkPanel && !linkPanel.hidden && !linkPanel.classList.contains('hidden')) {
            const linkPanelRect = linkPanel.getBoundingClientRect();
            if (linkPanelRect.left > canvasRect.left && linkPanelRect.left < canvasRect.right) {
                visibleRight = Math.min(visibleRight, linkPanelRect.left - canvasRect.left);
            }
        }
    }

    if (visibleRight <= visibleLeft) {
        visibleLeft = 0;
        visibleRight = canvasRect.width;
    }

    return { left: visibleLeft, right: visibleRight, top: 0, bottom: canvasRect.height };
}

export function getCanvasVisibleCenter() {
    if (!appState.canvas) return { x: 400, y: 300 };
    const rect = getCanvasVisibleRect();
    return { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 };
}

// 線分そのものとの交差を判定する。経路の外接矩形だけでは、画面を迂回する経路を誤認する。
function segmentIntersectsRect(start, end, rect) {
    let from = 0;
    let to = 1;
    for (const [axis, min, max] of [['x', rect.left, rect.right], ['y', rect.top, rect.bottom]]) {
        const delta = end[axis] - start[axis];
        if (delta === 0) {
            if (start[axis] < min || start[axis] > max) return false;
            continue;
        }
        const first = (min - start[axis]) / delta;
        const last = (max - start[axis]) / delta;
        from = Math.max(from, Math.min(first, last));
        to = Math.min(to, Math.max(first, last));
        if (from > to) return false;
    }
    return true;
}

/** 見えている経路は動かさず、隠れた経路だけを倍率維持・即時パンで可視化する。 */
export function revealCanvasLinkRoute(route) {
    if (!appState.canvas || !route || route.length < 2) return;
    const visible = getCanvasVisibleRect();
    if (visible.right <= visible.left || visible.bottom <= visible.top) return;
    const { scale, panX, panY } = appState.viewState;
    const worldRect = {
        left: (visible.left - panX) / scale,
        right: (visible.right - panX) / scale,
        top: (visible.top - panY) / scale,
        bottom: (visible.bottom - panY) / scale
    };
    for (let index = 1; index < route.length; index++) {
        if (segmentIntersectsRect(route[index - 1], route[index], worldRect)) return;
    }
    const midpoint = calculateLinkRouteMidpoint(route);
    if (!midpoint) return;
    appState.viewState.panX = (visible.left + visible.right) / 2 - midpoint.x * scale;
    appState.viewState.panY = (visible.top + visible.bottom) / 2 - midpoint.y * scale;
    applyViewTransform();
}

export function resetView() {
    appState.viewState.scale = DEFAULT_VIEW_SCALE;
    appState.viewState.panX = DEFAULT_VIEW_PAN_X;
    appState.viewState.panY = DEFAULT_VIEW_PAN_Y;

    if (getCurrentView()?.view_type === 'rack' && appState.canvas) {
        appState.canvas.scrollLeft = 0;
        appState.canvas.scrollTop = 0;
    }
    applyViewTransform();
}


export function saveCurrentViewState() {
    if (appState.currentViewId === null) {
        return;
    }

    appState.viewStates.set(Number(appState.currentViewId), {
        scale: appState.viewState.scale,
        panX: appState.viewState.panX,
        panY: appState.viewState.panY
    });
}


export function restoreCurrentViewState() {
    const saved = appState.currentViewId === null
        ? null
        : appState.viewStates.get(Number(appState.currentViewId));

    if (!saved) {
        const currentView = getCurrentView();
        const currentFloorPlan = getCurrentFloorPlan();
        if (currentView?.view_type === 'rack') { resetView(); return; }

        if (
            currentView?.view_type === 'floor' &&
            currentFloorPlan &&
            currentFloorPlan.is_visible
        ) {
            fitViewToDevices();
            return;
        }

        const currentPlacements = getCurrentPlacements();
        const hasNotes = (appState.canvasNotes || []).some(note => Number(note.view_id) === Number(appState.currentViewId));
        if (currentPlacements.length > 0 || hasNotes) {
            fitViewToDevices();
            return;
        }

        resetView();
        return;
    }

    appState.viewState.scale = clampNumber(
        Number(saved.scale) || DEFAULT_VIEW_SCALE,
        appState.viewState.minScale,
        appState.viewState.maxScale
    );
    appState.viewState.panX =
        Number(saved.panX) || 0;

    appState.viewState.panY =
        Number(saved.panY) || 0;

    applyViewTransform();
}



export function screenToWorld(clientX, clientY) {
    const rect = appState.canvas.getBoundingClientRect();

    return {
        x:
            (
                clientX -
                rect.left -
                appState.viewState.panX
            ) / appState.viewState.scale,

        y:
            (
                clientY -
                rect.top -
                appState.viewState.panY
            ) / appState.viewState.scale
    };
}

/**
 * キャンバス空白部分のポインター操作。
 *
 * Shift+ドラッグは矩形選択、
 * 通常ドラッグはパンとして処理する。
 */

/**
 * クライアント座標を、
 * キャンバス左上基準の座標へ変換する。
 */
export function getCanvasLocalPoint(
    clientX,
    clientY
) {
    const rect =
        appState.canvas.getBoundingClientRect();

    return {
        x:
            clampNumber(
                clientX - rect.left,
                0,
                rect.width
            ),

        y:
            clampNumber(
                clientY - rect.top,
                0,
                rect.height
            )
    };
}


/**
 * 2点から、方向に依存しない矩形を作る。
 */

