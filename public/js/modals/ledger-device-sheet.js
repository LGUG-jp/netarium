/**
 * 機器個票の描画・入力・画像操作。台帳の選択状態と画面遷移は呼び出し側が管理する。
 */
import { appState, getDeviceById, normalizeStatus } from '../core/state.js';
import { eventBus } from '../core/event-bus.js';
import { validateDeviceValues } from '../core/device-validation.js';
import { getDeviceStatusLabel } from '../core/device-monitoring.js';
import { getDeviceDestinations, getRackDeviceMounts } from '../core/device-placement.js';
import { getDeviceDraft, hasDeviceDraftChanges, commitDeviceDraft, discardDeviceDraft } from '../core/device-drafts.js';
import { chooseUnsavedChanges } from '../core/unsaved-changes-dialog.js';
import { flushSaveQueue, scheduleSave, hasResourceConflict, hasResourceChanges } from '../core/save-queue.js';
import { getDeviceImageBlockReason, uploadDeviceImage } from '../core/device-image-api.js';
import { render } from '../canvas/renderer.js';
import { isCurrentUserAdmin } from '../ui/access-control.js';
import { setInputError } from '../ui/field-errors.js';
import { bindLocationSuggestion } from '../ui/location-suggestions.js';
import { populateFloorSelect, viewHierarchyPath } from '../core/building-hierarchy.js';
import { createDeviceTypePicker, closeDeviceTypePicker } from '../ui/device-type-picker.js';
import { createDeviceIpEditor } from '../ui/device-ip-editor.js';
import { createIpDuplicateNotice } from '../ui/ip-duplicate-notice.js';
import { copyShareLink } from '../ui/share-link.js';
import {
    deleteDeviceImage,
    openDeviceImageZoom,
    bindDeviceImageCaptionInput,
    updateImageCaption,
    reorderDeviceImages
} from '../ui/device-images.js';
import { showToast } from '../ui/toast.js';
import { markDirty } from '../ui/status-bar.js';
import { openPingHelpDialog } from './ping-help-modal.js';
import { createDeviceConfigTab } from './device-config-modal.js';
import { createLedgerPortTab } from './ledger-port-tab.js';
import { legacyVlansForDevice } from '../core/legacy-link-vlans.js';
import { openViewManager } from './view-manager-modal.js';

