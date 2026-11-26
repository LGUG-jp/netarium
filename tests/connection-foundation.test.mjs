import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appState, getCurrentLinkGroups, getCurrentLinks, normalizeLink, removeDevicesFromState } from '../public/js/core/state.js';
import { normalizeDevicePort, setViewLinkRoute, toSaveLink } from '../public/js/core/connection-data.js';
import { applyConnectionSaveResult, buildConnectionSave, confirmedConnectionResult, createPendingConnectionSave,
    inspectPendingConnectionSave, reloadConnectionFromData } from '../public/js/core/connection-save.js';
import { applyResourceSaveResult, buildResourceSave, buildSaveableResourceSave, remapResourceState,
    remapResourceUiState, resetResourceBaseline } from '../public/js/core/resource-save.js';
import { eventBus } from '../public/js/core/event-bus.js';

const points = [{ x: 10, y: 25 }, { x: 25, y: 25 }];
const link = overrides => normalizeLink({ id: 17, from_id: 2, to_id: 1, from_port_id: 4, resource_revision: 32, ...overrides });

function setup(t, { links = [link()], routes = true } = {}) {
    const before = { ...appState };
    const views = [
        { id: 8, resource_revision: 21, name: '構成図', view_type: 'topology', show_connections: 1 },
        { id: 9, resource_revision: 22, name: '配置図', view_type: 'floor', show_connections: 1 },
        { id: 10, resource_revision: 23, name: '非表示', view_type: 'floor', show_connections: 0 },
        { id: 11, resource_revision: 24, name: 'ラック', view_type: 'rack', show_connections: 1 }
    ];
    const placements = views.flatMap(view => [1, 2].map(id => ({
        id: view.id * 10 + id, device_id: id, view_id: view.id, x: 20 * id, y: 30 * id
    })));
    Object.assign(appState, {
        links, views, placements, currentViewId: 8, viewLinkRoutes: [], legacyLinkConflicts: [],
        legacyLinkVlans: links.map(row => ({ link_id: row.id, vlan: '旧 VLAN' })),
        devices: [{ id: 1, name: 'A', resource_revision: 10 }, { id: 2, name: 'B', resource_revision: 11 }],
        devicePorts: [normalizeDevicePort({ id: 4, name: 'Gi1', device_id: 2, resource_revision: 20 })],
        resourceConflicts: { devices: new Map(), views: new Map(), links: new Map(), device_ports: new Map() }
    });
    if (routes) setViewLinkRoute(appState, { view_id: 8, from_id: 2, to_id: 1 }, points);
    resetResourceBaseline(appState);
    t.after(() => { Object.assign(appState, before); resetResourceBaseline(appState); });
}

function response(overrides) {
    return { revision: 15, id_maps: {}, links: [], device_ports: [], views: [], removed_view_link_routes: [],
        deleted_link_ids: [], deleted_device_port_ids: [], ...overrides };
}

test('shared connection and port name project into each eligible view; manual points belong to the pair in one view', t => {
    setup(t);
    assert.deepEqual(appState.viewLinkRoutes[0].manual_route, points.toReversed());
    assert.equal(getCurrentLinks()[0].from_port, 'Gi1');
    assert.deepEqual(getCurrentLinks()[0].manual_route, points);
    assert.equal(Object.hasOwn(appState.links[0], 'view_id'), false);
    appState.currentViewId = 9;
    assert.equal(getCurrentLinks()[0].id, 17);
    assert.equal(getCurrentLinks()[0].route_mode, 'auto');
    for (const id of [10, 11]) {
        appState.currentViewId = id;
        assert.deepEqual(getCurrentLinks(), []);
    }
    appState.placements = appState.placements.filter(row => row.id !== 82);
    appState.currentViewId = 8;
    assert.deepEqual(getCurrentLinks(), []);
    assert.deepEqual(buildConnectionSave().links, []);
    assert.equal(buildResourceSave().views[0].view_link_routes.length, 1);
    assert.equal(Object.hasOwn(buildResourceSave().views[0], 'links'), false);
});

