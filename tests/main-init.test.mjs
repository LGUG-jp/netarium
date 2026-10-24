import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import {
    applyResourceSaveResult, buildResourceSave, buildSaveableResourceSave, createResourceBaseline, createPendingResourceSave,
    inspectPendingResourceSave, resetResourceBaseline, syncResourceRevision, reloadResourceFromData
} from '../public/js/core/resource-save.js';
import { appState, toSaveDevice, toSaveView } from '../public/js/core/state.js';

test('起動時に直接リンクのビューを読み込み、追加したビューを保存できる', async (t) => {
    const elements = new Map();
    const mockEl = (id = '') => ({
        id,
        value: '', textContent: '', children: [], hidden: true, listeners: new Map(),
        setAttribute() {}, removeAttribute() {}, getAttribute() { return null; },
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        style: {}, dataset: {},
        appendChild(child) { child.parentElement = this; this.children.push(child); },
        append(...children) { children.forEach(child => this.appendChild(child)); },
        replaceChildren(...children) { this.children = children; },
        querySelector() { return null; }, querySelectorAll() { return []; },
        addEventListener(type, listener) {
            if (!this.listeners.has(type)) this.listeners.set(type, []);
            this.listeners.get(type).push(listener);
        },
        removeEventListener() {},
        async dispatch(type, extra = {}) {
            const event = { type, target: this, currentTarget: this, preventDefault() {}, ...extra };
            let result;
            for (const listener of this.listeners.get(type) || []) result = await listener(event);
            return result;
        },
        getBoundingClientRect() {
            return { left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800 };
        }
    });
    const getElement = id => {
        // この起動fixtureには台帳の一覧・フィルターを配置しない。
        if (id === 'ledger-table-body' || (id.startsWith('ledger-') && id.endsWith('-filter'))) return null;
        if (!elements.has(id)) elements.set(id, mockEl(id));
        return elements.get(id);
    };
    getElement('canvas-note-layer');
    for (const id of ['note-background-color', 'note-text-color']) {
        mockEl().append(getElement(id), getElement(`${id}-options`));
    }
    const originalGlobals = new Map(['window', 'document', 'fetch', 'confirm'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    t.after(() => {
        for (const [key, descriptor] of originalGlobals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    });
    const errors = [];
    t.mock.method(console, 'error', (...args) => errors.push(args));
    globalThis.window = {
        addEventListener() {}, location: { search: '?view=12', reload() {} },
        clearTimeout() {}, setTimeout() { return 0; },
        APP_CONFIG: { user: { isAdmin: true }, csrfToken: 'test-only-token' }
    };
    globalThis.document = {
        body: mockEl(), addEventListener() {}, getElementById: getElement,
        querySelector: () => null, querySelectorAll: () => [], createElement: mockEl
    };
    const view = { id: 1, resource_revision: 1, name: '試験ビュー', facility: '', floor: '', view_type: 'topology', sort_order: 10, memo: '' };
    const linkedView = { ...view, id: 12, name: '共有先', sort_order: 20 };
    let savedPayload;
    const startupRequests = [];
    globalThis.fetch = async (url, options) => {
        startupRequests.push(url);
        if (url.includes('action=load')) {
            return new Response(JSON.stringify({ revision: 1, views: [view, linkedView], devices: [], placements: [], links: [], floor_plans: [], device_images: [] }));
        }
        assert.ok(url.includes('action=save_resources'), `想定外のAPI: ${url}`);
        savedPayload = JSON.parse(options.body);
        const savedView = { ...savedPayload.views[0].view, id: 101, resource_revision: 1 };
        return new Response(JSON.stringify({
            ok: true, revision: 2, saved_at: '2026-10-02T00:00:00+09:00',
            id_maps: { views: { 2: 101 } }, devices: [], views: [savedView],
            placements: [], links: [], canvas_notes: [], affected_view_ids: [101], deleted_device_ids: [], deleted_view_ids: []
        }));
    };
    await import('../public/js/main.js');
    // init()の非同期読込とfinallyを待ち、握りつぶされた例外も失敗として扱う。
    await setImmediate();
    const state = window.appState;
    assert.deepEqual(errors, []);
    assert.equal(state.noteLayer, getElement('canvas-note-layer'));
    assert.equal(state.noteLayer.id, 'canvas-note-layer');
    assert.equal(state.currentViewId, 12);
    assert.equal(state.appStatus.state, 'saved');
    assert.deepEqual(state.views, [view, linkedView]);
    assert.equal(startupRequests.length, 1);
    assert.ok(startupRequests[0].includes('action=load'), 'リンクを開くだけでは保存やPingを実行しない');

    const addedView = { ...view, id: 2, name: '追加ビュー', sort_order: 20 };
    state.views.push(addedView);
    state.appStatus.dirty = true;
    state.currentViewId = 2;
    state.viewStates.set(2, { scale: 1.5, panX: 25, panY: 40 });
    Object.assign(state.viewState, { scale: 1.5, panX: 25, panY: 40 });
    assert.equal(await getElement('saveBtn').dispatch('click'), true);
    assert.equal(state.currentViewId, 101);
    assert.equal(state.views.find(row => row.id === 101).resource_revision, 1);
    assert.deepEqual(state.viewStates.get(101), { scale: 1.5, panX: 25, panY: 40 });
    assert.equal(state.viewStates.has(2), false);
    assert.equal(state.views.find(row => row.id === 1).name, view.name);
    assert.equal(state.dataRevision, 2);
    assert.equal(state.appStatus.dirty, false);
    assert.deepEqual(errors, []);

    state.views.find(row => row.id === 101).name = '再編集';
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, error: 'busy' }), { status: 503 });
    assert.equal(await window.saveData(), false);
    assert.equal(state.appStatus.state, 'unconfirmed');
    assert.notEqual(window.getPendingSave(), null, '503だけではロールバック済みと断定しない');
    globalThis.fetch = async () => new Response(JSON.stringify({
        revision: 2, views: [...state.views], devices: [], placements: [], links: []
    }));
    assert.equal(await window.confirmPendingSave(), 'retry');
    assert.equal(window.getPendingSave(), null);
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, error: 'server error' }), { status: 500 });
    assert.equal(await window.saveData(), false);
    assert.equal(state.appStatus.state, 'unconfirmed');
    assert.notEqual(window.getPendingSave(), null, '500はコミット成否を断定しない');
    globalThis.fetch = async () => new Response(JSON.stringify({
        revision: 2, views: [...state.views], devices: [], placements: [], links: []
    }));
    assert.equal(await window.confirmPendingSave(), 'retry');
    assert.equal(window.getPendingSave(), null);

    let requests = 0;
    state.views.push({ ...addedView, id: 102, name: '通信不明の新規ビュー' });
    globalThis.fetch = async () => {
        requests++;
        return new Response(JSON.stringify({ ok: false, error: 'busy' }), { status: 503 });
    };
    assert.equal(await window.saveData(), false);
    const pending = window.getPendingSave();
    assert.equal(state.appStatus.state, 'unconfirmed');
    assert.equal(await window.saveData(), false);
    assert.equal(requests, 1, '未確定作成は再送しない');
    globalThis.fetch = async () => new Response(JSON.stringify({
        revision: 10, views: [...state.views], devices: [], placements: [], links: []
    }));
    assert.equal(await window.confirmPendingSave(), 'unknown');
    assert.equal(window.getPendingSave(), pending, '内容一致だけで作成IDを推測しない');
    globalThis.confirm = () => true;
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, error: 'busy' }), { status: 503 });
    await window.reloadDataWithConfirmation();
    assert.equal(window.getPendingSave(), pending, '再読込失敗で未確定作成の再送制限を解除しない');
    state.currentViewId = 1;
    globalThis.fetch = async () => new Response(JSON.stringify({
        revision: 10, views: [view, linkedView], devices: [], placements: [], links: []
    }));
    assert.equal(await window.loadData(), true);
    assert.equal(state.currentViewId, 1, '通常の再読込ではURLによる自動遷移を繰り返さない');
});

