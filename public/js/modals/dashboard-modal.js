/**
 * Netarium - modals/dashboard-modal.js
 */

import {
    DATA_QUALITY_CATEGORY_LABELS,
    DASHBOARD_QUALITY_CODES,
    DASHBOARD_UNSET_LABEL,
    DEVICE_TYPES
} from '../core/constants.js';
import { isMaintenanceRejection } from '../core/api-client.js';
import { appState, normalizeStatus } from '../core/state.js';
import {
    buildDashboardModel,
    validateDashboardModel
} from '../core/dashboard-model.js';
import { MAINTENANCE_EXPIRY_LABELS } from '../core/maintenance-expiry.js';
import {
    isCurrentUserAdmin
} from '../ui/access-control.js';
import {
    closeToolbarMenu
} from '../ui/toolbar-controls.js';
import {
    showToast
} from '../ui/toast.js';
import {
    registerModalClose,
    registerModalOpen
} from '../core/modal-focus.js';
import { openDashboardLedger } from './ledger-modal.js';
import { openIpManagement } from './ip-management-modal.js';
import {
    isDataQualityPending,
    normalizeDataQualityCodeFilter,
    normalizeDataQualityIds,
    reloadDataQualityResult,
    showDataQualityOverlay
} from './data-quality-modal.js';
let dashboardModel = null;
let dashboardRevision = null;
let isDashboardLoading = false;
let dashboardPreviousFocus = null;
let ipSummary = null;
let ipSummaryState = 'unloaded';
const dashboardBreakdownExpanded = {
    facility: false,
    buildings: new Set(),
    type: false
};

const DASHBOARD_TABS = ['operations', 'assets', 'network', 'quality'];
const MAINTENANCE_STORAGE_KEY = 'netarium.dashboardMaintenance';
let maintenanceMode = 'fiscal';
let fiscalYearStartMonth = 4;

function normalizeFiscalStartMonth(value) {
    const month = Number(value);
    return Number.isInteger(month) && month >= 1 && month <= 12 ? month : 4;
}

function loadDashboardMaintenanceSettings() {
    try {
        const settings = JSON.parse(window.localStorage.getItem(MAINTENANCE_STORAGE_KEY));
        maintenanceMode = settings?.mode === 'remaining' ? 'remaining' : 'fiscal';
        fiscalYearStartMonth = normalizeFiscalStartMonth(settings?.month);
    } catch {
        // 保存領域を使えない場合は、同じページ内の選択を保持する。
    }
}

export function updateDashboardMaintenanceSettings() {
    maintenanceMode = document.getElementById('dashboard-maintenance-mode')?.value === 'remaining'
        ? 'remaining' : 'fiscal';
    fiscalYearStartMonth = normalizeFiscalStartMonth(document.getElementById('dashboard-fiscal-start')?.value);
    try {
        window.localStorage.setItem(MAINTENANCE_STORAGE_KEY, JSON.stringify({
            mode: maintenanceMode, month: fiscalYearStartMonth
        }));
    } catch {
        // 表示の切替は保存領域がなくても続行する。
    }
    renderDashboard();
}

export function selectDashboardTab(tab, { focus = false } = {}) {
    if (!DASHBOARD_TABS.includes(tab)) {
        return;
    }

    DASHBOARD_TABS.forEach(name => {
        const button = document.getElementById(`dashboard-tab-${name}`);
        const panel = document.getElementById(`dashboard-panel-${name}`);
        const selected = name === tab;
        if (button) {
            button.setAttribute('aria-selected', String(selected));
            button.tabIndex = selected ? 0 : -1;
            if (selected) {
                if (focus) button.focus();
                button.scrollIntoView?.({ block: 'nearest', inline: 'nearest', container: 'nearest' });
            }
        }
        if (panel) {
            panel.hidden = !selected;
        }
    });
}

export function handleDashboardTabKeydown(event) {
    const tab = event.target?.closest?.('[data-dashboard-tab]');
    const index = DASHBOARD_TABS.indexOf(tab?.dataset.dashboardTab);
    if (index < 0) {
        return;
    }

    let next;
    switch (event.key) {
        case 'ArrowLeft':
            next = (index + DASHBOARD_TABS.length - 1) % DASHBOARD_TABS.length;
            break;
        case 'ArrowRight':
            next = (index + 1) % DASHBOARD_TABS.length;
            break;
        case 'Home':
            next = 0;
            break;
        case 'End':
            next = DASHBOARD_TABS.length - 1;
            break;
        default:
            return;
    }
    event.preventDefault();
    selectDashboardTab(DASHBOARD_TABS[next], { focus: true });
}
function createCurrentDashboardModel() {
    return buildDashboardModel({
        devices: appState.devices,
        placements: appState.placements,
        views: appState.views,
        buildings: appState.buildings,
        floors: appState.floors,
        rackSettings: appState.rackSettings,
        rackMounts: appState.rackMounts,
        rackShelves: appState.rackShelves,
        rackShelfDevices: appState.rackShelfDevices,
        devicePorts: appState.devicePorts,
        links: appState.links,
        qualityResult: appState.dataQualityResult,
        qualityLoading: isDashboardLoading || isDataQualityPending(),
        dataRevision: appState.dataRevision,
        dirty: appState.appStatus?.dirty,
        fiscalYearStartMonth
    });
}
/**
 * 現在データからダッシュボード集計を生成する。
 *
 * Step 1の確認用。
 */

/**
 * 現在データからダッシュボード集計を生成する。
 *
 * Step 1の確認用。
 */
export function inspectDashboardModel() {
    const model =
        createCurrentDashboardModel();

    const validationErrors =
        validateDashboardModel(
            model
        );

    return {
        model,
        valid:
            validationErrors.length ===
            0,
        validationErrors
    };
}


export function getDashboardOverlay() {
    return document.getElementById(
        'dashboard-overlay'
    );
}


export function getDashboardDialog() {
    return document.querySelector(
        '#dashboard-overlay ' +
        '.dashboard-dialog'
    );
}

/**
 * ダッシュボード内でフォーカス可能な要素を取得する。
 */

/**
 * ダッシュボード内でフォーカス可能な要素を取得する。
 */
export function getDashboardFocusableElements() {
    const dialog =
        getDashboardDialog();

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
            'summary, ' +
            '[tabindex]:not([tabindex="-1"])'
        )
    ).filter(element => {
        if (
            !(element instanceof
                HTMLElement)
        ) {
            return false;
        }
        const details = element.closest('details');

        return (
            !element.hidden &&
            !element.closest('[hidden]') &&
            (element.tagName === 'SUMMARY' || element.tabIndex !== -1) &&
            (!details || details.open || element.tagName === 'SUMMARY') &&
            element.offsetParent !== null &&
            element.getAttribute(
                'aria-hidden'
            ) !== 'true'
        );
    });
}

