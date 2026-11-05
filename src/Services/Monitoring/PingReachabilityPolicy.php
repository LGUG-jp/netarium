<?php
declare(strict_types=1);

namespace Netarium\Services\Monitoring;

final class PingReachabilityPolicy
{
    public static function decisions(array $records, array $spaces): array
    {
        $spaces = array_column($spaces, null, 'id');
        $groups = [];
        foreach ($records as $record) {
            $ip = trim((string)$record['ip']);
            if ($ip === '') { continue; }
            $space = $spaces[$record['address_space_id'] ?? 0] ?? [];
            $record['ping_reachability'] = $space['ping_reachability'] ?? 'unset';
            $record['address_space_name'] = $space['name'] ?? null;
            $groups[$ip][] = $record;
        }
        $decisions = [];
        foreach ($groups as $group) {
            foreach ($group as $target) {
                if ($target['kind'] !== 'management') { continue; }
                $others = array_values(array_filter($group, static fn(array $r): bool =>
                    (string)$r['device_id'] !== (string)$target['device_id']));
                $state = $target['ping_reachability'];
                $otherStates = array_column($others, 'ping_reachability');
                $reason = null;
                if ($state === 'unreachable') {
                    $reason = 'unreachable';
                } elseif ($others !== []) {
                    if ($state === 'reachable' && in_array('reachable', $otherStates, true)) {
                        $reachableSpaces = [$target['address_space_id'] => true];
                        foreach ($others as $other) {
                            if ($other['ping_reachability'] === 'reachable') { $reachableSpaces[$other['address_space_id']] = true; }
                        }
                        $reason = count($reachableSpaces) > 1 ? 'multiple_reachable'
                            : (in_array('unset', $otherStates, true) ? 'unresolved' : 'duplicate');
                    } elseif (($state === 'reachable' && in_array('unset', $otherStates, true))
                        || ($state === 'unset' && in_array('reachable', $otherStates, true))) {
                        $reason = 'unresolved';
                    } elseif ($state !== 'reachable' || count(array_filter($otherStates, static fn(string $s): bool => $s !== 'unreachable')) > 0) {
                        $reason = 'duplicate';
                    }
                }
                $error = match ($reason) {
                    'unreachable' => 'ネットワーク区分が「到達不可」に設定されているため、Pingをスキップしました',
                    'multiple_reachable' => '同じIPが複数の到達可能なネットワーク区分に登録されているため、通信先を特定できずPingをスキップしました',
                    'unresolved' => '同じIPに到達性が未設定・未分類の登録があるため、通信先を特定できずPingをスキップしました',
                    'duplicate' => '同じIPが他機器にも登録されているため、対象機器を特定できずPingをスキップしました',
                    default => null,
                };
                $decisions[$target['device_id']] = ['allowed' => $reason === null, 'reason_code' => $reason, 'error' => $error, 'records' => $group];
            }
        }
        return $decisions;
    }
}
