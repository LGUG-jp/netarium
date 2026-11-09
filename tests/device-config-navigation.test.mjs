import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { installWorkspaceDom } from './helpers/workspace-dom.mjs';

test('Configの機器切替は台帳順・個票・編集と非同期処理を保護する', async t => {
    const keys = ['window', 'document', 'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement',
        'HTMLTextAreaElement', 'HTMLButtonElement', 'localStorage', 'fetch'];
    const originals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const dom = installWorkspaceDom({ templates: ['templates/modals/ledger.php', 'templates/components/toast.php'], phpSetup: '$isAdmin = true;' });
    class Input extends globalThis.Element {}
    globalThis.HTMLInputElement = globalThis.HTMLSelectElement = globalThis.HTMLTextAreaElement = globalThis.HTMLButtonElement = Input;
    globalThis.localStorage = { getItem: () => null, setItem() {} };
    const { appState, normalizeDevice, normalizeView } = await import('../public/js/core/state.js');
    // 軽量DOMの単一要素セレクターに、台帳の行を指定する子孫セレクターを補う。
    const queryAll = document.querySelectorAll;
    document.querySelectorAll = selector => selector.startsWith('#ledger-table-body ')
        ? document.getElementById('ledger-table-body').querySelectorAll(selector.slice('#ledger-table-body '.length))
        : queryAll(selector);
    const resources = await import('../public/js/core/resource-save.js');
    const drafts = await import('../public/js/core/device-drafts.js');
    const queue = await import('../public/js/core/save-queue.js');
    const ledger = await import('../public/js/modals/ledger-modal.js');
    const config = await import('../public/js/modals/device-config-modal.js');
    const { handleAuthExpired } = await import('../public/js/core/api-client.js');
    const { getTopModalContainer } = await import('../public/js/core/modal-focus.js');
    const get = id => dom.get(id);
    const next = () => get('device-config-next').dispatch('click');
    const prev = () => get('device-config-prev').dispatch('click');
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
    const deferred = () => {
        let resolve;
        const promise = new Promise(done => { resolve = done; });
        return { promise, resolve };
    };
    let requests, histories, failSave, failLoad, pendingLoad, pendingSave, pendingDelete;
    const closeConfig = async () => {
        const closing = config.closeDeviceConfig();
        await setImmediate();
        const discard = get('unsaved-changes-discard');
        if (discard) await discard.click();
        return closing;
    };
    const item = (id, content) => ({ id, generation: id, content, memo: '', actor_name: '合成管理者', created_at: '2026-11-08T12:00:00Z' });
    const reset = async () => {
        queue.clearPendingSave();
        drafts.discardDeviceDrafts();
        await closeConfig();
        await ledger.closeLedgerDetailPane();
        window.APP_CONFIG.user = { role: 'admin', isAdmin: true };
        Object.assign(appState, { authExpired: false, isPinging: false, appStatus: { dirty: false, state: 'saved' },
            dataRevision: 1, resourceConflicts: { devices: new Map(), views: new Map() },
            devices: [1, 2, 3, 4].map(id => normalizeDevice({ id, name: `合成SW-${id}`, type: 'switch', resource_revision: 1 })),
            views: [normalizeView({ id: 1, name: '合成ビュー', view_type: 'topology', resource_revision: 1 })], currentViewId: 1,
            placements: [], links: [], canvasNotes: [], rackMounts: [], rackShelfDevices: [], deviceImages: [] });
        resources.resetResourceBaseline(appState);
        requests = []; histories = new Map([[1, [item(2, 'first needle'), item(1, 'old needle')]], [2, []], [3, [item(2, 'third needle needle')]]]);
        failSave = failLoad = null;
        pendingLoad = pendingSave = pendingDelete = null;
        globalThis.fetch = async (url, options = {}) => {
            const query = new URL(String(url), 'http://localhost').searchParams;
            const action = query.get('action');
            const payload = options.body ? JSON.parse(options.body) : null;
            const id = Number(query.get('device_id') || payload?.device_id);
            requests.push({ action, id, payload });
            if (action === 'save_resources') {
                return json({ ok: true, revision: ++appState.dataRevision, id_maps: {},
                    devices: payload.devices.map(row => ({ ...row.device, resource_revision: row.expected_revision + 1 })),
                    views: [], placements: [], links: [], canvas_notes: [], deleted_device_ids: [], deleted_view_ids: [], affected_view_ids: [] });
            }
            if (action === 'load_device_configs' && pendingLoad) await pendingLoad.promise;
            if (action === 'save_device_config' && pendingSave) await pendingSave.promise;
            if (action === 'delete_device_configs' && pendingDelete) await pendingDelete.promise;
            const failure = action === 'save_device_config' ? failSave : action === 'load_device_configs' ? failLoad : null;
            if (failure) return json({ ok: false, error: '合成エラー' }, failure);
            if (action === 'save_device_config') histories.set(id, [item(3, payload.content), ...(histories.get(id) || [])]);
            if (action === 'delete_device_configs') histories.set(id, histories.get(id).filter(row => !payload.ids.includes(row.id)));
            return json({ ok: true, device_id: id, device_revision: 1, revision: 1, items: histories.get(id) || [] });
        };
        ledger.updateLedgerFilters(); ledger.renderLedgerTable();
        // 検索・ソート後に相当する表示行順。4は表示対象外。
        const table = get('ledger-table-body');
        const rows = [3, 1, 2].map(id => table.querySelector(`tr[data-device-id="${id}"]`));
        table.replaceChildren(...rows);
        get('ledger-overlay').hidden = false;
        await ledger.openLedgerDetail(1);
        get('ledger-sheet-config-btn').focus();
        assert.equal(await ledger.openActiveDeviceConfig(), true);
    };
    const choose = async value => {
        await setImmediate();
        assert.ok(get(`unsaved-changes-${value}`));
        await get(`unsaved-changes-${value}`).click();
    };
    const editConfig = async () => {
        await get('device-config-register').click();
        const editor = get('device-config-editor');
        editor.value = 'unsaved config'; await editor.dispatch('input');
        return editor.value;
    };
    t.after(async () => {
        queue.clearPendingSave(); drafts.discardDeviceDrafts();
        await closeConfig(); await ledger.closeLedgerDetailPane();
        for (const [key, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
        }
    });

    await t.test('表示順で未登録機器も巡回し、選択版・検索・差分・削除選択を初期化して最後の個票へ戻る', async () => {
        await reset();
        await get('device-config-search').dispatch('input');
        get('device-config-search').value = 'needle';
        await get('device-config-search-btn').click();
        assert.equal(get('device-config-search-status').textContent, '1 / 1件');
        await get('device-config-overlay').querySelector('[data-version-id="1"]').click();
        await prev();
        assert.equal(ledger.activeLedgerDeviceId, 3);
        assert.equal(get('device-config-name').textContent, '合成SW-3');
        assert.equal(get('device-config-text').value, 'third needle needle');
        assert.equal(get('device-config-search').value, '');
        get('device-config-search').value = 'needle'; await get('device-config-search-btn').click();
        assert.equal(get('device-config-search-status').textContent, '1 / 2件', '同じ版IDでも前機器の検索位置を再利用しない');
        assert.equal(get('device-config-prev').disabled, true);
        await prev(); assert.equal(ledger.activeLedgerDeviceId, 3);
        await next();
        await get('device-config-compare').click();
        assert.ok(get('device-config-overlay').querySelector('.device-config-diff'));
        await next();
        assert.equal(ledger.activeLedgerDeviceId, 2);
        assert.match(get('device-config-overlay').textContent, /Configが登録されていません/);
        assert.equal(get('device-config-text'), null);
        assert.equal(get('device-config-search'), null);
        assert.equal(get('device-config-next').disabled, true);
        await prev();
        await get('device-config-delete-mode').click();
        await get('device-config-select-all').click();
        await next(); await prev();
        assert.equal(get('device-config-delete-selected'), null);
        await get('device-config-delete-mode').click();
        assert.equal(get('device-config-delete-selected').disabled, true);
        await get('close-device-config-btn').click();
        assert.equal(get('ledger-device-sheet-overlay').hidden, false);
        assert.equal(get('ledger-overlay').hidden, false);
        assert.equal(ledger.activeLedgerDeviceId, 1);
        assert.match(get('ledger-sheet-title').textContent, /合成SW-1/);
        assert.equal(get('ledger-table-body').querySelector('tr.ledger-row-active').dataset.deviceId, '1');
        assert.equal(get('ledger-sheet-prev-btn').disabled, false);
        assert.equal(get('ledger-sheet-next-btn').disabled, false);
        assert.deepEqual(requests.filter(row => row.action === 'load_device_configs').map(row => row.id), [1, 3, 1, 2, 1, 2, 1]);
    });

    await t.test('編集継続・保存失敗・409では入力を保持し、保存完了まで連打と閉鎖を抑止する', async () => {
        await reset(); const content = await editConfig();
        let moving = next();
        await next();
        assert.equal(await config.closeDeviceConfig(), false);
        await choose('cancel'); await moving;
        assert.equal(get('device-config-editor').value, content);
        assert.equal(ledger.activeLedgerDeviceId, 1);
        for (const status of [500, 409]) {
            failSave = status;
            moving = next(); await choose('save'); await moving;
            assert.equal(ledger.activeLedgerDeviceId, 1);
            assert.equal(get('device-config-editor').value, content);
            if (status === 409) await get('device-config-reload').click();
        }
        failSave = null; pendingSave = deferred();
        moving = next(); await choose('save');
        assert.equal(get('device-config-next').disabled, true);
        assert.equal(await config.closeDeviceConfig(), false);
        await next();
        assert.deepEqual(requests.filter(row => row.action === 'load_device_configs').map(row => row.id), [1, 1]);
        pendingSave.resolve(); await moving;
        assert.equal(ledger.activeLedgerDeviceId, 2);
        assert.equal(histories.get(1)[0].content, content);
        assert.equal(requests.filter(row => row.action === 'save_device_config').length, 3);
    });

    await t.test('破棄は明示選択時のみ行い、削除確認中と削除API中は移動しない', async () => {
        await reset(); await editConfig();
        const moving = prev(); await choose('discard'); await moving;
        assert.equal(ledger.activeLedgerDeviceId, 3);
        await get('device-config-delete-mode').click(); await get('device-config-select-all').click();
        await get('device-config-delete-selected').click();
        assert.equal(get('device-config-next').disabled, true);
        await next(); assert.equal(ledger.activeLedgerDeviceId, 3);
        pendingDelete = deferred();
        const deleting = get('device-config-delete-confirm').click();
        await next(); assert.equal(ledger.activeLedgerDeviceId, 3);
        assert.equal(await config.closeDeviceConfig(), false);
        pendingDelete.resolve(); await deleting;
        await next(); assert.equal(ledger.activeLedgerDeviceId, 1);
    });

    await t.test('個票の未適用入力は確認し、保存競合時はConfigと個票を移動しない', async () => {
        await reset();
        const name = get('ledger-sheet-body').querySelector('[data-field="name"]');
        name.value = '未適用の個票'; await name.dispatch('input');
        let moving = next(); await choose('cancel'); await moving;
        assert.equal(ledger.activeLedgerDeviceId, 1);
        assert.equal(drafts.getDeviceDraft('sheet', 1).name, '未適用の個票');
        appState.resourceConflicts.devices.set(1, { id: 1 });
        await next();
        assert.equal(ledger.activeLedgerDeviceId, 1);
        assert.equal(drafts.getDeviceDraft('sheet', 1).name, '未適用の個票');
        appState.resourceConflicts.devices.clear();
        moving = next(); await choose('save'); await moving;
        assert.equal(ledger.activeLedgerDeviceId, 2);
        assert.equal(appState.devices[0].name, '未適用の個票');
        assert.equal(get('ledger-device-sheet-overlay').hidden, true);
        assert.equal(getTopModalContainer(), get('device-config-overlay'));
    });

    await t.test('取得中の連打は1回だけ切り替え、404応答で前機器の本文を表示しない', async () => {
        await reset(); pendingLoad = deferred(); failLoad = 404;
        const moving = next(); await setImmediate();
        assert.equal(ledger.activeLedgerDeviceId, 2);
        assert.equal(get('device-config-text'), null);
        assert.equal(get('device-config-next').disabled, true);
        await next(); await prev();
        assert.equal(await config.closeDeviceConfig(), false);
        pendingLoad.resolve(); await moving;
        assert.equal(get('device-config-name').textContent, '合成SW-2');
        assert.equal(get('device-config-text'), null);
        assert.deepEqual(requests.filter(row => row.action === 'load_device_configs').map(row => row.id), [1, 2]);
        failLoad = null; pendingLoad = null;
        await prev(); assert.equal(get('device-config-text').value, 'first needle');
    });

    await t.test('取得中に対象が削除されても遅延成功応答を本文に反映しない', async () => {
        await reset(); pendingLoad = deferred();
        const moving = prev(); await setImmediate();
        appState.devices = appState.devices.filter(row => row.id !== 3);
        pendingLoad.resolve(); await moving;
        assert.equal(get('device-config-text'), null);
        assert.equal(get('device-config-name').textContent, '合成SW-3');
        assert.equal(get('device-config-prev').disabled, true);
        assert.equal(get('device-config-next').disabled, true);
    });

    await t.test('確認中に対象が非表示・削除となった場合と現在機器削除時は中断する', async () => {
        for (const change of ['hidden', 'deleted', 'current-deleted']) {
            await reset(); await editConfig();
            const moving = next();
            if (change === 'hidden') get('ledger-table-body').querySelector('tr[data-device-id="2"]').hidden = true;
            else appState.devices = appState.devices.filter(row => row.id !== (change === 'deleted' ? 2 : 1));
            await choose('cancel'); await moving;
            await next();
            assert.equal(ledger.activeLedgerDeviceId, 1);
            assert.equal(get('device-config-editor').value, 'unsaved config');
            assert.deepEqual(requests.map(row => row.action), ['load_device_configs']);
        }
    });

    await t.test('個票の確認待ちに対象行が消えたら切り替えない', async () => {
        await reset();
        const name = get('ledger-sheet-body').querySelector('[data-field="name"]');
        name.value = '確認待ちの個票'; await name.dispatch('input');
        const moving = next();
        get('ledger-table-body').querySelector('tr[data-device-id="2"]').remove();
        await choose('discard'); await moving;
        assert.equal(ledger.activeLedgerDeviceId, 1);
        assert.equal(get('device-config-text').value, 'first needle');
        assert.deepEqual(requests.map(row => row.action), ['load_device_configs']);
    });

    await t.test('管理者以外の移動と保存時の401は切替を確定せず、Config入力を保持する', async () => {
        await reset();
        window.APP_CONFIG.user = { role: 'viewer', isAdmin: false };
        await next();
        assert.equal(ledger.activeLedgerDeviceId, 1);
        assert.deepEqual(requests.map(row => row.action), ['load_device_configs']);
        window.APP_CONFIG.user = { role: 'admin', isAdmin: true };
        const content = await editConfig();
        failSave = 401;
        const moving = next(); await choose('save'); await moving;
        assert.equal(appState.authExpired, true);
        assert.equal(ledger.activeLedgerDeviceId, 1);
        assert.equal(get('device-config-editor').value, content);
        assert.equal(get('device-config-overlay').querySelector('.device-config-body').hidden, true);
        assert.deepEqual(requests.map(row => row.action), ['load_device_configs', 'save_device_config']);
    });

    await t.test('認証失効後の遅延取得応答を表示せず、再移動を受け付けない', async () => {
        await reset(); pendingLoad = deferred();
        const moving = prev(); await setImmediate();
        handleAuthExpired();
        pendingLoad.resolve(); await moving;
        assert.equal(get('device-config-text'), null);
        assert.equal(get('device-config-overlay').querySelector('.device-config-body').hidden, true);
        assert.equal(get('device-config-prev').disabled, true);
        assert.equal(get('device-config-next').disabled, true);
        await next();
        assert.deepEqual(requests.filter(row => row.action === 'load_device_configs').map(row => row.id), [1, 3]);
        await config.closeDeviceConfig();
    });
});
