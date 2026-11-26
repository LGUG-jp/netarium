import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { installWorkspaceDom } from './helpers/workspace-dom.mjs';
import { DEFAULT_DEVICE_WIDTH, DEFAULT_VIEW_SCALE } from '../public/js/core/constants.js';

const dom = installWorkspaceDom({ templates: ['templates/components/tool_palette.php', 'templates/modals/link_bulk.php'] });
const { appState, normalizeDevice, normalizeView, normalizeLink } = await import('../public/js/core/state.js');
const navigation = await import('../public/js/ui/workspace-navigation.js');
const bulk = await import('../public/js/modals/link-bulk-modal.js');
const { eventBus } = await import('../public/js/core/event-bus.js');
const resource = await import('../public/js/core/resource-save.js');
const queue = await import('../public/js/core/save-queue.js');
const panels = await import('../public/js/ui/property-panel.js');
const { excludeLegacyLink, resolveViewLegacyConflicts } = await import('../public/js/core/legacy-link-review.js');
const { resolveWorkspaceLinks } = await import('../public/js/core/link-bulk-data.js');
const { initModalFocusTrap, getTopModalContainer } = await import('../public/js/core/modal-focus.js');
const { onKeyDown } = await import('../public/js/canvas/selection.js');
const toolbar = await import('../public/js/ui/toolbar.js');
const drafts = await import('../public/js/core/device-drafts.js');