/**
 * ダッシュボードのTabを処理する。
 */
export function handleDashboardDialogKeydown(
    event
) {
    const overlay =
        getDashboardOverlay();

    if (
        !overlay ||
        overlay.hidden
    ) {
        return false;
    }


    if (event.key !== 'Tab') {
        return false;
    }

    const focusable =
        getDashboardFocusableElements();

    if (focusable.length === 0) {
        event.preventDefault();

        getDashboardDialog()
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
            !getDashboardDialog()
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
            !getDashboardDialog()
                ?.contains(active)
        )
    ) {
        event.preventDefault();
        first.focus();

        return true;
    }

    return false;
}


export function openDashboard() {
    if (!isCurrentUserAdmin()) {
        showToast(
            'この操作を実行する権限がありません',
            'warning'
        );

        return;
    }

    const overlay =
        getDashboardOverlay();

    if (!overlay) {
        showToast(
            'ダッシュボード画面が見つかりません',
            'error'
        );

        return;
    }

    if (!overlay.hidden) {
        return;
    }

    const activeElement =
        document.activeElement;

    dashboardPreviousFocus =
        activeElement instanceof HTMLElement
            ? activeElement
            : null;

    closeToolbarMenu();

    dashboardBreakdownExpanded.facility = false;
    dashboardBreakdownExpanded.buildings.clear();
    dashboardBreakdownExpanded.type = false;
    setDashboardDetailsExpanded('dashboard-breakdown-toggle', false);
    setDashboardDetailsExpanded('dashboard-racks-toggle', false);
    loadDashboardMaintenanceSettings();

    appState.isDashboardNavigating = false;
    if (!isDashboardLoading) {
        ipSummary = null;
        ipSummaryState = 'unloaded';
    }

    overlay.hidden = false;

    document.body.classList.add(
        'dashboard-open'
    );
    selectDashboardTab('operations');

    if (isDashboardLoading) renderDashboard();
    else void refreshDashboard();
    registerModalOpen('dashboard', overlay, '#dashboard-refresh-btn', { onClose: closeDashboard });
    focusDashboard();
}


