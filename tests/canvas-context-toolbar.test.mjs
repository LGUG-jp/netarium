import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import {
    finishCanvasContextToolbar,
    hideCanvasContextToolbar,
    showCanvasContextToolbar
} from '../public/js/ui/canvas-context-toolbar.js';

const elements = new Map();
class TestElement extends EventTarget {
    constructor(id = '') {
        super();
        this.id = id;
        this.hidden = true;
        this.dataset = {};
        this.style = {};
        this.value = '';
        this.children = [];
        this.attributes = new Map();
        const classes = new Set();
        this.classList = {
            add: name => classes.add(name),
            remove: name => classes.delete(name),
            contains: name => classes.has(name),
            toggle(name, force) {
                const add = force ?? !classes.has(name);
                if (add) classes.add(name);
                else classes.delete(name);
                return add;
            }
        };
    }
    setAttribute(name, value) { this.attributes.set(name, value); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) {
        this.attributes.delete(name);
        if (name === 'data-active-context') delete this.dataset.activeContext;
    }
    querySelectorAll(selector) {
        return selector === '[data-canvas-context]' ? this.children : [];
    }
    querySelector(selector) {
        return selector === 'button:not(:disabled)' ? this.button : null;
    }
    closest(selector) { return selector.includes('#canvas-context-toolbar') ? this : null; }
    contains(element) { return element === this || this.children.some(child => child.contains(element)); }
    focus() { document.activeElement = this; }
    append(...children) { this.children.push(...children); }
    appendChild(child) { this.children.push(child); return child; }
    replaceChildren(...children) { this.children = children; }
    getBoundingClientRect() { return { left: 0, top: 0, width: 1200, height: 800 }; }
}

globalThis.Element = TestElement;
globalThis.HTMLElement = TestElement;
globalThis.document = {
    body: new TestElement(), activeElement: null,
    getElementById: id => elements.get(id) ?? null,
    querySelector: () => null, querySelectorAll: () => [],
    createElement: () => new TestElement(), addEventListener() {}
};
globalThis.window = {
    APP_CONFIG: { user: { isAdmin: true } },
    setTimeout: () => 0, clearTimeout() {}, requestAnimationFrame: callback => callback()
};
globalThis.confirm = () => true;

const { appState } = await import('../public/js/core/state.js');
const {
    finishFloorPlanAdjustMode, fitViewToFloorPlan, openFloorPlanManager, toggleFloorPlanAdjustMode
} = await import('../public/js/modals/floor-plan-modal.js');
const { onKeyDown } = await import('../public/js/canvas/selection.js');
const { fitViewToDevices, onCanvasClick } = await import('../public/js/canvas/renderer.js');
const { eventBus } = await import('../public/js/core/event-bus.js');
const { onCanvasPointerDown } = await import('../public/js/canvas/drag-drop.js');
const { placementState } = await import('../public/js/ui/placement-mode.js');

function panel(id) {
    const element = new TestElement();
    element.dataset.canvasContext = id;
    element.setAttribute('aria-label', id);
    element.button = new TestElement();
    return element;
}
function escapeEvent() {
    return { key: 'Escape', target: document.body, preventDefault() {}, stopImmediatePropagation() {} };
}

beforeEach(() => {
    finishCanvasContextToolbar();
    finishFloorPlanAdjustMode();
    elements.clear();
    const toolbar = new TestElement('canvas-context-toolbar');
    toolbar.children = [panel('floor-plan'), panel('secondary')];
    elements.set(toolbar.id, toolbar);
    elements.set('floor-plan-manager-overlay', new TestElement('floor-plan-manager-overlay'));
    elements.set('floor-plan-drag-mode-btn', new TestElement());
    window.APP_CONFIG.user.isAdmin = true;
    appState.currentViewId = 1;
    appState.views = [{ id: 1, name: '試験フロア', view_type: 'floor' }];
    appState.floorPlans = [{ view_id: 1, x: 100, y: 80, scale: 1, opacity: 0.5,
        is_visible: true, image_width: 3000, image_height: 2000 }];
    appState.isPinging = false;
    appState.isFloorPlanUpdating = false;
    appState.canvas = new TestElement();
    appState.world = new TestElement();
    appState.floorPlanLayer = null;
    appState.selectedPlacementIds = new Set([10]);
    appState.devices = [];
    appState.placements = [];
    appState.links = [];
    appState.linkMode = false;
    appState.isRangeSelecting = false;
    appState.suppressNextClick = false;
    placementState.active = false;
});

