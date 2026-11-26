import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import { setImmediate as settle } from 'node:timers/promises';
import { installWorkspaceDom } from './helpers/workspace-dom.mjs';
import { placementState } from '../public/js/ui/placement-mode.js';

// ブラウザ環境の軽量モック
if (typeof globalThis.document === 'undefined') {
    globalThis.document = {
        getElementById: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
        createElement: (tag) => ({
            tagName: tag.toUpperCase(),
            className: '',
            dataset: {},
            classList: {
                add() {},
                remove() {},
                toggle() {}
            },
            setAttribute() {},
            getAttribute() { return null; },
            appendChild() {},
            append() {},
            replaceChildren() {},
            addEventListener() {},
            style: {}
        })
    };
}
if (typeof globalThis.window === 'undefined') {
    globalThis.window = {
        requestAnimationFrame: (cb) => cb(),
        setTimeout: (cb) => cb(),
        APP_CONFIG: {
            user: { isAdmin: true }
        }
    };
} else if (!globalThis.window.APP_CONFIG) {
    globalThis.window.APP_CONFIG = {
        user: { isAdmin: true }
    };
}

import {
    expandedIssueKeys,
    getIssueKey,
    getDataQualityPrimaryAction,
    getDataQualitySeverityIcon,
    getDataQualityTargetField,
    getDataQualityTargetSummary,
    getDataQualityDetailLines,
    normalizeDataQualityCodeFilter,
    openDataQualityDeviceInSheet,
    createDataQualityIssueElement,
    closeDataQuality,
    openDataQuality,
    openDataQualityView,
    refreshDataQuality,
    refreshDataQualityAfterSheet,
    reloadDataQualityResult,
    createDataQualityIssueActions,
    renderDataQuality,
    selectDataQualitySuppressed
} from '../public/js/modals/data-quality-modal.js';

import { eventBus } from '../public/js/core/event-bus.js';
import { getFocusableElements, getTopModalContainer, initModalFocusTrap, registerModalClose, registerModalOpen } from '../public/js/core/modal-focus.js';
import { closeLedgerDetailPane } from '../public/js/modals/ledger-modal.js';
import { closeWorkspaceNavigation } from '../public/js/ui/workspace-navigation.js';
import { closeBuildingView, getOpenBuildingId, hasBuildingViewDraft, openBuildingView } from '../public/js/ui/building-view.js';

import { appState, normalizeDevice } from '../public/js/core/state.js';
import { DASHBOARD_QUALITY_CODES } from '../public/js/core/constants.js';
import { buildDashboardModel } from '../public/js/core/dashboard-model.js';
import { resetResourceBaseline } from '../public/js/core/resource-save.js';
import { clearPendingSave } from '../public/js/core/save-queue.js';

beforeEach(() => {
    appState.devices = [
        { id: 1, name: 'Core-SW-01', type: 'switch', ip: '192.168.1.1' },
        { id: 2, name: 'Edge-SW-02', type: 'switch', ip: '192.168.1.2' },
        { id: 3, name: 'AP-01', type: 'ap', ip: '192.168.1.10' }
    ];
    appState.views = [
        { id: 10, name: '1F フロア図', view_type: 'floor' },
        { id: 20, name: '論理構成図', view_type: 'logical' }
    ];
    appState.placements = [
        { id: 100, device_id: 1, view_id: 10, x: 100, y: 100 }
    ];
    appState.links = [
        { id: 50, from_id: 1, to_id: 2, resource_revision: 1 }
    ];
    appState.devicePorts = [];
    appState.viewLinkRoutes = [];
    globalThis.window.APP_CONFIG = { user: { isAdmin: true } };
    expandedIssueKeys.clear();
});

test('getDataQualitySeverityIcon: 各重要度に対応する記号を返す', () => {
    assert.equal(getDataQualitySeverityIcon('error'), '●');
    assert.equal(getDataQualitySeverityIcon('warning'), '▲');
    assert.equal(getDataQualitySeverityIcon('info'), 'ℹ');
    assert.equal(getDataQualitySeverityIcon('unknown'), '');
    assert.equal(getDataQualitySeverityIcon(null), '');
});

test('getIssueKey: 問題のプロパティから一意で安定したキーを生成する', () => {
    const issue1 = {
        code: 'unplaced_device',
        entity_type: 'device',
        entity_ids: [1, 2],
        message: '未配置機器があります'
    };
    const issue2 = {
        code: 'unplaced_device',
        entity_type: 'device',
        entity_ids: [1, 2],
        message: '未配置機器があります'
    };
    const issue3 = {
        code: 'unplaced_device',
        entity_type: 'device',
        entity_ids: [1, 3],
        message: '未配置機器があります'
    };

    assert.equal(getIssueKey(issue1), getIssueKey(issue2));
    assert.notEqual(getIssueKey(issue1), getIssueKey(issue3));
});

test('expandedIssueKeys: 展開状態の登録と解除を管理できる', () => {
    const issue = {
        code: 'missing_required_fields',
        entity_type: 'device',
        entity_ids: [1],
        message: '必須項目が未入力です'
    };
    const key = getIssueKey(issue);

    assert.equal(expandedIssueKeys.has(key), false);
    expandedIssueKeys.add(key);
    assert.equal(expandedIssueKeys.has(key), true);
    expandedIssueKeys.delete(key);
    assert.equal(expandedIssueKeys.has(key), false);
});

test('getDataQualityTargetSummary: 対象機器・ビューを簡潔に要約する', () => {
    // 単一機器
    const singleDeviceIssue = {
        entity_type: 'device',
        entity_ids: [1]
    };
    assert.ok(getDataQualityTargetSummary(singleDeviceIssue).includes('Core-SW-01'));

    // 複数機器
    const multiDeviceIssue = {
        entity_type: 'device',
        entity_ids: [1, 2, 3]
    };
    const multiSummary = getDataQualityTargetSummary(multiDeviceIssue);
    assert.ok(multiSummary.includes('3台'));
    assert.ok(multiSummary.includes('Core-SW-01'));

    // ビュー
    const viewIssue = {
        entity_type: 'view',
        entity_ids: [10]
    };
    assert.ok(getDataQualityTargetSummary(viewIssue).includes('1F フロア図'));

});

function prepareNavigation(isAdmin, ...templates) {
    const dom = installWorkspaceDom({
        templates: ['templates/components/property_panel.php', 'templates/components/link_panel.php', ...templates]
    });
    window.APP_CONFIG.user.isAdmin = isAdmin;
    appState.currentViewId = 20;
    appState.editingDeviceId = null;
    appState.editingLinkId = null;
    appState.selectedPlacementIds.clear();
    appState.appStatus.dirty = false;
    appState.canvas = null;
    placementState.active = false;
    placementState.queue = [];
    return dom;
}

test('未配置診断は管理者だけ配置モードへ進み、閲覧者は対象台帳へ進む', async () => {
    const issue = { code: 'unplaced_device', entity_type: 'device', entity_ids: [2] };
    for (const isAdmin of [true, false]) {
        prepareNavigation(isAdmin);
        const ledgerTargets = [];
        const unsubscribe = eventBus.on('ledger:open-data-quality-device', id => ledgerTargets.push(id));
        try {
            await getDataQualityPrimaryAction(issue).action();
            assert.equal(placementState.active, isAdmin);
            assert.deepEqual(placementState.queue.map(device => device.id), isAdmin ? [2] : []);
            assert.deepEqual(ledgerTargets, isAdmin ? [] : [2]);
        } finally {
            unsubscribe();
            placementState.active = false;
        }
    }
});

test('図面未登録診断は管理者だけ登録画面へ進み、閲覧者は対象ビューを表示する', async () => {
    const issue = { code: 'floor_view_without_plan', entity_type: 'view', entity_ids: [10] };
    for (const isAdmin of [true, false]) {
        prepareNavigation(isAdmin);
        const registrationTargets = [];
        const unsubscribe = eventBus.on('floor-plan:open-data-quality', id => registrationTargets.push(id));
        try {
            await getDataQualityPrimaryAction(issue).action();
            assert.deepEqual(registrationTargets, isAdmin ? [10] : []);
            assert.equal(appState.currentViewId, isAdmin ? 20 : 10);
            assert.equal(placementState.active, false);
        } finally {
            unsubscribe();
        }
    }
});

