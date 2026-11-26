import { appState } from '../core/state.js';
import { DEVICE_TYPES } from '../core/constants.js';
import { eventBus } from '../core/event-bus.js';
import { isCurrentUserAdmin } from './access-control.js';
import { chooseUnsavedChanges } from '../core/unsaved-changes-dialog.js';
import { getTopModalContainer } from '../core/modal-focus.js';
import { closeToolbarMenu } from './toolbar-controls.js';
import { loadBuildingFloorTransform, saveBuildingFloorTransform } from '../core/building-view-save.js';
import { getLinkColor } from '../core/link-systems.js';
import { showStatusMessage, showToast } from './toast.js';
import { IDENTITY_TRANSFORM, floorTransform, validFloorTransform, buildingFloorLayers, buildingFloorZ,
    transformedFloorCorners, buildingSceneFrame, fitBuildingCamera, projectBuildingPoint, buildingDragDelta,
    alignBuildingFloor, transformBuildingPoint, findEnabledBuilding, isBuildingViewEnabled, buildingConnections,
    floorViewSelection, buildingComparisonAnchors, buildingComparisonFrame } from '../core/building-view-model.js';

const NS = 'http://www.w3.org/2000/svg';
const DEFAULT_CAMERA = { azimuth: -30, elevation: 25, zoom: 1 };
const INVERT_DRAG_KEY = 'netarium.buildingViewInvertDrag';
const DEVICE_TYPE_ENTRIES = Object.entries(DEVICE_TYPES);
const deviceType = device => Object.hasOwn(DEVICE_TYPES, device.type) ? device.type : 'other';
const KEYS = ['scale', 'offset_x', 'offset_y', 'rotation'];
const fieldUnit = key => key === 'scale' ? 100 : 1;
const fieldText = (key, value) => {
    const shown = value * fieldUnit(key);
    const rounded = Number(shown.toFixed(3));
    return String(rounded === 0 ? shown : rounded);
};
let current = null;
let fieldId = 0;
const permitted = () => isCurrentUserAdmin() && !appState.authExpired && !appState.isPinging;
const usable = state => current === state && !state.unavailable;
const equal = (a, b) => KEYS.every(key => a[key] === b[key]);
const sameFloorContext = (a, b) => a && b && Number(a.building_id) === Number(b.building_id) &&
    (a.representative_view_id ?? null) === (b.representative_view_id ?? null);
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const element = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
};
const svgElement = (tag, attributes) => {
    const node = document.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    return node;
};
function button(parent, text, action) {
    const node = element('button', text, 'btn btn-secondary btn-sm');
    node.type = 'button';
    node.addEventListener('click', action);
    parent.append(node);
    return node;
}

function setPanelExpanded(toggle, panel, expanded) {
    if (!expanded && panel.contains(document.activeElement)) toggle.focus({ preventScroll: true });
    panel.hidden = !expanded;
    toggle.setAttribute('aria-expanded', String(expanded));
}

function panelToggle(parent, panel, label) {
    const toggle = button(parent, label, () => setPanelExpanded(toggle, panel, panel.hidden));
    toggle.setAttribute('aria-controls', panel.id);
    setPanelExpanded(toggle, panel, true);
    return toggle;
}

function displayCheckbox(parent, id, text, checked, change, color) {
    const label = element('label', '', 'building-view-display-choice');
    const input = element('input');
    input.type = 'checkbox';
    input.id = id;
    input.checked = checked;
    label.htmlFor = id;
    label.append(input);
    if (color) {
        const dot = element('span', '', 'building-view-display-dot');
        dot.setAttribute('aria-hidden', 'true');
        dot.style.backgroundColor = color;
        label.append(dot);
    }
    label.append(element('span', text));
    input.addEventListener('change', () => change(input.checked));
    parent.append(label);
    return { input, label };
}

function buildDisplayControls(state) {
    const fieldset = element('fieldset', '', 'building-view-display');
    fieldset.append(element('legend', '表示設定'));
    const primary = element('div', '', 'building-view-display-primary');
    const change = update => checked => {
        if (!usable(state)) return;
        update(checked);
        syncVisibleMarkers(state);
        renderConnectionDetails(state); draw(state);
    };
    displayCheckbox(primary, 'building-view-selected-floor-only', '選択階の機器のみ', false,
        change(checked => { state.selectedFloorOnly = checked; }));
    const internal = displayCheckbox(primary, 'building-view-show-connections', 'フロア間接続を表示', true,
        change(checked => {
            if (state.comparison) state.comparison.showInternal = checked;
            else state.showConnections = checked;
        }));
    state.connectionToggle = internal.input;
    const inter = displayCheckbox(primary, 'building-view-show-inter-building-connections',
        '建物間接続を表示', true, change(checked => { if (state.comparison) state.comparison.showInter = checked; }));
    state.interBuildingToggle = inter.input;
    state.interBuildingLabel = inter.label;
    state.interBuildingToggle.setAttribute('aria-controls', 'building-view-links');
    state.connectionToggle.setAttribute('aria-controls', 'building-view-links');
    fieldset.append(primary);
    fieldset.append(buildComparisonControls(state));
    const types = element('details');
    const summary = element('summary');
    types.append(summary);
    const { input: allTypes } = displayCheckbox(types, 'building-view-all-types', 'すべての機器種別', true,
        change(checked => {
            state.visibleTypes.clear();
            for (const [type, input] of typeInputs) {
                input.checked = checked;
                if (checked) state.visibleTypes.add(type);
            }
            syncTypes();
        }));
    const syncTypes = () => {
        const count = state.visibleTypes.size, total = DEVICE_TYPE_ENTRIES.length;
        summary.textContent = `機器種別（${count}/${total}）`;
        allTypes.checked = count === total;
        allTypes.indeterminate = count > 0 && count < total;
    };
    const choices = element('div', '', 'building-view-display-types');
    choices.id = 'building-view-display-types';
    allTypes.setAttribute('aria-controls', choices.id);
    const typeInputs = new Map();
    for (const [type, { label, color }] of DEVICE_TYPE_ENTRIES) {
        const { input } = displayCheckbox(choices, `building-view-type-${type}`, label, true, change(checked => {
            if (checked) state.visibleTypes.add(type);
            else state.visibleTypes.delete(type);
            syncTypes();
        }), color);
        typeInputs.set(type, input);
    }
    syncTypes();
    types.append(choices);
    fieldset.append(types);
    return fieldset;
}

function comparisonSelect(parent, id, text) {
    const label = element('label');
    const select = element('select');
    select.id = id;
    label.htmlFor = id;
    label.append(element('span', text), select);
    parent.append(label);
    return select;
}

function buildComparisonControls(state) {
    const controls = element('div', '', 'building-view-compare');
    controls.append(element('h3', '建物比較'));
    state.addControls = element('div', '', 'building-view-compare-fields');
    state.compareBuilding = element('select');
    state.compareBuilding.id = 'building-view-compare-building';
    state.compareBuilding.setAttribute('aria-label', '比較する建物');
    state.addControls.append(state.compareBuilding);
    state.addBuilding = button(state.addControls, '建物を追加', () => addComparison(state));
    // 編集中の欄からボタンへポインターで移る際は、自動保存より未保存確認を優先する。
    state.addBuilding.addEventListener('pointerdown', event => {
        if (event.button === 0 && state.dirty) event.preventDefault();
    });
    state.noComparisonCandidates = element('p', '追加できる建物がありません。');
    state.addControls.append(state.noComparisonCandidates);
    state.anchorControls = element('div', '', 'building-view-compare-fields');
    state.removeBuilding = button(state.anchorControls, '比較を解除', () => {
        if (!usable(state) || !state.comparison || state.busy || state.gesture) return;
        const primary = findEnabledBuilding(appState, state.id);
        if (primary) removeComparison(state, [buildingEntry(primary)]);
        else refresh();
    });
    state.anchorSelects = [0, 1].map(index => {
        const select = comparisonSelect(state.anchorControls, `building-view-compare-anchor-${index}`, '基準フロア');
        select.addEventListener('change', () => {
            if (!usable(state) || !state.comparison || state.busy || state.gesture) return;
            const id = Number(select.value);
            if (!state.buildings[index].layers.some(layer => Number(layer.floor.id) === id)) return;
            state.comparison.anchorIds[index] = id;
            if (state.autoFit) fitCamera(state);
            else state.frame = sceneFrame(state);
            draw(state);
        });
        return select;
    });
    controls.append(state.addControls, state.anchorControls);
    return controls;
}

function appendOption(select, id, text) {
    const option = element('option', text);
    option.value = String(id);
    select.append(option);
}

