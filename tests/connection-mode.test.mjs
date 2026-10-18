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
    'templates/components/toast.php', 'templates/modals/floor_plan_manager.php'
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
const { eventBus } = await import('../public/js/core/event-bus.js');
const { syncLinkModeButton } = await import('../public/js/ui/toolbar-controls.js');
eventBus.on('toolbar:sync-link-mode', syncLinkModeButton);
eventBus.on('canvas:render-floor-plan', floorPlan.renderFloorPlan);
const resource = await import('../public/js/core/resource-save.js');
const queue = await import('../public/js/core/save-queue.js');
const contextToolbar = await import('../public/js/ui/canvas-context-toolbar.js');
const { getTopModalContainer } = await import('../public/js/core/modal-focus.js');

document.readyState = 'loading';
const { registerStaticListeners } = await import('../public/js/main.js');
registerStaticListeners();
dom.events.addEventListener('keydown', onKeyDown);
dom.get('canvas').addEventListener('click', canvas.onCanvasClick);
navigation.initWorkspaceNavigation();
wiring.initWiringControls();
notes.initCanvasNotes();

let requests;
let responseStatus;
let holdNext;
let releaseResponse;
let responseMaps;

globalThis.fetch = async (url, options) => {
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
    if (responseStatus === 409) return new Response(JSON.stringify({ ok: false, error: '別の管理者が更新しました',
        details: { conflicts: [{ kind: 'views', id: payload.views[0].id, name: '対象ビュー' }] }
    }), { status: 409 });
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
        links: payload.views.flatMap(row => (row.links || []).map(item => ({
            ...item, id: mapped('links', item.id), view_id: mapped('views', item.view_id),
            from_id: mapped('devices', item.from_id), to_id: mapped('devices', item.to_id)
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
    appState.floorPlanAdjustMode = false;
    window.APP_CONFIG.user.isAdmin = true;
    appState.views = [normalizeView({ id: 10, name: '対象ビュー', resource_revision: 1 }), normalizeView({ id: 20, name: '別ビュー', resource_revision: 1 })];
    appState.devices = ['元SW', '先AP', '予備SW', '別ビューの機器'].map((name, index) => normalizeDevice({
        id: index + 1, name, ip: `192.0.2.${index + 1}`, type: 'switch', resource_revision: 1
    }));
    appState.placements = [1, 2, 3, 4].map(id => ({ id: id + 10, device_id: id, view_id: id === 4 ? 20 : 10, x: id * 200, y: 100 }));
    appState.links = []; appState.linkSystems = []; appState.floorPlans = []; appState.canvasNotes = []; appState.deviceImages = [];
    appState.currentViewId = 10; appState.dataRevision = 1; appState.nextLinkId = 1;
    appState.linkMode = false; appState.linkSourceId = null; appState.linkSourceFixed = false; appState.linkSourceConnected = false;
    appState.noteMode = false; appState.selectedCanvasNoteId = null; appState.editingDeviceId = null; appState.editingLinkId = null;
    appState.selectedPlacementIds = new Set(); appState.viewStates = new Map(); appState.floorPlanAutoFittedViews = new Set();
    appState.resourceConflicts = { devices: new Map(), views: new Map() };
    appState.authExpired = false; appState.isPinging = false; appState.isSaving = false;
    appState.isRangeSelecting = false; appState.suppressNextClick = false;
    appState.appStatus = { dirty: false, state: 'saved', lastSavedAt: null, lastError: null };
    appState.viewState = { scale: 1, panX: 0, panY: 0 };
    appState.canvas = dom.get('canvas'); appState.world = dom.get('world');
    appState.currentSvg = dom.get('link-layer'); appState.deviceLayer = dom.get('device-layer');
    appState.floorPlanLayer = dom.get('floor-plan-layer'); appState.noteLayer = dom.get('canvas-note-layer');
    requests = []; responseStatus = 200; holdNext = false; releaseResponse = null; responseMaps = {};
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
    assert.equal(panel().querySelector('select'), null);
    const help = panel().querySelector('a');
    assert.match(help.getAttribute('href'), /help\.html#connections$/);
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
    assert.deepEqual(appState.links.map(link => [link.view_id, link.from_id, link.to_id]), [[10, 1, 2]]);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].views[0].expected_revision, 1);
    assert.deepEqual(requests[0].views[0].links.map(link => [link.from_id, link.to_id]), [[1, 2]]);
    assertClientOnly(requests[0]);
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
    assert.deepEqual(panel().querySelectorAll('button, a, input').map(node => node.id),
        ['wiring-open-list', 'wiring-help', 'wiring-close-btn', 'wiring-source-fixed', 'wiring-reselect-source']);
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
    assert.equal(requests[1].views[0].expected_revision, 2);
    requests.forEach(assertClientOnly);
    assertClientOnly(toolbar.getCurrentData());
});

test('固定中の同一・逆方向重複・別ビュー/未配置先では作成せず接続元を保持する', async () => {
    appState.links = [normalizeLink({ id: 9, view_id: 10, from_id: 2, to_id: 1 })];
    appState.nextLinkId = 10;
    resource.resetResourceBaseline(appState);
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
        appState.links = [normalizeLink({ id: 9, view_id: 10, from_id: 2, to_id: 3, route_mode: 'manual', manual_route: [{ x: 300, y: 100 }, { x: 600, y: 100 }] })];
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

test('viewerは開始も作成もできず、Ping・認証失効・ビュー競合中は作成を拒否する', async () => {
    window.APP_CONFIG.user.isAdmin = false;
    toolbar.applyRoleBasedUi();
    assert.equal(dom.get('linkBtn').hidden, true);
    await start();
    canvas.handleLinkModeClick(appState.devices[0]);
    assertEnded();
    window.APP_CONFIG.user.isAdmin = true; toolbar.applyRoleBasedUi();
    await start(); await clickDevice(1); await fixSource();
    for (const reason of ['ping', 'auth', 'conflict', 'view']) {
        appState.isPinging = reason === 'ping'; appState.authExpired = reason === 'auth';
        appState.resourceConflicts.views = reason === 'conflict' ? new Map([[10, { message: '競合' }]]) : new Map();
        appState.currentViewId = reason === 'view' ? null : 10;
        canvas.handleLinkModeClick(appState.devices[1]);
        assert.equal(appState.links.length, 0, `${reason}中は接続を作成しない`);
        assert.equal(appState.linkSourceId, 1);
    }
    appState.currentViewId = 10; appState.authExpired = false; appState.isPinging = false;
    appState.resourceConflicts.views.clear();
    window.APP_CONFIG.user.isAdmin = false;
    canvas.handleLinkModeClick(appState.devices[1]);
    assert.equal(appState.links.length, 0);
    assert.equal(requests.length, 0);
});

test('保存応答待ちの連続作成は採番された接続元を保持して次revisionへ直列保存する', async () => {
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
    assert.equal(requests[1].views[0].expected_revision, 2);
    assert.deepEqual(new Set(requests[1].views[0].links.map(link => `${link.from_id}:${link.to_id}`)),
        new Set(['105:2', '105:3']));
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

test('409は作成済み接続と固定接続元を保持し、競合ビューへの追加保存を止める', async () => {
    await start(); await clickDevice(1); await fixSource();
    responseStatus = 409;
    await clickDevice(2);
    await flush();
    assert.equal(requests.length, 1);
    assert.equal(queue.hasResourceConflict('views', 10), true);
    assert.equal(appState.links.length, 1);
    assert.equal(appState.linkSourceId, 1);
    assert.equal(appState.linkSourceFixed, true);
    assert.equal(appState.linkSourceConnected, true);
    assert.equal(panel().hidden, false);
    assert.equal(dom.get('wiring-source-fixed').disabled, true);
    assert.equal(sourceElement(1).classList.contains('link-source'), true);
    await clickDevice(3);
    assert.equal(appState.links.length, 1);
    assert.equal(appState.linkSourceId, 1);
    assert.equal(requests.length, 1);
    assertClientOnly(requests[0]);
});
