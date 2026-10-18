<?php
declare(strict_types=1);

namespace Netarium\Repositories;

use PDO;

class DeviceRepository
{
    private PDO $db;

    public function __construct(PDO $db)
    {
        $this->db = $db;
    }

    /**
     * 監視情報を含む機器一覧の取得 (load用)
     */
    public function getAllWithStatus(?array $ids = null): array
    {
        if ($ids === []) {
            return [];
        }
        $where = $ids === null ? '' : 'WHERE d.id IN (' . implode(', ', array_map('intval', $ids)) . ')';
        return $this->db->query("
            SELECT
                d.id,
                d.resource_revision,
                d.name,
                d.type,
                d.ip,
                d.x,
                d.y,
                COALESCE(m.status, 'unknown') AS status,
                m.last_checked_at,
                m.last_response_ms,
                m.last_error,
                d.facility,
                d.floor,
                d.location,
                d.manufacturer,
                d.model,
                d.asset_number,
                d.serial_number,
                d.mac_address,
                d.memo,
                d.management_scheme,
                d.management_port,
                d.department,
                d.maintenance_vendor,
                d.install_date,
                d.maintenance_expiry
            FROM devices AS d
            LEFT JOIN device_monitor_status AS m
                ON m.device_id = d.id
            {$where}
            ORDER BY d.id
        ")->fetchAll();
    }

    /**
     * CSVエクスポート用の機器一覧取得
     */
    public function getAllForCsv(): array
    {
        return $this->db->query("
            SELECT
                id,
                name,
                type,
                ip,
                facility,
                floor,
                location,
                manufacturer,
                model,
                asset_number,
                serial_number,
                mac_address,
                memo,
                management_scheme,
                management_port,
                department,
                maintenance_vendor,
                install_date,
                maintenance_expiry
            FROM devices
            ORDER BY id
        ")->fetchAll(PDO::FETCH_ASSOC);
    }

    /**
     * CSV取込比較用のIDキー連想配列取得
     */
    public function getDevicesByIdForCsvImport(): array
    {
        $rows = $this->getAllForCsv();
        $devicesById = [];

        foreach ($rows as $row) {
            $devicesById[(int)$row['id']] = $row;
        }

        return $devicesById;
    }

    /**
     * 機器IDからIPアドレスを取得
     */
    public function getIpById(int $id): ?string
    {
        $stmt = $this->db->prepare("
            SELECT ip
            FROM devices
            WHERE id = :id
        ");

        $stmt->execute([':id' => $id]);
        $ip = $stmt->fetchColumn();

        return $ip === false ? null : trim((string)$ip);
    }

    /**
     * 監視結果の一括保存
     */
    public function updateMonitorStatuses(array $results): int
    {
        $updateStmt = $this->db->prepare("
            INSERT INTO device_monitor_status (
                device_id,
                status,
                last_checked_at,
                last_response_ms,
                last_error
            )
            SELECT
                d.id,
                :status,
                :last_checked_at,
                :last_response_ms,
                :last_error
            FROM devices AS d
            WHERE d.id = :id
            ON CONFLICT(device_id)
            DO UPDATE SET
                status = excluded.status,
                last_checked_at = excluded.last_checked_at,
                last_response_ms = excluded.last_response_ms,
                last_error = excluded.last_error
        ");

        $updatedCount = 0;

        foreach ($results as $result) {
            $updateStmt->execute([
                ':id' => $result['id'],
                ':status' => $result['status'],
                ':last_checked_at' => $result['checked_at'],
                ':last_response_ms' => $result['response_ms'],
                ':last_error' => $result['error'],
            ]);

            if ($updateStmt->rowCount() > 0) {
                $updatedCount++;
            }
        }

        return $updatedCount;
    }
}
