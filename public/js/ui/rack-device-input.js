import { DEVICE_TYPES } from '../core/constants.js';
import { appState } from '../core/state.js';
import { getDefaultDeviceName } from '../core/device-defaults.js';
import { createDeviceTypePicker, closeDeviceTypePicker } from './device-type-picker.js';

export function createRackDeviceInput({
    idPrefix, deviceId = null, getDevices = () => appState.devices,
    searchText = device => `${device.name} ${device.ip || ''}`,
    locationText = () => '', canChange = () => true, onChange = () => {}
}) {
    const locked = deviceId != null;
    const element = document.createElement('div');
    element.className = 'rack-device-input';
    const modes = document.createElement('div');
    modes.className = 'rack-device-modes';
    modes.hidden = locked;
    const existing = document.createElement('div');
    existing.className = 'rack-device-existing';
    existing.hidden = locked;
    const summary = document.createElement('div');
    summary.className = 'rack-device-summary';
    summary.setAttribute('aria-label', '選択した機器');
    summary.hidden = true;
    const selectionDetails = document.createElement('div');
    selectionDetails.className = 'rack-device-selection-details';
    selectionDetails.appendChild(summary);
    const fresh = document.createElement('div');
    fresh.className = 'rack-device-new';
    fresh.hidden = true;
    let mode = 'existing';
    let selectedId = deviceId;
    let candidatesOpen = false;
    let activeIndex = -1;
    let matches = [];
    let optionElements = [];
    let focusingMode = false;

    function field(parent, labelText, control, suffix) {
        control.id = `${idPrefix}-${suffix}`;
        const label = document.createElement('label');
        label.htmlFor = control.id;
        label.textContent = labelText;
        const group = document.createElement('div');
        group.className = 'rack-mount-field';
        group.append(label, control);
        parent.appendChild(group);
        return control;
    }
    function modeButton(label, value) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn btn-secondary btn-sm';
        button.id = `${idPrefix}-${value}-mode`;
        button.textContent = label;
        button.setAttribute('aria-pressed', String(value === mode));
        button.addEventListener('click', () => {
            if (locked || !canChange() || mode === value) return;
            mode = value;
            selectedId = null;
            search.value = acceptedSearch = '';
            syncSummary();
            hideCandidates();
            closeDeviceTypePicker();
            existing.hidden = locked || mode !== 'existing';
            fresh.hidden = mode !== 'new';
            existingButton.setAttribute('aria-pressed', String(mode === 'existing'));
            newButton.setAttribute('aria-pressed', String(mode === 'new'));
            focusingMode = true;
            (mode === 'existing' ? search : type).focus();
            focusingMode = false;
            onChange();
        });
        modes.appendChild(button);
        return button;
    }
    const existingButton = modeButton('既存機器から選択', 'existing');
    const newButton = modeButton('新しい機器を登録', 'new');
    const filterPicker = createDeviceTypePicker({ value: '', includeAll: true, disabled: locked, onChange: changeFilter });
    const filter = field(existing, '種別で絞り込み', filterPicker.control, 'filter');
    const search = field(existing, '機器名・IPアドレスで検索', document.createElement('input'), 'search');
    search.type = 'text';
    search.autocomplete = 'off';
    search.readOnly = locked;
    search.setAttribute('role', 'combobox');
    search.setAttribute('aria-autocomplete', 'list');
    search.setAttribute('aria-haspopup', 'listbox');
    search.setAttribute('aria-expanded', 'false');
    const region = document.createElement('div');
    region.className = 'rack-device-candidate-region';
    region.hidden = true;
    const candidates = document.createElement('div');
    candidates.id = `${idPrefix}-candidates`;
    candidates.className = 'rack-device-candidates';
    candidates.setAttribute('role', 'listbox');
    candidates.setAttribute('aria-label', '既存機器の候補');
    candidates.hidden = true;
    search.setAttribute('aria-controls', candidates.id);
    region.appendChild(candidates);

    const picker = createDeviceTypePicker({ value: 'switch', onChange: changeType });
    const type = picker.control;
    field(fresh, '種別', type, 'type');
    const name = field(fresh, '機器名', document.createElement('input'), 'name');
    name.type = 'text';
    name.value = getDefaultDeviceName(type.value);
    name.maxLength = 100;
    const ip = field(fresh, 'IPアドレス（任意）', document.createElement('input'), 'ip');
    ip.type = 'text';
    ip.maxLength = 45;
    let acceptedType = type.value;
    let acceptedName = name.value;
    let acceptedIp = ip.value;
    let acceptedFilter = filter.value;
    search.value = locked ? getDevices().find(device => String(device.id) === String(deviceId))?.name || '' : '';
    let acceptedSearch = search.value;
    element.append(modes, existing, selectionDetails, region, fresh);
    syncSummary();

    function syncSummary() {
        const device = mode === 'existing' && selectedId != null
            ? getDevices().find(candidate => String(candidate.id) === String(selectedId)) : null;
        summary.hidden = !device;
        selectionDetails.hidden = !device;
        summary.replaceChildren();
        if (!device) return;
        const definition = DEVICE_TYPES[device.type] || DEVICE_TYPES.other;
        const icon = document.createElement('img');
        icon.className = 'device-type-icon';
        icon.src = definition.icon;
        icon.alt = '';
        const main = document.createElement('span');
        main.className = 'rack-device-option-main';
        const title = document.createElement('span');
        title.className = 'rack-device-option-name';
        title.textContent = device.name;
        const detail = document.createElement('small');
        detail.className = 'rack-device-option-detail';
        detail.textContent = `${definition.label} / ${device.ip || 'IP未設定'}`;
        main.append(title, detail);
        summary.append(icon, main);
    }

    function positionCandidates() {
        const rect = search.getBoundingClientRect();
        const bottom = rect.top + rect.height;
        const space = Math.max(0, window.innerHeight - bottom - 16);
        Object.assign(region.style, {
            left: `${rect.left}px`, top: `${bottom + 4}px`, width: `${rect.width}px`,
            height: `${Math.min(280, window.innerHeight * 0.3, space)}px`
        });
    }
    function hideCandidates() {
        candidatesOpen = false;
        candidates.hidden = true;
        region.hidden = true;
        window.removeEventListener?.('resize', positionCandidates);
        window.removeEventListener?.('scroll', positionCandidates, true);
        activeIndex = -1;
        search.setAttribute('aria-expanded', 'false');
        search.removeAttribute('aria-activedescendant');
    }
    function setActive(index) {
        if (!optionElements.length) return;
        activeIndex = (index + optionElements.length) % optionElements.length;
        optionElements.forEach((option, position) => option.classList.toggle('is-active', position === activeIndex));
        const option = optionElements[activeIndex];
        search.setAttribute('aria-activedescendant', option.id);
        option.scrollIntoView({ block: 'nearest' });
    }
    function matchingDevices() {
        const query = search.value.trim().toLocaleLowerCase();
        return getDevices().filter(device => (!filter.value || device.type === filter.value) &&
            String(searchText(device)).toLocaleLowerCase().includes(query));
    }
    function choose(device) {
        if (locked || mode !== 'existing' || !canChange()) return;
        selectedId = device.id;
        search.value = acceptedSearch = device.name;
        search.focus();
        hideCandidates();
        syncSummary();
        onChange();
    }
    function openCandidates() {
        if (locked || focusingMode || mode !== 'existing' || !canChange()) return;
        closeDeviceTypePicker();
        matches = matchingDevices();
        candidates.replaceChildren();
        search.removeAttribute('aria-activedescendant');
        optionElements = matches.map(device => {
            const option = document.createElement('button');
            option.type = 'button';
            option.id = `${idPrefix}-option-${device.id}`;
            option.className = 'rack-device-option';
            option.tabIndex = -1;
            option.setAttribute('role', 'option');
            option.setAttribute('aria-selected', String(String(device.id) === String(selectedId)));
            const definition = DEVICE_TYPES[device.type] || DEVICE_TYPES.other;
            const icon = document.createElement('img');
            icon.className = 'device-type-icon';
            icon.src = definition.icon;
            icon.alt = '';
            const main = document.createElement('span');
            main.className = 'rack-device-option-main';
            const title = document.createElement('span');
            title.className = 'rack-device-option-name';
            title.textContent = device.name;
            const detail = document.createElement('small');
            detail.className = 'rack-device-option-detail';
            const location = locationText(device);
            detail.textContent = [definition.label, device.ip || 'IP未設定', location ? `現在：${location}` : ''].filter(Boolean).join(' / ');
            main.append(title, detail);
            option.append(icon, main);
            option.addEventListener('pointerdown', event => event.preventDefault());
            option.addEventListener('click', () => choose(device));
            candidates.appendChild(option);
            return option;
        });
        if (!matches.length) {
            const empty = document.createElement('p');
            empty.textContent = '該当する機器がありません';
            candidates.appendChild(empty);
        }
        candidatesOpen = true;
        candidates.hidden = false;
        region.hidden = false;
        positionCandidates();
        window.addEventListener('resize', positionCandidates);
        window.addEventListener('scroll', positionCandidates, true);
        search.setAttribute('aria-expanded', 'true');
        activeIndex = -1;
        setActive(Math.max(0, matches.findIndex(device => String(device.id) === String(selectedId))));
    }
    search.addEventListener('focus', openCandidates);
    search.addEventListener('click', openCandidates);
    search.addEventListener('blur', hideCandidates);
    filter.addEventListener('blur', hideCandidates);
    filter.addEventListener('focus', hideCandidates);
    search.addEventListener('input', () => {
        if (locked || mode !== 'existing' || !canChange()) { search.value = acceptedSearch; return; }
        acceptedSearch = search.value;
        selectedId = null;
        syncSummary();
        openCandidates();
        onChange();
    });
    function changeFilter() {
        if (locked || mode !== 'existing' || !canChange()) {
            createDeviceTypePicker({ control: filter, value: acceptedFilter, includeAll: true, disabled: locked, onChange: changeFilter });
            return;
        }
        acceptedFilter = filter.value;
        createDeviceTypePicker({ control: filter, value: acceptedFilter, includeAll: true, onChange: changeFilter });
        if (!matchingDevices().some(device => String(device.id) === String(selectedId))) selectedId = null;
        syncSummary();
        openCandidates();
        onChange();
    }
    filter.addEventListener('change', changeFilter);
    search.addEventListener('keydown', event => {
        if (event.isComposing || event.keyCode === 229) return;
        if (event.key === 'Tab') { hideCandidates(); return; }
        if (event.key === 'Escape' && candidatesOpen) {
            event.preventDefault();
            event.stopPropagation();
            hideCandidates();
            return;
        }
        if (locked || mode !== 'existing' || !canChange()) { hideCandidates(); return; }
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            event.preventDefault();
            const wasOpen = candidatesOpen;
            if (!wasOpen) openCandidates();
            if (event.key === 'Home') setActive(0);
            else if (event.key === 'End') setActive(optionElements.length - 1);
            else if (wasOpen) setActive(activeIndex + (event.key === 'ArrowDown' ? 1 : -1));
        } else if (event.key === 'Enter' && candidatesOpen) {
            event.preventDefault();
            if (matches[activeIndex]) choose(matches[activeIndex]);
        }
    });
    function changeType() {
        if (locked || mode !== 'new' || !canChange()) {
            createDeviceTypePicker({ control: type, value: acceptedType, onChange: changeType });
            return;
        }
        if (type.value === acceptedType) return;
        if (name.value === getDefaultDeviceName(acceptedType)) name.value = getDefaultDeviceName(type.value);
        acceptedType = type.value;
        acceptedName = name.value;
        // 直接changeを送る利用側でもピッカーのラベル・アイコンを同期する。
        createDeviceTypePicker({ control: type, value: acceptedType, onChange: changeType });
        onChange();
    }
    type.addEventListener('change', changeType);
    name.addEventListener('input', () => {
        if (locked || mode !== 'new' || !canChange()) { name.value = acceptedName; return; }
        acceptedName = name.value;
        onChange();
    });
    ip.addEventListener('input', () => {
        if (locked || mode !== 'new' || !canChange()) { ip.value = acceptedIp; return; }
        acceptedIp = ip.value;
        onChange();
    });
    function reset() {
        if (locked) return;
        selectedId = null;
        search.value = acceptedSearch = '';
        syncSummary();
        hideCandidates();
        closeDeviceTypePicker();
        createDeviceTypePicker({ control: filter, value: '', includeAll: true, disabled: locked, onChange: changeFilter });
        acceptedFilter = filter.value;
        createDeviceTypePicker({ control: type, value: 'switch', onChange: changeType });
        acceptedType = type.value;
        name.value = acceptedName = getDefaultDeviceName(type.value);
        ip.value = acceptedIp = '';
        onChange();
    }
    function setDisabled(disabled) {
        existingButton.disabled = disabled;
        newButton.disabled = disabled;
        filterPicker.control.disabled = disabled || locked;
        search.disabled = disabled;
        picker.control.disabled = disabled;
        name.disabled = disabled;
        ip.disabled = disabled;
        if (disabled) hideCandidates();
    }
    return {
        element, selectionDetails, search, filter, type, name, ip, hideCandidates, reset, setDisabled,
        get candidatesOpen() { return candidatesOpen; },
        get selectedId() { return selectedId; },
        get mode() { return mode; },
        get values() { return { name: name.value.trim() || getDefaultDeviceName(type.value), ip: ip.value.trim() }; }
    };
}
