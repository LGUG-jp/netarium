/**
 * Netarium - canvas/link-router.js
 */

import {
    DEFAULT_DEVICE_HEIGHT,
    DEFAULT_DEVICE_OBSTACLE_HEIGHT,
    DEFAULT_DEVICE_WIDTH,
    LINK_LABEL_DIAGONAL_OFFSET,
    LINK_LABEL_HORIZONTAL_OFFSET,
    LINK_LABEL_VERTICAL_OFFSET,
    LINK_ROUTE_MODES,
    LINK_ROUTE_STRAIGHT_THRESHOLD
} from '../core/constants.js';

import { appState } from '../core/state.js';

/**
 * 座標を有限数へ正規化する。
 */
export function normalizeLinkRoutePoint(point) {
    if (!point) {
        return null;
    }

    const x =
        Number(point.x);

    const y =
        Number(point.y);

    if (
        !Number.isFinite(x) ||
        !Number.isFinite(y)
    ) {
        return null;
    }

    return {
        x,
        y
    };
}

/**
 * 始点と終点の位置関係から、
 * 自動描画に使用する経路を選ぶ。
 */

/**
 * 始点と終点の位置関係から、
 * 自動描画に使用する経路を選ぶ。
 */
export function resolveLinkRouteMode(
    fromPoint,
    toPoint,
    requestedMode =
        LINK_ROUTE_MODES.AUTO
) {
    if (
        requestedMode ===
            LINK_ROUTE_MODES.STRAIGHT ||
        requestedMode ===
            LINK_ROUTE_MODES.HORIZONTAL ||
        requestedMode ===
            LINK_ROUTE_MODES.VERTICAL
    ) {
        return requestedMode;
    }

    const start =
        normalizeLinkRoutePoint(
            fromPoint
        );

    const end =
        normalizeLinkRoutePoint(
            toPoint
        );

    if (!start || !end) {
        return null;
    }

    const deltaX =
        Math.abs(
            end.x - start.x
        );

    const deltaY =
        Math.abs(
            end.y - start.y
        );

    /*
     * ほぼ水平またはほぼ垂直なら、
     * 折れ線にする意味がないため直線にする。
     */
    if (
        deltaX <=
            LINK_ROUTE_STRAIGHT_THRESHOLD ||
        deltaY <=
            LINK_ROUTE_STRAIGHT_THRESHOLD
    ) {
        return LINK_ROUTE_MODES.STRAIGHT;
    }

    /*
     * 横方向の距離が長ければ
     * 横→縦→横を選ぶ。
     *
     * 同距離の場合も横優先とすることで、
     * 経路選択を常に一定にする。
     */
    if (deltaX >= deltaY) {
        return LINK_ROUTE_MODES.HORIZONTAL;
    }

    return LINK_ROUTE_MODES.VERTICAL;
}

/**
 * 連続して重複する経路点を除去する。
 */

/**
 * 連続して重複する経路点を除去する。
 */
export function removeDuplicateLinkRoutePoints(
    route
) {
    if (!Array.isArray(route)) {
        return [];
    }

    return route.reduce(
        (result, point) => {
            const normalizedPoint =
                normalizeLinkRoutePoint(
                    point
                );

            if (!normalizedPoint) {
                return result;
            }

            const previous =
                result[
                    result.length - 1
                ];

            if (
                previous &&
                previous.x ===
                    normalizedPoint.x &&
                previous.y ===
                    normalizedPoint.y
            ) {
                return result;
            }

            result.push(
                normalizedPoint
            );

            return result;
        },
        []
    );
}


/**
 * リンク両端の座標から経路を生成する。
 *
 * straight:
 *   始点 → 終点
 *
 * horizontal:
 *   始点 → 横中継点 → 縦中継点 → 終点
 *
 * vertical:
 *   始点 → 縦中継点 → 横中継点 → 終点
 */

/**
 * リンク両端の座標から経路を生成する。
 *
 * straight:
 *   始点 → 終点
 *
 * horizontal:
 *   始点 → 横中継点 → 縦中継点 → 終点
 *
 * vertical:
 *   始点 → 縦中継点 → 横中継点 → 終点
 */
export function calculateLinkRoute(
    fromPoint,
    toPoint,
    requestedMode =
        LINK_ROUTE_MODES.AUTO
) {
    const start =
        normalizeLinkRoutePoint(
            fromPoint
        );

    const end =
        normalizeLinkRoutePoint(
            toPoint
        );

    if (!start || !end) {
        return [];
    }

    const mode =
        resolveLinkRouteMode(
            start,
            end,
            requestedMode
        );

    if (!mode) {
        return [];
    }

    if (
        mode ===
        LINK_ROUTE_MODES.STRAIGHT
    ) {
        return [
            start,
            end
        ];
    }

    if (
        mode ===
        LINK_ROUTE_MODES.HORIZONTAL
    ) {
        const middleX =
            (
                start.x +
                end.x
            ) / 2;

        return removeDuplicateLinkRoutePoints([
            start,
            {
                x: middleX,
                y: start.y
            },
            {
                x: middleX,
                y: end.y
            },
            end
        ]);
    }

    if (
        mode ===
        LINK_ROUTE_MODES.VERTICAL
    ) {
        const middleY =
            (
                start.y +
                end.y
            ) / 2;

        return removeDuplicateLinkRoutePoints([
            start,
            {
                x: start.x,
                y: middleY
            },
            {
                x: end.x,
                y: middleY
            },
            end
        ]);
    }

    return [];
}


/**
 * 経路の点配列をSVG pathのd属性へ変換する。
 *
 * 例:
 * [
 *     { x: 100, y: 100 },
 *     { x: 300, y: 200 }
 * ]
 *
 * ↓
 *
 * M 100 100 L 300 200
 */