export function closeDashboard() {
    const overlay =
        getDashboardOverlay();

    if (
        !overlay ||
        overlay.hidden
    ) {
        return;
    }

    overlay.hidden = true;
    registerModalClose('dashboard');

    document.body.classList.remove(
        'dashboard-open'
    );
    const previousFocus =
        dashboardPreviousFocus;

    dashboardPreviousFocus = null;

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

/**
 * 遷移先がフォーカスを管理する場合の閉じ方。
 */

/**
 * 遷移先がフォーカスを管理する場合の閉じ方。
 */
export function hideDashboardForNavigation() {
    const overlay =
        getDashboardOverlay();

    if (overlay) {
        overlay.hidden = true;
    }
    registerModalClose('dashboard', { restoreFocus: false });

    document.body.classList.remove(
        'dashboard-open'
    );

    dashboardPreviousFocus = null;
}

/**
 * selectへ指定値を設定する。
 *
 * optionが存在しない場合は空欄へ戻す。
 */

/**
 * ダッシュボードから品質診断へ移動できるか確認する。
 */
export function confirmDashboardQualityNavigation() {
    if (appState.appStatus?.dirty) {
        return confirm(
            '画面に未保存の変更があります。\n\n' +
            'ダッシュボードの基本集計には画面上の変更が' +
            '含まれていますが、診断画面は保存済みデータを' +
            '基準にしています。\n' +
            'このまま移動しますか?'
        );
    }

    if (
        dashboardModel
            ?.qualityRevisionMatches ===
        false
    ) {
        return confirm(
            '品質診断のリビジョンと現在の画面データが' +
            '一致していません。\n\n' +
            '診断画面には保存済みデータを基準とした結果が' +
            '表示されます。\n' +
            'このまま移動しますか?'
        );
    }

    return true;
}


/**
 * ダッシュボードから指定条件で
 * データ品質診断を開く。
 */

/**
 * ダッシュボードから指定条件で
 * データ品質診断を開く。
 */
export function openDashboardDataQuality(
    options = {}
) {
    if (appState.isDashboardNavigating) {
        return;
    }

    if (!isCurrentUserAdmin()) {
        showToast(
            'この操作を実行する権限がありません',
            'warning'
        );

        return;
    }

    if (
        !confirmDashboardQualityNavigation()
    ) {
        return;
    }

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

    appState.isDashboardNavigating = true;

    try {
        const previousFocus = dashboardPreviousFocus;
        hideDashboardForNavigation();

        appState.dataQualitySeverityFilter =
            String(
                options.severity || ''
            );

        appState.dataQualityCategoryFilter =
            String(
                options.category || ''
            );

        appState.dataQualityCodeFilter =
            normalizeDataQualityCodeFilter(
                options.codes
            );
        appState.dataQualityFieldFilter = options.field ?? '';
        appState.dataQualitySuppressedView = options.showSuppressed === true ? 'only' : 'hidden';

        showDataQualityOverlay(overlay, previousFocus, { keepResults: true, afterCurrent: true });

        window.requestAnimationFrame(
            () => {
                appState.isDashboardNavigating =
                    false;
            }
        );
    } catch (error) {
        appState.isDashboardNavigating = false;
        throw error;
    }
}


function setDashboardDetailsExpanded(toggleId, expanded) {
    const toggle = document.getElementById(toggleId);
    const details = document.getElementById(toggle?.getAttribute('aria-controls'));
    if (!toggle || !details) return;
    details.hidden = !expanded;
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.textContent = expanded ? '閉じる ▲' : `${toggle.dataset.expandLabel} ▼`;
}

/**
 * ダッシュボードカードの操作を実行する。
 */

function openDashboardLedgerWithFocus(options) {
    const previousFocus = dashboardPreviousFocus;
    hideDashboardForNavigation();
    if (previousFocus && typeof previousFocus.focus === 'function') {
        previousFocus.focus();
    }
    openDashboardLedger(options);
}

/**
 * ダッシュボードカードの操作を実行する。
 */
export function handleDashboardAction(
    action, data = {}
) {
    if (appState.isDashboardNavigating) {
        return;
    }
    const normalizedAction =
        String(action || '');

    switch (normalizedAction) {
        case 'ledger-building':
            openDashboardLedgerWithFocus({ buildingId: data.buildingId });
            return;
        case 'ledger-floor':
            openDashboardLedgerWithFocus({ floorId: data.floorId });
            return;
        case 'ledger-type':
            openDashboardLedgerWithFocus({ type: data.deviceType });
            return;
        case 'ledger-maintenance-year': {
            const range = dashboardModel?.maintenance.fiscalYears[Number(data.index)];
            if (range) openDashboardLedgerWithFocus({ maintenanceRange: range });
            return;
        }
        case 'quality-code':
            if (!data.code || isDashboardLoading) return;
            openDashboardDataQuality({ codes: [data.code], field: data.field, showSuppressed: data.showSuppressed === 'true' });
            return;
        case 'quality-category':
            openDashboardDataQuality({ category: data.category, severity: data.severity });
            return;
        case 'quality-suppressed':
            openDashboardDataQuality({ showSuppressed: true });
            return;
        case 'quality-diagnosis':
            openDashboardDataQuality();
            return;
        case 'ip-management':
        case 'ip-unclassified': {
            if (!isCurrentUserAdmin() || isDashboardLoading) return;
            const previousFocus = dashboardPreviousFocus;
            hideDashboardForNavigation();
            previousFocus?.focus();
            void openIpManagement({ unclassified: normalizedAction === 'ip-unclassified' });
            return;
        }
        case 'toggle-breakdown':
        case 'toggle-racks': {
            const toggleId = normalizedAction === 'toggle-racks' ? 'dashboard-racks-toggle' : 'dashboard-breakdown-toggle';
            const toggle = document.getElementById(toggleId);
            setDashboardDetailsExpanded(toggleId, toggle?.getAttribute('aria-expanded') !== 'true');
            return;
        }

        case 'ledger-all':
            openDashboardLedgerWithFocus();
            return;

        case 'ledger-green':
            openDashboardLedgerWithFocus({
                status: 'green'
            });
            return;

        case 'ledger-red':
            openDashboardLedgerWithFocus({
                status: 'red'
            });
            return;

        case 'ledger-unknown':
            openDashboardLedgerWithFocus({
                status: 'unknown'
            });
            return;

        case 'ledger-maintenance-expired':
            openDashboardLedgerWithFocus({ maintenanceExpiry: 'expired' });
            return;

        case 'ledger-maintenance':
            openDashboardLedgerWithFocus({ maintenanceExpiry: data.maintenanceCategory });
            return;

        case 'quality-error':
            openDashboardDataQuality({
                severity: 'error'
            });
            return;

        case 'quality-warning':
            openDashboardDataQuality({
                severity: 'warning'
            });
            return;
        case 'quality-info':
            openDashboardDataQuality({
                severity: 'info'
            });
            return;

        case 'quality-unplaced':
            openDashboardLedgerWithFocus({ placement: 'unplaced' });
            return;

        case 'quality-incomplete':
            openDashboardDataQuality({
                codes: [
                    DASHBOARD_QUALITY_CODES
                        .missingRequiredFields,

                    DASHBOARD_QUALITY_CODES
                        .missingRecommendedFields
                ]
            });
            return;

        case 'quality-floor-plan':
            openDashboardDataQuality({
                codes: [
                    DASHBOARD_QUALITY_CODES
                        .floorViewWithoutPlan
                ]
            });
            return;

        case 'quality-all':
            openDashboardDataQuality({ severity: 'problems' });
            return;

        default:
            return;
    }
}



export function focusDashboard() {
    window.requestAnimationFrame(
        () => {
            const refreshButton =
                document.getElementById(
                    'dashboard-refresh-btn'
                );

            if (
                refreshButton &&
                !refreshButton.disabled
            ) {
                refreshButton.focus();
                return;
            }

            getDashboardDialog()?.focus();
        }
    );
}


export async function refreshDashboard() {
    if (!isCurrentUserAdmin() || isDashboardLoading) return;
    const refreshButton = document.getElementById('dashboard-refresh-btn');
    const dialog = getDashboardDialog();
    const restoreRefreshFocus = refreshButton && document.activeElement === refreshButton;
    if (restoreRefreshFocus) dialog?.focus();

    isDashboardLoading = true;
    setDashboardLoadingState(true);
    renderDashboard();

    const [qualityRequest] = await Promise.allSettled([
        reloadDataQualityResult(), refreshDashboardIpSummary()
    ]);
    isDashboardLoading = false;
    setDashboardLoadingState(false);
    renderDashboard();
    if (restoreRefreshFocus && document.activeElement === dialog && getDashboardOverlay()?.hidden === false) {
        refreshButton.focus();
    }

    if (qualityRequest.status === 'rejected') {
        renderDashboardError(qualityRequest.reason?.message || 'データ品質情報を取得できませんでした');
        return;
    }
    const validationErrors = validateDashboardModel(dashboardModel);
    if (validationErrors.length) {
        console.warn('ダッシュボード集計の整合性警告', validationErrors);
        renderDashboardError('集計結果の一部に整合しない値があります。');
        return;
    }
    setDashboardStatusHidden();
}


export function setDashboardStatusHidden() {
    const status =
        document.getElementById(
            'dashboard-status'
        );

    if (!status) {
        return;
    }

    status.hidden = true;
    status.className =
        'dashboard-status';
    status.textContent = '';
}


export function setDashboardLoadingState(
    loading
) {
    const button =
        document.getElementById(
            'dashboard-refresh-btn'
        );

    const status =
        document.getElementById(
            'dashboard-status'
        );

    if (button) {
        button.disabled = loading;
        const label = document.getElementById('dashboard-refresh-label');
        if (label) label.textContent = loading ? '更新中...' : '更新';
    }

    if (status) {
        if (loading) {
            status.hidden = false;
            status.className =
                'dashboard-status is-loading';

            status.textContent =
                'データ品質・IP管理情報を取得しています...';
        } else if (
            status.classList.contains(
                'is-loading'
            )
        ) {
            status.hidden = true;
            status.className =
                'dashboard-status';
            status.textContent = '';
        }
    }

}

function renderDashboardIpSummary() {
    const ready = ipSummaryState === 'ready';
    for (const key of ['address_spaces', 'ip_segments', 'registered_ips', 'unclassified_ips']) {
        const element = document.getElementById(`dashboard-ip-${key}-count`);
        if (element) element.textContent = ready ? String(ipSummary.summary[key]) : '—';
    }
    const unclassified = document.getElementById('dashboard-ip-unclassified');
    if (unclassified) {
        unclassified.disabled = isDashboardLoading || !ready;
        unclassified.classList.toggle('is-warning', ready && ipSummary.summary.unclassified_ips > 0);
    }
    const openIpBtn = document.getElementById('dashboard-overlay')
        ?.querySelector('[data-dashboard-action="ip-management"]');
    if (openIpBtn) {
        openIpBtn.disabled = isDashboardLoading || !isCurrentUserAdmin();
    }
    const status = document.getElementById('dashboard-ip-status');
    if (!status) return;
    const stale = ready && (ipSummary.revision !== appState.dataRevision || appState.appStatus?.dirty);
    status.hidden = ready && !stale;
    status.classList.toggle('is-warning', ipSummaryState === 'error');
    if (ipSummaryState === 'loading') status.textContent = '保存済みDBから取得中...';
    else if (ipSummaryState === 'error') status.textContent = ipSummaryError || '取得できませんでした。「更新」で再取得してください。';
    else if (!ready) status.textContent = '未取得';
    else status.textContent = '画面データと差異がある可能性があります。';
}

let ipSummaryError = '';

async function refreshDashboardIpSummary() {
    ipSummaryState = 'loading';
    ipSummaryError = '';
    renderDashboardIpSummary();
    try {
        const url = 'api.php?action=load_ip_management_summary';
        const response = await fetch(url, {
            method: 'GET', credentials: 'same-origin', cache: 'no-store',
            headers: { Accept: 'application/json' }
        });
        if (response.status === 401 && typeof window.handleAuthExpired === 'function') {
            window.handleAuthExpired();
            ipSummary = null;
            ipSummaryState = 'error';
            renderDashboardIpSummary();
            return;
        }
        const data = await response.json();
        if (isMaintenanceRejection(response, data, url)) {
            ipSummaryError = '保守作業中のためIP管理集計を取得できません。';
            throw new Error(ipSummaryError);
        }
        if (!response.ok || data?.ok !== true ||
            !Number.isInteger(data.revision) ||
            !['address_spaces', 'ip_segments', 'registered_ips', 'unclassified_ips']
                .every(key => Number.isInteger(data.summary?.[key]) && data.summary[key] >= 0)) {
            throw new Error('IP管理集計を取得できませんでした');
        }
        ipSummary = data;
        ipSummaryState = 'ready';
    } catch {
        ipSummary = null;
        ipSummaryState = 'error';
    }
    renderDashboardIpSummary();
}



export function setDashboardCount(
    id,
    value
) {
    const element =
        document.getElementById(id);

    if (!element) {
        return;
    }

    const normalizedValue = value == null ? null : Math.max(0, Number(value) || 0);
    element.textContent = normalizedValue == null ? '—' : String(normalizedValue);

    const card =
        element.closest(
            '[data-dashboard-action]'
        );

    if (!card) {
        return;
    }

    /*
     * 総機器数と保守期限カードは0件でも台帳を開ける。
     * それ以外は0件時に無効化する。
     */
    const alwaysEnabled = ['ledger-all', 'ledger-maintenance-expired'].includes(card.dataset.dashboardAction);

    if (
        card instanceof
            HTMLButtonElement
    ) {
        card.disabled = normalizedValue == null || (!alwaysEnabled && normalizedValue === 0);
    }
}


/**
 * ダッシュボードの分類数を表示する。
 */

/**
 * ダッシュボードの分類数を表示する。
 */
export function setDashboardGroupCount(
    id,
    count
) {
    const element =
        document.getElementById(id);

    if (!element) {
        return;
    }

    const normalizedCount =
        Math.max(
            0,
            Number(count) || 0
        );

    element.textContent =
        `${normalizedCount}分類`;
}


/**
 * ダッシュボード内訳の1行を生成する。
 */

/**
 * ダッシュボード内訳の1行を生成する。
 */
export function createDashboardBreakdownItem(
    group,
    groupType
) {
    const item =
        document.createElement(
            'button'
        );

    item.type = 'button';
    item.className =
        'dashboard-breakdown-item';

    const normalizedGroupType =
        String(groupType || '');

    let canNavigate = true;

    if (normalizedGroupType === 'facility') {
        item.dataset.dashboardAction = 'ledger-building';
        item.dataset.buildingId = group.buildingId == null ? 'unset' : String(group.buildingId);
    }

    if (normalizedGroupType === 'floor') {
        item.dataset.dashboardAction = 'ledger-floor';
        item.dataset.floorId = group.floorId == null ? 'unset' : String(group.floorId);
    }

    if (normalizedGroupType === 'type') {
        const type =
            String(
                group?.type || ''
            );

        if (!type) {
            canNavigate = false;
        } else {
            item.dataset.dashboardAction =
                'ledger-type';

            item.dataset.deviceType =
                type;
        }
    }

    if (!canNavigate) {
        item.disabled = true;
        item.classList.add('is-unset');
        item.title =
            '未設定項目は台帳の選択フィルターへ直接反映できません';
    }

    const heading =
        document.createElement('div');

    heading.className =
        'dashboard-breakdown-item-heading';

    const label =
        document.createElement('strong');

    label.className =
        'dashboard-breakdown-label';

    label.textContent =
        String(
            group?.label ||
            DASHBOARD_UNSET_LABEL
        );

    label.title =
        label.textContent;

    const values =
        document.createElement('span');

    values.className =
        'dashboard-breakdown-values';

    const count =
        Math.max(
            0,
            Number(
                group?.count
            ) || 0
        );

    const percentage =
        Math.max(
            0,
            Number(
                group?.percentage
            ) || 0
        );

    const countText =
        document.createElement('strong');

    countText.textContent =
        `${count}台`;

    const percentageText =
        document.createElement('small');

    percentageText.textContent =
        `${percentage.toFixed(1)}%`;

    values.append(
        countText,
        percentageText
    );

    heading.append(
        label,
        values
    );

    const track =
        document.createElement('div');

    track.className =
        'dashboard-breakdown-track';

    track.setAttribute(
        'aria-hidden',
        'true'
    );

    const bar =
        document.createElement('span');

    bar.className =
        'dashboard-breakdown-bar';

    // 横棒は表示値と同じ分母を使う（建物の内訳は建物内の機器数）。
    const barWidth =
        Math.max(
            0,
            Math.min(
                100,
                percentage
            )
        );

    bar.style.width =
        `${barWidth}%`;

    track.appendChild(bar);

    item.append(
        heading,
        track
    );

    return item;
}


/**
 * 内訳が0件の場合の案内を生成する。
 */

/**
 * 内訳が0件の場合の案内を生成する。
 */
export function createDashboardBreakdownEmpty(
    message
) {
    const empty =
        document.createElement('p');

    empty.className =
        'dashboard-breakdown-empty';

    empty.textContent =
        String(
            message ||
            '集計対象がありません。'
        );

    return empty;
}

function createDashboardBuildingItem(group) {
    const ledgerButton = createDashboardBreakdownItem(group, 'facility');
    const row = document.createElement('div');
    row.className = 'dashboard-building-row';
    if (!group.floors.length) {
        row.appendChild(ledgerButton);
        return row;
    }

    const wrapper = document.createElement('div');
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'dashboard-building-toggle';
    toggle.setAttribute('aria-label', `${group.label}のフロア内訳`);
    const floors = document.createElement('div');
    floors.id = `dashboard-building-floors-${group.buildingId}`;
    floors.className = 'dashboard-breakdown-list dashboard-building-floors';
    toggle.setAttribute('aria-controls', floors.id);
    for (const floor of group.floors) {
        floors.appendChild(createDashboardBreakdownItem(floor, 'floor'));
    }
    function setExpanded(expanded) {
        if (expanded) dashboardBreakdownExpanded.buildings.add(group.buildingId);
        else dashboardBreakdownExpanded.buildings.delete(group.buildingId);
        floors.hidden = !expanded;
        toggle.setAttribute('aria-expanded', String(expanded));
        toggle.textContent = expanded ? '▾' : '▸';
    }
    setExpanded(dashboardBreakdownExpanded.buildings.has(group.buildingId));
    toggle.addEventListener('click', () => setExpanded(floors.hidden));
    row.append(toggle, ledgerButton);
    wrapper.append(row, floors);
    return wrapper;
}

/**
 * 指定された内訳リストを描画する。
 */

/**
 * 指定された内訳リストを描画する。
 */
export function renderDashboardBreakdownList(
    options
) {
    const container =
        document.getElementById(
            options?.containerId
        );

    if (!container) {
        return;
    }

    const groups =
        Array.isArray(options?.groups)
            ? options.groups
            : [];

    const groupType =
        String(options?.groupType || '');

    setDashboardGroupCount(
        options?.countId,
        groups.length
    );

    container.replaceChildren();

    if (groups.length === 0) {
        container.appendChild(
            createDashboardBreakdownEmpty(
                options?.emptyMessage
            )
        );

        return;
    }

    const isExpanded =
        Boolean(dashboardBreakdownExpanded[groupType]);

    const itemsToDisplay =
        isExpanded ? groups : groups.slice(0, 5);

    for (const group of itemsToDisplay) {
        container.appendChild(groupType === 'facility'
            ? createDashboardBuildingItem(group)
            : createDashboardBreakdownItem(group, groupType));
    }

    if (groups.length > 5) {
        const toggleBtn =
            document.createElement('button');
        toggleBtn.type = 'button';
        toggleBtn.className =
            'dashboard-breakdown-toggle-btn';
        toggleBtn.setAttribute(
            'aria-expanded',
            String(isExpanded)
        );
        toggleBtn.textContent = isExpanded
            ? `${groupType === 'facility' ? '先頭' : '上位'}5件のみ表示 ▲`
            : `すべて表示（全${groups.length}件） ▼`;

        toggleBtn.addEventListener('click', () => {
            dashboardBreakdownExpanded[groupType] =
                !dashboardBreakdownExpanded[groupType];
            renderDashboardBreakdowns();
            window.requestAnimationFrame(() => {
                const newToggle =
                    container.querySelector(
                        '.dashboard-breakdown-toggle-btn'
                    );
                if (newToggle instanceof HTMLElement) {
                    newToggle.focus();
                }
            });
        });

        container.appendChild(toggleBtn);
    }
}

/**
 * ダッシュボードの内訳を描画する。
 */

/**
 * ダッシュボードの内訳を描画する。
 */
export function renderDashboardBreakdowns() {
    const groups =
        dashboardModel?.groups ||
        {};

    renderDashboardBreakdownList({
        containerId:
            'dashboard-facility-list',

        countId:
            'dashboard-facility-group-count',

        groupType:
            'facility',

        groups:
            groups.facilities,

        emptyMessage:
            '設置建物・フロアの集計対象がありません。'
    });

    renderDashboardBreakdownList({
        containerId:
            'dashboard-type-list',

        countId:
            'dashboard-type-group-count',

        groupType:
            'type',

        groups:
            groups.types,

        emptyMessage:
            '機器種別別の集計対象がありません。'
    });

}




export function renderDashboardMonitoring() {
    const totals =
        dashboardModel?.totals ||
        {};

    const totalDevices =
        Math.max(0, Number(totals.devices) || 0);
    const green =
        Math.max(0, Number(totals.green) || 0);
    const red =
        Math.max(0, Number(totals.red) || 0);
    const unknown =
        Math.max(0, Number(totals.unknown) || 0);

    const greenPercent =
        totalDevices > 0 ? (green / totalDevices) * 100 : 0;
    const redPercent =
        totalDevices > 0 ? (red / totalDevices) * 100 : 0;
    const unknownPercent =
        totalDevices > 0 ? (unknown / totalDevices) * 100 : 0;

    const barGreen =
        document.getElementById('dashboard-bar-green');
    const barRed =
        document.getElementById('dashboard-bar-red');
    const barUnknown =
        document.getElementById('dashboard-bar-unknown');

    if (barGreen) {
        barGreen.style.width = `${greenPercent.toFixed(1)}%`;
    }
    if (barRed) {
        barRed.style.width = `${redPercent.toFixed(1)}%`;
    }
    if (barUnknown) {
        barUnknown.style.width = `${unknownPercent.toFixed(1)}%`;
    }

    const rowBarGreen =
        document.getElementById('dashboard-row-bar-green');
    const rowBarRed =
        document.getElementById('dashboard-row-bar-red');
    const rowBarUnknown =
        document.getElementById('dashboard-row-bar-unknown');

    if (rowBarGreen) {
        rowBarGreen.style.width = `${greenPercent.toFixed(1)}%`;
    }
    if (rowBarRed) {
        rowBarRed.style.width = `${redPercent.toFixed(1)}%`;
    }
    if (rowBarUnknown) {
        rowBarUnknown.style.width = `${unknownPercent.toFixed(1)}%`;
    }

    const greenCount =
        document.getElementById('dashboard-monitoring-green-count');
    const redCount =
        document.getElementById('dashboard-monitoring-red-count');
    const unknownCount =
        document.getElementById('dashboard-monitoring-unknown-count');

    if (greenCount) {
        greenCount.textContent = `${green}台`;
    }
    if (redCount) {
        redCount.textContent = `${red}台`;
    }
    if (unknownCount) {
        unknownCount.textContent = `${unknown}台`;
    }

    const greenPercentEl =
        document.getElementById('dashboard-monitoring-green-percent');
    const redPercentEl =
        document.getElementById('dashboard-monitoring-red-percent');
    const unknownPercentEl =
        document.getElementById('dashboard-monitoring-unknown-percent');

    if (greenPercentEl) {
        greenPercentEl.textContent = `${greenPercent.toFixed(1)}%`;
    }
    if (redPercentEl) {
        redPercentEl.textContent = `${redPercent.toFixed(1)}%`;
    }
    if (unknownPercentEl) {
        unknownPercentEl.textContent = `${unknownPercent.toFixed(1)}%`;
    }

    const coverageEl =
        document.getElementById('dashboard-monitoring-coverage');
    if (coverageEl) {
        coverageEl.textContent = `OK率 ${greenPercent.toFixed(1)}%`;
    }

    const rowGreen =
        document.querySelector('.dashboard-status-row.is-green');
    const rowRed =
        document.querySelector('.dashboard-status-row.is-red');
    const rowUnknown =
        document.querySelector('.dashboard-status-row.is-unknown');

    if (rowGreen instanceof HTMLButtonElement) {
        rowGreen.disabled = green === 0;
    }
    if (rowRed instanceof HTMLButtonElement) {
        rowRed.disabled = red === 0;
    }
    if (rowUnknown instanceof HTMLButtonElement) {
        rowUnknown.disabled = unknown === 0;
    }
}

export function renderDashboardCounts() {
    const totals =
        dashboardModel?.totals ||
        {};

    setDashboardCount(
        'dashboard-devices-count',
        totals.devices
    );

    setDashboardCount(
        'dashboard-unplaced-count',
        totals.unplacedDevices
    );

    setDashboardCount(
        'dashboard-incomplete-count',
        totals.incompleteDevices
    );

    setDashboardCount(
        'dashboard-quality-error-count',
        totals.qualityErrors
    );

    setDashboardCount(
        'dashboard-quality-warning-count',
        totals.qualityWarnings
    );

    setDashboardCount(
        'dashboard-floor-plan-missing-count',
        totals.floorViewsWithoutPlan
    );

    const expired = dashboardModel?.maintenance.expired ?? 0;
    setDashboardCount('dashboard-operations-expired-count', expired);
    document.getElementById('dashboard-operations-expired-count')?.closest('button')
        ?.classList.toggle('is-warning', expired > 0);
    setDashboardCount('dashboard-quality-panel-total', totals.qualityProblems);
    renderDashboardMonitoring();
}





export function renderDashboardNotices() {
    const container =
        document.getElementById(
            'dashboard-notices'
        );

    if (!container) {
        return;
    }

    container.replaceChildren();

    const notices = [];

    if (
        dashboardModel
            ?.hasUnsavedChanges
    ) {
        notices.push({
            type: 'warning',
            text:
                '画面に未保存の変更があります。' +
                '基本集計には画面上の変更が含まれますが、' +
                '品質診断は保存済みデータを基準にしています。'
        });
    }

    if (dashboardModel?.qualitySync === 'loading' && !isDashboardLoading) {
        notices.push({ type: 'warning', text: 'データ品質情報を更新しています。' });
    }
    if (dashboardModel && !dashboardModel.qualityAvailable && dashboardModel.qualitySync !== 'loading') {
        notices.push({
            type: 'warning',
            text:
                'データ品質情報を取得できていません。' +
                '更新ボタンで再取得してください。'
        });
    }

    if (dashboardModel?.qualitySync === 'revision_mismatch' ||
        (dashboardModel?.qualitySync === 'unsaved' && dashboardModel.qualityRevisionMatches === false)) {
        notices.push({
            type: 'error',
            text:
                '品質診断のリビジョンと現在の画面データが' +
                '一致していません。再読み込み後に更新してください。'
        });
    }

    notices.forEach(notice => {
        const paragraph =
            document.createElement(
                'p'
            );

        paragraph.className =
            'dashboard-notice ' +
            `is-${notice.type}`;

        paragraph.textContent =
            notice.text;

        container.appendChild(
            paragraph
        );
    });

    container.hidden =
        notices.length === 0;
}


async function openDashboardRack(viewId) {
    if (appState.isDashboardNavigating) return;
    appState.isDashboardNavigating = true;
    try {
        const { switchView } = await import('./view-manager-modal.js');
        // 確認のキャンセルや切替失敗ではダッシュボードを閉じない。
        if (!await switchView(viewId)) return;
        hideDashboardForNavigation();
        document.getElementById('view-search-input')?.focus();
    } catch (error) {
        console.error(error);
        showToast('ラックビューへ移動できませんでした', 'error');
    } finally {
        appState.isDashboardNavigating = false;
    }
}

function renderDashboardRacks() {
    const racks = dashboardModel.racks;
    setDashboardCount('dashboard-racks-count', racks.total);
    setDashboardCount('dashboard-rack-devices-count', racks.mountedDevices);
    const list = document.getElementById('dashboard-rack-list');
    if (!list) return;
    list.replaceChildren();
    if (!racks.items.length) {
        const empty = document.createElement('p');
        empty.className = 'dashboard-breakdown-empty';
        empty.textContent = '登録済みのラックはありません';
        list.appendChild(empty);
        return;
    }
    for (const rack of racks.items) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'dashboard-rack-row';
        const info = document.createElement('span');
        info.className = 'dashboard-rack-info';
        const heading = document.createElement('span');
        heading.className = 'dashboard-rack-heading';
        const name = document.createElement('strong');
        name.textContent = rack.name;
        heading.appendChild(name);
        const mounted = document.createElement('span');
        mounted.className = 'dashboard-rack-count';
        mounted.textContent = '搭載 ';
        const count = document.createElement('span');
        count.className = 'dashboard-rack-devices';
        count.textContent = `${rack.deviceCount}台`;
        mounted.appendChild(count);
        heading.appendChild(mounted);
        const arrow = document.createElement('span');
        arrow.textContent = '›';
        arrow.setAttribute('aria-hidden', 'true');
        heading.appendChild(arrow);
        info.appendChild(heading);
        const faces = document.createElement('span');
        faces.className = 'dashboard-rack-faces';
        for (const [face, label] of [['front', '前面'], ['rear', '背面']]) {
            const usage = rack.faces?.[face];
            const column = document.createElement('span');
            const free = document.createElement('span');
            free.className = `dashboard-rack-${face}-free`;
            free.textContent = `${label} 空き ${usage ? `${usage.empty}U` : '—'}`;
            column.appendChild(free);
            if (usage) {
                const track = document.createElement('span');
                track.className = 'dashboard-rack-occupancy-track';
                track.setAttribute('aria-hidden', 'true');
                const bar = document.createElement('span');
                bar.className = 'dashboard-rack-occupancy-bar';
                bar.style.width = `${usage.occupiedPercentage}%`;
                track.appendChild(bar);
                column.appendChild(track);
            }
            faces.appendChild(column);
        }
        info.appendChild(faces);
        const location = [rack.hierarchyPath, rack.location].filter(Boolean).join(' / ');
        if (location) {
            const detail = document.createElement('small');
            detail.textContent = location;
            info.appendChild(detail);
        }
        row.appendChild(info);
        row.addEventListener('click', () => openDashboardRack(rack.id));
        list.appendChild(row);
    }
}

