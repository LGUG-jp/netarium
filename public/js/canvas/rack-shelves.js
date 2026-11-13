import { appState, getCurrentView, getDeviceById, allocateLocalId } from '../core/state.js';
import { validateRackLayout, toSaveRackShelf } from '../core/rack-layout.js';
import { DEVICE_TYPES } from '../core/constants.js';
import { isCurrentUserAdmin, requireAdminUiAction } from '../ui/access-control.js';
import { hasResourceConflict, isSaveInFlight, scheduleSave } from '../core/save-queue.js';
import { markDirty } from '../ui/status-bar.js';
import { showToast } from '../ui/toast.js';
import { openPanel, closePanel, closeLinkPanel } from '../ui/property-panel.js';
import { registerModalOpen, registerModalClose } from '../core/modal-focus.js';
import { createDeviceTypePicker, closeDeviceTypePicker } from '../ui/device-type-picker.js';
import { eventBus } from '../core/event-bus.js';
import { createRackTransferConfirmation } from '../ui/rack-transfer-confirmation.js';
import { validateDeviceValues } from '../core/device-validation.js';
import { switchView } from '../modals/view-manager-modal.js';
import { createRackDeviceInput } from '../ui/rack-device-input.js';
import { mappedResourceId } from '../core/resource-save.js';

let adding = false, selectedShelfId = null, dialog = null, dialogViewId = null, deviceDialog = null, deviceDialogViewId = null, activeShelfDialog = null;
const eq = (a, b) => Number(a) === Number(b);
const shelves = () => appState.rackShelves || [];
const members = () => appState.rackShelfDevices || [];
const shelfById = id => shelves().find(row => eq(row.id, id));
export const shelfMembers = id => members().filter(row => eq(row.shelf_id, id)).sort((a, b) => a.sort_order - b.sort_order);
export function shelfForDevice(id) { return shelfById(members().find(row => eq(row.device_id, id))?.shelf_id); }
export function shelfEditable(ids = [appState.currentViewId]) {
    return isCurrentUserAdmin() && !appState.authExpired && !appState.isPinging && !isSaveInFlight() &&
        appState.appStatus.state !== 'unconfirmed' && !ids.some(id => hasResourceConflict('views', id));
}
const rackName = id => appState.views.find(row => eq(row.id, id))?.name || 'ラック';
export function shelfLocation(shelf) {
    return `${rackName(shelf.view_id)} / 棚板「${shelf.name}」 / ${shelf.face === 'rear' ? '背面' : '前面'} ${shelf.start_u}〜${shelf.start_u + shelf.height_u - 1}U`;
}
export function deviceRackLocation(id) {
    const shelf = shelfForDevice(id);
    if (shelf) return shelfLocation(shelf);
    const mount = appState.rackMounts.find(row => eq(row.device_id, id));
    return mount ? `${rackName(mount.view_id)} / 直付け / ${{ front: '前面', rear: '背面', both: '両面占有（旧形式）' }[mount.face]} ${mount.start_u}〜${mount.start_u + mount.height_u - 1}U` : 'ラック未所属';
}
function el(tag, className = '', text) {
    const node = document.createElement(tag); node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}
