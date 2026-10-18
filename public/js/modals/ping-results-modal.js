import { appState } from '../core/state.js';
import { eventBus } from '../core/event-bus.js';
import { registerModalOpen, registerModalClose } from '../core/modal-focus.js';
import {
    PING_RESULT_LABELS, createPingResultRun, completePingResultRun,
    getPingResultSummary, filterPingResultRows, serializePingResultCsv, getPingResultCsvFilename
} from '../core/ping-result-data.js';

let latestRun = null;
let activeFilter = 'all';
let subscribed = false;
const initializedOverlays = new WeakSet();

export function getLatestPingResultRun() {
    return latestRun;
}

function isComplete() {
    return latestRun !== null && latestRun.phase !== 'running';
}

function renderFooter() {
    const complete = isComplete();
    const running = latestRun?.phase === 'running';
    const container = document.getElementById('status-ping-container');
    document.body.classList.toggle('has-ping-results', complete);
    const message = document.getElementById('status-ping-message');
    const button = document.getElementById('status-ping-results-btn');
    if (container) container.hidden = !latestRun;
    if (message) {
        message.hidden = !complete;
        message.textContent = '';
        if (complete) {
            const counts = getPingResultSummary(latestRun);
            const label = latestRun.error ? 'Ping処理失敗' : 'Ping完了';
            message.textContent = `${label}: ${counts.total}件 / OK ${counts.success}件 / 失敗 ${counts.failure + counts.timeout}件`;
            if (counts.skipped) message.textContent += ` / スキップ ${counts.skipped}件`;
            if (counts.unknown) message.textContent += ` / 未確認 ${counts.unknown}件`;
            if (latestRun.error) message.textContent += ` / ${latestRun.error}`;
        }
        message.setAttribute('title', message.textContent);
    }
    if (button) {
        button.hidden = !complete;
        button.disabled = !complete;
    }
    const ledgerButton = document.getElementById('ledger-ping-results-btn');
    if (ledgerButton) ledgerButton.disabled = !complete;
    // 進捗はフッターの共通busy-labelだけで表示し、一時通知との重複を避ける。
    const toastMessage = document.getElementById('status-toast-message');
    if (toastMessage) toastMessage.hidden = Boolean(running);
}

function setTime(id, value) {
    const element = document.getElementById(id);
    element.textContent = value ? new Date(value).toLocaleString('ja-JP') : '未完了';
    if (value) element.setAttribute('datetime', value);
    else element.removeAttribute('datetime');
}

function appendCell(row, text, className = '') {
    const cell = document.createElement('td');
    cell.textContent = text;
    if (className) cell.className = className;
    row.appendChild(cell);
    return cell;
}

function appendError(cell, error) {
    if (!error) {
        cell.textContent = '—';
        return;
    }
    const details = document.createElement('details');
    details.className = 'ping-results-error-details';
    const summary = document.createElement('summary');
    summary.className = 'btn btn-tertiary btn-sm';
    summary.tabIndex = 0;
    summary.textContent = '詳細';
    const fullText = document.createElement('p');
    fullText.textContent = String(error);
    details.append(summary, fullText);
    cell.appendChild(details);
}

