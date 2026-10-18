<?php
declare(strict_types=1);

namespace Netarium\Repositories;

use PDO;
use Netarium\Core\ApiException;
use Netarium\Core\ResourceId;

class DeviceImageRepository
{
    private PDO $db;

    public function __construct(PDO $db)
    {
        $this->db = $db;
    }

    /**
     * 機器IDに紐づく画像一覧を表示順で取得
     */
    public function getByDeviceId(int $deviceId): array
    {
        $stmt = $this->db->prepare("
            SELECT
                id,
                device_id,
                stored_name,
                mime_type,
                file_size,
                image_width,
                image_height,
                caption,
                sort_order,
                created_at,
                updated_at
            FROM device_images
            WHERE device_id = :device_id
            ORDER BY sort_order ASC, id ASC
        ");

        $stmt->execute([':device_id' => $deviceId]);
        return $stmt->fetchAll(PDO::FETCH_ASSOC);
    }

    /**
     * ID指定で画像を取得
     */
    public function getById(int $id): ?array
    {
        $stmt = $this->db->prepare("
            SELECT
                id,
                device_id,
                stored_name,
                mime_type,
                file_size,
                image_width,
                image_height,
                caption,
                sort_order,
                created_at,
                updated_at
            FROM device_images
            WHERE id = :id
        ");

        $stmt->execute([':id' => $id]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row === false ? null : $row;
    }

    /**
     * 全画像を取得
     */
    public function getAll(): array
    {
        return $this->db->query("
            SELECT
                id,
                device_id,
                stored_name,
                mime_type,
                file_size,
                image_width,
                image_height,
                caption,
                sort_order,
                created_at,
                updated_at
            FROM device_images
            ORDER BY device_id ASC, sort_order ASC, id ASC
        ")->fetchAll(PDO::FETCH_ASSOC);
    }

    /**
     * 機器画像の合計件数と総バイト数を集計
     */
    public function getTotalUsage(): array
    {
        $row = $this->db->query("
            SELECT
                COUNT(*) AS total_count,
                COALESCE(SUM(file_size), 0) AS total_bytes
            FROM device_images
        ")->fetch(PDO::FETCH_ASSOC);

        return [
            'count' => (int)($row['total_count'] ?? 0),
            'bytes' => (int)($row['total_bytes'] ?? 0),
        ];
    }

    /**
     * 画像を新規登録
     */
    public function insert(
        int $deviceId,
        string $storedName,
        string $mimeType,
        int $fileSize,
        int $imageWidth,
        int $imageHeight,
        string $caption,
        int $sortOrder,
        string $createdAt,
        string $updatedAt
    ): int {
        $maxId = ResourceId::MAX;
        $stmt = $this->db->prepare("
            INSERT INTO device_images (
                device_id,
                stored_name,
                mime_type,
                file_size,
                image_width,
                image_height,
                caption,
                sort_order,
                created_at,
                updated_at
            ) SELECT
                :device_id,
                :stored_name,
                :mime_type,
                :file_size,
                :image_width,
                :image_height,
                :caption,
                :sort_order,
                :created_at,
                :updated_at
            WHERE COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'device_images'), 0) < {$maxId}
                AND COALESCE((SELECT MAX(id) FROM device_images), 0) < {$maxId}
        ");

        $stmt->execute([
            ':device_id' => $deviceId,
            ':stored_name' => $storedName,
            ':mime_type' => $mimeType,
            ':file_size' => $fileSize,
            ':image_width' => $imageWidth,
            ':image_height' => $imageHeight,
            ':caption' => $caption,
            ':sort_order' => $sortOrder,
            ':created_at' => $createdAt,
            ':updated_at' => $updatedAt,
        ]);
        if ($stmt->rowCount() !== 1) {
            throw new ApiException('IDの採番余地がありません。管理者に連絡してください', 409, [
                'reason' => 'id_exhausted',
                'resource' => 'device_images',
            ]);
        }

        return (int)$this->db->lastInsertId();
    }

    /**
     * 画像の順序と説明を更新
     */
    public function updateOrderAndCaption(
        int $id,
        int $sortOrder,
        string $caption,
        string $updatedAt
    ): void {
        $stmt = $this->db->prepare("
            UPDATE device_images
            SET
                sort_order = :sort_order,
                caption = :caption,
                updated_at = :updated_at
            WHERE id = :id
        ");

        $stmt->execute([
            ':id' => $id,
            ':sort_order' => $sortOrder,
            ':caption' => $caption,
            ':updated_at' => $updatedAt,
        ]);
    }

    /**
     * 画像レコードを削除
     */
    public function delete(int $id): void
    {
        $stmt = $this->db->prepare("
            DELETE FROM device_images
            WHERE id = :id
        ");

        $stmt->execute([':id' => $id]);
    }

    /**
     * GCキューに削除予約を登録
     */
    public function enqueueGc(string $storedName, ?string $queuedAt = null): void
    {
        $stmt = $this->db->prepare("
            INSERT OR IGNORE INTO device_image_gc (
                stored_name,
                queued_at
            ) VALUES (
                :stored_name,
                :queued_at
            )
        ");

        $stmt->execute([
            ':stored_name' => $storedName,
            ':queued_at' => $queuedAt ?? date(DATE_ATOM),
        ]);
    }

    /**
     * GCキューから削除完了したエントリを削除
     */
    public function dequeueGc(string $storedName): void
    {
        $stmt = $this->db->prepare("
            DELETE FROM device_image_gc
            WHERE stored_name = :stored_name
        ");

        $stmt->execute([':stored_name' => $storedName]);
    }

    /**
     * GCキュー内のエントリ一覧を取得
     */
    public function getQueuedGc(int $limit = 100): array
    {
        $stmt = $this->db->prepare("
            SELECT stored_name, queued_at
            FROM device_image_gc
            ORDER BY queued_at ASC
            LIMIT :limit
        ");

        $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
        $stmt->execute();
        return $stmt->fetchAll(PDO::FETCH_ASSOC);
    }
}
