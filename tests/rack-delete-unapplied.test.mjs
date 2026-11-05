import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { installWorkspaceDom } from './helpers/workspace-dom.mjs';

test('ラックのDelete取り外しは未適用入力の確認と保存を先に解決する', async t => {
    const keys = ['window', 'document', 'Element', 'HTMLElement', 'fetch', 'requestAnimationFrame', 'cancelAnimationFrame'];
    const originals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const dom = installWorkspaceDom({ templates: [
        'templates/components/canvas.php', 'templates/components/canvas_context_toolbar.php',
        'templates/components/property_panel.php'
    ] });
    const create = document.createElement;
    document.createElement = tag => {
        const node = create(tag);
        node.style.setProperty = (key, value) => { node.style[key] = value; };
        return node;
    };
    globalThis.requestAnimationFrame = callback => setTimeout(callback, 0);
    globalThis.cancelAnimationFrame = clearTimeout;
    const { appState, normalizeView, normalizeDevice } = await import('../public/js/core/state.js');
    const rack = await import('../public/js/canvas/rack-view.js');
    const panels = await import('../public/js/ui/property-panel.js');
    const drafts = await import('../public/js/core/device-drafts.js');
    const queue = await import('../public/js/core/save-queue.js');
    const resource = await import('../public/js/core/resource-save.js');
    const { onKeyDown } = await import('../public/js/canvas/selection.js');
    let requests, revision;
    const response = payload => new Response(JSON.stringify({
        ok: true, revision: ++revision, id_maps: {},
        devices: payload.devices.map(row => ({ ...row.device, resource_revision: revision + 20 })),
        views: payload.views.map(row => ({ ...row.view, resource_revision: revision + 30 })),
        placements: payload.views.flatMap(row => row.placements || []),
        links: payload.views.flatMap(row => row.links || []),
        canvas_notes: payload.views.flatMap(row => row.canvas_notes || []),
        rack_settings: payload.views.flatMap(row => row.rack_settings ? [row.rack_settings] : []),
        rack_mounts: payload.views.flatMap(row => row.rack_mounts || []),
        rack_shelves: payload.views.flatMap(row => row.rack_shelves || []),
        rack_shelf_devices: payload.views.flatMap(row => row.rack_shelf_devices || []),
        affected_view_ids: payload.views.map(row => row.id), deleted_device_ids: [], deleted_view_ids: []
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const save = async (_url, options) => {
        const payload = JSON.parse(options.body);
        requests.push(payload);
        return response(payload);
    };
    t.after(async () => {
        queue.clearPendingSave(); drafts.discardDeviceDrafts();
        await setImmediate();
        for (const [key, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    });
    function reset(shelf) {
        queue.clearPendingSave(); drafts.discardDeviceDrafts();
        appState.editingDeviceId = null; panels.closePanel();
        requests = []; revision = 1; globalThis.fetch = save;
        window.APP_CONFIG.user.isAdmin = true; window.confirm = () => true;
        Object.assign(appState, {
            views: [normalizeView({ id: 1, name: '試験ラック', view_type: 'rack', resource_revision: 10 }),
                normalizeView({ id: 2, name: '他ビュー', resource_revision: 11 })],
            devices: [1, 2].map(id => normalizeDevice({ id, name: `機器${id}`, type: 'pc', ip: '', resource_revision: id })),
            placements: [{ id: 1, device_id: 1, view_id: 2, x: 10, y: 20 }],
            links: [], canvasNotes: [], floorPlans: [], deviceImages: [], floorRackPlacements: [],
            rackSettings: [{ view_id: 1, total_u: 6, location: '' }],
            rackMounts: [1, 2].filter(id => !shelf || id !== 1).map(id => ({ device_id: id, view_id: 1,
                face: 'front', start_u: id, height_u: 1, width_slot: 'full', depth: 'half' })),
            rackShelves: shelf ? [{ id: 1, view_id: 1, name: '棚板', face: 'front', start_u: 4, height_u: 1, depth: 'half' }] : [],
            rackShelfDevices: shelf ? [{ device_id: 1, shelf_id: 1, sort_order: 0 }] : [],
            currentViewId: 1, editingLinkId: null,
            canvas: dom.get('canvas'), world: dom.get('world'), deviceLayer: dom.get('device-layer'), currentSvg: dom.get('link-layer'),
            selectedPlacementIds: new Set(), resourceConflicts: { devices: new Map(), views: new Map() },
            appStatus: { dirty: false, state: 'saved' }, isSaving: false, isPinging: false, authExpired: false
        });
        resource.resetResourceBaseline(appState); rack.renderRackView();
    }
    const block = id => dom.get('rack-view').querySelectorAll('[data-device-id]')
        .find(node => Number(node.dataset.deviceId) === id && node.tagName === 'BUTTON') ||
        (id === 1 && appState.rackShelfDevices.length ? dom.get('rack-view').querySelector('[data-shelf-id="1"]') : null);
    async function select() {
        await block(1).dispatch('click');
        if (appState.rackShelfDevices.length) await document.querySelector('.rack-shelf-member-open').dispatch('click');
    }
    const mounted = () => appState.rackMounts.some(row => row.device_id === 1) ||
        appState.rackShelfDevices.some(row => row.device_id === 1);
    async function edit(value = '機器1の編集内容') {
        await select();
        dom.get('p-name').value = value;
        await dom.events.dispatch('input', { target: dom.get('p-name') });
    }
    function remove() {
        const target = block(1); target.focus();
        return onKeyDown({ key: 'Delete', isComposing: false, target, preventDefault() {}, stopImmediatePropagation() {} });
    }
    function assertRetained() {
        assert.equal(mounted(), true);
        assert.equal(appState.devices.length, 2, '機器台帳を保持する');
        assert.equal(appState.placements.length, 1, '他ビューの配置を保持する');
    }
    for (const shelf of [false, true]) {
        const location = shelf ? '棚板' : '直付け';
        for (const [choice, label] of [['cancel', '編集を続ける'], ['discard', '変更を取り消す'], ['save', '適用']]) {
            await t.test(`${location}：「${label}」を解決するまで取り外し・保存しない`, async () => {
                reset(shelf); await edit();
                let release;
                if (choice === 'save') globalThis.fetch = async (_url, options) => {
                    const payload = JSON.parse(options.body); requests.push(payload);
                    if (requests.length === 1) return new Promise(resolve => { release = () => resolve(response(payload)); });
                    return response(payload);
                };
                const removing = remove();
                try {
                    await setImmediate();
                    assert.ok(dom.get('unsaved-changes-overlay'));
                    assertRetained();
                    assert.equal(requests.length, 0, '未適用確認より先に取り外しを送信しない');
                    assert.equal(appState.editingDeviceId, 1);
                    await dom.get(`unsaved-changes-${choice}`).dispatch('click');
                    if (choice === 'save') {
                        await setImmediate();
                        assertRetained();
                        assert.equal(requests.length, 1);
                        assert.equal(requests[0].devices[0].device.name, '機器1の編集内容');
                        assert.deepEqual(requests[0].views, [], '入力の保存完了までは取り外さない');
                        release(); release = null;
                    }
                    await removing;
                    assert.equal(await queue.flushSaveQueue({ silent: true }), true);
                    if (choice === 'cancel') {
                        assertRetained();
                        assert.equal(appState.editingDeviceId, 1);
                        assert.equal(dom.get('panel').hidden, false);
                        assert.equal(dom.get('p-name').value, '機器1の編集内容');
                        assert.equal(requests.length, 0);
                        assert.equal(panels.applyPanel(), true, '編集継続後も対象機器へ適用できる');
                        await queue.flushSaveQueue({ silent: true });
                        assert.equal(appState.devices[0].name, '機器1の編集内容');
                    } else {
                        assert.equal(mounted(), false);
                        assert.equal(appState.editingDeviceId, null);
                        assert.equal(dom.get('panel').hidden, true);
                        assert.equal(appState.devices[0].name, choice === 'save' ? '機器1の編集内容' : '機器1');
                        assert.equal(requests.length, choice === 'save' ? 2 : 1);
                        const saved = requests.at(-1).views[0];
                        assert.equal(saved.rack_mounts.some(row => row.device_id === 1), false);
                        assert.equal(saved.rack_shelf_devices.some(row => row.device_id === 1), false);
                        assert.equal(appState.devices.length, 2);
                        assert.equal(appState.placements.length, 1);
                        assert.equal(appState.rackMounts.some(row => row.device_id === 2), true);
                        if (shelf) assert.equal(appState.rackShelves.length, 1, '棚板自体は削除しない');
                    }
                } finally {
                    await dom.get('unsaved-changes-cancel')?.dispatch('click');
                    release?.(); await removing; await queue.flushSaveQueue({ silent: true });
                }
            });
        }
        await t.test(`${location}：取り外し確認の取消は入力を保持し、未編集なら確認後に取り外せる`, async () => {
            reset(shelf); await edit(); window.confirm = () => false;
            await remove(); assertRetained();
            assert.equal(appState.editingDeviceId, 1);
            assert.equal(dom.get('p-name').value, '機器1の編集内容');
            assert.equal(requests.length, 0);
            assert.equal(dom.get('unsaved-changes-overlay'), null);
            drafts.discardDeviceDrafts(); appState.editingDeviceId = null; panels.closePanel();
            await select(); window.confirm = () => true;
            await remove(); await queue.flushSaveQueue({ silent: true });
            assert.equal(mounted(), false);
            assert.equal(appState.editingDeviceId, null);
            assert.equal(requests.length, 1);
        });
        await t.test(`${location}：不正な入力は「適用」しても取り外さず、修正して適用できる`, async () => {
            reset(shelf); await edit(''); const removing = remove();
            try {
                await setImmediate(); await dom.get('unsaved-changes-save').dispatch('click'); await removing;
                assertRetained(); assert.equal(requests.length, 0);
                assert.equal(appState.editingDeviceId, 1);
                assert.equal(dom.get('panel').hidden, false);
                dom.get('p-name').value = '修正済み機器1';
                await dom.events.dispatch('input', { target: dom.get('p-name') });
                assert.equal(panels.applyPanel(), true);
                await queue.flushSaveQueue({ silent: true });
            } finally {
                await dom.get('unsaved-changes-cancel')?.dispatch('click'); await removing;
                await queue.flushSaveQueue({ silent: true });
            }
        });
        for (const status of [400, 409]) {
            await t.test(`${location}：適用の保存が${status}なら取り外しを送らない`, async () => {
                reset(shelf);
                // 409後に別機器だけ保存成功しても、対象機器の競合は解決していない。
                if (status === 409) appState.devices[1].name = '機器2の確定済み編集';
                globalThis.fetch = async (_url, options) => {
                    const payload = JSON.parse(options.body); requests.push(payload);
                    if (requests.length > 1) return response(payload);
                    return new Response(JSON.stringify({ ok: false, error: '合成保存エラー',
                        details: { conflicts: [{ kind: 'devices', id: 1, reason: 'revision_mismatch' }] }
                    }), { status, headers: { 'Content-Type': 'application/json' } });
                };
                await edit(); const removing = remove();
                try {
                    await setImmediate(); await dom.get('unsaved-changes-save').dispatch('click'); await removing;
                    assertRetained();
                    assert.equal(requests.length, status === 409 ? 2 : 1);
                    assert.ok(requests.every(payload => payload.views.length === 0));
                    if (status === 409) {
                        assert.equal(queue.hasResourceConflict('devices', 1), true);
                        assert.deepEqual(requests[1].devices.map(row => row.id), [2]);
                    }
                } finally {
                    await dom.get('unsaved-changes-cancel')?.dispatch('click'); await removing;
                }
            });
        }
        for (const change of ['selection', 'view']) {
            await t.test(`${location}：適用の保存待機中に${change === 'selection' ? '別機器を選ぶ' : 'ビューを変える'}と取り外しを中断する`, async () => {
                reset(shelf); await edit(); let release;
                globalThis.fetch = async (_url, options) => {
                    const payload = JSON.parse(options.body); requests.push(payload);
                    return new Promise(resolve => { release = () => resolve(response(payload)); });
                };
                const removing = remove();
                try {
                    await setImmediate(); await dom.get('unsaved-changes-save').dispatch('click'); await setImmediate();
                    assert.equal(requests.length, 1); assertRetained();
                    if (change === 'selection') await block(2).dispatch('click');
                    else appState.currentViewId = 2;
                    release(); release = null; await removing;
                    assertRetained(); assert.equal(requests.length, 1);
                    if (change === 'selection') {
                        assert.equal(appState.editingDeviceId, 2);
                        assert.equal(dom.get('p-name').value, '機器2');
                    }
                } finally {
                    await dom.get('unsaved-changes-cancel')?.dispatch('click');
                    release?.(); await removing; await queue.flushSaveQueue({ silent: true });
                }
            });
        }
    }
});