function syncComparisonControls(state) {
    const comparison = state.comparison;
    state.addControls.hidden = Boolean(comparison);
    state.anchorControls.hidden = !comparison;
    state.interBuildingLabel.hidden = !comparison;
    state.connectionToggle.checked = showInternalConnections(state);
    if (!comparison) {
        const candidates = (appState.buildings || []).filter(building => Number(building.id) !== state.id && isBuildingViewEnabled(building));
        const selected = state.compareBuilding.value;
        state.compareBuilding.replaceChildren();
        for (const building of candidates) appendOption(state.compareBuilding, building.id, building.name);
        state.compareBuilding.value = candidates.some(building => String(building.id) === selected)
            ? selected : String(candidates[0]?.id ?? '');
        state.noComparisonCandidates.hidden = candidates.length > 0;
        return;
    }
    state.interBuildingToggle.checked = comparison.showInter;
    state.anchorSelects.forEach((select, index) => {
        const { name, layers } = state.buildings[index];
        select.parentElement.querySelector('span').textContent = `基準フロア（${name}）`;
        select.replaceChildren();
        for (const { floor } of layers) appendOption(select, floor.id, floor.name);
        if (!layers.length) appendOption(select, '', 'フロアなし');
        select.value = String(comparison.anchorIds[index] ?? '');
    });
}

async function addComparison(state) {
    const id = Number(state.compareBuilding.value);
    const canAdd = () => usable(state) && !state.comparison && !state.busy && !state.gesture &&
        id !== state.id && Boolean(findEnabledBuilding(appState, state.id)) && Boolean(findEnabledBuilding(appState, id));
    if (state.comparisonPending || !canAdd()) return;
    state.comparisonPending = true;
    try {
        if (!await resolveDraft(state, canAdd) || !canAdd()) return;
        state.adjusting = false;
        state.comparison = { id, anchorIds: null, showInternal: true, showInter: true };
        state.autoFit = true;
        applyBuildings(state, [buildingEntry(findEnabledBuilding(appState, state.id)), buildingEntry(findEnabledBuilding(appState, id))]);
        state.removeBuilding.focus();
    } finally {
        state.comparisonPending = false;
    }
}

function removeComparison(state, buildings, notice) {
    const active = document.activeElement;
    const refocus = state.anchorControls.contains(active) || state.interBuildingLabel.contains(active);
    state.comparison = null;
    state.autoFit = true;
    applyBuildings(state, buildings);
    if (notice) showToast(notice);
    else showStatusMessage('比較を解除しました。');
    if (refocus) (state.compareBuilding.disabled ? state.connectionToggle : state.compareBuilding).focus();
}

function syncComparisonLocks(state) {
    const locked = state.unavailable || state.busy || Boolean(state.gesture);
    state.addBuilding.disabled = state.compareBuilding.disabled = locked || Boolean(state.comparison) || !state.compareBuilding.children.length;
    state.removeBuilding.disabled = locked || !state.comparison;
    state.anchorSelects.forEach((select, index) => {
        select.disabled = locked || !state.comparison || !state.buildings[index].layers.length;
    });
}

function loadInvertDrag() {
    try { return window.localStorage.getItem(INVERT_DRAG_KEY) === 'true'; }
    catch { return false; }
}

function numberField(parent, text, change, constraints = {}) {
    const label = element('label', text);
    const input = element('input');
    input.id = `building-view-field-${++fieldId}`;
    label.htmlFor = input.id;
    input.type = 'number'; input.step = 'any';
    for (const [key, value] of Object.entries(constraints)) input.setAttribute(key, value);
    input.addEventListener('change', change);
    label.append(input); parent.append(label);
    return input;
}
const selectedLayer = state => state.layers.find(layer => Number(layer.floor.id) === state.selected);
const referenceLayer = state => state.layers.find(layer => Number(layer.floor.id) === state.referenceId);
const floorBuildingId = layer => Number(layer.floor.building_id);
const floorName = (state, layer) => state.comparison
    ? `${state.buildings.find(building => building.id === floorBuildingId(layer)).name}：${layer.floor.name}`
    : layer.floor.name;
const showInternalConnections = state => state.comparison?.showInternal ?? state.showConnections;
const showAnyConnections = state => showInternalConnections(state) || Boolean(state.comparison?.showInter);
const showConnection = (state, group) => group && (group.interBuilding ? state.comparison?.showInter : showInternalConnections(state));
function draft(state = current) {
    return Boolean(state && (state.busy || state.gesture?.moved || state.dirty));
}
export function hasBuildingViewDraft() { return draft(); }
export function getOpenBuildingId() { return current?.id ?? null; }

function markDraft(state) {
    const layer = selectedLayer(state);
    state.dirty = Boolean(state.unconfirmed) || state.invalid || Boolean(layer && !equal(state.value, layer.transform));
    if (!state.dirty) { state.reapply = false; state.reapplyNotice = ''; state.saveFailed = false; }
}
function syncEditorNotice(state) {
    let text = '';
    if (state.invalid) text = '拡大率（%）は正の数、XYは有限の数、回転は−180〜180度で入力してください。';
    else if (state.unconfirmed) text = '保存状態が未確認です。「保存状態を確認」で最新の保存値を取得してください。';
    else if (state.reapply) text = state.reapplyNotice || '未反映の入力があります。「入力を再適用」で保存できます。';
    else if (state.saveFailed) text = '保存できませんでした。入力を保持しています。「保存を再試行」で再送できます。';
    else if (!permitted() && state.dirty) text = '現在保存できません。入力は保持しています。';
    state.editorNotice.textContent = text;
    state.editorNotice.hidden = !text;
}
function showField(state, key, value) {
    const text = fieldText(key, value);
    state.inputs[key].value = text;
    state.displayed[key] = { text, value };
}
function readFields(state) {
    for (const key of KEYS) {
        const text = state.inputs[key].value.trim(), displayed = state.displayed[key];
        // 表示上の丸めを、触っていない項目の保存値へ持ち込まない。
        state.value[key] = text === '' ? NaN : text === displayed?.text ? displayed.value : Number(text) / fieldUnit(key);
    }
    state.invalid = !validFloorTransform(state.value);
    markDraft(state);
    if (state.invalid) showStatusMessage('拡大率（%）は正の数、XYは有限の数、回転は−180〜180度で入力してください。');
}
function syncControls(state, values = true) {
    if (current !== state) return;
    const locked = state.unavailable || state.busy || !permitted();
    const layer = selectedLayer(state);
    state.selection.textContent = layer ? floorName(state, layer) : 'フロアがありません';
    const diagram = layer?.needsRepresentative
        ? '代表図面が未設定です。物理配置ビューが複数あるため、表示する代表ビューを指定してください。'
        : layer?.plan ? `${layer.floor.representative_view_id == null ? '平面図' : '代表平面図'}：${layer.view.name}`
        : layer?.view ? `図面未登録：${layer.view.name}` : '図面なし · 物理配置ビューがありません';
    const count = state.connectionCounts.get(state.selected) ?? 0;
    state.selectionDetail.textContent = !layer ? '' : layer.view ? `${diagram} · 配置機器 ${count} 台` : diagram;
    state.selectionDetail.hidden = !layer;
    state.openPlan.hidden = !layer || (!layer.plan && !isCurrentUserAdmin());
    state.openPlan.disabled = !layer || state.busy || state.unavailable || (!layer.plan && !permitted());
    state.openPlan.textContent = layer?.plan ? '平面図を開く' : layer?.needsRepresentative ? '代表ビューを設定' : 'フロア設定を開く';
    state.adjust.hidden = Boolean(state.comparison) || !isCurrentUserAdmin();
    state.adjust.disabled = Boolean(state.comparison) || !layer || locked;
    state.adjust.textContent = state.adjusting ? '位置合わせを終了' : '位置合わせモード';
    state.adjust.setAttribute('aria-expanded', String(state.adjusting));
    state.editor.hidden = !state.adjusting;
    state.panel.classList.toggle('aligning', state.adjusting);
    state.reference.disabled = state.unavailable || state.busy || state.reference.children.length === 0;
    state.autoAlign.disabled = locked || state.invalid || Boolean(state.unconfirmed) ||
        !layer?.plan || !referenceLayer(state);
    for (const key of KEYS) {
        state.inputs[key].readOnly = state.unavailable;
        state.inputs[key].disabled = state.busy || Boolean(state.comparison) || !permitted();
        if (values) showField(state, key, state.value[key]);
    }
    state.recovery.hidden = Boolean(state.comparison) || state.unavailable || !permitted() || !(state.unconfirmed || state.reapply || state.saveFailed);
    state.recovery.disabled = locked || (!state.unconfirmed && state.invalid);
    state.recovery.textContent = state.unconfirmed ? '保存状態を確認' : state.reapply ? '入力を再適用' : '保存を再試行';
    state.restoreStart.disabled = state.restoreDefaults.disabled = locked || Boolean(state.unconfirmed);
    state.close.disabled = state.busy;
    state.displayControls.disabled = state.unavailable;
    syncEditorNotice(state);
    syncComparisonLocks(state);
    state.connectionSection.hidden = state.unavailable || !state.connectionSelection;
    for (const item of state.floorItems) {
        item.disabled = state.busy || state.unavailable;
        item.setAttribute('aria-pressed', String(Number(item.dataset.floorId) === state.selected));
    }
}
function revealSelectedFloor(state) {
    const selected = state.list.querySelector('[aria-pressed="true"]');
    if (!selected) return;
    const viewport = state.list.getBoundingClientRect();
    const row = selected.getBoundingClientRect();
    if (row.top < viewport.top) state.list.scrollTop += row.top - viewport.top;
    else if (row.bottom > viewport.bottom) state.list.scrollTop += row.bottom - viewport.bottom;
}
async function save(state, explicit = false) {
    if (!usable(state) || state.busy || !findEnabledBuilding(appState, state.id)) return false;
    if (state.comparison) return false;
    if (state.unconfirmed) {
        showToast('入力を保持しています。「保存状態を確認」で最新の保存値を取得してください。');
        return false;
    }
    if (state.reapply && !explicit) return false;
    readFields(state);
    if (!state.dirty) { state.reapply = false; settleRefresh(state); return true; }
    if (state.invalid) return false;
    if (!permitted()) { showToast('編集権限がないため保存できません。入力は保持しています。'); syncControls(state, false); return false; }
    const layer = selectedLayer(state);
    if (!layer) return false;
    const value = { ...state.value };
    state.busy = true; syncControls(state, false); showStatusMessage('位置合わせを保存中…');
    try {
        layer.floor = await saveBuildingFloorTransform(Number(layer.floor.id), value, layer.floor);
        layer.transform = floorTransform(layer.floor);
        state.value = { ...layer.transform };
        state.reapply = false;
        markDraft(state);
        syncControls(state);
        draw(state);
        if (!state.unavailable) showStatusMessage('建物用の位置合わせを保存しました。', 'success');
        return true;
    } catch (error) {
        if (error.status === 409 || (!error.requestNotSent && !error.maintenanceRejected && error.status !== 401 &&
            !(error.apiRejected && error.status < 500))) {
            state.unconfirmed = value;
        }
        state.saveFailed = !state.unconfirmed;
        markDraft(state);
        const next = !permitted() ? '' : state.unconfirmed
            ? '「保存状態を確認」で最新の保存値を取得してください。'
            : state.reapply ? '「入力を再適用」で再送できます。' : '「保存を再試行」で再送できます。';
        if (!state.unavailable) showToast(`${error.message || '保存できませんでした。'} 入力を保持しています。${next}`);
        return false;
    } finally {
        completeOperation(state);
    }
}

