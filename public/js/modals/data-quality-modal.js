/**
 * Netarium - modals/data-quality-modal.js
 */

import {
    DASHBOARD_QUALITY_CODES,
    DATA_QUALITY_CATEGORY_LABELS,
    DATA_QUALITY_SEVERITY_LABELS
} from '../core/constants.js';

import { appState } from '../core/state.js';
import { eventBus } from '../core/event-bus.js';
import {
    isCurrentUserAdmin
} from '../ui/access-control.js';
import {
    render,
    showDeviceInPlacement
} from '../canvas/renderer.js';
import {
    closeLinkPanel,
    openLinkPanel,
    openPanel
} from '../ui/property-panel.js';
import {
    showToast
} from '../ui/toast.js';
import {
    registerModalClose,
    registerModalOpen
} from '../core/modal-focus.js';
import {
    buildViewOptionLabel,
    switchView
} from './view-manager-modal.js';
import {
    getPlacementsForDevice
} from '../core/state.js';
import {
    enterPlacementMode
} from '../ui/placement-mode.js';
let isDataQualityLoading = false;

/**
 * 展開状態を保持する問題キーのセット（Phase 2.7D, 2.7I）
 */
export const expandedIssueKeys = new Set();

/**
 * 問題の一意キーを生成する（再診断時の文脈維持用）
 */
export function getIssueKey(issue) {
    const code = String(issue?.code || '');
    const entityType = String(issue?.entity_type || '');
    const entityIds = Array.isArray(issue?.entity_ids)
        ? issue.entity_ids.join(',')
        : '';
    const message = String(issue?.message || '');
    return `${code}:${entityType}:${entityIds}:${message}`;
}

/**
 * 重要度に応じた記号アイコンを返す（色のみに依存しない設計）
 */
export function getDataQualitySeverityIcon(severity) {
    switch (String(severity || '').toLowerCase()) {
        case 'error':
            return '●';
        case 'warning':
            return '▲';
        case 'info':
            return 'ℹ';
        default:
            return '';
    }
}
export function getDataQualitySeverityLabel(
    severity
) {
    return (
        DATA_QUALITY_SEVERITY_LABELS[
            String(severity || '')
        ] ||
        String(severity || '')
    );
}


export function getDataQualityCategoryLabel(
    category
) {
    return (
        DATA_QUALITY_CATEGORY_LABELS[
            String(category || '')
        ] ||
        String(category || 'その他')
    );
}


export function getDataQualityEntityLabel(
    issue
) {
    const entityType =
        String(
            issue?.entity_type || ''
        );

    const ids =
        Array.isArray(issue?.entity_ids)
            ? issue.entity_ids
            : [];

    const prefixLabels = {
        device: '機器ID',
        view: 'ビューID',
        placement: '配置ID',
        link: '接続ID'
    };

    const prefix =
        prefixLabels[entityType] ||
        '対象ID';

    if (ids.length === 0) {
        return '対象IDなし';
    }

    return (
        `${prefix}: ` +
        ids.map(id =>
            String(id)
        ).join(', ')
    );
}


export function formatDataQualityDateTime(
    value
) {
    const text =
        String(value || '');

    if (!text) {
        return '-';
    }

    const date =
        new Date(text);

    if (
        Number.isNaN(
            date.getTime()
        )
    ) {
        return text;
    }

    return date.toLocaleString(
        'ja-JP'
    );
}


export function getDataQualityDetailLines(
    issue
) {
    const details =
        issue?.details &&
        typeof issue.details ===
            'object'
            ? issue.details
            : {};

    const lines = [];

    if (
        Array.isArray(
            details.field_labels
        ) &&
        details.field_labels.length > 0
    ) {
        lines.push(
            '対象項目: ' +
            details.field_labels
                .map(value =>
                    String(value)
                )
                .join('、')
        );
    }

    if (
        details.value !== undefined &&
        details.value !== null &&
        String(details.value) !== ''
    ) {
        lines.push(
            '対象値: ' +
            String(details.value)
        );
    }

    if (
        Array.isArray(details.devices) &&
        details.devices.length > 0
    ) {
        const devicesText =
            details.devices
                .map(device => {
                    const id =
                        String(
                            device?.id ?? ''
                        );

                    const name =
                        String(
                            device?.name || ''
                        );

                    return name
                        ? `ID ${id}: ${name}`
                        : `ID ${id}`;
                })
                .join(' / ');

        lines.push(
            '対象機器: ' +
            devicesText
        );
    }

    if (details.view_name) {
        lines.push(
            '対象ビュー: ' +
            String(details.view_name)
        );
    }

    if (details.original_name) {
        lines.push(
            '図面ファイル: ' +
            String(details.original_name)
        );
    }

    if (
        details.last_checked_at
    ) {
        lines.push(
            '最終確認: ' +
            formatDataQualityDateTime(
                details.last_checked_at
            )
        );
    }

    if (
        details.stale_days !==
            undefined
    ) {
        lines.push(
            '判定基準: ' +
            String(
                details.stale_days
            ) +
            '日'
        );
    }

    if (
        details.device_facility ||
        details.device_floor
    ) {
        lines.push(
            '機器情報: ' +
            [
                details.device_facility,
                details.device_floor
            ]
                .filter(Boolean)
                .map(String)
                .join(' / ')
        );
    }

    if (
        details.view_facility ||
        details.view_floor
    ) {
        lines.push(
            '配置先: ' +
            [
                details.view_facility,
                details.view_floor
            ]
                .filter(Boolean)
                .map(String)
                .join(' / ')
        );
    }

    return lines;
}



export async function fetchDataQuality() {
    const response =
        await fetch(
            'api.php?action=data_quality',
            {
                method: 'GET',
                credentials: 'same-origin',
                cache: 'no-store',
                headers: {
                    Accept:
                        'application/json'
                }
            }
        );

    let data = null;

    try {
        data =
            await response.json();
    } catch (error) {
        throw new Error(
            '診断結果を読み取れません'
        );
    }

    if (
        !response.ok ||
        !data ||
        data.ok !== true
    ) {
        if (response.status === 401 && typeof window.handleAuthExpired === 'function') {
            window.handleAuthExpired();
        }

        const error =
            new Error(
                String(
                    data?.error ||
                    'データ品質診断に失敗しました'
                )
            );

        error.status =
            response.status;

        throw error;
    }

    return data;
}


export function openDataQuality() {
    const overlay =
        document.getElementById(
            'data-quality-overlay'
        );

    if (!overlay) {
        showToast(
            'データ品質診断画面が見つかりません',
            'error'
        );

        return;
    }

    if (!overlay.hidden) {
        return;
    }

    const activeElement =
        document.activeElement;

    appState.dataQualityPreviousFocus =
        activeElement instanceof HTMLElement
            ? activeElement
            : null;

    document
        .querySelectorAll('.toolbar-menu[open]')
        .forEach(menu => {
            menu.open = false;
        });

    appState.dataQualitySeverityFilter = '';
    appState.dataQualityCategoryFilter = '';
    appState.dataQualityCodeFilter = [];

    overlay.hidden = false;

    renderDataQuality();
    registerModalOpen('data_quality', overlay, '#data-quality-refresh-btn', { onClose: closeDataQuality });
    focusDataQualityDialog();
    refreshDataQuality();
}



