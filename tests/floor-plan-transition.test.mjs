import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { installWorkspaceDom } from './helpers/workspace-dom.mjs';

const dom = installWorkspaceDom({
    templates: ['templates/modals/view_manager.php', 'templates/modals/floor_plan_manager.php',
        'templates/components/canvas_context_toolbar.php', 'templates/components/status_bar.php', 'templates/components/canvas.php'],
    phpSetup: "$storageCapacity = ['images' => ['max_entry_bytes' => 10485760, 'max_total_bytes' => 209715200], 'floor_plans' => ['max_files' => 100]]; $appConfig = ['floor_plan_upload_max_bytes' => 31457280, 'floor_plan_upload_max_dimension' => 7000, 'floor_plan_upload_max_pixels' => 35000000, 'floor_plan_max_dimension' => 4096];"
});
const { appState, normalizeView } = await import('../public/js/core/state.js');
const manager = await import('../public/js/modals/view-manager-modal.js');
const floor = await import('../public/js/modals/floor-plan-modal.js');
const resource = await import('../public/js/core/resource-save.js');
const queue = await import('../public/js/core/save-queue.js');
const { getTopModalContainer } = await import('../public/js/core/modal-focus.js');
const { onKeyDown } = await import('../public/js/canvas/selection.js');
const { eventBus } = await import('../public/js/core/event-bus.js');
const context = await import('../public/js/ui/canvas-context-toolbar.js');
document.readyState = 'loading';
const { registerStaticListeners } = await import('../public/js/main.js');
registerStaticListeners();
eventBus.on('canvas:render-floor-plan', floor.renderFloorPlan);
dom.get('floor-plan-file').addEventListener('change', floor.uploadCurrentFloorPlan);
dom.get('floor-plan-visible').addEventListener('change', floor.toggleFloorPlanVisibility);
dom.get('floor-plan-opacity').addEventListener('input', floor.previewFloorPlanOpacity);
for (const type of ['change', 'pointerup', 'keyup', 'blur']) {
    dom.get('floor-plan-opacity').addEventListener(type, floor.commitFloorPlanOpacity);
}
const palette = dom.add('button', 'floor-plan-manage-btn');
const canvas = dom.get('canvas');
const world = dom.get('world');
const layer = dom.get('floor-plan-layer');
const svg = dom.get('link-layer');
const devices = dom.get('device-layer');
let dimensions;
let server, requests, failure, held, release;
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const freshPlan = (overrides = {}) => ({ view_id: 1, original_name: 'synthetic.png', mime_type: 'image/png',
    file_size: 4, image_width: 800, image_height: 600, image_url: '/floor.png?revision=1',
    x: 0, y: 0, scale: 1, opacity: 1, is_visible: 1, revision: 1, ...overrides });
