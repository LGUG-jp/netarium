<?php
declare(strict_types=1);

namespace Netarium\Services\Topology;

use PDO;
use PDOException;
use Throwable;
use Netarium\Core\ApiException;
use Netarium\Core\Database;
use Netarium\Core\Request;
use Netarium\Core\ResourceId;
use Netarium\Repositories\AppMetaRepository;
use Netarium\Repositories\DeviceRepository;
use Netarium\Repositories\FloorPlanRepository;
use Netarium\Repositories\DeviceImageRepository;
use Netarium\Repositories\LinkRepository;
use Netarium\Repositories\PlacementRepository;
use Netarium\Repositories\ViewRepository;
use Netarium\Services\FloorPlan\FloorPlanService;
use Netarium\Services\DeviceImage\DeviceImageService;

class TopologyService
{
    private PDO $db;
    private AppMetaRepository $appMetaRepo;
    private DeviceRepository $deviceRepo;
    private ViewRepository $viewRepo;
    private PlacementRepository $placementRepo;
    private LinkRepository $linkRepo;
    private FloorPlanRepository $floorPlanRepo;
    private DeviceImageRepository $deviceImageRepo;

    public function __construct(PDO $db)
    {
        $this->db = $db;
        $this->appMetaRepo = new AppMetaRepository($db);
        $this->deviceRepo = new DeviceRepository($db);
        $this->viewRepo = new ViewRepository($db);
        $this->placementRepo = new PlacementRepository($db);
        $this->linkRepo = new LinkRepository($db);
        $this->floorPlanRepo = new FloorPlanRepository($db);
        $this->deviceImageRepo = new DeviceImageRepository($db);
    }

    /**
     * 構成図データのロード
     */
    public function load(): array
    {
        $ownsTransaction = !$this->db->inTransaction();
        if ($ownsTransaction) {
            $this->db->beginTransaction();
        }
        try {
            $result = $this->readSnapshot();
            if ($ownsTransaction) {
                $this->db->commit();
            }
            return $result;
        } catch (Throwable $e) {
            if ($ownsTransaction && $this->db->inTransaction()) {
                $this->db->rollBack();
            }
            throw $e;
        }
    }

    private function readSnapshot(): array
    {
        $views = $this->viewRepo->getAll();
        $devices = $this->deviceRepo->getAllWithStatus();
        $placements = $this->placementRepo->getAll();
        $links = $this->linkRepo->getAll();
        $canvasNotes = $this->db->query('SELECT * FROM canvas_notes ORDER BY id')->fetchAll(PDO::FETCH_ASSOC);
        $floorPlans = $this->floorPlanRepo->getAll();
        $rawImages = $this->deviceImageRepo->getAll();
        $deviceImages = array_map(static function (array $r): array {
            return [
                'id' => (int)$r['id'],
                'device_id' => (int)$r['device_id'],
                'mime_type' => (string)$r['mime_type'],
                'file_size' => (int)$r['file_size'],
                'image_width' => (int)$r['image_width'],
                'image_height' => (int)$r['image_height'],
                'caption' => (string)$r['caption'],
                'sort_order' => (int)$r['sort_order'],
                'created_at' => (string)$r['created_at'],
                'updated_at' => (string)$r['updated_at'],
                'image_url' => 'device_image.php?image_id=' . (int)$r['id'] . '&v=' . rawurlencode((string)$r['updated_at']) . '&cache_policy=200-1',
            ];
        }, $rawImages);

        /*
         * 構成データのリビジョンと最終保存日時
         */
        $revision = $this->appMetaRepo->getDataRevision();
        $savedAt = $this->appMetaRepo->get('last_saved_at', '');

        /*
         * Ping監視データのリビジョンと
         * 最終監視日時
         */
        $monitorRevision = $this->appMetaRepo->getMonitorRevision();
        $lastMonitoredAt = $this->appMetaRepo->get('last_monitored_at', '');

        return [
            'ok' => true,
            'revision' => $revision,
            'saved_at' => $savedAt !== '' ? $savedAt : null,
            'monitor_revision' => $monitorRevision,
            'last_monitored_at' => $lastMonitoredAt !== '' ? $lastMonitoredAt : null,
            'user' => [
                'id' => currentUserId(),
                'username' => currentUsername(),
                'role' => currentUserRole(),
                'is_admin' => isAdminUser(),
            ],
            'views' => $views,
            'devices' => $devices,
            'placements' => $placements,
            'links' => $links,
            'link_systems' => (new LinkSystemService($this->db))->list()['link_systems'],
            'canvas_notes' => $canvasNotes,
            'floor_plans' => $floorPlans,
            'device_images' => $deviceImages,
        ];
    }

