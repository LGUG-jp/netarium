import { appState, getCurrentView, getDeviceById } from '../core/state.js';
import { DEVICE_TYPES } from '../core/constants.js';
import { validateRackLayout, rackDisplaySlot, rackFaces, rackOccupiedFaces, rackOverlap, rackUsage } from '../core/rack-layout.js';
import { isCurrentUserAdmin, requireAdminUiAction } from '../ui/access-control.js';
import { hasResourceConflict, isSaveInFlight, scheduleSave } from '../core/save-queue.js';
import { markDirty } from '../ui/status-bar.js';
import { showToast } from '../ui/toast.js';
import { openPanel } from '../ui/property-panel.js';
import { registerModalOpen, registerModalClose } from '../core/modal-focus.js';
import { eventBus } from '../core/event-bus.js';
import { showCanvasContextToolbar, hideCanvasContextToolbar } from '../ui/canvas-context-toolbar.js';
import { createDeviceTypePicker, closeDeviceTypePicker } from '../ui/device-type-picker.js';
import { createRackTransferConfirmation } from '../ui/rack-transfer-confirmation.js';
import { suppressCanvasClickOnce } from './interaction-state.js';
import { isShelfAdding, setShelfAdding, openShelfDialog, showShelfPanel, shelfForDevice, shelfLocation, deviceRackLocation, shelfMembers } from './rack-shelves.js';
import { renderFloorRackReturn } from '../modals/view-manager-modal.js';

let dialog = null;
let dialogOriginViewId = null;
let rangeSelection = null;
let cancelRange = null;
let finishRange = null;
let cancelMountDrag = null;
const initializedRangeButtons = new WeakSet();
const faceLabel = face => ({ front: '前面', rear: '背面', both: '両面占有（旧形式）' })[face];
const slotLabel = slot => ({ full: '全幅', left: '左半分', right: '右半分' })[slot];
const depthLabel = mount => mount.face === 'both' || mount.depth === 'full' ? '全体' : '半分';
function element(tag, className = '', text) {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}
function button(text, handler, disabled = false) {
    const node = element('button', 'btn btn-secondary btn-sm', text);
    node.type = 'button'; node.disabled = disabled;
    node.addEventListener('click', handler);
    return node;
}
function rackMounts(id) { return appState.rackMounts.filter(row => Number(row.view_id) === Number(id)); }
function editable(viewIds) {
    return isCurrentUserAdmin() && !appState.authExpired && !isSaveInFlight() &&
        appState.appStatus.state !== 'unconfirmed' &&
        !viewIds.some(id => hasResourceConflict('views', id));
}
function closeMountDialog() {
    if (!dialog) return;
    closeDeviceTypePicker();
    dialog.remove(); dialog = null;
    registerModalClose('rack-mount');
}

export function saveRackMount(mount) {
    if (!requireAdminUiAction()) return false;
    const previous = appState.rackMounts.find(row => Number(row.device_id) === Number(mount.device_id));
    const sourceShelf = shelfForDevice(mount.device_id);
    if (!editable([mount.view_id, ...(previous ? [previous.view_id] : []), ...(sourceShelf ? [sourceShelf.view_id] : [])])) {
        showToast('保存中・未確認・競合中のラックは変更できません。保存状態を確認してください', 'warning');
        return false;
    }
    const mounts = [...appState.rackMounts.filter(row => Number(row.device_id) !== Number(mount.device_id)), mount];
    const rackShelfDevices = (appState.rackShelfDevices || []).filter(row => Number(row.device_id) !== Number(mount.device_id));
    try { validateRackLayout({ ...appState, rackMounts: mounts, rackShelfDevices }); }
    catch (error) { showToast(error.message, 'warning'); return false; }
    appState.rackMounts = mounts;
    appState.rackShelfDevices = rackShelfDevices;
    markDirty(); scheduleSave({ immediate: true, silent: true });
    eventBus.emit('rack:changed');
    return true;
}

export function removeRackMount(deviceId) {
    if (!requireAdminUiAction()) return false;
    const mount = appState.rackMounts.find(row => Number(row.device_id) === Number(deviceId));
    if (!mount || !editable([mount.view_id])) return false;
    appState.rackMounts = appState.rackMounts.filter(row => row !== mount);
    markDirty(); scheduleSave({ immediate: true, silent: true });
    eventBus.emit('rack:changed');
    return true;
}

