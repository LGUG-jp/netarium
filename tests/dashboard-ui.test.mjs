import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installWorkspaceDom, WorkspaceElement } from './helpers/workspace-dom.mjs';
import { appState, normalizeDevice, normalizeView } from '../public/js/core/state.js';
import {
    closeDashboard, getDashboardFocusableElements, hideDashboardForNavigation, openDashboard, refreshDashboard,
    renderDashboard
} from '../public/js/modals/dashboard-modal.js';

import { getTopModalContainer } from '../public/js/core/modal-focus.js';
async function setup(t, templates = []) {
    const keys = ['window', 'document', 'HTMLElement', 'HTMLButtonElement', 'Element', 'fetch', 'HTMLInputElement', 'HTMLTextAreaElement'];
    const originals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const state = { ...appState };
    const dom = installWorkspaceDom({ templates: ['templates/modals/dashboard.php', ...templates] });
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
    globalThis.fetch = async () => {
        requests++;
        return { ok: true, json: async () => ({ ok: true, revision: 1, issues: [], summary: { error: 0, warning: 0, info: 0, total: 0 } }) };
    };
    Object.assign(appState, {
        views: [], rackMounts: [], rackSettings: [], devices: [], placements: [], dataRevision: 1, dataQualityResult: null,
        currentViewId: null, editingDeviceId: null, editingLinkId: null, isPinging: false,
        isDashboardNavigating: false, appStatus: { dirty: false, state: 'saved' }
    });
    document.readyState = 'loading';
    const { registerStaticListeners } = await import('../public/js/main.js');
    registerStaticListeners();
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

function assertSelected(dom, name) {
    for (const candidate of ['operations', 'assets']) {
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
    for (const category of ['expired', 'within1Year', 'within2Years']) {
        const count = dom.get(`dashboard-maintenance-${category}-count`);
        assert.equal(count.textContent, '0');
        assert.equal(count.closest('button').disabled, false);
    }
    const focusable = getDashboardFocusableElements();
    assert.ok(focusable.includes(dom.get('dashboard-tab-assets')));
    assert.ok(!focusable.includes(dom.get('dashboard-tab-operations')));
    assert.ok(!focusable.includes(dom.get('dashboard-devices-count').closest('button')));
    assert.ok(focusable.includes(dom.get('dashboard-maintenance-expired-count').closest('button')));
    appState.devices = [{ id: 1, name: '保守切れ機器', maintenance_expiry: '2000-01-01', status: 'green' }];
    await refreshDashboard();
    assert.equal(dom.requests(), before + 1);
    assertSelected(dom, 'assets');
    assert.equal(dom.get('dashboard-maintenance-expired-count').textContent, '1');
    closeDashboard();
    openDashboard();
    await settleRefresh();
    assertSelected(dom, 'operations');
    hideDashboardForNavigation();
    assert.equal(getTopModalContainer(), null, '台帳への遷移で非表示のダッシュボードをモーダルスタックに残さない');
});

test('主要期限が0件でも2年超と期限未登録の内訳を表示し、更新後の件数に追従する', async t => {
    const dom = await setup(t);
    appState.devices = Array.from({ length: 10 }, (_, index) => ({
        id: index + 1, name: `補足確認${index + 1}`,
        maintenance_expiry: index < 3 ? '2999-12' : ''
    }));
    openDashboard();
    await settleRefresh();
    await clickTab(dom, 'assets');
    for (const category of ['expired', 'within1Year', 'within2Years']) {
        assert.equal(dom.get(`dashboard-maintenance-${category}-count`).textContent, '0');
    }
    assert.equal(dom.get('dashboard-maintenance-beyond2Years-count').textContent, '3');
    assert.equal(dom.get('dashboard-maintenance-unset-count').textContent, '7');
    assert.equal(dom.get('dashboard-maintenance-unset-count').closest('button'), null);
    appState.devices[3].maintenance_expiry = '2999-12-31';
    await refreshDashboard();
    assertSelected(dom, 'assets');
    assert.equal(dom.get('dashboard-maintenance-beyond2Years-count').textContent, '4');
    assert.equal(dom.get('dashboard-maintenance-unset-count').textContent, '6');
});

test('左右・Home・Endで選択とフォーカスを移し、非選択タブをTab巡回から外す', async t => {
    const dom = await setup(t);
    openDashboard();
    await settleRefresh();
    for (const [from, key, expected] of [
        ['operations', 'ArrowRight', 'assets'],
        ['assets', 'ArrowRight', 'operations'],
        ['operations', 'ArrowLeft', 'assets'],
        ['assets', 'Home', 'operations'],
        ['operations', 'End', 'assets']
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
    appState.devices = Array.from({ length: 8 }, (_, index) => ({
        id: index + 1, facility: `合成施設${index % 7}`, floor: '1F',
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
        dom.get('dashboard-assets-types-count').textContent
    ];
    assert.deepEqual(summary(), ['8', '2']);
    assert.equal(details.hidden, true);
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    assert.ok(!getDashboardFocusableElements().includes(dom.get('dashboard-type-list').querySelector('button')));

    await toggle.dispatch('click');
    assert.equal(details.hidden, false);
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(rackList.hidden, true);
    const facilities = dom.get('dashboard-facility-list');
    assert.equal(facilities.querySelectorAll('.dashboard-breakdown-item').length, 5);
    assert.equal(facilities.querySelector('.dashboard-breakdown-label').textContent, '合成施設0');
    assert.equal(facilities.querySelector('.dashboard-breakdown-bar').style.width, '25%');
    await facilities.querySelector('.dashboard-breakdown-toggle-btn').dispatch('click');
    assert.equal(facilities.querySelectorAll('.dashboard-breakdown-item').length, 7);
    assert.equal(details.hidden, false);

    await dom.get('dashboard-racks-toggle').dispatch('click');
    await toggle.dispatch('click');
    assert.equal(details.hidden, true);
    assert.equal(rackList.hidden, false);
    appState.devices.push({ id: 9, type: 'router', facility: '追加施設', floor: '2F' });
    await refreshDashboard();
    assert.deepEqual(summary(), ['9', '3']);
    assert.equal(details.hidden, true);
    assert.equal(rackList.hidden, false);
    await toggle.dispatch('click');
    assert.equal(facilities.querySelectorAll('.dashboard-breakdown-item').length, 8);
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
    assert.equal(dom.get('dashboard-floor-list').querySelectorAll('button').length, 0);
    assert.equal(dom.get('dashboard-type-list').querySelectorAll('button').length, 0);
});

test('ラック一覧だけを折り畳み、再描画と更新に追従し、開き直すと閉じる', async t => {
    const dom = await setup(t);
    appState.views = [
        { id: 1, view_type: 'rack', name: '合成ラック', facility: '合成施設', floor: '2F' },
        { id: 2, view_type: 'rack', name: '場所未登録' },
        { id: 3, view_type: 'floor', name: '通常フロア' }
    ];
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
    assert.equal(list.querySelectorAll('button')[1].querySelector('small'), null);
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
