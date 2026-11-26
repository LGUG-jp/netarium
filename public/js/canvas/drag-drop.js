/**
 * Netarium - canvas/drag-drop.js
 */

import { appState } from '../core/state.js';
import { eventBus } from '../core/event-bus.js';
import { mappedResourceId } from '../core/resource-save.js';
import { beginCanvasHistoryDrag, recordPlacementMove } from '../core/placement-history.js';
import {
    isCurrentUserAdmin
} from '../ui/access-control.js';
import {
    applyViewTransform
} from './pan-zoom.js';
import {
    getCurrentPlacements
} from '../core/state.js';
import {
    suppressCanvasClickOnce
} from './interaction-state.js';
import {
    markDirty
} from '../ui/status-bar.js';
import { hasResourceConflict, scheduleSave } from '../core/save-queue.js';
import { openPanel } from '../ui/property-panel.js';
import { isPlacementModeActive } from '../ui/placement-mode.js';

let isPanning = false;
let activePlacementDrag = null;
eventBus.on('resources:ids-remapped', maps => activePlacementDrag?.remap(maps));
eventBus.on('canvas:render-complete', () => activePlacementDrag?.refresh());
eventBus.on('resources:reloaded', () => activePlacementDrag?.cancel());
eventBus.on('resource:reloaded', ({ kind, id }) => {
    if (kind === 'views' && activePlacementDrag?.viewId === Number(id)) activePlacementDrag.cancel();
});

/**
 * キャンバス空白部分のポインター操作。
 *
 * 接続・メモモード以外のShift+ドラッグは矩形選択、
 * それ以外の空白ドラッグはパンとして処理する。
 */
export function onCanvasPointerDown(event) {
    if (
        event.button !== 0 ||
        isPanning ||
        appState.isRangeSelecting ||
        appState.floorPlanAdjustMode
    ) {
        return;
    }

    if (
        event.target instanceof Element &&
        event.target.closest(
            '.floor-rack, ' +
            '.device, ' +
            '.link-group, ' +
            '.link-count-badge, ' +
            '.link-route-editor, ' +
            '.canvas-note, ' +
            '#canvas-context-toolbar, ' +
            'button, ' +
            'input, ' +
            'select, ' +
            'textarea'
        )
    ) {
        return;
    }

    if (event.shiftKey && !appState.noteMode && !appState.linkMode) {
        eventBus.emit(
            'canvas:begin-range-selection',
            event
        );

        return;
    }

    beginCanvasPan(event);
}


/**
 * 空白ドラッグによるパンを開始する。
 */

/**
 * 空白ドラッグによるパンを開始する。
 */
export function beginCanvasPan(event) {
    const pointerId = event.pointerId;
    const startClientX =
        event.clientX;

    const startClientY =
        event.clientY;

    const startPanX =
        appState.viewState.panX;

    const startPanY =
        appState.viewState.panY;

    let moved = false;

    isPanning = true;
    const endHistoryDrag = beginCanvasHistoryDrag();

    appState.canvas.classList.add(
        'panning'
    );

    try {
        appState.canvas.setPointerCapture(
            event.pointerId
        );
    } catch (error) {
        /*
         * Pointer Captureが使用できない
         * 環境でも処理は継続する。
         */
    }

    const onMove = moveEvent => {
        if (moveEvent.pointerId !== pointerId) return;
        const dx =
            moveEvent.clientX -
            startClientX;

        const dy =
            moveEvent.clientY -
            startClientY;

        if (
            Math.abs(dx) > 3 ||
            Math.abs(dy) > 3
        ) {
            moved = true;
        }

        appState.viewState.panX =
            startPanX + dx;

        appState.viewState.panY =
            startPanY + dy;

        applyViewTransform();
    };

    const onFinish =
        finishEvent => {
            if (finishEvent.pointerId !== pointerId) return;
            try {
                if (
                    appState.canvas.hasPointerCapture(
                        finishEvent.pointerId
                    )
                ) {
                    appState.canvas.releasePointerCapture(
                        finishEvent.pointerId
                    );
                }
            } catch (error) {
                /*
                 * 既に解除済みの場合は
                 * 何もしない。
                 */
            }

            document.removeEventListener(
                'pointermove',
                onMove
            );

            document.removeEventListener(
                'pointerup',
                onFinish
            );

            document.removeEventListener(
                'pointercancel',
                onFinish
            );

            appState.canvas.classList.remove(
                'panning'
            );

            isPanning = false;
            endHistoryDrag();

            if (moved) {
                suppressCanvasClickOnce();
            }
        };

    document.addEventListener(
        'pointermove',
        onMove
    );

    document.addEventListener(
        'pointerup',
        onFinish
    );

    document.addEventListener(
        'pointercancel',
        onFinish
    );
}


