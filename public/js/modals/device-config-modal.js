/**
 * Netarium - modals/device-config-modal.js
 *
 * 機器Config手動保管・履歴確認・差分比較・選択削除モーダル。
 * 添付UIモック基準（5画面構成: 未登録・登録/編集・閲覧・削除モード・差分比較）
 */

import { appState } from '../core/state.js';
import { apiFetch } from '../core/api-client.js';
import { eventBus } from '../core/event-bus.js';
import { registerModalOpen, registerModalClose } from '../core/modal-focus.js';
import { chooseUnsavedChanges } from '../core/unsaved-changes-dialog.js';
import { formatStatusTime } from '../core/utils.js';
import { requireAdminUiAction } from '../ui/access-control.js';
import { showToast } from '../ui/toast.js';
import { CONFIG_MAX_BYTES, normalizeConfigText, validateConfigText, compareConfigLines } from '../core/device-config.js';
let suspended = [], confirmation = null;
let searchState = { versionId: null, query: '', matches: [], currentIndex: -1 };

let overlay, dialog, header, toolbar, deleteBanner, notice, body, closeButton;
let device = null, items = [], revision = 0, deviceRevision = 0;
let selectedId = null, sourceId = null, mode = 'view', draft = null;
let selected = new Set(), busy = false, loaded = false, conflict = false, sequence = 0;

function node(tag, text = null, className = '') {
    const el = document.createElement(tag);
    if (text !== null && text !== undefined) el.textContent = String(text);
    if (className) el.className = className;
    return el;
}

function svgIcon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');

    if (name === 'trash') {
        svg.innerHTML = '<polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>';
    } else if (name === 'plus') {
        svg.innerHTML = '<line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line>';
    } else if (name === 'save') {
        svg.innerHTML = '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline>';
    } else if (name === 'doc') {
        svg.setAttribute('width', '40');
        svg.setAttribute('height', '40');
        svg.innerHTML = '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline>';
    } else if (name === 'doc-large') {
        svg.setAttribute('width', '64');
        svg.setAttribute('height', '64');
        svg.innerHTML = '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line>';
    }
    return svg;
}

function button(text, action, parent, kind = 'secondary', id = '') {
    const el = node('button', text, `btn btn-${kind} btn-sm`);
    el.type = 'button';
    el.disabled = busy || appState.authExpired;
    if (id) el.id = id;
    el.addEventListener('click', action);
    if (parent) parent.appendChild(el);
    return el;
}

function message(text) {
    if (!notice) return;
    notice.textContent = text;
    notice.hidden = !text;
}

function errorMessage(error) {
    conflict = error.status === 409;
    message(conflict
        ? '機器またはConfig履歴が変更されています。入力を保持しています。「再読込」で状態を確認してください。'
        : error.status === 401
            ? 'ログインの有効期限が切れました。入力を保持しています。'
            : '操作に失敗しました。入力・履歴を保持しています。状態を確認してから再試行してください。');
}

function focusBody() {
    (body.querySelector('textarea, button, select, input') || closeButton).focus();
}

function ensureDom() {
    if (overlay?.ownerDocument === document) return;

    overlay = node('div', null, 'device-config-overlay');
    overlay.id = 'device-config-overlay';
    overlay.hidden = true;

    dialog = node('section', null, 'device-config-dialog');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'device-config-title');

    // 1. モーダルヘッダー
    header = node('header', null, 'device-config-header');
    const headerLeft = node('div', null, 'modal-header-heading');
    const title = node('h2', 'Config管理');
    title.id = 'device-config-title';

    const targetLabel = node('span', null, 'modal-header-target');
    targetLabel.id = 'device-config-target-label';
    targetLabel.append(document.createTextNode('対象機器：'));
    const targetName = node('strong', '', 'device-config-target-name');
    targetName.id = 'device-config-name';
    targetLabel.appendChild(targetName);

    headerLeft.append(title, targetLabel);

    closeButton = button('×', () => closeDeviceConfig(), null, 'secondary', 'close-device-config-btn');
    closeButton.className = 'modal-close-btn';
    closeButton.setAttribute('aria-label', '個票へ戻る');

    header.append(headerLeft, closeButton);

    // 通知バー
    notice = node('p', '', 'device-config-notice');
    notice.hidden = true;
    notice.setAttribute('role', 'status');
    notice.setAttribute('aria-live', 'polite');

    // 2. 上部操作バー（全画面共通、削除モード時も行を増やさずここで切替）
    toolbar = node('div', null, 'device-config-toolbar');
    toolbar.id = 'device-config-toolbar';

    // 3. コンテンツエリア
    body = node('div', null, 'device-config-body');

    dialog.append(header, notice, toolbar, body);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
}

function adopt(data) {
    items = data.items || [];
    revision = data.revision;
    deviceRevision = data.device_revision;
    if (Number.isSafeInteger(data.data_revision)) {
        appState.dataRevision = Math.max(appState.dataRevision, data.data_revision);
    }
    selectedId = items[0]?.id ?? null;
    sourceId = items[1]?.id ?? null;
    selected.clear();
    loaded = true;
    conflict = false;
}

