import test from 'node:test';
import assert from 'node:assert/strict';
import { buildingConnections, buildingFloorLayers, transformedFloorCorners, buildingSceneFrame,
    buildingComparisonAnchors, buildingComparisonFrame, buildingFloorZ, fitBuildingCamera, projectBuildingPoint,
    buildingDragDelta, transformBuildingPoint, validFloorTransform, alignBuildingFloor } from '../public/js/core/building-view-model.js';
import { getLinkColor } from '../public/js/core/link-systems.js';

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
const identity = { scale: 1, offset_x: 0, offset_y: 0, rotation: 0 };

test('basement and missing representatives retain ascending floor order without changing source data', () => {
    const data = { floors: [
        { id: 2, building_id: 1, name: '1F', sort_order: 20, ...identity },
        { id: 1, building_id: 1, name: 'B1', sort_order: -10, ...identity }
    ], views: [], floorPlans: [] };
    const before = JSON.stringify(data);
    const layers = buildingFloorLayers(data, 1);
    assert.deepEqual(layers.map(layer => [layer.floor.name, layer.index]), [['B1', 0], ['1F', 1]]);
    assert.deepEqual(layers.map(layer => layer.corners), Array.from({ length: 2 }, () => [
        { x: 0, y: 0 }, { x: 800, y: 0 }, { x: 800, y: 600 }, { x: 0, y: 600 }
    ]));
    assert.equal(JSON.stringify(data), before);
});

test('比較基準は表記を正規化し、リスト順によらず地上の最小共通階を優先する', () => {
    const primary = namedLayers(1, 10, ['3階', 'Ｂ１', ' １　ｆ ', '2F']);
    const secondary = namedLayers(2, 20, ['2階', '1 階', '地下１階', '3F']);
    assert.deepEqual(buildingComparisonAnchors(primary, secondary), { ids: [12, 21], matched: true });
});

test('地上に共通階がなければ一意な地下の最下層を選ぶ', () => {
    const primary = namedLayers(1, 10, ['1F', 'Ｂ　４Ｆ', 'b2f', '地下 1 階']);
    const secondary = namedLayers(2, 20, ['9F', 'B1', '地下２階', 'B4', '地下4階']);
    assert.deepEqual(buildingComparisonAnchors(primary, secondary), { ids: [12, 22], matched: true });
    assert.deepEqual(buildingComparisonAnchors(primary, secondary.slice(0, -1)), { ids: [11, 23], matched: true });
});

test('両棟の重複キーと番号のない階を自動一致から除外し、先頭階に仮揃えする', () => {
    const primary = namedLayers(1, 10, ['屋上', '1階', '１Ｆ', 'B1', '0F']);
    const secondary = namedLayers(2, 20, ['屋上', '1F', 'Ｂ１Ｆ', '地下1階', '0階']);
    assert.deepEqual(buildingComparisonAnchors(primary, secondary), { ids: [10, 20], matched: false });
    assert.deepEqual(buildingComparisonAnchors(primary, []), { ids: [10, null], matched: false });
    assert.deepEqual(buildingComparisonAnchors([], secondary), { ids: [null, 20], matched: false });
    assert.deepEqual(buildingComparisonAnchors([], []), { ids: [null, null], matched: false });
});

function namedLayers(buildingId, firstId, names) {
    const floors = names.map((name, index) => ({
        id: String(firstId + index), building_id: buildingId, name, sort_order: index
    }));
    return buildingFloorLayers({ floors, views: [], floorPlans: [] }, buildingId);
}

test('代表未設定の階では唯一の物理配置ビューだけを使い、明示設定は置き換えない', () => {
    const floors = [null, null, null, 42, 99].map((representative_view_id, index) => ({
        id: index + 1, building_id: 1, sort_order: index, representative_view_id, ...identity
    }));
    const views = [
        { id: 11, floor_id: 1, view_type: 'topology' },
        { id: 12, floor_id: 1, view_type: 'rack' },
        { id: 21, floor_id: 2, view_type: 'floor' },
        { id: 22, floor_id: 2, view_type: 'topology' },
        { id: 23, floor_id: 2, view_type: 'rack' },
        { id: 31, floor_id: 3, view_type: 'floor' },
        { id: 32, floor_id: 3, view_type: 'floor' },
        { id: 41, floor_id: 4, view_type: 'floor' },
        { id: 42, floor_id: 4, view_type: 'floor' },
        { id: 51, floor_id: 5, view_type: 'floor' },
        { id: 99, floor_id: 6, view_type: 'floor' }
    ];
    const drawn = [21, 31, 41].map(view_id => ({ view_id, image_width: 50, image_height: 25, scale: 1, x: 0, y: 0 }));
    const data = { floors, views, floorPlans: drawn };
    const before = structuredClone(data);
    const layers = buildingFloorLayers(data, 1);
    assert.deepEqual(layers.map(layer => layer.view?.id ?? null), [null, 21, null, 42, null]);
    assert.deepEqual(layers.map(layer => layer.plan?.view_id ?? null), [null, 21, null, null, null]);
    assert.deepEqual(data, before);
});