/**
 * 経路の点配列をSVG pathのd属性へ変換する。
 *
 * 例:
 * [
 *     { x: 100, y: 100 },
 *     { x: 300, y: 200 }
 * ]
 *
 * ↓
 *
 * M 100 100 L 300 200
 */
export function buildSvgPathData(route) {
    if (
        !Array.isArray(route) ||
        route.length < 2
    ) {
        return null;
    }

    const points =
        route.map(point => {
            if (!point) {
                return null;
            }

            const x =
                Number(point.x);

            const y =
                Number(point.y);

            if (
                !Number.isFinite(x) ||
                !Number.isFinite(y)
            ) {
                return null;
            }

            return {
                x,
                y
            };
        });

    if (
        points.some(
            point => point === null
        )
    ) {
        return null;
    }

    const [
        firstPoint,
        ...remainingPoints
    ] = points;

    const commands = [
        `M ${firstPoint.x} ${firstPoint.y}`
    ];

    remainingPoints.forEach(
        point => {
            commands.push(
                `L ${point.x} ${point.y}`
            );
        }
    );

    return commands.join(' ');
}

/**
 * リンク表示用のSVG path要素を生成する。
 */

/**
 * リンク表示用のSVG path要素を生成する。
 */
export function createTopologyLinkPath(
    className,
    pathData
) {
    if (
        !className ||
        !pathData
    ) {
        return null;
    }

    const path =
        document.createElementNS(
            'http://www.w3.org/2000/svg',
            'path'
        );

    path.classList.add(
        className
    );

    path.setAttribute(
        'd',
        pathData
    );

    return path;
}

/**
 * 経路から始点と終点を取得する。
 *
 * 現在のSVG line描画で使用する。
 * 経路が不正な場合はnullを返す。
 */

/**
 * 経路から始点と終点を取得する。
 *
 * 現在のSVG line描画で使用する。
 * 経路が不正な場合はnullを返す。
 */
export function getLinkRouteEndpoints(route) {
    if (
        !Array.isArray(route) ||
        route.length < 2
    ) {
        return null;
    }

    const start =
        route[0];

    const end =
        route[
            route.length - 1
        ];

    if (
        !start ||
        !end ||
        !Number.isFinite(start.x) ||
        !Number.isFinite(start.y) ||
        !Number.isFinite(end.x) ||
        !Number.isFinite(end.y)
    ) {
        return null;
    }

    return {
        start,
        end
    };
}

/**
 * 2点間の距離を計算する。
 */

/**
 * 2点間の距離を計算する。
 */
export function calculateLinkSegmentLength(
    start,
    end
) {
    const normalizedStart =
        normalizeLinkRoutePoint(
            start
        );

    const normalizedEnd =
        normalizeLinkRoutePoint(
            end
        );

    if (
        !normalizedStart ||
        !normalizedEnd
    ) {
        return null;
    }

    return Math.hypot(
        normalizedEnd.x -
            normalizedStart.x,
        normalizedEnd.y -
            normalizedStart.y
    );
}

/**
 * 経路を、始点・終点・長さを持つ
 * 区間の配列へ変換する。
 */

/**
 * 経路を、始点・終点・長さを持つ
 * 区間の配列へ変換する。
 */
export function getLinkRouteSegments(route) {
    if (
        !Array.isArray(route) ||
        route.length < 2
    ) {
        return [];
    }

    const segments = [];

    for (
        let index = 0;
        index < route.length - 1;
        index += 1
    ) {
        const start =
            normalizeLinkRoutePoint(
                route[index]
            );

        const end =
            normalizeLinkRoutePoint(
                route[index + 1]
            );

        if (!start || !end) {
            return [];
        }

        const length =
            calculateLinkSegmentLength(
                start,
                end
            );

        if (
            length === null ||
            !Number.isFinite(length)
        ) {
            return [];
        }

        /*
         * 長さ0の区間は経路長に影響しないため
         * 対象から除外する。
         */
        if (length === 0) {
            continue;
        }

        segments.push({
            start,
            end,
            length
        });
    }

    return segments;
}

/**
 * 経路全体の長さに対する中間地点と、
 * その地点を含む区間の方向を取得する。
 */

/**
 * 経路全体の長さに対する中間地点と、
 * その地点を含む区間の方向を取得する。
 */
export function calculateLinkRouteMidpoint(route) {
    const segments =
        getLinkRouteSegments(
            route
        );

    if (segments.length === 0) {
        return null;
    }

    const totalLength =
        segments.reduce(
            (sum, segment) =>
                sum + segment.length,
            0
        );

    if (
        !Number.isFinite(totalLength) ||
        totalLength <= 0
    ) {
        return null;
    }

    const targetDistance =
        totalLength / 2;

    let traversedDistance = 0;

    for (
        let index = 0;
        index < segments.length;
        index += 1
    ) {
        const segment =
            segments[index];

        const segmentEndDistance =
            traversedDistance +
            segment.length;

        /*
         * 経路中央が区間境界と一致する場合は、
         * 次の区間があれば次の区間を採用する。
         *
         * これにより、カギ線の角でラベル方向が
         * 不安定になりにくくなる。
         */
        const isLastSegment =
            index ===
            segments.length - 1;

        if (
            targetDistance <
                segmentEndDistance ||
            isLastSegment
        ) {
            const distanceInSegment =
                Math.max(
                    0,
                    Math.min(
                        segment.length,
                        targetDistance -
                            traversedDistance
                    )
                );

            const ratio =
                distanceInSegment /
                segment.length;

            const x =
                segment.start.x +
                (
                    segment.end.x -
                    segment.start.x
                ) * ratio;

            const y =
                segment.start.y +
                (
                    segment.end.y -
                    segment.start.y
                ) * ratio;

            const deltaX =
                segment.end.x -
                segment.start.x;

            const deltaY =
                segment.end.y -
                segment.start.y;

            let orientation =
                'diagonal';

            if (deltaY === 0) {
                orientation =
                    'horizontal';
            } else if (deltaX === 0) {
                orientation =
                    'vertical';
            }

            return {
                x,
                y,
                orientation,
                segmentIndex: index,
                totalLength
            };
        }

        traversedDistance =
            segmentEndDistance;
    }

    return null;
}

