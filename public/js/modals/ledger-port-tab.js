import { appState, allocateLocalId, getDeviceById } from '../core/state.js';
import { eventBus } from '../core/event-bus.js';
import { isValidPortVlan, normalizePortName } from '../core/connection-data.js';
import { buildPortLedgerBatch, portLedgerValues, projectPortLedger } from '../core/device-port-ledger.js';
import { confirmPendingSave, flushSaveQueue, getPendingSave, isSaveInFlight, reloadConflictedResource, saveConnectionBatch } from '../core/save-queue.js';
import { chooseUnsavedChanges } from '../core/unsaved-changes-dialog.js';
import { unmigratedVlanForLink } from '../core/legacy-link-vlans.js';
import { isCurrentUserAdmin } from '../ui/access-control.js';
import { setInputError } from '../ui/field-errors.js';
import { confirmPortVlanAction } from './ledger-port-vlan-dialog.js';
import { deleteUnmigratedVlan } from './ledger-legacy-vlans.js';

const COLUMNS = ['自機ポート名', '自機 VLAN', 'ポート備考', '接続先機器', '接続先ポート', '接続系統', 'ラベル', '接続備考', '操作'];
const ADD_PORT_LABEL = 'ポートのみ追加';
const deviceLabel = (device, id) => device?.name || `機器 #${id}`;
const searchable = text => text.normalize('NFKC').toLocaleLowerCase();
const COPY_FROM_PEER = '接続先 → この機器へコピー';
const COPY_TO_PEER = 'この機器 → 接続先へコピー';
const DELETE_UNMIGRATED_VLAN = '未移行設定削除';
const unmigratedVlanText = record => `未移行VLAN：${record.vlan}`;

function savedVlanPair({ link, port, peerPort, side }) {
    if (!(link?.resource_revision > 0 && port?.resource_revision > 0 && peerPort?.resource_revision > 0)) return null;
    const peerSide = side === 'from' ? 'to' : 'from';
    if (link[`${side}_port_id`] !== port.id || link[`${peerSide}_port_id`] !== peerPort.id) return null;
    return { linkId: link.id, side, peerSide, own: { ...port }, peer: { ...peerPort } };
}

function hasCurrentVlanPair({ linkId, side, peerSide, own, peer }) {
    const link = appState.links.find(row => row.id === linkId);
    const matchesPort = snapshot => appState.devicePorts.some(port => port.id === snapshot.id &&
        port.resource_revision === snapshot.resource_revision && port.vlan === snapshot.vlan);
    return link?.resource_revision > 0 &&
        link[`${side}_port_id`] === own.id && link[`${peerSide}_port_id`] === peer.id &&
        matchesPort(own) && matchesPort(peer);
}

function element(tag, text = '', className = '') {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
}

function button(label, handler, variant = 'secondary') {
    const node = element('button', label, `btn btn-${variant} btn-sm`);
    node.type = 'button';
    node.addEventListener('click', handler);
    return node;
}

function option(value, text) {
    const node = element('option', text);
    node.value = value;
    return node;
}

function wideRow(body, text, { section = false } = {}) {
    const row = element('tr', '', section ? 'port-ledger-section' : '');
    const cell = element(section ? 'th' : 'td', text);
    if (section) cell.scope = 'rowgroup';
    cell.colSpan = COLUMNS.length;
    row.append(cell);
    body.append(row);
    return cell;
}

