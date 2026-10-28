import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateRackLayout, rackUsage, rackOverlap } from '../public/js/core/rack-layout.js';
import { buildPrintModel, buildRackPrintLayout, createPrintSettings } from '../public/js/canvas/print-model.js';
import { renderPrintSheet } from '../public/js/canvas/print-renderer.js';
import { installPrintDom } from './helpers/print-dom.mjs';

const shelf = (extra = {}) => ({ id: -1, view_id: 1, name: '小型機器棚', face: 'front', start_u: 2, height_u: 1, depth: 'half', ...extra });
function fixture() {
    return { views: [{ id: 1, view_type: 'rack' }, { id: 2, view_type: 'rack' }, { id: 3, view_type: 'topology' }],
        devices: [1, 2, 3].map(id => ({ id, name: `機器${id}`, type: 'switch' })),
        rackSettings: [1, 2].map(view_id => ({ view_id, total_u: 6, location: '' })), rackMounts: [],
        rackShelves: [shelf()], rackShelfDevices: [{ device_id: 1, shelf_id: -1, sort_order: 0 }, { device_id: 2, shelf_id: -1, sort_order: 1 }],
        placements: [{ id: 1, device_id: 1, view_id: 3 }], links: [{ id: 1, view_id: 3, from_id: 1, to_id: 2 }] };
}
test('棚板は全幅を占有し子機器数だけUを増やさず通常配置と接続を保持する', () => {
    const data = fixture(); validateRackLayout(data);
    assert.deepEqual(rackUsage(6, [], 'front', data.rackShelves, data.rackShelfDevices), { empty: 5, half: 0, used: 1, deviceCount: 2 });
    assert.deepEqual(rackUsage(6, [], 'rear', data.rackShelves, data.rackShelfDevices), { empty: 6, half: 0, used: 0, deviceCount: 0 });
    assert.equal(data.placements.length, 1); assert.equal(data.links.length, 1);
    for (const width_slot of ['left', 'right', 'full']) {
        assert.ok(rackOverlap(shelf(), { view_id: 1, face: 'front', start_u: 2, height_u: 1, width_slot }));
        assert.equal(rackOverlap(shelf(), { view_id: 1, face: 'rear', start_u: 2, height_u: 1, width_slot }), null);
        assert.ok(rackOverlap(shelf({ depth: 'full' }), { view_id: 1, face: 'rear', start_u: 2, height_u: 1, width_slot }));
    }
});
test('棚同士と直付けの物理重複・所属の二重登録・不正参照を拒否する', () => {
    for (const change of [
        data => data.rackShelves.push(shelf({ id: -2 })),
        data => data.rackMounts.push({ device_id: 3, view_id: 1, face: 'front', start_u: 2, height_u: 1, width_slot: 'right', depth: 'half' }),
        data => data.rackMounts.push({ device_id: 1, view_id: 2, face: 'front', start_u: 1, height_u: 1, width_slot: 'full', depth: 'half' }),
        data => data.rackShelfDevices.push({ device_id: 1, shelf_id: -1, sort_order: 2 }),
        data => data.rackShelfDevices[0].shelf_id = 99,
        data => data.rackShelfDevices[0].sort_order = 1,
        data => data.rackShelfDevices[0].sort_order = -1,
        data => data.rackShelves[0].height_u = 6,
        data => data.rackShelves[0].face = 'both',
        data => data.rackShelves[0].depth = 'invalid',
        data => data.rackShelves[0].name = ' '
    ]) { const data = fixture(); change(data); assert.throws(() => validateRackLayout(data)); }
});
test('全奥行き棚の印刷は棚名と台数を表示し反対面占有を固定寸法にする', () => {
    const data = fixture(); data.rackShelves[0].depth = 'full';
    const model = buildRackPrintLayout(data.views[0], data.devices, data.rackSettings, [], createPrintSettings(), data.rackShelves, data.rackShelfDevices);
    assert.equal(model.blocks.length, 1); assert.equal(model.blocks[0].name, '小型機器棚 / 2台');
    assert.equal(model.blocks[0].slot, 'full'); assert.equal(model.blocks[0].height, 32);
    assert.equal(model.blockedSlots.length, 1); assert.equal(model.blockedSlots[0].face, 'rear');
    assert.equal(model.blockedSlots[0].width, model.blocks[0].width);
});

function shelfPrintModel(data, settings = createPrintSettings()) {
    return buildPrintModel({ view: data.views[0], devices: data.devices, placements: data.placements,
        links: data.links, rackSettings: data.rackSettings, rackMounts: data.rackMounts,
        rackShelves: data.rackShelves, rackShelfDevices: data.rackShelfDevices,
        notes: [{ id: 1, view_id: 1, text: 'ラック本文メモ', x: 0, y: 0,
            width: 280, height: 100, font_size: 16 }] }, settings);
}
function shelfDetailGroups(sheet) {
    return sheet.querySelectorAll('g').filter(group => group.getAttribute('data-rack-shelf-detail') !== null);
}
function visibleText(element) {
    return element.querySelectorAll('text').map(node => node.textContent).join('');
}