async function load({ retainDraft = false } = {}) {
    if (busy || appState.authExpired) return;
    busy = true;
    render();
    const seq = ++sequence;
    try {
        const data = await apiFetch('load_device_configs', { query: new URLSearchParams({ device_id: device.id }) });
        if (seq !== sequence) return;
        adopt(data);
        if (!retainDraft) {
            mode = 'view';
            draft = null;
        }
        message(retainDraft ? '履歴を再読込しました。保持した入力を確認して保存してください。' : '');
    } catch (error) {
        if (seq !== sequence) return;
        errorMessage(error);
    } finally {
        if (seq === sequence) {
            busy = false;
            render();
        }
    }
}

function historyLabel(item) {
    return `${formatStatusTime(item.created_at)} · ${item.actor_name}${item.memo ? ` · ${item.memo}` : ''}`;
}

function render() {
    if (!overlay || overlay.hidden) return;
    closeButton.disabled = busy;
    toolbar.replaceChildren();
    body.replaceChildren();
    dialog.setAttribute('aria-busy', String(busy));

    if (!loaded) {
        body.appendChild(node('p', busy ? 'Configを読み込んでいます…' : 'Configを取得できませんでした。', 'device-config-empty-state-desc'));
        button('再読込', () => load(), toolbar);
        return;
    }

    if (conflict) {
        button('再読込', () => load({ retainDraft: mode === 'edit' }), toolbar, 'secondary', 'device-config-reload');
    }

    // 操作バー（Toolbar）のレンダリング
    renderToolbar();

    if (mode === 'diff') {
        renderDiff();
    } else {
        renderTwoColumnLayout();
    }
}

/**
 * 上部操作バー（全画面共通）のレンダリング
 */
function renderToolbar() {
    // 削除モードバー（画面④）
    // タブ（左側、全画面で同じ位置・高さを維持）
    const tabs = node('div', null, 'device-config-tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', '表示モード');

    const viewTab = node('button', 'Config本文', 'device-config-tab-btn');
    viewTab.type = 'button';
    viewTab.id = 'device-config-tab-view';
    viewTab.setAttribute('role', 'tab');
    viewTab.setAttribute('aria-selected', String(mode !== 'diff'));
    viewTab.setAttribute('aria-pressed', String(mode !== 'diff'));
    viewTab.disabled = busy || mode === 'edit' || mode === 'delete';
    viewTab.addEventListener('click', () => {
        mode = 'view';
        render();
        focusBody();
    });

    const diffTab = node('button', '差分比較', 'device-config-tab-btn');
    diffTab.type = 'button';
    diffTab.id = 'device-config-compare';
    diffTab.setAttribute('role', 'tab');
    diffTab.setAttribute('aria-selected', String(mode === 'diff'));
    diffTab.setAttribute('aria-pressed', String(mode === 'diff'));
    diffTab.disabled = busy || items.length < 2 || mode === 'edit' || mode === 'delete';
    if (items.length < 2) {
        diffTab.title = '比較には2版以上の登録が必要です';
    }
    diffTab.addEventListener('click', () => {
        mode = 'diff';
        render();
        focusBody();
    });

    tabs.append(viewTab, diffTab);
    toolbar.appendChild(tabs);

    // アクションボタン（右側、削除モード時も行を増やさずここで切替）
    const actions = node('div', null, 'device-config-toolbar-actions');

    if (mode === 'delete') {
        // 削除モード時：ツールバー内に赤系の削除コントロールを表示
        deleteBanner = node('div', null, 'device-config-delete-controls');
        deleteBanner.id = 'device-config-delete-banner';

        deleteBanner.appendChild(node('span', '🗑️', 'device-config-delete-banner-icon'));
        deleteBanner.appendChild(node('span', '削除する履歴を選択してください。', 'device-config-delete-msg'));

        const badge = node('span', `${selected.size}件選択中`, 'device-config-selection-badge');
        badge.id = 'device-config-selection-count';
        deleteBanner.appendChild(badge);

        const deleteActions = node('div', null, 'device-config-delete-banner-actions');
        button('キャンセル', () => {
            mode = 'view';
            selected.clear();
            render();
            focusBody();
        }, deleteActions, 'secondary', 'device-config-delete-cancel');

        const deleteSelectedBtn = button(
            `選択した${selected.size}件を削除`,
            () => confirmDelete(),
            deleteActions,
            'danger',
            'device-config-delete-selected'
        );
        deleteSelectedBtn.disabled = busy || selected.size === 0 || conflict;

        deleteBanner.appendChild(deleteActions);
        actions.appendChild(deleteBanner);
    } else if (mode === 'edit') {
        button('キャンセル', () => leaveEditor(), actions, 'secondary');
        const saveBtn = button('保存', () => saveDraft(), actions, 'primary', 'device-config-save');
        saveBtn.prepend(svgIcon('save'), document.createTextNode(' '));
        saveBtn.disabled = busy || conflict;
    } else {
        const deleteModeBtn = button('履歴を削除', () => {
            mode = 'delete';
            selected.clear();
            render();
            focusBody();
        }, actions, 'secondary', 'device-config-delete-mode');
        deleteModeBtn.prepend(svgIcon('trash'), document.createTextNode(' '));
        deleteModeBtn.disabled = busy || items.length === 0;

        const registerBtn = button('新しい版を登録', () => startEdit(), actions, 'primary', 'device-config-register');
        registerBtn.prepend(svgIcon('plus'), document.createTextNode(' '));
        registerBtn.disabled = busy || conflict;
    }

    toolbar.appendChild(actions);
}