/**
 * 経路全体の中間地点を基準として、
 * ラベル表示位置を計算する。
 *
 * 水平区間:
 *   線の上へ配置
 *
 * 垂直区間:
 *   線の右へ配置
 *
 * 斜め区間:
 *   従来どおり線の上へ配置
 */

/**
 * 経路全体の中間地点を基準として、
 * ラベル表示位置を計算する。
 *
 * 水平区間:
 *   線の上へ配置
 *
 * 垂直区間:
 *   線の右へ配置
 *
 * 斜め区間:
 *   従来どおり線の上へ配置
 */
export function calculateLinkLabelPosition(route) {
    const midpoint =
        calculateLinkRouteMidpoint(
            route
        );

    if (midpoint) {
        if (
            midpoint.orientation ===
            'horizontal'
        ) {
            return {
                x: midpoint.x,
                y:
                    midpoint.y -
                    LINK_LABEL_HORIZONTAL_OFFSET,
                orientation:
                    midpoint.orientation
            };
        }

        if (
            midpoint.orientation ===
            'vertical'
        ) {
            return {
                x:
                    midpoint.x +
                    LINK_LABEL_VERTICAL_OFFSET,
                y: midpoint.y,
                orientation:
                    midpoint.orientation
            };
        }

        return {
            x: midpoint.x,
            y:
                midpoint.y -
                LINK_LABEL_DIAGONAL_OFFSET,
            orientation:
                midpoint.orientation
        };
    }

    /*
     * 長さ0の経路などに対するフォールバック。
     */
    const endpoints =
        getLinkRouteEndpoints(
            route
        );

    if (!endpoints) {
        return null;
    }

    return {
        x:
            (
                endpoints.start.x +
                endpoints.end.x
            ) / 2,
        y:
            (
                endpoints.start.y +
                endpoints.end.y
            ) / 2 -
            LINK_LABEL_DIAGONAL_OFFSET,
        orientation: 'diagonal'
    };
}


/**
 * リンク描画
 */

const ROUTE_LANE_SPACING = 24;
const MAX_ROUTE_OFFSET_STEPS = 6;
const DEVICE_ROUTE_CLEARANCE = 10;
const MAX_DETOUR_CANDIDATES = 32;
const MAX_DETOUR_STEPS = 8;
const MAX_AUTO_ROUTE_POINTS = 10; // 手動調整へ移行できる最大8中間点。
const MAX_DENSE_DETOUR_LINKS = 32; // ビュー全体で最大256追加候補。

function getRouteOffsets(connectionCount = 1) {
    // 128pxカードと余白を越える±96px laneまで用意し、片側だけの共有幹線を避ける。
    const steps = Math.min(MAX_ROUTE_OFFSET_STEPS, Math.max(4, Math.ceil((connectionCount - 1) / 2)));
    const offsets = [0];
    for (let step = 1; step <= steps; step++) {
        offsets.push(step * ROUTE_LANE_SPACING, -step * ROUTE_LANE_SPACING);
    }
    return offsets;
}

function getPlacementRect(placement) {
    const left = Number(placement.x) || 0;
    const top = Number(placement.y) || 0;
    return {
        deviceId: Number(placement.device_id),
        left, top,
        right: left + (Number(placement.width) || DEFAULT_DEVICE_WIDTH),
        bottom: top + (Number(placement.height) || DEFAULT_DEVICE_HEIGHT)
    };
}

// 中心端点は変えず、共通の最初の折れを機器内部に収める。
// 大きなoffsetの外向き区間も別の座標に置き、外部の共通幹線を作らない。
function getLaneEndpointPoints(point, rect, offset, horizontal) {
    const halfAcross = Math.max(0, (horizontal ? rect.bottom - rect.top : rect.right - rect.left) / 2 - 4);
    const halfAlong = Math.max(0, (horizontal ? rect.right - rect.left : rect.bottom - rect.top) / 2 - 4);
    const innerOffset = Math.max(-halfAcross, Math.min(halfAcross, offset));
    const branch = halfAlong * offset / ((MAX_ROUTE_OFFSET_STEPS + 1) * ROUTE_LANE_SPACING);
    if (horizontal) {
        return [
            point,
            { x: point.x, y: point.y + innerOffset },
            { x: point.x + branch, y: point.y + innerOffset },
            { x: point.x + branch, y: point.y + offset }
        ];
    }
    return [
        point,
        { x: point.x + innerOffset, y: point.y },
        { x: point.x + innerOffset, y: point.y + branch },
        { x: point.x + offset, y: point.y + branch }
    ];
}

function getSplitLaneRoute(start, end, fromRect, toRect, horizontal, fromOffset, toOffset, middleOffset = 0) {
    const fromPoints = getLaneEndpointPoints(start, fromRect, fromOffset, horizontal);
    const toPoints = getLaneEndpointPoints(end, toRect, toOffset, horizontal);
    const fromLane = fromPoints[fromPoints.length - 1];
    const toLane = toPoints[toPoints.length - 1];
    const middle = horizontal ? (start.x + end.x) / 2 + middleOffset : (start.y + end.y) / 2 + middleOffset;
    return [
        ...fromPoints,
        horizontal ? { x: middle, y: fromLane.y } : { x: fromLane.x, y: middle },
        horizontal ? { x: middle, y: toLane.y } : { x: toLane.x, y: middle },
        ...toPoints.reverse()
    ];
}

