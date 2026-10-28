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
    addEventListener(key, handler) { this.listeners[key] = handler; }
    removeEventListener(key) { delete this.listeners[key]; }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    closest(selector) { return selector === 'button' && this.tagName === 'BUTTON' ? this : null; }
    contains(node) { return this.children.includes(node); }
    focus() {}
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); }
    getBoundingClientRect() { return { left: 0, top: 0, width: 1000, height: 700, right: 1000, bottom: 700 }; }
}
globalThis.Element = Node;
globalThis.HTMLElement = Node;
globalThis.document = {
    body: new Node(), activeElement: null,
    getElementById: id => elements.get(id) || null,
    querySelector: () => null, querySelectorAll: () => [], createElement: tag => new Node(tag),
    addEventListener: (key, handler) => documentListeners.set(key, handler),
    removeEventListener: key => documentListeners.delete(key)
};
globalThis.window = { APP_CONFIG: { user: { isAdmin: true } }, addEventListener() {}, confirm: () => true,
    setTimeout, clearTimeout, requestAnimationFrame: callback => setTimeout(callback, 0) };

const { appState, normalizeView } = await import('../public/js/core/state.js');
const { resetResourceBaseline } = await import('../public/js/core/resource-save.js');
const { clearPendingSave } = await import('../public/js/core/save-queue.js');
const { eventBus } = await import('../public/js/core/event-bus.js');
const { enterPlacementMode, exitPlacementMode, placementState, handleCanvasPlacementClick, switchPlacementTab } = await import('../public/js/ui/placement-mode.js');
const { renderFloorRacks, getSelectedFloorRackPlacement, removeSelectedFloorRack, clearFloorRackSelection, FLOOR_RACK_ICON } = await import('../public/js/canvas/floor-racks.js');
const { switchView, renderFloorRackReturn } = await import('../public/js/modals/view-manager-modal.js');
const { buildPrintModel, createPrintSettings } = await import('../public/js/canvas/print-model.js');
const { onKeyDown, updateSelectionCount } = await import('../public/js/canvas/selection.js');