function connectionFixture() {
    return {
        floors: [
            { id: 1, building_id: 1, sort_order: 1, representative_view_id: '11',
                scale: 2, offset_x: 300, offset_y: -100, rotation: 90 },
            { id: 2, building_id: 1, sort_order: 2 }
        ],
        views: [
            { id: 11, floor_id: 1, view_type: 'floor', show_connections: 0 },
            { id: 21, floor_id: 2, view_type: 'floor', show_connections: 0 }
        ],
        floorPlans: []
    };
}

test('代表図の直接配置とラック搭載・棚搭載を元座標で解決し、同じ中心をまとめる', () => {
    const data = connectionFixture();
    data.views.push({ id: 31, view_type: 'rack', floor_id: 1 });
    data.devices = [
        { id: '1', floor_id: 2 }, { id: 2 }, { id: 3 }, { id: 4 }
    ];
    data.placements = [
        { view_id: '11', device_id: 1, x: '-10', y: '7.5' },
        { view_id: 21, device_id: 4, x: -10, y: 7.5 }
    ];
    data.floorRackPlacements = [{ floor_view_id: '21', rack_view_id: '31', x: 100, y: 25 }];
    data.rackMounts = [{ view_id: 31, device_id: '2' }];
    data.rackShelves = [{ id: 51, view_id: '31', name: '棚' }];
    data.rackShelfDevices = [{ shelf_id: '51', device_id: 3 }];
    data.links = [{ id: 10, from_id: 1, to_id: 2 }];
    const before = structuredClone(data);
    const layers = buildingFloorLayers(data, 1);
    const { devices, locations, groups } = buildingConnections(data, layers);

    assert.ok(layers.every(layer => !layer.plan));
    assert.deepEqual([...devices], [
        [1, { device: data.devices[0], layer: layers[0], point: { x: 44, y: 50.5 } }],
        [2, { device: data.devices[1], layer: layers[1], point: { x: 154, y: 68 } }],
        [3, { device: data.devices[2], layer: layers[1], point: { x: 154, y: 68 } }],
        [4, { device: data.devices[3], layer: layers[1], point: { x: 44, y: 50.5 } }]
    ]);
    assert.deepEqual(locations, new Map([
        ['1:44:50.5', { layer: layers[0], point: { x: 44, y: 50.5 }, devices: [data.devices[0]] }],
        ['2:154:68', { layer: layers[1], point: { x: 154, y: 68 }, devices: data.devices.slice(1, 3) }],
        ['2:44:50.5', { layer: layers[1], point: { x: 44, y: 50.5 }, devices: [data.devices[3]] }]
    ]));
    assert.deepEqual(groups.get('1:2').link_ids, [10]);
    assert.deepEqual(data, before);
});