// サーバー状態はローカルappStateから独立。loadは保存の成否/競合を本当に区別する。
async function http(url, options = {}) {
    const action = new URL(url, 'http://localhost/').searchParams.get('action');
    const payload = options.body instanceof FormData ? Object.fromEntries(options.body) : options.body ? JSON.parse(options.body) : null;
    requests.push({ action, payload });
    if (action === 'load') return json(structuredClone(server));
    if (held === action) {
        held = null;
        await new Promise(resolve => { release = resolve; });
    }
    if (failure) {
        const current = failure; failure = null;
        if (current === 'network') throw new TypeError('connection lost');
        if (current === 'busy') return json({ ok: false, error: '現在、別の更新処理が実行されています。少し待ってから再度保存してください' }, 409);
        return json({ ok: false, error: '保存できません', details: { conflicts: [{ kind: 'views', id: 1, name: '合成フロア' }] } }, current);
    }
    const expected = Number(payload.expected_revision ?? payload.views?.[0]?.expected_revision);
    assert.equal(expected, server.views[0].resource_revision, '送信時点の対象revisionを使う');
    server.revision++;
    server.views[0].resource_revision++;
    if (action === 'save_resources') {
        assert.equal(payload.views.length, 1);
        Object.assign(server.views[0], payload.views[0].view, { resource_revision: expected + 1 });
        return json({ ok: true, revision: server.revision, views: structuredClone(server.views), devices: [],
            placements: [], links: [], canvas_notes: [], id_maps: {}, deleted_device_ids: [], deleted_view_ids: [], affected_view_ids: [1] });
    }
    if (action === 'update_floor_plan_settings') {
        const { expected_revision: _expected, ...settings } = payload;
        Object.assign(server.floor_plans[0], settings);
        server.floor_plans[0].revision++;
        return json({ ok: true, revision: server.revision, view_revision: server.views[0].resource_revision,
            floor_plan_settings: structuredClone(server.floor_plans[0]) });
    }
    if (action === 'upload_floor_plan') {
        const previous = server.floor_plans[0];
        server.floor_plans = [freshPlan({ ...previous, original_name: payload.floor_plan.name,
            image_width: dimensions.width, image_height: dimensions.height,
            mime_type: payload.floor_plan.type, file_size: payload.floor_plan.size,
            image_url: `/floor.png?revision=${server.revision}`, revision: (previous?.revision || 0) + 1 })];
        return json({ ok: true, revision: server.revision, view_revision: server.views[0].resource_revision, floor_plan: structuredClone(server.floor_plans[0]) });
    }
    assert.equal(action, 'delete_floor_plan');
    server.floor_plans = [];
    return json({ ok: true, revision: server.revision, view_revision: server.views[0].resource_revision });
}
beforeEach(async () => {
    await queue.flushSaveQueue({ silent: true });
    floor.finishFloorPlanAdjustMode('replace');
    floor.closeFloorPlanManager();
    await manager.closeViewManager();
    queue.clearPendingSave();
    globalThis.confirm = () => true;
    window.APP_CONFIG.user.isAdmin = true;
    window.APP_CONFIG.capacity = { floorPlanMaxBytes: 30 * 1024 * 1024, floorPlanMaxDimension: 7000, floorPlanMaxPixels: 35000000 };
    dimensions = { width: 800, height: 600 };
    appState.views = [normalizeView({ id: 1, resource_revision: 1, name: '合成フロア', view_type: 'floor' })];
    appState.currentViewId = 1; appState.dataRevision = 1;
    appState.floorPlans = []; appState.devices = []; appState.placements = []; appState.links = []; appState.canvasNotes = [];
    appState.selectedPlacementIds = new Set(); appState.viewStates = new Map();
    appState.authExpired = false; appState.isPinging = false; appState.isFloorPlanUpdating = false;
    appState.linkMode = false; appState.noteMode = false; appState.editingLinkId = null;
    appState.currentSvg = svg; appState.deviceLayer = devices;
    appState.canvas = canvas; appState.world = world; appState.floorPlanLayer = layer;
    appState.viewState = { scale: 1, panX: 0, panY: 0 };
    appState.floorPlanAutoFittedViews = new Set();
    appState.resourceConflicts = { devices: new Map(), views: new Map() };
    appState.appStatus = { dirty: false, state: 'saved', lastSavedAt: null, lastError: null };
    resource.resetResourceBaseline(appState);
    server = { revision: 1, views: structuredClone(appState.views), floor_plans: [], devices: [], placements: [], links: [], canvas_notes: [] };
    requests = []; failure = null; held = null; release = null;
    globalThis.fetch = http;
    layer.replaceChildren();
    palette.focus();
    manager.openViewManager();
});
after(async () => { await queue.flushSaveQueue({ silent: true }); floor.finishFloorPlanAdjustMode('replace'); floor.closeFloorPlanManager(); queue.clearPendingSave(); });
const flush = () => queue.flushSaveQueue({ silent: true });
const image = () => layer.querySelector('.floor-plan-image');
const coords = () => [appState.floorPlans[0].x, appState.floorPlans[0].y, appState.floorPlans[0].scale];
const escape = () => onKeyDown({ key: 'Escape', target: document.activeElement, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} });
function imageFile(name = 'synthetic.png', type = 'image/png') {
    if (dimensions.error) return new File(['invalid'], name, { type });
    let bytes;
    if (type === 'image/jpeg') {
        bytes = new Uint8Array([255, 216, 255, 192, 0, 8, 8,
            dimensions.height >> 8, dimensions.height & 255, dimensions.width >> 8, dimensions.width & 255, 0]);
    } else {
        bytes = new Uint8Array(24);
        bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
        const header = new DataView(bytes.buffer);
        header.setUint32(16, dimensions.width);
        header.setUint32(20, dimensions.height);
    }
    return new File([bytes], name, { type });
}
async function choose(file = imageFile()) {
    await dom.get('floor-plan-upload-btn').dispatch('click');
    dom.get('floor-plan-file').files = file ? [file] : [];
    await dom.get('floor-plan-file').dispatch('change');
    await setImmediate();
}
async function registerPlan() {
    await dom.get('vm-floor-plan-btn').dispatch('click');
    await choose();
    assert.equal(appState.floorPlans[0].original_name, 'synthetic.png');
}
function installPlan(overrides) {
    appState.floorPlans = [freshPlan(overrides)];
    server.floor_plans = structuredClone(appState.floorPlans);
    resource.resetResourceBaseline(appState);
    floor.renderFloorPlan();
}
async function edit() { await dom.get('floor-plan-drag-mode-btn').dispatch('click'); }
async function key(target, name, shiftKey = false) {
    await target.dispatch('keydown', { key: name, shiftKey });
    await dom.events.dispatch('keyup', { key: name, target });
}
async function drag(dx, dy, { target = image(), end = 'pointerup' } = {}) {
    const zoom = appState.viewState.scale;
    await target.dispatch('pointerdown', { button: 0, pointerId: 7, clientX: 100, clientY: 100 });
    await target.dispatch('pointermove', { pointerId: 7, clientX: 100 + dx * zoom, clientY: 100 + dy * zoom });
    if (end) await target.dispatch(end, { pointerId: 7, clientX: 100 + dx * zoom, clientY: 100 + dy * zoom });
    return target;
}