function bindPeerPicker(input, deviceId, { getSelected, allowEmpty, onChoose }) {
    const popup = element('div', '', 'port-ledger-peer-popup');
    const list = element('div');
    list.id = 'ledger-port-peer-list';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', '接続先機器の候補');
    const empty = element('p', '該当する機器がありません', 'form-support');
    empty.setAttribute('role', 'status');
    popup.hidden = true;
    popup.append(list, empty);
    popup.addEventListener('pointerdown', event => event.preventDefault());
    popup.addEventListener('mousedown', event => event.preventDefault());
    input.parentElement.append(popup);
    const anchored = typeof popup.showPopover === 'function' &&
        globalThis.CSS?.supports('position-area: block-end span-inline-end');
    if (anchored) popup.setAttribute('popover', 'manual');
    input.autocomplete = 'off';
    input.placeholder = '機器名・IPアドレスで絞り込み';
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-controls', list.id);

    let matches = [];
    let active = -1;
    const displayLabel = (device, id) => `${deviceLabel(device, id)}（#${id}）${device?.ip ? ` / ${device.ip}` : ''}`;
    function close() {
        if (anchored && !popup.hidden) popup.hidePopover();
        popup.hidden = true;
        const id = getSelected();
        input.value = id ? displayLabel(appState.devices.find(device => String(device.id) === id), id) : '';
        input.setAttribute('aria-expanded', 'false');
        input.removeAttribute('aria-activedescendant');
        active = -1;
    }
    function setActive(index, scroll = false) {
        list.children[active]?.classList.remove('is-active');
        active = matches.length ? (index + matches.length) % matches.length : -1;
        const current = list.children[active];
        if (current) {
            current.classList.add('is-active');
            input.setAttribute('aria-activedescendant', current.id);
            if (scroll) current.scrollIntoView({ block: 'nearest' });
        } else {
            input.removeAttribute('aria-activedescendant');
        }
    }
    function choose(id) {
        onChoose(id);
        close();
    }
    function show(query) {
        const words = searchable(query).trim().split(/\s+/u).filter(Boolean);
        matches = allowEmpty && !words.length ? [{ id: '', text: '接続を登録しない' }] : [];
        const seen = new Set([String(deviceId)]);
        for (const device of appState.devices) {
            const id = String(device.id);
            if (seen.has(id)) continue;
            seen.add(id);
            const text = displayLabel(device, id);
            const haystack = searchable(`${text} ${device.location || ''} ${device.model || ''}`);
            if (words.every(word => haystack.includes(word))) matches.push({ id, text });
        }
        list.replaceChildren(...matches.map(({ id, text }) => {
            const entry = element('div', text, 'port-ledger-peer-option');
            entry.id = `ledger-port-peer-option-${id || 'none'}`;
            entry.setAttribute('role', 'option');
            entry.setAttribute('aria-selected', String(id === getSelected()));
            entry.addEventListener('click', () => choose(id));
            return entry;
        }));
        active = -1;
        empty.hidden = matches.length > 0;
        if (popup.hidden) {
            popup.hidden = false;
            if (anchored) popup.showPopover();
            input.setAttribute('aria-expanded', 'true');
        }
        setActive(Math.max(0, matches.findIndex(item => item.id === getSelected())));
    }
    function open() {
        if (popup.hidden) {
            input.value = '';
            show('');
        }
    }
    input.addEventListener('click', open);
    input.addEventListener('focus', () => input.select?.());
    input.addEventListener('input', () => show(input.value));
    input.addEventListener('blur', close);
    input.addEventListener('keydown', event => {
        if (event.isComposing || event.keyCode === 229) return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (popup.hidden) open();
            else setActive(active + (event.key === 'ArrowDown' ? 1 : -1), true);
        } else if (!popup.hidden && event.key === 'Enter') {
            event.preventDefault();
            if (matches[active]) choose(matches[active].id);
        } else if (!popup.hidden && event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            close();
        }
    });
    close();
    return close;
}

