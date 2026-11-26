<?php
declare(strict_types=1);

namespace Netarium\Tests\Suites;

use PDO;
use Netarium\Tests\TestCase;
use Netarium\Tests\TestHttpClient;
use Netarium\Tests\TestServer;

class BuildingHierarchyTest extends TestCase
{
    public function __construct(TestHttpClient $client) {}

    private function isolated(callable $test): void
    {
        $server = new TestServer();
        try {
            $server->start();
            $client = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($client->login('admin', 'admin123'));
            $db = new PDO('sqlite:' . $server->getDbPath());
            $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
            $test($client, $db, $server);
        } finally {
            $db = null;
            $server->stop();
        }
    }

    private function load(TestHttpClient $client): array
    {
        return $client->get('/api.php?action=load')->assertOk()->getJson();
    }

    private function mutate(TestHttpClient $client, string $operation, array $fields = []): array
    {
        return $client->postJson('/api.php?action=building_hierarchy',
            ['revision' => $this->load($client)['revision'], 'operation' => $operation] + $fields)->assertOk()->getJson();
    }

    private function fixture(TestHttpClient $client): array
    {
        $building = $this->mutate($client, 'create_building', ['name' => '本館'])['buildings'][0]['id'];
        $floor = $this->mutate($client, 'create_floor', ['name' => '1階', 'building_id' => $building])['floors'][0]['id'];
        return [$building, $floor];
    }

    private function operation(array $data, array $view): array
    {
        $id = $view['id'];
        $result = ['operation' => 'update', 'id' => $id, 'expected_revision' => $view['resource_revision'], 'view' => $view];
        foreach (['placements', 'links', 'canvas_notes', 'rack_mounts', 'rack_shelves'] as $key) {
            $result[$key] = array_values(array_filter($data[$key], static fn(array $row): bool => $row['view_id'] === $id));
        }
        $result['rack_settings'] = null;
        $result['rack_shelf_devices'] = [];
        $result['floor_rack_placements'] = [];
        return $result;
    }

    private function saveView(TestHttpClient $client, array $data, array $view): array
    {
        return $client->postJson('/api.php?action=save_resources', ['devices' => [], 'views' => [$this->operation($data, $view)]])->assertOk()->getJson();
    }

    public function testAuthorizationCasValidationAndTransforms(): void
    {
        $this->isolated(function (TestHttpClient $client, PDO $db, TestServer $server): void {
            $anonymous = new TestHttpClient($server->getBaseUrl());
            $anonymous->get('/api.php?action=building_hierarchy')->assertError(401);
            $viewer = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($viewer->login('viewer', 'viewer123'));
            $viewer->get('/api.php?action=building_hierarchy')->assertOk();
            $input = ['revision' => $this->load($client)['revision'], 'operation' => 'create_building', 'name' => '本館'];
            $viewer->postJson('/api.php?action=building_hierarchy', $input)->assertError(403);
            $client->postJson('/api.php?action=building_hierarchy', $input, ['X-CSRF-Token' => 'incorrect'])->assertError(403);
            $first = $client->postJson('/api.php?action=building_hierarchy', $input)->assertOk()->getJson();
            $client->postJson('/api.php?action=building_hierarchy', $input)->assertError(409);
            $this->assertSame(1, count($first['buildings']));
            $building = $first['buildings'][0]['id'];
            $badInputs = [
                ['operation' => 'create_floor', 'building_id' => 999999, 'name' => '不正'],
                ['operation' => 'create_floor', 'building_id' => $building, 'name' => '不正', 'scale' => 0],
                ['operation' => 'create_floor', 'building_id' => $building, 'name' => '不正', 'rotation' => 181],
                ['operation' => 'create_building', 'name' => str_repeat('字', 101)],
                ['operation' => 'create_building', 'name' => '不正', 'sort_order' => 1000000],
                ['operation' => 'update_building', 'id' => $building, 'building_view_enabled' => 2],
                ['operation' => 'update_building', 'id' => $building, 'building_view_enabled' => '1'],
                ['operation' => 'update_building', 'id' => $building, 'building_view_enabled' => null],
            ];
            foreach ($badInputs as $bad) {
                $before = $client->get('/api.php?action=building_hierarchy')->assertOk()->getJson();
                $client->postJson('/api.php?action=building_hierarchy', ['revision' => $before['revision']] + $bad)->assertError(400);
                $this->assertSame($before, $client->get('/api.php?action=building_hierarchy')->assertOk()->getJson());
            }
            $before = $this->load($client);
            $state = $this->mutate($client, 'create_floor', ['building_id' => $building, 'name' => '1階',
                'scale' => 2.5, 'offset_x' => -123.5, 'offset_y' => 40.25, 'rotation' => -90]);
            $this->assertSame(2.5, $state['floors'][0]['scale']);
            $this->assertSame(-123.5, $state['floors'][0]['offset_x']);
            $after = $this->load($client);
            $this->assertSame($before['placements'], $after['placements']);
            $this->assertSame($before['devices'], $after['devices']);
        });
    }

