<?php
declare(strict_types=1);

namespace Netarium\Tests\Suites;

use Netarium\Core\Database;
use Netarium\Services\Quality\QualityNotApplicable;
use Netarium\Tests\TestCase;
use Netarium\Tests\TestHttpClient;
use Netarium\Tests\TestServer;
use PDO;
use PDOException;

class DataQualityTest extends TestCase
{
    private const DIAGNOSE = '/api.php?action=data_quality';
    private const SET_NOT_APPLICABLE = '/api.php?action=set_quality_not_applicable';

    private TestHttpClient $client;

    public function __construct(TestHttpClient $client)
    {
        $this->client = $client;
    }

    public function testPcTypeIsValidWhileUnknownTypeIsDiagnosed(): void
    {
        require_once dirname(__DIR__, 2) . '/bootstrap.php';
        $service = new \Netarium\Services\Quality\QualityDiagnosticService(new \PDO('sqlite::memory:'));
        $issues = [];
        $service->appendDataQualityMissingFieldIssues($issues, [
            ['id' => 1, 'name' => '合成PC', 'type' => 'pc'],
            ['id' => 2, 'name' => '合成未知種別', 'type' => 'unknown-device-type'],
        ], []);
        $required = array_values(array_filter($issues,
            static fn(array $issue): bool => $issue['code'] === 'missing_required_fields'));
        $this->assertCount(1, $required);
        $this->assertSame([2], $required[0]['entity_ids']);
        $this->assertSame(['type'], $required[0]['details']['fields']);
    }

    public function testRackOnlyMountIsPlacedUntilRemoved(): void
    {
        $server = new \Netarium\Tests\TestServer();
        try {
            $server->start();
            $client = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($client->login('admin', 'admin123'));
            $unplaced = static function () use ($client): array {
                $data = $client->get('/api.php?action=data_quality')->assertOk()->getJson();
                return array_merge([], ...array_map(static fn($row) => $row['entity_ids'],
                    array_filter($data['issues'], static fn($row) => $row['code'] === 'unplaced_device')));
            };
            $this->assertTrue(in_array(3, $unplaced(), true));
            $db = new \PDO('sqlite:' . $server->getDbPath());
            $db->exec("INSERT INTO views (id,name,view_type) VALUES (90,'Quality Rack','rack')");
            $db->exec("INSERT INTO rack_settings VALUES (90,42,'')");
            $db->exec("INSERT INTO rack_mounts(device_id,view_id,face,start_u,height_u,width_slot) VALUES (3,90,'rear',1,2,'left')");
            $this->assertFalse(in_array(3, $unplaced(), true));
            $db->exec('DELETE FROM rack_mounts WHERE device_id = 3');
            $this->assertTrue(in_array(3, $unplaced(), true));
            $db->exec("INSERT INTO rack_shelves VALUES (1,90,'Shelf','front',1,1,'half')");
            $db->exec('INSERT INTO rack_shelf_devices VALUES (3,1,0)');
            $this->assertFalse(in_array(3, $unplaced(), true));
            $db->exec('DELETE FROM rack_shelf_devices WHERE device_id = 3');
            $this->assertTrue(in_array(3, $unplaced(), true));
        } finally {
            unset($db);
            $server->stop();
        }
    }

    public function testCommonConnectionsDiagnosePortAndRouteIntegrityWithoutRequiringPlacement(): void
    {
        $server = new \Netarium\Tests\TestServer();
        try {
            $server->start();
            $client = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($client->login('admin', 'admin123'));
            $client->postJson('/api.php?action=save_connections', ['links' => [[
                'operation' => 'create', 'link' => ['from_id' => 3, 'to_id' => 4],
            ], [
                'operation' => 'create', 'link' => ['from_id' => 1, 'to_id' => 2, 'from_port_name' => 'ge0/2'],
            ]]])->assertOk();
            $db = new \PDO('sqlite:' . $server->getDbPath());
            $db->exec('PRAGMA foreign_keys = OFF');
            $db->exec("INSERT INTO links (id, from_id, to_id, to_port_id) VALUES (90, 3, 2, 1)");
            $db->exec("INSERT INTO view_link_routes VALUES (2, 1, 4, '[]')");
            $db->exec("INSERT INTO legacy_link_conflicts VALUES (91, 2, 1, 3, 'port_conflict', '{}')");
            $response = $client->get('/api.php?action=data_quality')->assertOk()->getJson();
            $byCode = array_column($response['issues'], null, 'code');
            $this->assertFalse(isset($byCode['orphan_link_view']));
            $this->assertFalse(isset($byCode['link_endpoint_not_placed']));
            $this->assertFalse(isset($byCode['duplicate_link']));
            $this->assertSame([90], $byCode['invalid_link_port']['entity_ids']);
            $this->assertSame([1, 90], $byCode['duplicate_port_use']['entity_ids']);
            $this->assertSame([1, 4], $byCode['invalid_view_link_route']['details']['device_ids']);
            $this->assertSame('warning', $byCode['legacy_link_conflict']['severity']);
            $this->assertSame(91, $byCode['legacy_link_conflict']['details']['legacy_link_id']);
        } finally {
            unset($db);
            $server->stop();
        }
    }

