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
