import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEVICE_TYPES } from '../public/js/core/constants.js';
import { buildPrintModel, createPrintSettings, viewportToPrintBounds, calculatePrintScale } from '../public/js/canvas/print-model.js';
import { resolveTopologyLinkRoutes } from '../public/js/canvas/link-route-resolver.js';
import { createLinkDisplayMap } from '../public/js/canvas/link-crossings.js';
import { LINK_SYSTEM_COLORS } from '../public/js/core/link-systems.js';
import { RACK_NOTE_REGION_X } from '../public/js/core/canvas-note-data.js';

function fixture() {
    return {
        view: { id: 1, name: '合成構成図', facility: '試験施設', floor: '3F', view_type: 'topology' },
        devices: Object.keys(DEVICE_TYPES).map((type, index) => ({ id: index + 1, type,
            name: `合成機器${index + 1}`, ip: `192.0.2.${index + 1}`, password: 'excluded-password',
            management_url: 'excluded-connection', serial_number: 'excluded-serial' })),
        placements: Object.keys(DEVICE_TYPES).map((_, index) => ({ id: index + 1, device_id: index + 1,
            view_id: 1, x: index * 200 + 100, y: index % 2 * 200 + 100 })),
        links: [{ id: 1, view_id: 1, from_id: 1, to_id: 2, label: '合成配線', route_mode: 'manual',
            manual_route: [{ x: 148, y: 600 }, { x: 348, y: 600 }] }],
        notes: [{ id: 1, view_id: 1, text: '<b>合成メモ</b>\n2行目', x: 1800, y: 700, width: 220, height: 120,
            background_color: '#FFF3B0', background_opacity: 0.5, text_color: '#263238', font_size: 20 }],
        floorPlan: { view_id: 1, image_url: 'synthetic-plan.png', image_width: 3000, image_height: 2000,
            x: 50, y: 60, scale: 0.5, opacity: 0.7, is_visible: false },
        viewport: { x: 300, y: 200, width: 400, height: 600 },
        printedAt: new Date(2026, 9, 6, 12, 30)
    };
}

test('全種の個別filterは非表示端点の配線だけを除外し、別ビューを混入させない', () => {
    const input = fixture();
    input.placements.push({ id: 99, device_id: 1, view_id: 2, x: 9000, y: 9000 });
    input.links.push({ ...input.links[0], id: 99, view_id: 2 });
    input.notes.push({ ...input.notes[0], id: 99, view_id: 2 });
    for (const type of Object.keys(DEVICE_TYPES)) {
        const settings = createPrintSettings();
        settings.deviceTypes[type] = false;
        const model = buildPrintModel(input, settings);
        assert.deepEqual(model.nodes.map(node => node.type), Object.keys(DEVICE_TYPES).filter(key => key !== type));
        assert.deepEqual(model.wires.map(wire => wire.id), ['switch', 'l3_switch'].includes(type) ? [] : [1]);
        assert.deepEqual(model.notes.map(note => note.id), [1]);
        assert.ok(model.bounds.x + model.bounds.width < 9000);
    }
});

test('全体boundsはONの機器・手動配線・ラベル・メモから求める', () => {
    const input = fixture();
    const options = createPrintSettings();
    const withNotes = buildPrintModel(input, options);
    assert.equal(withNotes.bounds.x + withNotes.bounds.width, 2036);
    assert.equal(withNotes.bounds.y + withNotes.bounds.height, 836);
    options.notes = false;
    const withoutNotes = buildPrintModel(input, options);
    assert.ok(withoutNotes.bounds.y + withoutNotes.bounds.height >= 616, '機器外の手動経路を含める');
    options.links = false;
    const devicesOnly = buildPrintModel(input, options);
    assert.equal(devicesOnly.bounds.y + devicesOnly.bounds.height, 402);
    assert.deepEqual(devicesOnly.wires, []);
    options.deviceTypes = Object.fromEntries(Object.keys(DEVICE_TYPES).map(key => [key, false]));
    const empty = buildPrintModel(input, options);
    assert.equal(empty.empty, true);
    assert.ok(Number.isFinite(calculatePrintScale(empty.bounds, 800, 600)));
});