test('重複接続とポート不整合は両権限で共通接続を表示できるビューへ進む', async () => {
    appState.placements.push({ id: 200, device_id: 2, view_id: 10, x: 400, y: 100 });
    const issues = [
        { code: 'duplicate_link', details: { link_ids: [50, 51] } },
        { code: 'invalid_link_port', details: { link_id: 50, device_id: 1, port_id: 9 } },
        { code: 'duplicate_port_use', details: { link_ids: [50, 51], port_id: 9 } }
    ];
    for (const { code, details } of issues) {
        for (const isAdmin of [true, false]) {
            const dom = prepareNavigation(isAdmin);
            await getDataQualityPrimaryAction({
                code, severity: 'error', category: 'integrity',
                entity_type: 'link', entity_ids: details.link_ids ?? [50], details
            }).action();
            assert.equal(appState.currentViewId, 10);
            assert.equal(appState.editingLinkId, 50);
            assert.equal(dom.get('link-panel').hidden, false);
            assert.equal(dom.get('lp-label').readOnly, !isAdmin);
            assert.equal(appState.editingDeviceId, null);
        }
    }
});

test('欠落した始点・終点の診断は共通接続IDを表示し、存在しない配置へ移動しない', async () => {
    for (const side of ['from', 'to']) {
        appState.links[0] = { id: 50, from_id: 1, to_id: 2, [`${side}_id`]: 999, resource_revision: 1 };
        const issue = {
            code: `orphan_link_${side}_device`, severity: 'error', category: 'integrity',
            entity_type: 'link', entity_ids: [50], details: { link_id: 50, device_id: 999 }
        };
        for (const isAdmin of [true, false]) {
            const dom = prepareNavigation(isAdmin);
            assert.match(getDataQualityTargetSummary(issue), /対象接続.*50/);
            await getDataQualityPrimaryAction(issue).action();
            assert.equal(appState.currentViewId, 20);
            assert.equal(appState.editingLinkId, null);
            assert.equal(dom.get('link-panel').hidden, true);
        }
    }
});

test('移行保留の診断から元ビューの接続一覧を開き、通常の接続編集は開かない', async () => {
    const issue = {
        code: 'legacy_link_conflict', severity: 'warning', category: 'integrity',
        entity_type: 'view', entity_ids: [10],
        message: '移行保留の旧接続があります。確認が必要です',
        details: { legacy_link_id: 91, view_id: 10, device_a_id: 1, device_b_id: 2, reason: 'port_conflict' }
    };
    for (const isAdmin of [true, false]) {
        const dom = prepareNavigation(isAdmin);
        const nav = dom.add('aside', 'workspace-nav-panel');
        nav.hidden = true;
        await getDataQualityPrimaryAction(issue).action();
        assert.equal(appState.currentViewId, 10);
        assert.equal(nav.hidden, false);
        assert.equal(appState.editingLinkId, null);
        assert.equal(dom.get('link-panel').hidden, true);
        const card = createDataQualityIssueElement(issue);
        assert.ok(card.classList.contains('data-quality-issue-warning'));
        assert.match(card.textContent, /移行保留の旧接続/);
        assert.match(getDataQualityTargetSummary(issue), /1F フロア図/);
    }
});

const pendingLegacyVlanIssue = {
    code: 'legacy_link_vlan', severity: 'warning', category: 'integrity',
    entity_type: 'link', entity_ids: [50],
    message: '未移行VLANは、再設定または削除してください。',
    details: { link_id: 50, device_ids: [1, 2], vlan: 'access 10' }
};

test('未移行VLANの診断は片端の配置があるビューの接続一覧で要確認欄を開く', async () => {
    appState.legacyLinkVlans = [{ link_id: 50, vlan: 'access 10' }];
    try {
        for (const isAdmin of [true, false]) {
            for (const target of ['floor', 'current', 'rack-shelf']) {
                const dom = prepareNavigation(isAdmin, 'templates/components/tool_palette.php', 'templates/modals/data_quality.php');
                appState.views = [
                    { id: 10, name: 'フロア図', view_type: 'floor' },
                    { id: 20, name: '論理構成図', view_type: 'logical' },
                    { id: 30, name: 'ラック', view_type: 'rack' }
                ];
                appState.placements = target === 'rack-shelf' ? [] : [
                    { id: 100, device_id: 1, view_id: 10, x: 100, y: 100 },
                    ...(target === 'current' ? [{ id: 200, device_id: 2, view_id: 20, x: 200, y: 100 }] : [])
                ];
                appState.rackShelves = target === 'rack-shelf' ? [{ id: 301, view_id: 30 }] : [];
                appState.rackShelfDevices = target === 'rack-shelf' ? [{ shelf_id: 301, device_id: 2 }] : [];
                const overlay = dom.get('data-quality-overlay');
                overlay.hidden = false;
                registerModalOpen('data_quality', overlay);
                try {
                    await getDataQualityPrimaryAction(pendingLegacyVlanIssue).action();
                    assert.equal(appState.currentViewId, { floor: 10, current: 20, 'rack-shelf': 30 }[target]);
                    assert.equal(overlay.hidden, true);
                    assert.equal(getTopModalContainer(), null);
                    assert.equal(dom.get('workspace-nav-panel').hidden, false);
                    assert.equal(dom.get('workspace-nav-tab-links').getAttribute('aria-selected'), 'true');
                    const review = dom.get('workspace-nav-legacy');
                    assert.equal(review.open, true);
                    assert.equal(document.activeElement, review.children[0]);
                    assert.match(review.textContent, /access 10/);
                    assert.equal(dom.get('link-panel').hidden, true);
                } finally {
                    registerModalClose('data_quality', { restoreFocus: false });
                    closeWorkspaceNavigation();
                }
            }
        }
    } finally {
        appState.legacyLinkVlans = [];
        appState.rackShelves = [];
        appState.rackShelfDevices = [];
    }
});

test('両端が未配置の未移行VLANは個票で該当する接続行を展開する', async () => {
    appState.placements = [];
    appState.devices = appState.devices.map(normalizeDevice);
    appState.legacyLinkVlans = [{ link_id: 50, vlan: 'access 10' }];
    try {
        for (const isAdmin of [true, false]) {
            const dom = prepareNavigation(isAdmin, 'templates/modals/ledger.php', 'templates/modals/data_quality.php');
            const overlay = dom.get('data-quality-overlay');
            overlay.hidden = false;
            const card = createDataQualityIssueElement(pendingLegacyVlanIssue);
            overlay.appendChild(card);
            assert.match(getDataQualityTargetSummary(pendingLegacyVlanIssue), /Core-SW-01.*Edge-SW-02/);
            assert.match(card.textContent, /未移行VLAN：access 10/);
            assert.equal(card.querySelectorAll('.data-quality-action-button').length, 1);
            registerModalOpen('data_quality', overlay);
            const trigger = card.querySelector('.data-quality-action-primary');
            trigger.focus();
            try {
                await getDataQualityPrimaryAction(pendingLegacyVlanIssue).action();
                assert.equal(appState.currentViewId, 20);
                assert.equal(overlay.hidden, false);
                assert.equal(dom.get('ledger-overlay').hidden, true);
                assert.equal(getTopModalContainer(), dom.get('ledger-device-sheet-overlay'));
                assert.equal(dom.get('ledger-sheet-body').dataset.deviceId, '1');
                assert.equal(dom.get('ledger-sheet-body').dataset.activeTab, 'ports');
                const editor = dom.get('ledger-port-editor');
                assert.match(editor.textContent, /未移行VLAN：access 10/);
                assert.equal(editor.contains(document.activeElement), true);
                await closeLedgerDetailPane();
                assert.equal(document.activeElement, trigger);
            } finally {
                await closeLedgerDetailPane();
                registerModalClose('data_quality', { restoreFocus: false });
            }
        }
    } finally {
        appState.legacyLinkVlans = [];
    }
});

