import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    DEFAULT_DEVICE_HEIGHT,
    DEFAULT_DEVICE_OBSTACLE_HEIGHT,
    DEFAULT_DEVICE_WIDTH
} from '../public/js/core/constants.js';
import {
    routeTopologyLinks,
    simplifyCollinearPoints
} from '../public/js/canvas/link-router.js';

function center(placement) {
    return {
        x: placement.x + (placement.width || DEFAULT_DEVICE_WIDTH) / 2,
        y: placement.y + (placement.height || DEFAULT_DEVICE_HEIGHT) / 2
    };
}

function segments(route) {
    return route.slice(1).map((b, index) => {
        const a = route[index];
        return {
            a, b,
            horizontal: a.y === b.y,
            vertical: a.x === b.x,
            left: Math.min(a.x, b.x), right: Math.max(a.x, b.x),
            top: Math.min(a.y, b.y), bottom: Math.max(a.y, b.y)
        };
    });
}

// 表示上の区間だけを測る。矩形境界で区切り、中点が機器に隠れる区間を除外する。
// 経路選択スコアや候補生成はテスト側で再実装しない。
function visibleIntervals(segment, placements) {
    if (!segment.horizontal && !segment.vertical) return [];
    const horizontal = segment.horizontal;
    const low = horizontal ? segment.left : segment.top;
    const high = horizontal ? segment.right : segment.bottom;
    const boxes = placements.map(p => ({
        left: p.x, right: p.x + (p.width || DEFAULT_DEVICE_WIDTH),
        top: p.y, bottom: p.y + (p.height || DEFAULT_DEVICE_HEIGHT)
    }));
    const cuts = [...new Set([
        low, high,
        ...boxes.flatMap(box => horizontal ? [box.left, box.right] : [box.top, box.bottom])
            .filter(value => value > low && value < high)
    ])].sort((a, b) => a - b);
    const intervals = [];
    for (let i = 1; i < cuts.length; i++) {
        const middle = (cuts[i - 1] + cuts[i]) / 2;
        const x = horizontal ? middle : segment.a.x;
        const y = horizontal ? segment.a.y : middle;
        if (!boxes.some(box => x >= box.left && x <= box.right && y >= box.top && y <= box.bottom)) {
            intervals.push([cuts[i - 1], cuts[i]]);
        }
    }
    return intervals;
}

function parallelConflicts(routes, placements, maximumGap = 0.001) {
    const entries = [...routes].map(([id, route]) => ({
        id, segments: segments(route).map(segment => ({
            ...segment, visible: visibleIntervals(segment, placements)
        }))
    }));
    const conflicts = [];
    for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
            for (const a of entries[i].segments) {
                for (const b of entries[j].segments) {
                    if (!((a.horizontal && b.horizontal) || (a.vertical && b.vertical))) continue;
                    const gap = Math.abs(a.horizontal ? a.a.y - b.a.y : a.a.x - b.a.x);
                    if (gap >= maximumGap) continue;
                    for (const [aLow, aHigh] of a.visible) {
                        for (const [bLow, bHigh] of b.visible) {
                            const length = Math.min(aHigh, bHigh) - Math.max(aLow, bLow);
                            if (length > 0.001) conflicts.push({ ids: [entries[i].id, entries[j].id], gap, length });
                        }
                    }
                }
            }
        }
    }
    return conflicts;
}

function assertRouteGeometry(routes, links, placements) {
    const byDevice = new Map(placements.map(p => [p.device_id, p]));
    assert.equal(routes.size, links.length);
    for (const link of links) {
        const route = routes.get(link.id);
        assert.ok(route.length >= 2);
        assert.deepEqual(route[0], center(byDevice.get(link.from_id)));
        assert.deepEqual(route.at(-1), center(byDevice.get(link.to_id)));
        for (const point of route) {
            assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
        }
        for (const segment of segments(route)) {
            assert.ok(segment.horizontal || segment.vertical);
            assert.notDeepEqual(segment.a, segment.b);
        }
    }
}

