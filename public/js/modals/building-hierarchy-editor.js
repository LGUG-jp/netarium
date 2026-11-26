import { appState, normalizeView, normalizeDevice, normalizePlacement, normalizeCanvasNote, normalizeFloorPlan, recalculateNextIds } from '../core/state.js';
import { connectionsFromData } from '../core/connection-data.js';
import { apiFetch } from '../core/api-client.js';
import { eventBus } from '../core/event-bus.js';
import { hasAnyDeviceDraftChanges } from '../core/device-drafts.js';
import { hasPendingChanges, runResourceMutation, flushSaveQueue, hasResourceConflict } from '../core/save-queue.js';
import { resetResourceBaseline } from '../core/resource-save.js';
import { orderedBuildings, viewHierarchyPath } from '../core/building-hierarchy.js';
import { findEnabledBuilding, floorViewSelection, isPhysicalViewOnFloor } from '../core/building-view-model.js';
import { isCurrentUserAdmin } from '../ui/access-control.js';
import { hasUnappliedPanelChanges, hasUnappliedLinkPanelChanges, closePanel, closeLinkPanel } from '../ui/property-panel.js';
import { markDirty } from '../ui/status-bar.js';
import { showToast } from '../ui/toast.js';
import { toSaveRackSettings, toSaveRackMount, toSaveRackShelf, toSaveRackShelfDevice } from '../core/rack-layout.js';
import { toSaveFloorRackPlacement } from '../core/floor-rack-data.js';
import { markSaved } from '../ui/status-bar.js';
import { endLinkMode } from '../core/link-mode.js';
import { chooseUnsavedChanges } from '../core/unsaved-changes-dialog.js';

let body, status, editor, selection, onSaved;
let busy = false, dirty = false, resolving = false, revision = 0, editorGeneration = 0;
let applyChanges;
let attachState;
const node = (tag, text = '', className = '') => {
    const element = document.createElement(tag);
    element.textContent = text;
    if (className) element.className = className;
    return element;
};
const admin = () => isCurrentUserAdmin() && !appState.authExpired && !appState.isPinging;
const clean = () => !hasPendingChanges() && !hasAnyDeviceDraftChanges() && !appState.viewManagerFormDirty &&
    !hasUnappliedPanelChanges() && !hasUnappliedLinkPanelChanges() && !appState.isFloorPlanUpdating && !appState.floorPlanAdjustMode &&
    !(appState.resourceConflicts?.devices?.size || appState.resourceConflicts?.views?.size);
export async function resolveHierarchyEditor() {
    if (busy || resolving) return false;
    if (!dirty) return true;
    const generation = editorGeneration;
    resolving = true;
    try {
        const choice = await chooseUnsavedChanges('建物・フロアに未適用の入力があります。どうしますか？');
        if (generation !== editorGeneration) return false;
        if (choice === 'save') return await applyChanges() && generation === editorGeneration && !dirty;
        if (choice !== 'discard') return false;
        dirty = false;
        renderManager();
        return true;
    } finally { resolving = false; }
}
export function clearHierarchyEditor() {
    editorGeneration++;
    selection = null; dirty = false; applyChanges = null;
    attachState = null;
}
export function hasHierarchyEditorDraft() { return dirty; }

function button(parent, text, action, danger = false) {
    const element = node('button', text, `btn btn-secondary btn-sm${danger ? ' btn-danger' : ''}`);
    element.type = 'button'; element.disabled = busy;
    element.addEventListener('click', action);
    parent.appendChild(element);
    return element;
}