beforeEach(() => {
    clearPendingSave(); clearFloorRackSelection(); elements.clear(); documentListeners.clear();
    window.APP_CONFIG.user.isAdmin = true; window.confirm = () => true;
    appState.views = [
        { id: 1, name: 'フロア', view_type: 'floor' }, { id: 2, name: 'ラックA', view_type: 'rack' },
        { id: 3, name: '別フロア', view_type: 'floor' }, { id: 4, name: '論理図', view_type: 'topology' }
    ].map(view => normalizeView({ ...view, resource_revision: 1 }));
    Object.assign(appState, { currentViewId: 1, devices: [], placements: [], links: [], canvasNotes: [],
        rackSettings: [{ view_id: 2, total_u: 42, location: '' }], rackMounts: [], rackShelves: [], rackShelfDevices: [],
        floorRackPlacements: [], floorPlans: [], deviceImages: [], linkSystems: [],
        selectedPlacementIds: new Set(), selectedCanvasNoteId: null, editingDeviceId: null, editingLinkId: null,
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
const click = target => ({ target, stopPropagation() {}, preventDefault() {} });
const settle = async () => { await Promise.resolve(); await Promise.resolve(); await setImmediate(); };

test('physical-only rack tab lists U/status, places one reference and exits without a device', () => {
    enterPlacementMode({ tab: 'rack' });
    assert.equal(elements.get('place-tab-btn-rack').hidden, false);
    const candidate = elements.get('placement-rack-list').children[0];
    assert.equal(candidate.children[0].src, FLOOR_RACK_ICON);
    assert.equal(candidate.children[1].children[0].textContent, 'ラックA');
    assert.equal(candidate.children[1].children[1].textContent, '42U / 未配置');
    candidate.listeners.click();
    assert.equal(handleCanvasPlacementClick({ clientX: 200, clientY: 200 }), true);
    assert.equal(appState.floorRackPlacements.length, 1);
    assert.equal(appState.floorRackPlacements[0].rack_view_id, 2);
    assert.equal(placementState.active, false);
    assert.deepEqual(appState.devices, []); assert.deepEqual(appState.placements, []);
    appState.currentViewId = 3; enterPlacementMode({ tab: 'rack' });
    assert.equal(elements.get('placement-rack-list').children[0].disabled, true);
    placementState.selectedRackId = 2;
    handleCanvasPlacementClick({ clientX: 500, clientY: 500 });
    assert.equal(appState.floorRackPlacements.length, 1);
    exitPlacementMode(); appState.currentViewId = 4; enterPlacementMode({ tab: 'rack' });
    assert.equal(elements.get('place-tab-btn-rack').hidden, true);
    assert.equal(placementState.tab, 'new');
    switchPlacementTab('rack'); assert.equal(placementState.tab, 'new');
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
    const icon = appState.deviceLayer.children[0];
    assert.equal(icon.children[0].src, FLOOR_RACK_ICON); assert.equal(icon.children[1].textContent, '改名ラック');
    assert.equal(icon.children.some(child => child.tagName === 'BUTTON'), false);
    assert.equal(icon.listeners.pointerdown, undefined);
    icon.listeners.click(click(icon)); await settle();
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
    const icon = appState.deviceLayer.children[0];
    icon.children[2].listeners.click(click(icon.children[2])); await settle();
    assert.equal(getSelectedFloorRackPlacement(), ref);
    updateSelectionCount(); assert.equal(elements.get('deleteSelectedBtn').disabled, false);
    window.confirm = () => false; assert.equal(await removeSelectedFloorRack(), false);
    assert.deepEqual(appState.floorRackPlacements, [ref]);
    window.confirm = () => true;
    appState.resourceConflicts.views.set(1, {}); assert.equal(await removeSelectedFloorRack(), false);
    appState.resourceConflicts.views.clear();
    assert.equal(await removeSelectedFloorRack(), true);
    assert.deepEqual(appState.floorRackPlacements, []);
    assert.equal(appState.views.some(view => view.id === 2), true);
    assert.equal(appState.rackSettings.length, 1);
});

test('admin drag changes XY at canvas scale and does not navigate on resulting click', async () => {
    const ref = { floor_view_id: 1, rack_view_id: 2, x: 100, y: 200 }; appState.floorRackPlacements = [ref];
    renderFloorRacks(); const icon = appState.deviceLayer.children[0];
    icon.listeners.pointerdown({ ...click(icon), button: 0, pointerId: 1, clientX: 100, clientY: 100 }); await settle();
    documentListeners.get('pointermove')({ pointerId: 1, clientX: 120, clientY: 130 });
    documentListeners.get('pointerup')({ type: 'pointerup', pointerId: 1, clientX: 120, clientY: 130 });
    assert.equal(ref.x, 140); assert.equal(ref.y, 260);
    icon.listeners.click(click(icon)); assert.equal(appState.currentViewId, 1);
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
    input.view = appState.views[3]; assert.equal(buildPrintModel(input, settings).nodes.length, 0);
});

test('rack selection clears on blank canvas and device/range selection; closed palette hides rack tab', async () => {
    const { onCanvasClick } = await import('../public/js/canvas/renderer.js');
    const { replaceSelectedPlacementIds } = await import('../public/js/canvas/selection.js');
    appState.floorRackPlacements = [{ floor_view_id: 1, rack_view_id: 2, x: 100, y: 200 }];
    renderFloorRacks();
    const icon = appState.deviceLayer.children[0];
    icon.children[2].listeners.click(click(icon.children[2])); await settle();
    assert.ok(getSelectedFloorRackPlacement());
    await onCanvasClick(click(new Node()));
    assert.equal(getSelectedFloorRackPlacement(), null);
    icon.children[2].listeners.click(click(icon.children[2])); await settle();
    replaceSelectedPlacementIds([50]); replaceSelectedPlacementIds([]);
    assert.equal(getSelectedFloorRackPlacement(), null);
    enterPlacementMode({ tab: 'rack' }); exitPlacementMode();
    assert.equal(elements.get('place-tab-btn-rack').hidden, true);
});

test('viewer modifier-click navigates without selecting a removable rack', async () => {
    appState.floorRackPlacements = [{ floor_view_id: 1, rack_view_id: 2, x: 100, y: 200 }];
    window.APP_CONFIG.user.isAdmin = false;
    renderFloorRacks(); const icon = appState.deviceLayer.children[0];
    icon.listeners.click({ ...click(icon), ctrlKey: true }); await settle();
    assert.equal(appState.currentViewId, 2);
    assert.equal(getSelectedFloorRackPlacement(), null);
    assert.equal(await removeSelectedFloorRack(), false);
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
    const icon = appState.deviceLayer.children[0];
    icon.children[2].listeners.click(click(icon.children[2])); await settle();
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
