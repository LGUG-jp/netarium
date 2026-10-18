import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLinkDisplayMap } from '../public/js/canvas/link-crossings.js';
import { buildSvgPathData, calculateLinkLabelPosition } from '../public/js/canvas/link-router.js';
import { resolveTopologyLinkRoutes } from '../public/js/canvas/link-route-resolver.js';

const point = (x, y) => ({ x, y });
const line = (x1, y1, x2, y2) => [point(x1, y1), point(x2, y2)];
const display = (routes, mode) => createLinkDisplayMap(new Map(routes), mode);

// SVGの線分と曲線を読み、表示形状・連続性を確認する。
function geometry(pathData) {
    const tokens = pathData.split(/\s+/);
    const segments = [];
    const starts = [];
    const gaps = [];
    let current;
    for (let i = 0; i < tokens.length;) {
        const command = tokens[i++];
        const nextPoint = () => point(Number(tokens[i++]), Number(tokens[i++]));
        if (command === 'M') {
            const previous = current;
            current = nextPoint();
            starts.push(current);
            if (previous) gaps.push({ start: previous, end: current });
        } else if (command === 'L') {
            const end = nextPoint();
            segments.push({ start: current, end });
            current = end;
        } else {
            assert.equal(command, 'Q');
            const control = nextPoint();
            const end = nextPoint();
            segments.push({ start: current, control, end });
            current = end;
        }
    }
    return { starts, segments, gaps, end: current };
}

function onCurve(curve, t) {
    const u = 1 - t;
    return point(u * u * curve.start.x + 2 * u * t * curve.control.x + t * t * curve.end.x,
        u * u * curve.start.y + 2 * u * t * curve.control.y + t * t * curve.end.y);
}

function assertPoint(actual, expected) {
    assert.ok(Math.abs(actual.x - expected.x) < 0.000001);
    assert.ok(Math.abs(actual.y - expected.y) < 0.000001);
}

function assertContinuous(pathData, start, end) {
    const shape = geometry(pathData);
    assert.equal(shape.starts.length, 1);
    assertPoint(shape.starts[0], start);
    assertPoint(shape.end, end);
    for (let i = 1; i < shape.segments.length; i++) {
        assertPoint(shape.segments[i].start, shape.segments[i - 1].end);
    }
    for (const segment of shape.segments) {
        for (const p of [segment.start, segment.control, segment.end].filter(Boolean)) {
            assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
        }
    }
    return shape.segments.filter(segment => segment.control);
}

// 移動区間の境界を確認し、切れ目をまたぐ描画線分がないことを検証する。
function assertGaps(pathData, start, end, expected) {
    const shape = geometry(pathData);
    assertPoint(shape.starts[0], start);
    assertPoint(shape.end, end);
    assert.equal(shape.starts.length, expected.length + 1);
    assert.equal(shape.gaps.length, expected.length);
    assert.ok(shape.segments.every(segment => !segment.control));
    for (let i = 0; i < expected.length; i++) {
        assertPoint(shape.gaps[i].start, expected[i].start);
        assertPoint(shape.gaps[i].end, expected[i].end);
    }
    for (const segment of shape.segments) {
        for (const p of [segment.start, segment.end]) {
            assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
        }
        // SVGのL区間が非描画区間の内部を通らないことを調べる。
        for (const gap of expected) {
            const middle = point((gap.start.x + gap.end.x) / 2, (gap.start.y + gap.end.y) / 2);
            const dx = segment.end.x - segment.start.x;
            const dy = segment.end.y - segment.start.y;
            const lengthSquared = dx * dx + dy * dy;
            if (!lengthSquared) continue;
            const t = ((middle.x - segment.start.x) * dx + (middle.y - segment.start.y) * dy) / lengthSquared;
            const distance = Math.abs(dx * (middle.y - segment.start.y) - dy * (middle.x - segment.start.x));
            assert.ok(t <= 0 || t >= 1 || distance > 0.000001);
        }
    }
    return shape;
}