function field(form, key, text, value, choices = null) {
    const label = node('label', text);
    const input = node(choices ? 'select' : 'input');
    label.htmlFor = `hierarchy-${key}`;
    input.id = `hierarchy-${key}`; input.name = key;
    if (choices) {
        for (const [id, name] of choices) {
            const option = node('option', name); option.value = String(id); input.appendChild(option);
        }
    } else if (key === 'sort_order') {
        input.type = 'number'; input.min = '-999999'; input.max = '999999'; input.step = '1';
    } else {
        input.type = 'text'; input.maxLength = 100;
    }
    input.value = String(value ?? ''); input.required = key !== 'representative_view_id';
    input.addEventListener('input', () => { if (key !== 'view-search') dirty = true; });
    input.addEventListener('change', () => { if (key !== 'view-search') dirty = true; });
    label.appendChild(input); form.appendChild(label);
    return input;
}


export function renderHierarchyEditor(container, next, saved) {
    editorGeneration++;
    body = container; selection = next; onSaved = saved;
    revision = Number(appState.dataRevision); dirty = false;
    attachState = { expanded: false, query: '', includeAssigned: false };
    renderManager();
}

function renderManager() {
    body.replaceChildren();
    editor = node('form', '', 'view-manager-form'); editor.id = 'building-hierarchy-form'; body.appendChild(editor);
    status = node('p', '', 'form-support'); status.setAttribute('role', 'status'); editor.appendChild(status);
    const header = node('div', '', 'view-manager-editor-header'); editor.appendChild(header);
    const isFloor = selection?.kind === 'floor';
    const row = selection && (isFloor ? appState.floors : appState.buildings).find(item => Number(item.id) === Number(selection.id));
    header.appendChild(node('h3', selection ? `${isFloor ? 'フロア' : '建物'}${row ? 'を編集' : 'を登録'}` : '建物・フロア'));
    const tools = node('div', '', 'view-manager-editor-tools'); header.appendChild(tools);
    const reload = button(tools, '', refresh); reload.id = 'hierarchy-refresh-btn'; reload.title = '最新情報を取得';
    const icon = node('img'); icon.src = 'assets/icons/app/refresh.svg'; icon.width = 16; icon.height = 16;
    icon.alt = ''; icon.setAttribute('aria-hidden', 'true'); reload.appendChild(icon); reload.appendChild(node('span', '更新'));
    if (!selection) return;
    const kind = selection.kind;
    const name = field(editor, 'name', '名称', row?.name || '');
    const order = field(editor, 'sort_order', '表示順（小さい順）', row?.sort_order ?? 0);
    const building = isFloor ? field(editor, 'building_id', '建物', row?.building_id ?? selection.building_id ?? appState.buildings[0]?.id,
        orderedBuildings(appState).map(item => [item.id, item.name])) : null;
    const physicalViews = isFloor && row ? appState.views.filter(view => isPhysicalViewOnFloor(view, row.id)) : [];
    const representative = isFloor ? field(editor, 'representative_view_id', '代表物理配置ビュー', row?.representative_view_id,
        [['', '自動選択（未指定）'], ...physicalViews.map(view => [view.id, view.name])]) : null;
    if (isFloor) {
        const hint = node('p', '', 'form-support');
        hint.id = 'hierarchy-representative-hint';
        editor.appendChild(hint);
        const updateHint = () => {
            hint.hidden = representative.value !== '';
            if (hint.hidden) representative.removeAttribute('aria-describedby');
            else representative.setAttribute('aria-describedby', hint.id);
        };
        hint.textContent = physicalViews.length === 0 ? '物理配置ビューがありません。'
            : physicalViews.length === 1 ? `建物ビューでは「${physicalViews[0].name}」を自動選択します。2件以上になると代表の指定が必要です。`
            : '物理配置ビューが複数あります。建物ビュー用の代表を指定してください。';
        representative.addEventListener('change', updateHint);
        updateHint();
        editor.appendChild(node('p', 'フロア名は自由形式です。B2、1F、RF などの上下順序は表示順で指定してください。', 'form-support'));
        if (row) renderAttachView(row);
    }
    let useBuildingView;
    if (!isFloor) {
        const label = node('label', '', 'hierarchy-checkbox');
        useBuildingView = node('input');
        useBuildingView.type = 'checkbox';
        useBuildingView.id = 'hierarchy-building_view_enabled';
        useBuildingView.name = 'building_view_enabled';
        useBuildingView.checked = row?.building_view_enabled === 1;
        useBuildingView.addEventListener('change', () => { dirty = true; });
        label.htmlFor = useBuildingView.id;
        label.append(useBuildingView, node('span', '建物ビューを使用する'));
        editor.appendChild(label);
    }
    const actions = node('div', '', 'view-manager-form-actions'); editor.appendChild(actions);
    applyChanges = async () => {
        if (editor.reportValidity && !editor.reportValidity()) return false;
        const payload = { operation: `${row ? 'update' : 'create'}_${kind}`, name: name.value.trim(), sort_order: Number(order.value) };
        if (row) payload.id = Number(row.id);
        if (isFloor) {
            payload.building_id = Number(building.value);
            payload.representative_view_id = representative.value ? Number(representative.value) : null;
        } else {
            payload.building_view_enabled = useBuildingView.checked ? 1 : 0;
        }
        return mutate(payload);
    };
    editor.addEventListener('submit', event => {
        event.preventDefault();
        if (!resolving) void applyChanges();
    });
    if (row) button(actions, `${isFloor ? 'フロア' : '建物'}を削除`, () => {
        if (window.confirm('削除すると所属ビューは未分類になります。ビュー・機器・接続は削除されません。続行しますか？')) {
            void mutate({ operation: `delete_${kind}`, id: Number(row.id) });
        }
    }, true);
    const save = node('button', '適用', 'btn btn-primary btn-sm');
    save.type = 'submit'; save.title = '入力を適用し、自動保存します'; save.disabled = busy; actions.appendChild(save);
}

