<?php
declare(strict_types=1);

namespace Netarium\Services\Topology;

use DateInterval;
use DateTimeImmutable;
use DateTimeZone;
use PDO;
use Throwable;
use Netarium\Core\ApiException;
use Netarium\Core\AuditLog;
use Netarium\Core\ResourceId;
use Netarium\Repositories\DeviceIpAddressRepository;

final class ChangeHistoryService
{
    public const RETENTION_DAYS = 90;
    public const ALLOWED_PERIOD_DAYS = [7, 30, 90];
    public const DEFAULT_PERIOD_DAYS = 30;
    public const DEFAULT_PER_PAGE = 50;
    public const MAX_PER_PAGE = 100;

    private const MAX_SUBCOLLECTION_ITEMS = 8;
    private const PREVIEW_SUBCOLLECTION_ITEMS = 5;
    private const MAX_TOTAL_ITEMS = 25;
    private const MAX_CHANGES_JSON_BYTES = 16384;
    private const MAX_VALUE_CHARS = 160;
    private const MAX_LABEL_CHARS = 120;
    private const MAX_SUMMARY_CHARS = 500;
    private const MAX_TARGET_NAME_CHARS = 200;

    public const DEVICE_TYPE_LABELS = [
        'switch' => 'L2スイッチ',
        'l3_switch' => 'L3スイッチ',
        'router' => 'ルータ',
        'firewall' => 'ファイアウォール',
        'ap' => 'アクセスポイント',
        'server' => 'サーバ',
        'pc' => 'PC',
        'printer' => 'プリンタ・複合機',
        'other' => 'その他',
    ];

    public const VIEW_TYPE_LABELS = [
        'topology' => '論理・全体構成図',
        'floor' => '物理・フロア配置図',
        'rack' => 'ラック搭載図',
    ];

    private const FACE_LABELS = [
        'front' => '前面',
        'rear' => '背面',
        'both' => '両面',
    ];

    private const SLOT_LABELS = [
        'full' => '全幅',
        'left' => '左半幅',
        'right' => '右半幅',
    ];

    private const DEPTH_LABELS = [
        'half' => '半奥行',
        'full' => '全奥行',
    ];

    /**
     * 機器の記録対象フィールド（小さな明示的ホワイトリスト）。
     * x/y互換列、resource_revision、IP所属分類、画像実体、監視結果、秘密値、config全文は含めない。
     */
    private const DEVICE_FIELD_LABELS = [
        'name' => '名称',
        'type' => '種別',
        'ip' => '管理IP',
        'additional_ips' => '追加IPv4',
        'facility' => '施設',
        'floor' => 'フロア',
        'location' => '設置場所',
        'manufacturer' => 'メーカー',
        'model' => '型番',
        'asset_number' => '資産番号',
        'serial_number' => 'シリアル番号',
        'mac_address' => 'MACアドレス',
        'department' => '管理部署',
        'maintenance_vendor' => '保守会社',
        'install_date' => '導入年月',
        'maintenance_expiry' => '保守期限',
        'management_connection' => '管理接続',
        'memo' => '備考',
    ];

    private const VIEW_FIELD_LABELS = [
        'name' => 'ビュー名',
        'view_type' => '種別',
        'facility' => '施設',
        'floor' => 'フロア',
        'sort_order' => '表示順',
        'memo' => '備考',
    ];

    public function __construct(private PDO $db)
    {
    }

    public static function nowUtc(?DateTimeImmutable $now = null): DateTimeImmutable
    {
        return ($now ?? new DateTimeImmutable('now', new DateTimeZone('UTC')))
            ->setTimezone(new DateTimeZone('UTC'));
    }

    public static function formatUtc(DateTimeImmutable $dt): string
    {
        return $dt->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d\TH:i:s\Z');
    }

    public static function cutoffUtc(int $days = self::RETENTION_DAYS, ?DateTimeImmutable $now = null): string
    {
        $clampedDays = max(1, min(self::RETENTION_DAYS, $days));
        return self::formatUtc(self::nowUtc($now)->sub(new DateInterval('P' . $clampedDays . 'D')));
    }

    /**
     * 90日を超えた変更履歴を低負荷に物理削除する（呼び出し元のトランザクション内で実行可能）。
     */
    public function pruneExpired(?DateTimeImmutable $now = null): int
    {
        $cutoff = self::cutoffUtc(self::RETENTION_DAYS, $now);
        $stmt = $this->db->prepare('DELETE FROM change_history WHERE occurred_at < :cutoff');
        $stmt->execute([':cutoff' => $cutoff]);
        return $stmt->rowCount();
    }

    /**
     * 保存処理の前後比較に必要な論理スナップショットを取得する。
     *
     * @param int[]|null $deviceIds nullの場合は全機器、配列の場合は対象機器のみ詳細取得（空配列なら詳細なし）
     * @param int[]|null $viewIds nullの場合は全ビュー、配列の場合は対象ビューのみ詳細取得（空配列なら詳細なし）
     */
    public function captureSnapshot(?array $deviceIds = null, ?array $viewIds = null): array
    {
        $deviceNames = [];
        foreach ($this->db->query('SELECT id, name FROM devices ORDER BY id')->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $deviceNames[(int)$row['id']] = (string)$row['name'];
        }

        $viewMeta = [];
        foreach ($this->db->query('SELECT id, name, view_type FROM views ORDER BY id')->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $viewMeta[(int)$row['id']] = [
                'name' => (string)$row['name'],
                'view_type' => (string)$row['view_type'],
            ];
        }

        $linkSystems = [];
        foreach ($this->db->query('SELECT id, name FROM link_systems ORDER BY id')->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $linkSystems[(int)$row['id']] = (string)$row['name'];
        }

        $devices = [];
        if ($deviceIds !== []) {
            $where = $deviceIds === null
                ? ''
                : ' WHERE id IN (' . implode(',', array_map('intval', $deviceIds)) . ')';
            $rawDevices = $this->db->query(
                'SELECT id, name, type, ip, facility, floor, location, manufacturer, model,
                        asset_number, serial_number, mac_address, department, maintenance_vendor,
                        install_date, maintenance_expiry, management_scheme, management_port, memo
                 FROM devices' . $where . ' ORDER BY id'
            )->fetchAll(PDO::FETCH_ASSOC);
            $additionalByDevice = (new DeviceIpAddressRepository($this->db))->getByDeviceIds($deviceIds);
            foreach ($rawDevices as $row) {
                $id = (int)$row['id'];
                $additional = [];
                foreach ($additionalByDevice[$id] ?? [] as $ipRow) {
                    $additional[] = [
                        'ip' => (string)$ipRow['ip'],
                        'label' => (string)$ipRow['label'],
                    ];
                }
                $scheme = (string)($row['management_scheme'] ?? '');
                $port = $row['management_port'] !== null ? (int)$row['management_port'] : null;
                $devices[$id] = [
                    'id' => $id,
                    'name' => (string)$row['name'],
                    'type' => (string)$row['type'],
                    'ip' => (string)$row['ip'],
                    'additional_ips' => $additional,
                    'facility' => (string)$row['facility'],
                    'floor' => (string)$row['floor'],
                    'location' => (string)$row['location'],
                    'manufacturer' => (string)$row['manufacturer'],
                    'model' => (string)$row['model'],
                    'asset_number' => (string)$row['asset_number'],
                    'serial_number' => (string)$row['serial_number'],
                    'mac_address' => (string)$row['mac_address'],
                    'department' => (string)($row['department'] ?? ''),
                    'maintenance_vendor' => (string)($row['maintenance_vendor'] ?? ''),
                    'install_date' => (string)($row['install_date'] ?? ''),
                    'maintenance_expiry' => (string)($row['maintenance_expiry'] ?? ''),
                    'management_connection' => $scheme === ''
                        ? ''
                        : ($port !== null ? "{$scheme}:{$port}" : $scheme),
                    'memo' => (string)$row['memo'],
                ];
            }
        }

        $views = [];
        $placementsByView = [];
        $linksByView = [];
        $rackSettings = [];
        $rackMounts = [];
        $rackShelves = [];
        $rackShelfDevices = [];
        $floorRacks = [];

        if ($viewIds !== []) {
            $viewWhere = $viewIds === null
                ? ''
                : ' WHERE id IN (' . implode(',', array_map('intval', $viewIds)) . ')';
            foreach ($this->db->query(
                'SELECT id, name, facility, floor, view_type, sort_order, memo FROM views' . $viewWhere . ' ORDER BY id'
            )->fetchAll(PDO::FETCH_ASSOC) as $row) {
                $id = (int)$row['id'];
                $views[$id] = [
                    'id' => $id,
                    'name' => (string)$row['name'],
                    'facility' => (string)$row['facility'],
                    'floor' => (string)$row['floor'],
                    'view_type' => (string)$row['view_type'],
                    'sort_order' => (int)$row['sort_order'],
                    'memo' => (string)$row['memo'],
                ];
            }

            $subViewWhere = $viewIds === null
                ? ''
                : ' WHERE view_id IN (' . implode(',', array_map('intval', $viewIds)) . ')';

            foreach ($this->db->query(
                'SELECT id, device_id, view_id, x, y FROM device_placements' . $subViewWhere . ' ORDER BY view_id, device_id'
            )->fetchAll(PDO::FETCH_ASSOC) as $row) {
                $vId = (int)$row['view_id'];
                $dId = (int)$row['device_id'];
                $placementsByView[$vId][$dId] = [
                    'id' => (int)$row['id'],
                    'device_id' => $dId,
                    'x' => (float)$row['x'],
                    'y' => (float)$row['y'],
                ];
            }

            foreach ($this->db->query(
                'SELECT id, view_id, from_id, to_id, system_id, label, from_port, to_port, vlan, memo, route_mode, manual_route
                 FROM links' . $subViewWhere . ' ORDER BY view_id, id'
            )->fetchAll(PDO::FETCH_ASSOC) as $row) {
                $vId = (int)$row['view_id'];
                $manualRoute = json_decode((string)$row['manual_route'], true);
                $linksByView[$vId][(int)$row['id']] = [
                    'id' => (int)$row['id'],
                    'from_id' => (int)$row['from_id'],
                    'to_id' => (int)$row['to_id'],
                    'system_id' => $row['system_id'] !== null ? (int)$row['system_id'] : null,
                    'label' => (string)$row['label'],
                    'from_port' => (string)$row['from_port'],
                    'to_port' => (string)$row['to_port'],
                    'vlan' => (string)$row['vlan'],
                    'memo' => (string)$row['memo'],
                    'route_mode' => (string)$row['route_mode'],
                    'manual_route' => is_array($manualRoute) ? $manualRoute : [],
                ];
            }

            // ラック・フロア配置は移設検知のため全体を取得する（件数が少なく高速）
            foreach ($this->db->query('SELECT view_id, total_u, location FROM rack_settings ORDER BY view_id')->fetchAll(PDO::FETCH_ASSOC) as $row) {
                $rackSettings[(int)$row['view_id']] = [
                    'total_u' => (int)$row['total_u'],
                    'location' => (string)$row['location'],
                ];
            }
            foreach ($this->db->query('SELECT device_id, view_id, face, start_u, height_u, width_slot, depth FROM rack_mounts ORDER BY device_id')->fetchAll(PDO::FETCH_ASSOC) as $row) {
                $rackMounts[(int)$row['device_id']] = [
                    'device_id' => (int)$row['device_id'],
                    'view_id' => (int)$row['view_id'],
                    'face' => (string)$row['face'],
                    'start_u' => (int)$row['start_u'],
                    'height_u' => (int)$row['height_u'],
                    'width_slot' => (string)$row['width_slot'],
                    'depth' => (string)$row['depth'],
                ];
            }
            foreach ($this->db->query('SELECT id, view_id, name, face, start_u, height_u, depth FROM rack_shelves ORDER BY id')->fetchAll(PDO::FETCH_ASSOC) as $row) {
                $rackShelves[(int)$row['id']] = [
                    'id' => (int)$row['id'],
                    'view_id' => (int)$row['view_id'],
                    'name' => (string)$row['name'],
                    'face' => (string)$row['face'],
                    'start_u' => (int)$row['start_u'],
                    'height_u' => (int)$row['height_u'],
                    'depth' => (string)$row['depth'],
                ];
            }
            foreach ($this->db->query('SELECT device_id, shelf_id, sort_order FROM rack_shelf_devices ORDER BY shelf_id, sort_order, device_id')->fetchAll(PDO::FETCH_ASSOC) as $row) {
                $rackShelfDevices[(int)$row['device_id']] = [
                    'device_id' => (int)$row['device_id'],
                    'shelf_id' => (int)$row['shelf_id'],
                    'sort_order' => (int)$row['sort_order'],
                ];
            }
            foreach ($this->db->query('SELECT floor_view_id, rack_view_id, x, y FROM floor_rack_placements ORDER BY rack_view_id')->fetchAll(PDO::FETCH_ASSOC) as $row) {
                $floorRacks[(int)$row['rack_view_id']] = [
                    'floor_view_id' => (int)$row['floor_view_id'],
                    'rack_view_id' => (int)$row['rack_view_id'],
                    'x' => (float)$row['x'],
                    'y' => (float)$row['y'],
                ];
            }
        }

        return [
            'device_names' => $deviceNames,
            'view_meta' => $viewMeta,
            'link_systems' => $linkSystems,
            'devices' => $devices,
            'views' => $views,
            'placements_by_view' => $placementsByView,
            'links_by_view' => $linksByView,
            'rack_settings' => $rackSettings,
            'rack_mounts' => $rackMounts,
            'rack_shelves' => $rackShelves,
            'rack_shelf_devices' => $rackShelfDevices,
            'floor_racks' => $floorRacks,
        ];
    }

