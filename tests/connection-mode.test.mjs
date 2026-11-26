import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { installWorkspaceDom } from './helpers/workspace-dom.mjs';

// 他のテストの初期化に依存せず、実パレットと実キャンバスのcallerを通す。
const dom = installWorkspaceDom({
    phpSetup: "require_once 'bootstrap.php'; $appConfig = \\Netarium\\Core\\Config::create(); $storageCapacity = $appConfig['storage_capacity']; ",
    templates: [
    'templates/components/tool_palette.php', 'templates/components/canvas.php',
    'templates/components/canvas_context_toolbar.php', 'templates/components/status_bar.php',
    'templates/components/toast.php', 'templates/modals/floor_plan_manager.php',
    'templates/components/link_panel.php', 'templates/components/property_panel.php'
] });
const { appState, normalizeDevice, normalizeView, normalizeLink } = await import('../public/js/core/state.js');
const toolbar = await import('../public/js/ui/toolbar.js');
const wiring = await import('../public/js/ui/wiring-controls.js');
const canvas = await import('../public/js/canvas/renderer.js');
const navigation = await import('../public/js/ui/workspace-navigation.js');
const placement = await import('../public/js/ui/placement-mode.js');
const notes = await import('../public/js/canvas/canvas-notes.js');
const floorPlan = await import('../public/js/modals/floor-plan-modal.js');
const routes = await import('../public/js/canvas/link-route-editor.js');
const manager = await import('../public/js/modals/view-manager-modal.js');
const { onKeyDown } = await import('../public/js/canvas/selection.js');
const { onCanvasPointerDown } = await import('../public/js/canvas/drag-drop.js');
const property = await import('../public/js/ui/property-panel.js');
const { eventBus } = await import('../public/js/core/event-bus.js');
const { syncLinkModeButton } = await import('../public/js/ui/toolbar-controls.js');
eventBus.on('toolbar:sync-link-mode', syncLinkModeButton);
eventBus.on('canvas:render-floor-plan', floorPlan.renderFloorPlan);
const resource = await import('../public/js/core/resource-save.js');
const { resetConnectionBaseline } = await import('../public/js/core/connection-save.js');
const queue = await import('../public/js/core/save-queue.js');
const contextToolbar = await import('../public/js/ui/canvas-context-toolbar.js');
const { getTopModalContainer } = await import('../public/js/core/modal-focus.js');

document.readyState = 'loading';
const { registerStaticListeners } = await import('../public/js/main.js');
registerStaticListeners();
dom.events.addEventListener('keydown', onKeyDown);
dom.get('canvas').addEventListener('click', canvas.onCanvasClick);
dom.get('canvas').addEventListener('pointerdown', onCanvasPointerDown);
navigation.initWorkspaceNavigation();
wiring.initWiringControls();
notes.initCanvasNotes();

let requests;
let connectionConflict;
let holdNext;
let releaseResponse;
let responseMaps;
let nextServerLinkId;
let saveRejection;
let legacyCalls;
let serverLegacyRows;
let resolveLegacyWrite;

globalThis.fetch = async (url, options) => {
    if (url.includes('action=load')) {
        legacyCalls.push(['load', appState.dataRevision]);
        return new Response(JSON.stringify({
            ok: true, revision: appState.dataRevision, views: appState.views, legacy_link_conflicts: serverLegacyRows
        }));
    }
    if (url.includes('action=resolve_legacy_link_conflict')) {
        const payload = JSON.parse(options.body);
        legacyCalls.push(['delete', payload]);
        return resolveLegacyWrite(payload);
    }
    if (url.includes('action=ping')) {
        if (holdNext) {
            holdNext = false;
            await new Promise(resolve => { releaseResponse = resolve; });
        }
        return new Response(JSON.stringify({ ok: true, monitor_revision: 1, results: [
            { id: 1, status: 'green', response_ms: 1, checked_at: '2026-10-08T01:00:00Z' }
        ] }));
    }
    if (url.includes('action=update_floor_plan_settings')) {
        const payload = JSON.parse(options.body);
        requests.push(payload);
        return new Response(JSON.stringify({ revision: appState.dataRevision + 1,
            view_revision: payload.expected_revision + 1,
            floor_plan_settings: { ...payload, revision: 2 } }));
    }
    if (url.includes('action=save_connections')) {
        const payload = JSON.parse(options.body);
        requests.push(payload);
        if (holdNext) {
            holdNext = false;
            await new Promise(resolve => { releaseResponse = resolve; });
        }
        if (saveRejection) {
            return new Response(JSON.stringify({ ok: false, error: saveRejection }), { status: 400 });
        }
        if (connectionConflict) {
            const stale = payload.links.find(row => row.operation === 'update');
            assert.ok(stale, '競合応答は既存接続の更新を対象とする');
            return new Response(JSON.stringify({ ok: false, error: '別の管理者が更新しました',
                details: { conflicts: [{ resource: 'links', id: stale.id, name: '既存の接続' }] }
            }), { status: 409 });
        }
        assert.deepEqual(payload.device_ports, []);
        const links = Object.fromEntries(payload.links.filter(row => row.operation === 'create')
            .map(row => [row.id, nextServerLinkId++]));
        const ports = [];
        const saved = payload.links.filter(row => row.operation !== 'delete').map(row => {
            const link = { ...row.link, id: links[row.id] ?? row.id, resource_revision: (row.expected_revision || 0) + 1 };
            for (const [offset, side] of ['from', 'to'].entries()) {
                const key = `${side}_port_name`;
                if (!Object.hasOwn(link, key)) continue;
                const name = link[key];
                const port = name && {
                    id: link.id * 10 + offset, name, device_id: link[`${side}_id`], memo: '', resource_revision: 1
                };
                if (port) ports.push(port);
                link[`${side}_port_id`] = port ? port.id : null;
                delete link[key];
            }
            return link;
        });
        return new Response(JSON.stringify({
            ok: true, revision: appState.dataRevision + 1, saved_at: '2026-10-08T01:00:00Z',
            id_maps: { links, device_ports: {} }, device_ports: ports, views: [], removed_view_link_routes: [],
            links: saved, deleted_link_ids: payload.links.filter(row => row.operation === 'delete').map(row => row.id),
            deleted_device_port_ids: []
        }));
    }
    assert.match(url, /action=save_resources/);
    const payload = JSON.parse(options.body);
    requests.push(payload);
    const { newIds } = resource.createPendingResourceSave(payload);
    const maps = Object.fromEntries(Object.entries(newIds).map(([kind, ids]) => [kind,
        Object.fromEntries(ids.map(id => [id, responseMaps[kind]?.[id] ?? id + 1000]))
    ]));
    const mapped = (kind, id) => Number(maps[kind]?.[id] ?? id);
    if (holdNext) {
        holdNext = false;
        await new Promise(resolve => { releaseResponse = resolve; });
    }
    return new Response(JSON.stringify({
        ok: true, revision: appState.dataRevision + 1, saved_at: '2026-10-08T01:00:00Z', id_maps: maps,
        devices: payload.devices.filter(row => row.operation !== 'delete').map(row => ({
            ...row.device, id: mapped('devices', row.id), resource_revision: (row.expected_revision || 0) + 1
        })),
        views: payload.views.filter(row => row.operation !== 'delete').map(row => ({
            ...row.view, id: mapped('views', row.id), resource_revision: (row.expected_revision || 0) + 1
        })),
        placements: payload.views.flatMap(row => (row.placements || []).map(item => ({
            ...item, id: mapped('placements', item.id), view_id: mapped('views', item.view_id), device_id: mapped('devices', item.device_id)
        }))),
        view_link_routes: payload.views.flatMap(row => (row.view_link_routes || []).map(item => ({
            ...item, view_id: mapped('views', item.view_id),
            device_a_id: mapped('devices', item.device_a_id), device_b_id: mapped('devices', item.device_b_id)
        }))),
        canvas_notes: payload.views.flatMap(row => row.canvas_notes || []),
        deleted_device_ids: [], deleted_view_ids: [], affected_view_ids: payload.views.map(row => mapped('views', row.id))
    }));
};