/**
 * 2カラムレイアウト（左：履歴、右：メインコンテンツ）
 */
function renderTwoColumnLayout() {
    const layout = node('div', null, 'device-config-layout');

    // 左サイドバー：履歴エリア
    const sidebar = node('aside', null, 'device-config-sidebar');
    sidebar.setAttribute('aria-label', 'Config履歴');

    const sidebarHeader = node('div', null, 'device-config-sidebar-header');
    const sidebarTitle = node('span', `履歴 (${items.length}件)`, 'device-config-sidebar-title');
    sidebarHeader.appendChild(sidebarTitle);

    if (mode === 'delete') {
        const deleteControls = node('div', null, 'device-config-sidebar-delete-controls');
        const toggleAll = node(
            'button',
            selected.size === items.length && items.length > 0 ? '選択解除' : 'すべて選択',
            'device-config-select-toggle-btn'
        );
        toggleAll.type = 'button';
        toggleAll.id = 'device-config-select-all';
        toggleAll.disabled = busy || items.length === 0;
        toggleAll.addEventListener('click', () => {
            selected = selected.size === items.length ? new Set() : new Set(items.map(i => i.id));
            render();
        });
        deleteControls.appendChild(toggleAll);
        sidebarHeader.appendChild(deleteControls);
    }
    sidebar.appendChild(sidebarHeader);

    const historyScroll = node('div', null, 'device-config-history-scroll');

    if (items.length === 0) {
        // 履歴0件時の空表示（画面①・画面②で0件時）
        const emptyHistory = node('div', null, 'device-config-history-empty');
        const icon = svgIcon('doc');
        icon.classList.add('device-config-history-empty-icon');
        emptyHistory.appendChild(icon);
        emptyHistory.appendChild(node('p', '登録されたConfigはまだありません', 'device-config-history-empty-title'));
        emptyHistory.appendChild(node('p', mode === 'edit'
            ? '右側のフォームからConfigを登録してください。'
            : '右側の「新しい版を登録」からConfigを登録してください。', 'device-config-history-empty-desc'));
        historyScroll.appendChild(emptyHistory);
    } else {
        // 履歴リスト
        for (const item of items) {
            if (mode === 'delete') {
                // 削除モード：各行の最左端にチェックボックス（モック④準拠、「削除対象」文言なし）
                const row = node('label', null, `device-config-delete-row${selected.has(item.id) ? ' is-checked' : ''}`);

                const checkbox = node('input', null, 'device-config-card-checkbox');
                checkbox.type = 'checkbox';
                checkbox.checked = selected.has(item.id);
                checkbox.disabled = busy;
                checkbox.dataset.configId = String(item.id);
                checkbox.setAttribute('aria-label', `${historyLabel(item)}を削除対象に選択`);
                checkbox.addEventListener('change', () => {
                    if (checkbox.checked) selected.add(item.id);
                    else selected.delete(item.id);
                    render();
                    body.querySelector(`input[data-config-id="${item.id}"]`)?.focus();
                });
                const content = node('div', null, 'device-config-delete-row-content');
                content.appendChild(node('time', formatStatusTime(item.created_at), 'device-config-card-time'));
                content.appendChild(node('div', item.actor_name, 'device-config-card-actor'));
                if (item.memo) {
                    content.appendChild(node('div', item.memo, 'device-config-card-memo'));
                }

                row.append(checkbox, content);
                historyScroll.appendChild(row);
            } else {
                // 通常・閲覧・編集中：カードボタン
                const card = node('button', null, `device-config-card${selectedId === item.id ? ' is-selected' : ''}`);
                card.type = 'button';
                card.dataset.versionId = String(item.id);
                card.setAttribute('aria-pressed', String(selectedId === item.id));
                card.disabled = busy;

                card.appendChild(node('time', formatStatusTime(item.created_at), 'device-config-card-time'));
                card.appendChild(node('div', item.actor_name, 'device-config-card-actor'));
                if (item.memo) {
                    card.appendChild(node('div', item.memo, 'device-config-card-memo'));
                }

                card.addEventListener('click', () => {
                    selectedId = item.id;
                    render();
                    body.querySelector(`[data-version-id="${item.id}"]`)?.focus();
                });

                historyScroll.appendChild(card);
            }
        }
    }
    sidebar.appendChild(historyScroll);
    layout.appendChild(sidebar);

    // 右メインエリア
    const main = node('div', null, 'device-config-main');

    if (mode === 'edit') {
        main.appendChild(renderEditorContent());
    } else if (items.length === 0) {
        main.appendChild(renderEmptyContent());
    } else {
        main.appendChild(renderViewerContent());
    }

    layout.appendChild(main);
    body.appendChild(layout);
}

/**
 * 画面①：未登録状態のメインコンテンツ
 */