for (const reverse of [false, true]) {
    for (const vertical of [false, true]) {
        test(`${vertical ? '垂直' : '水平'}交差の${reverse ? '逆向き' : '順向き'}でも線を切らず同じ側へ山を描く`, () => {
            const upper = vertical ? line(0, 0, 0, 100) : line(0, 0, 100, 0);
            if (reverse) upper.reverse();
            const lower = vertical ? line(-50, 50, 50, 50) : line(50, -50, 50, 50);
            const result = display([[2, upper], [1, lower]]);
            assert.equal(result.get(1).pathData, buildSvgPathData(lower));
            const curves = assertContinuous(result.get(2).pathData, upper[0], upper[1]);
            assert.equal(curves.length, 1);
            const peak = onCurve(curves[0], 0.5);
            if (vertical) { assert.ok(peak.x > 0); assertPoint(point(0, peak.y), point(0, 50)); }
            else { assert.ok(peak.y < 0); assertPoint(point(peak.x, 0), point(50, 0)); }
        });
    }
}

test('斜め交差でも経路方向に沿った曲線で上側へ迂回する', () => {
    const route = line(0, 0, 100, 100);
    const result = display([[1, line(0, 100, 100, 0)], [2, route]]);
    const curves = assertContinuous(result.get(2).pathData, route[0], route[1]);
    assert.equal(curves.length, 1);
    const peak = onCurve(curves[0], 0.5);
    assert.ok(peak.x > 50 && peak.y < 50);
    for (const t of [0.25, 0.5, 0.75]) assert.ok(onCurve(curves[0], t).y < onCurve(curves[0], t).x);
});

test('内部折れ点をまたぐ交差も両側を連続したブリッジでつなぐ', () => {
    const route = [point(0, 0), point(50, 0), point(50, 50)];
    const result = display([[1, line(0, -50, 100, 50)], [2, route]]);
    const curves = assertContinuous(result.get(2).pathData, route[0], route.at(-1));
    assert.equal(curves.length, 1);
    assertPoint(curves[0].start, point(44, 0));
    assertPoint(curves[0].end, point(50, 6));
    const peak = onCurve(curves[0], 0.5);
    assert.ok(peak.x > 50 && peak.y < 0);
});

test('共通端点・T字接続・共有幹線の分岐と合流には山を作らない', () => {
    for (const routes of [
        [[1, line(0, 0, 50, 50)], [2, line(50, 50, 100, 0)]],
        [[1, line(50, -50, 50, 0)], [2, line(0, 0, 100, 0)]],
        [[1, line(0, 0, 100, 0)], [2, line(50, 0, 50, 50)]],
        [[1, [point(0, 0), point(50, 0), point(50, 50)]], [2, line(0, 0, 100, 0)]],
        [[1, [point(100, 0), point(50, 0), point(50, 50)]], [2, [point(50, 100), point(50, 0), point(0, 0)]]]
    ]) {
        const result = display(routes);
        for (const [id, route] of routes) assert.equal(result.get(id).pathData, buildSvgPathData(route));
    }
});

test('同一直線の重複・逆向き共有・平行線には山を作らない', () => {
    const routes = [[1, line(0, 0, 100, 100)], [2, line(80, 80, 20, 20)], [3, line(0, 2, 100, 102)]];
    const result = display(routes);
    for (const [id, route] of routes) assert.equal(result.get(id).pathData, buildSvgPathData(route));
});

test('近接交差は一つの山にまとめ、離れた交差では間の直線を残す', () => {
    for (const [positions, expected] of [[[48, 54], 1], [[30, 70], 2]]) {
        const result = display([[1, line(positions[0], -50, positions[0], 50)],
            [2, line(positions[1], -50, positions[1], 50)], [3, line(0, 0, 100, 0)]]);
        const curves = assertContinuous(result.get(3).pathData, point(0, 0), point(100, 0));
        assert.equal(curves.length, expected);
        if (expected === 2) assert.ok(curves[0].end.x < curves[1].start.x);
    }
});

