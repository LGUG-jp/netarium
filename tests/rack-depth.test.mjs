import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateRackLayout, rackUsage, rackOverlap, toSaveRackMount } from '../public/js/core/rack-layout.js';
import { buildDashboardModel } from '../public/js/core/dashboard-model.js';
import { installWorkspaceDom } from './helpers/workspace-dom.mjs';
import { buildRackPrintLayout } from '../public/js/canvas/print-model.js';

const mount = (device_id, extra = {}) => ({ device_id, view_id: 1, face: 'front', start_u: 2, height_u: 2, width_slot: 'left', ...extra });
const fixture = mounts => ({ views: [{ id: 1, name: '試験ラック', view_type: 'rack' }],
    devices: [1, 2, 3].map(id => ({ id, name: `機器${id}`, type: 'server' })),
    rackSettings: [{ view_id: 1, total_u: 6, location: '' }], rackMounts: mounts, placements: [], links: [] });

test('旧搭載と半分同士は前後同一物理枠に共存し、全体は順序にかかわらず拒否する', () => {
    const old = mount(1), rear = mount(2, { face: 'rear', depth: 'half' });
    validateRackLayout(fixture([old, rear]));
    assert.equal(toSaveRackMount(old).depth, 'half');
    for (const rows of [[{ ...old, depth: 'full' }, rear], [rear, { ...old, depth: 'full' }],
        [old, { ...rear, depth: 'full' }]]) {
        assert.throws(() => validateRackLayout(fixture(rows)), /重複/);
    }
    for (const depth of [null, '', 'quarter', 1]) {
        assert.throws(() => validateRackLayout(fixture([mount(1, { depth })])), /奥行き/);
    }
});

test('全体半幅は前面基準の同じ左右だけ全Uで塞ぎ、反対半幅を消費しない', () => {
    const front = mount(1, { depth: 'full' });
    const rearRight = mount(2, { face: 'rear', width_slot: 'right' });
    validateRackLayout(fixture([front, rearRight]));
    assert.deepEqual(rackUsage(6, [front], 'front'), { empty: 4, half: 2, used: 0 });
    assert.deepEqual(rackUsage(6, [front], 'rear'), { empty: 4, half: 2, used: 0 });
    assert.equal(rackOverlap(front, rearRight), null);
    const boundary = mount(2, { face: 'rear', start_u: 3, height_u: 1 });
    assert.deepEqual(rackOverlap(front, boundary), { face: 'rear', slot: 'left', u: 3 });
    assert.throws(() => validateRackLayout(fixture([front, boundary])), /重複/);
    validateRackLayout(fixture([front, { ...boundary, start_u: 4 }]));
    const full = { ...front, width_slot: 'full' };
    assert.throws(() => validateRackLayout(fixture([full, rearRight])), /重複/);
    assert.deepEqual(rackUsage(6, [full], 'rear'), { empty: 4, half: 0, used: 2 });
    assert.throws(() => validateRackLayout(fixture([mount(1, { face: 'both', width_slot: 'full' }), rearRight])), /重複/);
});

test('ダッシュボードは反対面使用不可を占有率に含め、実機器を二重集計しない', () => {
    const data = fixture([mount(1, { depth: 'full' }), mount(2, { face: 'rear', start_u: 4, height_u: 1, width_slot: 'full' })]);
    const result = buildDashboardModel(data).racks;
    assert.equal(result.mountedDevices, 2);
    assert.equal(result.items[0].deviceCount, 2);
    assert.deepEqual(result.items[0].faces, {
        front: { empty: 4, occupiedPercentage: 2 / 12 * 100 },
        rear: { empty: 3, occupiedPercentage: 4 / 12 * 100 }
    });
});

test('印刷の反対面占有は搭載機器とは別に描画し、背面の物理半幅だけを反転する', () => {
    const data = fixture([mount(1, { depth: 'full' })]);
    const layout = buildRackPrintLayout(data.views[0], data.devices, data.rackSettings, data.rackMounts);
    assert.deepEqual(layout.blocks.map(block => [block.deviceId, block.face]), [[1, 'front']]);
    const blocked = layout.blockedSlots[0], rear = layout.faces[1], device = layout.blocks[0];
    assert.equal(blocked.face, 'rear');
    assert.equal(blocked.slot, 'right');
    assert.equal(blocked.x, rear.x + rear.width / 2);
    assert.equal(blocked.width, rear.width / 2);
    assert.deepEqual([blocked.y, blocked.height], [device.y, device.height]);
    assert.equal(blocked.causeName, '機器1');
});

