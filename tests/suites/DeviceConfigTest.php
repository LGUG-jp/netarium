<?php
declare(strict_types=1);

namespace Netarium\Tests\Suites;

use PDO;
use Netarium\Core\ApiException;
use Netarium\Services\Topology\DeviceConfigService;
use Netarium\Tests\TestCase;
use Netarium\Tests\TestHttpClient;
use Netarium\Tests\TestServer;

class DeviceConfigTest extends TestCase
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

    private function load(TestHttpClient $client, int $id = 1): array
    {
        $result = $client->get('/api.php?action=load_device_configs&device_id=' . $id)->assertOk()->getJson();
        $this->assertSame(true, $result['success']);
        return $result;
    }

    private function input(array $state): array
    {
        return ['device_id' => $state['device_id'], 'expected_revision' => $state['revision'], 'expected_device_revision' => $state['device_revision']];
    }

    private function save(TestHttpClient $client, array $state, string $content, string $memo = ''): array
    {
        return $client->postJson('/api.php?action=save_device_config', $this->input($state) + ['content' => $content, 'memo' => $memo])->assertOk()->getJson();
    }

    public function testNormalizationNoopRetentionAndGenerationHighWater(): void
    {
        $this->isolated(function (TestHttpClient $client, PDO $db): void {
            $public = $client->get('/api.php?action=load')->assertOk()->getJson();
            $state = $this->load($client);
            $this->assertSame(0, $state['revision']);
            $this->assertSame([], $state['items']);
            $first = $this->save($client, $state, "\xEF\xBB\xBFhostname test\r\ninterface eth0\r", '初回');
            $this->assertSame($public['revision'] + 1, $client->get('/api.php?action=load')->assertOk()->getJson()['revision']);
            $this->assertSame("hostname test\ninterface eth0\n", $first['items'][0]['content']);
            $this->assertSame('admin', $first['items'][0]['actor_name']);
            $this->assertTrue($first['items'][0]['actor_user_id'] > 0);
            $this->assertMatchesRegex('/\A\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\z/', $first['items'][0]['created_at']);
            $noop = $this->save($client, $first, "hostname test\r\ninterface eth0\r\n", 'メモだけ変更');
            $this->assertSame(true, $noop['unchanged']);
            unset($noop['unchanged']);
            // Request IDs are intentionally distinct, history and revision are not.
            $this->assertSame($first['items'], $noop['items']);
            $this->assertSame($first['revision'], $noop['revision']);
            $this->assertSame($public['revision'] + 1, $client->get('/api.php?action=load')->assertOk()->getJson()['revision']);
            $state = $first;
            for ($i = 2; $i <= 7; $i++) { $state = $this->save($client, $state, 'hostname version-' . $i); }
            $this->assertSame([7, 6, 5, 4, 3], array_column($state['items'], 'generation'));
            $after = $client->get('/api.php?action=load')->assertOk()->getJson();
            $this->assertSame($public['revision'] + 7, $after['revision']);
            $expectedAfterDelete = $after['revision'] + 1;
            unset($public['revision'], $after['revision']);
            $this->assertSame($public, $after);
            $state = $client->postJson('/api.php?action=delete_device_configs', $this->input($state) + ['ids' => array_column($state['items'], 'id')])->assertOk()->getJson();
            $this->assertSame([], $state['items']);
            $this->assertSame(8, (int)$db->query('SELECT next_generation FROM device_config_states WHERE device_id = 1')->fetchColumn());
            $this->assertSame($expectedAfterDelete, $client->get('/api.php?action=load')->assertOk()->getJson()['revision']);
            $state = $this->save($client, $state, 'hostname after-delete');
            $this->assertSame(8, $state['items'][0]['generation']);
            $this->assertSame($first['device_revision'], $state['device_revision']);
            $max = str_repeat('a', DeviceConfigService::MAX_BYTES);
            $state = $this->save($client, $state, $max, str_repeat('字', 200));
            $this->assertSame(DeviceConfigService::MAX_BYTES, strlen($state['items'][0]['content']));
        });
    }
    public function testConfigRevisionAllowsSubsequentDeviceImageUpload(): void
    {
        $this->isolated(function (TestHttpClient $client, PDO $db, TestServer $server): void {
            $state = $this->save($client, $this->load($client), "hostname with-image\n");
            $png = $server->getTempDir() . '/config-device-image.png';
            file_put_contents($png, base64_decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', true));
            $uploaded = $client->postMultipart('/image_upload.php?action=upload_device_image', [
                'device_id' => 1, 'revision' => $state['data_revision'], 'caption' => '',
            ], ['image' => ['path' => $png, 'mime' => 'image/png', 'filename' => 'config-device-image.png']])->assertOk()->getJson();
            $this->assertSame($state['data_revision'] + 1, $uploaded['revision']);
            $this->assertSame(1, count($uploaded['images']));
            $this->assertSame(1, (int)$uploaded['images'][0]['device_id']);
            $this->assertSame($state['items'], $this->load($client)['items']);
        });
    }


    public function testInvalidInputAuthorizationAndSecretIsolation(): void
    {
        $this->isolated(function (TestHttpClient $client, PDO $db, TestServer $server): void {
            $state = $this->load($client);
            $secret = 'CONFIG_SECRET_DO_NOT_LOG_333';
            foreach (['', " \t\r\n", "\xEF\xBB\xBF", $secret . "\0", $secret . "\x01", $secret . "\x7F", $secret . "\u{0085}", str_repeat('a', 262145)] as $content) {
                $response = $client->postJson('/api.php?action=save_device_config', $this->input($state) + ['content' => $content])->assertError(400);
                $this->assertFalse(str_contains($response->getBody(), $secret));
                $this->assertSame($state, $this->load($client));
            }
            $client->postJson('/api.php?action=save_device_config', $this->input($state) + ['content' => 'text', 'memo' => str_repeat('字', 201)])->assertError(400);
            $client->request('POST', '/api.php?action=save_device_config', '{"content":"' . $secret . "\xFF" . '"}', ['Content-Type' => 'application/json', 'X-CSRF-Token' => $client->getCsrfToken()])->assertError(400);
            $client->postJson('/api.php?action=save_device_config', $this->input($state) + ['content' => $secret], ['X-CSRF-Token' => 'incorrect'])->assertError(403);
            $client->get('/api.php?action=save_device_config')->assertError(405);
            $client->postJson('/api.php?action=load_device_configs', ['device_id' => 1])->assertError(405);
            $viewer = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($viewer->login('viewer', 'viewer123'));
            $anonymous = new TestHttpClient($server->getBaseUrl());
            $anonymous->get('/api.php?action=load_device_configs&device_id=1')->assertError(401);
            $viewer->get('/api.php?action=load_device_configs&device_id=1')->assertError(403);
            foreach (['save_device_config', 'delete_device_configs'] as $action) {
                $viewer->postJson('/api.php?action=' . $action, $this->input($state) + ['content' => $secret, 'ids' => [1]])->assertError(403);
            }
            $state = $this->save($client, $state, $secret . "\n<script>alert(1)</script>");
            $this->assertStringContains('<script>', $state['items'][0]['content']);
            foreach ([$client, $viewer] as $reader) {
                $this->assertFalse(str_contains($reader->get('/api.php?action=load')->assertOk()->getBody(), $secret));
            }
            $this->assertFalse(str_contains($client->get('/api.php?action=export_devices_csv')->getBody(), $secret));
            $this->assertFalse(str_contains((string)$db->query('SELECT group_concat(changes_json) FROM change_history')->fetchColumn(), $secret));
            $logs = (string)file_get_contents($server->getTempDir() . '/server.log');
            $logDirectory = $server->getTempDir() . '/logs';
            if (is_dir($logDirectory)) {
                foreach (new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($logDirectory, \FilesystemIterator::SKIP_DOTS)) as $file) {
                    if ($file->isFile()) { $logs .= file_get_contents($file->getPathname()); }
                }
            }
            $this->assertFalse(str_contains($logs, $secret));
            $this->assertSame(1, (int)$db->query('SELECT COUNT(*) FROM device_configs')->fetchColumn());
        });
    }

    public function testRestoreOperationGateRejectsConfigReadsAndWrites(): void
    {
        $this->isolated(function (TestHttpClient $client, PDO $db, TestServer $server): void {
            $state = $this->load($client);
            $gate = new \Netarium\Core\OperationGate($server->getTempDir() . '/temp/operation.lock');
            try {
                $gate->acquireExclusive();
                $client->get('/api.php?action=load_device_configs&device_id=1')->assertError(409);
                $client->postJson('/api.php?action=save_device_config', $this->input($state) + ['content' => 'blocked'])->assertError(409);
                $client->postJson('/api.php?action=delete_device_configs', $this->input($state) + ['ids' => [1]])->assertError(409);
            } finally {
                $gate->release();
            }
            $this->assertSame($state, $this->load($client));
        });
    }

    public function testConflictsSelectedDeletionAndDeviceCascadeAreAtomic(): void
    {
        $this->isolated(function (TestHttpClient $client, PDO $db): void {
            $empty = $this->load($client);
            $one = $this->save($client, $empty, 'one');
            $two = $this->save($client, $one, 'two');
            $three = $this->save($client, $two, 'three');
            $client->postJson('/api.php?action=save_device_config', $this->input($one) + ['content' => 'stale'])->assertError(409);
            $client->postJson('/api.php?action=delete_device_configs', $this->input($two) + ['ids' => [$two['items'][0]['id']]])->assertError(409);
            foreach ([[], [$three['items'][0]['id'], $three['items'][0]['id']]] as $ids) {
                $client->postJson('/api.php?action=delete_device_configs', $this->input($three) + ['ids' => $ids])->assertError(400);
            }
            $client->postJson('/api.php?action=delete_device_configs', $this->input($three) + ['ids' => [$three['items'][0]['id'], 999999]])->assertError(409);
            $this->assertSame($three['items'], $this->load($client)['items']);
            $remaining = $client->postJson('/api.php?action=delete_device_configs', $this->input($three) + ['ids' => [$three['items'][0]['id'], $three['items'][2]['id']]])->assertOk()->getJson();
            $this->assertSame([2], array_column($remaining['items'], 'generation'));
            $client->postJson('/api.php?action=delete_device_configs', $this->input($three) + ['ids' => [$three['items'][0]['id']]])->assertError(409);
            // A parallel device edit must invalidate both save and delete without touching history.
            $db->exec("UPDATE devices SET memo = 'parallel config test' WHERE id = 1");
            $client->postJson('/api.php?action=save_device_config', $this->input($remaining) + ['content' => 'stale device'])->assertError(409);
            $client->postJson('/api.php?action=delete_device_configs', $this->input($remaining) + ['ids' => [$remaining['items'][0]['id']]])->assertError(409);
            $fresh = $this->load($client);
            $this->assertSame($remaining['items'], $fresh['items']);
            // Trigger failure after deletion must roll the deletion and its revision back.
            $db->exec("CREATE TRIGGER config_delete_failure BEFORE UPDATE ON device_config_states BEGIN SELECT RAISE(ABORT, 'CONFIG_TRIGGER_SECRET'); END");
            $failure = $client->postJson('/api.php?action=delete_device_configs', $this->input($fresh) + ['ids' => [$fresh['items'][0]['id']]])->assertError(500);
            $this->assertFalse(str_contains($failure->getBody(), 'CONFIG_TRIGGER_SECRET'));
            $this->assertSame($fresh, $this->load($client));
            $db->exec('DROP TRIGGER config_delete_failure');
            $db->exec("CREATE TRIGGER config_save_failure BEFORE UPDATE ON device_config_states BEGIN SELECT RAISE(ABORT, 'CONFIG_TRIGGER_SECRET'); END");
            $client->postJson('/api.php?action=save_device_config', $this->input($fresh) + ['content' => 'failed save'])->assertError(500);
            $this->assertSame($fresh, $this->load($client));
            $db->exec('DROP TRIGGER config_save_failure');
            $client->postJson('/api.php?action=save_resources', ['devices' => [['id' => 1, 'operation' => 'delete', 'expected_revision' => $fresh['device_revision']]], 'views' => []])->assertOk();
            $this->assertSame(0, (int)$db->query('SELECT COUNT(*) FROM device_configs WHERE device_id = 1')->fetchColumn());
            $this->assertSame(0, (int)$db->query('SELECT COUNT(*) FROM device_config_states WHERE device_id = 1')->fetchColumn());
            $client->get('/api.php?action=load_device_configs&device_id=1')->assertError(404);
            $client->postJson('/api.php?action=save_device_config', $this->input($fresh) + ['content' => 'deleted device'])->assertError(409);
        });
    }

    public function testSingleNewestDeletionPreservesDeviceAndRejectsForeignIds(): void
    {
        $this->isolated(function (TestHttpClient $client, PDO $db): void {
            $one = $this->save($client, $this->load($client), 'first device');
            $two = $this->save($client, $one, 'newest first device');
            $otherId = (int)$db->query('SELECT id FROM devices WHERE id <> 1 ORDER BY id LIMIT 1')->fetchColumn();
            $this->assertTrue($otherId > 0);
            $other = $this->save($client, $this->load($client, $otherId), 'other device');
            $client->postJson('/api.php?action=delete_device_configs', $this->input($two) + ['ids' => [$two['items'][0]['id'], $other['items'][0]['id']]])->assertError(409);
            $this->assertSame($two['items'], $this->load($client)['items']);
            $remaining = $client->postJson('/api.php?action=delete_device_configs', $this->input($two) + ['ids' => [$two['items'][0]['id']]])->assertOk()->getJson();
            $this->assertSame($one['items'], $remaining['items']);
            $this->assertSame($two['device_revision'], $remaining['device_revision']);
            $this->assertSame($other['items'], $this->load($client, $otherId)['items']);
        });
    }

    public function testSharedBackupValidatorRejectsInvalidRowsWithoutLeakingContent(): void
    {
        $valid = ['id' => 1, 'device_id' => 1, 'generation' => 3, 'content' => 'BACKUP_CONFIG_SECRET', 'created_at' => '2026-10-31T12:00:00Z', 'actor_user_id' => null, 'actor_name' => 'retired admin', 'memo' => ''];
        $states = [['device_id' => 1, 'revision' => 5, 'next_generation' => 4]];
        $this->assertSame(['device_configs' => [$valid], 'device_config_states' => $states], DeviceConfigService::validateBackupRows([$valid], $states, [1]));
        $this->assertSame([], DeviceConfigService::validateBackupRows([], $states, [1])['device_configs']);
        $boundary = array_replace($valid, ['id' => \Netarium\Core\ResourceId::MAX_RESTORE]);
        $this->assertSame([$boundary], DeviceConfigService::validateBackupRows([$boundary], $states, [1])['device_configs']);
        $invalid = [
            [[$valid], [], [1]], [[$valid], $states, [2]],
            [[array_replace($valid, ['content' => "bad\0"])], $states, [1]],
            [[array_replace($valid, ['content' => "bad\r\n"])], $states, [1]],
            [[array_replace($valid, ['created_at' => '2026-02-30T12:00:00Z'])], $states, [1]],
            [[array_replace($valid, ['memo' => str_repeat('字', 201)])], $states, [1]],
            [[$valid, $valid], $states, [1]],
            [[$valid], [['device_id' => 1, 'revision' => 1, 'next_generation' => 3]], [1]],
            [[$valid, array_replace($valid, ['id' => 2, 'generation' => 2])], $states, [1]],
            [[$valid, array_replace($valid, ['id' => 2, 'generation' => 2, 'created_at' => '2026-11-01T12:00:00Z'])], $states, [1]],
            [[array_replace($valid, ['id' => \Netarium\Core\ResourceId::MAX])], $states, [1]],
            [[$valid], [['device_id' => 1, 'revision' => \Netarium\Core\ResourceId::MAX, 'next_generation' => 4]], [1]],
            [[$valid], [['device_id' => 1, 'revision' => 5, 'next_generation' => PHP_INT_MAX]], [1]],
            [[], [['device_id' => 1, 'revision' => 5, 'next_generation' => PHP_INT_MAX]], [1]],
        ];
        $six = [];
        for ($generation = 1; $generation <= 6; $generation++) {
            $six[] = array_replace($valid, ['id' => $generation, 'generation' => $generation]);
        }
        $invalid[] = [$six, [['device_id' => 1, 'revision' => 6, 'next_generation' => 7]], [1]];
        foreach ($invalid as [$configs, $stateRows, $devices]) {
            try {
                DeviceConfigService::validateBackupRows($configs, $stateRows, $devices);
                $this->fail('Invalid backup accepted');
            } catch (ApiException $e) {
                $this->assertSame(400, $e->getHttpStatus());
                $this->assertFalse(str_contains($e->getMessage(), 'BACKUP_CONFIG_SECRET'));
            }
        }
        // Total bytes limit in backup validation
        $shortLimitRows = [
            array_replace($valid, ['id' => 1, 'generation' => 1, 'content' => str_repeat('a', 500)]),
            array_replace($valid, ['id' => 2, 'generation' => 2, 'content' => str_repeat('b', 600)]),
        ];
        try {
            DeviceConfigService::validateBackupRows($shortLimitRows, [['device_id' => 1, 'revision' => 2, 'next_generation' => 3]], [1], 1000);
            $this->fail('Total bytes limit in backup was not enforced');
        } catch (ApiException $e) {
            $this->assertSame(400, $e->getHttpStatus());
        }
        $accepted = DeviceConfigService::validateBackupRows($shortLimitRows, [['device_id' => 1, 'revision' => 2, 'next_generation' => 3]], [1], 1200);
        $this->assertSame(2, count($accepted['device_configs']));
    }

    private function japaneseCapacityFixture(int $totalBytes): array
    {
        $rows = [];
        $states = [];
        $deviceIds = [];
        $id = 1;
        for ($deviceId = 1000; $totalBytes > 0; $deviceId++) {
            $deviceIds[] = $deviceId;
            for ($generation = 1; $generation <= DeviceConfigService::MAX_VERSIONS && $totalBytes > 0; $generation++) {
                $bytes = min($totalBytes, DeviceConfigService::MAX_BYTES - 1);
                $character = ['日', '本', '語', '文', '字'][$generation - 1];
                $content = str_repeat($character, intdiv($bytes, 3)) . str_repeat('a', $bytes % 3);
                $rows[] = ['id' => $id++, 'device_id' => $deviceId, 'generation' => $generation,
                    'content' => $content, 'created_at' => '2026-10-31T12:00:00Z',
                    'actor_user_id' => null, 'actor_name' => 'admin', 'memo' => ''];
                $totalBytes -= $bytes;
            }
            $states[] = ['device_id' => $deviceId, 'revision' => $generation - 1, 'next_generation' => $generation];
        }
        return ['device_configs' => $rows, 'device_config_states' => $states, 'device_ids' => $deviceIds];
    }

    public function testBackupValidatorEnforcesJapaneseTotalByteBoundaryWithValidRows(): void
    {
        $fixture = $this->japaneseCapacityFixture(DeviceConfigService::DEFAULT_MAX_TOTAL_BYTES - 1);
        $rows = $fixture['device_configs'];
        $states = $fixture['device_config_states'];
        $devices = $fixture['device_ids'];
        $last = count($rows) - 1;
        $this->assertSame($rows, DeviceConfigService::validateBackupRows($rows, $states, $devices)['device_configs']);
        $rows[$last]['content'] .= 'a';
        $this->assertSame($rows, DeviceConfigService::validateBackupRows($rows, $states, $devices)['device_configs']);
        $rows[$last]['content'] .= 'a';
        try {
            DeviceConfigService::validateBackupRows($rows, $states, $devices);
            $this->fail('Japanese backup content exceeded the total byte limit');
        } catch (ApiException $e) {
            $this->assertSame(400, $e->getHttpStatus());
        }
    }

    public function testSystemTotalCapacityQuotaRejectsRegistrationAndPreservesState(): void
    {
        $this->isolated(function (TestHttpClient $client, PDO $db): void {
            $state = $this->load($client);
            foreach (['一', '二', '三', '四', '五'] as $content) {
                $state = $this->save($client, $state, $content);
            }
            $maxBytes = DeviceConfigService::DEFAULT_MAX_TOTAL_BYTES;
            // This is an uncompressed UTF-8 content quota, not a ZIP size guarantee.
            // Leave 100 bytes free, including the five existing 3-byte generations.
            $fixture = $this->japaneseCapacityFixture($maxBytes - 100 - 15);
            $insertDevice = $db->prepare("INSERT INTO devices (id, name, ip, type, location) VALUES (?, ?, '', 'server', '')");
            $insertConfig = $db->prepare('INSERT INTO device_configs (device_id, generation, content, created_at, actor_user_id, actor_name, memo) VALUES (?, ?, ?, ?, ?, ?, ?)');
            $insertState = $db->prepare('INSERT INTO device_config_states (device_id, revision, next_generation) VALUES (?, ?, ?)');
            $db->beginTransaction();
            foreach ($fixture['device_ids'] as $deviceId) {
                $insertDevice->execute([$deviceId, 'Config capacity device ' . $deviceId]);
            }
            foreach ($fixture['device_configs'] as $row) {
                $insertConfig->execute([$row['device_id'], $row['generation'], $row['content'], $row['created_at'], $row['actor_user_id'], $row['actor_name'], $row['memo']]);
            }
            foreach ($fixture['device_config_states'] as $row) {
                $insertState->execute([$row['device_id'], $row['revision'], $row['next_generation']]);
            }
            $db->commit();
            unset($fixture);
            $otherFingerprint = static function () use ($db): array {
                $stmt = $db->query('SELECT *, LENGTH(CAST(content AS BLOB)) AS content_bytes FROM device_configs WHERE device_id <> 1 ORDER BY id');
                $rows = [];
                while ($row = $stmt->fetch(PDO::FETCH_ASSOC)) {
                    $row['content_sha256'] = hash('sha256', $row['content']);
                    unset($row['content']);
                    $rows[] = $row;
                }
                return $rows;
            };
            $beforeOtherRows = $otherFingerprint();

            // Retention replaces a 3-byte generation: 99 bytes leaves four bytes free.
            $state = $this->save($client, $state, str_repeat('日', 33));
            $this->assertSame($maxBytes - 4, (int)$db->query('SELECT SUM(LENGTH(CAST(content AS BLOB))) FROM device_configs')->fetchColumn());
            // Seven bytes replacing three reaches the exact 40 MiB boundary.
            $state = $this->save($client, $state, '日本a');
            $this->assertSame($maxBytes, (int)$db->query('SELECT SUM(LENGTH(CAST(content AS BLOB))) FROM device_configs')->fetchColumn());
            $this->assertSame([7, 6, 5, 4, 3], array_column($state['items'], 'generation'));
            $state = $this->load($client);
            $beforeRows = $db->query('SELECT * FROM device_configs WHERE device_id = 1 ORDER BY id')->fetchAll(PDO::FETCH_ASSOC);
            $beforeStates = $db->query('SELECT * FROM device_config_states ORDER BY device_id')->fetchAll(PDO::FETCH_ASSOC);
            $beforeHistory = $db->query('SELECT * FROM change_history ORDER BY id')->fetchAll(PDO::FETCH_ASSOC);
            $beforeSequences = $db->query('SELECT * FROM sqlite_sequence ORDER BY name')->fetchAll(PDO::FETCH_ASSOC);
            $beforeResourceSequences = $db->query('SELECT * FROM resource_sequences ORDER BY name')->fetchAll(PDO::FETCH_ASSOC);

            // Four bytes replacing three exceeds the limit by one, despite fewer characters.
            $res = $client->postJson('/api.php?action=save_device_config', $this->input($state) + ['content' => '日a', 'memo' => '拒否された変更'])->assertError(400);
            $this->assertStringContains('Configのシステム保存容量', $res->getBody());
            // Roll back insertion, retention eviction, memo, revisions and generation allocation.
            $this->assertSame($state, $this->load($client));
            $this->assertSame($beforeRows, $db->query('SELECT * FROM device_configs WHERE device_id = 1 ORDER BY id')->fetchAll(PDO::FETCH_ASSOC));
            $this->assertSame($beforeStates, $db->query('SELECT * FROM device_config_states ORDER BY device_id')->fetchAll(PDO::FETCH_ASSOC));
            $this->assertSame($beforeHistory, $db->query('SELECT * FROM change_history ORDER BY id')->fetchAll(PDO::FETCH_ASSOC));
            $this->assertSame($beforeSequences, $db->query('SELECT * FROM sqlite_sequence ORDER BY name')->fetchAll(PDO::FETCH_ASSOC));
            $this->assertSame($beforeResourceSequences, $db->query('SELECT * FROM resource_sequences ORDER BY name')->fetchAll(PDO::FETCH_ASSOC));
            $this->assertSame($beforeOtherRows, $otherFingerprint());
            $this->assertSame($maxBytes, (int)$db->query('SELECT SUM(LENGTH(CAST(content AS BLOB))) FROM device_configs')->fetchColumn());
        });
    }
    public function testConfigMutationRecordsChangeHistoryWithMetadataOnly(): void
    {
        $this->isolated(function (TestHttpClient $client, PDO $db, TestServer $server): void {
            $state = $this->load($client);
            $secretBody = "SECRET_CONFIG_BODY password 12345\nhostname recorded-sw\n";
            $secretMemo = 'SECRET_CONFIG_MEMO 初回登録メモ';
            $updatedMemo = 'SECRET_UPDATED_MEMO 更新メモ';
            $noopMemo = 'SECRET_NOOP_MEMO メモだけ変更';
            $staleMemo = 'SECRET_STALE_MEMO 競合した変更';
            $saved = $this->save($client, $state, $secretBody, $secretMemo);
            $this->assertSame($secretMemo, $saved['items'][0]['memo']);
            $this->assertSame($secretMemo, $db->query('SELECT memo FROM device_configs WHERE device_id = 1')->fetchColumn());

            $historyRes = $client->get('/api.php?action=load_change_history&target_type=device&target_id=1')->assertOk()->getJson();
            $latestHistory = $historyRes['items'][0];
            $this->assertSame('device', $latestHistory['target_type']);
            $this->assertSame(1, $latestHistory['target_id']);
            $this->assertSame('update', $latestHistory['operation']);
            $rawHistory = $db->query('SELECT * FROM change_history ORDER BY id')->fetchAll(PDO::FETCH_ASSOC);
            $payload = json_decode($rawHistory[count($rawHistory) - 1]['changes_json'], true, 512, JSON_THROW_ON_ERROR);
            $this->assertSame(['source' => 'device_config', 'items' => [
                ['label' => 'Config世代', 'before' => '—', 'after' => '第1世代'],
            ]], $payload);

            // Neither a memo-only no-op nor a stale write changes stored memo or history.
            $beforeRejected = $this->load($client);
            $noop = $this->save($client, $saved, $secretBody, $noopMemo);
            $this->assertSame(true, $noop['unchanged']);
            $this->assertSame($saved['items'], $noop['items']);
            $this->assertSame($saved['revision'], $noop['revision']);
            $this->assertSame($saved['data_revision'], $noop['data_revision']);
            $client->postJson('/api.php?action=save_device_config', $this->input($state) + ['content' => 'stale', 'memo' => $staleMemo])->assertError(409);
            $this->assertSame($beforeRejected, $this->load($client));
            $this->assertSame($rawHistory, $db->query('SELECT * FROM change_history ORDER BY id')->fetchAll(PDO::FETCH_ASSOC));

            $updated = $this->save($client, $saved, $secretBody . "interface eth0\n", $updatedMemo);
            $this->assertSame([$updatedMemo, $secretMemo], array_column($updated['items'], 'memo'));
            $updateHistory = $db->query('SELECT summary, changes_json FROM change_history ORDER BY id DESC LIMIT 1')->fetch(PDO::FETCH_ASSOC);
            $this->assertSame(['source' => 'device_config', 'items' => [
                ['label' => 'Config世代', 'before' => '第1世代', 'after' => '第2世代'],
            ]], json_decode($updateHistory['changes_json'], true, 512, JSON_THROW_ON_ERROR));

            $selected = $client->postJson('/api.php?action=delete_device_configs', $this->input($updated) + ['ids' => [$saved['items'][0]['id']]])->assertOk()->getJson();
            $this->assertSame([$updated['items'][0]], $selected['items']);
            $selectedHistory = $db->query('SELECT summary, changes_json FROM change_history ORDER BY id DESC LIMIT 1')->fetch(PDO::FETCH_ASSOC);
            $deletionPayload = ['source' => 'device_config', 'items' => [
                ['label' => 'Config履歴削除', 'before' => '1件', 'after' => '—（削除）'],
            ]];
            $this->assertSame($deletionPayload, json_decode($selectedHistory['changes_json'], true, 512, JSON_THROW_ON_ERROR));
            $beforeRejected = $this->load($client);
            $client->postJson('/api.php?action=delete_device_configs', $this->input($updated) + ['ids' => [$updated['items'][0]['id']]])->assertError(409);
            $this->assertSame($beforeRejected, $this->load($client));
            $deleted = $client->postJson('/api.php?action=delete_device_configs', $this->input($selected) + ['ids' => [$selected['items'][0]['id']]])->assertOk()->getJson();
            $this->assertSame([], $deleted['items']);
            $deleteHistory = $db->query('SELECT summary, changes_json FROM change_history ORDER BY id DESC LIMIT 1')->fetch(PDO::FETCH_ASSOC);
            $this->assertSame($deletionPayload, json_decode($deleteHistory['changes_json'], true, 512, JSON_THROW_ON_ERROR));
            $this->assertSame(count($rawHistory) + 3, (int)$db->query('SELECT COUNT(*) FROM change_history')->fetchColumn());

            // All successful, unchanged and rejected operations must keep secrets out of
            // general history (including summaries), API history and audit/server logs.
            $history = json_encode($db->query('SELECT * FROM change_history ORDER BY id')->fetchAll(PDO::FETCH_ASSOC), JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
            $historyResponse = $client->get('/api.php?action=load_change_history&target_type=device&target_id=1')->assertOk()->getBody();
            $logs = (string)file_get_contents($server->getTempDir() . '/server.log');
            $logDirectory = $server->getTempDir() . '/logs';
            if (is_dir($logDirectory)) {
                foreach (new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($logDirectory, \FilesystemIterator::SKIP_DOTS)) as $file) {
                    if ($file->isFile()) { $logs .= file_get_contents($file->getPathname()); }
                }
            }
            $this->assertStringContains('device_config.save', $logs);
            $this->assertStringContains('device_config.delete', $logs);
            foreach (['SECRET_CONFIG_BODY', 'SECRET_CONFIG_MEMO', 'SECRET_UPDATED_MEMO', 'SECRET_NOOP_MEMO', 'SECRET_STALE_MEMO'] as $secret) {
                $this->assertFalse(str_contains($history, $secret));
                $this->assertFalse(str_contains($historyResponse, $secret));
                $this->assertFalse(str_contains($logs, $secret));
            }
        });
    }
}
