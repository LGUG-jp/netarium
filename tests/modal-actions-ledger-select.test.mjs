import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installWorkspaceDom } from './helpers/workspace-dom.mjs';

test('Issue #376: 機器台帳の選択セルのクリック領域と個票抑止、およびモーダル操作ボタン配置', async t => {
    const keys = [
        'window', 'document', 'Element', 'HTMLElement', 'fetch',
        'requestAnimationFrame', 'cancelAnimationFrame', 'localStorage', 'confirm',
        'HTMLInputElement', 'HTMLSelectElement', 'HTMLTextAreaElement', 'HTMLButtonElement'
    ];
    const originals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const dom = installWorkspaceDom({
        templates: [
            'templates/components/canvas.php',
            'templates/components/canvas_context_toolbar.php',
            'templates/components/property_panel.php',
            'templates/modals/view_manager.php',
            'templates/modals/ledger.php',
            'templates/modals/link_systems.php'
        ]
    });

    class FakeInputElement extends globalThis.Element {}
    class FakeSelectElement extends globalThis.Element {}
    class FakeTextAreaElement extends globalThis.Element {}
    class FakeButtonElement extends globalThis.Element {}
    globalThis.HTMLInputElement = FakeInputElement;
    globalThis.HTMLSelectElement = FakeSelectElement;
    globalThis.HTMLTextAreaElement = FakeTextAreaElement;
    globalThis.HTMLButtonElement = FakeButtonElement;

    globalThis.requestAnimationFrame = callback => setTimeout(callback, 0);
    globalThis.cancelAnimationFrame = clearTimeout;
    window.confirm = () => true;

    const { appState, normalizeView, normalizeDevice } = await import('../public/js/core/state.js');
    const resource = await import('../public/js/core/resource-save.js');
    const queue = await import('../public/js/core/save-queue.js');
    const ledger = await import('../public/js/modals/ledger-modal.js');
    const rack = await import('../public/js/canvas/rack-view.js');

    t.after(async () => {
        queue.clearPendingSave();
        ledger.ledgerSelectedDeviceIds.clear();
        await new Promise(resolve => setTimeout(resolve, 0));
        for (const [key, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
        }
    });

    // 1. 機器台帳の先頭選択セルの構造とクリック・ダブルクリック時の個票抑止、および余白クリックによる切替
    await t.test('台帳の先頭選択セルはlabelを内包し、セル余白クリックでチェックを切り替え、個票を開かない', async () => {
        const testDevice = normalizeDevice({ id: 101, name: 'Core-SW-1', type: 'switch', resource_revision: 1 });
        appState.devices = [testDevice];
        appState.views = [normalizeView({ id: 1, name: 'Topology', view_type: 'topology', resource_revision: 1 })];
        appState.currentViewId = 1;
        resource.resetResourceBaseline(appState);

        const row = ledger.createLedgerRow(testDevice);
        const selectCell = row.querySelector('.ledger-sticky-check');
        assert.ok(selectCell, '先頭選択セルが存在する');

        const label = selectCell.querySelector('label.ledger-select-cell-label');
        assert.ok(label, 'label.ledger-select-cell-label が内包されている');

        const checkbox = label.querySelector('input.ledger-row-checkbox');
        assert.ok(checkbox, 'input.ledger-row-checkbox が label 内に存在する');
        assert.equal(checkbox.type, 'checkbox');
        assert.equal(checkbox.checked, false);
        assert.ok(!ledger.ledgerSelectedDeviceIds.has(101));

        // 1. セル余白（target: selectCell、行高が大きい場合の上下余白・左右余白）をクリックしたとき、
        // 伝播が停止し、かつチェックがONになること
        let clickPropagationStopped = false;
        await selectCell.dispatch('click', {
            target: selectCell,
            stopPropagation() { clickPropagationStopped = true; }
        });
        assert.equal(clickPropagationStopped, true, 'tdのclickで伝播が停止する');
        assert.equal(checkbox.checked, true, '余白クリックでcheckboxがONになる');
        assert.ok(ledger.ledgerSelectedDeviceIds.has(101), '選択機器セットにIDが追加される');
        assert.ok(row.classList.contains('ledger-row-selected'), '行に ledger-row-selected クラスが付与される');

        // 2. 再度セル余白をクリックしたとき、チェックがOFFになること
        await selectCell.dispatch('click', { target: selectCell });
        assert.equal(checkbox.checked, false, '再度余白クリックでcheckboxがOFFになる');
        assert.ok(!ledger.ledgerSelectedDeviceIds.has(101), '選択機器セットからIDが削除される');
        assert.ok(!row.classList.contains('ledger-row-selected'), '行の ledger-row-selected クラスが解除される');

        // 3. ダブルクリック時（2回クリック + dblclick）でも伝播が停止し、余計なトグルが発生しないこと
        let dblClickPropagationStopped = false;
        await selectCell.dispatch('click', { target: selectCell }); // 1回目: ON
        assert.equal(checkbox.checked, true);
        await selectCell.dispatch('click', { target: selectCell }); // 2回目: OFF
        assert.equal(checkbox.checked, false);
        await selectCell.dispatch('dblclick', {
            target: selectCell,
            stopPropagation() { dblClickPropagationStopped = true; }
        }); // dblclick: 余計なトグルなし
        assert.equal(dblClickPropagationStopped, true, 'tdのdblclickで伝播が停止する');
        assert.equal(checkbox.checked, false, 'ダブルクリック後も状態が崩れない');
        assert.ok(!ledger.ledgerSelectedDeviceIds.has(101));

        // 4. row の click / dblclick リスナーに selectCell または label を渡しても個票が開かない（早期リターンする）こと
        await row.dispatch('click', { target: selectCell, currentTarget: row });
        await row.dispatch('click', { target: label, currentTarget: row });
        await row.dispatch('dblclick', { target: selectCell, currentTarget: row });
        await row.dispatch('dblclick', { target: label, currentTarget: row });

        // 5. checkbox 本体の change イベント（キーボード Space 等）でも正しく選択状態が切り替わること
        checkbox.checked = true;
        await checkbox.dispatch('change');
        assert.ok(ledger.ledgerSelectedDeviceIds.has(101), 'Space操作で選択機器セットにIDが追加される');
        assert.ok(row.classList.contains('ledger-row-selected'), 'Space操作で行にクラスが付与される');

        checkbox.checked = false;
        await checkbox.dispatch('change');
        assert.ok(!ledger.ledgerSelectedDeviceIds.has(101), 'Space操作で選択機器セットからIDが削除される');
        assert.ok(!row.classList.contains('ledger-row-selected'), 'Space操作で行のクラスが解除される');
    });

    // 2. 接続系統設定のアクションボタン配置
    await t.test('接続系統設定のアクションボタン順序は削除が先頭（左端）、右側にキャンセル・登録/適用が配置される', async () => {
        const actions = dom.get('link-systems-actions');
        assert.ok(actions, 'link-systems-actions が存在する');
        const buttons = actions.querySelectorAll('button');
        const ids = buttons.map(b => b.id);
        assert.deepEqual(ids, ['link-systems-delete', 'link-systems-cancel', 'link-systems-save'],
            'DOM順序が「削除」「キャンセル」「登録」の順である');
    });

    // 3. ラック搭載モーダルのアクションボタン順序
    await t.test('ラック搭載ダイアログのアクションボタン順序はキャンセルが先、ラックへ搭載が右端となる', async () => {
        appState.views = [
            normalizeView({ id: 2, name: '検証ラック', view_type: 'rack', resource_revision: 1 })
        ];
        appState.rackSettings = [{ view_id: 2, total_u: 42, location: 'データセンター' }];
        appState.rackMounts = [];
        appState.currentViewId = 2;
        appState.resourceConflicts = { devices: new Map(), views: new Map() };
        appState.appStatus = { dirty: false, state: 'saved' };
        appState.isSaving = false;
        appState.authExpired = false;
        resource.resetResourceBaseline(appState);

        rack.openRackMountDialog({ viewId: 2, face: 'front', startU: 1 });
        const overlay = document.querySelector('.rack-mount-overlay');
        assert.ok(overlay, 'rack-mount-overlay が存在する');
        const mountActions = overlay.querySelector('.rack-mount-actions');
        assert.ok(mountActions, 'rack-mount-actions が存在する');

        const buttons = mountActions.querySelectorAll('button');
        assert.equal(buttons.length, 2);
        assert.equal(buttons[0].textContent, 'キャンセル', '1番目のボタンがキャンセル');
        assert.match(buttons[1].textContent, /ラックへ搭載|新しい機器を登録/, '2番目のボタンが主操作（右端）');
        await buttons[0].dispatch('click');
        assert.equal(document.querySelector('.rack-mount-overlay'), null, 'キャンセルでダイアログが閉じる');
    });
});
