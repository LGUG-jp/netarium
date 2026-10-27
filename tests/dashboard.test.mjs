import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    addDashboardGroupPercentages,
    aggregateDashboardDeviceTypes,
    aggregateDashboardFacilities,
    aggregateDashboardFloors,
    aggregateDashboardGroups,
    aggregateDashboardMonitoring,
    aggregateDashboardQuality,
    buildDashboardModel,
    compareDashboardGroups,
    createDashboardGroupKey,
    getDashboardDeviceTypeLabel,
    getDashboardIncompleteDeviceIds,
    getDashboardUnplacedDeviceIds,
    normalizeDashboardGroupValue,
    validateDashboardModel
} from '../public/js/core/dashboard-model.js';
import { getUnplacedDeviceIds, getPlacedDeviceIds, getDeviceDestinations } from '../public/js/core/device-placement.js';
import {
    DASHBOARD_QUALITY_CODES,
    DASHBOARD_UNSET_LABEL,
    DEVICE_TYPES
} from '../public/js/core/constants.js';

test('normalizeDashboardGroupValue and createDashboardGroupKey', () => {
    assert.equal(normalizeDashboardGroupValue(''), DASHBOARD_UNSET_LABEL);
    assert.equal(normalizeDashboardGroupValue('  '), DASHBOARD_UNSET_LABEL);
    assert.equal(normalizeDashboardGroupValue(null), DASHBOARD_UNSET_LABEL);
    assert.equal(normalizeDashboardGroupValue(' 本庁舎 '), '本庁舎');

    assert.equal(createDashboardGroupKey(' 本庁舎 '), '本庁舎');
    assert.equal(createDashboardGroupKey(''), '未設定');
});

test('aggregateDashboardMonitoring: 正確に状態別の台数を集計する', () => {
    const devices = [
        { id: 1, status: 'green' },
        { id: 2, status: 'green' },
        { id: 3, status: 'red' },
        { id: 4, status: 'red' },
        { id: 5, status: 'unknown' },
        { id: 6, status: 'checking' },
        { id: 7, status: null }
    ];
    const result = aggregateDashboardMonitoring(devices);
    assert.equal(result.green, 2);
    assert.equal(result.red, 2);
    assert.equal(result.unknown, 3);
});

test('aggregateDashboardFacilities: 施設別の件数・割合とソート順を確認', () => {
    const devices = [
        { id: 1, facility: '第1庁舎' },
        { id: 2, facility: '第1庁舎' },
        { id: 3, facility: '第1庁舎' },
        { id: 4, facility: '第2庁舎' },
        { id: 5, facility: '' }
    ];
    const result = aggregateDashboardFacilities(devices);
    assert.equal(result.length, 3);
    assert.equal(result[0].label, '第1庁舎');
    assert.equal(result[0].count, 3);
    assert.equal(result[0].percentage, 60.0);
    assert.equal(result[1].label, '第2庁舎');
    assert.equal(result[1].count, 1);
    assert.equal(result[1].percentage, 20.0);
    assert.equal(result[2].label, DASHBOARD_UNSET_LABEL);
    assert.equal(result[2].count, 1);
    assert.equal(result[2].percentage, 20.0);
});

test('aggregateDashboardFloors: 施設とフロアの組み合わせで集計する', () => {
    const devices = [
        { id: 1, facility: '第1庁舎', floor: '1F' },
        { id: 2, facility: '第1庁舎', floor: '1F' },
        { id: 3, facility: '第1庁舎', floor: '2F' },
        { id: 4, facility: '第2庁舎', floor: '1F' }
    ];
    const result = aggregateDashboardFloors(devices);
    assert.equal(result.length, 3);
    assert.equal(result[0].label, '第1庁舎 / 1F');
    assert.equal(result[0].count, 2);
    assert.equal(result[0].percentage, 50.0);
});

