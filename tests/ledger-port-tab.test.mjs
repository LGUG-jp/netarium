import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { installWorkspaceDom } from './helpers/workspace-dom.mjs';

const response = (data, status = 200) => new Response(JSON.stringify(data), { status });
const port = (id, device_id, name, memo = '', resource_revision = 1, vlan = '') => ({ id, device_id, name, memo, resource_revision, vlan });
const maintenanceReply = action => {
    const rejected = new Response(JSON.stringify({ ok: false, error_code: 'NETARIUM_MAINTENANCE_REJECTED',
        contract_version: 1, request_execution: 'not_started', operation_id: 'test-maintenance' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } });
    Object.defineProperty(rejected, 'url', { value: `http://localhost/api.php?action=${action}` });
    return rejected;
};

// The API transaction and its validation are covered separately by ConnectionSaveTest.php.
test('個票での接続・ポートの適用、取消、競合と共有接続の反映', async () => {
    const dom = installWorkspaceDom({ templates: ['templates/modals/ledger.php', 'templates/components/toast.php'], phpSetup: '$isAdmin = true;' });
    globalThis.localStorage = { getItem: () => null, setItem() {} };
    globalThis.confirm = window.confirm = () => true;
    const { appState, getCurrentLinks, normalizeDevice, normalizeView, recalculateNextIds } = await import('../public/js/core/state.js');
    const { normalizeDevicePort, normalizeLink } = await import('../public/js/core/connection-data.js');
    const { resetResourceBaseline } = await import('../public/js/core/resource-save.js');
    const { flushSaveQueue, getPendingSave, saveConnectionBatch } = await import('../public/js/core/save-queue.js');
    const { eventBus } = await import('../public/js/core/event-bus.js');
    const ledger = await import('../public/js/modals/ledger-modal.js');
    const { openLedgerDetail, closeLedgerDetailPane, hasUnsavedPortDraft } = ledger;
    const get = dom.get;
    const byText = (root, text) => root?.querySelectorAll('button').find(button => button.textContent === text);
    const tab = key => get('ledger-sheet-tabs').querySelector(`[data-tab-key="${key}"]`);
    const panel = () => get(tab('ports').getAttribute('aria-controls'));
    const editor = () => get('ledger-port-editor');
    const row = key => panel().querySelector(`[data-port-ledger-key="${key}"]`);
    const edit = key => byText(row(key), '編集').click();
    const change = async (key, value) => {
        const input = get(`ledger-port-${key}`);
        input.value = value;
        await input.dispatch(input.tagName === 'SELECT' ? 'change' : 'input');
    };
    const apply = () => byText(editor(), '適用').click();
    const cancel = () => byText(editor(), 'キャンセル').click();
    const copyFromPeer = () => byText(editor(), '接続先 → この機器へコピー');
    const copyToPeer = () => byText(editor(), 'この機器 → 接続先へコピー');
    const copyDialog = () => get('ledger-port-vlan-confirm-overlay');
    const settle = async () => { await setImmediate(); await setImmediate(); };
    const devices = [
        normalizeDevice({ id: 1, name: 'スイッチA', type: 'switch', resource_revision: 1 }),
        normalizeDevice({ id: 2, name: 'ルーターB', type: 'router', ip: '192.0.2.2', resource_revision: 1 }),
        normalizeDevice({ id: 3, name: '未配置C', type: 'switch', resource_revision: 1 })
    ];
    const views = [1, 2].map(id => normalizeView({ id, name: `合成ビュー ${id}`, view_type: 'topology', resource_revision: 1 }));
    const placements = views.flatMap(view => [1, 2].map((id, index) => ({ id: view.id * 10 + id, view_id: view.id, device_id: id, x: index * 50, y: 10 })));
    const ports = Array.from({ length: 48 }, (_, i) => normalizeDevicePort(port(i + 1, 1, String(i + 1)))).reverse();
    ports.push(normalizeDevicePort(port(202, 2, '既存ポート', '既存のポート備考', 1, 'access 5')));
    const first = normalizeLink({ id: 100, from_id: 1, from_port_id: 1, to_id: 2, label: '元のラベル', resource_revision: 5 });
    Object.assign(appState, { devices, views, placements, currentViewId: 1, dataRevision: 10,
        links: [first], devicePorts: ports, linkSystems: [{ id: 9, name: '業務' }],
        legacyLinkConflicts: [{ legacy_link_id: 92, view_id: 1, device_a_id: 1, device_b_id: 2,
            payload: { from_id: 1, from_port: '４８', to_id: 2, to_port: 'LAN' } }] });
    recalculateNextIds();
    resetResourceBaseline(appState);

    let reply;
    const calls = [];
    const saved = (detail = {}) => response({ ok: true, revision: appState.dataRevision + 1,
        id_maps: {}, device_ports: [], links: [], deleted_device_port_ids: [], deleted_link_ids: [],
        removed_view_link_routes: [], views: [], ...detail });
    let copyRecoverySnapshot = null;
    globalThis.fetch = async (url, options = {}) => {
        const action = new URL(String(url), 'http://localhost').searchParams.get('action');
        if (action === 'load' && copyRecoverySnapshot) return response(copyRecoverySnapshot);
        if (action === 'load') return response({ ok: true, revision: 20, devices, views, device_ports: appState.devicePorts,
            links: [{ ...appState.links.find(link => link.id === 100), resource_revision: 9, label: '他者のラベル' }] });
        assert.ok(['save_connections', 'copy_port_vlan'].includes(action), action);
        const payload = JSON.parse(options.body);
        calls.push(payload);
        return reply(payload);
    };

    assert.equal(await openLedgerDetail(1), true);
    assert.equal(get('ledger-sheet-body').dataset.activeTab, 'primary');
    assert.equal(await closeLedgerDetailPane(), true);
    assert.equal(await openLedgerDetail(1, { tab: 'ports', canOpen: () => false }), false);
    assert.equal(get('ledger-device-sheet-overlay').hidden, true);
    assert.equal(await openLedgerDetail(1, { tab: 'ports' }), true);
    assert.equal(get('ledger-device-sheet-overlay').hidden, false);
    assert.equal(tab('ports').getAttribute('aria-selected'), 'true');
    assert.equal(tab('ports').tabIndex, 0);
    assert.equal(panel().hidden, false);
    assert.deepEqual(get('ledger-sheet-tabs').querySelectorAll('[role="tab"]').slice(-2).map(tab => tab.textContent),
        ['接続・ポート', 'Config管理']);
    assert.equal(panel().querySelectorAll('thead').length, 1);
    const rows = panel().querySelectorAll('tr[data-port-ledger-key]');
    assert.equal(rows.length, 48);
    assert.deepEqual(rows.slice(0, 10).map(row => row.children[0].textContent), ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
    assert.equal(row('port-1').children.length, 9);
    assert.deepEqual(panel().querySelector('thead').children[0].children.slice(0, 3).map(cell => cell.textContent),
        ['自機ポート名', '自機 VLAN', 'ポート備考']);
    assert.equal(row('port-1').children[4].textContent, '未指定');
    assert.equal(row('port-2').children[3].textContent, '未接続');
    assert.match(row('port-48').children[3].textContent, /要確認/);

    // 一覧下部のフォームは、内側の表と外側の個票の両方で末尾が切れる。
    const body = get('ledger-sheet-body');
    const tableViewport = panel().querySelector('.port-ledger-scroll');
    const header = tableViewport.querySelector('thead');
    header.offsetHeight = 32;
    Object.assign(body, { clientTop: 0, clientHeight: 400, getBoundingClientRect: () => ({ top: 100 }) });
    Object.assign(tableViewport, { clientTop: 1, clientHeight: 360, scrollLeft: 120,
        getBoundingClientRect: () => ({ top: 200 - body.scrollTop }) });
    const createElement = document.createElement;
    let editorHeight = 180;
    document.createElement = tag => {
        const node = createElement(tag);
        if (tag === 'form') node.getBoundingClientRect = () => {
            const top = 490 - body.scrollTop - tableViewport.scrollTop;
            return { top, bottom: top + editorHeight };
        };
        return node;
    };
    try {
        await edit('port-48');
        const visibleBottom = Math.min(
            body.getBoundingClientRect().top + body.clientHeight,
            tableViewport.getBoundingClientRect().top + tableViewport.clientTop + tableViewport.clientHeight
        );
        assert.equal(editor().getBoundingClientRect().bottom, visibleBottom, '適用ボタンを含むフォーム末尾が見える');
        assert.equal(tableViewport.scrollLeft, 120, '横スクロール位置は変えない');
        assert.equal(document.activeElement, get('ledger-port-portName'));
        const positions = [tableViewport.scrollTop, body.scrollTop];
        await edit('port-48');
        assert.deepEqual([tableViewport.scrollTop, body.scrollTop], positions, '全体が見えていれば移動しない');
        await cancel();

        editorHeight = 420;
        tableViewport.scrollTop = body.scrollTop = 0;
        await edit('port-48');
        const visibleTop = Math.max(body.getBoundingClientRect().top,
            tableViewport.getBoundingClientRect().top + tableViewport.clientTop + header.offsetHeight);
        assert.equal(editor().getBoundingClientRect().top, visibleTop, '全体が入らない高さでは見出しと先頭入力欄を表示する');
        await cancel();
    } finally {
        document.createElement = createElement;
        tableViewport.scrollTop = body.scrollTop = 0;
    }

    await edit('port-1');
    const editorLabels = () => editor().querySelectorAll('label').map(label => label.textContent);
    const editLabels = editorLabels();
    const peerInput = () => get('ledger-port-peerId');
    const peerOptions = () => get('ledger-port-peer-list').querySelectorAll('[role="option"]').map(option => option.textContent);
    await peerInput().click();
    assert.deepEqual(peerOptions(), ['ルーターB（#2） / 192.0.2.2', '未配置C（#3）']);
    await peerInput().dispatch('keydown', { key: 'ArrowDown' });
    assert.match(get(peerInput().getAttribute('aria-activedescendant')).textContent, /未配置C/);
    await change('peerId', '未配置C');
    assert.deepEqual(peerOptions(), ['未配置C（#3）']);
    await peerInput().dispatch('keydown', { key: 'Escape' });
    assert.match(peerInput().value, /ルーターB/);
    assert.equal(hasUnsavedPortDraft(), false);
    assert.deepEqual(editor().querySelectorAll('button').map(button => button.textContent),
        ['接続を解除', 'キャンセル', '適用']);
    await change('linkMemo', '未適用');
    const tabSwitch = tab('secondary').click();
    await settle();
    await get('unsaved-changes-cancel').click();
    await tabSwitch;
    assert.equal(get('ledger-port-linkMemo').value, '未適用');
    assert.equal(hasUnsavedPortDraft(), true);
    await cancel();
    assert.equal(calls.length, 0);
    assert.equal(appState.links[0].memo, '');

    await byText(row('port-1'), 'ルーターB').click();
    assert.equal(ledger.activeLedgerDeviceId, 2);
    assert.equal(appState.currentViewId, 1);
    assert.match(panel().textContent, /ポート未指定の接続/);
    assert.equal(row('link-100').children[1].textContent, '—');
    await edit('link-100');
    assert.equal(copyFromPeer(), undefined);
    const ownVlan = () => get('ledger-port-vlan');
    const ownVlanReason = () => get('ledger-port-vlan-reason');
    assert.equal(ownVlan().type, 'text');
    assert.equal(ownVlan().disabled, true);
    assert.equal(ownVlanReason().hidden, true);
    await change('portName', '既存ポート');
    assert.equal(ownVlan().disabled, false);
    assert.equal(ownVlan().readOnly, true);
    assert.equal(ownVlan().value, 'access 5');
    assert.equal(ownVlanReason().hidden, false);
    assert.match(ownVlanReason().textContent, /ポートの行で編集/);
    assert.equal(get('ledger-port-portMemo').value, '既存のポート備考');
    await change('portName', ' ＬＡＮ　１ ');
    await change('portMemo', 'B のポート備考');
    await change('linkMemo', '両端で共有する備考');
    const trunkVlan = 'trunk allowed 10,20,30 / native <99>';
    assert.equal(ownVlan().readOnly, false);
    assert.equal(ownVlan().value, '');
    await change('vlan', trunkVlan);
    await change('systemId', '9');
    let release;
    reply = payload => new Promise(resolve => {
        release = () => resolve(saved({ id_maps: { device_ports: { [payload.device_ports[0].id]: 203 } },
            device_ports: [port(203, 2, 'LAN 1', 'B のポート備考', 1, trunkVlan)],
            links: [{ ...first, to_port_id: 203, system_id: 9, memo: '両端で共有する備考', resource_revision: 6 }] }));
    });
    const applying = apply();
    await settle();
    assert.equal(appState.links[0].to_port_id, null);
    assert.equal(appState.devicePorts.some(row => row.id === 203), false);
    assert.deepEqual(calls.at(-1).device_ports[0].port,
        { device_id: 2, name: 'LAN 1', memo: 'B のポート備考', vlan: trunkVlan });
    assert.deepEqual(calls.at(-1).links, [{ operation: 'update', id: 100, expected_revision: 5,
        link: { to_port_name: 'LAN 1', memo: '両端で共有する備考', system_id: 9 } }]);
    release();
    await applying;
    assert.equal(editor(), null);
    assert.equal(row('port-203').children[6].textContent, '元のラベル');
    assert.equal(row('port-203').children[1].textContent, trunkVlan);
    assert.equal(row('port-203').children[2].textContent, 'B のポート備考');
    assert.equal(getCurrentLinks()[0].to_port, 'LAN 1');
    await byText(row('port-203'), 'スイッチA').click();
    assert.equal(row('port-1').children[7].textContent, '両端で共有する備考');

    await edit('port-1');
    assert.equal(editor().querySelector('.port-ledger-vlan-copy').children[0].textContent, `接続先の VLAN設定：${trunkVlan}`);
    assert.equal(copyFromPeer().disabled, false);
    assert.equal(copyToPeer().disabled, true);
    assert.match(get(copyToPeer().getAttribute('aria-describedby')).textContent, /この機器の VLAN設定が空欄/);
    const copyReason = () => get('ledger-port-vlan-copy-reason');
    const copyActions = copyFromPeer().parentElement;
    assert.deepEqual(copyActions.parentElement.children, [copyActions, copyReason()]);
    const beforeEmptySource = calls.length;
    await copyToPeer().click();
    assert.equal(calls.length, beforeEmptySource);
    for (const [key, draft, original] of [
        ['portName', '他のポート名', '1'], ['vlan', 'access 10', ''], ['portMemo', '編集中', ''],
        ['peerPortName', '別の接続先ポート', 'LAN 1'], ['systemId', '', '9'],
        ['label', '他のラベル', '元のラベル'], ['linkMemo', '編集中', '両端で共有する備考']
    ]) {
        await change(key, draft);
        assert.equal(hasUnsavedPortDraft(), true, key);
        assert.equal(copyFromPeer().disabled, true, key);
        assert.equal(copyToPeer().disabled, true, key);
        assert.equal(copyFromPeer().getAttribute('aria-describedby'), copyReason().id);
        assert.equal(copyToPeer().getAttribute('aria-describedby'), copyReason().id);
        assert.equal(copyReason().textContent, '未適用の変更を適用するか、キャンセルしてください。');
        assert.deepEqual(copyActions.children, [copyFromPeer(), copyToPeer()]);
        await change(key, original);
        assert.equal(hasUnsavedPortDraft(), false, key);
        assert.equal(copyFromPeer().disabled, false, key);
        assert.equal(copyReason().textContent, 'この機器の VLAN設定が空欄です。');
    }
    await change('peerId', '未配置C');
    await get('ledger-port-peer-option-3').click();
    assert.equal(hasUnsavedPortDraft(), true);
    assert.equal(copyFromPeer().disabled, true);
    await change('peerId', 'ルーターB');
    await get('ledger-port-peer-option-2').click();
    assert.equal(hasUnsavedPortDraft(), false);
    assert.equal(copyFromPeer().disabled, false);
    await change('vlan', '未適用の VLAN');
    const beforeCopy = calls.length;
    await copyFromPeer().click(); // DOM 代替では disabled のクリックも配送される。
    assert.equal(calls.length, beforeCopy);
    await cancel();
    await edit('port-1');
    assert.equal(copyFromPeer().disabled, false);
    const unmigratedCopy = { link_id: 100, vlan: '未移行の値' };
    appState.legacyLinkVlans = [unmigratedCopy];
    eventBus.emit('legacy-vlans:changed');

    reply = () => new Promise(resolve => {
        release = () => resolve(saved({ device_ports: [port(1, 1, '1', '', 2, trunkVlan)] }));
    });
    const copyIntoEmpty = copyFromPeer().click();
    await settle();
    assert.equal(copyDialog(), null);
    assert.equal(row('port-1').children[1].children[0].textContent, '—', '保存応答までは共有状態に反映しない');
    assert.deepEqual(calls.at(-1), {
        link_id: 100, source_port_id: 203, destination_port_id: 1,
        source_expected_revision: 1, destination_expected_revision: 1
    });
    assert.deepEqual(getPendingSave().payload, { device_ports: [
        { operation: 'update', id: 1, expected_revision: 1, port: { vlan: trunkVlan } }
    ], links: [] });
    release();
    await copyIntoEmpty;
    assert.equal(editor(), null);
    assert.equal(row('port-1').children[1].children[0].textContent, trunkVlan);
    assert.deepEqual(appState.legacyLinkVlans, [unmigratedCopy], '方向コピーでは未移行VLANを完了しない');
    appState.legacyLinkVlans = [];
    eventBus.emit('legacy-vlans:changed');
    await edit('port-1');
    const callsAfterCopy = calls.length;
    await copyToPeer().click();
    assert.equal(calls.length, callsAfterCopy);
    assert.equal(copyDialog(), null);
    assert.match(panel().textContent, /同じ VLAN が設定/);

    await change('vlan', 'access 10');
    reply = payload => {
        assert.deepEqual(payload.links, []);
        assert.equal(payload.device_ports[0].port.vlan, 'access 10');
        return saved({ device_ports: [port(1, 1, '1', '', 3, 'access 10')] });
    };
    await apply();
    await edit('port-1');
    assert.equal(copyToPeer().disabled, false);
    const callsBeforeOverwrite = calls.length;
    const cancelOverwrite = copyToPeer().click();
    await settle();
    assert.equal(document.activeElement, byText(copyDialog(), 'キャンセル'));
    assert.equal(get('ledger-port-vlan-confirm-title').textContent, 'VLAN設定の上書き確認');
    const copyColumns = () => get('ledger-port-vlan-confirm-message').querySelector('.port-vlan-confirm-comparison')
        .children.map(column => column.children.map(item => item.textContent));
    assert.deepEqual(copyColumns(), [
        ['コピー元', 'スイッチA（ポート：1）', 'VLAN設定：access 10'],
        ['コピー先', 'ルーターB（ポート：LAN 1）', `上書き前の VLAN設定：${trunkVlan}`]
    ]);
    await byText(copyDialog(), 'キャンセル').click();
    await cancelOverwrite;
    assert.equal(calls.length, callsBeforeOverwrite);
    assert.equal(copyDialog(), null);
    assert.equal(appState.devicePorts.find(row => row.id === 203).vlan, trunkVlan);

    const cancelReverse = copyFromPeer().click();
    await settle();
    assert.deepEqual(copyColumns(), [
        ['コピー元', 'ルーターB（ポート：LAN 1）', `VLAN設定：${trunkVlan}`],
        ['コピー先', 'スイッチA（ポート：1）', '上書き前の VLAN設定：access 10']
    ]);
    await byText(copyDialog(), 'キャンセル').click();
    await cancelReverse;
    assert.equal(calls.length, callsBeforeOverwrite);

    const staleOverwrite = copyToPeer().click();
    await settle();
    const connected = appState.links[0];
    appState.links[0] = { ...connected, to_port_id: 202 };
    await byText(copyDialog(), '上書きしてコピー').click();
    await staleOverwrite;
    assert.equal(calls.length, callsBeforeOverwrite);
    assert.match(editor().textContent, /接続またはポートが更新/);
    appState.links[0] = connected;

    window.location = { href: 'http://localhost/' };
    const unconfirmed = copyToPeer().click();
    await settle();
    reply = () => response({ ok: false, error: '合成されたコピー応答の失敗' }, 500);
    await byText(copyDialog(), '上書きしてコピー').click();
    await unconfirmed;
    assert.match(panel().textContent, /保存結果が未確認/);
    assert.equal(copyToPeer().disabled, true);
    copyRecoverySnapshot = { ok: true, revision: 20, devices, views, device_ports: appState.devicePorts, links: appState.links };
    assert.equal(appState.devicePorts.find(row => row.id === 203).vlan, trunkVlan);
    await byText(panel(), '保存状態を確認').click();
    assert.equal(getPendingSave(), null);
    assert.match(panel().textContent, /再度コピーしてください/);
    copyRecoverySnapshot = null;
    assert.equal(copyToPeer().disabled, false);

    const overwrite = copyToPeer().click();
    await settle();
    reply = () => maintenanceReply('copy_port_vlan');
    await byText(copyDialog(), '上書きしてコピー').click();
    await overwrite;
    assert.match(panel().textContent, /保守作業中のためコピーされていません/);
    assert.equal(copyToPeer().disabled, true);
    assert.equal(appState.devicePorts.find(row => row.id === 203).vlan, trunkVlan);
    reply = () => response({ ok: false, error: '再試行の応答も未確認' }, 500);
    await byText(panel(), '保存を再試行').click();
    assert.deepEqual(calls.at(-1), calls.at(-2), '承認時のポート ID と版のままコピーを再試行する');
    assert.deepEqual(calls.at(-1), {
        link_id: 100, source_port_id: 1, destination_port_id: 203,
        source_expected_revision: 3, destination_expected_revision: 1
    });
    copyRecoverySnapshot = { ok: true, revision: 20, devices, views, links: appState.links,
        device_ports: appState.devicePorts.map(row => row.id === 203 ? { ...row, vlan: 'access 10', resource_revision: 2 } : row) };
    await byText(panel(), '保存状態を確認').click();
    copyRecoverySnapshot = null;
    assert.match(panel().textContent, /コピー操作の成否は確認できません/);
    assert.equal(appState.devicePorts.find(row => row.id === 203).vlan, 'access 10');

    await edit('port-1');
    await change('portMemo', '未保存のポート備考');
    await change('label', '競合で保存されないラベル');
    reply = () => response({ ok: false, error: '合成された競合', details: { conflicts: [{ resource: 'links', id: 100,
        expected_revision: 6, actual_revision: 9 }] } }, 409);
    await apply();
    assert.equal(get('ledger-port-label').value, '競合で保存されないラベル');
    assert.equal(appState.devicePorts.find(row => row.id === 1).memo, '');
    assert.equal(appState.links[0].label, '元のラベル');
    await byText(panel(), '接続 #100 の競合を再読込').click();
    await apply();
    assert.match(editor().textContent, /編集中の行が更新されました/);
    assert.equal(appState.links[0].label, '他者のラベル');
    await cancel();

    await edit('port-2');
    const connectionFields = ['peerPortName', 'systemId', 'label', 'linkMemo'];
    assert.ok(connectionFields.every(key => get(`ledger-port-${key}`).disabled));
    assert.equal(get('ledger-port-portMemo').disabled, false);
    assert.equal(ownVlan().disabled, false);
    await change('peerId', '未配置C');
    assert.deepEqual(peerOptions(), ['未配置C（#3）']);
    await peerInput().dispatch('keydown', { key: 'Enter' });
    assert.ok(connectionFields.every(key => !get(`ledger-port-${key}`).disabled));
    assert.equal(peerInput().getAttribute('aria-expanded'), 'false');
    assert.match(peerInput().value, /未配置C/);
    await change('peerPortName', ' Ｇｉ１／０／１ ');
    reply = () => response({ ok: false, error: '合成された入力拒否' }, 400);
    await apply();
    assert.equal(getPendingSave(), null);
    assert.equal(appState.devicePorts.some(row => row.device_id === 3), false);
    assert.equal(get('ledger-port-peerPortName').value, 'Gi1/0/1');
    assert.match(editor().textContent, /合成された入力拒否/);
    reply = payload => saved({
        id_maps: { links: { [payload.links[0].id]: 205 } },
        links: [normalizeLink({ id: 205, from_id: 1, from_port_id: 2, to_id: 3, to_port_id: 204, resource_revision: 1 })],
        device_ports: [port(204, 3, 'Gi1/0/1')]
    });
    await apply();
    assert.equal(appState.links.find(link => link.id === 205).to_port_id, 204);
    assert.equal(getCurrentLinks().some(link => link.id === 205), false);
    await byText(row('port-2'), '未配置C').click();
    await edit('port-204');
    await change('portName', 'Gi2/0/1');
    reply = payload => {
        assert.deepEqual(payload.links, []);
        return saved({ device_ports: [port(204, 3, 'Gi2/0/1', '', 2)] });
    };
    await apply();
    assert.equal(appState.links.find(link => link.id === 205).to_port_id, 204);
    await byText(row('port-204'), 'スイッチA').click();
    assert.equal(row('port-2').children[4].textContent, 'Gi2/0/1');

    await edit('port-1');
    appState.legacyLinkVlans = [{ link_id: 100, vlan: '旧 VLAN 10' }];
    window.confirm = text => {
        assert.match(text, /ポートとその VLAN 設定は残ります。.*未移行VLANも削除/s);
        return true;
    };
    reply = () => saved({ deleted_link_ids: [100] });
    await byText(editor(), '接続を解除').click();
    window.confirm = () => true;
    assert.deepEqual(appState.legacyLinkVlans, []);
    assert.equal(tab('ports').textContent, '接続・ポート');
    assert.equal(getCurrentLinks().length, 0);
    assert.equal(row('port-1').children[3].textContent, '未接続');
    assert.equal(row('port-1').children[1].textContent, 'access 10');
    assert.equal(appState.devicePorts.some(row => row.id === 203), true);
    await edit('port-1');
    reply = () => saved({ deleted_device_port_ids: [1] });
    await byText(editor(), 'ポートを削除').click();
    assert.equal(row('port-1'), null);

    await byText(panel(), 'ポートのみ追加').click();
    assert.equal(get('ledger-port-peerId'), null);
    assert.equal(get('ledger-port-linkMemo'), null);
    await change('portName', '　２　');
    const countBeforeDuplicate = calls.length;
    await apply();
    assert.match(editor().textContent, /同じ機器に同名/);
    assert.equal(calls.length, countBeforeDuplicate);
    await change('portName', 'Gi3');
    const vlanAtLimit = '𠀀'.repeat(200);
    await change('vlan', `${vlanAtLimit}𠀀`);
    const countBeforeInvalidVlan = calls.length;
    await apply();
    assert.equal(calls.length, countBeforeInvalidVlan);
    assert.match(editor().textContent, /200 文字以内/);
    assert.equal(document.activeElement, ownVlan());
    assert.equal(ownVlan().value, `${vlanAtLimit}𠀀`);
    await change('vlan', vlanAtLimit);
    assert.doesNotMatch(editor().textContent, /200 文字以内/);
    reply = payload => saved({
        id_maps: { device_ports: { [payload.device_ports[0].id]: 210 } },
        device_ports: [port(210, 1, 'Gi3', '', 1, vlanAtLimit)]
    });
    await apply();
    assert.deepEqual(calls.at(-1).links, []);
    assert.equal(calls.at(-1).device_ports[0].port.vlan, vlanAtLimit);
    assert.equal(row('port-210').children[3].textContent, '未接続');
    await edit('port-210');
    assert.equal(ownVlan().value, vlanAtLimit);
    await change('vlan', '');
    reply = () => saved({ device_ports: [port(210, 1, 'Gi3', '', 2)] });
    await apply();
    assert.equal(calls.at(-1).device_ports[0].port.vlan, '');
    assert.equal(row('port-210').children[1].textContent, '—');

    await edit('port-2');
    await change('portMemo', '保守終了後のポート備考');
    reply = () => maintenanceReply('save_connections');
    await apply();
    assert.match(panel().textContent, /保守作業中のため保存されていません/);
    assert.equal(appState.devicePorts.find(row => row.id === 2).memo, '');
    reply = () => response({ ok: false, error: '再試行時の入力拒否' }, 400);
    await byText(panel(), '保存を再試行').click();
    assert.equal(getPendingSave(), null);
    assert.match(editor().textContent, /再試行時の入力拒否/);
    assert.equal(get('ledger-port-portMemo').value, '保守終了後のポート備考');
    reply = () => maintenanceReply('save_connections');
    await apply();
    reply = () => saved({ device_ports: [port(2, 1, '2', '保守終了後のポート備考', 2)] });
    await byText(panel(), '保存を再試行').click();
    assert.deepEqual(calls.at(-1), calls.at(-2));
    assert.equal(editor(), null);
    assert.equal(appState.devicePorts.find(row => row.id === 2).memo, '保守終了後のポート備考');
    assert.equal(row('port-2').children[2].textContent, '保守終了後のポート備考');

    appState.legacyLinkVlans = [{ link_id: 205, vlan: '旧 VLAN 10' }];
    const completeVlan = () => byText(editor(), '未移行設定削除');
    await edit('port-2');
    assert.ok(!completeVlan().disabled);
    await change('portMemo', '未適用のポート備考');
    assert.equal(completeVlan().disabled, true);
    await change('portMemo', '保守終了後のポート備考');
    assert.equal(completeVlan().disabled, false);
    reply = () => maintenanceReply('save_connections');
    await saveConnectionBatch({ device_ports: [{ operation: 'update', id: 2, expected_revision: 2,
        port: { memo: '別の保存操作' } }], links: [] });
    assert.ok(getPendingSave());
    assert.equal(completeVlan().disabled, true);
    await cancel();
    assert.equal(editor(), null);
    assert.equal(byText(row('port-2'), '未移行設定削除'), undefined);
    await edit('port-2');
    assert.equal(completeVlan().disabled, true, '保存待ちのまま編集を開き直しても削除できない');
    reply = () => saved({ device_ports: [port(2, 1, '2', '別の保存操作', 3)] });
    await flushSaveQueue();
    assert.ok(!completeVlan().disabled);
    await cancel();

    appState.devices.push(normalizeDevice({ id: 4, name: '保存前の機器', type: 'switch' }));
    await byText(panel(), '接続を追加').click();
    assert.equal(document.activeElement, get('ledger-port-portName'));
    assert.equal(editorLabels().length, 8);
    assert.deepEqual(editorLabels().map(text => text.replace('（任意）', '')),
        editLabels.map(text => text.replace('（任意）', '')));
    await change('portName', '一時ポート');
    await change('portMemo', '無効化で消える備考');
    await change('vlan', '無効化で隠れる VLAN');
    await change('portName', '');
    assert.equal(get('ledger-port-portMemo').disabled, true);
    assert.equal(get('ledger-port-portMemo').value, '');
    assert.equal(ownVlan().disabled, true);
    assert.equal(ownVlan().value, '');
    assert.equal(hasUnsavedPortDraft(), false);
    const popup = get('ledger-port-peer-list').parentElement;
    for (const type of ['pointerdown', 'mousedown']) {
        let prevented = false;
        await popup.dispatch(type, { preventDefault() { prevented = true; } });
        assert.equal(prevented, true);
    }
    await change('peerId', '保存前の機器');
    await get('ledger-port-peer-option-4').click();
    const countBeforeUnconfirmedDevice = calls.length;
    await apply();
    assert.match(editor().textContent, /接続先の機器を保存してから/);
    assert.equal(calls.length, countBeforeUnconfirmedDevice);
    await cancel();
    assert.equal(await closeLedgerDetailPane(), true);

    window.APP_CONFIG.user = { role: 'viewer', isAdmin: false };
    assert.equal(await openLedgerDetail(1), true);
    await tab('ports').click();
    assert.equal(byText(panel(), 'ポートのみ追加'), undefined);
    await byText(row('port-2'), '詳細').click();
    assert.equal(get('ledger-port-portMemo').readOnly, true);
    assert.equal(ownVlan().readOnly, true);
    assert.match(row('port-2').textContent, /未移行VLAN：旧 VLAN 10/);
    assert.match(editor().textContent, /未移行VLAN：旧 VLAN 10/);
    assert.equal(completeVlan(), undefined);
    assert.equal(byText(editor(), '未移行設定削除'), undefined);
    assert.match(editor().textContent, /接続先の VLAN設定：未設定/);
    assert.equal(copyFromPeer(), undefined);
    assert.equal(copyToPeer(), undefined);
    assert.equal(byText(editor(), '適用'), undefined);

    await closeLedgerDetailPane();
    window.APP_CONFIG.user = { role: 'admin', isAdmin: true };
    assert.equal(await openLedgerDetail(4, { tab: 'ports' }), true);
    const remappedDevice = appState.devices.find(row => row.id === 4);
    remappedDevice.id = 40;
    remappedDevice.resource_revision = 1;
    resetResourceBaseline(appState);
    eventBus.emit('resources:ids-remapped', { devices: { 4: 40 } });
    await byText(panel(), 'ポートのみ追加').click();
    assert.ok(editor());
    eventBus.emit('resources:reloaded');
    assert.equal(editor(), null);
    assert.equal(hasUnsavedPortDraft(), false);
    await byText(panel(), 'ポートのみ追加').click();
    await change('portName', 'Gi40');
    reply = payload => {
        assert.equal(payload.device_ports[0].port.device_id, 40);
        return saved({
            id_maps: { device_ports: { [payload.device_ports[0].id]: 401 } },
            device_ports: [port(401, 40, 'Gi40', '', 1)]
        });
    };
    await apply();
    await settle();
    assert.ok(row('port-401'));
});
