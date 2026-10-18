import { LINK_MANUAL_ROUTE_MAX_POINTS } from '../core/constants.js';
import { simplifyExact } from './manual-link-route.js';

function samePoint(a, b) {
    return a.x === b.x && a.y === b.y;
}


function validatePolyline(route, allowAutoDiagonal = false) {
    if (!Array.isArray(route) || route.length < 2) {
        throw new Error('接続の経路には両端を含む点の配列が必要です');
    }
    if (route.length - 2 > LINK_MANUAL_ROUTE_MAX_POINTS) {
        throw new Error(`接続の中間点は最大${LINK_MANUAL_ROUTE_MAX_POINTS}点です`);
    }
    for (let index = 0; index < route.length; index++) {
        const point = route[index];
        if (!point || typeof point !== 'object' || Array.isArray(point) ||
            Object.keys(point).length !== 2 || !Object.hasOwn(point, 'x') || !Object.hasOwn(point, 'y') ||
            !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
            throw new Error('接続の経路点には有限数のxとyだけを指定してください');
        }
        const previous = route[index - 1];
        if (previous && previous.x !== point.x && previous.y !== point.y &&
            !(allowAutoDiagonal && route.length === 2)) {
            throw new Error('接続の隣接経路点は水平または垂直にしてください');
        }
    }
}

function normalizeResult(route) {
    const result = simplifyExact(route);
    // ゼロ長になった場合も、編集操作の両端固定を維持する。
    if (result.length === 1) result.push({ ...result[0] });
    validatePolyline(result);
    return result;
}

function segmentIsHorizontal(route, index) {
    validatePolyline(route);
    if (!Number.isInteger(index) || index < 0 || index >= route.length - 1) {
        throw new Error('接続の区間番号が範囲外です');
    }
    if (samePoint(route[index], route[index + 1])) {
        throw new Error('長さがゼロの区間は編集できません');
    }
    return route[index].y === route[index + 1].y;
}

/** 描画経路から保存用中間点を取り出す。2端点の斜線autoはbuilderに直交化を任せる。 */
export function manualRouteFromPolyline(route) {
    validatePolyline(route, true);
    if (route.length === 2) return [];
    return simplifyExact(route).slice(1, -1);
}

/** 区間を垂直方向へ移動し、機器端点だけは元の位置に固定する。 */
export function moveManualRouteSegment(route, index, delta) {
    const horizontal = segmentIsHorizontal(route, index);
    if (!Number.isFinite(delta)) throw new Error('区間の移動量には有限数を指定してください');
    if (delta === 0) return normalizeResult(route);
    const axis = horizontal ? 'y' : 'x';
    const movedStart = { ...route[index], [axis]: route[index][axis] + delta };
    const movedEnd = { ...route[index + 1], [axis]: route[index + 1][axis] + delta };
    const result = route.slice(0, index);
    const previous = route[index - 1];
    if (index === 0 || (previous.x !== movedStart.x && previous.y !== movedStart.y)) {
        result.push(route[index]);
    }
    result.push(movedStart, movedEnd);
    const next = route[index + 2];
    if (!next || (next.x !== movedEnd.x && next.y !== movedEnd.y)) {
        result.push(route[index + 1]);
    }
    result.push(...route.slice(index + 2));
    return normalizeResult(result);
}

/** 隣接区間を伸縮させて2折れの段差を追加する。両側が機器端点ならU字にする。 */
export function addManualRouteDogleg(route, index, offset = 24) {
    const horizontal = segmentIsHorizontal(route, index);
    if (!Number.isFinite(offset) || offset === 0) {
        throw new Error('折れの幅にはゼロ以外の有限数を指定してください');
    }
    if (route.length - 2 > LINK_MANUAL_ROUTE_MAX_POINTS - 2) {
        throw new Error(`折れ追加には中間点が${LINK_MANUAL_ROUTE_MAX_POINTS - 2}点以下の経路が必要です`);
    }
    const axis = horizontal ? 'y' : 'x';
    const along = horizontal ? 'x' : 'y';
    const a = route[index], b = route[index + 1];
    const middle = a[along] / 2 + b[along] / 2;
    const previous = route[index - 1], next = route[index + 2];
    let result;
    if (next && next[along] === b[along] && next[axis] !== b[axis]) {
        const shifted = { ...b, [axis]: b[axis] + offset };
        result = [
            ...route.slice(0, index + 1),
            { ...a, [along]: middle },
            { ...shifted, [along]: middle },
            shifted,
            ...route.slice(index + 2)
        ];
    } else if (previous && previous[along] === a[along] && previous[axis] !== a[axis]) {
        const shifted = { ...a, [axis]: a[axis] + offset };
        result = [
            ...route.slice(0, index),
            shifted,
            { ...shifted, [along]: middle },
            { ...b, [along]: middle },
            ...route.slice(index + 1)
        ];
    } else {
        result = [
            ...route.slice(0, index + 1),
            { ...a, [axis]: a[axis] + offset },
            { ...b, [axis]: b[axis] + offset },
            ...route.slice(index + 1)
        ];
    }
    const normalized = normalizeResult(result);
    if (normalized.length <= simplifyExact(route).length) {
        throw new Error('この区間には指定した幅の折れを追加できません');
    }
    return normalized;
}

/** 選択区間近傍の2中間点を除き、必要なら元の出発方向のL字で接続する。 */
export function removeManualRouteBends(route, index) {
    segmentIsHorizontal(route, index);
    if (route.length < 4) throw new Error('この経路には削除できる折れがありません');
    const first = Math.max(1, Math.min(index, route.length - 3));
    const before = route[first - 1];
    const after = route[first + 2];
    const result = route.slice(0, first);
    if (before.x !== after.x && before.y !== after.y) {
        const departureHorizontal = before.y === route[first].y;
        result.push(departureHorizontal ?
            { x: after.x, y: before.y } : { x: before.x, y: after.y });
    }
    result.push(...route.slice(first + 2));
    const normalized = normalizeResult(result);
    if (normalized.length >= simplifyExact(route).length) {
        throw new Error('この経路には削除できる折れがありません');
    }
    return normalized;
}
