import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, beforeEach, test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { installWorkspaceDom } from './helpers/workspace-dom.mjs';
import { DEFAULT_DEVICE_WIDTH, DEFAULT_VIEW_SCALE } from '../public/js/core/constants.js';

const dom = installWorkspaceDom({ templates: ['templates/modals/link_bulk.php'] });
const { appState, normalizeDevice, normalizeView } = await import('../public/js/core/state.js');
const navigation = await import('../public/js/ui/workspace-navigation.js');
const bulk = await import('../public/js/modals/link-bulk-modal.js');
const { eventBus } = await import('../public/js/core/event-bus.js');
const resource = await import('../public/js/core/resource-save.js');
const queue = await import('../public/js/core/save-queue.js');
const panels = await import('../public/js/ui/property-panel.js');
const { initModalFocusTrap, getTopModalContainer } = await import('../public/js/core/modal-focus.js');
const { onKeyDown } = await import('../public/js/canvas/selection.js');

const entry = dom.add('button', 'palette-nav-btn');
const panel = dom.add('div', 'workspace-nav-panel');
panel.hidden = true;
dom.add('div', 'workspace-nav-content', panel);
const overlay = dom.get('link-bulk-overlay');
const linkPanel = dom.add('section', 'link-panel');
linkPanel.hidden = true;
for (const id of ['lp-label', 'lp-from-port', 'lp-to-port', 'lp-vlan', 'lp-memo']) dom.add('input', id, linkPanel);
dom.add('button', 'lp-system', linkPanel);
dom.get('lp-system').setAttribute('role', 'combobox');
dom.get('lp-system').setAttribute('aria-controls', 'lp-system-options');
dom.add('span', 'lp-system-name', dom.get('lp-system')).className = 'link-system-option-name';
dom.add('span', 'lp-system-swatch', dom.get('lp-system')).className = 'link-system-swatch';
dom.get('lp-system').getBoundingClientRect = () => ({ left: 900, top: 100, width: 280, height: 32, bottom: 132 });
window.confirm = () => true;
dom.add('div', 'lp-system-options', linkPanel);
const devicePanel = dom.add('section', 'panel');
devicePanel.hidden = true;
const canvas = dom.add('div', 'canvas');
const world = dom.add('div', 'world', canvas);
const svg = dom.add('svg', 'link-layer', world);
const deviceLayer = dom.add('div', 'device-layer', world);
const floorPlanLayer = dom.add('div', 'floor-plan-layer', world);
document.addEventListener('keydown', onKeyDown, true);
navigation.initWorkspaceNavigation();
bulk.initializeLinkBulkModal();
initModalFocusTrap();

let requests;
let responseStatus;
globalThis.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    requests.push(payload);
    if (responseStatus === 409) return new Response(JSON.stringify({ ok: false, error: '別の管理者が更新しました', details: {
        conflicts: [{ kind: 'views', id: 10, name: '対象ビュー' }]
    } }), { status: 409 });
    return new Response(JSON.stringify({ ok: true, revision: 2, saved_at: '2026-10-07T01:00:00Z',
        id_maps: { devices: {}, views: {}, links: {}, placements: {}, canvas_notes: {} },
        devices: [], views: payload.views.map(row => ({ ...row.view, resource_revision: row.expected_revision + 1 })),
        placements: payload.views.flatMap(row => row.placements || []),
        links: payload.views.flatMap(row => row.links || []), canvas_notes: [],
        deleted_device_ids: [], deleted_view_ids: [], affected_view_ids: payload.views.map(row => row.id)
    }));
};

