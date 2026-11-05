import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
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
    createDataQualityIssueActions
} from '../public/js/modals/data-quality-modal.js';

import { eventBus } from '../public/js/core/event-bus.js';

import { appState } from '../public/js/core/state.js';
import { DASHBOARD_QUALITY_CODES } from '../public/js/core/constants.js';

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
        { id: 50, view_id: 10, from_device_id: 1, to_device_id: 2 }
    ];
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

function prepareNavigation(isAdmin) {
    const dom = installWorkspaceDom({
        templates: ['templates/components/property_panel.php', 'templates/components/link_panel.php']
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

test('重複接続・接続不整合は両権限で対象ビューの接続情報へ進む', async () => {
    appState.links = [{ id: 50, view_id: 10, from_id: 1, to_id: 2 }];
    for (const code of ['duplicate_link', 'orphan_link_device', 'link_endpoint_not_placed']) {
        for (const isAdmin of [true, false]) {
            const dom = prepareNavigation(isAdmin);
            await getDataQualityPrimaryAction({
                code, category: code === 'duplicate_link' ? 'duplicate' : 'integrity',
                entity_type: 'link', entity_ids: [50]
            }).action();
            assert.equal(appState.currentViewId, 10);
            assert.equal(appState.editingLinkId, 50);
            assert.equal(dom.get('link-panel').hidden, false);
            assert.equal(dom.get('lp-label').readOnly, !isAdmin);
            assert.equal(appState.editingDeviceId, null);
        }
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

test('書式・必須/推奨項目・機器重複診断は対象個票へ進み、接続診断へ誤分岐しない', () => {
    for (const issue of [
        { code: 'invalid_management_port', category: 'format' },
        { code: 'missing_required_fields', details: { fields: ['model', 'facility'] } },
        { code: 'missing_recommended_fields', details: { fields: ['facility'] } },
        { code: 'duplicate_ip', category: 'duplicate' }
    ]) {
        for (const isAdmin of [true, false]) {
            prepareNavigation(isAdmin);
            const targets = [];
            const unsubscribe = eventBus.on('ledger:open-device-sheet', target => targets.push(target));
            try {
                getDataQualityPrimaryAction({ ...issue, entity_type: 'device', entity_ids: [3] }).action();
                assert.deepEqual(targets, [{ deviceId: 3, field: issue.details?.fields[0] ?? null }]);
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
    const previous = {
        ipSegments: appState.ipSegments, addressSpaces: appState.addressSpaces,
        dataQualityPreviousFocus: appState.dataQualityPreviousFocus
    };
    t.after(() => {
        globalThis.fetch = previousFetch;
        globalThis.confirm = previousConfirm;
        appState.appStatus.dirty = false;
        Object.assign(appState, previous);
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
        assert.equal(appState.dataQualityPreviousFocus, null);
    };
    const prepareQuality = () => {
        qualityOverlay.hidden = false;
        appState.dataQualityPreviousFocus = previousFocus;
        previousFocus.focus();
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
        assert.ok(appState.dataQualityPreviousFocus === previousFocus);
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
