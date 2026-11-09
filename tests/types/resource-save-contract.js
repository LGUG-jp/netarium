// @ts-check
// 型チェック専用。実行しない。本体の検査範囲とは区別する（docs/development.md #393）。
import { buildResourceSave, buildSaveableResourceSave, createResourceBaseline, mappedResourceId, viewResource } from '../../public/js/core/resource-save.js';

/** @type {import('../../public/js/core/resource-save.js').ResourceSaveState} */
const state = { devices: [{ id: '1', resource_revision: '2', management_port: null, ip_segment_id: null }], views: [] };
const baseline = createResourceBaseline(state);
createResourceBaseline({});
const payload = buildResourceSave(state, baseline);
buildSaveableResourceSave(state, baseline);
viewResource(state, { id: 1, view_type: 'rack' }, new Set([1]));
const before = baseline.devices.get(1);
if (before) {
    /** @type {number} */
    const revision = before.revision;
    /** @type {string} */
    // @ts-expect-error baseline の版番号は数値。
    const text = before.revision;
    // @ts-expect-error 更新には expected_revision が必須。
    payload.devices.push({ operation: 'update', id: 1, device: before.device });
}
// @ts-expect-error baseline のキーは正規化済みの数値 ID。
baseline.devices.get('1');
// @ts-expect-error baseline に存在しない ID は undefined になり得る。
baseline.views.get(1).revision;
// @ts-expect-error 保存差分では機器・ビュー配列が必要。
buildResourceSave({});
// @ts-expect-error 読込時の resource_revision も文字列・数値・null の範囲。
createResourceBaseline({ devices: [{ id: 1, resource_revision: false }] });
// @ts-expect-error normalized baseline と読込データを取り違えない。
buildResourceSave(state, state);
// @ts-expect-error 削除時の版番号を文字列で送らない。
payload.devices.push({ operation: 'delete', id: 1, expected_revision: '2' });
// @ts-expect-error 送信 ID は数値（仮 ID も含む）。
payload.views.push({ operation: 'delete', id: '1', expected_revision: 2 });

for (const operation of payload.devices) {
    if (operation.operation === 'delete') {
        // @ts-expect-error 削除操作に device 本文はない。
        operation.device.name;
    } else {
        /** @type {number | null} */
        const port = operation.device.management_port;
        // @ts-expect-error nullable な管理ポートは未判定で数値扱いしない。
        operation.device.management_port.toFixed();
        // @ts-expect-error 保存 DTO の機器種別は文字列。
        operation.device.type = 1;
        if (operation.operation === 'create') {
            // @ts-expect-error 新規作成には baseline の版番号がない。
            operation.expected_revision;
        } else {
            /** @type {number} */
            const revision = operation.expected_revision;
        }
    }
}
for (const operation of payload.views) {
    if (operation.operation === 'delete') continue;
    // @ts-expect-error 子配置の device_id も数値。
    operation.placements[0].device_id = '1';
    // @ts-expect-error ビュー種別の綴り違いを拒否する。
    operation.view.view_type = 'rak';
    // @ts-expect-error ラック設定は非ラックでは欠落し、未設定では null。
    operation.rack_settings.total_u;
    // @ts-expect-error 接続系統 ID は数値または null。
    operation.links[0].system_id = '1';
}
/** @type {number} */
const mapped = mappedResourceId({ '-1': 10 }, -1);
const selectionId = mappedResourceId(undefined, null);
mappedResourceId(undefined, null);
mappedResourceId(null, undefined);
// @ts-expect-error 採番先 ID は数値。
mappedResourceId({ '-1': '10' }, -1);
// @ts-expect-error ID に真偽値を使わない。
mappedResourceId({}, false);
// @ts-expect-error null/undefined の選択状態を未判定で数値扱いしない。
selectionId.toFixed();