test('短い経路・短い交差区間・端点付近では山を省略して線を残す', () => {
    for (const routes of [
        [[1, line(6, -50, 6, 50)], [2, line(0, 0, 12, 0)]],
        [[1, line(50, -3, 50, 3)], [2, line(0, 0, 100, 0)]],
        [[1, line(10, -50, 10, 50)], [2, line(0, 0, 100, 0)]]
    ]) assert.equal(display(routes).get(2).pathData, buildSvgPathData(routes[1][1]));
    const result = display([[1, line(14, -50, 14, 50)], [2, line(0, 0, 100, 0)]]);
    const curves = assertContinuous(result.get(2).pathData, point(0, 0), point(100, 0));
    assert.equal(curves.length, 1);
    assertPoint(curves[0].start, point(8, 0));
});

test('山付近のラベルを近くへ移動し、通常位置と過密時の位置は維持する', () => {
    for (const route of [line(0, 0, 100, 0), line(0, 0, 0, 100), line(0, 0, 100, 100)]) {
        const crossing = route[1].x === 0 ? line(-50, 50, 50, 50) : line(50, -50, 50, 150);
        const original = calculateLinkLabelPosition(route);
        const adjusted = display([[1, crossing], [2, route]]).get(2).labelPosition;
        assert.equal(adjusted.orientation, original.orientation);
        assert.notDeepEqual(adjusted, original);
        assert.ok(Math.hypot(adjusted.x - original.x, adjusted.y - original.y) <= 40.000001);
        assert.deepEqual(display([[2, route]]).get(2).labelPosition, original);
    }
    const routes = Array.from({ length: 9 }, (_, i) => [i + 1, line(10 + i * 10, -50, 10 + i * 10, 50)]);
    routes.push([20, line(0, 0, 100, 0)]);
    assert.deepEqual(display(routes).get(20).labelPosition, calculateLinkLabelPosition(routes.at(-1)[1]));
});

test('入力順で山の位置を変えず、元の経路を変更しない', () => {
    const routes = [[12, [point(0, 0), point(60, 0), point(60, 90)]], [3, line(30, -40, 30, 60)], [8, line(-20, 20, 100, 20)]];
    for (const [, route] of routes) { route.forEach(Object.freeze); Object.freeze(route); }
    const map = new Map(routes);
    const snapshot = structuredClone(map);
    assert.deepEqual(createLinkDisplayMap(map), display([...routes].reverse()));
    assert.deepEqual(map, snapshot);
    for (const [id, route] of routes) assert.equal(map.get(id), route);
});

test('重複点と不正な経路を扱い、長さゼロの端点を維持する', () => {
    const result = display([[1, [point(0, 0), point(0, 0), point(100, 0)]], [2, [point(0, 0), point(NaN, 10)]],
        [3, [point(0, 0)]], [4, [point(5, 5), point(5, 5)]]]);
    assertContinuous(result.get(1).pathData, point(0, 0), point(100, 0));
    assert.equal(result.has(2), false);
    assert.equal(result.has(3), false);
    assertPoint(geometry(result.get(4).pathData).end, point(5, 5));
});

test('500件までは全交差を表し、501件以上でも山数を制限して端点と連続性を保つ', () => {
    const routes = Array.from({ length: 80 }, (_, i) => [i + 1, line(20 + i * 20, -50, 20 + i * 20, 50)]);
    routes.push([10000, line(0, 0, 1700, 0)]);
    for (let i = 0; i < 420; i++) routes.push([100 + i, line(0, 1000 + i * 20, 100, 1000 + i * 20)]);
    const small = display(routes.slice(0, -1));
    assert.equal(assertContinuous(small.get(10000).pathData, point(0, 0), point(1700, 0)).length, 80);
    const result = display(routes);
    const curves = assertContinuous(result.get(10000).pathData, point(0, 0), point(1700, 0));
    assert.ok(curves.length >= 1 && curves.length <= 64);
    assert.deepEqual(result, display([...routes].reverse()));
});

test('既定方式は明示的なbridgeと同一の表示結果を返す', () => {
    const routes = [[1, line(50, -50, 50, 50)], [2, line(0, 0, 100, 0)]];
    assert.deepEqual(display(routes), display(routes, 'bridge'));
});

