import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPacketEffect } from '../public/js/canvas/hidden-packets.js';
import { eventBus } from '../public/js/core/event-bus.js';
import { appState } from '../public/js/core/state.js';
import { registerModalOpen, registerModalClose } from '../public/js/core/modal-focus.js';
import { installWorkspaceDom, WorkspaceElement } from './helpers/workspace-dom.mjs';

function fixture(t, count = 1, reduced = false) {
    const keys = ['window', 'document', 'HTMLElement', 'Element', 'MutationObserver', 'fetch'];
    const originals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const dom = installWorkspaceDom();
    let now = 0;
    let nextId = 1;
    let requests = 0;
    const frames = new Map();
    const timers = new Map();
    const observers = new Set();
    const windowEvents = new WorkspaceElement();
    const mediaEvents = new WorkspaceElement();
    const media = {
        matches: reduced,
        addEventListener: mediaEvents.addEventListener.bind(mediaEvents),
        removeEventListener: mediaEvents.removeEventListener.bind(mediaEvents)
    };
    Object.assign(window, {
        performance: { now: () => now },
        requestAnimationFrame: callback => { const id = nextId++; frames.set(id, callback); return id; },
        cancelAnimationFrame: id => frames.delete(id),
        setTimeout: (callback, delay) => { const id = nextId++; timers.set(id, { callback, due: now + delay }); return id; },
        clearTimeout: id => timers.delete(id),
        addEventListener: windowEvents.addEventListener.bind(windowEvents),
        removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
        matchMedia: query => { assert.equal(query, '(prefers-reduced-motion: reduce)'); return media; }
    });
    globalThis.fetch = () => { requests++; throw new Error('The display effect must not make network requests'); };
    globalThis.MutationObserver = class {
        constructor(callback) { this.callback = callback; }
        observe(target, options) { this.target = target; this.options = options; observers.add(this); }
        disconnect() { observers.delete(this); }
    };
    const world = dom.add('div', 'world');
    world.style.transform = 'translate(20px, 30px) scale(1.5)';
    const layer = dom.add('svg', 'link-layer', world);
    let scale = 0.55;
    layer.getScreenCTM = () => ({ a: scale, b: 0, c: 0, d: scale });
    const paths = [];
    const geometryCalls = [];
    for (let index = 0; index < count; index++) {
        const path = dom.add('path', `route-${index}`, layer);
        path.className = 'topology-link-hit selected';
        path.setAttribute('d', 'M 10 20 Q 70 120 210 40');
        path.style.stroke = '#123456';
        path.getTotalLength = () => { geometryCalls.push(['length', index]); return 200; };
        path.getPointAtLength = distance => {
            geometryCalls.push(['point', index, distance]);
            return { x: 10 + distance, y: 20 + distance * distance / 1000 };
        };
        paths.push(path);
    }
    // A visible, interrupted route must never be used instead of the continuous hit path.
    const visible = dom.add('path', 'visible-route', layer);
    visible.className = 'topology-link';
    visible.getTotalLength = () => { throw new Error('Wrong geometry source'); };
    const overlay = dom.add('div', 'hidden-terminal-overlay');
    const advance = time => {
        now = time;
        for (const [id, timer] of [...timers]) {
            if (timer.due <= now) { timers.delete(id); timer.callback(); }
        }
        const pending = [...frames];
        frames.clear();
        pending.forEach(([, callback]) => callback(now));
    };
    registerModalOpen('packet-test-terminal', overlay);
    advance(0); // Complete only the existing modal focus frame before measuring effect resources.
    const effect = createPacketEffect({ overlay });
    const subscriptions = ['view:switch', 'canvas:render-complete', 'canvas:view-transformed'];
    const baseline = subscriptions.map(name => eventBus.listeners.get(name)?.size || 0);
    const assertClean = () => {
        assert.equal(layer.querySelector('.hidden-packet-effect'), null);
        assert.equal(frames.size, 0);
        assert.equal(timers.size, 0);
        assert.equal(observers.size, 0);
        assert.equal(mediaEvents.listeners.get('change')?.size || 0, 0);
        for (const name of ['beforeprint', 'pagehide']) assert.equal(windowEvents.listeners.get(name)?.size || 0, 0);
        subscriptions.forEach((name, index) => assert.equal(eventBus.listeners.get(name)?.size || 0, baseline[index]));
        assert.equal(requests, 0);
    };
    t.after(() => {
        effect.stop();
        registerModalClose('packet-test-other', { restoreFocus: false });
        registerModalClose('packet-test-terminal', { restoreFocus: false });
        for (const [key, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    });
    return {
        ...dom, effect, layer, world, paths, overlay, geometryCalls, frames, timers, observers, media,
        advance, assertClean,
        mutate: () => [...observers].forEach(observer => observer.callback([])),
        dispatch: type => windowEvents.dispatch(type),
        reduce: async () => { media.matches = true; await mediaEvents.dispatch('change', { matches: true }); },
        setScale: value => { scale = value; eventBus.emit('canvas:view-transformed'); },
    };
}

test('連続SVG geometryを最大32本・96光点まで参照し、world内で動かして5000msで解放する', t => {
    const f = fixture(t, 48);
    f.effect.start();
    const group = f.layer.querySelector('.hidden-packet-effect');
    assert.equal(group.parentElement, f.layer);
    assert.equal(group.children.length, 96);
    for (const element of [group, ...group.children]) {
        assert.equal(element.getAttribute('pointer-events'), 'none');
        assert.equal(element.getAttribute('aria-hidden'), 'true');
    }
    const first = group.children[0];
    const before = first.getAttribute('cx');
    f.advance(700);
    assert.notEqual(first.getAttribute('cx'), before, '光点が経路上を移動する');
    assert.equal(f.geometryCalls.some(([, index]) => index >= 32), false);
    f.world.style.transform = 'translate(100px, 200px) scale(2)';
    f.mutate();
    assert.equal(group.parentElement.parentElement, f.world);
    f.advance(4999);
    assert.equal(f.layer.querySelector('.hidden-packet-effect'), group);
    f.advance(5000);
    f.assertClean();
});

test('縮小表示でも光点の画面上の半径を5pxに保ち、ズーム後も経路上を移動する', t => {
    const f = fixture(t);
    f.effect.start();
    const dots = f.layer.querySelectorAll('.hidden-packet-dot');
    for (const scale of [0.55, 0.05, 1, 3]) {
        f.setScale(scale);
        for (const dot of dots) {
            assert.ok(Math.abs(Number(dot.getAttribute('r')) * scale - 5) < 0.000001,
                'worldの縮小で光点が数pxの点にならない');
        }
    }
    f.advance(350);
    const positions = dots.map(dot => dot.getAttribute('cx'));
    f.advance(700);
    dots.forEach((dot, index) => assert.notEqual(dot.getAttribute('cx'), positions[index]));
    f.effect.stop();
    f.assertClean();
});

test('1本の経路でも異なる色と位置の3光点が同時に移動し、経路を外れない', t => {
    const f = fixture(t);
    f.effect.start();
    const dots = f.layer.querySelectorAll('.hidden-packet-dot');
    assert.equal(dots.length, 3);
    assert.equal(new Set(dots.map(dot => dot.style.color)).size, 3);
    const positions = dots.map(dot => dot.getAttribute('cx'));
    assert.equal(new Set(positions).size, 3, '複数光点を重ねず、経路上へ分散する');
    f.advance(500);
    dots.forEach((dot, index) => {
        const x = Number(dot.getAttribute('cx'));
        const y = Number(dot.getAttribute('cy'));
        assert.notEqual(dot.getAttribute('cx'), positions[index]);
        assert.ok(x >= 10 && x <= 210);
        assert.ok(Math.abs(y - (20 + (x - 10) ** 2 / 1000)) < 0.000001);
    });
    f.effect.stop();
    f.assertClean();
});

test('明示停止は途中でも冪等で、停止後のタイマーやframeは残らない', t => {
    const f = fixture(t);
    f.effect.start();
    f.advance(1200);
    f.effect.stop();
    f.effect.stop();
    f.assertClean();
    f.advance(10000);
    f.assertClean();
});

test('連打は前の演出を破棄し、一組だけを再開始する', t => {
    const f = fixture(t);
    f.effect.start();
    const previous = f.layer.querySelector('.hidden-packet-effect');
    f.advance(1000);
    f.effect.start();
    assert.equal(previous.isConnected, false);
    assert.equal(f.layer.querySelectorAll('.hidden-packet-effect').length, 1);
    assert.equal(f.frames.size, 1);
    assert.equal(f.timers.size, 1);
    assert.equal(f.observers.size, 1);
    f.advance(5000);
    assert.ok(f.layer.querySelector('.hidden-packet-effect'));
    f.advance(6000);
    f.assertClean();
});

for (const event of ['view:switch', 'canvas:render-complete']) {
    test(`${event}で即座に演出を破棄する`, t => {
        const f = fixture(t);
        f.effect.start();
        eventBus.emit(event);
        f.assertClean();
    });
}

for (const event of ['beforeprint', 'pagehide']) {
    test(`${event}で印刷や離脱より前に表示専用要素を破棄する`, async t => {
        const f = fixture(t);
        f.effect.start();
        await f.dispatch(event);
        f.assertClean();
        assert.equal(f.layer.querySelectorAll('circle').length, 0);
    });
}

test('replaceChildrenによる再描画はイベントなしでも検出して解放する', t => {
    const f = fixture(t);
    f.effect.start();
    f.layer.replaceChildren();
    f.mutate();
    f.assertClean();
});

test('MutationObserverの通知より先のframeでも再描画を検出する', t => {
    const f = fixture(t);
    f.effect.start();
    f.layer.replaceChildren();
    f.advance(16);
    f.assertClean();
});

test('別モーダル表示を共通stackから検出し、残留演出を破棄する', t => {
    const f = fixture(t);
    f.effect.start();
    const other = f.add('div', 'another-modal');
    registerModalOpen('packet-test-other', other);
    f.mutate();
    f.advance(16); // The other modal owns its independent focus frame.
    f.assertClean();
});

test('モーダル閉鎖およびDOMからの除去で破棄する', t => {
    const f = fixture(t);
    f.effect.start();
    f.overlay.hidden = true;
    f.mutate();
    f.assertClean();
    f.overlay.hidden = false;
    f.effect.start();
    f.overlay.remove();
    f.mutate();
    f.assertClean();
});

test('接続なしでは結果だけ返し、動作中リソースを登録しない', t => {
    const f = fixture(t, 0);
    f.effect.start();
    f.assertClean();
});

test('reduced-motionでは結果だけ返し、geometryも参照しない', t => {
    const f = fixture(t, 1, true);
    f.effect.start();
    assert.equal(f.geometryCalls.length, 0);
    f.assertClean();
});

test('実行途中のmotion reduceへの変更は即座に停止する', async t => {
    const f = fixture(t);
    f.effect.start();
    f.advance(800);
    await f.reduce();
    f.assertClean();
    f.effect.start();
    f.assertClean();
});

test('元path/class/style、業務stateと保存状態に変更を加えない', async t => {
    const f = fixture(t, 3);
    const originalPaths = f.paths.map(path => ({ attributes: [...path.attributes], className: path.className, style: { ...path.style } }));
    const originalChildren = [...f.layer.children];
    const state = structuredClone(appState);
    f.effect.start();
    f.advance(700);
    f.advance(2500);
    await f.dispatch('beforeprint');
    f.assertClean();
    assert.deepEqual(f.layer.children, originalChildren);
    assert.deepEqual(f.paths.map(path => ({ attributes: [...path.attributes], className: path.className, style: { ...path.style } })), originalPaths);
    assert.deepEqual(appState, state);
});

test('ゼロ長や参照不可のgeometryを対象にせず終了する', t => {
    const f = fixture(t, 2);
    f.paths[0].getTotalLength = () => 0;
    f.paths[1].getTotalLength = () => { throw new Error('Detached SVG path'); };
    f.effect.start();
    f.assertClean();
});
