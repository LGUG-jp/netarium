import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LINK_MANUAL_ROUTE_MAX_POINTS } from '../public/js/core/constants.js';
import { buildManualLinkRoute } from '../public/js/canvas/manual-link-route.js';
import {
    manualRouteFromPolyline,
    moveManualRouteSegment,
    addManualRouteDogleg,
    removeManualRouteBends
} from '../public/js/canvas/manual-link-route-edit.js';

const p = (x, y) => ({ x, y });
const straight = [p(0, 0), p(100, 0)];
const elbow = [p(0, 0), p(40, 0), p(40, 60), p(100, 60)];
const staircase = count => Array.from({ length: count + 2 }, (_, i) =>
    p(Math.ceil(i / 2) * 20, Math.floor(i / 2) * 20));

function assertGeometry(route, original) {
    assert.deepEqual(route[0], original[0]);
    assert.deepEqual(route.at(-1), original.at(-1));
    assert.ok(route.length - 2 <= LINK_MANUAL_ROUTE_MAX_POINTS);
    for (let i = 0; i < route.length; i++) {
        assert.ok(Number.isFinite(route[i].x) && Number.isFinite(route[i].y));
        if (i) assert.ok(route[i - 1].x === route[i].x || route[i - 1].y === route[i].y);
    }
    const rebuilt = buildManualLinkRoute(route[0], route.at(-1), manualRouteFromPolyline(route));
    assert.deepEqual(rebuilt, route, '保存用中間点から実際の描画geometryを再現する');
}

test('fullrouteから端点を除き、厳密な重複・同方向共線点だけを整理する', () => {
    const route = [p(0, 0), p(10, 0), p(10, 0), p(20, 0), p(20, 20), p(40, 20)];
    assert.deepEqual(manualRouteFromPolyline(route), [p(20, 0), p(20, 20)]);
    const turnaround = [p(0, 0), p(20, 0), p(10, 0), p(10, 20)];
    assert.deepEqual(manualRouteFromPolyline(turnaround), [p(20, 0), p(10, 0)]);
});

test('微小な折れと非常に大きい有限座標を保持する', () => {
    const route = [p(0, 0), p(1e-12, 0), p(1e-12, 1e-12), p(1e100, 1e-12)];
    assert.deepEqual(manualRouteFromPolyline(route), route.slice(1, -1));
    assertGeometry(moveManualRouteSegment(route, 1, 1e-13), route);
});

test('2端点のauto斜線は0中間点になり、既存builderで直交化される', () => {
    const diagonal = [p(0, 0), p(80, 60)];
    assert.deepEqual(manualRouteFromPolyline(diagonal), []);
    assert.deepEqual(buildManualLinkRoute(...diagonal, manualRouteFromPolyline(diagonal)),
        [p(0, 0), p(80, 0), p(80, 60)]);
    assert.throws(() => moveManualRouteSegment(diagonal, 0, 1));
    assert.throws(() => addManualRouteDogleg(diagonal, 0));
    assert.throws(() => removeManualRouteBends(diagonal, 0));
});

test('fullrouteの型、finite、属性、直交性、整理前の点数上限を厳格に検査する', () => {
    for (const route of [null, {}, [], [p(0, 0)], [p(0, 0), p('1', 0)],
        [p(0, 0), p(NaN, 0)], [p(0, 0), p(0, Infinity)],
        [p(0, 0), { x: 1, y: 0, extra: true }], [p(0, 0), [1, 0]],
        [p(0, 0), p(1, 1), p(2, 1)], staircase(LINK_MANUAL_ROUTE_MAX_POINTS + 1),
        Array.from({ length: LINK_MANUAL_ROUTE_MAX_POINTS + 3 }, (_, i) => p(i, 0))]) {
        assert.throws(() => manualRouteFromPolyline(route));
    }
    assert.equal(manualRouteFromPolyline(staircase(LINK_MANUAL_ROUTE_MAX_POINTS)).length,
        LINK_MANUAL_ROUTE_MAX_POINTS);
});

test('内部H区間のドラッグはyだけ、内部V区間はxだけを動かす', () => {
    const hRoute = [p(0, 0), p(0, 20), p(50, 20), p(50, 60)];
    const horizontal = moveManualRouteSegment(hRoute, 1, 7);
    assert.deepEqual(horizontal, [p(0, 0), p(0, 27), p(50, 27), p(50, 60)]);
    assertGeometry(horizontal, hRoute);
    const vertical = moveManualRouteSegment(elbow, 1, -7);
    assert.deepEqual(vertical, [p(0, 0), p(33, 0), p(33, 60), p(100, 60)]);
    assertGeometry(vertical, elbow);
});

