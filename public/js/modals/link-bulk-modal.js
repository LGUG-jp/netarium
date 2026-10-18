import { appState } from '../core/state.js';
import { eventBus } from '../core/event-bus.js';
import { BULK_LINK_FIELDS, startLinkBulkEdit, prepareLinkBulkEdit, applyLinkBulkEdit, remapLinkBulkSession } from '../core/link-bulk-data.js';
import { populateLinkSystemPicker, closeLinkSystemPicker } from '../ui/link-system-picker.js';
import { registerModalOpen, registerModalClose } from '../core/modal-focus.js';
import { scheduleSave } from '../core/save-queue.js';
import { closePanel, closeLinkPanel } from '../ui/property-panel.js';
import { markDirty } from '../ui/status-bar.js';
import { render } from '../canvas/renderer.js';
import { updateFormLengthFeedback, updateLengthFeedback } from '../ui/length-feedback.js';

let session = null;
let getSelectedIds = null;
let applying = false;
let opening = false;
let initialValues = new Map();
let previewUpdates = null;

function reportError(message = '') {
    const error = document.getElementById('link-bulk-error');
    if (error) error.textContent = message;
}

export async function openLinkBulkModal(selectedIds, options = {}) {
    const overlay = document.getElementById('link-bulk-overlay');
    if (!overlay || opening || session) return false;
    opening = true;
    try {
        // 閉じる処理にある既存の「適用・破棄・取消」確認を使い、未適用入力を黙って捨てない。
        const initial = startLinkBulkEdit(selectedIds);
        if (!await closePanel() || !await closeLinkPanel()) return false;
        getSelectedIds = options.getSelectedIds || (() => initial.ids);
        // 非同期の確認中にビュー・選択・権限が変わっていないか再確認する。
        const current = startLinkBulkEdit(getSelectedIds());
        if (current.viewId !== initial.viewId || current.ids.length !== initial.ids.length ||
            initial.ids.some(id => !current.ids.includes(id))) throw new Error('ビューまたは選択が変更されています。一括設定を開き直してください');
        session = current;
        for (const field of BULK_LINK_FIELDS) {
            const opt = document.getElementById(`link-bulk-use-${field.key}`);
            const input = document.getElementById(`link-bulk-${field.key}`);
            opt.checked = false;
            input.disabled = true;
            if (field.key === 'system_id') populateLinkSystemPicker(input, null, null, { emptyLabel: '未設定（割り当て解除）' });
            else input.value = '';
        }
        updateFormLengthFeedback(overlay);
        initialValues = new Map(BULK_LINK_FIELDS.map(field => [
            field.key, document.getElementById(`link-bulk-${field.key}`).value
        ]));
        document.getElementById('link-bulk-count').textContent = String(session.ids.length);
        previewUpdates = null;
        document.getElementById('link-bulk-form').hidden = false;
        document.getElementById('link-bulk-confirm').hidden = true;
        reportError();
        overlay.hidden = false;
        registerModalOpen('link-bulk', overlay, '#link-bulk-use-system_id', { onClose: closeLinkBulkModal });
        return true;
    } catch (error) {
        // 開く前のエラーも一覧内のライブ領域へ表示する。
        const status = document.getElementById('workspace-nav-selection-status');
        if (status) status.textContent = error.message;
        return false;
    } finally {
        opening = false;
    }
}

export function closeLinkBulkModal() {
    if (applying) return false;
    const hasDraft = session && BULK_LINK_FIELDS.some(field =>
        document.getElementById(`link-bulk-use-${field.key}`).checked ||
        document.getElementById(`link-bulk-${field.key}`).value !== initialValues.get(field.key));
    if (hasDraft && !window.confirm('未確定の一括設定を破棄して閉じますか？')) return false;
    return finishLinkBulkModal();
}

function finishLinkBulkModal() {
    closeLinkSystemPicker();
    for (const field of BULK_LINK_FIELDS) {
        const opt = document.getElementById(`link-bulk-use-${field.key}`);
        const input = document.getElementById(`link-bulk-${field.key}`);
        if (opt) opt.checked = false;
        if (input) {
            input.value = '';
            input.disabled = true;
        }
        if (input) updateLengthFeedback(input);
    }
    initialValues.clear();
    previewUpdates = null;
    const overlay = document.getElementById('link-bulk-overlay');
    if (overlay) overlay.hidden = true;
    session = null;
    getSelectedIds = null;
    registerModalClose('link-bulk');
    return true;
}

function readLinkBulkUpdates() {
    const updates = {};
    for (const field of BULK_LINK_FIELDS) {
        if (document.getElementById(`link-bulk-use-${field.key}`).checked) {
            updates[field.key] = document.getElementById(`link-bulk-${field.key}`).value;
        }
    }
    return updates;
}

function displayBulkValue(key, value) {
    if (value === '' || value == null) return key === 'system_id' ? '割り当て解除' : '空欄にする';
    if (key === 'system_id') {
        return appState.linkSystems?.find(system => Number(system.id) === Number(value))?.name || '不明な系統';
    }
    return String(value);
}

