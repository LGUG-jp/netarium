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
    const cell = (face, u, slot = 'left') => document.querySelector(`.rack-${face}`).querySelectorAll('.rack-empty')
        .find(node => Number(node.dataset.u) === u && node.style.gridColumn === (slot === 'left' ? '1' : '2'));
    const mouse = { pointerType: 'mouse', pointerId: 12, button: 0 };
    const closeDialog = async () => (button(document.querySelector('.rack-mount-actions'), '閉じる') || button(document.querySelector('.rack-mount-actions'), 'キャンセル'))?.dispatch('click');
    await t.test('棚板は単一セル・複数U・左右全幅をマウス解放時に一度だけ確定する', async () => {
        for (const [face, start, end, slot] of [['front', 3, 3, 'left'], ['front', 3, 6, 'right'], ['rear', 6, 3, 'left']]) {
            shelf.setShelfAdding(true);
            const first = cell(face, start), last = cell(face, end, slot);
            await first.dispatch('pointerdown', mouse); await last.dispatch('pointerenter', mouse);
            assert.equal(document.querySelectorAll('.rack-range-selected').length, (Math.abs(start - end) + 1) * 2, '棚板は全幅を選択');
            await last.dispatch('pointerup', mouse);
            await dom.events.dispatch('pointerup', { ...mouse, target: last });
            const form = document.querySelector('.rack-mount-form');
            assert.ok(dom.get('rack-shelf-title'));
            assert.equal(dom.get('rack-mount-title'), null, '機器搭載画面は開かない');
            assert.equal(dom.get('rack-shelf-face').value, face);
            assert.equal(dom.get('rack-shelf-start').value, String(Math.min(start, end)));
            assert.equal(dom.get('rack-shelf-height').value, String(Math.abs(start - end) + 1));
            assert.equal(document.querySelectorAll('.rack-range-selected').length, 0);
            await last.dispatch('click', { detail: 1 });
            assert.equal(document.querySelector('.rack-mount-form'), form);
            await closeDialog();
            assert.equal(shelf.isShelfAdding(), false);
        }
        assert.equal(appState.rackShelves.length, 1, '設定をキャンセルした棚板は追加しない');
        assert.deepEqual(buildResourceSave(), { devices: [], views: [] });
    });
    await t.test('棚板のタッチ・ペン・キーボード・ボタン確定を維持する', async () => {
        for (const pointerType of ['touch', 'pen']) {
            shelf.setShelfAdding(true);
            const tap = async node => {
                await node.dispatch('pointerdown', { pointerType, pointerId: 15, button: 0 });
                await node.dispatch('pointerup', { pointerType, pointerId: 15, button: 0 });
                await dom.events.dispatch('pointerup', { pointerType, pointerId: 15, target: node });
                await node.dispatch('click', { detail: 1 });
            };
            await tap(cell('front', 3));
            assert.equal(dom.get('rack-shelf-title'), null, `${pointerType}は1回目で確定しない`);
            await tap(cell('front', 5));
            assert.equal(dom.get('rack-shelf-height').value, '3');
            await closeDialog();
        }
        shelf.setShelfAdding(true);
        await cell('front', 3).dispatch('keydown', { key: 'Enter' });
        assert.equal(dom.get('rack-shelf-title'), null);
        await cell('front', 5).dispatch('keydown', { key: 'Enter' });
        assert.equal(dom.get('rack-shelf-height').value, '3');
        await closeDialog();
        shelf.setShelfAdding(true);
        await cell('front', 3).dispatch('keydown', { key: ' ' });
        await dom.get('rack-range-mount-btn').dispatch('click');
        assert.equal(dom.get('rack-shelf-start').value, '3');
        await closeDialog();
    });
    await t.test('棚板は途中の占有と反対側ハーフ幅占有を拒否し、Escape後に再開しない', async () => {
        for (const reason of ['shelf', 'half-mount', 'Escape']) {
            if (reason === 'half-mount') {
                appState.rackMounts = [{ device_id: 2, view_id: 1, face: 'front', start_u: 4, height_u: 1, width_slot: 'right' }];
                rack.renderRackView();
            }
            shelf.setShelfAdding(true);
            const first = cell('front', reason === 'shelf' ? 1 : 3), last = cell('front', 5);
            await first.dispatch('pointerdown', mouse); await last.dispatch('pointerenter', mouse);
            if (reason === 'Escape') await dom.events.dispatch('keydown', { key: 'Escape' });
            await last.dispatch('pointerup', mouse); await last.dispatch('click', { detail: 1 });
            assert.equal(dom.get('rack-shelf-title'), null, reason);
            assert.equal(dom.get('rack-mount-title'), null, reason);
            assert.equal(document.querySelectorAll('.rack-range-selected').length, 0, reason);
            shelf.setShelfAdding(false); appState.rackMounts = []; rack.renderRackView();
        }
        assert.equal(appState.rackShelves.length, 1);
        assert.deepEqual(buildResourceSave(), { devices: [], views: [] });
    });
    await t.test('棚板のクリックとダブルクリックは詳細・設定を分け、閲覧者と追加モードでは編集しない', async () => {
        rack.renderRackView();
        const block = document.querySelector('.rack-shelf');
        await block.dispatch('click', { detail: 1 });
        assert.ok(panelNow());
        await block.dispatch('click', { detail: 2 });
        await block.dispatch('dblclick');
        assert.ok(dom.get('rack-shelf-name'));
        await closeDialog();
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
        assert.equal([...document.querySelector('.rack-mount-device-area').children].some(node => node.classList.contains('rack-transfer-card')), false);
        const deviceAreaChildren = document.querySelector('.rack-mount-device-area').children;
        assert.ok(deviceAreaChildren[0].textContent.includes('機器を棚板に追加'));
        assert.ok(deviceAreaChildren[1].textContent.includes('棚板の搭載機器'));
        const form = document.querySelector('.rack-mount-form');
        dom.get('rack-shelf-view').value = '8'; dom.get('rack-shelf-start').value = '4';
        dom.get('rack-shelf-name').value = '移設後の棚'; dom.get('rack-shelf-depth').value = 'half';
        await form.dispatch('change');
        assert.equal(dom.get('rack-shelf-view').value, '8');
        assert.equal(dom.get('rack-shelf-start').value, '4');
        assert.equal(dom.get('rack-shelf-depth').value, 'half');
        await form.dispatch('submit');
        assert.equal(document.querySelector('.rack-mount-position-area').querySelector('.rack-transfer-confirmation').hidden, false);
        assert.deepEqual(appState.rackShelves, before);
        await button(document.querySelector('.rack-mount-actions'), 'キャンセル').dispatch('click');
        assert.equal(document.querySelector('.rack-mount-position-area').querySelector('.rack-transfer-confirmation').hidden, true);
        await form.dispatch('submit'); appState.views[1].resource_revision++;
        await form.dispatch('submit');
        assert.deepEqual(appState.rackShelves, before); assert.deepEqual(appState.rackShelfDevices, members);
        await closeDialog();
        shelf.openShelfDialog({ viewId: 1, shelfId: -1 });
        dom.get('rack-shelf-start').value = '3'; await document.querySelector('.rack-mount-form').dispatch('input');
        await document.querySelector('.rack-mount-form').dispatch('submit'); await settle();
        assert.equal(appState.rackShelves[0].start_u, 3);
        assert.deepEqual(appState.rackShelfDevices, members);
        await closeDialog();
        shelf.openShelfDialog({ viewId: 1, shelfId: -1 });
        dom.get('rack-shelf-view').value = '8'; await document.querySelector('.rack-mount-form').dispatch('change');
        await document.querySelector('.rack-mount-form').dispatch('submit');
        await document.querySelector('.rack-mount-form').dispatch('submit'); await settle();
        assert.equal(appState.rackShelves[0].view_id, 8);
        assert.deepEqual(appState.rackShelfDevices, members);
        if (document.querySelector('.rack-mount-actions')) await closeDialog();
        appState.rackShelves = before; appState.views.pop(); appState.rackSettings.pop(); resetResourceBaseline(appState);
        shelf.openShelfDialog({ viewId: 1, startU: 4 });
        assert.equal([...document.querySelector('.rack-mount-device-area').children].some(node => node.classList.contains('rack-transfer-card')), false);
        dom.get('rack-shelf-name').value = '追加棚';
        await document.querySelector('.rack-mount-form').dispatch('submit'); await settle();
        assert.ok(appState.rackShelves.some(row => row.name === '追加棚' && row.start_u === 4));
        await closeDialog();
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
    await t.test('既存機器は検索入力後に候補を出し、型番検索から追加してモーダルを維持し連続追加できる', async () => {
        appState.devices[1].model = 'SMALL-200'; resetResourceBaseline(appState);
        await button(panelNow(), '＋ 機器を追加').dispatch('click');
        const search = dom.get('rack-shelf-device-search');
        assert.ok(addOverlay()); assert.equal(addOverlay().textContent.includes('機器2'), false);
        search.value = 'SMALL-200'; await search.dispatch('input');
        const candidate = addOverlay().querySelector('#rack-shelf-device-candidates').querySelector('button');
        assert.ok(candidate);
        await candidate.dispatch('click');
        await addForm().dispatch('submit'); await settle();
        assert.ok(addOverlay());
        assert.deepEqual(shelf.shelfMembers(-1).map(row => row.device_id), [2]);
        assert.ok(addOverlay().querySelector('.rack-shelf-summary-list').textContent.includes('機器2'));
        assert.ok(panelNow().textContent.includes('機器2'));
        assert.equal(search.value, '');
        search.value = 'SMALL-200'; await search.dispatch('input');
        assert.ok(addOverlay().querySelector('#rack-shelf-device-candidates').textContent.includes('該当する機器がありません'));
        await closeDialog();
    });
    await t.test('直付けから棚板は元先カードを確認し、取消・revision変更では移設しない', async () => {
        appState.rackMounts = [{ device_id: 1, view_id: 1, face: 'rear', start_u: 5, height_u: 1, width_slot: 'full', depth: 'half' }];
        resetResourceBaseline(appState);
        await button(panelNow(), '＋ 機器を追加').dispatch('click');
        const search = dom.get('rack-shelf-device-search'); search.value = '機器1'; await search.dispatch('input');
        await addOverlay().querySelector('#rack-shelf-device-candidates').querySelector('button').dispatch('click');
        await addForm().dispatch('submit');
        let confirmation = addOverlay().querySelector('.rack-mount-device-area').querySelector('.rack-transfer-confirmation');
        assert.equal(confirmation.hidden, false); assert.equal(confirmation.textContent.includes('別ラック'), false);
        assert.ok(confirmation.textContent.includes('移設元')); assert.equal(appState.rackMounts[0].device_id, 1);
        await button(addOverlay(), 'キャンセル').dispatch('click');
        assert.equal(confirmation.hidden, true); assert.equal(appState.rackShelfDevices.some(row => row.device_id === 1), false);
        await addForm().dispatch('submit');
        appState.views[0].resource_revision += 1;
        await addForm().dispatch('submit');
        assert.equal(appState.rackMounts[0].device_id, 1);
        assert.equal(appState.rackShelfDevices.some(row => row.device_id === 1), false);
        await closeDialog();
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
            await addOverlay().querySelector('#rack-shelf-device-candidates').querySelector('button').dispatch('click');
            const before = structuredClone(appState.rackShelfDevices);
            await addForm().dispatch('submit');
            assert.equal(addOverlay().querySelector('.rack-mount-device-area').querySelector('.rack-transfer-confirmation').hidden, false);
            assert.deepEqual(appState.rackShelfDevices, before);
            await addForm().dispatch('submit'); await settle();
            assert.deepEqual(appState.rackShelfDevices.filter(row => row.device_id === 2).map(row => row.shelf_id), [target]);
            assert.equal(appState.rackMounts.some(row => row.device_id === 2), false);
            await closeDialog();
        }
    });
    await t.test('新規登録はIP空欄で棚板に所属し、モーダルを維持して詳細を更新する', async () => {
        resetResourceBaseline(appState);
        await button(panelNow(), '＋ 機器を追加').dispatch('click');
        await button(addOverlay(), '新しい機器を登録').dispatch('click');
        dom.get('rack-shelf-device-name').value = '新規ONU';
        dom.get('rack-shelf-device-ip').value = '不正なIP';
        await addForm().dispatch('submit');
        assert.equal(appState.devices.some(row => row.name === '新規ONU'), false);
        dom.get('rack-shelf-device-ip').value = '';
        await addForm().dispatch('submit'); await settle();
        assert.ok(addOverlay());
        const registered = appState.devices.find(row => row.name === '新規ONU');
        assert.ok(registered); assert.equal(registered.ip, '');
        const member = shelf.shelfMembers(-1).find(row => row.device_id === registered.id);
        assert.ok(member);
        assert.ok(addOverlay().querySelector('.rack-shelf-summary-list').textContent.includes('新規ONU'));
        assert.ok(panelNow().textContent.includes('新規ONU'));
        await closeDialog();
    });
    await t.test('競合発生時は機器追加モーダルを閉じ、所属を変更しない', async () => {
        await button(panelNow(), '＋ 機器を追加').dispatch('click');
        const before = structuredClone(appState.rackShelfDevices);
        appState.resourceConflicts.views.set(1, {}); eventBus.emit('save-state:changed');
        assert.equal(addOverlay(), null); assert.deepEqual(appState.rackShelfDevices, before);
        appState.resourceConflicts.views.clear();
    });
    await t.test('新規棚板作成は保存確定後に活性化し、複数機器の連続追加ができる', async () => {
        shelf.openShelfDialog({ viewId: 1, startU: 1 });
        assert.ok(addOverlay());
        const saveBtn = addOverlay().querySelector('.rack-shelf-save-btn');
        assert.ok(saveBtn);
        assert.equal(saveBtn.textContent, '棚板を作成');
        assert.equal(saveBtn.isConnected, true);
        assert.ok(document.querySelector('.rack-mount-device-area').classList.contains('is-disabled'));
        assert.equal(dom.get('rack-shelf-device-search').disabled, true);
        dom.get('rack-shelf-name').value = '連続追加棚';
        await saveBtn.dispatch('click'); await settle();
        assert.ok(addOverlay());
        assert.equal(document.querySelector('.rack-mount-device-area').classList.contains('is-disabled'), false);
        assert.equal(dom.get('rack-shelf-device-search').disabled, false);
        const createdShelf = appState.rackShelves.find(row => row.name === '連続追加棚');
        assert.ok(createdShelf);
        const saveName = async name => {
            dom.get('rack-shelf-name').value = name;
            await addForm().dispatch('input');
            assert.ok(addOverlay().querySelectorAll('.rack-shelf-member-remove-btn').every(node => node.disabled));
            await saveBtn.dispatch('click'); await settle();
            assert.equal(dom.get('rack-shelf-error').textContent, '');
            assert.equal(appState.rackShelves.find(row => row.id === createdShelf.id).name, name);
            assert.equal(saveBtn.disabled, false);
        };

        // 1台目を既存機器から追加
        const search = dom.get('rack-shelf-device-search');
        search.value = '機器1'; await search.dispatch('input');
        const candidate = addOverlay().querySelector('#rack-shelf-device-candidates').querySelector('button');
        assert.ok(candidate);
        await candidate.dispatch('click');
        await addForm().dispatch('submit');
        assert.equal(addOverlay().querySelector('.rack-mount-device-area').querySelector('.rack-transfer-confirmation').hidden, false);
        await addForm().dispatch('submit'); await settle();
        assert.ok(addOverlay());
        assert.equal(shelf.shelfMembers(createdShelf.id).length, 1);
        assert.ok(addOverlay().querySelector('.rack-shelf-summary-list').textContent.includes('機器1'));
        await saveName('連続追加棚・既存追加後');
        assert.equal(shelf.shelfMembers(createdShelf.id).length, 1);

        // 2台目を新規機器から追加
        await button(addOverlay(), '新しい機器を登録').dispatch('click');
        dom.get('rack-shelf-device-name').value = '棚上AP';
        dom.get('rack-shelf-device-ip').value = '';
        await addForm().dispatch('submit'); await settle();
        assert.ok(addOverlay());
        assert.equal(shelf.shelfMembers(createdShelf.id).length, 2);
        assert.ok(addOverlay().querySelector('.rack-shelf-summary-list').textContent.includes('棚上AP'));
        assert.ok(addOverlay().querySelector('.rack-shelf-count').textContent.includes('2台'));
        await saveName('連続追加棚・新規追加後');
        assert.equal(shelf.shelfMembers(createdShelf.id).length, 2);

        // モーダル内の簡易一覧から機器を取り外し（×ボタン）できることを確認
        const removeButtons = addOverlay().querySelectorAll('.rack-shelf-member-remove-btn');
        assert.equal(removeButtons.length, 2);
        window.confirm = () => true;
        await removeButtons[1].dispatch('click'); await settle();
        assert.equal(shelf.shelfMembers(createdShelf.id).length, 1);
        assert.equal(addOverlay().querySelectorAll('.rack-shelf-member-remove-btn').length, 1);
        assert.equal(addOverlay().querySelector('.rack-shelf-summary-list').textContent.includes('棚上AP'), false);
        await saveName('連続追加棚');
        assert.equal(shelf.shelfMembers(createdShelf.id).length, 1);
        await closeDialog();
    });
    await t.test('機器追加の保存待ちに別棚板が変わっても古い設定を保存しない', async () => {
        const target = appState.rackShelves.find(row => row.name === '連続追加棚');
        const other = appState.rackShelves.find(row => row.id !== target.id);
        const otherName = other.name;
        const device = appState.devices.find(row => row.name === '棚上AP');
        const originalFetch = globalThis.fetch;
        let release;
        const waiting = new Promise(resolve => { release = resolve; });
        let started;
        const requestStarted = new Promise(resolve => { started = resolve; });
        try {
            shelf.openShelfDialog({ viewId: 1, shelfId: target.id });
            const search = dom.get('rack-shelf-device-search');
            search.value = device.name; await search.dispatch('input');
            await addOverlay().querySelector('#rack-shelf-device-candidates').querySelector('button').dispatch('click');
            globalThis.fetch = async (...args) => {
                const response = await originalFetch(...args);
                started();
                await waiting;
                return response;
            };
            await addForm().dispatch('submit');
            await requestStarted;
            other.name = '別操作による棚板変更';
            release(); await settle();
            assert.ok(shelf.shelfMembers(target.id).some(row => row.device_id === device.id));
            assert.equal(appState.rackShelves.find(row => row.id === other.id).name, '別操作による棚板変更');
            dom.get('rack-shelf-name').value = '保存を拒否する設定';
            await addForm().dispatch('input');
            await addOverlay().querySelector('.rack-shelf-save-btn').dispatch('click');
            assert.equal(appState.rackShelves.find(row => row.id === target.id).name, '連続追加棚');
            assert.match(dom.get('rack-shelf-error').textContent, /ラックまたは保存状態が変わりました/);
        } finally {
            release();
            globalThis.fetch = originalFetch;
            await closeDialog();
            appState.rackShelves.find(row => row.id === other.id).name = otherName;
            shelf.removeShelfDevice(device.id);
            await settle();
        }
    });
    await t.test('ラック図の棚板ブロックは種別アイコン最大8台＋残数と総台数を表示する', async () => {
        rack.renderRackView();
        const blocks = document.querySelectorAll('.rack-shelf');
        const populatedBlock = [...blocks].find(b => b.textContent.includes('連続追加棚') || b.textContent.includes('1台'));
        assert.ok(populatedBlock);
        assert.ok(populatedBlock.querySelector('.rack-shelf-count'));
        assert.equal(populatedBlock.querySelector('.rack-shelf-count').textContent, '1台');
        const icons = populatedBlock.querySelector('.rack-shelf-device-icons');
        assert.ok(icons);
        assert.equal(icons.querySelectorAll('.rack-shelf-device-icon').length, 1);

        // 9台所属させて最大8アイコン表示と残数表示（+1）を確認
        const createdShelf = appState.rackShelves.find(row => row.name === '連続追加棚');
        for (let i = 201; i <= 208; i++) {
            appState.devices.push(normalizeDevice({ id: i, name: `追加機器${i}`, type: 'router' }));
            appState.rackShelfDevices.push({ device_id: i, shelf_id: createdShelf.id, sort_order: i - 200 });
        }
        rack.renderRackView();
        const nineBlock = [...document.querySelectorAll('.rack-shelf')].find(b => b.dataset.shelfId === String(createdShelf.id));
        assert.equal(nineBlock.querySelector('.rack-shelf-device-icons').querySelectorAll('.rack-shelf-device-icon').length, 8);
        assert.ok(nineBlock.querySelector('.rack-shelf-device-more'));
        assert.equal(nineBlock.querySelector('.rack-shelf-device-more').textContent, '+1');
        assert.equal(nineBlock.querySelector('.rack-shelf-count').textContent, '9台');
    });
    appState.resourceConflicts.views.set(1, {}); assert.equal(shelf.removeShelfDevice(1), false); assert.equal(shelf.reorderShelfDevice(1, 1), false);
    appState.resourceConflicts.views.clear(); appState.appStatus.state = 'unconfirmed'; assert.equal(shelf.assignDeviceToShelf(1, -1), false);
    appState.appStatus.state = 'saved'; window.APP_CONFIG.user.isAdmin = false; assert.equal(shelf.removeShelfDevice(1), false);
    shelf.closeShelfPanel();
});
