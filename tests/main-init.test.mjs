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
    class StartupElement {}
    const mockEl = (id = '') => Object.assign(new StartupElement(), {
        id,
        value: '', textContent: '', children: [], hidden: true, listeners: new Map(),
        clientWidth: 1000, clientHeight: 800,
        setAttribute() {}, removeAttribute() {}, getAttribute() { return null; },
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        style: {}, dataset: {},
        appendChild(child) { child.parentElement = this; this.children.push(child); },
        append(...children) { children.forEach(child => this.appendChild(child)); },
        prepend(child) { child.parentElement = this; this.children.unshift(child); },
        remove() {
            if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
            this.parentElement = null;
        },
        replaceChildren(...children) { this.children = children; },
        querySelector(selector) {
            const tag = selector.toUpperCase();
            for (const child of this.children) {
                if (child.tagName === tag) return child;
                const match = child.querySelector(selector);
                if (match) return match;
            }
            return null;
        },
        querySelectorAll() { return []; }, closest() { return null; },
        contains(node) { return node === this || this.children.some(child => child.contains(node)); },
        focus() { document.activeElement = this; },
        scrollIntoView() {},
        addEventListener(type, listener) {
            if (!this.listeners.has(type)) this.listeners.set(type, []);
            this.listeners.get(type).push(listener);
        },
        removeEventListener(type, listener) {
            this.listeners.set(type, (this.listeners.get(type) || []).filter(entry => entry !== listener));
        },
        async dispatch(type, extra = {}) {
            const event = {
                type, target: this, currentTarget: this, preventDefault() {},
                stopImmediatePropagation() { this.stopped = true; }, ...extra
            };
            let result;
            for (const listener of this.listeners.get(type) || []) {
                result = await listener(event);
                if (event.stopped) break;
            }
            return result;
        },
        getBoundingClientRect() {
            return { left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800 };
        }
    });
    const find = (element, id) => element.id === id ? element :
        element.children.map(child => find(child, id)).find(Boolean);
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
    const originalGlobals = new Map(['window', 'document', 'fetch', 'confirm', 'HTMLElement', 'ResizeObserver']
        .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    t.after(() => {
        for (const [key, descriptor] of originalGlobals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    });
    const errors = [];
    t.mock.method(console, 'error', (...args) => errors.push(args));
    const browserStorage = new Map([['netarium.lastViewId', '1']]);
    const windowEvents = new Map();
    globalThis.window = {
        addEventListener(type, callback) { windowEvents.set(type, callback); }, location: { search: '?view=12', reload() {} },
        localStorage: {
            getItem: key => browserStorage.get(key) ?? null,
            setItem: (key, value) => browserStorage.set(key, value)
        },
        clearTimeout() {}, setTimeout() { return 0; },
        APP_CONFIG: { user: { isAdmin: true }, csrfToken: 'test-only-token' }
    };
    const documentCapture = mockEl();
    globalThis.HTMLElement = StartupElement;
    globalThis.document = {
        body: mockEl(),
        // 実ブラウザーのフォーカス移動やイベント伝播は再現せず、文書のcaptureリスナーを直接検証する。
        addEventListener(type, listener, capture) {
            if (capture === true) documentCapture.addEventListener(type, listener);
        },
        removeEventListener(type, listener, capture) {
            if (capture === true) documentCapture.removeEventListener(type, listener);
        },
        // 動的な一覧コントロールは生成された実ノードだけを検索する。
        getElementById: id => id.startsWith('workspace-nav-') && !['workspace-nav-panel', 'workspace-nav-content'].includes(id)
            ? find(document.body, id) ?? null
            : getElement(id),
        querySelector: () => null, querySelectorAll: () => [],
        createElement: tag => Object.assign(mockEl(tag), { tagName: tag.toUpperCase() }),
        createElementNS: (_namespace, tag) => mockEl(tag)
    };
    const view = { id: 1, resource_revision: 1, name: '試験ビュー', facility: '', floor: '', floor_id: null, view_type: 'topology', show_connections: 1, sort_order: 10, memo: '' };
    const linkedView = { ...view, id: 12, name: '共有先', sort_order: 20 };
    const held = { legacy_link_id: 1, view_id: 1, device_a_id: 1, device_b_id: 2,
        reason: 'port_collision', payload: { from_id: 1, to_id: 2 } };
    let savedPayload;
    const startupRequests = [];
    globalThis.fetch = async (url, options) => {
        startupRequests.push(url);
        if (url.includes('action=load')) {
            return new Response(JSON.stringify({ revision: 1, views: [view, linkedView], devices: [], placements: [], links: [],
                floor_plans: [], device_images: [], legacy_link_conflicts: [held] }));
        }
        assert.ok(url.includes('action=save_resources'), `想定外のAPI: ${url}`);
        savedPayload = JSON.parse(options.body);
        const savedView = { ...savedPayload.views[0].view, id: 101, resource_revision: 1 };
        return new Response(JSON.stringify({
            ok: true, revision: 2, saved_at: '2026-10-02T00:00:00+09:00',
            id_maps: { views: { 2: 101 } }, devices: [], views: [savedView],
            placements: [], view_link_routes: [], canvas_notes: [], affected_view_ids: [101], deleted_device_ids: [], deleted_view_ids: []
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
    assert.equal(browserStorage.get('netarium.lastViewId'), '12', '明示URLの表示先を最後のビューとして記録する');
    assert.equal(getElement('canvas-view-controls').hidden, false);
    await getElement('zoom-in-btn').dispatch('click');
    assert.equal(getElement('zoom-label').textContent, '125%');
    await getElement('zoom-out-btn').dispatch('click');
    assert.equal(getElement('zoom-label').textContent, '100%');
    await getElement('zoom-out-btn').dispatch('click');
    await getElement('zoom-reset-btn').dispatch('click');
    assert.equal(getElement('zoom-label').textContent, '100%');
    await getElement('zoom-in-btn').dispatch('click');
    await getElement('zoom-fit-btn').dispatch('click');
    assert.equal(getElement('zoom-label').textContent, '100%'); // 空のビューの「全体」は既定表示へ戻す。
    const badge = getElement('palette-nav-legacy-badge');
    assert.equal(badge.hidden, true, '直リンクで開いたビューに他ビューの保留を数えない');
    assert.equal(await window.switchView(1), true);
    assert.equal(browserStorage.get('netarium.lastViewId'), '1');
    assert.equal(badge.hidden, false);
    assert.equal(badge.textContent, '要確認 1');
    assert.equal(await window.switchView(12), true);
    assert.equal(browserStorage.get('netarium.lastViewId'), '12');
    assert.equal(badge.hidden, true);
    state.currentViewId = null;
    assert.equal(await window.loadData({ initialSearch: '' }), true, 'F5相当の初期ロード');
    assert.equal(state.currentViewId, 12);
    assert.equal(state.appStatus.dirty, false);
    assert.ok(startupRequests.every(url => url.includes('action=load')), '切替と復元で保存やPingを実行しない');
    state.currentViewId = null;
    browserStorage.set('netarium.lastViewId', '999');
    assert.equal(await window.loadData({ initialSearch: '' }), true);
    assert.equal(state.currentViewId, 1, '削除済みの保存先は先頭へ戻す');
    state.currentViewId = null;
    assert.equal(await window.loadData({ initialSearch: '?view=12' }), true);
    assert.equal(state.currentViewId, 12);

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
        revision: 10, views: [view, linkedView], devices: [], placements: [], links: [], legacy_link_conflicts: [held]
    }));
    assert.equal(await window.loadData(), true);
    assert.equal(state.currentViewId, 1, '通常の再読込ではURLによる自動遷移を繰り返さない');
    assert.equal(badge.textContent, '要確認 1');
    const hierarchy = await import('../public/js/modals/building-hierarchy-editor.js');
    state.buildings = [{ id: 501, name: '検証棟', sort_order: 0, building_view_enabled: 1 }];
    state.floors = [{ id: 502, building_id: 501, name: '1F', sort_order: 0, representative_view_id: null }];
    const unload = () => {
        let prevented = false;
        windowEvents.get('beforeunload')({ preventDefault() { prevented = true; }, returnValue: undefined });
        return prevented;
    };
    assert.equal(unload(), false, '保存済み状態では警告しない');
    for (const selection of [{ kind: 'building', id: 501 }, { kind: 'floor', id: 502 }]) {
        hierarchy.renderHierarchyEditor(getElement('hierarchy-editor'), selection, () => {});
        assert.equal(unload(), false, '表示だけでは下書きにしない');
        const input = find(getElement('hierarchy-editor'), 'hierarchy-name');
        input.value = '未適用の名称'; await input.dispatch('input');
        assert.equal(state.appStatus.dirty, false);
        assert.equal(window.hasAnyUnappliedChanges(), true);
        assert.equal(unload(), true, '建物・フロア下書きだけでも再読込・ページ離脱を保護する');
        hierarchy.clearHierarchyEditor();
        assert.equal(unload(), false, '破棄後は離脱を妨げない');
    }
    hierarchy.renderHierarchyEditor(getElement('hierarchy-editor'), { kind: 'floor', id: 502 }, () => {});
    const input = find(getElement('hierarchy-editor'), 'hierarchy-name');
    input.value = '再読込前の下書き'; await input.dispatch('input');
    const { eventBus } = await import('../public/js/core/event-bus.js');
    eventBus.emit('resources:reloaded');
    assert.equal(unload(), false, '確認済みの全再読込後は古い階層下書きの離脱警告を残さない');

    const { closeBuildingView, getOpenBuildingId } = await import('../public/js/ui/building-view.js');
    const { registerModalOpen, registerModalClose } = await import('../public/js/core/modal-focus.js');
    const drawer = getElement('workspace-nav-panel');
    const drawerButton = getElement('palette-nav-btn');
    const search = getElement('view-search-input');
    const switcher = getElement('view-switcher');
    drawer.append(getElement('workspace-nav-content'));
    switcher.append(search, getElement('view-search-popup'));
    document.body.append(drawer, drawerButton, switcher, state.canvas);
    globalThis.ResizeObserver = class { observe() {} disconnect() {} };
    window.requestAnimationFrame = callback => callback();
    const buildingRequests = [];
    globalThis.fetch = async url => {
        buildingRequests.push(url);
        throw new Error(`建物表示中の想定外のAPI: ${url}`);
    };
    const chooseBuilding = async (name = '検証棟') => {
        search.value = name;
        await search.dispatch('input');
        await search.dispatch('keydown', { key: 'Enter' });
    };
    window.openWorkspaceNavigation();
    assert.equal(drawer.hidden, false);
    try {
        state.isPinging = true;
        await chooseBuilding();
        assert.equal(getOpenBuildingId(), null);
        assert.equal(drawer.hidden, false, 'Pingで切替を止めても一覧は閉じない');
        state.isPinging = false;
        state.authExpired = true;
        await chooseBuilding();
        assert.equal(getOpenBuildingId(), null);
        assert.equal(drawer.hidden, false, '管理者の保存ガードで切替を止めても一覧は閉じない');
        state.authExpired = false;

        window.APP_CONFIG.user.isAdmin = false;
        let cancelledRange = false;
        state.linkMode = true;
        state.isRangeSelecting = true;
        state.cancelActiveRangeSelection = () => { cancelledRange = true; state.isRangeSelecting = false; };
        drawerButton.focus = () => { assert.notEqual(drawer.inert, true, '一覧は背景を操作不能にする前に閉じる'); };
        const linkPanel = getElement('link-panel');
        linkPanel.hidden = false;
        search.value = '検証棟';
        await search.dispatch('input');
        const opening = search.dispatch('keydown', { key: 'Enter' });
        state.buildings[0].building_view_enabled = 0;
        await opening;
        assert.equal(linkPanel.hidden, false, '機器パネル終了待ちの間に無効になったら続く操作を行わない');
        assert.equal(getOpenBuildingId(), null);
        assert.equal(drawer.hidden, false);
        assert.equal(state.linkMode, true);
        assert.equal(cancelledRange, false);
        await chooseBuilding();
        assert.equal(getOpenBuildingId(), null, '無効な建物は検索からも開かない');
        state.buildings[0].building_view_enabled = 1;
        await chooseBuilding();
        assert.equal(getOpenBuildingId(), 501, '閲覧者は保存フラッシュなしで建物を開ける');
        assert.equal(state.linkMode, false, '配線作成モードを終了して建物ビューへ移る');
        assert.equal(cancelledRange, true, '範囲選択を解除して建物ビューへ移る');
        assert.equal(state.currentViewId, 1, '建物表示は平面のビュー選択を変更しない');
        assert.equal(drawer.hidden, true);
        assert.equal(drawer.inert, true);
        assert.equal(badge.hidden, true, '建物表示中は背後の平面ビューの保留を数えない');
        assert.deepEqual(buildingRequests, []);

        let shortcutPrevented = false;
        await documentCapture.dispatch('keydown', {
            target: document.activeElement, key: 'k', ctrlKey: true,
            preventDefault() { shortcutPrevented = true; }
        });
        assert.equal(shortcutPrevented, false, '建物表示中に通常のキャンバスショートカットを実行しない');

        const modal = mockEl('building-test-modal');
        modal.hidden = false;
        registerModalOpen(modal.id, modal, null, { onClose: () => {
            modal.hidden = true;
            registerModalClose(modal.id, { restoreFocus: false });
        } });
        try {
            await documentCapture.dispatch('keydown', { target: modal, key: 'Escape' });
            assert.equal(modal.hidden, true, '建物表示中も共有モーダルはEscapeで閉じる');
            assert.equal(getOpenBuildingId(), 501);
        } finally {
            registerModalClose(modal.id, { restoreFocus: false });
        }

        state.buildings.push({ id: 502, name: '比較別棟', building_view_enabled: 1 });
        eventBus.emit('hierarchy:changed');
        const primaryPanel = state.canvas.children.find(node => node.className === 'building-view');
        const add = find(primaryPanel, 'building-view-compare-building').parentElement.querySelector('button');
        await add.dispatch('click');
        assert.equal(getOpenBuildingId(), 501, '比較中もツールバーの主建物は変わらない');
        assert.match(primaryPanel.querySelector('h2').textContent, /比較別棟.*2棟比較/);
        await chooseBuilding('比較別棟');
        assert.equal(getOpenBuildingId(), 502);
        const secondaryPanel = state.canvas.children.find(node => node.className === 'building-view');
        assert.equal(secondaryPanel.querySelector('h2').textContent, '比較別棟 — 建物全体',
            '比較に表示中の別棟をツールバーで選んだときは、単一表示で開き直す');
        assert.equal(await closeBuildingView(), true);
        assert.equal(badge.hidden, false);
        assert.equal(badge.textContent, '要確認 1');
    } finally {
        state.isPinging = false;
        state.authExpired = false;
        await closeBuildingView();
        window.closeWorkspaceNavigation();
    }
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
        links: [{ id: 1, from_id: 1, to_id: 2, label: 'LAN', resource_revision: 1 }],
        viewLinkRoutes: []
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
    topology.viewLinkRoutes.push({ view_id: 1, device_a_id: 1, device_b_id: 2, manual_route: [{ x: 10, y: 20 }] });
    const topologyPending = createPendingResourceSave(buildResourceSave(topology, baseline), baseline, topology);
    assert.equal(inspectPendingResourceSave(topologyPending, resourceFixture()), 'retry');
    topology.views[0].resource_revision = 5;
    assert.equal(inspectPendingResourceSave(topologyPending, topology), 'saved');
    topology.viewLinkRoutes[0].manual_route[0].x = 40;
    assert.equal(inspectPendingResourceSave(topologyPending, topology), 'conflict');
});

test('ビューの未確認保存ではサーバー側の全角空白を無視しない', () => {
    const original = resourceFixture();
    const baseline = createResourceBaseline(original);
    const edited = structuredClone(original);
    edited.views[0].memo = '更新した注記';
    const pending = createPendingResourceSave(buildResourceSave(edited, baseline), baseline, edited);
    edited.views[0].resource_revision++;
    assert.equal(inspectPendingResourceSave(pending, edited), 'saved');
    edited.views[0].memo = '　更新した注記　';
    assert.equal(inspectPendingResourceSave(pending, edited), 'conflict');
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
        links: [{ id: 1, from_id: 1, to_id: 2, label: 'LAN' }],
        viewLinkRoutes: [], devicePorts: [],
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
        id_maps: { devices: { 1: 101, 2: 102 }, views: { 1: 201 }, placements: { 1: 301, 2: 302 } },
        devices: [savedDevice, savedDevice2], views: [savedView],
        placements: [
            { id: 301, device_id: 101, view_id: 201, x: 20, y: 30 },
            { id: 302, device_id: 102, view_id: 201, x: 50, y: 30 }
        ],
        view_link_routes: [],
        canvas_notes: [],
        deleted_device_ids: [], deleted_view_ids: [], affected_view_ids: [201]
    }, pending);
    assert.equal(appState.devices[0].id, 101);
    assert.equal(appState.devices[0].memo, 'Edit made while checking');
    assert.equal(appState.editingDeviceId, 101);
    assert.equal(appState.editingLinkId, 1);
    assert.deepEqual(appState.links.map(link => [link.id, link.from_id, link.to_id]), [[1, 101, 102]]);
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
    const view_link_routes = structuredClone(appState.viewLinkRoutes);
    appState.devices = appState.devices.filter(row => row.id !== 1);
    appState.views = [];
    appState.placements = [];
    appState.links = [];
    applyResourceSaveResult({
        revision: 2, id_maps: {}, devices: [device], views: [view], placements, view_link_routes, canvas_notes: [],
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
        views: [], placements: [], view_link_routes: [], canvas_notes: [],
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
            view_link_routes: [], canvas_notes: [], deleted_device_ids: [1], deleted_view_ids: [], affected_view_ids: [1]
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

test('#374: 保存待ちの機器編集を残して監視リセットを取り込み、未保存の管理IPに旧応答を移さない', t => {
    const previous = { ...appState };
    t.after(() => { Object.assign(appState, previous); resetResourceBaseline(appState); });
    for (const changeManagementIp of [false, true]) {
        const fixture = resourceFixture();
        Object.assign(fixture.devices[0], { ip: '192.0.2.81', status: 'green',
            last_checked_at: '2026-01-01 00:00:00', last_response_ms: 5, last_error: null });
        fixture.devices[1].additional_ips = [{ id: 91, ip: '192.0.2.81', label: '比較', sort_order: 0, segment_id: 2 }];
        Object.assign(appState, fixture, {
            canvasNotes: [], floorPlans: [], deviceImages: [], currentViewId: 1,
            selectedPlacementIds: new Set(), viewStates: new Map(), floorPlanAutoFittedViews: new Set(),
            resourceConflicts: { devices: new Map(), views: new Map() }
        });
        resetResourceBaseline(appState);
        appState.devices[1].additional_ips[0].segment_id = null;
        const pending = createPendingResourceSave(buildResourceSave());
        const savedA = { ...appState.devices[0] };
        const savedB = { ...appState.devices[1], resource_revision: 8 };
        appState.devices[0].name = '保存待ちに入力した名前';
        if (changeManagementIp) {
            Object.assign(appState.devices[0], { ip: '192.0.2.82', status: 'unknown',
                last_checked_at: null, last_response_ms: null, last_error: null });
        } else {
            Object.assign(savedA, { status: 'unknown', last_checked_at: null, last_response_ms: null,
                last_error: '同じIPに到達性が未設定・未分類の登録があるため、通信先を特定できずPingをスキップしました' });
        }
        applyResourceSaveResult({
            revision: 2, monitor_revision: 2, id_maps: {}, devices: [savedA, savedB],
            views: [], placements: [], view_link_routes: [], canvas_notes: [],
            deleted_device_ids: [], deleted_view_ids: [], affected_view_ids: []
        }, pending);
        const localA = appState.devices.find(row => row.id === 1);
        assert.equal(localA.name, '保存待ちに入力した名前');
        assert.equal(localA.status, 'unknown');
        assert.equal(localA.last_checked_at, null);
        assert.equal(localA.last_response_ms, null);
        assert.equal(localA.last_error, changeManagementIp ? null : savedA.last_error);
        assert.equal(localA.ip, changeManagementIp ? '192.0.2.82' : '192.0.2.81');
        const next = buildResourceSave();
        assert.deepEqual(next.devices.map(row => [row.id, row.expected_revision]), [[1, 3]]);
        assert.deepEqual(next.views, []);
    }
});