    public function testPendingLegacyVlanIsDiagnosedOncePerLinkAcrossAllViews(): void
    {
        $server = new \Netarium\Tests\TestServer();
        try {
            $server->start();
            $client = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($client->login('admin', 'admin123'));
            $db = new \PDO('sqlite:' . $server->getDbPath());
            $db->exec("INSERT INTO devices (id, name, type) VALUES
                (101, '配置済み機器', 'switch'), (102, '未配置機器A', 'switch'),
                (103, '未配置機器B', 'switch'), (104, '未配置機器C', 'switch')");
            $db->exec('INSERT INTO device_placements (device_id, view_id, x, y)
                VALUES (101, 1, 10, 20), (101, 2, 30, 40)');
            $db->exec('INSERT INTO links (id, from_id, to_id) VALUES (101, 101, 102), (102, 102, 103), (103, 103, 104)');
            $db->exec("INSERT INTO legacy_link_vlans (link_id, vlan) VALUES (101, 'access 10'), (102, 'native 99')");
            $diagnose = static fn(): array => array_values(array_filter(
                $client->get('/api.php?action=data_quality')->assertOk()->getJson()['issues'],
                static fn(array $issue): bool => $issue['code'] === 'legacy_link_vlan'
            ));

            $issues = $diagnose();
            $this->assertSame([[101], [102]], array_column($issues, 'entity_ids'));
            foreach ($issues as $issue) {
                $this->assertSame('link', $issue['entity_type']);
                $this->assertSame('warning', $issue['severity']);
                $this->assertSame('integrity', $issue['category']);
            }
            $this->assertSame([
                ['link_id' => 101, 'device_ids' => [101, 102], 'vlan' => 'access 10'],
                ['link_id' => 102, 'device_ids' => [102, 103], 'vlan' => 'native 99'],
            ], array_column($issues, 'details'));

            $db->exec('DELETE FROM device_placements WHERE device_id = 101');
            $this->assertSame($issues, $diagnose(), '配置をすべて外しても旧 VLAN の診断は残る');
            $db->exec('DELETE FROM legacy_link_vlans WHERE link_id = 101');
            $this->assertSame([$issues[1]], $diagnose(), '残っている旧 VLAN だけを診断する');
        } finally {
            unset($db);
            $server->stop();
        }
    }

    public function testUnclassifiedIpv4RequiresSegmentsAndIdentifiesBothAddressKinds(): void
    {
        $server = new \Netarium\Tests\TestServer();
        try {
            $server->start();
            $client = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($client->login('admin', 'admin123'));
            $db = new \PDO('sqlite:' . $server->getDbPath());
            $db->exec("INSERT INTO devices(id,name,type,ip) VALUES
                (980201,'未分類機器','server','192.0.2.21'),
                (980202,'所属済み機器','server','192.0.2.22'),
                (980203,'空欄機器','server',''),
                (980204,'不正IP機器','server','999.0.2.24'),
                (980205,'IPv6機器','server','2001:db8::25')");
            $db->exec("INSERT INTO device_ip_addresses(id,device_id,ip,label,sort_order) VALUES
                (980201,980201,'198.51.100.21','業務',0),
                (980202,980202,'192.0.2.23','所属済み',0)");
            $diagnose = static fn(): array => $client->get('/api.php?action=data_quality')->assertOk()->getJson()['issues'];
            $unclassified = static fn(array $issues): array => array_values(array_filter(
                $issues, static fn(array $issue): bool => $issue['code'] === 'unclassified_ip'
            ));
            $this->assertSame([], $unclassified($diagnose()));
            $db->exec("INSERT INTO address_spaces(id,name,memo) VALUES(980201,'診断用空間','')");
            $this->assertSame([], $unclassified($diagnose()), '空間だけでは未分類診断を有効にしない');
            $db->exec("INSERT INTO ip_segments(id,address_space_id,cidr,name) VALUES(980201,980201,'192.0.2.0/24','診断用')");
            $db->exec('UPDATE devices SET ip_segment_id=980201 WHERE id=980202');
            $db->exec('UPDATE device_ip_addresses SET segment_id=980201 WHERE id=980202');
            $issues = array_values(array_filter($unclassified($diagnose()),
                static fn(array $issue): bool => in_array(980201, $issue['entity_ids'], true)
                    || in_array(980202, $issue['entity_ids'], true)
                    || in_array(980203, $issue['entity_ids'], true)
                    || in_array(980204, $issue['entity_ids'], true)
                    || in_array(980205, $issue['entity_ids'], true)));
            $this->assertCount(2, $issues);
            $byValue = array_column($issues, null, 'message');
            $this->assertCount(2, $byValue, '同一機器の複数IPを別々の診断として表示する');
            foreach ($issues as $issue) {
                $this->assertSame('warning', $issue['severity']);
                $this->assertSame('device', $issue['entity_type']);
                $this->assertSame([980201], $issue['entity_ids']);
                $this->assertStringContains($issue['details']['value'], $issue['message']);
                $this->assertSame(980201, $issue['details']['devices'][0]['id']);
            }
            $byIp = array_column(array_column($issues, 'details'), null, 'value');
            $this->assertSame('ip', $byIp['192.0.2.21']['field']);
            $this->assertSame('management', $byIp['192.0.2.21']['ip_records'][0]['kind']);
            $this->assertSame('additional_ips', $byIp['198.51.100.21']['field']);
            $this->assertSame('additional', $byIp['198.51.100.21']['ip_records'][0]['kind']);
            $this->assertSame(980201, $byIp['198.51.100.21']['ip_records'][0]['id']);
            $db->exec('UPDATE devices SET ip_segment_id=NULL WHERE id=980202');
            $db->exec('UPDATE device_ip_addresses SET segment_id=NULL WHERE id=980202');
            $db->exec('DELETE FROM ip_segments');
            $this->assertSame([], $unclassified($diagnose()));
        } finally {
            unset($db);
            $server->stop();
        }
    }

    public function testReachabilityWarningsSeparatePingAmbiguityFromAllowedIpDuplicates(): void
    {
        $server = new \Netarium\Tests\TestServer();
        try {
            $server->start();
            $client = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($client->login('admin', 'admin123'));
            $db = new \PDO('sqlite:' . $server->getDbPath());
            $db->exec("INSERT INTO address_spaces(id,name,ping_reachability) VALUES
                (980301,'到達区分A','reachable'),(980302,'比較区分B','unreachable')");
            $db->exec("INSERT INTO ip_segments(id,address_space_id,cidr,name) VALUES
                (980301,980301,'192.0.2.0/24','A'),(980302,980302,'192.0.2.0/24','B')");
            $db->exec("INSERT INTO devices(id,name,type,ip,ip_segment_id) VALUES
                (980301,'合成対象A','server','192.0.2.61',980301),
                (980302,'合成対象B','server','192.0.2.61',980302),
                (980303,'合成一意IP','server','192.0.2.62',980301)");
            $diagnose = static fn(): array => $client->get('/api.php?action=data_quality')->assertOk()->getJson();
            $warnings = static fn(array $result): array => array_values(array_filter(
                $result['issues'], static fn(array $issue): bool => $issue['code'] === 'ambiguous_ping_target'
            ));
            foreach ([
                ['reachable', 'unreachable', false, false],
                ['reachable', 'reachable', false, true],
                ['reachable', 'unset', false, true],
                ['reachable', 'unset', true, true],
                ['unset', 'unset', false, false],
                ['unreachable', 'unreachable', false, false],
                ['unset', 'unreachable', false, false],
            ] as [$stateA, $stateB, $unclassified, $expectedWarning]) {
                $db->prepare('UPDATE address_spaces SET ping_reachability=? WHERE id=980301')->execute([$stateA]);
                $db->prepare('UPDATE address_spaces SET ping_reachability=? WHERE id=980302')->execute([$stateB]);
                $db->exec('UPDATE devices SET ip_segment_id=' . ($unclassified ? 'NULL' : '980302') . ' WHERE id=980302');
                $result = $diagnose();
                $found = $warnings($result);
                $this->assertCount($expectedWarning ? 1 : 0, $found, "{$stateA}/{$stateB}/{$unclassified}");
                if (!$expectedWarning) { continue; }
                $this->assertSame('warning', $found[0]['severity']);
                $this->assertSame('monitoring', $found[0]['category']);
                $this->assertSame([980301, 980302], $found[0]['entity_ids']);
                $this->assertSame('192.0.2.61', $found[0]['details']['value']);
                $records = array_column($found[0]['details']['ip_records'], null, 'device_id');
                $this->assertSame('reachable', $records[980301]['ping_reachability']);
                $this->assertSame('到達区分A', $records[980301]['address_space_name']);
                $this->assertSame($unclassified ? null : 980302, $records[980302]['address_space_id']);
                $this->assertTrue($result['summary']['warning'] >= 1);
                $duplicates = array_values(array_filter($result['issues'], static fn(array $issue): bool =>
                    $issue['code'] === 'duplicate_ip' && ($issue['details']['value'] ?? '') === '192.0.2.61'));
                $this->assertCount($unclassified ? 1 : 0, $duplicates, '異なる区分間の同値IP自体は重複警告にしない');
            }
            // 相手が追加IPでも管理IPの判定に影響する。追加IPだけの重複は新警告にしない。
            $db->exec("UPDATE address_spaces SET ping_reachability='reachable'");
            $db->exec("UPDATE devices SET ip='192.0.2.63',ip_segment_id=980302 WHERE id=980302");
            $db->exec("INSERT INTO device_ip_addresses(device_id,ip,label,sort_order,segment_id)
                VALUES(980302,'192.0.2.61','比較',0,980302)");
            $this->assertCount(1, $warnings($diagnose()));
            $db->exec("UPDATE devices SET ip='192.0.2.64' WHERE id=980301");
            $db->exec("INSERT INTO device_ip_addresses(device_id,ip,label,sort_order,segment_id)
                VALUES(980301,'192.0.2.61','追加のみ',0,980301)");
            $this->assertSame([], $warnings($diagnose()));

            // 意図的な対象外の未実行・古い日時は問題化しないが、不正日時は維持する。
            $db->exec("UPDATE address_spaces SET ping_reachability='unreachable' WHERE id=980301");
            $db->exec("INSERT OR REPLACE INTO device_monitor_status(device_id,status,last_checked_at,last_response_ms,last_error)
                VALUES(980301,'unknown',NULL,NULL,NULL),(980303,'unknown','2000-01-01 00:00:00',NULL,NULL)");
            $monitorIssues = static fn(array $result): array => array_values(array_filter(
                $result['issues'], static fn(array $issue): bool =>
                    in_array($issue['code'], ['monitor_unconfirmed', 'stale_monitor'], true)
                    && array_intersect($issue['entity_ids'], [980301, 980303]) !== []
            ));
            $this->assertSame([], $monitorIssues($diagnose()));
            $db->exec("UPDATE device_monitor_status SET last_checked_at='invalid-date' WHERE device_id=980303");
            $invalid = array_values(array_filter($diagnose()['issues'], static fn(array $issue): bool =>
                $issue['code'] === 'invalid_monitor_date' && $issue['entity_ids'] === [980303]));
            $this->assertCount(1, $invalid);
        } finally {
            unset($db);
            $server->stop();
        }
    }

    public function testDataQualitySchemaAndOutput(): void
    {
        $res = $this->client->get('/api.php?action=data_quality');
        $res->assertOk();
        $json = $res->getJson();

        $this->assertTrue($json['ok']);
        $this->assertArrayHasKey('generated_at', $json);
        $this->assertArrayHasKey('revision', $json);
        $this->assertArrayHasKey('summary', $json);
        $this->assertArrayHasKey('settings', $json);

        // Check summary structure
        $summary = $json['summary'];
        $this->assertArrayHasKey('total', $summary);
        $this->assertArrayHasKey('error', $summary);
        $this->assertArrayHasKey('warning', $summary);
        $this->assertArrayHasKey('info', $summary);

        // Check settings structure
        $settings = $json['settings'];
        $this->assertArrayHasKey('stale_monitor_days', $settings);
        $this->assertArrayHasKey('identifier_case_insensitive', $settings);
        $this->assertArrayHasKey('recommended_device_fields', $settings);
        $this->assertArrayHasKey('similar_name_enabled', $settings);

        // Check issues array
        $this->assertTrue(is_array($json['issues'] ?? null), 'Issues should be an array');
    }

    public function testMaintenanceDiagnostics(): void
    {
        // 1. Load current topology
        $loadRes = $this->client->get('/api.php?action=load');
        $loadRes->assertOk();
        $loadData = $loadRes->getJson();
        $rev = (int)$loadData['revision'];

        $tokyo = new \DateTimeZone('Asia/Tokyo');
        $today = new \DateTimeImmutable('today', $tokyo);
        $expiredDate = $today->modify('-1 day')->format('Y-m-d');
        $approachingDate = $today->modify('+10 days')->format('Y-m-d');
        $todayDate = $today->format('Y-m-d');
        $futureDate = $today->modify('+100 days')->format('Y-m-d');

        // Add test devices with various expiry dates
        $devices = $loadData['devices'];
        $devices[] = [
            'id' => 901,
            'name' => '期限切れ機器',
            'type' => 'server',
            'install_date' => '2020-01-01',
            'maintenance_expiry' => $expiredDate,
        ];
        $devices[] = [
            'id' => 902,
            'name' => '期限接近機器',
            'type' => 'server',
            'install_date' => '2020-01-01',
            'maintenance_expiry' => $approachingDate,
        ];
        $devices[] = [
            'id' => 903,
            'name' => '当日有効機器',
            'type' => 'server',
            'install_date' => '2020-01-01',
            'maintenance_expiry' => $todayDate,
        ];
        $devices[] = [
            'id' => 904,
            'name' => '十分未来機器',
            'type' => 'server',
            'install_date' => '2020-01-01',
            'maintenance_expiry' => $futureDate,
        ];

        $saveRes = $this->client->postJson('/api.php?action=save', [
            'revision' => $rev,
            'views' => $loadData['views'],
            'devices' => $devices,
            'placements' => $loadData['placements'],
            'links' => $loadData['links'],
            'canvas_notes' => $loadData['canvas_notes'],
        ]);
        $saveRes->assertOk();

        // 2. Run data_quality
        $dqRes = $this->client->get('/api.php?action=data_quality');
        $dqRes->assertOk();
        $dqJson = $dqRes->getJson();

        $issues = $dqJson['issues'];
        $expiredFound = false;
        $approachingFound = false;
        $todayIsApproaching = false;
        $todayIsExpired = false;
        $futureExpiredOrApproaching = false;

        foreach ($issues as $issue) {
            $ids = $issue['entity_ids'] ?? [];
            $code = $issue['code'] ?? '';

            if (in_array(901, $ids, true) && $code === 'maintenance_expired') {
                $expiredFound = true;
            }
            if (in_array(902, $ids, true) && $code === 'maintenance_expiry_approaching') {
                $approachingFound = true;
            }
            if (in_array(903, $ids, true)) {
                if ($code === 'maintenance_expired') {
                    $todayIsExpired = true;
                }
                if ($code === 'maintenance_expiry_approaching') {
                    $todayIsApproaching = true;
                }
            }
            if (in_array(904, $ids, true) && in_array($code, ['maintenance_expired', 'maintenance_expiry_approaching'], true)) {
                $futureExpiredOrApproaching = true;
            }
        }

        $this->assertTrue($expiredFound, 'Device 901 must have maintenance_expired warning');
        $this->assertTrue($approachingFound, 'Device 902 must have maintenance_expiry_approaching info');
        $this->assertFalse($todayIsExpired, 'Device 903 (today) must NOT be expired (today is valid)');
        $this->assertTrue($todayIsApproaching, 'Device 903 (today) must be in approaching info (within 30 days)');
        $this->assertFalse($futureExpiredOrApproaching, 'Device 904 (+100 days) must NOT be expired or approaching');
    }

    public function testFloorMismatchDiagnosticUsesFloorPaths(): void
    {
        $db = new \PDO('sqlite::memory:');
        \Netarium\Core\Database::initialize($db);
        $db->exec("INSERT INTO buildings (id, name) VALUES (1, '本庁舎'), (2, '別館')");
        $db->exec("INSERT INTO floors (id, building_id, name) VALUES (10, 1, '1F'), (20, 2, '2F')");
        $db->exec("INSERT INTO views (id, name, view_type, floor_id) VALUES (100, '別館2F図', 'floor', 20)");
        $db->exec("INSERT INTO devices (id, name, type, floor_id) VALUES (200, 'SW-01', 'switch', 10)");
        $db->exec("INSERT INTO device_placements (id, device_id, view_id, x, y) VALUES (300, 200, 100, 10, 20)");

        $service = new \Netarium\Services\Quality\QualityDiagnosticService($db);
        $issues = array_values(array_filter(
            $service->diagnoseDataQuality([]),
            static fn(array $issue): bool => $issue['code'] === 'floor_mismatch'
        ));

        $this->assertSame(1, count($issues));
        $details = $issues[0]['details'];
        $this->assertSame(10, (int)$details['device_floor_id']);
        $this->assertSame(20, (int)$details['view_floor_id']);
        $this->assertSame('本庁舎 / 1F', $details['device_path']);
        $this->assertSame('別館 / 2F', $details['view_path']);
    }

    public function testRackFloorMismatchWarnsForExistingPlacementsOnOtherOrUnassignedFloors(): void
    {
        $db = new \PDO('sqlite::memory:');
        \Netarium\Core\Database::initialize($db);
        $db->exec("INSERT INTO buildings (id, name) VALUES (1, '本庁舎'), (2, '別館')");
        $db->exec("INSERT INTO floors (id, building_id, name) VALUES (10, 1, '1F'), (20, 2, '1F')");
        $db->exec("INSERT INTO views (id, name, view_type, floor_id) VALUES
            (100, '別館配置図', 'floor', 20), (101, '無所属予定図', 'floor', 10),
            (102, '本庁舎配置図', 'floor', 10),
            (200, 'ラックA', 'rack', 20), (201, 'ラックB', 'rack', 10),
            (202, 'ラックC', 'rack', 10), (203, '無所属ラック', 'rack', NULL),
            (204, '未配置ラック', 'rack', 10)");
        $db->exec('INSERT INTO floor_rack_placements (floor_view_id, rack_view_id, x, y) VALUES
            (100, 200, 10, 20), (101, 201, 10, 20), (102, 202, 10, 20), (102, 203, 30, 20)');
        $db->exec("INSERT INTO devices (id, name, type, floor_id) VALUES (200, 'SW-01', 'switch', 10)");
        $db->exec('INSERT INTO device_placements (id, device_id, view_id, x, y) VALUES (300, 200, 101, 10, 20)');
        $db->exec('UPDATE views SET floor_id = 10 WHERE id = 200');
        $db->exec('UPDATE views SET floor_id = NULL WHERE id = 101');

        $service = new \Netarium\Services\Quality\QualityDiagnosticService($db);
        $issues = $service->diagnoseDataQuality([]);
        $rackIssues = array_values(array_filter($issues, static fn(array $issue): bool => $issue['code'] === 'rack_floor_mismatch'));
        $this->assertCount(2, $rackIssues);
        $this->assertCount(0, array_filter($issues, static fn(array $issue): bool => $issue['code'] === 'floor_mismatch'));
        foreach ($rackIssues as $issue) {
            $this->assertSame('warning', $issue['severity']);
            $this->assertSame('placement', $issue['category']);
            $this->assertSame('view', $issue['entity_type']);
        }
        $this->assertSame([200], $rackIssues[0]['entity_ids']);
        $this->assertSame([
            'view_id' => 100,
            'rack_view_name' => 'ラックA',
            'view_name' => '別館配置図',
            'rack_floor_id' => 10,
            'view_floor_id' => 20,
            'rack_path' => '本庁舎 / 1F',
            'view_path' => '別館 / 1F',
        ], $rackIssues[0]['details']);
        $this->assertSame([201], $rackIssues[1]['entity_ids']);
        $this->assertSame(101, $rackIssues[1]['details']['view_id']);
        $this->assertSame(10, $rackIssues[1]['details']['rack_floor_id']);
        $this->assertSame(null, $rackIssues[1]['details']['view_floor_id']);
        $this->assertSame('本庁舎 / 1F', $rackIssues[1]['details']['rack_path']);
        $this->assertSame(null, $rackIssues[1]['details']['view_path']);
    }

    public function testNotApplicableItemsAreSharedAndSplitWithinDiagnosisGroups(): void
    {
        $this->withQualityClient(function (TestHttpClient $client, PDO $db, TestServer $server): void {
            $db->exec(<<<'SQL'
                INSERT INTO devices (id, name, type) VALUES
                    (10, 'ONU', 'other'), (11, 'スイッチ', 'switch'), (12, 'ルーター', 'router'), (13, '予備機', 'server');
                INSERT INTO device_ports (id, device_id, name) VALUES (15, 11, 'A1');
                INSERT INTO links (id, from_id, to_id, from_port_id) VALUES (20, 10, 11, NULL), (21, 11, 12, 15);
                SQL);
            $topology = $client->get('/api.php?action=load')->assertOk()->getJson();
            $deviceRevision = array_column($topology['devices'], 'resource_revision', 'id')[10];
            $linkRevisions = array_column($topology['links'], 'resource_revision', 'id');
            $before = $client->get(self::DIAGNOSE)->assertOk()->getJson();
            $this->assertSame(0, $before['suppressed_count']);
            $this->assertSame([], $before['suppressed_issues']);
            $bothPorts = $this->findIssue($before['issues'], 'link_ports_missing', 20);
            $this->assertSame('info', $bothPorts['severity']);
            $this->assertSame('completeness', $bothPorts['category']);
            $this->assertSame('link', $bothPorts['entity_type']);
            $this->assertSame([
                'from' => ['device_id' => 10, 'device_name' => 'ONU'],
                'to' => ['device_id' => 11, 'device_name' => 'スイッチ'],
            ], $bothPorts['details']['missing_endpoints']);
            $this->assertSame(['from_port', 'to_port'], array_column($bothPorts['not_applicable_items'], 'field'));
            $this->assertSame([$linkRevisions[20], $linkRevisions[20]], array_column($bothPorts['not_applicable_items'], 'resource_revision'));
            $onePort = $this->findIssue($before['issues'], 'link_ports_missing', 21);
            $this->assertSame(['to'], array_keys($onePort['details']['missing_endpoints']));
            $this->assertSame([$linkRevisions[21]], array_column($onePort['not_applicable_items'], 'resource_revision'));
            $this->assertCount(2, array_filter($before['issues'], static fn(array $issue): bool => $issue['code'] === 'link_ports_missing'));
            $maintenance = $this->findIssue($before['issues'], 'maintenance_expiry_missing', 10);
            $this->assertSame('info', $maintenance['severity']);
            $this->assertSame('maintenance', $maintenance['category']);
            $this->assertSame('maintenance_expiry', $maintenance['details']['field']);
            $this->assertSame([$deviceRevision], array_column($maintenance['not_applicable_items'], 'resource_revision'));
            $monitoring = $this->findIssue($before['issues'], 'monitoring_not_applicable', 10);
            $this->assertSame([$deviceRevision], array_column($monitoring['not_applicable_items'], 'resource_revision'));

            $changes = [
                ['code' => 'monitoring_not_applicable', 'field' => 'ip', 'device_id' => 10, 'expected_revision' => $deviceRevision],
                ['code' => 'maintenance_expiry_missing', 'field' => 'maintenance_expiry', 'device_id' => 10, 'expected_revision' => $deviceRevision],
                ['code' => 'missing_recommended_fields', 'field' => 'manufacturer', 'device_id' => 10, 'expected_revision' => $deviceRevision],
                ['code' => 'link_ports_missing', 'field' => 'from_port', 'device_id' => 10, 'link_id' => 20, 'expected_revision' => $linkRevisions[20]],
            ];
            foreach ($changes as $change) {
                $client->postJson(self::SET_NOT_APPLICABLE, $change + ['not_applicable' => true])->assertOk();
            }
            // Suppression does not invalidate a topology editor's existing snapshot or cascade on retained rows.
            $client->postJson('/api.php?action=save', $topology)->assertOk();
            $deviceRevision = (int)$db->query('SELECT resource_revision FROM devices WHERE id = 10')->fetchColumn();
            $otherSession = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($otherSession->login('admin', 'admin123'));
            $after = $otherSession->get(self::DIAGNOSE)->assertOk()->getJson();
            $this->assertSame(4, $after['suppressed_count']);
            $this->assertCount(4, $after['suppressed_issues']);
            $this->assertNull($this->findIssue($after['issues'], 'monitoring_not_applicable', 10));
            $this->assertNotNull($this->findIssue($after['issues'], 'monitoring_not_applicable', 11));
            $this->assertNull($this->findIssue($after['issues'], 'maintenance_expiry_missing', 10));
            $this->assertNotNull($this->findIssue($after['issues'], 'maintenance_expiry_missing', 13));

            $visibleFields = $this->findIssue($after['issues'], 'missing_recommended_fields', 10);
            $suppressedFields = $this->findIssue($after['suppressed_issues'], 'missing_recommended_fields', 10);
            $this->assertSame(['floor_id', 'location', 'model'], $visibleFields['details']['fields']);
            $this->assertSame(['設置フロア', '設置場所', '型番'], $visibleFields['details']['field_labels']);
            $this->assertSame(['manufacturer'], $suppressedFields['details']['fields']);
            $this->assertSame(['メーカー'], $suppressedFields['details']['field_labels']);
            $this->assertSame([[
                'field' => 'manufacturer', 'device_id' => 10, 'label' => 'メーカー', 'resource_revision' => $deviceRevision,
            ]], $suppressedFields['not_applicable_items']);
            $visiblePort = $this->findIssue($after['issues'], 'link_ports_missing', 20);
            $suppressedPort = $this->findIssue($after['suppressed_issues'], 'link_ports_missing', 20);
            $this->assertSame(['to'], array_keys($visiblePort['details']['missing_endpoints']));
            $this->assertSame(['to_port'], array_column($visiblePort['not_applicable_items'], 'field'));
            $this->assertSame(['from'], array_keys($suppressedPort['details']['missing_endpoints']));
            $this->assertSame(['from_port'], array_column($suppressedPort['not_applicable_items'], 'field'));
            $this->assertSame($before['summary']['warning'], $after['summary']['warning']);
            $this->assertSame($before['summary']['info'] - 2, $after['summary']['info']);
            $this->assertCount($after['summary']['total'], $after['issues']);

            $toPort = ['code' => 'link_ports_missing', 'field' => 'to_port', 'device_id' => 11, 'link_id' => 20, 'expected_revision' => $linkRevisions[20]];
            $client->postJson(self::SET_NOT_APPLICABLE, $toPort + ['not_applicable' => true])->assertOk();
            $bothSuppressed = $client->get(self::DIAGNOSE)->assertOk()->getJson();
            $this->assertSame(5, $bothSuppressed['suppressed_count']);
            $this->assertCount(4, $bothSuppressed['suppressed_issues']);
            $this->assertSame($bothPorts, $this->findIssue($bothSuppressed['suppressed_issues'], 'link_ports_missing', 20));
            $this->assertNull($this->findIssue($bothSuppressed['issues'], 'link_ports_missing', 20));
            foreach ([...$changes, $toPort] as $change) {
                if (!isset($change['link_id'])) {
                    $change['expected_revision'] = $deviceRevision;
                }
                $otherSession->postJson(self::SET_NOT_APPLICABLE, $change + ['not_applicable' => false])->assertOk();
            }
            $released = $client->get(self::DIAGNOSE)->assertOk()->getJson();
            $this->assertSame(0, $released['suppressed_count']);
            $this->assertSame($bothPorts, $this->findIssue($released['issues'], 'link_ports_missing', 20));
            $maintenance['not_applicable_items'][0]['resource_revision'] = $deviceRevision;
            $this->assertSame($maintenance, $this->findIssue($released['issues'], 'maintenance_expiry_missing', 10));
        });
    }

    public function testNotApplicableMutationRequiresAdminCsrfAndCurrentTargetsWithoutSavingTopology(): void
    {
        $this->withQualityClient(function (TestHttpClient $client, PDO $db, TestServer $server): void {
            $db->exec(<<<'SQL'
                INSERT INTO devices (id, name, type) VALUES (10, 'ONU', 'other'), (11, '', 'other');
                UPDATE devices SET maintenance_expiry = '2000-01-01' WHERE id = 1;
                INSERT INTO links (id, from_id, to_id) VALUES (20, 10, 11);
                SQL);
            $deviceRevision = static fn(): int => (int)$db->query('SELECT resource_revision FROM devices WHERE id = 10')->fetchColumn();
            $linkRevision = static fn(): int => (int)$db->query('SELECT resource_revision FROM links WHERE id = 20')->fetchColumn();
            $expiry = ['code' => 'maintenance_expiry_missing', 'field' => 'maintenance_expiry', 'device_id' => 10, 'expected_revision' => $deviceRevision()];
            $payload = $expiry + ['not_applicable' => true];
            $viewer = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($viewer->login('viewer', 'viewer123'));
            $viewer->get(self::DIAGNOSE)->assertStatus(403);
            $viewer->postJson(self::SET_NOT_APPLICABLE, $payload)->assertStatus(403);
            $client->get(self::SET_NOT_APPLICABLE)->assertStatus(405);
            $client->postJson(self::SET_NOT_APPLICABLE, $payload, ['X-CSRF-Token' => 'invalid'])->assertStatus(403);
            $this->assertSame(0, (int)$db->query('SELECT COUNT(*) FROM quality_not_applicable')->fetchColumn());

            $before = $client->get(self::DIAGNOSE)->assertOk()->getJson();
            foreach ([
                ['floor_view_without_plan', 'ip', 2],
                ['maintenance_expired', 'maintenance_expiry', 1],
                ['missing_required_fields', 'type', 11],
                ['missing_recommended_fields', 'name', 10],
                ['missing_recommended_fields', 'memo', 10],
                ['monitoring_not_applicable', 'location', 10],
                ['link_ports_missing', 'ip', 10],
            ] as [$code, $field, $deviceId]) {
                $client->postJson(self::SET_NOT_APPLICABLE, [
                    'code' => $code, 'field' => $field, 'device_id' => $deviceId, 'not_applicable' => true,
                    'expected_revision' => $expiry['expected_revision'],
                ])->assertStatus(400);
            }
            foreach ([['floor_view_without_plan', 2], ['missing_required_fields', 11], ['maintenance_expired', 1]] as [$code, $id]) {
                $this->assertArrayNotHasKey('not_applicable_items', $this->findIssue($before['issues'], $code, $id));
            }
            $client->postJson(self::SET_NOT_APPLICABLE, $expiry + ['not_applicable' => 1])->assertStatus(400);
            $client->postJson(self::SET_NOT_APPLICABLE, $payload + ['link_id' => 20])->assertStatus(400);
            $link = ['code' => 'link_ports_missing', 'field' => 'from_port', 'device_id' => 10, 'expected_revision' => $linkRevision()];
            $client->postJson(self::SET_NOT_APPLICABLE, $link + ['not_applicable' => true])->assertStatus(400);
            $missingRevision = $payload;
            unset($missingRevision['expected_revision']);
            $client->postJson(self::SET_NOT_APPLICABLE, $missingRevision)->assertError(400, 'expected_revision');
            foreach (['31', true, 31.5, 0] as $invalid) {
                $client->postJson(self::SET_NOT_APPLICABLE, array_replace($payload, [
                    'expected_revision' => $invalid,
                ]))->assertError(400, 'expected_revision');
            }
            $client->postJson(self::SET_NOT_APPLICABLE, array_replace($link, [
                'link_id' => 20, 'expected_revision' => $expiry['expected_revision'], 'not_applicable' => true,
            ]))->assertStatus(409);
            foreach ([true, false] as $state) {
                $client->postJson(self::SET_NOT_APPLICABLE, array_replace($expiry, ['device_id' => 999, 'not_applicable' => $state]))->assertStatus(409);
                $client->postJson(self::SET_NOT_APPLICABLE, $link + ['link_id' => 999, 'not_applicable' => $state])->assertStatus(409);
                $client->postJson(self::SET_NOT_APPLICABLE, array_replace($link, [
                    'device_id' => 11, 'link_id' => 20, 'not_applicable' => $state,
                ]))->assertStatus(409);
            }

            $historyCount = $db->query('SELECT COUNT(*) FROM change_history')->fetchColumn();
            $saved = $client->postJson(self::SET_NOT_APPLICABLE, $payload)->assertOk()->getJson();
            $this->assertFalse($saved['unchanged']);
            $this->assertTrue($client->postJson(self::SET_NOT_APPLICABLE, $payload)->assertOk()->getJson()['unchanged']);
            $release = $expiry + ['not_applicable' => false];
            $cleared = $client->postJson(self::SET_NOT_APPLICABLE, $release)->assertOk()->getJson();
            $this->assertFalse($cleared['unchanged']);
            $this->assertTrue($client->postJson(self::SET_NOT_APPLICABLE, $release)->assertOk()->getJson()['unchanged']);
            $client->postJson(self::SET_NOT_APPLICABLE, $payload)->assertOk();
            $db->exec("UPDATE devices SET maintenance_expiry = '2099-12-31' WHERE id = 10");
            $stale = $client->postJson(self::SET_NOT_APPLICABLE, $payload)->assertStatus(409)->getJson();
            $this->assertStringContains('再診断', $stale['error']);
            $client->postJson(self::SET_NOT_APPLICABLE, $release)->assertStatus(409);
            $release['expected_revision'] = $deviceRevision();
            $this->assertTrue($client->postJson(self::SET_NOT_APPLICABLE, $release)->assertOk()->getJson()['unchanged']);
            $db->exec("INSERT INTO device_ports (id, device_id, name) VALUES (15, 10, 'P1'); UPDATE links SET from_port_id = 15 WHERE id = 20");
            $link['expected_revision'] = $linkRevision();
            $client->postJson(self::SET_NOT_APPLICABLE, $link + ['link_id' => 20, 'not_applicable' => true])->assertStatus(409);
            $this->assertTrue($client->postJson(self::SET_NOT_APPLICABLE, $link + [
                'link_id' => 20, 'not_applicable' => false,
            ])->assertOk()->getJson()['unchanged']);
            $after = $client->get(self::DIAGNOSE)->assertOk()->getJson();
            $this->assertSame($before['revision'], $after['revision']);
            $this->assertSame($historyCount, $db->query('SELECT COUNT(*) FROM change_history')->fetchColumn());
            $this->assertSame(0, (int)$db->query('SELECT COUNT(*) FROM quality_not_applicable')->fetchColumn());
            $this->assertNull($this->findIssue($after['issues'], 'maintenance_expiry_missing', 10));
            $this->assertSame(['to'], array_keys($this->findIssue($after['issues'], 'link_ports_missing', 20)['details']['missing_endpoints']));

            $this->assertArrayHasKey('request_id', $saved);
            $this->assertArrayHasKey('request_id', $cleared);
            $entries = [];
            foreach (glob($server->getTempDir() . '/logs/audit/audit-*.log') ?: [] as $file) {
                foreach (file($file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
                    $entry = json_decode($line, true, flags: JSON_THROW_ON_ERROR);
                    if (in_array($entry['request_id'], [$saved['request_id'], $cleared['request_id']], true)) {
                        $entries[$entry['request_id']][] = $entry;
                    }
                }
            }
            foreach (['set' => $saved, 'clear' => $cleared] as $operation => $result) {
                $log = $entries[$result['request_id']];
                $this->assertSame(['quality.set_not_applicable', 'quality.set_not_applicable'], array_column($log, 'event'));
                $this->assertSame(['started', 'success'], array_column($log, 'outcome'));
                $this->assertSame('device', $log[1]['target_type']);
                $this->assertSame(10, $log[1]['target_id']);
                $this->assertSame(1, $log[1]['target_count']);
                $this->assertSame([$operation, 'maintenance_expiry'], $log[1]['codes']);
            }
        });
    }

    public function testNotApplicableRejectsPreRestoreTargetsEvenWhenIdsAndMissingFieldsMatch(): void
    {
        $this->withQualityClient(function (TestHttpClient $client, PDO $db, TestServer $server): void {
            $db->exec('UPDATE links SET from_port_id = NULL WHERE id = 1');
            $oldTab = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($oldTab->login('admin', 'admin123'));
            $before = $oldTab->get(self::DIAGNOSE)->assertOk()->getJson();

            $archive = $server->getTempDir() . '/quality-restore.zip';
            file_put_contents($archive, $client->postJson('/api.php?action=export_backup_zip', [])->assertStatus(200)->getBody());
            $preview = $client->postMultipart('/api.php?action=preview_backup_restore', [], [
                'backup_zip' => ['path' => $archive, 'filename' => 'quality-restore.zip', 'type' => 'application/zip'],
            ])->assertOk()->getJson();
            $client->postJson('/api.php?action=commit_backup_restore', [
                'restore_token' => $preview['restore_token'], 'confirmation' => 'バックアップから復元',
            ])->assertOk();
            $restored = $client->get(self::DIAGNOSE)->assertOk()->getJson();

            foreach (['maintenance_expiry_missing' => 'maintenance_expiry', 'link_ports_missing' => 'from_port'] as $code => $field) {
                $oldIssue = $this->findIssue($before['issues'], $code, 1);
                $newIssue = $this->findIssue($restored['issues'], $code, 1);
                $this->assertSame($oldIssue['details'], $newIssue['details']);
                [$oldItem] = $oldIssue['not_applicable_items'];
                [$newItem] = $newIssue['not_applicable_items'];
                $this->assertSame($field, $newItem['field']);
                $this->assertSame(1, $newItem['device_id']);
                $this->assertTrue($newItem['resource_revision'] > $oldItem['resource_revision']);

                $target = ['code' => $code, 'field' => $field, 'device_id' => $newItem['device_id']];
                if ($code === 'link_ports_missing') {
                    $target['link_id'] = $newIssue['entity_ids'][0];
                }
                $stale = $target + ['expected_revision' => $oldItem['resource_revision']];
                $latest = $target + ['expected_revision' => $newItem['resource_revision']];
                $oldTab->postJson(self::SET_NOT_APPLICABLE, $stale + ['not_applicable' => true])->assertError(409, '再診断');
                $this->assertFalse($client->postJson(self::SET_NOT_APPLICABLE, $latest + [
                    'not_applicable' => true,
                ])->assertOk()->getJson()['unchanged']);
                $suppressed = $client->get(self::DIAGNOSE)->assertOk()->getJson();
                $this->assertSame($newIssue, $this->findIssue($suppressed['suppressed_issues'], $code, 1));
                $oldTab->postJson(self::SET_NOT_APPLICABLE, $stale + ['not_applicable' => false])->assertError(409, '再診断');
                $this->assertFalse($client->postJson(self::SET_NOT_APPLICABLE, $latest + [
                    'not_applicable' => false,
                ])->assertOk()->getJson()['unchanged']);
            }
            $after = $client->get(self::DIAGNOSE)->assertOk()->getJson();
            $this->assertSame(0, $after['suppressed_count']);
            $this->assertSame($restored['revision'], $after['revision']);
        });
    }

    public function testSchema29MigratesEmptyAndKeepsSuppressionAlignedWithUpdatesAndDeletes(): void
    {
        $db = new PDO('sqlite::memory:');
        Database::configure($db);
        for ($version = 1; $version <= 28; $version++) {
            ('migrateDatabaseToVersion' . $version)($db);
        }
        $db->exec(<<<'SQL'
            INSERT INTO buildings (id, name) VALUES (1, '本庁舎');
            INSERT INTO floors (id, building_id, name) VALUES (1, 1, '1F');
            INSERT INTO devices (id, name, type) VALUES (1, 'ONU', 'other'), (2, '対向機器', 'switch'), (3, '予備機', 'server');
            INSERT INTO device_ports (id, device_id, name) VALUES (10, 3, 'Gi1');
            INSERT INTO links (id, from_id, to_id) VALUES (20, 1, 2), (21, 2, 3);
            SQL);
        $beforeRevision = $db->query("SELECT meta_value FROM app_meta WHERE meta_key = 'data_revision'")->fetchColumn();
        \migrateDatabase($db);
        $this->assertSame(29, (int)$db->query('PRAGMA user_version')->fetchColumn());
        $this->assertSame($beforeRevision, $db->query("SELECT meta_value FROM app_meta WHERE meta_key = 'data_revision'")->fetchColumn());
        $this->assertSame([], $db->query('SELECT * FROM quality_not_applicable')->fetchAll());

        $insert = $db->prepare('INSERT INTO quality_not_applicable (device_id, link_id, field) VALUES (?, ?, ?)');
        foreach (QualityNotApplicable::DEVICE_FIELDS as $field) {
            $insert->execute([1, null, $field]);
        }
        $insert->execute([1, 20, 'from_port']);
        $insert->execute([2, 20, 'to_port']);
        $insert->execute([2, 21, 'from_port']);
        $insert->execute([3, 21, 'to_port']);
        foreach ([[1, null, 'ip'], [2, 20, 'from_port'], [1, null, 'name'], [1, null, 'from_port'],
            [1, 20, 'ip'], [999, null, 'ip'], [1, 999, 'from_port']] as $row) {
            try {
                $insert->execute($row);
                $this->fail('Invalid or duplicate suppression was accepted');
            } catch (PDOException $e) {
                $this->assertSame('23000', $e->getCode());
            }
        }
        $fields = static fn(string $scope): array => $db->query(
            "SELECT field FROM quality_not_applicable WHERE {$scope} ORDER BY field"
        )->fetchAll(PDO::FETCH_COLUMN);
        $db->exec("UPDATE devices SET ip = char(9, 10, 0, 32, 11, 13), name = '名称変更' WHERE id = 1");
        $this->assertCount(count(QualityNotApplicable::DEVICE_FIELDS), $fields('device_id = 1 AND link_id IS NULL'));
        $db->exec("UPDATE devices SET ip = char(0) || '192.0.2.1', floor_id = 1, location = 'A',
            manufacturer = 'B', model = 'C', asset_number = 'D', serial_number = 'E', mac_address = 'F',
            memo = char(12), maintenance_expiry = '2099-12-31' WHERE id = 1");
        $this->assertSame([], $fields('device_id = 1 AND link_id IS NULL'));
        $db->exec("UPDATE devices SET ip = '', floor_id = NULL, maintenance_expiry = '' WHERE id = 1");
        $this->assertSame([], $fields('device_id = 1 AND link_id IS NULL'));
        $db->exec("UPDATE links SET label = '変更' WHERE id = 20");
        $this->assertSame(['from_port', 'to_port'], $fields('link_id = 20'));
        $db->exec('UPDATE links SET from_id = 3 WHERE id = 20');
        $this->assertSame(['to_port'], $fields('link_id = 20'));
        $insert->execute([3, 20, 'from_port']);
        $db->exec('UPDATE links SET to_id = 1 WHERE id = 20');
        $this->assertSame(['from_port'], $fields('link_id = 20'));
        $insert->execute([1, 20, 'to_port']);
        $db->exec('UPDATE links SET from_port_id = 10 WHERE id = 20');
        $this->assertSame(['to_port'], $fields('link_id = 20'));
        $db->exec('DELETE FROM links WHERE id = 20');
        $this->assertSame([], $fields('link_id = 20'));
        $insert->execute([2, null, 'ip']);
        $insert->execute([3, null, 'ip']);
        $db->exec('DELETE FROM devices WHERE id = 2');
        $this->assertSame([], $fields('link_id = 21 OR device_id = 2'));
        $this->assertSame(['ip'], $fields('device_id = 3'));
        $this->assertSame([], $db->query('PRAGMA foreign_key_check')->fetchAll());
    }

    private function withQualityClient(callable $test): void
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
            unset($db);
            $server->stop();
        }
    }

    private function findIssue(array $issues, string $code, int $id): ?array
    {
        foreach ($issues as $issue) {
            if ($issue['code'] === $code && $issue['entity_ids'] === [$id]) {
                return $issue;
            }
        }
        return null;
    }
}
