import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildManualLinkRoute, normalizeManualRoute } from '../public/js/canvas/manual-link-route.js';

const point = (x, y) => ({ x, y });

function assertGeometry(route, start, end) {
    assert.ok(Array.isArray(route) && route.length >= 1);
    assert.deepEqual(route[0], start);
    assert.deepEqual(route.at(-1), end);
    assert.ok(route.length - 2 <= 8, '描画上の中間点も最大8点');
    for (const p of route) {
        assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
    }
    for (let i = 1; i < route.length; i++) {
        const a = route[i - 1];
        const b = route[i];
        assert.ok(a.x === b.x || a.y === b.y, 'すべての区間は厳密に直交する');
        assert.notDeepEqual(a, b, 'ゼロ長区間を残さない');
    }
}

function assertContains(route, anchor) {
    assert.ok(route.some(p => p.x === anchor.x && p.y === anchor.y) || route.slice(1).some((b, i) => {
        const a = route[i];
        return (a.x === b.x && anchor.x === a.x && anchor.y >= Math.min(a.y, b.y) && anchor.y <= Math.max(a.y, b.y)) ||
            (a.y === b.y && anchor.y === a.y && anchor.x >= Math.min(a.x, b.x) && anchor.x <= Math.max(a.x, b.x));
    }), 'アンカーの位置を経路が通る');
}

test('保存検証を再利用し、9点・非有限値・斜め・余分な属性を拒否する', () => {
    const invalid = [
        undefined, null, {},
        Array.from({ length: 9 }, (_, i) => point(i, 0)),
        [point(NaN, 0)], [point(0, Infinity)], [point(-Infinity, 0)],
        [point('1', 0)], [[1, 2]], [null], [{ x: 1 }],
        [{ x: 1, y: 2, z: 3 }], [point(0, 0), point(1, 1)]
    ];
    for (const points of invalid) {
        assert.throws(() => normalizeManualRoute(points));
        assert.throws(() => buildManualLinkRoute(point(0, 0), point(10, 10), points));
    }
    // 整理すれば1点になる入力でも、保存時の点数上限を先に適用する。
    assert.throws(() => normalizeManualRoute(Array.from({ length: 9 }, () => point(0, 0))));
});

test('重複・ゼロ長・同方向共線点を除き、折り返しは保持する', () => {
    const input = [point(0, 0), point(0, 0), point(5, 0), point(10, 0), point(5, 0), point(5, 5), point(5, 10), point(5, 10)];
    assert.deepEqual(normalizeManualRoute(input), [point(0, 0), point(10, 0), point(5, 0), point(5, 10)]);
    assert.deepEqual(normalizeManualRoute([point(0, 0), point(0, 10), point(0, -10)]),
        [point(0, 0), point(0, 10), point(0, -10)]);
    assert.deepEqual(normalizeManualRoute([point(1, 2), point(1, 2)]), [point(1, 2)]);
});

test('微小な折れは近似で消さず、座標の大きさに追加制限を設けない', () => {
    const tiny = [point(0, 0), point(0.00001, 0), point(0.00001, 0.00001), point(1, 0.00001)];
    assert.deepEqual(normalizeManualRoute(tiny), tiny);
    const route = buildManualLinkRoute(point(-1, 0), point(2, 0.00001), tiny);
    assert.deepEqual(route, [point(-1, 0), point(0.00001, 0), point(0.00001, 0.00001), point(2, 0.00001)]);
    assertGeometry(route, point(-1, 0), point(2, 0.00001));
    const large = [point(-Number.MAX_VALUE, 0), point(0, 0), point(Number.MAX_VALUE, 0)];
    assert.deepEqual(normalizeManualRoute(large), [large[0], large[2]]);
    const largeRoute = buildManualLinkRoute(large[0], large[2], large);
    assert.deepEqual(largeRoute, [large[0], large[2]]);
    assertGeometry(largeRoute, large[0], large[2]);
});

test('0点は直線または横から縦へのL字で接続する', () => {
    const cases = [
        [point(0, 0), point(30, 40), [point(0, 0), point(30, 0), point(30, 40)]],
        [point(0, 5), point(30, 5), [point(0, 5), point(30, 5)]],
        [point(5, 0), point(5, 30), [point(5, 0), point(5, 30)]],
        [point(5, 5), point(5, 5), [point(5, 5)]]
    ];
    for (const [start, end, expected] of cases) {
        const route = buildManualLinkRoute(start, end, []);
        assert.deepEqual(route, expected);
        assertGeometry(route, start, end);
    }
});

test('1点のアンカーを通り、開始側は横→縦、終了側は縦→横で接続する', () => {
    const anchor = point(20, 30);
    const start = point(0, 50);
    const end = point(50, 70);
    const route = buildManualLinkRoute(start, end, [anchor]);
    assert.deepEqual(route, [start, point(20, 50), anchor, point(20, 70), end]);
    assertGeometry(route, start, end);
    assertContains(route, anchor);
    const forward = buildManualLinkRoute(point(0, 0), point(50, 60), [anchor]);
    assert.deepEqual(forward, [point(0, 0), point(20, 0), point(20, 60), point(50, 60)]);
    assertContains(forward, anchor);
});