export function openRackMountDialog({ viewId, face = 'front', startU = 1, heightU = 1, widthSlot = 'full', deviceId = null }) {
    if (!requireAdminUiAction() || !editable([viewId])) return;
    closeMountDialog();
    cancelRange?.();
    const originViewId = appState.currentViewId;
    dialogOriginViewId = originViewId;
    const previous = appState.rackMounts.find(row => Number(row.device_id) === Number(deviceId));
    const overlay = element('div', 'view-manager-overlay rack-mount-overlay');
    const section = element('section', 'view-manager-dialog rack-mount-dialog');
    section.setAttribute('role', 'dialog'); section.setAttribute('aria-modal', 'true');
    section.setAttribute('aria-labelledby', 'rack-mount-title');
    const title = element('h2'); title.id = 'rack-mount-title';
    const form = element('form', 'rack-mount-form');
    const body = element('div', 'rack-mount-body');
    const actions = element('div', 'rack-mount-actions');
    const fields = {};
    function field(parent, name, labelText, node) {
        const group = element('div', 'rack-mount-field');
        const label = element('label', '', labelText); node.id = `rack-mount-${name}`;
        label.setAttribute('for', node.id); fields[name] = node;
        group.append(label, node); parent.appendChild(group); return node;
    }
    function select(parent, name, label, options, value) {
        const node = element('select');
        for (const [key, text] of options) {
            const option = element('option', '', text); option.value = String(key); node.appendChild(option);
        }
        node.value = String(value); return field(parent, name, label, node);
    }
    let selectedId = deviceId, newDevice = false, submitting = false, pendingTransfer = null;
    const deviceArea = element('div', 'rack-mount-device-area');
    const search = field(deviceArea, 'search', '機器（名称・IPで検索）', element('input'));
    search.type = 'text'; search.autocomplete = 'off';
    search.setAttribute('role', 'combobox'); search.setAttribute('aria-autocomplete', 'list');
    search.setAttribute('aria-controls', 'rack-mount-candidates'); search.setAttribute('aria-expanded', 'false');
    search.value = getDeviceById(deviceId)?.name || '';
    const candidates = element('div', 'rack-mount-candidates'); candidates.id = 'rack-mount-candidates';
    candidates.setAttribute('role', 'listbox'); candidates.setAttribute('aria-label', '搭載する機器の候補'); candidates.hidden = true;
    let matches = [], activeIndex = -1;
    const rackName = id => appState.views.find(row => Number(row.id) === Number(id))?.name || '不明なラック';
    const mountText = mount => `${faceLabel(mount.face)}・${slotLabel(rackDisplaySlot(mount.width_slot, mount.face))} / ${mount.start_u}〜${Number(mount.start_u) + Number(mount.height_u) - 1}U（${mount.height_u}U占有） / 奥行き：${depthLabel(mount)}`;
    const selectedMount = () => !newDevice && (appState.rackMounts.find(row => Number(row.device_id) === Number(selectedId)) ||
        (shelfForDevice(selectedId) && { ...shelfForDevice(selectedId), width_slot: 'full', shelf: true }));
    function hideCandidates() {
        candidates.hidden = true; search.setAttribute('aria-expanded', 'false'); search.removeAttribute('aria-activedescendant');
    }
    function chooseDevice(device) {
        selectedId = device.id; search.value = device.name; hideCandidates();
        if (selectedMount()?.face === 'both') { width.value = 'full'; depth.value = 'full'; }
        update();
    }
    function filterDevices() {
        const query = search.value.trim().toLocaleLowerCase('ja');
        matches = appState.devices.filter(row => !query || `${row.name} ${row.ip || ''}`.toLocaleLowerCase('ja').includes(query));
        candidates.replaceChildren(); activeIndex = -1; search.removeAttribute('aria-activedescendant');
        for (const device of matches) {
            const mounted = appState.rackMounts.find(row => Number(row.device_id) === Number(device.id));
            const option = element('div', 'rack-mount-option');
            option.id = `rack-mount-option-${device.id}`; option.setAttribute('role', 'option');
            option.setAttribute('aria-selected', String(Number(selectedId) === Number(device.id)));
            option.append(element('strong', '', device.name),
                element('span', '', [DEVICE_TYPES[device.type]?.label || device.type, device.ip].filter(Boolean).join(' / ')));
            if (mounted || shelfForDevice(device.id)) option.appendChild(element('span', '', `現在：${deviceRackLocation(device.id)}`));
            option.addEventListener('pointerdown', event => event.preventDefault());
            option.addEventListener('click', () => chooseDevice(device));
            candidates.appendChild(option);
        }
        if (!matches.length) {
            const empty = element('p', '', '該当する機器がありません'); empty.setAttribute('role', 'status'); candidates.appendChild(empty);
        }
        candidates.hidden = false; search.setAttribute('aria-expanded', 'true');
    }
    search.addEventListener('input', () => { selectedId = null; filterDevices(); update(); });
    search.addEventListener('focus', () => { if (!search.readOnly) filterDevices(); });
    search.addEventListener('blur', event => {
        if (event.relatedTarget && deviceArea.contains(event.relatedTarget)) return;
        hideCandidates();
    });
    search.addEventListener('keydown', event => {
        if (event.isComposing || event.keyCode === 229) return;
        if (event.key === 'Escape' && !candidates.hidden) {
            event.preventDefault(); event.stopPropagation(); hideCandidates(); return;
        }
        if (search.readOnly) return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (candidates.hidden) filterDevices();
            if (!matches.length) return;
            activeIndex = (activeIndex + (event.key === 'ArrowDown' ? 1 : (activeIndex < 0 ? 0 : -1)) + matches.length) % matches.length;
            for (const [index, option] of [...candidates.children].entries()) option.setAttribute('aria-selected', String(index === activeIndex));
            const option = candidates.children[activeIndex];
            search.setAttribute('aria-activedescendant', option.id); option.scrollIntoView({ block: 'nearest' });
        } else if (event.key === 'Enter' && !candidates.hidden) {
            event.preventDefault();
            if (activeIndex >= 0) chooseDevice(matches[activeIndex]);
        }
    });
    search.readOnly = deviceId != null;
    deviceArea.appendChild(candidates);
    const newArea = element('div'); newArea.hidden = true;
    const picker = createDeviceTypePicker({ value: 'switch', control: element('button') });
    const type = field(newArea, 'type', '新規登録する機器種別', picker.control);
    if (deviceId == null) {
        const mode = button('新しい機器を登録', () => {
            if (submitting) return;
            newDevice = !newDevice; selectedId = null; search.value = ''; hideCandidates();
            search.parentElement.hidden = newDevice; newArea.hidden = !newDevice;
            mode.textContent = newDevice ? '既存機器から選択' : '新しい機器を登録';
            update(); (newDevice ? type : search).focus();
        });
        mode.addEventListener('pointerdown', event => event.preventDefault());
        deviceArea.append(mode, newArea);
    }
    body.appendChild(deviceArea);
    if (deviceId != null) {
        select(body, 'view', '搭載先ラック', appState.views.filter(row => row.view_type === 'rack').map(row => [row.id, row.name]), previous?.view_id || viewId);
    } else {
        body.appendChild(element('p', 'rack-mount-destination', `搭載先：${rackName(viewId)}`));
    }
    const position = element('div', 'rack-mount-position');
    const rowPrimary = element('div', 'rack-mount-row rack-mount-row-primary');
    const initialFace = previous?.face || face;
    select(rowPrimary, 'face', '搭載面', [['front', '前面'], ['rear', '背面']], initialFace === 'rear' ? 'rear' : 'front');
    const width = select(rowPrimary, 'width', '横幅位置', [['full', '全幅'], ['left', '左半分'], ['right', '右半分']],
        rackDisplaySlot(previous?.width_slot || widthSlot, previous?.face || face));
    const depth = select(rowPrimary, 'depth', '奥行き', [['half', '半分'], ['full', '全体']],
        previous?.face === 'both' ? 'full' : previous?.depth || 'half');
    const rowSecondary = element('div', 'rack-mount-row rack-mount-row-secondary');
    function number(parent, name, label, value) {
        const input = field(parent, name, label, element('input'));
        input.type = 'number'; input.min = '1'; input.max = '60'; input.step = '1'; input.value = String(value); input.required = true;
    }
    number(rowSecondary, 'start', '開始U（最下段）', previous?.start_u || startU);
    number(rowSecondary, 'height', '占有U数', previous?.height_u || heightU);
    position.append(rowPrimary, rowSecondary);
    body.appendChild(position);
    const currentPosition = element('p', 'rack-mount-current');
    const summary = element('p', 'rack-mount-summary'); summary.setAttribute('role', 'status');
    const error = element('p', 'form-error'); error.setAttribute('role', 'alert'); error.id = 'rack-mount-error';
    for (const node of Object.values(fields)) node.setAttribute('aria-describedby', error.id);
    body.append(currentPosition, summary, error,
        element('p', 'rack-warning', '※ 横幅位置は各面から見た左右です。奥行きは半分／全体の簡易占有であり、現物寸法・棚板・金具・ケーブル・放熱等の物理的な干渉は保証しません。'));
    const legacyNotice = element('p', 'rack-warning rack-mount-legacy-notice',
        'この機器は旧形式の両面占有です。設定を保存すると選択した前面／背面へ変換します。両面の占有を維持するため奥行きの初期値は「全体」です。キャンセルでは変更しません。');
    body.appendChild(legacyNotice);
    const submit = element('button', 'btn btn-primary'); submit.type = 'submit';
    const transferConfirmation = createRackTransferConfirmation();
    const confirmation = transferConfirmation.element;
    const cancelTransfer = () => {
        pendingTransfer = null; transferConfirmation.hide(); body.hidden = false;
        update(); submit.focus();
    };
    actions.append(submit, button('キャンセル', () => pendingTransfer ? cancelTransfer() : closeMountDialog()));
    const destinationId = () => fields.view ? Number(fields.view.value) : Number(viewId);
    const current = () => dialog === overlay && Number(appState.currentViewId) === Number(originViewId) &&
        editable([destinationId(), ...(selectedMount() ? [selectedMount().view_id] : [])]);
    const readMount = () => ({
        view_id: destinationId(), face: fields.face.value, start_u: Number(fields.start.value), height_u: Number(fields.height.value),
        width_slot: rackDisplaySlot(width.value, fields.face.value), depth: depth.value
    });
    // 確認後は表示した機器・元位置・先位置・両revisionと一致する場合だけ保存する。
    const transferSnapshot = mount => JSON.stringify({
        device: getDeviceById(selectedId) && {
            id: Number(selectedId), name: getDeviceById(selectedId).name,
            revision: getDeviceById(selectedId).resource_revision
        }, source: selectedMount(), membership: (appState.rackShelfDevices || []).find(row => Number(row.device_id) === Number(selectedId)), destination: mount,
        views: [selectedMount()?.view_id, mount.view_id].map(id => {
            const view = appState.views.find(row => Number(row.id) === Number(id));
            return view && { id: view.id, name: view.name, revision: view.resource_revision };
        })
    });
    function positionError(mount) {
        const total = appState.rackSettings.find(row => Number(row.view_id) === mount.view_id)?.total_u;
        if (!total) return '搭載先のラックが存在しません。';
        if (!['front', 'rear'].includes(mount.face)) return '搭載面は前面・背面から選択してください。';
        if (!Number.isInteger(mount.start_u) || mount.start_u < 1) return '開始Uは1以上の整数で入力してください。';
        if (!Number.isInteger(mount.height_u) || mount.height_u < 1) return '占有U数は1以上の整数で入力してください。';
        const end = mount.start_u + mount.height_u - 1;
        if (end > total) return `指定範囲は${mount.start_u}〜${end}Uです。ラックの総U数（${total}U）を超えています。`;
        for (const other of [...rackMounts(mount.view_id), ...(appState.rackShelves || []).filter(row => Number(row.view_id) === mount.view_id).map(row => ({ ...row, width_slot: 'full' }))]) {
            if (!newDevice && Number(other.device_id) === Number(selectedId)) continue;
            const overlap = rackOverlap(mount, other);
            if (overlap) {
                return `${faceLabel(overlap.face)}${overlap.u}Uの${slotLabel(rackDisplaySlot(overlap.slot, overlap.face))}は使用中です（${other.name || getDeviceById(other.device_id)?.name || '搭載機器'}と重複）。`;
            }
        }
        return '';
    }
    function update() {
        const mount = readMount(), mounted = selectedMount();
        const moving = mounted && Number(mounted.view_id) !== mount.view_id;
        title.textContent = moving ? '機器をラックへ移設' : mounted ? 'ラック搭載位置を変更' : '機器をラックへ搭載';
        submit.textContent = pendingTransfer ? '移設を確定' : moving ? 'ラックへ移設' : mounted ? '搭載位置を変更' : 'ラックへ搭載';
        currentPosition.hidden = !mounted;
        currentPosition.textContent = mounted ? `現在：${rackName(mounted.view_id)} / ${mountText(mounted)}` : '';
        legacyNotice.hidden = mounted?.face !== 'both';
        const failure = positionError(mount);
        summary.textContent = failure ? '搭載位置を確認してください。'
            : `${mounted ? (moving ? '移設先' : '変更先（同じラック内）') : '搭載位置'}：${rackName(mount.view_id)} / ${mountText(mount)}`;
        error.textContent = failure || (!newDevice && !getDeviceById(selectedId) ? '候補から機器を選択してください。' : '');
        submit.disabled = submitting || !!failure || (!newDevice && !getDeviceById(selectedId));
    }
    let previousFace = fields.face.value;
    fields.face.addEventListener('change', () => {
        // 面変更でも物理的な左右位置を維持する。保存値は常に前面基準。
        width.value = rackDisplaySlot(rackDisplaySlot(width.value, previousFace), fields.face.value);
        previousFace = fields.face.value;
        update();
    });
    for (const node of [fields.view, width, depth, fields.start, fields.height].filter(Boolean)) {
        node.addEventListener('input', update); node.addEventListener('change', update);
    }
    form.addEventListener('submit', async event => {
        event.preventDefault(); hideCandidates();
        if (submitting || !current()) {
            if (pendingTransfer) cancelTransfer();
            error.textContent = 'ラックまたは保存状態が変わりました。搭載位置を選び直してください。'; return;
        }
        update();
        if (submit.disabled) { if (pendingTransfer) cancelTransfer(); return; }
        const mount = readMount();
        if (newDevice) {
            submitting = true; submit.disabled = true;
            try {
                const { addDevice } = await import('../ui/toolbar.js');
                if (!current()) return;
                const deviceType = type.value;
                const isCurrent = () => current() && newDevice && deviceType === type.value &&
                    Object.entries(mount).every(([key, value]) => readMount()[key] === value);
                const device = await addDevice(deviceType, { rackMount: mount, isCurrent });
                if (device) {
                    if (dialog === overlay) closeMountDialog();
                    document.getElementById('p-name')?.focus();
                } else if (dialog === overlay) error.textContent = '搭載位置・保存状態を確認してください。';
            } finally {
                submitting = false;
                if (dialog === overlay) submit.disabled = !!positionError(readMount()) || !current();
            }
            return;
        }
        mount.device_id = Number(selectedId);
        if (pendingTransfer && pendingTransfer !== transferSnapshot(mount)) {
            cancelTransfer();
            error.textContent = '確認中に機器・搭載位置・ラックが変わりました。移設条件を確認し直してください。';
            return;
        }
        try {
            validateRackLayout({ ...appState, rackMounts: [...appState.rackMounts.filter(row => Number(row.device_id) !== mount.device_id), mount],
                rackShelfDevices: (appState.rackShelfDevices || []).filter(row => Number(row.device_id) !== mount.device_id) });
        } catch (failure) { error.textContent = failure.message; return; }
        const source = selectedMount();
        if (source && (source.shelf || Number(source.view_id) !== mount.view_id) && !pendingTransfer) {
            pendingTransfer = transferSnapshot(mount);
            transferConfirmation.show({
                name: getDeviceById(selectedId).name,
                from: { rack: rackName(source.view_id), detail: source.shelf ? shelfLocation(source) : mountText(source) },
                to: { rack: rackName(mount.view_id), detail: mountText(mount) }
            });
            body.hidden = true;
            submit.textContent = '移設を確定';
            actions.querySelector('button[type="button"]')?.focus();
            return;
        }
        if (saveRackMount(mount)) closeMountDialog();
        else error.textContent = '保存状態・権限を確認し、競合がある場合はラックを再読込してください。';
    });
    form.append(body, confirmation, actions); section.append(title, form);
    overlay.appendChild(section); document.body.appendChild(overlay); dialog = overlay; update();
    registerModalOpen('rack-mount', overlay, deviceId == null ? '#rack-mount-search' : '#rack-mount-view', {
        onClose: () => { if (!candidates.hidden) hideCandidates(); else if (pendingTransfer) cancelTransfer(); else closeMountDialog(); }
    });
}

