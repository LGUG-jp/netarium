/**
 * Netarium - 共通保存キュー (Save Queue)
 *
 * 機器・ビュー・配置・リンク・メモの保存要求を直列化し、
 * 確定済みデータの保存要求・再試行・対象別競合制御・状態表示を共通管理する。
 */

import { appState, validateAllDataBeforeSave } from './state.js';
import { eventBus } from './event-bus.js';
import { hasDeviceDraftChanges } from './device-drafts.js';
import { apiFetch, handleAuthExpired } from './api-client.js';
import {
    applyResourceSaveResult,
    buildResourceSave,
    confirmedResourceResult,
    buildSaveableResourceSave,
    createPendingResourceSave,
    inspectPendingResourceSave,
    hasResourceChangesSince,
    reloadResourceFromData,
    resourceSaveValidationData,
    syncResourceRevision,
    viewResource
} from './resource-save.js';
import {
    markConflict,
    markMaintenance,
    markPending,
    markSaveError,
    markSaved,
    markUnconfirmed,
    renderStatusBar
} from '../ui/status-bar.js';
import { showToast, showStatusMessage } from '../ui/toast.js';
import { isCurrentUserAdmin, requireAdminUiAction } from '../ui/access-control.js';
import { render } from '../canvas/renderer.js';

let pendingSave = null;
let debounceTimer = null;
let activeSavePromise = null;
let hasQueuedSave = false;
let queuedSilent = true;
let saveGeneration = 0;
let activeConfirmation = null;
const reloadingResources = new Map();
// 図面は専用APIを使うが、ビューと同じ世代を進めるため共通キューで送る。
const floorPlanSaves = new Map();

export function scheduleFloorPlanSave(plan) {
    if (!isCurrentUserAdmin() || appState.authExpired) return;
    const snapshot = { view_id: Number(plan.view_id), x: Number(plan.x), y: Number(plan.y),
        scale: Number(plan.scale), opacity: Number(plan.opacity), is_visible: plan.is_visible ? 1 : 0 };
    floorPlanSaves.set(snapshot.view_id, snapshot);
    markPending();
    scheduleSave({ immediate: true });
}

function hasFloorPlanSaves({ saveable = false } = {}) {
    return [...floorPlanSaves.keys()].some(id => !saveable || !hasResourceConflict('views', id));
}

function holdForMaintenance(error) {
    pendingSave.maintenanceRejected = true;
    pendingSave.operationId = error.operationId;
    clearTimeout(debounceTimer);
    debounceTimer = null;
    hasQueuedSave = false;
    markMaintenance(error.message);
    showToast(error.message, 'warning');
}

function finishFloorPlanSave(data, snapshot) {
    if (!Number.isInteger(data?.revision) || !Number.isInteger(data?.view_revision) ||
        data.view_revision <= 0 || !Number.isInteger(data?.floor_plan_settings?.revision) ||
        data.floor_plan_settings.revision <= 0) {
        throw new Error('図面設定の保存応答が不完全です。保存状態を確認してください');
    }
    syncResourceRevision('views', snapshot.view_id, data.view_revision);
    appState.dataRevision = Number(data.revision);
    const plan = appState.floorPlans.find(row => Number(row.view_id) === snapshot.view_id);
    if (plan) {
        // 応答で操作中/後続操作の座標を巻き戻さない。
        plan.revision = Number(data.floor_plan_settings?.revision) || plan.revision;
        plan.updated_at = data.floor_plan_settings?.updated_at || plan.updated_at;
    }
    if (floorPlanSaves.get(snapshot.view_id) === snapshot) floorPlanSaves.delete(snapshot.view_id);
    markSaved(data.revision, data.saved_at || new Date());
    if (hasSaveableChanges()) markPending();
    eventBus.emit('floor-plan:saved', { viewId: snapshot.view_id });
}

