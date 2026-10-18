import { eventBus } from './event-bus.js';

const STORAGE_KEY = 'netarium.linkCrossingStyle';
let linkCrossingStyle = 'bridge';

function normalizeStyle(style) {
    return style === 'gap' ? 'gap' : 'bridge';
}

// 構成データとは独立した、このブラウザーだけの表示設定。
export function getLinkCrossingStyle() {
    return linkCrossingStyle;
}

export function initializeLinkDisplaySettings() {
    try {
        linkCrossingStyle = normalizeStyle(
            window.localStorage.getItem(STORAGE_KEY)
        );
    } catch {
        // localStorage自体へのアクセスが拒否される場合も初期値を使う。
        linkCrossingStyle = 'bridge';
    }
    return linkCrossingStyle;
}

export function setLinkCrossingStyle(style) {
    let nextStyle = normalizeStyle(style);
    try {
        window.localStorage.setItem(STORAGE_KEY, nextStyle);
    } catch {
        nextStyle = 'bridge';
    }
    linkCrossingStyle = nextStyle;
    eventBus.emit('canvas:render-links');
    return linkCrossingStyle;
}
