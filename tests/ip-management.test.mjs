import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cidrRange, segmentAddressPage, segmentCandidates, ipStatistics, pingReachabilityWarnings } from '../public/js/core/ip-management.js';
import { appState, normalizeDevice, toSaveDevice } from '../public/js/core/state.js';
import { confirmDeviceIpChanges, newDeviceIpConflicts } from '../public/js/core/device-ip-addresses.js';
import { createIpDuplicateNotice } from '../public/js/ui/ip-duplicate-notice.js';
import { installWorkspaceDom } from './helpers/workspace-dom.mjs';

const segments = [
    { id: 1, address_space_id: 1, cidr: '192.0.2.0/24', name: '本番', facility: '東', vlan_id: 10 },
    { id: 2, address_space_id: 2, cidr: '192.0.2.0/24', name: '検証', facility: '西', vlan_id: 20 }
];
test('巨大なCIDRでも50件のみ生成し、IPv4数値順と/0末尾を維持する', () => {
    const first = segmentAddressPage({ cidr: '0.0.0.0/0' }, [], 0, { includeUnregistered: true });
    assert.equal(first.rows.length, 50);
    assert.equal(first.rows[0].ip, '0.0.0.0');
    assert.equal(first.total, 4294967296);
    const last = segmentAddressPage({ cidr: '0.0.0.0/0' }, [], first.pages - 1, { includeUnregistered: true });
    assert.equal(last.rows.at(-1).ip, '255.255.255.255');
    assert.ok(last.rows.length <= 50);
    assert.equal(segmentAddressPage({ cidr: '192.0.2.0/24' }, [], 5, { includeUnregistered: true }).rows.length, 6);
    assert.equal(cidrRange('192.0.2.0/33'), null);
});
test('/31・/32の全アドレスと同一IPのすべての登録を表示する', () => {
    const records = [{ ip: '192.0.2.0', device_id: 1 }, { ip: '192.0.2.0', device_id: 2 }];
    const page = segmentAddressPage({ cidr: '192.0.2.0/31' }, records, 0, { includeUnregistered: true });
    assert.deepEqual(page.rows.map(row => row.ip), ['192.0.2.0', '192.0.2.1']);
    assert.equal(page.rows[0].records.length, 2);
    assert.equal(segmentAddressPage({ cidr: '192.0.2.0/32' }, records).rows.length, 1);
    assert.deepEqual(ipStatistics(records), { unique: 1, records: 2, duplicates: 1 });
});
test('別空間の再利用は許可し、同空間の新規重複は拒否し、未分類だけを確認する', () => {
    appState.ipSegments = segments;
    const before = [normalizeDevice({ id: 1, name: '甲', ip: '192.0.2.1', ip_segment_id: 1 }), normalizeDevice({ id: 2, name: '乙', ip: '192.0.2.2', ip_segment_id: 2 })];
    const reused = before.map(row => ({ ...row, ip: '192.0.2.1' }));
    assert.equal(newDeviceIpConflicts(before, reused).length, 0);
    const collision = reused.map(row => ({ ...row, ip_segment_id: 1 }));
    assert.throws(() => confirmDeviceIpChanges(before, collision), /同じアドレス空間/);
    const unclassified = reused.map(row => ({ ...row, ip_segment_id: null }));
    assert.equal(confirmDeviceIpChanges(before, unclassified, () => false), false);
    assert.equal(unclassified[0].ip_conflicts_confirmed, undefined);
    assert.equal(confirmDeviceIpChanges(before, unclassified, text => { assert.match(text, /機器ID 1/); assert.match(text, /機器ID 2/); return true; }), true);
    assert.equal(toSaveDevice(unclassified[0]).ip_conflicts_confirmed, true);
    assert.equal(confirmDeviceIpChanges(unclassified, unclassified, () => { throw new Error('既存重複の再確認'); }), true);
    const normalized = normalizeDevice(toSaveDevice(unclassified[0]));
    assert.equal(normalized.ip_segment_id, null);
    assert.equal(normalized.ip_conflicts_confirmed, undefined);
});
test('所属は選択UIも未分類案内も持たず、一意のみ自動所属する', async t => {
    const dom = installWorkspaceDom();
    t.after(() => dom.cleanup?.());
    appState.addressSpaces = [{ id: 1, name: '本番空間' }, { id: 2, name: '検証空間' }];
    appState.ipSegments = segments;
    const record = { ip: '192.0.2.1', ip_segment_id: 1 };
    const input = document.createElement('input');
    const notice = createIpDuplicateNotice({ getRecord: () => record, field: 'ip_segment_id', canEdit: () => true, onChange() {}, ipInput: input });
    assert.equal(notice.querySelector('select'), null);
    assert.equal(segmentCandidates(record.ip, segments).length, 2);
    input.value = '192.0.2.2'; await input.dispatch('input');
    assert.equal(record.ip_segment_id, null);
    assert.equal(notice.hidden, true);
    assert.doesNotMatch(notice.textContent, /未分類|IP管理/);
    appState.ipSegments = [segments[0]];
    input.value = '192.0.2.3'; await input.dispatch('input'); assert.equal(record.ip_segment_id, 1);
    input.value = '198.51.100.1'; await input.dispatch('input'); assert.equal(record.ip_segment_id, null);
    record.ip_segment_id = 2;
    const viewerInput = document.createElement('input');
    createIpDuplicateNotice({ getRecord: () => record, field: 'ip_segment_id', canEdit: () => false, onChange() { throw new Error('閲覧者の更新'); }, ipInput: viewerInput });
    viewerInput.value = '192.0.2.4'; await viewerInput.dispatch('input');
    assert.equal(record.ip_segment_id, 2);
});

