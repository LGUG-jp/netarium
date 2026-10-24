import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { appState } from '../public/js/core/state.js';
import { eventBus } from '../public/js/core/event-bus.js';
import {
    getConnectionHighlightEnabled,
    setConnectionHighlightEnabled,
    getLinkCrossingStyle,
    initializeLinkDisplaySettings,
    setLinkCrossingStyle
} from '../public/js/core/link-display-settings.js';
import {
    closeLinkDisplaySettings,
    initializeLinkDisplayModal,
    openLinkDisplaySettings
} from '../public/js/modals/link-display-modal.js';

const key = 'netarium.linkCrossingStyle';
const highlightKey = 'netarium.connectionHighlightEnabled';
const originalWindow = globalThis.window;
const originalDocument = globalThis.document;
const originalHTMLElement = globalThis.HTMLElement;
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
    if (originalHTMLElement === undefined) delete globalThis.HTMLElement;
    else globalThis.HTMLElement = originalHTMLElement;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
});

test('未使用の端末は山形ブリッジで起動し、読込時に保存や再描画をしない', () => {
    assert.equal(getLinkCrossingStyle(), 'bridge');
    assert.equal(getConnectionHighlightEnabled(), false);
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
    assert.equal(reloaded.getConnectionHighlightEnabled(), false);
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

test('接続関係の強調は保存された文字列trueだけを復元する', () => {
    for (const [stored, expected] of [
        ['true', true], ['false', false], ['TRUE', false], ['1', false],
        ['"true"', false], ['', false], [null, false], [true, false]
    ]) {
        values.set(highlightKey, stored);
        assert.equal(initializeLinkDisplaySettings(), 'bridge');
        assert.equal(getConnectionHighlightEnabled(), expected);
    }
    assert.deepEqual(writes, []);
    assert.deepEqual(events, []);
});

test('強調設定はbooleanのtrueだけを有効として独立したキーに保存する', () => {
    setLinkCrossingStyle('gap');
    events.length = 0;
    writes.length = 0;
    for (const enabled of [true, false, 'true', 1, null, undefined, {}, []]) {
        const expected = enabled === true;
        assert.equal(setConnectionHighlightEnabled(enabled), expected);
        assert.equal(getConnectionHighlightEnabled(), expected);
        assert.equal(values.get(highlightKey), String(expected));
        assert.equal(getLinkCrossingStyle(), 'gap');
        assert.equal(values.get(key), 'gap');
    }
    assert.deepEqual(writes, [
        [highlightKey, 'true'],
        ...Array.from({ length: 7 }, () => [highlightKey, 'false'])
    ]);
    assert.equal(events.length, 8);
    assert.ok(events.every(event => event.name === 'canvas:render' && event.args.length === 0));
});

test('強調設定を保存してから状態を反映し、キャンバス全体の再描画を通知する', () => {
    const observed = [];
    eventBus.emit = (name, ...args) => observed.push({
        name, args, enabled: getConnectionHighlightEnabled(), saved: values.get(highlightKey)
    });
    setConnectionHighlightEnabled(true);
    setConnectionHighlightEnabled(false);
    assert.deepEqual(observed, [
        { name: 'canvas:render', args: [], enabled: true, saved: 'true' },
        { name: 'canvas:render', args: [], enabled: false, saved: 'false' }
    ]);
});

test('強調設定もモジュール再読込後に復元され、初期化の戻り値は交差方式を保つ', async () => {
    setLinkCrossingStyle('gap');
    setConnectionHighlightEnabled(true);
    const reloaded = await import('../public/js/core/link-display-settings.js?highlight-reload');
    assert.equal(reloaded.getConnectionHighlightEnabled(), false);
    assert.equal(reloaded.initializeLinkDisplaySettings(), 'gap');
    assert.equal(reloaded.getConnectionHighlightEnabled(), true);
    assert.equal(events.length, 2);
    assert.equal(writes.length, 2);
});

test('一方の読込が失敗しても他方の保存値を独立して復元する', () => {
    values.set(key, 'gap');
    values.set(highlightKey, 'true');
    window.localStorage.getItem = name => {
        if (name === key) throw new Error('交差方式の読込拒否');
        return values.get(name);
    };
    assert.equal(initializeLinkDisplaySettings(), 'bridge');
    assert.equal(getConnectionHighlightEnabled(), true);
    window.localStorage.getItem = name => {
        if (name === highlightKey) throw new Error('強調設定の読込拒否');
        return values.get(name);
    };
    assert.equal(initializeLinkDisplaySettings(), 'gap');
    assert.equal(getConnectionHighlightEnabled(), false);
    assert.deepEqual(writes, []);
    assert.deepEqual(events, []);
});

test('強調設定の保存失敗ではオフに戻して全体再描画し、交差方式は保持する', () => {
    setLinkCrossingStyle('gap');
    setConnectionHighlightEnabled(true);
    events.length = 0;
    window.localStorage.setItem = (name, value) => {
        if (name === highlightKey) throw new Error('強調設定の保存拒否');
        values.set(name, value);
    };
    assert.equal(setConnectionHighlightEnabled(true), false);
    assert.equal(getConnectionHighlightEnabled(), false);
    assert.equal(values.get(highlightKey), 'true');
    assert.equal(getLinkCrossingStyle(), 'gap');
    assert.deepEqual(events.map(event => event.name), ['canvas:render']);
    assert.equal(setLinkCrossingStyle('bridge'), 'bridge');
    assert.equal(values.get(key), 'bridge');
});

test('交差方式の保存失敗でも強調設定は保存できる', () => {
    window.localStorage.setItem = (name, value) => {
        if (name === key) throw new Error('交差方式の保存拒否');
        values.set(name, value);
    };
    assert.equal(setLinkCrossingStyle('gap'), 'bridge');
    assert.equal(setConnectionHighlightEnabled(true), true);
    assert.equal(values.get(highlightKey), 'true');
});

test('ストレージが存在しない場合やアクセス拒否でも強調設定はオフになる', () => {
    for (const inaccessible of [false, true]) {
        setConnectionHighlightEnabled(true);
        if (inaccessible) {
            Object.defineProperty(window, 'localStorage', {
                configurable: true,
                get() { throw new Error('アクセス拒否'); }
            });
        } else {
            delete window.localStorage;
        }
        assert.equal(initializeLinkDisplaySettings(), 'bridge');
        assert.equal(getConnectionHighlightEnabled(), false);
        assert.equal(setConnectionHighlightEnabled(true), false);
        assert.equal(events.at(-1).name, 'canvas:render');
    }
});

function createDisplayForm() {
    const radios = ['bridge', 'gap'].map(value => ({
        value, checked: false,
        addEventListener(name, callback) { this[name] = callback; }
    }));
    const checkbox = {
        checked: false,
        addEventListener(name, callback) { this[name] = callback; }
    };
    const overlay = {
        hidden: true,
        addEventListener() {},
        querySelectorAll() { return radios; },
        querySelector() { return null; }
    };
    const toast = { setAttribute() {} };
    globalThis.HTMLElement = class {};
    globalThis.document = {
        getElementById(id) {
            if (id === 'link-display-settings-overlay') return overlay;
            if (id === 'connection-highlight-enabled') return checkbox;
            if (id === 'toast') return toast;
            return null;
        },
        querySelectorAll() { return radios; }
    };
    window.setTimeout = () => 1;
    window.clearTimeout = () => {};
    window.requestAnimationFrame = () => {};
    initializeLinkDisplayModal();
    return { radios, checkbox, overlay, toast };
}

test('表示設定を開くたびに保存済みの交差方式と強調設定をフォームへ同期する', () => {
    const { radios, checkbox, overlay } = createDisplayForm();
    setLinkCrossingStyle('gap');
    setConnectionHighlightEnabled(true);
    try {
        openLinkDisplaySettings();
        assert.equal(overlay.hidden, false);
        assert.deepEqual(radios.map(input => input.checked), [false, true]);
        assert.equal(checkbox.checked, true);
        closeLinkDisplaySettings();
        setConnectionHighlightEnabled(false);
        checkbox.checked = true;
        openLinkDisplaySettings();
        assert.equal(checkbox.checked, false);
    } finally {
        closeLinkDisplaySettings();
    }
});

test('チェック変更は即時保存し、交差方式と独立してフォームと強調状態を同期する', () => {
    const { checkbox, radios } = createDisplayForm();
    setLinkCrossingStyle('gap');
    checkbox.checked = true;
    checkbox.change();
    assert.equal(getConnectionHighlightEnabled(), true);
    assert.equal(values.get(highlightKey), 'true');
    assert.equal(checkbox.checked, true);
    assert.deepEqual(radios.map(input => input.checked), [false, true]);
    checkbox.checked = false;
    checkbox.change();
    assert.equal(values.get(highlightKey), 'false');
    assert.equal(checkbox.checked, false);
    assert.equal(events.at(-1).name, 'canvas:render');
});

test('強調設定の保存失敗はチェックをオフへ同期し、構成保存エラーではなくブラウザー表示の警告を出す', () => {
    const { checkbox, toast } = createDisplayForm();
    setConnectionHighlightEnabled(true);
    window.localStorage.setItem = () => { throw new Error('保存拒否'); };
    checkbox.checked = true;
    checkbox.change();
    assert.equal(getConnectionHighlightEnabled(), false);
    assert.equal(checkbox.checked, false);
    assert.equal(events.at(-1).name, 'canvas:render');
    assert.equal(toast.className, 'toast toast-warning');
});
