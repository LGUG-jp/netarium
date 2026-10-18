import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { appState, toSaveLink } from '../public/js/core/state.js';
import { startLinkBulkEdit, prepareLinkBulkEdit, applyLinkBulkEdit, remapLinkBulkSession, filterWorkspaceLinks } from '../public/js/core/link-bulk-data.js';
import { remapResourceState } from '../public/js/core/resource-save.js';

globalThis.window = { APP_CONFIG: { user: { isAdmin: true } } };

beforeEach(() => {
    window.APP_CONFIG.user.isAdmin = true;
    appState.authExpired = false;
    appState.isPinging = false;
    appState.currentViewId = 10;
    appState.views = [{ id: 10, name: '対象ビュー' }, { id: 20, name: '別ビュー' }];
    appState.devices = [{ id: 1, name: '接続元SW' }, { id: 2, name: '接続先AP' }, { id: 3, name: '予備SW' }];
    appState.linkSystems = [{ id: 3, name: '管理ネットワーク', color_key: 'indigo' }];
    appState.links = [
        { id: 1, view_id: 10, from_id: 1, to_id: 2, from_port: 'Gi1/1', to_port: 'eth0', system_id: 3,
            vlan: '100', label: 'uplink', memo: '保持する備考', route_mode: 'manual', manual_route: [{ x: 20, y: 30 }, { x: 40, y: 30 }] },
        { id: 2, view_id: 10, from_id: 2, to_id: 3, from_port: 'Gi1/2', to_port: 'eth1', system_id: null,
            vlan: '200', label: 'backup', memo: '別の備考', route_mode: 'auto', manual_route: [] },
        { id: 3, view_id: 20, from_id: 1, to_id: 2, system_id: null, vlan: '300', label: '他ビュー', memo: '' }
    ];
    appState.placements = [
        { id: 1, view_id: 10, device_id: 1, x: 0, y: 0 },
        { id: 2, view_id: 10, device_id: 2, x: 150, y: 0 },
        { id: 3, view_id: 10, device_id: 3, x: 300, y: 0 },
        { id: 4, view_id: 20, device_id: 1, x: 0, y: 0 },
        { id: 5, view_id: 20, device_id: 2, x: 150, y: 0 }
    ];
    appState.resourceConflicts = { views: new Map(), devices: new Map() };
});

test('検索はラベル・両端機器名・ポート・VLAN・系統名を対象にし、未設定も検索できる', () => {
    for (const query of ['uplink', '接続元sw', '接続先ap', 'gi1/1', 'eth0', '100', '管理ネットワーク']) {
        assert.ok(filterWorkspaceLinks(appState.links, query).some(link => link.id === 1), query);
    }
    assert.deepEqual(filterWorkspaceLinks(appState.links, 'uplink 100').map(link => link.id), [1]);
    assert.deepEqual(filterWorkspaceLinks(appState.links, '未設定').map(link => link.id), [2, 3]);
    assert.equal(filterWorkspaceLinks(appState.links, '存在しない').length, 0);
});

test('明示opt-in項目だけを空欄化し、端点・ポート・経路と他ビューを保持する', () => {
    const ids = [1, 2];
    const session = startLinkBulkEdit(ids);
    ids.pop();
    assert.deepEqual(session.ids, [1, 2]);
    const before = structuredClone(appState.links);
    const routes = appState.links.map(link => link.manual_route);
    assert.equal(applyLinkBulkEdit(session, { system_id: '', label: '', vlan: ' 新VLAN ' }), true);
    for (let i = 0; i < 2; i++) {
        assert.deepEqual(appState.links[i], { ...before[i], system_id: null, label: '', vlan: '新VLAN' });
        assert.equal(appState.links[i].manual_route, routes[i]);
    }
    assert.deepEqual(appState.links[2], before[2]);
    assert.equal(applyLinkBulkEdit(startLinkBulkEdit([1, 2]), { memo: '' }), true);
    assert.equal(appState.links[0].memo, '');
    assert.equal(appState.links[1].memo, '');
});

