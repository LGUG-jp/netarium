/**
 * Netarium - core/modal-focus.js
 *
 * モーダルダイアログおよび全画面オーバーレイの共通アクセシビリティ制御。
 * 初期フォーカス、Tabキーの閉じ込め、Escキーによる閉鎖、起動元要素へのフォーカス復帰を一貫して提供する。
 */

import { isCurrentUserAdmin } from '../ui/access-control.js';
import { eventBus } from './event-bus.js';

const modalStack = [];
const backdropListeners = new WeakSet();
const initializedDocuments = new WeakSet();
const canvasInertStates = new WeakMap();

/** ×・背景・Escは、登録された同じ閉鎖処理へ渡す。 */
export function requestModalClose() {
    const entry = modalStack.at(-1);
    if (!entry || entry.container.hidden || entry.container.closest?.('[hidden], .hidden') ||
        entry.closing || !entry.onClose) return false;
    entry.closing = true;
    try {
        const result = entry.onClose();
        if (result && typeof result.then === 'function') {
            return result.finally(() => { entry.closing = false; });
        }
        entry.closing = false;
        return result;
    } catch (error) {
        entry.closing = false;
        throw error;
    }
}
export function getTopModalContainer() {
    return modalStack.at(-1)?.container || null;
}

export function syncCanvasViewControlsVisibility() {
    const canvas = document.getElementById('canvas');
    const visibleModal = modalStack.some(({ container }) =>
        !container.hidden && !container.closest?.('[hidden], .hidden'));
    if (canvas) {
        if (visibleModal && !canvasInertStates.has(canvas)) canvasInertStates.set(canvas, canvas.inert);
        if (visibleModal) canvas.inert = true;
        else if (canvasInertStates.has(canvas)) {
            canvas.inert = canvasInertStates.get(canvas);
            canvasInertStates.delete(canvas);
        }
    }
    const controls = document.getElementById('canvas-view-controls');
    if (controls) controls.hidden = visibleModal || !canvas;
}

function syncModalStack() {
    const top = getTopModalContainer();
    syncCanvasViewControlsVisibility();
    modalStack.forEach((entry, index) => {
        if (entry.container.style) entry.container.style.zIndex = String(3000 + index);
        entry.container.inert = entry.container !== top && !entry.container.contains(top);
        const dialog = entry.container.querySelector('[role="dialog"]');
        if (dialog) dialog.setAttribute('aria-modal', entry.container === top ? 'true' : 'false');
    });
}

/**
 * フォーカス可能な要素を取得するセレクタ
 */
const FOCUSABLE_SELECTOR = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])'
].join(', ');

/**
 * 要素が現在可視かつフォーカス可能か判定
 */
function isElementVisibleAndFocusable(el) {
    if (!el || !(el instanceof HTMLElement)) return false;
    if (el.hidden || el.disabled || el.inert || el.getAttribute('aria-hidden') === 'true') return false;
    if (el.closest('[hidden], .hidden, [inert]')) return false;

    // 非管理者時のadmin-only要素は除外
    if (el.classList.contains('admin-only') && !isCurrentUserAdmin()) return false;
    if (el.closest('.admin-only') && !isCurrentUserAdmin()) return false;

    // 閉じたdetails内部の要素は除外
    const parentDetails = el.closest('details');
    if (parentDetails && !parentDetails.open && !el.closest('summary')) {
        return false;
    }

    // display: none や visibility: hidden の確認
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;

    return true;
}

/**
 * コンテナ内の有効なフォーカス可能要素一覧を取得
 */
export function getFocusableElements(container) {
    if (!container || !(container instanceof HTMLElement)) return [];
    return Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR))
        .filter(isElementVisibleAndFocusable);
}

/**
 * モーダルを開いた際のフォーカス登録
 *
 * @param {string} modalId - モーダルの識別子 (例: 'ledger', 'backup')
 * @param {HTMLElement|string} container - ダイアログまたはオーバーレイ要素
 * @param {HTMLElement|string|null} preferredInitialFocus - 優先する初期フォーカス要素
 * @param {{onClose?: function, finishFloorPlan?: boolean}} options - 閉鎖処理。表示専用UIは図面編集を保持できる
 */
