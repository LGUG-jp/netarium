// 選択値はselectのoption.selectedだけに保持し、台帳の行選択とは分離する。
const pickers = new WeakMap();
let openPicker = null;

export function closeLedgerFilterPickers() {
    if (!openPicker) return false;
    openPicker.popup.hidden = true;
    openPicker.trigger.setAttribute('aria-expanded', 'false');
    openPicker.trigger.removeAttribute('aria-activedescendant');
    openPicker = null;
    return true;
}

function positionPopup(picker) {
    if (picker.popup.hidden) return;
    const rect = picker.trigger.getBoundingClientRect();
    const width = Math.min(Math.max(rect.width, 240), window.innerWidth - 16);
    const below = window.innerHeight - rect.bottom - 8;
    const above = rect.top - 8;
    const upward = above > below && below < 240;
    Object.assign(picker.popup.style, {
        width: `${width}px`,
        left: `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`,
        top: upward ? 'auto' : `${rect.bottom + 4}px`,
        bottom: upward ? `${window.innerHeight - rect.top + 4}px` : 'auto',
        maxHeight: `${Math.max(0, Math.min(280, upward ? above : below) - 4)}px`
    });
}

function setActive(picker, index) {
    const options = [...picker.popup.children];
    picker.activeIndex = options.length ? (index + options.length) % options.length : -1;
    options.forEach((option, i) => option.classList.toggle('is-active', i === picker.activeIndex));
    const active = options[picker.activeIndex];
    if (active) {
        picker.trigger.setAttribute('aria-activedescendant', active.id);
        active.scrollIntoView({ block: 'nearest' });
    }
}

function syncSelection(picker) {
    const selected = Array.from(picker.select.selectedOptions);
    const summary = selected.length === 0 ? 'すべて'
        : selected.length === 1 ? selected[0].textContent : `${selected.length}件選択`;
    picker.trigger.textContent = `${summary} ▾`;
    picker.trigger.title = selected.map(option => option.textContent).join('、') || 'すべて';
    picker.trigger.setAttribute('aria-label', `${picker.label}: ${summary}`);
    picker.popup.querySelectorAll('[role="option"]').forEach((item, index) => {
        const option = picker.select.options[index];
        item.setAttribute('aria-selected', String(option.selected));
        item.querySelector('.ledger-filter-option-check').textContent = option.selected ? '✓' : '';
    });
}

function openPopup(picker) {
    closeLedgerFilterPickers();
    if (picker.select.disabled) return;
    picker.popup.replaceChildren();
    Array.from(picker.select.options).forEach((option, index) => {
        const item = document.createElement('div');
        item.id = `${picker.select.id}-option-${index}`;
        item.className = 'ledger-filter-option';
        item.dataset.value = option.value;
        item.setAttribute('role', 'option');
        const check = document.createElement('span');
        check.className = 'ledger-filter-option-check';
        check.setAttribute('aria-hidden', 'true');
        const text = document.createElement('span');
        text.textContent = option.textContent;
        item.append(check, text);
        item.addEventListener('pointerdown', event => event.preventDefault());
        item.addEventListener('mouseenter', () => setActive(picker, index));
        item.addEventListener('click', () => toggleOption(picker, index));
        picker.popup.appendChild(item);
    });
    if (!picker.select.options.length) {
        picker.trigger.setAttribute('aria-label', `${picker.label}: 候補なし`);
        return;
    }
    openPicker = picker;
    picker.popup.hidden = false;
    picker.trigger.setAttribute('aria-expanded', 'true');
    syncSelection(picker);
    positionPopup(picker);
    const index = Array.from(picker.select.options).findIndex(option => option.selected);
    setActive(picker, Math.max(0, index));
}

function toggleOption(picker, index) {
    if (picker.select.disabled) return;
    const option = picker.select.options[index];
    if (!option) return;
    option.selected = !option.selected;
    picker.changed();
    syncSelection(picker);
}

export function syncLedgerFilterPicker(select, label, changed) {
    let picker = pickers.get(select);
    if (!picker) {
        const trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.id = `${select.id}-trigger`;
        trigger.className = 'ledger-filter-trigger';
        trigger.setAttribute('role', 'combobox');
        trigger.setAttribute('aria-haspopup', 'listbox');
        trigger.setAttribute('aria-expanded', 'false');
        const popup = document.createElement('div');
        popup.id = `${select.id}-options`;
        popup.className = 'ledger-filter-options';
        popup.hidden = true;
        popup.setAttribute('role', 'listbox');
        popup.setAttribute('aria-label', label);
        popup.setAttribute('aria-multiselectable', 'true');
        trigger.setAttribute('aria-controls', popup.id);
        select.hidden = true;
        select.insertAdjacentElement('afterend', trigger);
        trigger.insertAdjacentElement('afterend', popup);
        picker = { select, trigger, popup, label, changed, activeIndex: -1 };
        pickers.set(select, picker);
        trigger.addEventListener('click', () => popup.hidden ? openPopup(picker) : closeLedgerFilterPickers());
        trigger.addEventListener('blur', closeLedgerFilterPickers);
        trigger.addEventListener('keydown', event => {
            if (event.isComposing) return;
            if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                event.preventDefault();
                const wasClosed = popup.hidden;
                if (wasClosed) openPopup(picker);
                if (event.key === 'Home') setActive(picker, 0);
                else if (event.key === 'End') setActive(picker, popup.children.length - 1);
                else if (!wasClosed) setActive(picker, picker.activeIndex + (event.key === 'ArrowDown' ? 1 : -1));
            } else if ((event.key === 'Enter' || event.key === ' ') && !popup.hidden) {
                event.preventDefault();
                toggleOption(picker, picker.activeIndex);
            } else if (event.key === 'Escape' && !popup.hidden) {
                event.preventDefault();
                event.stopPropagation();
                closeLedgerFilterPickers();
            } else if (event.key === 'Tab') closeLedgerFilterPickers();
        });
        document.addEventListener('pointerdown', event => {
            if (openPicker === picker && !trigger.parentElement.contains(event.target)) closeLedgerFilterPickers();
        });
        window.addEventListener('resize', () => positionPopup(picker));
        window.addEventListener('scroll', () => positionPopup(picker), true);
    }
    picker.changed = changed;
    picker.trigger.disabled = select.disabled;
    if (select.disabled && openPicker === picker) closeLedgerFilterPickers();
    // 候補が更新された開いたリストだけを再構築する。通常の絞り込みではフォーカスを保つ。
    if (!picker.popup.hidden && (picker.popup.children.length !== select.options.length ||
        Array.from(select.options).some((option, i) =>
            picker.popup.children[i].dataset.value !== option.value ||
            picker.popup.children[i].children[1].textContent !== option.textContent))) {
        openPopup(picker);
    }
    syncSelection(picker);
}