export function closeDataQuality() {
    const overlay =
        document.getElementById(
            'data-quality-overlay'
        );

    if (
        !overlay ||
        overlay.hidden
    ) {
        return;
    }

    overlay.hidden = true;
    registerModalClose('data_quality');
    const previousFocus = appState.dataQualityPreviousFocus;
    appState.dataQualityPreviousFocus = null;
    if (
        previousFocus instanceof HTMLElement &&
        previousFocus.isConnected
    ) {
        window.requestAnimationFrame(
            () => {
                previousFocus.focus();
            }
        );
    }
}



export function hideDataQualityForNavigation() {
    const overlay =
        document.getElementById(
            'data-quality-overlay'
        );

    if (overlay) {
        overlay.hidden = true;
    }

    /*
     * 遷移先が自分でフォーカスを設定するため、
     * 元のメニューボタンへは戻さない。
     */
    appState.dataQualityPreviousFocus = null;
}



export function normalizeDataQualityIds(
    values
) {
    if (!Array.isArray(values)) {
        return [];
    }

    return Array.from(
        new Set(
            values
                .map(value =>
                    Number(value)
                )
                .filter(value =>
                    Number.isInteger(value) &&
                    value > 0
                )
        )
    );
}


export function getDataQualityDeviceIds(
    issue
) {
    const ids = [];

    if (
        String(
            issue?.entity_type || ''
        ) === 'device'
    ) {
        ids.push(
            ...normalizeDataQualityIds(
                issue?.entity_ids
            )
        );
    }

    const details =
        issue?.details &&
        typeof issue.details ===
            'object'
            ? issue.details
            : {};

    if (
        Array.isArray(
            details.device_ids
        )
    ) {
        ids.push(
            ...normalizeDataQualityIds(
                details.device_ids
            )
        );
    }

    if (
        Array.isArray(
            details.missing_device_ids
        )
    ) {
        ids.push(
            ...normalizeDataQualityIds(
                details.missing_device_ids
            )
        );
    }

    if (
        details.device_id !==
            undefined
    ) {
        ids.push(
            ...normalizeDataQualityIds([
                details.device_id
            ])
        );
    }

    if (
        Array.isArray(details.devices)
    ) {
        ids.push(
            ...normalizeDataQualityIds(
                details.devices.map(
                    device =>
                        device?.id
                )
            )
        );
    }

    return Array.from(
        new Set(ids)
    ).filter(deviceId =>
        Boolean(
            findDataQualityDevice(
                deviceId
            )
        )
    );
}


export function getDataQualityViewIds(
    issue
) {
    const ids = [];

    if (
        String(
            issue?.entity_type || ''
        ) === 'view'
    ) {
        ids.push(
            ...normalizeDataQualityIds(
                issue?.entity_ids
            )
        );
    }

    const details =
        issue?.details &&
        typeof issue.details ===
            'object'
            ? issue.details
            : {};

    if (
        details.view_id !==
            undefined
    ) {
        ids.push(
            ...normalizeDataQualityIds([
                details.view_id
            ])
        );
    }

    return Array.from(
        new Set(ids)
    ).filter(viewId =>
        Boolean(
            findDataQualityView(
                viewId
            )
        )
    );
}


export function findDataQualityDevice(
    deviceId
) {
    const normalizedId =
        Number(deviceId);

    return appState.devices.find(device =>
        Number(device.id) ===
            normalizedId
    ) || null;
}


export function findDataQualityView(
    viewId
) {
    const normalizedId =
        Number(viewId);

    return appState.views.find(view =>
        Number(view.id) ===
            normalizedId
    ) || null;
}


export function getDataQualityDeviceName(
    deviceId
) {
    const device =
        findDataQualityDevice(
            deviceId
        );

    if (!device) {
        return `機器ID ${deviceId}`;
    }

    const name =
        String(
            device.name || ''
        ).trim();

    return name
        ? `${name}（ID ${device.id}）`
        : `機器ID ${device.id}`;
}


export function getDataQualityViewName(
    viewId
) {
    const view =
        findDataQualityView(
            viewId
        );

    if (!view) {
        return `ビューID ${viewId}`;
    }

    if (
        typeof buildViewOptionLabel ===
            'function'
    ) {
        return buildViewOptionLabel(
            view
        );
    }

    const name =
        String(view.name || '').trim();

    return name
        ? `${name}（ID ${view.id}）`
        : `ビューID ${view.id}`;
}

/**
 * 問題の対象を要約した短いテキストを生成する（Phase 2.7D）
 */
export function getDataQualityTargetSummary(issue) {
    const deviceIds = getDataQualityDeviceIds(issue);
    const viewIds = getDataQualityViewIds(issue);

    if (deviceIds.length > 0) {
        if (deviceIds.length === 1) {
            const name = getDataQualityDeviceName(deviceIds[0]);
            return `対象機器: ${name}`;
        }
        const firstNames = deviceIds
            .slice(0, 3)
            .map(id => getDataQualityDeviceName(id))
            .join(', ');
        const remaining = deviceIds.length - 3;
        return remaining > 0
            ? `対象機器 (${deviceIds.length}台): ${firstNames} 他${remaining}台`
            : `対象機器 (${deviceIds.length}台): ${firstNames}`;
    }

    if (viewIds.length > 0) {
        if (viewIds.length === 1) {
            const name = getDataQualityViewName(viewIds[0]);
            return `対象ビュー: ${name}`;
        }
        const firstNames = viewIds
            .slice(0, 2)
            .map(id => getDataQualityViewName(id))
            .join(', ');
        const remaining = viewIds.length - 2;
        return remaining > 0
            ? `対象ビュー (${viewIds.length}件): ${firstNames} 他${remaining}件`
            : `対象ビュー (${viewIds.length}件): ${firstNames}`;
    }

    if (issue?.entity_type === 'link') {
        const linkIds = Array.isArray(issue?.entity_ids)
            ? issue.entity_ids
            : [];
        if (linkIds.length > 0) {
            return `対象接続: ID ${linkIds.join(', ')}`;
        }
    }

    return getDataQualityEntityLabel(issue);
}


export function getDataQualityDialog() {
    return document.querySelector(
        '#data-quality-overlay ' +
        '.data-quality-dialog'
    );
}


export function getDataQualityFocusableElements() {
    const dialog =
        getDataQualityDialog();

    if (!dialog) {
        return [];
    }

    return Array.from(
        dialog.querySelectorAll(
            'button:not([disabled]), ' +
            '[href], ' +
            'input:not([disabled]), ' +
            'select:not([disabled]), ' +
            'textarea:not([disabled]), ' +
            '[tabindex]:not([tabindex="-1"])'
        )
    ).filter(element => {
        if (!(element instanceof HTMLElement)) {
            return false;
        }

        return (
            !element.hidden &&
            element.offsetParent !== null &&
            element.getAttribute(
                'aria-hidden'
            ) !== 'true'
        );
    });
}


