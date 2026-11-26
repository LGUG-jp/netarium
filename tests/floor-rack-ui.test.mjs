import assert from 'node:assert/strict';
import { beforeEach, afterEach, test } from 'node:test';
import { setImmediate } from 'node:timers/promises';

const elements = new Map();
const documentListeners = new Map();
class Node {
    constructor(tag = 'div') {
        this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.style = {};
        this.hidden = false; this.listeners = {}; this.attributes = {};
        const classes = new Set();
        this.classList = { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value),
            toggle(value, enabled) { if (enabled ?? !classes.has(value)) classes.add(value); else classes.delete(value); } };
    }
    append(...nodes) { for (const node of nodes) this.appendChild(node); }
    appendChild(node) { node.parentElement = this; this.children.push(node); return node; }
    prepend(node) { node.parentElement = this; this.children.unshift(node); }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    getAttribute(key) { return this.attributes[key] ?? null; }
    removeAttribute(key) { delete this.attributes[key]; }
    addEventListener(key, handler) {
        const previous = this.listeners[key];
        this.listeners[key] = previous ? event => { previous(event); return handler(event); } : handler;
    }
    removeEventListener(key) { delete this.listeners[key]; }
    querySelector(selector) {
        const rackId = /^\[data-rack-view-id="([^"]+)"\]$/.exec(selector)?.[1];
        return this.children.find(child => rackId !== undefined ? child.dataset.rackViewId === rackId
            : child.className?.split(' ').includes(selector.slice(1))) || null;
    }
    querySelectorAll(selector) {
        const classes = selector.split(',').map(value => value.trim().slice(1));
        const matches = [];
        const visit = node => {
            for (const child of node.children) {
                if (classes.some(name => child.classList.contains(name) || child.className?.split(' ').includes(name))) {
                    matches.push(child);
                }
                visit(child);
            }
        };
        visit(this);
        return matches;
    }
    closest(selector) { return selector === 'button' && this.tagName === 'BUTTON' ? this : null; }
    contains(node) { return this.children.includes(node); }
    focus() { document.activeElement = this; }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); }
    getBoundingClientRect() { return { left: 0, top: 0, width: 1000, height: 700, right: 1000, bottom: 700 }; }
}
globalThis.Element = Node;
globalThis.HTMLElement = Node;
globalThis.document = {
    body: new Node(), activeElement: null,
    getElementById: id => elements.get(id) || null,
    querySelector: () => null, querySelectorAll: () => [], createElement: tag => new Node(tag),
    createElementNS: (_namespace, tag) => new Node(tag),
    addEventListener: (key, handler) => documentListeners.set(key, handler),
    removeEventListener: key => documentListeners.delete(key)
};
globalThis.window = { APP_CONFIG: { user: { isAdmin: true } }, addEventListener() {}, confirm: () => true,
    setTimeout, clearTimeout, requestAnimationFrame: callback => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout };

const { appState, normalizeView } = await import('../public/js/core/state.js');
const { resetResourceBaseline } = await import('../public/js/core/resource-save.js');
const { clearPendingSave, flushSaveQueue } = await import('../public/js/core/save-queue.js');
const { eventBus } = await import('../public/js/core/event-bus.js');
const { enterPlacementMode, exitPlacementMode, placementState, handleCanvasPlacementClick, switchPlacementTab } = await import('../public/js/ui/placement-mode.js');
const { renderFloorRacks, getSelectedFloorRackPlacement, removeSelectedFloorRack, clearFloorRackSelection, FLOOR_RACK_ICON } = await import('../public/js/canvas/floor-racks.js');
const { renderLinks, syncConnectionHighlight } = await import('../public/js/canvas/renderer.js');
const { setConnectionHighlightEnabled } = await import('../public/js/core/link-display-settings.js');
const { closeLinkPanel } = await import('../public/js/ui/property-panel.js');
const { switchView, renderFloorRackReturn } = await import('../public/js/modals/view-manager-modal.js');
const { buildPrintModel, createPrintSettings } = await import('../public/js/canvas/print-model.js');
const { onKeyDown, updateSelectionCount } = await import('../public/js/canvas/selection.js');

