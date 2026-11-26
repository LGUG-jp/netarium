<?php
declare(strict_types=1);

namespace Netarium\Services\Topology;

use Netarium\Core\ApiException;
use Netarium\Core\Request;
use RuntimeException;

final class LegacyLinkMigration
{
    public static function normalizePortName(string $name): string
    {
        static $asciiWidth = null;
        $asciiWidth ??= array_combine(
            preg_split('//u', '！＂＃＄％＆＇（）＊＋，－．／０１２３４５６７８９：；＜＝＞？＠ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺ［＼］＾＿｀ａｂｃｄｅｆｇｈｉｊｋｌｍｎｏｐｑｒｓｔｕｖｗｘｙｚ｛｜｝～', -1, PREG_SPLIT_NO_EMPTY),
            str_split(implode('', array_map(chr(...), range(33, 126))))
        );
        return trim(preg_replace('/[\p{Z}\x09-\x0D\x{85}]+/u', ' ', strtr($name, $asciiWidth))
            ?? throw new RuntimeException('ポート名の文字コードが不正です'), ' ');
    }

    /** 旧行を一度だけ分類する。変換件数は統合した元行を含む。 */
    public static function convert(array $oldLinks): array
    {
        usort($oldLinks, static fn(array $a, array $b): int => $a['id'] <=> $b['id']);
        $groups = [];
        $portPairs = [];
        $reasons = [];
        foreach ($oldLinks as $row) {
            $fromId = (int)$row['from_id'];
            $toId = (int)$row['to_id'];
            $pair = min($fromId, $toId) . ':' . max($fromId, $toId);
            $fromName = self::normalizePortName($row['from_port']);
            $toName = self::normalizePortName($row['to_port']);
            if (is_string($row['manual_route'])) {
                $row['manual_route'] = Request::decodeJson($row['manual_route']);
            }
            $groups[$pair][] = [$row, $fromName, $toName];
            foreach ([[$fromId, $fromName], [$toId, $toName]] as [$device, $name]) {
                if ($name === '') {
                    continue;
                }
                $other = $portPairs[$device][$name] ?? $pair;
                if ($other !== $pair) {
                    $reasons[$other] = $reasons[$pair] = 'port_collision';
                }
                $portPairs[$device][$name] = $pair;
            }
        }

        $ports = $links = $routes = $held = [];
        $converted = 0;
        foreach ($groups as $pair => $members) {
            [$deviceA, $deviceB] = array_map('intval', explode(':', $pair));
            [$first, $fromName, $toName] = $members[0];
            $reason = $reasons[$pair] ?? null;
            $seenViews = [];
            $signature = null;
            $pairRoutes = [];
            foreach ($members as [$row, $from, $to]) {
                $viewId = (int)$row['view_id'];
                $forward = (int)$row['from_id'] === $deviceA;
                $attrs = [$row['system_id'], $row['vlan'], $row['label'], $row['memo']];
                $key = [...($forward ? [$from, $to] : [$to, $from]), ...$attrs];
                if (count($members) > 1 && ($from === '' || $to === '' || isset($seenViews[$viewId]) ||
                    ($signature !== null && $key !== $signature))) {
                    $reason ??= 'ambiguous_pair';
                }
                $signature ??= $key;
                $seenViews[$viewId] = true;
                if ($reason !== null || $row['route_mode'] !== 'manual') {
                    continue;
                }
                try {
                    $points = LinkRoute::normalize($row)['manual_route'];
                } catch (ApiException) {
                    $reason = 'invalid_manual_route';
                    continue;
                }
                $pairRoutes[] = [
                    'view_id' => $viewId, 'device_a_id' => $deviceA, 'device_b_id' => $deviceB,
                    'manual_route' => $forward ? $points : array_reverse($points),
                ];
            }
            if ($reason !== null) {
                foreach ($members as [$row]) {
                    $held[] = [
                        'legacy_link_id' => (int)$row['id'], 'view_id' => (int)$row['view_id'],
                        'device_a_id' => $deviceA, 'device_b_id' => $deviceB,
                        'reason' => $reason, 'payload' => $row,
                    ];
                }
                continue;
            }

            $link = array_intersect_key($first, array_flip(['id', 'from_id', 'to_id', 'system_id', 'label', 'vlan', 'memo']));
            foreach (['from' => $fromName, 'to' => $toName] as $side => $name) {
                $portId = null;
                if ($name !== '') {
                    $portId = count($ports) + 1;
                    $ports[] = ['id' => $portId, 'device_id' => (int)$first[$side . '_id'], 'name' => $name, 'memo' => ''];
                }
                $link[$side . '_port_id'] = $portId;
            }
            $links[] = $link;
            foreach ($pairRoutes as $route) { $routes[] = $route; }
            $converted += count($members);
        }

        $total = count($oldLinks);
        if ($total !== $converted + count($held)) {
            throw new RuntimeException('旧接続の変換件数が一致しません');
        }
        return [
            'device_ports' => $ports, 'links' => $links, 'view_link_routes' => $routes, 'legacy_link_conflicts' => $held,
            'counts' => ['total' => $total, 'converted' => $converted, 'held' => count($held)],
        ];
    }
}
