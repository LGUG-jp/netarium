<?php
declare(strict_types=1);

namespace Netarium\Repositories;

use PDO;

class LinkRepository
{
    private PDO $db;

    public function __construct(PDO $db)
    {
        $this->db = $db;
    }

    /**
     * リンク一覧取得
     */
    public function getAll(): array
    {
        $links = $this->db->query("
            SELECT
                id,
                view_id,
                from_id,
                to_id,
                system_id,
                label,
                from_port,
                to_port,
                vlan,
                memo,
                route_mode,
                manual_route
            FROM links
            ORDER BY id
        ")->fetchAll();
        foreach ($links as &$link) {
            $link['manual_route'] = json_decode($link['manual_route'], true, 512, JSON_THROW_ON_ERROR);
        }
        unset($link);
        return $links;
    }
}