beforeEach(() => {
    queue.clearPendingSave();
    floorPlan.finishFloorPlanAdjustMode('replace');
    floorPlan.closeFloorPlanManager();
    wiring.closeWiringControls({ restoreFocus: false });
    navigation.closeWorkspaceNavigation();
    placement.exitPlacementMode();
    notes.finishCanvasNotes();
    routes.finishLinkRouteEdit();
    property.closeLinkPanel();
    appState.floorPlanAdjustMode = false;
    window.APP_CONFIG.user.isAdmin = true;
    appState.views = [normalizeView({ id: 10, name: '対象ビュー', resource_revision: 1 }), normalizeView({ id: 20, name: '別ビュー', resource_revision: 1 })];
    appState.devices = ['元SW', '先AP', '予備SW', '別ビューの機器'].map((name, index) => normalizeDevice({
        id: index + 1, name, ip: `192.0.2.${index + 1}`, type: 'switch', resource_revision: 1
    }));
    appState.placements = [1, 2, 3, 4].map(id => ({ id: id + 10, device_id: id, view_id: id === 4 ? 20 : 10, x: id * 200, y: 100 }));
    appState.links = []; appState.devicePorts = []; appState.viewLinkRoutes = []; appState.legacyLinkConflicts = [];
    appState.linkSystems = []; appState.floorPlans = []; appState.canvasNotes = []; appState.deviceImages = [];
    appState.floorRackPlacements = []; appState.rackSettings = []; appState.rackMounts = [];
    appState.currentViewId = 10; appState.dataRevision = 1; appState.nextLinkId = 1;
    appState.linkMode = false; appState.linkSourceId = null; appState.linkSourceFixed = false; appState.linkSourceConnected = false;
    appState.noteMode = false; appState.selectedCanvasNoteId = null; appState.editingDeviceId = null; appState.editingLinkId = null;
    appState.selectedPlacementIds = new Set(); appState.viewStates = new Map(); appState.floorPlanAutoFittedViews = new Set();
    appState.resourceConflicts = { devices: new Map(), views: new Map(), links: new Map(), device_ports: new Map() };
    appState.authExpired = false; appState.isPinging = false; appState.isSaving = false;
    appState.isRangeSelecting = false; appState.suppressNextClick = false;
    appState.appStatus = { dirty: false, state: 'saved', lastSavedAt: null, lastError: null };
    appState.viewState = { scale: 1, panX: 0, panY: 0 };
    appState.canvas = dom.get('canvas'); appState.world = dom.get('world');
    appState.currentSvg = dom.get('link-layer'); appState.deviceLayer = dom.get('device-layer');
    appState.floorPlanLayer = dom.get('floor-plan-layer'); appState.noteLayer = dom.get('canvas-note-layer');
    requests = []; connectionConflict = false; holdNext = false; releaseResponse = null; responseMaps = {};
    nextServerLinkId = 1001;
    saveRejection = null;
    legacyCalls = [];
    serverLegacyRows = [];
    resolveLegacyWrite = ({ legacy_link_id, view_id, expected_revision }) => {
        serverLegacyRows = serverLegacyRows.filter(row => row.legacy_link_id !== legacy_link_id || row.view_id !== view_id);
        return new Response(JSON.stringify({
            ok: true, legacy_link_id, revision: expected_revision + 1, removed_view_link_routes: [], views: []
        }));
    };
    resource.resetResourceBaseline(appState);
    eventBus.emit('resources:reloaded');
    document.body.focus();
    canvas.render();
});
after(() => { queue.clearPendingSave(); });

const panel = () => dom.get('wiring-controls');
const sourceElement = id => appState.deviceLayer.querySelector(`[data-device-id="${id}"]`);
const clickDevice = async id => {
    const element = sourceElement(id);
    assert.ok(element, `機器${id}がキャンバスに表示される`);
    await element.dispatch('click');
};
const start = () => dom.get('linkBtn').dispatch('click');
const flush = () => queue.flushSaveQueue({ silent: true });
const instruction = () => dom.get('wiring-instruction').textContent;
const fixSource = async (checked = true) => {
    const checkbox = dom.get('wiring-source-fixed'); checkbox.checked = checked; await checkbox.dispatch('change');
};
const assertEnded = () => {
    assert.equal(appState.linkMode, false);
    assert.equal(appState.linkSourceId, null);
    assert.equal(appState.linkSourceFixed, false);
    assert.equal(appState.linkSourceConnected, false);
    assert.equal(panel().hidden, true);
    assert.equal(dom.get('linkBtn').getAttribute('aria-pressed'), 'false');
    assert.equal(appState.deviceLayer.querySelector('.link-source'), null);
};
const assertClientOnly = payload => assert.doesNotMatch(JSON.stringify(payload), /"linkSource(?:Id|Fixed|Connected)"/);

