import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rememberLastView, resolveInitialViewId } from '../public/js/core/last-view.js';

const state = {
    views: [{ id: 1, sort_order: 10 }, { id: 12, sort_order: 20 }],
    devices: [{ id: 30 }, { id: 31 }],
    placements: [{ id: 7, device_id: 30, view_id: 12 }]
};

function storageFixture(t, saved = '12') {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const values = new Map([['netarium.lastViewId', saved]]);
    globalThis.window = { localStorage: {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value)
    } };
    t.after(() => {
        if (previous) Object.defineProperty(globalThis, 'window', previous);
        else delete globalThis.window;
    });
    return values;
}

test('最後の選択を復元し、URLビューと機器の配置先を保存値より優先する', t => {
    storageFixture(t);
    const before = structuredClone(state);
    assert.equal(resolveInitialViewId(state, ''), 12);
    assert.equal(resolveInitialViewId(state, '?view=1'), 1);
    rememberLastView(1);
    assert.equal(resolveInitialViewId(state, ''), 1);
    assert.equal(resolveInitialViewId(state, '?device=30'), 12);
    assert.equal(resolveInitialViewId(state, '?device=31'), 1, '未配置機器の個票を開く背景は保存ビュー');
    assert.deepEqual(state, before, '表示先の解決で業務データを変更しない');
});

test('不正・削除済み・非公開のIDと不正な明示リンクは先頭へ戻す', t => {
    const values = storageFixture(t);
    for (const saved of [null, '', '0', '-1', '1e0', '12.0', '9007199254740992', '99', ' 12']) {
        values.set('netarium.lastViewId', saved);
        assert.equal(resolveInitialViewId(state, ''), 1, String(saved));
    }
    rememberLastView(12);
    for (const query of ['?view=99', '?view=invalid', '?view=1&view=12', '?view=1&device=30', '?device=99']) {
        assert.equal(resolveInitialViewId(state, query), 1, query);
    }
    assert.equal(resolveInitialViewId({ ...state, views: [] }, ''), null);
    for (const id of [null, -1, 0, NaN, Infinity, '1']) rememberLastView(id);
    assert.equal(resolveInitialViewId(state, ''), 12, '無効な選択で保存先を壊さない');
});

test('ストレージの読書きや取得が拒否されても起動と選択を継続する', t => {
    storageFixture(t);
    window.localStorage = {
        getItem() { throw new Error('read denied'); },
        setItem() { throw new Error('quota exceeded'); }
    };
    assert.equal(resolveInitialViewId(state, ''), 1);
    rememberLastView(12);
    assert.equal(resolveInitialViewId(state, '?view=12'), 12);
    Object.defineProperty(window, 'localStorage', { get() { throw new Error('denied'); } });
    assert.equal(resolveInitialViewId(state, ''), 1);
    rememberLastView(12);
});
