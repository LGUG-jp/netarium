/**
 * Netarium - canvas/selection.js
 */

import {
    RANGE_SELECTION_DRAG_THRESHOLD
} from '../core/constants.js';

import { appState } from '../core/state.js';
import { eventBus } from '../core/event-bus.js';
import { endLinkMode } from '../core/link-mode.js';
import { getTopModalContainer, requestModalClose } from '../core/modal-focus.js';
import { closeDeviceTypePicker } from '../ui/device-type-picker.js';
import { closeLinkSystemPicker } from '../ui/link-system-picker.js';
import {
    suppressCanvasClickOnce
} from './interaction-state.js';
import {
    getCanvasLocalPoint
} from './pan-zoom.js';
import {
    render
} from './renderer.js';
import {
    handleManagementConnectionDialogKeydown
} from '../modals/management-modal.js';
import {
    closeLinkPanel,
    deleteEditingLink,
    closePanel,
    deleteSelected
} from '../ui/property-panel.js';
import {
    dismissLedgerPopups
} from '../modals/ledger-modal.js';
import {
    finishFloorPlanAdjustMode
} from '../modals/floor-plan-modal.js';
import { handleCanvasContextToolbarKeydown } from '../ui/canvas-context-toolbar.js';
import { handleCanvasNoteKeydown } from './canvas-notes.js';
import { handleFloorPlanEditorKeydown } from './floor-plan-editor.js';
import {
    closeToolbarMenu,
    syncLinkModeButton
} from '../ui/toolbar-controls.js';
import {
    handleDataQualityDialogKeydown
} from '../modals/data-quality-modal.js';
import {
    handleDashboardDialogKeydown
} from '../modals/dashboard-modal.js';

let rangeSelectionInitialIds = new Set();

eventBus.on('resources:ids-remapped', maps => {
    rangeSelectionInitialIds = new Set([...rangeSelectionInitialIds]
        .map(id => Number(maps.placements?.[id] ?? id)));
});

/**
 * 2点から、方向に依存しない矩形を作る。
 */
export function createNormalizedRect(
    start,
    current
) {
    const left =
        Math.min(
            start.x,
            current.x
        );

    const top =
        Math.min(
            start.y,
            current.y
        );

    const right =
        Math.max(
            start.x,
            current.x
        );

    const bottom =
        Math.max(
            start.y,
            current.y
        );

    return {
        left,
        top,
        right,
        bottom,
        width:
            right - left,
        height:
            bottom - top
    };
}


/**
 * 選択矩形を画面へ表示する。
 */

/**
 * 選択矩形を画面へ表示する。
 */
export function renderCanvasSelectionBox(
    rectangle
) {
    if (!appState.selectionBox) {
        return;
    }

    appState.selectionBox.hidden = false;

    appState.selectionBox.style.left =
        `${rectangle.left}px`;

    appState.selectionBox.style.top =
        `${rectangle.top}px`;

    appState.selectionBox.style.width =
        `${rectangle.width}px`;

    appState.selectionBox.style.height =
        `${rectangle.height}px`;
}


/**
 * 選択矩形の表示だけを消去する。
 */

/**
 * 選択矩形の表示だけを消去する。
 */
export function hideCanvasSelectionBox() {
    if (appState.selectionBox) {
        appState.selectionBox.hidden = true;

        appState.selectionBox.style.left =
            '0px';

        appState.selectionBox.style.top =
            '0px';

        appState.selectionBox.style.width =
            '0px';

        appState.selectionBox.style.height =
            '0px';
    }

    appState.canvas?.classList.remove(
        'selecting'
    );
}


/**
 * 2つのクライアント座標矩形が
 * 一部でも重なっているか判定する。
 */

/**
 * 2つのクライアント座標矩形が
 * 一部でも重なっているか判定する。
 */
export function clientRectanglesIntersect(
    first,
    second
) {
    return !(
        first.right <
            second.left ||
        first.left >
            second.right ||
        first.bottom <
            second.top ||
        first.top >
            second.bottom
    );
}


/**
 * 選択矩形と重なる、現在ビューの
 * 配置IDを取得する。
 */

/**
 * 選択矩形と重なる、現在ビューの
 * 配置IDを取得する。
 */