function createDashboardButton(action, data = {}) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.dashboardAction = action;
    Object.assign(button.dataset, data);
    return button;
}

function dashboardBar(segments) {
    const track = document.createElement('span');
    track.className = 'dashboard-breakdown-track dashboard-analysis-bar';
    track.setAttribute('aria-hidden', 'true');
    for (const [percentage, style] of segments) {
        const bar = document.createElement('span');
        bar.className = `dashboard-breakdown-bar ${style}`;
        bar.style.width = `${percentage}%`;
        track.appendChild(bar);
    }
    return track;
}

function renderDashboardMaintenance() {
    const maintenance = dashboardModel.maintenance;
    const mode = document.getElementById('dashboard-maintenance-mode');
    const start = document.getElementById('dashboard-fiscal-start');
    const fiscal = maintenanceMode === 'fiscal';
    if (mode) mode.value = maintenanceMode;
    if (start) {
        start.value = String(fiscalYearStartMonth);
        start.hidden = !fiscal;
    }
    const startLabel = document.getElementById('dashboard-fiscal-start-label');
    if (startLabel) startLabel.hidden = !fiscal;
    for (const category of ['expired', 'unset', 'suppressed', 'invalid']) {
        setDashboardCount(`dashboard-maintenance-${category}-count`, maintenance[category]);
    }
    const expiredCard = document.getElementById('dashboard-maintenance-expired-count')?.closest('button');
    expiredCard?.classList.toggle('is-warning', maintenance.expired > 0);
    const invalidCard = document.getElementById('dashboard-maintenance-invalid');
    if (invalidCard) {
        invalidCard.hidden = maintenance.invalid === 0;
        invalidCard.disabled = dashboardModel.qualitySync === 'loading';
    }

    const list = document.getElementById('dashboard-maintenance-list');
    if (!list) return;
    const periods = fiscal ? maintenance.fiscalYears.map(({ label, count }, index) => ({
        label: label.split('（')[0], count, action: 'ledger-maintenance-year', index, title: label
    })) : ['within1Year', 'within2Years', 'beyond2Years'].map(category => ({
        label: MAINTENANCE_EXPIRY_LABELS[category], count: maintenance[category],
        action: 'ledger-maintenance', maintenanceCategory: category
    }));
    const maximum = Math.max(1, ...periods.map(period => period.count));
    list.replaceChildren(...periods.map(({ label, count, title, ...data }) => {
        const { action, ...params } = data;
        const button = createDashboardButton(action, params);
        button.className = 'dashboard-inline-metric dashboard-maintenance-period';
        const name = document.createElement('span');
        name.className = 'dashboard-maintenance-period-label';
        name.textContent = label;
        const value = document.createElement('strong');
        value.textContent = `${count}台`;
        if (count === 0) value.className = 'dashboard-count-muted';
        if (title) button.title = title;
        button.append(name, value, dashboardBar([[count / maximum * 100, '']]));
        return button;
    }));
}