function renderRows() {
    const rows = filterPingResultRows(latestRun, activeFilter);
    const body = document.getElementById('ping-results-table-body');
    body.replaceChildren();
    for (const result of rows) {
        const row = document.createElement('tr');
        row.dataset.deviceId = String(result.id);
        const deviceCell = appendCell(row, '');
        const name = document.createElement('strong');
        name.textContent = result.name || '（名称なし）';
        const ip = document.createElement('span');
        ip.className = 'ledger-sheet-sub';
        ip.textContent = result.ip || '—';
        deviceCell.append(name, ip);
        const outcome = document.createElement('span');
        outcome.className = result.outcome === 'success' ? 'status-ok'
            : result.outcome === 'failure' || result.outcome === 'timeout' ? 'status-ng' : 'is-muted';
        outcome.textContent = PING_RESULT_LABELS[result.outcome];
        appendCell(row, '').appendChild(outcome);
        appendCell(row, result.response_ms === null ? '—' : String(result.response_ms));
        appendError(appendCell(row, ''), result.error);
        body.appendChild(row);
    }
    document.getElementById('ping-results-visible-count').textContent = `表示 ${rows.length}件 / 対象 ${latestRun.rows.length}件`;
    document.getElementById('ping-results-empty').hidden = rows.length > 0;
    document.getElementById('ping-results-list').scrollTop = 0;
    document.querySelectorAll('[data-ping-results-filter]').forEach(button => {
        const selected = button.dataset.pingResultsFilter === activeFilter;
        button.setAttribute('aria-pressed', String(selected));
        button.classList.toggle('btn-primary', selected);
        button.classList.toggle('btn-secondary', !selected);
    });
}

function renderRun() {
    const counts = getPingResultSummary(latestRun);
    for (const key of ['total', ...Object.keys(PING_RESULT_LABELS)]) {
        document.getElementById(`ping-results-count-${key}`).textContent = String(counts[key]);
    }
    setTime('ping-results-started-at', latestRun.startedAt);
    setTime('ping-results-completed-at', latestRun.completedAt);
    const error = document.getElementById('ping-results-error');
    error.hidden = !latestRun.error;
    error.textContent = latestRun.error ? `Ping処理に失敗しました: ${latestRun.error}` : '';
    document.getElementById('ping-results-csv-btn').disabled = !isComplete();
    renderRows();
}

export function openPingResults() {
    const overlay = document.getElementById('ping-results-overlay');
    if (!overlay || !isComplete()) return false;
    activeFilter = 'all';
    renderRun();
    overlay.hidden = false;
    registerModalOpen('ping-results', overlay, '[data-ping-results-close]', { onClose: closePingResults });
    return true;
}

export function closePingResults() {
    const overlay = document.getElementById('ping-results-overlay');
    if (overlay) overlay.hidden = true;
    registerModalClose('ping-results');
    return true;
}

export function downloadPingResultsCsv() {
    if (!isComplete()) return false;
    // 表示フィルターにかかわらず、直近の実行対象を全件出力する。
    const blob = new Blob([serializePingResultCsv(latestRun)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    try {
        link.href = url;
        link.download = getPingResultCsvFilename(latestRun);
        link.hidden = true;
        document.body.appendChild(link);
        link.click();
    } finally {
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    return true;
}

function handlePingUpdated(update = {}) {
    if (update.running) {
        // targetsがある開始イベントだけsnapshotを作り、進捗イベントでは差し替えない。
        if (!Array.isArray(update.targets)) return;
        closePingResults();
        latestRun = createPingResultRun(update.targets, appState.devices, update.startedAt);
        activeFilter = 'all';
        document.getElementById('ping-results-table-body')?.replaceChildren();
        renderFooter();
        return;
    }
    if (!latestRun || latestRun.phase !== 'running') return;
    latestRun = completePingResultRun(latestRun, update.results, update.completedAt, update.error);
    renderFooter();
}

export function initializePingResultsModal() {
    const overlay = document.getElementById('ping-results-overlay');
    if (!overlay) return;
    if (!initializedOverlays.has(overlay)) {
        initializedOverlays.add(overlay);
        overlay.querySelectorAll('[data-ping-results-close]').forEach(button => {
            button.addEventListener('click', closePingResults);
        });
        overlay.querySelectorAll('[data-ping-results-filter]').forEach(button => {
            button.addEventListener('click', () => {
                activeFilter = button.dataset.pingResultsFilter;
                renderRows();
            });
        });
        document.getElementById('ping-results-csv-btn').addEventListener('click', downloadPingResultsCsv);
    }
    if (!subscribed) {
        subscribed = true;
        eventBus.on('ping:updated', handlePingUpdated);
    }
    renderFooter();
}