/**
 * 連続する同一直線上の3点を単純化する
 */
export function simplifyCollinearPoints(route) {
    if (!Array.isArray(route) || route.length <= 2) {
        return route || [];
    }
    const result = [route[0]];
    for (let i = 1; i < route.length - 1; i++) {
        const prev = result[result.length - 1];
        const curr = route[i];
        const next = route[i + 1];

        const isHorizontal = Math.abs(prev.y - curr.y) < 0.001 && Math.abs(curr.y - next.y) < 0.001;
        const isVertical = Math.abs(prev.x - curr.x) < 0.001 && Math.abs(curr.x - next.x) < 0.001;

        const continuesHorizontal = isHorizontal && (curr.x - prev.x) * (next.x - curr.x) >= 0;
        const continuesVertical = isVertical && (curr.y - prev.y) * (next.y - curr.y) >= 0;
        if (!continuesHorizontal && !continuesVertical) {
            result.push(curr);
        }
    }
    result.push(route[route.length - 1]);
    return result;
}

function getRouteKey(route) {
    return route.map(p => `${Math.round(p.x * 10) / 10},${Math.round(p.y * 10) / 10}`).join(';');
}

function getNormalizedSegments(route, linkId = 0) {
    const segments = [];
    for (let i = 0; i < route.length - 1; i++) {
        const p1 = route[i];
        const p2 = route[i + 1];
        const isHorizontal = Math.abs(p1.y - p2.y) < 0.001;
        const isVertical = Math.abs(p1.x - p2.x) < 0.001;
        const length = Math.hypot(p2.x - p1.x, p2.y - p1.y);
        if (length < 0.001) continue;

        segments.push({
            x1: Math.min(p1.x, p2.x),
            x2: Math.max(p1.x, p2.x),
            y1: Math.min(p1.y, p2.y),
            y2: Math.max(p1.y, p2.y),
            rawP1: p1,
            rawP2: p2,
            isHorizontal,
            isVertical,
            length,
            linkId
        });
    }
    return segments;
}

// 開区間で判定し、clearanceの外縁を走る線は許可する。斜線も角抜けを見落とさない。
function segmentRectOverlap(p1, p2, rect) {
    if (p1.y === p2.y) {
        if (p1.y <= rect.top || p1.y >= rect.bottom) return 0;
        return Math.max(0, Math.min(Math.max(p1.x, p2.x), rect.right) -
            Math.max(Math.min(p1.x, p2.x), rect.left));
    }
    if (p1.x === p2.x) {
        if (p1.x <= rect.left || p1.x >= rect.right) return 0;
        return Math.max(0, Math.min(Math.max(p1.y, p2.y), rect.bottom) -
            Math.max(Math.min(p1.y, p2.y), rect.top));
    }
    let low = 0;
    let high = 1;
    for (const [axis, min, max] of [
        ['x', rect.left, rect.right], ['y', rect.top, rect.bottom]
    ]) {
        const delta = p2[axis] - p1[axis];
        if (delta === 0) {
            if (p1[axis] <= min || p1[axis] >= max) return 0;
        } else {
            const a = (min - p1[axis]) / delta;
            const b = (max - p1[axis]) / delta;
            low = Math.max(low, Math.min(a, b));
            high = Math.min(high, Math.max(a, b));
            if (high <= low) return 0;
        }
    }
    return (high - low) * Math.hypot(p2.x - p1.x, p2.y - p1.y);
}

function firstRouteObstacle(route, obstacleIndex, fromRect, toRect) {
    for (let i = 1; i < route.length; i++) {
        const a = route[i - 1];
        const b = route[i];
        for (const rect of obstacleIndex.query(
            Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)
        )) {
            if (rect.deviceId !== fromRect.deviceId && rect.deviceId !== toRect.deviceId &&
                segmentRectOverlap(a, b, rect) > 0) return { index: i, rect };
        }
    }
    return null;
}

function pointInsideRect(point, rect) {
    return point.x > rect.left && point.x < rect.right &&
        point.y > rect.top && point.y < rect.bottom;
}