function renderDashboardNetworkRows(id, total, rows) {
    const container = document.getElementById(id);
    if (!container) return;
    container.replaceChildren(...rows.map(([label, count, unit, target]) => {
        const clickable = target && count > 0;
        const row = clickable ? createDashboardButton(target.action, target.data) : document.createElement('div');
        row.className = 'dashboard-network-row';
        const percentage = total ? count / total * 100 : 0;
        const name = document.createElement('span');
        name.textContent = label;
        const values = document.createElement('span');
        values.className = 'dashboard-network-values';
        const amount = document.createElement('strong');
        amount.textContent = `${count}${unit}`;
        const ratio = document.createElement('small');
        ratio.textContent = `${percentage.toFixed(1)}%`;
        values.append(amount, ratio);
        row.append(name, values);
        if (clickable) {
            const arrow = document.createElement('span');
            arrow.className = 'dashboard-network-arrow';
            arrow.setAttribute('aria-hidden', 'true');
            arrow.textContent = '→';
            row.appendChild(arrow);
        }
        row.appendChild(dashboardBar([[percentage, '']]));
        return row;
    }));
}

function renderDashboardNetwork() {
    const network = dashboardModel.network;
    setDashboardCount('dashboard-network-port-count', network.portCount);
    setDashboardCount('dashboard-network-link-count', network.linkCount);
    setDashboardCount('dashboard-network-device-count', network.devicesWithPorts);
    renderDashboardNetworkRows('dashboard-network-ports', network.portCount, [
        ['接続で参照中', network.connectedPorts, '件'],
        ['未接続', network.unconnectedPorts, '件']
    ]);
    if (network.endpoints) {
        renderDashboardNetworkRows('dashboard-network-endpoints', network.linkCount * 2, [
            ['指定済み', network.endpoints.specified, '端点'],
            ['未指定', network.endpoints.missing, '端点',
                { action: 'quality-code', data: { code: DASHBOARD_QUALITY_CODES.linkPortsMissing } }],
            ['設定不要', network.endpoints.suppressed, '端点',
                { action: 'quality-code', data: { code: DASHBOARD_QUALITY_CODES.linkPortsMissing, showSuppressed: 'true' } }]
        ]);
    } else {
        document.getElementById('dashboard-network-endpoints')
            ?.replaceChildren(createDashboardBreakdownEmpty('—'));
    }
    renderDashboardNetworkRows('dashboard-network-topology', network.linkCount, [
        ['同一フロア内', network.topology.sameFloor, '件'],
        ['フロア間（同一建物）', network.topology.betweenFloors, '件'],
        ['建物間', network.topology.betweenBuildings, '件'],
        ['設置フロア・所属不明', network.topology.unknown, '件']
    ]);
}

