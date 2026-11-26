<?php
declare(strict_types=1);

namespace Netarium\Tests\Suites;

use Netarium\Core\Database;
use Netarium\Tests\TestCase;
use Netarium\Tests\TestHttpClient;
use Netarium\Tests\TestServer;
use PDO;

final class ConnectionSaveTest extends TestCase
{
    private const SAVE = '/api.php?action=save_connections';
    private const RESOLVE = '/api.php?action=resolve_legacy_link_conflict';
    private const COPY_VLAN = '/api.php?action=copy_port_vlan';
    private const COMPLETE_VLAN = '/api.php?action=complete_legacy_link_vlan';

    private function isolated(callable $test): void
    {
        $server = new TestServer();
        try {
            $server->start();
            $client = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($client->login('admin', 'admin123'));
            $db = new PDO('sqlite:' . $server->getDbPath());
            Database::configure($db);
            $test($client, $db, $server);
        } finally {
            $db = null;
            $server->stop();
        }
    }

    private function updateVlan(TestHttpClient $client, array $port, string $vlan): array
    {
        return $client->postJson(self::SAVE, ['device_ports' => [[
            'operation' => 'update', 'id' => $port['id'], 'expected_revision' => $port['resource_revision'],
            'port' => ['vlan' => $vlan],
        ]]])->assertOk()->getJson()['device_ports'][0];
    }

