export function getPlacedDeviceIds(placements = []) {
    return new Set((Array.isArray(placements) ? placements : [])
        .map(placement => Number(placement?.device_id))
        .filter(id => Number.isInteger(id) && id > 0));
}

export function getUnplacedDeviceIds(devices = [], placements = []) {
    const placed = getPlacedDeviceIds(placements);
    return (Array.isArray(devices) ? devices : [])
        .map(device => Number(device?.id))
        .filter(id => Number.isInteger(id) && id > 0 && !placed.has(id));
}