function rowEditor(row, deviceId, canEdit, { onSubmit, onCancel, onCopy, onDeleteLegacy, onDraftChange }) {
    const portOnly = row.key === 'new-port';
    const newConnection = row.key === 'new-link';
    const canEditConnection = canEdit && !portOnly;
    const before = portLedgerValues(row);
    const vlanPair = savedVlanPair(row);
    let selected = before.peerId;
    const form = element('form', '', 'port-ledger-editor');
    form.id = 'ledger-port-editor';
    const fullPeerName = !portOnly && !canEditConnection && element('p', '', 'form-support');
    const title = portOnly ? ADD_PORT_LABEL : newConnection ? '接続を追加' :
        row.port?.name || `ポート未指定の接続 #${row.link.id}`;
    const heading = element('h3', title);
    heading.id = 'ledger-port-editor-title';
    form.setAttribute('aria-labelledby', heading.id);
    form.append(heading);
    const notice = row.link && element('div', '', 'port-ledger-legacy-notice');
    const noticeText = notice && element('p', '', 'port-ledger-legacy-value');
    const deleteLegacy = notice && canEdit && button(DELETE_UNMIGRATED_VLAN, () =>
        onDeleteLegacy(unmigratedVlanForLink(row.link.id)), 'danger');
    if (notice) {
        noticeText.tabIndex = -1;
        notice.append(noticeText);
        if (deleteLegacy) {
            deleteLegacy.setAttribute('aria-label', `${DELETE_UNMIGRATED_VLAN}（接続 #${row.link.id} の詳細）`);
            notice.append(deleteLegacy);
        }
    }
    const fields = element('div', '', portOnly ? 'port-ledger-fields' : 'port-ledger-fields port-ledger-connection-fields');
    const inputs = {};
    const field = (key, label, tag = 'input') => {
        const wrapper = element('div', '', 'port-ledger-field');
        const caption = element('label', label);
        const input = element(tag);
        input.id = `ledger-port-${key}`;
        if (tag === 'input') input.type = 'text';
        if (tag === 'textarea') input.rows = 1;
        if (tag !== 'select') input.value = before[key] ?? '';
        inputs[key] = input;
        caption.htmlFor = input.id;
        wrapper.append(caption, input);
        fields.append(wrapper);
        return input;
    };
    const ownName = field('portName', row.port || portOnly ? 'ポート名' : 'ポート名（任意）');
    const vlan = field('vlan', 'VLAN設定');
    const vlanError = element('p', '', 'form-error');
    vlanError.id = 'ledger-port-vlan-error';
    vlanError.hidden = true;
    const vlanReason = element('p', '', 'form-support port-ledger-field-reason');
    vlanReason.id = 'ledger-port-vlan-reason';
    vlan.setAttribute('aria-describedby', vlanReason.id);
    vlan.parentElement.append(vlanReason, vlanError);
    const portMemo = field('portMemo', 'ポート備考（この機器のみ）', 'textarea');
    const peerInput = canEditConnection && field('peerId', '接続先機器');
    const peerName = !portOnly && field('peerPortName', '接続先ポート名（任意）');
    let closePeerPicker;
    const copies = [];
    let copyReason;
    const system = !portOnly && field('systemId', '接続系統', 'select');
    const label = !portOnly && field('label', 'ラベル');
    const memo = !portOnly && field('linkMemo', '接続備考（両機器で共通）', 'textarea');
    const peerPorts = canEditConnection && element('datalist');
    if (canEditConnection) {
        peerPorts.id = 'ledger-port-peer-options';
        peerName.setAttribute('list', peerPorts.id);
        closePeerPicker = bindPeerPicker(peerInput, deviceId, {
            getSelected: () => selected,
            allowEmpty: !row.link && !newConnection,
            onChoose: id => {
                if (id === selected) return;
                selected = id;
                peerName.value = selected === before.peerId ? before.peerPortName : '';
                refreshPeerPorts();
                syncDraft();
            }
        });
    }
    const portNames = peerName ? [ownName, peerName] : [ownName];
    for (const input of portNames) {
        input.addEventListener('change', () => {
            input.value = normalizePortName(input.value);
            syncDraft();
        });
    }
    const error = element('p', '', 'form-support');
    error.setAttribute('role', 'alert');
    error.hidden = true;
    const actions = element('div', '', 'port-ledger-actions');
    const apply = button('適用', () => onSubmit('apply'), 'primary');
    const cancel = button(canEdit ? 'キャンセル' : '閉じる', onCancel);
    const destructive = row.link || row.port ? button(row.link ? '接続を解除' : 'ポートを削除', () => {
        let message = row.link ? 'この共通接続を解除しますか？ 全ビューに反映されます。ポートとその VLAN 設定は残ります。' :
            `未接続ポート「${row.port.name}」を削除しますか？`;
        if (row.link && unmigratedVlanForLink(row.link.id)) {
            message += '\nこの接続の未移行VLANも削除されます。';
        }
        if (window.confirm(message)) return onSubmit(row.link ? 'disconnect' : 'delete');
    }, 'danger') : null;
    if (canEdit && destructive && (!row.held || row.link)) actions.append(destructive);
    const confirmActions = element('div', '', 'port-ledger-confirm-actions');
    confirmActions.append(cancel);
    if (canEdit) confirmActions.append(apply);
    actions.append(confirmActions);
    if (fullPeerName) form.append(fullPeerName);
    form.append(fields);
    if (vlanPair) {
        const section = element('div', '', 'port-ledger-vlan-copy');
        section.append(element('p', `接続先の VLAN設定：${vlanPair.peer.vlan || '未設定'}`));
        if (canEdit) {
            const controls = element('div', '', 'port-ledger-vlan-copy-controls');
            const actions = element('div', '', 'port-ledger-vlan-copy-actions');
            copyReason = element('p', '', 'form-support');
            copyReason.id = 'ledger-port-vlan-copy-reason';
            copyReason.setAttribute('role', 'status');
            for (const [direction, source, destination] of [
                [COPY_FROM_PEER, vlanPair.peer, vlanPair.own],
                [COPY_TO_PEER, vlanPair.own, vlanPair.peer]
            ]) {
                const copy = button(direction, () => onCopy(vlanPair, direction, source, destination));
                copies.push({ copy, source });
                actions.append(copy);
            }
            controls.append(actions, copyReason);
            section.append(controls);
        }
        form.append(section);
    }
    if (peerPorts) form.append(peerPorts);
    form.append(error, actions);
    form.addEventListener('submit', event => {
        event.preventDefault();
        if (canEdit && !apply.disabled) void onSubmit('apply');
    });

    let newPortMemo = before.portMemo;
    let newPortVlan = before.vlan;
    let selectedOwnName = before.portName;
    let selectedOwnPort = null;
    let selectedOwnVlan = '';
    const canEditSelectedVlan = Boolean(row.unmigratedVlan && !row.port);
    let controlsLocked = false;
    let controlsBlocked = false;
    const findExistingOwnPort = () => !row.port && !portOnly && appState.devicePorts.find(port =>
        port.device_id === deviceId && port.name === normalizePortName(ownName.value));
    const existingOwnPort = () => canEditSelectedVlan ? selectedOwnPort : findExistingOwnPort();
    function captureOwnPort() {
        const name = normalizePortName(ownName.value);
        if (name === selectedOwnName) return;
        selectedOwnName = name;
        const match = findExistingOwnPort();
        selectedOwnPort = match ? { ...match } : null;
        selectedOwnVlan = selectedOwnPort?.vlan ?? '';
    }
    function read() {
        const existingPort = existingOwnPort();
        return Object.fromEntries(Object.keys(before).map(key => {
            if (key === 'peerId') return [key, selected];
            const input = inputs[key];
            if (input?.disabled && (key === 'portMemo' || key === 'vlan')) return [key, before[key]];
            if (existingPort && (key === 'portMemo' || (key === 'vlan' && !canEditSelectedVlan))) return [key, before[key]];
            return [key, input?.value ?? before[key]];
        }));
    }
    const hasInput = () => canEdit && Object.entries(read()).some(([key, value]) => value !== before[key]);
    function copyBlockReason() {
        if (!canEdit || appState.authExpired) return '編集権限がありません。';
        if (controlsLocked || controlsBlocked || getPendingSave()) return '保存処理が完了するまでコピーできません。';
        if (hasInput()) return '未適用の変更を適用するか、キャンセルしてください。';
        if (!vlanPair || !hasCurrentVlanPair(vlanPair)) return '接続またはポートが更新されました。行を開き直してください。';
        if (appState.resourceConflicts.links?.has(vlanPair.linkId) ||
            appState.resourceConflicts.device_ports?.has(vlanPair.own.id) ||
            appState.resourceConflicts.device_ports?.has(vlanPair.peer.id)) return '競合した接続またはポートを再読込してください。';
        return '';
    }
    function syncDraft() {
        syncControls(controlsLocked, controlsBlocked);
        onDraftChange();
    }
    function refreshPeerPorts() {
        if (canEditConnection) {
            peerPorts.replaceChildren(...appState.devicePorts.filter(port => String(port.device_id) === selected)
                .map(port => option(port.name, '')));
        } else if (selected) {
            const device = appState.devices.find(row => String(row.id) === selected);
            fullPeerName.textContent = `接続先：${deviceLabel(device, selected)}（#${selected}）`;
        } else {
            fullPeerName.hidden = true;
        }
    }
    function refreshOptions() {
        if (portOnly) return;
        refreshPeerPorts();
        const priorSystem = system.value;
        const systems = appState.linkSystems.map(row => option(String(row.id), row.name));
        const systemId = priorSystem || (!system.children.length ? before.systemId : '');
        if (systemId && !systems.some(item => item.value === systemId)) systems.push(option(systemId, `接続系統 #${systemId}`));
        system.replaceChildren(option('', '未設定'), ...systems);
        system.value = systemId;
    }
    function syncControls(locked, blocked) {
        controlsLocked = locked;
        controlsBlocked = blocked;
        const mutable = canEdit && !locked && !appState.authExpired;
        const existingPort = existingOwnPort();
        portMemo.disabled = !row.port && !normalizePortName(ownName.value);
        const memoValue = portMemo.disabled ? '' : existingPort ? existingPort.memo : newPortMemo;
        if (portMemo.value !== memoValue) portMemo.value = memoValue;
        portMemo.readOnly = !mutable || Boolean(existingPort);
        portMemo.title = existingPort ? '登録済みの備考はポートの行で編集できます' : '';
        vlan.disabled = portMemo.disabled;
        vlan.readOnly = !mutable || Boolean(existingPort && !canEditSelectedVlan);
        const vlanValue = vlan.disabled ? '' : existingPort ?
            (canEditSelectedVlan ? selectedOwnVlan : existingPort.vlan) : newPortVlan;
        if (vlan.value !== vlanValue) vlan.value = vlanValue;
        vlanReason.textContent = existingPort && !canEditSelectedVlan ? '登録済みの VLAN はポートの行で編集できます。' : '';
        vlanReason.hidden = !vlanReason.textContent;
        if (!vlanError.hidden && (vlan.disabled || (existingPort && !canEditSelectedVlan) || isValidPortVlan(vlan.value))) {
            setInputError(vlan, vlanError, '');
        }
        ownName.readOnly = !mutable;
        if (!portOnly) {
            for (const input of [peerName, label, memo]) {
                input.readOnly = !mutable;
                input.disabled = !selected;
            }
            if (peerInput) {
                peerInput.disabled = !mutable;
                if (!mutable) closePeerPicker();
            }
            system.disabled = !mutable || !selected;
        }
        apply.disabled = !mutable || blocked;
        if (destructive) destructive.disabled = !mutable || blocked;
        cancel.disabled = locked;
        if (notice) {
            const record = unmigratedVlanForLink(row.link.id);
            if (record) {
                const text = unmigratedVlanText(record);
                if (noticeText.textContent !== text) noticeText.textContent = text;
                if (!notice.parentElement) heading.after(notice);
            } else if (notice.parentElement) {
                if (notice.contains(document.activeElement)) ownName.focus();
                notice.remove();
            }
        }
        if (copyReason) {
            const common = copyBlockReason();
            for (const { copy, source } of copies) {
                copy.disabled = Boolean(common || !source.vlan);
                if (copy.disabled) copy.setAttribute('aria-describedby', copyReason.id);
                else copy.removeAttribute('aria-describedby');
            }
            const reason = common || (vlanPair.own.vlan
                ? (vlanPair.peer.vlan ? '' : '接続先の VLAN設定が空欄です。')
                : (vlanPair.peer.vlan ? 'この機器の VLAN設定が空欄です。' : '両端の VLAN設定が空欄です。'));
            if (copyReason.textContent !== reason) copyReason.textContent = reason;
        }
    }
    if (canEdit) {
        for (const [key, input] of Object.entries(inputs)) {
            if (key === 'peerId') continue;
            const update = () => {
                if (input === ownName && canEditSelectedVlan) captureOwnPort();
                if (input === portMemo && !portMemo.readOnly && !portMemo.disabled) newPortMemo = portMemo.value;
                if (input === vlan && !vlan.readOnly && !vlan.disabled) {
                    if (selectedOwnPort) selectedOwnVlan = vlan.value;
                    else newPortVlan = vlan.value;
                }
                syncDraft();
            };
            input.addEventListener('input', update);
            input.addEventListener('change', update);
        }
    }
    refreshOptions();
    return { row, form, initialFocus: ownName, noticeText, deleteLegacy, closePeerPicker, read, refreshOptions, syncControls,
        get selectedOwnPort() { return selectedOwnPort; },
        normalizeNames: () => {
            for (const input of portNames) input.value = normalizePortName(input.value);
        },
        hasInput, vlanPair, copyBlockReason,
        validateVlan: value => {
            if (vlan.disabled || vlan.readOnly || isValidPortVlan(value)) return true;
            setInputError(vlan, vlanError, 'VLAN設定は 1 行、200 文字以内で指定してください');
            vlan.focus();
            return false;
        },
        showError: message => { error.textContent = message; error.hidden = !message; }
    };
}

