/**
 * Netarium - 共有状態管理 (State)
 */

import {
    DEFAULT_VIEW_PAN_X,
    DEFAULT_VIEW_PAN_Y,
    DEFAULT_VIEW_SCALE,
    DEVICE_TYPES,
    MAX_VIEWS,
    VALID_STATUSES
} from './constants.js';
import { normalizeLinkRouteData } from './link-route-data.js';
import { validateCanvasNote } from './canvas-note-data.js';
export { normalizeCanvasNote, toSaveCanvasNote } from './canvas-note-data.js';
import { validateRackLayout } from './rack-layout.js';
import { validateFloorRackPlacements } from './floor-rack-data.js';

export const appState = {
    views: [],
    devices: [],
    placements: [],
    links: [],
    linkSystems: [],
    canvasNotes: [],
    rackSettings: [],
    rackMounts: [],
    rackShelves: [],
    rackShelfDevices: [],
    floorRackPlacements: [],
    floorPlans: [],
    deviceImages: [],
    currentViewId: null,
    selectedPlacementIds: new Set(),
    selectedCanvasNoteId: null,
    editingDeviceId: null,
    editingLinkId: null,
    nextViewId: 1,
    nextDeviceId: 1,
    nextPlacementId: 1,
    nextLinkId: 1,
    nextCanvasNoteId: 1,
    dataRevision: 0,
    monitorRevision: 0,
    linkMode: false,
    noteMode: false,
    linkSourceId: null,
    linkSourceFixed: false,
    linkSourceConnected: false,
    isSaving: false,
    isPinging: false,
    suppressNextClick: false,
    viewState: {
        scale: DEFAULT_VIEW_SCALE,
        panX: DEFAULT_VIEW_PAN_X,
        panY: DEFAULT_VIEW_PAN_Y,
        minScale: 0.05,
        maxScale: 3
    },
    viewStates: new Map(),
    floorPlanAutoFittedViews: new Set(),
    resourceConflicts: { devices: new Map(), views: new Map() },
    appStatus: {
        dirty: false,
        state: 'saved',
        lastSavedAt: null,
        lastMonitoredAt: null,
        lastError: null
    },
    canvas: null,
    world: null,
    deviceLayer: null,
    noteLayer: null,
    currentSvg: null,
    floorPlanLayer: null,

    selectionBox: null,
    isRangeSelecting: false,
    cancelActiveRangeSelection: null,
    ledgerSearchHighlightDeviceId: null,
    viewManagerFormDirty: false,
    isFloorPlanUpdating: false,
    floorPlanAdjustMode: false,
    isDevicesCsvImporting: false,
    isBackupExporting: false,
    dataQualityResult: null,
    dataQualitySeverityFilter: '',
    dataQualityCategoryFilter: '',
    dataQualityCodeFilter: [],
    dataQualityPreviousFocus: null,
    isDashboardNavigating: false
};

export const state = appState;

import {
    clampNumber,
    normalizeText,
    isValidIpv4
} from './utils.js';

export function toSaveView(view) {
    return {
        id: Number(view.id),
        name: normalizeText(view.name).trim(),
        facility:
            normalizeText(view.facility).trim(),
        floor:
            normalizeText(view.floor).trim(),
        view_type: ['topology', 'floor', 'rack'].includes(view.view_type) ? view.view_type : 'topology',
        sort_order:
            Number(view.sort_order) || 0,
        memo:
            normalizeText(view.memo).trim()
    };
}


export function toSavePlacement(placement) {
    return {
        id: Number(placement.id),
        device_id:
            Number(placement.device_id),
        view_id:
            Number(placement.view_id),
        x: Math.max(
            0,
            Number(placement.x) || 0
        ),
        y: Math.max(
            0,
            Number(placement.y) || 0
        )
    };
}



export function getCurrentView() {
    return appState.views.find(
        view =>
            Number(view.id) ===
            Number(appState.currentViewId)
    ) || null;
}


export function getCurrentPlacements() {
    if (appState.currentViewId === null) {
        return [];
    }

    return appState.placements.filter(
        placement =>
            Number(placement.view_id) ===
            Number(appState.currentViewId)
    );
}


