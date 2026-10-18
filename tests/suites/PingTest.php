<?php
declare(strict_types=1);

namespace Netarium\Tests\Suites;

use PDO;
use Netarium\Core\ApiException;
use Netarium\Core\Config;
use Netarium\Core\OperationGate;
use Netarium\Services\Monitoring\PingService;
use Netarium\Tests\TestCase;
use Netarium\Tests\TestHttpClient;
class PingTest extends TestCase
{
    private TestHttpClient $client;

    public function __construct(TestHttpClient $client)
    {
        $this->client = $client;
    }

    public function testPingEmptyTargets(): void
    {
        $load = $this->client->get('/api.php?action=load');
        $load->assertOk();

        $res = $this->client->postJson('/api.php?action=ping', [
            'revision' => (int)$load->getJson()['revision'],
            'targets' => [],
        ]);

        $res->assertOk();
        $json = $res->getJson();
        $this->assertTrue($json['ok']);
        $this->assertSame([], $json['results']);
        $this->assertSame(0, $json['summary']['total']);
        $this->assertArrayHasKey('monitor_revision', $json);
        $this->assertArrayHasKey('last_monitored_at', $json);
        $this->assertSame((int)$load->getJson()['monitor_revision'], (int)$json['monitor_revision']);
        $this->assertSame($load->getJson()['last_monitored_at'], $json['last_monitored_at']);
        $after = $this->client->get('/api.php?action=load');
        $after->assertOk();
        $this->assertSame($load->getJson()['devices'], $after->getJson()['devices']);
    }

    public function testPingLoopbackTargetAndRevisionIncrement(): void
    {
        // 1. Get current monitor revision
        $loadRes = $this->client->get('/api.php?action=load');
        $loadRes->assertOk();
        $loadJson = $loadRes->getJson();
        $initMonitorRev = (int)$loadJson['monitor_revision'];

        // 2. Ping 127.0.0.1 for device 3
        $res = $this->client->postJson('/api.php?action=ping', [
            'revision' => (int)$loadJson['revision'],
            'targets' => [
                ['id' => 3, 'ip' => '127.0.0.1'],
            ],
        ]);

        $res->assertOk();
        $json = $res->getJson();
        $this->assertTrue($json['ok']);
        $this->assertSame(1, $json['summary']['total']);
        $this->assertCount(1, $json['results']);

        $result = $json['results'][0];
        $this->assertSame(3, $result['id']);
        $this->assertSame('127.0.0.1', $result['ip']);
        $this->assertTrue(in_array($result['status'], ['green', 'red', 'unknown'], true));
        $this->assertTrue(in_array($result['outcome'], ['success', 'failure', 'timeout'], true));
        $this->assertArrayHasKey('checked_at', $result);
        $this->assertArrayHasKey('response_ms', $result);
        $this->assertArrayHasKey('error', $result);

        // Verify monitor revision incremented
        $this->assertSame($initMonitorRev + 1, (int)$json['monitor_revision']);
        $this->assertNotNull($json['last_monitored_at']);
    }

    public function testPingRestrictedPublicIp(): void
    {
        $load = $this->client->get('/api.php?action=load');
        $load->assertOk();

        $res = $this->client->postJson('/api.php?action=ping', [
            'revision' => (int)$load->getJson()['revision'],
            'targets' => [
                ['id' => 4, 'ip' => '8.8.8.8'], // Public IP
            ],
        ]);

        $res->assertOk();
        $json = $res->getJson();
        $this->assertCount(1, $json['results']);
        $result = $json['results'][0];

        $this->assertSame('unknown', $result['status']);
        $this->assertSame('skipped', $result['outcome']);
        $this->assertTrue((string)$result['error'] !== '');
    }

    public function testPingValidationErrors(): void
    {
        $load = $this->client->get('/api.php?action=load');
        $load->assertOk();
        $revision = (int)$load->getJson()['revision'];

        // 1. targets is not an array
        $resNotArray = $this->client->postJson('/api.php?action=ping', [
            'revision' => $revision,
            'targets' => 'invalid_string',
        ]);
        $resNotArray->assertStatus(400);

        // 2. target with invalid ID
        $resInvalidId = $this->client->postJson('/api.php?action=ping', [
            'revision' => $revision,
            'targets' => [
                ['id' => 0, 'ip' => '127.0.0.1'],
            ],
        ]);
        $resInvalidId->assertStatus(400);

        // 3. Duplicate target ID
        $resDup = $this->client->postJson('/api.php?action=ping', [
            'revision' => $revision,
            'targets' => [
                ['id' => 1, 'ip' => '192.168.1.1'],
                ['id' => 1, 'ip' => '192.168.1.1'],
            ],
        ]);
        $resDup->assertStatus(400);
    }

