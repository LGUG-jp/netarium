<?php
declare(strict_types=1);

namespace Netarium\Services\Topology;

use PDO;
use PDOException;
use Throwable;
use Netarium\Core\ApiException;
use Netarium\Core\Database;
use Netarium\Core\ResourceId;
use Netarium\Repositories\AppMetaRepository;
use Netarium\Repositories\DeviceRepository;
use Netarium\Repositories\DeviceImageRepository;
use Netarium\Services\DeviceImage\DeviceImageService;
use Netarium\Services\FloorPlan\FloorPlanService;

final class ResourceSaveService
{
    private PDO $db;

    public function __construct(PDO $db)
    {
        $this->db = $db;
    }

    public function save(array $input, array $config): array
    {
        $deviceOperations = $this->operations($input['devices'] ?? null, '機器');
        $viewOperations = $this->operations($input['views'] ?? null, 'ビュー');
        $maps = ['devices' => [], 'views' => [], 'placements' => [], 'links' => [], 'canvas_notes' => [], 'rack_shelves' => []];
        $deletedDevices = [];
        $deletedViews = [];
        $affectedViews = [];
        $floorPlanFiles = [];
        $meta = new AppMetaRepository($this->db);
        $placementIds = [];
        $linkIds = [];
        $noteIds = [];
        foreach ($viewOperations as $viewId => $operation) {
            if ($operation['operation'] === 'delete') {
                continue;
            }
            foreach ($operation['placements'] as $row) {
                $row = $this->topologyRow($row, $viewId, '配置');
                $placementIds[(int)$row['id']] = true;
            }
            foreach ($operation['links'] as $row) {
                $row = $this->topologyRow($row, $viewId, '接続');
                $linkIds[(int)$row['id']] = true;
            }
            foreach ($operation['canvas_notes'] as $row) {
                $row = $this->topologyRow($row, $viewId, 'メモ');
                $row['view_id'] = array_key_exists('view_id', $row) ? $row['view_id'] : $viewId;
                $row = CanvasNote::normalize($row);
                $noteIds[$row['id']] = true;
            }
        }

        try {
            $this->db->beginTransaction();
            // Acquire the writer lock before reading resource revisions. busy_timeout remains in effect.
            $this->db->exec("UPDATE resource_sequences SET value = value WHERE name = 'revision'");
            $devices = $this->indexed($this->db->query('SELECT * FROM devices')->fetchAll(PDO::FETCH_ASSOC));
            $views = $this->indexed($this->db->query('SELECT * FROM views')->fetchAll(PDO::FETCH_ASSOC));
            $existingViews = $views;
            $existingSettings = $this->db->query('SELECT * FROM rack_settings ORDER BY view_id')->fetchAll(PDO::FETCH_ASSOC);
            $existingMounts = $this->db->query('SELECT * FROM rack_mounts ORDER BY device_id')->fetchAll(PDO::FETCH_ASSOC);
            $existingShelves = $this->db->query('SELECT * FROM rack_shelves ORDER BY id')->fetchAll(PDO::FETCH_ASSOC);
            $existingShelfDevices = $this->db->query('SELECT * FROM rack_shelf_devices ORDER BY device_id')->fetchAll(PDO::FETCH_ASSOC);
            $existingFloorRacks = $this->db->query('SELECT * FROM floor_rack_placements ORDER BY rack_view_id')->fetchAll(PDO::FETCH_ASSOC);
            // SQLiteのNOCASEに合わせ、退避中も残る既存名（削除予定を含む）を予約する。
            $reservedViewNames = array_fill_keys(array_map('strtolower', array_column($views, 'name')), true);
            $placements = $this->selectRows('device_placements', 'id', array_keys($placementIds));
            $links = $this->selectRows('links', 'id', array_keys($linkIds));
            $existingNotes = $this->indexed($this->selectRows('canvas_notes', 'id', array_keys($noteIds)));
            $conflicts = array_merge(
                $this->revisionConflicts($deviceOperations, $devices, 'devices'),
                $this->revisionConflicts($viewOperations, $views, 'views')
            );
            if ($conflicts !== []) {
                throw new ApiException('保存対象が他の利用者または別画面で更新・削除されています', 409, ['conflicts' => $conflicts]);
            }

            foreach ($deviceOperations as $localId => $operation) {
                $id = $operation['operation'] === 'create' ? $this->allocate('devices') : $localId;
                if ($operation['operation'] === 'create') {
                    $maps['devices'][$localId] = $id;
                }
                if ($operation['operation'] === 'delete') {
                    $deletedDevices[$id] = true;
                    unset($devices[$id]);
                } else {
                    $devices[$id] = array_replace($operation['device'], ['id' => $id]);
                }
            }
            foreach ($viewOperations as $localId => $operation) {
                $id = $operation['operation'] === 'create' ? $this->allocate('views') : $localId;
                if ($operation['operation'] === 'create') {
                    $maps['views'][$localId] = $id;
                }
                $affectedViews[$id] = true;
                if ($operation['operation'] === 'delete') {
                    $deletedViews[$id] = true;
                    unset($views[$id]);
                } else {
                    $views[$id] = array_replace($operation['view'], ['id' => $id]);
                }
            }
            $replacedViews = [];
            foreach ($viewOperations as $localId => $operation) {
                $replacedViews[$maps['views'][$localId] ?? $localId] = true;
            }
            RackLayout::assertViewChanges(array_values($existingViews), array_values($views), array_merge($existingMounts, $existingShelves));
            $floorRacks = [];
            foreach ($existingFloorRacks as $row) {
                if (isset($deletedViews[$row['rack_view_id']])) {
                    $affectedViews[(int)$row['floor_view_id']] = true;
                } elseif (!isset($replacedViews[$row['floor_view_id']])) {
                    $floorRacks[] = $row;
                }
            }
            foreach ($viewOperations as $localId => $operation) {
                if ($operation['operation'] === 'delete') { continue; }
                $viewId = $maps['views'][$localId] ?? $localId;
                $rows = $operation['floor_rack_placements'] ?? null;
                if ($rows === null && !array_key_exists('floor_rack_placements', $operation)
                    && !in_array($viewId, array_column($existingFloorRacks, 'floor_view_id'), true)) {
                    $rows = [];
                }
                if (!is_array($rows) || !array_is_list($rows)) {
                    throw new ApiException('ラック配置の全構成を配列で指定してください', 400);
                }
                foreach ($rows as $row) {
                    if (!is_array($row) || ($row['floor_view_id'] ?? $localId) !== $localId
                        || !is_int($row['rack_view_id'] ?? null)) {
                        throw new ApiException('ラック配置のビュー参照が不正です', 400);
                    }
                    $row['floor_view_id'] = $viewId;
                    $row['rack_view_id'] = $maps['views'][$row['rack_view_id']] ?? $row['rack_view_id'];
                    $floorRacks[] = $row;
                }
            }
            $floorRacks = FloorRackPlacement::normalizeRows($floorRacks, array_values($views));
            $settings = [];
            $mounts = [];
            foreach ($existingSettings as $row) {
                if (!isset($replacedViews[(int)$row['view_id']])) {
                    $settings[] = $row;
                }
            }
            $previousMounts = array_column($existingMounts, null, 'device_id');
            foreach ($existingMounts as $row) {
                if (isset($deletedDevices[(int)$row['device_id']])) {
                    $affectedViews[(int)$row['view_id']] = true;
                } elseif (!isset($replacedViews[(int)$row['view_id']])) {
                    $mounts[] = $row;
                }
            }
            foreach ($viewOperations as $localId => $operation) {
                if ($operation['operation'] === 'delete') {
                    continue;
                }
                $viewId = $maps['views'][$localId] ?? $localId;
                $isRack = ($views[$viewId]['view_type'] ?? 'topology') === 'rack';
                if ($isRack && (!is_array($operation['rack_settings'] ?? null)
                    || !is_array($operation['rack_mounts'] ?? null) || !array_is_list($operation['rack_mounts']))) {
                    throw new ApiException('ラック属性と搭載情報の全構成を指定してください', 400);
                }
                if (!$isRack && (($operation['rack_settings'] ?? null) !== null || ($operation['rack_mounts'] ?? []) !== [])) {
                    throw new ApiException('通常ビューにラック情報は保存できません', 400);
                }
                if (!$isRack) {
                    continue;
                }
                $setting = $operation['rack_settings'];
                if (isset($setting['view_id']) && $setting['view_id'] !== $localId) {
                    throw new ApiException('ラック属性のビュー参照が不正です', 400);
                }
                $setting['view_id'] = $viewId;
                $settings[] = $setting;
                foreach ($operation['rack_mounts'] as $row) {
                    if (!is_array($row) || (isset($row['view_id']) && $row['view_id'] !== $localId)) {
                        throw new ApiException('ラック搭載のビュー参照が不正です', 400);
                    }
                    $deviceId = $row['device_id'] ?? null;
                    if (!is_int($deviceId)) {
                        throw new ApiException('device_idは正の整数で指定してください', 400);
                    }
                    $row['device_id'] = $maps['devices'][$deviceId] ?? $deviceId;
                    $row['view_id'] = $viewId;
                    $previous = $previousMounts[$row['device_id']] ?? null;
                    if ($previous !== null && (int)$previous['view_id'] !== $viewId
                        && !isset($replacedViews[(int)$previous['view_id']])) {
                        throw new ApiException('移設には元・先ラック双方のリビジョン付き更新が必要です', 400);
                    }
                    $mounts[] = $row;
                }
            }
            $shelves = [];
            $shelfDevices = [];
            $previousShelves = array_column($existingShelves, null, 'id');
            $previousLocations = array_column($existingMounts, 'view_id', 'device_id');
            foreach ($existingShelfDevices as $row) {
                $previousLocations[$row['device_id']] = $previousShelves[$row['shelf_id']]['view_id'];
            }
            foreach ($existingShelves as $row) {
                if (!isset($replacedViews[$row['view_id']])) { $shelves[] = $row; }
            }
            foreach ($existingShelfDevices as $row) {
                $owner = $previousShelves[$row['shelf_id']]['view_id'];
                if (isset($deletedDevices[$row['device_id']])) {
                    $affectedViews[$owner] = true;
                } elseif (!isset($replacedViews[$owner])) {
                    $shelfDevices[] = $row;
                }
            }
            foreach ($viewOperations as $localId => $operation) {
                if ($operation['operation'] === 'delete') { continue; }
                $viewId = $maps['views'][$localId] ?? $localId;
                $rows = $operation['rack_shelves'] ?? null;
                $members = $operation['rack_shelf_devices'] ?? null;
                $hasExisting = false;
                foreach ($existingShelves as $row) {
                    if ((int)$row['view_id'] === $viewId) { $hasExisting = true; break; }
                }
                // Legacy clients can save an empty rack, never erase shelves they did not load.
                if (!array_key_exists('rack_shelves', $operation) && !array_key_exists('rack_shelf_devices', $operation) && !$hasExisting) {
                    $rows = []; $members = [];
                }
                if (!is_array($rows) || !array_is_list($rows) || !is_array($members) || !array_is_list($members)) {
                    throw new ApiException('棚板と棚板機器の全構成を指定してください', 400);
                }
                if (($views[$viewId]['view_type'] ?? '') !== 'rack' && ($rows !== [] || $members !== [])) {
                    throw new ApiException('通常ビューに棚板は保存できません', 400);
                }
                $localShelfIds = [];
                foreach ($rows as $row) {
                    if (!is_array($row) || !is_int($row['id'] ?? null) || $row['id'] === 0
                        || abs($row['id']) > ResourceId::MAX || isset($localShelfIds[$row['id']])
                        || (isset($row['view_id']) && $row['view_id'] !== $localId)) {
                        throw new ApiException('棚板ID・ビュー参照が不正です', 400);
                    }
                    $localShelfId = $row['id'];
                    if (isset($maps['rack_shelves'][$localShelfId])) {
                        throw new ApiException('棚板IDが重複しています', 400);
                    }
                    $previous = $previousShelves[$localShelfId] ?? null;
                    if ($localShelfId > 0 && ($previous === null
                        || ((int)$previous['view_id'] !== $viewId && !isset($replacedViews[$previous['view_id']])))) {
                        throw new ApiException('棚板移設には元・先ラック双方のリビジョン付き更新が必要です', 400);
                    }
                    $id = $localShelfId < 0 ? $this->allocate('rack_shelves') : $localShelfId;
                    $maps['rack_shelves'][$localShelfId] = $id;
                    $localShelfIds[$localShelfId] = $id;
                    $row['id'] = $id;
                    $row['view_id'] = $viewId;
                    $shelves[] = $row;
                }
                foreach ($members as $row) {
                    if (!is_array($row) || !is_int($row['device_id'] ?? null) || !is_int($row['shelf_id'] ?? null)
                        || !isset($localShelfIds[$row['shelf_id'] ?? 0])) {
                        throw new ApiException('棚板機器の参照が不正です', 400);
                    }
                    $row['device_id'] = $maps['devices'][$row['device_id']] ?? $row['device_id'];
                    $row['shelf_id'] = $localShelfIds[$row['shelf_id']];
                    $previousView = $previousLocations[$row['device_id']] ?? null;
                    if ($previousView !== null && (int)$previousView !== $viewId && !isset($replacedViews[$previousView])) {
                        throw new ApiException('移設には元・先ラック双方のリビジョン付き更新が必要です', 400);
                    }
                    $shelfDevices[] = $row;
                }
            }
            $nextShelves = array_fill_keys(array_column($shelves, 'id'), true);
            foreach ($existingShelfDevices as $row) {
                if (!isset($nextShelves[$row['shelf_id']])) {
                    throw new ApiException('機器が残る棚板は削除できません。先に機器を取り外してください', 400);
                }
            }
            foreach ($mounts as $row) {
                $previousView = $previousLocations[$row['device_id']] ?? null;
                if ($previousView !== null && (int)$previousView !== (int)$row['view_id'] && !isset($replacedViews[$previousView])) {
                    throw new ApiException('移設には元・先ラック双方のリビジョン付き更新が必要です', 400);
                }
            }

            $placements = array_merge($placements, $this->selectRows('device_placements', 'device_id', array_keys($deletedDevices)));
            $links = array_merge($links,
                $this->selectRows('links', 'from_id', array_keys($deletedDevices)),
                $this->selectRows('links', 'to_id', array_keys($deletedDevices)));
            foreach (array_merge($placements, $links) as $row) {
                if (isset($deletedDevices[(int)($row['device_id'] ?? 0)]) ||
                    isset($deletedDevices[(int)($row['from_id'] ?? 0)]) ||
                    isset($deletedDevices[(int)($row['to_id'] ?? 0)])) {
                    $affectedViews[(int)$row['view_id']] = true;
                }
            }
            $existingPlacements = $this->indexed($placements);
            $existingLinks = $this->indexed($links);
            $placements = [];
            $links = [];
            $notes = [];

            foreach ($viewOperations as $localId => $operation) {
                if ($operation['operation'] === 'delete') {
                    continue;
                }
                $viewId = $maps['views'][$localId] ?? $localId;
                foreach ($operation['placements'] as $row) {
                    $row = $this->topologyRow($row, $localId, '配置');
                    $localPlacementId = (int)$row['id'];
                    if (isset($maps['placements'][$localPlacementId])) {
                        throw new ApiException("配置ID {$localPlacementId} が重複しています", 400);
                    }
                    $id = isset($existingPlacements[$localPlacementId]) && (int)$existingPlacements[$localPlacementId]['view_id'] === $viewId
                        ? $localPlacementId : $this->allocate('placements');
                    $maps['placements'][$localPlacementId] = $id;
                    $row['id'] = $id;
                    $row['view_id'] = $viewId;
                    $deviceId = (int)($row['device_id'] ?? 0);
                    $row['device_id'] = $maps['devices'][$deviceId] ?? $deviceId;
                    $placements[] = $row;
                }
                foreach ($operation['links'] as $row) {
                    $row = $this->topologyRow($row, $localId, '接続');
                    $localLinkId = (int)$row['id'];
                    if (isset($maps['links'][$localLinkId])) {
                        throw new ApiException("接続ID {$localLinkId} が重複しています", 400);
                    }
                    $id = isset($existingLinks[$localLinkId]) && (int)$existingLinks[$localLinkId]['view_id'] === $viewId
                        ? $localLinkId : $this->allocate('links');
                    $maps['links'][$localLinkId] = $id;
                    $row['id'] = $id;
                    $row['view_id'] = $viewId;
                    $fromId = (int)($row['from_id'] ?? $row['fromId'] ?? 0);
                    $toId = (int)($row['to_id'] ?? $row['toId'] ?? 0);
                    $row['from_id'] = $maps['devices'][$fromId] ?? $fromId;
                    $row['to_id'] = $maps['devices'][$toId] ?? $toId;
                    $links[] = $row;
                }
                foreach ($operation['canvas_notes'] as $row) {
                    $row = $this->topologyRow($row, $localId, 'メモ');
                    $localNoteId = $row['id'];
                    if (isset($maps['canvas_notes'][$localNoteId])) {
                        throw new ApiException("メモID {$localNoteId} が重複しています", 400);
                    }
                    $id = isset($existingNotes[$localNoteId]) && (int)$existingNotes[$localNoteId]['view_id'] === $viewId
                        ? $localNoteId : $this->allocate('canvas_notes');
                    $maps['canvas_notes'][$localNoteId] = $id;
                    $row['id'] = $id;
                    $row['view_id'] = $viewId;
                    $notes[] = $row;
                }
            }

            // Validate only changed devices and the devices referenced by changed topology.
            // Unchanged topology is already constrained by SQLite and is not rewritten.
            $validationDeviceIds = [];
            foreach ($deviceOperations as $localId => $operation) {
                if ($operation['operation'] !== 'delete') {
                    $validationDeviceIds[$maps['devices'][$localId] ?? $localId] = true;
                }
            }
            foreach ($placements as $row) {
                $validationDeviceIds[(int)$row['device_id']] = true;
            }
            foreach ($links as $row) {
                $validationDeviceIds[(int)$row['from_id']] = true;
                $validationDeviceIds[(int)$row['to_id']] = true;
            }
            foreach ($mounts as $row) {
                $validationDeviceIds[(int)$row['device_id']] = true;
            }
            foreach ($shelfDevices as $row) {
                $validationDeviceIds[(int)$row['device_id']] = true;
            }
            [$normalizedViews, $normalizedDevices, $normalizedPlacements, $normalizedLinks, , , $normalizedNotes, $normalizedSettings, $normalizedMounts, $normalizedShelves, $normalizedShelfDevices] =
                (new TopologyService($this->db))->normalizeTopology([
                    'views' => array_values($views), 'devices' => array_values(array_intersect_key($devices, $validationDeviceIds)),
                    'placements' => $placements, 'links' => $links, 'canvas_notes' => $notes,
                    'rack_settings' => $settings, 'rack_mounts' => $mounts,
                    'rack_shelves' => $shelves, 'rack_shelf_devices' => $shelfDevices,
                ], $config);
            $normalizedViews = $this->indexed($normalizedViews);
            $normalizedDevices = $this->indexed($normalizedDevices);
            $monitorChanged = false;
            $changedDeviceIds = [];
            foreach ($deviceOperations as $localId => $operation) {
                $id = $maps['devices'][$localId] ?? $localId;
                if ($operation['operation'] === 'delete') {
                    foreach ((new DeviceImageRepository($this->db))->getByDeviceId($id) as $image) {
                        (new DeviceImageRepository($this->db))->enqueueGc((string)$image['stored_name'], date(DATE_ATOM));
                    }
                    $this->deleteRow('devices', $id);
                    $monitorChanged = true;
                    continue;
                }
                $previousIp = (new DeviceRepository($this->db))->getIpById($id);
                $this->writeRow('devices', $normalizedDevices[$id], $operation['operation'] === 'create');
                $changedDeviceIds[$id] = true;
                if ($previousIp === null || $previousIp !== $normalizedDevices[$id]['ip']) {
                    $stmt = $this->db->prepare("INSERT INTO device_monitor_status (device_id, status, last_checked_at, last_response_ms, last_error)
                        VALUES (:id, 'unknown', NULL, NULL, NULL) ON CONFLICT(device_id) DO UPDATE SET
                        status = 'unknown', last_checked_at = NULL, last_response_ms = NULL, last_error = NULL");
                    $stmt->execute([':id' => $id]);
                    $monitorChanged = true;
                }
            }
            // 既存名・正規化後の最終名を避けて退避し、名称交換時の一意制約違反を回避する。
            foreach ($normalizedViews as $view) {
                $reservedViewNames[strtolower($view['name'])] = true;
            }
            $pendingNameSequence = 0;
            $renameView = $this->db->prepare('UPDATE views SET name = :name WHERE id = :id');
            foreach ($viewOperations as $localId => $operation) {
                if ($operation['operation'] === 'update') {
                    $id = $maps['views'][$localId] ?? $localId;
                    do {
                        $pendingName = '__pending_' . ++$pendingNameSequence;
                    } while (isset($reservedViewNames[$pendingName]));
                    $renameView->execute([':name' => $pendingName, ':id' => $id]);
                }
            }
            // Clear replaced owners first, including both ends of a cross-floor transfer.
            foreach (array_keys($replacedViews) as $id) {
                $this->db->prepare('DELETE FROM floor_rack_placements WHERE floor_view_id = :id')->execute([':id' => $id]);
            }
            foreach ($viewOperations as $localId => $operation) {
                $id = $maps['views'][$localId] ?? $localId;
                if ($operation['operation'] === 'delete' || $normalizedViews[$id]['view_type'] !== 'floor') {
                    $stmt = $this->db->prepare('SELECT stored_name FROM view_floor_plans WHERE view_id = :id');
                    $stmt->execute([':id' => $id]);
                    $storedName = $stmt->fetchColumn();
                    if ($storedName !== false) {
                        $floorPlanFiles[] = (string)$storedName;
                    }
                    $stmt = $this->db->prepare('DELETE FROM view_floor_plans WHERE view_id = :id');
                    $stmt->execute([':id' => $id]);
                }
                if ($operation['operation'] === 'delete') {
                    $this->deleteRow('views', $id);
                    continue;
                }
                $this->writeRow('views', $normalizedViews[$id], $operation['operation'] === 'create');
                foreach (['links', 'device_placements', 'canvas_notes'] as $table) {
                    $stmt = $this->db->prepare("DELETE FROM {$table} WHERE view_id = :id");
                    $stmt->execute([':id' => $id]);
                }
            }
            // Clear all changed racks before insertion so transfers do not trip device uniqueness.
            foreach ($viewOperations as $localId => $operation) {
                $id = $maps['views'][$localId] ?? $localId;
                $this->db->prepare('DELETE FROM rack_mounts WHERE view_id = :id')->execute([':id' => $id]);
                $this->db->prepare('DELETE FROM rack_shelves WHERE view_id = :id')->execute([':id' => $id]);
                $this->db->prepare('DELETE FROM rack_settings WHERE view_id = :id')->execute([':id' => $id]);
            }
            foreach (['rack_settings' => $normalizedSettings, 'rack_mounts' => $normalizedMounts] as $table => $rows) {
                foreach ($rows as $row) {
                    if (isset($replacedViews[$row['view_id']])) {
                        $this->writeRow($table, $row, true);
                    }
                }
            }
            foreach ($normalizedShelves as $row) {
                if (isset($replacedViews[$row['view_id']])) { $this->writeRow('rack_shelves', $row, true); }
            }
            $shelfOwners = array_column($normalizedShelves, 'view_id', 'id');
            foreach ($normalizedShelfDevices as $row) {
                if (isset($replacedViews[$shelfOwners[$row['shelf_id']]])) { $this->writeRow('rack_shelf_devices', $row, true); }
            }
            foreach ($normalizedPlacements as $row) {
                if (isset($replacedViews[$row['view_id']]) && !isset($deletedViews[$row['view_id']])) {
                    $this->writeRow('device_placements', $row, true);
                }
            }
            foreach ($normalizedLinks as $row) {
                if (isset($replacedViews[$row['view_id']]) && !isset($deletedViews[$row['view_id']])) {
                    $this->writeRow('links', $row, true);
                }
            }
            foreach ($normalizedNotes as $row) {
                $this->writeRow('canvas_notes', $row, true);
            }
            foreach ($floorRacks as $row) {
                if (isset($replacedViews[$row['floor_view_id']])) {
                    $this->writeRow('floor_rack_placements', $row, true);
                }
            }
            if ($monitorChanged) {
                $meta->incrementMonitorRevision();
            }
            if ($deviceOperations !== [] || $viewOperations !== []) {
                $this->db->exec("UPDATE app_meta SET meta_value = CAST(meta_value AS INTEGER) + 1 WHERE meta_key = 'data_revision'");
                $meta->set('last_saved_at', date(DATE_ATOM));
            }
            // Read the response before commit, from the same snapshot as the writes.
            $affectedPlacements = $this->selectRows('device_placements', 'view_id', array_keys($affectedViews));
            $affectedLinks = $this->selectRows('links', 'view_id', array_keys($affectedViews));
            $affectedMounts = $this->selectRows('rack_mounts', 'view_id', array_keys($affectedViews));
            $affectedShelves = $this->selectRows('rack_shelves', 'view_id', array_keys($affectedViews));
            $affectedShelfDevices = $this->selectRows('rack_shelf_devices', 'shelf_id', array_column($affectedShelves, 'id'));
            // 削除影響ビューの配置が参照する機器も応答に含め、クライアントの構成欠落を防ぐ
            $responseDeviceIds = $changedDeviceIds;
            foreach ($affectedPlacements as $p) {
                $responseDeviceIds[(int)$p['device_id']] = true;
            }
            foreach ($affectedMounts as $mount) {
                $responseDeviceIds[(int)$mount['device_id']] = true;
            }
            foreach ($affectedShelfDevices as $membership) {
                $responseDeviceIds[(int)$membership['device_id']] = true;
            }
            $result = [
                'ok' => true, 'revision' => $meta->getDataRevision(),
                'monitor_revision' => $meta->getMonitorRevision(),
                'saved_at' => $meta->get('last_saved_at', '') ?: null,
                'id_maps' => array_map(static fn(array $map): object => (object)$map, $maps),
                'devices' => (new DeviceRepository($this->db))->getAllWithStatus(array_keys($responseDeviceIds)),
                'views' => $this->selectRows('views', 'id', array_keys($affectedViews)),
                'placements' => $affectedPlacements,
                'links' => $affectedLinks,
                'canvas_notes' => $this->selectRows('canvas_notes', 'view_id', array_keys($affectedViews)),
                'rack_settings' => $this->selectRows('rack_settings', 'view_id', array_keys($affectedViews)),
                'rack_mounts' => $affectedMounts,
                'rack_shelves' => $affectedShelves,
                'rack_shelf_devices' => $affectedShelfDevices,
                'floor_rack_placements' => $this->selectRows('floor_rack_placements', 'floor_view_id', array_keys($affectedViews)),
                'deleted_device_ids' => array_keys($deletedDevices),
                'deleted_view_ids' => array_keys($deletedViews),
                'affected_view_ids' => array_keys($affectedViews),
            ];
            $this->db->commit();
        } catch (Throwable $e) {
            if ($this->db->inTransaction()) {
                $this->db->rollBack();
            }
            if ($e instanceof PDOException && Database::isBusy($e)) {
                throw new ApiException('現在、別の保存処理が実行されています。少し待ってから再度保存してください', 503);
            }
            throw $e;
        }
        foreach ($floorPlanFiles as $storedName) {
            (new FloorPlanService($this->db))->deleteFloorPlanFile((string)$config['floor_plan_directory'], $storedName);
        }
        if ($deletedDevices !== []) {
            try {
                (new DeviceImageService($this->db))->processGcQueue($config);
                $result['post_processing_required'] = (new DeviceImageRepository($this->db))->getQueuedGc(1) !== [];
            } catch (Throwable $e) {
                // 保存は確定済み。後処理の失敗を未保存として再送させない。
                error_log('[Resource Save] Image cleanup failed: ' . $e->getMessage());
                $result['post_processing_required'] = true;
            }
            if ($result['post_processing_required']) {
                $result['message'] = '保存しました。機器画像の整理が未完了です。管理者が監査ログと画像GCを確認してください';
            }
        }
        return $result;
    }

    private function operations($rows, string $label): array
    {
        if (!is_array($rows)) {
            throw new ApiException("{$label}の変更が配列ではありません", 400);
        }
        $result = [];
        foreach ($rows as $row) {
            if (!is_array($row) || !in_array($row['operation'] ?? null, ['create', 'update', 'delete'], true)) {
                throw new ApiException("{$label}の操作が不正です", 400);
            }
            $id = ResourceId::parse($row['id'] ?? null, "{$label}ID");
            if (isset($result[$id])) {
                throw new ApiException("{$label}IDが不正または重複しています", 400);
            }
            if ($row['operation'] !== 'create') {
                $revision = filter_var($row['expected_revision'] ?? null, FILTER_VALIDATE_INT);
                if ($revision === false || $revision <= 0) {
                    throw new ApiException("{$label}ID {$id}: リビジョンが指定されていません。再読み込みしてください", 400);
                }
                $row['expected_revision'] = $revision;
            }
            if ($row['operation'] !== 'delete') {
                $key = $label === '機器' ? 'device' : 'view';
                if (!is_array($row[$key] ?? null)) {
                    throw new ApiException("{$label}ID {$id}: データ形式が不正です", 400);
                }
                if ($key === 'view' && (!is_array($row['placements'] ?? null) || !is_array($row['links'] ?? null)
                    || !is_array($row['canvas_notes'] ?? null) || !array_is_list($row['canvas_notes']))) {
                    throw new ApiException("ビューID {$id}: 配置・接続・メモの全構成を指定してください", 400);
                }
                if ($key === 'view' && array_key_exists('rack_mounts', $row)
                    && (!is_array($row['rack_mounts']) || !array_is_list($row['rack_mounts']))) {
                    throw new ApiException('ラック搭載情報は配列で指定してください', 400);
                }
                if ($key === 'view' && ($row['view']['view_type'] ?? 'topology') === 'rack'
                    && ($row['floor_plans'] ?? []) !== []) {
                    throw new ApiException('ラックに図面は保存できません', 400);
                }
            }
            $result[$id] = $row;
        }
        return $result;
    }

    private function revisionConflicts(array $operations, array $existing, string $kind): array
    {
        $conflicts = [];
        foreach ($operations as $id => $operation) {
            if ($operation['operation'] === 'create') {
                continue;
            }
            if (!isset($existing[$id]) || (int)$existing[$id]['resource_revision'] !== $operation['expected_revision']) {
                $conflicts[] = ['kind' => $kind, 'id' => (int)$id, 'name' => $existing[$id]['name'] ?? '削除済み'];
            }
        }
        return $conflicts;
    }

    private function topologyRow($row, int $viewId, string $label): array
    {
        if (!is_array($row)) {
            throw new ApiException("ビューID {$viewId}: {$label}データが不正です", 400);
        }
        if ($label === 'メモ' && !is_int($row['id'] ?? null)) {
            throw new ApiException('canvas_notes.idは正の整数で指定してください', 400);
        }
        $row['id'] = ResourceId::parse($row['id'] ?? null, "{$label}ID");
        if (isset($row['view_id']) && ResourceId::parse($row['view_id'], 'view_id') !== $viewId) {
            throw new ApiException("ビューID {$viewId}: {$label}データが不正です", 400);
        }
        if ($label === '配置') {
            $row['device_id'] = ResourceId::parse($row['device_id'] ?? null, 'device_id');
        } elseif ($label === '接続') {
            $row['from_id'] = ResourceId::parse($row['from_id'] ?? $row['fromId'] ?? null, 'from_id');
            $row['to_id'] = ResourceId::parse($row['to_id'] ?? $row['toId'] ?? null, 'to_id');
            if (isset($row['system_id'])) {
                $row['system_id'] = LinkSystemService::positiveInteger($row['system_id'], 'system_id');
            }
        }
        return $row;
    }

    private function indexed(array $rows): array
    {
        $result = [];
        foreach ($rows as $row) {
            $result[(int)$row['id']] = $row;
        }
        return $result;
    }

    private function allocate(string $name): int
    {
        return ResourceId::allocate($this->db, $name);
    }

    private function writeRow(string $table, array $row, bool $create): void
    {
        if ($table === 'links') {
            $row['manual_route'] = json_encode($row['manual_route'], JSON_THROW_ON_ERROR);
        }
        $fields = array_keys($row);
        if ($create) {
            $sql = "INSERT INTO {$table} (" . implode(', ', $fields) . ') VALUES (:' . implode(', :', $fields) . ')';
        } else {
            $assignments = array_map(static fn(string $field): string => "{$field} = :{$field}", array_values(array_diff($fields, ['id'])));
            $sql = "UPDATE {$table} SET " . implode(', ', $assignments) . ' WHERE id = :id';
        }
        $this->db->prepare($sql)->execute($row);
    }

    private function deleteRow(string $table, int $id): void
    {
        $this->db->prepare("DELETE FROM {$table} WHERE id = :id")->execute([':id' => $id]);
    }

    private function selectRows(string $table, string $column, array $ids): array
    {
        if ($ids === []) {
            return [];
        }
        $idList = implode(', ', array_map('intval', $ids));
        $order = $table === 'floor_rack_placements' ? 'rack_view_id'
            : ($table === 'rack_settings' ? 'view_id' : (in_array($table, ['rack_mounts', 'rack_shelf_devices'], true) ? 'device_id' : 'id'));
        $rows = $this->db->query("SELECT * FROM {$table} WHERE {$column} IN ({$idList}) ORDER BY {$order}")->fetchAll(PDO::FETCH_ASSOC);
        if ($table === 'links') {
            foreach ($rows as &$row) {
                $row['manual_route'] = json_decode($row['manual_route'], true, 512, JSON_THROW_ON_ERROR);
            }
            unset($row);
        }
        return $rows;
    }
}
