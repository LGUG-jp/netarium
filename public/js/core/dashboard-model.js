/**
 * Netarium - core/dashboard-model.js
 *
 * ダッシュボード集計の純粋計算モデル。
 * DOMやappStateなどの外部状態に依存せず、引数として渡されたデータから
 * 完全に決定論的な集計モデルを構築・検証する。
 */

import {
    DASHBOARD_QUALITY_CODES,
    DASHBOARD_UNSET_LABEL,
    DEVICE_TYPES
} from './constants.js';

import { normalizeStatus } from './state.js';
import { getUnplacedDeviceIds } from './device-placement.js';
import { normalizeDataQualityIds } from '../modals/data-quality-modal.js';

/**
 * ダッシュボードの分類値を整える。
 * 前後空白を除去し、空欄は「未設定」とする。
 */
export function normalizeDashboardGroupValue(value) {
    const text = String(value ?? '').trim();
    return text || DASHBOARD_UNSET_LABEL;
}

/**
 * ダッシュボードの分類比較キーを生成する。
 */
export function createDashboardGroupKey(value) {
    const normalized = normalizeDashboardGroupValue(value);
    try {
        return normalized.normalize('NFKC').toLocaleLowerCase('ja');
    } catch (error) {
        return normalized.toLocaleLowerCase('ja');
    }
}

/**
 * 項目値ごとの件数を集計する。
 */
export function aggregateDashboardGroups(items, getValue) {
    if (!Array.isArray(items) || typeof getValue !== 'function') {
        return [];
    }

    const groups = new Map();

    items.forEach(item => {
        const rawValue = getValue(item);
        const label = normalizeDashboardGroupValue(rawValue);
        const key = createDashboardGroupKey(label);

        const current = groups.get(key);
        if (current) {
            current.count++;
            return;
        }

        groups.set(key, {
            key,
            label,
            count: 1
        });
    });

    return Array.from(groups.values()).sort(compareDashboardGroups);
}

/**
 * 集計結果を件数降順、名称昇順で並べる。
 */
export function compareDashboardGroups(left, right) {
    const countDifference = Number(right?.count || 0) - Number(left?.count || 0);
    if (countDifference !== 0) {
        return countDifference;
    }
    return String(left?.label || '').localeCompare(String(right?.label || ''), 'ja');
}

/**
 * グループ集計へ総数に対する割合を付ける。
 */
export function addDashboardGroupPercentages(groups, total) {
    const normalizedTotal = Math.max(0, Number(total) || 0);

    return (Array.isArray(groups) ? groups : []).map(group => {
        const count = Math.max(0, Number(group?.count) || 0);
        const percentage = normalizedTotal > 0 ? (count / normalizedTotal) * 100 : 0;

        return {
            ...group,
            count,
            percentage: Math.round(percentage * 10) / 10
        };
    });
}

/**
 * 機器を施設別に集計する。
 */
export function aggregateDashboardFacilities(sourceDevices = []) {
    const devices = Array.isArray(sourceDevices) ? sourceDevices : [];
    const groups = aggregateDashboardGroups(devices, device => device?.facility);
    return addDashboardGroupPercentages(groups, devices.length);
}

/**
 * 機器を施設・フロアの組み合わせで集計する。
 */
export function aggregateDashboardFloors(sourceDevices = []) {
    const devices = Array.isArray(sourceDevices) ? sourceDevices : [];
    const groupMap = new Map();

    devices.forEach(device => {
        const facility = normalizeDashboardGroupValue(device?.facility);
        const floor = normalizeDashboardGroupValue(device?.floor);
        const facilityKey = createDashboardGroupKey(facility);
        const floorKey = createDashboardGroupKey(floor);
        const key = `${facilityKey}\u0000${floorKey}`;

        const current = groupMap.get(key);
        if (current) {
            current.count++;
            return;
        }

        groupMap.set(key, {
            key,
            facility,
            floor,
            label: `${facility} / ${floor}`,
            count: 1
        });
    });

    const groups = Array.from(groupMap.values()).sort(compareDashboardGroups);
    return addDashboardGroupPercentages(groups, devices.length);
}

/**
 * 機器種別の表示名を返す。
 */
export function getDashboardDeviceTypeLabel(type) {
    const normalizedType = String(type || '').trim();
    if (normalizedType && DEVICE_TYPES[normalizedType]) {
        return DEVICE_TYPES[normalizedType].label;
    }
    return DASHBOARD_UNSET_LABEL;
}

