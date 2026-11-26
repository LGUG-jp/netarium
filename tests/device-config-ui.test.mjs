import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { installWorkspaceDom } from './helpers/workspace-dom.mjs';

const getConfigTab = () => document.getElementById('ledger-sheet-tabs').querySelector('[data-tab-key="config"]');
const getConfigPanel = () => document.getElementById(getConfigTab().getAttribute('aria-controls'));

test('個票Configタブの登録・閲覧・検索・コピー・…メニュー削除と権限・失敗保持を統合検証する', async t => {
    const keys = ['window', 'document', 'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement',
        'HTMLTextAreaElement', 'HTMLButtonElement', 'localStorage', 'fetch', 'navigator'];
    const originals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const dom = installWorkspaceDom({ templates: ['templates/modals/ledger.php', 'templates/components/toast.php'], phpSetup: '$isAdmin = true;' });
    class Input extends globalThis.Element {}
    globalThis.HTMLInputElement = globalThis.HTMLSelectElement = globalThis.HTMLTextAreaElement = globalThis.HTMLButtonElement = Input;
    globalThis.localStorage = { getItem: () => null, setItem() {} };
    const { appState, normalizeDevice, normalizeView } = await import('../public/js/core/state.js');
    const resources = await import('../public/js/core/resource-save.js');
    const drafts = await import('../public/js/core/device-drafts.js');
    const queue = await import('../public/js/core/save-queue.js');
    const ledger = await import('../public/js/modals/ledger-modal.js');
    const { initModalFocusTrap, getTopModalContainer, requestModalClose } = await import('../public/js/core/modal-focus.js');
    const { onKeyDown } = await import('../public/js/canvas/selection.js');
    initModalFocusTrap();

    let copied = '';
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async value => { copied = value; } } } });
    let revision = 0, items = [], failSave = null, failDelete = null, pendingSave = null, request = [];
    const deviceData = normalizeDevice({ id: 10, resource_revision: 7, name: '<script>device</script>', type: 'switch' });
    const snapshot = () => ({ ok: true, device_id: 10, device_revision: deviceData.resource_revision, data_revision: 100 + revision, revision, items: structuredClone(items) });

    globalThis.fetch = async (url, options = {}) => {
        const action = new URL(String(url), 'http://localhost').searchParams.get('action');
        const payload = options.body ? JSON.parse(options.body) : null;
        request.push({ action, payload });
        if (action === 'save_resources') {
            deviceData.resource_revision++;
            return new Response(JSON.stringify({
                ok: true, revision: 100, id_maps: {},
                devices: payload.devices.map(row => ({ ...row.device, resource_revision: deviceData.resource_revision })),
                views: [], placements: [], view_link_routes: [], canvas_notes: [],
                deleted_device_ids: [], deleted_view_ids: [], affected_view_ids: []
            }), { status: 200 });
        }
        if (action === 'save_device_config' && pendingSave) await pendingSave;
        const failure = action === 'save_device_config' ? failSave : action === 'delete_device_configs' ? failDelete : null;
        if (failure) return new Response(JSON.stringify({ ok: false, error: 'private-body-must-not-be-echoed' }), { status: failure });
        if (action === 'save_device_config') {
            const id = revision + 1;
            items.unshift({ id, generation: id, content: payload.content, memo: payload.memo, actor_name: '<b>admin</b>', created_at: `2026-10-31T12:00:0${id}Z` });
            revision++;
        } else if (action === 'delete_device_configs') {
            items = items.filter(item => !payload.ids.includes(item.id));
            revision++;
        }
        return new Response(JSON.stringify(snapshot()), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const byText = (root, text) => root.querySelectorAll('button').find(button => button.textContent === text);
    const openConfigTab = async () => {
        await getConfigTab().click();
        await ledger.getConfigLoadPromise();
    };
    const closeSheetForce = async () => {
        const cancel = document.getElementById('device-config-confirm-overlay')?.querySelectorAll('button').find(el => el.textContent === 'キャンセル');
        if (cancel) await cancel.click();
        const closing = ledger.closeLedgerDetailPane();
        await setImmediate();
        const discard = document.getElementById('unsaved-changes-discard');
        if (discard) await discard.click();
        return closing;
    };

    t.after(async () => {
        failSave = null; pendingSave = null;
        queue.clearPendingSave();
        drafts.discardDeviceDrafts();
        await closeSheetForce();
        for (const [key, value] of originals) {
            if (value) Object.defineProperty(globalThis, key, value); else delete globalThis[key];
        }
    });

    queue.clearPendingSave();
    drafts.discardDeviceDrafts();
    Object.assign(appState, {
        authExpired: false, isPinging: false, dataRevision: 0,
        appStatus: { dirty: false, state: 'saved' },
        resourceConflicts: { devices: new Map(), views: new Map() },
        devices: [deviceData], views: [normalizeView({ id: 1, name: '合成ビュー', view_type: 'topology', resource_revision: 1 })],
        currentViewId: 1, placements: [], links: [], canvasNotes: [],
        rackMounts: [], rackShelfDevices: [], deviceImages: []
    });
    resources.resetResourceBaseline(appState);

    // 専用Configモーダル起動ボタンが廃止されていること
    assert.equal(document.getElementById('ledger-sheet-config-btn'), null, '操作バーの専用Config起動ボタンは削除されている');

    // 閲覧者にはConfigタブを公開せず、APIも呼ばない
    window.APP_CONFIG.user = { role: 'viewer', isAdmin: false };
    await ledger.openLedgerDetail(10);
    assert.equal(getConfigTab(), null);
    assert.equal(request.length, 0);
    await ledger.closeLedgerDetailPane();

    // 未保存（仮ID）機器でConfigタブを開いてもAPIを呼ばず案内のみ表示
    window.APP_CONFIG.user = { role: 'admin', isAdmin: true };
    const tempDevice = normalizeDevice({ id: -1, resource_revision: 0, name: '未保存機器', type: 'switch' });
    appState.devices.push(tempDevice);
    await ledger.openLedgerDetail(-1);
    await getConfigTab().click();
    assert.equal(request.length, 0);
    assert.match(getConfigPanel().textContent, /保存後にConfigを利用できます/);
    await ledger.closeLedgerDetailPane();
    appState.devices = [deviceData];

    // 管理者として実機器を開き、通常時は共通保存ボタンが非表示であること
    await ledger.openLedgerDetail(10);
    const sheetOverlay = document.getElementById('ledger-device-sheet-overlay');
    assert.equal(document.getElementById('ledger-sheet-save-btn').hidden, true, '通常時は個票の保存ボタンが非表示');
    assert.equal(document.getElementById('ledger-sheet-save-status').hidden, true);
    assert.equal(request.length, 0, '基本タブ表示中はConfig APIを遅延読み込みしない');

    await openConfigTab();
    const configPanel = getConfigPanel();
    assert.equal(configPanel.hidden, false);
    assert.equal(document.getElementById('ledger-sheet-body').dataset.activeTab, 'config');
    assert.equal(request.filter(r => r.action === 'load_device_configs').length, 1);
    assert.ok(configPanel.querySelector('.device-config-history-empty'), '画面①：未登録時も左側に履歴エリアの空表示が存在');
    assert.match(configPanel.querySelector('.device-config-history-empty').textContent, /登録されたConfigはまだありません/);
    assert.ok(configPanel.querySelector('.device-config-empty-state'), '画面①：右側中央に未登録空状態が存在');
    assert.match(configPanel.textContent, /Configが登録されていません/);
    assert.equal(configPanel.querySelector('input[type="checkbox"]'), null);
    assert.equal(configPanel.querySelector('script'), null);

    // 上段左右の配置順：[Config本文][差分比較] ... […][新しい版を登録]
    const toolbar = document.getElementById('device-config-toolbar');
    const toolbarActions = toolbar.querySelector('.device-config-toolbar-actions');
    assert.equal(toolbarActions.children[0].id, 'device-config-more-menu');
    assert.equal(toolbarActions.children[1].id, 'device-config-register');

    // 個票の基本情報を変更・保存した後でも Config 登録が最新 device_revision で通ること
    await document.getElementById('ledger-sheet-tab-0').click();
    const nameInput = document.getElementById('ledger-sheet-body').querySelector('[data-field="name"]');
    nameInput.value = '<script>device-updated</script>';
    await nameInput.dispatch('input');
    assert.equal(document.getElementById('ledger-sheet-save-btn').hidden, false);
    assert.equal(document.getElementById('ledger-sheet-save-btn').textContent, '適用');
    // タブ切替だけでは暗黙に適用・破棄されない
    await getConfigTab().click();
    assert.equal(drafts.hasDeviceDraftChanges('sheet', 10), true);
    assert.equal(await ledger.saveLedgerSheet(), true);
    assert.equal(document.getElementById('ledger-sheet-save-btn').hidden, true);
    assert.equal(deviceData.resource_revision, 8);

    // 新しい版を登録
    await document.getElementById('device-config-register').click();
    let editor = document.getElementById('device-config-editor');
    assert.equal(editor.value, '');
    editor.value = '<script>not executable</script>\r\nhostname example'; await editor.dispatch('input');
    let draftText = editor.value;
    const memo = document.getElementById('device-config-memo'); memo.value = 'テスト版'; await memo.dispatch('input');
    assert.ok(configPanel.querySelector('.device-config-warning-box'));
    assert.ok(configPanel.querySelector('.device-config-sidebar'));
    assert.equal(document.getElementById('device-config-memo-count').textContent, '4/200');

    // ファイル読込と保存失敗・409・二重送信防止
    let releaseFile;
    const file = document.getElementById('device-config-file');
    const buffer = new Promise(resolve => { releaseFile = resolve; });
    file.files = [{ size: 40, arrayBuffer: () => buffer }];
    window.confirm = () => true;
    const reading = file.dispatch('change');
    assert.equal(document.getElementById('device-config-save').disabled, true);
    const beforeReadSave = request.length;
    await document.getElementById('device-config-save').dispatch('click');
    assert.equal(request.length, beforeReadSave);
    releaseFile(new TextEncoder().encode('hostname file-selected\n<script>literal</script>').buffer);
    await reading;
    draftText = document.getElementById('device-config-editor').value;
    assert.equal(draftText, 'hostname file-selected\n<script>literal</script>');

    failSave = 500;
    await document.getElementById('device-config-save').click();
    assert.equal(document.getElementById('device-config-editor').value, draftText);
    assert.doesNotMatch(configPanel.textContent, /private-body/);

    failSave = 409;
    await document.getElementById('device-config-save').click();
    assert.equal(document.getElementById('device-config-save').disabled, true);
    assert.equal(document.getElementById('device-config-editor').value, draftText);
    await document.getElementById('device-config-reload').click();
    assert.equal(document.getElementById('device-config-editor').value, draftText);
    failSave = null;

    let release;
    pendingSave = new Promise(resolve => { release = resolve; });
    const firstSave = document.getElementById('device-config-save').click();
    assert.equal(document.getElementById('device-config-save').disabled, true);
    assert.equal(document.getElementById('ledger-sheet-prev-btn').disabled, true);
    assert.equal(document.getElementById('close-ledger-detail-pane-btn').disabled, true);
    const saveCount = request.filter(row => row.action === 'save_device_config').length;
    await document.getElementById('device-config-save').dispatch('click');
    assert.equal(request.filter(row => row.action === 'save_device_config').length, saveCount);
    release(); await firstSave; pendingSave = null;
    assert.equal(request.at(-1).payload.expected_device_revision, 8, '基本情報保存後の最新device_revisionを使う');
    assert.equal(document.getElementById('device-config-text').value, draftText.replace(/\r\n/g, '\n'));
    assert.equal(appState.dataRevision, 101);
    assert.equal(document.getElementById('device-config-compare').disabled, true);
    await document.getElementById('device-config-copy').click();
    assert.equal(copied, draftText.replace(/\r\n/g, '\n'));
    assert.equal(configPanel.querySelector('script'), null);

    // 本文検索
    const search = document.getElementById('device-config-search');
    const searchStatus = document.getElementById('device-config-search-status');
    search.value = 'host';
    await search.dispatch('input');
    assert.equal(searchStatus.textContent, '');
    const text = document.getElementById('device-config-text');
    assert.notEqual(document.activeElement, text);
    search.value = 'hostname';
    await byText(configPanel, '次を検索').click();
    assert.equal(text.value.slice(text.selectionStart, text.selectionEnd), 'hostname');
    assert.equal(searchStatus.textContent, '1 / 1件');
    await text.dispatch('keydown', { key: 'Enter' });
    assert.equal(searchStatus.textContent, '1 / 1件');
    search.value = 'nonexistent';
    await byText(configPanel, '次を検索').click();
    assert.equal(searchStatus.textContent, '0件');

    // 2版目登録・差分比較
    await document.getElementById('device-config-register').click();
    editor = document.getElementById('device-config-editor');
    assert.equal(editor.value, copied);
    editor.value += '\ninterface test'; await editor.dispatch('input');
    await document.getElementById('device-config-save').click();
    await document.getElementById('device-config-compare').click();
    assert.match(configPanel.querySelector('.device-config-diff').textContent, /interface test/);
    await byText(configPanel, 'Config本文').click();
    await configPanel.querySelector('[data-version-id="1"]').click();
    assert.equal(document.getElementById('device-config-text').value, copied);

    // ［…］補助操作メニューと Esc 閉鎖、履歴削除
    const moreBtn = document.getElementById('device-config-more-btn');
    const morePopup = document.getElementById('device-config-more-popup');
    assert.equal(morePopup.hidden, true);
    assert.equal(moreBtn.getAttribute('aria-expanded'), 'false');
    await moreBtn.click();
    assert.equal(morePopup.hidden, false);
    assert.equal(moreBtn.getAttribute('aria-expanded'), 'true');
    // Esc でまずメニューだけ閉じ、個票モーダル自体は開いたままにする
    await onKeyDown({ key: 'Escape', preventDefault() {}, stopImmediatePropagation() {} });
    assert.equal(morePopup.hidden, true);
    assert.equal(sheetOverlay.hidden, false);
    assert.equal(document.activeElement, moreBtn);

    await moreBtn.click();
    const deleteModeBtn = document.getElementById('device-config-delete-mode');
    assert.ok(morePopup.contains(deleteModeBtn), '履歴を削除は…メニュー内に配置される');
    await deleteModeBtn.click();
    assert.equal(morePopup.hidden, true);
    assert.equal(document.getElementById('device-config-delete-selected').disabled, true);
    assert.ok(document.getElementById('device-config-toolbar').contains(document.getElementById('device-config-delete-banner')));
    await document.getElementById('device-config-select-all').click();
    assert.match(document.getElementById('device-config-delete-banner').textContent, /2件選択中/);
    await document.getElementById('device-config-delete-selected').click();
    const confirm = document.getElementById('device-config-confirm-overlay');
    assert.match(confirm.textContent, /全2件/);
    assert.match(confirm.textContent, /機器本体は削除しません/);
    await requestModalClose();
    assert.equal(document.getElementById('device-config-confirm-overlay'), null);

    // 409削除失敗→再読込→選択削除→全削除
    failDelete = 409;
    await document.getElementById('device-config-delete-selected').click();
    await document.getElementById('device-config-delete-confirm').click();
    assert.equal(items.length, 2);
    failDelete = null;
    await document.getElementById('device-config-reload').click();
    await document.getElementById('device-config-more-btn').click();
    await document.getElementById('device-config-delete-mode').click();
    const checkbox = configPanel.querySelector('input[data-config-id="2"]'); checkbox.checked = true; await checkbox.dispatch('change');
    await document.getElementById('device-config-delete-selected').click();
    await document.getElementById('device-config-delete-confirm').click();
    assert.deepEqual(items.map(row => row.id), [1]);
    await document.getElementById('device-config-more-btn').click();
    await document.getElementById('device-config-delete-mode').click();
    await document.getElementById('device-config-select-all').click();
    await document.getElementById('device-config-delete-selected').click();
    await document.getElementById('device-config-delete-confirm').click();
    assert.match(configPanel.textContent, /Configが登録されていません/);
    assert.equal(items.length, 0);

    // 5世代上限の警告と自動削除トースト
    items = [
        { id: 5, generation: 5, content: 'v5 content', memo: '', actor_name: 'admin', created_at: '2026-10-31T15:00:00Z' },
        { id: 4, generation: 4, content: 'v4 content', memo: '', actor_name: 'admin', created_at: '2026-10-31T14:00:00Z' },
        { id: 3, generation: 3, content: 'v3 content', memo: '', actor_name: 'admin', created_at: '2026-10-31T13:00:00Z' },
        { id: 2, generation: 2, content: 'v2 content', memo: '', actor_name: 'admin', created_at: '2026-10-31T12:00:00Z' },
        { id: 1, generation: 1, content: 'v1 oldest', memo: '', actor_name: 'admin', created_at: '2026-10-31T11:00:00Z' }
    ];
    revision = 5;
    await ledger.closeLedgerDetailPane();
    await ledger.openLedgerDetail(10);
    assert.equal(document.getElementById('ledger-sheet-body').dataset.activeTab, 'primary', '閉鎖後に開き直すと先頭タブへ戻る');
    await openConfigTab();
    await document.getElementById('device-config-register').click();
    const retentionWarn = document.getElementById('device-config-retention-warning');
    assert.equal(retentionWarn.hidden, true);
    editor = document.getElementById('device-config-editor');
    editor.value = 'v6 changed content';
    await editor.dispatch('input');
    assert.equal(retentionWarn.hidden, false);
    assert.match(retentionWarn.textContent, /保存上限（5世代）に達しています/);
    await document.getElementById('device-config-save').click();
    assert.match(document.body.textContent, /最も古い履歴を1件削除しました/);
    await ledger.closeLedgerDetailPane();
    assert.equal(sheetOverlay.hidden, true);
    assert.equal(getTopModalContainer(), null);
});

