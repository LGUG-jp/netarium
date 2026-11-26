import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { installWorkspaceDom } from './helpers/workspace-dom.mjs';

test('未移行VLANは対象行で確認し、個票の接続フォームで再設定・削除できる', async () => {
    const { get } = installWorkspaceDom({
        templates: ['templates/modals/ledger.php', 'templates/components/toast.php'], phpSetup: '$isAdmin = true;'
    });
    globalThis.localStorage = { getItem: () => null, setItem() {} };
    const { appState, normalizeDevice, recalculateNextIds } = await import('../public/js/core/state.js');
    const { normalizeDevicePort, normalizeLink } = await import('../public/js/core/connection-data.js');
    const { eventBus } = await import('../public/js/core/event-bus.js');
    const { resetResourceBaseline } = await import('../public/js/core/resource-save.js');
    const { openLedgerDetail, closeLedgerDetailPane } = await import('../public/js/modals/ledger-modal.js');
    const button = (root, label) => root.querySelectorAll('button').find(node => node.textContent === label);
    const row = key => document.querySelector(`[data-port-ledger-key="${key}"]`);
    const tab = () => get('ledger-sheet-tabs').querySelector('[data-tab-key="ports"]');
    const form = () => get('ledger-port-editor');
    const input = key => get(`ledger-port-${key}`);
    const dialog = () => get('ledger-port-vlan-confirm-overlay');
    const removeLabel = '未移行設定削除';
    const open = linkId => openLedgerDetail(1, { tab: 'ports', linkId });
    const apply = () => button(form(), '適用').click();
    const change = async (key, value) => {
        input(key).value = value;
        await input(key).dispatch('input');
    };
    const nextTurn = async () => { await setImmediate(); await setImmediate(); };
    const legacy = id => appState.legacyLinkVlans.find(record => Number(record.link_id) === id);
    const port = id => appState.devicePorts.find(port => port.id === id);
    const link = id => appState.links.find(link => link.id === id);
    const devices = Array.from({ length: 9 }, (_, index) => normalizeDevice({
        id: index + 1, name: `機器 ${index + 1}`, type: 'switch', resource_revision: 1,
    }));
    const ports = [
        { id: 11, device_id: 1, name: 'Gi1', vlan: 'access 5', resource_revision: 4 },
        { id: 12, device_id: 2, name: 'P1', vlan: '', resource_revision: 3 },
        { id: 13, device_id: 1, name: '再利用', vlan: 'access 30', resource_revision: 5, memo: '既存備考' },
        { id: 14, device_id: 1, name: '再設定', vlan: 'access 40', resource_revision: 6 },
        { id: 15, device_id: 1, name: '旧ポート名', vlan: 'access 50', resource_revision: 7 },
    ].map(normalizeDevicePort);
    const links = [
        { id: 99, from_id: 2, to_id: 1, from_port_id: 12, to_port_id: 11, resource_revision: 6 },
        { id: 101, from_id: 3, to_id: 1, resource_revision: 3 },
        { id: 102, from_id: 1, to_id: 4, resource_revision: 3 },
        { id: 103, from_id: 1, to_id: 5, resource_revision: 4 },
        { id: 104, from_id: 1, to_id: 6, from_port_id: 15, resource_revision: 7 },
        { id: 105, from_id: 1, to_id: 7, resource_revision: 1 },
        { id: 106, from_id: 1, to_id: 8, resource_revision: 1 },
        { id: 107, from_id: 1, to_id: 9, resource_revision: 1 },
    ].map(normalizeLink);
    Object.assign(appState, {
        devices, devicePorts: ports, links, dataRevision: 10,
        legacyLinkVlans: links.map(({ id }) => ({ link_id: String(id), vlan: id === 99 ? 'trunk <20>' : `access ${id}` })),
    });
    recalculateNextIds();
    resetResourceBaseline(appState);
    const requests = [];
    let respond;
    globalThis.fetch = async (url, options) => {
        const action = new URL(String(url), 'http://localhost').searchParams.get('action');
        const payload = JSON.parse(options.body);
        requests.push({ action, payload });
        return respond(payload);
    };
    const saved = (detail = {}) => Response.json({
        ok: true, revision: appState.dataRevision + 1, device_ports: [], links: [], views: [],
        deleted_link_ids: [], deleted_device_port_ids: [], removed_view_link_routes: [], id_maps: {}, ...detail,
    });
    const completed = (id, detail = {}) => saved({
        completed_legacy_vlan_link_id: id, links: [{ ...link(id), resource_revision: link(id).resource_revision + 1 }], ...detail,
    });
    const latest = () => requests.at(-1).payload;

    assert.equal(await open(99), true);
    assert.equal(get('ledger-port-legacy-vlans'), null);
    assert.equal(tab().textContent, '接続・ポート（未移行VLAN 8件）');
    assert.equal(row('port-11').children.length, 9);
    assert.equal(row('port-11').children[1].querySelector('.port-ledger-legacy-value').textContent, '未移行VLAN：trunk <20>');
    assert.equal(document.activeElement, form().querySelector('.port-ledger-legacy-value'));
    assert.equal(input('vlan').value, 'access 5', '未移行の値は自動転記しない');
    assert.match(form().textContent, /接続先の VLAN設定：未設定/);
    await change('portMemo', 'ポート備考だけ変更');
    await change('label', '共通ラベル');
    respond = () => saved({
        links: [{ ...link(99), label: '共通ラベル', resource_revision: 7 }],
        device_ports: [{ ...port(11), memo: 'ポート備考だけ変更', resource_revision: 5 }],
    });
    await apply();
    assert.equal(latest().complete_legacy_vlan, undefined);
    assert.ok(legacy(99));

    await open(99);
    await change('vlan', 'x'.repeat(201));
    await apply();
    assert.equal(requests.length, 1);
    assert.match(form().textContent, /200 文字以内/);
    assert.equal(document.activeElement, input('vlan'));
    assert.ok(legacy(99));
    await change('vlan', 'access 18');
    assert.equal(button(form(), removeLabel).disabled, true);
    assert.equal(button(row('port-11'), removeLabel), undefined);
    await button(form(), removeLabel).click();
    assert.equal(dialog(), null);
    assert.equal(input('vlan').value, 'access 18');
    respond = () => Response.json({ ok: false, error: '入力を拒否しました' }, { status: 400 });
    await apply();
    assert.equal(requests.at(-1).action, 'save_connections');
    assert.deepEqual(latest(), {
        complete_legacy_vlan: 99,
        device_ports: [{ operation: 'update', id: 11, expected_revision: 5,
            port: { device_id: 1, name: 'Gi1', memo: 'ポート備考だけ変更', vlan: 'access 18' } }],
        links: [{ operation: 'update', id: 99, expected_revision: 7, link: {} }],
    });
    assert.match(form().textContent, /入力を拒否しました/);
    const sent = Promise.withResolvers();
    const release = Promise.withResolvers();
    respond = () => {
        sent.resolve();
        return release.promise;
    };
    const saving = apply();
    await Promise.race([sent.promise, saving.then(() => assert.fail('再設定の保存を送信していません'))]);
    assert.equal(port(11).vlan, 'access 5');
    assert.ok(legacy(99), '保存応答までは未移行表示を残す');
    release.resolve(completed(99, { device_ports: [{ ...port(11), vlan: 'access 18', resource_revision: 6 }] }));
    await saving;
    assert.equal(port(11).vlan, 'access 18');
    assert.equal(port(12).vlan, '');
    assert.equal(form(), null);
    assert.equal(legacy(99), undefined);
    assert.equal(tab().textContent, '接続・ポート（未移行VLAN 7件）');

    await open(101);
    assert.equal(input('vlan').disabled, true);
    await change('portName', ' Ｇｉ９ ');
    assert.equal(input('vlan').disabled, false);
    assert.equal(input('vlan').value, '');
    await change('vlan', 'access 101');
    const collision = normalizeDevicePort({ id: 30, device_id: 1, name: 'Gi9', vlan: '他者の設定', resource_revision: 1 });
    appState.devicePorts.push(collision);
    eventBus.emit('resource:reloaded', { kind: 'device_ports', id: 30 });
    const beforeCollision = requests.length;
    await apply();
    assert.equal(requests.length, beforeCollision);
    assert.match(form().textContent, /ポートが更新されました/);
    assert.equal(input('vlan').value, 'access 101');
    assert.equal(port(30).vlan, '他者の設定');
    appState.devicePorts = appState.devicePorts.filter(port => port.id !== collision.id);
    button(form(), 'キャンセル').click();
    await open(101);
    await change('portName', ' Ｇｉ１０ ');
    await change('vlan', 'access 101');
    respond = payload => completed(101, {
        id_maps: { device_ports: { [payload.device_ports[0].id]: 31 } },
        links: [{ ...link(101), to_port_id: 31, resource_revision: 4 }],
        device_ports: [{ id: 31, device_id: 1, name: 'Gi10', vlan: 'access 101', resource_revision: 1 }],
    });
    await apply();
    assert.equal(latest().complete_legacy_vlan, 101);
    assert.deepEqual(latest().links, [{ operation: 'update', id: 101, expected_revision: 3, link: { to_port_name: 'Gi10' } }]);
    assert.equal(latest().device_ports[0].operation, 'create');
    assert.deepEqual(latest().device_ports[0].port, { device_id: 1, name: 'Gi10', memo: '', vlan: 'access 101' });
    assert.equal(document.activeElement, button(row('port-31'), '編集'));
    assert.equal(legacy(101), undefined);

    await open(102);
    await change('portName', '再利用');
    assert.equal(input('vlan').value, 'access 30');
    assert.equal(input('portMemo').readOnly, true);
    respond = () => completed(102, { links: [{ ...link(102), from_port_id: 13, resource_revision: 4 }] });
    await apply();
    assert.equal(latest().complete_legacy_vlan, 102);
    assert.deepEqual(latest().device_ports, []);
    assert.deepEqual(latest().links[0].link, { from_port_id: 13 });
    assert.equal(port(13).vlan, 'access 30');
    assert.equal(port(13).memo, '既存備考');
    assert.equal(legacy(102), undefined);

    await open(103);
    await change('portName', '再設定');
    assert.equal(input('vlan').value, 'access 40');
    assert.equal(input('vlan').readOnly, false);
    await change('vlan', 'access 43');
    respond = () => completed(103, {
        links: [{ ...link(103), from_port_id: 14, resource_revision: 5 }],
        device_ports: [{ ...port(14), vlan: 'access 43', resource_revision: 7 }],
    });
    await apply();
    assert.deepEqual(latest().device_ports, [{ operation: 'update', id: 14, expected_revision: 6, port: { vlan: 'access 43' } }]);
    assert.deepEqual(latest().links[0].link, { from_port_id: 14 });
    assert.equal(legacy(103), undefined);

    await open(104);
    await change('portName', '新ポート名');
    respond = () => saved({ device_ports: [{ ...port(15), name: '新ポート名', resource_revision: 8 }] });
    await apply();
    assert.equal(latest().complete_legacy_vlan, undefined);
    assert.equal(latest().device_ports[0].port.vlan, undefined);
    assert.equal(port(15).vlan, 'access 50');
    assert.ok(legacy(104));

    const confirmDelete = async (control, confirmLabel) => {
        control.focus();
        const deleting = control.click();
        await nextTurn();
        assert.match(dialog().textContent, /ポートのVLAN設定は変更せず/);
        assert.equal(await closeLedgerDetailPane(), false, '削除確認中は個票を閉じない');
        await button(dialog(), confirmLabel).click();
        await deleting;
    };
    assert.equal(await open(105), true);
    await change('portName', 'VLAN未設定のポート');
    respond = payload => saved({
        id_maps: { device_ports: { [payload.device_ports[0].id]: 32 } },
        device_ports: [{ id: 32, device_id: 1, name: 'VLAN未設定のポート', vlan: '', resource_revision: 1 }],
        links: [{ ...link(105), from_port_id: 32, resource_revision: 2 }],
    });
    await apply();
    assert.equal(latest().complete_legacy_vlan, undefined);
    assert.equal(port(32).vlan, '');
    assert.ok(legacy(105));
    assert.equal(await open(105), true);
    const notice = form().querySelector('.port-ledger-legacy-value');
    const editorDelete = () => button(form(), removeLabel);
    assert.equal(notice.parentElement, editorDelete().parentElement);
    appState.isPinging = true;
    eventBus.emit('ledger:render');
    assert.equal(editorDelete().disabled, true);
    appState.isPinging = false;
    eventBus.emit('ledger:render');
    assert.equal(editorDelete().disabled, false);
    const beforeDelete = requests.length;
    await confirmDelete(editorDelete(), 'キャンセル');
    assert.equal(requests.length, beforeDelete);
    assert.equal(document.activeElement, editorDelete());

    respond = () => Response.json({ ok: false, error: '削除を拒否しました' }, { status: 409 });
    await confirmDelete(editorDelete(), removeLabel);
    assert.ok(legacy(105));
    assert.equal(document.activeElement, editorDelete());

    respond = payload => saved({ link_id: payload.link_id });
    const expectedRevision = appState.dataRevision;
    await confirmDelete(editorDelete(), removeLabel);
    assert.deepEqual(requests.at(-1), { action: 'complete_legacy_link_vlan', payload: {
        link_id: 105, expected_revision: expectedRevision, link_expected_revision: 2,
    } });
    assert.equal(legacy(105), undefined);
    assert.equal(form().querySelector('.port-ledger-legacy-value'), null);
    assert.equal(document.activeElement, input('portName'));

    await open(106);
    await confirmDelete(button(form(), removeLabel), removeLabel);
    assert.equal(legacy(106), undefined);
    assert.equal(form().querySelector('.port-ledger-legacy-value'), null);
    assert.equal(document.activeElement, input('portName'));
    assert.equal(tab().textContent, '接続・ポート（未移行VLAN 2件）');
    await open(107);
    await change('portName', '未保存ポート');
    await change('vlan', 'access 107');
    respond = () => Response.json({ ok: false, error: '別の利用者が更新しました',
        details: { conflicts: [{ resource: 'links', id: 107, expected_revision: 1, actual_revision: 2 }] }
    }, { status: 409 });
    await apply();
    assert.match(form().textContent, /別の利用者が更新しました/);
    assert.equal(input('vlan').value, 'access 107');
    assert.ok(legacy(107));
    assert.equal(link(107).from_port_id, null);
    const conflicts = requests.length;
    await apply();
    assert.equal(requests.length, conflicts, '競合の対象を再読込するまでは再送しない');
    await button(form(), 'キャンセル').click();
    assert.equal(await closeLedgerDetailPane(), true);

    window.APP_CONFIG.user = { role: 'viewer', isAdmin: false };
    assert.equal(await open(107), true);
    assert.equal(document.activeElement, form().querySelector('.port-ledger-legacy-value'));
    assert.match(row('link-107').textContent, /未移行VLAN：access 107/);
    assert.equal(button(row('link-107'), removeLabel), undefined);
    assert.equal(button(form(), removeLabel), undefined);
    assert.equal(button(form(), '適用'), undefined);
    assert.equal(await closeLedgerDetailPane(), true);
});
