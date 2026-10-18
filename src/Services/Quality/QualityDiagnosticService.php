<?php
declare(strict_types=1);

namespace Netarium\Services\Quality;

use DateTimeImmutable;
use DateTimeZone;
use LogicException;
use Normalizer;
use PDO;
use Throwable;
use Netarium\Repositories\AppMetaRepository;
use Netarium\Services\Topology\DeviceFields;

class QualityDiagnosticService
{
    private PDO $db;
    private AppMetaRepository $appMetaRepo;

    public function __construct(PDO $db)
    {
        $this->db = $db;
        $this->appMetaRepo = new AppMetaRepository($db);
    }

    public function createDataQualityIssue(
        string $code,
        string $severity,
        string $category,
        string $entityType,
        array $entityIds,
        string $message,
        array $details = []
    ): array {
        if (!in_array($severity, ['error', 'warning', 'info'], true)) {
            throw new LogicException('データ品質診断のseverityが不正です');
        }

        $normalizedIds = [];

        foreach ($entityIds as $entityId) {
            if (is_int($entityId) || ctype_digit((string)$entityId)) {
                $normalizedIds[] = (int)$entityId;
            }
        }

        $normalizedIds = array_values(array_unique($normalizedIds));
        sort($normalizedIds, SORT_NUMERIC);

        return [
            'code' => $code,
            'severity' => $severity,
            'category' => $category,
            'entity_type' => $entityType,
            'entity_ids' => $normalizedIds,
            'message' => $message,
            'details' => $details,
        ];
    }

    /**
     * 重複比較用の一般文字列を正規化する。
     */
    public function normalizeDataQualityText(string $value, bool $caseInsensitive = true): string
    {
        $value = trim($value);

        if ($value === '') {
            return '';
        }

        if (!$caseInsensitive) {
            return $value;
        }

        if (function_exists('mb_strtoupper')) {
            return mb_strtoupper($value, 'UTF-8');
        }

        return strtoupper($value);
    }

    /**
     * MACアドレスを重複比較用に正規化する。
     *
     * 区切り文字と空白を除去し、
     * 12桁16進数の場合だけ正規値を返す。
     */
    public function normalizeDataQualityMac(string $value): ?string
    {
        $value = trim($value);

        if ($value === '') {
            return null;
        }

        $normalized = preg_replace('/[:.\-\s]/u', '', $value);

        if (!is_string($normalized) || preg_match('/\A[0-9A-Fa-f]{12}\z/', $normalized) !== 1) {
            return null;
        }

        return strtoupper($normalized);
    }

    /**
     * MACアドレスを標準表示形式へ変換する。
     */
    public function formatDataQualityMac(string $normalized): string
    {
        return implode(':', str_split(strtoupper($normalized), 2));
    }

    /**
     * 施設・フロア比較用に文字列を正規化する。
     */
    public function normalizeDataQualityLocation(string $value): string
    {
        $value = trim($value);

        if ($value === '') {
            return '';
        }

        if (class_exists('Normalizer')) {
            $normalized = Normalizer::normalize($value, Normalizer::FORM_KC);

            if (is_string($normalized)) {
                $value = $normalized;
            }
        }

        $value = preg_replace('/\s+/u', '', $value) ?? $value;

        if (function_exists('mb_strtoupper')) {
            return mb_strtoupper($value, 'UTF-8');
        }

        return strtoupper($value);
    }

    /**
     * 診断結果に表示する機器項目名を返す。
     */
    public function getDataQualityDeviceFieldLabels(): array
    {
        return [
            'name' => '名称',
            'type' => '種別',
            'ip' => 'IPアドレス',
            'facility' => '施設',
            'floor' => 'フロア',
            'location' => '設置場所',
            'manufacturer' => 'メーカー',
            'model' => '型番',
            'asset_number' => '管理番号',
            'serial_number' => 'シリアル番号',
            'mac_address' => 'MACアドレス',
            'memo' => '備考',
            'management_scheme' => '管理接続方式',
            'management_port' => '管理接続ポート',
            'department' => '担当部署',
            'maintenance_vendor' => '保守ベンダー',
            'install_date' => '導入年月',
            'maintenance_expiry' => '保守期限',
        ];
    }