// 最初に衝突した矩形の上下左右だけを探す。全配置を探索せず、
// 通常32候補/8迂回、高速8候補/2迂回、最大8中間点で打ち切る。
function generateObstacleDetours(route, obstacleIndex, fromRect, toRect, dense = false) {
    const limit = dense ? 8 : MAX_DETOUR_CANDIDATES;
    const stepLimit = dense ? 2 : MAX_DETOUR_STEPS;
    const queue = [{ route, depth: 0 }];
    const seen = new Set([getRouteKey(route)]);
    const clearRoutes = [];
    let generated = 0;
    for (let cursor = 0; cursor < queue.length && generated < limit; cursor++) {
        const current = queue[cursor];
        const hit = firstRouteObstacle(current.route, obstacleIndex, fromRect, toRect);
        if (!hit) {
            clearRoutes.push(current.route);
            continue;
        }
        if (current.depth >= stepLimit) continue;
        let first = hit.index - 1;
        let last = hit.index;
        while (first > 0 && pointInsideRect(current.route[first], hit.rect)) first--;
        while (last < current.route.length - 1 && pointInsideRect(current.route[last], hit.rect)) last++;
        const a = current.route[first];
        const b = current.route[last];
        // 未接続カードが端点そのものを覆う場合は、座標契約を保った回避が不可能。
        if (pointInsideRect(a, hit.rect) || pointInsideRect(b, hit.rect)) continue;
        const bypasses = [
            [a, { x: a.x, y: hit.rect.top }, { x: b.x, y: hit.rect.top }, b],
            [a, { x: a.x, y: hit.rect.bottom }, { x: b.x, y: hit.rect.bottom }, b],
            [a, { x: hit.rect.left, y: a.y }, { x: hit.rect.left, y: b.y }, b],
            [a, { x: hit.rect.right, y: a.y }, { x: hit.rect.right, y: b.y }, b]
        ];
        if (!dense) {
            // 同じ障害物を避ける別リンクにも、既存24px laneの分離余地を残す。
            const top = hit.rect.top - ROUTE_LANE_SPACING;
            const bottom = hit.rect.bottom + ROUTE_LANE_SPACING;
            const left = hit.rect.left - ROUTE_LANE_SPACING;
            const right = hit.rect.right + ROUTE_LANE_SPACING;
            bypasses.push(
                [a, { x: a.x, y: top }, { x: b.x, y: top }, b],
                [a, { x: a.x, y: bottom }, { x: b.x, y: bottom }, b],
                [a, { x: left, y: a.y }, { x: left, y: b.y }, b],
                [a, { x: right, y: a.y }, { x: right, y: b.y }, b]
            );
        }
        for (const bypass of bypasses) {
            if (generated >= limit) break;
            generated++;
            if (bypass.slice(1).some((p, i) => segmentRectOverlap(bypass[i], p, hit.rect) > 0)) continue;
            const candidate = simplifyCollinearPoints(removeDuplicateLinkRoutePoints([
                ...current.route.slice(0, first), ...bypass, ...current.route.slice(last + 1)
            ]));
            if (candidate.length > MAX_AUTO_ROUTE_POINTS) continue;
            const key = getRouteKey(candidate);
            if (seen.has(key)) continue;
            seen.add(key);
            if (!firstRouteObstacle(candidate, obstacleIndex, fromRect, toRect)) clearRoutes.push(candidate);
            else queue.push({ route: candidate, depth: current.depth + 1 });
        }
    }
    return clearRoutes;
}

export function generateLinkRouteCandidates(start, end, options = {}) {
    const rawCandidates = [];
    const offsets = getRouteOffsets(options.connectionCount);
    const deltaX = Math.abs(end.x - start.x);
    const deltaY = Math.abs(end.y - start.y);
    const isNearlyHorizontal = deltaY <= LINK_ROUTE_STRAIGHT_THRESHOLD;
    const isNearlyVertical = deltaX <= LINK_ROUTE_STRAIGHT_THRESHOLD;

    // 1. 直線が適用可能な場合
    if (isNearlyHorizontal || isNearlyVertical) {
        rawCandidates.push([start, end]);
    }

    // 2. 同一直線上の場合の迂回候補 (2本の直交折れ線で中央を迂回)
    if (isNearlyHorizontal) {
        const dir = end.x >= start.x ? 1 : -1;
        const breakDist = Math.min(30, Math.max(10, deltaX * 0.25));
        const x1 = start.x + dir * breakDist;
        const x2 = end.x - dir * breakDist;
        for (const offset of offsets.slice(1)) {
            rawCandidates.push([
                start,
                { x: x1, y: start.y },
                { x: x1, y: start.y + offset },
                { x: x2, y: start.y + offset },
                { x: x2, y: end.y },
                end
            ]);
        }
    } else if (isNearlyVertical) {
        const dir = end.y >= start.y ? 1 : -1;
        const breakDist = Math.min(30, Math.max(10, deltaY * 0.25));
        const y1 = start.y + dir * breakDist;
        const y2 = end.y - dir * breakDist;
        for (const offset of offsets.slice(1)) {
            rawCandidates.push([
                start,
                { x: start.x, y: y1 },
                { x: start.x + offset, y: y1 },
                { x: start.x + offset, y: y2 },
                { x: end.x, y: y2 },
                end
            ]);
        }
    }

    // 3. 横優先カギ線 (S -> (mx, sy) -> (mx, ey) -> E)
    const baseMx = (start.x + end.x) / 2;
    for (const offset of offsets) {
        const mx = baseMx + offset;
        rawCandidates.push([
            start,
            { x: mx, y: start.y },
            { x: mx, y: end.y },
            end
        ]);
    }

    // 4. 縦優先カギ線 (S -> (sx, my) -> (ex, my) -> E)
    const baseMy = (start.y + end.y) / 2;
    for (const offset of offsets) {
        const my = baseMy + offset;
        rawCandidates.push([
            start,
            { x: start.x, y: my },
            { x: end.x, y: my },
            end
        ]);
    }

    // 接続数に応じて増やすが、最大13 offset / 65候補に固定する。
    if (options.fromRect && options.toRect) {
        for (const offset of offsets) {
            rawCandidates.push(getSplitLaneRoute(start, end, options.fromRect, options.toRect, true, offset, offset, offset));
            rawCandidates.push(getSplitLaneRoute(start, end, options.fromRect, options.toRect, false, offset, offset, offset));
        }
    }

    // 候補の正規化、重複除去、無効除外
    const seenKeys = new Set();
    const cleanCandidates = [];

    for (const raw of rawCandidates) {
        const simplified = simplifyCollinearPoints(removeDuplicateLinkRoutePoints(raw));
        if (simplified.length < 2) continue;
        const key = getRouteKey(simplified);
        if (!seenKeys.has(key)) {
            seenKeys.add(key);
            cleanCandidates.push(simplified);
        }
    }

    return cleanCandidates;
}

