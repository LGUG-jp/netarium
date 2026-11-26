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
    DATA_QUALITY_DEVICE_FIELD_LABELS,
    DEVICE_TYPES
} from './constants.js';

import { normalizeStatus } from './state.js';
import { getUnplacedDeviceIds } from './device-placement.js';
import { normalizeDataQualityIds } from '../modals/data-quality-modal.js';
import { aggregateMaintenanceExpiry } from './maintenance-expiry.js';
import { rackUsage } from './rack-layout.js';
import { compareHierarchyOrder, viewHierarchyPath } from './building-hierarchy.js';

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
 * 機器を設置建物ID別に集計する。
 */
export function aggregateDashboardFacilities(sourceDevices = [], hierarchy = {}) {
    const devices = Array.isArray(sourceDevices) ? sourceDevices : [];
    return aggregateFacilities(devices, indexDashboardFloors(hierarchy));
}

function indexDashboardFloors({ buildings = [], floors = [] }) {
    const buildingsById = new Map(buildings.map(building => [Number(building.id), building]));
    const locations = new Map();
    for (const floor of floors) {
        const buildingId = Number(floor.building_id);
        const building = buildingsById.get(buildingId);
        if (building) {
            locations.set(Number(floor.id), { floor, building, buildingId });
        }
    }
    return locations;
}

