import { appState } from './state.js';

// UI状態色とは独立した、接続分類専用の固定パレット。
export const LINK_SYSTEM_COLORS = Object.freeze([
    { key: 'indigo', name: '藍', color: '#4B5BA9' },
    { key: 'teal', name: '青緑', color: '#167D8D' },
    { key: 'violet', name: '紫', color: '#8054A3' },
    { key: 'cyan', name: '水色', color: '#257FA8' },
    { key: 'slate', name: '灰青', color: '#526879' },
    { key: 'brown', name: '茶', color: '#89613E' },
    { key: 'magenta', name: '赤紫', color: '#A34F87' },
    { key: 'olive', name: 'オリーブ', color: '#747C32' }
].map(Object.freeze));

export function getLinkSystem(systemId, systems = appState.linkSystems) {
    if (systemId == null) return null;
    if (systems instanceof Map) return systems.get(Number(systemId)) || null;
    return systems.find(system => Number(system.id) === Number(systemId)) || null;
}

export function getLinkColor(link, systems = appState.linkSystems) {
    const system = getLinkSystem(link.system_id, systems);
    const entry = LINK_SYSTEM_COLORS.find(color => color.key === system?.color_key);
    return entry ? `var(--link-system-${entry.key}, ${entry.color})` : 'var(--link-default-color, rgba(71,85,105,.72))';
}

export function syncLinkSystemSwatch(swatch, value) {
    if (!swatch) return;
    swatch.style.backgroundColor = getLinkColor({ system_id: value === '' ? null : value });
}