/**
 * 候補区間の外接矩形で絞り込む。細い斜め線も同じ外接矩形で扱うため、
 * 詳細な交差判定は従来の関数に任せる。
 * 長大な区間は粗いセルへ登録し、広い範囲でも登録/検索が膨らまないようにする。
 */
class RouteSpatialIndex {
    constructor() {
        this.levels = [192, 1536, 12288, 98304].map(size => ({
            size, cells: new Map()
        }));
        this.wide = [];
        this.items = [];
    }

    add(item, left, top, right, bottom) {
        const index = this.items.length;
        this.items.push({ item, left, top, right, bottom });
        let selected;
        let minX;
        let maxX;
        let minY;
        let maxY;
        for (const level of this.levels) {
            minX = Math.floor(left / level.size);
            maxX = Math.floor(right / level.size);
            minY = Math.floor(top / level.size);
            maxY = Math.floor(bottom / level.size);
            if (Number.isSafeInteger(minX) && Number.isSafeInteger(maxX) &&
                Number.isSafeInteger(minY) && Number.isSafeInteger(maxY) &&
                (maxX - minX + 1) * (maxY - minY + 1) <= 64) {
                selected = level;
                break;
            }
        }
        if (!selected) {
            this.wide.push(index);
            return;
        }
        for (let x = minX; x <= maxX; x++) {
            let column = selected.cells.get(x);
            if (!column) {
                column = new Map();
                selected.cells.set(x, column);
            }
            for (let y = minY; y <= maxY; y++) {
                let entries = column.get(y);
                if (!entries) {
                    entries = [];
                    column.set(y, entries);
                }
                entries.push(index);
            }
        }
    }

    query(left, top, right, bottom, padding = 0) {
        left -= padding;
        top -= padding;
        right += padding;
        bottom += padding;
        const found = new Set(this.wide);
        for (const { size, cells } of this.levels) {
            if (cells.size === 0) continue;
            const minX = Math.floor(left / size);
            const maxX = Math.floor(right / size);
            const minY = Math.floor(top / size);
            const maxY = Math.floor(bottom / size);

            // 長い区間や、++で進まない大きなセル番号では登録済みセルだけを走査する。
            if (!Number.isSafeInteger(minX) || !Number.isSafeInteger(maxX) ||
                !Number.isSafeInteger(minY) || !Number.isSafeInteger(maxY) ||
                (maxX - minX + 1) * (maxY - minY + 1) > cells.size * 64) {
                for (const [x, column] of cells) {
                    if (x < minX || x > maxX) continue;
                    for (const [y, entries] of column) {
                        if (y < minY || y > maxY) continue;
                        for (const index of entries) found.add(index);
                    }
                }
            } else {
                for (let x = minX; x <= maxX; x++) {
                    const column = cells.get(x);
                    if (!column) continue;
                    for (let y = minY; y <= maxY; y++) {
                        const entries = column.get(y);
                        if (!entries) continue;
                        for (const index of entries) found.add(index);
                    }
                }
            }
        }

        // 元の走査順で合算し、同点時の候補選択を維持する。
        return Array.from(found)
            .sort((a, b) => a - b)
            .filter(index => {
                const box = this.items[index];
                return box.left <= right && box.right >= left &&
                    box.top <= bottom && box.bottom >= top;
            })
            .map(index => this.items[index].item);
    }
}

function indexRouteSegment(index, segment) {
    index.add(segment, segment.x1, segment.y1, segment.x2, segment.y2);
}

function getVisibleSegments(segments, fromRect, toRect) {
    let visible = segments;
    for (const rect of [fromRect, toRect]) {
        const clipped = [];
        for (const segment of visible) {
            const horizontal = segment.isHorizontal;
            if ((!horizontal && !segment.isVertical) ||
                (horizontal ? segment.y1 < rect.top || segment.y1 > rect.bottom :
                    segment.x1 < rect.left || segment.x1 > rect.right)) {
                clipped.push(segment);
                continue;
            }
            const low = horizontal ? segment.x1 : segment.y1;
            const high = horizontal ? segment.x2 : segment.y2;
            const cutLow = Math.max(low, horizontal ? rect.left : rect.top);
            const cutHigh = Math.min(high, horizontal ? rect.right : rect.bottom);
            if (cutHigh <= cutLow) {
                clipped.push(segment);
                continue;
            }
            if (low < cutLow) {
                clipped.push(horizontal ? { ...segment, x2: cutLow, length: cutLow - low } :
                    { ...segment, y2: cutLow, length: cutLow - low });
            }
            if (cutHigh < high) {
                clipped.push(horizontal ? { ...segment, x1: cutHigh, length: high - cutHigh } :
                    { ...segment, y1: cutHigh, length: high - cutHigh });
            }
        }
        visible = clipped;
    }
    return visible;
}

function nearbyRouteSegments(index, segment) {
    // 完全重複だけでなく24px未満の近接平行区間も取得する。
    return index.query(segment.x1, segment.y1, segment.x2, segment.y2, ROUTE_LANE_SPACING);
}

