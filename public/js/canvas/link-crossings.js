import {
    buildSvgPathData,
    calculateLinkLabelPosition
} from './link-router.js';

const EPSILON = 0.000001;
const CROSSING_RADIUS = 6;
const END_MARGIN = 8;
const LARGE_MAP_THRESHOLD = 500;
const LARGE_MAP_CANDIDATES = 8;
const LARGE_MAP_INDEX_VISITS = 32;
const LARGE_MAP_SPANS = 64;

function measureRoute(id, route) {
    if (!Array.isArray(route) || route.length < 2) return null;
    const points = route.map(point => ({ x: Number(point?.x), y: Number(point?.y) }));
    if (points.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y))) return null;
    const segments = [];
    let length = 0;
    for (let i = 1; i < points.length; i++) {
        const a = points[i - 1];
        const b = points[i];
        const size = Math.hypot(b.x - a.x, b.y - a.y);
        if (size < EPSILON) continue;
        segments.push({
            id, a, b, length: size, offset: length, index: segments.length,
            minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x),
            minY: Math.min(a.y, b.y), maxY: Math.max(a.y, b.y)
        });
        length += size;
    }
    return { id, points, segments, length, crossingSpans: [] };
}

// 平衡な境界ボックス木で、長い斜線を細かなセルへ展開せずに探索する。
function buildIndex(segments) {
    if (!segments.length) return null;
    const node = {
        minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity,
        minId: Infinity
    };
    for (const segment of segments) {
        node.minId = Math.min(node.minId, segment.id);
        node.minX = Math.min(node.minX, segment.minX);
        node.minY = Math.min(node.minY, segment.minY);
        node.maxX = Math.max(node.maxX, segment.maxX);
        node.maxY = Math.max(node.maxY, segment.maxY);
    }
    if (segments.length <= 8) {
        node.segments = segments;
        return node;
    }
    if (node.maxX - node.minX >= node.maxY - node.minY) {
        segments.sort((a, b) => (a.minX + a.maxX) - (b.minX + b.maxX) ||
            a.id - b.id || a.offset - b.offset);
    } else {
        segments.sort((a, b) => (a.minY + a.maxY) - (b.minY + b.maxY) ||
            a.id - b.id || a.offset - b.offset);
    }
    const middle = Math.floor(segments.length / 2);
    node.left = buildIndex(segments.slice(0, middle));
    node.right = buildIndex(segments.slice(middle));
    return node;
}

function overlaps(a, b) {
    return a.minX <= b.maxX + EPSILON && a.maxX + EPSILON >= b.minX &&
        a.minY <= b.maxY + EPSILON && a.maxY + EPSILON >= b.minY;
}

function visitCandidates(node, segment, budget, visit) {
    if (!node || budget.candidates <= 0 || budget.nodes <= 0 ||
        node.minId >= segment.id || !overlaps(node, segment)) return;
    budget.nodes--;
    if (node.segments) {
        for (const other of node.segments) {
            if (other.id >= segment.id || !overlaps(segment, other)) continue;
            visit(other);
            if (--budget.candidates <= 0) break;
        }
        return;
    }
    visitCandidates(node.left, segment, budget, visit);
    visitCandidates(node.right, segment, budget, visit);
}

function crossing(a, b) {
    const ax = a.b.x - a.a.x;
    const ay = a.b.y - a.a.y;
    const bx = b.b.x - b.a.x;
    const by = b.b.y - b.a.y;
    const denominator = ax * by - ay * bx;
    // 同一直線や共有区間は独立した交差として扱わない。
    if (Math.abs(denominator) <= EPSILON * a.length * b.length) return null;
    const dx = b.a.x - a.a.x;
    const dy = b.a.y - a.a.y;
    const t = (dx * by - dy * bx) / denominator;
    const u = (dx * ay - dy * ax) / denominator;
    if (t < -EPSILON || t > 1 + EPSILON || u < -EPSILON || u > 1 + EPSILON) return null;
    return {
        distance: a.offset + Math.max(0, Math.min(1, t)) * a.length,
        otherDistance: b.offset + Math.max(0, Math.min(1, u)) * b.length
    };
}

