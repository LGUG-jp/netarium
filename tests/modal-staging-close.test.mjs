import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { installWorkspaceDom } from './helpers/workspace-dom.mjs';
import { appState } from '../public/js/core/state.js';
import { eventBus } from '../public/js/core/event-bus.js';
import { BACKUP_RESTORE_CONFIRMATION } from '../public/js/core/constants.js';
import { registerModalClose, getTopModalContainer } from '../public/js/core/modal-focus.js';
import { onKeyDown } from '../public/js/canvas/selection.js';
import { resetResourceBaseline } from '../public/js/core/resource-save.js';
import { clearPendingSave, flushSaveQueue } from '../public/js/core/save-queue.js';
import { openDevicesCsvImport, closeDevicesCsvImport, resetDevicesCsvImportPreview, previewDevicesCsvImport, commitDevicesCsvImport } from '../public/js/modals/csv-modal.js';
import { openBackupRestore, closeBackupRestore, resetBackupRestorePreview, previewBackupRestore, commitBackupRestore } from '../public/js/modals/backup-modal.js';
import { initializeLinkBulkModal, openLinkBulkModal, closeLinkBulkModal, previewLinkBulkModal, applyLinkBulkModal } from '../public/js/modals/link-bulk-modal.js';
import { initializeAccountManagement, openUserManagement, openPasswordChange, closeAccountManagement, refreshUserList } from '../public/js/modals/account-modal.js';

const response = data => new Response(JSON.stringify({ ok: true, ...data }));
const drain = async () => { for (let i = 0; i < 4; i++) await setImmediate(); };
const escape = () => onKeyDown({ key: 'Escape', preventDefault() {}, stopImmediatePropagation() {} });
function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

