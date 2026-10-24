import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test, beforeEach } from 'node:test';

// ブラウザ環境の軽量モック
const mockElements = new Map();

function createMockElement(tag = 'div') {
    const el = {
        tagName: tag.toUpperCase(),
        className: '',
        children: [],
        dataset: {},
        hidden: false,
        classList: {
            classes: new Set(),
            add(c) { this.classes.add(c); },
            remove(c) { this.classes.delete(c); },
            toggle(c, force) {
                if (force === undefined) {
                    if (this.classes.has(c)) this.classes.delete(c);
                    else this.classes.add(c);
                } else if (force) {
                    this.classes.add(c);
                } else {
                    this.classes.delete(c);
                }
            },
            contains(c) { return this.classes.has(c); }
        },
        set innerHTML(val) {
            if (val === '') this.children = [];
        },
        setAttribute(name, val) {
            this[name] = val;
            if (name.startsWith('data-')) {
                const prop = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
                this.dataset[prop] = val;
            }
        },
        removeAttribute(name) {
            delete this[name];
            if (name.startsWith('data-')) {
                const prop = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
                delete this.dataset[prop];
            }
        },
        getAttribute(name) { return this[name] || null; },
        focus() {},
        _listeners: {},
        append(...children) { this.children.push(...children); },
        replaceChildren(...children) { this.children = [...children]; },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        appendChild(child) {
            this.children.push(child);
            return child;
        },
        addEventListener(ev, fn) { this._listeners[ev] = fn; },
        removeEventListener(ev) { delete this._listeners[ev]; },
        getBoundingClientRect() {
            return {
                left: 0,
                top: 0,
                right: 1200,
                bottom: 800,
                width: 1200,
                height: 800
            };
        },
        style: {}
    };
    return el;
}

if (typeof globalThis.document === 'undefined') {
    globalThis.document = {
        body: createMockElement('body'),
        getElementById: (id) => {
            if (!mockElements.has(id)) {
                mockElements.set(id, createMockElement('div'));
            }
            return mockElements.get(id);
        },
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener() {},
        createElement: (tag) => createMockElement(tag)
    };
}

if (typeof globalThis.window === 'undefined') {
    globalThis.window = {
        requestAnimationFrame: (cb) => cb(),
        setTimeout: (cb) => cb(),
        clearTimeout: () => {},
        confirm: () => true,
        addEventListener() {},
        APP_CONFIG: {
            user: { isAdmin: true }
        }
    };
}

import {
    DEFAULT_DEVICE_HEIGHT,
    DEFAULT_DEVICE_WIDTH,
    DEFAULT_VIEW_PAN_X,
    DEFAULT_VIEW_PAN_Y,
    DEFAULT_VIEW_SCALE
} from '../public/js/core/constants.js';

import { appState } from '../public/js/core/state.js';
import { eventBus } from '../public/js/core/event-bus.js';
import {
    applyViewTransform,
    getCanvasVisibleCenter,
    resetView,
    restoreCurrentViewState
} from '../public/js/canvas/pan-zoom.js';

import {
    fitViewToDevices,
    focusDevicePlacement
} from '../public/js/canvas/renderer.js';

import { fitViewToFloorPlan } from '../public/js/modals/floor-plan-modal.js';
import { clampPosition } from '../public/js/canvas/drag-drop.js';
import { openDirectLink } from '../public/js/core/direct-link.js';

beforeEach(() => {
    mockElements.clear();
    appState.views = [{ id: 1, name: '通常ビュー', view_type: 'normal' }];
    appState.currentViewId = 1;
    appState.devices = [];
    appState.placements = [];
    appState.links = [];
    appState.floorPlans = [];
    appState.viewStates = new Map();
    appState.floorPlanAutoFittedViews = new Set();
    appState.selectedPlacementIds = new Set();
    appState.editingDeviceId = null;
    appState.editingLinkId = null;
    appState.canvas = createMockElement('main');
    appState.world = createMockElement('div');
    appState.deviceLayer = createMockElement('div');
    appState.viewState = {
        scale: DEFAULT_VIEW_SCALE,
        panX: DEFAULT_VIEW_PAN_X,
        panY: DEFAULT_VIEW_PAN_Y,
        minScale: 0.05,
        maxScale: 3
    };
});



