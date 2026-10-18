import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appState } from '../public/js/core/state.js';
import { initViewCombobox, syncViewCombobox } from '../public/js/ui/view-combobox.js';
import {
    showCanvasContextToolbar,
    handleCanvasContextToolbarKeydown,
    hideCanvasContextToolbar
} from '../public/js/ui/canvas-context-toolbar.js';

test('ビュー検索の候補・操作・現在表示', async t => {
    const previous = { ...appState };
    const globals = new Map(['window', 'document'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    t.after(() => {
        Object.assign(appState, previous);
        for (const [key, descriptor] of globals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    });
    class Element {
        constructor(tagName = 'DIV') {
            this.tagName = tagName;
            this.children = []; this.attributes = new Map(); this.events = new Map(); this.style = {};
            this.hidden = true; this.value = ''; this.classes = new Set(); this.dataset = {};
            this.classList = { toggle: (name, on) => on ? this.classes.add(name) : this.classes.delete(name) };
        }
        addEventListener(type, fn) { this.events.set(type, fn); }
        dispatch(type, event = {}) { return this.events.get(type)?.({ target: this, preventDefault() {}, stopPropagation() {}, ...event }); }
        setAttribute(key, value) { this.attributes.set(key, String(value)); }
        removeAttribute(key) { this.attributes.delete(key); }
        getAttribute(key) { return this.attributes.get(key) ?? null; }
        replaceChildren() { this.children = []; }
        appendChild(child) { this.children.push(child); }
        scrollIntoView() {}
        contains(target) { return target === this || this.children.some(child => child.contains(target)); }
        getBoundingClientRect() { return { left: 1150, width: 240, bottom: 40 }; }
        querySelectorAll(selector) {
            return selector === '[data-canvas-context]' ? this.children.filter(child => child.dataset.canvasContext) : [];
        }
        querySelector() { return null; }
    }
    const elements = new Map([
        ['view-search-input', new Element('INPUT')],
        ['view-search-popup', new Element('DIV')],
        ['view-search-results', new Element('DIV')],
        ['view-search-summary', new Element('DIV')],
        ['view-switcher', new Element('DIV')]
    ]);
    const doc = new Element('DOCUMENT');
    globalThis.document = {
        getElementById: id => elements.get(id), createElement: tag => new Element(tag ? String(tag).toUpperCase() : 'DIV'),
        addEventListener: doc.addEventListener.bind(doc)
    };
    globalThis.window = { innerWidth: 1366, innerHeight: 768, addEventListener() {} };
    const input = elements.get('view-search-input');
    const popup = elements.get('view-search-popup');
    const list = elements.get('view-search-results');
    const views = [
        { id: 1, name: '基幹ネットワーク', facility: '本庁舎', floor: '3F', view_type: 'topology', sort_order: 20 },
        { id: 2, name: '配置図', facility: '本庁舎', floor: '3F', view_type: 'floor', sort_order: 10 },
        { id: 3, name: '別館NW', facility: '別館', floor: '1F', view_type: 'topology', sort_order: 20 }
    ];
    appState.views = views.map(view => ({ ...view }));
    appState.currentViewId = 1;
    let allowSelection = true;
    initViewCombobox(async id => {
        if (allowSelection) appState.currentViewId = id;
        return allowSelection;
    });
    const names = () => list.children.map(option => option.children[0].textContent);
    const search = value => { input.value = value; input.dispatch('input'); };
    const key = value => input.dispatch('keydown', { key: value });

    await t.test('クリックで表示順の全候補を開き現在ビューを識別する', () => {
        assert.equal(input.value, '基幹ネットワーク');
        input.dispatch('click');
        assert.deepEqual(names(), ['配置図', '基幹ネットワーク', '別館NW']);
        assert.equal(input.getAttribute('aria-expanded'), 'true');
        assert.equal(list.children[1].getAttribute('aria-selected'), 'true');
        assert.equal(input.getAttribute('aria-activedescendant'), list.children[1].id);
        assert.equal(popup.style.left, '1078px');
    });
    await t.test('名称・施設・フロア・種別と複数語を検索し0件を通知する', () => {
        for (const [query, expected] of [
            ['基幹', ['基幹ネットワーク']], ['別館', ['別館NW']], ['３ｆ', ['配置図', '基幹ネットワーク']],
            ['フロア', ['配置図']], ['論理', ['基幹ネットワーク', '別館NW']], ['本庁舎 3F 論理', ['基幹ネットワーク']]
        ]) { search(query); assert.deepEqual(names(), expected); }
        search('存在しない');
        assert.deepEqual(names(), []);
        assert.equal(elements.get('view-search-summary').textContent, '該当するビューがありません');
        assert.equal(input.getAttribute('aria-activedescendant'), null);
        key('Enter');
        assert.equal(appState.currentViewId, 1);
    });
    await t.test('矢印で循環移動しIME確定を選択と混同せずEnterで選択する', async () => {
        search('');
        key('ArrowUp');
        assert.equal(input.getAttribute('aria-activedescendant'), list.children[0].id);
        key('ArrowUp');
        assert.equal(input.getAttribute('aria-activedescendant'), list.children[2].id);
        key('ArrowDown');
        assert.equal(input.getAttribute('aria-activedescendant'), list.children[0].id);
        await input.dispatch('keydown', { key: 'Enter', isComposing: true });
        assert.equal(appState.currentViewId, 1);
        await key('Enter');
        assert.equal(appState.currentViewId, 2);
        assert.equal(input.value, '配置図');
        assert.equal(popup.hidden, true);
    });
    await t.test('Esc・blur・外部クリックと選択拒否は現在名に戻し自由入力を保存しない', async () => {
        for (const close of [() => key('Escape'), () => input.dispatch('blur'), () => doc.dispatch('pointerdown', { target: new Element() })]) {
            search('自由入力'); close();
            assert.equal(input.value, '配置図');
            assert.equal(popup.hidden, true);
            assert.equal(input.getAttribute('aria-expanded'), 'false');
            assert.equal(input.getAttribute('aria-activedescendant'), null);
        }
        allowSelection = false;
        search('別館');
        await list.children[0].dispatch('click');
        assert.equal(appState.currentViewId, 2);
        assert.equal(input.value, '配置図');
        assert.deepEqual(appState.views, views);
    });
    await t.test('再描画中の検索を保持し再読込・名称変更・削除に同期する', () => {
        search('別館');
        appState.views[2].name = '別館更新';
        syncViewCombobox();
        assert.equal(input.value, '別館');
        assert.deepEqual(names(), ['別館更新']);
        appState.views = [{ id: 50, name: '読込後', facility: '新施設', floor: '2F', view_type: 'floor', sort_order: 1 }];
        appState.currentViewId = 50;
        syncViewCombobox();
        assert.equal(input.value, '読込後');
        input.dispatch('click');
        assert.deepEqual(names(), ['読込後']);
        input.dispatch('blur');
        appState.views[0].name = '名称更新';
        syncViewCombobox();
        assert.equal(input.value, '名称更新');
        appState.views = []; appState.currentViewId = null;
        syncViewCombobox();
        assert.equal(input.disabled, true);
        assert.equal(input.value, '');
        assert.equal(popup.hidden, true);
    });
    await t.test('コンテキストツールバー表示中でも検索入力のEscでツールバーを終了させない', () => {
        appState.views = views.map(view => ({ ...view }));
        appState.currentViewId = 1;
        syncViewCombobox();
        let finishedReason = null;
        const toolbar = new Element('DIV');
        const panel = new Element('DIV');
        panel.dataset.canvasContext = 'test-context';
        panel.setAttribute('aria-label', 'テストコンテキスト');
        toolbar.appendChild(panel);
        elements.set('canvas-context-toolbar', toolbar);
        showCanvasContextToolbar('test-context', reason => { finishedReason = reason; });
        input.dispatch('click');
        const escapeEvent = { key: 'Escape', target: input, preventDefault() {}, stopImmediatePropagation() {} };
        assert.equal(handleCanvasContextToolbarKeydown(escapeEvent), false);
        assert.equal(finishedReason, null);
        key('Escape');
        assert.equal(popup.hidden, true);
        assert.equal(finishedReason, null);
        hideCanvasContextToolbar('test-context');
    });
});
