import assert from 'node:assert/strict';
import { test } from 'node:test';

// 本物のmodule/eventBusとpointer/keyイベントを使用。DOM境界だけを置換する。
test('図面直接編集: geometry、pointer、keyboard、取消、権限', async t => {
    const original = new Map(['window', 'document'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    class Node {
        constructor(tag = 'div') {
            this.tagName = tag.toUpperCase(); this.children = []; this.listeners = new Map();
            this.style = {}; this.dataset = {}; this.attributes = new Map(); this.captures = new Set();
            this.connected = true; this.ownerDocument = globalThis.document;
        }
        get isConnected() { return this.connected && (!this.parentElement || this.parentElement.isConnected); }
        addEventListener(type, fn) {
            if (!this.listeners.has(type)) this.listeners.set(type, new Set());
            this.listeners.get(type).add(fn);
        }
        removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
        dispatch(type, fields = {}) {
            const event = { target: this, pointerId: 1, button: 0, isPrimary: true,
                clientX: 0, clientY: 0, preventDefault() { this.prevented = true; },
                stopPropagation() {}, stopImmediatePropagation() {}, ...fields };
            for (const fn of [...(this.listeners.get(type) || [])]) fn(event);
            return event;
        }
        appendChild(child) { child.parentElement = this; child.connected = true; this.children.push(child); return child; }
        remove() {
            if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
            this.parentElement = null; this.connected = false;
        }
        setAttribute(key, value) { this.attributes.set(key, String(value)); }
        getAttribute(key) { return this.attributes.get(key) ?? null; }
        focus() { document.activeElement = this; }
        setPointerCapture(id) { this.captures.add(id); }
        hasPointerCapture(id) { return this.captures.has(id); }
        releasePointerCapture(id) { this.captures.delete(id); this.dispatch('lostpointercapture', { pointerId: id }); }
        getBoundingClientRect() { return { left: 30, top: 40, width: 1200, height: 800 }; }
    }
    const doc = new Node(), win = new Node();
    globalThis.window = win;
    window.APP_CONFIG = { user: { isAdmin: true } };
    window.setTimeout = setTimeout;
    window.clearTimeout = clearTimeout;
    globalThis.document = doc;
    doc.defaultView = win; doc.body = new Node(); doc.activeElement = doc.body;
    doc.createElement = tag => new Node(tag);
    doc.getElementById = () => null;
    doc.querySelector = () => null;
    doc.querySelectorAll = () => [];
    const { appState } = await import('../public/js/core/state.js');
    const { eventBus } = await import('../public/js/core/event-bus.js');
    const editor = await import('../public/js/canvas/floor-plan-editor.js');
    const plan = () => ({ view_id: 7, image_width: 400, image_height: 200,
        x: 20, y: 30, scale: 0.5, is_visible: true });
    const nearly = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} != ${expected}`);
    const diagonal = (p, corner) => ({ x: p.x + (corner.endsWith('w') ? p.image_width * p.scale : 0),
        y: p.y + (corner.startsWith('n') ? p.image_height * p.scale : 0) });
    let image, current, frame, commits, previews;
    function setup(zoom = 1, p = plan()) {
        editor.cancelFloorPlanGesture();
        appState.currentViewId = 7; appState.floorPlanAdjustMode = true;
        appState.authExpired = false; appState.isPinging = false; appState.isFloorPlanUpdating = false;
        window.APP_CONFIG.user.isAdmin = true;
        appState.resourceConflicts = { devices: new Map(), views: new Map() };
        appState.viewState = { scale: zoom, panX: 80, panY: -20 };
        appState.canvas = new Node(); appState.floorPlanLayer = new Node();
        current = p; image = new Node('img'); commits = []; previews = [];
        appState.floorPlanLayer.appendChild(image);
        editor.attachFloorPlanEditor(image, current, {
            onPreview: value => previews.push({ ...value }), onCommit: value => commits.push({ ...value })
        });
        frame = appState.floorPlanLayer.children.find(node => node.className === 'floor-plan-editor-frame');
    }
    const screen = (x, y) => ({ clientX: 30 + 80 + x * appState.viewState.scale,
        clientY: 40 - 20 + y * appState.viewState.scale });
    try {
        await t.test('四隅の射影・対角固定・縦横比・倍率制約・大寸法', () => {
            for (const corner of ['nw', 'ne', 'se', 'sw']) {
                const p = plan(), anchor = diagonal(p, corner);
                for (const scale of [0.05, 0.2, 1, 2]) {
                    const point = { x: anchor.x + (corner.endsWith('w') ? -1 : 1) * p.image_width * scale,
                        y: anchor.y + (corner.startsWith('n') ? -1 : 1) * p.image_height * scale };
                    const result = editor.resizeFloorPlanFromCorner(p, corner, point);
                    nearly(result.scale, scale);
                    const after = diagonal({ ...p, ...result }, corner);
                    nearly(after.x, anchor.x); nearly(after.y, anchor.y);
                    nearly((p.image_width * result.scale) / (p.image_height * result.scale), 2);
                }
                assert.equal(editor.scaleFloorPlanFromCorner(p, corner, -2).scale, 0.05);
                assert.equal(editor.scaleFloorPlanFromCorner(p, corner, 9).scale, 2);
                const huge = { ...p, image_width: 900000, image_height: 450000 };
                const resized = editor.scaleFloorPlanFromCorner(huge, corner, 2);
                assert.ok(resized.x >= -100000 && resized.x <= 100000);
                assert.ok(resized.y >= -100000 && resized.y <= 100000);
                const fixed = diagonal({ ...huge, ...resized }, corner), before = diagonal(huge, corner);
                nearly(fixed.x, before.x); nearly(fixed.y, before.y);
            }
            assert.deepEqual(editor.moveFloorPlan(plan(), 999999, -999999), { x: 100000, y: -100000, scale: 0.5 });
        });
        await t.test('各Canvas倍率で本体移動・四隅pointer一操作一commit', () => {
            for (const zoom of [0.1, 0.5, 1, 2, 4]) {
                setup(zoom);
                image.dispatch('pointerdown', { ...screen(20, 30), pointerType: 'touch' });
                assert.ok(image.hasPointerCapture(1));
                image.dispatch('pointermove', screen(35, 22));
                image.dispatch('pointerup', screen(35, 22));
                nearly(current.x, 35); nearly(current.y, 22); assert.equal(commits.length, 1);
                image.dispatch('pointerup', screen(35, 22)); assert.equal(commits.length, 1);
                assert.equal(frame.style.transform, `scale(${1 / zoom})`);
                for (const corner of ['nw', 'ne', 'se', 'sw']) {
                    setup(zoom);
                    const handle = frame.children.find(node => node.dataset.floorPlanCorner === corner);
                    const before = diagonal(current, corner);
                    const start = { x: current.x + (corner.endsWith('w') ? 0 : 400 * current.scale),
                        y: current.y + (corner.startsWith('n') ? 0 : 200 * current.scale) };
                    // ハンドル内の任意の押下位置でも、動き始めに跳躍しない。
                    handle.dispatch('pointerdown', { ...screen(start.x + 3, start.y + 5), pointerType: 'pen' });
                    const end = screen(before.x + (corner.endsWith('w') ? -1 : 1) * 400 + 3,
                        before.y + (corner.startsWith('n') ? -1 : 1) * 200 + 5);
                    handle.dispatch('pointermove', end); handle.dispatch('pointerup', end);
                    nearly(current.scale, 1); assert.equal(commits.length, 1);
                    const after = diagonal(current, corner); nearly(after.x, before.x); nearly(after.y, before.y);
                }
            }
        });
        await t.test('取消・capture喪失・render・no-op・別pointer', () => {
            for (const cause of ['pointercancel', 'lostpointercapture', 'escape', 'render']) {
                setup(); image.dispatch('pointerdown', screen(0, 0));
                image.dispatch('pointermove', { ...screen(30, 40), pointerId: 2 });
                assert.equal(current.x, 20);
                image.dispatch('pointermove', screen(30, 40));
                if (cause === 'escape') doc.dispatch('keydown', { key: 'Escape' });
                else if (cause === 'render') { image.connected = false; eventBus.emit('canvas:render-complete'); }
                else image.dispatch(cause);
                assert.equal(current.x, 20); assert.equal(current.y, 30); assert.equal(commits.length, 0);
                assert.equal(editor.cancelFloorPlanGesture(), false);
            }
            setup(); image.dispatch('pointerdown', screen(0, 0)); image.dispatch('pointerup', screen(0, 0));
            assert.equal(commits.length, 0);
            image.dispatch('pointerdown', screen(0, 0)); image.dispatch('pointermove', screen(2, 3));
            const replacement = new Node('img'); appState.floorPlanLayer.appendChild(replacement);
            editor.attachFloorPlanEditor(replacement, current, { onCommit: value => commits.push(value) });
            assert.equal(current.x, 20); assert.equal(commits.length, 0);
        });
        await t.test('keyboard repeat集約・Shift・四隅・blur・Escape', () => {
            setup();
            image.dispatch('keydown', { key: 'ArrowRight' });
            image.dispatch('keydown', { key: 'ArrowRight', repeat: true });
            image.dispatch('keydown', { key: 'ArrowDown', shiftKey: true });
            assert.equal(current.x, 22); assert.equal(current.y, 40); assert.equal(commits.length, 0);
            doc.dispatch('keyup', { key: 'ArrowRight' }); assert.equal(commits.length, 0);
            doc.dispatch('keyup', { key: 'ArrowDown' }); assert.equal(commits.length, 1);
            image.dispatch('keydown', { key: 'ArrowLeft' }); image.dispatch('blur'); assert.equal(commits.length, 2);
            image.dispatch('keydown', { key: 'ArrowLeft' }); doc.dispatch('keydown', { key: 'Escape' });
            assert.equal(current.x, 21); assert.equal(commits.length, 2);
            for (const corner of ['nw', 'ne', 'se', 'sw']) {
                setup(); const handle = frame.children.find(node => node.dataset.floorPlanCorner === corner);
                const before = diagonal(current, corner);
                handle.dispatch('keydown', { key: 'ArrowUp' });
                handle.dispatch('keydown', { key: 'ArrowRight', shiftKey: true });
                nearly(current.scale, 0.61);
                handle.dispatch('keydown', { key: 'ArrowDown' });
                handle.dispatch('keydown', { key: 'ArrowLeft', shiftKey: true });
                nearly(current.scale, 0.5);
                const after = diagonal(current, corner); nearly(after.x, before.x); nearly(after.y, before.y);
                win.dispatch('blur');
                // 浮動小数点の往復値を避け、確実に変化する操作でblur確定を検証。
                handle.dispatch('keydown', { key: 'ArrowUp' }); handle.dispatch('blur');
                assert.ok(commits.length >= 1);
                assert.ok(handle.getAttribute('aria-label').includes('拡大・縮小'));
            }
        });
        await t.test('権限・認証・Ping・競合・mode/view変更で開始拒否と途中復元', () => {
            const guards = [() => { window.APP_CONFIG.user.isAdmin = false; },
                () => { appState.authExpired = true; }, () => { appState.isPinging = true; },
                () => { appState.resourceConflicts.views.set(7, {}); },
                () => { appState.floorPlanAdjustMode = false; }, () => { appState.currentViewId = 8; },
                () => { appState.isFloorPlanUpdating = true; }];
            for (const deny of guards) {
                setup(); deny(); image.dispatch('pointerdown', screen(0, 0));
                image.dispatch('pointermove', screen(5, 5)); image.dispatch('pointerup', screen(5, 5));
                assert.equal(current.x, 20); assert.equal(commits.length, 0);
                assert.equal(editor.handleFloorPlanEditorKeydown({ target: image, key: 'ArrowUp' }), false);
                setup(); image.dispatch('pointerdown', screen(0, 0)); image.dispatch('pointermove', screen(5, 5));
                deny(); image.dispatch('pointerup', screen(5, 5));
                assert.equal(current.x, 20); assert.equal(commits.length, 0);
            }
        });
        await t.test('zoom/pan変更は保存せず枠だけ再配置・主画像focus復元', async () => {
            setup(); image.focus();
            appState.viewState.scale = 2; appState.viewState.panX = 100;
            eventBus.emit('canvas:view-transformed');
            assert.equal(frame.style.width, '400px'); assert.equal(frame.style.transform, 'scale(0.5)');
            assert.equal(current.scale, 0.5); assert.equal(commits.length, 0); assert.equal(previews.length, 0);
            const old = image, replacement = new Node('img');
            old.connected = false; appState.floorPlanLayer.appendChild(replacement);
            editor.attachFloorPlanEditor(replacement, current);
            doc.activeElement = doc.body;
            await Promise.resolve();
            assert.equal(doc.activeElement, replacement);
            assert.equal(replacement.tabIndex, 0);
        });
        await t.test('非表示時も調整枠を一時表示し、四隅ハンドルは画像の角に配置される', () => {
            setup(0.1, { ...plan(), x: -5000, y: -3000, image_width: 6616, image_height: 4677, is_visible: false });
            assert.equal(frame.hidden, false);
            for (const handle of frame.children) {
                const corner = handle.dataset.floorPlanCorner;
                assert.equal(handle.style.left, corner.endsWith('w') ? '0%' : '100%');
                assert.equal(handle.style.top, corner.startsWith('n') ? '0%' : '100%');
            }
            const handle = frame.children[0], before = { ...current };
            handle.dispatch('pointerdown', screen(0, 0));
            handle.dispatch('pointermove', screen(0, 0));
            handle.dispatch('pointerup', screen(0, 0));
            assert.deepEqual(current, before);
            assert.equal(commits.length, 0);
        });
    } finally {
        editor.cancelFloorPlanGesture();
        for (const [key, descriptor] of original) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    }
});
