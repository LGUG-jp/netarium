/**
 * Netarium - modals/data-quality-modal.js
 */

import {
    DASHBOARD_QUALITY_CODES,
    DATA_QUALITY_CATEGORY_LABELS,
    DATA_QUALITY_DEVICE_FIELD_LABELS,
    DATA_QUALITY_SEVERITY_LABELS
} from '../core/constants.js';

import { apiFetch, isMaintenanceRejection } from '../core/api-client.js';
import { appState, getCurrentLinks } from '../core/state.js';
import { resolveViewLinks } from '../core/connection-data.js';
import { viewHierarchyPath } from '../core/building-hierarchy.js';
import { getDeviceDestinations, getRackDeviceMounts } from '../core/device-placement.js';
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
import { closeBuildingView, getOpenBuildingId } from '../ui/building-view.js';
import { openWorkspaceNavigation } from '../ui/workspace-navigation.js';
import {
    getTopModalContainer,
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
import { openIpManagement } from './ip-management-modal.js';
import { openLedgerDetail } from './ledger-modal.js';
let dataQualityRefresh = null;
let isDataQualitySaving = false;
let latestQualityRequest = 0;
let isDataQualityFetching = false;
let dataQualityReturnFocus = null;

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
    const key = `${code}:${entityType}:${entityIds}:${message}`;
    const details = issue?.details;
    if (!details) return key;

    let target;
    switch (code) {
        case 'floor_mismatch':
        case 'rack_floor_mismatch':
            target = details.view_id;
            break;
        case 'legacy_link_conflict':
            target = details.legacy_link_id;
            break;
        case 'invalid_view_link_route':
            target = details.device_ids;
            break;
        case 'invalid_link_port':
            if (details.port_id != null) target = [details.port_id, details.device_id];
            break;
        case 'duplicate_port_use':
        case 'orphan_device_port':
            target = details.port_id;
            break;
        default:
            if (issue.category === 'duplicate') target = details.value;
    }
    return target == null ? key : `${key}:${JSON.stringify(target)}`;
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
    if (severity === 'problems') return 'エラー・警告';
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

    if (issue?.code === 'rack_floor_mismatch') {
        return [
            `ラックの所属フロア: ${details.rack_path}`,
            `配置先ビュー: ${details.view_name}（ID ${details.view_id}）`,
            `配置先ビューの所属フロア: ${details.view_path ?? '未設定'}`
        ];
    }
    if (issue?.code === 'legacy_link_vlan') {
        return [`未移行VLAN：${details.vlan}`];
    }
    if (issue?.code === 'link_ports_missing') {
        return missingLinkEndpoints(issue).map(([side, endpoint]) =>
            `${side === 'from' ? '始点' : '終点'}ポート未指定: ${qualityEndpointName(endpoint)}`);
    }

    const lines = [];
    const appendDetail = (label, value) => {
        if (value != null && value !== '') lines.push(`${label}: ${value}`);
    };
    appendDetail('保守期限', details.maintenance_expiry);
    appendDetail('導入年月', details.install_date);
    appendDetail('管理接続方式', details.scheme);
    appendDetail('管理接続ポート', details.port);

    if (issue?.code === 'legacy_link_conflict') {
        appendDetail('旧接続ID', details.legacy_link_id);
        appendDetail('保留理由', details.reason);
    }
    if (['invalid_link_port', 'duplicate_port_use', 'orphan_device_port'].includes(issue?.code)) {
        appendDetail('ポートID', details.port_id);
        const shownIds = issue.entity_type === 'link' ? normalizeDataQualityIds(issue.entity_ids) : [];
        const linkIds = normalizeDataQualityIds(details.link_ids ?? [details.link_id]);
        appendDetail('接続ID', linkIds.filter(id => !shownIds.includes(id)).join(', '));
    }

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

    if (issue?.code === 'ambiguous_ping_target' && Array.isArray(details.ip_records)) {
        const reachabilityLabels = { unset: '未設定', reachable: '到達可能', unreachable: '到達不可' };
        for (const record of details.ip_records) {
            const space = record.address_space_id == null
                ? '未分類'
                : record.address_space_name || `区分ID ${record.address_space_id}`;
            const kind = record.kind === 'management' ? '管理IP' : `追加IP${record.label ? `（${record.label}）` : ''}`;
            lines.push(`${record.ip} / ID ${record.device_id}: ${record.device_name || '名称未設定'} / ${kind} / ${space} / ${reachabilityLabels[record.ping_reachability] || '未設定'}`);
        }
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

    if (details.device_path || Object.hasOwn(details, 'device_floor_id')) {
        lines.push('設置フロア: ' + (details.device_path || viewHierarchyPath({ floor_id: details.device_floor_id }, appState)));
    }
    if (details.view_path || Object.hasOwn(details, 'view_floor_id')) {
        lines.push('配置先: ' + (details.view_path || viewHierarchyPath({ floor_id: details.view_floor_id }, appState)));
    }

    return lines;
}



async function fetchDataQuality() {
    const url = 'api.php?action=data_quality';
    const response =
        await fetch(
            url,
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

    if (response.status === 401) {
        if (typeof window.handleAuthExpired === 'function') {
            window.handleAuthExpired();
        }
        const error = new Error('認証の有効期限が切れました');
        error.status = 401;
        throw error;
    }

    let data = null;

    try {
        data =
            await response.json();
    } catch (error) {
        throw new Error(
            '診断結果を読み取れません'
        );
    }

    if (isMaintenanceRejection(response, data, url)) {
        const error = new Error('保守作業中のためデータ品質診断を実行できません。保守終了後に再試行してください');
        error.status = response.status;
        error.maintenanceRejected = true;
        throw error;
    }

    if (
        !response.ok ||
        !data ||
        data.ok !== true
    ) {
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

export function isDataQualityPending() {
    return isDataQualitySaving || isDataQualityFetching;
}

export async function reloadDataQualityResult() {
    // 「設定不要」は構成のリビジョンを進めないため、画面間では要求順に適用する。
    const request = ++latestQualityRequest;
    isDataQualityFetching = true;
    eventBus.emit('data-quality:sync-changed');
    try {
        const result = await fetchDataQuality();
        if (request !== latestQualityRequest) return;
        appState.dataQualityResult = result;
    } catch (error) {
        if (request !== latestQualityRequest) return;
        appState.dataQualityResult = null;
        throw error;
    } finally {
        if (request === latestQualityRequest) {
            isDataQualityFetching = false;
            eventBus.emit('data-quality:sync-changed');
        }
    }
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

    const menuSummary = document.activeElement?.closest('.toolbar-menu[open]')?.querySelector('summary');
    const trigger = menuSummary ?? document.activeElement;

    document
        .querySelectorAll('.toolbar-menu[open]')
        .forEach(menu => {
            menu.open = false;
        });

    appState.dataQualitySeverityFilter = '';
    appState.dataQualityCategoryFilter = '';
    clearDataQualityCodeFilter();
    appState.dataQualitySuppressedView = 'hidden';

    showDataQualityOverlay(overlay, trigger);
}

export function showDataQualityOverlay(overlay, trigger, refreshOptions) {
    dataQualityReturnFocus = trigger ?? null;
    renderDataQuality();
    overlay.hidden = false;
    registerModalOpen('data_quality', overlay, '#data-quality-show-suppressed', {
        onClose: closeDataQuality,
        restoreFocusTo: () => trigger
    });
    refreshDataQuality(refreshOptions);
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
}



export function hideDataQualityForNavigation() {
    const overlay =
        document.getElementById(
            'data-quality-overlay'
        );

    if (overlay) {
        overlay.hidden = true;
    }
    registerModalClose('data_quality', { restoreFocus: false });
}

export function focusDataQualityTrigger() {
    const candidates = [
        dataQualityReturnFocus,
        document.getElementById('data-quality-btn'),
        document.querySelector('#toolbar-manage-menu > summary')
    ];
    for (const target of candidates) {
        if (target && typeof target.focus === 'function' && document.body?.contains?.(target) &&
            !target.hidden && !target.disabled && !target.closest?.('[hidden], .hidden, [inert]') &&
            !(target.closest?.('details') && !target.closest('details').open && !target.closest?.('summary'))) {
            target.focus();
            return target;
        }
    }
    return null;
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

function missingLinkEndpoints(issue) {
    return Object.entries(issue?.details?.missing_endpoints ?? {});
}

function qualityEndpointName(endpoint) {
    return endpoint.device_name
        ? `${endpoint.device_name}（ID ${endpoint.device_id}）`
        : getDataQualityDeviceName(endpoint.device_id);
}

/**
 * 問題の対象を要約した短いテキストを生成する（Phase 2.7D）
 */
export function getDataQualityTargetSummary(issue) {
    if (issue?.code === 'rack_floor_mismatch') {
        return `対象ラック: ${issue.details.rack_view_name}（ID ${issue.entity_ids[0]}）`;
    }
    if (issue?.code === 'link_ports_missing') {
        return `接続ID ${issue.entity_ids[0]} / ポート未指定: ` +
            missingLinkEndpoints(issue).map(([, endpoint]) => qualityEndpointName(endpoint)).join('、');
    }

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
    if (getOpenBuildingId() != null && !await closeBuildingView()) return;

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

    if (getOpenBuildingId() != null && !await closeBuildingView()) return;
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
    if (getOpenBuildingId() != null && !await closeBuildingView()) return;

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
    const deviceIds = getDataQualityDeviceIds(issue);
    if (deviceIds.length === 0) {
        showToast('対象機器が見つかりません', 'warning');
        return;
    }

    if (!isCurrentUserAdmin() || appState.currentViewId === null) {
        // 一般ユーザーまたは現在ビュー未選択時は受け手側で確認と遷移を制御する。
        eventBus.emit('ledger:open-data-quality-device', deviceIds[0]);
        return;
    }

    if (!confirmDataQualityNavigation()) {
        return;
    }
    if (getOpenBuildingId() != null && !await closeBuildingView()) return;

    if (!await enterPlacementMode({
        tab: 'unplaced',
        initialDeviceIds: deviceIds
    })) {
        return;
    }
    hideDataQualityForNavigation();
}

/**
 * 接続問題の修正導線：対象ビュー・接続へ移動（Phase 2.7G）
 */
export async function openDataQualityLinkFlow(issue) {
    if (!confirmDataQualityNavigation()) {
        return;
    }
    if (getOpenBuildingId() != null && !await closeBuildingView()) return;

    const linkId = Number(
        issue?.details?.link_id ||
        (Array.isArray(issue?.details?.link_ids) && issue.details.link_ids.length > 0
            ? issue.details.link_ids[0]
            : (issue?.entity_type === 'link' && Array.isArray(issue?.entity_ids) && issue.entity_ids.length > 0
                ? issue.entity_ids[0]
                : 0))
    );

    const active = getCurrentLinks().find(link => Number(link.id) === linkId);
    const viewIds = getDataQualityViewIds(issue);
    const viewId = active?.view_id || (linkId > 0 && appState.links.some(link => Number(link.id) === linkId)
        ? appState.views.find(view => resolveViewLinks(view, appState).some(link => Number(link.id) === linkId))?.id
        : viewIds[0]);
    const isMissingPort = issue?.code === 'link_ports_missing';
    if (!viewId && isMissingPort) {
        const deviceId = missingLinkEndpoints(issue)[0]?.[1]?.device_id;
        if (!findDataQualityDevice(deviceId)) {
            showToast('対象機器が現在の画面データに見つかりません', 'warning');
            return;
        }
        await openLedgerDetail(deviceId, { tab: 'ports', linkId });
        return;
    }

    if (viewId > 0 && Number(appState.currentViewId) !== Number(viewId)) {
        if (!await switchView(Number(viewId))) return;
    }
    const link = getCurrentLinks().find(item => Number(item.id) === linkId);

    if (link) {
        if (!await openLinkPanel(link)) return;
        hideDataQualityForNavigation();
        if (isMissingPort) {
            const side = missingLinkEndpoints(issue)[0]?.[0];
            if (side) document.getElementById(`lp-${side}-port`)?.focus();
        }
        render();
        return;
    }

    const deviceIds = getDataQualityDeviceIds(issue);
    if (deviceIds.length > 0) {
        const device = findDataQualityDevice(deviceIds[0]);
        if (device) {
            const placement = getPlacementsForDevice(device.id).find(
                p => Number(p.view_id) === Number(appState.currentViewId)
            );
            if (placement) {
                if (await showDeviceInPlacement(device, placement)) {
                    hideDataQualityForNavigation();
                }
                return;
            }
        }
    }

    showToast('対象の接続または機器配置が現在のビューに見つかりません', 'warning');
}

async function openDataQualityLegacyVlan(issue) {
    const deviceIds = getDataQualityDeviceIds(issue);
    if (deviceIds.length === 0) return;

    const rackMounts = getRackDeviceMounts(appState);
    const destinations = deviceIds.flatMap(id =>
        getDeviceDestinations(id, appState.placements, rackMounts, appState.views)
    );
    const target = destinations.find(({ view }) => Number(view.id) === Number(appState.currentViewId)) ?? destinations[0];
    if (!target) {
        await openLedgerDetail(deviceIds[0], { tab: 'ports', linkId: Number(issue.details?.link_id ?? issue.entity_ids?.[0]) });
        return;
    }

    if (!confirmDataQualityNavigation()) return;
    if (getOpenBuildingId() != null && !await closeBuildingView()) return;
    if (Number(appState.currentViewId) !== Number(target.view.id) && !await switchView(target.view.id)) return;
    hideDataQualityForNavigation();
    openWorkspaceNavigation({ tab: 'links', reviewLegacy: true });
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

function getDataQualityUnclassifiedIpRecords(issue) {
    return (Array.isArray(issue?.details?.ip_records) ? issue.details.ip_records : [])
        .map(record => ({
            device_id: Number(record.device_id),
            kind: record.kind,
            id: record.kind === 'management' ? null : Number(record.id),
            ip: String(record.ip || '')
        }));
}

async function openDataQualityIpMembership(record, allowClassified = false) {
    if (!confirmDataQualityNavigation()) return;
    hideDataQualityForNavigation();
    focusDataQualityTrigger();
    await openIpManagement(record ? { target: record, allowClassified } : undefined);
}

/**
 * 診断結果ごとの主操作（Primary Action）を決定する（Phase 2.7E）
 */
export function getDataQualityPrimaryAction(issue) {
    const code = String(issue?.code || '');
    const category = String(issue?.category || '');
    if (code === 'rack_floor_mismatch') {
        const view = findDataQualityView(issue?.details?.view_id);
        if (view?.view_type !== 'floor') return null;
        return {
            label: '配置先ビューを開く',
            action: () => openDataQualityView(view.id),
            title: 'ラックアイコンが配置されているビューへ移動します'
        };
    }

    const deviceIds = getDataQualityDeviceIds(issue);
    const viewIds = getDataQualityViewIds(issue);
    const isAdmin = isCurrentUserAdmin();
    if (code === 'link_ports_missing') {
        return {
            label: '接続を確認',
            action: () => openDataQualityLinkFlow(issue),
            title: '接続情報、または機器個票の「接続・ポート」を開きます'
        };
    }
    if (code === 'maintenance_expiry_missing' && deviceIds.length > 0) {
        return {
            label: '台帳で確認',
            action: () => openDataQualityDeviceInSheet(deviceIds[0], 'maintenance_expiry'),
            title: '機器個票の保守期限を開きます'
        };
    }

    if (code === 'ambiguous_ping_target') {
        return {
            label: 'IPアドレス管理で確認',
            action: () => openDataQualityIpMembership(getDataQualityUnclassifiedIpRecords(issue)[0], true),
            title: 'IPアドレス管理で対象IPの所属区分と到達性を確認します'
        };
    }
    if (code === 'unclassified_ip') {
        return {
            label: 'IPアドレス管理で確認',
            action: () => openDataQualityIpMembership(getDataQualityUnclassifiedIpRecords(issue)[0]),
            title: 'IPアドレス管理の未分類一覧で所属を確認します'
        };
    }
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
        if (code === 'duplicate_link' || code === 'duplicate_port_use') {
            return {
                label: '接続を確認',
                action: () => openDataQualityLinkFlow(issue),
                title: '重複接続を表示できるビューへ移動します'
            };
        }
        return {
            label: isAdmin ? '台帳で修正' : '台帳で確認',
            action: () => {
                if (deviceIds.length > 0) {
                    openDataQualityDeviceInSheet(deviceIds[0], getDataQualityTargetField(issue));
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
        if (!isCurrentUserAdmin()) {
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

    if (code === 'legacy_link_conflict') {
        const view = findDataQualityView(viewIds[0]);
        if (!view) return null;
        return {
            label: '旧接続を確認',
            title: '元ビューの接続一覧を開きます',
            action: async () => {
                if (!confirmDataQualityNavigation()) return;
                if (getOpenBuildingId() != null && !await closeBuildingView()) return;
                if (Number(appState.currentViewId) !== Number(view.id) && !await switchView(view.id)) return;
                hideDataQualityForNavigation();
                openWorkspaceNavigation({ tab: 'links' });
            }
        };
    }
    if (code === 'legacy_link_vlan') {
        return deviceIds.length > 0 ? {
            label: '未移行VLANを確認',
            title: '接続一覧または機器個票の「接続・ポート」を開きます',
            action: () => openDataQualityLegacyVlan(issue)
        } : null;
    }
    if (code === 'invalid_view_link_route' && viewIds.length > 0) {
        return { label: 'ビューを確認', action: () => openDataQualityView(viewIds[0]), title: '手動経路のビューへ移動します' };
    }
    if (issue?.entity_type === 'link' && category === 'integrity') {
        return {
            label: '接続を確認',
            action: () => openDataQualityLinkFlow(issue),
            title: '接続問題が存在するビューへ移動します'
        };
    }

    // 9. 書式不正（MAC、管理方式、ポート、設置日、保守期限等）
    if (category === 'format') {
        const field = getDataQualityTargetField(issue) ?? ({
            nonstandard_mac: 'mac_address',
            invalid_management_scheme: 'management_scheme',
            management_port_without_scheme: 'management_port',
            invalid_management_port: 'management_port',
            invalid_install_date: 'install_date',
            invalid_maintenance_expiry_date: 'maintenance_expiry'
        })[code] ?? null;
        return {
            label: isAdmin ? '台帳で修正' : '台帳で確認',
            action: () => {
                if (deviceIds.length > 0) {
                    openDataQualityDeviceInSheet(deviceIds[0], field);
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
                    openDataQualityDeviceInSheet(deviceIds[0], 'maintenance_expiry');
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
    if (issue?.code === 'rack_floor_mismatch' || issue?.code === 'legacy_link_vlan') return null;

    const deviceIds =
        getDataQualityDeviceIds(
            issue
        );

    const viewIds =
        getDataQualityViewIds(
            issue
        );

    const ipRecords = issue?.code === 'unclassified_ip'
        ? getDataQualityUnclassifiedIpRecords(issue)
        : [];

    if (
        deviceIds.length === 0 &&
        viewIds.length === 0 &&
        ipRecords.length === 0
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
            (ipRecords.length || deviceIds.length) +
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

    if (ipRecords.length > 0) {
        ipRecords.forEach(record => {
            const row = document.createElement('div');
            row.className = 'data-quality-target-row';
            const label = document.createElement('strong');
            label.className = 'data-quality-target-label';
            label.textContent = `${getDataQualityDeviceName(record.device_id)} / ${record.kind === 'management' ? '管理IPv4アドレス' : `追加IPv4アドレス #${record.id}`}: ${record.ip}`;
            const buttons = document.createElement('div');
            buttons.className = 'data-quality-target-actions';
            buttons.appendChild(createDataQualityActionButton(
                '所属を確認',
                () => openDataQualityIpMembership(record),
                'data-quality-action-primary'
            ));
            row.append(label, buttons);
            list.appendChild(row);
        });
    } else {
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
    }

    section.appendChild(list);

    return section;
}

async function updateDataQualityNotApplicable(issue, item, notApplicable, button) {
    if (isDataQualitySaving || dataQualityRefresh) return;
    const keepFocus = document.activeElement === button;
    isDataQualitySaving = true;
    eventBus.emit('data-quality:sync-changed');
    updateDataQualityControls();
    let shouldRefresh = false;

    try {
        await apiFetch('set_quality_not_applicable', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                code: issue.code,
                field: item.field,
                device_id: item.device_id,
                expected_revision: item.resource_revision,
                ...(issue.entity_type === 'link' ? { link_id: issue.entity_ids[0] } : {}),
                not_applicable: notApplicable
            })
        });
        shouldRefresh = true;
        showToast(notApplicable ? '設定不要にしました' : '設定不要を解除しました', 'success');
    } catch (error) {
        showToast(error.message, error.status === 409 ? 'warning' : 'error');
        shouldRefresh = error.status === 409;
    } finally {
        isDataQualitySaving = false;
    }

    if (!shouldRefresh) {
        eventBus.emit('data-quality:sync-changed');
        updateDataQualityControls();
        if (keepFocus && document.activeElement === document.body && button.isConnected) button.focus();
        return;
    }
    await refreshDataQuality({ afterCurrent: true });
    if (keepFocus && (document.activeElement === button || document.activeElement === document.body) &&
        getTopModalContainer() === document.getElementById('data-quality-overlay')) {
        document.getElementById('data-quality-show-suppressed')?.focus();
    }
}

function createNotApplicableActions(issue, suppressed) {
    if (!isCurrentUserAdmin() || !issue.not_applicable_items?.length) return null;

    const section = document.createElement('section');
    section.className = 'data-quality-actions';
    const heading = document.createElement('h5');
    heading.textContent = suppressed ? '設定不要の項目' : '設定不要にできる項目';
    const list = document.createElement('div');
    list.className = 'data-quality-target-list';

    for (const item of issue.not_applicable_items) {
        const row = document.createElement('div');
        row.className = 'data-quality-target-row';
        const label = document.createElement('strong');
        label.className = 'data-quality-target-label';
        const endpoint = issue.details?.missing_endpoints?.[item.field === 'from_port' ? 'from' : 'to'];
        label.textContent = endpoint ? `${item.label}: ${qualityEndpointName(endpoint)}` : item.label;
        const action = suppressed ? '設定不要を解除' : '設定不要にする';
        const button = createDataQualityActionButton(action,
            () => updateDataQualityNotApplicable(issue, item, !suppressed, button),
            'data-quality-not-applicable-button');
        button.setAttribute('aria-label', `${label.textContent}：${action}`);
        row.append(label, button);
        list.appendChild(row);
    }
    section.append(heading, list);
    return section;
}



export async function refreshDataQuality({ keepResults = false, afterCurrent = false } = {}) {
    if (isDataQualitySaving) return;
    if (dataQualityRefresh) {
        if (!afterCurrent) return dataQualityRefresh;
        await dataQualityRefresh;
        return refreshDataQuality({ keepResults });
    }
    dataQualityRefresh = runDataQualityRefresh(keepResults && Boolean(appState.dataQualityResult));
    return dataQualityRefresh;
}

export function refreshDataQualityAfterSheet() {
    if (document.getElementById('data-quality-overlay')?.hidden !== false) return;
    const revision = Number(appState.dataQualityResult?.revision);
    const dataRevision = Number(appState.dataRevision);
    if (!appState.appStatus?.dirty && revision > 0 && dataRevision > 0 && revision !== dataRevision) {
        return refreshDataQuality({ keepResults: true, afterCurrent: true });
    }
    if (dataQualityRefresh) {
        renderDataQualityNotices();
        return;
    }
    renderDataQuality();
}

async function runDataQualityRefresh(keepResults) {

    // 再診断前のスクロール位置を退避（Phase 2.7I）
    const bodyEl = document.querySelector('.data-quality-body');
    const listEl = document.getElementById('data-quality-issue-list');
    const savedBodyScroll = bodyEl ? bodyEl.scrollTop : 0;
    const savedListScroll = listEl ? listEl.scrollTop : 0;

    updateDataQualityControls(true);
    if (!keepResults) {
        const status = document.getElementById('data-quality-status');
        if (status) {
            status.hidden = false;
            status.className = 'data-quality-status is-loading';
            status.textContent = 'データ品質を診断しています...';
        }
        if (listEl) listEl.hidden = true;
    }

    try {
        await reloadDataQualityResult();
        if (listEl?.contains(document.activeElement)) {
            document.getElementById('data-quality-show-suppressed')?.focus();
        }

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

        renderDataQualityError(
            error.message ||
            'データ品質診断に失敗しました'
        );

    } finally {
        dataQualityRefresh = null;
        updateDataQualityControls();
    }
}


function updateDataQualityControls(loading = dataQualityRefresh !== null) {
    const busy = loading || isDataQualitySaving;
    const refreshButton = document.getElementById('data-quality-refresh-btn');
    if (refreshButton) {
        refreshButton.disabled = busy;
        refreshButton.textContent = loading ? '診断中...' : '再診断';
    }
    const toggle = document.getElementById('data-quality-show-suppressed');
    if (toggle) toggle.disabled = isDataQualitySaving;

    const overlay = document.getElementById('data-quality-overlay');
    overlay?.querySelectorAll('.data-quality-action-button, .data-quality-expand-btn, .data-quality-category-button, [data-quality-severity], .data-quality-filter-chip-remove')
        .forEach(button => { button.disabled = busy; });
    const clear = document.getElementById('data-quality-clear-filter-btn');
    if (clear) {
        clear.disabled = busy || (!appState.dataQualitySeverityFilter && !appState.dataQualityCategoryFilter &&
            appState.dataQualitySuppressedView !== 'only' &&
            appState.dataQualityCodeFilter.length === 0);
    }
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
    setDataQualityCount('data-quality-suppressed-count', appState.dataQualityResult?.suppressed_count);
    const toggle = document.getElementById('data-quality-show-suppressed');
    const suppressedView = appState.dataQualitySuppressedView;
    if (toggle) toggle.checked = suppressedView !== 'hidden';
    const toggleLabel = document.getElementById('data-quality-suppressed-label');
    if (toggleLabel) toggleLabel.textContent = suppressedView === 'only' ? '設定不要のみ表示' : '設定不要も表示';

    document
        .querySelectorAll(
            '[data-quality-severity]'
        )
        .forEach(card => {
            const active = suppressedView !== 'only' &&
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

    if (normalizedCodes.length === 1) {
        switch (normalizedCodes[0]) {
            case DASHBOARD_QUALITY_CODES.unplacedDevice: return '未配置機器';
            case DASHBOARD_QUALITY_CODES.floorViewWithoutPlan: return '図面未登録';
            case DASHBOARD_QUALITY_CODES.missingRecommendedFields: return '機器の推奨項目未登録';
            case DASHBOARD_QUALITY_CODES.maintenanceExpiryMissing: return '保守期限未登録';
            case DASHBOARD_QUALITY_CODES.managementIpMissing: return '管理IP未登録';
            case DASHBOARD_QUALITY_CODES.linkPortsMissing: return '接続ポート未指定';
            case DASHBOARD_QUALITY_CODES.legacyLinkConflict: return '移行保留の旧接続';
            case DASHBOARD_QUALITY_CODES.legacyLinkVlan: return '未移行VLAN';
            case 'invalid_maintenance_expiry_date': return '保守期限の形式不正';
            default: return '指定された問題';
        }
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

function getActiveDataQualityCodeFilterLabel() {
    const label = getDataQualityCodeFilterLabel();
    const field = appState.dataQualityFieldFilter;
    return label && field ? `${label}：${DATA_QUALITY_DEVICE_FIELD_LABELS[field] ?? field}` : label;
}

function clearDataQualityCodeFilter() {
    appState.dataQualityCodeFilter = [];
    appState.dataQualityFieldFilter = '';
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
    if (appState.dataQualitySuppressedView === 'only') {
        chips.push({
            type: 'suppressed',
            label: '設定不要のみ',
            onRemove: () => {
                selectDataQualitySuppressed(false);
                document.getElementById('data-quality-show-suppressed')?.focus();
            }
        });
    }

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
                appState.dataQualitySeverityFilter = '';
                renderDataQuality();
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

    const codeLabel = getActiveDataQualityCodeFilterLabel();
    if (codeLabel) {
        chips.push({
            type: 'code',
            label: codeLabel,
            onRemove: () => {
                clearDataQualityCodeFilter();
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



function dataQualityIssues(suppressed = false) {
    const issues = suppressed ? appState.dataQualityResult?.suppressed_issues : appState.dataQualityResult?.issues;
    return Array.isArray(issues) ? issues : [];
}

export function selectDataQualitySuppressed(checked) {
    if (isDataQualitySaving) return;
    appState.dataQualitySuppressedView = checked ? 'included' : 'hidden';
    if (!dataQualityRefresh) renderDataQuality();
}

function matchesDataQualitySeverity(issue) {
    const filter = appState.dataQualitySeverityFilter;
    if (!filter) return true;
    const severity = String(issue?.severity || '');
    return filter === 'problems' ? severity === 'error' || severity === 'warning' : severity === filter;
}

function matchesDataQualityField(issue) {
    const field = appState.dataQualityFieldFilter;
    return !field || (issue?.code === DASHBOARD_QUALITY_CODES.missingRecommendedFields &&
        issue.details?.fields?.includes(field));
}

export function getFilteredDataQualityIssues(issues = dataQualityIssues()) {
    const codeSet =
        new Set(
            normalizeDataQualityCodeFilter(
                appState.dataQualityCodeFilter
            )
        );

    const filtered = issues.filter(issue => {
        if (!matchesDataQualitySeverity(issue)) return false;

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

        return matchesDataQualityField(issue);
    });

    const field = appState.dataQualityFieldFilter;
    if (!field) return filtered;
    return filtered.map(issue => ({
        ...issue,
        details: {
            ...issue.details,
            fields: [field],
            field_labels: [DATA_QUALITY_DEVICE_FIELD_LABELS[field] ?? field]
        },
        not_applicable_items: (issue.not_applicable_items ?? []).filter(item => item.field === field)
    }));
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

    const suppressedView = appState.dataQualitySuppressedView;
    const issues = suppressedView === 'only' ? [] : dataQualityIssues().filter(matchesDataQualityField);
    const suppressed = suppressedView === 'hidden' ? [] : dataQualityIssues(true).filter(matchesDataQualityField);
    const visibleKeys = suppressedView === 'included'
        ? new Set(issues.filter(issue => issue.not_applicable_items?.length).map(getIssueKey))
        : null;
    const displayed = suppressedView === 'only'
        ? suppressed
        : visibleKeys
            ? [...issues, ...suppressed.filter(issue => !visibleKeys.has(getIssueKey(issue)))]
            : issues;

    const counts = {};

    for (const issue of displayed) {
        if (codeSet.size > 0 && !codeSet.has(String(issue?.code || ''))) continue;
        if (!matchesDataQualitySeverity(issue)) continue;

        const category =
            String(
                issue?.category ||
                'other'
            );

        counts[category] =
            (counts[category] || 0) +
            1;
    }

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
            * 問題コードと項目の絞り込みを解除する。
            */
            clearDataQualityCodeFilter();

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
                * ダッシュボード由来の条件を解除する。
                */
                clearDataQualityCodeFilter();

                renderDataQuality();
            }
        );

        container.appendChild(
            button
        );
    });
}


export function createDataQualityIssueElement(issue, { suppressed = false, suppressedPart } = {}) {
    const article =
        document.createElement(
            'article'
        );

    const severity =
        String(
            issue?.severity ||
            'info'
        );

    const issueKey = getIssueKey(issue);
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
    if (suppressed || suppressedPart) {
        const badge = document.createElement('span');
        badge.className = 'data-quality-count-badge';
        badge.textContent = suppressed ? '設定不要' : '設定不要の項目あり';
        tagsRow.appendChild(badge);
    }

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
    const notApplicableActions = createNotApplicableActions(issue, suppressed);
    if (notApplicableActions) detailsPanel.appendChild(notApplicableActions);
    if (suppressedPart) {
        const suppressedActions = createNotApplicableActions(suppressedPart, true);
        if (suppressedActions) detailsPanel.appendChild(suppressedActions);
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

    if (
        !status ||
        !list
    ) {
        return;
    }

    // フィルタチップの描画・更新（Phase 2.7C）
    renderDataQualityFilterChips();

    const suppressedView = appState.dataQualitySuppressedView;
    const onlySuppressed = suppressedView === 'only';
    const issues = onlySuppressed ? [] : getFilteredDataQualityIssues();
    const suppressed = suppressedView === 'hidden'
        ? []
        : getFilteredDataQualityIssues(dataQualityIssues(true));

    let titleText =
        appState.dataQualitySeverityFilter
            ? getDataQualitySeverityLabel(
                appState.dataQualitySeverityFilter
            )
            : 'すべての問題';
    if (onlySuppressed) titleText = '設定不要の項目';

    if (appState.dataQualityCategoryFilter) {
        titleText +=
            ' / ' +
            getDataQualityCategoryLabel(
                appState.dataQualityCategoryFilter
            );
    }

    const codeFilterLabel =
        getActiveDataQualityCodeFilterLabel();

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
        const suppressedCount = suppressed.reduce((count, issue) => count + issue.not_applicable_items.length, 0);
        filterSummary.textContent = onlySuppressed ? `設定不要 ${suppressedCount}項目`
            : suppressedView === 'included' ? `通常 ${issues.length}件 / 設定不要 ${suppressedCount}項目`
                : `${issues.length}件`;
    }

    list.replaceChildren();

    if (issues.length === 0 && suppressed.length === 0) {
        status.hidden = false;
        status.className =
            'data-quality-status is-empty';

        const filtered = appState.dataQualitySeverityFilter || appState.dataQualityCategoryFilter ||
            appState.dataQualityCodeFilter.length > 0;
        status.textContent = onlySuppressed
            ? '選択した条件に該当する設定不要項目はありません。'
            : filtered ? '選択した条件に該当する問題はありません。' : 'データ品質上の問題は見つかりませんでした。';

        list.hidden = true;

        return;
    }

    const suppressedByKey = new Map(suppressed.map(issue => [getIssueKey(issue), issue]));
    // 一部を設定不要にした場合も、データ品質のカードは診断グループにつき1枚。
    for (const issue of issues) {
        const key = getIssueKey(issue);
        list.appendChild(createDataQualityIssueElement(issue, { suppressedPart: suppressedByKey.get(key) }));
        suppressedByKey.delete(key);
    }
    for (const issue of suppressedByKey.values()) {
        list.appendChild(createDataQualityIssueElement(issue, { suppressed: true }));
    }

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
    if (isDataQualitySaving) return;
    renderDataQualitySummary();
    renderDataQualityCategories();
    renderDataQualityMeta();
    renderDataQualityNotices();
    renderDataQualityIssues();
    if (isDataQualityPending() || Boolean(dataQualityRefresh)) {
        updateDataQualityControls(true);
    }
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
    clearDataQualityCodeFilter();
    if (appState.dataQualitySuppressedView === 'only') appState.dataQualitySuppressedView = 'hidden';

    renderDataQuality();
}


export function clearDataQualityFilters() {
    appState.dataQualitySeverityFilter = '';
    appState.dataQualityCategoryFilter = '';
    clearDataQualityCodeFilter();
    if (appState.dataQualitySuppressedView === 'only') appState.dataQualitySuppressedView = 'hidden';

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
