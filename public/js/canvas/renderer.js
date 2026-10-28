/**
 * Netarium - canvas/renderer.js
 */

import {
    DEFAULT_DEVICE_HEIGHT,
    DEFAULT_DEVICE_WIDTH,
    DEFAULT_VIEW_SCALE,
    DEVICE_TYPES,
    LINK_ROUTE_MODES
} from '../core/constants.js';

import { appState } from '../core/state.js';
import { endLinkMode, resetLinkCreationState } from '../core/link-mode.js';
import { getDeviceStatusLabel, getDeviceStatusDescription } from '../core/device-monitoring.js';
import { requireAdminUiAction } from '../ui/access-control.js';
import {
    clampNumber
} from '../core/utils.js';
import { eventBus } from '../core/event-bus.js';
import { getLinkCrossingStyle, getConnectionHighlightEnabled } from '../core/link-display-settings.js';
import { getLinkColor } from '../core/link-systems.js';
import { calculateOriginFit } from './origin-fit.js';
import {
    applyViewTransform,
    getCanvasVisibleCenter,
    resetView,
    revealCanvasLinkRoute
} from './pan-zoom.js';
import {
    allocateLocalId,
    getCurrentFloorPlan,
    getCurrentCanvasNotes,
    getCurrentLinks,
    getCurrentPlacements,
    getCurrentView,
    getDeviceForPlacement,
    getPlacementForDeviceInCurrentView,
    normalizeStatus
} from '../core/state.js';
import {
    buildSvgPathData,
    calculateLinkLabelPosition,
    calculateLinkRoute,
    createTopologyLinkPath,
    getLinkRouteEndpoints
} from './link-router.js';
import { resolveTopologyLinkRoutes } from './link-route-resolver.js';
import { createLinkDisplayMap } from './link-crossings.js';
import {
    getLinkRoutePreview,
    renderLinkRouteEditor,
    syncLinkRouteEditor
} from './link-route-editor.js';
import {
    makePlacementDraggable
} from './drag-drop.js';
import {
    showToast
} from '../ui/toast.js';
import {
    markDirty
} from '../ui/status-bar.js';
import { hasResourceConflict, scheduleSave } from '../core/save-queue.js';
import {
    closeLinkPanel,
    closePanel,
    openLinkPanel,
    openPanel
} from '../ui/property-panel.js';
import {
    handleCanvasPlacementClick,
    isPlacementModeActive
} from '../ui/placement-mode.js';
import { renderCanvasNotes, createCanvasNote, finishCanvasNotes } from './canvas-notes.js';
import { renderRackView } from './rack-view.js';
import { renderFloorRacks, getCurrentFloorRackPlacements, clearFloorRackSelection } from './floor-racks.js';

// 現在ビューの有効な端点だけを使い、無向の1ホップを描画ごとに求める。
function getConnectionHighlight() {
    if (!getConnectionHighlightEnabled() || appState.selectedPlacementIds.size !== 1 ||
        appState.linkMode || appState.noteMode || appState.isRangeSelecting ||
        appState.editingLinkId != null) return null;
    const placements = getCurrentPlacements();
    const selectedId = Number(appState.selectedPlacementIds.values().next().value);
    const source = placements.find(row => Number(row.id) === selectedId);
    if (!source || !getDeviceForPlacement(source)) return null;
    const deviceIds = new Set(appState.devices.map(device => Number(device.id)));
    const placedIds = new Set(placements
        .filter(row => deviceIds.has(Number(row.device_id)))
        .map(row => Number(row.device_id)));
    const sourceId = Number(source.device_id);
    const relatedIds = new Set([sourceId]);
    const linkIds = new Set();
    for (const link of getCurrentLinks()) {
        const from = Number(link.from_id);
        const to = Number(link.to_id);
        if (!placedIds.has(from) || !placedIds.has(to)) continue;
        if (from === sourceId || to === sourceId) {
            relatedIds.add(from);
            relatedIds.add(to);
            linkIds.add(Number(link.id));
        }
    }
    return { sourceId, relatedIds, linkIds };
}

