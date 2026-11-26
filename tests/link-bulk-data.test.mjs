import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { appState, getCurrentView, normalizeLink } from '../public/js/core/state.js';
import { startLinkBulkEdit, prepareLinkBulkEdit, applyLinkBulkEdit, remapLinkBulkSession, filterWorkspaceLinks, resolveWorkspaceLinks } from '../public/js/core/link-bulk-data.js';
import { remapResourceState } from '../public/js/core/resource-save.js';

globalThis.window = { APP_CONFIG: { user: { isAdmin: true } } };

beforeEach(() => {
    window.APP_CONFIG.user.isAdmin = true;
    appState.authExpired = false;
    appState.isPinging = false;
    appState.currentViewId = 10;
    appState.views = [{ id: 10, name: '対象ビュー' }, { id: 20, name: '別ビュー' }];
    appState.devices = [{ id: 1, name: '接続元SW' }, { id: 2, name: '接続先AP' }, { id: 3, name: '予備SW' }, { id: 4, name: '別ビュー機器' }];
    appState.linkSystems = [{ id: 3, name: '管理ネットワーク', color_key: 'indigo' }];
    appState.devicePorts = [
        { id: 11, device_id: 1, name: 'Gi1/1', vlan: 'access 100' }, { id: 12, device_id: 2, name: 'eth0', vlan: 'native 110' },
        { id: 13, device_id: 2, name: 'Gi1/2', vlan: 'access 200' }, { id: 14, device_id: 3, name: 'eth1', vlan: '' }
    ];
    appState.links = [
        { id: 1, from_id: 1, to_id: 2, from_port_id: 11, to_port_id: 12, system_id: 3, label: 'uplink', memo: '保持する備考' },
        { id: 2, from_id: 2, to_id: 3, from_port_id: 13, to_port_id: 14, label: 'backup', memo: '別の備考' },
        { id: 3, from_id: 1, to_id: 4, label: '他ビュー', memo: '' }
    ].map(link => normalizeLink({ ...link, resource_revision: 1 }));
    appState.viewLinkRoutes = [{ view_id: 10, device_a_id: 1, device_b_id: 2, manual_route: [{ x: 20, y: 30 }, { x: 40, y: 30 }] }];
    appState.placements = [
        { id: 1, view_id: 10, device_id: 1, x: 0, y: 0 },
        { id: 2, view_id: 10, device_id: 2, x: 150, y: 0 },
        { id: 3, view_id: 10, device_id: 3, x: 300, y: 0 },
        { id: 4, view_id: 20, device_id: 1, x: 0, y: 0 },
        { id: 5, view_id: 20, device_id: 4, x: 150, y: 0 }
    ];
    appState.resourceConflicts = { views: new Map(), devices: new Map(), links: new Map(), device_ports: new Map() };
});

test('検索は各接続のラベル・両端機器名・ポート名・両端の保存済み VLAN設定・系統名を対象にする', () => {
    const visible = resolveWorkspaceLinks(getCurrentView(), appState);
    const matchingIds = query => filterWorkspaceLinks(visible, query).map(link => link.id);
    for (const query of ['uplink', '接続元sw 接続先ap', 'gi1/1', 'eth0', 'access 100',
        'native 110', 'uplink 100 110', '管理ネットワーク']) {
        assert.deepEqual(matchingIds(query), [1], query);
    }
    assert.deepEqual(matchingIds('接続先ap 予備sw'), [2]);
    assert.deepEqual(matchingIds('200'), [2]);
    assert.deepEqual(matchingIds('未設定'), [2, 3]);
    for (const query of ['uplink 200', '100 200', '存在しない']) assert.deepEqual(matchingIds(query), [], query);
});

test('編集中の端点は機器と正規化ポート名で解決し、そのポート名と VLAN を検索する', () => {
    appState.devicePorts.push(
        { id: 15, device_id: 3, name: 'Gi1/2', vlan: 'wrong-owner' },
        { id: 16, device_id: 1, name: 'Gi1/3', vlan: 'access 300' }
    );
    Object.assign(appState.links[0], { from_port_name: ' Gi1/3 ', to_port_name: '　Ｇｉ１／２　', vlan: '旧共通値' });
    const visible = resolveWorkspaceLinks(getCurrentView(), appState);
    const matchingIds = query => filterWorkspaceLinks(visible, query).map(link => link.id);
    assert.deepEqual(matchingIds('uplink Gi1/3 Gi1/2 300 200'), [1]);
    assert.deepEqual(matchingIds('200'), [1, 2]);
    for (const query of ['100', '110', 'gi1/1', 'eth0', 'wrong-owner', '旧共通値']) {
        assert.deepEqual(matchingIds(query), [], query);
    }
});