test('配置不整合は両権限で指定ビューの対象機器を選択する', async () => {
    for (const isAdmin of [true, false]) {
        const dom = prepareNavigation(isAdmin);
        appState.currentViewId = 10;
        appState.canvas = dom.add('div', 'canvas');
        await getDataQualityPrimaryAction({
            code: 'floor_mismatch', entity_type: 'device', entity_ids: [1],
            details: { view_id: 10 }
        }).action();
        assert.equal(appState.currentViewId, 10);
        assert.deepEqual([...appState.selectedPlacementIds], [100]);
        assert.equal(appState.editingDeviceId, 1);
        assert.equal(dom.get('p-name').readOnly, !isAdmin);
    }
});

test('ラックの所属フロア不整合はラックと配置先を表示し、物理ビューだけを開く', async t => {
    const issue = {
        code: 'rack_floor_mismatch', severity: 'warning', category: 'placement',
        entity_type: 'view', entity_ids: [1],
        message: 'ラックと配置先ビューの所属フロアが異なります',
        details: {
            view_id: 10, rack_view_name: 'ラックA', view_name: '1F フロア図',
            rack_floor_id: 11, view_floor_id: 12, rack_path: '本庁舎 / 1F', view_path: '別館 / 1F'
        }
    };
    appState.views.push({ id: 1, name: 'ラックA', view_type: 'rack' });
    assert.equal(getDataQualityTargetSummary(issue), '対象ラック: ラックA（ID 1）');
    assert.deepEqual(getDataQualityDetailLines(issue), [
        'ラックの所属フロア: 本庁舎 / 1F',
        '配置先ビュー: 1F フロア図（ID 10）',
        '配置先ビューの所属フロア: 別館 / 1F'
    ]);
    assert.equal(getDataQualityDetailLines({
        ...issue, details: { ...issue.details, view_floor_id: null, view_path: null }
    })[2], '配置先ビューの所属フロア: 未設定');
    assert.equal(getDataQualityPrimaryAction({ ...issue, details: { view_id: 99 } }), null);
    assert.equal(getDataQualityPrimaryAction({ ...issue, details: { view_id: 20 } }), null);

    const previousConfirm = globalThis.confirm;
    t.after(() => {
        globalThis.confirm = previousConfirm;
        appState.appStatus.dirty = false;
    });
    for (const isAdmin of [true, false]) {
        const dom = prepareNavigation(isAdmin);
        const overlay = dom.add('div', 'data-quality-overlay');
        const card = createDataQualityIssueElement(issue);
        const action = getDataQualityPrimaryAction(issue);
        assert.equal(card.querySelector('.data-quality-action-primary').textContent, '配置先ビューを開く');
        assert.equal(card.querySelector('.data-quality-target-row'), null);

        globalThis.confirm = () => false;
        appState.appStatus.dirty = true;
        await action.action();
        assert.equal(appState.currentViewId, 20);
        assert.equal(overlay.hidden, false);

        appState.appStatus.dirty = false;
        await action.action();
        assert.equal(appState.currentViewId, 10);
        assert.equal(overlay.hidden, true);
        assert.equal(appState.editingDeviceId, null);
        assert.equal(placementState.active, false);
    }
});

test('書式・保守・必須/推奨項目・機器重複の主操作で、個票の該当欄を指定する', () => {
    for (const [issue, field] of [
        [{ code: 'nonstandard_mac', category: 'format' }, 'mac_address'],
        [{ code: 'invalid_management_scheme', category: 'format' }, 'management_scheme'],
        [{ code: 'management_port_without_scheme', category: 'format' }, 'management_port'],
        [{ code: 'invalid_management_port', category: 'format' }, 'management_port'],
        [{ code: 'invalid_install_date', category: 'format' }, 'install_date'],
        [{ code: 'invalid_maintenance_expiry_date', category: 'format' }, 'maintenance_expiry'],
        ...['maintenance_expired', 'maintenance_expiry_approaching', 'maintenance_expiry_before_install']
            .map(code => [{ code, category: 'maintenance' }, 'maintenance_expiry']),
        [{ code: 'missing_required_fields', details: { fields: ['model', 'facility'] } }, 'model'],
        [{ code: 'missing_recommended_fields', details: { fields: ['facility'] } }, 'facility'],
        [{ code: 'duplicate_ip', category: 'duplicate', details: { field: 'ip' } }, 'ip']
    ]) {
        for (const isAdmin of [true, false]) {
            prepareNavigation(isAdmin);
            const targets = [];
            const unsubscribe = eventBus.on('ledger:open-device-sheet', target => targets.push(target));
            try {
                getDataQualityPrimaryAction({ ...issue, entity_type: 'device', entity_ids: [3] }).action();
                assert.deepEqual(targets, [{ deviceId: 3, field }], issue.code);
                assert.equal(appState.editingLinkId, null);
                assert.equal(placementState.active, false);
            } finally {
                unsubscribe();
            }
        }
    }
});

test('監視診断は両権限で対象機器詳細を開き、閲覧者の編集を無効にする', async () => {
    for (const isAdmin of [true, false]) {
        const dom = prepareNavigation(isAdmin);
        await getDataQualityPrimaryAction({
            code: 'stale_monitor', category: 'monitoring', entity_type: 'device', entity_ids: [3]
        }).action();
        assert.equal(appState.editingDeviceId, 3);
        assert.equal(dom.get('panel').hidden, false);
        assert.equal(dom.get('p-name').readOnly, !isAdmin);
        assert.equal(appState.editingLinkId, null);
        assert.equal(placementState.active, false);
    }
});

test('normalizeDataQualityCodeFilter: 単一コードを配列にし、重複を除く', () => {
    assert.deepEqual(normalizeDataQualityCodeFilter('unplaced_device'), ['unplaced_device']);
    assert.deepEqual(normalizeDataQualityCodeFilter(['a', 'b', 'a']), ['a', 'b']);
});

test('openDataQualityDeviceInSheet: eventBus経由で個票表示イベントを発火する', () => {
    let emittedPayload = null;
    const unsubscribe = eventBus.on('ledger:open-device-sheet', payload => {
        emittedPayload = payload;
    });

    openDataQualityDeviceInSheet(1, 'facility');
    assert.ok(emittedPayload);
    assert.equal(emittedPayload.deviceId, 1);
    assert.equal(emittedPayload.field, 'facility');

    unsubscribe();
});

test('getDataQualityPrimaryAction: 機器情報修正アクション実行時にopenDataQualityDeviceInSheetが呼ばれる', () => {
    let emittedPayload = null;
    const unsubscribe = eventBus.on('ledger:open-device-sheet', payload => {
        emittedPayload = payload;
    });

    const reqIssue = {
        code: DASHBOARD_QUALITY_CODES.missingRequiredFields,
        entity_type: 'device',
        entity_ids: [2],
        details: { field: 'name' }
    };
    globalThis.window.APP_CONFIG.user.isAdmin = true;
    const action = getDataQualityPrimaryAction(reqIssue);
    assert.ok(action);
    action.action();

    assert.ok(emittedPayload);
    assert.equal(emittedPayload.deviceId, 2);
    assert.equal(emittedPayload.field, 'name');

    unsubscribe();
});

test('getDataQualityTargetField: details.fields配列またはdetails.fieldから先頭フィールド名を取得する', () => {
    // 配列の場合（APIの実際のレスポンス形式）
    assert.equal(
        getDataQualityTargetField({
            details: { fields: ['facility', 'floor'], field_labels: ['施設', 'フロア'] }
        }),
        'facility'
    );

    // 単一文字列の場合（フォールバック）
    assert.equal(
        getDataQualityTargetField({
            details: { field: 'name' }
        }),
        'name'
    );

    // フィールド情報なしの場合
    assert.equal(getDataQualityTargetField({}), null);
    assert.equal(getDataQualityTargetField({ details: { fields: [] } }), null);
});

test('getDataQualityPrimaryAction: details.fields配列形式の入力不足イシューから先頭フィールドが個票へ渡る', () => {
    let emittedPayload = null;
    const unsubscribe = eventBus.on('ledger:open-device-sheet', payload => {
        emittedPayload = payload;
    });

    const reqIssue = {
        code: DASHBOARD_QUALITY_CODES.missingRequiredFields,
        entity_type: 'device',
        entity_ids: [3],
        details: { fields: ['model', 'asset_number'] }
    };
    globalThis.window.APP_CONFIG.user.isAdmin = true;
    const action = getDataQualityPrimaryAction(reqIssue);
    assert.ok(action);
    action.action();

    assert.ok(emittedPayload);
    assert.equal(emittedPayload.deviceId, 3);
    assert.equal(emittedPayload.field, 'model');

    unsubscribe();
});