async function setup(t, template) {
    const keys = ['window', 'document', 'HTMLElement', 'Element', 'fetch', 'confirm', 'alert'];
    const globals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const original = { ...appState };
    const listeners = new Map([...eventBus.listeners].map(([name, callbacks]) => [name, new Set(callbacks)]));
    const dom = installWorkspaceDom({ templates: [template], phpSetup: "$storageCapacity = ['backup' => ['max_zip_bytes' => 104857600]];" });
    document.readyState = 'loading';
    const { registerStaticListeners } = await import('../public/js/main.js');
    registerStaticListeners();
    Object.assign(appState, {
        views: [], devices: [], placements: [], links: [], linkSystems: [], canvasNotes: [], floorPlans: [], deviceImages: [],
        currentViewId: null, currentSvg: null, deviceLayer: null, floorPlanLayer: null,
        selectedPlacementIds: new Set(), floorPlanAutoFittedViews: new Set(),
        viewStates: new Map(), viewState: { ...original.viewState },
        editingDeviceId: null, editingLinkId: null,
        authExpired: false, isSaving: false, isPinging: false, isDevicesCsvImporting: false,
        isFloorPlanUpdating: false, isBackupExporting: false, isRangeSelecting: false,
        dataRevision: 1, monitorRevision: 1, resourceConflicts: { devices: new Map(), views: new Map() },
        appStatus: { dirty: false, state: 'saved', lastError: null }
    });
    clearPendingSave();
    resetResourceBaseline(appState);
    window.confirm = globalThis.confirm = () => true;
    globalThis.alert = () => {};
    const redirects = [];
    window.location = { replace: destination => redirects.push(destination) };
    const requests = [];
    let handler = () => { throw new Error('API stub未設定'); };
    globalThis.fetch = (url, options) => {
        const action = new URL(url, 'http://localhost/').searchParams.get('action');
        const input = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
        requests.push({ action, input });
        return handler(action, input);
    };
    t.after(() => {
        window.confirm = () => true;
        closeDevicesCsvImport(); closeBackupRestore(); closeLinkBulkModal(); closeAccountManagement();
        for (const id of ['csv_import', 'backup', 'link-bulk', 'account']) registerModalClose(id, { restoreFocus: false });
        clearPendingSave();
        eventBus.listeners = listeners;
        Object.assign(appState, original);
        resetResourceBaseline(appState);
        for (const [key, descriptor] of globals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    });
    return { dom, requests, redirects, api: callback => { handler = callback; } };
}

function selectFile(dom, id, reset, extension) {
    const input = dom.get(id);
    input.files = [new Blob(['synthetic staging input'], { type: extension === 'csv' ? 'text/csv' : 'application/zip' })];
    input.value = `C:\\fakepath\\staging.${extension}`;
    reset();
    return input;
}
function closers(overlay) {
    return [() => overlay.querySelector('.modal-close-btn').click(), () => overlay.click(), escape];
}
async function assertBusyClose(overlay, confirmations) {
    const before = confirmations();
    for (const close of closers(overlay)) {
        await close();
        assert.equal(overlay.hidden, false, '処理中の入力・結果を閉鎖しない');
        assert.equal(getTopModalContainer(), overlay);
    }
    assert.equal(confirmations(), before, '処理中は破棄確認も起動しない');
}

const imports = [
    { label: 'CSV', template: 'templates/modals/csv_import.php', overlay: 'devices-csv-import-overlay', file: 'devices-csv-import-file',
        result: 'devices-csv-import-result', extension: 'csv',
        open: openDevicesCsvImport, reset: resetDevicesCsvImportPreview, preview: previewDevicesCsvImport, commit: commitDevicesCsvImport,
        previewAction: 'preview_devices_csv_import', commitAction: 'commit_devices_csv_import',
        previewData: { import_token: 'csv-staging-token', can_commit: true, summary: { total: 1, insert: 1 },
            rows: [{ line: 2, operation: 'insert', name: '合成取込機器', ip: '192.0.2.10' }] } },
    { label: 'backup', template: 'templates/modals/backup.php', overlay: 'backup-restore-overlay', file: 'backup-restore-file',
        result: 'backup-restore-result', extension: 'zip',
        open: openBackupRestore, reset: resetBackupRestorePreview, preview: previewBackupRestore, commit: commitBackupRestore,
        previewAction: 'preview_backup_restore', commitAction: 'commit_backup_restore',
        previewData: { restore_token: 'backup-staging-token', can_restore: true, backup: { name: '合成復元対象', counts: { devices: 7 } } } }
];

for (const spec of imports) {
    test(`${spec.label}: file・検証結果の破棄拒否/許可、検証・確定中の閉鎖抑止と遅延応答`, async t => {
        const { dom, requests, redirects, api } = await setup(t, spec.template);
        const overlay = dom.get(spec.overlay);
        let discard = false;
        let confirmations = 0;
        window.confirm = globalThis.confirm = () => { confirmations++; return discard; };
        api(action => {
            assert.equal(action, spec.previewAction);
            return response(spec.previewData);
        });
        // file選択だけでも、preview完成後でも、すべての閉じ方が同じ入力を保護する。
        for (const previewed of [false, true]) {
            for (const close of closers(overlay)) {
                spec.open();
                const file = selectFile(dom, spec.file, spec.reset, spec.extension);
                if (previewed) await spec.preview();
                const before = confirmations;
                await close();
                assert.equal(confirmations, before + 1);
                assert.equal(overlay.hidden, false);
                assert.ok(file.value.endsWith(`staging.${spec.extension}`));
                assert.equal(dom.get(spec.result).hidden, !previewed);
                if (previewed && spec.label === 'CSV') assert.match(dom.get('devices-csv-import-rows').textContent, /合成取込機器/);
                if (previewed && spec.label === 'backup') assert.equal(dom.get('backup-restore-devices').textContent, '7');
                discard = true;
                await close();
                assert.equal(confirmations, before + 2);
                assert.equal(overlay.hidden, true);
                assert.equal(file.value, '');
                assert.equal(file.files.length, 0);
                assert.equal(getTopModalContainer(), null);
                discard = false;
            }
        }
        assert.equal(requests.filter(request => request.action === spec.commitAction).length, 0);
        spec.open();
        selectFile(dom, spec.file, spec.reset, spec.extension);
        const validation = deferred();
        api(action => { assert.equal(action, spec.previewAction); return validation.promise; });
        const validating = spec.preview();
        await assertBusyClose(overlay, () => confirmations);
        validation.resolve(response(spec.previewData));
        await validating;
        assert.equal(overlay.hidden, false);
        assert.equal(dom.get(spec.result).hidden, false);
        if (spec.label === 'backup') {
            dom.get('backup-restore-confirmation').value = BACKUP_RESTORE_CONFIRMATION;
        }
        // 確定確認を拒否してもpreview/tokenは失われず、確定APIは呼ばれない。
        await spec.commit();
        assert.equal(requests.filter(request => request.action === spec.commitAction).length, 0);
        assert.equal(overlay.hidden, false);
        discard = true;
        const committingResponse = deferred();
        const reload = deferred();
        const loadStarted = deferred();
        api((action, input) => {
            if (action === spec.commitAction) {
                assert.equal(input[spec.label === 'CSV' ? 'import_token' : 'restore_token'], spec.label === 'CSV' ? 'csv-staging-token' : 'backup-staging-token');
                return committingResponse.promise;
            }
            assert.equal(action, 'load');
            loadStarted.resolve();
            return reload.promise;
        });
        const committing = spec.commit();
        await assertBusyClose(overlay, () => confirmations);
        const confirmedCount = confirmations;
        if (spec.label === 'CSV') {
            committingResponse.resolve(response({ revision: 2, monitor_revision: 3 }));
            await loadStarted.promise;
            assert.equal(overlay.hidden, true, '確定成功後、再読込の応答を待たずに閉じる');
            assert.equal(getTopModalContainer(), null);
            reload.resolve(response({ revision: 2, monitor_revision: 3, views: [],
                devices: [{ id: 10, name: '合成取込機器', type: 'switch', ip: '192.0.2.10', resource_revision: 1 }] }));
            await committing;
            assert.equal(appState.devices[0].name, '合成取込機器');
            assert.equal(appState.dataRevision, 2);
            assert.equal(appState.appStatus.dirty, false);
            assert.equal(overlay.hidden, true, '遅延再読込で閉鎖済みoverlayを復活させない');
            assert.equal(getTopModalContainer(), null);
        } else {
            committingResponse.resolve(response({ session_ended: false, redirect: 'index.php' }));
            await committing;
            assert.deepEqual(redirects, ['index.php']);
            assert.equal(overlay.hidden, true, '復元成功後はredirect前にoverlayを閉じる');
            assert.equal(getTopModalContainer(), null);
        }
        assert.equal(confirmations, confirmedCount, '成功閉鎖では破棄確認を再実行しない');
        assert.equal(requests.filter(request => request.action === spec.commitAction).length, 1);
    });
}

test('CSV: 追加 IP の全削除・新規 JSON を安全に表示し、対象付き警告を確定時にも確認する', async t => {
    const { dom, requests, api } = await setup(t, 'templates/modals/csv_import.php');
    const oldIps = JSON.stringify([{ ip: '192.0.2.20', label: '削除する用途' }]);
    const newIps = JSON.stringify([
        { ip: '192.0.2.30', label: '<img src=x onerror=alert(1)>' },
        { ip: '192.0.2.31', label: '保守' }
    ]);
    const warning = 'IP 192.0.2.30 は ID 9「既存機器」と重複します';
    const preview = {
        import_token: 'additional-ips-token', can_commit: true,
        summary: { total: 3, insert: 1, update: 1, unchanged: 1, warning: 1, error: 0 },
        rows: [
            { line: 2, id: 1, operation: 'update', name: '全削除機器', ip: '192.0.2.10',
                changed_fields: ['additional_ips'],
                changes: [{ field: 'additional_ips', label: '追加IPv4アドレス', before: oldIps, after: '[]' }] },
            { line: 3, operation: 'insert', name: '追加 IP 付き新規機器', ip: '',
                changes: [{ field: 'additional_ips', label: '追加IPv4アドレス', before: '[]', after: newIps }],
                warnings: [{ message: warning }] },
            { line: 4, id: 2, operation: 'unchanged', name: '空欄で既存保持', ip: '',
                changed_fields: [], changes: [] }
        ]
    };
    api(action => {
        assert.equal(action, 'preview_devices_csv_import');
        return response(preview);
    });
    openDevicesCsvImport();
    selectFile(dom, 'devices-csv-import-file', resetDevicesCsvImportPreview, 'csv');
    await previewDevicesCsvImport();
    const rows = dom.get('devices-csv-import-rows').children;
    assert.equal(rows.length, 3);
    assert.equal(rows[0].querySelector('.csv-import-change-label').textContent, '追加IPv4アドレス');
    assert.equal(rows[1].querySelector('.csv-import-change-label').textContent, '追加IPv4アドレス');
    assert.equal(rows[0].querySelector('.csv-import-change-before').textContent, oldIps);
    assert.equal(rows[0].querySelector('.csv-import-change-after').textContent, '[]（全削除）');
    assert.match(rows[1].textContent, /新規登録/);
    assert.equal(rows[1].querySelector('.csv-import-change-after').textContent, newIps);
    assert.equal(rows[1].querySelector('img'), null, '用途ラベルを HTML として解釈しない');
    assert.equal(rows[1].classList.contains('csv-import-row-warning'), true);
    assert.ok(rows[1].textContent.includes(warning));
    assert.equal(rows[2].querySelector('.csv-import-change-list').textContent, '変更なし');
    assert.equal(dom.get('devices-csv-warning').textContent, '1');
    assert.equal(dom.get('devices-csv-commit-btn').disabled, false, '警告だけなら確定可能');
    const confirmations = [];
    let accept = false;
    window.confirm = globalThis.confirm = message => { confirmations.push(message); return accept; };
    await commitDevicesCsvImport();
    assert.ok(confirmations[0].includes(`行 3: ${warning}`));
    assert.match(confirmations[0], /警告行: 1件/);
    assert.equal(requests.length, 1, '確認キャンセルでは確定 API を呼ばない');
    assert.equal(dom.get('devices-csv-import-result').hidden, false);
    assert.equal(rows[0].querySelector('.csv-import-change-after').textContent, '[]（全削除）');
    accept = true;
    api((action, input) => {
        if (action === 'commit_devices_csv_import') {
            assert.equal(input.import_token, 'additional-ips-token');
            return response({ revision: 2, monitor_revision: 1 });
        }
        assert.equal(action, 'load');
        return response({ revision: 2, monitor_revision: 1, views: [], devices: [] });
    });
    await commitDevicesCsvImport();
    assert.ok(confirmations[1].includes(`行 3: ${warning}`));
    assert.equal(requests.filter(request => request.action === 'commit_devices_csv_import').length, 1);
    assert.equal(dom.get('devices-csv-import-overlay').hidden, true);
});

test('backup: 長い選択名を安全に表示し、検証拒否でも保持して選択解除で消す', async t => {
    const { dom, requests } = await setup(t, 'templates/modals/backup.php');
    openBackupRestore();
    const input = dom.get('backup-restore-file');
    const name = dom.get('backup-restore-file-name');
    const emptyName = name.textContent;
    const filename = `${'長いバックアップ名'.repeat(30)}<img src=x>.zip`;
    const file = new Blob(['synthetic backup'], { type: 'application/zip' });
    Object.defineProperty(file, 'name', { value: filename });
    Object.defineProperty(file, 'size', { value: 104857601 });
    input.files = [file];
    input.value = `C:\\fakepath\\${filename}`;
    resetBackupRestorePreview();
    assert.equal(name.textContent, filename);
    assert.equal(name.querySelector('img'), null, 'ファイル名をHTMLとして解釈しない');
    await previewBackupRestore();
    assert.equal(requests.length, 0, '容量超過は既存の送信前検証で拒否する');
    assert.equal(input.files[0], file);
    assert.equal(name.textContent, filename);
    assert.equal(dom.get('backup-restore-file-error').hidden, false);
    input.value = '';
    resetBackupRestorePreview();
    assert.equal(name.textContent, emptyName);
    assert.equal(dom.get('backup-restore-preview-btn').disabled, true);
    assert.equal(dom.get('backup-restore-file-error').hidden, true);
});

test('link-bulk: checkboxだけの入力も保護し、適用・自動保存済みの変更は閉鎖で戻さない', async t => {
    const { dom, api, requests } = await setup(t, 'templates/modals/link_bulk.php');
    Object.assign(appState, {
        currentViewId: 1,
        views: [{ id: 1, name: '合成ビュー', resource_revision: 1, view_type: 'topology', sort_order: 1 }],
        devices: [{ id: 1, name: '合成SW', type: 'switch', resource_revision: 1 }, { id: 2, name: '合成AP', type: 'other', resource_revision: 1 }],
        placements: [{ id: 1, view_id: 1, device_id: 1, x: 0, y: 0 }, { id: 2, view_id: 1, device_id: 2, x: 200, y: 0 }],
        links: [{ id: 1, view_id: 1, from_id: 1, to_id: 2, from_port: 'Gi1', to_port: 'eth0', system_id: null,
            label: '元ラベル', vlan: '10', memo: '保持する備考', route_mode: 'auto', manual_route: [] }]
    });
    resetResourceBaseline(appState);
    initializeLinkBulkModal();
    const overlay = dom.get('link-bulk-overlay');
    const original = structuredClone(appState.links);
    let discard = false;
    let confirmations = 0;
    window.confirm = () => { confirmations++; return discard; };
    for (const close of closers(overlay)) {
        assert.equal(await openLinkBulkModal([1]), true);
        const checkbox = dom.get('link-bulk-use-label');
        checkbox.checked = true;
        await checkbox.dispatch('change');
        assert.equal(dom.get('link-bulk-label').disabled, false);
        const before = confirmations;
        await close();
        assert.equal(confirmations, before + 1);
        assert.equal(overlay.hidden, false);
        assert.equal(checkbox.checked, true);
        assert.deepEqual(appState.links, original);
        discard = true;
        await close();
        assert.equal(overlay.hidden, true);
        assert.equal(getTopModalContainer(), null);
        assert.deepEqual(appState.links, original);
        discard = false;
    }
    assert.equal(requests.length, 0);
    const persisted = [];
    api((action, input) => {
        assert.equal(action, 'save_resources');
        persisted.push(structuredClone(input.views[0].links));
        return response({ revision: 2, id_maps: { devices: {}, views: {}, placements: {}, links: {}, canvas_notes: {} },
            devices: [], views: input.views.map(view => ({ ...view.view, id: view.id, resource_revision: 2 })),
            placements: input.views[0].placements, links: input.views[0].links, canvas_notes: [],
            affected_view_ids: [1], deleted_device_ids: [], deleted_view_ids: [] });
    });
    await openLinkBulkModal([1]);
    dom.get('link-bulk-use-label').checked = true;
    await dom.get('link-bulk-use-label').dispatch('change');
    dom.get('link-bulk-label').value = '確定ラベル';
    const before = confirmations;
    assert.equal(previewLinkBulkModal(), true);
    assert.deepEqual(appState.links, original, '確認だけでは変更を確定しない');
    assert.equal(requests.length, 0);
    assert.equal(await applyLinkBulkModal(), true);
    await flushSaveQueue({ silent: true });
    assert.equal(confirmations, before, '適用成功の閉鎖は破棄確認を通さない');
    assert.equal(overlay.hidden, true);
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0][0].label, '確定ラベル');
    assert.equal(appState.links[0].label, '確定ラベル');
    assert.equal(appState.links[0].memo, '保持する備考');
    assert.equal(appState.appStatus.dirty, false);
    await openLinkBulkModal([1]);
    await escape();
    assert.equal(overlay.hidden, true);
    assert.equal(confirmations, before, '新しい入力がなければ確認しない');
    assert.equal(appState.links[0].label, '確定ラベル');
    assert.equal(requests.length, 1);
});