export function renderRackPanel(device) {
    const oldSection = document.getElementById('rack-position-section');
    const expanded = oldSection?.open ?? true;
    oldSection?.remove();
    const mount = appState.rackMounts.find(row => Number(row.device_id) === Number(device.id));
    const shelf = shelfForDevice(device.id);
    if (shelf) {
        const panel = document.getElementById('panel'); if (!panel) return;
        const section = element('details', 'panel-group rack-position-section'); section.id = 'rack-position-section'; section.open = expanded;
        section.appendChild(element('summary', 'panel-group-summary', '棚板への所属'));
        const body = element('div', 'panel-group-body'); body.appendChild(element('p', '', shelfLocation(shelf)));
        body.appendChild(button('棚板の詳細', () => showShelfPanel(shelf.id)));
        if (isCurrentUserAdmin()) body.appendChild(button('直付けへ変更・移設', () => openRackMountDialog({ viewId: shelf.view_id, deviceId: device.id }), !editable([shelf.view_id])));
        section.appendChild(body); panel.querySelector('.panel-actions')?.insertAdjacentElement('beforebegin', section); return;
    }
    if (!mount) return;
    const panel = document.getElementById('panel'); if (!panel) return;
    const section = element('details', 'panel-group rack-position-section'); section.id = 'rack-position-section';
    section.open = expanded;
    const summary = element('summary', 'panel-group-summary');
    summary.appendChild(element('span', 'panel-group-title', 'ラック搭載位置'));
    const view = appState.views.find(row => Number(row.id) === Number(mount.view_id));
    const uRangeText = mount.height_u === 1 ? `${mount.start_u}U` : `${mount.start_u}〜${mount.start_u + mount.height_u - 1}U`;
    const rackName = view?.name || 'ラック';
    const summaryText = `${rackName} / ${uRangeText}`;
    const position = element('span', 'panel-group-summary-text', summaryText);
    position.title = `${rackName} / ${faceLabel(mount.face)} / ${uRangeText} / ${slotLabel(rackDisplaySlot(mount.width_slot, mount.face))} / 奥行き：${depthLabel(mount)}`;
    summary.appendChild(position);
    const body = element('div', 'panel-group-body');
    body.appendChild(element('p', 'rack-mount-full-position', position.title));
    if (isCurrentUserAdmin()) {
        body.append(button('搭載位置を変更・移設', () => openRackMountDialog({ viewId: mount.view_id, deviceId: device.id }), !editable([mount.view_id])),
            button('ラックから取り外し', () => {
                if (removeRackMount(device.id)) { renderRackPanel(device); eventBus.emit('rack:changed'); }
            }, !editable([mount.view_id])));
    }
    section.append(summary, body);
    panel.querySelector('.panel-actions')?.insertAdjacentElement('beforebegin', section);
}

