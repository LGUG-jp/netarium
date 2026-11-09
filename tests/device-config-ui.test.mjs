import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installWorkspaceDom } from './helpers/workspace-dom.mjs';

test('Config登録の失敗・競合時に入力を保持し、選択削除を確認してから実行、元個票へ復帰する', async t => {
    const keys = ['window', 'document', 'Element', 'HTMLElement', 'fetch', 'navigator'];
    const originals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const dom = installWorkspaceDom({ templates: ['templates/modals/ledger.php', 'templates/components/toast.php'], phpSetup: '$isAdmin = true;' });
    const { appState } = await import('../public/js/core/state.js');
    const { openDeviceConfig, closeDeviceConfig } = await import('../public/js/modals/device-config-modal.js');
    const { getTopModalContainer, requestModalClose } = await import('../public/js/core/modal-focus.js');
    Object.assign(appState, { authExpired: false, dataRevision: 0, appStatus: { dirty: false, state: 'saved' } });
    let copied = '';
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async value => { copied = value; } } } });
    const device = { id: 10, resource_revision: 7, name: '<script>device</script>' };
    const parent = document.getElementById('ledger-device-sheet-overlay'); parent.hidden = false;
    const request = [];
    let revision = 0, items = [], failSave = null, failDelete = null, pendingSave = null;
    const snapshot = () => ({ ok: true, device_id: 10, device_revision: 7, data_revision: 100 + revision, revision, items: structuredClone(items) });
    globalThis.fetch = async (url, options = {}) => {
        const action = new URL(String(url), 'http://localhost').searchParams.get('action');
        const payload = options.body ? JSON.parse(options.body) : null;
        request.push({ action, payload });
        if (action === 'save_device_config' && pendingSave) await pendingSave;
        let failure = action === 'save_device_config' ? failSave : action === 'delete_device_configs' ? failDelete : null;
        if (failure) return new Response(JSON.stringify({ ok: false, error: 'private-body-must-not-be-echoed' }), { status: failure });
        if (action === 'save_device_config') {
            const id = revision + 1;
            items.unshift({ id, generation: id, content: payload.content, memo: payload.memo, actor_name: '<b>admin</b>', created_at: `2026-10-31T12:00:0${id}Z` });
            revision++;
        } else if (action === 'delete_device_configs') {
            items = items.filter(item => !payload.ids.includes(item.id)); revision++;
        }
        return new Response(JSON.stringify(snapshot()), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const byText = (root, text) => root.querySelectorAll('button').find(button => button.textContent === text);
    t.after(async () => {
        failSave = null; pendingSave = null;
        const cancel = document.getElementById('device-config-confirm-overlay')?.querySelectorAll('button').find(el => el.textContent === 'キャンセル');
        if (cancel) await cancel.click();
        if (document.getElementById('device-config-editor')) {
            const editor = document.getElementById('device-config-editor'); editor.value = ''; await editor.dispatch('input');
            const memo = document.getElementById('device-config-memo'); memo.value = ''; await memo.dispatch('input');
        }
        await closeDeviceConfig();
        for (const [key, value] of originals) { if (value) Object.defineProperty(globalThis, key, value); else delete globalThis[key]; }
    });

    window.APP_CONFIG.user = { role: 'viewer', isAdmin: false };
    assert.equal(await openDeviceConfig(device), false);
    assert.equal(request.length, 0);
    window.APP_CONFIG.user = { role: 'admin', isAdmin: true };
    assert.equal(await openDeviceConfig({ ...device, resource_revision: 0 }), false);
    document.getElementById('ledger-sheet-config-btn').focus();
    assert.equal(await openDeviceConfig(device), true);
    const overlay = document.getElementById('device-config-overlay');
    assert.equal(document.getElementById('device-config-name').textContent, device.name, '対象機器名が動的に表示される');
    assert.ok(overlay.querySelector('.device-config-history-empty'), '画面①：未登録時も左側に履歴エリアの空表示が存在');
    assert.match(overlay.querySelector('.device-config-history-empty').textContent, /登録されたConfigはまだありません/);
    assert.ok(overlay.querySelector('.device-config-empty-state'), '画面①：右側中央に未登録空状態が存在');
    assert.equal(parent.hidden, true);
    assert.match(overlay.textContent, /Configが登録されていません/);
    assert.equal(overlay.querySelector('input[type="checkbox"]'), null);
    assert.equal(overlay.querySelector('script'), null);
    await document.getElementById('device-config-register').click();
    let editor = document.getElementById('device-config-editor');
    assert.equal(editor.value, '');
    editor.value = '<script>not executable</script>\r\nhostname example'; await editor.dispatch('input');
    let draftText = editor.value;
    const memo = document.getElementById('device-config-memo'); memo.value = 'テスト版'; await memo.dispatch('input');
    let releaseFile;
    assert.ok(overlay.querySelector('.device-config-warning-box'), '画面②：登録上部に警告注意枠が表示される');
    assert.ok(overlay.querySelector('.device-config-sidebar'), '画面②：編集中も左側履歴サイドバーのレイアウトを維持');
    assert.equal(document.getElementById('device-config-memo-count').textContent, '4/200', '画面②：メモの文字数カウンタが表示される');
    const file = document.getElementById('device-config-file');
    const buffer = new Promise(resolve => { releaseFile = resolve; });
    file.files = [{ size: 40, arrayBuffer: () => buffer }];
    window.confirm = () => true;
    const reading = file.dispatch('change');
    assert.equal(document.getElementById('device-config-save').disabled, true, 'ファイル読込中は保存できない');
    const beforeReadSave = request.length;
    await document.getElementById('device-config-save').dispatch('click');
    assert.equal(request.length, beforeReadSave, '読込途中の古い本文を送信しない');
    releaseFile(new TextEncoder().encode('hostname file-selected\n<script>literal</script>').buffer);
    await reading;
    draftText = document.getElementById('device-config-editor').value;
    assert.equal(draftText, 'hostname file-selected\n<script>literal</script>');
    assert.equal(document.getElementById('device-config-save').disabled, false);
    failSave = 500;
    await document.getElementById('device-config-save').click();
    assert.equal(document.getElementById('device-config-editor').value, draftText);
    assert.doesNotMatch(overlay.textContent, /private-body/);
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
    const saveCount = request.filter(row => row.action === 'save_device_config').length;
    await document.getElementById('device-config-save').dispatch('click');
    assert.equal(request.filter(row => row.action === 'save_device_config').length, saveCount);
    release(); await firstSave; pendingSave = null;
    assert.equal(document.getElementById('device-config-text').value, draftText.replace(/\r\n/g, '\n'));
    assert.equal(appState.dataRevision, 101, 'Config変更後の画像API等が送る全体revisionを同期する');
    assert.equal(document.getElementById('device-config-compare').disabled, true);
    assert.ok(overlay.querySelector('.device-config-viewer-tools'), '画面③：本文表示領域上部に検索ツールバー');
    assert.ok(document.getElementById('device-config-search'), '画面③：検索入力欄');
    assert.ok(document.getElementById('device-config-copy'), '画面③：全文コピーボタン');
    assert.ok(document.getElementById('device-config-delete-mode'), '画面③：上部操作バーに履歴削除ボタン');
    await document.getElementById('device-config-copy').click();
    assert.equal(copied, draftText.replace(/\r\n/g, '\n'));
    assert.equal(overlay.querySelector('script'), null);

    const search = document.getElementById('device-config-search');
    const searchStatus = document.getElementById('device-config-search-status');
    assert.ok(search.classList.contains('input-sm'), '検索欄にinput-smクラスが付与されている');

    // 文字入力時にフォーカスが外れず、ステータスがリセットされることを確認
    search.value = 'host';
    await search.dispatch('input');
    assert.equal(searchStatus.textContent, '', '文字入力中はステータスを空にリセット');
    const text = document.getElementById('device-config-text');
    assert.notEqual(document.activeElement, text, '文字入力中に本文へフォーカスを奪わない');

    // 「次を検索」押下で検索実行・ハイライト確認
    search.value = 'hostname';
    await byText(overlay, '次を検索').click();
    assert.equal(text.value.slice(text.selectionStart, text.selectionEnd), 'hostname');
    assert.equal(searchStatus.textContent, '1 / 1件', '検索結果が現在位置/総一致件数で表示される');
    assert.equal(document.activeElement, text, '検索実行時は一致箇所をハイライトするため本文へフォーカス');

    // Enterキーで検索実行
    search.value = 'host';
    await search.dispatch('keydown', { key: 'Enter' });
    assert.equal(text.value.slice(text.selectionStart, text.selectionEnd), 'host');
    assert.equal(searchStatus.textContent, '1 / 1件', 'Enterキーで検索を実行できる');
    assert.equal(document.activeElement, text, 'Enter押下時も一致箇所をハイライト');

    // 本文フォーカス時もEnterキーで継続検索可能
    await text.dispatch('keydown', { key: 'Enter' });
    assert.equal(text.value.slice(text.selectionStart, text.selectionEnd), 'host');
    assert.equal(searchStatus.textContent, '1 / 1件', '本文フォーカス時もEnterで検索を継続できる');
    assert.equal(document.activeElement, text, '継続検索時も本文のハイライトを維持');

    search.value = 'nonexistent';
    await byText(overlay, '次を検索').click();
    assert.equal(searchStatus.textContent, '0件', '未一致時は0件と表示される');

    await document.getElementById('device-config-register').click();
    editor = document.getElementById('device-config-editor');
    assert.equal(editor.value, copied);
    editor.value += '\ninterface test'; await editor.dispatch('input');
    await document.getElementById('device-config-save').click();
    await document.getElementById('device-config-compare').click();
    assert.match(overlay.querySelector('.device-config-diff').textContent, /interface test/);
    assert.equal(overlay.querySelector('select').options.length, 1);
    await byText(overlay, 'Config本文').click();
    await overlay.querySelector('[data-version-id="1"]').click();
    assert.equal(document.getElementById('device-config-text').value, copied);
    await document.getElementById('device-config-copy').click(); assert.equal(copied, items[1].content);

    const toolbarBefore = document.getElementById('device-config-toolbar');
    await document.getElementById('device-config-delete-mode').click();
    assert.equal(document.getElementById('device-config-delete-selected').disabled, true);
    assert.ok(toolbarBefore.contains(document.getElementById('device-config-tab-view')), 'タブは削除モード切替後も同じ操作バー行内に維持');
    assert.ok(toolbarBefore.contains(document.getElementById('device-config-delete-banner')), '削除コントロールは操作バー内に配置され別行を増やさない');
    assert.equal(overlay.querySelector('.device-config-dialog > .device-config-delete-banner'), null, 'モーダル直下に別行バナーを挿入しない');
    assert.match(document.getElementById('device-config-delete-banner').textContent, /削除する履歴を選択してください。/, '削除の案内文');
    assert.match(document.getElementById('device-config-delete-banner').textContent, /0件選択中/, '選択件数バッジが案内バーに表示される');
    assert.equal(overlay.querySelector('.device-config-sidebar').textContent.includes('0件選択中'), false, '左側履歴欄から選択中バッジの重複が削除されている');
    assert.equal(overlay.querySelector('.device-config-sidebar').textContent.includes('選択：'), false, '左側履歴欄から選択件数文言の重複が削除されている');
    assert.ok(document.getElementById('device-config-text'), '画面④：本文表示領域は通常時と同じ位置・構造を維持');
    assert.equal(overlay.textContent.includes('削除対象'), false, '画面④：「削除対象」という文言は廃止');
    assert.ok(overlay.querySelector('.device-config-card-checkbox'), '画面④：チェックボックスが最左端に配置');
    await document.getElementById('device-config-select-all').click();
    assert.match(document.getElementById('device-config-delete-banner').textContent, /2件選択中/);
    assert.equal(document.getElementById('device-config-register'), null);
    await document.getElementById('device-config-delete-selected').click();
    let confirm = document.getElementById('device-config-confirm-overlay');
    assert.match(confirm.textContent, /全2件/);
    assert.equal(confirm.textContent.includes('バックアップZIP'), false, '確認ダイアログからバックアップZIP文言を削除');
    assert.match(confirm.textContent, /機器本体は削除しません/);
    assert.match(confirm.textContent, /この操作は取り消せません/);
    assert.equal(request.filter(row => row.action === 'delete_device_configs').length, 0);
    await requestModalClose();
    assert.equal(document.getElementById('device-config-confirm-overlay'), null);
    assert.match(document.getElementById('device-config-delete-banner').textContent, /2件選択中/);
    failDelete = 409;
    await document.getElementById('device-config-delete-selected').click();
    await document.getElementById('device-config-delete-confirm').click();
    assert.equal(items.length, 2);
    assert.equal(document.getElementById('device-config-confirm-overlay'), null);
    assert.equal(document.getElementById('device-config-delete-selected').disabled, true);
    failDelete = null;
    await document.getElementById('device-config-reload').click();
    await document.getElementById('device-config-delete-mode').click();
    let checkbox = overlay.querySelector('input[data-config-id="2"]'); checkbox.checked = true; await checkbox.dispatch('change');
    await document.getElementById('device-config-delete-selected').click();
    await document.getElementById('device-config-delete-confirm').click();
    assert.equal(document.getElementById('device-config-text').value, copied);
    assert.deepEqual(items.map(row => row.id), [1]);
    await document.getElementById('device-config-delete-mode').click();
    await document.getElementById('device-config-select-all').click();
    await document.getElementById('device-config-delete-selected').click();
    await document.getElementById('device-config-delete-confirm').click();
    assert.match(overlay.textContent, /Configが登録されていません/);
    assert.equal(items.length, 0);
    items = [
        { id: 5, generation: 5, content: 'v5 content', memo: '', actor_name: 'admin', created_at: '2026-10-31T15:00:00Z' },
        { id: 4, generation: 4, content: 'v4 content', memo: '', actor_name: 'admin', created_at: '2026-10-31T14:00:00Z' },
        { id: 3, generation: 3, content: 'v3 content', memo: '', actor_name: 'admin', created_at: '2026-10-31T13:00:00Z' },
        { id: 2, generation: 2, content: 'v2 content', memo: '', actor_name: 'admin', created_at: '2026-10-31T12:00:00Z' },
        { id: 1, generation: 1, content: 'v1 oldest', memo: '', actor_name: 'admin', created_at: '2026-10-31T11:00:00Z' }
    ];
    revision = 5;
    await closeDeviceConfig();
    await openDeviceConfig(device);
    await document.getElementById('device-config-register').click();
    const retentionWarn = document.getElementById('device-config-retention-warning');
    assert.ok(retentionWarn);
    assert.equal(retentionWarn.hidden, true, '直近と同本文の初期状態では最古削除警告は非表示');
    editor = document.getElementById('device-config-editor');
    editor.value = 'v6 changed content';
    await editor.dispatch('input');
    assert.equal(retentionWarn.hidden, false, '本文変更で最古削除警告が表示される');
    assert.match(retentionWarn.textContent, /保存上限（5世代）に達しています/);
    assert.match(retentionWarn.textContent, /最も古い履歴/);
    assert.match(retentionWarn.textContent, /2026\/10\/31 20:00:00/); // JST
    editor.value = 'v5 content';
    await editor.dispatch('input');
    assert.equal(retentionWarn.hidden, true, '直近と同本文に戻すと最古削除警告は消える');
    editor.value = 'v6 changed content';
    await editor.dispatch('input');
    await document.getElementById('device-config-save').click();
    const toast = document.querySelector('.toast, [role="status"]');
    assert.match(document.body.textContent, /最も古い履歴を1件削除しました/);
    await document.getElementById('close-device-config-btn').click();
    assert.equal(parent.hidden, false);
    assert.equal(overlay.hidden, true);
    assert.equal(getTopModalContainer(), null);
    assert.equal(overlay.querySelector('textarea'), null);
});