test('未分類IPの主操作・対象別操作は管理と追加の登録を混同せず未分類一覧へ進み、キャンセルで画面を保つ', async t => {
    const dom = prepareNavigation(true);
    const previousFetch = globalThis.fetch;
    const previousConfirm = globalThis.confirm;
    const previous = { ipSegments: appState.ipSegments, addressSpaces: appState.addressSpaces };
    t.after(() => {
        globalThis.fetch = previousFetch;
        globalThis.confirm = previousConfirm;
        appState.appStatus.dirty = false;
        Object.assign(appState, previous);
        registerModalClose('data_quality', { restoreFocus: false });
    });
    const records = [
        { device_id: 3, device_name: 'AP-01', kind: 'management', id: null, ip: '192.0.2.31', segment_id: null },
        { device_id: 3, device_name: 'AP-01', kind: 'additional', id: 81, ip: '192.0.2.31', label: '追加81', segment_id: null },
        { device_id: 2, device_name: 'Edge-SW-02', kind: 'additional', id: 82, ip: '192.0.2.31', label: '追加82', segment_id: null },
        { device_id: 3, device_name: 'AP-01', kind: 'additional', id: 83, ip: '192.0.2.31', label: '追加83', segment_id: null }
    ];
    let requests = 0;
    globalThis.fetch = async () => {
        requests++;
        return new Response(JSON.stringify({
            status: 'success', revision: 1, address_spaces: [], ip_segments: [], ip_records: records
        }));
    };
    const { closeIpManagement } = await import('../public/js/modals/ip-management-modal.js');
    const qualityOverlay = dom.add('div', 'data-quality-overlay');
    const previousFocus = dom.add('button', 'quality-opener');
    const settle = async () => {
        await new Promise(resolve => setImmediate(resolve));
        await new Promise(resolve => setImmediate(resolve));
    };
    const assertTarget = record => {
        const overlay = document.getElementById('ip-management-overlay');
        assert.equal(overlay.hidden, false);
        const rows = overlay.querySelectorAll('.ip-management-record');
        assert.equal(rows.length, records.length);
        assert.equal(overlay.querySelectorAll('.ip-management-target').length, 1);
        const selected = rows[records.indexOf(record)];
        assert.equal(selected.dataset.recordKey, `${record.device_id}:${record.kind}:${record.id ?? ''}`);
        assert.equal(selected.classList.contains('ip-management-target'), true);
        const checkbox = selected.querySelector('input[type="checkbox"]');
        if (window.APP_CONFIG.user.isAdmin) {
            assert.ok(checkbox);
            assert.equal(checkbox.disabled, true, '診断対象でも候補なし登録は選択できない');
            assert.equal(checkbox.checked, false, '診断からの遷移で登録を勝手に選択しない');
        } else {
            assert.equal(checkbox, null, '閲覧者は診断対象でも選択操作できない');
        }
        assert.equal(selected.querySelector('.ip-management-ip-cell').querySelector('.ip-management-target-label')?.textContent, '診断対象');
        assert.ok(document.activeElement === selected);
        assert.equal(qualityOverlay.hidden, true);
        assert.equal(getTopModalContainer(), overlay);
    };
    const prepareQuality = () => {
        qualityOverlay.hidden = false;
        previousFocus.focus();
        registerModalOpen('data_quality', qualityOverlay);
    };
    const issueFor = record => ({
        code: 'unclassified_ip', severity: 'warning', category: 'completeness',
        entity_type: 'device', entity_ids: [record.device_id],
        details: {
            field: record.kind === 'management' ? 'ip' : 'additional_ips',
            field_labels: [record.kind === 'management' ? '管理IPv4アドレス' : '追加IPv4アドレス'],
            value: record.ip, devices: [{ id: record.device_id, name: record.device_name }],
            ip_records: [{ ...record, device_id: String(record.device_id), id: record.id === null ? null : String(record.id) }]
        }
    });
    for (const record of records) {
        const issue = issueFor(record);
        const lines = getDataQualityDetailLines(issue).join('\n');
        assert.match(lines, record.kind === 'management' ? /管理IPv4アドレス/ : /追加IPv4アドレス/);
        assert.match(lines, /192\.0\.2\.31/);
        assert.match(lines, new RegExp(`ID ${record.device_id}: ${record.device_name}`));
        for (const isAdmin of [true, false]) {
            window.APP_CONFIG.user.isAdmin = isAdmin;
            prepareQuality();
            const article = createDataQualityIssueElement(issue);
            qualityOverlay.replaceChildren(article);
            const primary = article.querySelector('.data-quality-action-primary');
            assert.equal(primary.textContent, 'IPアドレス管理で確認');
            await primary.dispatch('click');
            await settle();
            assertTarget(record);
            assert.equal(closeIpManagement(), true);
        }
    }

    const multiRecords = [records[3], records[0], records[2], records[1]];
    const multiIssue = {
        ...issueFor(records[3]), entity_ids: [3, 2],
        details: { ip_records: multiRecords }
    };
    const actions = createDataQualityIssueActions(multiIssue);
    qualityOverlay.replaceChildren(actions);
    assert.equal(actions.querySelector('h5').textContent, '対象ごとの操作');
    const targetRows = actions.querySelectorAll('.data-quality-target-row');
    assert.equal(targetRows.length, multiRecords.length);
    for (const [index, record] of multiRecords.entries()) {
        const buttons = targetRows[index].querySelectorAll('button');
        assert.deepEqual(buttons.map(button => button.textContent), ['所属を確認']);
        prepareQuality();
        await buttons[0].dispatch('click');
        await settle();
        assertTarget(record);
        assert.equal(closeIpManagement(), true);
    }
    prepareQuality();
    const multiArticle = createDataQualityIssueElement(multiIssue);
    qualityOverlay.replaceChildren(multiArticle);
    await multiArticle.querySelector('.data-quality-action-primary').dispatch('click');
    await settle();
    assertTarget(multiRecords[0]);
    assert.equal(closeIpManagement(), true);

    globalThis.confirm = () => false;
    appState.appStatus.dirty = true;
    prepareQuality();
    const primary = multiArticle.querySelector('.data-quality-action-primary');
    const before = requests;
    const rowButton = multiArticle.querySelectorAll('.data-quality-target-row')[1].querySelector('button');
    for (const button of [primary, rowButton]) {
        button.focus();
        await button.dispatch('click');
        await settle();
        assert.equal(requests, before);
        assert.equal(document.getElementById('ip-management-overlay').hidden, true);
        assert.equal(qualityOverlay.hidden, false);
        assert.equal(getTopModalContainer(), qualityOverlay);
        assert.ok(document.activeElement === button);
        assert.equal(appState.appStatus.dirty, true);
    }
});

