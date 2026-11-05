/**
 * Netarium - modals/change-history-modal.js
 *
 * 管理者専用の共通変更履歴モーダル（機器・ビュー・ラック統合）。
 */

import { appState } from '../core/state.js';
import { apiFetch } from '../core/api-client.js';
import { eventBus } from '../core/event-bus.js';
import { registerModalOpen, registerModalClose } from '../core/modal-focus.js';
import { formatStatusTime } from '../core/utils.js';
import { isCurrentUserAdmin, requireAdminUiAction } from '../ui/access-control.js';
import { closeToolbarMenu } from '../ui/toolbar-controls.js';

const ALLOWED_DAYS = [7, 30, 90];
const DEFAULT_DAYS = 30;
const PER_PAGE = 50;
const MAX_QUERY_CODEPOINTS = 200;
const SUSPENDABLE_MODAL_IDS = [
    'ledger-overlay',
    'ledger-device-sheet-overlay',
    'view-manager-overlay'
];

const OPERATION_META = Object.freeze({
    create: { label: '作成', className: 'is-create' },
    update: { label: '更新', className: 'is-update' },
    delete: { label: '削除', className: 'is-delete' }
});

let overlay = null;
let periodButtons = [];
let typeSelect = null;
let searchInput = null;
let actorSelect = null;
let resetButton = null;
let refreshButton = null;
let filterErrorEl = null;
let targetBannerEl = null;
let targetBannerTextEl = null;
let targetBannerDeletedEl = null;
let metaSummaryEl = null;
let paginationWrapEl = null;
let prevPageBtn = null;
let nextPageBtn = null;
let pageIndicatorEl = null;
let statusMessageEl = null;
let tableWrapEl = null;
let tbodyEl = null;

let days = DEFAULT_DAYS;
let targetType = '';
let targetId = null;
let targetNameHint = '';
let query = '';
let actor = '';
let page = 1;
let total = 0;
let totalPages = 1;
let items = [];
let actors = [];
let focusedTarget = null;
let expandedIds = new Set();
let loading = false;
let errorText = '';
let requestSeq = 0;
let searchDebounceTimer = null;
let suspendedOverlays = [];

function node(tag, text = null, className = '') {
    const el = document.createElement(tag);
    if (text !== null && text !== undefined) {
        el.textContent = String(text);
    }
    if (className) {
        el.className = className;
    }
    return el;
}

function codePointLength(str) {
    return Array.from(String(str ?? '')).length;
}

function formatTargetTypeBadge(row) {
    if (row.target_type === 'device') {
        return '機器';
    }
    if (row.view_type === 'rack') {
        return 'ビュー（ラック）';
    }
    if (row.view_type === 'floor') {
        return 'ビュー（フロア）';
    }
    return 'ビュー';
}

function hasNonDefaultFilter() {
    return days !== DEFAULT_DAYS ||
        targetType !== '' ||
        targetId !== null ||
        query.trim() !== '' ||
        actor !== '';
}