test('aggregateDashboardDeviceTypes: 機器種別別の集計とラベル変換を確認', () => {
    const devices = [
        { id: 1, type: 'server' },
        { id: 2, type: 'server' },
        { id: 3, type: 'switch' },
        { id: 4, type: 'unknown_type' }
    ];
    const result = aggregateDashboardDeviceTypes(devices);
    assert.equal(result.length, 3);
    assert.equal(result[0].label, 'サーバ');
    assert.equal(result[0].count, 2);
    assert.equal(result[0].percentage, 50.0);
    assert.equal(result[1].label, 'L2スイッチ');
    assert.equal(result[1].count, 1);
    assert.equal(result[1].percentage, 25.0);
    assert.equal(result[2].label, DASHBOARD_UNSET_LABEL);
    assert.equal(result[2].count, 1);
    assert.equal(result[2].percentage, 25.0);
});

test('getUnplacedDeviceIds: 未配置機器の抽出を確認', () => {
    const devices = [
        { id: 1, name: 'srv1' },
        { id: 2, name: 'srv2' },
        { id: 3, name: 'srv3' }
    ];
    const placements = [
        { id: 101, device_id: 1, view_id: 10 }
    ];
    const unplaced = getUnplacedDeviceIds(devices, placements);
    assert.deepEqual(unplaced, [2, 3]);
});

test('buildDashboardModel & validateDashboardModel: 正常モデルが検証を通過する', () => {
    const devices = [
        { id: 1, name: 'srv1', type: 'server', facility: '本庁舎', floor: '1F', status: 'green' },
        { id: 2, name: 'sw1', type: 'switch', facility: '本庁舎', floor: '1F', status: 'red' },
        { id: 3, name: 'pc1', type: 'pc', facility: '本庁舎', floor: '2F', status: 'unknown' }
    ];
    const placements = [
        { id: 10, device_id: 1, view_id: 1 },
        { id: 11, device_id: 2, view_id: 1 }
    ];
    const qualityResult = {
        ok: true,
        revision: 5,
        generated_at: '2026-10-01T12:00:00Z',
        issues: [
            {
                severity: 'error',
                code: 'duplicate_ip',
                entity_type: 'device',
                entity_ids: [1],
                title: 'IP重複'
            },
            {
                severity: 'warning',
                code: DASHBOARD_QUALITY_CODES.unplacedDevice,
                entity_type: 'device',
                entity_ids: [3],
                title: '未配置機器'
            },
            {
                severity: 'warning',
                code: DASHBOARD_QUALITY_CODES.floorViewWithoutPlan,
                entity_type: 'view',
                entity_ids: [2],
                title: '図面未登録'
            }
        ]
    };

    const model = buildDashboardModel({
        devices,
        placements,
        qualityResult,
        dataRevision: 5,
        dirty: false
    });

    assert.equal(model.totals.devices, 3);
    assert.equal(model.totals.green, 1);
    assert.equal(model.totals.red, 1);
    assert.equal(model.totals.unknown, 1);
    assert.equal(model.totals.unplacedDevices, 1); // device 3 is not in placements
    assert.equal(model.totals.qualityErrors, 1);
    assert.equal(model.totals.qualityWarnings, 2);
    assert.equal(model.totals.qualityTotal, 3);
    assert.equal(model.totals.qualityProblems, 3); // 1 error + 2 warnings
    assert.equal(model.totals.floorViewsWithoutPlan, 1);
    assert.equal(model.qualityAvailable, true);
    assert.equal(model.qualityRevisionMatches, true);

    const validationErrors = validateDashboardModel(model);
    assert.deepEqual(validationErrors, []);
});

test('validateDashboardModel: 整合性エラーを検出する', () => {
    const invalidModel = {
        totals: {
            devices: 10,
            green: 5,
            red: 2,
            unknown: 1 // 5 + 2 + 1 = 8 !== 10
        },
        groups: {
            facilities: [{ count: 10 }],
            floors: [{ count: 10 }],
            types: [{ count: 10 }]
        }
    };
    const errors = validateDashboardModel(invalidModel);
    assert.ok(errors.length > 0);
    assert.ok(errors.some(e => e.includes('監視状態の合計が総機器数と一致しません')));
});