function revealPortEditor({ form, initialFocus }, target = initialFocus) {
    target.focus({ preventScroll: true });
    const tableViewport = form.closest('.port-ledger-scroll');
    const headerHeight = tableViewport.querySelector('thead').offsetHeight;
    // 内側から縦方向だけ調整し、表の横スクロール位置は変えない。
    for (const [viewport, inset] of [[tableViewport, headerHeight], [form.closest('#ledger-sheet-body'), 0]]) {
        if (!viewport?.clientHeight) continue;
        const top = viewport.getBoundingClientRect().top + viewport.clientTop;
        const visibleTop = top + inset;
        const visibleBottom = top + viewport.clientHeight;
        const bounds = form.getBoundingClientRect();
        if (bounds.top < visibleTop || bounds.bottom - bounds.top > visibleBottom - visibleTop) {
            viewport.scrollTop += bounds.top - visibleTop;
        } else if (bounds.bottom > visibleBottom) {
            viewport.scrollTop += bounds.bottom - visibleBottom;
        }
    }
}

export function createLedgerPortTab({ openDevice, onBusyChange }) {
    let deviceId = null;
    let root, ports, unspec, held, status, recovery, addPort, addLink, editor, submission;
    let submitting = false;
    let confirmingVlan = false;
    let deletingLegacyVlan = false;
    const isBusy = () => submitting || confirmingVlan || deletingLegacyVlan;
    let info = '';
    const pending = () => Boolean(submission && getPendingSave()?.payload === submission);
    const hasUnsavedDraft = () => !pending() && Boolean(editor?.hasInput());
    const originButtons = new Map();
    const canDeleteLegacy = () => isCurrentUserAdmin() && !appState.authExpired && !appState.isPinging &&
        !getPendingSave() && !isSaveInFlight() && !hasUnsavedDraft();

    function syncLegacyButton() {
        if (editor?.deleteLegacy) editor.deleteLegacy.disabled = isBusy() || !canDeleteLegacy();
    }

    async function deleteLegacy(record) {
        if (!record || !editor || isBusy() || !canDeleteLegacy()) return false;
        const current = editor;
        const control = current.deleteLegacy;
        deletingLegacyVlan = true;
        onBusyChange();
        let deleted;
        try {
            deleted = await deleteUnmigratedVlan(record, {
                canAct: () => editor === current && canDeleteLegacy(),
                onBusyChange: busy => { if (busy) syncStatus(); }
            });
            return deleted;
        } finally {
            deletingLegacyVlan = false;
            onBusyChange();
            syncStatus();
            if (editor === current && (document.activeElement === control || !document.activeElement?.isConnected ||
                document.activeElement === document.body)) {
                const target = !deleted && control.isConnected && !control.disabled ? control : current.initialFocus;
                target?.focus();
            }
        }
    }

    function closeEditor({ focus = false } = {}) {
        const row = editor?.row;
        editor = null;
        refreshTable();
        if (focus) {
            const link = row?.link && appState.links.find(link => link.id === row.link.id);
            const attachedPort = link?.[`${row.side}_port_id`];
            (originButtons.get(row?.key) || originButtons.get(`port-${attachedPort}`) || addPort || root)?.focus();
        }
    }
    function finish(message = '保存済み') {
        submission = null;
        info = message;
        closeEditor({ focus: true });
        syncStatus();
    }
    async function runSave(current, task) {
        submitting = true;
        info = '';
        onBusyChange();
        syncStatus();
        try {
            const saved = await task();
            if (saved && editor === current) finish();
            if (!saved && !pending() && editor === current) {
                current.showError(appState.appStatus.lastError || '保存できませんでした。入力を保持しています');
            }
            return saved;
        } finally {
            submitting = false;
            onBusyChange();
            if (!pending()) submission = null;
            syncStatus();
        }
    }
    async function retryMaintenance() {
        if (!editor || !pending() || !getPendingSave()?.maintenanceRejected ||
            !isCurrentUserAdmin() || appState.authExpired || submitting) return false;
        const current = editor;
        current.showError('');
        return await runSave(current, () => flushSaveQueue());
    }
    async function submit(action) {
        if (!editor || !isCurrentUserAdmin() || appState.authExpired || isBusy() || getPendingSave()) return false;
        const current = editor;
        if (action === 'apply') current.normalizeNames();
        const values = current.read();
        current.showError('');
        if (action === 'apply' && !current.validateVlan(values.vlan)) return false;
        try {
            submission = buildPortLedgerBatch(appState, deviceId, current.row, values, allocateLocalId, action, current.selectedOwnPort);
            if (!submission.device_ports.length && !submission.links.length) {
                submission = null;
                closeEditor({ focus: true });
                return true;
            }
        } catch (error) {
            current.showError(error.message);
            return false;
        }
        return await runSave(current, () => saveConnectionBatch(submission));
    }
    async function copyVlan(pair, direction, source, destination) {
        const current = editor;
        if (!current || current.vlanPair !== pair || !isCurrentUserAdmin() ||
            isBusy() || current.copyBlockReason() || !source.vlan) return false;
        current.showError('');
        if (source.vlan === destination.vlan) {
            info = 'コピー先には同じ VLAN が設定されています。';
            syncStatus();
            return true;
        }
        const vlanCopy = {
            link_id: pair.linkId,
            source_port_id: source.id,
            destination_port_id: destination.id,
            source_expected_revision: source.resource_revision,
            destination_expected_revision: destination.resource_revision
        };
        const batch = { device_ports: [{
            operation: 'update', id: destination.id, expected_revision: destination.resource_revision,
            port: { vlan: source.vlan }
        }], links: [] };
        if (destination.vlan) {
            confirmingVlan = true;
            try {
                const endpoint = port => `${deviceLabel(getDeviceById(port.device_id), port.device_id)}（ポート：${port.name}）`;
                const confirmed = await confirmPortVlanAction({
                    title: 'VLAN設定の上書き確認',
                    lines: [direction],
                    comparison: [
                        { label: 'コピー元', endpoint: endpoint(source), value: `VLAN設定：${source.vlan}` },
                        { label: 'コピー先', endpoint: endpoint(destination), value: `上書き前の VLAN設定：${destination.vlan}` }
                    ],
                    confirmLabel: '上書きしてコピー'
                });
                if (!confirmed) return false;
            } finally {
                confirmingVlan = false;
            }
            if (editor !== current || !isCurrentUserAdmin()) return false;
            const reason = current.copyBlockReason();
            if (reason) {
                current.showError(reason);
                return false;
            }
        }
        submission = batch;
        return await runSave(current, () => saveConnectionBatch(batch, { vlanCopy }));
    }
    async function confirmLeave() {
        if (isBusy()) return false;
        if (pending()) return true; // 保存済みかどうかの確認は共通キューに残る。
        if (hasUnsavedDraft()) {
            const current = editor;
            const choice = await chooseUnsavedChanges('接続・ポートに未適用の変更があります。どうしますか？');
            if (current !== editor || appState.authExpired) return false;
            if (choice === 'save') return submit('apply');
            if (choice !== 'discard') return false;
        }
        if (editor) closeEditor();
        return true;
    }
    async function start(row, focusPending = false) {
        if (isBusy()) return;
        const sourceId = deviceId;
        const reveal = () => revealPortEditor(editor,
            focusPending && editor.noticeText?.isConnected ? editor.noticeText : undefined);
        if (editor?.row.key === row.key) { reveal(); return; }
        if (!await confirmLeave() || isBusy() || pending() || !root || sourceId !== deviceId) return;
        editor = rowEditor(row, deviceId, isCurrentUserAdmin() && !appState.authExpired,
            { onSubmit: submit, onCancel: () => closeEditor({ focus: true }), onCopy: copyVlan,
                onDeleteLegacy: deleteLegacy, onDraftChange: syncLegacyButton });
        refreshTable();
        syncStatus();
        reveal();
    }

    function openConnection(linkId) {
        const { ports: registered, unspecified } = projectPortLedger(appState, deviceId);
        const row = [...registered, ...unspecified].find(row => Number(row.link?.id) === Number(linkId));
        if (row) return start(row, true);
    }

    function syncStatus() {
        if (!root) return;
        const waiting = getPendingSave();
        const ownPending = pending();
        const copyPending = ownPending && Boolean(waiting.vlanCopy);
        if (ownPending && appState.appStatus.state === 'unconfirmed') {
            status.textContent = '保存結果が未確認です。確認できない場合は個票を閉じ、「読込」で最新データを確認してください。';
        } else if (ownPending && waiting.maintenanceRejected) {
            status.textContent = copyPending ? '保守作業中のためコピーされていません。' :
                '保守作業中のため保存されていません。入力を保持しています。';
        } else {
            status.textContent = submitting ? '保存中…' : info;
        }
        status.hidden = !status.textContent;
        if (addPort) addPort.disabled = addLink.disabled = isBusy() || Boolean(waiting) || appState.authExpired;
        editor?.syncControls(submitting || ownPending || deletingLegacyVlan, Boolean(waiting));
        syncLegacyButton();

        const conflictButtons = [];
        if (isCurrentUserAdmin() && !appState.authExpired) {
            for (const [kind, label] of [['device_ports', 'ポート'], ['links', '接続']]) {
                for (const [id] of appState.resourceConflicts[kind] || []) {
                    const retry = button(`${label} #${id} の競合を再読込`, () => reloadConflictedResource(kind, id));
                    retry.disabled = submitting || Boolean(waiting);
                    conflictButtons.push(retry);
                }
            }
            if (ownPending && appState.appStatus.state === 'unconfirmed') {
                conflictButtons.push(button('保存状態を確認', async () => {
                    const result = await confirmPendingSave();
                    if (result === 'retry') {
                        submission = null;
                        info = copyPending ? 'コピー先は更新されていませんでした。再度コピーしてください。' :
                            '保存されていませんでした。入力を確認し、適用し直してください。';
                    }
                    syncStatus();
                }));
            } else if (ownPending && waiting.maintenanceRejected) {
                conflictButtons.push(button('保存を再試行', retryMaintenance));
            }
        }
        const focusedButton = recovery.contains(document.activeElement) ? document.activeElement.textContent : null;
        recovery.replaceChildren(...conflictButtons);
        if (focusedButton) conflictButtons.find(node => node.textContent === focusedButton)?.focus();
    }

    function refreshTable() {
        if (!root) return;
        const active = document.activeElement;
        editor?.closePeerPicker?.();
        const keepEditorFocus = editor?.form.contains(active);
        const keepRowFocus = active?.dataset.portLedgerRow;
        const oldHeldOpen = held.open;
        const state = projectPortLedger(appState, deviceId);
        const devices = new Map(appState.devices.map(row => [Number(row.id), row]));
        const systems = new Map(appState.linkSystems.map(row => [Number(row.id), row.name]));
        const addEditor = group => wideRow(group, '').append(editor.form);
        originButtons.clear();
        if (addPort) originButtons.set('new-port', addPort).set('new-link', addLink);
        let editorShown = false;
        function appendRow(group, row) {
            const tr = element('tr');
            tr.dataset.portLedgerKey = row.key;
            const name = row.port?.name ?? '未指定';
            const peerDevice = devices.get(row.peerId);
            const peerText = row.link ? deviceLabel(peerDevice, row.peerId) : row.held ? '要確認（旧接続）' : '未接続';
            const peer = peerDevice && row.link ? button(peerText, () => openDevice(row.peerId), 'tertiary') : null;
            if (peer) peer.setAttribute('aria-label', `${peerText}（#${row.peerId}）の個票を開く`);
            const cells = [name, row.port?.vlan || '—', row.port?.memo || '—', peer || peerText,
                row.link ? row.peerPortName || '未指定' : '—', systems.get(row.link?.system_id) || '—',
                row.link?.label || '—', row.link?.memo || '—'];
            cells.forEach((value, index) => {
                const cell = element(index === 0 ? 'th' : 'td');
                if (index === 0) cell.scope = 'row';
                const content = typeof value === 'string' ? element('span', value) : value;
                content.classList.add('port-ledger-value');
                content.title = content.textContent;
                cell.append(content);
                if (index === 1 && row.unmigratedVlan) {
                    const notice = element('p', unmigratedVlanText(row.unmigratedVlan), 'port-ledger-legacy-value');
                    notice.title = notice.textContent;
                    cell.append(notice);
                }
                tr.append(cell);
            });
            const actions = element('td');
            const edit = button(isCurrentUserAdmin() ? '編集' : '詳細', () => start(row));
            const expanded = editor?.row.key === row.key;
            edit.setAttribute('aria-label', `${row.port?.name ?? `接続 #${row.link.id}`}を${edit.textContent === '編集' ? '編集' : '表示'}`);
            edit.setAttribute('aria-expanded', String(expanded));
            if (expanded) edit.setAttribute('aria-controls', editor.form.id);
            edit.dataset.portLedgerRow = row.key;
            originButtons.set(row.key, edit);
            actions.append(edit);
            tr.append(actions);
            group.append(tr);
            if (expanded) { addEditor(group); editorShown = true; }
        }
        ports.replaceChildren();
        const adding = editor?.row.key === 'new-port' || editor?.row.key === 'new-link';
        if (adding) { addEditor(ports); editorShown = true; }
        for (const row of state.ports) appendRow(ports, row);
        if (!state.ports.length && !adding) wideRow(ports, '登録ポートはありません');
        unspec.replaceChildren();
        if (state.unspecified.length) {
            wideRow(unspec, 'ポート未指定の接続', { section: true });
        }
        for (const row of state.unspecified) appendRow(unspec, row);
        if (editor && !editorShown) addEditor(unspec);
        held.hidden = !state.held.length;
        if (state.held.length) {
            const list = element('ul');
            const views = new Map(appState.views.map(view => [Number(view.id), view.name]));
            for (const row of state.held) {
                const { payload } = row;
                const endpoint = side => `${deviceLabel(devices.get(Number(payload[`${side}_id`])), payload[`${side}_id`])} / ${payload[`${side}_port`] || '未指定'}`;
                list.append(element('li', `旧接続 #${row.legacy_link_id}（${views.get(row.view_id) || `ビュー #${row.view_id}`}）：${endpoint('from')} ↔ ${endpoint('to')}`));
            }
            held.replaceChildren(element('summary', `移行保留の旧接続 ${state.held.length} 件`),
                element('p', '旧記録は登録済みの接続・空きポートとして扱いません。元のビューの「一覧」で確認してください。', 'form-support'), list);
            held.open = oldHeldOpen;
        }
        syncLegacyButton();
        if (keepEditorFocus) active.focus();
        else if (keepRowFocus) originButtons.get(keepRowFocus)?.focus();
    }

    function mount(panel, id) {
        if (!root || deviceId !== id) {
            deviceId = id;
            editor = submission = null;
            info = '';
            root = element('div');
            root.tabIndex = -1;
            addPort = addLink = null;
            if (isCurrentUserAdmin()) {
                const toolbar = element('div', '', 'port-ledger-toolbar');
                addPort = button(ADD_PORT_LABEL, () => start({ key: 'new-port' }));
                addLink = button('接続を追加', () => start({ key: 'new-link' }));
                toolbar.append(addPort, addLink);
                root.append(toolbar);
            }
            status = element('p', '', 'port-ledger-status');
            status.setAttribute('role', 'status');
            recovery = element('div', '', 'port-ledger-actions');
            held = element('details');
            const scroll = element('div', '', 'port-ledger-scroll');
            scroll.tabIndex = 0;
            scroll.setAttribute('role', 'region');
            scroll.setAttribute('aria-label', 'ポートと共通接続の一覧');
            const table = element('table', '', 'port-ledger-table');
            const head = element('thead');
            const header = element('tr');
            for (const name of COLUMNS) {
                const th = element('th', name);
                th.scope = 'col';
                header.append(th);
            }
            head.append(header);
            ports = element('tbody');
            unspec = element('tbody');
            table.append(head, ports, unspec);
            scroll.append(table);
            root.append(status, recovery, scroll, held);
            panel.append(root);
        } else {
            panel.append(root);
        }
        refreshTable();
        syncStatus();
    }

    function refresh() {
        if (!root) return;
        editor?.refreshOptions();
        refreshTable();
        syncStatus();
    }
    eventBus.on('resources:saved', data => {
        if (pending()) finish(data?.copy_state_matched
            ? 'コピー先に指定の VLAN が設定されています。コピー操作の成否は確認できません。' : undefined);
        else refresh();
    });
    for (const event of ['resource:reloaded', 'legacy-links:changed', 'legacy-vlans:changed', 'link-systems:changed']) {
        eventBus.on(event, refresh);
    }
    eventBus.on('resources:reloaded', () => {
        editor = submission = null;
        info = '';
        refresh();
    });
    eventBus.on('resources:ids-remapped', maps => {
        if (deviceId != null && maps?.devices?.[deviceId] != null) {
            deviceId = Number(maps.devices[deviceId]);
        }
        refresh();
    });
    eventBus.on('save-state:changed', syncStatus);
    eventBus.on('auth:expired', syncStatus);
    // Ping の開始・終了とも、実行状態を更新してから台帳の再描画が通知される。
    eventBus.on('ledger:render', syncLegacyButton);
    return { mount, openConnection, confirmLeave, hasUnsavedDraft, isBusy,
        clear: () => {
            root = editor = submission = null;
            originButtons.clear();
        } };
}