function resourceFixture() {
    return {
        views: [{ id: 1, name: '配置図', resource_revision: 4 }],
        devices: [
            { id: 1, name: 'Router', type: 'router', resource_revision: 3 },
            { id: 2, name: 'Switch', type: 'switch', resource_revision: 7 }
        ],
        placements: [
            { id: 1, device_id: 1, view_id: 1, x: 10, y: 20 },
            { id: 2, device_id: 2, view_id: 1, x: 30, y: 40 }
        ],
        links: [{ id: 1, view_id: 1, from_id: 1, to_id: 2, label: 'LAN' }]
    };
}

test('機器属性の変更と機器削除cascadeはビュー保存を要求しない', () => {
    const data = resourceFixture();
    const baseline = createResourceBaseline(data);
    data.devices[0].name = 'Router renamed';
    let payload = buildResourceSave(data, baseline);
    assert.deepEqual(payload.devices.map(row => [row.operation, row.id, row.expected_revision]), [['update', 1, 3]]);
    assert.deepEqual(payload.views, []);
    data.devices = data.devices.filter(row => row.id !== 1);
    data.placements = data.placements.filter(row => row.device_id !== 1);
    data.links = [];
    payload = buildResourceSave(data, baseline);
    assert.deepEqual(payload, { devices: [{ operation: 'delete', id: 1, expected_revision: 3 }], views: [] });
    assert.deepEqual(createPendingResourceSave(payload, baseline, data).affectedViewIds, [1]);
    data.placements[0].x = 50;
    payload = buildResourceSave(data, baseline);
    assert.equal(payload.views[0].expected_revision, 4);
    assert.deepEqual(payload.views[0].placements.map(row => row.device_id), [2]);
});

