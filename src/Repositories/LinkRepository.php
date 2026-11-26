<?php
declare(strict_types=1);

namespace Netarium\Repositories;

use Netarium\Core\Request;
use PDO;

class LinkRepository
{
    public function __construct(private PDO $db)
    {
    }

    public function getAll(): array
    {
        return $this->db->query('SELECT * FROM links ORDER BY id')->fetchAll(PDO::FETCH_ASSOC);
    }

    public function getDevicePorts(): array
    {
        return $this->db->query('SELECT * FROM device_ports ORDER BY id')->fetchAll(PDO::FETCH_ASSOC);
    }

    public function getViewLinkRoutes(): array
    {
        $rows = $this->db->query('SELECT * FROM view_link_routes ORDER BY view_id, device_a_id, device_b_id')->fetchAll(PDO::FETCH_ASSOC);
        return self::decodeColumn($rows, 'manual_route');
    }

    public function getLegacyLinkConflicts(): array
    {
        $rows = $this->db->query('SELECT * FROM legacy_link_conflicts ORDER BY legacy_link_id')->fetchAll(PDO::FETCH_ASSOC);
        return self::decodeColumn($rows, 'payload');
    }

    public function getLegacyLinkVlans(): array
    {
        return $this->db->query('SELECT * FROM legacy_link_vlans ORDER BY link_id')->fetchAll(PDO::FETCH_ASSOC);
    }

    private static function decodeColumn(array $rows, string $column): array
    {
        foreach ($rows as &$row) {
            $row[$column] = Request::decodeJson($row[$column]);
        }
        unset($row);
        return $rows;
    }
}
