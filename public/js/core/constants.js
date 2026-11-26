/**
 * Netarium - コア定数定義
 */

export const API_URL = 'api.php';

export const DEVICE_TYPES = Object.freeze({
    switch: {
        label: 'L2スイッチ',
        shortLabel: 'L2SW',
        color: '#359cf0',
        icon: 'assets/icons/devices/l2-switch.svg'
    },
    l3_switch: {
        label: 'L3スイッチ',
        shortLabel: 'L3SW',
        color: '#29b6c5',
        icon: 'assets/icons/devices/l3-switch.svg'
    },
    router: {
        label: 'ルータ',
        shortLabel: 'Router',
        color: '#39ad60',
        icon: 'assets/icons/devices/router.svg'
    },
    firewall: {
        label: 'ファイアウォール',
        shortLabel: 'FW',
        color: '#f3686d',
        icon: 'assets/icons/devices/firewall.svg'
    },
    ap: {
        label: 'アクセスポイント',
        shortLabel: 'AP',
        color: '#ffb875',
        icon: 'assets/icons/devices/access-point.svg'
    },
    server: {
        label: 'サーバ',
        shortLabel: 'Server',
        color: '#ad89e5',
        icon: 'assets/icons/devices/server.svg'
    },
    printer: {
        label: 'プリンタ・複合機',
        shortLabel: 'Printer',
        color: '#ffcc43',
        icon: 'assets/icons/devices/printer.svg'
    },
    pc: {
        label: 'PC',
        shortLabel: 'PC',
        color: '#7075df',
        icon: 'assets/icons/devices/pc.svg'
    },
    other: {
        label: 'その他',
        shortLabel: 'etc',
        color: '#9da9b7',
        icon: 'assets/icons/devices/other.svg'
    }
});

export const VALID_STATUSES = Object.freeze(['unknown', 'checking', 'green', 'red']);

export const DEFAULT_VIEW_SCALE = 0.5;
export const DEFAULT_VIEW_PAN_X = 0;
export const DEFAULT_VIEW_PAN_Y = 0;

export const DEFAULT_DEVICE_WIDTH = 108;
export const DEFAULT_DEVICE_HEIGHT = 86;
// canvas.cssのカード全体: icon 42 + margin 3 + gap 9 + name 19.5
// + IP 15.2 + 状態ラベル 22.2 + padding 13 + border 4 = 127.9px。
// 障害物専用に切り上げ、既存の中心端点の高さ86pxは維持する。
export const DEFAULT_DEVICE_OBSTACLE_HEIGHT = 128;
export const MAX_VIEWS = 100;

export const RANGE_SELECTION_DRAG_THRESHOLD = 4;
export const DEVICE_SEARCH_RESULT_LIMIT = 20;

export const BACKUP_RESTORE_CONFIRMATION = 'バックアップから復元';

export const DATA_QUALITY_SEVERITY_LABELS = Object.freeze({
    error: 'エラー',
    warning: '警告',
    info: '情報'
});

export const DATA_QUALITY_CATEGORY_LABELS = Object.freeze({
    integrity: '参照整合性',
    duplicate: '重複',
    completeness: '入力不足',
    format: '書式',
    placement: '配置',
    monitoring: '監視',
    maintenance: '保守',
    floor_plan: 'フロア図面',
    naming: '名称'
});

// QualityDiagnosticService::getDataQualityDeviceFieldLabels() と同じ項目名。
export const DATA_QUALITY_DEVICE_FIELD_LABELS = Object.freeze({
    name: '名称',
    type: '種別',
    ip: 'IPアドレス',
    floor_id: '設置フロア',
    location: '設置場所',
    manufacturer: 'メーカー',
    model: '型番',
    asset_number: '管理番号',
    serial_number: 'シリアル番号',
    mac_address: 'MACアドレス',
    memo: '備考',
    management_scheme: '管理接続方式',
    management_port: '管理接続ポート',
    department: '担当部署',
    maintenance_vendor: '保守ベンダー',
    install_date: '導入年月',
    maintenance_expiry: '保守期限'
});

/*
 * ダッシュボード集計で使用する表示値。
 */
export const DASHBOARD_UNSET_LABEL = '未設定';

/*
 * データ品質診断からダッシュボードへ
 * 集計する問題コード。
 */
export const DASHBOARD_QUALITY_CODES = Object.freeze({
    unplacedDevice: 'unplaced_device',
    missingRequiredFields: 'missing_required_fields',
    missingRecommendedFields: 'missing_recommended_fields',
    floorViewWithoutPlan: 'floor_view_without_plan',
    managementIpMissing: 'monitoring_not_applicable',
    maintenanceExpiryMissing: 'maintenance_expiry_missing',
    linkPortsMissing: 'link_ports_missing',
    legacyLinkConflict: 'legacy_link_conflict',
    legacyLinkVlan: 'legacy_link_vlan'
});

export const MANAGEMENT_DEFAULT_PORTS = Object.freeze({
    http: 80,
    https: 443,
    ssh: 22
});

export const LINK_ROUTE_MODES = Object.freeze({
    AUTO: 'auto',
    STRAIGHT: 'straight',
    HORIZONTAL: 'horizontal',
    VERTICAL: 'vertical'
});

// PHP側のLinkRoute::MAX_POINTSをアプリ設定から受け取る。
export const LINK_MANUAL_ROUTE_MAX_POINTS = globalThis.window?.APP_CONFIG?.linkRoute?.maxPoints ?? 8;

/*
 * X差またはY差がこの値以下なら、
 * 不要なカギ線を作らず直線にする。
 */
export const LINK_ROUTE_STRAIGHT_THRESHOLD = 4;

export const LINK_LABEL_HORIZONTAL_OFFSET = 8;
export const LINK_LABEL_VERTICAL_OFFSET = 8;
export const LINK_LABEL_DIAGONAL_OFFSET = 6;