test('未確認保存は対象リソースだけを確認し、作成ID未確定では再送を許可しない', () => {
    const data = resourceFixture();
    const baseline = createResourceBaseline(data);
    data.devices[0].name = 'Router renamed';
    const pending = createPendingResourceSave(buildResourceSave(data, baseline), baseline, data);
    const db = resourceFixture();
    db.revision = 999;
    db.devices[1].name = 'Other tab';
    db.devices[1].resource_revision = 8;
    assert.equal(inspectPendingResourceSave(pending, db), 'retry');
    db.devices[0] = { ...data.devices[0], resource_revision: 4 };
    assert.equal(inspectPendingResourceSave(pending, db), 'saved');
    db.devices[0].name = 'Conflicting change';
    assert.equal(inspectPendingResourceSave(pending, db), 'conflict');
    data.devices.push({ id: 3, name: 'New device' });
    const creating = createPendingResourceSave(buildResourceSave(data, baseline), baseline, data);
    assert.equal(inspectPendingResourceSave(creating, resourceFixture()), 'unknown');
    const topology = resourceFixture();
    topology.links.push({ id: 2, view_id: 1, from_id: 1, to_id: 2, label: 'Second cable' });
    const topologyPending = createPendingResourceSave(buildResourceSave(topology, baseline), baseline, topology);
    assert.equal(inspectPendingResourceSave(topologyPending, resourceFixture()), 'retry');
    topology.views[0].resource_revision = 5;
    topology.links[1].id = 100;
    assert.equal(inspectPendingResourceSave(topologyPending, topology), 'unknown');
});