test('先頭と末尾のH/V区間は機器端点を動かさず直交接続を挿入する', () => {
    const first = moveManualRouteSegment(elbow, 0, 10);
    assert.deepEqual(first, [p(0, 0), p(0, 10), p(40, 10), p(40, 60), p(100, 60)]);
    assertGeometry(first, elbow);
    const last = moveManualRouteSegment(elbow, 2, -10);
    assert.deepEqual(last, [p(0, 0), p(40, 0), p(40, 50), p(100, 50), p(100, 60)]);
    assertGeometry(last, elbow);
    const transpose = route => route.map(({ x, y }) => p(y, x));
    assert.deepEqual(moveManualRouteSegment(transpose(elbow), 0, 10), transpose(first));
    assert.deepEqual(moveManualRouteSegment(transpose(elbow), 2, -10), transpose(last));
});

test('直線のドラッグは両端固定のU字になり、0deltaは形を変えない', () => {
    const moved = moveManualRouteSegment(straight, 0, 12);
    assert.deepEqual(moved, [p(0, 0), p(0, 12), p(100, 12), p(100, 0)]);
    assertGeometry(moved, straight);
    const vertical = [p(0, 0), p(0, 100)];
    assert.deepEqual(moveManualRouteSegment(vertical, 0, -12),
        [p(0, 0), p(-12, 0), p(-12, 100), p(0, 100)]);
    assert.deepEqual(moveManualRouteSegment(elbow, 1, 0), elbow);
});

test('同軸の折り返し区間を動かしても近隣との接続は直交のまま', () => {
    const route = [p(0, 0), p(40, 0), p(20, 0), p(20, 40)];
    const moved = moveManualRouteSegment(route, 1, 10);
    assert.deepEqual(moved, [p(0, 0), p(40, 0), p(40, 10), p(20, 10), p(20, 40)]);
    assertGeometry(moved, route);
});

test('ドラッグによる8点超過と算術overflowを拒否する', () => {
    const route = staircase(LINK_MANUAL_ROUTE_MAX_POINTS);
    assertGeometry(moveManualRouteSegment(route, 1, 1), route);
    assert.throws(() => moveManualRouteSegment(route, 0, -1));
    const huge = [p(0, Number.MAX_VALUE), p(10, Number.MAX_VALUE)];
    assert.throws(() => moveManualRouteSegment(huge, 0, Number.MAX_VALUE));
});

test('H/Vの折れ追加は指定の垂直offsetで両端固定のU字を作る', () => {
    const added = addManualRouteDogleg(straight, 0, 5);
    assert.deepEqual(added, [p(0, 0), p(0, 5), p(100, 5), p(100, 0)]);
    assertGeometry(added, straight);
    const vertical = [p(0, 0), p(0, 100)];
    const negative = addManualRouteDogleg(vertical, 0, -5);
    assert.deepEqual(negative, [p(0, 0), p(-5, 0), p(-5, 100), p(0, 100)]);
    assertGeometry(negative, vertical);
});

test('既存の迂回区間への追加は単なる平行移動にならず、2折れを超える経路になる', () => {
    const detour = moveManualRouteSegment(straight, 0, 20);
    const added = addManualRouteDogleg(detour, 1, 5);
    assert.deepEqual(added, [p(0, 0), p(0, 20), p(50, 20), p(50, 25), p(100, 25), p(100, 0)]);
    assertGeometry(added, detour);
    for (const index of [0, 2]) {
        const edge = addManualRouteDogleg(detour, index, 5);
        assert.equal(edge.length, detour.length + 2);
        assertGeometry(edge, detour);
    }
});

test('6点経路への追加は8点になり、7/8点には追加できない', () => {
    const six = staircase(LINK_MANUAL_ROUTE_MAX_POINTS - 2);
    const added = addManualRouteDogleg(six, 0, 5);
    assert.equal(added.length - 2, LINK_MANUAL_ROUTE_MAX_POINTS);
    assertGeometry(added, six);
    assert.throws(() => addManualRouteDogleg(staircase(LINK_MANUAL_ROUTE_MAX_POINTS - 1), 2));
    assert.throws(() => addManualRouteDogleg(staircase(LINK_MANUAL_ROUTE_MAX_POINTS), 2));
});