test('link-bulk: 系統候補のキー操作・Esc・確認から戻る・未設定の適用は入力と確定境界を保持する', async t => {
    const { dom, api, requests } = await setup(t, 'templates/modals/link_bulk.php');
    Object.assign(window, { innerWidth: 1366, innerHeight: 768 });
    Object.assign(appState, {
        currentViewId: 1,
        views: [{ id: 1, name: '合成ビュー', resource_revision: 1, view_type: 'topology', sort_order: 1 }],
        devices: [{ id: 1, name: '合成SW', type: 'switch', resource_revision: 1 }, { id: 2, name: '合成AP', type: 'other', resource_revision: 1 }],
        placements: [{ id: 1, view_id: 1, device_id: 1, x: 0, y: 0 }, { id: 2, view_id: 1, device_id: 2, x: 200, y: 0 }],
        links: [{ id: 1, view_id: 1, from_id: 1, to_id: 2, system_id: 3, label: '保持するラベル',
            vlan: '10', memo: '', route_mode: 'auto', manual_route: [] }],
        linkSystems: [{ id: 3, name: '合成管理系統', color_key: 'teal' }, { id: 4, name: '合成業務系統', color_key: 'indigo' }]
    });
    resetResourceBaseline(appState);
    initializeLinkBulkModal();
    assert.equal(await openLinkBulkModal([1]), true);
    const overlay = dom.get('link-bulk-overlay');
    const control = dom.get('link-bulk-system_id');
    const list = dom.get('link-bulk-system-options');
    const original = structuredClone(appState.links);
    // 変更対象を選ぶまではプログラムによるキー操作でも開けない。
    await control.dispatch('keydown', { key: 'ArrowDown' });
    assert.equal(list.hidden, true);
    dom.get('link-bulk-use-system_id').checked = true;
    await dom.get('link-bulk-use-system_id').dispatch('change');
    control.getBoundingClientRect = () => ({ left: 24, top: 160, bottom: 192, width: 320, height: 32 });
    await control.dispatch('keydown', { key: ' ' });
    assert.equal(list.hidden, false);
    assert.equal(control.getAttribute('aria-expanded'), 'true');
    assert.equal(list.parentElement, overlay.querySelector('[role="dialog"]'));
    await control.dispatch('keydown', { key: 'End' });
    assert.equal(control.getAttribute('aria-activedescendant'), list.children[2].id);
    await control.dispatch('keydown', { key: 'ArrowUp' });
    await control.dispatch('keydown', { key: 'Enter' });
    assert.equal(control.value, '3');
    assert.equal(list.children[1].getAttribute('aria-selected'), 'true');
    assert.equal(list.hidden, true);
    await control.dispatch('keydown', { key: 'ArrowDown' });
    await escape();
    assert.equal(list.hidden, true);
    assert.equal(overlay.hidden, false, '候補のEscは親モーダルを閉じない');
    assert.equal(control.value, '3');
    assert.equal(previewLinkBulkModal(), true);
    assert.deepEqual(appState.links, original);
    assert.equal(requests.length, 0);
    await dom.get('link-bulk-back').dispatch('click');
    assert.equal(control.value, '3');
    assert.equal(dom.get('link-bulk-use-system_id').checked, true);
    await control.dispatch('keydown', { key: 'Home' });
    await control.dispatch('keydown', { key: ' ' });
    assert.equal(control.value, '');
    assert.equal(list.children[0].getAttribute('aria-selected'), 'true');
    assert.equal(previewLinkBulkModal(), true);
    await dom.get('link-bulk-back').dispatch('click');
    assert.equal(control.value, '');
    assert.equal(dom.get('link-bulk-use-system_id').checked, true);
    assert.equal(previewLinkBulkModal(), true);
    api((action, input) => {
        assert.equal(action, 'save_resources');
        assert.equal(input.views[0].links[0].system_id, null);
        return response({ revision: 2, id_maps: {},
            devices: [], views: input.views.map(view => ({ ...view.view, id: view.id, resource_revision: 2 })),
            placements: input.views[0].placements, links: input.views[0].links, canvas_notes: [],
            affected_view_ids: [1], deleted_device_ids: [], deleted_view_ids: [] });
    });
    assert.equal(await applyLinkBulkModal(), true);
    await flushSaveQueue({ silent: true });
    assert.equal(appState.links[0].system_id, null);
    assert.equal(appState.links[0].label, original[0].label);
    assert.equal(requests.length, 1);
    assert.equal(list.hidden, true);
    assert.equal(overlay.hidden, true);
});