/**
 * 次に発生するキャンバスクリックを
 * 1回だけ無視する。
 */

/**
 * 次に発生するキャンバスクリックを
 * 1回だけ無視する。
 */
/**
 * クライアント座標を、
 * キャンバス左上基準の座標へ変換する。
 */

/**
 * 選択グループ全体がキャンバス内に収まるよう、
 * 移動量を制限する
 */
export function clampGroupDelta(startPositions, dx, dy) {
    let minimumDx = -Infinity;
    let minimumDy = -Infinity;

    startPositions.forEach(position => {
        minimumDx = Math.max(
            minimumDx,
            -position.x
        );

        minimumDy = Math.max(
            minimumDy,
            -position.y
        );
    });

    return {
        dx: Math.max(minimumDx, dx),
        dy: Math.max(minimumDy, dy)
    };
}


export function getDragTargetPlacements(
    placement
) {
    const placementId =
        Number(placement.id);

    if (
        appState.selectedPlacementIds.has(
            placementId
        )
    ) {
        return getCurrentPlacements()
            .filter(item =>
                appState.selectedPlacementIds.has(
                    Number(item.id)
                )
            );
    }

    return [placement];
}

function getPlacementElement(placementId) {
    if (!appState.deviceLayer) {
        return null;
    }

    return appState.deviceLayer.querySelector(
        `.device[data-placement-id="${Number(
            placementId
        )}"]`
    );
}


