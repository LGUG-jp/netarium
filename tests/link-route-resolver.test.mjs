import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveTopologyLinkRoutes } from '../public/js/canvas/link-route-resolver.js';
import { routeTopologyLinks, buildSvgPathData, calculateLinkLabelPosition } from '../public/js/canvas/link-router.js';
import { spawnSync } from 'node:child_process';

const point = (x, y) => ({ x, y });
const placements = () => [
    { device_id: 1, x: 0, y: 0, width: 96, height: 86 },
    { device_id: 2, x: 800, y: 0, width: 96, height: 86 }
];
const link = (id, extra = {}) => ({ id, from_id: 1, to_id: 2, ...extra });
const manualPoints = () => [point(200, 43), point(200, 200), point(600, 200), point(600, 43)];
const manualLink = (id) => link(id, { route_mode: 'manual', manual_route: manualPoints() });
const manualGeometry = () => [point(48, 43), ...manualPoints(), point(848, 43)];

function assertGeometry(route, start, end) {
    assert.ok(route.length >= 2);
    assert.ok(route.length - 2 <= 8);
    assert.deepEqual(route[0], start);
    assert.deepEqual(route.at(-1), end);
    for (const p of route) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
    for (let i = 1; i < route.length; i++) {
        assert.ok(route[i - 1].x === route[i].x || route[i - 1].y === route[i].y);
        assert.notDeepEqual(route[i - 1], route[i]);
    }
}

function freezeInput(value) {
    if (value && typeof value === 'object') {
        for (const child of Object.values(value)) freezeInput(child);
        Object.freeze(value);
    }
    return value;
}

test('旧autoと明示autoの経路を変えず、描画側へ同じ座標を渡す', () => {
    const ps = placements();
    const legacy = [link(1)];
    const expected = new Map([[1, [point(48, 43), point(848, 43)]]]);
    assert.deepEqual(resolveTopologyLinkRoutes(legacy, ps), expected);
    assert.deepEqual(resolveTopologyLinkRoutes([link(1, { route_mode: 'auto', manual_route: [] })], ps), expected);
    const many = Array.from({ length: 8 }, (_, index) => link(index + 1));
    assert.deepEqual(resolveTopologyLinkRoutes(many, ps), routeTopologyLinks(many, ps));
});

test('mixed描画は保存した手動幹線を保ち、自動リンクも同じMapへ統合する', () => {
    const ps = placements();
    const links = [manualLink(1), link(2), link(3, { route_mode: 'auto', manual_route: [] })];
    const routes = resolveTopologyLinkRoutes(links, ps);
    assert.deepEqual([...routes.keys()], [1, 2, 3]);
    assert.deepEqual(routes.get(1), manualGeometry());
    assert.equal(buildSvgPathData(routes.get(1)), 'M 48 43 L 200 43 L 200 200 L 600 200 L 600 43 L 848 43');
    assert.deepEqual(calculateLinkLabelPosition(routes.get(1)), { x: 448, y: 192, orientation: 'horizontal' });
    for (const route of routes.values()) assertGeometry(route, point(48, 43), point(848, 43));
});

test('ID順で確定したmanualを後続autoが避け、入力順には依存しない', () => {
    const ps = placements();
    const links = [link(3), link(1, { route_mode: 'manual', manual_route: [] }), link(2)];
    const routes = resolveTopologyLinkRoutes(links, ps);
    const automatic = routeTopologyLinks(links, ps);
    assert.deepEqual(routes.get(1), [point(48, 43), point(848, 43)]);
    assert.deepEqual(routes, automatic);
    assert.notDeepEqual(routes.get(2), routes.get(1));
    // 2本目の自動経路の長い水平区間は手動幹線と重ならない。
    const longHorizontal = routes.get(2).slice(1).filter((p, index) =>
        p.y === routes.get(2)[index].y && Math.abs(p.x - routes.get(2)[index].x) > 400);
    assert.ok(longHorizontal.length > 0);
    assert.ok(longHorizontal.every(p => p.y !== 43));
    const reversed = resolveTopologyLinkRoutes([...links].reverse(), [...ps].reverse());
    assert.deepEqual(reversed, routes);
    assert.deepEqual([...reversed.keys()], [1, 2, 3]);
});

test('後から確定するmanualは先行autoを再計算せず、その経路を優先する', () => {
    const ps = placements();
    const links = [link(2, { route_mode: 'manual', manual_route: [] }), link(1)];
    const routes = resolveTopologyLinkRoutes(links, ps);
    assert.deepEqual(routes.get(1), [point(48, 43), point(848, 43)]);
    assert.deepEqual(routes.get(2), routes.get(1));
    assert.deepEqual([...routes.keys()], [1, 2]);
});