beforeEach(async () => {
    queue.clearPendingSave();
    bulk.closeLinkBulkModal();
    await panels.closeLinkPanel();
    await panels.closePanel();
    navigation.closeWorkspaceNavigation();
    window.APP_CONFIG.user.isAdmin = true;
    appState.views = [normalizeView({ id: 10, resource_revision: 1, name: '対象ビュー' }), normalizeView({ id: 20, resource_revision: 1, name: '別ビュー' })];
    appState.devices = [normalizeDevice({ id: 1, resource_revision: 1, name: '元SW' }), normalizeDevice({ id: 2, resource_revision: 1, name: '先AP' }), normalizeDevice({ id: 3, resource_revision: 1, name: '予備SW' })];
    appState.linkSystems = [{ id: 5, name: '管理系統', color_key: 'teal', resource_revision: 1 }];
    appState.currentViewId = 10;
    appState.links = [
        { id: 1, view_id: 10, from_id: 1, to_id: 2, system_id: 5, label: 'UPLINK', vlan: '100', from_port: 'Gi1/1', to_port: 'eth0', memo: '元の備考', route_mode: 'manual', manual_route: [{ x: 10, y: 20 }] },
        { id: 2, view_id: 10, from_id: 2, to_id: 3, system_id: null, label: 'BACKUP', vlan: '200', from_port: 'Gi1/2', to_port: 'eth1', memo: '別の備考', route_mode: 'auto', manual_route: [] },
        { id: 3, view_id: 20, from_id: 1, to_id: 2, system_id: null, label: 'OTHER', vlan: '', from_port: '', to_port: '', memo: '', route_mode: 'auto', manual_route: [] }
    ];
    appState.placements = [
        { id: 11, view_id: 10, device_id: 1, x: 0, y: 0 },
        { id: 13, view_id: 10, device_id: 2, x: 150, y: 0 },
        { id: 14, view_id: 10, device_id: 3, x: 300, y: 0 },
        { id: 12, view_id: 20, device_id: 2, x: 0, y: 0 },
        { id: 15, view_id: 20, device_id: 1, x: 150, y: 0 }
    ];
    appState.selectedPlacementIds = new Set();
    appState.editingDeviceId = null; appState.editingLinkId = null;
    appState.canvasNotes = []; appState.floorPlans = []; appState.deviceImages = [];
    appState.currentSvg = svg; appState.deviceLayer = deviceLayer; appState.floorPlanLayer = floorPlanLayer;
    appState.world = world;
    appState.canvas = canvas;
    appState.authExpired = false; appState.isPinging = false; appState.isSaving = false;
    appState.viewState = { ...appState.viewState, scale: 0.5, panX: 0, panY: 0 };
    const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
    canvas.getBoundingClientRect = () => rect(50, 80, 1200, 800);
    panel.getBoundingClientRect = () => rect(50, 100, 300, 600);
    linkPanel.getBoundingClientRect = () => rect(950, 80, 300, 800);
    appState.resourceConflicts = { devices: new Map(), views: new Map() };
    appState.appStatus = { dirty: false, state: 'saved', lastSavedAt: null, lastError: null };
    resource.resetResourceBaseline(appState);
    eventBus.emit('resources:reloaded');
    requests = []; responseStatus = 200;
    navigation.openWorkspaceNavigation();
    await dom.get('workspace-nav-tab-devices').dispatch('click');
});
after(() => { queue.clearPendingSave(); });

const get = dom.get;
const rowButton = id => panel.querySelector(`[data-link-id="${id}"]`);
const checkbox = id => panel.querySelector(`[data-nav-focus="check-${id}"]`);
async function select(id, checked = true) { const input = checkbox(id); input.checked = checked; await input.dispatch('change'); }
async function linksTab() { await get('workspace-nav-tab-links').dispatch('click'); }
async function search(value) { const input = get('workspace-nav-search'); input.value = value; await input.dispatch('input'); }
async function setField(key, value) {
    const opt = get(`link-bulk-use-${key}`); opt.checked = true; await opt.dispatch('change');
    get(`link-bulk-${key}`).value = value;
}

test('タブはビュー内件数とARIAを持ち、矢印・Home・Endで切替とフォーカスを維持する', async () => {
    assert.equal(get('workspace-nav-tab-devices').textContent, '機器 (3台)');
    assert.equal(get('workspace-nav-tab-links').textContent, '接続 (2件)');
    assert.equal(get('workspace-nav-devices').hidden, false);
    assert.equal(get('workspace-nav-links').hidden, true);
    await get('workspace-nav-tab-devices').dispatch('keydown', { key: 'ArrowRight' });
    assert.equal(document.activeElement, get('workspace-nav-tab-links'));
    assert.equal(get('workspace-nav-tab-links').getAttribute('aria-selected'), 'true');
    assert.equal(get('workspace-nav-tab-devices').tabIndex, 0);
    assert.equal(get('workspace-nav-tab-links').tabIndex, 0);
    assert.equal(get('workspace-nav-links').getAttribute('aria-labelledby'), 'workspace-nav-tab-links');
    await get('workspace-nav-tab-links').dispatch('keydown', { key: 'Home' });
    assert.equal(document.activeElement, get('workspace-nav-tab-devices'));
    await get('workspace-nav-tab-devices').dispatch('keydown', { key: 'End' });
    eventBus.emit('canvas:render-complete');
    assert.equal(document.activeElement, get('workspace-nav-tab-links'));
    assert.equal(rowButton(3), null);
    assert.equal(rowButton(1).children[0].textContent, '元SW → 先AP');
    assert.match(rowButton(1).textContent, /管理系統.*UPLINK/);
    assert.match(rowButton(1).querySelector('.workspace-nav-system-swatch').style.backgroundColor, /link-system-teal/);
});