export function getCurrentLinks() {
    if (appState.currentViewId === null) {
        return [];
    }

    return appState.links.filter(
        link =>
            Number(link.view_id) ===
            Number(appState.currentViewId)
    );
}

export function getCurrentCanvasNotes() {
    if (appState.currentViewId === null) return [];
    return appState.canvasNotes.filter(note => Number(note.view_id) === Number(appState.currentViewId));
}


export function getDeviceById(deviceId) {
    return appState.devices.find(
        device =>
            Number(device.id) ===
            Number(deviceId)
    ) || null;
}


export function getPlacementById(placementId) {
    return appState.placements.find(
        placement =>
            Number(placement.id) ===
            Number(placementId)
    ) || null;
}


export function getDeviceForPlacement(placement) {
    if (!placement) {
        return null;
    }

    return getDeviceById(placement.device_id);
}


export function getPlacementForDeviceInCurrentView(deviceId) {
    return appState.placements.find(
        placement =>
            Number(placement.view_id) ===
                Number(appState.currentViewId) &&
            Number(placement.device_id) ===
                Number(deviceId)
    ) || null;
}


/**
 * リンク作成モード切替
 */

/**
 * 安全な未使用ID計算
 */
export function calculateNextAvailableId(items) {
    const used = new Set();
    let max = 0;
    for (const item of (items || [])) {
        const id = Number(item?.id);
        if (Number.isSafeInteger(id) && id > 0) {
            used.add(id);
            if (id > max) {
                max = id;
            }
        }
    }
    const next = max + 1;
    if (next <= Number.MAX_SAFE_INTEGER && !used.has(next)) {
        return next;
    }
    for (let candidate = 1; candidate <= Number.MAX_SAFE_INTEGER; candidate++) {
        if (!used.has(candidate)) {
            return candidate;
        }
    }
    return 1;
}

const KIND_TO_PROP = {
    views: 'nextViewId',
    devices: 'nextDeviceId',
    placements: 'nextPlacementId',
    links: 'nextLinkId',
    canvasNotes: 'nextCanvasNoteId'
};

/**
 * 安全な仮ID払い出し
 */
export function allocateLocalId(kind) {
    if (kind === 'rackShelves') {
        return Math.min(0, ...appState.rackShelves.map(row => Number(row.id))) - 1;
    }
    const prop = KIND_TO_PROP[kind];
    const items = appState[kind] || [];
    let current = Number(appState[prop]);
    const used = new Set(items.map(item => Number(item?.id)));
    if (!Number.isSafeInteger(current) || current <= 0 || used.has(current)) {
        current = calculateNextAvailableId(items);
    }
    appState[prop] = calculateNextAvailableId([...items, { id: current }]);
    return current;
}

/**
 * 次ID再計算
 */
export function recalculateNextIds() {
    appState.nextViewId = calculateNextAvailableId(appState.views);
    appState.nextDeviceId = calculateNextAvailableId(appState.devices);
    appState.nextPlacementId = calculateNextAvailableId(appState.placements);
    appState.nextLinkId = calculateNextAvailableId(appState.links);
    appState.nextCanvasNoteId = calculateNextAvailableId(appState.canvasNotes);
}


function normalizeLinkSystemId(value) {
    if (value == null) return null;
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id <= 0 ||
        (typeof value !== 'number' && (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)))) {
        throw new Error('接続系統は未設定または正の整数で指定してください');
    }
    return id;
}

/**
 * DB/APIから取得したリンクデータの正規化
 */

/**
 * DB/APIから取得したリンクデータの正規化
 */
export function normalizeLink(link) {
    return {
        ...normalizeLinkRouteData(link),
        system_id: normalizeLinkSystemId(link.system_id),
        id: Number(link.id),
        view_id: Number(link.view_id),
        from_id: Number(
            link.from_id ?? link.fromId
        ),
        to_id: Number(
            link.to_id ?? link.toId
        ),
        label: normalizeText(link.label),
        from_port: normalizeText(link.from_port),
        to_port: normalizeText(link.to_port),
        vlan: normalizeText(link.vlan),
        memo: normalizeText(link.memo)
    };
}


/**
 * 保存用機器データ
 */

/**
 * 保存用機器データ
 */
