import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appState } from '../public/js/core/state.js';
import { getTopModalContainer } from '../public/js/core/modal-focus.js';
import { initializePrintModal, closePrintModal, executePrint } from '../public/js/modals/print-modal.js';
import { onKeyDown } from '../public/js/canvas/selection.js';
import { installPrintDom } from './helpers/print-dom.mjs';
import { RACK_NOTE_REGION_X } from '../public/js/core/canvas-note-data.js';

function setup(t) {
    const dom = installPrintDom();
    const originalState = { ...appState };
    Object.assign(appState, {
        views: [{ id: 1, name: '合成構成図', facility: '試験施設', floor: '3F', view_type: 'floor' }],
        currentViewId: 1, devices: [
            { id: 1, type: 'switch', name: '<script>合成SW</script>', ip: '192.0.2.1', password: 'SECRET' },
            { id: 2, type: 'ap', name: '合成AP', ip: '' }
        ],
        placements: [{ id: 1, view_id: 1, device_id: 1, x: 100, y: 100 },
            { id: 2, view_id: 1, device_id: 2, x: 400, y: 100 }],
        links: [{ id: 1, view_id: 1, from_id: 1, to_id: 2, label: '合成配線' }],
        linkSystems: [],
        canvasNotes: [{ id: 1, view_id: 1, text: '<b>合成メモ</b>\n2行目', x: 150, y: 300, width: 220, height: 120,
            background_color: '#FFF3B0', background_opacity: 0.5, text_color: '#263238', font_size: 20 }],
        floorPlans: [{ view_id: 1, image_url: 'synthetic-floor.png', x: 0, y: 0, image_width: 1000,
            image_height: 800, scale: 1, opacity: 0.7, is_visible: false }],
        canvas: dom.get('print-device-types'), selectedPlacementIds: new Set([2]), selectedCanvasNoteId: 1,
        editingLinkId: 1, linkMode: true, linkSourceId: 2, noteMode: false,
        floorPlanAdjustMode: false, viewState: { scale: 0.5, panX: -100, panY: 200 },
        appStatus: { dirty: false, state: 'saved' }
    });
    initializePrintModal();
    t.after(() => { closePrintModal(); Object.assign(appState, originalState); dom.restore(); });
    return dom;
}
function stateSnapshot() {
    const { canvas, world, deviceLayer, noteLayer, currentSvg, floorPlanLayer, ...data } = appState;
    return structuredClone(data);
}
async function change(dom, id, checked) {
    const input = dom.get(id); input.checked = checked; await input.dispatch('change');
}