function renderEmptyContent() {
    const wrap = node('div', null, 'device-config-empty-state');
    const icon = svgIcon('doc-large');
    icon.classList.add('device-config-empty-state-icon');
    wrap.appendChild(icon);

    wrap.appendChild(node('h3', 'Configが登録されていません', 'device-config-empty-state-title'));
    wrap.appendChild(node('p', 'この機器の設定ファイルを登録して、履歴の管理を始めましょう。', 'device-config-empty-state-desc'));

    const registerBtn = button('新しい版を登録', () => startEdit(), wrap, 'primary', 'device-config-register');
    registerBtn.prepend(svgIcon('plus'), document.createTextNode(' '));
    registerBtn.disabled = busy || conflict;

    return wrap;
}

/**
 * 画面②：登録／編集フォームコンテンツ
 */
function renderEditorContent() {
    const form = node('div', null, 'device-config-form');

    // 警告注意枠
    const warning = node('div', null, 'device-config-warning-box');
    const warnIcon = node('span', '⚠️', 'device-config-warning-box-icon');
    const warnText = node('span', '登録前にパスワード・共有鍵・SNMP community等を削除またはマスキングしてください。実機への取得・適用は行いません。');
    warning.append(warnIcon, warnText);
    form.appendChild(warning);
    // 5世代上限到達時の最古削除注意表示
    const retentionWarning = node('div', null, 'device-config-retention-warning');
    retentionWarning.id = 'device-config-retention-warning';
    retentionWarning.hidden = true;

    const updateRetentionWarning = () => {
        if (items.length >= 5) {
            const latestContent = normalizeConfigText(items[0]?.content ?? '');
            const currentContent = normalizeConfigText(draft.content);
            const willAddGeneration = currentContent.trim() !== '' && currentContent !== latestContent;
            if (willAddGeneration) {
                const oldestItem = items[items.length - 1];
                const oldestDate = formatStatusTime(oldestItem.created_at);
                retentionWarning.textContent = `保存上限（5世代）に達しています。新しい版を保存すると、最も古い履歴（${oldestDate}）が自動的に削除されます。`;
                retentionWarning.hidden = false;
                return;
            }
        }
        retentionWarning.textContent = '';
        retentionWarning.hidden = true;
    };
    updateRetentionWarning();
    form.appendChild(retentionWarning);

    // ファイル選択セクション
    const fileGroup = node('div', null, 'device-config-form-group');
    const fileLabel = node('label', 'テキストファイルから読み込む（UTF-8）', 'device-config-form-label');
    fileLabel.htmlFor = 'device-config-file';

    const fileRow = node('div', null, 'device-config-file-row');
    const fileInput = node('input', null, 'device-config-file-input');
    fileInput.type = 'file';
    fileInput.id = 'device-config-file';
    fileInput.accept = '.txt,.cfg,.conf,text/plain';
    fileInput.disabled = busy;

    fileInput.addEventListener('change', async () => {
        const source = fileInput.files?.[0];
        if (!source || busy) return;
        const originalDraft = draft;
        const originalContent = draft.content;
        busy = true;
        render();
        try {
            if (source.size > CONFIG_MAX_BYTES * 2 + 3) {
                throw new Error('ファイルが大きすぎます（Config本文は256 KiBまで）');
            }
            const text = validateConfigText(new TextDecoder('utf-8', { fatal: true }).decode(await source.arrayBuffer()));
            if (draft.content !== originalContent) {
                throw new Error('読込中に本文が編集されました。もう一度ファイルを選択してください');
            }
            if (dirtyDraft() && !window.confirm('編集済みのConfig本文をファイルの内容で置き換えますか？')) {
                return;
            }
            draft.content = text;
            message('');
        } catch (error) {
            if (draft === originalDraft && !overlay.hidden) {
                message(error instanceof TypeError ? 'UTF-8のテキストファイルを指定してください' : error.message);
            }
        } finally {
            fileInput.value = '';
            busy = false;
            render();
            focusBody();
        }
    });

    fileRow.appendChild(fileInput);
    fileGroup.append(fileLabel, fileRow);
    form.appendChild(fileGroup);

    // Config本文入力セクション
    const textGroup = node('div', null, 'device-config-form-group is-flex');
    const textHeader = node('div', null, 'device-config-form-header');
    const textLabel = node('label', 'Config本文（必須）', 'device-config-form-label');
    textLabel.htmlFor = 'device-config-editor';

    const byteCounter = node('span', '', 'device-config-form-counter');
    byteCounter.id = 'device-config-byte-count';

    const updateByteCount = () => {
        const bytes = new TextEncoder().encode(normalizeConfigText(draft.content)).length;
        byteCounter.textContent = `${bytes.toLocaleString()} / ${CONFIG_MAX_BYTES.toLocaleString()} bytes（最大256 KiB）`;
    };
    updateByteCount();

    textHeader.append(textLabel, byteCounter);

    const editorWrap = node('div', null, 'device-config-editor-wrap');
    const editor = node('textarea', null, 'device-config-editor-textarea');
    editor.id = 'device-config-editor';
    editor.value = draft.content;
    editor.wrap = 'off';
    editor.spellcheck = false;
    editor.disabled = busy;

    editor.addEventListener('input', () => {
        draft.content = editor.value;
        updateByteCount();
        updateRetentionWarning();
    });

    editorWrap.appendChild(editor);
    textGroup.append(textHeader, editorWrap);
    form.appendChild(textGroup);

    // 変更メモセクション
    const memoGroup = node('div', null, 'device-config-form-group');
    const memoHeader = node('div', null, 'device-config-form-header');
    const memoLabel = node('label', '変更メモ（任意、200文字まで）', 'device-config-form-label');
    memoLabel.htmlFor = 'device-config-memo';

    const memoCounter = node('span', `${draft.memo.length}/200`, 'device-config-form-counter');
    memoCounter.id = 'device-config-memo-count';

    memoHeader.append(memoLabel, memoCounter);

    const memoInput = node('input', null, 'device-config-memo-input');
    memoInput.type = 'text';
    memoInput.id = 'device-config-memo';
    memoInput.maxLength = 200;
    memoInput.value = draft.memo;
    memoInput.placeholder = '変更内容のメモを入力してください（例：バージョンアップ、設定変更 など）';
    memoInput.disabled = busy;

    memoInput.addEventListener('input', () => {
        draft.memo = memoInput.value;
        memoCounter.textContent = `${draft.memo.length}/200`;
    });

    memoGroup.append(memoHeader, memoInput);
    form.appendChild(memoGroup);

    return form;
}