export function focusDataQualityDialog() {
    window.requestAnimationFrame(
        () => {
            const refreshButton =
                document.getElementById(
                    'data-quality-refresh-btn'
                );

            const dialog =
                getDataQualityDialog();

            if (
                refreshButton &&
                !refreshButton.disabled
            ) {
                refreshButton.focus();
                return;
            }

            const focusable =
                getDataQualityFocusableElements();

            if (focusable.length > 0) {
                focusable[0].focus();
                return;
            }

            dialog?.focus();
        }
    );
}



export async function openDataQualityDeviceDetail(
    deviceId
) {
    if (
        !confirmDataQualityNavigation()
    ) {
        return;
    }
    const device =
        findDataQualityDevice(
            deviceId
        );

    if (!device) {
        showToast(
            '対象機器が現在の画面データに見つかりません',
            'warning'
        );

        return;
    }

    const devicePlacements =
        getPlacementsForDevice(
            device.id
        );

    const currentPlacement =
        devicePlacements.find(
            placement =>
                Number(
                    placement.view_id
                ) ===
                    Number(
                        appState.currentViewId
                    )
        );


    if (currentPlacement) {
        if (!await showDeviceInPlacement(
            device,
            currentPlacement
        )) return;
        hideDataQualityForNavigation();
        return;
    }

    if (
        devicePlacements.length > 0
    ) {
        if (!await showDeviceInPlacement(
            device,
            devicePlacements[0]
        )) return;
        hideDataQualityForNavigation();
        return;
    }

    if (!await openPanel(device)) {
        return;
    }
    hideDataQualityForNavigation();

    appState.selectedPlacementIds.clear();

    render();

}


export async function openDataQualityDevicePlacement(
    deviceId,
    viewId = null
) {

    if (
        !confirmDataQualityNavigation()
    ) {
        return;
    }

    const device =
        findDataQualityDevice(
            deviceId
        );

    if (!device) {
        showToast(
            '対象機器が現在の画面データに見つかりません',
            'warning'
        );

        return;
    }

    const devicePlacements =
        getPlacementsForDevice(
            device.id
        );

    if (
        devicePlacements.length === 0
    ) {
        showToast(
            'この機器はどのビューにも配置されていません',
            'warning'
        );

        return;
    }

    let targetPlacement = null;

    if (
        Number.isInteger(
            Number(viewId)
        ) &&
        Number(viewId) > 0
    ) {
        targetPlacement =
            devicePlacements.find(
                placement =>
                    Number(
                        placement.view_id
                    ) ===
                        Number(viewId)
            ) || null;
    }

    if (!targetPlacement) {
        targetPlacement =
            devicePlacements.find(
                placement =>
                    Number(
                        placement.view_id
                    ) ===
                        Number(
                            appState.currentViewId
                        )
            ) ||
            devicePlacements[0];
    }

    if (!await showDeviceInPlacement(
        device,
        targetPlacement
    )) {
        return;
    }

    hideDataQualityForNavigation();
}


export async function openDataQualityView(
    viewId
) {
    if (
        !confirmDataQualityNavigation()
    ) {
        return;
    }
    const view =
        findDataQualityView(
            viewId
        );

    if (!view) {
        showToast(
            '対象ビューが現在の画面データに見つかりません',
            'warning'
        );

        return;
    }

    if (
        Number(appState.currentViewId) !==
            Number(view.id)
    ) {
        if (!await switchView(
            Number(view.id)
        )) {
            return;
        }
    } else {
        render();
    }
    hideDataQualityForNavigation();

}


/**
 * データ品質管理の表示を維持したまま、前面に機器個票を開く（Phase 2.7E 連続修正導線）
 */
export function openDataQualityDeviceInSheet(deviceId, field = null) {
    const device = findDataQualityDevice(deviceId);
    if (!device) {
        showToast('対象機器が現在の画面データに見つかりません', 'warning');
        return;
    }

    eventBus.emit('ledger:open-device-sheet', {
        deviceId: device.id,
        field: field
    });
}
/**
 * 未配置機器の修正導線：配置フローへ接続（Phase 2.7F）
 */
export async function openDataQualityDevicePlacementFlow(issue) {
    if (!confirmDataQualityNavigation()) {
        return;
    }

    const deviceIds = getDataQualityDeviceIds(issue);
    if (deviceIds.length === 0) {
        showToast('対象機器が見つかりません', 'warning');
        return;
    }

    if (!isCurrentUserAdmin()) {
        // 一般ユーザーは台帳で確認へ安全に縮退
        eventBus.emit('ledger:open-data-quality-device', deviceIds[0]);
        return;
    }

    if (appState.currentViewId !== null) {
        if (!await enterPlacementMode({
            tab: 'unplaced',
            initialDeviceIds: deviceIds
        })) {
            return;
        }
        hideDataQualityForNavigation();
    } else {
        // 現在ビューがない場合は台帳へ
        hideDataQualityForNavigation();
        eventBus.emit('ledger:open-data-quality-device', deviceIds[0]);
    }
}

/**
 * 接続問題の修正導線：対象ビュー・接続へ移動（Phase 2.7G）
 */
export async function openDataQualityLinkFlow(issue) {
    if (!confirmDataQualityNavigation()) {
        return;
    }

    const linkId = Number(
        issue?.details?.link_id ||
        (Array.isArray(issue?.details?.link_ids) && issue.details.link_ids.length > 0
            ? issue.details.link_ids[0]
            : (issue?.entity_type === 'link' && Array.isArray(issue?.entity_ids) && issue.entity_ids.length > 0
                ? issue.entity_ids[0]
                : 0))
    );

    const link = linkId > 0
        ? (appState.links || []).find(l => Number(l.id) === linkId) || null
        : null;

    const viewIds = getDataQualityViewIds(issue);
    const viewId =
        Number(link?.view_id || 0) ||
        (viewIds.length > 0 ? viewIds[0] : Number(issue?.details?.view_id || 0));

    if (viewId > 0 && Number(appState.currentViewId) !== Number(viewId)) {
        if (!await switchView(Number(viewId))) return;
    }

    if (link) {
        if (!await openLinkPanel(link)) return;
        hideDataQualityForNavigation();
        render();
        return;
    }

    hideDataQualityForNavigation();

    const deviceIds = getDataQualityDeviceIds(issue);
    if (deviceIds.length > 0) {
        const device = findDataQualityDevice(deviceIds[0]);
        if (device) {
            const placement = getPlacementsForDevice(device.id).find(
                p => Number(p.view_id) === Number(appState.currentViewId)
            );
            if (placement) {
                showDeviceInPlacement(device, placement);
                return;
            }
        }
    }

}

/**
 * 診断イシューから最初に対象とすべきフィールド名を取得する（Phase 2.7E）
 */
export function getDataQualityTargetField(issue) {
    if (Array.isArray(issue?.details?.fields) && issue.details.fields.length > 0) {
        return String(issue.details.fields[0]);
    }
    if (issue?.details?.field) {
        return String(issue.details.field);
    }
    return null;
}

/**
 * 診断結果ごとの主操作（Primary Action）を決定する（Phase 2.7E）
 */