export function createLedgerDeviceSheet({
    getActiveDeviceId, getAdjacentLedgerDeviceId, updateDraft,
    syncLedgerDraftButtons, showLedgerDestination, openDevice
}) {
    let activateSheetTab = () => {};
    const configTab = createDeviceConfigTab({
        onBusyChange: () => syncLedgerDraftButtons(),
        onRequestActivate: () => activateSheetTab('config')
    });
    const portTab = createLedgerPortTab({
        onBusyChange: syncLedgerDraftButtons,
        openDevice: async id => {
            if (await openDevice(id, { tab: 'ports' })) {
                document.getElementById('ledger-sheet-tabs')?.querySelector('[data-tab-key="ports"]')?.focus();
            }
        }
    });
    const isSheetTabBusy = () => configTab.isBusy() || portTab.isBusy();
    const syncSheetImageBlockState = () => {
        const body = document.getElementById('ledger-sheet-body');
        if (!body || getActiveDeviceId() == null) return;
        const isAdmin = isCurrentUserAdmin();
        const reason = !isAdmin ? '閲覧専用のため画像を登録できません' : getDeviceImageBlockReason(getActiveDeviceId());
        const blocked = Boolean(reason);
        for (const button of body.querySelectorAll('.ledger-sheet-image-slot-add')) {
            button.disabled = blocked;
            button.title = reason || '画像ファイルを選択して登録';
            const notice = button.parentElement.querySelector('.ledger-sheet-image-block-reason');
            if (notice) {
                notice.textContent = reason;
                notice.hidden = !blocked;
            }
        }
        for (const button of body.querySelectorAll('.ledger-sheet-image-move, .ledger-sheet-image-replace, .ledger-sheet-image-delete')) {
            button.disabled = blocked;
        }
        for (const input of body.querySelectorAll('.ledger-sheet-image-caption-input')) {
            input.disabled = !isAdmin || blocked;
        }
    };
    function portTabLabel(id) {
        const count = legacyVlansForDevice(Number(id)).length;
        return count ? `接続・ポート（未移行VLAN ${count}件）` : '接続・ポート';
    }
    const syncPortTabLabel = () => {
        const id = getActiveDeviceId();
        if (id == null || typeof document === 'undefined') return;
        const tab = document.getElementById('ledger-sheet-tabs')?.querySelector('[data-tab-key="ports"]');
        if (tab) tab.textContent = portTabLabel(id);
    };
    eventBus.on('legacy-vlans:changed', syncPortTabLabel);
    eventBus.on('resources:reloaded', syncPortTabLabel);
    eventBus.on('resources:saved', syncPortTabLabel);
    eventBus.on('resource:reloaded', syncPortTabLabel);
    eventBus.on('resources:saved', syncSheetImageBlockState);
    eventBus.on('save-state:changed', syncSheetImageBlockState);
    eventBus.on('resource:reloaded', ({ kind, id }) => {
        if (kind === 'devices' && Number(id) === getActiveDeviceId()) {
            const device = getDeviceById(id);
            if (device) renderLedgerDeviceSheet(device);
        }
    });
    eventBus.on('device-images:changed', deviceId => {
        if (Number(deviceId) !== getActiveDeviceId()) return;
        const device = getDeviceById(deviceId);
        if (device) renderLedgerDeviceSheet(device);
    });
    eventBus.on('device-placements:changed', deviceId => {
        if (Number(deviceId) !== getActiveDeviceId()) return;
        const wrapper = document.getElementById('ledger-sheet-body')?.querySelector('.ledger-sheet-view-pills');
        if (wrapper) renderSheetDestinations(wrapper, deviceId);
    });

    eventBus.on('ip-management:changed', () => {
        if (typeof document === 'undefined' || getActiveDeviceId() == null) return;
        const device = getDeviceById(getActiveDeviceId());
        if (device) renderLedgerDeviceSheet(device);
    });

    function syncSheetFloorOptions() {
        if (typeof document === 'undefined' || getActiveDeviceId() == null) return;
        const select = document.getElementById('ledger-sheet-body')?.querySelector('[data-field="floor_id"]');
        const device = getDeviceDraft('sheet', getActiveDeviceId());
        if (!select || !device) return;
        populateFloorSelect(select, appState, device.floor_id);
        const legacy = document.getElementById('ledger-sheet-legacy-location');
        if (legacy) legacy.hidden = device.floor_id != null || !(device.facility || device.floor);
    }
    eventBus.on('hierarchy:changed', syncSheetFloorOptions);
    eventBus.on('resources:reloaded', syncSheetFloorOptions);

    async function confirmConfigNavigation(id) {
        return await configTab.confirmLeave() && getActiveDeviceId() === id && !appState.authExpired;
    }

    async function confirmOpenPortsTab() {
        // 同じ機器の基本情報や接続・ポートの入力は切替先でも個票に残す。
        if (document.getElementById('ledger-sheet-body')?.dataset.activeTab !== 'config') return true;
        return confirmConfigNavigation(getActiveDeviceId());
    }

    async function confirmSheetNavigation({ saveBeforeLeaving = false, includeConfig = true } = {}) {
        const id = getActiveDeviceId();
        if (id === null) return true;
        if (portTab.isBusy() || (includeConfig && configTab.isBusy())) return false;

        const confirmBasic = async () => {
            if (!hasDeviceDraftChanges('sheet', id)) return true;
            const choice = await chooseUnsavedChanges('個票に未適用の変更があります。どうしますか？');
            if (getActiveDeviceId() !== id) return false;
            if (choice === 'save') {
                if (!commitSheetDraft()) return false;
                if (saveBeforeLeaving) {
                    const saved = await flushSaveQueue({ silent: true, resumeMaintenance: false });
                    if (!saved || hasResourceConflict('devices', id) || hasResourceChanges('devices', id)) {
                        showToast('機器の保存が完了していません。個票で保存状態を確認してください', 'warning');
                        return false;
                    }
                }
                return getActiveDeviceId() === id && !appState.authExpired;
            }
            if (choice !== 'discard') return false;
            discardDeviceDraft('sheet', id);
            return true;
        };

        const body = typeof document !== 'undefined' ? document.getElementById('ledger-sheet-body') : null;
        if (!await portTab.confirmLeave() || getActiveDeviceId() !== id) return false;
        if (includeConfig && body?.dataset?.activeTab === 'config') {
            if (!await confirmConfigNavigation(id)) return false;
            return await confirmBasic();
        }
        if (!await confirmBasic()) return false;
        return !includeConfig || await confirmConfigNavigation(id);
    }

    function commitSheetDraft() {
        try {
            if (getActiveDeviceId() !== null && hasResourceConflict('devices', getActiveDeviceId())) {
                throw new Error('この機器は競合しています。「競合を再読込」で確認してください');
            }
            if (getActiveDeviceId() !== null) {
                const { errors } = validateDeviceValues(getDeviceDraft('sheet', getActiveDeviceId()));
                showSheetFieldErrors(errors, true);
                if (Object.keys(errors).length) return false;
            }
            if (getActiveDeviceId() !== null && commitDeviceDraft('sheet', getActiveDeviceId())) {
                markDirty();
                scheduleSave({ immediate: true, silent: true });
                render();
            }
            return true;
        } catch (err) {
            showToast(`個票の入力を確認してください: ${err.message}`, 'warning');
            return false;
        }
    }

    let pendingSheetReplaceImageId = null;

    function triggerSheetImageUpload(replaceImageId = null) {
        if (!isCurrentUserAdmin()) return;
        if (appState.authExpired) return;
        const reason = getDeviceImageBlockReason(getActiveDeviceId());
        if (reason) {
            showToast(reason, 'warning');
            return;
        }
        pendingSheetReplaceImageId = replaceImageId;
        const fileInput = document.getElementById('ledger-sheet-image-file-input');
        if (!fileInput) return;
        fileInput.value = '';
        fileInput.click();
    }

    async function uploadSheetImageFile(file, replaceImageId = null) {
        if (!file || !getActiveDeviceId()) return;
        if (appState.authExpired) return;
        const deviceId = Number(getActiveDeviceId());

        try {
            await uploadDeviceImage(deviceId, file, replaceImageId);
        } catch (err) {
            if (err.status !== 401 && !appState.authExpired) showToast(err.message, 'error');
        }
    }

    if (typeof document !== 'undefined') {
        document.addEventListener('click', event => {
            const button = event.target?.closest?.('#ledger-sheet-copy-link-btn');
            if (button) void copyShareLink({ deviceId: getActiveDeviceId() }, button);
        });
        document.addEventListener('DOMContentLoaded', () => {
            const sheetFileInput = document.getElementById('ledger-sheet-image-file-input');
            if (sheetFileInput) {
                sheetFileInput.addEventListener('change', () => {
                    const file = sheetFileInput.files?.[0];
                    if (file) {
                        uploadSheetImageFile(file, pendingSheetReplaceImageId);
                    }
                    pendingSheetReplaceImageId = null;
                });
            }
        });
    }

    function focusLedgerSheetField(field) {
        const input = Array.from(document.getElementById('ledger-device-sheet-overlay')?.querySelectorAll('[data-field]') || [])
            .find(element => element.dataset.field === field);
        if (!input) return;
        const panel = input.closest('[role="tabpanel"]');
        if (panel) document.getElementById(panel.getAttribute('aria-labelledby'))?.click();
        input.focus();
        input.scrollIntoView({ block: 'center', inline: 'nearest' });
    }
    function showSheetFieldErrors(errors, focus = false) {
        let first = null;
        (document.getElementById('ledger-sheet-body')?.querySelectorAll('[data-field]') || []).forEach(input => {
            const field = input.dataset.field;
            if (field === 'additional_ips') {
                const addressInput = input.validateIps({ reveal: focus });
                if (errors[field] && !first) first = addressInput;
                return;
            }
            const error = document.getElementById(`ledger-sheet-${field}-error`);
            setInputError(input, error, errors[field]);
            if (errors[field] && !first) first = input;
        });
        if (focus && first) {
            const panel = first.closest('[role="tabpanel"]');
            if (panel) document.getElementById(panel.getAttribute('aria-labelledby'))?.click();
            first.focus();
        }
    }


    function bindSheetDraftInput(input, field) {
        const update = () => {
            if (!isCurrentUserAdmin() || appState.isPinging || getActiveDeviceId() === null) return;
            input.title = input.value;
            updateDraft('sheet', getActiveDeviceId(), field, ['management_port', 'floor_id'].includes(field)
                ? (input.validity?.badInput
                    ? 'invalid'
                    : (input.value === '' ? null : (/^\d+$/.test(input.value) ? Number(input.value) : input.value)))
                : input.value);
            const draft = getDeviceDraft('sheet', getActiveDeviceId());
            showSheetFieldErrors(validateDeviceValues(draft).errors);
            if (field === 'floor_id') syncSheetFloorOptions();
            const title = document.getElementById('ledger-sheet-title');
            if (field === 'name' && title) {
                title.textContent = input.value ? `機器台帳 個票: ${input.value}` : `機器台帳 個票 (ID: ${getActiveDeviceId()})`;
            }
        };
        input.addEventListener('input', update);
        if (input.tagName === 'SELECT') input.addEventListener('change', update);
    }

    function renderLedgerDeviceSheet(device, { tab } = {}) {
        if (getActiveDeviceId() !== Number(device.id)) return;
        const overlay = document.getElementById('ledger-device-sheet-overlay');
        if (!overlay) return;
        const storedDevice = getDeviceById(device.id);
        device = getDeviceDraft('sheet', device.id) || device;
        const tabBusy = isSheetTabBusy();
        for (const [id, direction] of [['ledger-sheet-prev-btn', -1], ['ledger-sheet-next-btn', 1]]) {
            const button = document.getElementById(id);
            if (button) button.disabled = appState.authExpired || tabBusy || getAdjacentLedgerDeviceId(direction) === null;
        }
        const closeBtn = document.getElementById('close-ledger-detail-pane-btn');
        if (closeBtn) closeBtn.disabled = tabBusy;
        const titleEl = document.getElementById('ledger-sheet-title');
        if (titleEl) {
            titleEl.textContent = device.name ? `機器台帳 個票: ${device.name}` : `機器台帳 個票 (ID: ${device.id})`;
            titleEl.title = device.name || '';
        }

        const viewManageBtn = document.getElementById('ledger-sheet-view-manage-btn');
        if (viewManageBtn) {
            viewManageBtn.hidden = !isCurrentUserAdmin();
        }
        syncLedgerDraftButtons();

        const body = document.getElementById('ledger-sheet-body');
        if (!body) return;
        const focused = body.contains(document.activeElement) ? document.activeElement : null;
        const focusedField = focused?.dataset?.field;
        const focusedImageId = focused?.dataset?.imageId;
        const focusedIpIndex = focused?.dataset?.ipIndex;
        const focusedIpField = focused?.dataset?.ipField;
        const focusedPortField = focused?.closest('.ledger-sheet-panel-ports');
        const ipsExpanded = body.dataset.deviceId === String(device.id) &&
            body.querySelector('.device-ip-editor')?.dataset.expanded === 'true';
        const selectionStart = typeof focused?.selectionStart === 'number' ? focused.selectionStart : null;
        const selectionEnd = typeof focused?.selectionEnd === 'number' ? focused.selectionEnd : null;
        if (body.dataset.deviceId !== String(device.id)) portTab.clear();
        closeDeviceTypePicker();
        body.replaceChildren();
        const tabs = document.getElementById('ledger-sheet-tabs');
        const isAdmin = isCurrentUserAdmin();
        const previousTab = body.dataset.deviceId === String(device.id) ||
            (!overlay.hidden && ['config', 'ports'].includes(body.dataset.activeTab))
            ? (body.dataset.activeTab || 'primary')
            : 'primary';
        body.dataset.deviceId = String(device.id);
        tabs?.replaceChildren();
        const tabDefs = [
            { key: 'primary', label: '機器・設置・資産' },
            { key: 'secondary', label: '管理・保守・状態' },
            { key: 'ports', label: portTabLabel(device.id) },
            ...(isAdmin ? [{ key: 'config', label: 'Config管理' }] : [])
        ];
        const panels = [];
        const tabButtons = [];
        let configPanel = null;
        function activateTab(index) {
            const target = tabDefs[index] || tabDefs[0];
            body.dataset.activeTab = target.key;
            if (target.key === 'ports') portTab.mount(panels[index], Number(device.id));
            panels.forEach((panel, i) => { panel.hidden = i !== index; });
            tabButtons.forEach((button, i) => {
                button.setAttribute('aria-selected', String(i === index));
                button.tabIndex = i === index ? 0 : -1;
            });
            if (isAdmin) {
                configTab.setActive(target.key === 'config');
            }
        }
        activateSheetTab = key => {
            const index = tabDefs.findIndex(tab => tab.key === key);
            if (index >= 0) activateTab(index);
        };
        async function requestTab(index, focus = false) {
            const key = tabDefs[index].key;
            if (body.dataset.activeTab === 'ports' && key !== 'ports') {
                if (!await portTab.confirmLeave() || getActiveDeviceId() !== Number(device.id)) return;
            }
            activateSheetTab(key);
            if (focus) tabs?.querySelector(`[data-tab-key="${key}"]`)?.focus();
        }
        tabDefs.forEach((tabDef, index) => {
            const panel = document.createElement('div');
            panel.id = `ledger-sheet-panel-${index}`;
            panel.className = `ledger-sheet-panel${['config', 'ports'].includes(tabDef.key) ? ` ledger-sheet-panel-${tabDef.key}` : ''}`;
            panel.dataset.tabKey = tabDef.key;
            panel.setAttribute('role', 'tabpanel');
            panel.setAttribute('aria-labelledby', `ledger-sheet-tab-${index}`);
            panels.push(panel);
            body.appendChild(panel);
            if (tabDef.key === 'config') configPanel = panel;
            const button = document.createElement('button');
            button.id = `ledger-sheet-tab-${index}`;
            button.type = 'button';
            button.dataset.tabKey = tabDef.key;
            button.textContent = tabDef.label;
            button.setAttribute('role', 'tab');
            button.setAttribute('aria-controls', panel.id);
            button.addEventListener('click', () => requestTab(index));
            button.addEventListener('keydown', async event => {
                let next;
                if (event.key === 'ArrowRight') next = (index + 1) % tabButtons.length;
                else if (event.key === 'ArrowLeft') next = (index - 1 + tabButtons.length) % tabButtons.length;
                else if (event.key === 'Home') next = 0;
                else if (event.key === 'End') next = tabButtons.length - 1;
                else return;
                event.preventDefault();
                await requestTab(next, true);
            });
            tabButtons.push(button);
            tabs?.appendChild(button);
        });
        const initialTab = tab === 'ports' ? tab : previousTab;
        const initialIndex = Math.max(0, tabDefs.findIndex(tabDef => tabDef.key === initialTab));
        if (isAdmin && configPanel) {
            configTab.mount(configPanel, storedDevice || device, { isActive: tabDefs[initialIndex]?.key === 'config' });
        } else {
            configTab.clear();
        }
        activateTab(initialIndex);
        function createSheetRow(label, inputEl) {
            const tr = document.createElement('div');
            tr.className = 'ledger-sheet-field';
            const th = document.createElement('label');
            th.textContent = label;
            const td = document.createElement('div');
            if (typeof inputEl !== 'string') {
                const control = ['INPUT', 'SELECT', 'TEXTAREA'].includes(inputEl.tagName) ? inputEl : null;
                if (control) {
                    if (!control.id) control.id = `ledger-sheet-field-${control.dataset.field}`;
                    th.setAttribute('for', control.id);
                }
            }
            if (typeof inputEl === 'string') {
                td.textContent = inputEl;
            } else {
                td.appendChild(inputEl);
                if (inputEl.dataset?.field && inputEl.dataset.field !== 'additional_ips') {
                    const error = document.createElement('div');
                    error.id = `ledger-sheet-${inputEl.dataset.field}-error`;
                    error.className = 'form-error';
                    error.hidden = true;
                    td.appendChild(error);
                }
            }
            tr.appendChild(th);
            tr.appendChild(td);
            return tr;
        }

        function createSheetInput(field, maxLength = 100) {
            const input = document.createElement('input');
            input.type = 'text';
            input.dataset.field = field;
            const val = String(device[field] || '');
            input.value = val;
            input.dataset.maxLength = String(maxLength);
            input.readOnly = !isAdmin;
            if (!isAdmin) {
                input.title = val ? `${val} (閲覧専用)` : '閲覧専用です';
            } else {
                input.title = val;
            }

            bindSheetDraftInput(input, field);
            bindLocationSuggestion(input, field);

            return input;
        }

        function createSheetSection(titleText, contentEl, rightElement = null) {
            const details = document.createElement('section');
            details.className = 'ledger-sheet-section';
            const summary = document.createElement('div');
            summary.className = 'ledger-sheet-section-summary';
            const title = document.createElement('h4');
            title.textContent = titleText;
            summary.appendChild(title);

            if (rightElement) {
                const rightWrap = document.createElement('div');
                rightWrap.className = 'ledger-sheet-summary-right';
                rightWrap.appendChild(rightElement);
                summary.appendChild(rightWrap);
            }

            const contentWrap = document.createElement('div');
            contentWrap.className = 'ledger-sheet-content';
            contentWrap.appendChild(contentEl);

            details.appendChild(summary);
            details.appendChild(contentWrap);
            return details;
        }

        // ① 基本情報セクション
        const basicTable = document.createElement('div');
        basicTable.className = 'ledger-sheet-table';
        basicTable.appendChild(createSheetRow('機器名称', createSheetInput('name', 100)));

        const typePicker = createDeviceTypePicker({
            deviceId: device.id, value: device.type, disabled: !isAdmin,
            onChange: input => {
                updateDraft('sheet', getActiveDeviceId(), 'type', input.value);
            }
        });
        bindSheetDraftInput(typePicker.control, 'type');
        basicTable.appendChild(createSheetRow('機器種別', typePicker.element));

        const ipInput = createSheetInput('ip', 45);
        const ipRow = createSheetRow('管理IPv4アドレス', ipInput);
        ipInput.parentElement.appendChild(createIpDuplicateNotice({
            getRecord: () => getDeviceDraft('sheet', getActiveDeviceId()),
            field: 'ip_segment_id', ipInput,
            canEdit: () => getActiveDeviceId() !== null && isCurrentUserAdmin() && !appState.authExpired && !appState.isPinging &&
                !hasResourceConflict('devices', getActiveDeviceId()),
            onChange: () => eventBus.emit('device-drafts:changed')
        }));
        basicTable.appendChild(ipRow);
        basicTable.appendChild(createSheetRow('追加IPv4アドレス', createDeviceIpEditor({
            compact: true, expanded: ipsExpanded,
            getDevice: () => getDeviceDraft('sheet', getActiveDeviceId()),
            canEdit: () => getActiveDeviceId() !== null && isCurrentUserAdmin() && !appState.authExpired && !appState.isPinging &&
                !hasResourceConflict('devices', getActiveDeviceId()),
            onChange: () => eventBus.emit('device-drafts:changed')
        })));
        const deviceIdLabel = document.createElement('span');
        deviceIdLabel.className = 'form-support';
        deviceIdLabel.textContent = `機器ID: ${device.id}`;
        panels[0].appendChild(createSheetSection('基本情報・IPアドレス', basicTable, deviceIdLabel));

        // ② 設置・配置情報セクション
        const placeTable = document.createElement('div');
        placeTable.className = 'ledger-sheet-table ledger-sheet-placement-fields';
        const floorSelect = document.createElement('select');
        floorSelect.dataset.field = 'floor_id';
        populateFloorSelect(floorSelect, appState, device.floor_id);
        floorSelect.disabled = !isAdmin;
        bindSheetDraftInput(floorSelect, 'floor_id');
        const floorRow = createSheetRow('設置フロア', floorSelect);
        placeTable.appendChild(floorRow);
        const floorSupport = document.createElement('div');
        floorSupport.className = 'ledger-sheet-field ledger-sheet-floor-support';
        const legacy = document.createElement('div');
        legacy.id = 'ledger-sheet-legacy-location';
        legacy.hidden = device.floor_id != null || !(device.facility || device.floor);
        const legacyHeading = document.createElement('h5');
        legacyHeading.textContent = '移行前の設置情報';
        const legacyValues = document.createElement('p');
        legacyValues.textContent = [
            device.facility ? `旧施設：${device.facility}` : '',
            device.floor ? `旧フロア：${device.floor}` : ''
        ].filter(Boolean).join(' / ');
        const legacyNotice = document.createElement('p');
        legacyNotice.className = 'form-support';
        legacyNotice.textContent = '現在の所属ではありません';
        legacy.append(legacyHeading, legacyValues, legacyNotice);
        floorSupport.appendChild(legacy);
        if (isAdmin) {
            const manage = document.createElement('button');
            manage.id = 'ledger-sheet-hierarchy-manage-btn';
            manage.type = 'button';
            manage.className = 'ledger-sheet-hierarchy-link';
            manage.textContent = '建物・フロアを管理';
            manage.disabled = appState.authExpired || appState.isPinging || tabBusy;
            manage.addEventListener('click', async () => {
                const id = getActiveDeviceId();
                if (!isCurrentUserAdmin() || appState.authExpired || appState.isPinging || id == null) return;
                manage.disabled = true;
                try {
                    if (!await confirmSheetNavigation({ saveBeforeLeaving: true })) return;
                    const current = getDeviceById(id);
                    if (!isCurrentUserAdmin() || appState.authExpired || getActiveDeviceId() !== id || !current) return;
                    renderLedgerDeviceSheet(current);
                    document.getElementById('ledger-sheet-hierarchy-manage-btn')?.focus();
                    openViewManager();
                } finally {
                    manage.disabled = false;
                }
            });
            floorSelect.parentElement.appendChild(manage);
        }
        placeTable.appendChild(floorSupport);
        placeTable.appendChild(createSheetRow('設置場所詳細', createSheetInput('location', 150)));

        const viewsWrap = document.createElement('div');
        viewsWrap.className = 'ledger-sheet-view-pills';
        renderSheetDestinations(viewsWrap, device.id);
        placeTable.appendChild(createSheetRow('配置済みビュー', viewsWrap));
        panels[0].appendChild(createSheetSection('設置・配置情報', placeTable));

        // ③ 資産情報セクション
        const assetTable = document.createElement('div');
        assetTable.className = 'ledger-sheet-table ledger-sheet-asset-fields';
        assetTable.appendChild(createSheetRow('メーカー', createSheetInput('manufacturer', 100)));
        assetTable.appendChild(createSheetRow('型番', createSheetInput('model', 100)));
        assetTable.appendChild(createSheetRow('管理番号', createSheetInput('asset_number', 100)));
        assetTable.appendChild(createSheetRow('シリアル番号', createSheetInput('serial_number', 100)));
        assetTable.appendChild(createSheetRow('MACアドレス', createSheetInput('mac_address', 50)));
        assetTable.appendChild(createSheetRow('導入年月', createSheetInput('install_date', 10)));
        panels[0].appendChild(createSheetSection('機器・資産情報', assetTable));

        // ④ 管理・保守情報セクション
        const maintTable = document.createElement('div');
        maintTable.className = 'ledger-sheet-table';
        maintTable.appendChild(createSheetRow('担当部署', createSheetInput('department', 100)));
        maintTable.appendChild(createSheetRow('保守ベンダー', createSheetInput('maintenance_vendor', 100)));
        maintTable.appendChild(createSheetRow('保守期限', createSheetInput('maintenance_expiry', 10)));

        const schemeSelect = document.createElement('select');
        schemeSelect.dataset.field = 'management_scheme';
        schemeSelect.disabled = !isAdmin;
        [
            { value: '', label: '未設定' },
            { value: 'https', label: 'HTTPS' },
            { value: 'http', label: 'HTTP' },
            { value: 'ssh', label: 'SSH' },
        ].forEach(opt => {
            const option = document.createElement('option');
            option.value = opt.value;
            option.textContent = opt.label;
            if (String(device.management_scheme || '') === opt.value) option.selected = true;
            schemeSelect.appendChild(option);
        });
        bindSheetDraftInput(schemeSelect, 'management_scheme');
        maintTable.appendChild(createSheetRow('管理接続方式', schemeSelect));

        const portInput = document.createElement('input');
        portInput.type = 'number';
        portInput.min = '1';
        portInput.max = '65535';
        portInput.dataset.field = 'management_port';
        portInput.value = device.management_port != null ? String(device.management_port) : '';
        portInput.readOnly = !isAdmin;
        bindSheetDraftInput(portInput, 'management_port');
        maintTable.appendChild(createSheetRow('接続ポート', portInput));
        const maintenanceSection = createSheetSection('管理・保守情報', maintTable);
        maintenanceSection.classList.add('ledger-sheet-maintenance');
        panels[1].appendChild(maintenanceSection);

        // ⑤ 監視・Ping疎通セクション
        const monTable = document.createElement('div');
        monTable.className = 'ledger-sheet-table';
        const statusPill = document.createElement('span');
        const normStatus = normalizeStatus(device.status);
        statusPill.className = `ledger-status-pill ledger-status-${normStatus}`;
        statusPill.textContent = getDeviceStatusLabel(normStatus);
        monTable.appendChild(createSheetRow('疎通状態', statusPill));
        monTable.appendChild(createSheetRow('最終確認日時', device.last_checked_at || '-'));
        monTable.appendChild(createSheetRow('応答時間', device.last_response_ms == null ? '-' : `${device.last_response_ms} ms`));

        const errorSpan = document.createElement('span');
        errorSpan.textContent = device.last_error || '-';
        if (device.last_error) {
            errorSpan.style.color = 'var(--danger)';
        }
        monTable.appendChild(createSheetRow('直近エラー', errorSpan));
        const pingHelpButton = document.createElement('button');
        pingHelpButton.id = 'ledger-sheet-ping-help-btn';
        pingHelpButton.type = 'button';
        pingHelpButton.className = 'btn btn-tertiary btn-sm';
        pingHelpButton.textContent = 'Ping結果について';
        pingHelpButton.setAttribute('aria-haspopup', 'dialog');
        pingHelpButton.setAttribute('aria-controls', 'ping-help-dialog');
        pingHelpButton.addEventListener('click', openPingHelpDialog);
        panels[1].appendChild(createSheetSection('監視・疎通状態', monTable, pingHelpButton));

        // ⑥ 備考セクション
        const memoTable = document.createElement('div');
        memoTable.className = 'ledger-sheet-table';
        const memoTextarea = document.createElement('textarea');
        memoTextarea.dataset.field = 'memo';
        const memoVal = String(device.memo || '');
        memoTextarea.value = memoVal;
        memoTextarea.dataset.maxLength = '1000';
        memoTextarea.readOnly = !isAdmin;
        memoTextarea.rows = 4;
        if (!isAdmin) {
            memoTextarea.title = memoVal ? `${memoVal} (閲覧専用)` : '閲覧専用です';
        } else {
            memoTextarea.title = memoVal;
        }
        bindSheetDraftInput(memoTextarea, 'memo');
        memoTable.appendChild(createSheetRow('備考内容', memoTextarea));
        panels[1].appendChild(createSheetSection('備考', memoTable));

        // ⑦ 登録画像セクション
        const images = (appState.deviceImages || [])
            .filter(img => Number(img.device_id) === Number(device.id))
            .sort((a, b) => Number(a.sort_order) - Number(b.sort_order));

        const imageBlockReason = !isAdmin ? '閲覧専用のため画像を登録できません' : getDeviceImageBlockReason(device.id);

        const imagesWrap = document.createElement('div');
        const imageSupport = document.createElement('p');
        imageSupport.className = 'form-support ledger-sheet-image-support';
        const imageCapacity = window.APP_CONFIG?.capacity;
        const maxImageMiB = Math.floor((Number(imageCapacity?.deviceImageMaxBytes) || 10 * 1024 * 1024) / (1024 * 1024));
        const maxImageWidth = Number(imageCapacity?.deviceImageMaxWidth) || 4000;
        const maxImageHeight = Number(imageCapacity?.deviceImageMaxHeight) || 4000;
        const textSpan = document.createElement('span');
        textSpan.className = 'ledger-sheet-image-limits';
        textSpan.textContent = `PNGまたはJPEG／最大${maxImageMiB}MiB／最大${maxImageWidth}×${maxImageHeight}px`;
        const helpLine = document.createElement('span');
        helpLine.className = 'ledger-sheet-image-help';
        const helpIntro = document.createElement('span');
        helpIntro.textContent = '画像の登録・操作方法は';
        const helpLink = document.createElement('a');
        helpLink.href = 'help-devices.html#devices';
        helpLink.target = '_blank';
        helpLink.rel = 'noopener';
        helpLink.textContent = 'ヘルプ';
        const textAfter = document.createElement('span');
        textAfter.textContent = 'を参照してください。';
        imageSupport.appendChild(textSpan);
        helpLine.appendChild(helpIntro);
        helpLine.appendChild(helpLink);
        helpLine.appendChild(textAfter);
        imageSupport.appendChild(helpLine);
        const grid = document.createElement('div');
        grid.className = 'ledger-sheet-images-grid';

            images.forEach((img, idx) => {
                const card = document.createElement('div');
                card.className = 'ledger-sheet-image-card';

                const thumbWrap = document.createElement('div');
                thumbWrap.className = 'ledger-sheet-image-thumb-wrap';
                thumbWrap.title = 'クリックして拡大';

                const thumbImg = document.createElement('img');
                thumbImg.src = `${img.image_url}&size=thumb`;
                thumbImg.alt = img.caption || `機器画像 ${idx + 1}`;
                thumbImg.className = 'ledger-sheet-image-thumb';
                thumbImg.loading = 'lazy';

                const zoomBtn = document.createElement('button');
                zoomBtn.type = 'button';
                zoomBtn.className = 'ledger-sheet-image-zoom-trigger';
                zoomBtn.textContent = '🔍 拡大';
                zoomBtn.title = '拡大表示';
                zoomBtn.setAttribute('aria-label', `${img.caption || `画像${idx + 1}`}を拡大表示`);

                thumbWrap.addEventListener('click', () => {
                    openDeviceImageZoom(img);
                });
                zoomBtn.addEventListener('click', e => {
                    e.stopPropagation();
                    openDeviceImageZoom(img);
                });

                thumbWrap.appendChild(thumbImg);
                thumbWrap.appendChild(zoomBtn);
                card.appendChild(thumbWrap);

                const captionInput = document.createElement('input');
                captionInput.type = 'text';
                captionInput.className = 'ledger-sheet-image-caption-input';
                captionInput.value = img.caption || '';
                captionInput.dataset.maxLength = '100';
                captionInput.dataset.imageId = String(img.id);
                captionInput.placeholder = '説明（100文字以内）';
                captionInput.disabled = !isAdmin || Boolean(imageBlockReason);
                captionInput.setAttribute('aria-label', `画像${idx + 1}の説明`);
                const captionErrorEl = bindDeviceImageCaptionInput(captionInput, {
                    deviceId: device.id, imageId: img.id, errorId: `sheet-image-${img.id}-caption-error`,
                    onSave: value => updateImageCaption(Number(device.id), Number(img.id), value)
                });
                card.appendChild(captionInput);
                card.appendChild(captionErrorEl);

                if (isAdmin) {
                    const actionsWrap = document.createElement('div');
                    actionsWrap.className = 'ledger-sheet-image-actions';
                    for (const [offset, label] of [[-1, '前へ'], [1, '次へ']]) {
                        if (!images[idx + offset]) continue;
                        const move = document.createElement('button');
                        move.type = 'button';
                        move.className = 'btn btn-secondary btn-sm ledger-sheet-image-move ledger-sheet-image-icon-action';
                        move.textContent = offset < 0 ? '←' : '→';
                        move.setAttribute('aria-label', `画像${idx + 1}を${label}移動`);
                        move.title = `画像${idx + 1}を${label}移動`;
                        move.disabled = Boolean(imageBlockReason);
                        move.addEventListener('click', () => {
                            const reordered = [...images];
                            [reordered[idx], reordered[idx + offset]] = [reordered[idx + offset], reordered[idx]];
                            reorderDeviceImages(Number(device.id), reordered);
                        });
                        actionsWrap.appendChild(move);
                    }

                    const replaceBtn = document.createElement('button');
                    replaceBtn.type = 'button';
                    replaceBtn.className = 'btn btn-secondary btn-sm ledger-sheet-image-replace';
                    replaceBtn.textContent = '差替え';
                    replaceBtn.title = '別の画像に差替えます';
                    replaceBtn.disabled = Boolean(imageBlockReason);
                    replaceBtn.addEventListener('click', () => {
                        triggerSheetImageUpload(Number(img.id));
                    });
                    actionsWrap.appendChild(replaceBtn);

                    const deleteBtn = document.createElement('button');
                    deleteBtn.type = 'button';
                    deleteBtn.className = 'btn btn-secondary btn-sm btn-danger ledger-sheet-image-delete ledger-sheet-image-icon-action';
                    deleteBtn.setAttribute('aria-label', `画像${idx + 1}を削除`);
                    deleteBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>';
                    deleteBtn.title = 'この画像を削除します';
                    deleteBtn.disabled = Boolean(imageBlockReason);
                    deleteBtn.addEventListener('click', () => {
                        deleteDeviceImage(Number(device.id), Number(img.id));
                    });
                    actionsWrap.appendChild(deleteBtn);

                    card.appendChild(actionsWrap);
                }

                grid.appendChild(card);
            });
        for (let index = images.length; index < 3; index++) {
            const slot = document.createElement('div');
            slot.className = 'ledger-sheet-image-card ledger-sheet-image-empty';
            const add = document.createElement('button');
            add.type = 'button';
            add.className = 'ledger-sheet-image-slot-add';
            add.textContent = '＋ 画像を追加';
            add.setAttribute('aria-label', `画像枠${index + 1}に画像を追加`);
            add.disabled = Boolean(imageBlockReason);
            add.title = imageBlockReason || '画像ファイルを選択して登録';
            add.addEventListener('click', () => triggerSheetImageUpload());
            slot.appendChild(add);
            const reason = document.createElement('span');
            reason.className = 'form-support ledger-sheet-image-block-reason';
            reason.textContent = imageBlockReason;
            reason.hidden = !imageBlockReason;
            slot.appendChild(reason);
            grid.appendChild(slot);
        }
        imagesWrap.appendChild(grid);

        imagesWrap.appendChild(imageSupport);
        panels[0].appendChild(createSheetSection('登録画像', imagesWrap));
        if (hasDeviceDraftChanges('sheet', device.id)) showSheetFieldErrors(validateDeviceValues(device).errors);
        if (focusedIpIndex !== undefined) {
            const input = body.querySelector(`[data-ip-index="${focusedIpIndex}"][data-ip-field="${focusedIpField}"]`);
            if (input) {
                input.focus();
                if (selectionStart !== null) input.setSelectionRange(selectionStart, selectionEnd);
            }
        } else if (focusedField) {
            const input = body.querySelector(`[data-field="${focusedField}"]`);
            if (input) {
                input.focus();
                if (selectionStart !== null && typeof input.setSelectionRange === 'function') {
                    try { input.setSelectionRange(selectionStart, selectionEnd); } catch (_) {}
                }
            }
        } else if (focusedImageId) {
            const input = body.querySelector(`[data-image-id="${focusedImageId}"]`);
            if (input) {
                input.focus();
                if (selectionStart !== null && typeof input.setSelectionRange === 'function') {
                    try { input.setSelectionRange(selectionStart, selectionEnd); } catch (_) {}
                }
            }
        } else if (focusedPortField && body.dataset.activeTab === 'ports' && focused.isConnected) {
            focused.focus();
        }
    }

    function renderSheetDestinations(wrapper, deviceId) {
        const destinations = getDeviceDestinations(deviceId, appState.placements, getRackDeviceMounts(appState), appState.views);
        wrapper.replaceChildren();
        if (!destinations.length) {
            const empty = document.createElement('span');
            empty.className = 'form-support';
            empty.textContent = '未配置（どのビューにも配置されていません）';
            wrapper.appendChild(empty);
            return;
        }
        for (const { view, kind, mount } of destinations) {
            const path = viewHierarchyPath(view, appState);
            const pill = document.createElement('button');
            pill.className = 'ledger-sheet-view-pill';
            pill.type = 'button';
            pill.textContent = `${path} / ${view.name}`;
            pill.setAttribute('aria-label', `${view.name}でこの機器を表示`);
            pill.addEventListener('click', () => showLedgerDestination(Number(deviceId), Number(view.id)));
            if (kind === 'rack') {
                pill.textContent += `（ラック / ${mount.shelf_name ? `${mount.shelf_name} / ` : ''}${mount.start_u}〜${Number(mount.start_u) + Number(mount.height_u) - 1}U）`;
                pill.title = [path, (appState.rackSettings || []).find(row => Number(row.view_id) === Number(view.id))?.location,
                    '搭載しても台帳の設置フロア・設置場所は変更しません'].filter(Boolean).join(' / ');
            } else {
                pill.title = `${path} / クリックしてこのビューで表示`;
            }
            wrapper.appendChild(pill);
        }
    }

    return {
        renderLedgerDeviceSheet, focusLedgerSheetField, triggerSheetImageUpload,
        commitSheetDraft, confirmSheetNavigation, confirmOpenPortsTab,
        isSheetTabBusy, openSheetConnection: portTab.openConnection,
        clearSheetTabs: () => { configTab.clear(); portTab.clear(); },
        closeConfigMoreMenu: () => configTab.closeMoreMenu({ restoreFocus: true }),
        remapConfigDeviceId: mapped => configTab.remapDeviceId(mapped),
        getConfigLoadPromise: () => configTab.getLoadPromise(),
        hasUnsavedSheetTabDraft: () => configTab.hasUnsavedDraft() || portTab.hasUnsavedDraft(),
        hasUnsavedPortDraft: portTab.hasUnsavedDraft
    };
}