test('到達性矛盾は関係する区分と状態を示し、閲覧者も対象IPの管理画面へ進める', async t => {
    const dom = prepareNavigation(false);
    const previousFetch = globalThis.fetch;
    const previous = { addressSpaces: appState.addressSpaces, ipSegments: appState.ipSegments };
    const records = [
        { device_id: 1, device_name: '合成A', kind: 'management', id: null, ip: '192.0.2.71',
            segment_id: 101, address_space_id: 10, address_space_name: '運用区分', ping_reachability: 'reachable' },
        { device_id: 2, device_name: '合成B', kind: 'additional', id: 201, ip: '192.0.2.71',
            label: '比較用', segment_id: 102, address_space_id: 20, address_space_name: '比較区分', ping_reachability: 'unset' },
        { device_id: 3, device_name: '合成C', kind: 'management', id: null, ip: '192.0.2.71',
            segment_id: null, address_space_id: null, address_space_name: null, ping_reachability: 'unset' }
    ];
    const issue = {
        code: 'ambiguous_ping_target', severity: 'warning', category: 'monitoring', entity_type: 'device',
        entity_ids: [1, 2, 3], message: 'Ping対象の識別不可',
        details: { value: '192.0.2.71', ip_records: records }
    };
    globalThis.fetch = async () => new Response(JSON.stringify({
        ok: true, revision: 1,
        address_spaces: [{ id: 10, name: '運用区分', ping_reachability: 'reachable' },
            { id: 20, name: '比較区分', ping_reachability: 'unset' }],
        ip_segments: [{ id: 101, name: 'A', address_space_id: 10, cidr: '192.0.2.0/24' },
            { id: 102, name: 'B', address_space_id: 20, cidr: '192.0.2.0/24' }],
        ip_records: records
    }));
    const { closeIpManagement } = await import('../public/js/modals/ip-management-modal.js');
    t.after(() => {
        closeIpManagement();
        globalThis.fetch = previousFetch;
        Object.assign(appState, previous);
    });
    const lines = getDataQualityDetailLines(issue);
    assert.ok(lines.some(line => line.includes('192.0.2.71') && line.includes('合成A') && line.includes('運用区分 / 到達可能')));
    assert.ok(lines.some(line => line.includes('追加IP（比較用）') && line.includes('比較区分 / 未設定')));
    assert.ok(lines.some(line => line.includes('合成C') && line.includes('未分類 / 未設定')));
    const overlay = dom.add('div', 'data-quality-overlay');
    for (const isAdmin of [true, false]) {
        window.APP_CONFIG.user.isAdmin = isAdmin;
        overlay.hidden = false;
        const article = createDataQualityIssueElement(issue);
        overlay.replaceChildren(article);
        await article.querySelector('.data-quality-action-primary').dispatch('click');
        await new Promise(resolve => setImmediate(resolve));
        const ipOverlay = document.getElementById('ip-management-overlay');
        assert.equal(overlay.hidden, true);
        assert.equal(ipOverlay.hidden, false);
        assert.equal(ipOverlay.querySelector('.ip-management-search-match')?.dataset.ip, '192.0.2.71');
        assert.equal(ipOverlay.querySelector('.ip-management-search-match')?.dataset.recordKey, '1:management:');
        assert.equal(closeIpManagement(), true);
    }
});

const missingPortsIssue = {
    code: 'link_ports_missing', severity: 'info', category: 'completeness', entity_type: 'link', entity_ids: [50],
    message: '接続のポートが未指定です',
    details: { missing_endpoints: { to: { device_id: 2, device_name: 'Edge-SW-02' } } },
    not_applicable_items: [{ field: 'to_port', device_id: 2, label: '終点ポート', resource_revision: 7 }]
};

test('ポート未指定診断は共通表示ビューの接続情報を開く', async () => {
    const dom = prepareNavigation(true, 'templates/modals/data_quality.php');
    const overlay = dom.get('data-quality-overlay');
    overlay.hidden = false;
    appState.placements.push({ id: 101, device_id: 2, view_id: 10, x: 200, y: 200 });
    clearPendingSave();
    resetResourceBaseline(appState);
    assert.deepEqual(getDataQualityDetailLines(missingPortsIssue), ['終点ポート未指定: Edge-SW-02（ID 2）']);
    await getDataQualityPrimaryAction(missingPortsIssue).action();
    assert.equal(appState.currentViewId, 10);
    assert.equal(appState.editingLinkId, 50);
    assert.equal(dom.get('link-panel').hidden, false);
    assert.equal(overlay.hidden, true);
    assert.equal(document.activeElement, dom.get('lp-to-port'));
});

test('端点の詳細がないポート未指定診断でも、共通表示ビューの接続情報を開ける', async () => {
    const dom = prepareNavigation(true, 'templates/modals/data_quality.php');
    dom.get('data-quality-overlay').hidden = false;
    appState.placements.push({ id: 101, device_id: 2, view_id: 10, x: 200, y: 200 });
    resetResourceBaseline(appState);

    await getDataQualityPrimaryAction({ ...missingPortsIssue, details: {} }).action();

    assert.equal(dom.get('link-panel').hidden, false);
    assert.equal(dom.get('data-quality-overlay').hidden, true);
    assert.notEqual(document.activeElement, dom.get('lp-from-port'));
    assert.notEqual(document.activeElement, dom.get('lp-to-port'));
});

test('共通表示ビューがなければ未指定側の機器個票で対象接続を開く', async () => {
    const dom = prepareNavigation(true, 'templates/modals/ledger.php', 'templates/modals/data_quality.php');
    const overlay = dom.get('data-quality-overlay');
    overlay.hidden = false;
    appState.devices = appState.devices.map(normalizeDevice);
    appState.placements.push({ id: 101, device_id: 2, view_id: 20, x: 200, y: 200 });
    registerModalOpen('data_quality', overlay);
    const frames = [];
    const requestFrame = window.requestAnimationFrame;
    window.requestAnimationFrame = callback => frames.push(callback);
    try {
        await getDataQualityPrimaryAction(missingPortsIssue).action();
        assert.equal(overlay.hidden, false);
        assert.equal(getTopModalContainer(), dom.get('ledger-device-sheet-overlay'));
        assert.equal(dom.get('ledger-sheet-body').dataset.deviceId, '2');
        assert.equal(dom.get('ledger-sheet-body').dataset.activeTab, 'ports');
        assert.equal(dom.get('ledger-port-editor-title').textContent, 'ポート未指定の接続 #50');
        for (const frame of frames.splice(0)) frame();
        assert.equal(dom.get('ledger-port-editor').contains(document.activeElement), true);
    } finally {
        window.requestAnimationFrame = requestFrame;
        await closeLedgerDetailPane();
        registerModalClose('data_quality', { restoreFocus: false });
    }
});

const noMaintenanceExpiry = {
    code: 'maintenance_expiry_missing', severity: 'info', category: 'maintenance', entity_type: 'device', entity_ids: [2],
    message: '保守期限が未登録です', details: { field: 'maintenance_expiry' },
    not_applicable_items: [{ field: 'maintenance_expiry', device_id: 2, label: '保守期限', resource_revision: 19 }]
};

test('保守期限未登録の「保守」カードから保守期限欄を指定して個票を開く', t => {
    prepareNavigation(true);
    const destinations = [];
    t.after(eventBus.on('ledger:open-device-sheet', target => destinations.push(target)));
    const card = createDataQualityIssueElement(noMaintenanceExpiry);
    assert.equal(card.querySelector('.data-quality-category-badge').textContent, '保守');
    getDataQualityPrimaryAction(noMaintenanceExpiry).action();
    assert.deepEqual(destinations, [{ deviceId: 2, field: 'maintenance_expiry' }]);
});

function prepareNotApplicable(t) {
    const before = {
        dataQualityResult: appState.dataQualityResult,
        dataQualitySeverityFilter: appState.dataQualitySeverityFilter,
        dataQualityCategoryFilter: appState.dataQualityCategoryFilter,
        dataQualityCodeFilter: appState.dataQualityCodeFilter,
        dataQualitySuppressedView: appState.dataQualitySuppressedView
    };
    const originalFetch = globalThis.fetch;
    const dom = prepareNavigation(true, 'templates/modals/data_quality.php');
    dom.get('data-quality-overlay').hidden = false;
    registerModalOpen('data_quality', dom.get('data-quality-overlay'));
    Object.assign(appState, {
        dataQualitySeverityFilter: '', dataQualityCategoryFilter: '', dataQualityCodeFilter: [], dataQualitySuppressedView: 'hidden'
    });
    t.after(() => {
        registerModalClose('data_quality', { restoreFocus: false });
        Object.assign(appState, before);
        globalThis.fetch = originalFetch;
    });
    return dom;
}

function recommendedIssue(deviceId, ...fields) {
    const labels = new Map([['manufacturer', 'メーカー'], ['model', '型番']]);
    return {
        code: 'missing_recommended_fields', severity: 'warning', category: 'completeness',
        entity_type: 'device', entity_ids: [deviceId], message: '機器の推奨項目が不足しています',
        details: { fields, field_labels: fields.map(field => labels.get(field)) },
        not_applicable_items: fields.map(field => ({
            field, device_id: deviceId, label: labels.get(field), resource_revision: 100 + deviceId
        }))
    };
}

