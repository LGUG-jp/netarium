import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installWorkspaceDom } from './helpers/workspace-dom.mjs';
import { appState, normalizeDevice, normalizeView } from '../public/js/core/state.js';
import { eventBus } from '../public/js/core/event-bus.js';
import { applyPlacementHistory, beginCanvasHistoryDrag, getPlacementHistoryAvailability, recordPlacementMove } from '../public/js/core/placement-history.js';

const resetHistory = () => eventBus.emit('resources:reloaded');
const point = x => ({ x, y: 5 });
function movePlacement(row, x) {
    const before = { x: row.x, y: row.y };
    row.x = x;
    recordPlacementMove(row.view_id, [{ placementId: row.id, before, after: { x, y: row.y } }]);
}

test('履歴はビューごとに直近20件を保持し、Redoは新しい移動をしたビューだけ破棄する', t => {
    t.after(resetHistory);
    const first = { id: 1, view_id: 10, ...point(0) };
    const second = { id: 2, view_id: 20, ...point(0) };
    appState.placements = [first, second];
    for (let x = 1; x <= 23; x++) movePlacement(first, x);
    movePlacement(second, 10);
    assert.equal(applyPlacementHistory(20, 'undo'), true);
    for (let x = 22; x >= 3; x--) {
        assert.equal(applyPlacementHistory(10, 'undo'), true);
        assert.equal(first.x, x);
    }
    assert.equal(applyPlacementHistory(10, 'undo'), false);
    movePlacement(first, 15);
    assert.equal(applyPlacementHistory(10, 'redo'), false);
    assert.equal(applyPlacementHistory(20, 'redo'), true);
    assert.deepEqual([first.x, second.x], [15, 10]);
});

test('採番後も機器とラックを元に戻せ、対象ビューの再読込と全再読込で履歴が失効する', t => {
    t.after(resetHistory);
    const device = { id: -2, view_id: -1, ...point(0) };
    const rack = { floor_view_id: -1, rack_view_id: -3, ...point(0) };
    const other = { id: 4, view_id: 40, ...point(0) };
    Object.assign(appState, { placements: [device, other], floorRackPlacements: [rack] });
    movePlacement(device, 10);
    movePlacement(other, 20);
    rack.x = 5;
    recordPlacementMove(-1, [{ rackViewId: -3, before: point(0), after: point(5) }]);
    assert.equal(applyPlacementHistory(-1, 'undo'), true);
    Object.assign(device, { id: 12, view_id: 11 });
    Object.assign(rack, { floor_view_id: 11, rack_view_id: 13 });
    eventBus.emit('resources:ids-remapped', { views: { '-1': 11, '-3': 13 }, placements: { '-2': 12 } });
    assert.equal(applyPlacementHistory(-1, 'undo'), false);
    assert.equal(applyPlacementHistory(11, 'undo'), true);
    assert.deepEqual([device.x, rack.x], [0, 0]);
    assert.equal(applyPlacementHistory(11, 'redo'), true);
    assert.equal(applyPlacementHistory(11, 'redo'), true);
    assert.deepEqual([device.x, rack.x], [10, 5]);
    eventBus.emit('resource:reloaded', { kind: 'devices', id: 11 });
    assert.equal(getPlacementHistoryAvailability(11).undo, true);
    eventBus.emit('resource:reloaded', { kind: 'views', id: 11 });
    assert.equal(applyPlacementHistory(11, 'undo'), false);
    assert.equal(getPlacementHistoryAvailability(40).undo, true);
    resetHistory();
    assert.equal(applyPlacementHistory(40, 'undo'), false);
});

test('採番先が別の未保存ビューの旧IDと重なっても、両ビューの履歴を保持する', t => {
    t.after(resetHistory);
    const sent = { id: 2, view_id: 20, ...point(0) };
    const unsent = { id: 3, view_id: 21, ...point(5) };
    appState.placements = [sent, unsent];
    movePlacement(sent, 10);
    movePlacement(unsent, 25);
    Object.assign(sent, { id: 3, view_id: 21 });
    Object.assign(unsent, { id: 4, view_id: 22 });
    eventBus.emit('resources:ids-remapped', { views: { 20: 21, 21: 22 }, placements: { 2: 3, 3: 4 } });
    assert.equal(applyPlacementHistory(21, 'undo'), true);
    assert.deepEqual([sent.x, unsent.x], [0, 25]);
    assert.equal(applyPlacementHistory(22, 'undo'), true);
    assert.deepEqual([sent.x, unsent.x], [0, 5]);
});