test('代表位置がないか一意に決まらない機器、同一階の接続、移行保留行は描画しない', () => {
    const data = connectionFixture();
    data.floors.push(
        { id: 3, building_id: 1, sort_order: 3 },
        { id: 4, building_id: 2, sort_order: 1 },
        { id: 5, building_id: 1, sort_order: 4, representative_view_id: 99 }
    );
    data.views.push(
        { id: 12, floor_id: 1, view_type: 'floor' }, // 明示された代表とは別
        { id: 31, floor_id: 3, view_type: 'floor' }, // 代表未確定
        { id: 32, floor_id: 3, view_type: 'floor' },
        { id: 41, floor_id: 4, view_type: 'floor' }, // 別棟
        { id: 51, floor_id: 5, view_type: 'floor' }, // 明示された代表がない
        { id: 61, view_type: 'floor' }, // 未分類
        { id: 62, floor_id: 1, view_type: 'topology' },
        ...[71, 72, 73, 74].map(id => ({ id, view_type: 'rack', floor_id: 1 }))
    );
    data.devices = Array.from({ length: 18 }, (_, index) => ({ id: index + 1, floor_id: 2 }));
    data.placements = [
        [1, 11], [2, 21], [2, 12], [3, 11], [4, 31], [5, 41], [7, 12],
        [8, 11], [8, 21], [9, 21], [9, 21], [10, 21], [13, 51],
        [14, 61], [15, 62], [16, 21], [17, 21], [99, 21]
    ].map(([device_id, view_id]) => ({ device_id, view_id, x: device_id, y: 0 }));
    data.floorRackPlacements = [
        { floor_view_id: 21, rack_view_id: 71, x: 10, y: 0 }, // 直接配置と同一点で競合
        { floor_view_id: 12, rack_view_id: 72, x: 0, y: 0 }, // 非代表のラック
        { floor_view_id: 11, rack_view_id: 74, x: 0, y: 0 },
        { floor_view_id: 21, rack_view_id: 74, x: 0, y: 0 } // ラックの解決先が複数階
    ];
    data.rackMounts = [
        { device_id: 10, view_id: 71 }, { device_id: 11, view_id: 72 },
        { device_id: 12, view_id: 73 }, { device_id: 18, view_id: 74 }
    ];
    data.links = data.devices.slice(1, 16).map(({ id }) => ({ id, from_id: 1, to_id: id }));
    data.links.push({ id: 99, from_id: 1, to_id: 99 }, { id: 18, from_id: 1, to_id: 18 });
    data.legacy_link_conflicts = [{ id: 17, from_id: 1, to_id: 17 }];
    const { devices, groups, locations } = buildingConnections(data, buildingFloorLayers(data, 1));
    assert.deepEqual([...devices.keys()], [1, 2, 3, 16, 17]);
    assert.deepEqual([...groups.keys()], ['1:2', '1:16']);
    assert.equal(locations.size, devices.size);
});

test('比較では2棟全体で端点を解決し、座標が重なる機器もペア単位で接続を分類する', () => {
    const data = connectionFixture();
    data.floors[1].building_id = '2';
    data.floors.push({ id: 3, building_id: '1', sort_order: 3 });
    data.views.push(
        { id: 31, view_type: 'rack', floor_id: 2 },
        { id: 32, view_type: 'rack', floor_id: 2 },
        { id: 41, view_type: 'floor', floor_id: 3 }
    );
    data.devices = Array.from({ length: 9 }, (_, index) => ({ id: index + 1 }));
    data.placements = [[11, 1], [21, 4], [41, 5], [11, 6], [21, 6], [11, 8], [21, 9]]
        .map(([view_id, device_id]) => ({ view_id, device_id, x: 0, y: 0 }));
    data.floorRackPlacements = [
        { floor_view_id: 21, rack_view_id: 31, x: 80, y: 90 },
        { floor_view_id: 11, rack_view_id: 32, x: 0, y: 0 },
        { floor_view_id: 21, rack_view_id: 32, x: 0, y: 0 }
    ];
    data.rackMounts = [{ view_id: 31, device_id: 2 }, { view_id: 32, device_id: 7 }];
    data.rackShelves = [{ id: 51, view_id: 31 }];
    data.rackShelfDevices = [{ shelf_id: 51, device_id: 3 }, { shelf_id: 51, device_id: 8 }];
    data.links = data.devices.slice(1).map(({ id }) => ({ id, from_id: 1, to_id: id }));
    data.links.push({ id: 10, from_id: 3, to_id: 1 }, { id: 11, from_id: 2, to_id: 3 });
    const before = structuredClone(data);
    const layers = [1, 2].flatMap(id => buildingFloorLayers(data, id));
    const { devices, locations, groups } = buildingConnections(data, layers);

    assert.deepEqual([...devices.keys()], [1, 2, 3, 4, 5, 9]);
    assert.deepEqual(devices.get(2).point, { x: 134, y: 133 });
    assert.deepEqual(devices.get(3).point, devices.get(2).point);
    assert.deepEqual(devices.get(4).point, devices.get(1).point);
    assert.deepEqual(locations.get('1:54:43').devices.map(device => device.id), [1]);
    assert.deepEqual(locations.get('2:54:43').devices.map(device => device.id), [4, 9]);
    assert.deepEqual([...groups].map(([key, group]) => [key, group.interBuilding, group.link_ids]), [
        ['1:2', true, [2]], ['1:3', true, [3, 10]], ['1:4', true, [4]], ['1:5', false, [5]], ['1:9', true, [9]]
    ]);
    assert.deepEqual(data, before);
});

