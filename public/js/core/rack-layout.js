export const MAX_RACK_U = 60;

export function toSaveRackSettings(row) {
    return { view_id: Number(row.view_id), total_u: Number(row.total_u), location: String(row.location || '').trim() };
}

export function toSaveRackMount(row) {
    return {
        device_id: Number(row.device_id), view_id: Number(row.view_id), face: row.face,
        start_u: Number(row.start_u), height_u: Number(row.height_u), width_slot: row.width_slot,
        depth: row.depth === undefined ? 'half' : row.depth
    };
}

export function toSaveRackShelf(row) {
    return { id: Number(row.id), view_id: Number(row.view_id), name: String(row.name || '').trim(),
        face: row.face, start_u: Number(row.start_u), height_u: Number(row.height_u), depth: row.depth };
}

export function toSaveRackShelfDevice(row) {
    return { device_id: Number(row.device_id), shelf_id: Number(row.shelf_id), sort_order: Number(row.sort_order) };
}

export function rackShelfOccupancy(row) { return { ...row, width_slot: 'full' }; }

// 保存値は前面から見た物理的左右。背面での入力・描画時だけ反転する。
export function rackDisplaySlot(slot, face) {
    if (face !== 'rear' || slot === 'full') return slot;
    return slot === 'left' ? 'right' : 'left';
}

export function rackFaces(face) {
    return face === 'both' ? ['front', 'rear'] : [face];
}

export function rackSlots(slot) {
    return slot === 'full' ? ['left', 'right'] : [slot];
}

// 搭載面と占有面は別。全奥行きは反対面の同じ物理左右も塞ぐ。
export function rackOccupiedFaces(mount) {
    return mount.depth === 'full' ? ['front', 'rear'] : rackFaces(mount.face);
}

export function rackOverlap(first, second) {
    if (Number(first.view_id) !== Number(second.view_id)) return null;
    const face = rackOccupiedFaces(first).find(value => rackOccupiedFaces(second).includes(value));
    const firstSlot = first.width_slot || 'full', secondSlot = second.width_slot || 'full';
    if (!face || (firstSlot !== 'full' && secondSlot !== 'full' && firstSlot !== secondSlot)) return null;
    const u = Math.max(Number(first.start_u), Number(second.start_u));
    if (u > Math.min(Number(first.start_u) + Number(first.height_u) - 1, Number(second.start_u) + Number(second.height_u) - 1)) return null;
    return { face, u, slot: firstSlot === 'full' ? secondSlot : firstSlot };
}

