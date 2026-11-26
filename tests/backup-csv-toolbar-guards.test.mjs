import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installWorkspaceDom } from './helpers/workspace-dom.mjs';

test('PR 3 ガード検証: backup-modal, csv-modal, toolbar, toolbar-controls', async t => {
    const keys = ['window', 'document', 'HTMLElement', 'Element', 'fetch', 'confirm', 'FormData', 'requestAnimationFrame', 'cancelAnimationFrame'];
    const originals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const dom = installWorkspaceDom({
        templates: [
            'templates/components/toolbar.php',
            'templates/components/tool_palette.php',
            'templates/components/status_bar.php',
            'templates/components/toast.php',
            'templates/modals/backup.php',
            'templates/modals/csv_import.php'
        ],
        phpSetup: "define('NETARIUM_VERSION', '2.0.0'); $isAdmin = true; $username = 'admin'; $userRole = 'admin'; $csrfToken = 'test-csrf'; $storageCapacity = ['backup' => ['max_zip_bytes' => 25165824, 'max_uncompressed_bytes' => 67108864]];"
    });
    if (typeof globalThis.FormData === 'undefined') {
        globalThis.FormData = class { append() {} };
    }
    const confirmMessages = [];
    let confirmResult = false;
    globalThis.confirm = msg => { confirmMessages.push(String(msg)); return confirmResult; };
    window.confirm = globalThis.confirm;
    window.location = { href: 'http://localhost/' };
    window.requestAnimationFrame = cb => { cb(); return 0; };
    window.cancelAnimationFrame = () => {};

    const { appState, normalizeDevice, normalizeView } = await import('../public/js/core/state.js');
    const { eventBus } = await import('../public/js/core/event-bus.js');
    const { clearPendingSave, scheduleSave } = await import('../public/js/core/save-queue.js');
    const { getDeviceDraft, discardDeviceDrafts } = await import('../public/js/core/device-drafts.js');
    const { resetResourceBaseline } = await import('../public/js/core/resource-save.js');
    const backup = await import('../public/js/modals/backup-modal.js');
    const csv = await import('../public/js/modals/csv-modal.js');
    const toolbar = await import('../public/js/ui/toolbar.js');
    const { syncViewCapabilities } = await import('../public/js/ui/toolbar-controls.js');

    const prevAppState = { ...appState };
    t.after(() => {
        clearPendingSave();
        discardDeviceDrafts();
        delete window.hasAnyUnappliedChanges;
        Object.assign(appState, prevAppState);
        for (const [key, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    });

    function resetState() {
        clearPendingSave();
        discardDeviceDrafts();
        delete window.hasAnyUnappliedChanges;
        window.APP_CONFIG.user.isAdmin = true;
        window.APP_CONFIG.csrfToken = 'test-csrf';
        Object.assign(appState, {
            views: [normalizeView({ id: 1, name: 'V1', view_type: 'topology', resource_revision: 1 })],
            devices: [normalizeDevice({ id: 1, name: 'D1', type: 'switch', resource_revision: 1 })],
            placements: [],
            links: [],
            canvasNotes: [],
            floorPlans: [],
            deviceImages: [],
            rackSettings: [],
            rackMounts: [],
            rackShelves: [],
            rackShelfDevices: [],
            floorRackPlacements: [],
            currentViewId: 1,
            authExpired: false,
            isSaving: false,
            isPinging: false,
            isDevicesCsvImporting: false,
            isFloorPlanUpdating: false,
            isBackupExporting: false,
            dataRevision: 1,
            appStatus: { dirty: false, state: 'saved', lastError: null, lastSavedAt: null },
            resourceConflicts: { devices: new Map(), views: new Map() }
        });
        resetResourceBaseline(appState);
    }

    // 1. backup-modal: openBackupRestore ガード & 410/409 でトークンクリア
    await t.test('backup-modal: openBackupRestoreの各種ガードと410失敗時トークンクリア', async () => {
        resetState();
        for (const block of [
            () => { appState.authExpired = true; },
            () => { appState.devices[0].name = '変更'; }, // hasPendingChanges
            () => { window.hasAnyUnappliedChanges = () => true; }
        ]) {
            resetState();
            block();
            backup.openBackupRestore();
            assert.equal(dom.get('backup-restore-overlay').hidden, true);
        }

        resetState();
        backup.openBackupRestore();
        assert.equal(dom.get('backup-restore-overlay').hidden, false);

        const fileInput = dom.get('backup-restore-file');
        const dummyFile = typeof File !== 'undefined'
            ? new File(['zip'], 'backup.zip', { type: 'application/zip' })
            : { name: 'backup.zip', size: 100 };
        Object.defineProperty(fileInput, 'files', { value: [dummyFile], configurable: true });

        const restoreTokens = [];
        globalThis.fetch = async (url, options) => {
            const action = new URL(String(url), 'http://localhost').searchParams.get('action');
            if (action === 'preview_backup_restore') {
                return Response.json({
                    ok: true,
                    restore_token: 'tok-123',
                    can_restore: true,
                    expires_at: '2026-01-02',
                    backup: {
                        name: 'backup.zip',
                        created_at: '2026-01-01T00:00:00Z',
                        application_version: '2.0.0',
                        counts: { views: 1, devices: 1, monitor: 0, placements: 0, links: 0, link_systems: 0, notes: 0, floor_plans: 0, device_images: 0, racks: 0, rack_mounts: 0 }
                    },
                    image_matches: []
                });
            }
            restoreTokens.push(JSON.parse(options.body).restore_token);
            if (restoreTokens.length === 1) {
                return Response.json({ ok: false, error: '別の更新処理中', details: { reason: 'operation_busy' } }, { status: 409 });
            }
            return Response.json({ ok: false, error: '有効期限切れ' }, { status: 410 });
        };

        await backup.previewBackupRestore();
        dom.get('backup-restore-confirmation').value = 'バックアップから復元';
        backup.updateBackupRestoreButtons();
        assert.equal(dom.get('backup-restore-commit-btn').disabled, false);

        confirmResult = true;
        await backup.commitBackupRestore();
        assert.equal(dom.get('backup-restore-commit-btn').disabled, false, '一時拒否後は同じプレビューで再試行できる');
        await backup.commitBackupRestore();
        assert.equal(dom.get('backup-restore-commit-btn').disabled, true, '410失敗後は再実行不可へリセットする');
        assert.deepEqual(restoreTokens, ['tok-123', 'tok-123']);
        backup.closeBackupRestore();
    });

    // 2. csv-modal: canStartDeviceCsvDownload ガード & 409時トークン/メッセージクリア・警告フィルタ
    await t.test('csv-modal: ダウンロードガード・unchanged警告除外・409後トークンクリア', async () => {
        resetState();
        for (const block of [
            () => { appState.authExpired = true; },
            () => { getDeviceDraft('ledger', 1).memo = '下書き'; },
            () => { appState.devices[0].memo = '未保存変更'; },
            () => { window.hasAnyUnappliedChanges = () => true; },
            () => { appState.devices[0].memo = '送信中'; scheduleSave({ debounceMs: 60000, silent: true }); }
        ]) {
            resetState();
            block();
            assert.equal(csv.canStartDeviceCsvDownload(), false);
        }

        resetState();
        assert.equal(csv.canStartDeviceCsvDownload(), true);
        csv.openDevicesCsvImport();

        const csvInput = dom.get('devices-csv-import-file');
        const dummyCsv = typeof File !== 'undefined'
            ? new File(['id,name\n1,D1\n'], 'devices.csv', { type: 'text/csv' })
            : { name: 'devices.csv', size: 32 };
        Object.defineProperty(csvInput, 'files', { value: [dummyCsv], configurable: true });

        const importTokens = [];
        globalThis.fetch = async (url, options) => {
            const action = new URL(String(url), 'http://localhost').searchParams.get('action');
            if (action === 'preview_devices_csv_import') {
                return Response.json({
                    ok: true,
                    import_token: 'csv-tok-1',
                    can_commit: true,
                    summary: { insert: 1, update: 0, unchanged: 1, warning: 2, error: 0, total: 2 },
                    rows: [
                        { line: 2, operation: 'unchanged', warnings: [{ message: '未分類IP警告_除外対象' }], errors: [], changes: [] },
                        { line: 3, operation: 'insert', warnings: [{ message: '取込行警告_表示対象' }], errors: [], changes: [] }
                    ]
                });
            }
            importTokens.push(JSON.parse(options.body).import_token);
            if (importTokens.length === 1) {
                return Response.json({ ok: false, error: '復元処理中', details: { reason: 'operation_busy' } }, { status: 409 });
            }
            return Response.json({ ok: false, error: '版数競合' }, { status: 409 });
        };

        await csv.previewDevicesCsvImport();
        dom.get('devices-csv-import-message').textContent = '前回の成功メッセージ';
        confirmMessages.length = 0;
        confirmResult = true;
        await csv.commitDevicesCsvImport();

        assert.equal(confirmMessages.length, 1);
        assert.ok(confirmMessages[0].includes('警告行: 1件'));
        assert.ok(confirmMessages[0].includes('取込行警告_表示対象'));
        assert.equal(confirmMessages[0].includes('未分類IP警告_除外対象'), false, 'unchanged行の警告は確認文に含めない');
        assert.equal(dom.get('devices-csv-commit-btn').disabled, false);
        assert.equal(appState.appStatus.dirty, false, '一時的な拒否を編集競合として扱わない');
        await csv.commitDevicesCsvImport();
        assert.deepEqual(importTokens, ['csv-tok-1', 'csv-tok-1']);
        assert.equal(dom.get('devices-csv-commit-btn').disabled, true, '409失敗後は確定ボタンを無効化する');
        assert.equal(dom.get('devices-csv-import-message').textContent, '');
        csv.closeDevicesCsvImport();
    });

    // 3. toolbar: exportBackupZip 401/保守拒否404 & setBusy ids disabled 状態維持 & syncViewCapabilities イベント購読
    await t.test('toolbar: exportBackupZip 401時非再有効化・保守404・setBusyのids状態復元', async () => {
        resetState();
        const exportBtn = dom.get('backup-export-btn');
        const saveBtn = dom.get('saveBtn');
        saveBtn.disabled = true;

        toolbar.setBusy(true, '実行中');
        assert.equal(saveBtn.disabled, true);
        toolbar.setBusy(false);
        assert.equal(saveBtn.disabled, true, 'setBusy前にdisabledだったids要素を勝手に有効化しない');

        globalThis.fetch = async url => {
            const rejected = new Response(JSON.stringify({
                ok: false,
                error_code: 'NETARIUM_MAINTENANCE_REJECTED',
                contract_version: 1,
                request_execution: 'not_started',
                operation_id: 'op-1'
            }), { status: 404, headers: { 'Content-Type': 'application/json' } });
            Object.defineProperty(rejected, 'url', { value: new URL(String(url), 'http://localhost').href });
            return rejected;
        };
        await toolbar.exportBackupZip();
        assert.match(dom.get('toast').textContent, /保守作業中/);
        assert.equal(exportBtn.disabled, false);

        globalThis.fetch = async () => new Response('', { status: 401 });
        await toolbar.exportBackupZip();
        assert.equal(appState.authExpired, true);
        assert.equal(exportBtn.disabled, true, '401失効後はexportボタンを再有効化しない');

        resetState();
        syncViewCapabilities();
        const placeBtn = dom.get('palette-place-btn');
        assert.equal(placeBtn.disabled, false);
        appState.isPinging = true;
        eventBus.emit('ping:busy-changed');
        assert.equal(placeBtn.disabled, true);
        appState.isPinging = false;
        eventBus.emit('ping:busy-changed');
        assert.equal(placeBtn.disabled, false);
        appState.authExpired = true;
        eventBus.emit('auth:expired');
        assert.equal(placeBtn.disabled, true);
    });
});
