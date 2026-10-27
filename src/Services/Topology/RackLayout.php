<?php
declare(strict_types=1);

namespace Netarium\Services\Topology;

use Netarium\Core\ApiException;

final class RackLayout
{
    public static function validate(array $settings, array $mounts, array $views, array $devices, array $shelves = [], array $shelfDevices = [], bool $allowTemporaryIds = false): array
    {
        if (!array_is_list($settings) || !array_is_list($mounts) || !array_is_list($shelves) || !array_is_list($shelfDevices)) {
            throw new ApiException('ラック情報は配列で指定してください', 400);
        }
        $viewTypes = [];
        foreach ($views as $view) {
            $viewTypes[(int)$view['id']] = $view['view_type'];
        }
        $deviceIds = array_fill_keys(array_column($devices, 'id'), true);
        $normalizedSettings = [];
        $racks = [];
        foreach ($settings as $row) {
            if (!is_array($row)) {
                throw new ApiException('ラック属性が不正です', 400);
            }
            $viewId = self::integer($row['view_id'] ?? null, 'view_id');
            $total = self::integer($row['total_u'] ?? null, 'total_u');
            $location = $row['location'] ?? '';
            if (($viewTypes[$viewId] ?? null) !== 'rack' || isset($racks[$viewId]) || $total > 60
                || !is_string($location) || preg_match('//u', $location) !== 1
                || (function_exists('mb_strlen') ? mb_strlen($location, 'UTF-8') : preg_match_all('/./us', $location)) > 150) {
                throw new ApiException('ラック属性・参照・総U数が不正です', 400);
            }
            $racks[$viewId] = $total;
            $normalizedSettings[] = ['view_id' => $viewId, 'total_u' => $total, 'location' => $location];
        }
        foreach ($viewTypes as $id => $type) {
            if ($type === 'rack' && !isset($racks[$id])) {
                throw new ApiException('ラック属性を指定してください', 400);
            }
        }
        $normalizedMounts = [];
        $mounted = [];
        $occupied = [];
        foreach ($mounts as $row) {
            if (!is_array($row)) {
                throw new ApiException('ラック搭載情報が不正です', 400);
            }
            $deviceId = self::integer($row['device_id'] ?? null, 'device_id');
            $viewId = self::integer($row['view_id'] ?? null, 'view_id');
            $start = self::integer($row['start_u'] ?? null, 'start_u');
            $height = self::integer($row['height_u'] ?? null, 'height_u');
            $face = $row['face'] ?? null;
            $slot = $row['width_slot'] ?? null;
            $depth = array_key_exists('depth', $row) ? $row['depth'] : 'half';
            if (!isset($deviceIds[$deviceId]) || !isset($racks[$viewId]) || isset($mounted[$deviceId])
                || !in_array($face, ['front', 'rear', 'both'], true)
                || !in_array($slot, ['full', 'left', 'right'], true) || ($face === 'both' && $slot !== 'full')
                || !in_array($depth, ['half', 'full'], true)
                || $start > $racks[$viewId] || $height > $racks[$viewId] - $start + 1) {
                throw new ApiException('ラック搭載の参照・範囲・面・横幅が不正、または同一機器が重複しています', 400);
            }
            foreach (self::occupiedCells($viewId, $face, $slot, $start, $height, $depth) as $key) {
                if (isset($occupied[$key])) {
                    throw new ApiException('ラックの搭載位置が重複しています', 400);
                }
                $occupied[$key] = true;
            }
            $mounted[$deviceId] = true;
            $normalizedMounts[] = ['device_id' => $deviceId, 'view_id' => $viewId, 'face' => $face,
                'start_u' => $start, 'height_u' => $height, 'width_slot' => $slot, 'depth' => $depth];
        }
        $normalizedShelves = [];
        $shelfIds = [];
        foreach ($shelves as $row) {
            if (!is_array($row)) {
                throw new ApiException('棚板情報が不正です', 400);
            }
            $id = $row['id'] ?? null;
            if (!$allowTemporaryIds || !is_int($id) || $id >= 0 || $id < -\Netarium\Core\ResourceId::MAX) {
                $id = \Netarium\Core\ResourceId::parse($id, '棚板ID');
            }
            $viewId = self::integer($row['view_id'] ?? null, 'view_id');
            $start = self::integer($row['start_u'] ?? null, 'start_u');
            $height = self::integer($row['height_u'] ?? null, 'height_u');
            $name = $row['name'] ?? null;
            if (is_string($name)) { $name = trim($name); }
            $face = $row['face'] ?? null;
            $depth = $row['depth'] ?? null;
            if (isset($shelfIds[$id]) || !isset($racks[$viewId])
                || !is_string($name) || trim($name) === '' || preg_match('//u', $name) !== 1
                || (function_exists('mb_strlen') ? mb_strlen($name, 'UTF-8') : preg_match_all('/./us', $name)) > 100
                || !in_array($face, ['front', 'rear'], true) || !in_array($depth, ['half', 'full'], true)
                || $start > $racks[$viewId] || $height > $racks[$viewId] - $start + 1) {
                throw new ApiException('棚板の参照・名称・範囲・面・奥行きが不正です', 400);
            }
            foreach (self::occupiedCells($viewId, $face, 'full', $start, $height, $depth) as $key) {
                if (isset($occupied[$key])) {
                    throw new ApiException('棚板とラックの搭載位置が重複しています', 400);
                }
                $occupied[$key] = true;
            }
            $shelfIds[$id] = true;
            $normalizedShelves[] = ['id' => $id, 'view_id' => $viewId, 'name' => trim($name),
                'face' => $face, 'start_u' => $start, 'height_u' => $height, 'depth' => $depth];
        }
        $normalizedShelfDevices = [];
        $orders = [];
        foreach ($shelfDevices as $row) {
            if (!is_array($row)) {
                throw new ApiException('棚板機器情報が不正です', 400);
            }
            $deviceId = self::integer($row['device_id'] ?? null, 'device_id');
            $shelfId = $row['shelf_id'] ?? null;
            if (!$allowTemporaryIds || !is_int($shelfId) || $shelfId >= 0 || $shelfId < -\Netarium\Core\ResourceId::MAX) {
                $shelfId = \Netarium\Core\ResourceId::parse($shelfId, 'shelf_id');
            }
            $order = $row['sort_order'] ?? null;
            if (!isset($deviceIds[$deviceId], $shelfIds[$shelfId]) || isset($mounted[$deviceId])
                || !is_int($order) || $order < 0 || isset($orders[$shelfId][$order])) {
                throw new ApiException('棚板機器の参照・順序が不正、または同一機器が重複しています', 400);
            }
            $mounted[$deviceId] = true;
            $orders[$shelfId][$order] = true;
            $normalizedShelfDevices[] = ['device_id' => $deviceId, 'shelf_id' => $shelfId, 'sort_order' => $order];
        }
        return [$normalizedSettings, $normalizedMounts, $normalizedShelves, $normalizedShelfDevices];
    }

