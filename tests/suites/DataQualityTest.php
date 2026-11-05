<?php
declare(strict_types=1);

namespace Netarium\Tests\Suites;

use Netarium\Tests\TestCase;
use Netarium\Tests\TestHttpClient;

class DataQualityTest extends TestCase
{
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
}
