import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appState } from '../public/js/core/state.js';
import { eventBus } from '../public/js/core/event-bus.js';
import { getTopModalContainer, registerModalOpen, registerModalClose, initModalFocusTrap } from '../public/js/core/modal-focus.js';
import { onKeyDown } from '../public/js/canvas/selection.js';
import {
    initializePingResultsModal, openPingResults, closePingResults,
    downloadPingResultsCsv, getLatestPingResultRun
} from '../public/js/modals/ping-results-modal.js';
import { installWorkspaceDom, WorkspaceElement } from './helpers/workspace-dom.mjs';

const startedAt = new Date(2026, 9, 8, 1, 2, 3);
const completedAt = new Date(2026, 9, 8, 1, 3, 4);

async function setup(t) {
    const keys = ['window', 'document', 'HTMLElement', 'Element', 'fetch'];
    const originals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const state = { ...appState };
    const urlMethods = new Map(['createObjectURL', 'revokeObjectURL'].map(key => [key, Object.getOwnPropertyDescriptor(URL, key)]));
    const dom = installWorkspaceDom({
        templates: ['templates/modals/ping_results.php', 'templates/modals/ledger.php', 'templates/components/status_bar.php'],
        phpSetup: '$isAdmin = true;'
    });
    document.readyState = 'loading';
    const { registerStaticListeners } = await import('../public/js/main.js');
    registerStaticListeners();
    Object.assign(appState, {
        devices: [{ id: 1, name: '機器 A', ip: '192.0.2.1', status: 'green' }],
        currentViewId: 7, selectedPlacementIds: new Set([22]), selectedCanvasNoteId: 5,
        editingDeviceId: 1, editingLinkId: 9, linkMode: true,
        appStatus: { dirty: true, state: 'dirty', lastMonitoredAt: '過去の監視日時' }
    });
    const ledger = dom.get('ledger-overlay');
    const body = dom.get('ledger-table-body');
    const row = dom.add('tr', '', body);
    dom.add('td', '', row).textContent = '保存前の台帳行';
    dom.get('ledger-search').value = '保持する検索';
    dom.add('option', '', dom.get('ledger-view-filter')).value = '7';
    dom.get('ledger-view-filter').value = '7';
    dom.get('ledger-status-filter').value = 'red';
    dom.get('busy-label').textContent = 'Ping確認中 0/1';
    dom.get('status-toast-message').textContent = '既存の一時通知';
    dom.get('status-save-state').textContent = '未保存';
    let requests = 0;
    let renders = 0;
    const stopRender = eventBus.on('ledger:render', () => { renders++; });
    globalThis.fetch = () => { requests++; throw new Error('結果表示からAPIを呼ばない'); };
    const downloads = [];
    const blobs = [];
    const revoked = [];
    const timers = [];
    let clickError = null;
    document.createElement = tag => {
        const element = new WorkspaceElement(tag);
        if (tag === 'a') element.click = () => {
            downloads.push({ href: element.href, filename: element.download, attached: document.body.contains(element) });
            if (clickError) throw clickError;
        };
        return element;
    };
    URL.createObjectURL = blob => { blobs.push(blob); return `blob:ping-${blobs.length}`; };
    URL.revokeObjectURL = url => revoked.push(url);
    window.setTimeout = (callback, delay) => { timers.push({ callback, delay }); return timers.length; };
    initializePingResultsModal();
    initializePingResultsModal();
    eventBus.emit('ping:updated', { running: true, targets: [], startedAt });
    t.after(() => {
        closePingResults();
        registerModalClose('ledger');
        timers.splice(0).forEach(timer => timer.callback());
        stopRender();
        Object.assign(appState, state);
        for (const [key, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
        for (const [key, descriptor] of urlMethods) Object.defineProperty(URL, key, descriptor);
    });
    return {
        ...dom, ledger, row, downloads, blobs, revoked, timers,
        requests: () => requests, renders: () => renders,
        failClick: error => { clickError = error; },
        finishTimers: () => timers.splice(0).forEach(timer => timer.callback())
    };
}

function start(targets) {
    eventBus.emit('ping:updated', { running: true, message: 'Ping確認中', targets, startedAt });
}
function finish(results, error = null) {
    eventBus.emit('ping:updated', { running: false, results, completedAt, error });
}
function rows(dom) { return dom.get('ping-results-table-body').children; }
function filter(dom, name) { return dom.get('ping-results-overlay').querySelector(`[data-ping-results-filter="${name}"]`); }
async function blobCsv(blob) {
    // Blob.text()は先頭BOMを除くため、バイト列からBOMを保持して復号する。
    return new TextDecoder('utf-8', { ignoreBOM: true }).decode(await blob.arrayBuffer());
}
function temporaryLinks() {
    return document.body.querySelectorAll('a').filter(link => link.href?.startsWith('blob:'));
}

function seedMixed() {
    appState.devices = Array.from({ length: 6 }, (_, index) => ({ id: index + 1, name: `機器 ${index + 1}`, status: 'red' }));
    start(appState.devices.map(device => ({ id: device.id, ip: `192.0.2.${device.id}` })));
    finish([
        { id: 1, outcome: 'success', response_ms: 0 },
        { id: 2, outcome: 'failure', error: '接続先に到達できません' },
        { id: 3, outcome: 'timeout', error: '待機時間を超過\n' + '詳細情報'.repeat(35) },
        { id: 4, outcome: 'skipped', error: 'IPアドレス未設定' },
        { id: 5, outcome: 'unknown', error: '<script>応答不明</script>' },
        { id: 999, outcome: 'success', response_ms: 1 }
    ]);
}

test('実テンプレートの1件結果は自動で開かず、フッターと台帳から閲覧・再表示できる', async t => {
    const dom = await setup(t);
    const before = structuredClone(appState);
    assert.equal(openPingResults(), false);
    assert.equal(downloadPingResultsCsv(), false);
    start([{ id: 1, ip: '192.0.2.1' }]);
    assert.equal(dom.get('status-ping-message').hidden, true);
    assert.equal(dom.get('status-ping-message').textContent, '');
    assert.equal(dom.get('status-toast-message').hidden, true);
    assert.equal(dom.get('ledger-ping-results-btn').disabled, true);
    assert.equal(document.body.classList.contains('has-ping-results'), false);
    assert.equal(dom.get('busy-label').textContent, 'Ping確認中 0/1', '進捗表示は共通busy-labelが所有する');
    finish([{ id: 1, outcome: 'success', response_ms: 2.5 }]);
    assert.equal(dom.get('ping-results-overlay').hidden, true, '完了で作業中のフォーカスを奪わない');
    assert.equal(dom.get('status-ping-message').hidden, false);
    assert.equal(dom.get('status-ping-results-btn').hidden, false);
    assert.equal(dom.get('status-ping-results-btn').disabled, false);
    assert.equal(dom.get('ledger-ping-results-btn').disabled, false);
    assert.equal(document.body.classList.contains('has-ping-results'), true);
    assert.equal(dom.get('status-toast-message').hidden, false);
    assert.equal(dom.get('status-toast-message').textContent, '既存の一時通知');
    assert.equal(dom.get('status-save-state').textContent, '未保存');
    const opener = dom.get('status-ping-results-btn');
    opener.focus(); await opener.dispatch('click');
    assert.equal(getTopModalContainer(), dom.get('ping-results-overlay'));
    assert.equal(rows(dom).length, 1);
    assert.equal(rows(dom)[0].children[0].querySelector('strong').textContent, '機器 A');
    assert.equal(rows(dom)[0].children[0].querySelector('span').textContent, '192.0.2.1');
    assert.equal(rows(dom)[0].children[1].textContent, 'OK');
    assert.equal(rows(dom)[0].children[2].textContent, '2.5');
    assert.equal(dom.get('ping-results-started-at').getAttribute('datetime'), startedAt.toISOString());
    assert.equal(dom.get('ping-results-completed-at').getAttribute('datetime'), completedAt.toISOString());
    await filter(dom, 'failed').dispatch('click');
    assert.equal(rows(dom).length, 0);
    assert.equal(dom.get('ping-results-empty').hidden, false);
    await dom.get('ping-results-overlay').querySelector('[data-ping-results-close]').dispatch('click');
    assert.equal(document.activeElement, opener);
    await dom.get('ledger-ping-results-btn').dispatch('click');
    assert.equal(rows(dom).length, 1, '開き直すとallに戻す');
    assert.equal(filter(dom, 'all').getAttribute('aria-pressed'), 'true');
    assert.deepEqual(appState, before);
    assert.equal(dom.get('ledger-table-body').children[0], dom.row);
    assert.equal(dom.requests(), 0);
    assert.equal(dom.renders(), 0);
});

test('複数結果の5区分・対象整合・失敗のみ・成功のみ・エラー全文を表示する', async t => {
    const dom = await setup(t);
    seedMixed(); openPingResults();
    assert.deepEqual(['total', 'success', 'failure', 'timeout', 'skipped', 'unknown'].map(key => dom.get(`ping-results-count-${key}`).textContent), ['6', '1', '1', '1', '1', '2']);
    assert.equal(rows(dom).length, 6);
    assert.equal(dom.get('ping-results-visible-count').textContent, '表示 6件 / 対象 6件');
    assert.equal(rows(dom)[0].children[2].textContent, '0');
    assert.equal(rows(dom)[5].children[1].textContent, '未確認');
    assert.equal(rows(dom)[5].children[2].textContent, '—');
    const shortDetail = rows(dom)[1].querySelector('details');
    const detail = rows(dom)[2].querySelector('details');
    assert.equal(Boolean(shortDetail.open) || shortDetail.getAttribute('open') !== null, false);
    assert.equal(Boolean(detail.open) || detail.getAttribute('open') !== null, false);
    assert.equal(shortDetail.querySelector('p').textContent, '接続先に到達できません');
    assert.ok(detail.querySelector('p').textContent.includes('\n'));
    assert.equal(rows(dom)[4].querySelector('details').querySelector('p').textContent, '<script>応答不明</script>');
    assert.equal(dom.get('ping-results-overlay').querySelectorAll('script').length, 0);
    assert.equal(dom.get('ping-results-error').hidden, true);
    assert.ok(dom.get('status-ping-message').textContent.includes('失敗 2件'));
    await filter(dom, 'failed').dispatch('click');
    assert.deepEqual(rows(dom).map(row => row.dataset.deviceId), ['2', '3']);
    assert.equal(filter(dom, 'failed').getAttribute('aria-pressed'), 'true');
    await filter(dom, 'success').dispatch('click');
    assert.deepEqual(rows(dom).map(row => row.dataset.deviceId), ['1']);
    await filter(dom, 'all').dispatch('click');
    assert.equal(rows(dom).length, 6);
});

test('API全体の処理失敗はalertと全行未確認に反映し、既存監視状態を保持する', async t => {
    const dom = await setup(t);
    const before = structuredClone(appState);
    start([{ id: 1, ip: '192.0.2.1' }, { id: 2, ip: '192.0.2.2' }]);
    finish([{ id: 1, outcome: 'success', response_ms: 2 }], 'APIへの接続に失敗しました');
    assert.equal(dom.get('ping-results-overlay').hidden, true);
    assert.ok(dom.get('status-ping-message').textContent.includes('APIへの接続に失敗しました'));
    assert.ok(dom.get('status-ping-message').getAttribute('title').includes('APIへの接続に失敗しました'));
    openPingResults();
    assert.equal(dom.get('ping-results-error').hidden, false);
    assert.equal(dom.get('ping-results-error').getAttribute('role'), 'alert');
    assert.ok(dom.get('ping-results-error').textContent.includes('APIへの接続に失敗しました'));
    assert.equal(dom.get('ping-results-count-unknown').textContent, '2');
    assert.deepEqual(rows(dom).map(row => row.children[1].textContent), ['未確認', '未確認']);
    assert.deepEqual(rows(dom).map(row => row.querySelector('details').querySelector('p').textContent), ['APIへの接続に失敗しました', 'APIへの接続に失敗しました']);
    await filter(dom, 'failed').dispatch('click');
    assert.equal(rows(dom).length, 0, '処理失敗の未確認をNGへ分類しない');
    assert.deepEqual(appState, before);
    assert.equal(getLatestPingResultRun().phase, 'failed');
    downloadPingResultsCsv();
    const csv = await blobCsv(dom.blobs[0]);
    assert.ok(csv.includes('未確認'));
    assert.ok(csv.includes('APIへの接続に失敗しました'));
    dom.finishTimers();
    assert.deepEqual(dom.revoked, ['blob:ping-1']);
});

test('開始時snapshotを進捗で作り直さず、新実行では旧結果を閉じて混在させない', async t => {
    const dom = await setup(t);
    const targets = [{ id: 1, ip: '192.0.2.1' }];
    start(targets);
    const snapshot = getLatestPingResultRun();
    targets[0].ip = '203.0.113.10';
    appState.devices[0].name = '実行後に改名';
    eventBus.emit('ping:updated', { running: true, message: 'Ping確認中 1/1' });
    assert.equal(getLatestPingResultRun(), snapshot);
    finish([{ id: 1, outcome: 'failure', error: '前回の理由' }]);
    openPingResults();
    assert.equal(rows(dom)[0].children[0].querySelector('strong').textContent, '機器 A');
    assert.equal(rows(dom)[0].children[0].querySelector('span').textContent, '192.0.2.1');
    start([{ id: 2, ip: '192.0.2.2' }]);
    assert.equal(dom.get('ping-results-overlay').hidden, true);
    assert.equal(getTopModalContainer(), null);
    assert.equal(rows(dom).length, 0);
    assert.equal(dom.get('status-ping-results-btn').disabled, true);
    assert.equal(dom.get('ledger-ping-results-btn').disabled, true);
    assert.equal(document.body.classList.contains('has-ping-results'), false);
    assert.equal(getLatestPingResultRun().rows.length, 1);
    assert.equal(getLatestPingResultRun().rows[0].id, 2);
    finish([{ id: 1, outcome: 'failure', error: '混在不可' }, { id: 2, outcome: 'success', response_ms: 7 }]);
    openPingResults();
    assert.deepEqual(rows(dom).map(row => row.dataset.deviceId), ['2']);
    assert.equal(dom.get('ping-results-count-failure').textContent, '0');
    assert.ok(!dom.get('ping-results-overlay').textContent.includes('前回の理由'));
    assert.ok(!dom.get('ping-results-overlay').textContent.includes('混在不可'));
});

test('実BlobのCSVは絞り込み・閉鎖に依存せず全件・BOM・filename・URL解放を保つ', async t => {
    const dom = await setup(t);
    seedMixed(); openPingResults();
    await filter(dom, 'failed').dispatch('click');
    await dom.get('ping-results-csv-btn').dispatch('click');
    assert.equal(dom.blobs.length, 1);
    assert.equal(dom.blobs[0] instanceof Blob, true);
    assert.equal(dom.blobs[0].type, 'text/csv;charset=utf-8');
    assert.deepEqual([...new Uint8Array(await dom.blobs[0].arrayBuffer()).slice(0, 3)], [0xef, 0xbb, 0xbf]);
    const csv = await blobCsv(dom.blobs[0]);
    assert.deepEqual([...csv.matchAll(/"機器 (\d+)","192\.0\.2\.\d+"/g)].map(match => Number(match[1])), [1, 2, 3, 4, 5, 6]);
    assert.equal(dom.downloads[0].filename, 'ping_20261008_010203.csv');
    assert.equal(dom.downloads[0].attached, true);
    assert.equal(temporaryLinks().length, 0);
    assert.equal(rows(dom).length, 2, 'CSVは閲覧中の絞り込みを変更しない');
    assert.deepEqual(dom.revoked, [], 'ダウンロード開始前にURLを解放しない');
    dom.finishTimers();
    assert.deepEqual(dom.revoked, ['blob:ping-1']);
    closePingResults();
    assert.equal(downloadPingResultsCsv(), true, '閉じていても直近の全runを出力する');
    assert.equal(await blobCsv(dom.blobs[1]), csv, '閉鎖しても同じ全件結果を出力する');
    dom.finishTimers();
    assert.deepEqual(dom.revoked, ['blob:ping-1', 'blob:ping-2']);
    dom.failClick(new Error('ダウンロード起動失敗'));
    assert.throws(downloadPingResultsCsv, /ダウンロード起動失敗/);
    assert.equal(temporaryLinks().length, 0);
    dom.finishTimers();
    assert.deepEqual(dom.revoked, ['blob:ping-1', 'blob:ping-2', 'blob:ping-3']);
});

test('台帳上のmodal stack・Tabtrap・外側click・Esc・closeで台帳DOMとstateを維持する', async t => {
    const dom = await setup(t);
    start([{ id: 1, ip: '192.0.2.1' }]); finish([{ id: 1, outcome: 'failure', error: '詳細を確認する理由' }]);
    const before = structuredClone(appState);
    const ledgerBody = dom.get('ledger-table-body');
    const children = [...ledgerBody.children];
    const tableText = ledgerBody.textContent;
    dom.ledger.hidden = false;
    dom.get('ledger-search').focus();
    registerModalOpen('ledger', dom.ledger, '#ledger-search');
    const opener = dom.get('ledger-ping-results-btn');
    opener.focus(); await opener.dispatch('click');
    const overlay = dom.get('ping-results-overlay');
    assert.equal(getTopModalContainer(), overlay);
    assert.equal(dom.ledger.inert, true);
    assert.equal(dom.ledger.querySelector('[role="dialog"]').getAttribute('aria-modal'), 'false');
    assert.equal(document.activeElement, overlay.querySelector('[data-ping-results-close]'));
    initModalFocusTrap();
    const closeButton = overlay.querySelector('[data-ping-results-close]');
    const lastDetail = rows(dom)[0].querySelector('summary');
    lastDetail.focus();
    let prevented = false;
    await dom.events.dispatch('keydown', { key: 'Tab', preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(document.activeElement, closeButton);
    await dom.events.dispatch('keydown', { key: 'Tab', shiftKey: true, preventDefault() {} });
    assert.equal(document.activeElement, lastDetail);
    await overlay.dispatch('click', { target: overlay.querySelector('[role="dialog"]') });
    assert.equal(overlay.hidden, false, 'dialog内部clickでは閉じない');
    await overlay.dispatch('click');
    assert.equal(overlay.hidden, true);
    assert.equal(getTopModalContainer(), dom.ledger);
    assert.equal(dom.ledger.inert, false);
    assert.equal(document.activeElement, opener);
    await opener.dispatch('click');
    await onKeyDown({ key: 'Escape', preventDefault() {}, stopImmediatePropagation() {} });
    assert.equal(overlay.hidden, true);
    assert.equal(getTopModalContainer(), dom.ledger);
    assert.equal(document.activeElement, opener);
    closePingResults();
    assert.deepEqual(ledgerBody.children, children);
    assert.equal(ledgerBody.textContent, tableText);
    assert.equal(dom.get('ledger-search').value, '保持する検索');
    assert.equal(dom.get('ledger-view-filter').value, '7');
    assert.equal(dom.get('ledger-status-filter').value, 'red');
    assert.equal(dom.ledger.hidden, false);
    assert.deepEqual(appState, before);
    assert.equal(dom.renders(), 0);
    assert.equal(dom.requests(), 0);
});

test('150件の長い名前と混在結果を切り捨てず、失敗と成功の対象を切り替えられる', async t => {
    const dom = await setup(t);
    appState.devices = Array.from({ length: 150 }, (_, index) => ({ id: index + 1, name: `大量機器${index + 1}` + '長い機器名'.repeat(20) }));
    start(appState.devices.map(device => ({ id: device.id, ip: `192.0.2.${device.id}` })));
    finish(appState.devices.map(device => ({ id: device.id, outcome: device.id % 2 ? 'success' : 'timeout', response_ms: device.id % 2 ? 1 : null })));
    openPingResults();
    assert.equal(rows(dom).length, 150);
    assert.equal(dom.get('ping-results-count-total').textContent, '150');
    assert.equal(dom.get('ping-results-count-success').textContent, '75');
    assert.equal(dom.get('ping-results-count-timeout').textContent, '75');
    assert.deepEqual(rows(dom).map(row => Number(row.dataset.deviceId)), Array.from({ length: 150 }, (_, index) => index + 1));
    await filter(dom, 'failed').dispatch('click');
    assert.deepEqual(rows(dom).map(row => Number(row.dataset.deviceId)), Array.from({ length: 75 }, (_, index) => (index + 1) * 2));
    await filter(dom, 'success').dispatch('click');
    assert.deepEqual(rows(dom).map(row => Number(row.dataset.deviceId)), Array.from({ length: 75 }, (_, index) => index * 2 + 1));
    await filter(dom, 'all').dispatch('click');
    assert.equal(rows(dom).at(-1).children[0].querySelector('strong').textContent, appState.devices.at(-1).name);
});
