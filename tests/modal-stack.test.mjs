import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerModalOpen, registerModalClose, getTopModalContainer } from '../public/js/core/modal-focus.js';
import { installWorkspaceDom } from './helpers/workspace-dom.mjs';

test('個票から開いたモーダルが前面とフォーカスを占有し、閉じると起動元へ戻る', () => {
    const original = Object.fromEntries(['window', 'document', 'HTMLElement'].map(key => [key, globalThis[key]]));
    class Element {
        constructor() { this.style = { zIndex: '' }; this.hidden = false; this.attributes = new Map(); this.dialog = { setAttribute: (key, value) => this.attributes.set(key, value) }; }
        querySelector(selector) { return selector === '[role="dialog"]' ? this.dialog : null; }
        querySelectorAll() { return []; }
        contains(value) { return this === value; }
        focus() { document.activeElement = this; }
    }
    globalThis.HTMLElement = Element;
    const opener = new Element();
    globalThis.document = { activeElement: opener, body: { contains: () => true }, getElementById: () => null };
    globalThis.window = { requestAnimationFrame: fn => fn() };
    const sheet = new Element();
    const manager = new Element();
    try {
        registerModalOpen('sheet-test', sheet);
        registerModalOpen('manager-test', manager);
        assert.equal(getTopModalContainer(), manager);
        assert.ok(Number(manager.style.zIndex) > Number(sheet.style.zIndex));
        assert.equal(sheet.inert, true);
        assert.equal(sheet.attributes.get('aria-modal'), 'false');
        assert.equal(manager.attributes.get('aria-modal'), 'true');
        assert.equal(document.activeElement, manager);
        registerModalClose('manager-test');
        assert.equal(sheet.inert, false);
        assert.equal(sheet.attributes.get('aria-modal'), 'true');
        assert.equal(document.activeElement, sheet);
        registerModalClose('sheet-test');
        assert.equal(document.activeElement, opener);
    } finally {
        registerModalClose('manager-test'); registerModalClose('sheet-test');
        for (const [key, value] of Object.entries(original)) {
            if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
        }
    }
});

test('フッターのCanvas操作は子モーダルと親モーダルの閉鎖まで隠し、Canvasなしでは復帰させない', t => {
    const keys = ['window', 'document', 'HTMLElement', 'Element'];
    const originals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const dom = installWorkspaceDom({ templates: ['templates/components/canvas.php', 'templates/components/status_bar.php'] });
    const controls = dom.get('canvas-view-controls');
    controls.hidden = false;
    const parent = dom.add('div', 'footer-parent-modal');
    const child = dom.add('div', 'footer-child-modal');
    t.after(() => {
        registerModalClose('footer-child', { restoreFocus: false });
        registerModalClose('footer-parent', { restoreFocus: false });
        for (const [key, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    });
    registerModalOpen('footer-parent', parent);
    assert.equal(controls.hidden, true);
    registerModalOpen('footer-child', child);
    registerModalClose('footer-child');
    assert.equal(controls.hidden, true);
    registerModalClose('footer-parent');
    assert.equal(controls.hidden, false);
    dom.get('canvas').remove();
    registerModalOpen('footer-parent', parent);
    registerModalClose('footer-parent');
    assert.equal(controls.hidden, true);
});

test('modal-focus: status-barのinert制御・container上のShift+Tab抑制・閉鎖rAF競合・閉じたdetailsへの復帰', t => {
    const keys = ['window', 'document', 'HTMLElement', 'Element'];
    const originals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const dom = installWorkspaceDom({ templates: ['templates/components/canvas.php', 'templates/components/status_bar.php'] });
    const statusBar = document.querySelector('.status-bar');
    statusBar.inert = false;

    const rafQueue = [];
    window.requestAnimationFrame = fn => { rafQueue.push(fn); return rafQueue.length; };
    const flushRaf = () => { while (rafQueue.length) rafQueue.shift()(); };

    t.after(() => {
        for (const id of ['trap-m', 'seq-old', 'seq-new', 'details-m']) {
            registerModalClose(id, { restoreFocus: false });
        }
        for (const [key, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    });

    // 1. status-bar inert + Shift+Tab on container itself
    const { initModalFocusTrap } = { initModalFocusTrap: null };
    return import('../public/js/core/modal-focus.js').then(async mod => {
        mod.initModalFocusTrap();
        const modal = dom.add('div', 'trap-modal');
        modal.tabIndex = -1;
        const b1 = dom.add('button', 'trap-b1', modal);
        const b2 = dom.add('button', 'trap-b2', modal);
        b1.tabIndex = 0; b2.tabIndex = 0;
        const details = dom.add('details', 'menu-details');
        details.open = true;
        const summary = dom.add('summary', 'menu-summary', details);
        summary.tabIndex = 0;
        const menuItem = dom.add('button', 'menu-item', details);
        menuItem.tabIndex = 0;
        menuItem.focus();

        mod.registerModalOpen('trap-m', modal, b1, { onClose: () => { modal.hidden = true; mod.registerModalClose('trap-m'); } });
        assert.equal(statusBar.inert, true);
        flushRaf();

        modal.focus();
        let prevented = false;
        await dom.events.dispatch('keydown', { key: 'Tab', shiftKey: true, preventDefault() { prevented = true; } });
        assert.equal(prevented, true);
        assert.equal(document.activeElement, b2, 'container自身でのShift+Tabも末尾要素へ循環し外へ逃げない');

        // 2. 閉鎖直後の別モーダル起動時に旧closeのrAFが初期フォーカスを奪わない
        details.open = false;
        modal.hidden = true;
        mod.registerModalClose('trap-m');
        const nextModal = dom.add('div', 'seq-modal');
        const nextFirst = dom.add('button', 'seq-first', nextModal);
        nextFirst.tabIndex = 0;
        const nextPreferred = dom.add('button', 'seq-preferred', nextModal);
        nextPreferred.tabIndex = 0;
        mod.registerModalOpen('seq-new', nextModal, nextPreferred, { restoreFocusTo: () => summary });
        flushRaf();
        assert.equal(document.activeElement, nextPreferred);
        nextModal.hidden = true;
        mod.registerModalClose('seq-new');
        assert.equal(statusBar.inert, false);
        flushRaf();
        assert.equal(document.activeElement, summary, '遷移先を閉じると可視の起点に戻る');

        // 3. 閉じたdetails内のボタン起動・閉鎖時はsummaryへフォーカス復帰する
        details.open = true;
        menuItem.focus();
        const detailsModal = dom.add('div', 'details-modal');
        const dmBtn = dom.add('button', 'dm-btn', detailsModal);
        dmBtn.tabIndex = 0;
        mod.registerModalOpen('details-m', detailsModal, dmBtn);
        flushRaf();
        details.open = false;
        detailsModal.hidden = true;
        mod.registerModalClose('details-m');
        flushRaf();
        assert.equal(document.activeElement, summary);
    });
});