test('座標が変わった、または削除されたグループ移動を部分適用せず、無関係な操作は残す', t => {
    t.after(resetHistory);
    const [first, second, other] = [1, 2, 3].map(id => ({ id, view_id: 10, ...point(0) }));
    appState.placements = [first, second, other];
    movePlacement(other, 5);
    for (const row of [first, second]) row.x = 10;
    recordPlacementMove(10, [first, second].map(row => ({ placementId: row.id, before: point(0), after: point(10) })));
    first.x = 42;
    assert.equal(applyPlacementHistory(10, 'undo'), true);
    assert.deepEqual([first.x, second.x, other.x], [42, 10, 0]);
    first.x = 10;
    assert.equal(applyPlacementHistory(10, 'undo'), false, '一度失効した履歴は座標が戻っても復活しない');
    assert.equal(applyPlacementHistory(10, 'redo'), true);
    movePlacement(second, 30);
    assert.equal(applyPlacementHistory(10, 'undo'), true);
    appState.placements = [first, other];
    assert.equal(applyPlacementHistory(10, 'redo'), false);
});

test('対象を過去と同じ座標に数値編集しても、同じ対象の古い履歴は復活しない', t => {
    t.after(resetHistory);
    const first = { id: 1, view_id: 10, ...point(0) };
    const other = { id: 2, view_id: 10, ...point(0) };
    appState.placements = [first, other];
    movePlacement(first, 10);
    movePlacement(other, 5);
    movePlacement(first, 20);
    first.x = 10;
    assert.equal(applyPlacementHistory(10, 'undo'), true);
    assert.deepEqual([first.x, other.x], [10, 0]);
    assert.equal(applyPlacementHistory(10, 'undo'), false);
});

test('ドラッグを二重に終了しても、重なった別ドラッグの終了までは履歴を適用しない', t => {
    t.after(resetHistory);
    const row = { id: 1, view_id: 10, ...point(0) };
    appState.placements = [row];
    movePlacement(row, 10);
    const endFirst = beginCanvasHistoryDrag(), endSecond = beginCanvasHistoryDrag();
    try {
        endFirst();
        endFirst();
        assert.equal(applyPlacementHistory(10, 'undo'), false);
        endSecond();
        assert.equal(applyPlacementHistory(10, 'undo'), true);
        assert.equal(row.x, 0);
    } finally {
        endFirst();
        endSecond();
    }
});