test('機器の既存個別操作はビュー内の機器を選択し、縮小し過ぎた倍率を戻す', async () => {
    appState.viewState.scale = 0.1;
    const button = panel.querySelector('[data-placement-id="11"]');
    await button.dispatch('click');
    assert.equal(appState.selectedPlacementIds.has(11), true);
    assert.equal(appState.viewState.scale, DEFAULT_VIEW_SCALE);
    assert.equal(panel.querySelector('[data-placement-id="12"]'), null);
});

test('狭幅では機器を選択すると一覧を閉じる', async () => {
    window.innerWidth = 800;
    try {
        await panel.querySelector('[data-placement-id="11"]').dispatch('click');
        assert.equal(panel.hidden, true);
        assert.equal(appState.selectedPlacementIds.has(11), true);
    } finally {
        window.innerWidth = 1200;
    }
});

test('checkbox操作は個別選択を変えず、row buttonは一括選択を変えない', async () => {
    await linksTab();
    checkbox(1).focus();
    await select(1);
    assert.equal(appState.editingLinkId, null);
    assert.deepEqual(navigation.getWorkspaceSelectedLinkIds(), [1]);
    assert.equal(document.activeElement, checkbox(1));
    await rowButton(2).dispatch('click');
    assert.equal(appState.editingLinkId, 2);
    assert.deepEqual(navigation.getWorkspaceSelectedLinkIds(), [1]);
});

test('画面外の接続だけを一覧から中央へ可視化し、倍率・保存データ・一括選択を維持する', async () => {
    await linksTab();
    await select(1);
    appState.placements[1].x = 4000; appState.placements[1].y = 2000;
    appState.placements[2].x = 4200; appState.placements[2].y = 2000;
    const before = structuredClone({ links: appState.links, placements: appState.placements });
    await rowButton(2).dispatch('click');
    assert.equal(appState.editingLinkId, 2);
    assert.deepEqual(navigation.getWorkspaceSelectedLinkIds(), [1]);
    assert.equal(appState.viewState.scale, 0.5);
    assert.equal(appState.viewState.panX, 600 - (4100 + DEFAULT_DEVICE_WIDTH / 2) * 0.5);
    assert.equal(appState.viewState.panY, 400 - 2043 * 0.5);
    assert.deepEqual({ links: appState.links, placements: appState.placements }, before);
    assert.equal(requests.length, 0);
    const view = structuredClone(appState.viewState);
    await rowButton(2).dispatch('click');
    assert.deepEqual(appState.viewState, view);
});

test('一部だけ見える長い接続は中点が画面外でも一覧クリックで移動しない', async () => {
    await linksTab();
    appState.placements[1].x = -1000; appState.placements[1].y = 400;
    appState.placements[2].x = 10000; appState.placements[2].y = 400;
    const before = structuredClone(appState.viewState);
    await rowButton(2).dispatch('click');
    assert.equal(appState.editingLinkId, 2);
    assert.deepEqual(appState.viewState, before);
});

test('左右パネルに隠れた接続は、接続情報を開いた後の可視領域へ移す', async () => {
    await linksTab();
    for (const [x, y] of [[100, 400], [2000, 400]]) {
        appState.placements[1].x = x; appState.placements[1].y = y;
        appState.placements[2].x = x + 100; appState.placements[2].y = y;
        appState.viewState.panX = 0; appState.viewState.panY = 0;
        await rowButton(2).dispatch('click');
        assert.equal(appState.viewState.panX, 600 - (x + 50 + DEFAULT_DEVICE_WIDTH / 2) * 0.5);
        assert.equal(appState.viewState.panY, 400 - 443 * 0.5);
    }
});

test('画面を迂回するmanual経路は外接矩形で見えていると誤認せず経路上へ移す', async () => {
    await linksTab();
    appState.placements[0].x = 400 - DEFAULT_DEVICE_WIDTH / 2; appState.placements[0].y = 357;
    appState.placements[1].x = 2000 - DEFAULT_DEVICE_WIDTH / 2; appState.placements[1].y = 357;
    appState.links[0].manual_route = [{ x: 400, y: -400 }, { x: 2000, y: -400 }];
    const routeBefore = structuredClone(appState.links[0].manual_route);
    await rowButton(1).dispatch('click');
    assert.equal(appState.viewState.panX, 0);
    assert.equal(appState.viewState.panY, 600);
    assert.deepEqual(appState.links[0].manual_route, routeBefore);
    const after = structuredClone(appState.viewState);
    await rowButton(1).dispatch('click');
    assert.deepEqual(appState.viewState, after);
});