test('棚子の名称・種別・IPを順序どおり省略せず印刷し1Uサマリとメモに重ねない', t => {
    const dom = installPrintDom(); t.after(() => dom.restore());
    const data = fixture();
    const longName = '長い棚子機器名'.repeat(12);
    data.devices[0].name = longName;
    data.devices[0].ip = '2001:db8:1234:5678:90ab:cdef:1234:5678';
    data.devices[1].ip = '192.0.2.2';
    data.rackShelfDevices[0].sort_order = 1;
    data.rackShelfDevices[1].sort_order = 0;
    data.rackShelves.push(shelf({ id: -2, name: '背面棚', face: 'rear', start_u: 4 }));
    data.rackShelfDevices.push({ device_id: 3, shelf_id: -2, sort_order: 0 });
    const before = structuredClone(data);
    const model = shelfPrintModel(data);
    const sheet = renderPrintSheet(model);
    const details = shelfDetailGroups(sheet);
    assert.equal(details.length, 2);
    const entries = details[0].children.filter(child => child.getAttribute('data-device-id') !== null);
    assert.deepEqual(entries.map(child => child.getAttribute('data-device-id')), ['2', '1']);
    assert.equal(visibleText(entries[1]), longName + 'L2SW' + data.devices[0].ip);
    assert.ok(visibleText(entries[0]).includes('機器2L2SW192.0.2.2'));
    assert.ok(visibleText(details[1]).includes('背面棚 / 1台4〜4U / 背面機器3L2SW'));
    assert.equal(model.rack.blocks[0].height, 32);
    assert.equal(model.rack.blocks[0].name, '小型機器棚 / 2台');
    assert.equal(model.rack.faces[0].height, 6 * 32);
    for (const [index, detail] of model.rack.shelfDetails.entries()) {
        assert.ok(detail.x >= model.rack.bounds.x + model.rack.bounds.width + 16);
        assert.ok(model.bounds.x + model.bounds.width >= detail.x + detail.width);
        assert.ok(model.bounds.y + model.bounds.height >= detail.y + detail.height);
        if (index) assert.ok(detail.y > model.rack.shelfDetails[index - 1].y + model.rack.shelfDetails[index - 1].height);
        for (const child of detail.children) assert.ok(child.y + child.height <= detail.y + detail.height);
    }
    assert.ok(model.notes[0].y > model.rack.shelfDetails.at(-1).y + model.rack.shelfDetails.at(-1).height);
    assert.equal(sheet.querySelector('.print-note-text').textContent, 'ラック本文メモ');
    assert.deepEqual(data, before, '印刷は保存用データを変更しない');
});

test('棚子印刷は機器種別フィルタと名称・IP・種別の各表示設定を尊重する', t => {
    const dom = installPrintDom(); t.after(() => dom.restore());
    const data = fixture();
    data.devices[0].ip = '192.0.2.1';
    data.devices[1].type = 'ap';
    data.devices[1].ip = '192.0.2.2';
    for (const setting of ['deviceName', 'ip', 'deviceType']) {
        const options = createPrintSettings(); options[setting] = false;
        const text = visibleText(shelfDetailGroups(renderPrintSheet(shelfPrintModel(data, options)))[0]);
        assert.equal(text.includes('機器1'), setting !== 'deviceName');
        assert.equal(text.includes('192.0.2.1'), setting !== 'ip');
        assert.equal(text.includes('L2SW'), setting !== 'deviceType');
    }
    const filtered = createPrintSettings(); filtered.deviceTypes.ap = false;
    const model = shelfPrintModel(data, filtered);
    const details = shelfDetailGroups(renderPrintSheet(model));
    assert.equal(model.rack.blocks[0].name, '小型機器棚 / 1台');
    assert.equal(details[0].querySelectorAll('g').length, 1);
    assert.ok(visibleText(details[0]).includes('機器1L2SW192.0.2.1'));
    assert.equal(visibleText(details[0]).includes('機器2'), false);
    assert.equal(visibleText(details[0]).includes('192.0.2.2'), false);
    filtered.deviceTypes.switch = false;
    const empty = shelfPrintModel(data, filtered);
    assert.equal(shelfDetailGroups(renderPrintSheet(empty)).length, 0);
    assert.equal(empty.rack.blocks[0].height, 32);
    assert.equal(empty.notes[0].y, 32);
});