export function getPlacementIdsInClientRect(
    rectangle
) {
    if (
        !appState.canvas ||
        !appState.deviceLayer
    ) {
        return [];
    }

    const canvasRect =
        appState.canvas.getBoundingClientRect();

    const clientRectangle = {
        left:
            canvasRect.left +
            rectangle.left,

        top:
            canvasRect.top +
            rectangle.top,

        right:
            canvasRect.left +
            rectangle.right,

        bottom:
            canvasRect.top +
            rectangle.bottom
    };

    const placementIds = [];

    appState.deviceLayer
        .querySelectorAll(
            '.device[data-placement-id]'
        )
        .forEach(element => {
            if (
                !(
                    element instanceof
                    HTMLElement
                )
            ) {
                return;
            }

            const deviceRect =
                element
                    .getBoundingClientRect();

            if (
                !clientRectanglesIntersect(
                    clientRectangle,
                    deviceRect
                )
            ) {
                return;
            }

            const placementId =
                Number(
                    element.dataset
                        .placementId
                );

            if (
                Number.isInteger(
                    placementId
                ) &&
                placementId > 0
            ) {
                placementIds.push(
                    placementId
                );
            }
        });

    return placementIds;
}


/**
 * 指定された選択集合を、
 * 現在の選択状態へ反映する。
 */

/**
 * 指定された選択集合を、
 * 現在の選択状態へ反映する。
 */
export function replaceSelectedPlacementIds(
    placementIds
) {
    appState.selectedPlacementIds.clear();

    placementIds.forEach(
        placementId => {
            const normalizedId =
                Number(placementId);

            if (
                Number.isInteger(
                    normalizedId
                ) &&
                normalizedId > 0
            ) {
                appState.selectedPlacementIds.add(
                    normalizedId
                );
            }
        }
    );

    syncSelectedPlacementClasses();
    updateSelectionCount();
    if (typeof eventBus !== 'undefined' && eventBus.emit) {
        eventBus.emit('canvas:selection-changed');
    }
}


/**
 * 矩形内の配置を、
 * 矩形選択開始時の選択へ追加する。
 */

/**
 * 矩形内の配置を、
 * 矩形選択開始時の選択へ追加する。
 */
export function applyCanvasRangeSelection(
    rectangle
) {
    const nextSelection =
        new Set(
            rangeSelectionInitialIds
        );

    getPlacementIdsInClientRect(
        rectangle
    ).forEach(placementId => {
        nextSelection.add(
            placementId
        );
    });

    replaceSelectedPlacementIds(
        nextSelection
    );
}


/**
 * Shift+空白ドラッグによる
 * 矩形選択を開始する。
 */

/**
 * Shift+空白ドラッグによる
 * 矩形選択を開始する。
 */
