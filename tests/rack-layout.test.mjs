import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appState, normalizeView, normalizeDevice } from '../public/js/core/state.js';
import { validateRackLayout, rackDisplaySlot, rackUsage } from '../public/js/core/rack-layout.js';
import {
    createResourceBaseline, buildResourceSave, buildSaveableResourceSave, createPendingResourceSave,
    applyResourceSaveResult, resetResourceBaseline, inspectPendingResourceSave, reloadResourceFromData, resourceSaveValidationData
} from '../public/js/core/resource-save.js';

function fixture() {
    return {
        views: [1, 2].map(id => normalizeView({ id, name: `ラック${id}`, view_type: 'rack', resource_revision: id + 10 })),
        devices: [1, 2, 3].map(id => normalizeDevice({ id, name: `機器${id}`, type: 'switch', resource_revision: id })),
        placements: [], links: [], canvasNotes: [],
        rackSettings: [1, 2].map(view_id => ({ view_id, total_u: 6, location: '' })),
        rackMounts: [{ device_id: 1, view_id: 1, face: 'front', start_u: 1, height_u: 2, width_slot: 'left' }]
    };
}
function mount(device_id, extra = {}) {
    return { device_id, view_id: 1, face: 'front', start_u: 1, height_u: 2, width_slot: 'left', ...extra };
}

test('前後別面・左右半幅・複数Uの占有と両面全幅の境界を検証する', () => {
    const data = fixture();
    data.rackMounts.push(mount(2, { width_slot: 'right' }), mount(3, { face: 'rear' }));
    validateRackLayout(data);
    assert.deepEqual(rackUsage(6, data.rackMounts, 'front'), { empty: 4, half: 0, used: 2 });
    assert.deepEqual(rackUsage(6, data.rackMounts, 'rear'), { empty: 4, half: 2, used: 0 });
    for (const width_slot of ['left', 'right', 'full']) {
        const invalid = fixture();
        invalid.rackMounts.push(mount(2, { width_slot: 'full', start_u: 2 }));
        invalid.rackMounts[0].width_slot = width_slot;
        assert.throws(() => validateRackLayout(invalid), /重複/);
    }
    const both = fixture();
    both.rackMounts = [mount(1, { face: 'both', width_slot: 'full', start_u: 5 }), mount(2, { face: 'rear', start_u: 6, height_u: 1 })];
    assert.throws(() => validateRackLayout(both), /重複/);
    both.rackMounts.pop();
    validateRackLayout(both);
    assert.deepEqual(rackUsage(6, both.rackMounts, 'rear'), { empty: 4, half: 0, used: 2 });
});

test('範囲・整数・一意機器・存在参照・both半幅・ラックへのXY混入を拒否する', () => {
    for (const invalid of [
        { start_u: 0 }, { start_u: 6, height_u: 2 }, { height_u: 0.5 }, { start_u: 1.5 },
        { view_id: 9 }, { device_id: 99 }, { face: 'both' }, { width_slot: 'quarter' }
    ]) {
        const data = fixture(); data.rackMounts = [mount(1, invalid)];
        assert.throws(() => validateRackLayout(data));
    }
    const duplicate = fixture(); duplicate.rackMounts.push(mount(1, { view_id: 2 }));
    assert.throws(() => validateRackLayout(duplicate), /同じ機器/);
    const xy = fixture(); xy.placements.push({ id: 1, device_id: 2, view_id: 1, x: 0, y: 0 });
    assert.throws(() => validateRackLayout(xy), /XY/);
    for (const total_u of [0, 61, 3.5]) {
        const data = fixture(); data.rackSettings[0].total_u = total_u;
        assert.throws(() => validateRackLayout(data), /総U/);
    }
    const shrinking = fixture(); shrinking.rackSettings[0].total_u = 1;
    assert.throws(() => validateRackLayout(shrinking), /ラック内/);
});

test('背面の左右変換は対称で全幅を変更しない', () => {
    assert.equal(rackDisplaySlot('left', 'rear'), 'right');
    assert.equal(rackDisplaySlot('right', 'rear'), 'left');
    assert.equal(rackDisplaySlot('full', 'rear'), 'full');
    assert.equal(rackDisplaySlot(rackDisplaySlot('left', 'rear'), 'rear'), 'left');
    assert.equal(rackDisplaySlot('left', 'front'), 'left');
});