export function getDataQualityPrimaryAction(issue) {
    const code = String(issue?.code || '');
    const category = String(issue?.category || '');
    const deviceIds = getDataQualityDeviceIds(issue);
    const viewIds = getDataQualityViewIds(issue);
    const isAdmin = isCurrentUserAdmin();

    // 1. 未配置機器
    if (code === DASHBOARD_QUALITY_CODES.unplacedDevice || code === 'unplaced_device') {
        if (isAdmin) {
            return {
                label: '配置する',
                action: () => openDataQualityDevicePlacementFlow(issue),
                title: '未配置機器を現在のビューへ配置します'
            };
        }
        return {
            label: '台帳で確認',
            action: () => {
                if (deviceIds.length > 0) {
                    eventBus.emit('ledger:open-data-quality-device', deviceIds[0]);
                }
            },
            title: '機器台帳で機器情報を確認します'
        };
    }

    // 2. 必須項目不足
    if (code === DASHBOARD_QUALITY_CODES.missingRequiredFields || code === 'missing_required_fields') {
        const field = getDataQualityTargetField(issue);
        return {
            label: isAdmin ? '台帳で修正' : '台帳で確認',
            action: () => {
                if (deviceIds.length > 0) {
                    openDataQualityDeviceInSheet(deviceIds[0], field);
                }
            },
            title: isAdmin ? '機器個票を開いて必須項目を入力します' : '機器個票で必須項目を確認します'
        };
    }

    // 3. 推奨項目不足
    if (code === DASHBOARD_QUALITY_CODES.missingRecommendedFields || code === 'missing_recommended_fields') {
        const field = getDataQualityTargetField(issue);
        return {
            label: '台帳で確認',
            action: () => {
                if (deviceIds.length > 0) {
                    openDataQualityDeviceInSheet(deviceIds[0], field);
                }
            },
            title: '機器個票を開いて推奨項目を確認します'
        };
    }

    // 4. 重複系（名称、IP、資産番号、MAC）
    if (category === 'duplicate' || code.startsWith('duplicate_')) {
        if (code === 'duplicate_link') {
            return {
                label: '接続を確認',
                action: () => openDataQualityLinkFlow(issue),
                title: '重複接続が存在するビューへ移動します'
            };
        }
        return {
            label: isAdmin ? '台帳で修正' : '台帳で確認',
            action: () => {
                if (deviceIds.length > 0) {
                    openDataQualityDeviceInSheet(deviceIds[0]);
                }
            },
            title: isAdmin ? '機器個票で重複した機器情報を修正します' : '機器個票で重複情報を確認します'
        };
    }

    // 5. フロア図面未登録
    if (code === DASHBOARD_QUALITY_CODES.floorViewWithoutPlan || code === 'floor_view_without_plan') {
        const targetViewId = viewIds.length > 0 ? viewIds[0] : Number(issue?.details?.view_id || 0);
        if (isAdmin) {
            return {
                label: '図面を登録',
                action: () => {
                    if (targetViewId > 0) {
                        eventBus.emit('floor-plan:open-data-quality', targetViewId);
                    }
                },
                title: '対象フロアビューへ移動して図面管理を開きます'
            };
        }
        return {
            label: 'ビューを表示',
            action: () => {
                if (targetViewId > 0) {
                    openDataQualityView(targetViewId);
                }
            },
            title: '対象フロアビューへ移動します'
        };
    }

    // 6. フロア図面非表示
    if (code === 'floor_plan_hidden') {
        const targetViewId = viewIds.length > 0 ? viewIds[0] : Number(issue?.details?.view_id || 0);
        return {
            label: '図面を確認',
            action: () => {
                if (targetViewId > 0) {
                    eventBus.emit('floor-plan:open-data-quality', targetViewId);
                }
            },
            title: '対象フロアビューへ移動して図面の表示状態を確認します'
        };
    }

    // 7. 配置情報不整合（フロア相違、孤立配置等）
    if (code === 'floor_mismatch') {
        const targetViewId = Number(issue?.details?.view_id || 0) || (viewIds.length > 0 ? viewIds[0] : null);
        return {
            label: '配置を確認',
            action: () => {
                if (deviceIds.length > 0) {
                    openDataQualityDevicePlacement(deviceIds[0], targetViewId);
                }
            },
            title: '配置先のフロアビューで機器の配置を確認します'
        };
    }

    if (code === 'orphan_placement_device' || code === 'orphan_placement_view') {
        return {
            label: '配置を確認',
            action: () => {
                if (viewIds.length > 0) {
                    openDataQualityView(viewIds[0]);
                } else if (deviceIds.length > 0) {
                    eventBus.emit('ledger:open-data-quality-device', deviceIds[0]);
                }
            },
            title: '配置情報を確認します'
        };
    }

    // 8. 接続不整合
    if (
        category === 'integrity' ||
        code.startsWith('orphan_link_') ||
        code === 'link_endpoint_not_placed'
    ) {
        return {
            label: '接続を確認',
            action: () => openDataQualityLinkFlow(issue),
            title: '接続問題が存在するビューへ移動します'
        };
    }

    // 9. 書式不正（MAC、管理方式、ポート、設置日、保守期限等）
    if (category === 'format') {
        return {
            label: isAdmin ? '台帳で修正' : '台帳で確認',
            action: () => {
                if (deviceIds.length > 0) {
                    openDataQualityDeviceInSheet(deviceIds[0]);
                }
            },
            title: isAdmin ? '機器個票で書式エラーの項目を修正します' : '機器個票で項目を確認します'
        };
    }

    // 10. 保守情報
    if (category === 'maintenance') {
        return {
            label: '台帳で確認',
            action: () => {
                if (deviceIds.length > 0) {
                    openDataQualityDeviceInSheet(deviceIds[0]);
                }
            },
            title: '機器個票で保守期限を確認します'
        };
    }

    // 11. 監視状態
    if (category === 'monitoring') {
        return {
            label: '対象を確認',
            action: () => {
                if (deviceIds.length > 0) {
                    openDataQualityDeviceDetail(deviceIds[0]);
                }
            },
            title: '機器詳細で監視状態を確認します'
        };
    }

    // 12. 機器名類似などの名称
    if (category === 'naming') {
        return {
            label: '台帳で確認',
            action: () => {
                if (deviceIds.length > 0) {
                    openDataQualityDeviceInSheet(deviceIds[0]);
                }
            },
            title: '機器個票で機器名を確認します'
        };
    }

    // デフォルトフォールバック
    if (deviceIds.length > 0) {
        return {
            label: '台帳で確認',
            action: () => {
                openDataQualityDeviceInSheet(deviceIds[0]);
            },
            title: '機器個票で対象機器を確認します'
        };
    }

    if (viewIds.length > 0) {
        return {
            label: 'ビューへ移動',
            action: () => {
                openDataQualityView(viewIds[0]);
            },
            title: '対象ビューへ移動します'
        };
    }

    return null;
}


export function createDataQualityActionButton(
    label,
    handler,
    className = ''
) {
    const button =
        document.createElement(
            'button'
        );

    button.type = 'button';
    button.className =
        [
            'data-quality-action-button',
            className
        ]
            .filter(Boolean)
            .join(' ');

    button.textContent =
        String(label);

    button.addEventListener(
        'click',
        event => {
            event.preventDefault();
            event.stopPropagation();
            handler();
        }
    );

    return button;
}