test('機器ペアごとにID順で集約し、個別接続の向き・ポート表示・元明細を維持する', () => {
    const data = connectionFixture();
    data.devices = [{ id: 1 }, { id: 2 }];
    data.placements = [
        { device_id: 1, view_id: 11, x: 0, y: 0 },
        { device_id: 2, view_id: 21, x: 0, y: 0 }
    ];
    data.links = [
        { id: '10', from_id: 1, to_id: 2, to_port_id: 22, label: '台帳登録', system_id: 7 },
        { id: '2', from_id: '2', to_id: '1', from_port_id: '22', to_port_id: 11,
            to_port_name: '編集したポート', system_id: '7', label: '逆方向', memo: '光', resource_revision: 42 },
        { id: 11, from_id: 2, to_id: 1, from_port_id: null, to_port_id: null, system_id: 7 }
    ];
    data.devicePorts = [{ id: 11, name: 'Gi0/1' }, { id: '22', name: 'eth2' }];
    const { groups } = buildingConnections(data, buildingFloorLayers(data, 1));
    assert.deepEqual([...groups], [['1:2', {
        from_id: 1, to_id: 2, interBuilding: false, link_ids: [2, 10, 11], system_ids: [7], system_id: 7,
        members: [
            { ...data.links[1], from_port: 'eth2', to_port: '編集したポート' },
            { ...data.links[0], from_port: '', to_port: 'eth2' },
            { ...data.links[2], from_port: '', to_port: '' }
        ]
    }]]);
    assert.deepEqual(data.links.map(link => link.id), ['10', '2', 11]);
});

test('全件が同じ系統のときだけ割当を返し、共通パレットにない系統は中立色になる', () => {
    const data = connectionFixture();
    data.linkSystems = [
        { id: '1', color_key: 'teal' }, { id: 2, color_key: 'teal' }, { id: 3, color_key: 'unknown' }
    ];
    const cases = [
        [[1, '1'], [1], 1, 'var(--link-system-teal, #167D8D)'],
        [[1, 2], [1, 2], null],
        [[1, null], [1, null], null],
        [[null, undefined], [null], null],
        [[99], [99], 99],
        [[3], [3], 3]
    ];
    data.devices = Array.from({ length: cases.length + 1 }, (_, index) => ({ id: index + 1 }));
    data.placements = data.devices.map(({ id }) => ({
        device_id: id, view_id: id === 1 ? 11 : 21, x: id, y: 0
    }));
    data.links = cases.flatMap(([values], index) => values.map((system_id, offset) => ({
        id: 10 * index + offset + 1, from_id: 1, to_id: index + 2, system_id
    })));
    const { groups, systems } = buildingConnections(data, buildingFloorLayers(data, 1));
    assert.deepEqual(systems, new Map(data.linkSystems.map(system => [Number(system.id), system])));
    for (const [index, [, systemIds, systemId, expectedColor]] of cases.entries()) {
        const group = groups.get(`1:${index + 2}`);
        assert.deepEqual(group.system_ids, systemIds);
        assert.equal(group.system_id, systemId);
        assert.equal(getLinkColor({ system_id: group.system_id }, systems),
            expectedColor ?? 'var(--link-default-color, rgba(71,85,105,.72))');
    }
});

test('image dimensions, original center rotation and floor transform compose in common XY', () => {
    const data = { floors: [{ id: 1, building_id: 1, representative_view_id: 5,
        scale: 2, offset_x: 3, offset_y: 4, rotation: 90 }],
    views: [{ id: 5, floor_id: 1, view_type: 'floor' }],
    floorPlans: [{ view_id: 5, image_width: 100, image_height: 50, x: 10, y: 20, scale: 2, rotation: 90 }] };
    const before = JSON.stringify(data);
    const points = transformedFloorCorners(buildingFloorLayers(data, 1)[0]);
    near(points[0].x, 63); near(points[0].y, 324);
    near(points[1].x, -337); near(points[1].y, 324);
    assert.equal(JSON.stringify(data), before);
});