export function toSaveDevice(device) {
    return {
        id: Number(device.id),
        name: String(device.name || ''),
        type: DEVICE_TYPES[device.type]
        ? device.type
        : 'other',

        ip: String(device.ip || ''),
        x: Number(device.x) || 0,
        y: Number(device.y) || 0,

        facility: normalizeText(device.facility),
        floor: normalizeText(device.floor),
        location: normalizeText(device.location),
        manufacturer: normalizeText(device.manufacturer),
        model: normalizeText(device.model),
        asset_number: normalizeText(device.asset_number),
        serial_number: normalizeText(device.serial_number),
        mac_address: normalizeText(device.mac_address),
        memo: normalizeText(device.memo),
        management_scheme: normalizeText(device.management_scheme),
        management_port: (device.management_port !== null && device.management_port !== undefined && String(device.management_port).trim() !== '')
            ? Number(device.management_port)
            : null,
        department: normalizeText(device.department),
        maintenance_vendor: normalizeText(device.maintenance_vendor),
        install_date: normalizeText(device.install_date),
        maintenance_expiry: normalizeText(device.maintenance_expiry)
    };
}


/**
 * 保存用リンクデータ
 */

/**
 * 保存用リンクデータ
 */
export function toSaveLink(link) {
    return {
        ...normalizeLinkRouteData(link),
        system_id: normalizeLinkSystemId(link.system_id),
        id: Number(link.id),
        view_id: Number(link.view_id),
        from_id: Number(link.from_id),
        to_id: Number(link.to_id),
        label: normalizeText(link.label),
        from_port:
            normalizeText(link.from_port),
        to_port:
            normalizeText(link.to_port),
        vlan: normalizeText(link.vlan),
        memo: normalizeText(link.memo)
    };
}



/**
 * リンク妥当性チェック
 */

/**
 * リンク妥当性チェック
 */
export function isValidLinkObject(link) {
    if (!link) {
        return false;
    }

    if (!Number.isFinite(link.id) || link.id <= 0) {
        return false;
    }

    if (!Number.isFinite(link.from_id) || link.from_id <= 0) {
        return false;
    }

    if (!Number.isFinite(link.to_id) || link.to_id <= 0) {
        return false;
    }

    if (link.from_id === link.to_id) {
        return false;
    }

    if (
        !Number.isFinite(link.view_id) ||
        link.view_id <= 0
    ) {
        return false;
    }

    return true;
}

/**
 * ステータス正規化
 */

/**
 * ステータス正規化
 */
export function normalizeStatus(status) {
    const s = String(status || 'unknown');

    if (VALID_STATUSES.includes(s)) {
        return s;
    }

    return 'unknown';
}

/**
 * nullable number変換
 */

/**
 * nullable number変換
 */
export function toNullableNumber(value) {
    if (value === null || value === undefined || value === '') {
        return null;
    }

    const n = Number(value);

    if (!Number.isFinite(n)) {
        return null;
    }

    return n;
}

/**
 * ボタン等のbusy制御
 */

export function validateDevicesForSave(devices = appState.devices) {
    const usedIds = new Set();
    const usedIps = new Map();

    for (const device of devices) {
        const id = Number(device.id);

        device.name =
            normalizeText(device.name).trim();

        device.ip =
            normalizeText(device.ip).trim();

        if (
            !Number.isInteger(id) ||
            id <= 0
        ) {
            throw new Error(
                '機器IDが不正です'
            );
        }

        if (usedIds.has(id)) {
            throw new Error(
                `機器ID ${id} が重複しています`
            );
        }

        if (!device.name) {
            throw new Error(
                `機器ID ${id}: 名称を入力してください`
            );
        }

        if (
            device.ip &&
            !isValidIpv4(device.ip)
        ) {
            throw new Error(
                `機器ID ${id}: IPアドレスの形式が不正です`
            );
        }

        /*
         * APIは現在IP重複を禁止していません。
         * 運用上禁止する場合だけ残す。
         */
        if (device.ip) {
            if (usedIps.has(device.ip)) {
                throw new Error(
                    `IPアドレス ${device.ip} が重複しています`
                );
            }

            usedIps.set(device.ip, id);
        }

        usedIds.add(id);
    }
}