test('項目だけを設定不要にして解除でき、再診断とダッシュボード集計に通常件数だけを使う', async t => {
    const dom = prepareNotApplicable(t);
    const normal = {
        ok: true, revision: 3, summary: { error: 0, warning: 1, info: 0, total: 1 },
        issues: [recommendedIssue(1, 'manufacturer', 'model')],
        suppressed_issues: [recommendedIssue(3, 'model'), noMaintenanceExpiry], suppressed_count: 2
    };
    const partial = {
        ...normal, issues: [recommendedIssue(1, 'model')],
        suppressed_issues: [recommendedIssue(1, 'manufacturer'), ...normal.suppressed_issues], suppressed_count: 3
    };
    const requests = [];
    let next = partial;
    globalThis.fetch = async (url, options) => {
        requests.push([url, options.method, options.body && JSON.parse(options.body), new Headers(options.headers).get('X-CSRF-Token')]);
        return Response.json(options.method === 'POST' ? { ok: true } : next);
    };
    appState.dataQualityResult = normal;
    renderDataQuality();
    const list = dom.get('data-quality-issue-list');
    assert.equal(list.querySelectorAll('article').length, 1);
    const original = list.querySelector('article');
    await original.querySelector('.data-quality-expand-btn').dispatch('click');
    const [manufacturer, model] = original.querySelectorAll('.data-quality-not-applicable-button');
    assert.match(manufacturer.getAttribute('aria-label'), /^メーカー/);
    assert.match(model.getAttribute('aria-label'), /^型番/);
    manufacturer.focus();
    await manufacturer.dispatch('click');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(requests, [
        ['api.php?action=set_quality_not_applicable', 'POST', {
            code: 'missing_recommended_fields', field: 'manufacturer', device_id: 1, expected_revision: 101, not_applicable: true
        }, 'test-only-token'],
        ['api.php?action=data_quality', 'GET', undefined, null]
    ]);
    assert.equal(document.activeElement, dom.get('data-quality-show-suppressed'));
    assert.equal(list.querySelectorAll('.data-quality-not-applicable-button').length, 1);
    assert.match(list.textContent, /対象項目: 型番/);
    assert.doesNotMatch(list.textContent, /メーカー/);

    selectDataQualitySuppressed(true);
    assert.equal(dom.get('data-quality-suppressed-count').textContent, '3');
    assert.equal(dom.get('data-quality-total-count').textContent, '1');
    assert.equal(dom.get('data-quality-info-count').textContent, '0');
    assert.match(dom.get('data-quality-show-suppressed').closest('label').textContent, /設定不要も表示（3項目）/);
    assert.equal(dom.get('data-quality-filter-summary').textContent, '通常 1件 / 設定不要 3項目');
    const { totals, entityIds } = buildDashboardModel({
        devices: appState.devices, qualityResult: appState.dataQualityResult, dataRevision: normal.revision
    });
    assert.equal(totals.qualityTotal, Number(dom.get('data-quality-total-count').textContent));
    assert.equal(totals.qualityInfo, 0);
    assert.deepEqual(entityIds.incompleteDevices, [1]);
    const [partiallySuppressed, fullySuppressed, maintenance] = list.querySelectorAll('article');
    assert.equal(list.querySelectorAll('article').length, 3);
    assert.equal(partiallySuppressed.querySelector('.data-quality-count-badge').textContent, '設定不要の項目あり');
    assert.equal(fullySuppressed.querySelector('.data-quality-count-badge').textContent, '設定不要');
    assert.equal(maintenance.querySelector('.data-quality-expand-btn').getAttribute('aria-expanded'), 'false');
    assert.equal(partiallySuppressed.querySelector('.data-quality-expand-btn').getAttribute('aria-expanded'), 'true');
    next = normal;
    await partiallySuppressed.querySelectorAll('.data-quality-not-applicable-button')
        .find(button => button.textContent === '設定不要を解除').dispatch('click');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests[2][2].not_applicable, false);
    assert.equal(requests[2][2].field, 'manufacturer');
    assert.equal(requests[3][1], 'GET');
    assert.equal(dom.get('data-quality-suppressed-count').textContent, '2');
    assert.match(list.querySelector('article').textContent, /対象項目: メーカー、型番/);
});

test('接続の片端だけ設定不要でも同じ接続カードで残りの端点と設定不要の端点を区別する', async t => {
    const dom = prepareNotApplicable(t);
    appState.dataQualityResult = {
        issues: [missingPortsIssue], summary: { info: 1, total: 1 }, suppressed_count: 1,
        suppressed_issues: [{
            ...missingPortsIssue,
            details: { missing_endpoints: { from: { device_id: 1, device_name: 'Core-SW-01' } } },
            not_applicable_items: [{ field: 'from_port', device_id: 1, label: '始点ポート', resource_revision: 7 }]
        }]
    };
    renderDataQuality();
    const list = dom.get('data-quality-issue-list');
    assert.match(list.textContent, /終点ポート未指定: Edge-SW-02/);
    assert.doesNotMatch(list.textContent, /Core-SW-01/);
    selectDataQualitySuppressed(true);
    assert.equal(list.querySelectorAll('article').length, 1);
    assert.equal(dom.get('data-quality-category-list').querySelector('.data-quality-category-button').textContent, 'すべて1');
    await list.querySelector('.data-quality-expand-btn').dispatch('click');
    const [missing, suppressed] = list.querySelectorAll('.data-quality-not-applicable-button');
    assert.match(missing.getAttribute('aria-label'), /終点ポート.*Edge-SW-02.*設定不要にする/);
    assert.match(suppressed.getAttribute('aria-label'), /始点ポート.*Core-SW-01.*設定不要を解除/);
});

test('端点を指定した設定不要操作が競合したら再診断して古い接続を一覧から外す', async t => {
    const dom = prepareNotApplicable(t);
    appState.dataQualityResult = { issues: [missingPortsIssue], summary: { info: 1, total: 1 } };
    const attempts = [];
    globalThis.fetch = async (url, options) => {
        if (options.method === 'POST') {
            attempts.push(JSON.parse(options.body));
            return Response.json({ ok: false, error: '対象が変更されました。再診断してください' }, { status: 409 });
        }
        assert.equal(url, 'api.php?action=data_quality');
        return Response.json({ ok: true, issues: [], summary: { info: 0, total: 0 } });
    };
    renderDataQuality();
    const list = dom.get('data-quality-issue-list');
    await list.querySelector('.data-quality-expand-btn').dispatch('click');
    const button = list.querySelector('.data-quality-not-applicable-button');
    assert.match(button.getAttribute('aria-label'), /終点ポート.*Edge-SW-02/);
    await button.dispatch('click');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(attempts, [{
        code: 'link_ports_missing', field: 'to_port', device_id: 2, link_id: 50, expected_revision: 7, not_applicable: true
    }]);
    assert.equal(list.hidden, true);
    assert.match(dom.get('toast').textContent, /対象が変更されました/);
});

test('設定不要の保存中は画面を作り直さず、成功・競合どちらも古い診断より後に再取得する', async t => {
    const dom = prepareNotApplicable(t);
    const list = dom.get('data-quality-issue-list');
    const toggle = dom.get('data-quality-show-suppressed');
    const refresh = dom.get('data-quality-refresh-btn');
    const before = { ok: true, revision: 7, issues: [missingPortsIssue], summary: { info: 1, total: 1 } };

    for (const status of [200, 409]) {
        const post = Promise.withResolvers();
        const earlier = Promise.withResolvers();
        const next = Promise.withResolvers();
        const requests = [];
        globalThis.fetch = (_url, { method }) => {
            requests.push(method);
            if (method === 'POST') return post.promise;
            return requests.length === 1 ? earlier.promise : next.promise;
        };
        appState.dataQualityResult = before;
        expandedIssueKeys.clear();
        renderDataQuality();
        const card = list.querySelector('article');
        await card.querySelector('.data-quality-expand-btn').dispatch('click');
        const button = card.querySelector('.data-quality-not-applicable-button');
        button.focus();

        const earlierDiagnosis = reloadDataQualityResult();
        const saving = button.dispatch('click');
        try {
            assert.equal(refresh.disabled, true);
            assert.equal(toggle.disabled, true);
            assert.equal(button.disabled, true);
            await refreshDataQuality();
            selectDataQualitySuppressed(true);
            renderDataQuality();
            assert.equal(toggle.checked, false);
            assert.equal(list.querySelector('article'), card);
            assert.deepEqual(requests, ['GET', 'POST']);

            post.resolve(Response.json(status === 200 ? { ok: true } : { error: '変更が競合しました' }, { status }));
            await settle();
            assert.deepEqual(requests, ['GET', 'POST', 'GET']);
            assert.equal(refresh.disabled, true);

            next.resolve(Response.json({ ...before, issues: [], summary: { total: 0 },
                suppressed_issues: status === 200 ? [missingPortsIssue] : [], suppressed_count: status === 200 ? 1 : 0 }));
            await settle();
            earlier.resolve(Response.json(before));
            await earlierDiagnosis;

            assert.equal(list.querySelector('article'), null);
            assert.equal(appState.dataQualityResult.summary.total, 0);
            assert.equal(document.activeElement, toggle);
            for (const control of [refresh, toggle]) assert.equal(control.disabled, false);
        } finally {
            post.resolve(Response.json({ ok: true }));
            earlier.resolve(Response.json(before));
            next.resolve(Response.json(before));
            await saving;
            await earlierDiagnosis;
            await settle();
        }
    }
});