async function executeFloorPlanSave(snapshot) {
    const view = appState.views.find(row => Number(row.id) === snapshot.view_id);
    if (!view || !appState.floorPlans.some(row => Number(row.view_id) === snapshot.view_id)) {
        floorPlanSaves.delete(snapshot.view_id);
        return true;
    }
    const generation = saveGeneration;
    const pending = { floorPlan: snapshot, expectedRevision: view.resource_revision,
        viewSnapshot: JSON.stringify(viewResource(appState, view)),
        imageRevision: Number(appState.floorPlans.find(row => Number(row.view_id) === snapshot.view_id).revision) };
    try {
        appState.isSaving = true;
        appState.appStatus.state = 'saving';
        pendingSave = pending;
        renderStatusBar();
        updateSaveButtonState();
        const data = await apiFetch('update_floor_plan_settings', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...snapshot, expected_revision: pending.expectedRevision })
        });
        if (generation !== saveGeneration || pendingSave !== pending) return false;
        if (data?.ok !== true) {
            throw new Error('図面設定の保存成功を確認できません。保存状態を確認してください');
        }
        finishFloorPlanSave(data, snapshot);
        pendingSave = null;
        return true;
    } catch (error) {
        if (generation !== saveGeneration) return false;
        if (error.maintenanceRejected) {
            holdForMaintenance(error);
        } else if (error.status === 401) {
            pendingSave = null;
            handleAuthExpired();
        } else if (error.apiRejected && error.status === 409 && Array.isArray(error.details?.conflicts) && error.details.conflicts.length > 0) {
            pendingSave = null;
            rememberConflicts(error.details?.conflicts,
                { devices: [], views: [{ id: snapshot.view_id }] }, error.message);
            showToast(`図面設定の保存競合: ${error.message}。ビュー管理から最新データを再読込してください`, 'warning');
            return hasSaveableChanges();
        } else if ((error.apiRejected && error.status < 500) || error.requestNotSent) {
            pendingSave = null;
            markSaveError(error.message);
            showToast(`図面設定の保存エラー: ${error.message}。「保存」で再試行できます`, 'error');
        } else {
            markUnconfirmed('図面設定の保存成否を確認できません。「保存状態を確認」を実行してください');
            showToast('図面設定の保存状態が未確認です。確定値を保持しています', 'error');
        }
        return false;
    } finally {
        appState.isSaving = false;
        renderStatusBar();
        updateSaveButtonState();
    }
}

function inspectFloorPlanSave(pending, data) {
    const snapshot = pending.floorPlan;
    const view = data.views?.find(row => Number(row.id) === snapshot.view_id);
    const plan = data.floor_plans?.find(row => Number(row.view_id) === snapshot.view_id);
    // 図面だけの一致で、他画面の配置/リンク/メモを最新世代付きで上書きしない。
    if (!view || JSON.stringify(viewResource(data, view)) !== pending.viewSnapshot) return 'conflict';
    if (Number(view.resource_revision) === Number(pending.expectedRevision)) return 'retry';
    if (plan && ['x', 'y', 'scale', 'opacity', 'is_visible'].every(key =>
        Math.abs(Number(plan[key]) - snapshot[key]) < 0.0001)) {
        return Number(plan.revision) === pending.imageRevision + 1 ? 'saved' : 'conflict';
    }
    return 'conflict';
}

eventBus.on('resource:reloaded', ({ kind, id }) => {
    if (kind === 'views') floorPlanSaves.delete(Number(id));
});

function conflicts() {
    appState.resourceConflicts ||= { devices: new Map(), views: new Map() };
    return appState.resourceConflicts;
}

export function hasResourceConflict(kind, id) {
    return Boolean(conflicts()[kind]?.has(Number(id)));
}

export function isSaveInFlight() {
    return activeSavePromise !== null || activeConfirmation !== null || appState.isSaving;
}

// 画像登録など、全体revisionを使う操作は進行中の保存応答を反映してから開始する。
// debounce待機中の変更や未適用下書きは、この待機で確定・保存しない。
export async function waitForActiveResourceSave() {
    while (activeSavePromise !== null || activeConfirmation !== null) {
        await (activeSavePromise || activeConfirmation);
    }
}