    public function testPingRejectsStaleDataRevision(): void
    {
        $load = $this->client->get('/api.php?action=load');
        $load->assertOk();

        $res = $this->client->postJson('/api.php?action=ping', [
            'revision' => (int)$load->getJson()['revision'] + 1,
            'targets' => [],
        ]);

        $res->assertStatus(409);
    }

    public function testPingConcurrentDataUpdateAbortsAndPreservesState(): void
    {
        $dbPath = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'netarium_ping_test_' . bin2hex(random_bytes(6)) . '.sqlite';
        require_once dirname(__DIR__, 2) . '/src/Core/Database.php';

        $db = new PDO('sqlite:' . $dbPath);
        \Netarium\Core\Database::initialize($db);
        $externalDb = new PDO('sqlite:' . $dbPath);

        // Seed 1 device, monitor status, and app_meta
        $db->exec("INSERT INTO devices (id, name, type, ip) VALUES (1, 'テスト機器', 'server', '10.0.0.1')");
        $db->exec("INSERT INTO device_monitor_status (device_id, status) VALUES (1, 'unknown')");
        $db->exec("INSERT OR REPLACE INTO app_meta (meta_key, meta_value) VALUES ('data_revision', '1'), ('monitor_revision', '1')");

        $subclass = new class($db, $externalDb) extends PingService {
            private PDO $externalDb;
            public function __construct(PDO $db, PDO $externalDb) {
                parent::__construct($db);
                $this->externalDb = $externalDb;
            }
            public function pingHostWindows(string $ip, int $timeoutMs, bool $restrictPrivateOnly): array {
                // Simulate concurrent user incrementing data_revision and updating device IP
                $this->externalDb->exec("UPDATE app_meta SET meta_value = '2' WHERE meta_key = 'data_revision'");
                $this->externalDb->exec("UPDATE devices SET ip = '10.0.0.99' WHERE id = 1");
                return ['status' => 'red', 'outcome' => 'failure', 'response_ms' => null, 'error' => 'error'];
            }
        };

        $config = Config::create();
        try {
            $subclass->executePing([['id' => 1, 'ip' => '10.0.0.1']], 1, $config);
            $this->fail('executePing must fail with 409 when data_revision changed during execution');
        } catch (ApiException $e) {
            $this->assertSame(409, $e->getHttpStatus());
        }

        // Verify device 1 status was NOT updated to 'red' in DB
        $stmt = $db->query("SELECT status FROM device_monitor_status WHERE device_id = 1");
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        $this->assertSame('unknown', $row['status']);

        // Verify monitor_revision was NOT incremented
        $metaStmt = $db->query("SELECT meta_value FROM app_meta WHERE meta_key = 'monitor_revision'");
        $metaRow = $metaStmt->fetch(PDO::FETCH_ASSOC);
        $this->assertSame('1', $metaRow['meta_value']);

        unset($db, $externalDb);
        @unlink($dbPath);
    }

