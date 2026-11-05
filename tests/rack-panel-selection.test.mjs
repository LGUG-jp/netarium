import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { installWorkspaceDom } from './helpers/workspace-dom.mjs';

test('ラックの機器切替は未適用入力の確認後に編集対象と選択を変更する', async t => {
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
    let requests = [];
    globalThis.fetch = async (_url, options) => {
        const payload = JSON.parse(options.body);
        requests.push(payload);
        return new Response(JSON.stringify({
            ok: true, revision: 2, id_maps: {},
            devices: payload.devices.map(operation => ({ ...operation.device, resource_revision: 20 })),
            views: [], placements: [], links: [], canvas_notes: [],
            affected_view_ids: [], deleted_device_ids: [], deleted_view_ids: []
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    t.after(async () => {
        queue.clearPendingSave();
        drafts.discardDeviceDrafts();
        await setImmediate();
        for (const [key, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    });

    function reset() {
        queue.clearPendingSave();
        drafts.discardDeviceDrafts();
        appState.editingDeviceId = null;
        panels.closePanel();
        requests = [];
        Object.assign(appState, {
            views: [normalizeView({ id: 1, name: '試験ラック', view_type: 'rack', resource_revision: 10 })],
            devices: [1, 2].map(id => normalizeDevice({ id, name: `機器${id}`, type: 'pc', ip: '', resource_revision: id })),
            placements: [], links: [], canvasNotes: [], floorPlans: [], deviceImages: [], floorRackPlacements: [],
            rackSettings: [{ view_id: 1, total_u: 6, location: '' }],
            rackMounts: [1, 2].map(id => ({ device_id: id, view_id: 1, face: 'front',
                start_u: id, height_u: 1, width_slot: 'full', depth: 'half' })),
            rackShelves: [], rackShelfDevices: [], currentViewId: 1,
            canvas: dom.get('canvas'), world: dom.get('world'), deviceLayer: dom.get('device-layer'), currentSvg: dom.get('link-layer'),
            selectedPlacementIds: new Set(), resourceConflicts: { devices: new Map(), views: new Map() },
            appStatus: { dirty: false, state: 'saved' }, isSaving: false, isPinging: false, authExpired: false
        });
        resource.resetResourceBaseline(appState);
        rack.renderRackView();
    }
    const block = id => dom.get('rack-view').querySelectorAll('.rack-device')
        .find(node => Number(node.dataset.deviceId) === id);
    const click = id => block(id).dispatch('click');
    function assertSelected(id) {
        assert.equal(appState.editingDeviceId, id);
        for (const other of [1, 2]) {
            assert.equal(block(other).getAttribute('aria-pressed'), String(other === id));
        }
    }

    await t.test('未適用入力がなければ選んだ機器の値を表示し保存しない', async () => {
        reset();
        await click(1);
        await click(2);
        assertSelected(2);
        assert.equal(dom.get('p-name').value, '機器2');
        assert.equal(dom.get('unsaved-changes-overlay'), null);
        assert.equal(requests.length, 0);
    });

    for (const [choice, label] of [['cancel', '編集を続ける'], ['discard', '変更を取り消す'], ['save', '適用']]) {
        await t.test(`機器1の未適用入力で「${label}」を選んでも機器2へ誤保存しない`, async () => {
            reset();
            await click(1);
            dom.get('p-name').value = '機器1の編集内容';
            await dom.events.dispatch('input', { target: dom.get('p-name') });
            assert.equal(panels.hasUnappliedPanelChanges(), true);
            const switching = click(2);
            try {
                await setImmediate();
                assert.ok(dom.get('unsaved-changes-overlay'), '機器切替の前に未適用入力を確認する');
                assertSelected(1);
                assert.equal(dom.get('p-name').value, '機器1の編集内容');
                assert.deepEqual(resource.buildResourceSave(), { devices: [], views: [] });
                await dom.get(`unsaved-changes-${choice}`).dispatch('click');
                await switching;
                await queue.flushSaveQueue({ silent: true });

                if (choice === 'cancel') {
                    assertSelected(1);
                    assert.equal(dom.get('p-name').value, '機器1の編集内容');
                    assert.equal(panels.hasUnappliedPanelChanges(), true);
                    assert.equal(requests.length, 0);
                    assert.equal(panels.applyPanel(), true, '編集継続後も元の機器へ適用できる');
                    await queue.flushSaveQueue({ silent: true });
                } else {
                    assertSelected(2);
                    assert.equal(dom.get('p-name').value, '機器2');
                    assert.equal(panels.hasUnappliedPanelChanges(), false);
                }

                assert.equal(appState.devices.find(row => row.id === 2).name, '機器2');
                const expected = choice === 'discard' ? '機器1' : '機器1の編集内容';
                assert.equal(appState.devices.find(row => row.id === 1).name, expected);
                if (choice === 'discard') {
                    assert.equal(requests.length, 0);
                    assert.deepEqual(resource.buildResourceSave(), { devices: [], views: [] });
                } else {
                    assert.equal(requests.length, 1);
                    assert.deepEqual(requests[0].devices.map(operation => ({ id: operation.id, name: operation.device.name })),
                        [{ id: 1, name: '機器1の編集内容' }]);
                    assert.deepEqual(requests[0].views, []);
                }
            } finally {
                await dom.get('unsaved-changes-cancel')?.dispatch('click');
                await switching;
                await queue.flushSaveQueue({ silent: true });
            }
        });
    }
});
