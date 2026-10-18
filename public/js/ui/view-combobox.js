import { appState, getCurrentView } from '../core/state.js';
import { normalizeText } from '../core/utils.js';

let results = [];
let activeIndex = -1;
let query = '';
let selectView;
let selecting = false;
let displayedViewId = null;

const inputElement = () => document.getElementById('view-search-input');
const popupElement = () => document.getElementById('view-search-popup');
const searchText = value => normalizeText(value).normalize('NFKC').toLocaleLowerCase().trim();
const typeLabel = view => view.view_type === 'floor' ? '物理・フロア配置図' : '論理構成図';
const viewName = view => normalizeText(view.name).trim() || `ビューID ${view.id}`;

function positionPopup() {
    const input = inputElement();
    const popup = popupElement();
    if (!input || !popup || popup.hidden) return;
    const rect = input.getBoundingClientRect();
    const width = Math.min(Math.max(rect.width, 280), Math.max(0, window.innerWidth - 16));
    popup.style.width = `${width}px`;
    popup.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
    popup.style.top = `${rect.bottom + 4}px`;
    popup.style.maxHeight = `${Math.max(0, Math.min(320, window.innerHeight - rect.bottom - 12))}px`;
}

function setActiveIndex(index) {
    const list = document.getElementById('view-search-results');
    const input = inputElement();
    activeIndex = results.length ? (index + results.length) % results.length : -1;
    Array.from(list?.children || []).forEach((option, i) => {
        option.classList.toggle('active', i === activeIndex);
    });
    const option = list?.children[activeIndex];
    if (option) {
        input?.setAttribute('aria-activedescendant', option.id);
        option.scrollIntoView({ block: 'nearest' });
    } else {
        input?.removeAttribute('aria-activedescendant');
    }
}

function renderResults(preserveActive = false) {
    const activeId = preserveActive ? results[activeIndex]?.id : appState.currentViewId;
    const list = document.getElementById('view-search-results');
    const summary = document.getElementById('view-search-summary');
    if (!list) return;
    const terms = searchText(query).split(/\s+/).filter(Boolean);
    results = [...appState.views].sort((a, b) => Number(a.sort_order) - Number(b.sort_order) || Number(a.id) - Number(b.id))
        .filter(view => {
            const text = searchText([viewName(view), view.facility, view.floor, typeLabel(view), view.view_type].join(' '));
            return terms.every(term => text.includes(term));
        });
    list.replaceChildren();
    if (summary) summary.textContent = results.length ? `${results.length}件のビュー` : '該当するビューがありません';
    results.forEach((view, index) => {
        const option = document.createElement('div');
        option.id = `view-search-option-${index}`;
        option.className = 'view-search-option';
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', String(Number(view.id) === Number(appState.currentViewId)));
        const name = document.createElement('strong');
        name.textContent = viewName(view);
        const detail = document.createElement('span');
        detail.textContent = [view.facility, view.floor, typeLabel(view)].map(value => normalizeText(value).trim()).filter(Boolean).join(' / ');
        option.title = `${name.textContent}\n${detail.textContent}`;
        option.appendChild(name);
        option.appendChild(detail);
        // 入力のblurより先にフォーカス移動を抑え、clickで既存の切替処理を呼ぶ。
        option.addEventListener('mousedown', event => event.preventDefault());
        option.addEventListener('mouseenter', () => setActiveIndex(index));
        option.addEventListener('click', () => chooseView(view.id));
        list.appendChild(option);
    });
    const nextIndex = results.findIndex(view => Number(view.id) === Number(activeId));
    setActiveIndex(nextIndex >= 0 ? nextIndex : 0);
    positionPopup();
}

function openPopup() {
    const input = inputElement();
    const popup = popupElement();
    if (!input || !popup || input.disabled || selecting) return;
    if (popup.hidden) {
        query = '';
        input.value = '';
    }
    popup.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    renderResults();
}

function closePopup() {
    const input = inputElement();
    const popup = popupElement();
    if (popup) popup.hidden = true;
    query = '';
    activeIndex = -1;
    if (input) {
        input.value = getCurrentView() ? viewName(getCurrentView()) : '';
        input.setAttribute('aria-expanded', 'false');
        input.removeAttribute('aria-activedescendant');
    }
}

async function chooseView(id) {
    if (selecting) return;
    closePopup();
    selecting = true;
    try {
        await selectView(id);
    } finally {
        selecting = false;
        syncViewCombobox();
    }
}

export function syncViewCombobox() {
    const input = inputElement();
    if (!input) return;
    input.disabled = appState.views.length === 0;
    input.placeholder = input.disabled ? 'ビューがありません' : 'ビューを検索';
    if (!input.disabled && !popupElement()?.hidden && displayedViewId === appState.currentViewId) {
        renderResults(true);
    } else {
        closePopup();
    }
    displayedViewId = appState.currentViewId;
}

export function initViewCombobox(onSelect) {
    selectView = onSelect;
    const input = inputElement();
    if (!input) return;
    input.addEventListener('click', openPopup);
    input.addEventListener('input', () => {
        if (selecting) return;
        query = input.value;
        const popup = popupElement();
        if (popup) popup.hidden = false;
        input.setAttribute('aria-expanded', 'true');
        renderResults();
    });
    input.addEventListener('blur', closePopup);
    input.addEventListener('keydown', event => {
        if (event.isComposing || selecting) return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (popupElement()?.hidden) {
                openPopup();
            } else {
                setActiveIndex(activeIndex + (event.key === 'ArrowDown' ? 1 : -1));
            }
        } else if (event.key === 'Enter' && !popupElement()?.hidden) {
            event.preventDefault();
            if (results[activeIndex]) return chooseView(results[activeIndex].id);
        } else if (event.key === 'Escape' && !popupElement()?.hidden) {
            event.preventDefault();
            event.stopPropagation();
            closePopup();
        }
    });
    document.addEventListener('pointerdown', event => {
        if (!document.getElementById('view-switcher')?.contains(event.target) && !popupElement()?.contains(event.target)) closePopup();
    });
    window.addEventListener('resize', positionPopup);
    window.addEventListener('scroll', positionPopup, true);
    syncViewCombobox();
}
