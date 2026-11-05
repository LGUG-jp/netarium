import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { appState, normalizeDevice, normalizeView } from '../public/js/core/state.js';
import { buildResourceSave, resetResourceBaseline, createPendingResourceSave, applyResourceSaveResult } from '../public/js/core/resource-save.js';
import { eventBus } from '../public/js/core/event-bus.js';
import { confirmDeviceIpChanges, normalizeAdditionalIps } from '../public/js/core/device-ip-addresses.js';
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

test('新規重複を対象付き確認し、キャンセルはstateと全下書きを保持する', () => {
    const original = globalThis.window;
    let message = '';
    globalThis.window = { confirm(text) { message = text; return false; } };
    try {
        getDeviceDraft('ledger', 1).ip = '192.0.2.3';
        getDeviceDraft('ledger', 2).ip = '192.0.2.3';
        assert.throws(() => commitDeviceDrafts('ledger'), /キャンセル/);
        assert.match(message, /192\.0\.2\.3/);
        assert.match(message, /機器ID 1「機器A」/);
        assert.match(message, /機器ID 2「機器B」/);
        assert.deepEqual(appState.devices.map(device => device.ip), ['192.0.2.1', '192.0.2.2']);
        assert.equal(getDeviceDraft('ledger', 1).ip, '192.0.2.3');
        assert.equal(getDeviceDraft('ledger', 2).ip, '192.0.2.3');
        window.confirm = () => true;
        commitDeviceDrafts('ledger');
        assert.deepEqual(appState.devices.map(device => device.ip), ['192.0.2.3', '192.0.2.3']);
        window.confirm = () => { throw new Error('既存重複は再確認しない'); };
        getDeviceDraft('ledger', 1).memo = '無関係な更新';
        commitDeviceDrafts('ledger');
    } finally {
        if (original === undefined) delete globalThis.window;
        else globalThis.window = original;
    }
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

test('追加IPの下書きは深く分離し、既存子IDと順序を保持して管理IP監視を維持する', () => {
    appState.devices[0].additional_ips = normalizeAdditionalIps([
        { id: 10, ip: '192.0.2.10', label: '用途A' }, { id: 11, ip: '192.0.2.11', label: '用途B' }
    ]);
    appState.devices[0].status = 'up';
    appState.devices[0].last_response_ms = 5;
    resetResourceBaseline(appState);
    const draft = getDeviceDraft('sheet', 1);
    assert.equal(hasDeviceDraftChanges('sheet', 1), false);
    draft.additional_ips.reverse();
    draft.additional_ips[0].label = '用途変更';
    assert.equal(appState.devices[0].additional_ips[0].id, 10);
    assert.equal(appState.devices[0].additional_ips[1].label, '用途B');
    assert.equal(buildResourceSave().devices.length, 0);
    commitDeviceDraft('sheet', 1);
    assert.deepEqual(appState.devices[0].additional_ips.map(row => row.id), [11, 10]);
    assert.deepEqual(buildResourceSave().devices[0].device.additional_ips.map(row => row.sort_order), [0, 1]);
    assert.equal(appState.devices[0].status, 'up');
    assert.equal(appState.devices[0].last_response_ms, 5);
});

test('管理IPと追加IPを横断した新規衝突だけを最終状態で確認する', () => {
    const before = appState.devices;
    const after = before.map(row => ({ ...row, additional_ips: [] }));
    after[0].additional_ips = [{ ip: before[1].ip }];
    let count = 0;
    assert.equal(confirmDeviceIpChanges(before, after, text => { count++; assert.match(text, /機器ID 2/); return true; }), true);
    assert.equal(count, 1);
    assert.equal(confirmDeviceIpChanges(after, after.map(row => ({ ...row, memo: '編集' })), () => { throw new Error('不要な確認'); }), true);
});

test('新規追加IPのサーバー採番は応答待ちの編集と下書きへも引き継ぐ', () => {
    appState.devices[0].additional_ips = normalizeAdditionalIps([{ ip: '192.0.2.10', label: '送信時' }]);
    const payload = buildResourceSave();
    assert.equal(payload.devices[0].device.additional_ips[0].id, null);
    assert.equal('_client_key' in payload.devices[0].device.additional_ips[0], false);
    const pending = createPendingResourceSave(payload);
    const draft = getDeviceDraft('sheet', 1);
    draft.additional_ips[0].ip = '192.0.2.12';
    appState.devices[0].memo = '応答待ちの確定編集';
    const remote = { ...payload.devices[0].device, resource_revision: 2,
        additional_ips: [{ id: 77, ip: '192.0.2.10', label: '送信時', sort_order: 0 }] };
    applyResourceSaveResult({
        revision: 2, id_maps: {}, devices: [remote], views: [], placements: [], links: [],
        canvas_notes: [], deleted_device_ids: [], deleted_view_ids: [], affected_view_ids: []
    }, pending);
    assert.equal(appState.devices[0].additional_ips[0].id, 77);
    assert.equal(appState.devices[0].memo, '応答待ちの確定編集');
    assert.equal(draft.additional_ips[0].id, 77);
    assert.equal(draft.additional_ips[0].ip, '192.0.2.12');
    commitDeviceDraft('sheet', 1);
    assert.equal(buildResourceSave().devices[0].device.additional_ips[0].id, 77);
});

test('機器と追加IPの同時採番でも応答待ちの下書きを新しいIDで適用できる', () => {
    appState.devices.push(normalizeDevice({ id: 3, name: '新規機器', ip: '',
        additional_ips: [{ ip: '192.0.2.30', label: '送信時' }] }));
    const payload = buildResourceSave();
    const pending = createPendingResourceSave(payload);
    const draft = getDeviceDraft('sheet', 3);
    draft.additional_ips[0].label = '応答待ちの入力';
    const sent = payload.devices.find(row => row.id === 3).device;
    const maps = applyResourceSaveResult({
        revision: 2, id_maps: { devices: { 3: 30 } },
        devices: [{ ...sent, id: 30, resource_revision: 2,
            additional_ips: [{ id: 77, ip: '192.0.2.30', label: '送信時', sort_order: 0 }] }],
        views: [], placements: [], links: [], canvas_notes: [],
        deleted_device_ids: [], deleted_view_ids: [], affected_view_ids: []
    }, pending);
    eventBus.emit('resources:ids-remapped', maps);
    commitDeviceDraft('sheet', 30);
    const device = appState.devices.find(row => row.id === 30);
    assert.equal(device.additional_ips[0].id, 77);
    assert.equal(device.additional_ips[0].label, '応答待ちの入力');
});