for (const reverse of [false, true]) {
    for (const vertical of [false, true]) {
        test(`gapの${vertical ? '垂直' : '水平'}交差は${reverse ? '逆向き' : '順向き'}でも低ID線を保ち同じ幅だけ切る`, () => {
            const route = vertical ? line(0, 0, 0, 100) : line(0, 0, 100, 0);
            if (reverse) route.reverse();
            const lower = vertical ? line(-50, 50, 50, 50) : line(50, -50, 50, 50);
            const routes = [[2, route], [1, lower]];
            const result = display(routes, 'gap');
            assert.equal(result.get(1).pathData, buildSvgPathData(lower));
            const boundary = vertical ? [point(0, 44), point(0, 56)] : [point(44, 0), point(56, 0)];
            if (reverse) boundary.reverse();
            assertGaps(result.get(2).pathData, route[0], route[1],
                [{ start: boundary[0], end: boundary[1] }]);
            assert.deepEqual(result.get(2).labelPosition, display(routes).get(2).labelPosition);
        });
    }
}

test('gapは斜め交差と折れ点をまたぐ交差でもbridgeと同じ境界を切る', () => {
    for (const reverse of [false, true]) {
        for (const route of [
            line(0, 0, 100, 100),
            [point(0, 0), point(50, 0), point(50, 50)]
        ]) {
            if (reverse) route.reverse();
            const lower = route.length === 2 ? line(0, 100, 100, 0) : line(0, -50, 100, 50);
            const routes = [[1, lower], [2, route]];
            const curves = assertContinuous(display(routes).get(2).pathData, route[0], route.at(-1));
            assert.equal(curves.length, 1);
            const shape = assertGaps(display(routes, 'gap').get(2).pathData, route[0], route.at(-1), curves);
            if (route.length === 3) {
                const boundaries = reverse ? [point(50, 6), point(44, 0)] : [point(44, 0), point(50, 6)];
                assertPoint(shape.gaps[0].start, boundaries[0]);
                assertPoint(shape.gaps[0].end, boundaries[1]);
                assert.ok(shape.segments.every(segment =>
                    !(segment.start.x === 50 && segment.start.y === 0) &&
                    !(segment.end.x === 50 && segment.end.y === 0)));
            } else {
                const offset = 6 / Math.sqrt(2);
                const boundaries = [point(50 - offset, 50 - offset), point(50 + offset, 50 + offset)];
                if (reverse) boundaries.reverse();
                assertPoint(shape.gaps[0].start, boundaries[0]);
                assertPoint(shape.gaps[0].end, boundaries[1]);
            }
        }
    }
});

test('gapは近接交差を結合し、離れた切れ目間の線を残す', () => {
    for (const [positions, boundaries] of [
        [[48, 54], [[42, 60]]],
        [[30, 70], [[24, 36], [64, 76]]]
    ]) {
        const routes = [[1, line(positions[0], -50, positions[0], 50)],
            [2, line(positions[1], -50, positions[1], 50)], [3, line(0, 0, 100, 0)]];
        const expected = boundaries.map(([from, to]) => ({ start: point(from, 0), end: point(to, 0) }));
        const shape = assertGaps(display(routes, 'gap').get(3).pathData, point(0, 0), point(100, 0), expected);
        if (boundaries.length === 2) {
            assert.ok(shape.segments.some(segment => segment.start.x === 36 && segment.end.x === 64));
        }
    }
});