test('manualからautoへ戻すと保存中間点に依存せず既存autoへ戻る', () => {
    const ps = placements();
    const links = [manualLink(1), link(2)];
    const before = resolveTopologyLinkRoutes(links, ps);
    const automatic = links.map(item => ({ ...item, route_mode: 'auto', manual_route: [] }));
    const after = resolveTopologyLinkRoutes(automatic, ps);
    assert.notDeepEqual(after.get(1), before.get(1));
    assert.deepEqual(after, routeTopologyLinks(automatic, ps));
    assert.deepEqual(links[0].manual_route, manualPoints());
});

test('機器移動でmanualの接続端だけが追従し、内部幹線と保存座標は変わらない', () => {
    const links = freezeInput([manualLink(1)]);
    const original = structuredClone(links);
    const before = resolveTopologyLinkRoutes(links, placements());
    const moved = freezeInput([
        { device_id: 1, x: 120, y: 80, width: 96, height: 86 },
        { device_id: 2, x: 960, y: 120, width: 96, height: 86 }
    ]);
    const after = resolveTopologyLinkRoutes(links, moved);
    const expected = [point(168, 123), point(200, 123), point(200, 200), point(600, 200), point(600, 163), point(1008, 163)];
    assert.deepEqual(before.get(1), manualGeometry());
    assert.deepEqual(after.get(1), expected);
    assertGeometry(after.get(1), point(168, 123), point(1008, 163));
    assert.deepEqual(links, original);
    assert.deepEqual(resolveTopologyLinkRoutes(links, placements()), before);
});

test('大型カードを横切るmanualは保存幹線を保持し、端点追従後のauto切替だけが迂回する', () => {
    // スクリーンショットの再現ではなく、R1/R2/L2/L3・3接続の合成fixture。
    const ps = [
        ...placements(),
        { device_id: 3, x: 330, y: -200, width: 200, height: 500 },
        { device_id: 4, x: 0, y: 800, width: 96, height: 86 }
    ];
    const links = freezeInput([
        manualLink(1),
        { id: 2, from_id: 3, to_id: 2 },
        { id: 3, from_id: 1, to_id: 4 }
    ]);
    const snapshot = structuredClone(links);
    const before = resolveTopologyLinkRoutes(links, ps);
    assert.deepEqual(before.get(1), manualGeometry());
    assert.deepEqual(resolveTopologyLinkRoutes([...links].reverse(), [...ps].reverse()), before);
    assert.deepEqual(resolveTopologyLinkRoutes(
        JSON.parse(JSON.stringify(links)), JSON.parse(JSON.stringify(ps))), before);

    const moved = ps.map(p => {
        if (p.device_id === 1) return { ...p, x: 120, y: 80 };
        if (p.device_id === 2) return { ...p, x: 960, y: 120 };
        return { ...p };
    });
    const after = resolveTopologyLinkRoutes(links, moved);
    const expected = [
        point(168, 123), point(200, 123), point(200, 200),
        point(600, 200), point(600, 163), point(1008, 163)
    ];
    assert.deepEqual(after.get(1), expected);
    assertGeometry(after.get(1), point(168, 123), point(1008, 163));
    assert.deepEqual(links, snapshot);

    // 保存点を残したままautoへ切り替えても、manualの幹線は参照しない。
    const automatic = links.map(item => ({ ...item, route_mode: 'auto' }));
    const switched = resolveTopologyLinkRoutes(automatic, moved);
    assert.deepEqual(switched, routeTopologyLinks(automatic, moved));
    assert.notDeepEqual(switched.get(1), after.get(1));
    assert.deepEqual(switched.get(1)[0], point(168, 123));
    assert.deepEqual(switched.get(1).at(-1), point(1008, 163));
    const card = moved.find(p => p.device_id === 3);
    const crossesCard = route => route.slice(1).some((b, index) => {
        const a = route[index];
        if (a.y === b.y) {
            return a.y > card.y - 10 && a.y < card.y + card.height + 10 &&
                Math.max(a.x, b.x) > card.x - 10 && Math.min(a.x, b.x) < card.x + card.width + 10;
        }
        assert.equal(a.x, b.x);
        return a.x > card.x - 10 && a.x < card.x + card.width + 10 &&
            Math.max(a.y, b.y) > card.y - 10 && Math.min(a.y, b.y) < card.y + card.height + 10;
    });
    assert.equal(crossesCard(after.get(1)), true);
    assert.equal(crossesCard(switched.get(1)), false);
    assert.deepEqual(resolveTopologyLinkRoutes(
        [...automatic].reverse(), [...moved].reverse()), switched);
    assert.deepEqual(resolveTopologyLinkRoutes(automatic, moved), switched);
    assert.deepEqual(links, snapshot);
});

