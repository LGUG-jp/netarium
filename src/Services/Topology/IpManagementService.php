<?php
declare(strict_types=1);

namespace Netarium\Services\Topology;

use PDO;
use Throwable;
use Netarium\Core\ApiException;
use Netarium\Core\ResourceId;
use Netarium\Repositories\AppMetaRepository;
use Netarium\Repositories\DeviceRepository;
use Netarium\Repositories\DeviceIpAddressRepository;
use Netarium\Services\Monitoring\PingReachabilityMonitor;

final class IpManagementService
{
    private const MAX_CONFLICT_DETAILS = 1000;

    public function __construct(private PDO $db) {}

    public function masters(): array
    {
        return [
            'address_spaces' => $this->db->query('SELECT * FROM address_spaces ORDER BY id')->fetchAll(PDO::FETCH_ASSOC),
            'ip_segments' => $this->db->query('SELECT * FROM ip_segments ORDER BY address_space_id, id')->fetchAll(PDO::FETCH_ASSOC),
        ];
    }

    public function load(): array
    {
        $owns = !$this->db->inTransaction();
        if ($owns) { $this->db->beginTransaction(); }
        try {
            $result = array_merge(['ok' => true, 'status' => 'success', 'revision' => (new AppMetaRepository($this->db))->getDataRevision()], $this->masters(), [
                'monitor_revision' => (new AppMetaRepository($this->db))->getMonitorRevision(),
                'ip_records' => (new DeviceIpAddressRepository($this->db))->getIpRecords(),
                'devices' => (new DeviceRepository($this->db))->getAllWithStatus(),
            ]);
            if ($owns) { $this->db->commit(); }
            return $result;
        } catch (Throwable $e) {
            if ($owns && $this->db->inTransaction()) { $this->db->rollBack(); }
            throw $e;
        }
    }