function applyDeviceConnectionHighlight(element, deviceId, highlight) {
    element.classList.toggle('connection-dimmed',
        Boolean(highlight && !highlight.relatedIds.has(deviceId)));
    element.classList.toggle('connection-related',
        Boolean(highlight && deviceId !== highlight.sourceId && highlight.relatedIds.has(deviceId)));
}

export function syncConnectionHighlight(highlight = getConnectionHighlight()) {
    appState.deviceLayer?.querySelectorAll('.device').forEach(element => {
        applyDeviceConnectionHighlight(element, Number(element.dataset.deviceId), highlight);
    });
    appState.currentSvg?.querySelectorAll('.link-group').forEach(element => {
        element.classList.toggle('connection-dimmed',
            Boolean(highlight && !highlight.linkIds.has(Number(element.dataset.id))));
    });
}

eventBus.on('rack:reload', async viewId => {
    const { reloadConflictedResource } = await import('../core/save-queue.js');
    await reloadConflictedResource('views', viewId);
    render();
});
/**
 * 描画
 */
export function render({ revealLinkId = null } = {}) {
    if (renderRackView()) {
        renderCanvasNotes();
        applyViewTransform();
        eventBus.emit('canvas:render-complete');
        return;
    }
    if (
        !appState.currentSvg ||
        !appState.deviceLayer ||
        !appState.floorPlanLayer
    ) {
        return;
    }
    const focusedPlacementId = appState.linkMode && appState.deviceLayer.contains(document.activeElement)
        ? document.activeElement.dataset.placementId : null;
    if (appState.world) appState.world.hidden = false;

    appState.currentSvg.replaceChildren();
    appState.deviceLayer.replaceChildren();

    eventBus.emit('canvas:render-floor-plan');
    const connectionHighlight = getConnectionHighlight();
    renderLinks({ revealLinkId, connectionHighlight });
    renderCanvasNotes();

    getCurrentPlacements().forEach(
        placement => {
            const device =
                getDeviceForPlacement(
                    placement
                );

            if (!device) {
                return;
            }

            const element =
                createDeviceElement(
                    placement,
                    device,
                    connectionHighlight
                );

            appState.deviceLayer.appendChild(element);
        }
    );
    renderFloorRacks();
    if (focusedPlacementId) {
        appState.deviceLayer.querySelector(`[data-placement-id="${focusedPlacementId}"]`)?.focus();
    }

    applyViewTransform();
    eventBus.emit('canvas:render-complete');

}

/**
 * 座標を有限数へ正規化する。
 */

/**
 * リンク描画
 */
