import { DEVICE_TYPES } from '../core/constants.js';
import { appState } from '../core/state.js';
import { isCurrentUserAdmin } from './access-control.js';
import { eventBus } from '../core/event-bus.js';

const pickers = new WeakMap();
eventBus.on('save-state:changed', () => {
    if (activePicker && !canChoose(activePicker)) closeDeviceTypePicker();
});

let activePicker = null;
let nextPickerId = 0;
let boundDocument = null;
let boundWindow = null;

function canChoose(picker) {
    return !picker.control.disabled && isCurrentUserAdmin() &&
        !appState.authExpired && !appState.isPinging;
}

export function closeDeviceTypePicker() {
    if (!activePicker) return false;
    const picker = activePicker;
    activePicker = null;
    picker.control.setAttribute('aria-expanded', 'false');
    picker.control.removeAttribute('aria-activedescendant');
    picker.control.removeAttribute('aria-controls');
    picker.popup.remove();
    picker.popup = null;
    picker.options = [];
    picker.activeIndex = -1;
    return true;
}

function positionPopup() {
    const picker = activePicker;
    if (!picker) return;
    if (!picker.control.isConnected || !canChoose(picker)) {
        closeDeviceTypePicker();
        return;
    }
    const rect = picker.control.getBoundingClientRect();
    const viewportWidth = Math.max(0, window.innerWidth);
    const viewportHeight = Math.max(0, window.innerHeight);
    const margin = Math.min(8, viewportWidth / 2, viewportHeight / 2);
    const clamp = (value, min, max) => Math.max(min, Math.min(value, max));
    const width = Math.min(Math.max(rect.width, 240), viewportWidth - margin * 2);
    const belowStart = clamp(rect.bottom + 4, margin, viewportHeight - margin);
    const aboveEnd = clamp(rect.top - 4, margin, viewportHeight - margin);
    const below = viewportHeight - margin - belowStart;
    const above = aboveEnd - margin;
    const upward = above > below && below < 240;
    Object.assign(picker.popup.style, {
        position: 'fixed',
        boxSizing: 'border-box',
        overflowY: 'auto',
        width: `${width}px`,
        left: `${clamp(rect.left, margin, viewportWidth - width - margin)}px`,
        top: upward ? 'auto' : `${belowStart}px`,
        bottom: upward ? `${viewportHeight - aboveEnd}px` : 'auto',
        maxHeight: `${Math.min(280, upward ? above : below)}px`
    });
}

function bindGlobalListeners() {
    if (typeof document !== 'undefined' && boundDocument !== document) {
        boundDocument = document;
        // 行の再描画で増殖しないよう、共有リスナーは開いている候補だけを見る。
        document.addEventListener('pointerdown', event => {
            const picker = activePicker;
            if (picker && !picker.element.contains(event.target) && !picker.popup?.contains(event.target)) {
                closeDeviceTypePicker();
            }
        });
    }
    if (typeof window !== 'undefined' && boundWindow !== window) {
        boundWindow = window;
        window.addEventListener('resize', positionPopup);
        window.addEventListener('scroll', positionPopup, true);
    }
}

function createIcon(type) {
    const icon = document.createElement('img');
    icon.className = 'device-type-icon';
    icon.src = DEVICE_TYPES[type].icon;
    icon.alt = '';
    icon.width = 24;
    icon.height = 24;
    return icon;
}

function syncSelection(picker) {
    const definition = DEVICE_TYPES[picker.control.value] || DEVICE_TYPES.other;
    picker.icon.src = definition.icon;
    picker.label.textContent = definition.label;
    picker.control.setAttribute('aria-label', `種別: ${definition.label}`);
    picker.control.title = definition.label;
    for (const option of picker.options) {
        option.setAttribute('aria-selected', String(option.value === picker.control.value));
    }
}

function setActive(picker, index) {
    if (activePicker !== picker || !picker.options.length) return;
    const count = picker.options.length;
    picker.activeIndex = (index + count) % count;
    picker.options.forEach((option, i) => option.classList.toggle('is-active', i === picker.activeIndex));
    const option = picker.options[picker.activeIndex];
    picker.control.setAttribute('aria-activedescendant', option.id);
    option.scrollIntoView({ block: 'nearest' });
}

function choose(picker, option) {
    if (activePicker !== picker || !option) return;
    if (!canChoose(picker)) {
        closeDeviceTypePicker();
        return;
    }
    picker.control.value = option.value;
    syncSelection(picker);
    closeDeviceTypePicker();
    // 親へ下書きの選択値だけを渡し、確定・保存は各フォームに任せる。
    picker.onChange?.(picker.control);
}