export function createDataQualityDeviceActionRow(
    deviceId,
    issue
) {
    const row =
        document.createElement(
            'div'
        );

    row.className =
        'data-quality-target-row';

    const label =
        document.createElement(
            'strong'
        );

    label.className =
        'data-quality-target-label';

    label.textContent =
        getDataQualityDeviceName(
            deviceId
        );

    const buttons =
        document.createElement(
            'div'
        );

    buttons.className =
        'data-quality-target-actions';

    buttons.appendChild(
        createDataQualityActionButton(
            '機器詳細',
            () => {
                openDataQualityDeviceDetail(
                    deviceId
                );
            }
        )
    );

    buttons.appendChild(
        createDataQualityActionButton(
            '台帳で表示',
            () => {
                eventBus.emit(
                    'ledger:open-data-quality-device',
                    deviceId
                );
            }
        )
    );

    const placements =
        getPlacementsForDevice(
            deviceId
        );

    if (placements.length > 0) {
        const preferredViewId =
            Number(
                issue?.details?.view_id ||
                0
            );

        buttons.appendChild(
            createDataQualityActionButton(
                placements.length > 1
                    ? '配置先へ'
                    : '配置を表示',
                () => {
                    openDataQualityDevicePlacement(
                        deviceId,
                        preferredViewId > 0
                            ? preferredViewId
                            : null
                    );
                },
                'data-quality-action-primary'
            )
        );
    }

    row.append(
        label,
        buttons
    );

    return row;
}


export function createDataQualityViewActionRow(
    viewId
) {
    const row =
        document.createElement(
            'div'
        );

    row.className =
        'data-quality-target-row';

    const label =
        document.createElement(
            'strong'
        );

    label.className =
        'data-quality-target-label';

    label.textContent =
        getDataQualityViewName(
            viewId
        );

    const buttons =
        document.createElement(
            'div'
        );

    buttons.className =
        'data-quality-target-actions';

    buttons.appendChild(
        createDataQualityActionButton(
            'ビューへ移動',
            () => {
                openDataQualityView(
                    viewId
                );
            },
            'data-quality-action-primary'
        )
    );

    const view =
        findDataQualityView(
            viewId
        );

    if (
        isCurrentUserAdmin() &&
        String(
            view?.view_type || ''
        ) === 'floor'
    ) {
        buttons.appendChild(
            createDataQualityActionButton(
                '図面管理',
                () => {
                    eventBus.emit(
                        'floor-plan:open-data-quality',
                        viewId
                    );
                }
            )
        );
    }

    row.append(
        label,
        buttons
    );

    return row;
}


export function createDataQualityIssueActions(
    issue
) {
    const deviceIds =
        getDataQualityDeviceIds(
            issue
        );

    const viewIds =
        getDataQualityViewIds(
            issue
        );

    if (
        deviceIds.length === 0 &&
        viewIds.length === 0
    ) {
        return null;
    }

    const section =
        document.createElement(
            'section'
        );

    section.className =
        'data-quality-actions';

    const heading =
        document.createElement(
            'h5'
        );

    heading.textContent =
        (
            deviceIds.length +
            viewIds.length
        ) > 1
            ? '対象ごとの操作'
            : '対象を確認';

    section.appendChild(
        heading
    );

    const list =
        document.createElement(
            'div'
        );

    list.className =
        'data-quality-target-list';

    deviceIds.forEach(
        deviceId => {
            list.appendChild(
                createDataQualityDeviceActionRow(
                    deviceId,
                    issue
                )
            );
        }
    );

    viewIds.forEach(
        viewId => {
            list.appendChild(
                createDataQualityViewActionRow(
                    viewId
                )
            );
        }
    );

    section.appendChild(list);

    return section;
}



export async function refreshDataQuality() {
    if (isDataQualityLoading) {
        return;
    }

    // 再診断前のスクロール位置を退避（Phase 2.7I）
    const bodyEl = document.querySelector('.data-quality-body');
    const listEl = document.getElementById('data-quality-issue-list');
    const savedBodyScroll = bodyEl ? bodyEl.scrollTop : 0;
    const savedListScroll = listEl ? listEl.scrollTop : 0;

    isDataQualityLoading = true;

    updateDataQualityLoadingState(
        true
    );

    try {
        appState.dataQualityResult =
            await fetchDataQuality();

        renderDataQuality();

        // スクロール位置を復元
        window.requestAnimationFrame(() => {
            if (bodyEl && savedBodyScroll > 0) {
                bodyEl.scrollTop = savedBodyScroll;
            }
            if (listEl && savedListScroll > 0) {
                listEl.scrollTop = savedListScroll;
            }
        });
    } catch (error) {
        console.error(error);

        appState.dataQualityResult = null;

        renderDataQualityError(
            error.message ||
            'データ品質診断に失敗しました'
        );

    } finally {
        isDataQualityLoading = false;

        updateDataQualityLoadingState(
            false
        );
    }
}


export function updateDataQualityLoadingState(
    loading
) {
    const refreshButton =
        document.getElementById(
            'data-quality-refresh-btn'
        );

    const status =
        document.getElementById(
            'data-quality-status'
        );

    const list =
        document.getElementById(
            'data-quality-issue-list'
        );

    if (refreshButton) {
        refreshButton.disabled =
            loading;

        refreshButton.textContent =
            loading
                ? '診断中...'
                : '再診断';
    }

    if (loading && status) {
        status.hidden = false;
        status.className =
            'data-quality-status is-loading';
        status.textContent =
            'データ品質を診断しています...';
    }

    if (loading && list) {
        list.hidden = true;
    }

    document
        .querySelectorAll(
            '#data-quality-overlay ' +
            '.data-quality-action-button'
        )
        .forEach(button => {
            button.disabled = loading;
        });

}


export function handleDataQualityDialogKeydown(
    event
) {
    const overlay =
        document.getElementById(
            'data-quality-overlay'
        );

    if (
        !overlay ||
        overlay.hidden
    ) {
        return false;
    }

    // 個票モーダルが前面に開いている場合は、個票側のEscape/キー処理に譲る
    const sheetOverlay =
        document.getElementById(
            'ledger-device-sheet-overlay'
        );
    if (
        sheetOverlay &&
        !sheetOverlay.hidden
    ) {
        return false;
    }

    if (event.key !== 'Tab') {
        return false;
    }

    const focusable =
        getDataQualityFocusableElements();

    if (focusable.length === 0) {
        event.preventDefault();

        getDataQualityDialog()
            ?.focus();

        return true;
    }

    const first =
        focusable[0];

    const last =
        focusable[
            focusable.length - 1
        ];

    const active =
        document.activeElement;

    if (
        event.shiftKey &&
        (
            active === first ||
            !getDataQualityDialog()
                ?.contains(active)
        )
    ) {
        event.preventDefault();
        last.focus();

        return true;
    }

    if (
        !event.shiftKey &&
        (
            active === last ||
            !getDataQualityDialog()
                ?.contains(active)
        )
    ) {
        event.preventDefault();
        first.focus();

        return true;
    }

    return false;
}



export function setDataQualityCount(
    id,
    value
) {
    const element =
        document.getElementById(id);

    if (element) {
        element.textContent =
            String(
                Number(value || 0)
            );
    }
}