test('実テンプレートからviewerが左右同時表示の設定を変更・印刷・取消してもstateを維持する', async t => {
    const dom = setup(t);
    window.APP_CONFIG.user.isAdmin = false;
    window.APP_CONFIG.user.role = 'viewer';
    let requests = 0;
    globalThis.fetch = () => { requests++; throw new Error('印刷からAPIを呼んではいけない'); };
    const before = stateSnapshot();
    const opener = dom.get('palette-print-btn'); opener.focus();
    await opener.dispatch('click');
    assert.equal(getTopModalContainer(), dom.get('print-overlay'));
    assert.equal(appState.linkMode, true);
    assert.equal(dom.get('print-floorPlan').disabled, false);
    assert.equal(dom.get('print-settings').hidden, false);
    assert.equal(dom.get('print-preview').hidden, false);
    const initial = dom.get('print-sheet-container').children[0];
    assert.equal(initial.querySelectorAll('.print-device').length, 2);
    assert.equal(initial.querySelectorAll('.print-device-ip').length, 1);
    assert.equal(initial.querySelectorAll('.print-wire').length, 1);
    dom.get('print-ip').focus();
    await change(dom, 'print-type-ap', false);
    await change(dom, 'print-ip', false);
    const sheet = dom.get('print-sheet-container').children[0];
    assert.equal(sheet.querySelectorAll('.print-device').length, 1);
    assert.equal(sheet.querySelectorAll('.print-device-ip').length, 0);
    assert.equal(sheet.querySelectorAll('.print-wire').length, 0);
    assert.equal(sheet.querySelector('.print-device-name').textContent, '<script>合成SW</script>');
    assert.equal(sheet.querySelectorAll('script').length, 0);
    assert.equal(sheet.querySelector('.print-floor-image').src, 'synthetic-floor.png');
    assert.equal(sheet.querySelector('.print-floor-image').style.opacity, '0.7');
    assert.equal(sheet.querySelector('.print-note-text').textContent, '<b>合成メモ</b>\n2行目');
    assert.equal(sheet.querySelector('.print-note-text').style.fontSize, '20px');
    assert.equal(sheet.querySelector('.print-note-background').style.opacity, '0.5');
    assert.equal(dom.get('print-execute').disabled, false);
    assert.equal(dom.get('print-page-style').textContent, '@page { size: landscape; margin: 0; }');
    assert.equal(document.body.classList.contains('print-preview-active'), true);
    await dom.get('print-execute').dispatch('click');
    assert.equal(dom.printCalls(), 1);
    assert.deepEqual(stateSnapshot(), before);
    assert.equal(dom.get('print-type-ap').checked, false);
    assert.equal(dom.get('print-ip').checked, false);
    assert.equal(document.activeElement, dom.get('print-ip'), '自動更新で設定入力からフォーカスを奪わない');
    await dom.get('print-cancel').dispatch('click');
    assert.equal(getTopModalContainer(), null);
    assert.equal(document.activeElement, opener);
    assert.deepEqual(stateSnapshot(), before);
    assert.equal(requests, 0);
    await opener.dispatch('click');
    assert.equal(dom.get('print-type-ap').checked, true, '新規印刷は初期値から始める');
});

test('一括選択解除・配線とラベルの依存・図面対象外・viewport切取・タイトルとメモOFF', async t => {
    const dom = setup(t);
    appState.views[0].view_type = 'topology';
    await dom.get('palette-print-btn').dispatch('click');
    assert.equal(dom.get('print-floorPlan').disabled, true);
    assert.equal(dom.get('print-floorPlan').checked, false);
    await dom.get('print-clear-all').dispatch('click');
    assert.equal(dom.get('print-type-switch').checked, false);
    assert.equal(dom.get('print-sheet-container').children[0].querySelectorAll('.print-device').length, 0);
    await dom.get('print-select-all').dispatch('click');
    assert.equal(dom.get('print-type-switch').checked, true);
    assert.equal(dom.get('print-sheet-container').children[0].querySelectorAll('.print-device').length, 2);
    assert.equal(dom.get('print-notes').parentElement.querySelector('strong').textContent, 'キャンバスメモ');
    await change(dom, 'print-links', false);
    assert.equal(dom.get('print-labels').disabled, true);
    assert.equal(dom.get('print-labels').checked, false);
    await change(dom, 'print-links', true);
    assert.equal(dom.get('print-labels').checked, true);
    await change(dom, 'print-labels', false);
    await change(dom, 'print-notes', false);
    await change(dom, 'print-title', false);
    const range = document.querySelector('input[name="print-range"]'); range.checked = false;
    const viewport = document.querySelectorAll('input[name="print-range"]')[1];
    viewport.checked = true; await viewport.dispatch('change');
    const sheet = dom.get('print-sheet-container').children[0];
    assert.equal(sheet.querySelector('svg').getAttribute('viewBox'), '200 -400 1600 1200');
    assert.equal(sheet.querySelector('.print-wire').getAttribute('d').startsWith('M'), true);
    assert.equal(sheet.querySelectorAll('text').length, 0, 'ラベルは描かない');
    assert.equal(sheet.querySelectorAll('.print-note').length, 0);
    assert.equal(sheet.querySelectorAll('.print-sheet-title').length, 0);
    assert.equal(sheet.querySelectorAll('.print-floor-image').length, 0);
    assert.equal(sheet.querySelectorAll('.print-device-ip').length, 1, '未設定IPに空行を作らない');
    const before = stateSnapshot();
    await onKeyDown({ key: 'Escape', preventDefault() {}, stopImmediatePropagation() {} });
    assert.equal(dom.get('print-overlay').hidden, true);
    assert.deepEqual(stateSnapshot(), before, '印刷画面のEscは元の作業モードを終了しない');
});