/**
 * 機器を種別別に集計する。
 */
export function aggregateDashboardDeviceTypes(sourceDevices = []) {
    const devices = Array.isArray(sourceDevices) ? sourceDevices : [];
    const groups = new Map();

    devices.forEach(device => {
        const rawType = String(device?.type || '').trim();
        const type = rawType && DEVICE_TYPES[rawType] ? rawType : '';
        const key = type || '__unset__';

        const current = groups.get(key);
        if (current) {
            current.count++;
            return;
        }

        groups.set(key, {
            key,
            type,
            label: getDashboardDeviceTypeLabel(type),
            count: 1
        });
    });

    const result = Array.from(groups.values()).sort(compareDashboardGroups);
    return addDashboardGroupPercentages(result, devices.length);
}

/**
 * 機器の監視状態を集計する。
 */
export function aggregateDashboardMonitoring(sourceDevices = []) {
    const devices = Array.isArray(sourceDevices) ? sourceDevices : [];
    const summary = {
        green: 0,
        red: 0,
        unknown: 0
    };

    devices.forEach(device => {
        const status = normalizeStatus(device?.status);
        if (status === 'green') {
            summary.green++;
        } else if (status === 'red') {
            summary.red++;
        } else {
            summary.unknown++;
        }
    });

    return summary;
}


/**
 * データ品質診断のissue配列を取得する。
 */
export function getDashboardQualityIssues(qualityResult = null) {
    return Array.isArray(qualityResult?.issues) ? qualityResult.issues : [];
}

/**
 * 指定したcodeの診断問題を取得する。
 */
export function getDashboardIssuesByCodes(codes, qualityResult = null) {
    const codeSet = new Set(
        (Array.isArray(codes) ? codes : [codes])
            .map(code => String(code || ''))
            .filter(Boolean)
    );

    if (codeSet.size === 0) {
        return [];
    }

    return getDashboardQualityIssues(qualityResult).filter(issue =>
        codeSet.has(String(issue?.code || ''))
    );
}

/**
 * 診断問題から指定entity_typeの一意な対象IDを取得する。
 */
export function getDashboardUniqueEntityIds(issues, entityType) {
    const normalizedType = String(entityType || '');
    const ids = new Set();

    (Array.isArray(issues) ? issues : []).forEach(issue => {
        if (String(issue?.entity_type || '') !== normalizedType) {
            return;
        }

        normalizeDataQualityIds(issue?.entity_ids).forEach(id => {
            ids.add(id);
        });
    });

    return Array.from(ids).sort((left, right) => left - right);
}

/**
 * 診断結果から未配置機器IDを取得する。
 */
export function getDashboardUnplacedDeviceIds(qualityResult = null) {
    const issues = getDashboardIssuesByCodes(
        DASHBOARD_QUALITY_CODES.unplacedDevice,
        qualityResult
    );
    return getDashboardUniqueEntityIds(issues, 'device');
}

/**
 * 診断結果から入力不足機器IDを取得する。
 */
export function getDashboardIncompleteDeviceIds(qualityResult = null) {
    const issues = getDashboardIssuesByCodes(
        [
            DASHBOARD_QUALITY_CODES.missingRequiredFields,
            DASHBOARD_QUALITY_CODES.missingRecommendedFields
        ],
        qualityResult
    );
    return getDashboardUniqueEntityIds(issues, 'device');
}

/**
 * 診断結果から図面未登録のフロアビューIDを取得する。
 */
export function getDashboardFloorViewsWithoutPlanIds(qualityResult = null) {
    const issues = getDashboardIssuesByCodes(
        DASHBOARD_QUALITY_CODES.floorViewWithoutPlan,
        qualityResult
    );
    return getDashboardUniqueEntityIds(issues, 'view');
}

/**
 * データ品質の問題件数を取得する。
 */
export function aggregateDashboardQuality(qualityResult = null) {
    const issues = getDashboardQualityIssues(qualityResult);

    const calculated = {
        error: 0,
        warning: 0,
        info: 0,
        total: issues.length
    };

    issues.forEach(issue => {
        const severity = String(issue?.severity || '');
        if (Object.prototype.hasOwnProperty.call(calculated, severity)) {
            calculated[severity]++;
        }
    });

    const apiSummary =
        qualityResult?.summary && typeof qualityResult.summary === 'object'
            ? qualityResult.summary
            : null;

    return {
        error:
            Number.isFinite(Number(apiSummary?.error))
                ? Math.max(0, Number(apiSummary.error))
                : calculated.error,
        warning:
            Number.isFinite(Number(apiSummary?.warning))
                ? Math.max(0, Number(apiSummary.warning))
                : calculated.warning,
        info:
            Number.isFinite(Number(apiSummary?.info))
                ? Math.max(0, Number(apiSummary.info))
                : calculated.info,
        total:
            Number.isFinite(Number(apiSummary?.total))
                ? Math.max(0, Number(apiSummary.total))
                : calculated.total
    };
}

