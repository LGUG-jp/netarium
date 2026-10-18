import { DEFAULT_DEVICE_HEIGHT, DEFAULT_DEVICE_WIDTH } from '../core/constants.js';
import { routeTopologyLinks } from './link-router.js';
import { buildManualLinkRoute } from './manual-link-route.js';

/** 保存座標を変えず、現在の機器中心から手動・自動の描画経路を一括解決する。 */
export function resolveTopologyLinkRoutes(links, placements) {
    if (!Array.isArray(links) || !Array.isArray(placements) || links.length === 0) {
        return new Map();
    }

    const placementByDeviceId = new Map();
    for (const placement of placements) {
        if (placement && placement.device_id != null) {
            placementByDeviceId.set(Number(placement.device_id), placement);
        }
    }

    const fixedRoutes = new Map();
    for (const link of links) {
        if (!link || link.route_mode !== 'manual' || link.from_id == null || link.to_id == null) continue;
        const from = placementByDeviceId.get(Number(link.from_id));
        const to = placementByDeviceId.get(Number(link.to_id));
        if (!from || !to) continue;
        const start = {
            x: Number(from.x) + (Number(from.width) || DEFAULT_DEVICE_WIDTH) / 2,
            y: Number(from.y) + (Number(from.height) || DEFAULT_DEVICE_HEIGHT) / 2
        };
        const end = {
            x: Number(to.x) + (Number(to.width) || DEFAULT_DEVICE_WIDTH) / 2,
            y: Number(to.y) + (Number(to.height) || DEFAULT_DEVICE_HEIGHT) / 2
        };
        try {
            const route = buildManualLinkRoute(start, end, link.manual_route);
            if (route) fixedRoutes.set(Number(link.id), route);
        } catch {
            // 壊れた手動経路だけを既存autoへ戻し、他リンクの描画は継続する。
        }
    }

    return routeTopologyLinks(links, placements, fixedRoutes);
}
