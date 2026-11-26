<?php
declare(strict_types=1);

namespace Netarium\Services\Topology;

use PDO;

/** Conservative, shared conversion for database upgrades and configuration restores. */
final class LegacyHierarchyMigration
{
    public static function convert(array &$tables, array $sequences = []): array
    {
        $report = ['assigned' => 0, 'explicit' => 0, 'created_buildings' => 0, 'created_floors' => 0, 'unclassified' => []];
        $buildings = $floors = $buildingNames = $floorNames = $aliases = [];
        $nextBuilding = (int)($sequences['buildings'] ?? 0);
        $nextFloor = (int)($sequences['floors'] ?? 0);
        foreach ($tables['buildings'] as $row) {
            $buildings[$row['id']] = $row;
            $buildingNames[self::normalizeLegacyName($row['name'])][] = $row['id'];
            $nextBuilding = max($nextBuilding, $row['id']);
        }
        foreach ($tables['floors'] as $row) {
            $floors[$row['id']] = $row;
            $floorNames[$row['building_id']][self::normalizeLegacyName($row['name'])][] = $row['id'];
            $nextFloor = max($nextFloor, $row['id']);
        }
        $key = static fn(string $facility, string $floor): string => json_encode([$facility, $floor], JSON_THROW_ON_ERROR);
        foreach ($tables['views'] as $row) {
            $facility = self::normalizeLegacyName($row['facility']);
            $floor = self::normalizeLegacyName($row['floor']);
            if (($row['floor_id'] ?? null) !== null && $facility !== '' && $floor !== '') {
                $aliases[$key($facility, $floor)][$row['floor_id']] = true;
            }
        }
        // Process names deterministically so generated IDs and unknown floor ordering are stable.
        $pairs = ['views' => [], 'devices' => []];
        foreach (['views', 'devices'] as $table) {
            foreach ($tables[$table] as $row) {
                if (($row['floor_id'] ?? null) === null) {
                    $facility = self::normalizeLegacyName($row['facility']);
                    $floor = self::normalizeLegacyName($row['floor']);
                    $pairs[$table][$key($facility, $floor)] = [$facility, $floor, $table === 'views'];
                }
            }
        }
        ksort($pairs['views'], SORT_STRING);
        ksort($pairs['devices'], SORT_STRING);
        // ビュー由来の階層生成をすべて終えてから、機器だけの旧名称を照合する。
        $pairs = $pairs['views'] + $pairs['devices'];
        $resolved = [];
        foreach ($pairs as $pairKey => [$facility, $floor, $canCreate]) {
            $reason = null;
            $id = null;
            $targets = array_keys($aliases[$pairKey] ?? []);
            if (count($targets) === 1) { $id = $targets[0]; }
            elseif (count($targets) > 1) { $reason = 'ambiguous_explicit_mapping'; }
            elseif ($facility === '') { $reason = $floor === '' ? 'empty_legacy_location' : 'missing_building'; }
            elseif (!$canCreate && $floor === '') { $reason = 'missing_floor'; }
            elseif (count($buildingNames[$facility] ?? []) > 1) { $reason = 'ambiguous_building_name'; }
            else {
                $buildingId = $buildingNames[$facility][0] ?? null;
                if ($buildingId === null && !$canCreate) {
                    $resolved[$pairKey] = [null, 'unmatched_legacy_location'];
                    continue;
                }
                if ($buildingId === null) {
                    $buildingId = ++$nextBuilding;
                    $buildings[$buildingId] = ['id' => $buildingId, 'name' => $facility, 'sort_order' => 0];
                    $buildingNames[$facility] = [$buildingId];
                    $report['created_buildings']++;
                }
                if ($floor === '') { $reason = 'missing_floor'; }
                elseif (count($floorNames[$buildingId][$floor] ?? []) > 1) { $reason = 'ambiguous_floor_name'; }
                else {
                    $id = $floorNames[$buildingId][$floor][0] ?? null;
                    if ($id === null && !$canCreate) { $reason = 'unmatched_legacy_location'; }
                    elseif ($id === null) {
                        $id = ++$nextFloor;
                        $floors[$id] = ['id' => $id, 'building_id' => $buildingId, 'name' => $floor,
                            'sort_order' => self::floorOrder($floor), 'representative_view_id' => null,
                            'scale' => 1, 'offset_x' => 0, 'offset_y' => 0, 'rotation' => 0];
                        $floorNames[$buildingId][$floor] = [$id];
                        $report['created_floors']++;
                    }
                }
            }
            $resolved[$pairKey] = [$id, $reason];
        }
        foreach (['views', 'devices'] as $table) {
            foreach ($tables[$table] as &$row) {
                if (($row['floor_id'] ?? null) !== null) { $report['explicit']++; continue; }
                [$id, $reason] = $resolved[$key(self::normalizeLegacyName($row['facility']), self::normalizeLegacyName($row['floor']))];
                $row['floor_id'] = $id;
                if ($id !== null) { $report['assigned']++; }
                else { $report['unclassified'][$reason] = ($report['unclassified'][$reason] ?? 0) + 1; }
            }
            unset($row);
        }
        $tables['buildings'] = array_values($buildings);
        $tables['floors'] = array_values($floors);
        return $report;
    }

    private static function normalizeLegacyName(string $name): string
    {
        // Only surrounding whitespace: no case folding, NFKC or semantic aliases.
        return preg_replace('/\A[\s\p{Z}]+|[\s\p{Z}]+\z/u', '', $name) ?? trim($name);
    }

    private static function floorOrder(string $name): int
    {
        if (preg_match('/\AB([1-9][0-9]{0,3})\z/', $name, $m)) { return -(int)$m[1]; }
        if (preg_match('/\A([1-9][0-9]{0,3})F\z/', $name, $m)) { return (int)$m[1]; }
        return $name === 'RF' ? 10000 : 20000;
    }

    /** Caller owns the transaction; failure rolls back hierarchy and memberships together. */
    public static function migrate(PDO $db): array
    {
        $tables = [];
        foreach (['buildings', 'floors', 'views', 'devices'] as $table) {
            $tables[$table] = $db->query("SELECT * FROM {$table} ORDER BY id")->fetchAll(PDO::FETCH_ASSOC);
        }
        $beforeBuildings = array_fill_keys(array_column($tables['buildings'], 'id'), true);
        $beforeFloors = array_fill_keys(array_column($tables['floors'], 'id'), true);
        $sequences = $db->query('SELECT name, value FROM resource_sequences')->fetchAll(PDO::FETCH_KEY_PAIR);
        $report = self::convert($tables, $sequences);
        foreach (['buildings' => $beforeBuildings, 'floors' => $beforeFloors] as $table => $existing) {
            foreach ($tables[$table] as $row) {
                if (isset($existing[$row['id']])) { continue; }
                $columns = array_keys($row);
                $db->prepare("INSERT INTO {$table} (" . implode(', ', $columns) . ') VALUES (:' . implode(', :', $columns) . ')')->execute($row);
            }
        }
        foreach (['views', 'devices'] as $table) {
            $stmt = $db->prepare("UPDATE {$table} SET floor_id = :floor_id WHERE id = :id AND floor_id IS NULL");
            foreach ($tables[$table] as $row) { $stmt->execute([':floor_id' => $row['floor_id'], ':id' => $row['id']]); }
        }
        $db->prepare("INSERT INTO app_meta(meta_key, meta_value) VALUES ('legacy_hierarchy_migration', :report)
            ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value")
            ->execute([':report' => json_encode($report, JSON_THROW_ON_ERROR)]);
        return $report;
    }
}