beforeEach(() => {
    clearPendingSave(); clearFloorRackSelection(); elements.clear(); documentListeners.clear();
    document.activeElement = null;
    window.APP_CONFIG.user.isAdmin = true; window.confirm = () => true;
    appState.views = [
        { id: 1, name: 'フロア', view_type: 'floor' }, { id: 2, name: 'ラックA', view_type: 'rack' },
        { id: 3, name: '別フロア', view_type: 'floor' }, { id: 4, name: '論理図', view_type: 'topology' }
    ].map(view => normalizeView({ ...view, resource_revision: 1 }));
    Object.assign(appState, { currentViewId: 1, devices: [], placements: [], links: [], canvasNotes: [],
        rackSettings: [{ view_id: 2, total_u: 42, location: '' }], rackMounts: [], rackShelves: [], rackShelfDevices: [],
        floorRackPlacements: [], floorPlans: [], deviceImages: [], linkSystems: [],
        selectedPlacementIds: new Set(), selectedCanvasNoteId: null, editingDeviceId: null, editingLinkId: null, editingLinkGroupKey: null,
        viewStates: new Map(), floorPlanAutoFittedViews: new Set(),
        resourceConflicts: { devices: new Map(), views: new Map() },
        viewState: { scale: .5, panX: 24, panY: 24, minScale: .05, maxScale: 3 },
        canvas: new Node(), world: null, currentSvg: null, deviceLayer: new Node(), floorPlanLayer: null,
        appStatus: { dirty: false, state: 'saved' }, authExpired: false, isPinging: false,
        linkMode: false, noteMode: false, floorPlanAdjustMode: false, isRangeSelecting: false, suppressNextClick: false });
    placementState.active = false; placementState.tab = 'new'; placementState.selectedRackId = null;
    for (const id of ['place-tab-btn-rack', 'place-content-rack', 'placement-rack-list', 'rack-header', 'deleteSelectedBtn']) elements.set(id, new Node());
    resetResourceBaseline(appState);
});
afterEach(() => { placementState.active = false; clearPendingSave(); eventBus.emit('resources:reloaded'); });
const click = (target, detail = 1) => ({ target, detail, stopPropagation() {}, preventDefault() {} });

test('physical-only rack tab lists U/status, places one reference and exits without a device', () => {
    enterPlacementMode({ tab: 'rack' });
    assert.equal(elements.get('place-tab-btn-rack').hidden, false);
    const candidate = elements.get('placement-rack-list').children[0];
    assert.equal(candidate.children[0].src, FLOOR_RACK_ICON);
    assert.equal(candidate.children[1].children[0].textContent, 'ラックA');
    assert.equal(candidate.children[1].children[1].textContent, '42U / 未配置 / 配置可能');
    candidate.listeners.click();
    assert.equal(handleCanvasPlacementClick({ clientX: 200, clientY: 200 }), true);
    assert.equal(appState.floorRackPlacements.length, 1);
    assert.equal(appState.floorRackPlacements[0].rack_view_id, 2);
    assert.equal(placementState.active, false);
    assert.deepEqual(appState.devices, []); assert.deepEqual(appState.placements, []);
    appState.currentViewId = 3; enterPlacementMode({ tab: 'rack' });
    assert.equal(elements.get('placement-rack-list').children[0].tagName, 'DIV', '配置済みラックは新規配置ボタンにしない');
    placementState.selectedRackId = 2;
    handleCanvasPlacementClick({ clientX: 500, clientY: 500 });
    assert.equal(appState.floorRackPlacements.length, 1);
    exitPlacementMode(); appState.currentViewId = 4; enterPlacementMode({ tab: 'rack' });
    assert.equal(elements.get('place-tab-btn-rack').hidden, true);
    assert.equal(placementState.tab, 'new');
    switchPlacementTab('rack'); assert.equal(placementState.tab, 'new');
});