function createDashboardQualityCount(label, count, { action, data, context, unit }) {
    const value = count == null ? '—' : `${count}${unit}`;
    const element = action && count > 0 ? createDashboardButton(action, data) : document.createElement('span');
    if (element.tagName === 'BUTTON') {
        element.className = 'dashboard-count-action';
        element.setAttribute('aria-label', `${context}：${label} ${value}`);
    } else if (count == null || count === 0) {
        element.className = 'dashboard-count-muted';
    }
    element.textContent = value;
    return element;
}

function createDashboardRegistrationRow(field) {
    const row = document.createElement('tr');
    row.setAttribute('role', 'row');
    const heading = document.createElement('th');
    heading.setAttribute('scope', 'row');
    heading.setAttribute('role', 'rowheader');
    heading.textContent = field.label;
    const total = field.registered + field.missing + field.suppressed;
    const bar = document.createElement('td');
    bar.setAttribute('role', 'cell');
    bar.appendChild(dashboardBar([
        [total ? field.registered / total * 100 : 0, 'is-registered'],
        [total ? field.missing / total * 100 : 0, 'is-missing'],
        [total ? field.suppressed / total * 100 : 0, 'is-suppressed']
    ]));
    const rate = document.createElement('td');
    rate.setAttribute('role', 'cell');
    rate.className = 'dashboard-registration-rate';
    rate.textContent = field.percentage == null ? '対象なし' : `${field.percentage.toFixed(1)}%`;
    row.append(heading, bar, rate);
    const filter = { code: field.code };
    if (field.code === DASHBOARD_QUALITY_CODES.missingRecommendedFields) filter.field = field.key;
    for (const [label, count, data] of [
        ['登録済み', field.registered, null],
        ['未登録', field.missing, filter],
        ['設定不要', field.suppressed, { ...filter, showSuppressed: 'true' }]
    ]) {
        const cell = document.createElement('td');
        cell.setAttribute('role', 'cell');
        const narrowLabel = document.createElement('span');
        narrowLabel.className = 'dashboard-registration-cell-label';
        narrowLabel.setAttribute('aria-hidden', 'true');
        narrowLabel.textContent = label;
        cell.append(narrowLabel, createDashboardQualityCount(label, count, {
            action: data ? 'quality-code' : null, data, context: field.label, unit: '台'
        }));
        row.appendChild(cell);
    }
    return row;
}

