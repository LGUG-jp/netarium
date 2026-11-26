import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appState } from '../public/js/core/state.js';
import { normalizeLink, normalizeViewLinkRoute, resolveViewLinks, toSaveLink } from '../public/js/core/connection-data.js';
import {
    applyResourceSaveResult, buildResourceSave, createPendingResourceSave,
    createResourceBaseline, hasResourceChangesSince, reloadResourceFromData, resetResourceBaseline
} from '../public/js/core/resource-save.js';

const link = (fields = {}) => ({ id: 20, from_id: 10, to_id: 11, resource_revision: 1, ...fields });
const route = (manual_route, fields = {}) => ({
    view_id: 1, device_a_id: 10, device_b_id: 11, manual_route, ...fields
});
const fixture = (points = null) => ({
    devices: [
        { id: 10, resource_revision: 1, name: 'SW1', type: 'switch' },
        { id: 11, resource_revision: 1, name: 'SW2', type: 'switch' }
    ],
    views: [{ id: 1, resource_revision: 1, name: '本館', view_type: 'topology' }],
    placements: [
        { id: 100, device_id: 10, view_id: 1, x: 0, y: 0 },
        { id: 101, device_id: 11, view_id: 1, x: 100, y: 100 }
    ],
    links: [link()], devicePorts: [], viewLinkRoutes: points === null ? [] : [route(points)]
});

test('手動経路は中間点をコピーし、接続の向きに合わせて表示だけを反転する', () => {
    const points = [{ x: 1, y: 2 }, { x: 1, y: 3 }];
    const data = fixture();
    assert.equal(resolveViewLinks(data.views[0], data)[0].route_mode, 'auto');
    data.viewLinkRoutes = [normalizeViewLinkRoute(route(points, { device_a_id: 11, device_b_id: 10 }))];
    points[0].x = 999;
    points.push({ x: 1, y: 4 });
    assert.deepEqual(data.viewLinkRoutes, [route([{ x: 1, y: 3 }, { x: 1, y: 2 }])]);
    data.links = [link({ from_id: 11, to_id: 10 })];
    const [projected] = resolveViewLinks(data.views[0], data);
    assert.equal(projected.route_mode, 'manual');
    assert.deepEqual(projected.manual_route, [{ x: 1, y: 2 }, { x: 1, y: 3 }]);
    assert.deepEqual(data.viewLinkRoutes[0].manual_route, [{ x: 1, y: 3 }, { x: 1, y: 2 }]);
    assert.equal('manual_route' in data.links[0], false);
});

test('最大8点を生の点数で検査し、有限座標・重複・同一直線を削らず保存する', () => {
    for (const points of [
        Array.from({ length: 8 }, (_, index) => ({ x: -Number.MAX_VALUE, y: index / 2 })),
        Array.from({ length: 8 }, () => ({ x: Number.MAX_VALUE, y: -0.5 })),
        []
    ]) {
        assert.deepEqual(normalizeViewLinkRoute(route(points)).manual_route, points);
        const data = fixture(points);
        assert.deepEqual(buildResourceSave(data, createResourceBaseline(fixture())).views[0].view_link_routes, [route(points)]);
        if (points.length) {
            assert.throws(() => normalizeViewLinkRoute(route([...points, points[7]])));
        }
    }
});

test('不正な配列・座標・余分な点キー・隣接斜線をビュー保存前に拒否する', () => {
    const invalid = [
        undefined, null, '[]', {}, new Array(1),
        [{ x: 0, y: 0 }, { x: 1, y: 1 }],
        ...[null, [], {}, { x: 1 }, { x: 1, y: 2, z: 3 }].map(point => [point]),
        ...[Infinity, -Infinity, NaN, '1', true, false, null, undefined].flatMap(value => [
            [{ x: value, y: 0 }], [{ x: 0, y: value }]
        ])
    ];
    const baseline = createResourceBaseline(fixture());
    for (const points of invalid) {
        assert.throws(() => normalizeViewLinkRoute(route(points)));
        assert.throws(() => buildResourceSave({ ...fixture(), viewLinkRoutes: [route(points)] }, baseline));
    }
});

test('系統とポート参照は正整数または未設定のみ受け付け、接続編集ではビューをdirtyにしない', () => {
    for (const convert of [normalizeLink, toSaveLink]) {
        for (const field of ['system_id', 'from_port_id', 'to_port_id']) {
            assert.equal(convert(link())[field], null);
            assert.equal(convert(link({ [field]: null }))[field], null);
            assert.equal(convert(link({ [field]: 7 }))[field], 7);
            for (const value of [false, true, 0, -1, 1.5, Infinity, NaN, '', {}, [], [1], 'unknown']) {
                assert.throws(() => convert(link({ [field]: value })));
            }
        }
    }
    Object.assign(appState, fixture());
    resetResourceBaseline(appState);
    appState.links[0].system_id = 7;
    assert.deepEqual(buildResourceSave(), { devices: [], views: [] });
});

