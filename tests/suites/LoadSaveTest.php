<?php
declare(strict_types=1);

namespace Netarium\Tests\Suites;

use Netarium\Tests\TestCase;
use Netarium\Tests\TestHttpClient;

class LoadSaveTest extends TestCase
{
    private TestHttpClient $client;

    public function __construct(TestHttpClient $client)
    {
        $this->client = $client;
    }

    public function testWholeSaveRejectsUnsafeAndExhaustingExplicitIds(): void
    {
        $server = new \Netarium\Tests\TestServer();
        $db = null;
        try {
            $server->start();
            $client = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($client->login('admin', 'admin123'));
            $db = new \PDO('sqlite:' . $server->getDbPath());
            $before = $client->get('/api.php?action=load')->assertOk()->getJson();
            $sequences = $db->query('SELECT * FROM resource_sequences ORDER BY name')->fetchAll(\PDO::FETCH_ASSOC);
            foreach ([9007199254740991, '9007199254740992', '999999999999999999999999999999', 1.5] as $id) {
                $input = $before;
                $device = $before['devices'][0];
                $device['id'] = $id;
                $device['name'] = 'Explicit boundary device';
                $device['ip'] = '';
                $input['devices'][] = $device;
                $client->postJson('/api.php?action=save', $input)->assertStatus(400);
                $this->assertSame($before, $client->get('/api.php?action=load')->assertOk()->getJson());
                $this->assertSame($sequences, $db->query('SELECT * FROM resource_sequences ORDER BY name')->fetchAll(\PDO::FETCH_ASSOC));
            }
            $db->exec("UPDATE resource_sequences SET value = 9007199254740990 WHERE name = 'devices'");
            $client->postJson('/api.php?action=save_resources', [
                'devices' => [['operation' => 'create', 'id' => 980001,
                    'device' => ['name' => 'Allocated MAX device', 'type' => 'switch']]],
                'views' => [],
            ])->assertOk();
            $input = $client->get('/api.php?action=load')->assertOk()->getJson();
            $client->postJson('/api.php?action=save', $input)->assertOk();
            $this->assertSame('9007199254740991', (string)$db->query(
                "SELECT id FROM devices WHERE name = 'Allocated MAX device'"
            )->fetchColumn());
            $this->assertSame('9007199254740991', (string)$db->query(
                "SELECT value FROM resource_sequences WHERE name = 'devices'"
            )->fetchColumn());
        } finally {
            $db = null;
            $server->stop();
        }
    }