function renderDashboardQuality() {
    const quality = dashboardModel.quality;
    for (const key of ['problems', 'error', 'warning', 'info', 'suppressed']) {
        setDashboardCount(`dashboard-diagnosis-${key}-count`, quality?.[key]);
    }
    const migration = document.getElementById('dashboard-diagnosis-migration');
    if (migration) {
        const entries = [
            ['移行保留', quality?.legacyConflicts, DASHBOARD_QUALITY_CODES.legacyLinkConflict],
            ['未移行VLAN', quality?.legacyVlans, DASHBOARD_QUALITY_CODES.legacyLinkVlan]
        ].filter(([, count]) => count > 0);
        migration.replaceChildren(...entries.map(([label, count, code]) => {
            const button = createDashboardButton('quality-code', { code });
            button.className = 'dashboard-inline-metric is-warning';
            button.textContent = `${label} ${count}件 →`;
            return button;
        }));
        migration.hidden = entries.length === 0;
    }

    const categories = document.getElementById('dashboard-diagnosis-categories');
    if (categories) {
        const counts = new Map(quality?.categories.map(category => [category.key, category]));
        const keys = new Set([...Object.keys(DATA_QUALITY_CATEGORY_LABELS), ...counts.keys()]);
        categories.replaceChildren(...Array.from(keys, key => {
            const row = document.createElement('div');
            row.className = 'dashboard-category-row';
            const label = DATA_QUALITY_CATEGORY_LABELS[key] ?? key;
            const name = document.createElement('strong');
            name.textContent = label;
            row.appendChild(name);
            for (const [kind, severity, count] of [
                ['問題', 'problems', counts.get(key)?.problems],
                ['情報', 'info', counts.get(key)?.info]
            ]) {
                const cell = document.createElement('span');
                cell.append(document.createTextNode(`${kind} `),
                    createDashboardQualityCount(kind, quality ? count ?? 0 : null, {
                        action: 'quality-category', data: { category: key, severity }, context: label, unit: '件'
                    }));
                row.appendChild(cell);
            }
            return row;
        }));
    }
    const table = document.getElementById('dashboard-registration-table');
    const status = document.getElementById('dashboard-registration-status');
    if (status) status.hidden = Boolean(quality);
    if (table) table.hidden = !quality;
    document.getElementById('dashboard-registration-rows')
        ?.replaceChildren(...(quality?.registration ?? []).map(createDashboardRegistrationRow));
}