test('機器個票から戻ると保存済みの変更だけ自動再診断し、未保存時はDB基準の案内を残す', async t => {
    const dom = prepareNavigation(true, 'templates/modals/ledger.php', 'templates/modals/data_quality.php');
    const overlay = dom.get('data-quality-overlay');
    const originalFetch = globalThis.fetch;
    const oldState = { dataRevision: appState.dataRevision, dataQualityResult: appState.dataQualityResult };
    const previous = { revision: 8, issues: [noMaintenanceExpiry], summary: { info: 1, total: 1 } };
    const later = Promise.withResolvers();
    let gets = 0;
    globalThis.fetch = url => {
        assert.equal(url, 'api.php?action=data_quality');
        gets++;
        return later.promise;
    };
    t.after(eventBus.on('data-quality:render', refreshDataQualityAfterSheet));
    t.after(() => {
        closeDataQuality();
        Object.assign(appState, oldState);
        appState.appStatus.dirty = false;
        globalThis.fetch = originalFetch;
    });
    appState.dataQualityResult = previous;
    appState.dataRevision = 9;
    overlay.hidden = false;
    registerModalOpen('data_quality', overlay);
    const openSheet = () => {
        const sheet = dom.get('ledger-device-sheet-overlay');
        sheet.hidden = false;
        registerModalOpen('ledger-device-sheet', sheet);
    };
    try {
        appState.appStatus.dirty = true;
        openSheet();
        assert.equal(await closeLedgerDetailPane(), true);
        assert.equal(gets, 0);
        assert.match(dom.get('data-quality-notices').textContent, /未保存/);
        assert.equal(dom.get('data-quality-total-count').textContent, '1');

        appState.appStatus.dirty = false;
        openSheet();
        assert.equal(await closeLedgerDetailPane(), true);
        assert.equal(gets, 1);
        assert.equal(getTopModalContainer(), overlay);
        assert.equal(dom.get('data-quality-issue-list').hidden, false);
        later.resolve(Response.json({ ok: true, revision: 9, issues: [], summary: { total: 0 } }));
        await settle();
        assert.equal(dom.get('data-quality-total-count').textContent, '0');
        assert.equal(dom.get('data-quality-notices').hidden, true);

        openSheet();
        assert.equal(await closeLedgerDetailPane(), true);
        assert.equal(gets, 1, '診断と保存済みデータが同じなら再取得しない');
    } finally {
        later.resolve(Response.json({ ok: true, revision: 9, issues: [], summary: { total: 0 } }));
        await settle();
    }
});

test('詳細欄は期限・書式の診断値と保留された接続・ポートの識別子を表示する', () => {
    const cases = [
        ['maintenance_expiry_before_install', { install_date: '2025-03-10', maintenance_expiry: '2025-03-09' },
            ['導入年月: 2025-03-10', '保守期限: 2025-03-09']],
        ['invalid_management_scheme', { scheme: 'telnet' }, ['管理接続方式: telnet']],
        ['invalid_management_port', { port: 0 }, ['管理接続ポート: 0']],
        ['legacy_link_conflict', { legacy_link_id: 81, reason: 'port_conflict' }, ['旧接続ID: 81', '保留理由: port_conflict']],
        ['invalid_link_port', { port_id: 9, link_id: 50 }, ['ポートID: 9']],
        ['duplicate_port_use', { port_id: 9, link_ids: [50, 51] }, ['ポートID: 9', '接続ID: 51']],
        ['orphan_device_port', { port_id: 9 }, ['ポートID: 9']]
    ];
    for (const [code, details, expected] of cases) {
        const issue = { code, details, entity_type: 'link', entity_ids: [50] };
        assert.deepEqual(getDataQualityDetailLines(issue).sort(), expected.sort(), code);
    }
});

test('配置不一致は保存済みのパスを優先し、APIにないパスだけ画面データを使う', t => {
    const previous = { buildings: appState.buildings, floors: appState.floors };
    Object.assign(appState, {
        buildings: [{ id: 1, name: '画面の建物' }],
        floors: [{ id: 2, building_id: 1, name: '画面の設置先' }, { id: 3, building_id: 1, name: '画面の配置先' }]
    });
    t.after(() => Object.assign(appState, previous));
    const issue = { code: 'floor_mismatch', details: {
        device_floor_id: 2, view_floor_id: 3, device_path: 'DBの設置先', view_path: 'DBの配置先'
    } };
    assert.deepEqual(getDataQualityDetailLines(issue), ['設置フロア: DBの設置先', '配置先: DBの配置先']);
    delete issue.details.device_path;
    assert.deepEqual(getDataQualityDetailLines(issue), ['設置フロア: 画面の建物 / 画面の設置先', '配置先: DBの配置先']);
});

test('同じ概要でも、別のビュー・旧接続・手動経路のカードは個別に展開できる', async t => {
    const dom = prepareNotApplicable(t);
    const pairs = [
        ['floor_mismatch', 'view_id', 10, 20],
        ['rack_floor_mismatch', 'view_id', 10, 20],
        ['legacy_link_conflict', 'legacy_link_id', 81, 82],
        ['invalid_view_link_route', 'device_ids', [1, 2], [1, 3]]
    ];
    for (const [code, field, first, second] of pairs) {
        const issue = { code, entity_type: 'view', entity_ids: [10], category: 'integrity', severity: 'warning', message: '同じ概要' };
        assert.equal(getIssueKey(issue), `${code}:view:10:同じ概要`);
        appState.dataQualityResult = {
            issues: [first, second].map(value => ({ ...issue, details: { [field]: value } }))
        };
        renderDataQuality();
        const list = dom.get('data-quality-issue-list');
        await list.querySelector('.data-quality-expand-btn').dispatch('click');
        renderDataQuality();
        assert.deepEqual(list.querySelectorAll('.data-quality-expand-btn').map(button => button.getAttribute('aria-expanded')),
            ['true', 'false'], code);
    }
});

test('品質診断のTabと閉じた後のフォーカスを共通モーダルが扱う', async t => {
    const dom = prepareNavigation(true, 'templates/modals/data_quality.php');
    const previousFetch = globalThis.fetch;
    const previousResult = appState.dataQualityResult;
    globalThis.fetch = async () => Response.json({ ok: true, issues: [], summary: { total: 0 } });
    t.after(() => {
        closeDataQuality();
        globalThis.fetch = previousFetch;
        appState.dataQualityResult = previousResult;
    });
    initModalFocusTrap();
    const menu = dom.add('details', 'manage-quality-menu');
    menu.className = 'toolbar-menu';
    menu.open = true;
    menu.setAttribute('open', '');
    const summary = dom.add('summary', 'manage-menu-summary', menu);
    const opener = dom.add('button', 'data-quality-btn', menu);
    opener.focus();
    openDataQuality();
    await settle();
    assert.equal(document.activeElement.id, 'data-quality-show-suppressed');
    const overlay = dom.get('data-quality-overlay');
    const buttons = getFocusableElements(overlay);
    buttons.at(-1).focus();
    await dom.events.dispatch('keydown', { key: 'Tab' });
    assert.ok(document.activeElement === buttons[0], '末尾から先頭へ戻る');
    await dom.events.dispatch('keydown', { key: 'Tab', shiftKey: true });
    assert.ok(document.activeElement === buttons.at(-1), '先頭から末尾へ戻る');
    closeDataQuality();
    assert.equal(document.activeElement.id, summary.id);
});