export async function beginCanvasRangeSelection(
    event
) {
    if (
        !appState.canvas ||
        !appState.selectionBox ||
        appState.isRangeSelecting
    ) {
        return;
    }

    event.preventDefault();

    const pointerId =
        event.pointerId;
    let pointerEnded = false;
    const stopWatchingPointer = () => {
        document.removeEventListener('pointerup', onPendingPointerEnd, true);
        document.removeEventListener('pointercancel', onPendingPointerEnd, true);
    };
    const onPendingPointerEnd = endEvent => {
        if (endEvent.pointerId !== pointerId) return;
        pointerEnded = true;
        stopWatchingPointer();
    };
    document.addEventListener('pointerup', onPendingPointerEnd, true);
    document.addEventListener('pointercancel', onPendingPointerEnd, true);

    /*
     * 確認待ちの間に終了したドラッグは、後から開始しない。
     */
    try {
        if (!await closePanel() || pointerEnded) return;
        if (!await closeLinkPanel() || pointerEnded) return;
    } finally {
        stopWatchingPointer();
    }

    const start =
        getCanvasLocalPoint(
            event.clientX,
            event.clientY
        );

    let latest =
        start;

    let dragStarted = false;
    let animationFrameId = null;

    rangeSelectionInitialIds =
        new Set(
            appState.selectedPlacementIds
        );

    appState.isRangeSelecting = true;

    appState.canvas.classList.add(
        'selecting'
    );


    try {
        appState.canvas.setPointerCapture(
            pointerId
        );
    } catch (error) {
        /*
         * Pointer Captureが使用できない
         * 環境でも処理は継続する。
         */
    }

    const updateSelection = () => {
        animationFrameId = null;

        const rectangle =
            createNormalizedRect(
                start,
                latest
            );

        if (
            !dragStarted &&
            (
                rectangle.width >=
                    RANGE_SELECTION_DRAG_THRESHOLD ||
                rectangle.height >=
                    RANGE_SELECTION_DRAG_THRESHOLD
            )
        ) {
            dragStarted = true;
        }

        if (!dragStarted) {
            return;
        }

        renderCanvasSelectionBox(
            rectangle
        );

        applyCanvasRangeSelection(
            rectangle
        );
    };

    const scheduleUpdate = () => {
        if (
            animationFrameId !== null
        ) {
            return;
        }

        animationFrameId =
            window.requestAnimationFrame(
                updateSelection
            );
    };

    const onMove = moveEvent => {
        if (
            moveEvent.pointerId !==
            pointerId
        ) {
            return;
        }

        latest =
            getCanvasLocalPoint(
                moveEvent.clientX,
                moveEvent.clientY
            );

        scheduleUpdate();
    };

    const cleanup = finishEvent => {
        try {
            if (
                appState.canvas.hasPointerCapture(
                    pointerId
                )
            ) {
                appState.canvas.releasePointerCapture(
                    pointerId
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
            onPointerUp
        );

        document.removeEventListener(
            'pointercancel',
            onPointerCancel
        );

        if (
            animationFrameId !== null
        ) {
            window.cancelAnimationFrame(
                animationFrameId
            );

            animationFrameId = null;
        }

        hideCanvasSelectionBox();

        appState.isRangeSelecting = false;

        appState.cancelActiveRangeSelection = null;

        rangeSelectionInitialIds =
            new Set();

        if (
            dragStarted &&
            finishEvent?.type ===
                'pointerup'
        ) {
            suppressCanvasClickOnce();
        }
    };

    const onPointerUp = upEvent => {
        if (
            upEvent.pointerId !==
            pointerId
        ) {
            return;
        }

        latest =
            getCanvasLocalPoint(
                upEvent.clientX,
                upEvent.clientY
            );

        /*
         * requestAnimationFrameを待たず、
         * 最終位置を確実に選択へ反映する。
         */
        const rectangle =
            createNormalizedRect(
                start,
                latest
            );

        if (
            rectangle.width >=
                RANGE_SELECTION_DRAG_THRESHOLD ||
            rectangle.height >=
                RANGE_SELECTION_DRAG_THRESHOLD
        ) {
            dragStarted = true;

            renderCanvasSelectionBox(
                rectangle
            );

            applyCanvasRangeSelection(
                rectangle
            );
        } else {
            /*
             * 小さい操作では開始前の
             * 選択状態を維持する。
             */
            replaceSelectedPlacementIds(
                rangeSelectionInitialIds
            );
        }

        cleanup(upEvent);
    };

    const onPointerCancel =
        cancelEvent => {
            if (
                cancelEvent.pointerId !==
                pointerId
            ) {
                return;
            }

            /*
             * OSやブラウザによる中断時は、
             * 開始前の選択へ戻す。
             */
            replaceSelectedPlacementIds(
                rangeSelectionInitialIds
            );

            cleanup(cancelEvent);
        };

    appState.cancelActiveRangeSelection =
        () => {
            replaceSelectedPlacementIds(
                rangeSelectionInitialIds
            );

            cleanup({
                type:
                    'keyboardcancel'
            });
        };

    document.addEventListener(
        'pointermove',
        onMove
    );

    document.addEventListener(
        'pointerup',
        onPointerUp
    );

    document.addEventListener(
        'pointercancel',
        onPointerCancel
    );
}



/**
 * API呼び出し共通処理
 */

/**
 * キーボード操作
 */
export async function onKeyDown(event) {
    if (event.key === 'Escape' && !event.isComposing && event.keyCode !== 229
        && (closeDeviceTypePicker() || closeLinkSystemPicker())) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
    }
    const topModal = getTopModalContainer();
    if (topModal && !topModal.hidden) {
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopImmediatePropagation();
            if (topModal.id !== 'ledger-overlay' || !dismissLedgerPopups()) {
                await requestModalClose();
            }
        } else if (['management-connection-overlay', 'management-ssh-help-overlay'].includes(topModal.id)) {
            handleManagementConnectionDialogKeydown(event);
        } else if (topModal.id === 'data-quality-overlay') {
            handleDataQualityDialogKeydown(event);
        } else if (topModal.id === 'dashboard-overlay') {
            handleDashboardDialogKeydown(event);
        }
        return;
    }
    if (appState.floorPlanAdjustMode && handleFloorPlanEditorKeydown(event)) return;
    if (appState.floorPlanAdjustMode && event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        finishFloorPlanAdjustMode('escape');
        return;
    }

    if (handleCanvasNoteKeydown(event)) {
        event.stopImmediatePropagation();
        return;
    }

    if (
        (
            event.ctrlKey ||
            event.metaKey
        ) &&
        event.key.toLocaleLowerCase() ===
            'k'
    ) {
        event.preventDefault();
        event.stopImmediatePropagation();

        closeToolbarMenu();

        const searchInput =
            document.getElementById(
                'device-search-input'
            );

        searchInput?.focus();
        searchInput?.select();

        return;
    }

    if (handleCanvasContextToolbarKeydown(event)) {
        return;
    }


    /*
     * 矩形選択中のEscapeは、
     * 開始前の選択状態へ戻して中止する。
     */
    if (
        event.key === 'Escape' &&
        appState.isRangeSelecting
    ) {
        event.preventDefault();
        event.stopImmediatePropagation();

        appState.cancelActiveRangeSelection?.();

        return;
    }

    // 経路ハンドルのキー操作は専用controllerへ渡し、リンク全体の削除と区別する。
    if (event.target?.closest?.('.link-route-editor')) {
        return;
    }

    // 接続補助パネルのcheckboxにフォーカスがあってもEscでモードを終了する。
    if (event.key === 'Escape' && appState.linkMode) {
        event.preventDefault();
        endLinkMode();
        syncLinkModeButton();
        render();
        document.getElementById('linkBtn')?.focus();
        return;
    }

    const active =
        document.activeElement;

    const target = event.target;
    const isInput = [active, target].some(element => element &&
        (['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) || element.getAttribute?.('role') === 'combobox' || element.isContentEditable));

    /*
     * 入力欄の編集中は、通常画面の
     * キーボード操作を実行しない。
     */
    if (isInput) {
        return;
    }
    if (event.key === 'Delete' && appState.editingLinkId !== null) {
        event.preventDefault();
        deleteEditingLink();
        return;
    }

    /*
     * 通常画面のEscape操作。
     */
    if (event.key === 'Escape') {
        event.preventDefault();


        if (!await closePanel() || !await closeLinkPanel()) {
            return;
        }
        appState.selectedPlacementIds.clear();

        render();
        return;
    }

    /*
     * 選択機器を現在のビューから外す。
     */
    if (
        event.key === 'Delete' ||
        event.key === 'Backspace'
    ) {
        if (
            appState.selectedPlacementIds.size > 0
        ) {
            event.preventDefault();
            await deleteSelected();
        }
    }
}



/**
 * 選択グループ全体がキャンバス内に収まるよう、
 * 移動量を制限する
 */

export function syncSelectedPlacementClasses() {
    if (!appState.deviceLayer) {
        return;
    }

    appState.deviceLayer
        .querySelectorAll('.device')
        .forEach(element => {
            const placementId =
                Number(
                    element.dataset
                        .placementId
                );

            element.classList.toggle(
                'selected',
                appState.selectedPlacementIds.has(
                    placementId
                )
            );
        });
}


export function updateSelectionCount() {
    const count =
        appState.selectedPlacementIds.size;

    const label =
        document.getElementById(
            'selection-count'
        );

    if (label) {
        label.textContent =
            count === 0
                ? '選択なし'
                : `${count}台選択中`;
    }

    const statusCountLabel =
        document.getElementById(
            'status-selection-count'
        );

    if (statusCountLabel) {
        statusCountLabel.textContent =
            `${count}選択`;
    }

    const deleteButton =
        document.getElementById(
            'deleteSelectedBtn'
        );

    if (deleteButton) {
        deleteButton.disabled =
            count === 0;
    }
}

/**
 * ビュー管理
 */
