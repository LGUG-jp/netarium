import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { appState } from '../public/js/core/state.js';
import { initializeLinkSystemsModal, openLinkSystems, closeLinkSystems } from '../public/js/modals/link-systems-modal.js';
import { getTopModalContainer, getFocusableElements } from '../public/js/core/modal-focus.js';
import { onKeyDown } from '../public/js/canvas/selection.js';
import { installPrintDom } from './helpers/print-dom.mjs';

const drain = async () => { for (let i = 0; i < 4; i++) await setImmediate(); };
const selectedColor = dom => [...dom.get('link-systems-color-options').children]
    .find(option => option.getAttribute('aria-checked') === 'true')?.value;
function setup(t) {
    const dom = installPrintDom({ templates: ['templates/modals/link_systems.php'] });
    const original = { ...appState };
    Object.assign(appState, { linkSystems: [], currentSvg: null, deviceLayer: null, floorPlanLayer: null,
        authExpired: false, isPinging: false, views: [{ id: 1, resource_revision: 19 }],
        appStatus: { dirty: false, state: 'saved' } });
    window.confirm = () => true;
    initializeLinkSystemsModal();
    t.after(() => { closeLinkSystems(); Object.assign(appState, original); dom.restore(); });
    const requests = [];
    let systems = [{ id: 1, name: '合成基幹LAN', color_key: 'indigo', resource_revision: 3, usage_count: 12 }];
    let failConflict = false;
    globalThis.fetch = async (url, options) => {
        const action = new URL(url, 'http://localhost/').searchParams.get('action');
        const input = options.body ? JSON.parse(options.body) : null;
        requests.push({ action, input });
        if (failConflict && action === 'update_link_system') return new Response(JSON.stringify({ error: '別の利用者が変更しました' }), { status: 409 });
        if (action === 'create_link_system') systems.push({ ...input, id: 2, resource_revision: 4, usage_count: 0 });
        if (action === 'update_link_system') systems = systems.map(row => row.id === input.id ? { ...row, ...input, resource_revision: 5 } : row);
        if (action === 'delete_link_system') systems = systems.filter(row => row.id !== input.id);
        const result = { ok: true, link_systems: systems };
        if (action === 'create_link_system') result.created_id = 2;
        return new Response(JSON.stringify(result));
    };
    return { dom, requests, conflict: () => { failConflict = true; }, replaceSystems: rows => { systems = structuredClone(rows); } };
}

test('系統追加・使用中の名称色変更・未使用削除はview世代と保存状態を変更しない', async t => {
    const { dom, requests } = setup(t);
    const before = structuredClone({ views: appState.views, appStatus: appState.appStatus });
    await openLinkSystems();
    await dom.get('link-systems-list').children[0].dispatch('click');
    assert.equal(dom.get('link-systems-delete').disabled, true);
    await dom.get('link-systems-delete').dispatch('click');
    assert.equal(requests.filter(row => row.action === 'delete_link_system').length, 0);
    dom.get('link-systems-name').value = '合成庁内LAN';
    await dom.get('link-systems-color-option-teal').dispatch('click');
    await dom.get('link-systems-form').dispatch('submit'); await drain();
    assert.deepEqual(requests.at(-1), { action: 'update_link_system', input: { id: 1, expected_revision: 3, name: '合成庁内LAN', color_key: 'teal' } });
    assert.equal(appState.linkSystems[0].color_key, 'teal');
    await dom.get('link-systems-new').dispatch('click');
    dom.get('link-systems-name').value = '合成無線LAN';
    await dom.get('link-systems-color-option-violet').dispatch('click');
    await dom.get('link-systems-form').dispatch('submit'); await drain();
    assert.equal(appState.linkSystems[1].name, '合成無線LAN');
    await dom.get('link-systems-delete').dispatch('click'); await drain();
    assert.deepEqual(appState.linkSystems.map(row => row.id), [1]);
    assert.deepEqual({ views: appState.views, appStatus: appState.appStatus }, before);
});