test('内部の部分削除は他の区間を残し、元の出発方向のL字でつなぐ', () => {
    const route = [p(0, 0), p(20, 0), p(20, 20), p(40, 20), p(40, 40), p(60, 40), p(60, 60)];
    const removed = removeManualRouteBends(route, 2);
    assert.deepEqual(removed, [p(0, 0), p(20, 0), p(20, 40), p(60, 40), p(60, 60)]);
    assertGeometry(removed, route);
    const horizontalDeparture = [p(0, 0), p(0, 20), p(20, 20), p(20, 40), p(40, 40), p(40, 60)];
    const hRemoved = removeManualRouteBends(horizontalDeparture, 2);
    assert.deepEqual(hRemoved, [p(0, 0), p(0, 20), p(40, 20), p(40, 60)]);
    assertGeometry(hRemoved, horizontalDeparture);
});

test('機器端点に接する選択でも近傍2中間点を削除し、端点は削除しない', () => {
    for (const index of [0, 1, 2]) {
        const removed = removeManualRouteBends(elbow, index);
        assert.deepEqual(removed, [p(0, 0), p(100, 0), p(100, 60)]);
        assertGeometry(removed, elbow);
    }
    const route = staircase(4);
    const removed = removeManualRouteBends(route, route.length - 2);
    assert.deepEqual(removed, [p(0, 0), p(20, 0), p(20, 20), p(60, 20), p(60, 40)]);
    assertGeometry(removed, route);
});

test('U doglegや保持されたUターンはユーザーの削除操作で戻せる', () => {
    const dogleg = addManualRouteDogleg(straight, 0);
    for (const index of [0, 1, 2]) assert.deepEqual(removeManualRouteBends(dogleg, index), straight);
    const turnaround = [p(0, 0), p(100, 0), p(50, 0), p(50, 60)];
    assert.deepEqual(manualRouteFromPolyline(turnaround), turnaround.slice(1, -1));
    assert.deepEqual(removeManualRouteBends(turnaround, 1), [p(0, 0), p(50, 0), p(50, 60)]);
});

test('直線、必要最小L字、整理しても点数が減らない経路は削除できない', () => {
    assert.throws(() => removeManualRouteBends(straight, 0));
    assert.throws(() => removeManualRouteBends([p(0, 0), p(50, 0), p(50, 60)], 0));
    assert.throws(() => removeManualRouteBends([p(0, 0), p(10, 0), p(20, 0), p(30, 0)], 1));
});

test('区間index、ゼロ長区間、移動量とoffsetを厳格に検査する', () => {
    for (const operation of [moveManualRouteSegment, addManualRouteDogleg, removeManualRouteBends]) {
        for (const index of [-1, 1, 0.5, NaN, '0']) assert.throws(() => operation(straight, index, 1));
        assert.throws(() => operation([p(0, 0), p(0, 0)], 0, 1));
        assert.throws(() => operation(staircase(LINK_MANUAL_ROUTE_MAX_POINTS + 1), 0, 1));
    }
    for (const value of [Infinity, NaN, '1', null]) {
        assert.throws(() => moveManualRouteSegment(straight, 0, value));
        assert.throws(() => addManualRouteDogleg(straight, 0, value));
    }
    assert.throws(() => addManualRouteDogleg(straight, 0, 0));
    const huge = [p(0, Number.MAX_VALUE), p(10, Number.MAX_VALUE)];
    assert.throws(() => addManualRouteDogleg(huge, 0, Number.MAX_VALUE));
});

test('全操作は入力不変で、戻り値の点も入力と共有しない', () => {
    const operations = [route => manualRouteFromPolyline(route),
        route => moveManualRouteSegment(route, 1, 5),
        route => moveManualRouteSegment(route, 1, 0),
        route => addManualRouteDogleg(route, 1, 5),
        route => removeManualRouteBends(route, 1)];
    for (const operation of operations) {
        const route = elbow.map(point => Object.freeze({ ...point }));
        Object.freeze(route);
        const result = operation(route);
        assert.deepEqual(route, elbow);
        for (const point of result) assert.ok(!route.includes(point));
        result[0].x = -999;
        assert.deepEqual(route, elbow);
    }
});