// 元画像の座標・実寸・auto/manualは不明なため、4台3接続の合成fixture。
// L2はR1-R2の端点ではなく、その大きなカードが従来の横断候補を塞ぐ。
function blockedCardFixture({ vertical = false, reversed = false, multiple = false } = {}) {
    const placements = [
        { device_id: 1, name: 'R1', x: 0, y: 200, width: 108, height: 86 },
        { device_id: 2, name: 'R2', x: 800, y: 200, width: 108, height: 86 },
        { device_id: 3, name: 'L2', x: 330, y: -7, width: 200, height: 500 },
        { device_id: 4, name: 'L3', x: 0, y: 800, width: 108, height: 86 }
    ];
    if (multiple) placements.push({ device_id: 5, x: 580, y: 100, width: 100, height: 340 });
    if (vertical) {
        for (const p of placements) {
            [p.x, p.y] = [p.y, p.x];
            [p.width, p.height] = [p.height, p.width];
        }
    }
    const links = [
        { id: 1, from_id: 1, to_id: 2 },
        { id: 2, from_id: 3, to_id: 2 },
        { id: 3, from_id: 1, to_id: 4 }
    ];
    if (reversed) {
        for (const link of links) [link.from_id, link.to_id] = [link.to_id, link.from_id];
    }
    return { placements, links };
}

// 経路候補・ルータの交差関数から独立した、開いた拡張矩形との交差判定。
// 境界上はちょうど10pxのclearanceとして許可し、端点が内部の区間も検出する。
function intersectsCardClearance(route, placement, clearance = 10) {
    const left = placement.x - clearance;
    const right = placement.x + (placement.width || DEFAULT_DEVICE_WIDTH) + clearance;
    const top = placement.y - clearance;
    const bottom = placement.y + (placement.height || DEFAULT_DEVICE_OBSTACLE_HEIGHT) + clearance;
    return segments(route).some(segment => {
        if (segment.horizontal) {
            return segment.a.y > top && segment.a.y < bottom &&
                segment.right > left && segment.left < right;
        }
        assert.ok(segment.vertical);
        return segment.a.x > left && segment.a.x < right &&
            segment.bottom > top && segment.top < bottom;
    });
}

function assertCardClearance(routes, links, placements) {
    for (const link of links) {
        for (const p of placements) {
            if (p.device_id === link.from_id || p.device_id === link.to_id) continue;
            assert.equal(intersectsCardClearance(routes.get(link.id), p), false,
                `link ${link.id} crosses card ${p.device_id} clearance`);
        }
    }
}

function addBoundaryLinks(placements, links, count) {
    const initialCount = links.length;
    for (let i = 0; links.length < count; i++) {
        const from_id = 20 + i * 2;
        const to_id = from_id + 1;
        placements.push(
            { device_id: from_id, x: 3000, y: i * 220 },
            { device_id: to_id, x: 3800, y: i * 220 }
        );
        links.push({ id: initialCount + i + 1, from_id, to_id });
    }
}

for (const count of [1, 500, 501]) {
    test(`${count}件でも既定カードのIP・状態表示領域を避け、従来の中心端点を保つ`, () => {
        const placements = [
            { device_id: 1, x: 0, y: 67 },
            { device_id: 2, x: 800, y: 67 },
            { device_id: 3, x: 330, y: 0 }
        ];
        const links = [{ id: 1, from_id: 1, to_id: 2 }];
        addBoundaryLinks(placements, links, count);
        const direct = [center(placements[0]), center(placements[1])];
        assert.ok(direct[0].y > DEFAULT_DEVICE_HEIGHT &&
            direct[0].y < DEFAULT_DEVICE_OBSTACLE_HEIGHT);
        assert.equal(intersectsCardClearance(direct, placements[2]), true);
        const routes = routeTopologyLinks(links, placements);
        assertRouteGeometry(routes, links, placements);
        assertCardClearance(routes, links.slice(0, 1), placements);
        assert.deepEqual(routes.get(1)[0], { x: 54, y: 110 });
        assert.deepEqual(routes.get(1).at(-1), { x: 854, y: 110 });
        assert.deepEqual(routeTopologyLinks([...links].reverse(), [...placements].reverse()), routes);
    });
}

for (const vertical of [false, true]) {
    for (const reversed of [false, true]) {
        for (const multiple of [false, true]) {
            test(`4台3接続の${vertical ? '垂直' : '水平'}・${reversed ? '反転' : '順方向'}経路が${multiple ? '複数' : '大型'}カードを10px離れて避ける`, () => {
                const { placements, links } = blockedCardFixture({ vertical, reversed, multiple });
                const routes = routeTopologyLinks(links, placements);
                assertRouteGeometry(routes, links, placements);
                assertCardClearance(routes, links, placements);
                assert.deepEqual(routeTopologyLinks([...links].reverse(), [...placements].reverse()), routes);
                assert.deepEqual(routeTopologyLinks(links, placements), routes);
                const reloaded = JSON.parse(JSON.stringify({ placements, links }));
                assert.deepEqual(routeTopologyLinks(reloaded.links, reloaded.placements), routes);
            });
        }
    }
}