test('所属ラックは同一フロアの物理ビューでのみ配置でき、所属変更後は候補と確定の両方で拒否する', () => {
    appState.views[0].floor_id = 10;
    appState.views[1].floor_id = 10;
    appState.views[2].floor_id = 10;
    appState.currentViewId = 3;
    enterPlacementMode({ tab: 'rack' });
    const rack = () => elements.get('placement-rack-list').children[0];
    rack().listeners.click();

    for (const floorId of [11, null]) {
        appState.views[2].floor_id = floorId;
        assert.equal(handleCanvasPlacementClick({ clientX: 200, clientY: 200 }), true);
        assert.deepEqual(appState.floorRackPlacements, []);
        assert.equal(rack().tagName, 'DIV');
        assert.match(rack().children[1].children[1].textContent, /このフロアには配置できません/);
        appState.views[2].floor_id = 10;
        switchPlacementTab('rack');
        rack().listeners.click();
    }
    assert.equal(handleCanvasPlacementClick({ clientX: 200, clientY: 200 }), true);
    assert.equal(appState.floorRackPlacements[0].floor_view_id, 3);
});

test('Escape cancels a pending rack without creating a reference', async () => {
    enterPlacementMode({ tab: 'rack' }); placementState.selectedRackId = 2;
    await onKeyDown({ key: 'Escape', preventDefault() {}, stopImmediatePropagation() {} });
    assert.equal(placementState.active, false); assert.equal(placementState.selectedRackId, null);
    assert.deepEqual(appState.floorRackPlacements, []);
});

test('icon uses live rack name, viewer can navigate and return restores floor pan/zoom', async () => {
    appState.floorRackPlacements = [{ floor_view_id: 1, rack_view_id: 2, x: 100, y: 200 }];
    appState.views[1].name = '改名ラック'; window.APP_CONFIG.user.isAdmin = false;
    renderFloorRacks();
    const item = appState.deviceLayer.children[0];
    const [trigger, open] = item.children;
    assert.equal(trigger.children[0].src, FLOOR_RACK_ICON);
    assert.equal(trigger.children[1].textContent, '改名ラック');
    assert.equal(open.hidden, true);
    await trigger.listeners.click(click(trigger));
    assert.equal(appState.currentViewId, 1);
    assert.equal(item.classList.contains('selected'), true);
    assert.equal(appState.deviceLayer.children[0].children[0], trigger, '初回クリックで対象DOMを保持する');
    assert.equal(open.hidden, false);
    await trigger.listeners.click(click(trigger, 2));
    await trigger.listeners.dblclick(click(trigger, 2));
    assert.equal(appState.currentViewId, 2);
    renderFloorRackReturn();
    const back = elements.get('rack-header').children[0];
    assert.equal(back.textContent, '← 元の物理配置図へ戻る');
    await back.listeners.click();
    assert.equal(appState.currentViewId, 1);
    assert.deepEqual({ scale: appState.viewState.scale, panX: appState.viewState.panX, panY: appState.viewState.panY }, { scale: .5, panX: 24, panY: 24 });
    await switchView(2); elements.get('rack-header').replaceChildren(); renderFloorRackReturn();
    assert.equal(elements.get('rack-header').children.length, 0);
});