test('drawing groups share only the canonical pair route across member order and view', t => {
    const reverse = link({ id: 17, system_id: 8, label: '逆向き', memo: '個別備考' });
    const forward = link({ id: 4, from_id: 1, to_id: 2, from_port_id: null, system_id: 8, label: '正向き' });
    const elsewhere = link({ id: 33, from_id: 3 });
    setup(t, { links: [reverse, elsewhere, forward] });
    const [group] = getCurrentLinkGroups();
    assert.equal(group.display_key, '8:1:2');
    assert.deepEqual(group.link_ids, [4, 17]);
    assert.deepEqual([group.from_id, group.to_id, group.system_id], [1, 2, 8]);
    assert.equal(group.route_mode, 'manual');
    assert.deepEqual(group.manual_route, points.toReversed());
    for (const field of ['id', 'from_port', 'to_port', 'label', 'vlan', 'memo']) {
        assert.equal(Object.hasOwn(group, field), false);
    }
    const [individual] = getCurrentLinks();
    assert.deepEqual([individual.id, individual.from_id, individual.to_id, individual.from_port], [17, 2, 1, 'Gi1']);
    assert.deepEqual(individual.manual_route, points);
    forward.system_id = 9;
    assert.equal(getCurrentLinkGroups()[0].system_id, null);
    appState.currentViewId = 9;
    assert.equal(getCurrentLinkGroups()[0].display_key, '9:1:2');
    assert.equal(getCurrentLinkGroups()[0].route_mode, 'auto');
    for (const id of [10, 11]) {
        appState.currentViewId = id;
        assert.deepEqual(getCurrentLinkGroups(), []);
    }
    appState.currentViewId = 8;
    appState.links = [reverse];
    const [single] = getCurrentLinkGroups();
    assert.deepEqual([single.id, single.display_key, single.to_port, single.label], [17, group.display_key, 'Gi1', '逆向き']);
    assert.deepEqual(single.manual_route, group.manual_route);
    appState.placements = appState.placements.filter(row => row.id !== 82);
    assert.deepEqual(getCurrentLinkGroups(), []);
});

test('物理配置図ではラックと棚板の接続を表示端点で集約し、曖昧な位置と別図面を除く', t => {
    const links = [
        [17, 2, 1], [18, 3, 1, 8], [19, 1, 4, 9], [20, 5, 3, 8], [21, 4, 5, 8], [22, 3, 4],
        [23, 6, 1], [24, 7, 1], [25, 8, 1], [26, 9, 1], [27, 10, 1], [28, 12, 1], [29, 13, 1], [30, 14, 1]
    ].map(([id, from_id, to_id, system_id]) => link({ id, from_id, to_id, system_id, from_port_id: null }));
    setup(t, { links, routes: false });
    appState.currentViewId = 9;
    appState.views.push({ id: 2, view_type: 'rack' }, { id: 12, view_type: 'rack' });
    appState.devices.push(...[3, 4, 5, 6, 7, 8, 9, 10, 12, 14].map(id => ({ id })));
    appState.placements.push(...[[10, 7], [9, 8], [9, 9], [9, 9], [9, 13]]
        .map(([view_id, device_id], index) => ({ id: index + 1000, view_id, device_id, x: 100 + index, y: 20 })));
    appState.floorRackPlacements = [[9, 11], [9, 2], [10, 12]]
        .map(([floor_view_id, rack_view_id]) => ({ floor_view_id, rack_view_id, x: rack_view_id * 100, y: 100 }));
    appState.rackMounts = [[11, 3], [2, 5], [12, 6], [11, 8], [8, 10], [2, 12], [12, 12]]
        .map(([view_id, device_id]) => ({ view_id, device_id }));
    appState.rackShelves = [{ id: 8, view_id: 11 }];
    appState.rackShelfDevices = [{ shelf_id: 8, device_id: 4 }, { shelf_id: 99, device_id: 14 }];
    appState.viewLinkRoutes = [2, 3, 4].map(device_b_id => ({ view_id: 9, device_a_id: 1, device_b_id, manual_route: points }));

    const groups = () => getCurrentLinkGroups()
        .map(({ display_key, link_ids, system_id, route_mode }) => [display_key, link_ids, system_id, route_mode]);
    assert.deepEqual(groups(), [
        ['9:-11:-2', [20, 21], 8, 'auto'],
        ['9:-11:1', [18, 19], null, 'auto'],
        ['9:1:2', [17], null, 'manual']
    ]);
    assert.deepEqual(getCurrentLinks().map(({ id, from_id, to_id }) => [id, from_id, to_id]),
        [[17, 2, 1], [18, 3, 1], [19, 1, 4], [20, 5, 3], [21, 4, 5]]);

    const savedRoutes = structuredClone(appState.viewLinkRoutes);
    appState.rackMounts[0].view_id = 2;
    assert.deepEqual(groups(), [
        ['9:-11:-2', [21, 22], null, 'auto'],
        ['9:-11:1', [19], 9, 'auto'],
        ['9:-2:1', [18], 8, 'auto'],
        ['9:1:2', [17], null, 'manual']
    ]);
    appState.floorRackPlacements.push({ floor_view_id: 10, rack_view_id: 2, x: 0, y: 0 });
    assert.deepEqual(groups().map(([key]) => key), ['9:-11:1', '9:1:2']);
    assert.deepEqual(appState.viewLinkRoutes, savedRoutes);
    for (const [viewId, keys] of [[8, ['8:1:2']], [10, []], [11, []]]) {
        appState.currentViewId = viewId;
        assert.deepEqual(groups().map(([key]) => key), keys);
    }
    appState.currentViewId = 9;
    appState.devices.push({ id: 15 });
    appState.placements.push({ id: 1005, view_id: 9, device_id: 15, x: '', y: 20 });
    appState.links.push(link({ id: 31, from_id: 15, to_id: 1, from_port_id: null }));
    assert.deepEqual(groups().map(([key]) => key), ['9:-11:1', '9:1:2']);
});