    /**
     * 設定された推奨項目を安全に取得する。
     */
    public function getDataQualityRecommendedDeviceFields(array $config): array
    {
        $allowedFields = [
            'facility',
            'floor',
            'location',
            'manufacturer',
            'model',
            'asset_number',
            'serial_number',
            'mac_address',
            'memo',
        ];

        $configuredFields = $config['quality_recommended_device_fields'] ?? [];

        if (!is_array($configuredFields)) {
            return [];
        }

        $fields = [];

        foreach ($configuredFields as $field) {
            $field = (string)$field;

            if (in_array($field, $allowedFields, true)) {
                $fields[] = $field;
            }
        }

        return array_values(array_unique($fields));
    }

    /**
     * 名称類似診断用に機器名称を正規化する。
     *
     * 初版では文字列距離を使用せず、
     * 表記差を吸収した後の完全一致だけを扱う。
     */
    public function normalizeDataQualityDeviceName(string $value): string
    {
        $value = trim($value);

        if ($value === '') {
            return '';
        }

        if (class_exists('Normalizer')) {
            $normalized = Normalizer::normalize($value, Normalizer::FORM_KC);

            if (is_string($normalized)) {
                $value = $normalized;
            }
        }

        if (function_exists('mb_strtoupper')) {
            $value = mb_strtoupper($value, 'UTF-8');
        } else {
            $value = strtoupper($value);
        }

        /*
         * 空白と記号の違いを吸収する。
         * 文字・数字は残す。
         */
        $value = preg_replace('/[\s\p{P}\p{S}]+/u', '', $value) ?? $value;

        return $value;
    }

    /**
     * 正規化後に同一となる機器名称を診断する。
     */
    public function appendDataQualitySimilarNameIssues(array &$issues, array $devices): void
    {
        $groups = [];

        foreach ($devices as $device) {
            $name = trim((string)($device['name'] ?? ''));
            $normalized = $this->normalizeDataQualityDeviceName($name);

            if ($normalized === '') {
                continue;
            }

            $groups[$normalized][] = [
                'id' => (int)$device['id'],
                'name' => $name,
            ];
        }

        foreach ($groups as $members) {
            if (count($members) < 2) {
                continue;
            }

            /*
             * 完全に同じ元名称だけのグループも対象とする。
             * 大文字小文字・空白・記号だけが異なる場合も、
             * 同じ問題へまとめる。
             */
            $entityIds = array_map(
                static fn(array $member): int => (int)$member['id'],
                $members
            );

            $issues[] = $this->createDataQualityIssue(
                'similar_device_name',
                'info',
                'naming',
                'device',
                $entityIds,
                '表記が同一または類似する機器名称があります',
                [
                    'normalized_name' => $this->normalizeDataQualityDeviceName((string)$members[0]['name']),
                    'devices' => $members,
                ]
            );
        }
    }