test('link-bulk: 系統候補は対象外・認証失効・モーダル閉鎖で閉じ、viewerは変更できない', async t => {
    const { dom } = await setup(t, 'templates/modals/link_bulk.php');
    Object.assign(appState, {
        currentViewId: 1, views: [{ id: 1 }], devices: [{ id: 1 }, { id: 2 }],
        placements: [{ id: 1, view_id: 1, device_id: 1 }, { id: 2, view_id: 1, device_id: 2 }],
        links: [{ id: 1, view_id: 1, from_id: 1, to_id: 2, system_id: null }],
        linkSystems: [{ id: 3, name: '合成管理系統', color_key: 'teal' }]
    });
    initializeLinkBulkModal();
    assert.equal(await openLinkBulkModal([1]), true);
    const control = dom.get('link-bulk-system_id');
    const list = dom.get('link-bulk-system-options');
    const checkbox = dom.get('link-bulk-use-system_id');
    checkbox.checked = true;
    await checkbox.dispatch('change');
    await control.dispatch('click');
    checkbox.checked = false;
    await checkbox.dispatch('change');
    assert.equal(list.hidden, true);
    checkbox.checked = true;
    await checkbox.dispatch('change');
    await control.dispatch('click');
    appState.authExpired = true;
    eventBus.emit('auth:expired');
    assert.equal(list.hidden, true);
    await list.children[1].dispatch('click');
    assert.equal(control.value, '');
    appState.authExpired = false;
    window.APP_CONFIG.user.isAdmin = false;
    await control.dispatch('click');
    await control.dispatch('keydown', { key: 'End' });
    await list.children[1].dispatch('click');
    assert.equal(list.hidden, true);
    assert.equal(control.value, '');
    assert.equal(previewLinkBulkModal(), false);
    window.APP_CONFIG.user.isAdmin = true;
    await control.dispatch('click');
    assert.equal(list.hidden, false);
    assert.equal(closeLinkBulkModal(), true);
    assert.equal(list.hidden, true);
    assert.equal(control.getAttribute('aria-expanded'), 'false');
});