    public function testPingDeadlineSavesCompletedAndSkippedResults(): void
    {
        $dbPath = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'netarium_ping_time_' . bin2hex(random_bytes(6)) . '.sqlite';
        require_once dirname(__DIR__, 2) . '/src/Core/Database.php';

        $db = new PDO('sqlite:' . $dbPath);
        \Netarium\Core\Database::initialize($db);

        $db->exec("INSERT INTO devices (id, name, type, ip) VALUES (1, 'テスト機器1', 'server', '10.0.0.1'), (2, 'テスト機器2', 'server', '10.0.0.2'), (3, '未選択機器', 'server', '10.0.0.3')");
        $db->exec("INSERT INTO device_monitor_status (device_id, status, last_checked_at, last_response_ms, last_error) VALUES (1, 'unknown', NULL, NULL, NULL), (2, 'green', '2020-01-01 00:00:00', 1, NULL), (3, 'red', '2020-01-01 00:00:00', NULL, 'previous failure')");
        $db->exec("INSERT OR REPLACE INTO app_meta (meta_key, meta_value) VALUES ('data_revision', '1'), ('monitor_revision', '1')");

        $subclass = new class($db) extends PingService {
            public array $calledIps = [];
            public function pingHostWindows(string $ip, int $timeoutMs, bool $restrictPrivateOnly): array {
                $this->calledIps[] = $ip;
                usleep(25000); // 25ms
                return ['status' => 'green', 'outcome' => 'success', 'response_ms' => 10, 'error' => null];
            }
        };

        $config = Config::create();
        $config['ping_max_duration_ms'] = 10; // 10ms max duration

        $unselectedBefore = $db->query("SELECT * FROM device_monitor_status WHERE device_id = 3")->fetch(PDO::FETCH_ASSOC);
        $result = $subclass->executePing([
            ['id' => 1, 'ip' => '10.0.0.1'],
            ['id' => 2, 'ip' => '10.0.0.2'],
        ], 1, $config);
        $this->assertTrue($result['ok']);
        $this->assertSame(['10.0.0.1'], $subclass->calledIps);
        $this->assertSame(['success', 'skipped'], array_column($result['results'], 'outcome'));
        $this->assertSame(1, $result['summary']['success']);
        $this->assertSame(1, $result['summary']['skipped']);
        $this->assertSame('green', $result['results'][0]['status']);
        $this->assertSame('unknown', $result['results'][1]['status']);
        $this->assertNull($result['results'][1]['response_ms']);
        $this->assertTrue((string)$result['results'][1]['error'] !== '');
        foreach ($result['results'] as $item) {
            $stored = $db->query("SELECT status, last_checked_at AS checked_at, last_response_ms AS response_ms, last_error AS error FROM device_monitor_status WHERE device_id = " . $item['id'])->fetch(PDO::FETCH_ASSOC);
            $this->assertSame($item['status'], $stored['status']);
            $this->assertSame($item['checked_at'], $stored['checked_at']);
            $this->assertSame($item['response_ms'], $stored['response_ms']);
            $this->assertSame($item['error'], $stored['error']);
        }
        $this->assertSame(2, $result['monitor_revision']);
        $this->assertSame($unselectedBefore, $db->query("SELECT * FROM device_monitor_status WHERE device_id = 3")->fetch(PDO::FETCH_ASSOC));

        // 最後の一件が期限を越えて完了しても、その成功結果を保存する。
        $lastResult = $subclass->executePing([['id' => 1]], 1, $config);
        $this->assertSame('success', $lastResult['results'][0]['outcome']);
        $this->assertSame(3, $lastResult['monitor_revision']);

        unset($db);
        @unlink($dbPath);
    }

    public function testWindowsOutputClassifiesTimeoutAndPreservesReasons(): void
    {
        $service = new PingService(new PDO('sqlite::memory:'));
        foreach (['Request timed out.', '要求がタイムアウトしました。'] as $reason) {
            $output = $reason . "\nPing statistics:\nPackets: Sent = 1, Received = 0, Lost = 1\n(100% loss)\nEnd";
            $result = $service->parseWindowsPingOutput($output, 1);
            $this->assertSame('red', $result['status']);
            $this->assertSame('timeout', $result['outcome']);
            $this->assertNull($result['response_ms']);
            $this->assertStringContains($reason, $result['error']);
        }
        foreach (['Destination host unreachable.', '宛先ホストに到達できません。'] as $reason) {
            $result = $service->parseWindowsPingOutput("Reply: TTL=64\n" . $reason, 0);
            $this->assertSame('failure', $result['outcome']);
            $this->assertSame('red', $result['status']);
            $this->assertStringContains($reason, $result['error']);
        }
        $success = $service->parseWindowsPingOutput('Reply: time=2ms TTL=128', 0);
        $this->assertSame('success', $success['outcome']);
        $this->assertSame(2, $success['response_ms']);
        $this->assertNull($success['error']);
    }

