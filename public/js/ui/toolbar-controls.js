/**
 * Netarium - ツールバー表示制御
 */

import { appState } from '../core/state.js';
import { eventBus } from '../core/event-bus.js';
import {
    exitPlacementMode,
    isPlacementModeActive,
    togglePlacementMode
} from './placement-mode.js';

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