test('applyViewTransform: 内部scale 0.5をUI表示100%として正しくラベル反映する', () => {
    const zoomLabel = globalThis.document.getElementById('zoom-label');

    // 内部 scale 0.5 -> 100%
    appState.viewState.scale = 0.5;
    applyViewTransform();
    assert.equal(zoomLabel.textContent, '100%');

    // 内部 scale 0.25 -> 50%
    appState.viewState.scale = 0.25;
    applyViewTransform();
    assert.equal(zoomLabel.textContent, '50%');

    // 内部 scale 0.75 -> 150%
    appState.viewState.scale = 0.75;
    applyViewTransform();
    assert.equal(zoomLabel.textContent, '150%');

    // 内部 scale 1.0 -> 200%
    appState.viewState.scale = 1.0;
    applyViewTransform();
    assert.equal(zoomLabel.textContent, '200%');
});

test('resetView: 100%ボタンで規定倍率へ戻る', () => {
    appState.canvas.getBoundingClientRect = () => ({
        left: 0, top: 0, right: 1000, bottom: 600, width: 1000, height: 600
    });

    appState.viewState.scale = 2.0;
    appState.viewState.panX = 500;
    appState.viewState.panY = 500;

    resetView();

    assert.equal(appState.viewState.scale, 0.5);

});

test('fitViewToDevices: 1台配置や狭い配置で100% (scale 0.5) を超えて自動拡大しない', () => {
    appState.canvas.getBoundingClientRect = () => ({
        left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800
    });

    // 機器1台だけ配置 (96x86)
    appState.placements = [
        { id: 1, view_id: 1, device_id: 10, x: 200, y: 200 }
    ];

    fitViewToDevices();

    // 1200 / 96 = 12.5 に拡大されず、上限 DEFAULT_VIEW_SCALE (0.5) に制限される
    assert.equal(appState.viewState.scale, DEFAULT_VIEW_SCALE);
    assert.equal(appState.viewState.panX, 0, '原点より左の配置不可領域を表示しない');
    assert.equal(appState.viewState.panY, 0, '原点より上の配置不可領域を表示しない');
});

test('fitViewToDevices: 広大な配置では適切に100%未満へ縮小される', () => {
    appState.canvas.getBoundingClientRect = () => ({
        left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800
    });

    // 3000px x 2000px の広大な配置
    appState.placements = [
        { id: 1, view_id: 1, device_id: 10, x: 100, y: 100 },
        { id: 2, view_id: 1, device_id: 20, x: 3100, y: 2100 }
    ];

    fitViewToDevices();

    assert.ok(appState.viewState.scale < DEFAULT_VIEW_SCALE);
    assert.ok(appState.viewState.scale >= appState.viewState.minScale);
    const state = appState.viewState;
    assert.ok(state.panX >= 0 && state.panY >= 0);
    assert.ok(state.panX + (3100 + DEFAULT_DEVICE_WIDTH) * state.scale <= 1200);
    assert.ok(state.panY + (2100 + DEFAULT_DEVICE_HEIGHT) * state.scale <= 800);
});

test('fitViewToDevices: 機器0件の場合はresetView相当の挙動になる', () => {
    appState.canvas.getBoundingClientRect = () => ({
        left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800
    });

    appState.placements = [];
    appState.viewState.scale = 2.0;

    fitViewToDevices();

    assert.equal(appState.viewState.scale, DEFAULT_VIEW_SCALE);
});

