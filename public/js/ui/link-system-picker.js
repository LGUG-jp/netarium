import { appState } from '../core/state.js';
import { getLinkSystem, syncLinkSystemSwatch } from '../core/link-systems.js';
import { isCurrentUserAdmin } from './access-control.js';
import { eventBus } from '../core/event-bus.js';

const pickers = new WeakMap();
let activePicker = null;
let boundDocument;
let boundWindow;
const canChoose = picker => !picker.control.disabled && isCurrentUserAdmin() && !appState.authExpired;

eventBus.on('auth:expired', closeLinkSystemPicker);
eventBus.on('save-state:changed', () => {
    if (activePicker && !canChoose(activePicker)) closeLinkSystemPicker();
});

export function closeLinkSystemPicker() {
    if (!activePicker) return false;
    const picker = activePicker;
    activePicker = null;
    picker.list.hidden = true;
    picker.control.setAttribute('aria-expanded', 'false');
    picker.control.removeAttribute('aria-activedescendant');
    picker.activeIndex = -1;
    return true;
}

function positionPopup() {
    const picker = activePicker;
    if (!picker) return;
    if (!canChoose(picker)) {
        closeLinkSystemPicker();
        return;
    }
    const rect = picker.control.getBoundingClientRect();
    const width = Math.min(rect.width, Math.max(0, window.innerWidth - 16));
    const below = window.innerHeight - rect.bottom - 8;
    const above = rect.top - 8;
    const upward = above > below && below < 240;
    picker.list.style.width = `${width}px`;
    picker.list.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
    picker.list.style.top = upward ? 'auto' : `${rect.bottom + 4}px`;
    picker.list.style.bottom = upward ? `${window.innerHeight - rect.top + 4}px` : 'auto';
    picker.list.style.maxHeight = `${Math.max(0, Math.min(240, upward ? above : below) - 4)}px`;
}

function setActive(picker, index) {
    const options = [...picker.list.children];
    picker.activeIndex = options.length ? (index + options.length) % options.length : -1;
    options.forEach((option, i) => option.classList.toggle('is-active', i === picker.activeIndex));
    const option = options[picker.activeIndex];
    if (option) {
        picker.control.setAttribute('aria-activedescendant', option.id);
        option.scrollIntoView({ block: 'nearest' });
    }
}

function syncSelected(picker) {
    const value = picker.control.value;
    const system = getLinkSystem(value);
    picker.control.querySelector('.link-system-option-name').textContent = value === '' ? picker.emptyLabel
        : system?.name || '削除済みの系統（選び直してください）';
    syncLinkSystemSwatch(picker.control.querySelector('.link-system-swatch'), value);
    for (const option of picker.list.children) {
        option.setAttribute('aria-selected', String(option.value === value));
    }
}

function choose(picker, option) {
    if (!canChoose(picker) || !option) return;
    picker.control.value = option.value;
    syncSelected(picker);
    closeLinkSystemPicker();
    picker.onChange?.(picker.control);
}

function openPopup(picker) {
    closeLinkSystemPicker();
    if (!canChoose(picker)) return;
    // 候補も親モーダルのフォーカス境界内に置く。
    const dialog = picker.control.closest('[role="dialog"]');
    if (dialog && picker.list.parentElement !== dialog) dialog.appendChild(picker.list);
    activePicker = picker;
    picker.list.hidden = false;
    picker.control.setAttribute('aria-expanded', 'true');
    positionPopup();
    const index = [...picker.list.children].findIndex(option => option.value === picker.control.value);
    setActive(picker, Math.max(0, index));
}

function bindControls(picker) {
    const control = picker.control;
    control.addEventListener('click', () => activePicker === picker ? closeLinkSystemPicker() : openPopup(picker));
    control.addEventListener('blur', () => {
        if (activePicker === picker) closeLinkSystemPicker();
    });
    control.addEventListener('keydown', event => {
        if (event.isComposing || event.keyCode === 229) return;
        if (event.key === 'Escape' && activePicker === picker) {
            event.preventDefault();
            event.stopPropagation();
            closeLinkSystemPicker();
            return;
        }
        if (event.key === 'Tab') {
            if (activePicker === picker) closeLinkSystemPicker();
            return;
        }
        if (!canChoose(picker)) return;
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            event.preventDefault();
            const wasClosed = activePicker !== picker;
            if (wasClosed) openPopup(picker);
            if (event.key === 'Home') setActive(picker, 0);
            else if (event.key === 'End') setActive(picker, picker.list.children.length - 1);
            else if (!wasClosed) setActive(picker, picker.activeIndex + (event.key === 'ArrowDown' ? 1 : -1));
        } else if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            if (activePicker !== picker) openPopup(picker);
            else choose(picker, picker.list.children[picker.activeIndex]);
        }
    });
    picker.list.addEventListener('pointerdown', event => event.preventDefault());
    if (typeof document !== 'undefined' && boundDocument !== document) {
        boundDocument = document;
        document.addEventListener('pointerdown', event => {
            const current = activePicker;
            if (current && !current.control.parentElement?.contains(event.target) && !current.list.contains(event.target)) {
                closeLinkSystemPicker();
            }
        });
    }
    if (typeof window !== 'undefined' && boundWindow !== window) {
        boundWindow = window;
        window.addEventListener('resize', positionPopup);
        window.addEventListener('scroll', positionPopup, true);
    }
}

export function populateLinkSystemPicker(control, value, changed, { emptyLabel = '未設定' } = {}) {
    if (!control) return;
    let picker = pickers.get(control);
    if (!picker) {
        const list = document.getElementById(control.getAttribute('aria-controls'));
        if (!list) return;
        picker = { control, list, activeIndex: -1 };
        pickers.set(control, picker);
        bindControls(picker);
    }
    if (activePicker === picker) closeLinkSystemPicker();
    control.value = value == null ? '' : String(value);
    picker.onChange = changed;
    picker.emptyLabel = emptyLabel;
    const list = picker.list;
    list.replaceChildren();
    const addOption = (name, id) => {
        const option = document.createElement('button');
        option.id = `${control.id}-option-${id || 'unset'}`;
        option.type = 'button';
        option.className = 'link-system-option';
        option.value = id;
        option.tabIndex = -1;
        option.setAttribute('role', 'option');
        const swatch = document.createElement('span');
        swatch.className = 'link-system-swatch';
        swatch.setAttribute('aria-hidden', 'true');
        syncLinkSystemSwatch(swatch, id);
        const label = document.createElement('span');
        label.className = 'link-system-option-name';
        label.textContent = name;
        option.appendChild(swatch);
        option.appendChild(label);
        option.addEventListener('mousedown', event => event.preventDefault());
        option.addEventListener('mouseenter', () => setActive(picker, [...list.children].indexOf(option)));
        option.addEventListener('click', () => choose(picker, option));
        list.appendChild(option);
    };
    addOption(emptyLabel, '');
    for (const system of appState.linkSystems) addOption(system.name, String(system.id));
    // 削除済みの下書きを黙って未設定へ変更しない。
    if (control.value && !getLinkSystem(control.value)) addOption('削除済みの系統（選び直してください）', control.value);
    syncSelected(picker);
}