test('ラックと機器で同じ番号を使っても再採番後に選択した集約線を維持する', t => {
    setup(t, { links: [link({ from_id: 3, to_id: 2, from_port_id: null })], routes: false });
    appState.devices.push({ id: 3 });
    appState.views.push({ id: 2, view_type: 'rack' });
    appState.floorRackPlacements = [{ floor_view_id: 9, rack_view_id: 2, x: 300, y: 200 }];
    appState.rackMounts = [{ view_id: 2, device_id: 3 }];
    appState.currentViewId = 9;
    appState.editingLinkGroupKey = getCurrentLinkGroups()[0].display_key;
    const maps = { views: { 2: 42, 9: 49 }, devices: { 2: 52 }, links: { 17: 57 } };
    remapResourceState(appState, maps);
    remapResourceUiState(maps);
    assert.equal(appState.editingLinkGroupKey, '49:-42:52');
    assert.deepEqual(getCurrentLinkGroups().find(group => group.display_key === appState.editingLinkGroupKey)?.link_ids, [57]);
});

test('connection updates preserve untouched port IDs and leave in-flight follow-up edits pending', t => {
    setup(t);
    Object.assign(appState.links[0], { label: '送信中', to_port_name: 'LAN 1' });
    const payload = buildConnectionSave({ saveable: true });
    assert.deepEqual(payload.links, [{ id: 17, operation: 'update', expected_revision: 32,
        link: { from_id: 2, to_id: 1, from_port_id: 4, to_port_name: 'LAN 1', system_id: null,
            label: '送信中', memo: '' } }]);
    const pending = createPendingConnectionSave(payload);
    appState.links[0].label = '後続入力';
    applyConnectionSaveResult(response({
        links: [link({ label: '送信中', to_port_id: 7, resource_revision: 39 })],
        device_ports: [normalizeDevicePort({ id: 7, name: 'LAN 1', device_id: 1, resource_revision: 38 })]
    }), pending);
    assert.equal(getCurrentLinks()[0].to_port, 'LAN 1');
    assert.equal(appState.links[0].label, '後続入力');
    assert.equal(Object.hasOwn(toSaveLink(appState.links[0]), 'to_port_name'), false);
    assert.equal(buildConnectionSave().links[0].expected_revision, 39);
    assert.deepEqual(buildResourceSave(), { devices: [], views: [] });
});

test('a link ID allocation remaps the selection and moves a different in-flight draft out of the way', t => {
    setup(t, { links: [], routes: false });
    appState.links = [link({ id: 3, resource_revision: 0 })];
    appState.editingLinkId = 3;
    const pending = createPendingConnectionSave(buildConnectionSave({ saveable: true }));
    appState.links.push(link({ id: 30, resource_revision: 0, label: '後続' }));
    const maps = applyConnectionSaveResult(response({ id_maps: { links: { 3: 30 } }, links: [link({ id: 30 })] }), pending);
    assert.deepEqual(maps.links, { 3: 30, 30: 31 });
    assert.equal(appState.editingLinkId, 30);
    assert.equal(buildConnectionSave().links[0].id, 31);
});

