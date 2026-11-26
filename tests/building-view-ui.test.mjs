import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { installWorkspaceDom } from './helpers/workspace-dom.mjs';
import { DEFAULT_DEVICE_HEIGHT, DEFAULT_DEVICE_WIDTH, DEVICE_TYPES } from '../public/js/core/constants.js';

test('建物ビューの選択・明示遷移・自動保存・取消・競合時入力保持', async t => {
    const keys = ['window', 'document', 'Element', 'HTMLElement', 'fetch', 'localStorage', 'Image', 'ResizeObserver'];
    const globals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const dom = installWorkspaceDom();
    const preferences = new Map();
    globalThis.localStorage = window.localStorage = {
        getItem: key => preferences.get(key) ?? null, setItem: (key, value) => preferences.set(key, value)
    };
    const requestedImages = new Map();
    globalThis.Image = class {
        complete = false;
        naturalWidth = 0;
        set src(url) { requestedImages.set(url, this); }
    };
    globalThis.ResizeObserver = class {
        constructor(callback) { this.callback = callback; }
        observe(target) { target.clientWidth = 1000; target.clientHeight = 650; this.callback(); }
        disconnect() {}
    };
    const toolbar = dom.add('header', 'toolbar');
    const selector = dom.add('div', 'view-switcher', toolbar);
    const otherAction = dom.add('button', 'other-action', toolbar);
    dom.add('input', 'view-search-input', selector);
    const authBanner = dom.add('div', 'status-auth-expired-banner');
    authBanner.hidden = true;
    const relogin = dom.add('a', 'building-test-relogin', authBanner);
    relogin.href = 'login.php';
    const canvas = dom.add('main', 'canvas');
    const world = dom.add('div', 'world', canvas);
    const { appState, normalizeView, normalizeDevice, normalizePlacement } = await import('../public/js/core/state.js');
    const oldState = { ...appState };
    const { resetResourceBaseline } = await import('../public/js/core/resource-save.js');
    const { handleAuthExpired } = await import('../public/js/core/api-client.js');
    const { clearPendingSave } = await import('../public/js/core/save-queue.js');
    const { eventBus } = await import('../public/js/core/event-bus.js');
    const ui = await import('../public/js/ui/building-view.js');
    const identity = { scale: 1, offset_x: 0, offset_y: 0, rotation: 0 };
    Object.assign(appState, {
        buildings: [{ id: 1, name: '本館', building_view_enabled: 1 }, { id: 2, name: '平屋', building_view_enabled: 1 },
            { id: 3, name: '無効棟', building_view_enabled: 0 }],
        floors: [{ id: 10, building_id: 1, name: 'B1', sort_order: -1, representative_view_id: 5, ...identity },
            { id: 11, building_id: 1, name: '1F', sort_order: 1, representative_view_id: null, ...identity },
            { id: 20, building_id: 2, name: '1F', sort_order: 1, ...identity }],
        views: [
            normalizeView({ id: 5, name: 'B1配置図', floor_id: 10, view_type: 'floor', resource_revision: 1 }),
            normalizeView({ id: 7, name: '別の物理配置図', floor_id: 10, view_type: 'floor', resource_revision: 1 })
        ],
        devices: ['router', 'server', 'ap', 'switch'].map((type, index) =>
            normalizeDevice({ id: index + 1, name: `機器${index + 1}`, type, floor_id: 10, resource_revision: 1 })),
        placements: [
            { id: 1, device_id: 1, view_id: 5, x: 5, y: 10 },
            { id: 2, device_id: 2, view_id: 5, x: 15, y: 20 },
            { id: 3, device_id: 3, view_id: 7, x: 25, y: 25 }
        ].map(normalizePlacement),
        links: [], canvasNotes: [], rackSettings: [], rackMounts: [], rackShelves: [], rackShelfDevices: [],
        floorRackPlacements: [], deviceImages: [],
        floorPlans: [{ view_id: 5, image_url: '/test-plan.png', image_width: 100, image_height: 60,
            x: 5, y: 10, scale: 1, rotation: 0, opacity: 1, is_visible: 1 }],
        canvas, world, dataRevision: 7, currentViewId: 5, authExpired: false, isPinging: false,
        floorPlanAdjustMode: false, isFloorPlanUpdating: false, viewManagerFormDirty: false,
        editingDeviceId: null, editingLinkId: null, resourceConflicts: { devices: new Map(), views: new Map() }
    });
    clearPendingSave(); resetResourceBaseline(appState);
    const originalPlans = structuredClone(appState.floorPlans);
    const originalPlacements = structuredClone(appState.placements);
    const requests = [], navigations = [], settings = [];
    const remoteFloors = new Map(appState.floors.map(row => [row.id, structuredClone(row)]));
    const remoteBuildings = new Map(appState.buildings.map(row => [row.id, structuredClone(row)]));
    let remoteRevision = appState.dataRevision, lostResponse = false, reads = 0, hold = null;
    let rejectSave = false;
    window.switchView = id => navigations.push(id);
    window.openViewManager = ({ floorId }) => { settings.push(floorId); };
    globalThis.fetch = async (_url, options) => {
        if (options.method === 'GET') {
            reads++;
            return new Response(JSON.stringify({ ok: true, revision: remoteRevision,
                buildings: [...remoteBuildings.values()], floors: [...remoteFloors.values()] }));
        }
        const payload = JSON.parse(options.body); requests.push(payload);
        if (hold) await hold;
        if (rejectSave) return new Response(JSON.stringify({ ok: false, error: '保存を拒否しました' }), { status: 400 });
        const row = remoteFloors.get(payload.id);
        if (remoteBuildings.get(row.building_id)?.building_view_enabled !== 1 ||
            Object.entries(payload.expected_floor).some(([key, value]) => (row[key] ?? null) !== value)) {
            return new Response(JSON.stringify({ ok: false, error: '競合' }), { status: 409 });
        }
        const floor = { ...row, scale: payload.scale, offset_x: payload.offset_x, offset_y: payload.offset_y, rotation: payload.rotation };
        remoteFloors.set(payload.id, floor); remoteRevision++;
        if (lostResponse) throw new Error('応答が切断されました');
        return new Response(JSON.stringify({ ok: true, revision: remoteRevision, floor }));
    };
    const settle = async () => { await setImmediate(); await setImmediate(); };
    const panel = () => document.querySelector('.building-view');
    const byText = text => panel().querySelectorAll('button').find(node => node.textContent === text);
    const visibleButton = text => panel().querySelectorAll('button').find(node => node.textContent === text && !node.hidden);
    const editor = () => panel().querySelector('.building-view-editor');
    const inputFor = text => editor().querySelectorAll('label').find(label => label.textContent === text).querySelector('input');
    const floor = id => panel().querySelector(`.building-floor[data-floor-id="${id}"]`);
    const floorPoints = id => floor(id).querySelector('.building-floor-face').getAttribute('points');
    const markers = () => panel().querySelectorAll('.building-device-dot');
    const assertMarkerTracksPlan = () => {
        assert.equal(markers().length, 2);
        const points = floorPoints(10).split(' ').map(point => point.split(',').map(Number));
        markers().forEach((marker, index) => {
            const placement = originalPlacements[index];
            const u = (placement.x + DEFAULT_DEVICE_WIDTH / 2 - 5) / 100;
            const v = (placement.y + DEFAULT_DEVICE_HEIGHT / 2 - 10) / 60;
            for (const [axis, attr] of ['cx', 'cy'].entries()) {
                const [a, b, , d] = points.map(point => point[axis]);
                assert.ok(Math.abs(Number(marker.getAttribute(attr)) - (a + (b - a) * u + (d - a) * v)) < 1e-8);
            }
        });
    };
    const change = async (label, value) => {
        const input = inputFor(label); input.value = value;
        await input.dispatch('input'); await input.dispatch('change'); await settle();
    };
    t.after(async () => {
        if (ui.hasBuildingViewDraft()) {
            const closing = ui.closeBuildingView(); await settle();
            await dom.get('unsaved-changes-discard')?.click(); await closing;
        } else await ui.closeBuildingView();
        clearPendingSave(); Object.assign(appState, oldState); resetResourceBaseline(appState);
        for (const [key, descriptor] of globals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
        }
    });

    canvas.scrollLeft = 25; canvas.scrollTop = 300;
    canvas.classList.add('rack-active');
    assert.equal(await ui.openBuildingView(3), false);
    assert.equal(await ui.openBuildingView(999), false);
    assert.equal(canvas.scrollTop, 300); assert.equal(canvas.scrollLeft, 25);
    assert.notEqual(otherAction.inert, true);
    assert.equal(await ui.openBuildingView(1), true);
    assert.equal(ui.getOpenBuildingId(), 1);
    assert.equal(canvas.classList.contains('building-view-active'), true);
    assert.equal(canvas.scrollTop, 0); assert.equal(canvas.scrollLeft, 0);
    assert.equal(otherAction.inert, true); assert.equal(world.inert, true); assert.notEqual(selector.inert, true);
    assert.equal(panel().querySelectorAll('.building-floor').length, 2);
    const stage = panel().querySelector('.building-view-stage');
    const upperFloor = floor(11);
    assert.deepEqual(panel().querySelector('.building-view-floors').children.map(row => row.textContent), ['1F', 'B1']);
    assert.equal(floor(10).classList.contains('selected'), true);
    assert.equal(floor(11).classList.contains('selected'), false);
    assert.match(panel().querySelector('.building-floor-label-note').textContent, /図面なし/);
    assert.equal(markers().length, 2, '設置フロアIDだけの機器や非代表ビューの配置は描かない');
    assert.deepEqual(markers().map(marker => marker.getAttribute('fill')), [DEVICE_TYPES.router.color, DEVICE_TYPES.server.color]);
    assert.equal(floor(10).querySelector('image'), null);
    const beforeImage = floorPoints(10);
    const loaded = requestedImages.get('/test-plan.png');
    loaded.complete = true; loaded.naturalWidth = 100; loaded.onload();
    const planImage = floor(10).querySelector('image');
    assert.ok(planImage);
    assert.equal(planImage.getAttribute('width'), '100');
    assert.equal(planImage.getAttribute('height'), '60');
    const matrix = planImage.getAttribute('transform').match(/^matrix\(([^)]+)\)$/)?.[1].split(' ').map(Number);
    const [pa, pb, , pd] = beforeImage.split(' ').map(point => point.split(',').map(Number));
    // 図面の投影傾きは、表示倍率や配置オフセットを除いた辺の勾配で確認する。
    const expectedSlope = Math.tan(-Math.PI / 6) * Math.sin(25 * Math.PI / 180);
    assert.ok(Math.abs((pb[1] - pa[1]) / (pb[0] - pa[0]) - expectedSlope) < 1e-8);
    assert.ok(matrix && matrix.length === 6);
    assert.ok(Math.abs(matrix[0] * 100 + matrix[4] - pb[0]) < 1e-8);
    assert.ok(Math.abs(matrix[1] * 100 + matrix[5] - pb[1]) < 1e-8);
    assert.ok(Math.abs(matrix[2] * 60 + matrix[4] - pd[0]) < 1e-8);
    assert.ok(Math.abs(matrix[3] * 60 + matrix[5] - pd[1]) < 1e-8);
    assert.ok(Math.abs(matrix[4] - pa[0]) < 1e-8);
    assert.ok(Math.abs(matrix[5] - pa[1]) < 1e-8);
    assert.equal(floorPoints(10), beforeImage, '図面を読み込んでも投影位置は変わらない');
    assertMarkerTracksPlan();
    await stage.dispatch('pointerdown', { target: upperFloor, pointerId: 1, button: 0, isPrimary: true, clientX: 100, clientY: 100 });
    await stage.dispatch('pointerup', { pointerId: 1, clientX: 100, clientY: 100 });
    await settle();
    assert.deepEqual(navigations, []);
    assert.equal(byText('1F').getAttribute('aria-pressed'), 'true');
    assert.equal(floor(11).classList.contains('selected'), true);
    assert.equal(floor(10).classList.contains('selected'), false);
    assert.match(panel().querySelector('.building-view-selection').textContent, /物理配置ビューがありません/);
    assertMarkerTracksPlan();
    await byText('フロア設定を開く').click();
    assert.deepEqual(settings, [11]); assert.equal(ui.getOpenBuildingId(), null); assert.equal(otherAction.inert, false);
    assert.equal(canvas.classList.contains('building-view-active'), false);
    assert.equal(canvas.scrollTop, 300); assert.equal(canvas.scrollLeft, 25);
    await ui.openBuildingView(1);
    await byText('平面図を開く').click();
    assert.deepEqual(navigations, [5]);

    await ui.openBuildingView(1); await byText('位置合わせモード').click();
    assert.deepEqual(editor().querySelector('.building-view-transform-fields').querySelectorAll('label').map(label => label.textContent),
        ['X移動', 'Y移動', '拡大率（%）', '回転（度）'], '表示順と入力欄のフォーカス順を揃える');
    assert.equal(inputFor('拡大率（%）').value, '100');
    assert.equal(byText('簡易自動整列').disabled, true, '別の図面がなければ自動整列しない');
    assert.equal(visibleButton('保存を再試行'), undefined);
    inputFor('拡大率（%）').value = '150'; await inputFor('拡大率（%）').dispatch('input');
    assert.equal(visibleButton('保存を再試行'), undefined, '入力中は復旧操作を出さない');
    rejectSave = true; await change('拡大率（%）', '150'); rejectSave = false;
    await visibleButton('保存を再試行').click(); await settle();
    assert.equal(remoteFloors.get(10).scale, 1.5, '拒否された変更を再試行で保存できる');
    assert.equal(visibleButton('保存を再試行'), undefined, '再試行が成功したら復旧操作を隠す');
    await change('拡大率（%）', '200');
    assert.equal(appState.floors[0].scale, 2); assert.equal(ui.hasBuildingViewDraft(), false);
    await byText('1F').click(); await settle(); await change('X移動', '33');
    await byText('B1').click(); await settle();
    assert.equal(inputFor('拡大率（%）').value, '200');
    await byText('調整開始時に戻す').click(); await settle();
    assert.equal(appState.floors[0].scale, 1);
    await change('X移動', '20');
    await byText('既定値に戻す').click(); await settle();
    assert.deepEqual(['scale', 'offset_x', 'offset_y', 'rotation'].map(key => remoteFloors.get(10)[key]), [1, 0, 0, 0]);
    assert.deepEqual(appState.floorPlans, originalPlans);

    // A階でモードを終了・再開しても、B階の前回の開始値を使わない。
    const exitAlignment = byText('位置合わせを終了');
    assert.equal(exitAlignment.getAttribute('aria-expanded'), 'true');
    assert.equal(exitAlignment.getAttribute('aria-controls'), editor().id);
    await exitAlignment.click();
    assert.equal(byText('位置合わせモード').getAttribute('aria-expanded'), 'false');
    assert.equal(editor().hidden, true);
    await byText('位置合わせモード').click();
    await byText('1F').click(); await settle(); await change('X移動', '48');
    await byText('調整開始時に戻す').click(); await settle();
    assert.equal(remoteFloors.get(11).offset_x, 33);
    await byText('B1').click(); await settle();

    const activeStage = panel().querySelector('.building-view-stage');
    const camera = activeStage.querySelector('.building-view-camera');
    const cameraButton = label => camera.querySelector(`button[aria-label="${label}"]`);
    const beforeCameraRequests = requests.length;
    await cameraButton('視点をリセット').click();
    const fittedPoints = floorPoints(10);
    await activeStage.dispatch('pointerdown', { target: cameraButton('右へ回転'), pointerId: 20, button: 0 });
    assert.equal(activeStage.hasPointerCapture(20), false, '視点ボタンのタッチ・クリックをドラッグが奪わない');
    await cameraButton('右へ回転').click();
    const rotatedByButton = floorPoints(10);
    assert.notEqual(rotatedByButton, fittedPoints);
    await cameraButton('視点をリセット').click();
    assert.equal(floorPoints(10), fittedPoints);
    await activeStage.dispatch('pointerdown', { target: activeStage, pointerId: 2, button: 0, clientX: 20, clientY: 20 });
    await activeStage.dispatch('pointermove', { pointerId: 2, clientX: 70, clientY: 45 });
    await activeStage.dispatch('pointerup', { pointerId: 2, clientX: 70, clientY: 45 });
    const rotatedPoints = floorPoints(10);
    assert.notEqual(rotatedPoints, fittedPoints);
    await activeStage.dispatch('wheel', { deltaY: -100 });
    assert.notEqual(floorPoints(10), rotatedPoints);
    await cameraButton('視点をリセット').click();
    assert.equal(floorPoints(10), fittedPoints, '回転・俯角・ズームを変えても「全体」で初期の投影へ戻る');
    const invertDrag = cameraButton('視点ドラッグを反転');
    assert.equal(invertDrag.getAttribute('aria-pressed'), 'false');
    await invertDrag.click();
    assert.equal(invertDrag.getAttribute('aria-pressed'), 'true');
    await activeStage.dispatch('pointerdown', { target: activeStage, pointerId: 21, button: 0, clientX: 80, clientY: 50 });
    await activeStage.dispatch('pointermove', { pointerId: 21, clientX: 30, clientY: 25 });
    await activeStage.dispatch('pointerup', { pointerId: 21, clientX: 30, clientY: 25 });
    assert.equal(floorPoints(10), rotatedPoints, '左右・上下とも逆方向のドラッグで同じ投影になる');
    await cameraButton('視点をリセット').click();
    await cameraButton('右へ回転').click();
    assert.equal(floorPoints(10), rotatedByButton, '反転は回転ボタンに影響しない');
    await cameraButton('視点をリセット').click();
    assert.equal(requests.length, beforeCameraRequests, '調整モードでも視点操作だけでは変換を保存しない');
    const floorTarget = floor(10);
    await activeStage.dispatch('pointerdown', { target: floorTarget, pointerId: 3, button: 0, clientX: 100, clientY: 100 });
    await activeStage.dispatch('pointermove', { pointerId: 3, clientX: 130, clientY: 110 });
    const projectedOrigin = points => points.split(' ')[0].split(',').map(Number);
    const origin = projectedOrigin(fittedPoints);
    const movedOrigin = projectedOrigin(floorPoints(10));
    assert.ok(Math.abs(movedOrigin[0] - origin[0] - 30) < 1e-8 && Math.abs(movedOrigin[1] - origin[1] - 10) < 1e-8,
        '反転をオンにしても位置合わせではドラッグ方向にフロアを移動する');
    assertMarkerTracksPlan();
    await activeStage.dispatch('pointerup', { pointerId: 3, clientX: 130, clientY: 110 });
    await settle();
    assert.notEqual(appState.floors[0].offset_x, 0);
    assert.equal(requests.length, beforeCameraRequests + 1);
    assert.deepEqual(appState.floorPlans, originalPlans);

    // 実ブラウザの順序: input → canvas pointerdown → blur による change → drag → pointerup。
    const beforeBlur = requests.length;
    const rotation = inputFor('回転（度）'); rotation.value = '22';
    await rotation.dispatch('input');
    await activeStage.dispatch('pointerdown', { target: floor(10),
        pointerId: 4, button: 0, clientX: 100, clientY: 100 });
    await rotation.dispatch('change'); await settle();
    assert.equal(requests.length, beforeBlur, 'ドラッグ開始後は数値入力だけを先行送信しない');
    const previousOffset = remoteFloors.get(10).offset_x;
    await activeStage.dispatch('pointermove', { pointerId: 4, clientX: 160, clientY: 110 });
    await activeStage.dispatch('pointerup', { pointerId: 4, clientX: 160, clientY: 110 });
    await settle();
    assert.equal(requests.length, beforeBlur + 1);
    assert.equal(remoteFloors.get(10).rotation, 22);
    assert.notEqual(remoteFloors.get(10).offset_x, previousOffset);

    // ドラッグの取消はドラッグだけを戻し、同時に確定した数値欄の変更は保存する。
    const savedOffset = remoteFloors.get(10).offset_x;
    rotation.value = '23'; await rotation.dispatch('input');
    await activeStage.dispatch('pointerdown', { target: floor(10),
        pointerId: 5, button: 0, clientX: 100, clientY: 100 });
    await rotation.dispatch('change');
    await activeStage.dispatch('pointermove', { pointerId: 5, clientX: 150, clientY: 100 });
    await activeStage.dispatch('pointercancel', { pointerId: 5 }); await settle();
    assert.equal(remoteFloors.get(10).rotation, 23);
    assert.equal(remoteFloors.get(10).offset_x, savedOffset);

    remoteFloors.set(10, { ...remoteFloors.get(10), offset_y: 77 }); remoteRevision++;
    await change('X移動', '123');
    assert.equal(ui.hasBuildingViewDraft(), true); assert.equal(inputFor('X移動').value, '123');
    for (const id of [3, 999]) assert.equal(await ui.openBuildingView(id), false);
    assert.equal(ui.getOpenBuildingId(), 1);
    assert.equal(dom.get('unsaved-changes-overlay'), null, '無効な切替先では破棄確認を始めない');
    const switching = ui.openBuildingView(2); await settle();
    assert.ok(dom.get('unsaved-changes-overlay'));
    await dom.get('unsaved-changes-cancel').click(); assert.equal(await switching, false);
    assert.equal(inputFor('X移動').value, '123');
    const staleSwitching = ui.openBuildingView(2); await settle();
    appState.buildings[1].building_view_enabled = 0;
    await dom.get('unsaved-changes-discard').click();
    assert.equal(await staleSwitching, false);
    assert.equal(ui.getOpenBuildingId(), 1, '確認中に切替先が無効になっても編集中の建物を閉じない');
    assert.equal(inputFor('X移動').value, '123');
    appState.buildings[1].building_view_enabled = 1;
    const beforeCheck = requests.length;
    await visibleButton('保存状態を確認').click(); await settle();
    assert.equal(reads, 1);
    assert.equal(requests.length, beforeCheck, '確認だけではサーバーへの書き込みを行わない');
    assert.equal(inputFor('X移動').value, '123');
    assert.equal(inputFor('Y移動').value, '77', '別タブが保存した未編集の項目は引き継ぐ');
    const editorNotice = () => panel().querySelector('.building-view-editor-notice');
    assert.equal(editorNotice().hidden, false);
    assert.match(editorNotice().textContent, /現在の保存値：/);
    await visibleButton('入力を再適用').click(); await settle();
    assert.equal(ui.hasBuildingViewDraft(), false);
    assert.equal(editorNotice().hidden, true);
    assert.equal(visibleButton('保存を再試行'), undefined);
    assert.equal(remoteFloors.get(10).offset_x, 123);
    assert.equal(remoteFloors.get(10).offset_y, 77);

    lostResponse = true; await change('X移動', '555'); lostResponse = false;
    assert.equal(remoteFloors.get(10).offset_x, 555);
    assert.ok(byText('調整開始時に戻す').disabled, '未確認のまま調整開始時へ戻さない');
    assert.ok(byText('既定値に戻す').disabled, '未確認のまま既定値へ戻さない');
    await visibleButton('保存状態を確認').click(); await settle();
    assert.equal(reads, 2);
    assert.equal(ui.hasBuildingViewDraft(), false);
    await byText('調整開始時に戻す').click(); await settle();
    assert.equal(remoteFloors.get(10).offset_x, savedOffset);
    assert.equal(remoteFloors.get(10).offset_y, 77, '取消で別タブの変更を巻き戻さない');

    let release;
    hold = new Promise(resolve => { release = resolve; });
    await change('X移動', '124');
    assert.equal(await ui.closeBuildingView(), false);
    assert.equal(ui.hasBuildingViewDraft(), true);
    release(); hold = null; await settle();
    assert.equal(ui.hasBuildingViewDraft(), false);
    const reference = { id: 12, building_id: 1, name: '2F', sort_order: 2, representative_view_id: null, ...identity };
    appState.floors.push(reference); remoteFloors.set(reference.id, { ...reference });
    appState.views.push(normalizeView({ id: 6, name: '2F配置図', floor_id: 12, view_type: 'floor', resource_revision: 1 }));
    appState.floorPlans.push({ view_id: 6, image_url: '/reference-plan.png', image_width: 303, image_height: 150,
        x: 40, y: 20, scale: 0.75, rotation: 60 });
    resetResourceBaseline(appState);
    eventBus.emit('hierarchy:changed');
    assert.equal(panel().querySelector('.building-alignment-guide').children.length, 4);
    assert.equal(panel().querySelector('#building-view-reference-floor').value, '12');
    appState.views.push(normalizeView({ id: 8, name: '別の2F配置図', floor_id: 12, view_type: 'floor', resource_revision: 1 }));
    eventBus.emit('resource:reloaded', { kind: 'views', id: 8 });
    assert.equal(panel().querySelector('.building-alignment-guide'), null, '図面なしを含む物理ビュー2件なら仮プレートに戻る');
    appState.views = appState.views.filter(row => row.id !== 8);
    eventBus.emit('resources:saved', {});
    assert.equal(panel().querySelector('.building-alignment-guide').children.length, 4);
    assert.equal(appState.floors.find(row => row.id === 12).representative_view_id, null);
    const beforeAlignment = { ...remoteFloors.get(10) };
    const beforePlanAlignment = structuredClone(appState.floorPlans);
    const beforeReference = requests.length;
    await panel().querySelector('#building-view-reference-floor').dispatch('change');
    assert.equal(requests.length, beforeReference, '基準階を選ぶだけでは保存しない');
    await byText('簡易自動整列').click(); await settle();
    const aligned = remoteFloors.get(10);
    assert.equal(requests.length, beforeReference + 1);
    assert.notEqual(aligned.scale, beforeAlignment.scale);
    assert.equal(remoteFloors.get(12).scale, 1);
    assert.deepEqual(appState.floorPlans, beforePlanAlignment);
    assertMarkerTracksPlan();
    assert.deepEqual(appState.placements, originalPlacements);
    await change('回転（度）', '74');
    assert.equal(remoteFloors.get(10).scale, aligned.scale, '回転のみ編集しても倍率の丸め表示を保存しない');
    assert.equal(remoteFloors.get(10).offset_x, aligned.offset_x, 'XYの丸め表示を保存しない');
    await byText('位置合わせを終了').click();
    assert.equal(panel().querySelector('.building-alignment-guide'), null);
    await ui.closeBuildingView(); await ui.openBuildingView(1);
    await byText('位置合わせモード').click();
    assert.equal(Number(inputFor('回転（度）').value), 74, '整列後の手動調整も再表示できる');
    await byText('簡易自動整列').click(); await settle();
    await byText('調整開始時に戻す').click(); await settle();
    assert.equal(remoteFloors.get(10).rotation, 74);

    const beforeDisable = requests.length;
    const beforeDisableFloor = structuredClone(appState.floors[0]);
    const pendingImage = requestedImages.get('/test-plan.png');
    byText('位置合わせを終了').focus();
    hold = new Promise(resolve => { release = resolve; });
    rejectSave = true;
    await change('X移動', '888');
    assert.equal(requests.length, beforeDisable + 1);
    appState.buildings[0].building_view_enabled = 0;
    eventBus.emit('resources:saved', {});
    assert.equal(panel().querySelector('.building-view-stage').hidden, true);
    assert.equal(panel().querySelector('.building-view-unavailable').hidden, false);
    assert.match(panel().querySelector('.building-view-unavailable').textContent, /使用できません/);
    assert.equal(panel().querySelector('svg').children.length, 0);
    assert.equal(await ui.openBuildingView(1), false, '表示中の同じ建物にも無効設定を適用する');
    pendingImage.complete = true; pendingImage.naturalWidth = 100; pendingImage.onload();
    assert.equal(panel().querySelector('svg').children.length, 0, '図面読み込みが完了しても無効な建物を描かない');
    release(); hold = null; await settle(); rejectSave = false;
    assert.equal(document.activeElement === byText('建物ビューを閉じる'), true, '通信中の無効化後も終了時に閉じるボタンへフォーカスを戻す');
    assert.equal(ui.hasBuildingViewDraft(), true);
    assert.equal(inputFor('X移動').value, '888');
    assert.equal(inputFor('X移動').readOnly, true);
    assert.equal(byText('位置合わせを終了').disabled, true);
    assert.equal(byText('平面図を開く').disabled, true);
    appState.buildings[0].building_view_enabled = 1;
    eventBus.emit('resources:reloaded');
    assert.equal(panel().querySelector('.building-view-unavailable').hidden, true);
    assert.equal(inputFor('X移動').value, '888', '再有効化しても未保存の入力は維持する');
    assert.equal(inputFor('X移動').readOnly, false);
    assert.ok(floor(10).querySelector('image'), '再有効化して描画を再開する');
    appState.buildings[0].building_view_enabled = 0;
    eventBus.emit('resource:reloaded', { kind: 'views', id: 5 });
    await inputFor('X移動').dispatch('change');
    const unavailableClose = ui.closeBuildingView(); await settle();
    await dom.get('unsaved-changes-save').click();
    assert.equal(await unavailableClose, false);
    assert.equal(requests.length, beforeDisable + 1, '無効化後は編集・適用のどちらからも送信しない');
    assert.deepEqual(appState.floors[0], beforeDisableFloor);
    const discardUnavailable = ui.closeBuildingView(); await settle();
    await dom.get('unsaved-changes-discard').click();
    assert.equal(await discardUnavailable, true);
    assert.equal(panel(), null);
    appState.buildings[0].building_view_enabled = 1;
    assert.equal(await ui.openBuildingView(1), true);
    assert.equal(floor(10).classList.contains('selected'), true);
    assert.equal(ui.hasBuildingViewDraft(), false);
    appState.buildings[0].building_view_enabled = 0;
    eventBus.emit('resources:reloaded');
    assert.equal(ui.getOpenBuildingId(), null, '入力がなければ再読込で無効になった建物を閉じる');
    appState.buildings[0].building_view_enabled = 1;

    assert.equal(await ui.openBuildingView(1), true);
    await byText('位置合わせモード').click();
    remoteBuildings.get(1).building_view_enabled = 0;
    await change('X移動', '321');
    assert.ok(visibleButton('保存状態を確認'));
    await visibleButton('保存状態を確認').click(); await settle();
    assert.equal(panel().querySelector('.building-view-stage').hidden, true, '別タブで無効化後の保存確認は描画を停止する');
    assert.equal(visibleButton('入力を再適用'), undefined, '無効化された建物では再適用ボタンを出さない');
    assert.equal(inputFor('X移動').value, '321', '無効化を検知しても未保存の入力は保持する');
    assert.equal(ui.hasBuildingViewDraft(), true);
    const discardRemoteDisabled = ui.closeBuildingView(); await settle();
    await dom.get('unsaved-changes-discard').click();
    assert.equal(await discardRemoteDisabled, true);
    remoteBuildings.get(1).building_view_enabled = 1;
    appState.buildings[0].building_view_enabled = 1;

    assert.equal(await ui.openBuildingView(2), true);
    assert.equal(panel().querySelectorAll('.building-floor').length, 1);
    appState.buildings = appState.buildings.filter(row => row.id !== 2);
    eventBus.emit('hierarchy:changed'); await settle();
    assert.equal(ui.getOpenBuildingId(), null);
    const originalFloors = appState.floors;
    const originalViews = appState.views;
    appState.floors = originalFloors.map(row => row.id === 10 ? { ...row, representative_view_id: null } : row);
    await ui.openBuildingView(1);
    const selectionText = () => panel().querySelector('.building-view-selection').textContent;
    assert.match(selectionText(), /代表図面が未設定です。物理配置ビューが複数あるため/);
    assert.ok(visibleButton('代表ビューを設定'));
    await byText('位置合わせモード').click();
    await change('X移動', '');
    assert.equal(editorNotice().hidden, false);
    assert.match(editorNotice().textContent, /正の数/);
    const cancelSettings = byText('代表ビューを設定').click(); await settle();
    await dom.get('unsaved-changes-cancel').click(); await cancelSettings;
    assert.equal(inputFor('X移動').value, '');
    assert.deepEqual(settings, [11]);
    const openSettings = byText('代表ビューを設定').click(); await settle();
    await dom.get('unsaved-changes-discard').click(); await openSettings;
    assert.equal(ui.getOpenBuildingId(), null);
    assert.deepEqual(settings, [11, 10]);

    window.APP_CONFIG.user.isAdmin = false;
    await ui.openBuildingView(1);
    assert.match(selectionText(), /物理配置ビューが複数あるため/);
    assert.equal(visibleButton('代表ビューを設定'), undefined);
    appState.views = originalViews.filter(row => row.id !== 7);
    eventBus.emit('resources:saved', {});
    assert.match(selectionText(), /平面図：B1配置図/);
    const autoPlan = requestedImages.get('/test-plan.png');
    autoPlan.complete = true; autoPlan.naturalWidth = 100; autoPlan.onload();
    assert.ok(floor(10).querySelector('image'), '唯一の物理ビューの図面を再表示する');
    assert.ok(visibleButton('平面図を開く'));
    assert.equal(appState.floors.find(row => row.id === 10).representative_view_id, null);
    await ui.closeBuildingView();
    window.APP_CONFIG.user.isAdmin = true;
    appState.floors = originalFloors;
    appState.views = originalViews;
    appState.floorPlans = [];
    await ui.openBuildingView(1);
    assert.match(selectionText(), /図面未登録：B1配置図/);
    assert.doesNotMatch(selectionText(), /物理配置ビューが複数/);
    await byText('フロア設定を開く').click();
    assert.deepEqual(settings, [11, 10, 10]);
    assert.deepEqual(navigations, [5], '図面なしの代表へ暗黙に遷移しない');
    await ui.openBuildingView(1);
    assert.equal(byText('反転').getAttribute('aria-pressed'), 'true', '建物ビューを開き直しても反転を維持する');
    handleAuthExpired();
    assert.equal(authBanner.hidden, false);
    assert.notEqual(authBanner.inert, true, '編集を残したまま別タブで再認証できる');
    const reloginKey = await dom.events.dispatch('keydown', { target: relogin, key: 'Enter' });
    assert.notEqual(reloginKey.stopped, true, '再ログインリンクのキーボード操作を妨げない');
    assert.ok(requests.length >= 5);
});