test('IP管理の階層・一括作成・候補選択・409保持・閲覧権限を実イベントで確認する', async t => {
    const dom = installWorkspaceDom({ templates: ['templates/components/status_bar.php'] });
    const { openIpManagement, closeIpManagement } = await import('../public/js/modals/ip-management-modal.js');
    const { resetResourceBaseline } = await import('../public/js/core/resource-save.js');
    const { discardDeviceDrafts, getDeviceDraft } = await import('../public/js/core/device-drafts.js');
    const { setImmediate } = await import('node:timers/promises');
    const previousFetch = globalThis.fetch, original = { ...appState };
    Object.assign(appState, { devices: [], views: [], links: [], placements: [], canvasNotes: [],
        floorPlans: [], rackSettings: [], rackMounts: [], rackShelves: [], rackShelfDevices: [], floorRackPlacements: [],
        authExpired: false, isPinging: false });
    discardDeviceDrafts(); resetResourceBaseline(appState);
    window.confirm = () => { throw new Error('window.confirmは使用しない'); };
    const requests = [];
    let snapshot = { status: 'success', revision: 7, address_spaces: [], ip_segments: [], ip_records: [], devices: [] };
    let conflict = false, loadError = false, duringLoad = null, serverError = false;
    globalThis.fetch = async (url, options = {}) => {
        const action = new URL(url, 'http://localhost').searchParams.get('action');
        const input = options.body ? JSON.parse(options.body) : null;
        requests.push({ action, input });
        if (action === 'load_ip_management') {
            if (loadError) throw new Error('取得失敗');
            if (duringLoad) await duringLoad();
        }
        if (conflict && action !== 'load_ip_management') return new Response(JSON.stringify({ error: '競合しています' }), { status: 409 });
        if (serverError && action === 'reclassify_ips') return new Response(JSON.stringify({ error: '再分類の保存失敗' }), { status: 500 });
        if (action === 'create_ip_network') snapshot = { ...snapshot, revision: snapshot.revision + 1, address_spaces: [{ id: 1, name: input.name }, ...snapshot.address_spaces.filter(row => row.id !== 1)],
            ip_segments: [{ id: 11, address_space_id: 1, ...input.segment }], created_address_space_id: 1, created_segment_id: 11 };
        if (action === 'save_ip_segment') snapshot = { ...snapshot, revision: snapshot.revision + 1,
            ip_segments: input.id ? snapshot.ip_segments.map(row => row.id === input.id ? { ...row, ...input } : row)
                : [...snapshot.ip_segments, { id: 13, ...input }] };
        return new Response(JSON.stringify(snapshot));
    };
    const settle = async () => { for (let i = 0; i < 5; i++) await setImmediate(); };
    const confirmModal = async (choice = 'confirm') => {
        const modal = document.getElementById('ip-management-confirm-overlay');
        assert.ok(modal && !modal.hidden, '確認モーダルが表示されている');
        const text = modal.textContent;
        const btn = modal.querySelector(`[data-confirm-action="${choice}"]`);
        assert.ok(btn, `confirm button ${choice}`);
        await btn.dispatch('click');
        await settle();
        return text;
    };
    const click = async (text, autoConfirm = true) => {
        const target = overlay.querySelectorAll('button').find(button => (button.getAttribute('aria-label') || button.textContent) === text);
        assert.ok(target, `button ${text}`); await target.dispatch('click'); await settle();
        if (autoConfirm && document.getElementById('ip-management-confirm-overlay')) await confirmModal('confirm');
    };
    const submitForm = async (panel, autoConfirm = true) => {
        await panel.dispatch('submit'); await settle();
        if (autoConfirm && document.getElementById('ip-management-confirm-overlay')) await confirmModal('confirm');
    };
    const fill = async (panel, name, value) => {
        const input = panel.querySelector(`[name="${name}"]`);
        assert.ok(input, name); input.value = value; await input.dispatch('input'); return input;
    };
    t.after(async () => {
        discardDeviceDrafts();
        const closing = closeIpManagement();
        if (closing && typeof closing.then === 'function') {
            if (document.getElementById('ip-management-confirm-overlay')) await confirmModal('confirm');
            await closing;
        }
        Object.assign(appState, original); resetResourceBaseline(appState); globalThis.fetch = previousFetch; dom.cleanup?.();
    });
    window.APP_CONFIG.user.isAdmin = false;
    await openIpManagement();
    const overlay = document.getElementById('ip-management-overlay');
    assert.ok(!overlay.querySelectorAll('button').some(button => button.textContent === 'ネットワークを登録'));
    assert.match(overlay.textContent, /ネットワークは未登録/);
    closeIpManagement(); window.APP_CONFIG.user.isAdmin = true; await openIpManagement();
    const header = overlay.querySelector('.modal-header');
    assert.deepEqual(header.querySelectorAll('button').map(button => button.textContent), ['更新', '×']);
    const close = header.querySelector('.modal-close-btn');
    assert.equal(close.type, 'button'); assert.equal(close.getAttribute('aria-label'), '閉じる');
    assert.ok(header.querySelectorAll('button')[0].classList.contains('btn-secondary'));
    const registration = overlay.querySelectorAll('button').find(button => button.textContent === 'ネットワークを登録');
    assert.ok(registration.parentElement.classList.contains('ip-management-section-header'));
    assert.ok(registration.classList.contains('btn-primary'));
    await click('ネットワークを登録');
    let panel = overlay.querySelector('form');
    assert.equal(overlay.querySelector('input[type="search"]'), null);
    assert.ok(!overlay.querySelectorAll('button').some(button => button.textContent === 'ネットワークを登録'));
    assert.deepEqual(panel.querySelector('.ip-management-actions').querySelectorAll('button').map(button => button.textContent), ['キャンセル', '登録']);
    assert.ok(panel.querySelector('.btn-cancel'));
    await fill(panel, 'name', '本番'); await fill(panel, 'segment_name', 'LAN');
    await fill(panel, 'cidr', 'invalid');
    assert.match(panel.textContent, /有効なIPv4 CIDR/);
    await fill(panel, 'cidr', '192.0.2.7/32');
    assert.match(panel.textContent, /192.0.2.7 ～ 192.0.2.7 \/ ホスト数: 1/);
    await fill(panel, 'cidr', '192.0.2.17/24');
    assert.match(panel.textContent, /192.0.2.0\/24.*255.255.255.0/s);
    assert.match(panel.textContent, /192.0.2.1 ～ 192.0.2.254 \/ ホスト数: 254/);
    await panel.dispatch('submit'); await settle();
    assert.equal(requests.at(-1).action, 'create_ip_network');
    assert.equal(requests.at(-1).input.expected_revision, 7);
    assert.equal(requests.at(-1).input.segment.cidr, '192.0.2.0/24');
    assert.equal(requests.at(-1).input.segment.vlan_id, null);
    assert.equal(overlay.querySelector('form'), null);
    assert.match(overlay.textContent, /現在位置: ネットワーク区分一覧 › 本番 › LAN/);
    assert.equal(overlay.querySelectorAll('h3').length, 1);
    assert.match(overlay.textContent, /登録済みのIPはありません/);
    assert.match(overlay.textContent, /0 \/ 0ページ/);
    let checkbox = overlay.querySelectorAll('input').find(input => input.type === 'checkbox');
    checkbox.checked = true; await checkbox.dispatch('change');
    assert.equal(overlay.querySelectorAll('tr').length, 51);
    await click('次の50件'); assert.match(overlay.querySelector('table').textContent, /192.0.2.50/);
    checkbox = overlay.querySelectorAll('input').find(input => input.type === 'checkbox');
    checkbox.checked = false; await checkbox.dispatch('change'); assert.match(overlay.textContent, /0 \/ 0ページ/);
    await click('本番');
    assert.match(overlay.textContent, /セグメントを追加/);
    assert.equal(overlay.querySelector('table'), null);
    await click('セグメントを追加');
    assert.equal(overlay.querySelector('form').querySelectorAll('input').find(input => input.name === 'address_space_id'), undefined);
    panel = overlay.querySelector('form');
    await fill(panel, 'name', '第二LAN'); await fill(panel, 'cidr', '198.51.100.0/24');
    await panel.dispatch('submit'); await settle();
    assert.equal(requests.at(-1).action, 'save_ip_segment');
    assert.equal(requests.at(-1).input.address_space_id, 1);
    assert.match(overlay.textContent, /現在位置: ネットワーク区分一覧 › 本番 › 第二LAN/);
    snapshot = { ...snapshot, address_spaces: [...snapshot.address_spaces, { id: 2, name: '検証' }] };
    await click('更新'); await click('セグメントを編集');
    panel = overlay.querySelector('form');
    assert.deepEqual(panel.querySelector('.ip-management-actions').querySelectorAll('button').map(button => button.textContent), ['削除', 'キャンセル', '保存']);
    assert.ok(panel.querySelector('.btn-danger').classList.contains('btn-secondary'));
    const parentSpace = panel.querySelector('select'); parentSpace.value = '2'; await parentSpace.dispatch('change');
    await submitForm(panel);
    assert.equal(requests.at(-1).input.address_space_id, 2);
    assert.match(overlay.textContent, /現在位置: ネットワーク区分一覧 › 検証 › 第二LAN/);
    await click('ネットワーク区分一覧');
    snapshot = { ...snapshot, ip_records: Array.from({ length: 80 }, (_, index) => ({
        device_id: index + 1, device_name: index >= 60 ? 'ページ外対象' : '通常', kind: 'management', id: null,
        ip: `192.0.2.${index + 1}`, segment_id: 11, address_space_id: 1
    })) };
    await click('更新'); await click('本番'); await click('LAN / 192.0.2.0/24');
    await click('次の50件'); assert.match(overlay.textContent, /2 \/ 2ページ/);
    const search = overlay.querySelectorAll('input').find(input => input.type === 'search');
    search.focus(); search.value = 'ページ外対象'; search.setSelectionRange(6, 6); await search.dispatch('input');
    assert.ok(document.activeElement === search); assert.ok(overlay.querySelector('input[type="search"]') === search);
    assert.equal(search.selectionStart, 6);
    assert.match(overlay.textContent, /1 \/ 1ページ（検索一致 20 IP）/);
    assert.match(overlay.querySelector('table').textContent, /192.0.2.61/);
    assert.equal(overlay.querySelectorAll('tr').length, 21);
    await click('ネットワーク区分一覧');
    snapshot = { ...snapshot, ip_segments: [...snapshot.ip_segments, { id: 12, address_space_id: 2, name: '重複範囲', cidr: '192.0.2.0/24' }],
        ip_records: [{ device_id: 1, device_name: '甲', kind: 'management', id: null, ip: '192.0.2.5', segment_id: null }] };
    await click('更新'); await click('未分類IP');
    const chooseUnclassified = async key => {
        const checkbox = overlay.querySelector(`[data-membership-key="${key}"]`);
        assert.ok(checkbox); checkbox.checked = true; await checkbox.dispatch('change');
    };
    await chooseUnclassified('1:management:');
    let select = overlay.querySelector('.ip-management-membership-select');
    select.value = '12'; await select.dispatch('change');
    select = overlay.querySelector('.ip-management-membership-select');
    serverError = true; await click('指定先へ再分類');
    assert.match(overlay.textContent, /再分類の保存失敗/);
    assert.equal(overlay.querySelector('[data-membership-key="1:management:"]').checked, true);
    assert.equal(overlay.querySelector('.ip-management-membership-select').value, '12');
    serverError = false; conflict = true; await click('指定先へ再分類');
    assert.equal(requests.at(-1).action, 'reclassify_ips');
    assert.equal(requests.at(-1).input.records[0].segment_id, 12);
    assert.ok(overlay.querySelector('select') === select); assert.equal(select.value, '12');
    assert.match(overlay.textContent, /入力は保持/);
    { const closing = closeIpManagement(); await settle(); await confirmModal('cancel'); assert.equal(await closing, false); }
    conflict = false; snapshot = { ...snapshot, revision: snapshot.revision + 1 };
    loadError = true; await click('入力を保持して最新情報を取得');
    assert.match(overlay.textContent, /取得失敗/);
    assert.equal(overlay.querySelector('[data-membership-key="1:management:"]').checked, true);
    loadError = false;
    await click('入力を保持して最新情報を取得');
    assert.equal(overlay.querySelector('select').value, '12');
    await click('指定先へ再分類');
    assert.equal(requests.at(-1).input.expected_revision, snapshot.revision);
    assert.equal(requests.at(-1).input.records[0].id, null);
    await click('ネットワーク区分一覧'); await click('ネットワークを登録'); panel = overlay.querySelector('form');
    const name = await fill(panel, 'name', '保持する区分名');
    await fill(panel, 'segment_name', '保持するセグメント'); await fill(panel, 'cidr', '192.0.2.0/31');
    for (const [field, value] of [['memo', '区分の保持メモ'], ['purpose', '保持する用途'], ['facility', '保持する施設'], ['vlan_id', '123'], ['segment_memo', '保持するセグメントメモ']]) await fill(panel, field, value);
    assert.match(panel.textContent, /192.0.2.0 ～ 192.0.2.1 \/ ホスト数: 2/);
    conflict = true; await panel.dispatch('submit'); await settle();
    assert.ok(overlay.querySelector('form') === panel); assert.equal(name.value, '保持する区分名');
    assert.match(overlay.textContent, /入力は保持/);
    { const closing = closeIpManagement(); await settle(); await confirmModal('cancel'); assert.equal(await closing, false); }
    const retained = Object.fromEntries(panel.querySelectorAll('input, textarea, select').map(input => [input.name, input.value]));
    const failedRevision = requests.at(-1).input.expected_revision;
    const assertRetained = () => assert.deepEqual(Object.fromEntries(overlay.querySelector('form').querySelectorAll('input, textarea, select').map(input => [input.name, input.value])), retained);
    const recoveryButton = () => overlay.querySelectorAll('button').find(button => button.textContent === '入力を保持して最新情報を取得');
    assert.equal(recoveryButton().hidden, false);
    let requestCount = requests.length;
    await click('更新', false); await confirmModal('cancel');
    assert.equal(requests.length, requestCount); assertRetained();
    window.APP_CONFIG.user.isAdmin = false;
    await click('入力を保持して最新情報を取得');
    assert.equal(requests.length, requestCount); assertRetained();
    window.APP_CONFIG.user.isAdmin = true;
    loadError = true; await click('入力を保持して最新情報を取得');
    assertRetained(); assert.match(overlay.textContent, /取得失敗/);
    assert.equal(recoveryButton().hidden, false);
    loadError = false;
    snapshot = { ...snapshot, revision: failedRevision + 5, devices: [{ id: 1, name: '最新の機器', ip: '192.0.2.5', resource_revision: 2 }] };
    appState.devices = [normalizeDevice({ id: 1, name: '保存済み', ip: '192.0.2.5', resource_revision: 1 })]; resetResourceBaseline(appState);
    appState.devices[0].name = '機器の未保存変更';
    let before = requests.length;
    await click('入力を保持して最新情報を取得');
    assert.equal(requests.length, before); assertRetained();
    assert.equal(appState.devices[0].name, '機器の未保存変更');
    appState.devices[0].name = '保存済み';
    getDeviceDraft('ip-recovery-test', 1).name = '未保存のdraft';
    await click('入力を保持して最新情報を取得');
    assert.equal(requests.length, before); assertRetained();
    discardDeviceDrafts();
    duringLoad = () => { getDeviceDraft('ip-recovery-test', 1).name = '通信中のdraft'; };
    await click('入力を保持して最新情報を取得');
    assertRetained(); assert.match(overlay.textContent, /取得中に未保存/);
    assert.equal(appState.devices[0].name, '保存済み');
    assert.equal(recoveryButton().hidden, false);
    discardDeviceDrafts(); duringLoad = null;
    // 失敗した取得では旧revisionのまま。復旧前の明示保存も自動再送もしない。
    before = requests.length;
    await overlay.querySelector('form').dispatch('submit'); await settle();
    assert.equal(requests.length, before);
    conflict = false; await click('入力を保持して最新情報を取得');
    assertRetained(); assert.equal(recoveryButton().hidden, true);
    assert.equal(appState.devices[0].name, '最新の機器');
    const { hasPendingChanges } = await import('../public/js/core/save-queue.js');
    assert.equal(hasPendingChanges(), false, '採用したdevicesを保存baselineにも同期する');
    assert.equal(requests.at(-1).action, 'load_ip_management', '復旧取得後に自動保存しない');
    const recoveredRevision = snapshot.revision;
    await overlay.querySelector('form').dispatch('submit'); await settle();
    assert.equal(requests.at(-1).action, 'create_ip_network');
    assert.equal(requests.at(-1).input.expected_revision, recoveredRevision);
    assert.equal(requests.at(-1).input.name, retained.name);

    // 最新existingの所属を基準に、保持した入力による影響件数を確認する。
    await click('セグメントを編集'); panel = overlay.querySelector('form');
    await fill(panel, 'name', '保持した編集名'); await fill(panel, 'memo', '保持するメモ');
    const moveTo = panel.querySelector('select'); moveTo.value = '2'; await moveTo.dispatch('change');
    conflict = true; await submitForm(panel);
    snapshot = { ...snapshot, revision: 30,
        ip_segments: snapshot.ip_segments.map(row => ({ ...row, name: '他の管理者の最新名', memo: '最新メモ' })),
        ip_records: [{ device_id: 1, kind: 'management', id: null, ip: '192.0.2.0', segment_id: 11, address_space_id: 1 }] };
    await click('入力を保持して最新情報を取得');
    panel = overlay.querySelector('form');
    assert.equal(panel.querySelectorAll('input').find(input => input.name === 'name').value, '保持した編集名');
    assert.equal(panel.querySelector('textarea').value, '保持するメモ');
    assert.equal(panel.querySelector('select').value, '2');
    assert.equal(panel.querySelectorAll('button').find(button => button.type === 'submit').disabled, true);
    before = requests.length; await panel.dispatch('submit'); await settle(); assert.equal(requests.length, before);
    assert.match(panel.textContent, /入力した値: 保持した編集名/);
    assert.match(panel.textContent, /最新の値: 他の管理者の最新名/);
    await click('入力した値を使用'); await click('入力した値を使用');
    panel = overlay.querySelector('form');
    await submitForm(panel, false);
    let confirmation = await confirmModal('cancel');
    assert.match(confirmation, /所属を再確認する登録は1件/);
    await click('削除', false);
    confirmation = await confirmModal('cancel');
    assert.match(confirmation, /他の管理者の最新名/);
    conflict = false; await submitForm(panel);
    assert.equal(requests.at(-1).input.expected_revision, 30);
    assert.equal(requests.at(-1).input.name, '保持した編集名');

    // 同IDでも別区分へ移動された編集対象は復活させず、コピー可能なまま保存禁止。
    await click('セグメントを編集'); panel = overlay.querySelector('form');
    await fill(panel, 'name', '移動後もコピーできる名前');
    conflict = true; await submitForm(panel);
    snapshot = { ...snapshot, revision: 32, ip_segments: snapshot.ip_segments.map(row => ({ ...row, address_space_id: 1 })) };
    await click('入力を保持して最新情報を取得');
    panel = overlay.querySelector('form');
    assert.match(panel.textContent, /削除または移動/);
    assert.equal(panel.querySelectorAll('input').find(input => input.name === 'name').value, '移動後もコピーできる名前');
    assert.equal(panel.querySelectorAll('button').find(button => button.type === 'submit').disabled, true);
    before = requests.length; await panel.dispatch('submit'); await settle(); assert.equal(requests.length, before);
    await click('キャンセル'); await click('ネットワーク区分一覧'); await click('保持する区分名'); await click('保持した編集名 / 192.0.2.0/31');
    await click('セグメントを編集'); panel = overlay.querySelector('form');
    conflict = true; await submitForm(panel);
    snapshot = { ...snapshot, revision: 33, ip_segments: [] };
    await click('入力を保持して最新情報を取得');
    assert.match(overlay.querySelector('form').textContent, /削除または移動/);
    before = requests.length; await overlay.querySelector('form').dispatch('submit'); await settle(); assert.equal(requests.length, before);
    await click('キャンセル'); await click('ネットワーク区分一覧');

    // 復旧で候補や登録が変わった選択は送信できず、最新状態で選び直す。
    snapshot = { ...snapshot, revision: 34, ip_segments: segments,
        ip_records: Array.from({ length: 5 }, (_, index) => ({ device_id: index + 1, kind: 'management', id: null, ip: `192.0.2.${index + 1}`, segment_id: null })) };
    await click('更新'); await click('未分類IP');
    for (let id = 1; id <= 5; id++) await chooseUnclassified(`${id}:management:`);
    select = overlay.querySelector('.ip-management-membership-select');
    select.value = '1'; await select.dispatch('change');
    await click('指定先へ再分類');
    snapshot = { ...snapshot, revision: 35,
        ip_segments: [segments[0], { ...segments[1], address_space_id: 1 }],
        ip_records: snapshot.ip_records.filter(row => row.device_id !== 4).map(row => row.device_id === 3 ? { ...row, ip: '192.0.2.99' } : row.device_id === 5 ? { ...row, segment_id: 1 } : row) };
    await click('入力を保持して最新情報を取得');
    assert.equal(requests.at(-1).action, 'load_ip_management', '復旧後は自動再送しない');
    assert.equal(overlay.querySelector('.ip-management-membership-btn').disabled, true);
    before = requests.length;
    await overlay.querySelector('.ip-management-membership-btn').dispatch('click'); await settle();
    assert.equal(requests.length, before);
    await click('選択をすべて解除');
    await chooseUnclassified('1:management:');
    select = overlay.querySelector('.ip-management-membership-select');
    select.value = '1'; await select.dispatch('change');
    conflict = false; await click('指定先へ再分類');
    assert.deepEqual(requests.at(-1).input.records, [{ device_id: 1, kind: 'management', id: null, segment_id: 1 }]);
    assert.equal(requests.at(-1).input.expected_revision, 35);
    await chooseUnclassified('2:management:');
    select = overlay.querySelector('.ip-management-membership-select');
    select.value = '1'; await select.dispatch('change');
    conflict = true; await click('指定先へ再分類');
    snapshot = { ...snapshot, revision: 36, ip_segments: [] };
    await click('入力を保持して最新情報を取得');
    assert.equal(overlay.querySelector('.ip-management-membership-btn').disabled, true);
    assert.ok(overlay.querySelectorAll('[data-membership-key]').every(input => input.disabled));
    before = requests.length;
    await overlay.querySelector('.ip-management-membership-btn').dispatch('click'); await settle();
    assert.equal(requests.length, before);

    // 閲覧者もカード全体とパンくずで移動でき、CIDR概要は常時表示される。
    conflict = false; await click('ネットワーク区分一覧');
    snapshot = { ...snapshot, revision: 40, address_spaces: [{ id: 1, name: '本番', memo: '運用区分の説明' }],
        ip_segments: [
            { id: 11, address_space_id: 1, name: 'LAN', cidr: '192.0.2.0/24', vlan_id: 10, purpose: '業務', facility: '東京' },
            { id: 12, address_space_id: 1, name: '対向', cidr: '198.51.100.0/31' },
            { id: 13, address_space_id: 1, name: '単一', cidr: '203.0.113.7/32' }
        ], ip_records: [
            { device_id: 1, kind: 'management', ip: '192.0.2.1', segment_id: 11, address_space_id: 1 },
            { device_id: 2, kind: 'management', ip: '192.0.2.1', segment_id: 11, address_space_id: 1 },
            { device_id: 3, kind: 'management', ip: '10.0.0.1', segment_id: null }
        ] };
    window.APP_CONFIG.user.isAdmin = false; await click('更新');
    assert.equal(document.getElementById('ip-management-title').textContent, 'IPアドレス管理');
    assert.equal(overlay.querySelector('[role="status"]').textContent, '');
    assert.equal(overlay.querySelector('.ip-management-dialog').classList.contains('is-fixed-height'), false,
        'ネットワーク区分一覧は高さ可変のまま');
    const spaceCard = overlay.querySelectorAll('button').find(button => button.getAttribute('aria-label') === '本番');
    assert.match(spaceCard.textContent, /3セグメント.*登録IP 2件.*運用区分の説明/s);
    assert.match(overlay.querySelector('.ip-management-unclassified').textContent, /未分類IP.*登録IP 1件/s);
    await click('本番');
    assert.ok(!overlay.querySelectorAll('button').some(button => button.textContent === 'セグメントを追加'));
    const segmentCard = overlay.querySelectorAll('button').find(button => button.getAttribute('aria-label') === 'LAN / 192.0.2.0/24');
    assert.match(segmentCard.textContent, /VLAN 10.*業務.*東京.*登録IP 2件/);
    await click('LAN / 192.0.2.0/24');
    const detailDialog = overlay.querySelector('.ip-management-dialog');
    const overviewDetails = overlay.querySelector('.ip-management-overview-details');
    const overviewToggle = overlay.querySelector('.ip-management-overview-toggle');
    assert.equal(overviewDetails.hidden, true, 'セグメント情報は初期状態で閉じる');
    assert.equal(overviewToggle.getAttribute('aria-expanded'), 'false');
    assert.equal(overviewToggle.getAttribute('aria-controls'), overviewDetails.id);
    assert.equal(detailDialog.classList.contains('is-fixed-height'), true);
    await click('CIDR詳細を展開');
    assert.equal(overviewDetails.hidden, false);
    assert.equal(overviewToggle.getAttribute('aria-expanded'), 'true');
    await click('CIDR詳細を折りたたむ');
    assert.equal(overviewDetails.hidden, true);
    assert.equal(detailDialog.classList.contains('is-fixed-height'), true, '折りたたみで詳細画面の外枠指定を解除しない');
    const overviewValue = title => {
        const item = overlay.querySelectorAll('dt').find(item => item.textContent === title);
        assert.ok(item, title); return item.parentElement.querySelector('dd').textContent;
    };
    assert.equal(overviewValue('サブネットマスク'), '255.255.255.0');
    assert.equal(overviewValue('ネットワークアドレス'), '192.0.2.0');
    assert.equal(overviewValue('ブロードキャスト'), '192.0.2.255');
    assert.equal(overviewValue('ホスト範囲'), '192.0.2.1 ～ 192.0.2.254');
    assert.equal(overviewValue('ホスト数'), '254');
    assert.equal(overviewValue('登録済みIP数'), '1種類（登録 2件）');
    assert.equal(overviewValue('ホスト用IP登録率'), '0.39%（1/254）');
    assert.ok(!overlay.querySelectorAll('button').some(button => button.textContent === 'セグメントを編集'));
    assert.equal(overlay.querySelectorAll('input').find(input => input.type === 'checkbox').checked, false);
    await click('更新'); assert.equal(overviewValue('CIDR'), '192.0.2.0/24');
    await click('本番');
    assert.equal(detailDialog.classList.contains('is-fixed-height'), false, 'セグメント一覧は高さ可変のまま');
    await click('対向 / 198.51.100.0/31');
    assert.equal(overlay.querySelector('.ip-management-overview-details').hidden, true, '別セグメントも初期状態で閉じる');
    assert.equal(overviewValue('ブロードキャスト'), 'なし（/31・/32）');
    assert.equal(overviewValue('ホスト範囲'), '198.51.100.0 ～ 198.51.100.1');
    assert.equal(overviewValue('ホスト数'), '2');
    await click('本番'); await click('単一 / 203.0.113.7/32');
    assert.equal(overviewValue('ブロードキャスト'), 'なし（/31・/32）');
    assert.equal(overviewValue('ホスト範囲'), '203.0.113.7 ～ 203.0.113.7');
    assert.equal(overviewValue('ホスト数'), '1');

    // 名称のみの編集では、復旧時に他者の最新CIDRを採用して巻き戻さない。
    await click('本番'); await click('LAN / 192.0.2.0/24');
    window.APP_CONFIG.user.isAdmin = true; await click('更新');
    await click('CIDR詳細を展開');
    await click('CIDR詳細を折りたたむ');
    assert.equal(overlay.querySelector('.ip-management-overview-details').hidden, true);
    const editSegment = overlay.querySelectorAll('button').find(button => button.textContent === 'セグメントを編集');
    assert.ok(editSegment);
    assert.equal(overlay.querySelector('.ip-management-overview-details').contains(editSegment), false,
        '詳細を閉じても編集導線は折りたたみ領域の外に残る');
    await click('セグメントを編集');
    assert.equal(overlay.querySelector('form').querySelector('[name="cidr"]').value, '192.0.2.0/24');
    assert.equal(detailDialog.classList.contains('is-fixed-height'), false, '編集フォームは高さ可変のまま');
    panel = overlay.querySelector('form'); await fill(panel, 'name', '名称だけ変更');
    conflict = true; await submitForm(panel);
    snapshot = { ...snapshot, revision: 41, ip_segments: snapshot.ip_segments.map(row => row.id === 11 ? { ...row, cidr: '192.0.2.0/25' } : row) };
    await click('入力を保持して最新情報を取得');
    panel = overlay.querySelector('form');
    assert.equal(panel.querySelectorAll('input').find(input => input.name === 'cidr').value, '192.0.2.0/25');
    assert.equal(panel.querySelectorAll('input').find(input => input.name === 'name').value, '名称だけ変更');
    conflict = false; await submitForm(panel);
    assert.equal(requests.at(-1).input.cidr, '192.0.2.0/25');
    assert.equal(requests.at(-1).input.name, '名称だけ変更');
    assert.equal(requests.at(-1).input.expected_revision, 41);
    assert.equal(detailDialog.classList.contains('is-fixed-height'), true, '保存後は外枠固定のセグメント詳細へ戻る');
    assert.equal(overlay.querySelector('.ip-management-overview-details').hidden, true);

    // 同一項目の両者変更は明示選択するまで保存せず、最新値の選択も保存へ反映する。
    await click('セグメントを編集'); panel = overlay.querySelector('form');
    await fill(panel, 'cidr', '192.0.2.0/26');
    conflict = true; await submitForm(panel);
    snapshot = { ...snapshot, revision: 43, ip_segments: snapshot.ip_segments.map(row => row.id === 11 ? { ...row, cidr: '192.0.2.0/27' } : row) };
    await click('入力を保持して最新情報を取得');
    panel = overlay.querySelector('form');
    assert.match(panel.textContent, /入力した値: 192.0.2.0\/26/);
    assert.match(panel.textContent, /最新の値: 192.0.2.0\/27/);
    assert.equal(panel.querySelectorAll('button').find(button => button.type === 'submit').disabled, true);
    before = requests.length; await panel.dispatch('submit'); await settle(); assert.equal(requests.length, before);
    await click('最新の値を使用');
    panel = overlay.querySelector('form');
    assert.equal(panel.querySelectorAll('input').find(input => input.name === 'cidr').value, '192.0.2.0/27');
    assert.equal(panel.querySelectorAll('button').find(button => button.type === 'submit').disabled, false);
    conflict = false; await submitForm(panel);
    assert.equal(requests.at(-1).input.cidr, '192.0.2.0/27');

    // 検索対象は画面ごとに分離し、遷移で前画面の検索を持ち越さない。
    await click('ネットワーク区分一覧');
    const searchFor = async value => { const input = overlay.querySelector('input[type="search"]'); input.value = value; await input.dispatch('input'); return input; };
    assert.match(overlay.querySelector('input[type="search"]').placeholder, /区分名・メモ/);
    await searchFor('東京'); assert.equal(overlay.querySelector('.ip-management-cards').querySelectorAll('button').length, 0);
    await searchFor('運用区分'); assert.equal(overlay.querySelector('.ip-management-cards').querySelectorAll('button').length, 1);
    await click('本番');
    assert.equal(overlay.querySelector('input[type="search"]').value, '');
    await searchFor('192.0.2.1'); assert.equal(overlay.querySelector('.ip-management-cards').querySelectorAll('button').length, 0);
    await searchFor('東京'); assert.equal(overlay.querySelector('.ip-management-cards').querySelectorAll('button').length, 1);

    // 同IP・同機器でも追加IPのchild IDとkindを区別する。
    const direct = { device_id: 7, kind: 'additional', id: 72, ip: '192.0.2.7' };
    snapshot = { ...snapshot, revision: 50, ip_records: [
        { ...direct, id: 71, device_name: '同じ機器', segment_id: null },
        { ...direct, device_name: '同じ機器', segment_id: null },
        { ...direct, kind: 'management', id: null, device_name: '同じ機器', segment_id: null }
    ] };
    window.APP_CONFIG.user.isAdmin = false;
    await openIpManagement({ target: direct });
    assert.match(overlay.textContent, /現在位置: ネットワーク区分一覧 › 未分類/);
    assert.equal(overlay.querySelector('input[type="search"]').value, '');
    let highlighted = overlay.querySelectorAll('.ip-management-target');
    assert.equal(highlighted.length, 1); assert.equal(highlighted[0].dataset.recordKey, '7:additional:72');
    assert.ok(document.activeElement === highlighted[0]);
    assert.equal(overlay.querySelectorAll('select').length, 0, '閲覧者の直接表示に編集操作を出さない');
    await searchFor('一致しない検索');
    assert.equal(overlay.querySelector('.ip-management-target').dataset.recordKey, '7:additional:72');
    assert.equal(overlay.querySelectorAll('.ip-management-record').length, 1, '診断対象は検索条件が異なっても表示する');
    await openIpManagement({ target: direct }); assert.equal(overlay.querySelector('input[type="search"]').value, '');
    snapshot = { ...snapshot, ip_records: snapshot.ip_records.map(row => row.id === 72 ? { ...row, ip: '192.0.2.8' } : row) };
    duringLoad = () => {
        assert.ok(header.querySelectorAll('button').every(button => button.disabled), '更新中は更新・閉鎖を無効化する');
        snapshot = { ...snapshot, ip_records: snapshot.ip_records.map(row => row.id === 72 ? { ...row, ip: '192.0.2.9' } : row) };
    };
    await click('更新');
    duringLoad = null;
    assert.equal(overlay.querySelector('.ip-management-target'), null); assert.match(overlay.querySelector('[role="status"]').textContent, /変更されました/);
    snapshot = { ...snapshot, ip_records: snapshot.ip_records.map(row => row.id === 72 ? { ...row, ip: direct.ip, segment_id: 11 } : row) };
    await openIpManagement({ target: direct });
    assert.equal(overlay.querySelector('.ip-management-target'), null);
    assert.match(document.getElementById('toast').textContent, /分類済み/);
    snapshot = { ...snapshot, ip_records: snapshot.ip_records.filter(row => row.id !== 72) };
    await click('更新');
    assert.equal(overlay.querySelector('.ip-management-target'), null); assert.match(overlay.querySelector('[role="status"]').textContent, /削除されました/);

    // 開いているフォームと再分類選択の入力保護を同じ遷移判定へ通す。
    window.APP_CONFIG.user.isAdmin = true;
    await click('ネットワーク区分一覧'); await click('ネットワークを登録');
    panel = overlay.querySelector('form'); await fill(panel, 'name', '破棄しない入力');
    before = requests.length;
    const blockedOpen1 = openIpManagement({ target: direct }); await settle();
    await confirmModal('cancel'); await blockedOpen1;
    assert.ok(overlay.querySelector('form') === panel); assert.equal(requests.length, before);
    snapshot = { ...snapshot, ip_records: [{ ...direct, segment_id: null }] };
    const allowedOpen1 = openIpManagement({ target: direct }); await settle();
    await confirmModal('confirm'); await allowedOpen1;
    assert.equal(overlay.querySelector('form'), null);
    await chooseUnclassified(`${direct.device_id}:${direct.kind}:${direct.id ?? ''}`);
    select = overlay.querySelector('select'); select.value = '11'; await select.dispatch('change');
    select = overlay.querySelector('.ip-management-membership-select');
    before = requests.length;
    const blockedOpen2 = openIpManagement({ target: { ...direct, id: 71 } }); await settle();
    await confirmModal('cancel'); await blockedOpen2;
    assert.ok(overlay.querySelector('select') === select); assert.equal(select.value, '11'); assert.equal(requests.length, before);
    const closing = closeIpManagement(); await settle();
    await confirmModal('confirm'); assert.equal(await closing, true);
    const management = { ...direct, kind: 'management', id: null };
    snapshot = { ...snapshot, ip_records: [{ ...management, segment_id: null }] };
    await openIpManagement({ target: management });
    assert.equal(overlay.querySelector('.ip-management-target').dataset.recordKey, '7:management:');

    // 名前なしの既存セグメントも、APIと同様にメモだけを編集できる。
    window.APP_CONFIG.user.isAdmin = true;
    await click('ネットワーク区分一覧');
    snapshot = { status: 'success', revision: 50,
        address_spaces: [{ id: 1, name: '本番' }],
        ip_segments: [{ id: 11, address_space_id: 1, name: '', cidr: '192.0.2.0/24', memo: '' }],
        ip_records: [], devices: [] };
    await click('更新'); await click('本番');
    await click('192.0.2.0/24');
    assert.match(overlay.querySelector('.ip-management-breadcrumb').textContent, /本番 › 192\.0\.2\.0\/24$/);
    await click('セグメントを編集');
    panel = overlay.querySelector('form');
    assert.equal(panel.querySelector('[name="name"]').required, false);
    await fill(panel, 'memo', '名前を付けずにメモを更新');
    await submitForm(panel);
    assert.equal(overlay.querySelector('form'), null);
    assert.match(overlay.textContent, /名前を付けずにメモを更新/);
    assert.equal(requests.at(-1).input.name, '');

    // querySelectorAllがArray.findを持たないブラウザでも、エラー表示とフォーカスが動く。
    const useNodeList = panel => {
        const selectAll = panel.querySelectorAll.bind(panel);
        panel.querySelectorAll = selector => {
            const nodes = selectAll(selector);
            return Object.assign({ length: nodes.length, [Symbol.iterator]: () => nodes.values() }, nodes);
        };
    };
    await click('セグメントを編集');
    panel = overlay.querySelector('form');
    const parentSelect = panel.querySelector('[name="address_space_id"]');
    parentSelect.value = ''; await parentSelect.dispatch('change');
    useNodeList(panel);
    before = requests.length;
    await panel.dispatch('submit');
    assert.equal(requests.length, before);
    assert.match(panel.querySelector('.ip-management-form-error').textContent, /ネットワーク区分を再選択/);
    assert.ok(document.activeElement === parentSelect);
    await click('キャンセル'); await click('本番'); await click('セグメントを追加');
    panel = overlay.querySelector('form');
    const preview = panel.querySelector('.ip-management-cidr-preview');
    assert.equal(preview.classList.contains('ip-management-invalid'), false, '空欄・未操作は中立表示');
    assert.doesNotMatch(preview.textContent, /有効なIPv4 CIDRを入力/);
    assert.equal(panel.querySelector('[name="name"]').required, true, '新規名の必須は維持');
    useNodeList(panel);
    before = requests.length;
    await panel.dispatch('submit');
    assert.equal(requests.length, before);
    assert.match(panel.querySelector('.ip-management-form-error').textContent, /必須項目/);
    assert.equal(document.activeElement?.name, 'name');
    assert.equal(preview.classList.contains('ip-management-invalid'), true, '送信後の空欄CIDRは警告');
    await fill(panel, 'cidr', 'invalid');
    assert.equal(preview.classList.contains('ip-management-invalid'), true);
    await fill(panel, 'cidr', '198.51.100.0/24');
    assert.equal(preview.classList.contains('ip-management-invalid'), false);
    await fill(panel, 'cidr', '');
    assert.equal(preview.classList.contains('ip-management-invalid'), true, '入力して空欄へ戻した場合も検証する');
    await click('キャンセル');
    await click('セグメントを追加');
    panel = overlay.querySelector('form');
    await panel.querySelector('[name="cidr"]').dispatch('invalid');
    assert.equal(panel.querySelector('.ip-management-cidr-preview').classList.contains('ip-management-invalid'), true,
        'ブラウザ標準検証がsubmitを止める場合も警告する');
});

