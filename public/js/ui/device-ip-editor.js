import { normalizeAdditionalIps, getDeviceIpRowErrors } from '../core/device-ip-addresses.js';
import { setInputError } from './field-errors.js';
import { createIpDuplicateNotice } from './ip-duplicate-notice.js';
import { appState } from '../core/state.js';
import { segmentCandidates } from '../core/ip-management.js';

let nextEditorId = 1;

/** 両編集面で同じ子レコード・並び順を保持する。更新先は常にdraft。 */
export function createDeviceIpEditor({ getDevice, canEdit, onChange, compact = false, expanded = false }) {
    const root = document.createElement('div');
    root.className = 'device-ip-editor';
    root.dataset.field = 'additional_ips';
    const rows = document.createElement('div');
    rows.className = 'device-ip-rows';
    const notice = document.createElement('div');
    notice.className = 'form-support';
    notice.setAttribute('role', 'alert');
    notice.hidden = true;
    const errorPrefix = `device-ip-error-${nextEditorId++}`;
    const touched = new Set();
    const rowElements = [];
    let renderedAddresses = '';
    const keyFor = address => address.id ?? address._client_key;
    const summary = document.createElement('div');
    summary.className = 'device-ip-summary';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'btn btn-tertiary btn-sm device-ip-toggle';
    const rowsId = `${errorPrefix}-rows`;
    rows.id = rowsId;
    toggle.setAttribute('aria-controls', rowsId);
    let add;
    root.setExpanded = value => {
        expanded = Boolean(value) && canEdit() && (!compact || Boolean(getDevice().additional_ips?.length));
        const restoreFocus = compact && !expanded && rows.contains(document.activeElement);
        root.dataset.expanded = String(expanded);
        rows.hidden = compact && !expanded;
        toggle.hidden = !canEdit() || !getDevice().additional_ips?.length;
        toggle.textContent = expanded ? '閉じる' : '編集';
        toggle.setAttribute('aria-expanded', String(!rows.hidden));
        if (add) add.hidden = compact && (!canEdit() || (!expanded && Boolean(getDevice().additional_ips?.length)));
        if (compact && add) {
            add.setAttribute('aria-controls', rowsId);
            add.setAttribute('aria-expanded', String(!rows.hidden));
        }
        if (restoreFocus) (toggle.hidden ? add : toggle)?.focus();
    };
    const refreshSummary = () => {
        if (!compact) return;
        summary.replaceChildren();
        const addresses = getDevice().additional_ips || [];
        for (const address of addresses) {
            const chip = document.createElement('span');
            chip.className = 'device-ip-chip';
            chip.textContent = [address.ip || '未入力', address.label].filter(Boolean).join(' · ');
            summary.appendChild(chip);
        }
        if (!addresses.length) summary.textContent = '追加IPなし';
        root.setExpanded(expanded);
    };
    toggle.addEventListener('click', () => {
        root.setExpanded(!expanded);
        if (expanded) rowElements[0]?.inputs.ip.focus();
        else (toggle.hidden ? add : toggle)?.focus();
    });
    root.validateIps = ({ reveal = false, device = getDevice() } = {}) => {
        const addresses = device.additional_ips || [];
        if (reveal) addresses.forEach(address => touched.add(keyFor(address)));
        const errors = getDeviceIpRowErrors(device);
        let first = null;
        rowElements.forEach(({ inputs, error }, index) => {
            setInputError(inputs.ip, error, '');
            setInputError(inputs.label, error, '');
            const address = addresses[index];
            const problem = errors[index];
            if (!problem || !address || (address.id == null && !address.ip && !address.label && !touched.has(keyFor(address)))) return;
            const input = inputs[problem.field];
            setInputError(input, error, problem.message);
            first ||= input;
        });
        if (compact && reveal && first) root.setExpanded(true);
        return first;
    };
    const update = addresses => {
        if (!canEdit()) return;
        getDevice().additional_ips = normalizeAdditionalIps(addresses);
        notice.hidden = true;
        refreshSummary();
        root.validateIps();
        onChange();
    };
    const changeRows = change => {
        if (!canEdit()) return false;
        const addresses = getDevice().additional_ips || [];
        if (JSON.stringify(addresses) !== renderedAddresses) {
            render();
            notice.textContent = '追加IPが別画面または保存応答で変更されました。最新の行を確認して再入力してください';
            notice.hidden = false;
            return false;
        }
        const next = normalizeAdditionalIps(addresses);
        change(next);
        update(next);
        renderedAddresses = JSON.stringify(getDevice().additional_ips || []);
        return true;
    };
    const render = () => {
        rows.replaceChildren();
        rowElements.length = 0;
        notice.hidden = true;
        const addresses = getDevice().additional_ips || [];
        addresses.forEach((address, index) => {
            const entry = document.createElement('div');
            entry.className = 'device-ip-entry';
            const row = document.createElement('div');
            row.className = 'device-ip-row';
            const error = document.createElement('div');
            error.id = `${errorPrefix}-${index}`;
            error.className = 'form-error';
            error.setAttribute('role', 'alert');
            const inputs = {};
            let duplicateNotice;
            for (const [field, label] of [['ip', 'IPv4アドレス'], ['label', '用途（任意）']]) {
                const input = document.createElement('input');
                input.type = 'text';
                input.value = address[field] || '';
                input.placeholder = label;
                input.setAttribute('aria-label', `追加IP ${index + 1} ${label}`);
                input.dataset.ipIndex = String(index);
                input.dataset.ipField = field;
                if (field === 'ip') input.maxLength = 15;
                input.readOnly = !canEdit();
                input.addEventListener('input', () => {
                    const changed = changeRows(next => {
                        touched.add(keyFor(next[index]));
                        if (field === 'ip' && next[index].ip !== input.value.trim()) {
                            const candidates = segmentCandidates(input.value.trim(), appState.ipSegments || []);
                            next[index].segment_id = candidates.length === 1 ? Number(candidates[0].id) : null;
                            delete getDevice().ip_conflicts_confirmed;
                        }
                        next[index][field] = input.value;
                    });
                    if (changed && field === 'ip') {
                        duplicateNotice.refresh();
                        renderedAddresses = JSON.stringify(getDevice().additional_ips || []);
                    }
                });
                inputs[field] = input;
                row.appendChild(input);
            }
            if (canEdit()) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'btn btn-tertiary btn-danger btn-sm device-ip-delete';
                button.title = '追加IPを削除';
                button.setAttribute('aria-label', `追加IP ${index + 1} 削除`);
                button.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>';
                button.addEventListener('click', () => {
                    if (!changeRows(next => next.splice(index, 1))) return;
                    render();
                    if (compact) {
                        root.setExpanded(expanded);
                        if (!expanded) add?.focus();
                        else (rowElements[Math.min(index, rowElements.length - 1)]?.inputs.ip)?.focus();
                    }
                });
                row.appendChild(button);
            }
            duplicateNotice = createIpDuplicateNotice({
                getRecord: () => {
                    const device = getDevice();
                    return { ...device.additional_ips[index], device_id: device.id };
                },
                canEdit,
                onChange
            });
            entry.append(row, error, duplicateNotice);
            rows.appendChild(entry);
            rowElements.push({ inputs, error });
        });
        if (!addresses.length) rows.textContent = '追加IPはありません';
        root.validateIps();
        renderedAddresses = JSON.stringify(getDevice().additional_ips || []);
        refreshSummary();
    };
    if (canEdit()) {
        add = document.createElement('button');
        add.type = 'button';
        add.className = 'btn btn-secondary btn-sm device-ip-add';
        add.textContent = 'IPアドレスを追加';
        add.addEventListener('click', () => {
            if (!changeRows(next => next.push({ id: null, ip: '', label: '' }))) return;
            render();
            if (compact) root.setExpanded(true);
            rowElements.at(-1)?.inputs.ip.focus();
        });
    }
    if (compact) {
        root.classList.add('device-ip-editor-compact');
        root.appendChild(summary);
        if (canEdit()) root.appendChild(toggle);
        root.setExpanded(expanded);
    }
    root.append(rows, notice);
    if (add) root.appendChild(add);
    render();
    return root;
}
