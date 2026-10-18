/**
 * Netarium - modals/placement-modal.js
 */

import {
    DEFAULT_DEVICE_HEIGHT,
    DEFAULT_DEVICE_WIDTH
} from '../core/constants.js';

import { appState } from '../core/state.js';
import { allocateLocalId } from '../core/state.js';
import { eventBus } from '../core/event-bus.js';
import { chooseUnsavedChanges } from '../core/unsaved-changes-dialog.js';
import {
    requireAdminUiAction
} from '../ui/access-control.js';
import {
    screenToWorld
} from '../canvas/pan-zoom.js';
import {
    compareViews,
    getDeviceById,
    getPlacementsForDevice
} from '../core/state.js';
import {
    render
} from '../canvas/renderer.js';
import {
    clampPosition
} from '../canvas/drag-drop.js';
import {
    closeLinkPanel,
    closePanel,
    openPanel
} from '../ui/property-panel.js';
import {
    registerModalClose,
    registerModalOpen
} from '../core/modal-focus.js';
import {
    normalizeFloorForMatch,
    normalizeMatchText,
    setInputValue,
    setTextContent
} from '../core/utils.js';
import {
    showToast
} from '../ui/toast.js';
import {
    markDirty
} from '../ui/status-bar.js';
import { scheduleSave } from '../core/save-queue.js';
let placementManagerDeviceId = null;
let placementManagerInitialViewIds = new Set();
let placementManagerSelectedViewIds = new Set();

export function getViewRecommendationScore(
    device,
    view
) {
    const deviceFacility =
        normalizeMatchText(
            device.facility
        );

    const deviceFloor =
        normalizeFloorForMatch(
            device.floor
        );

    const viewFacility =
        normalizeMatchText(
            view.facility
        );

    const viewFloor =
        normalizeFloorForMatch(
            view.floor
        );

    const facilityMatches =
        deviceFacility !== '' &&
        deviceFacility === viewFacility;

    const floorMatches =
        deviceFloor !== '' &&
        deviceFloor === viewFloor;

    if (
        view.view_type === 'floor' &&
        facilityMatches &&
        floorMatches
    ) {
        return 100;
    }

    if (
        view.view_type === 'topology' &&
        facilityMatches &&
        (
            viewFloor === '' ||
            floorMatches
        )
    ) {
        return 80;
    }

    if (
        view.view_type === 'floor' &&
        facilityMatches &&
        viewFloor === ''
    ) {
        return 70;
    }

    if (
        view.view_type === 'topology' &&
        viewFacility === '' &&
        viewFloor === ''
    ) {
        return 60;
    }

    if (facilityMatches) {
        return 40;
    }

    return 0;
}


export function openPlacementManager(deviceId) {
    if (!requireAdminUiAction()) {
        return;
    }
    const device =
        getDeviceById(deviceId);

    const overlay =
        document.getElementById(
            'placement-manager-overlay'
        );

    if (!device || !overlay) {
        showToast(
            '配置先選択画面を開けません',
            'error'
        );
        return;
    }

    placementManagerDeviceId =
        Number(device.id);

    placementManagerInitialViewIds =
        new Set(
            getPlacementsForDevice(
                device.id
            )
                .map(placement =>
                    Number(
                        placement.view_id
                    )
                )
        );

    placementManagerSelectedViewIds =
        new Set(
            placementManagerInitialViewIds
        );

    setTextContent(
        'placement-manager-device',
        `${device.name} ${
            device.ip
                ? `(${device.ip})`
                : ''
        }`
    );

    setTextContent(
        'pm-device-facility',
        device.facility || '-'
    );

    setTextContent(
        'pm-device-floor',
        device.floor || '-'
    );

    setInputValue(
        'placement-manager-search',
        ''
    );

    overlay.hidden = false;

    renderPlacementManager();
    registerModalOpen('placement_manager', overlay, '#placement-manager-search', { onClose: closePlacementManager });
}


export async function closePlacementManager() {
    const overlay = document.getElementById('placement-manager-overlay');
    if (!overlay || overlay.hidden) return true;
    const changes = getPlacementManagerChanges();
    if (changes.addedViewIds.length || changes.removedViewIds.length) {
        const choice = await chooseUnsavedChanges('未適用の配置変更があります。どうしますか？');
        if (choice === 'save') {
            return await applyPlacementManager();
        }
        if (choice === 'cancel') return false;
    }
    dismissPlacementManager();
    return true;
}

function dismissPlacementManager() {
    const overlay =
        document.getElementById(
            'placement-manager-overlay'
        );
    if (overlay) {
        overlay.hidden = true;
    }

    registerModalClose('placement_manager');
    placementManagerDeviceId = null;
    placementManagerInitialViewIds =
        new Set();
    placementManagerSelectedViewIds =
        new Set();
}


