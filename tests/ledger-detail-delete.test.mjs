import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installWorkspaceDom } from './helpers/workspace-dom.mjs';

test('個票からの完全削除は対象・未適用入力・保存状態を保護する', async t => {
    const keys = ['window', 'document', 'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement',
        'HTMLTextAreaElement', 'HTMLButtonElement', 'localStorage', 'confirm', 'fetch'];
    const originals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const dom = installWorkspaceDom({ templates: ['templates/modals/ledger.php'] });
    class Input extends globalThis.Element {}
    globalThis.HTMLInputElement = globalThis.HTMLSelectElement = globalThis.HTMLTextAreaElement = globalThis.HTMLButtonElement = Input;
    globalThis.localStorage = { getItem: () => null, setItem() {} };
    const { appState, normalizeDevice, normalizeView, normalizePlacement, normalizeLink } = await import('../public/js/core/state.js');
    const resources = await import('../public/js/core/resource-save.js');
    const drafts = await import('../public/js/core/device-drafts.js');
    const queue = await import('../public/js/core/save-queue.js');
    const { eventBus } = await import('../public/js/core/event-bus.js');
    const ledger = await import('../public/js/modals/ledger-modal.js');
    let requests, confirmations, responseStatus;
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
    const reset = async () => {
        queue.clearPendingSave();
        drafts.discardDeviceDrafts();
        await ledger.closeLedgerDetailPane();
        ledger.ledgerSelectedDeviceIds.clear();
        window.APP_CONFIG.user.isAdmin = true;
        appState.authExpired = false; appState.isPinging = false;
        appState.appStatus = { dirty: false, state: 'saved' };
        appState.resourceConflicts = { devices: new Map(), views: new Map() };
        appState.devices = [1, 2, 3].map(id => normalizeDevice({ id, name: `検証SW-${id}`, type: 'switch', resource_revision: 1 }));
        appState.views = [1, 2].map(id => normalizeView({ id, name: `検証ビュー${id}`, view_type: 'topology', resource_revision: 1 }));
        appState.currentViewId = 1;
        appState.placements = [[11, 1, 1], [12, 1, 2], [13, 1, 3], [21, 2, 1], [22, 2, 2]]
            .map(([id, view_id, device_id]) => normalizePlacement({ id, view_id, device_id, x: 10, y: 10 }));
        appState.links = [[1, 1, 1, 2], [2, 2, 1, 2], [3, 1, 2, 3]]
            .map(([id, view_id, from_id, to_id]) => normalizeLink({ id, view_id, from_id, to_id }));
        appState.rackMounts = []; appState.rackShelfDevices = []; appState.deviceImages = [];
        appState.canvasNotes = [];
        appState.selectedPlacementIds = new Set([11]);
        resources.resetResourceBaseline(appState);
        requests = []; confirmations = []; responseStatus = 200;
        globalThis.confirm = message => { confirmations.push(message); return true; };
        globalThis.fetch = async (url, options) => {
            assert.match(url, /action=save_resources/);
            const payload = JSON.parse(options.body); requests.push(payload);
            if (responseStatus !== 200) return json({ ok: false, error: '検証用の保存拒否',
                details: { conflicts: [{ kind: 'devices', id: 1, name: '検証SW-1' }] } }, responseStatus);
            return json({ ok: true, revision: appState.dataRevision + 1, id_maps: {},
                devices: payload.devices.filter(row => row.operation !== 'delete').map(row => ({ ...row.device, resource_revision: row.expected_revision + 1 })),
                views: payload.views.map(row => ({ ...row.view, resource_revision: row.expected_revision + 1 })),
                placements: payload.views.flatMap(row => row.placements), links: payload.views.flatMap(row => row.links),
                canvas_notes: [], deleted_device_ids: payload.devices.filter(row => row.operation === 'delete').map(row => row.id),
                deleted_view_ids: [], affected_view_ids: payload.views.map(row => row.id) });
        };
        ledger.updateLedgerFilters(); ledger.renderLedgerTable();
        await ledger.openLedgerDetail(1);
    };
    const edit = async value => {
        const input = dom.get('ledger-sheet-body').querySelector('[data-field="name"]');
        input.value = value; await input.dispatch('input');
    };
    const choose = async choice => {
        await new Promise(resolve => setImmediate(resolve));
        await dom.get(`unsaved-changes-${choice}`).click();
    };
    t.after(async () => {
        queue.clearPendingSave(); drafts.discardDeviceDrafts();
        await new Promise(resolve => setImmediate(resolve));
        for (const [key, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
        }
    });

    await t.test('確認には保存対象名と影響を表示し、取消では入力も配置も変えない', async () => {
        await reset();
        const before = structuredClone({ devices: appState.devices, placements: appState.placements, links: appState.links });
        globalThis.confirm = message => { confirmations.push(message); return false; };
        assert.equal(await ledger.deleteActiveLedgerDevice(), false);
        assert.equal(confirmations.length, 1);
        assert.match(confirmations[0], /機器「検証SW-1」/);
        assert.match(confirmations[0], /すべてのビュー上の配置.*関連するすべての接続/);
        assert.deepEqual({ devices: appState.devices, placements: appState.placements, links: appState.links }, before);
        assert.equal(dom.get('ledger-device-sheet-overlay').hidden, false);
        assert.deepEqual(requests, []);
    });

    await t.test('選択集合ではなく表示中の1台だけ削除し、全ビューの配置・接続と選択を同期する', async () => {
        await reset();
        ledger.ledgerSelectedDeviceIds.add(1); ledger.ledgerSelectedDeviceIds.add(2);
        assert.equal(await ledger.deleteActiveLedgerDevice(), true);
        assert.equal(dom.get('ledger-device-sheet-overlay').hidden, true);
        assert.equal(ledger.activeLedgerDeviceId, null);
        assert.deepEqual(appState.devices.map(row => row.id), [2, 3]);
        assert.deepEqual(appState.placements.map(row => row.id), [12, 13, 22]);
        assert.deepEqual(appState.links.map(row => row.id), [3]);
        assert.deepEqual([...ledger.ledgerSelectedDeviceIds], [2]);
        assert.deepEqual([...appState.selectedPlacementIds], []);
        assert.equal(dom.get('ledger-table-body').querySelector('tr[data-device-id="1"]'), null);
        assert.equal(await queue.flushSaveQueue({ silent: true }), true);
        assert.equal(appState.appStatus.state, 'saved');
        assert.deepEqual(requests[0].devices.map(row => [row.id, row.operation]), [[1, 'delete']]);
    });

    await t.test('未適用入力の編集継続では削除せず、破棄後だけ削除確認へ進む', async () => {
        await reset(); await edit('未適用の名前');
        let deleting = ledger.deleteActiveLedgerDevice();
        assert.equal(await ledger.deleteActiveLedgerDevice(), false);
        await choose('cancel'); assert.equal(await deleting, false);
        assert.equal(drafts.getDeviceDraft('sheet', 1).name, '未適用の名前');
        assert.deepEqual(confirmations, []);
        deleting = ledger.deleteActiveLedgerDevice(); await choose('discard');
        assert.equal(await deleting, true);
        assert.match(confirmations[0], /機器「検証SW-1」/);
        await queue.flushSaveQueue({ silent: true });
        assert.deepEqual(requests[0].devices.map(row => [row.id, row.operation]), [[1, 'delete']]);

        // 入力破棄後に削除をキャンセルした場合、個票が確定値に再描画されること
        await reset(); await edit('破棄予定の名前');
        globalThis.confirm = () => false;
        deleting = ledger.deleteActiveLedgerDevice(); await choose('discard');
        assert.equal(await deleting, false);
        assert.equal(dom.get('ledger-device-sheet-overlay').hidden, false);
        assert.equal(dom.get('ledger-sheet-body').querySelector('[data-field="name"]').value, '検証SW-1');
        assert.equal(drafts.hasDeviceDraftChanges('sheet', 1), false);
    });

    await t.test('未適用入力の適用に成功した名前で削除を確認する', async () => {
        await reset(); await edit('適用した名前');
        const deleting = ledger.deleteActiveLedgerDevice(); await choose('save');
        assert.equal(await deleting, true);
        assert.match(confirmations[0], /機器「適用した名前」/);
        await queue.flushSaveQueue({ silent: true });
        assert.deepEqual(requests.flatMap(payload => payload.devices.map(row => [row.id, row.operation])),
            [[1, 'update'], [1, 'delete']]);
    });

    await t.test('適用保存失敗と既知競合は削除を止め、個票の復旧操作を維持する', async () => {
        await reset(); await edit('保存を拒否される名前'); responseStatus = 422;
        const deleting = ledger.deleteActiveLedgerDevice(); await choose('save');
        assert.equal(await deleting, false);
        assert.deepEqual(confirmations, []);
        assert.equal(dom.get('ledger-device-sheet-overlay').hidden, false);
        assert.equal(dom.get('ledger-sheet-save-btn').disabled, false);
        appState.resourceConflicts.devices.set(1, { message: 'conflict' }); eventBus.emit('save-state:changed');
        assert.equal(dom.get('ledger-sheet-delete-btn').disabled, true);
        assert.equal(await ledger.deleteActiveLedgerDevice(), false);
        assert.equal(dom.get('ledger-sheet-save-btn').textContent, '競合を再読込');
        assert.deepEqual(appState.devices.map(row => row.id), [1, 2, 3]);
    });

    await t.test('削除受付後の保存拒否・競合を保存成功と表示しない', async () => {
        for (const status of [422, 409]) {
            await reset(); responseStatus = status;
            assert.equal(await ledger.deleteActiveLedgerDevice(), true);
            await queue.flushSaveQueue({ silent: true });
            assert.equal(dom.get('ledger-device-sheet-overlay').hidden, true);
            assert.notEqual(appState.appStatus.state, 'saved');
            if (status === 409) assert.equal(queue.hasResourceConflict('devices', 1), true);
            else assert.equal(queue.hasResourceChanges('devices', 1), true);
        }
    });


    await t.test('閲覧専用・認証失効・Ping実行中・成否未確認では実行できない', async () => {
        await reset();
        for (const mode of ['viewer', 'expired', 'ping', 'unconfirmed']) {
            window.APP_CONFIG.user.isAdmin = mode !== 'viewer';
            appState.authExpired = mode === 'expired'; appState.isPinging = mode === 'ping';
            appState.appStatus.state = mode === 'unconfirmed' ? 'unconfirmed' : 'saved';
            eventBus.emit('save-state:changed');
            assert.equal(dom.get('ledger-sheet-delete-btn').disabled, true);
            assert.equal(dom.get('ledger-sheet-delete-btn').hidden, mode === 'viewer');
            assert.equal(await ledger.deleteActiveLedgerDevice(), false);
        }
        assert.deepEqual(confirmations, []);
        assert.deepEqual(appState.devices.map(row => row.id), [1, 2, 3]);
    });

    await t.test('適用保存中の個票切替では削除を中止し、別機器へ対象をすり替えない', async () => {
        await reset(); await edit('保存中の名前');
        const fetchSave = globalThis.fetch;
        let release, started;
        const ready = new Promise(resolve => { started = resolve; });
        const pending = new Promise(resolve => { release = resolve; });
        globalThis.fetch = async (...args) => { started(); await pending; return fetchSave(...args); };
        const deleting = ledger.deleteActiveLedgerDevice(); await choose('save');
        await ready;
        await ledger.openLedgerDetail(2);
        release();
        assert.equal(await deleting, false);
        assert.deepEqual(confirmations, []);
        assert.deepEqual(appState.devices.map(row => row.id), [1, 2, 3]);
        assert.equal(ledger.activeLedgerDeviceId, 2);
    });

    await t.test('適用保存待機中に追加された未適用下書きは削除へ直進させず再確認する', async () => {
        await reset(); await edit('最初の名前');
        const fetchSave = globalThis.fetch;
        let release, started;
        const ready = new Promise(resolve => { started = resolve; });
        const pending = new Promise(resolve => { release = resolve; });
        globalThis.fetch = async (...args) => { started(); await pending; return fetchSave(...args); };
        const deleting = ledger.deleteActiveLedgerDevice(); await choose('save');
        await ready;
        // 保存通信中に入力欄が編集されたケース
        await edit('保存中に追加された名前');
        release();
        // 次の確認プロンプトが表示されるので、編集継続（cancel）を選ぶ
        await choose('cancel');
        assert.equal(await deleting, false);
        assert.equal(drafts.getDeviceDraft('sheet', 1).name, '保存中に追加された名前');
        assert.deepEqual(confirmations, []);
        assert.deepEqual(appState.devices.map(row => row.id), [1, 2, 3]);
    });

});