test('gapも端点・共有区間・短い区間・端点付近では元の線を保つ', () => {
    for (const routes of [
        [[1, line(0, 0, 50, 50)], [2, line(50, 50, 100, 0)]],
        [[1, line(50, -50, 50, 0)], [2, line(0, 0, 100, 0)]],
        [[1, line(0, 0, 100, 0)], [2, line(50, 0, 50, 50)]],
        [[1, [point(0, 0), point(50, 0), point(50, 50)]], [2, line(0, 0, 100, 0)]],
        [[1, [point(100, 0), point(50, 0), point(50, 50)]], [2, [point(50, 100), point(50, 0), point(0, 0)]]],
        [[1, line(0, 0, 100, 100)], [2, line(80, 80, 20, 20)], [3, line(0, 2, 100, 102)]],
        [[1, line(6, -50, 6, 50)], [2, line(0, 0, 12, 0)]],
        [[1, line(50, -3, 50, 3)], [2, line(0, 0, 100, 0)]],
        [[1, line(10, -50, 10, 50)], [2, line(0, 0, 100, 0)]]
    ]) {
        const result = display(routes, 'gap');
        for (const [id, route] of routes) assert.equal(result.get(id).pathData, buildSvgPathData(route));
    }
    const routes = [[1, line(14, -50, 14, 50)], [2, line(0, 0, 100, 0)]];
    assertGaps(display(routes, 'gap').get(2).pathData, point(0, 0), point(100, 0),
        [{ start: point(8, 0), end: point(20, 0) }]);
});

test('両方式のラベル・優先順位は共通で、入力順や方式変更で元経路を変更しない', () => {
    const routes = [[12, [point(0, 0), point(60, 0), point(60, 90)]],
        [3, line(30, -40, 30, 60)], [8, line(-20, 20, 100, 20)]];
    for (const [, route] of routes) { route.forEach(Object.freeze); Object.freeze(route); }
    const map = new Map(routes);
    const snapshot = structuredClone(map);
    const bridge = createLinkDisplayMap(map, 'bridge');
    const gap = createLinkDisplayMap(map, 'gap');
    assert.deepEqual(gap, display([...routes].reverse(), 'gap'));
    assert.deepEqual(bridge, createLinkDisplayMap(map));
    assert.deepEqual(map, snapshot);
    for (const [id, route] of routes) {
        assert.equal(map.get(id), route);
        assert.deepEqual(gap.get(id).labelPosition, bridge.get(id).labelPosition);
        const curves = geometry(bridge.get(id).pathData).segments.filter(segment => segment.control);
        assertGaps(gap.get(id).pathData, route[0], route.at(-1), curves);
    }
    assert.equal(gap.get(3).pathData, buildSvgPathData(routes[1][1]));
});

test('gapも重複点と不正経路を扱い、長さゼロの経路を維持する', () => {
    const routes = [[1, line(50, -50, 50, 50)], [2, [point(0, 0), point(0, 0), point(100, 0)]],
        [3, [point(0, 0), point(NaN, 10)]], [4, [point(0, 0)]], [5, [point(5, 5), point(5, 5)]]];
    const result = display(routes, 'gap');
    assertGaps(result.get(2).pathData, point(0, 0), point(100, 0),
        [{ start: point(44, 0), end: point(56, 0) }]);
    assert.equal(result.has(3), false);
    assert.equal(result.has(4), false);
    assertPoint(geometry(result.get(5).pathData).end, point(5, 5));
});

test('gapも500件までは全交差を切り、501件以上では一つの区間の候補を8件以下に制限する', () => {
    const routes = Array.from({ length: 80 }, (_, i) => [i + 1, line(20 + i * 20, -50, 20 + i * 20, 50)]);
    routes.push([10000, line(0, 0, 1700, 0)]);
    for (let i = 0; i < 420; i++) routes.push([100 + i, line(0, 1000 + i * 20, 100, 1000 + i * 20)]);
    for (const entries of [routes.slice(0, -1), routes]) {
        const bridge = display(entries);
        const curves = assertContinuous(bridge.get(10000).pathData, point(0, 0), point(1700, 0));
        const gap = display(entries, 'gap');
        const shape = assertGaps(gap.get(10000).pathData, point(0, 0), point(1700, 0), curves);
        if (entries.length === 500) assert.equal(shape.gaps.length, 80);
        else assert.ok(shape.gaps.length >= 1 && shape.gaps.length <= 8);
        assert.deepEqual(gap, display([...entries].reverse(), 'gap'));
        assert.deepEqual(gap.get(10000).labelPosition, bridge.get(10000).labelPosition);
    }
});