test('登録後のCanvas編集はmodal stackを空にし、pointer確定を自動保存してEsc後も保持する', async () => {
    await registerPlan(); await edit();
    assert.equal(getTopModalContainer(), null);
    assert.equal(dom.get('view-manager-overlay').hidden, true);
    assert.equal(dom.get('floor-plan-manager-overlay').hidden, true);
    assert.equal(dom.get('canvas-view-controls').hidden, false);
    assert.equal(image().classList.contains('adjustable'), true);
    const target = await drag(120, 80, { end: null });
    assert.deepEqual(coords(), [120, 80, 1]);
    assert.equal(requests.length, 1, 'pointer previewは通信しない');
    assert.match(target.style.transform, /translate\(120px, 80px\)/);
    await target.dispatch('pointerup', { pointerId: 7, clientX: 220, clientY: 180 });
    await flush();
    assert.equal(target.hasPointerCapture(7), false);
    assert.deepEqual([server.floor_plans[0].x, server.floor_plans[0].y], [120, 80]);
    await escape();
    assert.equal(appState.floorPlanAdjustMode, false);
    assert.equal(getTopModalContainer(), null);
    assert.equal(document.activeElement, palette);
    floor.openFloorPlanManager(); floor.closeFloorPlanManager();
    assert.deepEqual(coords(), [120, 80, 1]);
    assert.equal(getTopModalContainer(), null);
});

test('キーボード確定は画像移動と対角固定resizeを保存し完了で通常Canvasへ戻る', async () => {
    await registerPlan(); await edit();
    await key(image(), 'ArrowRight', true); await flush();
    const handle = layer.querySelector('[data-floor-plan-corner="nw"]');
    await key(handle, 'ArrowUp', true); await flush();
    assert.ok(Math.abs(appState.floorPlans[0].x - (-70)) < 1e-8);
    assert.ok(Math.abs(appState.floorPlans[0].y - (-60)) < 1e-8);
    assert.equal(appState.floorPlans[0].scale, 1.1);
    assert.equal(server.floor_plans[0].scale, 1.1);
    floor.finishFloorPlanAdjustMode();
    assert.equal(getTopModalContainer(), null);
    assert.equal(document.activeElement, palette);
    assert.equal(image().classList.contains('adjustable'), false);
});

test('四隅handleへのpointer resizeは縦横比と対角を固定しpointerupだけで保存する', async () => {
    await registerPlan(); await edit();
    const handle = layer.querySelector('[data-floor-plan-corner="se"]');
    const target = await drag(400, 300, { target: handle, end: null });
    assert.deepEqual(coords(), [0, 0, 1.5]);
    assert.equal(requests.length, 1);
    assert.equal(layer.querySelector('.floor-plan-editor-frame').style.width, '1200px');
    await target.dispatch('pointerup', { pointerId: 7, clientX: 500, clientY: 400 });
    await flush();
    assert.equal(server.floor_plans[0].scale, 1.5);
    assert.equal(target.hasPointerCapture(7), false);
    assert.deepEqual([server.floor_plans[0].x, server.floor_plans[0].y], [0, 0]);
});

test('非表示の図面は編集時だけ表示し、位置保存・終了でis_visibleを変更しない', async () => {
    installPlan({ is_visible: 0, opacity: 0.4 });
    assert.equal(image().hidden, true);
    floor.openFloorPlanManager(); await edit();
    assert.equal(image().hidden, false);
    assert.equal(dom.get('floor-plan-temporary-visible').hidden, false);
    await key(image(), 'ArrowDown', true); await flush();
    floor.finishFloorPlanAdjustMode();
    assert.equal(image().hidden, true);
    assert.equal(server.floor_plans[0].is_visible, 0);
    assert.equal(server.floor_plans[0].y, 10);
});

