import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { installWorkspaceDom } from './helpers/workspace-dom.mjs';

test('建物ビューからのヘッダー操作は、未保存確認とキャンバスの隔離を維持する', async t => {
    const keys = ['window', 'document', 'Element', 'HTMLElement', 'fetch', 'ResizeObserver'];
    const globals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const { add, get, events } = installWorkspaceDom({
        templates: ['templates/components/toolbar.php', 'templates/components/tool_palette.php',
            'templates/modals/account.php', 'templates/modals/link_display_settings.php'],
        phpSetup: "require 'version.php'; $username = 'テスト利用者'; $userRole = 'admin'; $csrfToken = 'test-only-token';"
    });
    const canvas = add('div', 'canvas');
    const world = add('div', 'world', canvas);
    const ledger = add('div', 'ledger-overlay');
    const ledgerSearch = add('input', 'ledger-search', ledger);
    ledger.hidden = true;
    const manageMenu = get('toolbar-manage-menu');
    const userMenu = get('toolbar-user-menu');
    for (const menu of [manageMenu, userMenu]) {
        Object.defineProperty(menu, 'open', {
            get: () => menu.getAttribute('open') !== null,
            set: open => open ? menu.setAttribute('open', '') : menu.removeAttribute('open')
        });
    }
    const logout = get('logout-btn');
    const logoutForm = logout.form = logout.closest('form');
    const logouts = [];
    logoutForm.requestSubmit = async submitter => {
        const event = await logoutForm.dispatch('submit', {
            submitter, preventDefault() { this.defaultPrevented = true; }
        });
        if (!event.defaultPrevented) logouts.push(getOpenBuildingId());
    };
    globalThis.ResizeObserver = class { observe() {} disconnect() {} };
    document.readyState = 'loading';
    const { appState } = await import('../public/js/core/state.js');
    const { openBuildingView, getOpenBuildingId } = await import('../public/js/ui/building-view.js');
    const { resetResourceBaseline } = await import('../public/js/core/resource-save.js');
    const { registerStaticListeners } = await import('../public/js/main.js');
    const oldState = { ...appState };
    t.after(() => {
        Object.assign(appState, oldState);
        resetResourceBaseline(appState);
        for (const [key, descriptor] of globals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
        }
    });
    const floor = { id: 2, building_id: 1, name: '1F', representative_view_id: null,
        scale: 1, offset_x: 0, offset_y: 0, rotation: 0 };
    Object.assign(appState, { canvas, world, buildings: [{ id: 1, name: '検証棟', building_view_enabled: 1 }],
        floors: [floor], dataRevision: 1 });
    resetResourceBaseline(appState);
    registerStaticListeners();
    assert.equal(get('device-search-input').getAttribute('role'), 'combobox');

    const opens = [];
    window.open = url => opens.push(url);
    const exports = [];
    let releaseSave;
    globalThis.fetch = async url => {
        if (url.endsWith('action=export_backup_zip')) {
            exports.push(getOpenBuildingId());
            return new Response('test ZIP', { headers: { 'Content-Type': 'application/zip' } });
        }
        assert.ok(url.endsWith('action=building_hierarchy'), url);
        await new Promise(resolve => { releaseSave = resolve; });
        return Response.json({ ok: false, error: '保存を拒否しました' }, { status: 400 });
    };
    const panel = () => document.querySelector('.building-view');
    const choice = name => get(`unsaved-changes-${name}`);
    const beginAlignment = async () => {
        await openBuildingView(1);
        await panel().querySelectorAll('button').find(button => button.textContent === '位置合わせモード').click();
        const offset = panel().querySelectorAll('label').find(label => label.textContent === 'X移動').querySelector('input');
        offset.value = '28';
        await offset.dispatch('input');
        return offset;
    };
    get('palette-place-btn').disabled = true;
    const offset = await beginAlignment();
    const history = get('placement-history');
    assert.equal(history.inert, true, '操作履歴を建物ビューの共有操作に含めない');
    for (const id of ['loadBtn', 'saveBtn', 'device-search-input', 'view-copy-link-btn', 'toolbar-brand-trigger',
        'placement-history-trigger', 'palette-place-btn', 'world']) {
        const node = get(id);
        const event = await events.dispatch('keydown', { target: node, key: 'Enter' });
        assert.equal(event.stopped, true, id);
        assert.equal(document.activeElement.textContent, '建物ビューを閉じる');
    }
    assert.equal(get('tool-palette').inert, true);
    for (const id of ['view-search-input', 'dashboard-btn', 'ledgerBtn', 'help-btn', 'backup-export-btn', 'logout-btn']) {
        let node = get(id);
        for (; node; node = node.parentElement) assert.notEqual(node.inert, true, id);
        const event = await events.dispatch('keydown', { target: get(id), key: 'Enter' });
        assert.notEqual(event.stopped, true, id);
    }

    manageMenu.open = true;
    await panel().dispatch('click');
    assert.equal(manageMenu.open, false, '建物ビュー内のクリックでメニューを閉じる');
    manageMenu.open = true;
    await events.dispatch('keydown', { key: 'Escape', target: get('backup-export-btn') });
    assert.equal(manageMenu.open, false);
    assert.equal(document.activeElement, manageMenu.querySelector('summary'));
    userMenu.open = true;
    await events.dispatch('keydown', { key: 'Escape', target: offset });
    assert.equal(userMenu.open, false, '建物ビュー内からの Esc でもメニューを閉じる');
    await get('help-btn').click();
    assert.deepEqual(opens, ['help.html']);
    assert.equal(getOpenBuildingId(), 1);
    assert.equal(offset.value, '28');

    userMenu.open = true;
    const cancelledLogout = logoutForm.requestSubmit(logout);
    await setImmediate();
    assert.ok(choice('cancel'), 'ログアウトの POST 前に三択を出す');
    assert.equal(userMenu.open, false);
    await choice('cancel').click(); await cancelledLogout;
    assert.deepEqual(logouts, []);
    assert.equal(getOpenBuildingId(), 1);
    assert.equal(offset.value, '28');
    assert.equal(document.activeElement, userMenu.querySelector('summary'));

    const settings = get('link-display-settings-btn');
    const settingsOverlay = get('link-display-settings-overlay');
    manageMenu.open = true;
    const failedNavigation = settings.click();
    await setImmediate();
    assert.ok(choice('save'));
    await choice('save').click(); await setImmediate();
    assert.ok(releaseSave);
    await get('ledgerBtn').click();
    assert.equal(ledger.hidden, true, '保存中に別の画面を開かない');
    releaseSave(); await failedNavigation;
    assert.equal(settingsOverlay.hidden, true);
    assert.equal(getOpenBuildingId(), 1);
    assert.equal(offset.value, '28');

    const exporting = get('backup-export-btn').click();
    await setImmediate();
    assert.deepEqual(exports, [], '確認前に出力を開始しない');
    assert.ok(choice('discard'));
    await choice('discard').click(); await exporting;
    assert.deepEqual(exports, [null], '建物ビューを閉じた後にだけ出力を開始する');
    assert.equal(get('tool-palette').inert, false);
    assert.equal(history.inert, false);
    assert.equal(get('palette-place-btn').disabled, true, '閉じても既存の disabled は維持する');

    window.APP_CONFIG.user.isAdmin = false;
    await openBuildingView(1);
    await get('ledgerBtn').click();
    assert.equal(getOpenBuildingId(), null);
    assert.equal(ledger.hidden, false);
    assert.equal(ledger.inert, false);
    assert.equal(document.activeElement, ledgerSearch);
    await window.closeLedger();
    await openBuildingView(1);
    userMenu.open = true;
    await get('password-change-btn').click();
    assert.equal(getOpenBuildingId(), null);
    assert.equal(get('account-overlay').hidden, false);
    assert.equal(document.activeElement, get('own-current-password'));
    await get('close-account-management-btn').click();
    assert.equal(document.activeElement, userMenu.querySelector('summary'));

    await openBuildingView(1);
    await logoutForm.requestSubmit(logout); await setImmediate();
    assert.deepEqual(logouts, [null], '送信の再開は建物ビューを閉じた後の 1 回だけ');
});

