import assert from 'node:assert/strict';
import { test, beforeEach, afterEach } from 'node:test';
import { setImmediate } from 'node:timers/promises';

// ブラウザ環境の軽量モック
const mockElements = new Map();
globalThis.HTMLElement = class {};
globalThis.HTMLSelectElement = class {
    static [Symbol.hasInstance](element) { return element?.tagName === 'SELECT'; }
};

function createMockElement(tag = 'div') {
    const el = {
        tagName: tag.toUpperCase(),
        className: '',
        children: [],
        dataset: {},
        hidden: false,
        selected: false,
        get value() { return this.tagName === 'SELECT' ? this.selectedOptions[0]?.value ?? '' : this._value ?? ''; },
        set value(value) {
            if (this.tagName !== 'SELECT') { this._value = String(value); return; }
            let matched = false;
            for (const option of this.options) {
                option.selected = !matched && option.value === String(value);
                if (option.selected) matched = true;
            }
        },
        get options() { return this.children.filter(child => child.tagName === 'OPTION'); },
        get selectedOptions() { return this.options.filter(option => option.selected); },
        contains(element) { return this === element || this.children.some(child => child.contains(element)); },
        closest(selector) {
            for (let node = this; node; node = node.parentElement) {
                if (selector === '[hidden], .hidden' &&
                    (node.hidden || node.classList.contains('hidden'))) return node;
            }
            return null;
        },
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
        insertAdjacentElement(position, child) {
            if (position !== 'afterend') throw new Error(`Unsupported fixture position: ${position}`);
            if (!this.parentElement) return null;
            const parent = this.parentElement;
            child.parentElement = parent;
            parent.children.splice(parent.children.indexOf(this) + 1, 0, child);
            return child;
        },
        _listeners: {},
        append(...children) { this.children.push(...children); },
        replaceChildren(...children) { this.children = [...children]; },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        appendChild(child) {
            child.parentElement = this;
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
        addEventListener() {},
        getElementById: (id) => {
            if (!mockElements.has(id)) {
                const isSelect = id === 'ledger-place-view-select' || /^ledger-(view|facility|floor|status|type|ip-presence|placement)-filter$/.test(id);
                const element = createMockElement(isSelect ? 'select' : 'div');
                if (isSelect && id !== 'ledger-place-view-select') element.multiple = true;
                mockElements.set(id, element);
            }
            return mockElements.get(id);
        },
        querySelector: () => null,
        querySelectorAll: () => [],
        createElement: (tag) => createMockElement(tag)
    };
}

if (typeof globalThis.window === 'undefined') {
    globalThis.window = {
        addEventListener() {},
        requestAnimationFrame: (cb) => cb(),
        setTimeout: (cb) => cb(),
        clearTimeout: () => {},
        confirm: () => true,
        APP_CONFIG: {
            user: { isAdmin: true }
        }
    };
} else if (!globalThis.window.APP_CONFIG) {
    globalThis.window.APP_CONFIG = {
        user: { isAdmin: true }
    };
}

import {
    DEFAULT_DEVICE_HEIGHT,
    DEFAULT_DEVICE_WIDTH,
    DEVICE_TYPES
} from '../public/js/core/constants.js';

import { appState, normalizeDevice, normalizeView, normalizePlacement } from '../public/js/core/state.js';
import { clearPendingSave, flushSaveQueue } from '../public/js/core/save-queue.js';
import { resetResourceBaseline } from '../public/js/core/resource-save.js';

import {
    addDevicesToPlacementQueue,
    clearPlacementQueue,
    enterPlacementMode,
    exitPlacementMode,
    getPlacementState,
    getRecommendedUnplacedDevices,
    getUnplacedCandidates,
    handleCanvasPlacementClick,
    isPlacementModeActive,
    placementState,
    removeDeviceFromPlacementQueue,
    renderPlacementPalette,
    setNextPlacementQueueDevice,
    setPlacementNewDeviceType,
    setPlacementUnplacedScope,
    switchPlacementTab,
    syncPlacementModeUi,
    togglePlacementMode
} from '../public/js/ui/placement-mode.js';

beforeEach(() => {
    clearPendingSave();
    placementState.active = false;
    mockElements.clear();
    globalThis.window.APP_CONFIG.user.isAdmin = true;
    globalThis.window.APP_CONFIG.csrfToken = 'placement-test-token';
    for (const [id, values] of [
        ['ledger-status-filter', ['green', 'red', 'unknown']],
        ['ledger-ip-presence-filter', ['registered', 'empty']],
        ['ledger-placement-filter', ['placed', 'unplaced']]
    ]) {
        const select = document.getElementById(id);
        for (const value of values) select.appendChild(Object.assign(createMockElement('option'), { value }));
    }

    appState.views = [
        { id: 1, name: '本庁舎 2F', facility: '本庁舎', floor: '2F', view_type: 'normal' },
        { id: 2, name: '別館 1F', facility: '別館', floor: '1F', view_type: 'normal' }
    ];
    appState.currentViewId = 1;

    appState.devices = [
        { id: 1, name: 'コアSW', type: 'l3_switch', facility: '本庁舎', floor: '2F' },
        { id: 2, name: 'フロアSW-01', type: 'switch', facility: '本庁舎', floor: '2F' },
        { id: 3, name: 'フロアSW-02', type: 'switch', facility: '本庁舎', floor: '3F' },
        { id: 4, name: '別館SW-01', type: 'switch', facility: '別館', floor: '1F' },
        { id: 5, name: '未配置AP', type: 'ap', facility: '', floor: '' }
    ];

    // デバイス1はビュー1に配置済み、デバイス4はビュー2に配置済み
    appState.placements = [
        { id: 101, device_id: 1, view_id: 1, x: 100, y: 100 },
        { id: 102, device_id: 4, view_id: 2, x: 200, y: 200 }
    ];

    appState.nextDeviceId = 10;
    appState.nextPlacementId = 200;

    appState.canvas = createMockElement('main');
    appState.world = createMockElement('div');
    appState.deviceLayer = createMockElement('div');
    appState.currentSvg = createMockElement('svg');
    appState.floorPlanLayer = createMockElement('div');
    appState.selectedPlacementIds = new Set();
    appState.editingDeviceId = null;
    appState.editingLinkId = null;
    appState.linkMode = false;
    appState.appStatus = { dirty: false };

    appState.viewState = {
        scale: 0.5,
        panX: 24,
        panY: 24,
        minScale: 0.05,
        maxScale: 3
    };

    exitPlacementMode();
    clearPlacementQueue();
    placementState.tab = 'new';
    placementState.newDeviceType = null;
    placementState.unplacedScope = 'current-view';
    placementState.selectedUnplacedIds.clear();
    appState.devices = appState.devices.map(device => normalizeDevice({ ...device, resource_revision: 1 }));
    appState.views = appState.views.map(view => normalizeView({ ...view, resource_revision: 1 }));
    appState.placements = appState.placements.map(normalizePlacement);
    appState.links = [];
    appState.floorPlans = [];
    appState.deviceImages = [];
    appState.authExpired = false;
    appState.dataRevision = 1;
    resetResourceBaseline(appState);
    syncPlacementModeUi();
});

afterEach(() => {
    clearPendingSave();
    placementState.active = false;
});

test('enterPlacementMode / exitPlacementMode / togglePlacementMode の基本ライフサイクル', () => {
    assert.equal(isPlacementModeActive(), false);

    // 管理者で開始
    const entered = enterPlacementMode();
    assert.equal(entered, true);
    assert.equal(isPlacementModeActive(), true);

    // 終了
    exitPlacementMode();
    assert.equal(isPlacementModeActive(), false);

    // トグル
    togglePlacementMode();
    assert.equal(isPlacementModeActive(), true);
    togglePlacementMode();
    assert.equal(isPlacementModeActive(), false);
});

test('enterPlacementMode: 一般ユーザー（閲覧者）は配置モードを開始できない', () => {
    globalThis.window.APP_CONFIG.user.isAdmin = false;
    const entered = enterPlacementMode();
    assert.equal(entered, false);
    assert.equal(isPlacementModeActive(), false);
});

test('switchPlacementTab: 新規タブと未配置タブの切替', () => {
    enterPlacementMode();
    assert.equal(placementState.tab, 'new');

    switchPlacementTab('unplaced');
    assert.equal(placementState.tab, 'unplaced');

    switchPlacementTab('new');
    assert.equal(placementState.tab, 'new');
});

test('setPlacementNewDeviceType: 機器種別の選択と変更', () => {
    enterPlacementMode();
    assert.equal(placementState.newDeviceType, null);

    setPlacementNewDeviceType('switch');
    assert.equal(placementState.newDeviceType, 'switch');

    setPlacementNewDeviceType('router');
    assert.equal(placementState.newDeviceType, 'router');

    setPlacementNewDeviceType('ap');
    assert.equal(placementState.newDeviceType, 'ap');
});

test('handleCanvasPlacementClick: 新規スタンプ配置で機器と配置が連続作成される', () => {
    enterPlacementMode({ tab: 'new', deviceType: 'router' });

    appState.canvas.getBoundingClientRect = () => ({
        left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800
    });

    const initialDevicesCount = appState.devices.length;
    const initialPlacementsCount = appState.placements.length;

    // 1回目のクリック
    const handled1 = handleCanvasPlacementClick({ clientX: 300, clientY: 200 });
    assert.equal(handled1, true);

    assert.equal(appState.devices.length, initialDevicesCount + 1);
    assert.equal(appState.placements.length, initialPlacementsCount + 1);
    const newDev1 = appState.devices[appState.devices.length - 1];
    assert.equal(newDev1.type, 'router');
    assert.equal(appState.appStatus.dirty, true);

    // 2回目のクリック（同一種別のまま連続配置）
    const handled2 = handleCanvasPlacementClick({ clientX: 400, clientY: 250 });
    assert.equal(handled2, true);

    assert.equal(appState.devices.length, initialDevicesCount + 2);
    assert.equal(appState.placements.length, initialPlacementsCount + 2);

    // モードは終了せず継続していること
    assert.equal(isPlacementModeActive(), true);
});

test('getUnplacedCandidates: このビューに未配置 / 全ビュー未配置の判定', () => {
    // 現在ビューはビュー1
    // デバイス1: ビュー1に配置済み
    // デバイス2: どのビューにも未配置
    // デバイス3: どのビューにも未配置
    // デバイス4: ビュー2に配置済み（ビュー1には未配置）
    // デバイス5: どのビューにも未配置

    // 1. このビューに未配置（デバイス1以外すべて = 2, 3, 4, 5）
    const currentViewCandidates = getUnplacedCandidates('current-view');
    const currentIds = currentViewCandidates.map(d => d.id);
    assert.ok(!currentIds.includes(1), 'デバイス1は現在ビューに配置済みなので除外');
    assert.ok(currentIds.includes(2));
    assert.ok(currentIds.includes(3));
    assert.ok(currentIds.includes(4), 'デバイス4は別ビュー配置だが現在ビューには未配置');
    assert.ok(currentIds.includes(5));

    // 2. 全ビュー未配置（どのビューにも配置されていないもの = 2, 3, 5）
    const allViewsCandidates = getUnplacedCandidates('all-views');
    const allIds = allViewsCandidates.map(d => d.id);
    assert.ok(!allIds.includes(1), 'デバイス1は配置済み');
    assert.ok(!allIds.includes(4), 'デバイス4はビュー2に配置済みなので全ビュー未配置ではない');
    assert.ok(allIds.includes(2));
    assert.ok(allIds.includes(3));
    assert.ok(allIds.includes(5));
});

test('getRecommendedUnplacedDevices: 現在ビューのfacility/floorに合致する推奨判定', () => {
    // 現在ビュー1: facility='本庁舎', floor='2F'
    // デバイス2: facility='本庁舎', floor='2F' -> 完全一致 (recommended)
    // デバイス3: facility='本庁舎', floor='3F' -> facility一致 (recommended)
    // デバイス4: facility='別館', floor='1F' -> 不一致 (others)
    // デバイス5: facility='', floor='' -> 未設定 (others)

    const candidates = [
        appState.devices[1], // デバイス2
        appState.devices[2], // デバイス3
        appState.devices[3], // デバイス4
        appState.devices[4]  // デバイス5
    ];

    const { recommended, others } = getRecommendedUnplacedDevices(candidates);

    const recIds = recommended.map(d => d.id);
    const othIds = others.map(d => d.id);

    assert.ok(recIds.includes(2), '本庁舎 / 2F は完全一致で推奨');
    assert.ok(othIds.includes(3), '本庁舎 / 3F はフロア違いのためその他');
    assert.ok(othIds.includes(4), '別館 / 1F は施設違いのためその他');
    assert.ok(othIds.includes(5), '施設フロア未設定はその他');
});

test('addDevicesToPlacementQueue & キュー操作: 追加・並び替え・削除', () => {
    enterPlacementMode({ tab: 'unplaced' });

    // キュー追加
    addDevicesToPlacementQueue([2, 3]);
    assert.equal(placementState.queue.length, 2);
    assert.equal(placementState.queue[0].id, 2);
    assert.equal(placementState.queue[1].id, 3);

    // 重複追加の防止（すでに入っているIDは無視される）
    addDevicesToPlacementQueue([2, 5]);
    assert.equal(placementState.queue.length, 3);
    assert.equal(placementState.queue[2].id, 5);

    // 既に現在ビューに配置済みの機器（ID: 1）はキューに入らない
    addDevicesToPlacementQueue([1]);
    assert.equal(placementState.queue.some(d => d.id === 1), false);

    // 機器を「次」に繰り上げ（ID: 5 を先頭へ）
    setNextPlacementQueueDevice(5);
    assert.equal(placementState.queue[0].id, 5);

    // 特定機器の削除（ID: 3 を削除）
    removeDeviceFromPlacementQueue(3);
    assert.equal(placementState.queue.length, 2);
    assert.equal(placementState.queue.some(d => d.id === 3), false);

    // クリア
    clearPlacementQueue();
    assert.equal(placementState.queue.length, 0);
});

test('handleCanvasPlacementClick: キューからの順次配置とキュー消化', () => {
    enterPlacementMode({ tab: 'unplaced', initialDeviceIds: [2, 3] });

    assert.equal(placementState.queue.length, 2);
    assert.equal(placementState.queue[0].id, 2);

    appState.canvas.getBoundingClientRect = () => ({
        left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800
    });

    // 1台目をクリック配置
    const handled1 = handleCanvasPlacementClick({ clientX: 300, clientY: 200 });
    assert.equal(handled1, true);

    // キューからデバイス2が消化され、残りはデバイス3（1台）
    assert.equal(placementState.queue.length, 1);
    assert.equal(placementState.queue[0].id, 3);

    // placementに追加されていること
    const placed1 = appState.placements.find(p => p.device_id === 2);
    assert.ok(placed1);
    assert.equal(placed1.view_id, 1);

    // 2台目をクリック配置
    const handled2 = handleCanvasPlacementClick({ clientX: 500, clientY: 400 });
    assert.equal(handled2, true);

    // キューは0件になる
    assert.equal(placementState.queue.length, 0);

    // placementに追加されていること
    const placed2 = appState.placements.find(p => p.device_id === 3);
    assert.ok(placed2);
    assert.equal(placed2.view_id, 1);

    // キューが0件になっても配置モード自体は継続する
    assert.equal(isPlacementModeActive(), true);
});

test('enterPlacementMode: 他画面からの初期対象ID引き継ぎ', () => {
    // 機器台帳やデータ品質から initialDeviceIds を渡して起動
    enterPlacementMode({
        initialDeviceIds: [2, 5]
    });

    assert.equal(isPlacementModeActive(), true);
    assert.equal(placementState.tab, 'unplaced');
    assert.equal(placementState.queue.length, 2);
    assert.equal(placementState.queue[0].id, 2);
    assert.equal(placementState.queue[1].id, 5);
});

test('外部から未配置モードを開始すると未配置タブが表示される', () => {
    enterPlacementMode({ tab: 'unplaced', initialDeviceIds: [2] });
    assert.equal(document.getElementById('place-content-new').hidden, true);
    assert.equal(document.getElementById('place-content-unplaced').hidden, false);
    assert.equal(document.getElementById('place-tab-btn-unplaced').getAttribute('aria-selected'), 'true');
});

test('施設が異なる機器は同じ階でも推奨しない', () => {
    const { recommended, others } = getRecommendedUnplacedDevices([
        { id: 9, facility: '別館', floor: '2F' }
    ]);
    assert.deepEqual(recommended, []);
    assert.deepEqual(others.map(device => device.id), [9]);
});

test('キュー追加後に削除された機器は配置を作成しない', () => {
    enterPlacementMode({ initialDeviceIds: [2] });
    appState.devices = appState.devices.filter(device => device.id !== 2);
    handleCanvasPlacementClick({ clientX: 400, clientY: 300 });
    assert.equal(appState.placements.some(placement => placement.device_id === 2), false);
    assert.equal(appState.appStatus.dirty, false);
});

test('配線へ切り替えると配置モードが終了し空白クリックで機器を増やさない', async () => {
    const { toggleLinkMode } = await import('../public/js/ui/toolbar.js');
    enterPlacementMode();
    toggleLinkMode();
    assert.equal(appState.linkMode, true);
    assert.equal(isPlacementModeActive(), false);
    assert.equal(handleCanvasPlacementClick({ clientX: 400, clientY: 300 }), false);
    assert.deepEqual(appState.devices.map(device => device.id), [1, 2, 3, 4, 5]);
});

test('ビュー切替後の候補にそのビューの未配置機器を表示する', async () => {
    const { switchView } = await import('../public/js/modals/view-manager-modal.js');
    enterPlacementMode({ tab: 'unplaced' });
    switchView(2);
    const list = document.getElementById('placement-unplaced-list');
    const labels = list.children.filter(child => child.tagName === 'LABEL');
    assert.deepEqual(labels.map(label => label.children[0].value).sort(), ['1', '2', '3', '5']);
});

test('パンとズーム後もゴーストと実配置のワールド座標が一致する', async () => {
    const { updatePlacementGhost, setPlacementNewDeviceType } = await import('../public/js/ui/placement-mode.js');
    const { applyViewTransform } = await import('../public/js/canvas/pan-zoom.js');
    enterPlacementMode();
    setPlacementNewDeviceType('switch');
    updatePlacementGhost(400, 300);
    appState.viewState.panX = 100;
    appState.viewState.panY = 80;
    appState.viewState.scale = 1;
    applyViewTransform();
    const ghost = document.getElementById('placement-ghost');
    assert.equal(ghost.hidden, false);
    const expectedX = 300 - DEFAULT_DEVICE_WIDTH / 2;
    const expectedY = 220 - DEFAULT_DEVICE_HEIGHT / 2;
    assert.equal(ghost.style.left, `${expectedX}px`);
    assert.equal(ghost.style.top, `${expectedY}px`);
    handleCanvasPlacementClick({ clientX: 400, clientY: 300 });
    assert.equal(appState.placements.at(-1).x, expectedX);
    assert.equal(appState.placements.at(-1).y, expectedY);
});

test('台帳の配置開始をキャンセルしても配置先ダイアログと選択を維持する', async () => {
    const ledger = await import('../public/js/modals/ledger-modal.js');
    ledger.ledgerSelectedDeviceIds.clear();
    ledger.ledgerSelectedDeviceIds.add(2);
    ledger.openLedgerPlaceViewModal();
    document.getElementById('ledger-place-view-select').value = '1';
    const { openPanel } = await import('../public/js/ui/property-panel.js');
    assert.equal(openPanel(appState.devices[0]), true);
    document.getElementById('p-name').value = '未適用の変更';
    window.confirm = () => false;
    try {
        ledger.confirmPlaceDevicesToView();
        assert.equal(document.getElementById('ledger-place-view-overlay').hidden, false);
        assert.equal(isPlacementModeActive(), false);
        assert.deepEqual(placementState.queue, []);
        assert.deepEqual([...ledger.ledgerSelectedDeviceIds], [2]);
    } finally {
        window.confirm = () => true;
        ledger.closeLedgerPlaceViewModal();
    }
});

test('台帳の配置先へ切り替えられなければ現在ビューへキューを渡さない', async () => {
    const ledger = await import('../public/js/modals/ledger-modal.js');
    ledger.ledgerSelectedDeviceIds.clear();
    ledger.ledgerSelectedDeviceIds.add(2);
    ledger.openLedgerPlaceViewModal();
    document.getElementById('ledger-place-view-select').value = '2';
    const { eventBus } = await import('../public/js/core/event-bus.js');
    const { switchView } = await import('../public/js/modals/view-manager-modal.js');
    const unsubscribe = eventBus.on('view:switch', switchView);
    const { openPanel } = await import('../public/js/ui/property-panel.js');
    assert.equal(openPanel(appState.devices[0]), true);
    document.getElementById('p-name').value = '';
    document.getElementById('p-type').value = 'l3_switch';
    try {
        ledger.confirmPlaceDevicesToView();
        assert.equal(appState.currentViewId, 1);
        assert.equal(document.getElementById('ledger-place-view-overlay').hidden, false);
        assert.equal(isPlacementModeActive(), false);
        assert.deepEqual(placementState.queue, []);
    } finally {
        unsubscribe();
        ledger.closeLedgerPlaceViewModal();
    }
});

test('ダッシュボードの未配置カードは台帳に全ビュー未配置フィルタを適用し、解除できる', async t => {
    const { handleDashboardAction, hideDashboardForNavigation } = await import('../public/js/modals/dashboard-modal.js');
    const { eventBus } = await import('../public/js/core/event-bus.js');
    t.after(eventBus.on('dashboard:hide-for-navigation', hideDashboardForNavigation));
    const ledger = await import('../public/js/modals/ledger-modal.js');
    const placementFilter = document.getElementById('ledger-placement-filter');
    document.getElementById('dashboard-overlay').hidden = false;
    handleDashboardAction('quality-unplaced');
    assert.equal(isPlacementModeActive(), false);
    assert.equal(document.getElementById('dashboard-overlay').hidden, true);
    assert.equal(document.getElementById('ledger-overlay').hidden, false);
    assert.equal(placementFilter.value, 'unplaced');
    assert.deepEqual(ledger.getLedgerFilterValues().placement, ['unplaced']);
    assert.deepEqual(ledger.getFilteredLedgerDevices().map(device => device.id).sort(), [2, 3, 5]);
    ledger.resetLedgerFilters();
    assert.deepEqual(ledger.getFilteredLedgerDevices().map(device => device.id).sort(), appState.devices.map(device => device.id).sort());
    await ledger.closeLedger();
});

test('配置モード開始時に選択ボタンのアクティブが解除され、終了時に復元される', () => {
    const viewBtn = document.getElementById('palette-view-btn');
    const placeBtn = document.getElementById('palette-place-btn');

    // 初期状態（選択モード）
    exitPlacementMode();
    assert.equal(viewBtn.classList.contains('active'), true);
    assert.equal(viewBtn.getAttribute('aria-pressed'), 'true');
    assert.equal(placeBtn.classList.contains('active'), false);
    assert.equal(placeBtn.getAttribute('aria-pressed'), 'false');

    // 配置モード開始
    enterPlacementMode();
    assert.equal(isPlacementModeActive(), true);
    assert.equal(viewBtn.classList.contains('active'), false);
    assert.equal(viewBtn.getAttribute('aria-pressed'), 'false');
    assert.equal(placeBtn.classList.contains('active'), true);
    assert.equal(placeBtn.getAttribute('aria-pressed'), 'true');

    // 配置モード終了
    exitPlacementMode();
    assert.equal(isPlacementModeActive(), false);
    assert.equal(viewBtn.classList.contains('active'), true);
    assert.equal(viewBtn.getAttribute('aria-pressed'), 'true');
    assert.equal(placeBtn.classList.contains('active'), false);
    assert.equal(placeBtn.getAttribute('aria-pressed'), 'false');
});

test('短縮表記: 各機器種別に指定のshortLabelが定義されている', () => {
    assert.equal(DEVICE_TYPES.switch.shortLabel, 'L2SW');
    assert.equal(DEVICE_TYPES.l3_switch.shortLabel, 'L3SW');
    assert.equal(DEVICE_TYPES.router.shortLabel, 'Router');
    assert.equal(DEVICE_TYPES.firewall.shortLabel, 'FW');
    assert.equal(DEVICE_TYPES.ap.shortLabel, 'AP');
    assert.equal(DEVICE_TYPES.server.shortLabel, 'Server');
    assert.equal(DEVICE_TYPES.printer.shortLabel, 'Printer');
    assert.equal(DEVICE_TYPES.other.shortLabel, 'etc');
});

test('新規機器配置: 初期状態は未選択(null)で、未選択時のクリックでは配置を作成しない', () => {
    enterPlacementMode({ tab: 'new' });
    assert.equal(placementState.newDeviceType, null);

    const initialPlacementsCount = appState.placements.length;
    const initialDevicesCount = appState.devices.length;

    // 未選択のままキャンバスクリック
    const handled = handleCanvasPlacementClick({ clientX: 300, clientY: 300 });
    assert.equal(handled, true);
    assert.equal(appState.placements.length, initialPlacementsCount);
    assert.equal(appState.devices.length, initialDevicesCount);
    assert.equal(appState.appStatus.dirty, false);
});

test('ゴースト表示: 新規タブで未選択時は非表示、選択後に初めて表示される', async () => {
    const { updatePlacementGhost, setPlacementNewDeviceType } = await import('../public/js/ui/placement-mode.js');
    enterPlacementMode({ tab: 'new' });
    assert.equal(placementState.newDeviceType, null);

    const ghost = document.getElementById('placement-ghost');

    // 未選択状態でマウス移動
    updatePlacementGhost(300, 300);
    assert.equal(ghost.hidden, true);

    // 種別を選択
    setPlacementNewDeviceType('switch');
    updatePlacementGhost(300, 300);
    assert.equal(ghost.hidden, false);
    const ghostLabel = document.getElementById('placement-ghost-label');
    assert.equal(ghostLabel.textContent, 'L2SW');
});

test('ゴースト表示: 未配置タブでキューが空のときは非表示、機器追加後に初めて表示される', async () => {
    const { updatePlacementGhost } = await import('../public/js/ui/placement-mode.js');
    enterPlacementMode({ tab: 'unplaced' });
    assert.equal(placementState.queue.length, 0);

    const ghost = document.getElementById('placement-ghost');

    // キュー空でマウス移動
    updatePlacementGhost(300, 300);
    assert.equal(ghost.hidden, true);

    // キューに機器を追加
    addDevicesToPlacementQueue([2]);
    assert.equal(placementState.queue.length, 1);

    updatePlacementGhost(300, 300);
    assert.equal(ghost.hidden, false);
    const ghostLabel = document.getElementById('placement-ghost-label');
    assert.equal(ghostLabel.textContent, 'フロアSW-01');
});

test('enterPlacementMode: 指定スコープの選択状態を読み上げ、再表示時に同期する', () => {
    const currentBtn = document.getElementById('place-scope-current');
    const allBtn = document.getElementById('place-scope-all');

    // all-viewsで開始
    enterPlacementMode({ tab: 'unplaced', unplacedScope: 'all-views' });
    assert.equal(placementState.unplacedScope, 'all-views');
    assert.equal(currentBtn.getAttribute('aria-pressed'), 'false');
    assert.equal(allBtn.getAttribute('aria-pressed'), 'true');

    // current-viewで開始
    enterPlacementMode({ tab: 'unplaced', unplacedScope: 'current-view' });
    assert.equal(placementState.unplacedScope, 'current-view');
    assert.equal(currentBtn.getAttribute('aria-pressed'), 'true');
    assert.equal(allBtn.getAttribute('aria-pressed'), 'false');
});

test('setPlacementUnplacedScope: スコープ切り替え時に選択済みIDがクリアされキュー混入を防ぐ', () => {
    enterPlacementMode({ tab: 'unplaced', unplacedScope: 'current-view' });
    placementState.selectedUnplacedIds.add(4); // 別ビュー配置済み機器を選択
    assert.equal(placementState.selectedUnplacedIds.has(4), true);

    // all-viewsへスコープ切り替え
    setPlacementUnplacedScope('all-views');
    assert.equal(placementState.unplacedScope, 'all-views');
    assert.equal(placementState.selectedUnplacedIds.size, 0);
    assert.equal(placementState.selectedUnplacedIds.has(4), false);
    assert.equal(document.getElementById('place-scope-current').getAttribute('aria-pressed'), 'false');
    assert.equal(document.getElementById('place-scope-all').getAttribute('aria-pressed'), 'true');
});

function mockPlacementSave(t) {
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        assert.equal(new URL(url, 'http://localhost').searchParams.get('action'), 'save_resources');
        const payload = JSON.parse(options.body);
        calls.push(payload);
        const devices = Object.fromEntries(payload.devices.filter(row => row.operation === 'create')
            .map(row => [row.id, row.id + 1000]));
        const placements = Object.fromEntries(payload.views.flatMap(row => row.placements)
            .map(row => [row.id, row.id + 1000]));
        return new Response(JSON.stringify({
            ok: true, revision: appState.dataRevision + 1,
            id_maps: { devices, views: {}, placements, links: {} },
            devices: payload.devices.map(row => ({
                ...row.device, id: devices[row.id] || row.id,
                resource_revision: (row.expected_revision || 0) + 1
            })),
            views: payload.views.map(row => ({
                ...row.view, resource_revision: (row.expected_revision || 0) + 1
            })),
            placements: payload.views.flatMap(row => row.placements.map(placement => ({
                ...placement, id: placements[placement.id],
                device_id: devices[placement.device_id] || placement.device_id
            }))),
            links: [], canvas_notes: [], deleted_device_ids: [], deleted_view_ids: [],
            affected_view_ids: payload.views.map(row => row.id)
        }));
    });
    return calls;
}