test('admin selection/delete confirms icon only, cancel and conflict preserve it', async () => {
    const ref = { floor_view_id: 1, rack_view_id: 2, x: 100, y: 200 }; appState.floorRackPlacements = [ref];
    renderFloorRacks();
    const trigger = appState.deviceLayer.children[0].children[0];
    await trigger.listeners.click(click(trigger));
    assert.equal(getSelectedFloorRackPlacement(), ref);
    updateSelectionCount(); assert.equal(elements.get('deleteSelectedBtn').disabled, false);
    window.confirm = () => false; assert.equal(await removeSelectedFloorRack(), false);
    assert.deepEqual(appState.floorRackPlacements, [ref]);
    window.confirm = () => true;
    appState.resourceConflicts.views.set(1, {}); assert.equal(await removeSelectedFloorRack(), false);
    appState.resourceConflicts.views.clear();
    await onKeyDown({ ...click(trigger), key: 'Delete', stopImmediatePropagation() {} });
    assert.deepEqual(appState.floorRackPlacements, []);
    assert.equal(appState.views.some(view => view.id === 2), true);
    assert.equal(appState.rackSettings.length, 1);
});

test('管理者のドラッグで座標を更新し、直後のクリック・ダブルクリックでは遷移しない', async () => {
    const ref = { floor_view_id: 1, rack_view_id: 2, x: 100, y: 200 }; appState.floorRackPlacements = [ref];
    renderFloorRacks();
    const item = appState.deviceLayer.children[0];
    const trigger = item.children[0];
    await trigger.listeners.click(click(trigger));
    trigger.listeners.pointerdown({ ...click(trigger), button: 0, pointerId: 1, clientX: 100, clientY: 100 });
    documentListeners.get('pointermove')({ pointerId: 1, clientX: 120, clientY: 130 });
    documentListeners.get('pointerup')({ type: 'pointerup', pointerId: 1, clientX: 120, clientY: 130 });
    assert.equal(ref.x, 140); assert.equal(ref.y, 260);
    assert.equal(item.style.left, '140px');
    await trigger.listeners.click(click(trigger));
    await trigger.listeners.click(click(trigger, 2));
    await trigger.listeners.dblclick(click(trigger, 2));
    assert.equal(appState.currentViewId, 1);
    // 新しいダブルクリックは、先ほどのドラッグの影響を受けない。
    await trigger.listeners.click(click(trigger));
    await trigger.listeners.click(click(trigger, 2));
    await trigger.listeners.dblclick(click(trigger, 2));
    assert.equal(appState.currentViewId, 2);
});

test('ラックの移動を取り消し・やり直すと、物理配置図の座標が保存される', async t => {
    appState.floorRackPlacements = [{ floor_view_id: 1, rack_view_id: 2, x: 0, y: 0 }];
    resetResourceBaseline(appState);
    window.APP_CONFIG.csrfToken = 'test-only-token';
    t.after(() => { delete window.APP_CONFIG.csrfToken; });
    const saved = [];
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
        const { views } = JSON.parse(options.body);
        const [operation] = views;
        saved.push(operation.floor_rack_placements[0]);
        const revision = saved.length + 1;
        return Response.json({ ok: true, revision, id_maps: {}, devices: [], placements: [], view_link_routes: [], canvas_notes: [],
            views: [{ ...operation.view, resource_revision: revision }],
            floor_rack_placements: operation.floor_rack_placements, affected_view_ids: [1], deleted_device_ids: [], deleted_view_ids: [] });
    });
    renderFloorRacks();
    const [trigger] = appState.deviceLayer.children[0].children;
    await trigger.listeners.click(click(trigger));
    const down = () => trigger.listeners.pointerdown({ ...click(trigger), button: 0, pointerId: 1, clientX: 100, clientY: 100 });
    const up = (clientX, clientY) => documentListeners.get('pointerup')({ type: 'pointerup', pointerId: 1, clientX, clientY });
    const key = async (key, shiftKey = false) => {
        let used = false;
        await onKeyDown({ ...click(trigger), key, ctrlKey: true, shiftKey,
            preventDefault() { used = true; }, stopImmediatePropagation() {} });
        return used;
    };
    down();
    up(80, 80); // 左上でクランプされ、開始座標と同じ。
    assert.equal(await key('z'), false);
    assert.deepEqual(saved, []);
    down();
    documentListeners.get('pointermove')({ pointerId: 1, clientX: 120, clientY: 130 });
    up(132, 145);
    assert.equal(await flushSaveQueue({ silent: true }), true);
    assert.equal(await key('z'), true);
    assert.equal(await flushSaveQueue({ silent: true }), true);
    appState.viewState.scale = 3;
    appState.deviceLayer.replaceChildren();
    renderFloorRacks();
    const item = appState.deviceLayer.children[0];
    item.children[0].listeners.pointerdown({ ...click(item.children[0]), button: 0, pointerId: 1, clientX: 100, clientY: 100 });
    documentListeners.get('pointermove')({ pointerId: 1, clientX: 120, clientY: 130 });
    up(101, 100);
    assert.equal(await flushSaveQueue({ silent: true }), true);
    assert.equal(item.style.left, '0px');
    assert.equal(appState.floorRackPlacements[0].x, 0);
    assert.equal(saved.length, 2, '1px未満の移動は保存しない');
    assert.equal(await key('z'), false);
    assert.equal(await key('z', true), true);
    assert.equal(await flushSaveQueue({ silent: true }), true);
    assert.deepEqual(saved.map(({ floor_view_id, rack_view_id, x, y }) =>
        [floor_view_id, rack_view_id, x, y]), [[1, 2, 64, 90], [1, 2, 0, 0], [1, 2, 64, 90]]);
    assert.deepEqual(appState.floorRackPlacements[0], saved.at(-1));
});