async function checkSave(state) {
    if (!usable(state) || state.busy || !state.unconfirmed || !permitted()) return;
    const layer = selectedLayer(state);
    state.busy = true; syncControls(state, false);
    try {
        const { floor, buildingEnabled } = await loadBuildingFloorTransform(Number(layer.floor.id));
        if (!usable(state)) return;
        const disableOpenBuilding = () => {
            appState.buildings = (appState.buildings || []).map(row =>
                Number(row.id) === state.id ? { ...row, building_view_enabled: 0 } : row);
            state.unconfirmed = null;
            state.reapply = false;
            state.saveFailed = false;
        };
        if (!sameFloorContext(floor, layer.floor)) {
            if (!buildingEnabled) {
                disableOpenBuilding();
                return;
            }
            showToast('フロアの所属または代表ビューが変わりました。入力を控えてから建物ビューを閉じ、最新情報を取得してください。');
            return;
        }
        const latest = floorTransform(floor);
        const submitted = equal(latest, state.unconfirmed);
        if (!submitted && !equal(latest, layer.transform)) {
            state.starts.set(state.selected, latest);
            for (const key of KEYS) {
                if (state.value[key] === layer.transform[key]) showField(state, key, latest[key]);
            }
        }
        layer.floor = floor;
        layer.transform = latest;
        // 位置合わせの基準だけを取り込み、他のリソースと全体リビジョンは更新しない。
        appState.floors = appState.floors.map(row => Number(row.id) === Number(floor.id) ? floor : row);
        state.unconfirmed = null;
        readFields(state);
        if (!buildingEnabled) {
            disableOpenBuilding();
            return;
        }
        state.reapply = state.dirty;
        const notice = `現在の保存値：拡大率 ${fieldText('scale', latest.scale)}%、X ${fieldText('offset_x', latest.offset_x)}、Y ${fieldText('offset_y', latest.offset_y)}、回転 ${fieldText('rotation', latest.rotation)}°。「入力を再適用」で保存できます。`;
        state.reapplyNotice = state.reapply ? notice : '';
        if (state.reapply) showToast(notice);
        else showStatusMessage('現在の入力とサーバーの保存値が一致しています。');
        draw(state);
    } catch (error) {
        if (!state.unavailable) showToast(`${error.message || '保存状態を確認できませんでした。'} 入力を保持しています。`);
    } finally {
        completeOperation(state);
    }
}
function completeOperation(state) {
    state.busy = false;
    if (current !== state) return;
    settleRefresh(state);
}

function settleRefresh(state) {
    if (state.unavailable || !findEnabledBuilding(appState, state.id) || (state.pendingRefresh && !draft(state))) refresh();
    else syncControls(state, false);
}
async function resolveDraft(state, canLeave = () => true) {
    if (state.busy || state.gesture) {
        if (!state.unavailable) showStatusMessage('操作・保存が終わってから切り替えてください。');
        return false;
    }
    if (!state.dirty) return canLeave();
    const choice = await chooseUnsavedChanges(state.unavailable
        ? '建物ビューは無効です。入力を保持するには確認を閉じ、建物ビューを閉じるには変更を取り消してください。'
        : state.unconfirmed
        ? '建物の位置合わせの保存状態が未確認です。入力を残す場合は、編集に戻って保存状態を確認してください。'
        : '建物の位置合わせに未保存の入力があります。');
    if (current !== state || choice === 'cancel' || !canLeave()) return false;
    if (choice === 'save') return save(state, true);
    state.unconfirmed = null; state.reapply = false; state.reapplyNotice = ''; state.saveFailed = false; state.dirty = false; state.invalid = false;
    state.value = { ...(selectedLayer(state)?.transform || IDENTITY_TRANSFORM) };
    if (state.pendingRefresh) refresh();
    else { syncControls(state); draw(state); }
    return true;
}

// 隔離とキーボードの例外を共有する。個票を開いている間は既存モーダルがキャンバスを隔離する。
const sharedControlIds = ['view-switcher', 'dashboard-btn', 'ledgerBtn', 'help-btn',
    'toolbar-manage-menu', 'toolbar-user-menu', 'status-auth-expired-banner',
    'status-toast-message', 'toast', 'ledger-device-sheet-overlay'];
function isolate(state) {
    const allowed = [state.panel, ...sharedControlIds.map(id => document.getElementById(id)).filter(Boolean)];
    state.allowed = allowed;
    const visit = parent => {
        for (const child of parent.children) {
            if (allowed.includes(child)) continue;
            if (allowed.some(node => child.contains(node))) visit(child);
            else if (!child.inert && !['SCRIPT', 'STYLE', 'LINK'].includes(child.tagName)) {
                child.inert = true; state.inert.push(child);
            }
        }
    };
    visit(document.body);
}
function keyboardShield(event) {
    if (!current || getTopModalContainer()) return;
    if (event.key === 'Escape' && !event.isComposing && event.keyCode !== 229) {
        const menu = event.target.closest?.('.toolbar-menu');
        const summary = menu?.open ? menu.querySelector('summary') : null;
        summary?.focus();
        closeToolbarMenu();
    }
    if (!current.allowed.some(node => node.contains(event.target))) {
        event.preventDefault(); event.stopImmediatePropagation(); current.close.focus();
    }
}
function dismiss(state) {
    state.observer.disconnect();
    state.panel.remove();
    state.host.classList.remove('building-view-active');
    state.host.scrollLeft = state.scrollLeft;
    state.host.scrollTop = state.scrollTop;
    for (const node of state.inert) node.inert = false;
    current = null;
    document.removeEventListener('keydown', keyboardShield, true);
    if (!getTopModalContainer()) state.previousFocus?.focus?.({ preventScroll: true });
    eventBus.emit('building-view:changed');
}

