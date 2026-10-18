<?php
declare(strict_types=1);

namespace Netarium\Repositories;

use PDO;

class FloorPlanRepository
{
    private PDO $db;

    public function __construct(PDO $db)
    {
        $this->db = $db;
    }

    /**
     * 全ビューのフロア図面情報一覧を取得
     */
    public function getAll(): array
    {
        $floorPlans = $this->db->query("
            SELECT
                view_id,
                original_name,
                mime_type,
                file_size,
                image_width,
                image_height,
                x,
                y,
                scale,
                opacity,
                is_visible,
                revision,
                created_at,
                updated_at
            FROM view_floor_plans
            ORDER BY view_id
        ")->fetchAll();

        foreach ($floorPlans as &$floorPlan) {
            $viewId = (int)$floorPlan['view_id'];
            $floorPlanRevision = (int)$floorPlan['revision'];

            $floorPlan['image_url'] =
                'floor_plan.php?view_id=' .
                rawurlencode((string)$viewId) .
                '&v=' .
                rawurlencode((string)$floorPlanRevision) .
                '&cache_policy=200-1';
        }
        unset($floorPlan);

        return $floorPlans;
    }

    /**
     * 特定ビューのフロア図面情報を取得
     */
    public function getByViewId(int $viewId): ?array
    {
        $stmt = $this->db->prepare("
            SELECT
                view_id,
                stored_name,
                original_name,
                mime_type,
                file_size,
                image_width,
                image_height,
                x,
                y,
                scale,
                opacity,
                is_visible,
                revision,
                created_at,
                updated_at
            FROM view_floor_plans
            WHERE view_id = :view_id
        ");

        $stmt->execute([':view_id' => $viewId]);
        $row = $stmt->fetch();

        return $row ?: null;
    }

    /**
     * フロア図面の新規登録または差し替え
     */
    public function upsert(array $data): void
    {
        $stmt = $this->db->prepare("
            INSERT INTO view_floor_plans (
                view_id,
                stored_name,
                original_name,
                mime_type,
                file_size,
                sha256,
                image_width,
                image_height,
                x,
                y,
                scale,
                opacity,
                is_visible,
                revision,
                created_at,
                updated_at
            ) VALUES (
                :view_id,
                :stored_name,
                :original_name,
                :mime_type,
                :file_size,
                :sha256,
                :image_width,
                :image_height,
                0,
                0,
                1,
                1,
                1,
                :revision,
                :created_at,
                :updated_at
            )
            ON CONFLICT(view_id)
            DO UPDATE SET
                stored_name = excluded.stored_name,
                original_name = excluded.original_name,
                mime_type = excluded.mime_type,
                file_size = excluded.file_size,
                sha256 = excluded.sha256,
                image_width = excluded.image_width,
                image_height = excluded.image_height,
                revision = excluded.revision,
                updated_at = excluded.updated_at
        ");

        $stmt->execute([
            ':view_id' => $data['view_id'],
            ':stored_name' => $data['stored_name'],
            ':original_name' => $data['original_name'],
            ':mime_type' => $data['mime_type'],
            ':file_size' => $data['file_size'],
            ':sha256' => $data['sha256'],
            ':image_width' => $data['image_width'],
            ':image_height' => $data['image_height'],
            ':revision' => $data['revision'],
            ':created_at' => $data['created_at'],
            ':updated_at' => $data['updated_at'],
        ]);
    }

    /**
     * フロア図面レコードの削除
     */
    public function delete(int $viewId): void
    {
        $stmt = $this->db->prepare("
            DELETE FROM view_floor_plans
            WHERE view_id = :view_id
        ");

        $stmt->execute([':view_id' => $viewId]);
    }

    /**
     * フロア図面の表示設定更新
     */
    public function updateSettings(
        int $viewId,
        float $x,
        float $y,
        float $scale,
        float $opacity,
        int $isVisible,
        int $revision,
        string $updatedAt
    ): void {
        $stmt = $this->db->prepare("
            UPDATE view_floor_plans
            SET
                x = :x,
                y = :y,
                scale = :scale,
                opacity = :opacity,
                is_visible = :is_visible,
                revision = :revision,
                updated_at = :updated_at
            WHERE view_id = :view_id
        ");

        $stmt->execute([
            ':view_id' => $viewId,
            ':x' => $x,
            ':y' => $y,
            ':scale' => $scale,
            ':opacity' => $opacity,
            ':is_visible' => $isVisible,
            ':revision' => $revision,
            ':updated_at' => $updatedAt,
        ]);
    }
}