test('空と1点のmanualも機器中心から直交接続する', () => {
    const ps = [{ device_id: 1, x: 0, y: 0, width: 96, height: 86 }, { device_id: 2, x: 800, y: 200, width: 96, height: 86 }];
    const links = [
        link(1, { route_mode: 'manual', manual_route: [] }),
        link(2, { route_mode: 'manual', manual_route: [point(200, 300)] })
    ];
    const routes = resolveTopologyLinkRoutes(links, ps);
    assert.deepEqual(routes.get(1), [point(48, 43), point(848, 43), point(848, 243)]);
    assert.deepEqual(routes.get(2), [point(48, 43), point(200, 43), point(200, 300), point(200, 243), point(848, 243)]);
    for (const route of routes.values()) assertGeometry(route, point(48, 43), point(848, 243));
});

test('不正manualだけがautoへフォールバックし、正常manualは変更しない', () => {
    const ps = placements();
    const invalidRoutes = [
        undefined, null, '[]', {},
        [point(10, 10), point(20, 20)],
        [point(NaN, 0)], [point(Infinity, 0)], [point('10', 0)],
        [{ x: 10 }], [{ x: 10, y: 20, z: 30 }],
        Array.from({ length: 9 }, (_, i) => point(i, 0))
    ];
    for (const invalid of invalidRoutes) {
        const links = [manualLink(1), link(2, { route_mode: 'manual', manual_route: invalid }), link(3)];
        const snapshot = structuredClone(links);
        const routes = resolveTopologyLinkRoutes(links, ps);
        const expected = routeTopologyLinks(links, ps, new Map([[1, manualGeometry()]]));
        assert.deepEqual(routes, expected);
        assert.deepEqual(routes.get(1), manualGeometry());
        for (const route of routes.values()) assertGeometry(route, point(48, 43), point(848, 43));
        assert.deepEqual(links, snapshot);
    }
});

test('配置が存在しないリンクはmanual/autoとも除外する', () => {
    const ps = placements();
    const links = [
        manualLink(1), link(2, { to_id: 99 }), manualLink(3),
        link(4, { from_id: 99, route_mode: 'manual', manual_route: null }),
        null, { id: 5, route_mode: 'manual', manual_route: [] }
    ];
    links[2].to_id = 99;
    const routes = resolveTopologyLinkRoutes(links, ps);
    assert.deepEqual([...routes.keys()], [1]);
    assert.deepEqual(routes.get(1), manualGeometry());
    for (const [invalidLinks, invalidPlacements] of [[null, ps], [links, null], [[], ps], [links, []]]) {
        assert.deepEqual([...resolveTopologyLinkRoutes(invalidLinks, invalidPlacements)], []);
    }
});

test('501件のdenseでもmanualを優先し、全autoの従来laneと接続順を保つ', () => {
    const ps = freezeInput(placements());
    const automatic = Array.from({ length: 501 }, (_, index) => link(index + 1));
    const baseline = routeTopologyLinks(automatic, ps);
    const links = freezeInput(automatic.map(item => [1, 2, 501].includes(item.id) ? manualLink(item.id) : item));
    const snapshot = structuredClone(links);
    const routes = resolveTopologyLinkRoutes(links, ps);
    assert.equal(routes.size, 501);
    assert.deepEqual([...routes.keys()], automatic.map(item => item.id));
    for (const item of links) {
        if (item.route_mode === 'manual') assert.deepEqual(routes.get(item.id), manualGeometry());
        else assert.deepEqual(routes.get(item.id), baseline.get(item.id));
        assertGeometry(routes.get(item.id), point(48, 43), point(848, 43));
    }
    assert.notDeepEqual(routes.get(3), routes.get(4));
    assert.deepEqual(resolveTopologyLinkRoutes([...links].reverse(), [...ps].reverse()), routes);
    assert.deepEqual(links, snapshot);
});