export function validateAllDataBeforeSave(data = appState) {
    validateViewsForSave(data);
    validateDevicesForSave(data.devices);
    validatePlacementsForSave(data);
    validateLinksForSave(data);
    validateCanvasNotesForSave(data);
    validateRackLayout(data);
    validateFloorRackPlacements(data);
}



export function validateViewsForSave(data = appState) {
    if (data.views.length < 1) {
        throw new Error(
            'ビューを最低1件登録してください'
        );
    }

    if (data.views.length > MAX_VIEWS) {
        throw new Error(
            `ビューは最大${MAX_VIEWS}件です`
        );
    }

    const usedIds = new Set();
    const usedNames = new Set();

    for (const view of data.views) {
        const id = Number(view.id);
        const name =
            normalizeText(view.name).trim();

        if (
            !Number.isInteger(id) ||
            id <= 0
        ) {
            throw new Error(
                'ビューIDが不正です'
            );
        }

        if (usedIds.has(id)) {
            throw new Error(
                `ビューID ${id} が重複しています`
            );
        }

        if (!name) {
            throw new Error(
                `ビューID ${id}: 名称を入力してください`
            );
        }

        const nameKey =
            name.toLocaleLowerCase('ja');

        if (usedNames.has(nameKey)) {
            throw new Error(
                `ビュー名「${name}」が重複しています`
            );
        }

        usedIds.add(id);
        usedNames.add(nameKey);
    }
}

export function validateCanvasNotesForSave(data = appState) {
    const viewIds = new Set(data.views.map(view => Number(view.id)));
    const usedIds = new Set();
    for (const note of data.canvasNotes || data.canvas_notes || []) {
        validateCanvasNote(note);
        const id = Number(note.id);
        if (usedIds.has(id)) throw new Error(`メモID ${id} が重複しています`);
        if (!viewIds.has(Number(note.view_id))) throw new Error(`メモID ${id}: ビューが見つかりません`);
        usedIds.add(id);
    }
}


export function validatePlacementsForSave(data = appState) {
    const viewIds = new Set(
        data.views.map(view => Number(view.id))
    );

    const deviceIds = new Set(
        data.devices.map(device => Number(device.id))
    );

    const usedIds = new Set();
    const usedPairs = new Set();

    for (const placement of data.placements) {
        const id =
            Number(placement.id);

        const deviceId =
            Number(placement.device_id);

        const viewId =
            Number(placement.view_id);

        if (
            !Number.isInteger(id) ||
            id <= 0
        ) {
            throw new Error(
                '配置IDが不正です'
            );
        }

        if (usedIds.has(id)) {
            throw new Error(
                `配置ID ${id} が重複しています`
            );
        }

        if (!deviceIds.has(deviceId)) {
            throw new Error(
                `配置ID ${id}: 機器が存在しません`
            );
        }

        if (!viewIds.has(viewId)) {
            throw new Error(
                `配置ID ${id}: ビューが存在しません`
            );
        }

        const pairKey =
            `${deviceId}:${viewId}`;

        if (usedPairs.has(pairKey)) {
            throw new Error(
                `機器ID ${deviceId} はビューID ${viewId}へ重複配置されています`
            );
        }

        if (
            !Number.isFinite(
                Number(placement.x)
            ) ||
            !Number.isFinite(
                Number(placement.y)
            ) ||
            Number(placement.x) < 0 ||
            Number(placement.y) < 0
        ) {
            throw new Error(
                `配置ID ${id}: 座標が不正です`
            );
        }

        usedIds.add(id);
        usedPairs.add(pairKey);
    }
}


