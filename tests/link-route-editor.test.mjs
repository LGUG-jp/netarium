import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';

test('右パネルの経路操作は明細の適用・削除と別グループで、その直前にある', async () => {
    const template = await readFile(new URL('../templates/components/link_panel.php', import.meta.url), 'utf8');
    assert.match(template, /<div id="lp-route-section"[^>]*>[\s\S]*?id="lp-route-edit-btn"[\s\S]*?id="lp-route-auto-btn"[\s\S]*?id="lp-route-help-btn"[\s\S]*?<\/div>\s*<div id="lp-detail-actions" class="panel-actions">/);
    assert.doesNotMatch(template, /lp-route-heading|未適用の入力だけを破棄/);

    const toolbar = await readFile(new URL('../templates/components/canvas_context_toolbar.php', import.meta.url), 'utf8');
    const help = toolbar.match(/<p id="link-route-help">([^<]+)<\/p>\s*<ul>([\s\S]*?)<\/ul>/);
    assert.equal(help?.[1], '接続線の区間を選んでドラッグすると、線の位置を動かせます（水平区間は上下、垂直区間は左右）。');
    assert.deepEqual([...help[2].matchAll(/<li>([^<]+)<\/li>/g)].map(([, line]) => line), [
        '矢印キーでも移動できます（Shift＋矢印キーで大きく移動）。',
        '選んだ区間に「折れを追加」「折れを削除」で曲がりを増減できます（最大8点）。',
        '変更はその場で自動保存されます。「完了」または Esc で調整を終了します。',
        '手動の調整をすべて元に戻す場合は、右パネルの「自動経路」を押します。'
    ]);
});