function openPopup(picker) {
    closeDeviceTypePicker();
    if (!canChoose(picker) || !picker.control.isConnected) return;
    const popup = document.createElement('div');
    popup.id = picker.popupId;
    popup.className = 'device-type-options';
    popup.setAttribute('role', 'listbox');
    popup.setAttribute('aria-label', '種別');
    picker.popup = popup;
    picker.options = Object.entries(DEVICE_TYPES).map(([value, definition], index) => {
        const option = document.createElement('button');
        option.type = 'button';
        option.id = `${picker.popupId}-${index}`;
        option.className = 'device-type-option';
        option.value = value;
        option.tabIndex = -1;
        option.setAttribute('role', 'option');
        const label = document.createElement('span');
        label.className = 'device-type-label';
        label.textContent = definition.label;
        option.appendChild(createIcon(value));
        option.appendChild(label);
        option.addEventListener('mouseenter', () => setActive(picker, index));
        option.addEventListener('click', () => choose(picker, option));
        popup.appendChild(option);
        return option;
    });
    // フォーカスを維持し、候補をモーダルのフォーカス境界内に置く。
    popup.addEventListener('pointerdown', event => event.preventDefault());
    (picker.control.closest('[role="dialog"]') || picker.control.closest('.ledger-overlay') || document.body).appendChild(popup);
    activePicker = picker;
    picker.control.setAttribute('aria-expanded', 'true');
    picker.control.setAttribute('aria-controls', picker.popupId);
    syncSelection(picker);
    positionPopup();
    setActive(picker, Math.max(0, picker.options.findIndex(option => option.value === picker.control.value)));
}

export function createDeviceTypePicker({ deviceId, value, disabled = false, onChange, control = null }) {
    bindGlobalListeners();
    if (control && pickers.has(control)) {
        const picker = pickers.get(control);
        if (activePicker === picker) closeDeviceTypePicker();
        control.value = Object.hasOwn(DEVICE_TYPES, value) ? String(value) : 'other';
        control.disabled = Boolean(disabled) || !isCurrentUserAdmin() || Boolean(appState.authExpired) || Boolean(appState.isPinging);
        picker.onChange = onChange;
        syncSelection(picker);
        return { element: picker.element, control };
    }
    const element = control || document.createElement('span');
    if (!control) element.className = 'device-type-picker';
    control ||= document.createElement('button');
    control.type = 'button';
    control.classList.add('device-type-trigger');
    control.value = Object.hasOwn(DEVICE_TYPES, value) ? String(value) : 'other';
    control.dataset.field = 'type';
    if (deviceId != null) control.dataset.deviceId = String(deviceId);
    control.disabled = Boolean(disabled) || !isCurrentUserAdmin() ||
        Boolean(appState.authExpired) || Boolean(appState.isPinging);
    control.setAttribute('role', 'combobox');
    control.setAttribute('aria-label', '種別');
    control.setAttribute('aria-haspopup', 'listbox');
    control.setAttribute('aria-expanded', 'false');
    const popupId = `device-type-options-${++nextPickerId}`;
    const icon = createIcon(control.value);
    const label = document.createElement('span');
    label.className = 'device-type-label';
    control.appendChild(icon);
    control.appendChild(label);
    if (element !== control) element.appendChild(control);
    const picker = { element, control, icon, label, popupId, popup: null, options: [], activeIndex: -1, onChange };
    pickers.set(control, picker);
    syncSelection(picker);
    control.addEventListener('click', () => {
        if (activePicker === picker) closeDeviceTypePicker();
        else openPopup(picker);
    });
    control.addEventListener('blur', () => {
        if (activePicker === picker) closeDeviceTypePicker();
    });
    control.addEventListener('keydown', event => {
        if (event.isComposing || event.keyCode === 229) return;
        if (event.key === 'Escape' && activePicker === picker) {
            event.preventDefault();
            event.stopPropagation();
            closeDeviceTypePicker();
            return;
        }
        if (event.key === 'Tab') {
            if (activePicker === picker) closeDeviceTypePicker();
            return;
        }
        if (!canChoose(picker)) {
            if (activePicker === picker) closeDeviceTypePicker();
            return;
        }
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            event.preventDefault();
            const wasClosed = activePicker !== picker;
            if (wasClosed) openPopup(picker);
            if (event.key === 'Home') setActive(picker, 0);
            else if (event.key === 'End') setActive(picker, picker.options.length - 1);
            else if (!wasClosed) setActive(picker, picker.activeIndex + (event.key === 'ArrowDown' ? 1 : -1));
        } else if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            if (activePicker === picker) choose(picker, picker.options[picker.activeIndex]);
            else openPopup(picker);
        }
    });
    return { element, control };
}
