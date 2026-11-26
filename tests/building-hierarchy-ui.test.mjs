import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { installWorkspaceDom } from './helpers/workspace-dom.mjs';

// API 側の参照整合性は PHP 回帰で検証し、ここでは未分類・入力保持・実フォームの操作を確認する。
test('建物・フロア管理と既存ビュー所属のUI境界', async t => {
    const keys = ['window', 'document', 'Element', 'HTMLElement', 'fetch', 'localStorage'];
    const globals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const dom = installWorkspaceDom({ templates: ['templates/modals/view_manager.php', 'templates/components/toast.php'] });
    globalThis.localStorage = { getItem: () => null, setItem() {} };
    window.confirm = () => true;
    const { appState, normalizeView, normalizeDevice, normalizePlacement, normalizeLink, toSaveView } = await import('../public/js/core/state.js');
    const oldState = { ...appState };
    const { resetResourceBaseline, buildResourceSave } = await import('../public/js/core/resource-save.js');
    const { clearPendingSave } = await import('../public/js/core/save-queue.js');
    const { hierarchyViewEntries, viewHierarchyPath } = await import('../public/js/core/building-hierarchy.js');
    const manager = await import('../public/js/modals/view-manager-modal.js');
    const { hasHierarchyEditorDraft } = await import('../public/js/modals/building-hierarchy-editor.js');
    const { initModalFocusTrap } = await import('../public/js/core/modal-focus.js');
    initModalFocusTrap();
    Object.assign(appState, {
        views: [
            { id: 1, name: '既存論理', view_type: 'topology' },
            { id: 2, name: '配置図', view_type: 'floor', floor_id: 10 },
            { id: 3, name: 'ラック', view_type: 'rack', floor_id: 10 }
        ].map(view => normalizeView({ ...view, resource_revision: 1 })),
        buildings: [{ id: 5, name: '本館', sort_order: 10, building_view_enabled: 1 }],
        floors: [{ id: 10, building_id: 5, name: 'B2', sort_order: 10, representative_view_id: 2, scale: 1, offset_x: 0, offset_y: 0, rotation: 0 },
            { id: 11, building_id: 5, name: 'RF', sort_order: -10, representative_view_id: null, scale: 1, offset_x: 0, offset_y: 0, rotation: 0 }],
        devices: [], placements: [], links: [], canvasNotes: [], rackSettings: [{ view_id: 3, total_u: 42, location: '' }], rackMounts: [], rackShelves: [],
        devicePorts: [], viewLinkRoutes: [],
        rackShelfDevices: [], floorRackPlacements: [], floorPlans: [], deviceImages: [],
        currentViewId: 1, dataRevision: 7, appStatus: { dirty: false, state: 'saved' }, authExpired: false,
        isPinging: false, isSaving: false, viewManagerFormDirty: false, isFloorPlanUpdating: false
    });
    clearPendingSave(); resetResourceBaseline(appState);
    let requests = [], failure = false, releaseRequest, snapshotOverride = {};
    globalThis.fetch = async (url, options) => {
        const payload = options?.body ? JSON.parse(options.body) : { operation: 'read', revision: appState.dataRevision };
        requests.push(payload);
        if (releaseRequest) await releaseRequest;
        if (failure) return new Response(JSON.stringify({ ok: false, error: '保存失敗' }), { status: typeof failure === 'number' ? failure : 409 });
        if (String(url).includes('save_resources')) {
            const idMap = Object.fromEntries(payload.views.filter(row => row.operation === 'create').map((row, index) => [row.id, 100 + requests.length * 10 + index]));
            const mapped = id => idMap[id] ?? id;
            const views = payload.views.map(operation => ({ ...operation.view, id: mapped(operation.id), resource_revision: 2 }));
            const floors = appState.floors.map(floor => ({ ...floor, representative_view_id: appState.views.some(view =>
                Number(view.id) === Number(floor.representative_view_id) && Number(view.floor_id) === Number(floor.id) &&
                view.view_type === 'floor') ? floor.representative_view_id : null }));
            return new Response(JSON.stringify({ ok: true, revision: appState.dataRevision + 1, id_maps: { views: idMap }, devices: [], views,
                placements: payload.views.flatMap(row => row.placements || []),
                view_link_routes: payload.views.flatMap(row => (row.view_link_routes || []).map(route => ({ ...route, view_id: mapped(row.id) }))),
                canvas_notes: payload.views.flatMap(row => row.canvas_notes || []),
                rack_settings: payload.views.flatMap(row => row.rack_settings ? [{ ...row.rack_settings, view_id: mapped(row.id) }] : []),
                rack_mounts: payload.views.flatMap(row => row.rack_mounts || []), rack_shelves: [], rack_shelf_devices: [], floor_rack_placements: [],
                deleted_view_ids: [], deleted_device_ids: [], affected_view_ids: views.map(view => view.id),
                buildings: appState.buildings, floors }));
        }
        if (payload.revision !== appState.dataRevision) {
            return new Response(JSON.stringify({ ok: false, error: '他の操作で更新されています' }), { status: 409 });
        }
        const buildings = appState.buildings.map(row => ({ ...row }));
        const floors = appState.floors.map(row => ({ ...row }));
        const rows = payload.operation.endsWith('_floor') ? floors : buildings;
        if (payload.operation.startsWith('update_')) Object.assign(rows.find(row => row.id === payload.id), payload);
        if (payload.operation.startsWith('create_')) rows.push({ ...payload, id: Math.max(0, ...rows.map(row => Number(row.id))) + 1 });
        if (payload.operation.startsWith('delete_')) rows.splice(rows.findIndex(row => row.id === payload.id), 1);
        return new Response(JSON.stringify({ ok: true, revision: appState.dataRevision + (payload.operation === 'read' ? 0 : 1), buildings, floors, views: appState.views,
            devices: appState.devices, placements: appState.placements, links: appState.links, canvas_notes: appState.canvasNotes,
            device_ports: appState.devicePorts, view_link_routes: appState.viewLinkRoutes,
            rack_settings: appState.rackSettings, rack_mounts: appState.rackMounts, rack_shelves: appState.rackShelves,
            rack_shelf_devices: appState.rackShelfDevices, floor_rack_placements: appState.floorRackPlacements,
            floor_plans: appState.floorPlans, device_images: [], link_systems: [], address_spaces: [], ip_segments: [], monitor_revision: 0,
            ...snapshotOverride }));
    };
    const overlay = () => dom.get('view-manager-overlay');
    const tree = key => dom.get('view-manager-list').querySelectorAll('button').find(button => button.dataset.nodeKey === key);
    const reveal = async key => {
        const [kind, id] = key.split(':');
        const view = kind === 'view' ? appState.views.find(row => Number(row.id) === Number(id)) : null;
        const floor = appState.floors.find(row => Number(row.id) === Number(kind === 'floor' ? id : view?.floor_id));
        const ancestors = floor ? [`building:${floor.building_id}`, ...(kind === 'view' ? [`floor:${floor.id}`] : [])] :
            kind === 'view' ? ['unclassified'] : [];
        for (const ancestor of ancestors) {
            assert.ok(tree(ancestor), `選択経路 ${ancestor} が表示される`);
            if (tree(ancestor).getAttribute('aria-expanded') === 'false') {
                await tree(ancestor).dispatch('keydown', { key: 'ArrowRight' });
            }
        }
    };
    const select = async key => { await reveal(key); await tree(key).click(); };
    const close = () => manager.closeViewManager();
    const submit = async () => { await dom.get('building-hierarchy-form').dispatch('submit'); await settle(); };
    const settle = async () => { await setImmediate(); await setImmediate(); };
    const decide = async (action, choice) => {
        const pending = action();
        await settle();
        assert.ok(dom.get('unsaved-changes-overlay'));
        await dom.get(`unsaved-changes-${choice}`).click();
        await pending; await settle();
    };
    t.after(async () => {
        window.confirm = () => true;
        failure = false;
        if (dom.get('unsaved-changes-cancel')) await dom.get('unsaved-changes-cancel').click();
        if (!overlay().hidden) {
            const pending = close(); await settle();
            if (dom.get('unsaved-changes-discard')) await dom.get('unsaved-changes-discard').click();
            await pending;
        }
        clearPendingSave(); Object.assign(appState, oldState); resetResourceBaseline(appState);
        for (const [key, value] of globals) {
            if (value) Object.defineProperty(globalThis, key, value); else delete globalThis[key];
        }
    });

    await t.test('所属を正規化・保存し、フロア名ではなく指定順で階層を並べる', () => {
        assert.equal(toSaveView(appState.views[0]).floor_id, null);
        assert.equal(toSaveView(appState.views[1]).floor_id, 10);
        assert.equal(viewHierarchyPath(appState.views[1], appState), '本館 / B2');
        assert.deepEqual(hierarchyViewEntries(appState).map(row => row.id), [2, 3, 1]);
        assert.deepEqual(buildResourceSave().views, []);
    });
    await t.test('選択経路だけを開き、再表示・検索解除では手動開閉を保持して新しい選択経路だけを開く', async () => {
        const original = { views: appState.views, buildings: appState.buildings, floors: appState.floors, currentViewId: appState.currentViewId };
        Object.assign(appState, {
            buildings: [{ id: 50, name: '経路本館' }, { id: 51, name: '経路別館' }],
            floors: [{ id: 60, building_id: 50, name: '選択階' }, { id: 61, building_id: 50, name: '別階' },
                { id: 62, building_id: 51, name: '別館階' }],
            views: [{ id: 1001, name: '選択ビュー', floor_id: 60 }, { id: 1002, name: '検索対象', floor_id: 61 },
                { id: 1003, name: '未所属対象' }, { id: 1004, name: '未所属その他' }].map(normalizeView),
            currentViewId: 1001
        });
        const search = dom.get('view-manager-search');
        const filter = value => { search.value = value; manager.renderViewManagerList(); };
        try {
            manager.openViewManager();
            assert.deepEqual(dom.get('view-manager-list').children.map(row => row.dataset.nodeKey),
                ['building:50', 'floor:60', 'view:1001', 'floor:61', 'building:51', 'unclassified']);
            assert.equal(tree('floor:61').getAttribute('aria-expanded'), 'false');
            assert.equal(tree('building:51').getAttribute('aria-expanded'), 'false');
            assert.equal(tree('unclassified').textContent, '▸ 未分類ビュー（2件）');
            await tree('floor:60').dispatch('keydown', { key: 'ArrowLeft' });
            assert.equal(document.activeElement, tree('floor:60'));
            await close();
            manager.renderViewManagerList();
            manager.openViewManager();
            assert.equal(manager.getViewManagerSelectedView().id, 1001);
            assert.equal(tree('floor:60').getAttribute('aria-expanded'), 'false');
            assert.equal(tree('view:1001'), undefined);
            filter('未所属対象');
            assert.ok(tree('view:1003'));
            assert.equal(tree('view:1004'), undefined);
            assert.equal(tree('unclassified').textContent, '▾ 未分類ビュー（2件）');
            filter('');
            assert.equal(tree('unclassified').getAttribute('aria-expanded'), 'false');
            assert.equal(tree('floor:60').getAttribute('aria-expanded'), 'false');
            filter('検索対象');
            assert.ok(tree('view:1002'));
            await tree('floor:61').dispatch('keydown', { key: 'ArrowRight' });
            assert.equal(document.activeElement, tree('view:1002'));
            await tree('view:1002').dispatch('keydown', { key: 'ArrowLeft' });
            assert.equal(document.activeElement, tree('floor:61'));
            await tree('floor:61').dispatch('keydown', { key: 'ArrowLeft' });
            assert.equal(document.activeElement, tree('building:50'));
            filter('');
            assert.equal(tree('floor:61').getAttribute('aria-expanded'), 'false');
            filter('検索対象');
            await select('view:1002');
            filter('');
            assert.equal(tree('view:1002').getAttribute('aria-selected'), 'true');
            assert.equal(tree('floor:61').getAttribute('aria-expanded'), 'true');
            assert.equal(tree('floor:60').getAttribute('aria-expanded'), 'false');
            assert.equal(tree('building:51').getAttribute('aria-expanded'), 'false');
            filter('経路別館');
            await select('building:51');
            filter('');
            assert.equal(tree('building:51').getAttribute('aria-selected'), 'true');
            assert.equal(tree('building:51').getAttribute('aria-expanded'), 'true');
            assert.equal(tree('floor:62').getAttribute('aria-expanded'), 'false');
            await tree('building:51').dispatch('keydown', { key: 'ArrowLeft' });
            filter('別館階');
            await select('floor:62');
            filter('');
            assert.equal(tree('floor:62').getAttribute('aria-selected'), 'true');
            assert.equal(tree('building:51').getAttribute('aria-expanded'), 'true');
            assert.equal(tree('floor:62').getAttribute('aria-expanded'), 'true');
            filter('未所属対象');
            await select('view:1003');
            filter('');
            assert.equal(tree('unclassified').getAttribute('aria-expanded'), 'true');
            assert.equal(tree('view:1003').getAttribute('aria-selected'), 'true');
            await close();
            appState.currentViewId = 1002;
            manager.openViewManager();
            await tree('building:51').dispatch('keydown', { key: 'ArrowLeft' });
            appState.views.find(view => view.id === 1002).floor_id = 62;
            manager.renderViewManagerList();
            assert.equal(tree('building:51').getAttribute('aria-expanded'), 'true');
            assert.equal(tree('floor:62').getAttribute('aria-expanded'), 'true');
            assert.equal(tree('view:1002').getAttribute('aria-selected'), 'true');
            assert.equal(tree('floor:60').getAttribute('aria-expanded'), 'false');
            await decide(close, 'discard');
            appState.buildings = []; appState.floors = [];
            appState.views = appState.views.map(view => normalizeView({ ...view, floor_id: null }));
            appState.currentViewId = 1003;
            manager.openViewManager();
            assert.equal(tree('unclassified').textContent, '▾ 未分類ビュー（4件）');
            assert.deepEqual(dom.get('view-manager-list').children.map(row => row.dataset.nodeKey),
                ['unclassified', 'view:1001', 'view:1002', 'view:1003', 'view:1004']);
            await tree('unclassified').dispatch('keydown', { key: 'ArrowLeft' });
            await close(); manager.openViewManager();
            assert.equal(tree('unclassified').getAttribute('aria-expanded'), 'false');
            await tree('unclassified').dispatch('keydown', { key: 'ArrowRight' });
            assert.ok(tree('view:1003'));
        } finally {
            filter('');
            await close();
            Object.assign(appState, original);
        }
    });
    await t.test('同じ管理画面に建物・空フロア・代表ビュー・未分類を表示し、キーボードで折りたたむ', async () => {
        manager.openViewManager();
        assert.equal(dom.get('building-hierarchy-overlay'), null);
        assert.equal(dom.get('building-hierarchy-manager-btn'), null);
        assert.deepEqual(dom.get('view-manager-list').children.map(row => row.dataset.nodeKey),
            ['building:5', 'unclassified', 'view:1']);
        assert.equal(tree('unclassified').textContent, '▾ 未分類ビュー（1件）');
        assert.equal(tree('building:5').getAttribute('aria-expanded'), 'false');
        await select('building:5');
        assert.equal(tree('floor:10').getAttribute('aria-expanded'), 'false');
        assert.equal(tree('view:2'), undefined);
        await tree('floor:10').dispatch('keydown', { key: 'ArrowRight' });
        assert.equal(tree('view:2').textContent, '配置図（代表）');
        assert.equal(dom.get('view-manager-form').hidden, true);
        assert.equal(dom.get('hierarchy-name').value, '本館');
        for (const id of ['view-duplicate-btn', 'view-delete-btn', 'view-apply-btn', 'view-history-btn', 'view-conflict-reload-btn']) {
            assert.equal(dom.get(id).closest('form'), dom.get('view-manager-form'));
            assert.equal(dom.get('hierarchy-editor').contains(dom.get(id)), false);
        }
        const buildingActions = dom.get('building-hierarchy-form').querySelectorAll('button');
        assert.ok(buildingActions.some(button => button.textContent === '建物を削除'));
        await tree('building:5').dispatch('keydown', { key: 'ArrowLeft' });
        assert.equal(tree('floor:10'), undefined);
        assert.ok(tree('unclassified'));
        assert.equal(tree('building:5').getAttribute('aria-expanded'), 'false');
        await tree('building:5').dispatch('keydown', { key: 'ArrowRight' });
        await select('floor:10');
        assert.deepEqual(dom.get('hierarchy-representative_view_id').options.map(option => option.textContent), ['自動選択（未指定）', '配置図']);
        assert.equal(dom.get('hierarchy-representative-hint').hidden, true);
        await select('view:2');
        assert.equal(dom.get('hierarchy-editor').hidden, true);
        assert.equal(dom.get('view-manager-form').hidden, false);
        assert.equal(dom.get('vm-floor-id').value, '10');
        assert.equal(dom.get('view-delete-btn').textContent.trim(), 'ビューを削除');
        await close();
    });
    await t.test('未分類から所属を適用し、配置・接続を変更せず共通保存に載せる', async () => {
        manager.openViewManager();
        assert.equal(appState.viewManagerFormDirty, false);
        dom.get('vm-floor-id').value = '10'; manager.updateViewManagerFormState();
        assert.equal(appState.viewManagerFormDirty, true);
        await manager.applyViewForm();
        assert.equal(appState.views[0].floor_id, 10);
        assert.equal(requests.at(-1).views[0].view.floor_id, 10);
        assert.deepEqual(appState.placements, []); assert.deepEqual(appState.links, []);
        assert.equal(appState.viewManagerFormDirty, false);
        await manager.closeViewManager();
    });
    await t.test('建物選択からフロアを追加し、選択を維持したまま代表を保存する', async () => {
        manager.openViewManager(); await select('building:5');
        await dom.get('hierarchy-add-floor-btn').onclick();
        assert.equal(dom.get('hierarchy-building_id').value, '5');
        dom.get('hierarchy-name').value = '追加階';
        await dom.get('hierarchy-name').dispatch('input');
        assert.equal(hasHierarchyEditorDraft(), true);
        await submit();
        assert.equal(overlay().hidden, false);
        assert.equal(hasHierarchyEditorDraft(), false);
        assert.equal(tree('floor:12').getAttribute('aria-selected'), 'true');
        await select('floor:10');
        dom.get('hierarchy-representative_view_id').value = '';
        await dom.get('hierarchy-representative_view_id').dispatch('change'); await submit();
        assert.equal(appState.floors.find(row => row.id === 10).representative_view_id, null);
        assert.equal(tree('floor:10').getAttribute('aria-selected'), 'true');
        dom.get('hierarchy-representative_view_id').value = '2';
        await dom.get('hierarchy-representative_view_id').dispatch('change'); await submit();
        assert.equal(appState.floors.find(row => row.id === 10).representative_view_id, 2);
        await close();
    });
    await t.test('未保存ビュー入力があればCRUDを送信せず、競合時も入力を保持する', async () => {
        manager.openViewManager(); await select('building:5');
        const name = dom.get('hierarchy-name'); name.value = '変更後'; await name.dispatch('input');
        appState.viewManagerFormDirty = true;
        const count = requests.length;
        await dom.get('building-hierarchy-form').dispatch('submit'); await settle();
        assert.equal(requests.length, count); assert.equal(name.value, '変更後');
        appState.viewManagerFormDirty = false; failure = true;
        await dom.get('building-hierarchy-form').dispatch('submit'); await settle();
        assert.equal(name.value, '変更後'); assert.equal(appState.buildings[0].name, '本館');
        assert.match(overlay().textContent, /他の操作で更新/);
        assert.equal(hasHierarchyEditorDraft(), true);
        await decide(close, 'cancel'); assert.equal(overlay().hidden, false);
        await decide(() => select('floor:10'), 'cancel'); assert.equal(dom.get('hierarchy-name').value, '変更後');
        const search = dom.get('view-manager-search'); search.value = '存在しない'; manager.renderViewManagerList();
        assert.equal(search.value, ''); assert.ok(tree('building:5'));
        await decide(() => dom.get('hierarchy-add-floor-btn').onclick(), 'cancel'); assert.equal(dom.get('hierarchy-name').value, '変更後');
        await decide(() => tree('building:5').dispatch('keydown', { key: 'ArrowLeft' }), 'cancel'); assert.ok(tree('floor:10'));
        failure = false; await decide(close, 'discard');
        assert.equal(hasHierarchyEditorDraft(), false);
    });
    await t.test('連続submitを一回に制限し、成功後もビューの所属を保持する', async () => {
        manager.openViewManager(); await select('building:5');
        dom.get('hierarchy-name').value = '改称本館'; await dom.get('hierarchy-name').dispatch('input');
        let release;
        releaseRequest = new Promise(resolve => { release = resolve; });
        const count = requests.length;
        await dom.get('building-hierarchy-form').dispatch('submit');
        await dom.get('building-hierarchy-form').dispatch('submit'); await settle();
        assert.equal(requests.length, count + 1);
        release(); releaseRequest = null; await settle();
        assert.equal(appState.buildings[0].name, '改称本館');
        assert.equal(appState.views[0].floor_id, 10);
        assert.deepEqual(buildResourceSave().views, []);
        await close();
    });
    await t.test('階層更新で最新のビュー世代と配置を一緒に取り込み、次の保存で古い配置へ戻さない', async () => {
        const remoteViews = appState.views.map(view => ({ ...view, resource_revision: 20 }));
        const placement = { id: 70, device_id: 80, view_id: 2, x: 987, y: 654 };
        snapshotOverride = { views: remoteViews, devices: [{ id: 80, name: '共有配置機器', type: 'switch', resource_revision: 20 }],
            placements: [placement] };
        manager.openViewManager(); await select('building:5');
        dom.get('hierarchy-name').value = '本館更新'; await dom.get('hierarchy-name').dispatch('input');
        await dom.get('building-hierarchy-form').dispatch('submit'); await settle();
        assert.deepEqual(appState.placements, [placement]);
        const view = appState.views.find(row => row.id === 2);
        assert.equal(view.resource_revision, 20);
        view.name = '配置図更新';
        const operation = buildResourceSave().views.find(row => row.id === 2);
        assert.equal(operation.expected_revision, 20);
        assert.deepEqual(operation.placements, [placement]);
        view.name = '配置図'; await close();
    });
    await t.test('既存ビューを検索して別フロアへ移し、通常の期待世代と配置・接続・メタデータを維持する', async () => {
        snapshotOverride = {};
        const view = appState.views.find(row => row.id === 2);
        view.memo = '保持する備考';
        appState.devices.push(normalizeDevice({ id: 81, name: '接続先', type: 'switch', resource_revision: 20 }));
        appState.placements.push(normalizePlacement({ id: 72, device_id: 81, view_id: 2, x: 321, y: 456 }));
        appState.links = [normalizeLink({ id: 71, from_id: 80, to_id: 81, from_port_id: 95, to_port_id: 96, resource_revision: 1 })];
        appState.devicePorts = [80, 81].map((device_id, index) => ({ id: 95 + index, device_id, name: '1', memo: '', resource_revision: 1 }));
        appState.viewLinkRoutes = [{ view_id: 2, device_a_id: 80, device_b_id: 81, manual_route: [{ x: 250, y: 400 }] }];
        view.show_connections = 0;
        resetResourceBaseline(appState);
        const before = structuredClone({ placements: appState.placements, links: appState.links, rackSettings: appState.rackSettings,
            ports: appState.devicePorts, routes: appState.viewLinkRoutes, notes: appState.canvasNotes, mounts: appState.rackMounts });
        manager.openViewManager(); await select('floor:11');
        assert.match(dom.get('hierarchy-representative-hint').textContent, /物理配置ビューがありません/);
        const toggle = dom.get('hierarchy-attach-toggle');
        assert.equal(toggle.getAttribute('aria-expanded'), 'false');
        assert.equal(dom.get('hierarchy-attach-panel').hidden, true);
        await toggle.click();
        assert.equal(toggle.getAttribute('aria-expanded'), 'true');
        assert.equal(document.activeElement, dom.get('hierarchy-view-search'));
        assert.equal(dom.get('hierarchy-attach-panel').querySelector('.hierarchy-attach-results').children.length, 0);
        const search = dom.get('hierarchy-view-search'); search.value = '配置図'; await search.dispatch('input');
        assert.equal(dom.get('hierarchy-attach-action-2'), null);
        const scope = dom.get('hierarchy-attach-include-assigned');
        scope.checked = true; await scope.dispatch('change');
        assert.equal(hasHierarchyEditorDraft(), false);
        const attach = dom.get('hierarchy-attach-action-2');
        assert.ok(attach);
        assert.equal(attach.textContent, '移動');
        const labelledIds = attach.getAttribute('aria-labelledby').split(' ');
        assert.match(labelledIds.map(id => dom.get(id).textContent).join(' '), /移動 配置図/);
        assert.match(attach.parentElement.textContent, /本館更新 \/ B2 → 本館更新 \/ RF/);
        assert.equal(dom.get('hierarchy-attach-action-3'), null);
        const count = requests.length;
        let confirmation;
        window.confirm = text => { confirmation = text; return false; };
        await attach.click();
        assert.match(confirmation, /配置図.*本館更新 \/ B2.*本館更新 \/ RF/);
        assert.equal(requests.length, count);
        assert.equal(appState.views.find(row => row.id === 2).floor_id, 10);
        window.confirm = () => true;
        await attach.click(); await settle();
        assert.equal(appState.views.find(row => row.id === 2).floor_id, 11);
        assert.equal(appState.views.find(row => row.id === 3).floor_id, 10);
        const request = requests.at(-1).views.find(row => row.id === 2);
        assert.equal(request.expected_revision, 20);
        assert.equal(request.view.floor_id, 11);
        assert.equal(request.view.memo, '保持する備考');
        assert.equal(request.view.show_connections, 0);
        assert.deepEqual(request.placements, before.placements);
        assert.equal(Object.hasOwn(request, 'links'), false);
        assert.deepEqual(request.view_link_routes, before.routes);
        assert.deepEqual({ placements: appState.placements, links: appState.links, rackSettings: appState.rackSettings,
            ports: appState.devicePorts, routes: appState.viewLinkRoutes, notes: appState.canvasNotes, mounts: appState.rackMounts }, before);
        assert.equal(overlay().hidden, false);
        assert.equal(tree('floor:11').getAttribute('aria-selected'), 'true');
        assert.equal(tree('view:2').textContent, '配置図');
        assert.equal(dom.get('hierarchy-attach-toggle').getAttribute('aria-expanded'), 'true');
        assert.equal(dom.get('hierarchy-view-search').value, '配置図');
        assert.equal(dom.get('hierarchy-attach-include-assigned').checked, true);
        assert.equal(document.activeElement, dom.get('hierarchy-view-search'));
        assert.deepEqual(dom.get('hierarchy-representative_view_id').options.map(option => option.textContent), ['自動選択（未指定）', '配置図']);
        assert.equal(dom.get('hierarchy-representative_view_id').value, '');
        assert.match(dom.get('hierarchy-representative-hint').textContent, /「配置図」を自動選択/);
        assert.equal(appState.floors.find(row => row.id === 11).representative_view_id, null);
        dom.get('hierarchy-representative_view_id').value = '2';
        await dom.get('hierarchy-representative_view_id').dispatch('change'); await submit();
        assert.equal(dom.get('hierarchy-representative-hint').hidden, true);
        assert.equal(appState.floors.find(row => row.id === 11).representative_view_id, 2);
        await close();
    });
    await t.test('選択フロアから全種別の新規ビューに所属を継承して通常保存する', async () => {
        for (const type of ['topology', 'floor', 'rack']) {
            manager.openViewManager(); await select('floor:11');
            await manager.addView(type); await settle();
            const view = manager.getViewManagerSelectedView();
            assert.equal(view.view_type, type); assert.equal(view.floor_id, 11);
            assert.equal(dom.get('vm-floor-id').value, '11');
            const saved = await import('../public/js/core/save-queue.js');
            await saved.flushSaveQueue({ silent: true });
            assert.equal(requests.at(-1).views.some(row => row.view.floor_id === 11 && row.view.view_type === type), true);
            await close();
        }
    });
    await t.test('新規建物からフロア・物理ビュー・代表指定まで同じ管理画面で完結する', async () => {
        manager.openViewManager();
        await dom.get('hierarchy-add-building-btn').onclick();
        assert.equal(dom.get('hierarchy-building_view_enabled').checked, false);
        dom.get('hierarchy-name').value = '別館'; await dom.get('hierarchy-name').dispatch('input'); await submit();
        assert.equal(tree('building:6').getAttribute('aria-selected'), 'true');
        assert.equal(appState.buildings.find(row => row.id === 6).building_view_enabled, 0);
        await dom.get('hierarchy-add-floor-btn').onclick();
        assert.equal(dom.get('hierarchy-building_id').value, '6');
        dom.get('hierarchy-name').value = '1F'; await dom.get('hierarchy-name').dispatch('input'); await submit();
        assert.equal(tree('floor:13').getAttribute('aria-selected'), 'true');
        await manager.addView('floor');
        const { flushSaveQueue } = await import('../public/js/core/save-queue.js');
        assert.equal(await flushSaveQueue({ silent: true }), true);
        const view = manager.getViewManagerSelectedView();
        assert.ok(view.id > 0); assert.equal(view.floor_id, 13);
        assert.equal(tree(`view:${view.id}`).getAttribute('aria-selected'), 'true');
        await select('floor:13');
        dom.get('hierarchy-representative_view_id').value = String(view.id);
        await dom.get('hierarchy-representative_view_id').dispatch('change'); await submit();
        assert.equal(appState.floors.find(row => row.id === 13).representative_view_id, view.id);
        assert.equal(overlay().hidden, false); assert.match(tree(`view:${view.id}`).textContent, /（代表）/);
        await close();
    });
    await t.test('建物ビュー設定は適用でだけ保存し、競合時はチェックと他の入力を保持する', async () => {
        manager.openViewManager(); await select('building:5');
        const checkbox = dom.get('hierarchy-building_view_enabled');
        assert.equal(checkbox.checked, true);
        checkbox.checked = false;
        const count = requests.length;
        await checkbox.dispatch('change');
        assert.equal(hasHierarchyEditorDraft(), true);
        assert.equal(requests.length, count);
        const name = dom.get('hierarchy-name');
        name.value += '・建物ビュー設定'; await name.dispatch('input');
        failure = 409;
        await submit();
        assert.equal(checkbox.checked, false);
        assert.equal(dom.get('hierarchy-name'), name);
        assert.match(name.value, /・建物ビュー設定$/);
        assert.equal(hasHierarchyEditorDraft(), true);
        assert.equal(appState.buildings.find(row => row.id === 5).building_view_enabled, 1);
        failure = false;
        await submit();
        assert.equal(appState.buildings.find(row => row.id === 5).building_view_enabled, 0);
        await close();
        manager.openViewManager(); await select('building:5');
        assert.equal(dom.get('hierarchy-building_view_enabled').checked, false);
        await select('floor:10');
        assert.equal(dom.get('hierarchy-building_view_enabled'), null);
        await close();
    });
    await t.test('同名の建物・フロアを作成しても新しいIDを選び、後続登録先を取り違えない', async () => {
        const building = appState.buildings[0];
        const nextBuildingId = Math.max(...appState.buildings.map(row => row.id)) + 1;
        manager.openViewManager();
        await dom.get('hierarchy-add-building-btn').onclick();
        dom.get('hierarchy-name').value = building.name;
        await dom.get('hierarchy-name').dispatch('input'); await submit();
        assert.equal(tree(`building:${nextBuildingId}`).getAttribute('aria-selected'), 'true');
        await dom.get('hierarchy-add-floor-btn').onclick();
        assert.equal(dom.get('hierarchy-building_id').value, String(nextBuildingId));
        await select('floor:10');
        await dom.get('hierarchy-add-floor-btn').onclick();
        const nextFloorId = Math.max(...appState.floors.map(row => row.id)) + 1;
        dom.get('hierarchy-name').value = appState.floors.find(row => row.id === 10).name;
        await dom.get('hierarchy-name').dispatch('input'); await submit();
        assert.equal(tree(`floor:${nextFloorId}`).getAttribute('aria-selected'), 'true');
        await manager.addView('floor');
        const { flushSaveQueue } = await import('../public/js/core/save-queue.js');
        assert.equal(await flushSaveQueue({ silent: true }), true);
        assert.equal(manager.getViewManagerSelectedView().floor_id, nextFloorId);
        await close();
    });
    await t.test('未分類候補の紐付けは選んだビューだけを対象にする', async () => {
        const candidate = normalizeView({ id: 900, name: '所属なし候補', view_type: 'topology', resource_revision: 1 });
        appState.views.push(candidate); resetResourceBaseline(appState);
        manager.openViewManager(); await select('floor:10');
        await dom.get('hierarchy-attach-toggle').click();
        const search = dom.get('hierarchy-view-search'); search.value = candidate.name; await search.dispatch('input');
        assert.equal(hasHierarchyEditorDraft(), false);
        const attach = dom.get('hierarchy-attach-action-900');
        assert.equal(attach.textContent, '紐付け');
        assert.match(attach.parentElement.textContent, /所属なし候補未分類/);
        const count = requests.length;
        window.confirm = () => assert.fail('未分類からの紐付けに移動確認は不要');
        await attach.click(); await settle();
        window.confirm = () => true;
        assert.equal(requests.length, count + 1);
        assert.deepEqual(requests.at(-1).views.map(row => row.id), [900]);
        assert.equal(appState.views.find(row => row.id === 900).floor_id, 10);
        await reveal('view:900');
        assert.equal(tree('view:900').getAttribute('aria-level'), '3');
        assert.equal(dom.get('hierarchy-attach-action-900'), null);
        await close();
    });
    await t.test('フロアを直接開くと代表選択にフォーカスし、複数の物理ビューだけを候補にする', async () => {
        const originalViews = appState.views;
        try {
            appState.views = [...originalViews,
                normalizeView({ id: 910, name: '物理A', floor_id: 10, view_type: 'floor' }),
                normalizeView({ id: 911, name: '物理B', floor_id: 10, view_type: 'floor' })];
            dom.get('view-manager-search').value = '対象階を隠す検索';
            manager.openViewManager({ floorId: 10 }); await settle();
            assert.equal(tree('floor:10').getAttribute('aria-selected'), 'true');
            const select = dom.get('hierarchy-representative_view_id');
            assert.equal(document.activeElement, select);
            assert.deepEqual(select.options.map(option => option.textContent), ['自動選択（未指定）', '物理A', '物理B']);
            assert.match(dom.get('hierarchy-representative-hint').textContent, /複数あります/);
            await close();
        } finally { appState.views = originalViews; }
    });
    await t.test('選択中のフロア・建物の削除は確認後だけ保存し、他の階層とビューを残す', async () => {
        manager.openViewManager();
        await dom.get('hierarchy-add-building-btn').onclick();
        dom.get('hierarchy-name').value = '削除対象建物'; await dom.get('hierarchy-name').dispatch('input'); await submit();
        const buildingId = Math.max(...appState.buildings.map(row => row.id));
        await dom.get('hierarchy-add-floor-btn').onclick();
        dom.get('hierarchy-name').value = '削除対象フロア'; await dom.get('hierarchy-name').dispatch('input'); await submit();
        const floorId = Math.max(...appState.floors.map(row => row.id));
        const views = structuredClone(appState.views);
        const otherBuildings = appState.buildings.filter(row => row.id !== buildingId).map(row => row.id);
        await select(`floor:${floorId}`);
        const removeFloor = dom.get('building-hierarchy-form').querySelectorAll('button').find(button => button.textContent === 'フロアを削除');
        assert.ok(removeFloor);
        window.confirm = () => false;
        const count = requests.length; await removeFloor.click(); await settle();
        assert.equal(requests.length, count);
        assert.ok(appState.floors.some(row => row.id === floorId));
        window.confirm = () => true;
        await removeFloor.click(); await settle();
        assert.equal(requests.at(-1).operation, 'delete_floor');
        assert.equal(requests.at(-1).id, floorId);
        assert.equal(appState.floors.some(row => row.id === floorId), false);
        assert.equal(hasHierarchyEditorDraft(), false);
        await select(`building:${buildingId}`);
        const removeBuilding = dom.get('building-hierarchy-form').querySelectorAll('button').find(button => button.textContent === '建物を削除');
        await removeBuilding.click(); await settle();
        assert.equal(requests.at(-1).operation, 'delete_building');
        assert.equal(requests.at(-1).id, buildingId);
        assert.deepEqual(appState.buildings.map(row => row.id), otherBuildings);
        assert.deepEqual(appState.views, views);
        await close();
    });
    await t.test('建物・フロアの三択で入力を維持・破棄・保存し、選んだビューや階層へだけ切り替える', async () => {
        for (const [key, other, rows, id] of [
            ['building:5', 'floor:10', 'buildings', 5], ['floor:10', 'building:5', 'floors', 10]
        ]) {
            manager.openViewManager(); await select(key);
            await reveal('view:2');
            const original = appState[rows].find(row => row.id === id).name;
            const input = dom.get('hierarchy-name'); input.value = `${original}・入力中`; await input.dispatch('input');
            const count = requests.length;
            await decide(() => select('view:2'), 'cancel');
            assert.equal(dom.get('hierarchy-name'), input);
            assert.equal(input.value, `${original}・入力中`);
            assert.equal(requests.length, count);
            assert.equal(hasHierarchyEditorDraft(), true);
            await decide(() => select('view:2'), 'discard');
            assert.equal(tree('view:2').getAttribute('aria-selected'), 'true');
            assert.equal(appState[rows].find(row => row.id === id).name, original);
            assert.equal(hasHierarchyEditorDraft(), false);
            await select(key);
            dom.get('hierarchy-name').value = `${original}・適用`; await dom.get('hierarchy-name').dispatch('input');
            await decide(() => select(other), 'save');
            assert.equal(appState[rows].find(row => row.id === id).name, `${original}・適用`);
            assert.equal(requests.at(-1).id, id);
            assert.equal(tree(other).getAttribute('aria-selected'), 'true');
            await close();
        }
    });
    await t.test('階層入力のモーダル閉鎖と更新でも同じ三択を使い、適用後だけ保存・再取得する', async () => {
        for (const key of ['building:5', 'floor:10']) {
            manager.openViewManager(); await select(key);
            const original = dom.get('hierarchy-name').value;
            dom.get('hierarchy-name').value = `${original}・閉鎖`; await dom.get('hierarchy-name').dispatch('input');
            await decide(close, 'cancel');
            assert.equal(overlay().hidden, false); assert.equal(hasHierarchyEditorDraft(), true);
            await decide(close, 'save');
            assert.equal(overlay().hidden, true); assert.equal(hasHierarchyEditorDraft(), false);
            manager.openViewManager(); await select(key);
            const saved = dom.get('hierarchy-name').value;
            dom.get('hierarchy-name').value = `${saved}・再取得`; await dom.get('hierarchy-name').dispatch('input');
            const count = requests.length;
            await decide(() => dom.get('hierarchy-refresh-btn').click(), 'cancel');
            assert.equal(requests.length, count);
            assert.equal(dom.get('hierarchy-name').value, `${saved}・再取得`);
            await decide(() => dom.get('hierarchy-refresh-btn').click(), 'save');
            assert.equal(requests.length, count + 2);
            assert.match(requests.at(-2).operation, /^update_/);
            assert.equal(requests.at(-1).operation, 'read');
            assert.equal(dom.get('hierarchy-name').value, `${saved}・再取得`);
            dom.get('hierarchy-name').value = '破棄する入力'; await dom.get('hierarchy-name').dispatch('input');
            await decide(() => dom.get('hierarchy-refresh-btn').click(), 'discard');
            assert.equal(dom.get('hierarchy-name').value, `${saved}・再取得`);
            assert.equal(hasHierarchyEditorDraft(), false);
            dom.get('hierarchy-name').value = '閉鎖時の破棄'; await dom.get('hierarchy-name').dispatch('input');
            await decide(close, 'discard');
            assert.equal(overlay().hidden, true); assert.equal(hasHierarchyEditorDraft(), false);
        }
    });
    await t.test('409・通信失敗の適用では対象を切り替えず入力を保持し、再試行成功後だけ遷移する', async () => {
        for (const [key, status] of [['building:5', 409], ['floor:10', 503]]) {
            manager.openViewManager(); await select(key);
            await reveal('view:2');
            const input = dom.get('hierarchy-name'); input.value = `失敗後に再試行${status}`; await input.dispatch('input');
            failure = status;
            await decide(() => select('view:2'), 'save');
            assert.equal(tree(key).getAttribute('aria-selected'), 'true');
            assert.equal(dom.get('hierarchy-name'), input);
            assert.equal(input.value, `失敗後に再試行${status}`); assert.equal(hasHierarchyEditorDraft(), true);
            failure = false;
            await decide(() => select('view:2'), 'save');
            assert.equal(tree('view:2').getAttribute('aria-selected'), 'true');
            assert.equal(hasHierarchyEditorDraft(), false);
            await close();
        }
    });
    await t.test('確認中・適用送信中の重複操作を進めず、最初の対象へ一回だけ適用する', async () => {
        manager.openViewManager(); await select('building:5');
        await reveal('view:2');
        dom.get('hierarchy-name').value = '単一送信の建物'; await dom.get('hierarchy-name').dispatch('input');
        const pending = select('floor:10'); await settle();
        await select('view:2');
        let release;
        releaseRequest = new Promise(resolve => { release = resolve; });
        const count = requests.length;
        await dom.get('unsaved-changes-save').click(); await settle();
        await select('view:2');
        assert.equal(requests.length, count + 1);
        assert.equal(requests.at(-1).operation, 'update_building');
        assert.equal(tree('building:5').getAttribute('aria-selected'), 'true');
        release(); releaseRequest = null; await pending; await settle();
        assert.equal(tree('floor:10').getAttribute('aria-selected'), 'true');
        assert.equal(appState.buildings.find(row => row.id === 5).name, '単一送信の建物');
        await close();
    });
    await t.test('確認中・保存中の全再読込後に古い対象へ適用したり別フォームを置き換えたりしない', async () => {
        const { eventBus } = await import('../public/js/core/event-bus.js');
        manager.openViewManager(); await select('building:5');
        dom.get('hierarchy-name').value = '古い確認入力'; await dom.get('hierarchy-name').dispatch('input');
        const pending = select('floor:10'); await settle();
        const count = requests.length;
        eventBus.emit('resources:reloaded');
        await dom.get('unsaved-changes-save').click(); await pending;
        assert.equal(requests.length, count); assert.equal(overlay().hidden, true);
        manager.openViewManager(); await select('building:5');
        dom.get('hierarchy-name').value = '古い送信入力'; await dom.get('hierarchy-name').dispatch('input');
        let release;
        releaseRequest = new Promise(resolve => { release = resolve; });
        const transition = select('floor:10'); await settle();
        await dom.get('unsaved-changes-save').click(); await settle();
        eventBus.emit('resources:reloaded');
        manager.openViewManager();
        const input = dom.get('vm-name'); input.value = '別フォームの新入力'; manager.updateViewManagerFormState();
        release(); releaseRequest = null; await transition; await settle();
        assert.equal(dom.get('vm-name'), input); assert.equal(input.value, '別フォームの新入力');
        assert.equal(manager.getViewManagerSelectedView().id, Number(appState.currentViewId));
        assert.equal(appState.viewManagerFormDirty, true);
        assert.equal(hasHierarchyEditorDraft(), false);
        await decide(close, 'discard');
    });
    await t.test('代表図面変更トーストは建物ビュー有効建物の表示対象ビューだけに通知する', async () => {
        const { eventBus } = await import('../public/js/core/event-bus.js');
        const toast = dom.get('toast');
        const targetFloor = { id: 99, building_id: 5, name: '通知検証階', sort_order: 99, representative_view_id: 2, scale: 1, offset_x: 0, offset_y: 0, rotation: 0 };
        appState.floors.push(targetFloor);
        appState.buildings.find(row => row.id === 5).building_view_enabled = 0;
        toast.textContent = ''; toast.hidden = true;
        eventBus.emit('floor-plan:saved', { viewId: 2 });
        assert.equal(toast.textContent, '', '建物ビューOFFの代表図面変更では通知しない');

        appState.buildings.find(row => row.id === 5).building_view_enabled = 1;
        eventBus.emit('floor-plan:saved', { viewId: 2 });
        assert.match(toast.textContent, /建物共通座標への位置合わせを再確認してください/);

        const solePhysical = normalizeView({ id: 950, name: '専用階配置図', view_type: 'floor', floor_id: 99, resource_revision: 1 });
        appState.views.push(solePhysical);
        targetFloor.representative_view_id = null;
        toast.textContent = ''; toast.hidden = true;
        eventBus.emit('floor-plan:saved', { viewId: 950 });
        assert.match(toast.textContent, /建物共通座標への位置合わせを再確認してください/, '代表未指定でも唯一の物理ビューなら通知する');

        const secondPhysical = normalizeView({ id: 951, name: '専用階別図', view_type: 'floor', floor_id: 99, resource_revision: 1 });
        appState.views.push(secondPhysical);
        toast.textContent = ''; toast.hidden = true;
        eventBus.emit('floor-plan:saved', { viewId: 950 });
        assert.equal(toast.textContent, '', '物理ビューが2件以上で代表未指定なら通知しない');
    });
});