test('restoreCurrentViewState: 初回表示と保存済み表示の復元優先順位', () => {
    appState.canvas.getBoundingClientRect = () => ({
        left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800
    });

    // 1. saved がなく、配置機器がある場合: 機器へ初回Fit
    appState.placements = [
        { id: 1, view_id: 1, device_id: 10, x: 100, y: 100 }
    ];
    restoreCurrentViewState();
    assert.equal(appState.viewState.scale, DEFAULT_VIEW_SCALE);

    // 2. 利用者がパン・ズームを変更
    appState.viewState.scale = 0.8;
    appState.viewState.panX = 350;
    appState.viewState.panY = 250;
    applyViewTransform();

    // 3. 次回 restoreCurrentViewState ではユーザーが変更した保存値が優先復元される
    appState.viewState.scale = 0.1;
    restoreCurrentViewState();
    assert.equal(appState.viewState.scale, 0.8);
    assert.equal(appState.viewState.panX, 350);
    assert.equal(appState.viewState.panY, 250);

    // 4. saved がなく、配置機器が0件の場合: resetView (既定pan)
    appState.currentViewId = 2;
    appState.views.push({ id: 2, name: '空ビュー', view_type: 'normal' });
    restoreCurrentViewState();
    assert.equal(appState.viewState.scale, DEFAULT_VIEW_SCALE);
});

test('focusDevicePlacement: 極端に縮小されている場合はDEFAULT_VIEW_SCALEへ引き上げ、可視領域中央へ移動する', () => {
    const canvasRect = {
        left: 0, top: 60, right: 1200, bottom: 860, width: 1200, height: 800
    };
    appState.canvas.getBoundingClientRect = () => canvasRect;

    const device = { id: 10, name: 'テストスイッチ', type: 'switch' };
    const placement = { id: 1, view_id: 1, device_id: 10, x: 500, y: 400 };

    appState.devices = [device];
    appState.placements = [placement];

    // 極端な縮小状態 (scale 0.1)
    appState.viewState.scale = 0.1;

    focusDevicePlacement(device, placement);

    // 最低表示倍率 DEFAULT_VIEW_SCALE (0.5) に引き上げられる
    assert.equal(appState.viewState.scale, DEFAULT_VIEW_SCALE);

    // 対象機器が選択されていること
    assert.ok(appState.selectedPlacementIds.has(1));

    // ノードの中心が可視領域の中央に来ること。
    assert.equal(appState.viewState.panX + (placement.x + DEFAULT_DEVICE_WIDTH / 2) * appState.viewState.scale,
        canvasRect.width / 2);
    assert.equal(appState.viewState.panY + (placement.y + DEFAULT_DEVICE_HEIGHT / 2) * appState.viewState.scale,
        canvasRect.height / 2);
});

test('focusDevicePlacement: すでに100%以上の場合は現在倍率を維持する', () => {
    appState.canvas.getBoundingClientRect = () => ({
        left: 0, top: 60, right: 1200, bottom: 860, width: 1200, height: 800
    });

    const device = { id: 10, name: 'テストスイッチ', type: 'switch' };
    const placement = { id: 1, view_id: 1, device_id: 10, x: 500, y: 400 };

    appState.devices = [device];
    appState.placements = [placement];

    // 拡大状態 (scale 0.8)
    appState.viewState.scale = 0.8;

    focusDevicePlacement(device, placement);

    // 倍率が維持されること
    assert.equal(appState.viewState.scale, 0.8);
});

test('getCanvasVisibleCenter: 右パネルが開いている場合、可視領域の中央を計算する', () => {
    // 900px以下のモバイル/狭幅画面で右パネルがオーバーレイしている状況
    appState.canvas.getBoundingClientRect = () => ({
        left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600
    });

    const panel = globalThis.document.getElementById('panel');
    panel.hidden = false;
    panel.classList.remove('hidden');
    panel.getBoundingClientRect = () => ({
        left: 500, top: 0, right: 800, bottom: 600, width: 300, height: 600
    });

    const center = getCanvasVisibleCenter();

    // 可視幅 = panel.left (500) - canvas.left (0) = 500
    // 可視centerX = 500 / 2 = 250
    assert.equal(center.x, 250);
    assert.equal(center.y, 300);
});