test('表示checkboxの確定はCanvasの表示状態と専用APIを同期する', async () => {
    await registerPlan();
    dom.get('floor-plan-visible').checked = false;
    await dom.get('floor-plan-visible').dispatch('change'); await flush();
    assert.equal(image().hidden, true);
    assert.equal(server.floor_plans[0].is_visible, 0);
    dom.get('floor-plan-visible').checked = true;
    await dom.get('floor-plan-visible').dispatch('change'); await flush();
    assert.equal(image().hidden, false);
    assert.equal(server.floor_plans[0].is_visible, 1);
    assert.equal(requests.filter(row => row.action === 'update_floor_plan_settings').length, 2);
});

test('opacity入力はDOM previewのみ、changeで最新値一件を保存しresetは位置と倍率だけ確認する', async () => {
    installPlan({ x: 40, y: 60, scale: 0.7, opacity: 0.4, is_visible: 0 });
    floor.openFloorPlanManager(); await edit();
    for (const value of ['80', '55', '30']) {
        dom.get('floor-plan-opacity').value = value;
        await dom.get('floor-plan-opacity').dispatch('input');
    }
    assert.equal(image().style.opacity, '0.3');
    assert.equal(requests.length, 0);
    await dom.get('floor-plan-opacity').dispatch('change'); await flush();
    assert.equal(requests.length, 1); assert.equal(server.floor_plans[0].opacity, 0.3);
    globalThis.confirm = () => false;
    await dom.get('floor-plan-reset-btn').dispatch('click');
    assert.deepEqual(coords(), [40, 60, 0.7]);
    globalThis.confirm = () => true;
    await dom.get('floor-plan-reset-btn').dispatch('click'); await flush();
    assert.deepEqual(coords(), [0, 0, 1]);
    assert.equal(server.floor_plans[0].opacity, 0.3); assert.equal(server.floor_plans[0].is_visible, 0);
});

test('共通resource保存中の連続確定は直列化され、図面の最新値と次revisionだけを送る', async () => {
    await registerPlan(); await edit();
    appState.views[0].name = '変更後';
    held = 'save_resources';
    const saving = flush(); await setImmediate();
    try {
        await key(image(), 'ArrowRight', true);
        await key(image(), 'ArrowRight', true);
        await key(image(), 'ArrowDown', true);
        assert.equal(requests.filter(row => row.action === 'update_floor_plan_settings').length, 0);
        assert.deepEqual(coords(), [20, 10, 1]);
    } finally { release?.(); }
    await saving; await flush();
    const settings = requests.filter(row => row.action === 'update_floor_plan_settings');
    assert.equal(settings.length, 1);
    assert.deepEqual([settings[0].payload.x, settings[0].payload.y, settings[0].payload.expected_revision], [20, 10, 3]);
    assert.equal(server.views[0].name, '変更後');
    assert.deepEqual([server.floor_plans[0].x, server.floor_plans[0].y], [20, 10]);
});

test('図面保存の応答待ちでも操作を続けられ、古い応答で最新座標を巻き戻さない', async () => {
    await registerPlan(); await edit(); held = 'update_floor_plan_settings';
    await key(image(), 'ArrowRight', true); await setImmediate();
    try {
        await key(image(), 'ArrowRight', true); await key(image(), 'ArrowDown', true);
        assert.deepEqual(coords(), [20, 10, 1]);
        assert.equal(requests.filter(row => row.action === 'update_floor_plan_settings').length, 1);
    } finally { release?.(); }
    await flush();
    const settings = requests.filter(row => row.action === 'update_floor_plan_settings');
    assert.deepEqual(settings.map(row => [row.payload.x, row.payload.y, row.payload.expected_revision]), [[10, 0, 2], [20, 10, 3]]);
    assert.deepEqual(coords(), [20, 10, 1]); assert.equal(appState.views[0].resource_revision, 4);
});

