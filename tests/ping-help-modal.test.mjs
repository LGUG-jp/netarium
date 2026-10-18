import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installWorkspaceDom } from './helpers/workspace-dom.mjs';
import { appState, normalizeDevice } from '../public/js/core/state.js';
import { discardDeviceDrafts, getDeviceDraft } from '../public/js/core/device-drafts.js';
import { openLedgerDetail, closeLedgerDetailPane } from '../public/js/modals/ledger-modal.js';
import { openPingHelpDialog, closePingHelpDialog } from '../public/js/modals/ping-help-modal.js';
import { getTopModalContainer, initModalFocusTrap, registerModalClose } from '../public/js/core/modal-focus.js';
import { onKeyDown } from '../public/js/canvas/selection.js';

async function setup(t) {
    const globals = new Map(['window', 'document', 'HTMLElement', 'Element'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const state = { ...appState };
    const dom = installWorkspaceDom({
        templates: ['templates/components/property_panel.php', 'templates/modals/ledger.php'],
        phpSetup: '$isAdmin = true;'
    });
    document.readyState = 'loading';
    const { registerStaticListeners } = await import('../public/js/main.js');
    registerStaticListeners();
    initModalFocusTrap();
    t.after(async () => {
        closePingHelpDialog();
        discardDeviceDrafts('sheet');
        await closeLedgerDetailPane();
        registerModalClose('ledger-device-sheet', { restoreFocus: false });
        Object.assign(appState, state);
        for (const [key, descriptor] of globals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    });
    return dom;
}

function escape() {
    return onKeyDown({ key: 'Escape', preventDefault() {}, stopImmediatePropagation() {} });
}

test('右プロパティのPing結果ヘルプは×・背景・Escで閉じ、同じ補助ボタンへ戻る', async t => {
    const dom = await setup(t);
    dom.get('panel').hidden = false;
    dom.get('panel').classList.remove('hidden');
    dom.get('p-group-extra').open = true;
    const opener = dom.get('p-ping-help-btn');
    const overlay = dom.get('ping-help-overlay');
    const close = dom.get('ping-help-close-btn');
    for (const dismiss of [() => close.click(), () => overlay.click(), escape]) {
        opener.focus();
        await opener.click();
        assert.equal(overlay.hidden, false);
        assert.equal(getTopModalContainer(), overlay);
        assert.equal(document.activeElement, close);
        // 繰り返し開いてもstackを増やさない。
        openPingHelpDialog();
        await dismiss();
        assert.equal(overlay.hidden, true);
        assert.equal(getTopModalContainer(), null);
        assert.equal(document.activeElement, opener);
    }
});

test('実機器個票の同一Pingヘルプは親の入力・stackを保持し、Tab循環とEsc復帰を提供する', async t => {
    const dom = await setup(t);
    appState.devices = [normalizeDevice({ id: 1, name: 'Synthetic switch', type: 'switch', status: 'red' })];
    appState.views = [];
    appState.placements = [];
    appState.deviceImages = [];
    appState.isPinging = false;
    appState.authExpired = false;
    const outside = dom.add('button', 'sheet-opener');
    outside.focus();
    await openLedgerDetail(1);
    const parent = dom.get('ledger-device-sheet-overlay');
    const opener = dom.get('ledger-sheet-ping-help-btn');
    const overlay = dom.get('ping-help-overlay');
    const close = dom.get('ping-help-close-btn');
    const input = dom.get('ledger-sheet-body').querySelector('[data-field="name"]');
    input.value = '保持する未適用入力';
    await input.dispatch('input');
    for (const dismiss of [() => close.click(), () => overlay.click(), escape]) {
        opener.focus();
        await opener.click();
        assert.equal(getTopModalContainer(), overlay);
        assert.equal(parent.inert, true);
        assert.equal(parent.querySelector('[role="dialog"]').getAttribute('aria-modal'), 'false');
        assert.ok(Number(overlay.style.zIndex) > Number(parent.style.zIndex));
        for (const shiftKey of [false, true]) {
            let prevented = false;
            await dom.events.dispatch('keydown', { key: 'Tab', shiftKey, preventDefault() { prevented = true; } });
            assert.equal(prevented, true);
            assert.equal(document.activeElement, close);
        }
        await parent.click();
        assert.equal(getTopModalContainer(), overlay, '親の背景クリックは子を閉じない');
        await dismiss();
        assert.equal(overlay.hidden, true);
        assert.equal(parent.hidden, false);
        assert.equal(parent.inert, false);
        assert.equal(parent.querySelector('[role="dialog"]').getAttribute('aria-modal'), 'true');
        assert.equal(getTopModalContainer(), parent);
        assert.equal(document.activeElement, opener);
        assert.equal(input.value, '保持する未適用入力');
        assert.equal(getDeviceDraft('sheet', 1).name, '保持する未適用入力');
    }
    discardDeviceDrafts('sheet');
    await closeLedgerDetailPane();
    assert.equal(getTopModalContainer(), null);
    assert.equal(document.activeElement, outside);
});