function accountRows(dom) {
    const row = dom.get('account-user-list-body').children[0];
    return { row, role: row.querySelector('.account-user-role'), active: row.querySelector('.account-user-active') };
}
const initialUser = { id: 7, username: 'synthetic-viewer', role: 'viewer', is_active: true };

test('利用者管理: 追加フォーム・role/active・再設定入力を×/背景/Escで黙って失わない', async t => {
    const { dom, api, requests } = await setup(t, 'templates/modals/account.php');
    initializeAccountManagement();
    api(action => { assert.equal(action, 'list_users'); return response({ users: [initialUser] }); });
    const overlay = dom.get('account-overlay');
    let discard = false;
    let confirmations = 0;
    window.confirm = () => { confirmations++; return discard; };
    const edits = [
        () => { dom.get('user-create-username').value = 'uncommitted-user'; return () => dom.get('user-create-username').value === 'uncommitted-user'; },
        () => { dom.get('user-create-role').value = 'admin'; return () => dom.get('user-create-role').value === 'admin'; },
        () => { const { role } = accountRows(dom); role.value = 'admin'; return () => role.value === 'admin'; },
        () => { const { active } = accountRows(dom); active.checked = false; return () => active.checked === false; },
        () => { const input = accountRows(dom).row.querySelector('.account-reset-password'); input.value = 'synthetic-uncommitted-password'; return () => input.value === 'synthetic-uncommitted-password'; }
    ];
    for (const edit of edits) {
        for (const close of closers(overlay)) {
            await openUserManagement();
            const kept = edit();
            const before = confirmations;
            await close();
            assert.equal(confirmations, before + 1);
            assert.equal(overlay.hidden, false);
            assert.equal(kept(), true);
            discard = true;
            await close();
            assert.equal(overlay.hidden, true);
            assert.equal(getTopModalContainer(), null);
            assert.equal(dom.get('user-create-username').value, '');
            assert.equal(dom.get('user-create-role').value, 'viewer');
            assert.equal(accountRows(dom).role.value, 'viewer');
            assert.equal(accountRows(dom).active.checked, true);
            assert.equal(accountRows(dom).row.querySelector('.account-reset-password').value, '');
            discard = false;
        }
    }
    assert.equal(requests.every(request => request.action === 'list_users'), true, '未確定入力はAPIに送らない');
});

