import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { installWorkspaceDom } from './helpers/workspace-dom.mjs';

test('個票の配置タグは入力確認の取消で個票を保持し、ビュー切替成立後だけ閉じる', async t => {
    const keys = ['window', 'document', 'fetch', 'localStorage', 'Element', 'HTMLElement', 'HTMLInputElement'];
    const originals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const dom = installWorkspaceDom({ templates: ['templates/modals/ledger.php', 'templates/modals/view_manager.php', 'templates/components/property_panel.php', 'templates/components/canvas.php', 'templates/components/canvas_context_toolbar.php'] });
    globalThis.localStorage = window.localStorage = { getItem: () => null, setItem() {} };
    const { appState, normalizeDevice, normalizeView } = await import('../public/js/core/state.js');
    const resource = await import('../public/js/core/resource-save.js');
    const ledger = await import('../public/js/modals/ledger-modal.js');
    const panel = await import('../public/js/ui/property-panel.js');
    const queue = await import('../public/js/core/save-queue.js');
    t.after(async () => {
        queue.clearPendingSave();
        await setImmediate();
        for (const [key, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
        }
    });
    Object.assign(appState, {
        devices: [1, 2].map(id => normalizeDevice({ id, name: `機器${id}`, type: 'switch', resource_revision: 1 })),
        views: [1, 2].map(id => normalizeView({ id, name: `ビュー${id}`, view_type: 'topology', resource_revision: 1 })),
        placements: [{ id: 1, device_id: 2, view_id: 1, x: 0, y: 0 }, { id: 2, device_id: 1, view_id: 2, x: 200, y: 100 }],
        currentViewId: 1, rackMounts: [], rackSettings: [], rackShelves: [], rackShelfMembers: [],
        links: [], canvasNotes: [], deviceImages: [], floorPlans: [],
        canvas: dom.get('canvas'), deviceLayer: null, currentSvg: null, floorPlanLayer: null,
        selectedPlacementIds: new Set(), resourceConflicts: { devices: new Map(), views: new Map() },
        appStatus: { dirty: false, state: 'saved' }, authExpired: false, isSaving: false, isPinging: false,
        editingDeviceId: null, editingLinkId: null
    });
    resource.resetResourceBaseline(appState);
    globalThis.fetch = () => { throw new Error('取消・破棄だけで保存しない'); };
    await panel.openPanel(appState.devices[1]);
    dom.get('p-name').value = '背後の未適用入力';
    await ledger.openLedgerDetail(1);
    const choose = async choice => {
        const pending = dom.get('ledger-sheet-body').querySelector('.ledger-sheet-view-pill').dispatch('click');
        await setImmediate();
        const button = dom.get(`unsaved-changes-${choice}`);
        assert.ok(button);
        await button.dispatch('click');
        await pending;
    };
    await choose('cancel');
    assert.equal(appState.currentViewId, 1);
    assert.equal(dom.get('ledger-device-sheet-overlay').hidden, false);
    assert.equal(dom.get('p-name').value, '背後の未適用入力');
    assert.deepEqual([...appState.selectedPlacementIds], []);
    await choose('discard');
    assert.equal(appState.currentViewId, 2);
    assert.equal(dom.get('ledger-device-sheet-overlay').hidden, true);
    assert.equal(appState.editingDeviceId, 1);
    assert.deepEqual([...appState.selectedPlacementIds], [2]);
    assert.equal(appState.devices[1].name, '機器2');
});
