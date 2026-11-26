import { appState, getCurrentView } from '../core/state.js';
import { eventBus } from '../core/event-bus.js';
import { getTopModalContainer } from '../core/modal-focus.js';
import { applyPlacementHistory, getPlacementHistoryAvailability, isCanvasHistoryDragActive } from '../core/placement-history.js';
import { hasViewPlacementConflict } from '../core/resource-save.js';
import { getPendingSave, isSaveInFlight, scheduleSave } from '../core/save-queue.js';
import { render } from '../canvas/renderer.js';
import { isCurrentUserAdmin } from './access-control.js';
import { getOpenBuildingId } from './building-view.js';
import { isPlacementModeActive } from './placement-mode.js';
import { markDirty } from './status-bar.js';

const isMac = () => /^Mac/i.test(window.navigator?.userAgentData?.platform ?? window.navigator?.platform ?? '');
const modalIsOpen = () => {
    const modal = getTopModalContainer();
    return modal && !modal.hidden && !modal.closest('[hidden], .hidden');
};

function historyAllowed(view) {
    return view && view.view_type !== 'rack' && getOpenBuildingId() == null && isCurrentUserAdmin() &&
        !appState.authExpired && !appState.isPinging && !isCanvasHistoryDragActive() && !isSaveInFlight() &&
        appState.appStatus.state !== 'unconfirmed' && appState.appStatus.state !== 'maintenance' &&
        !getPendingSave() && !hasViewPlacementConflict(view.id) &&
        !appState.linkMode && !appState.noteMode && !appState.floorPlanAdjustMode && !isPlacementModeActive() &&
        !document.getElementById('canvas-context-toolbar')?.dataset.activeContext && !modalIsOpen();
}

function apply(direction) {
    const view = getCurrentView();
    if (!historyAllowed(view) || !applyPlacementHistory(view.id, direction)) return false;
    markDirty();
    scheduleSave({ immediate: true, silent: true });
    render();
    return true;
}

export function handlePlacementHistoryShortcut(event) {
    if (event.defaultPrevented || event.altKey || event.isComposing || event.keyCode === 229) return false;
    const mac = isMac();
    if (mac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) return false;
    const key = event.key.toLowerCase();
    const direction = key === 'z' ? (event.shiftKey ? 'redo' : 'undo')
        : key === 'y' && !mac && !event.shiftKey ? 'redo' : null;
    if (!direction || !apply(direction)) return false;
    event.preventDefault();
    event.stopImmediatePropagation();
    return true;
}

export function initPlacementHistoryControls() {
    const controls = document.getElementById('placement-history');
    if (!controls) return;
    const inline = document.getElementById('placement-history-inline');
    const compact = document.getElementById('placement-history-compact');
    const trigger = document.getElementById('placement-history-trigger');
    const popup = document.getElementById('placement-history-menu');
    const buttons = [...controls.querySelectorAll('[data-history-action]')];
    const items = [...popup.querySelectorAll('button')];
    const media = window.matchMedia?.('(max-width: 1440px)');
    const enabledItems = () => items.filter(item => !item.disabled);

    const mac = isMac();
    for (const button of buttons) {
        const undoing = button.dataset.historyAction === 'undo';
        const keys = undoing ? (mac ? 'Cmd+Z' : 'Ctrl+Z') : (mac ? 'Cmd+Shift+Z' : 'Ctrl+Y / Ctrl+Shift+Z');
        const label = `${undoing ? '元に戻す' : 'やり直す'}（${keys}）`;
        button.title = label;
        button.setAttribute('aria-label', label);
        button.setAttribute('aria-keyshortcuts', undoing ? (mac ? 'Meta+Z' : 'Control+Z')
            : (mac ? 'Meta+Shift+Z' : 'Control+Y Control+Shift+Z'));
    }

    function setOpen(open, restoreFocus = false) {
        if (restoreFocus) trigger.focus({ preventScroll: true });
        popup.hidden = !open;
        trigger.setAttribute('aria-expanded', String(open));
    }

    function sync() {
        const view = getCurrentView();
        const available = view && getPlacementHistoryAvailability(view.id);
        const allowed = historyAllowed(view);
        const focusInMenu = popup.contains(document.activeElement);
        controls.hidden = !isCurrentUserAdmin();
        for (const button of buttons) {
            button.disabled = !allowed || !available?.[button.dataset.historyAction];
        }
        const disabled = !allowed || !(available?.undo || available?.redo);
        trigger.setAttribute('aria-disabled', String(disabled));
        if (!popup.hidden && disabled) setOpen(false, focusInMenu && !controls.inert && !controls.hidden && !modalIsOpen());
    }

    function syncLayout() {
        const active = document.activeElement;
        const narrow = media?.matches === true;
        const transferFocus = narrow ? inline.contains(active) : compact.contains(active);
        inline.hidden = narrow;
        compact.hidden = !narrow;
        if (!narrow) setOpen(false);
        if (transferFocus && !controls.hidden && !controls.inert) {
            const next = narrow ? trigger : [...inline.querySelectorAll('button')].find(button => !button.disabled) ??
                document.getElementById('loadBtn');
            next?.focus({ preventScroll: true });
        }
    }

    trigger.addEventListener('click', event => {
        if (trigger.getAttribute('aria-disabled') === 'true') return;
        const open = popup.hidden;
        setOpen(open);
        if (open && event.detail === 0) enabledItems()[0]?.focus({ preventScroll: true });
    });
    for (const button of buttons) {
        button.addEventListener('click', () => {
            if (popup.contains(button)) setOpen(false, true);
            if (!apply(button.dataset.historyAction)) sync();
        });
    }
    document.addEventListener('keydown', event => {
        if (event.isComposing || event.keyCode === 229 || modalIsOpen() || getOpenBuildingId() != null) return;
        if (event.key === 'Escape' && !popup.hidden) {
            event.preventDefault();
            event.stopImmediatePropagation();
            setOpen(false, true);
            return;
        }
        if (!compact.contains(event.target)) return;
        if (event.key === 'Tab' && !popup.hidden) {
            // 先にトリガーへ戻し、ブラウザーの既定の Tab / Shift+Tab でメニューの外へ進む。
            setOpen(false, true);
            return;
        }
        const items = enabledItems();
        if (trigger.getAttribute('aria-disabled') === 'true' || !items.length ||
            !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const current = items.indexOf(document.activeElement);
        const last = items.length - 1;
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? last
            : event.key === 'ArrowDown' ? (current + 1) % items.length
                : current <= 0 ? last : current - 1;
        setOpen(true);
        items[next].focus({ preventScroll: true });
    }, true);
    document.addEventListener('focusin', event => {
        if (!popup.hidden && !compact.contains(event.target)) setOpen(false);
    });
    document.addEventListener('click', event => {
        if (!popup.hidden && !compact.contains(event.target)) setOpen(false, popup.contains(document.activeElement));
    });
    media?.addEventListener('change', syncLayout);
    for (const name of ['placement-history:changed', 'save-availability:changed', 'save-state:changed',
        'canvas:render-complete', 'building-view:changed', 'wiring:render', 'canvas-context:changed',
        'canvas:range-selection-changed', 'modal-stack:changed', 'auth:expired', 'ping:busy-changed', 'resource:conflict']) {
        eventBus.on(name, sync);
    }
    syncLayout();
    sync();
}