test('同名系統の登録後も新しいIDを選択し、編集・削除は既存の同名系統に影響しない', async t => {
    const { dom, requests, replaceSystems } = setup(t);
    const originalSystem = { id: 1, name: '合成同名系統', color_key: 'indigo', resource_revision: 3, usage_count: 0 };
    replaceSystems([originalSystem]);
    await openLinkSystems();
    await dom.get('link-systems-new').dispatch('click');
    dom.get('link-systems-name').value = originalSystem.name;
    await dom.get('link-systems-color-option-teal').dispatch('click');
    await dom.get('link-systems-form').dispatch('submit'); await drain();
    assert.equal(dom.get('link-systems-row-2').getAttribute('aria-pressed'), 'true');
    assert.equal(dom.get('link-systems-row-1').getAttribute('aria-pressed'), 'false');
    assert.equal(selectedColor(dom), 'teal');
    dom.get('link-systems-name').value = '新規系統を変更';
    await dom.get('link-systems-color-option-violet').dispatch('click');
    await dom.get('link-systems-form').dispatch('submit'); await drain();
    assert.deepEqual(requests.at(-1), {
        action: 'update_link_system',
        input: { id: 2, expected_revision: 4, name: '新規系統を変更', color_key: 'violet' }
    });
    assert.deepEqual(appState.linkSystems[0], originalSystem);
    assert.equal(appState.linkSystems[1].name, '新規系統を変更');
    await dom.get('link-systems-delete').dispatch('click'); await drain();
    assert.deepEqual(requests.at(-1), { action: 'delete_link_system', input: { id: 2, expected_revision: 5 } });
    assert.deepEqual(appState.linkSystems, [originalSystem]);
});

test('409で名称と色の入力を保持し、再読込の破棄取消で入力を失わない', async t => {
    const { dom, requests, conflict } = setup(t);
    await openLinkSystems();
    await dom.get('link-systems-list').children[0].dispatch('click');
    dom.get('link-systems-name').value = '未保存の系統';
    await dom.get('link-systems-color-option-magenta').dispatch('click');
    conflict();
    await dom.get('link-systems-form').dispatch('submit'); await drain();
    assert.equal(dom.get('link-systems-name').value, '未保存の系統');
    assert.equal(selectedColor(dom), 'magenta');
    assert.equal(appState.linkSystems[0].resource_revision, 3);
    window.confirm = () => false;
    const count = requests.length;
    await dom.get('link-systems-refresh').dispatch('click'); await drain();
    assert.equal(requests.length, count);
    assert.equal(closeLinkSystems(), false);
    window.confirm = () => true;
    await dom.get('link-systems-refresh').dispatch('click'); await drain();
    assert.equal(dom.get('link-systems-name').value, '合成基幹LAN');
});

test('viewerは名称と使用件数を閲覧できるがプログラム操作でも編集を送信しない', async t => {
    const { dom, requests } = setup(t);
    window.APP_CONFIG.user.isAdmin = false;
    await openLinkSystems();
    await dom.get('link-systems-list').children[0].dispatch('click');
    assert.equal(dom.get('link-systems-name').disabled, true);
    assert.equal([...dom.get('link-systems-color-options').children].every(option => option.disabled), true);
    assert.equal(dom.get('link-systems-save').hidden, true);
    assert.equal(dom.get('link-systems-cancel').hidden, true);
    assert.equal(dom.get('link-systems-new').disabled, true);
    assert.equal(dom.get('link-systems-delete').hidden, true);
    const name = dom.get('link-systems-name').value;
    await dom.get('link-systems-new').dispatch('click');
    await dom.get('link-systems-cancel').dispatch('click');
    assert.equal(dom.get('link-systems-name').value, name);
    await dom.get('link-systems-form').dispatch('submit'); await drain();
    assert.deepEqual(requests.map(row => row.action), ['list_link_systems']);
    await onKeyDown({ key: 'Escape', preventDefault() {}, stopImmediatePropagation() {} });
    assert.equal(getTopModalContainer(), null);
});