    public function testWholeSaveChecksNewRackPairAfterResolvingViewFloors(): void
    {
        $server = new \Netarium\Tests\TestServer();
        $db = null;
        try {
            $server->start();
            $client = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($client->login('admin', 'admin123'));
            $db = new \PDO('sqlite:' . $server->getDbPath());
            $db->exec("INSERT INTO buildings (id, name) VALUES (981001, '本館')");
            $db->exec("INSERT INTO floors (id, building_id, name) VALUES (982001, 981001, '1階'), (982002, 981001, '2階')");
            $db->exec("INSERT INTO views (id, name, view_type, floor_id)
                VALUES (990001, 'Physical view', 'floor', 982001), (990002, 'Rack view', 'rack', 982001)");
            $db->exec("INSERT INTO rack_settings (view_id, total_u, location) VALUES (990002, 42, '')");
            $load = static fn(): array => $client->get('/api.php?action=load')->assertOk()->getJson();
            $input = $load();
            $floorIndex = array_search(990001, array_column($input['views'], 'id'), true);
            $rackIndex = array_search(990002, array_column($input['views'], 'id'), true);
            unset($input['views'][$rackIndex]['floor_id']);
            $pair = ['floor_view_id' => 990001, 'rack_view_id' => 990002, 'x' => 12.5, 'y' => 45];
            $input['floor_rack_placements'] = [$pair];
            foreach ([null, 982002] as $targetFloorId) {
                $input['views'][$floorIndex]['floor_id'] = $targetFloorId;
                $client->postJson('/api.php?action=save', $input)->assertError(400, '同じフロアの物理配置図');
                $after = $load();
                $this->assertSame($input['revision'], $after['revision']);
                $this->assertSame([], $after['floor_rack_placements']);
            }
            unset($input['views'][$floorIndex]['floor_id']);
            $client->postJson('/api.php?action=save', $input)->assertOk();
            $after = $load();
            $this->assertSame([$pair], $after['floor_rack_placements']);

            $floorIndex = array_search(990001, array_column($after['views'], 'id'), true);
            $after['views'][$floorIndex]['floor_id'] = 982002;
            $pair['y'] = -20.25;
            $after['floor_rack_placements'] = [$pair];
            $client->postJson('/api.php?action=save', $after)->assertOk();
            $after = $load();
            $this->assertSame(982002, array_column($after['views'], 'floor_id', 'id')[990001]);
            $this->assertSame([$pair], $after['floor_rack_placements']);
        } finally {
            $db = null;
            $server->stop();
        }
    }

    public function testLoadSchemaAndInitialData(): void
    {
        $res = $this->client->get('/api.php?action=load');
        $res->assertOk();
        $json = $res->getJson();

        // Check top-level keys
        $this->assertTrue($json['ok']);
        $this->assertArrayHasKey('revision', $json);
        $this->assertArrayHasKey('saved_at', $json);
        $this->assertArrayHasKey('monitor_revision', $json);
        $this->assertArrayHasKey('last_monitored_at', $json);
        $this->assertArrayHasKey('user', $json);
        $this->assertArrayHasKey('views', $json);
        $this->assertArrayHasKey('devices', $json);
        $this->assertArrayHasKey('placements', $json);
        $this->assertArrayHasKey('links', $json);
        $this->assertArrayHasKey('device_ports', $json);
        $this->assertArrayHasKey('view_link_routes', $json);
        $this->assertArrayHasKey('legacy_link_conflicts', $json);
        $this->assertArrayHasKey('link_systems', $json);
        foreach ($json['links'] as $link) {
            $this->assertArrayHasKey('system_id', $link);
            $this->assertNull($link['system_id']);
            $this->assertArrayHasKey('from_port_id', $link);
            $this->assertArrayHasKey('to_port_id', $link);
            $this->assertArrayHasKey('resource_revision', $link);
            foreach (['view_id', 'from_port', 'to_port', 'route_mode', 'manual_route'] as $field) {
                $this->assertFalse(array_key_exists($field, $link));
            }
        }
        $this->assertArrayHasKey('canvas_notes', $json);
        $this->assertSame([], $json['canvas_notes']);
        $this->assertArrayHasKey('floor_plans', $json);

        // Check user object
        $this->assertSame('admin', $json['user']['role']);
        $this->assertTrue($json['user']['is_admin']);

        // Check seeded devices
        $this->assertCount(4, $json['devices']);
        $firstDevice = $json['devices'][0];
        $expectedDeviceKeys = [
            'id', 'name', 'type', 'ip', 'x', 'y', 'status', 'last_checked_at',
            'last_response_ms', 'last_error', 'facility', 'floor', 'location',
            'manufacturer', 'model', 'asset_number', 'serial_number', 'mac_address', 'memo',
            'management_scheme', 'management_port', 'department', 'maintenance_vendor', 'install_date', 'maintenance_expiry'
        ];
        foreach ($expectedDeviceKeys as $key) {
            $this->assertArrayHasKey($key, $firstDevice, "Device must contain key '{$key}'");
        }

        // Check seeded views
        $this->assertCount(2, $json['views']);
        $firstView = $json['views'][0];
        $this->assertArrayHasKey('id', $firstView);
        $this->assertArrayHasKey('name', $firstView);
        $this->assertArrayHasKey('view_type', $firstView);
        $this->assertSame(1, $firstView['show_connections']);
    }

    public function testSaveSuccessfulAndIncrementsRevision(): void
    {
        // 1. Fetch current data
        $loadRes = $this->client->get('/api.php?action=load');
        $loadRes->assertOk();
        $initialData = $loadRes->getJson();
        $currentRev = (int)$initialData['revision'];

        $views = $initialData['views'];
        $devices = $initialData['devices'];
        $placements = $initialData['placements'];
        $views[0]['show_connections'] = 0;

        // Add a new device
        $newDeviceId = 5;
        $devices[] = [
            'id' => $newDeviceId,
            'name' => '新設アクセスポイント',
            'type' => 'ap',
            'ip' => '192.168.1.50',
            'facility' => '本庁舎',
            'floor' => '1F',
            'location' => '事務室',
            'manufacturer' => 'Cisco',
            'model' => 'Catalyst 9100',
            'asset_number' => 'AST-005',
            'serial_number' => 'SER-005',
            'mac_address' => '00:11:22:33:44:88',
            'memo' => 'テスト用AP',
            'management_scheme' => 'https',
            'management_port' => 8443,
            'department' => '情報企画課',
            'maintenance_vendor' => 'ベンダーZ',
            'install_date' => '2024-05',
            'maintenance_expiry' => '2027-04',
        ];

        // Place new device in view 1
        $placements[] = [
            'id' => 4,
            'device_id' => $newDeviceId,
            'view_id' => 1,
            'x' => 450,
            'y' => 200,
        ];

        // 2. Perform save
        $saveRes = $this->client->postJson('/api.php?action=save', [
            'revision' => $currentRev,
            'views' => $views,
            'devices' => $devices,
            'placements' => $placements,
            'links' => [['id' => 999001, 'from_id' => 5, 'to_id' => 1, 'view_id' => 1]],
            'device_ports' => [],
            'canvas_notes' => $initialData['canvas_notes'],
        ]);

        $saveRes->assertOk();
        $saveJson = $saveRes->getJson();
        $this->assertSame($currentRev + 1, $saveJson['revision']);
        $this->assertNotNull($saveJson['saved_at']);
        $this->assertSame($initialData['links'], $saveJson['links']);
        $this->assertSame($initialData['device_ports'], $saveJson['device_ports']);
        $this->assertSame(0, $saveJson['views'][0]['show_connections']);

        // 3. Verify changes persist on load
        $newLoadRes = $this->client->get('/api.php?action=load');
        $newLoadRes->assertOk();
        $newLoadJson = $newLoadRes->getJson();
        $this->assertSame($currentRev + 1, (int)$newLoadJson['revision']);
        $this->assertCount(5, $newLoadJson['devices']);
        $this->assertSame($initialData['links'], $newLoadJson['links']);
        $this->assertSame($initialData['device_ports'], $newLoadJson['device_ports']);
        $savedDevice = null;
        foreach ($newLoadJson['devices'] as $d) {
            if ((int)$d['id'] === $newDeviceId) {
                $savedDevice = $d;
                break;
            }
        }
        $this->assertNotNull($savedDevice);
        $this->assertSame('https', $savedDevice['management_scheme']);
        $this->assertSame(8443, (int)$savedDevice['management_port']);
        $this->assertSame('情報企画課', $savedDevice['department']);
        $this->assertSame('ベンダーZ', $savedDevice['maintenance_vendor']);
        $this->assertSame('2024-05', $savedDevice['install_date']);
        $this->assertSame('2027-04', $savedDevice['maintenance_expiry']);
    }

    public function testSaveConflict409OnStaleRevision(): void
    {
        // 1. Fetch current revision
        $loadRes = $this->client->get('/api.php?action=load');
        $currentRev = (int)$loadRes->getJson()['revision'];

        // 2. Try to save using an outdated revision (e.g. currentRev - 1)
        $staleRev = max(1, $currentRev - 1);
        // Force discrepancy if staleRev == currentRev
        if ($staleRev === $currentRev) {
            $staleRev = $currentRev + 999;
        }

        $res = $this->client->postJson('/api.php?action=save', [
            'revision' => $staleRev,
            'views' => [],
            'devices' => [],
            'placements' => [],
            'links' => [],
        ]);

        $res->assertStatus(409);
        $json = $res->getJson();
        $this->assertFalse($json['ok']);
    }

    public function testSaveValidationErrors(): void
    {
        // 1. Missing revision (0)
        $resNoRev = $this->client->postJson('/api.php?action=save', [
            'revision' => 0,
            'views' => [],
            'devices' => [],
            'placements' => [],
            'links' => [],
        ]);
        $resNoRev->assertStatus(400);

        // 2. Device without name
        $loadRes = $this->client->get('/api.php?action=load');
        $currentRev = (int)$loadRes->getJson()['revision'];

        $resEmptyName = $this->client->postJson('/api.php?action=save', [
            'revision' => $currentRev,
            'views' => [['id' => 1, 'name' => '全体', 'view_type' => 'topology']],
            'devices' => [['id' => 1, 'name' => '', 'type' => 'router']],
            'placements' => [],
            'links' => [],
        ]);
        $resEmptyName->assertStatus(400);

        // 3. Duplicate device ID
        $resDupId = $this->client->postJson('/api.php?action=save', [
            'revision' => $currentRev,
            'views' => [['id' => 1, 'name' => '全体', 'view_type' => 'topology']],
            'devices' => [
                ['id' => 1, 'name' => '機器A', 'type' => 'router'],
                ['id' => 1, 'name' => '機器B', 'type' => 'switch'],
            ],
            'placements' => [],
            'links' => [],
        ]);
        $resDupId->assertStatus(400);

        // 4. Invalid port without scheme
        $resPortNoScheme = $this->client->postJson('/api.php?action=save', [
            'revision' => $currentRev,
            'views' => [['id' => 1, 'name' => '全体', 'view_type' => 'topology']],
            'devices' => [['id' => 1, 'name' => '機器A', 'type' => 'router', 'management_scheme' => '', 'management_port' => 8080]],
            'placements' => [],
            'links' => [],
        ]);
        $resPortNoScheme->assertStatus(400);

        // 5. Invalid date (non-existent 2026-02-29)
        $resInvalidDate = $this->client->postJson('/api.php?action=save', [
            'revision' => $currentRev,
            'views' => [['id' => 1, 'name' => '全体', 'view_type' => 'topology']],
            'devices' => [['id' => 1, 'name' => '機器A', 'type' => 'router', 'install_date' => '2026-02-29']],
            'placements' => [],
            'links' => [],
        ]);
        $resInvalidDate->assertStatus(400);

        // 6. Expiry before install
        $resDateOrder = $this->client->postJson('/api.php?action=save', [
            'revision' => $currentRev,
            'views' => [['id' => 1, 'name' => '全体', 'view_type' => 'topology']],
            'devices' => [['id' => 1, 'name' => '機器A', 'type' => 'router', 'install_date' => '2025-06', 'maintenance_expiry' => '2025-05']],
            'placements' => [],
            'links' => [],
        ]);
        $resDateOrder->assertStatus(400);
    }
}
