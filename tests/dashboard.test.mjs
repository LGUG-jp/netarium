import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    aggregateDashboardDeviceTypes,
    aggregateDashboardFacilities,
    aggregateDashboardMonitoring,
    buildDashboardModel,
    createDashboardGroupKey,
    normalizeDashboardGroupValue,
    validateDashboardModel
} from '../public/js/core/dashboard-model.js';
import { getUnplacedDeviceIds, getPlacedDeviceIds, getDeviceDestinations } from '../public/js/core/device-placement.js';
import {
    DASHBOARD_QUALITY_CODES,
    DASHBOARD_UNSET_LABEL
} from '../public/js/core/constants.js';

const hierarchy = {
    buildings: [{ id: 1, name: '第1庁舎' }, { id: 2, name: '第2庁舎' }],
    floors: [{ id: 11, building_id: 1, name: '1F' }, { id: 12, building_id: 1, name: '2F' },
        { id: 21, building_id: 2, name: '1F' }]
};

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

test('aggregateDashboardFacilities: 設置建物・フロア別の件数と割合を確認', () => {
    const devices = [
        { id: 1, floor_id: 11 }, { id: 2, floor_id: 12 }, { id: 3, floor_id: 11 },
        { id: 4, floor_id: 21 }, { id: 5, floor_id: null, facility: '第1庁舎' }
    ];
    const result = aggregateDashboardFacilities(devices, hierarchy);
    assert.equal(result.length, 3);
    assert.deepEqual(result[0].floors, [
        { floorId: 11, label: '1F', count: 2, percentage: 66.7 },
        { floorId: 12, label: '2F', count: 1, percentage: 33.3 }
    ]);
    assert.equal(result[0].label, '第1庁舎');
    assert.equal(result[0].count, 3);
    assert.equal(result[0].percentage, 60.0);
    assert.equal(result[1].label, '第2庁舎');
    assert.equal(result[1].count, 1);
    assert.equal(result[1].percentage, 20.0);
    assert.deepEqual(result[1].floors, [{ floorId: 21, label: '1F', count: 1, percentage: 100 }]);
    assert.equal(result[2].label, DASHBOARD_UNSET_LABEL);
    assert.equal(result[2].count, 1);
    assert.equal(result[2].percentage, 20.0);
    assert.deepEqual(result[2].floors, []);
});

test('設置先は配置に依存せず、最多件数でも未設定を末尾に置き、空の建物・フロアは含めない', () => {
    const model = buildDashboardModel({
        buildings: [...hierarchy.buildings, { id: 3, name: '空の建物' }],
        floors: [...hierarchy.floors, { id: 99, building_id: 999, name: '孤立フロア' }],
        devices: [{ id: 1, floor_id: 12 }, { id: 2, floor_id: 99 }, { id: 3, floor_id: 999 }],
        placements: [{ id: 10, device_id: 1, view_id: 1 }, { id: 11, device_id: 1, view_id: 2 }],
        rackMounts: [{ device_id: 1, rack_device_id: 2 }]
    });
    assert.deepEqual(model.groups.facilities, [
        {
            key: '1', buildingId: 1, label: '第1庁舎', count: 1, percentage: 33.3,
            floors: [{ floorId: 12, label: '2F', count: 1, percentage: 100 }]
        },
        { key: 'unset', buildingId: null, label: DASHBOARD_UNSET_LABEL, count: 2, floors: [], percentage: 66.7 },
    ]);
});

test('建物・フロアは件数にかかわらず表示順、同順ならID順、未設定は末尾に置く', () => {
    const data = {
        buildings: [
            { id: 2, name: '別館', sort_order: 20 },
            { id: 1, name: '本館', sort_order: 20 },
            { id: 3, name: '新館', sort_order: 10 }
        ],
        floors: [
            { id: 32, building_id: 3, name: '2F', sort_order: 20 },
            { id: 31, building_id: 3, name: '1F', sort_order: 20 },
            { id: 35, building_id: 3, name: '地下', sort_order: 10 },
            { id: 11, building_id: 1, name: '1F', sort_order: 10 },
            { id: 21, building_id: 2, name: '1F', sort_order: 10 }
        ]
    };
    const devices = [21, 21, 21, 21, 21, 11, 32, 32, 31, 35, null]
        .map((floor_id, index) => ({ id: index + 1, floor_id }));
    const { groups } = buildDashboardModel({ ...data, devices });

    assert.deepEqual(groups.facilities.map(({ buildingId, count }) => [buildingId, count]),
        [[3, 4], [1, 1], [2, 5], [null, 1]]);
    assert.deepEqual(groups.facilities[0].floors.map(({ floorId, count }) => [floorId, count]),
        [[35, 1], [31, 1], [32, 2]]);
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
    assert.equal(model.qualitySync, 'synced');

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
    assert.equal(model.totals.qualityTotal, null);
    assert.equal(model.totals.qualityProblems, null);
    assert.equal(model.qualitySync, 'unavailable');
    assert.equal(model.qualityAvailable, false);
    assert.equal(model.groups.facilities.length, 0);
    assert.deepEqual(model.maintenance.fiscalYears.map(row => row.count), [0, 0, 0, 0, 0, 0]);
    assert.equal(model.network.linkCount, 0);
    assert.equal(model.network.portCount, 0);
    assert.equal(model.groups.types.length, 0);

    const errors = validateDashboardModel(model);
    assert.deepEqual(errors, []);
});

