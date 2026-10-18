import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appState, normalizeLink, toSaveLink, validateLinksForSave } from '../public/js/core/state.js';
import {
    applyResourceSaveResult, buildResourceSave, createPendingResourceSave,
    createResourceBaseline, hasResourceChangesSince, reloadResourceFromData, resetResourceBaseline
} from '../public/js/core/resource-save.js';

const link = (route = {}) => ({
    id: 20, view_id: 1, from_id: 10, to_id: 11,
    label: '', from_port: '', to_port: '', vlan: '', memo: '', ...route
});
const fixture = (route = {}) => ({
    devices: [
        { id: 10, resource_revision: 1, name: 'SW1', type: 'switch' },
        { id: 11, resource_revision: 1, name: 'SW2', type: 'switch' }
    ],
    views: [{ id: 1, resource_revision: 1, name: '本館', view_type: 'topology' }],
    placements: [
        { id: 100, device_id: 10, view_id: 1, x: 0, y: 0 },
        { id: 101, device_id: 11, view_id: 1, x: 100, y: 100 }
    ],
    links: [link(route)]
});

// consumerで使う3入口すべてが同じ経路契約を適用する。
const consumers = [
    normalizeLink,
    toSaveLink,
    row => validateLinksForSave(fixture(row))
];

test('旧リンクをauto/空配列へ移行し、APIのmanual中間点を独立して保持する', () => {
    for (const convert of [normalizeLink, toSaveLink]) {
        const legacy = convert(link());
        assert.equal(legacy.route_mode, 'auto');
        assert.deepEqual(legacy.manual_route, []);
        const input = link({ route_mode: 'manual', manual_route: [{ x: 1, y: 2 }, { x: 1, y: 3 }] });
        const output = convert(input);
        assert.equal(output.route_mode, 'manual');
        assert.deepEqual(output.manual_route, input.manual_route);
        input.manual_route[0].x = 999;
        input.manual_route.push({ x: 1, y: 4 });
        assert.deepEqual(output.manual_route, [{ x: 1, y: 2 }, { x: 1, y: 3 }]);
    }
});

test('最大8点を生の点数で検査し、有限座標・重複・同一直線を削らず保存する', () => {
    const points = Array.from({ length: 8 }, (_, index) => ({ x: -Number.MAX_VALUE, y: index / 2 }));
    for (const convert of [normalizeLink, toSaveLink]) {
        assert.deepEqual(convert(link({ route_mode: 'manual', manual_route: points })).manual_route, points);
        assert.deepEqual(convert(link({ route_mode: 'manual', manual_route: [] })).manual_route, []);
    }
    validateLinksForSave(fixture({ route_mode: 'manual', manual_route: points }));
    for (const consume of consumers) {
        assert.throws(() => consume(link({ route_mode: 'manual', manual_route: [...points, points[7]] })));
    }
    const duplicates = Array.from({ length: 8 }, () => ({ x: Number.MAX_VALUE, y: -0.5 }));
    assert.deepEqual(toSaveLink(link({ route_mode: 'manual', manual_route: duplicates })).manual_route, duplicates);
    for (const consume of consumers) {
        assert.throws(() => consume(link({ route_mode: 'manual', manual_route: [...duplicates, duplicates[0]] })));
    }
});

