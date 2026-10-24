import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';

const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
};
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });

test('確定保存キューの応答・競合・再読込境界', async t => {
    const globals = new Map(['window', 'document', 'fetch', 'confirm'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const elements = new Map();
    const element = id => {
        if (!elements.has(id)) elements.set(id, {
            id, textContent: '', title: '', hidden: false, disabled: false, dataset: {}, style: {}, children: [],
            classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, setAttribute() {},
            removeAttribute() {}, getAttribute() { return null; }, focus() {},
            appendChild(child) { this.children.push(child); }, append(...rows) { this.children.push(...rows); },
            replaceChildren(...rows) { this.children = rows; },
            addEventListener() {}, removeEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }
        });
        return elements.get(id);
    };
    globalThis.document = {
        getElementById: id => id === 'ledger-device-sheet-overlay' ? null : element(id),
        querySelectorAll: () => [], querySelector: () => null,
        addEventListener() {}, createElement: element, body: { appendChild() {}, classList: { toggle() {} } }
    };
    globalThis.window = {
        location: { href: 'https://netarium.test/app/' },
        APP_CONFIG: { user: { isAdmin: true }, csrfToken: 'test-token' }, addEventListener() {},
        clearTimeout() {}, setTimeout() { return 0; }
    };
    globalThis.confirm = () => true;
    t.mock.method(console, 'error', () => {});
    const { appState, normalizeDevice, normalizeView, normalizePlacement } = await import('../public/js/core/state.js');
    const queue = await import('../public/js/core/save-queue.js');
    const { saveData } = await import('../public/js/ui/toolbar.js');
    const resources = await import('../public/js/core/resource-save.js');
    const drafts = await import('../public/js/core/device-drafts.js');
    const { eventBus } = await import('../public/js/core/event-bus.js');
    const { normalizeCanvasNote } = await import('../public/js/core/canvas-note-data.js');
    const { openLedgerDetail } = await import('../public/js/modals/ledger-modal.js');
    t.after(() => {
        queue.clearPendingSave();
        drafts.discardDeviceDrafts();
        for (const [key, descriptor] of globals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    });
    let calls;
    let handler;
    const fixture = () => {
        queue.clearPendingSave();
        drafts.discardDeviceDrafts();
        appState.devices = [10, 20].map(id => normalizeDevice({ id, resource_revision: 1, name: `SW-${id}`, type: 'switch', ip: '' }));
        appState.views = [1, 2].map(id => normalizeView({ id, resource_revision: 1, name: `View-${id}`, view_type: 'topology' }));
        appState.placements = [normalizePlacement({ id: 100, view_id: 1, device_id: 10, x: 10, y: 20 })];
        appState.links = [];
        appState.canvasNotes = [];
        appState.selectedCanvasNoteId = null;
        appState.noteMode = false;
        appState.floorPlans = [];
        appState.deviceImages = [];
        appState.selectedPlacementIds = new Set();
        appState.floorPlanAutoFittedViews = new Set();
        appState.viewStates = new Map();
        appState.currentViewId = 1;
        appState.authExpired = false;
        appState.isSaving = false;
        appState.dataRevision = 1;
        appState.appStatus = { state: 'saved', dirty: false, lastError: null, lastSavedAt: null };
        appState.currentSvg = null;
        appState.deviceLayer = null;
        resources.resetResourceBaseline(appState);
        element('ledger-sheet-save-btn').dataset.deviceId = '10';
        calls = [];
        handler = async (action, payload) => json(success(payload));
        globalThis.fetch = async (url, options) => {
            const action = new URL(url, 'http://localhost').searchParams.get('action');
            const payload = options.body ? JSON.parse(options.body) : null;
            calls.push({ action, payload });
            return handler(action, payload);
        };
    };
    const success = payload => {
        const maps = { devices: {}, views: {}, placements: {}, links: {}, canvas_notes: {} };
        for (const id of resources.createPendingResourceSave(payload).newIds.canvas_notes) maps.canvas_notes[id] = id + 1000;
        for (const kind of ['devices', 'views']) {
            for (const operation of payload[kind]) {
                if (operation.operation === 'create') maps[kind][operation.id] = operation.id + 1000;
            }
        }
        const map = (kind, id) => maps[kind][id] || id;
        const devices = payload.devices.filter(row => row.operation !== 'delete').map(row => ({
            ...row.device, id: map('devices', row.id), resource_revision: (row.expected_revision || 0) + 1
        }));
        const views = payload.views.filter(row => row.operation !== 'delete').map(row => ({
            ...row.view, id: map('views', row.id), resource_revision: (row.expected_revision || 0) + 1
        }));
        const placements = [];
        const links = [];
        const canvas_notes = [];
        for (const operation of payload.views) {
            if (operation.operation === 'delete') continue;
            for (const placement of operation.placements) {
                maps.placements[placement.id] = placement.id;
                placements.push({ ...placement, device_id: map('devices', placement.device_id), view_id: map('views', placement.view_id) });
            }
            for (const link of operation.links) {
                maps.links[link.id] = link.id;
                links.push({ ...link, from_id: map('devices', link.from_id), to_id: map('devices', link.to_id), view_id: map('views', link.view_id) });
            }
            for (const note of operation.canvas_notes) {
                canvas_notes.push({ ...note, id: map('canvas_notes', note.id), view_id: map('views', note.view_id) });
            }
        }
        return {
            ok: true, revision: appState.dataRevision + 1, id_maps: maps, devices, views, placements, links, canvas_notes,
            deleted_device_ids: payload.devices.filter(row => row.operation === 'delete').map(row => row.id),
            deleted_view_ids: payload.views.filter(row => row.operation === 'delete').map(row => row.id),
            affected_view_ids: payload.views.map(row => map('views', row.id))
        };
    };
    const remoteData = () => ({
        revision: 2, devices: structuredClone(appState.devices), views: structuredClone(appState.views),
        placements: structuredClone(appState.placements), links: structuredClone(appState.links),
        canvas_notes: structuredClone(appState.canvasNotes), floor_plans: [], device_images: []
    });

    const maintenance = action => {
        const response = new Response(JSON.stringify({
            ok: false, error_code: 'NETARIUM_MAINTENANCE_REJECTED', contract_version: 1,
            request_execution: 'not_started', operation_id: 'maintenance-246'
        }), { status: 404, headers: { 'Content-Type': 'application/json' } });
        Object.defineProperty(response, 'url', { value: `https://netarium.test/app/api.php?action=${action}` });
        return response;
    };

    for (const creating of [false, true]) {
        await t.test(`${creating ? '新規' : '既存'}の保守拒否はsnapshot・後続編集・下書きを保持し明示保存だけで再開する`, async tc => {
            fixture();
            tc.mock.timers.enable({ apis: ['setTimeout'] });
            if (creating) appState.devices.push(normalizeDevice({ id: 30, name: '保守中新規', type: 'switch' }));
            const id = creating ? 30 : 10;
            const device = appState.devices.find(row => row.id === id);
            device.memo = '最初の編集';
            drafts.getDeviceDraft('panel', id).location = '未適用下書き';
            const gate = deferred();
            handler = async action => { await gate.promise; return maintenance(action); };
            const flight = queue.flushSaveQueue();
            const snapshot = queue.getPendingSave();
            device.memo = '通信中の追加編集';
            queue.scheduleSave({ debounceMs: 20 });
            gate.resolve();
            assert.equal(await flight, false);
            assert.equal(queue.getPendingSave(), snapshot);
            assert.equal(snapshot.maintenanceRejected, true);
            assert.equal(snapshot.operationId, 'maintenance-246');
            assert.equal(snapshot.payload.devices[0].device.memo, '最初の編集');
            assert.equal(appState.dataRevision, 1);
            assert.equal(device.id, id);
            assert.equal(device.memo, '通信中の追加編集');
            assert.equal(drafts.getDeviceDraft('panel', id).location, '未適用下書き');
            assert.equal(element('saveBtn').disabled, false);
            assert.match(element('saveBtn').title, /保守.*保持/);
            assert.equal(appState.appStatus.state, 'maintenance');
            assert.match(element('status-save-state').textContent, /保守待機（未受理）.*「保存」/);
            assert.equal(element('status-confirm-save-btn').hidden, true);
            tc.mock.timers.tick(1000);
            await setImmediate();
            assert.equal(calls.length, 1, '既存timerも保守中に再送しない');
            assert.equal(await queue.confirmPendingSave(), 'maintenance');
            assert.equal(calls.length, 1, '未受理を不明として照合しない');
            handler = async (_, payload) => json(success(payload));
            device.location = '保守解除後の追加入力';
            queue.scheduleSave({ immediate: true, silent: false });
            tc.mock.timers.tick(2000);
            await setImmediate();
            assert.equal(await queue.flushSaveQueue({ silent: true }), false);
            assert.equal(calls.length, 1, '解除後も自動再送しない');
            assert.equal(await saveData(), true, '上部の既存保存操作で明示再開できる');
            assert.equal(calls.length, 2);
            assert.equal(calls[1].payload.devices[0].device.memo, '通信中の追加編集');
            assert.equal(calls[1].payload.devices[0].device.location, '保守解除後の追加入力');
            assert.equal(calls[1].payload.devices[0].operation, creating ? 'create' : 'update');
            assert.equal(queue.getPendingSave(), null);
            assert.equal(queue.hasPendingChanges(), false);
            assert.equal(appState.devices.find(row => row.id === (creating ? 1030 : id)).memo, '通信中の追加編集');
            assert.equal(drafts.getDeviceDraft('panel', creating ? 1030 : id).location, '未適用下書き');
        });
    }

    const floorFixture = () => {
        fixture();
        appState.views[0].view_type = 'floor';
        appState.floorPlans = [{ view_id: 1, revision: 1, x: 0, y: 0, scale: 1, opacity: 1, is_visible: 1 }];
        resources.resetResourceBaseline(appState);
        return appState.floorPlans[0];
    };

    await t.test('図面保守待機は送信snapshotと後続設定を保持し解除後の明示保存で最新設定を反映する', async tc => {
        const plan = floorFixture();
        tc.mock.timers.enable({ apis: ['setTimeout'] });
        const gate = deferred();
        handler = async action => { await gate.promise; return maintenance(action); };
        plan.x = 10;
        queue.scheduleFloorPlanSave(plan);
        const flight = queue.waitForActiveResourceSave();
        const pending = queue.getPendingSave();
        plan.x = 25;
        plan.opacity = 0.5;
        queue.scheduleFloorPlanSave(plan);
        gate.resolve();
        await flight;
        assert.equal(queue.getPendingSave(), pending);
        assert.equal(pending.floorPlan.x, 10);
        assert.equal(pending.maintenanceRejected, true);
        assert.equal(plan.x, 25);
        assert.equal(plan.revision, 1);
        assert.equal(appState.views[0].resource_revision, 1);
        assert.equal(appState.dataRevision, 1);
        assert.equal(appState.appStatus.state, 'maintenance');
        assert.equal(element('status-confirm-save-btn').hidden, true);
        handler = async (_, payload) => json({ ok: true, revision: 2, view_revision: 2,
            floor_plan_settings: { ...payload, revision: 2 } });
        queue.scheduleFloorPlanSave(plan);
        tc.mock.timers.tick(5000);
        await setImmediate();
        assert.equal(await queue.flushSaveQueue({ silent: true }), false);
        assert.equal(calls.length, 1);
        assert.equal(await saveData(), true);
        assert.equal(calls.length, 2);
        assert.equal(calls[1].payload.x, 25);
        assert.equal(calls[1].payload.opacity, 0.5);
        assert.equal(calls[1].payload.expected_revision, 1);
        assert.equal(plan.revision, 2);
        assert.equal(appState.views[0].resource_revision, 2);
        assert.equal(queue.getPendingSave(), null);
        assert.equal(queue.hasPendingChanges(), false);
    });

    const ambiguousResponses = [
        ['通常404', () => json({ ok: false, error: 'Not found' }, 404)],
        ['汎用503', () => json({ ok: false, error: 'Unavailable' }, 503)],
        ['通信断', () => { throw new Error('network lost'); }],
        ['JSON破損404', () => new Response('{broken', { status: 404 })],
        ['JSON破損200', () => new Response('{broken', { status: 200 })],
        ['JSON破損409', () => new Response('{broken', { status: 409 })],
        ['未知契約', () => json({ ok: false, error_code: 'NETARIUM_MAINTENANCE_REJECTED',
            contract_version: 2, request_execution: 'not_started', operation_id: 'maintenance-246' }, 404)],
        ['不完全成功', () => json({ ok: true })],
        ['成功印欠落', (payload, kind) => {
            const result = kind === 'floor'
                ? { revision: 2, view_revision: 2, floor_plan_settings: { ...payload, revision: 2 } }
                : success(payload);
            delete result.ok;
            return json(result);
        }]
    ];
    for (const [label, response] of ambiguousResponses) {
        for (const kind of ['update', 'create', 'floor']) {
            await t.test(`${label}の${kind}は不明保留し明示保存でも再送せず既存照合を使う`, async () => {
                if (kind === 'floor') floorFixture();
                else fixture();
                const remote = remoteData();
                if (kind === 'create') appState.devices.push(normalizeDevice({ id: 30, name: '不明新規', type: 'switch' }));
                else if (kind === 'update') appState.devices[0].memo = '不明更新';
                handler = async (_, payload) => response(payload, kind);
                if (kind === 'floor') {
                    appState.floorPlans[0].x = 50;
                    queue.scheduleFloorPlanSave(appState.floorPlans[0]);
                    await queue.waitForActiveResourceSave();
                } else assert.equal(await queue.flushSaveQueue(), false);
                const pending = queue.getPendingSave();
                assert.ok(pending);
                assert.notEqual(pending.maintenanceRejected, true);
                assert.equal(appState.dataRevision, 1);
                queue.scheduleSave({ immediate: true });
                assert.equal(await queue.flushSaveQueue(), false);
                assert.equal(queue.getPendingSave(), pending);
                assert.equal(calls.length, 1);
                handler = async action => {
                    assert.equal(action, 'load');
                    return json(remote);
                };
                assert.equal(await queue.confirmPendingSave(), kind === 'create' ? 'unknown' : 'retry');
                assert.equal(calls.length, 2);
                if (kind === 'create') {
                    assert.equal(queue.getPendingSave(), pending);
                    assert.equal(await queue.flushSaveQueue(), false);
                    assert.equal(calls.length, 2, 'ID対応不明のcreateを再送しない');
                    assert.equal(appState.devices.find(row => row.id === 30).name, '不明新規');
                }
            });
        }
    }

    await t.test('保存応答待ちの次の編集は最新revisionで直列保存される', async () => {
        fixture();
        const gate = deferred();
        let requests = 0;
        handler = async (_, payload) => {
            const response = success(payload);
            if (++requests === 1) await gate.promise;
            return json(response);
        };
        appState.devices[0].name = '最初';
        const flight = queue.flushSaveQueue({ silent: true });
        assert.equal(queue.isSaveInFlight(), true);
        appState.devices[0].memo = '後続入力';
        queue.updateSaveButtonState();
        assert.equal(element('saveBtn').disabled, false);
        const queued = queue.flushSaveQueue({ silent: true });
        gate.resolve();
        assert.equal(await flight, true);
        await queued;
        assert.equal(calls.length, 2);
        assert.equal(calls[1].payload.devices[0].expected_revision, 2);
        assert.equal(calls[1].payload.devices[0].device.memo, '後続入力');
        assert.equal(appState.devices[0].memo, '後続入力');
        assert.equal(queue.hasPendingChanges(), false);
    });

    await t.test('成否確認は送信snapshotを使い確認中の追加編集を残す', async () => {
        fixture();
        appState.devices[0].name = '保存済み名称';
        let committed;
        handler = async (_, payload) => {
            committed = success(payload);
            throw new Error('応答喪失');
        };
        assert.equal(await queue.flushSaveQueue({ silent: true }), false);
        const remote = remoteData();
        remote.devices[0] = committed.devices[0];
        appState.devices[0].memo = '確認前の追加入力';
        const gate = deferred();
        handler = async (action, payload) => {
            if (action === 'load') {
                await gate.promise;
                return json(remote);
            }
            return json(success(payload));
        };
        const first = queue.confirmPendingSave();
        const second = queue.confirmPendingSave();
        assert.equal(first, second);
        assert.equal(calls.filter(row => row.action === 'load').length, 1);
        appState.devices[0].location = '確認中の入力';
        gate.resolve();
        assert.equal(await first, 'saved');
        assert.equal(appState.devices[0].memo, '確認前の追加入力');
        assert.equal(appState.devices[0].location, '確認中の入力');
        assert.equal(appState.devices[0].resource_revision, 2);
        await setImmediate();
        assert.equal(calls.filter(row => row.action === 'save_resources').length, 2);
        assert.equal(queue.isSaveInFlight(), false);
        const operation = calls.at(-1).payload.devices[0];
        assert.equal(operation.expected_revision, 2);
        assert.equal(operation.device.memo, '確認前の追加入力');
        assert.equal(operation.device.location, '確認中の入力');
    });

    await t.test('成否確認で対象競合が確定しても独立した後続確定を自動保存する', async () => {
        fixture();
        appState.devices[0].memo = '競合する送信';
        handler = async () => { throw new Error('成否不明'); };
        await queue.flushSaveQueue({ silent: true });
        const remote = remoteData();
        remote.devices[0].memo = '他利用者の変更';
        remote.devices[0].resource_revision = 8;
        appState.devices[1].memo = '後続確定';
        handler = async (action, payload) => action === 'load' ? json(remote) : json(success(payload));
        assert.equal(await queue.confirmPendingSave(), 'conflict');
        await setImmediate();
        assert.equal(calls.filter(row => row.action === 'save_resources').length, 2);
        assert.deepEqual(calls.at(-1).payload.devices.map(row => row.id), [20]);
        assert.equal(appState.devices.find(row => row.id === 10).memo, '競合する送信');
        assert.equal(appState.devices.find(row => row.id === 20).memo, '後続確定');
        assert.equal(queue.hasResourceConflict('devices', 10), true);
        assert.equal(queue.hasSaveableChanges(), false);
    });

    await t.test('古い再確認応答は新しい世代のpendingと入力を消さない', async () => {
        fixture();
        appState.devices[0].memo = '旧要求';
        handler = async () => { throw new Error('応答喪失'); };
        await queue.flushSaveQueue({ silent: true });
        const oldRemote = remoteData();
        const gate = deferred();
        handler = async () => { await gate.promise; return json(oldRemote); };
        const oldConfirmation = queue.confirmPendingSave();
        queue.clearPendingSave();
        appState.devices[1].memo = '新世代入力';
        handler = async () => { throw new Error('新世代の応答喪失'); };
        await queue.flushSaveQueue({ silent: true });
        const pending = queue.getPendingSave();
        gate.resolve();
        assert.equal(await oldConfirmation, 'stale');
        assert.equal(queue.getPendingSave(), pending);
        assert.equal(appState.appStatus.state, 'unconfirmed');
        assert.equal(appState.devices[1].memo, '新世代入力');
    });

    await t.test('構造化409は当該機器と依存ビューのみ保留し独立した新規を採番保存する', async () => {
        fixture();
        const remaps = [];
        const off = eventBus.on('resources:ids-remapped', maps => remaps.push(maps));
        appState.devices[0].memo = '競合側の入力';
        appState.devices[1].memo = '独立した入力';
        appState.devices.push(normalizeDevice({ id: 30, name: '新規', type: 'switch' }));
        appState.views[0].memo = '依存ビュー入力';
        appState.views[1].memo = '独立ビュー入力';
        appState.placements.push(normalizePlacement({ id: 200, device_id: 30, view_id: 2, x: 30, y: 40 }));
        let first = true;
        handler = async (_, payload) => {
            if (first) {
                first = false;
                return json({ ok: false, error: '名称に依存しない競合', details: { conflicts: [{ kind: 'devices', id: 10, name: 'SW-10' }] } }, 409);
            }
            return json(success(payload));
        };
        assert.equal(await queue.flushSaveQueue({ silent: true }), true);
        off();
        assert.equal(calls.length, 2);
        assert.deepEqual(calls[1].payload.devices.map(row => row.id), [20, 30]);
        assert.deepEqual(calls[1].payload.views.map(row => row.id), [2]);
        assert.equal(queue.hasResourceConflict('devices', 10), true);
        assert.equal(appState.devices.find(row => row.id === 10).memo, '競合側の入力');
        assert.equal(appState.views.find(row => row.id === 1).memo, '依存ビュー入力');
        assert.equal(appState.placements.find(row => row.id === 200).device_id, 1030);
        assert.equal(remaps.length, 1);
        assert.equal(remaps[0].devices[30], 1030);
        assert.equal(queue.hasSaveableChanges(), false);
        assert.match(element('status-save-state').textContent, /競合.*1件/);
        appState.devices.find(row => row.id === 20).location = '競合後も編集';
        queue.updateSaveButtonState();
        assert.equal(element('saveBtn').disabled, false);
        await queue.flushSaveQueue({ silent: true });
        assert.equal(calls.length, 3);
        assert.equal(queue.hasResourceConflict('devices', 10), true);
    });

    await t.test('対象不明409のbatchは再送せず後から別対象を保存できる', async () => {
        fixture();
        appState.devices[0].memo = '保留';
        handler = async () => json({ ok: false, error: '復元排他' }, 409);
        assert.equal(await queue.flushSaveQueue({ silent: true }), false);
        await queue.flushSaveQueue({ silent: true });
        assert.equal(calls.length, 1);
        appState.devices[1].memo = '別対象';
        handler = async (_, payload) => json(success(payload));
        await queue.flushSaveQueue({ silent: true });
        assert.equal(calls.length, 2);
        assert.deepEqual(calls[1].payload.devices.map(row => row.id), [20]);
        assert.equal(appState.devices.find(row => row.id === 10).memo, '保留');
        assert.equal(queue.hasResourceConflict('devices', 10), true);
    });
    await t.test('ID枯渇の409はリソース競合としてマークせず保存エラーとして処理する', async () => {
        fixture();
        appState.devices[0].memo = '枯渇時更新';
        handler = async () => json({ ok: false, error: 'IDの採番余地がありません', details: { reason: 'id_exhausted', resource: 'devices' } }, 409);
        assert.equal(await queue.flushSaveQueue({ silent: true }), false);
        assert.equal(appState.appStatus.state, 'error');
        assert.equal(queue.hasResourceConflict('devices', 10), false);
    });

    await t.test('競合ビューをcascade削除する機器削除は送信しない', async () => {
        fixture();
        appState.resourceConflicts.views.set(1, { kind: 'views', id: 1, name: 'View-1', message: '競合' });
        appState.devices = appState.devices.filter(row => row.id !== 10);
        appState.placements = [];
        appState.devices[0].memo = '削除と無関係';
        await queue.flushSaveQueue({ silent: true });
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0].payload.devices.map(row => [row.id, row.operation]), [[20, 'update']]);
        assert.equal(queue.hasPendingChanges(), true);
        assert.equal(queue.hasSaveableChanges(), false);
    });

    await t.test('競合対象だけ再読込し別機器の下書きと確定入力を保持する', async () => {
        fixture();
        const remote = remoteData();
        remote.devices[0].memo = 'リモート';
        remote.devices[0].resource_revision = 5;
        appState.devices[0].memo = '破棄対象';
        appState.devices[1].memo = '未関連確定入力';
        drafts.getDeviceDraft('panel', 20).location = '未関連下書き';
        drafts.getDeviceDraft('sheet', 10).location = '対象下書き';
        appState.resourceConflicts.devices.set(10, { kind: 'devices', id: 10, name: 'SW-10', message: '競合' });
        const events = [];
        const off = eventBus.on('resource:reloaded', detail => events.push(detail));
        handler = async () => json(remote);
        assert.equal(await queue.reloadConflictedResource('devices', 10), true);
        off();
        assert.equal(appState.devices.find(row => row.id === 10).memo, 'リモート');
        assert.equal(appState.devices.find(row => row.id === 20).memo, '未関連確定入力');
        assert.equal(drafts.getDeviceDraft('panel', 20).location, '未関連下書き');
        assert.equal(drafts.hasDeviceDraftChanges('sheet', 10), false);
        assert.deepEqual(events, [{ kind: 'devices', id: 10 }]);
        assert.equal(queue.hasResourceConflict('devices', 10), false);
        assert.deepEqual(resources.buildResourceSave().devices.map(row => row.id), [20]);
    });

    await t.test('機器競合の再読込で解除されたビュー変更を追加操作なしで保存する', async tc => {
        fixture();
        tc.mock.timers.enable({ apis: ['setTimeout'] });
        const remote = remoteData();
        remote.devices[0].memo = '他利用者の確定値';
        remote.devices[0].resource_revision = 2;
        appState.devices[0].memo = '破棄する機器変更';
        appState.placements[0].x = 90;
        handler = async () => json({
            ok: false, error: '競合',
            details: { conflicts: [{ kind: 'devices', id: 10, name: 'SW-10' }] }
        }, 409);
        assert.equal(await queue.flushSaveQueue({ silent: true }), false);
        handler = async (action, payload) => action === 'load' ? json(remote) : json(success(payload));
        assert.equal(await queue.reloadConflictedResource('devices', 10), true);
        tc.mock.timers.tick(800);
        await setImmediate();
        const saves = calls.filter(call => call.action === 'save_resources');
        assert.equal(saves.length, 2);
        assert.deepEqual(saves[1].payload.devices, []);
        assert.equal(saves[1].payload.views[0].placements[0].x, 90);
        assert.equal(appState.devices.find(row => row.id === 10).memo, '他利用者の確定値');
        assert.equal(queue.hasSaveableChanges(), false);
    });

    await t.test('対象再読込の古い応答も全読込後に反映しない', async () => {
        fixture();
        const remote = remoteData();
        appState.resourceConflicts.devices.set(10, { id: 10, name: 'SW-10' });
        const gate = deferred();
        handler = async () => { await gate.promise; return json(remote); };
        const reload = queue.reloadConflictedResource('devices', 10);
        queue.clearPendingSave();
        appState.devices[0].memo = '新しいデータの入力';
        gate.resolve();
        assert.equal(await reload, false);
        assert.equal(appState.devices[0].memo, '新しいデータの入力');
    });

    await t.test('保留対象の不正属性と名称依存は別機器の保存を止めない', async () => {
        fixture();
        appState.resourceConflicts.views.set(1, { kind: 'views', id: 1, name: 'View-1' });
        appState.views[0].name = '';
        appState.views[1].name = 'View-1';
        appState.devices[1].memo = '独立差分';
        await queue.flushSaveQueue({ silent: true });
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0].payload.devices.map(row => row.id), [20]);
        assert.deepEqual(calls[0].payload.views, []);
        assert.equal(appState.views.find(row => row.id === 1).name, '');
        assert.equal(appState.views.find(row => row.id === 2).name, 'View-1');
    });

    await t.test('応答の参照機器は未送信の競合入力を上書きしない', async () => {
        fixture();
        appState.devices[0].memo = '残す競合入力';
        appState.resourceConflicts.devices.set(10, { kind: 'devices', id: 10, name: 'SW-10' });
        const remoteDevice = normalizeDevice({ id: 10, resource_revision: 8, name: 'リモート名称', type: 'switch', memo: 'リモート' });
        appState.views[1].memo = '保存するビュー';
        handler = async (_, payload) => {
            const response = success(payload);
            response.devices.push(remoteDevice);
            return json(response);
        };
        await queue.flushSaveQueue({ silent: true });
        assert.equal(appState.devices.find(row => row.id === 10).memo, '残す競合入力');
        assert.equal(appState.devices.find(row => row.id === 10).name, 'SW-10');
        assert.equal(queue.hasResourceConflict('devices', 10), true);
        assert.equal(calls.length, 1);
    });

    await t.test('未送信の仮IDと採番IDの衝突でも保留入力と通知が追従する', async () => {
        fixture();
        appState.devices.push(normalizeDevice({ id: 30, name: '送信する新規', type: 'switch' }));
        appState.devices.push(normalizeDevice({ id: 1030, name: '保留新規', type: 'switch', memo: '未送信' }));
        appState.resourceConflicts.devices.set(1030, { kind: 'devices', id: 1030, name: '保留新規' });
        drafts.getDeviceDraft('panel', 1030).location = '仮ID下書き';
        const maps = [];
        const off = eventBus.on('resources:ids-remapped', value => maps.push(value));
        await queue.flushSaveQueue({ silent: true });
        off();
        assert.equal(calls.length, 1);
        assert.equal(appState.devices.find(row => row.id === 1030).name, '送信する新規');
        assert.equal(appState.devices.find(row => row.id === 1031).memo, '未送信');
        assert.equal(maps[0].devices[1030], 1031);
        assert.equal(queue.hasResourceConflict('devices', 1031), true);
        assert.equal(drafts.getDeviceDraft('panel', 1031).location, '仮ID下書き');
    });

    await t.test('ビュー再読込で必要機器のみ復元し他機器の削除と入力を残す', async () => {
        fixture();
        const remote = remoteData();
        appState.devices = [];
        appState.placements = [];
        appState.views[1].memo = '他ビュー入力';
        appState.resourceConflicts.views.set(1, { kind: 'views', id: 1, name: 'View-1' });
        handler = async () => json(remote);
        assert.equal(await queue.reloadConflictedResource('views', 1), true);
        assert.deepEqual(appState.devices.map(row => row.id), [10]);
        assert.equal(appState.placements[0].device_id, 10);
        assert.equal(appState.views.find(row => row.id === 2).memo, '他ビュー入力');
        assert.deepEqual(resources.buildResourceSave().devices.map(row => [row.id, row.operation]), [[20, 'delete']]);
    });

    await t.test('機器のリモート削除はその参照だけ整理し同じビューの追加入力を保持する', async () => {
        fixture();
        const remote = remoteData();
        remote.devices = remote.devices.filter(row => row.id !== 10);
        remote.placements = [];
        remote.views[0].resource_revision = 5;
        appState.views[0].memo = 'ビューの追加入力';
        appState.devices[1].memo = '別機器の入力';
        appState.resourceConflicts.devices.set(10, { kind: 'devices', id: 10, name: 'SW-10' });
        handler = async () => json(remote);
        assert.equal(await queue.reloadConflictedResource('devices', 10), true);
        assert.equal(appState.devices.some(row => row.id === 10), false);
        assert.equal(appState.placements.length, 0);
        assert.equal(appState.views.find(row => row.id === 1).memo, 'ビューの追加入力');
        const payload = resources.buildSaveableResourceSave();
        assert.equal(payload.views[0].expected_revision, 5);
        assert.equal(payload.views[0].view.memo, 'ビューの追加入力');
        assert.equal(payload.devices[0].device.memo, '別機器の入力');
    });

    await t.test('機器再読込でビューの別のリモート変更を検出したら上書きせず競合へ残す', async () => {
        fixture();
        const remote = remoteData();
        remote.devices = remote.devices.filter(row => row.id !== 10);
        remote.placements = [];
        remote.views[0].resource_revision = 5;
        remote.views[0].memo = '他利用者のビュー変更';
        appState.views[0].memo = '残すローカルビュー変更';
        appState.devices[1].memo = '独立差分';
        appState.resourceConflicts.devices.set(10, { kind: 'devices', id: 10, name: 'SW-10' });
        handler = async () => json(remote);
        assert.equal(await queue.reloadConflictedResource('devices', 10), true);
        assert.equal(queue.hasResourceConflict('devices', 10), false);
        assert.equal(queue.hasResourceConflict('views', 1), true);
        assert.equal(appState.views.find(row => row.id === 1).memo, '残すローカルビュー変更');
        assert.equal(appState.views.find(row => row.id === 1).resource_revision, 1);
        const payload = resources.buildSaveableResourceSave();
        assert.deepEqual(payload.views, []);
        assert.deepEqual(payload.devices.map(row => row.id), [20]);
    });

    await t.test('旧POSTの応答待ちを全読込で無効化しても新世代の確定要求は直列保存される', async () => {
        fixture();
        appState.devices[0].memo = '旧世代で送信';
        const gate = deferred();
        let oldResponse;
        let requests = 0;
        handler = async (_, payload) => {
            const response = success(payload);
            if (++requests === 1) {
                oldResponse = response;
                await gate.promise;
            }
            return json(response);
        };
        const flight = queue.flushSaveQueue({ silent: true });
        queue.clearPendingSave();
        appState.devices[0] = normalizeDevice(oldResponse.devices[0]);
        appState.dataRevision = oldResponse.revision;
        resources.resetResourceBaseline(appState);
        drafts.getDeviceDraft('ledger', 20).memo = '新世代の確定';
        assert.equal(drafts.commitDeviceDraft('ledger', 20), true);
        queue.scheduleSave({ immediate: true, silent: true });
        gate.resolve();
        assert.equal(await flight, true);
        assert.equal(calls.length, 2);
        assert.deepEqual(calls[1].payload.devices.map(row => row.id), [20]);
        assert.equal(calls[1].payload.devices[0].device.memo, '新世代の確定');
        assert.equal(appState.devices.find(row => row.id === 20).memo, '新世代の確定');
        assert.equal(queue.hasPendingChanges(), false);
        assert.equal(queue.isSaveInFlight(), false);
    });

    await t.test('対象再読込のリモート参照IDが未保存仮IDと重なっても新規と下書きを退避する', async () => {
        fixture();
        const remote = remoteData();
        remote.devices.push(normalizeDevice({ id: 30, resource_revision: 7, name: 'リモート機器', type: 'switch' }));
        remote.placements.push(normalizePlacement({ id: 200, view_id: 1, device_id: 30, x: 50, y: 60 }));
        remote.views[0].resource_revision = 7;
        appState.devices.push(normalizeDevice({ id: 30, name: '保存前の新規', type: 'switch' }));
        appState.placements.push(normalizePlacement({ id: 200, view_id: 2, device_id: 30, x: 70, y: 80 }));
        drafts.getDeviceDraft('panel', 30).memo = '仮ID下書き';
        appState.selectedPlacementIds.add(200);
        appState.resourceConflicts.views.set(1, { kind: 'views', id: 1, name: 'View-1' });
        handler = async () => json(remote);
        assert.equal(await queue.reloadConflictedResource('views', 1), true);
        assert.equal(appState.devices.find(row => row.id === 30).name, 'リモート機器');
        assert.equal(appState.devices.find(row => row.id === 31).name, '保存前の新規');
        assert.equal(drafts.getDeviceDraft('panel', 31).memo, '仮ID下書き');
        assert.equal(appState.placements.find(row => row.id === 200).device_id, 30);
        assert.equal(appState.placements.find(row => row.id === 201).device_id, 31);
        assert.equal(appState.selectedPlacementIds.has(201), true);
        assert.deepEqual(resources.buildResourceSave().devices.map(row => [row.id, row.operation]), [[31, 'create']]);
    });

    await t.test('確定済み同一対象の422差分は個票から再試行でき通信中はretryだけを無効化する', async () => {
        fixture();
        await openLedgerDetail(10);
        appState.devices[0].memo = '再試行する確定値';
        handler = async () => json({ ok: false, error: '保存拒否' }, 422);
        assert.equal(await queue.flushSaveQueue({ silent: true }), false);
        assert.equal(queue.hasResourceChanges('devices', 10), true);
        assert.equal(queue.hasResourceChanges('devices', 20), false);
        assert.equal(element('ledger-sheet-save-btn').disabled, false);
        const gate = deferred();
        handler = async (_, payload) => { await gate.promise; return json(success(payload)); };
        const retry = queue.flushSaveQueue({ silent: true });
        assert.equal(element('ledger-sheet-save-btn').disabled, true);
        drafts.getDeviceDraft('sheet', 10).location = '再試行中の新しい下書き';
        eventBus.emit('device-drafts:changed');
        assert.equal(element('ledger-sheet-save-btn').disabled, false);
        gate.resolve();
        assert.equal(await retry, true);
        assert.equal(queue.hasResourceChanges('devices', 10), false);
        assert.equal(drafts.getDeviceDraft('sheet', 10).location, '再試行中の新しい下書き');
        assert.equal(calls.length, 2);
    });

    await t.test('上部保存は未適用下書きで有効化せず個票は自身の下書きだけ対象にする', async () => {
        fixture();
        await openLedgerDetail(10);
        drafts.getDeviceDraft('sheet', 10).memo = '未適用';
        eventBus.emit('device-drafts:changed');
        assert.equal(element('saveBtn').disabled, true);
        assert.equal(element('ledger-sheet-save-btn').disabled, false);
        drafts.discardDeviceDraft('sheet', 10);
        appState.devices[1].memo = '他の確定変更';
        queue.updateSaveButtonState();
        assert.equal(element('saveBtn').disabled, false);
        assert.equal(element('ledger-sheet-save-btn').disabled, true);
        appState.resourceConflicts.devices.set(10, { id: 10, name: 'SW-10' });
        queue.updateSaveButtonState();
        assert.equal(element('ledger-sheet-save-btn').disabled, false);
        assert.equal(element('ledger-sheet-save-btn').textContent, '競合を再読込');
        appState.authExpired = true;
        queue.updateSaveButtonState();
        assert.equal(element('ledger-sheet-save-btn').disabled, true);
    });

    await t.test('新規メモの後続編集と採番衝突を共通キューで直列保存し選択を追従する', async () => {
        fixture();
        appState.canvasNotes.push(normalizeCanvasNote({ id: 1, view_id: 1, text: '送信本文' }));
        appState.selectedCanvasNoteId = 1;
        const gate = deferred();
        let requests = 0;
        handler = async (_, payload) => {
            const result = success(payload);
            if (++requests === 1) await gate.promise;
            return json(result);
        };
        const flight = queue.flushSaveQueue({ silent: true });
        assert.equal(calls.length, 1);
        appState.canvasNotes[0].text = '応答待ちの追加入力';
        appState.canvasNotes.push(normalizeCanvasNote({ id: 1001, view_id: 1, text: '未送信の追加メモ' }));
        appState.selectedCanvasNoteId = 1001;
        queue.flushSaveQueue({ silent: true });
        assert.equal(calls.length, 1);
        assert.equal(queue.getPendingSave().snapshot.canvasNotes[0].text, '送信本文');
        gate.resolve();
        assert.equal(await flight, true);
        assert.equal(calls.length, 2);
        assert.equal(calls[1].payload.views[0].expected_revision, 2);
        assert.deepEqual(calls[1].payload.views[0].canvas_notes.map(note => [note.id, note.text]),
            [[1001, '応答待ちの追加入力'], [1002, '未送信の追加メモ']]);
        assert.equal(appState.selectedCanvasNoteId, 2002);
        assert.deepEqual(appState.canvasNotes.map(note => [note.id, note.text]),
            [[1001, '応答待ちの追加入力'], [2002, '未送信の追加メモ']]);
        assert.equal(queue.hasPendingChanges(), false);
    });

    await t.test('メモの409は所属ビューだけを保留し独立ビューを保存・再読込する', async () => {
        fixture();
        appState.canvasNotes = [1, 2].map(id => normalizeCanvasNote({ id, view_id: id, text: '保存前' }));
        resources.resetResourceBaseline(appState);
        appState.canvasNotes[0].text = '競合側の入力';
        appState.canvasNotes[1].text = '独立した入力';
        appState.currentViewId = 2;
        appState.selectedCanvasNoteId = 2;
        let first = true;
        handler = async (_, payload) => {
            if (first) {
                first = false;
                return json({ ok: false, error: '競合', details: {
                    conflicts: [{ kind: 'views', id: 1, name: 'View-1' }]
                } }, 409);
            }
            return json(success(payload));
        };
        assert.equal(await queue.flushSaveQueue({ silent: true }), true);
        assert.equal(calls.length, 2);
        assert.deepEqual(calls[1].payload.views.map(row => row.id), [2]);
        assert.equal(appState.canvasNotes[0].text, '競合側の入力');
        assert.equal(appState.canvasNotes[1].text, '独立した入力');
        assert.equal(queue.hasResourceConflict('views', 1), true);
        assert.equal(queue.hasResourceConflict('views', 2), false);
        const remote = remoteData();
        remote.canvas_notes[0].text = '他利用者の本文';
        remote.views[0].resource_revision = 7;
        handler = async () => json(remote);
        assert.equal(await queue.reloadConflictedResource('views', 1), true);
        assert.equal(appState.canvasNotes.find(note => note.id === 1).text, '他利用者の本文');
        assert.equal(appState.canvasNotes.find(note => note.id === 2).text, '独立した入力');
        assert.equal(appState.selectedCanvasNoteId, 2);
        assert.equal(queue.hasPendingChanges(), false);
    });

    await t.test('新規メモの応答喪失は同じ本文のリモート行から採番を推測しない', async () => {
        fixture();
        appState.canvasNotes.push(normalizeCanvasNote({ id: 1, view_id: 1, text: '本文' }));
        handler = async () => { throw new Error('応答喪失'); };
        assert.equal(await queue.flushSaveQueue({ silent: true }), false);
        const remote = remoteData();
        remote.views[0].resource_revision = 2;
        remote.canvas_notes[0].id = 900;
        handler = async () => json(remote);
        assert.equal(await queue.confirmPendingSave(), 'unknown');
        assert.equal(calls.filter(row => row.action === 'save_resources').length, 1);
        assert.equal(appState.canvasNotes[0].id, 1);
        assert.ok(queue.getPendingSave());
    });

    await t.test('メモ配列のない旧保存応答は未確認として本文を保持する', async () => {
        fixture();
        appState.canvasNotes.push(normalizeCanvasNote({ id: 1, view_id: 1, text: '失わない本文' }));
        handler = async (_, payload) => {
            const old = success(payload);
            delete old.canvas_notes;
            return json(old);
        };
        assert.equal(await queue.flushSaveQueue({ silent: true }), false);
        assert.equal(appState.canvasNotes[0].text, '失わない本文');
        assert.equal(appState.canvasNotes[0].id, 1);
        assert.ok(queue.getPendingSave());
        assert.equal(appState.appStatus.state, 'unconfirmed');
    });

    await t.test('loadと全体データ取得はメモを含み旧データは空配列へ切り替える', async sub => {
        fixture();
        elements.clear();
        const lookup = document.getElementById;
        document.getElementById = id => elements.get(id) ?? null;
        sub.after(() => { document.getElementById = lookup; });
        const toolbar = await import('../public/js/ui/toolbar.js');
        const remote = remoteData();
        remote.canvas_notes = [normalizeCanvasNote({ id: 50, view_id: 1, text: '  改行\n本文  ' })];
        handler = async () => json(remote);
        await toolbar.loadData();
        assert.equal(appState.canvasNotes[0].text, '  改行\n本文  ');
        assert.equal(appState.nextCanvasNoteId, 51);
        assert.deepEqual(toolbar.getCurrentData().canvas_notes, remote.canvas_notes);
        delete remote.canvas_notes;
        await toolbar.loadData();
        assert.deepEqual(appState.canvasNotes, []);
        assert.deepEqual(toolbar.getCurrentData().canvas_notes, []);
        assert.equal(appState.nextCanvasNoteId, 1);
    });
});