test('新規ポート・未指定・機器変更では旧端点のポート名と VLAN を混ぜない', () => {
    const link = appState.links[0];
    const matchingIds = query => filterWorkspaceLinks(resolveWorkspaceLinks(getCurrentView(), appState), query).map(row => row.id);
    link.to_port_name = '新規ポート';
    assert.deepEqual(matchingIds('uplink 新規ポート 100'), [1]);
    for (const query of ['uplink eth0', 'uplink 110']) assert.deepEqual(matchingIds(query), [], query);

    link.to_port_name = '';
    for (const query of ['uplink 新規ポート', 'uplink eth0', 'uplink 110']) assert.deepEqual(matchingIds(query), [], query);

    link.to_id = 3;
    delete link.to_port_name;
    for (const query of ['uplink eth0', 'uplink 110']) assert.deepEqual(matchingIds(query), [], query);

    link.to_port_name = 'Gi1/2';
    assert.deepEqual(matchingIds('uplink Gi1/2'), [1]);
    assert.deepEqual(matchingIds('200'), [2], '他の機器の同名ポートは再利用しない');
    appState.devicePorts.push({ id: 15, device_id: 3, name: 'Gi1/2', vlan: 'trunk 400' });
    assert.deepEqual(matchingIds('uplink Gi1/2 400'), [1]);
});

test('明示opt-in項目だけを空欄化し、端点・ポート・経路と他ビューを保持する', () => {
    const ids = [1, 2];
    const session = startLinkBulkEdit(ids);
    ids.pop();
    assert.deepEqual(session.ids, [1, 2]);
    const before = structuredClone(appState.links);
    const ports = structuredClone(appState.devicePorts);
    const routes = structuredClone(appState.viewLinkRoutes);
    assert.equal(applyLinkBulkEdit(session, { system_id: '', label: '' }), true);
    for (let i = 0; i < 2; i++) {
        assert.deepEqual(appState.links[i], { ...before[i], system_id: null, label: '' });
    }
    assert.deepEqual(appState.viewLinkRoutes, routes);
    assert.deepEqual(appState.links[2], before[2]);
    assert.equal(applyLinkBulkEdit(startLinkBulkEdit([1, 2]), { memo: '' }), true);
    assert.equal(appState.links[0].memo, '');
    assert.equal(appState.links[1].memo, '');
    assert.deepEqual(appState.devicePorts, ports);
});

test('100/1000文字はUnicode codepointで検証し、上限超過で全件を保持する', () => {
    for (const [key, max] of [['label', 100], ['memo', 1000]]) {
        const value = '\u{20BB7}'.repeat(max);
        const plan = prepareLinkBulkEdit(startLinkBulkEdit([1, 2]), { [key]: value });
        assert.equal(plan.values[key], value);
        const before = structuredClone(appState.links);
        assert.throws(() => applyLinkBulkEdit(startLinkBulkEdit([1, 2]), { [key]: `${value}\u{20BB7}` }), new RegExp(`${max}文字`));
        assert.deepEqual(appState.links, before);
    }
    assert.throws(() => prepareLinkBulkEdit(startLinkBulkEdit([1]), {}), /項目を選択/);
    for (const key of ['from_id', 'to_id', 'from_port_id', 'to_port_id', 'manual_route']) {
        assert.throws(() => prepareLinkBulkEdit(startLinkBulkEdit([1]), { [key]: '' }), /対象外/);
    }
    assert.throws(() => prepareLinkBulkEdit(startLinkBulkEdit([1]), { system_id: 999 }), /系統が見つかりません/);
    assert.equal(prepareLinkBulkEdit(startLinkBulkEdit([1]), { system_id: '3' }).values.system_id, 3);
});

test('一括設定では他の変更項目と一緒に指定されても VLAN を拒否し、何も変更しない', () => {
    const before = structuredClone({ links: appState.links, ports: appState.devicePorts });
    assert.throws(() => applyLinkBulkEdit(startLinkBulkEdit([1, 2]), { label: '新ラベル', vlan: 'access 999' }), /対象外/);
    assert.deepEqual({ links: appState.links, ports: appState.devicePorts }, before);
});

test('現在ビュー・選択・権限・認証期限・競合・削除・並行変更を適用直前にも確認する', () => {
    const session = startLinkBulkEdit([1, 2]);
    const before = structuredClone(appState.links);
    // 接続 #3 は片端の機器が配置されている限り一括編集の対象になる。
    assert.equal(prepareLinkBulkEdit(startLinkBulkEdit([3]), { memo: '片端のみ' }).links[0].id, 3);
    const placed = appState.placements;
    appState.placements = placed.filter(row => row.view_id !== 10 || row.device_id !== 1);
    assert.throws(() => startLinkBulkEdit([3]), /削除または移動/);
    appState.placements = placed;
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
    appState.resourceConflicts.links.set(1, {});
    assert.throws(() => applyLinkBulkEdit(session, { memo: '変更' }), /競合/);
    appState.resourceConflicts.links.clear();
    appState.links[1].label = '別操作で確定';
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
    assert.equal(applyLinkBulkEdit(session, { memo: '再採番後の変更' }, [201, 202]), true);
    const reloaded = startLinkBulkEdit([201]);
    reloaded.invalidated = true;
    assert.throws(() => applyLinkBulkEdit(reloaded, { memo: '' }), /再読み込み/);
    assert.equal(appState.links[0].memo, '再採番後の変更');
});