test('大型障害物の移動後も中心端点を維持して経路を再計算する', () => {
    const { placements, links } = blockedCardFixture();
    const before = routeTopologyLinks(links, placements);
    const moved = placements.map(p => p.device_id === 3 ? { ...p, y: -400, height: 1200 } : { ...p });
    const after = routeTopologyLinks(links, moved);
    assertRouteGeometry(after, links, moved);
    assertCardClearance(after, links, moved);
    assert.notDeepEqual(after.get(1), before.get(1));
    assert.deepEqual(routeTopologyLinks([...links].reverse(), [...moved].reverse()), after);
    assert.deepEqual(routeTopologyLinks(links, moved), after);
    const reloaded = JSON.parse(JSON.stringify({ placements: moved, links }));
    assert.deepEqual(routeTopologyLinks(reloaded.links, reloaded.placements), after);
});

for (const count of [500, 501]) {
    test(`${count}件境界でも4台3接続の大型カード回避と中心端点を維持する`, () => {
        const { placements, links } = blockedCardFixture();
        const fixtureLinks = [...links];
        addBoundaryLinks(placements, links, count);
        const routes = routeTopologyLinks(links, placements);
        assertRouteGeometry(routes, links, placements);
        assertCardClearance(routes, fixtureLinks, placements);
        assert.deepEqual(routeTopologyLinks([...links].reverse(), [...placements].reverse()), routes);
        assert.deepEqual(routeTopologyLinks(links, placements), routes);
    });
}

function fanoutFixture() {
    return {
        placements: [
            { device_id: 1, x: 0, y: 300 },
            ...[0, 180, 360, 540, 720].map((y, index) => ({ device_id: index + 2, x: 600, y }))
        ],
        links: Array.from({ length: 5 }, (_, index) => ({ id: index + 1, from_id: 1, to_id: index + 2 }))
    };
}

for (const transpose of [false, true]) {
    test(`L2SWと複数APの${transpose ? '縦' : '横'}配置で機器外の共通幹線を分離する`, () => {
        const { placements, links } = fanoutFixture();
        if (transpose) {
            for (const p of placements) {
                [p.x, p.y] = [p.y, p.x];
                p.width = 86;
                p.height = 96;
            }
        }
        const routes = routeTopologyLinks(links, placements);
        assertRouteGeometry(routes, links, placements);
        assert.deepEqual(parallelConflicts(routes, placements), []);
        assert.ok(parallelConflicts(routes, placements, 24).every(conflict => conflict.length < 80));
    });
}

for (const vertical of [false, true]) {
    test(`同じ2機器の8本を${vertical ? '縦' : '横'}の長い区間で24px以上離す`, () => {
        const placements = [
            { device_id: 1, x: 0, y: 0 },
            { device_id: 2, x: vertical ? 0 : 800, y: vertical ? 800 : 0 }
        ];
        const links = Array.from({ length: 8 }, (_, index) => ({ id: index + 1, from_id: 1, to_id: 2 }));
        const routes = routeTopologyLinks(links, placements);
        assertRouteGeometry(routes, links, placements);
        assert.deepEqual(parallelConflicts(routes, placements), []);
        assert.ok(parallelConflicts(routes, placements, 24).every(conflict => conflict.length < 80));
    });
}

test('異なる端点の部分共有を分離し、第三の機器内部を迂回する', () => {
    const placements = [
        { device_id: 1, x: 0, y: 0 },
        { device_id: 2, x: 600, y: 0 },
        { device_id: 3, x: 240, y: 0 },
        { device_id: 4, x: 840, y: 0 }
    ];
    const links = [{ id: 1, from_id: 1, to_id: 2 }, { id: 2, from_id: 3, to_id: 4 }];
    const routes = routeTopologyLinks(links, placements);
    assertRouteGeometry(routes, links, placements);
    assert.deepEqual(parallelConflicts(routes, placements), []);
    for (const link of links) {
        for (const segment of segments(routes.get(link.id))) {
            for (const p of placements.filter(p => p.device_id !== link.from_id && p.device_id !== link.to_id)) {
                if (segment.horizontal && segment.a.y > p.y + 2 && segment.a.y < p.y + 84) {
                    assert.ok(segment.right <= p.x + 2 || segment.left >= p.x + 94);
                }
                if (segment.vertical && segment.a.x > p.x + 2 && segment.a.x < p.x + 94) {
                    assert.ok(segment.bottom <= p.y + 2 || segment.top >= p.y + 84);
                }
            }
        }
    }
});