let activeResourceMutation = Promise.resolve();

// 図面ファイルも共通保存の応答反映後に世代を読み、通信中は次の保存を待たせる。
export async function runResourceMutation(operation) {
    const run = async () => {
        await waitForActiveResourceSave();
        if (pendingSave || appState.authExpired) throw new Error('保留中の保存状態を確認してください');
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        activeSavePromise = gate;
        appState.isSaving = true;
        updateSaveButtonState();
        try {
            return await operation();
        } finally {
            release();
            if (activeSavePromise === gate) activeSavePromise = null;
            appState.isSaving = activeSavePromise !== null;
            updateSaveButtonState();
            if (hasQueuedSave && !pendingSave) scheduleSave({ immediate: true });
        }
    };
    const next = activeResourceMutation.then(run, run);
    activeResourceMutation = next.catch(() => {});
    return next;
}

export function hasSaveableChanges() {
    try {
        const payload = buildSaveableResourceSave();
        return payload.devices.length > 0 || payload.views.length > 0 || hasFloorPlanSaves({ saveable: true });
    } catch (_) {
        return false;
    }
}

export function hasResourceChanges(kind, id) {
    try {
        return Boolean(buildResourceSave()[kind]?.some(row => row.id === Number(id)));
    } catch (_) {
        return false;
    }
}

function rememberConflicts(items, payload, message) {
    const identified = (Array.isArray(items) ? items : []).filter(item =>
        ['devices', 'views'].includes(item.kind) && (payload[item.kind] || []).some(row => row.id === Number(item.id)));
    const targets = identified.length ? identified : ['devices', 'views'].flatMap(kind =>
        (payload[kind] || []).map(row => ({ kind, id: row.id,
            name: row.device?.name || row.view?.name ||
                appState[kind].find(item => Number(item.id) === Number(row.id))?.name || `ID ${row.id}` })));
    for (const item of targets) conflicts()[item.kind].set(Number(item.id), { ...item, message });
    markConflict(message);
}
/**
 * 保留中の未確認保存情報を取得
 */
export function getPendingSave() {
    return pendingSave;
}

/**
 * 保留中の未確認保存情報をクリア
 */
export function clearPendingSave() {
    clearTimeout(debounceTimer);
    debounceTimer = null;
    saveGeneration++;
    pendingSave = null;
    activeConfirmation = null;
    floorPlanSaves.clear();
    hasQueuedSave = false;
    queuedSilent = true;
    appState.isSaving = activeSavePromise !== null;
    conflicts().devices.clear();
    conflicts().views.clear();
    updateSaveButtonState();
}

/**
 * 未保存の差分があるかを判定
 */
export function hasPendingChanges() {
    try {
        const payload = buildResourceSave();
        return payload.devices.length > 0 || payload.views.length > 0 || hasFloorPlanSaves();
    } catch (_) {
        return false;
    }
}

/**
 * 上部「保存」ボタン等の活性条件を同期
 */