export function validateLinksForSave(data = appState) {
    const deviceIds = new Set(
        data.devices.map(device => Number(device.id))
    );

    const placementPairs = new Set(
        data.placements.map(placement =>
            `${Number(
                placement.device_id
            )}:${Number(
                placement.view_id
            )}`
        )
    );

    const viewIds = new Set(
        data.views.map(view => Number(view.id))
    );

    const usedIds = new Set();
    const usedPairs = new Set();

    for (const link of data.links) {
        normalizeLinkRouteData(link);
        normalizeLinkSystemId(link.system_id);
        const id = Number(link.id);
        const viewId =
            Number(link.view_id);
        const fromId =
            Number(link.from_id);
        const toId =
            Number(link.to_id);

        if (
            !Number.isInteger(id) ||
            id <= 0
        ) {
            throw new Error(
                '接続IDが不正です'
            );
        }

        if (usedIds.has(id)) {
            throw new Error(
                `接続ID ${id} が重複しています`
            );
        }

        if (!viewIds.has(viewId)) {
            throw new Error(
                `接続ID ${id}: ビューが存在しません`
            );
        }

        if (
            !deviceIds.has(fromId) ||
            !deviceIds.has(toId)
        ) {
            throw new Error(
                `接続ID ${id}: 接続機器が存在しません`
            );
        }

        if (fromId === toId) {
            throw new Error(
                `接続ID ${id}: 同一機器同士は接続できません`
            );
        }

        if (
            !placementPairs.has(
                `${fromId}:${viewId}`
            ) ||
            !placementPairs.has(
                `${toId}:${viewId}`
            )
        ) {
            throw new Error(
                `接続ID ${id}: 両端の機器を同じビューへ配置してください`
            );
        }

        const pairIds =
            [fromId, toId]
                .sort((a, b) => a - b);

        const pairKey =
            `${viewId}:${pairIds[0]}:${pairIds[1]}`;

        if (usedPairs.has(pairKey)) {
            throw new Error(
                `接続ID ${id}: 同一ビュー内で接続が重複しています`
            );
        }

        usedIds.add(id);
        usedPairs.add(pairKey);
    }
}





export function findDeviceWithDuplicateIp(
    ip,
    excludedDeviceId = null
) {
    const normalizedIp =
        normalizeText(ip).trim();

    if (!normalizedIp) {
        return null;
    }

    return appState.devices.find(device => {
        return (
            Number(device.id) !==
                Number(excludedDeviceId) &&
            normalizeText(device.ip).trim() ===
                normalizedIp
        );
    }) || null;
}



export function hasObjectChanged(
    before,
    after
) {
    return (
        JSON.stringify(before) !==
        JSON.stringify(after)
    );
}


/**
 * DB/APIから取得した機器データの正規化
 */

/**
 * DB/APIから取得した機器データの正規化
 */
export function normalizeDevice(device) {
    const type = DEVICE_TYPES[device.type]
        ? device.type
        : 'other';

    return {
        id: Number(device.id),
        resource_revision: Number(device.resource_revision) || 0,
        name: normalizeText(device.name),
        type,
        ip: normalizeText(device.ip),
        x: Number(device.x) || 0,
        y: Number(device.y) || 0,
        status: normalizeStatus(device.status),

        last_checked_at:
            device.last_checked_at == null
                ? null
                : String(device.last_checked_at),

        last_response_ms:
            toNullableNumber(device.last_response_ms),

        last_error:
            device.last_error == null
                ? null
                : String(device.last_error),

        facility: normalizeText(device.facility),
        floor: normalizeText(device.floor),
        location: normalizeText(device.location),
        manufacturer: normalizeText(device.manufacturer),
        model: normalizeText(device.model),
        asset_number: normalizeText(device.asset_number),
        serial_number: normalizeText(device.serial_number),
        mac_address: normalizeText(device.mac_address),
        memo: normalizeText(device.memo),
        management_scheme: normalizeText(device.management_scheme),
        management_port: toNullableNumber(device.management_port),
        department: normalizeText(device.department),
        maintenance_vendor: normalizeText(device.maintenance_vendor),
        install_date: normalizeText(device.install_date),
        maintenance_expiry: normalizeText(device.maintenance_expiry)
    };
}


export function normalizeView(view) {
    return {
        id: Number(view.id),
        resource_revision: Number(view.resource_revision) || 0,
        name: normalizeText(view.name),
        facility: normalizeText(view.facility),
        floor: normalizeText(view.floor),
        view_type: ['topology', 'floor', 'rack'].includes(view.view_type) ? view.view_type : 'topology',
        sort_order:
            Number(view.sort_order) || 0,
        memo: normalizeText(view.memo)
    };
}