test('簡易自動整列は元図面の倍率・回転を含めて中心、辺の向きと外形の面積を合わせる', () => {
    const data = {
        floors: [
            { id: 1, building_id: 1, representative_view_id: 5, ...identity, offset_x: 999 },
            { id: 2, building_id: 1, representative_view_id: 6, scale: 3, offset_x: -45, offset_y: 72, rotation: -130 },
            { id: 3, building_id: 1, ...identity }
        ],
        views: [5, 6].map((id, index) => ({ id, floor_id: index + 1, view_type: 'floor' })),
        floorPlans: [
            { view_id: 5, image_width: 60, image_height: 160, x: -20, y: 5, scale: 2, rotation: 165 },
            { view_id: 6, image_width: 200, image_height: 180, x: 4, y: 20, scale: 0.5, rotation: 25 }
        ]
    };
    const original = structuredClone(data);
    const [target, reference, noPlan] = buildingFloorLayers(data, 1);
    const result = alignBuildingFloor(target, reference);
    const a = transformedFloorCorners(target, result), b = transformedFloorCorners(reference);
    const length = (points, side) => Math.hypot(points[side].x - points[0].x, points[side].y - points[0].y);
    near((a[0].x + a[2].x) / 2, (b[0].x + b[2].x) / 2);
    near((a[0].y + a[2].y) / 2, (b[0].y + b[2].y) / 2);
    near((a[1].x - a[0].x) / length(a, 1), (b[1].x - b[0].x) / length(b, 1));
    near((a[1].y - a[0].y) / length(a, 1), (b[1].y - b[0].y) / length(b, 1));
    near(length(a, 1) * length(a, 3), length(b, 1) * length(b, 3));
    near(length(a, 1) / length(a, 3), 60 / 160);
    assert.equal(alignBuildingFloor(target, noPlan), null);
    assert.deepEqual(data, original);
});

test('仮プレートは元図面と建物用変換を適用した外形を参照し、保存済みの変換を保つ', () => {
    const saved = { ...identity, offset_x: 50, offset_y: -30 };
    const data = { floors: [
        { id: 1, building_id: 1, representative_view_id: 5,
            scale: 2, offset_x: 3, offset_y: 4, rotation: 90 },
        { id: 2, building_id: 1, ...identity },
        { id: 3, building_id: 1, ...saved }
    ], views: [{ id: 5, floor_id: 1, view_type: 'floor' }],
    floorPlans: [{ view_id: 5, image_width: 100, image_height: 50, x: 10, y: 20, scale: 2, rotation: 90 }] };
    const before = structuredClone(data);
    const [plan, unadjusted, adjusted] = buildingFloorLayers(data, 1);
    const expected = [{ x: -337, y: 124 }, { x: 63, y: 124 }, { x: 63, y: 324 }, { x: -337, y: 324 }];
    assert.equal(plan.plan, data.floorPlans[0]);
    assert.equal(unadjusted.plan, null);
    assert.deepEqual(adjusted.transform, saved);
    for (const [index, point] of transformedFloorCorners(unadjusted).entries()) {
        near(point.x, expected[index].x);
        near(point.y, expected[index].y);
    }
    for (const [index, point] of transformedFloorCorners(adjusted).entries()) {
        near(point.x, expected[index].x + saved.offset_x);
        near(point.y, expected[index].y + saved.offset_y);
    }
    assert.deepEqual(data, before);
});

test('仮プレートの基準は一つの極端な図面に引きずられず、無効な図面を除外する', () => {
    const plans = [
        { x: 100, y: 200, image_width: 400, image_height: 200, scale: 1 },
        { x: 75, y: 175, image_width: 450, image_height: 250, scale: 1 },
        { x: 5000, y: 5000, image_width: 800, image_height: 600, scale: 1e20 },
        { x: Infinity, y: 20, image_width: 400, image_height: 300, scale: 1 }
    ];
    const floors = plans.map((_, id) => ({ id: id + 1, building_id: 1, representative_view_id: id + 10, ...identity }));
    const data = { floors: [...floors, { id: 5, building_id: 1, ...identity }],
        views: floors.map(floor => ({ id: floor.representative_view_id, floor_id: floor.id, view_type: 'floor' })),
        floorPlans: plans.map((plan, id) => ({ view_id: id + 10, ...plan })) };
    const layers = buildingFloorLayers(data, 1);
    assert.deepEqual(layers[4].corners, [
        { x: 75, y: 175 }, { x: 525, y: 175 }, { x: 525, y: 425 }, { x: 75, y: 425 }
    ]);
});