function aggregateFacilities(devices, locations) {
    const facilities = new Map();
    for (const device of devices) {
        const location = locations.get(Number(device.floor_id));
        const buildingId = location?.buildingId ?? null;
        let facility = facilities.get(buildingId);
        if (!facility) {
            facility = {
                key: buildingId === null ? 'unset' : String(buildingId),
                buildingId,
                building: location?.building,
                count: 0,
                floors: new Map()
            };
            facilities.set(buildingId, facility);
        }
        facility.count++;
        if (!location) continue;
        const floorId = Number(location.floor.id);
        const floorGroup = facility.floors.get(floorId);
        if (floorGroup) {
            floorGroup.count++;
        } else {
            facility.floors.set(floorId, {
                floor: location.floor,
                count: 1
            });
        }
    }
    const unassigned = facilities.get(null);
    facilities.delete(null);
    const ordered = [...facilities.values()].sort((a, b) => compareHierarchyOrder(a.building, b.building));
    if (unassigned) ordered.push(unassigned);
    const groups = ordered.map(({ building, floors, ...facility }) => ({
        ...facility,
        label: building?.name ?? DASHBOARD_UNSET_LABEL,
        floors: addDashboardGroupPercentages(
            [...floors.values()]
                .sort((a, b) => compareHierarchyOrder(a.floor, b.floor))
                .map(({ floor, count }) => ({ floorId: Number(floor.id), label: floor.name, count })),
            facility.count
        )
    }));
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

function aggregateDashboardQuality(devices, qualityResult) {
    const issues = getDashboardQualityIssues(qualityResult);
    const suppressedIssues = qualityResult.suppressed_issues ?? [];
    const counts = { error: 0, warning: 0, info: 0, total: issues.length };
    const categories = new Map();
    let legacyConflicts = 0;
    let legacyVlans = 0;
    for (const { severity, category, code } of issues) {
        if (severity === 'error' || severity === 'warning' || severity === 'info') {
            counts[severity]++;
            if (category) {
                if (!categories.has(category)) categories.set(category, { key: category, problems: 0, info: 0 });
                categories.get(category)[severity === 'info' ? 'info' : 'problems']++;
            }
        }
        if (code === DASHBOARD_QUALITY_CODES.legacyLinkConflict) legacyConflicts++;
        if (code === DASHBOARD_QUALITY_CODES.legacyLinkVlan) legacyVlans++;
    }
    return {
        ...counts,
        problems: counts.error + counts.warning,
        suppressed: qualityResult.suppressed_count ?? 0,
        categories: [...categories.values()],
        legacyConflicts,
        legacyVlans,
        registration: aggregateDashboardRegistration(devices, qualityResult.settings, issues, suppressedIssues)
    };
}

function aggregateDashboardRegistration(devices, settings, issues, suppressedIssues) {
    const fields = new Map();
    for (const field of settings?.recommended_device_fields ?? []) {
        fields.set(field, DASHBOARD_QUALITY_CODES.missingRecommendedFields);
    }
    fields.set('ip', DASHBOARD_QUALITY_CODES.managementIpMissing);
    fields.set('maintenance_expiry', DASHBOARD_QUALITY_CODES.maintenanceExpiryMissing);

    const devicesById = new Set(devices.map(device => Number(device.id)));
    const statuses = new Map([...fields].map(([key]) => [key, { missing: new Set(), suppressed: new Set() }]));
    function record(field, code, deviceId, status) {
        const id = Number(deviceId);
        if (fields.get(field) === code && devicesById.has(id)) {
            statuses.get(field)[status].add(id);
        }
    }
    for (const { code, entity_type, entity_ids, details } of issues) {
        if (entity_type !== 'device') continue;
        if (code === DASHBOARD_QUALITY_CODES.missingRecommendedFields) {
            for (const field of details?.fields ?? []) {
                for (const id of entity_ids) record(field, code, id, 'missing');
            }
        } else if (code === DASHBOARD_QUALITY_CODES.managementIpMissing && details?.reason === 'ip_not_set') {
            for (const id of entity_ids) record('ip', code, id, 'missing');
        } else if (code === DASHBOARD_QUALITY_CODES.maintenanceExpiryMissing) {
            for (const id of entity_ids) record('maintenance_expiry', code, id, 'missing');
        }
    }
    for (const { code, entity_type, not_applicable_items } of suppressedIssues) {
        if (entity_type !== 'device') continue;
        for (const { field, device_id } of not_applicable_items ?? []) {
            record(field, code, device_id, 'suppressed');
        }
    }
    return [...fields].map(([key, code]) => {
        const { missing, suppressed } = statuses.get(key);
        for (const id of suppressed) missing.delete(id);
        const applicable = devicesById.size - suppressed.size;
        const registered = applicable - missing.size;
        return {
            key,
            label: DATA_QUALITY_DEVICE_FIELD_LABELS[key] ?? key,
            code,
            registered,
            missing: missing.size,
            suppressed: suppressed.size,
            percentage: applicable === 0 ? null : Math.round(registered * 1000 / applicable) / 10
        };
    });
}

function aggregateDashboardNetwork(devices, devicePorts, links, locations, qualityResult) {
    const portIds = new Set();
    const devicesWithPorts = new Set();
    for (const port of devicePorts) {
        portIds.add(Number(port.id));
        devicesWithPorts.add(Number(port.device_id));
    }
    const devicesById = new Map(devices.map(device => [Number(device.id), device]));
    const connectedPorts = new Set();
    const linkIds = new Set();
    const topology = { sameFloor: 0, betweenFloors: 0, betweenBuildings: 0, unknown: 0 };
    const endpoints = qualityResult ? { specified: 0, missing: 0, suppressed: 0 } : null;
    const suppressedEndpoints = new Map();
    for (const issue of qualityResult?.suppressed_issues ?? []) {
        if (issue.code !== DASHBOARD_QUALITY_CODES.linkPortsMissing || issue.entity_type !== 'link') continue;
        suppressedEndpoints.set(Number(issue.entity_ids[0]), issue.details.missing_endpoints);
    }
    for (const link of links) {
        const id = Number(link.id);
        if (linkIds.has(id)) continue;
        linkIds.add(id);

        const fromFloorId = Number(devicesById.get(Number(link.from_id))?.floor_id);
        const toFloorId = Number(devicesById.get(Number(link.to_id))?.floor_id);
        const from = locations.get(fromFloorId);
        const to = locations.get(toFloorId);
        if (!from || !to) topology.unknown++;
        else if (fromFloorId === toFloorId) topology.sameFloor++;
        else if (from.buildingId === to.buildingId) topology.betweenFloors++;
        else topology.betweenBuildings++;

        for (const side of ['from', 'to']) {
            const portId = link[`${side}_port_id`];
            if (portId != null) {
                if (portIds.has(Number(portId))) connectedPorts.add(Number(portId));
                if (endpoints) endpoints.specified++;
            } else if (endpoints) {
                // 孤立した端点は診断に現れないことがあるため、未指定は端点ごとに判定する。
                if (suppressedEndpoints.get(id)?.[side]) endpoints.suppressed++;
                else endpoints.missing++;
            }
        }
    }
    return {
        portCount: portIds.size,
        linkCount: linkIds.size,
        devicesWithPorts: devicesWithPorts.size,
        connectedPorts: connectedPorts.size,
        unconnectedPorts: portIds.size - connectedPorts.size,
        endpoints,
        topology
    };
}

/**
 * ラックごと・全体の搭載機器をIDで一意に集計する。
 */
function aggregateDashboardRacks(views, rackMounts, rackSettings, rackShelves, rackShelfDevices, hierarchy) {
    const racks = (Array.isArray(views) ? views : []).filter(view => view.view_type === 'rack');
    const mountedByRack = new Map(racks.map(view => [Number(view.id), { deviceIds: new Set(), mounts: [] }]));
    const mountedDevices = new Set();
    for (const mount of Array.isArray(rackMounts) ? rackMounts : []) {
        const rack = mountedByRack.get(Number(mount.view_id));
        if (!rack) continue;
        const deviceId = Number(mount.device_id);
        rack.deviceIds.add(deviceId);
        rack.mounts.push(mount);
        mountedDevices.add(deviceId);
    }
    const shelves = new Map(rackShelves.map(row => [Number(row.id), row]));
    for (const member of rackShelfDevices) {
        const shelf = shelves.get(Number(member.shelf_id));
        const rack = shelf && mountedByRack.get(Number(shelf.view_id));
        if (!rack) continue;
        rack.deviceIds.add(Number(member.device_id));
        mountedDevices.add(Number(member.device_id));
    }
    const settingsByRack = new Map(
        (Array.isArray(rackSettings) ? rackSettings : []).map(row => [Number(row.view_id), row])
    );
    return {
        total: racks.length,
        mountedDevices: mountedDevices.size,
        items: racks.map(view => {
            const rack = mountedByRack.get(Number(view.id));
            const settings = settingsByRack.get(Number(view.id));
            const totalU = Number(settings?.total_u);
            const faces = totalU > 0 ? {} : null;
            if (faces) {
                for (const face of ['front', 'rear']) {
                    const usage = rackUsage(totalU, rack.mounts, face,
                        rackShelves.filter(row => Number(row.view_id) === Number(view.id)), rackShelfDevices);
                    faces[face] = {
                        empty: usage.empty,
                        occupiedPercentage: Math.max(0, Math.min(100, (usage.used * 2 + usage.half) / (totalU * 2) * 100))
                    };
                }
            }
            return {
                id: Number(view.id),
                name: String(view.name || '').trim() || `ビューID ${view.id}`,
                hierarchyPath: viewHierarchyPath(view, hierarchy),
                location: String(settings?.location || '').trim(),
                deviceCount: rack.deviceIds.size,
                faces
            };
        })
    };
}

/**
 * ダッシュボード表示用の純粋集計モデルを生成する。
 * 外部状態 (appState や DOM) を直接読まず、渡された引数のみから構築する。
 */
export function buildDashboardModel({
    devices = [],
    placements = [],
    rackMounts = [],
    views = [],
    rackSettings = [],
    rackShelves = [],
    rackShelfDevices = [],
    buildings = [],
    floors = [],
    devicePorts = [],
    links = [],
    qualityResult = null,
    qualityLoading = false,
    dataRevision = 0,
    dirty = false,
    fiscalYearStartMonth = 4,
    referenceDate = new Date()
} = {}) {
    const sourceDevices = Array.isArray(devices) ? devices : [];
    const sourcePlacements = Array.isArray(placements) ? placements : [];
    const locations = indexDashboardFloors({ buildings, floors });

    const qualityAvailable = qualityResult?.ok === true;
    const qualityRevision = Number(qualityResult?.revision || 0);
    const revision = Number(dataRevision);
    const qualityRevisionMatches = qualityRevision > 0 && revision > 0 ? qualityRevision === revision : null;
    const hasUnsavedChanges = Boolean(dirty);
    let qualitySync;
    if (qualityLoading) qualitySync = 'loading';
    else if (hasUnsavedChanges) qualitySync = 'unsaved';
    else if (!qualityAvailable) qualitySync = 'unavailable';
    else if (qualityRevisionMatches !== true) qualitySync = 'revision_mismatch';
    else qualitySync = 'synced';
    const syncedQuality = qualitySync === 'synced' ? qualityResult : null;

    const quality = syncedQuality ? aggregateDashboardQuality(sourceDevices, syncedQuality) : null;
    const maintenanceRegistration = quality?.registration.find(row => row.key === 'maintenance_expiry');

    const monitoring = aggregateDashboardMonitoring(sourceDevices);
    const maintenance = aggregateMaintenanceExpiry(sourceDevices, referenceDate, fiscalYearStartMonth);
    const stateUnplacedDeviceIds = getUnplacedDeviceIds(
        sourceDevices,
        sourcePlacements,
        [...rackMounts, ...rackShelfDevices]
    );
    const qualityUnplacedDeviceIds = getDashboardUnplacedDeviceIds(syncedQuality);
    const incompleteDeviceIds = getDashboardIncompleteDeviceIds(syncedQuality);
    const floorViewsWithoutPlanIds = getDashboardFloorViewsWithoutPlanIds(syncedQuality);

    return {
        qualityAvailable,
        qualityRevisionMatches,
        hasUnsavedChanges,
        qualitySync,
        quality,
        maintenance: {
            ...maintenance,
            unset: maintenanceRegistration?.missing ?? null,
            suppressed: maintenanceRegistration?.suppressed ?? null
        },
        network: aggregateDashboardNetwork(sourceDevices, devicePorts, links, locations, syncedQuality),
        racks: aggregateDashboardRacks(views, rackMounts, rackSettings, rackShelves, rackShelfDevices, { buildings, floors }),
        totals: {
            devices: sourceDevices.length,
            green: monitoring.green,
            red: monitoring.red,
            unknown: monitoring.unknown,
            /* 基本集計は画面メモリ基準 */
            unplacedDevices: stateUnplacedDeviceIds.length,
            /* 品質指標は保存済みDB基準 */
            incompleteDevices: syncedQuality ? incompleteDeviceIds.length : null,
            qualityErrors: quality?.error ?? null,
            qualityWarnings: quality?.warning ?? null,
            qualityInfo: quality?.info ?? null,
            qualityTotal: quality?.total ?? null,
            qualityProblems: quality?.problems ?? null,
            floorViewsWithoutPlan: syncedQuality ? floorViewsWithoutPlanIds.length : null
        },
        entityIds: {
            stateUnplacedDevices: stateUnplacedDeviceIds,
            qualityUnplacedDevices: qualityUnplacedDeviceIds,
            incompleteDevices: incompleteDeviceIds,
            floorViewsWithoutPlan: floorViewsWithoutPlanIds
        },
        groups: {
            facilities: aggregateFacilities(sourceDevices, locations),
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
    for (const facility of model.groups?.facilities ?? []) {
        if (facility.buildingId != null &&
            (facility.floors ?? []).reduce((sum, floor) => sum + floor.count, 0) !== facility.count) {
            errors.push('フロア別件数の合計が建物内の機器数と一致しません');
        }
    }

    const qualityTotal =
        Number(totals.qualityErrors || 0) +
        Number(totals.qualityWarnings || 0) +
        Number(totals.qualityInfo || 0);

    if (model.qualitySync === 'synced' && qualityTotal !== totals.qualityTotal) {
        errors.push('品質診断の重大度別件数と合計が一致しません');
    }

    return errors;
}