test('#349: IME検索・未変更キャンセル・古い選択復帰・未分類絞り込み/ページング・分類済み所属変更・UI階層を確認する', async t => {
    const dom = installWorkspaceDom({ templates: ['templates/components/toolbar.php', 'templates/components/status_bar.php'], phpSetup: "define('NETARIUM_VERSION', '1.3.0'); \$currentUser = ['username' => 'admin', 'role' => 'admin'];" });
    const { openIpManagement, closeIpManagement } = await import('../public/js/modals/ip-management-modal.js');
    const { resetResourceBaseline } = await import('../public/js/core/resource-save.js');
    const { discardDeviceDrafts } = await import('../public/js/core/device-drafts.js');
    const { setImmediate } = await import('node:timers/promises');
    const previousFetch = globalThis.fetch, original = { ...appState };
    Object.assign(appState, {
        devices: [], views: [], links: [], placements: [], canvasNotes: [],
        floorPlans: [], rackSettings: [], rackMounts: [], rackShelves: [], rackShelfDevices: [], floorRackPlacements: [],
        authExpired: false, isPinging: false
    });
    discardDeviceDrafts(); resetResourceBaseline(appState);
    window.APP_CONFIG.user.isAdmin = true;
    window.confirm = () => { throw new Error('window.confirmは使用しない'); };

    // 1. 管理メニューの項目順（構成管理 → 設定）は維持する。
    const menuButtons = document.getElementById('toolbar-manage-menu').querySelectorAll('button');
    assert.deepEqual(menuButtons.slice(0, 5).map(btn => btn.id), [
        'view-manage-btn', 'ip-management-btn', 'change-history-btn', 'link-display-settings-btn', 'link-systems-settings-btn'
    ]);

    const requests = [];
    let snapshot = {
        status: 'success', revision: 10,
        address_spaces: [{ id: 1, name: '庁舎ネットワーク', memo: '本庁舎' }, { id: 2, name: '拠点ネットワーク', memo: '支所' }],
        ip_segments: [
            { id: 101, address_space_id: 1, name: '執務LAN', cidr: '192.0.2.0/24', vlan_id: 10, facility: '本館' },
            { id: 201, address_space_id: 2, name: '支所LAN', cidr: '192.0.2.0/24', vlan_id: 20, facility: '東支所' }
        ],
        devices: [
            { id: 1, name: 'コアルータ', type: 'router', ip: '192.0.2.1', ip_segment_id: 101 },
            { id: 2, name: 'フロアSW', type: 'switch', ip: '192.0.2.2', ip_segment_id: 101, additional_ips: [{ id: 501, ip: '192.0.2.3', label: '管理VLAN', segment_id: 101 }] },
            { id: 3, name: '同名機器', type: 'server', ip: '192.0.2.10', ip_segment_id: 101 },
            { id: 4, name: '同名機器', type: 'server', ip: '192.0.2.10', ip_segment_id: 101 }
        ],
        ip_records: [
            { device_id: 1, device_name: 'コアルータ', kind: 'management', id: null, ip: '192.0.2.1', label: '', segment_id: 101, address_space_id: 1 },
            { device_id: 2, device_name: 'フロアSW', kind: 'management', id: null, ip: '192.0.2.2', label: '', segment_id: 101, address_space_id: 1 },
            { device_id: 2, device_name: 'フロアSW', kind: 'additional', id: 501, ip: '192.0.2.3', label: '管理VLAN', segment_id: 101, address_space_id: 1 },
            { device_id: 3, device_name: '同名機器', kind: 'management', id: null, ip: '192.0.2.10', label: '', segment_id: 101, address_space_id: 1 },
            { device_id: 4, device_name: '同名機器', kind: 'management', id: null, ip: '192.0.2.10', label: '', segment_id: 101, address_space_id: 1 },
            { device_id: 9, device_name: '未分類端末', kind: 'management', id: null, ip: '192.0.2.50', label: '', segment_id: null, address_space_id: null }
        ]
    };
    globalThis.fetch = async (url, options = {}) => {
        const action = new URL(url, 'http://localhost').searchParams.get('action');
        const input = options.body ? JSON.parse(options.body) : null;
        requests.push({ action, input });
        if (action === 'reclassify_ips') {
            snapshot = {
                ...snapshot,
                revision: snapshot.revision + 1,
                affected_count: input.records.length,
                ip_records: snapshot.ip_records.map(row => {
                    const match = input.records.find(r => r.device_id === row.device_id && r.kind === row.kind && r.id === row.id);
                    if (!match) return row;
                    const seg = snapshot.ip_segments.find(s => s.id === match.segment_id);
                    return { ...row, segment_id: match.segment_id, address_space_id: seg?.address_space_id ?? null };
                })
            };
        }
        return new Response(JSON.stringify(snapshot));
    };
    const settle = async () => { for (let i = 0; i < 5; i++) await setImmediate(); };
    const confirmModal = async (choice = 'confirm') => {
        const modal = document.getElementById('ip-management-confirm-overlay');
        assert.ok(modal && !modal.hidden, '確認モーダルが表示されている');
        const text = modal.textContent;
        await modal.querySelector(`[data-confirm-action="${choice}"]`).dispatch('click');
        await settle();
        return text;
    };
    const click = async text => {
        const target = overlay.querySelectorAll('button').find(button => (button.getAttribute('aria-label') || button.textContent) === text);
        assert.ok(target, `button ${text}`); await target.dispatch('click'); await settle();
    };
    t.after(async () => {
        discardDeviceDrafts();
        const closing = closeIpManagement();
        if (closing && typeof closing.then === 'function') {
            if (document.getElementById('ip-management-confirm-overlay')) await confirmModal('confirm');
            await closing;
        }
        Object.assign(appState, original); resetResourceBaseline(appState); globalThis.fetch = previousFetch; dom.cleanup?.();
    });

    await openIpManagement();
    const overlay = document.getElementById('ip-management-overlay');

    // 2. 更新ボタンの共通更新アイコン＋「更新」表示、カード要確認表示（未分類IPは特定区分へ誤集計しない）
    const refreshBtn = overlay.querySelector('.ip-management-refresh-btn');
    assert.equal(refreshBtn.querySelector('img')?.src, 'assets/icons/app/refresh.svg');
    assert.equal(refreshBtn.textContent, '更新');
    const space1Card = overlay.querySelectorAll('.ip-management-card').find(c => c.getAttribute('aria-label') === '庁舎ネットワーク');
    const space2Card = overlay.querySelectorAll('.ip-management-card').find(c => c.getAttribute('aria-label') === '拠点ネットワーク');
    assert.ok(space1Card.classList.contains('has-warning'), '重複IPがある区分は警告表示');
    assert.match(space1Card.textContent, /登録IP 5件/);
    assert.match(space1Card.textContent, /重複IP 1種類/);
    assert.ok(!space2Card.classList.contains('has-warning'), '警告のない区分は警告色にしない');
    assert.match(space2Card.textContent, /登録IP 0件/);

    // 3. フォームを開いただけで未変更のキャンセル・閉鎖は確認モーダルを出さない
    await click('ネットワークを登録');
    assert.ok(overlay.querySelector('form'));
    await click('キャンセル');
    assert.equal(document.getElementById('ip-management-confirm-overlay'), null);
    assert.equal(overlay.querySelector('form'), null);
    await click('庁舎ネットワーク');
    await click('ネットワーク区分を編集');
    assert.ok(overlay.querySelector('form'));
    await click('キャンセル');
    assert.equal(document.getElementById('ip-management-confirm-overlay'), null);
    assert.equal(overlay.querySelector('form'), null);

    // 4. セグメント詳細：日本語IME変換中は検索更新を抑制し、searchInputをDOMから取り外さない
    await click('執務LAN / 192.0.2.0/24');
    const searchInput = overlay.querySelector('input[type="search"]');
    assert.ok(searchInput);
    assert.equal(overlay.querySelectorAll('.ip-management-device-link').length, 5);
    await searchInput.dispatch('compositionstart');
    searchInput.value = 'こあ';
    await searchInput.dispatch('input');
    assert.ok(overlay.querySelector('input[type="search"]') === searchInput, 'IME変換中にsearchInputを再生成しない');
    assert.equal(overlay.querySelectorAll('.ip-management-device-link').length, 5, 'IME変換確定前は結果一覧を更新しない');
    searchInput.value = 'コアルータ';
    await searchInput.dispatch('compositionend');
    assert.ok(overlay.querySelector('input[type="search"]') === searchInput, 'IME確定後も同じsearchInput要素を維持');
    assert.equal(overlay.querySelectorAll('tr').length, 2);

    // 5. 通常登録・同IPの各登録・台帳未登録を区別し、重複と機器名を表示する。
    searchInput.value = '192.0.2.2';
    await searchInput.dispatch('input');
    const matchedRow = overlay.querySelector('tr.ip-management-search-match');
    assert.ok(matchedRow);
    assert.equal(matchedRow.dataset.ip, '192.0.2.2');
    assert.equal(matchedRow.querySelector('.ip-management-status-badge'), null, '通常の1件登録では件数バッジを出さない');
    const swLink = matchedRow.querySelector('.ip-management-device-link');
    assert.equal(swLink.querySelector('img')?.src, 'assets/icons/devices/l2-switch.svg');
    assert.equal(swLink.textContent, 'フロアSW（管理IP）', '一意な機器名では機器IDを主表示に出さない');
    searchInput.value = '192.0.2.10';
    await searchInput.dispatch('input');
    const dupRow = overlay.querySelector('tr.ip-management-row-duplicate');
    assert.equal(dupRow.querySelector('.ip-management-ip-cell').querySelector('.ip-management-status-badge')?.textContent, '重複・2件');
    const dupLinks = overlay.querySelectorAll('.ip-management-device-link');
    assert.deepEqual(dupLinks.map(btn => btn.textContent), [
        '同名機器（機器ID 3）（管理IP）',
        '同名機器（機器ID 4）（管理IP）'
    ]);
    searchInput.value = '';
    await searchInput.dispatch('input');
    const unregCheckbox = overlay.querySelector('input[type="checkbox"]');
    unregCheckbox.checked = true;
    await unregCheckbox.dispatch('change');
    const zeroRow = overlay.querySelectorAll('tr').find(tr => tr.dataset.ip === '192.0.2.0');
    assert.equal(zeroRow.querySelector('.ip-management-status-badge')?.textContent, '台帳未登録');
    unregCheckbox.checked = false;
    await unregCheckbox.dispatch('change');

    // 6. 登録IPを選び、共通操作から1件の所属を変更する。
    const chooseRecord = async key => {
        const checkbox = overlay.querySelector(`[data-record-key="${key}"]`).querySelector('input[type="checkbox"]');
        checkbox.checked = true; await checkbox.dispatch('change');
    };
    const chooseDestination = async value => {
        const select = overlay.querySelector('.ip-management-membership-select');
        select.value = value; await select.dispatch('change');
    };
    await chooseRecord('2:additional:501');
    assert.equal(overlay.querySelector('.ip-management-membership-btn').disabled, true, '移動先未選択時は変更できない');
    await chooseDestination('201');
    await overlay.querySelector('.ip-management-membership-btn').dispatch('click'); await settle();
    const transferText = await confirmModal('confirm');
    assert.match(transferText, /192\.0\.2\.3.*フロアSW.*追加IP.*変更元.*庁舎ネットワーク \/ 執務LAN.*変更先.*拠点ネットワーク \/ 支所LAN/s);
    assert.deepEqual(requests.at(-1).input.records, [{
        device_id: 2, kind: 'additional', id: 501, from_segment_id: 101, segment_id: 201
    }]);
    assert.equal(overlay.querySelector('[data-record-key="2:additional:501"]'), null, '移動後は元のセグメント一覧から外れる');

    await chooseRecord('1:management:');
    await chooseDestination('unclassified');
    await overlay.querySelector('.ip-management-membership-btn').dispatch('click'); await settle();
    const unclassifyText = await confirmModal('confirm');
    assert.match(unclassifyText, /変更元.*庁舎ネットワーク \/ 執務LAN.*変更先.*未分類/s);
    assert.match(unclassifyText, /機器・IP登録は残り/);
    assert.deepEqual(requests.at(-1).input.records, [{
        device_id: 1, kind: 'management', id: null, from_segment_id: 101, segment_id: null
    }]);

    // 7. 古い選択状態（「現在位置: 削除済み」を出さず、消えたセグメント/区分から安全に一覧へ復帰）
    snapshot = { ...snapshot, ip_segments: snapshot.ip_segments.filter(s => s.id !== 101) };
    await click('更新');
    assert.doesNotMatch(overlay.textContent, /削除済み/);
    assert.match(overlay.textContent, /現在位置: ネットワーク区分一覧 › 庁舎ネットワーク/);
    assert.match(document.getElementById('toast').textContent, /セグメント一覧へ戻りました/);
    snapshot = { ...snapshot, address_spaces: snapshot.address_spaces.filter(s => s.id !== 1) };
    await click('更新');
    assert.doesNotMatch(overlay.textContent, /削除済み/);
    assert.match(overlay.textContent, /現在位置: ネットワーク区分一覧/);
    assert.match(document.getElementById('toast').textContent, /ネットワーク区分一覧へ戻りました/);

    // 8. 通常起動時は前回の位置を持ち越さず毎回「ネットワーク区分一覧」から開始
    await click('拠点ネットワーク');
    await click('支所LAN / 192.0.2.0/24');
    assert.match(overlay.textContent, /現在位置: ネットワーク区分一覧 › 拠点ネットワーク › 支所LAN/);
    assert.equal(closeIpManagement(), true);
    await openIpManagement();
    assert.equal(overlay.querySelector('h3').textContent, 'ネットワーク区分一覧');

    // 9. 未分類IP一覧：検索・候補フィルター・50件ページングの組み合わせと一括再分類対象の整合
    snapshot = {
        ...snapshot,
        ip_segments: [
            { id: 101, address_space_id: 2, name: '支所A', cidr: '192.0.2.0/24' },
            { id: 201, address_space_id: 2, name: '支所B', cidr: '192.0.2.0/24' },
            { id: 301, address_space_id: 2, name: '専用LAN', cidr: '198.51.100.0/24' },
            { id: 401, address_space_id: 2, name: '別LAN', cidr: '10.0.0.0/24' }
        ],
        ip_records: [
            ...Array.from({ length: 55 }, (_, idx) => ({
                device_id: 100 + idx, device_name: `拠点A一意_${idx + 1}`, kind: 'management', id: null,
                ip: `198.51.100.${idx + 1}`, segment_id: null
            })),
            { device_id: 13, device_name: '別候補端末', kind: 'management', id: null, ip: '10.0.0.1', segment_id: null },
            { device_id: 11, device_name: '複数端末', kind: 'additional', id: 511, label: '同IP追加', ip: '192.0.2.50', segment_id: null },
            { device_id: 11, device_name: '複数端末', kind: 'management', id: null, ip: '192.0.2.50', segment_id: null },
            { device_id: 12, device_name: '範囲外端末', kind: 'management', id: null, ip: '203.0.113.99', segment_id: null }
        ]
    };
    await openIpManagement({ target: { device_id: 12, kind: 'management', id: null, ip: '203.0.113.99' } });
    const targetEl = overlay.querySelector('.ip-management-target');
    assert.ok(targetEl);
    assert.equal(targetEl.querySelector('.ip-management-target-label')?.textContent, '診断対象');
    assert.ok(document.activeElement === targetEl);
    await click('ネットワーク区分一覧');
    await click('未分類IP');
    const autoButton = () => overlay.querySelector('.ip-management-auto-reclassify-btn');
    const specifiedButton = () => overlay.querySelector('.ip-management-membership-btn');
    const countSelected = expected => assert.equal(
        overlay.querySelector('output[aria-label="このページの選択件数"]').textContent, String(expected));
    const hiddenSelected = expected => assert.equal(
        Number(overlay.querySelector('.ip-management-hidden-selection')?.dataset.count || 0), expected);
    const checkAll = async () => {
        const all = overlay.querySelector('[aria-label="現在のページを全選択"]');
        all.checked = true; await all.dispatch('change');
    };
    assert.ok(autoButton().classList.contains('btn-secondary'));
    assert.ok(specifiedButton().classList.contains('btn-primary'));
    countSelected(0);
    assert.equal(autoButton().disabled, true);
    assert.equal(specifiedButton().disabled, true);
    await click('候補なしのみ');
    const unavailable = overlay.querySelector('[data-membership-key="12:management:"]');
    assert.equal(unavailable.disabled, true);
    await checkAll(); countSelected(0);
    await click('複数候補のみ');
    await chooseRecord('11:management:'); await chooseRecord('11:additional:511');
    countSelected(2);
    assert.equal(autoButton().disabled, true);
    assert.equal(overlay.querySelector('.ip-management-auto-reclassify-reason').hidden, false);
    await chooseDestination('101');
    assert.equal(specifiedButton().disabled, false);
    assert.ok(document.activeElement === overlay.querySelector('.ip-management-membership-select'));
    await specifiedButton().dispatch('click'); await settle();
    const beforeCancel = requests.length;
    const cancelText = await confirmModal('cancel');
    assert.match(cancelText, /複数端末/); assert.match(cancelText, /同IP追加/);
    assert.equal(requests.length, beforeCancel); countSelected(2);
    await click('すべての候補状態');
    let unclassSearch = overlay.querySelector('input[type="search"]');
    unclassSearch.value = '端末'; await unclassSearch.dispatch('input');
    await chooseRecord('13:management:');
    countSelected(3);
    assert.equal(autoButton().disabled, true, '一意と複数の混在も一部だけ自動送信しない');
    assert.equal(specifiedButton().disabled, true, '共通候補の積集合が空なら指定先へ送信できない');
    assert.equal(overlay.querySelector('.ip-management-membership-select').value, '101');
    assert.equal(overlay.querySelector('.ip-management-membership-select').options.find(option => option.value === '101').disabled, true);
    const mixedUnique = overlay.querySelector('[data-membership-key="13:management:"]');
    mixedUnique.checked = false; await mixedUnique.dispatch('change');
    unclassSearch.value = '存在しない検索条件_0件'; await unclassSearch.dispatch('input');
    countSelected(0); hiddenSelected(2);
    assert.equal(autoButton().disabled, true); assert.equal(specifiedButton().disabled, true);
    const beforeEmpty = requests.length;
    await autoButton().dispatch('click'); await specifiedButton().dispatch('click'); await settle();
    assert.equal(requests.length, beforeEmpty);
    assert.equal(document.getElementById('ip-management-confirm-overlay'), null);

    // 50件を選択後に次ページへ進んでも、前ページと検索外の選択は送信しない。
    unclassSearch.value = '拠点A'; await unclassSearch.dispatch('input');
    assert.match(overlay.textContent, /1 \/ 2ページ（絞り込み一致 55件）/);
    await checkAll(); countSelected(50); hiddenSelected(2);
    assert.equal(autoButton().disabled, false);
    await chooseDestination('301');
    await click('次の50件');
    countSelected(0); hiddenSelected(52);
    assert.equal(autoButton().disabled, true);
    await chooseRecord('150:management:');
    countSelected(1); hiddenSelected(52);
    await specifiedButton().dispatch('click'); await settle();
    await confirmModal('confirm');
    assert.deepEqual(requests.at(-1).input.records, [
        { device_id: 150, kind: 'management', id: null, segment_id: 301 }
    ]);
    countSelected(50); hiddenSelected(2);
    assert.equal(overlay.querySelector('[data-membership-key="150:management:"]'), null, '送信した登録は未分類一覧から取り除く');
    unclassSearch = overlay.querySelector('input[type="search"]');
    await autoButton().dispatch('click'); await settle();
    const firstPageText = await confirmModal('confirm');
    assert.doesNotMatch(firstPageText, /複数端末|別候補端末/);
    assert.equal(requests.at(-1).input.records.length, 50);
    assert.ok(requests.at(-1).input.records.every(row => row.device_id >= 100 && row.device_id < 150 && row.segment_id === 301));
    assert.ok(requests.at(-1).input.records.every(row => !Object.hasOwn(row, 'from_segment_id')));
    countSelected(0); hiddenSelected(2);
    unclassSearch = overlay.querySelector('input[type="search"]');
    unclassSearch.value = ''; await unclassSearch.dispatch('input');
    await click('複数候補のみ');
    countSelected(2); hiddenSelected(0);
    await chooseDestination('201');
    await specifiedButton().dispatch('click'); await settle(); await confirmModal('confirm');
    assert.deepEqual(requests.at(-1).input.records, [
        { device_id: 11, kind: 'additional', id: 511, segment_id: 201 },
        { device_id: 11, kind: 'management', id: null, segment_id: 201 }
    ], '管理IPと同IPの追加IPを独立した登録として送信する');

    // 各々の唯一候補が異なる場合、共通指定先はなくても自動処理できる。
    await click('一意候補のみ'); await checkAll();
    countSelected(5);
    assert.equal(autoButton().disabled, false);
    assert.equal(specifiedButton().disabled, true);
    assert.equal(overlay.querySelector('.ip-management-membership-candidates').hidden, false);
    await autoButton().dispatch('click'); await settle(); await confirmModal('confirm');
    assert.equal(requests.at(-1).input.records.length, 5);
    assert.ok(requests.at(-1).input.records.some(row => row.device_id === 13 && row.segment_id === 401));
    assert.ok(requests.at(-1).input.records.filter(row => row.device_id !== 13).every(row => row.segment_id === 301));
    countSelected(0);
    // 10. フローティング通知（本文に常設・可変のステータス行を持たず、成功通知は自動消去・エラー通知は保持）とフォーム近傍エラー
    const { requestModalClose } = await import('../public/js/core/modal-focus.js');
    const dialog = overlay.querySelector('.ip-management-dialog');
    assert.equal(dialog.querySelector('.modal-body').querySelector('[role="status"]'), null, 'modal-body内にレイアウトを押し下げるstatus要素を置かない');
    assert.equal(dialog.querySelector('.modal-body').querySelector('[data-recovery]'), null, '409復旧ボタンもmodal-body先頭に挿入しない');

    const timers = [];
    const origSetTimeout = window.setTimeout;
    window.setTimeout = (fn, ms) => { const entry = { fn, ms }; timers.push(entry); return entry; };
    try {
        await click('ネットワーク区分一覧');
        await click('ネットワークを登録');
        const formPanel = overlay.querySelector('form');
        await formPanel.dispatch('submit');
        const formError = formPanel.querySelector('.ip-management-form-error');
        assert.equal(formError.hidden, false, '必須未入力エラーはフォーム近傍に表示する');
        assert.match(formError.textContent, /必須項目/);
        assert.equal(document.activeElement?.name, 'name', '先頭の未入力項目へフォーカスする');
        await click('キャンセル');

        await click('更新');
        // 通常の成功通知は共通トーストへ表示し、共通タイマーで消去する。
        await click('ネットワークを登録');
        const regForm = overlay.querySelector('form');
        for (const [k, v] of [['name', '通知確認区分'], ['segment_name', '通知LAN'], ['cidr', '203.0.113.0/24']]) {
            const el = regForm.querySelectorAll('input').find(i => i.name === k);
            el.value = v; await el.dispatch('input');
        }
        const prevFetch = globalThis.fetch;
        globalThis.fetch = async (url, opts) => {
            const act = new URL(url, 'http://localhost').searchParams.get('action');
            if (act === 'create_ip_network') {
                snapshot = { ...snapshot, revision: snapshot.revision + 1,
                    address_spaces: [...snapshot.address_spaces, { id: 9, name: '通知確認区分' }],
                    ip_segments: [...snapshot.ip_segments, { id: 901, address_space_id: 9, name: '通知LAN', cidr: '203.0.113.0/24' }],
                    created_address_space_id: 9, created_segment_id: 901, affected_count: 0 };
            }
            return prevFetch(url, opts);
        };
        await regForm.dispatch('submit'); await settle();
        globalThis.fetch = prevFetch;
        const noticeBar = dialog.querySelector('.ip-management-notice');
        const sharedToast = document.getElementById('toast');
        assert.equal(noticeBar.hidden, true, '通常成功はIP管理専用通知を使わない');
        assert.equal(overlay.hidden, false, 'モーダルを開いたまま成功を通知する');
        assert.equal(sharedToast.hidden, false);
        assert.match(sharedToast.textContent, /^保存しました/);
        assert.equal(sharedToast.getAttribute('aria-live'), 'polite');
        assert.equal(document.getElementById('status-toast-message').textContent, '');
        timers.at(-1).fn();
        assert.equal(sharedToast.hidden, true);

        // 通信エラー時は自動消去タイマーを設定せず、通知を保持する
        timers.length = 0;
        const errFetch = globalThis.fetch;
        globalThis.fetch = async () => { throw new Error('通信タイムアウトが発生しました'); };
        await click('更新');
        globalThis.fetch = errFetch;
        assert.equal(noticeBar.hidden, false);
        assert.ok(noticeBar.classList.contains('is-error'));
        assert.equal(noticeBar.querySelector('[role="status"]').getAttribute('aria-live'), 'assertive');
        assert.equal(timers.length, 0, 'エラー通知は短時間で自動消去しない');
        await noticeBar.querySelector('.ip-management-notice-close').dispatch('click');
        assert.equal(noticeBar.hidden, true);
    } finally {
        window.setTimeout = origSetTimeout;
    }

    // 11. ×・Esc・背景クリックの確認判定
    await click('ネットワーク区分一覧');
    snapshot = { ...snapshot, ip_records: [...snapshot.ip_records,
        { device_id: 99, device_name: '終了確認端末', kind: 'management', id: null, ip: '192.0.2.99', segment_id: null }] };
    await click('更新');
    await click('未分類IP');
    await chooseRecord('99:management:');
    await chooseDestination('101');
    void requestModalClose();
    await settle();
    assert.ok(document.getElementById('ip-management-confirm-overlay'), '変更がある場合はEscで確認モーダルが開く');
    void requestModalClose();
    await settle();
    assert.equal(document.getElementById('ip-management-confirm-overlay'), null, '確認モーダル表示中のEscで確認モーダルだけ閉じる');
    assert.equal(overlay.hidden, false, '本体モーダルは開いたまま維持される');
    assert.equal(overlay.querySelector('[data-membership-key="99:management:"]').checked, true, '選択状態が維持される');
    await click('選択をすべて解除');
    await overlay.querySelector('.modal-close-btn').dispatch('click');
    await settle();
    assert.equal(document.getElementById('ip-management-confirm-overlay'), null);
    assert.equal(overlay.hidden, true);
});

