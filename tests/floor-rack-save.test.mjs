import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appState, normalizeView, normalizeDevice } from '../public/js/core/state.js';
import { validateFloorRackPlacements } from '../public/js/core/floor-rack-data.js';
import { createResourceBaseline, buildResourceSave, buildSaveableResourceSave, createPendingResourceSave,
    applyResourceSaveResult, resetResourceBaseline, reloadResourceFromData, hasResourceChangesSince } from '../public/js/core/resource-save.js';

function fixture() {
    return { devices: [], views: ['floor', 'floor', 'rack'].map((view_type, i) => normalizeView({
        id: i + 1, name: `View ${i + 1}`, view_type, resource_revision: i + 10 })),
    placements: [], links: [], canvasNotes: [], rackSettings: [{ view_id: 3, total_u: 42, location: '' }],
    rackMounts: [], rackShelves: [], rackShelfDevices: [],
    floorRackPlacements: [{ floor_view_id: 1, rack_view_id: 3, x: 20, y: 30 }] };
}
function install(data) {
    Object.assign(appState, data, { currentViewId: 1, floorPlans: [], deviceImages: [],
        selectedPlacementIds: new Set(), viewStates: new Map(), floorPlanAutoFittedViews: new Set(),
        resourceConflicts: { devices: new Map(), views: new Map() } });
    resetResourceBaseline(appState);
}

test('参照先・種別・全体一意性・座標の不正を拒否する', () => {
    validateFloorRackPlacements(fixture());
    for (const change of [{ floor_view_id: 3 }, { rack_view_id: 2 }, { rack_view_id: 99 }, { x: Infinity }, { y: NaN }]) {
        const data = fixture(); Object.assign(data.floorRackPlacements[0], change);
        assert.throws(() => validateFloorRackPlacements(data));
    }
    const data = fixture(); data.floorRackPlacements.push({ floor_view_id: 2, rack_view_id: 3, x: 0, y: 0 });
    assert.throws(() => validateFloorRackPlacements(data), /1か所/);
});

test('参照移設は元先revisionで保存し片側競合では両側を保留する', () => {
    const data = fixture(), baseline = createResourceBaseline(data);
    data.floorRackPlacements[0].floor_view_id = 2;
    assert.deepEqual(buildResourceSave(data, baseline).views.map(row => [row.id, row.expected_revision]), [[1, 10], [2, 11]]);
    data.resourceConflicts = { devices: new Map(), views: new Map([[1, {}]]) };
    assert.deepEqual(buildSaveableResourceSave(data, baseline), { devices: [], views: [] });
});

test('保存中の追加ドラッグは応答で上書きせず次回の保存対象になる', () => {
    const data = fixture(); install(data);
    appState.floorRackPlacements[0].x = 40;
    const pending = createPendingResourceSave(buildResourceSave());
    appState.floorRackPlacements[0].x = 60;
    assert.equal(hasResourceChangesSince(pending), true);
    applyResourceSaveResult({ revision: 30, id_maps: {}, devices: [], views: [{ ...data.views[0], resource_revision: 30 }],
        placements: [], links: [], canvas_notes: [], floor_rack_placements: [{ floor_view_id: 1, rack_view_id: 3, x: 40, y: 30 }],
        deleted_device_ids: [], deleted_view_ids: [], affected_view_ids: [1] }, pending);
    assert.equal(appState.floorRackPlacements[0].x, 60);
    assert.equal(buildResourceSave().views[0].expected_revision, 30);
});

test('ラック削除応答でアイコンだけ整理し古い参照を再保存しない', () => {
    const data = fixture(); install(data);
    appState.views = appState.views.filter(row => row.id !== 3);
    appState.rackSettings = []; appState.floorRackPlacements = [];
    const pending = createPendingResourceSave(buildResourceSave());
    applyResourceSaveResult({ revision: 31, id_maps: {}, devices: [], views: [{ ...data.views[0], resource_revision: 31 }],
        placements: [], links: [], canvas_notes: [], floor_rack_placements: [],
        deleted_device_ids: [], deleted_view_ids: [3], affected_view_ids: [1, 3] }, pending);
    assert.deepEqual(appState.floorRackPlacements, []);
    assert.deepEqual(buildResourceSave(), { devices: [], views: [] });
});

test('競合後のフロア再読込で保存済みラック座標を復元する', () => {
    install(fixture()); appState.floorRackPlacements[0].x = 99;
    const remote = fixture(); remote.views[0].resource_revision = 40; remote.floorRackPlacements[0].x = 12;
    reloadResourceFromData('views', 1, remote);
    assert.equal(appState.floorRackPlacements[0].x, 12);
    assert.deepEqual(buildResourceSave(), { devices: [], views: [] });
});

test('参照移設先の再読込で元フロアも同期し二重配置を残さない', () => {
    install(fixture());
    const remote = fixture(); remote.floorRackPlacements[0].floor_view_id = 2;
    remote.views[0].resource_revision = 50; remote.views[1].resource_revision = 51;
    reloadResourceFromData('views', 2, remote);
    assert.deepEqual(appState.floorRackPlacements.map(row => row.floor_view_id), [2]);
    assert.deepEqual(buildResourceSave(), { devices: [], views: [] });
});