test('利用者管理: 一覧・追加・更新API中は閉鎖を抑止し、保存後の閉鎖では権限/停止を戻さない', async t => {
    const { dom, api, requests } = await setup(t, 'templates/modals/account.php');
    initializeAccountManagement();
    const overlay = dom.get('account-overlay');
    let confirmations = 0;
    window.confirm = () => { confirmations++; return false; };
    let users = [structuredClone(initialUser)];
    const listing = deferred();
    api(action => { assert.equal(action, 'list_users'); return listing.promise; });
    const opening = openUserManagement();
    await assertBusyClose(overlay, () => confirmations);
    listing.resolve(response({ users }));
    await opening;
    const creating = deferred();
    api((action, input) => {
        if (action === 'list_users') return response({ users });
        assert.equal(action, 'create_user');
        assert.equal(input.username, 'synthetic-added-user');
        assert.equal(input.role, 'viewer');
        return creating.promise.then(() => {
            users.push({ id: 8, username: input.username, role: input.role, is_active: true });
            return response({});
        });
    });
    dom.get('user-create-username').value = 'synthetic-added-user';
    dom.get('user-create-password').value = 'synthetic-password-123';
    dom.get('user-create-password-confirm').value = 'synthetic-password-123';
    const submitting = dom.get('user-create-form').dispatch('submit');
    await assertBusyClose(overlay, () => confirmations);
    creating.resolve();
    await submitting;
    assert.equal(dom.get('account-user-list-body').children.length, 2);
    assert.equal(dom.get('user-create-username').value, '');
    const { row, role, active } = accountRows(dom);
    role.value = 'admin';
    active.checked = false;
    const updating = deferred();
    api((action, input) => {
        if (action === 'list_users') return response({ users });
        assert.equal(action, 'update_user');
        assert.deepEqual(input, { id: 7, role: 'admin', is_active: false });
        return updating.promise.then(() => {
            users = users.map(user => user.id === input.id ? { ...user, role: input.role, is_active: input.is_active } : user);
            return response({});
        });
    });
    await dom.get('account-user-list-body').dispatch('click', { target: row.querySelector('[data-account-action="update"]') });
    await assertBusyClose(overlay, () => confirmations);
    updating.resolve();
    await drain();
    assert.equal(accountRows(dom).role.value, 'admin');
    assert.equal(accountRows(dom).active.checked, false);
    await escape();
    assert.equal(confirmations, 0, 'APIで確定したフォーム/権限/状態に破棄確認は不要');
    assert.equal(overlay.hidden, true);
    await openUserManagement();
    assert.equal(accountRows(dom).role.value, 'admin');
    assert.equal(accountRows(dom).active.checked, false);
    await overlay.click();
    assert.equal(overlay.hidden, true);
    assert.equal(requests.filter(request => request.action === 'create_user').length, 1);
    assert.equal(requests.filter(request => request.action === 'update_user').length, 1);
});

test('利用者管理: 一覧更新失敗では下書きを保持し、再表示の取得失敗では古い操作行を除く', async t => {
    const { dom, api, requests } = await setup(t, 'templates/modals/account.php');
    initializeAccountManagement();
    api(() => response({ users: [initialUser] }));
    await openUserManagement();
    const { row, role, active } = accountRows(dom);
    role.value = 'admin';
    active.checked = false;
    const password = row.querySelector('.account-reset-password');
    password.value = 'synthetic-uncommitted-password';

    api(() => Promise.reject(new Error('synthetic listing failure')));
    await refreshUserList();
    assert.equal(accountRows(dom).role.value, 'admin');
    assert.equal(accountRows(dom).active.checked, false);
    assert.equal(accountRows(dom).row.querySelector('.account-reset-password').value, 'synthetic-uncommitted-password');

    closeAccountManagement();
    await openUserManagement();
    const body = dom.get('account-user-list-body');
    assert.equal(body.querySelector('.account-user-role') === null, true, '再表示時に古い権限操作を残さない');
    assert.equal(body.querySelector('.account-user-active') === null, true, '再表示時に古い停止操作を残さない');
    assert.equal(body.querySelector('[data-account-action="update"]') === null, true);
    assert.equal(body.querySelector('[data-account-action="reset"]') === null, true);

    api(() => response({ users: [{ ...initialUser, role: 'admin', is_active: false }] }));
    await refreshUserList();
    assert.equal(accountRows(dom).role.value, 'admin');
    assert.equal(accountRows(dom).active.checked, false);
    assert.equal(accountRows(dom).row.querySelector('.account-reset-password').value, '');
    assert.equal(requests.every(request => request.action === 'list_users'), true);
});

test('利用者管理: 削除は対象名と結果を確認し、削除済みタブから復元でき、他行の未適用変更を失わない', async t => {
    const { dom, api, requests } = await setup(t, 'templates/modals/account.php');
    initializeAccountManagement();
    const other = { id: 9, username: 'synthetic-other', role: 'viewer', is_active: true, is_deleted: false };
    let users = [structuredClone(initialUser), other];
    api((action, input) => {
        if (action === 'list_users') return response({ users });
        if (action === 'delete_user') {
            users = users.map(user => user.id === input.id ? { ...user, is_active: false, is_deleted: true, deleted_at: '2026-11-04 10:00:00' } : user);
            return response({ message: '削除しました' });
        }
        assert.equal(action, 'restore_user');
        users = users.map(user => user.id === input.id ? { ...user, is_deleted: false, deleted_at: null } : user);
        return response({ message: '復元しました' });
    });
    await openUserManagement();
    const body = dom.get('account-user-list-body');
    const rowOf = id => Array.from(body.querySelectorAll('tr[data-user-id]')).find(row => row.dataset.userId === String(id));
    rowOf(9).querySelector('.account-user-role').value = 'admin';

    const messages = [];
    window.confirm = message => { messages.push(message); return messages.length > 1; };
    const target = rowOf(7);
    await body.dispatch('click', { target: target.querySelector('[data-account-action="delete"]') });
    assert.equal(requests.some(request => request.action === 'delete_user'), false, '拒否では削除しない');
    await body.dispatch('click', { target: target.querySelector('[data-account-action="delete"]') });
    await drain();
    assert.match(messages[0], new RegExp(initialUser.username));
    assert.match(messages[0], /削除済み一覧へ移動します。ログインできなくなりますが、操作履歴は保持され、後から復元できます。/);
    assert.equal(dom.get('account-status').textContent, '削除しました');
    assert.equal(rowOf(7), undefined);
    assert.equal(rowOf(9).querySelector('.account-user-role').value, 'admin', '他行の未適用変更を保持');

    const deletedBody = dom.get('account-deleted-list-body');
    assert.equal(deletedBody.querySelectorAll('tr[data-user-id]').length, 1);
    assert.equal(deletedBody.querySelector('[data-account-action="update"]'), null);
    assert.equal(deletedBody.querySelector('[data-account-action="reset"]'), null);
    assert.equal(deletedBody.querySelector('[data-account-action="delete"]'), null);

    messages.length = 0;
    window.confirm = message => { messages.push(message); return true; };
    await deletedBody.dispatch('click', { target: deletedBody.querySelector('[data-account-action="restore"]') });
    await drain();
    assert.match(messages[0], /復元後は無効状態です。利用再開する場合は有効化してください/);
    assert.equal(requests.filter(request => request.action === 'restore_user').length, 1);
    assert.equal(dom.get('account-status').textContent, '復元しました');
    assert.equal(deletedBody.querySelectorAll('tr[data-user-id]').length, 0);
    assert.equal(rowOf(7) !== undefined, true);
});