export function updateSaveButtonState() {
    if (typeof document === 'undefined') return;
    const saveBtn = document.getElementById('saveBtn');
    const ledgerSaveBtn = document.getElementById('ledger-save-btn');
    const ledgerSheetSaveBtn = document.getElementById('ledger-sheet-save-btn');

    const buttons = [
        { el: saveBtn, name: '保存' },
        { el: ledgerSaveBtn, name: '適用' },
        { el: ledgerSheetSaveBtn, name: '適用' }
    ].filter(item => Boolean(item.el));

    if (buttons.length === 0) return;

    const setButtonState = (disabled, titleFn) => {
        for (const { el, name } of buttons) {
            el.disabled = disabled;
            el.title = typeof titleFn === 'function' ? titleFn(name) : titleFn;
        }
    };

    if (!isCurrentUserAdmin() || appState.authExpired) {
        setButtonState(
            true,
            name => appState.authExpired
                ? '認証が失効しているため保存できません。別タブで再認証後に新画面へ再入力してください'
                : `${name} (管理者権限が必要です)`
        );
        return;
    }

    const remaining = hasSaveableChanges() &&
        (!pendingSave || !appState.isSaving || pendingSave.floorPlan || hasResourceChangesSince(pendingSave));
    const maintenance = pendingSave?.maintenanceRejected === true;
    const unconfirmed = pendingSave !== null && !maintenance && (activeConfirmation !== null || !appState.isSaving);
    for (const { el, name } of buttons) {
        const sheetId = Number(ledgerSheetSaveBtn?.dataset?.deviceId);
        const isSheet = el === ledgerSheetSaveBtn;
        const sheetConflict = isSheet && hasResourceConflict('devices', sheetId);
        const draft = isSheet
            ? hasDeviceDraftChanges('sheet', sheetId)
            : el === ledgerSaveBtn ? hasDeviceDraftChanges('ledger') : false;
        const retry = isSheet && !isSaveInFlight() && !unconfirmed && hasResourceChanges('devices', sheetId);
        const saveable = maintenance || (isSheet ? draft || sheetConflict || retry : remaining || draft || hasQueuedSave);
        el.disabled = (unconfirmed && !draft) || !saveable ||
            (isSheet && sheetConflict && isSaveInFlight() && !draft);
        if (sheetConflict) {
            el.textContent = '競合を再読込';
            el.title = 'この機器の編集を破棄して最新データを再読込します';
            continue;
        }
        const actionName = draft ? '適用' : '保存';
        if (isSheet || el === ledgerSaveBtn) el.textContent = actionName;
        el.title = maintenance
            ? '保守作業で未受理の保存と入力を保持しています。保守終了後に「保存」で明示的に再開します'
            : unconfirmed
            ? '保存状態が未確認です。「保存状態を確認」を実行してください'
            : remaining || draft
                ? draft
                    ? '未適用の入力を適用し、自動保存します'
                    : `確定済みの変更を${isSaveInFlight() ? '保存中の処理の完了後に送信' : '送信・再試行'}します。未適用の入力は確定しません`
                : hasPendingChanges()
                    ? '競合対象と依存する変更は保留中です。対象の最新データを再読込してください'
                    : `${actionName} (変更はありません)`;
    }
}

/**
 * 保存要求をキューに投入する
 *
 * @param {Object} options
 * @param {number} [options.debounceMs=800] - debounce待機時間 (ms)
 * @param {boolean} [options.immediate=false] - true の場合はdebounceをスキップして即時flush
 * @param {boolean} [options.silent=true] - 自動保存時はtrue (トーストを出さない)
 */
export function scheduleSave({ debounceMs = 800, immediate = false, silent = true } = {}) {
    if (!isCurrentUserAdmin() || appState.authExpired) {
        return;
    }

    if (pendingSave !== null && !appState.isSaving) return;

    if (immediate || debounceMs <= 0) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
        flushSaveQueue({ silent, resumeMaintenance: false });
        return;
    }

    // debounce待機中のマーク
    markPending();
    updateSaveButtonState();

    clearTimeout(debounceTimer);

    debounceTimer = setTimeout(() => {
        debounceTimer = null;
        flushSaveQueue({ silent, resumeMaintenance: false });
    }, debounceMs);
}

/**
 * キューに溜まっている保存要求を即時フラッシュする
 *
 * @param {Object} options
 * @param {boolean} [options.silent=false]
 * @returns {Promise<boolean>}
 */