test('画像読込中・失敗・閉鎖後の遅延完了では印刷を許可しない', async t => {
    const dom = setup(t);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    dom.setDecode(() => gate);
    const pending = dom.get('palette-print-btn').dispatch('click');
    assert.equal(dom.get('print-execute').disabled, true);
    executePrint();
    assert.equal(dom.printCalls(), 0);
    closePrintModal();
    release();
    await pending;
    assert.equal(document.body.classList.contains('print-preview-active'), false);
    executePrint(); assert.equal(dom.printCalls(), 0);
    dom.setDecode(() => Promise.reject(new Error('合成画像エラー')));
    await dom.get('palette-print-btn').dispatch('click');
    assert.equal(dom.get('print-settings').hidden, false);
    assert.equal(dom.get('print-preview-error').hidden, false);
    assert.equal(dom.get('print-execute').disabled, true);
    executePrint(); assert.equal(dom.printCalls(), 0);
    dom.setDecode(() => Promise.resolve());
    await change(dom, 'print-floorPlan', false);
    assert.equal(dom.get('print-preview-error').hidden, true);
    assert.equal(dom.get('print-execute').disabled, false);
    assert.equal(dom.get('print-sheet-container').children[0].querySelector('.print-floor-image'), null);
});

test('連続変更では古い画像準備完了で印刷可能にせず、最新の設定だけを有効にする', async t => {
    const dom = setup(t);
    let releaseOld, releaseLatest;
    const oldGate = new Promise(resolve => { releaseOld = resolve; });
    const latestGate = new Promise(resolve => { releaseLatest = resolve; });
    dom.setDecode(() => oldGate);
    const opened = dom.get('palette-print-btn').dispatch('click');
    dom.setDecode(() => latestGate);
    const ip = dom.get('print-ip');
    ip.checked = false;
    ip.focus();
    const updated = ip.dispatch('change');
    releaseOld();
    await opened;
    assert.equal(dom.get('print-execute').disabled, true);
    assert.equal(dom.get('print-preview').getAttribute('aria-busy'), 'true');
    executePrint();
    assert.equal(dom.printCalls(), 0);
    releaseLatest();
    await updated;
    assert.equal(dom.get('print-preview').getAttribute('aria-busy'), 'false');
    assert.equal(dom.get('print-execute').disabled, false);
    assert.equal(dom.get('print-sheet-container').children[0].querySelectorAll('.print-device-ip').length, 0);
    assert.equal(document.activeElement, ip);
    const orientations = document.querySelectorAll('input[name="print-orientation"]');
    orientations[0].checked = false;
    orientations[2].checked = true;
    await orientations[2].dispatch('change');
    assert.equal(dom.get('print-sheet-container').children[0].classList.contains('print-portrait'), true);
    await dom.get('print-execute').dispatch('click');
    assert.equal(dom.printCalls(), 1);
});

test('印刷DOMは共通系統のsnapshot色だけを使い、hover・選択の強調を含めない', async t => {
    const dom = setup(t);
    appState.links[0].system_id = 8;
    appState.linkSystems = [{ id: 8, name: '共通系統', color_key: 'indigo' }];
    await dom.get('palette-print-btn').dispatch('click');
    const sheet = dom.get('print-sheet-container').children[0];
    const wire = sheet.querySelector('.print-wire');
    assert.equal(wire.getAttribute('stroke'), '#4B5BA9');
    assert.equal(wire.getAttribute('stroke-width'), '2.5');
    assert.equal(sheet.querySelectorAll('.selected').length, 0);
    assert.equal(sheet.querySelectorAll('.link-foreground').length, 0);
    await wire.dispatch('pointerenter');
    await wire.dispatch('pointerleave');
    assert.equal(wire.getAttribute('stroke'), '#4B5BA9');
    appState.linkSystems[0].color_key = 'teal';
    appState.links[0].system_id = null;
    assert.equal(wire.getAttribute('stroke'), '#4B5BA9', 'プレビュー作成後の編集は既存印刷DOMへ影響しない');
    await dom.get('print-execute').dispatch('click');
    assert.equal(dom.printCalls(), 1);
    assert.equal(wire.getAttribute('stroke'), '#4B5BA9');
    closePrintModal();
    await dom.get('palette-print-btn').dispatch('click');
    assert.equal(dom.get('print-sheet-container').children[0].querySelector('.print-wire')
        .getAttribute('stroke'), '#334155', '次のsnapshotは未設定の従来色を使う');
});