    public function summary(): array
    {
        $owns = !$this->db->inTransaction();
        if ($owns) { $this->db->beginTransaction(); }
        try {
            $revision = (new AppMetaRepository($this->db))->getDataRevision();
            $counts = $this->db->query("SELECT
                (SELECT COUNT(*) FROM address_spaces) AS address_spaces,
                (SELECT COUNT(*) FROM ip_segments) AS ip_segments,
                SUM(registered_ips) AS registered_ips,
                COALESCE(SUM(unclassified_ips), 0) AS unclassified_ips
                FROM (
                    SELECT COUNT(*) AS registered_ips,
                        SUM(CASE WHEN ip_segment_id IS NULL THEN 1 ELSE 0 END) AS unclassified_ips
                    FROM devices WHERE trim(ip) <> ''
                    UNION ALL
                    SELECT COUNT(*), SUM(CASE WHEN segment_id IS NULL THEN 1 ELSE 0 END)
                    FROM device_ip_addresses WHERE trim(ip) <> ''
                )")->fetch(PDO::FETCH_ASSOC);
            $result = ['ok' => true, 'status' => 'success', 'revision' => $revision,
                'summary' => array_map('intval', $counts)];
            if ($owns) { $this->db->commit(); }
            return $result;
        } catch (Throwable $e) {
            if ($owns && $this->db->inTransaction()) { $this->db->rollBack(); }
            throw $e;
        }
    }

    public static function candidates(string $ip, array $segments): array
    {
        return array_values(array_filter($segments, static fn(array $segment): bool => Ipv4Cidr::contains($segment['cidr'], $ip)));
    }

    /** Missing membership preserves only an unchanged IP record, never a replacement's old space. */
    public function resolveDevices(array $devices, bool $csv = false): array
    {
        $old = array_column((new DeviceRepository($this->db))->getAllWithStatus(), null, 'id');
        $segments = $this->masters()['ip_segments'];
        foreach ($devices as &$device) {
            $previous = $old[$device['id']] ?? [];
            $device['ip_segment_id'] = $this->resolve($device['ip'], $device, 'ip_segment_id', $previous, 'ip', $segments);
            $existing = array_column($previous['additional_ips'] ?? [], null, 'id');
            $device['additional_ips'] = $device['additional_ips'] ?? ($previous['additional_ips'] ?? []);
            foreach ($device['additional_ips'] as &$address) {
                $before = $existing[$address['id'] ?? 0] ?? [];
                if ($csv && ($before['label'] ?? null) !== $address['label']) { $before = []; }
                $address['segment_id'] = $this->resolve($address['ip'], $address, 'segment_id', $before, 'ip', $segments);
            }
            unset($address);
        }
        unset($device);
        return $devices;
    }

    private function resolve(string $ip, array $row, string $field, array $old, string $ipField, array $segments): ?int
    {
        $explicit = array_key_exists($field, $row);
        $id = $explicit ? $row[$field] : (($old[$ipField] ?? null) === $ip ? ($old[$field] ?? null) : null);
        if ($id !== null && (!is_int($id) || $id <= 0 || $id > ResourceId::MAX)) {
            throw new ApiException('所属セグメントIDが不正です', 400);
        }
        if ($ip === '') {
            if ($id !== null && ($old[$field] ?? null) !== $id) {
                throw new ApiException('IPが空欄の機器にセグメントは指定できません', 400);
            }
            return null;
        }
        $candidates = self::candidates($ip, $segments);
        if ($id !== null) {
            foreach ($candidates as $candidate) {
                if ((int)$candidate['id'] === $id) { return $id; }
            }
            // An IP edit invalidates its old selection; an arbitrary invalid reference is an error.
            if (($old[$ipField] ?? null) !== $ip && ($old[$field] ?? null) === $id) {
                return count($candidates) === 1 ? (int)$candidates[0]['id'] : null;
            }
            throw new ApiException('所属セグメントが存在しないか、IPがCIDR範囲外です。再選択してください', 400);
        }
        if ($explicit || ($old[$ipField] ?? null) === $ip) { return null; }
        return count($candidates) === 1 ? (int)$candidates[0]['id'] : null;
    }

    public static function records(array $devices, array $segments): array
    {
        $spaces = array_column($segments, 'address_space_id', 'id');
        $records = [];
        foreach ($devices as $key => $device) {
            $deviceId = $device['id'] ?? $key;
            $addresses = array_merge([['id' => null, 'ip' => $device['ip'], 'label' => '', 'segment_id' => $device['ip_segment_id'] ?? null, 'kind' => 'management']],
                array_map(static fn(array $a): array => $a + ['kind' => 'additional'], $device['additional_ips'] ?? []));
            foreach ($addresses as $address) {
                if ($address['ip'] === '') { continue; }
                $identity = (string)$deviceId . ':' . $address['ip'];
                $records[] = $address + ['device_id' => $deviceId, 'device_name' => $device['name'], 'key' => $identity,
                    'address_space_id' => $spaces[$address['segment_id'] ?? 0] ?? null,
                    'confirmed' => ($device['ip_conflicts_confirmed'] ?? false) === true];
            }
        }
        return $records;
    }

    /**
     * Compare final state, including all unchanged devices and all IP kinds.
     * @param array<string, bool>|null $recordConfirmations Reclassification confirmations keyed by device:kind:id.
     * Null preserves the device-level confirmation contract used by device saves and CSV imports.
     */
    public function conflicts(array $finalDevices, ?array $oldDevices = null, ?array $oldSegments = null, ?array $recordConfirmations = null): array
    {
        $masters = $this->masters();
        $segments = $masters['ip_segments'];
        $spaceNames = array_column($masters['address_spaces'], 'name', 'id');
        $oldDevices ??= (new DeviceRepository($this->db))->getAllWithStatus();
        $old = self::records($oldDevices, $oldSegments ?? $segments);
        $final = self::records($finalDevices, $segments);
        if ($recordConfirmations !== null) {
            foreach ($final as &$record) {
                $recordKey = $record['device_id'] . ':' . $record['kind'] . ':' . (string)($record['id'] ?? '');
                $record['confirmed'] = ($recordConfirmations[$recordKey] ?? false) === true;
            }
            unset($record);
        }
        $before = [];
        foreach ($old as $record) { $before[$record['key']] = $record; }
        $groups = [];
        foreach ($final as $record) { $groups[$record['ip']][] = $record; }
        $errors = []; $warnings = [];
        foreach ($groups as $ip => $records) {
            $candidateLabels = array_map(static fn(array $segment): string =>
                ($spaceNames[$segment['address_space_id']] ?? '') . ' / ' . $segment['name'] . ' / ' . $segment['cidr'],
                self::candidates((string)$ip, $segments));
            foreach ($records as $i => $a) {
                foreach (array_slice($records, $i + 1) as $b) {
                    if ((string)$a['device_id'] === (string)$b['device_id']) { continue; }
                    $spaceA = $a['address_space_id']; $spaceB = $b['address_space_id'];
                    if ($spaceA !== null && $spaceB !== null && (int)$spaceA !== (int)$spaceB) { continue; }
                    $previousA = $before[$a['key']] ?? null; $previousB = $before[$b['key']] ?? null;
                    if ($previousA !== null && $previousB !== null) {
                        $sameScope = $spaceA === null || $spaceB === null
                            ? ($previousA['address_space_id'] === null || $previousB['address_space_id'] === null)
                            : ($previousA['address_space_id'] === $spaceA && $previousB['address_space_id'] === $spaceB);
                        if ($sameScope) { continue; }
                    }
                    if (count($errors) + count($warnings) >= self::MAX_CONFLICT_DETAILS) {
                        throw new ApiException('IP重複の組合せは1回の操作で最大1,000組です。重複するIPを整理するか、対象を分割してください', 400, ['reason' => 'ip_conflict_limit']);
                    }
                    $targets = array_map(static fn(array $r): array => array_intersect_key($r, array_flip(['device_id', 'device_name', 'kind', 'id', 'segment_id', 'address_space_id'])), [$a, $b]);
                    $entry = ['ip' => (string)$ip, 'targets' => $targets, 'message' => 'IP ' . $ip . ' が重複します（機器ID ' . $a['device_id'] . '「' . $a['device_name'] . '」 / 機器ID ' . $b['device_id'] . '「' . $b['device_name'] . '」）'];
                    $entry['message'] .= '。空間・セグメント候補: ' . ($candidateLabels === [] ? '該当なし' : implode('、', $candidateLabels));
                    if ($spaceA !== null && $spaceB !== null) { $errors[] = $entry; }
                    else {
                        $changedA = $previousA === null || $previousA['ip'] !== $ip || $previousA['address_space_id'] !== $spaceA;
                        $changedB = $previousB === null || $previousB['ip'] !== $ip || $previousB['address_space_id'] !== $spaceB;
                        $entry['confirmed'] = (!$changedA || $a['confirmed']) && (!$changedB || $b['confirmed']);
                        $warnings[] = $entry;
                    }
                }
            }
        }
        return ['errors' => $errors, 'warnings' => $warnings];
    }

    public function assertFinal(array $devices, ?array $oldDevices = null, ?array $oldSegments = null, ?array $recordConfirmations = null): void
    {
        $conflicts = $this->conflicts($devices, $oldDevices, $oldSegments, $recordConfirmations);
        if ($conflicts['errors'] !== []) {
            throw new ApiException('同じアドレス空間内で新たに同じIPを登録できません', 400, ['reason' => 'ip_space_conflict', 'conflicts' => $conflicts['errors']]);
        }
        $unconfirmed = array_values(array_filter($conflicts['warnings'], static fn(array $w): bool => !$w['confirmed']));
        if ($unconfirmed !== []) {
            throw new ApiException('未分類IPの重複があります。対象機器とアドレス空間を確認して保存してください', 400, ['reason' => 'ip_confirmation_required', 'warnings' => $unconfirmed]);
        }
    }

    private static function text(array $input, string $field, int $max, bool $required = false): string
    {
        if (!is_string($input[$field] ?? '')) { throw new ApiException($field . 'は文字列で指定してください', 400); }
        $value = trim($input[$field] ?? '');
        $length = preg_match_all('/./us', $value);
        if ($length === false || $length > $max || ($required && $value === '')) {
            throw new ApiException($field . 'は' . ($required ? '1〜' : '') . $max . '文字以内で指定してください', 400);
        }
        return $value;
    }

    private static function reachability(array $input, string $default = 'unset'): string
    {
        $value = array_key_exists('ping_reachability', $input) ? $input['ping_reachability'] : $default;
        if (!is_string($value) || !in_array($value, ['unset', 'reachable', 'unreachable'], true)) {
            throw new ApiException('到達性の設定値が不正です', 400);
        }
        return $value;
    }

    private function segmentRow(array $input, int $spaceId, array $segments, ?int $id = null, bool $requireName = false): array
    {
        $row = ['name' => self::text($input, 'name', 100, $requireName), 'memo' => self::text($input, 'memo', 1000)];
        if (!is_string($input['cidr'] ?? null)) { throw new ApiException('CIDRを指定してください', 400); }
        $range = Ipv4Cidr::parse($input['cidr']);
        foreach ($segments as $segment) {
            if ((int)$segment['id'] === $id || (int)$segment['address_space_id'] !== $spaceId) { continue; }
            $other = Ipv4Cidr::parse($segment['cidr']);
            if ($range['start'] <= $other['end'] && $other['start'] <= $range['end']) { throw new ApiException('同一アドレス空間内のCIDR範囲は重複できません', 400); }
        }
        $vlan = $input['vlan_id'] ?? null;
        if ($vlan !== null && (!is_int($vlan) || $vlan < 1 || $vlan > 4094)) { throw new ApiException('VLAN IDは1〜4094の整数で指定してください', 400); }
        return $row + ['address_space_id' => $spaceId, 'cidr' => $range['cidr'], 'purpose' => self::text($input, 'purpose', 100), 'facility' => self::text($input, 'facility', 100), 'vlan_id' => $vlan];
    }

    public function mutate(string $action, array $input): array
    {
        $this->db->beginTransaction();
        try {
            $revision = $input['expected_revision'] ?? null;
            if (!is_int($revision) || $revision <= 0) { throw new ApiException('expected_revisionを整数で指定してください', 400); }
            (new AppMetaRepository($this->db))->claimDataRevision($revision);
            $monitor = new PingReachabilityMonitor($this->db);
            $beforeMonitor = $monitor->snapshot();
            $oldDevices = (new DeviceRepository($this->db))->getAllWithStatus();
            $oldSegments = $this->masters()['ip_segments'];
            $affected = 0;
            $created = [];
            if ($action === 'create_ip_network') {
                $spaceRow = ['name' => self::text($input, 'name', 100, true), 'memo' => self::text($input, 'memo', 1000),
                    'ping_reachability' => self::reachability($input)];
                $this->db->prepare('INSERT INTO address_spaces (name, memo, ping_reachability) VALUES (:name, :memo, :ping_reachability)')->execute($spaceRow);
                $spaceId = (int)$this->db->lastInsertId();
                if ($spaceId > ResourceId::MAX) { throw new ApiException('IDを採番できません', 400); }
                if (!is_array($input['segment'] ?? null)) { throw new ApiException('セグメントを指定してください', 400); }
                $row = $this->segmentRow($input['segment'], $spaceId, $oldSegments, null, true);
                $this->db->prepare('INSERT INTO ip_segments (name, memo, address_space_id, cidr, purpose, facility, vlan_id) VALUES (:name, :memo, :address_space_id, :cidr, :purpose, :facility, :vlan_id)')->execute($row);
                $segmentId = (int)$this->db->lastInsertId();
                if ($segmentId > ResourceId::MAX) { throw new ApiException('IDを採番できません', 400); }
                $created = ['created_address_space_id' => $spaceId, 'created_segment_id' => $segmentId];
            } elseif ($action === 'reclassify_ips') {
                $records = $input['records'] ?? null;
                if (!is_array($records) || !array_is_list($records) || $records === []) { throw new ApiException('再分類するIPを選択してください', 400); }
                $current = (new DeviceIpAddressRepository($this->db))->getIpRecords();
                $seen = [];
                $recordConfirmations = [];
                foreach ($records as $record) {
                    if (!is_array($record) || !is_int($record['device_id'] ?? null) || !array_key_exists('segment_id', $record)) { throw new ApiException('再分類の形式が不正です', 400); }
                    $targetSegmentId = $record['segment_id'];
                    if ($targetSegmentId !== null && (!is_int($targetSegmentId) || $targetSegmentId <= 0 || $targetSegmentId > ResourceId::MAX)) { throw new ApiException('再分類の形式が不正です', 400); }
                    $fromSegmentId = array_key_exists('from_segment_id', $record) ? $record['from_segment_id'] : null;
                    if ($fromSegmentId !== null && (!is_int($fromSegmentId) || $fromSegmentId <= 0 || $fromSegmentId > ResourceId::MAX)) { throw new ApiException('再分類の形式が不正です', 400); }
                    if ($targetSegmentId === $fromSegmentId) { throw new ApiException('再分類の形式が不正です', 400); }
                    $recordKey = $record['device_id'] . ':' . (string)($record['kind'] ?? '') . ':' . (string)($record['id'] ?? '');
                    if (isset($seen[$recordKey])) { throw new ApiException('再分類の形式が不正です', 400); }
                    $seen[$recordKey] = true;
                    $found = false;
                    foreach ($current as $ip) {
                        if ($ip['device_id'] !== $record['device_id'] || $ip['kind'] !== ($record['kind'] ?? null) || $ip['id'] !== ($record['id'] ?? null)) { continue; }
                        $candidates = self::candidates($ip['ip'], $oldSegments);
                        if ($ip['segment_id'] !== $fromSegmentId || ($targetSegmentId !== null && !in_array($targetSegmentId, array_column($candidates, 'id'), true))) { throw new ApiException('再分類候補が変わりました。再読み込みしてください', 409); }
                        if ($ip['kind'] === 'management') {
                            $this->db->prepare('UPDATE devices SET ip_segment_id = ? WHERE id = ?')->execute([$targetSegmentId, $record['device_id']]);
                        } else {
                            $this->db->prepare('UPDATE device_ip_addresses SET segment_id = ? WHERE id = ? AND device_id = ?')->execute([$targetSegmentId, $record['id'], $record['device_id']]);
                        }
                        $recordConfirmations[$recordKey] = (($input['ip_conflicts_confirmed'] ?? false) === true) || (($record['ip_conflicts_confirmed'] ?? false) === true);
                        $found = true; $affected++;
                        break;
                    }
                    if (!$found) { throw new ApiException('再分類するIPが存在しません', 400); }
                }
            } else {
                $space = str_contains($action, 'address_space');
                $table = $space ? 'address_spaces' : 'ip_segments';
                $id = array_key_exists('id', $input) ? ResourceId::parse($input['id'], 'id') : null;
                $existing = null;
                if ($id !== null) {
                    $stmt = $this->db->prepare("SELECT * FROM {$table} WHERE id = ?"); $stmt->execute([$id]);
                    $existing = $stmt->fetch(PDO::FETCH_ASSOC);
                    if ($existing === false) { throw new ApiException('対象は削除されています。再読み込みしてください', 409); }
                }
                if (str_starts_with($action, 'delete_')) {
                    if ($id === null) { throw new ApiException('削除対象IDが必要です', 400); }
                    if ($space) {
                        $stmt = $this->db->prepare('SELECT COUNT(*) FROM ip_segments WHERE address_space_id = ?'); $stmt->execute([$id]);
                        if ((int)$stmt->fetchColumn() > 0) { throw new ApiException('セグメントが残るアドレス空間は削除できません', 400); }
                    } else { $affected = $this->memberCount($id); }
                    $this->db->prepare("DELETE FROM {$table} WHERE id = ?")->execute([$id]);
                } else {
                    $row = ['name' => self::text($input, 'name', 100, $space), 'memo' => self::text($input, 'memo', 1000)];
                    if ($space) { $row['ping_reachability'] = self::reachability($input, $existing['ping_reachability'] ?? 'unset'); }
                    if (!$space) {
                        $spaceId = ResourceId::parse($input['address_space_id'] ?? null, 'address_space_id');
                        $stmt = $this->db->prepare('SELECT 1 FROM address_spaces WHERE id = ?'); $stmt->execute([$spaceId]);
                        if (!$stmt->fetchColumn()) { throw new ApiException('アドレス空間が存在しません', 400); }
                        $row = $this->segmentRow($input, $spaceId, $oldSegments, $id);
                        if ($existing !== null && ($existing['cidr'] !== $row['cidr'] || $existing['address_space_id'] !== $spaceId)) {
                            foreach ((new DeviceIpAddressRepository($this->db))->getIpRecords() as $record) {
                                if ($record['segment_id'] !== $id) { continue; }
                                $inRange = Ipv4Cidr::contains($row['cidr'], $record['ip']);
                                if (!$inRange || $existing['address_space_id'] !== $spaceId) { $affected++; }
                                if ($inRange) { continue; }
                                if ($record['kind'] === 'management') { $this->db->prepare('UPDATE devices SET ip_segment_id = NULL WHERE id = ?')->execute([$record['device_id']]); }
                                else { $this->db->prepare('UPDATE device_ip_addresses SET segment_id = NULL WHERE id = ?')->execute([$record['id']]); }
                            }
                        }
                    }
                    if ($id === null) {
                        $fields = array_keys($row);
                        $this->db->prepare("INSERT INTO {$table} (" . implode(',', $fields) . ') VALUES (:' . implode(',:', $fields) . ')')->execute($row);
                        $id = (int)$this->db->lastInsertId();
                        if ($id > ResourceId::MAX) { throw new ApiException('IDを採番できません', 400); }
                    } else {
                        $assignments = array_map(static fn(string $key): string => $key . '=:' . $key, array_keys($row));
                        $row['id'] = $id;
                        $this->db->prepare("UPDATE {$table} SET " . implode(',', $assignments) . ' WHERE id=:id')->execute($row);
                    }
                }
            }
            $final = (new DeviceRepository($this->db))->getAllWithStatus();
            if ($action === 'reclassify_ips') {
                $this->assertFinal($final, $oldDevices, $oldSegments, $recordConfirmations);
            } else {
                // Unclassifying a deleted/narrowed segment is not a new IP use. Preserve existing warnings.
                $conflicts = $this->conflicts($final, $oldDevices, $oldSegments);
                if ($conflicts['errors'] !== []) { throw new ApiException('変更により同一空間内でIPが重複します', 400, ['reason' => 'ip_space_conflict', 'conflicts' => $conflicts['errors']]); }
            }
            $monitor->reconcile($beforeMonitor);
            (new AppMetaRepository($this->db))->set('last_saved_at', date(DATE_ATOM));
            $result = $this->load() + ['affected_count' => $affected] + $created;
            $this->db->commit();
            return $result;
        } catch (Throwable $e) {
            if ($this->db->inTransaction()) { $this->db->rollBack(); }
            throw $e;
        }
    }

    private function memberCount(int $id): int
    {
        $stmt = $this->db->prepare('SELECT (SELECT COUNT(*) FROM devices WHERE ip_segment_id = ?) + (SELECT COUNT(*) FROM device_ip_addresses WHERE segment_id = ?)');
        $stmt->execute([$id, $id]);
        return (int)$stmt->fetchColumn();
    }
}