/**
 * 画面③・④：閲覧および削除時の本文表示コンテンツ
 */
function renderViewerContent() {
    const viewer = node('div', null, 'device-config-viewer');
    const item = items.find(row => row.id === selectedId) || items[0];

    // 検索・コピー用ツールバー
    const tools = node('div', null, 'device-config-viewer-tools');
    const searchBox = node('div', null, 'device-config-search-box');

    const searchInput = node('input', null, 'device-config-search-input input-sm');
    searchInput.type = 'search';
    searchInput.id = 'device-config-search';
    searchInput.placeholder = '本文を検索';
    searchInput.setAttribute('aria-label', '表示中のConfig本文を検索');
    const searchBtn = button('次を検索', () => doSearch(true), searchBox, 'secondary', 'device-config-search-btn');

    const searchStatus = node('span', '', 'device-config-search-status');
    searchStatus.id = 'device-config-search-status';
    searchStatus.setAttribute('aria-live', 'polite');

    searchBox.append(searchInput, searchBtn, searchStatus);

    const copyBtn = button('全文コピー', async () => {
        try {
            await navigator.clipboard.writeText(item ? item.content : '');
            showToast('表示中のConfig全文をコピーしました', 'success');
        } catch {
            message('コピーできませんでした。本文を選択して通常のコピー操作を使用してください。');
            const text = document.getElementById('device-config-text');
            if (text) {
                text.focus();
                text.select();
            }
        }
    }, tools, 'secondary', 'device-config-copy');

    const doSearch = (advance = true) => {
        const query = searchInput.value;
        const text = document.getElementById('device-config-text');
        if (!text) return;
        if (!query) {
            searchState = { versionId: selectedId, query: '', matches: [], currentIndex: -1 };
            searchStatus.textContent = '';
            return;
        }

        const rawContent = text.value || '';

        if (searchState.query !== query || searchState.versionId !== selectedId) {
            const matches = [];
            let pos = 0;
            while ((pos = rawContent.indexOf(query, pos)) !== -1) {
                matches.push(pos);
                pos += query.length;
            }
            searchState = {
                versionId: selectedId,
                query,
                matches,
                currentIndex: matches.length > 0 ? 0 : -1,
            };
        } else if (advance && searchState.matches.length > 0) {
            searchState.currentIndex = (searchState.currentIndex + 1) % searchState.matches.length;
        }

        const { matches, currentIndex } = searchState;
        if (matches.length === 0) {
            searchStatus.textContent = '0件';
            return;
        }

        searchStatus.textContent = `${currentIndex + 1} / ${matches.length}件`;

        const matchOffset = matches[currentIndex];
        text.focus();
        text.setSelectionRange(matchOffset, matchOffset + query.length);
        const lineCount = rawContent.slice(0, matchOffset).split('\n').length;
        text.scrollTop = Math.max(0, lineCount * 20 - text.clientHeight / 2);
    };

    searchInput.addEventListener('input', () => {
        searchState = { versionId: selectedId, query: '', matches: [], currentIndex: -1 };
        searchStatus.textContent = '';
    });
    searchInput.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
            event.preventDefault();
            doSearch(true);
        }
    });

    tools.append(searchBox, copyBtn);
    viewer.appendChild(tools);

    // 本文表示エリア
    const contentView = node('div', null, 'device-config-content-view');
    const textarea = node('textarea', null, 'device-config-content-textarea');
    textarea.id = 'device-config-text';
    textarea.value = item ? item.content : '';
    textarea.readOnly = true;
    textarea.wrap = 'off';
    textarea.spellcheck = false;
    textarea.setAttribute('aria-label', item ? `${historyLabel(item)}のConfig本文` : 'Config本文');
    textarea.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
            event.preventDefault();
            doSearch(true);
        }
    });

    contentView.appendChild(textarea);
    viewer.appendChild(contentView);

    return viewer;
}

/**
 * 画面⑤：差分比較（全幅表示）
 */