for (const outcome of ['saved', 'retry', 'conflict']) {
    test(`network failureは未確認で確定値を保持し、独立server loadから${outcome}を判定する`, async () => {
        await registerPlan(); await edit(); failure = 'network';
        await key(image(), 'ArrowRight', true); await flush();
        assert.equal(appState.appStatus.state, 'unconfirmed');
        assert.deepEqual(coords(), [10, 0, 1]);
        assert.ok(queue.getPendingSave());
        await flush();
        assert.equal(requests.filter(row => row.action === 'update_floor_plan_settings').length, 1, '確認前の再送禁止');
        if (outcome === 'saved') {
            server.floor_plans[0].x = 10; server.floor_plans[0].revision = 2;
            server.views[0].resource_revision = 3; server.revision = 3;
        } else if (outcome === 'conflict') {
            server.floor_plans[0].x = 70; server.views[0].resource_revision = 3; server.revision = 3;
        }
        assert.equal(await queue.confirmPendingSave(), outcome);
        assert.deepEqual(coords(), [10, 0, 1]);
        if (outcome === 'retry') {
            await flush(); assert.equal(server.floor_plans[0].x, 10);
            assert.equal(requests.filter(row => row.action === 'update_floor_plan_settings').length, 2);
        } else if (outcome === 'conflict') {
            assert.equal(queue.hasResourceConflict('views', 1), true);
            assert.equal(await queue.reloadConflictedResource('views', 1), true);
            assert.deepEqual(coords(), [70, 0, 1]);
            assert.equal(queue.hasResourceConflict('views', 1), false);
            assert.equal(image().style.transform, 'translate(70px, 0px) scale(1)');
        } else {
            assert.equal(appState.appStatus.state, 'saved');
            assert.equal(appState.views[0].resource_revision, 3);
            assert.equal(requests.filter(row => row.action === 'update_floor_plan_settings').length, 1);
        }
    });
}

test('同値リセットの応答喪失でも世代が未更新なら競合ではなく再試行する', async () => {
    await registerPlan(); await edit(); failure = 'network';
    floor.resetCurrentFloorPlanSettings();
    await flush();
    assert.equal(appState.appStatus.state, 'unconfirmed');
    assert.equal(await queue.confirmPendingSave(), 'retry');
    assert.equal(queue.hasResourceConflict('views', 1), false);
    await flush();
    assert.equal(appState.appStatus.state, 'saved');
    assert.deepEqual([server.floor_plans[0].x, server.floor_plans[0].y, server.floor_plans[0].scale], [0, 0, 1]);
});

test('SQLite busyの409は調整値とモードを保持し、再読込せず保存を再試行できる', async () => {
    await registerPlan(); await edit(); failure = 'busy';
    await key(image(), 'ArrowRight', true); await flush();
    assert.equal(appState.appStatus.state, 'error');
    assert.equal(appState.appStatus.dirty, true);
    assert.equal(queue.hasResourceConflict('views', 1), false);
    assert.equal(queue.getPendingSave(), null);
    assert.equal(appState.floorPlanAdjustMode, true);
    assert.deepEqual(coords(), [10, 0, 1]);
    assert.equal(server.floor_plans[0].x, 0);
    assert.equal(appState.views[0].resource_revision, server.views[0].resource_revision);
    await key(image(), 'ArrowDown', true); await flush();
    assert.deepEqual([server.floor_plans[0].x, server.floor_plans[0].y], [10, 10]);
    assert.equal(appState.appStatus.state, 'saved');
    assert.equal(requests.filter(row => row.action === 'load').length, 0);
});

test('図面と四隅へのfocusは調整中にaria-hiddenの祖先を持たず、完了後は装飾画像へ戻る', async () => {
    await registerPlan();
    assert.equal(layer.getAttribute('aria-hidden'), 'true');
    await edit();
    for (const target of [image(), ...layer.querySelectorAll('.floor-plan-editor-handle')]) {
        target.focus();
        assert.equal(document.activeElement, target);
        for (let node = target; node; node = node.parentElement) {
            assert.notEqual(node.getAttribute('aria-hidden'), 'true');
        }
        assert.ok(target.getAttribute('aria-label'));
    }
    floor.finishFloorPlanAdjustMode();
    assert.equal(document.activeElement, palette);
    assert.equal(layer.getAttribute('aria-hidden'), 'true');
    assert.equal(layer.querySelector('.floor-plan-editor-handle'), null);
    assert.equal(image().tabIndex, -1);
});

