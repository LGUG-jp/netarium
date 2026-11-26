import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { installWorkspaceDom } from './helpers/workspace-dom.mjs';

test('機器ドラッグとCanvasパンは開始したポインターのイベントだけを扱う', async t => {
    const keys = ['window', 'document', 'Element', 'HTMLElement', 'fetch', 'requestAnimationFrame', 'cancelAnimationFrame'];
    const originals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const dom = installWorkspaceDom();
    // Canvasの実テンプレートは静的HTMLなので、PHPを起動せず同じDOMへ読み込む。
    document.body.innerHTML = readFileSync(new URL('../templates/components/canvas.php', import.meta.url), 'utf8');
    globalThis.requestAnimationFrame = callback => setTimeout(callback, 0);
    globalThis.cancelAnimationFrame = clearTimeout;
    const { appState, normalizeView, normalizeDevice } = await import('../public/js/core/state.js');
    const drag = await import('../public/js/canvas/drag-drop.js');
    const queue = await import('../public/js/core/save-queue.js');
    const resource = await import('../public/js/core/resource-save.js');
    const { eventBus } = await import('../public/js/core/event-bus.js');
    const { render } = await import('../public/js/canvas/renderer.js');
    const { onKeyDown } = await import('../public/js/canvas/selection.js');
    const { getPlacementHistoryAvailability } = await import('../public/js/core/placement-history.js');
    const historyKey = (key, shiftKey = false) => onKeyDown({
        key, ctrlKey: true, shiftKey, target: dom.get('canvas'), preventDefault() {}, stopImmediatePropagation() {}
    });
    let requests = [], device;
    const points = new Map();
    globalThis.fetch = async (_url, options) => {
        const payload = JSON.parse(options.body);
        requests.push(payload);
        return new Response(JSON.stringify({
            ok: true, revision: 2, id_maps: {}, devices: [],
            views: payload.views.map(operation => ({ ...operation.view, resource_revision: 2 })),
            // PDO で REAL 列へ保存した値を応答に使う場合の有効桁数。
            placements: payload.views.flatMap(operation => operation.placements).map(row =>
                ({ ...row, x: Number(row.x.toPrecision(14)), y: Number(row.y.toPrecision(14)) })),
            view_link_routes: [], canvas_notes: [], affected_view_ids: payload.views.map(operation => operation.id),
            deleted_device_ids: [], deleted_view_ids: []
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const pointer = (pointerId, x = 100, y = 100, target = dom.get('canvas')) => ({
        pointerId, clientX: x, clientY: y, target, button: 0, preventDefault() {}, stopPropagation() {}
    });
    const move = (id, x, y) => {
        points.set(id, [x, y]);
        return dom.events.dispatch('pointermove', pointer(id, x, y));
    };
    const finish = (id, type = 'pointerup', at = null) => {
        const [x, y] = at ?? points.get(id) ?? [100, 100];
        return dom.events.dispatch(type, pointer(id, x, y));
    };
    const position = () => ({ x: appState.placements[0].x, y: appState.placements[0].y });
    async function cleanup() {
        await finish(7, 'pointercancel');
        await finish(8, 'pointercancel');
        await queue.flushSaveQueue({ silent: true });
        queue.clearPendingSave();
    }
    t.after(async () => {
        await cleanup();
        await setImmediate();
        for (const [key, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    });
    function reset() {
        queue.clearPendingSave();
        eventBus.emit('resources:reloaded');
        requests = [];
        points.clear();
        Object.assign(appState, {
            views: [normalizeView({ id: 1, name: '試験構成図', view_type: 'topology', resource_revision: 1 })],
            devices: [normalizeDevice({ id: 1, name: '試験機器', type: 'pc', ip: '', resource_revision: 1 })],
            placements: [{ id: 1, device_id: 1, view_id: 1, x: 100, y: 100 }], links: [],
            canvasNotes: [], floorPlans: [], deviceImages: [], floorRackPlacements: [],
            rackSettings: [], rackMounts: [], rackShelves: [], rackShelfDevices: [], currentViewId: 1,
            canvas: dom.get('canvas'), world: dom.get('world'), deviceLayer: dom.get('device-layer'),
            currentSvg: dom.get('link-layer'), floorPlanLayer: dom.get('floor-plan-layer'),
            canvasNoteLayer: dom.get('canvas-note-layer'),
            viewState: { scale: 1, panX: 0, panY: 0 }, selectedPlacementIds: new Set([1]), editingDeviceId: 1,
            resourceConflicts: { devices: new Map(), views: new Map() }, appStatus: { dirty: false, state: 'saved' },
            isSaving: false, isPinging: false, authExpired: false, linkMode: false, noteMode: false,
            floorPlanAdjustMode: false, isRangeSelecting: false, suppressNextClick: false
        });
        resource.resetResourceBaseline(appState);
        device = document.createElement('div');
        device.className = 'device';
        device.dataset.placementId = '1';
        appState.deviceLayer.replaceChildren(device);
        drag.makePlacementDraggable(device, appState.placements[0]);
    }
    async function scenario(name, run) {
        await t.test(name, async () => {
            reset();
            try { await run(); } finally { await cleanup(); }
        });
    }

    await scenario('別の指で空白をパンして離しても機器を変更せず、元の指で移動・保存できる', async () => {
        await device.dispatch('pointerdown', pointer(7, 100, 100, device));
        drag.onCanvasPointerDown(pointer(8));
        await move(8, 130, 150);
        assert.deepEqual(position(), { x: 100, y: 100 });
        assert.deepEqual({ x: appState.viewState.panX, y: appState.viewState.panY }, { x: 30, y: 50 });
        await finish(8);
        assert.equal(appState.canvas.classList.contains('panning'), false);
        assert.equal(requests.length, 0);
        await move(7, 140, 120);
        assert.deepEqual(position(), { x: 140, y: 120 });
        await finish(7);
        assert.equal(await queue.flushSaveQueue({ silent: true }), true);
        assert.equal(requests.length, 1);
        assert.deepEqual(requests[0].views[0].placements, [{ id: 1, device_id: 1, view_id: 1, x: 140, y: 120 }]);
    });

    await scenario('機器移動中に別の指で別機器へ触れても元のドラッグを継続し、1回だけ保存する', async () => {
        appState.devices.push(normalizeDevice({ id: 2, name: '試験機器2', type: 'pc', ip: '', resource_revision: 1 }));
        appState.placements.push({ id: 2, device_id: 2, view_id: 1, x: 300, y: 300 });
        resource.resetResourceBaseline(appState);

        const deviceB = document.createElement('div');
        deviceB.className = 'device';
        deviceB.dataset.placementId = '2';
        appState.deviceLayer.append(deviceB);
        drag.makePlacementDraggable(deviceB, appState.placements[1]);

        await device.dispatch('pointerdown', pointer(7, 100, 100, device));
        await move(7, 120, 125);
        assert.deepEqual(position(), { x: 120, y: 125 });
        assert.equal(appState.canvas.hasPointerCapture(7), true);

        await deviceB.dispatch('pointerdown', pointer(8, 300, 300, deviceB));
        assert.equal(requests.length, 0);
        assert.equal(appState.canvas.hasPointerCapture(7), true);
        assert.equal(device.classList.contains('dragging'), true);
        assert.equal(deviceB.classList.contains('dragging'), false);

        await move(7, 160, 140);
        assert.deepEqual(position(), { x: 160, y: 140 });
        assert.deepEqual(
            { x: appState.placements[1].x, y: appState.placements[1].y },
            { x: 300, y: 300 }
        );

        await finish(7);
        await queue.flushSaveQueue({ silent: true });
        assert.equal(requests.length, 1);
        assert.equal(appState.canvas.hasPointerCapture(7), false);
        assert.equal(device.classList.contains('dragging'), false);

        const savedPlacements = requests[0].views[0].placements;
        assert.deepEqual(
            savedPlacements.find(item => Number(item.id) === 1),
            { id: 1, device_id: 1, view_id: 1, x: 160, y: 140 }
        );
        assert.deepEqual(
            savedPlacements.find(item => Number(item.id) === 2),
            { id: 2, device_id: 2, view_id: 1, x: 300, y: 300 }
        );
    });

    await scenario('最後のmoveと異なるpointerupの位置が機器と保存payloadへ反映される', async () => {
        await device.dispatch('pointerdown', pointer(7, 100, 100, device));
        await move(7, 110, 120);
        assert.deepEqual(position(), { x: 110, y: 120 });
        await finish(7, 'pointerup', [140, 150]);
        assert.deepEqual(position(), { x: 140, y: 150 });
        await queue.flushSaveQueue({ silent: true });
        assert.equal(requests.length, 1);
        assert.deepEqual(requests[0].views[0].placements[0], {
            id: 1, device_id: 1, view_id: 1, x: 140, y: 150
        });
    });

    await scenario('pointermoveなしでupだけが移動閾値を超える場合も確定する', async () => {
        await device.dispatch('pointerdown', pointer(7, 100, 100, device));
        await finish(7, 'pointerup', [160, 170]);
        assert.deepEqual(position(), { x: 160, y: 170 });
        await queue.flushSaveQueue({ silent: true });
        assert.equal(requests.length, 1);
    });

    await scenario('複数選択のズーム換算と小数座標の保存後も、一括で元に戻してやり直せる', async () => {
        appState.devices.push(normalizeDevice({ id: 2, name: '試験機器2', type: 'pc', ip: '', resource_revision: 1 }));
        appState.placements.push({ id: 2, device_id: 2, view_id: 1, x: 300, y: 300 });
        appState.selectedPlacementIds.add(2);
        appState.viewState.scale = 3;
        resource.resetResourceBaseline(appState);
        await device.dispatch('pointerdown', pointer(7, 100, 100, device));
        await finish(7, 'pointerup', [132, 150]);
        const moved = [[100 + 32 / 3, 100 + 50 / 3], [300 + 32 / 3, 300 + 50 / 3]];
        await queue.flushSaveQueue({ silent: true });
        assert.equal(requests.length, 1);
        assert.deepEqual(requests[0].views[0].placements.map(p => [p.x, p.y]), moved);
        assert.deepEqual(position(), { x: Number(moved[0][0].toPrecision(14)), y: Number(moved[0][1].toPrecision(14)) });
        await historyKey('z');
        await queue.flushSaveQueue({ silent: true });
        assert.deepEqual(requests[1].views[0].placements.map(p => [p.x, p.y]), [[100, 100], [300, 300]]);
        assert.equal(getPlacementHistoryAvailability(1).undo, false, 'グループ移動全体で履歴1件');
        await historyKey('z', true);
        await queue.flushSaveQueue({ silent: true });
        assert.deepEqual(requests[2].views[0].placements.map(p => [p.x, p.y]), moved);
    });

    await scenario('開始位置への復帰と1px未満の移動は保存せず、やり直し履歴を保つ', async () => {
        appState.viewState.scale = 3;
        await device.dispatch('pointerdown', pointer(7, 100, 100, device));
        await move(7, 115, 118);
        await finish(7, 'pointerup', [100, 100]);
        assert.deepEqual(position(), { x: 100, y: 100 });
        assert.equal(requests.length, 0);
        assert.equal(getPlacementHistoryAvailability(1).undo, false);

        await device.dispatch('pointerdown', pointer(7, 100, 100, device));
        await finish(7, 'pointerup', [130, 100]);
        await queue.flushSaveQueue({ silent: true });
        await historyKey('z');
        await queue.flushSaveQueue({ silent: true });
        const countBefore = requests.length;
        device = appState.deviceLayer.querySelector('[data-placement-id="1"]');
        await device.dispatch('pointerdown', pointer(7, 100, 100, device));
        await move(7, 115, 118);
        await finish(7, 'pointerup', [101, 100]);
        await queue.flushSaveQueue({ silent: true });
        assert.deepEqual(position(), { x: 100, y: 100 });
        assert.equal(device.style.transform, 'translate(100px, 100px)');
        assert.equal(requests.length, countBefore);
        assert.equal(getPlacementHistoryAvailability(1).undo, false);
        await historyKey('z', true);
        await queue.flushSaveQueue({ silent: true });
        assert.deepEqual(position(), { x: 110, y: 100 });
    });

    await scenario('upの位置でも左上境界へクランプする', async () => {
        await device.dispatch('pointerdown', pointer(7, 100, 100, device));
        await finish(7, 'pointerup', [-50, -70]);
        assert.deepEqual(position(), { x: 0, y: 0 });
        await queue.flushSaveQueue({ silent: true });
        assert.equal(requests[0].views[0].placements[0].x, 0);
        assert.equal(requests[0].views[0].placements[0].y, 0);
    });

    await scenario('同時にmoveとupが到着しても最終upが優先される', async () => {
        await device.dispatch('pointerdown', pointer(7, 100, 100, device));
        const moving = move(7, 110, 115);
        const ending = finish(7, 'pointerup', [140, 150]);
        await Promise.all([moving, ending]);
        assert.deepEqual(position(), { x: 140, y: 150 });
        await queue.flushSaveQueue({ silent: true });
        assert.equal(requests.length, 1);
        assert.equal(requests[0].views[0].placements[0].x, 140);
        assert.equal(requests[0].views[0].placements[0].y, 150);
    });

    await scenario('重複pointerupは最初の離脱位置を一度だけ確定する', async () => {
        await device.dispatch('pointerdown', pointer(7, 100, 100, device));
        const first = finish(7, 'pointerup', [140, 150]);
        const duplicate = finish(7, 'pointerup', [190, 200]);
        await Promise.all([first, duplicate]);
        assert.deepEqual(position(), { x: 140, y: 150 });
        await queue.flushSaveQueue({ silent: true });
        assert.equal(requests.length, 1);
    });

    await scenario('pointercancelは最後の座標を確定せず、移動を戻して保存しない', async () => {
        await device.dispatch('pointerdown', pointer(7, 100, 100, device));
        await move(7, 125, 135);
        await finish(7, 'pointercancel', [180, 190]);
        assert.deepEqual(position(), { x: 100, y: 100 });
        assert.equal(device.classList.contains('dragging'), false);
        await queue.flushSaveQueue({ silent: true });
        assert.equal(requests.length, 0);
    });

    await scenario('ビュー切替の再描画で内部終了するとグループ全体を戻し、未保存差分も残さない', async () => {
        appState.views.push(normalizeView({ id: 2, name: '別ビュー', view_type: 'topology', resource_revision: 1 }));
        appState.devices.push(normalizeDevice({ id: 2, name: '試験機器2', type: 'pc', ip: '', resource_revision: 1 }));
        appState.placements.push({ id: 2, device_id: 2, view_id: 1, x: 300, y: 300 });
        appState.selectedPlacementIds.add(2);
        resource.resetResourceBaseline(appState);

        const pointerTypes = ['pointermove', 'pointerup', 'pointercancel'];
        const previousListeners = new Map(pointerTypes.map(type => [type,
            new Set(dom.events.listeners.get(type))]));
        await device.dispatch('pointerdown', pointer(7, 100, 100, device));
        const dragListeners = new Map(pointerTypes.map(type => [type,
            [...dom.events.listeners.get(type)].filter(fn => !previousListeners.get(type).has(fn))]));
        await move(7, 125, 135);
        assert.deepEqual(appState.placements.map(row => [row.x, row.y]), [[125, 135], [325, 335]]);
        appState.currentViewId = 2;
        render();

        assert.deepEqual(appState.placements.map(row => [row.x, row.y]), [[100, 100], [300, 300]]);
        assert.equal(appState.canvas.hasPointerCapture(7), false);
        for (const [type, listeners] of dragListeners) {
            assert.ok(listeners.every(fn => !dom.events.listeners.get(type).has(fn)));
        }
        await move(7, 190, 200);
        await finish(7);
        assert.deepEqual(resource.buildResourceSave(), { devices: [], views: [] });
        assert.equal(queue.hasPendingChanges(), false);
        assert.equal(appState.appStatus.dirty, false);
        await queue.flushSaveQueue({ silent: true });
        assert.equal(requests.length, 0);
    });

    await scenario('再読込通知でも同じ配置モデルが残る場合は移動を取り消す', async () => {
        await device.dispatch('pointerdown', pointer(7, 100, 100, device));
        await move(7, 125, 135);
        eventBus.emit('resources:reloaded');

        assert.deepEqual(position(), { x: 100, y: 100 });
        assert.equal(device.style.transform, 'translate(100px, 100px)');
        assert.equal(device.classList.contains('dragging'), false);
        assert.equal(appState.canvas.hasPointerCapture(7), false);
        assert.equal(queue.hasPendingChanges(), false);
        await queue.flushSaveQueue({ silent: true });
        assert.equal(requests.length, 0);
    });

    await scenario('配置IDが再採番されても同じ配置モデルの移動は取り消せる', async () => {
        const savedPlacement = { ...appState.placements[0], id: 101 };
        await device.dispatch('pointerdown', pointer(7, 100, 100, device));
        await move(7, 125, 135);
        const maps = { placements: { 1: 101 } };
        resource.remapResourceState(appState, maps);
        eventBus.emit('resources:ids-remapped', maps);
        device.dataset.placementId = '101';
        resource.resetResourceBaseline({ ...appState, placements: [savedPlacement] });
        eventBus.emit('resources:reloaded');

        assert.equal(appState.placements[0].id, 101);
        assert.deepEqual(position(), { x: 100, y: 100 });
        assert.equal(device.style.transform, 'translate(100px, 100px)');
        assert.equal(queue.hasPendingChanges(), false);
        await queue.flushSaveQueue({ silent: true });
        assert.equal(requests.length, 0);
    });

    for (const type of ['resources:reloaded', 'pointercancel']) {
        await scenario(`${type}で同じIDの再読込済み配置を開始座標へ巻き戻さない`, async () => {
            await device.dispatch('pointerdown', pointer(7, 100, 100, device));
            await move(7, 125, 135);
            appState.placements = [{ ...appState.placements[0], x: 400, y: 450 }];
            resource.resetResourceBaseline(appState);
            render();
            const reloadedDevice = appState.deviceLayer.children[0];
            assert.equal(reloadedDevice.style.transform, 'translate(400px, 450px)');

            if (type === 'pointercancel') await finish(7, type);
            else eventBus.emit(type);

            assert.deepEqual(position(), { x: 400, y: 450 });
            assert.equal(reloadedDevice.style.transform, 'translate(400px, 450px)');
            assert.equal(reloadedDevice.classList.contains('dragging'), false);
            assert.equal(appState.canvas.hasPointerCapture(7), false);
            assert.equal(queue.hasPendingChanges(), false);
            await queue.flushSaveQueue({ silent: true });
            assert.equal(requests.length, 0);
        });
    }

    await scenario('別ビューの再読込では継続し、対象ビューの再読込では移動を破棄する', async () => {
        await device.dispatch('pointerdown', pointer(7, 100, 100, device));
        await move(7, 125, 135);
        eventBus.emit('resource:reloaded', { kind: 'views', id: 2 });
        assert.equal(appState.canvas.hasPointerCapture(7), true);
        appState.placements = [{ ...appState.placements[0], x: 400, y: 450 }];
        resource.resetResourceBaseline(appState);
        eventBus.emit('resource:reloaded', { kind: 'views', id: 1 });
        render();
        await finish(7, 'pointerup', [155, 165]);
        assert.deepEqual(position(), { x: 400, y: 450 });
        assert.equal(appState.canvas.hasPointerCapture(7), false);
        assert.equal(getPlacementHistoryAvailability(1).undo, false);
        assert.equal(requests.length, 0);
    });

    await scenario('確定時にグループの配置が消えたら部分移動を保存せず、次の操作へ復帰する', async () => {
        appState.devices.push(normalizeDevice({ id: 2, name: '試験機器2', type: 'pc', resource_revision: 1 }));
        appState.placements.push({ id: 2, device_id: 2, view_id: 1, x: 300, y: 300 });
        appState.selectedPlacementIds.add(2);
        await device.dispatch('pointerdown', pointer(7, 100, 100, device));
        await move(7, 125, 135);
        appState.placements.pop();
        await finish(7, 'pointerup', [NaN, NaN]); // 最終座標を再適用できない終了通知。
        assert.deepEqual(position(), { x: 100, y: 100 });
        assert.equal(requests.length, 0);
        resource.resetResourceBaseline(appState);

        await device.dispatch('pointerdown', pointer(7, 100, 100, device));
        await finish(7, 'pointerup', [125, 135]);
        await queue.flushSaveQueue({ silent: true });
        await historyKey('z');
        await queue.flushSaveQueue({ silent: true });
        assert.deepEqual(position(), { x: 100, y: 100 });
    });

    for (const type of ['pointerup', 'pointercancel']) {
        await scenario(`機器移動中の別ポインターの${type}で保存・終了しない`, async () => {
            await device.dispatch('pointerdown', pointer(7, 100, 100, device));
            await move(7, 120, 125);
            assert.equal(appState.canvas.hasPointerCapture(7), true);
            await move(8, 800, 900);
            assert.deepEqual(position(), { x: 120, y: 125 });
            await finish(8, type);
            assert.equal(requests.length, 0);
            assert.equal(appState.canvas.hasPointerCapture(7), true);
            assert.equal(device.classList.contains('dragging'), true);
            await move(7, 160, 135);
            assert.deepEqual(position(), { x: 160, y: 135 });
            await finish(7);
            await queue.flushSaveQueue({ silent: true });
            assert.equal(requests.length, 1);
            assert.equal(appState.canvas.hasPointerCapture(7), false);
            assert.equal(device.classList.contains('dragging'), false);
        });

        await scenario(`Canvasパン中の別ポインターの${type}で移動・終了しない`, async () => {
            drag.onCanvasPointerDown(pointer(7));
            await move(8, 800, 900);
            assert.deepEqual({ x: appState.viewState.panX, y: appState.viewState.panY }, { x: 0, y: 0 });
            await finish(8, type);
            assert.equal(appState.canvas.classList.contains('panning'), true);
            assert.equal(appState.canvas.hasPointerCapture(7), true);
            await move(7, 145, 125);
            assert.deepEqual({ x: appState.viewState.panX, y: appState.viewState.panY }, { x: 45, y: 25 });
            await finish(7);
            assert.equal(appState.canvas.classList.contains('panning'), false);
            assert.equal(appState.canvas.hasPointerCapture(7), false);
            assert.equal(requests.length, 0);
        });
    }

    await scenario('開始したポインターの取消で後片付けし、次の単一ポインター操作ができる', async () => {
        await device.dispatch('pointerdown', pointer(7, 100, 100, device));
        await finish(7, 'pointercancel');
        await move(7, 900, 900);
        assert.deepEqual(position(), { x: 100, y: 100 });
        assert.equal(requests.length, 0);
        await device.dispatch('pointerdown', pointer(7, 100, 100, device));
        await move(7, 125, 135);
        await finish(7);
        await queue.flushSaveQueue({ silent: true });
        assert.equal(requests.length, 1);
        assert.deepEqual(position(), { x: 125, y: 135 });
        drag.onCanvasPointerDown(pointer(7));
        await move(7, 110, 120);
        await finish(7, 'pointercancel');
        assert.equal(appState.canvas.classList.contains('panning'), false);
        assert.equal(appState.canvas.hasPointerCapture(7), false);
    });

    await scenario('noteMode・authExpired・ビュー競合中はドラッグを開始せず位置と保存対象を変えない', async () => {
        for (const mutate of [
            () => { appState.noteMode = true; },
            () => { appState.authExpired = true; },
            () => { appState.resourceConflicts.views.set(1, {}); }
        ]) {
            reset();
            mutate();
            await device.dispatch('pointerdown', pointer(7, 100, 100, device));
            await move(7, 160, 180);
            await finish(7);
            assert.deepEqual(position(), { x: 100, y: 100 });
            assert.equal(appState.canvas.hasPointerCapture(7), false);
            assert.equal(requests.length, 0);
        }
    });

    await scenario('openPanelの確認待ち中にpointerupが来た場合は確認承認後でもドラッグを中断する', async () => {
        const { appendPhpTemplates } = await import('./helpers/workspace-dom.mjs');
        const panelWrapper = document.createElement('div');
        appendPhpTemplates(panelWrapper, tag => document.createElement(tag), ['templates/components/property_panel.php']);
        document.body.appendChild(panelWrapper);
        const panel = await import('../public/js/ui/property-panel.js');
        try {
            appState.devices.push(normalizeDevice({ id: 2, name: '試験機器2', type: 'pc', ip: '', resource_revision: 1 }));
            appState.placements.push({ id: 2, device_id: 2, view_id: 1, x: 300, y: 300 });
            resource.resetResourceBaseline(appState);

            const deviceB = document.createElement('div');
            deviceB.className = 'device';
            deviceB.dataset.placementId = '2';
            appState.deviceLayer.append(deviceB);
            drag.makePlacementDraggable(deviceB, appState.placements[1]);

            assert.equal(await panel.openPanel(appState.devices[0]), true);
            const nameInput = document.getElementById('p-name');
            nameInput.value = '未適用の名称';
            await nameInput.dispatch('input');

            await deviceB.dispatch('pointerdown', pointer(7, 300, 300, deviceB));
            const moving = move(7, 350, 360);
            await setImmediate();
            const finishing = finish(7, 'pointerup', [360, 370]);
            const discardBtn = document.getElementById('unsaved-changes-discard');
            assert.ok(discardBtn, '未保存確認ダイアログが表示される');
            await discardBtn.dispatch('click');
            await moving;
            await finishing;
            await queue.flushSaveQueue({ silent: true });

            assert.deepEqual({ x: appState.placements[1].x, y: appState.placements[1].y }, { x: 300, y: 300 });
            assert.equal(requests.length, 0);
        } finally {
            await panel.closePanel();
            panelWrapper.remove();
        }
    });
});
