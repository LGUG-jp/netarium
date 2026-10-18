import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { appState, normalizeDevice } from '../public/js/core/state.js';
import { getDeviceDraft, discardDeviceDrafts } from '../public/js/core/device-drafts.js';
import { startDeviceBulkEdit, summarizeBulkValues, prepareDeviceBulkEdit, applyDeviceBulkEdit } from '../public/js/core/device-bulk-edit.js';
import { resetResourceBaseline, buildResourceSave } from '../public/js/core/resource-save.js';

beforeEach(() => {
    discardDeviceDrafts();
    appState.devices = [
        normalizeDevice({ id: 1, name: '架空機器A', ip: '192.0.2.1', facility: '庁舎A', floor: '1F', model: ' 型番A ', install_date: '2024-01-01', resource_revision: 2 }),
        normalizeDevice({ id: 2, name: '架空機器B', ip: '192.0.2.2', facility: '', floor: '1F', install_date: '2025-03-01', resource_revision: 3 })
    ];
    appState.views = [{ id: 10, name: '架空ビュー', resource_revision: 4 }];
    appState.placements = [{ id: 1, view_id: 10, device_id: 1, x: 10, y: 20 }];
    appState.links = [];
    appState.resourceConflicts = { devices: new Map(), views: new Map() };
    resetResourceBaseline(appState);
});

test('選択IDを固定し、共通値・複数値・未設定を区別する', () => {
    const selected = [1, 2];
    const session = startDeviceBulkEdit(selected);
    selected.pop();
    assert.deepEqual(session.ids, [1, 2]);
    assert.equal(summarizeBulkValues(session, 'floor'), '1F');
    assert.equal(summarizeBulkValues(session, 'facility'), '複数の値（未設定を含む）');
    assert.equal(summarizeBulkValues(session, 'department'), '未設定');
    assert.throws(() => startDeviceBulkEdit([]), /選択/);
});

test('指定項目だけ正規化して空欄化し、配置と未選択属性を維持する', () => {
    const session = startDeviceBulkEdit([1, 2]);
    const placements = structuredClone(appState.placements);
    const updates = { facility: ' 庁舎B ', floor: '', location: 'EPS', department: '情報担当', maintenance_vendor: '架空ベンダー', maintenance_expiry: '2026-12-31', manufacturer: '架空メーカー', install_date: '2025-04-01' };
    const plan = prepareDeviceBulkEdit(session, updates);
    assert.equal(plan.placedCount, 1);
    assert.equal(appState.devices[0].facility, '庁舎A');
    assert.equal(applyDeviceBulkEdit(session, updates), true);
    for (const device of appState.devices) {
        assert.equal(device.facility, '庁舎B'); assert.equal(device.floor, '');
        assert.equal(device.install_date, '2025-04-01'); assert.equal(device.maintenance_expiry, '2026-12-31');
        assert.equal(device.location, 'EPS'); assert.equal(device.department, '情報担当');
        assert.equal(device.maintenance_vendor, '架空ベンダー'); assert.equal(device.manufacturer, '架空メーカー');
    }
    assert.equal(appState.devices[0].model, ' 型番A ');
    assert.equal(appState.devices[0].ip, '192.0.2.1');
    assert.deepEqual(appState.placements, placements);
    const payload = buildResourceSave();
    assert.deepEqual(payload.devices.map(row => row.expected_revision), [2, 3]);
    assert.deepEqual(payload.views, []);
});
test('後半の機器で日付順序違反となる場合も全件を保持する', () => {
    const session = startDeviceBulkEdit([1, 2]);
    const before = structuredClone(appState.devices);
    assert.throws(() => applyDeviceBulkEdit(session, { maintenance_expiry: '2025-02-28' }), /機器ID 2/);
    assert.deepEqual(appState.devices, before);
    assert.throws(() => prepareDeviceBulkEdit(session, { install_date: '2026-02-30' }), /実在/);
    assert.throws(() => prepareDeviceBulkEdit(session, { location: 'a'.repeat(151) }), /150文字/);
    assert.throws(() => prepareDeviceBulkEdit(session, { name: '対象外' }), /対象外/);
    assert.throws(() => prepareDeviceBulkEdit(session, {}), /項目を選択/);
});