export function normalizePlacement(placement) {
    return {
        id: Number(placement.id),
        device_id: Number(placement.device_id),
        view_id: Number(placement.view_id),
        x: Math.max(
            0,
            Number(placement.x) || 0
        ),
        y: Math.max(
            0,
            Number(placement.y) || 0
        )
    };
}


export function normalizeFloorPlan(
    floorPlan
) {
    return {
        view_id:
            Number(floorPlan.view_id),

        original_name:
            normalizeText(
                floorPlan.original_name
            ),

        mime_type:
            normalizeText(
                floorPlan.mime_type
            ),

        file_size:
            Math.max(
                0,
                Number(
                    floorPlan.file_size
                ) || 0
            ),

        image_width:
            Math.max(
                0,
                Number(
                    floorPlan.image_width
                ) || 0
            ),

        image_height:
            Math.max(
                0,
                Number(
                    floorPlan.image_height
                ) || 0
            ),

        x:
            Number(floorPlan.x) || 0,

        y:
            Number(floorPlan.y) || 0,

        scale:
            clampNumber(
                Number(floorPlan.scale) || 1,
                0.05,
                2
            ),

        opacity:
            clampNumber(
                floorPlan.opacity == null
                    ? 1
                    : Number(
                        floorPlan.opacity
                    ),
                0,
                1
            ),

        is_visible:
            Number(
                floorPlan.is_visible
            ) === 1,

        revision:
            Math.max(
                1,
                Number(
                    floorPlan.revision
                ) || 1
            ),

        created_at:
            floorPlan.created_at || null,

        updated_at:
            floorPlan.updated_at || null,

        image_url:
            normalizeText(
                floorPlan.image_url
            )
    };
}


export function getFloorPlanForView(
    viewId
) {
    return appState.floorPlans.find(
        floorPlan =>
            Number(
                floorPlan.view_id
            ) === Number(viewId)
    ) || null;
}


export function getCurrentFloorPlan() {
    if (appState.currentViewId === null) {
        return null;
    }

    return getFloorPlanForView(
        appState.currentViewId
    );
}


export function getPlacementsForDevice(deviceId) {
    return appState.placements.filter(
        placement =>
            Number(placement.device_id) ===
            Number(deviceId)
    );
}


export function getPlacedViewsForDevice(deviceId) {
    const placedViewIds = new Set(
        getPlacementsForDevice(deviceId)
            .map(placement =>
                Number(placement.view_id)
            )
    );
    for (const mount of appState.rackMounts) {
        if (Number(mount.device_id) === Number(deviceId)) placedViewIds.add(Number(mount.view_id));
    }
    const shelfIds = new Set(appState.rackShelfDevices.filter(row => Number(row.device_id) === Number(deviceId))
        .map(row => Number(row.shelf_id)));
    for (const shelf of appState.rackShelves) {
        if (shelfIds.has(Number(shelf.id))) placedViewIds.add(Number(shelf.view_id));
    }

    return appState.views
        .filter(view =>
            placedViewIds.has(
                Number(view.id)
            )
        )
        .sort(compareViews);
}


export function compareViews(a, b) {
    const orderDifference =
        Number(a.sort_order) -
        Number(b.sort_order);

    return orderDifference !== 0
        ? orderDifference
        : Number(a.id) - Number(b.id);
}


export function removeDevicesFromState(deviceIds) {
    const targetIds =
        new Set(
            (deviceIds || [])
                .map(Number)
                .filter(id =>
                    Number.isInteger(id) &&
                    id > 0
                )
        );

    if (targetIds.size === 0) {
        return 0;
    }

    appState.devices = appState.devices.filter(d => !targetIds.has(Number(d.id)));
    appState.placements = appState.placements.filter(p => !targetIds.has(Number(p.device_id)));
    appState.rackMounts = appState.rackMounts.filter(row => !targetIds.has(Number(row.device_id)));
    appState.rackShelfDevices = appState.rackShelfDevices.filter(row => !targetIds.has(Number(row.device_id)));
    appState.links = appState.links.filter(link => {
        return (
            !targetIds.has(Number(link.from_id)) &&
            !targetIds.has(Number(link.to_id))
        );
    });

    return targetIds.size;
}


/**
 * 台帳の全選択チェックボックス切り替え
 */