export function renderPlacementManager() {
    const list =
        document.getElementById(
            'placement-manager-list'
        );

    const device =
        getDeviceById(
            placementManagerDeviceId
        );

    if (!list || !device) {
        return;
    }

    const keyword =
        normalizeMatchText(
            document.getElementById(
                'placement-manager-search'
            )?.value
        );

    const candidates = appState.views
        .map(view => ({
            view,
            score:
                getViewRecommendationScore(
                    device,
                    view
                )
        }))
        .filter(item => {
            if (!keyword) {
                return true;
            }

            const searchable =
                normalizeMatchText([
                    item.view.name,
                    item.view.facility,
                    item.view.floor,
                    item.view.view_type,
                    item.view.memo
                ].join(' '));

            return searchable.includes(
                keyword
            );
        })
        .sort((a, b) => {
            const scoreDifference =
                b.score - a.score;

            return scoreDifference !== 0
                ? scoreDifference
                : compareViews(
                    a.view,
                    b.view
                );
        });

    const recommended =
        candidates.filter(
            item => item.score > 0
        );

    const others =
        candidates.filter(
            item => item.score === 0
        );

    list.replaceChildren();

    appendPlacementManagerSection(
        list,
        '推奨',
        recommended,
        true
    );

    appendPlacementManagerSection(
        list,
        'その他',
        others,
        false
    );

    if (candidates.length === 0) {
        const empty =
            document.createElement('div');

        empty.className =
            'placement-manager-empty';

        empty.textContent =
            '条件に一致するビューがありません';

        list.appendChild(empty);
    }

    setTextContent(
        'placement-manager-count',
        `${candidates.length}件`
    );

    updatePlacementManagerImpact();
}


export function appendPlacementManagerSection(
    container,
    title,
    items,
    recommended
) {
    if (items.length === 0) {
        return;
    }

    const section =
        document.createElement('section');

    section.className =
        'placement-manager-section';

    const heading =
        document.createElement('h3');

    heading.textContent = title;
    section.appendChild(heading);

    items.forEach(item => {
        section.appendChild(
            createPlacementManagerOption(
                item.view,
                recommended
            )
        );
    });

    container.appendChild(section);
}


export function createPlacementManagerOption(
    view,
    recommended
) {
    const label =
        document.createElement('label');

    label.className =
        'placement-manager-option';

    if (recommended) {
        label.classList.add(
            'recommended'
        );
    }

    const checkbox =
        document.createElement('input');

    checkbox.type = 'checkbox';
    checkbox.value = String(view.id);
    checkbox.checked =
        placementManagerSelectedViewIds
            .has(Number(view.id));

    checkbox.addEventListener(
        'change',
        () => {
            const viewId =
                Number(view.id);

            if (checkbox.checked) {
                placementManagerSelectedViewIds
                    .add(viewId);
            } else {
                placementManagerSelectedViewIds
                    .delete(viewId);
            }

            updatePlacementManagerImpact();
        }
    );

    const main =
        document.createElement('span');

    main.className =
        'placement-manager-option-main';

    const name =
        document.createElement('strong');

    name.textContent =
        view.name ||
        `ビューID ${view.id}`;

    const typeLabel =
        view.view_type === 'floor'
            ? '物理'
            : '論理';

    const detail =
        document.createElement('span');

    detail.textContent = [
        view.facility,
        view.floor,
        typeLabel
    ]
        .filter(Boolean)
        .join(' / ');

    main.appendChild(name);
    main.appendChild(detail);

    label.appendChild(checkbox);
    label.appendChild(main);

    if (recommended) {
        const badge =
            document.createElement('span');

        badge.className =
            'placement-manager-option-badge';

        badge.textContent = '推奨';
        label.appendChild(badge);
    }

    return label;
}


export function getPlacementManagerChanges() {
    const addedViewIds =
        [...placementManagerSelectedViewIds]
            .filter(viewId =>
                !placementManagerInitialViewIds
                    .has(viewId)
            );

    const removedViewIds =
        [...placementManagerInitialViewIds]
            .filter(viewId =>
                !placementManagerSelectedViewIds
                    .has(viewId)
            );

    return {
        addedViewIds,
        removedViewIds
    };
}


export function countLinksRemovedByPlacementChange(
    deviceId,
    removedViewIds
) {
    const removedViewIdSet =
        new Set(
            removedViewIds.map(Number)
        );

    return appState.links.filter(link =>
        removedViewIdSet.has(
            Number(link.view_id)
        ) &&
        (
            Number(link.from_id) ===
                Number(deviceId) ||
            Number(link.to_id) ===
                Number(deviceId)
        )
    ).length;
}


export function updatePlacementManagerImpact() {
    const impact =
        document.getElementById(
            'placement-manager-impact'
        );

    if (!impact) {
        return;
    }

    const changes =
        getPlacementManagerChanges();

    const removedLinkCount =
        countLinksRemovedByPlacementChange(
            placementManagerDeviceId,
            changes.removedViewIds
        );

    impact.textContent =
        `追加 ${changes.addedViewIds.length}件 / ` +
        `解除 ${changes.removedViewIds.length}件 / ` +
        `削除される接続 ${removedLinkCount}件`;
}