function sharesSectionAtCrossing(route, segment, otherRoute, other, hit) {
    // 折れ点では、共有幹線の終端で非平行な区間が交わる場合がある。
    // 経路全体ではなく、同じ経路距離に接する隣接区間だけを調べる。
    for (let i = Math.max(0, segment.index - 1);
        i <= Math.min(route.segments.length - 1, segment.index + 1); i++) {
        const a = route.segments[i];
        if (hit.distance < a.offset - EPSILON ||
            hit.distance > a.offset + a.length + EPSILON) continue;
        const ax = (a.b.x - a.a.x) / a.length;
        const ay = (a.b.y - a.a.y) / a.length;
        for (let j = Math.max(0, other.index - 1);
            j <= Math.min(otherRoute.segments.length - 1, other.index + 1); j++) {
            const b = otherRoute.segments[j];
            if (hit.otherDistance < b.offset - EPSILON ||
                hit.otherDistance > b.offset + b.length + EPSILON) continue;
            const bx = b.b.x - b.a.x;
            const by = b.b.y - b.a.y;
            if (Math.abs(ax * by - ay * bx) > EPSILON * b.length ||
                Math.abs(ax * (b.a.y - a.a.y) - ay * (b.a.x - a.a.x)) > EPSILON) continue;
            const from = ax * (b.a.x - a.a.x) + ay * (b.a.y - a.a.y);
            const to = ax * (b.b.x - a.a.x) + ay * (b.b.y - a.a.y);
            if (Math.min(a.length, Math.max(from, to)) -
                Math.max(0, Math.min(from, to)) > EPSILON) return true;
        }
    }
    return false;
}

function mergeCrossingSpans(spans) {
    const merged = [];
    spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    for (const span of spans) {
        const previous = merged[merged.length - 1];
        if (previous && span[0] <= previous[1] + EPSILON) {
            previous[1] = Math.max(previous[1], span[1]);
        } else {
            merged.push([...span]);
        }
    }
    return merged;
}

function pointOnSegment(segment, distance) {
    const t = (distance - segment.offset) / segment.length;
    return {
        x: segment.a.x + (segment.b.x - segment.a.x) * t,
        y: segment.a.y + (segment.b.y - segment.a.y) * t
    };
}

function visiblePath(route, mode) {
    if (!route.crossingSpans.length) return buildSvgPathData(route.points);
    const first = route.points[0];
    const commands = [`M ${first.x} ${first.y}`];
    let segmentIndex = 0;
    const appendStraightUntil = distance => {
        while (segmentIndex < route.segments.length) {
            const segment = route.segments[segmentIndex];
            const end = segment.offset + segment.length;
            const point = pointOnSegment(segment, Math.min(distance, end));
            commands.push(`L ${point.x} ${point.y}`);
            if (end >= distance - EPSILON) return point;
            segmentIndex++;
        }
        return route.points[route.points.length - 1];
    };
    for (const [from, to] of route.crossingSpans) {
        const start = appendStraightUntil(from);
        let endIndex = segmentIndex;
        while (route.segments[endIndex].offset + route.segments[endIndex].length < to - EPSILON) {
            endIndex++;
        }
        const end = pointOnSegment(route.segments[endIndex], to);
        if (mode === 'gap') {
            // 折れ点を含む区間も、終点への移動で実際に描画を切る。
            commands.push(`M ${end.x} ${end.y}`);
            segmentIndex = endIndex;
            continue;
        }
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const chord = Math.hypot(dx, dy);
        if (chord < EPSILON) {
            appendStraightUntil(to);
            continue;
        }
        // 逆向きの配線でも、水平は上・垂直は右へ同じ山を描く。
        let nx = dy / chord;
        let ny = -dx / chord;
        if (ny > EPSILON || (Math.abs(ny) <= EPSILON && nx < 0)) {
            nx = -nx;
            ny = -ny;
        }
        const height = Math.min(CROSSING_RADIUS, (to - from) / 2);
        const cx = (start.x + end.x) / 2 + nx * height * 2;
        const cy = (start.y + end.y) / 2 + ny * height * 2;
        commands.push(`Q ${cx} ${cy} ${end.x} ${end.y}`);
        segmentIndex = endIndex;
    }
    appendStraightUntil(route.length);
    return commands.join(' ');
}