test('#352: 登録単位の選択・共通候補・ページ/検索保持・表示分だけの送信・失敗復旧を確認する', async t => {
    const dom = installWorkspaceDom({ templates: ['templates/components/status_bar.php'] });
    const { openIpManagement, closeIpManagement } = await import('../public/js/modals/ip-management-modal.js');
    const { resetResourceBaseline } = await import('../public/js/core/resource-save.js');
    const { discardDeviceDrafts } = await import('../public/js/core/device-drafts.js');
    const { setImmediate } = await import('node:timers/promises');
    const previousFetch = globalThis.fetch, original = { ...appState };
    Object.assign(appState, {
        devices: [], views: [], links: [], placements: [], canvasNotes: [],
        floorPlans: [], rackSettings: [], rackMounts: [], rackShelves: [], rackShelfDevices: [], floorRackPlacements: [],
        authExpired: false, isPinging: false
    });
    discardDeviceDrafts(); resetResourceBaseline(appState);
    window.APP_CONFIG.user.isAdmin = true;
    window.confirm = () => { throw new Error('window.confirmは使用しない'); };
    let snapshot = {
        status: 'success', revision: 60, devices: [],
        address_spaces: [{ id: 1, name: '本番' }, { id: 2, name: '検証' }],
        ip_segments: [
            { id: 101, address_space_id: 1, name: '移動元', cidr: '192.0.2.0/24' },
            { id: 201, address_space_id: 2, name: '全範囲', cidr: '192.0.2.0/24' },
            { id: 202, address_space_id: 2, name: '狭い範囲', cidr: '192.0.2.0/27' },
            { id: 203, address_space_id: 2, name: '別範囲', cidr: '198.51.100.0/24' }
        ],
        ip_records: [
            ...Array.from({ length: 55 }, (_, index) => ({
                device_id: index + 1, device_name: `端末${index + 1}`, kind: 'management', id: null,
                ip: `192.0.2.${index + 1}`, segment_id: 101, address_space_id: 1
            })),
            { device_id: 1, device_name: '端末1', kind: 'additional', id: 701, label: '別登録', ip: '192.0.2.1', segment_id: 101, address_space_id: 1 },
            { device_id: 90, device_name: '別機器', kind: 'management', id: null, ip: '192.0.2.1', segment_id: 101, address_space_id: 1 }
        ]
    };
    const requests = [];
    let failure = 0, loadError = false;
    globalThis.fetch = async (url, options = {}) => {
        const action = new URL(url, 'http://localhost').searchParams.get('action');
        const input = options.body ? JSON.parse(options.body) : null;
        requests.push({ action, input });
        if (action === 'load_ip_management' && loadError) throw new Error('復旧取得失敗');
        if (action === 'reclassify_ips') {
            if (failure) return new Response(JSON.stringify({ error: '所属変更失敗' }), { status: failure });
            snapshot = { ...snapshot, revision: snapshot.revision + 1, affected_count: input.records.length,
                ip_records: snapshot.ip_records.map(row => {
                    const change = input.records.find(item => item.device_id === row.device_id && item.kind === row.kind && item.id === row.id);
                    if (!change) return row;
                    const segment = snapshot.ip_segments.find(item => item.id === change.segment_id);
                    return { ...row, segment_id: change.segment_id, address_space_id: segment?.address_space_id ?? null };
                }) };
        }
        return new Response(JSON.stringify(snapshot));
    };
    const settle = async () => { for (let i = 0; i < 5; i++) await setImmediate(); };
    const confirm = async choice => {
        const modal = document.getElementById('ip-management-confirm-overlay');
        assert.ok(modal && !modal.hidden, '変更前に確認する');
        const text = modal.textContent;
        await modal.querySelector(`[data-confirm-action="${choice}"]`).dispatch('click'); await settle();
        return text;
    };
    t.after(async () => {
        discardDeviceDrafts();
        const closing = closeIpManagement();
        if (closing && typeof closing.then === 'function') {
            if (document.getElementById('ip-management-confirm-overlay')) await confirm('confirm');
            await closing;
        }
        Object.assign(appState, original); resetResourceBaseline(appState); globalThis.fetch = previousFetch; dom.cleanup?.();
    });
    await openIpManagement();
    const overlay = document.getElementById('ip-management-overlay');
    const click = async text => {
        const button = overlay.querySelectorAll('button').find(item => (item.getAttribute('aria-label') || item.textContent) === text);
        assert.ok(button, text); await button.dispatch('click'); await settle();
    };
    const checkboxFor = key => {
        const row = overlay.querySelector(`[data-record-key="${key}"]`);
        assert.ok(row, key); return row.querySelector('input[type="checkbox"]');
    };
    const check = async (checkbox, checked = true) => { checkbox.checked = checked; await checkbox.dispatch('change'); };
    const search = async value => {
        const input = overlay.querySelector('input[type="search"]');
        input.value = value; await input.dispatch('input');
    };
    const destination = () => overlay.querySelector('.ip-management-membership-select');
    const choose = async value => { const select = destination(); select.value = value; await select.dispatch('change'); };
    const move = async () => { await overlay.querySelector('.ip-management-membership-btn').dispatch('click'); await settle(); };
    const options = () => destination().options.filter(option => !option.disabled).map(option => option.value);
    const counts = (visible, total) => {
        assert.equal(Number(overlay.querySelector('output[aria-label="このページの選択件数"]').textContent), visible);
        const hiddenSelection = overlay.querySelector('.ip-management-hidden-selection');
        if (total > visible) {
            assert.ok(hiddenSelection && !hiddenSelection.hidden);
            assert.equal(Number(hiddenSelection.dataset.count), total - visible);
        } else {
            assert.ok(!hiddenSelection || hiddenSelection.hidden, 'ページ外の選択がない場合は補足を表示しない');
        }
    };
    const writes = () => requests.filter(request => request.action === 'reclassify_ips');
    const all = () => overlay.querySelector('[aria-label="現在のページを全選択"]');
    const pagingControls = expected => {
        const paging = overlay.querySelector('.ip-management-paging');
        assert.ok(paging?.querySelector('.ip-management-paging-summary'));
        assert.equal(paging.querySelectorAll('button').length, expected ? 3 : 0);
        assert.equal(Boolean(paging.querySelector('[aria-label="表示ページ"]')), expected);
    };
    await click('本番'); await click('移動元 / 192.0.2.0/24');
    counts(0, 0);
    pagingControls(true);
    const overview = overlay.querySelector('.ip-management-segment-overview');
    const details = overview.querySelector('.ip-management-overview-details');
    assert.equal(details.hidden, true, 'セグメント情報は初期表示で閉じる');
    assert.equal(overview.querySelector('[aria-expanded="false"]').getAttribute('aria-label'), 'CIDR詳細を展開');
    assert.ok(overview.children.some(child => child !== details && child.textContent.includes('192.0.2.0/24')),
        'CIDRは折りたたみ領域の外に残る');

    // 同一IPでも機器・管理/追加の各登録を独立に選べる。候補は全選択IPの積集合。
    overlay.querySelector('.ip-management-table-scroll').scrollTop = 156;
    checkboxFor('1:additional:701').focus();
    await check(checkboxFor('1:additional:701'));
    assert.ok(document.activeElement === checkboxFor('1:additional:701'), '選択後も同じ登録のチェックボックスでキーボード操作を続けられる');
    assert.equal(overlay.querySelector('.ip-management-table-scroll').scrollTop, 156,
        '選択後の再描画で一覧のスクロール位置を失わない');
    assert.equal(checkboxFor('1:management:').checked, false);
    assert.equal(checkboxFor('90:management:').checked, false);
    counts(1, 1);
    assert.deepEqual(options(), ['', '201', '202', 'unclassified']);
    await choose('202');
    assert.ok(document.activeElement === destination(), '移動先の変更後も候補を続けて選べる');

    // CIDR詳細の開閉は検索入力・表示中の登録・選択・変更先を変えない。
    await search('192.0.2.1');
    const retainedSearch = overlay.querySelector('input[type="search"]');
    const retainedRows = () => overlay.querySelectorAll('[data-record-key]').map(row => row.dataset.recordKey);
    const rowsBeforeToggle = retainedRows();
    const writesBeforeToggle = writes().length;
    for (const expanded of [true, false]) {
        await click(expanded ? 'CIDR詳細を展開' : 'CIDR詳細を折りたたむ');
        assert.equal(details.hidden, !expanded);
        assert.equal(overview.querySelector(`[aria-expanded="${expanded}"]`)?.tagName, 'BUTTON');
        assert.ok(overlay.querySelector('input[type="search"]') === retainedSearch);
        assert.equal(retainedSearch.value, '192.0.2.1');
        assert.deepEqual(retainedRows(), rowsBeforeToggle);
        assert.equal(checkboxFor('1:additional:701').checked, true);
        assert.equal(destination().value, '202');
        counts(1, 1);
    }
    assert.equal(writes().length, writesBeforeToggle);
    await search('');
    await check(checkboxFor('40:management:'));
    assert.deepEqual(options(), ['', '201', 'unclassified'], '狭い範囲・範囲外・変更元は共通候補に含めない');
    assert.equal(destination().value, '202', '候補外になった移動先の入力を黙って別の値へ変えない');
    assert.equal(overlay.querySelector('.ip-management-membership-btn').disabled, true);
    await choose('201');
    await check(all(), false);
    counts(0, 0); assert.equal(destination().value, '201', 'チェックで選択を解除しても変更先の入力を保持する');
    assert.equal(checkboxFor('1:additional:701').checked, false);
    assert.equal(overlay.querySelector('.ip-management-membership-btn').disabled, true);

    // ページ全選択は同じIPの複数登録も含み、他ページの選択を解除しない。
    await check(all()); counts(52, 52);
    assert.ok(document.activeElement === all(), '全選択後もヘッダーのチェックボックスにフォーカスを保持する');
    assert.equal(checkboxFor('1:additional:701').checked, true);
    assert.equal(checkboxFor('90:management:').checked, true);
    await click('次の50件'); counts(0, 52);
    assert.equal(all().checked, false);
    await check(all()); counts(5, 57);
    await click('前の50件'); counts(52, 57); assert.equal(all().checked, true);
    await check(all(), false); counts(0, 5);
    await click('次の50件'); counts(5, 5); assert.equal(all().checked, true);
    await search('192.0.2.55'); counts(1, 5);
    pagingControls(false);
    await choose('201');
    const beforeCancel = writes().length;
    await move();
    const cancelled = await confirm('cancel');
    assert.match(cancelled, /選択した登録 1件.*非表示の選択 4件は変更しません/s);
    assert.equal(writes().length, beforeCancel); counts(1, 5); assert.equal(destination().value, '201');
    await move(); await confirm('confirm');
    assert.deepEqual(writes().at(-1).input.records, [
        { device_id: 55, kind: 'management', id: null, from_segment_id: 101, segment_id: 201 }
    ]);
    counts(0, 4);
    await search(''); counts(0, 4);
    pagingControls(true);
    await click('次の50件'); counts(4, 4);
    for (const id of [51, 52, 53, 54]) assert.equal(checkboxFor(`${id}:management:`).checked, true);
    await search('一致なし'); counts(0, 4);
    const beforeHidden = writes().length;
    await move(); assert.equal(writes().length, beforeHidden);
    assert.equal(document.getElementById('ip-management-confirm-overlay'), null);
    await search('');
    await click('次の50件');
    await check(all(), false); counts(0, 0);

    // 複数登録の未分類化は重複を確認し、失敗・409・復旧取得失敗でも選択と変更先を失わない。
    await search('192.0.2.1');
    await check(checkboxFor('1:management:')); await check(checkboxFor('90:management:'));
    await choose('unclassified');
    const retained = () => {
        counts(2, 2); assert.equal(destination().value, 'unclassified');
        assert.equal(checkboxFor('1:management:').checked, true);
        assert.equal(checkboxFor('90:management:').checked, true);
        assert.equal(checkboxFor('1:additional:701').checked, false);
    };
    failure = 500;
    await move();
    const duplicateText = await confirm('confirm');
    assert.match(duplicateText, /選択した登録 2件/);
    assert.match(duplicateText, /端末1.*機器ID 1.*別機器.*機器ID 90/s);
    assert.match(duplicateText, /機器・IP登録は残り/);
    assert.match(duplicateText, /他の機器と同じIP/);
    assert.equal(writes().at(-1).input.ip_conflicts_confirmed, true);
    retained(); assert.match(overlay.textContent, /所属変更失敗/);
    failure = 409;
    await move(); await confirm('confirm'); retained();
    assert.match(overlay.textContent, /入力は保持/);
    const beforeRecovery = writes().length;
    loadError = true; await click('入力を保持して最新情報を取得');
    retained(); assert.match(overlay.textContent, /復旧取得失敗/);
    loadError = false; failure = 0; snapshot = { ...snapshot, revision: 80 };
    await click('入力を保持して最新情報を取得');
    retained(); assert.equal(writes().length, beforeRecovery, '復旧取得で自動送信しない');
    await move(); await confirm('confirm');
    assert.equal(writes().at(-1).input.expected_revision, 80);
    assert.deepEqual(writes().at(-1).input.records, [
        { device_id: 1, kind: 'management', id: null, from_segment_id: 101, segment_id: null },
        { device_id: 90, kind: 'management', id: null, from_segment_id: 101, segment_id: null }
    ]);
    counts(0, 0);
    assert.equal(checkboxFor('1:additional:701').checked, false, '同一機器・同一IPの未送信追加登録は残る');
    snapshot = { ...snapshot, ip_segments: snapshot.ip_segments.filter(segment => ![201, 202].includes(segment.id)) };
    await click('更新');
    await search('192.0.2.40');
    await check(checkboxFor('40:management:'));
    assert.deepEqual(options(), ['', 'unclassified'], '共通セグメントがなくても未分類化は選択できる');
    await choose('unclassified');
    assert.equal(overlay.querySelector('.ip-management-membership-btn').disabled, false);
});

