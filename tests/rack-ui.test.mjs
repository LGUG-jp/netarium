import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installWorkspaceDom } from './helpers/workspace-dom.mjs';

// 実PHPテンプレートを使う代替DOM。実ブラウザーのレイアウト確認とは区別する。
test('ラックの両面表示・範囲選択・背面入力・機器詳細・閲覧権限を実フォームで扱う', async t => {
    const keys = ['window', 'document', 'Element', 'HTMLElement', 'fetch', 'requestAnimationFrame', 'cancelAnimationFrame'];
    const originals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const dom = installWorkspaceDom({ templates: ['templates/components/canvas.php', 'templates/components/canvas_context_toolbar.php', 'templates/components/property_panel.php', 'templates/modals/view_manager.php'] });
    const create = document.createElement;
    const scrollRequests = [];
    document.createElement = tag => {
        const node = create(tag);
        node.style.setProperty = (key, value) => { node.style[key] = value; };
        node.scrollIntoView = () => { scrollRequests.push(node); };
        return node;
    };
    globalThis.requestAnimationFrame = callback => setTimeout(callback, 0);
    globalThis.cancelAnimationFrame = clearTimeout;
    const { appState, normalizeView, normalizeDevice } = await import('../public/js/core/state.js');
    const resource = await import('../public/js/core/resource-save.js');
    const queue = await import('../public/js/core/save-queue.js');
    const rack = await import('../public/js/canvas/rack-view.js');
    t.after(async () => {
        queue.clearPendingSave();
        await new Promise(resolve => setTimeout(resolve, 0));
        for (const [key, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
        }
    });
    const initialMount = { device_id: 1, view_id: 1, face: 'rear', start_u: 1, height_u: 2, width_slot: 'right', depth: 'half' };
    const savedMount = { device_id: 2, view_id: 1, face: 'rear', start_u: 4, height_u: 1, width_slot: 'right', depth: 'half' };
    Object.assign(appState, {
        views: [normalizeView({ id: 1, name: '試験ラック', view_type: 'rack', resource_revision: 10 }), normalizeView({ id: 2, name: '通常構成', resource_revision: 11 })],
        devices: [1, 2].map(id => normalizeDevice({ id, name: `機器${id}`, type: 'switch', resource_revision: id })),
        placements: [{ id: 1, device_id: 1, view_id: 2, x: 10, y: 20 }], links: [], canvasNotes: [], floorPlans: [], deviceImages: [],
        rackSettings: [{ view_id: 1, total_u: 6, location: '東側' }], rackMounts: [initialMount], currentViewId: 1,
        canvas: dom.get('canvas'), world: dom.get('world'), deviceLayer: dom.get('device-layer'), floorPlanLayer: dom.get('floor-plan-layer'), currentSvg: dom.get('link-layer'),
        selectedPlacementIds: new Set(), resourceConflicts: { devices: new Map(), views: new Map() },
        appStatus: { dirty: false, state: 'saved' }, isSaving: false, authExpired: false, editingDeviceId: null
    });
    resource.resetResourceBaseline(appState);
    globalThis.fetch = async () => new Response(JSON.stringify({
        ok: true, revision: 2, id_maps: {}, devices: [], views: [{ ...appState.views[0], resource_revision: 20 }],
        placements: [], links: [], canvas_notes: [], rack_settings: [{ view_id: 1, total_u: 6, location: '東側' }],
        rack_mounts: [initialMount, savedMount], affected_view_ids: [1], deleted_device_ids: [], deleted_view_ids: []
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    rack.renderRackView();
    const root = dom.get('rack-view');
    assert.equal(root.hidden, false);
    assert.equal(dom.get('world').hidden, true);
    assert.equal(root.querySelector('.rack-rear').querySelector('.rack-device').style.gridColumn, '1');
    assert.equal(root.querySelector('.rack-rear').querySelector('.rack-device').style.gridRow, '5 / span 2');
    const scale = root.querySelector('.rack-number-grid').querySelectorAll('span').map(node => node.textContent);
    assert.deepEqual(scale, ['6', '5', '4', '3', '2', '1']);
    assert.equal(root.getAttribute('aria-label'), '試験ラック');
    assert.equal(root.querySelector('.rack-header').querySelector('h2'), null);
    assert.equal(root.querySelector('.rack-face-switch'), null);
    assert.equal(root.querySelectorAll('.rack-number-grid').length, 2);
    assert.ok(root.querySelector('.rack-front'));
    assert.ok(root.querySelector('.rack-rear'));
    assert.deepEqual(resource.buildResourceSave(), { devices: [], views: [] });
    assert.equal(appState.views[0].resource_revision, 10);
    const { eventBus } = await import('../public/js/core/event-bus.js');
    const cell = (face, u, slot = 'left') => root.querySelector(`.rack-${face}`).querySelectorAll('.rack-empty')
        .find(node => node.getAttribute('aria-label') === `${face === 'rear' ? '背面' : '前面'} ${u}U ${slot === 'left' ? '左半分' : '右半分'} 空き`);
    const cancelDialog = async () => {
        const form = document.querySelector('.rack-mount-form');
        await form.querySelectorAll('button').find(node => node.textContent === 'キャンセル').dispatch('click');
    };
    const choose = async query => {
        const search = dom.get('rack-mount-search');
        search.value = query; await search.dispatch('input');
        await search.dispatch('keydown', { key: 'ArrowDown' });
        await search.dispatch('keydown', { key: 'Enter' });
    };
    const submitButton = () => document.querySelector('.rack-mount-actions').querySelector('button[type="submit"]');
    const change = async (name, value) => {
        const node = dom.get(`rack-mount-${name}`); node.value = value; await node.dispatch('input');
    };
    await t.test('コンボボックスの検索・選択解除・上下キー・Escapeと新規登録切替', async () => {
        appState.devices[1].ip = '192.0.2.22';
        rack.openRackMountDialog({ viewId: 1, startU: 3 });
        const search = dom.get('rack-mount-search');
        assert.equal(dom.get('rack-mount-view'), null, '空きセルからは搭載先を固定する');
        await choose('192.0.2.22');
        assert.equal(search.value, '機器2');
        assert.equal(submitButton().disabled, false);
        assert.equal(dom.get('rack-mount-candidates').hidden, true);
        await change('search', '存在しない機器');
        assert.equal(dom.get('rack-mount-candidates').textContent, '該当する機器がありません');
        assert.equal(submitButton().disabled, true, '検索変更で古い選択を保存しない');
        await document.querySelector('.rack-mount-form').dispatch('submit');
        assert.deepEqual(appState.rackMounts, [initialMount]);
        await change('search', '');
        await search.dispatch('keydown', { key: 'ArrowUp' });
        assert.equal(search.getAttribute('aria-activedescendant'), 'rack-mount-option-2');
        await search.dispatch('keydown', { key: 'ArrowUp' });
        assert.equal(search.getAttribute('aria-activedescendant'), 'rack-mount-option-1');
        await search.dispatch('keydown', { key: 'Enter' });
        assert.equal(search.value, '機器1');
        assert.equal(submitButton().textContent, '搭載位置を変更');
        await change('search', '機器');
        assert.ok(dom.get('rack-mount-candidates').textContent.includes('スイッチ'));
        assert.ok(dom.get('rack-mount-candidates').textContent.includes('192.0.2.22'));
        assert.ok(dom.get('rack-mount-candidates').textContent.includes('現在：試験ラック'));
        // 実起動時はdocument captureの共通ショートカットが先にEscapeを処理する。
        const { onKeyDown } = await import('../public/js/canvas/selection.js');
        await onKeyDown({ key: 'Escape', preventDefault() {}, stopImmediatePropagation() {} });
        assert.equal(dom.get('rack-mount-candidates').hidden, true);
        assert.ok(dom.get('rack-mount-title'), '候補だけ閉じ、モーダルを維持する');
        const mode = document.querySelector('.rack-mount-device-area').querySelector('button');
        await mode.dispatch('click');
        assert.equal(dom.get('rack-mount-type').parentElement.parentElement.hidden, false);
        assert.equal(submitButton().textContent, 'ラックへ搭載');
        assert.equal(submitButton().disabled, false);
        await mode.dispatch('click');
        assert.equal(submitButton().disabled, true, '既存機器へ戻しても以前の選択を復活させない');
        await cancelDialog();
    });
    await t.test('範囲と背面左右・奥行き全体の衝突を入力中に検証する', async () => {
        rack.openRackMountDialog({ viewId: 1, face: 'rear', startU: 3, heightU: 3, widthSlot: 'right' });
        await choose('機器2');
        const summary = () => document.querySelector('.rack-mount-summary').textContent;
        const error = () => dom.get('rack-mount-error').textContent;
        assert.ok(summary().includes('背面・左半分 / 3〜5U（3U占有）'));
        await change('start', '1');
        assert.ok(error().includes('背面1Uの左半分は使用中'));
        assert.equal(submitButton().disabled, true);
        assert.equal(summary(), '搭載位置を確認してください。');
        await change('width', 'right');
        assert.equal(error(), '', '反対側ハーフ幅は併設可能');
        await change('width', 'full');
        assert.ok(error().includes('使用中'));
        dom.get('rack-mount-face').value = 'front'; await dom.get('rack-mount-face').dispatch('change');
        await change('depth', 'full');
        assert.equal(submitButton().disabled, true);
        await change('start', '5');
        assert.ok(error().includes('総U数（6U）'));
        await change('height', '1.5');
        assert.ok(error().includes('占有U数は1以上の整数'));
        await change('height', '0');
        assert.ok(error().includes('占有U数は1以上の整数'));
        await change('start', '');
        assert.ok(error().includes('開始Uは1以上の整数'));
        await change('start', '3'); await change('height', '2');
        assert.equal(submitButton().disabled, false);
        appState.resourceConflicts.views.set(1, {});
        await document.querySelector('.rack-mount-form').dispatch('submit');
        assert.ok(error().includes('保存状態が変わりました'));
        assert.deepEqual(appState.rackMounts, [initialMount]);
        appState.resourceConflicts.views.clear(); await cancelDialog();
    });
    await t.test('詳細パネルは現ラックを選択し自機衝突を除外、移設先と現在位置を区別する', async () => {
        appState.views.push(normalizeView({ id: 3, name: '移設先ラック', view_type: 'rack', resource_revision: 30 }));
        appState.rackSettings.push({ view_id: 3, total_u: 4, location: '' });
        rack.openRackMountDialog({ viewId: 1, deviceId: 1 });
        assert.equal(dom.get('rack-mount-view').value, '1');
        assert.equal(dom.get('rack-mount-search').readOnly, true);
        assert.equal(submitButton().disabled, false, '自機の現在位置とは衝突しない');
        assert.equal(submitButton().textContent, '搭載位置を変更');
        await change('view', '3');
        assert.equal(submitButton().textContent, 'ラックへ移設');
        assert.equal(dom.get('rack-mount-title').textContent, '機器をラックへ移設');
        assert.ok(document.querySelector('.rack-mount-current').textContent.includes('現在：試験ラック'));
        assert.ok(document.querySelector('.rack-mount-summary').textContent.includes('移設先：移設先ラック'));
        appState.resourceConflicts.views.set(1, {});
        await document.querySelector('.rack-mount-form').dispatch('submit');
        assert.ok(dom.get('rack-mount-error').textContent.includes('保存状態が変わりました'));
        assert.deepEqual(appState.rackMounts, [initialMount], '元ラック競合時も移設を確定しない');
        appState.resourceConflicts.views.clear();
        window.APP_CONFIG.user.isAdmin = false;
        await document.querySelector('.rack-mount-form').dispatch('submit');
        assert.deepEqual(appState.rackMounts, [initialMount], 'フォームを開いた後の権限変更も確認する');
        window.APP_CONFIG.user.isAdmin = true;
        await change('view', '1');
        assert.equal(submitButton().textContent, '搭載位置を変更');
        assert.ok(document.querySelector('.rack-mount-summary').textContent.includes('同じラック内'));
        await cancelDialog();
        rack.openRackMountDialog({ viewId: 3, face: 'front', startU: 2 });
        await choose('機器1');
        assert.ok(dom.get('rack-mount-title').textContent.includes('移設'));
        assert.equal(dom.get('rack-mount-view'), null, '他ラック搭載済み候補でも空きセルの搭載先は固定');
        assert.ok(document.querySelector('.rack-mount-summary').textContent.includes('移設先ラック'));
        await cancelDialog();
        appState.views.pop(); appState.rackSettings.pop();
        resource.resetResourceBaseline(appState);
    });
    // ラック再描画は注釈面や編集中の入力DOMを切断しない。
    const content = dom.get('rack-content'), notes = dom.get('rack-notes-area');
    const textarea = document.createElement('textarea'); textarea.value = '編集中'; notes.appendChild(textarea); textarea.focus();
    eventBus.emit('rack:changed');
    assert.equal(dom.get('rack-content'), content);
    assert.equal(dom.get('rack-notes-area'), notes);
    assert.equal(textarea.isConnected, true);
    assert.equal(document.activeElement, textarea);
    assert.equal(textarea.value, '編集中');
    // PCドラッグは同じ面・物理スロット内の連続Uを開始/高さへ変換する。
    await cell('front', 3).dispatch('pointerdown', { pointerType: 'mouse', button: 0 });
    await cell('front', 5).dispatch('pointerenter');
    assert.equal(root.querySelectorAll('.rack-range-selected').length, 3);
    await cell('front', 5).dispatch('pointerup', { pointerType: 'mouse' });
    assert.equal(dom.get('rack-mount-title'), null);
    assert.equal(dom.get('canvas-context-toolbar').hidden, false);
    await dom.get('rack-range-mount-btn').dispatch('click');
    assert.equal(dom.get('rack-mount-start').value, '3');
    assert.equal(dom.get('rack-mount-height').value, '3');
    assert.ok(document.querySelector('.rack-mount-form').querySelectorAll('button').some(node => node.textContent === '新しい機器を登録'));
    await cancelDialog();
    // 左右をまたぐ範囲は全幅へ変換し、共通ツールバーで確定する。
    await cell('front', 3).dispatch('pointerdown', { pointerType: 'mouse', button: 0 });
    await cell('front', 5, 'right').dispatch('pointerenter');
    await cell('front', 5, 'right').dispatch('pointerup', { pointerType: 'mouse' });
    assert.equal(root.querySelectorAll('.rack-range-selected').length, 6);
    await dom.get('rack-range-mount-btn').dispatch('click');
    assert.equal(dom.get('rack-mount-width').value, 'full');
    assert.equal(dom.get('rack-mount-start').value, '3');
    assert.equal(dom.get('rack-mount-height').value, '3');
    await cancelDialog();
    const tap = async node => {
        await node.dispatch('pointerdown', { pointerType: 'touch', button: 0 });
        await node.dispatch('pointerup', { pointerType: 'touch' });
        await node.dispatch('click');
    };
    await tap(cell('rear', 3));
    assert.equal(dom.get('rack-mount-title'), null);
    assert.equal(root.querySelectorAll('.rack-range-selected').length, 1);
    await tap(cell('rear', 5));
    assert.equal(dom.get('rack-mount-start').value, '3');
    assert.equal(dom.get('rack-mount-height').value, '3');
    assert.equal(dom.get('rack-mount-width').value, 'left');
    await cancelDialog();
    await tap(cell('front', 6));
    await dom.get('rack-range-mount-btn').dispatch('click');
    assert.equal(dom.get('rack-mount-height').value, '1');
    await cancelDialog();
    await tap(cell('front', 6));
    await dom.get('rack-range-cancel-btn').dispatch('click');
    assert.equal(root.querySelectorAll('.rack-range-selected').length, 0);
    await cell('front', 2).dispatch('keydown', { key: 'Enter' });
    await cell('front', 4).dispatch('keydown', { key: 'Enter' });
    assert.equal(dom.get('rack-mount-start').value, '2');
    assert.equal(dom.get('rack-mount-height').value, '3');
    await cancelDialog();
    await cell('front', 2).dispatch('keydown', { key: 'Enter' });
    await cell('front', 2).dispatch('keydown', { key: 'Escape' });
    assert.equal(root.querySelectorAll('.rack-range-selected').length, 0);
    // 再描画・保存中・競合・ID remapで古いセル/範囲を再利用しない。
    const stale = cell('front', 3);
    await tap(stale); eventBus.emit('rack:changed'); await stale.dispatch('click');
    assert.equal(dom.get('rack-mount-title'), null);
    assert.equal(root.querySelectorAll('.rack-range-selected').length, 0);
    await tap(cell('front', 3));
    appState.isSaving = true; eventBus.emit('save-state:changed');
    assert.equal(root.querySelectorAll('.rack-range-selected').length, 0);
    assert.ok(root.querySelectorAll('.rack-empty').every(node => node.disabled));
    appState.isSaving = false; eventBus.emit('save-state:changed');
    await cell('front', 3).dispatch('click');
    const staleForm = document.querySelector('.rack-mount-form');
    eventBus.emit('resources:ids-remapped', {});
    await staleForm.dispatch('submit');
    assert.equal(dom.get('rack-mount-title'), null);
    assert.deepEqual(appState.rackMounts, [initialMount]);
    appState.resourceConflicts.views.set(1, {});
    eventBus.emit('save-state:changed');
    assert.ok(root.querySelectorAll('.rack-empty').every(node => node.disabled));
    appState.resourceConflicts.views.clear(); eventBus.emit('save-state:changed');
    // 面・幅と奥行き全体の変更も既存の占有判定で重複を拒否する。
    rack.openRackMountDialog({ viewId: 1, face: 'front', startU: 1, heightU: 2, widthSlot: 'left' });
    await choose('機器2');
    dom.get('rack-mount-width').value = 'full';
    dom.get('rack-mount-depth').value = 'full';
    await document.querySelector('.rack-mount-form').dispatch('submit');
    assert.ok(document.querySelector('.rack-mount-form').querySelector('.form-error').textContent.includes('重複'));
    assert.deepEqual(appState.rackMounts, [initialMount]);
    dom.get('rack-mount-face').value = 'rear'; await dom.get('rack-mount-face').dispatch('change');
    dom.get('rack-mount-width').value = 'left';
    await document.querySelector('.rack-mount-form').dispatch('submit');
    assert.ok(document.querySelector('.rack-mount-form').querySelector('.form-error').textContent.includes('重複'));
    dom.get('rack-mount-width').value = 'full';
    await document.querySelector('.rack-mount-form').dispatch('submit');
    assert.ok(document.querySelector('.rack-mount-form').querySelector('.form-error').textContent.includes('重複'));
    await cancelDialog();
    // ビュー変更で開いていたフォームを破棄する。
    await cell('front', 3).dispatch('click');
    const oldForm = document.querySelector('.rack-mount-form');
    appState.currentViewId = 2; rack.renderRackView(); await oldForm.dispatch('submit');
    assert.equal(dom.get('rack-mount-title'), null);
    assert.deepEqual(appState.rackMounts, [initialMount]);
    appState.currentViewId = 1; rack.renderRackView();
    const rearEmpty = root.querySelector('.rack-rear').querySelectorAll('.rack-empty').find(node => node.getAttribute('aria-label') === '背面 4U 左半分 空き');
    await rearEmpty.dispatch('click');
    assert.equal(dom.get('rack-mount-width').value, 'left');
    await choose('機器2');
    await document.querySelector('.rack-mount-form').dispatch('submit');
    assert.equal(await queue.flushSaveQueue({ silent: true }), true);
    assert.equal(appState.views.find(row => row.id === 1).resource_revision, 20);
    assert.deepEqual(appState.rackMounts.find(row => row.device_id === 2), savedMount);
    assert.equal(appState.placements[0].x, 10);
    assert.equal(appState.devices[1].location, '');
    assert.equal(dom.get('rack-mount-title'), null);
    const rearBlock = root.querySelector('.rack-rear').querySelectorAll('.rack-device').find(node => node.textContent.startsWith('機器2'));
    await rearBlock.dispatch('click');
    assert.equal(appState.editingDeviceId, 2);
    assert.equal(dom.get('panel').hidden, false);
    assert.ok(dom.get('rack-position-section'));
    assert.equal(dom.get('rack-position-section').tagName, 'DETAILS');
    dom.get('rack-position-section').open = false;
    rack.renderRackPanel(appState.devices[1]);
    assert.equal(dom.get('rack-position-section').open, false);
    const section = dom.get('rack-position-section');
    assert.equal(section.parentElement.children.indexOf(section) + 1, section.parentElement.children.indexOf(dom.get('p-apply-btn').parentElement));
    assert.ok(section.querySelector('summary').textContent.includes('試験ラック'));
    // 閲覧者は機器を選択できるが、空きセル・搭載変更を使えない。
    window.APP_CONFIG.user.isAdmin = false;
    rack.renderRackView(); rack.renderRackPanel(appState.devices[1]);
    assert.ok(root.querySelectorAll('.rack-empty').every(node => node.disabled));
    assert.equal(dom.get('rack-position-section').querySelectorAll('button').length, 0);
    const before = structuredClone(appState.rackMounts);
    assert.equal(rack.removeRackMount(2), false);
    assert.deepEqual(appState.rackMounts, before);
    appState.currentViewId = 2;
    assert.equal(rack.renderRackView(), false);
    assert.equal(root.hidden, true);
    assert.equal(dom.get('world').hidden, false);
    window.innerWidth = 600;
    assert.equal(root.querySelectorAll('.rack-side').length, 2);
    const { openDirectLink } = await import('../public/js/core/direct-link.js');
    assert.equal(await openDirectLink('?view=1&device=2'), true);
    assert.equal(appState.currentViewId, 1);
    assert.equal(appState.editingDeviceId, 2);
    assert.equal(root.hidden, false);
    assert.ok(root.querySelector('.rack-rear'), '小画面でも背面機器を表示する');
    const revealedRear = scrollRequests.at(-1);
    assert.equal(revealedRear.getAttribute('aria-pressed'), 'true');
    assert.equal(revealedRear.dataset.deviceId, '2');
    appState.rackMounts[0].face = 'front';
    resource.resetResourceBaseline(appState);
    assert.equal(await rack.showRackDevice({ viewId: 1, deviceId: 1 }), true);
    assert.ok(root.querySelector('.rack-front'), '前面機器も常に表示する');
    assert.equal(scrollRequests.at(-1).dataset.deviceId, '1');
    await t.test('搭載機器のUドラッグはプレビューだけを動かし、有効な確定だけ保存する', async () => {
        window.APP_CONFIG.user.isAdmin = true;
        appState.rackMounts = [
            { device_id: 1, view_id: 1, face: 'front', start_u: 1, height_u: 2, width_slot: 'right' },
            { device_id: 2, view_id: 1, face: 'front', start_u: 5, height_u: 1, width_slot: 'full' }
        ];
        resource.resetResourceBaseline(appState); rack.renderRackView();
        let writes = 0;
        globalThis.fetch = async () => {
            writes++;
            return new Response(JSON.stringify({ ok: true, revision: 3, id_maps: {}, devices: [],
                views: [{ ...appState.views[0], resource_revision: 21 }], placements: [], links: [], canvas_notes: [],
                rack_settings: appState.rackSettings, rack_mounts: appState.rackMounts, affected_view_ids: [1],
                deleted_device_ids: [], deleted_view_ids: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        };
        const block = () => root.querySelector('.rack-front').querySelector('[data-device-id="1"]');
        const movingMount = () => appState.rackMounts.find(row => Number(row.device_id) === 1);
        const start = async () => {
            root.querySelector('.rack-front').querySelector('.rack-grid').getBoundingClientRect = () => ({ height: 240, width: 200, left: 0 });
            await block().dispatch('pointerdown', { pointerId: 1, button: 0, clientY: 100, clientX: 150 });
        };
        await start(); await block().dispatch('pointermove', { pointerId: 1, clientY: 20, clientX: 150 });
        assert.equal(movingMount().start_u, 1);
        assert.equal(writes, 0);
        assert.equal(block().style.gridRow, '3 / span 2');
        await block().dispatch('pointerup', { pointerId: 1, clientY: 20, clientX: 150 });
        assert.equal(movingMount().start_u, 3);
        assert.equal(await queue.flushSaveQueue({ silent: true }), true);
        assert.equal(writes, 1);
        assert.deepEqual([movingMount().device_id, movingMount().view_id, movingMount().face, movingMount().height_u, movingMount().width_slot],
            [1, 1, 'front', 2, 'right'], 'U移動で機器・ラック・面・高さ・物理左右を変えない');
        await start(); await block().dispatch('pointermove', { pointerId: 1, clientY: 60, clientX: 150 });
        assert.equal(block().classList.contains('rack-device-invalid'), true);
        await block().dispatch('pointerup', { pointerId: 1, clientY: 60, clientX: 150 });
        assert.equal(movingMount().start_u, 3, '5Uの全幅機器との衝突は拒否');
        await start(); await block().dispatch('pointerup', { pointerId: 1, clientY: 260, clientX: 150 });
        assert.equal(movingMount().start_u, 3, 'ラック範囲外を拒否');
        await start(); await block().dispatch('pointermove', { pointerId: 1, clientY: 180, clientX: 150 });
        appState.resourceConflicts.views.set(1, {});
        await block().dispatch('pointerup', { pointerId: 1, clientY: 180, clientX: 150 });
        assert.equal(movingMount().start_u, 3, 'ドラッグ途中の競合で確定しない');
        appState.resourceConflicts.views.clear();
        await start(); await block().dispatch('pointermove', { pointerId: 1, clientY: 180, clientX: 150 });
        await block().dispatch('pointercancel', { pointerId: 1 });
        assert.equal(movingMount().start_u, 3);
        appState.isSaving = true;
        await start(); await block().dispatch('pointerup', { pointerId: 1, clientY: 180, clientX: 150 });
        appState.isSaving = false;
        window.APP_CONFIG.user.isAdmin = false;
        await start(); await block().dispatch('pointerup', { pointerId: 1, clientY: 180, clientX: 150 });
        window.APP_CONFIG.user.isAdmin = true;
        assert.equal(movingMount().start_u, 3, '保存中・閲覧権限ではドラッグ確定しない');
        await start(); appState.views[0].resource_revision++;
        await block().dispatch('pointerup', { pointerId: 1, clientY: 180, clientX: 150 });
        assert.equal(movingMount().start_u, 3, '開始後にrevisionが変わった場合も確定しない');
        assert.equal(writes, 1);
        // ハーフ幅機器の左右・斜めドラッグ移動
        await start();
        await block().dispatch('pointermove', { pointerId: 1, clientY: 20, clientX: 50 });
        assert.equal(block().style.gridColumn, '1', '左側へドラッグすると1列目プレビュー');
        await block().dispatch('pointerup', { pointerId: 1, clientY: 20, clientX: 50 });
        // 全幅機器はドラッグしても全幅のまま
        const fullBlock = () => root.querySelector('.rack-front').querySelector('[data-device-id="2"]');
        root.querySelector('.rack-front').querySelector('.rack-grid').getBoundingClientRect = () => ({ height: 240, width: 200, left: 0 });
        await fullBlock().dispatch('pointerdown', { pointerId: 2, button: 0, clientY: 40, clientX: 20 });
        await fullBlock().dispatch('pointermove', { pointerId: 2, clientY: 40, clientX: 180 });
        assert.equal(fullBlock().style.gridColumn, '1 / span 2', '全幅機器は左右ドラッグしても全幅維持');
        await fullBlock().dispatch('pointerup', { pointerId: 2, clientY: 40, clientX: 180 });
        assert.equal(appState.rackMounts.find(r => r.device_id === 2).width_slot, 'full');
    });
    await t.test('機器ブロックのシングルクリック・ダブルクリック・Delete取り外し', async () => {
        window.APP_CONFIG.user.isAdmin = true;
        appState.rackMounts = [
            { device_id: 1, view_id: 1, face: 'front', start_u: 1, height_u: 1, width_slot: 'left' }
        ];
        appState.devices[0].status = 'green';
        appState.devices[0].ip = '192.168.1.1';
        resource.resetResourceBaseline(appState); rack.renderRackView();
        const block = root.querySelector('.rack-front').querySelector('[data-device-id="1"]');
        assert.equal(block.querySelector('.rack-device-status-badge')?.textContent, 'OK', 'OKバッジが表示される');
        assert.equal(block.querySelector('.rack-device-name')?.textContent, '機器1', 'ハーフ幅ではIP非表示');
        assert.equal(block.querySelector('.rack-device-ip'), null, '別行IP要素は作成しない');
        assert.equal(block.style.borderColor || '', '', '枠線色は変えない');
        // 全幅機器では1行で名前とIPを表示
        appState.rackMounts[0].width_slot = 'full';
        rack.renderRackView();
        const fullBlock = root.querySelector('.rack-front').querySelector('[data-device-id="1"]');
        assert.equal(fullBlock.querySelector('.rack-device-name')?.textContent, '機器1');
        assert.equal(fullBlock.querySelector('.rack-device-ip-inline')?.textContent, '/ 192.168.1.1', '全幅では一回り小さいIPが1行表示');
        appState.rackMounts[0].width_slot = 'left';
        rack.renderRackView();
        // シングルクリックでパネルが開く
        await block.dispatch('click');
        assert.equal(appState.editingDeviceId, 1);
        assert.equal(block.getAttribute('aria-pressed'), 'true');
        const section = dom.get('rack-position-section');
        assert.ok(section.querySelector('.panel-group-summary-text').textContent.includes('1U'), '単一Uは1Uと1行表示');
        // ダブルクリックで変更モーダルが開く
        await block.dispatch('dblclick');
        assert.equal(dom.get('rack-mount-title')?.textContent, 'ラック搭載位置を変更');
        await cancelDialog();
        // 閲覧権限ではダブルクリックしてもモーダルが開かない
        window.APP_CONFIG.user.isAdmin = false;
        await block.dispatch('dblclick');
        assert.equal(dom.get('rack-mount-title'), null);
        window.APP_CONFIG.user.isAdmin = true;
        block.focus();
        const initialDeviceCount = appState.devices.length;
        const initialPlacementCount = appState.placements.length;
        const { onKeyDown } = await import('../public/js/canvas/selection.js');
        // 確認キャンセル時は取り外されない
        window.confirm = () => false;
        await onKeyDown({ key: 'Delete', isComposing: false, target: block, preventDefault() {}, stopImmediatePropagation() {} });
        assert.equal(appState.rackMounts.length, 1, 'キャンセル時は取り外されない');
        // 確認OK時に取り外される
        window.confirm = () => true;
        await onKeyDown({ key: 'Delete', isComposing: false, target: block, preventDefault() {}, stopImmediatePropagation() {} });
        assert.equal(appState.rackMounts.length, 0, 'rack_mountsから取り外される');
        assert.equal(appState.devices.length, initialDeviceCount, '機器台帳は削除されない');
        assert.equal(appState.placements.length, initialPlacementCount, '通常配置は削除されない');
        assert.equal(appState.editingDeviceId, null, '選択解除される');
    });
    await t.test('検索コンボボックスにフォーカス中の「新しい機器を登録」1回クリック切替', async () => {
        rack.openRackMountDialog({ viewId: 1, startU: 1 });
        const search = dom.get('rack-mount-search');
        search.focus();
        await search.dispatch('focus');
        const modeBtn = document.querySelector('.rack-mount-device-area').querySelectorAll('button').find(b => b.textContent.includes('新しい機器を登録'));
        await modeBtn.dispatch('pointerdown');
        await modeBtn.dispatch('click');
        assert.equal(modeBtn.textContent, '既存機器から選択');
        assert.equal(dom.get('rack-mount-type').parentElement.parentElement.hidden, false);
        await cancelDialog();
    });
});