async function closeCurrentBuilding(canLeave) {
    const state = current;
    if (!state) return true;
    if (!await resolveDraft(state, canLeave) || !canLeave()) return false;
    if (current !== state) return current == null;
    dismiss(state);
    return true;
}
export function closeBuildingView() { return closeCurrentBuilding(() => true); }
export async function openBuildingView(buildingId) {
    const id = Number(buildingId);
    const getBuilding = () => findEnabledBuilding(appState, id);
    if (!getBuilding()) return false;
    const host = appState.canvas || document.getElementById('canvas');
    if (!host) return false;
    if (current?.id === id) return true;
    if (current && !await closeCurrentBuilding(getBuilding)) return false;
    const building = getBuilding();
    if (!building || current) return false;
    const state = { id, selected: null, comparison: null, comparisonPending: false,
        camera: { ...DEFAULT_CAMERA }, autoFit: true, value: { ...IDENTITY_TRANSFORM },
        starts: new Map(), busy: false, dirty: false, invalid: false, adjusting: false,
        unconfirmed: null, reapply: false, reapplyNotice: '', saveFailed: false, unavailable: false,
        gesture: null, inert: [], images: new Map(), previousFocus: document.activeElement,
        host, scrollLeft: host.scrollLeft, scrollTop: host.scrollTop };
    state.showConnections = true;
    state.selectedFloorOnly = false;
    state.visibleTypes = new Set(DEVICE_TYPE_ENTRIES.map(([type]) => type));
    state.invertDrag = loadInvertDrag();
    state.panMode = false;
    state.connectionSelection = null;
    state.pendingRefresh = false;
    current = state;
    state.buildings = [buildingEntry(building)];
    state.panel = element('section', '', 'building-view');
    const header = element('header', '', 'building-view-header');
    state.title = element('h2', `${building.name} — 建物全体`);
    header.append(state.title);
    const headerActions = element('div', '', 'building-view-header-actions');
    header.append(headerActions);
    const body = element('div', '', 'building-view-body');
    state.displayControls = buildDisplayControls(state);
    state.displayControls.id = 'building-view-display-panel';
    state.displayToggle = panelToggle(headerActions, state.displayControls, '表示設定');
    state.stage = element('div', '', 'building-view-stage');
    state.svg = svgElement('svg', { role: 'group', 'aria-label': 'フロアと機器の配置' });
    state.stage.append(state.svg);
    const sidebar = state.sidebar = element('aside', '', 'building-view-sidebar');
    sidebar.id = 'building-view-details-panel';
    state.sidebarToggle = panelToggle(headerActions, sidebar, 'フロア・明細');
    state.close = button(headerActions, '建物ビューを閉じる', () => { void closeBuildingView(); });
    const floorHeading = element('h3', 'フロア（上の階から）');
    floorHeading.id = 'building-view-floors-heading';
    sidebar.append(floorHeading);
    state.list = element('div', '', 'building-view-floors');
    state.list.setAttribute('role', 'group');
    state.list.setAttribute('aria-labelledby', floorHeading.id);
    sidebar.append(state.list);
    const details = element('div', '', 'building-view-selection');
    state.selection = element('strong');
    state.selectionDetail = element('p'); details.append(state.selection, state.selectionDetail);
    state.openPlan = button(details, '平面図を開く', async () => {
        if (!usable(state)) return;
        const layer = selectedLayer(state);
        if (!layer || (!layer.plan && !permitted())) return;
        const canLeave = () => Boolean(findEnabledBuilding(appState, layer.floor.building_id)) && (Boolean(layer.plan) || permitted());
        if (!await closeCurrentBuilding(canLeave)) return;
        if (layer.plan) {
            window.switchView?.(layer.view.id);
        } else {
            window.openViewManager?.({ floorId: layer.floor.id });
        }
    });
    sidebar.append(details);
    state.connectionSection = element('section', '', 'building-view-selection building-connection-details');
    state.connectionSection.id = 'building-view-connection-details';
    const connectionHeader = element('div', '', 'building-connection-header');
    state.connectionHeading = element('h3');
    state.connectionHeading.tabIndex = -1;
    connectionHeader.append(state.connectionHeading);
    button(connectionHeader, '選択を解除', () => selectConnection(state, null));
    state.connectionBody = element('div');
    state.connectionSection.append(connectionHeader, state.connectionBody);
    sidebar.append(state.connectionSection);
    state.adjust = button(sidebar, '位置合わせモード', async () => {
        if (!usable(state) || state.comparison || state.busy || !permitted()) return;
        if (state.adjusting && (!await resolveDraft(state, () => usable(state)) || !usable(state))) return;
        state.adjusting = !state.adjusting;
        if (state.adjusting) {
            state.autoFit = false;
            state.starts.clear();
            state.starts.set(state.selected, { ...state.value });
        }
        syncReference(state);
        syncControls(state); draw(state);
    });
    state.editor = element('fieldset', '', 'building-view-editor');
    state.editor.id = 'building-view-editor';
    state.adjust.setAttribute('aria-controls', state.editor.id);
    state.editor.append(element('legend', '建物用の位置合わせ'));
    state.inputs = {};
    state.displayed = {};
    const fields = element('div', '', 'building-view-transform-fields');
    state.editor.append(fields);
    const labels = { offset_x: 'X移動', offset_y: 'Y移動', scale: '拡大率（%）', rotation: '回転（度）' };
    for (const [key, label] of Object.entries(labels)) {
        state.inputs[key] = numberField(fields, label, () => {
            if (!usable(state) || !state.adjusting || state.comparisonPending) return;
            readFields(state); syncControls(state, false); draw(state);
            // pointerdown は数値欄の blur より先に届く。ドラッグ終了時に両方をまとめて保存する。
            if (state.gesture?.moving) state.gesture.saveField = true;
            else void save(state);
        }, key === 'rotation' ? { min: '-180', max: '180' } : key === 'scale' ? { min: '0', step: 'any' } : {});
        state.inputs[key].addEventListener('input', () => {
            if (usable(state) && state.adjusting) { readFields(state); syncControls(state, false); draw(state); }
        });
    }
    const setTransform = async value => {
        if (!usable(state) || !state.adjusting || !permitted() || state.busy || state.unconfirmed) return;
        state.value = { ...value }; state.invalid = false; markDraft(state); syncControls(state); draw(state); await save(state, true);
    };
    const alignment = element('div', '', 'building-view-alignment');
    const referenceLabel = element('label', '基準階');
    state.reference = element('select');
    state.reference.id = 'building-view-reference-floor'; referenceLabel.htmlFor = state.reference.id;
    state.reference.addEventListener('change', () => {
        if (!usable(state)) return;
        state.referenceId = Number(state.reference.value) || null;
        syncControls(state, false); draw(state);
    });
    referenceLabel.append(state.reference); alignment.append(referenceLabel);
    state.autoAlign = button(alignment, '簡易自動整列', () => {
        if (!usable(state)) return;
        const value = alignBuildingFloor(selectedLayer(state), referenceLayer(state));
        if (!value) { showToast('図面の外形から整列できませんでした。'); return; }
        void setTransform(value);
    });
    state.referenceHint = element('p');
    alignment.append(state.referenceHint); state.editor.append(alignment);
    const editActions = element('div', '', 'building-view-edit-actions');
    state.restoreStart = button(editActions, '調整開始時に戻す', () => {
        void setTransform(state.starts.get(state.selected) || selectedLayer(state).transform);
    });
    state.restoreDefaults = button(editActions, '既定値に戻す', () => { void setTransform(IDENTITY_TRANSFORM); });
    state.recovery = button(editActions, '保存を再試行', () => {
        if (state.unconfirmed) void checkSave(state);
        else void save(state, true);
    });
    state.editorNotice = element('p', '', 'building-view-editor-notice');
    state.editorNotice.hidden = true;
    const notes = element('ul', '', 'building-view-editor-notes');
    for (const text of ['変更は自動保存', '既定値：倍率100%、X・Y・回転は0', '元図面・機器座標は変更しない']) {
        notes.append(element('li', text));
    }
    state.editor.append(state.editorNotice, editActions, notes);
    sidebar.append(state.editor);
    const camera = element('div', '', 'building-view-camera');
    camera.setAttribute('role', 'group');
    camera.setAttribute('aria-label', '視点操作');
    for (const [label, symbol, action] of [
        ['視点をリセット', '全体', () => {
            state.camera = { ...DEFAULT_CAMERA };
            state.autoFit = true;
            fitCamera(state);
            draw(state);
        }],
        ['縮小', '−', () => zoom(state, 1 / 1.2)],
        ['拡大', '＋', () => zoom(state, 1.2)],
        ['左へ回転', '↶', () => rotate(state, -15)],
        ['右へ回転', '↷', () => rotate(state, 15)]
    ]) {
        const control = button(camera, symbol, () => { if (usable(state) && !state.gesture) action(); });
        control.setAttribute('aria-label', label);
        control.title = label;
    }
    const panArrows = element('div', '', 'building-view-pan-arrows');
    panArrows.id = 'building-view-pan-arrows';
    panArrows.hidden = true;
    const pan = button(camera, '移動', () => {
        if (!usable(state) || state.gesture) return;
        state.panMode = !state.panMode;
        state.panel.classList.toggle('panning', state.panMode);
        pan.setAttribute('aria-pressed', String(state.panMode));
        panArrows.hidden = !state.panMode;
        if (state.autoFit) fitCamera(state);
        draw(state);
    });
    pan.setAttribute('aria-pressed', 'false');
    pan.setAttribute('aria-label', 'ドラッグで移動');
    pan.setAttribute('aria-controls', panArrows.id);
    pan.setAttribute('aria-keyshortcuts', 'ArrowLeft ArrowRight ArrowUp ArrowDown');
    pan.setAttribute('aria-description', 'フォーカス中は矢印キーでも移動できます。');
    pan.title = '空白ドラッグで移動（矢印キーでも移動）';
    const move = (dx, dy) => {
        if (!usable(state) || state.gesture) return;
        panCamera(state, state.camera, dx, dy);
        draw(state);
    };
    const directions = [
        ['ArrowLeft', '←', '左へ移動', -32, 0], ['ArrowUp', '↑', '上へ移動', 0, -32],
        ['ArrowDown', '↓', '下へ移動', 0, 32], ['ArrowRight', '→', '右へ移動', 32, 0]
    ];
    for (const [, symbol, label, dx, dy] of directions) {
        const control = button(panArrows, symbol, () => move(dx, dy));
        control.setAttribute('aria-label', label);
    }
    pan.addEventListener('keydown', event => {
        const direction = directions.find(([key]) => key === event.key);
        if (!direction) return;
        event.preventDefault();
        move(direction[3], direction[4]);
    });
    camera.append(panArrows);
    const invertDrag = button(camera, '反転', () => {
        if (!usable(state)) return;
        state.invertDrag = !state.invertDrag;
        invertDrag.setAttribute('aria-pressed', String(state.invertDrag));
        try { window.localStorage.setItem(INVERT_DRAG_KEY, String(state.invertDrag)); }
        catch { /* 保存できなくても、この表示中は切り替えられる。 */ }
    });
    invertDrag.setAttribute('aria-label', '視点ドラッグを反転');
    invertDrag.setAttribute('aria-pressed', String(state.invertDrag));
    invertDrag.title = '空白ドラッグで視点を回す方向を上下左右とも反転';
    state.stage.append(camera);
    state.cameraControls = camera;
    state.unavailableNotice = element('p', 'この建物では建物ビューを使用できません。位置合わせの入力は保持しています。',
        'building-view-unavailable');
    state.unavailableNotice.hidden = true;
    body.append(state.displayControls, state.stage, state.unavailableNotice, sidebar);
    state.panel.append(header, body); host.append(state.panel);
    host.classList.add('building-view-active');
    host.scrollLeft = 0;
    host.scrollTop = 0;
    state.panel.addEventListener('click', closeToolbarMenu, true);
    // Stop bubbling before document-level canvas shortcuts without cancelling native inputs.
    for (const type of ['keydown', 'keyup', 'click', 'dblclick', 'pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'wheel', 'contextmenu']) {
        state.panel.addEventListener(type, event => event.stopPropagation());
    }
    state.stage.addEventListener('pointerdown', event => startGesture(state, event));
    state.stage.addEventListener('pointermove', event => moveGesture(state, event));
    state.stage.addEventListener('pointerup', event => finishGesture(state, event, true));
    state.stage.addEventListener('pointercancel', event => finishGesture(state, event, false));
    state.stage.addEventListener('lostpointercapture', event => finishGesture(state, event, false));
    state.stage.addEventListener('contextmenu', event => {
        if (!event.target.closest?.('.building-view-camera, [data-building-target]')) event.preventDefault();
    });
    state.stage.addEventListener('wheel', event => {
        if (camera.contains(event.target)) return;
        event.preventDefault();
        zoom(state, Math.exp(-event.deltaY * 0.001));
    }, { passive: false });
    state.observer = new ResizeObserver(() => {
        if (!usable(state)) return;
        if (state.autoFit) fitCamera(state);
        draw(state);
    });
    applyBuildings(state, state.buildings);
    state.observer.observe(state.stage);
    isolate(state); document.addEventListener('keydown', keyboardShield, true);
    state.close.focus(); eventBus.emit('building-view:changed');
    return true;
}
function fitCamera(state) {
    state.frame = sceneFrame(state);
    state.camera = fitBuildingCamera(state.layers, state.camera, state.frame, sceneSize(state),
        state.invalid ? null : state.selected, state.value, state.connections.locations.values());
}

function panCamera(state, origin, dx, dy) {
    state.autoFit = false;
    state.camera.panX = (origin.panX ?? 0) + dx;
    state.camera.panY = (origin.panY ?? 0) + dy;
}

function rotate(state, delta) {
    state.autoFit = false;
    state.camera.azimuth = ((state.camera.azimuth + delta + 540) % 360) - 180;
    draw(state);
}
function zoom(state, factor) {
    if (!usable(state) || state.gesture) return;
    state.autoFit = false;
    state.camera.zoom = clamp(state.camera.zoom * factor, 0.2, 5);
    draw(state);
}
async function selectFloor(state, id) {
    const canSelect = () => usable(state);
    if (!canSelect()) return;
    if (state.selected === id) {
        if (state.connectionSelection) selectConnection(state, null);
        return;
    }
    if (!await resolveDraft(state, canSelect) || !canSelect()) return;
    const layer = state.layers.find(candidate => Number(candidate.floor.id) === id);
    if (!layer) return;
    state.selected = id;
    state.value = { ...layer.transform }; state.invalid = false;
    if (state.adjusting && !state.starts.has(id)) state.starts.set(id, { ...state.value });
    syncReference(state);
    state.connectionSelection = null;
    if (state.selectedFloorOnly) syncVisibleMarkers(state);
    syncControls(state); revealSelectedFloor(state); renderConnectionDetails(state); draw(state);
}
function syncReference(state) {
    if (!state.adjusting) return;
    const target = selectedLayer(state);
    const candidates = target ? state.layers.filter(layer => layer !== target && layer.plan) : [];
    const existing = candidates.find(layer => Number(layer.floor.id) === state.referenceId);
    const nearest = existing ?? candidates.reduce((best, layer) =>
        !best || Math.abs(layer.index - target.index) < Math.abs(best.index - target.index) ? layer : best, null);
    state.referenceId = nearest ? Number(nearest.floor.id) : null;
    state.reference.replaceChildren();
    for (let i = candidates.length - 1; i >= 0; i--) {
        const option = element('option', candidates[i].floor.name);
        option.value = String(candidates[i].floor.id);
        state.reference.append(option);
    }
    state.reference.value = state.referenceId == null ? '' : String(state.referenceId);
    state.referenceHint.textContent = !nearest ? '基準にできる別の図面がありません。' :
        !target?.plan ? '調整対象に図面がないため、自動整列はできません。' : '図面の外形を目安に整列します。';
}
function buildingEntry(building) {
    const id = Number(building.id);
    return { id, name: building.name, layers: buildingFloorLayers(appState, id) };
}

function sceneFrame(state) {
    return state.comparison ? buildingComparisonFrame(state.buildings, state.comparison.anchorIds) : buildingSceneFrame(state.layers);
}

function applyBuildings(state, buildings) {
    state.buildings = buildings;
    state.layers = state.comparison ? buildings.flatMap(building => building.layers) : buildings[0].layers;
    if (state.comparison) {
        const ids = state.comparison.anchorIds;
        if (!ids || !buildings.every(({ layers }, index) => layers.length
            ? layers.some(layer => Number(layer.floor.id) === ids[index]) : ids[index] === null)) {
            state.comparison.anchorIds = buildingComparisonAnchors(buildings[0].layers, buildings[1].layers).ids;
        }
    }
    const name = state.comparison ? `${buildings[0].name} と ${buildings[1].name}` : buildings[0].name;
    const caption = state.comparison ? '2棟比較' : '建物全体';
    state.title.textContent = `${name} — ${caption}`;
    state.panel.setAttribute('aria-label', `${name} ${caption}`);
    syncComparisonControls(state);
    const floorFocus = populateFloors(state);
    syncConnections(state, state.layers);
    if (state.autoFit) fitCamera(state);
    else state.frame = sceneFrame(state);
    syncControls(state);
    floorFocus?.focus({ preventScroll: true });
    revealSelectedFloor(state); draw(state);
}

function populateFloors(state) {
    const focusedId = state.list.contains(document.activeElement) ? document.activeElement.dataset.floorId : null;
    const selection = selectedLayer(state) ?? state.layers[0];
    state.selected = selection ? Number(selection.floor.id) : null;
    state.value = { ...(selection?.transform || IDENTITY_TRANSFORM) };
    state.list.replaceChildren();
    state.floorItems = [];
    for (const { id, name, layers } of state.buildings) {
        let group = state.list;
        if (state.comparison) {
            group = element('div', '', 'building-view-floor-group');
            const heading = element('h4', name);
            heading.id = `building-view-floor-group-${id}`;
            group.setAttribute('role', 'group');
            group.setAttribute('aria-labelledby', heading.id);
            group.append(heading);
            if (!layers.length) group.append(element('p', 'フロアがありません'));
            state.list.append(group);
        }
        for (let i = layers.length - 1; i >= 0; i--) {
            const layer = layers[i];
            const item = button(group, layer.floor.name, () => { void selectFloor(state, Number(layer.floor.id)); });
            item.dataset.floorId = String(layer.floor.id);
            if (state.comparison) item.setAttribute('aria-label', floorName(state, layer));
            state.floorItems.push(item);
            const url = layer.plan?.image_url;
            if (url && !state.images.has(url)) {
                const image = new Image(); state.images.set(url, image);
                image.onload = () => draw(state);
                image.onerror = () => {
                    if (!usable(state) || !state.layers.some(layer => layer.plan?.image_url === url)) return;
                    showToast('読み込めない図面は簡易プレートで表示しています。');
                    draw(state);
                };
                image.src = url;
            }
        }
    }
    const focus = id => state.floorItems.find(item => item.dataset.floorId === id);
    syncReference(state);
    return focusedId == null ? null : focus(focusedId) ?? focus(String(state.selected)) ?? state.close;
}

function syncConnections(state, layers) {
    const connections = buildingConnections(appState, layers);
    const { devices, locations, groups } = connections;
    if (layers !== state.layers) {
        // 描画を保留している間、所属棟や代表図が変わった階には新しい配置を描かない。
        const visible = new Map(state.layers.map(layer => [Number(layer.floor.id), layer]));
        for (const [key, location] of locations) {
            const layer = visible.get(Number(location.layer.floor.id));
            if (layer?.view && Number(layer.view.id) === Number(location.layer.view.id) &&
                floorBuildingId(layer) === floorBuildingId(location.layer)) continue;
            locations.delete(key);
            for (const device of location.devices) devices.delete(Number(device.id));
        }
        for (const [key, group] of groups) {
            if (!devices.has(group.from_id) || !devices.has(group.to_id)) groups.delete(key);
        }
    }
    const counts = new Map();
    for (const { layer } of devices.values()) {
        const id = Number(layer.floor.id);
        counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    state.connections = connections;
    state.connectionCounts = counts;
    syncVisibleMarkers(state);
    renderConnectionDetails(state);
}

function markerOnVisibleFloor(state, layer) {
    return !state.selectedFloorOnly || Number(layer.floor.id) === state.selected;
}

function syncVisibleMarkers(state) {
    const { devices, locations, groups } = state.connections;
    const filterTypes = state.visibleTypes.size !== DEVICE_TYPE_ENTRIES.length;
    let visible = locations;
    if (filterTypes || state.selectedFloorOnly) {
        visible = new Map();
        for (const [key, location] of locations) {
            if (!markerOnVisibleFloor(state, location.layer)) continue;
            const members = filterTypes ? location.devices.filter(device => state.visibleTypes.has(deviceType(device))) : location.devices;
            if (members.length) visible.set(key, members.length === location.devices.length ? location : { ...location, devices: members });
        }
    }
    state.visibleLocations = visible;
    const selection = state.connectionSelection;
    if (!selection) return;
    if (selection.kind === 'link') {
        if (!showConnection(state, groups.get(selection.key))) state.connectionSelection = null;
    } else if (selection.kind === 'device') {
        const marker = devices.get(selection.key);
        if (!marker || !markerOnVisibleFloor(state, marker.layer) || !state.visibleTypes.has(deviceType(marker.device))) {
            state.connectionSelection = null;
        }
    } else {
        const location = visible.get(selection.key);
        if (!location) state.connectionSelection = null;
        else if (location.devices.length === 1) state.connectionSelection = { kind: 'device', key: Number(location.devices[0].id) };
    }
}

function selectConnection(state, selection) {
    if (!usable(state) || state.gesture || state.busy) return;
    state.connectionSelection = selection;
    if (selection && state.sidebar.hidden) setPanelExpanded(state.sidebarToggle, state.sidebar, true);
    renderConnectionDetails(state); draw(state);
}

const endpointName = (state, endpoint) => `${endpoint.device.name || `機器 #${endpoint.device.id}`}（${floorName(state, endpoint.layer)}）`;
function systemName(state, id) {
    return id == null ? '未設定' : state.connections.systems.get(Number(id))?.name || `不明（#${id}）`;
}

async function openConnectionEndpoint(state, groupKey, endpoint, sheet) {
    const deviceId = Number(endpoint.device.id);
    const floorId = Number(endpoint.layer.floor.id);
    const viewId = Number(endpoint.layer.view.id);
    const targetExists = () => {
        if (appState.authExpired || !findEnabledBuilding(appState, floorBuildingId(endpoint.layer))) return false;
        if (sheet) return appState.devices.some(device => Number(device.id) === deviceId);
        const floor = appState.floors.find(floor => Number(floor.id) === floorId &&
            Number(floor.building_id) === floorBuildingId(endpoint.layer));
        return floor && Number(floorViewSelection(floor, appState.views).view?.id) === viewId;
    };
    const canLeave = () => {
        const selection = state.connectionSelection;
        const group = state.connections.groups.get(groupKey);
        return usable(state) && selection?.kind === 'link' && selection.key === groupKey &&
            group && (group.from_id === deviceId || group.to_id === deviceId) && targetExists();
    };
    if (!canLeave() || getTopModalContainer()) return;
    if (sheet) {
        const ledger = await import('../modals/ledger-modal.js');
        const canOpen = () => canLeave() && !getTopModalContainer();
        if (!canOpen() || !await resolveDraft(state, canOpen) || !canOpen()) return;
        // 保存による明細の再描画後は、開いたときの DOM 要素を参照できない。
        const restoreFocusTo = () => {
            if (current !== state) return state.previousFocus;
            if (!usable(state)) return state.close;
            if (state.sidebar.hidden) return state.sidebarToggle;
            return state.connectionBody.querySelector(`[data-building-action="sheet:${deviceId}"]`) || connectionFocusTarget(state);
        };
        await ledger.openLedgerDetail(deviceId, { tab: 'ports', canOpen, restoreFocusTo });
    } else if (await closeCurrentBuilding(canLeave) && !current && targetExists()) {
        await window.switchView?.(viewId);
    }
}

const connectionFocusTarget = state => state.displayControls.hidden ? state.displayToggle : state.connectionToggle;

function renderConnectionDetails(state) {
    const { connectionBody: body, connectionHeading: heading, connectionSection: section } = state;
    const focused = section.contains(document.activeElement);
    const active = focused ? document.activeElement.getAttribute('data-building-action') : null;
    const selection = state.connectionSelection;
    section.hidden = state.unavailable || !selection;
    body.replaceChildren();
    if (section.hidden) {
        if (focused && !state.unavailable) connectionFocusTarget(state).focus();
        return;
    }
    const { devices, groups } = state.connections;
    const action = (parent, key, text, handler) => {
        const control = button(parent, text, handler);
        control.setAttribute('data-building-action', key);
        return control;
    };
    if (selection.kind === 'location') {
        const location = state.visibleLocations.get(selection.key);
        heading.textContent = '同じ位置の機器を選択';
        for (const device of location.devices) {
            const id = Number(device.id);
            action(body, `device:${id}`, endpointName(state, devices.get(id)), () => selectConnection(state, { kind: 'device', key: id }));
        }
    } else if (selection.kind === 'device') {
        const id = selection.key;
        heading.textContent = state.comparison ? '関連する接続' : '関連するフロア間接続';
        body.append(element('p', endpointName(state, devices.get(id))));
        let found = false;
        for (const [key, group] of groups) {
            const peer = group.from_id === id ? group.to_id : group.to_id === id ? group.from_id : null;
            if (peer == null || !showConnection(state, group)) continue;
            found = true;
            action(body, `link:${key}`, `${endpointName(state, devices.get(peer))}：${group.link_ids.length} 件`,
                () => selectConnection(state, { kind: 'link', key }));
        }
        if (!found) body.append(element('p', showAnyConnections(state) ? '表示対象の接続はありません。' :
            state.comparison ? '接続は非表示です。' : 'フロア間接続は非表示です。'));
    } else {
        const key = selection.key;
        const group = groups.get(key);
        heading.textContent = '接続明細';
        const kind = !state.comparison ? '' : group.interBuilding ? '建物間接続 · ' : 'フロア間接続（棟内） · ';
        body.append(element('p', `${kind}${group.link_ids.length} 件 · 系統：${group.system_ids.map(id => systemName(state, id)).join('、')}`));
        for (const id of [group.from_id, group.to_id]) {
            const endpoint = devices.get(id);
            const row = element('div', '', 'building-connection-endpoint');
            const name = endpointName(state, endpoint);
            row.append(element('strong', name));
            action(row, `sheet:${id}`, '個票（接続・ポート）を開く', () => openConnectionEndpoint(state, key, endpoint, true))
                .setAttribute('aria-label', `${name}の個票（接続・ポート）を開く`);
            action(row, `plan:${id}`, '代表平面図を開く', () => openConnectionEndpoint(state, key, endpoint, false))
                .setAttribute('aria-label', `${name}の代表平面図を開く`);
            body.append(row);
        }
        const list = element('ul', '', 'building-connection-members');
        for (const link of group.members) {
            const row = element('li');
            const from = endpointName(state, devices.get(Number(link.from_id)));
            const to = endpointName(state, devices.get(Number(link.to_id)));
            const fields = element('p', '', 'building-connection-fields');
            fields.append(element('span', `系統：${systemName(state, link.system_id)}`));
            if (link.label) fields.append(element('span', `ラベル：${link.label}`));
            row.append(element('strong', `接続 #${link.id}`),
                element('p', `${from}：${link.from_port || '未指定'} ↔ ${to}：${link.to_port || '未指定'}`), fields);
            if (link.memo) row.append(element('p', `備考：${link.memo}`));
            list.append(row);
        }
        body.append(list);
    }
    if (active) (body.querySelector(`[data-building-action="${active}"]`) || heading).focus({ preventScroll: true });
}

function sceneButton(state, label, selection, pressed, emphasis) {
    const group = svgElement('g', { class: `building-scene-button${emphasis}`, role: 'button', tabindex: 0,
        'aria-label': label, 'aria-pressed': pressed, 'aria-controls': state.connectionSection.id,
        'data-building-target': `${selection.kind}:${selection.key}` });
    const title = svgElement('title', {});
    title.textContent = label;
    group.append(title);
    const activate = keyboard => {
        selectConnection(state, pressed ? null : selection);
        if (keyboard && !state.connectionSection.hidden && usable(state) && !state.busy) state.connectionHeading.focus();
    };
    group.addEventListener('click', () => activate(false));
    group.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') event.preventDefault();
        if (event.key === 'Enter' && !event.repeat) activate(true);
    });
    group.addEventListener('keyup', event => {
        if (event.key === ' ') { event.preventDefault(); activate(true); }
    });
    return group;
}