export function renderLinks({ revealLinkId = null, connectionHighlight = getConnectionHighlight() } = {}) {
    if (!appState.currentSvg) {
        return;
    }

    syncLinkRouteEditor();
    appState.currentSvg.replaceChildren();
    syncConnectionHighlight(connectionHighlight);

    const currentLinks = getCurrentLinks();
    const systemMap = new Map(appState.linkSystems.map(system => [Number(system.id), system]));
    const currentPlacements = getCurrentPlacements();
    const routeMap = resolveTopologyLinkRoutes(currentLinks, currentPlacements);
    const preview = getLinkRoutePreview();
    if (preview && routeMap.has(preview.linkId)) {
        routeMap.set(preview.linkId, preview.points);
    }
    if (revealLinkId !== null) {
        revealCanvasLinkRoute(routeMap.get(revealLinkId));
    }
    if (routeMap.size === 0) {
        return;
    }
    const displayMap = createLinkDisplayMap(routeMap, getLinkCrossingStyle());
    // One shared foreground keeps the complete active route above every link.
    const foreground = document.createElementNS(
        'http://www.w3.org/2000/svg',
        'g'
    );
    foreground.classList.add('link-foreground');
    foreground.setAttribute('aria-hidden', 'true');
    const halo = createTopologyLinkPath('link-foreground-halo', 'M 0 0');
    const activePath = createTopologyLinkPath('link-foreground-path', 'M 0 0');
    foreground.appendChild(halo);
    foreground.appendChild(activePath);
    let selectedForeground = null;
    let hoveredId = null;
    const showForeground = active => {
        foreground.style.display = active ? '' : 'none';
        foreground.classList.toggle('selected', Boolean(active?.selected));
        if (active) {
            halo.setAttribute('d', active.pathData);
            activePath.setAttribute('d', active.pathData);
            activePath.style.stroke = active.color;
        }
    };

    currentLinks.forEach(link => {
        const route = routeMap.get(Number(link.id));

        if (!route || route.length < 2) {
            return;
        }

        const endpoints =
            getLinkRouteEndpoints(route);

        const pathData =
            buildSvgPathData(route);

        if (
            !endpoints ||
            !pathData
        ) {
            return;
        }

        const display = displayMap.get(Number(link.id));
        const labelPosition = display?.labelPosition ??
            calculateLinkLabelPosition(route);

        const group =
            document.createElementNS(
                'http://www.w3.org/2000/svg',
                'g'
            );

        group.classList.add('link-group');
        group.dataset.id = String(link.id);
        group.classList.toggle('connection-dimmed',
            Boolean(connectionHighlight && !connectionHighlight.linkIds.has(Number(link.id))));
        const color = getLinkColor(link, systemMap);
        const selected = Number(link.id) === Number(appState.editingLinkId);
        const active = { pathData: display?.pathData || pathData, color, selected };

        if (selected) {
            group.classList.add('selected');
            selectedForeground = active;
        }

        const hitPath =
            createTopologyLinkPath(
                'topology-link-hit',
                pathData
            );

        if (!hitPath) {
            return;
        }

        hitPath.addEventListener(
            'click',
            event => {
                event.stopPropagation();
                onLinkClick(link);
            }
        );

        const path =
            createTopologyLinkPath(
                'topology-link',
                display?.pathData || pathData
            );

        if (!path) {
            return;
        }
        path.style.stroke = color;

        path.addEventListener(
            'click',
            event => {
                event.stopPropagation();
                onLinkClick(link);
            }
        );

        group.appendChild(hitPath);
        group.appendChild(path);
        group.addEventListener('pointerenter', () => {
            hoveredId = Number(link.id);
            showForeground(active);
        });
        group.addEventListener('pointerleave', () => {
            if (hoveredId !== Number(link.id)) return;
            hoveredId = null;
            showForeground(selectedForeground);
        });

        if (
            link.label &&
            labelPosition
        ) {
            const text =
                document.createElementNS(
                    'http://www.w3.org/2000/svg',
                    'text'
                );

            text.classList.add(
                'link-label'
            );

            text.setAttribute(
                'x',
                String(
                    labelPosition.x
                )
            );

            text.setAttribute(
                'y',
                String(
                    labelPosition.y
                )
            );

            if (
                labelPosition.orientation ===
                'vertical'
            ) {
                text.setAttribute(
                    'text-anchor',
                    'start'
                );

                text.setAttribute(
                    'dominant-baseline',
                    'middle'
                );
            } else {
                text.setAttribute(
                    'text-anchor',
                    'middle'
                );
            }

            text.textContent =
                link.label;

            group.appendChild(text);
        }

        appState.currentSvg.appendChild(group);
    });
    showForeground(selectedForeground);
    appState.currentSvg.appendChild(foreground);
    renderLinkRouteEditor(appState.currentSvg, routeMap);
}


/**
 * 機器要素作成
 */

/**
 * 機器要素作成
 */