test('常設色候補の左右・上下・端点移動は下書きだけを変更し、適用まで保存せず、閉鎖取消で選択を保持する', async t => {
    const { dom, requests } = setup(t);
    await openLinkSystems();
    const options = dom.get('link-systems-color-options');
    const indigo = dom.get('link-systems-color-option-indigo');
    const teal = dom.get('link-systems-color-option-teal');
    const cyan = dom.get('link-systems-color-option-cyan');
    const beforeRequests = requests.length;
    await indigo.dispatch('keydown', { key: 'ArrowRight' });
    assert.equal(document.activeElement, teal);
    assert.equal(selectedColor(dom), 'teal');
    assert.equal(teal.getAttribute('tabindex'), '0');
    assert.equal(indigo.getAttribute('tabindex'), '-1');
    await teal.dispatch('keydown', { key: 'ArrowDown' });
    assert.equal(document.activeElement, cyan);
    assert.equal(selectedColor(dom), 'cyan');
    await cyan.dispatch('keydown', { key: 'ArrowUp' });
    assert.equal(document.activeElement, teal);
    await teal.dispatch('keydown', { key: 'ArrowLeft' });
    assert.equal(document.activeElement, indigo);
    await indigo.dispatch('keydown', { key: 'End' });
    assert.equal(document.activeElement, options.children.at(-1));
    assert.equal(selectedColor(dom), 'olive');
    await options.children.at(-1).dispatch('keydown', { key: 'Home' });
    assert.equal(document.activeElement, indigo);
    await teal.dispatch('keydown', { key: ' ' });
    assert.equal(selectedColor(dom), 'teal');
    assert.deepEqual([...options.children].filter(option => option.getAttribute('aria-checked') === 'true').map(option => option.value), ['teal']);
    assert.equal(appState.linkSystems[0].color_key, 'indigo');
    assert.equal(requests.length, beforeRequests);
    window.confirm = () => false;
    await onKeyDown({ key: 'Escape', preventDefault() {}, stopImmediatePropagation() {} });
    assert.equal(dom.get('link-systems-overlay').hidden, false);
    assert.equal(selectedColor(dom), 'teal');
    assert.equal(options.hidden, false);
    await dom.get('link-systems-form').dispatch('submit'); await drain();
    assert.equal(appState.linkSystems[0].color_key, 'teal');
    assert.equal(requests.length, beforeRequests + 1);
    window.confirm = () => true;
    await onKeyDown({ key: 'Escape', preventDefault() {}, stopImmediatePropagation() {} });
    assert.equal(dom.get('link-systems-overlay').hidden, true);
});

test('Tabで色を変えず、viewer・認証失効時は常設候補のクリックとキー操作でも変更できない', async t => {
    const { dom, requests } = setup(t);
    await openLinkSystems();
    const teal = dom.get('link-systems-color-option-teal');
    await teal.dispatch('keydown', { key: 'Tab' });
    assert.equal(selectedColor(dom), 'indigo');
    const beforeRequests = requests.length;
    for (const expired of [false, true]) {
        window.APP_CONFIG.user.isAdmin = expired;
        appState.authExpired = expired;
        await teal.dispatch('click');
        await teal.dispatch('keydown', { key: 'ArrowDown' });
        await teal.dispatch('keydown', { key: ' ' });
        assert.equal(selectedColor(dom), 'indigo');
        assert.equal(appState.linkSystems[0].color_key, 'indigo');
        assert.equal(requests.length, beforeRequests);
    }
    window.APP_CONFIG.user.isAdmin = true;
    appState.authExpired = false;
});