test('ドラッグ中に対象の物理配置図を再読込した場合は、ラックの再読込座標を保持する', () => {
    appState.floorRackPlacements = [{ floor_view_id: 1, rack_view_id: 2, x: 100, y: 200 }];
    resetResourceBaseline(appState);
    renderFloorRacks();
    const [trigger] = appState.deviceLayer.children[0].children;
    trigger.listeners.pointerdown({ ...click(trigger), button: 0, pointerId: 1, clientX: 100, clientY: 100 });
    documentListeners.get('pointermove')({ pointerId: 1, clientX: 120, clientY: 130 });
    eventBus.emit('resource:reloaded', { kind: 'views', id: 3 });
    assert.equal(documentListeners.has('pointerup'), true);
    const remote = { floor_view_id: 1, rack_view_id: 2, x: 400, y: 450 };
    appState.floorRackPlacements = [remote];
    resetResourceBaseline(appState);
    eventBus.emit('resource:reloaded', { kind: 'views', id: 1 });
    appState.deviceLayer.replaceChildren();
    renderFloorRacks();
    assert.equal(documentListeners.has('pointerup'), false);
    assert.deepEqual(remote, { floor_view_id: 1, rack_view_id: 2, x: 400, y: 450 });
    assert.equal(appState.deviceLayer.children[0].style.left, '400px');
});