test('Config差分の両側検索・循環移動・比較切替と差分ブロック移動を安全に処理する', async t => {
    const keys = ['window', 'document', 'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement',
        'HTMLTextAreaElement', 'HTMLButtonElement', 'localStorage', 'fetch'];
    const originals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    installWorkspaceDom({ templates: ['templates/modals/ledger.php'], phpSetup: '$isAdmin = true;' });
    class Input extends globalThis.Element {}
    globalThis.HTMLInputElement = globalThis.HTMLSelectElement = globalThis.HTMLTextAreaElement = globalThis.HTMLButtonElement = Input;
    globalThis.localStorage = { getItem: () => null, setItem() {} };
    const { appState, normalizeDevice } = await import('../public/js/core/state.js');
    const resources = await import('../public/js/core/resource-save.js');
    const ledger = await import('../public/js/modals/ledger-modal.js');
    Object.assign(appState, {
        authExpired: false, isPinging: false, dataRevision: 0,
        appStatus: { dirty: false, state: 'saved' },
        resourceConflicts: { devices: new Map(), views: new Map() },
        devices: [normalizeDevice({ id: 10, resource_revision: 7, name: 'test', type: 'switch' })],
        views: [], placements: [], links: [], canvasNotes: [],
        rackMounts: [], rackShelfDevices: [], deviceImages: []
    });
    resources.resetResourceBaseline(appState);
    window.APP_CONFIG.user = { role: 'admin', isAdmin: true };
    const latest = 'shared needle needle\nadded needle\nanchor\nlast <img src=x onerror=alert(1)>';
    const contents = [latest, 'shared needle needle\nremoved needle\nanchor\nlast old', latest, 'x\n'.repeat(4001)];
    let items = contents.map((content, index) => ({
        id: 4 - index, generation: 4 - index, content, memo: '', actor_name: 'needle-header-only',
        created_at: '2026-11-01T00:00:00Z',
    }));
    globalThis.fetch = async () => new Response(JSON.stringify({
        ok: true, revision: 4, device_revision: 7, items,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    t.after(async () => {
        await ledger.closeLedgerDetailPane();
        for (const [key, value] of originals) {
            if (value) Object.defineProperty(globalThis, key, value); else delete globalThis[key];
        }
    });
    await ledger.openLedgerDetail(10);
    await getConfigTab().click();
    await ledger.getConfigLoadPromise();
    const get = id => document.getElementById(`device-config-diff-${id}`);
    await document.getElementById('device-config-compare').click();
    const diff = document.querySelector('.device-config-diff');
    const originalText = diff.textContent;
    const search = get('search');
    const status = get('search-status');
    const side = () => document.querySelector('.device-config-diff-search-side').textContent;
    const mark = () => diff.querySelector('mark');
    search.focus();
    search.value = 'needle';
    await search.dispatch('input');
    assert.equal(mark(), null);
    await search.dispatch('keydown', { key: 'Enter', isComposing: true });
    assert.equal(mark(), null);
    await search.dispatch('keydown', { key: 'Enter' });
    assert.equal(status.textContent, '1 / 6件');
    assert.equal(side(), '比較元');
    assert.equal(mark().textContent, 'needle');
    for (let index = 2; index <= 6; index++) {
        await get('search-next').click();
        assert.equal(status.textContent, `${index} / 6件`);
        assert.equal(diff.querySelectorAll('mark').length, 1);
    }
    await get('search-next').click();
    assert.equal(status.textContent, '1 / 6件');
    assert.equal(diff.textContent, originalText);

    assert.equal(get('position').textContent, '0 / 2');
    await get('next').click();
    assert.equal(get('position').textContent, '1 / 2');
    await get('next').click();
    assert.equal(get('position').textContent, '2 / 2');
    await get('next').click();
    assert.equal(get('position').textContent, '1 / 2');
    await get('previous').click();
    assert.equal(get('position').textContent, '2 / 2');

    let select = get('source-select');
    select.value = '2'; await select.dispatch('change');
    assert.match(document.querySelector('.device-config-diff-pane').textContent, /差分はありません/);
    select = get('source-select');
    select.value = '1'; await select.dispatch('change');
    assert.match(document.querySelector('.device-config-diff-pane').textContent, /比較できません/);
    select = get('source-select');
    select.value = '3'; await select.dispatch('change');
    assert.equal(get('search').value, '');

    const multiItems = [
        { id: 20, generation: 2, content: 'header\nline1-new\nline2-new\nline3-new\nfooter', memo: '', actor_name: 'admin', created_at: '2026-11-01T02:00:00Z' },
        { id: 10, generation: 1, content: 'header\nline1-old\nline2-old\nline3-old\nfooter', memo: '', actor_name: 'admin', created_at: '2026-11-01T01:00:00Z' }
    ];
    items = multiItems;
    await ledger.closeLedgerDetailPane();
    await ledger.openLedgerDetail(10);
    await getConfigTab().click();
    await ledger.getConfigLoadPromise();
    await document.getElementById('device-config-compare').click();
    const multiDiff = document.querySelector('.device-config-diff');
    await get('next').click();
    const currentDiffRows = multiDiff.querySelectorAll('.is-current-diff');
    assert.equal(currentDiffRows.length, 3);
    assert.ok(currentDiffRows[0].classList.contains('is-diff-block-start'));
    assert.equal(currentDiffRows[1].classList.contains('is-diff-block-start'), false);
    assert.ok(currentDiffRows[2].classList.contains('is-diff-block-end'));
});