test('画面外接続のcheckbox・全選択とCanvas上の選択ではパンしない', async () => {
    await linksTab();
    appState.viewState.panX = -10000;
    const before = structuredClone(appState.viewState);
    await select(1);
    const all = get('workspace-nav-select-all'); all.checked = true; await all.dispatch('change');
    assert.deepEqual(appState.viewState, before);
    assert.equal(appState.editingLinkId, null);
    const { onLinkClick } = await import('../public/js/canvas/renderer.js');
    await onLinkClick(appState.links[1]);
    assert.equal(appState.editingLinkId, 2);
    assert.deepEqual(appState.viewState, before);
    assert.deepEqual(navigation.getWorkspaceSelectedLinkIds(), [1, 2]);
});

test('接続切替の未適用入力をキャンセルすると、選択とパンを維持する', async () => {
    await linksTab();
    await rowButton(1).dispatch('click');
    get('lp-label').value = '未適用';
    appState.viewState.panX = -10000;
    const before = structuredClone(appState.viewState);
    const selecting = rowButton(2).dispatch('click');
    await setImmediate();
    await get('unsaved-changes-cancel').dispatch('click');
    await selecting;
    assert.equal(appState.editingLinkId, 1);
    assert.equal(get('lp-label').value, '未適用');
    assert.deepEqual(appState.viewState, before);
    panels.revertLinkPanelValues();
});

test('viewerも一覧から画面外の接続を可視化できるが編集・一括選択はできない', async () => {
    window.APP_CONFIG.user.isAdmin = false;
    navigation.renderWorkspaceNavigation();
    await linksTab();
    appState.viewState.panX = -10000;
    await rowButton(2).dispatch('click');
    assert.equal(appState.editingLinkId, 2);
    assert.notEqual(appState.viewState.panX, -10000);
    assert.equal(get('lp-label').readOnly, true);
    assert.equal(checkbox(2), null);
    assert.deepEqual(navigation.getWorkspaceSelectedLinkIds(), []);
});

test('斜め経路の外接矩形だけが重なる場合は移動し、境界に届く線分は移動しない', async () => {
    const { revealCanvasLinkRoute } = await import('../public/js/canvas/pan-zoom.js');
    // 可視左端はworld x=600。線分は画面外だが外接矩形だけは重なる。
    const route = [{ x: 500, y: 20 }, { x: 620, y: -200 }];
    const before = structuredClone(appState.viewState);
    revealCanvasLinkRoute(route);
    assert.notDeepEqual(appState.viewState, before);
    Object.assign(appState.viewState, { scale: 0.5, panX: 0, panY: 0 });
    revealCanvasLinkRoute([{ x: 400, y: 400 }, { x: 600, y: 400 }]);
    assert.equal(appState.viewState.panX, 0);
    assert.equal(appState.viewState.panY, 0);
    revealCanvasLinkRoute([{ x: 0, y: 600 }, { x: 2400, y: 600 }]);
    assert.equal(appState.viewState.panX, 0);
    assert.equal(appState.viewState.panY, 0);
});

test('端点配置が欠けて描画できない接続を選んでもパンしない', async () => {
    await linksTab();
    appState.placements = appState.placements.filter(row => row.device_id !== 3);
    const before = structuredClone(appState.viewState);
    await rowButton(2).dispatch('click');
    assert.equal(appState.editingLinkId, 2);
    assert.deepEqual(appState.viewState, before);
});

test('狭幅の接続行クリックは機器と同様に一覧を閉じ、チェック選択は保持する', async () => {
    await linksTab();
    await select(1);
    window.innerWidth = 800;
    try {
        appState.viewState.panX = -10000;
        await rowButton(2).dispatch('click');
        assert.equal(panel.hidden, true);
        assert.equal(appState.editingLinkId, 2);
        // 一覧を除いた可視範囲はcanvas x=0..900。機器中心間の中点を中央450へ移す。
        assert.equal(appState.viewState.panX, 450 - (225 + DEFAULT_DEVICE_WIDTH / 2) * 0.5);
        assert.deepEqual(navigation.getWorkspaceSelectedLinkIds(), [1]);
    } finally {
        window.innerWidth = 1200;
    }
});

test('系統の候補と選択欄は同じ色を示し、選択は下書きとして適用まで保存しない', async () => {
    appState.linkSystems.push({ id: 6, name: '合成業務系統', color_key: 'brown', resource_revision: 1 });
    panels.openLinkPanel(appState.links[0]);
    const control = get('lp-system');
    await control.dispatch('click');
    const list = get('lp-system-options');
    const option = [...list.children].find(option => option.value === '6');
    assert.match(option.querySelector('.link-system-swatch').style.backgroundColor, /link-system-brown/);
    await option.dispatch('click');
    assert.equal(control.value, '6');
    assert.equal(get('lp-system-swatch').style.backgroundColor, option.querySelector('.link-system-swatch').style.backgroundColor);
    assert.equal(appState.links[0].system_id, 5);
    assert.equal(panels.hasUnappliedLinkPanelChanges(), true);
    assert.equal(requests.length, 0);
    assert.equal(panels.applyLinkPanel({ showMessage: false }), true);
    await queue.flushSaveQueue({ silent: true });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].views[0].links[0].system_id, 6);
    assert.equal(list.hidden, true);
});