export function registerModalOpen(modalId, container, preferredInitialFocus = null, { onClose = null, finishFloorPlan = true } = {}) {
    const containerEl = typeof container === 'string'
        ? document.querySelector(container)
        : container;

    if (!containerEl) return;
    if (modalStack.some(entry => entry.id === modalId)) return;
    if (containerEl.getAttribute?.('tabindex') === null) containerEl.tabIndex = -1;
    if (finishFloorPlan) eventBus.emit('floor-plan:finish');

    const previousFocus = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    modalStack.push({
        id: modalId,
        container: containerEl,
        previousFocus,
        originalZIndex: containerEl.style?.zIndex || '',
        onClose,
        closing: false
    });
    syncModalStack();
    if (onClose && !backdropListeners.has(containerEl)) {
        containerEl.addEventListener('click', event => {
            if (event.target !== containerEl || getTopModalContainer() !== containerEl) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            return requestModalClose();
        }, true);
        backdropListeners.add(containerEl);
    }

    window.requestAnimationFrame(() => {
        if (getTopModalContainer() !== containerEl) return;
        let target = null;
        if (preferredInitialFocus) {
            target = typeof preferredInitialFocus === 'string'
                ? containerEl.querySelector(preferredInitialFocus)
                : preferredInitialFocus;
        }

        if (!target || !isElementVisibleAndFocusable(target)) {
            const focusables = getFocusableElements(containerEl);
            target = focusables[0] || containerEl;
        }

        if (target && typeof target.focus === 'function') {
            target.focus();
        }
    });
}

/**
 * モーダルを閉じた際のフォーカス復帰
 *
 * @param {string} modalId - モーダルの識別子
 * @param {{restoreFocus?: boolean}} options - モード切替時は切替先がフォーカスを管理する
 */
export function registerModalClose(modalId, { restoreFocus = true } = {}) {
    const index = modalStack.findIndex(entry => entry.id === modalId);
    if (index === -1) return;

    const [entry] = modalStack.splice(index, 1);
    if (entry.container.style) entry.container.style.zIndex = entry.originalZIndex;
    entry.container.inert = false;
    const dialog = entry.container.querySelector('[role="dialog"]');
    if (dialog) dialog.setAttribute('aria-modal', 'true');
    syncModalStack();
    const previousFocus = entry.previousFocus;

    if (restoreFocus && index === modalStack.length && previousFocus && typeof previousFocus.focus === 'function') {
        window.requestAnimationFrame(() => {
            const top = getTopModalContainer();
            if (document.body.contains(previousFocus) && !previousFocus.hidden && !previousFocus.disabled &&
                !previousFocus.closest?.('[hidden], .hidden, [inert]') && (!top || top.contains(previousFocus))) {
                previousFocus.focus();
            } else if (top && !top.hidden) {
                (getFocusableElements(top)[0] || top).focus();
            }
        });
    }
}

/**
 * グローバルのTabキー閉じ込めリスナー初期化
 */
export function initModalFocusTrap() {
    if (typeof document === 'undefined' || initializedDocuments.has(document)) return;
    initializedDocuments.add(document);

    document.addEventListener('keydown', event => {
        if (event.key !== 'Tab') return;
        if (modalStack.length === 0) return;

        const currentModal = modalStack[modalStack.length - 1];
        const container = currentModal.container;
        if (!container || container.hidden || container.closest('[hidden], .hidden')) {
            return;
        }

        const focusables = getFocusableElements(container);
        if (focusables.length === 0) {
            event.preventDefault();
            return;
        }

        const firstElement = focusables[0];
        const lastElement = focusables[focusables.length - 1];

        if (event.shiftKey) {
            if (document.activeElement === firstElement || !container.contains(document.activeElement)) {
                event.preventDefault();
                lastElement.focus();
            }
        } else {
            if (document.activeElement === lastElement || !container.contains(document.activeElement)) {
                event.preventDefault();
                firstElement.focus();
            }
        }
    });
    document.addEventListener('focusin', event => {
        const container = getTopModalContainer();
        if (!container || container.hidden || container.closest('[hidden], .hidden') || container.contains(event.target)) return;
        (getFocusableElements(container)[0] || container).focus();
    });
}
