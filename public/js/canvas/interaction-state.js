/**
 * Netarium - キャンバス操作状態
 */

import { appState } from '../core/state.js';

export function suppressCanvasClickOnce() {
    appState.suppressNextClick = true;

    window.setTimeout(
        () => {
            appState.suppressNextClick = false;
        },
        0
    );
}
