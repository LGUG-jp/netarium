<?php
declare(strict_types=1);

namespace Netarium\Repositories;

use PDO;

class PlacementRepository
{
    private PDO $db;

    public function __construct(PDO $db)
    {
        $this->db = $db;
    }

    /**
     * 配置一覧取得
     */
    public function getAll(): array
    {
        return $this->db->query("
            SELECT
                id,
                device_id,
                view_id,
                x,
                y
            FROM device_placements
            ORDER BY id
        ")->fetchAll();
    }
}
