<?php
declare(strict_types=1);

namespace Netarium\Repositories;

use PDO;

class ViewRepository
{
    private PDO $db;

    public function __construct(PDO $db)
    {
        $this->db = $db;
    }

    /**
     * ビュー一覧取得
     */
    public function getAll(): array
    {
        return $this->db->query("
            SELECT
                id,
                resource_revision,
                name,
                facility,
                floor,
                view_type,
                sort_order,
                memo
            FROM views
            ORDER BY sort_order, id
        ")->fetchAll();
    }

    /**
     * ビューID指定取得
     */
    public function getById(int $id): ?array
    {
        $stmt = $this->db->prepare("
            SELECT
                id,
                resource_revision,
                name,
                facility,
                floor,
                view_type,
                sort_order,
                memo
            FROM views
            WHERE id = :id
        ");

        $stmt->execute([':id' => $id]);
        $row = $stmt->fetch();

        return $row ?: null;
    }
}