test('空間セル境界を挟む12px近接平行線も長い区間で分離する', () => {
    const placements = [
        { device_id: 1, x: 0, y: 176, width: 8, height: 8 },
        { device_id: 2, x: 600, y: 176, width: 8, height: 8 },
        { device_id: 3, x: 200, y: 188, width: 8, height: 8 },
        { device_id: 4, x: 800, y: 188, width: 8, height: 8 }
    ];
    const links = [{ id: 1, from_id: 1, to_id: 2 }, { id: 2, from_id: 3, to_id: 4 }];
    const routes = routeTopologyLinks(links, placements);
    assertRouteGeometry(routes, links, placements);
    assert.ok(parallelConflicts(routes, placements, 24).every(conflict => conflict.length < 80));
});

test('密集配置でも有限な直交経路、中心端点、入力順と反復の安定性を保つ', () => {
    const placements = Array.from({ length: 30 }, (_, i) => ({
        device_id: i + 1, x: (i % 6) * 58, y: Math.floor(i / 6) * 58
    }));
    const links = Array.from({ length: 65 }, (_, i) => {
        const from_id = i * 17 % 30 + 1;
        let to_id = (i * 13 + Math.floor(i / 3) + 1) % 30 + 1;
        if (from_id === to_id) to_id = to_id % 30 + 1;
        return { id: i + 1, from_id, to_id };
    });
    const actual = routeTopologyLinks(links, placements);
    assertRouteGeometry(actual, links, placements);
    assert.deepEqual(routeTopologyLinks([...links].reverse(), [...placements].reverse()), actual);
    assert.deepEqual(routeTopologyLinks(links, placements), actual);
});

test('機器移動後は全体を再計算し、端点と関連経路を更新する', () => {
    const { placements, links } = fanoutFixture();
    const before = routeTopologyLinks(links, placements);
    const moved = placements.map(p => p.device_id === 1 ? { ...p, x: 120, y: 450 } : { ...p });
    const after = routeTopologyLinks(links, moved);
    assertRouteGeometry(after, links, moved);
    for (const link of links) assert.notDeepEqual(after.get(link.id), before.get(link.id));
    assert.deepEqual(routeTopologyLinks([...links].reverse(), moved), after);
});

test('501件以上の高速経路でもAP fanoutの機器外共通幹線を分離する', () => {
    const { placements, links } = fanoutFixture();
    const extras = Array.from({ length: 496 }, (_, i) => ({ id: i + 6, from_id: 20, to_id: 21 }));
    placements.push({ device_id: 20, x: 3000, y: 0 }, { device_id: 21, x: 3800, y: 0 });
    const allLinks = [...links, ...extras];
    const routes = routeTopologyLinks(allLinks, placements);
    assertRouteGeometry(routes, allLinks, placements);
    const fanoutRoutes = new Map(links.map(link => [link.id, routes.get(link.id)]));
    assert.deepEqual(parallelConflicts(fanoutRoutes, placements), []);
    assert.ok(parallelConflicts(fanoutRoutes, placements, 24).every(conflict => conflict.length < 80));
    assert.notDeepEqual(routes.get(6), routes.get(7));
    assert.notDeepEqual(routes.get(7), routes.get(8));
    assert.deepEqual(routeTopologyLinks([...allLinks].reverse(), placements), routes);
    assert.deepEqual(routeTopologyLinks(allLinks, placements), routes);
});

test('同一直線上でも迂回の折り返し点は削除しない', () => {
    const horizontal = [{ x: 0, y: 0 }, { x: 48, y: 0 }, { x: 24, y: 0 }, { x: 72, y: 0 }];
    const vertical = horizontal.map(p => ({ x: p.y, y: p.x }));
    assert.deepEqual(simplifyCollinearPoints(horizontal), horizontal);
    assert.deepEqual(simplifyCollinearPoints(vertical), vertical);
    assert.deepEqual(simplifyCollinearPoints([{ x: 0, y: 0 }, { x: 24, y: 0 }, { x: 48, y: 0 }]),
        [{ x: 0, y: 0 }, { x: 48, y: 0 }]);
});
