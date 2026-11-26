import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installWorkspaceDom } from './helpers/workspace-dom.mjs';

test('別画面で新設したフロアへの移動を競合再読込し、名称変更で所属を消さない', async t => {
    const keys = ['window', 'document', 'Element', 'HTMLElement', 'fetch', 'confirm', 'localStorage'];
    const originals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const dom = installWorkspaceDom({ templates: ['templates/modals/view_manager.php', 'templates/components/toast.php'] });
    globalThis.localStorage = { getItem: () => null, setItem() {} };
    globalThis.confirm = window.confirm = () => true;
    const { appState, normalizeView } = await import('../public/js/core/state.js');
    const previous = { ...appState };
    const { resetResourceBaseline } = await import('../public/js/core/resource-save.js');
    const queue = await import('../public/js/core/save-queue.js');
    const manager = await import('../public/js/modals/view-manager-modal.js');
    Object.assign(appState, {
        views: [normalizeView({ id: 1, name: '元の配置図', view_type: 'floor', floor_id: 10, resource_revision: 1 })],
        buildings: [{ id: 5, name: '元の棟', sort_order: 0 }], floors: [{ id: 10, building_id: 5, name: '1F', sort_order: 0 }],
        devices: [], placements: [], links: [], canvasNotes: [], rackSettings: [], rackMounts: [], rackShelves: [], rackShelfDevices: [],
        floorRackPlacements: [], floorPlans: [], deviceImages: [], currentViewId: 1, authExpired: false,
        isPinging: false, isSaving: false, dataRevision: 1, appStatus: { dirty: false, state: 'saved' },
        resourceConflicts: { devices: new Map(), views: new Map() }
    });
    queue.clearPendingSave(); resetResourceBaseline(appState);
    const remote = {
        ok: true, revision: 2, views: [normalizeView({ id: 1, name: '移動後の配置図', view_type: 'floor', floor_id: 20, resource_revision: 2 })],
        buildings: [...appState.buildings, { id: 9, name: '新しい棟', sort_order: 10 }],
        floors: [...appState.floors, { id: 20, building_id: 9, name: 'B2', sort_order: 10 }],
        devices: [], placements: [], links: [], canvas_notes: [], floor_plans: [], rack_settings: [], rack_mounts: [], rack_shelves: [],
        rack_shelf_devices: [], floor_rack_placements: []
    };
    let saved;
    globalThis.fetch = async (url, options = {}) => {
        if (options.method !== 'POST') return new Response(JSON.stringify(remote));
        saved = JSON.parse(options.body);
        return new Response(JSON.stringify({ ok: true, revision: 3, id_maps: {},
            devices: [], views: saved.views.map(row => ({ ...row.view, resource_revision: 3 })),
            placements: [], view_link_routes: [], canvas_notes: [], rack_settings: [], rack_mounts: [], rack_shelves: [], rack_shelf_devices: [],
            affected_view_ids: [1], deleted_view_ids: [], deleted_device_ids: [], buildings: remote.buildings, floors: remote.floors }));
    };
    t.after(async () => {
        await manager.closeViewManager(); queue.clearPendingSave(); Object.assign(appState, previous); resetResourceBaseline(appState);
        for (const [key, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
        }
    });
    manager.openViewManager();
    appState.resourceConflicts.views.set(1, { kind: 'views', id: 1, name: '元の配置図' });
    assert.equal(await manager.reloadSelectedViewConflict(), true);
    assert.equal(dom.get('vm-floor-id').value, '20');
    assert.equal(dom.get('vm-floor-id').options.some(option => option.value === '20' && option.textContent === '新しい棟 / B2'), true);
    dom.get('vm-name').value = '名称だけ変更'; manager.updateViewManagerFormState();
    assert.equal(await manager.applyViewForm(), true);
    assert.equal(saved.views[0].expected_revision, 2);
    assert.equal(saved.views[0].view.floor_id, 20);
    assert.equal(appState.views[0].floor_id, 20);
});
