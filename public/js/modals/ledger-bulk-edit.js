/**
 * 機器台帳の一括編集モーダル。選択集合・個票の閉鎖・台帳再描画は呼び出し側に委ねる。
 */
import { appState } from '../core/state.js';
import { BULK_DEVICE_FIELDS, startDeviceBulkEdit, summarizeBulkValues, prepareDeviceBulkEdit, applyDeviceBulkEdit } from '../core/device-bulk-edit.js';
import { requireAdminUiAction } from '../ui/access-control.js';
import { registerModalOpen, registerModalClose } from '../core/modal-focus.js';
import { showToast, showStatusMessage } from '../ui/toast.js';
import { markDirty } from '../ui/status-bar.js';
import { scheduleSave } from '../core/save-queue.js';
import { render } from '../canvas/renderer.js';

export function createLedgerBulkEdit({ selectedDeviceIds, closeDetailPane, renderTable }) {
    let bulkEditSession = null;
    let bulkEditUpdates = null;
    let bulkEditInitialValues = null;

    async function openLedgerBulkEdit() {
        if (!requireAdminUiAction() || appState.authExpired || appState.isPinging || bulkEditSession) return;
        try {
            const session = startDeviceBulkEdit([...selectedDeviceIds]);
            if (!await closeDetailPane()) return;
            bulkEditSession = session;
            bulkEditUpdates = null;
            const fields = document.getElementById('ledger-bulk-edit-fields');
            fields.replaceChildren();
            for (const field of BULK_DEVICE_FIELDS) {
                const row = document.createElement('div');
                row.className = 'ledger-bulk-edit-field';
                const label = document.createElement('label');
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.id = `ledger-bulk-change-${field.key}`;
                label.append(checkbox, document.createTextNode(` ${field.label}を変更する`));
                const current = document.createElement('p');
                current.textContent = `現在値: ${summarizeBulkValues(session, field.key)}`;
                const input = document.createElement(field.options ? 'select' : 'input');
                if (field.options) {
                    for (const choice of field.options) {
                        const option = document.createElement('option');
                        option.value = choice.value;
                        option.textContent = choice.label;
                        input.appendChild(option);
                    }
                } else {
                    input.type = field.type || 'text';
                    if (field.key === 'management_port') {
                        input.min = '1';
                        input.max = '65535';
                        input.step = '1';
                        input.placeholder = '1〜65535（空欄で未設定）';
                    }
                }
                input.id = `ledger-bulk-value-${field.key}`;
                input.setAttribute('aria-label', `${field.label}の変更後の値`);
                input.disabled = true;
                if (field.date) input.placeholder = 'YYYY-MM または YYYY-MM-DD';
                checkbox.addEventListener('change', () => {
                    input.disabled = !checkbox.checked;
                    const count = BULK_DEVICE_FIELDS.filter(item => document.getElementById(`ledger-bulk-change-${item.key}`).checked).length;
                    document.getElementById('ledger-bulk-edit-count').textContent = `変更対象: ${count}項目`;
                    document.getElementById('ledger-bulk-edit-next').disabled = count === 0;
                });
                row.append(label, current, input);
                fields.appendChild(row);
            }
            document.getElementById('ledger-bulk-edit-title').textContent = `${session.ids.length}台の機器を一括編集`;
            document.getElementById('ledger-bulk-edit-count').textContent = '変更対象: 0項目';
            document.getElementById('ledger-bulk-edit-next').disabled = true;
            backLedgerBulkEdit();
            bulkEditInitialValues = new Map(BULK_DEVICE_FIELDS.map(field =>
                [field.key, document.getElementById(`ledger-bulk-value-${field.key}`).value]));
            const overlay = document.getElementById('ledger-bulk-edit-overlay');
            overlay.hidden = false;
            registerModalOpen('ledger-bulk-edit', overlay, '#ledger-bulk-change-facility', { onClose: closeLedgerBulkEdit });
        } catch (error) {
            showToast(error.message, 'warning');
        }
    }

    function closeLedgerBulkEdit() {
        const changed = bulkEditSession && BULK_DEVICE_FIELDS.some(field =>
            document.getElementById(`ledger-bulk-change-${field.key}`).checked ||
            document.getElementById(`ledger-bulk-value-${field.key}`).value !== bulkEditInitialValues?.get(field.key));
        if (changed && !window.confirm('未適用の一括編集を破棄して閉じますか？')) return false;
        finishLedgerBulkEdit();
        return true;
    }

    function finishLedgerBulkEdit() {
        const overlay = document.getElementById('ledger-bulk-edit-overlay');
        if (overlay) overlay.hidden = true;
        bulkEditInitialValues = null;
        bulkEditSession = null;
        bulkEditUpdates = null;
        registerModalClose('ledger-bulk-edit');
    }

    function backLedgerBulkEdit() {
        document.getElementById('ledger-bulk-edit-form').hidden = false;
        document.getElementById('ledger-bulk-edit-confirm').hidden = true;
        document.getElementById('ledger-bulk-edit-error').textContent = '';
        bulkEditUpdates = null;
    }

    function showLedgerBulkEditError(error) {
        const message = document.getElementById('ledger-bulk-edit-error');
        message.textContent = error.message;
        message.focus({ preventScroll: true });
        document.getElementById('ledger-bulk-edit-body').scrollTop = 0;
    }

    function previewLedgerBulkEdit() {
        if (!bulkEditSession || !requireAdminUiAction() || appState.authExpired || appState.isPinging) return;
        try {
            const updates = {};
            for (const field of BULK_DEVICE_FIELDS) {
                if (document.getElementById(`ledger-bulk-change-${field.key}`).checked) {
                    updates[field.key] = document.getElementById(`ledger-bulk-value-${field.key}`).value;
                }
            }
            const plan = prepareDeviceBulkEdit(bulkEditSession, updates);
            const preview = document.getElementById('ledger-bulk-edit-preview');
            preview.replaceChildren();
            for (const field of BULK_DEVICE_FIELDS) {
                if (!Object.hasOwn(plan.updates, field.key)) continue;
                const row = document.createElement('div');
                row.className = 'ledger-bulk-edit-change';
                const label = document.createElement('strong');
                label.className = 'ledger-bulk-edit-change-label';
                label.textContent = field.label;
                const before = document.createElement('span');
                before.className = 'ledger-bulk-edit-before';
                const current = summarizeBulkValues(bulkEditSession, field.key);
                before.textContent = `変更前: ${field.options?.find(option => option.value === current)?.label || current}`;
                const arrow = document.createElement('span');
                arrow.className = 'ledger-bulk-edit-arrow';
                arrow.textContent = '→';
                arrow.setAttribute('aria-hidden', 'true');
                const after = document.createElement('strong');
                const value = plan.updates[field.key];
                const clearing = value === '' || value === null;
                after.className = clearing ? 'ledger-bulk-edit-after ledger-bulk-edit-clearing' : 'ledger-bulk-edit-after';
                after.textContent = `変更後: ${clearing ? '空欄にする' : field.options?.find(option => option.value === value)?.label || value}`;
                row.append(label, before, arrow, after);
                preview.appendChild(row);
            }
            document.getElementById('ledger-bulk-edit-warning').textContent = plan.placedCount
                ? `選択中のうち${plan.placedCount}台はビューに配置済みです。施設・フロアを変更しても配置先や座標は変更されません。` : '';
            document.getElementById('ledger-bulk-edit-apply').textContent = `${bulkEditSession.ids.length}台に適用`;
            document.getElementById('ledger-bulk-edit-error').textContent = '';
            document.getElementById('ledger-bulk-edit-form').hidden = true;
            document.getElementById('ledger-bulk-edit-confirm').hidden = false;
            bulkEditUpdates = plan.updates;
            document.getElementById('ledger-bulk-edit-apply').focus();
        } catch (error) {
            showLedgerBulkEditError(error);
        }
    }

    function confirmLedgerBulkEdit() {
        if (!bulkEditSession || !bulkEditUpdates || !requireAdminUiAction() || appState.authExpired || appState.isPinging) return;
        try {
            const count = bulkEditSession.ids.length;
            const changed = applyDeviceBulkEdit(bulkEditSession, bulkEditUpdates);
            finishLedgerBulkEdit();
            selectedDeviceIds.clear();
            renderTable();
            render();
            if (changed) {
                markDirty();
                scheduleSave({ immediate: true, silent: true });
            }
            showStatusMessage(`${count}台への一括適用を完了しました。選択を解除しました`);
        } catch (error) {
            showLedgerBulkEditError(error);
        }
    }

    function remapBulkEditSessionIds(mapped) {
        if (!bulkEditSession) return;
        bulkEditSession.ids = bulkEditSession.ids.map(mapped);
        bulkEditSession.bases.forEach(device => { device.id = mapped(device.id); });
    }

    return {
        openLedgerBulkEdit, closeLedgerBulkEdit, backLedgerBulkEdit,
        previewLedgerBulkEdit, confirmLedgerBulkEdit, remapBulkEditSessionIds
    };
}