function btn(text, handler, disabled = false) {
    const node = el('button', 'btn btn-secondary btn-sm', text); node.type = 'button'; node.disabled = disabled;
    node.addEventListener('click', handler); return node;
}
function commit(changes) {
    try { validateRackLayout({ ...appState, ...changes }); }
    catch (error) { showToast(error.message, 'warning'); return false; }
    Object.assign(appState, changes); markDirty(); scheduleSave({ immediate: true, silent: true }); eventBus.emit('rack:changed'); return true;
}
function assignmentSnapshot(deviceId, shelfId) {
    return JSON.stringify([getDeviceById(deviceId), shelfById(shelfId), appState.views, appState.rackMounts, shelves(), members()]);
}
export function assignDeviceToShelf(deviceId, shelfId, confirmation = null) {
    if (!requireAdminUiAction()) return false;
    const shelf = shelfById(shelfId), source = shelfForDevice(deviceId);
    const mount = appState.rackMounts.find(row => eq(row.device_id, deviceId));
    const ids = [shelf?.view_id, source?.view_id, mount?.view_id].filter(id => id != null);
    if (!shelf || !getDeviceById(deviceId) || !shelfEditable(ids)) return false;
    if (source && eq(source.id, shelf.id)) return true;
    const snapshot = assignmentSnapshot(deviceId, shelfId);
    if ((source || mount) && confirmation?.snapshot !== snapshot) return false;
    if (snapshot !== assignmentSnapshot(deviceId, shelfId) || !shelfEditable(ids)) return false;
    return commit({ rackMounts: appState.rackMounts.filter(row => !eq(row.device_id, deviceId)), rackShelfDevices: [
        ...members().filter(row => !eq(row.device_id, deviceId)),
        { device_id: Number(deviceId), shelf_id: Number(shelfId), sort_order: Math.max(-1, ...shelfMembers(shelfId).map(row => row.sort_order)) + 1 }
    ] });
}
export function removeShelfDevice(deviceId) {
    const shelf = shelfForDevice(deviceId);
    if (!requireAdminUiAction() || !shelf || !shelfEditable([shelf.view_id])) return false;
    return commit({ rackShelfDevices: members().filter(row => !eq(row.device_id, deviceId)) });
}
export function reorderShelfDevice(deviceId, direction) {
    const shelf = shelfForDevice(deviceId);
    if (!requireAdminUiAction() || !shelf || !shelfEditable([shelf.view_id])) return false;
    const rows = shelfMembers(shelf.id), index = rows.findIndex(row => eq(row.device_id, deviceId)), target = index + direction;
    if (![-1, 1].includes(direction) || target < 0 || target >= rows.length) return false;
    [rows[index], rows[target]] = [rows[target], rows[index]];
    const orders = new Map(rows.map((row, order) => [Number(row.device_id), order]));
    return commit({ rackShelfDevices: members().map(row => eq(row.shelf_id, shelf.id) ? { ...row, sort_order: orders.get(Number(row.device_id)) } : row) });
}
export function deleteShelf(id) {
    const shelf = shelfById(id);
    if (!requireAdminUiAction() || !shelf || !shelfEditable([shelf.view_id])) return false;
    if (shelfMembers(id).length) { showToast('機器が残っている棚板は削除できません。先に機器を取り外してください', 'warning'); return false; }
    if (!window.confirm(`棚板「${shelf.name}」を削除しますか？`)) return false;
    if (shelfById(id) !== shelf || !shelfEditable([shelf.view_id]) || shelfMembers(id).length) return false;
    closeShelfPanel(); return commit({ rackShelves: shelves().filter(row => !eq(row.id, id)) });
}
export function isShelfAdding() { return adding; }
export function setShelfAdding(active) {
    if (active) closeShelfDialog();
    adding = Boolean(active) && getCurrentView()?.view_type === 'rack' && shelfEditable();
    const control = document.getElementById('palette-shelf-btn');
    control?.classList.toggle('active', adding); control?.setAttribute('aria-pressed', String(adding));
    const select = document.getElementById('palette-view-btn');
    select?.classList.toggle('active', !adding); select?.setAttribute('aria-pressed', String(!adding));
    const mount = document.getElementById('rack-range-mount-btn'); if (mount) mount.textContent = adding ? '棚板を追加' : '機器を搭載';
}
function closeShelfDialog({ confirmIfDirty = false } = {}) {
    if (confirmIfDirty && activeShelfDialog && !activeShelfDialog.waitingCreation && activeShelfDialog.isDirty?.()) {
        if (typeof window.confirm === 'function' && !window.confirm('棚板の変更が保存されていません。破棄して閉じますか？')) return;
    }
    closeDeviceTypePicker();
    activeShelfDialog?.hideCandidates?.();
    activeShelfDialog = null;
    dialog?.remove(); dialog = null; dialogViewId = null;
    deviceDialog?.remove(); deviceDialog = null; deviceDialogViewId = null;
    registerModalClose('rack-shelf'); registerModalClose('rack-shelf-device');
    setShelfAdding(false);
}
export function openShelfDialog({ viewId, face = 'front', startU = 1, heightU = 1, shelfId = null }) {
    if (!requireAdminUiAction() || !shelfEditable([viewId])) return;
    closeShelfDialog();
    const origin = appState.currentViewId;

    let currentShelfId = shelfId != null ? Number(shelfId) : null;
    let previous = currentShelfId != null ? shelfById(currentShelfId) : null;
    let waitingCreation = currentShelfId == null;
    let isSavingShelf = false;
    let isAddingDevice = false;
    let pendingShelfTransfer = null;
    let pendingDeviceTransfer = null;
    const shelfSnapshot = () => JSON.stringify([shelfById(currentShelfId), shelves(), members(), appState.views, appState.rackMounts]);
    let initialSnapshot = shelfSnapshot();
    let membershipSnapshotChanged = false;
    const fields = {};
    const overlay = el('div', 'view-manager-overlay rack-mount-overlay rack-shelf-overlay rack-shelf-device-overlay');
    const section = el('section', 'view-manager-dialog rack-mount-dialog rack-mount-two-pane');
    section.setAttribute('role', 'dialog'); section.setAttribute('aria-modal', 'true'); section.setAttribute('aria-labelledby', 'rack-shelf-title');
    const title = el('h2', '', previous ? '棚板の設定' : '棚板を追加'); title.id = 'rack-shelf-title';
    const heading = el('div', 'modal-header-heading rack-mount-heading');
    const target = el('p', 'modal-header-target', `搭載先：${rackName(previous?.view_id || viewId)}`);
    heading.append(title, target);
    const form = el('form', 'rack-mount-form rack-shelf-form rack-shelf-device-form');
    const body = el('div', `rack-mount-body rack-mount-panes${waitingCreation ? ' is-new-shelf' : ''}`);

    // --- 左ペイン: 機器の選択・登録、搭載済み機器の一覧 ---
    const deviceArea = el('section', 'rack-mount-device-area');
    deviceArea.setAttribute('aria-label', '機器の選択・登録');

    // 1. 機器を棚板に追加エリア（上側）
    const deviceAreaFieldset = el('fieldset', 'rack-mount-position');
    deviceAreaFieldset.append(el('legend', '', '機器を棚板に追加'));
    const disabledNotice = el('p', 'rack-shelf-disabled-notice');
    deviceAreaFieldset.appendChild(disabledNotice);

    const deviceConfirmation = createRackTransferConfirmation();
    const deviceError = el('p', 'form-error rack-shelf-device-error');
    deviceError.setAttribute('role', 'alert');

    function canOperateDeviceInput() {
        return currentShelfId != null && !waitingCreation && !isSavingShelf && !isAddingDevice && !isDirty() &&
            shelfSnapshot() === initialSnapshot &&
            shelfEditable([appState.currentViewId, previous?.view_id].filter(Boolean));
    }

    const deviceInput = createRackDeviceInput({
        idPrefix: 'rack-shelf-device',
        getDevices: () => currentShelfId != null
            ? appState.devices.filter(row => !shelfMembers(currentShelfId).some(member => eq(member.device_id, row.id)))
            : [],
        searchText: device => `${device.name} ${device.ip || ''} ${device.model || ''}`,
        locationText: device => deviceRackLocation(device.id),
        canChange: () => canOperateDeviceInput(),
        onChange: () => {
            deviceError.textContent = '';
            pendingDeviceTransfer = null;
            deviceConfirmation.hide();
            addDeviceBtn.textContent = '棚板に追加';
        }
    });

    deviceAreaFieldset.append(deviceInput.element, deviceConfirmation.element, deviceError);

    const deviceActions = el('div', 'rack-shelf-device-actions');
    const addDeviceBtn = el('button', 'btn btn-primary btn-sm rack-shelf-add-device-btn', '棚板に追加');
    addDeviceBtn.type = 'button';
    deviceActions.appendChild(addDeviceBtn);
    deviceAreaFieldset.appendChild(deviceActions);
    deviceArea.appendChild(deviceAreaFieldset);

    // 2. 棚板の搭載機器一覧エリア（下側）
    const summarySection = el('div', 'rack-shelf-devices-section');
    const summaryHeader = el('div', 'rack-shelf-devices-header');
    const summaryTitle = el('span', '', '棚板の搭載機器');
    const summaryCount = el('span', 'rack-shelf-count', '0台');
    summaryHeader.append(summaryTitle, summaryCount);
    const summaryList = el('ul', 'rack-shelf-summary-list');
    summarySection.append(summaryHeader, summaryList);
    deviceArea.appendChild(summarySection);

    function renderSummaryList() {
        summaryList.replaceChildren();
        const rows = currentShelfId != null ? shelfMembers(currentShelfId) : [];
        summaryCount.textContent = `${rows.length}台`;
        if (rows.length === 0) {
            summaryList.appendChild(el('p', 'rack-shelf-summary-empty', '搭載機器はありません'));
        } else {
            for (const row of rows) {
                const dev = getDeviceById(row.device_id);
                if (!dev) continue;
                const item = el('li', 'rack-shelf-summary-item');
                const def = DEVICE_TYPES[dev.type] || DEVICE_TYPES.other;
                const ico = el('img', 'device-type-icon');
                ico.src = def.icon;
                ico.alt = '';
                const nameSpan = el('span', 'rack-shelf-summary-name', dev.name);
                const detailSpan = el('span', 'rack-shelf-summary-detail', [def.label, dev.ip].filter(Boolean).join(' / '));
                const removeBtn = el('button', 'rack-shelf-member-remove-btn', '×');
                removeBtn.type = 'button';
                removeBtn.setAttribute('aria-label', `「${dev.name}」を棚板から取り外す`);
                removeBtn.title = `「${dev.name}」を棚板から取り外す`;
                removeBtn.disabled = !canOperateDeviceInput();
                removeBtn.addEventListener('click', async () => {
                    if (!canOperateDeviceInput() || !eq(shelfForDevice(dev.id)?.id, currentShelfId)) return;
                    if (typeof window.confirm === 'function') {
                        if (!window.confirm(`「${dev.name}」を棚板から取り外しますか？`)) return;
                    }
                    if (removeShelfDevice(dev.id)) {
                        refreshMembershipSnapshot(dev.id);
                        renderSummaryList();
                        updateAllStates();
                        showToast(`機器「${dev.name}」を棚板から取り外しました`);
                    }
                });
                item.append(ico, nameSpan, detailSpan, removeBtn);
                summaryList.appendChild(item);
            }
        }
    }

    // --- 右ペイン: 棚板名・搭載先（設置位置）の設定 ---
    const positionArea = el('section', 'rack-mount-position-area');
    positionArea.setAttribute('aria-label', '棚板の設定');

    function field(name, label, tag, value, options) {
        const group = el('div', 'rack-mount-field');
        const text = el('label', '', label);
        const input = el(tag);
        input.id = `rack-shelf-${name}`;
        text.setAttribute('for', input.id);
        for (const [val, lab] of options || []) {
            const option = el('option', '', lab);
            option.value = val;
            input.appendChild(option);
        }
        input.value = String(value);
        fields[name] = input;
        group.append(text, input);
        return { group, input };
    }

    const nameField = field('name', '棚板名', 'input', previous?.name || '棚板');
    nameField.input.required = true;
    nameField.input.maxLength = 100;

    let rackField = null;
    let rackContainer = null;
    if (previous) {
        rackField = field('view', '搭載先ラック', 'select', previous.view_id,
            appState.views.filter(row => row.view_type === 'rack').map(row => [String(row.id), row.name]));
        rackContainer = rackField.group;
    } else {
        rackContainer = el('div', 'rack-mount-field');
        rackContainer.append(
            el('span', 'rack-mount-fixed-label', '搭載先ラック'),
            el('strong', 'rack-transfer-rack', rackName(viewId))
        );
    }

    const positionFieldset = el('fieldset', 'rack-mount-position');
    const units = el('div', 'rack-mount-position-grid');
    const dimensions = el('div', 'rack-mount-position-grid');
    positionFieldset.append(el('legend', '', '棚板の設置位置'), nameField.group, rackContainer, units, dimensions);

    const startField = field('start', '開始U（最下段）', 'input', previous?.start_u || startU);
    startField.input.type = 'number'; startField.input.min = '1'; startField.input.max = '60'; startField.input.step = '1'; startField.input.required = true;
    const heightField = field('height', '占有U数', 'input', previous?.height_u || heightU);
    heightField.input.type = 'number'; heightField.input.min = '1'; heightField.input.max = '60'; heightField.input.step = '1'; heightField.input.required = true;
    units.append(startField.group, heightField.group);

    const faceField = field('face', '搭載面', 'select', previous?.face || face, [['front', '前面'], ['rear', '背面']]);
    const depthField = field('depth', '奥行き', 'select', previous?.depth || 'half', [['half', '半分'], ['full', '全体']]);
    dimensions.append(faceField.group, depthField.group);

    const shelfWarning = el('p', 'rack-warning', '棚板は全幅です。棚板上の機器は追加のUを占有しません。奥行きは簡易占有であり、現物の干渉・耐荷重・放熱は保証しません。');
    const shelfError = el('p', 'form-error');
    shelfError.setAttribute('role', 'alert');
    shelfError.id = 'rack-shelf-error';

    const shelfConfirmation = createRackTransferConfirmation();
    const shelfActions = el('div', 'rack-shelf-save-actions');
    const shelfSubmit = el('button', 'btn btn-primary rack-shelf-save-btn', previous ? '設定を保存' : '棚板を作成');
    shelfSubmit.type = 'button';
    shelfActions.appendChild(shelfSubmit);

    positionArea.append(positionFieldset, shelfWarning, shelfError, shelfConfirmation.element, shelfActions);

    body.append(deviceArea, positionArea);

    const actions = el('div', 'rack-mount-actions');
    const closeBtn = el('button', 'btn btn-secondary btn-sm', waitingCreation ? 'キャンセル' : '閉じる');
    closeBtn.type = 'button';
    actions.appendChild(closeBtn);

    form.append(body, actions);
    section.append(heading, form);
    overlay.appendChild(section);
    document.body.appendChild(overlay);
    dialog = overlay;
    dialogViewId = origin;
    deviceDialog = overlay;
    deviceDialogViewId = origin;

    function getShelfInputValues() {
        return {
            name: fields.name.value.trim(),
            view_id: rackField ? Number(fields.view.value) : Number(viewId),
            start_u: Number(fields.start.value),
            height_u: Number(fields.height.value),
            face: fields.face.value,
            depth: fields.depth.value
        };
    }

    let baselineSnapshot = previous ? JSON.stringify({
        name: previous.name,
        view_id: previous.view_id,
        start_u: previous.start_u,
        height_u: previous.height_u,
        face: previous.face,
        depth: previous.depth
    }) : null;

    function isDirty() {
        if (waitingCreation || currentShelfId == null || !fields.name) return true;
        return JSON.stringify(getShelfInputValues()) !== baselineSnapshot;
    }

    function updateAllStates() {
        const destination = rackField ? Number(fields.view.value) : Number(viewId);
        const moving = previous && !eq(previous.view_id, destination);
        title.textContent = moving ? '棚板をラックへ移設' : previous ? '棚板の設定' : '棚板を追加';
        target.textContent = moving ? 'ラックへ移設：現在 → 移設先' : `搭載先：${rackName(destination)}`;

        shelfSubmit.textContent = isSavingShelf ? '保存中...' :
            pendingShelfTransfer ? '移設を確定' : moving ? 'ラックへ移設' : previous ? '設定を保存' : '棚板を作成';
        shelfSubmit.disabled = isSavingShelf;

        closeBtn.textContent = (pendingShelfTransfer || pendingDeviceTransfer || waitingCreation) ? 'キャンセル' : '閉じる';

        body.classList.toggle('is-new-shelf', waitingCreation);

        const canAdd = canOperateDeviceInput();
        deviceInput.setDisabled(!canAdd);
        addDeviceBtn.disabled = !canAdd;
        for (const button of summaryList.querySelectorAll('.rack-shelf-member-remove-btn')) {
            button.disabled = !canAdd;
        }
        deviceArea.classList.toggle('is-disabled', !canAdd);

        if (waitingCreation || currentShelfId == null) {
            disabledNotice.hidden = false;
            disabledNotice.textContent = isSavingShelf ? '棚板を保存中...完了後に機器を追加できます。' : '棚板を作成・保存すると、機器を追加できるようになります。';
        } else if (isDirty()) {
            disabledNotice.hidden = false;
            disabledNotice.textContent = '棚板の設定が変更されています。先に「設定を保存」してください。';
        } else if (isSavingShelf) {
            disabledNotice.hidden = false;
            disabledNotice.textContent = '棚板を保存中...';
        } else if (!shelfEditable([appState.currentViewId, previous?.view_id].filter(Boolean))) {
            disabledNotice.hidden = false;
            disabledNotice.textContent = '保存中または未確認のため、機器を追加できません。';
        } else {
            disabledNotice.hidden = true;
        }
    }

    // この画面で変更した機器の所属だけを基準へ反映し、他の変更は古い条件として検出する。
    function refreshMembershipSnapshot(deviceId) {
        const snapshot = JSON.parse(initialSnapshot);
        snapshot[2] = snapshot[2].filter(row => !eq(row.device_id, deviceId));
        const member = members().find(row => eq(row.device_id, deviceId));
        if (member) snapshot[2].push({ ...member });
        snapshot[4] = snapshot[4].filter(row => !eq(row.device_id, deviceId));
        initialSnapshot = JSON.stringify(snapshot);
        membershipSnapshotChanged = true;
    }

    async function handleShelfSave() {
        shelfError.textContent = '';
        if (isSavingShelf) return;
        const destination = rackField ? Number(fields.view.value) : Number(viewId);
        const currentSnapshot = shelfSnapshot();
        if (!eq(appState.currentViewId, origin) || !shelfEditable([viewId, destination]) || (previous && currentSnapshot !== initialSnapshot)) {
            pendingShelfTransfer = null;
            shelfConfirmation.hide();
            shelfError.textContent = 'ラックまたは保存状態が変わりました。設定し直してください。';
            updateAllStates();
            return;
        }
        let row, next;
        try {
            row = toSaveRackShelf({
                id: currentShelfId || allocateLocalId('rackShelves'),
                view_id: destination,
                name: fields.name.value,
                face: fields.face.value,
                start_u: fields.start.value,
                height_u: fields.height.value,
                depth: fields.depth.value
            });
            next = [...shelves().filter(r => !eq(r.id, row.id)), row];
            validateRackLayout({ ...appState, rackShelves: next });
        } catch (failure) {
            shelfError.textContent = failure.message;
            return;
        }
        const moving = previous && !eq(previous.view_id, row.view_id);
        if (moving && !pendingShelfTransfer) {
            pendingShelfTransfer = JSON.stringify(row);
            shelfConfirmation.show({
                name: `棚板「${previous.name}」と所属機器${shelfMembers(previous.id).length}台`,
                from: { rack: rackName(previous.view_id), detail: shelfLocation(previous) },
                to: { rack: rackName(row.view_id), detail: shelfLocation(row) }
            });
            shelfSubmit.textContent = '移設を確定';
            updateAllStates();
            return;
        }
        if (moving && pendingShelfTransfer !== JSON.stringify(row)) {
            pendingShelfTransfer = null;
            shelfConfirmation.hide();
            shelfError.textContent = '移設条件が変わりました。設定し直してください。';
            return;
        }

        pendingShelfTransfer = null;
        shelfConfirmation.hide();
        isSavingShelf = true;
        currentShelfId = row.id;
        updateAllStates();

        if (!commit({ rackShelves: next })) {
            isSavingShelf = false;
            updateAllStates();
            return;
        }
    }

    async function handleAddDevice() {
        deviceError.textContent = '';
        if (!canOperateDeviceInput() || isAddingDevice) return;
        const current = () => dialog === overlay && shelfById(currentShelfId) && eq(appState.currentViewId, previous?.view_id ?? viewId) &&
            shelfSnapshot() === initialSnapshot;

        if (deviceInput.mode === 'new') {
            const values = deviceInput.values;
            const validation = validateDeviceValues({ ...values, name: values.name || '新しい機器' });
            if (Object.keys(validation.errors).length) {
                deviceError.textContent = Object.values(validation.errors).join('\n');
                return;
            }
            isAddingDevice = true;
            addDeviceBtn.disabled = true;
            try {
                const { addDevice } = await import('../ui/toolbar.js');
                if (!current() || !shelfEditable([previous?.view_id ?? viewId])) return;
                const dev = await addDevice(deviceInput.type.value, {
                    rackShelfId: currentShelfId,
                    isCurrent: current,
                    openDevicePanel: false,
                    deviceValues: values
                });
                if (dev) {
                    refreshMembershipSnapshot(dev.id);
                    deviceInput.reset();
                    renderSummaryList();
                    showToast(`機器「${dev.name}」を棚板に追加しました`);
                }
            } finally {
                isAddingDevice = false;
                updateAllStates();
            }
            return;
        }

        const selectedId = deviceInput.selectedId;
        const device = getDeviceById(selectedId);
        if (!device) {
            deviceError.textContent = '追加する機器を選択してください。';
            return;
        }
        const source = shelfForDevice(device.id);
        const mount = appState.rackMounts.find(r => eq(r.device_id, device.id));
        const ids = [previous?.view_id ?? viewId, source?.view_id, mount?.view_id].filter(id => id != null);
        if (!shelfEditable(ids)) {
            deviceError.textContent = '移設元または移設先を変更できません。';
            return;
        }
        const snapshot = assignmentSnapshot(device.id, currentShelfId);
        if (pendingDeviceTransfer && pendingDeviceTransfer !== snapshot) {
            pendingDeviceTransfer = null;
            deviceConfirmation.hide();
            addDeviceBtn.textContent = '棚板に追加';
            deviceError.textContent = '移設条件が変わりました。機器を選び直してください。';
            return;
        }
        if ((source || mount) && !pendingDeviceTransfer) {
            pendingDeviceTransfer = snapshot;
            deviceConfirmation.show({
                name: device.name,
                from: { rack: rackName(source?.view_id ?? mount.view_id), detail: deviceRackLocation(device.id) },
                to: { rack: rackName(previous?.view_id ?? viewId), detail: shelfLocation(previous || { name: fields.name.value, view_id: viewId, face: fields.face.value, start_u: Number(fields.start.value), height_u: Number(fields.height.value) }) }
            });
            addDeviceBtn.textContent = '移設を確定';
            updateAllStates();
            return;
        }
        isAddingDevice = true;
        addDeviceBtn.disabled = true;
        try {
            if (assignDeviceToShelf(device.id, currentShelfId, pendingDeviceTransfer ? { snapshot: pendingDeviceTransfer } : null)) {
                refreshMembershipSnapshot(device.id);
                pendingDeviceTransfer = null;
                deviceConfirmation.hide();
                addDeviceBtn.textContent = '棚板に追加';
                deviceInput.reset();
                renderSummaryList();
                showToast(`機器「${device.name}」を棚板に追加しました`);
            } else {
                pendingDeviceTransfer = null;
                deviceConfirmation.hide();
                addDeviceBtn.textContent = '棚板に追加';
                deviceError.textContent = '追加できませんでした。所属と保存状態を確認してください。';
            }
        } finally {
            isAddingDevice = false;
            updateAllStates();
        }
    }

    shelfSubmit.addEventListener('click', handleShelfSave);
    addDeviceBtn.addEventListener('click', handleAddDevice);

    form.addEventListener('submit', async event => {
        event.preventDefault();
        if (isDirty() || waitingCreation) await handleShelfSave();
        else await handleAddDevice();
    });
    form.addEventListener('input', () => {
        pendingShelfTransfer = null;
        shelfConfirmation.hide();
        updateAllStates();
    });
    form.addEventListener('change', () => {
        pendingShelfTransfer = null;
        shelfConfirmation.hide();
        updateAllStates();
    });

    closeBtn.addEventListener('click', () => {
        if (pendingShelfTransfer) { pendingShelfTransfer = null; shelfConfirmation.hide(); updateAllStates(); shelfError.textContent = ''; return; }
        if (pendingDeviceTransfer) { pendingDeviceTransfer = null; deviceConfirmation.hide(); addDeviceBtn.textContent = '棚板に追加'; updateAllStates(); deviceError.textContent = ''; return; }
        closeShelfDialog({ confirmIfDirty: true });
    });

    activeShelfDialog = {
        overlay,
        viewId: origin,
        get currentShelfId() { return currentShelfId; },
        get waitingCreation() { return waitingCreation; },
        isDirty,
        hideCandidates: () => deviceInput.hideCandidates(),
        onIdsRemapped(maps) {
            const snapshot = JSON.parse(initialSnapshot);
            for (const shelf of [snapshot[0], ...snapshot[1]].filter(Boolean)) {
                shelf.id = mappedResourceId(maps.rack_shelves, shelf.id);
                shelf.view_id = mappedResourceId(maps.views, shelf.view_id);
            }
            for (const member of snapshot[2]) {
                member.device_id = mappedResourceId(maps.devices, member.device_id);
                member.shelf_id = mappedResourceId(maps.rack_shelves, member.shelf_id);
            }
            for (const view of snapshot[3]) view.id = mappedResourceId(maps.views, view.id);
            for (const mount of snapshot[4]) {
                mount.device_id = mappedResourceId(maps.devices, mount.device_id);
                mount.view_id = mappedResourceId(maps.views, mount.view_id);
            }
            initialSnapshot = JSON.stringify(snapshot);
            if (currentShelfId != null && maps.rack_shelves?.[currentShelfId] != null) {
                currentShelfId = Number(maps.rack_shelves[currentShelfId]);
                waitingCreation = false;
            }
            previous = shelfById(currentShelfId);
            if (currentShelfId != null && !previous) {
                closeShelfDialog();
                return;
            }
            renderSummaryList();
            updateAllStates();
        },
        onResourcesSaved(data) {
            if (!membershipSnapshotChanged && !isAddingDevice) return;
            const snapshot = JSON.parse(initialSnapshot);
            for (const view of snapshot[3]) {
                const saved = data.views.find(row => eq(row.id, view.id));
                if (saved) view.resource_revision = saved.resource_revision;
            }
            initialSnapshot = JSON.stringify(snapshot);
            membershipSnapshotChanged = false;
        },
        onSaveStateChanged(state) {
            if (!isCurrentUserAdmin() || appState.authExpired || appState.appStatus.state === 'unconfirmed' || hasResourceConflict('views', origin)) {
                closeShelfDialog();
                return;
            }
            if (isSaveInFlight()) return;

            if (isSavingShelf) {
                if (state === 'saved') {
                    isSavingShelf = false;
                    waitingCreation = false;
                    previous = shelfById(currentShelfId);
                    if (previous) {
                        baselineSnapshot = JSON.stringify({
                            name: previous.name,
                            view_id: previous.view_id,
                            start_u: previous.start_u,
                            height_u: previous.height_u,
                            face: previous.face,
                            depth: previous.depth
                        });
                        initialSnapshot = JSON.stringify([previous, shelves(), members(), appState.views, appState.rackMounts]);
                    }
                    updateAllStates();
                    showToast('棚板の設定を保存しました');
                } else if (state === 'error' || state === 'conflict') {
                    isSavingShelf = false;
                    shelfError.textContent = '棚板の保存に失敗しました。再試行してください。';
                    updateAllStates();
                }
            } else {
                updateAllStates();
            }
        }
    };

    renderSummaryList();
    updateAllStates();

    registerModalOpen('rack-shelf', overlay, waitingCreation ? '#rack-shelf-name' : '#rack-shelf-device-search', {
        onClose: () => {
            if (deviceInput.candidatesOpen) deviceInput.hideCandidates();
            else if (pendingShelfTransfer) { pendingShelfTransfer = null; shelfConfirmation.hide(); updateAllStates(); }
            else if (pendingDeviceTransfer) { pendingDeviceTransfer = null; deviceConfirmation.hide(); updateAllStates(); }
            else closeShelfDialog({ confirmIfDirty: true });
        }
    });
}
function closeShelfDeviceDialog() {
    closeShelfDialog();
}
function deviceIcon(device) {
    const icon = el('img', 'device-type-icon'); icon.src = (DEVICE_TYPES[device.type] || DEVICE_TYPES.other).icon; icon.alt = ''; return icon;
}
function openShelfDeviceDialog(shelfId) {
    const shelf = shelfById(shelfId);
    if (!requireAdminUiAction() || !shelf || !shelfEditable([shelf.view_id]) || !eq(shelf.view_id, appState.currentViewId)) return;
    openShelfDialog({ viewId: shelf.view_id, shelfId: shelf.id });
}
export function closeShelfPanel() {
    closeShelfDeviceDialog(); closeShelfDialog();
    document.getElementById('rack-shelf-panel')?.remove(); selectedShelfId = null;
}
export async function showShelfPanel(id) {
    const available = () => {
        const shelf = shelfById(id);
        return shelf && appState.views.some(view => eq(view.id, shelf.view_id) && view.view_type === 'rack') ? shelf : null;
    };
    let shelf = available();
    if (!shelf) { showToast('棚板または配置先ラックが見つかりません。最新データを確認してください。', 'warning'); return false; }
    if (!eq(shelf.view_id, appState.currentViewId) && !await switchView(shelf.view_id)) return false;
    if (!await closePanel() || !await closeLinkPanel()) return false;
    shelf = available();
    if (!shelf || !eq(shelf.view_id, appState.currentViewId)) {
        showToast('棚板の配置先が変わりました。最新データを確認してください。', 'warning'); return false;
    }
    if (selectedShelfId != null && !eq(selectedShelfId, id)) closeShelfDeviceDialog();
    selectedShelfId = shelf.id; renderShelfPanel(); return true;
}
function renderShelfPanel() {
    document.getElementById('rack-shelf-panel')?.remove();
    const shelf = shelfById(selectedShelfId); if (!shelf || !eq(shelf.view_id, appState.currentViewId)) { closeShelfPanel(); return; }
    const panel = el('aside', 'rack-shelf-panel'); panel.id = 'rack-shelf-panel'; panel.setAttribute('aria-label', '棚板の詳細');
    const header = el('div', 'panel-header'), title = el('h3', 'rack-shelf-panel-title'), icon = el('img', 'rack-shelf-icon');
    icon.src = 'assets/icons/toolbar/shelf.svg'; icon.alt = ''; title.append(icon, el('span', '', shelf.name));
    const headerActions = el('div', 'rack-shelf-panel-actions'), rows = shelfMembers(shelf.id);
    const close = btn('×', closeShelfPanel); close.className = 'modal-close-btn panel-close-btn'; close.setAttribute('aria-label', 'パネルを閉じる');
    headerActions.appendChild(close); header.append(title, headerActions); panel.appendChild(header);
    const group = (label, summaryText) => {
        const section = el('details', 'panel-group'); section.open = true;
        const summary = el('summary', 'panel-group-summary'); summary.append(el('span', 'panel-group-title', label), el('span', 'panel-group-summary-text', summaryText));
        const body = el('div', 'panel-group-body'); section.append(summary, body); panel.appendChild(section); return body;
    };
    const position = group('設置位置', '');
    position.classList.add('rack-shelf-position');
    position.append(el('p', '', rackName(shelf.view_id)),
        el('p', '', `${shelf.face === 'rear' ? '背面' : '前面'} ・ ${shelf.start_u}〜${shelf.start_u + shelf.height_u - 1}U（${shelf.height_u}U）`),
        el('p', '', shelf.depth === 'full' ? '全体（前後両面を占有）' : `半分（${shelf.face === 'rear' ? '背面' : '前面'}側のみ占有）`));
    const devices = group('機器一覧', `${rows.length}台`), list = el('ol', 'rack-shelf-members');
    for (const [index, row] of rows.entries()) {
        const device = getDeviceById(row.device_id); if (!device) continue;
        const item = el('li', 'rack-shelf-member'), open = btn('', async () => { if (await openPanel(device)) closeShelfPanel(); });
        open.classList.add('rack-shelf-member-open');
        const label = el('span'); label.append(el('strong', '', device.name), el('small', '', [DEVICE_TYPES[device.type]?.label || device.type, device.ip].filter(Boolean).join(' / ')));
        open.append(deviceIcon(device), label); item.appendChild(open);
        if (isCurrentUserAdmin()) {
            const actions = el('div', 'rack-shelf-member-actions');
            actions.append(btn('↑', () => reorderShelfDevice(device.id, -1), !shelfEditable() || index === 0), btn('↓', () => reorderShelfDevice(device.id, 1), !shelfEditable() || index === rows.length - 1), btn('取り外し', () => {
                if (window.confirm(`「${device.name}」を棚板から取り外しますか？`)) removeShelfDevice(device.id);
            }, !shelfEditable()));
            actions.children[0].setAttribute('aria-label', `${device.name}を上へ`); actions.children[1].setAttribute('aria-label', `${device.name}を下へ`);
            item.appendChild(actions);
        }
        list.appendChild(item);
    }
    if (rows.length) devices.appendChild(list); else devices.appendChild(el('p', 'rack-shelf-empty', 'この棚板に機器はありません'));
    if (isCurrentUserAdmin()) {
        const add = btn('＋ 機器を追加', () => openShelfDeviceDialog(shelf.id), !shelfEditable()); add.classList.add('rack-shelf-add-device'); devices.appendChild(add);
        const actions = el('div', 'rack-shelf-settings-actions');
        actions.append(btn('棚板の設定', () => openShelfDialog({ viewId: shelf.view_id, shelfId: shelf.id }), !shelfEditable()),
            btn('棚板を削除', () => deleteShelf(shelf.id), !shelfEditable() || rows.length > 0));
        actions.children[1].classList.add('btn-danger');
        panel.appendChild(actions);
    }
    document.body.appendChild(panel);
}
eventBus.on('rack:changed', () => { if (selectedShelfId != null) renderShelfPanel(); });
eventBus.on('save-state:changed', state => {
    if (activeShelfDialog) activeShelfDialog.onSaveStateChanged(state);
    else if (!shelfEditable()) setShelfAdding(false);
    if (selectedShelfId != null) renderShelfPanel();
});
eventBus.on('resources:saved', data => activeShelfDialog?.onResourcesSaved(data));
eventBus.on('resources:ids-remapped', maps => {
    if (activeShelfDialog) activeShelfDialog.onIdsRemapped(maps);
    if (selectedShelfId != null) {
        selectedShelfId = Number(maps.rack_shelves?.[selectedShelfId] ?? selectedShelfId);
        renderShelfPanel();
    }
});
eventBus.on('device-panel:opened', closeShelfPanel);
eventBus.on('canvas:render-complete', () => {
    if (dialog && !eq(dialogViewId, appState.currentViewId)) closeShelfDialog();
    if (getCurrentView()?.view_type !== 'rack' || (selectedShelfId != null && !eq(shelfById(selectedShelfId)?.view_id, appState.currentViewId))) { setShelfAdding(false); closeShelfDialog(); closeShelfPanel(); }
});
if (typeof document !== 'undefined') {
    document.addEventListener('click', event => {
        if (event.target.closest?.('#palette-shelf-btn')) { closeShelfDialog(); setShelfAdding(!adding); }
        if (event.target.closest?.('#palette-view-btn')) { setShelfAdding(false); closeShelfDialog(); closeShelfDeviceDialog(); }
    });
    document.addEventListener('keydown', event => { if (event.key === 'Escape') { setShelfAdding(false); if (!dialog && !deviceDialog) closeShelfPanel(); } });
}
