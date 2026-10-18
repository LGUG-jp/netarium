/**
 * Netarium - コア定数定義
 */

export const API_URL = 'api.php';

export const DEVICE_TYPES = Object.freeze({
    switch: {
        label: 'L2スイッチ',
        shortLabel: 'L2SW',
        icon: 'assets/icons/devices/l2-switch.svg'
    },
    l3_switch: {
        label: 'L3スイッチ',
        shortLabel: 'L3SW',
        icon: 'assets/icons/devices/l3-switch.svg'
    },
    router: {
        label: 'ルータ',
        shortLabel: 'Router',
        icon: 'assets/icons/devices/router.svg'
    },
    firewall: {
        label: 'ファイアウォール',
        shortLabel: 'FW',
        icon: 'assets/icons/devices/firewall.svg'
    },
    ap: {
        label: 'アクセスポイント',
        shortLabel: 'AP',
        icon: 'assets/icons/devices/access-point.svg'
    },
    server: {
        label: 'サーバ',
        shortLabel: 'Server',
        icon: 'assets/icons/devices/server.svg'
    },
    printer: {
        label: 'プリンタ・複合機',
        shortLabel: 'Printer',
        icon: 'assets/icons/devices/printer.svg'
    },
    other: {
        label: 'その他',
        shortLabel: 'etc',
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
    floor_plan: 'フロア図面',
    naming: '名称'
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
    floorViewWithoutPlan: 'floor_view_without_plan'
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