    private function assertAudited(TestServer $server, array $response, string $event, int $id, int $count): void
    {
        $this->assertTrue(isset($response['request_id']));
        $entries = [];
        foreach (glob($server->getTempDir() . '/logs/audit/audit-*.log') ?: [] as $file) {
            foreach (file($file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
                $entry = json_decode($line, true, flags: JSON_THROW_ON_ERROR);
                if ($entry['request_id'] === $response['request_id']) {
                    $entries[] = $entry;
                }
            }
        }
        $this->assertCount(2, $entries);
        $this->assertSame([$event, $event], array_column($entries, 'event'));
        $this->assertSame(['started', 'success'], array_column($entries, 'outcome'));
        $this->assertSame($id, $entries[1]['target_id']);
        $this->assertSame($count, $entries[1]['target_count']);
    }

    public function testMigrationMergesExactReversedLinksAndHoldsWholeCollisionGroups(): void
    {
        $db = new PDO('sqlite::memory:');
        Database::configure($db);
        for ($version = 1; $version <= 26; $version++) {
            ('migrateDatabaseToVersion' . $version)($db);
        }
        $db->exec("INSERT INTO views (id,name) VALUES (1,'ビュー 1'),(2,'ビュー 2'),(3,'ビュー 3')");
        for ($id = 1; $id <= 8; $id++) {
            $db->exec("INSERT INTO devices(id,name,type) VALUES ({$id},'機器 {$id}','switch')");
        }
        $db->exec(<<<'SQL'
            INSERT INTO links (id,view_id,from_id,to_id,from_port,to_port,label,vlan,route_mode,manual_route) VALUES
                (1,1,2,1,'Ｇｉ２',' Ｇｉ１　１ ','同一','trunk 10,20','manual','[{"x":30,"y":5},{"x":10,"y":5}]'),
                (2,2,1,2,'Gi1  1','Gi2','同一','trunk 10,20','manual','[]'),
                (3,1,1,3,'衝突','WAN','','access 30','auto','[]'),
                (4,2,4,1,'','衝突','','','auto','[]'),
                (5,3,5,1,'','衝突','','','auto','[]'),
                (6,1,6,7,'A','B','属性差 A','','auto','[]'),
                (7,2,7,6,'B','A','属性差 B','','manual','[{"x":10,"y":5}]'),
                (8,1,7,8,'','P51','','','auto','[]'),
                (9,2,7,8,'','P51','','','auto','[]'),
                (10,1,5,8,'','単独','','','auto','[]'),
                (11,1,4,8,'D','X','','','auto','[]'),
                (12,1,8,4,'X','D','','','auto','[]');
            UPDATE resource_sequences SET value=33 WHERE name='links';
            SQL);
        \migrateDatabase($db);
        $this->assertSame(APP_DATABASE_SCHEMA_VERSION, $db->query('PRAGMA user_version')->fetchColumn());
        $repo = new \Netarium\Repositories\LinkRepository($db);
        $this->assertSame([1, 10], array_column($repo->getAll(), 'id'));
        $this->assertSame(['Gi2', 'Gi1 1', '単独'], array_column($repo->getDevicePorts(), 'name'));
        $this->assertSame(['', '', ''], array_column($repo->getDevicePorts(), 'vlan'));
        $this->assertFalse(array_key_exists('vlan', $repo->getAll()[0]));
        $this->assertSame([['link_id' => 1, 'vlan' => 'trunk 10,20']], $repo->getLegacyLinkVlans());
        $this->assertSame([
            ['view_id' => 1, 'device_a_id' => 1, 'device_b_id' => 2, 'manual_route' => [['x' => 10, 'y' => 5], ['x' => 30, 'y' => 5]]],
            ['view_id' => 2, 'device_a_id' => 1, 'device_b_id' => 2, 'manual_route' => []],
        ], $repo->getViewLinkRoutes());
        $held = $repo->getLegacyLinkConflicts();
        $this->assertSame([3, 4, 5, 6, 7, 8, 9, 11, 12], array_column($held, 'legacy_link_id'));
        $this->assertSame(['port_collision', 'port_collision', 'port_collision'], array_column(array_slice($held, 0, 3), 'reason'));
        $this->assertSame('access 30', $held[0]['payload']['vlan']);
        $this->assertSame([['x' => 10, 'y' => 5]], $held[4]['payload']['manual_route']);
        $this->assertSame('属性差 B', $held[4]['payload']['label']);
        $this->assertSame(['total' => 12, 'converted' => 3, 'held' => 9],
            json_decode($db->query("SELECT meta_value FROM app_meta WHERE meta_key='legacy_link_migration'")->fetchColumn(), true));
        $this->assertSame(33, $db->query("SELECT value FROM resource_sequences WHERE name='links'")->fetchColumn());
        $this->assertSame([1, 1, 1], $db->query('SELECT show_connections FROM views ORDER BY id')->fetchAll(PDO::FETCH_COLUMN));
        $this->assertSame([], $db->query('PRAGMA foreign_key_check')->fetchAll());
    }

    public function testCreatesAndUpdatesPortsAtomicallyWithCommonLinksAndDeviceHistory(): void
    {
        $this->isolated(function (TestHttpClient $client, PDO $db, TestServer $server): void {
            $viewer = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($viewer->login('viewer', 'viewer123'));
            $payload = [
                'device_ports' => [['operation' => 'create', 'id' => 90, 'port' => [
                    'device_id' => 3, 'name' => 'ＬＡＮ　１', 'memo' => '自機', 'vlan' => 'access 40',
                ]]],
                'links' => [['operation' => 'create', 'id' => 91, 'link' => [
                    'from_id' => 3, 'to_id' => 4, 'from_port_name' => 'LAN  1', 'to_port_name' => ' ＷＡＮ１ ',
                ]]],
            ];
            $viewer->postJson(self::SAVE, $payload)->assertError(403);
            $client->postJson(self::SAVE, $payload, ['X-CSRF-Token' => 'incorrect'])->assertError(403);
            $viewRevision = $db->query('SELECT resource_revision FROM views WHERE id=1')->fetchColumn();
            $legacyPayload = $payload;
            $legacyPayload['links'][0]['link']['vlan'] = '40';
            $client->postJson(self::SAVE, $legacyPayload)->assertError(400);
            $created = $client->postJson(self::SAVE, $payload)->assertOk()->getJson();
            $link = $created['links'][0];
            $port = $created['device_ports'][0];
            $this->assertSame($link['id'], $created['id_maps']['links'][91]);
            $this->assertSame($port['id'], $created['id_maps']['device_ports'][90]);
            $this->assertSame($port['id'], $link['from_port_id']);
            $this->assertSame(['LAN 1', 'WAN1'], array_column($created['device_ports'], 'name'));
            $this->assertSame(['access 40', ''], array_column($created['device_ports'], 'vlan'));
            $this->assertFalse(array_key_exists('vlan', $link));
            $client->postJson(self::SAVE, ['links' => [['operation' => 'update', 'id' => $link['id'],
                'expected_revision' => $link['resource_revision'], 'link' => ['vlan' => null]]]])->assertError(400);
            $this->assertSame($viewRevision, $db->query('SELECT resource_revision FROM views WHERE id=1')->fetchColumn());
            $history = $db->query('SELECT event_id,target_type,target_id FROM change_history ORDER BY target_id')->fetchAll();
            $this->assertSame([3, 4], array_column($history, 'target_id'));
            $this->assertSame(['device', 'device'], array_column($history, 'target_type'));
            $this->assertSame($history[0]['event_id'], $history[1]['event_id']);

            $change = ['device_ports' => [['operation' => 'update', 'id' => $port['id'],
                'expected_revision' => $port['resource_revision'], 'port' => ['name' => 'lan1']]]];
            $renamed = $client->postJson(self::SAVE, $change)->assertOk()->getJson()['device_ports'][0];
            $this->assertSame($port['id'], $renamed['id']);
            $this->assertSame('lan1', $renamed['name']);
            $this->assertSame('access 40', $renamed['vlan']);
            $this->assertNotSame($port['resource_revision'], $renamed['resource_revision']);
            $stale = $client->postJson(self::SAVE, $change)->assertError(409)->getJson();
            $this->assertSame('device_ports', $stale['details']['conflicts'][0]['resource']);
            $loaded = $client->get('/api.php?action=load')->assertOk()->getJson();
            $this->assertSame($link, $loaded['links'][1]);
            $client->postJson(self::SAVE, ['device_ports' => [['operation' => 'delete', 'id' => $port['id'],
                'expected_revision' => $renamed['resource_revision']]]])->assertError(400);
            $client->postJson(self::SAVE, ['links' => [['operation' => 'delete', 'id' => $link['id'],
                'expected_revision' => $link['resource_revision']]]])->assertOk();
            $this->assertSame(4, $db->query('SELECT COUNT(*) FROM device_ports')->fetchColumn());
            $client->postJson(self::SAVE, ['device_ports' => [['operation' => 'delete', 'id' => $port['id'],
                'expected_revision' => $renamed['resource_revision']]]])->assertOk();
            $this->assertSame(3, $db->query('SELECT COUNT(*) FROM device_ports')->fetchColumn());
            $this->assertSame('', $db->query('SELECT vlan FROM device_ports WHERE id=' . $link['to_port_id'])->fetchColumn());
        });
    }

    public function testValidatesAndClearsVlanOnAnUnconnectedPort(): void
    {
        $this->isolated(function (TestHttpClient $client, PDO $db): void {
            $value = str_repeat('仮😀', 100);
            $created = $client->postJson(self::SAVE, ['device_ports' => [[
                'operation' => 'create', 'port' => ['device_id' => 3, 'name' => 'LAN1', 'vlan' => $value],
            ]]])->assertOk()->getJson();
            $port = $created['device_ports'][0];
            $this->assertSame($value, $port['vlan']);
            $this->assertSame([], $created['links']);
            foreach ([$value . '😀', "access\n10", "access\u{2028}10", "\raccess 10", null] as $invalid) {
                $client->postJson(self::SAVE, ['device_ports' => [[
                    'operation' => 'update', 'id' => $port['id'], 'expected_revision' => $port['resource_revision'],
                    'port' => ['vlan' => $invalid],
                ]]])->assertError(400);
            }
            $this->assertSame($created['revision'], (int)$db->query(
                "SELECT meta_value FROM app_meta WHERE meta_key='data_revision'"
            )->fetchColumn());
            $edited = $this->updateVlan($client, $port, '  native 20  ');
            $this->assertSame('native 20', $edited['vlan']);
            $cleared = $this->updateVlan($client, $edited, '');
            $this->assertSame('', $cleared['vlan']);
            $entries = $client->get('/api.php?action=load_change_history&target_type=device&target_id=3')->assertOk()->getJson()['items'];
            $this->assertSame([['label' => "ポート: LAN1 (ID: {$port['id']})", 'before' => 'LAN1 / VLAN:native 20', 'after' => 'LAN1']],
                $entries[0]['items']);
        });
    }

    public function testCopiesVlanInEitherDirectionAndDoesNotSaveEmptyOrEqualValues(): void
    {
        $this->isolated(function (TestHttpClient $client, PDO $db, TestServer $server): void {
            [$from, $to] = $db->query('SELECT * FROM device_ports ORDER BY id')->fetchAll(PDO::FETCH_ASSOC);
            $link = $db->query('SELECT * FROM links WHERE id=1')->fetch(PDO::FETCH_ASSOC);
            $copy = static fn(array $source, array $destination): array => [
                'link_id' => $link['id'], 'source_port_id' => $source['id'], 'destination_port_id' => $destination['id'],
                'source_expected_revision' => $source['resource_revision'],
                'destination_expected_revision' => $destination['resource_revision'],
            ];
            $viewer = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($viewer->login('viewer', 'viewer123'));
            $viewer->postJson(self::COPY_VLAN, $copy($to, $from))->assertError(403);
            $client->postJson(self::COPY_VLAN, $copy($to, $from), ['X-CSRF-Token' => 'incorrect'])->assertError(403);
            $client->get(self::COPY_VLAN)->assertError(405);

            $revision = static fn(): int => (int)$db->query("SELECT meta_value FROM app_meta WHERE meta_key='data_revision'")->fetchColumn();
            $before = $revision();
            $client->postJson(self::COPY_VLAN, $copy($to, $from))->assertError(400);
            $this->assertSame($before, $revision());
            $this->assertSame([$from, $to], $db->query('SELECT * FROM device_ports ORDER BY id')->fetchAll(PDO::FETCH_ASSOC));

            $to = $this->updateVlan($client, $to, 'trunk allowed 10,20');
            $before = $revision();
            $historyBeforeCopy = $db->query('SELECT COUNT(*) FROM change_history')->fetchColumn();
            $db->exec("CREATE TRIGGER test_copy_history_failure BEFORE INSERT ON change_history
                BEGIN SELECT RAISE(ABORT, 'test copy history failure'); END");
            $client->postJson(self::COPY_VLAN, $copy($to, $from))->assertError(500);
            $db->exec('DROP TRIGGER test_copy_history_failure');
            $this->assertSame($before, $revision());
            $this->assertSame([$from, $to], $db->query('SELECT * FROM device_ports ORDER BY id')->fetchAll(PDO::FETCH_ASSOC));
            $this->assertSame($historyBeforeCopy, $db->query('SELECT COUNT(*) FROM change_history')->fetchColumn());
            $saved = $client->postJson(self::COPY_VLAN, $copy($to, $from))->assertOk()->getJson();
            $this->assertFalse($saved['unchanged']);
            $this->assertSame($before + 1, $saved['revision']);
            $this->assertSame([$link], $saved['links']);
            $this->assertSame(['device_ports' => [], 'links' => []], $saved['id_maps']);
            foreach (['deleted_link_ids', 'deleted_device_port_ids', 'removed_view_link_routes', 'views'] as $field) {
                $this->assertSame([], $saved[$field]);
            }
            [$updatedFrom, $unchangedTo] = $saved['device_ports'];
            $this->assertSame($to, $unchangedTo);
            $this->assertNotSame($from['resource_revision'], $updatedFrom['resource_revision']);
            $this->assertSame($to['vlan'], $updatedFrom['vlan']);
            $this->assertAudited($server, $saved, 'topology.copy_port_vlan', $from['id'], 1);
            $entry = $client->get('/api.php?action=load_change_history&target_type=device&target_id=1')->assertOk()->getJson()['items'][0];
            $this->assertSame($saved['request_id'], $entry['request_id']);
            $this->assertSame([['label' => 'ポート: ge0/1 (ID: 1)', 'before' => 'ge0/1', 'after' => 'ge0/1 / VLAN:trunk allowed 10,20']],
                $entry['items']);
            $historyCount = $db->query('SELECT COUNT(*) FROM change_history')->fetchColumn();
            $equal = $client->postJson(self::COPY_VLAN, $copy($updatedFrom, $to))->assertOk()->getJson();
            $this->assertTrue($equal['unchanged']);
            $this->assertSame($saved['revision'], $equal['revision']);
            $this->assertSame($saved['saved_at'], $equal['saved_at']);
            $this->assertSame($saved['device_ports'], $equal['device_ports']);
            $this->assertSame($saved['device_ports'], $db->query('SELECT * FROM device_ports ORDER BY id')->fetchAll(PDO::FETCH_ASSOC));
            $this->assertSame($historyCount, $db->query('SELECT COUNT(*) FROM change_history')->fetchColumn());
            $this->assertAudited($server, $equal, 'topology.copy_port_vlan', $to['id'], 0);

            $updatedFrom = $this->updateVlan($client, $updatedFrom, 'access 10');
            $reverse = $client->postJson(self::COPY_VLAN, $copy($updatedFrom, $to))->assertOk()->getJson();
            $this->assertFalse($reverse['unchanged']);
            $this->assertSame($updatedFrom, $reverse['device_ports'][0]);
            $this->assertSame('access 10', $reverse['device_ports'][1]['vlan']);
        });
    }

    public function testCopyRefusesChangedSourceDestinationOrConnectionEndpoints(): void
    {
        $this->isolated(function (TestHttpClient $client, PDO $db): void {
            [$source, $destination] = $db->query('SELECT * FROM device_ports ORDER BY id')->fetchAll(PDO::FETCH_ASSOC);
            $source = $this->updateVlan($client, $source, 'access 10');
            $link = $db->query('SELECT * FROM links WHERE id=1')->fetch(PDO::FETCH_ASSOC);
            $copy = [
                'link_id' => $link['id'], 'source_port_id' => $source['id'], 'destination_port_id' => $destination['id'],
                'source_expected_revision' => $source['resource_revision'],
                'destination_expected_revision' => $destination['resource_revision'],
            ];
            $state = static fn(): array => [
                $db->query("SELECT meta_value FROM app_meta WHERE meta_key='data_revision'")->fetchColumn(),
                $db->query('SELECT * FROM device_ports ORDER BY id')->fetchAll(PDO::FETCH_ASSOC),
                $db->query('SELECT COUNT(*) FROM change_history')->fetchColumn(),
            ];
            $updatedSource = $this->updateVlan($client, $source, 'access 20');
            $before = $state();
            $conflict = $client->postJson(self::COPY_VLAN, $copy)->assertError(409)->getJson();
            $this->assertSame([['resource' => 'device_ports', 'id' => $source['id'],
                'expected_revision' => $source['resource_revision'], 'actual_revision' => $updatedSource['resource_revision']]],
                $conflict['details']['conflicts']);
            $this->assertSame($before, $state());
            $copy['source_expected_revision'] = $updatedSource['resource_revision'];

            $updatedDestination = $this->updateVlan($client, $destination, 'access 30');
            $before = $state();
            $conflict = $client->postJson(self::COPY_VLAN, $copy)->assertError(409)->getJson();
            $this->assertSame([['resource' => 'device_ports', 'id' => $destination['id'],
                'expected_revision' => $destination['resource_revision'], 'actual_revision' => $updatedDestination['resource_revision']]],
                $conflict['details']['conflicts']);
            $this->assertSame($before, $state());
            $copy['destination_expected_revision'] = $updatedDestination['resource_revision'];

            $client->postJson(self::SAVE, ['links' => [[
                'operation' => 'update', 'id' => $link['id'], 'expected_revision' => $link['resource_revision'],
                'link' => ['to_port_name' => 'ge0/25'],
            ]]])->assertOk();
            $before = $state();
            $conflict = $client->postJson(self::COPY_VLAN, $copy)->assertError(409)->getJson();
            $this->assertSame('link_endpoints_changed', $conflict['details']['reason']);
            $this->assertSame($before, $state());
        });
    }

    public function testReconfiguresUnmigratedVlanWithAnUnspecifiedPortInOneSave(): void
    {
        $this->isolated(function (TestHttpClient $client, PDO $db, TestServer $server): void {
            $db->exec("INSERT INTO links (id, from_id, to_id) VALUES (100, 3, 4);
                INSERT INTO legacy_link_vlans VALUES (1, 'old trunk'), (100, 'old access')");
            $linkRevision = $db->query('SELECT resource_revision FROM links WHERE id=100')->fetchColumn();
            $revision = (int)$db->query("SELECT meta_value FROM app_meta WHERE meta_key='data_revision'")->fetchColumn();
            $save = [
                'complete_legacy_vlan' => 100,
                'device_ports' => [['operation' => 'create', 'id' => 90, 'port' => [
                    'device_id' => 3, 'name' => 'LAN 1', 'vlan' => 'access 30',
                ]]],
                'links' => [['operation' => 'update', 'id' => 100, 'expected_revision' => $linkRevision,
                    'link' => ['from_port_name' => 'LAN 1']]],
            ];
            $viewer = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($viewer->login('viewer', 'viewer123'));
            $viewer->postJson(self::SAVE, $save)->assertError(403);
            $client->postJson(self::SAVE, $save, ['X-CSRF-Token' => 'incorrect'])->assertError(403);
            $result = $client->postJson(self::SAVE, $save)->assertOk()->getJson();
            $this->assertSame($revision + 1, $result['revision']);
            $this->assertSame(100, $result['completed_legacy_vlan_link_id']);
            $port = $result['device_ports'][0];
            $this->assertSame($result['id_maps']['device_ports'][90], $port['id']);
            $this->assertSame($port['id'], $result['links'][0]['from_port_id']);
            $this->assertNull($result['links'][0]['to_port_id']);
            $this->assertSame('access 30', $port['vlan']);
            $this->assertSame([1], array_column(
                $viewer->get('/api.php?action=load')->assertOk()->getJson()['legacy_link_vlans'], 'link_id'
            ));
            $history = $db->prepare('SELECT target_id, changes_json FROM change_history WHERE request_id = ? ORDER BY target_id');
            $history->execute([$result['request_id']]);
            $entries = $history->fetchAll(PDO::FETCH_ASSOC);
            $this->assertSame([3, 4], array_column($entries, 'target_id'));
            $this->assertTrue(str_contains($entries[0]['changes_json'], 'access 30'));
            $this->assertAudited($server, $result, 'topology.save_connections', 100, 1);
        });
    }

    public function testReconfiguresOnlySelectedEndpointAndRollsBackOnFailure(): void
    {
        $this->isolated(function (TestHttpClient $client, PDO $db): void {
            $db->exec("INSERT INTO links (id, from_id, to_id) VALUES (100, 3, 4);
                INSERT INTO legacy_link_vlans VALUES (1, 'old trunk')");
            $ports = $db->query('SELECT * FROM device_ports ORDER BY id')->fetchAll(PDO::FETCH_ASSOC);
            $peer = $this->updateVlan($client, $ports[1], 'trunk 40,50');
            $links = $db->query('SELECT id, resource_revision FROM links')->fetchAll(PDO::FETCH_KEY_PAIR);
            $state = static fn(): array => [
                $db->query("SELECT * FROM app_meta WHERE meta_key IN ('data_revision','last_saved_at') ORDER BY meta_key")->fetchAll(),
                $db->query('SELECT * FROM legacy_link_vlans ORDER BY link_id')->fetchAll(),
                $db->query('SELECT * FROM device_ports ORDER BY id')->fetchAll(),
                $db->query('SELECT * FROM links ORDER BY id')->fetchAll(),
                $db->query('SELECT * FROM resource_sequences ORDER BY name')->fetchAll(),
                $db->query('SELECT * FROM change_history ORDER BY id')->fetchAll(),
            ];
            $update = ['operation' => 'update', 'id' => $ports[0]['id'],
                'expected_revision' => $ports[0]['resource_revision'], 'port' => ['vlan' => ' access 10 ']];
            $link = ['operation' => 'update', 'id' => 1, 'expected_revision' => $links[1], 'link' => ['memo' => '移行済み']];
            $save = ['complete_legacy_vlan' => 1, 'device_ports' => [$update], 'links' => [$link]];
            $before = $state();
            foreach ([null, false, '1', [1], 0, 100] as $marker) {
                $client->postJson(self::SAVE, array_replace($save, ['complete_legacy_vlan' => $marker]))->assertError(400);
            }
            foreach ([
                [],
                [['operation' => 'delete', 'id' => 1, 'expected_revision' => $links[1]]],
                [$link, array_replace($link, ['id' => 100, 'expected_revision' => $links[100]])],
                [array_replace($link, ['expected_revision' => null])],
            ] as $badLinks) {
                $client->postJson(self::SAVE, array_replace($save, ['links' => $badLinks]))->assertError(400);
            }
            foreach ([
                [array_replace($update, ['port' => ['vlan' => "10\n20"]])],
                [$update, ['operation' => 'create', 'port' => ['device_id' => 1, 'name' => 'unused']]],
                [$update, ['operation' => 'create', 'port' => [
                    'device_id' => $peer['device_id'], 'name' => $peer['name'], 'vlan' => 'overwrite',
                ]]],
                [$update, ['operation' => 'delete', 'id' => $peer['id'], 'expected_revision' => $peer['resource_revision']]],
            ] as $badPorts) {
                $client->postJson(self::SAVE, array_replace($save, ['device_ports' => $badPorts]))->assertError(400);
            }
            $missing = $client->postJson(self::SAVE, ['complete_legacy_vlan' => 100, 'links' => [
                array_replace($link, ['id' => 100, 'expected_revision' => $links[100]]),
            ]])->assertError(409)->getJson();
            $this->assertSame('unmigrated_vlan_missing', $missing['details']['reason']);
            $conflict = $client->postJson(self::SAVE, array_replace($save, ['links' => [
                array_replace($link, ['expected_revision' => $links[1] + 1]),
            ]]))->assertError(409)->getJson();
            $this->assertSame('links', $conflict['details']['conflicts'][0]['resource']);
            $conflict = $client->postJson(self::SAVE, array_replace($save, ['device_ports' => [
                array_replace($update, ['expected_revision' => $ports[0]['resource_revision'] + 1]),
            ]]))->assertError(409)->getJson();
            $this->assertSame('device_ports', $conflict['details']['conflicts'][0]['resource']);
            $this->assertSame($before, $state());

            $db->exec("CREATE TRIGGER test_vlan_history_failure BEFORE INSERT ON change_history
                BEGIN SELECT RAISE(ABORT, 'test VLAN history failure'); END");
            $client->postJson(self::SAVE, $save)->assertError(500);
            $db->exec('DROP TRIGGER test_vlan_history_failure');
            $this->assertSame($before, $state());

            $normal = $client->postJson(self::SAVE, ['links' => [$link]])->assertOk()->getJson();
            $this->assertArrayNotHasKey('completed_legacy_vlan_link_id', $normal);
            $this->assertSame('old trunk', $db->query('SELECT vlan FROM legacy_link_vlans WHERE link_id=1')->fetchColumn());
            $save['links'][0]['expected_revision'] = $normal['links'][0]['resource_revision'];
            $result = $client->postJson(self::SAVE, $save)->assertOk()->getJson();
            $this->assertSame(1, $result['completed_legacy_vlan_link_id']);
            $resultPorts = array_column($result['device_ports'], null, 'id');
            $this->assertSame('access 10', $resultPorts[$ports[0]['id']]['vlan']);
            $this->assertSame($peer, $resultPorts[$peer['id']]);
            $this->assertSame(0, $db->query('SELECT COUNT(*) FROM legacy_link_vlans')->fetchColumn());
        });
    }

    public function testDeletesOnlyUnmigratedVlanWithRevisionAndAuthorizationGuards(): void
    {
        $this->isolated(function (TestHttpClient $client, PDO $db, TestServer $server): void {
            $db->exec("INSERT INTO links (id, from_id, to_id) VALUES (100, 3, 4);
                INSERT INTO legacy_link_vlans VALUES (1, 'old trunk'), (100, 'old access')");
            $ports = $db->query('SELECT * FROM device_ports ORDER BY id')->fetchAll(PDO::FETCH_ASSOC);
            $this->updateVlan($client, $ports[0], 'access 30');
            $links = $db->query('SELECT id, resource_revision FROM links')->fetchAll(PDO::FETCH_KEY_PAIR);
            $revision = static fn(): int => (int)$db->query("SELECT meta_value FROM app_meta WHERE meta_key='data_revision'")->fetchColumn();
            $records = static fn(): array => $db->query('SELECT link_id, vlan FROM legacy_link_vlans ORDER BY link_id')->fetchAll(PDO::FETCH_KEY_PAIR);
            $rows = static fn(): array => [
                $db->query('SELECT * FROM device_ports ORDER BY id')->fetchAll(),
                $db->query('SELECT * FROM links ORDER BY id')->fetchAll(),
                $db->query('SELECT * FROM change_history ORDER BY id')->fetchAll(),
            ];
            $delete = ['link_id' => 1, 'expected_revision' => $revision(), 'link_expected_revision' => $links[1]];
            $beforeRows = $rows();
            $beforeRecords = $records();
            $viewer = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($viewer->login('viewer', 'viewer123'));
            $viewer->postJson(self::COMPLETE_VLAN, $delete)->assertError(403);
            $client->postJson(self::COMPLETE_VLAN, $delete, ['X-CSRF-Token' => 'incorrect'])->assertError(403);
            $client->get(self::COMPLETE_VLAN)->assertError(405);
            $client->postJson(self::COMPLETE_VLAN, array_replace($delete, ['expected_revision' => $revision() + 1]))->assertError(409);
            $client->postJson(self::COMPLETE_VLAN, array_replace($delete, ['link_expected_revision' => $links[1] + 1]))->assertError(409);
            foreach ([[], null, [['port_id' => 1, 'expected_revision' => 1, 'vlan' => 'overwrite']]] as $portChanges) {
                $client->postJson(self::COMPLETE_VLAN, $delete + ['device_ports' => $portChanges])->assertError(400);
            }
            $client->postJson(self::COMPLETE_VLAN, $delete + ['links' => []])->assertError(400);
            $this->assertSame($beforeRecords, $records());
            $this->assertSame($beforeRows, $rows());
            $this->assertSame($delete['expected_revision'], $revision());

            $result = $client->postJson(self::COMPLETE_VLAN, $delete)->assertOk()->getJson();
            $this->assertSame(1, $result['link_id']);
            $this->assertSame($delete['expected_revision'] + 1, $result['revision']);
            $this->assertArrayNotHasKey('device_ports', $result);
            $this->assertSame([100 => 'old access'], $records());
            $this->assertSame($beforeRows, $rows());
            $this->assertAudited($server, $result, 'topology.complete_legacy_link_vlan', 1, 1);
            $retry = $client->postJson(self::COMPLETE_VLAN, array_replace($delete, [
                'expected_revision' => $result['revision'],
            ]))->assertError(409)->getJson();
            $this->assertSame('unmigrated_vlan_missing', $retry['details']['reason']);
            $this->assertSame($result['revision'], $revision());
        });
    }

    public function testLegacyVlanFollowsConnectionDeletionButNotPlacementRemoval(): void
    {
        $this->isolated(function (TestHttpClient $client, PDO $db): void {
            $db->exec("INSERT INTO devices (id, name) VALUES (98, '端点 A'), (99, '端点 B');
                INSERT INTO links (id, from_id, to_id) VALUES (98, 98, 1), (99, 1, 99);
                INSERT INTO legacy_link_vlans VALUES (1, 'old trunk'), (98, 'old 98'), (99, 'old 99')");
            $load = static fn(): array => $client->get('/api.php?action=load')->assertOk()->getJson();
            $records = static fn(): array => array_column($load()['legacy_link_vlans'], 'link_id');
            $data = $load();
            $view = $data['views'][0];
            $this->assertTrue(in_array($view['id'], array_column($data['placements'], 'view_id'), true));
            $client->postJson('/api.php?action=save_resources', ['devices' => [], 'views' => [[
                'operation' => 'update', 'id' => $view['id'], 'expected_revision' => $view['resource_revision'],
                'view' => $view, 'placements' => [],
                'canvas_notes' => array_values(array_filter($data['canvas_notes'],
                    static fn(array $row): bool => $row['view_id'] === $view['id'])),
            ]]])->assertOk();
            $afterUnplace = $load();
            $this->assertFalse(in_array($view['id'], array_column($afterUnplace['placements'], 'view_id'), true));
            $this->assertSame([1, 98, 99], array_column($afterUnplace['legacy_link_vlans'], 'link_id'));

            $link = $data['links'][0];
            $ports = $data['device_ports'];
            $ports[0] = $this->updateVlan($client, $ports[0], 'access 30');
            $client->postJson(self::SAVE, ['links' => [[
                'operation' => 'delete', 'id' => $link['id'], 'expected_revision' => $link['resource_revision'],
            ]]])->assertOk();
            $this->assertSame([98, 99], $records());
            $this->assertSame($ports, $load()['device_ports']);

            $devices = array_column($load()['devices'], null, 'id');
            $deleted = $client->postJson('/api.php?action=save_resources', ['views' => [], 'devices' => [[
                'operation' => 'delete', 'id' => 98, 'expected_revision' => $devices[98]['resource_revision'],
            ]]])->assertOk()->getJson();
            $this->assertSame([98], $deleted['deleted_link_ids']);
            $this->assertSame([99], $records());

            $data = $load();
            $data['devices'] = array_values(array_filter($data['devices'], static fn(array $row): bool => $row['id'] !== 99));
            $saved = $client->postJson('/api.php?action=save', $data)->assertOk()->getJson();
            $this->assertSame([], $saved['legacy_link_vlans']);
            $this->assertSame($ports, $saved['device_ports']);
        });
    }

    public function testRejectsCrossRolePortUseAndUnspecifiedPairsWithoutPartialWrites(): void
    {
        $this->isolated(function (TestHttpClient $client, PDO $db): void {
            $before = $db->query("SELECT meta_value FROM app_meta WHERE meta_key='data_revision'")->fetchColumn();
            $try = $client->postJson(self::SAVE, ['links' => [['operation' => 'create', 'link' => [
                'from_id' => 3, 'to_id' => 1, 'from_port_name' => '新規ポート', 'to_port_id' => 1,
            ]]]])->assertError(400)->getJson();
            $this->assertSame('port_in_use', $try['details']['reason']);
            $this->assertSame(1, $try['details']['link_id']);
            $this->assertSame(2, $db->query('SELECT COUNT(*) FROM device_ports')->fetchColumn());
            $this->assertSame($before, $db->query("SELECT meta_value FROM app_meta WHERE meta_key='data_revision'")->fetchColumn());
            $client->postJson(self::SAVE, ['links' => [['operation' => 'create', 'link' => [
                'from_id' => 3, 'to_id' => 4, 'to_port_id' => 1,
            ]]]])->assertError(400);
            $first = $client->postJson(self::SAVE, ['links' => [['operation' => 'create', 'link' => [
                'from_id' => 3, 'to_id' => 4,
            ]]]])->assertOk()->getJson()['links'][0];
            $duplicate = $client->postJson(self::SAVE, ['links' => [['operation' => 'create', 'link' => [
                'from_id' => 4, 'to_id' => 3,
            ]]]])->assertError(400)->getJson();
            $this->assertSame($first['id'], $duplicate['details']['link_id']);
            $this->assertSame('unspecified_pair_exists', $duplicate['details']['reason']);
            $edited = $client->postJson(self::SAVE, ['links' => [['operation' => 'update', 'id' => $first['id'],
                'expected_revision' => $first['resource_revision'], 'link' => ['from_port_name' => 'LAN5']]]])->assertOk()->getJson();
            $this->assertSame($first['id'], $edited['links'][0]['id']);
            $client->postJson(self::SAVE, ['links' => [['operation' => 'delete', 'id' => $first['id'],
                'expected_revision' => $first['resource_revision']]]])->assertError(409);
            $client->postJson(self::SAVE, ['links' => [['operation' => 'create', 'link' => [
                'from_id' => 4, 'to_id' => 3, 'from_port_name' => 'LAN4',
            ]]]])->assertOk();
            $this->assertSame(3, $db->query('SELECT COUNT(*) FROM links')->fetchColumn());
        });
    }

    public function testRetainsManualRoutesUntilLastConnectionAndCleansUpAtomically(): void
    {
        $this->isolated(function (TestHttpClient $client, PDO $db): void {
            $db->exec("INSERT INTO view_link_routes VALUES (1,1,2,'[]'), (2,1,2,'[]')");
            $first = $db->query('SELECT * FROM links WHERE id=1')->fetch();
            $another = $client->postJson(self::SAVE, ['links' => [['operation' => 'create', 'link' => [
                'from_id' => 2, 'to_id' => 1, 'from_port_name' => 'Gi2',
            ]]]])->assertOk()->getJson()['links'][0];
            $delete = static fn(array $link): array => ['links' => [['operation' => 'delete', 'id' => $link['id'],
                'expected_revision' => $link['resource_revision']]]];
            $client->postJson(self::SAVE, $delete($first))->assertOk();
            $this->assertSame(2, $db->query('SELECT COUNT(*) FROM view_link_routes')->fetchColumn());
            $viewRevisions = $db->query('SELECT resource_revision FROM views ORDER BY id')->fetchAll(PDO::FETCH_COLUMN);
            $result = $client->postJson(self::SAVE, $delete($another))->assertOk()->getJson();
            $this->assertSame([1, 2], array_column($result['removed_view_link_routes'], 'view_id'));
            $this->assertSame($viewRevisions, array_column($result['views'], 'previous_resource_revision'));
            $this->assertSame(0, $db->query('SELECT COUNT(*) FROM view_link_routes')->fetchColumn());
            $this->assertSame(3, $db->query('SELECT COUNT(*) FROM device_ports')->fetchColumn());
        });
    }

    public function testResolvesOnlyTheSelectedLegacyRowAndCleansUpTheLastReference(): void
    {
        $this->isolated(function (TestHttpClient $client, PDO $db, TestServer $server): void {
            $db->exec("INSERT INTO legacy_link_conflicts VALUES
                (100, 1, 1, 2, 'port_collision', '{\"label\":\"旧接続 A\"}'),
                (101, 2, 1, 2, 'port_collision', '{\"label\":\"旧接続 B\"}')");
            $db->exec("INSERT INTO view_link_routes VALUES (1,1,2,'[{\"x\":40,\"y\":20}]')");
            $link = $db->query('SELECT id, resource_revision FROM links WHERE id=1')->fetch();
            $deleted = $client->postJson(self::SAVE, ['links' => [[
                'operation' => 'delete', 'id' => 1, 'expected_revision' => $link['resource_revision'],
            ]]])->assertOk()->getJson();
            $this->assertSame([], $deleted['removed_view_link_routes']);
            $this->assertSame(1, $db->query('SELECT COUNT(*) FROM view_link_routes')->fetchColumn());
            $beforeLinks = $db->query('SELECT * FROM links ORDER BY id')->fetchAll();
            $beforePorts = $db->query('SELECT * FROM device_ports ORDER BY id')->fetchAll();
            $beforeView = $db->query('SELECT resource_revision FROM views WHERE id=1')->fetchColumn();
            $revision = $deleted['revision'];
            $resolve = ['legacy_link_id' => 100, 'view_id' => 1, 'expected_revision' => $revision];

            $viewer = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($viewer->login('viewer', 'viewer123'));
            $viewer->postJson(self::RESOLVE, $resolve)->assertError(403);
            $client->postJson(self::RESOLVE, array_replace($resolve, ['view_id' => 2]))->assertError(409);
            $client->postJson(self::RESOLVE, array_replace($resolve, ['expected_revision' => $revision - 1]))->assertError(409);
            $this->assertSame([100, 101], $db->query('SELECT legacy_link_id FROM legacy_link_conflicts')->fetchAll(PDO::FETCH_COLUMN));

            $result = $client->postJson(self::RESOLVE, $resolve)->assertOk()->getJson();
            $this->assertSame($revision + 1, $result['revision']);
            $this->assertSame([], $result['removed_view_link_routes']);
            $this->assertSame([101], $db->query('SELECT legacy_link_id FROM legacy_link_conflicts')->fetchAll(PDO::FETCH_COLUMN));
            $this->assertSame(1, $db->query('SELECT COUNT(*) FROM view_link_routes')->fetchColumn());

            $result = $client->postJson(self::RESOLVE, [
                'legacy_link_id' => 101, 'view_id' => 2, 'expected_revision' => $result['revision'],
            ])->assertOk()->getJson();
            $this->assertSame([['view_id' => 1, 'device_a_id' => 1, 'device_b_id' => 2]], $result['removed_view_link_routes']);
            $this->assertSame($beforeView, $result['views'][0]['previous_resource_revision']);
            $this->assertTrue($result['views'][0]['resource_revision'] > $beforeView);
            $this->assertSame(0, $db->query('SELECT COUNT(*) FROM legacy_link_conflicts')->fetchColumn());
            $this->assertSame(0, $db->query('SELECT COUNT(*) FROM view_link_routes')->fetchColumn());
            $this->assertSame($beforeLinks, $db->query('SELECT * FROM links ORDER BY id')->fetchAll());
            $this->assertSame($beforePorts, $db->query('SELECT * FROM device_ports ORDER BY id')->fetchAll());
        });
    }

    public function testAllowsPortSwapAndDeleteWithSameNameCreateInSingleBatch(): void
    {
        $this->isolated(function (TestHttpClient $client, PDO $db): void {
            $created = $client->postJson(self::SAVE, [
                'device_ports' => [
                    ['operation' => 'create', 'id' => 101, 'port' => ['device_id' => 3, 'name' => 'Gi1', 'memo' => 'A']],
                    ['operation' => 'create', 'id' => 102, 'port' => ['device_id' => 3, 'name' => 'Gi2', 'memo' => 'B']],
                    ['operation' => 'create', 'id' => 103, 'port' => ['device_id' => 3, 'name' => 'Gi3', 'memo' => 'C']],
                ],
            ])->assertOk()->getJson();
            $ports = array_column($created['device_ports'], null, 'name');

            $swapped = $client->postJson(self::SAVE, [
                'device_ports' => [
                    ['operation' => 'update', 'id' => $ports['Gi1']['id'], 'expected_revision' => $ports['Gi1']['resource_revision'],
                        'port' => ['name' => 'Gi2']],
                    ['operation' => 'update', 'id' => $ports['Gi2']['id'], 'expected_revision' => $ports['Gi2']['resource_revision'],
                        'port' => ['name' => 'Gi1']],
                    ['operation' => 'delete', 'id' => $ports['Gi3']['id'], 'expected_revision' => $ports['Gi3']['resource_revision']],
                    ['operation' => 'create', 'id' => 104, 'port' => ['device_id' => 3, 'name' => 'Gi3', 'memo' => '再作成']],
                ],
                'links' => [
                    ['operation' => 'create', 'id' => 201, 'link' => [
                        'from_id' => 3, 'to_id' => 4, 'from_port_name' => 'Gi3',
                    ]],
                ],
            ])->assertOk()->getJson();

            $byId = array_column($swapped['device_ports'], null, 'id');
            $this->assertSame('Gi2', $byId[$ports['Gi1']['id']]['name']);
            $this->assertSame('Gi1', $byId[$ports['Gi2']['id']]['name']);
            $recreatedId = $swapped['id_maps']['device_ports'][104];
            $this->assertSame('Gi3', $byId[$recreatedId]['name']);
            $this->assertSame('再作成', $byId[$recreatedId]['memo']);
            $this->assertSame($recreatedId, $swapped['links'][0]['from_port_id']);
            $this->assertSame([$ports['Gi3']['id']], $swapped['deleted_device_port_ids']);
        });
    }

    public function testCompleteLegacyVlanAcceptsEmptyLinkObject(): void
    {
        $this->isolated(function (TestHttpClient $client, PDO $db): void {
            $db->exec("INSERT INTO legacy_link_vlans VALUES (1, 'old access 10')");
            $ports = $db->query('SELECT * FROM device_ports ORDER BY id')->fetchAll(PDO::FETCH_ASSOC);
            $linkRev = (int)$db->query('SELECT resource_revision FROM links WHERE id=1')->fetchColumn();

            $result = $client->postJson(self::SAVE, [
                'complete_legacy_vlan' => 1,
                'device_ports' => [[
                    'operation' => 'update',
                    'id' => $ports[0]['id'],
                    'expected_revision' => $ports[0]['resource_revision'],
                    'port' => ['vlan' => 'access 10'],
                ]],
                'links' => [[
                    'operation' => 'update',
                    'id' => 1,
                    'expected_revision' => $linkRev,
                    'link' => new \stdClass(),
                ]],
            ])->assertOk()->getJson();

            $this->assertSame(1, $result['completed_legacy_vlan_link_id']);
            $this->assertSame(0, (int)$db->query('SELECT COUNT(*) FROM legacy_link_vlans')->fetchColumn());
        });
    }
}
