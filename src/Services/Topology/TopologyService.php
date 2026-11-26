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
use Netarium\Repositories\DeviceIpAddressRepository;
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
            'buildings' => $this->db->query('SELECT * FROM buildings ORDER BY sort_order, id')->fetchAll(PDO::FETCH_ASSOC),
            'floors' => $this->db->query('SELECT * FROM floors ORDER BY sort_order, id')->fetchAll(PDO::FETCH_ASSOC),
            'devices' => $devices,
            'placements' => $placements,
            'device_ports' => $this->linkRepo->getDevicePorts(),
            'links' => $this->linkRepo->getAll(),
            'view_link_routes' => $this->linkRepo->getViewLinkRoutes(),
            'legacy_link_conflicts' => $this->linkRepo->getLegacyLinkConflicts(),
            'legacy_link_vlans' => $this->linkRepo->getLegacyLinkVlans(),
            'link_systems' => (new LinkSystemService($this->db))->list()['link_systems'],
            'address_spaces' => (new IpManagementService($this->db))->masters()['address_spaces'],
            'ip_segments' => (new IpManagementService($this->db))->masters()['ip_segments'],
            'canvas_notes' => $canvasNotes,
            'floor_plans' => $floorPlans,
            'rack_settings' => $this->db->query('SELECT * FROM rack_settings ORDER BY view_id')->fetchAll(PDO::FETCH_ASSOC),
            'rack_mounts' => $this->db->query('SELECT * FROM rack_mounts ORDER BY device_id')->fetchAll(PDO::FETCH_ASSOC),
            'rack_shelves' => $this->db->query('SELECT * FROM rack_shelves ORDER BY id')->fetchAll(PDO::FETCH_ASSOC),
            'rack_shelf_devices' => $this->db->query('SELECT * FROM rack_shelf_devices ORDER BY shelf_id, sort_order, device_id')->fetchAll(PDO::FETCH_ASSOC),
            'floor_rack_placements' => $this->db->query('SELECT * FROM floor_rack_placements ORDER BY rack_view_id')->fetchAll(PDO::FETCH_ASSOC),
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

        [$normalizedViews, $normalizedDevices, $normalizedPlacements, $normalizedRoutes, $viewIds, $deviceIds, $normalizedNotes, $normalizedSettings, $normalizedMounts, $normalizedShelves, $normalizedShelfDevices, $normalizedFloorRacks] =
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
            $ipManagement = new IpManagementService($this->db);
            $monitor = new \Netarium\Services\Monitoring\PingReachabilityMonitor($this->db);
            $beforeMonitor = $monitor->snapshot();
            $normalizedDevices = $ipManagement->resolveDevices($normalizedDevices);
            $ipManagement->assertFinal($normalizedDevices);
            foreach ($normalizedDevices as &$device) { unset($device['ip_conflicts_confirmed']); }
            unset($device);
            $existingViews = $this->viewRepo->getAll();
            $existingMembership = array_column($existingViews, 'floor_id', 'id');
            $existingViewsById = array_column($existingViews, null, 'id');
            $inputViews = array_column($input['views'], null, 'id');
            $floors = array_fill_keys($this->db->query('SELECT id FROM floors')->fetchAll(PDO::FETCH_COLUMN), true);
            $existingDevices = array_column($this->deviceRepo->getAllWithStatus(), null, 'id');
            $inputDevices = array_column($input['devices'], null, 'id');
            foreach ($normalizedDevices as &$device) {
                foreach (['floor_id', 'facility', 'floor'] as $field) {
                    if (!array_key_exists($field, $inputDevices[$device['id']])) {
                        $device[$field] = $existingDevices[$device['id']][$field] ?? ($field === 'floor_id' ? null : '');
                    }
                }
                BuildingHierarchyService::normalizeFloorId($device['floor_id'], $floors);
            }
            unset($device);
            foreach ($normalizedViews as &$view) {
                if (!array_key_exists('show_connections', $inputViews[$view['id']])) {
                    $view['show_connections'] = $existingViewsById[$view['id']]['show_connections'] ?? 1;
                }
                if (!array_key_exists('floor_id', $inputViews[$view['id']])) {
                    $view['floor_id'] = $existingMembership[$view['id']] ?? null;
                }
                foreach (['facility', 'floor'] as $field) {
                    if (!array_key_exists($field, $inputViews[$view['id']])) {
                        $view[$field] = $existingViewsById[$view['id']][$field] ?? '';
                    }
                }
                $view['floor_id'] = BuildingHierarchyService::normalizeFloorId($view['floor_id'], $floors);
            }
            unset($view);
            $representatives = $this->db->query('SELECT id, representative_view_id FROM floors WHERE representative_view_id IS NOT NULL')->fetchAll(PDO::FETCH_ASSOC);
            $existingMounts = $this->db->query('SELECT * FROM rack_mounts')->fetchAll(PDO::FETCH_ASSOC);
            $existingShelves = $this->db->query('SELECT * FROM rack_shelves')->fetchAll(PDO::FETCH_ASSOC);
            $existingFloorRacks = $this->db->query('SELECT floor_view_id, rack_view_id FROM floor_rack_placements')->fetchAll(PDO::FETCH_ASSOC);
            if (!array_key_exists('floor_rack_placements', $input) && $existingFloorRacks !== []) {
                throw new ApiException('ラック配置情報が欠落しています。画面を再読み込みしてください', 400);
            }
            FloorRackPlacement::assertNewPairsMatchFloors($normalizedFloorRacks, $existingFloorRacks, $normalizedViews);
            if ((!array_key_exists('rack_shelves', $input) || !array_key_exists('rack_shelf_devices', $input)) && $existingShelves !== []) {
                throw new ApiException('棚板情報が欠落しています。画面を再読み込みしてください', 400);
            }
            $nextShelfIds = array_fill_keys(array_column($normalizedShelves, 'id'), true);
            foreach ($this->db->query('SELECT shelf_id FROM rack_shelf_devices') as $membership) {
                if (!isset($nextShelfIds[$membership['shelf_id']])) {
                    throw new ApiException('機器が残る棚板は削除できません。先に機器を取り外してください', 400);
                }
            }
            if (!array_key_exists('rack_settings', $input) || !array_key_exists('rack_mounts', $input)) {
                if (in_array('rack', array_column($existingViews, 'view_type'), true)) {
                    throw new ApiException('ラック情報が欠落しています。画面を再読み込みしてください', 400);
                }
            }
            RackLayout::assertViewChanges($existingViews, $normalizedViews, array_merge($existingMounts, $existingShelves));
            if (!array_key_exists('view_link_routes', $input)) {
                // Old clients cannot express routes; preserve rows whose view and devices survive.
                $viewTypes = array_column($normalizedViews, 'view_type', 'id');
                foreach ($this->linkRepo->getViewLinkRoutes() as $route) {
                    if (isset($viewTypes[$route['view_id']], $deviceIds[$route['device_a_id']], $deviceIds[$route['device_b_id']])
                        && $viewTypes[$route['view_id']] !== 'rack') {
                        $normalizedRoutes[] = $route;
                    }
                }
            } else {
                $this->assertRoutePairsExist($normalizedRoutes);
            }

            // 明示IDの新規挿入では、後続のサーバー採番を最低1件残す。
            // サーバーが採番済みのMAXは既存行の再保存に限って許可する。
            foreach ([
                'views' => $normalizedViews,
                'devices' => $normalizedDevices,
                'device_placements' => $normalizedPlacements,
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
            $shelfIdMap = [];
            $existingShelfIds = array_column($existingShelves, 'view_id', 'id');
            foreach ($normalizedShelves as &$shelf) {
                $localId = $shelf['id'];
                if ($localId > 0 && !isset($existingShelfIds[$localId])) {
                    throw new ApiException('未知の棚板IDです。画面を再読み込みしてください', 400);
                }
                if (!isset($existingShelfIds[$localId])) {
                    $shelf['id'] = ResourceId::allocate($this->db, 'rack_shelves');
                }
                $shelfIdMap[$localId] = $shelf['id'];
            }
            unset($shelf);
            foreach ($normalizedShelfDevices as &$membership) {
                $membership['shelf_id'] = $shelfIdMap[$membership['shelf_id']];
            }
            unset($membership);
            $changeHistory = new ChangeHistoryService($this->db);
            $beforeHistory = $changeHistory->captureSnapshot();
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
                    rotation REAL NOT NULL,
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
                    image_width, image_height, x, y, scale, opacity, rotation,
                    is_visible, revision, created_at, updated_at, sha256
                FROM view_floor_plans
            ");

            // View-owned rows are rebuilt below. Common links and ports are not view data.
            $existingViewIds = $this->db->query("SELECT id FROM views")->fetchAll(PDO::FETCH_COLUMN);
            foreach ($existingViewIds as $existingViewId) {
                if (!isset($viewIds[(int)$existingViewId])) {
                    $deletedViewCount++;
                }
            }

            $this->db->exec('DELETE FROM device_placements');
            $this->db->exec('DELETE FROM views');
            $viewStmt = $this->db->prepare("
                INSERT INTO views (id, name, facility, floor, view_type, floor_id, sort_order, memo, show_connections)
                VALUES (:id, :name, :facility, :floor, :view_type, :floor_id, :sort_order, :memo, :show_connections)
            ");

            foreach ($normalizedViews as $view) {
                $viewStmt->execute([
                    ':id' => $view['id'],
                    ':name' => $view['name'],
                    ':facility' => $view['facility'],
                    ':floor' => $view['floor'],
                    ':view_type' => $view['view_type'],
                    ':floor_id' => $view['floor_id'],
                    ':sort_order' => $view['sort_order'],
                    ':memo' => $view['memo'],
                    ':show_connections' => $view['show_connections'],
                ]);
            }
            $restoreRepresentative = $this->db->prepare("UPDATE floors SET representative_view_id = :view_id
                WHERE id = :id AND EXISTS (SELECT 1 FROM views WHERE id = :view_id AND floor_id = :id AND view_type = 'floor')");
            foreach ($representatives as $representative) {
                $restoreRepresentative->execute([':id' => $representative['id'], ':view_id' => $representative['representative_view_id']]);
            }

            /*
             * 現在も存在し、種別がfloorのビューだけ
             * 図面情報を復元する。
             */
            $this->db->exec("
                INSERT INTO view_floor_plans (
                    view_id, stored_name, original_name, mime_type, file_size,
                    image_width, image_height, x, y, scale, opacity, rotation,
                    is_visible, revision, created_at, updated_at, sha256
                )
                SELECT
                    saved.view_id, saved.stored_name, saved.original_name, saved.mime_type, saved.file_size,
                    saved.image_width, saved.image_height, saved.x, saved.y, saved.scale, saved.opacity, saved.rotation,
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
                    install_date, maintenance_expiry, ip_segment_id, floor_id
                ) VALUES (
                    :id, :name, :type, :ip, :x, :y, :facility, :floor, :location,
                    :manufacturer, :model, :asset_number, :serial_number, :mac_address, :memo,
                    :management_scheme, :management_port, :department, :maintenance_vendor,
                    :install_date, :maintenance_expiry, :ip_segment_id, :floor_id
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
                    floor_id = excluded.floor_id,
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
                    maintenance_expiry = excluded.maintenance_expiry,
                    ip_segment_id = excluded.ip_segment_id
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
                    ':floor_id' => $device['floor_id'],
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
                    ':ip_segment_id' => $device['ip_segment_id'],
                ]);
                (new DeviceIpAddressRepository($this->db))->saveForDevice(
                    $device['id'], $device['additional_ips'] ?? null, $device['ip']
                );
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
            $this->db->exec('DELETE FROM legacy_link_conflicts WHERE view_id NOT IN (SELECT id FROM views) OR device_a_id NOT IN (SELECT id FROM devices) OR device_b_id NOT IN (SELECT id FROM devices)');
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

            $routeStmt = $this->db->prepare('INSERT INTO view_link_routes (view_id, device_a_id, device_b_id, manual_route)
                VALUES (:view_id, :device_a_id, :device_b_id, :manual_route)');
            foreach ($normalizedRoutes as $route) {
                $route['manual_route'] = json_encode($route['manual_route'], JSON_THROW_ON_ERROR);
                $routeStmt->execute($route);
            }

            $noteStmt = $this->db->prepare('INSERT INTO canvas_notes (' . implode(', ', CanvasNote::COLUMNS)
                . ') VALUES (:' . implode(', :', CanvasNote::COLUMNS) . ')');
            foreach ($normalizedNotes as $note) {
                $noteStmt->execute($note);
            }
            foreach (['rack_settings' => $normalizedSettings, 'rack_mounts' => $normalizedMounts,
                'rack_shelves' => $normalizedShelves, 'rack_shelf_devices' => $normalizedShelfDevices,
                'floor_rack_placements' => $normalizedFloorRacks] as $table => $rows) {
                foreach ($rows as $row) {
                    $fields = array_keys($row);
                    $this->db->prepare("INSERT INTO {$table} (" . implode(', ', $fields)
                        . ') VALUES (:' . implode(', :', $fields) . ')')->execute($row);
                }
            }

            $monitor->reconcile($beforeMonitor, $changedIpCount === 0);
            $savedAt = date(DATE_ATOM);
            $this->appMetaRepo->set('last_saved_at', $savedAt);
            $changeHistory->recordFromSnapshot($beforeHistory, null, null, 'save');
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
            try {
                (new DeviceImageService($this->db))->processGcQueue($config);
            } catch (Throwable $e) {
                error_log('[Netarium Save] Device image GC failed: ' . $e->getMessage());
            }
        }

        return array_merge($snapshot, [
            'message' => '保存しました',
            'id_maps' => ['canvas_notes' => (object)$noteIdMap, 'rack_shelves' => (object)$shelfIdMap],
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

        if (!is_array($views)) {
            throw new ApiException('viewsが配列ではありません', 400);
        }

        if (!is_array($devices)) {
            throw new ApiException('devicesが配列ではありません', 400);
        }

        if (!is_array($placements)) {
            throw new ApiException('placementsが配列ではありません', 400);
        }

        $maxViews = max(1, (int)($config['max_views'] ?? 100));
        $maxPlacementsPerView = max(1, (int)($config['max_placements_per_view'] ?? 2000));

        if (count($views) < 1) {
            throw new ApiException('ビューを最低1件登録してください', 400);
        }

        if (count($views) > $maxViews) {
            throw new ApiException("ビューは最大{$maxViews}件まで登録できます", 400);
        }

        $allowedViewTypes = ['topology', 'floor', 'rack'];
        $allowedDeviceTypes = [
            'switch', 'l3_switch', 'router', 'firewall', 'ap', 'server', 'printer', 'pc', 'other',
        ];

        /*
         * 全データをDBへ書き込む前に検証する。
         */
        $normalizedViews = [];
        $viewIds = [];
        $viewNames = [];
        $floorIds = array_fill_keys($this->db->query('SELECT id FROM floors')->fetchAll(PDO::FETCH_COLUMN), true);

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

            $showConnections = array_key_exists('show_connections', $view) ? $view['show_connections'] : 1;
            if (!in_array($showConnections, [0, 1], true)) {
                throw new ApiException("ビューID {$id}: show_connectionsは0または1を指定してください", 400);
            }
            $viewIds[$id] = $viewType;
            $viewNames[$nameKey] = true;

            $normalizedViews[] = [
                'id' => $id,
                'name' => $name,
                'facility' => DeviceFields::legacyLocation($view['facility'] ?? '', 100),
                'floor' => DeviceFields::legacyLocation($view['floor'] ?? '', 50),
                'view_type' => $viewType,
                'floor_id' => BuildingHierarchyService::normalizeFloorId($view['floor_id'] ?? null, $floorIds),
                'sort_order' => (int)($view['sort_order'] ?? 0),
                'memo' => Request::normalizeLedgerText($view['memo'] ?? '', 1000),
                'show_connections' => $showConnections,
            ];
        }

        $normalizedDevices = [];
        $deviceIds = [];
        $devicesWithAdditionalIps = [];

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
                'floor_id' => BuildingHierarchyService::normalizeFloorId($device['floor_id'] ?? null, $floorIds),
                'facility' => DeviceFields::legacyLocation($device['facility'] ?? '', 100),
                'floor' => DeviceFields::legacyLocation($device['floor'] ?? '', 50),
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
                'additional_ips' => array_key_exists('additional_ips', $device)
                    ? (is_array($device['additional_ips'])
                        ? $device['additional_ips']
                        : throw new ApiException('追加IPは配列で指定してください', 400))
                    : null,
            ];
            if (array_key_exists('ip_segment_id', $device)) {
                $normalizedDevices[array_key_last($normalizedDevices)]['ip_segment_id'] = $device['ip_segment_id'];
            }
            $normalizedDevices[array_key_last($normalizedDevices)]['ip_conflicts_confirmed'] = ($device['ip_conflicts_confirmed'] ?? false) === true;
            if (!empty($device['additional_ips'])) {
                $devicesWithAdditionalIps[$id] = array_key_last($normalizedDevices);
            }
        }
        $existingAdditional = (new DeviceIpAddressRepository($this->db))->getByDeviceIds(array_keys($devicesWithAdditionalIps));
        foreach ($devicesWithAdditionalIps as $id => $index) {
            $device = &$normalizedDevices[$index];
            $device['additional_ips'] = DeviceIpAddressRepository::normalize(
                $device['additional_ips'], $device['ip'], "機器ID {$id}: ",
                array_column($existingAdditional[$id] ?? [], null, 'id')
            );
            unset($device);
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

        $normalizedRoutes = [];
        $routes = array_key_exists('view_link_routes', $input) ? $input['view_link_routes'] : [];
        if (!is_array($routes) || !array_is_list($routes)) {
            throw new ApiException('view_link_routesは配列で指定してください', 400);
        }
        foreach ($routes as $route) {
            if (!is_array($route)) {
                throw new ApiException('view_link_routes内のデータ形式が不正です', 400);
            }
            $viewId = ResourceId::parse($route['view_id'] ?? null, 'view_id');
            $a = ResourceId::parse($route['device_a_id'] ?? null, 'device_a_id');
            $b = ResourceId::parse($route['device_b_id'] ?? null, 'device_b_id');
            if (!isset($viewIds[$viewId]) || $viewIds[$viewId] === 'rack') {
                throw new ApiException("ビューID {$viewId}: 手動経路を保存できません", 400);
            }
            if ($a === $b || !isset($deviceIds[$a], $deviceIds[$b])) {
                throw new ApiException('手動経路の端点機器が不正です', 400);
            }
            $points = LinkRoute::normalize(['route_mode' => 'manual', 'manual_route' => $route['manual_route'] ?? null])['manual_route'];
            $low = min($a, $b);
            $high = max($a, $b);
            $key = "{$viewId}:{$low}:{$high}";
            if (isset($normalizedRoutes[$key])) {
                throw new ApiException("ビューID {$viewId}: 同じ機器ペアの手動経路が重複しています", 400);
            }
            $normalizedRoutes[$key] = [
                'view_id' => $viewId,
                'device_a_id' => $low,
                'device_b_id' => $high,
                'manual_route' => $a < $b ? $points : array_reverse($points),
            ];
        }
        $normalizedNotes = CanvasNote::normalizeRows($input['canvas_notes'] ?? null, $viewIds);
        $settings = $input['rack_settings'] ?? [];
        $mounts = $input['rack_mounts'] ?? [];
        $shelves = array_key_exists('rack_shelves', $input) ? $input['rack_shelves'] : [];
        $shelfDevices = array_key_exists('rack_shelf_devices', $input) ? $input['rack_shelf_devices'] : [];
        if (!is_array($shelves) || !is_array($shelfDevices)) {
            throw new ApiException('棚板情報は配列で指定してください', 400);
        }
        if (!is_array($settings) || !is_array($mounts)) {
            throw new ApiException('ラック情報は配列で指定してください', 400);
        }
        [$normalizedSettings, $normalizedMounts, $normalizedShelves, $normalizedShelfDevices] =
            RackLayout::validate($settings, $mounts, $normalizedViews, $normalizedDevices, $shelves, $shelfDevices, true);
        $rackIds = array_fill_keys(array_column($normalizedSettings, 'view_id'), true);
        foreach (array_merge($normalizedPlacements, $input['floor_plans'] ?? []) as $row) {
            if (isset($rackIds[$row['view_id']])) {
                throw new ApiException('ラックにはXY配置・図面を保存できません', 400);
            }
        }
        $normalizedFloorRacks = FloorRackPlacement::normalizeRows($input['floor_rack_placements'] ?? [], $normalizedViews);
        return [$normalizedViews, $normalizedDevices, $normalizedPlacements, array_values($normalizedRoutes), $viewIds, $deviceIds, $normalizedNotes, $normalizedSettings, $normalizedMounts, $normalizedShelves, $normalizedShelfDevices, $normalizedFloorRacks];
    }

    /** Validate against current connections under the transaction's writer lock. */
    public function assertRoutePairsExist(array $routes): void
    {
        if ($routes === []) {
            return;
        }
        $check = $this->db->prepare('SELECT 1 WHERE EXISTS (
            SELECT 1 FROM links WHERE min(from_id, to_id) = :a AND max(from_id, to_id) = :b
        ) OR EXISTS (
            SELECT 1 FROM legacy_link_conflicts WHERE device_a_id = :a AND device_b_id = :b
        )');
        foreach ($routes as $route) {
            $check->bindValue(':a', $route['device_a_id'], PDO::PARAM_INT);
            $check->bindValue(':b', $route['device_b_id'], PDO::PARAM_INT);
            $check->execute();
            if ($check->fetchColumn() === false) {
                throw new ApiException('手動経路に対応する接続がありません', 400);
            }
        }
    }
}