for (const tab of ['new', 'unplaced']) {
    test(`連続配置(${tab}): 最後のクリックから800ms後に最終配置を1要求で保存`, async t => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const calls = mockPlacementSave(t);
        enterPlacementMode({ tab, deviceType: 'router' });
        if (tab === 'unplaced') addDevicesToPlacementQueue([2, 3]);
        handleCanvasPlacementClick({ clientX: 300, clientY: 200 });
        assert.equal(appState.placements.length, 3, '最初の操作は待たずローカル反映');
        t.mock.timers.tick(400);
        handleCanvasPlacementClick({ clientX: 400, clientY: 250 });
        assert.equal(appState.placements.length, 4, '次の操作も待たずローカル反映');
        t.mock.timers.tick(799);
        assert.equal(calls.length, 0);
        const expected = structuredClone(appState.placements.filter(row => row.view_id === 1));
        t.mock.timers.tick(1);
        await setImmediate();
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0].views[0].placements, expected);
        assert.equal(calls[0].devices.length, tab === 'new' ? 2 : 0);
        await exitPlacementMode();
        assert.equal(calls.length, 1, '保存済みの終了では追加要求なし');
    });

    test(`配置終了(${tab}): debounce待機中の最終配置を即時flush`, async t => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const calls = mockPlacementSave(t);
        enterPlacementMode({ tab, deviceType: 'router' });
        if (tab === 'unplaced') addDevicesToPlacementQueue([2, 3]);
        handleCanvasPlacementClick({ clientX: 300, clientY: 200 });
        handleCanvasPlacementClick({ clientX: 400, clientY: 250 });
        assert.equal(calls.length, 0);
        const expected = structuredClone(appState.placements.filter(row => row.view_id === 1));
        await exitPlacementMode();
        assert.equal(isPlacementModeActive(), false);
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0].views[0].placements, expected);
        t.mock.timers.tick(800);
        await setImmediate();
        assert.equal(calls.length, 1, '終了で待機timerを取り消す');
    });
}

