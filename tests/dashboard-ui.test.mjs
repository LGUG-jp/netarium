import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installWorkspaceDom, WorkspaceElement } from './helpers/workspace-dom.mjs';
import { appState, normalizeDevice, normalizeView } from '../public/js/core/state.js';
import { eventBus } from '../public/js/core/event-bus.js';
import {
    closeDashboard, getDashboardFocusableElements, hideDashboardForNavigation, openDashboard, refreshDashboard,
    renderDashboard, renderDashboardAfterQualityChange, renderDashboardAfterSaveStateChange
} from '../public/js/modals/dashboard-modal.js';

import { getTopModalContainer, requestModalClose } from '../public/js/core/modal-focus.js';
async function setup(t, templates = []) {
    const keys = ['window', 'document', 'HTMLElement', 'HTMLButtonElement', 'Element', 'fetch', 'HTMLInputElement', 'HTMLTextAreaElement'];
    const originals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const state = { ...appState };
    const dom = installWorkspaceDom({ templates: ['templates/modals/dashboard.php', ...templates] });
    const storage = new Map();
    window.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
    globalThis.HTMLButtonElement = WorkspaceElement;
    globalThis.HTMLInputElement = globalThis.HTMLTextAreaElement = WorkspaceElement;
    for (const button of document.querySelectorAll('button')) {
        button.tabIndex = Number(button.attributes.get('tabindex') ?? 0);
    }
    const querySelector = document.querySelector.bind(document);
    document.querySelector = selector => selector === '#dashboard-overlay .dashboard-dialog'
        ? dom.get('dashboard-overlay').querySelector('.dashboard-dialog')
        : querySelector(selector);
    let requests = 0;
    globalThis.fetch = async url => {
        requests++;
        if (String(url).includes('action=load_ip_management_summary')) {
            return { ok: true, json: async () => ({ ok: true, revision: 1,
                summary: { address_spaces: 0, ip_segments: 0, registered_ips: 0, unclassified_ips: 0 } }) };
        }
        return { ok: true, json: async () => ({ ok: true, revision: 1, issues: [], summary: { error: 0, warning: 0, info: 0, total: 0 } }) };
    };
    Object.assign(appState, {
        views: [], buildings: [], floors: [], rackMounts: [], rackSettings: [], devices: [], placements: [],
        devicePorts: [], links: [], dataRevision: 1, dataQualityResult: null,
        currentViewId: null, editingDeviceId: null, editingLinkId: null, isPinging: false,
        isDashboardNavigating: false, appStatus: { dirty: false, state: 'saved' }
    });
    document.readyState = 'loading';
    const { registerStaticListeners } = await import('../public/js/main.js');
    registerStaticListeners();
    t.after(eventBus.on('dashboard:hide-for-navigation', hideDashboardForNavigation));
    t.after(eventBus.on('data-quality:sync-changed', renderDashboardAfterQualityChange));
    t.after(eventBus.on('save-state:changed', renderDashboardAfterSaveStateChange));
    t.after(() => {
        closeDashboard();
        Object.assign(appState, state);
        for (const [key, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    });
    return { ...dom, requests: () => requests };
}

async function settleRefresh() {
    await new Promise(resolve => setImmediate(resolve));
}

async function clickTab(dom, name) {
    const tab = dom.get(`dashboard-tab-${name}`);
    await dom.get('dashboard-tabs').dispatch('click', { target: tab });
    return tab;
}

const clickAction = (dom, target) => dom.get('dashboard-content').dispatch('click', { target });

function assertSelected(dom, name) {
    for (const candidate of ['operations', 'assets', 'network', 'quality']) {
        const tab = dom.get(`dashboard-tab-${candidate}`);
        const panel = dom.get(tab.getAttribute('aria-controls'));
        assert.equal(tab.getAttribute('role'), 'tab');
        assert.equal(panel.getAttribute('role'), 'tabpanel');
        assert.equal(panel.getAttribute('aria-labelledby'), tab.id);
        assert.equal(tab.getAttribute('aria-selected'), String(candidate === name));
        assert.equal(tab.tabIndex, candidate === name ? 0 : -1);
        assert.equal(panel.hidden, candidate !== name);
    }
}

test('実テンプレートのタブ切替は再取得せず、更新後も維持し、開き直すと運用に戻る', async t => {
    const dom = await setup(t);
    openDashboard();
    await settleRefresh();
    assertSelected(dom, 'operations');
    const before = dom.requests();
    await clickTab(dom, 'assets');
    assertSelected(dom, 'assets');
    assert.equal(dom.requests(), before);
    assert.equal(document.getElementById('dashboard-assets-types-count'), null);
    assert.equal(dom.get('dashboard-assets-facilities-count').textContent, '0');
    assert.equal(dom.get('dashboard-maintenance-mode').value, 'fiscal');
    assert.equal(dom.get('dashboard-fiscal-start').value, '4');
    assert.equal(dom.get('dashboard-maintenance-expired-count').closest('button').classList.contains('is-warning'), false);
    const fiscalPeriods = dom.get('dashboard-maintenance-list').querySelectorAll('button');
    assert.equal(fiscalPeriods.length, 6);
    assert.ok(fiscalPeriods.every(period => !period.disabled && period.querySelector('strong').textContent === '0台'));
    const focusable = getDashboardFocusableElements();
    assert.ok(focusable.includes(dom.get('dashboard-tab-assets')));
    assert.ok(!focusable.includes(dom.get('dashboard-tab-operations')));
    assert.ok(!focusable.includes(dom.get('dashboard-devices-count').closest('button')));
    assert.ok(focusable.includes(dom.get('dashboard-maintenance-expired-count').closest('button')));
    appState.devices = [{ id: 1, name: '保守切れ機器', maintenance_expiry: '2000-01-01', status: 'green' }];
    await refreshDashboard();
    assert.equal(dom.requests(), before + 2);
    assertSelected(dom, 'assets');
    assert.equal(dom.get('dashboard-maintenance-expired-count').textContent, '1');
    assert.equal(dom.get('dashboard-maintenance-expired-count').closest('button').classList.contains('is-warning'), true);
    closeDashboard();
    openDashboard();
    await settleRefresh();
    assertSelected(dom, 'operations');
    hideDashboardForNavigation();
    assert.equal(getTopModalContainer(), null, '台帳への遷移で非表示のダッシュボードをモーダルスタックに残さない');
});

test('保守期限の開始月と表示モードを保持し、未登録・設定不要・形式不正を区別する', async t => {
    const dom = await setup(t);
    appState.devices = [
        { id: 1, maintenance_expiry: '2999-12' },
        { id: 2, maintenance_expiry: '' },
        { id: 3, maintenance_expiry: '' },
        { id: 4, maintenance_expiry: 'invalid' }
    ];
    const originalFetch = globalThis.fetch;
    const issue = { code: 'maintenance_expiry_missing', severity: 'info', category: 'completeness', entity_type: 'device' };
    globalThis.fetch = url => String(url).includes('action=data_quality') ? Response.json({
        ok: true, revision: 1, issues: [{ ...issue, entity_ids: [2] }],
        suppressed_issues: [{ ...issue, entity_ids: [3], not_applicable_items: [{ field: 'maintenance_expiry', device_id: 3 }] }],
        suppressed_count: 1
    }) : originalFetch(url);
    openDashboard();
    await settleRefresh();
    await clickTab(dom, 'assets');
    const start = dom.get('dashboard-fiscal-start');
    const mode = dom.get('dashboard-maintenance-mode');
    const currentYear = new Date().getFullYear();
    start.value = '1';
    await start.dispatch('change');
    assert.match(dom.get('dashboard-maintenance-list').querySelector('button').title,
        new RegExp(`${currentYear}年度（${currentYear}/01〜${currentYear}/12）`));
    assert.equal(dom.get('dashboard-maintenance-unset-count').textContent, '1');
    assert.equal(dom.get('dashboard-maintenance-suppressed-count').textContent, '1');
    assert.equal(dom.get('dashboard-maintenance-invalid-count').textContent, '1');
    assert.equal(dom.get('dashboard-maintenance-invalid').hidden, false);
    mode.value = 'remaining';
    await mode.dispatch('change');
    assert.equal(start.hidden, true);
    const beyond = dom.get('dashboard-maintenance-list').querySelector('[data-maintenance-category="beyond2Years"]');
    assert.equal(beyond.querySelector('.dashboard-maintenance-period-label').textContent, '2年超');
    assert.equal(beyond.querySelector('strong').textContent, '1台');
    assert.equal(beyond.querySelector('.dashboard-breakdown-bar').style.width, '100%');
    closeDashboard();
    openDashboard();
    await settleRefresh();
    assert.equal(mode.value, 'remaining');
    assert.equal(start.value, '1');
    assert.equal(start.hidden, true);

    Object.defineProperty(window, 'localStorage', { get() { throw new Error('storage blocked'); } });
    mode.value = 'fiscal';
    await mode.dispatch('change');
    assert.equal(start.hidden, false);
    assert.match(dom.get('dashboard-maintenance-list').querySelector('button').textContent, /年度/);
});

test('左右・Home・Endで選択とフォーカスを移し、非選択タブをTab巡回から外す', async t => {
    const dom = await setup(t);
    openDashboard();
    await settleRefresh();
    for (const [from, key, expected] of [
        ['operations', 'ArrowRight', 'assets'],
        ['assets', 'ArrowRight', 'network'],
        ['network', 'ArrowRight', 'quality'],
        ['quality', 'ArrowRight', 'operations'],
        ['operations', 'ArrowLeft', 'quality'],
        ['quality', 'Home', 'operations'],
        ['operations', 'End', 'quality']
    ]) {
        const event = await dom.get('dashboard-tabs').dispatch('keydown', {
            target: dom.get(`dashboard-tab-${from}`), key,
            preventDefault() { this.prevented = true; }
        });
        assert.equal(event.prevented, true);
        assertSelected(dom, expected);
        assert.equal(document.activeElement, dom.get(`dashboard-tab-${expected}`));
    }
});

test('機器内訳の概要は詳細を閉じても更新し、ラックとは独立して開閉する', async t => {
    const dom = await setup(t);
    appState.buildings = Array.from({ length: 7 }, (_, index) => ({ id: index + 1, name: `合成施設${index}` }));
    appState.floors = appState.buildings.map(row => ({ id: row.id, building_id: row.id, name: '1F' }));
    appState.floors.push({ id: 10, building_id: 1, name: '2F' });
    appState.devices = Array.from({ length: 8 }, (_, index) => ({
        id: index + 1, floor_id: index === 7 ? 10 : index + 1,
        type: index < 6 ? 'server' : 'switch'
    }));
    openDashboard();
    await settleRefresh();
    await clickTab(dom, 'assets');
    const details = dom.get('dashboard-breakdown-details');
    const toggle = dom.get('dashboard-breakdown-toggle');
    const rackList = dom.get('dashboard-rack-list');
    const summary = () => [
        dom.get('dashboard-assets-devices-count').textContent,
        dom.get('dashboard-assets-facilities-count').textContent
    ];
    assert.deepEqual(summary(), ['8', '7']);
    assert.equal(details.hidden, true);
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    assert.ok(!getDashboardFocusableElements().includes(dom.get('dashboard-type-list').querySelector('button')));

    await toggle.dispatch('click');
    assert.equal(details.hidden, false);
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(rackList.hidden, true);
    const facilities = dom.get('dashboard-facility-list');
    const buildingButtons = () => facilities.querySelectorAll('[data-dashboard-action="ledger-building"]');
    assert.equal(buildingButtons().length, 5);
    assert.equal(facilities.querySelector('.dashboard-breakdown-label').textContent, '合成施設0');
    assert.equal(facilities.querySelector('.dashboard-breakdown-bar').style.width, '25%');
    const buildingRow = facilities.querySelector('.dashboard-building-row');
    const buildingToggle = buildingRow.querySelector('.dashboard-building-toggle');
    const floors = dom.get(buildingToggle.getAttribute('aria-controls'));
    assert.equal(floors.hidden, true);
    await buildingToggle.dispatch('click');
    assert.equal(dom.get('dashboard-overlay').hidden, false);
    assert.equal(buildingToggle.getAttribute('aria-expanded'), 'true');
    assert.equal(floors.hidden, false);
    assert.equal(floors.querySelector('.dashboard-breakdown-bar').style.width, '50%');
    assert.equal(buildingToggle.contains(buildingRow.querySelector('[data-dashboard-action="ledger-building"]')), false);
    await buildingToggle.dispatch('click');
    assert.equal(floors.hidden, true);
    await facilities.querySelector('.dashboard-breakdown-toggle-btn').dispatch('click');
    assert.equal(buildingButtons().length, 7);
    assert.equal(details.hidden, false);

    await dom.get('dashboard-racks-toggle').dispatch('click');
    await toggle.dispatch('click');
    assert.equal(details.hidden, true);
    assert.equal(rackList.hidden, false);
    appState.buildings.push({ id: 8, name: '追加施設' });
    appState.floors.push({ id: 8, building_id: 8, name: '2F' });
    appState.devices.push({ id: 9, type: 'router', floor_id: 8 });
    await refreshDashboard();
    assert.deepEqual(summary(), ['9', '8']);
    assert.equal(details.hidden, true);
    assert.equal(rackList.hidden, false);
    await toggle.dispatch('click');
    assert.equal(buildingButtons().length, 8);
    closeDashboard();
    openDashboard();
    await settleRefresh();
    assert.equal(details.hidden, true);
    assert.equal(rackList.hidden, true);
    appState.devices = [];
    await refreshDashboard();
    assert.deepEqual(summary(), ['0', '0']);
    await toggle.dispatch('click');
    assert.equal(facilities.querySelectorAll('button').length, 0);
    assert.equal(facilities.querySelector('.dashboard-building-toggle'), null);
    assert.equal(dom.get('dashboard-type-list').querySelectorAll('button').length, 0);
});

test('設置建物数はIDで数え、旧施設の文字列や未設定を含めない', async t => {
    const dom = await setup(t);
    appState.buildings = [{ id: 1, name: '本庁' }, { id: 2, name: '分庁舎' }];
    appState.floors = [{ id: 10, building_id: 1, name: '1F' }, { id: 11, building_id: 1, name: '2F' },
        { id: 20, building_id: 2, name: '1F' }];
    appState.devices = [
        { id: 1, floor_id: 10 }, { id: 2, floor_id: 11 }, { id: 3, floor_id: 20 },
        { id: 4, floor_id: null, facility: '旧施設' }, { id: 5, floor_id: null }, { id: 6 }
    ];
    openDashboard();
    await settleRefresh();
    assert.equal(dom.get('dashboard-assets-devices-count').textContent, '6');
    assert.equal(dom.get('dashboard-assets-facilities-count').textContent, '2');
    await clickTab(dom, 'assets');
    await dom.get('dashboard-breakdown-toggle').dispatch('click');
    const last = dom.get('dashboard-facility-list').querySelectorAll('.dashboard-building-row').at(-1);
    assert.equal(last.querySelector('[data-building-id="unset"]').querySelector('strong').textContent, '未設定');
    assert.equal(last.querySelector('.dashboard-building-toggle'), null);
    appState.devices = [{ id: 7, facility: '' }];
    await refreshDashboard();
    assert.equal(dom.get('dashboard-assets-facilities-count').textContent, '0');
});

test('ラック一覧だけを折り畳み、再描画と更新に追従し、開き直すと閉じる', async t => {
    const dom = await setup(t);
    appState.views = [
        { id: 1, view_type: 'rack', name: '合成ラック', facility: '旧施設', floor: '旧階', floor_id: 10 },
        { id: 2, view_type: 'rack', name: '場所未登録' },
        { id: 3, view_type: 'floor', name: '通常フロア' }
    ];
    appState.buildings = [{ id: 1, name: '合成施設' }];
    appState.floors = [{ id: 10, building_id: 1, name: '2F' }];
    appState.rackSettings = [{ view_id: 1, total_u: 6, location: '北側' }, { view_id: 2, total_u: 4 }];
    appState.rackMounts = [
        { view_id: 1, device_id: 10, face: 'both', width_slot: 'full', start_u: 1, height_u: 2 },
        { view_id: 1, device_id: 11, face: 'rear', width_slot: 'right', start_u: 3, height_u: 1 }
    ];
    openDashboard();
    await settleRefresh();
    await clickTab(dom, 'assets');
    const toggle = dom.get('dashboard-racks-toggle');
    const list = dom.get('dashboard-rack-list');
    const summary = () => [dom.get('dashboard-racks-count').textContent, dom.get('dashboard-rack-devices-count').textContent];
    assert.deepEqual(summary(), ['2', '2']);
    assert.equal(list.hidden, true);
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    const firstRow = () => list.querySelector('button');
    assert.ok(getDashboardFocusableElements().includes(toggle));
    assert.ok(!getDashboardFocusableElements().includes(firstRow()));
    await toggle.dispatch('click');
    assert.equal(list.hidden, false);
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(firstRow().querySelector('small').textContent, '合成施設 / 2F / 北側');
    assert.equal(firstRow().querySelector('.dashboard-rack-devices').textContent, '2台');
    assert.equal(list.querySelectorAll('button')[1].querySelector('small').textContent, '未分類');
    assert.match(firstRow().querySelector('.dashboard-rack-front-free').textContent, /4U$/);
    assert.match(firstRow().querySelector('.dashboard-rack-rear-free').textContent, /3U$/);
    const bars = firstRow().querySelectorAll('.dashboard-rack-occupancy-bar');
    assert.equal(parseFloat(bars[0].style.width), 4 / 12 * 100);
    assert.equal(parseFloat(bars[1].style.width), 5 / 12 * 100);
    assert.deepEqual(list.querySelectorAll('button')[1].querySelectorAll('.dashboard-rack-occupancy-bar').map(bar => bar.style.width), ['0%', '0%']);

    // 名称変更・追加・移設を再描画で反映し、開閉状態はそのまま保つ。
    appState.views[0].name = '変更後のラック';
    appState.views.push({ id: -1, view_type: 'rack', name: '新規ラック' });
    appState.rackSettings.push({ view_id: -1, total_u: 4 });
    appState.rackMounts[1].view_id = -1;
    renderDashboard();
    assert.deepEqual(summary(), ['3', '2']);
    assert.equal(list.hidden, false);
    assert.equal(firstRow().querySelector('strong').textContent, '変更後のラック');
    assert.equal(firstRow().querySelector('.dashboard-rack-devices').textContent, '1台');
    assert.equal(list.querySelectorAll('button')[2].querySelector('.dashboard-rack-devices').textContent, '1台');
    assert.match(firstRow().querySelector('.dashboard-rack-rear-free').textContent, /4U$/);
    assert.equal(parseFloat(firstRow().querySelectorAll('.dashboard-rack-occupancy-bar')[1].style.width), 4 / 12 * 100);
    assert.match(list.querySelectorAll('button')[2].querySelector('.dashboard-rack-front-free').textContent, /4U$/);
    assert.match(list.querySelectorAll('button')[2].querySelector('.dashboard-rack-rear-free').textContent, /3U$/);

    // 取り外しと削除は更新操作でも反映される。
    appState.rackMounts = [];
    appState.views = appState.views.filter(view => view.id === 3);
    await refreshDashboard();
    assert.deepEqual(summary(), ['0', '0']);
    assert.equal(list.textContent, '登録済みのラックはありません');
    assert.equal(list.hidden, false);
    closeDashboard();
    openDashboard();
    await settleRefresh();
    await clickTab(dom, 'assets');
    assert.equal(list.hidden, true);
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    assert.deepEqual(summary(), ['0', '0']);
});

test('ラック選択は未適用編集とPing中の拒否を維持し、成功時だけ閉じて対象ラックを描画する', async t => {
    const dom = await setup(t, ['templates/components/property_panel.php', 'templates/components/canvas.php']);
    const create = document.createElement;
    document.createElement = tag => {
        const node = create(tag);
        node.style.setProperty = (key, value) => { node.style[key] = value; };
        return node;
    };
    const { openPanel } = await import('../public/js/ui/property-panel.js');
    const { resetResourceBaseline } = await import('../public/js/core/resource-save.js');
    const { clearPendingSave } = await import('../public/js/core/save-queue.js');
    appState.views = [
        normalizeView({ id: 1, name: '通常ビュー' }),
        normalizeView({ id: 2, name: '遷移先ラック', view_type: 'rack' })
    ];
    appState.devices = [normalizeDevice({ id: 1, name: '確定済み機器', type: 'server' })];
    Object.assign(appState, {
        currentViewId: 1, rackSettings: [{ view_id: 2, total_u: 3, location: '' }],
        links: [], canvasNotes: [], floorPlans: [], deviceImages: [],
        world: dom.get('world'), canvas: dom.get('canvas'), deviceLayer: dom.get('device-layer'),
        currentSvg: dom.get('link-layer'), floorPlanLayer: dom.get('floor-plan-layer'),
        selectedPlacementIds: new Set(), viewStates: new Map(),
        viewState: { ...appState.viewState }, resourceConflicts: { devices: new Map(), views: new Map() }
    });
    resetResourceBaseline(appState);
    t.after(() => clearPendingSave());
    const selector = dom.add('input', 'view-search-input');
    openPanel(appState.devices[0]);
    dom.get('p-name').value = '未適用の編集';
    openDashboard();
    await settleRefresh();
    await clickTab(dom, 'assets');
    await dom.get('dashboard-racks-toggle').dispatch('click');
    const row = dom.get('dashboard-rack-list').querySelector('button');
    const pending = row.dispatch('click');
    await settleRefresh();
    await dom.get('unsaved-changes-cancel').dispatch('click');
    await pending;
    assert.equal(appState.currentViewId, 1);
    assert.equal(dom.get('dashboard-overlay').hidden, false);
    assert.equal(getTopModalContainer(), dom.get('dashboard-overlay'));
    assert.equal(dom.get('p-name').value, '未適用の編集');
    assert.equal(appState.isDashboardNavigating, false);

    appState.isPinging = true;
    await row.dispatch('click');
    assert.equal(appState.currentViewId, 1);
    assert.equal(dom.get('dashboard-overlay').hidden, false);
    appState.isPinging = false;
    const accepted = row.dispatch('click');
    await settleRefresh();
    await dom.get('unsaved-changes-discard').dispatch('click');
    await accepted;
    assert.equal(appState.currentViewId, 2);
    assert.equal(dom.get('dashboard-overlay').hidden, true);
    assert.equal(getTopModalContainer(), null);
    assert.equal(appState.devices[0].name, '確定済み機器');
    assert.equal(dom.get('rack-view').hidden, false);
    assert.equal(dom.get('world').hidden, true);
    assert.equal(dom.get('rack-view').getAttribute('aria-label'), '遷移先ラック');
    assert.equal(document.activeElement, selector);
});

test('IP集計は未取得・取得中・DBの件数・失敗・再取得を区別し、古い画面マスタに依存しない', async t => {
    const dom = await setup(t);
    assert.equal(dom.get('dashboard-ip-status').textContent, '未取得');
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    const qualityFetch = globalThis.fetch;
    let fail = false;
    globalThis.fetch = async url => {
        if (!String(url).includes('action=load_ip_management_summary')) return qualityFetch(url);
        await pending;
        if (fail) return { ok: false, status: 503, json: async () => ({ error: 'unavailable' }) };
        return { ok: true, json: async () => ({ ok: true, revision: 7,
            summary: { address_spaces: 2, ip_segments: 3, registered_ips: 5, unclassified_ips: 1 } }) };
    };
    Object.assign(appState, { addressSpaces: [], ipSegments: [] });
    openDashboard();
    assert.match(dom.get('dashboard-ip-status').textContent, /取得中/);
    assert.equal(dom.get('dashboard-ip-registered_ips-count').textContent, '—');
    finish();
    await settleRefresh();
    assert.deepEqual(['address_spaces', 'ip_segments', 'registered_ips', 'unclassified_ips']
        .map(key => dom.get(`dashboard-ip-${key}-count`).textContent), ['2', '3', '5', '1']);
    assert.equal(dom.get('dashboard-ip-unclassified').classList.contains('is-warning'), true);
    assert.equal(dom.get('dashboard-ip-unclassified').disabled, false);
    assert.match(dom.get('dashboard-ip-status').textContent, /画面データと差異/);
    fail = true;
    await refreshDashboard();
    assert.equal(dom.get('dashboard-ip-registered_ips-count').textContent, '—');
    assert.match(dom.get('dashboard-ip-status').textContent, /取得できません/);
    assert.equal(dom.get('dashboard-ip-unclassified').disabled, true);
    fail = false;
    await refreshDashboard();
    assert.equal(dom.get('dashboard-ip-registered_ips-count').textContent, '5');
    assert.equal(dom.get('dashboard-ip-unclassified').disabled, false);
});

for (const ipFinished of [false, true]) {
    test(`更新中の開き直しはIP取得${ipFinished ? '完了後の集計' : '中の状態'}を保持し、通常の開き直しは再取得する`, async t => {
        const dom = await setup(t);
        const originalFetch = globalThis.fetch;
        let finishQuality, finishIp;
        const qualityPending = new Promise(resolve => { finishQuality = resolve; });
        const ipPending = new Promise(resolve => { finishIp = resolve; });
        t.after(() => { finishQuality(); finishIp(); });
        let registered = 3;
        globalThis.fetch = async url => {
            if (String(url).includes('action=data_quality')) {
                await qualityPending;
                return originalFetch(url);
            }
            await ipPending;
            return { ok: true, json: async () => ({ ok: true, revision: 1,
                summary: { address_spaces: 1, ip_segments: 2, registered_ips: registered, unclassified_ips: 1 } }) };
        };
        if (ipFinished) finishIp();
        openDashboard();
        await settleRefresh();
        assert.equal(dom.get('dashboard-ip-registered_ips-count').textContent, ipFinished ? '3' : '—');
        closeDashboard();
        openDashboard();
        await clickTab(dom, 'network');
        assert.equal(dom.get('dashboard-ip-registered_ips-count').textContent, ipFinished ? '3' : '—');
        assert.equal(dom.get('dashboard-ip-unclassified').disabled, true);
        finishIp();
        finishQuality();
        await settleRefresh();
        assert.deepEqual(['address_spaces', 'ip_segments', 'registered_ips', 'unclassified_ips']
            .map(key => dom.get(`dashboard-ip-${key}-count`).textContent), ['1', '2', '3', '1']);
        assert.equal(dom.get('dashboard-ip-status').hidden, true);
        assert.equal(dom.get('dashboard-ip-unclassified').disabled, false);
        assert.equal(dom.get('dashboard-refresh-btn').disabled, false);
        registered = 4;
        closeDashboard();
        openDashboard();
        await settleRefresh();
        assert.equal(dom.get('dashboard-ip-registered_ips-count').textContent, '4');
    });
}

test('品質取得の失敗でもIP取得の完了を待ち、IPサマリーは独立して表示する', async t => {
    const dom = await setup(t);
    const originalFetch = globalThis.fetch;
    const originalError = console.error;
    console.error = () => {};
    t.after(() => { console.error = originalError; });
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    globalThis.fetch = async url => {
        if (String(url).includes('action=data_quality')) throw new Error('quality unavailable');
        await pending;
        return originalFetch(url);
    };
    openDashboard();
    await settleRefresh();
    assert.equal(dom.get('dashboard-refresh-btn').disabled, true);
    assert.equal(dom.get('dashboard-ip-unclassified').disabled, true);
    finish();
    await settleRefresh();
    assert.equal(dom.get('dashboard-refresh-btn').disabled, false);
    assert.equal(dom.get('dashboard-ip-registered_ips-count').textContent, '0');
    assert.equal(dom.get('dashboard-ip-unclassified').disabled, false);
    assert.equal(dom.get('dashboard-ip-status').hidden, true);
    assert.equal(dom.get('dashboard-ip-unclassified').querySelector('.dashboard-kpi-unit').textContent, '件');
    assert.equal(dom.get('dashboard-status').hidden, false);
});

test('IP全ゼロは警告にせず、区分一覧と未分類一覧へ排他的に遷移し起動元にフォーカスを戻す', async t => {
    const dom = await setup(t);
    const { closeIpManagement } = await import('../public/js/modals/ip-management-modal.js');
    const originalFetch = globalThis.fetch;
    const requested = [];
    globalThis.fetch = async url => {
        const action = new URL(url, 'http://localhost').searchParams.get('action');
        requested.push(action);
        if (action === 'load_ip_management') return new Response(JSON.stringify({
            ok: true, status: 'success', revision: 1, devices: [], address_spaces: [], ip_segments: [], ip_records: []
        }));
        return originalFetch(url);
    };
    const origin = document.createElement('button');
    document.body.appendChild(origin);
    for (const action of ['ip-management', 'ip-unclassified']) {
        origin.focus();
        openDashboard();
        await settleRefresh();
        await clickTab(dom, 'network');
        assert.equal(dom.get('dashboard-ip-unclassified_ips-count').textContent, '0');
        assert.equal(dom.get('dashboard-ip-unclassified').classList.contains('is-warning'), false);
        const before = requested.length;
        const button = dom.get('dashboard-panel-network').querySelector(`[data-dashboard-action="${action}"]`);
        button.focus();
        await clickAction(dom, button);
        await settleRefresh();
        const modal = document.getElementById('ip-management-overlay');
        assert.equal(dom.get('dashboard-overlay').hidden, true);
        assert.equal(getTopModalContainer(), modal);
        assert.equal(modal.hidden, false);
        assert.match(modal.textContent, action === 'ip-unclassified' ? /未分類IP一覧/ : /ネットワークを登録/);
        assert.deepEqual(requested.slice(before), ['load_ip_management']);
        await closeIpManagement();
        await settleRefresh();
        assert.equal(getTopModalContainer(), null);
        assert.equal(document.activeElement, origin);
    }
});

test('到達不可を含む未確認も全機器のOK率に含み、到達性警告は既存の品質診断へ進む', async t => {
    const dom = await setup(t, ['templates/modals/data_quality.php']);
    const origin = dom.add('button', 'open-dashboard-for-quality');
    origin.focus();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async url => String(url).includes('action=data_quality')
        ? { ok: true, json: async () => ({
            ok: true, revision: 1,
            summary: { error: 0, warning: 1, info: 0, total: 1 },
            issues: [{ code: 'ambiguous_ping_target', severity: 'warning', category: 'monitoring',
                entity_type: 'device', entity_ids: [1, 2], message: 'Ping対象の識別不可' }]
        }) }
        : originalFetch(url);
    appState.devices = [
        normalizeDevice({ id: 1, name: '到達可能', status: 'green' }),
        normalizeDevice({ id: 2, name: '未確定', status: 'unknown' }),
        normalizeDevice({ id: 3, name: '到達不可', status: 'unknown' }),
        normalizeDevice({ id: 4, name: '未実行', status: 'unknown' })
    ];
    openDashboard();
    await settleRefresh();
    assert.equal(dom.get('dashboard-devices-count').textContent, '4');
    assert.equal(dom.get('dashboard-monitoring-green-count').textContent, '1台');
    assert.equal(dom.get('dashboard-monitoring-unknown-count').textContent, '3台');
    assert.equal(dom.get('dashboard-bar-green').style.width, '25.0%');
    assert.equal(dom.get('dashboard-bar-unknown').style.width, '75.0%');
    assert.equal(dom.get('dashboard-quality-warning-count').textContent, '1');
    const { handleDashboardAction } = await import('../public/js/modals/dashboard-modal.js');
    handleDashboardAction('quality-warning');
    assert.equal(dom.get('dashboard-overlay').hidden, true);
    assert.equal(dom.get('data-quality-overlay').hidden, false);
    assert.equal(getTopModalContainer(), dom.get('data-quality-overlay'));
    assert.equal(appState.dataQualitySeverityFilter, 'warning');
    assert.equal(appState.dataQualityCategoryFilter, '');
    assert.equal(appState.dataQualityResult.issues[0].code, 'ambiguous_ping_target');
    await settleRefresh();
    requestModalClose();
    assert.equal(dom.get('data-quality-overlay').hidden, true);
    assert.equal(getTopModalContainer(), null);
    assert.equal(document.activeElement, origin);
});

test('IP集計待ちのダッシュボード更新は、後から再診断した設定不要の結果を上書きしない', async t => {
    const dom = await setup(t, ['templates/modals/data_quality.php']);
    const { closeDataQuality, openDataQuality } = await import('../public/js/modals/data-quality-modal.js');
    const { handleDashboardAction } = await import('../public/js/modals/dashboard-modal.js');
    const originalFetch = globalThis.fetch;
    let finishIpSummary;
    const pendingIpSummary = new Promise(resolve => { finishIpSummary = resolve; });
    const issue = { code: 'missing_recommended_fields', severity: 'warning', category: 'completeness',
        entity_type: 'device', entity_ids: [1], message: '機器の推奨項目が不足しています',
        not_applicable_items: [{ field: 'model', device_id: 1, label: '型番', resource_revision: 2 }] };
    const before = { ok: true, revision: 1, issues: [issue],
        summary: { error: 0, warning: 1, info: 0, total: 1 }, suppressed_issues: [], suppressed_count: 0 };
    const after = { ...before, issues: [], summary: { ...before.summary, warning: 0, total: 0 },
        suppressed_issues: [issue], suppressed_count: 1 };
    let diagnosis = before;
    globalThis.fetch = async url => String(url).includes('action=data_quality')
        ? Response.json(diagnosis)
        : pendingIpSummary.then(() => originalFetch(url));
    try {
        openDashboard();
        await settleRefresh();
        closeDashboard();
        diagnosis = after;
        openDataQuality();
        await settleRefresh();
        assert.equal(dom.get('data-quality-suppressed-count').textContent, '1');
        closeDataQuality();

        finishIpSummary();
        await settleRefresh();
        handleDashboardAction('quality-incomplete');
        assert.equal(dom.get('data-quality-warning-count').textContent, '0');
        assert.equal(dom.get('data-quality-suppressed-count').textContent, '1');
        await settleRefresh();
    } finally {
        finishIpSummary();
        closeDataQuality();
    }
});

test('ダッシュボードから同じリビジョンでも再取得し、最新の設定不要が届くまで通常一覧を保つ', async t => {
    const dom = await setup(t, ['templates/modals/data_quality.php']);
    const { handleDashboardAction } = await import('../public/js/modals/dashboard-modal.js');
    const { closeDataQuality } = await import('../public/js/modals/data-quality-modal.js');
    const originalFetch = globalThis.fetch;
    const issue = { code: 'missing_recommended_fields', severity: 'warning', category: 'completeness',
        entity_type: 'device', entity_ids: [1], message: '機器の推奨項目が不足しています',
        not_applicable_items: [{ field: 'model', device_id: 1, label: '型番', resource_revision: 2 }] };
    const before = { ok: true, revision: 1, issues: [issue],
        summary: { error: 0, warning: 1, info: 0, total: 1 }, suppressed_issues: [], suppressed_count: 0 };
    const after = { ...before, issues: [], summary: { ...before.summary, warning: 0, total: 0 },
        suppressed_issues: [issue], suppressed_count: 1 };
    const pending = Promise.withResolvers();
    let requests = 0;
    globalThis.fetch = url => {
        if (!String(url).includes('action=data_quality')) return originalFetch(url);
        return ++requests === 1 ? Promise.resolve(Response.json(before)) : pending.promise;
    };
    appState.devices = [normalizeDevice({ id: 1, name: '機器1' })];
    try {
        openDashboard();
        await settleRefresh();
        assert.equal(dom.get('dashboard-quality-warning-count').textContent, '1');
        assert.equal(appState.dataRevision, appState.dataQualityResult.revision);

        handleDashboardAction('quality-incomplete');
        const list = dom.get('data-quality-issue-list');
        const card = list.querySelector('article');
        assert.ok(card);
        assert.equal(requests, 2);
        await settleRefresh();
        assert.equal(list.hidden, false);
        assert.equal(list.querySelector('article'), card);
        assert.equal(dom.get('data-quality-warning-count').textContent, '1');

        pending.resolve(Response.json(after));
        await settleRefresh();
        assert.equal(dom.get('data-quality-total-count').textContent, '0');
        assert.equal(dom.get('data-quality-suppressed-count').textContent, '1');
        assert.equal(list.querySelector('article'), null);
    } finally {
        pending.resolve(Response.json(after));
        await settleRefresh();
        closeDataQuality();
    }
});

test('年度の件数を選ぶと、期限切れを含めず年度条件を台帳に引き継ぐ', async t => {
    const dom = await setup(t, ['templates/modals/ledger.php']);
    const { closeLedger, getFilteredLedgerDevices } = await import('../public/js/modals/ledger-modal.js');
    appState.devices = [
        normalizeDevice({ id: 1, name: '期限切れ', maintenance_expiry: '2000-01-01' }),
        normalizeDevice({ id: 2, name: '先の年度', maintenance_expiry: '2999-12' })
    ];
    openDashboard();
    await settleRefresh();
    await clickTab(dom, 'assets');
    const later = dom.get('dashboard-maintenance-list').querySelectorAll('button').at(-1);
    assert.match(later.querySelector('.dashboard-maintenance-period-label').textContent, /年度以降/);
    assert.equal(later.querySelector('strong').textContent, '1台');
    try {
        await clickAction(dom, later.querySelector('strong'));
        assert.equal(dom.get('dashboard-overlay').hidden, true);
        assert.equal(dom.get('ledger-overlay').hidden, false);
        assert.deepEqual(getFilteredLedgerDevices().map(device => device.id), [2]);
        assert.match(dom.get('ledger-active-filter-list').textContent, /保守期限.*年度以降/);
    } finally {
        await closeLedger();
    }
    openDashboard();
    await settleRefresh();
    await clickTab(dom, 'assets');
    const empty = dom.get('dashboard-maintenance-list').querySelector('button');
    assert.equal(empty.querySelector('strong').textContent, '0台');
    try {
        await clickAction(dom, empty);
        assert.equal(dom.get('ledger-overlay').hidden, false);
        assert.deepEqual(getFilteredLedgerDevices(), []);
        assert.match(dom.get('ledger-active-filter-list').textContent, /保守期限.*年度/);
    } finally {
        await closeLedger();
    }
});

test('取得中・未保存・revision不一致・取得失敗は品質連動指標を確定表示しない', async t => {
    const dom = await setup(t);
    const originalError = console.error;
    console.error = () => {};
    t.after(() => { console.error = originalError; });
    const result = { ok: true, revision: 1, issues: [{
        code: 'maintenance_expiry_missing', severity: 'info', category: 'completeness',
        entity_type: 'device', entity_ids: [1]
    }] };
    appState.dataQualityResult = result;
    appState.devices = [{ id: 1 }];
    appState.links = [{ id: 1, from_id: 1, to_id: 99 }];
    const originalFetch = globalThis.fetch;
    const pending = Promise.withResolvers();
    let qualityRequest = pending.promise;
    globalThis.fetch = url => String(url).includes('action=data_quality') ? qualityRequest : originalFetch(url);
    const assertUnconfirmed = () => {
        assert.equal(dom.get('dashboard-quality-panel-total').textContent, '—');
        assert.equal(dom.get('dashboard-maintenance-unset-count').textContent, '—');
        assert.equal(dom.get('dashboard-maintenance-suppressed-count').textContent, '—');
        assert.equal(dom.get('dashboard-network-endpoints').textContent, '—');
        for (const key of ['problems', 'error', 'warning', 'info', 'suppressed']) {
            const metric = dom.get(`dashboard-diagnosis-${key}-count`);
            assert.equal(metric.textContent, '—');
            assert.equal(metric.closest('button').disabled, true);
        }
        assert.equal(dom.get('dashboard-diagnosis-categories').querySelectorAll('button').length, 0);
        assert.doesNotMatch(dom.get('dashboard-diagnosis-categories').textContent, /\d件/);
        assert.equal(dom.get('dashboard-diagnosis-migration').hidden, true);
        assert.equal(dom.get('dashboard-registration-table').hidden, true);
        assert.equal(dom.get('dashboard-registration-status').textContent, '—');
        assert.equal(dom.get('dashboard-registration-status').hidden, false);
        assert.equal(dom.get('dashboard-network-link-count').textContent, '1');
    };
    try {
        openDashboard();
        assertUnconfirmed();
        pending.resolve(Response.json(result));
        await settleRefresh();
        assert.equal(dom.get('dashboard-maintenance-unset-count').textContent, '1');
        const missing = dom.get('dashboard-network-endpoints').querySelector('button');
        assert.equal(missing.querySelector('strong').textContent, '2端点');
        appState.appStatus.dirty = true;
        eventBus.emit('save-state:changed');
        assertUnconfirmed();
        assert.match(dom.get('dashboard-notices').textContent, /未保存/);
        appState.appStatus.dirty = false;
        appState.dataRevision = 2;
        eventBus.emit('save-state:changed');
        assertUnconfirmed();
        assert.match(dom.get('dashboard-notices').textContent, /リビジョン.*一致していません/);
        appState.dataRevision = 1;
        qualityRequest = Promise.resolve(Response.json({ error: '診断取得失敗' }, { status: 503 }));
        await refreshDashboard();
        assertUnconfirmed();
        assert.match(dom.get('dashboard-status').textContent, /診断取得失敗/);
    } finally {
        pending.resolve(Response.json(result));
        await settleRefresh();
    }
});

test('カテゴリの問題・情報を分け、推奨項目の未登録と設定不要を選択した項目だけに絞る', async t => {
    const dom = await setup(t, ['templates/modals/data_quality.php']);
    const { closeDataQuality, getFilteredDataQualityIssues } = await import('../public/js/modals/data-quality-modal.js');
    appState.devices = [1, 2].map(id => normalizeDevice({ id, name: `機器${id}` }));
    const labels = { floor_id: '設置フロア', location: '設置場所', manufacturer: 'メーカー', model: '型番' };
    const recommended = (id, fields) => ({
        code: 'missing_recommended_fields', severity: 'warning', category: 'completeness',
        entity_type: 'device', entity_ids: [id], details: { fields, field_labels: fields.map(field => labels[field]) },
        not_applicable_items: fields.map(field => ({ field, device_id: id, label: labels[field], resource_revision: 1 }))
    });
    const result = {
        ok: true, revision: 1, issues: [
            { code: 'legacy_link_vlan', category: 'integrity', severity: 'warning', entity_type: 'link', entity_ids: [1], details: {} },
            { code: 'maintenance_expiry_missing', category: 'completeness', severity: 'info', entity_type: 'device', entity_ids: [1], details: {} },
            recommended(1, ['floor_id']),
            recommended(2, ['manufacturer', 'location'])
        ], summary: { error: 0, warning: 3, info: 1, total: 4 }, suppressed_count: 3,
        suppressed_issues: [recommended(1, ['model', 'manufacturer']), recommended(2, ['model'])],
        settings: { recommended_device_fields: ['floor_id', 'location', 'manufacturer', 'model'] }
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = url => String(url).includes('action=data_quality') ? Response.json(result) : originalFetch(url);
    openDashboard();
    await settleRefresh();
    await clickTab(dom, 'quality');
    assert.equal(dom.get('dashboard-diagnosis-problems-count').textContent, '3');
    for (const [key, count] of [['error', '0'], ['warning', '3'], ['info', '1'], ['suppressed', '3']]) {
        assert.equal(dom.get(`dashboard-diagnosis-${key}-count`).textContent, count);
    }
    const rows = dom.get('dashboard-diagnosis-categories').querySelectorAll('.dashboard-category-row');
    assert.equal(rows.length, 9);
    const integrity = rows.find(row => row.querySelector('strong').textContent === '参照整合性');
    assert.match(integrity.textContent, /問題 1件.*情報 0件/);
    assert.equal(integrity.querySelectorAll('button').length, 1, '0件の情報は操作できない');
    const completeness = rows.find(row => row.querySelector('strong').textContent === '入力不足');
    assert.equal(completeness.querySelectorAll('button').length, 2);
    const migration = dom.get('dashboard-diagnosis-migration');
    assert.equal(migration.hidden, false);
    assert.equal(migration.querySelectorAll('button').length, 1, '移行保留が0件なら出さない');
    assert.match(migration.textContent, /未移行VLAN 1件/);
    const diagnosisHeader = dom.get('dashboard-diagnosis-title').closest('.dashboard-section-header');
    assert.equal(diagnosisHeader.contains(migration), true);
    assert.equal(diagnosisHeader.contains(dom.get('dashboard-diagnosis-problems-count')), true);
    try {
        const total = dom.get('dashboard-diagnosis-problems-count').closest('button');
        await clickAction(dom, total);
        assert.deepEqual(getFilteredDataQualityIssues().map(issue => issue.code),
            ['legacy_link_vlan', 'missing_recommended_fields', 'missing_recommended_fields']);
        assert.match(dom.get('data-quality-filter-chips').textContent, /エラー・警告/);
        await settleRefresh();
    } finally {
        closeDataQuality();
    }
    openDashboard();
    await settleRefresh();
    await clickTab(dom, 'quality');
    assert.equal(dom.get('dashboard-registration-table').hidden, false);
    const registration = dom.get('dashboard-registration-rows').querySelectorAll('tr');
    assert.deepEqual(registration.map(row => row.querySelector('th').textContent).sort(),
        ['IPアドレス', 'メーカー', '保守期限', '型番', '設置フロア', '設置場所']);
    const registrationHeader = dom.get('dashboard-registration-title').closest('.dashboard-section-header');
    assert.match(registrationHeader.textContent, /設定不要は登録率の分母から除外/);
    assert.deepEqual(registrationHeader.querySelector('.dashboard-registration-legend')
        .querySelectorAll('li').map(item => item.textContent), ['登録済み', '未登録', '設定不要']);
    const model = registration.find(row => row.querySelector('th').textContent === '型番');
    const floor = registration.find(row => row.querySelector('th').textContent === '設置フロア');
    assert.equal(model.querySelector('.dashboard-registration-rate').textContent, '対象なし');
    assert.equal(model.querySelector('.is-suppressed').style.width, '100%');
    assert.equal(floor.querySelector('.dashboard-registration-rate').textContent, '50.0%');
    assert.equal(floor.querySelector('.is-missing').style.width, '50%');
    const manufacturer = registration.find(row => row.querySelector('th').textContent === 'メーカー');
    try {
        await clickAction(dom, manufacturer.querySelector('[aria-label="メーカー：未登録 1台"]'));
        await settleRefresh();
        const list = dom.get('data-quality-issue-list');
        assert.match(list.textContent, /機器2/);
        assert.doesNotMatch(list.textContent, /機器1|設置場所/);
        assert.equal(dom.get('data-quality-filter-summary').textContent, '1件');
        assert.match(dom.get('data-quality-list-title').textContent, /メーカー/);
    } finally {
        closeDataQuality();
    }
    openDashboard();
    await settleRefresh();
    await clickTab(dom, 'quality');
    try {
        await clickAction(dom, dom.get('dashboard-registration-rows').querySelector('[aria-label="メーカー：設定不要 1台"]'));
        assert.equal(dom.get('data-quality-overlay').hidden, false);
        assert.equal(dom.get('data-quality-show-suppressed').checked, true);
        assert.deepEqual(appState.dataQualityCodeFilter, ['missing_recommended_fields']);
        await settleRefresh();
        const list = dom.get('data-quality-issue-list');
        assert.match(list.textContent, /機器1/);
        assert.doesNotMatch(list.textContent, /機器2|型番/);
        assert.equal(dom.get('data-quality-filter-summary').textContent, '設定不要 1項目');
        const clearOnly = dom.get('data-quality-filter-chips')
            .querySelector('[aria-label="「設定不要のみ」の絞り込みを解除"]');
        await clearOnly.dispatch('click');
        assert.match(list.textContent, /機器2/);
        assert.doesNotMatch(list.textContent, /機器1|設置場所/);
        assert.doesNotMatch(list.textContent, /設定不要の項目あり/);
        assert.equal(document.activeElement, dom.get('data-quality-show-suppressed'));
        const clearField = dom.get('data-quality-filter-chips')
            .querySelector('[aria-label="「機器の推奨項目未登録：メーカー」の絞り込みを解除"]');
        await clearField.dispatch('click');
        assert.match(list.textContent, /設置フロア/);
        assert.match(list.textContent, /設置場所/);
        assert.equal(dom.get('data-quality-filter-summary').textContent, '4件');
    } finally {
        closeDataQuality();
    }
});

test('閲覧者はダッシュボードを開けず診断・IP集計も取得しない', async t => {
    const dom = await setup(t);
    window.APP_CONFIG.user.isAdmin = false;
    openDashboard();
    await refreshDashboard();
    assert.equal(dom.get('dashboard-overlay').hidden, true);
    assert.equal(dom.requests(), 0);
});

test('設定不要の保存中に開き直しても、同じrevisionの旧診断を確定表示しない', async t => {
    const dom = await setup(t, ['templates/modals/data_quality.php']);
    const { closeDataQuality, openDataQuality } = await import('../public/js/modals/data-quality-modal.js');
    appState.devices = [normalizeDevice({ id: 1, name: '機器1' })];
    const issue = { code: 'missing_recommended_fields', severity: 'warning', category: 'completeness',
        entity_type: 'device', entity_ids: [1], details: { fields: ['model'], field_labels: ['型番'] },
        not_applicable_items: [{ field: 'model', device_id: 1, label: '型番', resource_revision: 1 }] };
    const before = { ok: true, revision: 1, issues: [issue], suppressed_issues: [], suppressed_count: 0,
        summary: { error: 0, warning: 1, info: 0, total: 1 } };
    const after = { ...before, issues: [], suppressed_issues: [issue], suppressed_count: 1,
        summary: { error: 0, warning: 0, info: 0, total: 0 } };
    const write = Promise.withResolvers();
    const recheck = Promise.withResolvers();
    let saving = false;
    let saved = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async url => {
        if (String(url).includes('action=set_quality_not_applicable')) {
            saving = true;
            await write.promise;
            saved = true;
            return Response.json({ ok: true });
        }
        if (String(url).includes('action=data_quality')) {
            if (saved) await recheck.promise;
            return Response.json(saved ? after : before);
        }
        return originalFetch(url);
    };
    let pendingWrite;
    try {
        openDataQuality();
        await settleRefresh();
        const card = dom.get('data-quality-issue-list').querySelector('article');
        await card.querySelector('.data-quality-expand-btn').dispatch('click');
        pendingWrite = card.querySelector('.data-quality-not-applicable-button').dispatch('click');
        await settleRefresh();
        assert.equal(saving, true);
        closeDataQuality();
        openDashboard();
        await settleRefresh();
        assert.equal(dom.get('dashboard-refresh-btn').disabled, false);
        assert.equal(dom.get('dashboard-quality-panel-total').textContent, '—');
        assert.match(dom.get('dashboard-notices').textContent, /データ品質情報を更新/);
        write.resolve();
        await settleRefresh();
        assert.equal(dom.get('dashboard-quality-panel-total').textContent, '—');
        recheck.resolve();
        await pendingWrite;
        await settleRefresh();
        assert.equal(dom.get('dashboard-quality-panel-total').textContent, '0');
        assert.equal(dom.get('dashboard-diagnosis-suppressed-count').textContent, '1');
    } finally {
        write.resolve();
        recheck.resolve();
        await pendingWrite;
        closeDataQuality();
    }
});

test('更新中もフォーカスはモーダル内に残り、操作しなければ更新ボタンへ戻る', async t => {
    const dom = await setup(t);
    openDashboard();
    await settleRefresh();
    const button = dom.get('dashboard-refresh-btn');
    button.focus();
    const originalFetch = globalThis.fetch;
    const pending = Promise.withResolvers();
    globalThis.fetch = async (...args) => {
        await pending.promise;
        return originalFetch(...args);
    };
    const update = button.dispatch('click');
    try {
        assert.equal(button.disabled, true);
        assert.equal(document.activeElement, dom.get('dashboard-overlay').querySelector('.dashboard-dialog'));
    } finally {
        pending.resolve();
        await update;
    }
    assert.equal(button.disabled, false);
    assert.equal(document.activeElement, button);
});

test('建物行とフロア行は異なる設置条件で機器台帳を開く', async t => {
    const dom = await setup(t, ['templates/modals/ledger.php']);
    const { closeLedger, getFilteredLedgerDevices } = await import('../public/js/modals/ledger-modal.js');
    appState.buildings = [{ id: 1, name: '本館' }, { id: 2, name: '別館' }];
    appState.floors = [
        { id: 10, building_id: 1, name: '1F' }, { id: 11, building_id: 1, name: '2F' },
        { id: 20, building_id: 2, name: '1F' }
    ];
    appState.devices = [10, 11, 20].map((floor_id, index) => normalizeDevice({
        id: index + 1, name: `機器${index + 1}`, floor_id
    }));
    for (const [action, idAttr, id, expected] of [
        ['ledger-building', 'building-id', 1, [1, 2]],
        ['ledger-floor', 'floor-id', 10, [1]]
    ]) {
        openDashboard();
        await settleRefresh();
        await clickTab(dom, 'assets');
        await dom.get('dashboard-breakdown-toggle').dispatch('click');
        if (action === 'ledger-floor') {
            await dom.get('dashboard-facility-list').querySelector('.dashboard-building-toggle').dispatch('click');
        }
        const button = dom.get('dashboard-facility-list')
            .querySelector(`[data-dashboard-action="${action}"][data-${idAttr}="${id}"]`);
        try {
            await clickAction(dom, button);
            assert.equal(dom.get('ledger-overlay').hidden, false);
            assert.deepEqual(getFilteredLedgerDevices().map(device => device.id), expected);
        } finally {
            await closeLedger();
        }
    }
});

test('運用状況の上段は4指標に絞り、保守期限超過から対象機器だけを台帳で開く', async t => {
    const dom = await setup(t, ['templates/modals/ledger.php']);
    const { closeLedger, getFilteredLedgerDevices } = await import('../public/js/modals/ledger-modal.js');
    appState.devices = [
        normalizeDevice({ id: 1, name: '期限切れ', maintenance_expiry: '2000-01-01', status: 'red' }),
        normalizeDevice({ id: 2, name: '有効', maintenance_expiry: '2999-12', status: 'green' })
    ];
    openDashboard();
    await settleRefresh();
    const operations = dom.get('dashboard-panel-operations');
    const labels = operations.querySelector('.dashboard-kpi-bar').querySelectorAll('button')
        .map(button => button.querySelector('.dashboard-kpi-label').textContent.replace('▲', '').trim());
    assert.deepEqual(labels, ['総機器数', '未配置', '入力不足', '保守期限超過']);
    assert.equal(operations.querySelectorAll('[data-dashboard-action="ledger-green"]').length, 1);
    assert.equal(operations.querySelectorAll('[data-dashboard-action="quality-all"]').length, 1);
    const count = dom.get('dashboard-operations-expired-count');
    assert.equal(count.textContent, '1');
    assert.equal(count.closest('button').classList.contains('is-warning'), true);
    try {
        await clickAction(dom, count);
        assert.equal(dom.get('ledger-overlay').hidden, false);
        assert.deepEqual(getFilteredLedgerDevices().map(device => device.id), [1]);
    } finally {
        await closeLedger();
    }
});

test('ネットワークの端点行は件数と割合を並べ、行全体から該当診断へ進む', async t => {
    const dom = await setup(t, ['templates/modals/data_quality.php']);
    const { closeDataQuality } = await import('../public/js/modals/data-quality-modal.js');
    appState.devices = [{ id: 1 }, { id: 2 }];
    appState.links = [{ id: 1, from_id: 1, to_id: 2, from_port_id: null, to_port_id: null }];
    appState.devicePorts = [{ id: 1, device_id: 1 }];
    const issue = { code: 'link_ports_missing', severity: 'info', category: 'completeness',
        entity_type: 'link', entity_ids: [1] };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = url => String(url).includes('action=data_quality') ? Response.json({
        ok: true, revision: 1, issues: [{ ...issue, details: { missing_endpoints: { to: { device_id: 2 } } } }],
        suppressed_issues: [{ ...issue, details: { missing_endpoints: { from: { device_id: 1 } } },
            not_applicable_items: [{ field: 'from_port', device_id: 1, label: '始点ポート', resource_revision: 1 }] }],
        suppressed_count: 1
    }) : originalFetch(url);
    openDashboard();
    await settleRefresh();
    await clickTab(dom, 'network');
    assert.equal(dom.get('dashboard-network-port-count').textContent, '1');
    assert.equal(dom.get('dashboard-network-link-count').textContent, '1');
    assert.equal(dom.get('dashboard-network-device-count').textContent, '1');
    const endpoints = dom.get('dashboard-network-endpoints').querySelectorAll('.dashboard-network-row');
    assert.deepEqual(endpoints.map(row => [
        row.children[0].textContent, row.querySelector('strong').textContent, row.querySelector('small').textContent
    ]), [['指定済み', '0端点', '0.0%'], ['未指定', '1端点', '50.0%'], ['設定不要', '1端点', '50.0%']]);
    assert.equal(endpoints[0].tagName, 'DIV');
    assert.equal(endpoints[1].tagName, 'BUTTON');
    assert.equal(endpoints[2].tagName, 'BUTTON');
    try {
        await clickAction(dom, endpoints[2].querySelector('small'));
        assert.equal(dom.get('data-quality-overlay').hidden, false);
        assert.deepEqual(appState.dataQualityCodeFilter, ['link_ports_missing']);
        assert.equal(dom.get('data-quality-show-suppressed').checked, true);
        await settleRefresh();
    } finally {
        closeDataQuality();
    }
});

test('読み込み中のIP管理ボタン無効化・非JSON401処理・台帳遷移後のフォーカス復帰', async t => {
    const dom = await setup(t, ['templates/modals/ledger.php']);
    const { closeLedger } = await import('../public/js/modals/ledger-modal.js');
    const opener = dom.add('button', 'dashboard-opener-btn');
    opener.tabIndex = 0;
    opener.focus();

    let releaseSummary;
    const summaryGate = new Promise(resolve => { releaseSummary = resolve; });
    const origFetch = globalThis.fetch;
    let authExpiredCalled = 0;
    const origHandleAuth = window.handleAuthExpired;
    window.handleAuthExpired = () => { authExpiredCalled++; };

    try {
        globalThis.fetch = async url => {
            if (String(url).includes('action=load_ip_management_summary')) {
                await summaryGate;
                return new Response('<html>401 Unauthorized</html>', { status: 401, headers: { 'Content-Type': 'text/html' } });
            }
            return origFetch(url);
        };

        openDashboard();
        const ipBtn = dom.get('dashboard-overlay').querySelector('[data-dashboard-action="ip-management"]');
        assert.equal(ipBtn.disabled, true, '読み込み中はIP管理ボタンを無効化');
        releaseSummary();
        await settleRefresh();
        assert.equal(authExpiredCalled, 1, '非JSONの401応答でもhandleAuthExpiredを呼び出す');
        assert.equal(ipBtn.disabled, false);

        await clickAction(dom, dom.get('dashboard-devices-count').closest('button'));
        assert.equal(dom.get('ledger-overlay').hidden, false);
        await closeLedger();
        assert.equal(document.activeElement, opener, '台帳閉鎖後にダッシュボード起動元へフォーカスを戻す');
    } finally {
        window.handleAuthExpired = origHandleAuth;
    }
});

test('ダッシュボードから品質診断と図面管理を経由しても元の起点へ戻る', async t => {
    const dom = await setup(t, ['templates/modals/data_quality.php']);
    const { openDashboardDataQuality } = await import('../public/js/modals/dashboard-modal.js');
    const { openDataQualityFloorPlan, closeFloorPlanManager } = await import('../public/js/modals/floor-plan-modal.js');
    const oldTrigger = dom.add('button', 'data-quality-btn');
    oldTrigger.focus();
    const quality = await import('../public/js/modals/data-quality-modal.js');
    quality.openDataQuality();
    quality.closeDataQuality();
    await settleRefresh();

    const trigger = dom.add('button', 'dashboard-btn');
    trigger.focus();
    const floorOverlay = dom.add('div', 'floor-plan-manager-overlay');
    floorOverlay.hidden = true;
    dom.add('button', 'floor-plan-upload-btn', floorOverlay);
    appState.views = [normalizeView({ id: 1, view_type: 'floor', name: '対象フロア' })];
    appState.currentViewId = 1;

    try {
        openDashboard();
        await settleRefresh();
        openDashboardDataQuality();
        assert.equal(getTopModalContainer(), dom.get('data-quality-overlay'));
        await openDataQualityFloorPlan(1);
        assert.equal(getTopModalContainer(), floorOverlay);
        closeFloorPlanManager();
        assert.equal(document.activeElement, trigger);
    } finally {
        closeFloorPlanManager();
        quality.closeDataQuality();
        await settleRefresh();
    }
});

test('ダッシュボードの未確認はcheckingも含めて集計し台帳遷移先にも表示する', async t => {
    const dom = await setup(t, ['templates/modals/ledger.php']);
    const { closeLedger } = await import('../public/js/modals/ledger-modal.js');
    appState.devices = [
        normalizeDevice({ id: 1, name: 'OK機器', status: 'green' }),
        normalizeDevice({ id: 2, name: 'NG機器', status: 'red' }),
        normalizeDevice({ id: 3, name: '未確認機器', status: 'unknown' }),
        normalizeDevice({ id: 4, name: '確認中機器', status: 'checking' })
    ];
    openDashboard();
    await settleRefresh();
    assert.equal(dom.get('dashboard-monitoring-unknown-count').textContent, '2台');

    await clickAction(dom, dom.get('dashboard-overlay').querySelector('[data-dashboard-action="ledger-unknown"]'));
    const shownIds = dom.get('ledger-table-body').querySelectorAll('tr[data-device-id]').map(row => Number(row.dataset.deviceId));
    assert.deepEqual(shownIds, [3, 4]);
    await closeLedger();
});