test('ビューの接続非表示は設定だけを保存し、共通接続と手動経路を保持する', () => {
    const data = fixture([{ x: 15, y: 25 }]);
    const baseline = createResourceBaseline(data);
    data.views[0].show_connections = 0;
    const [saved] = buildResourceSave(data, baseline).views;
    assert.equal(saved.view.show_connections, 0);
    assert.deepEqual(saved.view_link_routes, data.viewLinkRoutes);
    assert.deepEqual(data.links, [link()]);
    assert.deepEqual(resolveViewLinks(data.views[0], data), []);
});

test('manual経路だけの編集をview dirtyとして送信し、snapshotと応答待ちの追加入力を保持する', () => {
    Object.assign(appState, fixture());
    resetResourceBaseline(appState);
    appState.viewLinkRoutes = [route([{ x: 10, y: 20 }, { x: 10, y: 40 }])];
    const payload = buildResourceSave();
    assert.deepEqual(payload.devices, []);
    assert.equal(payload.views.length, 1);
    assert.equal(payload.views[0].operation, 'update');
    assert.equal(payload.views[0].expected_revision, 1);
    assert.deepEqual(payload.views[0].view_link_routes, [route([{ x: 10, y: 20 }, { x: 10, y: 40 }])]);
    assert.equal('links' in payload.views[0], false);
    const pending = createPendingResourceSave(payload);
    assert.equal(hasResourceChangesSince(pending), false);
    appState.viewLinkRoutes[0].manual_route[1].y = 60;
    appState.viewLinkRoutes[0].manual_route.push({ x: 30, y: 60 });
    assert.equal(hasResourceChangesSince(pending), true);
    assert.deepEqual(pending.snapshot.viewLinkRoutes[0].manual_route, [{ x: 10, y: 20 }, { x: 10, y: 40 }]);
    assert.deepEqual(payload.views[0].view_link_routes[0].manual_route, [{ x: 10, y: 20 }, { x: 10, y: 40 }]);
    // 保存した版だけを返す独立したサーバー応答。後続入力をechoしない。
    applyResourceSaveResult({
        revision: 2, id_maps: {}, devices: [],
        views: [{ id: 1, resource_revision: 2, name: '本館', view_type: 'topology' }],
        placements: [
            { id: 100, device_id: 10, view_id: 1, x: 0, y: 0 },
            { id: 101, device_id: 11, view_id: 1, x: 100, y: 100 }
        ],
        view_link_routes: [route([{ x: 10, y: 20 }, { x: 10, y: 40 }])],
        canvas_notes: [],
        deleted_device_ids: [], deleted_view_ids: [], affected_view_ids: [1]
    }, pending);
    assert.deepEqual(appState.viewLinkRoutes[0].manual_route, [{ x: 10, y: 20 }, { x: 10, y: 60 }, { x: 30, y: 60 }]);
    const next = buildResourceSave();
    assert.equal(next.views[0].expected_revision, 2);
    assert.deepEqual(next.views[0].view_link_routes, appState.viewLinkRoutes);
});

test('競合view再読込でmanual経路を復元し、リモート入力の参照を共有しない', () => {
    Object.assign(appState, fixture());
    resetResourceBaseline(appState);
    const { viewLinkRoutes, ...remote } = fixture();
    remote.view_link_routes = [route([{ x: 15, y: 25 }])];
    remote.views[0].resource_revision = 4;
    reloadResourceFromData('views', 1, remote);
    assert.deepEqual(buildResourceSave(), { devices: [], views: [] });
    remote.view_link_routes[0].manual_route[0].x = 999;
    assert.deepEqual(appState.viewLinkRoutes[0].manual_route, [{ x: 15, y: 25 }]);
    appState.viewLinkRoutes[0].manual_route[0].y = 35;
    assert.equal(buildResourceSave().views[0].expected_revision, 4);
    const baseline = createResourceBaseline(appState);
    appState.viewLinkRoutes[0].manual_route[0].y = 45;
    assert.equal(buildResourceSave(appState, baseline).views[0].view_link_routes[0].manual_route[0].y, 45);
});

test('追加入力のない保存応答でmanual経路を取り込み、保存済みviewをdirtyにしない', () => {
    Object.assign(appState, fixture());
    resetResourceBaseline(appState);
    appState.viewLinkRoutes = [route([{ x: -10, y: 20 }])];
    const pending = createPendingResourceSave(buildResourceSave());
    const response = {
        revision: 2, id_maps: {}, devices: [],
        views: [{ id: 1, resource_revision: 2, name: '本館', view_type: 'topology' }],
        placements: [
            { id: 100, device_id: 10, view_id: 1, x: 0, y: 0 },
            { id: 101, device_id: 11, view_id: 1, x: 100, y: 100 }
        ],
        view_link_routes: [route([{ x: -10, y: 20 }])],
        canvas_notes: [],
        deleted_device_ids: [], deleted_view_ids: [], affected_view_ids: [1]
    };
    applyResourceSaveResult(response, pending);
    assert.deepEqual(appState.viewLinkRoutes, [route([{ x: -10, y: 20 }])]);
    assert.deepEqual(buildResourceSave(), { devices: [], views: [] });
    response.view_link_routes[0].manual_route[0].x = 999;
    assert.deepEqual(appState.viewLinkRoutes, [route([{ x: -10, y: 20 }])]);
    assert.deepEqual(buildResourceSave(), { devices: [], views: [] });
});
