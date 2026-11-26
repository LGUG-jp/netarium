/**
 * Netarium - canvas/renderer.js
 */

import {
    DEFAULT_DEVICE_HEIGHT,
    DEFAULT_DEVICE_WIDTH,
    DEFAULT_VIEW_SCALE,
    DEVICE_TYPES
} from '../core/constants.js';

import { appState } from '../core/state.js';
import { endLinkMode, handleLinkCreationClick } from '../core/link-mode.js';
import { getDeviceStatusLabel, getDeviceStatusDescription } from '../core/device-monitoring.js';
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
    getCurrentFloorPlan,
    getCurrentCanvasNotes,
    getCurrentLinkGroups,
    getCurrentPlacements,
    getCurrentView,
    getPlacementForDeviceInCurrentView,
    normalizeStatus
} from '../core/state.js';
import { getViewLinkRoutingPlacements, linkGroupLabel } from '../core/connection-data.js';
import {
    buildSvgPathData,
    calculateLinkLabelPosition,
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
    closeLinkPanel,
    closePanel,
    hasUnappliedPanelChanges,
    openLinkGroup,
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
import { replaceSelectedPlacementIds, syncSelectedPlacementClasses } from './selection.js';

function isDeviceDetailSelectionMode() {
    return !appState.linkMode && !appState.noteMode && appState.selectedCanvasNoteId == null &&
        !isPlacementModeActive() && !appState.floorPlanAdjustMode && !appState.isRangeSelecting &&
        !appState.canvas?.classList.contains('panning') && !hasLinkSelection();
}

const hasLinkSelection = () => appState.editingLinkGroupKey != null || appState.editingLinkId != null;

// 現在ビューの有効な端点だけを使い、無向の1ホップを描画ごとに求める。
function getConnectionHighlight(deviceIndex) {
    if (!getConnectionHighlightEnabled() || appState.selectedPlacementIds.size !== 1 ||
        appState.linkMode || appState.noteMode || appState.isRangeSelecting ||
        hasLinkSelection()) return null;
    const placements = getCurrentPlacements();
    const selectedId = Number(appState.selectedPlacementIds.values().next().value);
    const source = placements.find(row => Number(row.id) === selectedId);
    if (!source) return null;
    const sourceId = Number(source.device_id);
    const deviceIds = deviceIndex ?? new Set(appState.devices.map(device => Number(device.id)));
    if (Number.isNaN(sourceId) || !deviceIds.has(sourceId)) return null;
    const placedIds = new Set(placements
        .filter(row => deviceIds.has(Number(row.device_id)))
        .map(row => Number(row.device_id)));
    const relatedIds = new Set([sourceId]);
    const linkKeys = new Set();
    for (const link of getCurrentLinkGroups()) {
        // ラック端点は機器の隣接判定に含めず、線と本数バッジを通常表示のままにする。
        if (link.rack_projected) {
            linkKeys.add(link.display_key);
            continue;
        }
        const from = Number(link.from_id);
        const to = Number(link.to_id);
        if (!placedIds.has(from) || !placedIds.has(to)) continue;
        if (from === sourceId || to === sourceId) {
            relatedIds.add(from);
            relatedIds.add(to);
            linkKeys.add(link.display_key);
        }
    }
    return { sourceId, relatedIds, linkKeys };
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
    appState.currentSvg?.querySelectorAll('.link-group, .link-count-badge').forEach(element => {
        element.classList.toggle('connection-dimmed',
            Boolean(highlight && !highlight.linkKeys.has(element.dataset.displayKey)));
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
    const devicesById = new Map();
    for (const device of appState.devices) {
        const id = Number(device.id);
        // 以前の検索と同じく NaN は照合せず、同じ ID なら先頭を使う。
        if (!Number.isNaN(id) && !devicesById.has(id)) devicesById.set(id, device);
    }
    const connectionHighlight = getConnectionHighlight(devicesById);
    renderLinks({ revealLinkId, connectionHighlight });
    renderCanvasNotes();

    getCurrentPlacements().forEach(
        placement => {
            const device = devicesById.get(Number(placement.device_id));

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

    const currentLinks = getCurrentLinkGroups();
    const systemMap = new Map(appState.linkSystems.map(system => [Number(system.id), system]));
    const routingPlacements = getViewLinkRoutingPlacements(getCurrentView(), appState, getCurrentPlacements());
    const routeMap = resolveTopologyLinkRoutes(currentLinks, routingPlacements);
    const preview = getLinkRoutePreview();
    if (preview && routeMap.has(preview.key)) {
        routeMap.set(preview.key, preview.points);
    }
    if (revealLinkId !== null) {
        const key = currentLinks.find(group => group.link_ids.includes(Number(revealLinkId)))?.display_key;
        revealCanvasLinkRoute(routeMap.get(key));
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
    let badges = null;
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
        const key = link.display_key;
        const route = routeMap.get(key);

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

        const display = displayMap.get(key);
        const labelPosition = display?.labelPosition ??
            calculateLinkLabelPosition(route);

        const group =
            document.createElementNS(
                'http://www.w3.org/2000/svg',
                'g'
            );

        group.classList.add('link-group');
        group.dataset.displayKey = key;
        group.classList.toggle('connection-dimmed',
            Boolean(connectionHighlight && !connectionHighlight.linkKeys.has(key)));
        const selected = appState.editingLinkId != null ? link.link_ids.includes(Number(appState.editingLinkId)) :
            key === appState.editingLinkGroupKey;
        const color = selected ? 'var(--primary)' : getLinkColor(link, systemMap);
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

        const path =
            createTopologyLinkPath(
                'topology-link',
                display?.pathData || pathData
            );

        if (!path) {
            return;
        }
        path.style.stroke = color;

        const select = event => {
            event.stopPropagation();
            return onLinkGroupClick(link);
        };
        hitPath.addEventListener('click', select);
        path.addEventListener('click', select);

        group.appendChild(hitPath);
        group.appendChild(path);
        const enter = () => {
            hoveredId = key;
            showForeground(active);
        };
        const leave = () => {
            if (hoveredId !== key) return;
            hoveredId = null;
            showForeground(selectedForeground);
        };
        group.addEventListener('pointerenter', enter);
        group.addEventListener('pointerleave', leave);

        const label = linkGroupLabel(link);
        if (
            label &&
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

            text.textContent = label;
            if (link.link_ids.length > 1) {
                badges ??= document.createElementNS('http://www.w3.org/2000/svg', 'g');
                const badge = document.createElementNS('http://www.w3.org/2000/svg', 'g');
                const background = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
                const vertical = labelPosition.orientation === 'vertical';
                const width = label.length * 8 + 10;
                const x = labelPosition.x + (vertical ? width / 2 : 0);
                const y = labelPosition.y - (vertical ? 0 : 6);
                background.setAttribute('x', String(x - width / 2));
                background.setAttribute('y', String(y - 9));
                background.setAttribute('width', String(width));
                background.setAttribute('height', '18');
                background.setAttribute('rx', '4');
                text.setAttribute('x', String(x));
                text.setAttribute('y', String(y));
                text.classList.add('link-label-count');
                badge.classList.add('link-count-badge');
                badge.dataset.displayKey = key;
                badge.classList.toggle('connection-dimmed',
                    Boolean(connectionHighlight && !connectionHighlight.linkKeys.has(key)));
                badge.addEventListener('click', select);
                badge.addEventListener('pointerenter', enter);
                badge.addEventListener('pointerleave', leave);
                badge.append(background, text);
                badges.appendChild(badge);
            } else {
                group.appendChild(text);
            }
        }

        appState.currentSvg.appendChild(group);
    });
    showForeground(selectedForeground);
    appState.currentSvg.appendChild(foreground);
    if (badges) appState.currentSvg.appendChild(badges);
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

    const isLinkSource = appState.linkMode && Number(appState.linkSourceId) === Number(device.id);
    const isLegacyTarget = appState.linkMode && appState.legacyLinkCreation != null &&
        Number(appState.linkTargetId) === Number(device.id);
    if (isLinkSource) el.classList.add('link-source');
    if (isLegacyTarget) el.classList.add('link-target');

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
    name.title = name.textContent;

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

    // 選択クリックで要素を交換しないため、ブラウザーのdblclickとフォーカス復帰を維持できる。
    el.tabIndex = -1;
    let detailClickAllowed = true;
    el.addEventListener(
        'click',
        event => {
            if (!(event.detail > 1)) {
                detailClickAllowed = isDeviceDetailSelectionMode() && !appState.suppressNextClick;
            }
            return onPlacementClick(event, placement, device);
        }
    );

    if (appState.linkMode) {
        el.tabIndex = 0;
        el.setAttribute('role', 'button');
        const endpoint = isLinkSource ? '接続元 / ' : isLegacyTarget ? '接続先 / ' : '';
        el.setAttribute('aria-label', `${endpoint}${device.name || '(名称未設定)'}${device.ip ? ` ${device.ip}` : ''} / ${statusDescription}`);
        el.setAttribute('aria-pressed', String(isLinkSource || isLegacyTarget));
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
            if (!detailClickAllowed || !isDeviceDetailSelectionMode() || appState.suppressNextClick ||
                event.ctrlKey || event.metaKey || event.shiftKey || event.altKey ||
                el.classList.contains('dragging') || !el.isConnected ||
                !getCurrentPlacements().includes(placement)) return;
            el.focus({ preventScroll: true });
            const { openLedgerDetail } = await import('../modals/ledger-modal.js');
            if (!el.isConnected || !isDeviceDetailSelectionMode()) return;
            await openLedgerDetail(device.id);
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
    const hadLinkSelection = hasLinkSelection();
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
    // 全再描画でクリック元を破棄すると、続くネイティブdblclickが届かない。
    syncSelectedPlacementClasses();
    if (hadLinkSelection) renderLinks();
    eventBus.emit('canvas:selection-changed');
}


/**
 * リンク作成モード中のクリック処理
 */
export function handleLinkModeClick(device) {
    if (handleLinkCreationClick(device)) render();
}


/**
 * リンククリック
 */
async function onLinkGroupClick(group) {
    finishCanvasNotes('selection');
    if (!await openLinkGroup(group)) return;
    appState.selectedPlacementIds.clear();
    clearFloorRackSelection();
    render();
}

export async function onLinkClick(link, { reveal = false } = {}) {
    finishCanvasNotes('selection');
    if (!await openLinkPanel(link)) {
        return;
    }

    appState.selectedPlacementIds.clear();
    clearFloorRackSelection();
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
            '.link-count-badge, ' +
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

    const clearsOnlyDeviceSelection =
        appState.selectedPlacementIds.size > 0 && !hasLinkSelection() && !hasUnappliedPanelChanges();
    if (!await closePanel() || !await closeLinkPanel()) {
        return;
    }
    if (clearsOnlyDeviceSelection) {
        replaceSelectedPlacementIds([]);
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
        return import('../modals/view-manager-modal.js').then(async ({ switchView }) => {
            if (!await switchView(targetViewId) || Number(appState.currentViewId) !== targetViewId) return false;
            return showDeviceInPlacement(device, placement);
        });
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