// silent=false の既存「保存」「適用」操作だけが保守待機を明示解除する。
// 自動保存・画面遷移は silent=true または resumeMaintenance=false を使う。
export async function flushSaveQueue({ silent = false, resumeMaintenance = !silent } = {}) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
    if (activeConfirmation !== null) return false;

    // 既に保存通信が走っている場合は、直列化キューに積んで現在の完了を待つ
    if (activeSavePromise !== null) {
        hasQueuedSave = true;
        if (!silent) queuedSilent = false;
        updateSaveButtonState();
        return activeSavePromise;
    }
    if (pendingSave?.maintenanceRejected) {
        if (!resumeMaintenance) return false;
        // 拒否時のsnapshotはここまで保持。最新の確定入力を再構築し後続編集も送る。
        pendingSave = null;
    }

    activeSavePromise = (async () => {
        try {
            let lastResult = true;
            while (true) {
                const currentSilent = queuedSilent ? silent : false;
                queuedSilent = true;
                hasQueuedSave = false;
                const generation = saveGeneration;

                lastResult = await executeSave({ silent: currentSilent });
                if (!lastResult) {
                    if (generation !== saveGeneration && hasQueuedSave && pendingSave === null) {
                        continue;
                    }
                    break;
                }

                // 保存中に発生した追加変更（同一機器の再編集など）があるか検査
                if (!hasSaveableChanges()) {
                    break;
                }

                // 残余差分がある場合は、新しいresource_revisionで直ちに再保存する
                markPending();
            }
            return lastResult;
        } finally {
            activeSavePromise = null;
            updateSaveButtonState();
            eventBus.emit('save-state:changed', appState.appStatus.state);
        }
    })();

    return activeSavePromise;
}

/**
 * 実際の1回分の保存処理
 */