test('#374: 到達性の警告は他機器の管理IPに影響する矛盾だけを全登録から抽出する', () => {
    const records = [
        { device_id: 1, kind: 'management', ip: '192.0.2.1', segment_id: 1, address_space_id: 1 },
        { device_id: 2, kind: 'additional', ip: '192.0.2.1', segment_id: 2, address_space_id: 2 }
    ];
    const spaces = (a, b) => [{ id: 1, name: '本番', ping_reachability: a }, { id: 2, name: '検証', ping_reachability: b }];
    assert.equal(pingReachabilityWarnings(records, spaces('reachable', 'unreachable'), segments).length, 0);
    assert.equal(pingReachabilityWarnings(records, spaces('unset', 'unset'), segments).length, 0);
    assert.equal(pingReachabilityWarnings(records, spaces('unreachable', 'reachable'), segments).length, 0);
    for (const state of ['reachable', 'unset']) {
        const warnings = pingReachabilityWarnings(records, spaces('reachable', state), segments);
        assert.equal(warnings.length, 1);
        assert.equal(warnings[0].ip, '192.0.2.1');
        assert.deepEqual(warnings[0].records.map(row => row.address_space_name), ['本番', '検証']);
    }
    assert.equal(pingReachabilityWarnings([{ ...records[0] }, { ...records[1], segment_id: null, address_space_id: null }],
        spaces('reachable', 'unreachable'), segments).length, 1, '未分類の追加IPも照合する');
    assert.equal(pingReachabilityWarnings(records.map(row => ({ ...row, device_id: 1 })),
        spaces('reachable', 'unset'), segments).length, 0, '同一機器の登録は例外許可を妨げない');
    assert.equal(pingReachabilityWarnings(records.map(row => ({ ...row, kind: 'additional' })),
        spaces('reachable', 'reachable'), segments).length, 0, '管理IPがない組合せは監視警告にしない');
    const sameSpaceRecords = [records[0], { ...records[1], segment_id: 1, address_space_id: 1 }];
    assert.equal(pingReachabilityWarnings(sameSpaceRecords, spaces('reachable', 'reachable'), segments).length, 0,
        '同じ到達可能区分だけの旧重複は既存の重複診断へ委ねる');
    assert.equal(pingReachabilityWarnings([...sameSpaceRecords,
        { device_id: 3, kind: 'additional', ip: '192.0.2.1', segment_id: null, address_space_id: null }],
        spaces('reachable', 'reachable'), segments).length, 1, '既存重複と未分類追加IPが混在しても到達性矛盾を隠さない');
});

