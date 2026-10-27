/**
 * Netarium - modals/device-search-modal.js
 */

import {
    DEVICE_SEARCH_RESULT_LIMIT,
    DEVICE_TYPES
} from '../core/constants.js';

import { appState } from '../core/state.js';
import { eventBus } from '../core/event-bus.js';
import { getDeviceDestinations, getRackDeviceMounts } from '../core/device-placement.js';
import {
    getDeviceTypeSearchText,
    normalizeMatchText,
    normalizeText,
    setTextContent
} from '../core/utils.js';
import {
    compareViews,
    getDeviceById,
    getPlacementForDeviceInCurrentView
} from '../core/state.js';
import {
    showToast
} from '../ui/toast.js';
import {
    registerModalClose,
    registerModalOpen
} from '../core/modal-focus.js';
import {
    buildViewOptionLabel
} from '../core/view-format.js';
import {
    showDeviceInPlacement
} from '../canvas/renderer.js';
import {
    openLedgerForSearchedDevice
} from './ledger-modal.js';

let deviceSearchResults = [];
let deviceSearchActiveIndex = -1;
let deviceSearchViewDeviceId = null;
let deviceSearchHighlightTimer = null;

function destinationsFor(deviceId) {
    return getDeviceDestinations(deviceId, appState.placements, getRackDeviceMounts(appState), appState.views);
}

function showDestination(device, destination) {
    if (destination.kind === 'rack') {
        eventBus.emit('rack:show-device', { deviceId: Number(device.id), viewId: Number(destination.view.id) });
    } else {
        showDeviceInPlacement(device, destination.placement);
    }
}

eventBus.on('resources:ids-remapped', maps => {
    if (deviceSearchViewDeviceId !== null) {
        deviceSearchViewDeviceId = Number(maps.devices?.[deviceSearchViewDeviceId] ?? deviceSearchViewDeviceId);
    }
});

export function initializeDeviceSearch() {
    const input =
        document.getElementById(
            'device-search-input'
        );

    const clearButton =
        document.getElementById(
            'device-search-clear'
        );

    const searchRoot =
        document.getElementById(
            'device-search'
        );

    if (!input || !clearButton || !searchRoot) {
        return;
    }

    input.addEventListener(
        'input',
        () => {
            renderDeviceSearchResults();
        }
    );

    input.addEventListener(
        'focus',
        () => {
            if (input.value.trim() !== '') {
                renderDeviceSearchResults();
            }
        }
    );

    input.addEventListener(
        'keydown',
        onDeviceSearchKeyDown
    );

    clearButton.addEventListener(
        'click',
        () => {
            clearDeviceSearch(true);
        }
    );

    document.addEventListener(
        'click',
        event => {
            if (
                event.target instanceof Node &&
                !searchRoot.contains(event.target)
            ) {
                closeDeviceSearchPopup();
            }
        }
    );
}


export function getDeviceSearchTerms(value) {
    const normalized =
        normalizeMatchText(value);

    if (!normalized) {
        return [];
    }

    return normalized
        .split(' ')
        .filter(Boolean);
}


export function getDeviceSearchText(device) {
    return normalizeMatchText([
        device.id,
        device.name,
        getDeviceTypeSearchText(device),
        device.ip,
        device.facility,
        device.floor,
        device.location,
        device.manufacturer,
        device.model,
        device.asset_number,
        device.serial_number,
        device.mac_address,
        device.memo,
        device.management_scheme,
        device.management_port,
        device.department,
        device.maintenance_vendor,
        device.install_date,
        device.maintenance_expiry
    ].join(' '));
}


export function getDeviceSearchScore(
    device,
    terms
) {
    const name =
        normalizeMatchText(
            device.name
        );

    const ip =
        normalizeMatchText(
            device.ip
        );

    const idText =
        String(device.id);

    const fullText =
        getDeviceSearchText(device);

    let score = 0;

    terms.forEach(term => {
        if (name === term) {
            score += 500;
        } else if (name.startsWith(term)) {
            score += 250;
        } else if (name.includes(term)) {
            score += 120;
        }

        if (ip === term) {
            score += 450;
        } else if (ip.startsWith(term)) {
            score += 180;
        }

        if (idText === term) {
            score += 300;
        }

        if (fullText.includes(term)) {
            score += 10;
        }
    });

    if (
        getPlacementForDeviceInCurrentView(
            device.id
        )
    ) {
        score += 40;
    }

    return score;
}


export function searchDevices(query) {
    const terms =
        getDeviceSearchTerms(query);

    if (terms.length === 0) {
        return [];
    }

    return appState.devices
        .filter(device => {
            const searchable =
                getDeviceSearchText(device);

            return terms.every(term =>
                searchable.includes(term)
            );
        })
        .map(device => ({
            device,
            score:
                getDeviceSearchScore(
                    device,
                    terms
                )
        }))
        .sort((a, b) => {
            const scoreDifference =
                b.score - a.score;

            if (scoreDifference !== 0) {
                return scoreDifference;
            }

            const nameDifference =
                normalizeText(a.device.name)
                    .localeCompare(
                        normalizeText(
                            b.device.name
                        ),
                        'ja'
                    );

            return nameDifference !== 0
                ? nameDifference
                : Number(a.device.id) -
                    Number(b.device.id);
        });
}


