// @ts-check

/** @typedef {import('../core/link-route-data.js').RoutePoint} RoutePoint */

import { normalizeLinkRouteData } from '../core/link-route-data.js';

/**
 * @param {RoutePoint} a
 * @param {RoutePoint} b
 */
function samePoint(a, b) {
    return a.x === b.x && a.y === b.y;
}

/**
 * @param {number} value
 * @param {number} a
 * @param {number} b
 */
function isBetween(value, a, b) {
    return value >= Math.min(a, b) && value <= Math.max(a, b);
}

/**
 * 厳密な重複と区間内の共線点だけを除き、折り返しと微小な折れを残す。
 * @param {readonly RoutePoint[]} points
 * @returns {RoutePoint[]}
 */
export function simplifyExact(points) {
    /** @type {RoutePoint[]} */
    const result = [];
    for (const point of points) {
        const copy = { x: point.x, y: point.y };
        if (result.length && samePoint(/** @type {RoutePoint} */ (result.at(-1)), copy)) continue;
        while (result.length >= 2) {
            // length >= 2 を確認済み。Array.at の型は配列長から絞り込まれない。
            const previous = /** @type {RoutePoint} */ (result.at(-2));
            const middle = /** @type {RoutePoint} */ (result.at(-1));
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

/**
 * 保存データと同じ厳格検証を行い、入力から独立した中間点を返す。
 * @param {readonly RoutePoint[]} points
 * @returns {RoutePoint[]}
 */
export function normalizeManualRoute(points) {
    const normalized = normalizeLinkRouteData({ route_mode: 'manual', manual_route: points });
    return simplifyExact(normalized.manual_route);
}

/**
 * @param {RoutePoint | null | undefined} point
 * @returns {point is RoutePoint}
 */
function isFinitePoint(point) {
    return point != null && Number.isFinite(point.x) && Number.isFinite(point.y);
}

/**
 * 斜めの端点接続だけを、隣の区間と同じ軸上へ投影する。
 * @param {RoutePoint} boundary
 * @param {boolean} vertical
 * @param {RoutePoint} center
 */
function reconnectBoundary(boundary, vertical, center) {
    if (boundary.x === center.x || boundary.y === center.y) return;
    if (vertical) {
        boundary.y = center.y;
    } else {
        boundary.x = center.x;
    }
}

/**
 * 現在の機器中心へつなぎ直す。保存用の中間点や端点は変更しない。
 * @param {RoutePoint | null | undefined} start
 * @param {RoutePoint | null | undefined} end
 * @param {readonly RoutePoint[]} manualRoute
 * @returns {RoutePoint[] | null}
 */
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
    // ここでは points.length >= 2 を確認済み。
    const lastVertical = /** @type {RoutePoint} */ (points.at(-1)).x === /** @type {RoutePoint} */ (points.at(-2)).x;
    reconnectBoundary(points[0], firstVertical, start);
    reconnectBoundary(/** @type {RoutePoint} */ (points.at(-1)), lastVertical, end);
    return simplifyExact([start, ...points, end]);
}
