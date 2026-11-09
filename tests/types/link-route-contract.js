// @ts-check
// 型チェック専用。実行しない。不正な呼出しを受理すると TS2578 で失敗する。
import { normalizeLinkRouteData } from '../../public/js/core/link-route-data.js';
import { buildManualLinkRoute, normalizeManualRoute, simplifyExact } from '../../public/js/canvas/manual-link-route.js';

/** @type {readonly import('../../public/js/core/link-route-data.js').RoutePoint[]} */
const points = Object.freeze([Object.freeze({ x: 0, y: 0 }), Object.freeze({ x: 10, y: 0 })]);
const normalized = normalizeLinkRouteData({ route_mode: 'manual', manual_route: points });
const route = buildManualLinkRoute({ x: 0, y: 0 }, { x: 10, y: 10 }, normalizeManualRoute(points));
if (route !== null) simplifyExact(route);
normalized.manual_route.push({ x: 20, y: 0 });
normalizeLinkRouteData({});
buildManualLinkRoute(null, undefined, []);

// @ts-expect-error 経路モードの綴り違いを拒否する。
normalizeLinkRouteData({ route_mode: 'manul', manual_route: [] });
// @ts-expect-error API座標の文字列と数値を取り違えない。
normalizeLinkRouteData({ route_mode: 'manual', manual_route: [{ x: '10', y: 0 }] });
// @ts-expect-error 中間点は配列で渡す。
normalizeManualRoute({ x: 0, y: 0 });
// @ts-expect-error 点のy座標欠落を拒否する。
simplifyExact([{ x: 0 }]);
// @ts-expect-error 端点の座標も数値で渡す。
buildManualLinkRoute({ x: 0, y: '0' }, { x: 10, y: 10 }, []);
/** @type {string} */
// @ts-expect-error 正規化後の座標は文字列ではない。
const coordinate = normalized.manual_route[0].x;
// @ts-expect-error 無効な端点ではnullを返すため、判定前の配列アクセスを拒否する。
route.map(point => point.x);