test('getCanvasVisibleCenter: 左のワークスペースナビパネルが開いている場合、その右端を考慮して中央を計算する', () => {
    appState.canvas.getBoundingClientRect = () => ({
        left: 58, top: 0, right: 1258, bottom: 800, width: 1200, height: 800
    });

    // 左パネル (幅340px, left: 58, right: 398)
    const navPanel = globalThis.document.getElementById('workspace-nav-panel');
    navPanel.hidden = false;
    navPanel.classList.remove('hidden');
    navPanel.getBoundingClientRect = () => ({
        left: 58, top: 0, right: 398, bottom: 800, width: 340, height: 800
    });

    const center = getCanvasVisibleCenter();

    // visibleLeft = nav.right (398) - canvas.left (58) = 340
    // visibleRight = canvas.width = 1200
    // centerX = 340 + (1200 - 340) / 2 = 340 + 430 = 770
    assert.equal(center.x, 770);
    assert.equal(center.y, 400);
});

test('getCanvasVisibleCenter: 左右両方のパネルが開いている場合、両パネルの間の領域中央を計算する', () => {
    appState.canvas.getBoundingClientRect = () => ({
        left: 58, top: 0, right: 1258, bottom: 800, width: 1200, height: 800
    });

    // 左パネル (幅340px, right: 398)
    const navPanel = globalThis.document.getElementById('workspace-nav-panel');
    navPanel.hidden = false;
    navPanel.classList.remove('hidden');
    navPanel.getBoundingClientRect = () => ({
        left: 58, top: 0, right: 398, bottom: 800, width: 340, height: 800
    });

    // 右パネル (幅300px, left: 958)
    const panel = globalThis.document.getElementById('panel');
    panel.hidden = false;
    panel.classList.remove('hidden');
    panel.getBoundingClientRect = () => ({
        left: 958, top: 0, right: 1258, bottom: 800, width: 300, height: 800
    });

    const center = getCanvasVisibleCenter();

    // visibleLeft = 398 - 58 = 340
    // visibleRight = 958 - 58 = 900
    // centerX = 340 + (900 - 340) / 2 = 340 + 280 = 620
    assert.equal(center.x, 620);
    assert.equal(center.y, 400);
});

test('clampPosition: 負座標は許可されず 0 にクランプされる', () => {
    const clamped = clampPosition(-50, -30);
    assert.equal(clamped.x, 0);
    assert.equal(clamped.y, 0);

    const normal = clampPosition(150, 200);
    assert.equal(normal.x, 150);
    assert.equal(normal.y, 200);
});

test('fitViewToFloorPlan: 小さな図面でも100% (scale 0.5) を超えて自動拡大しない', () => {
    appState.canvas.getBoundingClientRect = () => ({
        left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800
    });

    // 100x100 の小さな図面
    const floorPlan = {
        view_id: 1,
        image_width: 100,
        image_height: 100,
        scale: 1,
        x: 0,
        y: 0,
        is_visible: true
    };

    fitViewToFloorPlan(floorPlan);

    assert.equal(appState.viewState.scale, DEFAULT_VIEW_SCALE);
    assert.equal(appState.viewState.panX, 0);
    assert.equal(appState.viewState.panY, 0);
});