test('印刷プレビューの機器種別は短縮名で表示され、機器名・種別のチェックで表示を制御できる', async t => {
    const dom = setup(t);
    const types = ['switch', 'l3_switch', 'router', 'firewall', 'ap', 'server', 'printer', 'pc', 'other'];
    appState.devices = types.map((type, idx) => ({ id: idx + 1, type, name: `機器_${type}`, ip: `192.168.1.${idx + 1}` }));
    appState.placements = types.map((_, idx) => ({ id: idx + 1, view_id: 1, device_id: idx + 1, x: idx * 120, y: 100 }));
    appState.links = [];
    await dom.get('palette-print-btn').dispatch('click');
    const sheet = dom.get('print-sheet-container').children[0];
    const typeEls = sheet.querySelectorAll('.print-device-type');
    assert.equal(typeEls.length, 9);
    assert.deepEqual(
        typeEls.map(el => el.textContent),
        ['L2SW', 'L3SW', 'RT', 'FW', 'AP', 'SV', 'PR', 'PC', 'etc']
    );
    assert.equal(sheet.querySelectorAll('.print-device-name').length, 9);

    // 機器名をOFFにする
    await change(dom, 'print-deviceName', false);
    const sheetNoName = dom.get('print-sheet-container').children[0];
    assert.equal(sheetNoName.querySelectorAll('.print-device-name').length, 0);
    assert.equal(sheetNoName.querySelectorAll('.print-device-type').length, 9);

    // 機器種別をOFFにする
    await change(dom, 'print-deviceType', false);
    const sheetNoType = dom.get('print-sheet-container').children[0];
    assert.equal(sheetNoType.querySelectorAll('.print-device-name').length, 0);
    assert.equal(sheetNoType.querySelectorAll('.print-device-type').length, 0);

    // 機器名を再度ONにする
    await change(dom, 'print-deviceName', true);
    const sheetNameOnly = dom.get('print-sheet-container').children[0];
    assert.equal(sheetNameOnly.querySelectorAll('.print-device-name').length, 9);
    assert.equal(sheetNameOnly.querySelectorAll('.print-device-type').length, 0);
});

test('rack preview renders both faces with U geometry, mirrors rear halves and remains printable when empty', async t => {
    const dom = setup(t);
    appState.views[0].view_type = 'rack';
    appState.rackSettings = [{ view_id: 1, total_u: 8, location: '試験ラック位置' }];
    appState.rackMounts = [
        { device_id: 1, view_id: 1, face: 'both', start_u: 4, height_u: 2, width_slot: 'full' },
        { device_id: 2, view_id: 1, face: 'rear', start_u: 1, height_u: 1, width_slot: 'left' }
    ];
    const before = stateSnapshot();
    await dom.get('palette-print-btn').dispatch('click');
    const sheet = dom.get('print-sheet-container').children[0];
    const svg = sheet.querySelector('svg');
    const groups = svg.querySelectorAll('g');
    assert.equal(groups.length, 3, 'both is one device block on each face, not one per occupied U');
    assert.equal(groups.filter(group => group.getAttribute('data-device-id') === '1').length, 2);
    const rearHalf = groups.find(group => group.getAttribute('data-device-id') === '2');
    assert.equal(rearHalf.getAttribute('data-rack-face'), 'rear');
    assert.equal(Number(rearHalf.querySelector('rect').getAttribute('x')), 425);
    assert.deepEqual(svg.querySelectorAll('text').filter(text => /^\d+$/.test(text.textContent))
        .map(text => text.textContent), ['8', '7', '6', '5', '4', '3', '2', '1']);
    assert.equal(svg.querySelectorAll('script').length, 0);
    assert.equal(dom.get('print-links').disabled, true);
    assert.equal(dom.get('print-notes').disabled, false);
    assert.equal(dom.get('print-notes').parentElement.querySelector('strong').textContent, 'ラックメモ');
    assert.equal(svg.querySelector('.print-note-text').textContent, '<b>合成メモ</b>\n2行目');
    assert.equal(svg.querySelector('.print-note-text').style.fontSize, '20px');
    await change(dom, 'print-notes', false);
    assert.equal(dom.get('print-sheet-container').children[0].querySelector('.print-note'), null);
    await change(dom, 'print-notes', true);
    assert.equal(dom.get('print-sheet-container').children[0].querySelector('.print-note-text').textContent, '<b>合成メモ</b>\n2行目');
    assert.ok(document.querySelectorAll('input[name="print-range"]').every(input => input.disabled));
    assert.equal(dom.get('print-execute').disabled, false);
    await dom.get('print-clear-all').dispatch('click');
    const emptySvg = dom.get('print-sheet-container').children[0].querySelector('svg');
    assert.equal(emptySvg.querySelectorAll('g').length, 0);
    assert.equal(emptySvg.querySelectorAll('rect').length, 2);
    assert.equal(dom.get('print-execute').disabled, false);
    await dom.get('print-execute').dispatch('click');
    assert.equal(dom.printCalls(), 1);
    assert.deepEqual(stateSnapshot(), before);
});

