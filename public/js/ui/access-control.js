/**
 * Netarium - UI権限と操作可否
 */

import { appState } from '../core/state.js';
import { showToast } from './toast.js';

export function isCurrentUserAdmin() {
    return (
        window.APP_CONFIG?.user?.isAdmin ===
        true
    );
}

export function requireNotPinging() {
    if (!appState.isPinging) {
        return true;
    }

    showToast(
        'Ping実行中は編集できません',
        'warning'
    );

    return false;
}

export function requireAdminUiAction() {
    if (!isCurrentUserAdmin()) {
        showToast(
            'この操作を実行する権限がありません',
            'warning'
        );

        return false;
    }

    return requireNotPinging();
}