test('確認後の削除・属性変更・競合・個別下書きで一部適用しない', () => {
    const session = startDeviceBulkEdit([1, 2]);
    prepareDeviceBulkEdit(session, { model: '新型番' });
    appState.devices[1].location = '別操作の変更';
    assert.throws(() => applyDeviceBulkEdit(session, { model: '新型番' }), /属性が変更/);
    assert.equal(appState.devices[0].model, ' 型番A ');
    appState.devices[1].location = '';
    appState.resourceConflicts.devices.set(2, {});
    assert.throws(() => applyDeviceBulkEdit(session, { model: '新型番' }), /競合/);
    appState.resourceConflicts.devices.clear();
    getDeviceDraft('panel', 2).model = '未適用型番';
    assert.throws(() => applyDeviceBulkEdit(session, { model: '新型番' }), /未適用/);
    assert.equal(getDeviceDraft('panel', 2).model, '未適用型番');
    discardDeviceDrafts();
    appState.devices.pop();
    assert.throws(() => applyDeviceBulkEdit(session, { model: '新型番' }), /見つかりません/);
    assert.equal(appState.devices[0].model, ' 型番A ');
});

test('単一機器の型番変更と未変更適用、設置項目以外で配置注意を出さない', () => {
    const session = startDeviceBulkEdit([1]);
    assert.equal(prepareDeviceBulkEdit(session, { model: '新型番' }).placedCount, 0);
    assert.equal(applyDeviceBulkEdit(session, { model: '新型番' }), true);
    assert.equal(appState.devices[0].model, '新型番');
    assert.equal(appState.devices[1].model, '');
    assert.equal(applyDeviceBulkEdit(startDeviceBulkEdit([1]), { model: '新型番' }), false);
});

test('接続方式とポートを同時設定し、境界値と数値への正規化を個別編集と揃える', () => {
    for (const port of ['1', '65535']) {
        const session = startDeviceBulkEdit([1, 2]);
        const plan = prepareDeviceBulkEdit(session, { management_scheme: 'ssh', management_port: port });
        assert.deepEqual(plan.updates, { management_scheme: 'ssh', management_port: Number(port) });
        applyDeviceBulkEdit(session, plan.updates);
        assert.deepEqual(appState.devices.map(device => [device.management_scheme, device.management_port]), [['ssh', Number(port)], ['ssh', Number(port)]]);
    }
    const before = structuredClone(appState.devices);
    for (const port of ['0', '65536', '1.5', '1e2']) {
        assert.throws(() => applyDeviceBulkEdit(startDeviceBulkEdit([1, 2]), { management_port: port }), /ポート/);
        assert.deepEqual(appState.devices, before);
    }
    assert.throws(() => applyDeviceBulkEdit(startDeviceBulkEdit([1, 2]), { management_scheme: 'ftp' }), /接続方式/);
    assert.deepEqual(appState.devices, before);
});

test('ポートだけの変更は接続方式未設定の対象が1台でもあれば全台で拒否する', () => {
    appState.devices[0].management_scheme = 'https';
    const before = structuredClone(appState.devices);
    assert.throws(() => applyDeviceBulkEdit(startDeviceBulkEdit([1, 2]), { management_port: '443' }), /機器ID 2/);
    assert.deepEqual(appState.devices, before);
    applyDeviceBulkEdit(startDeviceBulkEdit([1, 2]), { management_scheme: 'https', management_port: '443' });
    assert.deepEqual(appState.devices.map(device => [device.management_scheme, device.management_port]), [['https', 443], ['https', 443]]);
});

test('接続方式の空欄化で残存ポートを黙って消さず、両項目の明示空欄化だけを適用する', () => {
    for (const device of appState.devices) {
        device.management_scheme = 'ssh';
        device.management_port = 22;
    }
    const before = structuredClone(appState.devices);
    assert.throws(() => applyDeviceBulkEdit(startDeviceBulkEdit([1, 2]), { management_scheme: '' }), /接続方式が未設定/);
    assert.deepEqual(appState.devices, before);
    const plan = prepareDeviceBulkEdit(startDeviceBulkEdit([1, 2]), { management_scheme: '', management_port: '' });
    assert.deepEqual(plan.updates, { management_scheme: '', management_port: null });
    applyDeviceBulkEdit(startDeviceBulkEdit([1, 2]), plan.updates);
    assert.deepEqual(appState.devices.map(device => [device.management_scheme, device.management_port]), [['', null], ['', null]]);
});
