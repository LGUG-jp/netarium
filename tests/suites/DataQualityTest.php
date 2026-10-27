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