test('保存IDを選択・画像・図面に反映し、後続編集と保存版番号を維持する', (t) => {
    const previous = { ...appState };
    t.after(() => {
        Object.assign(appState, previous);
        resetResourceBaseline(appState);
    });
    Object.assign(appState, {
        devices: [{ id: 1, name: 'New router', type: 'router' }, { id: 2, name: 'New switch', type: 'switch' }],
        views: [{ id: 1, name: 'New floor', view_type: 'floor' }],
        placements: [
            { id: 1, device_id: 1, view_id: 1, x: 20, y: 30 },
            { id: 2, device_id: 2, view_id: 1, x: 50, y: 30 }
        ],
        links: [{ id: 1, view_id: 1, from_id: 1, to_id: 2, label: 'LAN' }],
        currentViewId: 1, editingDeviceId: 1, editingLinkId: 1, linkSourceId: 1,
        ledgerSearchHighlightDeviceId: 1,
        selectedPlacementIds: new Set([1]),
        floorPlanAutoFittedViews: new Set([1]), viewStates: new Map([[1, { scale: 2 }]]),
        deviceImages: [{ id: 77, device_id: 1 }],
        floorPlans: [{ view_id: 1 }]
    });
    resetResourceBaseline({});
    const pending = createPendingResourceSave(buildResourceSave());
    const savedDevice = { ...toSaveDevice(appState.devices[0]), id: 101, resource_revision: 1 };
    const savedDevice2 = { ...toSaveDevice(appState.devices[1]), id: 102, resource_revision: 1 };
    const savedView = { ...toSaveView(appState.views[0]), id: 201, resource_revision: 1 };
    appState.devices[0].memo = 'Edit made while checking';
    applyResourceSaveResult({
        revision: 2,
        id_maps: { devices: { 1: 101, 2: 102 }, views: { 1: 201 }, placements: { 1: 301, 2: 302 }, links: { 1: 401 } },
        devices: [savedDevice, savedDevice2], views: [savedView],
        placements: [
            { id: 301, device_id: 101, view_id: 201, x: 20, y: 30 },
            { id: 302, device_id: 102, view_id: 201, x: 50, y: 30 }
        ],
        links: [{ id: 401, view_id: 201, from_id: 101, to_id: 102, label: 'LAN' }],
        canvas_notes: [],
        deleted_device_ids: [], deleted_view_ids: [], affected_view_ids: [201]
    }, pending);
    assert.equal(appState.devices[0].id, 101);
    assert.equal(appState.devices[0].memo, 'Edit made while checking');
    assert.equal(appState.editingDeviceId, 101);
    assert.equal(appState.editingLinkId, 401);
    assert.equal(appState.linkSourceId, 101);
    assert.deepEqual([...appState.selectedPlacementIds], [301]);
    assert.equal(appState.currentViewId, 201);
    assert.equal(appState.viewStates.get(201).scale, 2);
    assert.deepEqual([...appState.floorPlanAutoFittedViews], [201]);
    assert.equal(appState.deviceImages[0].device_id, 101);
    assert.equal(appState.floorPlans[0].view_id, 201);
    let remaining = buildResourceSave();
    assert.deepEqual(remaining.devices.map(row => [row.operation, row.id, row.expected_revision]), [['update', 101, 1]]);
    assert.deepEqual(remaining.views, []);
    syncResourceRevision('devices', 101, 2);
    remaining = buildResourceSave();
    assert.equal(remaining.devices[0].expected_revision, 2);
});

test('保存状態確認までに削除した機器・ビューを応答で復活させない', (t) => {
    const previous = { ...appState };
    t.after(() => {
        Object.assign(appState, previous);
        resetResourceBaseline(appState);
    });
    Object.assign(appState, resourceFixture(), {
        floorPlans: [], deviceImages: [], currentViewId: 1,
        selectedPlacementIds: new Set(), viewStates: new Map(),
        floorPlanAutoFittedViews: new Set()
    });
    resetResourceBaseline(appState);
    appState.devices[0].memo = '送信済みの編集';
    appState.views[0].memo = '送信済みのビュー編集';
    const pending = createPendingResourceSave(buildResourceSave());
    const device = { ...toSaveDevice(appState.devices[0]), resource_revision: 10 };
    const view = { ...toSaveView(appState.views[0]), resource_revision: 11 };
    const placements = structuredClone(appState.placements);
    const links = structuredClone(appState.links);
    appState.devices = appState.devices.filter(row => row.id !== 1);
    appState.views = [];
    appState.placements = [];
    appState.links = [];
    applyResourceSaveResult({
        revision: 2, id_maps: {}, devices: [device], views: [view], placements, links, canvas_notes: [],
        deleted_device_ids: [], deleted_view_ids: [], affected_view_ids: [1]
    }, pending);
    assert.deepEqual(appState.devices.map(row => row.id), [2]);
    assert.deepEqual(appState.views, []);
    assert.deepEqual(appState.placements, []);
    assert.deepEqual(appState.links, []);
    const remaining = buildResourceSave();
    assert.deepEqual(remaining.devices, [{ operation: 'delete', id: 1, expected_revision: 10 }]);
    assert.deepEqual(remaining.views, [{ operation: 'delete', id: 1, expected_revision: 11 }]);
});