test('ラック端点の線と×2は強調で薄くせず、ラック移動と取消・接続表示切替に追従する', async t => {
    const ref = { floor_view_id: 1, rack_view_id: 2, x: 100, y: 200 };
    appState.floorRackPlacements = [ref];
    appState.devices = [10, 11, 12, 13, 14].map(id => ({ id, name: `機器${id}` }));
    appState.placements = [10, 13, 14].map((id, index) => ({
        id, view_id: 1, device_id: id, x: 600 + index * 160, y: 200
    }));
    appState.rackMounts = [11, 12].map((device_id, index) => ({
        view_id: 2, device_id, face: 'front', start_u: index + 1, height_u: 1
    }));
    appState.links = [
        { id: 21, from_id: 10, to_id: 11 }, { id: 22, from_id: 12, to_id: 10 },
        { id: 23, from_id: 13, to_id: 14 }
    ];
    appState.currentSvg = new Node('svg');
    const off = eventBus.on('canvas:render-links', renderLinks);
    const { requestAnimationFrame, cancelAnimationFrame } = window;
    let frame;
    window.requestAnimationFrame = callback => { frame = callback; return 1; };
    window.cancelAnimationFrame = () => { frame = null; };
    window.localStorage = { setItem() {} };
    t.after(() => {
        off();
        setConnectionHighlightEnabled(false);
        delete window.localStorage;
        Object.assign(window, { requestAnimationFrame, cancelAnimationFrame });
    });
    const groups = () => appState.currentSvg.querySelectorAll('.link-group');
    const rackGroup = () => groups().find(group => group.dataset.displayKey === '1:-2:10');
    const path = () => rackGroup().querySelectorAll('.topology-link-hit')[0].getAttribute('d');
    const badges = () => appState.currentSvg.querySelectorAll('.link-count-badge');
    const assertRackLink = () => {
        assert.equal(rackGroup().classList.contains('connection-dimmed'), false);
        assert.equal(badges().length, 1);
        assert.equal(badges()[0].classList.contains('connection-dimmed'), false);
        assert.equal(badges()[0].querySelectorAll('.link-label-count')[0].textContent, '×2');
    };

    setConnectionHighlightEnabled(true);
    appState.selectedPlacementIds.add(10);
    renderFloorRacks();
    renderLinks();
    assert.equal(groups().length, 2);
    const direct = groups().find(group => group.dataset.displayKey === '1:13:14');
    assert.equal(direct.classList.contains('connection-dimmed'), true);
    assertRackLink();
    appState.selectedPlacementIds = new Set([13]);
    syncConnectionHighlight();
    assert.equal(direct.classList.contains('connection-dimmed'), false);
    assertRackLink();
    const before = path();
    const foreground = appState.currentSvg.querySelectorAll('.link-foreground')[0];
    badges()[0].listeners.pointerenter();
    assert.equal(foreground.style.display, '');
    assert.equal(foreground.querySelectorAll('.link-foreground-path')[0].getAttribute('d'),
        rackGroup().querySelectorAll('.topology-link')[0].getAttribute('d'));
    badges()[0].listeners.pointerleave();
    assert.equal(foreground.style.display, 'none');

    const item = appState.deviceLayer.children[0];
    const trigger = item.children[0];
    trigger.listeners.pointerdown({ ...click(trigger), button: 0, pointerId: 1, clientX: 100, clientY: 100 });
    documentListeners.get('pointermove')({ pointerId: 1, clientX: 160, clientY: 140 });
    assert.equal(item.style.top, '280px');
    assert.equal(path(), before);
    frame();
    assert.notEqual(path(), before);
    assertRackLink();
    documentListeners.get('pointermove')({ pointerId: 1, clientX: 170, clientY: 150 });
    documentListeners.get('pointercancel')({ type: 'pointercancel', pointerId: 1 });
    assert.equal(frame, null);
    assert.equal(item.style.top, '200px');
    assert.equal(path(), before);
    assert.equal(getSelectedFloorRackPlacement(), ref);

    appState.views[0].show_connections = 0;
    eventBus.emit('canvas:render-links');
    assert.deepEqual(groups(), []);
    assert.deepEqual(badges(), []);
    appState.views[0].show_connections = 1;
    eventBus.emit('canvas:render-links');
    assert.equal(path(), before);
    assertRackLink();

    const panel = new Node();
    panel.hidden = true;
    elements.set('link-panel', panel);
    const rows = new Node('ul');
    elements.set('lp-group-connections', rows);
    assert.equal(item.children[1].hidden, false);
    t.after(() => {
        closeLinkPanel();
        document.body.classList.remove('panel-open');
    });
    for (const target of [
        () => rackGroup().querySelectorAll('.topology-link-hit')[0],
        () => badges()[0]
    ]) {
        const element = target();
        await element.listeners.click(click(element));
        assert.equal(panel.hidden, false);
        assert.equal(getSelectedFloorRackPlacement(), null);
        assert.equal(item.children[1].hidden, true);
        assert.equal(appState.editingLinkGroupKey, '1:-2:10');
        assert.deepEqual(rows.children.map(row => row.dataset.linkId), ['21', '22']);
        eventBus.emit('canvas:render-links');
        assert.equal(rackGroup().classList.contains('selected'), true);
        assert.equal(closeLinkPanel(), true);
    }
});

