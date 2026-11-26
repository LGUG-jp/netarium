import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { installWorkspaceDom } from './helpers/workspace-dom.mjs';

test('建物表示のフロア変換保存は既存リソースと入力を保持する', async t => {
    const keys = ['window', 'document', 'Element', 'HTMLElement', 'fetch', 'localStorage'];
    const globals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    installWorkspaceDom();
    globalThis.localStorage = { getItem: () => null, setItem() {} };
    const { appState, normalizeView, normalizeDevice, normalizePlacement } = await import('../public/js/core/state.js');
    const originalState = { ...appState };
    const { resetResourceBaseline, buildResourceSave } = await import('../public/js/core/resource-save.js');
    const { clearPendingSave, runResourceMutation } = await import('../public/js/core/save-queue.js');
    const { getDeviceDraft, discardDeviceDrafts } = await import('../public/js/core/device-drafts.js');
    const { loadBuildingFloorTransform, saveBuildingFloorTransform } = await import('../public/js/core/building-view-save.js');
    const transform = { scale: 1.5, offset_x: 12, offset_y: -8, rotation: 30 };
    const baseline = { building_id: 1, representative_view_id: 2, scale: 1, offset_x: 0, offset_y: 0, rotation: 0 };
    let requests, failure, hold, remoteFloors, remoteBuildings, remoteRevision;
    const install = () => {
        discardDeviceDrafts('building-save-test');
        Object.assign(appState, {
            buildings: [{ id: 1, name: '本館', sort_order: 0, building_view_enabled: 1 }],
            floors: [{ id: 10, name: '1F', sort_order: 0, ...baseline },
                { id: 11, name: '2F', sort_order: 1, ...baseline, representative_view_id: null }],
            views: [normalizeView({ id: 2, resource_revision: 4, name: '配置図', view_type: 'floor', floor_id: 10 })],
            devices: [normalizeDevice({ id: 3, resource_revision: 5, name: '機器', type: 'switch' })],
            placements: [normalizePlacement({ id: 4, device_id: 3, view_id: 2, x: 100, y: 200 })],
            links: [], canvasNotes: [], rackSettings: [], rackMounts: [], rackShelves: [], rackShelfDevices: [], floorRackPlacements: [],
            floorPlans: [{ view_id: 2, x: 20, y: 30, scale: 0.5, rotation: 15, revision: 3, opacity: 1, is_visible: 1 }],
            deviceImages: [], currentViewId: 2, dataRevision: 7, authExpired: false, isPinging: false,
            isFloorPlanUpdating: false, floorPlanAdjustMode: false, viewManagerFormDirty: false,
            editingDeviceId: null, editingLinkId: null, appStatus: { dirty: false, state: 'saved' },
            resourceConflicts: { devices: new Map(), views: new Map() }
        });
        window.APP_CONFIG.user.isAdmin = true;
        clearPendingSave();
        resetResourceBaseline(appState);
        requests = []; failure = null; hold = null;
        remoteFloors = structuredClone(appState.floors);
        remoteBuildings = [{ id: 1, name: '別世代の建物', building_view_enabled: 1 }];
        remoteRevision = appState.dataRevision;
    };
    globalThis.fetch = async (url, options) => {
        assert.match(String(url), /action=building_hierarchy/);
        if (options.method === 'GET') {
            requests.push('GET');
            return new Response(JSON.stringify({ ok: true, revision: remoteRevision, floors: remoteFloors,
                buildings: remoteBuildings, views: [] }));
        }
        const payload = JSON.parse(options.body);
        requests.push(payload);
        if (hold) await hold;
        if (failure instanceof Error) throw failure;
        const floor = remoteFloors.find(row => row.id === payload.id);
        if (failure || Object.keys(baseline).some(key => payload.expected_floor[key] !== floor[key])) {
            return new Response(JSON.stringify({ ok: false, error: '競合', details: { revision: remoteRevision } }),
                { status: failure || 409 });
        }
        Object.assign(floor, { scale: payload.scale, offset_x: payload.offset_x, offset_y: payload.offset_y, rotation: payload.rotation });
        return new Response(JSON.stringify({ ok: true, revision: ++remoteRevision, floor }));
    };
    t.after(() => {
        discardDeviceDrafts('building-save-test');
        clearPendingSave(); Object.assign(appState, originalState); resetResourceBaseline(appState);
        for (const [key, descriptor] of globals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
        }
    });

    await t.test('変換4項目だけを送り、元座標・resource baseline・dirty表示を変更せず連続保存できる', async () => {
        install();
        appState.appStatus = { dirty: true, state: 'pending', lastError: '他画面の状態' };
        const status = structuredClone(appState.appStatus);
        const originalResources = Object.fromEntries(['views', 'devices', 'placements', 'floorPlans'].map(key => [key, appState[key]]));
        const originalValues = structuredClone(originalResources);
        const buildings = appState.buildings;
        const otherFloor = appState.floors[1];
        remoteFloors[0].name = '保存応答の名称';
        remoteFloors[1].name = '取り込まない';
        const saved = await saveBuildingFloorTransform(10, { ...transform, name: '送らない', x: 999 }, appState.floors[0]);
        assert.deepEqual(requests[0], { operation: 'update_floor_transform', id: 10, ...transform, expected_floor: baseline });
        assert.deepEqual(saved, { id: 10, building_id: 1, name: '保存応答の名称', sort_order: 0, representative_view_id: 2, ...transform });
        assert.equal(appState.floors[0], saved);
        assert.equal(appState.floors[1], otherFloor);
        assert.equal(appState.buildings, buildings);
        for (const key of Object.keys(originalResources)) {
            assert.equal(appState[key], originalResources[key]);
            assert.deepEqual(appState[key], originalValues[key]);
        }
        assert.deepEqual(appState.appStatus, status);
        assert.deepEqual(buildResourceSave(), { devices: [], views: [] });
        await saveBuildingFloorTransform(10, { ...transform, offset_x: 24 }, saved);
        assert.deepEqual(requests[1].expected_floor, { ...baseline, ...transform });
        assert.equal(appState.dataRevision, 9);
        appState.placements[0].x = 120;
        assert.equal(buildResourceSave().views[0].expected_revision, 4);
    });

    await t.test('共通キューの先行操作を待ち、実行時の共有世代と呼出時の変換・比較値を使う', async () => {
        install();
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        const first = runResourceMutation(async () => { await gate; appState.dataRevision = ++remoteRevision; });
        await setImmediate();
        const input = { ...transform };
        const expected = { ...appState.floors[0] };
        const second = saveBuildingFloorTransform(10, input, expected);
        input.offset_x = 999;
        expected.offset_y = 999;
        await setImmediate();
        assert.equal(requests.length, 0);
        release(); await first; await second;
        assert.deepEqual(requests[0].expected_floor, baseline);
        assert.equal(requests[0].offset_x, 12);
        assert.equal(appState.dataRevision, 9);
    });

    await t.test('保存キュー待機中に建物ビューが無効になれば送信しない', async () => {
        install();
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        const first = runResourceMutation(() => gate);
        await setImmediate();
        const second = saveBuildingFloorTransform(10, transform, appState.floors[0]);
        appState.buildings = [{ ...appState.buildings[0], building_view_enabled: 0 }];
        release(); await first;
        await assert.rejects(second, { requestNotSent: true });
        assert.deepEqual(requests, []);
        assert.equal(appState.floors[0].offset_x, baseline.offset_x);
    });

    await t.test('409と通信失敗をそのままthrowし、保存値と入力を維持する', async () => {
        for (const error of [409, new Error('通信失敗')]) {
            install(); failure = error; remoteRevision = 99;
            const floors = appState.floors;
            await assert.rejects(saveBuildingFloorTransform(10, transform, floors[0]), thrown => {
                if (error instanceof Error) assert.equal(thrown, error);
                else { assert.equal(thrown.status, 409); assert.equal(thrown.details.revision, 99); }
                assert.notEqual(thrown.requestNotSent, true);
                return true;
            });
            assert.equal(appState.floors, floors);
            assert.equal(appState.dataRevision, 7);
            assert.equal(transform.offset_x, 12);
        }
    });

    await t.test('409後の確認GETは共有状態を変えず、明示保存とその次の編集が全体世代を飛び越えない', async () => {
        install();
        const buildings = appState.buildings;
        const floors = appState.floors;
        remoteFloors[0].offset_x = 45;
        remoteFloors[1].name = '最新の別フロア';
        remoteRevision = 11;
        await assert.rejects(saveBuildingFloorTransform(10, transform, floors[0]), { status: 409 });
        const recovery = await loadBuildingFloorTransform(10);
        assert.deepEqual(recovery, { floor: remoteFloors[0], buildingEnabled: true, revision: 11 });
        assert.deepEqual(await loadBuildingFloorTransform(99), { floor: null, buildingEnabled: false, revision: 11 });
        remoteBuildings[0].building_view_enabled = 0;
        assert.deepEqual(await loadBuildingFloorTransform(10), { floor: remoteFloors[0], buildingEnabled: false, revision: 11 });
        remoteBuildings[0].building_view_enabled = 1;
        assert.deepEqual(requests.map(request => request.operation ?? request), ['update_floor_transform', 'GET', 'GET', 'GET']);
        assert.equal(appState.buildings, buildings);
        assert.equal(appState.floors, floors);
        assert.equal(appState.dataRevision, 7);

        const saved = await saveBuildingFloorTransform(10, transform, recovery.floor);
        assert.equal(requests[4].expected_floor.offset_x, 45);
        const savedAgain = await saveBuildingFloorTransform(10, { ...transform, rotation: 15 }, saved);
        assert.equal(appState.floors[0], savedAgain);
        assert.equal(appState.floors[1], floors[1]);
        assert.equal(appState.buildings, buildings);
        assert.equal(appState.dataRevision, 7);
        assert.equal(remoteRevision, 13);
    });

    const blocks = {
        '管理者以外': () => { window.APP_CONFIG.user.isAdmin = false; },
        '認証失効': () => { appState.authExpired = true; },
        'Ping中': () => { appState.isPinging = true; },
        'ビュー管理の入力': () => { appState.viewManagerFormDirty = true; },
        '図面の編集中': () => { appState.floorPlanAdjustMode = true; },
        '図面の更新中': () => { appState.isFloorPlanUpdating = true; },
        '機器下書き': () => { getDeviceDraft('building-save-test', 3).name = '未適用'; },
        '機器競合': () => { appState.resourceConflicts.devices.set(3, {}); },
        'ビュー競合': () => { appState.resourceConflicts.views.set(2, {}); },
        '未保存配置': () => { appState.placements[0].x = 123; }
    };
    for (const [name, block] of Object.entries(blocks)) {
        await t.test(`${name}があれば送信しない`, async () => {
            install(); block();
            await assert.rejects(saveBuildingFloorTransform(10, transform, appState.floors[0]), { requestNotSent: true });
            assert.equal(requests.length, 0);
            assert.equal(appState.dataRevision, 7);
        });
    }

    await t.test('通信中の別入力・再読込を上書きせずthrowし、パネル入力を保存済み扱いにしない', async () => {
        for (const change of [
            () => { appState.placements[0].x = 321; },
            () => { getDeviceDraft('building-save-test', 3).name = '通信中の入力'; },
            () => { appState.viewManagerFormDirty = true; },
            () => { appState.dataRevision = 99; },
            () => { appState.floors[0].name = '通信中の変更'; }
        ]) {
            install();
            let release;
            hold = new Promise(resolve => { release = resolve; });
            const pending = saveBuildingFloorTransform(10, transform, appState.floors[0]);
            await setImmediate();
            assert.equal(requests.length, 1);
            change();
            const state = structuredClone({ floors: appState.floors, placements: appState.placements, revision: appState.dataRevision });
            release();
            await assert.rejects(pending);
            assert.deepEqual({ floors: appState.floors, placements: appState.placements, revision: appState.dataRevision }, state);
            assert.equal(transform.offset_x, 12);
        }
    });

    await t.test('不正な変換と存在しない対象を送信しない', async () => {
        install();
        for (const invalid of [{ scale: 0 }, { scale: Infinity }, { offset_x: NaN }, { offset_y: '2' }, { rotation: 181 }]) {
            await assert.rejects(saveBuildingFloorTransform(10, { ...transform, ...invalid }, appState.floors[0]), { requestNotSent: true });
        }
        await assert.rejects(saveBuildingFloorTransform(99, transform, appState.floors[0]), { requestNotSent: true });
        await assert.rejects(saveBuildingFloorTransform(10, transform, {}), { requestNotSent: true });
        assert.equal(requests.length, 0);
    });
});
