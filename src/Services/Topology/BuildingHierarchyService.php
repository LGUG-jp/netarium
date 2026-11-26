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

final class BuildingHierarchyService
{
    private const TRANSFORM_FIELDS = ['scale', 'offset_x', 'offset_y', 'rotation'];

    private const FLOOR_TRANSFORM_BASELINE_FIELDS = ['building_id', 'representative_view_id', ...self::TRANSFORM_FIELDS];

    private const REVISION_CONFLICT = '他の利用者または別画面でデータが更新されています。再読み込みしてください';

    public function __construct(private PDO $db) {}

    public function load(): array
    {
        // View revisions must travel with their topology, never with hierarchy metadata alone.
        return (new TopologyService($this->db))->load();
    }

    public function mutate(array $input): array
    {
        $operation = $input['operation'] ?? '';
        $updateTransform = $operation === 'update_floor_transform';
        $revision = $input['revision'] ?? null;
        if (!$updateTransform && (!is_int($revision) || $revision < 1)) {
            throw new ApiException('リビジョンを正の整数で指定してください', 400);
        }
        if (!$updateTransform && !in_array($operation, ['create_building', 'update_building', 'delete_building', 'create_floor', 'update_floor', 'delete_floor'], true)) {
            throw new ApiException('建物・フロア操作が不正です', 400);
        }
        $table = str_ends_with($operation, '_building') ? 'buildings' : 'floors';
        $create = str_starts_with($operation, 'create_');
        $delete = str_starts_with($operation, 'delete_');
        try {
            $this->db->beginTransaction();
            $meta = new AppMetaRepository($this->db);
            if ($updateTransform) {
                // Lock the database for writes before comparing the floor in the same transaction.
                $this->db->exec("UPDATE app_meta SET meta_value = CAST(meta_value AS INTEGER) + 1 WHERE meta_key = 'data_revision'");
            } else {
                $meta->claimDataRevision($revision);
            }
            $id = $create ? ResourceId::allocate($this->db, $table) : self::id($input['id'] ?? null);
            $existing = null;
            if (!$create) {
                $stmt = $this->db->prepare("SELECT * FROM {$table} WHERE id = :id");
                $stmt->execute([':id' => $id]);
                $existing = $stmt->fetch(PDO::FETCH_ASSOC);
                if ($existing === false) { throw new ApiException('建物またはフロアが見つかりません', 404); }
            }
            if ($updateTransform) {
                $this->updateFloorTransform($input, $existing);
                $stmt->execute([':id' => $id]);
                $savedFloor = $stmt->fetch(PDO::FETCH_ASSOC);
            } elseif ($delete) {
                // FK SET NULL detaches views; membership triggers update their resource revisions.
                $this->db->prepare("DELETE FROM {$table} WHERE id = :id")->execute([':id' => $id]);
            } else {
                $fields = $table === 'buildings' ? ['name', 'sort_order', 'building_view_enabled']
                    : ['building_id', 'name', 'sort_order', 'representative_view_id', 'scale', 'offset_x', 'offset_y', 'rotation'];
                $row = $existing ?: ($table === 'buildings' ? ['id' => $id, 'name' => '', 'sort_order' => 0, 'building_view_enabled' => 0]
                    : ['id' => $id, 'building_id' => null, 'name' => '', 'sort_order' => 0, 'representative_view_id' => null,
                        'scale' => 1, 'offset_x' => 0, 'offset_y' => 0, 'rotation' => 0]);
                foreach ($fields as $field) {
                    if (array_key_exists($field, $input)) { $row[$field] = $input[$field]; }
                }
                $snapshot = $this->load();
                $rows = array_column($snapshot[$table], null, 'id');
                $rows[$id] = $row;
                self::validateBackupRows($table === 'buildings' ? array_values($rows) : $snapshot['buildings'],
                    $table === 'floors' ? array_values($rows) : $snapshot['floors'], $snapshot['views']);
                if ($create) {
                    $columns = array_keys($row);
                    $this->db->prepare("INSERT INTO {$table} (" . implode(', ', $columns) . ') VALUES (:' . implode(', :', $columns) . ')')->execute($row);
                } else {
                    $assignments = implode(', ', array_map(static fn(string $field): string => "{$field} = :{$field}", $fields));
                    $this->db->prepare("UPDATE {$table} SET {$assignments} WHERE id = :id")->execute($row);
                }
            }
            $meta->set('last_saved_at', date(DATE_ATOM));
            $result = $updateTransform
                ? ['ok' => true, 'revision' => $meta->getDataRevision(), 'floor' => $savedFloor]
                : $this->load();
            $this->db->commit();
            return $result;
        } catch (Throwable $e) {
            if ($this->db->inTransaction()) { $this->db->rollBack(); }
            if ($e instanceof PDOException && Database::isBusy($e)) {
                throw new ApiException('現在、別の保存処理が実行されています。少し待ってから再度保存してください', 503);
            }
            throw $e;
        }
    }

