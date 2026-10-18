import { normalizeLinkRouteData } from '../core/link-route-data.js';

function samePoint(a, b) {
    return a.x === b.x && a.y === b.y;
}

function isBetween(value, a, b) {
    return value >= Math.min(a, b) && value <= Math.max(a, b);
}

/** 厳密な重複と区間内の共線点だけを除き、折り返しと微小な折れを残す。 */
export function simplifyExact(points) {
    const result = [];
    for (const point of points) {
        const copy = { x: point.x, y: point.y };
        if (result.length && samePoint(result.at(-1), copy)) continue;
        while (result.length >= 2) {
            const previous = result.at(-2);
            const middle = result.at(-1);
            const redundant = (
                previous.x === middle.x && middle.x === copy.x &&
                isBetween(middle.y, previous.y, copy.y)
            ) || (
                previous.y === middle.y && middle.y === copy.y &&
                isBetween(middle.x, previous.x, copy.x)
            );
            if (!redundant) break;
            result.pop();
        }
        result.push(copy);
    }
    return result;
}

/** 保存データと同じ厳格検証を行い、入力から独立した中間点を返す。 */
export function normalizeManualRoute(points) {
    const normalized = normalizeLinkRouteData({ route_mode: 'manual', manual_route: points });
    return simplifyExact(normalized.manual_route);
}

function isFinitePoint(point) {
    return point != null && Number.isFinite(point.x) && Number.isFinite(point.y);
}

/** 斜めの端点接続だけを、隣の区間と同じ軸上へ投影する。 */
function reconnectBoundary(boundary, vertical, center) {
    if (boundary.x === center.x || boundary.y === center.y) return;
    if (vertical) {
        boundary.y = center.y;
    } else {
        boundary.x = center.x;
    }
}

/** 現在の機器中心へつなぎ直す。保存用の中間点や端点は変更しない。 */
export function buildManualLinkRoute(start, end, manualRoute) {
    const points = normalizeManualRoute(manualRoute);
    if (!isFinitePoint(start) || !isFinitePoint(end)) return null;

    if (points.length === 0) {
        return simplifyExact([start, { x: end.x, y: start.y }, end]);
    }
    if (points.length === 1) {
        const anchor = points[0];
        return simplifyExact([
            start,
            { x: anchor.x, y: start.y },
            anchor,
            { x: anchor.x, y: end.y },
            end
        ]);
    }

    // 2点でも両端を同じ軸上へ投影するので、中間区間の直交性は崩れない。
    const firstVertical = points[0].x === points[1].x;
    const lastVertical = points.at(-1).x === points.at(-2).x;
    reconnectBoundary(points[0], firstVertical, start);
    reconnectBoundary(points.at(-1), lastVertical, end);
    return simplifyExact([start, ...points, end]);
}