for (const staleView of [false, true]) {
    test(`connection route removal ${staleView ? 'does not adopt a concurrent view revision' : 'advances its matching view baseline'}`, t => {
        setup(t);
        appState.links = [];
        const pending = createPendingConnectionSave(buildConnectionSave());
        applyConnectionSaveResult(response({
            deleted_link_ids: [17], removed_view_link_routes: [{ view_id: 8, device_a_id: 1, device_b_id: 2 }],
            views: [{ id: 8, previous_resource_revision: staleView ? 25 : 21, resource_revision: 40 }]
        }), pending);
        assert.deepEqual(appState.legacyLinkVlans, []);
        assert.deepEqual(appState.viewLinkRoutes, []);
        assert.deepEqual(buildResourceSave().views, []);
        appState.views[0].name = 'ローカル編集';
        assert.equal(buildResourceSave().views[0].expected_revision, staleView ? 21 : 40);
    });
}

for (const concurrent of [null, 'placement', 'floor plan']) {
    test(`confirming a lost connection save response ${concurrent ? `preserves conflict detection for a changed ${concurrent}` : 'allows the next placement save'}`, t => {
        setup(t);
        const plan = { view_id: 8, revision: 1, created_at: '2026-11-19', updated_at: '2026-11-19' };
        appState.floorPlans = [plan];
        const data = response({
            views: appState.views.map((row, i) => i === 0 ? { ...row, resource_revision: 40 } : { ...row }),
            placements: appState.placements.map(row => ({ ...row })),
            floor_plans: [{ ...plan }],
            view_link_routes: []
        });
        if (concurrent === 'placement') data.placements[1].y += 15;
        if (concurrent === 'floor plan') data.floor_plans[0].revision++;

        appState.links = [];
        const pending = createPendingConnectionSave(buildConnectionSave());
        appState.placements[0].x += 10;
        if (!concurrent) appState.viewLinkRoutes = []; // 照合ではローカルの経路ではなく保存済み経路を使う。
        assert.equal(inspectPendingConnectionSave(pending, data).outcome, 'saved');
        applyConnectionSaveResult(confirmedConnectionResult(pending, data), pending);

        const [view] = buildResourceSave().views;
        assert.equal(view.expected_revision, concurrent ? 21 : 40);
        assert.deepEqual(view.view_link_routes, []);
        assert.equal(view.placements[0].x, 30);
        assert.equal(view.placements[1].y, 60);
    });
}

test('confirming a port update checks raw VLAN input before trimming only ASCII spaces', () => {
    const inspect = (sentVlan, storedVlan) => inspectPendingConnectionSave({
        payload: { links: [], device_ports: [{ id: 4, operation: 'update', expected_revision: 20, port: { vlan: sentVlan } }] }
    }, {
        links: [], device_ports: [{ id: 4, device_id: 2, vlan: storedVlan, resource_revision: 21 }]
    }).outcome;
    assert.equal(inspect('  VLAN 10  ', 'VLAN 10'), 'saved');
    assert.equal(inspect('   ', ''), 'saved');
    assert.equal(inspect(' \u00a010\u3000 ', '\u00a010\u3000'), 'saved');
    assert.equal(inspect('\u00a010\u3000', '10'), 'conflict');
    assert.equal(inspect(' ' + '😀'.repeat(198) + ' ', '😀'.repeat(198)), 'saved');
    assert.equal(inspect(' ' + '😀'.repeat(199) + ' ', '😀'.repeat(199)), 'conflict');
    for (const invalid of ['10\n', '\t10', '10\u0085', '10\u2028', '10\u2029']) {
        assert.equal(inspect(invalid, '10'), 'conflict');
    }
});