function renderAttachView(floor) {
    const state = attachState;
    const panel = node('div', '', 'hierarchy-attach-panel');
    panel.id = 'hierarchy-attach-panel';
    const toggle = button(editor, '既存ビューを追加・移動', () => {
        setExpanded(!state.expanded);
        if (state.expanded) search.focus();
    });
    toggle.id = 'hierarchy-attach-toggle';
    toggle.classList.add('hierarchy-attach-toggle');
    toggle.setAttribute('aria-controls', panel.id);
    editor.appendChild(panel);
    const search = field(panel, 'view-search', 'ビュー名・所属先で検索', state.query);
    search.required = false; search.type = 'search';
    search.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.isComposing) event.preventDefault();
    });
    const scope = node('label', '', 'hierarchy-checkbox');
    const includeAssigned = node('input');
    includeAssigned.type = 'checkbox';
    includeAssigned.id = 'hierarchy-attach-include-assigned';
    includeAssigned.checked = state.includeAssigned;
    scope.htmlFor = includeAssigned.id;
    scope.append(includeAssigned, node('span', '他フロアのビューも含める'));
    panel.appendChild(scope);
    const results = node('div', '', 'hierarchy-attach-results');
    panel.appendChild(results);
    const setExpanded = expanded => {
        state.expanded = expanded;
        panel.hidden = !expanded;
        toggle.setAttribute('aria-expanded', String(expanded));
        if (expanded) renderResults();
    };
    const renderResults = () => {
        results.replaceChildren();
        const query = state.query.trim().toLocaleLowerCase('ja');
        if (!query) return;
        const unclassified = [], assigned = [];
        for (const view of appState.views) {
            const moving = view.floor_id != null;
            if (moving && (!state.includeAssigned || Number(view.floor_id) === Number(floor.id))) continue;
            const path = viewHierarchyPath(view, appState) || '未分類';
            if (`${view.name} ${path}`.toLocaleLowerCase('ja').includes(query)) {
                (moving ? assigned : unclassified).push({ view, path });
            }
        }
        if (!unclassified.length && !assigned.length) {
            results.appendChild(node('p', '一致するビューがありません。', 'form-support'));
        }
        const target = viewHierarchyPath({ floor_id: floor.id }, appState);
        for (const { view, path } of unclassified.concat(assigned)) {
            const row = node('div', '', 'hierarchy-attach-row'); results.appendChild(row);
            const details = node('div', '', 'hierarchy-attach-details'); row.appendChild(details);
            const name = node('strong', view.name); name.id = `hierarchy-attach-name-${view.id}`; details.appendChild(name);
            const sourceFloorId = view.floor_id;
            const moving = sourceFloorId != null;
            details.appendChild(node('span', moving ? `${path} → ${target}` : path));
            const attach = button(row, moving ? '移動' : '紐付け', async () => {
                const generation = editorGeneration;
                if (busy || resolving || !admin()) return;
                if (!await resolveHierarchyEditor() || generation !== editorGeneration || busy || !admin()) return;
                const currentView = appState.views.find(item => Number(item.id) === Number(view.id));
                if (!currentView || currentView.floor_id !== sourceFloorId ||
                    !appState.floors.some(item => Number(item.id) === Number(floor.id))) return;
                if (hasResourceConflict('views', view.id) || !clean()) {
                    status.textContent = '未保存の変更または競合を解消してから所属を変更してください。'; return;
                }
                if (moving && !window.confirm(`「${currentView.name}」を「${viewHierarchyPath(currentView, appState)}」から` +
                    `「${viewHierarchyPath({ floor_id: floor.id }, appState)}」へ移動しますか？`)) return;
                busy = true; disableControls();
                try {
                    // 所属だけを変更し、配置・接続・ラック情報は通常のリソース保存へ渡す。
                    currentView.floor_id = Number(floor.id); markDirty();
                    if (!await flushSaveQueue({ silent: true })) {
                        status.textContent = '所属の保存に失敗しました。入力と変更を保持しています。'; return;
                    }
                    if (generation !== editorGeneration) return;
                    revision = Number(appState.dataRevision);
                    dirty = false; renderManager(); onSaved?.(selection);
                } finally { busy = false; disableControls(); }
                if (generation === editorGeneration && state.expanded) {
                    document.getElementById('hierarchy-view-search')?.focus();
                }
            });
            attach.id = `hierarchy-attach-action-${view.id}`;
            attach.setAttribute('aria-labelledby', `${attach.id} ${name.id}`);
        }
    };
    search.addEventListener('input', () => { state.query = search.value; renderResults(); });
    includeAssigned.addEventListener('change', () => { state.includeAssigned = includeAssigned.checked; renderResults(); });
    setExpanded(state.expanded);
}