test('projection drag inverse preserves XY at oblique and rotated viewpoints', () => {
    const frame = { x: 20, y: -40, span: 1600 }, size = { width: 1200, height: 700 };
    for (const azimuth of [-180, -90, 0, 45, 179]) {
        for (const elevation of [15, 35, 75]) {
            const camera = { azimuth, elevation, zoom: 1.7 };
            const a = projectBuildingPoint({ x: 120, y: 200 }, 70, camera, frame, size);
            const b = projectBuildingPoint({ x: 157, y: 179 }, 70, camera, frame, size);
            const delta = buildingDragDelta(b.x - a.x, b.y - a.y, camera, frame, size);
            near(delta.x, 37); near(delta.y, -21);
        }
    }
});

test('single floor frame remains finite, invalid scale and nonfinite transforms are rejected', () => {
    const layer = { corners: [{ x: 0, y: 0 }, { x: 0, y: 0 }], transform: identity };
    const point = projectBuildingPoint({ x: 0, y: 0 }, 0,
        { azimuth: -30, elevation: 35, zoom: 1 }, buildingSceneFrame([layer]), { width: 1000, height: 600 });
    assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
    assert.equal(validFloorTransform(identity), true);
    for (const value of [{ scale: 0 }, { scale: -1 }, { offset_x: Infinity }, { rotation: 181 }]) {
        assert.equal(validFloorTransform({ ...identity, ...value }), false);
    }
});

function assertFits(layers, camera, frame, size, selectedId, selectedTransform, locations = []) {
    const points = layers.flatMap(layer => {
        const transform = layer.floor.id === selectedId ? selectedTransform : undefined;
        return transformedFloorCorners(layer, transform).map(point =>
            projectBuildingPoint(point, buildingFloorZ(layer, frame), camera, frame, size, layer));
    });
    for (const { layer, point } of locations) {
        const transform = layer.floor.id === selectedId ? selectedTransform : layer.transform;
        points.push(projectBuildingPoint(transformBuildingPoint(point, transform),
            buildingFloorZ(layer, frame), camera, frame, size, layer));
    }
    for (const { offsetX, topZ } of frame.buildings?.values() ?? []) {
        points.push(projectBuildingPoint({ x: offsetX, y: 0 }, topZ, camera, frame, size));
    }
    const minX = Math.min(...points.map(point => point.x)), maxX = Math.max(...points.map(point => point.x));
    const minY = Math.min(...points.map(point => point.y)), maxY = Math.max(...points.map(point => point.y));
    const epsilon = 1e-8;
    assert.ok(minX >= 24 - epsilon && maxX <= size.width - 24 + epsilon);
    assert.ok(minY >= 24 - epsilon && maxY <= size.height - 24 + epsilon);
    near(minX + maxX, size.width);
    near(minY + maxY, size.height);
    assert.ok(Math.min(minX, minY) <= 24 + epsilon, 'the stack should use the available width or height');
}

const initialCamera = { azimuth: -30, elevation: 25, zoom: 1 };

test('縦長・横長の画面で非対称な積層と選択階の下書きを余白付きでフィットする', () => {
    const data = { floors: [
        { id: 1, building_id: 1, ...identity, offset_y: -250 },
        { id: 2, building_id: 1, ...identity, offset_x: 400, scale: 1.5 },
        { id: 3, building_id: 1, ...identity, offset_x: -300, offset_y: 800, rotation: 30 }
    ], views: [], floorPlans: [] };
    const layers = buildingFloorLayers(data, 1);
    const frame = buildingSceneFrame(layers);
    const draft = { scale: 2.5, offset_x: -1100, offset_y: 450, rotation: -30 };
    const camera = { ...initialCamera, zoom: 2.3, fitScale: 99, centerU: 111, centerV: 222 };
    const portrait = { width: 360, height: 760 }, landscape = { width: 1260, height: 420 };
    const first = fitBuildingCamera(layers, camera, frame, portrait, '2', draft);
    const second = fitBuildingCamera(layers, first, frame, landscape, '2', draft);
    assertFits(layers, first, frame, portrait, 2, draft);
    assertFits(layers, second, frame, landscape, 2, draft);
    assert.notEqual(first.fitScale, second.fitScale);
    assert.equal(first.zoom, 1);
    assert.equal(second.zoom, 1);
    assert.equal(first.azimuth, initialCamera.azimuth);
    assert.equal(first.elevation, initialCamera.elevation);
    assert.deepEqual(camera, { ...initialCamera, zoom: 2.3, fitScale: 99, centerU: 111, centerV: 222 });
    assert.equal(layers[1].transform.scale, 1.5);
});