    public function testMixedResultsPreserveUnselectedMonitorState(): void
    {
        require_once dirname(__DIR__, 2) . '/src/Core/Database.php';
        $db = new PDO('sqlite::memory:');
        \Netarium\Core\Database::initialize($db);
        $insert = $db->prepare("INSERT INTO devices (id, name, type, ip) VALUES (?, ?, 'server', ?)");
        foreach (['10.0.0.1', '10.0.0.2', '10.0.0.3', '', 'invalid', '8.8.8.8', '10.0.0.7'] as $index => $ip) {
            $insert->execute([$index + 1, '機器' . ($index + 1), $ip]);
        }
        $db->exec("INSERT INTO device_monitor_status (device_id, status, last_checked_at, last_error) VALUES (7, 'red', '2020-01-01 00:00:00', 'previous failure')");
        $db->exec("INSERT OR REPLACE INTO app_meta (meta_key, meta_value) VALUES ('data_revision', '1'), ('monitor_revision', '1')");
        $service = new class($db) extends PingService {
            public function pingHostWindows(string $ip, int $timeoutMs, bool $restrictPrivateOnly): array {
                $outputs = [
                    '10.0.0.1' => ['Reply: time=1ms TTL=128', 0],
                    '10.0.0.2' => ['Destination host unreachable.', 1],
                    '10.0.0.3' => ['Request timed out.', 1],
                ];
                if (isset($outputs[$ip])) {
                    return $this->parseWindowsPingOutput(...$outputs[$ip]);
                }
                return parent::pingHostWindows($ip, $timeoutMs, $restrictPrivateOnly);
            }
        };
        $before = $db->query("SELECT * FROM device_monitor_status WHERE device_id = 7")->fetch(PDO::FETCH_ASSOC);
        $targets = array_map(static fn(int $id): array => ['id' => $id], range(1, 6));
        $result = $service->executePing($targets, 1, Config::create());
        $this->assertSame(['success', 'failure', 'timeout', 'skipped', 'skipped', 'skipped'], array_column($result['results'], 'outcome'));
        $this->assertSame(1, $result['summary']['success']);
        $this->assertSame(1, $result['summary']['failure']);
        $this->assertSame(1, $result['summary']['timeout']);
        $this->assertSame(3, $result['summary']['skipped']);
        $storedStatuses = $db->query("SELECT status FROM device_monitor_status WHERE device_id <= 6 ORDER BY device_id")->fetchAll(PDO::FETCH_COLUMN);
        $this->assertSame(['green', 'red', 'red', 'unknown', 'unknown', 'unknown'], $storedStatuses);
        $this->assertSame($before, $db->query("SELECT * FROM device_monitor_status WHERE device_id = 7")->fetch(PDO::FETCH_ASSOC));
        $this->assertSame(6, (int)$db->query("SELECT COUNT(*) FROM device_monitor_status WHERE device_id <> 7")->fetchColumn());
    }

    public function testPingHundredTargetLimitHasNoSideEffectsOnRejection(): void
    {
        $load = $this->client->get('/api.php?action=load');
        $load->assertOk();
        $response = $this->client->postJson('/api.php?action=ping', [
            'revision' => (int)$load->getJson()['revision'],
            'targets' => array_map(static fn(int $id): array => ['id' => $id], range(1, 101)),
        ]);
        $response->assertStatus(400);
        $after = $this->client->get('/api.php?action=load');
        $after->assertOk();
        $this->assertSame($load->getJson()['monitor_revision'], $after->getJson()['monitor_revision']);
        $this->assertSame($load->getJson()['devices'], $after->getJson()['devices']);

        require_once dirname(__DIR__, 2) . '/src/Core/Database.php';
        $db = new PDO('sqlite::memory:');
        \Netarium\Core\Database::initialize($db);
        $insert = $db->prepare("INSERT INTO devices (id, name, type, ip) VALUES (?, ?, 'server', '')");
        foreach (range(1, 100) as $id) {
            $insert->execute([$id, '機器' . $id]);
        }
        $db->exec("INSERT OR REPLACE INTO app_meta (meta_key, meta_value) VALUES ('data_revision', '1')");
        $service = new PingService($db);
        $result = $service->executePing(array_map(static fn(int $id): array => ['id' => $id], range(1, 100)), 1, Config::create());
        $this->assertCount(100, $result['results']);
        $this->assertSame(100, $result['summary']['skipped']);
        $this->assertSame(100, (int)$db->query("SELECT COUNT(*) FROM device_monitor_status")->fetchColumn());
    }

    public function testPingExclusiveLockRejectsConcurrentRequests(): void
    {
        $lockPath = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'netarium_ping_lock_' . bin2hex(random_bytes(6)) . '.lock';
        $gate1 = new OperationGate($lockPath);
        $gate1->acquireExclusive('現在、別のPingが実行中です。終了後に再度実行してください');

        $gate2 = new OperationGate($lockPath);
        try {
            $gate2->acquireExclusive('現在、別のPingが実行中です。終了後に再度実行してください');
            $this->fail('Second exclusive acquire must fail with 409');
        } catch (ApiException $e) {
            $this->assertSame(409, $e->getHttpStatus());
        } finally {
            $gate1->release();
            $gate2->release();
            @unlink($lockPath);
        }
    }
}