    public function testBuildingViewTogglePreservesFloorDataAndRejectsStaleUpdates(): void
    {
        $this->isolated(function (TestHttpClient $client, PDO $db, TestServer $server): void {
            [$building, $floor] = $this->fixture($client);
            $data = $this->load($client);
            $view = $data['views'][0];
            $view['floor_id'] = $floor;
            $view['view_type'] = 'floor';
            $this->saveView($client, $data, $view);
            $this->mutate($client, 'update_floor', ['id' => $floor, 'representative_view_id' => $view['id'],
                'scale' => 1.5, 'offset_x' => -12.5, 'offset_y' => 42, 'rotation' => 15]);
            $db->exec("UPDATE devices SET floor_id = $floor WHERE id = 1");
            $db->prepare("INSERT INTO view_floor_plans
                (view_id, stored_name, original_name, mime_type, file_size, image_width, image_height, created_at, updated_at)
                VALUES (?, 'floor.png', 'floor.png', 'image/png', 100, 20, 30, '2026-01-01', '2026-01-01')")
                ->execute([$view['id']]);

            $api = '/api.php?action=building_hierarchy';
            $initial = $this->load($client);
            $this->assertSame(0, $initial['buildings'][0]['building_view_enabled']);
            $this->assertSame($view['id'], $initial['floor_plans'][0]['view_id']);
            $this->assertSame($floor, $initial['devices'][0]['floor_id']);
            $enable = ['operation' => 'update_building', 'id' => $building, 'building_view_enabled' => 1,
                'revision' => $initial['revision']];
            $viewer = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($viewer->login('viewer', 'viewer123'));
            $viewer->postJson($api, $enable)->assertError(403);
            $client->postJson($api, $enable)->assertOk();
            $client->postJson($api, $enable)->assertError(409);
            $enabled = $this->load($client);
            $this->assertSame(1, $enabled['buildings'][0]['building_view_enabled']);
            $this->assertSame(1, $viewer->get($api)->assertOk()->getJson()['buildings'][0]['building_view_enabled']);

            $this->mutate($client, 'update_building', ['id' => $building, 'building_view_enabled' => 0]);
            $disabled = $this->load($client);
            $this->assertSame($initial['buildings'], $disabled['buildings']);
            $baseline = array_intersect_key($enabled['floors'][0],
                array_flip(['building_id', 'representative_view_id', 'scale', 'offset_x', 'offset_y', 'rotation']));
            $client->postJson($api, ['operation' => 'update_floor_transform', 'id' => $floor, 'offset_x' => 999,
                'expected_floor' => $baseline] + $baseline)->assertError(409);
            $this->assertSame($disabled, $this->load($client));

            $this->mutate($client, 'update_building', ['id' => $building, 'building_view_enabled' => 1]);
            $reenabled = $this->load($client);
            $this->assertSame($enabled['buildings'], $reenabled['buildings']);
            foreach (['floors', 'views', 'devices', 'placements', 'floor_plans'] as $key) {
                $this->assertSame($initial[$key], $enabled[$key]);
                $this->assertSame($initial[$key], $disabled[$key]);
                $this->assertSame($initial[$key], $reenabled[$key]);
            }
        });
    }

    public function testFloorTransformComparesOnlyTheTargetBaselineAndWritesOnlyTransforms(): void
    {
        $this->isolated(function (TestHttpClient $client, PDO $db, TestServer $server): void {
            [$building, $floor] = $this->fixture($client);
            $this->mutate($client, 'update_building', ['id' => $building, 'building_view_enabled' => 1]);
            $api = '/api.php?action=building_hierarchy';
            $baselineFields = array_flip(['building_id', 'representative_view_id', 'scale', 'offset_x', 'offset_y', 'rotation']);
            $initial = $this->load($client);
            $initialFloor = array_intersect_key($initial['floors'][0], $baselineFields);
            $transform = ['scale' => 2.5, 'offset_x' => -123.5, 'offset_y' => 1234567890123.125, 'rotation' => -90];
            $input = ['operation' => 'update_floor_transform', 'id' => $floor] + $transform;

            $viewer = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($viewer->login('viewer', 'viewer123'));
            $viewer->postJson($api, $input + ['expected_floor' => $initialFloor])->assertError(403);

            $client->postJson($api, $input)->assertError(400);
            $client->postJson($api, $input + ['expected_floor' => array_diff_key($initialFloor, ['representative_view_id' => true])])
                ->assertError(400);
            $client->postJson($api, ['scale' => 0] + $input + ['expected_floor' => $initialFloor])->assertError(400);
            $this->assertSame($initial, $this->load($client));

            $this->mutate($client, 'update_floor', ['id' => $floor, 'offset_x' => 45.5]);
            $changed = $this->load($client);
            // A current global revision does not make a stale target baseline safe.
            $client->postJson($api, $input + ['revision' => $changed['revision'], 'expected_floor' => $initialFloor])->assertError(409);
            $this->assertSame($changed, $this->load($client));

            $otherBuilding = $this->mutate($client, 'create_building', ['name' => '別館', 'building_view_enabled' => 1])['buildings'][1]['id'];
            $this->mutate($client, 'update_floor', ['id' => $floor, 'building_id' => $otherBuilding]);
            $moved = $this->load($client);
            $client->postJson($api, $input + ['expected_floor' => array_intersect_key($changed['floors'][0], $baselineFields)])->assertError(409);
            $this->assertSame($moved, $this->load($client));

            $view = $moved['views'][0];
            $view['floor_id'] = $floor;
            $view['view_type'] = 'floor';
            $this->saveView($client, $moved, $view);
            $this->mutate($client, 'update_floor', ['id' => $floor, 'representative_view_id' => $view['id']]);
            $current = $this->load($client);
            $client->postJson($api, $input + ['expected_floor' => array_intersect_key($moved['floors'][0], $baselineFields)])->assertError(409);
            $this->assertSame($current, $this->load($client));

            $expected = array_intersect_key($current['floors'][0], $baselineFields);
            // JSON numbers may arrive as integers even where the database stores a REAL.
            $expected['scale'] = 1;
            $saved = $client->postJson($api, $input + ['expected_floor' => $expected, 'revision' => $initial['revision'],
                'name' => '書き換えない', 'sort_order' => 999, 'building_id' => $building, 'representative_view_id' => null])
                ->assertOk()->getJson();
            $after = $this->load($client);
            $this->assertSame($current['revision'] + 1, $saved['revision']);
            $this->assertSame($saved['revision'], $after['revision']);
            $this->assertSame(array_replace($current['floors'][0], $transform), $saved['floor']);
            $this->assertSame($after['floors'][0], $saved['floor']);
            foreach (['buildings', 'views', 'devices', 'placements', 'floor_plans'] as $key) {
                $this->assertSame($current[$key], $after[$key]);
            }

            $savedAgain = $client->postJson($api, ['rotation' => 15] + $input + [
                'expected_floor' => array_intersect_key($saved['floor'], $baselineFields),
            ])->assertOk()->getJson();
            $this->assertSame($saved['revision'] + 1, $savedAgain['revision']);
            $this->assertSame(array_replace($saved['floor'], ['rotation' => 15]), $savedAgain['floor']);
        });
    }

    public function testMembershipLegacyPreservationAndRepresentativeLifecycle(): void
    {
        $this->isolated(function (TestHttpClient $client): void {
            [$building, $floor] = $this->fixture($client);
            $data = $this->load($client);
            $view = $data['views'][0];
            $id = $view['id'];
            $view['floor_id'] = $floor;
            $view['view_type'] = 'floor';
            $this->saveView($client, $data, $view);
            $this->mutate($client, 'update_floor', ['id' => $floor, 'representative_view_id' => $id]);
            $data = $this->load($client);
            foreach ($data['views'] as &$row) { unset($row['floor_id']); }
            unset($row);
            $client->postJson('/api.php?action=save', $data)->assertOk();
            $data = $this->load($client);
            $view = array_column($data['views'], null, 'id')[$id];
            $this->assertSame($floor, $view['floor_id']);
            $this->assertSame($id, $data['floors'][0]['representative_view_id']);
            unset($view['floor_id']);
            $this->saveView($client, $data, $view);
            $data = $this->load($client);
            $view = array_column($data['views'], null, 'id')[$id];
            $this->assertSame($floor, $view['floor_id']);
            $invalid = $view;
            $client->postJson('/api.php?action=building_hierarchy', ['revision' => $data['revision'], 'operation' => 'update_floor',
                'id' => $floor, 'representative_view_id' => 2])->assertError(400);
            $invalid['floor_id'] = 999999;
            $client->postJson('/api.php?action=save_resources', ['devices' => [], 'views' => [$this->operation($data, $invalid)]])->assertError(400);
            $invalidData = $data;
            foreach ($invalidData['views'] as &$row) { if ($row['id'] === $id) { $row['floor_id'] = 999999; } }
            unset($row);
            $client->postJson('/api.php?action=save', $invalidData)->assertError(400);
            $view['view_type'] = 'topology';
            $result = $this->saveView($client, $data, $view);
            $this->assertNull($result['floors'][0]['representative_view_id']);
            $client->postJson('/api.php?action=building_hierarchy', ['revision' => $result['revision'], 'operation' => 'update_floor',
                'id' => $floor, 'representative_view_id' => $id])->assertError(400);
            $data = $this->load($client);
            $view = array_column($data['views'], null, 'id')[$id];
            $view['view_type'] = 'floor';
            $this->saveView($client, $data, $view);
            $this->mutate($client, 'update_floor', ['id' => $floor, 'representative_view_id' => $id]);
            $data = $this->load($client);
            $view = array_column($data['views'], null, 'id')[$id];
            $view['floor_id'] = null;
            $result = $this->saveView($client, $data, $view);
            $this->assertNull($result['floors'][0]['representative_view_id']);
            $data = $this->load($client);
            $view = array_column($data['views'], null, 'id')[$id];
            $view['floor_id'] = $floor;
            $this->saveView($client, $data, $view);
            $this->mutate($client, 'update_floor', ['id' => $floor, 'representative_view_id' => $id]);
            $data = $this->load($client);
            $view = array_column($data['views'], null, 'id')[$id];
            $client->postJson('/api.php?action=save_resources', ['devices' => [], 'views' => [[
                'operation' => 'delete', 'id' => $id, 'expected_revision' => $view['resource_revision'],
            ]]])->assertOk();
            $this->assertNull($this->load($client)['floors'][0]['representative_view_id']);
        });
    }

    public function testFloorAndBuildingDeletionDetachWithoutTopologyLoss(): void
    {
        $this->isolated(function (TestHttpClient $client): void {
            foreach (['delete_floor', 'delete_building'] as $operation) {
                [$building, $floor] = $this->fixture($client);
                $data = $this->load($client);
                $view = $data['views'][0];
                $id = $view['id'];
                $view['floor_id'] = $floor;
                $this->saveView($client, $data, $view);
                $before = $this->load($client);
                $oldView = array_column($before['views'], null, 'id')[$id];
                $this->mutate($client, $operation, ['id' => $operation === 'delete_floor' ? $floor : $building]);
                $after = $this->load($client);
                foreach (['devices', 'placements', 'links'] as $key) { $this->assertSame($before[$key], $after[$key]); }
                $newView = array_column($after['views'], null, 'id')[$id];
                $this->assertNull($newView['floor_id']);
                $this->assertTrue($newView['resource_revision'] > $oldView['resource_revision']);
                $this->assertSame($before['revision'] + 1, $after['revision']);
                $client->postJson('/api.php?action=save_resources', ['devices' => [], 'views' => [$this->operation($before, $oldView)]])->assertError(409);
                if ($operation === 'delete_floor') { $this->mutate($client, 'delete_building', ['id' => $building]); }
            }
        });
    }

    public function testConservativeLegacyConversionAndIdempotence(): void
    {
        $row = static fn(int $id, string $facility, string $floor, ?int $floorId = null): array =>
            ['id' => $id, 'facility' => $facility, 'floor' => $floor, 'floor_id' => $floorId];
        $floor = static fn(int $id, int $building, string $name): array =>
            ['id' => $id, 'building_id' => $building, 'name' => $name, 'sort_order' => 17,
                'representative_view_id' => null, 'scale' => 2, 'offset_x' => 3, 'offset_y' => 4, 'rotation' => 5];
        $tables = [
            'buildings' => [['id' => 1, 'name' => 'Current', 'sort_order' => 9],
                ['id' => 2, 'name' => 'Duplicate', 'sort_order' => 0], ['id' => 3, 'name' => ' Duplicate ', 'sort_order' => 0]],
            'floors' => [$floor(1, 1, '1F'), $floor(2, 1, '2F'), $floor(3, 1, 'ambiguous'), $floor(4, 1, ' ambiguous ')],
            'views' => [$row(1, "\u{3000}Old\u{00A0}", "\u{3000}1F ", 2), $row(2, 'Split', '1F', 1), $row(3, 'Split', '1F', 2),
                $row(4, 'Old', '1F'), $row(5, 'Safe', 'B2'), $row(6, 'Safe', 'B1'),
                $row(7, 'Safe', '1F'), $row(8, 'Safe', '2F'), $row(9, 'Safe', 'RF'),
                $row(10, 'Building only', ''), $row(11, '', 'Orphan floor')],
            'devices' => [$row(1, 'Old', '1F'), $row(2, 'Split', '1F'), $row(3, 'Duplicate', '1F'),
                $row(4, 'Current', 'ambiguous'), $row(5, '', '1F'), $row(6, 'Building only', ''),
                $row(7, '', ''), $row(8, 'Safe', 'B2'), $row(9, 'Conflicting old', 'RF', 1),
                $row(10, 'Device only', '1F'), $row(11, 'Safe', '3F'),
                $row(12, 'Device building only', ''), $row(13, "\u{3000}Current\u{00A0}", ' 1F ')],
            'device_placements' => [['id' => 1, 'device_id' => 9, 'view_id' => 9, 'x' => 12, 'y' => 34]],
            'links' => [['id' => 1, 'from_id' => 1, 'to_id' => 9]],
        ];
        $before = $tables;
        $report = \Netarium\Services\Topology\LegacyHierarchyMigration::convert($tables);
        $this->assertSame(2, $tables['views'][3]['floor_id']);
        $this->assertSame(2, $tables['devices'][0]['floor_id']);
        foreach ([1, 2, 3, 4, 5, 6] as $index) { $this->assertNull($tables['devices'][$index]['floor_id']); }
        $this->assertSame(1, $tables['devices'][8]['floor_id']);
        $this->assertSame($tables['views'][4]['floor_id'], $tables['devices'][7]['floor_id']);
        $this->assertSame(1, $tables['devices'][12]['floor_id']);
        foreach ([9, 10, 11] as $index) { $this->assertNull($tables['devices'][$index]['floor_id']); }
        $this->assertNull($tables['views'][9]['floor_id']);
        $this->assertNull($tables['views'][10]['floor_id']);
        $this->assertSame(['Current', 'Duplicate', ' Duplicate ', 'Building only', 'Safe'], array_column($tables['buildings'], 'name'));
        $this->assertSame(2, $report['unclassified']['unmatched_legacy_location']);
        $this->assertSame(1, $report['unclassified']['ambiguous_explicit_mapping']);
        $this->assertSame(1, $report['unclassified']['ambiguous_building_name']);
        $this->assertSame(1, $report['unclassified']['ambiguous_floor_name']);
        $this->assertSame(2, $report['created_buildings']);
        $this->assertSame(5, $report['created_floors']);
        $safeFloors = array_values(array_filter($tables['floors'], static fn(array $r): bool => $r['id'] > 4));
        usort($safeFloors, static fn(array $a, array $b): int => $a['sort_order'] <=> $b['sort_order']);
        $this->assertSame(['B2', 'B1', '1F', '2F', 'RF'], array_column($safeFloors, 'name'));
        foreach (['device_placements', 'links'] as $table) { $this->assertSame($before[$table], $tables[$table]); }
        foreach (['views', 'devices'] as $table) {
            foreach ($before[$table] as $index => $original) {
                $this->assertSame($original['facility'], $tables[$table][$index]['facility']);
                $this->assertSame($original['floor'], $tables[$table][$index]['floor']);
            }
        }
        $once = $tables;
        $again = \Netarium\Services\Topology\LegacyHierarchyMigration::convert($tables);
        $this->assertSame($once, $tables);
        $this->assertSame(0, $again['created_buildings']);
        $this->assertSame(0, $again['created_floors']);
    }

    public function testLegacyDatabaseAndWebConversionUseSameHierarchy(): void
    {
        foreach (range(11, 24) as $schema) {
            $db = new PDO('sqlite::memory:', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
            $db->exec('PRAGMA foreign_keys=ON');
            for ($version = 1; $version <= $schema; $version++) { ('migrateDatabaseToVersion' . $version)($db); }
            $db->exec("INSERT INTO views(id,name,facility,floor,view_type) VALUES(1,'Old view',' Main ',' B1 ','floor')");
            $db->exec("INSERT INTO devices(id,name,facility,floor,x,y) VALUES(1,'Old device',' Main ',' B1 ',12,34)");
            $db->exec("INSERT INTO devices(id,name,facility,floor) VALUES
                (2,'Device only',' Device only ',' 1F '),(3,'Unmatched floor',' Main ',' 2F '),
                (4,'Partial device',' Device building only ','')");
            $db->exec("INSERT INTO device_placements(id,device_id,view_id,x,y) VALUES(1,1,1,56,78)");
            $service = new \Netarium\Services\Backup\BackupService($db);
            $source = $service->fetchBackupTables($schema);
            $web = $service->convertBackupRestoreData($source, $schema);
            migrateDatabase($db);
            $current = $service->fetchBackupTables();
            foreach (['buildings', 'floors', 'device_placements', 'links'] as $table) {
                $this->assertTrue($web[$table] == $current[$table], 'Database and Web migration differ: ' . $table);
            }
            foreach (['views', 'devices'] as $table) {
                $this->assertSame($web[$table][0]['floor_id'], $current[$table][0]['floor_id']);
                $this->assertSame(' Main ', $current[$table][0]['facility']);
                $this->assertSame(' B1 ', $current[$table][0]['floor']);
            }
            foreach ([1, 2, 3] as $index) {
                $this->assertNull($web['devices'][$index]['floor_id']);
                $this->assertNull($current['devices'][$index]['floor_id']);
                $this->assertSame($source['devices'][$index]['facility'], $current['devices'][$index]['facility']);
                $this->assertSame($source['devices'][$index]['floor'], $current['devices'][$index]['floor']);
            }
            $this->assertSame(2, json_decode($db->query("SELECT meta_value FROM app_meta WHERE meta_key='legacy_hierarchy_migration'")
                ->fetchColumn(), true)['unclassified']['unmatched_legacy_location']);
            $this->assertSame(APP_DATABASE_SCHEMA_VERSION, (int)$db->query('PRAGMA user_version')->fetchColumn());
            $this->assertSame([], $db->query('PRAGMA foreign_key_check')->fetchAll());
            $before = $db->query('SELECT * FROM devices')->fetchAll();
            $db->beginTransaction();
            \Netarium\Services\Topology\LegacyHierarchyMigration::migrate($db);
            $db->commit();
            $this->assertSame($before, $db->query('SELECT * FROM devices')->fetchAll());
            $this->assertSame(1, (int)$db->query('SELECT COUNT(*) FROM buildings')->fetchColumn());
            $this->assertSame(1, (int)$db->query('SELECT COUNT(*) FROM floors')->fetchColumn());
        }
    }

    public function testDeviceOnlyLegacyDatabaseMigrationDoesNotCreateHierarchy(): void
    {
        foreach (range(11, 24) as $schema) {
            $db = new PDO('sqlite::memory:', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
            for ($version = 1; $version <= $schema; $version++) { ('migrateDatabaseToVersion' . $version)($db); }
            $db->exec("INSERT INTO devices(name,facility,floor) VALUES
                ('Device only',' Device only ',' 1F '),('Partial device',' Partial ','')");
            migrateDatabase($db);
            $this->assertSame(0, (int)$db->query('SELECT COUNT(*) FROM buildings')->fetchColumn());
            $this->assertSame(0, (int)$db->query('SELECT COUNT(*) FROM floors')->fetchColumn());
            $this->assertSame(0, (int)$db->query('SELECT COUNT(*) FROM devices WHERE floor_id IS NOT NULL')->fetchColumn());
            $this->assertSame(' Device only ', $db->query('SELECT facility FROM devices WHERE id=1')->fetchColumn());
            $this->assertSame(' 1F ', $db->query('SELECT floor FROM devices WHERE id=1')->fetchColumn());
        }
    }

    public function testDatabaseMigrationHonorsHierarchyIdHighWaterMarks(): void
    {
        $db = new PDO('sqlite::memory:', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        for ($version = 1; $version <= 24; $version++) { ('migrateDatabaseToVersion' . $version)($db); }
        $db->exec("UPDATE resource_sequences SET value=10 WHERE name='buildings'");
        $db->exec("UPDATE resource_sequences SET value=20 WHERE name='floors'");
        $db->exec("INSERT INTO devices(name,facility,floor) VALUES('Legacy','Main','1F')");
        $db->exec("INSERT INTO views(name,facility,floor) VALUES('Legacy view','Main','1F')");
        migrateDatabase($db);
        $this->assertSame(11, (int)$db->query('SELECT id FROM buildings')->fetchColumn());
        $this->assertSame(21, (int)$db->query('SELECT id FROM floors')->fetchColumn());
        $this->assertSame(21, (int)$db->query('SELECT floor_id FROM devices')->fetchColumn());
    }

    public function testVersion25FailureRollsBackAndRetries(): void
    {
        $db = new PDO('sqlite::memory:', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        for ($version = 1; $version <= 24; $version++) { ('migrateDatabaseToVersion' . $version)($db); }
        $db->exec("INSERT INTO devices(name,facility,floor) VALUES('Legacy','Main','1F')");
        $db->exec("INSERT INTO views(name,facility,floor) VALUES('Legacy view','Main','1F')");
        $db->exec("CREATE TRIGGER reject_migration BEFORE INSERT ON floors BEGIN SELECT RAISE(ABORT,'migration failure'); END");
        try { migrateDatabase($db); $this->assertTrue(false, 'Migration must fail'); }
        catch (\PDOException $e) { $this->assertStringContains('migration failure', $e->getMessage()); }
        $this->assertSame(24, (int)$db->query('PRAGMA user_version')->fetchColumn());
        $this->assertSame(0, (int)$db->query('SELECT COUNT(*) FROM buildings')->fetchColumn());
        $this->assertFalse(in_array('floor_id', array_column($db->query('PRAGMA table_info(devices)')->fetchAll(PDO::FETCH_ASSOC), 'name'), true));
        $db->exec('DROP TRIGGER reject_migration');
        migrateDatabase($db);
        $this->assertSame(1, (int)$db->query('SELECT COUNT(*) FROM devices WHERE floor_id IS NOT NULL')->fetchColumn());
    }

    public function testDevicePhysicalFloorPersistenceOmissionValidationAndDeletion(): void
    {
        $this->isolated(function (TestHttpClient $client, PDO $db): void {
            [$building, $floor] = $this->fixture($client);
            $db->exec("UPDATE devices SET facility=' Old raw ', floor=' B1 '");
            $data = $this->load($client);
            $device = $data['devices'][0];
            $id = $device['id'];
            $device['floor_id'] = $floor;
            unset($device['facility'], $device['floor']);
            $save = function (array $row) use ($client): void {
                $current = array_column($this->load($client)['devices'], null, 'id')[$row['id']];
                $client->postJson('/api.php?action=save_resources', ['views' => [], 'devices' => [[
                    'operation' => 'update', 'id' => $row['id'], 'expected_revision' => $current['resource_revision'], 'device' => $row,
                ]]])->assertOk();
            };
            $save($device);
            $data = $this->load($client);
            $saved = array_column($data['devices'], null, 'id')[$id];
            $this->assertSame($floor, $saved['floor_id']);
            $this->assertSame(' Old raw ', $saved['facility']);
            $this->assertSame(' B1 ', $saved['floor']);
            $history = $db->query("SELECT changes_json FROM change_history WHERE target_type='device' AND target_id=$id ORDER BY id DESC LIMIT 1")->fetchColumn();
            $this->assertTrue(in_array('設置フロアID', array_column(json_decode($history, true, 512, JSON_THROW_ON_ERROR)['items'], 'label'), true));
            $cleared = $saved;
            $cleared['floor_id'] = null;
            $save($cleared);
            $this->assertNull(array_column($this->load($client)['devices'], null, 'id')[$id]['floor_id']);
            $save($saved);
            unset($saved['floor_id'], $saved['facility'], $saved['floor']);
            $save($saved);
            $data = $this->load($client);
            foreach ($data['devices'] as &$row) { unset($row['floor_id'], $row['facility'], $row['floor']); }
            unset($row);
            $client->postJson('/api.php?action=save', $data)->assertOk();
            $data = $this->load($client);
            $saved = array_column($data['devices'], null, 'id')[$id];
            $this->assertSame($floor, $saved['floor_id']);
            $this->assertSame(' Old raw ', $saved['facility']);
            $invalid = $saved;
            $invalid['floor_id'] = 999999;
            $client->postJson('/api.php?action=save_resources', ['views' => [], 'devices' => [[
                'operation' => 'update', 'id' => $id, 'expected_revision' => $saved['resource_revision'], 'device' => $invalid,
            ]]])->assertError(400);
            $before = $this->load($client);
            $this->mutate($client, 'delete_building', ['id' => $building]);
            $after = $this->load($client);
            $detached = array_column($after['devices'], null, 'id')[$id];
            $this->assertNull($detached['floor_id']);
            $this->assertTrue($detached['resource_revision'] > $saved['resource_revision']);
            $this->assertSame($saved['facility'], $detached['facility']);
            foreach (['placements', 'links'] as $key) { $this->assertSame($before[$key], $after[$key]); }
            $db->exec("UPDATE views SET facility='', floor=''");
            $diagnosis = $client->get('/api.php?action=data_quality')->assertOk()->getJson();
            $this->assertArrayHasKey('legacy_hierarchy', $diagnosis);
            $this->assertSame(0, $diagnosis['legacy_hierarchy']['created_buildings']);
            $this->assertSame(0, $diagnosis['legacy_hierarchy']['created_floors']);
            $this->assertTrue(($diagnosis['legacy_hierarchy']['unclassified']['unmatched_legacy_location'] ?? 0) > 0);
        });
    }
}