export function renderDataQualitySummary() {
    const summary =
        appState.dataQualityResult?.summary ||
        {};

    setDataQualityCount(
        'data-quality-error-count',
        summary.error
    );

    setDataQualityCount(
        'data-quality-warning-count',
        summary.warning
    );

    setDataQualityCount(
        'data-quality-info-count',
        summary.info
    );

    setDataQualityCount(
        'data-quality-total-count',
        summary.total
    );

    document
        .querySelectorAll(
            '[data-quality-severity]'
        )
        .forEach(card => {
            const active =
                String(
                    card.dataset
                        .qualitySeverity ||
                    ''
                ) ===
                    appState.dataQualitySeverityFilter;

            card.classList.toggle(
                'is-active',
                active
            );

            card.setAttribute(
                'aria-pressed',
                active
                    ? 'true'
                    : 'false'
            );
        });

}

/**
 * 診断コードの指定を安全な一意配列へ変換する。
 */

/**
 * 診断コードの指定を安全な一意配列へ変換する。
 */
export function normalizeDataQualityCodeFilter(
    codes
) {
    const source =
        Array.isArray(codes)
            ? codes
            : (
                codes
                    ? [codes]
                    : []
            );

    return Array.from(
        new Set(
            source
                .map(code =>
                    String(
                        code || ''
                    ).trim()
                )
                .filter(Boolean)
        )
    );
}

/**
 * ダッシュボード遷移用の診断条件名を返す。
 */

/**
 * ダッシュボード遷移用の診断条件名を返す。
 */
export function getDataQualityCodeFilterLabel(
    codes =
        appState.dataQualityCodeFilter
) {
    const normalizedCodes =
        normalizeDataQualityCodeFilter(
            codes
        );

    if (
        normalizedCodes.length === 1 &&
        normalizedCodes[0] ===
            DASHBOARD_QUALITY_CODES
                .unplacedDevice
    ) {
        return '未配置機器';
    }

    if (
        normalizedCodes.length === 1 &&
        normalizedCodes[0] ===
            DASHBOARD_QUALITY_CODES
                .floorViewWithoutPlan
    ) {
        return '図面未登録';
    }

    const incompleteCodes =
        new Set([
            DASHBOARD_QUALITY_CODES
                .missingRequiredFields,

            DASHBOARD_QUALITY_CODES
                .missingRecommendedFields
        ]);

    if (
        normalizedCodes.length === 2 &&
        normalizedCodes.every(code =>
            incompleteCodes.has(code)
        )
    ) {
        return '入力不足機器';
    }

    if (normalizedCodes.length > 0) {
        return '指定された問題';
    }

    return '';
}

/**
 * 絞り込み条件チップを描画する（Phase 2.7C）
 */
export function renderDataQualityFilterChips() {
    const container =
        document.getElementById(
            'data-quality-filter-chips'
        );
    const clearBtn =
        document.getElementById(
            'data-quality-clear-filter-btn'
        );

    if (!container) {
        return;
    }

    container.replaceChildren();

    const chips = [];

    // Severity chip
    if (appState.dataQualitySeverityFilter) {
        const severity =
            appState.dataQualitySeverityFilter;
        const icon =
            getDataQualitySeverityIcon(severity);
        const label =
            getDataQualitySeverityLabel(severity);
        chips.push({
            type: 'severity',
            label: `${icon} ${label}`.trim(),
            onRemove: () => {
                selectDataQualitySeverity('');
            }
        });
    }

    // Category chip
    if (appState.dataQualityCategoryFilter) {
        const category =
            appState.dataQualityCategoryFilter;
        const label =
            getDataQualityCategoryLabel(category);
        chips.push({
            type: 'category',
            label: label,
            onRemove: () => {
                appState.dataQualityCategoryFilter = '';
                renderDataQuality();
            }
        });
    }

    // Code chip
    const normalizedCodes =
        normalizeDataQualityCodeFilter(
            appState.dataQualityCodeFilter
        );
    if (normalizedCodes.length > 0) {
        const label =
            getDataQualityCodeFilterLabel(
                normalizedCodes
            ) || '問題指定';
        chips.push({
            type: 'code',
            label: label,
            onRemove: () => {
                appState.dataQualityCodeFilter = [];
                renderDataQuality();
            }
        });
    }

    const hasFilters = chips.length > 0;
    if (clearBtn) {
        clearBtn.disabled = !hasFilters;
    }

    if (chips.length === 0) {
        container.hidden = true;
        return;
    }

    container.hidden = false;

    const prefix =
        document.createElement('span');
    prefix.className =
        'data-quality-filter-chips-label';
    prefix.textContent = '絞り込み:';
    container.appendChild(prefix);

    chips.forEach(chip => {
        const chipEl =
            document.createElement('span');
        chipEl.className =
            `data-quality-filter-chip data-quality-filter-chip-${chip.type}`;

        const textEl =
            document.createElement('span');
        textEl.className =
            'data-quality-filter-chip-text';
        textEl.textContent = chip.label;
        chipEl.appendChild(textEl);

        const removeBtn =
            document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className =
            'data-quality-filter-chip-remove';
        removeBtn.textContent = '×';
        removeBtn.setAttribute(
            'aria-label',
            `「${chip.label}」の絞り込みを解除`
        );
        removeBtn.addEventListener(
            'click',
            event => {
                event.preventDefault();
                event.stopPropagation();
                chip.onRemove();
            }
        );
        chipEl.appendChild(removeBtn);

        container.appendChild(chipEl);
    });
}



export function getFilteredDataQualityIssues() {
    const issues =
        Array.isArray(
            appState.dataQualityResult?.issues
        )
            ? appState.dataQualityResult.issues
            : [];

    const codeSet =
        new Set(
            normalizeDataQualityCodeFilter(
                appState.dataQualityCodeFilter
            )
        );

    return issues.filter(issue => {
        if (
            appState.dataQualitySeverityFilter &&
            String(issue?.severity || '') !==
                appState.dataQualitySeverityFilter
        ) {
            return false;
        }

        if (
            appState.dataQualityCategoryFilter &&
            String(issue?.category || '') !==
                appState.dataQualityCategoryFilter
        ) {
            return false;
        }

        if (
            codeSet.size > 0 &&
            !codeSet.has(
                String(
                    issue?.code || ''
                )
            )
        ) {
            return false;
        }

        return true;
    });
}