    /**
     * Stored width slots already use the front-facing physical coordinates.
     * A full-depth mount reserves that same physical slot on both faces.
     * Shared by mount validation and shelf occupancy.
     *
     * @return \Generator<int, string>
     */
    public static function occupiedCells(int $viewId, string $face, string $slot, int $start, int $height, string $depth = 'half'): \Generator
    {
        foreach ($face === 'both' || $depth === 'full' ? ['front', 'rear'] : [$face] as $side) {
            foreach ($slot === 'full' ? ['left', 'right'] : [$slot] as $width) {
                for ($u = $start; $u < $start + $height; $u++) {
                    yield "$viewId:$side:$u:$width";
                }
            }
        }
    }

    private static function integer($value, string $field): int
    {
        if (!is_int($value) || $value < 1) {
            throw new ApiException("{$field}は正の整数で指定してください", 400);
        }
        return $value;
    }

    public static function assertViewChanges(array $existingViews, array $newViews, array $existingMounts): void
    {
        $new = array_column($newViews, null, 'id');
        $occupied = array_fill_keys(array_column($existingMounts, 'view_id'), true);
        foreach ($existingViews as $view) {
            $id = (int)$view['id'];
            $next = $new[$id]['view_type'] ?? null;
            if (($view['view_type'] !== 'rack' && $next === 'rack')
                || ($view['view_type'] === 'rack' && $next !== 'rack' && isset($occupied[$id]))) {
                throw new ApiException('既存ビューのラック化、または搭載済みラックの削除・種別変更はできません', 400);
            }
        }
    }
}