function renderDiff() {
    const pane = node('div', null, 'device-config-diff-pane');

    // 比較元セレクタとタイムスタンプ表示
    const headerBar = node('div', null, 'device-config-diff-header-bar');

    const selectorRow = node('div', null, 'device-config-diff-selector-row');
    const selectLabel = node('label', '比較元（過去の登録分）');
    selectLabel.htmlFor = 'device-config-diff-source-select';

    const select = node('select', null, 'device-config-diff-select');
    select.id = 'device-config-diff-source-select';
    select.setAttribute('aria-label', '比較元のConfig');
    select.disabled = busy;

    for (const item of items.slice(1)) {
        const option = node('option', historyLabel(item));
        option.value = String(item.id);
        select.appendChild(option);
    }

    if (!items.slice(1).some(item => item.id === sourceId)) {
        sourceId = items[1]?.id ?? null;
    }
    select.value = String(sourceId);

    select.addEventListener('change', () => {
        sourceId = Number(select.value);
        render();
        body.querySelector('select')?.focus();
    });

    selectorRow.append(selectLabel, select);
    headerBar.appendChild(selectorRow);

    const source = items.find(item => item.id === sourceId) || items[1];
    const target = items[0];

    if (source && target) {
        const timestamps = node('div', null, 'device-config-diff-timestamps');
        timestamps.append(
            node('span', `比較元：${formatStatusTime(source.created_at)}`, 'device-config-diff-timestamp'),
            node('span', `比較先：${formatStatusTime(target.created_at)}`, 'device-config-diff-timestamp')
        );
        headerBar.appendChild(timestamps);
    }

    // 既存ヘッダーの空き幅に配置し、結果表示で操作欄を作り直さない。
    const searchBox = node('div', null, 'device-config-search-box');
    const searchInput = node('input', null, 'device-config-search-input input-sm');
    searchInput.type = 'search';
    searchInput.id = 'device-config-diff-search';
    searchInput.placeholder = '本文を検索';
    searchInput.setAttribute('aria-label', '比較元・比較先のConfig本文を検索');
    const searchStatus = node('span', '', 'device-config-search-status');
    searchStatus.id = 'device-config-diff-search-status';
    searchStatus.setAttribute('role', 'status');
    const searchSide = node('span', '', 'device-config-diff-search-side');
    const nextSearch = button('次を検索', () => search(true), null, 'secondary', 'device-config-diff-search-next');
    searchBox.append(searchInput, nextSearch, searchStatus, searchSide);

    const navigation = node('div', null, 'device-config-diff-navigation');
    const previousDiff = button('前の差分', () => moveDiff(-1), navigation, 'secondary', 'device-config-diff-previous');
    const diffStatus = node('span', '0 / 0', 'device-config-search-status');
    diffStatus.id = 'device-config-diff-position';
    diffStatus.setAttribute('role', 'status');
    navigation.appendChild(diffStatus);
    const nextDiff = button('次の差分', () => moveDiff(1), navigation, 'secondary', 'device-config-diff-next');
    selectorRow.append(searchBox, navigation);

    const cells = [], blocks = [];
    let query = '', matches = [], matchIndex = -1, blockIndex = -1;
    let activeMark = null, activeCell = null;
    const clearMatch = () => {
        if (activeCell) activeCell.el.textContent = activeCell.text;
        activeMark = null;
        activeCell = null;
    };
    const resetSearch = () => {
        clearMatch();
        query = '';
        matches = [];
        matchIndex = -1;
        searchStatus.textContent = '';
        searchSide.textContent = '';
        searchStatus.setAttribute('aria-label', '');
    };
    const search = (advance) => {
        if (searchInput.disabled) return;
        const value = searchInput.value;
        if (!value) { resetSearch(); return; }
        if (value !== query) {
            resetSearch();
            query = value;
            for (const cell of cells) {
                let offset = 0;
                while ((offset = cell.text.indexOf(query, offset)) !== -1) {
                    matches.push({ cell, offset });
                    offset += query.length;
                }
            }
        } else if (!advance) return;
        clearMatch();
        if (!matches.length) {
            searchStatus.textContent = '0 / 0件';
            return;
        }
        matchIndex = (matchIndex + 1) % matches.length;
        const { cell, offset } = matches[matchIndex];
        activeCell = cell;
        activeMark = node('mark', cell.text.slice(offset, offset + query.length), 'device-config-diff-match');
        cell.el.textContent = '';
        cell.el.append(
            document.createTextNode(cell.text.slice(0, offset)),
            activeMark,
            document.createTextNode(cell.text.slice(offset + query.length))
        );
        searchStatus.textContent = `${matchIndex + 1} / ${matches.length}件`;
        searchStatus.setAttribute('aria-label', `${searchStatus.textContent}、${cell.side}`);
        searchSide.textContent = cell.side;
        activeMark.scrollIntoView({ block: 'center', inline: 'nearest' });
    };
    const moveDiff = direction => {
        if (!blocks.length || previousDiff.disabled) return;
        if (blockIndex >= 0) {
            for (const rowEl of blocks[blockIndex]) {
                rowEl.classList.remove('is-current-diff');
            }
        }
        blockIndex = blockIndex < 0
            ? (direction > 0 ? 0 : blocks.length - 1)
            : (blockIndex + direction + blocks.length) % blocks.length;
        const block = blocks[blockIndex];
        for (const rowEl of block) {
            rowEl.classList.add('is-current-diff');
        }
        diffStatus.textContent = `${blockIndex + 1} / ${blocks.length}`;
        block[0]?.scrollIntoView({ block: 'center', inline: 'nearest' });
    };
    searchInput.addEventListener('input', resetSearch);
    searchInput.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.isComposing) {
            event.preventDefault();
            search(true);
        }
    });
    const disableTools = () => {
        searchInput.disabled = true;
        nextSearch.disabled = true;
        previousDiff.disabled = true;
        nextDiff.disabled = true;
    };
    disableTools();
    pane.appendChild(headerBar);

    if (!source || !target) {
        pane.appendChild(node('p', '比較対象が不足しています。', 'device-config-diff-empty-msg'));
        body.appendChild(pane);
        return;
    }

    const result = compareConfigLines(source.content, target.content);
    if (!result) {
        pane.appendChild(node(
            'p',
            '比較できません（行数または計算量の上限を超えています）。「Config本文」で全文を確認してください。',
            'device-config-diff-empty-msg'
        ));
        body.appendChild(pane);
        return;
    }

    if (result.identical) {
        pane.appendChild(node('p', '差分はありません', 'device-config-diff-empty-msg'));
        body.appendChild(pane);
        return;
    }

    const diffContainer = node('div', null, 'device-config-diff device-config-diff-container');
    searchInput.disabled = nextSearch.disabled = busy || appState.authExpired;
    diffContainer.tabIndex = 0;
    diffContainer.setAttribute('aria-label', 'Configの行単位差分');

    let leftLine = 0;
    let rightLine = 0;
    let previousKind = 'equal';
    let currentBlock = null;
    for (const row of result.rows) {
        const rowEl = node('div', null, `device-config-diff-row is-${row.kind}`);
        const left = node('pre');
        const right = node('pre');
        for (const [text, el, side] of [[row.left, left, '比較元'], [row.right, right, '比較先']]) {
            if (text === null) continue;
            const line = side === '比較元' ? ++leftLine : ++rightLine;
            el.appendChild(document.createTextNode(`${row.kind === 'equal' ? ' ' : side === '比較元' ? '−' : '＋'} ${line}  `));
            const content = node('span', text);
            el.appendChild(content);
            el.setAttribute('aria-label', `${side} ${line}行目`);
            cells.push({ el: content, text, side });
        }
        if (row.kind !== 'equal') {
            if (row.left !== null) left.className = 'is-removed';
            if (row.right !== null) right.className = 'is-added';
            if (previousKind === 'equal') {
                rowEl.classList.add('is-diff-block-start');
                currentBlock = [rowEl];
                blocks.push(currentBlock);
            } else {
                currentBlock.push(rowEl);
            }
        } else if (currentBlock) {
            currentBlock[currentBlock.length - 1].classList.add('is-diff-block-end');
            currentBlock = null;
        }
        previousKind = row.kind;

        rowEl.append(left, right);
        diffContainer.appendChild(rowEl);
    }
    if (currentBlock) {
        currentBlock[currentBlock.length - 1].classList.add('is-diff-block-end');
    }

    previousDiff.disabled = nextDiff.disabled = busy || appState.authExpired || !blocks.length;
    diffStatus.textContent = `0 / ${blocks.length}`;
    pane.appendChild(diffContainer);
    body.appendChild(pane);
}