test('奥行き入力と反対面グレーアウトは同じ物理左右・複数U判定を使う', async t => {
    const keys = ['window', 'document', 'Element', 'HTMLElement', 'requestAnimationFrame', 'cancelAnimationFrame'];
    const originals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const dom = installWorkspaceDom({ templates: ['templates/components/canvas.php', 'templates/components/canvas_context_toolbar.php'] });
    const create = document.createElement;
    document.createElement = tag => {
        const node = create(tag); node.style.setProperty = (key, value) => { node.style[key] = value; }; return node;
    };
    globalThis.requestAnimationFrame = callback => setTimeout(callback, 0);
    globalThis.cancelAnimationFrame = clearTimeout;
    const { appState, normalizeView, normalizeDevice } = await import('../public/js/core/state.js');
    const rack = await import('../public/js/canvas/rack-view.js');
    const resource = await import('../public/js/core/resource-save.js');
    const queue = await import('../public/js/core/save-queue.js');
    Object.assign(appState, fixture([mount(1, { depth: 'full' })]), {
        views: [normalizeView({ id: 1, name: '試験ラック', view_type: 'rack', resource_revision: 10 })],
        devices: [1, 2].map(id => normalizeDevice({ id, name: `機器${id}`, type: 'server', resource_revision: id })),
        currentViewId: 1, canvas: dom.get('canvas'), world: dom.get('world'), floorPlans: [], canvasNotes: [], deviceImages: [],
        selectedPlacementIds: new Set(), resourceConflicts: { devices: new Map(), views: new Map() },
        appStatus: { dirty: false, state: 'saved' }, authExpired: false, isSaving: false
    });
    t.after(async () => {
        queue.clearPendingSave(); await new Promise(resolve => setTimeout(resolve, 0));
        for (const [key, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
        }
    });
    resource.resetResourceBaseline(appState); rack.renderRackView();
    const root = dom.get('rack-view');
    const rear = root.querySelector('.rack-rear');
    assert.equal(rear.querySelectorAll('.rack-device').length, 0, '反対面には別機器のブロックを作らない');
    const blocked = rear.querySelectorAll('.rack-depth-blocked');
    assert.deepEqual(blocked.map(node => [node.dataset.u, node.dataset.slot]), [['3', 'left'], ['2', 'left']]);
    for (const node of blocked) {
        assert.equal(node.disabled, true);
        assert.ok(node.getAttribute('aria-label').includes('右半分 反対面の機器により占有（機器1）'));
        await node.dispatch('click');
        assert.equal(document.querySelector('.rack-mount-form'), null);
    }
    assert.ok(rear.querySelector('.rack-usage').textContent.includes('空きU 4 / 半空きU 2'));
    const available = rear.querySelectorAll('.rack-empty').find(node => node.dataset.u === '2' && node.dataset.slot === 'right');
    assert.equal(available.disabled, false);
    rack.openRackMountDialog({ viewId: 1, face: 'rear', startU: 2, heightU: 2, widthSlot: 'right' });
    const search = dom.get('rack-mount-search'); search.value = '機器2'; await search.dispatch('input');
    await search.dispatch('keydown', { key: 'ArrowDown' }); await search.dispatch('keydown', { key: 'Enter' });
    const form = document.querySelector('.rack-mount-form');
    const submit = form.querySelector('button[type="submit"]');
    assert.equal(dom.get('rack-mount-depth').value, 'half');
    const primaryFields = form.querySelector('.rack-mount-row-primary').querySelectorAll('.rack-mount-field');
    const secondaryFields = form.querySelector('.rack-mount-row-secondary').querySelectorAll('.rack-mount-field');
    assert.equal(primaryFields.length, 3, '1段目は面・幅・奥行きの3列');
    assert.equal(secondaryFields.length, 2, '2段目は開始U・占有Uの2列');
    assert.equal(primaryFields[1].querySelector('label').textContent, '横幅位置');
    assert.equal(primaryFields[2].querySelector('label').textContent, '奥行き');
    assert.ok(form.querySelector('.rack-warning').textContent.includes('横幅位置は各面から見た左右です'));
    assert.equal(submit.disabled, false);
    dom.get('rack-mount-width').value = 'right'; await dom.get('rack-mount-width').dispatch('input');
    assert.equal(submit.disabled, true, '背面から右=物理左は反対面全体と衝突');
    assert.ok(dom.get('rack-mount-error').textContent.includes('機器1'));
    appState.rackMounts[0].depth = 'half';
    await dom.get('rack-mount-width').dispatch('input');
    assert.equal(submit.disabled, false, '半分同士は同じ物理左でも共存');
    dom.get('rack-mount-depth').value = 'full'; await dom.get('rack-mount-depth').dispatch('input');
    assert.equal(submit.disabled, true, '新しい側を全体にしても前面機器と衝突');
    form.querySelectorAll('button').find(node => node.textContent === 'キャンセル').dispatch('click');
});