export function validateRackLayout(data) {
    const settings = data.rackSettings || data.rack_settings || [];
    const mounts = data.rackMounts || data.rack_mounts || [];
    const shelves = data.rackShelves || data.rack_shelves || [];
    const shelfDevices = data.rackShelfDevices || data.rack_shelf_devices || [];
    const views = new Map(data.views.map(row => [Number(row.id), row]));
    const devices = new Set(data.devices.map(row => Number(row.id)));
    const racks = new Map();
    for (const row of settings) {
        const { view_id: id, total_u: total, location } = toSaveRackSettings(row);
        if (!Number.isSafeInteger(id) || views.get(id)?.view_type !== 'rack' || racks.has(id)) {
            throw new Error('ラック設定のビューが不正または重複しています');
        }
        if (!Number.isInteger(total) || total < 1 || total > MAX_RACK_U) throw new Error(`総U数は1〜${MAX_RACK_U}の整数で入力してください`);
        if (Array.from(location).length > 150) throw new Error('ラックの設置場所は150文字以内で入力してください');
        racks.set(id, total);
    }
    for (const view of views.values()) {
        if (view.view_type === 'rack' && !racks.has(Number(view.id))) throw new Error('ラック設定がありません');
    }
    const occupied = new Set();
    const mounted = new Set();
    const shelfIds = new Set();
    for (const raw of shelves) {
        const shelf = toSaveRackShelf(raw);
        if (!Number.isSafeInteger(shelf.id) || shelf.id === 0 || shelfIds.has(shelf.id)) throw new Error('棚板IDが不正または重複しています');
        if (!shelf.name || Array.from(shelf.name).length > 100) throw new Error('棚板名は1〜100文字で入力してください');
        if (!['front', 'rear'].includes(shelf.face)) throw new Error('棚板の面が不正です');
        if (!['half', 'full'].includes(shelf.depth)) throw new Error('棚板の奥行きは半分・全体から選択してください');
        shelfIds.add(shelf.id);
    }
    for (const raw of [...mounts, ...shelves.map(rackShelfOccupancy)]) {
        const row = toSaveRackMount(raw);
        const isShelf = raw.device_id === undefined;
        if (!isShelf && (!Number.isSafeInteger(row.device_id) || !devices.has(row.device_id) || mounted.has(row.device_id))) {
            throw new Error('搭載機器が存在しないか、同じ機器を複数のラックへ搭載しています');
        }
        const total = racks.get(row.view_id);
        if (!total) throw new Error('搭載先のラックが存在しません');
        if (!['front', 'rear', 'both'].includes(row.face) || !['full', 'left', 'right'].includes(row.width_slot) ||
            (row.face === 'both' && row.width_slot !== 'full')) throw new Error('搭載面・横幅が不正です（前後占有は全幅のみ）');
        if (!['half', 'full'].includes(row.depth)) throw new Error('奥行きは半分・全体から選択してください');
        if (!Number.isInteger(row.start_u) || !Number.isInteger(row.height_u) || row.start_u < 1 || row.height_u < 1 ||
            row.start_u + row.height_u - 1 > total) throw new Error('開始U・占有Uはラック内に収まる正の整数で入力してください');
        for (const face of rackOccupiedFaces(row)) {
            for (let u = row.start_u; u < row.start_u + row.height_u; u++) {
                for (const slot of rackSlots(row.width_slot)) {
                    const key = `${row.view_id}:${face}:${u}:${slot}`;
                    if (occupied.has(key)) throw new Error(`搭載位置が重複しています（${face === 'front' ? '前面' : '背面'} ${u}U）`);
                    occupied.add(key);
                }
            }
        }
        if (!isShelf) mounted.add(row.device_id);
    }
    const orders = new Set();
    for (const raw of shelfDevices) {
        const row = toSaveRackShelfDevice(raw);
        if (!devices.has(row.device_id) || mounted.has(row.device_id)) throw new Error('同じ機器の棚板・ラックへの二重所属はできません');
        if (!shelfIds.has(row.shelf_id)) throw new Error('所属先の棚板が存在しません');
        if (!Number.isSafeInteger(row.sort_order) || row.sort_order < 0 || orders.has(`${row.shelf_id}:${row.sort_order}`)) throw new Error('棚板内の順序が不正または重複しています');
        mounted.add(row.device_id); orders.add(`${row.shelf_id}:${row.sort_order}`);
    }
    for (const kind of ['placements', 'links', 'floorPlans', 'floor_plans']) {
        if ((data[kind] || []).some(row => racks.has(Number(row.view_id)))) throw new Error('ラックにXY配置・接続・図面は保存できません');
    }
}

export function rackUsage(totalU, mounts, face, shelves = [], shelfDevices = []) {
    const rows = Array.from({ length: totalU }, () => new Set());
    for (const mount of [...mounts, ...shelves.map(rackShelfOccupancy)]) {
        if (!rackOccupiedFaces(mount).includes(face)) continue;
        for (let u = mount.start_u; u < Number(mount.start_u) + Number(mount.height_u); u++) {
            for (const slot of rackSlots(mount.width_slot)) rows[u - 1]?.add(slot);
        }
    }
    const result = rows.reduce((result, slots) => {
        result[slots.size === 0 ? 'empty' : slots.size === 1 ? 'half' : 'used']++;
        return result;
    }, { empty: 0, half: 0, used: 0 });
    if (arguments.length > 3) {
        const shelfIds = new Set(shelves.filter(row => rackFaces(row.face).includes(face)).map(row => Number(row.id)));
        result.deviceCount = new Set([
            ...mounts.filter(row => rackFaces(row.face).includes(face)).map(row => Number(row.device_id)),
            ...shelfDevices.filter(row => shelfIds.has(Number(row.shelf_id))).map(row => Number(row.device_id))
        ]).size;
    }
    return result;
}
