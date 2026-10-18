/**
 * Netarium - canvas/drag-drop.js
 */

import { appState } from '../core/state.js';
import { eventBus } from '../core/event-bus.js';
import { mappedResourceId } from '../core/resource-save.js';
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
import { scheduleSave } from '../core/save-queue.js';
import { openPanel } from '../ui/property-panel.js';

let isPanning = false;
let activePlacementDrag = null;
eventBus.on('resources:ids-remapped', maps => activePlacementDrag?.remap(maps));
eventBus.on('canvas:render-complete', () => activePlacementDrag?.refresh());
eventBus.on('resources:reloaded', () => activePlacementDrag?.cancel());

/**
 * キャンバス空白部分のポインター操作。
 *
 * Shift+ドラッグは矩形選択、
 * 通常ドラッグはパンとして処理する。
 */
export function onCanvasPointerDown(event) {
    if (
        event.button !== 0 ||
        appState.linkMode ||
        isPanning ||
        appState.isRangeSelecting ||
        appState.floorPlanAdjustMode
    ) {
        return;
    }

    if (
        event.target instanceof Element &&
        event.target.closest(
            '.device, ' +
            '.link-group, ' +
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

    if (event.shiftKey && !appState.noteMode) {
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
                appState.isPinging ||
                appState.floorPlanAdjustMode ||
                appState.isRangeSelecting
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

            const pointerId =
                event.pointerId;

            const beginDrag = async () => {
                if (dragStarted || dragAborted) {
                    return !dragAborted;
                }

                const target = appState.placements.find(item => Number(item.id) === primaryId);
                if (!target || Number(target.view_id) !== Number(appState.currentViewId)) return false;
                if (appState.editingDeviceId !== Number(target.device_id)) {
                    const panelOpen = !document.getElementById('panel')?.hidden ||
                        !document.getElementById('link-panel')?.hidden;
                    if (panelOpen && !await openPanel(appState.devices.find(
                        device => Number(device.id) === Number(target.device_id)
                    ))) {
                        dragAborted = true;
                        return false;
                    }
                    appState.editingDeviceId = Number(target.device_id);
                }

                if (!multiSelectKey) {
                    appState.selectedPlacementIds.clear();
                    dragIds.forEach(id => appState.selectedPlacementIds.add(id));
                    eventBus.emit('canvas:selection-changed');
                }

                dragStarted = true;
                event.preventDefault();

                try {
                    appState.canvas.setPointerCapture(
                        pointerId
                    );
                } catch (err) {
                    // 継続
                }

                dragIds.forEach(id => getPlacementElement(id)?.classList.add('dragging'));
                return true;
            };

            const onPointerMove =
                async moveEvent => {
                    if (!refreshTargets()) return;
                    const screenDx =
                        moveEvent.clientX -
                        startX;

                    const screenDy =
                        moveEvent.clientY -
                        startY;

                    if (
                        !dragStarted &&
                        Math.abs(screenDx) <= 3 &&
                        Math.abs(screenDy) <= 3
                    ) {
                        return;
                    }

                    if (!await beginDrag()) {
                        return;
                    }
                    moved = true;

                    const requestedDx =
                        screenDx /
                        appState.viewState.scale;

                    const requestedDy =
                        screenDy /
                        appState.viewState.scale;

                    const delta =
                        clampGroupDelta(
                            startPositions,
                            requestedDx,
                            requestedDy
                        );

                    dragIds.forEach(id => {
                        const item = appState.placements.find(row => Number(row.id) === id);
                        const start = startPositions.get(id);
                        if (!item || !start) return;
                        item.x = start.x + delta.dx;
                        item.y = start.y + delta.dy;
                        const targetElement = getPlacementElement(id);
                        if (targetElement) {
                            targetElement.style.transform = `translate(${item.x}px, ${item.y}px)`;
                        }
                    });

                    scheduleRenderLinks();
                };

            const finish =
                upEvent => {
                    try {
                        if (
                            appState.canvas.hasPointerCapture(
                                upEvent.pointerId
                            )
                        ) {
                            appState.canvas.releasePointerCapture(
                                upEvent.pointerId
                            );
                        }
                    } catch (err) {
                        // 無視
                    }

                    dragIds.forEach(id => getPlacementElement(id)?.classList.remove('dragging'));

                    document.removeEventListener(
                        'pointermove',
                        onPointerMove
                    );

                    document.removeEventListener(
                        'pointerup',
                        finish
                    );

                    document.removeEventListener(
                        'pointercancel',
                        finish
                    );


                    if (renderRafId !== null) {
                        cancelAnimationFrame(renderRafId);
                        renderRafId = null;
                    }
                    if (moved) {
                        eventBus.emit('canvas:render-links');
                    }
                    if (moved) {
                        markDirty();
                        scheduleSave({ immediate: true, silent: true });
                    }
                    if (moved || dragAborted) {
                        suppressCanvasClickOnce();
                    }

                    if (activePlacementDrag === dragSession) activePlacementDrag = null;
                    dragIds = [];
                    startPositions.clear();
                    dragStarted = false;
                };

            const refreshTargets = () => {
                if (dragIds.some(id => !appState.placements.some(item => Number(item.id) === id &&
                    Number(item.view_id) === Number(appState.currentViewId)))) {
                    dragAborted = true;
                    finish({ pointerId });
                    return false;
                }
                if (dragStarted) dragIds.forEach(id => getPlacementElement(id)?.classList.add('dragging'));
                return true;
            };
            const dragSession = {
                remap(maps) {
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
