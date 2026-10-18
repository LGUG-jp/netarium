import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installWorkspaceDom } from './helpers/workspace-dom.mjs';
import { registerModalOpen, registerModalClose, getTopModalContainer, requestModalClose, initModalFocusTrap } from '../public/js/core/modal-focus.js';
import { openPasswordChange, closeAccountManagement, initializeAccountManagement } from '../public/js/modals/account-modal.js';
import { onKeyDown } from '../public/js/canvas/selection.js';
import { chooseUnsavedChanges } from '../public/js/core/unsaved-changes-dialog.js';
import { appState, normalizeDevice } from '../public/js/core/state.js';
import { resetResourceBaseline } from '../public/js/core/resource-save.js';
import { openLedgerBulkEdit, closeLedgerBulkEdit, ledgerSelectedDeviceIds } from '../public/js/modals/ledger-modal.js';

function setup(t, templates = ['templates/modals/account.php']) {
    const keys = ['window', 'document', 'HTMLElement', 'Element'];
    const originals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const dom = installWorkspaceDom({ templates, phpSetup: '$isAdmin = true;' });
    document.createTextNode = text => Object.assign(document.createElement('span'), { textContent: text });
    t.after(() => {
        window.confirm = () => true;
        closeLedgerBulkEdit();
        for (const id of ['pending-modal', 'stack-child', 'stack-parent', 'account']) {
            registerModalClose(id, { restoreFocus: false });
        }
        for (const [key, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    });
    initializeAccountManagement();
    initModalFocusTrap();
    return dom;
}

function escape() {
    return onKeyDown({ key: 'Escape', preventDefault() {}, stopImmediatePropagation() {} });
}

test('パスワード変更をEscで閉じ、起動元へフォーカスを戻す', async t => {
    const dom = setup(t);
    const opener = dom.add('button', 'account-opener');
    opener.focus();
    openPasswordChange();
    await escape();
    assert.equal(dom.get('account-overlay').hidden, true);
    assert.equal(getTopModalContainer(), null);
    assert.equal(document.activeElement, opener);
});

test('パスワードの未確定入力は×・背景・Escで同じ破棄判定を使う', async t => {
    const dom = setup(t);
    let confirmations = 0;
    let discard = false;
    window.confirm = () => { confirmations++; return discard; };
    for (const close of [closeAccountManagement, () => dom.get('account-overlay').click(), escape]) {
        openPasswordChange();
        dom.get('own-new-password').value = 'synthetic-uncommitted-password';
        const before = confirmations;
        await close();
        assert.equal(confirmations, before + 1);
        assert.equal(dom.get('account-overlay').hidden, false);
        assert.equal(dom.get('own-new-password').value, 'synthetic-uncommitted-password');
        discard = true;
        await close();
        assert.equal(dom.get('account-overlay').hidden, true);
        assert.equal(dom.get('own-new-password').value, '');
        assert.equal(getTopModalContainer(), null);
        discard = false;
    }
});

test('最前面だけを閉じ、Tab循環・親への復帰・Canvas遮断を最後まで維持する', async t => {
    const dom = setup(t);
    const canvas = dom.add('div', 'canvas');
    canvas.inert = false;
    const opener = dom.add('button', 'modal-opener');
    const parent = dom.add('div', 'stack-parent');
    const first = dom.add('button', 'parent-first', parent);
    const last = dom.add('button', 'parent-last', parent);
    const child = dom.add('div', 'stack-child');
    const childButton = dom.add('button', 'child-action', child);
    opener.focus();
    registerModalOpen('stack-parent', parent, first, { onClose: () => {
        parent.hidden = true;
        registerModalClose('stack-parent');
    } });
    assert.equal(canvas.inert, true);
    last.focus();
    let prevented = false;
    await dom.events.dispatch('keydown', { key: 'Tab', preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(document.activeElement, first);
    await dom.events.dispatch('keydown', { key: 'Tab', shiftKey: true });
    assert.equal(document.activeElement, last);
    registerModalOpen('stack-child', child, childButton, { onClose: () => {
        child.hidden = true;
        registerModalClose('stack-child');
    } });
    assert.equal(parent.inert, true);
    await parent.click();
    assert.equal(getTopModalContainer(), child);
    await escape();
    assert.equal(child.hidden, true);
    assert.equal(parent.inert, false);
    assert.equal(canvas.inert, true);
    assert.equal(document.activeElement, last);
    opener.focus();
    await dom.events.dispatch('focusin', { target: opener });
    assert.equal(document.activeElement, first);
    await parent.click();
    assert.equal(parent.hidden, true);
    assert.equal(canvas.inert, false);
    assert.equal(document.activeElement, opener);
    prevented = false;
    await dom.events.dispatch('keydown', { key: 'Tab', preventDefault() { prevented = true; } });
    assert.equal(prevented, false);
    assert.equal(getTopModalContainer(), null);
});

test('破棄確認の×・背景・Escは編集継続へ戻し、確認overlayを残さない', async t => {
    const dom = setup(t);
    for (const close of [
        () => dom.get('unsaved-changes-overlay').querySelector('.modal-close-btn').click(),
        () => dom.get('unsaved-changes-overlay').click(),
        escape
    ]) {
        const choice = chooseUnsavedChanges();
        await close();
        assert.equal(await choice, 'cancel');
        assert.equal(dom.get('unsaved-changes-overlay'), null);
        assert.equal(getTopModalContainer(), null);
    }
});

test('閉鎖判定待ちの反復Escや背景クリックで確認を重複しない', async t => {
    const dom = setup(t);
    const overlay = dom.add('div', 'pending-modal');
    let resolve;
    let calls = 0;
    const decision = new Promise(done => { resolve = done; });
    registerModalOpen('pending-modal', overlay, null, { onClose: () => {
        calls++;
        return decision;
    } });
    const pending = requestModalClose();
    await requestModalClose();
    await overlay.click();
    assert.equal(calls, 1);
    resolve(false);
    await pending;
    assert.equal(getTopModalContainer(), overlay);
    await requestModalClose();
    assert.equal(calls, 2);
});

test('機器一括編集は未適用の入力を閉鎖拒否で保持し、破棄しても元データを変えない', async t => {
    const dom = setup(t, ['templates/modals/account.php', 'templates/modals/ledger.php']);
    const saved = { ...appState };
    t.after(() => { Object.assign(appState, saved); ledgerSelectedDeviceIds.clear(); });
    appState.devices = [normalizeDevice({ id: 901, name: '架空閉鎖試験', facility: '元施設', resource_revision: 1 })];
    appState.views = []; appState.placements = []; appState.links = [];
    appState.resourceConflicts = { devices: new Map(), views: new Map() };
    appState.isPinging = false; appState.authExpired = false;
    resetResourceBaseline(appState);
    ledgerSelectedDeviceIds.add(901);
    for (const close of [closeLedgerBulkEdit, () => dom.get('ledger-bulk-edit-overlay').click(), escape]) {
        await openLedgerBulkEdit();
        const opt = dom.get('ledger-bulk-change-facility');
        const value = dom.get('ledger-bulk-value-facility');
        opt.checked = true; value.value = '未適用施設';
        window.confirm = () => false;
        await close();
        assert.equal(dom.get('ledger-bulk-edit-overlay').hidden, false);
        assert.equal(opt.checked, true);
        assert.equal(value.value, '未適用施設');
        assert.equal(appState.devices[0].facility, '元施設');
        window.confirm = () => true;
        await close();
        assert.equal(dom.get('ledger-bulk-edit-overlay').hidden, true);
        assert.equal(appState.devices[0].facility, '元施設');
        assert.equal(getTopModalContainer(), null);
    }
});