test('機器属性の更新はラックを保存せず、移設は両側revisionを要求する', () => {
    const data = fixture(); const baseline = createResourceBaseline(data);
    data.devices[0].name = '名称更新';
    assert.deepEqual(buildResourceSave(data, baseline).views, []);
    data.rackMounts[0].view_id = 2;
    const payload = buildResourceSave(data, baseline);
    assert.deepEqual(payload.views.map(row => [row.id, row.expected_revision]), [[1, 11], [2, 12]]);
    assert.deepEqual(payload.views[0].rack_mounts, []);
    assert.equal(payload.views[1].rack_mounts[0].device_id, 1);
    data.resourceConflicts = { devices: new Map(), views: new Map([[1, {}]]) };
    assert.deepEqual(buildSaveableResourceSave(data, baseline).views, []);
});

test('保存応答待ちの後続U編集を保持し、確認・再読込もラック契約に従う', () => {
    Object.assign(appState, fixture(), {
        floorPlans: [], deviceImages: [], currentViewId: 1, selectedPlacementIds: new Set(),
        viewStates: new Map(), floorPlanAutoFittedViews: new Set(),
        resourceConflicts: { devices: new Map(), views: new Map() }
    });
    resetResourceBaseline(appState);
    appState.rackMounts[0].start_u = 3;
    const pending = createPendingResourceSave(buildResourceSave());
    const remote = fixture(); remote.views[0].resource_revision = 13;
    remote.rackMounts[0].start_u = 3;
    assert.equal(inspectPendingResourceSave(pending, remote), 'saved');
    appState.rackMounts[0].start_u = 4;
    applyResourceSaveResult({
        revision: 5, id_maps: {}, devices: [], views: [remote.views[0]], placements: [], links: [], canvas_notes: [],
        rack_settings: [remote.rackSettings[0]], rack_mounts: remote.rackMounts,
        deleted_device_ids: [], deleted_view_ids: [], affected_view_ids: [1]
    }, pending);
    assert.equal(appState.rackMounts[0].start_u, 4);
    assert.equal(buildResourceSave().views[0].expected_revision, 13);
    reloadResourceFromData('views', 1, remote);
    assert.equal(appState.rackMounts[0].start_u, 3);
    assert.deepEqual(buildResourceSave(), { devices: [], views: [] });
});

test('移設先だけの競合再読込でも元ラックを同期し二重搭載を残さない', () => {
    Object.assign(appState, fixture(), { resourceConflicts: { devices: new Map(), views: new Map() } });
    resetResourceBaseline(appState);
    const remote = fixture();
    remote.rackMounts[0].view_id = 2;
    remote.views[0].resource_revision = 21;
    remote.views[1].resource_revision = 22;
    reloadResourceFromData('views', 2, remote);
    assert.deepEqual(appState.rackMounts.map(row => [row.device_id, row.view_id]), [[1, 2]]);
    assert.equal(appState.views.find(row => row.id === 1).resource_revision, 21);
    assert.deepEqual(buildResourceSave(), { devices: [], views: [] });
    appState.devices[1].name = '独立した機器更新';
    validateRackLayout(resourceSaveValidationData(buildResourceSave()));
});

test('移設の再読込は相手ラックの未送信編集を保持し、別のリモート変更を競合表示する', () => {
    Object.assign(appState, fixture(), { resourceConflicts: { devices: new Map(), views: new Map() } });
    resetResourceBaseline(appState);
    appState.rackSettings[0].location = '未送信の場所';
    const remote = fixture();
    remote.rackMounts[0].view_id = 2;
    remote.views[0].name = '他利用者によるラック名変更';
    remote.views[0].resource_revision = 21;
    remote.views[1].resource_revision = 22;
    reloadResourceFromData('views', 2, remote);
    assert.equal(appState.rackSettings.find(row => row.view_id === 1).location, '未送信の場所');
    assert.deepEqual(appState.rackMounts.map(row => [row.device_id, row.view_id]), [[1, 2]]);
    assert.ok(appState.resourceConflicts.views.has(1));
    const payload = buildSaveableResourceSave();
    assert.deepEqual(payload.views, []);
    validateRackLayout(resourceSaveValidationData(payload));
});
