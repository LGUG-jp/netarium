<?php
declare(strict_types=1);

namespace Netarium\Services\Topology;

use Netarium\Core\ApiException;

final class LinkRoute
{
    public const MAX_POINTS = 8;

    /** APIとバックアップで共用する中間経路の検証。端点は含めない。 */
    public static function normalize(array $link): array
    {
        $mode = $link['route_mode'] ?? 'auto';
        if (array_key_exists('route_mode', $link) && $link['route_mode'] === null) {
            throw new ApiException('接続の経路モードが不正です', 400);
        }
        if (!in_array($mode, ['auto', 'manual'], true)) {
            throw new ApiException('接続の経路モードが不正です', 400);
        }
        $points = array_key_exists('manual_route', $link) ? $link['manual_route'] : ($mode === 'auto' ? [] : null);
        if (!is_array($points) || !array_is_list($points)) {
            throw new ApiException('接続の手動経路は中間点の配列にしてください', 400);
        }
        if (count($points) > self::MAX_POINTS) {
            throw new ApiException('接続の中間点は最大' . self::MAX_POINTS . '点です', 400);
        }
        if ($mode === 'auto' && $points !== []) {
            throw new ApiException('自動経路には手動の中間点を指定できません', 400);
        }
        $normalized = [];
        foreach ($points as $point) {
            if (!is_array($point) || count($point) !== 2 ||
                !array_key_exists('x', $point) || !array_key_exists('y', $point)) {
                throw new ApiException('接続の中間点はxとyだけを指定してください', 400);
            }
            foreach (['x', 'y'] as $axis) {
                if ((!is_int($point[$axis]) && !is_float($point[$axis])) || !is_finite((float)$point[$axis])) {
                    throw new ApiException('接続の中間点の座標は有限の数値にしてください', 400);
                }
            }
            $previous = $normalized === [] ? null : $normalized[count($normalized) - 1];
            if ($previous !== null &&
                (float)$previous['x'] !== (float)$point['x'] && (float)$previous['y'] !== (float)$point['y']) {
                throw new ApiException('接続の中間経路は水平または垂直にしてください', 400);
            }
            $normalized[] = ['x' => $point['x'], 'y' => $point['y']];
        }
        return ['route_mode' => $mode, 'manual_route' => $normalized];
    }
}
