/**
 * Netarium - modals/dashboard-modal.js
 */

import {
    DASHBOARD_QUALITY_CODES,
    DASHBOARD_UNSET_LABEL,
    DEVICE_TYPES
} from '../core/constants.js';
import { appState, normalizeStatus } from '../core/state.js';
import {
    buildDashboardModel,
    validateDashboardModel
} from '../core/dashboard-model.js';
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
import {
    fetchDataQuality,
    focusDataQualityDialog,
    normalizeDataQualityCodeFilter,
    normalizeDataQualityIds,
    refreshDataQuality,
    renderDataQuality
} from './data-quality-modal.js';
let dashboardModel = null;
let isDashboardLoading = false;
let dashboardPreviousFocus = null;
const dashboardBreakdownExpanded = {
    facility: false,
    floor: false,
    type: false
};
function createCurrentDashboardModel(qualityResult = appState.dataQualityResult) {
    return buildDashboardModel({
        devices: appState.devices,
        placements: appState.placements,
        qualityResult,
        dataRevision: appState.dataRevision,
        dirty: appState.appStatus?.dirty
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
            '[tabindex]:not([tabindex="-1"])'
        )
    ).filter(element => {
        if (
            !(element instanceof
                HTMLElement)
        ) {
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
    dashboardBreakdownExpanded.floor = false;
    dashboardBreakdownExpanded.type = false;

    appState.isDashboardNavigating = false;

    overlay.hidden = false;

    document.body.classList.add(
        'dashboard-open'
    );

    /*
     * 品質結果を取得する前でも、
     * 基本集計を先に表示できる。
     */
    dashboardModel =
        createCurrentDashboardModel();

    renderDashboard();
    registerModalOpen('dashboard', overlay, '#dashboard-refresh-btn', { onClose: closeDashboard });
    focusDashboard();
    refreshDashboard();
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

        renderDataQuality();

        overlay.hidden = false;

        appState.dataQualityPreviousFocus = null;

        focusDataQualityDialog();

        const resultRevision =
            Number(
                appState.dataQualityResult
                    ?.revision ||
                0
            );

        if (
            !appState.dataQualityResult ||
            (
                resultRevision > 0 &&
                Number(appState.dataRevision) > 0 &&
                resultRevision !==
                    Number(appState.dataRevision)
            )
        ) {
            refreshDataQuality();
        }

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


/**
 * ダッシュボードカードの操作を実行する。
 */

/**
 * ダッシュボードカードの操作を実行する。
 */
export function handleDashboardAction(
    action
) {
    if (appState.isDashboardNavigating) {
        return;
    }
    const normalizedAction =
        String(action || '');

    switch (normalizedAction) {
        case 'ledger-all':
            openDashboardLedger();
            return;

        case 'ledger-green':
            openDashboardLedger({
                status: 'green'
            });
            return;

        case 'ledger-red':
            openDashboardLedger({
                status: 'red'
            });
            return;

        case 'ledger-unknown':
            openDashboardLedger({
                status: 'unknown'
            });
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
            openDashboardLedger({ placement: 'unplaced' });
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
            openDashboardDataQuality();
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
    if (isDashboardLoading) {
        return;
    }

    isDashboardLoading = true;

    setDashboardLoadingState(
        true
    );

    /*
     * 品質APIを待っている間も、
     * 現在の画面データによる基本集計を表示する。
     */
    dashboardModel =
        createCurrentDashboardModel();

    renderDashboard();

    try {
        appState.dataQualityResult =
            await fetchDataQuality();

        dashboardModel =
            createCurrentDashboardModel(
                appState.dataQualityResult
            );

        const validationErrors =
            validateDashboardModel(
                dashboardModel
            );

        if (
            validationErrors.length > 0
        ) {
            console.warn(
                'ダッシュボード集計の整合性警告',
                validationErrors
            );

            renderDashboardError(
                '集計結果の一部に整合しない値があります。'
            );

            return;
        }

        renderDashboard();
        setDashboardStatusHidden();
    } catch (error) {
        console.error(error);

        /*
         * 基本集計は残し、品質指標だけ
         * 取得できない状態として表示する。
         */
        appState.dataQualityResult = null;

        dashboardModel =
            createCurrentDashboardModel(null);

        renderDashboard();

        renderDashboardError(
            error.message ||
            'データ品質情報を取得できませんでした'
        );

    } finally {
        isDashboardLoading = false;

        setDashboardLoadingState(
            false
        );
        renderDashboardCounts();
    }
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
        button.textContent =
            loading
                ? '更新中...'
                : '更新';
    }

    if (status) {
        if (loading) {
            status.hidden = false;
            status.className =
                'dashboard-status is-loading';

            status.textContent =
                'データ品質情報を取得しています...';
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

    /*
     * 品質情報の更新中は、カードと内訳の
     * 遷移操作を一時的に無効化する。
     */
    document
        .querySelectorAll(
            '#dashboard-content ' +
            '[data-dashboard-action]'
        )
        .forEach(element => {
            if (
                !(element instanceof
                    HTMLButtonElement)
            ) {
                return;
            }

            if (loading) {
                if (
                    !Object.prototype
                        .hasOwnProperty.call(
                            element.dataset,
                            'disabledBeforeDashboardLoading'
                        )
                ) {
                    element.dataset
                        .disabledBeforeDashboardLoading =
                        element.disabled
                            ? 'true'
                            : 'false';
                }

                element.disabled = true;
                return;
            }

            if (
                !Object.prototype
                    .hasOwnProperty.call(
                        element.dataset,
                        'disabledBeforeDashboardLoading'
                    )
            ) {
                return;
            }

            element.disabled =
                element.dataset
                    .disabledBeforeDashboardLoading ===
                    'true';

            delete element.dataset
                .disabledBeforeDashboardLoading;
        });
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

    const number =
        Number(value);

    const normalizedValue =
        Number.isFinite(number)
            ? Math.max(
                0,
                number
            )
            : 0;

    element.textContent =
        String(normalizedValue);

    const card =
        element.closest(
            '[data-dashboard-action]'
        );

    if (!card) {
        return;
    }

    /*
     * 総機器数は0件でも台帳を開ける。
     * それ以外は0件時に無効化する。
     */
    const alwaysEnabled =
        card.dataset
            .dashboardAction ===
        'ledger-all';

    if (
        card instanceof
            HTMLButtonElement
    ) {
        card.disabled =
            !alwaysEnabled &&
            normalizedValue === 0;
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
        const facility =
            String(
                group?.label || ''
            );

        if (
            facility ===
            DASHBOARD_UNSET_LABEL
        ) {
            canNavigate = false;
        } else {
            item.dataset.dashboardAction =
                'ledger-facility';

            item.dataset.facility =
                facility;
        }
    }

    if (normalizedGroupType === 'floor') {
        const facility =
            String(
                group?.facility || ''
            );

        const floor =
            String(
                group?.floor || ''
            );

        if (
            facility ===
                DASHBOARD_UNSET_LABEL ||
            floor ===
                DASHBOARD_UNSET_LABEL
        ) {
            canNavigate = false;
        } else {
            item.dataset.dashboardAction =
                'ledger-floor';

            item.dataset.facility =
                facility;

            item.dataset.floor =
                floor;
        }
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

    /*
     * 横棒も表示値と同じく、
     * 総機器数に対する割合で描画する。
     */
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

    itemsToDisplay.forEach(group => {
        container.appendChild(
            createDashboardBreakdownItem(
                group,
                groupType
            )
        );
    });

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
            ? '上位5件のみ表示 ▲'
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
            '施設別の集計対象がありません。'
    });

    renderDashboardBreakdownList({
        containerId:
            'dashboard-floor-list',

        countId:
            'dashboard-floor-group-count',

        groupType:
            'floor',

        groups:
            groups.floors,

        emptyMessage:
            'フロア別の集計対象がありません。'
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
        'dashboard-green-count',
        totals.green
    );

    setDashboardCount(
        'dashboard-red-count',
        totals.red
    );

    setDashboardCount(
        'dashboard-unknown-count',
        totals.unknown
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

    const qualityProblems =
        Number(
            totals.qualityProblems ??
            (Number(totals.qualityErrors || 0) + Number(totals.qualityWarnings || 0))
        );

    setDashboardCount(
        'dashboard-quality-total-count',
        qualityProblems
    );

    renderDashboardMonitoring();

    const panelTotal =
        document.getElementById('dashboard-quality-panel-total');
    if (panelTotal) {
        panelTotal.textContent =
            String(qualityProblems);
        const panelTotalBtn =
            panelTotal.closest('button');
        if (panelTotalBtn instanceof HTMLButtonElement) {
            panelTotalBtn.disabled =
                qualityProblems === 0;
        }
    }

    const errorRow =
        document.querySelector('.dashboard-quality-row.is-error');
    const warningRow =
        document.querySelector('.dashboard-quality-row.is-warning');
    const floorPlanRow =
        document.querySelector('.dashboard-quality-row.is-floor-plan');

    if (errorRow instanceof HTMLButtonElement) {
        errorRow.disabled =
            Number(totals.qualityErrors || 0) === 0;
    }
    if (warningRow instanceof HTMLButtonElement) {
        warningRow.disabled =
            Number(totals.qualityWarnings || 0) === 0;
    }
    if (floorPlanRow instanceof HTMLButtonElement) {
        floorPlanRow.disabled =
            Number(totals.floorViewsWithoutPlan || 0) === 0;
    }
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

    if (
        dashboardModel &&
        !dashboardModel
            .qualityAvailable &&
        !isDashboardLoading
    ) {
        notices.push({
            type: 'warning',
            text:
                'データ品質情報を取得できていません。' +
                '更新ボタンで再取得してください。'
        });
    }

    if (
        dashboardModel
            ?.qualityRevisionMatches ===
        false
    ) {
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


export function renderDashboard() {
    const content =
        document.getElementById(
            'dashboard-content'
        );

    const status =
        document.getElementById(
            'dashboard-status'
        );

    renderDashboardCounts();
    renderDashboardNotices();
    renderDashboardBreakdowns();

    if (content) {
        content.hidden = false;
    }

    if (
        status &&
        !isDashboardLoading
    ) {
        status.hidden = true;
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