async function accept(data, generation) {
    if (!await closePanel() || !await closeLinkPanel() || !clean()) {
        throw new Error('他の画面の入力を保存してから最新情報を取得してください。');
    }
    if (generation !== editorGeneration) throw new Error('編集対象が変わったため再取得してください。');
    appState.buildings = data.buildings;
    appState.floors = data.floors;
    appState.views = data.views.map(normalizeView);
    appState.devices = data.devices.map(normalizeDevice);
    appState.placements = data.placements.map(normalizePlacement);
    Object.assign(appState, connectionsFromData(data));
    appState.canvasNotes = data.canvas_notes.map(normalizeCanvasNote);
    appState.rackSettings = data.rack_settings.map(toSaveRackSettings);
    appState.rackMounts = data.rack_mounts.map(toSaveRackMount);
    appState.rackShelves = data.rack_shelves.map(toSaveRackShelf);
    appState.rackShelfDevices = data.rack_shelf_devices.map(toSaveRackShelfDevice);
    appState.floorRackPlacements = data.floor_rack_placements.map(toSaveFloorRackPlacement);
    appState.floorPlans = data.floor_plans.map(normalizeFloorPlan);
    appState.deviceImages = data.device_images;
    appState.linkSystems = data.link_systems;
    appState.addressSpaces = data.address_spaces;
    appState.ipSegments = data.ip_segments;
    appState.monitorRevision = Number(data.monitor_revision);
    if (!appState.views.some(view => Number(view.id) === Number(appState.currentViewId))) {
        appState.currentViewId = appState.views[0]?.id ?? null;
    }
    appState.selectedPlacementIds.clear();
    appState.selectedCanvasNoteId = null;
    appState.editingDeviceId = null;
    appState.editingLinkId = null;
    appState.editingLinkGroupKey = null;
    endLinkMode();
    appState.noteMode = false;
    recalculateNextIds();
    appState.dataRevision = revision = Number(data.revision);
    resetResourceBaseline(appState);
    markSaved(data.revision, data.saved_at);
    eventBus.emit('resources:reloaded', { source: 'hierarchy-editor' });
    eventBus.emit('hierarchy:changed');
}

