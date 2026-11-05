import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDeviceIpEditor } from '../public/js/ui/device-ip-editor.js';
import { normalizeAdditionalIps, validateDeviceIps } from '../public/js/core/device-ip-addresses.js';
import { installWorkspaceDom } from './helpers/workspace-dom.mjs';
import { appState } from '../public/js/core/state.js';

function install(t, templates = []) {
    const keys = ['window', 'document', 'Element', 'HTMLElement', 'fetch', 'localStorage'];
    const globals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const dom = installWorkspaceDom({ templates, phpSetup: '$isAdmin = true;' });
    globalThis.localStorage = window.localStorage = { getItem: () => null, setItem() {} };
    t.after(() => {
        dom.cleanup?.();
        for (const [key, descriptor] of globals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    });
    return dom;
}

function device() {
    return { ip: '', additional_ips: normalizeAdditionalIps([
        { id: 10, ip: '192.0.2.10', label: '用途A' }, { id: 20, ip: '192.0.2.20', label: '用途B' }
    ]) };
}
const entries = editor => editor.querySelectorAll('.device-ip-entry');
const inputs = entry => entry.querySelectorAll('input');
const visibleErrors = editor => editor.querySelectorAll('.form-error').filter(error => !error.hidden);

test('共通追加IPエディターは横並びの入力とゴミ箱だけで編集・削除し、既存IDと閲覧権限を守る', async t => {
    install(t);
    const draft = device();
    let allowed = true;
    const editor = createDeviceIpEditor({ getDevice: () => draft, canEdit: () => allowed, onChange() {} });
    const row = entries(editor)[0].querySelector('.device-ip-row');
    assert.equal(row.children.length, 3);
    assert.deepEqual(row.children.slice(0, 2).map(input => input.tagName), ['INPUT', 'INPUT']);
    assert.equal(row.querySelectorAll('button').length, 1);
    assert.ok(row.querySelector('button').querySelector('svg'));
    const label = inputs(entries(editor)[0])[1];
    label.value = '変更用途'; await label.dispatch('input');
    assert.equal(draft.additional_ips[0].label, '変更用途');
    assert.equal(draft.additional_ips[0].id, 10);
    await entries(editor)[0].querySelector('button').dispatch('click');
    assert.deepEqual(draft.additional_ips.map(row => row.id), [20]);
    assert.equal(draft.additional_ips[0].sort_order, 0);
    await editor.querySelector('.device-ip-add').dispatch('click');
    const ip = inputs(entries(editor)[1])[0];
    ip.value = '192.0.2.30'; await ip.dispatch('input');
    assert.deepEqual(draft.additional_ips.map(row => row.ip), ['192.0.2.20', '192.0.2.30']);
    assert.equal(draft.additional_ips[1].id, null);
    allowed = false;
    await entries(editor)[0].querySelector('button').dispatch('click');
    assert.deepEqual(draft.additional_ips.map(row => row.id), [20, null]);
    const viewer = createDeviceIpEditor({ getDevice: () => draft, canEdit: () => false, onChange() { throw new Error('閲覧者更新'); } });
    assert.equal(viewer.querySelectorAll('button').length, 0);
    assert.ok(viewer.querySelectorAll('input').every(input => input.readOnly));
});

test('追加IPのエラーは該当行直下だけに表示し、未入力の新規行は入力・適用まで保留する', async t => {
    install(t);
    const draft = device();
    const editor = createDeviceIpEditor({ getDevice: () => draft, canEdit: () => true, onChange() {} });
    const add = editor.querySelector('.device-ip-add');
    await add.dispatch('click');
    assert.equal(visibleErrors(editor).length, 0);
    assert.ok(validateDeviceIps(draft), '表示を保留しても保存時の必須検証は維持する');
    const blank = entries(editor)[2];
    const ip = inputs(blank)[0];
    ip.value = 'invalid'; await ip.dispatch('input');
    assert.deepEqual(visibleErrors(editor), [blank.children[1]]);
    assert.equal(blank.children[0].className, 'device-ip-row');
    assert.equal(ip.getAttribute('aria-describedby'), blank.children[1].id);
    assert.ok(inputs(entries(editor)[0]).every(input => input.getAttribute('aria-invalid') !== 'true'));
    ip.value = draft.additional_ips[0].ip; await ip.dispatch('input');
    assert.equal(visibleErrors(editor).length, 1);
    ip.value = '192.0.2.30'; await ip.dispatch('input');
    assert.equal(visibleErrors(editor).length, 0);
    const label = inputs(blank)[1];
    label.value = 'あ'.repeat(101); await label.dispatch('input');
    assert.deepEqual(visibleErrors(editor), [blank.children[1]]);
    assert.equal(label.getAttribute('aria-invalid'), 'true');
    assert.notEqual(ip.getAttribute('aria-invalid'), 'true');
    label.value = '用途'; await label.dispatch('input');
    await add.dispatch('click');
    assert.equal(visibleErrors(editor).length, 0);
    assert.equal(editor.validateIps({ reveal: true }), inputs(entries(editor)[3])[0]);
    assert.deepEqual(visibleErrors(editor), [entries(editor)[3].children[1]]);
    await add.dispatch('click');
    assert.equal(entries(editor)[4].children[1].hidden, true, '失敗した適用の後でも新たな空行は即時エラーにしない');
});

test('別画面の並べ替え・削除後は古い入力を別の追加IPへ適用せず最新行を示す', async t => {
    install(t);
    const draft = device();
    const editor = createDeviceIpEditor({ getDevice: () => draft, canEdit: () => true, onChange() {} });
    const oldInput = inputs(entries(editor)[0])[1];
    draft.additional_ips = normalizeAdditionalIps([...draft.additional_ips].reverse());
    oldInput.value = '古い行への入力'; await oldInput.dispatch('input');
    assert.deepEqual(draft.additional_ips.map(row => [row.id, row.label]), [[20, '用途B'], [10, '用途A']]);
    assert.equal(inputs(entries(editor)[0])[0].value, '192.0.2.20');
    const removedInput = inputs(entries(editor)[1])[1];
    draft.additional_ips = [draft.additional_ips[0]];
    removedInput.value = '削除済みへの入力'; await removedInput.dispatch('input');
    assert.deepEqual(draft.additional_ips.map(row => [row.id, row.label]), [[20, '用途B']]);
    assert.equal(entries(editor).length, 1);
    const current = inputs(entries(editor)[0])[1];
    current.value = '最新行への入力'; await current.dispatch('input');
    assert.equal(draft.additional_ips[0].label, '最新行への入力');
});

test('右パネル・個票の適用でも追加IPエラーを行内に統一し、空行を保存しない', async t => {
    for (const surface of ['panel', 'sheet']) await t.test(surface, async t => {
        const dom = install(t, ['templates/components/property_panel.php', 'templates/modals/ledger.php']);
        const { appState, normalizeDevice } = await import('../public/js/core/state.js');
        const { resetResourceBaseline } = await import('../public/js/core/resource-save.js');
        const drafts = await import('../public/js/core/device-drafts.js');
        const queue = await import('../public/js/core/save-queue.js');
        const panel = await import('../public/js/ui/property-panel.js');
        const ledger = await import('../public/js/modals/ledger-modal.js');
        dom.cleanup = () => { queue.clearPendingSave(); drafts.discardDeviceDrafts(); };
        Object.assign(appState, { authExpired: false, isPinging: false,
            devices: [normalizeDevice({ ...device(), id: 1, name: '検証機器', type: 'switch', ip: '203.0.113.10', resource_revision: 1 })],
            views: [{ id: 1, name: '検証ビュー', view_type: 'topology', resource_revision: 1 }],
            currentViewId: 1, placements: [{ id: 1, view_id: 1, device_id: 1, x: 10, y: 10 }],
            links: [], deviceImages: [] });
        appState.resourceConflicts.devices.clear();
        appState.resourceConflicts.views.clear();
        resetResourceBaseline(appState);
        let requests = 0;
        globalThis.fetch = async () => { requests++; throw new Error('不正な空行を送信してはいけない'); };
        if (surface === 'panel') panel.openPanel(appState.devices[0]);
        else await ledger.openLedgerDetail(1);
        const container = surface === 'panel' ? dom.get('p-additional-ips') : dom.get('ledger-sheet-body');
        const editor = container.querySelector('.device-ip-editor');
        assert.ok(editor);
        const managementNotice = surface === 'panel'
            ? dom.get('p-ip-notice')
            : dom.get('ledger-sheet-body').querySelector('.ip-duplicate-notice');
        assert.ok(managementNotice);
        assert.equal(managementNotice.hidden, true);
        assert.doesNotMatch(managementNotice.textContent, /未分類|IP管理/);
        assert.equal(editor.querySelectorAll('button').length, surface === 'sheet' ? 4 : 3, '個票では要約の編集切替も表示する');
        if (surface === 'sheet') await editor.querySelector('.device-ip-toggle').dispatch('click');
        await editor.querySelector('.device-ip-add').dispatch('click');
        assert.equal(visibleErrors(editor).length, 0);
        assert.equal(surface === 'panel' ? panel.applyPanelValues() : await ledger.saveLedgerSheet(), false);
        const entry = entries(editor)[2];
        assert.deepEqual(visibleErrors(editor), [entry.children[1]]);
        assert.equal(document.activeElement, inputs(entry)[0]);
        assert.equal(document.getElementById(surface === 'panel' ? 'p-additional-ips-error' : 'ledger-sheet-additional_ips-error'), null);
        assert.equal(requests, 0);
        assert.equal(appState.devices[0].additional_ips.length, 2);
        const { eventBus } = await import('../public/js/core/event-bus.js');
        appState.devices[0].id = 101;
        if (surface === 'panel') appState.editingDeviceId = 101;
        eventBus.emit('resources:ids-remapped', { devices: { 1: 101 } });
        const ip = inputs(entry)[0];
        ip.value = '192.0.2.30';
        await ip.dispatch('input');
        assert.equal(drafts.getDeviceDraft(surface, 101).additional_ips[2].ip, '192.0.2.30');
        assert.equal(editor.validateIps({ reveal: true }), null);
        assert.equal(visibleErrors(editor).length, 0);
    });
});

test('追加IPは選択欄を出さず変更時だけ自動所属を判定し、既存所属とIDを保持する', async t => {
    install(t);
    const previous = { ipSegments: appState.ipSegments, devices: appState.devices };
    t.after(() => Object.assign(appState, previous));
    appState.ipSegments = [
        { id: 1, address_space_id: 1, cidr: '192.0.2.0/24' },
        { id: 2, address_space_id: 2, cidr: '192.0.2.0/24' },
        { id: 3, address_space_id: 1, cidr: '198.51.100.0/24' }
    ];
    appState.devices = [];
    const draft = { id: 10, ip: '', additional_ips: normalizeAdditionalIps([
        { id: 20, ip: '192.0.2.10', label: '既存', segment_id: 2 }
    ]) };
    const editor = createDeviceIpEditor({ getDevice: () => draft, canEdit: () => true, onChange() {} });
    assert.equal(editor.querySelector('select'), null);
    const [ip, label] = inputs(entries(editor)[0]);
    label.value = '用途変更'; await label.dispatch('input');
    assert.equal(draft.additional_ips[0].segment_id, 2);
    await ip.dispatch('input');
    assert.equal(draft.additional_ips[0].segment_id, 2, '同値の入力通知では既存の手動所属を解除しない');
    ip.value = '198.51.100.5'; await ip.dispatch('input');
    assert.equal(draft.additional_ips[0].segment_id, 3);
    assert.equal(entries(editor)[0].querySelector('.ip-duplicate-notice').hidden, true);
    ip.value = '192.0.2.10'; await ip.dispatch('input');
    assert.equal(draft.additional_ips[0].segment_id, null);
    assert.doesNotMatch(entries(editor)[0].textContent, /未分類|IP管理/);
    assert.equal(draft.additional_ips[0].id, 20);
    assert.equal(draft.additional_ips[0].label, '用途変更');
    ip.value = '203.0.113.1'; await ip.dispatch('input');
    assert.equal(draft.additional_ips[0].segment_id, null);
});

test('追加IPの未分類案内を出さず、他機器との重複警告と行内エラーは維持する', async t => {
    install(t);
    const previous = { ipSegments: appState.ipSegments, devices: appState.devices };
    t.after(() => Object.assign(appState, previous));
    appState.ipSegments = [];
    appState.devices = [{ id: 2, ip: '192.0.2.30', additional_ips: [] }];
    const draft = { id: 1, ip: '192.0.2.10', additional_ips: normalizeAdditionalIps([{ id: 10, ip: '192.0.2.20' }]) };
    const editor = createDeviceIpEditor({ getDevice: () => draft, canEdit: () => true, onChange() {} });
    const entry = entries(editor)[0], ip = inputs(entry)[0];
    assert.doesNotMatch(entry.textContent, /未分類|IP管理/);
    ip.value = '192.0.2.30'; await ip.dispatch('input');
    assert.match(entry.textContent, /重複の可能性/);
    assert.doesNotMatch(entry.textContent, /未分類|IP管理/);
    ip.value = 'broken'; await ip.dispatch('input');
    assert.equal(visibleErrors(editor).length, 1);
    assert.doesNotMatch(entry.textContent, /重複の可能性|未分類|IP管理/);
    ip.value = draft.ip; await ip.dispatch('input');
    assert.equal(visibleErrors(editor).length, 1);
});

test('コンパクト追加IPは0件では追加だけを表示し、新規行へフォーカスして最後の削除で通常表示へ戻る', async t => {
    install(t);
    const draft = { ip: '', additional_ips: [] };
    let changes = 0;
    const editor = createDeviceIpEditor({ getDevice: () => draft, canEdit: () => true, onChange() { changes++; }, compact: true });
    const summary = editor.querySelector('.device-ip-summary');
    const toggle = editor.querySelector('.device-ip-toggle');
    const rows = editor.querySelector('.device-ip-rows');
    const add = editor.querySelector('.device-ip-add');
    assert.equal(summary.textContent, '追加IPなし');
    assert.equal(toggle.hidden, true);
    assert.equal(add.hidden, false);
    assert.equal(rows.hidden, true);
    assert.equal(toggle.getAttribute('aria-controls'), rows.id);
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    editor.setExpanded(true);
    assert.equal(rows.hidden, true, '0件では空の編集領域を展開しない');
    await add.dispatch('click');
    const ip = inputs(entries(editor)[0])[0];
    assert.equal(draft.additional_ips.length, 1);
    assert.equal(draft.additional_ips[0].id, null);
    assert.equal(draft.additional_ips[0].ip, '');
    assert.equal(document.activeElement, ip);
    assert.equal(rows.hidden, false);
    assert.equal(toggle.hidden, false);
    assert.equal(toggle.textContent, '閉じる');
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(visibleErrors(editor).length, 0);
    await entries(editor)[0].querySelector('.device-ip-delete').dispatch('click');
    assert.equal(draft.additional_ips.length, 0);
    assert.equal(entries(editor).length, 0);
    assert.equal(summary.textContent, '追加IPなし');
    assert.equal(rows.hidden, true);
    assert.equal(toggle.hidden, true);
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(add.hidden, false);
    assert.equal(document.activeElement, add);
    assert.equal(changes, 2);
});

test('コンパクト追加IPは1件・複数件とも要約と編集から開き、自然な操作順と開閉・追加後のフォーカスを保つ', async t => {
    for (const count of [1, 2]) await t.test(`${count}件`, async t => {
        install(t);
        const draft = device();
        draft.additional_ips = draft.additional_ips.slice(0, count);
        const editor = createDeviceIpEditor({ getDevice: () => draft, canEdit: () => true, onChange() {}, compact: true });
        const summary = editor.querySelector('.device-ip-summary');
        const toggle = editor.querySelector('.device-ip-toggle');
        const rows = editor.querySelector('.device-ip-rows');
        const add = editor.querySelector('.device-ip-add');
        assert.equal(rows.hidden, true);
        assert.equal(add.hidden, true);
        assert.equal(toggle.hidden, false);
        assert.equal(toggle.textContent, '編集');
        assert.equal(toggle.tagName, 'BUTTON', 'Enter/Spaceはnative buttonのclickを利用する');
        assert.equal(toggle.type, 'button');
        assert.ok(editor.children.indexOf(summary) < editor.children.indexOf(toggle));
        assert.ok(editor.children.indexOf(toggle) < editor.children.indexOf(rows));
        assert.ok(editor.children.indexOf(rows) < editor.children.indexOf(add));
        for (const address of draft.additional_ips) {
            assert.ok(summary.textContent.includes(address.ip));
            assert.ok(summary.textContent.includes(address.label));
        }
        await toggle.dispatch('click');
        const firstIp = inputs(entries(editor)[0])[0];
        assert.equal(document.activeElement, firstIp);
        assert.equal(rows.hidden, false);
        assert.equal(add.hidden, false);
        assert.equal(toggle.getAttribute('aria-expanded'), 'true');
        const label = inputs(entries(editor)[0])[1];
        label.value = '変更中'; await label.dispatch('input');
        label.focus();
        editor.setExpanded(false);
        assert.equal(document.activeElement, toggle, 'API経由の閉鎖でも非表示入力へフォーカスを残さない');
        assert.equal(rows.hidden, true);
        assert.equal(add.hidden, true);
        assert.equal(toggle.getAttribute('aria-expanded'), 'false');
        assert.match(summary.textContent, /変更中/);
        await toggle.dispatch('click');
        assert.equal(document.activeElement, firstIp);
        await add.dispatch('click');
        const newIp = inputs(entries(editor)[count])[0];
        assert.equal(document.activeElement, newIp);
        assert.equal(draft.additional_ips.length, count + 1);
        await toggle.dispatch('click');
        assert.equal(document.activeElement, toggle);
        assert.equal(rows.hidden, true);
        assert.equal(add.hidden, true);
        editor.setExpanded(true);
        assert.equal(document.activeElement, toggle, 'API展開は個票の既存の選択復元を妨げない');
        await entries(editor)[count].querySelector('.device-ip-delete').dispatch('click');
        assert.equal(document.activeElement, inputs(entries(editor)[count - 1])[0]);
        assert.equal(rows.hidden, false);
        assert.equal(entries(editor).length, count);
    });
});

test('コンパクト追加IPは閉鎖中の検証で対象行を開き、入力更新でも再描画せず検証と要約を同期する', async t => {
    install(t);
    const draft = device();
    const editor = createDeviceIpEditor({ getDevice: () => draft, canEdit: () => true, onChange() {}, compact: true });
    const toggle = editor.querySelector('.device-ip-toggle');
    await toggle.dispatch('click');
    await editor.querySelector('.device-ip-add').dispatch('click');
    const ip = inputs(entries(editor)[2])[0];
    editor.setExpanded(false);
    assert.equal(editor.validateIps({ reveal: true }), ip);
    assert.equal(editor.querySelector('.device-ip-rows').hidden, false);
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.deepEqual(visibleErrors(editor), [entries(editor)[2].children[1]]);
    ip.focus();
    ip.value = '192.0.2.30'; await ip.dispatch('input');
    assert.equal(inputs(entries(editor)[2])[0], ip);
    assert.equal(document.activeElement, ip);
    assert.equal(visibleErrors(editor).length, 0);
    assert.equal(editor.validateIps({ reveal: true }), null);
    assert.match(editor.querySelector('.device-ip-summary').textContent, /192\.0\.2\.30/);
    assert.deepEqual(draft.additional_ips.slice(0, 2).map(address => address.id), [10, 20]);
});

test('コンパクト追加IPの閲覧者は0件・複数件とも要約のみで入力を展開・更新できない', t => {
    install(t);
    for (const addresses of [[], device().additional_ips]) {
        const draft = { ip: '', additional_ips: addresses };
        const viewer = createDeviceIpEditor({ getDevice: () => draft, canEdit: () => false, onChange() { throw new Error('閲覧者更新'); }, compact: true, expanded: true });
        const rows = viewer.querySelector('.device-ip-rows');
        const summary = viewer.querySelector('.device-ip-summary');
        assert.equal(viewer.querySelectorAll('button').length, 0);
        assert.equal(rows.hidden, true);
        viewer.setExpanded(true);
        assert.equal(rows.hidden, true);
        assert.ok(viewer.querySelectorAll('input').every(input => input.readOnly));
        if (!addresses.length) assert.equal(summary.textContent, '追加IPなし');
        for (const address of addresses) {
            assert.ok(summary.textContent.includes(address.ip));
            assert.ok(summary.textContent.includes(address.label));
        }
    }
});

test('非コンパクト追加IPは0件でも常時表示の追加操作と行編集を維持する', async t => {
    install(t);
    const draft = { ip: '', additional_ips: [] };
    const editor = createDeviceIpEditor({ getDevice: () => draft, canEdit: () => true, onChange() {} });
    const rows = editor.querySelector('.device-ip-rows');
    const add = editor.querySelector('.device-ip-add');
    assert.equal(rows.hidden, false);
    assert.equal(rows.textContent, '追加IPはありません');
    assert.equal(add.hidden, false);
    assert.equal(editor.querySelector('.device-ip-summary'), null);
    assert.equal(editor.querySelector('.device-ip-toggle'), null);
    await add.dispatch('click');
    assert.equal(document.activeElement, inputs(entries(editor)[0])[0]);
    editor.setExpanded(false);
    assert.equal(rows.hidden, false);
    await entries(editor)[0].querySelector('.device-ip-delete').dispatch('click');
    assert.equal(rows.hidden, false);
    assert.equal(add.hidden, false);
    assert.equal(draft.additional_ips.length, 0);
});

test('コンパクト追加IPでも用途変更は所属を保持し、IP入力の自動所属・重複警告・行内検証を維持する', async t => {
    install(t);
    const previous = { ipSegments: appState.ipSegments, devices: appState.devices };
    t.after(() => Object.assign(appState, previous));
    appState.ipSegments = [
        { id: 1, address_space_id: 1, cidr: '192.0.2.0/24' },
        { id: 2, address_space_id: 1, cidr: '198.51.100.0/24' }
    ];
    appState.devices = [{ id: 2, ip: '198.51.100.30', additional_ips: [] }];
    const draft = { id: 1, ip: '', additional_ips: normalizeAdditionalIps([
        { id: 10, ip: '192.0.2.10', label: '既存', segment_id: 1 }
    ]) };
    const editor = createDeviceIpEditor({ getDevice: () => draft, canEdit: () => true, onChange() {}, compact: true });
    await editor.querySelector('.device-ip-toggle').dispatch('click');
    const entry = entries(editor)[0];
    const [ip, label] = inputs(entry);
    label.value = '変更用途'; await label.dispatch('input');
    assert.equal(draft.additional_ips[0].segment_id, 1);
    ip.value = '198.51.100.30'; await ip.dispatch('input');
    assert.equal(draft.additional_ips[0].segment_id, 2);
    assert.equal(draft.additional_ips[0].id, 10);
    assert.equal(draft.additional_ips[0].label, '変更用途');
    assert.match(entry.textContent, /重複の可能性/);
    assert.equal(visibleErrors(editor).length, 0);
    ip.value = 'invalid'; await ip.dispatch('input');
    assert.equal(draft.additional_ips[0].segment_id, null);
    assert.deepEqual(visibleErrors(editor), [entry.children[1]]);
    assert.doesNotMatch(entry.textContent, /重複の可能性/);
    assert.equal(inputs(entries(editor)[0])[0], ip);
    assert.equal(document.activeElement, ip);
    assert.equal(appState.devices[0].ip, '198.51.100.30', '編集対象以外の機器は更新しない');
});