test('図面だけの初回Fitは原点と図面境界を収め、保存済み表示を優先復元する', () => {
    appState.canvas.getBoundingClientRect = () => ({ width: 1200, height: 800 });
    appState.views[0].view_type = 'floor';
    appState.floorPlans = [{ view_id: 1, image_width: 3000, image_height: 2000, scale: 1, x: 100, y: 80, is_visible: true }];
    const off = eventBus.on('floor-plan:fit', fitViewToFloorPlan);
    try {
        restoreCurrentViewState();
        const state = appState.viewState;
        assert.ok(state.scale < DEFAULT_VIEW_SCALE);
        assert.ok(state.panX >= 0 && state.panX < 1200 / 4);
        assert.ok(state.panY >= 0 && state.panY < 800 / 4);
        assert.ok(state.panX + 3100 * state.scale <= 1200);
        assert.ok(state.panY + 2080 * state.scale <= 800);
        appState.viewStates.set(1, { scale: 0.8, panX: -180, panY: 240 });
        restoreCurrentViewState();
        assert.equal(state.scale, 0.8);
        assert.equal(state.panX, -180);
        assert.equal(state.panY, 240);
    } finally { off(); }
});

test('fitViewToDevices: 図面調整モード中は非表示のフロア図面でもfit対象になる', () => {
    appState.canvas.getBoundingClientRect = () => ({ width: 1200, height: 800 });
    appState.views[0].view_type = 'floor';
    appState.floorPlans = [{ view_id: 1, image_width: 3000, image_height: 2000, scale: 1, x: -5000, y: -3000, is_visible: false }];
    appState.floorPlanAdjustMode = true;
    let fittedPlan = null;
    const off = eventBus.on('floor-plan:fit', plan => { fittedPlan = plan; });
    try {
        fitViewToDevices();
        assert.ok(fittedPlan !== null, '調整モード中は非表示図面でもfloor-plan:fitがemitされる');
        assert.equal(fittedPlan.view_id, 1);
    } finally {
        off();
        appState.floorPlanAdjustMode = false;
    }
});
test('レスポンシブスタイル: 狭幅画面でもヘッダーとCanvasの間に余計なmargin-topを設けない', () => {
    const css = fs.readFileSync(new URL('../public/css/canvas.css', import.meta.url), 'utf8');
    assert.doesNotMatch(css, /#canvas\s*\{[^}]*margin-top:\s*var\(--toolbar-height\)/, 'Canvasにtoolbar-height分のmargin-topを二重適用しない');
    assert.doesNotMatch(css, /@media[^{]*max-width:\s*820px[^{]*\{[^}]*#canvas/, '820px以下のメディアクエリでCanvasに余計な上部空白を設けない');
});

test('直接リンクは管理者・閲覧者とも指定ビューの機器を選択し詳細を開く', async () => {
    for (const isAdmin of [true, false]) {
        window.APP_CONFIG.user.isAdmin = isAdmin;
        appState.views = [{ id: 1, sort_order: 1 }, { id: 12, sort_order: 2 }];
        appState.currentViewId = 1;
        appState.devices = [{ id: 305, name: '共有対象', type: 'router', ip: '' }];
        appState.placements = [{ id: 30, view_id: 12, device_id: 305, x: 400, y: 300 }];
        appState.editingDeviceId = null;
        assert.equal(await openDirectLink('?view=12&device=305'), true);
        assert.equal(appState.currentViewId, 12);
        assert.equal(appState.editingDeviceId, 305);
        assert.deepEqual([...appState.selectedPlacementIds], [30]);
        assert.equal(document.getElementById('panel').classList.contains('hidden'), false);
    }
    window.APP_CONFIG.user.isAdmin = true;
});

test('直接リンクのビュー切替が中止された場合は選択・表示状態を保持する', async () => {
    appState.views.push({ id: 12, sort_order: 2 });
    appState.devices = [{ id: 305 }];
    appState.placements = [{ id: 30, view_id: 12, device_id: 305 }];
    appState.selectedPlacementIds.add(99);
    appState.isPinging = true;
    const before = { ...appState.viewState };
    try {
        assert.equal(await openDirectLink('?view=12&device=305'), false);
        assert.equal(appState.currentViewId, 1);
        assert.deepEqual([...appState.selectedPlacementIds], [99]);
        assert.deepEqual(appState.viewState, before);
        assert.equal(appState.editingDeviceId, null);
    } finally {
        appState.isPinging = false;
    }
});
