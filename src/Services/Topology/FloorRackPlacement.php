<?php
declare(strict_types=1);

namespace Netarium\Services\Topology;

use Netarium\Core\ApiException;
use Netarium\Core\ResourceId;

final class FloorRackPlacement
{
    public static function normalizeRows(mixed $rows, array $views): array
    {
        if (!is_array($rows) || !array_is_list($rows)) {
            throw new ApiException('ラック配置は配列で指定してください', 400);
        }
        $types = array_column($views, 'view_type', 'id');
        $seen = [];
        $result = [];
        foreach ($rows as $row) {
            if (!is_array($row)) {
                throw new ApiException('ラック配置の形式が不正です', 400);
            }
            $floorId = ResourceId::parse($row['floor_view_id'] ?? null, 'floor_view_id');
            $rackId = ResourceId::parse($row['rack_view_id'] ?? null, 'rack_view_id');
            if (($types[$floorId] ?? null) !== 'floor' || ($types[$rackId] ?? null) !== 'rack') {
                throw new ApiException('ラック配置には既存の物理配置図とラックビューを指定してください', 400);
            }
            if (isset($seen[$rackId])) {
                throw new ApiException('同じラックは全体で1か所にだけ配置できます', 400);
            }
            foreach (['x', 'y'] as $field) {
                if ((!is_int($row[$field] ?? null) && !is_float($row[$field] ?? null)) || !is_finite((float)$row[$field])) {
                    throw new ApiException("ラック配置の{$field}は有限の数値で指定してください", 400);
                }
            }
            $seen[$rackId] = true;
            $result[] = ['floor_view_id' => $floorId, 'rack_view_id' => $rackId, 'x' => (float)$row['x'], 'y' => (float)$row['y']];
        }
        return $result;
    }
}