// DOM操作から本物の保存キューを通し、fetch境界の送信内容を観測する。
test('リンク経路編集の操作と保存境界', async t => {
    const keys = ['window', 'document', 'Element', 'HTMLElement', 'fetch', 'confirm'];
    const original = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    class Node {
        constructor(id = '') {
            this.id = id; this.dataset = {}; this.attributes = new Map(); this.children = [];
            this.listeners = new Map(); this.hidden = false; this.disabled = false; this.style = {};
            this.captures = new Set(); this.classes = new Set();
            this.tagName = id.endsWith('-btn') ? 'BUTTON' : 'DIV';
            this.classList = {
                add: (...names) => names.forEach(name => this.classes.add(name)),
                remove: (...names) => names.forEach(name => this.classes.delete(name)),
                contains: name => this.classes.has(name),
                toggle: (name, force) => { if (force) this.classes.add(name); else this.classes.delete(name); }
            };
        }
        addEventListener(type, fn) {
            if (!this.listeners.has(type)) this.listeners.set(type, new Set());
            this.listeners.get(type).add(fn);
        }
        removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
        dispatch(type, fields = {}) {
            const event = { target: this, button: 0, pointerId: 1, clientX: 0, clientY: 0,
                preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {}, ...fields };
            return Promise.all([...(this.listeners.get(type) || [])].map(fn => fn(event)));
        }
        setAttribute(name, value) { this.attributes.set(name, String(value)); }
        getAttribute(name) { return this.attributes.get(name) ?? null; }
        removeAttribute(name) { this.attributes.delete(name); }
        appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
        append(...children) { children.forEach(child => this.appendChild(child)); }
        replaceChildren(...children) { this.children = []; this.append(...children); }
        querySelectorAll(selector) {
            if (selector === '[data-canvas-context]') return this.children.filter(child => child.dataset.canvasContext);
            const descendants = this.children.flatMap(child => [child, ...child.querySelectorAll('*')]);
            if (selector.includes('button:not([disabled])')) {
                return descendants.filter(child =>
                    (child.tagName === 'BUTTON' && !child.disabled) ||
                    (child.getAttribute('tabindex') != null && child.getAttribute('tabindex') !== '-1'));
            }
            return descendants;
        }
        querySelector(selector) {
            if (selector === 'button:not(:disabled)') return this.querySelectorAll('*').find(child => child.tagName === 'BUTTON' && !child.disabled) ?? null;
            if (selector === '[role="dialog"]') return this.querySelectorAll('*').find(child => child.getAttribute('role') === 'dialog') ?? null;
            const index = selector.match(/data-route-segment="(\d+)"/)?.[1];
            return this.querySelectorAll('*').find(child => index != null && child.dataset.routeSegment === index) ?? null;
        }
        closest(selector) { return selector.split(',').some(part => part.trim() === `#${this.id}`) ? this : null; }
        contains(node) { return this === node || this.children.some(child => child.contains(node)); }
        focus() {
            document.activeElement = this;
            documentEvents.dispatch('focusin', { target: this });
            this.dispatch('focus');
        }
        setPointerCapture(id) { this.captures.add(id); }
        hasPointerCapture(id) { return this.captures.has(id); }
        releasePointerCapture(id) { this.captures.delete(id); }
        getBoundingClientRect() { return { left: 0, top: 0 }; }
    }
    const elements = new Map();
    const element = id => elements.get(id) ?? null;
    const documentEvents = new Node();
    // テストの簡易DOMでもpointerupには最後のmove座標を引き継ぐ。
    // 省略された座標を(0, 0)とみなすと、本来のドラッグ終点が変わってしまう。
    let lastPointer = { clientX: 0, clientY: 0 };
    const dispatchDocumentEvent = documentEvents.dispatch.bind(documentEvents);
    documentEvents.dispatch = (type, fields = {}) => {
        if (type === 'pointermove' && (fields.pointerId == null || fields.pointerId === 1)) {
            lastPointer = {
                clientX: fields.clientX ?? lastPointer.clientX,
                clientY: fields.clientY ?? lastPointer.clientY
            };
        }
        if ((type === 'pointerup' || type === 'pointercancel') &&
            fields.clientX === undefined && fields.clientY === undefined) {
            fields = { ...lastPointer, ...fields };
        }
        return dispatchDocumentEvent(type, fields);
    };
    globalThis.Element = globalThis.HTMLElement = Node;
    globalThis.document = {
        body: new Node(), activeElement: null,
        getElementById: element, querySelector: () => null, querySelectorAll: () => [],
        createElement: () => new Node(), createElementNS: () => new Node(),
        addEventListener: documentEvents.addEventListener.bind(documentEvents),
        removeEventListener: documentEvents.removeEventListener.bind(documentEvents)
    };
    globalThis.window = {
        APP_CONFIG: { user: { isAdmin: true }, csrfToken: 'test-token' }, clearTimeout,
        setTimeout(fn, delay) { const timer = setTimeout(fn, delay); timer.unref(); return timer; },
        requestAnimationFrame: fn => fn(),
        getComputedStyle: () => ({ display: 'block', visibility: 'visible' })
    };
    let answer = true;
    let confirmations = 0;
    globalThis.confirm = window.confirm = () => { confirmations++; return answer; };
    const { appState, getCurrentLinkGroups, getCurrentLinks } = await import('../public/js/core/state.js');
    const resource = await import('../public/js/core/resource-save.js');
    const queue = await import('../public/js/core/save-queue.js');
    const { eventBus } = await import('../public/js/core/event-bus.js');
    const editor = await import('../public/js/canvas/link-route-editor.js');
    const panels = await import('../public/js/ui/property-panel.js');
    const renderer = await import('../public/js/canvas/renderer.js');
    const displaySettings = await import('../public/js/core/link-display-settings.js');
    const { resolveTopologyLinkRoutes } = await import('../public/js/canvas/link-route-resolver.js');
    const visibleLinks = getCurrentLinks;
    const resolvedRoutes = () => resolveTopologyLinkRoutes(getCurrentLinkGroups(), appState.placements);
    const currentRoute = () => resolvedRoutes().get(getCurrentLinkGroups()[0].display_key);
    const route = (manual_route = [], fields = {}) => ({ view_id: 1, device_a_id: 10, device_b_id: 20, manual_route, ...fields });
    const points = () => appState.viewLinkRoutes[0].manual_route;
    const { onKeyDown } = await import('../public/js/canvas/selection.js');
    const { getTopModalContainer, initModalFocusTrap } = await import('../public/js/core/modal-focus.js');
    initModalFocusTrap();
    const { handleCanvasContextToolbarKeydown, showCanvasContextToolbar, finishCanvasContextToolbar } =
        await import('../public/js/ui/canvas-context-toolbar.js');
    let requests = [], hold = false, release = null, remap = false, fail = false;
    let serverData = null, loadRequests = 0;
    globalThis.fetch = async (_url, options) => {
        if (_url.includes('action=load')) {
            loadRequests++;
            return new Response(JSON.stringify({ ok: true, ...serverData }));
        }
        const payload = JSON.parse(options.body);
        requests.push(payload);
        if (hold) { hold = false; await new Promise(resolve => { release = resolve; }); }
        if (fail && payload.views.some(row => Number(row.id) === 1)) return new Response(JSON.stringify({ ok: false, error: '競合', details: {
            conflicts: [{ kind: 'views', id: 1, name: '試験' }]
        } }), { status: 409 });
        const maps = { devices: {}, views: {}, placements: {} };
        if (remap) {
            maps.views[1] = 101;
            maps.placements = { 11: 111, 21: 121 };
        }
        remap = false;
        const id = (kind, value) => Number(maps[kind]?.[value] ?? value);
        return new Response(JSON.stringify({ ok: true, revision: 2, saved_at: '2026-10-05T00:00:00Z', id_maps: maps,
            devices: [], views: payload.views.map(row => ({ ...row.view, id: id('views', row.id), resource_revision: (row.expected_revision || 0) + 1 })),
            placements: payload.views.flatMap(row => row.placements.map(p => ({
                ...p, id: id('placements', p.id), view_id: id('views', p.view_id)
            }))),
            view_link_routes: payload.views.flatMap(row => row.view_link_routes.map(saved => ({
                ...saved, view_id: id('views', saved.view_id)
            }))),
            canvas_notes: [],
            affected_view_ids: payload.views.map(row => id('views', row.id)), deleted_device_ids: [], deleted_view_ids: []
        }));
    };
    let renderAllLinks = false;
    const render = () => {
        if (renderAllLinks) { renderer.renderLinks(); return; }
        editor.syncLinkRouteEditor();
        const routes = resolvedRoutes();
        const preview = editor.getLinkRoutePreview();
        if (preview) routes.set(preview.key, preview.points);
        appState.currentSvg.replaceChildren();
        editor.renderLinkRouteEditor(appState.currentSvg, routes);
    };
    const off = eventBus.on('canvas:render-links', render);
    t.after(async () => {
        release?.();
        await queue.flushSaveQueue({ silent: true });
        editor.closeLinkRouteHelp();
        editor.finishLinkRouteEdit(); off(); queue.clearPendingSave();
        for (const [key, descriptor] of original) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
        }
    });
    const settle = async () => { await queue.flushSaveQueue({ silent: true }); await setImmediate(); };
    const reset = () => {
        editor.closeLinkRouteHelp();
        editor.finishLinkRouteEdit(); queue.clearPendingSave(); elements.clear(); requests = [];
        hold = false; release = null; remap = false; fail = false; answer = true; confirmations = 0;
        serverData = null; loadRequests = 0;
        renderAllLinks = false;
        lastPointer = { clientX: 0, clientY: 0 };
        window.APP_CONFIG.user.isAdmin = true;
        appState.views = [{ id: 1, resource_revision: 1, name: '試験', view_type: 'topology', sort_order: 10 }];
        appState.devices = [{ id: 10, resource_revision: 1, name: 'SW1', type: 'switch', ip: '' },
            { id: 20, resource_revision: 1, name: 'SW2', type: 'switch', ip: '' }];
        appState.placements = [{ id: 11, device_id: 10, view_id: 1, x: 100, y: 100 },
            { id: 21, device_id: 20, view_id: 1, x: 500, y: 100 }];
        appState.linkSystems = [];
        appState.links = [{ id: 1, from_id: 10, to_id: 20, label: '元の属性', resource_revision: 1 }];
        appState.devicePorts = []; appState.viewLinkRoutes = [];
        appState.legacyLinkVlans = [];
        appState.currentViewId = 1; appState.editingLinkId = 1; appState.authExpired = false;
        appState.editingLinkGroupKey = null;
        appState.isPinging = false; appState.isSaving = false; appState.floorPlanAdjustMode = false;
        appState.resourceConflicts = { views: new Map(), devices: new Map(), links: new Map(), device_ports: new Map() };
        appState.appStatus = { dirty: false, state: 'saved' };
        Object.assign(appState.viewState, { scale: 1, panX: 0, panY: 0 });
        appState.currentSvg = new Node('svg');
        appState.canvas = new Node('canvas');
        for (const id of ['lp-route-edit-btn', 'lp-route-auto-btn', 'link-route-add-btn', 'link-route-remove-btn',
            'link-route-finish-btn', 'link-route-help', 'toast', 'link-panel', 'lp-reload-conflict-btn',
            'lp-label', 'lp-from-port', 'lp-to-port', 'lp-memo', 'lp-from-device', 'lp-to-device',
            'lp-route-section', 'lp-detail-actions']) {
            elements.set(id, new Node(id));
        }
        const toolbar = new Node('canvas-context-toolbar');
        for (const context of ['link-route', 'floor-plan']) {
            const panel = new Node(); panel.dataset.canvasContext = context; panel.setAttribute('aria-label', context);
            panel.appendChild(element('link-route-finish-btn')); toolbar.appendChild(panel);
        }
        toolbar.hidden = true; elements.set(toolbar.id, toolbar);
        resource.resetResourceBaseline(appState); editor.initLinkRouteEditor();
        eventBus.emit('resources:reloaded');
    };
    const segment = (index = 0) => appState.currentSvg.querySelector(`[data-route-segment="${index}"]`);
    const start = () => element('lp-route-edit-btn').dispatch('click');
    const beginDrag = () => {
        lastPointer = { clientX: 0, clientY: 0 };
        return segment().dispatch('pointerdown');
    };
    const move = y => documentEvents.dispatch('pointermove', { clientY: y });
    const end = (type, position = {}) => documentEvents.dispatch(type ?? 'pointerup', position);

    await t.test('ミニヘルプのESC・Tabは編集を終了せず、閉じると起動元へ戻る', async () => {
        reset();
        for (const id of ['lp-route-help-btn', 'link-route-help-close-btn']) {
            elements.set(id, new Node(id));
        }
        const overlay = new Node('link-route-help-overlay');
        const dialog = new Node('link-route-help-dialog');
        dialog.setAttribute('role', 'dialog'); dialog.setAttribute('tabindex', '-1');
        dialog.append(element('link-route-help-close-btn'));
        overlay.hidden = true; overlay.append(dialog); elements.set(overlay.id, overlay);
        document.body.replaceChildren(element('lp-route-help-btn'), element('canvas-context-toolbar'), overlay);
        editor.initLinkRouteEditor();

        const originalRoute = structuredClone(appState.viewLinkRoutes);
        element('lp-route-help-btn').focus(); element('lp-route-help-btn').dispatch('click');
        assert.deepEqual(appState.viewLinkRoutes, originalRoute); assert.equal(requests.length, 0);
        assert.equal(getTopModalContainer(), overlay);
        await onKeyDown({ key: 'Escape', preventDefault() {}, stopImmediatePropagation() {} });
        assert.equal(overlay.hidden, true); assert.equal(document.activeElement, element('lp-route-help-btn'));

        start(); await settle();
        const savedRoute = structuredClone(appState.viewLinkRoutes), saves = requests.length;
        beginDrag(); move(20);
        assert.ok(editor.getLinkRoutePreview());
        element('lp-label').value = '未適用属性';
        element('lp-route-help-btn').focus(); element('lp-route-help-btn').dispatch('click');
        assert.equal(document.activeElement, element('link-route-help-close-btn'));
        assert.equal(editor.getLinkRoutePreview(), null);
        end(); // ヘルプ表示前のpointerupが届いても確定しない。
        element('link-route-help-close-btn').focus();
        let trapped = false;
        documentEvents.dispatch('keydown', { key: 'Tab', preventDefault() { trapped = true; } });
        assert.equal(trapped, true); assert.equal(document.activeElement, element('link-route-help-close-btn'));
        await onKeyDown({ key: 'Escape', preventDefault() {}, stopImmediatePropagation() {} });
        assert.equal(getTopModalContainer(), null); assert.equal(document.activeElement, element('lp-route-help-btn'));
        assert.equal(element('canvas-context-toolbar').hidden, false);
        assert.deepEqual(appState.viewLinkRoutes, savedRoute); assert.equal(requests.length, saves);
        assert.equal(element('lp-label').value, '未適用属性');

        segment().dispatch('pointerdown'); move(30); end(); await settle();
        assert.equal(points().length, 2);
        element('lp-route-help-btn').focus(); element('lp-route-help-btn').dispatch('click');
        element('link-route-help-close-btn').dispatch('click');
        assert.equal(overlay.hidden, true); assert.equal(document.activeElement, element('lp-route-help-btn'));
        await onKeyDown({ key: 'Escape', preventDefault() {}, stopImmediatePropagation() {} });
        assert.equal(element('canvas-context-toolbar').hidden, true);
    });

    await t.test('開始→軸ドラッグ→折れ追加/削除→auto確認→完了', async () => {
        reset(); start(); await settle();
        assert.deepEqual(appState.viewLinkRoutes, [route()]);
        assert.equal(requests.length, 1); assert.equal(appState.currentSvg.getAttribute('aria-hidden'), 'false');
        assert.equal(element('link-route-add-btn').disabled, true);
        segment().dispatch('keydown', { key: 'Enter' });
        assert.equal(element('link-route-add-btn').disabled, false);
        const before = structuredClone(appState.viewLinkRoutes);
        beginDrag(); move(30);
        assert.deepEqual(appState.viewLinkRoutes, before); assert.equal(requests.length, 1);
        assert.ok(editor.getLinkRoutePreview()); assert.equal(appState.currentSvg.hasPointerCapture(1), true);
        end(); await settle();
        assert.equal(editor.getLinkRoutePreview(), null); assert.equal(requests.length, 2);
        assert.equal(points().length, 2);
        element('lp-label').value = '未適用属性';
        segment(1).dispatch('keydown', { key: ' ' });
        element('link-route-add-btn').dispatch('click'); await settle();
        assert.equal(points().length, 4);
        element('link-route-remove-btn').dispatch('click'); await settle();
        assert.ok(points().length < 4);
        assert.equal(appState.links[0].label, '元の属性'); assert.equal(element('lp-label').value, '未適用属性');
        answer = false; element('lp-route-auto-btn').dispatch('click');
        assert.equal(appState.viewLinkRoutes.length, 1); assert.ok(segment());
        answer = true; element('lp-route-auto-btn').dispatch('click'); await settle();
        assert.equal(confirmations, 2); assert.deepEqual(appState.viewLinkRoutes, []);
        assert.equal(segment(), null);
        start(); await settle(); element('link-route-finish-btn').dispatch('click');
        assert.equal(segment(), null); assert.equal(document.activeElement, element('lp-route-edit-btn'));
    });
    await t.test('自動経路の操作は手動経路があるときだけ表示し、確認して自動へ戻せる', async () => {
        reset();
        assert.equal(element('lp-route-auto-btn').disabled, true);
        assert.equal(element('lp-route-auto-btn').hidden, true);
        element('lp-route-auto-btn').dispatch('click');
        assert.equal(confirmations, 0);
        assert.equal(requests.length, 0);
        start(); await settle();
        assert.equal(element('lp-route-auto-btn').disabled, false);
        element('link-route-finish-btn').dispatch('click');
        assert.equal(element('canvas-context-toolbar').hidden, true);
        assert.equal(element('lp-route-auto-btn').disabled, false);
        assert.equal(element('lp-route-auto-btn').hidden, false);
        const saved = structuredClone(appState.viewLinkRoutes);
        answer = false; element('lp-route-auto-btn').dispatch('click');
        assert.deepEqual(appState.viewLinkRoutes, saved);
        assert.equal(requests.length, 1);
        answer = true; element('lp-route-auto-btn').dispatch('click'); await settle();
        assert.deepEqual(appState.viewLinkRoutes, []);
        assert.equal(requests.length, 2);
        assert.deepEqual(requests[1].views[0].view_link_routes, []);
        assert.equal(element('lp-route-auto-btn').disabled, true);
        assert.equal(element('lp-route-auto-btn').hidden, true);
        element('lp-route-auto-btn').dispatch('click');
        assert.equal(confirmations, 2);
        assert.equal(requests.length, 2);
    });
    await t.test('自動経路への復帰は未確定ドラッグだけを破棄し、操作制限を守る', async () => {
        reset(); start(); await settle(); beginDrag(); move(24);
        assert.ok(editor.getLinkRoutePreview());
        element('lp-route-auto-btn').dispatch('click'); await settle();
        assert.equal(editor.getLinkRoutePreview(), null);
        assert.equal(appState.currentSvg.hasPointerCapture(1), false);
        assert.deepEqual(appState.viewLinkRoutes, []);
        assert.equal(requests.length, 2);
        end(); await settle();
        assert.equal(requests.length, 2);
        for (const blocked of ['viewer', 'auth', 'ping', 'floor', 'conflict', 'selection']) {
            reset();
            appState.viewLinkRoutes = [route()];
            resource.resetResourceBaseline(appState);
            if (blocked === 'viewer') window.APP_CONFIG.user.isAdmin = false;
            if (blocked === 'auth') appState.authExpired = true;
            if (blocked === 'ping') appState.isPinging = true;
            if (blocked === 'floor') appState.floorPlanAdjustMode = true;
            if (blocked === 'conflict') appState.resourceConflicts.views.set(1, {});
            if (blocked === 'selection') appState.editingLinkId = null;
            editor.syncLinkRouteEditor();
            assert.equal(element('lp-route-auto-btn').disabled, true, blocked);
            element('lp-route-auto-btn').dispatch('click');
            assert.deepEqual(appState.viewLinkRoutes, [route()], blocked);
            assert.equal(confirmations, 0, blocked);
            assert.equal(requests.length, 0, blocked);
        }
    });
    await t.test('cancel/ESC/context切替はpreviewだけ破棄し保存確定を維持', async () => {
        reset(); start(); await settle(); const saved = structuredClone(appState.viewLinkRoutes);
        beginDrag(); move(24); end('pointercancel');
        assert.equal(editor.getLinkRoutePreview(), null); assert.ok(segment());
        assert.deepEqual(appState.viewLinkRoutes, saved); assert.equal(requests.length, 1);
        beginDrag(); move(48);
        handleCanvasContextToolbarKeydown({ key: 'Escape', preventDefault() {}, stopImmediatePropagation() {} });
        assert.equal(segment(), null); assert.deepEqual(appState.viewLinkRoutes, saved);
        start(); beginDrag(); move(24); showCanvasContextToolbar('floor-plan', () => {});
        assert.equal(segment(), null); assert.equal(editor.getLinkRoutePreview(), null);
        assert.equal(element('canvas-context-toolbar').hidden, false); finishCanvasContextToolbar();
    });
    await t.test('ビューの新規採番後も共通接続IDを保ち、採番後のビューで経路を確定する', async () => {
        reset();
        // 採番対象は未保存の新規ビュー。既存ビューのIDが変わる応答は作らない。
        delete appState.views[0].resource_revision;
        resource.resetResourceBaseline({ ...appState, views: [], placements: [], viewLinkRoutes: [] });
        hold = true; remap = true; start(); await setImmediate();
        assert.ok(release); beginDrag(); move(20);
        release(); release = null; await settle();
        assert.equal(appState.editingLinkId, 1);
        assert.equal(editor.getLinkRoutePreview().key, '101:10:20');
        end(); await settle();
        assert.equal(requests.at(-1).views[0].id, 101);
        assert.deepEqual(requests.at(-1).views[0].view_link_routes, [route(points(), { view_id: 101 })]);
        assert.equal(points().length, 2); assert.ok(segment());
    });
    await t.test('保存中でも追加編集・keyboardfocus維持', async () => {
        reset(); hold = true; start(); await setImmediate();
        const startY = currentRoute()[0].y;
        segment().focus(); segment().dispatch('keydown', { key: 'ArrowDown', shiftKey: true });
        assert.equal(points()[0].y, startY + 10);
        assert.equal(document.activeElement.dataset.routeSegment, '0');
        render(); assert.equal(document.activeElement.dataset.routeSegment, '0');
        release(); release = null; await settle();
        assert.equal(requests.length, 2); assert.equal(points().length, 2);
    });
    await t.test('応答待ちの連続ドラッグとキー操作は最新経路1件へ集約する', async () => {
        reset(); hold = true;
        const [from, to] = currentRoute();
        start(); await setImmediate();
        assert.ok(release);
        beginDrag(); move(24); end();
        segment(1).dispatch('keydown', { key: 'ArrowDown', shiftKey: true });
        segment(1).dispatch('pointerdown'); move(14); end();
        const expected = [{ x: from.x, y: from.y + 48 }, { x: to.x, y: to.y + 48 }];
        assert.deepEqual(points(), expected);
        assert.equal(requests.length, 1, '確定ごとに並列送信しない');
        assert.deepEqual(queue.getPendingSave().payload.views[0].view_link_routes, [route()],
            '応答待ちsnapshotへ後続経路を混入させない');
        release(); release = null; await settle();
        assert.equal(requests.length, 2);
        assert.deepEqual(requests.map(row => row.views[0].expected_revision), [1, 2]);
        assert.deepEqual(requests[1].views[0].view_link_routes, [route(expected)]);
        assert.deepEqual(points(), expected);
        assert.deepEqual(resource.buildResourceSave().views, []);
        assert.equal(queue.getPendingSave(), null);
        assert.equal(appState.appStatus.state, 'saved');
        assert.ok(segment(), '保存完了後も編集を継続できる');
    });
    await t.test('応答待ちの経路確定からauto復帰も最新modeだけを次の世代で保存する', async () => {
        reset(); hold = true; start(); await setImmediate();
        beginDrag(); move(24); end();
        element('lp-route-auto-btn').dispatch('click');
        assert.deepEqual(appState.viewLinkRoutes, []);
        assert.equal(requests.length, 1);
        assert.equal(segment(), null);
        release(); release = null; await settle();
        assert.equal(requests.length, 2);
        assert.deepEqual(requests[0].views[0].view_link_routes, [route()]);
        assert.equal(requests[1].views[0].expected_revision, 2);
        assert.deepEqual(requests[1].views[0].view_link_routes, []);
        assert.deepEqual(appState.viewLinkRoutes, []);
        assert.deepEqual(resource.buildResourceSave().views, []);
    });
    await t.test('409は最新の確定経路を保留しpreviewだけ破棄、別ビュー保存と既存再読込へ統合する', async () => {
        reset();
        appState.views.push({ id: 2, resource_revision: 1, name: '別ビュー', view_type: 'topology', memo: '' });
        resource.resetResourceBaseline(appState);
        serverData = JSON.parse(JSON.stringify({
            revision: 10, saved_at: '2026-10-05T01:00:00Z',
            devices: appState.devices, views: appState.views, placements: appState.placements,
            links: appState.links, view_link_routes: [], floor_plans: [], device_images: []
        }));
        appState.views[1].memo = '別ビューの確定変更';
        panels.openLinkPanel(visibleLinks()[0]);
        hold = true; fail = true; start(); await setImmediate();
        beginDrag(); move(24); end();
        const committed = structuredClone(points());
        segment(1).dispatch('pointerdown'); move(48);
        assert.ok(editor.getLinkRoutePreview());
        element('lp-label').value = '未適用の説明';
        release(); release = null; await settle();
        assert.equal(queue.hasResourceConflict('views', 1), true);
        assert.equal(queue.hasResourceConflict('views', 2), false);
        assert.deepEqual(points(), committed);
        assert.equal(editor.getLinkRoutePreview(), null);
        assert.equal(appState.currentSvg.hasPointerCapture(1), false);
        assert.equal(segment(), null);
        assert.equal(element('canvas-context-toolbar').hidden, true);
        assert.equal(element('lp-route-edit-btn').disabled, true);
        assert.equal(element('lp-route-auto-btn').disabled, true);
        assert.equal(element('lp-reload-conflict-btn').hidden, false);
        assert.equal(element('lp-label').value, '未適用の説明');
        assert.equal(requests.length, 2);
        assert.deepEqual(requests[1].views.map(row => row.id), [2]);
        assert.equal(requests[1].views[0].view.memo, '別ビューの確定変更');
        assert.deepEqual(resource.buildResourceSave().views.map(row => row.id), [1]);
        assert.equal(queue.getPendingSave(), null);
        const before = requests.length;
        start(); element('lp-route-auto-btn').dispatch('click'); end(); await settle();
        assert.equal(requests.length, before, '競合ビューを自動上書きしない');
        answer = false;
        await documentEvents.dispatch('click', { target: element('lp-reload-conflict-btn') });
        assert.equal(loadRequests, 0);
        assert.deepEqual(points(), committed);
        assert.equal(queue.hasResourceConflict('views', 1), true);
        serverData.views[0].resource_revision = 3;
        serverData.views[1] = { ...appState.views[1] };
        serverData.view_link_routes = [route([{ x: 200, y: 160 }, { x: 400, y: 160 }])];
        answer = true;
        await documentEvents.dispatch('click', { target: element('lp-reload-conflict-btn') });
        assert.equal(loadRequests, 1);
        assert.equal(queue.hasResourceConflict('views', 1), false);
        assert.deepEqual(appState.viewLinkRoutes, serverData.view_link_routes);
        assert.equal(element('lp-label').value, '未適用の説明', '経路の再読込で独立した接続の入力は破棄しない');
        assert.equal(appState.links[0].label, '元の属性');
        assert.equal(element('lp-reload-conflict-btn').hidden, true);
        assert.equal(element('lp-route-edit-btn').disabled, false);
        assert.equal(appState.views.find(row => Number(row.id) === 2).memo, '別ビューの確定変更');
        assert.deepEqual(resource.buildResourceSave().views, []);
        assert.equal(requests.length, before, '再読込した経路を重複保存しない');
        start(); assert.ok(segment(), '最新データで経路編集を再開できる');
    });
    await t.test('経路は最後のmoveではなくupの座標で確定し保存される', async () => {
        reset(); start(); await settle();
        const initial = currentRoute();
        beginDrag(); move(10);
        assert.deepEqual(points(), []);
        end('pointerup', { clientY: 35 }); await settle();
        assert.deepEqual(points(), [
            { x: initial[0].x, y: initial[0].y + 35 },
            { x: initial.at(-1).x, y: initial.at(-1).y + 35 }
        ]);
        assert.deepEqual(requests.at(-1).views[0].view_link_routes, appState.viewLinkRoutes);
    });
    await t.test('経路はmoveなしのupだけでも確定し、cancelでは確定しない', async () => {
        reset(); start(); await settle();
        const initialY = currentRoute()[0].y;
        beginDrag(); end('pointerup', { clientY: 25 }); await settle();
        assert.equal(points()[0].y, initialY + 25);
        const saved = structuredClone(points());
        const count = requests.length;
        beginDrag(); move(20); end('pointercancel', { clientY: 90 }); await settle();
        assert.deepEqual(points(), saved);
        assert.equal(requests.length, count);
    });
    await t.test('フロア図でも区間を調整でき、別pointerの終了やcapture失敗で誤確定しない', async () => {
        reset(); appState.views[0].view_type = 'floor'; start(); await settle();
        assert.deepEqual(appState.viewLinkRoutes, [route()]);
        const initial = currentRoute();
        appState.viewState.scale = 2;
        appState.currentSvg.setPointerCapture = () => { throw new Error('capture不可'); };
        beginDrag(); documentEvents.dispatch('pointermove', { clientX: 900, clientY: 20 });
        documentEvents.dispatch('pointerup', { pointerId: 2 });
        assert.ok(editor.getLinkRoutePreview());
        assert.deepEqual(points(), []);
        end(); await settle();
        assert.deepEqual(points(), [
            { x: initial[0].x, y: initial[0].y + 10 },
            { x: initial.at(-1).x, y: initial.at(-1).y + 10 }
        ]);
    });
    await t.test('ドラッグ中の拡縮・パン後も現在のworld座標で水平区間を確定する', async () => {
        reset(); start(); await settle();
        const sourceY = currentRoute()[0].y;
        beginDrag();
        Object.assign(appState.viewState, { scale: 2, panY: 10 });
        documentEvents.dispatch('pointermove', { clientX: 900, clientY: 30 });
        end(); await settle();
        assert.equal(points()[0].y, sourceY + 10);
        assert.equal(points()[1].y, sourceY + 10);
    });
    await t.test('viewer/認証失効/409・選択変更・外部端点移動を防止', async () => {
        reset(); window.APP_CONFIG.user.isAdmin = false; editor.syncLinkRouteEditor();
        assert.equal(element('lp-route-edit-btn').disabled, true); start(); assert.equal(segment(), null);
        window.APP_CONFIG.user.isAdmin = true; appState.authExpired = true; start(); assert.equal(segment(), null);
        appState.authExpired = false; start(); await settle(); beginDrag(); move(24);
        appState.placements[0].x += 10; end(); await settle();
        assert.equal(segment(), null);
        assert.deepEqual(points(), [], '端点変更後に古いpreviewを確定しない');
        start(); beginDrag(); move(24); appState.editingLinkId = null; appState.editingLinkGroupKey = null;
        eventBus.emit('link-route:selection-changed'); assert.equal(segment(), null); assert.equal(editor.getLinkRoutePreview(), null);
        await settle(); reset(); fail = true; start(); await settle();
        assert.equal(queue.hasResourceConflict('views', 1), true); assert.equal(segment(), null);
        assert.equal(element('lp-route-edit-btn').disabled, true);
    });
    await t.test('最大8折れの追加disabledと垂直区間の左右キー', async () => {
        reset();
        appState.viewLinkRoutes = [route([
            { x: 200, y: 143 }, { x: 200, y: 180 }, { x: 260, y: 180 }, { x: 260, y: 220 },
            { x: 320, y: 220 }, { x: 320, y: 180 }, { x: 400, y: 180 }, { x: 400, y: 143 }
        ])];
        resource.resetResourceBaseline(appState);
        start(); assert.equal(requests.length, 0);
        segment(1).dispatch('keydown', { key: 'Enter' });
        assert.equal(element('link-route-add-btn').disabled, true);
        segment(1).dispatch('keydown', { key: 'ArrowRight' }); await settle();
        assert.equal(points()[0].x, 201);
        assert.equal(points()[1].x, 201);
        element('link-route-remove-btn').dispatch('click'); await settle();
        assert.ok(points().length < 8);
        assert.equal(element('link-route-add-btn').disabled, points().length > 6);
    });
    await t.test('再読込・ビュー変更・リンク消失・編集中の権限失効', async () => {
        reset(); start(); await settle(); beginDrag(); move(24);
        eventBus.emit('resource:reloaded', { kind: 'views', id: 2 });
        assert.ok(editor.getLinkRoutePreview());
        eventBus.emit('resource:reloaded', { kind: 'views', id: 1 });
        assert.equal(segment(), null); assert.equal(editor.getLinkRoutePreview(), null);
        start(); beginDrag(); move(24); appState.currentViewId = 2; editor.syncLinkRouteEditor();
        assert.equal(segment(), null); assert.equal(editor.getLinkRoutePreview(), null);
        appState.currentViewId = 1; start(); appState.links = []; editor.syncLinkRouteEditor();
        assert.equal(segment(), null);
        reset(); start(); await settle(); beginDrag(); move(24);
        window.APP_CONFIG.user.isAdmin = false; eventBus.emit('save-state:changed');
        assert.equal(segment(), null); assert.equal(element('lp-route-edit-btn').disabled, true);
        assert.equal(requests.length, 1);
        window.APP_CONFIG.user.isAdmin = true; start(); appState.authExpired = true;
        eventBus.emit('save-state:changed'); assert.equal(segment(), null);
    });
    await t.test('点数超過を無変更で拒否し、同contextはリンク切替で終了する', async () => {
        reset();
        appState.viewLinkRoutes = [route(Array.from({ length: 9 }, (_, x) => ({ x, y: 0 })))];
        start(); assert.equal(segment(), null); assert.equal(points().length, 9); assert.equal(requests.length, 0);
        appState.viewLinkRoutes = [route()];
        start(); assert.ok(segment()); assert.equal(requests.length, 0);
        beginDrag(); move(24);
        appState.devices.push({ id: 30, name: 'SW3', type: 'switch', resource_revision: 1 });
        appState.placements.push({ id: 31, device_id: 30, view_id: 1, x: 900, y: 100 });
        appState.links.push({ id: 2, from_id: 20, to_id: 30, resource_revision: 1 });
        appState.viewLinkRoutes.push(route([], { device_a_id: 20, device_b_id: 30 }));
        appState.editingLinkId = 2; start();
        assert.equal(editor.getLinkRoutePreview(), null); assert.ok(segment());
        assert.deepEqual(points(), []);
    });
    await t.test('実rendererはmanualのbridge/gapをpreview・hit・hover・選択・viewer表示で維持する', async () => {
        window.localStorage = { getItem: () => 'bridge', setItem() {} };
        const numbers = path => path.match(/-?(?:\d*\.)?\d+(?:e[+-]?\d+)?/gi).map(Number);
        for (const mode of ['bridge', 'gap']) {
            reset(); renderAllLinks = true;
            appState.devices = [1, 2, 3, 4].map(id => ({ id, resource_revision: 1, name: `機器${id}`, type: 'switch' }));
            const placement = (id, x, y) => ({ id, device_id: id, view_id: 1, x: x - 10, y: y - 10, width: 20, height: 20 });
            appState.placements = [placement(1, 50, -100), placement(2, 50, 100),
                placement(3, 0, 0), placement(4, 300, 200)];
            appState.linkSystems = [
                { id: 8, name: '共通系統A', color_key: 'indigo' },
                { id: 9, name: '共通系統B', color_key: 'teal' }
            ];
            appState.links = [
                { id: 1, from_id: 1, to_id: 2, system_id: 8, resource_revision: 1 },
                { id: 2, from_id: 3, to_id: 4, system_id: 9, label: '多段の手動配線', resource_revision: 1 }
            ];
            appState.viewLinkRoutes = [route(
                [{ x: 100, y: 0 }, { x: 100, y: 100 }, { x: 200, y: 100 }, { x: 200, y: 200 }],
                { device_a_id: 3, device_b_id: 4 }
            )];
            appState.editingLinkId = 2;
            for (const id of ['lp-label', 'lp-from-port', 'lp-to-port', 'lp-memo']) {
                const input = element(id); input.tagName = id === 'lp-memo' ? 'TEXTAREA' : 'INPUT';
                element('link-panel').appendChild(input);
            }
            resource.resetResourceBaseline(appState);
            const snapshot = structuredClone({ links: appState.links, routes: appState.viewLinkRoutes });
            displaySettings.setLinkCrossingStyle(mode);
            const group = id => appState.currentSvg.children.find(node => node.dataset.displayKey === (id === 1 ? '1:1:2' : '1:3:4'));
            const path = (id, type) => group(id).children.find(node => node.classList.contains(type));
            const active = () => appState.currentSvg.children.find(node => node.classList.contains('link-foreground'))
                .children.find(node => node.classList.contains('link-foreground-path')).getAttribute('d');
            const foreground = () => appState.currentSvg.children.find(node => node.classList.contains('link-foreground'));
            const foregroundColor = () => foreground().children.find(node =>
                node.classList.contains('link-foreground-path')).style.stroke;
            const autoColor = 'var(--link-system-indigo, #4B5BA9)';
            const selectedColor = 'var(--primary)';
            assert.equal(path(1, 'topology-link').style.stroke, autoColor);
            assert.equal(path(2, 'topology-link').style.stroke, selectedColor);
            assert.equal(foregroundColor(), selectedColor);
            assert.equal(foreground().classList.contains('selected'), true);
            const visible = path(2, 'topology-link').getAttribute('d');
            assert.equal((visible.match(/M/g) ?? []).length, mode === 'gap' ? 2 : 1);
            assert.equal((visible.match(/Q/g) ?? []).length, mode === 'bridge' ? 1 : 0);
            assert.deepEqual(numbers(path(2, 'topology-link-hit').getAttribute('d')),
                [0, 0, 100, 0, 100, 100, 200, 100, 200, 200, 300, 200]);
            assert.equal(active(), visible, '選択強調でbridge/gapを直線へ戻さない');
            const label = group(2).children.find(node => node.classList.contains('link-label'));
            assert.equal(Number(label.getAttribute('x')), 150);
            assert.equal(Number(label.getAttribute('y')), 92);
            await group(1).dispatch('pointerenter');
            assert.equal(active(), path(1, 'topology-link').getAttribute('d'));
            assert.equal(foregroundColor(), autoColor, 'hoverは自動経路の系統色を保持する');
            assert.equal(foreground().classList.contains('selected'), false, '非選択hoverへPrimary outlineを持ち越さない');
            assert.equal(group(2).classList.contains('selected'), true);
            assert.equal(path(2, 'topology-link').style.stroke, selectedColor);
            await group(1).dispatch('pointerleave');
            assert.equal(active(), visible, 'hover終了後は選択中の手動経路へ戻す');
            assert.equal(foregroundColor(), selectedColor, 'hover離脱時は選択色へ戻す');
            assert.equal(foreground().classList.contains('selected'), true, '選択のPrimary outlineも復元する');
            await group(1).dispatch('pointerenter');
            await group(2).dispatch('pointerenter');
            await group(1).dispatch('pointerleave');
            assert.equal(active(), visible, '古いhover離脱は現在のforegroundを変更しない');
            assert.equal(foregroundColor(), selectedColor);
            assert.equal(foreground().classList.contains('selected'), true);
            await group(2).dispatch('pointerleave');
            await path(2, 'topology-link-hit').dispatch('click'); await setImmediate();
            assert.equal(appState.editingLinkId, 2);
            assert.equal(element('lp-label').value, '多段の手動配線');
            start(); beginDrag(); move(20);
            assert.deepEqual(numbers(path(2, 'topology-link-hit').getAttribute('d')).slice(0, 6),
                [0, 0, 0, 20, 100, 20], 'hitにも端点固定のpreviewを反映する');
            assert.equal(active(), path(2, 'topology-link').getAttribute('d'));
            assert.equal(foregroundColor(), selectedColor, 'previewも選択色を保持する');
            assert.deepEqual({ links: appState.links, routes: appState.viewLinkRoutes }, snapshot,
                'previewを確定データへ混入させない');
            end('pointercancel');
            assert.equal(path(2, 'topology-link').getAttribute('d'), visible);
            window.APP_CONFIG.user.isAdmin = false; appState.editingLinkId = null; appState.editingLinkGroupKey = null;
            renderer.renderLinks();
            assert.equal(segment(), null);
            await path(2, 'topology-link-hit').dispatch('click'); await setImmediate();
            renderer.renderLinks();
            assert.equal(appState.editingLinkId, 2);
            assert.equal(path(2, 'topology-link').getAttribute('d'), visible);
            assert.equal(active(), visible);
            assert.equal(foregroundColor(), selectedColor, '閲覧者の選択にも青い線色を使う');
            assert.equal(element('lp-from-port').readOnly, true);
            assert.equal(element('lp-route-edit-btn').disabled, true);
            start(); assert.equal(segment(), null);
            assert.deepEqual({ links: appState.links, routes: appState.viewLinkRoutes }, snapshot);
            assert.deepEqual(resource.buildResourceSave().views, []);
            assert.equal(requests.length, 0, '表示方式・hover・選択・preview取消・viewer表示で保存しない');
        }
    });
    await t.test('複数接続の経路は明細の選択・再採番・1件に減少してもペアの編集を継続する', async () => {
        reset();
        appState.links.push({ id: 2, from_id: 20, to_id: 10, label: '逆方向の明細', resource_revision: 1 });
        assert.equal(await panels.openLinkGroup(getCurrentLinkGroups()[0]), true);
        assert.equal(appState.editingLinkId, null);
        assert.equal(element('lp-detail-actions').hidden, true);
        assert.equal(element('lp-route-section').hidden, false);
        resource.resetResourceBaseline(appState);
        editor.syncLinkRouteEditor();
        assert.equal(element('lp-route-edit-btn').disabled, false);
        start(); await settle(); beginDrag(); move(24);
        assert.equal(element('lp-route-auto-btn').hidden, false);
        assert.equal(editor.getLinkRoutePreview().key, '1:10:20');
        appState.editingLinkId = 2;
        eventBus.emit('link-route:selection-changed');
        assert.equal(editor.getLinkRoutePreview().key, '1:10:20');
        appState.links[1].id = 20;
        appState.editingLinkId = 20;
        eventBus.emit('resources:ids-remapped', { links: { 2: 20 } });
        assert.equal(editor.getLinkRoutePreview().key, '1:10:20');
        appState.links = appState.links.slice(1);
        resource.resetResourceBaseline(appState);
        render();
        assert.equal(editor.getLinkRoutePreview().key, '1:10:20');
        const snapshot = structuredClone(appState.links);
        end(); await settle();
        assert.equal(requests.length, 2);
        assert.deepEqual(requests[1].views[0].view_link_routes, [route(points())]);
        assert.deepEqual(appState.links, snapshot);
        assert.deepEqual(visibleLinks()[0].manual_route, points().toReversed());
        assert.ok(segment());
    });
    await t.test('系統未設定・旧形式・削除済み参照は既存色を保ち、非選択hover終了でforegroundを隠す', async () => {
        let defaultColor;
        for (const systemId of [undefined, null, 999, 8]) {
            reset();
            appState.linkSystems = [{ id: 8, name: '不明な色', color_key: 'unknown' }];
            if (systemId !== undefined) appState.links[0].system_id = systemId;
            appState.editingLinkId = null;
            renderer.renderLinks();
            const group = appState.currentSvg.children.find(node => node.classList.contains('link-group'));
            const path = group.children.find(node => node.classList.contains('topology-link'));
            const hit = group.children.find(node => node.classList.contains('topology-link-hit'));
            const foreground = appState.currentSvg.children.find(node => node.classList.contains('link-foreground'));
            const active = foreground.children.find(node => node.classList.contains('link-foreground-path'));
            if (defaultColor === undefined) defaultColor = path.style.stroke;
            else assert.equal(path.style.stroke, defaultColor, '未設定・旧形式・解決不能な参照は同じ標準色を使う');
            assert.equal(hit.getAttribute('d'), path.getAttribute('d'));
            assert.equal(foreground.style.display, 'none');
            await group.dispatch('pointerenter');
            assert.equal(active.style.stroke, path.style.stroke);
            assert.equal(active.getAttribute('d'), path.getAttribute('d'));
            assert.equal(foreground.classList.contains('selected'), false);
            await group.dispatch('pointerleave');
            assert.equal(foreground.style.display, 'none');
        }
    });
});