export function getInitialPlacementPosition(
    viewId
) {
    if (
        Number(viewId) ===
            Number(appState.currentViewId) &&
        appState.canvas
    ) {
        const rect =
            appState.canvas.getBoundingClientRect();

        const center =
            screenToWorld(
                rect.left +
                    rect.width / 2,
                rect.top +
                    rect.height / 2
            );

        return clampPosition(
            center.x -
                DEFAULT_DEVICE_WIDTH / 2,
            center.y -
                DEFAULT_DEVICE_HEIGHT / 2
        );
    }

    const count =
        appState.placements.filter(
            placement =>
                Number(
                    placement.view_id
                ) === Number(viewId)
        ).length;

    const column = count % 8;
    const row =
        Math.floor(count / 8);

    return {
        x: 80 + column * 120,
        y: 80 + row * 110
    };
}


export async function applyPlacementManager() {
    if (!requireAdminUiAction()) {
        return false;
    }
    const device =
        getDeviceById(
            placementManagerDeviceId
        );

    if (!device) {
        showToast(
            '配置対象の機器が見つかりません',
            'warning'
        );
        dismissPlacementManager();
        return false;
    }

    const changes =
        getPlacementManagerChanges();

    const removedLinkCount =
        countLinksRemovedByPlacementChange(
            device.id,
            changes.removedViewIds
        );

    if (
        changes.addedViewIds.length === 0 &&
        changes.removedViewIds.length === 0
    ) {
        dismissPlacementManager();
        return true;
    }

    if (
        changes.removedViewIds.length > 0
    ) {
        const confirmed = confirm(
            '配置変更を適用しますか?\n\n' +
            `追加される配置: ${changes.addedViewIds.length}件\n` +
            `解除される配置: ${changes.removedViewIds.length}件\n` +
            `削除される接続: ${removedLinkCount}件`
        );

        if (!confirmed) {
            return false;
        }
    }

    const removedViewIdSet =
        new Set(
            changes.removedViewIds
                .map(Number)
        );

    appState.placements = appState.placements.filter(
        placement =>
            !(
                Number(
                    placement.device_id
                ) === Number(device.id) &&
                removedViewIdSet.has(
                    Number(
                        placement.view_id
                    )
                )
            )
    );

    appState.links = appState.links.filter(link =>
        !(
            removedViewIdSet.has(
                Number(link.view_id)
            ) &&
            (
                Number(link.from_id) ===
                    Number(device.id) ||
                Number(link.to_id) ===
                    Number(device.id)
            )
        )
    );

    changes.addedViewIds.forEach(
        viewId => {
            const alreadyExists =
                appState.placements.some(
                    placement =>
                        Number(
                            placement.device_id
                        ) ===
                            Number(device.id) &&
                        Number(
                            placement.view_id
                        ) ===
                            Number(viewId)
                );

            if (alreadyExists) {
                return;
            }

            const position =
                getInitialPlacementPosition(
                    viewId
                );

            appState.placements.push({
                id: allocateLocalId('placements'),
                device_id:
                    Number(device.id),
                view_id:
                    Number(viewId),
                x: position.x,
                y: position.y
            });
        }
    );

    markDirty();
    scheduleSave({ immediate: true, silent: true });
    const removedCurrentView =
        removedViewIdSet.has(
            Number(appState.currentViewId)
        );

    dismissPlacementManager();

    if (removedCurrentView) {
        appState.selectedPlacementIds.clear();
        appState.editingDeviceId = null;
        appState.editingLinkId = null;
        await closePanel();
        await closeLinkPanel();
    }

    render();

    const ledgerOverlay =
        document.getElementById(
            'ledger-overlay'
        );

    const ledgerIsOpen =
        Boolean(
            ledgerOverlay &&
            !ledgerOverlay.hidden
        );

    if (ledgerIsOpen) {
        eventBus.emit('ledger:render');
        window.requestAnimationFrame(() => {
            const newBtn = document.querySelector(
                `#ledger-table button[data-ledger-action="placement"][data-device-id="${device.id}"]`
            );
            if (newBtn && typeof newBtn.focus === 'function') {
                newBtn.focus();
            } else {
                const searchInput = document.getElementById('ledger-search');
                if (searchInput && typeof searchInput.focus === 'function') {
                    searchInput.focus();
                }
            }
        });
    }

    /*
    * 機器台帳から配置先を変更した場合は、
    * 台帳を維持して機器詳細パネルを開かない。
    */
    if (
        !ledgerIsOpen &&
        !removedCurrentView
    ) {
        const currentDevice =
            getDeviceById(device.id);

        if (currentDevice) {
            await openPanel(currentDevice);
        }
    }


    return true;
}


eventBus.on('resources:ids-remapped', maps => {
    const mapped = (kind, id) => id == null ? id : Number(maps[kind]?.[id] ?? id);
    placementManagerDeviceId = mapped('devices', placementManagerDeviceId);
    placementManagerInitialViewIds = new Set([...placementManagerInitialViewIds].map(id => mapped('views', id)));
    placementManagerSelectedViewIds = new Set([...placementManagerSelectedViewIds].map(id => mapped('views', id)));
});