export function renderDeviceSearchResults() {
    const input =
        document.getElementById(
            'device-search-input'
        );

    const popup =
        document.getElementById(
            'device-search-popup'
        );

    const resultList =
        document.getElementById(
            'device-search-results'
        );

    const summary =
        document.getElementById(
            'device-search-summary'
        );

    const clearButton =
        document.getElementById(
            'device-search-clear'
        );

    if (
        !input ||
        !popup ||
        !resultList ||
        !summary ||
        !clearButton
    ) {
        return;
    }

    const query =
        input.value.trim();

    clearButton.hidden =
        query === '';

    resultList.replaceChildren();
    deviceSearchActiveIndex = -1;

    if (query === '') {
        deviceSearchResults = [];
        closeDeviceSearchPopup();
        return;
    }

    const allResults =
        searchDevices(query);

    deviceSearchResults =
        allResults.slice(
            0,
            DEVICE_SEARCH_RESULT_LIMIT
        );

    popup.hidden = false;
    input.setAttribute(
        'aria-expanded',
        'true'
    );

    if (allResults.length === 0) {
        summary.textContent =
            '該当する機器はありません';

        const empty =
            document.createElement('div');

        empty.className =
            'device-search-empty';

        empty.textContent =
            '検索条件を変更してください';

        resultList.appendChild(empty);
        return;
    }

    summary.textContent =
        allResults.length >
        DEVICE_SEARCH_RESULT_LIMIT
            ? `${allResults.length}件中、上位${DEVICE_SEARCH_RESULT_LIMIT}件を表示`
            : `${allResults.length}件`;

    deviceSearchResults.forEach(
        (item, index) => {
            resultList.appendChild(
                createDeviceSearchResult(
                    item.device,
                    index
                )
            );
        }
    );
}


export function createDeviceSearchResult(
    device,
    index
) {
    const button =
        document.createElement('button');

    button.type = 'button';
    button.className =
        'device-search-result';

    button.id =
        `device-search-result-${index}`;

    button.setAttribute(
        'role',
        'option'
    );

    button.setAttribute(
        'aria-selected',
        'false'
    );

    button.dataset.deviceId =
        String(device.id);

    const main =
        document.createElement('span');

    main.className =
        'device-search-result-main';

    const name =
        document.createElement('strong');

    name.textContent =
        device.name ||
        `機器ID ${device.id}`;

    const ip =
        document.createElement('span');

    ip.textContent =
        device.ip || 'IP未設定';

    main.appendChild(name);
    main.appendChild(ip);

    const detail =
        document.createElement('span');

    detail.className =
        'device-search-result-detail';

    const typeLabel =
        (
            DEVICE_TYPES[device.type] ||
            DEVICE_TYPES.other
        ).label;

    const location = [
        device.facility,
        device.floor,
        device.location
    ]
        .map(value =>
            normalizeText(value).trim()
        )
        .filter(Boolean)
        .join(' / ');

    const placementCount = destinationsFor(device.id).length;

    detail.textContent = [
        typeLabel,
        location || '設置場所未設定',
        placementCount > 0
            ? `${placementCount}ビューに配置`
            : '未配置'
    ].join(' | ');

    button.appendChild(main);
    button.appendChild(detail);

    button.addEventListener(
        'mouseenter',
        () => {
            setDeviceSearchActiveIndex(
                index
            );
        }
    );

    button.addEventListener(
        'click',
        () => {
            selectDeviceSearchResult(
                device.id
            );
        }
    );

    return button;
}


export function setDeviceSearchActiveIndex(
    requestedIndex
) {
    const resultElements =
        Array.from(
            document.querySelectorAll(
                '.device-search-result'
            )
        );

    if (resultElements.length === 0) {
        deviceSearchActiveIndex = -1;
        return;
    }

    const normalizedIndex =
        (
            requestedIndex +
            resultElements.length
        ) % resultElements.length;

    deviceSearchActiveIndex =
        normalizedIndex;

    resultElements.forEach(
        (element, index) => {
            const active =
                index ===
                normalizedIndex;

            element.classList.toggle(
                'active',
                active
            );

            element.setAttribute(
                'aria-selected',
                active
                    ? 'true'
                    : 'false'
            );
        }
    );

    const activeElement =
        resultElements[
            normalizedIndex
        ];

    activeElement.scrollIntoView({
        block: 'nearest'
    });

    document
        .getElementById(
            'device-search-input'
        )
        ?.setAttribute(
            'aria-activedescendant',
            activeElement.id
        );
}


