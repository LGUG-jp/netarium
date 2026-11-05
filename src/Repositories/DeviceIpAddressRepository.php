<?php
declare(strict_types=1);

namespace Netarium\Repositories;

use PDO;
use Netarium\Core\ApiException;
use Netarium\Core\ResourceId;

final class DeviceIpAddressRepository
{
    public function __construct(private PDO $db) {}

    public static function normalize(array $rows, string $managementIp = '', string $prefix = ''): array
    {
        if (!array_is_list($rows)) {
            throw new ApiException($prefix . '追加IPは配列で指定してください', 400);
        }
        $managementIp = trim($managementIp);
        if ($managementIp !== '' && !filter_var($managementIp, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4)) {
            throw new ApiException($prefix . '管理IPの形式が不正です', 400);
        }
        $ips = $managementIp === '' ? [] : [$managementIp => true];
        $ids = [];
        $result = [];
        foreach ($rows as $index => $row) {
            if (!is_array($row) || !is_string($row['ip'] ?? null) || !is_string($row['label'] ?? '')) {
                throw new ApiException($prefix . '追加IPの形式が不正です', 400);
            }
            $id = $row['id'] ?? null;
            if ($id !== null && (!is_int($id) || $id <= 0 || $id > ResourceId::MAX || isset($ids[$id]))) {
                throw new ApiException($prefix . '追加IPのIDが不正または重複しています', 400);
            }
            $ip = trim($row['ip']);
            $label = trim($row['label'] ?? '');
            $order = $row['sort_order'] ?? $index;
            if (!filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4) || isset($ips[$ip])) {
                throw new ApiException($prefix . '追加IPのIPv4形式が不正、または機器内で重複しています', 400);
            }
            $labelLength = preg_match_all('/./us', $label);
            if ($labelLength === false || $labelLength > 100 || !is_int($order) || $order < 0 || $order > 2147483647) {
                throw new ApiException($prefix . '追加IPの用途は100文字以内、表示順は非負整数で指定してください', 400);
            }
            $ips[$ip] = true;
            if ($id !== null) { $ids[$id] = true; }
            $normalized = ['id' => $id, 'ip' => $ip, 'label' => $label, 'sort_order' => $order];
            if (array_key_exists('segment_id', $row)) {
                $segment = $row['segment_id'];
                if ($segment !== null && (!is_int($segment) || $segment <= 0 || $segment > ResourceId::MAX)) {
                    throw new ApiException($prefix . '所属セグメントIDが不正です', 400);
                }
                $normalized['segment_id'] = $segment;
            }
            $result[] = $normalized;
        }
        return $result;
    }

    public function getByDeviceIds(?array $ids = null): array
    {
        if ($ids === []) { return []; }
        $where = $ids === null ? '' : ' WHERE device_id IN (' . implode(',', array_map('intval', $ids)) . ')';
        $result = [];
        foreach ($this->db->query('SELECT * FROM device_ip_addresses' . $where . ' ORDER BY device_id, sort_order, id')->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $result[(int)$row['device_id']][] = ['id' => (int)$row['id'], 'ip' => $row['ip'], 'label' => $row['label'], 'sort_order' => (int)$row['sort_order'], 'segment_id' => $row['segment_id'] === null ? null : (int)$row['segment_id']];
        }
        return $result;
    }

    public function getIpRecords(): array
    {
        return $this->db->query("SELECT r.*, s.address_space_id FROM (
            SELECT d.id AS device_id, d.name AS device_name, 'management' AS kind,
            NULL AS id, d.ip AS ip, '' AS label, 0 AS sort_order, d.ip_segment_id AS segment_id FROM devices d WHERE trim(d.ip) <> ''
            UNION ALL SELECT d.id, d.name, 'additional', a.id, a.ip, a.label, a.sort_order, a.segment_id
            FROM device_ip_addresses a JOIN devices d ON d.id = a.device_id
            ) r LEFT JOIN ip_segments s ON s.id = r.segment_id
            ORDER BY device_id, kind DESC, sort_order, id")->fetchAll(PDO::FETCH_ASSOC);
    }


    // Caller owns the write transaction and revision claim. Missing rows preserve old clients' data.
    public function saveForDevice(int $deviceId, ?array $rows, string $managementIp): void
    {
        $existing = $this->getByDeviceIds([$deviceId])[$deviceId] ?? [];
        $rows = self::normalize($rows ?? $existing, $managementIp, "機器ID {$deviceId}: ");
        $owned = array_column($existing, null, 'id');
        foreach ($rows as $row) {
            if ($row['id'] !== null && !isset($owned[$row['id']])) {
                throw new ApiException('追加IPのIDは保存対象機器に所属していません', 400);
            }
        }
        $retained = array_filter(array_column($rows, 'id'), static fn($id): bool => $id !== null);
        $delete = $this->db->prepare('DELETE FROM device_ip_addresses WHERE device_id = ?' . ($retained === [] ? '' : ' AND id NOT IN (' . implode(',', array_fill(0, count($retained), '?')) . ')'));
        $delete->execute(array_merge([$deviceId], array_values($retained)));
        $insert = $this->db->prepare('INSERT INTO device_ip_addresses (device_id, ip, label, sort_order, segment_id) VALUES (?, ?, ?, ?, ?)');
        $update = $this->db->prepare('UPDATE device_ip_addresses SET ip = ?, label = ?, sort_order = ?, segment_id = ? WHERE id = ? AND device_id = ?');
        foreach ($rows as $row) {
            if ($row['id'] === null) {
                if ((int)$this->db->query('SELECT COALESCE(MAX(id), 0) FROM device_ip_addresses')->fetchColumn() >= ResourceId::MAX) {
                    throw new ApiException('追加IPのIDを採番できません', 400);
                }
                $insert->execute([$deviceId, $row['ip'], $row['label'], $row['sort_order'], $row['segment_id'] ?? null]);
            } else {
                $segment = array_key_exists('segment_id', $row) ? $row['segment_id'] : $owned[$row['id']]['segment_id'];
                $update->execute([$row['ip'], $row['label'], $row['sort_order'], $segment, $row['id'], $deviceId]);
            }
        }
    }
}
