import { LINK_MANUAL_ROUTE_MAX_POINTS } from './constants.js';

/** 保存する中間点だけを検査し、入力から独立した経路データを返す。 */
export function normalizeLinkRouteData(link) {
    const mode = Object.hasOwn(link, 'route_mode') ? link.route_mode : 'auto';
    if (mode !== 'auto' && mode !== 'manual') {
        throw new Error('接続の経路モードが不正です');
    }
    const points = Object.hasOwn(link, 'manual_route') ? link.manual_route : (mode === 'auto' ? [] : undefined);
    if (!Array.isArray(points)) {
        throw new Error('接続の手動経路には中間点の配列が必要です');
    }
    if (points.length > LINK_MANUAL_ROUTE_MAX_POINTS) {
        throw new Error(`接続の中間点は最大${LINK_MANUAL_ROUTE_MAX_POINTS}点です`);
    }
    if (mode === 'auto' && points.length !== 0) {
        throw new Error('自動経路には中間点を指定できません');
    }
    for (let index = 0; index < points.length; index++) {
        const point = points[index];
        if (!point || typeof point !== 'object' || Array.isArray(point) ||
            Object.keys(point).length !== 2 || !Object.hasOwn(point, 'x') || !Object.hasOwn(point, 'y') ||
            !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
            throw new Error('接続の中間点には有限数のxとyだけを指定してください');
        }
        const previous = points[index - 1];
        if (previous && previous.x !== point.x && previous.y !== point.y) {
            throw new Error('接続の隣接中間点は水平または垂直にしてください');
        }
    }
    return { route_mode: mode, manual_route: points.map(point => ({ x: point.x, y: point.y })) };
}
