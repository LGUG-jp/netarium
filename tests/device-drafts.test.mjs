import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { appState, normalizeDevice, normalizeView } from '../public/js/core/state.js';
import { buildResourceSave, resetResourceBaseline } from '../public/js/core/resource-save.js';
import { eventBus } from '../public/js/core/event-bus.js';
import {
    getDeviceDraft, commitDeviceDraft, commitDeviceDrafts, discardDeviceDrafts,
    hasAnyDeviceDraftChanges, hasDeviceDraftChanges
} from '../public/js/core/device-drafts.js';

beforeEach(() => {
    discardDeviceDrafts();
    appState.devices = [
        normalizeDevice({ id: 1, name: '機器A', ip: '192.0.2.1', type: 'switch', resource_revision: 1 }),
        normalizeDevice({ id: 2, name: '機器B', ip: '192.0.2.2', type: 'router', resource_revision: 1 })
    ];
    appState.views = [normalizeView({ id: 1, name: 'ビューA', resource_revision: 1 })];
    appState.placements = [];
    appState.links = [];
    appState.resourceConflicts.devices.clear();
    appState.resourceConflicts.views.clear();
    resetResourceBaseline(appState);
});

test('未適用機器属性は別ビューの配置保存へ混入しない', () => {
    getDeviceDraft('panel', 1).name = '入力途中';
    appState.placements.push({ id: 1, device_id: 1, view_id: 1, x: 30, y: 40 });
    const payload = buildResourceSave();
    assert.equal(hasAnyDeviceDraftChanges(), true);
    assert.deepEqual(payload.devices, []);
    assert.deepEqual(payload.views[0].placements, [{ id: 1, device_id: 1, view_id: 1, x: 30, y: 40 }]);
    commitDeviceDraft('panel', 1);
    assert.equal(buildResourceSave().devices[0].device.name, '入力途中');
    assert.equal(hasDeviceDraftChanges('panel', 1), false);
});

test('下書き確定は編集していない属性や最新の監視結果を上書きしない', () => {
    getDeviceDraft('sheet', 1).memo = '追記';
    appState.devices[0] = { ...appState.devices[0], name: '別画面の確定値', status: 'up', last_response_ms: 4, resource_revision: 2 };
    commitDeviceDraft('sheet', 1);
    assert.equal(appState.devices[0].memo, '追記');
    assert.equal(appState.devices[0].name, '別画面の確定値');
    assert.equal(appState.devices[0].last_response_ms, 4);
    assert.equal(appState.devices[0].resource_revision, 2);
});

test('同じ属性への別画面の確定値は下書きで黙って上書きしない', () => {
    getDeviceDraft('sheet', 1).name = '個票入力';
    getDeviceDraft('panel', 1).name = '詳細入力';
    commitDeviceDraft('panel', 1);
    assert.throws(() => commitDeviceDraft('sheet', 1));
    assert.equal(appState.devices[0].name, '詳細入力');
    assert.equal(getDeviceDraft('sheet', 1).name, '個票入力');
});

test('台帳一括確定は全行検証し、不正行があれば全下書きを保持する', () => {
    getDeviceDraft('ledger', 1).name = '変更A';
    getDeviceDraft('ledger', 2).ip = '不正IP';
    assert.throws(() => commitDeviceDrafts('ledger'));
    assert.equal(appState.devices[0].name, '機器A');
    assert.equal(appState.devices[1].ip, '192.0.2.2');
    assert.equal(getDeviceDraft('ledger', 1).name, '変更A');
    assert.equal(getDeviceDraft('ledger', 2).ip, '不正IP');
    getDeviceDraft('ledger', 2).ip = '192.0.2.3';
    commitDeviceDrafts('ledger');
    assert.equal(appState.devices[0].name, '変更A');
    assert.equal(appState.devices[1].ip, '192.0.2.3');
});

test('台帳一括確定はIPの交換を確定後の集合で検証する', () => {
    getDeviceDraft('ledger', 1).ip = '192.0.2.2';
    getDeviceDraft('ledger', 2).ip = '192.0.2.1';
    commitDeviceDrafts('ledger', [2, 1]);
    assert.deepEqual(appState.devices.map(device => device.ip), ['192.0.2.2', '192.0.2.1']);
    assert.equal(hasDeviceDraftChanges('ledger'), false);
});

test('台帳一括確定は他行で空欄にするIPの付け替えを許可する', () => {
    getDeviceDraft('ledger', 1).ip = '192.0.2.2';
    getDeviceDraft('ledger', 2).ip = '';
    commitDeviceDrafts('ledger');
    assert.deepEqual(appState.devices.map(device => device.ip), ['192.0.2.2', '']);
});

test('台帳一括確定は確定後も重複するIPを拒否し、stateと全下書きを保持する', () => {
    getDeviceDraft('ledger', 1).ip = '192.0.2.3';
    getDeviceDraft('ledger', 2).ip = '192.0.2.3';
    assert.throws(() => commitDeviceDrafts('ledger'), /IPアドレス.*重複/);
    assert.deepEqual(appState.devices.map(device => device.ip), ['192.0.2.1', '192.0.2.2']);
    assert.equal(getDeviceDraft('ledger', 1).ip, '192.0.2.3');
    assert.equal(getDeviceDraft('ledger', 2).ip, '192.0.2.3');
});

test('再採番後も編集中の入力を新IDへ確定できる', () => {
    const draft = getDeviceDraft('sheet', 1);
    draft.name = '保存待機中の次の入力';
    appState.devices[0].id = 100;
    eventBus.emit('resources:ids-remapped', { devices: { 1: 100 } });
    assert.equal(getDeviceDraft('sheet', 100), draft);
    commitDeviceDraft('sheet', 100);
    assert.equal(appState.devices[0].name, '保存待機中の次の入力');
    assert.equal(appState.devices[0].id, 100);
});

test('競合対象だけの再読込は別機器の下書きを残す', () => {
    getDeviceDraft('panel', 1).name = '競合入力';
    getDeviceDraft('ledger', 2).name = '別機器入力';
    appState.resourceConflicts.devices.set(1, { name: '機器A' });
    assert.throws(() => commitDeviceDraft('panel', 1));
    eventBus.emit('resource:reloaded', { kind: 'devices', id: 1 });
    assert.equal(hasDeviceDraftChanges('panel', 1), false);
    assert.equal(getDeviceDraft('ledger', 2).name, '別機器入力');
    eventBus.emit('resources:reloaded');
    assert.equal(hasAnyDeviceDraftChanges(), false);
});

test('管理ポート・日付・長さの不正値を確定せず保持する', () => {
    for (const [key, value] of [['management_port', '65536'], ['install_date', '2026-02-30'], ['name', '機'.repeat(101)]]) {
        discardDeviceDrafts('sheet');
        getDeviceDraft('sheet', 1)[key] = value;
        assert.throws(() => commitDeviceDraft('sheet', 1));
        assert.equal(getDeviceDraft('sheet', 1)[key], value);
    }
    assert.equal(appState.devices[0].name, '機器A');
    assert.equal(appState.devices[0].management_port, null);
    assert.equal(appState.devices[0].install_date, '');
});
