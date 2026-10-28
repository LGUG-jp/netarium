import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installWorkspaceDom } from './helpers/workspace-dom.mjs';

test('別ラック移設は表示条件を確認してから両ラックを保存する', async t => {
    const keys = ['window', 'document', 'Element', 'HTMLElement', 'fetch', 'requestAnimationFrame', 'cancelAnimationFrame'];
    const originals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const dom = installWorkspaceDom({ templates: ['templates/components/canvas.php', 'templates/components/canvas_context_toolbar.php'] });
    const create = document.createElement;
    document.createElement = tag => {
        const node = create(tag);
        node.style.setProperty = (key, value) => { node.style[key] = value; };
        return node;
    };
    globalThis.requestAnimationFrame = callback => setTimeout(callback, 0);
    globalThis.cancelAnimationFrame = clearTimeout;
    const { appState, normalizeView, normalizeDevice } = await import('../public/js/core/state.js');
    const resource = await import('../public/js/core/resource-save.js');
    const queue = await import('../public/js/core/save-queue.js');
    const rack = await import('../public/js/canvas/rack-view.js');
    const { requestModalClose } = await import('../public/js/core/modal-focus.js');
    const initial = { device_id: 1, view_id: 1, face: 'rear', start_u: 2, height_u: 2, width_slot: 'right' };
    const shelf = { id: 1, view_id: 1, name: '管理棚', face: 'front', start_u: 2, height_u: 2, depth: 'half' };
    const memberships = [{ shelf_id: 1, device_id: 1, sort_order: 0 }, { shelf_id: 1, device_id: 2, sort_order: 1 }];
    let writes = [];
    globalThis.fetch = async (_url, options) => {
        writes.push(JSON.parse(options.body));
        return new Response(JSON.stringify({ ok: true, revision: 2, id_maps: {}, devices: [],
            views: appState.views.map(view => ({ ...view, resource_revision: view.resource_revision + 1 })),
            placements: [], links: [], canvas_notes: [], rack_settings: appState.rackSettings,
            rack_mounts: appState.rackMounts, rack_shelves: appState.rackShelves, rack_shelf_devices: appState.rackShelfDevices,
            affected_view_ids: writes.at(-1).views.map(view => view.id), deleted_device_ids: [], deleted_view_ids: []
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const form = () => document.querySelector('.rack-mount-form');
    const submit = () => form().querySelector('button[type="submit"]');
    const cancel = () => form().querySelectorAll('button').find(node => node.textContent === 'キャンセル').dispatch('click');
    const change = async (name, value) => { const field = dom.get(`rack-mount-${name}`); field.value = value; await field.dispatch('input'); };
    const reset = ({ fromShelf = false } = {}) => {
        Object.assign(appState, {
            views: [1, 2].map(id => normalizeView({ id, name: `ラック${id}`, view_type: 'rack', resource_revision: id * 10 })),
            devices: [1, 2].map(id => normalizeDevice({ id, name: `機器${id}`, type: 'server', resource_revision: id })),
            rackSettings: [1, 2].map(view_id => ({ view_id, total_u: 42, location: '' })),
            rackMounts: fromShelf ? [] : [{ ...initial }],
            rackShelves: fromShelf ? [{ ...shelf }] : [], rackShelfDevices: fromShelf ? structuredClone(memberships) : [],
            placements: [], links: [], canvasNotes: [], floorPlans: [], deviceImages: [],
            currentViewId: 1, canvas: dom.get('canvas'), world: dom.get('world'), selectedPlacementIds: new Set(),
            resourceConflicts: { devices: new Map(), views: new Map() }, authExpired: false, isSaving: false,
            appStatus: { dirty: false, state: 'saved' }, editingDeviceId: null
        });
        window.APP_CONFIG.user.isAdmin = true;
        writes = []; resource.resetResourceBaseline(appState);
        rack.openRackMountDialog({ viewId: 1, deviceId: 1 });
    };
    const beginTransfer = async () => {
        await change('view', '2'); await change('start', '8');
        await form().dispatch('submit');
        assert.equal(submit().textContent, '移設を確定');
        assert.deepEqual(appState.rackMounts, [initial]);
        assert.equal(writes.length, 0);
    };
    const beginShelfTransfer = async () => {
        reset({ fromShelf: true });
        await change('start', '8');
        await form().dispatch('submit');
        assert.equal(submit().textContent, '移設を確定');
        assert.deepEqual(appState.rackMounts, []);
        assert.deepEqual(appState.rackShelfDevices, memberships);
        assert.equal(writes.length, 0);
    };
    t.after(async () => {
        queue.clearPendingSave();
        await new Promise(resolve => setTimeout(resolve, 0));
        for (const [key, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
        }
    });
    await t.test('元先の面・U範囲・各面から見た幅を表示し取消とEscapeで保存しない', async () => {
        reset(); await beginTransfer();
        const confirmation = form().querySelector('.rack-transfer-confirmation');
        const text = confirmation.textContent;
        assert.ok(text.includes('機器1'));
        assert.ok(text.includes('移設元'));
        assert.ok(text.includes('移設先'));
        assert.ok(text.includes('ラック1'));
        assert.ok(text.includes('ラック2'));
        assert.ok(text.includes('2〜3U'));
        assert.ok(text.includes('8〜9U'));
        assert.ok(text.includes('元の所属は解除されます'));
        assert.ok(confirmation.querySelector('.rack-transfer-flow'));
        assert.equal(confirmation.querySelector('.rack-transfer-arrow').textContent, '→');
        assert.ok(confirmation.querySelector('.rack-transfer-notice'));
        await cancel();
        assert.equal(submit().textContent, 'ラックへ移設');
        await form().dispatch('submit');
        requestModalClose();
        assert.equal(submit().textContent, 'ラックへ移設');
        assert.deepEqual(appState.rackMounts, [initial]);
        assert.equal(writes.length, 0);
        await cancel();
    });
    for (const [label, mutate] of [
        ['元revision', () => { appState.views[0].resource_revision++; }],
        ['先revision', () => { appState.views[1].resource_revision++; }],
        ['元位置', () => { appState.rackMounts[0].start_u = 4; }],
        ['先位置', () => change('start', '10')],
        ['機器変更', () => { appState.devices[0].resource_revision++; }],
        ['選択解除', () => change('search', '機器2')],
        ['権限', () => { window.APP_CONFIG.user.isAdmin = false; }],
        ['元競合', () => { appState.resourceConflicts.views.set(1, {}); }],
        ['先競合', () => { appState.resourceConflicts.views.set(2, {}); }],
        ['認証失効', () => { appState.authExpired = true; }]
    ]) {
        await t.test(`確認中の${label}変更では古い条件を確定しない`, async () => {
            reset(); await beginTransfer(); await mutate();
            const before = structuredClone(appState.rackMounts);
            await form().dispatch('submit');
            assert.deepEqual(appState.rackMounts, before);
            assert.equal(writes.length, 0);
            assert.equal(form().querySelector('.rack-mount-body').hidden, false);
            assert.equal(form().querySelector('.rack-transfer-confirmation').hidden, true);
            await cancel();
        });
    }
    await t.test('確定時だけ既存保存経路で元先を一括更新する', async () => {
        reset(); await beginTransfer(); await form().dispatch('submit');
        assert.equal(await queue.flushSaveQueue({ silent: true }), true);
        assert.deepEqual(appState.rackMounts.map(row => [row.device_id, row.view_id, row.face, row.start_u, row.height_u, row.width_slot]),
            [[1, 2, 'rear', 8, 2, 'right']]);
        assert.equal(writes.length, 1);
        assert.deepEqual(writes[0].views.map(view => view.id).sort(), [1, 2]);
        assert.equal(form(), null);
    });
    await t.test('同ラック内移動には追加確認しない', async () => {
        reset(); await change('start', '6'); await form().dispatch('submit');
        assert.equal(await queue.flushSaveQueue({ silent: true }), true);
        assert.deepEqual(appState.rackMounts.map(row => [row.device_id, row.view_id, row.face, row.start_u, row.height_u, row.width_slot]),
            [[1, 1, 'rear', 6, 2, 'right']]);
        assert.equal(form(), null);
    });
    await t.test('棚板から同じラックへの直付けも元所属と移設先を確認し取消とEscapeで保存しない', async () => {
        await beginShelfTransfer();
        const confirmation = form().querySelector('.rack-transfer-confirmation');
        assert.equal(confirmation.hidden, false);
        assert.ok(confirmation.textContent.includes('機器1'));
        assert.ok(confirmation.textContent.includes('移設しますか？'));
        assert.equal(confirmation.textContent.includes('別ラック'), false);
        assert.ok(confirmation.querySelector('.rack-transfer-from').textContent.includes('管理棚'));
        assert.ok(confirmation.querySelector('.rack-transfer-from').textContent.includes('2〜3U'));
        assert.ok(confirmation.querySelector('.rack-transfer-to').textContent.includes('8〜8U'));
        assert.ok(confirmation.textContent.includes('元の所属は解除されます'));
        await cancel();
        assert.equal(confirmation.hidden, true);
        assert.equal(form().querySelector('.rack-mount-body').hidden, false);
        assert.equal(dom.get('rack-mount-start').value, '8');
        await form().dispatch('submit');
        requestModalClose();
        assert.equal(confirmation.hidden, true);
        assert.deepEqual(appState.rackShelfDevices, memberships);
        assert.deepEqual(appState.rackShelves, [shelf]);
        assert.deepEqual(appState.rackMounts, []);
        assert.equal(writes.length, 0);
        await cancel();
    });
    for (const [label, mutate] of [
        ['棚板名', () => { appState.rackShelves[0].name = '変更後の棚'; }],
        ['棚板位置', () => { appState.rackShelves[0].start_u = 4; }],
        ['所属', () => { appState.rackShelfDevices[0].sort_order = 2; }],
        ['revision', () => { appState.views[0].resource_revision++; }],
        ['競合', () => { appState.resourceConflicts.views.set(1, {}); }],
        ['保存中', () => { appState.isSaving = true; }],
        ['未確認', () => { appState.appStatus.state = 'unconfirmed'; }],
        ['現在のビュー', () => { appState.currentViewId = 2; }]
    ]) {
        await t.test(`棚板から同ラック直付けの確認中に${label}が変わると保存しない`, async () => {
            await beginShelfTransfer();
            await mutate();
            const before = structuredClone({ mounts: appState.rackMounts, shelves: appState.rackShelves, members: appState.rackShelfDevices });
            await form().dispatch('submit');
            assert.deepEqual({ mounts: appState.rackMounts, shelves: appState.rackShelves, members: appState.rackShelfDevices }, before);
            assert.equal(writes.length, 0);
            assert.equal(form().querySelector('.rack-transfer-confirmation').hidden, true);
            assert.equal(form().querySelector('.rack-mount-body').hidden, false);
            await cancel();
        });
    }
    await t.test('棚板から同ラック直付けの確定だけが対象所属を解除して既存キューで保存する', async () => {
        await beginShelfTransfer();
        await form().dispatch('submit');
        assert.equal(await queue.flushSaveQueue({ silent: true }), true);
        assert.deepEqual(appState.rackMounts, [{ device_id: 1, view_id: 1, face: 'front', start_u: 8, height_u: 1, width_slot: 'full', depth: 'half' }]);
        assert.deepEqual(appState.rackShelves, [shelf]);
        assert.deepEqual(appState.rackShelfDevices, [memberships[1]]);
        assert.equal(writes.length, 1);
        assert.deepEqual(writes[0].views.map(view => view.id), [1]);
        assert.deepEqual(writes[0].views[0].rack_shelf_devices, [memberships[1]]);
        assert.deepEqual(writes[0].views[0].rack_mounts, appState.rackMounts);
        assert.equal(form(), null);
    });
});