function labelPosition(route) {
    const original = calculateLinkLabelPosition(route.points);
    const midpoint = route.length / 2;
    const clearance = 10;
    const blocks = mergeCrossingSpans(route.crossingSpans.map(([from, to]) => [from - clearance, to + clearance]));
    const block = blocks.find(([from, to]) => midpoint > from && midpoint < to);
    if (!original || !block) return original;
    const candidates = [block[0], block[1]]
        .filter(distance => distance >= END_MARGIN && distance <= route.length - END_MARGIN &&
            Math.abs(distance - midpoint) <= 40)
        .sort((a, b) => Math.abs(a - midpoint) - Math.abs(b - midpoint) || a - b);
    if (!candidates.length) return original;
    const distance = candidates[0];
    const segment = route.segments.find(part => distance <= part.offset + part.length + EPSILON);
    if (!segment) return original;
    const point = pointOnSegment(segment, distance);
    const dx = (segment.b.x - segment.a.x) / segment.length;
    const dy = (segment.b.y - segment.a.y) / segment.length;
    return calculateLinkLabelPosition([
        { x: point.x - dx, y: point.y - dy },
        { x: point.x + dx, y: point.y + dy }
    ]);
}

// 交差区間を一度だけ探索し、表示方式に依存しない経路距離で保存する。
function collectCrossingSpans(routes) {
    const segments = [...routes.values()].flatMap(route => route.segments);
    const index = buildIndex(segments);
    const large = routes.size > LARGE_MAP_THRESHOLD;
    for (const route of routes.values()) {
        const budget = { candidates: Infinity, nodes: Infinity };
        for (const segment of route.segments) {
            if (large && route.crossingSpans.length >= LARGE_MAP_SPANS) break;
            budget.candidates = large ? LARGE_MAP_CANDIDATES : Infinity;
            budget.nodes = large ? LARGE_MAP_INDEX_VISITS : Infinity;
            visitCandidates(index, segment, budget, other => {
                if (large && route.crossingSpans.length >= LARGE_MAP_SPANS) return;
                const hit = crossing(segment, other);
                if (!hit) return;
                const otherRoute = routes.get(other.id);
                // 経路端点で別の経路に接する場合は、交差ではなく接続とみなす。
                if (hit.otherDistance <= EPSILON ||
                    hit.otherDistance >= otherRoute.length - EPSILON) return;
                const radius = Math.min(CROSSING_RADIUS, segment.length / 4, other.length / 4);
                if (radius < 2 || hit.distance - radius < END_MARGIN ||
                    hit.distance + radius > route.length - END_MARGIN) return;
                const nearBend = Math.abs(hit.distance - segment.offset) <= EPSILON ||
                    Math.abs(hit.distance - segment.offset - segment.length) <= EPSILON ||
                    Math.abs(hit.otherDistance - other.offset) <= EPSILON ||
                    Math.abs(hit.otherDistance - other.offset - other.length) <= EPSILON;
                if (nearBend && sharesSectionAtCrossing(route, segment, otherRoute, other, hit)) return;
                route.crossingSpans.push([hit.distance - radius, hit.distance + radius]);
            });
        }
        route.crossingSpans = mergeCrossingSpans(route.crossingSpans);
    }
}

/**
 * 表示用の幾何形状。低ID側は元の線、高ID側はbridgeなら山、gapなら切れ目で交差する。
 * 元の経路とクリック判定用の完全経路は変更しない。
 * 500経路超では区間あたり候補8件・一致する検索ノード32件までとし、
 * 経路あたりの交差候補を64件に制限する。
 */
export function createLinkDisplayMap(routeMap, mode = 'bridge') {
    const routes = new Map();
    for (const [id, route] of [...routeMap].sort((a, b) => Number(a[0]) - Number(b[0]))) {
        const numericId = Number(id);
        if (!Number.isFinite(numericId)) continue;
        const measured = measureRoute(numericId, route);
        if (measured) routes.set(numericId, measured);
    }
    collectCrossingSpans(routes);
    const displayMap = new Map();
    for (const route of routes.values()) {
        displayMap.set(route.id, {
            pathData: visiblePath(route, mode),
            labelPosition: labelPosition(route)
        });
    }
    return displayMap;
}