test('ビュー採番で参照元と参照先を一緒に更新する', () => {
    const data = fixture(); data.views[0].id = -1; data.views[2].id = -3;
    data.floorRackPlacements = [{ floor_view_id: -1, rack_view_id: -3, x: 2, y: 3 }];
    data.rackSettings[0].view_id = -3; install(data);
    // 新規ビューを含む送信前の基準は空。
    resetResourceBaseline({ devices: [], views: [] });
    const pending = createPendingResourceSave(buildResourceSave());
    applyResourceSaveResult({ revision: 60, id_maps: { views: { '-1': 10, '-3': 30, '2': 20 } }, devices: [],
        views: data.views.map(row => ({ ...row, id: ({ '-1': 10, '-3': 30, '2': 20 })[row.id], resource_revision: 60 })),
        placements: [], links: [], canvas_notes: [],
        floor_rack_placements: [{ floor_view_id: 10, rack_view_id: 30, x: 2, y: 3 }],
        rack_settings: [{ view_id: 30, total_u: 42, location: '' }], rack_mounts: [], rack_shelves: [], rack_shelf_devices: [],
        deleted_device_ids: [], deleted_view_ids: [], affected_view_ids: [10, 20, 30] }, pending);
    assert.deepEqual(appState.floorRackPlacements, [{ floor_view_id: 10, rack_view_id: 30, x: 2, y: 3 }]);
    assert.deepEqual(buildResourceSave(), { devices: [], views: [] });
});

for (const newFloor of [false, true]) test(`移設元の再読込は${newFloor ? '新規' : '既存'}フロアの未保存参照を整理し別の編集を保持する`, () => {
    install(fixture());
    const destinationId = newFloor ? 4 : 2;
    if (newFloor) appState.views.push(normalizeView({ id: 4, name: 'New floor', view_type: 'floor' }));
    const destination = appState.views.find(row => row.id === destinationId);
    destination.memo = 'Local memo';
    appState.floorRackPlacements[0].floor_view_id = destinationId;
    const remote = fixture();
    reloadResourceFromData('views', 1, remote);
    assert.deepEqual(appState.floorRackPlacements, remote.floorRackPlacements);
    validateFloorRackPlacements(appState);
    assert.equal(destination.memo, 'Local memo');
    assert.equal(appState.resourceConflicts.views.has(destinationId), true);
    assert.deepEqual(buildSaveableResourceSave().views, []);
});

test('フロア再読込は未取得ラックの搭載・棚板・機器・メモを補完し既存の編集を保持する', () => {
    const data = fixture();
    data.devices = [normalizeDevice({ id: 7, name: 'Existing device', type: 'server', resource_revision: 20 })];
    install(data);
    appState.devices[0].name = 'Local device name';
    appState.views.find(row => row.id === 3).memo = 'Local rack memo';
    appState.rackSettings[0].location = 'Local rack location';
    const remote = fixture();
    remote.views.push(normalizeView({ id: 4, name: 'Remote rack', view_type: 'rack', resource_revision: 30 }));
    remote.views[0].resource_revision = 31;
    remote.devices = [normalizeDevice({ id: 7, name: 'Remote device name', type: 'server', resource_revision: 21 }),
        normalizeDevice({ id: 8, name: 'Shelf device', type: 'pc', resource_revision: 32 })];
    remote.rackSettings.push({ view_id: 4, total_u: 10, location: 'Remote location' });
    remote.rackMounts = [{ device_id: 7, view_id: 4, face: 'front', start_u: 1, height_u: 1, width_slot: 'full', depth: 'half' }];
    remote.rackShelves = [{ id: 9, view_id: 4, name: 'Remote shelf', face: 'front', start_u: 3, height_u: 2, depth: 'half' }];
    remote.rackShelfDevices = [{ device_id: 8, shelf_id: 9, sort_order: 0 }];
    remote.canvas_notes = [{ id: 10, view_id: 4, text: 'Remote note', x: 0, y: 0, width: 200, height: 100,
        background_color: '#FFFFCC', background_opacity: 0.85, text_color: '#263238', font_size: 14 }];
    delete remote.canvasNotes; // load応答のメモはsnake_caseだけで受信する。
    remote.floorRackPlacements.push({ floor_view_id: 1, rack_view_id: 4, x: 100, y: 200 });
    reloadResourceFromData('views', 1, remote);
    assert.equal(appState.views.find(row => row.id === 4)?.name, 'Remote rack');
    assert.deepEqual(appState.rackSettings.find(row => row.view_id === 4), remote.rackSettings[1]);
    assert.deepEqual(appState.rackMounts, remote.rackMounts);
    assert.deepEqual(appState.rackShelves, remote.rackShelves);
    assert.deepEqual(appState.rackShelfDevices, remote.rackShelfDevices);
    assert.equal(appState.canvasNotes.find(row => row.id === 10)?.text, 'Remote note');
    assert.equal(appState.devices.find(row => row.id === 8)?.name, 'Shelf device');
    assert.equal(appState.devices.find(row => row.id === 7).name, 'Local device name');
    assert.equal(appState.views.find(row => row.id === 3).memo, 'Local rack memo');
    assert.equal(appState.rackSettings.find(row => row.view_id === 3).location, 'Local rack location');
    validateFloorRackPlacements(appState);
    const pending = buildResourceSave();
    assert.deepEqual(pending.devices.map(row => [row.operation, row.id]), [['update', 7]]);
    assert.deepEqual(pending.views.map(row => [row.operation, row.id]), [['update', 3]]);
});

test('移設先の再読込はローカル参照から関係ラックを識別し元フロアの配置を復元する', () => {
    install(fixture());
    appState.floorRackPlacements[0].floor_view_id = 2;
    appState.views.find(row => row.id === 3).memo = 'Keep rack edit';
    const remote = fixture();
    reloadResourceFromData('views', 2, remote);
    assert.deepEqual(appState.floorRackPlacements, remote.floorRackPlacements);
    validateFloorRackPlacements(appState);
    assert.equal(appState.views.find(row => row.id === 3).memo, 'Keep rack edit');
    assert.equal(appState.resourceConflicts.views.has(1), true);
});