const entry = dom.get('palette-nav-btn');
const badge = dom.get('palette-nav-legacy-badge');
const panel = dom.get('workspace-nav-panel');
const overlay = dom.get('link-bulk-overlay');
const linkPanel = dom.add('section', 'link-panel');
linkPanel.hidden = true;
for (const id of ['lp-label', 'lp-from-port', 'lp-to-port', 'lp-memo']) dom.add('input', id, linkPanel);
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
let pingRequests;
let responseStatus;
let legacyResponse;
let legacyLoadResponse;
let legacyRequestHeaders;
globalThis.fetch = async (url, options) => {
    if (url.includes('action=load')) {
        return new Response(JSON.stringify(legacyLoadResponse()));
    }
    const payload = JSON.parse(options.body);
    if (url.includes('action=ping')) {
        pingRequests.push(payload);
        return new Response(JSON.stringify({ ok: true, monitor_revision: 7,
            results: payload.targets.map(target => ({ id: target.id, status: 'green',
                response_ms: 2, checked_at: '2026-10-25T01:00:00Z' })) }));
    }
    requests.push(payload);
    if (url.includes('action=resolve_legacy_link_conflict')) {
        legacyRequestHeaders = options.headers;
        if (responseStatus === 409) return new Response(JSON.stringify({ ok: false, error: '再読み込みしてください' }), { status: 409 });
        return new Response(JSON.stringify(await legacyResponse(payload)));
    }
    if (url.includes('action=complete_legacy_link_vlan')) {
        return Response.json({ ok: true, link_id: payload.link_id, revision: payload.expected_revision + 1 });
    }
    if (url.includes('action=save_connections')) {
        if (responseStatus === 409) return new Response(JSON.stringify({ ok: false, error: '別の管理者が更新しました', details: {
            conflicts: [{ resource: 'links', id: payload.links[0].id, expected_revision: 1, actual_revision: 3 }]
        } }), { status: 409 });
        const ids = Object.fromEntries(payload.links.filter(row => row.operation === 'create').map(row => [row.id, row.id + 100]));
        return new Response(JSON.stringify({ ok: true, revision: appState.dataRevision + 1, saved_at: '2026-10-07T01:00:00Z',
            id_maps: { links: ids }, device_ports: [], views: [], removed_view_link_routes: [], deleted_device_port_ids: [], deleted_link_ids: [],
            links: payload.links.map(({ id, link, expected_revision = 0 }) => ({
                ...link, id: ids[id] ?? id, resource_revision: expected_revision + 1
            }))
        }));
    }
    return new Response(JSON.stringify({ ok: true, revision: 2, saved_at: '2026-10-07T01:00:00Z',
        id_maps: { devices: {}, views: {}, placements: {}, canvas_notes: {} },
        devices: [], views: payload.views.map(row => ({ ...row.view, resource_revision: row.expected_revision + 1 })),
        placements: payload.views.flatMap(row => row.placements || []),
        view_link_routes: payload.views.flatMap(row => row.view_link_routes || []), canvas_notes: [],
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
    window.confirm = () => true;
    appState.views = [normalizeView({ id: 10, resource_revision: 1, name: '対象ビュー' }), normalizeView({ id: 20, resource_revision: 1, name: '別ビュー' })];
    appState.devices = [
        normalizeDevice({ id: 1, resource_revision: 1, name: '元SW' }), normalizeDevice({ id: 2, resource_revision: 1, name: '先AP' }),
        normalizeDevice({ id: 3, resource_revision: 1, name: '予備SW' }), normalizeDevice({ id: 4, resource_revision: 1, name: '別ビュー機器' }),
        normalizeDevice({ id: 5, resource_revision: 1, name: '未配置機器' })
    ];
    appState.linkSystems = [{ id: 5, name: '管理系統', color_key: 'teal', resource_revision: 1 }];
    appState.currentViewId = 10;
    appState.dataRevision = 1;
    appState.legacyLinkConflicts = [];
    appState.legacyLinkVlans = [];
    appState.links = [
        { id: 1, from_id: 1, to_id: 2, system_id: 5, label: 'UPLINK', from_port_id: 21, to_port_id: 22, memo: '元の備考' },
        { id: 2, from_id: 2, to_id: 3, system_id: null, label: 'BACKUP', from_port_id: 23, to_port_id: 24, memo: '別の備考' },
        { id: 3, from_id: 4, to_id: 5, system_id: null, label: 'OTHER' }
    ].map(link => normalizeLink({ ...link, resource_revision: 1 }));
    appState.devicePorts = [
        { id: 21, device_id: 1, name: 'Gi1/1', vlan: 'access 100' }, { id: 22, device_id: 2, name: 'eth0', vlan: 'native 110' },
        { id: 23, device_id: 2, name: 'Gi1/2', vlan: 'access 200' }, { id: 24, device_id: 3, name: 'eth1', vlan: '' }
    ];
    appState.viewLinkRoutes = [{ view_id: 10, device_a_id: 1, device_b_id: 2, manual_route: [{ x: 10, y: 20 }] }];
    appState.placements = [
        { id: 11, view_id: 10, device_id: 1, x: 0, y: 0 },
        { id: 13, view_id: 10, device_id: 2, x: 150, y: 0 },
        { id: 14, view_id: 10, device_id: 3, x: 300, y: 0 },
        { id: 12, view_id: 20, device_id: 2, x: 0, y: 0 },
        { id: 15, view_id: 20, device_id: 4, x: 150, y: 0 }
    ];
    appState.selectedPlacementIds = new Set();
    appState.editingDeviceId = null; appState.editingLinkId = null; appState.editingLinkGroupKey = null;
    appState.canvasNotes = []; appState.floorPlans = []; appState.deviceImages = [];
    appState.rackMounts = []; appState.rackShelves = []; appState.rackShelfDevices = []; appState.rackSettings = [];
    appState.currentSvg = svg; appState.deviceLayer = deviceLayer; appState.floorPlanLayer = floorPlanLayer;
    appState.world = world;
    appState.canvas = canvas;
    appState.authExpired = false; appState.isPinging = false; appState.isSaving = false;
    appState.viewState = { ...appState.viewState, scale: 0.5, panX: 0, panY: 0 };
    const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
    canvas.getBoundingClientRect = () => rect(50, 80, 1200, 800);
    panel.getBoundingClientRect = () => rect(50, 100, 300, 600);
    linkPanel.getBoundingClientRect = () => rect(950, 80, 300, 800);
    appState.resourceConflicts = { devices: new Map(), views: new Map(), links: new Map(), device_ports: new Map() };
    appState.appStatus = { dirty: false, state: 'saved', lastSavedAt: null, lastError: null };
    resource.resetResourceBaseline(appState);
    eventBus.emit('resources:reloaded');
    requests = []; pingRequests = []; responseStatus = 200;
    legacyRequestHeaders = null;
    legacyLoadResponse = () => ({
        ok: true, revision: appState.dataRevision, views: appState.views, legacy_link_conflicts: appState.legacyLinkConflicts
    });
    legacyResponse = ({ legacy_link_id, expected_revision }) => ({
        ok: true, legacy_link_id, revision: expected_revision + 1, saved_at: '2026-10-07T01:00:00Z',
        views: [], removed_view_link_routes: []
    });
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

test('ラック一覧は現在ラックの搭載機器を重複なく表示し、XY配置を作らず実選択経路で開く', async () => {
    appState.views[0].view_type = 'rack';
    appState.rackMounts = [
        { view_id: 10, device_id: 2 }, { view_id: '10', device_id: '2' },
        { view_id: 20, device_id: 1 }, { view_id: 10, device_id: 999 }
    ];
    appState.devices[1].ip = '192.0.2.2';
    appState.selectedPlacementIds.add(11);
    appState.editingDeviceId = 1;
    navigation.renderWorkspaceNavigation();
    assert.equal(get('workspace-nav-tab-devices').textContent, '機器 (1台)');
    assert.equal(panel.querySelectorAll('[data-rack-device-id]').length, 1);
    assert.equal(panel.querySelector('[data-placement-id]'), null);
    const button = panel.querySelector('[data-rack-device-id="2"]');
    assert.match(button.textContent, /先AP.*192\.0\.2\.2/);
    assert.match(button.getAttribute('aria-label'), /先AP/);
    assert.equal(button.classList.contains('is-selected'), false);
    const placements = structuredClone(appState.placements);
    await button.dispatch('click');
    assert.equal(appState.editingDeviceId, 2);
    assert.equal(panel.querySelector('[data-rack-device-id="2"]').classList.contains('is-selected'), true);
    assert.deepEqual(appState.placements, placements);
    assert.deepEqual(requests, []);
    appState.editingDeviceId = 1;
    eventBus.emit('device-panel:opened', appState.devices[0]);
    assert.equal(panel.querySelector('.is-selected'), null);
    appState.editingDeviceId = 2;
});

test('ラックPingは現在ラックで選択された実機器だけを共通API・監視更新経路へ渡す', async () => {
    appState.views[0].view_type = 'rack';
    appState.rackMounts = [
        { view_id: 10, device_id: 2 }, { view_id: '10', device_id: '2' },
        { view_id: 20, device_id: 1 }
    ];
    appState.devices[0].ip = '192.0.2.1';
    appState.devices[1].ip = ' 192.0.2.2 ';
    appState.devices[1].type = 'pc';
    appState.selectedPlacementIds.add(11);
    appState.editingDeviceId = 2;
    appState.dataRevision = 42;
    resource.resetResourceBaseline(appState);
    await toolbar.pingSelected();
    assert.deepEqual(pingRequests, [{ revision: 42, targets: [{ id: 2, ip: '192.0.2.2' }] }]);
    assert.equal(appState.devices[1].status, 'green');
    assert.equal(appState.monitorRevision, 7);
    assert.equal(appState.isPinging, false);
    assert.deepEqual(requests, []);
    for (const id of [1, 3, 999, null]) {
        appState.editingDeviceId = id;
        await toolbar.pingSelected();
    }
    appState.editingDeviceId = 2;
    appState.devices[1].ip = ' ';
    await toolbar.pingSelected();
    assert.equal(pingRequests.length, 1, '別ラック・未搭載・削除済み・未選択・IPなしは対象にしない');
});

test('ラックPingも既存の管理者・認証・保存待ち・実行中・未適用入力の制限を保持する', async () => {
    appState.views[0].view_type = 'rack';
    appState.rackMounts = [{ view_id: 10, device_id: 2 }];
    appState.editingDeviceId = 2;
    appState.devices[1].ip = '192.0.2.2';
    resource.resetResourceBaseline(appState);
    window.APP_CONFIG.user.isAdmin = false;
    await toolbar.pingSelected();
    window.APP_CONFIG.user.isAdmin = true;
    appState.authExpired = true;
    await toolbar.pingSelected();
    appState.authExpired = false;
    appState.appStatus.dirty = true;
    await toolbar.pingSelected();
    appState.appStatus.dirty = false;
    appState.isPinging = true;
    await toolbar.pingSelected();
    appState.isPinging = false;
    drafts.getDeviceDraft('rack-ping-test', 2).name = '未適用の機器名';
    try {
        await toolbar.pingSelected();
    } finally {
        drafts.discardDeviceDrafts('rack-ping-test');
    }
    assert.deepEqual(pingRequests, []);
});

test('通常ビューのPingはXY選択を使い、配置重複を除外して現在ビューの対象だけを送信する', async () => {
    appState.devices[0].ip = '192.0.2.1';
    appState.devices[1].ip = '192.0.2.2';
    appState.placements.push({ id: 16, view_id: 10, device_id: 1, x: 100, y: 100 });
    appState.selectedPlacementIds = new Set([11, 16, 12, 999]);
    appState.editingDeviceId = 2;
    appState.rackMounts = [{ view_id: 10, device_id: 2 }];
    resource.resetResourceBaseline(appState);
    await toolbar.pingSelected();
    assert.deepEqual(pingRequests[0].targets, [{ id: 1, ip: '192.0.2.1' }]);
    assert.deepEqual(requests, []);
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

test('一覧の異なる明細を選ぶと同じ集約線を表示し、×Nのクリックで明細一覧に戻る', async () => {
    appState.links.push(normalizeLink({ id: 4, from_id: 3, to_id: 2, label: '逆向きの明細', resource_revision: 1 }));
    resource.resetResourceBaseline(appState);
    await linksTab();
    appState.placements[1].x = 4000; appState.placements[1].y = 2000;
    appState.placements[2].x = 4200; appState.placements[2].y = 2000;
    const group = () => svg.querySelector('.link-group[data-display-key="10:2:3"]');
    await select(2);
    for (const id of [4, 2]) {
        appState.viewState.panX = 0;
        appState.viewState.panY = 0;
        await rowButton(id).dispatch('click');
        assert.equal(appState.editingLinkId, id);
        assert.equal(group().classList.contains('selected'), true);
        assert.equal(appState.viewState.panX, 600 - (4100 + DEFAULT_DEVICE_WIDTH / 2) * 0.5);
        assert.equal(appState.viewState.panY, 400 - 2043 * 0.5);
    }
    const badge = svg.querySelector('.link-count-badge[data-display-key="10:2:3"]');
    assert.equal(badge.querySelector('.link-label-count').textContent, '×2');
    const view = structuredClone(appState.viewState);
    await badge.dispatch('click');
    assert.equal(appState.editingLinkId, null);
    assert.equal(appState.editingLinkGroupKey, '10:2:3');
    assert.equal(group().classList.contains('selected'), true);
    assert.deepEqual(appState.viewState, view);
    assert.deepEqual(navigation.getWorkspaceSelectedLinkIds(), [2]);
    assert.equal(requests.length, 0);
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
    appState.viewLinkRoutes[0].manual_route = [{ x: 400, y: -400 }, { x: 2000, y: -400 }];
    const routeBefore = structuredClone(appState.viewLinkRoutes[0].manual_route);
    await rowButton(1).dispatch('click');
    assert.equal(appState.viewState.panX, 0);
    assert.equal(appState.viewState.panY, 600);
    assert.deepEqual(appState.viewLinkRoutes[0].manual_route, routeBefore);
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

test('一覧は少なくとも片端の配置がある共通接続を残し、両端未配置のときだけ外す', async () => {
    await linksTab();
    appState.placements = appState.placements.filter(row => row.device_id !== 3);
    const before = structuredClone(appState.viewState);
    const { render } = await import('../public/js/canvas/renderer.js');
    render();
    assert.ok(rowButton(2), '片端が未配置でも一覧から明細を開ける');
    assert.ok(!svg.querySelector('[data-display-key="10:2:3"]'), '片端が未配置なら線は表示しない');
    await rowButton(2).dispatch('click');
    assert.equal(appState.editingLinkId, 2);
    await select(2);
    appState.placements = appState.placements.filter(row => row.view_id !== 10 || row.device_id !== 2);
    eventBus.emit('canvas:render-complete');
    assert.equal(rowButton(2), null);
    assert.ok(appState.links.some(link => link.id === 2));
    assert.deepEqual(navigation.getWorkspaceSelectedLinkIds(), []);
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
    assert.equal(requests[0].links[0].link.system_id, 6);
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

test('両端の VLAN設定を検索し、同じ機器を共有する別接続の VLAN は混ぜない', async () => {
    await linksTab();
    const input = get('workspace-nav-search');
    assert.match(input.placeholder, /VLAN設定/);
    assert.match(panel.querySelector(`label[for="${input.id}"]`).textContent, /接続を検索/);
    assert.match(get(input.getAttribute('aria-describedby')).textContent, /両端のポート/);

    for (const query of ['access 100', 'native 110', '100 110']) {
        await search(query);
        assert.ok(rowButton(1), query);
        assert.equal(rowButton(2), null, query);
    }
    await search('access 200');
    assert.equal(rowButton(1), null);
    assert.ok(rowButton(2));
    const all = get('workspace-nav-select-all');
    all.checked = true;
    await all.dispatch('change');
    assert.deepEqual(navigation.getWorkspaceSelectedLinkIds(), [2]);

    await search('110 200');
    assert.equal(rowButton(1), null);
    assert.equal(rowButton(2), null);
});

test('ポート名の変更を含む VLAN 検索結果だけを一括選択する', async () => {
    appState.devicePorts.push(
        { id: 25, device_id: 1, name: 'Gi1/5', vlan: 'access 500' },
        { id: 26, device_id: 3, name: 'Gi1/5', vlan: 'access 600' }
    );
    appState.links[0].from_port_name = '　Ｇｉ１／５　';
    await linksTab();
    for (const query of ['100', '600']) {
        await search(query);
        assert.equal(rowButton(1), null, query);
    }

    await search('Gi1/5 500');
    assert.ok(rowButton(1));
    assert.equal(rowButton(2), null);
    const all = get('workspace-nav-select-all');
    all.checked = true;
    await all.dispatch('change');
    assert.deepEqual(navigation.getWorkspaceSelectedLinkIds(), [1]);

    appState.links[0].from_port_name = '';
    await search('500');
    assert.equal(rowButton(1), null);
    assert.match(get('workspace-nav-selection-status').textContent, /選択 1件（表示外 1件）/);
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
    assert.equal(get('workspace-nav-tab-links').textContent, '接続 (2件)');
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
    const portsBefore = structuredClone(appState.devicePorts);
    const routesBefore = structuredClone(appState.viewLinkRoutes);
    const openButton = get('workspace-nav-bulk-open'); openButton.focus();
    assert.equal(await bulk.openLinkBulkModal(navigation.getWorkspaceSelectedLinkIds(), { getSelectedIds: navigation.getWorkspaceSelectedLinkIds }), true);
    assert.equal(get('link-bulk-use-vlan'), null);
    assert.equal(get('link-bulk-vlan'), null);
    for (const key of ['system_id', 'label', 'memo']) {
        assert.equal(get(`link-bulk-use-${key}`).checked, false);
        assert.equal(get(`link-bulk-${key}`).disabled, true);
    }
    get('link-bulk-memo').value = 'opt-outの入力は無視';
    await setField('system_id', ''); await setField('label', '共通ラベル');
    assert.equal(bulk.previewLinkBulkModal(), true);
    assert.doesNotMatch(get('link-bulk-preview').textContent, /VLAN/);
    assert.deepEqual(appState.links, before, '確認画面ではまだ変更・保存しない');
    assert.deepEqual(requests, []);
    assert.equal(await bulk.applyLinkBulkModal(), true);
    await queue.flushSaveQueue({ silent: true });
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].links.map(row => [row.id, row.expected_revision]), [[1, 1], [2, 1]]);
    assert.equal(requests[0].views, undefined);
    assert.deepEqual(requests[0].device_ports, []);
    for (let index = 0; index < 2; index++) {
        const { id, resource_revision, ...fields } = before[index];
        assert.deepEqual(requests[0].links[index].link, { ...fields, system_id: null, label: '共通ラベル' });
        assert.equal(appState.links.find(link => link.id === id).memo, fields.memo);
    }
    assert.deepEqual(appState.devicePorts, portsBefore);
    assert.deepEqual(appState.viewLinkRoutes, routesBefore);
    assert.deepEqual(appState.links.find(link => link.id === before[2].id), before[2]);
    assert.equal(overlay.hidden, true);
    assert.equal(document.activeElement?.id, 'workspace-nav-bulk-open');
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
    appState.resourceConflicts.links.set(1, {});
    assert.equal(await bulk.applyLinkBulkModal(), false); assert.match(get('link-bulk-error').textContent, /競合/);
    bulk.closeLinkBulkModal(); appState.resourceConflicts.links.clear();
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
    assert.equal(appState.resourceConflicts.links.has(1), true);
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
    assert.equal(requests[0].links.find(row => row.id === 101).link.label, '再採番後');
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
    assert.equal(requests[0].links.find(row => row.id === 1).link.memo, '修正して確定する備考');
});

const legacyButton = id => panel.querySelector(`[data-nav-focus="legacy-${id}"]`);
const legacyCreate = id => panel.querySelector(`[data-nav-focus="legacy-create-${id}"]`);
const legacyDetails = id => panel.querySelector(`[data-nav-focus="legacy-details-${id}"]`);
const legacyRoute = id => panel.querySelector(`[data-nav-focus="legacy-route-${id}"]`);
const legacyRow = (legacy_link_id, view_id, overrides = {}) => ({
    legacy_link_id, view_id, device_a_id: 1, device_b_id: 3, reason: 'port_collision',
    payload: {
        id: legacy_link_id, view_id, from_id: 3, to_id: 1, from_port: '旧ポートA', to_port: '旧ポートB',
        system_id: 5, vlan: '321', label: '旧ラベル', memo: '<旧メモ>', route_mode: 'manual',
        manual_route: [{ x: 23, y: -11 }, { x: -250.5, y: 30 }]
    },
    ...overrides
});

test('旧行は元ビュー限定の読取用に描画し、同じIDの共通接続とも一括選択を共有しない', async () => {
    const current = legacyRow(1, 10);
    const other = legacyRow(22, 20);
    const orphan = legacyRow(33, 30);
    appState.legacyLinkConflicts = [current, other, orphan];
    await linksTab();
    const section = get('workspace-nav-legacy');
    assert.equal(section.open, true);
    assert.equal(section.querySelector('summary').textContent, '確認が必要な接続（1件）');
    assert.equal(section.querySelector('p').textContent, 'データ移行後、この旧接続の線は表示されていません。');
    const summary = legacyDetails(1);
    const details = summary.parentElement;
    assert.equal(details.tagName, 'DETAILS');
    assert.equal(details.open, false);
    const item = details.parentElement;
    assert.match(item.querySelector('strong').textContent, /予備SW（旧ポートA） → 元SW（旧ポートB）/);
    assert.equal(summary.textContent, '詳細');
    assert.equal(legacyCreate(1).textContent, '新規接続する');
    assert.equal(legacyButton(1).textContent, '旧記録を削除する');
    assert.ok(!details.contains(legacyCreate(1)) && !details.contains(legacyButton(1)));
    details.open = true; // ネイティブの開閉は軽量DOMで代替する。
    const body = details.children[1];
    assert.match(body.textContent, /保留理由：同じポートが複数の接続先/);
    assert.match(body.textContent, /対象ビュー \(#10\).*旧接続ID：#1.*旧ポートA → 旧ポートB/);
    assert.match(body.textContent, /管理系統 \/ VLAN：321.*旧ラベル.*<旧メモ>/);
    assert.match(body.textContent, /手動経路あり（座標2件）/);
    const routeSummary = legacyRoute(1);
    const routeDetails = routeSummary.parentElement;
    assert.equal(routeDetails.tagName, 'DETAILS');
    assert.equal(routeDetails.open, false);
    assert.doesNotMatch(routeSummary.textContent, /"x":23/);
    routeDetails.open = true;
    assert.equal(routeDetails.querySelector('code').textContent, JSON.stringify(current.payload.manual_route));
    routeSummary.focus();
    eventBus.emit('canvas:render-complete');
    assert.equal(legacyDetails(1).parentElement.open, true);
    assert.equal(legacyRoute(1).parentElement.open, true);
    assert.equal(document.activeElement, legacyRoute(1));
    assert.deepEqual(resolveViewLegacyConflicts(appState.views[0], appState), [current]);
    assert.deepEqual(resolveViewLegacyConflicts(null, appState), []);
    assert.equal(legacyButton(22), null);
    assert.equal(legacyButton(33), null);
    assert.ok(legacyButton(1) && rowButton(1));
    assert.equal(get('workspace-nav-tab-links').textContent, '接続 (2件)');
    get('workspace-nav-select-all').checked = true;
    await get('workspace-nav-select-all').dispatch('change');
    assert.deepEqual(navigation.getWorkspaceSelectedLinkIds(), [1, 2]);
    assert.equal(appState.editingLinkId, null);
    assert.deepEqual(requests, []);

    appState.currentViewId = 20;
    appState.views[1].view_type = 'rack';
    appState.rackMounts.push({ view_id: 20, device_id: 4 });
    window.APP_CONFIG.user.isAdmin = false;
    navigation.renderWorkspaceNavigation();
    assert.match(section.textContent, /#22/);
    assert.equal(legacyDetails(22).parentElement.open, false);
    assert.doesNotMatch(section.textContent, /#1 /);
    assert.equal(legacyButton(22), null);
    assert.equal(legacyCreate(22), null);
    assert.deepEqual(resolveWorkspaceLinks(appState.views[1], appState).map(link => link.id), [3]);
    await assert.rejects(excludeLegacyLink(other), /権限/);
    window.APP_CONFIG.user.isAdmin = true;
    await assert.rejects(excludeLegacyLink(current), /元ビュー/);
    await assert.rejects(excludeLegacyLink(orphan), /元ビュー/);
    assert.deepEqual(requests, []);
});

test('バッジ付き一覧は現在ビューの保留へフォーカスし、共通接続を登録しても保留件数を維持する', async () => {
    navigation.toggleWorkspaceNavigation();
    assert.equal(panel.hidden, true);
    assert.equal(badge.hidden, true);
    navigation.toggleWorkspaceNavigation();
    assert.equal(document.activeElement, get('workspace-nav-tab-devices'));
    navigation.toggleWorkspaceNavigation();

    const current = legacyRow(1, 10);
    const second = legacyRow(2, 10);
    const other = legacyRow(22, 20);
    const orphan = legacyRow(33, 30);
    appState.legacyLinkConflicts = [current, second, other, orphan];
    eventBus.emit('resources:reloaded');
    assert.equal(entry.contains(badge), true);
    assert.equal(badge.hidden, false);
    assert.equal(badge.textContent, '要確認 2');
    navigation.toggleWorkspaceNavigation();
    assert.equal(panel.hidden, false);
    assert.equal(get('workspace-nav-tab-links').getAttribute('aria-selected'), 'true');
    assert.equal(document.activeElement, get('workspace-nav-legacy').querySelector('summary'));

    appState.links.push(normalizeLink({ id: 4, from_id: 1, to_id: 3, label: '通常登録' }));
    assert.equal(await queue.flushSaveQueue({ silent: true }), true);
    assert.equal(requests[0].links[0].operation, 'create');
    assert.ok(appState.links.some(link => link.id === 104 && link.label === '通常登録'));
    assert.equal(badge.textContent, '要確認 2');
    assert.ok(legacyDetails(1) && legacyDetails(2));

    window.APP_CONFIG.user.isAdmin = false;
    eventBus.emit('resources:reloaded');
    assert.equal(badge.textContent, '要確認 2');
    assert.ok(legacyDetails(1));
    assert.equal(legacyButton(1), null);
    assert.equal(legacyCreate(1), null);
    navigation.toggleWorkspaceNavigation();
    assert.equal(panel.hidden, true);
    assert.equal(document.activeElement, entry);

    appState.currentViewId = 20;
    eventBus.emit('canvas:render-complete');
    assert.equal(badge.textContent, '要確認 1');
    appState.currentViewId = 30;
    eventBus.emit('canvas:render-complete');
    assert.equal(badge.hidden, true, '元ビューのない保留行を数えない');
    appState.currentViewId = 20;
    appState.legacyLinkConflicts = [orphan];
    eventBus.emit('resources:reloaded');
    assert.equal(badge.hidden, true);
    navigation.toggleWorkspaceNavigation();
    assert.equal(document.activeElement, get('workspace-nav-tab-links'), 'バッジがなければ前回のタブを開く');
});

test('要確認は未移行VLANを片端配置でも数え、入力欄を並べずに右パネルを開く', async () => {
    appState.legacyLinkConflicts = [legacyRow(51, 10)];
    appState.legacyLinkVlans = [{ link_id: 1, vlan: '旧 access 10' }, { link_id: 3, vlan: '旧 access 30' }];
    appState.placements = appState.placements.filter(row => row.view_id !== 10 || row.device_id !== 2);
    appState.devicePorts = appState.devicePorts.map(port => ({ ...port, resource_revision: 1 }));
    resource.resetResourceBaseline(appState);
    navigation.closeWorkspaceNavigation();
    eventBus.emit('legacy-vlans:changed');
    assert.equal(badge.textContent, '要確認 2');
    navigation.toggleWorkspaceNavigation();
    const section = get('workspace-nav-legacy');
    const review = get('workspace-nav-legacy-vlans');
    assert.equal(section.open, true);
    assert.equal(document.activeElement, section.querySelector('summary'));
    assert.match(section.textContent, /移行保留の旧接続.*未移行VLAN（1件）/s);
    assert.match(review.textContent, /元SW（Gi1\/1） ↔ 先AP.*未移行VLAN：旧 access 10/s);
    assert.doesNotMatch(review.textContent, /共通接続 #1|VLAN設定：|access 100|旧 access 30/);
    const actions = label => review.querySelectorAll('button').find(node => node.textContent === label);
    assert.equal(review.querySelectorAll('input, form').length, 0);
    assert.deepEqual(review.querySelectorAll('button').map(button => button.textContent), ['再設定する', '未移行設定削除']);
    await actions('再設定する').click();
    assert.equal(appState.editingLinkId, 1);
    assert.equal(linkPanel.hidden, false);
    assert.equal(document.activeElement, get('lp-from-port'));
    assert.deepEqual(requests, [], '右パネルを開くだけでは保存しない');
    const remove = () => actions('未移行設定削除');
    const changeSystem = async () => {
        await get('lp-system').dispatch('click');
        await [...get('lp-system-options').children].find(option => option.value === '').dispatch('click');
    };
    assert.equal(remove().disabled, false);
    await changeSystem();
    assert.equal(remove().disabled, true);
    assert.equal(panels.revertLinkPanelValues(), true);
    assert.equal(remove().disabled, false);
    await changeSystem();
    assert.equal(remove().disabled, true);
    const closing = panels.closeLinkPanel();
    await setImmediate();
    await get('unsaved-changes-discard').click();
    assert.equal(await closing, true);
    assert.equal(remove().disabled, false);
    const complete = actions('未移行設定削除').click();
    await setImmediate();
    const dialog = get('ledger-port-vlan-confirm-overlay');
    assert.match(dialog.textContent, /未移行VLANの削除.*共通接続 #1.*未移行VLAN：旧 access 10.*ポートのVLAN設定は変更せず、未移行VLANを削除します。/s);
    const endpoints = dialog.querySelectorAll('.port-vlan-confirm-endpoint');
    assert.deepEqual(endpoints.map(card => [card.querySelector('h3').textContent,
        ...card.querySelectorAll('p').map(line => line.textContent)]), [
        ['元SW', 'ポート：Gi1/1', '現在の VLAN設定：access 100'],
        ['先AP', 'ポート：eth0', '現在の VLAN設定：native 110'],
    ]);
    const confirm = dialog.querySelectorAll('button').find(node => node.textContent === '未移行設定削除');
    assert.equal(confirm.classList.contains('btn-danger'), true);
    assert.equal(document.activeElement.textContent, 'キャンセル');
    await confirm.click();
    await complete;
    assert.deepEqual(requests, [{ link_id: 1, expected_revision: 1, link_expected_revision: 1 }]);
    assert.deepEqual(appState.devicePorts.slice(0, 2).map(port => port.vlan), ['access 100', 'native 110']);
    assert.equal(badge.textContent, '要確認 1');
    assert.equal(review.hidden, true);
    assert.ok(legacyDetails(51));

    appState.currentViewId = 20;
    appState.views[1].view_type = 'rack';
    eventBus.emit('canvas:render-complete');
    assert.equal(badge.hidden, true, 'ラックビューの平面配置は数えない');
    appState.rackMounts.push({ view_id: 20, device_id: 4 });
    window.APP_CONFIG.user.isAdmin = false;
    eventBus.emit('rack:changed');
    assert.equal(badge.textContent, '要確認 1');
    assert.match(review.textContent, /旧 access 30/);
    assert.deepEqual(review.querySelectorAll('button'), [], '閲覧者は未移行VLANを確認できるが再設定・削除はできない');
});

test('接続線を非表示にしても共通接続の明細・ポート検索・一括設定は利用できる', async () => {
    appState.views[0].show_connections = 0;
    resource.resetResourceBaseline(appState);
    await linksTab();
    await search('Gi1/1');
    assert.equal(rowButton(2), null);
    await rowButton(1).dispatch('click');
    assert.equal(appState.editingLinkId, 1);
    assert.equal(svg.querySelector('.link-group'), null);
    await select(1);
    assert.equal(await bulk.openLinkBulkModal(navigation.getWorkspaceSelectedLinkIds()), true);
    await setField('label', '非表示でも編集');
    assert.equal(bulk.previewLinkBulkModal(), true);
    assert.equal(await bulk.applyLinkBulkModal(), true);
    await queue.flushSaveQueue({ silent: true });
    assert.deepEqual(requests.map(body => body.links[0].id), [1]);
});

test('確認後は旧IDと元ビューと世代のみを送信し、該当旧行と応答の経路だけを除外する', async () => {
    appState.legacyLinkConflicts = [legacyRow(1, 10), legacyRow(22, 20, { device_a_id: 2 })];
    const removed = { view_id: 10, device_a_id: 1, device_b_id: 3 };
    appState.viewLinkRoutes.push({ ...removed, manual_route: [{ x: 23, y: -11 }] });
    resource.resetResourceBaseline(appState);
    legacyResponse = () => ({
        ok: true, legacy_link_id: 1, revision: 2, saved_at: '2026-10-07T01:00:00Z',
        removed_view_link_routes: [removed], views: [{ id: 10, previous_resource_revision: 1, resource_revision: 2 }]
    });
    const initial = structuredClone({ links: appState.links, ports: appState.devicePorts, route: appState.viewLinkRoutes[0] });
    await linksTab(); await select(1);
    window.confirm = message => {
        assert.match(message, /旧記録 #1/);
        assert.match(message, /この旧記録1件をDBから削除します/);
        assert.match(message, /新しい接続は作成されず、既存の接続やポートは変わりません/);
        assert.match(message, /共通接続も旧記録も残らない場合.*手動経路も削除/);
        return false;
    };
    await legacyButton(1).dispatch('click');
    assert.deepEqual(requests, []);
    assert.equal(badge.textContent, '要確認 1');
    window.confirm = () => true;
    legacyButton(1).focus();
    await legacyButton(1).dispatch('click');
    assert.deepEqual(requests, [{ legacy_link_id: 1, view_id: 10, expected_revision: 1 }]);
    assert.equal(legacyRequestHeaders.get('X-CSRF-Token'), 'test-only-token');
    assert.deepEqual(appState.legacyLinkConflicts.map(row => row.legacy_link_id), [22]);
    assert.deepEqual(appState.links, initial.links);
    assert.deepEqual(appState.devicePorts, initial.ports);
    assert.deepEqual(appState.viewLinkRoutes, [initial.route]);
    assert.equal(appState.views[0].resource_revision, 2);
    assert.equal(appState.dataRevision, 2);
    assert.equal(queue.hasPendingChanges(), false);
    assert.deepEqual(navigation.getWorkspaceSelectedLinkIds(), [1]);
    assert.equal(get('workspace-nav-legacy').hidden, true);
    assert.equal(badge.hidden, true);
    assert.equal(document.activeElement, get('workspace-nav-tab-links'));
});

test('未保存、保存中と409の旧接続除外は対象を保持し、通常の保存へ混ぜない', async () => {
    const row = legacyRow(1, 10);
    appState.legacyLinkConflicts = [row];
    await linksTab();
    appState.links[0].memo = '未保存';
    await legacyButton(1).dispatch('click');
    assert.deepEqual(requests, []);
    assert.equal(appState.links[0].memo, '未保存');
    resource.resetResourceBaseline(appState);
    appState.isSaving = true;
    await legacyButton(1).dispatch('click');
    assert.deepEqual(requests, []);
    appState.isSaving = false;
    responseStatus = 409;
    await legacyButton(1).dispatch('click');
    assert.deepEqual(requests, [{ legacy_link_id: 1, view_id: 10, expected_revision: 1 }]);
    assert.deepEqual(appState.legacyLinkConflicts, [row]);
    assert.equal(badge.textContent, '要確認 1');
    assert.equal(appState.dataRevision, 1);
    assert.ok(legacyButton(1));
});

test('最新世代でも同じ旧IDに別の行がある場合や元ビューが消えた場合は送信しない', async () => {
    const row = legacyRow(1, 10);
    appState.dataRevision = 40; // 別リソースの保存で全体世代だけ進んだ状態。
    appState.legacyLinkConflicts = [row];
    const loaded = { ok: true, revision: 40, views: appState.views, legacy_link_conflicts: [row] };
    legacyLoadResponse = () => loaded;
    await linksTab();
    loaded.legacy_link_conflicts = [{ ...row, payload: { ...row.payload, memo: '復元された別の行' } }];
    await assert.rejects(excludeLegacyLink(row), /画面を再読み込み/);
    loaded.legacy_link_conflicts = [row];
    loaded.views = appState.views.slice(1);
    await assert.rejects(excludeLegacyLink(row), /画面を再読み込み/);
    loaded.views = appState.views;
    loaded.revision += 1;
    await assert.rejects(excludeLegacyLink(row), /画面を再読み込み/);
    assert.deepEqual(requests, []);
    assert.deepEqual(appState.legacyLinkConflicts, [row]);
    assert.equal(appState.dataRevision, 40);
});

test('旧行の除外応答を待つ間に次の通常保存を送信せず、後続の変更を保つ', async () => {
    const row = legacyRow(1, 10);
    appState.legacyLinkConflicts = [row];
    let finish;
    legacyResponse = () => new Promise(resolve => { finish = resolve; });
    await linksTab();
    legacyDetails(1).parentElement.open = true;
    const excluding = legacyButton(1).dispatch('click');
    await setImmediate();
    assert.equal(typeof finish, 'function');
    assert.equal(queue.isSaveInFlight(), true);
    assert.equal(legacyButton(1).getAttribute('aria-disabled'), 'true');
    await legacyButton(1).dispatch('click');
    appState.links[0].memo = '通信中の通常編集';
    const saving = queue.flushSaveQueue({ silent: true });
    assert.deepEqual(requests, [{ legacy_link_id: 1, view_id: 10, expected_revision: 1 }]);
    finish({ ok: true, legacy_link_id: 1, revision: 2, views: [], removed_view_link_routes: [] });
    await excluding;
    await saving;
    assert.equal(appState.legacyLinkConflicts.length, 0);
    assert.equal(requests.length, 2);
    assert.equal(requests[1].links[0].link.memo, '通信中の通常編集');
    assert.equal(appState.dataRevision, 3);
    assert.equal(appState.links[0].memo, '通信中の通常編集');
});

test('Ping実行状態の変化と一括設定エラーのクラス契約を維持する', async () => {
    assert.equal(get('link-bulk-error').classList.contains('link-bulk-error'), true);
    appState.legacyLinkVlans = [{ link_id: 1, vlan: '旧 access 10' }];
    await linksTab();
    await select(1);
    const bulkBtn = get('workspace-nav-bulk-open');
    const vlanButtons = () => get('workspace-nav-legacy-vlans').querySelectorAll('button');
    assert.equal(bulkBtn.disabled, false);
    assert.equal(vlanButtons().some(btn => btn.disabled), false);

    appState.isPinging = true;
    eventBus.emit('ping:busy-changed');
    assert.equal(bulkBtn.disabled, true);
    assert.equal(vlanButtons().every(btn => btn.disabled), true);

    appState.isPinging = false;
    eventBus.emit('ping:busy-changed');
    assert.equal(bulkBtn.disabled, false);
    assert.equal(vlanButtons().some(btn => btn.disabled), false);
});

test('キャンバスの機器選択と余白クリックによる選択解除で一覧の選択表示を同期する', async () => {
    const { render, onCanvasClick } = await import('../public/js/canvas/renderer.js');
    render();
    const linkNode = () => svg.querySelector('.link-group[data-display-key="10:1:2"] .topology-link');
    const originalLink = linkNode();
    const canvasDevice = id => deviceLayer.querySelector(`[data-placement-id="${id}"]`);
    const navDevice = id => panel.querySelector(`[data-placement-id="${id}"]`);

    await canvasDevice(11).dispatch('click');
    assert.equal(navDevice(11).classList.contains('is-selected'), true);
    assert.equal(navDevice(13).classList.contains('is-selected'), false);
    assert.ok(linkNode() === originalLink);

    await canvasDevice(13).dispatch('click');
    assert.equal(navDevice(11).classList.contains('is-selected'), false);
    assert.equal(navDevice(13).classList.contains('is-selected'), true);
    assert.ok(linkNode() === originalLink);

    await onCanvasClick({ target: canvas });
    assert.equal(appState.selectedPlacementIds.size, 0);
    assert.equal(panel.querySelector('.workspace-nav-device-item.is-selected'), null);
    assert.ok(linkNode() === originalLink);
});