// 文言そのものではなく、作成前後の案内・選択・保存の変化を観察する。
test('開始は一覧を閉じて補助パネルを開き、固定OFFでは1本ごとに接続元を選び直す', async () => {
    navigation.openWorkspaceNavigation();
    await start();
    assert.equal(dom.get('workspace-nav-panel').hidden, true);
    assert.equal(panel().hidden, false);
    assert.equal(dom.get('linkBtn').getAttribute('aria-pressed'), 'true');
    assert.equal(dom.get('wiring-instruction').getAttribute('role'), 'status');
    const before = instruction();
    assert.equal(dom.get('wiring-source-fixed').checked, false);
    assert.equal(dom.get('wiring-target-search').hidden, true);
    const help = panel().querySelector('a');
    assert.match(help.getAttribute('href'), /help-canvas\.html#connections$/);
    assert.equal(help.getAttribute('target'), '_blank');
    const source = sourceElement(1);
    assert.equal(source.tabIndex, 0);
    assert.equal(source.getAttribute('role'), 'button');
    assert.match(source.getAttribute('aria-label'), /元SW.*192\.0\.2\.1/);
    source.focus();
    await source.dispatch('keydown', { key: 'Enter' });
    assert.equal(document.activeElement, sourceElement(1));
    assert.equal(sourceElement(1).getAttribute('aria-pressed'), 'true');
    assert.equal(appState.linkSourceId, 1);
    assert.equal(sourceElement(1).classList.contains('link-source'), true);
    assert.match(panel().textContent, /元SW/);
    assert.match(panel().textContent, /192\.0\.2\.1/);
    assert.notEqual(instruction(), before);
    assert.equal(requests.length, 0);
    sourceElement(2).focus();
    await sourceElement(2).dispatch('keydown', { key: ' ' });
    assert.equal(document.activeElement, sourceElement(2));
    await flush();
    assert.equal(document.activeElement, sourceElement(2), '保存応答の再描画後も機器のキー操作を継続できる');
    assert.equal(appState.linkMode, true);
    assert.equal(panel().hidden, false);
    assert.equal(appState.linkSourceId, null);
    assert.equal(sourceElement(1).classList.contains('link-source'), false);
    assert.equal(instruction(), before);
    assert.deepEqual(appState.links.map(link => [link.from_id, link.to_id, link.resource_revision]), [[1, 2, 1]]);
    assert.equal(requests.length, 1);
    const [created] = requests[0].links;
    assert.equal(created.operation, 'create');
    assert.equal('expected_revision' in created, false);
    assert.deepEqual([created.link.from_id, created.link.to_id], [1, 2]);
    assert.equal(appState.views[0].resource_revision, 1, '接続作成ではビューのrevisionを上げない');
    assertClientOnly(requests[0]);
});

for (const fixed of [false, true]) {
    for (const finish of ['pointerup', 'pointercancel']) {
        test(`接続元固定${fixed ? 'ON' : 'OFF'}の空白パンは${finish}後も接続を継続し、別ポインターと直後のクリックを無視する`, async () => {
            await start();
            await clickDevice(1);
            if (fixed) {
                await fixSource();
                await clickDevice(3);
                await flush();
            }
            const linksBefore = appState.links.length;
            const connectedBefore = appState.linkSourceConnected;
            const waiting = instruction();
            appState.viewState = { scale: 1.5, panX: 20, panY: -10 };
            const pointer = { pointerId: 7, button: 0, clientX: 100, clientY: 100, shiftKey: fixed };
            await appState.canvas.dispatch('pointerdown', pointer);
            assert.equal(appState.canvas.hasPointerCapture(7), true);
            assert.equal(appState.isRangeSelecting, false, '接続中のShiftドラッグは矩形選択を始めない');
            await dom.events.dispatch('pointermove', { ...pointer, clientX: 160, clientY: 140 });
            assert.deepEqual(appState.viewState, { scale: 1.5, panX: 80, panY: 30 });
            assert.equal(appState.world.style.transform, 'translate(80px, 30px) scale(1.5)');
            assert.equal(appState.linkSourceId, 1);
            assert.equal(appState.linkSourceFixed, fixed);
            assert.equal(appState.linkSourceConnected, connectedBefore);
            assert.equal(instruction(), waiting);
            await dom.events.dispatch('pointermove', { ...pointer, pointerId: 8, clientX: 900 });
            await dom.events.dispatch(finish, { ...pointer, pointerId: 8 });
            assert.deepEqual(appState.viewState, { scale: 1.5, panX: 80, panY: 30 });
            assert.equal(appState.canvas.hasPointerCapture(7), true);
            await dom.events.dispatch(finish, pointer);
            assert.equal(appState.canvas.hasPointerCapture(7), false);
            assert.equal(appState.canvas.classList.contains('panning'), false);
            await clickDevice(2);
            assert.equal(appState.links.length, linksBefore, 'パン直後の機器クリックでは接続しない');
            assert.equal(appState.linkSourceId, 1);
            assert.equal(appState.linkSourceConnected, connectedBefore);
            await dom.events.dispatch('pointermove', { ...pointer, clientX: 700 });
            assert.deepEqual(appState.viewState, { scale: 1.5, panX: 80, panY: 30 });
            await appState.canvas.dispatch('pointerdown', pointer);
            await dom.events.dispatch('pointerup', pointer);
            assert.equal(appState.canvas.hasPointerCapture(7), false, '終了後も次のパンを開始・終了できる');
            await appState.canvas.dispatch('click');
            assert.equal(appState.linkSourceId, 1, '空白の単純クリックでは接続元を変えない');
            await clickDevice(2);
            await flush();
            assert.deepEqual(appState.links.map(link => [link.from_id, link.to_id]),
                fixed ? [[1, 3], [1, 2]] : [[1, 2]]);
            assert.equal(appState.linkMode, true);
            assert.equal(appState.linkSourceId, fixed ? 1 : null);
            assert.equal(appState.linkSourceFixed, fixed);
        });
    }
}

test('接続モードでは機器・接続線・経路編集・メモ・操作要素上からパンを開始しない', async () => {
    await start();
    await clickDevice(1);
    for (const className of ['floor-rack', 'device', 'link-group', 'link-count-badge', 'link-route-editor', 'canvas-note']) {
        const parent = document.createElement('div');
        parent.className = className;
        const child = document.createElement('span');
        parent.append(child);
        await appState.canvas.dispatch('pointerdown', { target: child, pointerId: 7, button: 0 });
        assert.equal(appState.canvas.hasPointerCapture(7), false, className);
    }
    for (const target of [dom.get('canvas-context-toolbar'),
        ...['button', 'input', 'select', 'textarea'].map(tag => document.createElement(tag))]) {
        await appState.canvas.dispatch('pointerdown', { target, pointerId: 7, button: 0 });
        assert.equal(appState.canvas.hasPointerCapture(7), false, target.tagName);
    }
    await dom.events.dispatch('pointermove', { pointerId: 7, clientX: 500, clientY: 600 });
    assert.deepEqual(appState.viewState, { scale: 1, panX: 0, panY: 0 });
    assert.equal(appState.linkSourceId, 1);
    assert.equal(appState.linkMode, true);
});

test('未選択・通常完了・固定作成・選び直しで同じ骨格を保ち、未選択操作をdisabledにする', async () => {
    await start();
    const ids = ['wiring-source-info', 'wiring-source-name', 'wiring-source-ip', 'wiring-source-icon',
        'wiring-source-fixed-label', 'wiring-source-fixed', 'wiring-instruction', 'wiring-reselect-source'];
    const nodes = ids.map(id => dom.get(id));
    const assertSkeleton = () => {
        ids.forEach((id, index) => assert.equal(dom.get(id), nodes[index]));
        for (const id of ['wiring-source-info', 'wiring-source-fixed-label', 'wiring-instruction', 'wiring-reselect-source']) {
            assert.equal(dom.get(id).hidden, false);
        }
    };
    const assertUnselected = () => {
        assertSkeleton();
        assert.equal(dom.get('wiring-source-name').textContent, '未選択');
        assert.equal(dom.get('wiring-source-icon').style.visibility, 'hidden');
        assert.equal(dom.get('wiring-source-ip').hidden, true);
        assert.equal(dom.get('wiring-source-fixed').disabled, true);
        assert.equal(dom.get('wiring-source-fixed').checked, false);
        assert.equal(dom.get('wiring-reselect-source').disabled, true);
    };
    assertUnselected();
    const initialInstruction = instruction();
    await clickDevice(1);
    assertSkeleton();
    assert.equal(dom.get('wiring-source-name').textContent, '元SW');
    assert.equal(dom.get('wiring-source-icon').style.visibility, 'visible');
    assert.equal(dom.get('wiring-source-fixed').disabled, false);
    assert.equal(dom.get('wiring-reselect-source').disabled, false);
    await clickDevice(2);
    await flush();
    assertUnselected();
    assert.equal(instruction(), initialInstruction);
    await clickDevice(1);
    await fixSource();
    const firstTargetInstruction = instruction();
    await clickDevice(3);
    await flush();
    assertSkeleton();
    assert.equal(appState.linkSourceId, 1);
    assert.equal(dom.get('wiring-source-fixed').checked, true);
    assert.equal(dom.get('wiring-source-fixed').disabled, false);
    assert.equal(dom.get('wiring-reselect-source').disabled, false);
    assert.notEqual(instruction(), firstTargetInstruction);
    await dom.get('wiring-reselect-source').dispatch('click');
    assertUnselected();
    assert.equal(instruction(), initialInstruction);
});

test('ヘッダーの補助導線は未選択時も操作でき、本文に混在せず再描画でフォーカスを失わない', async () => {
    await start();
    const header = panel().querySelector('.wiring-header');
    const content = dom.get('wiring-controls-content');
    const list = dom.get('wiring-open-list');
    const help = dom.get('wiring-help');
    assert.equal(list.parentElement.children[0], dom.get('wiring-controls-title'));
    assert.equal(help.parentElement.children[1], dom.get('wiring-close-btn'));
    assert.deepEqual(header.querySelectorAll('button, a').map(node => node.id),
        ['wiring-open-list', 'wiring-help', 'wiring-close-btn']);
    assert.equal(content.contains(list), false);
    assert.equal(content.contains(help), false);
    assert.equal(list.getAttribute('aria-label'), '接続一覧を開く');
    assert.equal(help.getAttribute('aria-label'), '接続の使い方（別タブで開く）');
    help.focus();
    appState.devices[0].name = '合成機器_' + '長い名称'.repeat(12);
    await clickDevice(1);
    assert.equal(document.activeElement, help);
    assert.equal(dom.get('wiring-source-name').textContent, appState.devices[0].name);
    assert.ok(dom.get('wiring-reselect-source').parentElement.contains(dom.get('wiring-source-name')));
    assert.ok(content.contains(dom.get('wiring-source-fixed')));
    await dom.get('wiring-reselect-source').dispatch('click');
    await list.dispatch('click');
    assertEnded();
    assert.equal(dom.get('workspace-nav-tab-links').getAttribute('aria-selected'), 'true');
});

test('接続元は種別アイコンと名前・IPを表示し、IPなしでは空行を残さない', async () => {
    appState.devices[0].type = 'firewall';
    appState.devices[0].name = '合成FW';
    await start();
    await clickDevice(1);
    const icon = dom.get('wiring-source-icon');
    assert.match(icon.src, /assets\/icons\/devices\/firewall\.svg$/);
    assert.equal(icon.alt, '');
    assert.equal(icon.getAttribute('aria-hidden'), 'true');
    assert.equal(dom.get('wiring-source-name').textContent, '合成FW');
    assert.equal(dom.get('wiring-source-ip').hidden, false);
    assert.equal(dom.get('wiring-source-ip').textContent, '192.0.2.1');
    appState.devices[0].ip = '';
    appState.devices[0].type = 'ap';
    canvas.render();
    assert.equal(dom.get('wiring-source-icon'), icon);
    assert.match(icon.src, /assets\/icons\/devices\/access-point\.svg$/);
    assert.equal(dom.get('wiring-source-ip').hidden, true);
    assert.equal(dom.get('wiring-source-ip').textContent, '');
    assert.equal(appState.linkSourceId, 1);
    appState.devices[0].type = 'unknown-type';
    canvas.render();
    assert.match(icon.src, /assets\/icons\/devices\/other\.svg$/);
});

test('固定ONはAを保持してB/Cへ連続作成し、空白クリックも接続元を解除しない', async () => {
    await start();
    await clickDevice(1);
    await fixSource();
    const fixedCheckbox = dom.get('wiring-source-fixed');
    fixedCheckbox.focus();
    const waitingFirst = instruction();
    await clickDevice(2);
    await flush();
    assert.equal(appState.linkSourceId, 1);
    assert.equal(appState.linkSourceConnected, true);
    assert.equal(dom.get('wiring-source-fixed').checked, true);
    assert.equal(sourceElement(1).classList.contains('link-source'), true);
    assert.equal(dom.get('wiring-source-fixed'), fixedCheckbox);
    assert.equal(document.activeElement, fixedCheckbox);
    assert.notEqual(instruction(), waitingFirst);
    const waitingNext = instruction();
    await dom.get('canvas').dispatch('click', { clientX: 900, clientY: 700 });
    assert.equal(appState.linkSourceId, 1);
    assert.equal(instruction(), waitingNext);
    await clickDevice(3);
    await flush();
    assert.deepEqual(appState.links.map(link => [link.from_id, link.to_id]), [[1, 2], [1, 3]]);
    assert.equal(appState.linkSourceId, 1);
    assert.equal(instruction(), waitingNext);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests.map(request => request.links.map(({ operation, link }) =>
        [operation, link.from_id, link.to_id])), [[['create', 1, 2]], [['create', 1, 3]]]);
    assert.equal(appState.views[0].resource_revision, 1);
    requests.forEach(assertClientOnly);
    assertClientOnly(toolbar.getCurrentData());
});

