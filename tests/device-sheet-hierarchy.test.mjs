import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { installWorkspaceDom } from './helpers/workspace-dom.mjs';

test('個票の旧設置情報と階層管理への往復は所属・入力・権限を保護する', async t => {
    const keys = ['window', 'document', 'Element', 'HTMLElement', 'fetch', 'localStorage', 'confirm'];
    const originals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const dom = installWorkspaceDom({ templates: ['templates/modals/ledger.php', 'templates/modals/view_manager.php',
        'templates/modals/placement_manager.php', 'templates/components/property_panel.php', 'templates/components/toast.php'] });
    globalThis.localStorage = { getItem: () => null, setItem() {} };
    const { appState, normalizeDevice, normalizeView } = await import('../public/js/core/state.js');
    const ledger = await import('../public/js/modals/ledger-modal.js');
    const manager = await import('../public/js/modals/view-manager-modal.js');
    const placementManager = await import('../public/js/modals/placement-modal.js');
    const drafts = await import('../public/js/core/device-drafts.js');
    const queue = await import('../public/js/core/save-queue.js');
    const { resetResourceBaseline } = await import('../public/js/core/resource-save.js');
    const { getTopModalContainer } = await import('../public/js/core/modal-focus.js');
    const originalState = { ...appState };
    let requests = [], failSave = false;
    const settle = async () => { await setImmediate(); await setImmediate(); };
    const field = name => dom.get('ledger-sheet-body').querySelector(`[data-field="${name}"]`);
    const legacy = () => dom.get('ledger-sheet-legacy-location');
    const manage = () => dom.get('ledger-sheet-hierarchy-manage-btn');
    globalThis.fetch = async (url, options) => {
        const payload = JSON.parse(options.body);
        requests.push(payload);
        if (String(url).includes('save_resources')) {
            if (failSave) return new Response(JSON.stringify({ ok: false, error: '保存失敗' }), { status: 422 });
            return new Response(JSON.stringify({ ok: true, revision: appState.dataRevision + 1, id_maps: {},
                devices: payload.devices.map(row => ({ ...row.device, resource_revision: 2 })),
                views: payload.views.map(row => ({ ...row.view, resource_revision: 2 })),
                placements: payload.views.flatMap(row => row.placements), view_link_routes: [], canvas_notes: [],
                affected_view_ids: payload.views.map(row => row.view.id), deleted_device_ids: [], deleted_view_ids: [] }));
        }
        assert.equal(payload.operation, 'create_floor');
        return new Response(JSON.stringify({ ok: true, revision: appState.dataRevision + 1,
            buildings: appState.buildings, floors: [...appState.floors, { ...payload, id: 12 }], views: appState.views,
            devices: appState.devices, placements: [], links: [], canvas_notes: [], rack_settings: [], rack_mounts: [],
            rack_shelves: [], rack_shelf_devices: [], floor_rack_placements: [], floor_plans: [], device_images: [],
            link_systems: [], address_spaces: [], ip_segments: [], monitor_revision: 0 }));
    };
    const reset = async (values = {}, admin = true, deviceIds = [1]) => {
        drafts.discardDeviceDrafts(); queue.clearPendingSave();
        if (!dom.get('view-manager-overlay').hidden) await manager.closeViewManager();
        await ledger.closeLedgerDetailPane();
        window.APP_CONFIG.user.isAdmin = admin;
        Object.assign(appState, {
            devices: deviceIds.map(id => normalizeDevice({ id, name: id === 1 ? '機器' : `機器${id}`, type: 'pc', resource_revision: 1, ...values })),
            views: [normalizeView({ id: 1, name: '論理ビュー', view_type: 'topology', resource_revision: 1 })],
            buildings: [{ id: 5, name: '本館' }], floors: [{ id: 11, building_id: 5, name: '1F' }],
            placements: [], links: [], canvasNotes: [], rackSettings: [], rackMounts: [], rackShelves: [],
            rackShelfDevices: [], floorRackPlacements: [], floorPlans: [], deviceImages: [],
            currentViewId: 1, selectedPlacementIds: new Set(), resourceConflicts: { devices: new Map(), views: new Map() },
            appStatus: { dirty: false, state: 'saved' }, authExpired: false, isPinging: false, isSaving: false,
            viewManagerFormDirty: false, dataRevision: 1
        });
        requests = []; failSave = false; resetResourceBaseline(appState);
        await ledger.openLedgerDetail(1);
    };
    const decide = async choice => {
        await settle();
        assert.equal(dom.get('unsaved-changes-overlay').hidden, false);
        await dom.get(`unsaved-changes-${choice}`).click();
    };
    t.after(async () => {
        drafts.discardDeviceDrafts(); queue.clearPendingSave();
        if (!dom.get('view-manager-overlay').hidden) await manager.closeViewManager();
        await ledger.closeLedgerDetailPane(); await settle();
        Object.assign(appState, originalState); resetResourceBaseline(appState);
        for (const [key, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
        }
    });
    await t.test('配置解除を開いた個票の一覧に反映し、別フロアを推奨しない', async () => {
        await reset({ floor_id: 11 });
        appState.floors.push({ id: 12, building_id: 5, name: '2F' });
        appState.views[0].floor_id = 11;
        appState.views.push(normalizeView({ id: 2, name: '別フロア図', floor_id: 12, view_type: 'floor', resource_revision: 1 }));
        appState.placements = [
            { id: 1, device_id: 1, view_id: 1, x: 20, y: 30 },
            { id: 2, device_id: 1, view_id: 2, x: 20, y: 30 }
        ];
        resetResourceBaseline(appState);
        ledger.renderLedgerDeviceSheet(appState.devices[0]);
        const pills = () => dom.get('ledger-sheet-body').querySelectorAll('.ledger-sheet-view-pill').map(node => node.textContent);
        assert.deepEqual(pills(), ['本館 / 1F / 論理ビュー', '本館 / 2F / 別フロア図']);
        const nameInput = field('name');
        assert.equal(dom.get('ledger-overlay').hidden, true);
        await ledger.manageActiveDevicePlacements();
        const options = document.querySelectorAll('.placement-manager-option');
        const sameFloor = options.find(option => option.children[0].value === '1');
        const otherFloor = options.find(option => option.children[0].value === '2');
        assert.equal(sameFloor.querySelector('.placement-manager-option-badge')?.textContent, '推奨');
        assert.equal(otherFloor.querySelector('.placement-manager-option-badge'), null);
        const checkbox = otherFloor.children[0];
        assert.equal(checkbox.checked, true);
        checkbox.checked = false;
        await checkbox.dispatch('change');
        globalThis.confirm = () => true;
        assert.equal(await placementManager.applyPlacementManager(), true);
        assert.deepEqual(pills(), ['本館 / 1F / 論理ビュー']);
        assert.equal(field('name'), nameInput);
        assert.equal(getTopModalContainer(), dom.get('ledger-device-sheet-overlay'));
        assert.equal(dom.get('panel').hidden, true, '個票からの配置変更で通常キャンバスの機器詳細を開かない');
        assert.equal(await queue.flushSaveQueue({ silent: true }), true);
    });
    await t.test('初回の台帳未表示でもモデル順に前後移動し、先頭・末尾・1件の境界を守る', async () => {
        await reset({}, true, [3, 1, 2]);
        assert.equal(dom.get('ledger-overlay').hidden, true);
        assert.equal(dom.get('ledger-table-body').children.length, 0);
        assert.equal(dom.get('ledger-sheet-prev-btn').disabled, false);
        assert.equal(dom.get('ledger-sheet-next-btn').disabled, false);
        assert.equal(await window.navigateLedgerDevice(-1), true);
        assert.equal(ledger.activeLedgerDeviceId, 3);
        assert.equal(dom.get('ledger-sheet-prev-btn').disabled, true);
        assert.equal(await window.navigateLedgerDevice(-1), false);
        assert.equal(await window.navigateLedgerDevice(1), true);
        assert.equal(await window.navigateLedgerDevice(1), true);
        assert.equal(ledger.activeLedgerDeviceId, 2);
        assert.equal(dom.get('ledger-sheet-next-btn').disabled, true);
        assert.equal(await window.navigateLedgerDevice(1), false);
        assert.equal(dom.get('ledger-table-body').children.length, 0, '移動のために台帳行を生成しない');
        await reset();
        assert.equal(dom.get('ledger-sheet-prev-btn').disabled, true);
        assert.equal(dom.get('ledger-sheet-next-btn').disabled, true);
    });
    await t.test('台帳未表示の前後移動でも未適用確認を維持する', async () => {
        await reset({}, true, [1, 2]);
        field('name').value = '直接表示の入力'; await field('name').dispatch('input');
        let moving = window.navigateLedgerDevice(1);
        await decide('cancel'); await moving;
        assert.equal(ledger.activeLedgerDeviceId, 1);
        assert.equal(field('name').value, '直接表示の入力');
        moving = window.navigateLedgerDevice(1);
        await decide('discard'); await moving;
        assert.equal(ledger.activeLedgerDeviceId, 2);
        assert.equal(appState.devices[0].name, '機器');
        assert.deepEqual(requests, []);
    });
    await t.test('台帳表示中は検索・フィルタ結果のモデル順で移動する', async () => {
        await reset({}, true, [3, 1, 2]);
        appState.devices[0].type = 'switch';
        ledger.openLedger();
        const types = dom.get('ledger-type-filter');
        for (const option of types.options) option.selected = option.value === 'pc';
        ledger.renderLedgerTable();
        await ledger.openLedgerDetail(1);
        assert.equal(dom.get('ledger-sheet-prev-btn').disabled, true);
        assert.equal(await window.navigateLedgerDevice(1), true);
        assert.equal(ledger.activeLedgerDeviceId, 2);
        assert.equal(dom.get('ledger-sheet-next-btn').disabled, true);
        dom.get('ledger-search').value = '機器2';
        await ledger.openLedgerDetail(2);
        assert.equal(dom.get('ledger-sheet-prev-btn').disabled, true);
        assert.equal(dom.get('ledger-sheet-next-btn').disabled, true);
        dom.get('ledger-search').value = '';
        await ledger.closeLedger();
    });
    for (const [facility, floor, floorId, visible] of [
        ['本庁舎', '3F', null, true], ['本庁舎', '', null, true], ['', '3F', null, true],
        ['', '', null, false], ['本庁舎', '3F', 11, false], ['<img src=x>', '<script>old</script>', null, true]
    ]) {
        await t.test(`旧情報の表示条件: ${JSON.stringify([facility, floor, floorId])}`, async () => {
            await reset({ facility, floor, floor_id: floorId });
            assert.equal(legacy().hidden, !visible);
            if (visible) {
                assert.ok(legacy().textContent.includes('現在の所属ではありません'));
                assert.equal(legacy().querySelector('p').textContent, [facility ? `旧施設：${facility}` : '', floor ? `旧フロア：${floor}` : ''].filter(Boolean).join(' / '));
                assert.equal(legacy().querySelector('input, select, textarea, img, script'), null);
            }
            assert.ok(manage());
            const floorControl = field('floor_id');
            assert.equal(manage().parentElement, floorControl.parentElement, '管理リンクは設置フロアの直下');
            assert.ok(floorControl.parentElement.children.indexOf(manage()) > floorControl.parentElement.children.indexOf(floorControl));
            assert.equal(legacy().parentElement.parentElement, floorControl.parentElement.parentElement.parentElement, '補足は同じ2列グリッドの右列');
            assert.equal(dom.get('ledger-sheet-view-manage-btn').textContent.trim(), '表示ビュー管理');
            assert.equal(dom.get('panel').querySelector('#ledger-sheet-legacy-location'), null);
            assert.equal(dom.get('ledger-table-body').querySelector('#ledger-sheet-legacy-location'), null);
            assert.deepEqual(requests, []);
        });
    }
    await t.test('所属の変更・解除で補足が切り替わり、旧原文は保存後も不変', async () => {
        await reset({ facility: ' 旧施設 ', floor: ' 旧階 ' });
        field('floor_id').value = '11'; await field('floor_id').dispatch('change');
        assert.equal(legacy().hidden, true);
        assert.equal(await ledger.saveLedgerSheet(), true);
        assert.equal(appState.devices[0].floor_id, 11);
        assert.equal(requests.at(-1).devices[0].device.facility, ' 旧施設 ');
        assert.equal(requests.at(-1).devices[0].device.floor, ' 旧階 ');
        field('floor_id').value = ''; await field('floor_id').dispatch('change');
        assert.equal(legacy().hidden, false);
        assert.equal(appState.devices[0].facility, ' 旧施設 ');
        assert.equal(appState.devices[0].floor, ' 旧階 ');
    });
    for (const choice of ['cancel', 'discard', 'save']) {
        await t.test(`未適用入力の確認: ${choice}`, async () => {
            await reset();
            field('name').value = '未適用の名称'; await field('name').dispatch('input');
            const opening = manage().click();
            await decide(choice); await opening; await settle();
            assert.equal(dom.get('view-manager-overlay').hidden, choice === 'cancel');
            assert.equal(dom.get('ledger-device-sheet-overlay').hidden, false);
            assert.equal(field('name').value, choice === 'discard' ? '機器' : '未適用の名称');
            assert.equal(appState.devices[0].name, choice === 'save' ? '未適用の名称' : '機器');
            assert.equal(requests.length, choice === 'save' ? 1 : 0);
        });
    }
    await t.test('保存失敗は個票に留まり、入力を保持する', async () => {
        await reset(); failSave = true;
        field('name').value = '保存待ち'; await field('name').dispatch('input');
        const opening = manage().click(); await decide('save'); await opening;
        assert.equal(dom.get('view-manager-overlay').hidden, true);
        assert.equal(field('name').value, '保存待ち');
        assert.equal(manage().disabled, false);
    });
    await t.test('閲覧者には管理導線を出さず、権限失効後の既存ボタンも管理画面を開かない', async () => {
        await reset({ facility: '本庁舎' }, false);
        assert.equal(manage(), null); assert.equal(legacy().hidden, false);
        await reset(); window.APP_CONFIG.user.isAdmin = false;
        await manage().click();
        assert.equal(dom.get('view-manager-overlay').hidden, true);
        assert.deepEqual(requests, []);
    });
    await t.test('既存管理画面で追加したフロアが個票へ同期し、戻りのフォーカスと編集を維持する', async () => {
        await reset({ facility: '旧施設' });
        await manage().click(); await settle();
        assert.equal(getTopModalContainer(), dom.get('view-manager-overlay'));
        const building = dom.get('view-manager-list').querySelectorAll('button').find(button => button.dataset.nodeKey === 'building:5');
        await building.click();
        await dom.get('hierarchy-add-floor-btn').onclick();
        dom.get('hierarchy-name').value = '新フロア'; await dom.get('hierarchy-name').dispatch('input');
        await dom.get('building-hierarchy-form').dispatch('submit'); await settle();
        await manager.closeViewManager(); await settle();
        assert.equal(getTopModalContainer(), dom.get('ledger-device-sheet-overlay'));
        assert.equal(document.activeElement, manage());
        assert.equal(field('floor_id').options.find(option => option.value === '12').textContent, '本館 / 新フロア');
        field('floor_id').value = '12'; await field('floor_id').dispatch('change');
        assert.equal(legacy().hidden, true);
        assert.equal(drafts.getDeviceDraft('sheet', 1).floor_id, 12);
        assert.equal(appState.devices[0].floor_id, null);
        assert.equal(appState.devices[0].facility, '旧施設');
    });
});
