import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { installWorkspaceDom } from './helpers/workspace-dom.mjs';

const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
};

test('Issue #431: 画像操作後の機器resource_revision同期・保存キュー直列化・下書き保持・競合保護', async t => {
    const keys = [
        'window', 'document', 'Element', 'HTMLElement', 'HTMLInputElement',
        'HTMLSelectElement', 'HTMLTextAreaElement', 'HTMLButtonElement',
        'localStorage', 'fetch', 'confirm', 'requestAnimationFrame', 'cancelAnimationFrame'
    ];
    const originals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const dom = installWorkspaceDom({
        templates: [
            'templates/components/property_panel.php',
            'templates/modals/ledger.php',
            'templates/components/status_bar.php',
            'templates/components/toolbar.php',
            'templates/components/toast.php'
        ],
        phpSetup: "define('NETARIUM_VERSION', '1.3.0'); $currentUser = ['username' => 'admin', 'role' => 'admin']; $username = 'admin'; $userRole = 'admin'; $csrfToken = 'test-token'; $isAdmin = true;"
    });
    class Input extends globalThis.Element {}
    globalThis.HTMLInputElement = globalThis.HTMLSelectElement = globalThis.HTMLTextAreaElement = globalThis.HTMLButtonElement = Input;
    globalThis.localStorage = { getItem: () => null, setItem() {} };
    globalThis.requestAnimationFrame = callback => setTimeout(callback, 0);
    globalThis.cancelAnimationFrame = clearTimeout;
    window.confirm = globalThis.confirm = () => true;
    t.mock.method(console, 'error', () => {});

    const { appState, normalizeDevice, normalizeView } = await import('../public/js/core/state.js');
    const { eventBus } = await import('../public/js/core/event-bus.js');
    const resources = await import('../public/js/core/resource-save.js');
    const drafts = await import('../public/js/core/device-drafts.js');
    const queue = await import('../public/js/core/save-queue.js');
    const panels = await import('../public/js/ui/property-panel.js');
    const ledger = await import('../public/js/modals/ledger-modal.js');
    const { saveData } = await import('../public/js/ui/toolbar.js');
    const {
        uploadDeviceImageFile,
        deleteDeviceImage,
        reorderDeviceImages,
        updateImageCaption
    } = await import('../public/js/ui/device-images.js');
    const {
        uploadDeviceImage,
        deleteDeviceImageRequest,
        updateDeviceImagesRequest
    } = await import('../public/js/core/device-image-api.js');

    await dom.events.dispatch('DOMContentLoaded');

    let serverDataRevision;
    let serverDevice;
    let serverDevice2;
    let serverImages;
    let nextImageId;
    let configRevision;
    let configItems;
    let requests;
    let nextGate;
    let rejectNextImageWith409;
    let rejectNextSaveWith409;
    let skipServerDeviceRevisionCheck;
    let forcedPreviousDeviceRevision;

    const getServerDevice = id => (Number(id) === 2 ? serverDevice2 : serverDevice);
    const setServerDevice = dev => {
        if (Number(dev.id) === 2) serverDevice2 = dev;
        else serverDevice = dev;
    };

    const resetScenario = async ({ includeSecondDevice = false } = {}) => {
        queue.clearPendingSave();
        drafts.discardDeviceDrafts();
        await ledger.closeLedgerDetailPane();
        panels.closePanel();

        serverDataRevision = 10;
        serverDevice = normalizeDevice({
            id: 1, resource_revision: 5, name: 'SW-Core', type: 'switch',
            ip: '192.0.2.10', facility: '本館', floor: '1F', memo: '初期メモ'
        });
        serverDevice2 = normalizeDevice({
            id: 2, resource_revision: 5, name: 'SW-Edge', type: 'switch',
            ip: '192.0.2.20', facility: '本館', floor: '2F', memo: '初期メモ2'
        });
        serverImages = [];
        nextImageId = 101;
        configRevision = 1;
        configItems = [];
        requests = [];
        nextGate = new Map();
        rejectNextImageWith409 = false;
        rejectNextSaveWith409 = false;
        skipServerDeviceRevisionCheck = false;
        forcedPreviousDeviceRevision = undefined;

        Object.assign(appState, {
            devices: includeSecondDevice
                ? [structuredClone(serverDevice), structuredClone(serverDevice2)]
                : [structuredClone(serverDevice)],
            views: [normalizeView({ id: 1, resource_revision: 1, name: 'フロア1', view_type: 'topology' })],
            currentViewId: 1,
            editingDeviceId: null,
            editingLinkId: null,
            placements: [],
            links: [],
            canvasNotes: [],
            floorPlans: [],
            deviceImages: [],
            floorRackPlacements: [],
            rackSettings: [],
            rackMounts: [],
            rackShelves: [],
            rackShelfDevices: [],
            selectedPlacementIds: new Set(),
            resourceConflicts: { devices: new Map(), views: new Map() },
            appStatus: { state: 'saved', dirty: false, lastError: null, lastSavedAt: null },
            dataRevision: serverDataRevision,
            authExpired: false,
            isPinging: false,
            isSaving: false
        });
        window.APP_CONFIG.user = { role: 'admin', isAdmin: true };
        resources.resetResourceBaseline(appState);

        globalThis.fetch = async (url, options = {}) => {
            const action = new URL(String(url), 'http://localhost').searchParams.get('action');
            const parsedBody = options.body instanceof FormData
                ? Object.fromEntries(options.body.entries())
                : options.body ? JSON.parse(options.body) : null;
            requests.push({ action, body: parsedBody });

            if (nextGate.has(action)) {
                const gate = nextGate.get(action);
                nextGate.delete(action);
                await gate.promise;
            }

            if (action === 'load') {
                const devices = includeSecondDevice
                    ? [structuredClone(serverDevice), structuredClone(serverDevice2)]
                    : [structuredClone(serverDevice)];
                return new Response(JSON.stringify({
                    revision: serverDataRevision,
                    devices,
                    views: structuredClone(appState.views),
                    placements: [], links: [], canvas_notes: [], floor_plans: [],
                    device_images: structuredClone(serverImages)
                }));
            }

            if (action === 'save_resources') {
                if (rejectNextSaveWith409) {
                    rejectNextSaveWith409 = false;
                    return new Response(JSON.stringify({
                        ok: false,
                        error: '他で更新されました',
                        conflicts: [{ kind: 'devices', id: 1, name: serverDevice.name }]
                    }), { status: 409 });
                }
                const savedDevices = [];
                const conflicts = [];
                for (const devOp of parsedBody.devices || []) {
                    const target = getServerDevice(devOp.id);
                    if (Number(devOp.expected_revision) !== Number(target.resource_revision)) {
                        conflicts.push({ kind: 'devices', id: Number(devOp.id), name: target.name });
                    }
                }
                if (conflicts.length > 0) {
                    return new Response(JSON.stringify({
                        ok: false,
                        error: `機器ID ${conflicts[0].id} は他の利用者または別画面で更新・削除されています`,
                        conflicts
                    }), { status: 409 });
                }
                serverDataRevision++;
                for (const devOp of parsedBody.devices || []) {
                    const target = getServerDevice(devOp.id);
                    const updated = normalizeDevice({
                        ...devOp.device,
                        id: Number(devOp.id),
                        resource_revision: target.resource_revision + 1
                    });
                    setServerDevice(updated);
                    savedDevices.push(structuredClone(updated));
                }
                return new Response(JSON.stringify({
                    ok: true,
                    revision: serverDataRevision,
                    saved_at: '2026-11-16T00:00:00Z',
                    id_maps: { devices: {}, views: {}, placements: {}, links: {} },
                    devices: savedDevices,
                    views: [], placements: [], view_link_routes: [], canvas_notes: [],
                    deleted_device_ids: [], deleted_view_ids: [], affected_view_ids: []
                }));
            }

            if (action === 'upload_device_image' || action === 'update_device_images' || action === 'delete_device_image') {
                if (rejectNextImageWith409) {
                    rejectNextImageWith409 = false;
                    return new Response(JSON.stringify({
                        ok: false,
                        error: '他の利用者または別画面でデータが更新されています'
                    }), { status: 409 });
                }
                const requestedRev = Number(parsedBody.revision);
                if (requestedRev !== serverDataRevision) {
                    return new Response(JSON.stringify({
                        ok: false,
                        error: `全体revision不一致 (expected=${requestedRev}, actual=${serverDataRevision})`
                    }), { status: 409 });
                }
                const target = getServerDevice(parsedBody.device_id);
                const expectedDevRev = Number(parsedBody.expected_device_revision);
                if (!skipServerDeviceRevisionCheck && expectedDevRev !== Number(target.resource_revision)) {
                    return new Response(JSON.stringify({
                        ok: false,
                        error: `機器ID ${target.id} は他の利用者または別画面で更新・削除されています。再読み込みしてください`
                    }), { status: 409 });
                }
                const prevDevRev = forcedPreviousDeviceRevision !== undefined
                    ? forcedPreviousDeviceRevision
                    : target.resource_revision;
                forcedPreviousDeviceRevision = undefined;
                serverDataRevision++;
                target.resource_revision++;
                if (action === 'upload_device_image') {
                    const replaceId = Number(parsedBody.replace_image_id || 0);
                    if (replaceId > 0) {
                        serverImages = serverImages.map(img => img.id === replaceId
                            ? { ...img, caption: String(parsedBody.caption || img.caption), image_url: `device_image.php?image_id=${replaceId}&v=2` }
                            : img);
                    } else {
                        const id = nextImageId++;
                        serverImages.push({
                            id, device_id: Number(target.id), caption: String(parsedBody.caption || ''),
                            sort_order: serverImages.length + 1,
                            image_url: `device_image.php?image_id=${id}`
                        });
                    }
                } else if (action === 'update_device_images') {
                    const byId = new Map(serverImages.map(img => [img.id, img]));
                    serverImages = parsedBody.images.map((item, idx) => ({
                        ...byId.get(Number(item.id)),
                        caption: String(item.caption ?? ''),
                        sort_order: idx + 1
                    }));
                } else if (action === 'delete_device_image') {
                    const delId = Number(parsedBody.image_id);
                    serverImages = serverImages
                        .filter(img => img.id !== delId)
                        .map((img, idx) => ({ ...img, sort_order: idx + 1 }));
                }
                return new Response(JSON.stringify({
                    ok: true,
                    revision: serverDataRevision,
                    ...(prevDevRev === null ? {} : { previous_device_revision: prevDevRev }),
                    device_revision: target.resource_revision,
                    images: structuredClone(serverImages.filter(img => Number(img.device_id) === Number(target.id)))
                }));
            }

            if (action === 'load_device_configs' || action === 'save_device_config') {
                if (action === 'save_device_config') {
                    if (Number(parsedBody.expected_device_revision) !== Number(serverDevice.resource_revision)) {
                        return new Response(JSON.stringify({ ok: false, error: 'device_revision不一致' }), { status: 409 });
                    }
                    configRevision++;
                    configItems.unshift({
                        id: configRevision, generation: configRevision,
                        content: parsedBody.content, memo: parsedBody.memo,
                        actor_name: 'admin', created_at: '2026-11-16T00:00:00Z'
                    });
                }
                return new Response(JSON.stringify({
                    ok: true, device_id: 1,
                    device_revision: serverDevice.resource_revision,
                    data_revision: serverDataRevision,
                    revision: configRevision,
                    items: structuredClone(configItems)
                }));
            }

            throw new Error(`Unexpected action: ${action}`);
        };
    };

    t.after(async () => {
        queue.clearPendingSave();
        drafts.discardDeviceDrafts();
        await ledger.closeLedgerDetailPane();
        panels.closePanel();
        for (const [key, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    });

    await t.test('1. 右パネルの全画像操作が device_revision と baseline を同期し、未適用下書きを保持したまま再読込なしで機器保存できる', async () => {
        await resetScenario();
        await panels.openPanel(appState.devices[0]);

        // 右パネルの未適用下書きを作成
        dom.get('p-name').value = 'パネル未適用名';
        await dom.events.dispatch('input', { target: dom.get('p-name') });
        assert.equal(panels.hasUnappliedPanelChanges(), true);

        const png1 = new File([new Uint8Array([137, 80, 78, 71])], 'one.png', { type: 'image/png' });
        const png2 = new File([new Uint8Array([137, 80, 78, 71])], 'two.png', { type: 'image/png' });
        const png3 = new File([new Uint8Array([137, 80, 78, 71])], 'rep.png', { type: 'image/png' });

        // 追加 2枚
        assert.equal(await uploadDeviceImageFile(png1), true);
        assert.equal(appState.devices[0].resource_revision, serverDevice.resource_revision);
        assert.equal(await uploadDeviceImageFile(png2), true);
        assert.equal(appState.devices[0].resource_revision, serverDevice.resource_revision);
        const [img1, img2] = appState.deviceImages;

        // 差替え
        assert.equal(await uploadDeviceImageFile(png3, img1.id), true);
        assert.equal(appState.devices[0].resource_revision, serverDevice.resource_revision);

        // 順序入替
        assert.equal(await reorderDeviceImages(1, [img2, img1]), true);
        assert.equal(appState.devices[0].resource_revision, serverDevice.resource_revision);
        assert.deepEqual(appState.deviceImages.map(i => i.id), [img2.id, img1.id]);

        // キャプション変更
        assert.equal(await updateImageCaption(1, img2.id, '前面ポート'), true);
        assert.equal(appState.devices[0].resource_revision, serverDevice.resource_revision);
        assert.equal(appState.deviceImages[0].caption, '前面ポート');

        // 削除
        assert.equal(await deleteDeviceImage(1, img1.id), true);
        assert.equal(appState.devices[0].resource_revision, serverDevice.resource_revision);
        assert.deepEqual(appState.deviceImages.map(i => i.id), [img2.id]);

        // 全画像操作を通じて右パネルの未適用入力が消えていないこと
        assert.equal(dom.get('p-name').value, 'パネル未適用名');
        assert.equal(panels.hasUnappliedPanelChanges(), true);

        // パネルを適用して保存すると最新の expected_revision が送られ 409 にならないこと
        assert.equal(panels.applyPanel(), true);
        assert.equal(await queue.flushSaveQueue({ silent: true }), true);
        const lastSave = requests.filter(r => r.action === 'save_resources').at(-1);
        assert.equal(lastSave.body.devices[0].expected_revision, serverDevice.resource_revision - 1);
        assert.equal(serverDevice.name, 'パネル未適用名');
        assert.equal(appState.appStatus.state, 'saved');
    });

    await t.test('2. 台帳個票の全画像操作が device_revision と Config タブを同期し、未適用下書き保持のまま保存できる', async () => {
        await resetScenario();
        await ledger.openLedgerDetail(1);
        const sheet = dom.get('ledger-sheet-body');
        const configTab = () => dom.get('ledger-sheet-tabs').querySelector('[data-tab-key="config"]');

        // 先にConfigタブを開いて deviceRevision を初期化し、基本タブへ戻す
        await configTab().click();
        await ledger.getConfigLoadPromise();
        await dom.get('ledger-sheet-tab-0').click();

        // 個票の未適用下書きを作成
        const memoInput = sheet.querySelector('[data-field="memo"]');
        memoInput.value = '個票未保存メモ';
        await memoInput.dispatch('input');

        const uploadInput = dom.get('ledger-sheet-image-file-input');
        const pngA = new File([new Uint8Array([137, 80, 78, 71])], 's1.png', { type: 'image/png' });
        const pngB = new File([new Uint8Array([137, 80, 78, 71])], 's2.png', { type: 'image/png' });
        const pngC = new File([new Uint8Array([137, 80, 78, 71])], 's3.png', { type: 'image/png' });

        // スロット追加 2枚
        await sheet.querySelector('.ledger-sheet-image-slot-add').dispatch('click');
        uploadInput.files = [pngA];
        await uploadInput.dispatch('change');
        await setImmediate();
        assert.equal(appState.devices[0].resource_revision, serverDevice.resource_revision);

        await sheet.querySelector('.ledger-sheet-image-slot-add').dispatch('click');
        uploadInput.files = [pngB];
        await uploadInput.dispatch('change');
        await setImmediate();
        assert.equal(appState.devices[0].resource_revision, serverDevice.resource_revision);

        // 差替え
        await sheet.querySelector('.ledger-sheet-image-replace').dispatch('click');
        uploadInput.files = [pngC];
        await uploadInput.dispatch('change');
        await setImmediate();
        assert.equal(appState.devices[0].resource_revision, serverDevice.resource_revision);

        // 並替
        await sheet.querySelector('.ledger-sheet-image-move').dispatch('click');
        await setImmediate();
        assert.equal(appState.devices[0].resource_revision, serverDevice.resource_revision);

        // キャプション変更
        const capInput = sheet.querySelector('.ledger-sheet-image-caption-input');
        capInput.value = '個票説明';
        await capInput.dispatch('input');
        await capInput.dispatch('change');
        await setImmediate();
        assert.equal(appState.devices[0].resource_revision, serverDevice.resource_revision);

        // 削除
        await sheet.querySelector('.ledger-sheet-image-delete').dispatch('click');
        await setImmediate();
        assert.equal(appState.devices[0].resource_revision, serverDevice.resource_revision);

        // 未適用下書きが保持されていること
        assert.equal(sheet.querySelector('[data-field="memo"]').value, '個票未保存メモ');

        // 個票保存が 409 なしで成功すること
        assert.equal(await ledger.saveLedgerSheet(), true);
        assert.equal(serverDevice.memo, '個票未保存メモ');

        // さらに画像追加後でも Config タブが最新 device_revision で保存できること
        await sheet.querySelector('.ledger-sheet-image-slot-add').dispatch('click');
        uploadInput.files = [pngA];
        await uploadInput.dispatch('change');
        await setImmediate();

        await configTab().click();
        await sheet.querySelector('#device-config-register').click();
        const cfgTextarea = sheet.querySelector('#device-config-editor');
        cfgTextarea.value = 'hostname SW-Core\n';
        await cfgTextarea.dispatch('input');
        await sheet.querySelector('#device-config-save').click();
        await setImmediate();
        const cfgSave = requests.filter(r => r.action === 'save_device_config').at(-1);
        assert.equal(cfgSave.body.expected_device_revision, serverDevice.resource_revision);
    });

    await t.test('3. save_resources と画像操作の双方向直列化（両方向の同時実行で409を起こさず戻り値も正確に返す）', async () => {
        await resetScenario();
        const png = new File([new Uint8Array([137, 80, 78, 71])], 'serial.png', { type: 'image/png' });

        // 方向A: save_resources 実行中に画像操作を起動 -> save 完了後に新 dataRevision で実行
        const saveGate = deferred();
        nextGate.set('save_resources', saveGate);
        appState.devices[0].memo = '保存中に画像起動';
        const savePromise = queue.flushSaveQueue({ silent: true });
        await setImmediate();
        assert.equal(requests.filter(r => r.action === 'save_resources').length, 1);

        const imgPromiseA = uploadDeviceImage(1, png);
        await setImmediate();
        assert.equal(requests.filter(r => r.action === 'upload_device_image').length, 0, 'save通信中は画像登録を送信しない');

        saveGate.resolve();
        assert.equal(await savePromise, true);
        await imgPromiseA;
        assert.equal(requests.filter(r => r.action === 'upload_device_image').length, 1);
        assert.equal(appState.devices[0].resource_revision, serverDevice.resource_revision);

        // 方向B: 画像アップロード中に flushSaveQueue / saveData を起動 -> 画像完了後に新 device_revision で送信し true を返す
        const imgGateB = deferred();
        nextGate.set('upload_device_image', imgGateB);
        const imgPromiseB = uploadDeviceImage(1, png);
        await setImmediate();
        assert.equal(requests.filter(r => r.action === 'upload_device_image').length, 2);

        const preImageDevRev = serverDevice.resource_revision;
        appState.devices[0].memo = '画像中に保存起動';
        const queuedSave = saveData();
        await setImmediate();
        assert.equal(requests.filter(r => r.action === 'save_resources').length, 1, '画像通信中は save_resources を送信しない');

        imgGateB.resolve();
        await imgPromiseB;
        assert.equal(await queuedSave, true, '後続保存が完了してから true を返すこと');
        const followUpSave = requests.filter(r => r.action === 'save_resources').at(-1);
        assert.equal(followUpSave.body.devices[0].expected_revision, preImageDevRev + 1, '画像登録後の新 device_revision を使うこと');
        assert.equal(serverDevice.memo, '画像中に保存起動');

        // 方向Bで後続保存が 409 になる場合は saveData() が false を返すこと
        const imgGateC = deferred();
        nextGate.set('upload_device_image', imgGateC);
        const imgPromiseC = uploadDeviceImage(1, png);
        await setImmediate();

        appState.devices[0].memo = '画像後に409失敗';
        rejectNextSaveWith409 = true;
        const queuedFailSave = saveData();
        await setImmediate();
        imgGateC.resolve();
        await imgPromiseC;
        assert.equal(await queuedFailSave, false, '後続保存が409なら呼び出し元へ false を返すこと');
        assert.equal(queue.hasResourceConflict('devices', 1), true);

        // 方向C: runResourceMutation() 開始直後（待機復帰前）に flushSaveQueue() を起動しても、通常保存完了まで画像APIを発行しない
        await resetScenario();
        const saveGateRace1 = deferred();
        nextGate.set('save_resources', saveGateRace1);
        const imgAfterRace1 = uploadDeviceImage(1, png);
        appState.devices[0].memo = '開始直後flush';
        const saveRace1 = queue.flushSaveQueue({ silent: true });
        await setImmediate();
        assert.equal(requests.filter(r => r.action === 'save_resources').length, 1);
        assert.equal(requests.filter(r => r.action === 'upload_device_image').length, 0, '待機復帰前に開始した通常保存の完了まで画像APIを送信しない');
        saveGateRace1.resolve();
        assert.equal(await saveRace1, true);
        await imgAfterRace1;
        assert.equal(requests.filter(r => r.action === 'upload_device_image').length, 1);
        assert.equal(appState.devices[0].resource_revision, serverDevice.resource_revision);

        // さらに既存保存の待機復帰前（save-state:changed 直後）に次の flushSaveQueue() が割り込んだ場合も再待機する
        const saveGateRace2 = deferred();
        const saveGateRace3 = deferred();
        nextGate.set('save_resources', saveGateRace2);
        appState.devices[0].memo = '割り込み前保存';
        const saveRace2 = queue.flushSaveQueue({ silent: true });
        await setImmediate();
        const imgDuringReentry = uploadDeviceImage(1, png);
        let saveRace3 = null;
        const offReentry = eventBus.on('save-state:changed', () => {
            if (queue.isSaveInFlight() || saveRace3) return;
            offReentry();
            nextGate.set('save_resources', saveGateRace3);
            appState.devices[0].memo = '割り込み後続保存';
            saveRace3 = queue.flushSaveQueue({ silent: true });
        });
        saveGateRace2.resolve();
        assert.equal(await saveRace2, true);
        await setImmediate();
        assert.ok(saveRace3, '待機復帰前に後続 flushSaveQueue() が開始されている');
        assert.equal(requests.filter(r => r.action === 'save_resources').length, 3);
        assert.equal(requests.filter(r => r.action === 'upload_device_image').length, 1, '割り込んだ通常保存の完了まで画像APIを送信しない');
        saveGateRace3.resolve();
        assert.equal(await saveRace3, true);
        await imgDuringReentry;
        assert.equal(requests.filter(r => r.action === 'upload_device_image').length, 2);
        assert.equal(appState.devices[0].resource_revision, serverDevice.resource_revision);
    });

    await t.test('4. 画像APIの409失敗時はrevision・画像一覧を上書きせず、機器競合中は画像操作UIとAPIをブロックして再読込で解除する', async () => {
        await resetScenario();
        await panels.openPanel(appState.devices[0]);
        await ledger.openLedgerDetail(1);
        const sheet = dom.get('ledger-sheet-body');

        const png = new File([new Uint8Array([137, 80, 78, 71])], 'err.png', { type: 'image/png' });
        await uploadDeviceImageFile(png);
        const revBefore409 = appState.devices[0].resource_revision;
        const dataRevBefore409 = appState.dataRevision;
        const imagesBefore409 = structuredClone(appState.deviceImages);

        // 画像APIが409を返しても revision / baseline / deviceImages を書き換えず自動再試行もしない
        const callsBefore = requests.length;
        rejectNextImageWith409 = true;
        assert.equal(await deleteDeviceImage(1, imagesBefore409[0].id), false);
        assert.equal(requests.length, callsBefore + 1, '409時に自動再試行しない');
        assert.equal(appState.devices[0].resource_revision, revBefore409);
        assert.equal(appState.dataRevision, dataRevBefore409);
        assert.deepEqual(appState.deviceImages, imagesBefore409);

        // save_resources が 409 で機器競合になった場合、右パネルと個票の画像操作をロックする
        rejectNextSaveWith409 = true;
        appState.devices[0].memo = '競合発生';
        assert.equal(await queue.flushSaveQueue({ silent: true }), false);
        assert.equal(queue.hasResourceConflict('devices', 1), true);

        // 右パネルのロック検証（DOM要素を維持したまま disabled/警告更新）
        assert.equal(dom.get('p-device-image-add-btn').disabled, true);
        assert.equal(dom.get('p-device-images-dirty-warning').hidden, false);
        assert.match(dom.get('p-device-images-dirty-warning').textContent, /保存競合/);
        assert.ok(dom.get('p-device-images-list').querySelectorAll('.device-image-caption-input, .device-image-actions button').every(el => el.disabled));

        // 個票の画像操作ロック検証
        assert.ok(sheet.querySelectorAll('.ledger-sheet-image-slot-add').every(el => el.disabled));
        assert.ok(sheet.querySelectorAll('.ledger-sheet-image-move, .ledger-sheet-image-replace, .ledger-sheet-image-delete, .ledger-sheet-image-caption-input').every(el => el.disabled));
        assert.ok(sheet.querySelectorAll('.ledger-sheet-image-block-reason').every(el => !el.hidden));

        // API直接呼出しも通信せず拒否される
        const reqsBeforeBlocked = requests.length;
        await assert.rejects(() => uploadDeviceImage(1, png), /保存競合/);
        assert.equal(requests.length, reqsBeforeBlocked);

        // 対象機器を再読込すると競合が解除され、画像操作も復帰する
        await queue.reloadConflictedResource('devices', 1);
        assert.equal(queue.hasResourceConflict('devices', 1), false);
        assert.equal(dom.get('p-device-image-add-btn').disabled, false);
        assert.equal(dom.get('p-device-images-dirty-warning').hidden, true);
        assert.ok(sheet.querySelectorAll('.ledger-sheet-image-slot-add').every(el => !el.disabled));
        assert.ok(sheet.querySelectorAll('.ledger-sheet-image-block-reason').every(el => el.hidden));
    });

    await t.test('5. 他クライアント更新済みの別機器B保存後に最新dataRevisionを得ても、未更新機器Aの画像操作で409となり古い属性を誤上書きしない', async () => {
        await resetScenario({ includeSecondDevice: true });
        const png = new File([new Uint8Array([137, 80, 78, 71])], 'a.png', { type: 'image/png' });

        // 初期画像1枚を登録した状態を準備（A: rev=6）
        await uploadDeviceImage(1, png);
        assert.equal(appState.devices.find(d => d.id === 1).resource_revision, 6);
        const existingImageId = appState.deviceImages[0].id;

        // 他クライアントが機器Aを更新（サーバー側の機器Aは name='Remote-Edited-A', resource_revision=7, global dataRevision++）
        serverDevice.name = 'Remote-Edited-A';
        serverDevice.resource_revision = 7;
        serverDataRevision++;

        // 自クライアントは無関係な機器Bだけを保存し、最新の global dataRevision を得る（機器Aはローカルで stale のまま）
        appState.devices.find(d => d.id === 2).memo = '機器Bだけ更新';
        assert.equal(await queue.flushSaveQueue({ silent: true }), true);
        assert.equal(appState.dataRevision, serverDataRevision, '機器B保存で全体 dataRevision は最新になる');
        const staleDeviceA = appState.devices.find(d => d.id === 1);
        assert.equal(staleDeviceA.name, 'SW-Core');
        assert.equal(staleDeviceA.resource_revision, 6);

        // 最新 dataRevision を持っていても、機器Aの操作前の expected_device_revision(6) != サーバー(7) のため全画像APIが409で拒否される
        await assert.rejects(
            () => uploadDeviceImage(1, png),
            err => err.status === 409
        );
        const uploadReq = requests.filter(r => r.action === 'upload_device_image').at(-1);
        assert.equal(Number(uploadReq.body.expected_device_revision), 6);

        await assert.rejects(
            () => updateDeviceImagesRequest(1, [{ id: existingImageId, caption: 'stale-update' }]),
            err => err.status === 409
        );
        const updateReq = requests.filter(r => r.action === 'update_device_images').at(-1);
        assert.equal(updateReq.body.expected_device_revision, 6);

        await assert.rejects(
            () => deleteDeviceImageRequest(1, existingImageId),
            err => err.status === 409
        );
        const deleteReq = requests.filter(r => r.action === 'delete_device_image').at(-1);
        assert.equal(deleteReq.body.expected_device_revision, 6);

        // クライアント側でも、previous_device_revision が一致しない・欠落した応答で baseline を進めない（多層防御）
        skipServerDeviceRevisionCheck = true;
        forcedPreviousDeviceRevision = 7; // != ローカル期待値 6
        await uploadDeviceImage(1, png);
        assert.equal(appState.devices.find(d => d.id === 1).resource_revision, 6, '不一致のprevious_device_revisionではdevice_revisionを進めない');

        forcedPreviousDeviceRevision = null; // 欠落応答
        await uploadDeviceImage(1, png);
        assert.equal(appState.devices.find(d => d.id === 1).resource_revision, 6, 'previous_device_revision欠落時もdevice_revisionを進めない');
        skipServerDeviceRevisionCheck = false;

        // その後、機器Aのメモを変更して保存しても古い expected_revision(6) が送られ、他クライアント変更を上書きせず 409 になる
        staleDeviceA.memo = '上書きしてはいけない編集';
        assert.equal(await queue.flushSaveQueue({ silent: true }), false);
        assert.equal(queue.hasResourceConflict('devices', 1), true);
        assert.equal(serverDevice.name, 'Remote-Edited-A', '他クライアントの編集が上書きされていないこと');
    });
});