function startEdit() {
    mode = 'edit';
    draft = {
        content: items[0]?.content ?? '',
        memo: '',
        initial: items[0]?.content ?? '',
    };
    message('');
    render();
    focusBody();
}

function dirtyDraft() {
    return draft && (draft.content !== draft.initial || draft.memo !== '');
}

async function leaveEditor() {
    if (busy) return false;
    if (dirtyDraft()) {
        const choice = await chooseUnsavedChanges('Configに未保存の入力があります。どうしますか？');
        if (choice === 'save') return saveDraft();
        if (choice !== 'discard') return false;
    }
    draft = null;
    mode = 'view';
    message('');
    render();
    focusBody();
    return true;
}

async function saveDraft() {
    if (busy || conflict || appState.authExpired || !draft) return false;
    let content;
    try {
        content = validateConfigText(draft.content);
    } catch (error) {
        message(error.message);
        return false;
    }
    const isFiveGenerations = items.length >= 5;
    const latestContent = normalizeConfigText(items[0]?.content ?? '');
    const willPruneOldest = isFiveGenerations && normalizeConfigText(content) !== latestContent;

    busy = true;
    render();
    try {
        const data = await apiFetch('save_device_config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                device_id: device.id,
                expected_revision: revision,
                expected_device_revision: deviceRevision,
                content,
                memo: draft.memo,
            }),
        });
        adopt(data);
        draft = null;
        mode = 'view';
        message('');
        if (data.unchanged) {
            showToast('直近の登録分と本文が同じため、世代を追加しませんでした', 'success');
        } else if (willPruneOldest) {
            showToast('Configを登録しました。保存上限により最も古い履歴を1件削除しました', 'success');
        } else {
            showToast('Configを登録しました', 'success');
        }
        return true;
    } catch (error) {
        errorMessage(error);
        return false;
    } finally {
        busy = false;
        render();
        focusBody();
    }
}