export function createDeviceElement(
    placement,
    device,
    connectionHighlight = getConnectionHighlight()
) {
    const el = document.createElement('div');

    el.classList.add('device');
    el.classList.add(
        normalizeStatus(device.status)
    );
    applyDeviceConnectionHighlight(el, Number(device.id), connectionHighlight);

    if (
        appState.selectedPlacementIds.has(
            Number(placement.id)
        )
    ) {
        el.classList.add('selected');
    }

    if (
        appState.linkMode &&
        Number(appState.linkSourceId) ===
        Number(device.id)
    ) {
        el.classList.add('link-source');
    }

    el.dataset.id = String(device.id);
    el.dataset.deviceId =
        String(device.id);
    el.dataset.placementId =
        String(placement.id);

    el.style.transform =
        `translate(${placement.x}px, ${placement.y}px)`;

    const iconWrap =
        document.createElement('div');

    iconWrap.classList.add('icon');

    const definition =
        DEVICE_TYPES[device.type] ||
        DEVICE_TYPES.other;

    const icon =
        document.createElement('img');

    icon.classList.add('icon-symbol');
    icon.src = definition.icon;
    icon.alt = '';
    icon.draggable = false;

    icon.addEventListener('error', () => {
        if (
            icon.dataset.fallbackApplied ===
                'true' ||
            definition.icon ===
                DEVICE_TYPES.other.icon
        ) {
            return;
        }

        icon.dataset.fallbackApplied = 'true';
        icon.src = DEVICE_TYPES.other.icon;
    });

    iconWrap.appendChild(icon);

    const name =
        document.createElement('div');

    name.classList.add('device-name');
    name.textContent =
        device.name || '(名称未設定)';

    const ip =
        document.createElement('div');

    ip.classList.add('device-ip');
    ip.textContent =
        device.ip || 'IP未設定';

    const meta =
        document.createElement('div');

    meta.classList.add('device-meta');
    meta.textContent = getDeviceStatusLabel(device.status);
    const statusDescription = getDeviceStatusDescription(device);
    meta.setAttribute('role', 'img');
    meta.setAttribute('aria-label', statusDescription);
    el.title = statusDescription;

    el.appendChild(iconWrap);
    el.appendChild(name);
    el.appendChild(ip);
    el.appendChild(meta);

    el.addEventListener(
        'click',
        event =>
            onPlacementClick(
                event,
                placement,
                device
            )
    );

    if (appState.linkMode) {
        el.tabIndex = 0;
        el.setAttribute('role', 'button');
        el.setAttribute('aria-label', `${device.name || '(名称未設定)'}${device.ip ? ` ${device.ip}` : ''} / ${statusDescription}`);
        el.setAttribute('aria-pressed', String(Number(appState.linkSourceId) === Number(device.id)));
        el.addEventListener('keydown', async event => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            await onPlacementClick(event, placement, device);
            appState.deviceLayer?.querySelector(`[data-placement-id="${placement.id}"]`)?.focus();
        });
    }

    el.addEventListener(
        'dblclick',
        async event => {
            event.stopPropagation();
            if (appState.linkMode) return;

            if (!await openPanel(device)) {
                return;
            }

            clearFloorRackSelection();
            appState.selectedPlacementIds.clear();
            appState.selectedPlacementIds.add(
                Number(placement.id)
            );

            render();
        }
    );

    makePlacementDraggable(
        el,
        placement
    );

    return el;
}


/**
 * 機器クリック
 */

/**
 * 機器クリック
 */
export async function onPlacementClick(
    event,
    placement,
    device
) {
    event.stopPropagation();

    if (appState.suppressNextClick) {
        appState.suppressNextClick = false;
        return;
    }

    if (appState.linkMode) {
        handleLinkModeClick(device);
        return;
    }

    finishCanvasNotes('selection');
    if (!await openPanel(device)) {
        return;
    }
    clearFloorRackSelection();

    const placementId =
        Number(placement.id);

    const multi =
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey;

    if (!multi) {
        appState.selectedPlacementIds.clear();
    }

    if (
        appState.selectedPlacementIds.has(
            placementId
        ) &&
        multi
    ) {
        appState.selectedPlacementIds.delete(
            placementId
        );
    } else {
        appState.selectedPlacementIds.add(
            placementId
        );
    }
    render();
}


/**
 * リンク作成モード中のクリック処理
 */

/**
 * リンク作成モード中のクリック処理
 */