test('2点は両端を元の区間軸へ投影し、途中で重なっても軸を変えない', () => {
    const cases = [
        [point(0, 0), point(100, 90), [point(20, 10), point(20, 70)],
            [point(0, 0), point(20, 0), point(20, 90), point(100, 90)]],
        [point(0, 0), point(100, 90), [point(20, 10), point(80, 10)],
            [point(0, 0), point(0, 10), point(100, 10), point(100, 90)]],
        [point(20, 0), point(30, 30), [point(10, 10), point(20, 10)],
            [point(20, 0), point(20, 10), point(30, 10), point(30, 30)]],
        [point(0, 20), point(30, 30), [point(10, 10), point(10, 20)],
            [point(0, 20), point(10, 20), point(10, 30), point(30, 30)]]
    ];
    for (const [start, end, manual, expected] of cases) {
        const route = buildManualLinkRoute(start, end, manual);
        assert.deepEqual(route, expected);
        assertGeometry(route, start, end);
    }
});

test('4点は端点移動とresize後の中心変更で境界だけを接続し直す', () => {
    const manual = [point(20, 10), point(20, 40), point(80, 40), point(80, 70)];
    const originalStart = point(0, 10);
    const originalEnd = point(100, 70);
    const cases = [
        [originalStart, originalEnd, [originalStart, ...manual, originalEnd]],
        [point(0, 0), originalEnd, [point(0, 0), point(20, 0), manual[1], manual[2], manual[3], originalEnd]],
        [originalStart, point(100, 90), [originalStart, manual[0], manual[1], manual[2], point(80, 90), point(100, 90)]],
        [point(0, 0), point(100, 90), [point(0, 0), point(20, 0), manual[1], manual[2], point(80, 90), point(100, 90)]]
    ];
    // 同じ配置位置で幅・高さだけを変えた機器中心も、移動と同じ接続規則を使う。
    const placement = { x: -40, y: -30, width: 100, height: 100 };
    const resizedCenter = point(placement.x + placement.width / 2, placement.y + placement.height / 2);
    cases.push([resizedCenter, originalEnd, [resizedCenter, point(20, 20), manual[1], manual[2], manual[3], originalEnd]]);
    for (const [start, end, expected] of cases) {
        const route = buildManualLinkRoute(start, end, manual);
        assert.deepEqual(route, expected);
        assertGeometry(route, start, end);
        assert.deepEqual(route.slice(2, 4), manual.slice(1, 3), '内側の中間点を移動しない');
    }
});

test('すでに直交する端点接続では境界点を変更しない', () => {
    const manual = [point(20, 10), point(20, 40), point(80, 40), point(80, 70)];
    const start = point(20, 30);
    const end = point(80, 50);
    const route = buildManualLinkRoute(start, end, manual);
    assert.deepEqual(route, [start, ...manual, end]);
    assertGeometry(route, start, end);
});

test('8点は全内側点を維持し、両端移動後も最大8折れに収まる', () => {
    const manual = [point(10, 10), point(10, 20), point(30, 20), point(30, 40),
        point(50, 40), point(50, 60), point(70, 60), point(70, 80)];
    const start = point(-10, -20);
    const end = point(100, 100);
    assert.deepEqual(normalizeManualRoute(manual), manual);
    const route = buildManualLinkRoute(start, end, manual);
    assert.deepEqual(route, [start, point(10, -20), ...manual.slice(1, -1), point(70, 100), end]);
    assert.equal(route.length - 2, 8);
    assertGeometry(route, start, end);
});

test('端点と中間点の一致や同一機器中心でも直交性とアンカーを保つ', () => {
    const anchor = point(20, 30);
    const cases = [
        [anchor, point(50, 60), [anchor]],
        [point(0, 0), anchor, [anchor]],
        [anchor, anchor, [anchor]],
        [point(0, 0), point(0, 0), [anchor]],
        [point(20, 10), point(80, 70), [point(20, 10), point(20, 40), point(80, 40), point(80, 70)]],
        [point(0, 0), point(0, 0), [point(20, 10), point(20, 40), point(80, 40), point(80, 70)]]
    ];
    for (const [start, end, manual] of cases) {
        const route = buildManualLinkRoute(start, end, manual);
        assertGeometry(route, start, end);
        if (manual.length === 1) assertContains(route, anchor);
    }
});

test('非有限の端点はnullを返すが、不正な保存経路は例外にする', () => {
    for (const invalid of [null, undefined, point(NaN, 0), point(0, Infinity), point('0', 0)]) {
        assert.equal(buildManualLinkRoute(invalid, point(0, 0), []), null);
        assert.equal(buildManualLinkRoute(point(0, 0), invalid, []), null);
    }
    assert.throws(() => buildManualLinkRoute(point(NaN, 0), point(0, 0), [point(0, 0), point(1, 1)]));
});

test('入力を変更せず、戻り値は独立し、反復の結果が決定的である', () => {
    const manual = Object.freeze([point(20, 10), point(20, 40), point(80, 40), point(80, 70)].map(Object.freeze));
    const start = Object.freeze(point(0, 0));
    const end = Object.freeze(point(100, 90));
    const before = structuredClone({ manual, start, end });
    const normalized = normalizeManualRoute(manual);
    const expected = buildManualLinkRoute(start, end, manual);
    assert.notEqual(normalized, manual);
    for (let i = 0; i < manual.length; i++) assert.notEqual(normalized[i], manual[i]);
    for (let i = 0; i < 5; i++) {
        const route = buildManualLinkRoute(start, end, manual);
        assert.deepEqual(route, expected);
        assert.notEqual(route, expected);
        assertGeometry(route, start, end);
    }
    normalized[0].x = -999;
    const independent = buildManualLinkRoute(start, end, manual);
    independent[0].x = -999;
    independent[2].y = -999;
    assert.deepEqual(buildManualLinkRoute(start, end, manual), expected);
    assert.deepEqual({ manual, start, end }, before);
    assert.deepEqual(normalizeManualRoute(normalizeManualRoute(manual)), normalizeManualRoute(manual));
});