test('100/100/1000文字はUnicode codepointで検証し、上限超過で全件を保持する', () => {
    for (const [key, max] of [['vlan', 100], ['label', 100], ['memo', 1000]]) {
        const value = '\u{20BB7}'.repeat(max);
        const plan = prepareLinkBulkEdit(startLinkBulkEdit([1, 2]), { [key]: value });
        assert.equal(plan.values[key], value);
        const before = structuredClone(appState.links);
        assert.throws(() => applyLinkBulkEdit(startLinkBulkEdit([1, 2]), { [key]: `${value}\u{20BB7}` }), new RegExp(`${max}文字`));
        assert.deepEqual(appState.links, before);
    }
    assert.throws(() => prepareLinkBulkEdit(startLinkBulkEdit([1]), {}), /項目を選択/);
    for (const key of ['from_id', 'to_id', 'from_port', 'to_port', 'route_mode', 'manual_route']) {
        assert.throws(() => prepareLinkBulkEdit(startLinkBulkEdit([1]), { [key]: '' }), /対象外/);
    }
    assert.throws(() => prepareLinkBulkEdit(startLinkBulkEdit([1]), { system_id: 999 }), /系統が見つかりません/);
    assert.equal(prepareLinkBulkEdit(startLinkBulkEdit([1]), { system_id: '3' }).values.system_id, 3);
});

test('現在ビュー・選択・権限・認証期限・競合・削除・並行変更を適用直前にも確認する', () => {
    const session = startLinkBulkEdit([1, 2]);
    const before = structuredClone(appState.links);
    assert.throws(() => startLinkBulkEdit([3]), /削除または移動/);
    assert.throws(() => applyLinkBulkEdit(session, { memo: '変更' }, [1]), /選択した接続が変更/);
    appState.currentViewId = 20;
    assert.throws(() => applyLinkBulkEdit(session, { memo: '変更' }), /ビューが変更/);
    appState.currentViewId = 10;
    window.APP_CONFIG.user.isAdmin = false;
    assert.throws(() => applyLinkBulkEdit(session, { memo: '変更' }), /権限/);
    window.APP_CONFIG.user.isAdmin = true;
    appState.authExpired = true;
    assert.throws(() => applyLinkBulkEdit(session, { memo: '変更' }), /権限/);
    appState.authExpired = false;
    appState.resourceConflicts.views.set(10, {});
    assert.throws(() => applyLinkBulkEdit(session, { memo: '変更' }), /競合/);
    appState.resourceConflicts.views.clear();
    appState.links[1].manual_route = [{ x: 40, y: 40 }];
    appState.links[1].route_mode = 'manual';
    assert.throws(() => applyLinkBulkEdit(session, { memo: '変更' }), /接続が変更/);
    appState.links = structuredClone(before);
    appState.links.splice(1, 1);
    assert.throws(() => applyLinkBulkEdit(session, { memo: '変更' }), /削除または移動/);
    assert.equal(appState.links[0].memo, before[0].memo);
});

test('ビュー・機器・接続のID再採番はsessionに追従し、再読込無効化では適用しない', () => {
    const session = startLinkBulkEdit([1, 2]);
    const maps = { views: { 10: 110 }, devices: { 1: 101, 2: 102 }, links: { 1: 201, 2: 202 }, placements: {} };
    remapResourceState(appState, maps);
    remapLinkBulkSession(session, maps);
    assert.equal(session.viewId, 110);
    assert.deepEqual(session.ids, [201, 202]);
    assert.deepEqual(session.bases[0], toSaveLink(appState.links[0]));
    assert.equal(applyLinkBulkEdit(session, { memo: '再採番後の変更' }, [201, 202]), true);
    const reloaded = startLinkBulkEdit([201]);
    reloaded.invalidated = true;
    assert.throws(() => applyLinkBulkEdit(reloaded, { memo: '' }), /再読み込み/);
    assert.equal(appState.links[0].memo, '再採番後の変更');
});