test('floorの図面ONは通常の非表示状態に依存せず図面全体をprimary boundsにする', () => {
    const input = fixture();
    input.view.view_type = 'floor';
    const options = createPrintSettings();
    const model = buildPrintModel(input, options);
    assert.deepEqual(model.bounds, { x: 50, y: 60, width: 1500, height: 1000 });
    assert.equal(model.floorPlan.opacity, 0.7);
    options.floorPlan = false;
    assert.equal(buildPrintModel(input, options).floorPlan, null);
    assert.equal(buildPrintModel(input, options).bounds.x + buildPrintModel(input, options).bounds.width, 2036);
    input.view.view_type = 'topology';
    options.floorPlan = true;
    assert.equal(buildPrintModel(input, options).floorPlan, null);
});

test('viewportはcanvasのpan/zoomを逆変換し、両viewで同じ切取範囲と向きを使う', () => {
    const bounds = viewportToPrintBounds({ width: 800, height: 600, left: 100, top: 50 },
        { scale: 0.5, panX: -100, panY: 200 });
    assert.deepEqual(bounds, { x: 200, y: -400, width: 1600, height: 1200 });
    const input = fixture();
    const options = createPrintSettings();
    options.range = 'viewport';
    for (const type of ['topology', 'floor']) {
        input.view.view_type = type;
        assert.deepEqual(buildPrintModel(input, options).bounds, input.viewport);
        assert.equal(buildPrintModel(input, options).orientation, 'portrait');
        options.orientation = 'landscape';
        assert.equal(buildPrintModel(input, options).orientation, 'landscape');
        options.orientation = 'auto';
    }
    assert.equal(calculatePrintScale(bounds, 800, 300), 0.25);
});

test('IP OFFと未設定IPはノードを詰めるが、機器中心・名称・経路を変えない', () => {
    const input = fixture();
    input.devices[1].ip = '';
    const options = createPrintSettings();
    const on = buildPrintModel(input, options);
    options.ip = false;
    const off = buildPrintModel(input, options);
    assert.equal(on.nodes[0].height - off.nodes[0].height, 16);
    assert.equal(on.nodes[0].y + on.nodes[0].height / 2, off.nodes[0].y + off.nodes[0].height / 2);
    assert.equal(on.nodes[1].height, off.nodes[1].height);
    assert.deepEqual(on.wires, off.wires);
    assert.deepEqual(off.nodes.map(node => node.ip), Array(input.devices.length).fill(''));
    assert.deepEqual(off.nodes.map(node => node.name), on.nodes.map(node => node.name));
});

test('手動経路は通常resolverを保持し、交差方式はbridge/gapを適用、配線OFFはlabelも除外する', () => {
    const input = fixture();
    input.placements = [
        { id: 1, view_id: 1, device_id: 1, x: 0, y: 100 },
        { id: 2, view_id: 1, device_id: 2, x: 400, y: 100 },
        { id: 3, view_id: 1, device_id: 3, x: 200, y: 0 },
        { id: 4, view_id: 1, device_id: 4, x: 200, y: 300 }
    ];
    input.links = [
        { id: 1, view_id: 1, from_id: 1, to_id: 2, system_id: 8, route_mode: 'auto', label: '横線' },
        { id: 2, view_id: 1, from_id: 3, to_id: 4, system_id: 9, route_mode: 'manual', manual_route: [], label: '縦線' }
    ];
    input.linkSystems = [{ id: 8, name: '共通A', color_key: 'indigo' },
        { id: 9, name: '共通B', color_key: 'teal' }];
    const routes = resolveTopologyLinkRoutes(input.links, input.placements);
    const options = createPrintSettings();
    for (const crossingStyle of ['bridge', 'gap']) {
        input.crossingStyle = crossingStyle;
        const expected = createLinkDisplayMap(routes, crossingStyle);
        const model = buildPrintModel(input, options);
        for (const wire of model.wires) {
            assert.deepEqual(wire.points, routes.get(wire.id));
            assert.equal(wire.pathData, expected.get(wire.id).pathData);
            assert.deepEqual(wire.labelPosition, expected.get(wire.id).labelPosition);
            assert.equal(wire.color, wire.id === 1 ? '#4B5BA9' : '#167D8D');
        }
        assert.ok(model.wires.some(wire => crossingStyle === 'bridge' ? wire.pathData.includes('Q') : wire.pathData.split('M').length > 2));
    }
    options.labels = false;
    assert.deepEqual(buildPrintModel(input, options).wires.map(wire => wire.label), ['', '']);
    options.links = false;
    assert.deepEqual(buildPrintModel(input, options).wires, []);
});