test('系統候補のキー移動は値を確定せず、Escape・Tab・外側クリックで閉じ、Enterで未設定を選べる', async () => {
    panels.openLinkPanel(appState.links[0]);
    const control = get('lp-system');
    control.focus();
    await control.dispatch('keydown', { key: 'ArrowDown' });
    await control.dispatch('keydown', { key: 'Home' });
    assert.equal(control.value, '5');
    await control.dispatch('keydown', { key: 'Escape' });
    assert.equal(get('lp-system-options').hidden, true);
    assert.equal(control.value, '5');
    await control.dispatch('click');
    await control.dispatch('keydown', { key: 'Tab' });
    assert.equal(get('lp-system-options').hidden, true);
    await control.dispatch('click');
    await dom.events.dispatch('pointerdown', { target: document.body });
    assert.equal(get('lp-system-options').hidden, true);
    await control.dispatch('keydown', { key: 'ArrowUp' });
    await control.dispatch('keydown', { key: 'Home' });
    await control.dispatch('keydown', { key: 'Enter' });
    assert.equal(control.value, '');
    assert.equal(appState.links[0].system_id, 5);
    assert.equal(panels.hasUnappliedLinkPanelChanges(), true);
    panels.revertLinkPanelValues();
});

test('系統の未適用候補が削除されても解除せず、viewerと認証失効時の候補操作を拒否する', async () => {
    panels.openLinkPanel(appState.links[0]);
    const control = get('lp-system');
    await control.dispatch('click');
    const option = [...get('lp-system-options').children].find(option => option.value === '');
    appState.authExpired = true;
    await option.dispatch('click');
    assert.equal(control.value, '5');
    appState.authExpired = false;
    appState.linkSystems = [];
    eventBus.emit('link-systems:changed');
    assert.equal(control.value, '5');
    assert.equal(panels.applyLinkPanel({ showMessage: false }), false);
    assert.equal(appState.links[0].system_id, 5);
    window.APP_CONFIG.user.isAdmin = false;
    panels.setLinkPanelReadOnly(true);
    await control.dispatch('click');
    assert.equal(get('lp-system-options').hidden, true);
    await option.dispatch('click');
    assert.equal(control.value, '5');
    assert.equal(requests.length, 0);
});

test('系統選択欄にフォーカス中のDeleteとBackspaceは接続を削除しない', async () => {
    panels.openLinkPanel(appState.links[0]);
    const control = get('lp-system');
    control.focus();
    const before = structuredClone(appState.links);
    const { onKeyDown } = await import('../public/js/canvas/selection.js');
    for (const key of ['Delete', 'Backspace']) {
        await onKeyDown({ key, target: control, preventDefault() {}, stopPropagation() {} });
    }
    assert.deepEqual(appState.links, before);
    assert.equal(appState.editingLinkId, 1);
    assert.equal(requests.length, 0);
});

test('系統名と未設定も検索でき、表示中だけを全選択して表示外の選択を保持する', async () => {
    await linksTab();
    await select(1); await select(2);
    const input = get('workspace-nav-search'); input.focus();
    await search('uplink');
    assert.equal(document.activeElement, input);
    assert.equal(rowButton(2), null);
    assert.match(get('workspace-nav-selection-status').textContent, /選択 2件（表示外 1件）/);
    const all = get('workspace-nav-select-all'); all.checked = false; await all.dispatch('change');
    assert.deepEqual(navigation.getWorkspaceSelectedLinkIds(), [2]);
    assert.match(get('workspace-nav-selection-status').textContent, /選択 1件（表示外 1件）/);
    await search('未設定');
    assert.equal(rowButton(1), null); assert.ok(rowButton(2));
    await search('管理系統');
    assert.ok(rowButton(1)); assert.equal(rowButton(2), null);
    get('workspace-nav-select-all').checked = true; await get('workspace-nav-select-all').dispatch('change');
    assert.deepEqual(new Set(navigation.getWorkspaceSelectedLinkIds()), new Set([1, 2]));
});