test('一覧とフォームが別領域で、選択・新規作成・キャンセルは未確定のまま遷移し直前の系統へ戻る', async t => {
    const { dom, requests, replaceSystems } = setup(t);
    replaceSystems([
        { id: 1, name: '合成基幹LAN', color_key: 'indigo', resource_revision: 3, usage_count: 12 },
        { id: 2, name: '合成無線LAN', color_key: 'teal', resource_revision: 4, usage_count: 0 }
    ]);
    await openLinkSystems();
    const workspace = document.querySelector('.link-systems-workspace');
    assert.equal(workspace.children.length, 2);
    const [left, right] = workspace.children;
    assert.equal(left.classList.contains('link-systems-list-area'), true);
    assert.equal(right.classList.contains('link-systems-form'), true);
    for (const id of ['new', 'list', 'refresh']) assert.equal(left.contains(dom.get(`link-systems-${id}`)), true);
    for (const id of ['name', 'color-options', 'actions', 'save', 'cancel', 'delete']) {
        assert.equal(right.contains(dom.get(`link-systems-${id}`)), true);
    }
    assert.equal(left.contains(right), false);
    assert.equal(dom.get('link-systems-row-1').getAttribute('aria-pressed'), 'true');
    assert.equal(parseInt(dom.get('link-systems-row-1').querySelector('.link-systems-row-usage').textContent, 10), 12);
    await dom.get('link-systems-row-2').dispatch('click');
    assert.equal(dom.get('link-systems-row-1').getAttribute('aria-pressed'), 'false');
    assert.equal(dom.get('link-systems-row-2').getAttribute('aria-pressed'), 'true');
    assert.equal(document.activeElement, dom.get('link-systems-row-2'));
    assert.equal(dom.get('link-systems-delete').disabled, false);
    assert.equal(dom.get('link-systems-cancel').hidden, true);
    const order = getFocusableElements(dom.get('link-systems-overlay')).map(node => node.id);
    const expected = ['link-systems-new', 'link-systems-refresh', 'link-systems-row-1', 'link-systems-row-2',
        'link-systems-name', 'link-systems-color-option-teal', 'link-systems-save', 'link-systems-delete'];
    for (let i = 1; i < expected.length; i++) assert.ok(order.indexOf(expected[i]) > order.indexOf(expected[i - 1]));
    const before = structuredClone(appState.linkSystems);
    const beforeRequests = requests.length;
    await dom.get('link-systems-new').dispatch('click');
    assert.equal(dom.get('link-systems-name').value, '');
    assert.equal(dom.get('link-systems-cancel').hidden, false);
    assert.equal(dom.get('link-systems-delete').hidden, true);
    assert.equal(dom.get('link-systems-row-2').getAttribute('aria-pressed'), 'false');
    assert.equal(document.activeElement, dom.get('link-systems-name'));
    dom.get('link-systems-name').value = '登録しない下書き';
    await dom.get('link-systems-color-option-violet').dispatch('click');
    window.confirm = () => false;
    await dom.get('link-systems-cancel').dispatch('click');
    assert.equal(dom.get('link-systems-name').value, '登録しない下書き');
    assert.equal(selectedColor(dom), 'violet');
    assert.equal(dom.get('link-systems-cancel').hidden, false);
    window.confirm = () => true;
    await dom.get('link-systems-cancel').dispatch('click');
    assert.equal(dom.get('link-systems-name').value, '合成無線LAN');
    assert.equal(selectedColor(dom), 'teal');
    assert.equal(dom.get('link-systems-row-2').getAttribute('aria-pressed'), 'true');
    assert.equal(document.activeElement, dom.get('link-systems-row-2'));
    assert.equal(dom.get('link-systems-cancel').hidden, true);
    assert.deepEqual(appState.linkSystems, before);
    assert.equal(requests.length, beforeRequests);
});

test('直前の系統が再読込で消えた場合のキャンセルは残る系統へ戻り、空の一覧では一度の破棄確認で閉じる', async t => {
    const { dom, requests, replaceSystems } = setup(t);
    await openLinkSystems();
    await dom.get('link-systems-new').dispatch('click');
    replaceSystems([{ id: 7, name: '合成代替系統', color_key: 'olive', resource_revision: 6, usage_count: 0 }]);
    await dom.get('link-systems-refresh').dispatch('click'); await drain();
    await dom.get('link-systems-cancel').dispatch('click');
    assert.equal(dom.get('link-systems-name').value, '合成代替系統');
    assert.equal(selectedColor(dom), 'olive');
    assert.equal(dom.get('link-systems-row-7').getAttribute('aria-pressed'), 'true');
    await dom.get('link-systems-new').dispatch('click');
    replaceSystems([]);
    await dom.get('link-systems-refresh').dispatch('click'); await drain();
    dom.get('link-systems-name').value = '未登録の系統';
    let confirms = 0;
    window.confirm = () => { confirms++; return true; };
    await dom.get('link-systems-cancel').dispatch('click');
    assert.equal(confirms, 1);
    assert.equal(dom.get('link-systems-overlay').hidden, true);
    assert.equal(getTopModalContainer(), null);
    assert.deepEqual(appState.linkSystems, []);
    assert.deepEqual(requests.map(row => row.action), ['list_link_systems', 'list_link_systems', 'list_link_systems']);
});