function evaluateCandidateRoute(route, obstacleIndex, committedIndex, candidateIndex, fromRect, toRect, bestScore) {
    const segments = getNormalizedSegments(route);
    let obstacleCrossings = 0;
    let overlapLength = 0;
    let proximityLength = 0;
    let intersectionCount = 0;
    let totalLength = 0;

    for (const seg of segments) {
        totalLength += seg.length;
        // 1. 他機器内部通過チェック
        for (const obs of obstacleIndex.query(seg.x1, seg.y1, seg.x2, seg.y2)) {
            if (obs.deviceId === fromRect.deviceId || obs.deviceId === toRect.deviceId) continue;
            const overlap = segmentRectOverlap(seg.rawP1, seg.rawP2, obs);
            if (overlap > 0) obstacleCrossings += 1000 + overlap;
        }
        if (bestScore && obstacleCrossings > bestScore.obstacleScore) return null;
    }

    for (const seg of getVisibleSegments(segments, fromRect, toRect)) {
        // 2. 既決定リンクとの重複・交差チェック
        for (const comSeg of nearbyRouteSegments(committedIndex, seg)) {
            if ((seg.isHorizontal && comSeg.isHorizontal) || (seg.isVertical && comSeg.isVertical)) {
                const horizontal = seg.isHorizontal;
                const separation = Math.abs(horizontal ? seg.y1 - comSeg.y1 : seg.x1 - comSeg.x1);
                if (separation < ROUTE_LANE_SPACING) {
                    const overlap = horizontal ?
                        Math.max(0, Math.min(seg.x2, comSeg.x2) - Math.max(seg.x1, comSeg.x1)) :
                        Math.max(0, Math.min(seg.y2, comSeg.y2) - Math.max(seg.y1, comSeg.y1));
                    if (separation < 1) overlapLength += overlap;
                    else proximityLength += overlap * (ROUTE_LANE_SPACING - separation) / ROUTE_LANE_SPACING;
                }
            } else if (seg.isHorizontal && comSeg.isVertical) {
                if (comSeg.x1 > seg.x1 + 1 && comSeg.x1 < seg.x2 - 1 && seg.y1 > comSeg.y1 + 1 && seg.y1 < comSeg.y2 - 1) {
                    intersectionCount += 1;
                }
            } else if (seg.isVertical && comSeg.isHorizontal) {
                if (seg.x1 > comSeg.x1 + 1 && seg.x1 < comSeg.x2 - 1 && comSeg.y1 > seg.y1 + 1 && comSeg.y1 < seg.y2 - 1) {
                    intersectionCount += 1;
                }
            }
        }
    }

    const bendCount = Math.max(0, route.length - 2);

    return {
        obstacleScore: obstacleCrossings,
        overlapLength,
        proximityLength,
        intersectionCount,
        totalLength,
        bendCount,
        candidateIndex
    };
}

function compareCandidateScores(a, b) {
    if (a.obstacleScore !== b.obstacleScore) return a.obstacleScore - b.obstacleScore;
    if (a.overlapLength !== b.overlapLength) return a.overlapLength - b.overlapLength;
    if (a.proximityLength !== b.proximityLength) return a.proximityLength - b.proximityLength;
    if (a.intersectionCount !== b.intersectionCount) return a.intersectionCount - b.intersectionCount;
    if (Math.abs(a.totalLength - b.totalLength) > 1) return a.totalLength - b.totalLength;
    if (a.bendCount !== b.bendCount) return a.bendCount - b.bendCount;
    return a.candidateIndex - b.candidateIndex;
}

/**
 * 高密度ビューでは候補×既決定区間の評価を行わず、機器ごとの接続順で
 * 24pxのlaneを最大13本まで循環割当する。共有端点も機器内部で分岐する。
 */
function routeDenseTopologyLinks(links, placementByDeviceId, fixedRoutes, rectByDeviceId, obstacleIndex) {
    const routes = new Map();
    const endpointCounts = new Map();
    const offsets = getRouteOffsets(MAX_ROUTE_OFFSET_STEPS * 2 + 1);
    let detourLinks = 0;
    for (const link of links) {
        const fromId = Number(link.from_id);
        const toId = Number(link.to_id);
        const from = placementByDeviceId.get(fromId);
        const to = placementByDeviceId.get(toId);
        const fromCount = endpointCounts.get(fromId) || 0;
        endpointCounts.set(fromId, fromCount + 1);
        const toCount = endpointCounts.get(toId) || 0;
        endpointCounts.set(toId, toCount + 1);
        // 手動リンクも接続順に数え、後続autoのlane割当を変えない。
        const linkId = Number(link.id);
        if (fixedRoutes?.has(linkId)) {
            routes.set(linkId, fixedRoutes.get(linkId));
            continue;
        }
        const start = {
            x: Number(from.x) + (Number(from.width) || DEFAULT_DEVICE_WIDTH) / 2,
            y: Number(from.y) + (Number(from.height) || DEFAULT_DEVICE_HEIGHT) / 2
        };
        const end = {
            x: Number(to.x) + (Number(to.width) || DEFAULT_DEVICE_WIDTH) / 2,
            y: Number(to.y) + (Number(to.height) || DEFAULT_DEVICE_HEIGHT) / 2
        };
        const fromOffset = offsets[fromCount % offsets.length];
        const toOffset = offsets[toCount % offsets.length];
        const horizontal = Math.abs(end.x - start.x) >= Math.abs(end.y - start.y);
        const fromRect = rectByDeviceId.get(fromId);
        const toRect = rectByDeviceId.get(toId);
        let route = simplifyCollinearPoints(removeDuplicateLinkRoutePoints(getSplitLaneRoute(
            start, end, fromRect, toRect, horizontal, fromOffset, toOffset, fromOffset
        )));
        if (detourLinks < MAX_DENSE_DETOUR_LINKS &&
            firstRouteObstacle(route, obstacleIndex, fromRect, toRect)) {
            detourLinks++;
            const detours = generateObstacleDetours(route, obstacleIndex, fromRect, toRect, true);
            let shortest = Infinity;
            for (const candidate of detours) {
                const length = getNormalizedSegments(candidate).reduce((sum, segment) => sum + segment.length, 0);
                if (length < shortest) {
                    shortest = length;
                    route = candidate;
                }
            }
        }
        routes.set(Number(link.id), route);
    }
    return routes;
}