export function onDeviceSearchKeyDown(event) {
    if (event.key === 'ArrowDown') {
        event.preventDefault();

        setDeviceSearchActiveIndex(
            deviceSearchActiveIndex + 1
        );

        return;
    }

    if (event.key === 'ArrowUp') {
        event.preventDefault();

        setDeviceSearchActiveIndex(
            deviceSearchActiveIndex - 1
        );

        return;
    }

    if (event.key === 'Enter') {
        event.preventDefault();

        if (
            deviceSearchResults.length === 0
        ) {
            return;
        }

        const index =
            deviceSearchActiveIndex >= 0
                ? deviceSearchActiveIndex
                : 0;

        const device =
            deviceSearchResults[
                index
            ]?.device;

        if (device) {
            selectDeviceSearchResult(
                device.id
            );
        }

        return;
    }

    if (event.key === 'Escape') {
        event.preventDefault();

        if (event.currentTarget.value) {
            clearDeviceSearch(true);
        } else {
            closeDeviceSearchPopup();
            event.currentTarget.blur();
        }
    }
}


export function closeDeviceSearchPopup() {
    const popup =
        document.getElementById(
            'device-search-popup'
        );

    const input =
        document.getElementById(
            'device-search-input'
        );

    if (popup) {
        popup.hidden = true;
    }

    if (input) {
        input.setAttribute(
            'aria-expanded',
            'false'
        );

        input.removeAttribute(
            'aria-activedescendant'
        );
    }

    deviceSearchActiveIndex = -1;
}


export function clearDeviceSearch(
    focusInput = false
) {
    const input =
        document.getElementById(
            'device-search-input'
        );

    const clearButton =
        document.getElementById(
            'device-search-clear'
        );

    if (input) {
        input.value = '';

        if (focusInput) {
            input.focus();
        }
    }

    if (clearButton) {
        clearButton.hidden = true;
    }

    deviceSearchResults = [];
    closeDeviceSearchPopup();
}


export function selectDeviceSearchResult(
    deviceId
) {
    const device =
        getDeviceById(deviceId);

    if (!device) {
        showToast(
            '対象機器が見つかりません',
            'warning'
        );

        return;
    }

    closeDeviceSearchPopup();

    const devicePlacements = destinationsFor(device.id);

    /*
     * どのビューにも配置されていない場合は、
     * 機器台帳を開いて対象行を強調する。
     */
    if (devicePlacements.length === 0) {
        openLedgerForSearchedDevice(
            device.id
        );

        return;
    }

    /*
     * 複数ビューに配置されている場合は、
     * 現在のビューに配置されていても
     * 表示先を選択させる。
     */
    if (devicePlacements.length > 1) {
        openDeviceSearchViewSelector(
            device
        );

        return;
    }

    /*
     * 配置先が1件だけの場合は、
     * そのビューで対象機器を表示する。
     */
    showDestination(
        device,
        devicePlacements[0]
    );
}



export function openDeviceSearchViewSelector(
    device
) {
    const overlay =
        document.getElementById(
            'device-search-view-overlay'
        );

    const list =
        document.getElementById(
            'device-search-view-list'
        );

    if (!overlay || !list) {
        showToast(
            '表示先選択画面が見つかりません',
            'error'
        );

        return;
    }

    deviceSearchViewDeviceId =
        Number(device.id);

    setTextContent(
        'device-search-view-device',
        `${device.name || `機器ID ${device.id}`}${
            device.ip
                ? ` (${device.ip})`
                : ''
        }`
    );

    list.replaceChildren();

    destinationsFor(device.id)
        .sort((a, b) => compareViews(a.view, b.view))
        .forEach(item => {
            const button =
                document.createElement(
                    'button'
                );

            button.type = 'button';
            button.className =
                'device-search-view-option';

            const name =
                document.createElement(
                    'strong'
                );

            name.textContent =
                buildViewOptionLabel(
                    item.view
                );

            const detail =
                document.createElement(
                    'span'
                );

            detail.textContent = item.kind === 'rack' ? 'ラック搭載図' :
                item.view.view_type === 'floor' ? '物理・フロア配置図' : '論理・全体構成図';

            button.appendChild(name);
            button.appendChild(detail);

            button.addEventListener(
                'click',
                () => {
                    const selectedDevice =
                        getDeviceById(
                            deviceSearchViewDeviceId
                        );

                    closeDeviceSearchViewSelector();

                    if (!selectedDevice) {
                        return;
                    }

                    showDestination(selectedDevice, item);
                }
            );

            list.appendChild(button);
        });

    overlay.hidden = false;

    registerModalOpen('device_search', overlay, undefined, { onClose: closeDeviceSearchViewSelector });
}


export function closeDeviceSearchViewSelector() {
    const overlay =
        document.getElementById(
            'device-search-view-overlay'
        );

    if (overlay) {
        overlay.hidden = true;
    }

    registerModalClose('device_search');
    deviceSearchViewDeviceId = null;
}