test('400は確定値を保持して通常再試行でき、409は値を保持して対象reloadまで送信を止める', async () => {
    await registerPlan(); await edit(); failure = 400;
    await key(image(), 'ArrowRight', true); await flush();
    assert.equal(queue.getPendingSave(), null); assert.deepEqual(coords(), [10, 0, 1]);
    await flush(); assert.equal(server.floor_plans[0].x, 10);
    failure = 409; await key(image(), 'ArrowDown', true); await flush();
    assert.deepEqual(coords(), [10, 10, 1]); assert.equal(queue.hasResourceConflict('views', 1), true);
    const count = requests.length; await flush(); assert.equal(requests.length, count);
    server.floor_plans[0].x = 90; server.floor_plans[0].y = 40; server.views[0].resource_revision++;
    globalThis.confirm = () => false;
    assert.equal(await queue.reloadConflictedResource('views', 1), false); assert.deepEqual(coords(), [10, 10, 1]);
    globalThis.confirm = () => true;
    assert.equal(await queue.reloadConflictedResource('views', 1), true); assert.deepEqual(coords(), [90, 40, 1]);
});

test('未確認図面と5設定が一致しても差替/別操作の図面revisionはsavedと誤認しない', async () => {
    await registerPlan(); await edit(); failure = 'network';
    await key(image(), 'ArrowRight', true); await flush();
    server.floor_plans[0].x = 10; server.floor_plans[0].revision = 3;
    server.floor_plans[0].image_url = '/replacement.png?revision=3';
    server.views[0].resource_revision = 4; server.revision = 4;
    assert.equal(await queue.confirmPendingSave(), 'conflict');
    assert.equal(queue.hasResourceConflict('views', 1), true);
    assert.deepEqual(coords(), [10, 0, 1]);
    assert.equal(appState.floorPlans[0].image_url, '/floor.png?revision=2');
    assert.equal(await queue.reloadConflictedResource('views', 1), true);
    assert.equal(image().src, '/replacement.png?revision=3');
});

for (const aggregate of ['view', 'placements', 'links', 'canvas_notes']) {
    test(`未確認図面の5設定一致でも別画面による${aggregate}更新は競合として保持し、古いaggregateを上書きしない`, async () => {
        await registerPlan(); await edit(); failure = 'network';
        await key(image(), 'ArrowRight', true); await flush();
        assert.equal(appState.appStatus.state, 'unconfirmed');
        server.floor_plans[0].x = 10;
        server.floor_plans[0].revision = 2;
        server.views[0].resource_revision = 4; server.revision = 4;
        if (aggregate === 'view') server.views[0].name = '別画面の新しい名称';
        else if (aggregate === 'placements') server.placements = [{ id: 11, view_id: 1, device_id: 1, x: 500, y: 600 }];
        else if (aggregate === 'links') server.links = [{ id: 12, view_id: 1, from_id: 1, to_id: 2, bandwidth: '1G' }];
        else server.canvas_notes = [{ id: 13, view_id: 1, x: 50, y: 80, text: '別画面の新しいメモ' }];
        const remote = structuredClone(server);
        assert.equal(await queue.confirmPendingSave(), 'conflict');
        assert.equal(queue.hasResourceConflict('views', 1), true);
        assert.deepEqual(coords(), [10, 0, 1]);
        assert.equal(appState.views[0].resource_revision, 2, '競合revisionをローカルの旧aggregateへ採用しない');
        appState.views[0].name = 'ローカルの編集を保持';
        await flush();
        assert.deepEqual(server, remote, '競合確認後に古いview本体や子要素を送信しない');
        assert.equal(requests.filter(row => row.action === 'save_resources').length, 0);
    });
}

for (const operation of ['replace', 'delete']) {
    test(`dirty viewを持つ図面${operation}は共通保存後の現行revisionを使い自己競合しない`, async () => {
        await registerPlan();
        appState.views[0].name = 'ファイル変更前の名称更新';
        if (operation === 'replace') await choose(imageFile('new.png'));
        else await dom.get('floor-plan-delete-btn').dispatch('click');
        await setImmediate();
        const saves = requests.filter(row => row.action !== 'load');
        assert.deepEqual(saves.map(row => row.action), ['upload_floor_plan', 'save_resources',
            operation === 'replace' ? 'upload_floor_plan' : 'delete_floor_plan']);
        assert.equal(Number(saves[2].payload.expected_revision), 3);
        assert.equal(appState.views[0].resource_revision, 4);
        assert.equal(server.views[0].name, 'ファイル変更前の名称更新');
        assert.equal(appState.appStatus.state, 'saved');
        if (operation === 'replace') assert.equal(appState.floorPlans[0].original_name, 'new.png');
        else assert.deepEqual(appState.floorPlans, []);
    });
}

