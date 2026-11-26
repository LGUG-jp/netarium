<?php
declare(strict_types=1);

namespace Netarium\Services\Quality;

use DateTimeImmutable;
use DateTimeZone;
use LogicException;
use Normalizer;
use PDO;
use Throwable;
use Netarium\Core\ApiException;
use Netarium\Repositories\AppMetaRepository;
use Netarium\Repositories\DeviceIpAddressRepository;
use Netarium\Services\Topology\DeviceFields;
use Netarium\Services\Topology\LinkRoute;
use Netarium\Services\Monitoring\PingReachabilityPolicy;

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
     * 診断結果に表示する機器項目名を返す。
     */
    public function getDataQualityDeviceFieldLabels(): array
    {
        return [
            'name' => '名称',
            'type' => '種別',
            'ip' => 'IPアドレス',
            'floor_id' => '設置フロア',
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
        return QualityNotApplicable::recommendedDeviceFields($config);
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
            'pc',
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
                if (QualityNotApplicable::isMissing($device, $field)) {
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
                floor_id,
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
                floor_id,
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
                maintenance_expiry,
                resource_revision
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

        $links = $this->db->query('SELECT id, from_id, to_id, from_port_id, to_port_id, resource_revision FROM links ORDER BY id')->fetchAll(PDO::FETCH_ASSOC);

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
            'device_ports' => $this->db->query('SELECT id, device_id FROM device_ports ORDER BY id')->fetchAll(PDO::FETCH_ASSOC),
            'view_link_routes' => $this->db->query('SELECT * FROM view_link_routes ORDER BY view_id, device_a_id, device_b_id')->fetchAll(PDO::FETCH_ASSOC),
            'legacy_link_conflicts' => $this->db->query('SELECT legacy_link_id, view_id, device_a_id, device_b_id, reason
                FROM legacy_link_conflicts ORDER BY legacy_link_id')->fetchAll(PDO::FETCH_ASSOC),
            'legacy_link_vlans' => $this->db->query('SELECT v.link_id, v.vlan, l.from_id, l.to_id
                FROM legacy_link_vlans v JOIN links l ON l.id = v.link_id ORDER BY v.link_id')->fetchAll(PDO::FETCH_ASSOC),
            'floor_plans' => $floorPlans,
            'rack_mounts' => $this->db->query("SELECT m.device_id, m.view_id FROM rack_mounts m
                JOIN views v ON v.id = m.view_id WHERE v.view_type = 'rack'
                UNION ALL SELECT d.device_id, s.view_id FROM rack_shelf_devices d
                JOIN rack_shelves s ON s.id = d.shelf_id
                JOIN views v ON v.id = s.view_id WHERE v.view_type = 'rack'")->fetchAll(PDO::FETCH_ASSOC),
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
        return $this->diagnoseSource($this->fetchDataQualitySource(), $config);
    }

    private function diagnoseSource(array $source, array $config): array
    {
        $views = $source['views'];
        $devices = $source['devices'];
        $monitorStatuses = $source['monitor_statuses'];
        $placements = $source['placements'];
        $floorPlans = $source['floor_plans'];
        $rackMountedDeviceIds = array_fill_keys(array_column($source['rack_mounts'], 'device_id'), true);

        $issues = [];

        $viewsById = [];
        $devicesById = [];
        $monitorByDeviceId = [];
        $placementsByDeviceId = [];
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
            }
        }

        $this->appendConnectionIssues($issues, $source, $viewsById, $devicesById);

        /*
         * 重複値。
         */
        $hasIpSegments = (bool)$this->db->query('SELECT EXISTS(SELECT 1 FROM ip_segments)')->fetchColumn();
        $ipGroups = [];
        $ipRecords = (new DeviceIpAddressRepository($this->db))->getIpRecords();
        $pingDecisions = PingReachabilityPolicy::decisions(
            $ipRecords,
            $this->db->query('SELECT * FROM address_spaces ORDER BY id')->fetchAll(PDO::FETCH_ASSOC)
        );
        foreach ($ipRecords as $record) {
            $ipGroups[$record['ip']][] = $record;
            // 不正なIPv4やIPv6は未分類診断の対象に含めない。
            if ($hasIpSegments && $record['segment_id'] === null
                && filter_var($record['ip'], FILTER_VALIDATE_IP, FILTER_FLAG_IPV4) !== false) {
                $fieldLabel = $record['kind'] === 'management' ? '管理IPv4アドレス' : '追加IPv4アドレス';
                $issues[] = $this->createDataQualityIssue(
                    'unclassified_ip', 'warning', 'completeness', 'device', [(int)$record['device_id']],
                    $fieldLabel . ' ' . $record['ip'] . ' が未分類です。IPアドレス管理で所属を確認してください',
                    [
                        'field' => $record['kind'] === 'management' ? 'ip' : 'additional_ips',
                        'field_labels' => [$fieldLabel],
                        'value' => $record['ip'],
                        'devices' => [['id' => (int)$record['device_id'], 'name' => $record['device_name']]],
                        'ip_records' => [$record],
                    ]
                );
            }
        }
        foreach ($ipGroups as $ip => $records) {
            $records = array_values(array_filter($records, static function (array $record) use ($records): bool {
                foreach ($records as $other) {
                    if ($record === $other) { continue; }
                    if ($record['address_space_id'] === null || $other['address_space_id'] === null
                        || $record['address_space_id'] === $other['address_space_id']) { return true; }
                }
                return false;
            }));
            $deviceIds = array_values(array_unique(array_map('intval', array_column($records, 'device_id'))));
            if (count($records) < 2) { continue; }
            $issues[] = $this->createDataQualityIssue(
                'duplicate_ip', 'warning', 'duplicate', 'device', $deviceIds,
                'IPアドレスが重複しています。利用状況を確認してください',
                ['field' => 'ip', 'value' => (string)$ip, 'devices' => array_map(
                    static fn(array $record): array => ['id' => (int)$record['device_id'], 'name' => $record['device_name']],
                    $records
                ), 'ip_records' => $records]
            );
        }

        // 同値IPという事実ではなく、管理IPの通信先が設定上識別できない場合だけ警告する。
        $warnedIps = [];
        foreach ($pingDecisions as $decision) {
            if (!in_array($decision['reason_code'], ['multiple_reachable', 'unresolved'], true)) { continue; }
            $records = $decision['records'];
            $ip = (string)$records[0]['ip'];
            if (isset($warnedIps[$ip])) { continue; }
            $warnedIps[$ip] = true;
            $issues[] = $this->createDataQualityIssue(
                'ambiguous_ping_target', 'warning', 'monitoring', 'device', array_column($records, 'device_id'),
                'Ping対象の識別不可: ' . $ip . ' の通信先を特定できないため、Pingはスキップされます',
                [
                    'value' => $ip,
                    'reason' => $decision['reason_code'],
                    'devices' => array_map(static fn(array $record): array =>
                        ['id' => (int)$record['device_id'], 'name' => $record['device_name']], $records),
                    'ip_records' => $records,
                ]
            );
        }

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
        $floorPathsById = array_column(
            $this->db->query("SELECT f.id, b.name || ' / ' || f.name AS path FROM floors f JOIN buildings b ON b.id = f.building_id")->fetchAll(PDO::FETCH_ASSOC),
            'path',
            'id'
        );

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

            if ($maintenanceExpiry === '') {
                $issues[] = $this->createDataQualityIssue(
                    'maintenance_expiry_missing',
                    'info',
                    'maintenance',
                    'device',
                    [$deviceId],
                    '保守期限が登録されていません',
                    ['field' => 'maintenance_expiry']
                );
            } else {
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

            if (!isset($placementsByDeviceId[$deviceId]) && !isset($rackMountedDeviceIds[$deviceId])) {
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
                $intentionallyExcluded = ($pingDecisions[$deviceId]['reason_code'] ?? null) === 'unreachable';

                if ($lastCheckedAt === '' && !$intentionallyExcluded) {
                    $issues[] = $this->createDataQualityIssue(
                        'monitor_unconfirmed',
                        'info',
                        'monitoring',
                        'device',
                        [$deviceId],
                        '監視状態が未確認です',
                        []
                    );
                } elseif ($lastCheckedAt !== '') {
                    try {
                        $checkedAt = new DateTimeImmutable($lastCheckedAt);

                        if (!$intentionallyExcluded && $checkedAt < $staleBefore) {
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

            // Physical installation is independent of diagram placement.
            // Report only explicit floor-ID differences on physical diagrams.
            foreach ($placementsByDeviceId[$deviceId] ?? [] as $placement) {
                $viewId = (int)$placement['view_id'];
                $view = $viewsById[$viewId] ?? null;

                if (!is_array($view) || (string)$view['view_type'] !== 'floor') {
                    continue;
                }

                $deviceFloorId = $device['floor_id'] ?? null;
                $viewFloorId = $view['floor_id'] ?? null;
                if ($deviceFloorId === null || $viewFloorId === null || (int)$deviceFloorId === (int)$viewFloorId) { continue; }
                $devicePath = $floorPathsById[(int)$deviceFloorId] ?? (string)$deviceFloorId;
                $viewPath = $floorPathsById[(int)$viewFloorId] ?? (string)$viewFloorId;

                $issues[] = $this->createDataQualityIssue(
                    'floor_mismatch',
                    'warning',
                    'placement',
                    'device',
                    [$deviceId],
                    '機器の設置フロアと配置先ビューの所属フロアが異なります',
                    [
                        'view_id' => $viewId,
                        'device_floor_id' => $deviceFloorId,
                        'view_floor_id' => $viewFloorId,
                        'device_path' => $devicePath,
                        'view_path' => $viewPath,
                    ]
                );
            }
        }

        $rackFloorMismatches = $this->db->query("
            SELECT rack.id AS rack_view_id, rack.name AS rack_view_name, rack.floor_id AS rack_floor_id,
                   physical.id AS view_id, physical.name AS view_name, physical.floor_id AS view_floor_id
            FROM floor_rack_placements p
            JOIN views rack ON rack.id = p.rack_view_id AND rack.view_type = 'rack'
            JOIN views physical ON physical.id = p.floor_view_id AND physical.view_type = 'floor'
            WHERE rack.floor_id IS NOT NULL AND rack.floor_id IS NOT physical.floor_id
        ");
        while ($placement = $rackFloorMismatches->fetch(PDO::FETCH_ASSOC)) {
            $rackViewId = (int)$placement['rack_view_id'];
            $rackFloorId = (int)$placement['rack_floor_id'];
            $viewFloorId = $placement['view_floor_id'] === null ? null : (int)$placement['view_floor_id'];

            $issues[] = $this->createDataQualityIssue(
                'rack_floor_mismatch',
                'warning',
                'placement',
                'view',
                [$rackViewId],
                $viewFloorId === null
                    ? 'ラックの配置先ビューに所属フロアが設定されていません'
                    : 'ラックと配置先ビューの所属フロアが異なります',
                [
                    'view_id' => (int)$placement['view_id'],
                    'rack_view_name' => (string)$placement['rack_view_name'],
                    'view_name' => (string)$placement['view_name'],
                    'rack_floor_id' => $rackFloorId,
                    'view_floor_id' => $viewFloorId,
                    'rack_path' => $floorPathsById[$rackFloorId] ?? (string)$rackFloorId,
                    'view_path' => $viewFloorId === null ? null : ($floorPathsById[$viewFloorId] ?? (string)$viewFloorId),
                ]
            );
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

    private function appendConnectionIssues(array &$issues, array $source, array $viewsById, array $devicesById): void
    {
        $portOwners = array_column($source['device_ports'], 'device_id', 'id');
        foreach ($portOwners as $portId => $deviceId) {
            if (!isset($devicesById[$deviceId])) {
                $issues[] = $this->createDataQualityIssue(
                    'orphan_device_port', 'error', 'integrity', 'device', [$deviceId],
                    'ポートが存在しない機器を参照しています', ['port_id' => $portId, 'device_id' => $deviceId]
                );
            }
        }

        $pairs = [];
        foreach ($source['legacy_link_conflicts'] as $row) {
            $pairs[$row['device_a_id'] . ':' . $row['device_b_id']] = true;
            $issues[] = $this->createDataQualityIssue(
                'legacy_link_conflict', 'warning', 'integrity', 'view', [$row['view_id']],
                '移行保留の旧接続があります。確認が必要です', $row
            );
        }

        foreach ($source['legacy_link_vlans'] as $row) {
            $linkId = (int)$row['link_id'];
            $issues[] = $this->createDataQualityIssue(
                'legacy_link_vlan', 'warning', 'integrity', 'link', [$linkId],
                '未移行VLANは、再設定または削除してください。',
                ['link_id' => $linkId, 'device_ids' => [(int)$row['from_id'], (int)$row['to_id']], 'vlan' => $row['vlan']]
            );
        }

        $linkGroups = [];
        $portGroups = [];
        foreach ($source['links'] as $link) {
            $linkId = $link['id'];
            $from = $link['from_id'];
            $to = $link['to_id'];
            $pair = min($from, $to) . ':' . max($from, $to);
            $pairs[$pair] = true;
            if ($from === $to) {
                $issues[] = $this->createDataQualityIssue(
                    'self_link', 'error', 'integrity', 'link', [$linkId],
                    '同一機器の自己接続があります', ['link_id' => $linkId, 'device_id' => $from]
                );
            }
            if ($link['from_port_id'] === null && $link['to_port_id'] === null) {
                $linkGroups[$pair][] = $linkId;
            }
            $missingEndpoints = [];
            foreach (['from', 'to'] as $endpoint) {
                $deviceId = $link[$endpoint . '_id'];
                $portId = $link[$endpoint . '_port_id'];
                if (!isset($devicesById[$deviceId])) {
                    $issues[] = $this->createDataQualityIssue(
                        'orphan_link_' . $endpoint . '_device', 'error', 'integrity', 'link', [$linkId],
                        '接続の端点が存在しない機器を参照しています', ['link_id' => $linkId, 'device_id' => $deviceId]
                    );
                } elseif ($portId === null) {
                    $missingEndpoints[$endpoint] = [
                        'device_id' => (int)$deviceId,
                        'device_name' => (string)$devicesById[$deviceId]['name'],
                    ];
                }
                if ($portId !== null) {
                    $portGroups[$portId][] = $linkId;
                    if (($portOwners[$portId] ?? null) !== $deviceId) {
                        $issues[] = $this->createDataQualityIssue(
                            'invalid_link_port', 'error', 'integrity', 'link', [$linkId],
                            '接続のポートが端点機器の台帳にありません',
                            ['link_id' => $linkId, 'device_id' => $deviceId, 'port_id' => $portId]
                        );
                    }
                }
            }
            if ($missingEndpoints !== []) {
                $issues[] = $this->createDataQualityIssue(
                    'link_ports_missing', 'info', 'completeness', 'link', [$linkId],
                    '接続端点のポートが指定されていません', ['missing_endpoints' => $missingEndpoints]
                );
            }
        }

        foreach ($linkGroups as $linkIds) {
            if (count($linkIds) > 1) {
                $issues[] = $this->createDataQualityIssue(
                    'duplicate_link', 'error', 'integrity', 'link', $linkIds,
                    '同じ機器ペアに両端ポート未指定の接続が重複しています', ['link_ids' => $linkIds]
                );
            }
        }
        foreach ($portGroups as $portId => $linkIds) {
            if (count($linkIds) > 1) {
                $issues[] = $this->createDataQualityIssue(
                    'duplicate_port_use', 'error', 'integrity', 'link', array_values(array_unique($linkIds)),
                    '同じ機器ポートが複数の端点で使用されています', ['port_id' => $portId, 'link_ids' => $linkIds]
                );
            }
        }

        foreach ($source['view_link_routes'] as $row) {
            $viewId = $row['view_id'];
            $a = $row['device_a_id'];
            $b = $row['device_b_id'];
            $type = $viewsById[$viewId]['view_type'] ?? null;
            $valid = $type !== null && $type !== 'rack' && $a < $b
                && isset($devicesById[$a], $devicesById[$b], $pairs["{$a}:{$b}"]);
            if ($valid) {
                try {
                    LinkRoute::normalize(['route_mode' => 'manual', 'manual_route' => json_decode($row['manual_route'], true)]);
                } catch (ApiException $e) {
                    $valid = false;
                }
            }
            if (!$valid) {
                $issues[] = $this->createDataQualityIssue(
                    'invalid_view_link_route', 'error', 'integrity', 'view', [$viewId],
                    'ビューの手動経路の参照先または中間点が不正です',
                    ['view_id' => $viewId, 'device_ids' => [$a, $b]]
                );
            }
        }
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

    private function getNotApplicableItems(array $issue, array $labels, array $resourceRevisions): array
    {
        $details = $issue['details'];
        if ($issue['code'] === 'link_ports_missing') {
            $items = [];
            foreach ($details['missing_endpoints'] as $side => $endpoint) {
                $items[] = [
                    'field' => $side . '_port',
                    'device_id' => $endpoint['device_id'],
                    'label' => $side === 'from' ? '始点ポート' : '終点ポート',
                    'resource_revision' => (int)$resourceRevisions['link'][$issue['entity_ids'][0]],
                ];
            }
            return $items;
        }

        $fields = match ($issue['code']) {
            'monitoring_not_applicable' => ($details['reason'] === 'ip_not_set') ? ['ip'] : [],
            'missing_recommended_fields' => $details['fields'],
            'maintenance_expiry_missing' => ['maintenance_expiry'],
            default => [],
        };
        return array_map(static fn(string $field): array => [
            'field' => $field, 'device_id' => $issue['entity_ids'][0], 'label' => $labels[$field],
            'resource_revision' => (int)$resourceRevisions['device'][$issue['entity_ids'][0]],
        ], $fields);
    }

    private function withNotApplicableItems(array $issue, array $items): array
    {
        $issue['not_applicable_items'] = $items;
        if ($issue['code'] === 'missing_recommended_fields') {
            $issue['details']['fields'] = array_column($items, 'field');
            $issue['details']['field_labels'] = array_column($items, 'label');
        } elseif ($issue['code'] === 'link_ports_missing') {
            $sides = array_map(static fn(array $item): string => substr($item['field'], 0, -5), $items);
            $issue['details']['missing_endpoints'] = array_intersect_key($issue['details']['missing_endpoints'], array_flip($sides));
        }
        return $issue;
    }

    private function splitNotApplicableIssues(array $issues, array $rows, array $resourceRevisions): array
    {
        $deviceFields = $linkFields = [];
        foreach ($rows as $row) {
            if ($row['link_id'] === null) {
                $deviceFields[$row['device_id']][$row['field']] = true;
            } else {
                $linkFields[$row['link_id']][$row['field']] = (int)$row['device_id'];
            }
        }

        $labels = $this->getDataQualityDeviceFieldLabels();
        $visible = $suppressed = [];
        $suppressedCount = 0;
        foreach ($issues as $issue) {
            $items = $this->getNotApplicableItems($issue, $labels, $resourceRevisions);
            if ($items === []) {
                $visible[] = $issue;
                continue;
            }
            $visibleItems = $suppressedItems = [];
            foreach ($items as $item) {
                $isSuppressed = $issue['entity_type'] === 'link'
                    ? ($linkFields[$issue['entity_ids'][0]][$item['field']] ?? null) === $item['device_id']
                    : isset($deviceFields[$item['device_id']][$item['field']]);
                if ($isSuppressed) {
                    $suppressedItems[] = $item;
                } else {
                    $visibleItems[] = $item;
                }
            }
            if ($visibleItems !== []) {
                $visible[] = $this->withNotApplicableItems($issue, $visibleItems);
            }
            if ($suppressedItems !== []) {
                $suppressed[] = $this->withNotApplicableItems($issue, $suppressedItems);
                $suppressedCount += count($suppressedItems);
            }
        }
        return [$visible, $suppressed, $suppressedCount];
    }

    /**
     * データ品質診断を実行し、完全なレスポンスデータを生成する
     */
    public function runDiagnosis(array $config): array
    {
        $ownsTransaction = !$this->db->inTransaction();
        if ($ownsTransaction) {
            $this->db->beginTransaction();
        }
        try {
            $revision = $this->appMetaRepo->getDataRevision();
            $source = $this->fetchDataQualitySource();
            $issues = $this->diagnoseSource($source, $config);
            $resourceRevisions = [
                'device' => array_column($source['devices'], 'resource_revision', 'id'),
                'link' => array_column($source['links'], 'resource_revision', 'id'),
            ];
            $hierarchy = [
                'views' => $source['views'],
                'devices' => $source['devices'],
            ];
            unset($source);
            $notApplicableRows = $this->db->query('SELECT device_id, link_id, field FROM quality_not_applicable')->fetchAll(PDO::FETCH_ASSOC);
            foreach (['buildings', 'floors'] as $table) {
                $hierarchy[$table] = $this->db->query("SELECT * FROM {$table} ORDER BY id")->fetchAll(PDO::FETCH_ASSOC);
            }
            if ($ownsTransaction) {
                $this->db->commit();
            }
        } catch (Throwable $e) {
            if ($ownsTransaction && $this->db->inTransaction()) { $this->db->rollBack(); }
            throw $e;
        }
        [$issues, $suppressedIssues, $suppressedCount] = $this->splitNotApplicableIssues($issues, $notApplicableRows, $resourceRevisions);
        $migration = \Netarium\Services\Topology\LegacyHierarchyMigration::convert($hierarchy);

        return [
            'ok' => true,
            'generated_at' => (new DateTimeImmutable())->format(DATE_ATOM),
            'revision' => $revision,
            'summary' => $this->summarizeDataQualityIssues($issues),
            'legacy_hierarchy' => $migration,
            'settings' => [
                'stale_monitor_days' => max(1, (int)($config['quality_stale_monitor_days'] ?? 30)),
                'identifier_case_insensitive' => (bool)($config['quality_identifier_case_insensitive'] ?? true),
                'recommended_device_fields' => $this->getDataQualityRecommendedDeviceFields($config),
                'similar_name_enabled' => (bool)($config['quality_similar_name_enabled'] ?? true),
            ],
            'issues' => $issues,
            'suppressed_issues' => $suppressedIssues,
            'suppressed_count' => $suppressedCount,
        ];
    }
}