test('同名建物もIDごとの集計と台帳の遷移先を保持する', () => {
    const data = {
        buildings: [{ id: 1, name: '同名' }, { id: 2, name: '同名' }],
        floors: [{ id: 11, building_id: 1, name: '1F' }, { id: 21, building_id: 2, name: '1F' }]
    };
    const groups = aggregateDashboardFacilities([{ floor_id: 11 }, { floor_id: 21 }], data);
    assert.deepEqual(groups.map(group => group.buildingId), [1, 2]);
    assert.deepEqual(groups.map(group => group.count), [1, 1]);
    assert.deepEqual(groups.map(group => group.floors[0].floorId), [11, 21]);
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

    const { fiscalYears, ...periods } = model.maintenance;
    const { fiscalYears: laterFiscalYears, ...laterPeriods } = laterModel.maintenance;
    assert.deepEqual(periods, {
        expired: 1, within1Year: 1, within2Years: 1, beyond2Years: 1, invalid: 1, unset: null, suppressed: null
    });
    assert.deepEqual(laterPeriods, {
        expired: 2, within1Year: 1, within2Years: 0, beyond2Years: 1, invalid: 1, unset: null, suppressed: null
    });
    assert.equal(fiscalYears.reduce((sum, row) => sum + row.count, 0), 3);
    assert.equal(laterFiscalYears.reduce((sum, row) => sum + row.count, 0), 2);
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
            { id: 2, name: 'ラックA', hierarchyPath: '未分類', location: '東側', deviceCount: 3,
                faces: { front: { empty: 3, occupiedPercentage: 5 / 12 * 100 }, rear: { empty: 2, occupiedPercentage: 50 } } },
            { id: -3, name: '追加ラック', hierarchyPath: '未分類', location: '', deviceCount: 2,
                faces: { front: { empty: 4, occupiedPercentage: 4 / 12 * 100 }, rear: { empty: 6, occupiedPercentage: 0 } } }
        ]
    });
    assert.equal(model.totals.devices, 5);
    assert.equal(model.totals.unplacedDevices, 1);
    assert.deepEqual(model.groups.facilities, [
        { key: 'unset', buildingId: null, label: DASHBOARD_UNSET_LABEL, count: 5, floors: [], percentage: 100 }
    ]);
    assert.deepEqual(input, before);
    assert.deepEqual(buildDashboardModel().racks, { total: 0, mountedDevices: 0, items: [] });
});

test('年度別保守期限: 基準日と年度末を含め、5年度以降は上限なしで分ける', () => {
    const devices = [
        '2026-03-29', '2026-03-30', '2026-03', '2026-04-01', '2030-03-31',
        '2030-04-01', '2040-01', '2026-02-30', ''
    ].map((maintenance_expiry, index) => ({ id: index + 1, maintenance_expiry }));
    const referenceDate = new Date(2026, 2, 30, 23, 59);
    const { maintenance } = buildDashboardModel({ devices, referenceDate });
    assert.equal(maintenance.expired, 1);
    assert.equal(maintenance.invalid, 1);
    assert.deepEqual(maintenance.fiscalYears, [
        { label: '2025年度（2025/04〜2026/03）', start: '2026-03-30', end: '2026-03-31', count: 2 },
        { label: '2026年度（2026/04〜2027/03）', start: '2026-04-01', end: '2027-03-31', count: 1 },
        { label: '2027年度（2027/04〜2028/03）', start: '2027-04-01', end: '2028-03-31', count: 0 },
        { label: '2028年度（2028/04〜2029/03）', start: '2028-04-01', end: '2029-03-31', count: 0 },
        { label: '2029年度（2029/04〜2030/03）', start: '2029-04-01', end: '2030-03-31', count: 1 },
        { label: '2030年度以降', start: '2030-04-01', end: null, count: 2 }
    ]);
    assert.deepEqual(
        buildDashboardModel({ devices, referenceDate, fiscalYearStartMonth: 13 }).maintenance,
        maintenance
    );
});