test('未登録・file選択取消は通信せず、形式/寸法/画像読込エラーを実フォームへ表示する', async () => {
    await dom.get('vm-floor-plan-btn').dispatch('click');
    assert.equal(dom.get('floor-plan-empty').hidden, false); assert.equal(dom.get('floor-plan-file').hidden, true);
    await choose(null); assert.equal(requests.length, 0);
    await choose(new File(['test'], 'bad.gif', { type: 'image/gif' }));
    assert.match(dom.get('floor-plan-file-error').textContent, /PNG/);
    dimensions.width = 7001;
    await choose(); assert.equal(dom.get('floor-plan-file-error').hidden, false);
    dimensions = { width: 7000, height: 5001 };
    await choose(); assert.equal(dom.get('floor-plan-file-error').hidden, false);
    dimensions = { width: 800, height: 600, error: true };
    await choose(); assert.match(dom.get('floor-plan-file-error').textContent, /読み込めません/);
    assert.equal(requests.length, 0); assert.equal(appState.isFloorPlanUpdating, false);
});

test('入力の7000px・3500万画素と30MiB境界を送信前に検査する', async () => {
    dimensions = { width: 7000, height: 5000 };
    await choose();
    assert.equal(requests.filter(row => row.action === 'upload_floor_plan').length, 1);
    const previous = structuredClone(appState.floorPlans);
    const count = requests.length;
    const header = imageFile();
    await choose(new File([header, new Uint8Array(30 * 1024 * 1024 + 1 - header.size)], 'large.png', { type: 'image/png' }));
    assert.equal(requests.length, count);
    assert.deepEqual(appState.floorPlans, previous);
    assert.equal(dom.get('floor-plan-file-error').hidden, false);
    await choose(new File([header, new Uint8Array(30 * 1024 * 1024 - header.size)], 'boundary.png', { type: 'image/png' }));
    assert.equal(requests.filter(row => row.action === 'upload_floor_plan').length, 2);
});

test('JPEGの長いfill bytesと複数APP/COMを窓単位で読み、SOF寸法まで到達する', async () => {
    const jpeg = new Uint8Array(await imageFile('source.jpg', 'image/jpeg').arrayBuffer());
    const app = new Uint8Array(65537);
    app.set([255, 225, 255, 255]); // APP1: 長さ65535（長さフィールドを含む）。
    const comment = app.slice();
    comment[1] = 254;
    const fill = new Uint8Array(150000).fill(255);
    const file = new File([jpeg.subarray(0, 2), app, app, comment, fill, jpeg.subarray(2)],
        'long-header.jpg', { type: 'image/jpeg' });
    const slice = file.slice.bind(file);
    let reads = 0;
    file.slice = (...args) => { reads++; return slice(...args); };
    await choose(file);
    assert.equal(requests.filter(row => row.action === 'upload_floor_plan').length, 1);
    assert.equal(dom.get('floor-plan-file-error').hidden, true);
    assert.ok(reads <= 10, `ヘッダー窓の読込回数: ${reads}`);
});

test('JPEGのfill bytesだけで終わる入力は窓単位で拒否し通信しない', async () => {
    const file = new File([new Uint8Array([255, 216]), new Uint8Array(200000).fill(255)],
        'truncated.jpg', { type: 'image/jpeg' });
    const slice = file.slice.bind(file);
    let reads = 0;
    file.slice = (...args) => { reads++; return slice(...args); };
    await choose(file);
    assert.equal(requests.length, 0);
    assert.equal(dom.get('floor-plan-file-error').hidden, false);
    assert.ok(reads <= 5, `ヘッダー窓の読込回数: ${reads}`);
});

test('登録API失敗・権限喪失は既存図面と管理dialogを維持し再登録できる', async t => {
    t.mock.method(console, 'error', () => {});
    await registerPlan();
    const existing = structuredClone(appState.floorPlans[0]);
    failure = 400;
    await choose(imageFile('failed.png'));
    assert.deepEqual(appState.floorPlans[0], existing);
    assert.equal(dom.get('floor-plan-manager-overlay').hidden, false);
    assert.equal(appState.isFloorPlanUpdating, false);
    assert.equal(dom.get('floor-plan-upload-btn').disabled, false);
    window.APP_CONFIG.user.isAdmin = false;
    const count = requests.length;
    await choose(imageFile('denied.png'));
    assert.equal(requests.length, count);
    assert.deepEqual(appState.floorPlans[0], existing);
    window.APP_CONFIG.user.isAdmin = true;
    await choose(imageFile('recovered.png'));
    assert.equal(appState.floorPlans[0].original_name, 'recovered.png');
});

