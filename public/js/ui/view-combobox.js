import { appState, getCurrentView } from '../core/state.js';
import { normalizeText } from '../core/utils.js';
import { clearShareLinkFallback } from './share-link.js';
import { buildHierarchyTree, flattenHierarchyTree, hierarchyViewEntries, syncHierarchyExpansion, viewHierarchyPath } from '../core/building-hierarchy.js';
import { findEnabledBuilding, isBuildingViewEnabled } from '../core/building-view-model.js';
import { eventBus } from '../core/event-bus.js';
import { getOpenBuildingId } from './building-view.js';

let results = [];
let activeIndex = -1;
let query = '';
let selectView;
let selectBuilding;
let selecting = false;
let displayedViewId = null;
const collapsed = new Set();
const expansionState = { collapsed, knownBranches: new Set(), selectedPath: null };
const buildingViewLabel = '建物全体';

const inputElement = () => document.getElementById('view-search-input');
const popupElement = () => document.getElementById('view-search-popup');
const searchText = value => normalizeText(value).normalize('NFKC').toLocaleLowerCase().trim();
const typeLabel = view => view.view_type === 'rack' ? 'ラック搭載図' :
    view.view_type === 'floor' ? '物理・フロア配置図' : '論理構成図';
const viewName = view => normalizeText(view.name).trim() || `ビューID ${view.id}`;
const typeIcon = view => view.view_type === 'rack' ? 'rack' : view.view_type === 'floor' ? 'floor-plan' : 'link';
const activeBuilding = () => findEnabledBuilding(appState, getOpenBuildingId());
const selectedKey = () => {
    const building = activeBuilding();
    return building ? `building-view:${building.id}` : `view:${appState.currentViewId}`;
};
const currentName = () => {
    const building = activeBuilding();
    if (building) return `${building.name} / ${buildingViewLabel}`;
    const view = getCurrentView();
    return view ? viewName(view) : '';
};

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
    const previous = preserveActive ? results[activeIndex] : null;
    const currentKey = selectedKey();
    const activeKey = preserveActive ? previous?.key : currentKey;
    const list = document.getElementById('view-search-results');
    const summary = document.getElementById('view-search-summary');
    if (!list) return;
    const terms = searchText(query).split(/\s+/).filter(Boolean);
    const searching = terms.length > 0;
    const tree = buildHierarchyTree(appState);
    if (selectBuilding) {
        for (const building of tree) {
            if (building.kind !== 'building' || !isBuildingViewEnabled(building.row)) continue;
            building.children.unshift({
                key: `building-view:${building.row.id}`, kind: 'building-view',
                row: building.row, children: []
            });
        }
    }
    syncHierarchyExpansion(tree, expansionState, currentKey);
    if (!searching) {
        // 開閉履歴は元の階層で保持し、1件のフロアだけ表示上の選択行に置き換える。
        for (const building of tree) {
            if (building.kind !== 'building') continue;
            for (const [index, floor] of building.children.entries()) {
                if (floor.kind !== 'floor' || floor.children.length !== 1) continue;
                building.children[index] = { ...floor.children[0], floor };
            }
        }
    }
    const searchable = hierarchyViewEntries(appState).map(view => ({
        key: `view:${view.id}`, kind: 'view', row: view, children: [], depth: 0
    }));
    if (selectBuilding) searchable.push(...(appState.buildings || []).filter(isBuildingViewEnabled).map(building => ({
        key: `building-view:${building.id}`, kind: 'building-view', row: building, children: [], depth: 0
    })));
    results = searching ? searchable.filter(node => {
        const text = searchText(node.kind === 'building-view' ? `${node.row.name} ${buildingViewLabel} 3D` :
            [viewName(node.row), viewHierarchyPath(node.row, appState), typeLabel(node.row), node.row.view_type].join(' '));
        return terms.every(term => text.includes(term));
    }) :
        flattenHierarchyTree(tree, collapsed);
    list.setAttribute('role', searching ? 'listbox' : 'tree');
    inputElement()?.setAttribute('aria-haspopup', searching ? 'listbox' : 'tree');
    list.replaceChildren();
    if (summary) {
        summary.classList.toggle('visually-hidden', results.length > 0);
        summary.textContent = searching ?
            (results.length ? `${results.length}件のビュー` : '該当するビューがありません') :
            `${appState.views.length}件のビュー · 階層からビューを選択`;
    }
    // 平坦なDOMでも階層と兄弟位置を支援技術へ明示する。
    const positions = new Map();
    const recordPositions = nodes => nodes.forEach((node, index) => {
        positions.set(node.key, { index: index + 1, size: nodes.length });
        recordPositions(node.children);
    });
    if (!searching) recordPositions(tree);
    results.forEach((node, index) => {
        const view = node.row;
        const isView = node.kind === 'view';
        const isEmptyFloor = node.kind === 'floor' && !node.children.length;
        const isCurrent = node.key === currentKey;
        const path = isView && searching ? viewHierarchyPath(view, appState) : '';
        const option = document.createElement('div');
        option.id = `view-search-option-${index}`;
        option.className = `view-search-option view-search-${node.kind}`;
        if (node.floor) option.className += ' view-search-single-floor';
        if (isEmptyFloor) option.className += ' view-search-floor-empty';
        option.style.paddingLeft = `${8 + node.depth * 12}px`;
        option.setAttribute('role', searching ? 'option' : 'treeitem');
        if (isView || node.kind === 'building-view') option.setAttribute('aria-selected', String(isCurrent));
        if (!searching) {
            option.setAttribute('aria-level', String(node.depth + 1));
            option.setAttribute('aria-posinset', String(positions.get(node.key).index));
            option.setAttribute('aria-setsize', String(positions.get(node.key).size));
            if (node.children.length) option.setAttribute('aria-expanded', String(!collapsed.has(node.key)));
        }
        const name = document.createElement('strong');
        name.textContent = node.floor ? '' : isView ? viewName(view) : node.kind === 'building-view' ?
            (searching ? `${normalizeText(view.name)} / ${buildingViewLabel}` : buildingViewLabel) :
            node.kind === 'unclassified' ? `未分類ビュー（${node.children.length}件）` : normalizeText(view.name);
        if (isView) {
            const icon = document.createElement('img');
            icon.className = 'view-search-type-icon';
            icon.src = `assets/icons/toolbar/${typeIcon(view)}.svg`;
            icon.alt = typeLabel(view);
            icon.width = 18;
            icon.height = 18;
            if (node.floor) {
                const floorName = document.createElement('span');
                floorName.textContent = `${normalizeText(node.floor.row.name)} / `;
                name.appendChild(floorName);
            }
            name.appendChild(icon);
            if (node.floor) {
                const label = document.createElement('span');
                label.textContent = viewName(view);
                name.appendChild(label);
            }
        }
        const detailText = isView ? (searching ? path : '') :
            node.kind === 'building' && !node.children.some(child => child.kind !== 'building-view') ? 'フロアなし' :
                isEmptyFloor ? 'ビューなし' : '';
        option.title = [name.textContent, detailText].filter(Boolean).join('\n');
        option.appendChild(name);
        if (isCurrent) {
            const badge = document.createElement('span');
            badge.className = 'view-search-current';
            badge.textContent = '現在';
            badge.setAttribute('aria-hidden', 'true');
            option.appendChild(badge);
        }
        if (detailText) {
            const detail = document.createElement('span');
            detail.className = isEmptyFloor ? 'view-search-empty-note' : 'view-search-detail';
            detail.textContent = detailText;
            option.appendChild(detail);
        }
        if (!searching && !isView && node.children.length) {
            const disclosure = document.createElement('span');
            disclosure.className = 'view-search-disclosure';
            disclosure.style.left = `${8 + node.depth * 12}px`;
            disclosure.setAttribute('aria-hidden', 'true');
            disclosure.textContent = collapsed.has(node.key) ? '▸' : '▾';
            option.appendChild(disclosure);
        }
        // 入力のblurより先にフォーカス移動を抑え、clickで確定する。
        option.addEventListener('pointerdown', event => event.preventDefault());
        option.addEventListener('mousedown', event => event.preventDefault());
        option.addEventListener('mouseenter', () => setActiveIndex(index));
        option.addEventListener('click', () => {
            setActiveIndex(index);
            return activateNode(node);
        });
        list.appendChild(option);
    });
    let nextIndex = results.findIndex(node => node.key === activeKey);
    if (nextIndex < 0 && !searching && previous) {
        const floorKey = previous.floor?.key || previous.key;
        nextIndex = results.findIndex(node => (node.floor?.key || node.key) === floorKey);
    }
    setActiveIndex(nextIndex >= 0 ? nextIndex : 0);
    positionPopup();
}