test('snapshotは入力・機密・管理情報を変更も共有もせず、空のタイトル情報を自然に省略する', () => {
    const input = fixture();
    const original = structuredClone(input);
    const options = createPrintSettings();
    const model = buildPrintModel(input, options);
    assert.deepEqual(input, original);
    assert.equal(JSON.stringify(model).includes('excluded-'), false);
    assert.deepEqual(model.title, { name: '合成構成図', location: '試験施設 / 3F', time: '2026-10-06 12:30' });
    model.nodes[0].name = 'snapshot編集';
    model.wires[0].points[0].x = -9000;
    model.notes[0].text = 'snapshot編集';
    model.floorPlan = null;
    model.settings.deviceTypes.ap = false;
    assert.deepEqual(input, original);
    assert.equal(options.deviceTypes.ap, true);
    options.title = false;
    assert.equal(buildPrintModel(input, options).title, null);
    input.view.facility = ''; input.view.floor = '';
    options.title = true;
    assert.equal(buildPrintModel(input, options).title.location, '');
});

test('メモ本文null/undefined、不正bounds、スケールゼロ除算、未解決リンクを安全に処理する', () => {
    const input = fixture();
    input.notes[0].text = null;
    input.viewport = { x: 0, y: 0, width: 0, height: -10 };
    const options = createPrintSettings();
    options.range = 'viewport';
    const model = buildPrintModel(input, options);
    assert.equal(model.notes[0].text, '');
    assert.equal(model.bounds.width, 1);
    assert.equal(model.bounds.height, 1);
    assert.ok(Number.isFinite(calculatePrintScale(model.bounds, 800, 600)));
    assert.ok(Number.isFinite(calculatePrintScale({ width: 0, height: 0 }, 800, 600)));
});

test('全系統色は共通マスタから固定hexへsnapshotし、後のマスタ・接続変更から独立する', () => {
    const input = fixture();
    const options = createPrintSettings();
    input.links[0].system_id = 8;
    input.linkSystems = [{ id: 8, name: '共通系統', color_key: 'indigo', resource_revision: 1 }];
    for (const entry of LINK_SYSTEM_COLORS) {
        input.linkSystems[0].color_key = entry.key;
        const before = structuredClone(input);
        const model = buildPrintModel(input, options);
        assert.equal(model.wires[0].color, entry.color);
        assert.deepEqual(input, before, 'snapshot作成は共通マスタも保存データも変更しない');
        input.linkSystems[0].color_key = 'slate';
        input.linkSystems[0].name = '後から改名';
        input.links[0].system_id = null;
        input.linkSystems.splice(0, 1);
        assert.equal(model.wires[0].color, entry.color, '後編集・削除は既存snapshotへ影響しない');
        input.links[0].system_id = 8;
        input.linkSystems.push({ id: 8, name: '共通系統', color_key: entry.key });
    }
});

test('旧形式・未設定・見つからない系統は従来の印刷色を維持する', () => {
    const input = fixture();
    const options = createPrintSettings();
    assert.equal(buildPrintModel(input, options).wires[0].color, '#334155');
    input.linkSystems = [{ id: 8, name: '不明な色', color_key: 'unknown' }];
    for (const id of [null, 999, 8]) {
        input.links[0].system_id = id;
        assert.equal(buildPrintModel(input, options).wires[0].color, '#334155');
    }
});