/**
 * ダッシュボード表示用の純粋集計モデルを生成する。
 * 外部状態 (appState や DOM) を直接読まず、渡された引数のみから構築する。
 */
export function buildDashboardModel({
    devices = [],
    placements = [],
    qualityResult = null,
    dataRevision = 0,
    dirty = false
} = {}) {
    const sourceDevices = Array.isArray(devices) ? devices : [];
    const sourcePlacements = Array.isArray(placements) ? placements : [];

    const monitoring = aggregateDashboardMonitoring(sourceDevices);
    const quality = aggregateDashboardQuality(qualityResult);
    const stateUnplacedDeviceIds = getUnplacedDeviceIds(
        sourceDevices,
        sourcePlacements
    );
    const qualityUnplacedDeviceIds = getDashboardUnplacedDeviceIds(qualityResult);
    const incompleteDeviceIds = getDashboardIncompleteDeviceIds(qualityResult);
    const floorViewsWithoutPlanIds = getDashboardFloorViewsWithoutPlanIds(qualityResult);

    const qualityRevision = Number(qualityResult?.revision || 0);

    return {
        qualityAvailable: Boolean(qualityResult && qualityResult.ok === true),
        qualityRevisionMatches:
            qualityRevision > 0 && Number(dataRevision) > 0
                ? qualityRevision === Number(dataRevision)
                : null,
        hasUnsavedChanges: Boolean(dirty),
        totals: {
            devices: sourceDevices.length,
            green: monitoring.green,
            red: monitoring.red,
            unknown: monitoring.unknown,
            /* 基本集計は画面メモリ基準 */
            unplacedDevices: stateUnplacedDeviceIds.length,
            /* 品質指標は保存済みDB基準 */
            incompleteDevices: incompleteDeviceIds.length,
            qualityErrors: quality.error,
            qualityWarnings: quality.warning,
            qualityInfo: quality.info,
            qualityTotal: quality.total,
            qualityProblems: quality.error + quality.warning,
            floorViewsWithoutPlan: floorViewsWithoutPlanIds.length
        },
        entityIds: {
            stateUnplacedDevices: stateUnplacedDeviceIds,
            qualityUnplacedDevices: qualityUnplacedDeviceIds,
            incompleteDevices: incompleteDeviceIds,
            floorViewsWithoutPlan: floorViewsWithoutPlanIds
        },
        groups: {
            facilities: aggregateDashboardFacilities(sourceDevices),
            floors: aggregateDashboardFloors(sourceDevices),
            types: aggregateDashboardDeviceTypes(sourceDevices)
        }
    };
}

/**
 * ダッシュボードモデルの基本整合性を確認する。
 */
export function validateDashboardModel(model) {
    const errors = [];

    if (!model || typeof model !== 'object') {
        return ['ダッシュボードモデルがありません'];
    }

    const totals = model.totals || {};
    const deviceTotal = Number(totals.devices || 0);
    const monitoringTotal =
        Number(totals.green || 0) + Number(totals.red || 0) + Number(totals.unknown || 0);

    if (monitoringTotal !== deviceTotal) {
        errors.push('監視状態の合計が総機器数と一致しません');
    }

    [
        ['施設別', model.groups?.facilities],
        ['フロア別', model.groups?.floors],
        ['種別別', model.groups?.types]
    ].forEach(([label, groups]) => {
        const groupTotal = (Array.isArray(groups) ? groups : []).reduce(
            (sum, group) => sum + Number(group?.count || 0),
            0
        );
        if (groupTotal !== deviceTotal) {
            errors.push(`${label}件数の合計が総機器数と一致しません`);
        }
    });

    const qualityTotal =
        Number(totals.qualityErrors || 0) +
        Number(totals.qualityWarnings || 0) +
        Number(totals.qualityInfo || 0);

    if (model.qualityAvailable && qualityTotal !== Number(totals.qualityTotal || 0)) {
        errors.push('品質診断の重大度別件数と合計が一致しません');
    }

    return errors;
}