test('機器検索の候補を絞ると旧候補への参照が外れ、矢印キーで新候補を選べる', async t => {
    const keys = ['window', 'document', 'Element', 'HTMLElement'];
    const globals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const { get } = installWorkspaceDom({
        templates: ['templates/components/toolbar.php'],
        phpSetup: "require 'version.php'; $username = 'テスト利用者'; $userRole = 'admin'; $csrfToken = 'test-only-token';"
    });
    const { appState, normalizeDevice } = await import('../public/js/core/state.js');
    const { closeDeviceSearchPopup, initializeDeviceSearch } = await import('../public/js/modals/device-search-modal.js');
    const previousDevices = appState.devices;
    t.after(() => {
        closeDeviceSearchPopup();
        appState.devices = previousDevices;
        for (const [key, descriptor] of globals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    });
    appState.devices = [
        normalizeDevice({ id: 1, name: 'Alpha' }),
        normalizeDevice({ id: 2, name: 'Beta' })
    ];
    initializeDeviceSearch();
    const input = get('device-search-input');
    input.focus();
    input.value = 'a';
    await input.dispatch('input');
    await input.dispatch('keydown', { key: 'ArrowDown' });
    await input.dispatch('keydown', { key: 'ArrowDown' });
    const previous = input.getAttribute('aria-activedescendant');
    assert.equal(get(previous).dataset.deviceId, '2');

    input.value = 'al';
    await input.dispatch('input');
    assert.equal(get(previous), null);
    assert.equal(input.getAttribute('aria-activedescendant'), null);
    assert.equal(input.getAttribute('aria-expanded'), 'true');
    assert.equal(document.activeElement, input);
    await input.dispatch('keydown', { key: 'ArrowDown' });
    assert.equal(get(input.getAttribute('aria-activedescendant')).dataset.deviceId, '1');
});