    /**
     * 機器の必須・推奨項目不足を診断する。
     */
    public function appendDataQualityMissingFieldIssues(array &$issues, array $devices, array $config): void
    {
        $labels = $this->getDataQualityDeviceFieldLabels();
        $recommendedFields = $this->getDataQualityRecommendedDeviceFields($config);
        $allowedTypes = [
            'switch',
            'l3_switch',
            'router',
            'firewall',
            'ap',
            'server',
            'printer',
            'other',
        ];

        foreach ($devices as $device) {
            $deviceId = (int)$device['id'];
            $missingRequiredFields = [];

            if (trim((string)($device['name'] ?? '')) === '') {
                $missingRequiredFields[] = 'name';
            }

            $type = trim((string)($device['type'] ?? ''));

            if ($type === '' || !in_array($type, $allowedTypes, true)) {
                $missingRequiredFields[] = 'type';
            }

            if ($missingRequiredFields !== []) {
                $missingRequiredLabels = array_map(
                    static fn(string $field): string => $labels[$field] ?? $field,
                    $missingRequiredFields
                );

                $issues[] = $this->createDataQualityIssue(
                    'missing_required_fields',
                    'warning',
                    'completeness',
                    'device',
                    [$deviceId],
                    '機器の必須項目が不足しています',
                    [
                        'fields' => $missingRequiredFields,
                        'field_labels' => $missingRequiredLabels,
                    ]
                );
            }

            $missingRecommendedFields = [];

            foreach ($recommendedFields as $field) {
                if (trim((string)($device[$field] ?? '')) === '') {
                    $missingRecommendedFields[] = $field;
                }
            }

            if ($missingRecommendedFields === []) {
                continue;
            }

            $missingRecommendedLabels = array_map(
                static fn(string $field): string => $labels[$field] ?? $field,
                $missingRecommendedFields
            );

            $issues[] = $this->createDataQualityIssue(
                'missing_recommended_fields',
                'warning',
                'completeness',
                'device',
                [$deviceId],
                '機器の推奨項目が不足しています',
                [
                    'fields' => $missingRecommendedFields,
                    'field_labels' => $missingRecommendedLabels,
                ]
            );
        }
    }