test('固定中の同一・逆方向重複・別ビュー/未配置先では作成せず接続元を保持する', async () => {
    appState.links = [normalizeLink({ id: 9, from_id: 2, to_id: 1, resource_revision: 1 })];
    appState.nextLinkId = 10;
    resetConnectionBaseline(appState);
    canvas.render();
    await start();
    canvas.handleLinkModeClick(appState.devices[3]);
    assert.equal(appState.linkSourceId, null, '別ビューの機器を接続元にはできない');
    await clickDevice(1); await fixSource(); await clickDevice(3); await flush();
    await clickDevice(1);
    await clickDevice(2);
    canvas.handleLinkModeClick(appState.devices[3]);
    canvas.handleLinkModeClick({ id: 999, name: '未配置' });
    assert.equal(appState.linkSourceId, 1);
    assert.equal(appState.linkSourceFixed, true);
    assert.equal(appState.linkSourceConnected, true);
    assert.equal(sourceElement(1).classList.contains('link-source'), true);
    assert.equal(appState.links.length, 2);
    assert.equal(requests.length, 1, '不正なクリックでは追加保存しない');
});

test('既存ペアは接続を自動追加せず、既存明細を開くかポートを指定して追加できる', async () => {
    appState.links = [normalizeLink({ id: 9, from_id: 2, to_id: 1, resource_revision: 1, label: '既設' })];
    appState.nextLinkId = 10;
    resetConnectionBaseline(appState);
    await start();
    await clickDevice(1);
    await fixSource();
    await clickDevice(2);
    const existing = dom.get('wiring-existing');
    assert.equal(existing.hidden, false);
    assert.equal(existing.open, false);
    assert.equal(dom.get('wiring-existing-message').textContent, '既存接続 1件・詳細');
    assert.equal(dom.get('wiring-target-ports').hidden, false);
    assert.equal(instruction(), '');
    assert.equal(requests.length, 0);
    existing.open = true;
    const entry = dom.get('wiring-existing-links').querySelector('button');
    assert.match(entry.textContent, /^#9\s+未指定 ↔ 未指定$/);
    await entry.dispatch('click');
    assert.equal(appState.editingLinkId, 9);
    assert.equal(dom.get('lp-label').value, '既設');
    const form = dom.get('wiring-target-form');
    await form.dispatch('submit');
    assert.equal(requests.length, 0, '両端ポートなしが重複する場合は保存しない');
    dom.get('wiring-from-port').value = 'Gi1/0/12';
    canvas.render();
    assert.equal(dom.get('wiring-from-port').value, 'Gi1/0/12');
    await form.dispatch('submit');
    await flush();
    assert.deepEqual(requests[0].links.map(row => [row.operation, row.link.from_port_name]), [['create', 'Gi1/0/12']]);
    assert.equal(appState.links.length, 2);
    assert.equal(appState.linkSourceId, 1);
    assert.equal(form.hidden, true);
    assert.equal(dom.get('lp-from-port').value, 'Gi1/0/12');
});

test('表示OFF・階層なしでも他ビューと未配置の候補を検索し、未配置への接続明細を編集・解除できる', async () => {
    appState.views[0].show_connections = 0;
    appState.buildings = [];
    appState.floors = [];
    appState.devices.push(normalizeDevice({ id: 5, name: '未配置SW', type: 'switch', resource_revision: 1 }));
    resource.resetResourceBaseline(appState);
    canvas.render();
    await start();
    await clickDevice(1);
    const search = dom.get('wiring-target-query');
    const select = dom.get('wiring-target-device');
    const searchFor = async text => {
        search.value = text;
        await search.dispatch('input');
    };
    assert.equal(dom.get('wiring-target-search').hidden, false);
    assert.equal(panel().querySelector('label[for="wiring-target-query"]').textContent, '他ビュー・未配置の機器を検索');
    await searchFor('別ビュー');
    assert.match(select.options[1].textContent, /他ビュー：未分類 \/ 別ビュー/);
    assert.equal(select.options[1].value, '4');
    await searchFor('未配置SW');
    assert.match(select.options[1].textContent, /全ビュー未配置.*設置：未分類/);
    select.value = '5';
    await select.dispatch('change');
    assert.equal(requests.length, 0);
    await dom.get('wiring-target-choose').dispatch('click');
    assert.equal(requests.length, 0);
    assert.equal(document.activeElement, dom.get('wiring-target-add'));
    assert.equal(dom.get('wiring-target-ports').hidden, true);
    assert.equal(dom.get('wiring-existing').hidden, true);
    assert.equal(instruction(), '');
    await dom.get('wiring-target-form').dispatch('submit');
    await flush();
    assert.deepEqual(appState.links.map(row => [row.from_id, row.to_id]), [[1, 5]]);
    assert.equal(appState.currentSvg.querySelector('.link-group'), null);
    assert.match(dom.get('lp-to-device').textContent, /未配置SW/);
    assert.equal(dom.get('lp-to-port').value, '');
    assert.equal(dom.get('lp-route-section').hidden, true);
    dom.get('lp-to-port').value = 'LAN5';
    dom.get('lp-label').value = '遠隔接続';
    await dom.get('lp-apply-btn').dispatch('click');
    await flush();
    assert.equal(requests[1].links[0].link.label, '遠隔接続');
    assert.equal(requests[1].links[0].link.to_port_name, 'LAN5');

    const previousConfirm = globalThis.confirm;
    let warning;
    globalThis.confirm = message => { warning = message; return true; };
    try {
        await dom.get('lp-delete-btn').dispatch('click');
        await flush();
        assert.match(warning, /すべてのビューとポート台帳.*ポート自体は削除されません/);
        assert.equal(requests[2].links[0].operation, 'delete');
        assert.equal(appState.links.length, 0);
        assert.equal(appState.devicePorts[0].name, 'LAN5');
    } finally {
        globalThis.confirm = previousConfirm;
    }
});

test('Delete キーは選択中の機器を現在ビューから外し、機器や共通接続は残す', async () => {
    appState.placements.push({ id: 31, device_id: 1, view_id: 20, x: 100, y: 100 });
    appState.links = [normalizeLink({ id: 9, from_id: 1, to_id: 2, resource_revision: 1 })];
    resource.resetResourceBaseline(appState);
    assert.equal(await property.openPanel(appState.devices[0]), true);
    appState.selectedPlacementIds = new Set([11, 12]);

    const pressDelete = () => dom.events.dispatch('keydown', { key: 'Delete', target: document.body });
    const previousConfirm = globalThis.confirm;
    const prompts = [];
    globalThis.confirm = message => { prompts.push(message); return prompts.length > 1; };
    try {
        await pressDelete();
        assert.equal(requests.length, 0);
        assert.ok(appState.placements.some(row => row.id === 11));
        await pressDelete();
        await flush();
    } finally {
        globalThis.confirm = previousConfirm;
    }
    assert.match(prompts[1], /^2台をこのビューから外しますか/);
    assert.deepEqual(appState.placements.map(row => row.id).sort((a, b) => a - b), [13, 14, 31]);
    assert.deepEqual(requests.map(batch => batch.views.map(view => view.id)), [[10]]);
    assert.deepEqual(requests[0].devices, []);
    assert.deepEqual(appState.links.map(row => row.id), [9]);
});

test('集約パネルは個別 ID の明細を表示し、まとめて削除せずペアの経路を保持する', async () => {
    appState.linkSystems = [{ id: 3, name: '管理系', color_key: 'teal' }];
    appState.devicePorts = [{ id: 41, device_id: 1, name: 'Gi1', vlan: 'access 40', resource_revision: 1 },
        { id: 42, device_id: 2, name: 'LAN2', resource_revision: 1 }];
    appState.links = [
        normalizeLink({ id: 9, from_id: 2, to_id: 1, from_port_id: 42, resource_revision: 1, label: '既設' }),
        normalizeLink({ id: 10, from_id: 1, to_id: 2, resource_revision: 1, label: '増設',
            system_id: 3, memo: '確認済み', from_port_id: 41 })
    ];
    const points = [{ x: 200, y: 100 }, { x: 400, y: 100 }];
    appState.viewLinkRoutes = [{ view_id: 10, device_a_id: 1, device_b_id: 2, manual_route: points }];
    resource.resetResourceBaseline(appState);
    canvas.render();
    await appState.currentSvg.querySelector('.topology-link-hit').dispatch('click');
    assert.equal(appState.editingLinkGroupKey, '10:1:2');
    assert.equal(appState.editingLinkId, null);
    assert.equal(dom.get('lp-detail-actions').hidden, true);
    assert.equal(dom.get('lp-route-edit-btn').disabled, false);
    assert.equal(dom.get('lp-route-auto-btn').hidden, false);
    routes.startLinkRouteEdit();
    assert.equal(dom.get('canvas-context-toolbar').hidden, false);
    await dom.events.dispatch('keydown', { key: 'Delete', target: document.body });
    assert.equal(appState.links.length, 2);
    const buttons = dom.get('lp-group-connections').querySelectorAll('button');
    assert.match(buttons[0].textContent, /^#9\s+未指定 ↔ LAN2$/);
    assert.match(buttons[1].textContent, /^#10\s+Gi1 ↔ 未指定$/);
    await buttons[1].dispatch('click');
    assert.equal(appState.editingLinkId, 10);
    assert.equal(appState.editingLinkGroupKey, '10:1:2');
    assert.equal(dom.get('lp-from-port').value, 'Gi1');
    assert.equal(dom.get('lp-label').value, '増設');
    for (const side of ['from', 'to']) {
        const editor = dom.get(`lp-${side}-vlan-editor`);
        assert.equal(editor.hidden, false);
        assert.equal(editor.querySelector('label').textContent.trim(), 'VLAN設定');
        assert.equal(dom.get(`lp-${side}-vlan-summary`).hidden, true);
    }
    assert.equal(dom.get('lp-from-vlan-input').value, 'access 40');
    assert.equal(dom.get('lp-from-vlan-input').disabled, false);
    assert.equal(dom.get('lp-to-vlan-input').value, '');
    assert.equal(dom.get('lp-to-vlan-input').disabled, true);
    assert.equal(dom.get('lp-memo').value, '確認済み');
    assert.equal(dom.get('canvas-context-toolbar').hidden, false, '同じペアの明細を開いても経路調整を終了しない');
    await dom.events.dispatch('click', { target: dom.get('lp-group-back') });
    assert.equal(appState.editingLinkId, null);
    await dom.get('lp-group-connections').querySelectorAll('button')[0].dispatch('click');
    assert.equal(dom.get('lp-from-vlan-input').value, '');
    assert.equal(dom.get('lp-from-vlan-input').disabled, false);
    assert.equal(dom.get('lp-to-vlan-input').disabled, true);
    await dom.events.dispatch('click', { target: dom.get('lp-group-back') });
    await dom.get('lp-group-connections').querySelectorAll('button')[1].dispatch('click');
    const previousConfirm = globalThis.confirm;
    globalThis.confirm = () => true;
    try { await dom.get('lp-delete-btn').dispatch('click'); } finally { globalThis.confirm = previousConfirm; }
    await flush();
    assert.deepEqual(appState.links.map(row => row.id), [9]);
    assert.deepEqual(appState.viewLinkRoutes[0].manual_route, points);
    assert.deepEqual(requests[0].links, [{ operation: 'delete', id: 10, expected_revision: 1 }]);
    property.closeLinkPanel();
    assert.equal(appState.editingLinkGroupKey, null);
});

test('ラック集約から実機器の明細を開いて編集・削除でき、経路は変更できない', async () => {
    routes.initLinkRouteEditor();
    appState.views[0].view_type = 'floor';
    appState.views.push(normalizeView({ id: 30, name: '東棟収容ラック', view_type: 'rack', resource_revision: 1 }));
    appState.floorRackPlacements = [{ floor_view_id: 10, rack_view_id: 30, x: 50, y: 100 }];
    appState.rackSettings = [{ view_id: 30, total_u: 6, location: '' }];
    appState.rackMounts = [1, 2].map(id => ({
        view_id: 30, device_id: id, face: 'front', start_u: id, height_u: 1, width_slot: 'full', depth: 'full'
    }));
    appState.placements = appState.placements.filter(row => ![1, 2].includes(row.device_id));
    appState.devices.push(normalizeDevice({ id: 5, name: 'フロアSW', type: 'switch', resource_revision: 1 }));
    appState.placements.push({ id: 15, device_id: 5, view_id: 10, x: 850, y: 100 });
    appState.devicePorts = [
        { id: 41, device_id: 1, name: 'Gi1', resource_revision: 1 },
        { id: 42, device_id: 2, name: 'LAN2', resource_revision: 1 },
        { id: 43, device_id: 3, name: 'Gi3', resource_revision: 1 }
    ];
    appState.links = [
        normalizeLink({ id: 9, from_id: 3, to_id: 1, from_port_id: 43, to_port_id: 41, resource_revision: 1 }),
        normalizeLink({ id: 10, from_id: 2, to_id: 3, from_port_id: 42, label: 'ラックAP', resource_revision: 1 }),
        normalizeLink({ id: 11, from_id: 3, to_id: 5, resource_revision: 1 })
    ];
    const points = [{ x: 200, y: 100 }, { x: 600, y: 100 }];
    appState.viewLinkRoutes = [{ view_id: 10, device_a_id: 1, device_b_id: 3, manual_route: points }];
    resource.resetResourceBaseline(appState);
    canvas.render();
    const selectGroup = key => appState.currentSvg.querySelector(`[data-display-key="${key}"]`)
        .querySelector('.topology-link-hit').dispatch('click');
    const assertRackRouteLocked = async () => {
        assert.equal(dom.get('lp-route-reason').hidden, false);
        assert.match(dom.get('lp-route-reason').textContent, /ラックを端点に含む.*経路を変更できません/);
        assert.equal(dom.get('lp-route-edit-btn').disabled, true);
        assert.equal(dom.get('lp-route-auto-btn').disabled, true);
        assert.equal(dom.get('lp-route-auto-btn').hidden, true);
        const previousConfirm = window.confirm;
        window.confirm = () => assert.fail('自動経路に戻す確認を開かない');
        try {
            await dom.get('lp-route-edit-btn').dispatch('click');
            await dom.get('lp-route-auto-btn').dispatch('click');
        } finally {
            window.confirm = previousConfirm;
        }
        assert.equal(dom.get('canvas-context-toolbar').hidden, true);
        assert.deepEqual(appState.viewLinkRoutes[0].manual_route, points);
        assert.equal(requests.length, 0);
    };

    await selectGroup('10:-30:3');
    assert.equal(appState.editingLinkGroupKey, '10:-30:3');
    assert.equal(appState.editingLinkId, null);
    assert.equal(dom.get('lp-group-endpoints').textContent, '東棟収容ラック ↔ 予備SW');
    assert.equal(dom.get('lp-detail-actions').hidden, true);
    await assertRackRouteLocked();
    const choices = () => dom.get('lp-group-connections').querySelectorAll('button');
    assert.deepEqual(choices().map(button => button.textContent), [
        '#9  元SW（Gi1） ↔ 予備SW（Gi3）', '#10  先AP（LAN2） ↔ 予備SW（未指定）'
    ]);
    await choices()[0].dispatch('click');
    assert.equal(dom.get('lp-detail-id').textContent, '接続 #9');
    assert.equal(dom.get('lp-to-device').textContent, '元SW');
    assert.equal(dom.get('lp-to-port').value, 'Gi1');
    await dom.events.dispatch('click', { target: dom.get('lp-group-back') });
    await choices()[1].dispatch('click');
    assert.equal(appState.editingLinkId, 10);
    assert.equal(dom.get('lp-detail-id').textContent, '接続 #10');
    assert.equal(dom.get('lp-group-endpoints').hidden, false);
    assert.equal(dom.get('lp-from-device').textContent, '先AP');
    assert.equal(dom.get('lp-from-port').value, 'LAN2');
    await assertRackRouteLocked();

    dom.get('lp-label').value = '更新したラックAP';
    await dom.get('lp-apply-btn').dispatch('click');
    await flush();
    assert.deepEqual(requests[0].links.map(({ operation, id }) => [operation, id]), [['update', 10]]);
    assert.equal(requests[0].links[0].link.label, '更新したラックAP');
    const previousConfirm = globalThis.confirm;
    globalThis.confirm = message => { assert.match(message, /接続 #10 を削除/); return true; };
    try { await dom.get('lp-delete-btn').dispatch('click'); } finally { globalThis.confirm = previousConfirm; }
    await flush();
    assert.deepEqual(requests[1].links, [{ operation: 'delete', id: 10, expected_revision: 2 }]);
    assert.deepEqual(appState.links.map(({ id, from_id, to_id }) => [id, from_id, to_id]), [[9, 3, 1], [11, 3, 5]]);
    assert.equal(dom.get('lp-detail-id').textContent, '接続 #9');
    assert.equal(dom.get('lp-group-back').hidden, true);

    await selectGroup('10:3:5');
    assert.equal(appState.editingLinkId, 11);
    assert.equal(dom.get('lp-group-endpoints').hidden, true);
    assert.equal(dom.get('lp-route-reason').hidden, true);
    assert.equal(dom.get('lp-route-edit-btn').disabled, false);

    await selectGroup('10:-30:3');
    appState.views.find(view => view.id === 30).name = '西棟収容ラック';
    eventBus.emit('resource:reloaded', { kind: 'views', id: 30 });
    assert.equal(dom.get('lp-group-endpoints').textContent, '西棟収容ラック ↔ 予備SW');

    window.APP_CONFIG.user.isAdmin = false;
    toolbar.applyRoleBasedUi();
    eventBus.emit('link-route:selection-changed');
    assert.equal(dom.get('lp-route-reason').hidden, true);
    window.APP_CONFIG.user.isAdmin = true;
    toolbar.applyRoleBasedUi();
    eventBus.emit('link-route:selection-changed');
    assert.equal(dom.get('lp-route-reason').hidden, false);

    appState.rackMounts = appState.rackMounts.filter(row => row.device_id !== 1);
    eventBus.emit('resource:reloaded', { kind: 'views', id: 30 });
    assert.equal(dom.get('link-panel').hidden, false);
    assert.equal(appState.editingLinkId, 9);
    assert.equal(appState.editingLinkGroupKey, null);
    assert.equal(dom.get('lp-group-endpoints').hidden, true);
    assert.equal(dom.get('lp-route-reason').hidden, true);

    appState.rackMounts.push({ view_id: 30, device_id: 1, face: 'front', start_u: 1, height_u: 1, width_slot: 'full', depth: 'full' });
    eventBus.emit('resource:reloaded', { kind: 'views', id: 30 });
    assert.equal(appState.editingLinkGroupKey, '10:-30:3');
    assert.equal(dom.get('lp-group-endpoints').hidden, false);
    assert.equal(dom.get('lp-route-reason').hidden, false);

    appState.links.push(normalizeLink({ id: 12, from_id: 2, to_id: 3, resource_revision: 1 }));
    eventBus.emit('resource:reloaded', { kind: 'views', id: 30 });
    await dom.events.dispatch('click', { target: dom.get('lp-group-back') });
    assert.equal(appState.editingLinkId, null);
    assert.equal(appState.editingLinkGroupKey, '10:-30:3');
    appState.rackMounts = appState.rackMounts.filter(row => ![1, 2].includes(row.device_id));
    eventBus.emit('resource:reloaded', { kind: 'views', id: 30 });
    assert.equal(dom.get('link-panel').hidden, true);
    assert.equal(appState.editingLinkGroupKey, null);
    appState.links = appState.links.filter(row => row.id !== 12);
    appState.rackMounts.push({ view_id: 30, device_id: 1, face: 'front', start_u: 1, height_u: 1, width_slot: 'full', depth: 'full' });
    await property.openLinkPanel(appState.links.find(row => row.id === 9));

    appState.rackMounts = appState.rackMounts.filter(row => row.device_id !== 1);
    appState.placements.push({ id: 16, view_id: 10, device_id: 1, x: 50, y: 100 });
    eventBus.emit('resources:saved', { views: [] });
    canvas.render();
    assert.equal(appState.editingLinkGroupKey, '10:1:3');
    assert.equal(dom.get('lp-detail-id').textContent, '接続 #9');
    assert.equal(dom.get('lp-route-reason').hidden, true);
    assert.equal(dom.get('lp-route-auto-btn').hidden, false);
    assert.deepEqual(appState.viewLinkRoutes[0].manual_route, points);
});

test('選び直しは固定と作成済み状態も解除し、次の機器を新しい接続元にする', async () => {
    await start(); await clickDevice(1); await fixSource(); await clickDevice(2); await flush();
    await dom.get('wiring-reselect-source').dispatch('click');
    assert.equal(appState.linkMode, true);
    assert.equal(appState.linkSourceId, null);
    assert.equal(appState.linkSourceFixed, false);
    assert.equal(appState.linkSourceConnected, false);
    assert.equal(dom.get('wiring-source-fixed').checked, false);
    assert.equal(sourceElement(1).classList.contains('link-source'), false);
    await clickDevice(3);
    assert.equal(appState.linkSourceId, 3);
    assert.equal(appState.links.length, 1);
    assert.equal(requests.length, 1);
});

test('補助一覧ボタンは既存一覧の接続タブを直接開く', async () => {
    await start(); await clickDevice(1);
    await dom.get('wiring-open-list').dispatch('click');
    assert.equal(dom.get('workspace-nav-panel').hidden, false);
    assert.equal(dom.get('workspace-nav-tab-links').getAttribute('aria-selected'), 'true');
    assert.equal(dom.get('workspace-nav-links').hidden, false);
    assert.equal(dom.get('workspace-nav-devices').hidden, true);
});

test('×・Escape・固定checkboxにフォーカス中のEscapeは全状態を終了して接続ボタンへ戻す', async () => {
    for (const exit of ['close', 'escape', 'checkbox']) {
        await start(); await clickDevice(1); await fixSource(); await clickDevice(2); await flush();
        if (exit === 'close') {
            assert.equal(dom.get('wiring-close-btn').getAttribute('aria-label'), '接続モードを終了');
            await dom.get('wiring-close-btn').dispatch('click');
        } else {
            const target = exit === 'checkbox' ? dom.get('wiring-source-fixed') : document.body;
            target.focus();
            await dom.events.dispatch('keydown', { key: 'Escape', target });
        }
        assertEnded();
        assert.equal(document.activeElement, dom.get('linkBtn'));
        // 次の終了操作では別の未接続先を使えるようにする。
        appState.links = []; resource.resetResourceBaseline(appState); canvas.render();
    }
});

test('配置・メモ・図面・経路・選択モードとビュー切替・再読込で固定状態を持ち越さない', async () => {
    const exits = [
        ['配置', () => placement.enterPlacementMode(), () => assert.equal(placement.isPlacementModeActive(), true)],
        ['メモ', () => notes.toggleCanvasNoteMode(), () => assert.equal(appState.noteMode, true)],
        ['図面', () => floorPlan.toggleFloorPlanAdjustMode(), () => assert.equal(appState.floorPlanAdjustMode, true)],
        ['経路', () => routes.startLinkRouteEdit(), () => assert.equal(dom.get('canvas-context-toolbar').hidden, false)],
        ['選択', () => dom.get('palette-view-btn').dispatch('click'), () => {}],
        ['ビュー', () => manager.switchView(20), () => assert.equal(appState.currentViewId, 20)],
        ['再読込', () => eventBus.emit('resources:reloaded'), () => {}]
    ];
    for (const [name, exit, assertDestination] of exits) {
        placement.exitPlacementMode(); notes.finishCanvasNotes(); routes.finishLinkRouteEdit();
        appState.floorPlanAdjustMode = false; appState.currentViewId = 10;
        appState.views[0].view_type = name === '図面' ? 'floor' : 'topology';
        appState.links = [normalizeLink({ id: 9, from_id: 2, to_id: 3, resource_revision: 1 })];
        appState.viewLinkRoutes = [{ view_id: 10, device_a_id: 2, device_b_id: 3,
            manual_route: [{ x: 300, y: 100 }, { x: 600, y: 100 }] }];
        appState.floorPlans = [{ id: 1, view_id: 10, is_visible: true, x: 0, y: 0, image_width: 800, image_height: 600, scale: 1, opacity: 0.5, image_url: '/floor.png' }];
        resource.resetResourceBaseline(appState); canvas.render();
        await start(); await clickDevice(1); await fixSource();
        // 全cleanupの確認用に、直前の連続作成状態も立てる。
        await clickDevice(2); await flush();
        if (name === '経路') appState.editingLinkId = 9;
        await exit();
        assertEnded(); assertDestination();
        await flush();
    }
});

test('viewer・Ping・認証失効・ビュー未選択では接続を作成せず、ビュー競合とは独立して保存する', async () => {
    window.APP_CONFIG.user.isAdmin = false;
    toolbar.applyRoleBasedUi();
    assert.equal(dom.get('linkBtn').hidden, true);
    await start();
    canvas.handleLinkModeClick(appState.devices[0]);
    assertEnded();
    window.APP_CONFIG.user.isAdmin = true; toolbar.applyRoleBasedUi();
    await start(); await clickDevice(1); await fixSource();
    for (const reason of ['ping', 'auth', 'view']) {
        appState.isPinging = reason === 'ping'; appState.authExpired = reason === 'auth';
        appState.currentViewId = reason === 'view' ? null : 10;
        canvas.handleLinkModeClick(appState.devices[1]);
        assert.equal(appState.links.length, 0, `${reason}中は接続を作成しない`);
        assert.equal(appState.linkSourceId, 1);
    }
    appState.currentViewId = 10; appState.authExpired = false; appState.isPinging = false;
    window.APP_CONFIG.user.isAdmin = false;
    canvas.handleLinkModeClick(appState.devices[1]);
    assert.equal(appState.links.length, 0);
    assert.equal(requests.length, 0);
    window.APP_CONFIG.user.isAdmin = true;
    appState.resourceConflicts.views.set(10, { message: 'ビュー競合' });
    canvas.handleLinkModeClick(appState.devices[1]);
    await flush();
    assert.deepEqual(appState.links.map(row => [row.from_id, row.to_id]), [[1, 2]]);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].links[0].operation, 'create');
});

test('機器の採番応答待ちの連続作成は接続元を保持し、採番後に接続をまとめて保存する', async () => {
    appState.devices.push(normalizeDevice({ id: 5, name: '新規SW', type: 'switch', ip: '192.0.2.5' }));
    appState.placements.push({ id: 15, view_id: 10, device_id: 5, x: 50, y: 100 });
    appState.nextPlacementId = 16;
    responseMaps = { devices: { 5: 105 } };
    canvas.render();
    await start(); await clickDevice(5); await fixSource();
    holdNext = true;
    await clickDevice(2);
    await setImmediate();
    assert.ok(releaseResponse, '保存応答が待機している');
    try {
        await clickDevice(3);
        assert.equal(requests.length, 1, '保存中は2本目の通信を開始しない');
        assert.equal(appState.linkSourceId, 5);
        assert.equal(appState.links.length, 2);
    } finally { releaseResponse(); }
    await flush();
    assert.equal(requests.length, 2);
    assert.equal(requests[0].devices[0].operation, 'create');
    assert.equal(requests[1].links.every(row => row.operation === 'create'), true);
    assert.deepEqual(requests[1].links.map(({ link }) => [link.from_id, link.to_id]), [[105, 2], [105, 3]]);
    assert.deepEqual(appState.links.map(link => [link.from_id, link.to_id]), [[105, 2], [105, 3]]);
    assert.equal(appState.linkSourceId, 105);
    assert.equal(appState.linkSourceFixed, true);
    assert.equal(appState.linkSourceConnected, true);
    assert.equal(sourceElement(105).classList.contains('link-source'), true);
    assert.match(panel().textContent, /新規SW/);
    requests.forEach(assertClientOnly);
});

test('接続元を選択したままPingが完了すると固定checkboxを再操作できる', async () => {
    await start(); await clickDevice(1);
    const fixed = dom.get('wiring-source-fixed');
    holdNext = true;
    const ping = toolbar.doPing([appState.devices[0]]);
    try {
        await setImmediate();
        assert.equal(appState.isPinging, true);
        assert.equal(fixed.disabled, true);
    } finally { releaseResponse?.(); }
    await ping;
    assert.equal(appState.isPinging, false);
    assert.equal(dom.get('wiring-source-fixed'), fixed);
    assert.equal(fixed.disabled, false);
    await fixSource();
    assert.equal(appState.linkSourceFixed, true);
    assert.equal(appState.linkSourceId, 1);
});

test('図面の確定済み変更は接続への切替と管理画面close後も保持される', async () => {
    appState.views[0].view_type = 'floor';
    appState.floorPlans = [{ id: 1, view_id: 10, is_visible: true, x: 0, y: 0,
        revision: 1, image_width: 800, image_height: 600, scale: 1, opacity: 0.5, image_url: '/floor.png' }];
    resource.resetResourceBaseline(appState);
    try {
        floorPlan.openFloorPlanManager();
        floorPlan.toggleFloorPlanAdjustMode();
        const image = appState.floorPlanLayer.querySelector('.floor-plan-image');
        assert.ok(image);
        await image.dispatch('keydown', { key: 'ArrowRight', shiftKey: true });
        await dom.events.dispatch('keyup', { key: 'ArrowRight', target: image });
        await flush();
        assert.equal(appState.floorPlans[0].x, 10);
        assert.equal(requests.length, 1);
        assert.equal(requests[0].x, 10);
        assert.equal(requests[0].expected_revision, 1);
        await start();
        await setImmediate();
        assert.equal(appState.floorPlanAdjustMode, false);
        assert.equal(appState.linkMode, true);
        assert.equal(dom.get('floor-plan-manager-overlay').hidden, true);
        assert.equal(getTopModalContainer(), null);
        assert.equal(document.activeElement, dom.get('linkBtn'));
        floorPlan.openFloorPlanManager();
        floorPlan.closeFloorPlanManager();
        assert.equal(appState.floorPlans[0].x, 10);
        assert.equal(getTopModalContainer(), null);
    } finally {
        floorPlan.finishFloorPlanAdjustMode('replace');
        floorPlan.closeFloorPlanManager();
    }
});

test('図面調整の明示的な完了とEscはmodalを再表示せず通常Canvasへ戻る', () => {
    appState.views[0].view_type = 'floor';
    appState.floorPlans = [{ id: 1, view_id: 10, is_visible: true, x: 0, y: 0,
        image_width: 800, image_height: 600, scale: 1, opacity: 0.5, image_url: '/floor.png' }];
    try {
        for (const reason of ['finish', 'escape']) {
            floorPlan.openFloorPlanManager();
            floorPlan.toggleFloorPlanAdjustMode();
            contextToolbar.finishCanvasContextToolbar(reason);
            assert.equal(appState.floorPlanAdjustMode, false);
            assert.equal(dom.get('floor-plan-manager-overlay').hidden, true);
            assert.equal(getTopModalContainer(), null);
            assert.equal(document.activeElement, dom.get('floor-plan-manage-btn'));
        }
    } finally { floorPlan.closeFloorPlanManager(); }
});

test('接続だけの409は固定接続元と作成済みの入力を保持し、保留中の接続を再送しない', async () => {
    appState.links = [normalizeLink({ id: 9, from_id: 2, to_id: 3, resource_revision: 1 })];
    resetConnectionBaseline(appState);
    appState.links[0].label = '未保存の編集';
    await start(); await clickDevice(1); await fixSource();
    connectionConflict = true;
    await clickDevice(2);
    await flush();
    assert.equal(requests.length, 1);
    assert.equal(queue.hasResourceConflict('links', 9), true);
    assert.equal(queue.hasResourceConflict('views', 10), false);
    assert.deepEqual(requests[0].links.map(row => [row.operation, row.expected_revision]), [['update', 1], ['create', undefined]]);
    assert.deepEqual(appState.links.map(link => [link.from_id, link.to_id]), [[2, 3], [1, 2]]);
    assert.equal(appState.links[0].label, '未保存の編集');
    assert.equal(appState.linkSourceId, 1);
    assert.equal(appState.linkSourceFixed, true);
    assert.equal(appState.linkSourceConnected, true);
    assert.equal(panel().hidden, false);
    assert.equal(sourceElement(1).classList.contains('link-source'), true);
    await flush();
    assert.equal(requests.length, 1);
    assertClientOnly(requests[0]);
});

const heldLink = (id, from, to, view = 10) => ({
    legacy_link_id: id, view_id: view, device_a_id: Math.min(from, to), device_b_id: Math.max(from, to),
    reason: 'port_collision', payload: {
        from_id: from, to_id: to, from_port: '旧A', to_port: '旧B', system_id: 9, vlan: '100', label: '旧ラベル', memo: '旧備考'
    }
});
function loadHeldLinks(...rows) {
    serverLegacyRows = structuredClone(rows);
    appState.legacyLinkConflicts = rows;
    canvas.render();
}
async function startHeldLink(id) {
    await dom.get('palette-nav-btn').dispatch('click');
    await dom.get('workspace-nav-legacy').querySelector(`[data-nav-focus="legacy-create-${id}"]`).dispatch('click');
}
const submitTarget = () => dom.get('wiring-target-form').dispatch('submit');
const badge = () => dom.get('palette-nav-legacy-badge');

test('旧記録から両端を選択し、接続と旧記録の保存応答を順に待って対象1件だけを消す', async () => {
    loadHeldLinks(heldLink(19, 2, 1), heldLink(20, 2, 1), heldLink(21, 2, 1, 20));
    await startHeldLink(19);
    assert.equal(dom.get('workspace-nav-panel').hidden, true);
    assert.equal(dom.get('wiring-source-name').textContent, '先AP');
    assert.equal(dom.get('wiring-target-name').textContent, '元SW');
    assert.equal(sourceElement(2).classList.contains('link-source'), true);
    assert.equal(sourceElement(1).classList.contains('link-target'), true);
    assert.equal(dom.get('wiring-target-ports').hidden, false);
    assert.equal(document.activeElement, dom.get('wiring-from-port'));
    assert.match(dom.get('wiring-legacy-ports').textContent, /旧A → 旧B/);
    assert.equal(dom.get('wiring-from-port').value, '');
    assert.equal(dom.get('wiring-to-port').value, '');
    dom.get('wiring-from-port').value = '選び直したポート';
    assert.deepEqual(requests, []);
    assert.deepEqual(legacyCalls, []);

    holdNext = true;
    const remove = resolveLegacyWrite;
    let releaseDelete;
    resolveLegacyWrite = payload => new Promise(resolve => { releaseDelete = () => resolve(remove(payload)); });
    const creating = submitTarget();
    await setImmediate();
    const [{ operation, link }] = requests[0].links;
    assert.equal(operation, 'create');
    assert.deepEqual([link.from_id, link.to_id, link.from_port_name], [2, 1, '選び直したポート']);
    assert.deepEqual([link.to_port_id, link.system_id, link.label, link.memo], [null, null, '', '']);
    assert.equal(Object.hasOwn(link, 'vlan'), false);
    assert.equal(badge().textContent, '要確認 2');
    assert.deepEqual(legacyCalls, []);
    releaseResponse();
    await setImmediate();

    assert.deepEqual(appState.links.map(row => row.id), [1001]);
    assert.deepEqual(legacyCalls, [['load', 2], ['delete', { legacy_link_id: 19, view_id: 10, expected_revision: 2 }]]);
    assert.equal(badge().textContent, '要確認 2', '接続だけ保存されても減らさない');
    releaseDelete();
    await creating;
    assert.equal(badge().textContent, '要確認 1');
    assert.deepEqual(appState.legacyLinkConflicts.map(row => row.legacy_link_id), [20, 21]);
    assert.deepEqual(serverLegacyRows.map(row => row.legacy_link_id), [20, 21]);
    assert.equal(appState.links[0].id, 1001);
    assertEnded();
});

test('端点が未配置でも既存検索で再選択・登録でき、Escで取り消した時点では記録を残す', async () => {
    appState.devices.push(normalizeDevice({ id: 5, name: '全ビュー未配置SW', resource_revision: 1 }));
    resource.resetResourceBaseline(appState);
    loadHeldLinks(heldLink(19, 5, 4));
    await startHeldLink(19);
    assert.equal(dom.get('wiring-source-name').textContent, '全ビュー未配置SW');
    assert.equal(dom.get('wiring-target-name').textContent, '別ビューの機器');
    await dom.get('wiring-target-cancel').dispatch('click');
    const query = dom.get('wiring-target-query');
    assert.equal(document.activeElement, query);
    query.value = '別ビュー';
    await query.dispatch('input');
    const select = dom.get('wiring-target-device');
    assert.equal(select.options[1].value, '4');
    select.value = '4';
    await select.dispatch('change');
    await dom.get('wiring-target-choose').dispatch('click');
    assert.equal(dom.get('wiring-target-name').textContent, '別ビューの機器');
    assert.equal(document.activeElement, dom.get('wiring-from-port'));
    await dom.events.dispatch('keydown', { key: 'Escape', target: document.activeElement });
    assertEnded();
    assert.equal(document.activeElement, dom.get('palette-nav-btn'));
    assert.equal(badge().textContent, '要確認 1');
    assert.deepEqual(requests, []);
    assert.deepEqual(legacyCalls, []);

    await startHeldLink(19);
    await submitTarget();
    assert.deepEqual(appState.links.map(link => [link.id, link.from_id, link.to_id]), [[1001, 5, 4]]);
    assert.deepEqual(legacyCalls, [['load', 2], ['delete', { legacy_link_id: 19, view_id: 10, expected_revision: 2 }]]);
    assert.equal(badge().hidden, true);
});

test('既存接続との重複とサーバーで拒否された接続登録では旧記録を削除しない', async () => {
    appState.links = [normalizeLink({ id: 9, from_id: 2, to_id: 1, resource_revision: 1 })];
    appState.nextLinkId = 10;
    resource.resetResourceBaseline(appState);
    loadHeldLinks(heldLink(19, 1, 2));
    await startHeldLink(19);
    await submitTarget();
    assert.equal(dom.get('wiring-target-form').hidden, false);
    assert.match(dom.get('toast').textContent, /接続が既にあります/);
    assert.deepEqual(requests, []);

    saveRejection = '指定されたポートは別の接続で使用されています';
    dom.get('wiring-from-port').value = '使用中のポート';
    await submitTarget();
    assert.equal(requests.length, 1);
    assert.match(dom.get('toast').textContent, /使用されています/);
    assert.deepEqual(legacyCalls, []);
    assert.equal(badge().textContent, '要確認 1');
    assert.deepEqual(serverLegacyRows.map(row => row.legacy_link_id), [19]);
    assert.equal(appState.links.find(row => row.id === 9).resource_revision, 1);
    assert.deepEqual(appState.links.map(row => row.id), [9], 'サーバー拒否後は仮接続を残さない');
    assert.equal(appState.appStatus.dirty, false);
    assert.equal(queue.hasPendingChanges(), false);
    assert.equal(dom.get('link-panel').hidden, true);

    saveRejection = null;
    await startHeldLink(19);
    dom.get('wiring-from-port').value = '空いているポート';
    await submitTarget();
    assert.equal(requests.length, 2);
    assert.deepEqual(appState.links.map(row => row.id), [9, 1001]);
    assert.equal(appState.editingLinkId, 1001);
    assert.equal(dom.get('link-panel').hidden, false);
    assert.equal(badge().hidden, true);
    assert.deepEqual(serverLegacyRows, []);
});

test('旧記録の削除だけが409なら登録済み接続と件数を維持し、旧記録だけ再操作できる', async () => {
    loadHeldLinks(heldLink(19, 1, 2));
    const remove = resolveLegacyWrite;
    resolveLegacyWrite = () => new Response(JSON.stringify({ ok: false, error: '更新が競合しました' }), { status: 409 });
    await startHeldLink(19);
    await submitTarget();
    assert.equal(requests.length, 1);
    assert.deepEqual(appState.links.map(row => row.id), [1001]);
    assert.deepEqual(serverLegacyRows.map(row => row.legacy_link_id), [19]);
    assert.equal(badge().textContent, '要確認 1');
    assert.match(dom.get('toast').textContent, /接続は登録済みです.*旧記録を削除する/);

    resolveLegacyWrite = remove;
    await dom.get('palette-nav-btn').dispatch('click');
    const previousConfirm = window.confirm;
    window.confirm = () => true;
    try {
        await dom.get('workspace-nav-legacy').querySelector('[data-nav-focus="legacy-19"]').dispatch('click');
    } finally {
        window.confirm = previousConfirm;
    }
    assert.deepEqual(serverLegacyRows, []);
    assert.deepEqual(appState.links.map(row => row.id), [1001]);
    assert.equal(requests.length, 1);
    assert.equal(badge().hidden, true);
});
