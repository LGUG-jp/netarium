import { eventBus } from './event-bus.js';

const STORAGE_KEY = 'netarium.linkCrossingStyle';
const CONNECTION_HIGHLIGHT_STORAGE_KEY = 'netarium.connectionHighlightEnabled';
let linkCrossingStyle = 'bridge';
let connectionHighlightEnabled = false;

function normalizeStyle(style) {
    return style === 'gap' ? 'gap' : 'bridge';
}

// 構成データとは独立した、このブラウザーだけの表示設定。
export function getLinkCrossingStyle() {
    return linkCrossingStyle;
}

export function getConnectionHighlightEnabled() {
    return connectionHighlightEnabled;
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
    try {
        connectionHighlightEnabled =
            window.localStorage.getItem(CONNECTION_HIGHLIGHT_STORAGE_KEY) === 'true';
    } catch {
        connectionHighlightEnabled = false;
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

export function setConnectionHighlightEnabled(enabled) {
    let nextEnabled = enabled === true;
    try {
        window.localStorage.setItem(CONNECTION_HIGHLIGHT_STORAGE_KEY, String(nextEnabled));
    } catch {
        nextEnabled = false;
    }
    connectionHighlightEnabled = nextEnabled;
    eventBus.emit('canvas:render');
    return connectionHighlightEnabled;
}