test('年度開始月は1月・12月を指定でき、年度名は開始年を用いる', () => {
    const input = {
        referenceDate: new Date(2026, 10, 30),
        devices: [{ id: 1, maintenance_expiry: '2026-11' }, { id: 2, maintenance_expiry: '2026-12-01' }]
    };
    const january = buildDashboardModel({ ...input, fiscalYearStartMonth: 1 }).maintenance.fiscalYears;
    assert.deepEqual(january[0], {
        label: '2026年度（2026/01〜2026/12）', start: '2026-11-30', end: '2026-12-31', count: 2
    });
    const december = buildDashboardModel({ ...input, fiscalYearStartMonth: 12 }).maintenance.fiscalYears;
    assert.deepEqual(december.slice(0, 2), [
        { label: '2025年度（2025/12〜2026/11）', start: '2026-11-30', end: '2026-11-30', count: 1 },
        { label: '2026年度（2026/12〜2027/11）', start: '2026-12-01', end: '2027-11-30', count: 1 }
    ]);
});

test('共通接続はID別に分類し、登録ポートと端点指定は別の分母で数える', () => {
    const devices = [11, 11, 12, 21, 99].map((floor_id, index) => ({ id: index + 1, floor_id }));
    const devicePorts = [[11, 1], [12, 1], [13, 1], [21, 2], [41, 4], [42, 4]]
        .map(([id, device_id]) => ({ id, device_id }));
    const links = [
        [101, 1, 2, 11, 21], [102, 1, 2, 12, 22], [103, 2, 3, null, null],
        [104, 3, 4, null, null], [105, 4, 5, 41, null], [106, 6, 4, null, 41]
    ].map(([id, from_id, to_id, from_port_id, to_port_id]) => ({ id, from_id, to_id, from_port_id, to_port_id }));
    const endpointIssue = {
        code: 'link_ports_missing', severity: 'info', category: 'completeness', entity_type: 'link'
    };
    const qualityResult = {
        ok: true,
        revision: 1,
        issues: [
            { ...endpointIssue, entity_ids: [103], details: { missing_endpoints: { to: { device_id: 3 } } } },
            { ...endpointIssue, entity_ids: [104], details: { missing_endpoints: { from: { device_id: 3 }, to: { device_id: 4 } } } },
            { ...endpointIssue, entity_ids: [105], details: { missing_endpoints: { to: { device_id: 5 } } } }
        ],
        suppressed_issues: [{
            ...endpointIssue,
            entity_ids: [103],
            details: { missing_endpoints: { from: { device_id: 2 } } },
            not_applicable_items: [{ field: 'from_port', device_id: 2 }]
        }],
        suppressed_count: 1
    };
    const { network } = buildDashboardModel({
        ...hierarchy, floors: [...hierarchy.floors, { id: 99, building_id: 999 }],
        devices, devicePorts, links: [...links, links[0]], qualityResult, dataRevision: 1,
        placements: [{ device_id: 5, view_id: 1 }, { device_id: 5, view_id: 2 }]
    });
    assert.deepEqual(network, {
        portCount: 6, linkCount: 6, devicesWithPorts: 3, connectedPorts: 4, unconnectedPorts: 2,
        endpoints: { specified: 6, missing: 5, suppressed: 1 },
        topology: { sameFloor: 2, betweenFloors: 1, betweenBuildings: 1, unknown: 2 }
    });
});