export function renderDataQualityCategories() {
    const container =
        document.getElementById(
            'data-quality-category-list'
        );

    if (!container) {
        return;
    }

    const codeSet =
        new Set(
            normalizeDataQualityCodeFilter(
                appState.dataQualityCodeFilter
            )
        );

    const issues =
        (
            Array.isArray(
                appState.dataQualityResult?.issues
            )
                ? appState.dataQualityResult.issues
                : []
        ).filter(issue =>
            codeSet.size === 0 ||
            codeSet.has(
                String(
                    issue?.code || ''
                )
            )
        );

    const counts = {};

    issues.forEach(issue => {
        if (
            appState.dataQualitySeverityFilter &&
            String(issue?.severity || '') !==
                appState.dataQualitySeverityFilter
        ) {
            return;
        }

        const category =
            String(
                issue?.category ||
                'other'
            );

        counts[category] =
            (counts[category] || 0) +
            1;
    });

    // 選択中のカテゴリは件数0でも解除・確認できるよう表示を保持（Phase 2.7C）
    if (
        appState.dataQualityCategoryFilter &&
        !counts[appState.dataQualityCategoryFilter]
    ) {
        counts[appState.dataQualityCategoryFilter] = 0;
    }

    const categories =
        Object.keys(counts)
            .sort((left, right) =>
                getDataQualityCategoryLabel(
                    left
                ).localeCompare(
                    getDataQualityCategoryLabel(
                        right
                    ),
                    'ja'
                )
            );

    container.replaceChildren();

    const allButton =
        document.createElement(
            'button'
        );

    allButton.type = 'button';
    allButton.className =
        'data-quality-category-button';

    if (
        appState.dataQualityCategoryFilter ===
        ''
    ) {
        allButton.classList.add(
            'is-active'
        );
    }

    allButton.setAttribute(
        'aria-pressed',
        appState.dataQualityCategoryFilter === ''
            ? 'true'
            : 'false'
    );

    const allLabel =
        document.createElement('span');

    allLabel.textContent = 'すべて';

    const allCount =
        document.createElement('strong');

    allCount.textContent =
        String(
            Object.values(counts)
                .reduce(
                    (sum, count) =>
                        sum + count,
                    0
                )
        );

    allButton.append(
        allLabel,
        allCount
    );

    allButton.addEventListener(
        'click',
        () => {
            appState.dataQualityCategoryFilter =
                '';

            /*
            * ダッシュボードから引き継いだ
            * 問題コードの絞り込みを解除する。
            */
            appState.dataQualityCodeFilter = [];

            renderDataQuality();
        }
    );

    container.appendChild(
        allButton
    );

    categories.forEach(category => {
        const button =
            document.createElement(
                'button'
            );

        button.type = 'button';
        button.className =
            'data-quality-category-button';

        if (
            appState.dataQualityCategoryFilter ===
            category
        ) {
            button.classList.add(
                'is-active'
            );
        }

        button.setAttribute(
            'aria-pressed',
            appState.dataQualityCategoryFilter ===
                category
                ? 'true'
                : 'false'
        );

        const label =
            document.createElement(
                'span'
            );

        label.textContent =
            getDataQualityCategoryLabel(
                category
            );

        const count =
            document.createElement(
                'strong'
            );

        count.textContent =
            String(counts[category] || 0);

        button.append(
            label,
            count
        );

        button.addEventListener(
            'click',
            () => {
                // 選択中のカテゴリを再クリックした場合は解除
                if (
                    appState.dataQualityCategoryFilter ===
                    category
                ) {
                    appState.dataQualityCategoryFilter =
                        '';
                } else {
                    appState.dataQualityCategoryFilter =
                        category;
                }

                /*
                * 通常のカテゴリ選択へ切り替えるため、
                * ダッシュボード由来のcode条件を解除する。
                */
                appState.dataQualityCodeFilter = [];

                renderDataQuality();
            }
        );

        container.appendChild(
            button
        );
    });
}


export function createDataQualityIssueElement(
    issue
) {
    const article =
        document.createElement(
            'article'
        );

    const severity =
        String(
            issue?.severity ||
            'info'
        );

    const issueKey =
        getIssueKey(issue);
    const isExpanded =
        expandedIssueKeys.has(issueKey);

    article.className =
        'data-quality-issue ' +
        `data-quality-issue-${severity}` +
        (isExpanded ? ' is-expanded' : '');
    article.dataset.issueKey = issueKey;

    // --- 要約部（Phase 2.7D） ---
    const summaryRow =
        document.createElement('div');
    summaryRow.className =
        'data-quality-issue-summary';

    const mainCol =
        document.createElement('div');
    mainCol.className =
        'data-quality-issue-main';

    const tagsRow =
        document.createElement('div');
    tagsRow.className =
        'data-quality-issue-tags';

    const severityBadge =
        document.createElement('span');
    severityBadge.className =
        'data-quality-severity-badge';
    severityBadge.textContent =
        `${getDataQualitySeverityIcon(severity)} ${getDataQualitySeverityLabel(severity)}`.trim();

    const categoryBadge =
        document.createElement('span');
    categoryBadge.className =
        'data-quality-category-badge';
    categoryBadge.textContent =
        getDataQualityCategoryLabel(
            issue?.category
        );

    tagsRow.append(
        severityBadge,
        categoryBadge
    );

    const entityIds =
        Array.isArray(issue?.entity_ids)
            ? issue.entity_ids
            : [];
    if (entityIds.length > 1) {
        const countBadge =
            document.createElement('span');
        countBadge.className =
            'data-quality-count-badge';
        countBadge.textContent =
            `${entityIds.length}件`;
        tagsRow.appendChild(countBadge);
    }

    const message =
        document.createElement('h4');
    message.className =
        'data-quality-issue-title';
    message.textContent =
        String(
            issue?.message ||
            '問題が見つかりました'
        );

    const targetSummary =
        document.createElement('p');
    targetSummary.className =
        'data-quality-issue-target-summary';
    targetSummary.textContent =
        getDataQualityTargetSummary(issue);

    mainCol.append(
        tagsRow,
        message,
        targetSummary
    );

    // アクション部（主操作 + 詳細トグル）
    const actionsCol =
        document.createElement('div');
    actionsCol.className =
        'data-quality-issue-actions-summary';

    const primaryAction =
        getDataQualityPrimaryAction(issue);
    if (primaryAction) {
        const primaryBtn =
            createDataQualityActionButton(
                primaryAction.label,
                primaryAction.action,
                'data-quality-action-primary'
            );
        if (primaryAction.title) {
            primaryBtn.title =
                primaryAction.title;
        }
        actionsCol.appendChild(primaryBtn);
    }

    const detailPanelId =
        `data-quality-detail-${Math.random().toString(36).slice(2, 9)}`;
    const expandBtn =
        document.createElement('button');
    expandBtn.type = 'button';
    expandBtn.className =
        'data-quality-expand-btn';
    expandBtn.setAttribute(
        'aria-expanded',
        isExpanded ? 'true' : 'false'
    );
    expandBtn.setAttribute(
        'aria-controls',
        detailPanelId
    );
    expandBtn.textContent =
        isExpanded ? '閉じる ▴' : '詳細 ▾';

    actionsCol.appendChild(expandBtn);
    summaryRow.append(
        mainCol,
        actionsCol
    );
    article.appendChild(summaryRow);

    // --- 詳細パネル部（初期は折りたたみ） ---
    const detailsPanel =
        document.createElement('div');
    detailsPanel.id = detailPanelId;
    detailsPanel.className =
        'data-quality-issue-details-panel';
    detailsPanel.hidden = !isExpanded;

    const metaRow =
        document.createElement('div');
    metaRow.className =
        'data-quality-issue-meta';

    const codeLabel =
        document.createElement('span');
    codeLabel.className =
        'data-quality-code-label';
    codeLabel.textContent =
        `診断コード: ${String(issue?.code || '')}`;

    const entityLabel =
        document.createElement('span');
    entityLabel.className =
        'data-quality-entity-label';
    entityLabel.textContent =
        getDataQualityEntityLabel(issue);

    metaRow.append(
        codeLabel,
        entityLabel
    );
    detailsPanel.appendChild(metaRow);

    const detailLines =
        getDataQualityDetailLines(issue);
    if (detailLines.length > 0) {
        const detailsList =
            document.createElement('ul');
        detailsList.className =
            'data-quality-details';
        detailLines.forEach(line => {
            const item =
                document.createElement('li');
            item.textContent = line;
            detailsList.appendChild(item);
        });
        detailsPanel.appendChild(detailsList);
    }

    const actionsSection =
        createDataQualityIssueActions(issue);
    if (actionsSection) {
        detailsPanel.appendChild(
            actionsSection
        );
    }

    article.appendChild(detailsPanel);

    expandBtn.addEventListener(
        'click',
        event => {
            event.preventDefault();
            event.stopPropagation();
            const willExpand =
                detailsPanel.hidden;
            detailsPanel.hidden = !willExpand;
            expandBtn.setAttribute(
                'aria-expanded',
                willExpand ? 'true' : 'false'
            );
            expandBtn.textContent =
                willExpand
                    ? '閉じる ▴'
                    : '詳細 ▾';
            article.classList.toggle(
                'is-expanded',
                willExpand
            );
            if (willExpand) {
                expandedIssueKeys.add(
                    issueKey
                );
            } else {
                expandedIssueKeys.delete(
                    issueKey
                );
            }
        }
    );

    return article;
}