    /**
     * 変更前スナップショットと現在のDB状態を論理比較し、差分がある場合のみ1保存イベントとして記録する。
     * 呼び出し元のトランザクション内で実行すること。
     *
     * @return int 記録した保存イベントID（実差分がない場合は0）
     */
    public function recordFromSnapshot(
        array $before,
        ?array $afterDeviceIds = null,
        ?array $afterViewIds = null,
        string $source = 'save_resources',
        ?DateTimeImmutable $now = null
    ): int {
        $nowUtc = self::nowUtc($now);
        $this->pruneExpired($nowUtc);

        $after = $this->captureSnapshot($afterDeviceIds, $afterViewIds);
        $entries = $this->buildDiffEntries($before, $after, $source);
        if ($entries === []) {
            return 0;
        }

        $occurredAt = self::formatUtc($nowUtc);
        $requestId = self::truncateText(AuditLog::id() ?? '', 64, false);
        $userId = function_exists('currentUserId') ? currentUserId() : 0;
        $actorUserId = $userId > 0 ? $userId : null;
        $actorName = self::truncateText(function_exists('currentUsername') ? currentUsername() : '', 100, false);

        $insertStmt = $this->db->prepare("
            INSERT INTO change_history (
                event_id, request_id, occurred_at, actor_user_id, actor_name,
                target_type, target_id, target_name, operation, summary, changes_json
            ) VALUES (
                :event_id, :request_id, :occurred_at, :actor_user_id, :actor_name,
                :target_type, :target_id, :target_name, :operation, :summary, :changes_json
            )
        ");

        $eventId = 0;
        foreach ($entries as $index => $entry) {
            $insertStmt->execute([
                ':event_id' => $index === 0 ? 1 : $eventId,
                ':request_id' => $requestId,
                ':occurred_at' => $occurredAt,
                ':actor_user_id' => $actorUserId,
                ':actor_name' => $actorName,
                ':target_type' => $entry['target_type'],
                ':target_id' => $entry['target_id'],
                ':target_name' => $entry['target_name'],
                ':operation' => $entry['operation'],
                ':summary' => $entry['summary'],
                ':changes_json' => $entry['changes_json'],
            ]);
            $insertedId = (int)$this->db->lastInsertId();
            if ($insertedId <= 0 || $insertedId > ResourceId::MAX) {
                throw new ApiException('変更履歴のIDを採番できません', 409, ['reason' => 'id_exhausted']);
            }
            if ($index === 0) {
                $eventId = $insertedId;
                if ($eventId !== 1) {
                    $this->db->prepare('UPDATE change_history SET event_id = :event_id WHERE id = :id')
                        ->execute([':event_id' => $eventId, ':id' => $insertedId]);
                }
            }
        }

        return $eventId;
    }

    /**
     * Config登録・削除のメタ情報を変更履歴に記録する（機密本文・差分は含めない）。
     * 呼び出し元のトランザクション内で実行すること。
     *
     * @param array<int, array{label: string, before: string, after: string}> $items
     */
    public function recordConfigChange(
        int $deviceId,
        string $deviceName,
        string $operation,
        string $summary,
        array $items,
        ?DateTimeImmutable $now = null
    ): int {
        $nowUtc = self::nowUtc($now);
        $this->pruneExpired($nowUtc);

        $occurredAt = self::formatUtc($nowUtc);
        $requestId = self::truncateText(AuditLog::id() ?? '', 64, false);
        $userId = function_exists('currentUserId') ? currentUserId() : 0;
        $actorUserId = $userId > 0 ? $userId : null;
        $actorName = self::truncateText(function_exists('currentUsername') ? currentUsername() : '', 100, false);

        $payload = [
            'source' => 'device_config',
            'items' => array_map(function (array $item): array {
                return [
                    'label' => self::truncateText((string)($item['label'] ?? ''), self::MAX_LABEL_CHARS),
                    'before' => self::truncateText((string)($item['before'] ?? '—'), self::MAX_VALUE_CHARS),
                    'after' => self::truncateText((string)($item['after'] ?? '—'), self::MAX_VALUE_CHARS),
                ];
            }, $items),
        ];

        $json = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
        $cleanName = trim($deviceName) !== '' ? trim($deviceName) : "ID: {$deviceId}";

        $stmt = $this->db->prepare("
            INSERT INTO change_history (
                event_id, request_id, occurred_at, actor_user_id, actor_name,
                target_type, target_id, target_name, operation, summary, changes_json
            ) VALUES (
                1, :request_id, :occurred_at, :actor_user_id, :actor_name,
                'device', :target_id, :target_name, :operation, :summary, :changes_json
            )
        ");
        $stmt->execute([
            ':request_id' => $requestId,
            ':occurred_at' => $occurredAt,
            ':actor_user_id' => $actorUserId,
            ':actor_name' => $actorName,
            ':target_id' => $deviceId,
            ':target_name' => self::truncateText($cleanName, self::MAX_TARGET_NAME_CHARS),
            ':operation' => in_array($operation, ['create', 'update', 'delete'], true) ? $operation : 'update',
            ':summary' => self::truncateText($summary, self::MAX_SUMMARY_CHARS),
            ':changes_json' => $json,
        ]);

        $insertedId = (int)$this->db->lastInsertId();
        if ($insertedId <= 0 || $insertedId > ResourceId::MAX) {
            throw new ApiException('変更履歴のIDを採番できません', 409, ['reason' => 'id_exhausted']);
        }
        if ($insertedId !== 1) {
            $this->db->prepare('UPDATE change_history SET event_id = :event_id WHERE id = :id')
                ->execute([':event_id' => $insertedId, ':id' => $insertedId]);
        }

        return $insertedId;
    }

    /**
     * 管理者向け変更履歴一覧取得（90日以内強制・サーバー側ページング）。
     */
    public function list(array $params, ?DateTimeImmutable $now = null): array
    {
        $nowUtc = self::nowUtc($now);
        $rawDays = $params['days'] ?? (string)self::DEFAULT_PERIOD_DAYS;
        if (!is_scalar($rawDays) || preg_match('/\A[0-9]+\z/', (string)$rawDays) !== 1) {
            throw new ApiException('期間指定が不正です', 400);
        }
        $days = (int)$rawDays;
        if (!in_array($days, self::ALLOWED_PERIOD_DAYS, true)) {
            throw new ApiException('期間は7・30・90日のいずれかで指定してください', 400);
        }

        $targetType = isset($params['target_type']) ? trim((string)$params['target_type']) : '';
        if (!in_array($targetType, ['', 'device', 'view'], true)) {
            throw new ApiException('対象種別の指定が不正です', 400);
        }

        $targetId = null;
        if (isset($params['target_id']) && trim((string)$params['target_id']) !== '') {
            $targetId = ResourceId::parse($params['target_id'], 'target_id');
            if ($targetType === '') {
                throw new ApiException('対象IDを指定する場合は対象種別も指定してください', 400);
            }
        }

        $query = isset($params['q']) ? trim((string)$params['q']) : '';
        if ($query !== '') {
            $this->assertCleanFilterText($query, self::MAX_TARGET_NAME_CHARS, '対象名検索');
        }

        $actor = isset($params['actor']) ? trim((string)$params['actor']) : '';
        if ($actor !== '') {
            $this->assertCleanFilterText($actor, 100, '操作者指定');
        }

        $page = 1;
        if (isset($params['page']) && trim((string)$params['page']) !== '') {
            $rawPage = (string)$params['page'];
            if (preg_match('/\A[1-9][0-9]{0,6}\z/', $rawPage) !== 1) {
                throw new ApiException('ページ番号が不正です', 400);
            }
            $page = (int)$rawPage;
        }

        $perPage = self::DEFAULT_PER_PAGE;
        if (isset($params['per_page']) && trim((string)$params['per_page']) !== '') {
            $rawPerPage = (string)$params['per_page'];
            if (preg_match('/\A[1-9][0-9]{0,2}\z/', $rawPerPage) !== 1) {
                throw new ApiException('表示件数が不正です', 400);
            }
            $perPage = (int)$rawPerPage;
            if ($perPage < 1 || $perPage > self::MAX_PER_PAGE) {
                throw new ApiException('表示件数は1〜100件の範囲で指定してください', 400);
            }
        }

        $retentionCutoff = self::cutoffUtc(self::RETENTION_DAYS, $nowUtc);
        $periodCutoff = self::cutoffUtc($days, $nowUtc);
        $effectiveCutoff = max($retentionCutoff, $periodCutoff);

        $conditions = ['occurred_at >= :cutoff'];
        $binds = [':cutoff' => $effectiveCutoff];

        if ($targetType !== '') {
            $conditions[] = 'target_type = :target_type';
            $binds[':target_type'] = $targetType;
        }
        if ($targetId !== null) {
            $conditions[] = 'target_id = :target_id';
            $binds[':target_id'] = $targetId;
        }
        if ($query !== '') {
            $escaped = strtr(strtolower($query), ['\\' => '\\\\', '%' => '\\%', '_' => '\\_']);
            $conditions[] = "LOWER(target_name) LIKE :query ESCAPE '\\'";
            $binds[':query'] = '%' . $escaped . '%';
        }
        if ($actor !== '') {
            $conditions[] = 'actor_name = :actor';
            $binds[':actor'] = $actor;
        }

        $whereSql = 'WHERE ' . implode(' AND ', $conditions);

        $countStmt = $this->db->prepare("SELECT COUNT(*) FROM change_history {$whereSql}");
        $countStmt->execute($binds);
        $total = (int)$countStmt->fetchColumn();

        $totalPages = max(1, (int)ceil($total / $perPage));
        if ($page > $totalPages) {
            $page = $totalPages;
        }
        $offset = ($page - 1) * $perPage;

        $listStmt = $this->db->prepare("
            SELECT id, event_id, request_id, occurred_at, actor_user_id, actor_name,
                   target_type, target_id, target_name, operation, summary, changes_json
            FROM change_history
            {$whereSql}
            ORDER BY occurred_at DESC, id DESC
            LIMIT :limit OFFSET :offset
        ");
        foreach ($binds as $key => $val) {
            $listStmt->bindValue($key, $val, is_int($val) ? PDO::PARAM_INT : PDO::PARAM_STR);
        }
        $listStmt->bindValue(':limit', $perPage, PDO::PARAM_INT);
        $listStmt->bindValue(':offset', $offset, PDO::PARAM_INT);
        $listStmt->execute();
        $rows = $listStmt->fetchAll(PDO::FETCH_ASSOC);

        $existingDevices = $this->fetchExistingIds('devices', $rows, 'device', $targetType === 'device' ? $targetId : null);
        $existingViews = $this->fetchExistingViews($rows, $targetType === 'view' ? $targetId : null);

        $eventIds = array_values(array_unique(array_map(static fn(array $r): int => (int)$r['event_id'], $rows)));
        $siblingsByEvent = $this->fetchEventSiblings($eventIds, $retentionCutoff);

        $items = [];
        foreach ($rows as $row) {
            $id = (int)$row['id'];
            $eventId = (int)$row['event_id'];
            $type = (string)$row['target_type'];
            $tId = (int)$row['target_id'];
            $decoded = json_decode((string)$row['changes_json'], true);
            $decoded = is_array($decoded) ? $decoded : [];

            $siblings = [];
            $eventSiblings = $siblingsByEvent[$eventId] ?? ['total' => 1, 'targets' => []];
            foreach ($eventSiblings['targets'] as $sibling) {
                if ($sibling['id'] === $id) {
                    continue;
                }
                $siblings[] = $sibling;
                if (count($siblings) === 10) {
                    break;
                }
            }
            $omittedSiblings = max(0, $eventSiblings['total'] - 1 - count($siblings));

            $viewType = $type === 'view'
                ? (string)($decoded['view_type'] ?? ($existingViews[$tId]['view_type'] ?? ''))
                : '';

            $items[] = [
                'id' => $id,
                'event_id' => $eventId,
                'request_id' => (string)$row['request_id'],
                'occurred_at' => (string)$row['occurred_at'],
                'actor_user_id' => $row['actor_user_id'] !== null ? (int)$row['actor_user_id'] : null,
                'actor_name' => (string)$row['actor_name'],
                'target_type' => $type,
                'target_id' => $tId,
                'target_name' => (string)$row['target_name'],
                'target_exists' => $type === 'device' ? isset($existingDevices[$tId]) : isset($existingViews[$tId]),
                'view_type' => $viewType,
                'operation' => (string)$row['operation'],
                'summary' => (string)$row['summary'],
                'items' => array_values(is_array($decoded['items'] ?? null) ? $decoded['items'] : []),
                'omitted_count' => max(0, (int)($decoded['omitted_count'] ?? 0)),
                'related_targets' => $siblings,
                'related_omitted_count' => $omittedSiblings,
            ];
        }

        $actorStmt = $this->db->prepare("
            SELECT DISTINCT actor_name
            FROM change_history
            WHERE occurred_at >= :cutoff AND actor_name <> ''
            ORDER BY actor_name ASC
            LIMIT 200
        ");
        $actorStmt->execute([':cutoff' => $retentionCutoff]);
        $actors = array_values(array_map('strval', $actorStmt->fetchAll(PDO::FETCH_COLUMN)));

        $focusedTarget = null;
        if ($targetType !== '' && $targetId !== null) {
            $focusedTarget = $this->resolveFocusedTarget($targetType, $targetId, $retentionCutoff, $existingDevices, $existingViews);
        }

        return [
            'ok' => true,
            'items' => $items,
            'total' => $total,
            'page' => $page,
            'per_page' => $perPage,
            'total_pages' => $totalPages,
            'days' => $days,
            'actors' => $actors,
            'focused_target' => $focusedTarget,
        ];
    }

    /**
     * バックアップデータの change_history テーブル検証用。
     */
    public static function validateBackupRows(array $rows): array
    {
        $result = [];
        $seenIds = [];
        foreach ($rows as $row) {
            if (!is_array($row)) {
                throw new ApiException('change_historyの行形式が不正です', 400);
            }
            $expectedKeys = [
                'id', 'event_id', 'request_id', 'occurred_at', 'actor_user_id',
                'actor_name', 'target_type', 'target_id', 'target_name',
                'operation', 'summary', 'changes_json',
            ];
            $actualKeys = array_keys($row);
            sort($expectedKeys);
            sort($actualKeys);
            if ($actualKeys !== $expectedKeys) {
                throw new ApiException('change_historyのキー構成が不正です', 400);
            }

            $id = ResourceId::parse($row['id'], 'change_history.id', ResourceId::MAX_RESTORE);
            if (isset($seenIds[$id])) {
                throw new ApiException('change_historyのIDが重複しています', 400);
            }
            $seenIds[$id] = true;

            $eventId = ResourceId::parse($row['event_id'], 'change_history.event_id', ResourceId::MAX_RESTORE);
            $targetId = ResourceId::parse($row['target_id'], 'change_history.target_id', ResourceId::MAX_RESTORE);

            if (!is_string($row['request_id']) || strlen($row['request_id']) > 64 || preg_match('/[\x00-\x1F\x7F]/', $row['request_id']) === 1) {
                throw new ApiException('change_history.request_idが不正です', 400);
            }
            $occurredAt = $row['occurred_at'];
            if (!is_string($occurredAt) || preg_match('/\A\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\z/', $occurredAt) !== 1) {
                throw new ApiException('change_history.occurred_atの日時形式が不正です', 400);
            }
            try {
                $parsed = new DateTimeImmutable($occurredAt, new DateTimeZone('UTC'));
                if ($parsed->format('Y-m-d\TH:i:s\Z') !== $occurredAt) {
                    throw new ApiException('change_history.occurred_atが実在日時ではありません', 400);
                }
            } catch (ApiException $e) {
                throw $e;
            } catch (Throwable) {
                throw new ApiException('change_history.occurred_atの日時形式が不正です', 400);
            }

            $actorUserId = $row['actor_user_id'];
            if ($actorUserId !== null) {
                $actorUserId = ResourceId::parse($actorUserId, 'change_history.actor_user_id', ResourceId::MAX_RESTORE);
            }

            $actorName = self::requireCleanString($row['actor_name'], 'change_history.actor_name', 100, true);
            $targetType = $row['target_type'];
            if (!in_array($targetType, ['device', 'view'], true)) {
                throw new ApiException('change_history.target_typeが不正です', 400);
            }
            $targetName = self::requireCleanString($row['target_name'], 'change_history.target_name', self::MAX_TARGET_NAME_CHARS, false);
            $operation = $row['operation'];
            if (!in_array($operation, ['create', 'update', 'delete'], true)) {
                throw new ApiException('change_history.operationが不正です', 400);
            }
            $summary = self::requireCleanString($row['summary'], 'change_history.summary', self::MAX_SUMMARY_CHARS, false);

            $changesJson = $row['changes_json'];
            if (!is_string($changesJson) || strlen($changesJson) < 2 || strlen($changesJson) > self::MAX_CHANGES_JSON_BYTES || preg_match('//u', $changesJson) !== 1) {
                throw new ApiException('change_history.changes_jsonが不正です', 400);
            }
            try {
                $decoded = json_decode($changesJson, true, 16, JSON_THROW_ON_ERROR);
            } catch (Throwable) {
                throw new ApiException('change_history.changes_jsonのJSON形式が不正です', 400);
            }
            if (!is_array($decoded) || !is_array($decoded['items'] ?? null) || !array_is_list($decoded['items'])) {
                throw new ApiException('change_history.changes_jsonの構造が不正です', 400);
            }
            foreach ($decoded['items'] as $item) {
                if (!is_array($item)
                    || !is_string($item['label'] ?? null)
                    || !is_string($item['before'] ?? null)
                    || !is_string($item['after'] ?? null)) {
                    throw new ApiException('change_history.changes_jsonの差分項目が不正です', 400);
                }
            }

            $result[] = [
                'id' => $id,
                'event_id' => $eventId,
                'request_id' => $row['request_id'],
                'occurred_at' => $occurredAt,
                'actor_user_id' => $actorUserId,
                'actor_name' => $actorName,
                'target_type' => $targetType,
                'target_id' => $targetId,
                'target_name' => $targetName,
                'operation' => $operation,
                'summary' => $summary,
                'changes_json' => $changesJson,
            ];
        }
        usort($result, static fn(array $a, array $b): int => $a['id'] <=> $b['id']);
        return $result;
    }

    private static function requireCleanString(mixed $value, string $field, int $maxChars, bool $allowEmpty): string
    {
        if (!is_string($value) || preg_match('//u', $value) !== 1 || preg_match('/\x00/', $value) === 1) {
            throw new ApiException("{$field}の文字列形式が不正です", 400);
        }
        $length = self::charLength($value);
        if ((!$allowEmpty && trim($value) === '') || $length > $maxChars) {
            throw new ApiException("{$field}の長さが不正です", 400);
        }
        return $value;
    }

    private function assertCleanFilterText(string $value, int $maxChars, string $label): void
    {
        if (preg_match('//u', $value) !== 1 || preg_match('/[\x00-\x1F\x7F]/u', $value) === 1) {
            throw new ApiException("{$label}に使用できない文字が含まれています", 400);
        }
        if (self::charLength($value) > $maxChars) {
            throw new ApiException("{$label}は{$maxChars}文字以内で指定してください", 400);
        }
    }

    private function fetchExistingIds(string $table, array $rows, string $type, ?int $extraId): array
    {
        $ids = [];
        foreach ($rows as $row) {
            if ($row['target_type'] === $type) {
                $ids[(int)$row['target_id']] = true;
            }
        }
        if ($extraId !== null) {
            $ids[$extraId] = true;
        }
        if ($ids === []) {
            return [];
        }
        $in = implode(',', array_map('intval', array_keys($ids)));
        $found = [];
        foreach ($this->db->query("SELECT id, name FROM {$table} WHERE id IN ({$in})")->fetchAll(PDO::FETCH_ASSOC) as $r) {
            $found[(int)$r['id']] = (string)$r['name'];
        }
        return $found;
    }

    private function fetchExistingViews(array $rows, ?int $extraId): array
    {
        $ids = [];
        foreach ($rows as $row) {
            if ($row['target_type'] === 'view') {
                $ids[(int)$row['target_id']] = true;
            }
        }
        if ($extraId !== null) {
            $ids[$extraId] = true;
        }
        if ($ids === []) {
            return [];
        }
        $in = implode(',', array_map('intval', array_keys($ids)));
        $found = [];
        foreach ($this->db->query("SELECT id, name, view_type FROM views WHERE id IN ({$in})")->fetchAll(PDO::FETCH_ASSOC) as $r) {
            $found[(int)$r['id']] = [
                'name' => (string)$r['name'],
                'view_type' => (string)$r['view_type'],
            ];
        }
        return $found;
    }

    private function fetchEventSiblings(array $eventIds, string $cutoff): array
    {
        if ($eventIds === []) {
            return [];
        }
        $in = implode(',', array_map('intval', $eventIds));
        // 自分自身が先頭10件に含まれる場合も10件表示できるよう、各イベントの先頭11件だけ取得する。
        // 件数はSQLで集計し、存在確認のJOINも表示候補に限定する。
        $stmt = $this->db->prepare("
            SELECT ranked.id, ranked.event_id, ranked.target_type, ranked.target_id,
                   ranked.target_name, ranked.operation, ranked.event_total,
                   CASE WHEN ranked.target_type = 'device' THEN devices.id IS NOT NULL
                        ELSE views.id IS NOT NULL END AS target_exists
            FROM (
                SELECT id, event_id, target_type, target_id, target_name, operation,
                       COUNT(*) OVER (PARTITION BY event_id) AS event_total,
                       ROW_NUMBER() OVER (PARTITION BY event_id ORDER BY id ASC) AS event_rank
                FROM change_history
                WHERE event_id IN ({$in}) AND occurred_at >= :cutoff
            ) AS ranked
            LEFT JOIN devices ON ranked.target_type = 'device' AND devices.id = ranked.target_id
            LEFT JOIN views ON ranked.target_type = 'view' AND views.id = ranked.target_id
            WHERE ranked.event_rank <= 11
            ORDER BY ranked.id ASC
        ");
        $stmt->execute([':cutoff' => $cutoff]);

        $grouped = [];
        while ($row = $stmt->fetch(PDO::FETCH_ASSOC)) {
            $eventId = (int)$row['event_id'];
            $grouped[$eventId]['total'] = (int)$row['event_total'];
            $grouped[$eventId]['targets'][] = [
                'id' => (int)$row['id'],
                'target_type' => (string)$row['target_type'],
                'target_id' => (int)$row['target_id'],
                'target_name' => (string)$row['target_name'],
                'target_exists' => (bool)$row['target_exists'],
                'operation' => (string)$row['operation'],
            ];
        }
        return $grouped;
    }

    private function resolveFocusedTarget(
        string $targetType,
        int $targetId,
        string $cutoff,
        array $existingDevices,
        array $existingViews
    ): array {
        if ($targetType === 'device' && isset($existingDevices[$targetId])) {
            return [
                'target_type' => 'device',
                'target_id' => $targetId,
                'target_name' => $existingDevices[$targetId],
                'target_exists' => true,
                'view_type' => '',
            ];
        }
        if ($targetType === 'view' && isset($existingViews[$targetId])) {
            return [
                'target_type' => 'view',
                'target_id' => $targetId,
                'target_name' => $existingViews[$targetId]['name'],
                'target_exists' => true,
                'view_type' => $existingViews[$targetId]['view_type'],
            ];
        }
        $stmt = $this->db->prepare("
            SELECT target_name, changes_json
            FROM change_history
            WHERE target_type = :type AND target_id = :id AND occurred_at >= :cutoff
            ORDER BY occurred_at DESC, id DESC
            LIMIT 1
        ");
        $stmt->execute([':type' => $targetType, ':id' => $targetId, ':cutoff' => $cutoff]);
        $latest = $stmt->fetch(PDO::FETCH_ASSOC);
        $decoded = is_array($latest) ? json_decode((string)$latest['changes_json'], true) : null;
        return [
            'target_type' => $targetType,
            'target_id' => $targetId,
            'target_name' => is_array($latest) ? (string)$latest['target_name'] : "ID: {$targetId}",
            'target_exists' => false,
            'view_type' => is_array($decoded) ? (string)($decoded['view_type'] ?? '') : '',
        ];
    }

    private function buildDiffEntries(array $before, array $after, string $source): array
    {
        $deviceNames = $after['device_names'] + $before['device_names'];
        $viewMeta = $after['view_meta'] + $before['view_meta'];
        $linkSystems = $after['link_systems'] + $before['link_systems'];

        $deletedDeviceIds = [];
        foreach ($before['device_names'] as $dId => $_) {
            if (!isset($after['device_names'][$dId])) {
                $deletedDeviceIds[$dId] = true;
            }
        }
        $deletedViewIds = [];
        foreach ($before['view_meta'] as $vId => $_) {
            if (!isset($after['view_meta'][$vId])) {
                $deletedViewIds[$vId] = true;
            }
        }

        $entries = [];

        $candidateDeviceIds = array_keys($before['devices'] + $after['devices']);
        sort($candidateDeviceIds, SORT_NUMERIC);
        foreach ($candidateDeviceIds as $deviceId) {
            $bDev = $before['devices'][$deviceId] ?? null;
            $aDev = $after['devices'][$deviceId] ?? null;
            $entry = $this->buildDeviceEntry($deviceId, $bDev, $aDev, $before, $viewMeta, $source);
            if ($entry !== null) {
                $entries[] = $entry;
            }
        }

        $beforeResidency = $this->buildRackResidency($before['rack_mounts'], $before['rack_shelves'], $before['rack_shelf_devices']);
        $afterResidency = $this->buildRackResidency($after['rack_mounts'], $after['rack_shelves'], $after['rack_shelf_devices']);

        $candidateViewIds = array_keys($before['views'] + $after['views']);
        sort($candidateViewIds, SORT_NUMERIC);
        foreach ($candidateViewIds as $viewId) {
            $bView = $before['views'][$viewId] ?? null;
            $aView = $after['views'][$viewId] ?? null;
            $entry = $this->buildViewEntry(
                $viewId,
                $bView,
                $aView,
                $before,
                $after,
                $beforeResidency,
                $afterResidency,
                $deviceNames,
                $viewMeta,
                $linkSystems,
                $deletedDeviceIds,
                $deletedViewIds,
                $source
            );
            if ($entry !== null) {
                $entries[] = $entry;
            }
        }

        return $entries;
    }

    private function buildDeviceEntry(
        int $deviceId,
        ?array $bDev,
        ?array $aDev,
        array $before,
        array $viewMeta,
        string $source
    ): ?array {
        $csvPrefix = $source === 'csv_import' ? 'CSV取込で' : '';

        if ($bDev === null && $aDev !== null) {
            $items = [];
            foreach (self::DEVICE_FIELD_LABELS as $field => $label) {
                $raw = $aDev[$field];
                if (!in_array($field, ['name', 'type', 'ip'], true) && ($raw === '' || $raw === [])) {
                    continue;
                }
                $items[] = [
                    'label' => $label,
                    'before' => '—',
                    'after' => $this->formatDeviceFieldValue($field, $raw),
                ];
            }
            $typeLabel = self::DEVICE_TYPE_LABELS[$aDev['type']] ?? $aDev['type'];
            $summary = $csvPrefix . '機器を作成（' . $typeLabel . ($aDev['ip'] !== '' ? ' / ' . $aDev['ip'] : '') . '）';
            return $this->finalizeEntry('device', $deviceId, $aDev['name'], 'create', $summary, $items, $source);
        }

        if ($bDev !== null && $aDev === null) {
            $items = [];
            foreach (self::DEVICE_FIELD_LABELS as $field => $label) {
                $raw = $bDev[$field];
                if (!in_array($field, ['name', 'type', 'ip'], true) && ($raw === '' || $raw === [])) {
                    continue;
                }
                $items[] = [
                    'label' => $label,
                    'before' => $this->formatDeviceFieldValue($field, $raw),
                    'after' => '—（削除）',
                ];
            }
            $cascadeImpacts = $this->describeDeletedDeviceViewImpacts($deviceId, $before, $viewMeta);
            if ($cascadeImpacts['text'] !== '') {
                $items[] = [
                    'label' => '関連ビュー影響',
                    'before' => $cascadeImpacts['text'],
                    'after' => '自動削除・解除',
                ];
            }
            $typeLabel = self::DEVICE_TYPE_LABELS[$bDev['type']] ?? $bDev['type'];
            $impactNote = $cascadeImpacts['view_count'] > 0 ? " / 関連{$cascadeImpacts['view_count']}ビューから除去" : '';
            $summary = "機器を削除（{$typeLabel}" . ($bDev['ip'] !== '' ? ' / ' . $bDev['ip'] : '') . "{$impactNote}）";
            return $this->finalizeEntry('device', $deviceId, $bDev['name'], 'delete', $summary, $items, $source);
        }

        if ($bDev === null || $aDev === null) {
            return null;
        }

        $changedItems = [];
        foreach (self::DEVICE_FIELD_LABELS as $field => $label) {
            if ($bDev[$field] === $aDev[$field]) {
                continue;
            }
            $beforeFormatted = $this->formatDeviceFieldValue($field, $bDev[$field]);
            $afterFormatted = $this->formatDeviceFieldValue($field, $aDev[$field]);
            if ($beforeFormatted === $afterFormatted) {
                $afterFormatted .= '（全文更新）';
            }
            $changedItems[] = [
                'label' => $label,
                'before' => $beforeFormatted,
                'after' => $afterFormatted,
            ];
        }

        if ($changedItems === []) {
            return null;
        }

        $labels = array_column($changedItems, 'label');
        $head = implode('・', array_slice($labels, 0, 3));
        $rest = count($labels) > 3 ? ' ほか' . (count($labels) - 3) . '項目' : '';
        $summary = $csvPrefix . $head . $rest . 'を変更';

        return $this->finalizeEntry('device', $deviceId, $aDev['name'], 'update', $summary, $changedItems, $source);
    }

    private function describeDeletedDeviceViewImpacts(int $deviceId, array $before, array $viewMeta): array
    {
        $byView = [];
        foreach ($before['placements_by_view'] as $vId => $placements) {
            if (isset($placements[$deviceId])) {
                $byView[$vId]['placements'] = ($byView[$vId]['placements'] ?? 0) + 1;
            }
        }
        foreach ($before['links_by_view'] as $vId => $links) {
            foreach ($links as $link) {
                if ($link['from_id'] === $deviceId || $link['to_id'] === $deviceId) {
                    $byView[$vId]['links'] = ($byView[$vId]['links'] ?? 0) + 1;
                }
            }
        }
        if (isset($before['rack_mounts'][$deviceId])) {
            $vId = $before['rack_mounts'][$deviceId]['view_id'];
            $byView[$vId]['rack'] = '直付け搭載';
        }
        if (isset($before['rack_shelf_devices'][$deviceId])) {
            $shelfId = $before['rack_shelf_devices'][$deviceId]['shelf_id'];
            $vId = $before['rack_shelves'][$shelfId]['view_id'] ?? null;
            if ($vId !== null) {
                $byView[$vId]['rack'] = '棚板搭載';
            }
        }

        if ($byView === []) {
            return ['view_count' => 0, 'text' => ''];
        }

        $parts = [];
        foreach ($byView as $vId => $info) {
            $vName = $viewMeta[$vId]['name'] ?? "ID:{$vId}";
            $sub = [];
            if (!empty($info['placements'])) {
                $sub[] = "配置{$info['placements']}件";
            }
            if (!empty($info['links'])) {
                $sub[] = "接続{$info['links']}件";
            }
            if (!empty($info['rack'])) {
                $sub[] = $info['rack'];
            }
            $parts[] = "「{$vName}」(" . implode('・', $sub) . ')';
        }
        $shown = array_slice($parts, 0, 3);
        $suffix = count($parts) > 3 ? ' ほか' . (count($parts) - 3) . 'ビュー' : '';
        return [
            'view_count' => count($byView),
            'text' => implode('、', $shown) . $suffix,
        ];
    }

    private function buildViewEntry(
        int $viewId,
        ?array $bView,
        ?array $aView,
        array $before,
        array $after,
        array $beforeResidency,
        array $afterResidency,
        array $deviceNames,
        array $viewMeta,
        array $linkSystems,
        array $deletedDeviceIds,
        array $deletedViewIds,
        string $source
    ): ?array {
        if ($bView === null && $aView !== null) {
            return $this->buildViewCreateEntry($viewId, $aView, $after, $afterResidency, $source);
        }
        if ($bView !== null && $aView === null) {
            return $this->buildViewDeleteEntry($viewId, $bView, $before, $beforeResidency, $viewMeta, $source);
        }
        if ($bView === null || $aView === null) {
            return null;
        }

        $items = [];
        $summaryParts = [];
        $omittedTotal = 0;

        // 1. ビュー主要設定・ラック設定
        $settingLabels = [];
        foreach (self::VIEW_FIELD_LABELS as $field => $label) {
            if ($bView[$field] === $aView[$field]) {
                continue;
            }
            $bVal = $this->formatViewFieldValue($field, $bView[$field]);
            $aVal = $this->formatViewFieldValue($field, $aView[$field]);
            if ($bVal === $aVal) {
                $aVal .= '（全文更新）';
            }
            $items[] = ['label' => $label, 'before' => $bVal, 'after' => $aVal];
            $settingLabels[] = $label;
        }
        if ($aView['view_type'] === 'rack') {
            $bRack = $before['rack_settings'][$viewId] ?? ['total_u' => 42, 'location' => ''];
            $aRack = $after['rack_settings'][$viewId] ?? ['total_u' => 42, 'location' => ''];
            if ($bRack['total_u'] !== $aRack['total_u']) {
                $items[] = ['label' => '総U数', 'before' => $bRack['total_u'] . 'U', 'after' => $aRack['total_u'] . 'U'];
                $settingLabels[] = '総U数';
            }
            if ($bRack['location'] !== $aRack['location']) {
                $items[] = [
                    'label' => '設置場所',
                    'before' => $bRack['location'] !== '' ? self::truncateText($bRack['location'], self::MAX_VALUE_CHARS) : '—',
                    'after' => $aRack['location'] !== '' ? self::truncateText($aRack['location'], self::MAX_VALUE_CHARS) : '—',
                ];
                $settingLabels[] = '設置場所';
            }
        }
        if ($settingLabels !== []) {
            $head = implode('・', array_slice($settingLabels, 0, 3));
            $rest = count($settingLabels) > 3 ? 'ほか' . (count($settingLabels) - 3) . '項目' : '';
            $summaryParts[] = $head . $rest . 'を変更';
        }

        // 2. 機器配置 (topology / floor)
        $placementDiff = $this->diffPlacements(
            $before['placements_by_view'][$viewId] ?? [],
            $after['placements_by_view'][$viewId] ?? [],
            $deviceNames,
            $deletedDeviceIds
        );
        if ($placementDiff['summary'] !== '') {
            $summaryParts[] = $placementDiff['summary'];
            [$bounded, $omitted] = $this->boundSubcollectionItems($placementDiff['items'], '機器配置');
            array_push($items, ...$bounded);
            $omittedTotal += $omitted;
        }

        // 3. 接続 (topology / floor)
        $linkDiff = $this->diffLinks(
            $before['links_by_view'][$viewId] ?? [],
            $after['links_by_view'][$viewId] ?? [],
            $deviceNames,
            $linkSystems,
            $deletedDeviceIds
        );
        if ($linkDiff['summary'] !== '') {
            $summaryParts[] = $linkDiff['summary'];
            [$bounded, $omitted] = $this->boundSubcollectionItems($linkDiff['items'], '接続');
            array_push($items, ...$bounded);
            $omittedTotal += $omitted;
        }

        // 4. ラック棚板 & ラック搭載機器 (rack)
        if ($aView['view_type'] === 'rack' || $bView['view_type'] === 'rack') {
            $shelfDiff = $this->diffRackShelves(
                $viewId,
                $before['rack_shelves'],
                $after['rack_shelves'],
                $viewMeta
            );
            if ($shelfDiff['summary'] !== '') {
                $summaryParts[] = $shelfDiff['summary'];
                [$bounded, $omitted] = $this->boundSubcollectionItems($shelfDiff['items'], '棚板');
                array_push($items, ...$bounded);
                $omittedTotal += $omitted;
            }

            $mountDiff = $this->diffRackResidency(
                $viewId,
                $beforeResidency,
                $afterResidency,
                $deviceNames,
                $viewMeta,
                $deletedDeviceIds
            );
            if ($mountDiff['summary'] !== '') {
                $summaryParts[] = $mountDiff['summary'];
                [$bounded, $omitted] = $this->boundSubcollectionItems($mountDiff['items'], 'ラック搭載');
                array_push($items, ...$bounded);
                $omittedTotal += $omitted;
            }
        }

        // 5. フロア図上のラック配置 (floor)
        if ($aView['view_type'] === 'floor' || $bView['view_type'] === 'floor') {
            $floorRackDiff = $this->diffFloorRacks(
                $viewId,
                $before['floor_racks'],
                $after['floor_racks'],
                $viewMeta,
                $deletedViewIds
            );
            if ($floorRackDiff['summary'] !== '') {
                $summaryParts[] = $floorRackDiff['summary'];
                [$bounded, $omitted] = $this->boundSubcollectionItems($floorRackDiff['items'], 'ラック配置');
                array_push($items, ...$bounded);
                $omittedTotal += $omitted;
            }
        }

        if ($items === []) {
            return null;
        }

        $summary = implode(' / ', $summaryParts);
        return $this->finalizeEntry(
            'view',
            $viewId,
            $aView['name'],
            'update',
            $summary !== '' ? $summary : 'ビューを更新',
            $items,
            $source,
            $aView['view_type'],
            $omittedTotal
        );
    }

    private function buildViewCreateEntry(int $viewId, array $aView, array $after, array $afterResidency, string $source): array
    {
        $items = [];
        foreach (self::VIEW_FIELD_LABELS as $field => $label) {
            $raw = $aView[$field];
            if (!in_array($field, ['name', 'view_type'], true) && ($raw === '' || ($field === 'sort_order' && $raw === 0))) {
                continue;
            }
            $items[] = [
                'label' => $label,
                'before' => '—',
                'after' => $this->formatViewFieldValue($field, $raw),
            ];
        }

        $extraSummary = [];
        if ($aView['view_type'] === 'rack') {
            $rack = $after['rack_settings'][$viewId] ?? null;
            if ($rack !== null) {
                $items[] = ['label' => '総U数', 'before' => '—', 'after' => $rack['total_u'] . 'U'];
                $extraSummary[] = $rack['total_u'] . 'U';
                if ($rack['location'] !== '') {
                    $items[] = ['label' => '設置場所', 'before' => '—', 'after' => self::truncateText($rack['location'], self::MAX_VALUE_CHARS)];
                }
            }
            $shelfCount = count(array_filter($after['rack_shelves'], static fn(array $s): bool => $s['view_id'] === $viewId));
            $mountCount = count(array_filter($afterResidency, static fn(array $r): bool => $r['view_id'] === $viewId));
            if ($shelfCount > 0) {
                $items[] = ['label' => '棚板', 'before' => '0件', 'after' => "{$shelfCount}件"];
                $extraSummary[] = "棚板{$shelfCount}件";
            }
            if ($mountCount > 0) {
                $items[] = ['label' => '搭載機器', 'before' => '0件', 'after' => "{$mountCount}件"];
                $extraSummary[] = "搭載{$mountCount}件";
            }
        } else {
            $pCount = count($after['placements_by_view'][$viewId] ?? []);
            $lCount = count($after['links_by_view'][$viewId] ?? []);
            $rCount = count(array_filter($after['floor_racks'], static fn(array $r): bool => $r['floor_view_id'] === $viewId));
            if ($pCount > 0) {
                $items[] = ['label' => '機器配置', 'before' => '0件', 'after' => "{$pCount}件"];
                $extraSummary[] = "配置{$pCount}件";
            }
            if ($lCount > 0) {
                $items[] = ['label' => '接続', 'before' => '0件', 'after' => "{$lCount}件"];
                $extraSummary[] = "接続{$lCount}件";
            }
            if ($rCount > 0) {
                $items[] = ['label' => 'ラック配置', 'before' => '0件', 'after' => "{$rCount}件"];
                $extraSummary[] = "ラック配置{$rCount}件";
            }
        }

        $typeLabel = self::VIEW_TYPE_LABELS[$aView['view_type']] ?? $aView['view_type'];
        $detailText = $extraSummary !== [] ? ' / ' . implode('・', $extraSummary) : '';
        $summary = "ビューを作成（{$typeLabel}{$detailText}）";

        return $this->finalizeEntry('view', $viewId, $aView['name'], 'create', $summary, $items, $source, $aView['view_type']);
    }

    private function buildViewDeleteEntry(
        int $viewId,
        array $bView,
        array $before,
        array $beforeResidency,
        array $viewMeta,
        string $source
    ): array {
        $items = [];
        foreach (self::VIEW_FIELD_LABELS as $field => $label) {
            $raw = $bView[$field];
            if (!in_array($field, ['name', 'view_type'], true) && ($raw === '' || ($field === 'sort_order' && $raw === 0))) {
                continue;
            }
            $items[] = [
                'label' => $label,
                'before' => $this->formatViewFieldValue($field, $raw),
                'after' => '—（削除）',
            ];
        }

        $extraSummary = [];
        if ($bView['view_type'] === 'rack') {
            $rack = $before['rack_settings'][$viewId] ?? null;
            if ($rack !== null) {
                $items[] = ['label' => '総U数', 'before' => $rack['total_u'] . 'U', 'after' => '—（削除）'];
                $extraSummary[] = $rack['total_u'] . 'U';
                if ($rack['location'] !== '') {
                    $items[] = ['label' => '設置場所', 'before' => self::truncateText($rack['location'], self::MAX_VALUE_CHARS), 'after' => '—（削除）'];
                }
            }
            $shelfCount = count(array_filter($before['rack_shelves'], static fn(array $s): bool => $s['view_id'] === $viewId));
            $mountCount = count(array_filter($beforeResidency, static fn(array $r): bool => $r['view_id'] === $viewId));
            if ($shelfCount > 0) {
                $items[] = ['label' => '棚板', 'before' => "{$shelfCount}件", 'after' => '—（削除）'];
            }
            if ($mountCount > 0) {
                $items[] = ['label' => '搭載機器', 'before' => "{$mountCount}件", 'after' => '—（削除）'];
            }
            if (isset($before['floor_racks'][$viewId])) {
                $floorId = $before['floor_racks'][$viewId]['floor_view_id'];
                $floorName = $viewMeta[$floorId]['name'] ?? "ID:{$floorId}";
                $items[] = [
                    'label' => 'フロア配置影響',
                    'before' => "フロア「{$floorName}」へ配置中",
                    'after' => '自動配置解除',
                ];
            }
        } else {
            $pCount = count($before['placements_by_view'][$viewId] ?? []);
            $lCount = count($before['links_by_view'][$viewId] ?? []);
            $rCount = count(array_filter($before['floor_racks'], static fn(array $r): bool => $r['floor_view_id'] === $viewId));
            if ($pCount > 0) {
                $items[] = ['label' => '機器配置', 'before' => "{$pCount}件", 'after' => '—（削除）'];
                $extraSummary[] = "配置{$pCount}件";
            }
            if ($lCount > 0) {
                $items[] = ['label' => '接続', 'before' => "{$lCount}件", 'after' => '—（削除）'];
                $extraSummary[] = "接続{$lCount}件";
            }
            if ($rCount > 0) {
                $items[] = ['label' => 'ラック配置', 'before' => "{$rCount}件", 'after' => '—（削除）'];
            }
        }

        $typeLabel = self::VIEW_TYPE_LABELS[$bView['view_type']] ?? $bView['view_type'];
        $detailText = $extraSummary !== [] ? ' / ' . implode('・', $extraSummary) : '';
        $summary = "ビューを削除（{$typeLabel}{$detailText}）";

        return $this->finalizeEntry('view', $viewId, $bView['name'], 'delete', $summary, $items, $source, $bView['view_type']);
    }

    private function diffPlacements(array $beforeMap, array $afterMap, array $deviceNames, array $deletedDeviceIds): array
    {
        $items = [];
        $added = 0;
        $moved = 0;
        $removed = 0;
        $cascadeRemoved = 0;

        $allDeviceIds = array_keys($beforeMap + $afterMap);
        sort($allDeviceIds, SORT_NUMERIC);
        foreach ($allDeviceIds as $dId) {
            $b = $beforeMap[$dId] ?? null;
            $a = $afterMap[$dId] ?? null;
            $dLabel = $this->entityLabel($deviceNames[$dId] ?? null, $dId);
            if ($b === null && $a !== null) {
                $added++;
                $items[] = [
                    'label' => "機器配置: {$dLabel}",
                    'before' => '未配置',
                    'after' => self::formatCoord($a['x'], $a['y']),
                ];
            } elseif ($b !== null && $a === null) {
                if (isset($deletedDeviceIds[$dId])) {
                    $cascadeRemoved++;
                    $items[] = [
                        'label' => "機器配置: {$dLabel}",
                        'before' => self::formatCoord($b['x'], $b['y']),
                        'after' => '機器削除により解除',
                    ];
                } else {
                    $removed++;
                    $items[] = [
                        'label' => "機器配置: {$dLabel}",
                        'before' => self::formatCoord($b['x'], $b['y']),
                        'after' => '未配置',
                    ];
                }
            } elseif ($b !== null && $a !== null) {
                if (abs($b['x'] - $a['x']) > 1e-4 || abs($b['y'] - $a['y']) > 1e-4) {
                    $moved++;
                    $bCoord = self::formatCoord($b['x'], $b['y']);
                    $aCoord = self::formatCoord($a['x'], $a['y']);
                    if ($bCoord === $aCoord) {
                        $aCoord .= '（微調整）';
                    }
                    $items[] = [
                        'label' => "機器配置: {$dLabel}",
                        'before' => $bCoord,
                        'after' => $aCoord,
                    ];
                }
            }
        }

        $parts = [];
        if ($added > 0) { $parts[] = "配置追加{$added}件"; }
        if ($moved > 0) { $parts[] = "座標変更{$moved}件"; }
        if ($removed > 0) { $parts[] = "配置削除{$removed}件"; }
        if ($cascadeRemoved > 0) { $parts[] = "機器削除に伴う配置解除{$cascadeRemoved}件"; }

        return [
            'items' => $items,
            'summary' => implode('・', $parts),
        ];
    }

    private function diffLinks(
        array $beforeLinks,
        array $afterLinks,
        array $deviceNames,
        array $linkSystems,
        array $deletedDeviceIds
    ): array {
        $matchedPairs = [];
        $unmatchedBefore = $beforeLinks;
        $unmatchedAfter = $afterLinks;

        foreach ($beforeLinks as $id => $bLink) {
            if (isset($afterLinks[$id])) {
                $matchedPairs[] = [$bLink, $afterLinks[$id]];
                unset($unmatchedBefore[$id], $unmatchedAfter[$id]);
            }
        }

        // 全体保存等でIDが振り直された場合も、同一ビュー内の端点ペアで論理照合する
        if ($unmatchedBefore !== [] && $unmatchedAfter !== []) {
            $beforeByEndpoints = [];
            foreach ($unmatchedBefore as $id => $bLink) {
                $pairKey = min($bLink['from_id'], $bLink['to_id']) . ':' . max($bLink['from_id'], $bLink['to_id']);
                $beforeByEndpoints[$pairKey] = $id;
            }
            foreach ($unmatchedAfter as $aId => $aLink) {
                $pairKey = min($aLink['from_id'], $aLink['to_id']) . ':' . max($aLink['from_id'], $aLink['to_id']);
                if (isset($beforeByEndpoints[$pairKey])) {
                    $bId = $beforeByEndpoints[$pairKey];
                    $matchedPairs[] = [$unmatchedBefore[$bId], $aLink];
                    unset($unmatchedBefore[$bId], $unmatchedAfter[$aId], $beforeByEndpoints[$pairKey]);
                }
            }
        }

        $items = [];
        $added = 0;
        $updated = 0;
        $removed = 0;
        $cascadeRemoved = 0;

        foreach ($unmatchedAfter as $aLink) {
            $added++;
            $items[] = [
                'label' => '接続: ' . $this->formatLinkPair($aLink, $deviceNames),
                'before' => 'なし',
                'after' => $this->formatLinkState($aLink, $deviceNames, $linkSystems),
            ];
        }

        foreach ($matchedPairs as [$bLink, $aLink]) {
            if ($this->canonicalLinkComparable($bLink) === $this->canonicalLinkComparable($aLink)) {
                continue;
            }
            $updated++;
            $bState = $this->formatLinkState($bLink, $deviceNames, $linkSystems);
            $aState = $this->formatLinkState($aLink, $deviceNames, $linkSystems);
            if ($bState === $aState) {
                $aState .= $bLink['manual_route'] !== $aLink['manual_route'] ? '（経路座標更新）' : '（内容更新）';
            }
            $items[] = [
                'label' => '接続: ' . $this->formatLinkPair($aLink, $deviceNames),
                'before' => $bState,
                'after' => $aState,
            ];
        }

        foreach ($unmatchedBefore as $bLink) {
            $isCascade = isset($deletedDeviceIds[$bLink['from_id']]) || isset($deletedDeviceIds[$bLink['to_id']]);
            if ($isCascade) {
                $cascadeRemoved++;
            } else {
                $removed++;
            }
            $items[] = [
                'label' => '接続: ' . $this->formatLinkPair($bLink, $deviceNames),
                'before' => $this->formatLinkState($bLink, $deviceNames, $linkSystems),
                'after' => $isCascade ? '機器削除により削除' : 'なし',
            ];
        }

        $parts = [];
        if ($added > 0) { $parts[] = "接続追加{$added}件"; }
        if ($updated > 0) { $parts[] = "接続変更{$updated}件"; }
        if ($removed > 0) { $parts[] = "接続削除{$removed}件"; }
        if ($cascadeRemoved > 0) { $parts[] = "機器削除に伴う接続削除{$cascadeRemoved}件"; }

        return [
            'items' => $items,
            'summary' => implode('・', $parts),
        ];
    }

    private function buildRackResidency(array $mounts, array $shelves, array $shelfDevices): array
    {
        $residency = [];
        foreach ($mounts as $dId => $m) {
            $residency[$dId] = [
                'view_id' => $m['view_id'],
                'kind' => 'mount',
                'face' => $m['face'],
                'start_u' => $m['start_u'],
                'height_u' => $m['height_u'],
                'width_slot' => $m['width_slot'],
                'depth' => $m['depth'],
            ];
        }
        foreach ($shelfDevices as $dId => $sd) {
            $shelf = $shelves[$sd['shelf_id']] ?? null;
            if ($shelf === null) {
                continue;
            }
            $residency[$dId] = [
                'view_id' => $shelf['view_id'],
                'kind' => 'shelf',
                'shelf_id' => $sd['shelf_id'],
                'shelf_name' => $shelf['name'],
                'shelf_face' => $shelf['face'],
                'shelf_start_u' => $shelf['start_u'],
                'sort_order' => $sd['sort_order'],
            ];
        }
        return $residency;
    }

    private function diffRackShelves(int $viewId, array $beforeShelves, array $afterShelves, array $viewMeta): array
    {
        $items = [];
        $added = 0;
        $updated = 0;
        $removed = 0;
        $transferredIn = 0;
        $transferredOut = 0;

        $allIds = array_keys($beforeShelves + $afterShelves);
        sort($allIds, SORT_NUMERIC);
        foreach ($allIds as $sId) {
            $b = $beforeShelves[$sId] ?? null;
            $a = $afterShelves[$sId] ?? null;
            $inBefore = $b !== null && $b['view_id'] === $viewId;
            $inAfter = $a !== null && $a['view_id'] === $viewId;
            if (!$inBefore && !$inAfter) {
                continue;
            }

            if (!$inBefore && $inAfter) {
                if ($b !== null && $b['view_id'] !== $viewId) {
                    $transferredIn++;
                    $prevRack = $viewMeta[$b['view_id']]['name'] ?? "ID:{$b['view_id']}";
                    $items[] = [
                        'label' => "棚板: {$a['name']}",
                        'before' => "ラック「{$prevRack}」から移設",
                        'after' => $this->formatShelfState($a),
                    ];
                } else {
                    $added++;
                    $items[] = [
                        'label' => "棚板: {$a['name']}",
                        'before' => 'なし',
                        'after' => $this->formatShelfState($a),
                    ];
                }
            } elseif ($inBefore && !$inAfter) {
                if ($a !== null && $a['view_id'] !== $viewId) {
                    $transferredOut++;
                    $nextRack = $viewMeta[$a['view_id']]['name'] ?? "ID:{$a['view_id']}";
                    $items[] = [
                        'label' => "棚板: {$b['name']}",
                        'before' => $this->formatShelfState($b),
                        'after' => "ラック「{$nextRack}」へ移設",
                    ];
                } else {
                    $removed++;
                    $items[] = [
                        'label' => "棚板: {$b['name']}",
                        'before' => $this->formatShelfState($b),
                        'after' => 'なし',
                    ];
                }
            } elseif ($b !== $a) {
                $updated++;
                $items[] = [
                    'label' => "棚板: {$a['name']}",
                    'before' => ($b['name'] !== $a['name'] ? "「{$b['name']}」 " : '') . $this->formatShelfState($b),
                    'after' => ($b['name'] !== $a['name'] ? "「{$a['name']}」 " : '') . $this->formatShelfState($a),
                ];
            }
        }

        $parts = [];
        if ($added > 0) { $parts[] = "棚板追加{$added}件"; }
        if ($updated > 0) { $parts[] = "棚板変更{$updated}件"; }
        if ($removed > 0) { $parts[] = "棚板削除{$removed}件"; }
        if ($transferredIn > 0) { $parts[] = "棚板搬入{$transferredIn}件"; }
        if ($transferredOut > 0) { $parts[] = "棚板搬出{$transferredOut}件"; }

        return ['items' => $items, 'summary' => implode('・', $parts)];
    }

    private function diffRackResidency(
        int $viewId,
        array $beforeResidency,
        array $afterResidency,
        array $deviceNames,
        array $viewMeta,
        array $deletedDeviceIds
    ): array {
        $items = [];
        $mounted = 0;
        $updated = 0;
        $unmounted = 0;
        $cascadeUnmounted = 0;
        $transferredIn = 0;
        $transferredOut = 0;

        $allDeviceIds = array_keys($beforeResidency + $afterResidency);
        sort($allDeviceIds, SORT_NUMERIC);
        foreach ($allDeviceIds as $dId) {
            $b = $beforeResidency[$dId] ?? null;
            $a = $afterResidency[$dId] ?? null;
            $inBefore = $b !== null && $b['view_id'] === $viewId;
            $inAfter = $a !== null && $a['view_id'] === $viewId;
            if (!$inBefore && !$inAfter) {
                continue;
            }
            $dLabel = $this->entityLabel($deviceNames[$dId] ?? null, $dId);

            if (!$inBefore && $inAfter) {
                if ($b !== null && $b['view_id'] !== $viewId) {
                    $transferredIn++;
                    $prevRack = $viewMeta[$b['view_id']]['name'] ?? "ID:{$b['view_id']}";
                    $items[] = [
                        'label' => "搭載機器: {$dLabel}",
                        'before' => "ラック「{$prevRack}」（" . $this->formatResidency($b) . '）から移設',
                        'after' => $this->formatResidency($a),
                    ];
                } else {
                    $mounted++;
                    $items[] = [
                        'label' => "搭載機器: {$dLabel}",
                        'before' => '未搭載',
                        'after' => $this->formatResidency($a),
                    ];
                }
            } elseif ($inBefore && !$inAfter) {
                if ($a !== null && $a['view_id'] !== $viewId) {
                    $transferredOut++;
                    $nextRack = $viewMeta[$a['view_id']]['name'] ?? "ID:{$a['view_id']}";
                    $items[] = [
                        'label' => "搭載機器: {$dLabel}",
                        'before' => $this->formatResidency($b),
                        'after' => "ラック「{$nextRack}」（" . $this->formatResidency($a) . '）へ移設',
                    ];
                } elseif (isset($deletedDeviceIds[$dId])) {
                    $cascadeUnmounted++;
                    $items[] = [
                        'label' => "搭載機器: {$dLabel}",
                        'before' => $this->formatResidency($b),
                        'after' => '機器削除により解除',
                    ];
                } else {
                    $unmounted++;
                    $items[] = [
                        'label' => "搭載機器: {$dLabel}",
                        'before' => $this->formatResidency($b),
                        'after' => '未搭載',
                    ];
                }
            } elseif ($this->canonicalResidencyComparable($b) !== $this->canonicalResidencyComparable($a)) {
                $updated++;
                $items[] = [
                    'label' => "搭載機器: {$dLabel}",
                    'before' => $this->formatResidency($b),
                    'after' => $this->formatResidency($a),
                ];
            }
        }

        $parts = [];
        if ($mounted > 0) { $parts[] = "機器搭載{$mounted}件"; }
        if ($updated > 0) { $parts[] = "搭載位置・順序変更{$updated}件"; }
        if ($unmounted > 0) { $parts[] = "機器取り外し{$unmounted}件"; }
        if ($transferredIn > 0) { $parts[] = "ラック間移設（搬入{$transferredIn}件）"; }
        if ($transferredOut > 0) { $parts[] = "ラック間移設（搬出{$transferredOut}件）"; }
        if ($cascadeUnmounted > 0) { $parts[] = "機器削除に伴う搭載解除{$cascadeUnmounted}件"; }

        return ['items' => $items, 'summary' => implode('・', $parts)];
    }

    private function diffFloorRacks(
        int $viewId,
        array $beforeFloorRacks,
        array $afterFloorRacks,
        array $viewMeta,
        array $deletedViewIds
    ): array {
        $items = [];
        $placed = 0;
        $moved = 0;
        $unplaced = 0;
        $cascadeUnplaced = 0;
        $transferredIn = 0;
        $transferredOut = 0;

        $allRackIds = array_keys($beforeFloorRacks + $afterFloorRacks);
        sort($allRackIds, SORT_NUMERIC);
        foreach ($allRackIds as $rackId) {
            $b = $beforeFloorRacks[$rackId] ?? null;
            $a = $afterFloorRacks[$rackId] ?? null;
            $inBefore = $b !== null && $b['floor_view_id'] === $viewId;
            $inAfter = $a !== null && $a['floor_view_id'] === $viewId;
            if (!$inBefore && !$inAfter) {
                continue;
            }
            $rLabel = $this->entityLabel($viewMeta[$rackId]['name'] ?? null, $rackId);

            if (!$inBefore && $inAfter) {
                if ($b !== null && $b['floor_view_id'] !== $viewId) {
                    $transferredIn++;
                    $prevFloor = $viewMeta[$b['floor_view_id']]['name'] ?? "ID:{$b['floor_view_id']}";
                    $items[] = [
                        'label' => "ラック配置: {$rLabel}",
                        'before' => "フロア「{$prevFloor}」" . self::formatCoord($b['x'], $b['y']) . ' から移動',
                        'after' => self::formatCoord($a['x'], $a['y']),
                    ];
                } else {
                    $placed++;
                    $items[] = [
                        'label' => "ラック配置: {$rLabel}",
                        'before' => '未配置',
                        'after' => self::formatCoord($a['x'], $a['y']),
                    ];
                }
            } elseif ($inBefore && !$inAfter) {
                if ($a !== null && $a['floor_view_id'] !== $viewId) {
                    $transferredOut++;
                    $nextFloor = $viewMeta[$a['floor_view_id']]['name'] ?? "ID:{$a['floor_view_id']}";
                    $items[] = [
                        'label' => "ラック配置: {$rLabel}",
                        'before' => self::formatCoord($b['x'], $b['y']),
                        'after' => "フロア「{$nextFloor}」" . self::formatCoord($a['x'], $a['y']) . ' へ移動',
                    ];
                } elseif (isset($deletedViewIds[$rackId])) {
                    $cascadeUnplaced++;
                    $items[] = [
                        'label' => "ラック配置: {$rLabel}",
                        'before' => self::formatCoord($b['x'], $b['y']),
                        'after' => 'ラック削除により解除',
                    ];
                } else {
                    $unplaced++;
                    $items[] = [
                        'label' => "ラック配置: {$rLabel}",
                        'before' => self::formatCoord($b['x'], $b['y']),
                        'after' => '未配置',
                    ];
                }
            } elseif (abs($b['x'] - $a['x']) > 1e-4 || abs($b['y'] - $a['y']) > 1e-4) {
                $moved++;
                $bCoord = self::formatCoord($b['x'], $b['y']);
                $aCoord = self::formatCoord($a['x'], $a['y']);
                if ($bCoord === $aCoord) {
                    $aCoord .= '（微調整）';
                }
                $items[] = [
                    'label' => "ラック配置: {$rLabel}",
                    'before' => $bCoord,
                    'after' => $aCoord,
                ];
            }
        }

        $parts = [];
        if ($placed > 0) { $parts[] = "ラック配置{$placed}件"; }
        if ($moved > 0) { $parts[] = "ラック座標変更{$moved}件"; }
        if ($unplaced > 0) { $parts[] = "ラック配置解除{$unplaced}件"; }
        if ($transferredIn > 0) { $parts[] = "フロア間ラック移動（搬入{$transferredIn}件）"; }
        if ($transferredOut > 0) { $parts[] = "フロア間ラック移動（搬出{$transferredOut}件）"; }
        if ($cascadeUnplaced > 0) { $parts[] = "ラック削除に伴う配置解除{$cascadeUnplaced}件"; }

        return ['items' => $items, 'summary' => implode('・', $parts)];
    }

    private function boundSubcollectionItems(array $items, string $categoryLabel): array
    {
        $count = count($items);
        if ($count <= self::MAX_SUBCOLLECTION_ITEMS) {
            return [$items, 0];
        }
        $shown = array_slice($items, 0, self::PREVIEW_SUBCOLLECTION_ITEMS);
        $omitted = $count - self::PREVIEW_SUBCOLLECTION_ITEMS;
        $shown[] = [
            'label' => "{$categoryLabel}（大量変更要約）",
            'before' => "ほか {$omitted}件の対象",
            'after' => "計 {$count}件の変更を集約表示",
        ];
        return [$shown, $omitted];
    }

    private function finalizeEntry(
        string $targetType,
        int $targetId,
        string $targetName,
        string $operation,
        string $summary,
        array $items,
        string $source,
        string $viewType = '',
        int $omittedCount = 0
    ): array {
        $normalizedItems = [];
        foreach ($items as $item) {
            if (count($normalizedItems) >= self::MAX_TOTAL_ITEMS) {
                $omittedCount++;
                continue;
            }
            $normalizedItems[] = [
                'label' => self::truncateText((string)$item['label'], self::MAX_LABEL_CHARS),
                'before' => self::truncateText((string)$item['before'], self::MAX_VALUE_CHARS),
                'after' => self::truncateText((string)$item['after'], self::MAX_VALUE_CHARS),
            ];
        }
        if ($normalizedItems === []) {
            $normalizedItems[] = ['label' => '変更', 'before' => '—', 'after' => '更新'];
        }

        $payload = [
            'source' => $source,
            'items' => $normalizedItems,
        ];
        if ($viewType !== '') {
            $payload['view_type'] = $viewType;
        }
        if ($omittedCount > 0) {
            $payload['omitted_count'] = $omittedCount;
        }

        $json = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
        while (strlen($json) > self::MAX_CHANGES_JSON_BYTES && count($payload['items']) > 1) {
            array_pop($payload['items']);
            $payload['omitted_count'] = ($payload['omitted_count'] ?? 0) + 1;
            $json = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
        }

        $cleanName = trim($targetName) !== '' ? trim($targetName) : "ID: {$targetId}";

        return [
            'target_type' => $targetType,
            'target_id' => $targetId,
            'target_name' => self::truncateText($cleanName, self::MAX_TARGET_NAME_CHARS),
            'operation' => $operation,
            'summary' => self::truncateText($summary, self::MAX_SUMMARY_CHARS),
            'changes_json' => $json,
        ];
    }

    private function formatDeviceFieldValue(string $field, mixed $value): string
    {
        if ($field === 'type') {
            $str = (string)$value;
            return self::DEVICE_TYPE_LABELS[$str] ?? ($str !== '' ? $str : '—');
        }
        if ($field === 'additional_ips') {
            if (!is_array($value) || $value === []) {
                return '—';
            }
            $parts = [];
            foreach ($value as $row) {
                $ip = (string)($row['ip'] ?? '');
                $label = (string)($row['label'] ?? '');
                $parts[] = $label !== '' ? "{$ip} ({$label})" : $ip;
            }
            return self::truncateText(implode(', ', $parts), self::MAX_VALUE_CHARS);
        }
        $str = trim((string)$value);
        return $str === '' ? '—' : self::truncateText($str, self::MAX_VALUE_CHARS);
    }

    private function formatViewFieldValue(string $field, mixed $value): string
    {
        if ($field === 'view_type') {
            $str = (string)$value;
            return self::VIEW_TYPE_LABELS[$str] ?? ($str !== '' ? $str : '—');
        }
        if ($field === 'sort_order') {
            return (string)(int)$value;
        }
        $str = trim((string)$value);
        return $str === '' ? '—' : self::truncateText($str, self::MAX_VALUE_CHARS);
    }

    private function entityLabel(?string $name, int $id): string
    {
        $clean = $name !== null ? trim($name) : '';
        return $clean !== '' ? self::truncateText($clean, 60) . " (ID: {$id})" : "ID: {$id}";
    }

    private function canonicalLinkComparable(array $link): array
    {
        return [
            'from_id' => $link['from_id'],
            'to_id' => $link['to_id'],
            'system_id' => $link['system_id'],
            'label' => $link['label'],
            'from_port' => $link['from_port'],
            'to_port' => $link['to_port'],
            'vlan' => $link['vlan'],
            'memo' => $link['memo'],
            'route_mode' => $link['route_mode'],
            'manual_route' => $link['manual_route'],
        ];
    }

    private function formatLinkPair(array $link, array $deviceNames): string
    {
        $from = $deviceNames[$link['from_id']] ?? "ID:{$link['from_id']}";
        $to = $deviceNames[$link['to_id']] ?? "ID:{$link['to_id']}";
        return self::truncateText($from, 40) . ' ↔ ' . self::truncateText($to, 40);
    }

    private function formatLinkState(array $link, array $deviceNames, array $linkSystems): string
    {
        $from = self::truncateText($deviceNames[$link['from_id']] ?? "ID:{$link['from_id']}", 28);
        $to = self::truncateText($deviceNames[$link['to_id']] ?? "ID:{$link['to_id']}", 28);
        $fromPort = $link['from_port'] !== '' ? "({$link['from_port']})" : '';
        $toPort = $link['to_port'] !== '' ? "({$link['to_port']})" : '';
        $parts = ["{$from}{$fromPort} → {$to}{$toPort}"];
        if ($link['system_id'] !== null) {
            $sysName = $linkSystems[$link['system_id']] ?? "ID:{$link['system_id']}";
            $parts[] = "系統:{$sysName}";
        }
        if ($link['label'] !== '') {
            $parts[] = "ラベル:{$link['label']}";
        }
        if ($link['vlan'] !== '') {
            $parts[] = "VLAN:{$link['vlan']}";
        }
        if ($link['route_mode'] === 'manual') {
            $pts = count($link['manual_route']);
            $parts[] = "手動経路({$pts}点)";
        }
        if ($link['memo'] !== '') {
            $parts[] = '備考:' . self::truncateText($link['memo'], 30);
        }
        return self::truncateText(implode(' / ', $parts), self::MAX_VALUE_CHARS);
    }

    private function formatShelfState(array $shelf): string
    {
        $face = self::FACE_LABELS[$shelf['face']] ?? $shelf['face'];
        $uRange = self::formatURange($shelf['start_u'], $shelf['height_u']);
        $depth = self::DEPTH_LABELS[$shelf['depth']] ?? $shelf['depth'];
        return "{$face} {$uRange} / {$depth}";
    }

    private function canonicalResidencyComparable(array $res): array
    {
        if ($res['kind'] === 'shelf') {
            return [
                'view_id' => $res['view_id'],
                'kind' => 'shelf',
                'shelf_id' => $res['shelf_id'],
                'sort_order' => $res['sort_order'],
            ];
        }
        return [
            'view_id' => $res['view_id'],
            'kind' => 'mount',
            'face' => $res['face'],
            'start_u' => $res['start_u'],
            'height_u' => $res['height_u'],
            'width_slot' => $res['width_slot'],
            'depth' => $res['depth'],
        ];
    }

    private function formatResidency(array $res): string
    {
        if ($res['kind'] === 'shelf') {
            $face = self::FACE_LABELS[$res['shelf_face']] ?? $res['shelf_face'];
            $order = $res['sort_order'] + 1;
            return '棚板「' . self::truncateText($res['shelf_name'], 36) . "」({$face} U{$res['shelf_start_u']}) 順{$order}";
        }
        $face = self::FACE_LABELS[$res['face']] ?? $res['face'];
        $uRange = self::formatURange($res['start_u'], $res['height_u']);
        $slot = self::SLOT_LABELS[$res['width_slot']] ?? $res['width_slot'];
        $depth = self::DEPTH_LABELS[$res['depth']] ?? $res['depth'];
        return "{$face} {$uRange} ({$slot}・{$depth})";
    }

    private static function formatURange(int $startU, int $heightU): string
    {
        if ($heightU <= 1) {
            return "U{$startU} (1U)";
        }
        $endU = $startU + $heightU - 1;
        return "U{$startU}-{$endU} ({$heightU}U)";
    }

    private static function formatCoord(float $x, float $y): string
    {
        $fx = abs($x - round($x)) < 0.05 ? (string)(int)round($x) : number_format($x, 1, '.', '');
        $fy = abs($y - round($y)) < 0.05 ? (string)(int)round($y) : number_format($y, 1, '.', '');
        return "({$fx}, {$fy})";
    }

    private static function charLength(string $text): int
    {
        if (function_exists('mb_strlen')) {
            return mb_strlen($text, 'UTF-8');
        }
        $count = preg_match_all('/./us', $text);
        return $count === false ? strlen($text) : $count;
    }

    private static function truncateText(string $text, int $maxChars, bool $ellipsis = true): string
    {
        if (self::charLength($text) <= $maxChars) {
            return $text;
        }
        $cutLen = $ellipsis ? max(1, $maxChars - 1) : $maxChars;
        if (function_exists('mb_substr')) {
            $sub = mb_substr($text, 0, $cutLen, 'UTF-8');
        } elseif (preg_match('/\A.{' . $cutLen . '}/us', $text, $m) === 1) {
            $sub = $m[0];
        } else {
            $sub = substr($text, 0, $cutLen);
        }
        return $ellipsis ? ($sub . '…') : $sub;
    }
}
