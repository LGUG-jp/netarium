import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { installWorkspaceDom } from './helpers/workspace-dom.mjs';

test('変更履歴モーダルのメニュー位置・閲覧者制限・絞り込み・差分展開・XSS保護・個票/ビュー管理の遷移と未適用保護を確認する', async t => {
    const keys = ['window', 'document', 'Element', 'HTMLElement', 'fetch', 'requestAnimationFrame', 'cancelAnimationFrame'];
    const originals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));

    const dom = installWorkspaceDom({
        phpSetup: "require 'version.php'; $username = 'admin'; $userRole = 'admin'; $isAdmin = true;",
        templates: [
            'templates/components/toolbar.php',
            'templates/components/tool_palette.php',
            'templates/components/canvas.php',
            'templates/components/property_panel.php',
            'templates/components/status_bar.php',
            'templates/components/toast.php',
            'templates/modals/ledger.php',
            'templates/modals/view_manager.php'
        ]
    });

    const create = document.createElement;
    document.createElement = tag => {
        const el = create(tag);
        el.style.setProperty = (key, value) => { el.style[key] = value; };
        return el;
    };
    globalThis.requestAnimationFrame = callback => setTimeout(callback, 0);
    globalThis.cancelAnimationFrame = clearTimeout;

    const { appState, normalizeDevice, normalizeView } = await import('../public/js/core/state.js');
    const { initModalFocusTrap, requestModalClose } = await import('../public/js/core/modal-focus.js');
    const { applyRoleBasedUi } = await import('../public/js/ui/toolbar.js');
    const { resetResourceBaseline } = await import('../public/js/core/resource-save.js');
    const { clearPendingSave, scheduleSave, hasResourceChanges, hasResourceConflict } = await import('../public/js/core/save-queue.js');
    const { discardDeviceDrafts, getDeviceDraft, hasDeviceDraftChanges } = await import('../public/js/core/device-drafts.js');
    const { openChangeHistory, closeChangeHistory } = await import('../public/js/modals/change-history-modal.js');
    const ledgerModal = await import('../public/js/modals/ledger-modal.js');
    const { openLedger, openLedgerDetail, openActiveDeviceHistory } = ledgerModal;
    const {
        openViewManager,
        openSelectedViewHistory,
        applyViewForm,
        updateViewManagerFormState,
        getViewManagerSelectedView
    } = await import('../public/js/modals/view-manager-modal.js');

    initModalFocusTrap();

    t.after(async () => {
        clearPendingSave();
        discardDeviceDrafts();
        closeChangeHistory();
        await setImmediate();
        dom.cleanup?.();
        for (const [key, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    });

    // 1. メニュー位置と非設置領域（左パレット・右パネルには追加しない）の確認
    const menuBtn = document.getElementById('change-history-btn');
    assert.ok(menuBtn, '管理メニューに変更履歴ボタンが存在する');
    assert.equal(menuBtn.previousElementSibling?.id, 'ip-management-btn', 'IPアドレス管理の直下に配置されている');
    assert.ok(menuBtn.classList.contains('admin-only'), 'admin-onlyクラスを持つ');

    const palette = document.getElementById('tool-palette') || document.querySelector('.tool-palette');
    const propPanel = document.getElementById('property-panel');
    assert.equal(palette?.textContent?.includes('変更履歴') ?? false, false, '左操作パレットに変更履歴を追加しない');
    assert.equal(propPanel?.textContent?.includes('変更履歴') ?? false, false, '機器の右情報パネルに変更履歴を追加しない');

    const viewHistoryBtn = document.getElementById('view-history-btn');
    const viewApplyBtn = document.getElementById('view-apply-btn');
    assert.ok(viewHistoryBtn && viewApplyBtn, 'ビュー管理に変更履歴ボタンが存在する');
    assert.equal(viewHistoryBtn.nextElementSibling, viewApplyBtn, 'ビュー管理の「適用」の左に配置されている');

    const sheetHistoryBtn = document.getElementById('ledger-sheet-history-btn');
    assert.ok(sheetHistoryBtn, '機器個票の操作バーに変更履歴ボタンが存在する');

    // モックAPI準備
    const historyRequests = [];
    const saveRequests = [];
    let saveResponseOverride = null;
    let historyResponseBuilder = url => ({
        ok: true,
        items: [
            {
                id: 501,
                event_id: 400,
                request_id: 'abcd1234',
                occurred_at: '2026-10-30T05:00:00Z',
                actor_user_id: 1,
                actor_name: 'admin',
                target_type: 'device',
                target_id: 10,
                target_name: '<img src=x onerror=alert(1)>SW-01',
                target_exists: false,
                view_type: '',
                operation: 'delete',
                summary: '機器を削除（L2スイッチ / 192.0.2.10）',
                items: [
                    { label: '名称', before: '<script>alert(1)</script>', after: '—（削除）' },
                    { label: '管理IP', before: '192.0.2.10', after: '—（削除）' }
                ],
                omitted_count: 3,
                related_targets: [
                    { id: 502, target_type: 'view', target_id: 1, target_name: '全体構成図', target_exists: true, operation: 'update' }
                ],
                related_omitted_count: 0
            }
        ],
        total: 60,
        page: Number(new URL(url, 'http://localhost').searchParams.get('page') || 1),
        per_page: 50,
        total_pages: 2,
        days: Number(new URL(url, 'http://localhost').searchParams.get('days') || 30),
        actors: ['admin', 'operator-a'],
        focused_target: new URL(url, 'http://localhost').searchParams.get('target_id')
            ? {
                target_type: new URL(url, 'http://localhost').searchParams.get('target_type'),
                target_id: Number(new URL(url, 'http://localhost').searchParams.get('target_id')),
                target_name: '対象名テスト',
                target_exists: true,
                view_type: 'rack'
            }
            : null
    });

    globalThis.fetch = async (url, options = {}) => {
        const urlStr = String(url);
        if (urlStr.includes('action=load_change_history')) {
            historyRequests.push(urlStr);
            return new Response(JSON.stringify(historyResponseBuilder(urlStr)), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });
        }
        if (urlStr.includes('action=save_resources')) {
            const payload = JSON.parse(options.body);
            saveRequests.push(payload);
            if (saveResponseOverride) {
                const response = await saveResponseOverride(payload);
                if (response) return response;
            }
            return new Response(JSON.stringify({
                ok: true,
                revision: 20,
                id_maps: {},
                devices: (payload.devices || []).map(row => ({ ...row.device, id: row.id, resource_revision: 15 })),
                views: (payload.views || []).map(row => ({ ...row.view, id: row.id, resource_revision: 25 })),
                placements: (payload.views || []).flatMap(row => row.placements || []),
                links: (payload.views || []).flatMap(row => row.links || []),
                canvas_notes: (payload.views || []).flatMap(row => row.canvas_notes || []),
                rack_settings: (payload.views || []).flatMap(row => row.rack_settings ? [{ ...row.rack_settings, view_id: row.id }] : []),
                rack_mounts: (payload.views || []).flatMap(row => row.rack_mounts || []),
                rack_shelves: (payload.views || []).flatMap(row => row.rack_shelves || []),
                rack_shelf_devices: (payload.views || []).flatMap(row => row.rack_shelf_devices || []),
                floor_rack_placements: (payload.views || []).flatMap(row => row.floor_rack_placements || []),
                affected_view_ids: (payload.views || []).map(row => row.id),
                deleted_device_ids: [], deleted_view_ids: []
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        throw new Error(`Unexpected fetch: ${urlStr}`);
    };

    Object.assign(appState, {
        views: [
            normalizeView({ id: 1, name: '全体構成図', view_type: 'topology', resource_revision: 5 }),
            normalizeView({ id: 2, name: '電算室ラック1', view_type: 'rack', resource_revision: 6 }),
            normalizeView({ id: 3, name: '未確定ビュー', view_type: 'topology', resource_revision: 0 })
        ],
        devices: [
            normalizeDevice({ id: 10, name: 'Core-SW', type: 'switch', ip: '192.0.2.10', resource_revision: 4 }),
            normalizeDevice({ id: 11, name: '未保存機器', type: 'pc', ip: '', resource_revision: 0 })
        ],
        placements: [],
        links: [],
        canvasNotes: [],
        floorPlans: [],
        deviceImages: [],
        rackSettings: [{ view_id: 2, total_u: 42, location: 'A列' }],
        rackMounts: [],
        rackShelves: [],
        rackShelfDevices: [],
        floorRackPlacements: [],
        currentViewId: 1,
        authExpired: false,
        isPinging: false,
        isSaving: false,
        appStatus: { dirty: false, state: 'saved' },
        resourceConflicts: { devices: new Map(), views: new Map() }
    });
    resetResourceBaseline(appState);

    // 2. 閲覧者（viewer）ではメニュー・個票・ビュー管理の導線が非表示で開けない
    window.APP_CONFIG.user = { id: 2, username: 'viewer', role: 'viewer', isAdmin: false };
    applyRoleBasedUi();
    assert.equal(menuBtn.hidden, true);
    assert.equal(sheetHistoryBtn.hidden, true);
    assert.equal(viewHistoryBtn.hidden, true);
    assert.equal(await openChangeHistory(), false);
    assert.equal(await openActiveDeviceHistory(), false);
    assert.equal(await openSelectedViewHistory(), false);
    assert.equal(historyRequests.length, 0, '閲覧者はAPI要求を発行しない');

    // 3. 管理者で全体履歴を開き、初期30日・7/90日切替・ページング・展開・削除済み表示・XSSエスケープを確認
    window.APP_CONFIG.user = { id: 1, username: 'admin', role: 'admin', isAdmin: true };
    applyRoleBasedUi();
    assert.equal(menuBtn.hidden, false);

    assert.equal(await openChangeHistory(), true);
    const overlay = document.getElementById('change-history-overlay');
    assert.ok(overlay && !overlay.hidden);
    assert.equal(historyRequests.length, 1);
    assert.match(historyRequests[0], /days=30/);
    assert.match(historyRequests[0], /page=1/);

    // XSS確認: script/img要素がDOMに注入されず文字列として表示されること
    assert.equal(overlay.querySelector('script'), null);
    assert.equal(overlay.querySelector('img[onerror]'), null);
    assert.match(overlay.querySelector('.change-history-target-name').textContent, /<img src=x onerror=alert\(1\)>SW-01/);
    assert.ok(overlay.querySelector('.change-history-deleted-badge'), '削除済みバッジが表示される');

    // 行展開で変更前→変更後の表と関連対象が表示されること
    const row = overlay.querySelector('.change-history-row');
    const detailRow = overlay.querySelector('.change-history-detail-row');
    assert.equal(detailRow.hidden, true);
    await row.dispatch('click');
    assert.equal(detailRow.hidden, false);
    assert.match(detailRow.textContent, /<script>alert\(1\)<\/script>/);
    assert.match(detailRow.textContent, /保存イベント #400/);
    assert.match(detailRow.textContent, /全体構成図/);

    // 7日・90日切替とページング
    const btn7 = overlay.querySelector('[data-period="7"]');
    const btn90 = overlay.querySelector('[data-period="90"]');
    await btn7.dispatch('click');
    assert.match(historyRequests.at(-1), /days=7/);
    await btn90.dispatch('click');
    assert.match(historyRequests.at(-1), /days=90/);
    const nextBtn = document.getElementById('change-history-next-page');
    assert.equal(nextBtn.disabled, false);
    await nextBtn.dispatch('click');
    assert.match(historyRequests.at(-1), /page=2/);

    closeChangeHistory();
    assert.equal(overlay.hidden, true);

    // 4. 機器台帳の個票からの遷移・未確定ID無効化・未適用編集の保護・戻り動作
    openLedger();
    await openLedgerDetail(11); // 未保存機器 (resource_revision: 0)
    assert.equal(sheetHistoryBtn.disabled, true, '保存前の未確定IDでは履歴ボタンを無効化');
    assert.equal(await openActiveDeviceHistory(), false);

    await openLedgerDetail(10); // 確定済み機器
    assert.equal(sheetHistoryBtn.disabled, false);

    // 未適用の編集がある状態で「変更履歴」を押す → 確認ダイアログが出て「編集を続ける」でキャンセルすると留まり破棄/保存しない
    const draft = getDeviceDraft('sheet', 10);
    draft.location = '未適用の設置場所';
    assert.equal(hasDeviceDraftChanges('sheet', 10), true);

    const navCancelPromise = openActiveDeviceHistory();
    await setImmediate();
    const confirmOverlay1 = document.querySelector('.unsaved-changes-overlay');
    assert.ok(confirmOverlay1, '未適用確認ダイアログが表示される');
    // 「編集を続ける」(cancel) を押す
    const continueBtn1 = Array.from(confirmOverlay1.querySelectorAll('button')).find(b => b.textContent.includes('編集を続ける'));
    await continueBtn1.dispatch('click');
    assert.equal(await navCancelPromise, false);
    assert.equal(overlay.hidden, true, 'キャンセル時は変更履歴を開かない');
    assert.equal(saveRequests.length, 0, '自動保存しない');
    assert.equal(getDeviceDraft('sheet', 10).location, '未適用の設置場所', '未適用編集を自動破棄しない');

    // 今度は未適用確認で「変更を取り消す」を選んで履歴へ遷移し、閉じたら元の個票へ戻る
    const navDiscardPromise = openActiveDeviceHistory();
    await setImmediate();
    const confirmOverlay2 = document.querySelector('.unsaved-changes-overlay');
    const discardBtn = Array.from(confirmOverlay2.querySelectorAll('button')).find(b => b.textContent.includes('変更を取り消す'));
    await discardBtn.dispatch('click');
    assert.equal(await navDiscardPromise, true);
    assert.equal(overlay.hidden, false);
    assert.match(historyRequests.at(-1), /target_type=device/);
    assert.match(historyRequests.at(-1), /target_id=10/);
    assert.equal(document.getElementById('ledger-device-sheet-overlay').hidden, true, '多重表示を避けて親モーダルを一時退避');

    // 対象絞り込みを解除すると全体履歴へ切り替わる
    await document.getElementById('change-history-clear-target-btn').dispatch('click');
    assert.doesNotMatch(historyRequests.at(-1), /target_id=/);

    // Esc閉鎖で元の個票（同じ機器ID=10）に戻る
    await requestModalClose();
    assert.equal(overlay.hidden, true);
    assert.equal(document.getElementById('ledger-device-sheet-overlay').hidden, false, '閉じると元の個票に戻る');
    assert.equal(ledgerModal.activeLedgerDeviceId, 10, '選択中の機器IDが維持される');

    // 対象名クリックは行を展開せず、削除済み対象もIDで絞り込む。
    await openChangeHistory();
    await overlay.querySelector('.change-history-target-name').dispatch('click');
    assert.match(historyRequests.at(-1), /target_id=10/);
    assert.equal(overlay.querySelector('.change-history-detail-row').hidden, true);
    closeChangeHistory();

    const chooseSave = async () => {
        const buttons = document.querySelector('.unsaved-changes-overlay').querySelectorAll('button');
        await Array.from(buttons).find(button => button.textContent.trim() === '適用').dispatch('click');
    };
    // 保存応答待ちは個票に留まり、対象機器のサーバー確定後だけ履歴を取得する。
    getDeviceDraft('sheet', 10).location = '保存成功の場所';
    let releaseSave;
    let markStarted;
    const started = new Promise(resolve => { markStarted = resolve; });
    saveResponseOverride = () => {
        markStarted();
        return new Promise(resolve => { releaseSave = resolve; });
    };
    const beforeSavedHistory = historyRequests.length;
    const savingNavigation = openActiveDeviceHistory();
    await setImmediate();
    await chooseSave();
    await started;
    assert.equal(historyRequests.length, beforeSavedHistory, '保存通信中は履歴を取得しない');
    assert.equal(overlay.hidden, true);
    releaseSave();
    assert.equal(await savingNavigation, true);
    assert.equal(hasResourceChanges('devices', 10), false);
    assert.equal(historyRequests.length, beforeSavedHistory + 1);
    closeChangeHistory();

    // 409・通信断では入力を保持して個票に留まり、履歴APIを呼ばない。
    for (const failure of ['conflict', 'network']) {
        clearPendingSave();
        appState.resourceConflicts = { devices: new Map(), views: new Map() };
        appState.appStatus.state = 'saved';
        resetResourceBaseline(appState);
        discardDeviceDrafts();
        getDeviceDraft('sheet', 10).location = `未保存-${failure}`;
        saveResponseOverride = () => {
            if (failure === 'network') throw new TypeError('通信断のテスト');
            return new Response(JSON.stringify({
                ok: false, error: '対象機器が更新されています',
                details: { conflicts: [{ kind: 'devices', id: 10 }] }
            }), { status: 409, headers: { 'Content-Type': 'application/json' } });
        };
        const beforeFailureHistory = historyRequests.length;
        const failedNavigation = openActiveDeviceHistory();
        await setImmediate();
        await chooseSave();
        assert.equal(await failedNavigation, false);
        assert.equal(overlay.hidden, true);
        assert.equal(document.getElementById('ledger-device-sheet-overlay').hidden, false);
        assert.equal(historyRequests.length, beforeFailureHistory);
        assert.equal(appState.devices.find(device => device.id === 10).location, `未保存-${failure}`);
    }
    clearPendingSave();
    saveResponseOverride = null;
    appState.resourceConflicts = { devices: new Map(), views: new Map() };
    appState.appStatus.state = 'saved';
    resetResourceBaseline(appState);
    discardDeviceDrafts();
    // 予約中の確定入力を履歴操作が勝手に保存せず、個票に留める。
    appState.devices.find(device => device.id === 10).location = 'debounce待機中';
    scheduleSave({ debounceMs: 60000, silent: true });
    const beforeQueuedSave = saveRequests.length;
    assert.equal(await openActiveDeviceHistory(), false);
    assert.equal(saveRequests.length, beforeQueuedSave);
    assert.equal(overlay.hidden, true);
    clearPendingSave();
    resetResourceBaseline(appState);
    saveRequests.length = 0;
    document.getElementById('ledger-device-sheet-overlay').hidden = true;
    document.getElementById('ledger-overlay').hidden = true;

    // 5. ビュー管理（ラックビュー含む）からの遷移・未確定ID無効化・未適用編集の保護・戻り動作
    appState.currentViewId = 3; // 未確定ビュー
    openViewManager();
    assert.equal(viewHistoryBtn.disabled, true, '未確定ビューでは変更履歴ボタンを無効化');
    assert.equal(await openSelectedViewHistory(), false);
    document.getElementById('view-manager-overlay').hidden = true;

    appState.currentViewId = 2; // ラックビュー (ID: 2, resource_revision: 6)
    openViewManager();
    assert.equal(getViewManagerSelectedView()?.id, 2);
    assert.equal(viewHistoryBtn.disabled, false, '保存済みラックビューでは変更履歴ボタンが有効');

    // ビュー管理フォームに未適用入力を入れる
    const vmNameInput = document.getElementById('vm-name');
    vmNameInput.value = '未適用のラック名';
    updateViewManagerFormState();

    // キャンセル時はビュー管理に留まり未適用入力を維持
    const vmCancelPromise = openSelectedViewHistory();
    await setImmediate();
    const vmConfirm1 = document.querySelector('.unsaved-changes-overlay');
    const vmContinueBtn = Array.from(vmConfirm1.querySelectorAll('button')).find(b => b.textContent.includes('編集を続ける'));
    await vmContinueBtn.dispatch('click');
    assert.equal(await vmCancelPromise, false);
    assert.equal(overlay.hidden, true);
    assert.equal(vmNameInput.value, '未適用のラック名', 'ビュー管理の未適用入力が維持される');
    assert.equal(saveRequests.length, 0);

    // 「適用」を選ぶと保存してラックビューの履歴を開き、閉じるとビュー管理の同じラックビューへ戻る
    const vmSavePromise = openSelectedViewHistory();
    await setImmediate();
    const vmConfirm2 = document.querySelector('.unsaved-changes-overlay');
    const vmSaveBtn = Array.from(vmConfirm2.querySelectorAll('button')).find(b => b.textContent.trim() === '適用');
    await vmSaveBtn.dispatch('click');
    assert.equal(await vmSavePromise, true);
    assert.equal(saveRequests.length, 1, '明示的に適用を選んだ場合のみ保存される');
    assert.equal(overlay.hidden, false);
    assert.match(historyRequests.at(-1), /target_type=view/);
    assert.match(historyRequests.at(-1), /target_id=2/);
    assert.equal(document.getElementById('view-manager-overlay').hidden, true);

    closeChangeHistory();
    assert.equal(overlay.hidden, true);
    assert.equal(document.getElementById('view-manager-overlay').hidden, false, '閉じるとビュー管理へ戻る');
    assert.equal(getViewManagerSelectedView()?.id, 2, '選択中のラックビューが維持される');

    // 保存応答前にモデルへ反映されたフォームは未適用入力ではなくなる。
    // 失敗後の再操作も通信中から待っていた遷移も、保存成功とは扱わない。
    for (const failure of ['conflict', 'network']) {
        for (const timing of ['after-failure', 'in-flight']) {
            await t.test(`ビュー履歴: ${failure} / ${timing} は入力を保持して留まる`, async () => {
                clearPendingSave();
                appState.resourceConflicts = { devices: new Map(), views: new Map() };
                appState.appStatus.state = 'saved';
                resetResourceBaseline(appState);
                appState.currentViewId = 1;
                openViewManager();
                const changedName = `未保存ビュー-${failure}-${timing}`;
                vmNameInput.value = changedName;
                updateViewManagerFormState();
                let release;
                let notifyStarted;
                const started = new Promise(resolve => { notifyStarted = resolve; });
                saveResponseOverride = async () => {
                    notifyStarted();
                    await new Promise(resolve => { release = resolve; });
                    if (failure === 'network') throw new TypeError('ビュー保存の通信断テスト');
                    return new Response(JSON.stringify({
                        ok: false, error: 'ビューが更新されています',
                        details: { conflicts: [{ kind: 'views', id: 1 }] }
                    }), { status: 409, headers: { 'Content-Type': 'application/json' } });
                };
                const beforeHistory = historyRequests.length;
                const applying = applyViewForm();
                await started;
                assert.equal(appState.viewManagerFormDirty, false, 'フォームとモデルは既に一致する');
                let navigating;
                if (timing === 'in-flight') {
                    navigating = openSelectedViewHistory();
                    await setImmediate();
                    assert.equal(historyRequests.length, beforeHistory, '保存応答待ちは履歴を取得しない');
                }
                release();
                assert.equal(await applying, false);
                assert.equal(hasResourceChanges('views', 1), true);
                assert.equal(hasResourceConflict('views', 1), failure === 'conflict');
                if (timing === 'after-failure') navigating = openSelectedViewHistory();
                assert.equal(await navigating, false);
                assert.equal(await openSelectedViewHistory(), false, '再操作でも失敗を成功扱いしない');
                assert.equal(historyRequests.length, beforeHistory);
                assert.equal(overlay.hidden, true);
                assert.equal(document.getElementById('view-manager-overlay').hidden, false);
                assert.equal(vmNameInput.value, changedName);
                assert.equal(getViewManagerSelectedView()?.name, changedName);
            });
        }
    }

    for (const nextState of ['new-input', 'auth-expired', 'saved']) {
        await t.test(`ビュー履歴: 保存待機後の ${nextState} を確認する`, async () => {
            clearPendingSave();
            appState.resourceConflicts = { devices: new Map(), views: new Map() };
            appState.appStatus.state = 'saved';
            appState.authExpired = false;
            resetResourceBaseline(appState);
            appState.currentViewId = 1;
            openViewManager();
            vmNameInput.value = `保存するビュー-${nextState}`;
            updateViewManagerFormState();
            let release;
            let notifyStarted;
            const started = new Promise(resolve => { notifyStarted = resolve; });
            saveResponseOverride = async () => {
                notifyStarted();
                await new Promise(resolve => { release = resolve; });
            };
            const beforeHistory = historyRequests.length;
            const applying = applyViewForm();
            await started;
            const navigating = openSelectedViewHistory();
            await setImmediate();
            assert.equal(historyRequests.length, beforeHistory);
            if (nextState === 'new-input') {
                vmNameInput.value = '保存通信中の次の未適用入力';
                updateViewManagerFormState();
            } else if (nextState === 'auth-expired') {
                appState.authExpired = true;
            }
            release();
            await applying;
            assert.equal(await navigating, nextState === 'saved');
            assert.equal(historyRequests.length, beforeHistory + (nextState === 'saved' ? 1 : 0));
            assert.equal(overlay.hidden, nextState !== 'saved');
            assert.equal(document.getElementById('view-manager-overlay').hidden, nextState === 'saved');
            if (nextState === 'new-input') {
                assert.equal(vmNameInput.value, '保存通信中の次の未適用入力');
                assert.equal(appState.viewManagerFormDirty, true);
            }
            appState.authExpired = false;
            if (nextState === 'saved') closeChangeHistory();
        });
    }
});