/**
 * 機器とリンク全体を考慮して重ならない経路を一括計算する
 *
 * @param {Array} links
 * @param {Array} placements
 * @param {Map<number, Array<{x: number, y: number}>> | null} fixedRoutes 手動経路
 * @returns {Map<number, Array<{x: number, y: number}>>}
 */
export function routeTopologyLinks(links, placements, fixedRoutes = null) {
    const routeMap = new Map();
    if (!Array.isArray(links) || !Array.isArray(placements) || links.length === 0) {
        return routeMap;
    }

    const placementByDeviceId = new Map();
    placements.forEach(p => {
        if (p && p.device_id != null) {
            placementByDeviceId.set(Number(p.device_id), p);
        }
    });

    const sortedLinks = links
        .filter(link => {
            if (!link || link.from_id == null || link.to_id == null) return false;
            return placementByDeviceId.has(Number(link.from_id)) && placementByDeviceId.has(Number(link.to_id));
        })
        .slice()
        .sort((a, b) => Number(a.id) - Number(b.id));

    const obstacles = [...placementByDeviceId.values()].map(getPlacementRect)
        .sort((a, b) => a.deviceId - b.deviceId);
    const rectByDeviceId = new Map(obstacles.map(rect => [rect.deviceId, rect]));
    const connectionCounts = new Map();
    for (const link of sortedLinks) {
        for (const id of [Number(link.from_id), Number(link.to_id)]) {
            connectionCounts.set(id, (connectionCounts.get(id) || 0) + 1);
        }
    }
    const obstacleIndex = new RouteSpatialIndex();
    for (const obstacle of obstacles) {
        const placement = placementByDeviceId.get(obstacle.deviceId);
        const expanded = {
            ...obstacle,
            left: obstacle.left - DEVICE_ROUTE_CLEARANCE,
            top: obstacle.top - DEVICE_ROUTE_CLEARANCE,
            right: obstacle.right + DEVICE_ROUTE_CLEARANCE,
            bottom: obstacle.top + (Number(placement.height) || DEFAULT_DEVICE_OBSTACLE_HEIGHT) + DEVICE_ROUTE_CLEARANCE
        };
        obstacleIndex.add(expanded, expanded.left, expanded.top, expanded.right, expanded.bottom);
    }

    // 高速経路を維持し、衝突線だけを局所処理する。
    if (sortedLinks.length > 500) {
        return routeDenseTopologyLinks(sortedLinks, placementByDeviceId, fixedRoutes, rectByDeviceId, obstacleIndex);
    }

    const committedIndex = new RouteSpatialIndex();

    for (const link of sortedLinks) {
        const linkId = Number(link.id);
        if (fixedRoutes?.has(linkId)) {
            const route = fixedRoutes.get(linkId);
            const fromRect = rectByDeviceId.get(Number(link.from_id));
            const toRect = rectByDeviceId.get(Number(link.to_id));
            routeMap.set(linkId, route);
            // ID順で確定し、後続autoが手動経路との重複・交差を評価する。
            const segments = getVisibleSegments(getNormalizedSegments(route, linkId), fromRect, toRect);
            for (const segment of segments) indexRouteSegment(committedIndex, segment);
            continue;
        }
        const fromP = placementByDeviceId.get(Number(link.from_id));
        const toP = placementByDeviceId.get(Number(link.to_id));

        const fromW = Number(fromP.width) || DEFAULT_DEVICE_WIDTH;
        const fromH = Number(fromP.height) || DEFAULT_DEVICE_HEIGHT;
        const toW = Number(toP.width) || DEFAULT_DEVICE_WIDTH;
        const toH = Number(toP.height) || DEFAULT_DEVICE_HEIGHT;

        const start = {
            x: Number(fromP.x) + fromW / 2,
            y: Number(fromP.y) + fromH / 2
        };
        const end = {
            x: Number(toP.x) + toW / 2,
            y: Number(toP.y) + toH / 2
        };

        const fromDeviceId = Number(link.from_id);
        const toDeviceId = Number(link.to_id);

        const fromRect = rectByDeviceId.get(fromDeviceId);
        const toRect = rectByDeviceId.get(toDeviceId);
        const candidateRoutes = generateLinkRouteCandidates(start, end, {
            fromRect, toRect,
            connectionCount: Math.max(connectionCounts.get(fromDeviceId), connectionCounts.get(toDeviceId))
        });

        let bestRoute = null;
        let bestScore = null;

        candidateRoutes.forEach((candidate, idx) => {
            const score = evaluateCandidateRoute(
                candidate, obstacleIndex, committedIndex, idx, fromRect, toRect, bestScore
            );
            if (score && (bestScore === null || compareCandidateScores(score, bestScore) < 0)) {
                bestScore = score;
                bestRoute = candidate;
            }
        });

        if (bestScore?.obstacleScore > 0) {
            const detours = generateObstacleDetours(bestRoute, obstacleIndex, fromRect, toRect);
            for (let i = 0; i < detours.length; i++) {
                const candidate = detours[i];
                const score = evaluateCandidateRoute(
                    candidate, obstacleIndex, committedIndex, candidateRoutes.length + i,
                    fromRect, toRect, bestScore
                );
                if (score && compareCandidateScores(score, bestScore) < 0) {
                    bestScore = score;
                    bestRoute = candidate;
                }
            }
        }

        if (!bestRoute || bestRoute.length < 2) {
            bestRoute = calculateLinkRoute(start, end, LINK_ROUTE_MODES.AUTO);
        }

        routeMap.set(linkId, bestRoute);

        const segs = getVisibleSegments(getNormalizedSegments(bestRoute, linkId), fromRect, toRect);
        for (const seg of segs) indexRouteSegment(committedIndex, seg);
    }

    return routeMap;
}