test('Config差分の両側検索・循環移動・比較切替と差分ブロック移動を安全に処理する', async t => {
    const keys = ['window', 'document', 'Element', 'HTMLElement', 'fetch'];
    const originals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    installWorkspaceDom({ templates: ['templates/modals/ledger.php'], phpSetup: '$isAdmin = true;' });
    const { appState } = await import('../public/js/core/state.js');
    const { openDeviceConfig, closeDeviceConfig } = await import('../public/js/modals/device-config-modal.js');
    Object.assign(appState, { authExpired: false, dataRevision: 0 });
    window.APP_CONFIG.user = { role: 'admin', isAdmin: true };
    const latest = 'shared needle needle\nadded needle\nanchor\nlast <img src=x onerror=alert(1)>';
    const contents = [latest, 'shared needle needle\nremoved needle\nanchor\nlast old', latest, 'x\n'.repeat(4001)];
    const items = contents.map((content, index) => ({
        id: 4 - index, generation: 4 - index, content, memo: '', actor_name: 'needle-header-only',
        created_at: '2026-11-01T00:00:00Z',
    }));
    globalThis.fetch = async () => new Response(JSON.stringify({
        ok: true, revision: 4, device_revision: 7, items,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    t.after(async () => {
        await closeDeviceConfig();
        for (const [key, value] of originals) {
            if (value) Object.defineProperty(globalThis, key, value); else delete globalThis[key];
        }
    });
    await openDeviceConfig({ id: 10, resource_revision: 7, name: 'test' });
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
    assert.equal(document.activeElement, search);
    assert.equal(mark(), null);
    await search.dispatch('keydown', { key: 'Enter', isComposing: true });
    assert.equal(mark(), null, 'IME確定のEnterでは検索しない');
    await search.dispatch('keydown', { key: 'Enter' });
    assert.equal(status.textContent, '1 / 6件');
    assert.equal(side(), '比較元');
    assert.equal(mark().textContent, 'needle');
    assert.equal(document.activeElement, search, '検索後も続けて入力できる');
    for (let index = 2; index <= 6; index++) {
        await get('search-next').click();
        assert.equal(status.textContent, `${index} / 6件`);
        assert.equal(diff.querySelectorAll('mark').length, 1);
        if (index === 3 || index === 4 || index === 6) assert.equal(side(), '比較先');
    }
    await get('search-next').click();
    assert.equal(status.textContent, '1 / 6件', '末尾から先頭へ循環する');
    assert.equal(diff.textContent, originalText, 'ハイライトでConfigと行番号を変更しない');
    search.value = '<img src=x onerror=alert(1)>';
    await search.dispatch('input');
    assert.equal(mark(), null);
    assert.equal(status.textContent, '');
    await get('search-next').click();
    assert.equal(status.textContent, '1 / 1件');
    assert.equal(side(), '比較先');
    assert.equal(mark().textContent, search.value);
    assert.equal(diff.querySelector('img'), null, '検索語もConfigもHTMLとして解釈しない');
    for (const query of ['needle-header-only', '＋', '999']) {
        search.value = query;
        await search.dispatch('input');
        await get('search-next').click();
        assert.equal(status.textContent, '0 / 0件', '本文以外を検索しない');
    }
    assert.equal(get('position').textContent, '0 / 2');
    await get('next').click();
    assert.equal(get('position').textContent, '1 / 2');
    assert.match(diff.querySelector('.is-current-diff').textContent, /removed needle/);
    await get('next').click();
    assert.equal(get('position').textContent, '2 / 2');
    assert.match(diff.querySelector('.is-current-diff').textContent, /last old/);
    await get('next').click();
    assert.equal(get('position').textContent, '1 / 2');
    await get('previous').click();
    assert.equal(get('position').textContent, '2 / 2');
    assert.equal(diff.querySelectorAll('.is-current-diff').length, 1);
    // 比較元切替後に一致結果・差分位置を引き継がない。
    let select = get('source-select');
    select.value = '2'; await select.dispatch('change');
    assert.match(document.querySelector('.device-config-diff-pane').textContent, /差分はありません/);
    assert.equal(get('search-status').textContent, '');
    assert.equal(get('position').textContent, '0 / 0');
    assert.equal(get('next').disabled, true);
    select = get('source-select');
    select.value = '1'; await select.dispatch('change');
    assert.match(document.querySelector('.device-config-diff-pane').textContent, /比較できません/);
    for (const id of ['search', 'search-next', 'previous', 'next']) assert.equal(get(id).disabled, true);
    select = get('source-select');
    select.value = '3'; await select.dispatch('change');
    assert.equal(get('search').value, '');
    assert.equal(get('search-status').textContent, '');
    await get('previous').click();
    // 複数行の連続差分ブロックで全行が強調され、先頭・末尾クラスが付与されることを確認
    assert.equal(diff.querySelectorAll('.is-current-diff').length, 1);
    assert.ok(diff.querySelector('.is-current-diff').classList.contains('is-diff-block-start'));
    assert.ok(diff.querySelector('.is-current-diff').classList.contains('is-diff-block-end'));
    assert.equal(get('position').textContent, '2 / 2', '未選択から前へ進むと最後の差分');
    assert.deepEqual(items.map(item => item.content), contents, '保存本文は不変');

    // 複数行にわたる連続差分ブロック（P3対応）の全行強調を確認
    const multiLineSource = 'header\nline1-old\nline2-old\nline3-old\nfooter';
    const multiLineTarget = 'header\nline1-new\nline2-new\nline3-new\nfooter';
    const multiItems = [
        { id: 20, generation: 2, content: multiLineTarget, memo: '', actor_name: 'admin', created_at: '2026-11-01T02:00:00Z' },
        { id: 10, generation: 1, content: multiLineSource, memo: '', actor_name: 'admin', created_at: '2026-11-01T01:00:00Z' }
    ];
    globalThis.fetch = async () => new Response(JSON.stringify({
        ok: true, revision: 2, device_revision: 7, items: multiItems
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    await closeDeviceConfig();
    await openDeviceConfig({ id: 10, resource_revision: 7, name: 'multi-diff-test' });
    await document.getElementById('device-config-compare').click();
    const multiDiff = document.querySelector('.device-config-diff');
    assert.equal(get('position').textContent, '0 / 1');
    await get('next').click();
    assert.equal(get('position').textContent, '1 / 1');
    const currentDiffRows = multiDiff.querySelectorAll('.is-current-diff');
    assert.equal(currentDiffRows.length, 3, '3行連続の変更行すべてにis-current-diffが付与される');
    assert.ok(currentDiffRows[0].classList.contains('is-diff-block-start'), 'ブロック先頭行にis-diff-block-startが付与される');
    assert.equal(currentDiffRows[1].classList.contains('is-diff-block-start'), false);
    assert.equal(currentDiffRows[1].classList.contains('is-diff-block-end'), false);
    assert.ok(currentDiffRows[2].classList.contains('is-diff-block-end'), 'ブロック末尾行にis-diff-block-endが付与される');
});
