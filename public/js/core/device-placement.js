/** Read-only rack destinations. Shelf members never become persisted direct mounts. */
export function getRackDeviceMounts(data) {
    const shelves = new Map((data.rackShelves || data.rack_shelves || []).map(row => [Number(row.id), row]));
    return [
        ...(data.rackMounts || data.rack_mounts || []),
        ...(data.rackShelfDevices || data.rack_shelf_devices || []).flatMap(row => {
            const shelf = shelves.get(Number(row.shelf_id));
            return shelf ? [{ ...shelf, width_slot: 'full', device_id: Number(row.device_id),
                shelf_id: Number(shelf.id), shelf_name: shelf.name, sort_order: Number(row.sort_order) }] : [];
        })
    ];
}

export function getPlacedDeviceIds(placements = [], rackMounts = []) {
    return new Set([...(Array.isArray(placements) ? placements : []),
        ...(Array.isArray(rackMounts) ? rackMounts : [])]
        .map(placement => Number(placement?.device_id))
        .filter(id => Number.isInteger(id) && id > 0));
}

export function getUnplacedDeviceIds(devices = [], placements = [], rackMounts = []) {
    const placed = getPlacedDeviceIds(placements, rackMounts);
    return (Array.isArray(devices) ? devices : [])
        .map(device => Number(device?.id))
        .filter(id => Number.isInteger(id) && id > 0 && !placed.has(id));
}

/** Rack mounts are destinations, never synthetic XY placements. */
export function getDeviceDestinations(deviceId, placements = [], rackMounts = [], views = []) {
    const viewById = new Map(views.map(view => [Number(view.id), view]));
    return [
        ...placements.filter(row => Number(row.device_id) === Number(deviceId))
            .map(placement => ({ placement, view: viewById.get(Number(placement.view_id)), kind: 'xy' })),
        ...rackMounts.filter(row => Number(row.device_id) === Number(deviceId))
            .map(mount => ({ mount, view: viewById.get(Number(mount.view_id)), kind: 'rack' }))
    ].filter(item => item.view && (item.kind === 'rack' ? item.view.view_type === 'rack' : item.view.view_type !== 'rack'));
}
