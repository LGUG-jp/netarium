import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { installWorkspaceDom } from './helpers/workspace-dom.mjs';

test('表示ビューの配置解除は関連する詳細入力だけを事前確認する (#340)', async t => {
    const keys = ['window', 'document', 'Element', 'HTMLElement', 'fetch', 'confirm'];
    const originals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const dom = installWorkspaceDom({ templates: [
        'templates/components/property_panel.php', 'templates/components/link_panel.php',
        'templates/modals/placement_manager.php'
    ] });
    const ledgerOverlay = dom.add('div', 'ledger-overlay');
    const { appState, normalizeDevice, normalizeView, normalizeLink } = await import('../public/js/core/state.js');
    const panels = await import('../public/js/ui/property-panel.js');
    const manager = await import('../public/js/modals/placement-modal.js');
    const ledger = await import('../public/js/modals/ledger-modal.js');
    const queue = await import('../public/js/core/save-queue.js');
    const drafts = await import('../public/js/core/device-drafts.js');
    const resource = await import('../public/js/core/resource-save.js');
    const { registerModalClose } = await import('../public/js/core/modal-focus.js');
    let requests = [];
    let confirmations = [];
    globalThis.confirm = message => window.confirm(message);
    globalThis.fetch = async (_url, options) => {
        const payload = JSON.parse(options.body);
        requests.push(payload);
        return new Response(JSON.stringify({
            ok: true, revision: 2, id_maps: {
                devices: Object.fromEntries(payload.devices.map(row => [row.id, row.id])),
                views: Object.fromEntries(payload.views.map(row => [row.id, row.id])),
                placements: Object.fromEntries(payload.views.flatMap(row => row.placements.map(item => [item.id, item.id]))),
                links: Object.fromEntries(payload.views.flatMap(row => row.links.map(item => [item.id, item.id])))
            },
            devices: payload.devices.map(row => ({ ...row.device, resource_revision: 2 })),
            views: payload.views.map(row => ({ ...row.view, resource_revision: 2 })),
            placements: payload.views.flatMap(row => row.placements),
            links: payload.views.flatMap(row => row.links), canvas_notes: [],
            deleted_device_ids: [], deleted_view_ids: [], affected_view_ids: payload.views.map(row => row.id)
        }));
    };
    t.after(async () => {
        await dom.get('unsaved-changes-cancel')?.dispatch('click');
        queue.clearPendingSave();
        drafts.discardDeviceDrafts();
        for (const id of ['placement_manager', 'unsaved-changes']) registerModalClose(id, { restoreFocus: false });
        await setImmediate();
        for (const [key, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    });

    function reset() {
        queue.clearPendingSave();
        drafts.discardDeviceDrafts();
        appState.editingDeviceId = appState.editingLinkId = null;
        panels.closePanel(); panels.closeLinkPanel();
        registerModalClose('placement_manager', { restoreFocus: false });
        dom.get('placement-manager-overlay').hidden = true;
        ledgerOverlay.replaceChildren(); ledgerOverlay.hidden = false;
        Object.assign(appState, {
            devices: [1, 2, 3].map(id => normalizeDevice({ id, name: `試験機器${id}`, type: 'pc', resource_revision: 1 })),
            views: [10, 11, 12].map(id => normalizeView({ id, name: `試験ビュー${id}`, view_type: 'topology', resource_revision: 1 })),
            placements: [
                { id: 30, device_id: 1, view_id: 10, x: 0, y: 0 },
                { id: 31, device_id: 2, view_id: 10, x: 200, y: 0 },
                { id: 32, device_id: 3, view_id: 10, x: 400, y: 0 },
                { id: 33, device_id: 1, view_id: 11, x: 0, y: 0 },
                { id: 34, device_id: 3, view_id: 11, x: 200, y: 0 }
            ],
            links: [normalizeLink({ id: 20, view_id: 10, from_id: 1, to_id: 2, label: '試験配線', from_port: 'P1', to_port: 'P2' }),
                normalizeLink({ id: 21, view_id: 11, from_id: 1, to_id: 3 })],
            currentViewId: 10, currentSvg: null, deviceLayer: null, floorPlanLayer: null,
            canvas: null, linkSystems: [], canvasNotes: [], floorPlans: [], deviceImages: [], rackMounts: [],
            selectedPlacementIds: new Set([30, 31, 32]),
            resourceConflicts: { devices: new Map(), views: new Map() },
            appStatus: { dirty: false, state: 'saved', lastError: null },
            isSaving: false, isPinging: false, authExpired: false, dataRevision: 1
        });
        resource.resetResourceBaseline(appState);
        requests = []; confirmations = [];
        window.confirm = message => { confirmations.push(message); return true; };
    }
    async function edit(kind) {
        if (kind === 'link') {
            assert.equal(await panels.openLinkPanel(appState.links[0]), true);
            for (const [id, value] of [['lp-label', '入力中のラベル'], ['lp-from-port', '入力中P1'],
                ['lp-to-port', '入力中P2'], ['lp-memo', '入力中の配線備考']]) {
                dom.get(id).value = value;
                await dom.events.dispatch('input', { target: dom.get(id) });
            }
        } else {
            assert.equal(await panels.openPanel(appState.devices[0]), true);
            for (const [id, value] of [['p-name', '入力中の機器名'], ['p-memo', '入力中の機器備考']]) {
                dom.get(id).value = value;
                await dom.events.dispatch('input', { target: dom.get(id) });
            }
        }
    }
    function assertDraft(kind) {
        if (kind === 'link') {
            assert.equal(appState.editingLinkId, 20);
            assert.equal(dom.get('link-panel').hidden, false);
            assert.equal(dom.get('lp-memo').value, '入力中の配線備考');
            assert.equal(panels.hasUnappliedLinkPanelChanges(), true);
        } else {
            assert.equal(appState.editingDeviceId, 1);
            assert.equal(dom.get('panel').hidden, false);
            assert.equal(dom.get('p-memo').value, '入力中の機器備考');
            assert.equal(panels.hasUnappliedPanelChanges(), true);
        }
    }
    async function prepareRemoval(deviceId, viewId = 10, { addView = false } = {}) {
        // 台帳の「表示ビュー」の実clickと、配置先checkboxの実changeを通す。
        const cell = ledger.createLedgerPlacementActionCell(appState.devices.find(row => row.id === deviceId));
        ledgerOverlay.appendChild(cell);
        await cell.querySelector('[data-ledger-action="placement"]').dispatch('click');
        const options = dom.get('placement-manager-list').querySelectorAll('input');
        const checkbox = options.find(node => Number(node.value) === viewId);
        assert.equal(checkbox.checked, true);
        checkbox.checked = false;
        await checkbox.dispatch('change');
        if (addView) {
            const added = options.find(node => Number(node.value) === 12);
            added.checked = true;
            await added.dispatch('change');
        }
    }
    const stateSnapshot = () => structuredClone({ devices: appState.devices, placements: appState.placements, links: appState.links });
    const assertUnchanged = before => {
        assert.deepEqual(stateSnapshot(), before);
        assert.deepEqual(resource.buildResourceSave(), { devices: [], views: [] });
        assert.equal(requests.length, 0);
        assert.equal(dom.get('placement-manager-overlay').hidden, false);
        assert.deepEqual([...appState.selectedPlacementIds], [30, 31, 32]);
    };

    await t.test('ラックのチェックは搭載実態を示し、補助操作だけが位置指定へ進む', async () => {
        reset();
        appState.views.push(...[20, 21].map(id => normalizeView({ id, name: `ラック${id}`, view_type: 'rack' })));
        appState.rackMounts = [{ device_id: 1, view_id: 20, face: 'front', start_u: 3, height_u: 2, width_slot: 'full' }];
        const { eventBus } = await import('../public/js/core/event-bus.js');
        const opened = [];
        const off = eventBus.on('rack:mount-device', payload => opened.push(payload));
        try {
            manager.openPlacementManager(1);
            const row = id => dom.get('placement-manager-list').querySelectorAll('.placement-manager-rack-option')
                .find(node => Number(node.querySelector('input').value) === id);
            assert.equal(row(20).querySelector('input').checked, true);
            assert.equal(row(21).querySelector('input').checked, false);
            assert.equal(row(20).querySelector('input').disabled, true);
            await row(21).dispatch('click');
            assert.deepEqual(opened, []);
            assert.deepEqual(manager.getPlacementManagerChanges(), { addedViewIds: [], removedViewIds: [] });
            await row(21).querySelector('button').dispatch('click');
            assert.deepEqual(opened, [{ viewId: 21, deviceId: 1 }]);
            assert.equal(appState.rackMounts[0].view_id, 20);
            assert.equal(requests.length, 0);
            appState.rackMounts = [];
            appState.rackShelves = [{ id: 7, view_id: 21, name: '管理棚', face: 'front', start_u: 6, height_u: 1 }];
            appState.rackShelfDevices = [{ shelf_id: 7, device_id: 1, sort_order: 0 }];
            manager.openPlacementManager(1);
            assert.equal(row(20).querySelector('input').checked, false);
            assert.equal(row(21).querySelector('input').checked, true);
            await manager.closePlacementManager();
        } finally {
            off();
            appState.rackShelves = []; appState.rackShelfDevices = [];
        }
    });

    for (const kind of ['link', 'device']) {
        await t.test(`${kind}の適用保存が400なら配置と配線を削除しない`, async () => {
            reset(); await edit(kind); await prepareRemoval(1, 10, { addView: true });
            const before = stateSnapshot();
            const successFetch = globalThis.fetch;
            globalThis.fetch = async (_url, options) => {
                requests.push(JSON.parse(options.body));
                return new Response(JSON.stringify({ ok: false, error: '保存拒否' }), { status: 400 });
            };
            const applying = manager.applyPlacementManager();
            try {
                await setImmediate();
                await dom.get('unsaved-changes-save').dispatch('click');
                assert.equal(await applying, false);
                assert.deepEqual(appState.placements, before.placements);
                assert.deepEqual(appState.links.map(row => row.id), before.links.map(row => row.id));
                assert.equal(dom.get('placement-manager-overlay').hidden, false);
                assert.ok(requests.length > 0);
                for (const view of requests.flatMap(row => row.views).filter(row => row.id === 10)) {
                    assert.ok(view.placements.some(row => row.device_id === 1));
                    assert.ok(view.links.some(row => row.id === 20));
                }
            } finally {
                globalThis.fetch = successFetch;
                queue.clearPendingSave();
            }
        });

        await t.test(`無関係な機器Cの現在ビュー配置を解除しても${kind}の未適用入力を保持する`, async () => {
            reset(); await edit(kind); await prepareRemoval(3);
            assert.equal(await manager.applyPlacementManager(), true);
            await queue.flushSaveQueue({ silent: true });
            assertDraft(kind);
            assert.equal(dom.get('unsaved-changes-overlay'), null);
            assert.equal(dom.get('placement-manager-overlay').hidden, true);
            assert.deepEqual([...appState.selectedPlacementIds], [30, 31]);
            const saved = requests.at(-1).views.find(row => row.id === 10);
            assert.deepEqual(saved.placements.map(row => row.device_id), [1, 2]);
            assert.equal(saved.links[0].memo, '', '未適用入力を配置解除の保存へ混ぜない');
            assert.deepEqual(requests.flatMap(row => row.devices), []);
            assert.equal(kind === 'link' ? panels.applyLinkPanel() : panels.applyPanel(), true);
            await queue.flushSaveQueue({ silent: true });
            if (kind === 'link') {
                const link = requests.at(-1).views.find(row => row.id === 10).links[0];
                assert.deepEqual([link.label, link.from_port, link.to_port, link.memo],
                    ['入力中のラベル', '入力中P1', '入力中P2', '入力中の配線備考']);
            } else {
                assert.equal(requests.at(-1).devices[0].device.memo, '入力中の機器備考');
            }
        });

        await t.test(`同じ機器の別ビュー配置だけを解除しても現在の${kind}入力を保持する`, async () => {
            reset(); await edit(kind); await prepareRemoval(1, 11);
            assert.equal(await manager.applyPlacementManager(), true);
            await queue.flushSaveQueue({ silent: true });
            assertDraft(kind);
            assert.equal(dom.get('unsaved-changes-overlay'), null);
            assert.equal(appState.links.some(row => row.id === 20), true);
            assert.equal(appState.links.some(row => row.id === 21), false);
            assert.deepEqual([...appState.selectedPlacementIds], [30, 31, 32]);
        });

        await t.test(`配置変更自体を取り消せば${kind}の入力確認・変更・保存を行わない`, async () => {
            reset(); await edit(kind); await prepareRemoval(1);
            const before = stateSnapshot();
            window.confirm = () => false;
            assert.equal(await manager.applyPlacementManager(), false);
            assertDraft(kind); assertUnchanged(before);
            assert.equal(dom.get('unsaved-changes-overlay'), null);
        });

        for (const deviceId of kind === 'link' ? [1, 2] : [1]) {
            for (const choice of ['cancel', 'discard', 'save']) {
                await t.test(`${kind}編集中に機器${deviceId}を解除: ${choice}を解決するまで配置も配線も変更しない`, async () => {
                    reset(); await edit(kind); await prepareRemoval(deviceId, 10, { addView: true });
                    const before = stateSnapshot();
                    const applying = manager.applyPlacementManager();
                    try {
                        await setImmediate();
                        assert.ok(dom.get('unsaved-changes-overlay'), '関連パネルを閉じる前に三択を開く');
                        assertDraft(kind); assertUnchanged(before);
                        assert.match(confirmations[0], /削除される接続: 1件/);
                        await dom.get(`unsaved-changes-${choice}`).dispatch('click');
                        assert.equal(await applying, choice !== 'cancel');
                        await queue.flushSaveQueue({ silent: true });
                        if (choice === 'cancel') {
                            assertDraft(kind); assertUnchanged(before);
                            return;
                        }
                        assert.equal(dom.get(kind === 'link' ? 'link-panel' : 'panel').hidden, true);
                        assert.equal(kind === 'link' ? appState.editingLinkId : appState.editingDeviceId, null);
                        assert.equal(appState.placements.some(row => row.device_id === deviceId && row.view_id === 10), false);
                        assert.equal(appState.placements.some(row => row.device_id === deviceId && row.view_id === 12), true);
                        assert.equal(appState.links.some(row => row.id === 20), false);
                        assert.equal(appState.links.some(row => row.id === 21), true, '別ビューの配線は保持');
                        assert.deepEqual([...appState.selectedPlacementIds], [30, 31, 32].filter(id => id !== deviceId + 29));
                        const savedView = requests.flatMap(row => row.views).filter(row => row.id === 10).at(-1);
                        assert.deepEqual(savedView.links, []);
                        const savedDrafts = kind === 'link'
                            ? requests.flatMap(row => row.views).flatMap(row => row.links).filter(row => row.id === 20)
                            : requests.flatMap(row => row.devices).map(row => row.device).filter(row => row.id === 1);
                        assert.equal(savedDrafts.some(row => row.memo === (kind === 'link' ? '入力中の配線備考' : '入力中の機器備考')), choice === 'save');
                    } finally {
                        await dom.get('unsaved-changes-cancel')?.dispatch('click');
                        await applying;
                        await queue.flushSaveQueue({ silent: true });
                    }
                });
            }
        }

        await t.test(`${kind}の適用が入力エラーなら配置解除を中止し入力と選択を保持する`, async () => {
            reset(); await edit(kind); await prepareRemoval(1);
            dom.get(kind === 'link' ? 'lp-memo' : 'p-name').value = kind === 'link' ? '長'.repeat(1001) : '';
            const before = stateSnapshot();
            const applying = manager.applyPlacementManager();
            try {
                await setImmediate();
                assert.ok(dom.get('unsaved-changes-save'));
                await dom.get('unsaved-changes-save').dispatch('click');
                assert.equal(await applying, false);
                assertUnchanged(before);
                assert.equal(dom.get(kind === 'link' ? 'link-panel' : 'panel').hidden, false);
                assert.equal(kind === 'link' ? panels.hasUnappliedLinkPanelChanges() : panels.hasUnappliedPanelChanges(), true);
            } finally {
                await dom.get('unsaved-changes-cancel')?.dispatch('click');
                await applying;
            }
        });
    }
});