test('ID再採番に一括選択とフォーカスが追従し、削除・ビュー変更・全体/対象再読込で整合する', async () => {
    await linksTab(); await select(1); checkbox(1).focus();
    const maps = { views: { 10: 110 }, links: { 1: 101 }, devices: {}, placements: {}, canvas_notes: {} };
    resource.remapResourceState(appState, maps);
    eventBus.emit('resources:ids-remapped', maps);
    assert.deepEqual(navigation.getWorkspaceSelectedLinkIds(), [101]);
    assert.equal(document.activeElement, checkbox(101));
    appState.links = appState.links.filter(link => link.id !== 101);
    eventBus.emit('canvas:render-complete');
    assert.deepEqual(navigation.getWorkspaceSelectedLinkIds(), []);
    await select(2);
    appState.currentViewId = 20; eventBus.emit('canvas:render-complete');
    assert.deepEqual(navigation.getWorkspaceSelectedLinkIds(), []);
    assert.equal(get('workspace-nav-search').value, '');
    assert.equal(get('workspace-nav-tab-links').textContent, '接続 (1件)');
    await select(3); eventBus.emit('resource:reloaded', { kind: 'views', id: 20 });
    assert.deepEqual(navigation.getWorkspaceSelectedLinkIds(), []);
    await select(3); eventBus.emit('resources:reloaded');
    assert.deepEqual(navigation.getWorkspaceSelectedLinkIds(), []);
});

test('viewerは検索と行選択ができるがcheckbox・一括設定は表示も適用もできない', async () => {
    window.APP_CONFIG.user.isAdmin = false;
    navigation.renderWorkspaceNavigation(); await linksTab();
    assert.equal(checkbox(1), null);
    assert.equal(get('workspace-nav-bulk').hidden, true);
    await search('管理系統');
    assert.ok(rowButton(1)); assert.equal(rowButton(2), null);
    await rowButton(1).dispatch('click');
    assert.equal(appState.editingLinkId, 1);
    assert.equal(await bulk.openLinkBulkModal([1]), false);
    assert.equal(overlay.hidden, true);
    assert.deepEqual(requests, []);
});

test('opt-outはdisabledで不変、opt-in空欄はclearし、端点・ポート・経路を保持して1回だけ保存する', async () => {
    await linksTab(); await select(1); await select(2);
    const before = structuredClone(appState.links);
    const openButton = get('workspace-nav-bulk-open'); openButton.focus();
    assert.equal(await bulk.openLinkBulkModal(navigation.getWorkspaceSelectedLinkIds(), { getSelectedIds: navigation.getWorkspaceSelectedLinkIds }), true);
    for (const key of ['system_id', 'label', 'vlan', 'memo']) {
        assert.equal(get(`link-bulk-use-${key}`).checked, false);
        assert.equal(get(`link-bulk-${key}`).disabled, true);
    }
    get('link-bulk-memo').value = 'opt-outの入力は無視';
    await setField('system_id', ''); await setField('vlan', ''); await setField('label', '共通ラベル');
    assert.equal(get('link-bulk-vlan').disabled, false);
    assert.equal(bulk.previewLinkBulkModal(), true);
    assert.deepEqual(appState.links, before, '確認画面ではまだ変更・保存しない');
    assert.deepEqual(requests, []);
    assert.equal(await bulk.applyLinkBulkModal(), true);
    await queue.flushSaveQueue({ silent: true });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].views.length, 1);
    assert.equal(requests[0].views[0].id, 10);
    assert.equal(requests[0].views[0].expected_revision, 1);
    assert.deepEqual(requests[0].devices, []);
    for (let index = 0; index < 2; index++) {
        assert.deepEqual(requests[0].views[0].links[index], { ...resource.viewResource({ links: before, placements: [], canvasNotes: [] }, appState.views[0]).links[index], system_id: null, vlan: '', label: '共通ラベル' });
        assert.equal(appState.links.find(link => link.id === before[index].id).memo, before[index].memo);
    }
    assert.deepEqual(appState.links.find(link => link.id === before[2].id), before[2]);
    assert.equal(overlay.hidden, true);
    assert.equal(document.activeElement?.id, 'workspace-nav-bulk-open');
    assert.equal(get('toast')?.hidden ?? true, true);
});

test('適用前の権限・選択・ビュー・競合変更は部分適用せず、reloadもsessionを無効化する', async () => {
    await linksTab(); await select(1);
    const open = () => bulk.openLinkBulkModal(navigation.getWorkspaceSelectedLinkIds(), { getSelectedIds: navigation.getWorkspaceSelectedLinkIds });
    await open(); await setField('memo', '変更');
    assert.equal(bulk.previewLinkBulkModal(), true);
    window.APP_CONFIG.user.isAdmin = false;
    assert.equal(await bulk.applyLinkBulkModal(), false); assert.equal(appState.links[0].memo, '元の備考');
    bulk.closeLinkBulkModal(); window.APP_CONFIG.user.isAdmin = true;
    await select(1); await open(); await setField('memo', '変更');
    assert.equal(bulk.previewLinkBulkModal(), true);
    appState.resourceConflicts.views.set(10, {});
    assert.equal(await bulk.applyLinkBulkModal(), false); assert.match(get('link-bulk-error').textContent, /競合/);
    bulk.closeLinkBulkModal(); appState.resourceConflicts.views.clear();
    await open(); await setField('memo', '変更');
    assert.equal(bulk.previewLinkBulkModal(), true);
    await select(2);
    assert.equal(await bulk.applyLinkBulkModal(), false); assert.match(get('link-bulk-error').textContent, /選択/);
    bulk.closeLinkBulkModal();
    await open(); await setField('memo', '変更');
    assert.equal(bulk.previewLinkBulkModal(), true);
    appState.currentViewId = 20;
    assert.equal(await bulk.applyLinkBulkModal(), false);
    bulk.closeLinkBulkModal(); appState.currentViewId = 10; navigation.renderWorkspaceNavigation();
    await select(1); await open(); await setField('memo', '変更');
    assert.equal(bulk.previewLinkBulkModal(), true);
    eventBus.emit('resources:reloaded');
    assert.equal(await bulk.applyLinkBulkModal(), false); assert.match(get('link-bulk-error').textContent, /再読み込み/);
    assert.deepEqual(requests, []); assert.equal(appState.links[0].memo, '元の備考');
});