test('多数階でも積層のZを含め上下端のプレートを余白付きでフィットする', () => {
    const data = { floors: Array.from({ length: 30 }, (_, index) => ({
        id: index + 1, building_id: 1, sort_order: index, ...identity
    })), views: [], floorPlans: [] };
    const layers = buildingFloorLayers(data, 1);
    const frame = buildingSceneFrame(layers), size = { width: 1000, height: 600 };
    near(buildingFloorZ(layers.at(-1), frame) - buildingFloorZ(layers[0], frame), 29 * frame.span * 0.22);
    assertFits(layers, fitBuildingCamera(layers, initialCamera, frame, size), frame, size);
});

test('フィット後のズームと回転でも投影差とフロア移動の逆変換は一致する', () => {
    const data = { floors: [{ id: 1, building_id: 1, ...identity }], views: [], floorPlans: [] };
    const layers = buildingFloorLayers(data, 1);
    const frame = buildingSceneFrame(layers), size = { width: 460, height: 720 };
    const fit = fitBuildingCamera(layers, initialCamera, frame, size, 1, { ...identity, offset_x: 280 });
    const z = buildingFloorZ(layers[0], frame);
    const point = { x: 160, y: 225 }, moved = { x: 197, y: 204 };
    const a = projectBuildingPoint(point, z, fit, frame, size);
    const b = projectBuildingPoint(moved, z, fit, frame, size);
    const zoomed = { ...fit, zoom: 2.5 };
    const az = projectBuildingPoint(point, z, zoomed, frame, size);
    const bz = projectBuildingPoint(moved, z, zoomed, frame, size);
    near(bz.x - az.x, 2.5 * (b.x - a.x));
    near(bz.y - az.y, 2.5 * (b.y - a.y));
    for (const camera of [fit, zoomed, { ...zoomed, azimuth: 57, elevation: 15 }]) {
        const start = projectBuildingPoint(point, z, camera, frame, size);
        const end = projectBuildingPoint(moved, z, camera, frame, size);
        const delta = buildingDragDelta(end.x - start.x, end.y - start.y, camera, frame, size);
        near(delta.x, 37); near(delta.y, -21);
    }
});

test('比較XYは元図面と階の変換の後に棟単位で合成し、棟内の比率と元データを保つ', () => {
    const data = { floors: [
        { id: 1, building_id: 1, representative_view_id: 5, scale: 2, offset_x: 3, offset_y: 4, rotation: 90 },
        { id: 2, building_id: 1, offset_x: 30, offset_y: 45 },
        { id: 3, building_id: 2, scale: 25, offset_x: -100, offset_y: 30 }
    ], views: [{ id: 5, floor_id: 1, view_type: 'floor' }],
    floorPlans: [{ view_id: 5, image_width: 100, image_height: 50, x: 10, y: 20, scale: 2, rotation: 90 }] };
    const stacks = [1, 2].map(id => ({ id, layers: buildingFloorLayers(data, id) }));
    const before = structuredClone({ data, stacks });
    const frame = buildingComparisonFrame(stacks, [1, 3]);
    const camera = { azimuth: 0, elevation: 90, zoom: 1, fitScale: 1 }, size = { width: 2600, height: 1600 };
    const [west, east] = stacks.map(({ id, layers }) => {
        const placement = frame.buildings.get(id);
        const localFrame = buildingSceneFrame(layers);
        near(placement.x, localFrame.x);
        near(placement.y, localFrame.y);
        return { width: localFrame.span * placement.scale,
            points: layers.flatMap(layer => transformedFloorCorners(layer).map(point => {
                const projected = projectBuildingPoint(point, buildingFloorZ(layer, frame), camera, frame, size, layer);
                const world = { x: (point.x - placement.x) * placement.scale + placement.offsetX,
                    y: (point.y - placement.y) * placement.scale };
                const expected = projectBuildingPoint(world, buildingFloorZ(layer, frame), camera, frame, size);
                near(projected.x, expected.x);
                near(projected.y, expected.y);
                return projected;
            })) };
    });
    near(west.width, east.width);
    assert.notEqual(frame.buildings.get(1).scale, frame.buildings.get(2).scale);
    assert.ok(Math.max(...west.points.map(point => point.x)) < Math.min(...east.points.map(point => point.x)));
    const [upperLeft, upperRight] = west.points;
    near(upperLeft.x, (63 - frame.buildings.get(1).x) * frame.buildings.get(1).scale +
        frame.buildings.get(1).offsetX + size.width / 2);
    near(upperRight.x - upperLeft.x, -400 * frame.buildings.get(1).scale);
    near(upperRight.y, upperLeft.y);
    assert.deepEqual({ data, stacks }, before);
});