export function renderDataQualityIssues() {
    const status =
        document.getElementById(
            'data-quality-status'
        );

    const list =
        document.getElementById(
            'data-quality-issue-list'
        );

    const title =
        document.getElementById(
            'data-quality-list-title'
        );

    const filterSummary =
        document.getElementById(
            'data-quality-filter-summary'
        );

    const clearButton =
        document.getElementById(
            'data-quality-clear-filter-btn'
        );

    if (
        !status ||
        !list
    ) {
        return;
    }

    // フィルタチップの描画・更新（Phase 2.7C）
    renderDataQualityFilterChips();

    const issues =
        getFilteredDataQualityIssues();

    let titleText =
        appState.dataQualitySeverityFilter
            ? getDataQualitySeverityLabel(
                appState.dataQualitySeverityFilter
            )
            : 'すべての問題';

    if (appState.dataQualityCategoryFilter) {
        titleText +=
            ' / ' +
            getDataQualityCategoryLabel(
                appState.dataQualityCategoryFilter
            );
    }

    const codeFilterLabel =
        getDataQualityCodeFilterLabel();

    if (codeFilterLabel) {
        titleText +=
            ' / ' +
            codeFilterLabel;
    }

    if (title) {
        title.textContent =
            titleText;
    }

    if (filterSummary) {
        filterSummary.textContent =
            `${issues.length}件`;
    }

    if (clearButton) {
        clearButton.disabled =
            !appState.dataQualitySeverityFilter &&
            !appState.dataQualityCategoryFilter &&
            appState.dataQualityCodeFilter.length ===
                0;
    }

    list.replaceChildren();

    if (issues.length === 0) {
        status.hidden = false;
        status.className =
            'data-quality-status is-empty';

        status.textContent =
            appState.dataQualitySeverityFilter ||
            appState.dataQualityCategoryFilter ||
            appState.dataQualityCodeFilter.length > 0
                ? '選択した条件に該当する問題はありません。'
                : 'データ品質上の問題は見つかりませんでした。';

        list.hidden = true;

        return;
    }

    issues.forEach(issue => {
        list.appendChild(
            createDataQualityIssueElement(
                issue
            )
        );
    });

    status.hidden = true;
    list.hidden = false;
}


export function renderDataQualityMeta() {
    const meta =
        document.getElementById(
            'data-quality-meta'
        );

    if (!meta) {
        return;
    }

    if (!appState.dataQualityResult) {
        meta.textContent = '未診断';
        return;
    }

    meta.textContent =
        '診断日時: ' +
        formatDataQualityDateTime(
            appState.dataQualityResult.generated_at
        ) +
        ' / リビジョン: ' +
        String(
            appState.dataQualityResult.revision ??
            '-'
        );
}


export function renderDataQuality() {
    renderDataQualitySummary();
    renderDataQualityCategories();
    renderDataQualityMeta();
    renderDataQualityNotices();
    renderDataQualityIssues();
}


export function renderDataQualityError(
    message
) {
    renderDataQualitySummary();
    renderDataQualityCategories();
    renderDataQualityMeta();
    renderDataQualityNotices();

    const status =
        document.getElementById(
            'data-quality-status'
        );

    const list =
        document.getElementById(
            'data-quality-issue-list'
        );

    if (status) {
        status.hidden = false;
        status.className =
            'data-quality-status is-error';
        status.textContent =
            String(message);
    }

    if (list) {
        list.replaceChildren();
        list.hidden = true;
    }
}


export function renderDataQualityNotices() {
    const container =
        document.getElementById(
            'data-quality-notices'
        );

    if (!container) {
        return;
    }

    container.replaceChildren();

    const notices = [];

    if (appState.appStatus?.dirty) {
        notices.push({
            type: 'warning',
            text:
                '画面に未保存の変更があります。' +
                '診断結果は保存済みデータを基準にしています。'
        });
    }

    const resultRevision =
        Number(
            appState.dataQualityResult?.revision ||
            0
        );

    const currentRevision =
        Number(appState.dataRevision || 0);

    if (
        resultRevision > 0 &&
        currentRevision > 0 &&
        resultRevision !==
            currentRevision
    ) {
        notices.push({
            type: 'error',
            text:
                '診断結果のリビジョンと現在の画面データが' +
                '一致していません。画面を再読み込みしてから' +
                '再診断してください。'
        });
    }

    notices.forEach(notice => {
        const item =
            document.createElement(
                'p'
            );

        item.className =
            'data-quality-notice ' +
            `is-${notice.type}`;

        item.textContent =
            notice.text;

        container.appendChild(item);
    });

    container.hidden =
        notices.length === 0;
}



export function selectDataQualitySeverity(
    severity
) {
    const normalized =
        String(severity || '');

    if (
        ![
            '',
            'error',
            'warning',
            'info'
        ].includes(normalized)
    ) {
        return;
    }

    appState.dataQualitySeverityFilter =
        normalized;

    appState.dataQualityCategoryFilter = '';
    appState.dataQualityCodeFilter = [];

    renderDataQuality();
}


export function clearDataQualityFilters() {
    appState.dataQualitySeverityFilter = '';
    appState.dataQualityCategoryFilter = '';
    appState.dataQualityCodeFilter = [];

    renderDataQuality();
}


export function confirmDataQualityNavigation() {
    if (!appState.appStatus?.dirty) {
        return true;
    }

    return confirm(
        '画面に未保存の変更があります。\n' +
        '診断結果は保存済みデータを基準にしています。\n\n' +
        'このまま対象を表示しますか?'
    );
}

/**
 * ダッシュボードの分類値を整える。
 *
 * 前後空白を除去し、空欄は「未設定」とする。
 */