test('密集30配置・501接続でも8点manualの多段幹線を保持し、移動後は接続端だけ追従する', () => {
    const ps = freezeInput(Array.from({ length: 30 }, (_, i) => ({
        device_id: i + 1, x: (i % 6) * 58, y: Math.floor(i / 6) * 58, width: 96, height: 86
    })));
    const trunk = [
        point(200, 43), point(200, -120), point(500, -120), point(500, 120),
        point(700, 120), point(700, 400), point(900, 400), point(900, 275)
    ];
    const links = freezeInput(Array.from({ length: 501 }, (_, i) => ({
        id: i + 1, from_id: i === 0 ? 1 : (i % 29) + 1,
        to_id: i === 0 ? 30 : ((i + 7) % 29) + 1,
        ...(i === 0 ? { route_mode: 'manual', manual_route: trunk } : {})
    })));
    const snapshot = structuredClone({ ps, links });
    const assertAll = (routes, positions) => {
        assert.equal(routes.size, 501);
        assert.deepEqual([...routes.keys()], links.map(item => item.id));
        const centers = new Map(positions.map(p => [p.device_id, point(p.x + 48, p.y + 43)]));
        for (const item of links) assertGeometry(routes.get(item.id), centers.get(item.from_id), centers.get(item.to_id));
    };
    const routes = resolveTopologyLinkRoutes(links, ps);
    assertAll(routes, ps);
    assert.deepEqual(routes.get(1), [point(48, 43), ...trunk, point(338, 275)]);
    assert.deepEqual(resolveTopologyLinkRoutes([...links].reverse(), [...ps].reverse()), routes);
    const moved = freezeInput(ps.map(p => p.device_id === 1 ? { ...p, x: -80, y: 150 } :
        p.device_id === 30 ? { ...p, x: 500, y: 500 } : p));
    const after = resolveTopologyLinkRoutes(links, moved);
    assertAll(after, moved);
    assert.deepEqual(after.get(1), [
        point(-32, 193), point(200, 193), ...trunk.slice(1, -1), point(900, 543), point(548, 543)
    ]);
    assert.deepEqual(resolveTopologyLinkRoutes([...links].reverse(), [...moved].reverse()), after);
    assert.deepEqual(resolveTopologyLinkRoutes(links, ps), routes);
    assert.deepEqual({ ps, links }, snapshot);
    // 密集配置の端点重なりと探索上限による残余衝突は仕様上許容する。
});

test('fixedRoutesと配置・リンク入力を変更しない', () => {
    const ps = freezeInput(placements());
    const links = freezeInput([manualLink(1), link(2)]);
    const fixedRoute = freezeInput(manualGeometry());
    const fixedRoutes = new Map([[1, fixedRoute], [99, [point(0, 0), point(1, 0)]]]);
    const snapshot = structuredClone({ ps, links, fixedRoutes });
    const routes = routeTopologyLinks(links, ps, fixedRoutes);
    assert.deepEqual([...routes.keys()], [1, 2]);
    assert.deepEqual({ ps, links, fixedRoutes }, snapshot);
    const resolved = resolveTopologyLinkRoutes(links, ps);
    assert.deepEqual(resolved, routes);
    resolved.get(1)[2].y = -999;
    assert.deepEqual(links, snapshot.links);
});

test('安全整数を超えるセル座標でもmanualとautoの索引走査が停止せず端点を保つ', () => {
    const resolverUrl = new URL('../public/js/canvas/link-route-resolver.js', import.meta.url).href;
    // 同期ループの再発でもスイート全体を止めないよう、監視付きの子プロセスで実行する。
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', `
        import { resolveTopologyLinkRoutes } from ${JSON.stringify(resolverUrl)};
        const placements = [
            { device_id: 1, x: 0, y: 0, width: 20, height: 20 },
            { device_id: 2, x: 100, y: 100, width: 20, height: 20 },
            { device_id: 3, x: 1e20, y: 0, width: 20, height: 20 },
            { device_id: 4, x: 1e20, y: 100, width: 20, height: 20 }
        ];
        const links = [
            { id: 1, from_id: 1, to_id: 2, route_mode: 'manual',
                manual_route: [{ x: 1e20, y: 10 }, { x: 1e20, y: 110 }] },
            { id: 2, from_id: 3, to_id: 4 }
        ];
        console.log(JSON.stringify([...resolveTopologyLinkRoutes(links, placements)]));
    `], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [
        [1, [point(10, 10), point(1e20, 10), point(1e20, 110), point(110, 110)]],
        [2, [point(1e20, 10), point(1e20, 110)]]
    ]);
});
