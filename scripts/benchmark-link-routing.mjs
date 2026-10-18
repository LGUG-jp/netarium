import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { resolveTopologyLinkRoutes } from '../public/js/canvas/link-route-resolver.js';
import { createLinkDisplayMap } from '../public/js/canvas/link-crossings.js';

// node scripts/benchmark-link-routing.mjs
// DOM描画を介さず、経路一括計算と交差ブリッジ・ラベル位置の計算を計測する。
function scenario(spacing, placementCount = 2000, linkCount = 5000, columns = 50) {
    const placements = Array.from({ length: placementCount }, (_, i) => ({
        device_id: i + 1,
        x: (i % columns) * spacing,
        y: Math.floor(i / columns) * spacing
    }));
    let seed = 271828;
    const random = () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed;
    };
    const links = Array.from({ length: linkCount }, (_, i) => {
        const from_id = random() % placements.length + 1;
        let to_id = random() % placements.length + 1;
        if (from_id === to_id) to_id = to_id % placements.length + 1;
        return { id: i + 1, from_id, to_id };
    });
    return { placements, links };
}

for (const [name, spacing, placementCount, linkCount, columns] of [
    ['推奨', 220, 100, 200, 10],
    ['境界・500', 220, 100, 500, 10],
    ['境界・501', 220, 100, 501, 10],
    ['上限・疎', 220, 2000, 5000, 50],
    ['上限・密', 72, 2000, 5000, 50]
]) {
    const { links, placements } = scenario(spacing, placementCount, linkCount, columns);
    const durations = [];
    const displayDurations = [];
    let baseline;
    for (let iteration = 0; iteration < 6; iteration++) {
        const start = performance.now();
        const routes = resolveTopologyLinkRoutes(links, placements);
        const routeEnd = performance.now();
        const display = createLinkDisplayMap(routes);
        const displayEnd = performance.now();
        if (iteration > 0) {
            durations.push(routeEnd - start);
            displayDurations.push(displayEnd - routeEnd);
        }
        if (display.size !== routes.size) throw new Error(`${name}: 表示経路数が一致しません`);
        if (routes.size !== links.length) throw new Error(`${name}: 経路数が一致しません`);
        for (const route of routes.values()) {
            assert.ok(route.length >= 2, `${name}: 経路点が不足しています`);
            for (const point of route) {
                assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y),
                    `${name}: 有限でない経路座標です`);
            }
        }
        if (baseline) assert.deepEqual(routes, baseline, `${name}: 反復計算で経路が変化しました`);
        else baseline = routes;
    }
    assert.deepEqual(
        resolveTopologyLinkRoutes([...links].reverse(), [...placements].reverse()),
        baseline, `${name}: 入力順で経路が変化しました`);
    const ordered = [...durations].sort((a, b) => a - b);
    console.log(`${name} ${placementCount}配置/${linkCount}リンク: 中央値 ${ordered[2].toFixed(1)} ms / 最大 ${ordered[4].toFixed(1)} ms (${durations.map(ms => ms.toFixed(1)).join(', ')})`);
    const displayOrdered = [...displayDurations].sort((a, b) => a - b);
    console.log(`  交差ブリッジ・ラベル: 中央値 ${displayOrdered[2].toFixed(1)} ms / 最大 ${displayOrdered[4].toFixed(1)} ms`);
}