    /**
     * データ品質診断に必要なDBデータを取得する。
     */
    public function fetchDataQualitySource(): array
    {
        $views = $this->db->query("
            SELECT
                id,
                name,
                facility,
                floor,
                view_type
            FROM views
            ORDER BY id
        ")->fetchAll(PDO::FETCH_ASSOC);

        $devices = $this->db->query("
            SELECT
                id,
                name,
                type,
                ip,
                facility,
                floor,
                location,
                manufacturer,
                model,
                asset_number,
                serial_number,
                mac_address,
                memo,
                management_scheme,
                management_port,
                department,
                maintenance_vendor,
                install_date,
                maintenance_expiry
            FROM devices
            ORDER BY id
        ")->fetchAll(PDO::FETCH_ASSOC);

        $monitorStatuses = $this->db->query("
            SELECT
                device_id,
                status,
                last_checked_at,
                last_response_ms,
                last_error
            FROM device_monitor_status
            ORDER BY device_id
        ")->fetchAll(PDO::FETCH_ASSOC);

        $placements = $this->db->query("
            SELECT
                id,
                device_id,
                view_id,
                x,
                y
            FROM device_placements
            ORDER BY id
        ")->fetchAll(PDO::FETCH_ASSOC);

        $links = $this->db->query("
            SELECT
                id,
                view_id,
                from_id,
                to_id,
                label,
                from_port,
                to_port,
                vlan,
                memo
            FROM links
            ORDER BY id
        ")->fetchAll(PDO::FETCH_ASSOC);

        $floorPlans = $this->db->query("
            SELECT *
            FROM view_floor_plans
            ORDER BY view_id
        ")->fetchAll(PDO::FETCH_ASSOC);

        return [
            'views' => $views,
            'devices' => $devices,
            'monitor_statuses' => $monitorStatuses,
            'placements' => $placements,
            'links' => $links,
            'floor_plans' => $floorPlans,
        ];
    }

    /**
     * 機器項目の重複を診断する。
     */
    public function appendDataQualityDuplicateIssues(
        array &$issues,
        array $devices,
        string $field,
        string $code,
        string $message,
        callable $normalize,
        ?callable $formatValue = null
    ): void {
        $groups = [];

        foreach ($devices as $device) {
            $rawValue = (string)($device[$field] ?? '');
            $normalized = $normalize($rawValue);

            if ($normalized === null || $normalized === '') {
                continue;
            }

            $groups[(string)$normalized][] = [
                'id' => (int)$device['id'],
                'name' => (string)($device['name'] ?? ''),
                'raw_value' => $rawValue,
            ];
        }

        foreach ($groups as $normalizedValue => $members) {
            if (count($members) < 2) {
                continue;
            }

            $entityIds = array_map(
                static fn(array $member): int => (int)$member['id'],
                $members
            );

            $displayValue = $formatValue !== null
                ? $formatValue($normalizedValue)
                : $members[0]['raw_value'];

            $issues[] = $this->createDataQualityIssue(
                $code,
                'warning',
                'duplicate',
                'device',
                $entityIds,
                $message,
                [
                    'field' => $field,
                    'value' => $displayValue,
                    'devices' => $members,
                ]
            );
        }
    }

    /**
     * DB全体のデータ品質を診断する。
     */
    public function diagnoseDataQuality(array $config): array
    {
        $source = $this->fetchDataQualitySource();

        $views = $source['views'];
        $devices = $source['devices'];
        $monitorStatuses = $source['monitor_statuses'];
        $placements = $source['placements'];
        $links = $source['links'];
        $floorPlans = $source['floor_plans'];

        $issues = [];

        $viewsById = [];
        $devicesById = [];
        $monitorByDeviceId = [];
        $placementsByDeviceId = [];
        $placementPairs = [];
        $floorPlanViewIds = [];

        foreach ($views as $view) {
            $viewsById[(int)$view['id']] = $view;
        }

        foreach ($devices as $device) {
            $devicesById[(int)$device['id']] = $device;
        }

        foreach ($monitorStatuses as $monitorStatus) {
            $monitorByDeviceId[(int)$monitorStatus['device_id']] = $monitorStatus;
        }

        foreach ($floorPlans as $floorPlan) {
            $viewId = (int)($floorPlan['view_id'] ?? 0);

            if ($viewId <= 0) {
                continue;
            }

            $floorPlanViewIds[$viewId] = true;

            if ((int)($floorPlan['is_visible'] ?? 1) === 0) {
                $view = $viewsById[$viewId] ?? null;

                $issues[] = $this->createDataQualityIssue(
                    'floor_plan_hidden',
                    'info',
                    'floor_plan',
                    'view',
                    [$viewId],
                    '登録済みのフロア図面が非表示です',
                    [
                        'view_name' => is_array($view) ? (string)($view['name'] ?? '') : '',
                        'original_name' => (string)($floorPlan['original_name'] ?? ''),
                    ]
                );
            }
        }

        /*
         * 配置の参照整合性。
         */
        foreach ($placements as $placement) {
            $placementId = (int)$placement['id'];
            $deviceId = (int)$placement['device_id'];
            $viewId = (int)$placement['view_id'];

            if (!isset($devicesById[$deviceId])) {
                $issues[] = $this->createDataQualityIssue(
                    'orphan_placement_device',
                    'error',
                    'integrity',
                    'placement',
                    [$placementId],
                    '配置が存在しない機器を参照しています',
                    [
                        'placement_id' => $placementId,
                        'device_id' => $deviceId,
                        'view_id' => $viewId,
                    ]
                );
            }

            if (!isset($viewsById[$viewId])) {
                $issues[] = $this->createDataQualityIssue(
                    'orphan_placement_view',
                    'error',
                    'integrity',
                    'placement',
                    [$placementId],
                    '配置が存在しないビューを参照しています',
                    [
                        'placement_id' => $placementId,
                        'device_id' => $deviceId,
                        'view_id' => $viewId,
                    ]
                );
            }

            if (isset($devicesById[$deviceId]) && isset($viewsById[$viewId])) {
                $placementsByDeviceId[$deviceId][] = $placement;
                $placementPairs[$viewId . ':' . $deviceId] = true;
            }
        }

        /*
         * 接続の参照整合性と重複。
         */
        $linkGroups = [];

        foreach ($links as $link) {
            $linkId = (int)$link['id'];
            $viewId = (int)$link['view_id'];
            $fromId = (int)$link['from_id'];
            $toId = (int)$link['to_id'];

            $hasView = isset($viewsById[$viewId]);
            $hasFromDevice = isset($devicesById[$fromId]);
            $hasToDevice = isset($devicesById[$toId]);

            if (!$hasView) {
                $issues[] = $this->createDataQualityIssue(
                    'orphan_link_view',
                    'error',
                    'integrity',
                    'link',
                    [$linkId],
                    '接続が存在しないビューを参照しています',
                    [
                        'link_id' => $linkId,
                        'view_id' => $viewId,
                    ]
                );
            }

            if (!$hasFromDevice) {
                $issues[] = $this->createDataQualityIssue(
                    'orphan_link_from_device',
                    'error',
                    'integrity',
                    'link',
                    [$linkId],
                    '接続の始点が存在しない機器を参照しています',
                    [
                        'link_id' => $linkId,
                        'device_id' => $fromId,
                    ]
                );
            }

            if (!$hasToDevice) {
                $issues[] = $this->createDataQualityIssue(
                    'orphan_link_to_device',
                    'error',
                    'integrity',
                    'link',
                    [$linkId],
                    '接続の終点が存在しない機器を参照しています',
                    [
                        'link_id' => $linkId,
                        'device_id' => $toId,
                    ]
                );
            }

            if ($hasView && $hasFromDevice && $hasToDevice) {
                $missingEndpointIds = [];

                if (!isset($placementPairs[$viewId . ':' . $fromId])) {
                    $missingEndpointIds[] = $fromId;
                }

                if (!isset($placementPairs[$viewId . ':' . $toId])) {
                    $missingEndpointIds[] = $toId;
                }

                if ($missingEndpointIds !== []) {
                    $issues[] = $this->createDataQualityIssue(
                        'link_endpoint_not_placed',
                        'error',
                        'integrity',
                        'link',
                        [$linkId],
                        '接続の両端が同じビューへ配置されていません',
                        [
                            'link_id' => $linkId,
                            'view_id' => $viewId,
                            'device_ids' => [$fromId, $toId],
                            'missing_device_ids' => array_values(array_unique($missingEndpointIds)),
                        ]
                    );
                }
            }

            /*
             * 始点・終点の順序を入れ替えても
             * 同じ接続として扱う。
             */
            $lowId = min($fromId, $toId);
            $highId = max($fromId, $toId);

            $linkKey = $viewId . ':' . $lowId . ':' . $highId;
            $linkGroups[$linkKey][] = $linkId;
        }

        foreach ($linkGroups as $linkIds) {
            if (count($linkIds) < 2) {
                continue;
            }

            $issues[] = $this->createDataQualityIssue(
                'duplicate_link',
                'error',
                'integrity',
                'link',
                $linkIds,
                '同一ビュー内に重複接続があります',
                [
                    'link_ids' => $linkIds,
                ]
            );
        }

        /*
         * 重複値。
         */
        $this->appendDataQualityDuplicateIssues(
            $issues,
            $devices,
            'ip',
            'duplicate_ip',
            'IPアドレスが重複しています',
            static fn(string $value): string => trim($value)
        );

        $this->appendDataQualityDuplicateIssues(
            $issues,
            $devices,
            'mac_address',
            'duplicate_mac',
            'MACアドレスが重複しています',
            fn(string $value): ?string => $this->normalizeDataQualityMac($value),
            fn(string $value): string => $this->formatDataQualityMac($value)
        );

        $identifierCaseInsensitive = (bool)($config['quality_identifier_case_insensitive'] ?? true);

        $this->appendDataQualityDuplicateIssues(
            $issues,
            $devices,
            'asset_number',
            'duplicate_asset_number',
            '管理番号が重複しています',
            fn(string $value): string => $this->normalizeDataQualityText($value, $identifierCaseInsensitive)
        );

        $this->appendDataQualityDuplicateIssues(
            $issues,
            $devices,
            'serial_number',
            'duplicate_serial_number',
            'シリアル番号が重複しています',
            fn(string $value): string => $this->normalizeDataQualityText($value, $identifierCaseInsensitive)
        );

        /*
         * 必須・推奨項目不足。
         */
        $this->appendDataQualityMissingFieldIssues(
            $issues,
            $devices,
            $config
        );

        /*
         * 表記差を吸収した機器名称の類似診断。
         */
        if ((bool)($config['quality_similar_name_enabled'] ?? true)) {
            $this->appendDataQualitySimilarNameIssues(
                $issues,
                $devices
            );
        }

        /*
         * 機器単位の診断。
         */
        $staleDays = max(1, (int)($config['quality_stale_monitor_days'] ?? 30));
        $staleBefore = new DateTimeImmutable('-' . $staleDays . ' days');
        $tokyoTz = new DateTimeZone('Asia/Tokyo');
        $todayTokyo = new DateTimeImmutable('today', $tokyoTz);
        $approachingThreshold = $todayTokyo->modify('+30 days');

        foreach ($devices as $device) {
            $deviceId = (int)$device['id'];
            $ip = trim((string)($device['ip'] ?? ''));
            $mac = trim((string)($device['mac_address'] ?? ''));

            if ($mac !== '' && $this->normalizeDataQualityMac($mac) === null) {
                $issues[] = $this->createDataQualityIssue(
                    'nonstandard_mac',
                    'warning',
                    'format',
                    'device',
                    [$deviceId],
                    'MACアドレスが標準形式ではありません',
                    [
                        'field' => 'mac_address',
                        'value' => $mac,
                    ]
                );
            }

            /*
             * 管理接続・保守情報の診断
             */
            $scheme = trim((string)($device['management_scheme'] ?? ''));
            $portRaw = $device['management_port'] ?? null;

            if ($scheme !== '' && !in_array($scheme, ['http', 'https', 'ssh'], true)) {
                $issues[] = $this->createDataQualityIssue(
                    'invalid_management_scheme',
                    'error',
                    'format',
                    'device',
                    [$deviceId],
                    '管理接続方式が不正です',
                    ['scheme' => $scheme]
                );
            }

            if ($scheme === '' && $portRaw !== null && trim((string)$portRaw) !== '') {
                $issues[] = $this->createDataQualityIssue(
                    'management_port_without_scheme',
                    'error',
                    'format',
                    'device',
                    [$deviceId],
                    '管理接続方式が未設定のままポートが指定されています',
                    ['port' => $portRaw]
                );
            }

            if ($portRaw !== null && trim((string)$portRaw) !== '') {
                $portStr = trim((string)$portRaw);
                if (preg_match('/\A[0-9]+\z/', $portStr) !== 1 || (int)$portStr < 1 || (int)$portStr > 65535) {
                    $issues[] = $this->createDataQualityIssue(
                        'invalid_management_port',
                        'error',
                        'format',
                        'device',
                        [$deviceId],
                        '管理接続ポートが1〜65535の整数ではありません',
                        ['port' => $portRaw]
                    );
                }
            }

            $installDate = trim((string)($device['install_date'] ?? ''));
            $maintenanceExpiry = trim((string)($device['maintenance_expiry'] ?? ''));
            $isInstallValid = true;
            $isExpiryValid = true;

            if ($installDate !== '') {
                if (!DeviceFields::isValidDateString($installDate)) {
                    $isInstallValid = false;
                    $issues[] = $this->createDataQualityIssue(
                        'invalid_install_date',
                        'error',
                        'format',
                        'device',
                        [$deviceId],
                        '導入年月が実在する日付形式ではありません',
                        ['install_date' => $installDate]
                    );
                }
            }

            if ($maintenanceExpiry !== '') {
                if (!DeviceFields::isValidDateString($maintenanceExpiry)) {
                    $isExpiryValid = false;
                    $issues[] = $this->createDataQualityIssue(
                        'invalid_maintenance_expiry_date',
                        'error',
                        'format',
                        'device',
                        [$deviceId],
                        '保守期限が実在する日付形式ではありません',
                        ['maintenance_expiry' => $maintenanceExpiry]
                    );
                }
            }

            if ($isInstallValid && $isExpiryValid && $installDate !== '' && $maintenanceExpiry !== '') {
                if (!DeviceFields::validateDateOrder($installDate, $maintenanceExpiry)) {
                    $issues[] = $this->createDataQualityIssue(
                        'maintenance_expiry_before_install',
                        'warning',
                        'maintenance',
                        'device',
                        [$deviceId],
                        '保守期限が導入年月より前になっています',
                        [
                            'install_date' => $installDate,
                            'maintenance_expiry' => $maintenanceExpiry,
                        ]
                    );
                }
            }

            if ($isExpiryValid && $maintenanceExpiry !== '') {
                try {
                    $expiryDate = strlen($maintenanceExpiry) === 7
                        ? (new DateTimeImmutable($maintenanceExpiry . '-01', $tokyoTz))->modify('last day of this month')
                        : new DateTimeImmutable($maintenanceExpiry, $tokyoTz);

                    if ($expiryDate < $todayTokyo) {
                        $issues[] = $this->createDataQualityIssue(
                            'maintenance_expired',
                            'warning',
                            'maintenance',
                            'device',
                            [$deviceId],
                            '保守期限が切れています',
                            ['maintenance_expiry' => $maintenanceExpiry]
                        );
                    } elseif ($expiryDate <= $approachingThreshold) {
                        $issues[] = $this->createDataQualityIssue(
                            'maintenance_expiry_approaching',
                            'info',
                            'maintenance',
                            'device',
                            [$deviceId],
                            '保守期限が近づいています（30日以内）',
                            ['maintenance_expiry' => $maintenanceExpiry]
                        );
                    }
                } catch (Throwable $e) {
                    // 日付パース例外（通常はisValidDateStringで除外済み）
                }
            }

            if (!isset($placementsByDeviceId[$deviceId])) {
                $issues[] = $this->createDataQualityIssue(
                    'unplaced_device',
                    'warning',
                    'placement',
                    'device',
                    [$deviceId],
                    '機器がどのビューにも配置されていません',
                    []
                );
            }

            if ($ip === '') {
                $issues[] = $this->createDataQualityIssue(
                    'monitoring_not_applicable',
                    'info',
                    'monitoring',
                    'device',
                    [$deviceId],
                    'IPアドレスがないため監視対象外相当です',
                    [
                        'reason' => 'ip_not_set',
                    ]
                );
            } else {
                $monitor = $monitorByDeviceId[$deviceId] ?? null;
                $lastCheckedAt = trim((string)($monitor['last_checked_at'] ?? ''));

                if ($lastCheckedAt === '') {
                    $issues[] = $this->createDataQualityIssue(
                        'monitor_unconfirmed',
                        'info',
                        'monitoring',
                        'device',
                        [$deviceId],
                        '監視状態が未確認です',
                        []
                    );
                } else {
                    try {
                        $checkedAt = new DateTimeImmutable($lastCheckedAt);

                        if ($checkedAt < $staleBefore) {
                            $issues[] = $this->createDataQualityIssue(
                                'stale_monitor',
                                'warning',
                                'monitoring',
                                'device',
                                [$deviceId],
                                '長期間、監視確認されていません',
                                [
                                    'last_checked_at' => $lastCheckedAt,
                                    'stale_days' => $staleDays,
                                ]
                            );
                        }
                    } catch (Throwable $e) {
                        $issues[] = $this->createDataQualityIssue(
                            'invalid_monitor_date',
                            'warning',
                            'monitoring',
                            'device',
                            [$deviceId],
                            '監視確認日時の形式が不正です',
                            [
                                'last_checked_at' => $lastCheckedAt,
                            ]
                        );
                    }
                }
            }

            /*
             * フロア不一致。
             *
             * floorビューで、双方の施設・フロアが
             * 入力済みの場合だけ比較する。
             */
            foreach ($placementsByDeviceId[$deviceId] ?? [] as $placement) {
                $viewId = (int)$placement['view_id'];
                $view = $viewsById[$viewId] ?? null;

                if (!is_array($view) || (string)$view['view_type'] !== 'floor') {
                    continue;
                }

                $deviceFacility = trim((string)($device['facility'] ?? ''));
                $deviceFloor = trim((string)($device['floor'] ?? ''));
                $viewFacility = trim((string)($view['facility'] ?? ''));
                $viewFloor = trim((string)($view['floor'] ?? ''));

                if (
                    $deviceFacility === '' ||
                    $deviceFloor === '' ||
                    $viewFacility === '' ||
                    $viewFloor === ''
                ) {
                    continue;
                }

                if (
                    $this->normalizeDataQualityLocation($deviceFacility) ===
                        $this->normalizeDataQualityLocation($viewFacility) &&
                    $this->normalizeDataQualityLocation($deviceFloor) ===
                        $this->normalizeDataQualityLocation($viewFloor)
                ) {
                    continue;
                }

                $issues[] = $this->createDataQualityIssue(
                    'floor_mismatch',
                    'warning',
                    'placement',
                    'device',
                    [$deviceId],
                    '機器情報と配置先ビューの施設・フロアが一致しません',
                    [
                        'view_id' => $viewId,
                        'device_facility' => $deviceFacility,
                        'device_floor' => $deviceFloor,
                        'view_facility' => $viewFacility,
                        'view_floor' => $viewFloor,
                    ]
                );
            }
        }

        /*
         * フロアビューの図面登録状況。
         */
        foreach ($views as $view) {
            $viewId = (int)$view['id'];

            if ((string)$view['view_type'] !== 'floor' || isset($floorPlanViewIds[$viewId])) {
                continue;
            }

            $issues[] = $this->createDataQualityIssue(
                'floor_view_without_plan',
                'warning',
                'floor_plan',
                'view',
                [$viewId],
                'フロアビューに図面が登録されていません',
                [
                    'view_name' => (string)$view['name'],
                ]
            );
        }

        /*
         * severity順、code順に安定ソートする。
         */
        $severityOrder = [
            'error' => 0,
            'warning' => 1,
            'info' => 2,
        ];

        usort(
            $issues,
            static function (array $left, array $right) use ($severityOrder): int {
                $severityComparison =
                    ($severityOrder[$left['severity']] ?? 99)
                    <=>
                    ($severityOrder[$right['severity']] ?? 99);

                if ($severityComparison !== 0) {
                    return $severityComparison;
                }

                $codeComparison = strcmp($left['code'], $right['code']);

                if ($codeComparison !== 0) {
                    return $codeComparison;
                }

                return ($left['entity_ids'][0] ?? 0) <=> ($right['entity_ids'][0] ?? 0);
            }
        );

        return $issues;
    }

    /**
     * severity別の問題件数を集計する。
     */
    public function summarizeDataQualityIssues(array $issues): array
    {
        $summary = [
            'error' => 0,
            'warning' => 0,
            'info' => 0,
            'total' => 0,
        ];

        foreach ($issues as $issue) {
            $severity = (string)($issue['severity'] ?? '');

            if (array_key_exists($severity, $summary)) {
                $summary[$severity]++;
            }

            $summary['total']++;
        }

        return $summary;
    }

    /**
     * データ品質診断を実行し、完全なレスポンスデータを生成する
     */
    public function runDiagnosis(array $config): array
    {
        $revision = $this->appMetaRepo->getDataRevision();
        $issues = $this->diagnoseDataQuality($config);

        return [
            'ok' => true,
            'generated_at' => (new DateTimeImmutable())->format(DATE_ATOM),
            'revision' => $revision,
            'summary' => $this->summarizeDataQualityIssues($issues),
            'settings' => [
                'stale_monitor_days' => max(1, (int)($config['quality_stale_monitor_days'] ?? 30)),
                'identifier_case_insensitive' => (bool)($config['quality_identifier_case_insensitive'] ?? true),
                'recommended_device_fields' => $this->getDataQualityRecommendedDeviceFields($config),
                'similar_name_enabled' => (bool)($config['quality_similar_name_enabled'] ?? true),
            ],
            'issues' => $issues,
        ];
    }
}
