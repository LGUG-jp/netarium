import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { installWorkspaceDom } from './helpers/workspace-dom.mjs';

test('個票Configタブの前後切替は台帳順・基本タブ入力・Config編集・非同期処理を保護する', async t => {
    const keys = ['window', 'document', 'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement',
        'HTMLTextAreaElement', 'HTMLButtonElement', 'localStorage', 'fetch'];
    const originals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const dom = installWorkspaceDom({ templates: ['templates/modals/ledger.php', 'templates/components/toast.php'], phpSetup: '$isAdmin = true;' });
    class Input extends globalThis.Element {}
    globalThis.HTMLInputElement = globalThis.HTMLSelectElement = globalThis.HTMLTextAreaElement = globalThis.HTMLButtonElement = Input;
    globalThis.localStorage = { getItem: () => null, setItem() {} };
    const { appState, normalizeDevice, normalizeView } = await import('../public/js/core/state.js');
    const queryAll = document.querySelectorAll;
    document.querySelectorAll = selector => selector.startsWith('#ledger-table-body ')
        ? document.getElementById('ledger-table-body').querySelectorAll(selector.slice('#ledger-table-body '.length))
        : queryAll(selector);
    const resources = await import('../public/js/core/resource-save.js');
    const drafts = await import('../public/js/core/device-drafts.js');
    const queue = await import('../public/js/core/save-queue.js');
    const ledger = await import('../public/js/modals/ledger-modal.js');
    const { handleAuthExpired } = await import('../public/js/core/api-client.js');

    const get = id => dom.get(id);
    const configTab = () => get('ledger-sheet-tabs').querySelector('[data-tab-key="config"]');
    const configPanel = () => get(configTab().getAttribute('aria-controls'));
    get('ledger-sheet-prev-btn').addEventListener('click', () => window.navigateLedgerDevice(-1));
    get('ledger-sheet-next-btn').addEventListener('click', () => window.navigateLedgerDevice(1));
    get('close-ledger-detail-pane-btn').addEventListener('click', () => ledger.closeLedgerDetailPane());

    const prev = async () => {
        if (get('ledger-sheet-prev-btn').disabled) return false;
        const result = await window.navigateLedgerDevice(-1);
        await ledger.getConfigLoadPromise();
        return result;
    };
    const next = async () => {
        if (get('ledger-sheet-next-btn').disabled) return false;
        const result = await window.navigateLedgerDevice(1);
        await ledger.getConfigLoadPromise();
        return result;
    };
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
    const deferred = () => {
        let resolve;
        const promise = new Promise(done => { resolve = done; });
        return { promise, resolve };
    };
    let requests, histories, failSave, failLoad, pendingLoad, pendingSave, pendingDelete;

    const closeSheet = async () => {
        const cancel = get('device-config-confirm-overlay')?.querySelectorAll('button').find(el => el.textContent === 'キャンセル');
        if (cancel) await cancel.click();
        const closing = ledger.closeLedgerDetailPane();
        await setImmediate();
        const discard = get('unsaved-changes-discard');
        if (discard) await discard.click();
        return closing;
    };
    const item = (id, content) => ({ id, generation: id, content, memo: '', actor_name: '合成管理者', created_at: '2026-11-08T12:00:00Z' });
    const reset = async () => {
        failSave = failLoad = null;
        pendingLoad = pendingSave = pendingDelete = null;
        queue.clearPendingSave();
        drafts.discardDeviceDrafts();
        appState.authExpired = false;
        await closeSheet();
        window.APP_CONFIG.user = { role: 'admin', isAdmin: true };
        Object.assign(appState, {
            authExpired: false, isPinging: false, appStatus: { dirty: false, state: 'saved' },
            dataRevision: 1, resourceConflicts: { devices: new Map(), views: new Map() },
            devices: [3, 1, 2, 4].map(id => normalizeDevice({ id, name: `合成SW-${id}`, type: id === 4 ? 'pc' : 'switch', resource_revision: 1 })),
            views: [normalizeView({ id: 1, name: '合成ビュー', view_type: 'topology', resource_revision: 1 })], currentViewId: 1,
            placements: [], links: [], canvasNotes: [], rackMounts: [], rackShelfDevices: [], deviceImages: []
        });
        resources.resetResourceBaseline(appState);
        requests = [];
        histories = new Map([[1, [item(2, 'first needle'), item(1, 'old needle')]], [2, []], [3, [item(2, 'third needle needle')]]]);
        globalThis.fetch = async (url, options = {}) => {
            const query = new URL(String(url), 'http://localhost').searchParams;
            const action = query.get('action');
            const payload = options.body ? JSON.parse(options.body) : null;
            const id = Number(query.get('device_id') || payload?.device_id);
            requests.push({ action, id, payload });
            if (action === 'save_resources') {
                return json({
                    ok: true, revision: ++appState.dataRevision, id_maps: {},
                    devices: payload.devices.map(row => ({ ...row.device, resource_revision: row.expected_revision + 1 })),
                    views: [], placements: [], view_link_routes: [], canvas_notes: [],
                    deleted_device_ids: [], deleted_view_ids: [], affected_view_ids: []
                });
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
        ledger.updateLedgerFilters();
        get('ledger-search').value = '';
        for (const option of get('ledger-type-filter').options) option.selected = option.value === 'switch';
        ledger.renderLedgerTable();
        get('ledger-overlay').hidden = false;
        await ledger.openLedgerDetail(1);
        await configTab().click();
        await ledger.getConfigLoadPromise();
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
        pendingLoad?.resolve?.(); pendingSave?.resolve?.(); pendingDelete?.resolve?.();
        queue.clearPendingSave(); drafts.discardDeviceDrafts();
        await closeSheet();
        for (const [key, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
        }
    });

    await t.test('Configタブのまま台帳表示順で未登録機器も巡回し、選択版・検索・差分・削除選択を初期化する', async () => {
        await reset();
        await get('device-config-search').dispatch('input');
        get('device-config-search').value = 'needle';
        await get('device-config-search-btn').click();
        assert.equal(get('device-config-search-status').textContent, '1 / 1件');
        await configPanel().querySelector('[data-version-id="1"]').click();

        await prev();
        assert.equal(ledger.activeLedgerDeviceId, 3);
        assert.equal(get('ledger-sheet-body').dataset.activeTab, 'config', 'Configタブ状態を維持して前機器へ移動する');
        assert.match(get('ledger-sheet-title').textContent, /合成SW-3/);
        assert.equal(get('device-config-text').value, 'third needle needle');
        assert.equal(get('device-config-search').value, '');
        get('device-config-search').value = 'needle'; await get('device-config-search-btn').click();
        assert.equal(get('device-config-search-status').textContent, '1 / 2件', '同じ版IDでも前機器の検索位置を再利用しない');
        assert.equal(get('ledger-sheet-prev-btn').disabled, true);
        await prev(); assert.equal(ledger.activeLedgerDeviceId, 3);

        await next();
        await get('device-config-compare').click();
        assert.ok(configPanel().querySelector('.device-config-diff'));
        await next();
        assert.equal(ledger.activeLedgerDeviceId, 2);
        assert.match(configPanel().textContent, /Configが登録されていません/);
        assert.equal(get('device-config-text'), null);
        assert.equal(get('device-config-search'), null);
        assert.equal(get('ledger-sheet-next-btn').disabled, true);

        await prev();
        await get('device-config-more-btn').click();
        await get('device-config-delete-mode').click();
        await get('device-config-select-all').click();
        await next(); await prev();
        assert.equal(get('device-config-delete-selected'), null);
        await get('device-config-more-btn').click();
        await get('device-config-delete-mode').click();
        assert.equal(get('device-config-delete-selected').disabled, true);

        // タブ切替だけでは通常タブの状態を壊さず、閉鎖後に開き直すと先頭タブへ戻る
        await get('ledger-sheet-tab-0').click();
        assert.equal(get('ledger-sheet-body').dataset.activeTab, 'primary');
        await configTab().click();
        assert.equal(get('ledger-sheet-body').dataset.activeTab, 'config');
        await ledger.closeLedgerDetailPane();
        assert.equal(get('ledger-device-sheet-overlay').hidden, true);
        assert.equal(get('ledger-overlay').hidden, false);
        assert.deepEqual(requests.filter(row => row.action === 'load_device_configs').map(row => row.id), [1, 3, 1, 2, 1, 2, 1]);
    });

    await t.test('タブ切替で未保存Configも未適用基本情報も破棄せず保持する', async () => {
        await reset();
        // Config 編集中に基本タブへ移動して名前編集→再びConfigタブへ戻っても両方保持される
        const content = await editConfig();
        await get('ledger-sheet-tab-0').click();
        assert.equal(configPanel().hidden, true);
        assert.equal(get('ledger-sheet-panel-0').hidden, false);
        const nameInput = get('ledger-sheet-body').querySelector('[data-field="name"]');
        nameInput.value = 'タブ切替保持名';
        await nameInput.dispatch('input');
        assert.equal(requests.filter(r => r.action === 'save_resources' || r.action === 'save_device_config').length, 0);
        await configTab().click();
        assert.equal(get('device-config-editor').value, content);
        assert.equal(drafts.getDeviceDraft('sheet', 1).name, 'タブ切替保持名');
        const editor = get('device-config-editor');
        editor.setSelectionRange(2, 6);
        ledger.renderLedgerDeviceSheet(appState.devices.find(device => device.id === 1));
        assert.equal(get('device-config-editor'), editor, '個票再描画でもConfig入力DOMを維持する');
        assert.equal(editor.selectionStart, 2);
        assert.equal(editor.selectionEnd, 6);
    });

    await t.test('個票を接続・ポート指定で開き直すと、表示中の変更済みConfigだけ確認する', async () => {
        await reset();
        const body = get('ledger-sheet-body');
        const openPorts = () => ledger.openLedgerDetail(1, { tab: 'ports' });

        await get('device-config-register').click();
        const untouchedEditor = get('device-config-editor');
        assert.ok(untouchedEditor);
        assert.equal(await openPorts(), true);
        await configTab().click();
        assert.equal(get('device-config-editor'), untouchedEditor);

        const content = 'unsaved config';
        untouchedEditor.value = content;
        await untouchedEditor.dispatch('input');
        await get('ledger-sheet-tab-0').click();
        const nameInput = body.querySelector('[data-field="name"]');
        nameInput.value = '未適用の機器名';
        await nameInput.dispatch('input');
        await configTab().click();

        let opening = openPorts();
        await setImmediate();
        assert.equal(body.dataset.activeTab, 'config');
        assert.match(get('unsaved-changes-message').textContent, /Configに未保存の入力/);
        await choose('cancel');
        assert.equal(await opening, false);
        assert.equal(body.dataset.activeTab, 'config');
        assert.equal(get('device-config-editor').value, content);

        opening = openPorts();
        await choose('discard');
        assert.equal(await opening, true);
        assert.equal(body.dataset.activeTab, 'ports');
        assert.equal(drafts.getDeviceDraft('sheet', 1).name, '未適用の機器名');
        await configTab().click();
        assert.equal(get('device-config-editor'), null);
        assert.equal(requests.some(row => row.action.startsWith('save_')), false);
    });

    await t.test('編集継続・保存失敗・409では入力を保持し、保存完了まで連打と閉鎖を抑止する', async () => {
        await reset(); const content = await editConfig();
        let moving = window.navigateLedgerDevice(1);
        await window.navigateLedgerDevice(1);
        assert.equal(await ledger.closeLedgerDetailPane(), false);
        await choose('cancel'); await moving;
        assert.equal(get('device-config-editor').value, content);
        assert.equal(ledger.activeLedgerDeviceId, 1);

        for (const status of [500, 409]) {
            failSave = status;
            moving = window.navigateLedgerDevice(1);
            await choose('save'); await moving;
            assert.equal(ledger.activeLedgerDeviceId, 1);
            assert.equal(get('device-config-editor').value, content);
            if (status === 409) await get('device-config-reload').click();
        }
        failSave = null; pendingSave = deferred();
        moving = window.navigateLedgerDevice(1);
        await choose('save');
        assert.equal(get('ledger-sheet-next-btn').disabled, true);
        assert.equal(get('close-ledger-detail-pane-btn').disabled, true);
        assert.equal(await ledger.closeLedgerDetailPane(), false);
        await next();
        assert.deepEqual(requests.filter(row => row.action === 'load_device_configs').map(row => row.id), [1, 1]);
        pendingSave.resolve(); await moving;
        await ledger.getConfigLoadPromise();
        assert.equal(ledger.activeLedgerDeviceId, 2);
        assert.equal(histories.get(1)[0].content, content);
        assert.equal(requests.filter(row => row.action === 'save_device_config').length, 3);
    });

    await t.test('破棄は明示選択時のみ行い、削除確認中と削除API中は移動・閉鎖しない', async () => {
        await reset(); await editConfig();
        const moving = window.navigateLedgerDevice(-1);
        await choose('discard'); await moving;
        await ledger.getConfigLoadPromise();
        assert.equal(ledger.activeLedgerDeviceId, 3);
        await get('device-config-more-btn').click();
        await get('device-config-delete-mode').click();
        await get('device-config-select-all').click();
        await get('device-config-delete-selected').click();
        assert.equal(get('ledger-sheet-next-btn').disabled, true);
        assert.equal(get('close-ledger-detail-pane-btn').disabled, true);
        await next(); assert.equal(ledger.activeLedgerDeviceId, 3);
        pendingDelete = deferred();
        const deleting = get('device-config-delete-confirm').click();
        await next(); assert.equal(ledger.activeLedgerDeviceId, 3);
        assert.equal(await ledger.closeLedgerDetailPane(), false);
        pendingDelete.resolve(); await deleting;
        await next(); assert.equal(ledger.activeLedgerDeviceId, 1);
    });

    await t.test('個票の未適用入力は確認し、409保存競合時は強制上書きせず状態通知と再読込を出す', async () => {
        await reset();
        await get('ledger-sheet-tab-0').click();
        const name = get('ledger-sheet-body').querySelector('[data-field="name"]');
        name.value = '未適用の個票'; await name.dispatch('input');
        await configTab().click();

        let moving = window.navigateLedgerDevice(1);
        await choose('cancel'); await moving;
        assert.equal(ledger.activeLedgerDeviceId, 1);
        assert.equal(drafts.getDeviceDraft('sheet', 1).name, '未適用の個票');

        appState.resourceConflicts.devices.set(1, { id: 1, name: '合成SW-1', message: 'conflict' });
        queue.updateSaveButtonState();
        assert.equal(get('ledger-sheet-save-btn').hidden, false);
        assert.equal(get('ledger-sheet-save-btn').textContent, '競合を再読込');
        assert.equal(get('ledger-sheet-save-status').hidden, false);
        assert.match(get('ledger-sheet-save-status').textContent, /強制上書き不可/);

        moving = window.navigateLedgerDevice(1);
        await choose('save'); await moving;
        assert.equal(ledger.activeLedgerDeviceId, 1);
        assert.equal(drafts.getDeviceDraft('sheet', 1).name, '未適用の個票');

        appState.resourceConflicts.devices.clear();
        queue.updateSaveButtonState();
        moving = window.navigateLedgerDevice(1);
        await choose('save'); await moving;
        await ledger.getConfigLoadPromise();
        assert.equal(ledger.activeLedgerDeviceId, 2);
        assert.equal(appState.devices.find(device => device.id === 1).name, '未適用の個票');
    });

    await t.test('取得中の連打は1回だけ切り替え、404応答で前機器の本文を表示しない', async () => {
        await reset(); pendingLoad = deferred(); failLoad = 404;
        const moving = window.navigateLedgerDevice(1);
        await setImmediate();
        assert.equal(ledger.activeLedgerDeviceId, 2);
        assert.equal(get('device-config-text'), null);
        assert.equal(get('ledger-sheet-next-btn').disabled, true);
        await next(); await prev();
        assert.equal(await ledger.closeLedgerDetailPane(), false);
        const loadPromise = ledger.getConfigLoadPromise();
        pendingLoad.resolve(); await moving; await loadPromise;
        assert.match(get('ledger-sheet-title').textContent, /合成SW-2/);
        assert.equal(get('device-config-text'), null);
        assert.deepEqual(requests.filter(row => row.action === 'load_device_configs').map(row => row.id), [1, 2]);
        failLoad = null; pendingLoad = null;
        await prev(); assert.equal(get('device-config-text').value, 'first needle');
    });

    await t.test('取得中に対象が削除されても遅延成功応答を本文に反映しない', async () => {
        await reset(); pendingLoad = deferred();
        const moving = window.navigateLedgerDevice(-1);
        await setImmediate();
        appState.devices = appState.devices.filter(row => row.id !== 3);
        const loadPromise = ledger.getConfigLoadPromise();
        pendingLoad.resolve(); await moving; await loadPromise;
        assert.equal(get('device-config-text'), null);
        assert.equal(get('ledger-sheet-prev-btn').disabled, true);
    });

    await t.test('確認中に対象が非表示・削除となった場合と現在機器削除時は中断する', async () => {
        for (const change of ['filtered', 'deleted', 'current-deleted']) {
            await reset(); await editConfig();
            const moving = window.navigateLedgerDevice(1);
            if (change === 'filtered') get('ledger-search').value = '合成SW-1';
            else appState.devices = appState.devices.filter(row => row.id !== (change === 'deleted' ? 2 : 1));
            await choose('cancel'); await moving;
            assert.equal(ledger.activeLedgerDeviceId, 1);
            assert.equal(get('device-config-editor').value, 'unsaved config');
            assert.deepEqual(requests.map(row => row.action), ['load_device_configs']);
        }
    });

    await t.test('個票の確認待ちに対象機器が削除されたら切り替えない', async () => {
        await reset();
        await get('ledger-sheet-tab-0').click();
        const name = get('ledger-sheet-body').querySelector('[data-field="name"]');
        name.value = '確認待ちの個票'; await name.dispatch('input');
        const moving = window.navigateLedgerDevice(1);
        appState.devices = appState.devices.filter(device => Number(device.id) !== 2);
        await choose('discard'); await moving;
        assert.equal(ledger.activeLedgerDeviceId, 1);
        assert.deepEqual(requests.map(row => row.action), ['load_device_configs']);
    });

    await t.test('保存時の401と認証失効後の遅延取得応答でConfig本文を隠し、操作を抑止する', async () => {
        await reset();
        const content = await editConfig();
        failSave = 401;
        const moving = window.navigateLedgerDevice(1);
        await choose('save'); await moving;
        assert.equal(appState.authExpired, true);
        assert.equal(ledger.activeLedgerDeviceId, 1);
        assert.equal(get('device-config-editor').value, content);
        assert.equal(configPanel().querySelector('.device-config-body').hidden, true);

        await reset();
        pendingLoad = deferred();
        const moving2 = window.navigateLedgerDevice(-1);
        await setImmediate();
        handleAuthExpired();
        const loadPromise = ledger.getConfigLoadPromise();
        pendingLoad.resolve(); await moving2; await loadPromise;
        assert.equal(get('device-config-text'), null);
        assert.equal(configPanel().querySelector('.device-config-body').hidden, true);
        assert.equal(get('ledger-sheet-prev-btn').disabled, true);
        assert.equal(get('ledger-sheet-next-btn').disabled, true);
        assert.deepEqual(requests.filter(row => row.action === 'load_device_configs').map(row => row.id), [1, 3]);
    });
});