function closeConfirmation() {
    if (!confirmation || busy) return false;
    confirmation.remove();
    confirmation = null;
    registerModalClose('device-config-delete');
    return true;
}

function confirmDelete() {
    if (busy || !selected.size || conflict || confirmation) return;
    const ids = [...selected];
    const expectedRevision = revision;
    const expectedDeviceRevision = deviceRevision;

    confirmation = node('div', null, 'device-config-overlay device-config-confirm-overlay');
    confirmation.id = 'device-config-confirm-overlay';

    const box = node('section', null, 'device-config-confirm-dialog');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', 'device-config-delete-title');

    const confirmHeader = node('header', null, 'device-config-confirm-header');
    const title = node('h2', '選択したConfig履歴を削除');
    title.id = 'device-config-delete-title';
    confirmHeader.appendChild(title);

    const closeBtn = button('×', () => closeConfirmation(), confirmHeader);
    closeBtn.className = 'modal-close-btn';
    closeBtn.setAttribute('aria-label', '削除をキャンセル');

    const confirmBody = node('div', null, 'device-config-confirm-body');
    const summary = node('p', `${device.name || `ID ${device.id}`}：${ids.length === items.length ? `全${items.length}件` : `${ids.length}件`}を削除します。`);

    const dates = node('ul', null, 'device-config-confirm-dates');
    items.filter(item => selected.has(item.id)).forEach(item => {
        dates.appendChild(node('li', formatStatusTime(item.created_at)));
    });

    const warning = node('p', '機器本体は削除しません。この操作は取り消せません。', 'device-config-confirm-warning');
    const errorEl = node('p', '', 'form-error');
    errorEl.setAttribute('role', 'alert');

    confirmBody.append(summary, dates, warning, errorEl);

    const confirmFooter = node('footer', null, 'device-config-confirm-footer');
    const cancelBtn = button('キャンセル', () => closeConfirmation(), confirmFooter);

    button('削除する', async () => {
        if (busy) return;
        busy = true;
        confirmation.querySelectorAll('button').forEach(el => { el.disabled = true; });
        try {
            const data = await apiFetch('delete_device_configs', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    device_id: device.id,
                    expected_revision: expectedRevision,
                    expected_device_revision: expectedDeviceRevision,
                    ids,
                }),
            });
            adopt(data);
            mode = 'view';
            busy = false;
            closeConfirmation();
            message('');
            await load();
            showToast(`${ids.length}件のConfig履歴を削除しました`, 'success');
        } catch (failure) {
            busy = false;
            errorMessage(failure);
            if (conflict) {
                closeConfirmation();
            } else if (confirmation) {
                errorEl.textContent = notice.textContent;
                confirmation.querySelectorAll('button').forEach(el => { el.disabled = appState.authExpired; });
            }
        } finally {
            busy = false;
            render();
        }
    }, confirmFooter, 'danger', 'device-config-delete-confirm');

    box.append(confirmHeader, confirmBody, confirmFooter);
    confirmation.appendChild(box);
    document.body.appendChild(confirmation);
    registerModalOpen('device-config-delete', confirmation, cancelBtn, { onClose: closeConfirmation });
}

export async function closeDeviceConfig() {
    if (!overlay || overlay.hidden) return true;
    if (busy || confirmation) return false;
    if (mode === 'edit' && !await leaveEditor()) return false;
    sequence++;
    overlay.hidden = true;
    suspended.forEach(el => {
        if (el && el.isConnected) el.hidden = false;
    });
    suspended = [];
    registerModalClose('device-config');
    items = [];
    draft = null;
    device = null;
    body.replaceChildren();
    return true;
}

export async function openDeviceConfig(target) {
    if (!requireAdminUiAction() || appState.authExpired || busy) return false;
    if (!Number.isSafeInteger(Number(target?.id)) || Number(target.id) <= 0 || Number(target.resource_revision) <= 0) return false;
    ensureDom();
    if (!overlay.hidden) return false;

    device = { id: Number(target.id), name: target.name || '' };
    deviceRevision = Number(target.resource_revision);
    items = [];
    revision = 0;
    selected.clear();
    loaded = false;
    conflict = false;
    mode = 'view';
    draft = null;
    body.hidden = false;

    document.getElementById('device-config-name').textContent = device.name || `ID ${device.id}`;
    message('');

    suspended = ['ledger-overlay', 'ledger-device-sheet-overlay']
        .map(id => document.getElementById(id))
        .filter(el => el && !el.hidden);

    overlay.hidden = false;
    registerModalOpen('device-config', overlay, closeButton, { onClose: closeDeviceConfig });
    suspended.forEach(el => { el.hidden = true; });

    await load();
    return true;
}

eventBus.on('auth:expired', () => {
    if (overlay && !overlay.hidden) {
        body.hidden = true;
        if (confirmation) {
            busy = false;
            closeConfirmation();
        }
        message('ログインの有効期限が切れました。画面を再読み込みしてください。');
    }
});
