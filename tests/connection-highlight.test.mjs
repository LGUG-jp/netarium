import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { installWorkspaceDom } from './helpers/workspace-dom.mjs';

// 実renderer・選択処理を共有DOMで動かし、保存データではなく表示契約を確認する。
test('接続強調の描画と選択操作', async t => {
    const keys = ['window', 'document', 'Element', 'HTMLElement'];
    const original = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const dom = installWorkspaceDom({ templates: [
        'templates/components/canvas_context_toolbar.php',
        'templates/components/property_panel.php',
        'templates/components/link_panel.php'
    ] });
    dom.add('span', 'selection-count');
    dom.add('span', 'status-selection-count');
    const storage = new Map();
    window.localStorage = {
        getItem: key => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, value)
    };
    const { appState } = await import('../public/js/core/state.js');
    const settings = await import('../public/js/core/link-display-settings.js');
    const { render, renderLinks, onCanvasClick } = await import('../public/js/canvas/renderer.js');
    const notes = await import('../public/js/canvas/canvas-notes.js');
    const { DEFAULT_CANVAS_NOTE } = await import('../public/js/core/canvas-note-data.js');
    const { replaceSelectedPlacementIds, beginCanvasRangeSelection } =
        await import('../public/js/canvas/selection.js');
    const initialState = { ...appState };
    t.after(() => {
        appState.cancelActiveRangeSelection?.();
        Object.assign(appState, initialState);
        for (const [key, descriptor] of original) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    });

    const placement = (id, deviceId = id, viewId = 1) => ({
        id, device_id: deviceId, view_id: viewId, x: id * 200, y: 100, width: 20, height: 20
    });
    const link = (id, from, to) => ({ id, from_id: from, to_id: to, resource_revision: 1 });
    const reset = (enabled = true) => {
        window.APP_CONFIG.user.isAdmin = true;
        dom.get('highlight-canvas')?.remove();
        const canvas = dom.add('div', 'highlight-canvas');
        Object.assign(appState, {
            views: [{ id: 1, name: '構成図', view_type: 'topology' }, { id: 2, name: '別ビュー', view_type: 'topology' }],
            currentViewId: 1,
            devices: [1, 2, 3, 4, 5, 6].map(id => ({ id, name: `機器${id}`, type: 'switch', status: 'unknown' })),
            placements: [1, 2, 3, 4, 5, 6].map(id => placement(id)),
            // 1→2、3→1の逆向き接続、2→4の二段目、独立した5・6。
            links: [link(11, 1, 2), link(12, 3, 1), link(13, 2, 4)],
            devicePorts: [], viewLinkRoutes: [], linkSystems: [], canvasNotes: [], floorPlans: [],
            selectedPlacementIds: new Set([1]), editingDeviceId: null, editingLinkId: null, editingLinkGroupKey: null,
            linkMode: false, noteMode: false, isRangeSelecting: false,
            cancelActiveRangeSelection: null, selectedCanvasNoteId: null,
            canvas, world: dom.add('div', 'highlight-world', canvas),
            currentSvg: dom.add('svg', 'highlight-links', canvas),
            deviceLayer: dom.add('div', 'highlight-devices', canvas),
            floorPlanLayer: dom.add('div', 'highlight-floor', canvas),
            selectionBox: dom.add('div', 'highlight-selection', canvas),
            noteLayer: dom.add('div', 'highlight-notes', canvas),
            viewState: { scale: 1, panX: 0, panY: 0, minScale: 0.05, maxScale: 3 }
        });
        settings.setConnectionHighlightEnabled(enabled);
        render();
        replaceSelectedPlacementIds([1]);
    };
    const device = id => appState.deviceLayer.querySelector(`[data-placement-id="${id}"]`);
    const group = key => appState.currentSvg.querySelector(`.link-group[data-display-key="1:${key}"]`);
    const idsWith = (layer, selector, key) => layer.querySelectorAll(selector)
        .map(node => Number(node.dataset[key])).sort((a, b) => a - b);
    const assertHighlight = (related, dimmedDevices, dimmedLinks) => {
        assert.deepEqual(idsWith(appState.deviceLayer, '.connection-related', 'placementId'), related);
        assert.deepEqual(idsWith(appState.deviceLayer, '.connection-dimmed', 'placementId'), dimmedDevices);
        assert.deepEqual(
            appState.currentSvg.querySelectorAll('.link-group.connection-dimmed').map(node => node.dataset.displayKey).sort(),
            dimmedLinks.map(key => `1:${key}`).sort()
        );
    };
    const assertNormal = () => assertHighlight([], [], []);
    const assertSourceOne = () => {
        assertHighlight([2, 3], [4, 5, 6], ['2:4']);
        assert.equal(device(1).classList.contains('selected'), true);
        assert.equal(device(1).classList.contains('connection-related'), false, '選択元は通常の選択表示だけを使う');
    };

    await t.test('初期値OFFと未選択・複数選択は通常表示', () => {
        settings.initializeLinkDisplaySettings();
        assert.equal(settings.getConnectionHighlightEnabled(), false);
        reset(false);
        assertNormal();
        settings.setConnectionHighlightEnabled(true);
        render();
        assertSourceOne();
        replaceSelectedPlacementIds([]);
        assertNormal();
        render();
        assertNormal();
        replaceSelectedPlacementIds([1, 2]);
        assertNormal();
        assert.equal(device(1).classList.contains('selected'), true);
        assert.equal(device(2).classList.contains('selected'), true);
        render();
        assertNormal();
    });

    await t.test('無向の一段隣接だけを強調し、パネル非編集中でも選択変更を即時反映', () => {
        reset();
        assert.equal(appState.editingDeviceId, null);
        assertSourceOne();
        const before = structuredClone({ devices: appState.devices, placements: appState.placements, links: appState.links });
        replaceSelectedPlacementIds([2]);
        assertHighlight([1, 4], [3, 5, 6], ['1:3']);
        replaceSelectedPlacementIds([5]);
        assertHighlight([], [1, 2, 3, 4, 6], ['1:2', '1:3', '2:4']);
        assert.equal(device(5).classList.contains('selected'), true, '孤立機器自身は薄くしない');
        replaceSelectedPlacementIds([1]);
        assertSourceOne();
        assert.deepEqual({ devices: appState.devices, placements: appState.placements, links: appState.links }, before);
    });

    await t.test('クリックで単独・複数・未選択へ切り替えても線と×Nを差し替えない', async () => {
        reset();
        appState.links.push(link(14, 2, 1));
        render();
        const badge = () => appState.currentSvg.querySelector('.link-count-badge[data-display-key="1:1:2"]');
        const svgNodes = () => [group('1:2').querySelector('.topology-link'), badge()];
        const [originalPath, originalBadge] = svgNodes();
        assert.equal(originalBadge.querySelector('.link-label-count').textContent, '×2');
        const assertSelection = (ids, dimmed) => {
            assert.deepEqual(idsWith(appState.deviceLayer, '.device.selected', 'placementId'), ids);
            assert.equal(badge().classList.contains('connection-dimmed'), dimmed);
            const [path, count] = svgNodes();
            assert.ok(path === originalPath, '接続線を再利用する');
            assert.ok(count === originalBadge, '本数バッジを再利用する');
        };

        await device(4).dispatch('click');
        assertHighlight([2], [1, 3, 5, 6], ['1:2', '1:3']);
        assertSelection([4], true);
        await device(1).dispatch('click', { ctrlKey: true });
        assertNormal();
        assertSelection([1, 4], false);
        await device(4).dispatch('click', { shiftKey: true });
        assertSourceOne();
        assertSelection([1], false);
        await device(1).dispatch('click', { metaKey: true });
        assertNormal();
        assertSelection([], false);
        await device(4).dispatch('click');
        assertSelection([4], true);
        await onCanvasClick({ target: appState.canvas });
        assertNormal();
        assertSelection([], false);
        assert.equal(dom.get('panel').hidden, true);
    });

    await t.test('別ビュー・削除済み端点と無効な選択元は隣接に含めない', () => {
        reset();
        appState.placements = [placement(1), placement(2), placement(3, 3, 2), placement(4), placement(5), placement(6)];
        appState.devices = appState.devices.filter(row => row.id !== 6);
        appState.links.push(link(15, 1, 6), link(16, 1, 99));
        render();
        assertHighlight([2], [4, 5], ['2:4', '1:6'].filter(key => group(key)));
        assert.equal(group('1:3'), null);
        assert.equal(group('1:99'), null);
        assert.equal(device(3), null);
        assert.equal(device(6), null);
        for (const selected of [[3], [6], [999]]) {
            replaceSelectedPlacementIds(selected);
            render();
            assertNormal();
        }
    });

    await t.test('数値と文字列の機器 ID を照合し、採番後の描画では新しい機器データを使う', () => {
        reset();
        appState.devices.push({ id: -7, name: '採番前', type: 'switch' });
        appState.placements.push(placement(7, '-7'));
        render();
        assert.equal(device(7).querySelector('.device-name').textContent, '採番前');

        appState.devices = [...appState.devices.slice(0, -1), { id: '70', name: '採番後', type: 'switch' }];
        appState.placements.push(placement(70));
        render();
        assert.equal(device(7), null);
        assert.equal(device(70).querySelector('.device-name').textContent, '採番後');
    });

    await t.test('再描画は接続の追加・削除とビュー間を移動した配置の最新状態を使う', () => {
        reset();
        appState.links = [link(14, 4, 1)];
        render();
        assertHighlight([4], [2, 3, 5, 6], []);
        assert.equal(group('1:2'), null);
        appState.placements = appState.placements.map(row => row.id === 4 ? { ...row, view_id: 2 } : row);
        render();
        assertHighlight([], [2, 3, 5, 6], []);
        assert.equal(group('1:4'), null);
        appState.placements.push(placement(40, 4));
        render();
        assertHighlight([40], [2, 3, 5, 6], []);
        appState.links = [];
        render();
        assertHighlight([], [2, 3, 5, 6, 40], []);
    });

    await t.test('リンクフォーカスと各操作モードは保存設定・選択を変えず強調を一時停止', () => {
        reset();
        const saved = storage.get('netarium.connectionHighlightEnabled');
        assert.equal(saved, 'true');
        for (const [field, active] of [['editingLinkId', 13], ['linkMode', true], ['isRangeSelecting', true], ['noteMode', true]]) {
            appState[field] = active;
            render();
            assertNormal();
            assert.equal(settings.getConnectionHighlightEnabled(), true);
            assert.equal(storage.get('netarium.connectionHighlightEnabled'), saved);
            assert.deepEqual([...appState.selectedPlacementIds], [1]);
            appState[field] = field === 'editingLinkId' ? null : false;
            render();
            assertSourceOne();
        }
    });

    await t.test('実際の矩形選択開始・中止でも再描画なしで強調を停止・復帰', async () => {
        reset();
        await beginCanvasRangeSelection({ pointerId: 7, clientX: 20, clientY: 20, preventDefault() {} });
        assert.equal(appState.isRangeSelecting, true);
        assertNormal();
        await dom.events.dispatch('pointercancel', { pointerId: 7, clientX: 20, clientY: 20 });
        assert.equal(appState.isRangeSelecting, false);
        assertSourceOne();
        assert.equal(settings.getConnectionHighlightEnabled(), true);
    });

    await t.test('メモ作成モードの開始・終了で機器選択の強調が残らない', async () => {
        reset();
        assertSourceOne();
        await notes.toggleCanvasNoteMode();
        assert.equal(appState.noteMode, true);
        assert.equal(appState.selectedPlacementIds.size, 0);
        assert.equal(device(1).classList.contains('selected'), false);
        assert.equal(dom.get('selection-count').textContent, '選択なし');
        assert.equal(dom.get('status-selection-count').textContent, '0選択');
        assertNormal();
        await notes.toggleCanvasNoteMode();
        assert.equal(appState.noteMode, false);
        assertNormal();
        replaceSelectedPlacementIds([1]);
        assertSourceOne();
        assert.equal(storage.get('netarium.connectionHighlightEnabled'), 'true');
    });

    for (const isAdmin of [true, false]) {
        await t.test(`${isAdmin ? '管理者' : '閲覧者'}の既存メモ選択で強調を解除し、終了後も残さない`, async () => {
            reset();
            window.APP_CONFIG.user.isAdmin = isAdmin;
            appState.canvasNotes = [{ ...DEFAULT_CANVAS_NOTE, id: 1, view_id: 1, text: '既存メモ' }];
            render();
            assertSourceOne();
            assert.equal(await notes.selectCanvasNote(1), true);
            assert.equal(appState.selectedCanvasNoteId, 1);
            assert.equal(appState.selectedPlacementIds.size, 0);
            assert.equal(device(1).classList.contains('selected'), false);
            assert.equal(dom.get('selection-count').textContent, '選択なし');
            assert.equal(dom.get('status-selection-count').textContent, '0選択');
            assertNormal();
            notes.finishCanvasNotes();
            assert.equal(appState.selectedCanvasNoteId, null);
            assertNormal();
            replaceSelectedPlacementIds([1]);
            assertSourceOne();
            assert.equal(storage.get('netarium.connectionHighlightEnabled'), 'true');
        });
    }

    for (const mode of ['bridge', 'gap']) {
        await t.test(`${mode}でもhit経路・hover前景・リンク選択の表示契約を維持`, async () => {
            reset();
            const centered = (id, x, y) => ({ ...placement(id), x: x - 10, y: y - 10 });
            appState.placements = [centered(1, 50, -100), centered(2, 50, 100), centered(3, 0, 0), centered(4, 100, 0)];
            appState.links = [link(11, 1, 2), link(12, 3, 4)];
            appState.viewLinkRoutes = [[1, 2], [3, 4]].map(([device_a_id, device_b_id]) => ({
                view_id: 1, device_a_id, device_b_id, manual_route: []
            }));
            settings.setLinkCrossingStyle(mode);
            settings.setConnectionHighlightEnabled(false);
            render();
            const key = id => id === 11 ? '1:2' : '3:4';
            const path = (id, name) => group(key(id)).querySelector(`.${name}`).getAttribute('d');
            const hit = path(12, 'topology-link-hit');
            const visible = path(12, 'topology-link');
            assert.notEqual(visible, hit, '交差表示だけを加工してhit経路は連続させる');
            if (mode === 'bridge') assert.match(visible, /Q/);
            else assert.equal((visible.match(/M/g) || []).length, 2);
            settings.setConnectionHighlightEnabled(true);
            render();
            assertHighlight([2], [3, 4], ['3:4']);
            renderLinks();
            assert.equal(group('3:4').classList.contains('connection-dimmed'), true);
            assert.equal(path(12, 'topology-link-hit'), hit);
            assert.equal(path(12, 'topology-link'), visible);
            const foreground = () => appState.currentSvg.querySelector('.link-foreground');
            const activePath = () => foreground().querySelector('.link-foreground-path').getAttribute('d');
            assert.equal(foreground().style.display, 'none');
            await group('3:4').dispatch('pointerenter');
            assert.equal(foreground().style.display, '');
            assert.equal(activePath(), visible);
            assert.equal(foreground().classList.contains('connection-dimmed'), false);
            await group('3:4').dispatch('pointerleave');
            assert.equal(foreground().style.display, 'none');
            appState.editingLinkId = 12;
            render();
            assertNormal();
            assert.equal(group('3:4').classList.contains('selected'), true);
            assert.equal(foreground().classList.contains('selected'), true);
            assert.equal(activePath(), visible);
            assert.equal(path(12, 'topology-link-hit'), hit);
            await group('1:2').dispatch('pointerenter');
            assert.equal(activePath(), path(11, 'topology-link'));
            await group('1:2').dispatch('pointerleave');
            assert.equal(activePath(), visible, 'hover終了後は選択リンクの前景へ戻す');
            assert.equal(storage.get('netarium.connectionHighlightEnabled'), 'true');
        });
    }

    await t.test('同じペアの複数明細は1本の図形で強調し、×Nと中立色または共通色を表示する', async () => {
        reset();
        appState.links[0].system_id = 1;
        appState.links.push({ ...link(14, 2, 1), system_id: 2, label: '個別接続のラベル' });
        appState.linkSystems = [{ id: 1, color_key: 'teal' }, { id: 2, color_key: 'teal' }];
        render();
        assertSourceOne();
        assert.equal(appState.currentSvg.querySelectorAll('.link-group').length, 3);
        const badge = appState.currentSvg.querySelector('.link-count-badge[data-display-key="1:1:2"]');
        assert.equal(badge.querySelector('.link-label-count').textContent, '×2');
        assert.ok(badge.querySelector('rect'));
        assert.equal(badge.classList.contains('connection-dimmed'), false);
        const path = () => group('1:2').querySelector('.topology-link');
        assert.equal(path().style.stroke, 'var(--link-system-teal, #167D8D)');
        const foreground = () => appState.currentSvg.querySelector('.link-foreground');
        const activePath = () => foreground().querySelector('.link-foreground-path').getAttribute('d');
        await group('1:2').dispatch('pointerenter');
        assert.equal(activePath(), path().getAttribute('d'));
        await group('1:2').dispatch('pointerleave');
        assert.equal(foreground().style.display, 'none');
        appState.linkSystems[1].color_key = 'indigo';
        renderLinks();
        assert.equal(path().style.stroke, 'var(--link-default-color, rgba(71,85,105,.72))');
        appState.editingLinkGroupKey = '1:1:2';
        render();
        assertNormal();
        assert.equal(group('1:2').classList.contains('selected'), true);
        assert.equal(path().style.stroke, 'var(--primary)');
        appState.editingLinkGroupKey = null;
        appState.editingLinkId = 14;
        renderLinks();
        assert.equal(group('1:2').classList.contains('selected'), true);
        assert.equal(foreground().classList.contains('selected'), true);
        assert.equal(activePath(), path().getAttribute('d'));
    });

    await t.test('接続の経路をプレビュー中に機器を選ぶと保存済み経路と通常の線色に戻る', async () => {
        reset();
        const { eventBus } = await import('../public/js/core/event-bus.js');
        const editor = await import('../public/js/canvas/link-route-editor.js');
        const off = eventBus.on('canvas:render-links', renderLinks);
        t.after(off);
        editor.initLinkRouteEditor();
        appState.viewLinkRoutes = [{ view_id: 1, device_a_id: 1, device_b_id: 2, manual_route: [] }];
        render();
        const path = () => group('1:2').querySelector('.topology-link-hit');
        const savedPath = path().getAttribute('d');
        await path().dispatch('click');
        assert.equal(group('1:2').classList.contains('selected'), true);
        editor.startLinkRouteEdit();
        const segment = appState.currentSvg.querySelector('[data-route-segment="0"]');
        await segment.dispatch('pointerdown', { button: 0, pointerId: 7, clientX: 0, clientY: 0 });
        await dom.events.dispatch('pointermove', { pointerId: 7, clientX: 0, clientY: 40 });
        assert.notEqual(path().getAttribute('d'), savedPath);

        await device(1).dispatch('click');
        assert.equal(dom.get('link-panel').hidden, true);
        assert.equal(group('1:2').classList.contains('selected'), false);
        assert.equal(appState.currentSvg.querySelector('.link-route-editor'), null);
        assert.equal(appState.currentSvg.hasPointerCapture(7), false);
        assert.equal(path().getAttribute('d'), savedPath);
        assertSourceOne();
    });

    await t.test('未適用の機器編集を適用して余白クリックで閉じるとキャンバス表示を即時更新する', async t => {
        const { clearPendingSave, waitForActiveResourceSave } = await import('../public/js/core/save-queue.js');
        const { resetResourceBaseline } = await import('../public/js/core/resource-save.js');
        const originalFetch = globalThis.fetch;
        const originalStatus = appState.appStatus;
        const response = Promise.withResolvers();
        const requests = [];
        t.after(async () => {
            // 後始末では応答反映を無効にしてから、保留した通信と保存キューを終了する。
            clearPendingSave();
            response.resolve(new Response('{"ok":true}'));
            try {
                await waitForActiveResourceSave();
            } finally {
                globalThis.fetch = originalFetch;
                appState.appStatus = originalStatus;
            }
        });
        reset();
        appState.devices[0].resource_revision = 1;
        appState.appStatus = { dirty: false, state: 'saved', lastSavedAt: null, lastMonitoredAt: null, lastError: null };
        resetResourceBaseline(appState);
        globalThis.fetch = (url, options) => {
            requests.push({ url, payload: JSON.parse(options.body) });
            return response.promise;
        };

        await device(1).dispatch('click');
        assert.equal(dom.get('panel').hidden, false);
        dom.get('p-name').value = '更新後の機器1';
        await dom.get('p-name').dispatch('input');

        const closing = onCanvasClick({ target: appState.canvas });
        const applying = dom.get('unsaved-changes-save').dispatch('click');
        const closedBeforeResponse = await Promise.race([
            Promise.all([applying, closing]).then(() => true),
            setImmediate(false)
        ]);
        assert.equal(requests.length, 1, '保存要求を送信している');
        assert.match(requests[0].url, /[?&]action=save_resources(?:&|$)/);
        const [operation] = requests[0].payload.devices;
        assert.equal(operation.expected_revision, 1);
        assert.equal(operation.device.name, '更新後の機器1');
        assert.equal(closedBeforeResponse, true, '保存応答を待たずにパネルを閉じる');
        assert.equal(dom.get('panel').hidden, true);
        assert.equal(appState.selectedPlacementIds.size, 0);
        assert.equal(device(1).querySelector('.device-name').textContent, '更新後の機器1');
        assertNormal();
    });
});