test('501件以上の多区間経路でも両方式の交差区間は64件以下に収まる', () => {
    const routes = Array.from({ length: 80 }, (_, i) => [i + 1, line(20 + i * 20, -50, 20 + i * 20, 850)]);
    const route = [];
    for (let i = 0; i < 20; i++) {
        const y = i * 40;
        route.push(point(i % 2 ? 1700 : 0, y), point(i % 2 ? 0 : 1700, y));
    }
    routes.push([10000, route]);
    for (let i = 0; i < 420; i++) routes.push([100 + i, line(0, 2000 + i * 20, 100, 2000 + i * 20)]);
    const bridge = display(routes);
    const curves = assertContinuous(bridge.get(10000).pathData, route[0], route.at(-1));
    assert.ok(curves.length > 8 && curves.length <= 64);
    const gap = display(routes, 'gap');
    assertGaps(gap.get(10000).pathData, route[0], route.at(-1), curves);
    assert.deepEqual(gap, display([...routes].reverse(), 'gap'));
});

for (const mode of ['bridge', 'gap']) {
    test(`autoと多段manualの混在でも${mode}の交差・全長ラベル・端点追従を共用する`, () => {
        const placement = (id, x, y) => ({
            id, device_id: id, x: x - 10, y: y - 10, width: 20, height: 20
        });
        const placements = [
            placement(1, 50, -100), placement(2, 50, 100),
            placement(3, 0, 0), placement(4, 300, 200)
        ];
        const links = [
            { id: 1, from_id: 1, to_id: 2 },
            {
                id: 2, from_id: 3, to_id: 4, route_mode: 'manual',
                manual_route: [point(100, 0), point(100, 100), point(200, 100), point(200, 200)]
            }
        ];
        const snapshot = structuredClone({ links, placements });
        for (const moved of [false, true]) {
            const current = moved
                ? [placements[0], placements[1], placement(3, -40, 20), placement(4, 340, 240)]
                : placements;
            const routes = resolveTopologyLinkRoutes(links, current);
            const route = routes.get(2);
            const expected = moved
                ? [point(-40, 20), point(100, 20), point(100, 100), point(200, 100), point(200, 240), point(340, 240)]
                : [point(0, 0), ...links[1].manual_route, point(300, 200)];
            assert.deepEqual(route, expected);
            const beforeDisplay = structuredClone(routes);
            const result = createLinkDisplayMap(routes, mode);
            const y = moved ? 20 : 0;
            if (mode === 'gap') {
                assertGaps(result.get(2).pathData, route[0], route.at(-1),
                    [{ start: point(44, y), end: point(56, y) }]);
            } else {
                const curves = assertContinuous(result.get(2).pathData, route[0], route.at(-1));
                assert.equal(curves.length, 1);
                assertPoint(curves[0].start, point(44, y));
                assertPoint(curves[0].end, point(56, y));
                assert.ok(onCurve(curves[0], 0.5).y < y);
            }
            assert.deepEqual(result.get(2).labelPosition,
                { x: moved ? 180 : 150, y: 92, orientation: 'horizontal' });
            assert.equal(result.get(1).pathData, 'M 50 -100 L 50 100');
            assert.deepEqual(routes, beforeDisplay);
        }
        assert.deepEqual({ links, placements }, snapshot);
    });
}