test('409は既存保存キューで編集を保持し、追加の一括適用は競合解決まで拒否する', async () => {
    await linksTab(); await select(1); await select(2);
    responseStatus = 409;
    await bulk.openLinkBulkModal(navigation.getWorkspaceSelectedLinkIds(), { getSelectedIds: navigation.getWorkspaceSelectedLinkIds });
    await setField('memo', '競合時も保持');
    assert.equal(bulk.previewLinkBulkModal(), true);
    assert.equal(await bulk.applyLinkBulkModal(), true);
    await queue.flushSaveQueue({ silent: true }); await setImmediate();
    assert.equal(requests.length, 1);
    assert.equal(appState.links[0].memo, '競合時も保持'); assert.equal(appState.links[1].memo, '競合時も保持');
    assert.equal(appState.resourceConflicts.views.has(10), true);
    assert.equal(appState.appStatus.state, 'conflict');
    assert.equal(await bulk.openLinkBulkModal(navigation.getWorkspaceSelectedLinkIds(), { getSelectedIds: navigation.getWorkspaceSelectedLinkIds }), false);
    assert.equal(requests.length, 1);
});

test('既存の未適用draft確認で取消すると入力を保持し、一括設定を開かない', async () => {
    await linksTab(); await select(1);
    await panels.openLinkPanel(appState.links[0]);
    get('lp-label').value = '未適用ラベル';
    const opening = bulk.openLinkBulkModal(navigation.getWorkspaceSelectedLinkIds(), { getSelectedIds: navigation.getWorkspaceSelectedLinkIds });
    await setImmediate();
    assert.ok(get('unsaved-changes-overlay'));
    await get('unsaved-changes-cancel').dispatch('click');
    assert.equal(await opening, false);
    assert.equal(get('lp-label').value, '未適用ラベル');
    assert.equal(appState.links[0].label, 'UPLINK');
    assert.equal(overlay.hidden, true);
    // 次のfixtureへ持ち越さず、実際の破棄確認を通して閉じる。
    const closing = panels.closeLinkPanel(); await setImmediate();
    await get('unsaved-changes-discard').dispatch('click'); await closing;
});

test('共通focus trapとEscapeを再利用し、背後の一覧を閉じず起動ボタンへ戻す', async () => {
    await linksTab(); await select(1);
    const button = get('workspace-nav-bulk-open'); button.focus();
    await bulk.openLinkBulkModal(navigation.getWorkspaceSelectedLinkIds(), { getSelectedIds: navigation.getWorkspaceSelectedLinkIds });
    assert.equal(getTopModalContainer(), overlay);
    const first = overlay.querySelector('.modal-close-btn');
    const last = get('link-bulk-next'); last.focus();
    let prevented = false;
    await dom.events.dispatch('keydown', { key: 'Tab', preventDefault() { prevented = true; } });
    assert.equal(prevented, true); assert.equal(document.activeElement, first);
    await dom.events.dispatch('keydown', { key: 'Escape' });
    assert.equal(overlay.hidden, true); assert.equal(panel.hidden, false);
    assert.equal(document.activeElement?.id, 'workspace-nav-bulk-open');
    assert.equal(getTopModalContainer(), null);
});