export function renderRackView() {
    const root = document.getElementById('rack-view');
    const view = getCurrentView(); const active = view?.view_type === 'rack';
    if (appState.world) appState.world.hidden = active;
    if (!root) return active;
    root.hidden = !active;
    appState.canvas?.classList.toggle('rack-active', active);
    cancelRange?.(); cancelMountDrag?.();
    if (dialog && (!active || Number(appState.currentViewId) !== Number(dialogOriginViewId) || !editable([view.id]))) closeMountDialog();
    if (!active) return false;
    root.setAttribute('aria-label', view.name);
    let content = document.getElementById('rack-content');
    if (!content) {
        content = element('div', 'rack-content'); content.id = 'rack-content';
        const surface = element('div', 'rack-surface'); surface.id = 'rack-surface';
        const notes = element('section', 'rack-notes-area'); notes.id = 'rack-notes-area';
        notes.setAttribute('aria-label', 'ラックの注釈');
        notes.appendChild(element('h3', 'rack-notes-heading', 'メモ'));
        content.append(surface, notes); root.appendChild(content);
        if (typeof ResizeObserver !== 'undefined') {
            new ResizeObserver(entries => {
                notes.style.height = `${entries[0].borderBoxSize?.[0]?.blockSize || entries[0].contentRect.height}px`;
            }).observe(surface);
        }
    }
    const surface = document.getElementById('rack-surface');
    surface.replaceChildren();
    const settings = appState.rackSettings.find(row => Number(row.view_id) === Number(view.id));
    if (!settings) { surface.appendChild(element('p', 'form-error', 'ラック設定を読み込めません。最新データを再読込してください。')); return true; }
    const mounts = rackMounts(view.id);
    const shelves = (appState.rackShelves || []).filter(row => Number(row.view_id) === Number(view.id));
    const occupancy = [...mounts, ...shelves.map(row => ({ ...row, width_slot: 'full' }))];
    let header = document.getElementById('rack-header');
    if (!header) {
        header = element('header', 'rack-header');
        header.id = 'rack-header';
        content.insertAdjacentElement('beforebegin', header);
    }
    header.replaceChildren();
    const locationText = [view.facility, view.floor, settings.location].filter(Boolean).join(' / ');
    if (locationText) header.appendChild(element('p', '', locationText));
    if (hasResourceConflict('views', view.id)) header.appendChild(button('このラックを再読込', () => eventBus.emit('rack:reload', view.id)));
    renderFloorRackReturn();
    const status = document.getElementById('rack-range-summary');
    const mountButton = document.getElementById('rack-range-mount-btn');
    const cancelButton = document.getElementById('rack-range-cancel-btn');
    for (const [control, handler] of [[mountButton, () => finishRange?.()], [cancelButton, () => { cancelRange?.(); setShelfAdding(false); }]]) {
        if (control && !initializedRangeButtons.has(control)) {
            control.addEventListener('click', handler); initializedRangeButtons.add(control);
        }
    }
    const cells = [];
    const clear = () => {
        rangeSelection = null; hideCanvasContextToolbar('rack-range');
        for (const cell of cells) { cell.classList.remove('rack-range-selected'); cell.setAttribute('aria-pressed', 'false'); }
    };
    cancelRange = clear;
    const validRange = selection => {
        if (!selection || Number(getCurrentView()?.id) !== Number(view.id) || !editable([view.id])) return false;
        const low = Math.min(selection.start, selection.end), high = Math.max(selection.start, selection.end);
        return !occupancy.some(row => rackOverlap(row, {
            view_id: view.id, face: selection.face, width_slot: isShelfAdding() ? 'full' : selection.slot,
            start_u: low, height_u: high - low + 1, depth: 'half'
        }));
    };
    const paint = () => {
        const selection = rangeSelection;
        if (!selection) return;
        for (const cell of cells) {
            const selected = cell.dataset.face === selection.face && (selection.slot === 'full' || cell.dataset.slot === selection.slot) &&
                Number(cell.dataset.u) >= Math.min(selection.start, selection.end) && Number(cell.dataset.u) <= Math.max(selection.start, selection.end);
            cell.classList.toggle('rack-range-selected', selected); cell.setAttribute('aria-pressed', String(selected));
        }
        const focus = document.activeElement;
        showCanvasContextToolbar('rack-range', clear);
        if (focus?.closest?.('.rack-grid')) focus.focus({ preventScroll: true });
        mountButton.disabled = !validRange(selection);
        status.textContent = `${faceLabel(selection.face)} ${Math.min(selection.start, selection.end)}〜${Math.max(selection.start, selection.end)}U ${slotLabel(rackDisplaySlot(selection.slot, selection.face))}`;
    };
    const finish = () => {
        const selection = rangeSelection;
        if (!validRange(selection)) { clear(); return; }
        const options = { viewId: view.id, face: selection.face, startU: Math.min(selection.start, selection.end),
            heightU: Math.abs(selection.start - selection.end) + 1, widthSlot: selection.slot };
        clear(); if (isShelfAdding()) openShelfDialog(options); else openRackMountDialog(options);
    };
    finishRange = finish;
    const layout = element('div', 'rack-layout');
    layout.style.setProperty('--rack-u', String(settings.total_u));
    for (const face of ['front', 'rear']) {
        const side = element('section', `rack-side rack-${face}`);
        side.appendChild(element('h3', '', faceLabel(face)));
        const usage = rackUsage(settings.total_u, mounts, face, shelves, appState.rackShelfDevices || []);
        side.appendChild(element('p', 'rack-usage', `空きU ${usage.empty} / 半空きU ${usage.half} / 使用中U ${usage.used}`));
        const grid = element('div', 'rack-grid'); grid.setAttribute('aria-label', `${faceLabel(face)}の搭載位置`);
        for (let u = settings.total_u; u >= 1; u--) {
            for (const displaySlot of ['left', 'right']) {
                const physicalSlot = rackDisplaySlot(displaySlot, face);
                const occupied = occupancy.find(row => rackOccupiedFaces(row).includes(face) && u >= row.start_u && u < row.start_u + row.height_u &&
                    (row.width_slot === 'full' || row.width_slot === physicalSlot));
                const blocked = occupied && !rackFaces(occupied.face).includes(face);
                const blockedText = blocked ? `反対面の${occupied.device_id === undefined ? '棚板' : '機器'}により占有（${occupied.name || getDeviceById(occupied.device_id)?.name || '搭載機器'}）` : '';
                const cell = element('button', `rack-empty${blocked ? ' rack-depth-blocked' : ''}`, blocked ? `${u}U ${slotLabel(displaySlot)} ${blockedText}` : `${u}U ${slotLabel(displaySlot)}`); cell.type = 'button';
                cell.style.gridRow = String(settings.total_u - u + 1); cell.style.gridColumn = displaySlot === 'left' ? '1' : '2';
                cell.disabled = Boolean(occupied) || !editable([view.id]);
                cell.setAttribute('aria-label', `${faceLabel(face)} ${u}U ${slotLabel(displaySlot)}${blocked ? ` ${blockedText}` : occupied ? ' 使用中' : ' 空き'}`);
                if (blocked) cell.title = blockedText;
                cell.dataset.u = String(u); cell.dataset.face = face; cell.dataset.slot = physicalSlot;
                cell.setAttribute('aria-pressed', 'false');
                const begin = mode => { rangeSelection = { face, startSlot: physicalSlot, slot: isShelfAdding() ? 'full' : physicalSlot, start: u, end: u, mode }; paint(); };
                const extend = () => {
                    if (!rangeSelection || rangeSelection.face !== face) return false;
                    const next = { ...rangeSelection, end: u, slot: isShelfAdding() || rangeSelection.startSlot !== physicalSlot ? 'full' : physicalSlot };
                    rangeSelection = next; paint(); return validRange(next);
                };
                let pointerMode = null;
                let suppressClick = false;
                cell.addEventListener('pointerdown', event => {
                    if (!cell.isConnected || cell.disabled || event.button > 0) return;
                    pointerMode = event.pointerType || 'mouse';
                    if (pointerMode === 'mouse') { event.preventDefault(); begin('mouse'); }
                });
                cell.addEventListener('pointerenter', () => { if (rangeSelection?.mode === 'mouse') extend(); });
                cell.addEventListener('pointerup', event => {
                    if (!cell.isConnected || cell.disabled) { clear(); return; }
                    if ((event.pointerType || pointerMode) === 'mouse' && rangeSelection?.mode === 'mouse') {
                        suppressClick = true;
                        if (!extend()) { clear(); return; }
                        if (rangeSelection.start === u && (isShelfAdding() || rangeSelection.slot !== 'full')) finish();
                        else rangeSelection.mode = 'selected';
                    }
                });
                cell.addEventListener('pointercancel', clear);
                cell.addEventListener('keydown', event => {
                    if (!cell.isConnected || cell.disabled || !editable([view.id])) return;
                    if (event.key === 'Escape') { event.preventDefault(); clear(); return; }
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault(); suppressClick = true;
                    if (rangeSelection?.mode === 'keyboard' && extend()) finish(); else begin('keyboard');
                });
                cell.addEventListener('click', () => {
                    if (suppressClick) { suppressClick = false; return; }
                    if (!cell.isConnected || cell.disabled || !editable([view.id]) || Number(getCurrentView()?.id) !== Number(view.id)) return;
                    if (pointerMode === 'touch' || pointerMode === 'pen') {
                        if (rangeSelection?.mode === 'touch' && extend()) finish(); else begin('touch');
                    } else { begin('click'); finish(); }
                });
                cells.push(cell);
                grid.appendChild(cell);
            }
        }
        for (const shelf of shelves.filter(row => row.face === face)) {
            const block = element('button', 'rack-device rack-shelf'); block.type = 'button';
            block.dataset.shelfId = String(shelf.id);
            block.style.gridRow = `${settings.total_u - shelf.start_u - shelf.height_u + 2} / span ${shelf.height_u}`;
            block.style.gridColumn = '1 / span 2';
            const row = element('div', 'rack-device-header');
            const icon = element('img', 'rack-device-icon'); icon.src = 'assets/icons/toolbar/shelf.svg'; icon.alt = '';
            row.append(icon, element('span', 'rack-device-name', shelf.name), element('span', '', `${shelfMembers(shelf.id).length}台`)); block.appendChild(row);
            block.title = `${shelfLocation(shelf)} / 奥行き：${depthLabel(shelf)}`;
            block.addEventListener('click', () => showShelfPanel(shelf.id)); grid.appendChild(block);
        }
        for (const mount of mounts.filter(row => rackFaces(row.face).includes(face))) {
            const device = getDeviceById(mount.device_id); if (!device) continue;
            const block = element('button', 'rack-device'); block.type = 'button';
            const definition = DEVICE_TYPES[device.type] || DEVICE_TYPES.other;
            block.style.setProperty('--rack-device-color', definition.color);
            const slot = rackDisplaySlot(mount.width_slot, face);
            const isFull = slot === 'full';
            const hasIp = device.ip && String(device.ip).trim();
            const headerRow = element('div', 'rack-device-header');
            const icon = element('img', 'rack-device-icon'); icon.src = definition.icon; icon.alt = definition.label;
            const nameSpan = element('span', 'rack-device-name', device.name || '(名称未設定)');
            headerRow.append(icon, nameSpan);
            if (isFull && hasIp) {
                headerRow.appendChild(element('span', 'rack-device-ip-inline', `/ ${String(device.ip).trim()}`));
            }
            if (device.status === 'green' || device.status === 'red') {
                const statusLabel = device.status === 'green' ? 'OK' : 'NG';
                headerRow.appendChild(element('span', `rack-device-status-badge status-${device.status}`, statusLabel));
            }
            block.appendChild(headerRow);
            block.dataset.deviceType = DEVICE_TYPES[device.type] ? device.type : 'other';
            block.dataset.deviceId = String(device.id);
            const ipInfo = device.ip ? ` / ${device.ip}` : '';
            const statusText = device.status === 'green' ? 'OK' : device.status === 'red' ? 'NG' : '';
            const statusPart = statusText ? ` / ${statusText}` : '';
            block.title = `${device.name || '(名称未設定)'}${ipInfo}${statusPart} — ${faceLabel(mount.face)} / ${mount.start_u}〜${mount.start_u + mount.height_u - 1}U / ${slotLabel(rackDisplaySlot(mount.width_slot, face))} / 奥行き：${depthLabel(mount)}`;
            block.style.gridRow = `${settings.total_u - mount.start_u - mount.height_u + 2} / span ${mount.height_u}`;
            /* slot already computed above */
            block.style.gridColumn = slot === 'full' ? '1 / span 2' : slot === 'left' ? '1' : '2';
            block.setAttribute('aria-pressed', String(Number(appState.editingDeviceId) === Number(device.id)));
            let drag = null, suppressClick = false;
            const resetDrag = () => {
                if (drag && block.hasPointerCapture?.(drag.pointerId)) block.releasePointerCapture(drag.pointerId);
                drag = null; block.classList.remove('rack-device-dragging', 'rack-device-invalid');
                block.style.gridRow = `${settings.total_u - mount.start_u - mount.height_u + 2} / span ${mount.height_u}`;
                const origSlot = rackDisplaySlot(mount.width_slot, face);
                block.style.gridColumn = origSlot === 'full' ? '1 / span 2' : origSlot === 'left' ? '1' : '2';
            };
            const isCurrent = () => block.isConnected && editable([view.id]) && Number(appState.currentViewId) === Number(view.id) &&
                drag?.revision === view.resource_revision && appState.rackMounts.includes(mount);
            const preview = event => {
                if (!drag || event.pointerId !== drag.pointerId) return;
                if (!isCurrent()) { resetDrag(); return; }
                const clientX = Number.isFinite(event.clientX) ? event.clientX : 0;
                const clientY = Number.isFinite(event.clientY) ? event.clientY : 0;
                const dy = clientY - drag.startY;
                const dx = clientX - drag.startX;
                if (!drag.moved && Math.hypot(dx, dy) < 5) return;
                event.preventDefault(); drag.moved = true;
                const rowHeight = drag.gridRect.height / drag.totalU;
                drag.curStartU = drag.origStartU - Math.round(dy / rowHeight);
                let targetPhysicalSlot = drag.origSlot;
                if (drag.origSlot !== 'full') {
                    const relX = clientX - (drag.gridRect.left || 0);
                    const isLeft = relX < (drag.gridRect.width / 2);
                    targetPhysicalSlot = rackDisplaySlot(isLeft ? 'left' : 'right', face);
                }
                drag.curPhysicalSlot = targetPhysicalSlot;
                const candidate = { ...mount, start_u: drag.curStartU, width_slot: targetPhysicalSlot };
                try {
                    validateRackLayout({ ...appState, rackMounts: [...appState.rackMounts.filter(row => row !== mount), candidate] });
                    drag.valid = true;
                } catch { drag.valid = false; }
                block.classList.add('rack-device-dragging');
                block.classList.toggle('rack-device-invalid', !drag.valid);
                const visibleStart = Math.max(1, Math.min(settings.total_u - mount.height_u + 1, drag.curStartU));
                block.style.gridRow = `${settings.total_u - visibleStart - mount.height_u + 2} / span ${mount.height_u}`;
                const curDisplaySlot = rackDisplaySlot(targetPhysicalSlot, face);
                block.style.gridColumn = curDisplaySlot === 'full' ? '1 / span 2' : (curDisplaySlot === 'left' ? '1' : '2');
            };
            block.addEventListener('pointerdown', event => {
                if (event.button > 0 || !editable([view.id]) || !block.isConnected) return;
                cancelRange?.(); cancelMountDrag?.();
                const gridRect = grid.getBoundingClientRect() || { height: settings.total_u * 40, width: 240, left: 0 };
                const startX = Number.isFinite(event.clientX) ? event.clientX : 0;
                const startY = Number.isFinite(event.clientY) ? event.clientY : 0;
                drag = { pointerId: event.pointerId, startX, startY, origStartU: mount.start_u, origSlot: mount.width_slot, curStartU: mount.start_u, curPhysicalSlot: mount.width_slot, revision: view.resource_revision, moved: false, valid: true, gridRect, totalU: settings.total_u };
                cancelMountDrag = resetDrag; block.setPointerCapture?.(event.pointerId);
            });
            block.addEventListener('pointermove', preview);
            block.addEventListener('pointerup', event => {
                if (!drag || event.pointerId !== drag.pointerId) return;
                const moved = drag.moved, valid = drag.valid && isCurrent(), targetU = drag.curStartU, targetSlot = drag.curPhysicalSlot;
                resetDrag();
                if (!moved) return;
                suppressClick = true; suppressCanvasClickOnce();
                setTimeout(() => { suppressClick = false; }, 200);
                if (valid && (targetU !== mount.start_u || targetSlot !== mount.width_slot)) {
                    saveRackMount({ ...mount, start_u: targetU, width_slot: targetSlot });
                }
            });
            block.addEventListener('pointercancel', resetDrag);
            block.addEventListener('click', async () => {
                if (suppressClick) { suppressClick = false; return; }
                appState.editingDeviceId = Number(device.id);
                for (const b of surface.querySelectorAll('.rack-device')) {
                    b.setAttribute('aria-pressed', String(Number(b.dataset.deviceId) === Number(device.id)));
                }
                if (await openPanel(device)) {
                    renderRackPanel(device);
                }
            });
            block.addEventListener('dblclick', () => {
                if (suppressClick) { suppressClick = false; return; }
                if (!isCurrentUserAdmin()) return;
                openRackMountDialog({ viewId: mount.view_id, deviceId: device.id });
            });
            grid.appendChild(block);
        }
        const numbers = element('div', 'rack-number-grid'); numbers.setAttribute('aria-label', `${faceLabel(face)} U番号（最下段1U）`);
        for (let u = settings.total_u; u >= 1; u--) numbers.appendChild(element('span', '', String(u)));
        const body = element('div', 'rack-side-body'); body.append(numbers, grid);
        side.appendChild(body); layout.appendChild(side);
    }
    surface.appendChild(layout);
    const notes = document.getElementById('rack-notes-area');
    if (typeof ResizeObserver === 'undefined') notes.style.height = `${settings.total_u * 40 + 88}px`;
    return true;
}