async function installConnectionFixture(t) {
    const keys = ['window', 'document', 'Element', 'HTMLElement', 'fetch', 'localStorage', 'Image', 'ResizeObserver'];
    const globals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const dom = installWorkspaceDom({ templates: ['templates/modals/ledger.php', 'templates/components/toast.php',
        'templates/components/property_panel.php', 'templates/components/status_bar.php'], phpSetup: '$isAdmin = true;' });
    globalThis.localStorage = { getItem: () => null, setItem() {} };
    const requestedImages = new Map();
    globalThis.Image = class { set src(url) { requestedImages.set(url, this); } };
    globalThis.ResizeObserver = class {
        constructor(callback) { this.callback = callback; }
        observe(target) { target.clientWidth = 900; target.clientHeight = 620; this.callback(); }
        disconnect() {}
    };
    const priorFocus = dom.add('button', 'building-source');
    priorFocus.focus();
    const canvas = dom.add('main', 'canvas');
    const linkPanel = dom.add('aside', 'link-panel');
    const { appState, normalizeView, normalizeDevice, normalizePlacement } = await import('../public/js/core/state.js');
    const { normalizeLink } = await import('../public/js/core/connection-data.js');
    const { eventBus } = await import('../public/js/core/event-bus.js');
    const { getTopModalContainer, requestModalClose } = await import('../public/js/core/modal-focus.js');
    const { resetResourceBaseline } = await import('../public/js/core/resource-save.js');
    const { clearPendingSave } = await import('../public/js/core/save-queue.js');
    const { openBuildingView, closeBuildingView, getOpenBuildingId, hasBuildingViewDraft } = await import('../public/js/ui/building-view.js');
    const footerZoom = dom.get('canvas-view-controls');
    const { closeLedgerDetailPane } = await import('../public/js/modals/ledger-modal.js');
    const oldState = { ...appState };
    const settle = async () => { await setImmediate(); await setImmediate(); };
    t.after(async () => {
        await dom.get('unsaved-changes-discard')?.click();
        if (getTopModalContainer() === dom.get('ledger-device-sheet-overlay')) {
            const closing = closeLedgerDetailPane(); await settle();
            await dom.get('unsaved-changes-discard')?.click(); await closing;
        }
        if (hasBuildingViewDraft()) {
            const closing = closeBuildingView(); await settle();
            await dom.get('unsaved-changes-discard')?.click(); await closing;
        } else await closeBuildingView();
        Object.assign(appState, oldState);
        clearPendingSave(); resetResourceBaseline(appState);
        for (const [key, descriptor] of globals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
        }
    });
    const identity = { scale: 1, offset_x: 0, offset_y: 0, rotation: 0 };
    const floor = (id, name, building_id, representative_view_id) =>
        ({ id, name, building_id, representative_view_id, sort_order: id, ...identity });
    const first = normalizeLink({ id: 101, from_id: 1, to_id: 3, system_id: 8, label: '幹線 A',
        memo: '合成備考', resource_revision: 1 });
    const second = normalizeLink({ id: 102, from_id: 3, to_id: 1, from_port_id: 71, system_id: 8 });
    const other = normalizeLink({ id: 103, from_id: 2, to_id: 5, label: '単独ラベル' });
    const systems = [{ id: 8, name: '業務', color_key: 'teal' }, { id: 9, name: '監視', color_key: 'teal' }];
    Object.assign(appState, {
        buildings: [{ id: 1, name: '本館', building_view_enabled: 1 }, { id: 2, name: '別館', building_view_enabled: 1 }],
        floors: [floor(10, 'B1', 1, 51), floor(11, '1F', 1, null), floor(20, '別館 1F', 2, 53)],
        views: [{ id: 51, floor_id: 10 }, { id: 52, floor_id: 11 }, { id: 53, floor_id: 20 }].map(view =>
            normalizeView({ ...view, name: `配置図 ${view.id}`, view_type: 'floor', show_connections: 0 }))
            .concat(normalizeView({ id: 61, floor_id: 11, name: 'ラック', view_type: 'rack' })),
        devices: [1, 2, 3, 4, 5, 6, 7].map(id =>
            normalizeDevice({ id, name: `機器${id}`, type: id === 4 ? 'router' : 'switch', resource_revision: 1 })),
        placements: [[1, 51, 0, 0], [2, 51, 75, 75], [5, 52, 600, 300], [6, 53, 35, 40], [7, 51, 30, 10], [7, 52, 45, 7]]
            .map(([device_id, view_id, x, y], index) => normalizePlacement({ id: index + 1, device_id, view_id, x, y })),
        floorRackPlacements: [{ floor_view_id: 52, rack_view_id: 61, x: 70, y: 20 }],
        rackMounts: [{ view_id: 61, device_id: 3 }],
        rackShelves: [{ id: 81, view_id: 61 }],
        rackShelfDevices: [{ shelf_id: 81, device_id: 4 }],
        floorPlans: [{ view_id: 51, image_url: '/test-building.png', image_width: 210, image_height: 150, x: 0, y: 0, scale: 1 }],
        devicePorts: [{ id: 71, device_id: 3, name: 'LAN 3', vlan: 'access 10' }],
        linkSystems: systems,
        links: [first, second, other, ...[[1, 2], [1, 6], [7, 3]].map(([from_id, to_id], index) =>
            normalizeLink({ id: 104 + index, from_id, to_id }))],
        legacyLinkConflicts: [{ legacy_link_id: 201, view_id: 51, device_a_id: 1, device_b_id: 5,
            payload: { from_id: 1, to_id: 5, from_port: 'LAN 1', to_port: '' } }],
        canvas, currentViewId: 51, isPinging: false, authExpired: false, dataRevision: 10
    });
    const updated = { ...first, memo: '個票で保存した備考', resource_revision: 2 };
    resetResourceBaseline(appState);
    const requests = [];
    globalThis.fetch = async (url, options) => {
        const action = new URL(String(url), 'http://localhost').searchParams.get('action');
        requests.push({ action, links: JSON.parse(options.body).links });
        return new Response(JSON.stringify({ ok: true, revision: 11, id_maps: {}, links: [updated], device_ports: [],
            deleted_link_ids: [], deleted_device_port_ids: [], removed_view_link_routes: [], views: [] }));
    };
    return { dom, appState, eventBus, normalizeLink, resetResourceBaseline, getTopModalContainer, requestModalClose,
        openBuildingView, closeBuildingView, getOpenBuildingId, hasBuildingViewDraft, settle, floor, first, second,
        other, systems, updated, requests, footerZoom, priorFocus, canvas, linkPanel, requestedImages };
}