test('VLAN だけの保存確認ではポートの更新と接続の版が一致することを確認する', t => {
    setup(t);
    const pending = createPendingConnectionSave({
        links: [{ operation: 'update', id: 17, expected_revision: 32, link: {} }],
        device_ports: [{ operation: 'update', id: 4, expected_revision: 20, port: { vlan: 'access 30' } }],
    }, { isolated: true });
    const unchanged = response({ links: appState.links, device_ports: appState.devicePorts });
    const saved = { ...unchanged, device_ports: [{ ...appState.devicePorts[0], resource_revision: 40, vlan: 'access 30' }] };
    assert.equal(inspectPendingConnectionSave(pending, unchanged).outcome, 'retry');
    assert.equal(inspectPendingConnectionSave(pending, saved).outcome, 'saved');
    assert.equal(inspectPendingConnectionSave(pending, {
        ...saved, links: [link({ from_port_id: null, resource_revision: 45 })]
    }).outcome, 'conflict');
});

test('confirming a VLAN copy checks the old link endpoints and both port versions before matching the destination value', () => {
    const source = { id: 4, device_id: 2, name: 'Gi1', vlan: '10', resource_revision: 20 };
    const destination = { id: 7, device_id: 1, name: 'Gi2', vlan: '20', resource_revision: 25 };
    const matching = { ...destination, vlan: '10', resource_revision: 33 };
    const original = link({ to_port_id: destination.id });
    const pending = {
        vlanCopy: { link_id: original.id, source_port_id: source.id, destination_port_id: destination.id,
            source_expected_revision: source.resource_revision, destination_expected_revision: destination.resource_revision },
        payload: { links: [], device_ports: [{ operation: 'update', id: destination.id,
            expected_revision: destination.resource_revision, port: { vlan: source.vlan } }] }
    };
    const inspect = (links, ports) => inspectPendingConnectionSave(pending, { links, device_ports: ports });
    assert.deepEqual(inspect([original], [source, destination]), { outcome: 'retry' });
    assert.deepEqual(inspect([original], [source, matching]), { outcome: 'matched' });
    assert.deepEqual(inspect([link({ from_id: 1, to_id: 2, from_port_id: 7, to_port_id: 4, resource_revision: 34 })],
        [source, matching]), { outcome: 'matched' });

    const linkConflict = { resource: 'links', id: 17, name: '' };
    const sourceConflict = { resource: 'device_ports', id: 4, name: 'Gi1' };
    const destinationConflict = { resource: 'device_ports', id: 7, name: 'Gi2' };
    assert.deepEqual(inspect([link({ to_port_id: 8 })], [source, matching]),
        { outcome: 'conflict', conflicts: [linkConflict, destinationConflict] });
    assert.deepEqual(inspect([], [source, destination]),
        { outcome: 'conflict', conflicts: [{ ...linkConflict, name: undefined }] });
    const changedSource = { ...source, resource_revision: 31 }; // Even a non-VLAN change invalidates the copy.
    assert.deepEqual(inspect([original], [changedSource, matching]),
        { outcome: 'conflict', conflicts: [sourceConflict, destinationConflict] });
    assert.deepEqual(inspect([original], [changedSource, destination]),
        { outcome: 'conflict', conflicts: [sourceConflict] });
    assert.deepEqual(inspect([original], [source, { ...matching, vlan: '30' }]),
        { outcome: 'conflict', conflicts: [destinationConflict] });
});

test('未移行VLANはポート保存と記録削除の両方が確認できたときだけ一覧から消す', t => {
    setup(t);
    const payload = {
        complete_legacy_vlan: 17,
        links: [{ operation: 'update', id: 17, expected_revision: 32, link: {} }],
        device_ports: [{ operation: 'update', id: 4, expected_revision: 20, port: { vlan: 'access 30' } }],
    };
    const pending = createPendingConnectionSave(payload, { isolated: true });
    const server = response({
        links: appState.links, device_ports: [{ ...appState.devicePorts[0], resource_revision: 40, vlan: 'access 30' }],
        legacy_link_vlans: appState.legacyLinkVlans,
    });
    assert.throws(() => applyConnectionSaveResult(server, pending), /未移行VLANの再設定を確認できません/);
    assert.equal(appState.devicePorts[0].vlan, '');
    assert.deepEqual(inspectPendingConnectionSave(pending, server), { outcome: 'conflict' });
    assert.deepEqual(inspectPendingConnectionSave(pending, {
        ...server, device_ports: appState.devicePorts
    }), { outcome: 'retry' });
    const completed = { ...server, legacy_link_vlans: [] };
    assert.deepEqual(inspectPendingConnectionSave(pending, completed), { outcome: 'saved' });
    applyConnectionSaveResult(confirmedConnectionResult(pending, completed), pending);
    assert.equal(appState.devicePorts[0].vlan, 'access 30');
    assert.deepEqual(appState.legacyLinkVlans, []);
    assert.deepEqual(buildConnectionSave(), { links: [], device_ports: [] });
});

