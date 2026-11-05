import { parseDirectLink, findDirectLinkTarget } from './direct-link.js';

const STORAGE_KEY = 'netarium.lastViewId';

export function rememberLastView(viewId) {
    if (!Number.isSafeInteger(viewId) || viewId <= 0) return;
    try {
        window.localStorage.setItem(STORAGE_KEY, String(viewId));
    } catch {
        // 保存できないブラウザーでもビュー操作は継続する。
    }
}

// 認証済みの読込結果から、初回描画の前に表示先を決定する。
export function resolveInitialViewId(state, search) {
    const fallback = state.views[0]?.id ?? null;
    const params = new URLSearchParams(search);
    const target = findDirectLinkTarget(parseDirectLink(search), state);
    if (target?.view) return Number(target.view.id);
    // 不正な明示リンクを保存ビューで別の宛先へ転送しない。
    if (params.has('view') || params.has('device') && !target) return fallback;
    try {
        const saved = window.localStorage.getItem(STORAGE_KEY);
        if (!/^[0-9]+$/.test(saved ?? '')) return fallback;
        const id = Number(saved);
        if (Number.isSafeInteger(id) && id > 0 && state.views.some(view => Number(view.id) === id)) return id;
    } catch {
        // localStorageへのアクセス拒否は通常起動を妨げない。
    }
    return fallback;
}
