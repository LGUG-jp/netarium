import { normalizeText } from './utils.js';

export const DEFAULT_CANVAS_NOTE = Object.freeze({
    text: '',
    x: 0,
    y: 0,
    width: 220,
    height: 120,
    background_color: '#FFF3B0',
    background_opacity: 0.85,
    text_color: '#263238',
    font_size: 14
});

export const CANVAS_NOTE_LIMITS = Object.freeze({
    minWidth: 120,
    maxWidth: 2000,
    minHeight: 60,
    maxHeight: 2000,
    minFontSize: 12,
    maxFontSize: 32,
    minOpacity: 0.2,
    maxOpacity: 1,
    maxTextLength: 1000
});

// ラックはXY座標を編集しないため、UIから到達しない予約座標の完全一致だけで
// 新しい中・下段を識別する。旧メモの自由座標やU数から所属を推測・移行しない。
// 13桁の整数を使い、PDOの浮動小数点→文字列変換でも丸められないようにする。
export const RACK_NOTE_REGION_X = 2 ** 40;
export const RACK_NOTE_REGIONS = Object.freeze([
    Object.freeze({ key: 'upper', label: '上段', y: 0 }),
    Object.freeze({ key: 'middle', label: '中段', y: 1 }),
    Object.freeze({ key: 'lower', label: '下段', y: 2 })
]);
export function getRackNoteRegion(note) {
    return (Number(note.x) === RACK_NOTE_REGION_X
        ? RACK_NOTE_REGIONS.find(region => region.y !== 0 && Number(note.y) === region.y)
        : null) || RACK_NOTE_REGIONS[0];
}

const colorPattern = /^#[0-9A-F]{6}$/i;
const boundedNumber = (value, fallback, min, max = Infinity) => {
    const number = value == null ? fallback : Number(value);
    return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
};
const normalizedColor = (value, fallback) =>
    typeof value === 'string' && colorPattern.test(value) ? value.toUpperCase() : fallback;

export function normalizeCanvasNote(note) {
    return {
        id: Number(note.id),
        view_id: Number(note.view_id),
        text: normalizeText(note.text),
        x: boundedNumber(note.x, DEFAULT_CANVAS_NOTE.x, 0),
        y: boundedNumber(note.y, DEFAULT_CANVAS_NOTE.y, 0),
        width: boundedNumber(note.width, DEFAULT_CANVAS_NOTE.width, CANVAS_NOTE_LIMITS.minWidth, CANVAS_NOTE_LIMITS.maxWidth),
        height: boundedNumber(note.height, DEFAULT_CANVAS_NOTE.height, CANVAS_NOTE_LIMITS.minHeight, CANVAS_NOTE_LIMITS.maxHeight),
        background_color: normalizedColor(note.background_color, DEFAULT_CANVAS_NOTE.background_color),
        background_opacity: boundedNumber(note.background_opacity, DEFAULT_CANVAS_NOTE.background_opacity,
            CANVAS_NOTE_LIMITS.minOpacity, CANVAS_NOTE_LIMITS.maxOpacity),
        text_color: normalizedColor(note.text_color, DEFAULT_CANVAS_NOTE.text_color),
        font_size: boundedNumber(note.font_size, DEFAULT_CANVAS_NOTE.font_size,
            CANVAS_NOTE_LIMITS.minFontSize, CANVAS_NOTE_LIMITS.maxFontSize)
    };
}

export function toSaveCanvasNote(note) {
    return {
        id: Number(note.id),
        view_id: Number(note.view_id),
        text: normalizeText(note.text),
        x: Number(note.x),
        y: Number(note.y),
        width: Number(note.width),
        height: Number(note.height),
        background_color: normalizeText(note.background_color).toUpperCase(),
        background_opacity: Number(note.background_opacity),
        text_color: normalizeText(note.text_color).toUpperCase(),
        font_size: Number(note.font_size)
    };
}

export function validateCanvasNote(note) {
    const id = Number(note.id);
    if (!Number.isInteger(id) || id <= 0) throw new Error('メモIDが不正です');
    const viewId = Number(note.view_id);
    if (!Number.isInteger(viewId) || viewId <= 0) throw new Error(`メモID ${id}: ビューIDが不正です`);
    if (typeof note.text !== 'string') throw new Error(`メモID ${id}: 本文は文字列で入力してください`);
    let textLength = 0;
    for (let offset = 0; offset < note.text.length; offset++) {
        if (note.text.codePointAt(offset) > 0xFFFF) offset++;
        if (++textLength > CANVAS_NOTE_LIMITS.maxTextLength) {
            throw new Error(`メモID ${id}: 本文は${CANVAS_NOTE_LIMITS.maxTextLength}文字以内で入力してください`);
        }
    }
    for (const [key, min, max] of [
        ['x', 0, Infinity], ['y', 0, Infinity],
        ['width', CANVAS_NOTE_LIMITS.minWidth, CANVAS_NOTE_LIMITS.maxWidth],
        ['height', CANVAS_NOTE_LIMITS.minHeight, CANVAS_NOTE_LIMITS.maxHeight],
        ['background_opacity', CANVAS_NOTE_LIMITS.minOpacity, CANVAS_NOTE_LIMITS.maxOpacity],
        ['font_size', CANVAS_NOTE_LIMITS.minFontSize, CANVAS_NOTE_LIMITS.maxFontSize]
    ]) {
        const number = Number(note[key]);
        if (!Number.isFinite(number) || number < min || number > max) {
            throw new Error(`メモID ${id}: ${key}の値が不正です`);
        }
    }
    if (!colorPattern.test(note.background_color) || !colorPattern.test(note.text_color)) {
        throw new Error(`メモID ${id}: 色は#RRGGBB形式で指定してください`);
    }
}
