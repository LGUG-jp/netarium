import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { installWorkspaceDom } from './helpers/workspace-dom.mjs';

test('棚板の保存完了・削除と旧両面搭載の編集境界', async t => {
    const keys = ['window', 'document', 'Element', 'HTMLElement', 'fetch', 'requestAnimationFrame', 'cancelAnimationFrame'];
    const originals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const dom = installWorkspaceDom({ templates: ['templates/components/canvas.php', 'templates/components/canvas_context_toolbar.php', 'templates/components/property_panel.php', 'templates/components/tool_palette.php'] });
    const create = document.createElement;
    document.createElement = tag => {
        const node = create(tag); node.style.setProperty = (key, value) => { node.style[key] = value; };
        node.scrollIntoView = () => {}; return node;
    };
    globalThis.requestAnimationFrame = callback => setTimeout(callback, 0); globalThis.cancelAnimationFrame = clearTimeout;
    const { appState, normalizeView, normalizeDevice } = await import('../public/js/core/state.js');
    const { eventBus } = await import('../public/js/core/event-bus.js');
    const rack = await import('../public/js/canvas/rack-view.js');
    const shelf = await import('../public/js/canvas/rack-shelves.js');
    const queue = await import('../public/js/core/save-queue.js');
    const resource = await import('../public/js/core/resource-save.js');
    const { syncViewCapabilities } = await import('../public/js/ui/toolbar-controls.js');
    await import('../public/js/ui/toolbar.js');
    // main.jsと同じ描画完了時の再同期を実行し、保存Promise終了前のdisabledを経由する。
    const syncAfterRender = () => syncViewCapabilities();
    eventBus.on('canvas:render-complete', syncAfterRender);
    t.after(() => {
        queue.clearPendingSave(); eventBus.off('canvas:render-complete', syncAfterRender);
        for (const [key, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
        }
    });
    const shelfRow = { id: 1, view_id: 1, name: '棚板', face: 'front', start_u: 4, height_u: 1, depth: 'half' };
    const legacy = { device_id: 1, view_id: 1, face: 'both', start_u: 1, height_u: 2, width_slot: 'full', depth: 'half' };
    function reset({ shelves = [shelfRow], mounts = [] } = {}) {
        queue.clearPendingSave(); shelf.closeShelfPanel();
        Object.assign(appState, {
            views: [normalizeView({ id: 1, name: 'ラック', view_type: 'rack', resource_revision: 1 })],
            devices: [1, 2].map(id => normalizeDevice({ id, name: `機器${id}`, type: 'switch', resource_revision: id })),
            placements: [], links: [], canvasNotes: [], floorPlans: [], deviceImages: [],
            rackSettings: [{ view_id: 1, total_u: 6, location: '' }], rackMounts: structuredClone(mounts),
            rackShelves: structuredClone(shelves), rackShelfDevices: [], currentViewId: 1,
            canvas: dom.get('canvas'), world: dom.get('world'), selectedPlacementIds: new Set(), editingDeviceId: null,
            resourceConflicts: { devices: new Map(), views: new Map() }, appStatus: { dirty: false, state: 'saved' },
            isSaving: false, authExpired: false, isPinging: false
        });
        window.APP_CONFIG.user.isAdmin = true; resource.resetResourceBaseline(appState);
        rack.renderRackView(); syncViewCapabilities();
    }
    const response = (shelves, mounts = [], revision = 2) => new Response(JSON.stringify({
        ok: true, revision, id_maps: {}, devices: [], views: [{ ...appState.views[0], resource_revision: revision }],
        placements: [], links: [], canvas_notes: [], rack_settings: [{ view_id: 1, total_u: 6, location: '' }],
        rack_mounts: mounts, rack_shelves: shelves, rack_shelf_devices: [],
        affected_view_ids: [1], deleted_device_ids: [], deleted_view_ids: []
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const cancelMount = async () => document.querySelector('.rack-mount-actions').querySelectorAll('button')
        .find(node => node.textContent === 'キャンセル').dispatch('click');

    await t.test('実保存の完了後に棚板ボタンが再び操作でき、保存中と競合時は無効にする', async () => {
        reset();
        let release;
        globalThis.fetch = async () => new Promise(resolve => { release = () => resolve(response([{ ...shelfRow, name: '更新棚板' }])); });
        shelf.openShelfDialog({ viewId: 1, shelfId: 1 });
        dom.get('rack-shelf-name').value = '更新棚板';
        await document.querySelector('.rack-mount-form').dispatch('submit'); await setImmediate();
        try {
            assert.equal(queue.isSaveInFlight(), true);
            eventBus.emit('canvas:render-complete');
            assert.equal(dom.get('palette-shelf-btn').disabled, true);
        } finally {
            release(); await queue.flushSaveQueue({ silent: true });
        }
        assert.equal(queue.isSaveInFlight(), false);
        assert.equal(dom.get('palette-shelf-btn').disabled, false);
        await dom.events.dispatch('click', { target: dom.get('palette-shelf-btn') });
        assert.equal(shelf.isShelfAdding(), true);
        const cell = document.querySelector('.rack-front').querySelectorAll('.rack-empty').find(node => node.dataset.u === '5');
        await cell.dispatch('click'); assert.ok(dom.get('rack-shelf-title'));
        await cancelMount();
        appState.resourceConflicts.views.set(1, {}); eventBus.emit('save-state:changed');
        assert.equal(dom.get('palette-shelf-btn').disabled, true);
        appState.resourceConflicts.views.clear(); appState.appStatus.state = 'unconfirmed'; eventBus.emit('save-state:changed');
        assert.equal(dom.get('palette-shelf-btn').disabled, true);
        appState.appStatus.state = 'saved'; appState.isPinging = true; eventBus.emit('save-state:changed');
        assert.equal(dom.get('palette-shelf-btn').disabled, true);
        appState.isPinging = false; window.APP_CONFIG.user.isAdmin = false; eventBus.emit('save-state:changed');
        assert.equal(dom.get('palette-shelf-btn').disabled, true);
    });
    await t.test('空棚板の削除取消は詳細を保ち、承認後は削除済みパネルを残さない', async () => {
        reset(); globalThis.fetch = async () => response([]);
        await shelf.showShelfPanel(1); window.confirm = () => false;
        assert.equal(shelf.deleteShelf(1), false); assert.ok(dom.get('rack-shelf-panel'));
        assert.equal(appState.rackShelves[0].id, 1);
        window.confirm = () => true;
        await dom.get('rack-shelf-panel').querySelectorAll('button').find(node => node.textContent === '棚板を削除').dispatch('click');
        assert.equal(dom.get('rack-shelf-panel'), null);
        assert.equal(appState.rackShelves.some(row => row.id === 1), false);
        assert.equal(await queue.flushSaveQueue({ silent: true }), true);
        assert.equal(dom.get('rack-shelf-panel'), null);
    });
    await t.test('旧bothは表示・編集取消で保持し、設定保存時だけ両面占有を保つ前面fullへ変換する', async () => {
        reset({ shelves: [], mounts: [legacy] });
        rack.openRackMountDialog({ viewId: 1, deviceId: 1 });
        assert.deepEqual(dom.get('rack-mount-face').options.map(row => row.value), ['front', 'rear']);
        assert.equal(dom.get('rack-mount-face').value, 'front');
        assert.equal(dom.get('rack-mount-depth').value, 'full');
        assert.equal(document.querySelector('.rack-mount-legacy-notice').hidden, false);
        await cancelMount();
        assert.deepEqual(appState.rackMounts, [legacy]);
        assert.deepEqual(resource.buildResourceSave(), { devices: [], views: [] });
        globalThis.fetch = async () => response([], [{ ...legacy, face: 'front', depth: 'full' }]);
        rack.openRackMountDialog({ viewId: 1, deviceId: 1 });
        await document.querySelector('.rack-mount-form').dispatch('submit');
        assert.equal(await queue.flushSaveQueue({ silent: true }), true);
        assert.equal(appState.rackMounts[0].face, 'front'); assert.equal(appState.rackMounts[0].depth, 'full');
        assert.equal(document.querySelector('.rack-rear').querySelectorAll('.rack-depth-blocked').length, 4);
    });
    await t.test('新規搭載は前面と背面だけ選べ、奥行き全体では反対面の搭載と衝突する', async () => {
        const opposite = { ...legacy, face: 'rear', depth: 'half' };
        reset({ shelves: [], mounts: [opposite] });
        rack.openRackMountDialog({ viewId: 1, startU: 1, heightU: 1 });
        const search = dom.get('rack-mount-search'); search.value = '機器2'; await search.dispatch('input');
        await search.dispatch('keydown', { key: 'ArrowDown' }); await search.dispatch('keydown', { key: 'Enter' });
        assert.deepEqual(dom.get('rack-mount-face').options.map(row => row.value), ['front', 'rear']);
        assert.equal(document.querySelector('.rack-mount-actions').querySelector('button[type="submit"]').disabled, false);
        dom.get('rack-mount-depth').value = 'full'; await dom.get('rack-mount-depth').dispatch('change');
        assert.equal(document.querySelector('.rack-mount-actions').querySelector('button[type="submit"]').disabled, true);
        await document.querySelector('.rack-mount-form').dispatch('submit'); assert.deepEqual(appState.rackMounts, [opposite]);
        await cancelMount();
    });
    const mounted = { ...legacy, face: 'front', width_slot: 'left', depth: 'half' };
    const preview = () => document.querySelector('.rack-mount-comparison');
    const sourceText = () => preview().querySelector('.rack-transfer-from').textContent;
    const destinationText = () => preview().querySelector('.rack-transfer-to').textContent;
    const submitMount = () => document.querySelector('.rack-mount-form').dispatch('submit');
    const change = async (name, value) => {
        dom.get(`rack-mount-${name}`).value = String(value);
        await dom.get(`rack-mount-${name}`).dispatch('change');
    };
    function addDestination() {
        appState.views.push(normalizeView({ id: 2, name: '移設先ラック', view_type: 'rack', resource_revision: 1 }));
        appState.rackSettings.push({ view_id: 2, total_u: 6, location: '' });
        resource.resetResourceBaseline(appState);
    }
    await t.test('同じラックの入力変更は変更後だけ更新し、取消で元搭載と保存差分を保つ', async () => {
        reset({ shelves: [], mounts: [mounted] });
        rack.openRackMountDialog({ viewId: 1, deviceId: 1 });
        const before = sourceText();
        assert.match(before, /ラック.*前面.*左半分.*1〜2U.*奥行き：半分/);
        assert.match(document.querySelector('.modal-header-target').textContent, /搭載位置を変更：現在 → 変更後/);
        await change('start', 3); await change('height', 1);
        await change('face', 'rear'); await change('width', 'left'); await change('depth', 'full');
        assert.equal(sourceText(), before);
        assert.match(destinationText(), /ラック.*背面.*左半分.*3〜3U.*奥行き：全体/);
        assert.deepEqual(appState.rackMounts, [mounted]);
        await cancelMount();
        assert.deepEqual(appState.rackMounts, [mounted]);
        assert.deepEqual(resource.buildResourceSave(), { devices: [], views: [] });
    });
    await t.test('別ラック選択と確認にも元先を表示し、確認取消後も元位置を固定する', async () => {
        reset({ shelves: [], mounts: [mounted] }); addDestination();
        rack.openRackMountDialog({ viewId: 1, deviceId: 1 });
        const before = sourceText();
        await change('view', 2); await change('start', 3);
        assert.equal(sourceText(), before);
        assert.match(destinationText(), /移設先ラック.*3〜4U/);
        assert.match(document.querySelector('.modal-header-target').textContent, /ラックへ移設：現在 → 移設先/);
        await submitMount();
        const confirmation = document.querySelector('.rack-transfer-confirmation');
        assert.equal(confirmation.hidden, false);
        assert.match(confirmation.querySelector('.rack-transfer-from').textContent, /ラック.*1〜2U/);
        assert.match(confirmation.querySelector('.rack-transfer-to').textContent, /移設先ラック.*3〜4U/);
        await cancelMount();
        assert.equal(confirmation.hidden, true); assert.equal(sourceText(), before);
        assert.deepEqual(appState.rackMounts, [mounted]);
        await change('view', 1);
        assert.match(document.querySelector('.modal-header-target').textContent, /搭載位置を変更：現在 → 変更後/);
        await cancelMount();
        assert.deepEqual(resource.buildResourceSave(), { devices: [], views: [] });
    });
    await t.test('棚板元は同じラックでも移設となり棚板名・面・U・幅・奥行きを対比する', async () => {
        reset(); appState.rackShelfDevices = [{ shelf_id: 1, device_id: 1, sort_order: 0 }];
        resource.resetResourceBaseline(appState);
        rack.openRackMountDialog({ viewId: 1, deviceId: 1 });
        const before = sourceText();
        assert.match(before, /ラック.*棚板「棚板」.*前面.*全幅.*4〜4U.*奥行き：半分/);
        assert.match(document.querySelector('.modal-header-target').textContent, /ラックへ移設：現在 → 移設先/);
        await change('start', 1); await change('face', 'rear');
        assert.equal(sourceText(), before); assert.match(destinationText(), /背面.*1〜1U/);
        await submitMount();
        assert.equal(document.querySelector('.rack-transfer-confirmation').hidden, false);
        assert.match(document.querySelector('.rack-transfer-confirmation').querySelector('.rack-transfer-from').textContent, /棚板「棚板」/);
        await cancelMount(); await cancelMount();
        assert.deepEqual(appState.rackShelfDevices, [{ shelf_id: 1, device_id: 1, sort_order: 0 }]);
        assert.deepEqual(appState.rackMounts, []);
        assert.deepEqual(resource.buildResourceSave(), { devices: [], views: [] });
    });
    await t.test('既存未搭載と新しい機器の搭載は移設と誤表示せず入力で先だけ変わる', async () => {
        reset({ shelves: [] });
        rack.openRackMountDialog({ viewId: 1 });
        const search = dom.get('rack-mount-search'); search.value = '機器2'; await search.dispatch('input');
        await search.dispatch('keydown', { key: 'ArrowDown' }); await search.dispatch('keydown', { key: 'Enter' });
        const before = sourceText();
        assert.match(before, /未搭載/);
        assert.equal(document.querySelector('.modal-header-target').textContent, '搭載位置（指定先）');
        await change('start', 3);
        assert.equal(sourceText(), before); assert.match(destinationText(), /3〜3U/);
        await document.querySelector('.rack-mount-device-area').querySelectorAll('button')
            .find(node => node.textContent === '新しい機器を登録').dispatch('click');
        assert.equal(document.querySelector('.modal-header-target').textContent, '搭載位置（指定先）');
        assert.match(sourceText(), /未搭載/);
        await cancelMount();
        assert.deepEqual(appState.rackMounts, []);
        assert.equal(appState.devices.length, 2);
    });
    await t.test('確認中の元位置変更とラック競合は確定を拒否して元データを上書きしない', async () => {
        reset({ shelves: [], mounts: [mounted] }); addDestination();
        rack.openRackMountDialog({ viewId: 2, deviceId: 1 });
        const before = sourceText();
        await submitMount();
        assert.equal(document.querySelector('.rack-transfer-confirmation').hidden, false);
        appState.rackMounts[0].start_u = 2;
        await submitMount();
        assert.equal(document.querySelector('.rack-transfer-confirmation').hidden, true);
        assert.match(dom.get('rack-mount-error').textContent, /確認中に/);
        assert.equal(sourceText(), before);
        assert.equal(appState.rackMounts[0].view_id, 1);
        assert.equal(appState.rackMounts[0].start_u, 2);
        await submitMount();
        appState.resourceConflicts.views.set(2, {});
        await submitMount();
        assert.match(dom.get('rack-mount-error').textContent, /保存状態が変わりました/);
        assert.equal(appState.rackMounts[0].view_id, 1);
        await cancelMount();
    });
});