test('配置を変更せず終了するとAPIを呼ばない', async t => {
    const calls = mockPlacementSave(t);
    enterPlacementMode({ tab: 'new', deviceType: 'router' });
    await exitPlacementMode();
    assert.equal(calls.length, 0);
});

test('保存で仮ID再採番後も同じ種別のスタンプ配置を継続できる', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const calls = mockPlacementSave(t);
    enterPlacementMode({ tab: 'new', deviceType: 'router' });
    handleCanvasPlacementClick({ clientX: 300, clientY: 200 });
    handleCanvasPlacementClick({ clientX: 400, clientY: 250 });
    await flushSaveQueue({ silent: true });
    assert.equal(calls.length, 1);
    assert.ok(appState.devices.some(row => row.id === 1010));
    assert.equal(placementState.newDeviceType, 'router');
    assert.equal(isPlacementModeActive(), true);
    handleCanvasPlacementClick({ clientX: 500, clientY: 300 });
    const newest = appState.devices.at(-1);
    assert.equal(newest.type, 'router');
    assert.ok(newest.id > 1011, '再採番後の機器とIDが重複しない');
    const temporaryId = newest.id;
    await exitPlacementMode();
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].devices.map(row => row.id), [temporaryId]);
    assert.equal(newest.id, temporaryId + 1000, '後続スタンプの保存応答も再採番される');
    assert.equal(calls[1].views[0].placements.length, 4);
});
test('安全整数上限付近の既存IDがあっても仮IDは安全な整数範囲の未使用値を割り当てる', async () => {
    const { appState, recalculateNextIds, allocateLocalId, calculateNextAvailableId } = await import('../public/js/core/state.js');
    appState.devices = [
        { id: 1, name: '機器1' },
        { id: 2, name: '機器2' },
        { id: Number.MAX_SAFE_INTEGER - 1, name: '復元上限機器' },
        { id: Number.MAX_SAFE_INTEGER, name: '最大機器' },
    ];
    recalculateNextIds();
    assert.equal(Number.isSafeInteger(appState.nextDeviceId), true);
    assert.equal(appState.nextDeviceId, 3);

    const first = allocateLocalId('devices');
    assert.equal(first, 3);
    const second = allocateLocalId('devices');
    assert.equal(second, 4);

    // 未保存機器の追加・削除・再追加でも安全な正の整数が返る
    appState.devices.push({ id: first, name: '仮機器1' });
    const third = allocateLocalId('devices');
    assert.equal(third, 4);
    // 削除（未保存取り消し）
    appState.devices.pop();
    recalculateNextIds();
    const fourth = allocateLocalId('devices');
    assert.equal(fourth, 3);
    assert.equal(Number.isSafeInteger(fourth), true);
    assert.ok(fourth > 0 && fourth <= Number.MAX_SAFE_INTEGER);
});