export function handleLinkModeClick(device) {
    if (!appState.linkMode || !requireAdminUiAction() || appState.authExpired ||
        hasResourceConflict('views', appState.currentViewId)) return;
    if (appState.currentViewId === null) {
        showToast(
            '表示中のビューがありません',
            'warning'
        );
        return;
    }
    const placed = getCurrentPlacements();
    if (!placed.some(row => Number(row.device_id) === Number(device.id)) ||
        (appState.linkSourceId != null && !placed.some(row => Number(row.device_id) === Number(appState.linkSourceId)))) {
        showToast('このビューの接続元と接続先を選択してください', 'warning');
        return;
    }

    if (appState.linkSourceId === null) {
        appState.linkSourceId = Number(device.id);
        appState.linkSourceConnected = false;
        eventBus.emit('wiring:render');


        render();
        return;
    }

    if (
        Number(appState.linkSourceId) ===
        Number(device.id)
    ) {
        showToast(
            '同一機器同士は接続できません',
            'warning'
        );
        return;
    }

    const exists =
        getCurrentLinks().some(link => {
            const a =
                Number(link.from_id);

            const b =
                Number(link.to_id);

            return (
                (
                    a === Number(appState.linkSourceId) &&
                    b === Number(device.id)
                ) ||
                (
                    a === Number(device.id) &&
                    b === Number(appState.linkSourceId)
                )
            );
        });

    if (exists) {
        showToast(
            'このビューには同じ接続が既に存在します',
            'warning'
        );

        if (!appState.linkSourceFixed) resetLinkCreationState();
        eventBus.emit('wiring:render');
        render();
        return;
    }

    appState.links.push({
        id: allocateLocalId('links'),
        view_id: Number(appState.currentViewId),
        from_id: Number(appState.linkSourceId),
        to_id: Number(device.id),
        route_mode: 'auto',
        manual_route: [],
        label: '',
        from_port: '',
        to_port: '',
        vlan: '',
        memo: ''
    });

    markDirty();
    scheduleSave({ immediate: true, silent: true });

    if (appState.linkSourceFixed) appState.linkSourceConnected = true;
    else resetLinkCreationState();
    eventBus.emit('wiring:render');
    render();
}


/**
 * リンククリック
 */

/**
 * リンククリック
 */
export async function onLinkClick(link, { reveal = false } = {}) {
    finishCanvasNotes('selection');
    if (!await openLinkPanel(link)) {
        return;
    }

    appState.selectedPlacementIds.clear();
    render({ revealLinkId: reveal ? Number(link.id) : null });
}


/**
 * キャンバスクリック
 */

/**
 * キャンバスクリック
 */
export async function onCanvasClick(event) {
    if (appState.suppressNextClick) {
        appState.suppressNextClick = false;
        return;
    }

    if (
        event?.target instanceof Element &&
        event.target.closest('#canvas-context-toolbar')
    ) {
        return;
    }

    // 既存機器・リンク・入力要素上のクリックでは配置処理を行わない
    if (
        event?.target instanceof Element &&
        event.target.closest(
            '.floor-rack, ' +
            '.device, ' +
            '.link-group, ' +
            '.link-route-editor, ' +
            '.canvas-note, ' +
            'button, ' +
            'input, ' +
            'select, ' +
            'textarea'
        )
    ) {
        return;
    }

    if (appState.noteMode) {
        await createCanvasNote(event);
        return;
    }
    finishCanvasNotes('selection');

    // 配置モード中のクリック処理
    if (isPlacementModeActive()) {
        if (handleCanvasPlacementClick(event)) {
            return;
        }
    }
    if (appState.linkMode) {
        return;
    }

    if (!await closePanel() || !await closeLinkPanel()) {
        return;
    }
    appState.selectedPlacementIds.clear();
    clearFloorRackSelection();

    render();
}


/**
 * 全体表示
 */

/**
 * 全体表示
 */
