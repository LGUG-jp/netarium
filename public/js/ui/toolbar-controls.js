/**
 * Netarium - ツールバー表示制御
 */

import { appState, getCurrentView } from '../core/state.js';
import { eventBus } from '../core/event-bus.js';
import { isCurrentUserAdmin } from './access-control.js';
import { hasResourceConflict, isSaveInFlight } from '../core/save-queue.js';
import {
    exitPlacementMode,
    isPlacementModeActive,
    togglePlacementMode
} from './placement-mode.js';

export function syncViewCapabilities() {
    const rack = getCurrentView()?.view_type === 'rack';
    const shelf = document.getElementById('palette-shelf-btn');
    if (shelf) {
        shelf.hidden = !rack || !isCurrentUserAdmin();
        shelf.disabled = !isCurrentUserAdmin() || appState.authExpired || appState.isPinging || isSaveInFlight() ||
            appState.appStatus.state === 'unconfirmed' || hasResourceConflict('views', appState.currentViewId);
    }
    const floorPlan = document.getElementById('floor-plan-manage-btn');
    if (floorPlan) floorPlan.hidden = rack || !isCurrentUserAdmin();
    for (const id of ['palette-place-btn', 'linkBtn', 'palette-note-btn']) {
        const control = document.getElementById(id);
        if (!control) continue;
        control.hidden = rack || !isCurrentUserAdmin();
        control.disabled = rack || !isCurrentUserAdmin() || appState.authExpired || appState.isPinging ||
            hasResourceConflict('views', appState.currentViewId);
        control.setAttribute('aria-disabled', String(control.disabled));
        if (rack) {
            if (control.dataset.titleBeforeRack == null) control.dataset.titleBeforeRack = control.title || '';
            control.title = id === 'linkBtn' ? 'ラックでは接続線を編集できません'
                : id === 'palette-note-btn' ? 'ラックの右側のメモ欄で直接編集してください' : 'ラックでは空きUから搭載してください';
        } else if (control.dataset.titleBeforeRack != null) {
            control.title = control.dataset.titleBeforeRack;
            delete control.dataset.titleBeforeRack;
        }
    }
}

export function syncLinkModeButton() {
    const linkBtn = document.getElementById('linkBtn');
    const viewBtn = document.getElementById('palette-view-btn');
    const isPlacementActive = isPlacementModeActive();

    if (linkBtn) {
        linkBtn.classList.toggle('active', appState.linkMode);
        linkBtn.setAttribute(
            'aria-pressed',
            appState.linkMode ? 'true' : 'false'
        );
        linkBtn.setAttribute('aria-expanded', String(appState.linkMode));
    }

    if (viewBtn) {
        const isNormalView = !appState.linkMode && !isPlacementActive && !appState.noteMode;
        viewBtn.classList.toggle('active', isNormalView);
        viewBtn.setAttribute(
            'aria-pressed',
            isNormalView ? 'true' : 'false'
        );
    }
    eventBus.emit('wiring:render');
}

export function togglePlacePopover() {
    togglePlacementMode();
}

export function closePlacePopover() {
    exitPlacementMode();
}
export function closeToolbarMenu() {
    document.querySelectorAll('.toolbar-menu[open]').forEach(menu => {
        menu.open = false;
    });
}

if (typeof document !== 'undefined') {
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            closeToolbarMenu();
            if (isPlacementModeActive()) {
                exitPlacementMode();
                document.getElementById('palette-place-btn')?.focus();
            }
        }
    });

    document.addEventListener('click', event => {
        const target = event.target;
        if (target instanceof Element) {
            if (!target.closest('.toolbar-menu')) {
                closeToolbarMenu();
            }
        }
    });
}
