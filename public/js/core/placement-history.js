import { appState } from './state.js';
import { eventBus } from './event-bus.js';
import { mappedResourceId } from './resource-save.js';

const MAX_ENTRIES = 20;
const histories = new Map();
let activeDrags = 0;
const notify = () => eventBus.emit('placement-history:changed');

export function beginCanvasHistoryDrag() {
    let ended = false;
    activeDrags++;
    notify();
    return () => {
        if (ended) return;
        ended = true;
        activeDrags = Math.max(0, activeDrags - 1);
        notify();
    };
}

export function isCanvasHistoryDragActive() {
    return activeDrags !== 0 || appState.isRangeSelecting;
}

export function recordPlacementMove(viewId, moves) {
    if (!moves.some(({ before, after }) => Math.hypot(after.x - before.x, after.y - before.y) >= 1)) return false;
    viewId = Number(viewId);
    let history = histories.get(viewId);
    if (!history) histories.set(viewId, history = { undo: [], redo: [] });
    history.redo.length = 0;
    history.undo.push(moves);
    if (history.undo.length > MAX_ENTRIES) history.undo.shift();
    notify();
    return true;
}

function indexTargets(viewId) {
    const placements = new Map(), racks = new Map();
    for (const row of appState.placements) {
        if (Number(row.view_id) === viewId) placements.set(Number(row.id), row);
    }
    for (const row of appState.floorRackPlacements) {
        if (Number(row.floor_view_id) === viewId) racks.set(Number(row.rack_view_id), row);
    }
    return move => move.placementId == null ? racks.get(move.rackViewId) : placements.get(move.placementId);
}

function sameCoordinate(current, expected) {
    const value = Number(current);
    // PDO が SQLite の REAL 列に保存する際の桁落ちだけを、座標の変更と区別する。
    return value === expected || Math.abs(value - expected) <= Math.min(1e-6, Math.abs(expected) * 5e-14);
}

function prune(stack, targetFor, expected, next) {
    // 上から順に適用した仮の座標で照合し、同じ対象を動かした過去の履歴も検証する。
    const positions = new Map();
    const invalidated = new Set();
    for (let i = stack.length - 1; i >= 0; i--) {
        const moves = stack[i];
        let valid = true;
        for (const move of moves) {
            const row = targetFor(move);
            const current = positions.get(row) ?? row;
            if (!row || invalidated.has(row) || !sameCoordinate(current.x, move[expected].x) ||
                !sameCoordinate(current.y, move[expected].y)) {
                if (row) invalidated.add(row);
                valid = false;
            }
        }
        if (!valid) {
            stack.splice(i, 1);
            continue;
        }
        for (const move of moves) positions.set(targetFor(move), move[next]);
    }
}

function validHistory(viewId) {
    const history = histories.get(viewId);
    if (!history || isCanvasHistoryDragActive()) return null;
    const targetFor = indexTargets(viewId);
    prune(history.undo, targetFor, 'after', 'before');
    prune(history.redo, targetFor, 'before', 'after');
    if (!history.undo.length && !history.redo.length) histories.delete(viewId);
    return { history, targetFor };
}

export function getPlacementHistoryAvailability(viewId) {
    const current = validHistory(Number(viewId));
    return { undo: Boolean(current?.history.undo.length), redo: Boolean(current?.history.redo.length) };
}

export function applyPlacementHistory(viewId, direction) {
    const current = validHistory(Number(viewId));
    const moves = current?.history[direction].pop();
    if (!moves) return false;
    const undoing = direction === 'undo';
    const next = undoing ? 'before' : 'after';
    for (const move of moves) Object.assign(current.targetFor(move), move[next]);
    current.history[undoing ? 'redo' : 'undo'].push(moves);
    return true;
}

eventBus.on('resources:ids-remapped', maps => {
    if (!histories.size || (!Object.keys(maps.views ?? {}).length && !Object.keys(maps.placements ?? {}).length)) return;
    // 採番先が別ビューの旧IDでも上書きしないよう、旧キーを退避してから再登録する。
    const previous = [...histories];
    histories.clear();
    for (const [id, history] of previous) {
        histories.set(mappedResourceId(maps.views, id), history);
        for (const stack of [history.undo, history.redo]) {
            for (const moves of stack) {
                for (const move of moves) {
                    if (move.placementId != null) move.placementId = mappedResourceId(maps.placements, move.placementId);
                    else move.rackViewId = mappedResourceId(maps.views, move.rackViewId);
                }
            }
        }
    }
    notify();
});
eventBus.on('resources:reloaded', () => { histories.clear(); notify(); });
eventBus.on('resource:reloaded', ({ kind, id }) => {
    if (kind === 'views' && histories.delete(Number(id))) notify();
});