function toggleNode(node) {
    if (!node.children.length) return;
    if (collapsed.has(node.key)) collapsed.delete(node.key);
    else collapsed.add(node.key);
    renderResults(true);
}

function activateNode(node) {
    if (node.kind === 'view') return chooseView(node.row.id);
    if (node.kind === 'building-view') return chooseBuilding(node.row.id);
    toggleNode(node);
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
        input.value = currentName();
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

async function chooseBuilding(id) {
    if (selecting || !findEnabledBuilding(appState, id)) return;
    closePopup();
    selecting = true;
    try {
        await selectBuilding(id);
    } finally {
        selecting = false;
        syncViewCombobox();
    }
}

export function syncViewCombobox() {
    clearShareLinkFallback('view-copy-link-btn');
    const input = inputElement();
    if (!input) return;
    input.disabled = appState.views.length === 0 && !(appState.buildings || []).length;
    input.placeholder = input.disabled ? 'ビューがありません' : 'ビュー・建物を検索';
    if (!input.disabled && !popupElement()?.hidden && displayedViewId === appState.currentViewId) {
        renderResults(true);
    } else {
        syncHierarchyExpansion(buildHierarchyTree(appState), expansionState, selectedKey());
        closePopup();
    }
    displayedViewId = appState.currentViewId;
}

export function initViewCombobox(onSelect, onSelectBuilding = null) {
    selectView = onSelect;
    selectBuilding = onSelectBuilding;
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
        } else if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') &&
            !popupElement()?.hidden && !searchText(query)) {
            const node = results[activeIndex];
            if (!node) return;
            event.preventDefault();
            if (event.key === 'ArrowRight') {
                if (node.children.length && collapsed.has(node.key)) toggleNode(node);
                else if (node.children.length) setActiveIndex(activeIndex + 1);
            } else if (node.children.length && !collapsed.has(node.key)) {
                toggleNode(node);
            } else {
                for (let index = activeIndex - 1; index >= 0; index--) {
                    if (results[index].depth < node.depth) {
                        setActiveIndex(index);
                        break;
                    }
                }
            }
        } else if (event.key === 'Enter' && !popupElement()?.hidden) {
            event.preventDefault();
            if (results[activeIndex]) return activateNode(results[activeIndex]);
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

eventBus.on('building-view:changed', syncViewCombobox);
