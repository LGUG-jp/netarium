export const compareHierarchyOrder = (a, b) =>
    Number(a.sort_order) - Number(b.sort_order) || Number(a.id) - Number(b.id);

export function orderedBuildings(data) {
    return [...(data.buildings || [])].sort(compareHierarchyOrder);
}

export function orderedFloors(data, buildingId) {
    return (data.floors || []).filter(row => Number(row.building_id) === Number(buildingId)).sort(compareHierarchyOrder);
}

export function viewHierarchyPath(view, data) {
    const floor = view.floor_id == null ? null : (data.floors || []).find(row => Number(row.id) === Number(view.floor_id));
    const building = floor && (data.buildings || []).find(row => Number(row.id) === Number(floor.building_id));
    return building ? `${building.name} / ${floor.name}` : '未分類';
}

export function populateFloorSelect(select, data, floorId) {
    if (!select) return;
    select.replaceChildren();
    const empty = document.createElement('option');
    empty.value = ''; empty.textContent = '未分類';
    select.appendChild(empty);
    for (const building of orderedBuildings(data)) {
        for (const floor of orderedFloors(data, building.id)) {
            const option = document.createElement('option');
            option.value = String(floor.id);
            option.textContent = `${building.name} / ${floor.name}`;
            select.appendChild(option);
        }
    }
    select.value = floorId == null ? '' : String(floorId);
}

export function sharesPlacementFloor(device, view) {
    return device.floor_id != null && view?.floor_id != null &&
        Number(device.floor_id) === Number(view.floor_id);
}

export function buildHierarchyTree(data) {
    const buildings = orderedBuildings(data).map(row => ({
        key: `building:${row.id}`, kind: 'building', row, children: []
    }));
    const buildingNodes = new Map(buildings.map(node => [Number(node.row.id), node]));
    const floorNodes = new Map();
    for (const row of [...(data.floors || [])].sort(compareHierarchyOrder)) {
        const building = buildingNodes.get(Number(row.building_id));
        if (!building) continue;
        const node = { key: `floor:${row.id}`, kind: 'floor', row, children: [] };
        floorNodes.set(Number(row.id), node);
        building.children.push(node);
    }
    const unclassified = { key: 'unclassified', kind: 'unclassified', row: null, children: [] };
    for (const row of [...(data.views || [])].sort(compareHierarchyOrder)) {
        const owner = row.floor_id == null ? unclassified : floorNodes.get(Number(row.floor_id)) || unclassified;
        owner.children.push({ key: `view:${row.id}`, kind: 'view', row, children: [] });
    }
    return [...buildings, unclassified];
}

export function flattenHierarchyTree(tree, collapsed = new Set()) {
    const entries = [];
    const visit = (nodes, depth) => {
        for (const node of nodes) {
            entries.push({ ...node, depth });
            if (!collapsed.has(node.key)) visit(node.children, depth + 1);
        }
    };
    visit(tree, 0);
    return entries;
}

// 開閉状態は画面ごとに保持し、新しい枝と選択経路だけを同期する。
export function syncHierarchyExpansion(tree, state, selectedKey) {
    const branches = new Set();
    let selectedPath = null;
    const path = [];
    const visit = nodes => {
        for (const node of nodes) {
            path.push(node.key);
            if (node.kind !== 'view') {
                branches.add(node.key);
                if (!state.knownBranches.has(node.key)) state.collapsed.add(node.key);
            }
            if (node.key === selectedKey) selectedPath = [...path];
            visit(node.children);
            path.pop();
        }
    };
    visit(tree);
    for (const key of state.collapsed) {
        if (!branches.has(key)) state.collapsed.delete(key);
    }
    state.knownBranches = branches;
    const signature = selectedPath?.join('/');
    if (signature && signature !== state.selectedPath) {
        for (const key of selectedPath) state.collapsed.delete(key);
        state.selectedPath = signature;
    }
}

export function hierarchyViewEntries(data) {
    return flattenHierarchyTree(buildHierarchyTree(data)).filter(node => node.kind === 'view').map(node => node.row);
}
