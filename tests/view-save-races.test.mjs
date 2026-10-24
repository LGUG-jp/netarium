import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';

// 実際のフォーム・ポインター操作を保存キュー/API境界まで通す軽量DOM。
test('ビュー確定保存とドラッグの競合境界', async t => {
    const keys = ['window', 'document', 'Element', 'HTMLElement', 'fetch', 'confirm', 'requestAnimationFrame', 'cancelAnimationFrame'];
    const original = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    t.after(async () => {
        // モーダルのフォーカス予約を消化してからブラウザglobalsを復元する。
        await new Promise(resolve => setTimeout(resolve, 0));
        for (const [key, descriptor] of original) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    });
    class DomElement {
        constructor(id = '') {
            this.id = id; this.value = ''; this.hidden = true; this.disabled = false;
            this.children = []; this.dataset = {}; this.style = {}; this.attributes = new Map();
            this.options = [];
            this.listeners = new Map(); this.classes = new Set(); this.captures = new Set();
            this.classList = {
                add: (...names) => names.forEach(name => this.classes.add(name)),
                remove: (...names) => names.forEach(name => this.classes.delete(name)),
                contains: name => this.classes.has(name),
                toggle: (name, force) => {
                    const enabled = force ?? !this.classes.has(name);
                    if (enabled) this.classes.add(name); else this.classes.delete(name);
                    return enabled;
                }
            };
        }
        addEventListener(type, fn) {
            if (!this.listeners.has(type)) this.listeners.set(type, new Set());
            this.listeners.get(type).add(fn);
        }
        removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
        async dispatch(type, event = {}) {
            for (const fn of [...(this.listeners.get(type) || [])]) await fn(event);
        }
        appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
        append(...children) { children.forEach(child => this.appendChild(child)); }
        remove() {
            if (this.parentElement) {
                this.parentElement.children = this.parentElement.children.filter(child => child !== this);
                this.parentElement = null;
            }
        }
        replaceChildren(...children) { this.children = children; }
        setAttribute(name, value) { this.attributes.set(name, String(value)); }
        getAttribute(name) { return this.attributes.get(name) ?? null; }
        removeAttribute(name) { this.attributes.delete(name); }
        closest() { return null; }
        querySelector(selector) {
            if (/^\.[\w-]+$/.test(selector)) {
                return this.children.find(child => (child.className || '').split(/\s+/).includes(selector.slice(1))) || null;
            }
            const placementId = selector.match(/data-placement-id="(\d+)"/)?.[1];
            return this.children.find(child => child.dataset.placementId === placementId) || null;
        }
        querySelectorAll() { return []; }
        focus() {}
        scrollIntoView() {}
        contains() { return false; }
        setPointerCapture(id) { this.captures.add(id); }
        hasPointerCapture(id) { return this.captures.has(id); }
        releasePointerCapture(id) { this.captures.delete(id); }
        getBoundingClientRect() { return { left: 0, top: 0, width: 1000, height: 800 }; }
    }
    const elements = new Map();
    const el = id => {
        if (!elements.has(id)) elements.set(id, new DomElement(id));
        return elements.get(id);
    };
    const findElement = (root, id) => {
        if (root.id === id) return root;
        for (const child of root.children) {
            const found = findElement(child, id);
            if (found) return found;
        }
        return null;
    };
    const createElement = tag => {
        const element = new DomElement(tag);
        element.hidden = false;
        return element;
    };
    const docEvents = new DomElement();
    globalThis.Element = globalThis.HTMLElement = DomElement;
    globalThis.document = {
        body: new DomElement(), activeElement: null,
        getElementById: id => findElement(document.body, id) ?? (id.startsWith('unsaved-changes-') ? null : el(id)),
        querySelector: () => null, querySelectorAll: () => [],
        createElement, createElementNS: (_, tag) => createElement(tag),
        addEventListener: docEvents.addEventListener.bind(docEvents),
        removeEventListener: docEvents.removeEventListener.bind(docEvents)
    };
    const raf = fn => { const timer = setTimeout(fn, 0); timer.unref(); return timer; };
    globalThis.requestAnimationFrame = raf;
    globalThis.cancelAnimationFrame = clearTimeout;
    globalThis.window = {
        addEventListener() {}, innerWidth: 1366, innerHeight: 768,
        APP_CONFIG: { user: { isAdmin: true }, csrfToken: 'test-token' },
        requestAnimationFrame: raf, clearTimeout,
        setTimeout(fn, delay) { const timer = setTimeout(fn, delay); timer.unref(); return timer; },
        getComputedStyle: () => ({ display: 'block', visibility: 'visible' })
    };
    let confirmations = [];
    let answers = [];
    globalThis.confirm = message => { confirmations.push(message); return answers.shift() ?? true; };
    window.confirm = (...args) => globalThis.confirm(...args);
    const { appState } = await import('../public/js/core/state.js');
    const resource = await import('../public/js/core/resource-save.js');
    const queue = await import('../public/js/core/save-queue.js');
    const { normalizeCanvasNote } = await import('../public/js/core/canvas-note-data.js');
    const manager = await import('../public/js/modals/view-manager-modal.js');
    const { initViewCombobox } = await import('../public/js/ui/view-combobox.js');
    const placementManager = await import('../public/js/modals/placement-modal.js');
    const { render } = await import('../public/js/canvas/renderer.js');
    const panels = await import('../public/js/ui/property-panel.js');
    const { openDirectLink } = await import('../public/js/core/direct-link.js');
    const { eventBus } = await import('../public/js/core/event-bus.js');
    t.after(() => queue.clearPendingSave());
    let calls = [];
    let failStatus = 0;
    let held = null;
    let holdNext = false;
    let viewIds = {};
    let placementIds = {};
    let serverData = null;
    const responseFor = (payload, newIds) => {
        // 応答はこのリクエストで新規作成したIDだけを採番する。
        // 未送信の次の複製IDを先に返すと、次回送信の仮IDとfixtureの対応がずれる。
        const configured = { devices: {}, views: viewIds, placements: placementIds, links: {}, canvas_notes: {} };
        const maps = Object.fromEntries(Object.entries(newIds).map(([kind, ids]) => [
            kind, Object.fromEntries(ids.map(id => [id, Number(configured[kind][id] ?? id + 1000)]))
        ]));
        const map = (kind, id) => Number(maps[kind]?.[id] ?? id);
        return {
            ok: true, revision: appState.dataRevision + 1, saved_at: '2026-10-03T01:00:00Z',
            id_maps: maps,
            devices: [],
            views: payload.views.filter(row => row.operation !== 'delete').map(row => ({
                ...row.view, id: map('views', row.id), resource_revision: (row.expected_revision || 0) + 1
            })),
            placements: payload.views.flatMap(row => (row.placements || []).map(item => ({
                ...item, id: map('placements', item.id), view_id: map('views', item.view_id)
            }))),
            links: payload.views.flatMap(row => (row.links || []).map(item => ({
                ...item, id: map('links', item.id), view_id: map('views', item.view_id),
                from_id: map('devices', item.from_id), to_id: map('devices', item.to_id)
            }))),
            canvas_notes: payload.views.flatMap(row => (row.canvas_notes || []).map(note => ({
                ...note, id: map('canvas_notes', note.id), view_id: map('views', note.view_id)
            }))),
            deleted_device_ids: [], deleted_view_ids: payload.views.filter(row => row.operation === 'delete').map(row => row.id),
            affected_view_ids: payload.views.map(row => map('views', row.id))
        };
    };
    globalThis.fetch = async (url, options) => {
        if (url.includes('action=load')) return new Response(JSON.stringify(serverData));
        const payload = JSON.parse(options.body);
        calls.push(payload);
        const { newIds } = resource.createPendingResourceSave(payload);
        if (holdNext) {
            holdNext = false;
            await new Promise(resolve => { held = resolve; });
        }
        if (failStatus) return new Response(JSON.stringify({ ok: false, error: '保存失敗', details: {
            conflicts: [{ kind: 'views', id: payload.views[0].id, name: payload.views[0].view?.name }]
        } }), { status: failStatus });
        return new Response(JSON.stringify(responseFor(payload, newIds)));
    };
    const reset = async (name = '本館') => {
        eventBus.emit('resources:reloaded');
        queue.clearPendingSave();
        elements.clear(); confirmations = []; answers = []; calls = []; failStatus = 0;
        el('lp-system').setAttribute('aria-controls', 'lp-system-options');
        for (const [id, className] of [['lp-system-name', 'link-system-option-name'], ['lp-system-swatch', 'link-system-swatch']]) {
            el(id).className = className;
            el('lp-system').appendChild(el(id));
        }
        held = null; holdNext = false; viewIds = {}; placementIds = {};
        appState.views = [
            { id: 1, resource_revision: 1, name, facility: '', floor: '', view_type: 'topology', sort_order: 10, memo: '' },
            { id: 2, resource_revision: 1, name: '別館', facility: '', floor: '', view_type: 'topology', sort_order: 20, memo: '' }
        ];
        appState.devices = [{ id: 10, resource_revision: 1, name: 'SW', type: 'switch', ip: '' }];
        appState.placements = [{ id: 100, device_id: 10, view_id: 1, x: 100, y: 100 }];
        appState.links = []; appState.floorPlans = []; appState.deviceImages = [];
        appState.canvasNotes = []; appState.selectedCanvasNoteId = null; appState.nextCanvasNoteId = 1; appState.noteMode = false;
        appState.currentViewId = 1; appState.nextViewId = 3; appState.nextPlacementId = 101; appState.nextLinkId = 1;
        appState.viewStates = new Map(); appState.selectedPlacementIds = new Set();
        appState.resourceConflicts = { devices: new Map(), views: new Map() };
        appState.floorPlanAutoFittedViews = new Set();
        appState.authExpired = false; appState.isSaving = false; appState.isPinging = false;
        appState.isRangeSelecting = false; appState.floorPlanAdjustMode = false; appState.linkMode = false;
        appState.editingDeviceId = null; appState.editingLinkId = null;
        appState.viewState.scale = 1; appState.currentSvg = null; appState.deviceLayer = null; appState.floorPlanLayer = null;
        appState.appStatus = { dirty: false, state: 'saved', lastSavedAt: null, lastError: null };
        resource.resetResourceBaseline(appState);
        manager.openViewManager();
    };
    const enter = (id, value) => { el(id).value = value; manager.updateViewManagerFormState(); };
    const release = async () => { assert.ok(held); held(); await setImmediate(); };
    const select = id => el('view-manager-list').children.find(child => Number(child.dataset.viewId) === id).dispatch('click');
    const choose = async (pending, choice) => {
        await setImmediate();
        const button = document.getElementById(`unsaved-changes-${choice}`);
        assert.ok(button, `三択ダイアログの${choice}ボタンが表示される`);
        await button.dispatch('click');
        return await pending;
    };
    let initializedToolbarInput = null;
    const selectToolbarView = id => {
        const input = el('view-search-input');
        if (initializedToolbarInput !== input) {
            initViewCombobox(manager.switchView);
            initializedToolbarInput = input;
        }
        input.value = appState.views.find(view => view.id === id).name;
        input.dispatch('input');
        return input.dispatch('keydown', { key: 'Enter', preventDefault() {} });
    };

    await t.test('ビュー切替で機器パネル未適用入力をキャンセルすると対象と入力を保持する', async () => {
        await reset();
        assert.equal(await panels.openPanel(appState.devices[0]), true);
        el('p-name').value = '未適用SW';
        await choose(selectToolbarView(2), 'cancel');
        assert.equal(appState.currentViewId, 1);
        assert.equal(appState.editingDeviceId, 10);
        assert.equal(el('panel').hidden, false);
        assert.equal(el('p-name').value, '未適用SW');
        assert.equal(el('view-search-input').value, '本館');
        assert.equal(appState.devices[0].name, 'SW');
        assert.equal(calls.length, 0);
        await choose(selectToolbarView(2), 'discard');
        await queue.flushSaveQueue({ silent: true });
        assert.equal(appState.currentViewId, 2);
        assert.equal(el('view-search-input').value, '別館');
        assert.equal(appState.editingDeviceId, null);
        assert.equal(el('panel').hidden, true);
        assert.equal(appState.devices[0].name, 'SW');
        assert.equal(calls.length, 0);
    });
    await t.test('直接リンクは未適用入力の破棄拒否でフォーカスせず、破棄承認後にだけ詳細へ移動する', async t => {
        await reset();
        const originalCanvas = appState.canvas;
        appState.canvas = el('canvas');
        t.after(() => { appState.canvas = originalCanvas; });
        appState.placements.push({ id: 291, view_id: 2, device_id: 10, x: 400, y: 300 });
        resource.resetResourceBaseline(appState);
        assert.equal(await panels.openPanel(appState.devices[0]), true);
        el('p-name').value = 'リンク遷移前の未適用入力';
        const selected = [...appState.selectedPlacementIds];
        assert.equal(await choose(openDirectLink('?view=2&device=10'), 'cancel'), false);
        assert.equal(appState.currentViewId, 1);
        assert.equal(el('p-name').value, 'リンク遷移前の未適用入力');
        assert.deepEqual([...appState.selectedPlacementIds], selected);
        assert.equal(calls.length, 0);
        assert.equal(await choose(openDirectLink('?view=2&device=10'), 'discard'), true);
        await queue.flushSaveQueue({ silent: true });
        assert.equal(appState.currentViewId, 2);
        assert.equal(appState.editingDeviceId, 10);
        assert.deepEqual([...appState.selectedPlacementIds], [291]);
        assert.equal(appState.devices[0].name, 'SW');
        assert.equal(calls.length, 0);
    });
    await t.test('ビュー切替でリンク未適用入力のキャンセル・破棄を処理し自動適用しない', async () => {
        await reset();
        appState.devices.push({ id: 11, resource_revision: 1, name: 'SW2', type: 'switch', ip: '' });
        appState.links = [{ id: 200, view_id: 1, from_id: 10, to_id: 11, label: '確定リンク', from_port: '', to_port: '', vlan: '', memo: '' }];
        resource.resetResourceBaseline(appState);
        assert.equal(await panels.openLinkPanel(appState.links[0]), true);
        el('lp-label').value = '未適用リンク';
        await choose(selectToolbarView(2), 'cancel');
        assert.equal(appState.currentViewId, 1);
        assert.equal(appState.editingLinkId, 200);
        assert.equal(el('link-panel').hidden, false);
        assert.equal(el('lp-label').value, '未適用リンク');
        assert.equal(appState.links[0].label, '確定リンク');
        assert.equal(calls.length, 0);
        await choose(selectToolbarView(2), 'discard');
        await queue.flushSaveQueue({ silent: true });
        assert.equal(appState.currentViewId, 2);
        assert.equal(appState.editingLinkId, null);
        assert.equal(el('link-panel').hidden, true);
        assert.equal(appState.links[0].label, '確定リンク');
        assert.equal(calls.length, 0);
    });

    await t.test('適用ボタンは未適用差分に追従し元の値に戻すとdirtyも解除する', async () => {
        await reset();
        assert.equal(el('view-apply-btn').disabled, true);
        enter('vm-name', '変更後');
        assert.equal(appState.viewManagerFormDirty, true);
        assert.equal(el('view-apply-btn').disabled, false);
        window.APP_CONFIG.user.isAdmin = false;
        manager.updateViewManagerFormState();
        assert.equal(el('view-apply-btn').disabled, true);
        window.APP_CONFIG.user.isAdmin = true;
        appState.authExpired = true;
        manager.updateViewManagerFormState();
        assert.equal(el('view-apply-btn').disabled, true);
        appState.authExpired = false;
        enter('vm-name', '本館');
        assert.equal(appState.viewManagerFormDirty, false);
        assert.equal(el('view-apply-btn').disabled, true);
        assert.equal(calls.length, 0);
    });
    await t.test('全項目検証前にモデルを部分更新しない', async () => {
        await reset();
        enter('vm-name', '変更後'); enter('vm-facility', '施'.repeat(101));
        assert.equal(await manager.applyViewForm(), false);
        assert.equal(appState.views[0].name, '本館');
        assert.equal(appState.views[0].facility, '');
        assert.equal(calls.length, 0);
        enter('vm-facility', ''); enter('vm-sort-order', '1.5');
        assert.equal(await manager.applyViewForm(), false);
        assert.equal(appState.views[0].name, '本館');
    });
    await t.test('失敗後の同じ入力の再適用はAPI再送し、再失敗を成功扱いしない', async () => {
        await reset(); failStatus = 422; enter('vm-name', '変更後');
        assert.equal(await manager.applyViewForm(), false);
        assert.equal(el('view-apply-btn').disabled, false, '確定済み未保存差分の再試行が可能');
        assert.equal(await manager.applyViewForm(), false);
        assert.equal(calls.length, 2);
        assert.equal(calls[1].views[0].view.name, '変更後');
        failStatus = 0;
        assert.equal(await manager.applyViewForm(), true);
        assert.equal(calls.length, 3);
        assert.equal(queue.hasPendingChanges(), false);
        assert.equal(el('view-apply-btn').disabled, true);
    });
    await t.test('送信中に再適用した次の確定入力を古い完了が未適用扱いしない', async () => {
        await reset(); enter('vm-name', '一回目'); holdNext = true;
        const first = manager.applyViewForm(); await setImmediate();
        enter('vm-name', '二回目'); const second = manager.applyViewForm();
        await release();
        assert.equal(await first, true); assert.equal(await second, true);
        assert.equal(appState.views[0].name, '二回目');
        assert.equal(el('vm-name').value, '二回目');
        assert.equal(appState.viewManagerFormDirty, false);
        assert.equal(calls.length, 2);
    });
    await t.test('保存待機中の追加DOM入力はモデルへ流出せずdirtyと入力が残る', async () => {
        await reset(); enter('vm-name', '確定名'); holdNext = true;
        const saving = manager.applyViewForm();
        await setImmediate();
        assert.equal(el('view-apply-btn').disabled, true, '確定済み送信だけでは適用を再要求しない');
        await setImmediate(); enter('vm-name', '次の未適用名'); enter('vm-memo', '次のメモ');
        assert.equal(el('view-apply-btn').disabled, false, '通信中の次の未適用入力は適用できる');
        await release(); assert.equal(await saving, true);
        assert.equal(el('vm-name').value, '次の未適用名');
        assert.equal(el('vm-memo').value, '次のメモ');
        assert.equal(appState.viewManagerFormDirty, true);
        assert.equal(appState.views[0].name, '確定名');
        assert.equal(appState.views[0].memo, '');
        assert.equal(calls.length, 1);
    });
    await t.test('古い適用完了は切替後のフォームとdirtyを書き換えない', async () => {
        await reset(); enter('vm-name', '確定名'); holdNext = true;
        const saving = manager.applyViewForm(); await setImmediate();
        await select(2); enter('vm-memo', '別館の未適用');
        await release(); await saving;
        assert.equal(manager.getViewManagerSelectedView().id, 2);
        assert.equal(el('vm-id').value, '2');
        assert.equal(el('vm-memo').value, '別館の未適用');
        assert.equal(appState.viewManagerFormDirty, true);
    });
    await t.test('保存中のビュー切替で別ビューの確定と未適用入力を分離して保持する', async () => {
        await reset(); enter('vm-name', '本館の確定名'); holdNext = true;
        const first = manager.applyViewForm(); await setImmediate();
        let second;
        try {
            await selectToolbarView(2);
            await select(2); enter('vm-memo', '別館の確定メモ');
            second = manager.applyViewForm();
            enter('vm-memo', '別館の次の未適用メモ');
            assert.equal(calls.length, 1, '別ビューも先行保存の応答を待つ');
        } finally {
            await release();
            await Promise.allSettled([first, second]);
        }
        assert.equal(await first, true);
        assert.equal(await second, true);
        assert.equal(appState.currentViewId, 2);
        assert.equal(manager.getViewManagerSelectedView().id, 2);
        assert.equal(appState.views.find(view => view.id === 1).name, '本館の確定名');
        assert.equal(appState.views.find(view => view.id === 2).memo, '別館の確定メモ');
        assert.equal(el('vm-memo').value, '別館の次の未適用メモ');
        assert.equal(appState.viewManagerFormDirty, true);
        assert.equal(queue.hasPendingChanges(), false);
        assert.equal(calls.length, 2);
        assert.deepEqual(calls[1].views.map(view => view.id), [2]);
        assert.equal(calls[1].views[0].expected_revision, 1);
        assert.equal(calls[1].views[0].view.memo, '別館の確定メモ');
        await choose(manager.closeViewManager(), 'discard');
    });
    await t.test('切替前の遅延保存失敗でも別ビューの確定値と次の未適用入力を保持し再試行できる', async () => {
        await reset(); enter('vm-name', '本館の再試行名'); holdNext = true; failStatus = 422;
        const first = manager.applyViewForm(); await setImmediate();
        let second;
        try {
            await selectToolbarView(2);
            await select(2); enter('vm-memo', '別館の確定メモ');
            second = manager.applyViewForm();
            enter('vm-memo', '別館の未適用メモ');
        } finally {
            await release();
            await Promise.allSettled([first, second]);
        }
        assert.equal(await first, false);
        assert.equal(await second, false);
        assert.equal(calls.length, 1, '確定失敗後に後続要求を成功扱いして送信しない');
        assert.equal(queue.getPendingSave(), null, '422は成否不明ではない');
        assert.equal(queue.hasPendingChanges(), true);
        assert.equal(appState.currentViewId, 2);
        assert.equal(el('vm-id').value, '2');
        assert.equal(el('vm-memo').value, '別館の未適用メモ');
        assert.equal(appState.viewManagerFormDirty, true);
        assert.equal(appState.views.find(view => view.id === 1).name, '本館の再試行名');
        assert.equal(appState.views.find(view => view.id === 2).memo, '別館の確定メモ');
        failStatus = 0;
        assert.equal(await queue.flushSaveQueue({ silent: true }), true);
        assert.deepEqual(calls[1].views.map(view => view.id), [1, 2]);
        assert.ok(calls[1].views.every(view => view.expected_revision === 1));
        assert.equal(queue.hasPendingChanges(), false);
        assert.equal(el('vm-memo').value, '別館の未適用メモ');
        assert.equal(appState.viewManagerFormDirty, true);
        await choose(manager.closeViewManager(), 'discard');
    });
    await t.test('全再読込通知は古い未適用DOMを再確認せず管理画面と選択を破棄する', async () => {
        await reset(); enter('vm-name', '再読込前の入力');
        const before = confirmations.length;
        appState.views = appState.views.map(view => view.id === 1 ? { ...view, name: '再読込後' } : view);
        eventBus.emit('resources:reloaded');
        assert.equal(confirmations.length, before);
        assert.equal(document.getElementById('unsaved-changes-overlay'), null);
        assert.equal(el('view-manager-overlay').hidden, true);
        assert.equal(appState.viewManagerFormDirty, false);
        assert.equal(manager.getViewManagerSelectedView(), null);
        assert.equal(manager.hasViewManagerChanges(), false);
        assert.equal(el('vm-id').value, '');
        await manager.closeViewManager();
        assert.equal(confirmations.length, before);
        assert.equal(document.getElementById('unsaved-changes-overlay'), null);
        manager.openViewManager();
        assert.equal(el('vm-name').value, '再読込後');
        assert.equal(el('vm-id').value, '1');
    });
    await t.test('削除送信中に閉じても確定済み削除を復活させない', async () => {
        await reset(); holdNext = true;
        await manager.deleteSelectedView(); await setImmediate();
        const count = confirmations.length;
        await manager.closeViewManager();
        assert.equal(confirmations.length, count, '確定済み変更の破棄を案内しない');
        assert.equal(document.getElementById('unsaved-changes-overlay'), null);
        assert.equal(appState.views.some(view => view.id === 1), false);
        assert.equal(el('view-manager-overlay').hidden, true);
        await release(); await queue.flushSaveQueue({ silent: true });
        assert.equal(appState.views.some(view => view.id === 1), false);
        assert.equal(calls[0].views[0].operation, 'delete');
    });
    await t.test('削除応答待ちに同名ビューを再作成しても旧構成を復活させず新規IDへ保存する', async () => {
        await reset();
        appState.canvasNotes = [normalizeCanvasNote({ id: 200, view_id: 1, x: 20, y: 30, text: '旧ビューのメモ' })];
        resource.resetResourceBaseline(appState);
        holdNext = true; viewIds = { 3: 30 };
        await manager.deleteSelectedView(); await setImmediate();
        let saving;
        try {
            await manager.addView();
            enter('vm-name', '本館'); enter('vm-memo', '再作成した確定メモ');
            saving = manager.applyViewForm();
            assert.equal(manager.getViewManagerSelectedView().id, 3);
            assert.equal(calls.length, 1);
        } finally {
            await release();
            await Promise.allSettled([saving]);
        }
        assert.equal(await saving, true);
        assert.equal(calls.length, 2);
        assert.equal(calls[0].views[0].operation, 'delete');
        assert.equal(calls[0].views[0].id, 1);
        assert.equal(calls[1].views[0].operation, 'create');
        assert.equal(calls[1].views[0].id, 3);
        assert.equal(appState.views.some(view => view.id === 1 || view.id === 3), false);
        assert.equal(manager.getViewManagerSelectedView().id, 30);
        assert.equal(el('vm-id').value, '30');
        assert.equal(el('vm-name').value, '本館');
        assert.equal(appState.views.find(view => view.id === 30).memo, '再作成した確定メモ');
        assert.equal(appState.placements.length, 0);
        assert.equal(appState.canvasNotes.length, 0);
        assert.equal(appState.devices[0].id, 10, '旧ビュー削除は台帳機器を消さない');
        assert.equal(appState.currentViewId, 2);
        assert.equal(queue.hasPendingChanges(), false);
    });
    await t.test('閉鎖の破棄は未適用DOMだけ、適用済み未保存差分は保持する', async () => {
        await reset(); failStatus = 422; enter('vm-name', '確定名');
        await manager.applyViewForm(); enter('vm-name', '破棄する入力');
        await choose(manager.closeViewManager(), 'discard');
        assert.equal(appState.views[0].name, '確定名');
        assert.equal(queue.hasPendingChanges(), true);
        assert.equal(el('view-manager-overlay').hidden, true);
        manager.openViewManager(); assert.equal(el('vm-name').value, '確定名');
        enter('vm-name', '続ける入力');
        await choose(manager.closeViewManager(), 'cancel'); assert.equal(el('view-manager-overlay').hidden, false);
        assert.equal(el('vm-name').value, '続ける入力');
    });
    await t.test('フロア種別の保存とID再採番が完了した選択ビューだけで図面管理を開く', async () => {
        await reset();
        viewIds = { 3: 30 };
        holdNext = true;
        await manager.addView();
        await setImmediate();
        enter('vm-type', 'floor');
        assert.equal(el('vm-floor-plan-btn').disabled, true);
        const saving = manager.applyViewForm();
        await setImmediate();
        assert.equal(el('vm-floor-plan-btn').disabled, true);
        await manager.openSelectedViewFloorPlan();
        assert.equal(el('floor-plan-manager-overlay').hidden, true);
        await release();
        await saving;
        assert.equal(manager.getViewManagerSelectedView().id, 30);
        assert.equal(manager.getViewManagerSelectedView().view_type, 'floor');
        assert.equal(el('vm-floor-plan-btn').disabled, false);
        assert.equal(appState.currentViewId, 1);

        enter('vm-memo', '未適用の入力');
        assert.equal(el('vm-floor-plan-btn').disabled, true);
        await manager.openSelectedViewFloorPlan();
        assert.equal(appState.currentViewId, 1);
        assert.equal(el('floor-plan-manager-overlay').hidden, true);
        enter('vm-memo', manager.getViewManagerSelectedView().memo);
        await manager.openSelectedViewFloorPlan();
        assert.equal(appState.currentViewId, 30);
        assert.equal(el('floor-plan-manager-overlay').hidden, false);
        assert.equal(el('view-manager-overlay').hidden, true);
        assert.equal(el('floor-plan-manager-view').textContent.includes(appState.views.find(view => view.id === 30).name), true);
        const { closeFloorPlanManager } = await import('../public/js/modals/floor-plan-modal.js');
        closeFloorPlanManager();
    });
    await t.test('追加保存のID再採番は選択ID・フォーム・比較snapshotを追従させる', async () => {
        await reset(); viewIds = { 3: 30 }; holdNext = true;
        await manager.addView(); await setImmediate(); enter('vm-memo', '再採番中の未適用');
        await release(); await queue.flushSaveQueue({ silent: true });
        assert.equal(manager.getViewManagerSelectedView().id, 30);
        assert.equal(el('vm-id').value, '30');
        assert.equal(el('vm-memo').value, '再採番中の未適用');
        assert.equal(appState.viewManagerFormDirty, true);
        assert.equal(manager.hasViewManagerChanges(), false);
    });
    await t.test('長いビュー名を連続複製しても接尾辞込み100文字で一意かつ新規revisionなし', async () => {
        await reset('名'.repeat(100)); holdNext = true;
        await manager.duplicateSelectedView(); await setImmediate();
        const first = manager.getViewManagerSelectedView();
        assert.equal(first.resource_revision, undefined);
        assert.equal(Array.from(first.name).length, 100);
        assert.ok(first.name.endsWith(' のコピー'));
        await select(1); await manager.duplicateSelectedView();
        const second = manager.getViewManagerSelectedView();
        assert.equal(second.resource_revision, undefined);
        assert.equal(Array.from(second.name).length, 100);
        assert.ok(second.name.endsWith(' のコピー2'));
        assert.notEqual(first.name, second.name);
        viewIds = { 3: 30, 4: 40 }; placementIds = { 101: 110, 102: 120 };
        await release(); await queue.flushSaveQueue({ silent: true });
        assert.equal(calls[0].views[0].id, 3);
        assert.equal(calls[1].views[0].id, 4, '未送信の二つ目の複製は次リクエストまで仮IDのまま');
        assert.equal(appState.views.some(view => view.id === 30), true);
        assert.equal(appState.views.some(view => view.id === 40), true);
        assert.equal(appState.placements.some(item => item.id === 110 && item.view_id === 30), true);
        assert.equal(appState.placements.some(item => item.id === 120 && item.view_id === 40), true);
        assert.equal(queue.hasPendingChanges(), false);
    });
    await t.test('競合ビューの適用を成功扱いせず別ビューは保存でき対象再読込で解除する', async () => {
        await reset(); failStatus = 409; enter('vm-name', '競合入力');
        assert.equal(await manager.applyViewForm(), false);
        assert.equal(el('view-conflict-reload-btn').hidden, false);
        const count = calls.length;
        assert.equal(await manager.applyViewForm(), false);
        assert.equal(calls.length, count);
        await select(2); failStatus = 0; enter('vm-memo', '別ビュー確定');
        assert.equal(await manager.applyViewForm(), true);
        assert.equal(calls.at(-1).views.some(view => view.id === 1), false);
        serverData = { revision: 5, devices: appState.devices, placements: appState.placements, links: [],
            views: appState.views.map(view => view.id === 1 ? { ...view, name: 'サーバー名', resource_revision: 2 } : view) };
        await select(1); assert.equal(await manager.reloadSelectedViewConflict(), true);
        assert.equal(el('vm-name').value, 'サーバー名');
        assert.equal(queue.hasResourceConflict('views', 1), false);
        assert.equal(appState.views.find(view => view.id === 2).memo, '別ビュー確定');
    });
    const pointer = (x, y) => ({ button: 0, pointerId: 7, clientX: x, clientY: y,
        target: new DomElement(), preventDefault() {}, stopPropagation() {} });
    const prepareCanvas = () => {
        appState.canvas = new DomElement('canvas'); appState.world = new DomElement('world');
        appState.currentSvg = new DomElement('svg'); appState.deviceLayer = new DomElement('devices');
        appState.floorPlanLayer = new DomElement('floor');
        render();
    };
    await t.test('pointerdown後の保存応答・再描画がplacementを置換しても次のmoveは現行モデルに反映', async () => {
        await reset(); prepareCanvas();
        appState.views[0].memo = '保存中'; holdNext = true;
        const saving = queue.flushSaveQueue({ silent: true }); await setImmediate();
        const oldPlacement = appState.placements[0]; const oldElement = appState.deviceLayer.children[0];
        await oldElement.dispatch('pointerdown', pointer(0, 0));
        await release(); await saving;
        assert.notEqual(appState.placements[0], oldPlacement);
        assert.notEqual(appState.deviceLayer.children[0], oldElement);
        await docEvents.dispatch('pointermove', pointer(40, 30));
        assert.equal(appState.placements[0].x, 140); assert.equal(appState.placements[0].y, 130);
        assert.equal(appState.deviceLayer.children[0].style.transform, 'translate(140px, 130px)');
        assert.equal(appState.deviceLayer.children[0].classList.contains('dragging'), true);
        await docEvents.dispatch('pointerup', pointer(40, 30)); await queue.flushSaveQueue({ silent: true });
        assert.equal(calls.at(-1).views[0].placements[0].x, 140);
    });
    await t.test('ドラッグ中の配置ID再採番は開始座標と選択を維持、対象消失は安全終了', async () => {
        await reset();
        resource.resetResourceBaseline({ ...appState, placements: [] });
        prepareCanvas(); holdNext = true; placementIds = { 100: 500 };
        const saving = queue.flushSaveQueue({ silent: true }); await setImmediate();
        await appState.deviceLayer.children[0].dispatch('pointerdown', pointer(0, 0));
        await docEvents.dispatch('pointermove', pointer(10, 10));
        await release(); await saving;
        assert.equal(appState.placements[0].id, 500);
        await docEvents.dispatch('pointermove', pointer(50, 40));
        assert.equal(appState.placements[0].x, 150); assert.equal(appState.placements[0].y, 140);
        assert.equal(appState.selectedPlacementIds.has(500), true);
        const stalePlacement = appState.placements[0];
        appState.placements = []; render();
        await docEvents.dispatch('pointermove', pointer(100, 100));
        assert.equal(stalePlacement.x, 150);
        assert.equal(docEvents.listeners.get('pointermove').size, 0);
        assert.equal(appState.canvas.hasPointerCapture(7), false);
        await queue.flushSaveQueue({ silent: true });
    });
    await t.test('配置選択に変更がなければ閉鎖時の確認や保存はしない', async () => {
        await reset();
        placementManager.openPlacementManager(10);
        assert.equal(await placementManager.closePlacementManager(), true);
        assert.equal(el('placement-manager-overlay').hidden, true);
        assert.equal(confirmations.length, 0);
        assert.equal(document.getElementById('unsaved-changes-overlay'), null);
        assert.equal(calls.length, 0);
    });
    await t.test('配置選択の閉鎖は未反映変更のキャンセル・破棄を区別する', async () => {
        await reset();
        placementManager.openPlacementManager(10);
        const checkbox = placementManager.createPlacementManagerOption(appState.views[1], false).children[0];
        checkbox.checked = true;
        await checkbox.dispatch('change');
        assert.equal(await choose(placementManager.closePlacementManager(), 'cancel'), false);
        assert.equal(el('placement-manager-overlay').hidden, false);
        assert.deepEqual(placementManager.getPlacementManagerChanges().addedViewIds, [2]);
        assert.deepEqual(appState.placements.map(row => row.view_id), [1]);
        assert.equal(calls.length, 0);
        assert.equal(await choose(placementManager.closePlacementManager(), 'discard'), true);
        assert.equal(el('placement-manager-overlay').hidden, true);
        assert.deepEqual(appState.placements.map(row => row.view_id), [1]);
        assert.equal(calls.length, 0);
    });
    await t.test('配置選択を反映して閉じると追加保存操作なしで送信する', async () => {
        await reset();
        placementManager.openPlacementManager(10);
        const checkbox = placementManager.createPlacementManagerOption(appState.views[1], false).children[0];
        checkbox.checked = true;
        await checkbox.dispatch('change');
        assert.equal(await choose(placementManager.closePlacementManager(), 'save'), true);
        assert.equal(el('placement-manager-overlay').hidden, true);
        assert.equal(confirmations.length, 0);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].views[0].id, 2);
        assert.equal(calls[0].views[0].placements[0].device_id, 10);
        await queue.flushSaveQueue({ silent: true });
        assert.deepEqual(appState.placements.map(row => row.view_id).sort(), [1, 2]);
        assert.equal(queue.hasPendingChanges(), false);
    });
    await t.test('閉鎖時に反映を選んでも配置・リンク削除の確認取消なら入力を保持する', async () => {
        await reset();
        appState.devices.push({ id: 11, resource_revision: 1, name: 'SW2', type: 'switch', ip: '' });
        appState.placements.push({ id: 101, device_id: 11, view_id: 1, x: 200, y: 100 });
        appState.links = [{ id: 200, view_id: 1, from_id: 10, to_id: 11, label: '', from_port: '', to_port: '', vlan: '', memo: '' }];
        resource.resetResourceBaseline(appState);
        placementManager.openPlacementManager(10);
        const checkbox = placementManager.createPlacementManagerOption(appState.views[0], false).children[0];
        checkbox.checked = false;
        await checkbox.dispatch('change');
        answers = [false];
        assert.equal(await choose(placementManager.closePlacementManager(), 'save'), false);
        assert.equal(el('placement-manager-overlay').hidden, false);
        assert.deepEqual(placementManager.getPlacementManagerChanges().removedViewIds, [1]);
        assert.deepEqual(appState.placements.map(row => row.id), [100, 101]);
        assert.deepEqual(appState.links.map(row => row.id), [200]);
        assert.equal(calls.length, 0);
        answers = [true];
        assert.equal(await choose(placementManager.closePlacementManager(), 'save'), true);
        assert.equal(calls.length, 1);
        await queue.flushSaveQueue({ silent: true });
        assert.deepEqual(appState.placements.map(row => row.device_id), [11]);
        assert.deepEqual(appState.links, []);
    });

    await t.test('ビュー複製はメモ本文と装飾を新規IDで保存し原本と参照を共有しない', async () => {
        await reset();
        appState.canvasNotes = [normalizeCanvasNote({ id: 50, view_id: 1, text: '  原本\n本文  ', x: 45, width: 320, background_color: '#123456', font_size: 20 })];
        appState.nextCanvasNoteId = 51;
        resource.resetResourceBaseline(appState);
        await manager.duplicateSelectedView();
        await queue.flushSaveQueue({ silent: true });
        const payload = calls[0].views.find(row => row.operation === 'create');
        assert.equal(payload.canvas_notes[0].id, 51);
        assert.equal(payload.canvas_notes[0].view_id, payload.id);
        assert.equal(payload.canvas_notes[0].text, '  原本\n本文  ');
        assert.equal(payload.canvas_notes[0].width, 320);
        assert.equal(payload.canvas_notes[0].background_color, '#123456');
        const copied = appState.canvasNotes.find(note => note.id === 1051);
        assert.ok(copied);
        copied.text = '複製後の編集';
        assert.equal(appState.canvasNotes.find(note => note.id === 50).text, '  原本\n本文  ');
    });

    await t.test('ビュー切替成立時のメモ終了通知は旧ビューで確定し選択とモードを解除する', async () => {
        await reset();
        appState.canvasNotes = [normalizeCanvasNote({ id: 50, view_id: 1, text: '保存前' })];
        resource.resetResourceBaseline(appState);
        appState.noteMode = true;
        appState.selectedCanvasNoteId = 50;
        const observed = [];
        const off = eventBus.on('canvas-note:finish', () => {
            observed.push(appState.currentViewId);
            appState.canvasNotes[0].text = '切替時の確定本文';
        });
        try {
            assert.equal(await manager.switchView(2), true);
            await queue.flushSaveQueue({ silent: true });
            assert.deepEqual(observed, [1]);
            assert.equal(appState.currentViewId, 2);
            assert.equal(appState.noteMode, false);
            assert.equal(appState.selectedCanvasNoteId, null);
            assert.equal(calls[0].views[0].id, 1);
            assert.equal(calls[0].views[0].canvas_notes[0].text, '切替時の確定本文');
        } finally { off(); }
    });

    await t.test('ビュー削除はそのメモだけを消し別ビューのメモと機器を残す', async () => {
        await reset();
        appState.canvasNotes = [normalizeCanvasNote({ id: 50, view_id: 1, text: '削除対象' }), normalizeCanvasNote({ id: 51, view_id: 2, text: '保持対象' })];
        appState.selectedCanvasNoteId = 50;
        resource.resetResourceBaseline(appState);
        await manager.deleteSelectedView();
        await queue.flushSaveQueue({ silent: true });
        assert.deepEqual(appState.canvasNotes.map(note => [note.id, note.text]), [[51, '保持対象']]);
        assert.equal(appState.selectedCanvasNoteId, null);
        assert.equal(appState.devices[0].id, 10);
        assert.ok(confirmations.some(message => message.includes('メモ: 1件')));
    });
});
