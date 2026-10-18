import { normalizeText } from './utils.js';

export function buildViewOptionLabel(view) {
    const parts = [];
    const facility = normalizeText(view.facility).trim();
    const floor = normalizeText(view.floor).trim();
    const name =
        normalizeText(view.name).trim() ||
        `ビューID ${view.id}`;

    if (facility) {
        parts.push(facility);
    }

    if (floor) {
        parts.push(floor);
    }

    /*
     * 名称が施設・フロアと同じ場合でも、
     * ビューを識別できるよう必ず最後に表示する。
     */
    parts.push(name);

    return parts.join(' / ');
}
