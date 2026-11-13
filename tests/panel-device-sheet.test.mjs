import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { installWorkspaceDom } from './helpers/workspace-dom.mjs';

test('機器詳細から個票へ移動する際は未適用入力と対象機器を保護する', async t => {
    const keys = ['window', 'document', 'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement',
        'HTMLTextAreaElement', 'HTMLButtonElement', 'localStorage', 'fetch', 'requestAnimationFrame', 'cancelAnimationFrame'];
    const originals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const dom = installWorkspaceDom({ templates: ['templates/components/property_panel.php', 'templates/modals/ledger.php'] });
    class Input extends globalThis.Element {}
    globalThis.HTMLInputElement = globalThis.HTMLSelectElement = globalThis.HTMLTextAreaElement = globalThis.HTMLButtonElement = Input;
    globalThis.localStorage = { getItem: () => null, setItem() {} };
    globalThis.requestAnimationFrame = callback => setTimeout(callback, 0);
    globalThis.cancelAnimationFrame = clearTimeout;
    const { appState, normalizeDevice, normalizeView } = await import('../public/js/core/state.js');
    const panels = await import('../public/js/ui/property-panel.js');
    const ledger = await import('../public/js/modals/ledger-modal.js');
    const drafts = await import('../public/js/core/device-drafts.js');
    const queue = await import('../public/js/core/save-queue.js');
    const resources = await import('../public/js/core/resource-save.js');
    let requests = [];
    globalThis.fetch = async (url, options) => {
        assert.match(url, /action=save_resources/);
        const payload = JSON.parse(options.body);
        requests.push(payload);
        return new Response(JSON.stringify({ ok: true, revision: 2, id_maps: {},
            devices: payload.devices.map(row => ({ ...row.device, resource_revision: 2 })),
            views: [], placements: [], links: [], canvas_notes: [], affected_view_ids: [], deleted_device_ids: [], deleted_view_ids: [] }), { status: 200 });
    };
    const reset = async (viewType = 'topology', admin = true) => {
        queue.clearPendingSave();
        drafts.discardDeviceDrafts();
        appState.editingDeviceId = null;
        await ledger.closeLedgerDetailPane();
        panels.closePanel();
        Object.assign(appState, {
            devices: [1, 2].map(id => normalizeDevice({ id, name: `機器${id}`, type: 'pc', resource_revision: 1 })),
            views: [normalizeView({ id: 10, name: '検証ビュー', view_type: viewType, resource_revision: 1 })],
            currentViewId: 10, editingDeviceId: null, editingLinkId: null,
            placements: [], links: [], canvasNotes: [], floorPlans: [], deviceImages: [], floorRackPlacements: [],
            rackSettings: [], rackMounts: [], rackShelves: [], rackShelfDevices: [],
            selectedPlacementIds: new Set(), resourceConflicts: { devices: new Map(), views: new Map() },
            appStatus: { dirty: false, state: 'saved' }, authExpired: false, isPinging: false, isSaving: false
        });
        window.APP_CONFIG.user.isAdmin = admin;
        resources.resetResourceBaseline(appState);
        requests = [];
        await panels.openPanel(appState.devices[0]);
    };
    const open = () => dom.events.dispatch('click', { target: dom.get('p-open-sheet-btn') });
    const editPanel = async () => {
        dom.get('p-name').value = '未適用の名前';
        await dom.events.dispatch('input', { target: dom.get('p-name') });
    };
    const choose = async choice => {
        await setImmediate();
        assert.equal(dom.get('unsaved-changes-overlay').hidden, false);
        await dom.get(`unsaved-changes-${choice}`).click();
    };
    t.after(async () => {
        queue.clearPendingSave(); drafts.discardDeviceDrafts();
        await ledger.closeLedgerDetailPane();
        await setImmediate();
        for (const [key, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    });

    for (const viewType of ['topology', 'floor', 'rack']) {
        for (const admin of [true, false]) {
            await t.test(`${viewType} / ${admin ? '管理者' : '閲覧者'}は一覧を経ず対象個票を開き、保存しない`, async () => {
                await reset(viewType, admin);
                dom.get('p-open-sheet-btn').focus();
                await open(); // ネイティブbuttonのEnter/Spaceも同じclickを発生させる。
                assert.equal(ledger.activeLedgerDeviceId, 1);
                assert.equal(dom.get('ledger-device-sheet-overlay').hidden, false);
                assert.equal(dom.get('ledger-overlay').hidden, true);
                assert.equal(dom.get('ledger-sheet-body').querySelector('[data-field="name"]').readOnly, !admin);
                assert.deepEqual(requests, []);
            });
        }
    }
    for (const choice of ['cancel', 'discard', 'save']) {
        await t.test(`右パネルの未適用入力: ${choice}`, async () => {
            await reset(); await editPanel();
            const opening = open();
            await choose(choice); await opening;
            await queue.flushSaveQueue({ silent: true });
            assert.equal(dom.get('ledger-device-sheet-overlay').hidden, choice === 'cancel');
            assert.equal(dom.get('panel').hidden, false);
            assert.equal(panels.hasUnappliedPanelChanges(), choice === 'cancel');
            assert.equal(appState.devices[0].name, choice === 'save' ? '未適用の名前' : '機器1');
            assert.equal(requests.length, choice === 'save' ? 1 : 0);
        });
    }
    for (const change of ['switch', 'delete', 'expire', 'close']) {
        await t.test(`右パネル確認中の${change}では古い対象を開かない`, async () => {
            await reset(); await editPanel();
            const opening = open();
            await setImmediate();
            if (change === 'switch') {
                drafts.discardDeviceDraft('panel', 1);
                dom.get('p-name').value = '機器1';
                await panels.openPanel(appState.devices[1]);
            }
            if (change === 'delete') appState.devices = appState.devices.filter(row => row.id !== 1);
            if (change === 'expire') appState.authExpired = true;
            if (change === 'close') {
                drafts.discardDeviceDraft('panel', 1);
                dom.get('p-name').value = '機器1';
                panels.closePanel();
            }
            await choose('save'); await opening;
            assert.equal(dom.get('ledger-device-sheet-overlay').hidden, true);
            assert.deepEqual(requests, []);
            assert.equal(appState.devices.find(row => row.id === 2).name, '機器2');
        });
    }
    await t.test('既存個票の中止を維持し、個票確認中のパネル切替も再確認する', async () => {
        await reset();
        await ledger.openLedgerDetail(2);
        const field = dom.get('ledger-sheet-body').querySelector('[data-field="name"]');
        field.value = '個票入力'; await field.dispatch('input');
        let opening = open();
        await choose('cancel'); await opening;
        assert.equal(ledger.activeLedgerDeviceId, 2);
        assert.equal(field.value, '個票入力');
        opening = open();
        await setImmediate();
        await panels.openPanel(appState.devices[1]);
        await choose('discard'); await opening;
        assert.equal(ledger.activeLedgerDeviceId, 2);
        assert.deepEqual(requests, []);
    });
    await t.test('未確定IDでもローカル個票を開け、暗黙に保存しない', async () => {
        await reset();
        appState.devices[0].id = -1;
        appState.devices[0].resource_revision = 0;
        await panels.openPanel(appState.devices[0]);
        await open();
        assert.equal(ledger.activeLedgerDeviceId, -1);
        assert.deepEqual(requests, []);
    });
});

test('図面の機器名全文ツールチップは親の状態説明と共存する', async t => {
    const keys = ['window', 'document', 'Element', 'HTMLElement'];
    const originals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    installWorkspaceDom();
    const { appState, normalizeDevice } = await import('../public/js/core/state.js');
    const { createDeviceElement } = await import('../public/js/canvas/renderer.js');
    const { getDeviceStatusDescription } = await import('../public/js/core/device-monitoring.js');
    appState.linkMode = false; appState.selectedPlacementIds = new Set();
    t.after(() => {
        for (const [key, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    });
    for (const name of ['SW1', '機器ABC-12345日本語の長い名称', '<img src=x onerror=alert(1)>']) {
        const device = normalizeDevice({ id: 1, name, ip: '192.0.2.1', status: 'unknown', type: 'pc' });
        const node = createDeviceElement({ id: 1, device_id: 1, view_id: 10, x: 100, y: 200 }, device);
        const label = node.querySelector('.device-name');
        assert.equal(label.textContent, name);
        assert.equal(label.title, name);
        assert.equal(label.children.length, 0, '名称をHTMLとして解釈しない');
        assert.equal(node.title, getDeviceStatusDescription(device));
        assert.equal(node.querySelector('.device-ip').textContent, '192.0.2.1');
        assert.equal(node.style.transform, 'translate(100px, 200px)');
    }
});
