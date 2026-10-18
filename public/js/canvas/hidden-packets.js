import { eventBus } from '../core/event-bus.js';
import { getTopModalContainer } from '../core/modal-focus.js';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const DURATION_MS = 5000;
const MAX_ROUTES = 32;
const PACKETS_PER_ROUTE = 3;
const PACKET_COLORS = ['#f87171', '#fb923c', '#fde047', '#4ade80', '#22d3ee', '#c084fc'];
const SCREEN_RADIUS_PX = 5;
const START_MESSAGE = 'Easter packet sequence initiated.\nWatch the topology for a moment...';
const NO_ROUTES_MESSAGE = 'No routes found. The packets are taking a coffee break.';
const REDUCED_MOTION_MESSAGE = '動きを減らす設定のため演出を省略しました';

/** A local, display-only effect. Never writes to route geometry or application state. */
export function createPacketEffect({ overlay }) {
    let group = null;
    let frameId = null;
    let timerId = null;
    let observer = null;
    let motion = null;
    let routes = [];
    let unsubscribeRender = null;
    let unsubscribeView = null;
    let unsubscribeTransform = null;

    function stop() {
        if (frameId !== null) window.cancelAnimationFrame(frameId);
        if (timerId !== null) window.clearTimeout(timerId);
        frameId = null;
        timerId = null;
        observer?.disconnect();
        observer = null;
        motion?.removeEventListener('change', onMotionChange);
        motion = null;
        unsubscribeRender?.();
        unsubscribeView?.();
        unsubscribeTransform?.();
        unsubscribeRender = null;
        unsubscribeView = null;
        unsubscribeTransform = null;
        window.removeEventListener('beforeprint', stop);
        window.removeEventListener('pagehide', stop);
        group?.remove();
        group = null;
        routes = [];
    }

    function onMotionChange(event) {
        if (event.matches) stop();
    }

    function syncPacketSize() {
        const matrix = group?.parentElement?.getScreenCTM();
        if (!matrix) return;
        const scale = Math.hypot(matrix.a, matrix.b);
        if (!Number.isFinite(scale) || scale <= 0) return;
        const radius = String(SCREEN_RADIUS_PX / scale);
        for (const route of routes) {
            for (const circle of route.circles) circle.setAttribute('r', radius);
        }
    }

    function isCurrent(layer) {
        const topModal = getTopModalContainer();
        return group?.parentElement === layer && layer.isConnected && overlay?.isConnected &&
            !overlay.hidden && !overlay.closest('[hidden], .hidden') &&
            (!topModal || topModal === overlay) &&
            routes.every(({ path }) => layer.contains(path));
    }

    function start() {
        stop();
        const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
        if (preference.matches) return REDUCED_MOTION_MESSAGE;
        const layer = document.getElementById('link-layer');
        if (!layer || !overlay?.isConnected || overlay.hidden) return NO_ROUTES_MESSAGE;

        const candidates = layer.querySelectorAll('.topology-link-hit');
        for (let index = 0; index < Math.min(candidates.length, MAX_ROUTES); index++) {
            const path = candidates[index];
            try {
                const length = path.getTotalLength();
                if (!Number.isFinite(length) || length <= 0) continue;
                const point = path.getPointAtLength(0);
                if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
                routes.push({ path, length, circles: [] });
            } catch {
                // Detached or otherwise unmeasurable SVG geometry is not a route to animate.
            }
        }
        if (!routes.length) return NO_ROUTES_MESSAGE;

        group = document.createElementNS(SVG_NAMESPACE, 'g');
        group.setAttribute('class', 'hidden-packet-effect');
        group.setAttribute('pointer-events', 'none');
        group.setAttribute('aria-hidden', 'true');
        for (let index = 0; index < routes.length; index++) {
            const route = routes[index];
            for (let packet = 0; packet < PACKETS_PER_ROUTE; packet++) {
                const circle = document.createElementNS(SVG_NAMESPACE, 'circle');
                circle.setAttribute('class', 'hidden-packet-dot');
                circle.setAttribute('r', String(SCREEN_RADIUS_PX));
                circle.setAttribute('pointer-events', 'none');
                circle.setAttribute('aria-hidden', 'true');
                circle.style.color = PACKET_COLORS[(index * PACKETS_PER_ROUTE + packet) % PACKET_COLORS.length];
                const phase = (index / routes.length + packet / PACKETS_PER_ROUTE) % 1;
                const point = route.path.getPointAtLength(phase * route.length);
                circle.setAttribute('cx', String(point.x));
                circle.setAttribute('cy', String(point.y));
                route.circles.push(circle);
                group.appendChild(circle);
            }
        }
        layer.appendChild(group);
        if (!isCurrent(layer)) {
            stop();
            return NO_ROUTES_MESSAGE;
        }
        syncPacketSize();

        motion = preference;
        motion.addEventListener('change', onMotionChange);
        unsubscribeRender = eventBus.on('canvas:render-complete', stop);
        unsubscribeView = eventBus.on('view:switch', stop);
        unsubscribeTransform = eventBus.on('canvas:view-transformed', syncPacketSize);
        window.addEventListener('beforeprint', stop);
        window.addEventListener('pagehide', stop);
        observer = new MutationObserver(() => {
            if (!isCurrent(layer)) stop();
        });
        // Observe only lifecycle attributes, not the circle positions updated each frame.
        observer.observe(document.body, {
            childList: true, subtree: true, attributes: true,
            attributeFilter: ['hidden', 'class', 'style', 'inert']
        });

        const startedAt = window.performance.now();
        function animate(now) {
            frameId = null;
            if (!isCurrent(layer) || now - startedAt >= DURATION_MS) {
                stop();
                return;
            }
            try {
                for (let index = 0; index < routes.length; index++) {
                    const route = routes[index];
                    for (let packet = 0; packet < route.circles.length; packet++) {
                        const progress = ((now - startedAt) / 1400 + index / routes.length +
                            packet / PACKETS_PER_ROUTE) % 1;
                        const point = route.path.getPointAtLength(progress * route.length);
                        route.circles[packet].setAttribute('cx', String(point.x));
                        route.circles[packet].setAttribute('cy', String(point.y));
                    }
                }
            } catch {
                stop();
                return;
            }
            frameId = window.requestAnimationFrame(animate);
        }
        timerId = window.setTimeout(stop, DURATION_MS);
        frameId = window.requestAnimationFrame(animate);
        return START_MESSAGE;
    }

    return { start, stop };
}