export function fitViewToDevices() {
    if (!appState.canvas) {
        return;
    }

    const currentView =
        getCurrentView();
    if (currentView?.view_type === 'rack') {
        const content = document.getElementById('rack-content');
        if (!content) { resetView(); return; }
        const viewport = appState.canvas.getBoundingClientRect();
        const bounds = content.getBoundingClientRect();
        const ratio = appState.viewState.scale / DEFAULT_VIEW_SCALE;
        appState.viewState.scale = clampNumber(Math.min(
            (viewport.width - 24) / Math.max(1, bounds.width / ratio),
            (viewport.height - 24) / Math.max(1, bounds.height / ratio)
        ) * DEFAULT_VIEW_SCALE, appState.viewState.minScale, appState.viewState.maxScale);
        appState.canvas.scrollLeft = 0; appState.canvas.scrollTop = 0;
        applyViewTransform();
        return;
    }

    const currentFloorPlan =
        getCurrentFloorPlan();

    if (
        currentView?.view_type ===
            'floor' &&
        currentFloorPlan &&
        (currentFloorPlan.is_visible || appState.floorPlanAdjustMode)
    ) {
        eventBus.emit(
            'floor-plan:fit',
            currentFloorPlan
        );

        return;
    }

    const currentPlacements =
        getCurrentPlacements();
    const currentNotes = getCurrentCanvasNotes();
    const floorRacks = getCurrentFloorRackPlacements();

    if (currentPlacements.length === 0 && currentNotes.length === 0 && floorRacks.length === 0) {
        resetView();
        return;
    }

    let maxX = 0;
    let maxY = 0;
    for (const placement of [...currentPlacements, ...floorRacks]) {
        maxX = Math.max(maxX, (Number(placement.x) || 0) + DEFAULT_DEVICE_WIDTH);
        maxY = Math.max(maxY, (Number(placement.y) || 0) + DEFAULT_DEVICE_HEIGHT);
    }
    for (const note of currentNotes) {
        maxX = Math.max(maxX, Number(note.x) + Number(note.width));
        maxY = Math.max(maxY, Number(note.y) + Number(note.height));
    }
    Object.assign(appState.viewState, calculateOriginFit(
        appState.canvas.getBoundingClientRect(),
        { minX: 0, minY: 0, maxX, maxY },
        appState.viewState
    ));

    applyViewTransform();
}


/**
 * キーボード操作
 */

export function getPlacementElement(
    placementId
) {
    if (!appState.deviceLayer) {
        return null;
    }

    return appState.deviceLayer.querySelector(
        `.device[data-placement-id="${Number(
            placementId
        )}"]`
    );
}


/**
 * 位置をキャンバス内に制限
 */

/**
 * 機器中心座標
 */
export function getPlacementCenter(placement) {
    return {
        x:
            Number(placement.x) +
            DEFAULT_DEVICE_WIDTH / 2,
        y:
            Number(placement.y) +
            DEFAULT_DEVICE_HEIGHT / 2
    };
}


/**
 * 編集パネル表示
 */

export function showDeviceInPlacement(
    device,
    placement
) {
    const targetViewId =
        Number(placement.view_id);

    if (
        Number(appState.currentViewId) !==
        targetViewId
    ) {
        eventBus.emit(
            'view:switch',
            targetViewId
        );
    }

    const currentPlacement =
        getPlacementForDeviceInCurrentView(
            device.id
        );

    if (!currentPlacement) {
        showToast(
            '対象機器の配置が見つかりません',
            'warning'
        );

        return false;
    }

    return focusDevicePlacement(
        device,
        currentPlacement
    );
}


export function focusDevicePlacement(
    device,
    placement
) {
    if (!appState.canvas) {
        return false;
    }

    endLinkMode();
    eventBus.emit('toolbar:sync-link-mode');

    const openResult = openPanel(device);
    if (openResult instanceof Promise) {
        return openResult.then(ok => {
            if (!ok) return false;
            finishFocusDevicePlacement(placement);
            return true;
        });
    }

    if (!openResult) {
        return false;
    }

    finishFocusDevicePlacement(placement);
    return true;
}

function finishFocusDevicePlacement(placement) {
    clearFloorRackSelection();
    appState.selectedPlacementIds.clear();
    appState.selectedPlacementIds.add(
        Number(placement.id)
    );
    if (appState.viewState.scale < DEFAULT_VIEW_SCALE) {
        appState.viewState.scale = DEFAULT_VIEW_SCALE;
    }

    const visibleCenter =
        getCanvasVisibleCenter();

    const center =
        getPlacementCenter(
            placement
        );

    appState.viewState.panX =
        visibleCenter.x -
        center.x *
            appState.viewState.scale;

    appState.viewState.panY =
        visibleCenter.y -
        center.y *
            appState.viewState.scale;
    render();

    highlightDevicePlacement(
        placement.id
    );
}

let deviceSearchHighlightTimer = null;

export function highlightDevicePlacement(
    placementId
) {
    window.clearTimeout(
        deviceSearchHighlightTimer
    );

    const element =
        getPlacementElement(
            placementId
        );

    if (!element) {
        return;
    }

    element.classList.add(
        'search-highlight'
    );

    deviceSearchHighlightTimer =
        window.setTimeout(
            () => {
                element.classList.remove(
                    'search-highlight'
                );
            },
            2400
        );
}

