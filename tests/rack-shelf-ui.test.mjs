import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installWorkspaceDom } from './helpers/workspace-dom.mjs';

test('棚板ブロック・所属詳細・追加取消・削除拒否・権限競合ガード', async t => {
    const keys = ['window', 'document', 'Element', 'HTMLElement', 'fetch', 'requestAnimationFrame', 'cancelAnimationFrame'];
    const originals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const dom = installWorkspaceDom({ templates: ['templates/components/canvas.php', 'templates/components/canvas_context_toolbar.php', 'templates/components/property_panel.php', 'templates/components/tool_palette.php'] });
    const create = document.createElement;
    document.createElement = tag => { const node = create(tag); node.style.setProperty = (key, value) => { node.style[key] = value; }; node.scrollIntoView = () => {}; return node; };
    globalThis.requestAnimationFrame = callback => setTimeout(callback, 0); globalThis.cancelAnimationFrame = clearTimeout;
    const { appState, normalizeView, normalizeDevice } = await import('../public/js/core/state.js');
    const rack = await import('../public/js/canvas/rack-view.js');
    const shelf = await import('../public/js/canvas/rack-shelves.js');
    const queue = await import('../public/js/core/save-queue.js');
    const { syncViewCapabilities } = await import('../public/js/ui/toolbar-controls.js');
    t.after(() => { queue.clearPendingSave(); for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
    window.APP_CONFIG.user.isAdmin = true;
    Object.assign(appState, { views: [normalizeView({ id: 1, name: '試験ラック', view_type: 'rack', resource_revision: 1 })],
        devices: [1, 2].map(id => normalizeDevice({ id, name: `機器${id}`, type: 'switch' })), placements: [], links: [], canvasNotes: [], floorPlans: [], deviceImages: [],
        rackSettings: [{ view_id: 1, total_u: 6, location: '' }], rackMounts: [],
        rackShelves: [{ id: -1, view_id: 1, name: '管理棚', face: 'front', start_u: 2, height_u: 1, depth: 'full' }],
        rackShelfDevices: [{ device_id: 1, shelf_id: -1, sort_order: 0 }, { device_id: 2, shelf_id: -1, sort_order: 1 }], currentViewId: 1,
        canvas: dom.get('canvas'), world: dom.get('world'), selectedPlacementIds: new Set(), editingDeviceId: null,
        resourceConflicts: { devices: new Map(), views: new Map() }, appStatus: { dirty: false, state: 'saved' }, isSaving: false, authExpired: false, isPinging: false });
    syncViewCapabilities(); assert.equal(dom.get('palette-shelf-btn').hidden, false); assert.equal(dom.get('palette-place-btn').hidden, true); assert.equal(dom.get('linkBtn').hidden, true);
    rack.renderRackView();
    const block = document.querySelector('.rack-shelf'); assert.ok(block.textContent.includes('管理棚')); assert.ok(block.textContent.includes('2台')); assert.equal(block.style.gridRow, '5 / span 1'); assert.equal(block.style.gridColumn, '1 / span 2');
    assert.equal(document.querySelector('.rack-rear').querySelectorAll('.rack-depth-blocked').length, 2);
    await shelf.showShelfPanel(-1);
    const panel = dom.get('rack-shelf-panel'); assert.ok(panel.textContent.includes('機器1'));
    assert.equal(panel.querySelectorAll('button').find(node => node.textContent === '棚板を削除').disabled, true);
    assert.equal(shelf.deleteShelf(-1), false); assert.equal(appState.rackShelves.length, 1);
    const { resetResourceBaseline, buildResourceSave, createPendingResourceSave } = await import('../public/js/core/resource-save.js');
    await t.test('別ビューから棚板詳細を開き、存在しない棚板では現在の詳細を保持する', async () => {
        appState.views.push(normalizeView({ id: 9, name: '論理図', view_type: 'logical' }));
        appState.currentViewId = 9;
        resetResourceBaseline(appState);
        assert.equal(await shelf.showShelfPanel(-1), true);
        assert.equal(appState.currentViewId, 1);
        const current = dom.get('rack-shelf-panel');
        assert.equal(await shelf.showShelfPanel(999), false);
        assert.equal(dom.get('rack-shelf-panel'), current);
        appState.views.pop();
    });
    shelf.setShelfAdding(true); assert.equal(shelf.isShelfAdding(), true);
    shelf.openShelfDialog({ viewId: 1, startU: 4 }); assert.ok(dom.get('rack-shelf-title'));
    await document.querySelector('.rack-mount-actions').querySelectorAll('button').find(node => node.textContent === 'キャンセル').dispatch('click');
    assert.equal(shelf.isShelfAdding(), false); assert.equal(appState.rackShelves.length, 1);
    const { eventBus } = await import('../public/js/core/event-bus.js');
    const button = (root, text) => root.querySelectorAll('button').find(node => node.textContent === text);
    const panelNow = () => dom.get('rack-shelf-panel');
    const addOverlay = () => document.querySelector('.rack-shelf-device-overlay');
    const addForm = () => document.querySelector('.rack-shelf-device-form');
    const settle = async () => { assert.equal(await queue.flushSaveQueue({ silent: true }), true); };
    globalThis.fetch = async (_url, options) => {
        const deviceIds = Object.fromEntries(JSON.parse(options.body).devices.filter(row => row.operation === 'create').map(row => [row.id, row.id + 100]));
        const shelfIds = Object.fromEntries(createPendingResourceSave(buildResourceSave()).newIds.rack_shelves.map(id => [id, 100 - id]));
        return new Response(JSON.stringify({
            ok: true, revision: 2, id_maps: { devices: deviceIds, rack_shelves: shelfIds },
            devices: appState.devices.map(row => ({ ...row, id: deviceIds[row.id] || row.id, resource_revision: 2 })),
            views: appState.views.map(view => ({ ...view, resource_revision: view.resource_revision + 1 })),
            placements: [], links: [], canvas_notes: [], rack_settings: appState.rackSettings,
            rack_mounts: appState.rackMounts, rack_shelves: appState.rackShelves.map(row => ({ ...row, id: shelfIds[row.id] || row.id })),
            rack_shelf_devices: appState.rackShelfDevices.map(row => ({ ...row, device_id: deviceIds[row.device_id] || row.device_id, shelf_id: shelfIds[row.shelf_id] || row.shelf_id })),
            affected_view_ids: appState.views.map(view => view.id), deleted_device_ids: [], deleted_view_ids: []
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    resetResourceBaseline(appState);
    await t.test('棚板のクリックとダブルクリックは詳細・設定を分け、閲覧者と追加モードでは編集しない', async () => {
        rack.renderRackView();
        const block = document.querySelector('.rack-shelf');
        await block.dispatch('click', { detail: 1 });
        assert.ok(panelNow());
        await block.dispatch('click', { detail: 2 });
        await block.dispatch('dblclick');
        assert.ok(dom.get('rack-shelf-name'));
        await button(document.querySelector('.rack-mount-actions'), 'キャンセル').dispatch('click');
        assert.equal(document.activeElement, block);
        window.APP_CONFIG.user.isAdmin = false;
        await block.dispatch('click', { detail: 1 }); await block.dispatch('dblclick');
        assert.ok(panelNow()); assert.equal(dom.get('rack-shelf-name'), null);
        window.APP_CONFIG.user.isAdmin = true;
        shelf.setShelfAdding(true); await block.dispatch('dblclick');
        assert.equal(dom.get('rack-shelf-name'), null); shelf.setShelfAdding(false);
    });
    await t.test('別ビューの棚板詳細は未適用入力の編集継続でビュー・入力を保持する', async () => {
        const panels = await import('../public/js/ui/property-panel.js');
        appState.views.push(normalizeView({ id: 9, name: '論理図', view_type: 'logical' }));
        appState.currentViewId = 9; resetResourceBaseline(appState);
        await panels.openPanel(appState.devices[0]);
        dom.get('p-name').value = '保持する下書き'; await dom.get('p-name').dispatch('input');
        const opening = shelf.showShelfPanel(-1);
        await new Promise(resolve => setImmediate(resolve));
        await dom.get('unsaved-changes-cancel').dispatch('click');
        assert.equal(await opening, false);
        assert.equal(appState.currentViewId, 9); assert.equal(appState.editingDeviceId, 1);
        assert.equal(dom.get('p-name').value, '保持する下書き');
        const retry = shelf.showShelfPanel(-1);
        await new Promise(resolve => setImmediate(resolve));
        await dom.get('unsaved-changes-discard').dispatch('click');
        assert.equal(await retry, true); assert.equal(appState.currentViewId, 1);
        appState.views.pop(); resetResourceBaseline(appState);
    });
    await t.test('設定比較は現在位置を固定し、移設確認の取消・revision変更で棚板と所属を保持する', async () => {
        appState.views.push(normalizeView({ id: 8, name: '移設先ラック', view_type: 'rack', resource_revision: 1 }));
        appState.rackSettings.push({ view_id: 8, total_u: 6, location: '' });
        resetResourceBaseline(appState);
        const before = structuredClone(appState.rackShelves), members = structuredClone(appState.rackShelfDevices);
        shelf.openShelfDialog({ viewId: 1, shelfId: -1 });
        const source = document.querySelector('.rack-transfer-from').textContent;
        const form = document.querySelector('.rack-mount-form');
        dom.get('rack-shelf-view').value = '8'; dom.get('rack-shelf-start').value = '4';
        dom.get('rack-shelf-name').value = '移設後の棚'; dom.get('rack-shelf-depth').value = 'half';
        await form.dispatch('change');
        assert.equal(document.querySelector('.rack-transfer-from').textContent, source);
        const destination = document.querySelector('.rack-transfer-to').textContent;
        assert.ok(destination.includes('移設先ラック')); assert.ok(destination.includes('移設後の棚'));
        assert.ok(destination.includes('4〜4U')); assert.ok(destination.includes('半分'));
        await form.dispatch('submit');
        assert.equal(document.querySelector('.rack-transfer-confirmation').hidden, false);
        assert.deepEqual(appState.rackShelves, before);
        await button(document.querySelector('.rack-mount-actions'), 'キャンセル').dispatch('click');
        assert.equal(document.querySelector('.rack-transfer-confirmation').hidden, true);
        await form.dispatch('submit'); appState.views[1].resource_revision++;
        await form.dispatch('submit');
        assert.deepEqual(appState.rackShelves, before); assert.deepEqual(appState.rackShelfDevices, members);
        assert.equal(document.querySelector('.rack-transfer-from').textContent, source);
        await button(document.querySelector('.rack-mount-actions'), 'キャンセル').dispatch('click');
        await button(document.querySelector('.rack-mount-actions'), 'キャンセル').dispatch('click');
        shelf.openShelfDialog({ viewId: 1, shelfId: -1 });
        dom.get('rack-shelf-start').value = '3'; await document.querySelector('.rack-mount-form').dispatch('input');
        await document.querySelector('.rack-mount-form').dispatch('submit'); await settle();
        assert.equal(appState.rackShelves[0].start_u, 3);
        assert.deepEqual(appState.rackShelfDevices, members);
        shelf.openShelfDialog({ viewId: 1, shelfId: -1 });
        dom.get('rack-shelf-view').value = '8'; await document.querySelector('.rack-mount-form').dispatch('change');
        await document.querySelector('.rack-mount-form').dispatch('submit');
        await document.querySelector('.rack-mount-form').dispatch('submit'); await settle();
        assert.equal(appState.rackShelves[0].view_id, 8);
        assert.deepEqual(appState.rackShelfDevices, members);
        appState.rackShelves = before; appState.views.pop(); appState.rackSettings.pop(); resetResourceBaseline(appState);
        shelf.openShelfDialog({ viewId: 1, startU: 4 });
        assert.equal(document.querySelector('.rack-mount-comparison').querySelector('.rack-transfer-from'), null);
        dom.get('rack-shelf-name').value = '追加棚';
        await document.querySelector('.rack-mount-form').dispatch('submit'); await settle();
        assert.ok(appState.rackShelves.some(row => row.name === '追加棚' && row.start_u === 4));
        appState.rackShelves = before; resetResourceBaseline(appState); await shelf.showShelfPanel(-1);
    });
    await t.test('棚板詳細から並べ替え・個別取り外しを保存し空状態へ更新する', async () => {
        window.confirm = () => true;
        await shelf.showShelfPanel(-1);
        await button(panelNow(), '↓').dispatch('click'); await settle();
        assert.deepEqual(shelf.shelfMembers(-1).map(row => row.device_id), [2, 1]);
        await button(panelNow(), '取り外し').dispatch('click'); await settle();
        assert.deepEqual(shelf.shelfMembers(-1).map(row => row.device_id), [1]);
        await button(panelNow(), '取り外し').dispatch('click'); await settle();
        assert.deepEqual(shelf.shelfMembers(-1), []);
        assert.equal(appState.devices.find(row => row.id === 2).name, '機器2');
    });
    await t.test('既存機器は検索入力後に候補を出し、型番検索から追加してモーダルを閉じる', async () => {
        appState.devices[1].model = 'SMALL-200'; resetResourceBaseline(appState);
        await button(panelNow(), '＋ 機器を追加').dispatch('click');
        const search = dom.get('rack-shelf-device-search');
        assert.ok(addOverlay()); assert.equal(addOverlay().textContent.includes('機器2'), false);
        search.value = 'SMALL-200'; await search.dispatch('input');
        await addOverlay().querySelector('.rack-shelf-candidates').querySelector('button').dispatch('click');
        await addForm().dispatch('submit'); await settle();
        assert.equal(addOverlay(), null);
        assert.deepEqual(shelf.shelfMembers(-1).map(row => row.device_id), [2]);
        assert.ok(panelNow().textContent.includes('機器2'));
    });
    await t.test('直付けから棚板は元先カードを確認し、取消・revision変更では移設しない', async () => {
        appState.rackMounts = [{ device_id: 1, view_id: 1, face: 'rear', start_u: 5, height_u: 1, width_slot: 'full', depth: 'half' }];
        resetResourceBaseline(appState);
        await button(panelNow(), '＋ 機器を追加').dispatch('click');
        const search = dom.get('rack-shelf-device-search'); search.value = '機器1'; await search.dispatch('input');
        await addOverlay().querySelector('.rack-shelf-candidates').querySelector('button').dispatch('click'); await addForm().dispatch('submit');
        let confirmation = addOverlay().querySelector('.rack-transfer-confirmation');
        assert.equal(confirmation.hidden, false); assert.equal(confirmation.textContent.includes('別ラック'), false);
        assert.ok(confirmation.textContent.includes('元の所属')); assert.equal(appState.rackMounts[0].device_id, 1);
        await button(addOverlay(), 'キャンセル').dispatch('click');
        assert.equal(confirmation.hidden, true); assert.equal(appState.rackShelfDevices.some(row => row.device_id === 1), false);
        await addForm().dispatch('submit');
        appState.views[0].resource_revision += 1;
        await addForm().dispatch('submit');
        assert.equal(appState.rackMounts[0].device_id, 1);
        assert.equal(appState.rackShelfDevices.some(row => row.device_id === 1), false);
        await button(addOverlay(), 'キャンセル').dispatch('click');
        if (addOverlay()) await button(addOverlay(), 'キャンセル').dispatch('click');
    });
    await t.test('棚板間とラック間の移設を元先カードで確定し、一つの所属だけ保存する', async () => {
        appState.views.push(normalizeView({ id: 2, name: '別棟ラック', view_type: 'rack', resource_revision: 1 }));
        appState.rackSettings.push({ view_id: 2, total_u: 6, location: '' });
        appState.rackShelves.push(
            { id: -2, view_id: 1, name: '上段棚', face: 'front', start_u: 4, height_u: 1, depth: 'half' },
            { id: -3, view_id: 2, name: '別棟棚', face: 'front', start_u: 2, height_u: 1, depth: 'half' }
        );
        resetResourceBaseline(appState);
        for (const target of [-2, -3, -1]) {
            const destination = appState.rackShelves.find(row => row.id === target);
            appState.currentViewId = destination.view_id;
            await shelf.showShelfPanel(target);
            await button(panelNow(), '＋ 機器を追加').dispatch('click');
            const search = dom.get('rack-shelf-device-search'); search.value = '機器2'; await search.dispatch('input');
            await addOverlay().querySelector('.rack-shelf-candidates').querySelector('button').dispatch('click');
            const before = structuredClone(appState.rackShelfDevices);
            await addForm().dispatch('submit');
            assert.equal(addOverlay().querySelector('.rack-transfer-confirmation').hidden, false);
            assert.deepEqual(appState.rackShelfDevices, before);
            await addForm().dispatch('submit'); await settle();
            assert.deepEqual(appState.rackShelfDevices.filter(row => row.device_id === 2).map(row => row.shelf_id), [target]);
            assert.equal(appState.rackMounts.some(row => row.device_id === 2), false);
            assert.equal(addOverlay(), null);
        }
    });
    await t.test('新規登録はIP空欄で棚板に所属し、追加モーダルを閉じ詳細を更新する', async () => {
        resetResourceBaseline(appState);
        await button(panelNow(), '＋ 機器を追加').dispatch('click');
        await button(addOverlay(), '新しい機器を登録').dispatch('click');
        dom.get('rack-shelf-device-name').value = '新規ONU';
        dom.get('rack-shelf-device-ip').value = '不正なIP';
        await addForm().dispatch('submit');
        assert.equal(appState.devices.some(row => row.name === '新規ONU'), false);
        dom.get('rack-shelf-device-ip').value = '';
        await addForm().dispatch('submit'); await settle();
        assert.equal(addOverlay(), null);
        const registered = appState.devices.find(row => row.name === '新規ONU');
        assert.ok(registered); assert.equal(registered.ip, '');
        const member = shelf.shelfMembers(-1).find(row => row.device_id === registered.id);
        assert.ok(member);
        assert.ok(panelNow().textContent.includes(appState.devices.find(row => row.id === member.device_id).name));
    });
    await t.test('競合発生時は機器追加モーダルを閉じ、所属を変更しない', async () => {
        await button(panelNow(), '＋ 機器を追加').dispatch('click');
        const before = structuredClone(appState.rackShelfDevices);
        appState.resourceConflicts.views.set(1, {}); eventBus.emit('save-state:changed');
        assert.equal(addOverlay(), null); assert.deepEqual(appState.rackShelfDevices, before);
        appState.resourceConflicts.views.clear();
    });
    appState.resourceConflicts.views.set(1, {}); assert.equal(shelf.removeShelfDevice(1), false); assert.equal(shelf.reorderShelfDevice(1, 1), false);
    appState.resourceConflicts.views.clear(); appState.appStatus.state = 'unconfirmed'; assert.equal(shelf.assignDeviceToShelf(1, -1), false);
    appState.appStatus.state = 'saved'; window.APP_CONFIG.user.isAdmin = false; assert.equal(shelf.removeShelfDevice(1), false);
    shelf.closeShelfPanel();
});
