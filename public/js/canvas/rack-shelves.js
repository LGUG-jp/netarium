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

let adding = false, selectedShelfId = null, dialog = null, dialogViewId = null, deviceDialog = null, deviceDialogViewId = null;
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
    adding = Boolean(active) && getCurrentView()?.view_type === 'rack' && shelfEditable();
    const control = document.getElementById('palette-shelf-btn');
    control?.classList.toggle('active', adding); control?.setAttribute('aria-pressed', String(adding));
    const select = document.getElementById('palette-view-btn');
    select?.classList.toggle('active', !adding); select?.setAttribute('aria-pressed', String(!adding));
    const mount = document.getElementById('rack-range-mount-btn'); if (mount) mount.textContent = adding ? '棚板を追加' : '機器を搭載';
}
function closeShelfDialog() {
    closeDeviceTypePicker(); dialog?.remove(); dialog = null; dialogViewId = null; registerModalClose('rack-shelf'); setShelfAdding(false);
}
export function openShelfDialog({ viewId, face = 'front', startU = 1, heightU = 1, shelfId = null }) {
    const previous = shelfById(shelfId);
    if (!requireAdminUiAction() || !shelfEditable([viewId])) return;
    closeShelfDialog(); closeShelfDeviceDialog();
    const origin = appState.currentViewId;
    const initialSnapshot = JSON.stringify([previous, shelves(), members(), appState.views, appState.rackMounts]);
    let pending = null;
    const overlay = el('div', 'view-manager-overlay rack-mount-overlay');
    const section = el('section', 'view-manager-dialog rack-mount-dialog'); section.setAttribute('role', 'dialog'); section.setAttribute('aria-modal', 'true'); section.setAttribute('aria-labelledby', 'rack-shelf-title');
    const title = el('h2', '', previous ? '棚板の設定' : '棚板を追加'); title.id = 'rack-shelf-title';
    const form = el('form', 'rack-mount-form'), body = el('div', 'rack-mount-body'), fields = {};
    function field(name, label, tag, value, options) {
        const group = el('div', 'rack-mount-field'), text = el('label', '', label), input = el(tag);
        input.id = `rack-shelf-${name}`; text.setAttribute('for', input.id);
        for (const [value, label] of options || []) { const option = el('option', '', label); option.value = value; input.appendChild(option); }
        input.value = String(value); fields[name] = input; group.append(text, input); body.appendChild(group); return input;
    }
    const name = field('name', '棚板名', 'input', previous?.name || '棚板'); name.required = true; name.maxLength = 100;
    const rack = field('view', '搭載先ラック', previous ? 'select' : 'input', previous?.view_id || rackName(viewId),
        previous ? appState.views.filter(row => row.view_type === 'rack').map(row => [String(row.id), row.name]) : []);
    if (!previous) rack.readOnly = true;
    const positionRow = el('div', 'rack-mount-row-secondary');
    const faceInput = field('face', '搭載面', 'select', previous?.face || face, [['front', '前面'], ['rear', '背面']]);
    const depthInput = field('depth', '奥行き', 'select', previous?.depth || 'half', [['half', '半分'], ['full', '全体']]);
    positionRow.append(faceInput.parentElement, depthInput.parentElement); body.appendChild(positionRow);
    const unitRow = el('div', 'rack-mount-row-secondary');
    for (const [key, label, value] of [['start', '開始U（最下段）', previous?.start_u || startU], ['height', '占有U数', previous?.height_u || heightU]]) {
        const input = field(key, label, 'input', value); input.type = 'number'; input.min = '1'; input.max = '60'; input.step = '1'; input.required = true;
        unitRow.appendChild(input.parentElement);
    }
    body.appendChild(unitRow);
    const summary = el('p', 'rack-mount-summary'); summary.setAttribute('aria-live', 'polite'); body.appendChild(summary);
    const updateSummary = () => {
        const start = Number(fields.start.value), height = Number(fields.height.value);
        summary.textContent = `${previous ? rackName(Number(rack.value)) : rackName(viewId)} / ${fields.face.value === 'rear' ? '背面' : '前面'} / ${start}〜${start + height - 1}U（${height}U） / 全幅 / 奥行き：${fields.depth.value === 'full' ? '全体' : '半分'}`;
    };
    updateSummary();
    body.appendChild(el('p', 'rack-warning', '棚板は全幅です。棚板上の機器は追加のUを占有しません。奥行きは簡易占有であり、現物の干渉・耐荷重・放熱は保証しません。'));
    const error = el('p', 'form-error'); error.setAttribute('role', 'alert'); body.appendChild(error);
    const confirmation = createRackTransferConfirmation(); body.appendChild(confirmation.element);
    const actions = el('div', 'rack-mount-actions'), submit = el('button', 'btn btn-primary', previous ? '設定を保存' : '棚板を追加'); submit.type = 'submit';
    actions.append(btn('キャンセル', () => {
        if (!pending) { closeShelfDialog(); return; }
        pending = null; confirmation.hide(); submit.textContent = '設定を保存'; error.textContent = '';
    }), submit);
    form.addEventListener('input', () => { pending = null; confirmation.hide(); submit.textContent = previous ? '設定を保存' : '棚板を追加'; updateSummary(); });
    form.addEventListener('change', () => { pending = null; confirmation.hide(); submit.textContent = previous ? '設定を保存' : '棚板を追加'; updateSummary(); });
    form.addEventListener('submit', event => {
        event.preventDefault(); error.textContent = '';
        const destination = previous ? Number(fields.view.value) : Number(viewId);
        const currentSnapshot = JSON.stringify([shelfById(shelfId), shelves(), members(), appState.views, appState.rackMounts]);
        if (!eq(appState.currentViewId, origin) || !shelfEditable([viewId, destination]) || (previous && currentSnapshot !== initialSnapshot)) { error.textContent = 'ラックまたは保存状態が変わりました。設定し直してください。'; return; }
        let row, next;
        try {
            row = toSaveRackShelf({ id: previous?.id || allocateLocalId('rackShelves'), view_id: destination, name: fields.name.value, face: fields.face.value, start_u: fields.start.value, height_u: fields.height.value, depth: fields.depth.value });
            next = [...shelves().filter(row => !eq(row.id, shelfId)), row];
            validateRackLayout({ ...appState, rackShelves: next });
        } catch (failure) { error.textContent = failure.message; return; }
        const moving = previous && !eq(previous.view_id, row.view_id);
        if (moving && !pending) {
            pending = JSON.stringify(row);
            confirmation.show({ name: `棚板「${previous.name}」と所属機器${shelfMembers(previous.id).length}台`,
                from: { rack: rackName(previous.view_id), detail: shelfLocation(previous) },
                to: { rack: rackName(row.view_id), detail: shelfLocation(row) } });
            submit.textContent = '移設を確定'; return;
        }
        if (moving && pending !== JSON.stringify(row)) { pending = null; confirmation.hide(); error.textContent = '移設条件が変わりました。設定し直してください。'; return; }
        closeShelfDialog();
        if (commit({ rackShelves: next })) {
            if (eq(row.view_id, appState.currentViewId)) showShelfPanel(row.id);
            else closeShelfPanel();
        }
    });
    form.append(body, actions); section.append(title, form); overlay.appendChild(section); document.body.appendChild(overlay); dialog = overlay; dialogViewId = origin;
    registerModalOpen('rack-shelf', overlay, '#rack-shelf-name', { onClose: closeShelfDialog });
}
function closeShelfDeviceDialog() {
    closeDeviceTypePicker();
    if (!deviceDialog) return;
    deviceDialog.remove(); deviceDialog = null; deviceDialogViewId = null; registerModalClose('rack-shelf-device');
}
function deviceIcon(device) {
    const icon = el('img', 'device-type-icon'); icon.src = (DEVICE_TYPES[device.type] || DEVICE_TYPES.other).icon; icon.alt = ''; return icon;
}
function openShelfDeviceDialog(shelfId) {
    const shelf = shelfById(shelfId);
    if (!requireAdminUiAction() || !shelf || !shelfEditable([shelf.view_id]) || !eq(shelf.view_id, appState.currentViewId)) return;
    closeShelfDialog(); closeShelfDeviceDialog();
    const overlay = el('div', 'view-manager-overlay rack-mount-overlay rack-shelf-device-overlay');
    const section = el('section', 'view-manager-dialog rack-mount-dialog');
    section.setAttribute('role', 'dialog'); section.setAttribute('aria-modal', 'true'); section.setAttribute('aria-labelledby', 'rack-shelf-device-title');
    const title = el('h2', '', '棚板に機器を追加'); title.id = 'rack-shelf-device-title';
    const form = el('form', 'rack-mount-form rack-shelf-device-form'), body = el('div', 'rack-mount-body');
    const modes = el('div', 'rack-shelf-device-modes'), existing = el('div', 'rack-shelf-existing'), fresh = el('div', 'rack-shelf-new');
    let mode = 'existing', selectedId = null, pending = null, busy = false;
    const current = () => deviceDialog === overlay && shelfById(shelfId) === shelf && eq(appState.currentViewId, shelf.view_id);
    const search = el('input'); search.id = 'rack-shelf-device-search'; search.type = 'search'; search.placeholder = '機器名・IP・型番で検索'; search.setAttribute('aria-label', '機器名・IP・型番で検索');
    const results = el('div', 'rack-shelf-candidates'); existing.append(search, results);
    const picker = createDeviceTypePicker({ value: 'switch', control: el('button') });
    const typeGroup = el('div', 'rack-mount-field'); typeGroup.append(el('span', '', '機器の種別'), picker.control); fresh.appendChild(typeGroup);
    const inputs = {};
    for (const [key, label] of [['name', '機器名'], ['ip', 'IPアドレス（任意）']]) {
        const group = el('div', 'rack-mount-field'), input = el('input'), text = el('label', '', label);
        input.id = `rack-shelf-device-${key}`; text.setAttribute('for', input.id); input.maxLength = key === 'name' ? 100 : 45;
        inputs[key] = input; group.append(text, input); fresh.appendChild(group);
    }
    const confirmation = createRackTransferConfirmation(), error = el('p', 'form-error'); error.setAttribute('role', 'alert');
    const actions = el('div', 'rack-mount-actions'), submit = el('button', 'btn btn-primary', '棚板に追加'); submit.type = 'submit';
    const resetConfirmation = () => { pending = null; confirmation.hide(); submit.textContent = '棚板に追加'; error.textContent = ''; };
    const filter = () => {
        results.replaceChildren(); const query = search.value.trim().toLocaleLowerCase('ja');
        if (!query) { results.appendChild(el('p', '', '機器名・IP・型番を入力して検索してください')); return; }
        for (const device of appState.devices.filter(row => !shelfMembers(shelfId).some(member => eq(member.device_id, row.id)) &&
            `${row.name} ${row.ip || ''} ${row.model || ''}`.toLocaleLowerCase('ja').includes(query))) {
            const candidate = btn('', () => {
                selectedId = device.id; resetConfirmation();
                for (const node of results.children) node.setAttribute('aria-pressed', String(node === candidate));
            });
            candidate.classList.add('rack-shelf-candidate'); candidate.setAttribute('aria-pressed', String(eq(selectedId, device.id)));
            const label = el('span'); label.append(el('strong', '', device.name), el('small', '', `${DEVICE_TYPES[device.type]?.label || device.type} / ${device.ip || 'IP未設定'} / ${deviceRackLocation(device.id)}`));
            candidate.append(deviceIcon(device), label); results.appendChild(candidate);
        }
        if (!results.children.length) results.appendChild(el('p', '', '該当する機器がありません'));
    };
    const setMode = value => {
        mode = value; resetConfirmation(); closeDeviceTypePicker(); existing.hidden = value !== 'existing'; fresh.hidden = value !== 'new';
        existingButton.setAttribute('aria-pressed', String(value === 'existing')); newButton.setAttribute('aria-pressed', String(value === 'new'));
    };
    const existingButton = btn('既存機器から選択', () => setMode('existing')), newButton = btn('新しい機器を登録', () => setMode('new'));
    modes.append(existingButton, newButton); setMode('existing'); filter();
    search.addEventListener('input', () => { selectedId = null; resetConfirmation(); filter(); });
    form.addEventListener('submit', async event => {
        event.preventDefault();
        if (busy) return;
        if (!current() || !shelfEditable([shelf.view_id])) { error.textContent = 'ラックまたは保存状態が変わりました。開き直してください。'; return; }
        if (mode === 'new') {
            const values = { name: inputs.name.value.trim(), ip: inputs.ip.value.trim() };
            const validation = validateDeviceValues({ ...values, name: values.name || '新しい機器' }, appState.devices);
            if (Object.keys(validation.errors).length) { error.textContent = Object.values(validation.errors).join('\n'); return; }
            busy = true; submit.disabled = true;
            try {
                const { addDevice } = await import('../ui/toolbar.js');
                if (!current() || !shelfEditable([shelf.view_id])) return;
                const device = await addDevice(picker.control.value, { rackShelfId: shelf.id, isCurrent: current,
                    openDevicePanel: false, shelfDeviceValues: values });
                if (device) { closeShelfDeviceDialog(); await showShelfPanel(shelf.id); }
            } finally { busy = false; submit.disabled = false; }
            return;
        }
        const device = getDeviceById(selectedId);
        if (!device) { error.textContent = '追加する機器を選択してください。'; return; }
        const source = shelfForDevice(device.id), mount = appState.rackMounts.find(row => eq(row.device_id, device.id));
        const ids = [shelf.view_id, source?.view_id, mount?.view_id].filter(id => id != null);
        if (!shelfEditable(ids)) { error.textContent = '移設元または移設先を変更できません。'; return; }
        const snapshot = assignmentSnapshot(device.id, shelf.id);
        if (pending && pending !== snapshot) { resetConfirmation(); error.textContent = '移設条件が変わりました。機器を選び直してください。'; return; }
        if ((source || mount) && !pending) {
            pending = snapshot;
            confirmation.show({ name: device.name, from: { rack: rackName(source?.view_id ?? mount.view_id), detail: deviceRackLocation(device.id) },
                to: { rack: rackName(shelf.view_id), detail: shelfLocation(shelf) } });
            submit.textContent = '移設を確定'; return;
        }
        if (assignDeviceToShelf(device.id, shelf.id, { snapshot })) { closeShelfDeviceDialog(); await showShelfPanel(shelf.id); }
        else { resetConfirmation(); error.textContent = '追加できませんでした。所属と保存状態を確認してください。'; }
    });
    actions.append(btn('キャンセル', () => { if (pending) resetConfirmation(); else closeShelfDeviceDialog(); }), submit);
    body.append(modes, existing, fresh, confirmation.element, error); form.append(body, actions); section.append(title, form); overlay.appendChild(section);
    document.body.appendChild(overlay); deviceDialog = overlay; deviceDialogViewId = shelf.view_id;
    registerModalOpen('rack-shelf-device', overlay, '#rack-shelf-device-search', { onClose: closeShelfDeviceDialog });
}
export function closeShelfPanel() {
    closeShelfDeviceDialog(); closeShelfDialog();
    document.getElementById('rack-shelf-panel')?.remove(); selectedShelfId = null;
}
export async function showShelfPanel(id) {
    if (!await closePanel() || !await closeLinkPanel()) return false;
    const shelf = shelfById(id); if (!shelf || !eq(shelf.view_id, appState.currentViewId)) return false;
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
eventBus.on('save-state:changed', () => { if (!shelfEditable()) { setShelfAdding(false); closeShelfDialog(); closeShelfDeviceDialog(); } if (selectedShelfId != null) renderShelfPanel(); });
eventBus.on('resources:ids-remapped', maps => {
    closeShelfDialog(); closeShelfDeviceDialog();
    if (selectedShelfId != null) {
        selectedShelfId = Number(maps.rack_shelves?.[selectedShelfId] ?? selectedShelfId);
        renderShelfPanel();
    }
});
eventBus.on('device-panel:opened', closeShelfPanel);
eventBus.on('canvas:render-complete', () => {
    if (dialog && !eq(dialogViewId, appState.currentViewId)) closeShelfDialog();
    if (deviceDialog && !eq(deviceDialogViewId, appState.currentViewId)) closeShelfDeviceDialog();
    if (getCurrentView()?.view_type !== 'rack' || (selectedShelfId != null && !eq(shelfById(selectedShelfId)?.view_id, appState.currentViewId))) { setShelfAdding(false); closeShelfDialog(); closeShelfPanel(); }
});
if (typeof document !== 'undefined') {
    document.addEventListener('click', event => {
        if (event.target.closest?.('#palette-shelf-btn')) setShelfAdding(!adding);
        if (event.target.closest?.('#palette-view-btn')) { setShelfAdding(false); closeShelfDialog(); closeShelfDeviceDialog(); }
    });
    document.addEventListener('keydown', event => { if (event.key === 'Escape') { setShelfAdding(false); if (!dialog && !deviceDialog) closeShelfPanel(); } });
}