function ensureDom() {
    if (overlay && overlay.ownerDocument === document) {
        return;
    }

    overlay = node('div', null, 'modal-overlay change-history-overlay');
    overlay.id = 'change-history-overlay';
    overlay.hidden = true;

    const dialog = node('section', null, 'modal-dialog change-history-dialog');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'change-history-title');

    const header = node('header', null, 'modal-header change-history-header');
    const title = node('h2', '変更履歴');
    title.id = 'change-history-title';

    const headerActions = node('div', null, 'change-history-header-actions');
    refreshButton = node('button', null, 'btn btn-secondary btn-sm change-history-refresh-btn');
    refreshButton.id = 'change-history-refresh-btn';
    refreshButton.type = 'button';
    const refreshIcon = node('img', null, 'change-history-refresh-icon');
    refreshIcon.src = 'assets/icons/app/refresh.svg';
    refreshIcon.width = 16;
    refreshIcon.height = 16;
    refreshIcon.alt = '';
    refreshIcon.setAttribute('aria-hidden', 'true');
    refreshButton.append(refreshIcon, node('span', '更新'));
    refreshButton.addEventListener('click', () => fetchHistory());

    const closeBtn = node('button', '×', 'modal-close-btn');
    closeBtn.id = 'close-change-history-btn';
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', '閉じる');
    closeBtn.addEventListener('click', () => closeChangeHistory());

    headerActions.append(refreshButton, closeBtn);
    header.append(title, headerActions);

    const toolbar = node('div', null, 'change-history-toolbar');

    const periodGroup = node('div', null, 'change-history-period-group');
    periodGroup.setAttribute('role', 'group');
    periodGroup.setAttribute('aria-label', '表示期間');
    periodButtons = ALLOWED_DAYS.map(period => {
        const btn = node('button', `直近${period}日`, 'change-history-period-btn');
        btn.type = 'button';
        btn.dataset.period = String(period);
        btn.setAttribute('aria-pressed', String(period === DEFAULT_DAYS));
        btn.addEventListener('click', () => {
            if (days === period && !loading) return;
            days = period;
            page = 1;
            expandedIds.clear();
            syncFilterControls();
            return fetchHistory();
        });
        periodGroup.appendChild(btn);
        return btn;
    });

    typeSelect = node('select', null, 'change-history-select');
    typeSelect.id = 'change-history-type-filter';
    typeSelect.setAttribute('aria-label', '対象種別');
    [
        ['', '対象種別: すべて'],
        ['device', '機器'],
        ['view', 'ビュー（ラック含む）']
    ].forEach(([val, label]) => {
        const opt = node('option', label);
        opt.value = val;
        typeSelect.appendChild(opt);
    });
    typeSelect.addEventListener('change', () => {
        targetType = typeSelect.value;
        targetId = null;
        targetNameHint = '';
        focusedTarget = null;
        page = 1;
        expandedIds.clear();
        syncFilterControls();
        return fetchHistory();
    });

    searchInput = node('input', null, 'change-history-search');
    searchInput.id = 'change-history-search';
    searchInput.type = 'search';
    searchInput.placeholder = '対象名で検索';
    searchInput.setAttribute('aria-label', '対象名検索');
    searchInput.addEventListener('input', () => {
        query = searchInput.value;
        syncFilterControls();
        clearTimeout(searchDebounceTimer);
        if (!validateQueryLength()) {
            return;
        }
        searchDebounceTimer = setTimeout(() => {
            page = 1;
            expandedIds.clear();
            void fetchHistory();
        }, 250);
    });
    searchInput.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
            event.preventDefault();
            clearTimeout(searchDebounceTimer);
            if (!validateQueryLength()) return;
            page = 1;
            expandedIds.clear();
            return fetchHistory();
        }
    });

    actorSelect = node('select', null, 'change-history-select');
    actorSelect.id = 'change-history-actor-filter';
    actorSelect.setAttribute('aria-label', '操作者');
    actorSelect.addEventListener('change', () => {
        actor = actorSelect.value;
        page = 1;
        expandedIds.clear();
        syncFilterControls();
        return fetchHistory();
    });

    resetButton = node('button', '条件を解除', 'btn btn-secondary btn-sm');
    resetButton.id = 'change-history-reset-btn';
    resetButton.type = 'button';
    resetButton.addEventListener('click', () => {
        clearTimeout(searchDebounceTimer);
        days = DEFAULT_DAYS;
        targetType = '';
        targetId = null;
        targetNameHint = '';
        focusedTarget = null;
        query = '';
        actor = '';
        page = 1;
        expandedIds.clear();
        setFilterError('');
        syncFilterControls();
        return fetchHistory();
    });

    toolbar.append(searchInput, typeSelect, actorSelect, periodGroup, resetButton);

    filterErrorEl = node('p', '', 'form-error change-history-filter-error');
    filterErrorEl.id = 'change-history-filter-error';
    filterErrorEl.setAttribute('aria-live', 'polite');
    filterErrorEl.hidden = true;

    targetBannerEl = node('div', null, 'change-history-target-banner');
    targetBannerEl.id = 'change-history-target-banner';
    targetBannerEl.hidden = true;
    const bannerInfo = node('div', null, 'change-history-target-banner-info');
    targetBannerTextEl = node('span', '', 'change-history-target-banner-text');
    targetBannerDeletedEl = node('span', '削除済み', 'change-history-deleted-badge');
    targetBannerDeletedEl.hidden = true;
    bannerInfo.append(targetBannerTextEl, targetBannerDeletedEl);
    const clearTargetBtn = node('button', '対象絞り込みを解除', 'btn btn-secondary btn-sm');
    clearTargetBtn.id = 'change-history-clear-target-btn';
    clearTargetBtn.type = 'button';
    clearTargetBtn.addEventListener('click', () => {
        targetType = '';
        targetId = null;
        targetNameHint = '';
        focusedTarget = null;
        page = 1;
        expandedIds.clear();
        syncFilterControls();
        return fetchHistory();
    });
    targetBannerEl.append(bannerInfo, clearTargetBtn);

    const metaBar = node('div', null, 'change-history-meta-bar');
    metaSummaryEl = node('div', '', 'change-history-meta-summary');
    metaSummaryEl.setAttribute('aria-live', 'polite');

    paginationWrapEl = node('div', null, 'change-history-pagination');
    prevPageBtn = node('button', '前へ', 'btn btn-secondary btn-sm');
    prevPageBtn.id = 'change-history-prev-page';
    prevPageBtn.type = 'button';
    prevPageBtn.addEventListener('click', () => {
        if (page <= 1 || loading) return;
        page--;
        expandedIds.clear();
        return fetchHistory();
    });
    pageIndicatorEl = node('span', '1 / 1 ページ', 'change-history-page-indicator');
    nextPageBtn = node('button', '次へ', 'btn btn-secondary btn-sm');
    nextPageBtn.id = 'change-history-next-page';
    nextPageBtn.type = 'button';
    nextPageBtn.addEventListener('click', () => {
        if (page >= totalPages || loading) return;
        page++;
        expandedIds.clear();
        return fetchHistory();
    });
    paginationWrapEl.append(prevPageBtn, pageIndicatorEl, nextPageBtn);
    metaBar.append(metaSummaryEl, paginationWrapEl);

    statusMessageEl = node('div', '', 'change-history-status');
    statusMessageEl.setAttribute('role', 'status');
    statusMessageEl.setAttribute('aria-live', 'polite');
    statusMessageEl.hidden = true;

    tableWrapEl = node('div', null, 'change-history-table-wrap');
    const table = node('table', null, 'change-history-table');
    const thead = node('thead');
    const headRow = node('tr');
    [
        ['詳細', 'col-expand'],
        ['日時', 'col-time'],
        ['操作者', 'col-actor'],
        ['対象種別', 'col-type'],
        ['対象名', 'col-target'],
        ['操作', 'col-operation'],
        ['変更内容', 'col-summary']
    ].forEach(([label, cls]) => {
        const th = node('th', label, cls);
        th.scope = 'col';
        headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    tbodyEl = node('tbody');
    tbodyEl.id = 'change-history-tbody';
    table.append(thead, tbodyEl);
    tableWrapEl.appendChild(table);

    const body = node('div', null, 'modal-body change-history-body');
    body.append(toolbar, filterErrorEl, targetBannerEl, metaBar, statusMessageEl, tableWrapEl);

    dialog.append(header, body);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
}

function setFilterError(message) {
    if (!filterErrorEl || !searchInput) return;
    filterErrorEl.textContent = message;
    filterErrorEl.hidden = !message;
    if (message) {
        searchInput.setAttribute('aria-invalid', 'true');
        searchInput.setAttribute('aria-describedby', 'change-history-filter-error');
    } else {
        searchInput.removeAttribute('aria-invalid');
        searchInput.removeAttribute('aria-describedby');
    }
}

function validateQueryLength() {
    const trimmed = query.trim();
    if (codePointLength(trimmed) > MAX_QUERY_CODEPOINTS) {
        setFilterError(`対象名検索は${MAX_QUERY_CODEPOINTS}文字以内で入力してください。`);
        return false;
    }
    setFilterError('');
    return true;
}

function syncActorOptions() {
    if (!actorSelect) return;
    const optionValues = [...actors];
    if (actor !== '' && !optionValues.includes(actor)) {
        optionValues.unshift(actor);
    }
    actorSelect.replaceChildren();
    const allOpt = node('option', '操作者: すべて');
    allOpt.value = '';
    actorSelect.appendChild(allOpt);
    optionValues.forEach(name => {
        const opt = node('option', name);
        opt.value = name;
        actorSelect.appendChild(opt);
    });
    actorSelect.value = actor;
}

function syncFilterControls() {
    if (!overlay) return;
    periodButtons.forEach(btn => {
        const active = Number(btn.dataset.period) === days;
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-pressed', String(active));
    });
    if (typeSelect) {
        typeSelect.value = targetType;
    }
    if (searchInput && searchInput.value !== query) {
        searchInput.value = query;
    }
    syncActorOptions();
    if (resetButton) {
        resetButton.disabled = !hasNonDefaultFilter();
    }
    if (refreshButton) {
        refreshButton.disabled = loading;
    }

    if (targetBannerEl && targetBannerTextEl && targetBannerDeletedEl) {
        if (targetId !== null && (targetType === 'device' || targetType === 'view')) {
            const typeText = targetType === 'device'
                ? '機器'
                : (focusedTarget?.view_type === 'rack'
                    ? 'ビュー（ラック）'
                    : (focusedTarget?.view_type === 'floor' ? 'ビュー（フロア）' : 'ビュー'));
            const resolvedName = focusedTarget && Number(focusedTarget.target_id) === targetId
                ? focusedTarget.target_name
                : (targetNameHint || `ID: ${targetId}`);
            targetBannerTextEl.textContent = `対象絞り込み中: ${typeText}「${resolvedName}」(ID: ${targetId})`;
            targetBannerDeletedEl.hidden = !(focusedTarget && focusedTarget.target_exists === false);
            targetBannerEl.hidden = false;
        } else {
            targetBannerEl.hidden = true;
            targetBannerDeletedEl.hidden = true;
        }
    }
}

function focusFilterOnTarget(nextType, nextId, nextName = '') {
    if (!nextType || !Number.isSafeInteger(Number(nextId)) || Number(nextId) <= 0) return;
    targetType = nextType;
    targetId = Number(nextId);
    targetNameHint = nextName || '';
    focusedTarget = null;
    query = '';
    page = 1;
    expandedIds.clear();
    setFilterError('');
    syncFilterControls();
    return fetchHistory();
}

function toggleRowExpanded(id, detailRow, expandBtn, mainRow) {
    const nextExpanded = !expandedIds.has(id);
    if (nextExpanded) {
        expandedIds.add(id);
    } else {
        expandedIds.delete(id);
    }
    detailRow.hidden = !nextExpanded;
    mainRow.classList.toggle('is-expanded', nextExpanded);
    expandBtn.setAttribute('aria-expanded', String(nextExpanded));
    expandBtn.setAttribute('aria-label', nextExpanded ? '差分を折りたたむ' : '差分を展開');
    expandBtn.textContent = nextExpanded ? '▾' : '▸';
}

function renderDetailContent(row) {
    const container = node('div', null, 'change-history-detail-box');

    const metaRow = node('div', null, 'change-history-detail-meta');
    metaRow.appendChild(node('span', `保存イベント #${row.event_id}`, 'change-history-event-badge'));
    if (row.request_id) {
        metaRow.appendChild(node('span', `照合ID: ${row.request_id}`, 'change-history-request-id'));
    }
    container.appendChild(metaRow);

    const siblings = Array.isArray(row.related_targets) ? row.related_targets : [];
    const omittedSiblings = Number(row.related_omitted_count || 0);
    if (siblings.length > 0 || omittedSiblings > 0) {
        const relatedBar = node('div', null, 'change-history-related-bar');
        relatedBar.appendChild(node('span', '同一保存イベントの関連対象:', 'change-history-related-label'));
        const list = node('div', null, 'change-history-related-list');
        siblings.forEach(sib => {
            const opLabel = OPERATION_META[sib.operation]?.label || sib.operation;
            const kindLabel = sib.target_type === 'device' ? '機器' : 'ビュー';
            const suffix = sib.target_exists === false ? '（削除済み）' : '';
            const btn = node(
                'button',
                `${kindLabel}: ${sib.target_name} (ID: ${sib.target_id}) [${opLabel}]${suffix}`,
                'change-history-related-chip'
            );
            btn.type = 'button';
            btn.title = 'この対象の変更履歴で絞り込む';
            btn.addEventListener('click', () => {
                focusFilterOnTarget(sib.target_type, sib.target_id, sib.target_name);
            });
            list.appendChild(btn);
        });
        if (omittedSiblings > 0) {
            list.appendChild(node('span', `ほか ${omittedSiblings}件`, 'change-history-related-more'));
        }
        relatedBar.appendChild(list);
        container.appendChild(relatedBar);
    }

    const diffTable = node('table', null, 'change-history-diff-table');
    const thead = node('thead');
    const headTr = node('tr');
    ['項目', '変更前', '変更後'].forEach(label => {
        const th = node('th', label);
        th.scope = 'col';
        headTr.appendChild(th);
    });
    thead.appendChild(headTr);
    const diffBody = node('tbody');
    const diffItems = Array.isArray(row.items) ? row.items : [];
    if (diffItems.length === 0) {
        const emptyTr = node('tr');
        const td = node('td', row.summary || '詳細差分なし');
        td.colSpan = 3;
        emptyTr.appendChild(td);
        diffBody.appendChild(emptyTr);
    } else {
        diffItems.forEach(item => {
            const tr = node('tr');
            tr.appendChild(node('td', item.label ?? '', 'diff-col-label'));
            tr.appendChild(node('td', item.before ?? '—', 'diff-col-before'));
            tr.appendChild(node('td', item.after ?? '—', 'diff-col-after'));
            diffBody.appendChild(tr);
        });
    }
    diffTable.append(thead, diffBody);
    container.appendChild(diffTable);

    if (Number(row.omitted_count) > 0) {
        container.appendChild(
            node('p', `大量変更のため、ほか ${row.omitted_count} 件の個別明細は要約しています。`, 'change-history-omitted-note')
        );
    }

    return container;
}

function renderList() {
    if (!overlay || !tbodyEl || !metaSummaryEl) return;
    syncFilterControls();

    if (errorText) {
        statusMessageEl.textContent = errorText;
        statusMessageEl.className = 'change-history-status is-error';
        statusMessageEl.hidden = false;
        tableWrapEl.hidden = true;
        metaSummaryEl.textContent = `表示期間: 直近${days}日（最大保持90日）`;
        paginationWrapEl.hidden = true;
        tbodyEl.replaceChildren();
        return;
    }

    if (loading && items.length === 0) {
        statusMessageEl.textContent = '変更履歴を読み込み中です...';
        statusMessageEl.className = 'change-history-status';
        statusMessageEl.hidden = false;
        tableWrapEl.hidden = true;
        metaSummaryEl.textContent = `表示期間: 直近${days}日（最大保持90日）`;
        paginationWrapEl.hidden = true;
        tbodyEl.replaceChildren();
        return;
    }

    const startIdx = total === 0 ? 0 : (page - 1) * PER_PAGE + 1;
    const endIdx = total === 0 ? 0 : Math.min(total, startIdx + items.length - 1);
    metaSummaryEl.textContent = total === 0
        ? `該当する変更履歴: 0件（直近${days}日・最大保持90日）`
        : `全 ${total.toLocaleString()} 件中 ${startIdx.toLocaleString()}〜${endIdx.toLocaleString()} 件を表示（直近${days}日・最大保持90日）`;

    paginationWrapEl.hidden = totalPages <= 1;
    if (totalPages > 1) {
        pageIndicatorEl.textContent = `${page} / ${totalPages} ページ`;
        prevPageBtn.disabled = loading || page <= 1;
        nextPageBtn.disabled = loading || page >= totalPages;
    }

    if (items.length === 0) {
        statusMessageEl.textContent = hasNonDefaultFilter()
            ? '指定した条件に一致する変更履歴はありません。期間を広げるか、「条件を解除」をお試しください。'
            : `直近${days}日間の変更履歴はありません。`;
        statusMessageEl.className = 'change-history-status';
        statusMessageEl.hidden = false;
        tableWrapEl.hidden = true;
        tbodyEl.replaceChildren();
        return;
    }

    statusMessageEl.hidden = true;
    tableWrapEl.hidden = false;
    tbodyEl.replaceChildren();

    items.forEach(row => {
        const rowId = Number(row.id);
        const isExpanded = expandedIds.has(rowId);
        const detailPanelId = `change-history-detail-${rowId}`;

        const tr = node('tr', null, `change-history-row${isExpanded ? ' is-expanded' : ''}`);
        tr.dataset.historyId = String(rowId);

        const expandTd = node('td', null, 'col-expand');
        const expandBtn = node('button', isExpanded ? '▾' : '▸', 'change-history-expand-btn');
        expandBtn.type = 'button';
        expandBtn.setAttribute('aria-expanded', String(isExpanded));
        expandBtn.setAttribute('aria-controls', detailPanelId);
        expandBtn.setAttribute('aria-label', isExpanded ? '差分を折りたたむ' : '差分を展開');
        expandTd.appendChild(expandBtn);

        const timeTd = node('td', null, 'col-time');
        const timeEl = node('time', formatStatusTime(row.occurred_at));
        if (row.occurred_at) {
            timeEl.setAttribute('datetime', row.occurred_at);
        }
        timeTd.appendChild(timeEl);

        const actorTd = node('td', row.actor_name || '—', 'col-actor');

        const typeTd = node('td', null, 'col-type');
        typeTd.appendChild(
            node('span', formatTargetTypeBadge(row), `change-history-type-badge is-${row.target_type}`)
        );

        const targetTd = node('td', null, 'col-target');
        const targetMain = node('div', null, 'change-history-target-cell');
        const targetLink = node('button', row.target_name, 'change-history-target-name');
        targetLink.type = 'button';
        targetLink.title = 'この対象の変更履歴だけを表示します';
        targetLink.addEventListener('click', event => {
            event.stopPropagation();
            return focusFilterOnTarget(row.target_type, row.target_id, row.target_name);
        });
        targetMain.appendChild(targetLink);
        targetMain.appendChild(node('span', `(ID: ${row.target_id})`, 'change-history-id-meta'));
        if (row.target_exists === false) {
            targetMain.appendChild(node('span', '削除済み', 'change-history-deleted-badge'));
        }
        targetTd.appendChild(targetMain);

        const opMeta = OPERATION_META[row.operation] || { label: row.operation, className: 'is-update' };
        const opTd = node('td', null, 'col-operation');
        opTd.appendChild(node('span', opMeta.label, `change-history-op-badge ${opMeta.className}`));

        const summaryTd = node('td', null, 'col-summary');
        const summaryWrap = node('div', null, 'change-history-summary-wrap');
        summaryWrap.appendChild(node('span', row.summary, 'change-history-summary-text'));
        const relatedCount = (Array.isArray(row.related_targets) ? row.related_targets.length : 0) +
            Number(row.related_omitted_count || 0);
        if (relatedCount > 0) {
            summaryWrap.appendChild(node('span', `関連${relatedCount}件`, 'change-history-related-badge'));
        }
        summaryTd.appendChild(summaryWrap);

        tr.append(expandTd, timeTd, actorTd, typeTd, targetTd, opTd, summaryTd);

        const detailTr = node('tr', null, 'change-history-detail-row');
        detailTr.id = detailPanelId;
        detailTr.hidden = !isExpanded;
        const detailTd = node('td');
        detailTd.colSpan = 7;
        detailTd.appendChild(renderDetailContent(row));
        detailTr.appendChild(detailTd);

        expandBtn.addEventListener('click', event => {
            event.stopPropagation();
            toggleRowExpanded(rowId, detailTr, expandBtn, tr);
        });
        tr.addEventListener('click', event => {
            if (event.target?.closest?.('button, a, input, select')) return;
            toggleRowExpanded(rowId, detailTr, expandBtn, tr);
        });

        tbodyEl.append(tr, detailTr);
    });
}

async function fetchHistory() {
    if (!isCurrentUserAdmin() || appState.authExpired) {
        return;
    }
    if (!validateQueryLength()) {
        return;
    }
    const seq = ++requestSeq;
    loading = true;
    errorText = '';
    renderList();

    const params = new URLSearchParams();
    params.set('days', String(days));
    params.set('page', String(page));
    params.set('per_page', String(PER_PAGE));
    if (targetType !== '') {
        params.set('target_type', targetType);
    }
    if (targetId !== null && targetType !== '') {
        params.set('target_id', String(targetId));
    }
    const trimmedQuery = query.trim();
    if (trimmedQuery !== '') {
        params.set('q', trimmedQuery);
    }
    if (actor !== '') {
        params.set('actor', actor);
    }

    try {
        const data = await apiFetch('load_change_history', { query: params });
        if (seq !== requestSeq) return;
        items = Array.isArray(data.items) ? data.items : [];
        total = Number.isInteger(Number(data.total)) ? Number(data.total) : 0;
        page = Number.isInteger(Number(data.page)) ? Number(data.page) : 1;
        totalPages = Number.isInteger(Number(data.total_pages)) ? Math.max(1, Number(data.total_pages)) : 1;
        actors = Array.isArray(data.actors) ? data.actors.map(String) : [];
        focusedTarget = data.focused_target && typeof data.focused_target === 'object' ? data.focused_target : null;
        loading = false;
        renderList();
    } catch (err) {
        if (seq !== requestSeq) return;
        loading = false;
        errorText = err?.message || '変更履歴の取得に失敗しました。';
        renderList();
    }
}

function restoreSuspendedOverlays() {
    suspendedOverlays.forEach(el => {
        if (el && el.isConnected) {
            el.hidden = false;
        }
    });
    suspendedOverlays = [];
}

export function closeChangeHistory() {
    if (!overlay || overlay.hidden) return true;
    clearTimeout(searchDebounceTimer);
    requestSeq++;
    loading = false;
    restoreSuspendedOverlays();
    overlay.hidden = true;
    registerModalClose('change-history');
    return true;
}

/**
 * 共通変更履歴モーダルを開く。
 *
 * @param {{targetType?: 'device'|'view', targetId?: number, targetName?: string}} options
 */
export async function openChangeHistory(options = {}) {
    if (!requireAdminUiAction()) {
        return false;
    }
    ensureDom();

    const alreadyOpen = !overlay.hidden;
    if (!alreadyOpen && document.activeElement?.closest?.('#toolbar-manage-menu')) {
        document.querySelector('#toolbar-manage-menu > summary')?.focus?.();
        closeToolbarMenu();
    }

    clearTimeout(searchDebounceTimer);
    days = DEFAULT_DAYS;
    if ((options.targetType === 'device' || options.targetType === 'view') &&
        Number.isSafeInteger(Number(options.targetId)) && Number(options.targetId) > 0) {
        targetType = options.targetType;
        targetId = Number(options.targetId);
        targetNameHint = options.targetName ? String(options.targetName) : '';
    } else {
        targetType = '';
        targetId = null;
        targetNameHint = '';
    }
    focusedTarget = null;
    query = '';
    actor = '';
    page = 1;
    total = 0;
    totalPages = 1;
    items = [];
    expandedIds.clear();
    errorText = '';
    setFilterError('');

    const visibleParents = alreadyOpen
        ? []
        : SUSPENDABLE_MODAL_IDS
            .map(id => document.getElementById(id))
            .filter(el => el && !el.hidden);

    overlay.hidden = false;
    if (!alreadyOpen) {
        registerModalOpen('change-history', overlay, '#change-history-search', { onClose: closeChangeHistory });
        suspendedOverlays = visibleParents;
        suspendedOverlays.forEach(el => {
            el.hidden = true;
        });
    }

    await fetchHistory();
    return true;
}

eventBus.on('resources:reloaded', () => {
    if (overlay && !overlay.hidden) {
        closeChangeHistory();
    }
});