function drawConnections(state, projectors) {
    const { devices, locations, groups, systems } = state.connections;
    const selection = state.connectionSelection;
    const selectedDevice = selection?.kind === 'device' ? selection.key : null;
    const selectedLink = selection?.kind === 'link' ? selection.key : null;
    const selectedLocation = selection?.kind === 'location' ? selection.key : null;
    const highlight = selectedDevice != null || selectedLink != null;
    const related = new Set();
    if (selectedDevice != null) related.add(selectedDevice);
    const projected = new Map();
    const showLinks = showAnyConnections(state);
    for (const { layer, point, devices } of (showLinks ? locations : state.visibleLocations).values()) {
        const screen = projectors.get(Number(layer.floor.id))(point);
        for (const device of devices) projected.set(Number(device.id), screen);
    }
    const links = svgElement('g', { id: 'building-view-links' });
    const emphasizedLinks = [];
    if (showLinks) {
        for (const [key, group] of groups) {
            if (!showConnection(state, group)) continue;
            const { from_id: from, to_id: to } = group;
            const pressed = selectedLink === key;
            const emphasized = pressed || selectedDevice === from || selectedDevice === to;
            if (emphasized) { related.add(from); related.add(to); }
            const count = group.link_ids.length;
            const label = `${endpointName(state, devices.get(from))} ↔ ${endpointName(state, devices.get(to))}：${count} 件`;
            const control = sceneButton(state, label, { kind: 'link', key }, pressed,
                emphasized ? ' is-emphasized' : highlight ? ' is-muted' : '');
            const a = projected.get(from), b = projected.get(to);
            const coordinates = { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
            control.append(
                svgElement('line', { ...coordinates, class: 'building-link-halo', 'aria-hidden': 'true' }),
                svgElement('line', { ...coordinates, class: 'building-link-stroke',
                    stroke: getLinkColor({ system_id: group.system_id }, systems) }),
                svgElement('line', { ...coordinates, class: 'building-link-hit' })
            );
            if (count > 1) {
                const label = `×${count}`;
                const width = label.length * .7 + .35;
                const badge = svgElement('g', { class: 'building-link-count', 'aria-hidden': 'true',
                    transform: `translate(${(a.x + b.x) / 2} ${(a.y + b.y) / 2})` });
                const text = svgElement('text', { class: 'building-link-badge' });
                text.textContent = label;
                badge.append(svgElement('rect', { x: `${-width / 2}em`, y: '-.65em', width: `${width}em`,
                    height: '1.3em', rx: '.65em' }), text);
                control.append(badge);
            }
            if (emphasized) emphasizedLinks.push(control);
            else links.append(control);
        }
    }
    for (const control of emphasizedLinks) links.append(control);
    const markers = svgElement('g', { class: 'building-device-markers' });
    const emphasizedMarkers = [];
    for (const [key, location] of state.visibleLocations) {
        const device = location.devices[0];
        const id = Number(device.id);
        const multiple = location.devices.length > 1;
        const pressed = multiple ? selectedLocation === key : selectedDevice === id;
        const emphasized = pressed || location.devices.some(device => related.has(Number(device.id)));
        const label = multiple ? `${floorName(state, location.layer)}：同じ位置に ${location.devices.length} 台` : endpointName(state, devices.get(id));
        const target = multiple ? { kind: 'location', key } : { kind: 'device', key: id };
        const control = sceneButton(state, label, target, pressed,
            emphasized ? ' is-emphasized' : highlight ? ' is-muted' : '');
        const { x: cx, y: cy } = projected.get(id);
        const { color } = DEVICE_TYPES[deviceType(device)];
        control.append(
            svgElement('circle', { cx, cy, r: multiple ? 8 : 4, class: 'building-device-dot',
                fill: multiple ? 'var(--bg-panel-solid)' : color }),
            svgElement('circle', { cx, cy, r: 8, class: 'building-device-hit' })
        );
        if (multiple) {
            const count = svgElement('text', { x: cx, y: cy, class: 'building-device-count' });
            count.textContent = String(location.devices.length);
            control.append(count);
        }
        if (emphasized) emphasizedMarkers.push(control);
        else markers.append(control);
    }
    for (const control of emphasizedMarkers) markers.append(control);
    state.svg.append(links, markers);
}

function size(state) { return { width: Math.max(state.stage.clientWidth, 1), height: Math.max(state.stage.clientHeight, 1) }; }
function sceneSize(state, viewport = size(state)) {
    const reserved = (state.cameraControls.offsetHeight || 0) + 8;
    return { width: viewport.width, height: viewport.height - Math.min(reserved, viewport.height / 3) };
}
function draw(state) {
    if (!usable(state)) return;
    const viewport = size(state);
    state.svg.setAttribute('viewBox', `0 0 ${viewport.width} ${viewport.height}`);
    const dimensions = sceneSize(state, viewport);
    const focusedTarget = state.svg.contains(document.activeElement)
        ? document.activeElement.getAttribute('data-building-target') : null;
    state.svg.replaceChildren();
    const outlines = svgElement('g', { 'pointer-events': 'none' });
    const labels = svgElement('g', { 'class': 'building-floor-labels', 'pointer-events': 'none' });
    let selectedGroup, selectedOutline, selectedLabel;
    let targetCorners, referenceCorners;
    const projectors = new Map();
    const stacks = state.comparison ? new Map(state.buildings.map(({ id }) =>
        [id, { faces: svgElement('g', { 'data-building-id': id }), top: Infinity }])) : null;
    for (const layer of state.layers) {
        const active = Number(layer.floor.id) === state.selected;
        const transform = active && !state.invalid ? state.value : layer.transform;
        const z = buildingFloorZ(layer, state.frame);
        const project = point => projectBuildingPoint(point, z, state.camera, state.frame, dimensions, layer);
        projectors.set(Number(layer.floor.id), point => project(transformBuildingPoint(point, transform)));
        const points = transformedFloorCorners(layer, transform).map(project);
        const stack = stacks?.get(floorBuildingId(layer));
        if (stack) {
            for (const { y } of points) stack.top = Math.min(stack.top, y);
        }
        if (state.adjusting && active) targetCorners = points;
        if (state.adjusting && Number(layer.floor.id) === state.referenceId) referenceCorners = points;
        const group = svgElement('g', { 'data-floor-id': layer.floor.id, class: active ? 'building-floor selected' : 'building-floor' });
        const pointsText = points.map(point => `${point.x},${point.y}`).join(' ');
        group.append(svgElement('polygon', { points: pointsText, class: 'building-floor-face' }));
        const image = layer.plan && state.images.get(layer.plan.image_url);
        if (image?.complete && image.naturalWidth) {
            const [a, b, , d] = points;
            const width = Number(layer.plan.image_width), height = Number(layer.plan.image_height);
            group.append(svgElement('image', { href: layer.plan.image_url, width, height,
                preserveAspectRatio: 'none',
                transform: `matrix(${(b.x - a.x) / width} ${(b.y - a.y) / width} ${(d.x - a.x) / height} ${(d.y - a.y) / height} ${a.x} ${a.y})` }));
        }
        const outline = svgElement('polygon', { points: pointsText, class: active ? 'building-floor-outline selected' : 'building-floor-outline' });
        const anchor = points.reduce((left, point) => point.x < left.x ? point : left);
        const x = anchor.x + 5;
        const text = svgElement('text', { x, y: anchor.y - 7, class: active ? 'building-floor-label selected' : 'building-floor-label' });
        text.textContent = layer.floor.name;
        if (!layer.plan || (image?.complete && !image.naturalWidth)) {
            const note = svgElement('tspan', { x, dy: '1.25em', class: 'building-floor-label-note' });
            note.textContent = '図面なし';
            text.append(note);
        }
        if (active) {
            selectedGroup = group; selectedOutline = outline; selectedLabel = text;
        } else {
            (stack?.faces ?? state.svg).append(group);
            outlines.append(outline); labels.append(text);
        }
    }
    if (selectedGroup) {
        (stacks?.get(floorBuildingId(selectedLayer(state))).faces ?? state.svg).append(selectedGroup);
        outlines.append(selectedOutline); labels.append(selectedLabel);
    }
    if (stacks) {
        const [primary, secondary] = state.buildings;
        const left = stacks.get(primary.id).faces, right = stacks.get(secondary.id).faces;
        // 回転後の +Y 側が手前。選択階も棟の前後を越えて描かない。
        if (state.camera.azimuth < 0 && state.camera.azimuth > -180) state.svg.append(right, left);
        else state.svg.append(left, right);
        for (const { id, name } of state.buildings) {
            const { offsetX, topZ } = state.frame.buildings.get(id);
            const { x, y } = projectBuildingPoint({ x: offsetX, y: 0 }, topZ, state.camera, state.frame, dimensions);
            const stackTop = stacks.get(id).top;
            const rawY = Math.min(y, stackTop - 8);
            const label = svgElement('text', { x, y: stackTop > 0 ? Math.max(16, rawY) : rawY,
                class: 'building-floor-label building-name-label' });
            label.textContent = name;
            labels.append(label);
        }
    }
    state.svg.append(outlines);
    if (targetCorners && referenceCorners) {
        const guide = svgElement('g', { class: 'building-alignment-guide', 'pointer-events': 'none' });
        for (let i = 0; i < 4; i++) {
            const a = referenceCorners[i], b = targetCorners[i];
            guide.append(svgElement('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y }));
        }
        state.svg.append(guide);
    }
    drawConnections(state, projectors);
    state.svg.append(labels);
    if (focusedTarget) {
        const target = state.svg.querySelector(`[data-building-target="${focusedTarget}"]`);
        (target || connectionFocusTarget(state)).focus({ preventScroll: true });
    }
}
function startGesture(state, event) {
    if (!usable(state) || state.gesture || state.busy || state.comparisonPending ||
        (event.button !== 0 && event.button !== 2) || event.isPrimary === false ||
        event.target.closest?.('.building-view-camera, [data-building-target]')) return;
    const id = Number(event.target.closest?.('[data-floor-id]')?.getAttribute('data-floor-id')) || null;
    const forcePan = event.button === 2 || event.shiftKey;
    // 位置合わせ中の選択階移動を除き、移動モード時はフロア上からでも移動でき、クリックで階選択も維持する。
    const moving = !forcePan && id != null && state.adjusting && id === state.selected && permitted() && !state.invalid && !state.unconfirmed;
    const pan = forcePan || (!moving && state.panMode);
    state.gesture = { pointerId: event.pointerId, x: event.clientX, y: event.clientY,
        camera: { ...state.camera }, autoFit: state.autoFit, dragDirection: state.invertDrag ? -1 : 1,
        value: { ...state.value }, id: forcePan ? null : id, moving, pan, moved: false };
    try { state.stage.setPointerCapture(event.pointerId); }
    catch { state.gesture = null; return; }
    syncComparisonLocks(state);
}
function moveGesture(state, event) {
    const gesture = state.gesture;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
    if (!gesture.moved && Math.hypot(dx, dy) < 4) return;
    gesture.moved = true;
    if (gesture.moving) {
        if (!permitted()) { finishGesture(state, event, false); return; }
        const delta = buildingDragDelta(dx, dy, state.camera, state.frame, sceneSize(state));
        state.value = { ...gesture.value, offset_x: gesture.value.offset_x + delta.x, offset_y: gesture.value.offset_y + delta.y };
        state.invalid = false; markDraft(state); syncControls(state);
    } else if (gesture.pan) {
        panCamera(state, gesture.camera, dx, dy);
    } else if (!gesture.id) {
        state.autoFit = false;
        state.camera.azimuth = ((gesture.camera.azimuth + dx * 0.4 * gesture.dragDirection + 180) % 360 + 360) % 360 - 180;
        state.camera.elevation = clamp(gesture.camera.elevation - dy * 0.2 * gesture.dragDirection, 15, 75);
    }
    draw(state);
}
function finishGesture(state, event, commit) {
    const gesture = state.gesture;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    releaseGesture(state);
    syncComparisonLocks(state);
    if (!commit) {
        if (gesture.moving) {
            state.value = gesture.value; markDraft(state); syncControls(state);
            if (gesture.saveField && permitted()) void save(state);
        } else {
            state.camera = gesture.camera;
            state.autoFit = gesture.autoFit;
        }
        if (state.pendingRefresh && !draft(state)) refresh();
        else draw(state);
        return;
    }
    if (gesture.saveField || (gesture.moving && gesture.moved)) {
        void save(state);
        return;
    }
    if (state.pendingRefresh && !draft(state)) refresh();
    if (!gesture.moved && gesture.id) { void selectFloor(state, gesture.id); return; }
}

function releaseGesture(state) {
    const gesture = state.gesture;
    state.gesture = null;
    if (gesture && state.stage.hasPointerCapture(gesture.pointerId)) state.stage.releasePointerCapture(gesture.pointerId);
}

function refresh() {
    const state = current;
    if (!state) return;
    const building = findEnabledBuilding(appState, state.id);
    if (!building) {
        const changed = !state.unavailable;
        state.unavailable = true;
        releaseGesture(state);
        if (!draft(state)) { dismiss(state); return; }
        const active = document.activeElement;
        const mustRefocus = state.stage.contains(active) || state.connectionSection.contains(active) || state.displayControls.contains(active);
        if (changed) {
            // 調整入力だけを保持し、無効な建物の描画や操作は停止する。
            state.stage.hidden = true;
            state.unavailableNotice.hidden = false;
            state.svg.replaceChildren();
            syncControls(state, false);
            showToast('この建物では建物ビューを使用できません。位置合わせの入力は保持しています。');
            eventBus.emit('building-view:changed');
        } else syncControls(state, false);
        if (!state.busy && (mustRefocus || (state.panel.contains(active) && active.disabled))) {
            state.close.focus({ preventScroll: true });
        }
        return;
    }
    if (state.unavailable) {
        state.unavailable = false;
        state.stage.hidden = false;
        state.unavailableNotice.hidden = true;
        eventBus.emit('building-view:changed');
    }
    const buildings = [buildingEntry(building)];
    if (state.comparison) {
        const secondary = findEnabledBuilding(appState, state.comparison.id);
        if (!secondary) {
            const removed = state.buildings[1];
            const exists = appState.buildings.some(row => Number(row.id) === removed.id);
            releaseGesture(state);
            state.pendingRefresh = false;
            const reason = exists ? '建物ビューが無効になった' : '建物が削除された';
            removeComparison(state, buildings, `${removed.name}：${reason}ため、比較を解除しました。`);
            return;
        }
        buildings.push(buildingEntry(secondary));
    }
    if (draft(state) || state.gesture) {
        // 描画と保存の基準は固定し、接続だけ最新データで引き直す。
        state.pendingRefresh = true;
        if (!state.comparison) syncComparisonControls(state);
        syncConnections(state, state.comparison ? buildings.flatMap(building => building.layers) : buildings[0].layers);
        syncControls(state, false); draw(state);
        return;
    }
    state.pendingRefresh = false;
    applyBuildings(state, buildings);
}
for (const event of ['resources:reloaded', 'resources:saved', 'hierarchy:changed', 'floor-plan:saved', 'resource:reloaded',
    'link-systems:changed']) eventBus.on(event, refresh);
eventBus.on('auth:expired', () => {
    const state = current;
    if (!state || state.unavailable) return;
    if (state.gesture) finishGesture(state, { pointerId: state.gesture.pointerId }, false);
    if (!usable(state)) return;
    showToast('認証が失効しました。位置合わせは保存できません。入力は保持しています。'); syncControls(state, false);
});
