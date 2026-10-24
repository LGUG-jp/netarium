import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installWorkspaceDom } from './helpers/workspace-dom.mjs';

// 実renderer・選択処理を共有DOMで動かし、保存データではなく表示契約を確認する。
test('接続強調の描画と選択操作', async t => {
    const keys = ['window', 'document', 'Element', 'HTMLElement'];
    const original = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const dom = installWorkspaceDom({ templates: ['templates/components/canvas_context_toolbar.php'] });
    dom.add('span', 'selection-count');
    dom.add('span', 'status-selection-count');
    const storage = new Map();
    window.localStorage = {
        getItem: key => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, value)
    };
    const { appState } = await import('../public/js/core/state.js');
    const settings = await import('../public/js/core/link-display-settings.js');
    const { render, renderLinks } = await import('../public/js/canvas/renderer.js');
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
    const link = (id, from, to, viewId = 1) => ({
        id, view_id: viewId, from_id: from, to_id: to, route_mode: 'auto', manual_route: []
    });
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
            linkSystems: [], canvasNotes: [], floorPlans: [],
            selectedPlacementIds: new Set([1]), editingDeviceId: null, editingLinkId: null,
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
    const group = id => appState.currentSvg.querySelector(`.link-group[data-id="${id}"]`);
    const idsWith = (layer, selector, key) => layer.querySelectorAll(selector)
        .map(node => Number(node.dataset[key])).sort((a, b) => a - b);
    const assertHighlight = (related, dimmedDevices, dimmedLinks) => {
        assert.deepEqual(idsWith(appState.deviceLayer, '.connection-related', 'placementId'), related);
        assert.deepEqual(idsWith(appState.deviceLayer, '.connection-dimmed', 'placementId'), dimmedDevices);
        assert.deepEqual(idsWith(appState.currentSvg, '.link-group.connection-dimmed', 'id'), dimmedLinks);
    };
    const assertNormal = () => assertHighlight([], [], []);
    const assertSourceOne = () => {
        assertHighlight([2, 3], [4, 5, 6], [13]);
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
        assertHighlight([1, 4], [3, 5, 6], [12]);
        replaceSelectedPlacementIds([5]);
        assertHighlight([], [1, 2, 3, 4, 6], [11, 12, 13]);
        assert.equal(device(5).classList.contains('selected'), true, '孤立機器自身は薄くしない');
        replaceSelectedPlacementIds([1]);
        assertSourceOne();
        assert.deepEqual({ devices: appState.devices, placements: appState.placements, links: appState.links }, before);
    });

    await t.test('別ビュー・削除済み端点と無効な選択元は隣接に含めない', () => {
        reset();
        appState.placements = [placement(1), placement(2), placement(3, 3, 2), placement(4), placement(5), placement(6)];
        appState.devices = appState.devices.filter(row => row.id !== 6);
        appState.links.push(link(14, 1, 4, 2), link(15, 1, 6), link(16, 1, 99));
        render();
        assertHighlight([2], [4, 5], [13, 15, 16].filter(id => group(id)));
        assert.equal(device(3), null);
        assert.equal(device(6), null);
        for (const selected of [[3], [6], [999]]) {
            replaceSelectedPlacementIds(selected);
            render();
            assertNormal();
        }
    });

    await t.test('再描画は追加・削除・ビュー移動したリンクと配置の最新状態を使う', () => {
        reset();
        appState.links = [link(14, 4, 1)];
        render();
        assertHighlight([4], [2, 3, 5, 6], []);
        assert.equal(group(11), null);
        appState.placements = appState.placements.map(row => row.id === 4 ? { ...row, view_id: 2 } : row);
        render();
        assertHighlight([], [2, 3, 5, 6], []);
        assert.equal(group(14), null);
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
            appState.links = [link(11, 1, 2), link(12, 3, 4)].map(row => ({ ...row, route_mode: 'manual' }));
            settings.setLinkCrossingStyle(mode);
            settings.setConnectionHighlightEnabled(false);
            render();
            const path = (id, name) => group(id).querySelector(`.${name}`).getAttribute('d');
            const hit = path(12, 'topology-link-hit');
            const visible = path(12, 'topology-link');
            assert.notEqual(visible, hit, '交差表示だけを加工してhit経路は連続させる');
            if (mode === 'bridge') assert.match(visible, /Q/);
            else assert.equal((visible.match(/M/g) || []).length, 2);
            settings.setConnectionHighlightEnabled(true);
            render();
            assertHighlight([2], [3, 4], [12]);
            renderLinks();
            assert.equal(group(12).classList.contains('connection-dimmed'), true);
            assert.equal(path(12, 'topology-link-hit'), hit);
            assert.equal(path(12, 'topology-link'), visible);
            const foreground = () => appState.currentSvg.querySelector('.link-foreground');
            const activePath = () => foreground().querySelector('.link-foreground-path').getAttribute('d');
            assert.equal(foreground().style.display, 'none');
            await group(12).dispatch('pointerenter');
            assert.equal(foreground().style.display, '');
            assert.equal(activePath(), visible);
            assert.equal(foreground().classList.contains('connection-dimmed'), false);
            await group(12).dispatch('pointerleave');
            assert.equal(foreground().style.display, 'none');
            appState.editingLinkId = 12;
            render();
            assertNormal();
            assert.equal(group(12).classList.contains('selected'), true);
            assert.equal(foreground().classList.contains('selected'), true);
            assert.equal(activePath(), visible);
            assert.equal(path(12, 'topology-link-hit'), hit);
            await group(11).dispatch('pointerenter');
            assert.equal(activePath(), path(11, 'topology-link'));
            await group(11).dispatch('pointerleave');
            assert.equal(activePath(), visible, 'hover終了後は選択リンクの前景へ戻す');
            assert.equal(storage.get('netarium.connectionHighlightEnabled'), 'true');
        });
    }
});