test('品質診断の通常グループと設定不要項目を分け、登録率は機器IDと項目で集計する', () => {
    const devices = [
        { id: 1, memo: 'A', maintenance_expiry: '' },
        { id: 2, memo: 'B', maintenance_expiry: '' },
        { id: 3, memo: 'C', manufacturer: 'C', model: 'C', ip: 'invalid', maintenance_expiry: '2026-13' }
    ];
    const deviceIssue = (code, id, severity, category, details) => ({
        code, entity_type: 'device', entity_ids: [id], severity, category, details
    });
    const recommended = (id, fields) =>
        deviceIssue('missing_recommended_fields', id, 'warning', 'completeness', { fields });
    const withoutIp = id => deviceIssue('monitoring_not_applicable', id, 'info', 'monitoring', { reason: 'ip_not_set' });
    const withoutExpiry = id => deviceIssue('maintenance_expiry_missing', id, 'info', 'maintenance', { field: 'maintenance_expiry' });
    const suppress = (issue, ...fields) => ({
        ...issue,
        not_applicable_items: fields.map(field => ({ field, device_id: issue.entity_ids[0] }))
    });
    const qualityResult = {
        ok: true,
        revision: 4,
        settings: { recommended_device_fields: ['manufacturer', 'model', 'serial_number', 'memo'] },
        issues: [
            recommended(1, ['manufacturer', 'model']),
            recommended(2, ['manufacturer']),
            withoutIp(1), withoutExpiry(1),
            deviceIssue('invalid_maintenance_expiry_date', 3, 'error', 'format', { maintenance_expiry: '2026-13' }),
            { code: 'legacy_link_conflict', severity: 'warning', category: 'integrity', entity_type: 'view', entity_ids: [9] },
            { code: 'legacy_link_vlan', severity: 'warning', category: 'integrity', entity_type: 'link', entity_ids: [10] }
        ],
        summary: { error: 1, warning: 4, info: 2, total: 7 },
        suppressed_issues: [
            suppress(recommended(1, ['serial_number']), 'serial_number'),
            suppress(recommended(2, ['model', 'serial_number']), 'model', 'serial_number'),
            suppress(recommended(3, ['serial_number']), 'serial_number'),
            suppress(withoutIp(2), 'ip'),
            suppress(withoutExpiry(2), 'maintenance_expiry')
        ],
        suppressed_count: 6
    };

    const model = buildDashboardModel({ devices, qualityResult, dataRevision: 4 });
    const recommendedCode = 'missing_recommended_fields';
    assert.deepEqual(model.quality, {
        error: 1, warning: 4, info: 2, problems: 5, total: 7, suppressed: 6, legacyConflicts: 1, legacyVlans: 1,
        categories: [
            { key: 'completeness', problems: 2, info: 0 },
            { key: 'monitoring', problems: 0, info: 1 },
            { key: 'maintenance', problems: 0, info: 1 },
            { key: 'format', problems: 1, info: 0 },
            { key: 'integrity', problems: 2, info: 0 }
        ],
        registration: [
            { key: 'manufacturer', label: 'メーカー', code: recommendedCode, registered: 1, missing: 2, suppressed: 0, percentage: 33.3 },
            { key: 'model', label: '型番', code: recommendedCode, registered: 1, missing: 1, suppressed: 1, percentage: 50 },
            { key: 'serial_number', label: 'シリアル番号', code: recommendedCode, registered: 0, missing: 0, suppressed: 3, percentage: null },
            { key: 'memo', label: '備考', code: recommendedCode, registered: 3, missing: 0, suppressed: 0, percentage: 100 },
            { key: 'ip', label: 'IPアドレス', code: 'monitoring_not_applicable', registered: 1, missing: 1, suppressed: 1, percentage: 50 },
            { key: 'maintenance_expiry', label: '保守期限', code: 'maintenance_expiry_missing', registered: 1, missing: 1, suppressed: 1, percentage: 50 }
        ]
    });
    assert.equal(model.maintenance.unset, 1);
    assert.equal(model.maintenance.suppressed, 1);
    assert.equal(model.maintenance.invalid, 1);
});

test('診断取得中・未取得・未保存・revision不一致では基本集計だけを確定する', () => {
    const qualityResult = {
        ok: true,
        revision: 5,
        issues: [{ severity: 'warning', code: 'missing_recommended_fields', entity_type: 'device', entity_ids: [1] }]
    };
    const input = {
        qualityResult, dataRevision: 5,
        referenceDate: new Date(2026, 3, 1),
        devices: [{ id: 1, maintenance_expiry: '2026-03-31' }],
        devicePorts: [{ id: 101, device_id: 1 }]
    };
    const synced = buildDashboardModel(input);
    assert.equal(synced.qualitySync, 'synced');
    assert.equal(synced.totals.incompleteDevices, 1);
    assert.deepEqual(synced.network.endpoints, { specified: 0, missing: 0, suppressed: 0 });

    for (const [qualitySync, overrides] of [
        ['loading', { qualityLoading: true }],
        ['unavailable', { qualityResult: { ...qualityResult, ok: false } }],
        ['unsaved', { dirty: true }],
        ['revision_mismatch', { dataRevision: 4 }],
        ['revision_mismatch', { dataRevision: 0 }]
    ]) {
        const model = buildDashboardModel({ ...input, ...overrides });
        assert.equal(model.qualitySync, qualitySync);
        assert.equal(model.quality, null);
        for (const key of [
            'incompleteDevices', 'qualityErrors', 'qualityWarnings', 'qualityInfo',
            'qualityTotal', 'qualityProblems', 'floorViewsWithoutPlan'
        ]) assert.equal(model.totals[key], null, key);
        assert.deepEqual(model.entityIds.incompleteDevices, []);
        assert.equal(model.maintenance.unset, null);
        assert.equal(model.maintenance.suppressed, null);
        assert.equal(model.network.endpoints, null);
        assert.equal(model.maintenance.expired, 1);
        assert.equal(model.network.portCount, 1);
    }
});