    private function updateFloorTransform(array $input, array $floor): void
    {
        $expectedFloor = $input['expected_floor'] ?? null;
        if (!is_array($expectedFloor) || array_diff(self::FLOOR_TRANSFORM_BASELINE_FIELDS, array_keys($expectedFloor)) !== []) {
            throw new ApiException('フロア座標変換の更新前の値を指定してください', 400);
        }
        $expectedBuildingId = self::id($expectedFloor['building_id']);
        $expectedRepresentative = $expectedFloor['representative_view_id'];
        if ($expectedRepresentative !== null) { self::id($expectedRepresentative); }
        self::validateTransform($expectedFloor);
        self::validateTransform($input);

        $floorRepresentative = $floor['representative_view_id'] === null ? null : (int)$floor['representative_view_id'];
        if ((int)$floor['building_id'] !== $expectedBuildingId || $floorRepresentative !== $expectedRepresentative) {
            throw new ApiException(self::REVISION_CONFLICT, 409);
        }
        $building = $this->db->prepare('SELECT building_view_enabled FROM buildings WHERE id = :id');
        $building->execute([':id' => $expectedBuildingId]);
        if ((int)$building->fetchColumn() !== 1) {
            throw new ApiException('建物ビューが無効になりました。最新情報を確認してください', 409);
        }
        $params = ['id' => $floor['id']];
        foreach (self::TRANSFORM_FIELDS as $field) {
            if ((float)$floor[$field] !== (float)$expectedFloor[$field]) {
                throw new ApiException(self::REVISION_CONFLICT, 409);
            }
            // PDO's default float-to-string conversion can lose significant digits before SQLite stores the REAL.
            $params[$field] = json_encode((float)$input[$field], JSON_THROW_ON_ERROR);
        }
        $this->db->prepare('UPDATE floors SET scale = :scale, offset_x = :offset_x, offset_y = :offset_y, rotation = :rotation WHERE id = :id')
            ->execute($params);
    }

    public static function normalizeFloorId($value, array $floors): ?int
    {
        if ($value === null) { return null; }
        $id = self::id($value);
        if (!isset($floors[$id])) { throw new ApiException('所属先フロアが存在しません', 400); }
        return $id;
    }

    public static function validateBackupRows(array $buildings, array $floors, array $views, bool $hasBuildingViewEnabled = true): void
    {
        $buildingIds = [];
        $buildingFields = ['id', 'name', 'sort_order'];
        if ($hasBuildingViewEnabled) { $buildingFields[] = 'building_view_enabled'; }
        foreach ($buildings as $row) {
            self::validateRow($row, $buildingFields);
            if ($hasBuildingViewEnabled && !in_array($row['building_view_enabled'], [0, 1], true)) {
                throw new ApiException('建物ビューの利用設定は 0 または 1 で指定してください', 400);
            }
            $id = self::id($row['id']);
            if (isset($buildingIds[$id])) { throw new ApiException('建物IDが重複しています', 400); }
            $buildingIds[$id] = true;
        }
        $floorIds = [];
        foreach ($floors as $row) {
            self::validateRow($row, ['id', 'building_id', 'name', 'sort_order', 'representative_view_id', 'scale', 'offset_x', 'offset_y', 'rotation']);
            $id = self::id($row['id']);
            if (isset($floorIds[$id])) { throw new ApiException('フロアIDが重複しています', 400); }
            $floorIds[$id] = true;
            if (!isset($buildingIds[self::id($row['building_id'])])) { throw new ApiException('所属先建物が存在しません', 400); }
            self::validateTransform($row);
        }
        $viewIds = [];
        foreach ($views as $view) {
            $id = self::id($view['id'] ?? null);
            if (isset($viewIds[$id])) { throw new ApiException('ビューIDが重複しています', 400); }
            self::normalizeFloorId($view['floor_id'] ?? null, $floorIds);
            $viewIds[$id] = $view;
        }
        foreach ($floors as $floor) {
            if ($floor['representative_view_id'] === null) { continue; }
            $view = $viewIds[self::id($floor['representative_view_id'])] ?? null;
            if ($view === null || ($view['floor_id'] ?? null) !== $floor['id'] || ($view['view_type'] ?? '') !== 'floor') {
                throw new ApiException('代表ビューは同じフロアに所属する物理構成ビューを指定してください', 400);
            }
        }
    }

    private static function validateTransform(array $row): void
    {
        foreach (self::TRANSFORM_FIELDS as $field) {
            $value = $row[$field] ?? null;
            if ((!is_int($value) && !is_float($value)) || !is_finite((float)$value)
                || ($field === 'scale' && $value <= 0) || ($field === 'rotation' && ($value < -180 || $value > 180))) {
                throw new ApiException('フロア座標変換が不正です', 400);
            }
        }
    }

    private static function id($value): int
    {
        if (!is_int($value) || $value < 1 || $value > ResourceId::MAX) { throw new ApiException('IDは正の整数で指定してください', 400); }
        return $value;
    }

    private static function validateRow($row, array $fields): void
    {
        if (!is_array($row) || array_diff(array_keys($row), $fields) !== [] || array_diff($fields, array_keys($row)) !== []) {
            throw new ApiException('建物・フロアの項目が不正です', 400);
        }
        if (!is_string($row['name']) || trim($row['name']) === '' || mb_strlen($row['name'], 'UTF-8') > 100
            || preg_match('//u', $row['name']) !== 1) {
            throw new ApiException('名称は1～100文字で指定してください', 400);
        }
        if (!is_int($row['sort_order']) || $row['sort_order'] < -999999 || $row['sort_order'] > 999999) {
            throw new ApiException('表示順が不正です', 400);
        }
    }
}