test('buildDashboardModel: 空データおよびqualityResultなしの初期状態を正しく処理する', () => {
    const model = buildDashboardModel({
        devices: [],
        placements: [],
        qualityResult: null,
        dataRevision: 0,
        dirty: false
    });

    assert.equal(model.totals.devices, 0);
    assert.equal(model.totals.green, 0);
    assert.equal(model.totals.red, 0);
    assert.equal(model.totals.unknown, 0);
    assert.equal(model.totals.unplacedDevices, 0);
    assert.equal(model.totals.qualityTotal, 0);
    assert.equal(model.totals.qualityProblems, 0);
    assert.equal(model.qualityAvailable, false);
    assert.equal(model.groups.facilities.length, 0);
    assert.equal(model.groups.floors.length, 0);
    assert.equal(model.groups.types.length, 0);

    const errors = validateDashboardModel(model);
    assert.deepEqual(errors, []);
});

test('内訳の初期表示件数（5件制限）と展開ロジックの動作を確認', () => {
    const manyDevices = [
        { id: 1, facility: '施設A' },
        { id: 2, facility: '施設B' },
        { id: 3, facility: '施設C' },
        { id: 4, facility: '施設D' },
        { id: 5, facility: '施設E' },
        { id: 6, facility: '施設F' },
        { id: 7, facility: '施設G' }
    ];
    const facilities = aggregateDashboardFacilities(manyDevices);
    assert.equal(facilities.length, 7);

    // 初期表示: 5件
    const initialSlice = facilities.slice(0, 5);
    assert.equal(initialSlice.length, 5);
    assert.equal(initialSlice[0].label, '施設A');
    assert.equal(initialSlice[4].label, '施設E');

    // 展開時: 全件
    assert.equal(facilities.length, 7);
});

test('buildDashboardModel: 指定基準日で保守期限を集計し、既存の監視・内訳集計と元値を保つ', () => {
    const devices = [
        { id: 1, facility: '施設A', floor: '1F', type: 'server', status: 'green', maintenance_expiry: '2025-12' },
        { id: 2, facility: '施設A', floor: '1F', type: 'server', status: 'red', maintenance_expiry: '2026-12' },
        { id: 3, facility: '施設B', floor: '2F', type: 'server', status: 'unknown', maintenance_expiry: '2027-12' },
        { id: 4, facility: '施設B', floor: '2F', type: 'server', status: 'green', maintenance_expiry: '2029-12' },
        { id: 5, facility: '施設B', floor: '2F', type: 'server', status: 'green', maintenance_expiry: '' },
        { id: 6, facility: '施設B', floor: '2F', type: 'server', status: 'green', maintenance_expiry: 'invalid' }
    ];
    const originalDevices = structuredClone(devices);
    const model = buildDashboardModel({ devices, referenceDate: new Date(2026, 0, 1) });
    const laterModel = buildDashboardModel({ devices, referenceDate: new Date(2027, 0, 1) });

    assert.deepEqual(model.maintenance, {
        expired: 1, within1Year: 1, within2Years: 1, beyond2Years: 1, unset: 1
    });
    assert.deepEqual(laterModel.maintenance, {
        expired: 2, within1Year: 1, within2Years: 0, beyond2Years: 1, unset: 1
    });
    assert.deepEqual(model.totals, laterModel.totals);
    assert.deepEqual(model.groups, laterModel.groups);
    assert.equal(model.totals.devices, 6);
    assert.equal(model.totals.green, 4);
    assert.equal(model.totals.red, 1);
    assert.equal(model.totals.unknown, 1);
    assert.deepEqual(validateDashboardModel(model), []);
    assert.deepEqual(devices, originalDevices);
});