test('floor printing includes only valid refs with live names independently of device filters', () => {
    const input = { view: appState.views[0], views: appState.views, devices: [], placements: [], links: [], notes: [],
        floorRackPlacements: [{ floor_view_id: 1, rack_view_id: 2, x: 1200, y: 900 },
            { floor_view_id: 3, rack_view_id: 2, x: 9000, y: 9000 }, { floor_view_id: 1, rack_view_id: 99, x: 0, y: 0 }] };
    const settings = createPrintSettings();
    for (const type of Object.keys(settings.deviceTypes)) settings.deviceTypes[type] = false;
    const model = buildPrintModel(input, settings);
    assert.equal(model.empty, false); assert.equal(model.nodes.length, 1);
    assert.equal(model.nodes[0].name, 'ラックA'); assert.equal(model.nodes[0].icon, FLOOR_RACK_ICON);
    assert.ok(model.bounds.x + model.bounds.width > 1200); assert.deepEqual(model.wires, []);
    settings.rack = false;
    const withoutRack = buildPrintModel(input, settings);
    assert.equal(withoutRack.nodes.length, 0);
    assert.equal(withoutRack.empty, true);
    settings.rack = true;
    input.view = appState.views[3]; assert.equal(buildPrintModel(input, settings).nodes.length, 0);
});

test('rack selection clears on blank canvas and device/range selection; closed palette hides rack tab', async () => {
    const { onCanvasClick } = await import('../public/js/canvas/renderer.js');
    const { replaceSelectedPlacementIds } = await import('../public/js/canvas/selection.js');
    appState.floorRackPlacements = [{ floor_view_id: 1, rack_view_id: 2, x: 100, y: 200 }];
    renderFloorRacks();
    const [trigger, open] = appState.deviceLayer.children[0].children;
    await trigger.listeners.click(click(trigger));
    assert.ok(getSelectedFloorRackPlacement());
    await onCanvasClick(click(new Node()));
    assert.equal(getSelectedFloorRackPlacement(), null);
    assert.equal(open.hidden, true);
    await trigger.listeners.click(click(trigger));
    replaceSelectedPlacementIds([50]); replaceSelectedPlacementIds([]);
    assert.equal(getSelectedFloorRackPlacement(), null);
    assert.equal(trigger.getAttribute('aria-pressed'), 'false');
    assert.equal(open.hidden, true);
    enterPlacementMode({ tab: 'rack' }); exitPlacementMode();
    assert.equal(elements.get('place-tab-btn-rack').hidden, true);
});

test('閲覧者もキーボードでラックを選択して開けるが、移動・解除はできない', async () => {
    const ref = { floor_view_id: 1, rack_view_id: 2, x: 100, y: 200 };
    appState.floorRackPlacements = [ref];
    window.APP_CONFIG.user.isAdmin = false;
    renderFloorRacks();
    const [trigger, open] = appState.deviceLayer.children[0].children;
    assert.equal(trigger.tagName, 'BUTTON');
    trigger.focus();
    await trigger.listeners.click(click(trigger, 0)); // Enter/Space によるネイティブ click
    assert.equal(document.activeElement, trigger);
    assert.equal(trigger.getAttribute('aria-pressed'), 'true');
    assert.equal(appState.currentViewId, 1);
    trigger.listeners.pointerdown({ ...click(trigger), button: 0, pointerId: 1 });
    assert.equal(documentListeners.has('pointermove'), false);
    updateSelectionCount();
    assert.equal(elements.get('deleteSelectedBtn').disabled, true);
    assert.equal(await removeSelectedFloorRack(), false);
    assert.deepEqual(appState.floorRackPlacements, [ref]);
    assert.equal(open.hidden, false);
    open.focus();
    await open.listeners.click(click(open, 0));
    assert.equal(appState.currentViewId, 2);
});

