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
        get textContent() { return (this.text || '') + this.children.map(child => child.textContent).join(''); }
        set textContent(value) { this.text = String(value); this.children = []; }
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
    appState.buildings = [];
    appState.floors = [];
    appState.currentViewId = 1;
    let allowSelection = true;
    let rejectSelection = false;
    const names = () => list.children.map(option => option.children[0].textContent);
    const visibleText = option => [option.text || '', ...option.children
        .filter(child => child.getAttribute('aria-hidden') !== 'true')
        .map(visibleText)].join('');
    const search = value => { input.value = value; input.dispatch('input'); };
    const key = value => input.dispatch('keydown', { key: value });

    await t.test('現在経路だけを初期展開し手動開閉・検索・再表示・選択と所属変更を追従する', async () => {
        allowSelection = true;
        appState.buildings = [
            { id: 100, name: '本館', sort_order: 1 },
            { id: 200, name: '別棟', sort_order: 2 },
            { id: 300, name: '第三棟', sort_order: 3 }
        ];
        appState.floors = [
            { id: 101, building_id: 100, name: '本館1F', sort_order: 1 },
            { id: 102, building_id: 100, name: '本館2F', sort_order: 2 },
            { id: 201, building_id: 200, name: '別棟1F', sort_order: 1 },
            { id: 301, building_id: 300, name: '第三棟1F', sort_order: 1 }
        ];
        appState.views = [
            { id: 1001, name: '現在図', floor_id: 101, view_type: 'topology', sort_order: 1 },
            { id: 1002, name: '上階図', floor_id: 102, view_type: 'floor', sort_order: 2 },
            { id: 1003, name: '補助', floor_id: 101, view_type: 'rack', sort_order: 2 },
            { id: 2001, name: '別棟図', floor_id: 201, view_type: 'rack', sort_order: 3 },
            { id: 3001, name: '第三棟図', floor_id: 301, view_type: 'topology', sort_order: 4 },
            { id: 9001, name: '未所属図', floor_id: null, view_type: 'topology', sort_order: 5 }
        ];
        const row = name => list.children.find(option => option.children[0].textContent === name);
        const expanded = (name, expected) => assert.equal(row(name)?.getAttribute('aria-expanded'), String(expected), name);
        const selected = name => {
            assert.equal(row(name)?.getAttribute('aria-selected'), 'true');
            assert.equal(input.getAttribute('aria-activedescendant'), row(name)?.id);
            assert.equal(row(name)?.children[1].textContent, '現在');
        };
        appState.currentViewId = 1001;
        initViewCombobox(async id => {
            if (rejectSelection) throw new Error('selection failed');
            if (allowSelection) appState.currentViewId = id;
            return allowSelection;
        });
        input.dispatch('click');
        assert.deepEqual(names(), ['本館', '本館1F', '現在図', '補助', '本館2F / 上階図', '別棟', '第三棟', '未分類ビュー（1件）']);
        expanded('本館', true);
        expanded('本館1F', true);
        assert.equal(row('本館2F / 上階図')?.getAttribute('aria-expanded'), null);
        assert.equal(row('本館2F / 上階図')?.getAttribute('aria-level'), '2');
        const [floorName, floorIcon, floorViewName] = row('本館2F / 上階図').children[0].children;
        assert.equal(floorName.textContent, '本館2F / ');
        assert.equal(floorIcon.alt, '物理・フロア配置図');
        assert.equal(floorViewName.textContent, '上階図');
        assert.equal(row('本館2F / 上階図')?.children.length, 1, '直接選択行に開閉記号や重複するビュー行を出さない');
        expanded('別棟', false);
        expanded('第三棟', false);
        expanded('未分類ビュー（1件）', false);
        selected('現在図');

        // 現在経路を手動で閉じても、再描画・再表示で開き直さない。
        row('本館1F').dispatch('click');
        row('別棟').dispatch('click');
        assert.equal(row('別棟1F / 別棟図')?.children[0].children[1].alt, 'ラック搭載図');
        const manualNames = names();
        syncViewCombobox();
        assert.deepEqual(names(), manualNames);
        input.dispatch('blur');
        input.dispatch('click');
        assert.deepEqual(names(), manualNames);
        expanded('本館1F', false);
        expanded('別棟', true);
        assert.equal(input.getAttribute('aria-activedescendant'), row('本館').id);

        // 閉じたフロア・建物・未分類を含む全ビューが検索対象。
        search('図');
        assert.deepEqual(names(), ['現在図', '補助', '上階図', '別棟図', '第三棟図', '未所属図']);
        assert.equal(row('別棟図')?.children[1].textContent, '別棟 / 別棟1F');
        assert.equal(list.getAttribute('role'), 'listbox');
        assert.ok(list.children.every(option => option.getAttribute('aria-expanded') === null));
        search('');
        assert.deepEqual(names(), manualNames);
        assert.equal(list.getAttribute('role'), 'tree');
        expanded('本館1F', false);
        expanded('別棟', true);

        // 検索結果の実選択では新経路を開き、無関係な手動展開は保持する。
        search('上階図');
        await row('上階図').dispatch('click');
        assert.equal(appState.currentViewId, 1002);
        assert.equal(popup.hidden, true);
        input.dispatch('click');
        assert.equal(row('本館2F / 上階図')?.getAttribute('aria-expanded'), null);
        expanded('本館1F', false);
        expanded('別棟', true);
        selected('本館2F / 上階図');
        await row('本館2F / 上階図').dispatch('click');
        assert.equal(popup.hidden, true);
        assert.equal(appState.currentViewId, 1002);

        // 外部切替も、閉じたポップアップの次回表示で追従する。
        input.dispatch('blur');
        appState.currentViewId = 3001;
        syncViewCombobox();
        input.dispatch('click');
        expanded('第三棟', true);
        expanded('別棟', true);
        selected('第三棟1F / 第三棟図');
        assert.equal(row('第三棟1F / 第三棟図')?.children[0].children[1].alt, '論理構成図');

        // 同じビューのフロア変更と、フロア自体の建物変更にも追従する。
        row('本館2F / 上階図').dispatch('mouseenter');
        appState.views.find(view => view.id === 3001).floor_id = 102;
        syncViewCombobox();
        assert.equal(input.getAttribute('aria-activedescendant'), row('上階図').id);
        assert.equal(row('第三棟1F')?.children[1].textContent, 'ビューなし');
        expanded('本館2F', true);
        expanded('別棟', true);
        assert.equal(row('第三棟図')?.getAttribute('aria-selected'), 'true');
        row('第三棟').dispatch('click');
        input.dispatch('blur');
        appState.floors.find(floor => floor.id === 102).building_id = 300;
        syncViewCombobox();
        input.dispatch('click');
        expanded('第三棟', true);
        expanded('本館2F', true);
        expanded('別棟', true);
        selected('第三棟図');

        // 複数件の階を手動で閉じ、1件を経て複数件に戻っても閉じた状態を保持する。
        row('本館2F').dispatch('click');
        appState.views.find(view => view.id === 1002).floor_id = 301;
        syncViewCombobox();
        assert.equal(input.getAttribute('aria-activedescendant'), row('本館2F / 第三棟図').id);
        assert.equal(row('本館2F / 第三棟図').getAttribute('aria-selected'), 'true');
        appState.views.find(view => view.id === 1002).floor_id = 102;
        syncViewCombobox();
        expanded('本館2F', false);
        assert.equal(input.getAttribute('aria-activedescendant'), row('本館2F').id);

        row('別棟').dispatch('mouseenter');
        key('ArrowRight');
        const rack = row('別棟1F / 別棟図');
        assert.equal(input.getAttribute('aria-activedescendant'), rack.id);
        key('ArrowRight'); // 葉では何もしない。
        assert.equal(input.getAttribute('aria-activedescendant'), rack.id);
        key('ArrowLeft');
        assert.equal(input.getAttribute('aria-activedescendant'), row('別棟').id);
        key('ArrowDown');
        await key('Enter');
        assert.equal(appState.currentViewId, 2001);
        assert.equal(popup.hidden, true);
        input.dispatch('click');
        selected('別棟1F / 別棟図');

        // 新しい枝は未分類選択時に閉じ、未分類だけを初期展開する。
        input.dispatch('blur');
        appState.buildings = [{ id: 400, name: '未展開棟', sort_order: 1 }];
        appState.floors = [{ id: 401, building_id: 400, name: '未展開階', sort_order: 1 }];
        appState.views = [
            { id: 4001, name: '分類図', floor_id: 401, view_type: 'floor', sort_order: 1 },
            { id: 9002, name: '未分類選択図', floor_id: null, view_type: 'topology', sort_order: 2 }
        ];
        appState.currentViewId = 9002;
        syncViewCombobox();
        input.dispatch('click');
        assert.deepEqual(names(), ['未展開棟', '未分類ビュー（1件）', '未分類選択図']);
        expanded('未展開棟', false);
        expanded('未分類ビュー（1件）', true);
        selected('未分類選択図');
        row('未分類ビュー（1件）').dispatch('click');
        input.dispatch('blur');
        input.dispatch('click');
        expanded('未分類ビュー（1件）', false);
        search('分類');
        assert.deepEqual(names(), ['分類図', '未分類選択図']);
        search('');
        expanded('未分類ビュー（1件）', false);
        expanded('未展開棟', false);

        input.dispatch('blur');
        appState.buildings = []; appState.floors = [];
        appState.views = views.map(view => ({ ...view }));
        appState.currentViewId = 1;
        syncViewCombobox();
    });
    await t.test('旧施設情報から階層を作らず未分類グループで現在ビューを識別する', () => {
        assert.equal(input.value, '基幹ネットワーク');
        input.dispatch('click');
        assert.deepEqual(names(), ['未分類ビュー（3件）', '配置図', '基幹ネットワーク', '別館NW']);
        assert.equal(list.getAttribute('role'), 'tree');
        assert.equal(input.getAttribute('aria-haspopup'), 'tree');
        assert.equal(list.children[0].getAttribute('aria-expanded'), 'true');
        assert.equal(list.children[2].getAttribute('aria-level'), '2');
        assert.equal(input.getAttribute('aria-expanded'), 'true');
        assert.equal(list.children[2].getAttribute('aria-selected'), 'true');
        assert.equal(input.getAttribute('aria-activedescendant'), list.children[2].id);
        assert.equal(elements.get('view-search-summary').classes.has('visually-hidden'), true);
        assert.ok(elements.get('view-search-summary').textContent);
        assert.equal(visibleText(list.children[2]), '基幹ネットワーク');
        assert.equal(list.children[2].children[0].children[0].alt, '論理構成図');
        assert.doesNotMatch(visibleText(list.children[2]), /旧情報|論理構成図|未分類/);
        assert.equal(popup.style.left, '1078px');
    });
    await t.test('名称・種別を検索し旧文字列を検索対象にしない', () => {
        for (const [query, expected] of [
            ['基幹', ['基幹ネットワーク']], ['別館', ['別館NW']], ['３ｆ', []], ['本庁舎', []],
            ['フロア', ['配置図']], ['論理', ['基幹ネットワーク', '別館NW']], ['基幹 論理', ['基幹ネットワーク']]
        ]) { search(query); assert.deepEqual(names(), expected); }
        assert.equal(list.getAttribute('role'), 'listbox');
        assert.equal(input.getAttribute('aria-haspopup'), 'listbox');
        assert.equal(visibleText(list.children[0]), '基幹ネットワーク未分類');
        assert.equal(list.children[0].getAttribute('role'), 'option');
        assert.equal(elements.get('view-search-summary').classes.has('visually-hidden'), true);
        search('存在しない');
        assert.deepEqual(names(), []);
        assert.equal(elements.get('view-search-summary').classes.has('visually-hidden'), false);
        assert.ok(elements.get('view-search-summary').textContent);
        assert.equal(input.getAttribute('aria-activedescendant'), null);
        key('Enter');
        assert.equal(appState.currentViewId, 1);
    });
    await t.test('矢印で循環移動しIME確定を選択と混同せずEnterで選択する', async () => {
        search('');
        assert.equal(elements.get('view-search-summary').classes.has('visually-hidden'), true);
        key('ArrowUp');
        assert.equal(input.getAttribute('aria-activedescendant'), list.children[1].id);
        key('ArrowUp');
        assert.equal(input.getAttribute('aria-activedescendant'), list.children[0].id);
        key('ArrowUp');
        assert.equal(input.getAttribute('aria-activedescendant'), list.children[3].id);
        key('ArrowDown');
        assert.equal(input.getAttribute('aria-activedescendant'), list.children[0].id);
        key('ArrowDown');
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
        rejectSelection = true;
        search('別館');
        await assert.rejects(list.children[0].dispatch('click'), /selection failed/);
        assert.equal(appState.currentViewId, 2);
        assert.equal(input.value, '配置図');
        assert.equal(popup.hidden, true);
        rejectSelection = false;
        input.dispatch('click');
        assert.equal(list.children.find(row => row.getAttribute('aria-selected') === 'true').children[0].textContent, '配置図');
        input.dispatch('blur');
    });
    await t.test('建物・フロア・空階層を選択せず開閉し左右キーで親子へ移動する', async () => {
        // 前ケースで開いた未分類も、利用者が閉じた状態から分類済みへ移る。
        input.dispatch('click');
        list.children[0].dispatch('click');
        input.dispatch('blur');
        appState.buildings = [
            { id: 10, name: '新庁舎', sort_order: 1 },
            { id: 20, name: '空の建物', sort_order: 2 }
        ];
        appState.floors = [
            { id: 11, building_id: 10, name: '4F', sort_order: 1 },
            { id: 12, building_id: 10, name: '空フロア', sort_order: 2 }
        ];
        appState.views[0].floor_id = 11;
        appState.views[1].floor_id = 11;
        input.dispatch('click');
        assert.deepEqual(names(), ['新庁舎', '4F', '配置図', '基幹ネットワーク', '空フロア', '空の建物', '未分類ビュー（1件）']);
        assert.equal(visibleText(list.children[0]), '新庁舎');
        assert.equal(visibleText(list.children[1]), '4F');
        assert.equal(visibleText(list.children[2]), '配置図');
        assert.equal(visibleText(list.children[3]), '基幹ネットワーク');
        assert.equal(list.children[2].children[0].children[0].alt, '物理・フロア配置図');
        assert.doesNotMatch(visibleText(list.children[3]), /新庁舎|4F|本庁舎|3F|旧情報|論理構成図/);
        assert.equal(input.getAttribute('aria-activedescendant'), list.children[2].id);
        assert.equal(list.children[2].getAttribute('aria-level'), '3');
        assert.equal(list.children[1].getAttribute('aria-posinset'), '1');
        assert.equal(list.children[1].getAttribute('aria-setsize'), '2');
        key('ArrowLeft');
        assert.equal(input.getAttribute('aria-activedescendant'), list.children[1].id);
        await key('Enter');
        assert.deepEqual(names(), ['新庁舎', '4F', '空フロア', '空の建物', '未分類ビュー（1件）']);
        assert.equal(list.children[1].getAttribute('aria-expanded'), 'false');
        assert.equal(appState.currentViewId, 2);
        syncViewCombobox();
        assert.equal(list.children[1].getAttribute('aria-expanded'), 'false');
        key('ArrowRight');
        assert.equal(list.children[1].getAttribute('aria-expanded'), 'true');
        key('ArrowRight');
        assert.equal(input.getAttribute('aria-activedescendant'), list.children[2].id);
        key('ArrowLeft'); key('ArrowLeft'); key('ArrowLeft');
        assert.equal(input.getAttribute('aria-activedescendant'), list.children[0].id);
        key('ArrowLeft');
        assert.deepEqual(names(), ['新庁舎', '空の建物', '未分類ビュー（1件）']);
        key('ArrowRight');
        assert.equal(list.children[0].getAttribute('aria-expanded'), 'true');
        await list.children[2].dispatch('click');
        assert.equal(appState.currentViewId, 2);
        assert.equal(popup.hidden, false);
        assert.match(list.children[2].children[1].textContent, /ビューなし/);
        assert.equal(list.children[2].getAttribute('aria-expanded'), null);
        await list.children[3].dispatch('click');
        assert.equal(appState.currentViewId, 2);
        assert.match(list.children[3].children[1].textContent, /フロアなし/);
        search('新庁舎 ４ｆ 論理');
        assert.deepEqual(names(), ['基幹ネットワーク']);
        assert.equal(list.children[0].children[0].textContent, '基幹ネットワーク');
        assert.equal(visibleText(list.children[0]), '基幹ネットワーク新庁舎 / 4F');
        assert.doesNotMatch(visibleText(list.children[0]), /本庁舎|3F|旧情報|論理構成図/);
        search('本庁舎 3F 論理');
        assert.deepEqual(names(), []);
        search('新庁舎'); search('');
        assert.equal(list.children[1].getAttribute('aria-expanded'), 'false');
        let prevented = false;
        list.children[0].dispatch('pointerdown', { preventDefault() { prevented = true; } });
        assert.equal(prevented, true);
        const activeBeforeComposition = input.getAttribute('aria-activedescendant');
        input.dispatch('keydown', { key: 'ArrowRight', isComposing: true });
        assert.equal(list.children[1].getAttribute('aria-expanded'), 'false');
        assert.equal(input.getAttribute('aria-activedescendant'), activeBeforeComposition);
        appState.views = [];
        appState.currentViewId = null;
        syncViewCombobox();
        assert.equal(input.disabled, false);
        input.dispatch('click');
        assert.ok(names().includes('空の建物'));
        assert.ok(names().includes('空フロア'));
        assert.equal(list.children.some(row => row.getAttribute('aria-selected') === 'true'), false);
        input.dispatch('blur');
        appState.buildings = []; appState.floors = [];
        appState.views = views.map(view => ({ ...view }));
        appState.currentViewId = 2;
        syncViewCombobox();
    });
    await t.test('未分類では旧情報を表示・検索せず名称を安全に表示する', () => {
        appState.views = [
            { id: 70, name: '<img onerror=alert(1)>', facility: '  ', floor: null, view_type: 'rack', sort_order: 1 },
            { id: 71, name: '施設のみ', facility: '旧施設', floor: '', view_type: 'floor', sort_order: 2 },
            { id: 72, name: '階のみ', facility: null, floor: '地下', view_type: 'topology', sort_order: 3 }
        ];
        appState.currentViewId = 70;
        syncViewCombobox();
        input.dispatch('click');
        assert.equal(visibleText(list.children[1]), '<img onerror=alert(1)>');
        assert.equal(list.children[1].children[0].children.length, 1);
        assert.equal(list.children[1].children[0].children[0].tagName, 'IMG');
        assert.equal(list.children[1].children[0].children[0].alt, 'ラック搭載図');
        assert.equal(visibleText(list.children[2]), '施設のみ');
        assert.equal(visibleText(list.children[3]), '階のみ');
        search('ラック');
        assert.deepEqual(names(), ['<img onerror=alert(1)>']);
        assert.equal(visibleText(list.children[0]), '<img onerror=alert(1)>未分類');
        assert.equal(list.children[0].getAttribute('aria-selected'), 'true');
        search('旧施設');
        assert.deepEqual(names(), []);
        search('地下');
        assert.deepEqual(names(), []);
        input.dispatch('blur');
        appState.views = views.map(view => ({ ...view }));
        appState.currentViewId = 2;
        syncViewCombobox();
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
        assert.deepEqual(names(), ['未分類ビュー（1件）', '読込後']);
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

    await t.test('有効な建物の建物全体だけを出し、無効な建物のフロアと通常ビューは残す', async () => {
        appState.buildings = [{ id: 700, name: '積層試験棟', sort_order: 0, building_view_enabled: 1 }];
        appState.floors = [];
        appState.views = views.map(view => ({ ...view }));
        appState.currentViewId = 1;
        const before = structuredClone(appState.views);
        const normal = [];
        const selected = [];
        initViewCombobox(id => normal.push(id), id => selected.push(id));
        search('建物全体');
        assert.deepEqual(names(), ['積層試験棟 / 建物全体']);
        search('積層試験棟 3D');
        assert.deepEqual(names(), ['積層試験棟 / 建物全体']);
        await list.children[0].dispatch('click');
        assert.deepEqual(selected, [700]);
        assert.deepEqual(appState.views, before);
        input.dispatch('click');
        const building = list.children.find(option => option.children[0].textContent === '積層試験棟');
        assert.match(visibleText(building), /フロアなし/);
        await building.dispatch('click');
        const whole = list.children.find(option => option.children[0].textContent === '建物全体');
        assert.ok(whole, 'フロアなしの建物も建物全体を選択できる');
        await whole.dispatch('click');
        assert.deepEqual(selected, [700, 700]);
        assert.equal(appState.currentViewId, 1);

        appState.buildings.push({ id: 701, name: '単一階棟', sort_order: 1, building_view_enabled: 0 });
        appState.floors = [{ id: 711, building_id: 701, name: '1F', sort_order: 0 }];
        appState.views = [{ ...views[0], id: 1, floor_id: 711 }];
        appState.currentViewId = 1;
        syncViewCombobox();
        input.dispatch('click');
        const withFloor = list.children.find(option => option.children[0].textContent === '単一階棟');
        assert.doesNotMatch(visibleText(withFloor), /フロアなし/, '1件フロア置換後もフロアありの建物にはフロアなしを出さない');
        assert.equal(names().slice(names().indexOf('単一階棟')).includes('建物全体'), false,
            '無効な建物の展開済み階層に建物全体がない');
        await list.children.find(option => option.children[0].textContent === `1F / ${views[0].name}`).dispatch('click');
        assert.deepEqual(normal, [1], '無効な建物でも単一ビューの直行行を選べる');
        search('単一階棟 3D');
        assert.deepEqual(names(), []);
        search('単一階棟 建物全体');
        assert.deepEqual(names(), []);
        search(`単一階棟 ${views[0].name}`);
        assert.deepEqual(names(), [views[0].name]);
        await key('Enter');
        assert.deepEqual(normal, [1, 1], '無効な建物でも通常ビューを検索して開ける');
        search('建物全体');
        const stale = list.children[0];
        assert.deepEqual(names(), ['積層試験棟 / 建物全体']);
        appState.buildings[0].building_view_enabled = 0;
        await stale.dispatch('click');
        assert.deepEqual(selected, [700, 700], '表示直後に無効になった行も起動しない');
        syncViewCombobox();
        assert.deepEqual(names(), []);
    });
});
