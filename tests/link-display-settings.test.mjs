import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { appState } from '../public/js/core/state.js';
import { eventBus } from '../public/js/core/event-bus.js';
import {
    getLinkCrossingStyle,
    initializeLinkDisplaySettings,
    setLinkCrossingStyle
} from '../public/js/core/link-display-settings.js';
import { initializeLinkDisplayModal } from '../public/js/modals/link-display-modal.js';

const key = 'netarium.linkCrossingStyle';
const originalWindow = globalThis.window;
const originalDocument = globalThis.document;
const originalEmit = eventBus.emit;
let values;
let events;
let writes;
let initialState;

beforeEach(() => {
    values = new Map();
    events = [];
    writes = [];
    globalThis.window = {
        localStorage: {
            getItem(name) { return values.get(name) ?? null; },
            setItem(name, value) {
                writes.push([name, value]);
                values.set(name, value);
            }
        }
    };
    eventBus.emit = (name, ...args) => {
        events.push({ name, args, style: getLinkCrossingStyle(), saved: values.get(key) });
    };
    initializeLinkDisplaySettings();
    appState.appStatus.dirty = true;
    appState.appStatus.state = 'error';
    appState.dataRevision = 37;
    appState.monitorRevision = 12;
    initialState = structuredClone(appState);
});

afterEach(() => {
    // 未保存状態やrevisionだけでなく、構成を含む共有状態全体を変更しない。
    assert.deepEqual(appState, initialState);
    eventBus.emit = originalEmit;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
});

test('未使用の端末は山形ブリッジで起動し、読込時に保存や再描画をしない', () => {
    assert.equal(getLinkCrossingStyle(), 'bridge');
    assert.deepEqual(writes, []);
    assert.deepEqual(events, []);
});

test('保存後に状態を反映し、リンクだけを即時再描画する', () => {
    assert.equal(setLinkCrossingStyle('gap'), 'gap');
    assert.equal(getLinkCrossingStyle(), 'gap');
    assert.deepEqual(writes, [[key, 'gap']]);
    assert.deepEqual(events, [{
        name: 'canvas:render-links', args: [], style: 'gap', saved: 'gap'
    }]);
    assert.equal(setLinkCrossingStyle('bridge'), 'bridge');
    assert.equal(values.get(key), 'bridge');
});

test('再読込した独立したモジュールにも端末の選択を引き継ぐ', async () => {
    setLinkCrossingStyle('gap');
    const reloaded = await import('../public/js/core/link-display-settings.js?settings-reload');
    assert.equal(reloaded.getLinkCrossingStyle(), 'bridge');
    assert.equal(reloaded.initializeLinkDisplaySettings(), 'gap');
    assert.equal(reloaded.getLinkCrossingStyle(), 'gap');
    assert.equal(events.length, 1);
    assert.equal(writes.length, 1);
});

test('保存済みの方式を読み込み、不正値はブリッジへ戻す', () => {
    for (const [stored, expected] of [
        ['gap', 'gap'], ['bridge', 'bridge'], ['unknown', 'bridge'],
        ['', 'bridge'], ['GAP', 'bridge'], ['"gap"', 'bridge']
    ]) {
        values.set(key, stored);
        assert.equal(initializeLinkDisplaySettings(), expected);
    }
    assert.deepEqual(writes, []);
    assert.deepEqual(events, []);
});

test('不正な設定値を指定してもブリッジだけを保存する', () => {
    for (const style of ['unknown', null, undefined, {}, 'GAP']) {
        assert.equal(setLinkCrossingStyle(style), 'bridge');
        assert.equal(values.get(key), 'bridge');
    }
    assert.ok(events.every(event => event.name === 'canvas:render-links'));
});

test('読込失敗時は直前の選択が切れ目でもブリッジへ戻す', () => {
    setLinkCrossingStyle('gap');
    window.localStorage.getItem = () => { throw new Error('読込拒否'); };
    assert.equal(initializeLinkDisplaySettings(), 'bridge');
    assert.equal(getLinkCrossingStyle(), 'bridge');
    assert.equal(events.length, 1);
});

test('保存失敗時はブリッジを反映してリンクだけを再描画する', () => {
    setLinkCrossingStyle('gap');
    events.length = 0;
    window.localStorage.setItem = () => { throw new Error('容量不足'); };
    assert.equal(setLinkCrossingStyle('gap'), 'bridge');
    assert.deepEqual(events, [{
        name: 'canvas:render-links', args: [], style: 'bridge', saved: 'gap'
    }]);
});

test('localStorageが利用できない端末でも読込・保存を継続する', () => {
    delete window.localStorage;
    assert.equal(initializeLinkDisplaySettings(), 'bridge');
    assert.equal(setLinkCrossingStyle('gap'), 'bridge');
    assert.equal(events.length, 1);
});

test('localStorageプロパティへのアクセス自体が拒否されてもブリッジを使う', () => {
    Object.defineProperty(window, 'localStorage', {
        get() { throw new Error('アクセス拒否'); }
    });
    assert.equal(initializeLinkDisplaySettings(), 'bridge');
    assert.equal(setLinkCrossingStyle('gap'), 'bridge');
    assert.equal(events[0].style, 'bridge');
});

test('保存失敗で戻した方式へラジオ選択も同期する', () => {
    const inputs = ['bridge', 'gap'].map(value => ({
        value, checked: value === 'gap',
        addEventListener(name, callback) { this[name] = callback; }
    }));
    const overlay = {
        addEventListener() {},
        querySelectorAll() { return inputs; }
    };
    const toast = { setAttribute() {}, classList: { add() {} } };
    globalThis.document = {
        getElementById(id) {
            if (id === 'link-display-settings-overlay') return overlay;
            if (id === 'toast') return toast;
            return null;
        },
        querySelectorAll() { return inputs; }
    };
    window.setTimeout = () => 1;
    window.clearTimeout = () => {};
    window.localStorage.setItem = () => { throw new Error('保存拒否'); };
    initializeLinkDisplayModal();
    inputs[1].change();
    assert.equal(inputs[0].checked, true);
    assert.equal(inputs[1].checked, false);
    assert.equal(getLinkCrossingStyle(), 'bridge');
    assert.equal(events[0].name, 'canvas:render-links');
});
