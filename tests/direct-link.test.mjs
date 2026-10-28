import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDirectLink, findDirectLinkTarget } from '../public/js/core/direct-link.js';

const state = {
    views: [{ id: 12, sort_order: 20 }, { id: 8, sort_order: 10 }, { id: 3, sort_order: 10 }],
    devices: [{ id: 305 }, { id: 306 }],
    placements: [
        { id: 1, device_id: 305, view_id: 12 },
        { id: 2, device_id: 305, view_id: 8 },
        { id: 3, device_id: 305, view_id: 3 }
    ]
};

test('直接リンクは正の安全な10進IDだけを解釈し、任意クエリを無視する', () => {
    assert.deepEqual(parseDirectLink('?view=12&device=305&next=https://example.invalid&token=ignored'), { view: 12, device: 305 });
    assert.deepEqual(parseDirectLink('?device=9007199254740991'), { device: Number.MAX_SAFE_INTEGER });
    assert.deepEqual(parseDirectLink('?view=0012'), { view: 12 });
    assert.deepEqual(parseDirectLink('?next=//example.invalid'), {});
    for (const value of ['', '0', '-1', '1.2', '1e2', '9007199254740992', 'Infinity', 'NaN', ' 1', '1\n', '<script>']) {
        assert.equal(parseDirectLink(`?view=${encodeURIComponent(value)}`), null, JSON.stringify(value));
    }
    for (const query of ['?view=12&view=12', '?device=305&device=306', '?view=12&%76iew=8', '?view=12&device=']) {
        assert.equal(parseDirectLink(query), null, query);
    }
});

test('ビューのみと明示した機器配置を解決し、不一致を他ビューへ転送しない', () => {
    assert.deepEqual(findDirectLinkTarget({ view: 12 }, state), { kind: 'view', view: state.views[0] });
    const target = findDirectLinkTarget({ view: 12, device: 305 }, state);
    assert.equal(target.view.id, 12);
    assert.equal(target.placement.id, 1);
    assert.equal(findDirectLinkTarget({ view: 12, device: 306 }, state), null);
    assert.equal(findDirectLinkTarget({ view: 99, device: 305 }, state), null);
    assert.equal(findDirectLinkTarget({ device: 999 }, state), null);
    assert.equal(findDirectLinkTarget(null, state), null);
    assert.deepEqual(findDirectLinkTarget({}, state), { kind: 'none' });
});

test('複数配置はsort_order、同順ならID順で決定し、未配置は台帳を選ぶ', () => {
    const before = structuredClone(state);
    const target = findDirectLinkTarget({ device: 305 }, state);
    assert.equal(target.view.id, 3);
    assert.equal(target.placement.id, 3);
    assert.deepEqual(findDirectLinkTarget({ device: 306 }, state), { kind: 'ledger', device: state.devices[1] });
    assert.deepEqual(state, before, '解決は配置やデータを変更しない');
    assert.equal(findDirectLinkTarget({ device: 305 }, { ...state, views: [] }), null, '孤立した配置を新規配置扱いしない');
});

test('ラック機器の共有リンクはその搭載先だけを解決しXY配置と共存する', () => {
    const rack = { id: 20, sort_order: 1, view_type: 'rack' };
    const mount = { device_id: 305, view_id: 20, face: 'rear', start_u: 1, height_u: 2, width_slot: 'left' };
    const data = { ...state, views: [...state.views, rack], rackMounts: [mount] };
    assert.deepEqual(findDirectLinkTarget({ view: 20, device: 305 }, data), {
        kind: 'rack', view: rack, device: state.devices[0], mount
    });
    assert.equal(findDirectLinkTarget({ device: 305 }, data).kind, 'rack');
    assert.equal(findDirectLinkTarget({ view: 12, device: 305 }, data).kind, 'placement');
    assert.equal(findDirectLinkTarget({ view: 20, device: 306 }, data), null);
});