test('利用者管理: 登録フォームは初期折りたたみで展開・格納・キャンセル・成功時自動格納とフォーカス遷移を行う', async t => {
    const { dom, api, requests } = await setup(t, 'templates/modals/account.php');
    initializeAccountManagement();
    let users = [structuredClone(initialUser)];
    api((action, input) => {
        if (action === 'list_users') return response({ users });
        if (action === 'create_user') {
            users.push({ id: 10, username: input.username, role: input.role, is_active: true });
            return response({ message: '登録しました' });
        }
    });
    await openUserManagement();

    const form = dom.get('user-create-form');
    const toggleBtn = dom.get('user-create-toggle-btn');
    const cancelBtn = dom.get('user-create-cancel-btn');
    const username = dom.get('user-create-username');

    // 1. 初期状態は折りたたみ
    assert.equal(form.hidden, true);
    assert.equal(toggleBtn.getAttribute('aria-expanded'), 'false');

    // 2. パスワード条件の表示確認
    const hint = dom.get('user-create-password-hint');
    assert.equal(hint.querySelector('.password-requirements-title').textContent, 'パスワードの条件');
    assert.equal(hint.querySelectorAll('li').length, 2);

    // 3. 展開操作
    await toggleBtn.dispatch('click');
    assert.equal(form.hidden, false);
    assert.equal(toggleBtn.getAttribute('aria-expanded'), 'true');
    assert.equal(document.activeElement, username);

    // 4. 未入力での再トグル格納
    await toggleBtn.dispatch('click');
    assert.equal(form.hidden, true);
    assert.equal(toggleBtn.getAttribute('aria-expanded'), 'false');
    assert.equal(document.activeElement, toggleBtn);

    // 5. 入力途中の格納確認（拒否・許可）
    let confirmations = 0;
    window.confirm = () => { confirmations++; return confirmations > 1; };
    await toggleBtn.dispatch('click');
    username.value = 'draft-user';
    await toggleBtn.dispatch('click');
    assert.equal(form.hidden, false, '破棄拒否時は開いたまま保持');
    assert.equal(username.value, 'draft-user');
    await toggleBtn.dispatch('click');
    assert.equal(form.hidden, true, '破棄許可時は格納');
    assert.equal(username.value, '');

    // 6. キャンセルボタンでの格納
    await toggleBtn.dispatch('click');
    assert.equal(form.hidden, false);
    await cancelBtn.dispatch('click');
    assert.equal(form.hidden, true);
    assert.equal(document.activeElement, toggleBtn);

    // 7. 登録成功時の自動格納
    await toggleBtn.dispatch('click');
    username.value = 'new-user';
    dom.get('user-create-password').value = 'password-valid-123';
    dom.get('user-create-password-confirm').value = 'password-valid-123';
    await form.dispatch('submit');
    await drain();
    assert.equal(form.hidden, true, '登録成功後は自動格納');
    assert.equal(toggleBtn.getAttribute('aria-expanded'), 'false');
    assert.equal(document.activeElement, toggleBtn);
    assert.equal(dom.get('account-status').textContent, '登録しました');
});

test('利用者登録: 上限超過を編集でき、近傍エラーと先頭不正項目へのフォーカスで送信を止める', async t => {
    const { dom, api, requests } = await setup(t, 'templates/modals/account.php');
    initializeAccountManagement();
    api(action => {
        if (action === 'list_users') return response({ users: [initialUser] });
        assert.equal(action, 'create_user');
        return response({});
    });
    await openUserManagement();
    const username = dom.get('user-create-username');
    const password = dom.get('user-create-password');
    const confirmation = dom.get('user-create-password-confirm');
    const form = dom.get('user-create-form');
    username.value = 'a'.repeat(51);
    password.value = 'p'.repeat(129);
    confirmation.value = password.value;
    assert.equal(username.getAttribute('maxlength'), null);
    assert.equal(password.getAttribute('maxlength'), null);
    await form.dispatch('input', { target: password });
    assert.equal(dom.get('user-create-username-error').hidden, false);
    assert.equal(dom.get('user-create-password-error').hidden, false);
    assert.equal(password.getAttribute('aria-invalid'), 'true');
    assert.match(password.getAttribute('aria-describedby'), /user-create-password-hint.*user-create-password-error/);
    await form.dispatch('submit');
    assert.equal(document.activeElement, username);
    assert.equal(password.value, 'p'.repeat(129));
    assert.equal(requests.filter(request => request.action === 'create_user').length, 0);
    username.value = 'valid-user';
    for (const value of ['a'.repeat(11), '😀'.repeat(128) + 'a', 'a'.repeat(12) + '\0', 'a'.repeat(12) + '\uD800']) {
        password.value = value;
        confirmation.value = value;
        await form.dispatch('submit');
        assert.equal(document.activeElement, password);
        assert.equal(dom.get('user-create-password-error').hidden, false);
        assert.equal(password.value, value);
        assert.equal(confirmation.value, value);
        assert.equal(requests.filter(request => request.action === 'create_user').length, 0);
    }
    password.value = '😀'.repeat(128);
    confirmation.value = 'different-password';
    await form.dispatch('submit');
    assert.equal(document.activeElement, confirmation);
    assert.match(dom.get('user-create-password-confirm-error').textContent, /一致/);
    confirmation.value = password.value;
    await form.dispatch('input', { target: confirmation });
    assert.equal(dom.get('user-create-password-confirm-error').hidden, true);
    assert.equal(password.getAttribute('aria-describedby'), 'user-create-password-hint');
    await form.dispatch('submit');
    const created = requests.find(request => request.action === 'create_user');
    assert.equal(created.input.password, '😀'.repeat(128));
    assert.equal(created.input.password_confirm, '😀'.repeat(128));
    assert.equal(requests.filter(request => request.action === 'create_user').length, 1);
    assert.equal(username.value, '');
});