test('機器名・機器種別のOFFでノード表示項目を制御できる', () => {
    const input = fixture();
    const options = createPrintSettings();
    const full = buildPrintModel(input, options);
    assert.equal(full.nodes[0].name, '合成機器1');
    assert.equal(full.nodes[0].showDeviceType, true);

    options.deviceName = false;
    const noName = buildPrintModel(input, options);
    assert.deepEqual(noName.nodes.map(n => n.name), input.devices.map(() => ''));
    assert.equal(noName.nodes[0].showDeviceType, true);

    options.deviceName = true;
    options.deviceType = false;
    const noType = buildPrintModel(input, options);
    assert.equal(noType.nodes[0].name, '合成機器1');
    assert.deepEqual(noType.nodes.map(n => n.showDeviceType), input.devices.map(() => false));
});

test('rack print has both physical faces, common descending U, mirrored halves, and one block per multi-U face', () => {
    const input = fixture();
    input.view.view_type = 'rack';
    input.rackSettings = [{ view_id: 1, total_u: 8, location: '機械室' }];
    input.rackMounts = [
        { device_id: 1, view_id: 1, face: 'front', start_u: 1, height_u: 2, width_slot: 'left' },
        { device_id: 2, view_id: 1, face: 'rear', start_u: 1, height_u: 1, width_slot: 'left' },
        { device_id: 3, view_id: 1, face: 'both', start_u: 4, height_u: 3, width_slot: 'full' },
        { device_id: 4, view_id: 2, face: 'front', start_u: 8, height_u: 1, width_slot: 'full' }
    ];
    const before = structuredClone(input);
    const options = createPrintSettings();
    options.range = 'viewport';
    const model = buildPrintModel(input, options);
    assert.equal(model.empty, false);
    assert.deepEqual(model.rack.faces.map(face => face.face), ['front', 'rear']);
    assert.deepEqual(model.rack.rows.map(row => row.u), [8, 7, 6, 5, 4, 3, 2, 1]);
    const front = model.rack.blocks.find(block => block.deviceId === 1);
    const rear = model.rack.blocks.find(block => block.deviceId === 2);
    assert.equal(front.slot, 'left');
    assert.equal(rear.slot, 'right');
    assert.equal(front.height, model.rack.rowHeight * 2);
    assert.equal(front.y + front.height, model.rack.faces[0].y + model.rack.faces[0].height);
    assert.equal(rear.x, model.rack.faces[1].x + model.rack.faces[1].width / 2);
    const both = model.rack.blocks.filter(block => block.deviceId === 3);
    assert.equal(both.length, 2);
    assert.equal(both[0].y, both[1].y);
    assert.equal(both[0].height, 3 * model.rack.rowHeight);
    assert.equal(model.rack.blocks.length, 4);
    assert.deepEqual(model.wires, []);
    assert.deepEqual(model.notes.map(note => [note.id, note.text]), input.notes
        .filter(note => note.view_id === input.view.id).map(note => [note.id, note.text]));
    assert.ok(model.notes.every(note => note.x >= model.rack.bounds.width));
    assert.ok(model.notes.every(note => note.y + note.height <= model.bounds.y + model.bounds.height));
    assert.equal(model.floorPlan, null);
    assert.ok(model.title.location.includes('機械室'));
    assert.notDeepEqual(model.bounds, input.viewport);
    assert.deepEqual(input, before);
});