for (const mode of ['bridge', 'gap']) {
    test(`manual同士の${mode}は8点の正規化・折り返し・方向反転・端点移動後も3交差を維持する`, () => {
        const placement = (id, x, y) => ({ id, device_id: id, x: x - 10, y: y - 10, width: 20, height: 20 });
        const saved = [point(100, 0), point(100, 50), point(100, 100), point(100, 100),
            point(0, 100), point(0, 200), point(200, 200), point(200, 300)];
        for (const moved of [false, true]) {
            for (const reversed of [false, true]) {
                const start = moved ? point(-40, 20) : point(0, 0);
                const end = moved ? point(340, 340) : point(300, 300);
                const links = [
                    { id: 1, from_id: 1, to_id: 2, route_mode: 'manual', manual_route: [] },
                    { id: 2, from_id: reversed ? 4 : 3, to_id: reversed ? 3 : 4,
                        route_mode: 'manual', manual_route: reversed ? [...saved].reverse() : saved }
                ];
                const placements = [placement(1, 50, -100), placement(2, 50, 400),
                    placement(3, start.x, start.y), placement(4, end.x, end.y)];
                const snapshot = structuredClone({ links, placements });
                const expected = [start, point(100, start.y), point(100, 100), point(0, 100),
                    point(0, 200), point(200, 200), point(200, end.y), end];
                if (reversed) expected.reverse();
                const routes = resolveTopologyLinkRoutes(links, placements);
                assert.deepEqual(routes.get(2), expected);
                const spans = [
                    { start: point(44, start.y), end: point(56, start.y) },
                    { start: point(56, 100), end: point(44, 100) },
                    { start: point(44, 200), end: point(56, 200) }
                ];
                if (reversed) spans.reverse().forEach(span => { [span.start, span.end] = [span.end, span.start]; });
                const beforeDisplay = structuredClone(routes);
                const result = createLinkDisplayMap(routes, mode);
                if (mode === 'gap') {
                    assertGaps(result.get(2).pathData, expected[0], expected.at(-1), spans);
                } else {
                    const curves = assertContinuous(result.get(2).pathData, expected[0], expected.at(-1));
                    assert.equal(curves.length, 3);
                    curves.forEach((curve, index) => {
                        assertPoint(curve.start, spans[index].start);
                        assertPoint(curve.end, spans[index].end);
                    });
                }
                assert.equal(result.get(1).pathData, 'M 50 -100 L 50 400');
                assert.deepEqual(createLinkDisplayMap(new Map([...routes].reverse()), mode), result);
                assert.deepEqual(routes, beforeDisplay);
                assert.deepEqual({ links, placements }, snapshot, '描画の正規化を保存データへ反映しない');
            }
        }
    });
}

test('manualの500/501件境界でもbridgeとgapは同じ交差を表し、密集時だけ候補を制限する', () => {
    const placement = (id, x, y) => ({ id, device_id: id, x: x - 5, y: y - 5, width: 10, height: 10 });
    const links = [], placements = [];
    const add = (id, start, end, manual = []) => {
        const from = id * 2, to = from + 1;
        placements.push(placement(from, start.x, start.y), placement(to, end.x, end.y));
        links.push({ id, from_id: from, to_id: to, route_mode: 'manual', manual_route: manual });
    };
    for (let index = 0; index < 80; index++) {
        const x = 20 + index * 20;
        add(index + 1, point(x, -50), point(x, 250));
    }
    add(10000, point(0, 0), point(2000, 300), [
        point(1700, 0), point(1700, 100), point(0, 100), point(0, 200), point(1700, 200), point(1700, 300)
    ]);
    for (let index = 0; index < 420; index++) {
        const y = 2000 + index * 20;
        add(100 + index, point(0, y), point(100, y));
    }
    const snapshot = structuredClone({ links, placements });
    for (const count of [500, 501]) {
        const routes = resolveTopologyLinkRoutes(links.slice(0, count), placements);
        const route = routes.get(10000);
        const bridge = createLinkDisplayMap(routes, 'bridge');
        const curves = assertContinuous(bridge.get(10000).pathData, route[0], route.at(-1));
        if (count === 500) assert.equal(curves.length, 240, '通常規模では3区間の全80交差を描画する');
        else assert.ok(curves.length > 0 && curves.length <= 24, '密集時は各水平区間で8交差以下');
        const gap = createLinkDisplayMap(routes, 'gap');
        assertGaps(gap.get(10000).pathData, route[0], route.at(-1), curves);
        assert.deepEqual(gap.get(10000).labelPosition, bridge.get(10000).labelPosition);
        assert.deepEqual(createLinkDisplayMap(new Map([...routes].reverse()), 'bridge'), bridge);
        assert.deepEqual(createLinkDisplayMap(new Map([...routes].reverse()), 'gap'), gap);
    }
    assert.deepEqual({ links, placements }, snapshot);
});