test('差替は設定とFit履歴を保持しcache URL/metadataを更新、削除は図面とFit履歴だけを除く', async () => {
    await registerPlan(); await edit(); await key(image(), 'ArrowRight', true); await flush(); floor.finishFloorPlanAdjustMode();
    floor.openFloorPlanManager();
    const previousUrl = image().src;
    dimensions = { width: 1600, height: 900 };
    await choose(imageFile('replacement.jpg', 'image/jpeg'));
    assert.deepEqual(coords(), [10, 0, 1]); assert.notEqual(image().src, previousUrl);
    assert.equal(dom.get('floor-plan-file-name').textContent, 'replacement.jpg');
    assert.equal(dom.get('floor-plan-dimensions').textContent, '1600 × 900 px');
    assert.equal(appState.floorPlanAutoFittedViews.has(1), true);
    const placements = appState.placements; const links = appState.links;
    await dom.get('floor-plan-delete-btn').dispatch('click');
    await setImmediate();
    assert.deepEqual(appState.floorPlans, []); assert.equal(image(), null);
    assert.equal(appState.floorPlanAutoFittedViews.has(1), false);
    assert.equal(appState.placements, placements); assert.equal(appState.links, links);
    assert.equal(dom.get('floor-plan-empty').hidden, false);
});

for (const reason of ['pointercancel', 'lostpointercapture', 'escape', 'other-context', 'auth', 'permission', 'view', 'modal']) {
    test(`未確定pointerは${reason}で取消しcaptureを解放、確定済み位置を保持する`, async () => {
        await registerPlan(); await edit(); await key(image(), 'ArrowRight', true); await flush();
        const target = await drag(70, 40, { end: null });
        if (reason === 'pointercancel' || reason === 'lostpointercapture') await target.dispatch(reason, { pointerId: 7 });
        else if (reason === 'escape') { await escape(); await escape(); }
        else if (reason === 'other-context') context.finishCanvasContextToolbar('replace');
        else if (reason === 'auth') { appState.authExpired = true; eventBus.emit('auth:expired'); }
        else if (reason === 'permission') { window.APP_CONFIG.user.isAdmin = false; floor.renderFloorPlan(); }
        else if (reason === 'view') {
            appState.views.push(normalizeView({ id: 2, name: '別ビュー', resource_revision: 1 }));
            resource.resetResourceBaseline(appState); await manager.switchView(2);
        } else floor.openFloorPlanManager();
        assert.equal(target.hasPointerCapture(7), false);
        assert.equal(layer.getAttribute('aria-hidden'), String(!appState.floorPlanAdjustMode));
        assert.deepEqual(coords(), [10, 0, 1]);
        await flush(); assert.equal(server.floor_plans[0].x, 10);
        assert.equal(requests.filter(row => row.action === 'update_floor_plan_settings').length, 1);
    });
}

test('既存巨大画像も編集可能で、初期FitとCanvas zoomは図面倍率/保存座標から独立する', async () => {
    installPlan({ image_width: 12000, image_height: 8000, x: 30, y: 50, scale: 0.2 });
    await image().dispatch('load');
    const fitted = { ...appState.viewState };
    assert.equal(appState.floorPlanAutoFittedViews.has(1), true);
    floor.openFloorPlanManager(); await edit();
    assert.deepEqual(coords(), [30, 50, 0.2]); assert.deepEqual(appState.viewState, fitted);
    appState.viewState.scale = 0.5; eventBus.emit('canvas:view-transformed');
    const handle = layer.querySelector('[data-floor-plan-corner="se"]');
    assert.ok(handle); assert.equal(handle.hidden, false);
    await drag(20, 10); await flush();
    assert.deepEqual(coords(), [50, 60, 0.2]);
    floor.finishFloorPlanAdjustMode(); await image().dispatch('load');
    assert.equal(appState.viewState.scale, 0.5); assert.deepEqual(coords(), [50, 60, 0.2]);
});

test('管理dialogの通常close/Escは起動元へ戻り、未適用view入力と権限を守る', async () => {
    dom.get('vm-name').value = '未適用'; manager.updateViewManagerFormState();
    await manager.openSelectedViewFloorPlan(); assert.equal(getTopModalContainer(), dom.get('view-manager-overlay'));
    dom.get('vm-name').value = '合成フロア'; manager.updateViewManagerFormState();
    await registerPlan(); await escape();
    assert.equal(getTopModalContainer(), dom.get('view-manager-overlay'));
    await escape(); assert.equal(getTopModalContainer(), null);
    floor.openFloorPlanManager(); window.APP_CONFIG.user.isAdmin = false; floor.closeFloorPlanManager();
    assert.equal(getTopModalContainer(), null);
    floor.openFloorPlanManager(); assert.equal(dom.get('floor-plan-manager-overlay').hidden, true);
});
