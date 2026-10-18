import assert from 'node:assert/strict';
import fs from 'node:fs';
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

    await t.test('保持した複数下書きのIP交換・付け替えは保存でき、最終候補の重複は拒否する', async () => {
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
        assert.equal(await ledger.saveLedger(), false);
        assert.deepEqual(appState.devices.map(device => device.ip), ['', '192.0.2.2']);
        assert.equal(drafts.getDeviceDraft('ledger', 1).ip, '192.0.2.3');
        assert.equal(drafts.getDeviceDraft('ledger', 2).ip, '192.0.2.3');
        drafts.discardDeviceDrafts('ledger');
    });
    assert.equal(await ledger.closeLedger(), true);
});

test('スタイル定義: 個票の各入力BOXに検索BOXと同様のPrimary青枠フォーカスが指定されている', () => {
    const baseCss = fs.readFileSync(new URL('../public/css/base.css', import.meta.url), 'utf8');
    const ledgerCss = fs.readFileSync(new URL('../public/css/modals/ledger.css', import.meta.url), 'utf8');
    assert.match(baseCss, /\.ledger-sheet-table input:focus-visible/);
    assert.match(baseCss, /outline:\s*2px solid var\(--primary\)\s*!important/);
    assert.match(ledgerCss, /\.ledger-sheet-table input:not\(\[readonly\]\):not\(:disabled\):focus-visible/);
});