test('削除された系統のopt-inを未設定へ置換せず、opt-outに戻せば他項目だけを適用できる', async () => {
    await linksTab(); await select(2);
    appState.linkSystems.push({ id: 6, name: '未使用系統', color_key: 'slate' });
    eventBus.emit('link-systems:changed');
    await bulk.openLinkBulkModal(navigation.getWorkspaceSelectedLinkIds(), { getSelectedIds: navigation.getWorkspaceSelectedLinkIds });
    await setField('system_id', '6'); await setField('memo', '');
    appState.linkSystems = appState.linkSystems.filter(system => system.id !== 6);
    eventBus.emit('link-systems:changed');
    assert.equal(get('link-bulk-system_id').value, '6');
    assert.equal(bulk.previewLinkBulkModal(), false);
    assert.equal(await bulk.applyLinkBulkModal(), false);
    assert.equal(appState.links[1].memo, '別の備考');
    const opt = get('link-bulk-use-system_id'); opt.checked = false; await opt.dispatch('change');
    assert.equal(get('link-bulk-system_id').disabled, true);
    assert.equal(bulk.previewLinkBulkModal(), true);
    assert.equal(await bulk.applyLinkBulkModal(), true);
    await queue.flushSaveQueue({ silent: true });
    const saved = appState.links.find(link => link.id === 2);
    assert.equal(saved.system_id, null);
    assert.equal(saved.memo, '');
    assert.equal(requests.length, 1);
});

test('モーダルを開いたままのID再採番にも対象・選択が追従して新しいIDへ1回保存する', async () => {
    await linksTab(); await select(1);
    await bulk.openLinkBulkModal(navigation.getWorkspaceSelectedLinkIds(), { getSelectedIds: navigation.getWorkspaceSelectedLinkIds });
    await setField('label', '再採番後');
    assert.equal(bulk.previewLinkBulkModal(), true);
    const maps = { views: {}, devices: {}, links: { 1: 101 }, placements: {}, canvas_notes: {} };
    resource.remapResourceState(appState, maps);
    resource.resetResourceBaseline(appState);
    eventBus.emit('resources:ids-remapped', maps);
    assert.deepEqual(navigation.getWorkspaceSelectedLinkIds(), [101]);
    assert.equal(await bulk.applyLinkBulkModal(), true);
    await queue.flushSaveQueue({ silent: true });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].views[0].links.find(link => link.id === 101).label, '再採番後');
    assert.equal(appState.links.find(link => link.id === 101).label, '再採番後');
});

test('確認前は適用できず、確認から戻ると入力を保持して修正後の値だけを適用する', async () => {
    await linksTab(); await select(1);
    const original = structuredClone(appState.links);
    await bulk.openLinkBulkModal(navigation.getWorkspaceSelectedLinkIds(), { getSelectedIds: navigation.getWorkspaceSelectedLinkIds });
    await setField('memo', '確認用の下書き');
    assert.equal(await bulk.applyLinkBulkModal(), false);
    assert.deepEqual(appState.links, original);
    assert.deepEqual(requests, []);
    await get('link-bulk-next').dispatch('click');
    assert.equal(get('link-bulk-form').hidden, true);
    assert.equal(get('link-bulk-confirm').hidden, false);
    assert.equal(document.activeElement, get('link-bulk-apply'));
    assert.ok(get('link-bulk-preview').textContent.includes('確認用の下書き'));
    assert.deepEqual(appState.links, original);
    await get('link-bulk-back').dispatch('click');
    assert.equal(get('link-bulk-form').hidden, false);
    assert.equal(get('link-bulk-confirm').hidden, true);
    assert.equal(get('link-bulk-use-memo').checked, true);
    assert.equal(get('link-bulk-memo').value, '確認用の下書き');
    assert.equal(document.activeElement, get('link-bulk-next'));
    assert.equal(await bulk.applyLinkBulkModal(), false, '戻る操作で古い確認値を無効にする');
    await setField('memo', '修正して確定する備考');
    await get('link-bulk-next').dispatch('click');
    window.confirm = () => false;
    await dom.events.dispatch('keydown', { key: 'Escape' });
    assert.equal(overlay.hidden, false);
    assert.equal(get('link-bulk-confirm').hidden, false);
    assert.deepEqual(appState.links, original);
    await get('link-bulk-apply').dispatch('click');
    await queue.flushSaveQueue({ silent: true });
    assert.equal(appState.links.find(link => link.id === 1).memo, '修正して確定する備考');
    assert.equal(appState.links.find(link => link.id === 2).memo, original.find(link => link.id === 2).memo);
    assert.equal(overlay.hidden, true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].views.find(view => view.id === 10).links.find(link => link.id === 1).memo, '修正して確定する備考');
});

test('スタイル定義: 接続タブの検索BOXが一回り小さい32pxサイズで定義され、左右余白が確保されている', () => {
    const css = fs.readFileSync(new URL('../public/css/components/tool_palette.css', import.meta.url), 'utf8');
    assert.match(css, /#workspace-nav-search\s*\{[^}]*height:\s*32px;/);
    assert.match(css, /#workspace-nav-search\s*\{[^}]*min-height:\s*32px;/);
    assert.match(css, /\.workspace-nav-tools\s*\{[^}]*padding:\s*0 4px;/);
});
