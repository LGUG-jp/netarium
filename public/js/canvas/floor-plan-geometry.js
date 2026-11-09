// x/yは未回転の左上座標。描画・操作・印刷は同じ中心回転を使用する。
export function getFloorPlanCorners(plan) {
    const width = Number(plan.image_width) * Number(plan.scale);
    const height = Number(plan.image_height) * Number(plan.scale);
    const angle = Number(plan.rotation ?? 0) * Math.PI / 180;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const centerX = Number(plan.x) + width / 2, centerY = Number(plan.y) + height / 2;
    const point = (x, y) => ({ x: centerX + cos * x - sin * y, y: centerY + sin * x + cos * y });
    return { nw: point(-width / 2, -height / 2), ne: point(width / 2, -height / 2),
        se: point(width / 2, height / 2), sw: point(-width / 2, height / 2) };
}

export function getFloorPlanBounds(plan) {
    const corners = Object.values(getFloorPlanCorners(plan));
    return { minX: Math.min(...corners.map(point => point.x)), minY: Math.min(...corners.map(point => point.y)),
        maxX: Math.max(...corners.map(point => point.x)), maxY: Math.max(...corners.map(point => point.y)) };
}