test('サーバー採番IDと後から追加した仮IDが重なっても機器を混同しない', (t) => {
    const previous = { ...appState };
    t.after(() => {
        Object.assign(appState, previous);
        resetResourceBaseline(appState);
    });
    Object.assign(appState, resourceFixture(), {
        floorPlans: [], deviceImages: [], currentViewId: 1,
        selectedPlacementIds: new Set(), viewStates: new Map(),
        floorPlanAutoFittedViews: new Set()
    });
    resetResourceBaseline(appState);
    appState.devices.push({ id: 3, name: '保存対象の新規機器', type: 'switch' });
    const pending = createPendingResourceSave(buildResourceSave());
    appState.devices.push({ id: 4, name: '送信後に追加した機器', type: 'ap' });
    appState.placements.push({ id: 3, device_id: 4, view_id: 1, x: 50, y: 60 });
    appState.editingDeviceId = 4;
    applyResourceSaveResult({
        revision: 2, id_maps: { devices: { 3: 4 } },
        devices: [{ id: 4, name: '保存対象の新規機器', type: 'switch', resource_revision: 10 }],
        views: [], placements: [], links: [], canvas_notes: [],
        deleted_device_ids: [], deleted_view_ids: [], affected_view_ids: []
    }, pending);
    const saved = appState.devices.find(row => row.id === 4);
    const later = appState.devices.find(row => row.name === '送信後に追加した機器');
    assert.equal(saved.name, '保存対象の新規機器');
    assert.notEqual(later.id, 4);
    assert.equal(appState.editingDeviceId, later.id);
    assert.equal(appState.placements.find(row => row.id === 3).device_id, later.id);
    const remaining = buildResourceSave();
    assert.deepEqual(remaining.devices.map(row => [row.operation, row.id]), [['create', later.id]]);
});

test('機器削除応答は他利用者の追加配置を消さず、保存中の配置移動も保持する', t => {
    const previous = { ...appState };
    t.after(() => { Object.assign(appState, previous); resetResourceBaseline(appState); });
    for (const [moveDuringSave, remoteAddition] of [[false, true], [true, true], [true, false]]) {
        Object.assign(appState, resourceFixture(), {
            floorPlans: [], deviceImages: [], currentViewId: 1,
            selectedPlacementIds: new Set(), viewStates: new Map(),
            floorPlanAutoFittedViews: new Set(),
            resourceConflicts: { devices: new Map(), views: new Map() }
        });
        resetResourceBaseline(appState);
        appState.devices = appState.devices.filter(row => row.id !== 1);
        appState.placements = appState.placements.filter(row => row.device_id !== 1);
        appState.links = [];
        const pending = createPendingResourceSave(buildResourceSave());
        if (moveDuringSave) appState.placements[0].x = 70;
        applyResourceSaveResult({
            revision: 20, id_maps: {},
            devices: [
                { id: 2, name: 'Switch', type: 'switch', resource_revision: 7 },
                { id: 3, name: '他利用者の追加機器', type: 'ap', resource_revision: 8 }
            ],
            views: [{ id: 1, name: '配置図', resource_revision: 9 }],
            placements: [
                { id: 2, device_id: 2, view_id: 1, x: 30, y: 40 },
                ...(remoteAddition ? [{ id: 3, device_id: 3, view_id: 1, x: 50, y: 60 }] : [])
            ],
            links: [], canvas_notes: [], deleted_device_ids: [1], deleted_view_ids: [], affected_view_ids: [1]
        }, pending);
        if (moveDuringSave) {
            assert.equal(appState.placements.find(row => row.id === 2).x, 70);
            assert.equal(buildResourceSave().views[0].expected_revision, 9);
            assert.equal(appState.resourceConflicts.views.has(1), remoteAddition,
                '自分の削除cascadeだけで進んだrevisionは競合と誤認しない');
            assert.equal(buildSaveableResourceSave().views.length, remoteAddition ? 0 : 1);
        } else {
            assert.equal(appState.placements.find(row => row.id === 3)?.device_id, 3);
            assert.deepEqual(buildResourceSave(), { devices: [], views: [] });
        }
    }
});

test('削除中の二端機器の片方を再読込しても他方へのリンクは復活しない', t => {
    const previous = { ...appState };
    t.after(() => { Object.assign(appState, previous); resetResourceBaseline(appState); });
    const remote = resourceFixture();
    Object.assign(appState, resourceFixture(), {
        floorPlans: [], deviceImages: [], currentViewId: 1,
        selectedPlacementIds: new Set(), viewStates: new Map(),
        floorPlanAutoFittedViews: new Set(),
        resourceConflicts: { devices: new Map(), views: new Map() }
    });
    resetResourceBaseline(appState);
    appState.devices = [];
    appState.placements = [];
    appState.links = [];
    reloadResourceFromData('devices', 1, remote);
    assert.deepEqual(appState.devices.map(row => row.id), [1]);
    assert.deepEqual(appState.links, []);
    assert.deepEqual(buildResourceSave(), {
        devices: [{ operation: 'delete', id: 2, expected_revision: 7 }], views: []
    });
});