export function renderDashboardAfterQualityChange() {
    if (isDashboardLoading || getDashboardOverlay()?.hidden !== false) return;
    renderDashboard();
    if (dashboardModel.qualitySync === 'synced') setDashboardStatusHidden();
}

export function renderDashboardAfterSaveStateChange() {
    if (getDashboardOverlay()?.hidden !== false) return;
    if (dashboardRevision !== appState.dataRevision ||
        dashboardModel?.hasUnsavedChanges !== Boolean(appState.appStatus?.dirty)) {
        renderDashboard();
    }
}

export function renderDashboard() {
    dashboardModel = createCurrentDashboardModel();
    dashboardRevision = appState.dataRevision;
    const content =
        document.getElementById(
            'dashboard-content'
        );

    renderDashboardCounts();
    setDashboardCount('dashboard-assets-devices-count', dashboardModel.totals.devices);
    setDashboardCount('dashboard-assets-facilities-count',
        dashboardModel.groups.facilities.filter(group => group.buildingId != null).length);
    renderDashboardMaintenance();
    renderDashboardNetwork();
    renderDashboardQuality();
    renderDashboardNotices();
    renderDashboardRacks();
    renderDashboardBreakdowns();
    renderDashboardIpSummary();

    if (content) {
        content.hidden = false;
    }
}


export function renderDashboardError(
    message
) {
    const status =
        document.getElementById(
            'dashboard-status'
        );

    const content =
        document.getElementById(
            'dashboard-content'
        );

    if (content) {
        content.hidden = false;
    }

    if (status) {
        status.hidden = false;
        status.className =
            'dashboard-status is-error';

        status.textContent =
            String(message);
    }

    renderDashboardNotices();
}




