/**
 * Netarium - ui/status-bar.js
 */

import { appState } from '../core/state.js';
import { eventBus } from '../core/event-bus.js';
import {
    formatStatusTime,
    normalizeText,
    setTextContent
} from '../core/utils.js';
import {
    getCurrentLinks,
    getCurrentPlacements,
    getCurrentView,
    normalizeStatus
} from '../core/state.js';

/**
 *  ステータスバー描画関数
 */
export function markPending() {
    appState.appStatus.dirty = true;

    if (
        appState.appStatus.state !== 'saving' &&
        appState.appStatus.state !== 'unconfirmed' &&
        appState.appStatus.state !== 'maintenance'
    ) {
        appState.appStatus.state = 'pending';
    }

    renderStatusBar();
}

export function markDirty() {
    markPending();
}


export function markSaved(
    revision,
    savedAt = null
) {
    const conflictCount = (appState.resourceConflicts?.devices?.size || 0) + (appState.resourceConflicts?.views?.size || 0);
    appState.appStatus.dirty = conflictCount > 0;
    appState.appStatus.state = conflictCount > 0 ? 'conflict' : 'saved';
    if (conflictCount === 0) appState.appStatus.lastError = null;

    if (
        Number.isInteger(Number(revision)) &&
        Number(revision) >= 0
    ) {
        appState.dataRevision =
            Number(revision);
    }

    appState.appStatus.lastSavedAt =
        savedAt || new Date();

    const confirmBtn = document.getElementById('status-confirm-save-btn');
    if (confirmBtn) {
        confirmBtn.hidden = true;
    }

    renderStatusBar();
}


export function markSaveError(message) {
    appState.appStatus.dirty = true;
    appState.appStatus.state = 'error';
    appState.appStatus.lastError =
        normalizeText(message);

    renderStatusBar();
}


export function markConflict(message) {
    appState.appStatus.dirty = true;
    appState.appStatus.state = 'conflict';
    appState.appStatus.lastError =
        normalizeText(message);

    renderStatusBar();
}

export function markMaintenance(message) {
    appState.appStatus.dirty = true;
    appState.appStatus.state = 'maintenance';
    appState.appStatus.lastError = normalizeText(message);
    renderStatusBar();
}

export function markUnconfirmed(message) {
    appState.appStatus.dirty = true;
    appState.appStatus.state = 'unconfirmed';
    appState.appStatus.lastError = normalizeText(message);

    renderStatusBar();
}


export function renderStatusBar() {
    const currentView =
        getCurrentView();

    setTextContent(
        'status-view-name',
        currentView
            ? `ビュー: ${currentView.name}`
            : 'ビュー: -'
    );

    setTextContent(
        'status-view-type',
        currentView
            ? (
                currentView.view_type ===
                'floor'
                    ? '種別: 物理'
                    : '種別: 論理'
            )
            : '種別: -'
    );

    setTextContent(
        'status-placement-count',
        `${getCurrentPlacements().length}機器`
    );

    setTextContent(
        'status-link-count',
        `${getCurrentLinks().length}接続`
    );

    const selectionCount =
        appState.selectedPlacementIds instanceof Set
            ? appState.selectedPlacementIds.size
            : 0;

    setTextContent(
        'status-selection-count',
        `${selectionCount}選択`
    );
    const counts = {
        green: 0,
        red: 0,
        unknown: 0
    };

    appState.devices.forEach(device => {
        const status =
            normalizeStatus(device.status);

        if (status === 'green') {
            counts.green++;
        } else if (status === 'red') {
            counts.red++;
        } else {
            counts.unknown++;
        }
    });

    setTextContent(
        'status-ok-count',
        counts.green
    );

    setTextContent(
        'status-ng-count',
        counts.red
    );

    setTextContent(
        'status-unknown-count',
        counts.unknown
    );

    setTextContent(
        'status-revision',
        appState.dataRevision > 0
            ? `Rev. ${appState.dataRevision}`
            : 'Rev. -'
    );

    setTextContent(
        'status-last-saved',
        appState.appStatus.lastSavedAt
            ? `最終保存: ${formatStatusTime(
                appState.appStatus.lastSavedAt
            )}`
            : '最終保存: -'
    );

    setTextContent(
    'status-last-monitored',
    appState.appStatus.lastMonitoredAt
        ? `最終監視: ${formatStatusTime(
            appState.appStatus.lastMonitoredAt
        )}`
        : '最終監視: -'
    );


    const stateElement =
        document.getElementById(
            'status-save-state'
        );

    if (!stateElement) {
        return;
    }

    const stateMap = {
        saved: {
            label: '✓ 保存済み',
            className: 'status-saved'
        },
        pending: {
            label: '… 保存待ち',
            className: 'status-dirty'
        },
        dirty: {
            label: '… 保存待ち',
            className: 'status-dirty'
        },
        saving: {
            label: '⟳ 保存中',
            className: 'status-saving'
        },
        error: {
            label: '! 保存失敗',
            className: 'status-error'
        },
        conflict: {
            label: '! 競合あり',
            className: 'status-conflict'
        },
        maintenance: {
            label: '保守待機（未受理）: 終了後に「保存」で再開',
            className: 'status-dirty'
        },
        unconfirmed: {
            label: '? 未確認',
            className: 'status-unconfirmed'
        }
    };

    const state =
        stateMap[appState.appStatus.state] ||
        stateMap.saved;

    stateElement.className =
        `status-save-state ${state.className}`;

    const conflicts = [
        ...appState.resourceConflicts?.devices?.values() || [],
        ...appState.resourceConflicts?.views?.values() || []
    ];
    if (conflicts.length) stateElement.classList.add('status-conflict');
    stateElement.textContent = state.label +
        (conflicts.length && appState.appStatus.state !== 'conflict' ? ` / 競合 ${conflicts.length}件` :
            conflicts.length ? ` (${conflicts.length}件)` : '');
    stateElement.title = [
        appState.appStatus.lastError,
        ...conflicts.map(item => `${item.kind === 'devices' ? '機器' : 'ビュー'}「${item.name || item.id}」: ${item.message}`)
    ].filter(Boolean).join('\n');

    const confirmBtn = document.getElementById('status-confirm-save-btn');
    if (confirmBtn) {
        confirmBtn.hidden = appState.appStatus.state !== 'unconfirmed';
    }
    if (typeof eventBus !== 'undefined' && eventBus.emit) {
        eventBus.emit('save-state:changed', appState.appStatus.state);
    }
}

if (typeof eventBus !== 'undefined' && eventBus.on) {
    eventBus.on('canvas:selection-changed', () => {
        const selectionCount =
            appState.selectedPlacementIds instanceof Set
                ? appState.selectedPlacementIds.size
                : 0;
        setTextContent(
            'status-selection-count',
            `${selectionCount}選択`
        );
    });
}