test('品質診断から台帳と個票を開き、閉じると管理メニューへ戻る', async t => {
    const dom = prepareNavigation(true, 'templates/modals/data_quality.php', 'templates/modals/ledger.php');
    const ledger = await import('../public/js/modals/ledger-modal.js');
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json({ ok: true, issues: [], summary: { total: 0 } });
    t.after(async () => {
        await ledger.closeLedger();
        closeDataQuality();
        globalThis.fetch = previousFetch;
    });

    const menu = dom.add('details', 'toolbar-manage-menu');
    menu.className = 'toolbar-menu';
    menu.setAttribute('open', '');
    const summary = dom.add('summary', 'quality-menu-summary', menu);
    const opener = dom.add('button', 'data-quality-btn', menu);
    opener.focus();
    openDataQuality();
    await settle();

    await ledger.openDataQualityDeviceInLedger(2, { openSheet: true });
    await settle();
    assert.equal(dom.get('data-quality-overlay').hidden, true);
    assert.equal(getTopModalContainer(), dom.get('ledger-device-sheet-overlay'));
    assert.equal(await ledger.closeLedgerDetailPane(), true);
    assert.equal(getTopModalContainer(), dom.get('ledger-overlay'));
    assert.equal(await ledger.closeLedger(), true);
    assert.equal(document.activeElement, summary);
});

test('建物ビューの位置合わせをキャンセルした場合、品質診断の各遷移は中断する', async t => {
    const dom = prepareNavigation(true, 'templates/modals/data_quality.php', 'templates/modals/ledger.php');
    const canvas = dom.add('main', 'canvas');
    const overlay = dom.get('data-quality-overlay');
    overlay.hidden = true;
    const oldObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class { observe() {} disconnect() {} };
    const oldState = { buildings: appState.buildings, floors: appState.floors, floorPlans: appState.floorPlans };
    Object.assign(appState, {
        buildings: [{ id: 1, name: '本館', building_view_enabled: 1 }],
        floors: [{ id: 11, building_id: 1, name: '1F', representative_view_id: 10 }],
        floorPlans: [{ view_id: 10, image_width: 100, image_height: 60, scale: 1, is_visible: 1 }],
        canvas
    });
    appState.views[0].floor_id = 11;
    t.after(async () => {
        if (getOpenBuildingId() != null) {
            const closing = closeBuildingView();
            await dom.get('unsaved-changes-discard')?.click();
            await closing;
        }
        registerModalClose('data_quality', { restoreFocus: false });
        Object.assign(appState, oldState, { canvas: null });
        globalThis.ResizeObserver = oldObserver;
    });
    assert.equal(await openBuildingView(1), true);
    const building = document.querySelector('.building-view');
    await building.querySelectorAll('button').find(button => button.textContent === '位置合わせモード').click();
    const input = dom.get('building-view-editor').querySelector('input');
    input.value = '25';
    await input.dispatch('input');
    assert.equal(hasBuildingViewDraft(), true);

    overlay.hidden = false;
    registerModalOpen('data_quality', overlay);
    const issues = [
        { code: 'stale_monitor', category: 'monitoring', entity_type: 'device', entity_ids: [1] },
        { code: 'floor_mismatch', entity_type: 'device', entity_ids: [1], details: { view_id: 10 } },
        { code: 'unplaced_device', entity_type: 'device', entity_ids: [2] },
        { code: 'invalid_link_port', category: 'integrity', entity_type: 'link', entity_ids: [50] },
        missingPortsIssue,
        { code: 'legacy_link_conflict', entity_type: 'view', entity_ids: [10] }
    ];
    appState.placements.push({ id: 101, device_id: 2, view_id: 10, x: 200, y: 200 });
    const actions = [
        ...issues.map(issue => [issue.code, getDataQualityPrimaryAction(issue).action]),
        ['view', () => openDataQualityView(10)],
        ['ports-in-ledger', () => {
            appState.placements.pop();
            return getDataQualityPrimaryAction(missingPortsIssue).action();
        }]
    ];
    for (const [name, action] of actions) {
        const navigation = action();
        const cancel = dom.get('unsaved-changes-cancel');
        assert.ok(cancel, name);
        await cancel.click();
        await navigation;
        assert.equal(getOpenBuildingId(), 1, name);
        assert.equal(getTopModalContainer(), overlay, name);
        assert.equal(overlay.hidden, false, name);
        assert.equal(appState.currentViewId, 20, name);
        assert.equal(appState.editingDeviceId, null, name);
        assert.equal(appState.editingLinkId, null, name);
    }

    clearPendingSave();
    resetResourceBaseline(appState);
    const navigation = openDataQualityView(10);
    await dom.get('unsaved-changes-discard').click();
    await navigation;
    assert.equal(getOpenBuildingId(), null);
    assert.equal(appState.currentViewId, 10);
    assert.equal(overlay.hidden, true);
});

test('data-quality: 重要度チップ解除維持・非JSON401・閲覧者縮退・配置なし接続フォールバック非閉鎖', async t => {
    const keys = ['window', 'document', 'HTMLElement', 'Element', 'fetch', 'requestAnimationFrame', 'cancelAnimationFrame'];
    const originals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const { installWorkspaceDom } = await import('./helpers/workspace-dom.mjs');
    const dom = installWorkspaceDom({ templates: ['templates/modals/data_quality.php', 'templates/components/toast.php'] });
    let authExpiredCalled = 0;
    window.handleAuthExpired = () => { authExpiredCalled++; };
    t.after(() => {
        closeDataQuality();
        for (const [key, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    });

    // 1. 非JSONの401応答でhandleAuthExpiredを呼ぶ
    globalThis.fetch = async () => new Response('<html>401</html>', { status: 401, headers: { 'Content-Type': 'text/html' } });
    openDataQuality();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(authExpiredCalled, 1);

    // 2. 重要度フィルタチップの削除でカテゴリフィルタ等を保持する
    appState.dataQualityResult = {
        revision: 1,
        generated_at: '2026-01-01T00:00:00Z',
        summary: { error: 1, warning: 1, info: 0, total: 2 },
        issues: [
            { code: 'unplaced_device', severity: 'warning', category: 'completeness', entity_type: 'device', entity_ids: [1], message: '未配置' },
            { code: 'management_ip_missing', severity: 'error', category: 'completeness', entity_type: 'device', entity_ids: [2], message: 'IP未設定' }
        ]
    };
    appState.dataQualityCategoryFilter = 'completeness';
    appState.dataQualitySeverityFilter = 'warning';
    renderDataQuality();
    const chipRemove = dom.get('data-quality-filter-chips').querySelector('.data-quality-filter-chip-remove');
    assert.ok(chipRemove);
    await chipRemove.click();
    assert.equal(appState.dataQualitySeverityFilter, '');
    assert.equal(appState.dataQualityCategoryFilter, 'completeness', 'カテゴリ絞り込みを保持する');

    // 3. 閲覧者時のfloor_plan_hidden縮退
    window.APP_CONFIG.user.isAdmin = false;
    const viewerAction = getDataQualityPrimaryAction({ code: 'floor_plan_hidden', entity_type: 'view', entity_ids: [10] });
    assert.equal(viewerAction.label, 'ビューを表示');
    window.APP_CONFIG.user.isAdmin = true;

    // 4. 配置なし接続のフォールバック失敗時にモーダルを閉じない
    appState.links = [{ id: 99, from_id: 2, to_id: 3, resource_revision: 1 }];
    appState.placements = [];
    const { openDataQualityLinkFlow } = await import('../public/js/modals/data-quality-modal.js');
    await openDataQualityLinkFlow({ code: 'invalid_link_port', entity_type: 'link', entity_ids: [99] });
    assert.equal(dom.get('data-quality-overlay').hidden, false);
});