test('ラックの印刷見出しで上中下を区別し、本文と全件表示を維持する', async t => {
    const dom = setup(t);
    appState.views[0].view_type = 'rack';
    appState.rackSettings = [{ view_id: 1, total_u: 1 }];
    appState.rackMounts = [];
    const base = appState.canvasNotes[0];
    appState.canvasNotes = [
        { ...base, id: 3, x: RACK_NOTE_REGION_X, y: 2, text: '<b>下段</b>' },
        { ...base, id: 2, x: RACK_NOTE_REGION_X, y: 1, text: '中段\n全文' },
        { ...base, id: 1, text: '既存上段' }
    ];
    const before = stateSnapshot();
    await dom.get('palette-print-btn').dispatch('click');
    const sheet = dom.get('print-sheet-container').children[0];
    assert.deepEqual(sheet.querySelectorAll('.print-note-heading').map(node => node.textContent), ['上段', '中段', '下段']);
    assert.deepEqual(sheet.querySelectorAll('.print-note-text').map(node => node.textContent), ['既存上段', '中段\n全文', '<b>下段</b>']);
    assert.equal(sheet.querySelectorAll('b').length, 0);
    await change(dom, 'print-notes', false);
    assert.equal(dom.get('print-sheet-container').children[0].querySelectorAll('.print-note').length, 0);
    await change(dom, 'print-notes', true);
    assert.equal(dom.get('print-sheet-container').children[0].querySelectorAll('.print-note').length, 3);
    assert.equal(dom.get('print-execute').disabled, false);
    await dom.get('print-execute').dispatch('click');
    assert.equal(dom.printCalls(), 1);
    assert.deepEqual(stateSnapshot(), before);
});

test('1Uハーフ幅機器もIP設定の有効・無効を印刷テキストへ反映する', async t => {
    const dom = setup(t);
    appState.views[0].view_type = 'rack';
    appState.devices = [{ id: 1, name: '1U機器', type: 'switch', ip: '192.168.100.254' }];
    appState.rackSettings = [{ view_id: 1, total_u: 4, location: '' }];
    appState.rackMounts = [{ device_id: 1, view_id: 1, face: 'front', start_u: 1, height_u: 1, width_slot: 'left' }];
    await dom.get('palette-print-btn').dispatch('click');
    const printedTexts = () => dom.get('print-sheet-container').children[0].querySelector('svg').querySelectorAll('text').map(row => row.textContent);
    await change(dom, 'print-ip', true);
    assert.ok(printedTexts().includes('192.168.100.254'), 'SVG titleだけでなく用紙上にIPを出す');
    await change(dom, 'print-ip', false);
    assert.ok(!printedTexts().includes('192.168.100.254'));
});