function disableControls() {
    body?.querySelectorAll('button, input, select').forEach(element => {
        element.disabled = busy || (element.dataset.requiresBuilding === 'true' && !appState.buildings.length);
    });
}

async function mutate(payload) {
    if (busy || !admin()) return false;
    if (!clean()) { status.textContent = '他の画面に未保存の変更があります。先に適用・保存してください。入力は保持しています。'; return false; }
    const generation = editorGeneration;
    const target = selection;
    let saved = false;
    busy = true; disableControls();
    const previousIds = new Set((payload.operation.endsWith('_floor') ? appState.floors : appState.buildings).map(row => row.id));
    try {
        await runResourceMutation(async () => {
            if (!admin() || !clean()) throw new Error('権限または未保存の変更を確認してください。');
            const data = await apiFetch('building_hierarchy', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...payload, revision }) });
            // 通信中に他画面で編集された場合は、その入力を置き換えず再読込を促す。
            if (!clean()) throw new Error('建物・フロアは保存されました。他の入力を保存してから最新情報を取得してください。');
            if (generation !== editorGeneration) return;
            await accept(data, generation); dirty = false;
            if (payload.operation.startsWith('delete_')) selection = null;
            else if (!payload.id) {
                const rows = target.kind === 'floor' ? appState.floors : appState.buildings;
                const created = rows.find(row => !previousIds.has(row.id));
                if (created) selection = { kind: target.kind, id: created.id };
            }
            renderManager(); status.textContent = '保存しました。'; onSaved?.(selection);
            saved = true;
        });
    } catch (error) {
        if (generation === editorGeneration) status.textContent = error.status === 409
            ? '他の操作で更新されました。入力を控えてから「更新」で確認してください。' : error.message;
    } finally { busy = false; disableControls(); }
    return saved;
}

async function refresh() {
    const generation = editorGeneration;
    if (!await resolveHierarchyEditor() || generation !== editorGeneration || busy) return;
    if (!clean()) { status.textContent = '他の画面の変更を先に保存してください。'; return; }
    busy = true; disableControls();
    try {
        await runResourceMutation(async () => {
            if (!clean()) throw new Error('未保存の変更を先に保存してください。');
            const data = await apiFetch('building_hierarchy');
            if (!clean()) throw new Error('通信中に入力が変更されました。変更を保存してから再取得してください。');
            if (generation !== editorGeneration) return;
            await accept(data, generation); dirty = false; renderManager(); status.textContent = '最新情報を取得しました。'; onSaved?.(selection);
        });
    } catch (error) { status.textContent = error.message; }
    finally { busy = false; disableControls(); }
}


eventBus.on('floor-plan:saved', ({ viewId }) => {
    if (appState.floors.some(floor =>
        findEnabledBuilding(appState, floor.building_id) &&
        Number(floorViewSelection(floor, appState.views).view?.id) === Number(viewId))) {
        showToast('建物ビューで使う図面を変更しました。建物共通座標への位置合わせを再確認してください。', 'warning');
    }
});
