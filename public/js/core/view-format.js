import { normalizeText } from './utils.js';
import { appState } from './state.js';
import { viewHierarchyPath } from './building-hierarchy.js';

export function buildViewOptionLabel(view, data = appState) {
    const name = normalizeText(view.name).trim() || `ビューID ${view.id}`;
    return `${viewHierarchyPath(view, data)} / ${name}`;
}