test('context切替は前の機能を一度終了し、遅れた終了通知でも次の機能を閉じない', () => {
    const finished = [];
    showCanvasContextToolbar('floor-plan', reason => {
        finished.push(reason);
        hideCanvasContextToolbar('floor-plan');
    });
    showCanvasContextToolbar('floor-plan', () => assert.fail('同じcontextを再開始しない'));
    showCanvasContextToolbar('secondary', reason => finished.push(reason));
    hideCanvasContextToolbar('floor-plan');
    const toolbar = elements.get('canvas-context-toolbar');
    assert.deepEqual(finished, ['replace']);
    assert.equal(toolbar.hidden, false);
    assert.deepEqual(toolbar.children.map(child => child.hidden), [true, false]);
    assert.equal(document.activeElement, toolbar.children[1].button);
    finishCanvasContextToolbar();
    assert.deepEqual(finished, ['replace', 'finish']);
    assert.equal(toolbar.hidden, true);
    assert.deepEqual(toolbar.children.map(child => child.hidden), [true, true]);
    assert.equal(finishCanvasContextToolbar(), false);
});

test('存在しないcontextへの切替は現在の編集を終了しない', () => {
    showCanvasContextToolbar('floor-plan', () => assert.fail('編集中のcontextを維持する'));
    assert.throws(() => showCanvasContextToolbar('missing', () => {}), /context/);
    assert.equal(elements.get('canvas-context-toolbar').hidden, false);
    hideCanvasContextToolbar('floor-plan');
});


test('調整中も共通の全体表示で図面を収め、状態クリアで調整表示を終了する', () => {
    openFloorPlanManager();
    toggleFloorPlanAdjustMode();
    Object.assign(appState.viewState, { scale: 3, panX: -5000, panY: -4000 });
    const off = eventBus.on('floor-plan:fit', fitViewToFloorPlan);
    try {
        fitViewToDevices();
        const { scale, panX, panY } = appState.viewState;
        assert.ok(100 * scale + panX >= 0);
        assert.ok(80 * scale + panY >= 0);
        assert.ok(3100 * scale + panX <= 1200);
        assert.ok(2080 * scale + panY <= 800);
        assert.equal(appState.floorPlanAdjustMode, true);
        assert.equal(elements.get('canvas-context-toolbar').hidden, false);
    } finally {
        off();
    }
    finishFloorPlanAdjustMode();
    assert.equal(elements.get('canvas-context-toolbar').hidden, true);
    assert.equal(document.body.classList.contains('floor-plan-adjusting'), false);
});


test('viewerは図面調整contextを開始できない', () => {
    window.APP_CONFIG.user.isAdmin = false;
    toggleFloorPlanAdjustMode();
    assert.equal(appState.floorPlanAdjustMode, false);
    assert.equal(elements.get('canvas-context-toolbar').hidden, true);
});

test('ツールバーの空白や説明文は、配置・選択解除・パンの開始にならない', async () => {
    placementState.active = true;
    const event = { target: elements.get('canvas-context-toolbar'), button: 0,
        clientX: 200, clientY: 200, preventDefault() { assert.fail('パンを開始しない'); } };
    await onCanvasClick(event);
    onCanvasPointerDown(event);
    assert.deepEqual([...appState.selectedPlacementIds], [10]);
    assert.deepEqual(appState.devices, []);
    assert.deepEqual(appState.placements, []);
});
