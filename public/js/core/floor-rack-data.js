/** Floor symbols reference existing rack views; they are never inventory devices. */
export const floorRackPlacements = data => data.floorRackPlacements || data.floor_rack_placements || [];

/** A rack's own floor limits new placements, not existing references. */
export function canPlaceFloorRack(rack, view) {
    return view?.view_type === 'floor' && (rack.floor_id == null ||
        (view.floor_id != null && Number(rack.floor_id) === Number(view.floor_id)));
}

export function getFloorRackDestination(data, rackViewId) {
    const placement = floorRackPlacements(data).find(row => Number(row.rack_view_id) === Number(rackViewId));
    if (!placement) return null;
    const view = data.views.find(row => row.view_type === 'floor' && Number(row.id) === Number(placement.floor_view_id));
    return view ? { placement, view } : null;
}

export function toSaveFloorRackPlacement(row) {
    return { floor_view_id: Number(row.floor_view_id), rack_view_id: Number(row.rack_view_id),
        x: Number(row.x), y: Number(row.y) };
}

export function validateFloorRackPlacements(data) {
    const views = new Map((data.views || []).map(row => [Number(row.id), row]));
    const placed = new Set();
    for (const raw of floorRackPlacements(data)) {
        const row = toSaveFloorRackPlacement(raw);
        if (!Number.isSafeInteger(row.floor_view_id) || views.get(row.floor_view_id)?.view_type !== 'floor' ||
            !Number.isSafeInteger(row.rack_view_id) || views.get(row.rack_view_id)?.view_type !== 'rack') {
            throw new Error('ラック配置の参照先が不正です。物理配置図とラックを確認してください');
        }
        if (placed.has(row.rack_view_id)) throw new Error('同じラックは物理配置図全体で1か所だけ配置できます');
        if (![row.x, row.y].every(Number.isFinite)) {
            throw new Error('ラック配置の座標は有限数にしてください');
        }
        placed.add(row.rack_view_id);
    }
}