export function previewLinkBulkModal() {
    if (!session || applying) return false;
    let firstInvalid = null;
    for (const field of BULK_LINK_FIELDS) {
        const input = document.getElementById(`link-bulk-${field.key}`);
        if (!updateLengthFeedback(input) && !firstInvalid) firstInvalid = input;
    }
    if (firstInvalid) {
        firstInvalid.focus();
        return false;
    }
    try {
        const plan = prepareLinkBulkEdit(session, readLinkBulkUpdates(), getSelectedIds());
        const preview = document.getElementById('link-bulk-preview');
        preview.replaceChildren();
        for (const field of BULK_LINK_FIELDS) {
            if (!Object.hasOwn(plan.values, field.key)) continue;
            const row = document.createElement('div');
            row.className = 'ledger-bulk-edit-change';
            const label = document.createElement('strong');
            label.className = 'ledger-bulk-edit-change-label';
            label.textContent = field.label;
            const before = document.createElement('span');
            before.className = 'ledger-bulk-edit-before';
            const values = new Set(plan.links.map(link => displayBulkValue(field.key, link[field.key])));
            before.textContent = `変更前: ${values.size === 1 ? [...values][0] : '複数の値'}`;
            const arrow = document.createElement('span');
            arrow.className = 'ledger-bulk-edit-arrow';
            arrow.textContent = '→';
            arrow.setAttribute('aria-hidden', 'true');
            const after = document.createElement('strong');
            const value = plan.values[field.key];
            after.className = value === '' || value == null
                ? 'ledger-bulk-edit-after ledger-bulk-edit-clearing' : 'ledger-bulk-edit-after';
            after.textContent = `変更後: ${displayBulkValue(field.key, value)}`;
            row.append(label, before, arrow, after);
            preview.appendChild(row);
        }
        previewUpdates = plan.values;
        closeLinkSystemPicker();
        reportError();
        document.getElementById('link-bulk-form').hidden = true;
        document.getElementById('link-bulk-confirm').hidden = false;
        const button = document.getElementById('link-bulk-apply');
        button.textContent = `${session.ids.length}件に適用`;
        button.focus();
        return true;
    } catch (error) {
        reportError(error.message);
        document.getElementById('link-bulk-error').focus();
        return false;
    }
}

function backLinkBulkModal() {
    if (!session || applying) return;
    previewUpdates = null;
    reportError();
    document.getElementById('link-bulk-confirm').hidden = true;
    document.getElementById('link-bulk-form').hidden = false;
    document.getElementById('link-bulk-next').focus();
}

export async function applyLinkBulkModal() {
    if (!session || !previewUpdates || applying) return false;
    applying = true;
    const button = document.getElementById('link-bulk-apply');
    if (button) button.disabled = true;
    try {
        const updates = previewUpdates;
        prepareLinkBulkEdit(session, updates, getSelectedIds());
        if (!await closePanel() || !await closeLinkPanel()) return false;
        // 確認後も、現在ビュー・全対象・権限・競合・属性・選択を再検証する。
        const changed = applyLinkBulkEdit(session, updates, getSelectedIds());
        if (changed) {
            markDirty();
            scheduleSave({ immediate: true, silent: true });
        }
        finishLinkBulkModal();
        render();
        return true;
    } catch (error) {
        reportError(error.message);
        return false;
    } finally {
        applying = false;
        if (button) button.disabled = false;
    }
}

export function initializeLinkBulkModal() {
    const overlay = document.getElementById('link-bulk-overlay');
    if (!overlay) return;
    for (const field of BULK_LINK_FIELDS) {
        const opt = document.getElementById(`link-bulk-use-${field.key}`);
        const input = document.getElementById(`link-bulk-${field.key}`);
        opt.addEventListener('change', () => {
            input.disabled = !opt.checked;
            updateLengthFeedback(input);
            if (field.key === 'system_id' && input.disabled) closeLinkSystemPicker();
        });
    }
    overlay.querySelectorAll('[data-link-bulk-close]').forEach(button => button.addEventListener('click', closeLinkBulkModal));
    document.getElementById('link-bulk-next').addEventListener('click', previewLinkBulkModal);
    document.getElementById('link-bulk-back').addEventListener('click', backLinkBulkModal);
    document.getElementById('link-bulk-apply').addEventListener('click', applyLinkBulkModal);
    eventBus.on('resources:ids-remapped', maps => {
        if (session) remapLinkBulkSession(session, maps);
    });
    const invalidate = () => {
        if (session) {
            session.invalidated = true;
            reportError('データが再読み込みされています。一括設定を開き直してください');
        }
    };
    eventBus.on('resources:reloaded', invalidate);
    eventBus.on('resource:reloaded', ({ kind, id }) => {
        if (session && kind === 'views' && Number(id) === session.viewId) invalidate();
    });
    eventBus.on('link-systems:changed', () => {
        if (!session) return;
        const input = document.getElementById('link-bulk-system_id');
        const value = input.value;
        populateLinkSystemPicker(input, value, null, { emptyLabel: '未設定（割り当て解除）' });
        // 消えた選択を未設定へ黙って置換しない。
        if (document.getElementById('link-bulk-use-system_id').checked && value &&
            !appState.linkSystems?.some(system => Number(system.id) === Number(value))) {
            reportError('選択した接続系統が削除されています。系統を選び直すか、変更対象から外してください');
        }
    });
}