test('確定応答で削除された機器・ビューの旧接続保留だけを一覧から除く', t => {
    setup(t);
    const held = [
        { legacy_link_id: 100, view_id: 8, device_a_id: 1, device_b_id: 2 },
        { legacy_link_id: 101, view_id: 9, device_a_id: 1, device_b_id: 3 },
        { legacy_link_id: 102, view_id: 8, device_a_id: 1, device_b_id: 3 }
    ];
    appState.devices.push({ id: 3, name: 'C', resource_revision: 12 });
    appState.legacyLinkConflicts = held;
    resetResourceBaseline(appState);
    const notifications = [];
    t.after(eventBus.on('legacy-links:changed', () => notifications.push(appState.legacyLinkConflicts)));
    removeDevicesFromState([2]);
    assert.deepEqual(appState.links, []);
    assert.deepEqual(appState.devicePorts, []);
    assert.deepEqual(appState.viewLinkRoutes, []);
    assert.deepEqual(appState.legacyLinkConflicts, held);
    assert.deepEqual(notifications, []);
    assert.deepEqual(buildConnectionSave(), { device_ports: [], links: [] });
    const resources = buildSaveableResourceSave();
    assert.deepEqual(resources.devices, [{ operation: 'delete', id: 2, expected_revision: 11 }]);
    assert.deepEqual(resources.views, []);
    assert.deepEqual(appState.legacyLinkVlans, [{ link_id: 17, vlan: '旧 VLAN' }]);
    applyResourceSaveResult(response({
        devices: [], placements: [], view_link_routes: [], canvas_notes: [],
        deleted_device_ids: [2], deleted_link_ids: [17], deleted_device_port_ids: [4],
        deleted_view_ids: [], affected_view_ids: []
    }));
    assert.deepEqual(appState.legacyLinkVlans, []);
    assert.deepEqual(appState.legacyLinkConflicts, [held[1], held[2]]);
    applyResourceSaveResult(response({
        devices: [], placements: [], view_link_routes: [], canvas_notes: [],
        deleted_device_ids: [], deleted_view_ids: [9], affected_view_ids: []
    }));
    assert.deepEqual(appState.legacyLinkConflicts, [held[2]]);
    assert.deepEqual(notifications, [[held[1], held[2]], [held[2]]]);
});

test('reloading a removed port drops its stale link without losing another link or the shared route', t => {
    const other = link({ id: 18, from_port_id: null });
    setup(t, { links: [link(), other] });
    const route = appState.viewLinkRoutes[0];
    reloadConnectionFromData('device_ports', 4, {
        device_ports: [], links: [other], view_link_routes: [route], legacy_link_conflicts: []
    });
    assert.deepEqual(appState.devicePorts, []);
    assert.deepEqual(getCurrentLinks().map(row => row.id), [other.id]);
    assert.deepEqual(appState.legacyLinkVlans, [{ link_id: other.id, vlan: '旧 VLAN' }]);
    assert.deepEqual(appState.viewLinkRoutes, [route]);
});

test('保存応答が未確認の接続文字列はPHPの既定trimだけを送信値に適用する', t => {
    setup(t);
    const pending = createPendingConnectionSave({
        device_ports: [{
            operation: 'update',
            id: 4,
            expected_revision: 1,
            port: { memo: '\0\t　port memo　\x0b \r\n' }
        }],
        links: [{
            operation: 'update',
            id: 17,
            expected_revision: 32,
            link: { label: ' 　uplink　 ', memo: ' \x0clink memo\x0c ' }
        }]
    });
    const remote = {
        device_ports: [{ ...appState.devicePorts[0], memo: '　port memo　', resource_revision: 2 }],
        links: [{ ...appState.links[0], label: '　uplink　', memo: '\x0clink memo\x0c', resource_revision: 33 }]
    };
    assert.deepEqual(inspectPendingConnectionSave(pending, remote), { outcome: 'saved' });
    assert.deepEqual(inspectPendingConnectionSave(pending, {
        ...remote, links: [{ ...remote.links[0], label: 'uplink' }]
    }), { outcome: 'conflict' });
});