test('ヘッダーとキー操作は、表示中ビュー・保存状態・編集状態に従う', async t => {
    const globals = new Map(['window', 'document', 'Element', 'HTMLElement', 'fetch', 'confirm']
        .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const { add, get, events } = installWorkspaceDom({ templates: ['templates/components/toolbar.php'],
        phpSetup: "require 'version.php'; $username = '検証'; $userRole = 'admin'; $csrfToken = 'test-only-token';" });
    document.readyState = 'loading';
    window.navigator = { platform: 'Win32' };
    const media = { matches: false, addEventListener(_type, listener) { this.change = listener; } };
    window.matchMedia = () => media;
    window.location = { href: 'https://example.test/index.php' };
    const setNarrow = value => { media.matches = value; media.change(); };
    const { registerStaticListeners } = await import('../public/js/main.js');
    const { onKeyDown } = await import('../public/js/canvas/selection.js');
    const { applyRoleBasedUi } = await import('../public/js/ui/toolbar.js');
    const { clearPendingSave, flushSaveQueue, reloadConflictedResource, updateSaveButtonState } = await import('../public/js/core/save-queue.js');
    const { resetResourceBaseline } = await import('../public/js/core/resource-save.js');
    const { registerModalOpen, registerModalClose } = await import('../public/js/core/modal-focus.js');
    const { syncPanelIfOpen } = await import('../public/js/ui/property-panel.js');
    const views = ['topology', 'floor', 'rack'].map((view_type, index) =>
        normalizeView({ id: index + 1, name: `試験ビュー ${index + 1}`, resource_revision: 1, view_type }));
    const devices = [1, 2].map(id => normalizeDevice({ id, name: `試験機器 ${id}`, type: 'pc', resource_revision: 1 }));
    const placements = devices.map(({ id }) => ({ id, device_id: id, view_id: id, ...point(0) }));
    const floorRack = { floor_view_id: 2, rack_view_id: 3, ...point(80) };
    resetHistory();
    Object.assign(appState, { views, devices, placements, floorRackPlacements: [floorRack], currentViewId: 1, editingDeviceId: 1,
        appStatus: { state: 'saved', dirty: false }, rackSettings: [{ view_id: 3, total_u: 42, location: '' }] });
    for (const x of [10, 20]) movePlacement(placements[0], x);
    for (const x of [30, 50]) movePlacement(placements[1], x);
    resetResourceBaseline(appState);
    registerStaticListeners();
    const off = eventBus.on('canvas:render-complete', syncPanelIfOpen);
    t.after(() => {
        off();
        clearPendingSave();
        resetHistory();
        for (const [key, descriptor] of globals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
        }
    });

    const panel = add('div', 'panel');
    const xInput = add('input', 'p-coord-x', panel);
    const yInput = add('input', 'p-coord-y', panel);
    xInput.defaultValue = xInput.value = '20'; yInput.defaultValue = yInput.value = '5';
    appState.deviceLayer = add('div', 'device-layer');
    appState.currentSvg = add('svg', 'link-layer');
    appState.floorPlanLayer = add('div', 'floor-plan-layer');
    const controls = get('placement-history'), inline = get('placement-history-inline');
    const trigger = get('placement-history-trigger'), popup = get('placement-history-menu');
    const [undo, redo] = inline.querySelectorAll('button');
    const [menuUndo, menuRedo] = popup.querySelectorAll('button');
    assert.equal(undo.disabled, false);
    assert.equal(redo.disabled, true);
    assert.match(undo.title, /Ctrl\+Z/);
    assert.match(redo.getAttribute('aria-label'), /Ctrl\+Y.*Ctrl\+Shift\+Z/);
    assert.equal(controls.previousElementSibling, get('loadBtn'));
    assert.equal(controls.nextElementSibling, get('saveBtn'));

    const requestBodies = [];
    let revision = 1;
    let respond = (payload, url) => saved(payload, url);
    const saved = payload => {
        revision++;
        return Response.json({ ok: true, revision, id_maps: {}, devices: [],
            views: payload.views.map(operation => ({ ...operation.view, resource_revision: revision })),
            placements: payload.views.flatMap(operation => operation.placements), view_link_routes: [], canvas_notes: [],
            floor_rack_placements: payload.views.flatMap(operation => operation.floor_rack_placements ?? []),
            affected_view_ids: payload.views.map(operation => operation.id), deleted_device_ids: [], deleted_view_ids: [] });
    };
    globalThis.fetch = async (url, options) => {
        const payload = options.body ? JSON.parse(options.body) : null;
        if (payload) requestBodies.push(payload);
        return respond(payload, url);
    };
    const makeKey = (key, extra = {}) => ({ key, target: document.activeElement,
        preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...extra });
    const shortcut = async (key, extra = {}) => {
        const event = makeKey(key, { ctrlKey: true, ...extra });
        await onKeyDown(event);
        return event.defaultPrevented === true;
    };
    const keydown = (key, options = {}) => events.dispatch('keydown', makeKey(key, options));
    const x = () => appState.placements.find(row => Number(row.view_id) === Number(appState.currentViewId)).x;
    const switchTo = id => { appState.currentViewId = id; eventBus.emit('canvas:render-complete'); };

    setNarrow(true);
    assert.equal(inline.hidden, true);
    assert.equal(trigger.parentElement.hidden, false);
    trigger.focus();
    await trigger.dispatch('click', { detail: 0 }); // Enter / Space のネイティブ click
    assert.equal(document.activeElement, menuUndo);
    assert.equal(panel.hidden, false);
    await keydown('Escape');
    assert.equal(popup.hidden, true);
    assert.equal(document.activeElement, trigger);
    await keydown('ArrowDown');
    const tab = await keydown('Tab');
    assert.equal(tab.defaultPrevented, undefined);
    assert.equal(popup.hidden, true);
    assert.equal(document.activeElement, trigger);
    await trigger.dispatch('click', { detail: 1 });
    await events.dispatch('click', { target: panel });
    assert.equal(popup.hidden, true);
    await trigger.dispatch('click', { detail: 1 });
    setNarrow(false);
    assert.equal(inline.hidden, false);
    assert.equal(popup.hidden, true);
    assert.equal(document.activeElement, undo);
    setNarrow(true);
    await keydown('ArrowDown');

    let finishSave;
    respond = payload => new Promise(resolve => { finishSave = () => resolve(saved(payload)); });
    await menuUndo.click();
    assert.equal(x(), 10);
    assert.equal(xInput.value, '10');
    assert.equal(document.activeElement, trigger);
    assert.equal(trigger.getAttribute('aria-disabled'), 'true');
    assert.equal(await shortcut('z', { shiftKey: true }), false);
    finishSave();
    await flushSaveQueue({ silent: true });
    respond = saved;
    assert.equal(trigger.getAttribute('aria-disabled'), 'false');
    assert.equal(requestBodies[0].views[0].placements[0].x, 10);

    await keydown('ArrowDown');
    assert.equal(document.activeElement, menuUndo);
    await keydown('ArrowDown');
    assert.equal(document.activeElement, menuRedo);
    await keydown('ArrowUp');
    assert.equal(document.activeElement, menuUndo);
    await keydown('Escape');
    setNarrow(false);
    assert.equal(await shortcut('y'), true);
    await flushSaveQueue({ silent: true });
    assert.equal(x(), 20);
    assert.equal(requestBodies[1].views[0].expected_revision, 2);

    for (const extra of [{ altKey: true }, { isComposing: true }, { target: xInput },
        { target: Object.assign(add('div', 'editable'), { isContentEditable: true }) }]) {
        assert.equal(await shortcut('z', { target: undo, ...extra }), false);
    }
    const modal = add('div', 'history-test-modal');
    registerModalOpen('history-test-modal', modal, modal);
    assert.equal(undo.disabled, true);
    assert.equal(await shortcut('z'), false);
    modal.hidden = true;
    registerModalClose('history-test-modal');
    assert.equal(undo.disabled, false);
    const context = add('div', 'canvas-context-toolbar');
    for (const [state, event] of [['isRangeSelecting', 'canvas:range-selection-changed'], ['isPinging', 'ping:busy-changed'],
        ['linkMode', 'wiring:render'], ['noteMode', 'wiring:render'], ['floorPlanAdjustMode', 'canvas-context:changed'],
        ['authExpired', 'auth:expired']]) {
        appState[state] = true;
        eventBus.emit(event);
        assert.equal(undo.disabled, true, state);
        assert.equal(await shortcut('z'), false, state);
        appState[state] = false;
        updateSaveButtonState();
        assert.equal(undo.disabled, false, state);
    }
    context.dataset.activeContext = 'link-route';
    eventBus.emit('canvas-context:changed');
    assert.equal(undo.disabled, true);
    delete context.dataset.activeContext;
    eventBus.emit('canvas-context:changed');
    window.APP_CONFIG.user.isAdmin = false;
    applyRoleBasedUi();
    assert.equal(controls.hidden, true);
    assert.equal(await shortcut('z'), false);
    window.APP_CONFIG.user.isAdmin = true;
    applyRoleBasedUi();
    assert.equal(undo.disabled, false, '権限反映で履歴のないボタンを誤って有効化しない');
    assert.equal(redo.disabled, true);
    switchTo(3);
    assert.equal(undo.disabled, true);
    assert.equal(await shortcut('z'), false);
    switchTo(1);

    undo.focus();
    xInput.value = '123';
    window.navigator.platform = 'MacIntel';
    assert.equal(await shortcut('z'), false, 'Mac では Ctrl+Z を奪わない');
    assert.equal(await shortcut('z', { ctrlKey: false, metaKey: true }), true);
    await flushSaveQueue({ silent: true });
    assert.equal(xInput.value, '123', '未適用の数値入力は残す');
    assert.equal(await shortcut('y', { ctrlKey: false, metaKey: true }), false, 'Cmd+Y を奪わない');
    assert.equal(await shortcut('z', { ctrlKey: false, metaKey: true, shiftKey: true }), true);
    await flushSaveQueue({ silent: true });
    assert.equal(x(), 20);
    window.navigator.platform = 'Win32';

    switchTo(2);
    assert.equal(await shortcut('z'), true);
    await flushSaveQueue({ silent: true });
    assert.equal(x(), 30);
    for (const [kind, id] of [['devices', 2], ['views', 3]]) {
        await t.test(`${kind} の依存先が409なら履歴を無効化し、対象再読込で復帰する`, async () => {
            assert.equal(undo.disabled, false);
            assert.equal(redo.disabled, false);
            const edited = appState[kind].find(row => row.id === id);
            const remote = { ...edited, resource_revision: ++revision };
            edited.name += '（競合する編集）';
            respond = payload => {
                assert.deepEqual(payload[kind].map(row => row.id), [id]);
                return Response.json({ ok: false, error: '依存先が別画面で変更されました',
                    details: { conflicts: [{ resource: kind, id }] } }, { status: 409 });
            };
            assert.equal(await flushSaveQueue({ silent: true }), false);
            assert.equal(undo.disabled, true);
            assert.equal(redo.disabled, true);
            setNarrow(true);
            assert.equal(trigger.getAttribute('aria-disabled'), 'true');
            await trigger.dispatch('click', { detail: 1 });
            assert.equal(popup.hidden, true);
            const failedAttempt = requestBodies.length;
            assert.equal(await shortcut('z'), false);
            assert.equal(await shortcut('y'), false);
            assert.equal(requestBodies.length, failedAttempt);
            assert.equal(x(), 30);
            switchTo(1);
            assert.equal(undo.disabled, false, '依存しないビューは引き続き操作できる');
            switchTo(2);
            globalThis.confirm = () => true;
            respond = () => Response.json({ ok: true, revision, placements: appState.placements,
                floor_rack_placements: appState.floorRackPlacements, rack_settings: appState.rackSettings,
                devices: appState.devices.map(row => kind === 'devices' && row.id === id ? remote : row),
                views: appState.views.map(row => kind === 'views' && row.id === id ? remote : row) });
            assert.equal(await reloadConflictedResource(kind, id), true);
            assert.equal(undo.disabled, false);
            assert.equal(redo.disabled, false);
            assert.equal(trigger.getAttribute('aria-disabled'), 'false');
            setNarrow(false);
        });
    }
    respond = saved;
    assert.equal(await shortcut('y'), true);
    await flushSaveQueue({ silent: true });
    assert.equal(x(), 50, '依存先を再読込しても表示中ビューの履歴を利用できる');
    switchTo(1);

    respond = () => Response.json({ ok: false, error: '別画面で変更されました',
        details: { conflicts: [{ resource: 'views', id: 1 }] } }, { status: 409 });
    assert.equal(await shortcut('z'), true);
    assert.equal(await flushSaveQueue({ silent: true }), false);
    assert.equal(undo.disabled, true);
    assert.equal(redo.disabled, true);
    const failedAttempt = requestBodies.length;
    assert.equal(await shortcut('z', { shiftKey: true }), false);
    assert.equal(requestBodies.length, failedAttempt);
    assert.equal(x(), 10, '競合後は再読込までローカルの確定値を保持する');
    switchTo(2);
    assert.equal(undo.disabled, false, '別のビューの版競合では無効化しない');
    switchTo(1);
    globalThis.confirm = () => true;
    // リビジョンだけ進んだ場合も、対象を再読込した履歴は破棄する。
    revision++;
    respond = () => Response.json({ ok: true, revision, views: [{ ...views[0], resource_revision: revision }],
        devices, placements: [{ id: 1, device_id: 1, view_id: 1, ...point(10) }], links: [] });
    assert.equal(await reloadConflictedResource('views', 1), true);
    assert.equal(x(), 10);
    assert.equal(undo.disabled, true);
    assert.equal(redo.disabled, true);

    switchTo(2);
    respond = (_payload, url) => {
        const response = Response.json({ ok: false, error_code: 'NETARIUM_MAINTENANCE_REJECTED', contract_version: 1,
            request_execution: 'not_started', operation_id: 'maintenance-history' }, { status: 404 });
        Object.defineProperty(response, 'url', { value: new URL(url, window.location.href).href });
        return response;
    };
    assert.equal(await shortcut('z'), true);
    assert.equal(await flushSaveQueue({ silent: true }), false);
    assert.equal(appState.appStatus.state, 'maintenance');
    assert.equal(await shortcut('y'), false);
    assert.equal(redo.disabled, true);
    respond = saved;
    assert.equal(await flushSaveQueue(), true, '「保存」で保守待機中の変更を送信すると履歴が再び利用できる');
    assert.equal(redo.disabled, false);

    t.mock.method(console, 'error', () => {});
    respond = () => { throw new Error('通信切断'); };
    assert.equal(await shortcut('z', { shiftKey: true }), true);
    assert.equal(await flushSaveQueue({ silent: true }), false);
    assert.equal(appState.appStatus.state, 'unconfirmed');
    assert.equal(undo.disabled, true);
    assert.equal(await shortcut('z'), false);
});