test('rack-only devices are placed, destinations coexist with XY, and ledger location is untouched', () => {
    const devices = [
        { id: 1, type: 'switch', facility: '台帳施設', floor: '旧階', location: '台帳場所' },
        { id: 2, type: 'server' }, { id: 3, type: 'other' }
    ];
    const placements = [{ device_id: 1, view_id: 10 }];
    const mounts = [{ device_id: 1, view_id: 20, face: 'both', start_u: 2, height_u: 2, width_slot: 'full' },
        { device_id: 2, view_id: 20, face: 'rear', start_u: 1, height_u: 1, width_slot: 'left' }];
    const views = [{ id: 10, view_type: 'topology' }, { id: 20, view_type: 'rack', facility: 'ラック施設' }];
    const before = structuredClone(devices);
    assert.deepEqual([...getPlacedDeviceIds(placements, mounts)], [1, 2]);
    assert.deepEqual(getUnplacedDeviceIds(devices, placements, mounts), [3]);
    assert.deepEqual(getDeviceDestinations(1, placements, mounts, views).map(item => [item.kind, item.view.id]),
        [['xy', 10], ['rack', 20]]);
    const rackOnly = getDeviceDestinations(2, placements, mounts, views);
    assert.equal(rackOnly[0].mount, mounts[1]);
    assert.equal(rackOnly[0].placement, undefined);
    const model = buildDashboardModel({ devices, placements, rackMounts: mounts });
    assert.equal(model.totals.unplacedDevices, 1);
    assert.deepEqual(devices, before);
});

test('ラック集計は面・幅・表示の重複を機器IDで除き、通常配置や台帳の集計を変えない', () => {
    const input = {
        views: [
            { id: 1, view_type: 'topology', name: '通常構成' },
            { id: 2, view_type: 'rack', name: 'ラックA', facility: '合成施設', floor: '1F' },
            { id: -3, view_type: 'rack', name: '追加ラック' },
            { id: 4, view_type: 'floor', name: 'フロア' }
        ],
        devices: [1, 2, 3, 4, 5].map(id => ({ id, type: 'server', facility: '台帳施設' })),
        placements: [{ device_id: 1, view_id: 1 }],
        rackMounts: [
            { view_id: 2, device_id: 1, face: 'both', width_slot: 'full', start_u: 1, height_u: 2 },
            { view_id: 2, device_id: '1', face: 'rear', width_slot: 'full', start_u: 1, height_u: 2 },
            { view_id: '2', device_id: 2, face: 'front', width_slot: 'left', start_u: 3, height_u: 1 },
            { view_id: 2, device_id: 3, face: 'rear', width_slot: 'right', start_u: 4, height_u: 2 },
            { view_id: -3, device_id: 4, face: 'front', width_slot: 'full', start_u: 1, height_u: 1 },
            { view_id: -3, device_id: 1, face: 'front', width_slot: 'full', start_u: 2, height_u: 1 }
        ],
        rackSettings: [{ view_id: '2', total_u: 6, location: ' 東側 ' }, { view_id: -3, total_u: 6 }]
    };
    const before = structuredClone(input);
    const model = buildDashboardModel(input);
    assert.deepEqual(model.racks, {
        total: 2,
        mountedDevices: 4,
        items: [
            { id: 2, name: 'ラックA', facility: '合成施設', floor: '1F', location: '東側', deviceCount: 3,
                faces: { front: { empty: 3, occupiedPercentage: 5 / 12 * 100 }, rear: { empty: 2, occupiedPercentage: 50 } } },
            { id: -3, name: '追加ラック', facility: '', floor: '', location: '', deviceCount: 2,
                faces: { front: { empty: 4, occupiedPercentage: 4 / 12 * 100 }, rear: { empty: 6, occupiedPercentage: 0 } } }
        ]
    });
    assert.equal(model.totals.devices, 5);
    assert.equal(model.totals.unplacedDevices, 1);
    assert.deepEqual(model.groups.facilities, [{ key: '台帳施設', label: '台帳施設', count: 5, percentage: 100 }]);
    assert.deepEqual(input, before);
    assert.deepEqual(buildDashboardModel().racks, { total: 0, mountedDevices: 0, items: [] });
});