test('他の編集モードや保存競合中はラックの移動操作を開始しない', async () => {
    const ref = { floor_view_id: 1, rack_view_id: 2, x: 100, y: 200 };
    appState.floorRackPlacements = [ref];
    renderFloorRacks();
    const [trigger, open] = appState.deviceLayer.children[0].children;
    for (const mode of ['linkMode', 'noteMode', 'floorPlanAdjustMode']) {
        appState[mode] = true;
        await trigger.listeners.click(click(trigger));
        await trigger.listeners.dblclick(click(trigger, 2));
        trigger.listeners.pointerdown({ ...click(trigger), button: 0, pointerId: 1 });
        assert.equal(documentListeners.has('pointermove'), false);
        assert.equal(getSelectedFloorRackPlacement(), null);
        assert.equal(appState.currentViewId, 1);
        appState[mode] = false;
    }
    await trigger.listeners.click(click(trigger));
    placementState.active = true;
    await open.listeners.click(click(open));
    assert.equal(appState.currentViewId, 1);
    assert.equal(await removeSelectedFloorRack(), false);
    placementState.active = false;
    appState.resourceConflicts.views.set(1, {});
    trigger.listeners.pointerdown({ ...click(trigger), button: 0, pointerId: 1 });
    assert.equal(documentListeners.has('pointermove'), false);
    assert.deepEqual(appState.floorRackPlacements, [ref]);
});

test('保存未確認ではラック配置・解除を拒否し状態確定後に再操作できる', async () => {
    const { renderPlacementRacks } = await import('../public/js/ui/placement-mode.js');
    enterPlacementMode({ tab: 'rack' });
    elements.get('placement-rack-list').children[0].listeners.click();
    appState.appStatus.state = 'unconfirmed';
    renderPlacementRacks();
    assert.equal(elements.get('placement-rack-list').children[0].disabled, true);
    handleCanvasPlacementClick({ clientX: 200, clientY: 200 });
    assert.deepEqual(appState.floorRackPlacements, []);
    assert.equal(placementState.active, true);
    appState.appStatus.state = 'saved';
    renderPlacementRacks();
    assert.equal(elements.get('placement-rack-list').children[0].disabled, false);
    handleCanvasPlacementClick({ clientX: 200, clientY: 200 });
    const ref = appState.floorRackPlacements[0];
    assert.equal(ref.rack_view_id, 2);
    assert.equal(placementState.active, false);
    renderFloorRacks();
    const trigger = appState.deviceLayer.children[0].children[0];
    await trigger.listeners.click(click(trigger));
    appState.appStatus.state = 'unconfirmed';
    updateSelectionCount();
    assert.equal(elements.get('deleteSelectedBtn').disabled, true);
    let confirmations = 0;
    window.confirm = () => { confirmations++; return true; };
    assert.equal(await removeSelectedFloorRack(), false);
    assert.deepEqual(appState.floorRackPlacements, [ref]);
    assert.equal(confirmations, 0);
    appState.appStatus.state = 'saved';
    updateSelectionCount();
    assert.equal(elements.get('deleteSelectedBtn').disabled, false);
    window.confirm = () => { appState.appStatus.state = 'unconfirmed'; return true; };
    assert.equal(await removeSelectedFloorRack(), false);
    assert.deepEqual(appState.floorRackPlacements, [ref]);
    appState.appStatus.state = 'saved';
    window.confirm = () => true;
    assert.equal(await removeSelectedFloorRack(), true);
    assert.deepEqual(appState.floorRackPlacements, []);
});