test('パスワード再設定: 不正入力の確認/APIを止め、512バイトの値をそのまま送る', async t => {
    const { dom, api, requests } = await setup(t, 'templates/modals/account.php');
    initializeAccountManagement();
    api(action => {
        if (action === 'list_users') return response({ users: [initialUser] });
        assert.equal(action, 'reset_user_password');
        return response({});
    });
    await openUserManagement();
    const { row } = accountRows(dom);
    const password = row.querySelector('.account-reset-password');
    let confirmations = 0;
    window.confirm = () => { confirmations++; return true; };
    for (const [value, message] of [
        ['', 'パスワードは12文字以上で入力してください'],
        ['あ'.repeat(11), 'パスワードは12文字以上で入力してください'],
        ['a'.repeat(129), 'パスワードは128文字以内で入力してください'],
        ['😀'.repeat(128) + 'a', 'パスワードは512バイト以内で入力してください'],
        ['a'.repeat(12) + '\0', 'パスワードに使用できない文字が含まれています'],
        ['a'.repeat(12) + '\uD800', 'パスワードに使用できない文字が含まれています'],
        ['😀'.repeat(128) + '\uDC00', 'パスワードに使用できない文字が含まれています']
    ]) {
        password.value = value;
        await dom.get('account-user-list-body').dispatch('input', { target: password });
        await dom.get('account-user-list-body').dispatch('click', { target: row.querySelector('[data-account-action="reset"]') });
        await drain();
        assert.equal(dom.get(`${password.id}-error`).textContent, `! ${message}`);
        assert.equal(dom.get(`${password.id}-error`).hidden, false);
        assert.equal(document.activeElement, password);
        assert.equal(password.value, value);
        assert.equal(confirmations, 0);
        assert.equal(requests.filter(request => request.action === 'reset_user_password').length, 0);
    }
    password.value = '😀'.repeat(128);
    await dom.get('account-user-list-body').dispatch('click', { target: row.querySelector('[data-account-action="reset"]') });
    await drain();
    assert.equal(confirmations, 1);
    const resets = requests.filter(request => request.action === 'reset_user_password');
    assert.equal(resets.length, 1);
    assert.equal(resets[0].input.password, '😀'.repeat(128));
    assert.equal(resets[0].input.password_confirm, '😀'.repeat(128));
    assert.equal(accountRows(dom).row.querySelector('.account-reset-password').value, '');
});

test('自分のパスワード変更: 新規ポリシーと一致を検証し、不正入力とlegacy現在欄を保持する', async t => {
    const { dom, api, requests } = await setup(t, 'templates/modals/account.php');
    initializeAccountManagement();
    api(action => { assert.equal(action, 'change_own_password'); return response({}); });
    openPasswordChange();
    const form = dom.get('password-change-content');
    const current = dom.get('own-current-password');
    const password = dom.get('own-new-password');
    const confirmation = dom.get('own-new-password-confirm');
    for (const value of ['', 'a'.repeat(11), 'あ'.repeat(11), 'a'.repeat(129), '😀'.repeat(128) + 'a', 'a'.repeat(12) + '\0', 'a'.repeat(12) + '\uDC00']) {
        current.value = 'legacy';
        password.value = value;
        confirmation.value = value;
        await form.dispatch('submit');
        assert.equal(document.activeElement, password);
        assert.equal(password.value, value);
        assert.equal(confirmation.value, value);
        assert.equal(current.value, 'legacy');
        assert.equal(requests.length, 0);
    }
    password.value = 'e\u0301'.repeat(6);
    confirmation.value = 'wrong-password';
    await form.dispatch('submit');
    assert.equal(document.activeElement, confirmation);
    assert.equal(requests.length, 0);
    confirmation.value = password.value;
    for (const value of ['legacy', 'p'.repeat(513), 'あ'.repeat(201), '\0', '\uD800']) {
        current.value = value;
        await form.dispatch('input', { target: current });
        assert.equal(dom.get('own-current-password-error').hidden, true);
        await form.dispatch('submit');
        assert.equal(requests.at(-1).input.current_password, value);
        assert.equal(requests.at(-1).input.new_password, 'e\u0301'.repeat(6));
        assert.equal(window.location.href, 'login.php');
        // 成功時のreset後に、次のlegacy照合入力を設定する。
        password.value = 'e\u0301'.repeat(6);
        confirmation.value = password.value;
    }
    assert.equal(requests.length, 5);
    current.value = '';
    await form.dispatch('submit');
    assert.equal(document.activeElement, current);
    assert.equal(dom.get('own-current-password-error').textContent, '! 入力してください');
    assert.equal(requests.length, 5);
    current.value = 'legacy';
    password.value = '😀'.repeat(128);
    confirmation.value = password.value;
    await form.dispatch('submit');
    assert.equal(requests.length, 6);
    assert.equal(requests.at(-1).input.new_password, '😀'.repeat(128));
    assert.equal(requests.at(-1).input.new_password_confirm, '😀'.repeat(128));
});