async function executeSave({ silent = false } = {}) {
    if (!requireAdminUiAction()) {
        return false;
    }

    if (appState.authExpired) {
        return false;
    }

    if (pendingSave !== null) {
        showToast('確定状況が未確認の保存があります。「保存状態を確認」を実行してください', 'warning');
        return false;
    }

    const myGeneration = saveGeneration;

    try {
        appState.isSaving = true;
        const payload = buildSaveableResourceSave();
        validateAllDataBeforeSave(resourceSaveValidationData(payload));
        appState.appStatus.state = 'saving';
        renderStatusBar();
        updateSaveButtonState();

        if (payload.devices.length === 0 && payload.views.length === 0) {
            const snapshot = [...floorPlanSaves.values()].find(row => !hasResourceConflict('views', row.view_id));
            if (snapshot) return await executeFloorPlanSave(snapshot);
            markSaved(appState.dataRevision, appState.appStatus.lastSavedAt);
            updateSaveButtonState();
            return true;
        }
        const currentPending = createPendingResourceSave(payload);
        pendingSave = currentPending;
        updateSaveButtonState();
        const data = await apiFetch('save_resources', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (myGeneration !== saveGeneration || pendingSave !== currentPending) {
            return false;
        }
        if (data?.ok !== true) {
            throw new Error('保存成功を確認できません。保存状態を確認してください');
        }

        finishResourceSave(data, currentPending, { silent });
        pendingSave = null;
        return true;
    } catch (err) {
        if (myGeneration !== saveGeneration) {
            return false;
        }

        if (err.maintenanceRejected && pendingSave) {
            holdForMaintenance(err);
            return false;
        }
        if (err.status === 401) {
            pendingSave = null;
            handleAuthExpired();
            return false;
        }
        if (err.apiRejected && err.status === 409) {
            if (err.details?.reason === 'id_exhausted') {
                pendingSave = null;
                markSaveError(err.message);
                showToast(`保存エラー: ${err.message}`, 'error');
                return false;
            }
            const failed = pendingSave?.payload || { devices: [], views: [] };
            pendingSave = null;
            rememberConflicts(err.details?.conflicts, failed, err.message);
            showToast(`保存競合: ${err.message}。競合対象は保留し、それ以外の変更を保存します`, 'warning');
            return hasSaveableChanges();
        }

        if ((err.apiRejected && err.status < 500) || pendingSave === null || err.requestNotSent) {
            pendingSave = null;
            markSaveError(err.message);
            showToast(`保存エラー: ${err.message}`, 'error');
            return false;
        }

        // 5xx応答・通信断など成否を断定できない場合は、保留スナップショットを維持する
        markUnconfirmed('サーバーでの保存成否を確認できませんでした。保存状態を確認してください');
        console.error(err);
        showToast('保存の確定状況が未確認です。「保存状態を確認」を実行してください', 'error');
        return false;

    } finally {
        appState.isSaving = false;
        renderStatusBar();
        updateSaveButtonState();
    }
}

/**
 * 保存成功時のステート反映とイベント通知
 */
function finishResourceSave(data, pending = pendingSave, { silent = false } = {}) {
    const maps = applyResourceSaveResult(data, pending);
    eventBus.emit('resources:ids-remapped', maps);
    const monitorRevision = Number(data.monitor_revision);
    if (Number.isInteger(monitorRevision)) {
        appState.monitorRevision = monitorRevision;
    }
    markSaved(data.revision, data.saved_at || new Date());
    if (hasSaveableChanges()) markPending();
    eventBus.emit('resources:saved', data);
    eventBus.emit('view:render-selector');
    eventBus.emit('ledger:render');
    eventBus.emit('device-search:render-results');
    render();

    if (!silent && data.post_processing_required) {
        showToast(data.message || '保存後に確認が必要な処理があります', 'warning');
    }
}

/**
 * 保留中保存の整合確認
 */
export function confirmPendingSave() {
    if (activeConfirmation) return activeConfirmation;
    if (pendingSave?.maintenanceRejected) {
        showStatusMessage('保守作業で保存は未受理です。入力を保持しています。保守終了後に「保存」で再開してください');
        return Promise.resolve('maintenance');
    }
    if (!pendingSave || activeSavePromise !== null) {
        if (!pendingSave) showStatusMessage('確認対象の保留中保存はありません');
        return Promise.resolve('retry');
    }
    const pending = pendingSave;
    const generation = saveGeneration;
    const isCurrent = () => generation === saveGeneration && pendingSave === pending;
    const operation = (async () => {
        try {
            appState.isSaving = true;
            renderStatusBar();
            updateSaveButtonState();
            const dbData = await apiFetch('load');
            if (!isCurrent()) return 'stale';
            const result = pending.floorPlan ? inspectFloorPlanSave(pending, dbData) : inspectPendingResourceSave(pending, dbData);
            if (result === 'retry') {
                pendingSave = null;
                appState.appStatus.state = 'pending';
                markPending();
                showStatusMessage('対象リソースは更新されていませんでした。再度「保存」を実行できます');
            } else if (result === 'saved') {
                if (pending.floorPlan) {
                    const plan = dbData.floor_plans.find(row => Number(row.view_id) === pending.floorPlan.view_id);
                    const view = dbData.views.find(row => Number(row.id) === pending.floorPlan.view_id);
                    finishFloorPlanSave({ revision: dbData.revision, saved_at: dbData.saved_at,
                        view_revision: view.resource_revision, floor_plan_settings: plan }, pending.floorPlan);
                } else finishResourceSave(confirmedResourceResult(pending, dbData), pending, { silent: true });
                pendingSave = null;
            } else if (result === 'conflict') {
                pendingSave = null;
                if (pending.floorPlan) {
                    rememberConflicts(null, { devices: [], views: [{ id: pending.floorPlan.view_id }] },
                        '対象ビューが変更されています。最新データを再読込してください');
                } else {
                    const targets = ['devices', 'views'].flatMap(kind => pending.payload[kind]
                        .filter(operation => {
                            const row = (dbData[kind] || []).find(row => Number(row.id) === operation.id);
                            return !row || Number(row.resource_revision) !== operation.expected_revision;
                        }).map(operation => ({ kind, id: operation.id,
                            name: (dbData[kind] || []).find(row => Number(row.id) === operation.id)?.name || '削除済み' })));
                    rememberConflicts(targets, pending.payload, '対象リソースが変更されています。対象の最新データを再読込してください');
                }
                showToast('保存対象の競合を確認しました。競合対象の最新データを再読込してください', 'warning');
            } else {
                markUnconfirmed('新規作成のID対応を確認できません。重複を避けるため再送できません。最新データを再読込してください');
                showToast('新規作成の保存状態は確定できません。再保存せず最新データを再読込してください', 'warning');
            }
            return result;
        } catch (error) {
            if (!isCurrent()) return 'stale';
            if (error.status === 401) handleAuthExpired();
            else {
                markUnconfirmed('確認通信に失敗しました。時間をおいて再確認してください');
                showToast(`保存状態の確認に失敗しました: ${error.message}`, 'error');
            }
            return 'unknown';
        } finally {
            if (generation === saveGeneration) {
                appState.isSaving = false;
                renderStatusBar();
                updateSaveButtonState();
            }
        }
    })();
    activeConfirmation = operation;
    operation.then(result => {
        if (activeConfirmation === operation) {
            activeConfirmation = null;
            updateSaveButtonState();
            eventBus.emit('save-state:changed', appState.appStatus.state);
            if ((result === 'saved' || result === 'conflict') && hasSaveableChanges()) {
                flushSaveQueue({ silent: true });
            }
        }
    });
    return operation;
}

export function reloadConflictedResource(kind, id) {
    id = Number(id);
    const key = `${kind}:${id}`;
    if (reloadingResources.has(key)) return reloadingResources.get(key);
    if (!hasResourceConflict(kind, id) || isSaveInFlight() || pendingSave) return Promise.resolve(false);
    const conflict = conflicts()[kind].get(id);
    if (!confirm(`「${conflict.name || `ID ${id}`}」の編集を破棄し最新データを再読込しますか？ 関連する配置・接続・メモや必要な機器の削除も整理されます。その他の入力は保持します。`)) {
        return Promise.resolve(false);
    }
    const generation = saveGeneration;
    const operation = (async () => {
        try {
            const data = await apiFetch('load');
            if (generation !== saveGeneration || conflicts()[kind].get(id) !== conflict || isSaveInFlight()) return false;
            const maps = reloadResourceFromData(kind, id, data);
            eventBus.emit('resources:ids-remapped', maps);
            conflicts()[kind].delete(id);
            eventBus.emit('resource:reloaded', { kind, id });
            if (hasSaveableChanges()) {
                appState.appStatus.state = 'pending';
                markPending();
                scheduleSave({ silent: true });
            } else markSaved(data.revision, data.saved_at);
            eventBus.emit('view:render-selector');
            eventBus.emit('ledger:render');
            eventBus.emit('device-search:render-results');
            render();
            updateSaveButtonState();
            return true;
        } catch (error) {
            if (generation !== saveGeneration) return false;
            if (error.status === 401) handleAuthExpired();
            else showToast(`対象の再読込に失敗しました: ${error.message}`, 'error');
            return false;
        } finally {
            if (reloadingResources.get(key) === operation) reloadingResources.delete(key);
        }
    })();
    reloadingResources.set(key, operation);
    return operation;
}

eventBus.on('device-drafts:changed', updateSaveButtonState);

/**
 * 共通機器属性更新・保存インターフェース (#97等から利用)
 *
 * @param {number} deviceId - 更新対象の機器ID
 * @param {Object} updates - 更新フィールドのマップ
 * @param {Object} [options]
 * @param {boolean} [options.immediate=true] - 即時保存するかどうか
 * @param {boolean} [options.silent=true] - 自動保存時はtrue
 * @returns {boolean}
 */
export function saveDeviceProperties(deviceId, updates = {}, { immediate = true, silent = true } = {}) {
    const device = appState.devices.find(d => Number(d.id) === Number(deviceId));
    if (!device) {
        return false;
    }

    let changed = false;
    for (const [key, val] of Object.entries(updates)) {
        if (device[key] !== val) {
            device[key] = val;
            changed = true;
        }
    }

    if (changed) {
        markPending();
        scheduleSave({ debounceMs: immediate ? 0 : 800, immediate, silent });
    }
    return true;
}