test('フロア間接続の描画・選択・ドラフト中の同期と個票／代表平面図への遷移', async t => {
    const { dom, appState, eventBus, resetResourceBaseline, getTopModalContainer, requestModalClose, openBuildingView,
        closeBuildingView, getOpenBuildingId, hasBuildingViewDraft, settle, first, second, other, systems, updated,
        requests, footerZoom, priorFocus, canvas, linkPanel } = await installConnectionFixture(t);
    const navigations = [];
    window.switchView = id => navigations.push(id);
    assert.equal(await openBuildingView(1), true);
    assert.equal(footerZoom.hidden, true);
    assert.equal(dom.get('status-bar').hidden, false);
    const isInert = node => {
        for (; node; node = node.parentElement) if (node.inert === true) return true;
        return false;
    };
    for (const id of ['toast', 'status-toast-message']) {
        assert.equal(isInert(dom.get(id)), false, `${id} は通知の読み上げ・表示のため隔離しない`);
    }
    assert.equal(isInert(dom.get('status-save-state')), true);
    assert.equal(isInert(dom.get('canvas-view-controls')), true);
    const panel = () => document.querySelector('.building-view');
    const stage = () => panel().querySelector('.building-view-stage');
    const control = key => panel().querySelector(`[data-building-target="${key}"]`);
    const action = key => panel().querySelector(`[data-building-action="${key}"]`);
    const button = name => panel().querySelectorAll('button').find(button => button.textContent === name);
    const details = () => panel().querySelector('.building-connection-details');
    const checkbox = id => dom.get(`building-view-${id}`);
    const toggle = () => checkbox('show-connections');
    const check = async (id, value) => {
        const input = checkbox(id);
        input.checked = value;
        await input.dispatch('change');
    };
    const line = (key = '1:3') => control(`link:${key}`).querySelector('.building-link-stroke');
    const ends = () => ['x1', 'y1', 'x2', 'y2'].map(attr => line().getAttribute(attr));
    const dot = key => ['cx', 'cy'].map(attr => control(key).querySelector('.building-device-dot').getAttribute(attr));
    const rack = panel().querySelectorAll('[data-building-target]').find(node => node.dataset.buildingTarget.startsWith('location:'))
        .dataset.buildingTarget;
    assert.equal(toggle().checked, true);
    assert.equal(checkbox('selected-floor-only').checked, false);
    assert.equal(checkbox('type-router').checked, true);
    const allTypes = checkbox('all-types');
    assert.equal(allTypes.checked, true);
    assert.equal(allTypes.indeterminate, false);
    assert.equal(toggle().closest('.building-view-display'), stage().previousElementSibling);
    assert.equal(panel().querySelectorAll('.building-link-stroke').length, 2);
    assert.equal(control('device:7'), null);
    assert.deepEqual(panel().querySelectorAll('.building-link-badge').map(node => node.textContent), ['×2']);
    assert.ok(control('link:1:3').querySelector('.building-link-count').querySelector('rect'), '複数接続の件数に背景を表示する');
    assert.equal(control('link:2:5').querySelector('.building-link-count'), null);
    assert.match(line().getAttribute('stroke'), /--link-system-teal/);
    assert.match(line('2:5').getAttribute('stroke'), /--link-default-color/);
    assert.deepEqual(ends(), [...dot('device:1'), ...dot(rack)]);
    assert.ok(ends().every(value => Number.isFinite(Number(value))));
    const [x, y] = dot('device:5').map(Number);
    assert.ok(x > 0 && x < stage().clientWidth && y > 0 && y < stage().clientHeight, '図面外の端点も初期表示で選べる');
    const svg = stage().querySelector('svg');
    assert.ok(svg.children.indexOf(control('link:1:3').parentElement) > svg.children.indexOf(panel().querySelector('.building-floor.selected')));
    assert.ok(svg.children.indexOf(control(rack).parentElement) < svg.children.indexOf(panel().querySelector('.building-floor-labels')));

    await check('show-connections', false);
    assert.equal(control('link:1:3'), null);
    assert.ok(control(rack));
    await check('show-connections', true);
    const unfiltered = ends();
    await check('selected-floor-only', true);
    assert.ok(control('device:1'));
    assert.equal(control(rack), null);
    assert.equal(control('device:5'), null);
    assert.deepEqual(ends(), unfiltered, '機器マーカーだけを絞り、フロア間接続線は表示する');
    await button('1F').click();
    assert.equal(control('device:1'), null);
    assert.ok(control(rack));
    await control(rack).click();
    assert.ok(action('device:4'));
    await check('type-router', false);
    assert.equal(control(rack), null, '同じラックの機器を種別単位で絞り込む');
    assert.equal(action('device:4'), null);
    assert.equal(control('device:3').getAttribute('aria-pressed'), 'true');
    await check('type-switch', false);
    assert.equal(panel().querySelector('.building-device-dot'), null);
    assert.equal(details().hidden, true, '非表示になった機器の選択を解除する');
    assert.deepEqual(ends(), unfiltered);
    await control('link:1:3').click();
    assert.equal(details().querySelector('h3').textContent, '接続明細', '両端のマーカーを隠しても接続線から明細を開ける');
    const types = Object.keys(DEVICE_TYPES);
    const summary = () => panel().querySelector('summary').textContent;
    assert.equal(allTypes.checked, false);
    assert.equal(allTypes.indeterminate, true, '一部を外すと一括チェックに混在状態を表示する');
    await check('all-types', true);
    assert.equal(allTypes.indeterminate, false);
    assert.ok(types.every(type => checkbox(`type-${type}`).checked));
    assert.equal(summary(), `機器種別（${types.length}/${types.length}）`);
    assert.ok(control(rack), '一括選択でラック上の機器マーカーが復帰する');
    assert.equal(control('device:1'), null, '一括選択は選択階の条件を変えない');
    await check('all-types', false);
    assert.equal(allTypes.indeterminate, false);
    assert.ok(types.every(type => !checkbox(`type-${type}`).checked));
    assert.equal(summary(), `機器種別（0/${types.length}）`);
    assert.equal(panel().querySelector('.building-device-dot'), null);
    assert.equal(control('link:1:3').getAttribute('aria-pressed'), 'true', '一括解除は接続線と明細の選択を変えない');
    assert.deepEqual(ends(), unfiltered);
    await check('all-types', true);
    await check('selected-floor-only', false);
    await button('B1').click();
    const beforePointer = ends();
    const hit = control('link:1:3').querySelector('.building-link-hit');
    await stage().dispatch('pointerdown', { target: hit, pointerId: 31, button: 0, clientX: 35, clientY: 35 });
    assert.equal(stage().hasPointerCapture(31), false);
    await stage().dispatch('pointermove', { pointerId: 31, clientX: 70, clientY: 60 });
    await stage().dispatch('pointerup', { pointerId: 31 });
    assert.deepEqual(ends(), beforePointer, '線のヒット領域から視点・位置合わせを操作しない');

    await control(rack).click();
    assert.match(details().textContent, /同じ位置の機器を選択/);
    assert.match(action('device:4').textContent, /機器4（1F）/);
    await action('device:3').click();
    assert.equal(control('link:1:3').classList.contains('is-emphasized'), true);
    assert.equal(control('link:2:5').classList.contains('is-muted'), true);
    assert.equal(control('device:1').classList.contains('is-emphasized'), true);
    assert.equal(control('device:5').classList.contains('is-muted'), true);
    assert.equal(button('B1').getAttribute('aria-pressed'), 'true');
    await control('link:1:3').dispatch('keyup', { key: ' ' });
    assert.match(details().textContent, /2 件 · 系統：業務/);
    assert.match(details().textContent, /接続 #101機器1（B1）：未指定 ↔ 機器3（1F）：未指定/);
    assert.match(details().textContent, /接続 #102機器3（1F）：LAN 3 ↔ 機器1（B1）：未指定/);
    const [withMetadata, withoutMetadata] = details().querySelector('.building-connection-members').children;
    assert.deepEqual(withMetadata.querySelector('.building-connection-fields').children.map(field => field.textContent),
        ['系統：業務', 'ラベル：幹線 A']);
    assert.match(withMetadata.textContent, /備考：合成備考/);
    assert.equal(withoutMetadata.querySelector('.building-connection-fields').textContent, '系統：業務');
    assert.doesNotMatch(withoutMetadata.textContent, /備考：/);
    assert.doesNotMatch(details().textContent, /VLAN|access 10/);
    assert.equal(document.activeElement, details().querySelector('h3'));
    const clear = button('選択を解除');
    clear.focus();
    await clear.click();
    assert.equal(details().hidden, true);
    assert.equal(document.activeElement, toggle());
    assert.equal(control('link:1:3').getAttribute('aria-pressed'), 'false');
    assert.equal(panel().querySelector('.is-muted'), null);
    assert.equal(button('B1').getAttribute('aria-pressed'), 'true');
    await control('link:1:3').click();
    assert.deepEqual(navigations, []);

    await button('位置合わせモード').click();
    const floorArea = panel().querySelector('.building-floor.selected').querySelector('.building-floor-face');
    await stage().dispatch('pointerdown', { target: floorArea, pointerId: 32, button: 0, clientX: 100, clientY: 100 });
    await stage().dispatch('pointermove', { pointerId: 32, clientX: 137, clientY: 118 });
    assert.notDeepEqual(ends().slice(0, 2), beforePointer.slice(0, 2));
    assert.deepEqual(ends(), [...dot('device:1'), ...dot(rack)]);
    assert.deepEqual(ends().slice(2), beforePointer.slice(2));
    await stage().dispatch('pointercancel', { pointerId: 32 });
    assert.deepEqual(ends(), beforePointer);
    const input = panel().querySelectorAll('label').find(label => label.textContent === 'X移動').querySelector('input');
    input.value = '22'; await input.dispatch('input');
    const draftEnds = ends();
    assert.notDeepEqual(draftEnds, beforePointer);
    assert.deepEqual(draftEnds.slice(2), beforePointer.slice(2));
    assert.equal(hasBuildingViewDraft(), true);

    appState.linkSystems = [{ ...systems[0], name: '業務更新', color_key: 'indigo' }, { ...systems[1], color_key: 'indigo' }];
    eventBus.emit('link-systems:changed');
    assert.match(line().getAttribute('stroke'), /--link-system-indigo/);
    assert.match(details().textContent, /業務更新/);
    assert.deepEqual(ends(), draftEnds);
    appState.links = [{ ...second, system_id: 9, memo: '個票からの更新' }, first, other];
    eventBus.emit('resources:saved', { links: appState.links });
    assert.match(line().getAttribute('stroke'), /--link-default-color/, '同じ配色でも異なる系統なら中立');
    assert.match(details().textContent, /個票からの更新/);
    assert.equal(input.value, '22');
    action('plan:3').focus();
    appState.links = [other];
    eventBus.emit('resource:reloaded', { kind: 'links', id: 101 });
    assert.equal(control('link:1:3'), null);
    assert.equal(details().hidden, true);
    assert.equal(document.activeElement, toggle());
    appState.links = [first, second, other];
    resetResourceBaseline(appState);
    eventBus.emit('resources:reloaded');
    await control('link:1:3').click();
    const keepAligning = action('sheet:3').click(); await settle();
    await dom.get('unsaved-changes-cancel').click(); await keepAligning;
    assert.equal(dom.get('ledger-device-sheet-overlay').hidden, true);
    assert.equal(input.value, '22');
    const stay = action('plan:3').click(); await settle();
    await dom.get('unsaved-changes-cancel').click(); await stay;
    assert.equal(getOpenBuildingId(), 1);
    assert.equal(input.value, '22');
    assert.deepEqual(navigations, []);
    const go = action('plan:3').click(); await settle();
    await dom.get('unsaved-changes-discard').click(); await go;
    assert.deepEqual(navigations, [52], '図面画像が未登録でも代表物理配置ビューを開く');
    assert.equal(getOpenBuildingId(), null);
    assert.equal(footerZoom.hidden, false);

    await openBuildingView(1);
    assert.equal(footerZoom.hidden, true);
    await check('show-connections', false);
    await check('selected-floor-only', true);
    await check('type-router', false);
    await closeBuildingView();
    await openBuildingView(1);
    assert.equal(toggle().checked, true, '閉じた建物ビューの接続表示設定は持ち越さない');
    assert.equal(checkbox('selected-floor-only').checked, false);
    assert.equal(checkbox('type-router').checked, true);
    await button('1F').click();
    await panel().querySelector('button[aria-label="右へ回転"]').click();
    const beforeSheet = ends();
    await control('link:1:3').click();
    const sheet = dom.get('ledger-device-sheet-overlay');
    assert.equal(sheet.hidden, true);
    const trigger = action('sheet:3');
    trigger.focus();
    await trigger.click();
    assert.equal(getOpenBuildingId(), 1);
    assert.equal(getTopModalContainer(), sheet);
    assert.equal(sheet.inert, false);
    assert.equal(dom.get('ledger-sheet-body').dataset.deviceId, '3');
    assert.equal(dom.get('ledger-sheet-tabs').querySelector('[data-tab-key="ports"]').getAttribute('aria-selected'), 'true');
    assert.equal(canvas.inert, true);
    assert.equal(linkPanel.inert, true);
    assert.equal(document.activeElement, dom.get('close-ledger-detail-pane-btn'));
    const edit = sheet.querySelector('[data-port-ledger-key="link-101"]').querySelectorAll('button')
        .find(button => button.textContent === '編集');
    await edit.click();
    const memo = dom.get('ledger-port-linkMemo');
    memo.value = updated.memo;
    await memo.dispatch('input');
    await dom.get('ledger-port-editor').querySelectorAll('button').find(button => button.textContent === '適用').click();
    assert.deepEqual(requests, [{ action: 'save_connections', links: [
        { operation: 'update', id: 101, expected_revision: 1, link: { memo: updated.memo } }
    ] }]);
    assert.equal(getTopModalContainer(), sheet);
    const closingSheet = requestModalClose(); await settle();
    assert.equal(dom.get('unsaved-changes-overlay'), null, '適用後は個票をそのまま閉じられる');
    assert.equal(await closingSheet, true);
    assert.equal(sheet.hidden, true);
    assert.equal(getTopModalContainer(), null);
    assert.equal(getOpenBuildingId(), 1);
    assert.notEqual(canvas.inert, true);
    assert.equal(linkPanel.inert, true);
    assert.equal(button('1F').getAttribute('aria-pressed'), 'true');
    assert.equal(footerZoom.hidden, true, '個票を閉じても建物ビュー中は通常ビューのズーム操作を出さない');
    assert.deepEqual(ends(), beforeSheet);
    assert.equal(control('link:1:3').getAttribute('aria-pressed'), 'true');
    assert.match(details().textContent, /個票で保存した備考/);
    assert.equal(document.activeElement, action('sheet:3'));

    await action('sheet:1').click();
    appState.links = [other];
    eventBus.emit('resources:saved', { deleted_link_ids: [101, 102] });
    assert.equal(await requestModalClose(), true);
    assert.equal(getOpenBuildingId(), 1);
    assert.equal(control('link:1:3'), null);
    assert.equal(details().hidden, true);
    assert.equal(document.activeElement, toggle());
    await closeBuildingView();
    assert.equal(document.activeElement, priorFocus);

    // 個票を閉じるだけなら建物ビューに戻り、配置先の明示選択なら通常キャンバスに移る。
    resetResourceBaseline(appState);
    await openBuildingView(1);
    await control('link:2:5').click();
    await action('sheet:5').click();
    await dom.get('ledger-sheet-tabs').querySelector('[data-tab-key="primary"]').click();
    await sheet.querySelector('.ledger-sheet-view-pill').click();
    assert.equal(getOpenBuildingId(), null);
    assert.equal(sheet.hidden, true);
    assert.equal(footerZoom.hidden, false);
    assert.notEqual(canvas.inert, true);
    assert.equal(appState.currentViewId, 52);
    assert.deepEqual([...appState.selectedPlacementIds], [3]);
    assert.equal(dom.get('panel').hidden, false);
    assert.equal(appState.editingDeviceId, 5);
});

async function installComparisonFixture(t) {
    const fixture = await installConnectionFixture(t);
    const { appState, dom, floor, normalizeLink, resetResourceBaseline, settle } = fixture;
    appState.buildings = [...appState.buildings, { id: 3, name: '資料館', building_view_enabled: 1 },
        { id: 4, name: '非公開棟', building_view_enabled: 0 }];
    appState.floors = [...appState.floors.filter(row => row.id !== 20), floor(20, '1F', 2, 53),
        floor(21, '2F', 2, null), floor(30, '1F', 3, null), floor(40, '1F', 4, null)];
    appState.floorPlans = [...appState.floorPlans, { ...appState.floorPlans[0], view_id: 53, image_url: '/test-annex.png' }];
    appState.devicePorts = [...appState.devicePorts, { id: 72, device_id: 6, name: '別館 LAN' },
        { id: 73, device_id: 1, name: '本館 LAN' }];
    appState.links = appState.links.map(link => link.id === 105 ? { ...link, to_port_id: 72, system_id: 8 } : link)
        .concat(normalizeLink({ id: 107, from_id: 6, to_id: 1, from_port_id: 72, to_port_id: 73, system_id: 8 }),
            normalizeLink({ id: 108, from_id: 7, to_id: 6 }));
    resetResourceBaseline(appState);
    const navigations = [];
    window.switchView = id => navigations.push(id);
    const panel = () => document.querySelector('.building-view');
    const stage = () => panel().querySelector('.building-view-stage');
    const button = text => panel().querySelectorAll('button').find(node => node.textContent === text);
    const sceneTarget = key => stage().querySelector(`[data-building-target="${key}"]`);
    const action = key => panel().querySelector(`[data-building-action="${key}"]`);
    const svgFloor = id => stage().querySelector(`.building-floor[data-floor-id="${id}"]`);
    const floorList = () => panel().querySelector('.building-view-floors');
    const floorButton = id => floorList().querySelector(`button[data-floor-id="${id}"]`);
    const details = () => panel().querySelector('.building-connection-details');
    const compare = () => dom.get('building-view-compare-building');
    const anchor = index => dom.get(`building-view-compare-anchor-${index}`);
    const setSelect = async (select, value) => {
        select.value = value;
        await select.dispatch('change'); await settle();
    };
    const check = async (id, value) => {
        const input = dom.get(`building-view-${id}`);
        input.checked = value;
        await input.dispatch('change');
    };
    const addAnnex = async () => {
        await setSelect(compare(), '2');
        const adding = button('建物を追加').click(); await settle();
        assert.equal(dom.get('unsaved-changes-overlay'), null, '未保存の入力がなければ確認不要');
        await adding;
    };
    return { ...fixture, navigations, panel, stage, button, sceneTarget, action, svgFloor, floorList, floorButton,
        details, compare, anchor, setSelect, check, addAnnex };
}

const visible = node => Boolean(node && !node.closest('[hidden]'));
const enabled = node => visible(node) && !node.closest('[disabled]');
const facePoints = floor => floor.querySelector('.building-floor-face').getAttribute('points')
    .trim().split(/\s+/).map(point => point.split(',').map(Number));

test('別棟の追加前に位置合わせの未保存確認を行い、比較を解除すると単一表示に戻る', async t => {
    const { dom, appState, openBuildingView, getOpenBuildingId, hasBuildingViewDraft, requests, settle,
        panel, stage, button, svgFloor, floorList, compare, anchor, setSelect, addAnnex } = await installComparisonFixture(t);
    assert.equal(await openBuildingView(1), true);
    const originalFloors = structuredClone(appState.floors);
    const floorIds = () => stage().querySelectorAll('.building-floor')
        .map(node => Number(node.dataset.floorId)).sort((a, b) => a - b);
    assert.deepEqual(floorIds(), [10, 11]);
    assert.deepEqual(floorList().children.map(node => node.textContent), ['1F', 'B1']);
    assert.deepEqual(compare().options.filter(option => option.value).map(option => option.value).sort(), ['2', '3'],
        '主建物と無効な建物は追加候補に含まない');
    await button('位置合わせモード').click();
    const input = panel().querySelector('.building-view-editor').querySelectorAll('label')
        .find(label => label.textContent === 'X移動').querySelector('input');
    input.value = '22'; await input.dispatch('input');
    await setSelect(compare(), '2');

    const cancelling = button('建物を追加').click(); await settle();
    assert.ok(dom.get('unsaved-changes-overlay'));
    await dom.get('unsaved-changes-cancel').click(); await cancelling;
    assert.equal(getOpenBuildingId(), 1);
    assert.deepEqual(floorIds(), [10, 11]);
    assert.equal(input.value, '22');
    assert.equal(hasBuildingViewDraft(), true);
    assert.equal(requests.length, 0);

    await setSelect(compare(), '2');
    const discarding = button('建物を追加').click(); await settle();
    assert.ok(dom.get('unsaved-changes-overlay'));
    await dom.get('unsaved-changes-discard').click(); await discarding;
    assert.equal(getOpenBuildingId(), 1);
    assert.deepEqual(floorIds(), [10, 11, 20, 21]);
    assert.equal(stage().querySelectorAll('svg').length, 1);
    assert.equal(svgFloor(10).closest('svg'), svgFloor(20).closest('svg'), '両棟の階を同じSVGに描画する');
    const centerX = id => facePoints(svgFloor(id)).reduce((sum, [x]) => sum + x, 0) / 4;
    assert.ok(centerX(11) < centerX(20), '同じ描画領域の左に本館、右に別館を配置する');
    const svg = stage().querySelector('svg');
    const stackOrder = () => svg.children.filter(child => child === svgFloor(10).parentElement || child === svgFloor(20).parentElement);
    assert.deepEqual(stackOrder(), [svgFloor(20).parentElement, svgFloor(10).parentElement]);
    assert.deepEqual(svg.querySelectorAll('.building-name-label').map(label => label.textContent), ['本館', '別館']);
    const turn = panel().querySelector('button[aria-label="右へ回転"]');
    for (let step = 0; step < 3; step++) await turn.click();
    assert.deepEqual(stackOrder(), [svgFloor(10).parentElement, svgFloor(20).parentElement],
        '視点を回すと面の描画順が逆になり、選択階も手前の棟を覆わない');
    assert.equal(enabled(button('建物を追加')) && enabled(compare()), false, '比較中に3棟目を追加できない');
    assert.equal(enabled(button('位置合わせモード')), false);
    assert.equal(enabled(button('位置合わせを終了')), false);
    assert.equal(visible(panel().querySelector('.building-view-editor')), false);
    assert.equal(hasBuildingViewDraft(), false);
    assert.equal(requests.length, 0);
    assert.deepEqual(appState.floors, originalFloors);

    const removing = button('比較を解除').click(); await settle();
    assert.equal(dom.get('unsaved-changes-overlay'), null);
    await removing;
    assert.equal(getOpenBuildingId(), 1);
    assert.deepEqual(floorIds(), [10, 11]);
    assert.deepEqual(floorList().children.map(node => node.textContent), ['1F', 'B1']);
    assert.equal(visible(anchor(0)), false);
    assert.equal(visible(dom.get('building-view-show-inter-building-connections')), false);
    assert.equal(enabled(button('位置合わせモード')), true);
    await button('位置合わせモード').click();
    assert.equal(visible(panel().querySelector('.building-view-editor')), true);
    await addAnnex();
    assert.deepEqual(floorIds(), [10, 11, 20, 21]);
    assert.equal(visible(panel().querySelector('.building-view-editor')), false, '未保存の入力がない位置合わせを自動終了する');
    assert.equal(requests.length, 0);
});

test('保存を選んだ場合は主建物の下書きが確定するまで別棟を追加しない', async t => {
    const { appState, dom, openBuildingView, panel, button, svgFloor, addAnnex, settle } = await installComparisonFixture(t);
    const requests = [];
    let reply;
    globalThis.fetch = async (url, options) => {
        assert.match(url, /action=building_hierarchy$/);
        assert.equal(options.method, 'POST');
        const payload = JSON.parse(options.body);
        requests.push(payload);
        await new Promise(resolve => { reply = resolve; });
        const floor = appState.floors.find(row => row.id === payload.id);
        return Response.json({ ok: true, revision: appState.dataRevision + 1, floor: { ...floor, offset_x: payload.offset_x } });
    };
    assert.equal(await openBuildingView(1), true);
    await button('位置合わせモード').click();
    const input = panel().querySelector('.building-view-editor').querySelectorAll('label')
        .find(label => label.textContent === 'X移動').querySelector('input');
    input.value = '22'; await input.dispatch('input');
    const adding = button('建物を追加').click(); await settle();
    const saving = dom.get('unsaved-changes-save').click(); await settle();
    assert.equal(svgFloor(20), null, '保存の応答前は単一表示のまま');
    assert.equal(button('建物を追加').disabled, true, '保存中の別操作は無効');
    reply();
    await saving; await adding;
    assert.deepEqual(requests, [{ operation: 'update_floor_transform', id: 10, scale: 1, offset_x: 22, offset_y: 0, rotation: 0,
        expected_floor: { building_id: 1, representative_view_id: 51, scale: 1, offset_x: 0, offset_y: 0, rotation: 0 } }]);
    assert.equal(appState.floors.find(row => row.id === 10).offset_x, 22);
    assert.ok(svgFloor(20));
    assert.equal(visible(panel().querySelector('.building-view-editor')), false);

    await button('比較を解除').click();
    await addAnnex();
    assert.equal(requests.length, 1, '位置合わせを保存する以外に比較の保存リクエストは送らない');
});

test('2棟の接続表示・選択・機器マーカーと別棟の個票／代表平面図への遷移', async t => {
    const { dom, openBuildingView, getOpenBuildingId, getTopModalContainer, requestModalClose, navigations,
        panel, button, sceneTarget, action, floorList, floorButton, details, check, addAnnex, settle } = await installComparisonFixture(t);
    assert.equal(await openBuildingView(1), true);
    await addAnnex();
    const group = id => floorList().children.find(node => node.contains(floorButton(id)));
    assert.ok(group(11));
    assert.ok(group(20));
    assert.notEqual(group(11), group(20), '同名階は建物別のグループに分ける');
    assert.equal(dom.get(group(11).getAttribute('aria-labelledby')).textContent, '本館');
    assert.equal(dom.get(group(20).getAttribute('aria-labelledby')).textContent, '別館');
    assert.equal(floorButton(11).getAttribute('aria-label'), '本館：1F');
    assert.equal(floorButton(20).getAttribute('aria-label'), '別館：1F');

    const inside = () => sceneTarget('link:1:3');
    const between = () => sceneTarget('link:1:6');
    assert.equal(dom.get('building-view-show-connections').checked, true);
    assert.equal(dom.get('building-view-show-inter-building-connections').checked, true);
    assert.ok(inside());
    assert.ok(between());
    assert.equal(sceneTarget('link:6:7'), null, '複数の配置候補を持つ端点は推測しない');
    assert.equal(between().querySelector('.building-link-badge').textContent, '×2');
    assert.match(between().querySelector('.building-link-stroke').getAttribute('stroke'), /--link-system-teal/);
    assert.match(sceneTarget('device:6').getAttribute('aria-label'), /機器6（別館：1F）/);
    const rack = panel().querySelectorAll('[data-building-target]').find(node => node.dataset.buildingTarget.startsWith('location:'));
    assert.match(rack.getAttribute('aria-label'), /^本館：1F：同じ位置/);
    await rack.click();
    assert.match(action('device:4').textContent, /機器4（本館：1F）/);
    await between().click();
    assert.equal(between().getAttribute('aria-pressed'), 'true');
    assert.equal(inside().classList.contains('is-muted'), true);
    assert.match(details().textContent, /接続 #105機器1（本館：B1）：未指定 ↔ 機器6（別館：1F）：別館 LAN/);
    assert.match(details().textContent, /接続 #107機器6（別館：1F）：別館 LAN ↔ 機器1（本館：B1）：本館 LAN/);

    await check('show-connections', false);
    assert.equal(inside(), null);
    assert.equal(between().getAttribute('aria-pressed'), 'true');
    assert.equal(details().hidden, false);
    await check('show-inter-building-connections', false);
    assert.equal(between(), null);
    assert.equal(details().hidden, true, '選んだ建物間接続を非表示にすると選択も解除する');
    await check('show-connections', true);
    assert.ok(inside());
    assert.equal(between(), null);
    await inside().click();
    await check('show-inter-building-connections', true);
    assert.equal(inside().getAttribute('aria-pressed'), 'true');
    assert.equal(between().getAttribute('aria-pressed'), 'false');
    await check('show-connections', false);
    assert.equal(inside(), null);
    assert.ok(between());
    assert.equal(details().hidden, true, '棟内接続でも選択した線だけを解除する');
    await check('show-connections', true);

    assert.ok(sceneTarget('device:1'));
    await floorButton(20).click(); await settle();
    assert.equal(floorButton(20).getAttribute('aria-pressed'), 'true');
    assert.match(panel().querySelector('.building-view-selection').textContent, /別館：1F/);
    const lineEnds = line => ['x1', 'y1', 'x2', 'y2']
        .map(attr => line.querySelector('.building-link-stroke').getAttribute(attr));
    const beforeFilter = [lineEnds(inside()), lineEnds(between())];
    await check('selected-floor-only', true);
    assert.ok(sceneTarget('device:6'));
    assert.equal(sceneTarget('device:1'), null);
    assert.equal(sceneTarget('device:5'), null);
    assert.deepEqual([lineEnds(inside()), lineEnds(between())], beforeFilter);

    await between().click();
    await action('sheet:6').click();
    const sheet = dom.get('ledger-device-sheet-overlay');
    assert.equal(getTopModalContainer(), sheet);
    assert.equal(dom.get('ledger-sheet-body').dataset.deviceId, '6');
    assert.equal(dom.get('ledger-sheet-tabs').querySelector('[data-tab-key="ports"]').getAttribute('aria-selected'), 'true');
    assert.equal(getOpenBuildingId(), 1);
    assert.equal(await requestModalClose(), true);
    assert.equal(sheet.hidden, true);
    assert.equal(floorButton(20).getAttribute('aria-pressed'), 'true');
    assert.equal(between().getAttribute('aria-pressed'), 'true');
    assert.deepEqual(lineEnds(between()), beforeFilter[1]);
    await action('plan:6').click();
    assert.deepEqual(navigations, [53], '別館の代表物理配置ビューを明示的に開く');
    assert.equal(getOpenBuildingId(), null);

    assert.equal(await openBuildingView(1), true);
    await addAnnex();
    await floorButton(20).click(); await settle();
    await button('平面図を開く').click();
    assert.deepEqual(navigations, [53, 53], '選択階詳細からも別館の代表平面図を開く');
    assert.equal(getOpenBuildingId(), null);
});

test('左右のパネルを別々に折りたたみ、表示設定と選択を保つ', async t => {
    const { dom, openBuildingView, button, floorButton, sceneTarget, details, check } = await installComparisonFixture(t);
    assert.equal(await openBuildingView(1), true);
    const displayToggle = button('表示設定'), sidebarToggle = button('フロア・明細');
    const displayPanel = dom.get(displayToggle.getAttribute('aria-controls'));
    const sidebar = dom.get(sidebarToggle.getAttribute('aria-controls'));
    assert.equal(visible(displayPanel), true);
    assert.equal(visible(sidebar), true);
    await check('selected-floor-only', true);
    dom.get('building-view-selected-floor-only').focus();
    await displayToggle.click();
    assert.equal(displayToggle.getAttribute('aria-expanded'), 'false');
    assert.equal(document.activeElement, displayToggle);
    assert.equal(visible(displayPanel), false);
    assert.equal(visible(sidebar), true);
    assert.equal(sceneTarget('device:5'), null, '折りたたみ後も選択階フィルターが効く');
    await sceneTarget('link:1:3').click();
    floorButton(10).focus();
    await sidebarToggle.click();
    assert.equal(sidebarToggle.getAttribute('aria-expanded'), 'false');
    assert.equal(document.activeElement, sidebarToggle);
    assert.equal(visible(details()), false);
    await displayToggle.click();
    assert.equal(dom.get('building-view-selected-floor-only').checked, true);
    assert.equal(visible(sidebar), false);
    await sidebarToggle.click();
    assert.equal(visible(details()), true, '同じ明細に戻れる');
    assert.equal(sceneTarget('link:1:3').getAttribute('aria-pressed'), 'true');
    await sidebarToggle.click();
    await sceneTarget('link:2:5').click();
    assert.equal(sidebarToggle.getAttribute('aria-expanded'), 'true');
    assert.equal(visible(details()), true, '接続線から明細を開くと右パネルを展開する');
    assert.equal(sceneTarget('link:2:5').getAttribute('aria-pressed'), 'true');
});

test('比較の基準階と別棟の利用可否を再読込に追随させ、閲覧者も高さ・階・接続を選べる', async t => {
    const { appState, dom, eventBus, openBuildingView, getOpenBuildingId, requests, settle, panel, button, svgFloor,
        sceneTarget, floorButton, details, compare, anchor, setSelect, addAnnex, requestedImages } = await installComparisonFixture(t);
    window.APP_CONFIG.user.isAdmin = false;
    const originalBuildings = appState.buildings;
    const originalFloors = appState.floors;
    const savedFloors = structuredClone(originalFloors);
    assert.equal(await openBuildingView(1), true);
    assert.equal(enabled(button('位置合わせモード')), false, '単一表示でも閲覧者は編集不可');
    await addAnnex();
    assert.equal(anchor(0).value, '11');
    assert.equal(anchor(1).value, '20', '同名の1Fを初期の基準階にする');
    const heightDifference = () => facePoints(svgFloor(21))[0][1] - facePoints(svgFloor(11))[0][1];
    const autoHeightDifference = heightDifference();
    await setSelect(anchor(1), '21');
    assert.equal(anchor(1).value, '21');
    assert.notEqual(heightDifference(), autoHeightDifference, '基準階を変えると両棟の相対的な高さが変わる');
    await floorButton(21).click(); await settle();
    assert.equal(floorButton(21).getAttribute('aria-pressed'), 'true');
    await sceneTarget('link:1:6').click();
    assert.match(details().textContent, /接続 #105/);
    assert.equal(visible(panel().querySelector('.building-view-editor')), false);
    assert.equal(enabled(button('位置合わせモード')), false);
    assert.deepEqual(appState.floors, savedFloors, '基準階の操作は保存済みの位置合わせを変更しない');
    assert.equal(requests.length, 0);

    appState.floors = originalFloors.filter(row => row.id !== 21);
    eventBus.emit('resources:reloaded'); await settle();
    assert.equal(svgFloor(21), null);
    assert.equal(anchor(1).value, '20', '削除した基準階を保持せず残る階へ切り替える');
    assert.ok(sceneTarget('link:1:6'));
    if (sceneTarget('link:1:6').getAttribute('aria-pressed') !== 'true') await sceneTarget('link:1:6').click();

    const status = () => dom.get('toast').textContent;
    const assertSingleAfterLoss = reason => {
        assert.equal(getOpenBuildingId(), 1);
        assert.ok(svgFloor(10));
        assert.equal(svgFloor(20), null);
        assert.equal(sceneTarget('link:1:6'), null);
        assert.equal(details().hidden, true);
        assert.equal(visible(anchor(1)), false);
        assert.equal(compare().options.some(option => option.value === '2'), false);
        assert.match(status(), /比較.*解除/);
        assert.match(status(), reason);
    };
    for (const [buildings, reason] of [
        [originalBuildings.map(row => row.id === 2 ? { ...row, building_view_enabled: 0 } : row), /無効|利用でき|使用でき/],
        [originalBuildings.filter(row => row.id !== 2), /削除|なくな|見つか|存在し|利用でき|使用でき/]
    ]) {
        floorButton(20).focus();
        appState.buildings = buildings;
        eventBus.emit('resources:reloaded'); await settle();
        assertSingleAfterLoss(reason);
        assert.equal(document.activeElement, floorButton(10), '消えた階から主建物の選択階へフォーカスを戻す');
        const notice = status();
        requestedImages.get('/test-annex.png').onerror();
        assert.match(notice, /比較を解除/);
        assert.equal(status(), notice, '外した棟の図面エラーで解除理由を上書きしない');
        appState.buildings = originalBuildings;
        eventBus.emit('resources:reloaded'); await settle();
        assert.equal(svgFloor(20), null, '候補が復帰しても自動で再追加しない');
        await addAnnex();
        await sceneTarget('link:1:6').click();
    }

    await button('比較を解除').click();
    assert.equal(dom.get('status-toast-message').textContent, '比較を解除しました。');
    appState.floors = appState.floors.map(row => row.id === 20 ? { ...row, name: '吹抜け' } : row);
    eventBus.emit('hierarchy:changed'); await settle();
    await addAnnex();
    assert.equal(anchor(0).value, '10', '一致しない場合は主建物の先頭階を使う');
    assert.equal(anchor(1).value, '20');
    await setSelect(anchor(0), '11');
    await setSelect(anchor(1), '20');
    assert.equal(anchor(0).value, '11');
    assert.equal(anchor(1).value, '20');
    appState.buildings = originalBuildings.map(row => row.id === 1 ? { ...row, building_view_enabled: 0 } : row);
    eventBus.emit('resources:reloaded'); await settle();
    assert.equal(getOpenBuildingId(), null, '主建物の無効化で別棟を主にせず建物ビューを閉じる');
    assert.equal(panel(), null);
});

test('パン中に基準階が別棟へ移ると古い図への接続を消し、終了後に高さと接続種別を更新する', async t => {
    const { appState, eventBus, openBuildingView, addAnnex, stage, anchor, button, sceneTarget, check } =
        await installComparisonFixture(t);
    assert.equal(await openBuildingView(1), true);
    await addAnnex();
    assert.equal(anchor(1).value, '20');
    assert.ok(sceneTarget('link:1:6'));
    await check('show-inter-building-connections', false);
    assert.equal(sceneTarget('link:1:6'), null);

    const plane = stage();
    await plane.dispatch('pointerdown', { pointerId: 31, button: 0, shiftKey: true, clientX: 110, clientY: 120 });
    await plane.dispatch('pointermove', { pointerId: 31, clientX: 146, clientY: 144 });
    assert.equal(button('比較を解除').disabled, true);
    appState.floors = appState.floors.map(row => row.id === 20 ? { ...row, building_id: 1 } : row);
    eventBus.emit('hierarchy:changed');
    assert.equal(sceneTarget('link:1:6'), null, '移動前の別棟の位置へ新しい棟内接続を描かない');
    assert.equal(sceneTarget('device:6'), null, '所属が変わった端点も保留中の図には描かない');
    await plane.dispatch('pointercancel', { pointerId: 31 });
    assert.equal(anchor(1).value, '21');
    assert.match(sceneTarget('link:1:6').getAttribute('aria-label'), /機器6（本館：1F）/);
    assert.equal(button('比較を解除').disabled, false);
});

test('建物ビューをShift・右ボタン・タッチ用の移動モードでパンし、取消時は投影を戻す', async t => {
    const { appState, openBuildingView, hasBuildingViewDraft, requests, panel, stage, svgFloor, floorButton, addAnnex, settle } =
        await installComparisonFixture(t);
    assert.equal(await openBuildingView(1), true);
    const savedFloors = structuredClone(appState.floors);
    const reset = () => panel().querySelector('button[aria-label="視点をリセット"]').click();
    const points = ids => ids.flatMap(id => facePoints(svgFloor(id)));
    const pan = async (ids, pointerId, options, endEvent) => {
        const plane = stage();
        const before = points(ids);
        const from = { clientX: 110, clientY: 120 };
        const to = { clientX: 146, clientY: 144 };
        await plane.dispatch('pointerdown', { pointerId, button: 0, isPrimary: true, ...options, ...from });
        assert.equal(plane.hasPointerCapture(pointerId), true);
        await plane.dispatch('pointermove', { pointerId, ...to });
        const moved = points(ids);
        moved.forEach(([x, y], index) => {
            assert.ok(Math.abs(x - before[index][0] - 36) < 1e-8 && Math.abs(y - before[index][1] - 24) < 1e-8,
                '各頂点が同量だけ平行移動し、図形の角度と大きさは変わらない');
        });
        await plane.dispatch(endEvent, { pointerId, ...to });
        assert.equal(plane.hasPointerCapture(pointerId), false);
        assert.deepEqual(points(ids), endEvent === 'pointerup' ? moved : before);
    };
    await pan([10, 11], 31, { shiftKey: true }, 'pointerup');
    await reset();
    await addAnnex();
    const ids = [10, 11, 20, 21];
    const fitted = points(ids);
    await pan(ids, 32, { button: 2 }, 'pointerup');
    await reset();
    assert.deepEqual(points(ids), fitted);

    const camera = stage().querySelector('.building-view-camera');
    const mode = camera.querySelector('button[aria-label="ドラッグで移動"]');
    const right = camera.querySelector('button[aria-label="右へ移動"]');
    assert.equal(visible(right), false);
    assert.equal(mode.getAttribute('aria-pressed'), 'false');
    await mode.click();
    assert.equal(panel().classList.contains('panning'), true);
    assert.equal(mode.getAttribute('aria-pressed'), 'true');
    assert.equal(visible(right), true);
    const assertMovedRight = () => points(ids).forEach(([x, y], index) => {
        assert.ok(Math.abs(x - fitted[index][0] - 32) < 1e-8);
        assert.ok(Math.abs(y - fitted[index][1]) < 1e-8);
    });
    await right.click();
    assertMovedRight();
    await reset();
    await mode.dispatch('keydown', { key: 'ArrowRight' });
    assertMovedRight();
    await reset();
    await stage().dispatch('wheel', { target: right, deltaY: -100 });
    assert.deepEqual(points(ids), fitted, '視点操作バーのスクロールをズームで奪わない');
    await pan(ids, 33, { pointerType: 'touch' }, 'pointercancel');
    await pan(ids, 35, { pointerType: 'touch' }, 'lostpointercapture');
    await pan(ids, 34, { pointerType: 'touch' }, 'pointerup');
    await reset();
    // 移動モード中でもフロア面上からのドラッグはパン、クリックは階選択として扱う。
    await pan(ids, 36, { pointerType: 'touch', target: svgFloor(11) }, 'pointerup');
    assert.equal(floorButton(10).getAttribute('aria-pressed'), 'true');
    await stage().dispatch('pointerdown', { pointerId: 37, button: 0, isPrimary: true, target: svgFloor(20), clientX: 100, clientY: 100 });
    await stage().dispatch('pointerup', { pointerId: 37, target: svgFloor(20), clientX: 101, clientY: 101 });
    await settle();
    assert.equal(floorButton(20).getAttribute('aria-pressed'), 'true');
    await reset();
    stage().clientHeight = 100;
    await reset();
    for (const label of stage().querySelectorAll('.building-name-label')) {
        assert.ok(Number(label.getAttribute('y')) >= 16, '狭い縦幅でも建物名ラベルが上端に見切れない');
    }
    await stage().dispatch('pointerdown', { pointerId: 38, button: 0, isPrimary: true, clientX: 100, clientY: 300 });
    await stage().dispatch('pointermove', { pointerId: 38, clientX: 100, clientY: 50 });
    await stage().dispatch('pointerup', { pointerId: 38, clientX: 100, clientY: 50 });
    for (const label of stage().querySelectorAll('.building-name-label')) {
        assert.ok(Number(label.getAttribute('y')) < 0, '上方向へパンして建物が画面外へ出たときはラベルも追従する');
    }
    await mode.click();
    assert.equal(panel().classList.contains('panning'), false);
    assert.equal(mode.getAttribute('aria-pressed'), 'false');
    assert.equal(visible(right), false);
    assert.equal(hasBuildingViewDraft(), false);
    assert.deepEqual(appState.floors, savedFloors);
    assert.equal(requests.length, 0);
});