    /**
     * 構成図データの保存
     */
    public function save(array $input, array $config): array
    {
        $requestedRevision = (int)($input['revision'] ?? 0);
        $currentRevision = $this->appMetaRepo->getDataRevision();

        if ($requestedRevision <= 0) {
            throw new ApiException('データリビジョンが指定されていません。画面を再読み込みしてください', 400);
        }

        if ($requestedRevision !== $currentRevision) {
            throw new ApiException('他の利用者または別画面でデータが更新されています。再読み込みしてください', 409);
        }

        [$normalizedViews, $normalizedDevices, $normalizedPlacements, $normalizedLinks, $viewIds, $deviceIds, $normalizedNotes] =
            $this->normalizeTopology($input, $config);
        $newRevision = $requestedRevision + 1;
        $savedAt = null;
        $deletedFloorPlanFiles = [];
        $deletedViewCount = 0;
        $deletedDeviceCount = 0;
        $this->db->beginTransaction();

        try {
            /*
             * data_revisionが画面側の保持値と
             * 一致する場合だけ次の値へ更新する。
             *
             * 同じリビジョンからの保存が重なった場合、
             * 条件を満たした処理だけが保存を継続する。
             */
            $revisionClaimStmt = $this->db->prepare("
                UPDATE app_meta
                SET meta_value = :new_revision
                WHERE meta_key = 'data_revision'
                AND meta_value = :requested_revision
            ");

            $revisionClaimStmt->execute([
                ':new_revision' => (string)$newRevision,
                ':requested_revision' => (string)$requestedRevision,
            ]);

            if ($revisionClaimStmt->rowCount() !== 1) {
                throw new ApiException(
                    '他の利用者または別画面でデータが更新されています。再読み込みしてください',
                    409
                );
            }
            // マスタ削除との競合もwriter取得後に検査し、未知参照を400として返す。
            $systems = array_fill_keys($this->db->query('SELECT id FROM link_systems')->fetchAll(PDO::FETCH_COLUMN), true);
            foreach ($normalizedLinks as $link) {
                LinkSystemService::normalizeSystemId($link['system_id'], $systems);
            }

            // 明示IDの新規挿入では、後続のサーバー採番を最低1件残す。
            // サーバーが採番済みのMAXは既存行の再保存に限って許可する。
            foreach ([
                'views' => $normalizedViews,
                'devices' => $normalizedDevices,
                'device_placements' => $normalizedPlacements,
                'links' => $normalizedLinks,
            ] as $table => $rows) {
                $existingId = $this->db->prepare("SELECT 1 FROM {$table} WHERE id = :id");
                foreach ($rows as $row) {
                    if ($row['id'] <= ResourceId::MAX_RESTORE) {
                        continue;
                    }
                    $existingId->execute([':id' => $row['id']]);
                    if ($existingId->fetchColumn() === false) {
                        throw new ApiException("{$table}.idは" . ResourceId::MAX_RESTORE . '以下で指定してください', 400);
                    }
                }
            }

            // 全体保存でもメモの新規IDはブラウザ値を採用せず、非再利用カウンターで採番する。
            $existingNotes = [];
            foreach ($this->db->query('SELECT id, view_id FROM canvas_notes')->fetchAll(PDO::FETCH_ASSOC) as $note) {
                $existingNotes[(int)$note['id']] = (int)$note['view_id'];
            }
            $noteIdMap = [];
            foreach ($normalizedNotes as &$note) {
                $localId = $note['id'];
                if (($existingNotes[$localId] ?? null) !== $note['view_id']) {
                    $note['id'] = ResourceId::allocate($this->db, 'canvas_notes');
                }
                $noteIdMap[$localId] = $note['id'];
            }
            unset($note);
            /*
             * 今回の保存データに含まれる機器IDを
             * 一時テーブルへ格納する。
             *
             * 後で、ここに存在しない機器を
             * DBから完全削除するために使用する。
             */
            $this->db->exec("
                CREATE TEMP TABLE IF NOT EXISTS save_device_ids (
                    id INTEGER PRIMARY KEY
                )
            ");

            $this->db->exec('DELETE FROM save_device_ids');

            /*
             * 既存機器のうち、保存によってIPが変更される
             * 機器IDを一時的に保持する。
             */
            $this->db->exec("
                CREATE TEMP TABLE IF NOT EXISTS changed_ip_device_ids (
                    id INTEGER PRIMARY KEY
                )
            ");

            $this->db->exec('DELETE FROM changed_ip_device_ids');

            $saveDeviceIdStmt = $this->db->prepare("
                INSERT INTO save_device_ids (id) VALUES (:id)
            ");

            foreach ($normalizedDevices as $device) {
                $saveDeviceIdStmt->execute([':id' => $device['id']]);
            }

            /*
             * views全置換による外部キー連鎖削除から
             * 図面情報を一時的に退避する。
             */
            $this->db->exec("
                CREATE TEMP TABLE IF NOT EXISTS saved_view_floor_plans (
                    view_id INTEGER PRIMARY KEY,
                    stored_name TEXT NOT NULL,
                    original_name TEXT NOT NULL,
                    mime_type TEXT NOT NULL,
                    file_size INTEGER NOT NULL,
                    image_width INTEGER NOT NULL,
                    image_height INTEGER NOT NULL,
                    x REAL NOT NULL,
                    y REAL NOT NULL,
                    scale REAL NOT NULL,
                    opacity REAL NOT NULL,
                    is_visible INTEGER NOT NULL,
                    revision INTEGER NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    sha256 TEXT NOT NULL DEFAULT ''
                )
            ");

            $this->db->exec('DELETE FROM saved_view_floor_plans');

            $this->db->exec("
                INSERT INTO saved_view_floor_plans
                SELECT
                    view_id, stored_name, original_name, mime_type, file_size,
                    image_width, image_height, x, y, scale, opacity,
                    is_visible, revision, created_at, updated_at, sha256
                FROM view_floor_plans
            ");

            /*
             * 外部キー制約を満たす削除順。
             *
             * devicesはここでは削除しない。
             */
            $existingViewIds = $this->db->query("SELECT id FROM views")->fetchAll(PDO::FETCH_COLUMN);
            foreach ($existingViewIds as $existingViewId) {
                if (!isset($viewIds[(int)$existingViewId])) {
                    $deletedViewCount++;
                }
            }

            $this->db->exec('DELETE FROM links');
            $this->db->exec('DELETE FROM device_placements');
            $this->db->exec('DELETE FROM views');
            $viewStmt = $this->db->prepare("
                INSERT INTO views (id, name, facility, floor, view_type, sort_order, memo)
                VALUES (:id, :name, :facility, :floor, :view_type, :sort_order, :memo)
            ");

            foreach ($normalizedViews as $view) {
                $viewStmt->execute([
                    ':id' => $view['id'],
                    ':name' => $view['name'],
                    ':facility' => $view['facility'],
                    ':floor' => $view['floor'],
                    ':view_type' => $view['view_type'],
                    ':sort_order' => $view['sort_order'],
                    ':memo' => $view['memo'],
                ]);
            }

            /*
             * 現在も存在し、種別がfloorのビューだけ
             * 図面情報を復元する。
             */
            $this->db->exec("
                INSERT INTO view_floor_plans (
                    view_id, stored_name, original_name, mime_type, file_size,
                    image_width, image_height, x, y, scale, opacity,
                    is_visible, revision, created_at, updated_at, sha256
                )
                SELECT
                    saved.view_id, saved.stored_name, saved.original_name, saved.mime_type, saved.file_size,
                    saved.image_width, saved.image_height, saved.x, saved.y, saved.scale, saved.opacity,
                    saved.is_visible, saved.revision, saved.created_at, saved.updated_at, saved.sha256
                FROM saved_view_floor_plans AS saved
                INNER JOIN views AS current_view
                    ON current_view.id = saved.view_id
                WHERE current_view.view_type = 'floor'
            ");

            /*
             * 削除されたビュー、またはtopologyへ
             * 変更されたビューの画像ファイルを記録する。
             */
            $deletedFloorPlanFiles = $this->db->query("
                SELECT saved.stored_name
                FROM saved_view_floor_plans AS saved
                LEFT JOIN view_floor_plans AS restored
                    ON restored.view_id = saved.view_id
                WHERE restored.view_id IS NULL
            ")->fetchAll(PDO::FETCH_COLUMN);

            /*
             * devicesを更新する前に、
             * DB内の旧IPと保存データの新IPを比較する。
             *
             * 新規機器はdevicesにまだ存在しないため対象外。
             */
            $changedIpStmt = $this->db->prepare("
                INSERT OR IGNORE INTO changed_ip_device_ids (id)
                SELECT id
                FROM devices
                WHERE id = :id
                AND ip <> :ip
            ");

            foreach ($normalizedDevices as $device) {
                $changedIpStmt->execute([
                    ':id' => $device['id'],
                    ':ip' => $device['ip'],
                ]);
            }

            $deviceStmt = $this->db->prepare("
                INSERT INTO devices (
                    id, name, type, ip, x, y, facility, floor, location,
                    manufacturer, model, asset_number, serial_number, mac_address, memo,
                    management_scheme, management_port, department, maintenance_vendor,
                    install_date, maintenance_expiry
                ) VALUES (
                    :id, :name, :type, :ip, :x, :y, :facility, :floor, :location,
                    :manufacturer, :model, :asset_number, :serial_number, :mac_address, :memo,
                    :management_scheme, :management_port, :department, :maintenance_vendor,
                    :install_date, :maintenance_expiry
                )
                ON CONFLICT(id)
                DO UPDATE SET
                    name = excluded.name,
                    type = excluded.type,
                    ip = excluded.ip,
                    x = excluded.x,
                    y = excluded.y,
                    facility = excluded.facility,
                    floor = excluded.floor,
                    location = excluded.location,
                    manufacturer = excluded.manufacturer,
                    model = excluded.model,
                    asset_number = excluded.asset_number,
                    serial_number = excluded.serial_number,
                    mac_address = excluded.mac_address,
                    memo = excluded.memo,
                    management_scheme = excluded.management_scheme,
                    management_port = excluded.management_port,
                    department = excluded.department,
                    maintenance_vendor = excluded.maintenance_vendor,
                    install_date = excluded.install_date,
                    maintenance_expiry = excluded.maintenance_expiry
            ");
            foreach ($normalizedDevices as $device) {
                $deviceStmt->execute([
                    ':id' => $device['id'],
                    ':name' => $device['name'],
                    ':type' => $device['type'],
                    ':ip' => $device['ip'],
                    ':x' => $device['x'],
                    ':y' => $device['y'],
                    ':facility' => $device['facility'],
                    ':floor' => $device['floor'],
                    ':location' => $device['location'],
                    ':manufacturer' => $device['manufacturer'],
                    ':model' => $device['model'],
                    ':asset_number' => $device['asset_number'],
                    ':serial_number' => $device['serial_number'],
                    ':mac_address' => $device['mac_address'],
                    ':memo' => $device['memo'],
                    ':management_scheme' => $device['management_scheme'],
                    ':management_port' => $device['management_port'],
                    ':department' => $device['department'],
                    ':maintenance_vendor' => $device['maintenance_vendor'],
                    ':install_date' => $device['install_date'],
                    ':maintenance_expiry' => $device['maintenance_expiry'],
                ]);
            }

            /*
             * 不要機器を削除する直前に、
             * 実際に削除される機器の件数を監査用集計として取得する。
             */
            $deletedDeviceCount = (int)$this->db->query("
                SELECT COUNT(*)
                FROM devices
                WHERE id NOT IN (
                    SELECT id
                    FROM save_device_ids
                )
            ")->fetchColumn();

            $deletedImageFiles = $this->db->query("
                SELECT stored_name
                FROM device_images
                WHERE device_id NOT IN (
                    SELECT id
                    FROM save_device_ids
                )
            ")->fetchAll(PDO::FETCH_COLUMN);

            if ($deletedImageFiles !== []) {
                $gcStmt = $this->db->prepare("
                    INSERT OR IGNORE INTO device_image_gc (stored_name, queued_at)
                    VALUES (:stored_name, :queued_at)
                ");
                $now = date(DATE_ATOM);
                foreach ($deletedImageFiles as $file) {
                    $gcStmt->execute([
                        ':stored_name' => $file,
                        ':queued_at' => $now,
                    ]);
                }
            }

            $this->db->exec("
                DELETE FROM devices
                WHERE id NOT IN (
                    SELECT id
                    FROM save_device_ids
                )
            ");
            /*
             * 新規機器の監視状態を作成
             */
            $this->db->exec("
                INSERT OR IGNORE INTO device_monitor_status (
                    device_id, status, last_checked_at, last_response_ms, last_error
                )
                SELECT id, 'unknown', NULL, NULL, NULL
                FROM devices
            ");

            /*
             * IPが変更された既存機器は、
             * 旧IPに対するPing結果を引き継がない。
             */
            $this->db->exec("
                UPDATE device_monitor_status
                SET
                    status = 'unknown',
                    last_checked_at = NULL,
                    last_response_ms = NULL,
                    last_error = NULL
                WHERE device_id IN (
                    SELECT id
                    FROM changed_ip_device_ids
                )
            ");

            /*
             * IP変更により監視状態を初期化した場合は、
             * 監視データのリビジョンも更新する。
             */
            $changedIpCount = (int)$this->db->query("
                SELECT COUNT(*)
                FROM changed_ip_device_ids
            ")->fetchColumn();

            if ($changedIpCount > 0) {
                $this->appMetaRepo->incrementMonitorRevision();
            }

            $placementStmt = $this->db->prepare("
                INSERT INTO device_placements (id, device_id, view_id, x, y)
                VALUES (:id, :device_id, :view_id, :x, :y)
            ");

            foreach ($normalizedPlacements as $placement) {
                $placementStmt->execute([
                    ':id' => $placement['id'],
                    ':device_id' => $placement['device_id'],
                    ':view_id' => $placement['view_id'],
                    ':x' => $placement['x'],
                    ':y' => $placement['y'],
                ]);
            }

            $linkStmt = $this->db->prepare("
                INSERT INTO links (id, view_id, from_id, to_id, system_id, label, from_port, to_port, vlan, memo, route_mode, manual_route)
                VALUES (:id, :view_id, :from_id, :to_id, :system_id, :label, :from_port, :to_port, :vlan, :memo, :route_mode, :manual_route)
            ");

            foreach ($normalizedLinks as $link) {
                $linkStmt->execute([
                    ':id' => $link['id'],
                    ':view_id' => $link['view_id'],
                    ':from_id' => $link['from_id'],
                    ':to_id' => $link['to_id'],
                    ':system_id' => $link['system_id'],
                    ':label' => $link['label'],
                    ':from_port' => $link['from_port'],
                    ':to_port' => $link['to_port'],
                    ':vlan' => $link['vlan'],
                    ':memo' => $link['memo'],
                    ':route_mode' => $link['route_mode'],
                    ':manual_route' => json_encode($link['manual_route'], JSON_THROW_ON_ERROR),
                ]);
            }

            $noteStmt = $this->db->prepare('INSERT INTO canvas_notes (' . implode(', ', CanvasNote::COLUMNS)
                . ') VALUES (:' . implode(', :', CanvasNote::COLUMNS) . ')');
            foreach ($normalizedNotes as $note) {
                $noteStmt->execute($note);
            }

            $savedAt = date(DATE_ATOM);
            $this->appMetaRepo->set('last_saved_at', $savedAt);
            $snapshot = $this->readSnapshot();

            $this->db->commit();
        } catch (Throwable $e) {
            if ($this->db->inTransaction()) {
                $this->db->rollBack();
            }

            if ($e instanceof PDOException && Database::isBusy($e)) {
                throw new ApiException(
                    '現在、別の保存処理が実行されています。少し待ってから再度保存してください',
                    409
                );
            }

            throw $e;
        }

        $floorPlanService = new FloorPlanService($this->db);
        $floorPlanDir = (string)$config['floor_plan_directory'];

        foreach ($deletedFloorPlanFiles as $storedName) {
            $floorPlanService->deleteFloorPlanFile($floorPlanDir, (string)$storedName);
        }

        if (!empty($deletedImageFiles)) {
            (new DeviceImageService($this->db))->processGcQueue($config);
        }

        return array_merge($snapshot, [
            'message' => '保存しました',
            'id_maps' => ['canvas_notes' => (object)$noteIdMap],
            'audit_counts' => [
                'deleted_device_count' => $deletedDeviceCount,
                'deleted_view_count' => $deletedViewCount,
            ],
        ]);
    }

    public function normalizeTopology(array $input, array $config): array
    {
        $views = $input['views'] ?? null;
        $devices = $input['devices'] ?? null;
        $placements = $input['placements'] ?? null;
        $links = $input['links'] ?? null;

        if (!is_array($views)) {
            throw new ApiException('viewsが配列ではありません', 400);
        }

        if (!is_array($devices)) {
            throw new ApiException('devicesが配列ではありません', 400);
        }

        if (!is_array($placements)) {
            throw new ApiException('placementsが配列ではありません', 400);
        }

        if (!is_array($links)) {
            throw new ApiException('linksが配列ではありません', 400);
        }

        $maxViews = max(1, (int)($config['max_views'] ?? 100));
        $maxPlacementsPerView = max(1, (int)($config['max_placements_per_view'] ?? 2000));
        $maxLinksPerView = max(1, (int)($config['max_links_per_view'] ?? 5000));

        if (count($views) < 1) {
            throw new ApiException('ビューを最低1件登録してください', 400);
        }

        if (count($views) > $maxViews) {
            throw new ApiException("ビューは最大{$maxViews}件まで登録できます", 400);
        }

        $allowedViewTypes = ['topology', 'floor'];
        $allowedDeviceTypes = [
            'switch', 'l3_switch', 'router', 'firewall', 'ap', 'server', 'printer', 'other',
        ];

        /*
         * 全データをDBへ書き込む前に検証する。
         */
        $normalizedViews = [];
        $viewIds = [];
        $viewNames = [];

        foreach ($views as $view) {
            if (!is_array($view)) {
                throw new ApiException('views内のデータ形式が不正です', 400);
            }

            $id = ResourceId::parse($view['id'] ?? null, 'ビューID');

            if (isset($viewIds[$id])) {
                throw new ApiException("ビューID {$id} が重複しています", 400);
            }

            $name = Request::normalizeLedgerText($view['name'] ?? '', 100);

            if ($name === '') {
                throw new ApiException("ビューID {$id}: 名称を入力してください", 400);
            }

            $nameKey = function_exists('mb_strtolower')
                ? mb_strtolower($name, 'UTF-8')
                : strtolower($name);

            if (isset($viewNames[$nameKey])) {
                throw new ApiException("ビュー名「{$name}」が重複しています", 400);
            }

            $viewType = (string)($view['view_type'] ?? 'topology');

            if (!in_array($viewType, $allowedViewTypes, true)) {
                throw new ApiException("ビューID {$id}: 種別が不正です", 400);
            }

            $viewIds[$id] = true;
            $viewNames[$nameKey] = true;

            $normalizedViews[] = [
                'id' => $id,
                'name' => $name,
                'facility' => Request::normalizeLedgerText($view['facility'] ?? '', 100),
                'floor' => Request::normalizeLedgerText($view['floor'] ?? '', 50),
                'view_type' => $viewType,
                'sort_order' => (int)($view['sort_order'] ?? 0),
                'memo' => Request::normalizeLedgerText($view['memo'] ?? '', 1000),
            ];
        }

        $normalizedDevices = [];
        $deviceIds = [];

        foreach ($devices as $device) {
            if (!is_array($device)) {
                throw new ApiException('devices内のデータ形式が不正です', 400);
            }

            $id = ResourceId::parse($device['id'] ?? null, '機器ID');

            if (isset($deviceIds[$id])) {
                throw new ApiException("機器ID {$id} が重複しています", 400);
            }

            $name = Request::normalizeLedgerText($device['name'] ?? '', 100);

            if ($name === '') {
                throw new ApiException("機器ID {$id}: 名称を入力してください", 400);
            }

            $type = (string)($device['type'] ?? 'other');

            if (!in_array($type, $allowedDeviceTypes, true)) {
                $type = 'other';
            }

            $ip = trim((string)($device['ip'] ?? ''));

            if ($ip !== '' && !filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4)) {
                throw new ApiException("機器ID {$id}: IPアドレスの形式が不正です", 400);
            }

            /*
             * x/yは互換用として保存する。
             * 座標の正本はplacements側。
             */
            $legacyX = Request::normalizeFiniteNumber($device['x'] ?? 0, 0);
            $legacyY = Request::normalizeFiniteNumber($device['y'] ?? 0, 0);

            $deviceIds[$id] = true;
            $fields = DeviceFields::normalizeAndValidate($device, "機器ID {$id}: ");

            $normalizedDevices[] = [
                'id' => $id,
                'name' => $name,
                'type' => $type,
                'ip' => $ip,
                'x' => max(0, $legacyX),
                'y' => max(0, $legacyY),
                'facility' => Request::normalizeLedgerText($device['facility'] ?? '', 100),
                'floor' => Request::normalizeLedgerText($device['floor'] ?? '', 50),
                'location' => Request::normalizeLedgerText($device['location'] ?? '', 150),
                'manufacturer' => Request::normalizeLedgerText($device['manufacturer'] ?? '', 100),
                'model' => Request::normalizeLedgerText($device['model'] ?? '', 100),
                'asset_number' => Request::normalizeLedgerText($device['asset_number'] ?? '', 100),
                'serial_number' => Request::normalizeLedgerText($device['serial_number'] ?? '', 100),
                'mac_address' => Request::normalizeLedgerText($device['mac_address'] ?? '', 50),
                'memo' => Request::normalizeLedgerText($device['memo'] ?? '', 1000),
                'management_scheme' => $fields['management_scheme'],
                'management_port' => $fields['management_port'],
                'department' => $fields['department'],
                'maintenance_vendor' => $fields['maintenance_vendor'],
                'install_date' => $fields['install_date'],
                'maintenance_expiry' => $fields['maintenance_expiry'],
            ];
        }

        $normalizedPlacements = [];
        $placementIds = [];
        $placementPairs = [];
        $placementCountsByView = [];

        foreach ($placements as $placement) {
            if (!is_array($placement)) {
                throw new ApiException('placements内のデータ形式が不正です', 400);
            }

            $id = ResourceId::parse($placement['id'] ?? null, '配置ID');
            $deviceId = ResourceId::parse($placement['device_id'] ?? null, 'device_id');
            $viewId = ResourceId::parse($placement['view_id'] ?? null, 'view_id');

            if (isset($placementIds[$id])) {
                throw new ApiException("配置ID {$id} が重複しています", 400);
            }

            if (!isset($deviceIds[$deviceId])) {
                throw new ApiException("配置ID {$id}: 機器が存在しません", 400);
            }

            if (!isset($viewIds[$viewId])) {
                throw new ApiException("配置ID {$id}: ビューが存在しません", 400);
            }

            $pairKey = $deviceId . ':' . $viewId;

            if (isset($placementPairs[$pairKey])) {
                throw new ApiException("機器ID {$deviceId} はビューID {$viewId}へ既に配置されています", 400);
            }

            $placementCountsByView[$viewId] = ($placementCountsByView[$viewId] ?? 0) + 1;

            if ($placementCountsByView[$viewId] > $maxPlacementsPerView) {
                throw new ApiException("ビューID {$viewId}の配置数が上限{$maxPlacementsPerView}件を超えています", 400);
            }

            $x = Request::normalizeFiniteNumber($placement['x'] ?? 0, 0);
            $y = Request::normalizeFiniteNumber($placement['y'] ?? 0, 0);

            if ($x < 0 || $y < 0) {
                throw new ApiException("配置ID {$id}: 座標は0以上にしてください", 400);
            }

            $placementIds[$id] = true;
            $placementPairs[$pairKey] = true;

            $normalizedPlacements[] = [
                'id' => $id,
                'device_id' => $deviceId,
                'view_id' => $viewId,
                'x' => $x,
                'y' => $y,
            ];
        }

        $normalizedLinks = [];
        $linkIds = [];
        $linkPairs = [];
        $linkCountsByView = [];
        $systems = array_fill_keys($this->db->query('SELECT id FROM link_systems')->fetchAll(PDO::FETCH_COLUMN), true);

        foreach ($links as $link) {
            if (!is_array($link)) {
                throw new ApiException('links内のデータ形式が不正です', 400);
            }

            $id = ResourceId::parse($link['id'] ?? null, '接続ID');
            $viewId = ResourceId::parse($link['view_id'] ?? null, 'view_id');
            $fromId = ResourceId::parse($link['from_id'] ?? $link['fromId'] ?? null, 'from_id');
            $toId = ResourceId::parse($link['to_id'] ?? $link['toId'] ?? null, 'to_id');

            if (isset($linkIds[$id])) {
                throw new ApiException("接続ID {$id} が重複しています", 400);
            }

            if (!isset($viewIds[$viewId])) {
                throw new ApiException("接続ID {$id}: ビューが存在しません", 400);
            }

            if (!isset($deviceIds[$fromId]) || !isset($deviceIds[$toId])) {
                throw new ApiException("接続ID {$id}: 接続元または接続先の機器が存在しません", 400);
            }

            if ($fromId === $toId) {
                throw new ApiException("接続ID {$id}: 同一機器同士は接続できません", 400);
            }

            if (!isset($placementPairs[$fromId . ':' . $viewId]) || !isset($placementPairs[$toId . ':' . $viewId])) {
                throw new ApiException("接続ID {$id}: 両端の機器を同じビューへ配置してください", 400);
            }

            $pairIds = [$fromId, $toId];
            sort($pairIds, SORT_NUMERIC);
            $pairKey = $viewId . ':' . $pairIds[0] . ':' . $pairIds[1];

            if (isset($linkPairs[$pairKey])) {
                throw new ApiException("接続ID {$id}: 同じビュー内で接続が重複しています", 400);
            }

            $linkCountsByView[$viewId] = ($linkCountsByView[$viewId] ?? 0) + 1;

            if ($linkCountsByView[$viewId] > $maxLinksPerView) {
                throw new ApiException("ビューID {$viewId}の接続数が上限{$maxLinksPerView}件を超えています", 400);
            }

            $linkIds[$id] = true;
            $linkPairs[$pairKey] = true;

            $route = LinkRoute::normalize($link);
            $normalizedLinks[] = [
                'id' => $id,
                'view_id' => $viewId,
                'from_id' => $fromId,
                'to_id' => $toId,
                'system_id' => LinkSystemService::normalizeSystemId($link['system_id'] ?? null, $systems),
                'label' => Request::normalizeLedgerText($link['label'] ?? '', 100),
                'from_port' => Request::normalizeLedgerText($link['from_port'] ?? '', 50),
                'to_port' => Request::normalizeLedgerText($link['to_port'] ?? '', 50),
                'vlan' => Request::normalizeLedgerText($link['vlan'] ?? '', 100),
                'memo' => Request::normalizeLedgerText($link['memo'] ?? '', 1000),
                'route_mode' => $route['route_mode'],
                'manual_route' => $route['manual_route'],
            ];
        }
        $normalizedNotes = CanvasNote::normalizeRows($input['canvas_notes'] ?? null, $viewIds);
        return [$normalizedViews, $normalizedDevices, $normalizedPlacements, $normalizedLinks, $viewIds, $deviceIds, $normalizedNotes];
    }
}
