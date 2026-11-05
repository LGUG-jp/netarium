import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installWorkspaceDom } from './helpers/workspace-dom.mjs';
import { appState, normalizeDevice } from '../public/js/core/state.js';
import { resetResourceBaseline } from '../public/js/core/resource-save.js';

test('レビュー対応: 個票画像説明のフォーカス維持と台帳非表示項目のエラー案内', async t => {
    const globals = new Map(['window', 'document', 'fetch', 'confirm', 'localStorage', 'Element', 'HTMLElement', 'HTMLInputElement'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const dom = installWorkspaceDom({
        templates: ['templates/modals/ledger.php'],
        phpSetup: '$isAdmin = true;'
    });
    window.confirm = () => true;
    let preset = 'all';
    globalThis.localStorage = window.localStorage = { getItem: () => preset, setItem: (_, val) => { preset = val; } };
    globalThis.fetch = async (_url, options = {}) => {
        const body = options.body ? JSON.parse(options.body) : {};
        return new Response(JSON.stringify({
            ok: true, revision: 2, saved_at: '2026-10-09T00:00:00Z', id_maps: {},
            devices: (body.devices || []).map(op => ({ ...op.device, resource_revision: 2 })),
            views: [], placements: [], links: [], canvas_notes: [], affected_view_ids: [],
            deleted_device_ids: [], deleted_view_ids: []
        }));
    };
    t.after(() => {
        queue.clearPendingSave();
        drafts.discardDeviceDrafts('ledger');
        drafts.discardDeviceDrafts('sheet');
        for (const [key, descriptor] of globals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    });

    const ledger = await import('../public/js/modals/ledger-modal.js');
    const queue = await import('../public/js/core/save-queue.js');
    const drafts = await import('../public/js/core/device-drafts.js');
    await dom.events.dispatch('DOMContentLoaded');

    appState.devices = [
        normalizeDevice({ id: 1, name: 'SW1', type: 'switch', resource_revision: 1 }),
        normalizeDevice({ id: 2, name: 'SW2', type: 'switch', resource_revision: 1 })
    ];
    appState.views = [{ id: 1, name: 'Floor', view_type: 'topology', resource_revision: 1 }];
    appState.currentViewId = 1;
    appState.placements = [{ id: 1, view_id: 1, device_id: 1, x: 10, y: 10 }];
    appState.deviceImages = [{ id: 91, device_id: 1, caption: '初期説明', sort_order: 0 }];
    resetResourceBaseline(appState);

    // 1. 個票の画像説明欄のフォーカス・選択位置復元
    await ledger.openLedgerDetail(1);
    const sheet = dom.get('ledger-sheet-body');
    const captionInput = sheet.querySelector('[data-image-id="91"]');
    assert.ok(captionInput, '画像説明欄が存在する');
    captionInput.focus();
    captionInput.setSelectionRange(2, 4);
    ledger.renderLedgerDeviceSheet(appState.devices[0]);
    assert.equal(document.activeElement, sheet.querySelector('[data-image-id="91"]'), '再描画後も画像説明欄がフォーカスされている');
    assert.equal(document.activeElement.selectionStart, 2);
    assert.equal(document.activeElement.selectionEnd, 4);
    await ledger.closeLedgerDetailPane();

    await t.test('品質診断と共通フォーカス導線はmemoと基本項目のタブを選び、個票ドラフトを保持する', async () => {
        await ledger.openLedgerDetail(1);
        const memo = sheet.querySelector('[data-field="memo"]');
        memo.value = '未確定の備考';
        await memo.dispatch('input');
        for (const field of ['memo', 'ip']) {
            ledger.focusLedgerSheetField(field);
            assert.equal(document.activeElement.dataset.field, field);
            assert.equal(document.activeElement.closest('[role="tabpanel"]').hidden, false);
            await ledger.openDataQualityDeviceInLedger({ deviceId: 1, field });
            await new Promise(resolve => setImmediate(resolve));
            assert.equal(document.activeElement.dataset.field, field);
            assert.equal(document.activeElement.closest('[role="tabpanel"]').hidden, false);
            assert.equal(sheet.querySelector('[data-field="memo"]').value, '未確定の備考');
        }
        drafts.discardDeviceDrafts('sheet');
        await ledger.closeLedgerDetailPane();
    });

    await t.test('追加IPは0件から追加・フォーカスでき、再描画とタブ切替を経ても入力・選択範囲・保存エラーを保持する', async () => {
        await ledger.openLedgerDetail(1);
        let editor = sheet.querySelector('.device-ip-editor');
        assert.equal(editor.dataset.expanded, 'false');
        assert.equal(editor.querySelectorAll('[data-ip-field="ip"]').length, 0);
        assert.equal(editor.querySelector('.device-ip-toggle').hidden, true);
        await editor.querySelector('.device-ip-add').dispatch('click');
        let input = editor.querySelector('[data-ip-index="0"][data-ip-field="ip"]');
        assert.equal(editor.dataset.expanded, 'true');
        assert.equal(document.activeElement, input);
        input.value = 'invalid'; await input.dispatch('input');
        input.focus(); input.setSelectionRange(2, 4);
        ledger.renderLedgerDeviceSheet(appState.devices[0]);
        editor = sheet.querySelector('.device-ip-editor');
        input = editor.querySelector('[data-ip-index="0"][data-ip-field="ip"]');
        assert.equal(editor.dataset.expanded, 'true');
        assert.equal(input.value, 'invalid');
        assert.equal(document.activeElement, input);
        assert.equal(input.selectionStart, 2);
        assert.equal(input.selectionEnd, 4);
        await dom.get('ledger-sheet-tab-1').dispatch('click');
        assert.equal(editor.closest('[role="tabpanel"]').hidden, true);
        await dom.get('ledger-sheet-tab-0').dispatch('click');
        assert.equal(editor.closest('[role="tabpanel"]').hidden, false);
        assert.equal(input.value, 'invalid');
        assert.equal(input.selectionStart, 2);
        assert.equal(input.selectionEnd, 4);
        await editor.querySelector('.device-ip-toggle').dispatch('click');
        assert.equal(editor.dataset.expanded, 'false');
        assert.equal(document.activeElement, editor.querySelector('.device-ip-toggle'));
        await dom.get('ledger-sheet-tab-1').dispatch('click');
        assert.equal(await ledger.saveLedgerSheet(), false);
        assert.equal(editor.dataset.expanded, 'true');
        assert.equal(editor.closest('[role="tabpanel"]').hidden, false);
        assert.equal(document.activeElement, input);
        assert.equal(input.getAttribute('aria-invalid'), 'true');
        ledger.renderLedgerDeviceSheet(appState.devices[0]);
        editor = sheet.querySelector('.device-ip-editor');
        input = editor.querySelector('[data-ip-index="0"][data-ip-field="ip"]');
        assert.equal(editor.dataset.expanded, 'true');
        assert.equal(document.activeElement, input);
        assert.equal(input.value, 'invalid');
        assert.equal(input.getAttribute('aria-invalid'), 'true');
        assert.ok(editor.querySelectorAll('.form-error').some(error => !error.hidden));
        drafts.discardDeviceDrafts('sheet');
        await ledger.closeLedgerDetailPane();
    });

    await t.test('画像は0〜3枚でも3枠を維持し、実APIの失敗・並替・削除と閲覧権限を扱う', async () => {
        const originalFetch = globalThis.fetch;
        await ledger.openLedgerDetail(1);
        appState.deviceImages = [];
        const revision = appState.devices[0].resource_revision;
        appState.devices[0].resource_revision = 0;
        ledger.renderLedgerDeviceSheet(appState.devices[0]);
        assert.ok(sheet.querySelectorAll('.ledger-sheet-image-slot-add').every(button => button.disabled));
        appState.devices[0].resource_revision = revision;
        const { eventBus } = await import('../public/js/core/event-bus.js');
        eventBus.emit('resources:saved');
        assert.ok(sheet.querySelectorAll('.ledger-sheet-image-slot-add').every(button => !button.disabled));
        assert.ok(sheet.querySelectorAll('.ledger-sheet-image-block-reason').every(notice => notice.hidden));
        ledger.renderLedgerDeviceSheet(appState.devices[0]);
        const uploadInput = dom.get('ledger-sheet-image-file-input');
        let opened = 0;
        uploadInput.addEventListener('click', () => { opened++; });
        await sheet.querySelector('.ledger-sheet-image-slot-add').dispatch('click');
        assert.equal(opened, 1);
        uploadInput.files = [{ type: 'image/gif', size: 1 }];
        await uploadInput.dispatch('change');
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(sheet.querySelectorAll('.ledger-sheet-image-slot-add').length, 3);
        const images = Array.from({ length: 3 }, (_, index) => ({
            id: 91 + index, device_id: 1, caption: `説明${index}`, sort_order: index, image_url: `api.php?image=${index}`
        }));
        let uploadCalls = 0;
        globalThis.fetch = async (url, options) => {
            assert.ok(url.includes('upload_device_image'));
            assert.ok(options.body instanceof FormData);
            uploadCalls++;
            return new Response(JSON.stringify({ ok: false, error: '登録失敗' }), { status: 500 });
        };
        uploadInput.files = [new File([new Uint8Array([137, 80, 78, 71])], 'synthetic.png', { type: 'image/png' })];
        await uploadInput.dispatch('change');
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(uploadCalls, 1);
        assert.deepEqual(appState.deviceImages, []);
        assert.equal(sheet.querySelectorAll('.ledger-sheet-image-slot-add').length, 3);
        globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, revision: 3, images: images.slice(0, 1) }));
        await uploadInput.dispatch('change');
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(appState.deviceImages.map(image => image.id), [91]);
        assert.equal(sheet.querySelectorAll('.ledger-sheet-image-slot-add').length, 2);
        for (let count = 0; count <= 3; count++) {
            appState.deviceImages = images.slice(0, count);
            ledger.renderLedgerDeviceSheet(appState.devices[0]);
            assert.equal(sheet.querySelectorAll('.ledger-sheet-image-card').length, 3);
            assert.equal(sheet.querySelectorAll('.ledger-sheet-image-slot-add').length, 3 - count);
            assert.equal(sheet.querySelectorAll('.ledger-sheet-image-zoom-trigger').length, count);
        }
        const middleActions = sheet.querySelectorAll('.ledger-sheet-image-actions')[1];
        assert.equal(middleActions.querySelectorAll('button').length, 4);
        for (const button of middleActions.querySelectorAll('.ledger-sheet-image-icon-action')) {
            assert.ok(button.getAttribute('aria-label'));
            assert.ok(button.title);
        }
        const beforeReplace = opened;
        await middleActions.querySelector('.ledger-sheet-image-replace').dispatch('click');
        assert.equal(opened, beforeReplace + 1, '中央画像の差替えで画像ファイル選択を開く');
        let request;
        globalThis.fetch = async (url, options) => {
            request = { url, body: JSON.parse(options.body) };
            return new Response(JSON.stringify({ ok: false, error: '更新失敗' }), { status: 409 });
        };
        await sheet.querySelector('.ledger-sheet-image-move').dispatch('click');
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(appState.deviceImages.map(image => image.id), [91, 92, 93]);
        assert.equal(sheet.querySelectorAll('.ledger-sheet-image-card').length, 3);
        await sheet.querySelector('.ledger-sheet-image-delete').dispatch('click');
        await new Promise(resolve => setImmediate(resolve));
        assert.ok(request.url.includes('delete_device_image'));
        assert.deepEqual(appState.deviceImages.map(image => image.id), [91, 92, 93]);
        assert.equal(sheet.querySelectorAll('.ledger-sheet-image-zoom-trigger').length, 3);
        globalThis.fetch = async (url, options) => {
            request = { url, body: JSON.parse(options.body) };
            const next = url.includes('delete_device_image')
                ? appState.deviceImages.filter(image => image.id !== request.body.image_id)
                : request.body.images.map((image, index) => ({ ...images.find(item => item.id === image.id), sort_order: index }));
            return new Response(JSON.stringify({ ok: true, revision: 3, images: next }));
        };
        await sheet.querySelector('.ledger-sheet-image-move').dispatch('click');
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(request.body.images.map(image => image.id), [92, 91, 93]);
        assert.deepEqual(sheet.querySelectorAll('[data-image-id]').map(input => Number(input.dataset.imageId)), [92, 91, 93]);
        await sheet.querySelector('.ledger-sheet-image-delete').dispatch('click');
        await new Promise(resolve => setImmediate(resolve));
        assert.ok(request.url.includes('delete_device_image'));
        assert.equal(sheet.querySelectorAll('.ledger-sheet-image-card').length, 3);
        assert.equal(sheet.querySelectorAll('.ledger-sheet-image-slot-add').length, 1);
        window.APP_CONFIG.user.isAdmin = false;
        ledger.renderLedgerDeviceSheet(appState.devices[0]);
        assert.ok(sheet.querySelector('.ledger-sheet-image-slot-add').disabled);
        assert.equal(sheet.querySelectorAll('.ledger-sheet-image-move').length, 0);
        assert.equal(sheet.querySelectorAll('.ledger-sheet-image-delete').length, 0);
        assert.equal(sheet.querySelectorAll('.ledger-sheet-image-replace').length, 0);
        assert.equal(sheet.querySelectorAll('.ledger-sheet-image-zoom-trigger').length, 2);
        window.APP_CONFIG.user.isAdmin = true;
        globalThis.fetch = originalFetch;
        await ledger.closeLedgerDetailPane();
    });

    // 2. 台帳の非表示項目に不正な下書きがある場合のエラー案内
    // フィルターの表示ビューを全解除状態にして全機器を表示
    ledger.updateLedgerFilters();
    ledger.setLedgerColumnPreset('all');
    ledger.renderLedgerTableHeader();
    ledger.renderLedgerTable();

    const tbody = dom.get('ledger-table-body');
    const manufacturer = tbody.querySelector('input[data-device-id="1"][data-field="manufacturer"]');
    assert.ok(manufacturer, '資産管理のメーカー欄が存在する');
    manufacturer.value = '😀'.repeat(101);
    await manufacturer.dispatch('input');

    // プリセットを切り替えてメーカー列を非表示にする
    preset = 'placement';
    ledger.setLedgerColumnPreset('placement');
    ledger.renderLedgerTableHeader();
    ledger.renderLedgerTable();
    assert.equal(tbody.querySelector('input[data-device-id="1"][data-field="manufacturer"]'), null, 'メーカー欄が非表示になっている');

    const toast = dom.get('toast') || dom.add('div', 'toast');
    assert.equal(await ledger.saveLedger(), false);
    assert.equal(await ledger.closeLedger(), false);
    assert.ok(toast.textContent.includes('メーカー'), '非表示エラーの項目名がトーストに含まれる');

    // 下書きを修正して正常終了できること
    preset = 'all';
    ledger.setLedgerColumnPreset('all');
    ledger.renderLedgerTableHeader();
    ledger.renderLedgerTable();
    const restoredManufacturer = tbody.querySelector('input[data-device-id="1"][data-field="manufacturer"]');
    restoredManufacturer.value = '正常メーカー';
    await restoredManufacturer.dispatch('input');
    assert.equal(await ledger.saveLedger(), true);

    await t.test('追加IP列は件数だけを表示し、標準とすべての列順・表示切替・追加IP検索を維持する', async () => {
        drafts.discardDeviceDrafts('ledger');
        appState.devices[0] = normalizeDevice({ ...appState.devices[0], additional_ips: [
            { id: 101, ip: '198.51.100.101', label: '業務LAN' },
            { id: 102, ip: '198.51.100.102', label: '管理LAN' }
        ] });
        const countCell = id => tbody.querySelector(`tr[data-device-id="${id}"]`).querySelector('[data-column="additional_ips"]');
        for (const selectedPreset of ['standard', 'all']) {
            preset = selectedPreset;
            ledger.setLedgerColumnPreset(selectedPreset);
            const header = dom.get('ledger-table').querySelector('thead').querySelectorAll('th');
            const ipIndex = header.findIndex(cell => cell.dataset.column === 'ip');
            assert.equal(header[ipIndex + 1].dataset.column, 'additional_ips');
            assert.equal(countCell(1).textContent, '2件');
            assert.equal(countCell(2).textContent, '—');
            assert.equal(countCell(1).querySelectorAll('input, button, details').length, 0);
        }
        for (const selectedPreset of ['placement', 'asset', 'maintenance', 'monitoring']) {
            preset = selectedPreset;
            ledger.setLedgerColumnPreset(selectedPreset);
            assert.equal(countCell(1), null);
        }
        preset = 'standard';
        ledger.setLedgerColumnPreset('standard');
        const { searchDevices } = await import('../public/js/modals/device-search-modal.js');
        for (const query of ['198.51.100.102', '業務LAN']) {
            dom.get('ledger-search').value = query;
            ledger.renderLedgerTable();
            assert.deepEqual(tbody.querySelectorAll('tr[data-device-id]').map(row => Number(row.dataset.deviceId)), [1]);
            assert.equal(countCell(1).textContent, '2件');
            assert.deepEqual(searchDevices(query).map(result => result.device.id), [1]);
        }
        dom.get('ledger-search').value = '';
        drafts.getDeviceDraft('sheet', 1).additional_ips.pop();
        drafts.commitDeviceDraft('sheet', 1);
        drafts.discardDeviceDrafts('ledger');
        ledger.renderLedgerTable();
        assert.equal(countCell(1).textContent, '1件', '個票の削除を適用すると再表示時の件数へ反映する');
        window.APP_CONFIG.user.isAdmin = false;
        ledger.renderLedgerTable();
        assert.equal(countCell(1).textContent, '1件');
        assert.equal(countCell(1).querySelectorAll('input, button, details').length, 0);
        window.APP_CONFIG.user.isAdmin = true;
        preset = 'all';
        ledger.setLedgerColumnPreset('all');
    });

    await t.test('保持した複数下書きのIP交換・付け替えは保存でき、新規重複は明示確認で確定する', async () => {
        const editIp = (id, ip) => {
            drafts.getDeviceDraft('ledger', id).ip = ip;
        };
        editIp(1, '192.0.2.1');
        editIp(2, '192.0.2.2');
        assert.equal(await ledger.saveLedger(), true);

        editIp(1, '192.0.2.2');
        editIp(2, '192.0.2.1');
        ledger.renderLedgerTable();
        assert.equal(await ledger.saveLedger(), true);
        assert.deepEqual(appState.devices.map(device => device.ip), ['192.0.2.2', '192.0.2.1']);

        editIp(1, '');
        editIp(2, '192.0.2.2');
        assert.equal(await ledger.saveLedger(), true);
        assert.deepEqual(appState.devices.map(device => device.ip), ['', '192.0.2.2']);

        editIp(1, '192.0.2.3');
        editIp(2, '192.0.2.3');
        let warning = '';
        window.confirm = message => { warning = message; return false; };
        assert.equal(await ledger.saveLedger(), false);
        assert.deepEqual(appState.devices.map(device => device.ip), ['', '192.0.2.2']);
        assert.equal(drafts.getDeviceDraft('ledger', 1).ip, '192.0.2.3');
        assert.equal(drafts.getDeviceDraft('ledger', 2).ip, '192.0.2.3');
        assert.ok(warning.includes('192.0.2.3') && warning.includes('SW1') && warning.includes('SW2'));
        window.confirm = () => true;
        assert.equal(await ledger.saveLedger(), true);
        assert.deepEqual(appState.devices.map(device => device.ip), ['192.0.2.3', '192.0.2.3']);
        drafts.discardDeviceDrafts('ledger');
    });
    assert.equal(await ledger.closeLedger(), true);
});