test('不正なmode・配列・座標・余分な点キー・隣接斜線を保存前に拒否する', () => {
    const invalid = [
        { route_mode: 'straight' }, { route_mode: null }, { route_mode: false },
        { route_mode: 'manual' }, { manual_route: null }, { manual_route: '[]' },
        { route_mode: 'manual', manual_route: {} },
        { route_mode: 'auto', manual_route: [{ x: 0, y: 0 }] },
        { route_mode: 'manual', manual_route: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
        ...[null, [], {}, { x: 1 }, { x: 1, y: 2, z: 3 }].map(point => ({ route_mode: 'manual', manual_route: [point] })),
        ...[Infinity, -Infinity, NaN, '1', true, false, null, undefined].flatMap(value => [
            { route_mode: 'manual', manual_route: [{ x: value, y: 0 }] },
            { route_mode: 'manual', manual_route: [{ x: 0, y: value }] }
        ])
    ];
    for (const route of invalid) {
        for (const consume of consumers) assert.throws(() => consume(link(route)));
    }
    const sparse = new Array(1);
    for (const consume of consumers) assert.throws(() => consume(link({ route_mode: 'manual', manual_route: sparse })));
});

test('系統参照は正整数または未設定のみ受け付け、保存snapshotに独立して保持する', () => {
    for (const consume of consumers) {
        for (const value of [false, true, 0, -1, 1.5, Infinity, NaN, '', {}, [], [1], 'unknown']) {
            assert.throws(() => consume(link({ system_id: value })));
        }
    }
    for (const convert of [normalizeLink, toSaveLink]) {
        assert.equal(convert(link()).system_id, null);
        assert.equal(convert(link({ system_id: null })).system_id, null);
        assert.equal(convert(link({ system_id: 7 })).system_id, 7);
    }
    Object.assign(appState, fixture({ system_id: null }));
    resetResourceBaseline(appState);
    appState.links[0].system_id = 7;
    const pending = createPendingResourceSave(buildResourceSave());
    appState.links[0].system_id = null;
    assert.equal(pending.snapshot.links[0].system_id, 7);
    assert.equal(hasResourceChangesSince(pending), true);
});

test('manual経路だけの編集をview dirtyとして送信し、snapshotと応答待ちの追加入力を保持する', () => {
    Object.assign(appState, fixture());
    resetResourceBaseline(appState);
    appState.links[0].route_mode = 'manual';
    appState.links[0].manual_route = [{ x: 10, y: 20 }, { x: 10, y: 40 }];
    const payload = buildResourceSave();
    assert.deepEqual(payload.devices, []);
    assert.equal(payload.views.length, 1);
    assert.equal(payload.views[0].operation, 'update');
    assert.equal(payload.views[0].expected_revision, 1);
    assert.deepEqual(payload.views[0].links[0].manual_route, [{ x: 10, y: 20 }, { x: 10, y: 40 }]);
    const pending = createPendingResourceSave(payload);
    assert.equal(hasResourceChangesSince(pending), false);
    appState.links[0].manual_route[1].y = 60;
    appState.links[0].manual_route.push({ x: 30, y: 60 });
    assert.equal(hasResourceChangesSince(pending), true);
    assert.deepEqual(pending.snapshot.links[0].manual_route, [{ x: 10, y: 20 }, { x: 10, y: 40 }]);
    assert.deepEqual(payload.views[0].links[0].manual_route, [{ x: 10, y: 20 }, { x: 10, y: 40 }]);
    // 保存した版だけを返す独立したサーバー応答。後続入力をechoしない。
    applyResourceSaveResult({
        revision: 2, id_maps: {}, devices: [],
        views: [{ id: 1, resource_revision: 2, name: '本館', view_type: 'topology' }],
        placements: [
            { id: 100, device_id: 10, view_id: 1, x: 0, y: 0 },
            { id: 101, device_id: 11, view_id: 1, x: 100, y: 100 }
        ],
        links: [link({ route_mode: 'manual', manual_route: [{ x: 10, y: 20 }, { x: 10, y: 40 }] })],
        canvas_notes: [],
        deleted_device_ids: [], deleted_view_ids: [], affected_view_ids: [1]
    }, pending);
    assert.deepEqual(appState.links[0].manual_route, [{ x: 10, y: 20 }, { x: 10, y: 60 }, { x: 30, y: 60 }]);
    const next = buildResourceSave();
    assert.equal(next.views[0].expected_revision, 2);
    assert.deepEqual(next.views[0].links[0].manual_route, appState.links[0].manual_route);
});

test('競合view再読込でmanual経路を復元し、リモート入力の参照を共有しない', () => {
    Object.assign(appState, fixture());
    resetResourceBaseline(appState);
    const remote = fixture({ route_mode: 'manual', manual_route: [{ x: 15, y: 25 }] });
    remote.views[0].resource_revision = 4;
    reloadResourceFromData('views', 1, remote);
    assert.deepEqual(buildResourceSave(), { devices: [], views: [] });
    remote.links[0].manual_route[0].x = 999;
    assert.deepEqual(appState.links[0].manual_route, [{ x: 15, y: 25 }]);
    appState.links[0].manual_route[0].y = 35;
    assert.equal(buildResourceSave().views[0].expected_revision, 4);
    const baseline = createResourceBaseline(appState);
    appState.links[0].manual_route[0].y = 45;
    assert.equal(buildResourceSave(appState, baseline).views[0].links[0].manual_route[0].y, 45);
});

test('追加入力のない保存応答でmanual経路を取り込み、保存済みviewをdirtyにしない', () => {
    Object.assign(appState, fixture());
    resetResourceBaseline(appState);
    appState.links[0].route_mode = 'manual';
    appState.links[0].manual_route = [{ x: -10, y: 20 }];
    const pending = createPendingResourceSave(buildResourceSave());
    const response = {
        revision: 2, id_maps: {}, devices: [],
        views: [{ id: 1, resource_revision: 2, name: '本館', view_type: 'topology' }],
        placements: [
            { id: 100, device_id: 10, view_id: 1, x: 0, y: 0 },
            { id: 101, device_id: 11, view_id: 1, x: 100, y: 100 }
        ],
        links: [link({ route_mode: 'manual', manual_route: [{ x: -10, y: 20 }] })],
        canvas_notes: [],
        deleted_device_ids: [], deleted_view_ids: [], affected_view_ids: [1]
    };
    applyResourceSaveResult(response, pending);
    assert.equal(appState.links[0].route_mode, 'manual');
    assert.deepEqual(appState.links[0].manual_route, [{ x: -10, y: 20 }]);
    assert.deepEqual(buildResourceSave(), { devices: [], views: [] });
    response.links[0].manual_route[0].x = 999;
    assert.deepEqual(appState.links[0].manual_route, [{ x: -10, y: 20 }]);
    assert.deepEqual(buildResourceSave(), { devices: [], views: [] });
});