test('B1〜5Fと1F〜2Fの比較では基準階を揃え、共通間隔のまま基準変更できる', () => {
    const primary = namedLayers(1, 10, ['B1', '1F', '2F', '3F', '4F', '5F']);
    const secondary = namedLayers(2, 20, ['1階', '2階']);
    const stacks = [{ id: 1, layers: primary }, { id: 2, layers: secondary }];
    const anchors = buildingComparisonAnchors(primary, secondary);
    assert.deepEqual(anchors, { ids: [11, 20], matched: true });
    const frame = buildingComparisonFrame(stacks, anchors.ids);
    const z = (layer, scene = frame) => buildingFloorZ(layer, scene);
    const step = z(primary[2]) - z(primary[1]);
    assert.ok(step > 0);
    near(z(primary[1]), z(secondary[0]));
    near(z(primary[2]), z(secondary[1]));
    near(z(primary[0]), z(primary[1]) - step);
    near(z(primary[5]), z(primary[1]) + 4 * step);
    const changed = buildingComparisonFrame(stacks, [12, 20]);
    near(z(primary[2], changed), z(secondary[0], changed));
    near(z(primary[3], changed), z(secondary[1], changed));
    near(changed.buildings.get(1).topZ, frame.buildings.get(1).topZ - step);
    assert.deepEqual(changed.buildings.get(2), frame.buildings.get(2));
    assert.equal(changed.buildings.get(1).offsetX, frame.buildings.get(1).offsetX);
    assert.equal(changed.buildings.get(1).scale, frame.buildings.get(1).scale);
});

test('空棟を含め、比較のフィットは変換後の外形・機器・建物ラベルのアンカーを収める', () => {
    const size = { width: 660, height: 1000 };
    for (const layers of [namedLayers(2, 20, ['1階', '2階']), []]) {
        const anchors = buildingComparisonAnchors([], layers);
        const frame = buildingComparisonFrame([{ id: 1, layers: [] }, { id: 2, layers }], anchors.ids);
        assert.equal(frame.buildings.size, 2);
        const empty = frame.buildings.get(1);
        assert.ok(Number.isFinite(empty.offsetX) && Number.isFinite(empty.topZ));
        const locations = layers.map(layer => ({ layer, point: { x: 400, y: 2400 } }));
        const camera = fitBuildingCamera(layers, initialCamera, frame, size, undefined, undefined, locations);
        assertFits(layers, camera, frame, size, undefined, undefined, locations);
    }
});

test('パンはズームにかかわらず画面座標に加算され、フィットでリセットされる', () => {
    const layers = namedLayers(1, 10, ['1F']);
    const frame = buildingSceneFrame(layers), size = { width: 820, height: 620 };
    const fit = fitBuildingCamera(layers, initialCamera, frame, size);
    const point = { x: 380, y: 250 }, z = buildingFloorZ(layers[0], frame);
    for (const zoom of [1, 2.5]) {
        const camera = { ...fit, zoom };
        const panned = { ...camera, panX: 78, panY: -51 };
        const a = projectBuildingPoint(point, z, camera, frame, size);
        const b = projectBuildingPoint(point, z, panned, frame, size);
        near(b.x - a.x, 78);
        near(b.y - a.y, -51);
        assert.deepEqual(fitBuildingCamera(layers, panned, frame, size), fit);
        assert.deepEqual(panned, { ...camera, panX: 78, panY: -51 });
    }
});
