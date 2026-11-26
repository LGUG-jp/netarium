import { apiFetch } from './api-client.js';
import { pairKey } from './connection-data.js';
import { hasAnyDeviceDraftChanges } from './device-drafts.js';
import { eventBus } from './event-bus.js';
import { applyRemovedConnectionRoutes } from './resource-save.js';
import { flushSaveQueue, getPendingSave, hasPendingChanges, isSaveInFlight, runResourceMutation,
    updateSaveButtonState } from './save-queue.js';
import { appState, getCurrentView, recalculateNextIds } from './state.js';
import { isCurrentUserAdmin } from '../ui/access-control.js';
import { hasUnappliedLinkPanelChanges, hasUnappliedPanelChanges } from '../ui/property-panel.js';
import { markPending, markSaved } from '../ui/status-bar.js';
import { showToast } from '../ui/toast.js';

export function resolveViewLegacyConflicts(view, data) {
    if (!view) return [];
    const viewId = Number(view.id);
    return data.legacyLinkConflicts.filter(row => Number(row.view_id) === viewId);
}

function requireReviewable(row, requireCurrentView = true) {
    if (!isCurrentUserAdmin() || appState.authExpired) throw new Error('この操作を実行する権限がありません');
    if (appState.isPinging) throw new Error('Ping実行中は旧接続を操作できません');
    if (!appState.legacyLinkConflicts.includes(row) ||
        (requireCurrentView && Number(getCurrentView()?.id) !== Number(row.view_id))) {
        throw new Error('元ビューの旧接続を確認し直してください');
    }
    if (getPendingSave() || hasPendingChanges() || appState.appStatus.dirty || hasAnyDeviceDraftChanges() ||
        hasUnappliedLinkPanelChanges() || hasUnappliedPanelChanges() || appState.viewManagerFormDirty ||
        appState.isFloorPlanUpdating || appState.floorPlanAdjustMode) {
        throw new Error('先に他の画面の未適用・未保存の変更を確認してください');
    }
}

export function assertLegacyLinkReviewable(row) {
    if (isSaveInFlight()) throw new Error('保存中の処理が完了してから旧接続を確認してください');
    requireReviewable(row);
}

export async function excludeLegacyLink(row, { afterConnectionSave = false } = {}) {
    if (isSaveInFlight()) throw new Error('保存中の処理が完了してから旧接続を確認してください');
    const requireCurrentView = !afterConnectionSave;
    requireReviewable(row, requireCurrentView);
    const revision = appState.dataRevision;
    const legacyId = Number(row.legacy_link_id);
    const viewId = Number(row.view_id);
    return runResourceMutation(async () => {
        requireReviewable(row, requireCurrentView);
        if (appState.dataRevision !== revision) throw new Error('元ビューの旧接続を確認し直してください');
        // 個別保存や対象の再読込では保留行を取り込まず、全体世代だけ進む場合がある。
        // 確認済みの旧行が現行データに同じ内容で存在するときだけ、世代を事前条件に除外する。
        const snapshot = await apiFetch('load');
        requireReviewable(row, requireCurrentView);
        const current = snapshot.legacy_link_conflicts?.find(candidate =>
            Number(candidate.legacy_link_id) === legacyId && Number(candidate.view_id) === viewId);
        if (snapshot.ok !== true || snapshot.revision !== revision || appState.dataRevision !== revision ||
            !snapshot.views?.some(view => Number(view.id) === viewId) || JSON.stringify(current) !== JSON.stringify(row)) {
            throw new Error('元ビューまたは旧接続が更新されています。画面を再読み込みしてください');
        }
        const result = await apiFetch('resolve_legacy_link_conflict', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ legacy_link_id: legacyId, view_id: viewId, expected_revision: revision })
        });
        if (result.ok !== true || result.revision !== revision + 1 || result.legacy_link_id !== legacyId ||
            !Array.isArray(result.removed_view_link_routes) || !Array.isArray(result.views)) {
            throw new Error('旧記録の削除結果を確認できません。画面を再読み込みしてください');
        }
        // 移動には追従するが、別データの再読込をこの応答で巻き戻さない。
        if (appState.dataRevision !== revision || !appState.legacyLinkConflicts.includes(row)) {
            throw new Error('通信中にデータが更新されました。画面を再読み込みしてください');
        }
        const localPairs = new Set(appState.links.map(link => pairKey(link.from_id, link.to_id)));
        applyRemovedConnectionRoutes(result.removed_view_link_routes, result.views, localPairs);
        appState.legacyLinkConflicts = appState.legacyLinkConflicts.filter(candidate => candidate !== row);
        appState.dataRevision = result.revision;
        // 送信後に他の変更が確定した場合、保存待ちの状態を上書きしない。
        if (!appState.appStatus.dirty && !hasPendingChanges()) markSaved(result.revision, result.saved_at);
        eventBus.emit('legacy-links:changed');
        return result;
    });
}

export async function saveLegacyLinkReplacement(link, row) {
    const { id, from_id, to_id } = link;
    let savedLink = null;
    const unsubscribe = eventBus.on('resources:saved', data => {
        const savedId = data.id_maps?.links?.[id];
        if (savedId == null) return;
        savedLink ||= data.links?.find(candidate => Number(candidate.id) === Number(savedId) &&
            Number(candidate.from_id) === Number(from_id) && Number(candidate.to_id) === Number(to_id)) ?? null;
    });
    try {
        // キュー全体の結果ではなく、この作成要求の採番と応答行で確定を判定する。
        await flushSaveQueue({ silent: true });
    } finally {
        unsubscribe();
    }
    if (!savedLink) {
        // サーバー拒否など未確定保持でない失敗時は仮接続を戻し、直後に再操作できるようにする。
        if (!getPendingSave() && appState.links.includes(link) && !link.resource_revision) {
            appState.links = appState.links.filter(item => item !== link);
            recalculateNextIds();
            if (hasPendingChanges()) markPending();
            else markSaved(appState.dataRevision, appState.appStatus.lastSavedAt);
            updateSaveButtonState();
            eventBus.emit('legacy-links:changed');
        }
        return false;
    }
    try {
        const result = await excludeLegacyLink(row, { afterConnectionSave: true });
        if (result.audit_warning) {
            showToast('接続を登録し旧記録を削除しましたが、監査ログを記録できませんでした', 'warning');
        } else {
            showToast('接続を登録し、旧記録を削除しました', 'success');
        }
    } catch (error) {
        showToast(`接続は登録済みです。旧記録の削除を完了できませんでした（${error.message}）。` +
            '再読み込み後も残っている旧記録は「旧記録を削除する」で削除できます。', 'warning');
    }
    const created = appState.links.find(item => Number(item.id) === Number(savedLink.id));
    if (created) eventBus.emit('wiring:connection-created', created);
    return true;
}
