import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';

// 実controller・renderer・保存キューをDOM代替から操作し、確定境界を確認する。
test('キャンバスメモの作成・編集・座標・保存・権限', async t => {
    const keys = ['window', 'document', 'Element', 'HTMLElement', 'fetch', 'confirm'];
    const originals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const toolbarTemplate = await readFile(new URL('../templates/components/canvas_context_toolbar.php', import.meta.url), 'utf8');
    class Node {
        constructor(tagName = 'DIV', id = '') {
            this.tagName = tagName.toUpperCase(); this.id = id; this.dataset = {}; this.children = [];
            this.attributes = new Map(); this.listeners = new Map(); this.classes = new Set(); this.style = {};
            this.hidden = false; this.disabled = false; this.value = ''; this.textContent = ''; this.captures = new Set();
            this.classList = { add: (...names) => names.forEach(n => this.classes.add(n)),
                remove: (...names) => names.forEach(n => this.classes.delete(n)), contains: n => this.classes.has(n),
                toggle: (n, force) => { if (force) this.classes.add(n); else this.classes.delete(n); } };
        }
        set className(value) { this.classes = new Set(value.split(/\s+/)); }
        get className() { return [...this.classes].join(' '); }
        setAttribute(name, value) { this.attributes.set(name, String(value)); }
        getAttribute(name) { return this.attributes.get(name) ?? null; }
        removeAttribute(name) { this.attributes.delete(name); }
        appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
        append(...children) { children.forEach(child => this.appendChild(child)); }
        replaceChildren(...children) { this.children.forEach(child => { child.parentElement = null; }); this.children = []; this.append(...children); }
        replaceWith(child) { const parent = this.parentElement; parent.children[parent.children.indexOf(this)] = child; child.parentElement = parent; this.parentElement = null; }
        remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); }
        contains(node) { return this === node || this.children.some(child => child.contains(node)); }
        matches(selector) {
            if (selector === '*') return true;
            if (selector === '[data-canvas-context]') return this.dataset.canvasContext != null;
            if (selector === '[data-color]') return this.dataset.color != null;
            if (selector === 'button:not(:disabled)') return this.tagName === 'BUTTON' && !this.disabled;
            if (selector.startsWith('#')) return this.id === selector.slice(1);
            if (selector.startsWith('.')) return this.classes.has(selector.slice(1));
            const noteId = selector.match(/^\[data-note-id="(\d+)"\]$/)?.[1];
            if (noteId != null) return this.dataset.noteId === noteId;
            return this.tagName.toLowerCase() === selector;
        }
        querySelectorAll(selector) { return this.children.flatMap(child => [child, ...child.querySelectorAll('*')]).filter(child => child.matches(selector)); }
        querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
        closest(selector) { if (selector.split(',').some(part => this.matches(part.trim()))) return this; return this.parentElement?.closest(selector) ?? null; }
        addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
        removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
        async dispatch(type, values = {}) {
            const event = { type, target: this, button: 0, pointerId: 1, clientX: 0, clientY: 0,
                preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {}, ...values };
            for (const fn of this.listeners.get(type) ?? []) await fn(event);
        }
        async typeText(text) {
            // ブラウザの入力上限はUTF-16コード単位。直接valueを代入する操作とは区別する。
            this.value = this.maxLength >= 0 ? text.slice(0, this.maxLength) : text;
            await this.dispatch('input');
        }
        focus() { const before = document.activeElement; document.activeElement = this; if (before !== this) before?.dispatch('blur'); }
        setPointerCapture(id) { this.captures.add(id); }
        hasPointerCapture(id) { return this.captures.has(id); }
        releasePointerCapture(id) { this.captures.delete(id); }
        getBoundingClientRect() { return { left: 10, top: 20, width: 1000, height: 700, right: 1010, bottom: 720 }; }
    }
    const elements = new Map();
    const docEvents = new Node();
    globalThis.Element = globalThis.HTMLElement = Node;
    globalThis.document = { body: new Node(), activeElement: null, getElementById: id => elements.get(id) ?? null,
        querySelector: () => null, querySelectorAll: () => [], createElement: tag => new Node(tag), createElementNS: (_ns, tag) => new Node(tag),
        addEventListener: docEvents.addEventListener.bind(docEvents), removeEventListener: docEvents.removeEventListener.bind(docEvents) };
    globalThis.window = { APP_CONFIG: { user: { isAdmin: true }, csrfToken: 'test' }, clearTimeout,
        setTimeout(fn, delay) { const timer = setTimeout(fn, delay); timer.unref(); return timer; },
        requestAnimationFrame: fn => fn(), getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) };
    globalThis.confirm = window.confirm = () => true;
    const { appState } = await import('../public/js/core/state.js');
    const resource = await import('../public/js/core/resource-save.js');
    const queue = await import('../public/js/core/save-queue.js');
    const notes = await import('../public/js/canvas/canvas-notes.js');
    const renderer = await import('../public/js/canvas/renderer.js');
    const { onKeyDown } = await import('../public/js/canvas/selection.js');
    const { eventBus } = await import('../public/js/core/event-bus.js');
    const { showCanvasContextToolbar } = await import('../public/js/ui/canvas-context-toolbar.js');
    const { restoreCurrentViewState } = await import('../public/js/canvas/pan-zoom.js');
    const { enterPlacementMode, exitPlacementMode } = await import('../public/js/ui/placement-mode.js');
    let requests = [], fail = false, hold = false, release = null;
    globalThis.fetch = async (_url, options) => {
        const payload = JSON.parse(options.body); requests.push(payload);
        if (hold) { hold = false; await new Promise(resolve => { release = resolve; }); }
        if (fail) return new Response(JSON.stringify({ ok: false, error: '競合', details: { conflicts: [{ kind: 'views', id: 1 }] } }), { status: 409 });
        return new Response(JSON.stringify({ ok: true, revision: requests.length + 1, saved_at: '2026-10-06T00:00:00Z',
            id_maps: { devices: {}, views: {}, placements: {}, links: {}, canvas_notes: Object.fromEntries(payload.views.flatMap(v => v.canvas_notes ?? []).map(n => [n.id, n.id])) },
            devices: [], views: payload.views.map(v => ({ ...v.view, resource_revision: (v.expected_revision || 0) + 1 })),
            placements: [], links: [], canvas_notes: payload.views.flatMap(v => v.canvas_notes ?? []),
            rack_settings: payload.views.flatMap(v => v.rack_settings ? [v.rack_settings] : []),
            rack_mounts: payload.views.flatMap(v => v.rack_mounts || []),
            affected_view_ids: payload.views.map(v => v.id), deleted_device_ids: [], deleted_view_ids: [] }));
    };
    const element = id => elements.get(id);
    const settle = async () => { await queue.flushSaveQueue({ silent: true }); await setImmediate(); };
    function setup() {
        notes.finishCanvasNotes(); exitPlacementMode(); queue.clearPendingSave(); elements.clear(); requests = [];
        fail = false; hold = false; release = null; document.activeElement = null; window.APP_CONFIG.user.isAdmin = true;
        Object.assign(appState, { views: [{ id: 1, resource_revision: 1, name: '試験', view_type: 'topology' }], devices: [], placements: [], links: [],
            canvasNotes: [], floorPlans: [], currentViewId: 1, selectedCanvasNoteId: null, nextCanvasNoteId: 1, noteMode: false,
            editingDeviceId: null, editingLinkId: null, linkMode: false, floorPlanAdjustMode: false, authExpired: false, isPinging: false,
            resourceConflicts: { views: new Map(), devices: new Map() }, appStatus: { dirty: false, state: 'saved' }, viewStates: new Map() });
        appState.selectedPlacementIds.clear(); Object.assign(appState.viewState, { scale: 1, panX: 0, panY: 0 });
        for (const id of ['canvas', 'world', 'canvas-note-layer', 'device-layer', 'floor-plan-layer', 'link-layer', 'canvas-context-toolbar', 'toast']) elements.set(id, new Node('div', id));
        for (const id of ['palette-note-btn', 'palette-view-btn', 'note-delete-btn', 'note-finish-btn']) elements.set(id, new Node('button', id));
        for (const id of ['note-opacity', 'note-font-size']) elements.set(id, new Node('input', id));
        for (const id of ['note-background-color', 'note-text-color']) {
            const control = new Node(); control.className = 'canvas-note-color-control';
            const trigger = new Node('button', id); trigger.className = 'canvas-note-color-trigger';
            trigger.setAttribute('aria-expanded', 'false');
            const swatch = new Node('span'); swatch.className = 'canvas-note-color-swatch'; trigger.appendChild(swatch);
            const menu = new Node('div', `${id}-options`); menu.hidden = true; menu.className = 'canvas-note-color-options';
            const markup = toolbarTemplate.match(new RegExp(`<div id="${id}-options"[^>]*>([\\s\\S]*?)</div>`))[1];
            for (const match of markup.matchAll(/<button ([^>]*)><\/button>/g)) {
                const option = new Node('button'); option.className = 'canvas-note-color-option';
                option.dataset.color = match[1].match(/data-color="([^"]*)"/)[1];
                option.setAttribute('aria-label', match[1].match(/aria-label="([^"]*)"/)[1]);
                option.setAttribute('aria-checked', 'false'); option.style.backgroundColor = option.dataset.color;
                menu.appendChild(option);
            }
            control.append(trigger, menu); elements.set(id, trigger); elements.set(`${id}-options`, menu);
        }
        elements.set('note-opacity-value', new Node('output'));
        for (const context of ['canvas-note', 'floor-plan', 'link-route']) {
            const panel = new Node(); panel.dataset.canvasContext = context; panel.setAttribute('aria-label', context); panel.hidden = true;
            if (context === 'canvas-note') panel.append(element('note-background-color').parentElement, element('note-text-color').parentElement);
            panel.append(element('note-delete-btn'), element('note-finish-btn')); element('canvas-context-toolbar').append(panel);
        }
        Object.assign(appState, { canvas: element('canvas'), world: element('world'), noteLayer: element('canvas-note-layer'),
            deviceLayer: element('device-layer'), floorPlanLayer: element('floor-plan-layer'), currentSvg: element('link-layer') });
        resource.resetResourceBaseline(appState);
        // 毎回新しいdocumentで初期化したことと同等に、イベント対象も新しくする。
        document = { ...document }; notes.initCanvasNotes();
        appState.suppressNextClick = false;
    }
    const currentElement = () => appState.noteLayer.children[0];
    const key = (key, target, fields = {}) => onKeyDown({ key, target, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {}, ...fields });
    const colorOptions = id => element(`${id}-options`).querySelectorAll('[data-color]');
    async function chooseColor(id, value) {
        await element(id).dispatch('click');
        await colorOptions(id).find(option => option.dataset.color === value).dispatch('click');
    }
    async function create(text = '注記\n2行目') {
        await notes.toggleCanvasNoteMode(); await renderer.onCanvasClick({ target: appState.canvas, clientX: 110, clientY: 120 });
        const textarea = currentElement().querySelector('textarea'); textarea.value = text;
        await key('Enter', textarea, { ctrlKey: true }); await settle(); return appState.canvasNotes[0];
    }
    t.after(async () => { release?.(); await settle(); notes.finishCanvasNotes(); queue.clearPendingSave();
        for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });

    await t.test('補助平面文字も1000文字まで入力・保存でき、1001文字は保存せず入力を保持する', async () => {
        setup(); await notes.toggleCanvasNoteMode();
        await renderer.onCanvasClick({ target: appState.canvas, clientX: 110, clientY: 120 });
        const textarea = currentElement().querySelector('textarea');
        const text = '𠀀'.repeat(1000);
        await textarea.typeText(text);
        await key('Enter', textarea, { ctrlKey: true }); await settle();
        assert.equal(requests[0].views[0].canvas_notes[0].text, text);
        assert.equal(appState.canvasNotes[0].text, text);
        notes.beginCanvasNoteText();
        const oversized = currentElement().querySelector('textarea');
        await oversized.typeText(text + '𠀀');
        await key('Enter', oversized, { ctrlKey: true }); await settle();
        assert.equal(requests.length, 1);
        assert.equal(appState.canvasNotes[0].text, text + '𠀀');
        notes.beginCanvasNoteText();
        const corrected = currentElement().querySelector('textarea');
        await corrected.typeText(text.slice(2));
        await key('Enter', corrected, { ctrlKey: true }); await settle();
        assert.equal(requests.at(-1).views[0].canvas_notes[0].text, text.slice(2));
    });
    await t.test('新規入力を直ちに開始し、入力中のDelete/Ctrl+K/IMEをcanvasへ渡さず確定時だけ保存', async () => {
        setup(); await notes.toggleCanvasNoteMode();
        Object.assign(appState.viewState, { scale: 0.5, panX: 50, panY: 30 });
        await renderer.onCanvasClick({ target: appState.canvas, clientX: 110, clientY: 120 });
        const textarea = currentElement().querySelector('textarea'); assert.equal(document.activeElement, textarea);
        assert.equal(appState.noteMode, true); assert.deepEqual([appState.canvasNotes[0].x, appState.canvasNotes[0].y], [100, 140]);
        textarea.value = '<img src=x onerror=alert(1)>\n<script>危険</script>';
        await key('Delete', textarea); await key('k', textarea, { ctrlKey: true }); await key('Enter', textarea, { isComposing: true });
        assert.equal(appState.canvasNotes.length, 1); assert.equal(requests.length, 0); assert.equal(appState.canvasNotes[0].text, '');
        await key('Enter', textarea, { ctrlKey: true }); await settle();
        assert.equal(requests.length, 1); assert.equal(requests[0].views[0].canvas_notes[0].text, textarea.value);
        assert.equal(currentElement().querySelector('.canvas-note-text').textContent, textarea.value);
        assert.equal(currentElement().querySelector('textarea'), null);
        await renderer.onCanvasClick({ target: appState.canvas, clientX: 250, clientY: 200 });
        assert.equal(appState.canvasNotes.length, 2); assert.equal(appState.noteMode, true);
        const before = appState.canvasNotes.length;
        for (const target of [currentElement(), element('note-finish-btn'), new Node('input')]) await renderer.onCanvasClick({ target, clientX: 300, clientY: 300 });
        assert.equal(appState.canvasNotes.length, before);
        await key('Escape', document.activeElement); await settle(); assert.equal(appState.noteMode, false);
    });
    await t.test('保存中の再描画でも本文下書きとフォーカスを保持しblurで確定', async () => {
        setup(); const note = await create('元');
        hold = true;
        await chooseColor('note-text-color', '#1D4ED8');
        await setImmediate();
        assert.equal(appState.isSaving, true);
        notes.beginCanvasNoteText();
        const textarea = currentElement().querySelector('textarea'); textarea.value = '保存応答中の本文';
        renderer.render(); eventBus.emit('save-state:changed'); assert.equal(document.activeElement, textarea);
        assert.equal(currentElement().querySelector('textarea'), textarea); assert.equal(note.text, '元');
        release(); await settle();
        assert.equal(currentElement().querySelector('textarea'), textarea);
        assert.equal(textarea.value, '保存応答中の本文');
        assert.equal(appState.canvasNotes[0].text, '元');
        await textarea.dispatch('blur'); await settle(); assert.equal(appState.canvasNotes[0].text, '保存応答中の本文');
    });
    await t.test('移動previewは未保存、pan/zoom後のpointerupで確定し負座標を保存しない', async () => {
        setup(); await create(); const before = requests.length;
        await currentElement().querySelector('.canvas-note-header').dispatch('pointerdown', { clientX: 110, clientY: 120 });
        await docEvents.dispatch('pointermove', { clientX: 210, clientY: 220 });
        assert.equal(appState.canvasNotes[0].x, 100); assert.equal(requests.length, before); assert.equal(currentElement().style.left, '200px');
        Object.assign(appState.viewState, { scale: 0.5, panX: 50, panY: 30 });
        await docEvents.dispatch('pointerup', { clientX: 10, clientY: 20 }); await settle();
        assert.deepEqual([appState.canvasNotes[0].x, appState.canvasNotes[0].y], [0, 0]); assert.equal(requests.length, before + 1);
        await currentElement().querySelector('.canvas-note-header').dispatch('pointerdown', { clientX: 100, clientY: 100 });
        await docEvents.dispatch('pointermove', { pointerId: 2, clientX: 900, clientY: 900 });
        await docEvents.dispatch('pointercancel'); assert.equal(appState.canvasNotes[0].x, 0);
    });
    await t.test('resizeは最小・最大を制限しpointermove非保存、pointercancelで戻す', async () => {
        setup(); await create(); const before = requests.length;
        await currentElement().querySelector('.canvas-note-resize').dispatch('pointerdown', { clientX: 100, clientY: 100 });
        await docEvents.dispatch('pointermove', { clientX: -1000, clientY: -1000 });
        assert.equal(currentElement().style.width, '120px'); assert.equal(currentElement().style.height, '60px'); assert.equal(requests.length, before);
        await docEvents.dispatch('pointerup', { clientX: -1000, clientY: -1000 }); await settle();
        assert.deepEqual([appState.canvasNotes[0].width, appState.canvasNotes[0].height], [120, 60]);
        await currentElement().querySelector('.canvas-note-resize').dispatch('pointerdown', { clientX: 0, clientY: 0 });
        await docEvents.dispatch('pointermove', { clientX: 5000, clientY: 5000 }); assert.equal(currentElement().style.width, '2000px');
        await docEvents.dispatch('pointercancel'); assert.equal(currentElement().style.width, '120px');
    });
    await t.test('背景のみ透明化、色選択と数値changeで保存し連続inputは保存しない', async () => {
        setup(); await create(); const before = requests.length;
        const opacity = element('note-opacity'); opacity.value = '20'; await opacity.dispatch('input');
        assert.equal(currentElement().style.backgroundColor, 'rgba(255, 243, 176, 0.2)'); assert.equal(currentElement().style.opacity, undefined);
        assert.equal(requests.length, before); await opacity.dispatch('change'); await settle();
        for (const [id, value, field] of [['note-background-color', '#DBEAFE', 'background_color'], ['note-font-size', '32', 'font_size'], ['note-text-color', '#B91C1C', 'text_color']]) {
            if (field.endsWith('_color')) await chooseColor(id, value);
            else {
                const input = element(id); input.value = value; const count = requests.length;
                await input.dispatch('input'); assert.equal(requests.length, count); await input.dispatch('change');
            }
            await settle();
            assert.equal(appState.canvasNotes[0][field], field === 'font_size' ? 32 : value.toUpperCase());
        }
        assert.equal(appState.canvasNotes[0].background_opacity, 0.2);
    });
    await t.test('候補外の既存色を四角に表示し、開閉では変えず選び直した色だけ保存する', async () => {
        setup(); const note = await create();
        note.background_color = '#123456'; note.text_color = '#654321';
        resource.resetResourceBaseline(appState); notes.renderCanvasNotes();
        const background = element('note-background-color'), text = element('note-text-color');
        assert.equal(background.querySelector('.canvas-note-color-swatch').style.backgroundColor, '#123456');
        assert.equal(text.querySelector('.canvas-note-color-swatch').style.backgroundColor, '#654321');
        const before = requests.length;
        await background.dispatch('click'); await key('Escape', document.activeElement); await settle();
        assert.equal(requests.length, before);
        assert.deepEqual([note.background_color, note.text_color], ['#123456', '#654321']);
        await chooseColor('note-background-color', '#FCE7F3'); await settle();
        const saved = requests.at(-1).views[0].canvas_notes[0];
        assert.deepEqual([saved.background_color, saved.text_color], ['#FCE7F3', '#654321']);
        text.focus(); await key('Delete', text);
        assert.equal(appState.canvasNotes[0].id, note.id);
        await chooseColor('note-text-color', '#B91C1C'); await settle();
        const recolored = requests.at(-1).views[0].canvas_notes[0];
        assert.deepEqual([recolored.background_color, recolored.text_color], ['#FCE7F3', '#B91C1C']);
    });
    await t.test('色の矢印移動は未確定で、Enterで保存しEsc・外側・Tab・context終了で閉じる', async () => {
        setup(); await create(); const before = requests.length;
        const background = element('note-background-color'), text = element('note-text-color');
        const menu = element('note-background-color-options'), options = colorOptions('note-background-color');
        await background.dispatch('keydown', { key: 'ArrowDown' });
        assert.equal(document.activeElement, options[0]); assert.equal(menu.hidden, false);
        await options[0].dispatch('keydown', { key: 'ArrowRight' });
        assert.equal(document.activeElement, options[1]); assert.equal(requests.length, before);
        await options[1].dispatch('keydown', { key: 'Enter' }); await settle();
        assert.equal(appState.canvasNotes[0].background_color, options[1].dataset.color);
        assert.equal(menu.hidden, true); assert.equal(document.activeElement, background);
        assert.equal(options[1].getAttribute('aria-checked'), 'true');
        await background.dispatch('click'); await key('Escape', document.activeElement);
        assert.equal(menu.hidden, true); assert.equal(appState.selectedCanvasNoteId, appState.canvasNotes[0].id);
        await background.dispatch('click'); await text.dispatch('click');
        assert.equal(menu.hidden, true); assert.equal(element('note-text-color-options').hidden, false);
        await docEvents.dispatch('pointerdown', { target: appState.canvas });
        assert.equal(element('note-text-color-options').hidden, true);
        await background.dispatch('click'); await document.activeElement.dispatch('keydown', { key: 'Tab' });
        assert.equal(menu.hidden, true);
        await background.dispatch('click'); notes.finishCanvasNotes();
        assert.equal(menu.hidden, true); assert.equal(background.getAttribute('aria-expanded'), 'false');
    });
    await t.test('選択とmode/contextの排他、Escで本文確定とpreview破棄', async () => {
        setup(); await create(); await key('Escape', currentElement());
        await currentElement().dispatch('dblclick'); const textarea = currentElement().querySelector('textarea'); textarea.value = '切替時に確定';
        showCanvasContextToolbar('floor-plan', () => {}); await settle();
        assert.equal(appState.canvasNotes[0].text, '切替時に確定'); assert.equal(appState.selectedCanvasNoteId, null);
        assert.equal(element('canvas-context-toolbar').dataset.activeContext, 'floor-plan');
        await notes.toggleCanvasNoteMode(); await enterPlacementMode(); assert.equal(appState.noteMode, false);
    });
    await t.test('Delete確認の取消・削除とviewerの読取専用、click時に背景色ボタンへフォーカスを奪われない', async () => {
        setup(); await create(); window.confirm = () => false;
        await currentElement().dispatch('click');
        assert.equal(document.activeElement, currentElement());
        await key('Delete', currentElement()); assert.equal(appState.canvasNotes.length, 1);
        window.confirm = () => true; await key('Backspace', currentElement()); await settle(); assert.equal(appState.canvasNotes.length, 0);
        await create('閲覧用'); notes.finishCanvasNotes(); window.APP_CONFIG.user.isAdmin = false;
        const before = requests.length; await currentElement().dispatch('dblclick'); await notes.toggleCanvasNoteMode();
        assert.equal(currentElement().querySelector('textarea'), null); assert.equal(appState.noteMode, false);
        assert.equal(currentElement().querySelector('.canvas-note-text').textContent, '閲覧用');
        await key('Delete', currentElement()); assert.equal(appState.canvasNotes.length, 1); assert.equal(requests.length, before);
    });
    await t.test('409でドラッグpreviewを破棄し確定本文を保持、対象再読込で編集を捨てる', async () => {
        setup(); await create('元'); fail = true; notes.beginCanvasNoteText();
        currentElement().querySelector('textarea').value = '競合した本文'; notes.commitCanvasNoteText(); await settle();
        assert.equal(appState.canvasNotes[0].text, '競合した本文'); assert.equal(queue.hasResourceConflict('views', 1), true);
        const count = requests.length; await currentElement().querySelector('.canvas-note-header').dispatch('pointerdown');
        await docEvents.dispatch('pointermove', { clientX: 500, clientY: 500 }); await docEvents.dispatch('pointerup');
        assert.equal(requests.length, count); assert.equal(appState.canvasNotes[0].x, 100);
        appState.canvasNotes[0].text = '最新'; eventBus.emit('resource:reloaded', { kind: 'views', id: 1 });
        assert.equal(appState.selectedCanvasNoteId, null); assert.equal(currentElement().querySelector('.canvas-note-text').textContent, '最新');
    });
    await t.test('メモだけのFitと初期表示、floor図面優先、保存済み表示を優先', async () => {
        setup(); await create(); appState.canvasNotes[0].x = 10000; appState.canvasNotes[0].y = 8000;
        renderer.fitViewToDevices(); assert.ok(appState.viewState.scale < 0.5); assert.equal(appState.viewState.panX, 0);
        appState.viewState.scale = 1; restoreCurrentViewState(); assert.ok(appState.viewState.scale < 0.5);
        appState.viewStates.set(1, { scale: 0.7, panX: 42, panY: 23 }); restoreCurrentViewState(); assert.equal(appState.viewState.scale, 0.7);
        appState.views[0].view_type = 'floor'; appState.floorPlans = [{ view_id: 1, is_visible: true }];
        let fits = 0; const off = eventBus.on('floor-plan:fit', () => { fits++; }); renderer.fitViewToDevices(); off(); assert.equal(fits, 1);
    });
    function setupRack(existing = []) {
        setup();
        appState.views[0].view_type = 'rack';
        appState.rackSettings = [{ view_id: 1, total_u: 8, location: '' }];
        appState.rackMounts = [];
        appState.canvasNotes = structuredClone(existing);
        appState.nextCanvasNoteId = Math.max(0, ...existing.map(note => note.id)) + 1;
        const area = new Node('div', 'rack-notes-area');
        elements.set('rack-notes-area', area);
        resource.resetResourceBaseline(appState);
        notes.renderCanvasNotes();
        return area;
    }
    const rackSection = (region = 'upper') => element('rack-notes-area').querySelectorAll('.rack-note-region')
        .find(section => section.dataset.region === region);
    const rackEditors = (region = 'upper') => rackSection(region)?.querySelectorAll('.rack-note-editor') || [];
    const rackBlank = (region = 'upper') => rackEditors(region).find(editor => !editor.dataset.noteId);
    await t.test('ラックは常設入力欄から非空入力時だけ作成し、blurで既存キューへ保存する', async () => {
        const area = setupRack();
        assert.equal(area.querySelector('.rack-notes-heading').textContent, 'メモ');
        assert.equal(appState.noteLayer.children.length, 0);
        assert.notEqual(appState.noteLayer.parentElement, area);
        await notes.toggleCanvasNoteMode();
        assert.equal(appState.noteMode, false);
        assert.equal(await notes.createCanvasNote({ target: area, clientX: 100, clientY: 100 }), false);
        const editor = rackBlank();
        editor.focus(); await editor.dispatch('focus'); await editor.typeText('');
        assert.equal(appState.canvasNotes.length, 0);
        assert.equal(requests.length, 0);
        await editor.typeText('ラック注釈\n直接入力');
        assert.equal(appState.canvasNotes.length, 1);
        assert.equal(rackEditors().length, 2);
        assert.equal(document.activeElement, editor);
        assert.equal(appState.selectedCanvasNoteId, null);
        assert.notEqual(element('canvas-context-toolbar').dataset.activeContext, 'canvas-note');
        assert.equal(requests.length, 0);
        eventBus.emit('canvas:view-transformed'); eventBus.emit('save-state:changed');
        assert.equal(rackEditors()[0], editor);
        assert.equal(editor.value, 'ラック注釈\n直接入力');
        await editor.dispatch('blur'); await settle();
        assert.equal(requests.at(-1).views[0].canvas_notes[0].text, editor.value);
        assert.equal(rackEditors()[0], editor);
        assert.equal(appState.rackMounts.length, 0);
    });
    await t.test('複数の既存メモは本文・色・書式・座標を保持し、個別編集とビュー切替に対応する', async () => {
        const { DEFAULT_CANVAS_NOTE } = await import('../public/js/core/canvas-note-data.js');
        const stored = [
            { ...DEFAULT_CANVAS_NOTE, id: 11, view_id: 1, text: '一つ目\n全文', x: 800, y: 900,
                width: 450, height: 250, text_color: '#123456', background_color: '#654321', background_opacity: 0.4, font_size: 32 },
            { ...DEFAULT_CANVAS_NOTE, id: 12, view_id: 1, text: '二つ目', x: 2000, y: 3000 },
            { ...DEFAULT_CANVAS_NOTE, id: 13, view_id: 2, text: '通常ビューのメモ', x: 77, y: 88 }
        ];
        setupRack(stored);
        assert.deepEqual(rackEditors().map(editor => editor.value), ['一つ目\n全文', '二つ目', '']);
        assert.equal(rackEditors()[0].style.fontSize, '32px');
        assert.equal(rackEditors()[0].style.color, '#123456');
        assert.equal(rackEditors()[0].style.backgroundColor, 'rgba(101, 67, 33, 0.4)');
        const editor = rackEditors()[1];
        editor.focus(); await editor.dispatch('focus'); await editor.typeText('二つ目を編集');
        eventBus.emit('canvas:view-transformed'); notes.renderCanvasNotes();
        assert.equal(rackEditors()[1], editor);
        notes.finishCanvasNotes('view'); await settle();
        assert.deepEqual(new Map(appState.canvasNotes.map(note => [Number(note.id), note])),
            new Map(stored.map(note => [note.id, note.id === 12 ? { ...note, text: '二つ目を編集' } : note])));
        const saved = requests.at(-1).views[0].canvas_notes;
        assert.deepEqual(saved.find(note => note.id === 11), stored[0]);
        appState.views.push({ id: 2, resource_revision: 1, view_type: 'topology' });
        appState.currentViewId = 2; notes.renderCanvasNotes();
        assert.equal(rackEditors().length, 0);
        assert.equal(currentElement().querySelector('.canvas-note-text').textContent, '通常ビューのメモ');
        assert.equal(currentElement().style.left, '77px');
        appState.currentViewId = 1; notes.renderCanvasNotes();
        assert.deepEqual(rackEditors().map(editor => editor.value), ['一つ目\n全文', '二つ目を編集', '']);
    });
    await t.test('旧メモが4件以上でも全件を上段に保持し、通常座標を中下段と誤認しない', async () => {
        const { DEFAULT_CANVAS_NOTE } = await import('../public/js/core/canvas-note-data.js');
        const stored = [0, 1, 2, 400, 2400, 9007199254740990].map((x, index) => ({
            ...DEFAULT_CANVAS_NOTE, id: index + 1, view_id: 1, x, y: index % 3, text: `既存${index}`
        }));
        setupRack(stored);
        assert.deepEqual(rackEditors().filter(editor => editor.dataset.noteId).map(editor => editor.value),
            stored.map(note => note.text));
        assert.equal(rackEditors('middle').length, 1);
        assert.equal(rackEditors('lower').length, 1);
        for (const editor of rackEditors().filter(editor => editor.dataset.noteId)) {
            await editor.typeText(`${editor.value}を編集`); await editor.dispatch('blur');
        }
        await settle();
        assert.deepEqual(appState.canvasNotes, stored.map(note => ({ ...note, text: `${note.text}を編集` })));
        assert.equal(requests.at(-1).views[0].canvas_notes.length, stored.length);
    });
    await t.test('3領域は非空だけ追加し、1・42・60Uへの変更と再読込後も固定所属を保持する', async () => {
        const { getRackNoteRegion } = await import('../public/js/core/canvas-note-data.js');
        setupRack();
        assert.deepEqual(element('rack-notes-area').querySelectorAll('.rack-note-region-heading').map(node => node.textContent),
            ['上段', '中段', '下段']);
        const editors = new Map();
        for (const region of ['upper', 'middle', 'lower']) {
            const editor = rackBlank(region); editors.set(region, editor);
            await editor.typeText(' \n\t'); await editor.dispatch('blur');
            assert.equal(appState.canvasNotes.length, editors.size - 1);
            await editor.typeText(`${region}の本文`); await editor.dispatch('blur'); await settle();
            assert.equal(rackEditors(region)[0], editor);
        }
        assert.deepEqual(appState.canvasNotes.map(note => getRackNoteRegion(note).key), ['upper', 'middle', 'lower']);
        const saved = structuredClone(requests.at(-1).views[0].canvas_notes);
        for (const totalU of [1, 42, 60, 1]) {
            appState.rackSettings[0].total_u = totalU;
            notes.renderCanvasNotes();
            for (const [region, editor] of editors) {
                assert.equal(rackEditors(region)[0], editor);
                assert.equal(editor.value, `${region}の本文`);
            }
            assert.equal(appState.rackSettings[0].total_u, totalU);
            assert.deepEqual(appState.canvasNotes, saved);
        }
        appState.canvasNotes = structuredClone(saved);
        eventBus.emit('resources:reloaded');
        for (const region of editors.keys()) assert.equal(rackEditors(region)[0].value, `${region}の本文`);
        for (const region of editors.keys()) {
            const editor = rackEditors(region)[0];
            await editor.typeText(`${region}の追記`); await editor.dispatch('blur'); await settle();
            assert.equal(appState.canvasNotes.find(note => String(note.id) === editor.dataset.noteId).text, `${region}の追記`);
        }
    });
    for (const region of ['upper', 'middle', 'lower']) {
        await t.test(`${region}領域のID再割当・競合・再読込・権限変更は下書きを保護する`, async () => {
            setupRack();
            const editor = rackBlank(region);
            await editor.typeText('保存済み'); await editor.dispatch('blur'); await settle();
            const note = appState.canvasNotes[0], oldId = note.id;
            await editor.typeText('ID再割当前の下書き');
            note.id = 101;
            eventBus.emit('resources:ids-remapped', { canvas_notes: { [oldId]: 101 }, views: {} });
            notes.renderCanvasNotes();
            assert.equal(rackEditors(region)[0], editor);
            assert.equal(editor.dataset.noteId, '101');
            assert.equal(editor.value, 'ID再割当前の下書き');
            resource.resetResourceBaseline(appState);
            notes.commitCanvasNoteText(); await settle();
            assert.equal(requests.at(-1).views[0].canvas_notes[0].text, 'ID再割当前の下書き');
            await editor.typeText('競合した本文'); fail = true;
            notes.commitCanvasNoteText(); await settle();
            assert.equal(queue.hasResourceConflict('views', 1), true);
            assert.equal(editor.readOnly, true);
            assert.ok(['upper', 'middle', 'lower'].every(key => rackBlank(key).hidden));
            appState.canvasNotes[0].text = 'サーバーの最新本文';
            eventBus.emit('resource:reloaded', { kind: 'views', id: 1 });
            assert.equal(rackEditors(region)[0].value, 'サーバーの最新本文');
            appState.resourceConflicts.views.clear(); fail = false;
            resource.resetResourceBaseline(appState); notes.renderCanvasNotes();
            await editor.typeText('権限喪失時の下書き');
            window.APP_CONFIG.user.isAdmin = false; notes.renderCanvasNotes();
            assert.equal(editor.readOnly, true);
            assert.equal(notes.commitCanvasNoteText(), false);
            assert.equal(editor.value, '権限喪失時の下書き');
            const count = appState.canvasNotes.length;
            for (const key of ['upper', 'middle', 'lower']) await rackBlank(key).typeText('禁止された追加');
            assert.equal(appState.canvasNotes.length, count);
            window.APP_CONFIG.user.isAdmin = true; notes.renderCanvasNotes();
            assert.equal(editor.readOnly, false);
            notes.commitCanvasNoteText(); await settle();
            assert.equal(appState.canvasNotes[0].text, '権限喪失時の下書き');
        });
    }
    await t.test('ラック直接入力は保存応答・ID再割当でも下書きとフォーカスを保持する', async () => {
        setupRack();
        const editor = rackBlank();
        editor.focus(); await editor.typeText('保存する本文'); await editor.dispatch('blur'); await settle();
        const note = appState.canvasNotes[0], oldId = note.id;
        hold = true;
        await editor.typeText('応答を待つ本文'); notes.commitCanvasNoteText(); await setImmediate();
        assert.equal(appState.isSaving, true);
        editor.focus(); await editor.dispatch('focus'); await editor.typeText('応答中の下書き');
        release(); await settle();
        assert.equal(editor.value, '応答中の下書き');
        assert.equal(rackEditors()[0], editor);
        appState.canvasNotes[0].id = 101;
        eventBus.emit('resources:ids-remapped', { canvas_notes: { [oldId]: 101 }, views: {} });
        eventBus.emit('save-state:changed');
        assert.equal(rackEditors()[0], editor);
        assert.equal(editor.dataset.noteId, '101');
        assert.equal(editor.value, '応答中の下書き');
        assert.equal(document.activeElement, editor);
        resource.resetResourceBaseline(appState);
        notes.commitCanvasNoteText(); await settle();
        assert.equal(requests.at(-1).views[0].canvas_notes[0].text, '応答中の下書き');
    });
    await t.test('保存応答待ちのメモ下書きは409後のビュー切替でも消えない', async () => {
        const { switchView } = await import('../public/js/modals/view-manager-modal.js');
        setupRack();
        appState.views.push({ ...appState.views[0], id: 2, name: '別ビュー', view_type: 'topology' });
        resource.resetResourceBaseline(appState);
        const editor = rackBlank();
        await editor.typeText('送信した本文'); hold = true;
        notes.commitCanvasNoteText();
        const firstSave = queue.flushSaveQueue({ silent: true }); await setImmediate();
        await editor.typeText('応答待ちに追記した本文');
        fail = true; release(); await firstSave; await settle();
        assert.equal(queue.hasResourceConflict('views', 1), true);
        assert.equal(editor.value, '応答待ちに追記した本文');
        assert.equal(await switchView(2), true);
        assert.equal(appState.canvasNotes[0].text, '応答待ちに追記した本文');
        assert.equal(await switchView(1), true);
        assert.equal(rackEditors()[0].value, '応答待ちに追記した本文');
        assert.equal(requests.length, 1, '競合中のビューを再送しない');
        appState.resourceConflicts.views.clear(); fail = false; notes.renderCanvasNotes();
        await rackEditors()[0].typeText('権限変更で確定できない本文');
        window.APP_CONFIG.user.isAdmin = false;
        assert.equal(await switchView(2), false);
        assert.equal(appState.currentViewId, 1);
        assert.equal(rackEditors()[0].value, '権限変更で確定できない本文');
        window.APP_CONFIG.user.isAdmin = true; notes.commitCanvasNoteText(); await settle();
    });
    await t.test('ラックの1000文字検証と競合・再読込・権限変更は既存保存契約を維持する', async () => {
        setupRack();
        const editor = rackBlank(), text = '𠀀'.repeat(1000);
        await editor.typeText(text); notes.commitCanvasNoteText(); await settle();
        assert.equal(requests.at(-1).views[0].canvas_notes[0].text, text);
        await editor.typeText(text + '𠀀'); notes.commitCanvasNoteText(); await settle();
        assert.equal(requests.length, 1);
        assert.equal(editor.value, text + '𠀀');
        await editor.typeText('競合する本文'); fail = true;
        notes.commitCanvasNoteText(); await settle();
        assert.equal(queue.hasResourceConflict('views', 1), true);
        assert.equal(editor.readOnly, true);
        assert.equal(editor.value, '競合する本文');
        assert.equal(rackBlank().hidden, true);
        appState.canvasNotes[0].text = '再読込した最新本文';
        eventBus.emit('resource:reloaded', { kind: 'views', id: 1 });
        assert.equal(rackEditors()[0].value, '再読込した最新本文');
        appState.resourceConflicts.views.clear(); fail = false;
        resource.resetResourceBaseline(appState); notes.renderCanvasNotes();
        await editor.typeText('権限変更時の下書き');
        window.APP_CONFIG.user.isAdmin = false; notes.renderCanvasNotes();
        assert.equal(editor.readOnly, true);
        assert.equal(notes.commitCanvasNoteText(), false);
        assert.equal(editor.value, '権限変更時の下書き');
        window.APP_CONFIG.user.isAdmin = true; notes.renderCanvasNotes();
        assert.equal(editor.readOnly, false);
        notes.commitCanvasNoteText(); await settle();
        assert.equal(appState.canvasNotes[0].text, '権限変更時の下書き');
        window.APP_CONFIG.user.isAdmin = false; notes.renderCanvasNotes();
        const before = requests.length;
        await rackBlank().typeText('保存できない');
        assert.equal(appState.canvasNotes.length, 1);
        assert.equal(requests.length, before);
    });
    await t.test('ラックメモの個別削除は上中下段で動作し、確認・取消・権限・競合・非同期blur復活防止を守る', async () => {
        const { DEFAULT_CANVAS_NOTE, RACK_NOTE_REGION_X } = await import('../public/js/core/canvas-note-data.js');
        const stored = [
            { ...DEFAULT_CANVAS_NOTE, id: 1, view_id: 1, x: 0, y: 0, text: '上段メモ1' },
            { ...DEFAULT_CANVAS_NOTE, id: 2, view_id: 1, x: 0, y: 0, text: '上段メモ2' },
            { ...DEFAULT_CANVAS_NOTE, id: 3, view_id: 1, x: RACK_NOTE_REGION_X, y: 1, text: '中段メモ' },
            { ...DEFAULT_CANVAS_NOTE, id: 4, view_id: 1, x: RACK_NOTE_REGION_X, y: 2, text: '下段メモ' }
        ];
        setupRack(stored);
        const deleteButtons = (region = 'upper') => rackSection(region)?.querySelectorAll('.rack-note-delete-btn') || [];
        assert.equal(deleteButtons('upper').length, 2);
        assert.equal(deleteButtons('middle').length, 1);
        assert.equal(deleteButtons('lower').length, 1);
        assert.equal(rackBlank('upper').parentElement.querySelector('.rack-note-delete-btn'), null);

        let confirmPrompt = null;
        globalThis.confirm = window.confirm = msg => { confirmPrompt = msg; return false; };
        await deleteButtons('middle')[0].dispatch('click');
        assert.equal(confirmPrompt, 'このラックメモを削除しますか？');
        assert.equal(appState.canvasNotes.length, 4);
        assert.equal(rackEditors('middle')[0].value, '中段メモ');

        globalThis.confirm = window.confirm = () => true;
        const middleEditor = rackEditors('middle')[0];
        middleEditor.focus();
        await middleEditor.typeText('中段を編集中');
        await deleteButtons('middle')[0].dispatch('click');
        await settle();
        assert.equal(appState.canvasNotes.length, 3);
        assert.equal(appState.canvasNotes.find(n => n.id === 3), undefined);
        assert.equal(rackEditors('middle').length, 1, '削除後は空欄のみ');
        assert.equal(requests.at(-1).views[0].canvas_notes.find(n => n.id === 3), undefined);

        assert.deepEqual(appState.canvasNotes.map(n => [n.id, n.x, n.y]),
            [[1, 0, 0], [2, 0, 0], [4, RACK_NOTE_REGION_X, 2]]);

        window.APP_CONFIG.user.isAdmin = false;
        notes.renderCanvasNotes();
        assert.ok(deleteButtons('upper').every(btn => btn.disabled && btn.hidden));
        assert.equal(notes.deleteRackNote(1), false);
        window.APP_CONFIG.user.isAdmin = true;
        notes.renderCanvasNotes();

        appState.resourceConflicts.views.set(1, {});
        notes.renderCanvasNotes();
        assert.ok(deleteButtons('upper').every(btn => btn.disabled));
        assert.equal(notes.deleteRackNote(1), false);
        appState.resourceConflicts.views.clear();
        notes.renderCanvasNotes();

        await deleteButtons('upper')[0].dispatch('click');
        await settle();
        assert.equal(appState.canvasNotes.length, 2);
        assert.equal(appState.canvasNotes.find(n => n.id === 1), undefined);
    });
    await t.test('新規入力欄から作成した直後にも削除ボタンが表示され、個別削除できる', async () => {
        setupRack();
        globalThis.confirm = window.confirm = () => true;
        const blank = rackBlank('middle');
        assert.equal(blank.parentElement.querySelector('.rack-note-delete-btn'), null);
        await blank.typeText('作成直後のメモ');
        const button = blank.parentElement.querySelector('.rack-note-delete-btn');
        assert.ok(button, '再読込なしで削除ボタンが表示される');
        await blank.dispatch('blur'); await settle();
        await button.dispatch('click'); await settle();
        assert.equal(appState.canvasNotes.length, 0);
        assert.equal(rackEditors('middle').length, 1);
        assert.equal(requests.at(-1).views[0].canvas_notes.length, 0);
    });
});
