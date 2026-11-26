import { appState } from './state.js';
import { apiFetch } from './api-client.js';
import { eventBus } from './event-bus.js';
import { hasAnyDeviceDraftChanges } from './device-drafts.js';
import { getPendingSave, hasPendingChanges, runResourceMutation } from './save-queue.js';
import { findEnabledBuilding } from './building-view-model.js';
import { isCurrentUserAdmin } from '../ui/access-control.js';
import { hasUnappliedPanelChanges, hasUnappliedLinkPanelChanges } from '../ui/property-panel.js';

function requireEditable() {
    if (!isCurrentUserAdmin() || appState.authExpired || appState.isPinging) {
        throw new Error('権限・認証状態またはPing実行中でないことを確認してください。入力は保持しています。');
    }
    if (getPendingSave() || hasPendingChanges() || hasAnyDeviceDraftChanges() || appState.viewManagerFormDirty ||
        hasUnappliedPanelChanges() || hasUnappliedLinkPanelChanges() || appState.isFloorPlanUpdating || appState.floorPlanAdjustMode ||
        appState.resourceConflicts?.devices?.size || appState.resourceConflicts?.views?.size) {
        throw new Error('他の画面に未保存の変更があります。先に適用・保存してください。入力は保持しています。');
    }
}

function transformFields(floor) {
    return { scale: floor?.scale, offset_x: floor?.offset_x, offset_y: floor?.offset_y, rotation: floor?.rotation };
}

function isValidTransform(values) {
    return Number.isFinite(values.scale) && values.scale > 0 &&
        Number.isFinite(values.offset_x) && Number.isFinite(values.offset_y) &&
        Number.isFinite(values.rotation) && values.rotation >= -180 && values.rotation <= 180;
}

function isPositiveInteger(value) {
    return Number.isSafeInteger(value) && value > 0;
}

function isValidFloorBaseline(floor) {
    return isPositiveInteger(floor.building_id) &&
        (floor.representative_view_id === null || isPositiveInteger(floor.representative_view_id)) &&
        isValidTransform(floor);
}

function findFloor(floors, floorId) {
    return floors.find(floor => Number(floor.id) === floorId);
}

export async function loadBuildingFloorTransform(floorId) {
    const data = await apiFetch('building_hierarchy', { method: 'GET' });
    if (data.ok !== true || !isPositiveInteger(data.revision) || !Array.isArray(data.floors) || !Array.isArray(data.buildings)) {
        throw new Error('フロア座標変換の最新情報を取得できませんでした。');
    }
    const floor = findFloor(data.floors, floorId) ?? null;
    if (floor !== null && !isValidFloorBaseline(floor)) {
        throw new Error('フロア座標変換の最新情報を取得できませんでした。');
    }
    const buildingEnabled = floor !== null && Boolean(findEnabledBuilding(data, floor.building_id));
    // 復旧確認用の読み込みでは共有のデータ・保存世代を更新しない。
    return { floor, buildingEnabled, revision: data.revision };
}

/**
 * 建物表示用の変換だけを保存する。元ビュー・機器・図面の座標には適用しない。
 * 保存は対象行の世代だけを確認する。共有の全体世代は飛び番なら取り込まない。
 * @param {number} floorId
 * @param {{scale: number, offset_x: number, offset_y: number, rotation: number}} transform
 * @param {object} expectedFloor フロア変換を編集し始めた時点の行
 * @returns {Promise<object>} 保存されたフロア行
 */
export async function saveBuildingFloorTransform(floorId, transform, expectedFloor) {
    // キュー待機中に呼出元の入力オブジェクトが変わっても送信値は変えない。
    const values = transformFields(transform);
    const expected = { building_id: expectedFloor?.building_id,
        representative_view_id: expectedFloor?.representative_view_id, ...transformFields(expectedFloor) };
    let requestSent = false;
    try {
        if (!isPositiveInteger(floorId) || !isValidTransform(values) || !isValidFloorBaseline(expected)) {
            throw new Error('フロア座標変換が不正です。');
        }
        return await runResourceMutation(async () => {
            requireEditable();
            const floor = findFloor(appState.floors, floorId);
            if (!floor) {
                throw new Error('対象のフロアが見つかりません。最新情報を確認してください。');
            }
            if (!findEnabledBuilding(appState, floor.building_id)) {
                throw new Error('この建物では建物ビューを使用できません。入力は保持しています。');
            }
            const sharedRevision = appState.dataRevision;
            const originalFloor = JSON.stringify(floor);
            const body = JSON.stringify({ operation: 'update_floor_transform', id: floorId,
                ...values, expected_floor: expected });
            requestSent = true;
            const data = await apiFetch('building_hierarchy', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body
            });
            // 応答待ちで別画面が編集・再読込された場合、その入力や保存世代を巻き戻さない。
            requireEditable();
            if (appState.dataRevision !== sharedRevision || JSON.stringify(findFloor(appState.floors, floorId)) !== originalFloor) {
                throw new Error('通信中に他の操作で更新されました。入力を保持したまま最新情報を確認してください。');
            }
            if (data.ok !== true || !isPositiveInteger(data.revision) || data.revision <= sharedRevision ||
                Number(data.floor?.id) !== floorId || !isValidFloorBaseline(data.floor)) {
                throw new Error('フロア座標変換の保存応答が不完全です。入力を保持したまま保存状態を確認してください。');
            }
            appState.floors = appState.floors.map(row => Number(row.id) === floorId ? data.floor : row);
            // 見えていない他の変更を、全体保存の基準として承認しない。
            if (data.revision === sharedRevision + 1) {
                appState.dataRevision = data.revision;
            }
            // markSavedは他画面のdirty表示まで消すため呼ばない。パネル自身が保存完了を扱う。
            eventBus.emit('hierarchy:changed');
            return data.floor;
        });
    } catch (error) {
        if (!requestSent) error.requestNotSent = true;
        throw error;
    }
}