export function makePlacementDraggable(
    el,
    placement
) {
    let startX = 0;
    let startY = 0;
    let moved = false;
    let dragAborted = false;
    let dragStarted = false;
    let dragIds = [];
    let startPositions = new Map();

    let renderRafId = null;

    const scheduleRenderLinks = () => {
        if (renderRafId !== null) return;
        renderRafId = requestAnimationFrame(() => {
            renderRafId = null;
            eventBus.emit('canvas:render-links');
        });
    };
    el.addEventListener(
        'pointerdown',
        event => {
            if (
                !isCurrentUserAdmin() ||
                appState.authExpired ||
                appState.appStatus?.state === 'unconfirmed' ||
                appState.isPinging ||
                appState.floorPlanAdjustMode ||
                appState.isRangeSelecting ||
                appState.noteMode ||
                isPlacementModeActive() ||
                hasResourceConflict('views', appState.currentViewId)
            ) {
                return;
            }
            if (
                event.button !== 0 ||
                appState.linkMode
            ) {
                return;
            }

            if (
                event.target instanceof Element &&
                event.target.closest(
                    'input, textarea, select, button'
                )
            ) {
                return;
            }
            const currentPlacement = appState.placements.find(item =>
                Number(item.id) === Number(el.dataset.placementId ?? placement.id));
            if (!currentPlacement) return;

            const pointerId = event.pointerId;
            if (
                activePlacementDrag &&
                activePlacementDrag.pointerId !== pointerId
            ) {
                return;
            }
            activePlacementDrag?.cancel();
            let primaryId = Number(currentPlacement.id);

            const multiSelectKey =
                event.ctrlKey ||
                event.metaKey ||
                event.shiftKey;

            startX = event.clientX;
            startY = event.clientY;
            moved = false;
            dragStarted = false;
            dragAborted = false;

            if (multiSelectKey) {
                dragIds = (appState.selectedPlacementIds.has(primaryId)
                    ? getCurrentPlacements().filter(item => appState.selectedPlacementIds.has(Number(item.id)))
                    : [currentPlacement]).map(item => Number(item.id));
            } else {
                dragIds = getDragTargetPlacements(currentPlacement).map(item => Number(item.id));
            }

            startPositions = new Map(
                dragIds.map(id => {
                    const item = appState.placements.find(row => Number(row.id) === id);
                    return [
                    Number(item.id),
                    {
                        placement: item,
                        x:
                            Number(item.x) ||
                            0,
                        y:
                            Number(item.y) ||
                            0
                    }
                    ];
                })
            );

            const endHistoryDrag = beginCanvasHistoryDrag();
            // ダイアログ表示中にupが来ても複数の開始処理を走らせない。
            let finished = false;
            let pendingPointerUp = false;
            let moveSequence = 0;
            let startPromise = null;
            const beginDrag = () => {
                if (dragStarted) return Promise.resolve(true);
                if (dragAborted || finished) return Promise.resolve(false);
                if (startPromise) return startPromise;

                startPromise = (async () => {
                    const target = appState.placements.find(item => Number(item.id) === primaryId);
                    if (!target || Number(target.view_id) !== Number(appState.currentViewId)) return false;
                    if (appState.editingDeviceId !== Number(target.device_id)) {
                        const panelOpen = !document.getElementById('panel')?.hidden ||
                            !document.getElementById('link-panel')?.hidden;
                        if (panelOpen) {
                            const hadPendingUp = pendingPointerUp;
                            if (!await openPanel(appState.devices.find(
                                device => Number(device.id) === Number(target.device_id)
                            )) || (!hadPendingUp && pendingPointerUp)) {
                                dragAborted = true;
                                return false;
                            }
                        }
                        if (finished || dragAborted || activePlacementDrag !== dragSession) {
                            dragAborted = true;
                            return false;
                        }
                        appState.editingDeviceId = Number(target.device_id);
                    }

                    if (finished || dragAborted || activePlacementDrag !== dragSession) {
                        dragAborted = true;
                        return false;
                    }
                    if (!multiSelectKey) {
                        appState.selectedPlacementIds.clear();
                        dragIds.forEach(id => appState.selectedPlacementIds.add(id));
                        eventBus.emit('canvas:selection-changed');
                    }

                    dragStarted = true;
                    event.preventDefault();
                    try {
                        appState.canvas.setPointerCapture(pointerId);
                    } catch (err) {
                        // 継続
                    }

                    dragIds.forEach(id => getPlacementElement(id)?.classList.add('dragging'));
                    return true;
                })();
                return startPromise;
            };

            const applyPointerPosition = moveEvent => {
                const requestedDx = (moveEvent.clientX - startX) / appState.viewState.scale;
                const requestedDy = (moveEvent.clientY - startY) / appState.viewState.scale;
                const delta = clampGroupDelta(startPositions, requestedDx, requestedDy);

                dragIds.forEach(id => {
                    const item = appState.placements.find(row => Number(row.id) === id);
                    const start = startPositions.get(id);
                    if (!item || !start) return;
                    start.placement = item;
                    item.x = start.x + delta.dx;
                    item.y = start.y + delta.dy;
                    const targetElement = getPlacementElement(id);
                    if (targetElement) {
                        targetElement.style.transform = `translate(${item.x}px, ${item.y}px)`;
                    }
                });
                scheduleRenderLinks();
            };

            const onPointerMove = async moveEvent => {
                if (moveEvent.pointerId !== pointerId || finished) return;
                if (!refreshTargets()) return;
                const screenDx = moveEvent.clientX - startX;
                const screenDy = moveEvent.clientY - startY;
                if (!dragStarted && Math.abs(screenDx) <= 3 && Math.abs(screenDy) <= 3) return;

                const sequence = ++moveSequence;
                if (!await beginDrag() || finished || sequence !== moveSequence ||
                    activePlacementDrag !== dragSession) return;
                moved = true;
                applyPointerPosition(moveEvent);
            };

            const restorePositions = () => {
                for (const id of dragIds) {
                    const item = appState.placements.find(row => Number(row.id) === id);
                    const start = startPositions.get(id);
                    // 再読込で差し替わった配置は変更しない。
                    if (!start || item !== start.placement) continue;
                    item.x = start.x;
                    item.y = start.y;
                    const target = getPlacementElement(id);
                    if (target) target.style.transform = `translate(${item.x}px, ${item.y}px)`;
                }
            };

            const recordMove = () => {
                const moves = [];
                for (const placementId of dragIds) {
                    const start = startPositions.get(placementId);
                    const item = appState.placements.find(row => Number(row.id) === placementId &&
                        Number(row.view_id) === dragSession.viewId);
                    // 欠けた配置を除いてグループの一部だけを履歴に積まない。
                    if (!start || !item) return false;
                    moves.push({ placementId, before: { x: start.x, y: start.y }, after: { x: item.x, y: item.y } });
                }
                return recordPlacementMove(dragSession.viewId, moves);
            };

            const completeDrag = commit => {
                finished = true;
                moveSequence++;
                try {
                    try {
                        if (appState.canvas.hasPointerCapture(pointerId)) {
                            appState.canvas.releasePointerCapture(pointerId);
                        }
                    } catch (err) {
                        // 無視
                    }

                    dragIds.forEach(id => getPlacementElement(id)?.classList.remove('dragging'));
                    document.removeEventListener('pointermove', onPointerMove);
                    document.removeEventListener('pointerup', finish);
                    document.removeEventListener('pointercancel', finish);

                    if (renderRafId !== null) {
                        cancelAnimationFrame(renderRafId);
                        renderRafId = null;
                    }
                    if (moved) {
                        const recorded = commit && recordMove();
                        if (!recorded) restorePositions();
                        eventBus.emit('canvas:render-links');
                        if (recorded) {
                            markDirty();
                            scheduleSave({ immediate: true, silent: true });
                        }
                    }
                    if (moved || dragAborted) suppressCanvasClickOnce();
                } finally {
                    if (activePlacementDrag === dragSession) activePlacementDrag = null;
                    dragIds = [];
                    startPositions.clear();
                    dragStarted = false;
                    endHistoryDrag();
                }
            };

            const finish = async upEvent => {
                const pointerUp = upEvent.type === 'pointerup';
                if (upEvent.pointerId !== pointerId || finished || (pointerUp && pendingPointerUp)) return;
                // 重複upは先の確定を上書きしない。cancelは保留中のupより優先する。
                if (pointerUp) pendingPointerUp = true;
                let commit = false;
                try {
                    // 最終のmoveが配信されなくても、upの座標を同じ制約で確定する。
                    if (pointerUp && Number.isFinite(upEvent.clientX) && Number.isFinite(upEvent.clientY)) {
                        await onPointerMove(upEvent);
                    }
                    commit = pointerUp && !dragAborted;
                } finally {
                    if (!finished) completeDrag(commit);
                }
            };

            const refreshTargets = () => {
                if (
                    appState.authExpired ||
                    appState.appStatus?.state === 'unconfirmed' ||
                    hasResourceConflict('views', dragSession.viewId) ||
                    dragIds.some(id => !appState.placements.some(item => Number(item.id) === id &&
                        Number(item.view_id) === Number(appState.currentViewId)))
                ) {
                    dragAborted = true;
                    finish({ pointerId });
                    return false;
                }
                if (dragStarted) dragIds.forEach(id => getPlacementElement(id)?.classList.add('dragging'));
                return true;
            };
            const dragSession = {
                pointerId,
                viewId: Number(currentPlacement.view_id),
                remap(maps) {
                    this.viewId = mappedResourceId(maps.views, this.viewId);
                    primaryId = mappedResourceId(maps.placements, primaryId);
                    dragIds = dragIds.map(id => mappedResourceId(maps.placements, id));
                    startPositions = new Map([...startPositions].map(([id, position]) =>
                        [mappedResourceId(maps.placements, id), position]));
                },
                refresh: refreshTargets,
                cancel() {
                    dragAborted = true;
                    finish({ pointerId });
                }
            };
            activePlacementDrag = dragSession;

            document.addEventListener(
                'pointermove',
                onPointerMove
            );

            document.addEventListener(
                'pointerup',
                finish
            );

            document.addEventListener(
                'pointercancel',
                finish
            );
        }
    );
}


/**
 * 位置をキャンバス内に制限
 */
export function clampPosition(x, y) {
    return {
        x: Math.max(0, Number(x) || 0),
        y: Math.max(0, Number(y) || 0)
    };
}


/**
 * 機器中心座標
 */
