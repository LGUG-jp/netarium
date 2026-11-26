<?php
declare(strict_types=1);

namespace Netarium\Tests\Suites;

use Netarium\Core\Database;
use Netarium\Repositories\LinkRepository;
use Netarium\Tests\TestCase;
use PDO;

final class PortVlanMigrationTest extends TestCase
{
    public function testSchema27KeepsOnlyNonemptyCommonVlanUntilItsConnectionIsDeleted(): void
    {
        $db = new PDO('sqlite::memory:');
        Database::configure($db);
        for ($version = 1; $version <= 27; $version++) {
            ('migrateDatabaseToVersion' . $version)($db);
        }
        $db->exec(<<<'SQL'
            INSERT INTO devices (id, name, type) VALUES (1, '元スイッチ', 'switch'), (2, '対向', 'switch'), (3, '予備', 'switch');
            INSERT INTO device_ports (id, device_id, name) VALUES (11, 1, 'Gi1'), (12, 2, 'Gi2');
            INSERT INTO links (id, from_id, to_id, from_port_id, to_port_id, vlan) VALUES
                (21, 1, 2, 11, 12, ' trunk 20 '), (22, 2, 3, NULL, NULL, 'access 30'),
                (23, 1, 3, NULL, NULL, char(9, 10, 32));
            SQL);
        $linksRevision = $db->query('SELECT resource_revision FROM links WHERE id=21')->fetchColumn();
        $portRevision = $db->query('SELECT resource_revision FROM device_ports WHERE id=11')->fetchColumn();
        migrateDatabase($db);
        $repo = new LinkRepository($db);
        $this->assertSame(APP_DATABASE_SCHEMA_VERSION, $db->query('PRAGMA user_version')->fetchColumn());
        $this->assertSame([21, 22, 23], array_column($repo->getAll(), 'id'));
        $this->assertSame(false, array_key_exists('vlan', $repo->getAll()[0]));
        $this->assertSame(['', ''], array_column($repo->getDevicePorts(), 'vlan'));
        $this->assertSame([
            ['link_id' => 21, 'vlan' => ' trunk 20 '],
            ['link_id' => 22, 'vlan' => 'access 30'],
        ], $repo->getLegacyLinkVlans());
        $db->exec("UPDATE device_ports SET vlan='access 20', name='Gi9' WHERE id=11;
            UPDATE links SET label='updated' WHERE id=21");
        $this->assertTrue($db->query('SELECT resource_revision FROM links WHERE id=21')->fetchColumn() > $linksRevision);
        $this->assertTrue($db->query('SELECT resource_revision FROM device_ports WHERE id=11')->fetchColumn() > $portRevision);
        $db->exec('DELETE FROM links WHERE id=21');
        $this->assertSame([['link_id' => 22, 'vlan' => 'access 30']], $repo->getLegacyLinkVlans());
        $this->assertSame('access 20', $db->query('SELECT vlan FROM device_ports WHERE id=11')->fetchColumn());
        $db->exec('DELETE FROM devices WHERE id=2');
        migrateDatabase($db);
        $this->assertSame([], $repo->getLegacyLinkVlans());
        $this->assertSame([], $db->query('PRAGMA foreign_key_check')->fetchAll());
    }
}
