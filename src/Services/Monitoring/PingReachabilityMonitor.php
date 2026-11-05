<?php
declare(strict_types=1);

namespace Netarium\Services\Monitoring;

use PDO;
use Netarium\Repositories\AppMetaRepository;
use Netarium\Repositories\DeviceIpAddressRepository;
use Netarium\Repositories\DeviceRepository;

/** Called inside the configuration writer's transaction, never by a Ping request. */
final class PingReachabilityMonitor
{
    public function __construct(private PDO $db) {}

    public function snapshot(): array
    {
        return PingReachabilityPolicy::decisions(
            (new DeviceIpAddressRepository($this->db))->getIpRecords(),
            $this->db->query('SELECT * FROM address_spaces ORDER BY id')->fetchAll(PDO::FETCH_ASSOC)
        );
    }

    private static function identity(array $decision, int $deviceId): array
    {
        $rows = [];
        foreach ($decision['records'] as $r) {
            if ($decision['reason_code'] === 'unreachable'
                && ((int)$r['device_id'] !== $deviceId || $r['kind'] !== 'management')) { continue; }
            $rows[] = [$r['device_id'], $r['kind'], $r['ip'], $r['segment_id'], $r['address_space_id'], $r['ping_reachability']];
        }
        sort($rows);
        return [$decision['reason_code'], $rows];
    }

    public function reconcile(array $before, bool $incrementRevision = true): array
    {
        $results = [];
        foreach ($this->snapshot() as $id => $decision) {
            if ($decision['allowed'] || (isset($before[$id]) && self::identity($before[$id], (int)$id) === self::identity($decision, (int)$id))) { continue; }
            $results[] = ['id' => $id, 'status' => 'unknown', 'checked_at' => null,
                'response_ms' => null, 'error' => $decision['error']];
        }
        $count = (new DeviceRepository($this->db))->updateMonitorStatuses($results);
        if ($count > 0 && $incrementRevision) { (new AppMetaRepository($this->db))->incrementMonitorRevision(); }
        return array_column($results, 'id');
    }
}