if (typeof document !== 'undefined') {
    document.addEventListener('pointerup', () => { if (rangeSelection?.mode === 'mouse') cancelRange?.(); });
    document.addEventListener('pointercancel', () => cancelRange?.());
    document.addEventListener('keydown', event => { if (event.key === 'Escape') { cancelRange?.(); cancelMountDrag?.(); } });
}
eventBus.on('canvas:view-transformed', () => cancelMountDrag?.());
eventBus.on('rack:changed', () => { closeMountDialog(); renderRackView(); if (appState.editingDeviceId != null) { const device = getDeviceById(appState.editingDeviceId); if (device) renderRackPanel(device); } });
eventBus.on('save-state:changed', () => {
    if (typeof document === 'undefined') return;
    if (!editable([appState.currentViewId])) { cancelRange?.(); closeMountDialog(); }
    if (getCurrentView()?.view_type === 'rack') renderRackView();
    const device = getDeviceById(appState.editingDeviceId);
    if (device) renderRackPanel(device);
});
eventBus.on('resources:ids-remapped', () => { cancelRange?.(); closeMountDialog(); });
eventBus.on('device-panel:opened', device => renderRackPanel(device));
eventBus.on('rack:mount-device', ({ viewId, deviceId }) => openRackMountDialog({ viewId, deviceId }));
export async function showRackDevice({ viewId, deviceId }) {
    const { switchView } = await import('../modals/view-manager-modal.js');
    if (!await switchView(viewId) || Number(appState.currentViewId) !== Number(viewId)) return false;
    const device = getDeviceById(deviceId);
    const shelf = shelfForDevice(deviceId);
    const mount = appState.rackMounts.find(row => Number(row.device_id) === Number(deviceId) &&
        Number(row.view_id) === Number(viewId)) || (Number(shelf?.view_id) === Number(viewId) ? shelf : null);
    if (!mount) return false;
    if (!device || !await openPanel(device)) return false;
    cancelRange?.();
    renderRackPanel(device);
    renderRackView();
    const block = shelf ? document.getElementById('rack-view')?.querySelector(`[data-shelf-id="${Number(shelf.id)}"]`) :
        document.getElementById('rack-view')?.querySelector(`[data-device-id="${Number(deviceId)}"]`);
    block?.focus({ preventScroll: true });
    block?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return true;
}
eventBus.on('rack:show-device', showRackDevice);