test('empty or type-filtered rack keeps its complete printable U geometry and honors content options', () => {
    const input = fixture();
    input.view.view_type = 'rack';
    input.rackSettings = [{ view_id: 1, total_u: 60 }];
    input.rackMounts = [{ device_id: 1, view_id: 1, face: 'both', start_u: 1, height_u: 1, width_slot: 'full' }];
    const options = createPrintSettings();
    options.deviceName = false; options.deviceType = false; options.ip = false;
    const model = buildPrintModel(input, options);
    assert.equal(model.rack.blocks[0].name, '');
    assert.equal(model.rack.blocks[0].ip, '');
    assert.equal(model.rack.blocks[0].showDeviceType, false);
    options.deviceTypes.switch = false;
    const filtered = buildPrintModel(input, options);
    assert.equal(filtered.rack.blocks.length, 0);
    assert.equal(filtered.empty, false);
    assert.equal(filtered.rack.rows.length, 60);
    assert.deepEqual(filtered.bounds, model.bounds);
    input.rackMounts = [];
    assert.deepEqual(buildPrintModel(input, options).bounds, model.bounds);
});

test('ラック注釈は別ビューを含めず本文・見た目を保ち、OFFでも搭載座標を変えない', () => {
    const input = fixture();
    input.view.view_type = 'rack';
    input.notes.push({ ...input.notes[0], id: 99, view_id: 2, text: '別ラックの注釈', y: 9000 });
    input.notes.push({ ...input.notes[0], id: 100, x: 0, y: 0, text: '別の注釈\n' + '長文'.repeat(100) });
    input.rackSettings = [{ view_id: 1, total_u: 8 }];
    input.rackMounts = [{ device_id: 1, view_id: 1, face: 'front', start_u: 2, height_u: 2, width_slot: 'full' }];
    const options = createPrintSettings();
    const annotated = buildPrintModel(input, options);
    const original = input.notes.filter(note => note.view_id === 1);
    const appearance = ({ id, text, background_color, background_opacity, text_color, font_size }) =>
        ({ id, text, background_color, background_opacity, text_color, font_size });
    assert.deepEqual(annotated.notes.map(appearance), original.map(appearance));
    for (let index = 1; index < annotated.notes.length; index++) {
        assert.ok(annotated.notes[index].y >= annotated.notes[index - 1].y + annotated.notes[index - 1].height,
            '自由配置の保存座標が重なっていても印刷時の注釈は重ならない');
    }
    options.notes = false;
    const plain = buildPrintModel(input, options);
    assert.deepEqual(plain.notes, []);
    assert.deepEqual(annotated.rack.blocks, plain.rack.blocks);
    assert.deepEqual(plain.bounds, plain.rack.bounds);
});

test('ラックメモの印刷は上中下の領域順と見出しを保ち、全件を重ならず投影する', () => {
    const input = fixture();
    input.view.view_type = 'rack';
    const base = input.notes[0];
    input.notes = [
        { ...base, id: 3, x: RACK_NOTE_REGION_X, y: 2, text: '下段' },
        { ...base, id: 1, x: 2200, y: 1600, text: '既存上段' },
        { ...base, id: 2, x: RACK_NOTE_REGION_X, y: 1, text: '中段\n' + '長文'.repeat(500) },
        { ...base, id: 4, x: 1, y: 2, text: 'もう一つの既存上段' }
    ];
    const original = structuredClone(input);
    for (const totalU of [1, 42, 60]) {
        input.rackSettings = [{ view_id: 1, total_u: totalU }];
        const model = buildPrintModel(input, createPrintSettings());
        assert.deepEqual(model.notes.map(note => [note.id, note.regionLabel]),
            [[1, '上段'], [4, '上段'], [2, '中段'], [3, '下段']]);
        assert.deepEqual(model.notes.map(note => note.text), [input.notes[1].text, input.notes[3].text, input.notes[2].text, input.notes[0].text]);
        for (let index = 1; index < model.notes.length; index++) {
            assert.ok(model.notes[index].y >= model.notes[index - 1].y + model.notes[index - 1].height);
        }
        assert.ok(model.notes.every(note => note.x < 1000 && note.y + note.height <= model.bounds.y + model.bounds.height));
        assert.deepEqual(input.notes, original.notes);
        assert.equal(model.rack.rows.length, totalU);
    }
});
