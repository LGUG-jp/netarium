import { DEFAULT_VIEW_SCALE } from '../core/constants.js';
import { clampNumber } from '../core/utils.js';

export function calculateOriginFit(rect, bounds, viewState) {
    const padding = 8;
    const minX = Math.min(0, bounds.minX);
    const minY = Math.min(0, bounds.minY);
    const width = Math.max(1, Math.max(0, bounds.maxX) - minX);
    const height = Math.max(1, Math.max(0, bounds.maxY) - minY);
    const scale = clampNumber(Math.min(
        Math.max(1, rect.width - padding) / width,
        Math.max(1, rect.height - padding) / height,
        DEFAULT_VIEW_SCALE
    ), viewState.minScale, viewState.maxScale);
    return { scale, panX: minX < 0 ? -minX * scale : 0, panY: minY < 0 ? -minY * scale : 0 };
}
