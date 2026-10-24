import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installWorkspaceDom, WorkspaceElement } from './helpers/workspace-dom.mjs';
import { appState } from '../public/js/core/state.js';
import {
    closeDashboard, getDashboardFocusableElements, hideDashboardForNavigation, openDashboard, refreshDashboard
} from '../public/js/modals/dashboard-modal.js';

import { getTopModalContainer } from '../public/js/core/modal-focus.js';
async function setup(t) {
    const keys = ['window', 'document', 'HTMLElement', 'HTMLButtonElement', 'Element', 'fetch'];
    const originals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const state = { ...appState };
    const dom = installWorkspaceDom({ templates: ['templates/modals/dashboard.php'] });
    globalThis.HTMLButtonElement = WorkspaceElement;
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
        devices: [], placements: [], dataRevision: 1, dataQualityResult: null,
        isDashboardNavigating: false, appStatus: { dirty: false }
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