test('#374: 両フォームの到達性、dirty/409、警告付き保存、監視同期と閲覧者表示を操作する', async t => {
    const dom = installWorkspaceDom({ templates: ['templates/components/status_bar.php'] });
    const { openIpManagement, closeIpManagement } = await import('../public/js/modals/ip-management-modal.js');
    const { resetResourceBaseline } = await import('../public/js/core/resource-save.js');
    const { discardDeviceDrafts } = await import('../public/js/core/device-drafts.js');
    const { setImmediate } = await import('node:timers/promises');
    const original = { ...appState }, previousFetch = globalThis.fetch;
    Object.assign(appState, { devices: [
        normalizeDevice({ id: 1, name: '甲', ip: '192.0.2.1', status: 'green', last_response_ms: 8 }),
        normalizeDevice({ id: 99, name: '未保存IP機器', ip: '192.0.2.99', status: 'unknown' })
    ],
        views: [], links: [], placements: [], canvasNotes: [], floorPlans: [], rackSettings: [], rackMounts: [],
        rackShelves: [], rackShelfDevices: [], floorRackPlacements: [], authExpired: false, isPinging: false });
    discardDeviceDrafts(); resetResourceBaseline(appState);
    let snapshot = { revision: 10, monitor_revision: 20,
        address_spaces: [{ id: 1, name: '本番', ping_reachability: 'unset' }, { id: 2, name: '検証', ping_reachability: 'reachable' }],
        ip_segments: segments,
        ip_records: [{ device_id: 1, device_name: '甲<script>', kind: 'management', ip: '192.0.2.1', segment_id: 1, address_space_id: 1 },
            { device_id: 2, device_name: '乙', kind: 'additional', ip: '192.0.2.1', segment_id: 2, address_space_id: 2 }],
        devices: [
            normalizeDevice({ id: 1, name: '甲', ip: '192.0.2.1', status: 'unknown', last_response_ms: null, last_error: '重複・到達先未確定' }),
            normalizeDevice({ id: 99, name: '未保存IP機器', ip: '192.0.2.98', status: 'green', last_response_ms: 12 })
        ] };
    const requests = [];
    let conflict = false;
    globalThis.fetch = async (url, options = {}) => {
        const action = new URL(url, 'http://localhost').searchParams.get('action');
        const input = options.body ? JSON.parse(options.body) : null;
        requests.push({ action, input });
        if (action !== 'load_ip_management' && conflict) return new Response(JSON.stringify({ error: '競合しています' }), { status: 409 });
        if (action === 'save_address_space') snapshot = { ...snapshot, revision: snapshot.revision + 1, monitor_revision: snapshot.monitor_revision + 1,
            address_spaces: snapshot.address_spaces.map(space => space.id === input.id ? { ...space, ...input } : space) };
        if (action === 'create_ip_network') snapshot = { ...snapshot, revision: snapshot.revision + 1,
            address_spaces: [...snapshot.address_spaces, { id: 3, name: input.name, ping_reachability: input.ping_reachability }],
            ip_segments: [...snapshot.ip_segments, { id: 3, address_space_id: 3, ...input.segment }],
            created_address_space_id: 3, created_segment_id: 3 };
        return new Response(JSON.stringify(snapshot));
    };
    const settle = async () => { for (let i = 0; i < 5; i++) await setImmediate(); };
    let overlay;
    const click = async text => {
        const button = overlay.querySelectorAll('button').find(row => (row.getAttribute('aria-label') || row.textContent) === text);
        assert.ok(button, text); await button.dispatch('click'); await settle();
    };
    const confirm = async (choice = 'confirm') => {
        const modal = document.getElementById('ip-management-confirm-overlay');
        assert.ok(modal); await modal.querySelector(`[data-confirm-action="${choice}"]`).dispatch('click'); await settle();
    };
    const choose = async value => {
        const radios = overlay.querySelectorAll('[name="ping_reachability"]');
        assert.equal(radios.length, 3);
        for (const radio of radios) radio.checked = radio.value === value;
        await radios.find(row => row.value === value).dispatch('change');
    };
    const selected = () => overlay.querySelectorAll('[name="ping_reachability"]').find(row => row.checked)?.value;
    const submit = async () => { await overlay.querySelector('form').dispatch('submit'); await settle(); };
    t.after(async () => {
        const closing = closeIpManagement(); await settle();
        if (document.getElementById('ip-management-confirm-overlay')) await confirm();
        await closing;
        discardDeviceDrafts(); Object.assign(appState, original); resetResourceBaseline(appState);
        globalThis.fetch = previousFetch; dom.cleanup?.();
    });
    window.APP_CONFIG.user.isAdmin = true;
    await openIpManagement(); overlay = document.getElementById('ip-management-overlay');
    assert.equal(appState.monitorRevision, 20);
    assert.equal(appState.devices[0].status, 'unknown', '読込時も旧OKを残さない');
    assert.equal(appState.devices[0].last_response_ms, null);
    const unsavedIpDevice = appState.devices.find(row => row.id === 99);
    assert.equal(unsavedIpDevice.ip, '192.0.2.99');
    assert.equal(unsavedIpDevice.status, 'unknown', '未保存の変更後IPに古いIPの監視結果を上書きしない');
    assert.equal(unsavedIpDevice.last_response_ms, null);
    const cards = overlay.querySelectorAll('.ip-management-card');
    assert.equal(cards.filter(card => card.textContent.includes('Ping到達：可能')).length, 1);
    assert.equal(cards.filter(card => card.textContent.includes('Ping到達：未設定')).length, 1);
    await click('ネットワークを登録');
    assert.equal(selected(), 'unset');
    let panel = overlay.querySelector('form');
    const field = panel.querySelector('fieldset');
    assert.equal(panel.children.indexOf(field), panel.children.indexOf(panel.querySelector('[name="name"]').parentElement) + 1);
    assert.ok(panel.children.indexOf(field) < panel.children.indexOf(panel.querySelector('details')));
    assert.match(field.textContent, /実際のネットワーク構成・通信経路を確認して設定してください/);
    assert.match(field.textContent, /この設定では、サーバーの通信経路は変更されません/);
    assert.match(field.textContent, /重複IPは、到達可能な登録先が1つに特定できる場合のみPingします/);
    await choose('unreachable');
    await click('キャンセル'); await confirm('cancel');
    assert.equal(selected(), 'unreachable', '到達性だけの変更もdirtyとして保持');
    for (const [name, value] of [['name', '隔離'], ['segment_name', '隔離LAN'], ['cidr', '198.51.100.0/24']]) {
        const input = panel.querySelector(`[name="${name}"]`); input.value = value; await input.dispatch('input');
    }
    await submit();
    assert.equal(requests.at(-1).action, 'create_ip_network');
    assert.equal(requests.at(-1).input.ping_reachability, 'unreachable');
    assert.equal(requests.at(-1).input.segment.ping_reachability, undefined);
    await click('セグメントを編集');
    assert.equal(overlay.querySelector('[name="ping_reachability"]'), null);
    await click('キャンセル');
    await click('ネットワーク区分一覧'); await click('本番'); await click('ネットワーク区分を編集');
    assert.equal(selected(), 'unset');
    panel = overlay.querySelector('form');
    assert.equal(panel.children.indexOf(panel.querySelector('fieldset')), 2, '区分名直下');
    assert.equal(panel.querySelector('.ip-management-reachability-warning').hidden, false, '到達可能と別機器の未設定も警告する');
    assert.match(panel.querySelector('.ip-management-reachability-warning').textContent, /未設定/);
    await choose('reachable');
    let warning = overlay.querySelector('.ip-management-reachability-warning');
    assert.equal(warning.hidden, false);
    assert.match(warning.textContent, /192\.0\.2\.1.*甲<script>.*本番.*到達可能.*乙.*検証.*到達可能/s);
    assert.equal(warning.querySelector('script'), null, '機器名をHTMLとして解釈しない');
    assert.match(warning.textContent, /設定は保存できます/);
    conflict = true;
    await submit(); await confirm();
    assert.equal(selected(), 'reachable');
    snapshot = { ...snapshot, revision: 30, monitor_revision: 40,
        address_spaces: snapshot.address_spaces.map(space => space.id === 1 ? { ...space, ping_reachability: 'unreachable' } : space) };
    conflict = false;
    await click('入力を保持して最新情報を取得');
    assert.match(overlay.textContent, /到達性の変更が競合/);
    assert.equal(overlay.querySelector('button[type="submit"]').disabled, true);
    await click('入力した値を使用');
    assert.equal(selected(), 'reachable');
    await submit(); await confirm();
    assert.equal(requests.at(-1).input.ping_reachability, 'reachable', '警告は保存を禁止しない');
    assert.equal(requests.at(-1).input.expected_revision, 30);
    assert.equal(appState.monitorRevision, 41);
    await click('ネットワーク区分を編集');
    assert.equal(selected(), 'reachable', '保存値を復元');
    await choose('unreachable');
    warning = overlay.querySelector('.ip-management-reachability-warning');
    assert.equal(warning.hidden, true, '到達可能＋到達不可には警告しない');
    await submit(); await confirm();
    await click('ネットワーク区分一覧');
    await closeIpManagement();
    window.APP_CONFIG.user.isAdmin = false;
    await openIpManagement();
    assert.match(overlay.textContent, /Ping到達：可能/);
    assert.match(overlay.textContent, /Ping到達：不可/);
    assert.equal(overlay.querySelector('[name="ping_reachability"]'), null);
    assert.ok(!overlay.querySelectorAll('button').some(row => row.textContent === 'ネットワークを登録'));
    await click('本番');
    assert.ok(!overlay.querySelectorAll('button').some(row => row.textContent === 'ネットワーク区分を編集'));
});
