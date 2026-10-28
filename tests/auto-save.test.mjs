import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';

test('共通保存キューと自動保存 (Issue #82) の総合検証', async (t) => {
    const elements = new Map();
    const mockEl = (id = '') => ({
        id,
        value: '', textContent: '', title: '', children: [], hidden: true, disabled: false,
        setAttribute() {}, removeAttribute() {}, getAttribute() { return null; },
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        style: {}, dataset: {},
        appendChild(child) { child.parentElement = this; this.children.push(child); },
        append(...children) { children.forEach(child => this.appendChild(child)); },
        remove() {
            if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
            this.parentElement = null;
        },
        replaceChildren(...children) { this.children = children; },
        contains(element) { return this === element || this.children.some(child => child.contains(element)); },
        querySelector() { return null; }, querySelectorAll() { return []; },
        addEventListener() {}, removeEventListener() {},
        focus() {},
        getBoundingClientRect() {
            return { left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800 };
        }
    });

    const getElement = id => {
        // この保存fixtureには台帳の一覧・フィルターを配置しない。
        if (id === 'ledger-table-body' || (id.startsWith('ledger-') && id.endsWith('-filter'))) return null;
        if (!elements.has(id)) elements.set(id, mockEl(id));
        return elements.get(id);
    };
    getElement('canvas-note-layer');
    for (const id of ['note-background-color', 'note-text-color']) {
        mockEl().append(getElement(id), getElement(`${id}-options`));
    }

    const originalGlobals = new Map(['window', 'document', 'fetch', 'confirm'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    t.after(() => {
        for (const [key, descriptor] of originalGlobals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    });

    t.mock.method(console, 'error', () => {});

    globalThis.window = {
        addEventListener() {}, location: { reload() {} },
        clearTimeout: globalThis.clearTimeout.bind(globalThis),
        setTimeout: globalThis.setTimeout.bind(globalThis),
        APP_CONFIG: { user: { isAdmin: true }, csrfToken: 'test-token' },
    };
    globalThis.document = {
        body: mockEl('body'),
        addEventListener() {},
        getElementById: getElement,
        querySelector: () => null,
        querySelectorAll: () => [],
        createElement: tag => mockEl(tag)
    };

    const view = { id: 1, resource_revision: 1, name: 'フロア1', facility: '本館', floor: '1F', view_type: 'topology', sort_order: 10, memo: '' };
    const device1 = { id: 10, resource_revision: 1, name: 'SW-01', type: 'switch', ip: '192.168.1.1', facility: '本館', floor: '1F' };
    const placement1 = { id: 100, device_id: 10, view_id: 1, x: 100, y: 100 };

    let fetchCalls = [];
    let nextRevision = 2;

    globalThis.fetch = async (url, options) => {
        const actionMatch = url.match(/action=([^&]+)/);
        const action = actionMatch ? actionMatch[1] : '';
        fetchCalls.push({ action, body: options?.body ? JSON.parse(options.body) : null });

        if (action === 'load') {
            return new Response(JSON.stringify({
                revision: 1,
                views: [view],
                devices: [device1],
                placements: [placement1],
                links: [],
                floor_plans: [],
                device_images: []
            }));
        }

        if (action === 'save_resources') {
            const payload = JSON.parse(options.body);
            const savedDevices = [];
            const savedViews = [];
            const idMaps = { devices: {}, views: {}, placements: {}, links: {} };

            for (const dev of payload.devices || []) {
                if (dev.operation === 'create') {
                    const newId = dev.id + 1000;
                    idMaps.devices[dev.id] = newId;
                    savedDevices.push({ ...dev.device, id: newId, resource_revision: 1 });
                } else if (dev.operation === 'update') {
                    savedDevices.push({ ...dev.device, id: dev.id, resource_revision: (dev.expected_revision || 1) + 1 });
                }
            }

            for (const v of payload.views || []) {
                if (v.operation === 'create') {
                    const newId = v.id + 1000;
                    idMaps.views[v.id] = newId;
                    savedViews.push({ ...v.view, id: newId, resource_revision: 1 });
                } else if (v.operation === 'update') {
                    savedViews.push({ ...v.view, id: v.id, resource_revision: (v.expected_revision || 1) + 1 });
                }
            }
            return new Response(JSON.stringify({
                ok: true,
                revision: nextRevision++,
                saved_at: new Date().toISOString(),
                id_maps: idMaps,
                devices: savedDevices,
                views: savedViews,
                placements: [placement1],
                links: [],
                canvas_notes: [],
                deleted_device_ids: payload.devices?.filter(d => d.operation === 'delete').map(d => d.id) || [],
                deleted_view_ids: payload.views?.filter(v => v.operation === 'delete').map(v => v.id) || [],
                affected_view_ids: [1]
            }));
        }

        return new Response(JSON.stringify({ ok: true }));
    };

    await import('../public/js/main.js');
    await setImmediate();

    const state = window.appState;
    assert.equal(state.noteLayer, getElement('canvas-note-layer'), 'メモレイヤーが起動時に初期化される');
    const saveBtn = getElement('saveBtn');

    // 1. 初期ロード後の状態確認 (保存済み、ボタン無効)
    assert.equal(state.appStatus.state, 'saved');
    assert.equal(state.appStatus.dirty, false);
    assert.equal(saveBtn.disabled, true, '保存済み状態では上部保存ボタンは無効');
    const { applyRoleBasedUi } = await import('../public/js/ui/toolbar.js');
    const originalQuerySelectorAll = document.querySelectorAll;
    document.querySelectorAll = selector => selector === '.admin-only'
        ? [saveBtn, getElement('ledger-save-btn'), getElement('ledger-sheet-save-btn')] : [];
    applyRoleBasedUi();
    assert.equal(saveBtn.disabled, true);
    assert.equal(getElement('ledger-save-btn').disabled, true);
    assert.equal(getElement('ledger-sheet-save-btn').disabled, true);
    document.querySelectorAll = originalQuerySelectorAll;

    // 2. 機器属性の自動保存 (Phase 5D-3 & #97 共通インターフェース)
    // 機器名変更を投入
    const beforeAutoSaveToast = getElement('toast').textContent;
    window.saveDeviceProperties(10, { name: 'SW-01-Renamed' }, { immediate: true, silent: true });
    await setImmediate();
    // 非同期プロミス完了を待機
    assert.equal(fetchCalls.filter(f => f.action === 'save_resources').length, 1, '即時flushでsave_resourcesが1回呼ばれること');
    const lastSaveCall = fetchCalls[fetchCalls.length - 1];
    assert.equal(lastSaveCall.action, 'save_resources');
    assert.equal(lastSaveCall.body.devices[0].device.name, 'SW-01-Renamed');
    assert.equal(state.appStatus.state, 'saved');
    assert.equal(saveBtn.disabled, true, '保存完了後は上部保存ボタンが無効に戻ること');
    assert.equal(getElement('toast').textContent, beforeAutoSaveToast, '通常の自動保存成功で通知を増やさない');

    // 3. Debounce保存の検証
    const countBeforeDebounce = fetchCalls.length;
    state.devices.find(device => device.id === 10).memo = '確定済みの追記';
    window.scheduleSave({ debounceMs: 50, immediate: false, silent: true });
    // debounce中
    assert.equal(state.appStatus.state, 'pending');
    assert.equal(saveBtn.disabled, false, 'debounce待機中は上部保存ボタンが有効になること');
    assert.equal(fetchCalls.length, countBeforeDebounce, 'debounce待機中は即座に送信しない');

    // debounce時間を待機
    await new Promise(r => setTimeout(r, 80));
    assert.equal(state.appStatus.state, 'saved');
    assert.equal(saveBtn.disabled, true);
    assert.equal(fetchCalls.at(-1).body.devices[0].device.memo, '確定済みの追記');

    // 4. 直列化 (Serialization): 保存中に発生した追加変更の安全な再保存 (Phase 5D-2)
    // 保存APIに遅延を設けて、保存中に別フィールドの編集を発生させる
    let delayResolve = null;
    const origFetch = globalThis.fetch;
    let deferredSaveCalls = 0;
    let imageUploadCalls = 0;
    globalThis.fetch = async (url, options) => {
        if (url.includes('action=upload_device_image')) {
            imageUploadCalls++;
            if (Number(options.body.get('revision')) !== nextRevision - 1) {
                return new Response(JSON.stringify({ ok: false, error: '画像登録のrevisionが古いです' }), { status: 409 });
            }
            return new Response(JSON.stringify({
                ok: true, revision: nextRevision++,
                images: [{ id: 1, device_id: 10, caption: '' }]
            }));
        }
        if (url.includes('action=save_resources')) {
            deferredSaveCalls++;
            if (deferredSaveCalls === 1) {
                // 1回目のリクエストを遅延させる
                await new Promise(r => { delayResolve = r; });
            }
        }
        return origFetch(url, options);
    };

    // 機器のIP変更を開始 (1回目の保存)
    const targetDev = state.devices.find(d => d.id === 10);
    targetDev.ip = '10.0.0.1';
    window.scheduleSave({ immediate: true, silent: true });
    await new Promise(r => setTimeout(r, 10));

    // 保存実行中
    assert.equal(state.isSaving, true);
    assert.equal(state.appStatus.state, 'saving');

    // 保存中にさらに機器名を再変更 (2回目の変更)
    targetDev.name = 'SW-01-Super';
    window.scheduleSave({ immediate: true, silent: true });

    // 保存中に追加変更があるため保存ボタンは有効
    assert.equal(saveBtn.disabled, false, '保存中に追加変更がある場合は保存ボタンが有効');
    const explicitSave = window.saveData();
    const { uploadDeviceImage } = await import('../public/js/core/device-image-api.js');
    const imageUpload = uploadDeviceImage(10, new Blob(['image'], { type: 'image/png' }));
    await setImmediate();
    assert.equal(imageUploadCalls, 0, '画像登録は進行中の保存が完了するまで送信しない');

    // 1回目の保存を完了させる
    delayResolve();
    assert.equal(await explicitSave, true, '通常の保存通信中も明示保存を未確認扱いで拒否しない');
    const savedAttributeRevision = state.devices.find(device => device.id === 10).resource_revision;
    await imageUpload;
    assert.equal(imageUploadCalls, 1);
    assert.equal(state.deviceImages[0].device_id, 10);
    assert.equal(state.devices.find(device => device.id === 10).resource_revision, savedAttributeRevision);

    assert.equal(state.isSaving, false);
    assert.equal(deferredSaveCalls, 2, '保存中の追加変更によって2回目のsave_resourcesが自動実行されたこと');
    assert.equal(state.devices.find(device => device.id === 10).name, 'SW-01-Super');
    assert.equal(state.devices.find(device => device.id === 10).ip, '10.0.0.1');
    assert.equal(state.appStatus.state, 'saved');
    assert.equal(saveBtn.disabled, true);

    // 5. 409 競合時の挙動 (Phase 5D-1 & 5D-3)
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, error: '機器 SW-01 は他で更新されました' }), { status: 409 });
    const devForConflict = state.devices.find(d => d.id === 10);
    devForConflict.memo = '競合テスト';
    const saveSuccess = await window.flushSaveQueue({ silent: true });
    assert.equal(saveSuccess, false, '409時は保存失敗となること');
    assert.equal(state.appStatus.state, 'conflict');
    assert.equal(saveBtn.disabled, true, '409競合時は上部保存ボタンで強制上書きできないこと');

    // 6. 401 認証失効時の挙動 (Phase 5D-1)
    state.appStatus.state = 'saved';
    const { clearPendingSave } = await import('../public/js/core/save-queue.js');
    clearPendingSave();
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, error: '認証が必要です' }), { status: 401 });
    const devForAuth = state.devices.find(d => d.id === 10);
    devForAuth.memo = '認証切れテスト';
    const authSaveResult = await window.flushSaveQueue({ silent: true });
    assert.equal(authSaveResult, false);
    assert.equal(state.authExpired, true);
    assert.equal(saveBtn.disabled, true, '認証失効時は保存ボタンが無効');
    // 編集内容が失われていないこと
    assert.equal(devForAuth.memo, '認証切れテスト', '認証失効時に入力内容を破棄しないこと');

    // 7. 一時的な通信エラー (503 / 500)
    state.authExpired = false;
    state.appStatus.state = 'saved';
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, error: 'database busy' }), { status: 503 });
    const devForBusy = state.devices.find(d => d.id === 10);
    devForBusy.memo = '一時エラーテスト';
    const busyResult = await window.flushSaveQueue({ silent: true });
    assert.equal(busyResult, false);
    assert.equal(state.appStatus.state, 'unconfirmed');
    assert.notEqual(window.getPendingSave(), null);
    assert.equal(devForBusy.memo, '一時エラーテスト', '通信失敗時に編集内容を失わないこと');
});
test('各操作確定時の自動保存と二重操作解消 (Issue #82)', async (t) => {
    const elements = new Map();
    const mockEl = (id = '') => ({
        id, value: '', textContent: '', title: '', children: [], options: [], hidden: true, disabled: false,
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        style: {}, dataset: {}, appendChild() {}, append() {}, replaceChildren() {},
        remove() {
            if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
            this.parentElement = null;
        },
        querySelector() { return null; }, querySelectorAll() { return []; },
        addEventListener() {}, removeEventListener() {}, setAttribute() {}, removeAttribute() {}, getAttribute() { return null; },
        focus() {},
        contains(element) { return this === element || this.children.includes(element); },
        closest(selector) {
            if (selector === '[hidden], .hidden') return this.hidden ? this : null;
            return null;
        },
    });
    const getElement = id => {
        // この保存fixtureには台帳の一覧・フィルターを配置しない。
        if (id === 'ledger-table-body' || (id.startsWith('ledger-') && id.endsWith('-filter'))) return null;
        if (!elements.has(id)) elements.set(id, mockEl(id));
        return elements.get(id);
    };
    const originalGlobals = new Map(['window', 'document', 'fetch', 'confirm', 'HTMLElement'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    globalThis.HTMLElement = class HTMLElement {};
    t.after(() => {
        for (const [key, descriptor] of originalGlobals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    });

    globalThis.window = {
        clearTimeout: globalThis.clearTimeout.bind(globalThis),
        setTimeout: globalThis.setTimeout.bind(globalThis),
        requestAnimationFrame: cb => setTimeout(cb, 0),
        APP_CONFIG: { user: { isAdmin: true }, csrfToken: 'token' }
    };
    globalThis.document = {
        getElementById: getElement,
        body: mockEl('body'),
        querySelectorAll: () => [],
        createElement: tag => mockEl(tag),
        createElementNS: (ns, tag) => mockEl(tag)
    };
    globalThis.confirm = () => true;

    let saveCalls = [];
    globalThis.fetch = async (url, options) => {
        if (url.includes('action=save_resources')) {
            const body = JSON.parse(options.body);
            saveCalls.push(body);
            const idMaps = { devices: {}, views: {}, placements: {}, links: {} };
            const savedViews = [];
            for (const v of body.views || []) {
                if (v.operation === 'create') {
                    idMaps.views[v.id] = v.id + 100;
                    savedViews.push({ ...v.view, id: v.id + 100, resource_revision: 1 });
                } else {
                    savedViews.push({ ...v.view, id: v.id, resource_revision: (v.expected_revision || 1) + 1 });
                }
                for (const l of v.links || []) {
                    idMaps.links[l.id] = l.id;
                }
            }
            return new Response(JSON.stringify({
                ok: true, revision: 10, saved_at: new Date().toISOString(),
                id_maps: idMaps,
                devices: [], views: savedViews,
                placements: body.views?.[0]?.placements || [],
                links: body.views?.[0]?.links || [],
                canvas_notes: [],
                deleted_device_ids: [], deleted_view_ids: [],
                affected_view_ids: body.views?.map(v => v.id) || []
            }));
        }
        return new Response(JSON.stringify({ ok: true }));
    };

    const { appState } = await import('../public/js/core/state.js');
    const { resetResourceBaseline } = await import('../public/js/core/resource-save.js');
    const { clearPendingSave } = await import('../public/js/core/save-queue.js');
    const { addView, deleteSelectedView, openViewManager, closeViewManager } = await import('../public/js/modals/view-manager-modal.js');
    const { handleLinkModeClick } = await import('../public/js/canvas/renderer.js');

    // 初期状態をセットアップ
    appState.appStatus.state = 'saved';
    appState.appStatus.dirty = false;
    appState.authExpired = false;
    clearPendingSave();
    // 初期状態をセットアップ
    appState.views = [
        { id: 1, name: 'MainView', resource_revision: 1, facility: '', floor: '', view_type: 'topology', sort_order: 10, memo: '' }
    ];
    appState.devices = [
        { id: 1, name: 'D1', type: 'switch', resource_revision: 1 },
        { id: 2, name: 'D2', type: 'router', resource_revision: 1 }
    ];
    appState.placements = [
        { id: 1, device_id: 1, view_id: 1, x: 10, y: 10 },
        { id: 2, device_id: 2, view_id: 1, x: 50, y: 50 }
    ];
    appState.links = [];
    appState.currentViewId = 1;
    appState.nextViewId = 2;
    appState.nextLinkId = 1;
    resetResourceBaseline(appState);

    // 1. 新規ビュー追加 → 即時自動保存されること (上部保存ボタンを押す二重操作不要)
    saveCalls = [];
    addView();
    await setImmediate();
    await new Promise(r => setTimeout(r, 20));
    assert.equal(saveCalls.length, 1, 'ビュー追加で即時save_resourcesが呼ばれること');
    assert.equal(saveCalls[0].views[0].operation, 'create');

    // 2. リンク作成 → 即時自動保存されること (二重操作不要)
    saveCalls = [];
    appState.currentViewId = 1;
    appState.linkMode = true;
    appState.linkSourceId = null;
    appState.linkSourceFixed = false;
    appState.linkSourceConnected = false;
    handleLinkModeClick(appState.devices[0]);
    handleLinkModeClick(appState.devices[1]);
    await setImmediate();
    await new Promise(r => setTimeout(r, 20));
    assert.equal(saveCalls.length, 1, 'リンク作成で即時save_resourcesが呼ばれること');
    assert.equal(appState.links.length, 1);

    // 3. ビュー管理モーダルの開閉 (registerModalOpen/registerModalCloseが正常に動作すること)
    openViewManager();
    const vmOverlay = getElement('view-manager-overlay');
    assert.equal(vmOverlay.hidden, false, 'ビュー管理モーダルが例外なく正常に開くこと');
    closeViewManager();
    await new Promise(r => setTimeout(r, 20));
});
