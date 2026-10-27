import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appState, normalizeView, normalizeDevice } from '../public/js/core/state.js';
import { createResourceBaseline, buildResourceSave, buildSaveableResourceSave, createPendingResourceSave,
    applyResourceSaveResult, resetResourceBaseline, reloadResourceFromData } from '../public/js/core/resource-save.js';
import { getRackDeviceMounts, getDeviceDestinations } from '../public/js/core/device-placement.js';
import { buildDashboardModel } from '../public/js/core/dashboard-model.js';

function fixture() {
    return {
        views: [1, 2].map(id => normalizeView({ id, name: `Rack ${id}`, view_type: 'rack', resource_revision: id + 10 })),
        devices: [1, 2].map(id => normalizeDevice({ id, name: `Device ${id}`, type: 'other', ip: '', resource_revision: id })),
        placements: [], links: [], canvasNotes: [], rackMounts: [],
        rackSettings: [1, 2].map(view_id => ({ view_id, total_u: 6, location: '' })),
        rackShelves: [{ id: 4, view_id: 1, name: 'Shelf', face: 'front', start_u: 2, height_u: 2, depth: 'full' }],
        rackShelfDevices: [{ device_id: 1, shelf_id: 4, sort_order: 0 }, { device_id: 2, shelf_id: 4, sort_order: 1 }]
    };
}
function install(data) {
    Object.assign(appState, data, { currentViewId: 1, floorPlans: [], deviceImages: [],
        selectedPlacementIds: new Set(), viewStates: new Map(), floorPlanAutoFittedViews: new Set(),
        resourceConflicts: { devices: new Map(), views: new Map() } });
    resetResourceBaseline(appState);
}

test('棚板の実機器は配置先を持ち、物理占有は台数ではなく棚のUだけを数える', () => {
    const data = fixture();
    const destinations = getDeviceDestinations(2, [], getRackDeviceMounts(data), data.views);
    assert.equal(destinations[0].view.id, 1);
    assert.equal(destinations[0].mount.shelf_name, 'Shelf');
    const model = buildDashboardModel(data);
    assert.equal(model.racks.mountedDevices, 2);
    assert.equal(model.racks.items[0].deviceCount, 2);
    assert.equal(model.racks.items[0].faces.front.empty, 4);
    assert.equal(model.racks.items[0].faces.rear.empty, 4);
    assert.equal(model.totals.unplacedDevices, 0);
});

test('棚から直付けへの移設は元先revision付きで送信し片側競合なら双方保留する', () => {
    const data = fixture(), baseline = createResourceBaseline(data);
    data.rackShelfDevices = data.rackShelfDevices.filter(row => row.device_id !== 1);
    data.rackMounts.push({ device_id: 1, view_id: 2, face: 'rear', start_u: 1, height_u: 1, width_slot: 'full', depth: 'half' });
    const payload = buildResourceSave(data, baseline);
    assert.deepEqual(payload.views.map(row => [row.id, row.expected_revision]), [[1, 11], [2, 12]]);
    assert.deepEqual(payload.views[0].rack_shelf_devices.map(row => row.device_id), [2]);
    data.resourceConflicts = { devices: new Map(), views: new Map([[1, {}]]) };
    assert.deepEqual(buildSaveableResourceSave(data, baseline).views, []);
});

test('空の棚板自体の移設も双方保留し既存IDを新規採番扱いにしない', () => {
    const data = fixture(); data.rackShelfDevices = [];
    const baseline = createResourceBaseline(data);
    data.rackShelves[0].view_id = 2;
    const payload = buildResourceSave(data, baseline);
    assert.deepEqual(createPendingResourceSave(payload, baseline, data).newIds.rack_shelves, []);
    data.resourceConflicts = { devices: new Map(), views: new Map([[2, {}]]) };
    assert.deepEqual(buildSaveableResourceSave(data, baseline).views, []);
});

test('棚板採番応答は子参照を更新し保存中に変更した名称を保持する', () => {
    const initial = fixture(); initial.rackShelves = []; initial.rackShelfDevices = []; install(initial);
    appState.rackShelves = [{ ...fixture().rackShelves[0], id: -1 }];
    appState.rackShelfDevices = [{ device_id: 1, shelf_id: -1, sort_order: 0 }];
    const pending = createPendingResourceSave(buildResourceSave());
    const savedShelf = { ...appState.rackShelves[0], id: 8 };
    appState.rackShelves[0].name = 'Later name';
    applyResourceSaveResult({ revision: 20, id_maps: { rack_shelves: { '-1': 8 } }, devices: [],
        views: [{ ...initial.views[0], resource_revision: 20 }], placements: [], links: [], canvas_notes: [],
        rack_settings: [initial.rackSettings[0]], rack_mounts: [], rack_shelves: [savedShelf],
        rack_shelf_devices: [{ device_id: 1, shelf_id: 8, sort_order: 0 }],
        deleted_device_ids: [], deleted_view_ids: [], affected_view_ids: [1] }, pending);
    assert.equal(appState.rackShelves[0].id, 8);
    assert.equal(appState.rackShelfDevices[0].shelf_id, 8);
    assert.equal(appState.rackShelves[0].name, 'Later name');
    assert.equal(buildResourceSave().views[0].expected_revision, 20);
});

test('移設先の再読込で元棚の所属も同期し二重所属を残さない', () => {
    install(fixture());
    const remote = fixture(); remote.rackShelfDevices = remote.rackShelfDevices.filter(row => row.device_id !== 1);
    remote.rackMounts = [{ device_id: 1, view_id: 2, face: 'front', start_u: 1, height_u: 1, width_slot: 'full', depth: 'half' }];
    remote.views.forEach(row => { row.resource_revision += 20; });
    reloadResourceFromData('views', 2, remote);
    assert.deepEqual(appState.rackShelfDevices.map(row => row.device_id), [2]);
    assert.equal(appState.rackMounts[0].device_id, 1);
    assert.deepEqual(buildResourceSave(), { devices: [], views: [] });
});

test('棚板本体の移設元を再読込しても移設先の子所属を失わない', () => {
    install(fixture());
    const remote = fixture(); remote.rackShelves[0].view_id = 2;
    remote.views.forEach(row => { row.resource_revision += 20; });
    reloadResourceFromData('views', 1, remote);
    assert.deepEqual(appState.rackShelves.map(row => [row.id, row.view_id]), [[4, 2]]);
    assert.deepEqual(appState.rackShelfDevices.map(row => [row.device_id, row.shelf_id]), [[1, 4], [2, 4]]);
    assert.deepEqual(buildResourceSave(), { devices: [], views: [] });
});
