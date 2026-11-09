<?php
declare(strict_types=1);

namespace Netarium\Tests\Suites;

use Netarium\Tests\TestCase;
use Netarium\Tests\TestHttpClient;
use ZipArchive;

class BackupTest extends TestCase
{
    private TestHttpClient $client;

    public function __construct(TestHttpClient $client)
    {
        $this->client = $client;
    }


    private function expireRestorePreview(\Netarium\Tests\TestServer $server, array $preview): void
    {
        $directory = $server->getTempDir() . '/temp/backup-restore/' . $preview['restore_token'];
        foreach (['workspace.json', 'preview.json'] as $name) {
            $path = $directory . '/' . $name;
            if (!is_file($path)) {
                continue;
            }
            $metadata = json_decode((string)file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);
            $metadata['expires_at'] = time() - 1;
            file_put_contents($path, json_encode($metadata, JSON_THROW_ON_ERROR));
        }
    }

    public function testRestorePreviewRequestReclaimsExpiredAbandonedPreviewAndKeepsValidPreview(): void
    {
        $this->withIdBoundaryFixture(function (string $path, \PDO $db, \Netarium\Tests\TestServer $server): void {
            $expired = $this->previewIdBackup($path);
            $valid = $this->previewIdBackup($path);
            $root = $server->getTempDir() . '/temp/backup-restore/';
            $validBytes = (string)file_get_contents($root . $valid['restore_token'] . '/preview.json');
            $before = $this->idBoundaryState($db);
            $this->expireRestorePreview($server, $expired);
            $replacement = $this->previewIdBackup($path);
            $this->assertFalse(is_dir($root . $expired['restore_token']));
            $this->assertTrue(is_dir($root . $replacement['restore_token']));
            $this->assertSame($validBytes, (string)file_get_contents($root . $valid['restore_token'] . '/preview.json'));
            $this->assertSame($before, $this->idBoundaryState($db));
            $this->commitIdBackup($valid);
        });
    }

    private function restoreWorkspaceConfig(string $root, array $limits = []): array
    {
        return [
            'backup_restore_directory' => $root,
            'backup_restore_ttl_seconds' => 60,
            'backup_restore_workspace' => array_replace([
                'max_count' => 8, 'max_bytes' => 4096,
                'max_user_count' => 2, 'max_user_bytes' => 2048,
            ], $limits),
        ];
    }

    private function assertRestoreStatus(int $status, callable $operation): void
    {
        try {
            $operation();
            $this->fail('復元作業領域の操作が拒否されませんでした');
        } catch (\Netarium\Core\ApiException $error) {
            $this->assertSame($status, $error->getHttpStatus());
        }
    }

    private function restoreFiles(string $directory): array
    {
        $files = [];
        $iterator = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator(
            $directory, \FilesystemIterator::SKIP_DOTS
        ));
        foreach ($iterator as $file) {
            // Windowsの排他中ロックファイルは読取り不能。保全対象は復元データ。
            if ($file->isFile() && !$file->isLink() && $file->getFilename() !== '.workspace.lock') {
                $files[substr($file->getPathname(), strlen($directory))] = hash_file('sha256', $file->getPathname());
            }
        }
        ksort($files);
        return $files;
    }

    public function testRestorePreviewUserCountBoundaryPreservesDatabaseAndOtherUserToken(): void
    {
        $this->withIdBoundaryFixture(function (string $path, \PDO $db, \Netarium\Tests\TestServer $server): void {
            $db->exec("UPDATE users SET role = 'admin' WHERE username = 'viewer'");
            $other = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($other->login('viewer', 'viewer123'));
            $otherPreview = $other->postMultipart('/api.php?action=preview_backup_restore', [],
                ['backup_zip' => ['path' => $path, 'filename' => 'other.zip', 'type' => 'application/zip']])->assertOk()->getJson();
            $first = $this->previewIdBackup($path);
            $second = $this->previewIdBackup($path);
            $root = $server->getTempDir() . '/temp/backup-restore';
            $files = $this->restoreFiles($root);
            $before = $this->idBoundaryState($db);
            $rejected = $this->previewIdBackup($path, 413);
            $this->assertFalse(isset($rejected['restore_token']));
            $this->assertSame($files, $this->restoreFiles($root));
            $this->assertSame($before, $this->idBoundaryState($db));
            $this->expireRestorePreview($server, $first);
            $this->previewIdBackup($path);
            $this->assertTrue(is_dir($root . '/' . $second['restore_token']));
            $this->assertTrue(is_dir($root . '/' . $otherPreview['restore_token']));
            $other->postJson('/api.php?action=commit_backup_restore', [
                'restore_token' => $otherPreview['restore_token'], 'confirmation' => 'バックアップから復元',
            ])->assertOk();
        });
    }

    public function testRestoreWorkspaceByteAndCountLimitsAllowExactAndRejectOneMore(): void
    {
        $this->withIdBoundaryFixture(function (string $path, \PDO $db, \Netarium\Tests\TestServer $server): void {
            $root = $server->getTempDir() . '/workspace-boundaries';
            mkdir($root . '/one', 0700, true);
            $metadata = json_encode(['user_id' => '1', 'expires_at' => time() + 600], JSON_THROW_ON_ERROR);
            file_put_contents($root . '/one/workspace.json', $metadata);
            file_put_contents($root . '/one/data', 'small payload');
            $bytes = strlen($metadata) + strlen('small payload');
            foreach (['max_bytes', 'max_user_bytes'] as $limit) {
                $workspace = new \Netarium\Services\Backup\RestoreWorkspace($this->restoreWorkspaceConfig($root, [$limit => $bytes + 10]));
                try {
                    $workspace->assertCanAdd('1', 10, 0);
                    $this->assertRestoreStatus(413, static fn() => $workspace->assertCanAdd('1', 11, 0));
                    $result = $workspace->cleanupExpired();
                    $this->assertSame(0, $result['removed']);
                    $this->assertSame(1, $result['remaining']);
                    $this->assertSame($bytes, $result['bytes']);
                } finally {
                    $workspace->release();
                }
            }
            foreach (['max_count', 'max_user_count'] as $limit) {
                $limits = [$limit => 2];
                if ($limit === 'max_count') {
                    $limits['max_user_count'] = 20;
                }
                $workspace = new \Netarium\Services\Backup\RestoreWorkspace($this->restoreWorkspaceConfig($root, $limits));
                try {
                    $workspace->assertCanAdd('1', 0);
                    $this->assertRestoreStatus(413, static fn() => $workspace->assertCanAdd('1', 0, 2));
                } finally {
                    $workspace->release();
                }
            }
            $workspace = new \Netarium\Services\Backup\RestoreWorkspace($this->restoreWorkspaceConfig($root, ['max_user_bytes' => 10]));
            try {
                $workspace->assertCanAdd('2', 10, 0);
                $this->assertRestoreStatus(413, static fn() => $workspace->assertCanAdd('2', 11, 0));
            } finally {
                $workspace->release();
            }
        });
    }

    public function testRestoreWorkspaceCleanupPreservesTimeBoundaryAndReclaimsLegacyAndOrphans(): void
    {
        $this->withIdBoundaryFixture(function (string $path, \PDO $db, \Netarium\Tests\TestServer $server): void {
            $root = $server->getTempDir() . '/workspace-expiry';
            $now = 1700000000;
            $directory = static fn(string $name): string => $root . '/' . hash('sha256', $name);
            foreach (['expired', 'boundary', 'legacy', 'orphan', 'broken', 'fresh'] as $name) {
                mkdir($directory($name), 0700, true);
                file_put_contents($directory($name) . '/data', 'payload');
            }
            file_put_contents($directory('expired') . '/workspace.json', json_encode(['user_id' => '1', 'expires_at' => $now - 1]));
            file_put_contents($directory('legacy') . '/preview.json', json_encode(['user_id' => '2', 'expires_at' => $now - 1]));
            file_put_contents($directory('broken') . '/workspace.json', '{broken');
            touch($directory('orphan'), $now - 61);
            touch($directory('broken'), $now - 61);
            touch($directory('fresh'), $now - 2);
            file_put_contents($directory('boundary') . '/workspace.json', json_encode(['user_id' => '1', 'expires_at' => $now]));
            $config = $this->restoreWorkspaceConfig($root);
            $config['backup_restore_ttl_seconds'] = 1;
            // 時計の差替えは子プロセスだけに閉じ、suite全体の時刻関数を変更しない。
            $script = $server->getTempDir() . '/workspace-clock.php';
            file_put_contents($script, '<?php namespace Netarium\Services\Backup { function time(): int { return 1700000000; } }'
                . 'namespace { require $argv[1]; $workspace = new \Netarium\Services\Backup\RestoreWorkspace(json_decode($argv[2], true));'
                . 'try { echo json_encode($workspace->cleanupExpired(), JSON_THROW_ON_ERROR); } finally { $workspace->release(); } }');
            $process = proc_open([PHP_BINARY, $script, dirname(__DIR__, 2) . '/bootstrap.php', json_encode($config, JSON_THROW_ON_ERROR)],
                [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
            $this->assertTrue(is_resource($process));
            fclose($pipes[0]);
            $output = stream_get_contents($pipes[1]);
            $error = stream_get_contents($pipes[2]);
            fclose($pipes[1]);
            fclose($pipes[2]);
            $this->assertSame(0, proc_close($process), $error);
            $result = json_decode($output, true, 512, JSON_THROW_ON_ERROR);
            $workspace = new \Netarium\Services\Backup\RestoreWorkspace($config);
            try {
                $this->assertSame(4, $result['removed']);
                $this->assertSame(2, $result['remaining']);
                $this->assertTrue(is_dir($directory('boundary')));
                $this->assertTrue(is_dir($directory('fresh')));
                foreach (['expired', 'legacy', 'orphan', 'broken'] as $name) {
                    $this->assertFalse(is_dir($directory($name)));
                }
                $expectedBytes = strlen('payload') * 2 + filesize($directory('boundary') . '/workspace.json');
                $this->assertSame($expectedBytes, $result['bytes']);
                $workspace->release();
                $workspace = new \Netarium\Services\Backup\RestoreWorkspace($this->restoreWorkspaceConfig($root, ['max_user_bytes' => $expectedBytes]));
                $workspace->assertCanAdd('1', 0, 0);
                $this->assertRestoreStatus(413, static fn() => $workspace->assertCanAdd('1', 1, 0));
                $workspace->release();
                $workspace = new \Netarium\Services\Backup\RestoreWorkspace($this->restoreWorkspaceConfig($root, ['max_user_count' => 1]));
                $workspace->assertCanAdd('2', 0, 0);
                $this->assertRestoreStatus(413, static fn() => $workspace->assertCanAdd('2', 0));
                $this->assertSame(strlen('payload'), filesize($directory('fresh') . '/data'));
            } finally {
                $workspace->release();
            }
        });
    }

    public function testRestoreWorkspaceExternalLockRejectsPreviewCommitAndCleanupUntilReleased(): void
    {
        $this->withIdBoundaryFixture(function (string $path, \PDO $db, \Netarium\Tests\TestServer $server): void {
            $preview = $this->previewIdBackup($path);
            $expired = $this->previewIdBackup($path);
            $this->expireRestorePreview($server, $expired);
            $root = $server->getTempDir() . '/temp/backup-restore';
            $files = $this->restoreFiles($root);
            $before = $this->idBoundaryState($db);
            $script = $server->getTempDir() . '/hold-workspace.php';
            file_put_contents($script, '<?php require $argv[1]; $gate = new \Netarium\Core\OperationGate($argv[2]);'
                . '$gate->acquireExclusive(); echo "ready\n"; fflush(STDOUT); fgets(STDIN); $gate->release();');
            $process = proc_open([PHP_BINARY, $script, dirname(__DIR__, 2) . '/bootstrap.php', $root . '/.workspace.lock'],
                [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
            $this->assertTrue(is_resource($process));
            try {
                stream_set_timeout($pipes[1], 10);
                $this->assertSame("ready\n", fgets($pipes[1]));
                $this->previewIdBackup($path, 409);
                $this->commitIdBackup($preview, 409);
                $this->assertRestoreStatus(409, function () use ($root): void {
                    $workspace = new \Netarium\Services\Backup\RestoreWorkspace($this->restoreWorkspaceConfig($root));
                    try {
                        $workspace->cleanupExpired();
                    } finally {
                        $workspace->release();
                    }
                });
                $this->assertSame($before, $this->idBoundaryState($db));
                $this->assertTrue($this->runRestorePrune($server->getTempDir()) !== 0);
                $this->assertSame($files, $this->restoreFiles($root));
            } finally {
                fwrite($pipes[0], "\n");
                foreach ($pipes as $pipe) {
                    fclose($pipe);
                }
                proc_close($process);
            }
            $this->commitIdBackup($preview);
            $this->assertFalse(is_dir($root . '/' . $expired['restore_token']));
        });
    }

    private function runRestorePrune(string $storageDirectory): int
    {
        $process = proc_open([
            PHP_BINARY, dirname(__DIR__, 2) . '/scripts/prune-restore-previews.php',
            '--storage-dir', $storageDirectory,
        ], [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
        $this->assertTrue(is_resource($process));
        fclose($pipes[0]);
        stream_get_contents($pipes[1]);
        stream_get_contents($pipes[2]);
        fclose($pipes[1]);
        fclose($pipes[2]);
        return proc_close($process);
    }

    public function testRestorePreviewCliPrunesWithoutDatabaseAndPreservesValidWorkspace(): void
    {
        $this->withIdBoundaryFixture(function (string $path, \PDO $db, \Netarium\Tests\TestServer $server): void {
            $storage = $server->getTempDir() . '/cli-storage';
            $root = $storage . '/temp/backup-restore';
            $expired = $root . '/' . hash('sha256', 'expired');
            $valid = $root . '/' . hash('sha256', 'valid');
            foreach ([$expired, $valid] as $directory) {
                mkdir($directory, 0700, true);
                file_put_contents($directory . '/data', 'small fixture');
            }
            file_put_contents($expired . '/workspace.json', json_encode(['user_id' => '1', 'expires_at' => time() - 1]));
            // Legacy previews have no lease file; their existing metadata still protects them.
            file_put_contents($valid . '/preview.json', json_encode(['user_id' => '2', 'expires_at' => time() + 600]));
            $files = $this->restoreFiles($valid);
            $this->assertSame(0, $this->runRestorePrune($storage));
            $this->assertFalse(is_dir($expired));
            $this->assertSame($files, $this->restoreFiles($valid));
            $this->assertFalse(is_dir($storage . '/db'));
            $this->assertSame(0, $this->runRestorePrune($storage));
            $this->assertSame($files, $this->restoreFiles($valid));
        });
    }

    public function testFloorPlanRotationMigrationAndSourceContracts(): void
    {
        foreach (range(11, 22) as $sourceSchema) {
            $db = new \PDO('sqlite::memory:', null, null, [
                \PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION,
                \PDO::ATTR_DEFAULT_FETCH_MODE => \PDO::FETCH_ASSOC,
            ]);
            for ($version = 1; $version <= $sourceSchema; $version++) {
                ('migrateDatabaseToVersion' . $version)($db);
            }
            $db->exec("INSERT INTO views(id,name,view_type) VALUES(1,'Rotation','floor')");
            $db->exec("INSERT INTO view_floor_plans
                (view_id,stored_name,original_name,mime_type,file_size,image_width,image_height,created_at,updated_at)
                VALUES(1,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png','floor.png','image/png',1,1,1,'2026-01-01','2026-01-01')");
            $service = new \Netarium\Services\Backup\BackupService($db);
            $sourceTables = $service->fetchBackupTables($sourceSchema);
            $this->assertFalse(array_key_exists('rotation', $sourceTables['view_floor_plans'][0]));
            $converted = $service->convertBackupRestoreData($sourceTables, $sourceSchema);
            $this->assertSame(0, $converted['view_floor_plans'][0]['rotation']);
            $sourceTables['view_floor_plans'][0]['rotation'] = 45;
            $this->assertRestoreStatus(400, static fn() => $service->convertBackupRestoreData($sourceTables, $sourceSchema));
            migrateDatabase($db);
            $this->assertSame(0.0, $db->query('SELECT rotation FROM view_floor_plans')->fetchColumn());
            $beforeRevision = (int)$db->query('SELECT resource_revision FROM views WHERE id=1')->fetchColumn();
            $db->exec('UPDATE view_floor_plans SET rotation=45 WHERE view_id=1');
            $this->assertTrue((int)$db->query('SELECT resource_revision FROM views WHERE id=1')->fetchColumn() > $beforeRevision);
            foreach (['181', '-180.1', '1e999', '-1e999', "'invalid'", "X'00'", 'NULL'] as $invalidSql) {
                try {
                    $db->exec("UPDATE view_floor_plans SET rotation={$invalidSql} WHERE view_id=1");
                    $this->fail('Invalid SQLite rotation must be rejected: ' . $invalidSql);
                } catch (\PDOException $error) {
                    $this->assertStringContains('constraint', strtolower($error->getMessage()));
                }
                $this->assertSame(45.0, $db->query('SELECT rotation FROM view_floor_plans')->fetchColumn());
            }
        }
    }

    public function testFloorPlanRotationWebZipRoundTripAndInvalidValues(): void
    {
        $this->withIdBoundaryFixture(function (string $path, \PDO $db): void {
            foreach ([-180, -37, 0, 90, 180, 0.1, -0.1, 12.3, 12.3456789] as $rotation) {
                $db->exec("UPDATE view_floor_plans SET rotation={$rotation}");
                file_put_contents($path, $this->client->postJson('/api.php?action=export_backup_zip', [])->assertStatus(200)->getBody());
                $db->exec('UPDATE view_floor_plans SET rotation=1');
                $this->commitIdBackup($this->previewIdBackup($path));
                $this->assertSame((float)$rotation, $db->query('SELECT rotation FROM view_floor_plans')->fetchColumn());
            }
            $before = $this->idBoundaryState($db);
            foreach ([-181, 181, -180.1, 180.1, '90', '1.5', true, false, null, [], ''] as $index => $invalid) {
                $bad = $path . '.rotation-' . $index;
                copy($path, $bad);
                $this->rewriteBackupZip($bad, static function (array &$doc) use ($invalid): void {
                    $doc['tables']['view_floor_plans'][0]['rotation'] = $invalid;
                });
                $this->previewIdBackup($bad, 400);
                $this->assertSame($before, $this->idBoundaryState($db));
            }
            foreach (['1e309', '-1e309'] as $index => $nonfinite) {
                $bad = $path . '.nonfinite-' . $index;
                copy($path, $bad);
                $this->rewriteBackupZip($bad, static function (array &$doc): void {
                    $doc['tables']['view_floor_plans'][0]['rotation'] = '__NONFINITE__';
                }, static fn(string $json): string => str_replace('"__NONFINITE__"', $nonfinite, $json));
                $this->previewIdBackup($bad, 400);
                $this->assertSame($before, $this->idBoundaryState($db));
            }
            foreach (['missing', 'unknown', 'legacy-mixed', 'future'] as $fault) {
                $bad = $path . '.' . $fault;
                copy($path, $bad);
                $this->rewriteBackupZip($bad, static function (array &$doc, array &$manifest) use ($fault): void {
                    if ($fault === 'missing') { unset($doc['tables']['view_floor_plans'][0]['rotation']); }
                    if ($fault === 'unknown') { $doc['tables']['view_floor_plans'][0]['unknown'] = 0; }
                    if ($fault === 'legacy-mixed') { $manifest['schema_version'] = 22; }
                    if ($fault === 'future') { $manifest['schema_version'] = 24; }
                });
                $this->previewIdBackup($bad, 400);
                $this->assertSame($before, $this->idBoundaryState($db));
            }
            $legacy = $path . '.schema22';
            copy($path, $legacy);
            $this->rewriteBackupZip($legacy, static function (array &$doc, array &$manifest): void {
                $manifest['schema_version'] = 22;
                foreach ($doc['tables']['view_floor_plans'] as &$plan) { unset($plan['rotation']); }
                unset($plan);
            });
            $this->commitIdBackup($this->previewIdBackup($legacy));
            $this->assertSame(0.0, $db->query('SELECT rotation FROM view_floor_plans')->fetchColumn());
        });
    }

    private function viewRevision(int $viewId): int
    {
        $data = $this->client->get('/api.php?action=load')->assertOk()->getJson();
        return (int)array_column($data['views'], 'resource_revision', 'id')[$viewId];
    }

    private function rewriteBackupZip(string $path, callable $change, ?callable $changeJson = null): void
    {
        $zip = new ZipArchive();
        $this->assertTrue($zip->open($path) === true);
        try {
            $document = json_decode((string)$zip->getFromName('data/netarium.json'), true, 512, JSON_THROW_ON_ERROR);
            $manifest = json_decode((string)$zip->getFromName('manifest.json'), true, 512, JSON_THROW_ON_ERROR);
            $change($document, $manifest);
            foreach (['views' => 'views', 'devices' => 'devices', 'placements' => 'device_placements',
                'links' => 'links', 'link_systems' => 'link_systems', 'canvas_notes' => 'canvas_notes',
                'floor_plans' => 'view_floor_plans', 'device_images' => 'device_images',
                'rack_settings' => 'rack_settings', 'rack_mounts' => 'rack_mounts',
                'device_ip_addresses' => 'device_ip_addresses', 'address_spaces' => 'address_spaces',
                'ip_segments' => 'ip_segments', 'change_history' => 'change_history',
                'device_configs' => 'device_configs', 'device_config_states' => 'device_config_states'] as $key => $table) {
                if (isset($manifest['summary'][$key]) && is_array($document['tables'][$table] ?? null)) {
                    $manifest['summary'][$key] = count($document['tables'][$table]);
                }
            }
            $json = json_encode($document, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
            if ($changeJson !== null) {
                $json = $changeJson($json);
            }
            foreach ($manifest['files'] as &$entry) {
                if ($entry['path'] === 'data/netarium.json') {
                    $manifest['summary']['total_bytes'] += strlen($json) - (int)$entry['size'];
                    $entry['size'] = strlen($json);
                    $entry['sha256'] = hash('sha256', $json);
                }
            }
            unset($entry);
            $zip->addFromString('data/netarium.json', $json);
            $zip->addFromString('manifest.json', json_encode($manifest, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR));
        } finally {
            $zip->close();
        }
    }

    private static function removeIpManagementContract(array &$doc, array &$manifest): void
    {
        self::removeChangeHistoryContract($doc, $manifest);
        unset($manifest['summary']['address_spaces'], $manifest['summary']['ip_segments'],
            $doc['tables']['address_spaces'], $doc['tables']['ip_segments']);
        foreach ($doc['tables']['devices'] as &$row) { unset($row['ip_segment_id']); }
        unset($row);
        foreach ($doc['tables']['device_ip_addresses'] ?? [] as $index => $row) {
            unset($doc['tables']['device_ip_addresses'][$index]['segment_id']);
        }
    }

    private static function removeChangeHistoryContract(array &$doc, array &$manifest): void
    {
        foreach ($doc['tables']['view_floor_plans'] ?? [] as $index => $plan) {
            unset($doc['tables']['view_floor_plans'][$index]['rotation']);
        }
        foreach ($doc['tables']['address_spaces'] ?? [] as $index => $space) {
            unset($doc['tables']['address_spaces'][$index]['ping_reachability']);
        }
        unset($manifest['summary']['device_configs'], $manifest['summary']['device_config_states'],
            $doc['tables']['device_configs'], $doc['tables']['device_config_states']);
        unset($manifest['summary']['change_history'], $doc['tables']['change_history']);
    }

    public function testReachabilityMigrationAndWebBackupCompatibility(): void
    {
        $db = new \PDO('sqlite::memory:', null, null, [\PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION]);
        for ($v = 1; $v <= 20; $v++) { ('migrateDatabaseToVersion' . $v)($db); }
        $db->exec("INSERT INTO address_spaces (id,name,memo) VALUES (1,'Legacy','keep')");
        migrateDatabase($db);
        $this->assertSame('unset', $db->query('SELECT ping_reachability FROM address_spaces')->fetchColumn());
        $this->assertSame('keep', $db->query('SELECT memo FROM address_spaces')->fetchColumn());
        try {
            $db->exec("UPDATE address_spaces SET ping_reachability='invalid'");
            $this->fail('The three-state database contract must reject unknown values');
        } catch (\PDOException) {}
        $this->withIdBoundaryFixture(function (string $path, \PDO $db): void {
            $db->exec("INSERT INTO address_spaces (id,name,ping_reachability) VALUES (41,'A','reachable'),(42,'B','unreachable'),(43,'C','unset')");
            $deviceId = (int)$db->query('SELECT id FROM devices ORDER BY id LIMIT 1')->fetchColumn();
            $db->exec("INSERT INTO ip_segments(id,address_space_id,cidr) VALUES(51,42,'192.0.2.0/24')");
            $db->prepare("UPDATE devices SET ip='192.0.2.10',ip_segment_id=51 WHERE id=?")->execute([$deviceId]);
            $db->prepare("UPDATE device_monitor_status SET status='green',last_response_ms=8,last_error=NULL WHERE device_id=?")->execute([$deviceId]);
            $archive = $path . '.reachability.zip';
            file_put_contents($archive, $this->client->postJson('/api.php?action=export_backup_zip', [])->assertStatus(200)->getBody());
            $this->commitIdBackup($this->previewIdBackup($archive));
            $this->assertSame(['reachable','unreachable','unset'], $db->query('SELECT ping_reachability FROM address_spaces ORDER BY id')->fetchAll(\PDO::FETCH_COLUMN));
            $restored = $db->query('SELECT * FROM device_monitor_status WHERE device_id=' . $deviceId)->fetch(\PDO::FETCH_ASSOC);
            $this->assertSame('unknown', $restored['status']);
            $this->assertNull($restored['last_response_ms']);
            $this->assertStringContains('到達不可', $restored['last_error']);
            foreach (['invalid', null] as $value) {
                $bad = $archive . '.' . ($value ?? 'missing');
                copy($archive, $bad);
                $this->rewriteBackupZip($bad, static function (array &$doc) use ($value): void {
                    if ($value === null) { unset($doc['tables']['address_spaces'][0]['ping_reachability']); }
                    else { $doc['tables']['address_spaces'][0]['ping_reachability'] = $value; }
                });
                $this->previewIdBackup($bad, 400);
            }
            $legacy = $archive . '.schema20';
            copy($archive, $legacy);
            $this->rewriteBackupZip($legacy, static function (array &$doc, array &$manifest): void {
                $manifest['schema_version'] = 20;
                foreach ($doc['tables']['address_spaces'] as &$space) { unset($space['ping_reachability']); }
                unset($space);
                foreach ($doc['tables']['view_floor_plans'] as &$plan) { unset($plan['rotation']); }
                unset($plan);
            });
            $this->commitIdBackup($this->previewIdBackup($legacy));
            $this->assertSame(['unset','unset','unset'], $db->query('SELECT ping_reachability FROM address_spaces ORDER BY id')->fetchAll(\PDO::FETCH_COLUMN));
        });
    }

    public function testIpManagementBackupRoundTripAndContractBoundaries(): void
    {
        $this->withIdBoundaryFixture(function (string $path, \PDO $db): void {
            $ids = $db->query('SELECT id FROM devices ORDER BY id LIMIT 2')->fetchAll(\PDO::FETCH_COLUMN);
            $db->exec("INSERT INTO address_spaces(id,name,memo) VALUES(41,'本番','空間メモ'),(42,'隔離','')");
            $db->exec("INSERT INTO ip_segments(id,address_space_id,cidr,name,purpose,facility,vlan_id,memo)
                VALUES(51,41,'198.51.100.0/24','業務','用途','拠点',4094,'セグメントメモ'),
                (52,42,'198.51.100.0/24','隔離','','',NULL,'')");
            $stmt = $db->prepare("UPDATE devices SET ip='198.51.100.1',ip_segment_id=51 WHERE id=?");
            foreach ($ids as $id) { $stmt->execute([$id]); }
            $db->prepare("INSERT INTO device_ip_addresses(id,device_id,ip,label,sort_order,segment_id)
                VALUES(71,?,'198.51.100.255',' ブロードキャスト ',4,51)")->execute([$ids[0]]);
            $kept = [];
            foreach (['address_spaces', 'ip_segments', 'device_ip_addresses'] as $table) {
                $kept[$table] = $db->query("SELECT * FROM $table ORDER BY id")->fetchAll(\PDO::FETCH_ASSOC);
            }
            $archive = $path . '.ipam.zip';
            file_put_contents($archive, $this->client->postJson('/api.php?action=export_backup_zip', [])->assertStatus(200)->getBody());
            $db->exec('DELETE FROM device_ip_addresses; UPDATE devices SET ip_segment_id=NULL; DELETE FROM ip_segments; DELETE FROM address_spaces');
            $this->commitIdBackup($this->previewIdBackup($archive));
            foreach ($kept as $table => $rows) {
                $this->assertSame($rows, $db->query("SELECT * FROM $table ORDER BY id")->fetchAll(\PDO::FETCH_ASSOC));
            }
            $this->assertSame(2, (int)$db->query('SELECT COUNT(*) FROM devices WHERE ip_segment_id=51')->fetchColumn());
            $before = $this->idBoundaryState($db);
            foreach (['cidr', 'host-bits', 'overlap', 'space', 'segment', 'range', 'empty-ip', 'vlan', 'unknown', 'missing', 'duplicate-space', 'duplicate-segment', 'newer'] as $fault) {
                $bad = $archive . '.' . $fault;
                copy($archive, $bad);
                $this->rewriteBackupZip($bad, static function (array &$doc, array &$manifest) use ($fault): void {
                    $segment = &$doc['tables']['ip_segments'][0];
                    if ($fault === 'cidr') { $segment['cidr'] = '198.51.100.0/33'; }
                    if ($fault === 'host-bits') { $segment['cidr'] = '198.51.100.1/24'; }
                    if ($fault === 'overlap') { $doc['tables']['ip_segments'][1]['address_space_id'] = 41; }
                    if ($fault === 'space') { $segment['address_space_id'] = 999999; }
                    if ($fault === 'segment') { $doc['tables']['devices'][0]['ip_segment_id'] = 999999; }
                    if ($fault === 'range') { $doc['tables']['device_ip_addresses'][0]['ip'] = '203.0.113.1'; }
                    if ($fault === 'empty-ip') { $doc['tables']['devices'][0]['ip'] = ''; }
                    if ($fault === 'vlan') { $segment['vlan_id'] = 4095; }
                    if ($fault === 'unknown') { $segment['extra'] = ''; }
                    if ($fault === 'missing') { unset($doc['tables']['devices'][0]['ip_segment_id']); }
                    if ($fault === 'duplicate-space') { $doc['tables']['address_spaces'][] = $doc['tables']['address_spaces'][0]; }
                    if ($fault === 'duplicate-segment') { $doc['tables']['ip_segments'][] = $segment; }
                    if ($fault === 'newer') { $manifest['schema_version'] = APP_DATABASE_SCHEMA_VERSION + 1; }
                });
                $this->previewIdBackup($bad, 400);
                $this->assertSame($before, $this->idBoundaryState($db));
            }
            $beforeLoad = $this->client->get('/api.php?action=load')->assertOk()->getJson();
            foreach ([17, 18] as $schema) {
                foreach (['legacy invalid IP', '2001:db8::1'] as $index => $invalidIp) {
                    $bad = $archive . '.management-ip.' . $schema . '.' . $index;
                    copy($archive, $bad);
                    $this->rewriteBackupZip($bad, static function (array &$doc, array &$manifest) use ($schema, $invalidIp): void {
                        $manifest['schema_version'] = $schema;
                        self::removeChangeHistoryContract($doc, $manifest);
                        if ($schema === 17) {
                            self::removeIpManagementContract($doc, $manifest);
                        } else {
                            $doc['tables']['devices'][0]['ip_segment_id'] = null;
                        }
                        $doc['tables']['devices'][0]['ip'] = $invalidIp;
                        $doc['tables']['devices'][0]['memo'] = '拒否時に反映してはいけない';
                    });
                    $result = $this->previewIdBackup($bad, 400);
                    $this->assertFalse(isset($result['restore_token']));
                    $this->assertStringContains('devices.ip', $result['error']);
                    $this->assertStringContains('IPv4', $result['error']);
                    $this->assertSame($before, $this->idBoundaryState($db));
                    $this->assertSame($beforeLoad, $this->client->get('/api.php?action=load')->assertOk()->getJson());
                }
            }
            $legacy = $archive . '.schema17';
            copy($archive, $legacy);
            $this->rewriteBackupZip($legacy, static function (array &$doc, array &$manifest): void {
                $manifest['schema_version'] = 17;
                self::removeChangeHistoryContract($doc, $manifest);
                self::removeIpManagementContract($doc, $manifest);
                $doc['tables']['devices'][1]['ip'] = '';
            });
            $this->commitIdBackup($this->previewIdBackup($legacy));
            $this->assertSame([], $db->query('SELECT * FROM address_spaces')->fetchAll());
            $this->assertSame([], $db->query('SELECT * FROM ip_segments')->fetchAll());
            $this->assertSame(0, (int)$db->query('SELECT COUNT(*) FROM devices WHERE ip_segment_id IS NOT NULL')->fetchColumn());
            $this->assertSame(71, (int)$db->query('SELECT id FROM device_ip_addresses')->fetchColumn());
            $this->assertSame(null, $db->query('SELECT segment_id FROM device_ip_addresses')->fetchColumn());
            $this->assertSame('', $db->query('SELECT ip FROM devices ORDER BY id LIMIT 1 OFFSET 1')->fetchColumn());
            $devices = $db->query('SELECT * FROM devices ORDER BY id')->fetchAll(\PDO::FETCH_ASSOC);
            $addresses = $db->query('SELECT * FROM device_ip_addresses ORDER BY id')->fetchAll(\PDO::FETCH_ASSOC);
            $current = $archive . '.schema18-roundtrip.zip';
            file_put_contents($current, $this->client->postJson('/api.php?action=export_backup_zip', [])->assertStatus(200)->getBody());
            $db->exec("DELETE FROM device_ip_addresses; UPDATE devices SET memo='復元前の変更'");
            $this->commitIdBackup($this->previewIdBackup($current));
            $restoredDevices = $db->query('SELECT * FROM devices ORDER BY id')->fetchAll(\PDO::FETCH_ASSOC);
            foreach ($devices as $index => &$device) {
                $this->assertTrue($restoredDevices[$index]['resource_revision'] > $device['resource_revision']);
                $device['resource_revision'] = $restoredDevices[$index]['resource_revision'];
            }
            unset($device);
            $this->assertSame($devices, $restoredDevices);
            $this->assertSame($addresses, $db->query('SELECT * FROM device_ip_addresses ORDER BY id')->fetchAll(\PDO::FETCH_ASSOC));
            $this->assertSame([], $db->query('SELECT * FROM address_spaces')->fetchAll());
            $this->assertSame([], $db->query('SELECT * FROM ip_segments')->fetchAll());
        });
    }

    public function testChangeHistoryBackupRoundTripRetentionAndSchema18Migration(): void
    {
        $this->withIdBoundaryFixture(function (string $path, \PDO $db): void {
            $recentAt = gmdate('Y-m-d\TH:i:s\Z', time() - 5 * 86400);
            $expiredAt = gmdate('Y-m-d\TH:i:s\Z', time() - 95 * 86400);
            $changesJson = json_encode([
                'source' => 'save_resources',
                'items' => [['label' => '管理IP', 'before' => '192.0.2.10', 'after' => '192.0.2.11']],
            ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
            $ins = $db->prepare("INSERT INTO change_history (
                id, event_id, request_id, occurred_at, actor_user_id, actor_name,
                target_type, target_id, target_name, operation, summary, changes_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
            $ins->execute([10, 10, 'req-expired', $expiredAt, 1, 'admin', 'device', 1, '旧変更機器', 'update', '期限切れ変更', $changesJson]);
            $ins->execute([25, 25, 'req-recent', $recentAt, 1, 'admin', 'device', 1, '直近変更機器', 'update', '管理IPを変更', $changesJson]);
            $recentRow = $db->query('SELECT * FROM change_history WHERE id=25')->fetchAll(\PDO::FETCH_ASSOC);
            $sourceHistory = $db->query('SELECT * FROM change_history ORDER BY id')->fetchAll(\PDO::FETCH_ASSOC);

            $archive = $path . '.history19.zip';
            file_put_contents($archive, $this->client->postJson('/api.php?action=export_backup_zip', [])->assertStatus(200)->getBody());
            $zip = new ZipArchive();
            $this->assertTrue($zip->open($archive) === true);
            try {
                $document = json_decode((string)$zip->getFromName('data/netarium.json'), true, 512, JSON_THROW_ON_ERROR);
                $manifest = json_decode((string)$zip->getFromName('manifest.json'), true, 512, JSON_THROW_ON_ERROR);
                $this->assertSame($recentRow, $document['tables']['change_history']);
                $this->assertSame(1, $manifest['summary']['change_history']);
            } finally {
                $zip->close();
            }
            $this->assertSame($sourceHistory, $db->query('SELECT * FROM change_history ORDER BY id')->fetchAll(\PDO::FETCH_ASSOC));
            $db->exec('DELETE FROM change_history');
            $this->commitIdBackup($this->previewIdBackup($archive));

            // 90日以内は保持し、復元自体の大量履歴は生成しない
            $this->assertSame($recentRow, $db->query('SELECT * FROM change_history ORDER BY id')->fetchAll(\PDO::FETCH_ASSOC));
            $seq = (int)$db->query("SELECT seq FROM sqlite_sequence WHERE name='change_history'")->fetchColumn();
            $this->assertTrue($seq >= 25);

            // 旧ZIPや保存後に期限を迎えた履歴も復元時に整理する。
            $expiredArchive = $archive . '.expired';
            copy($archive, $expiredArchive);
            $this->rewriteBackupZip($expiredArchive, static function (array &$doc, array &$manifest) use ($sourceHistory): void {
                $doc['tables']['change_history'] = $sourceHistory;
            });
            $this->commitIdBackup($this->previewIdBackup($expiredArchive));
            $this->assertSame($recentRow, $db->query('SELECT * FROM change_history ORDER BY id')->fetchAll(\PDO::FETCH_ASSOC));

            // スキーマ18 ZIPからの復元では空履歴へ移行
            $schema18Zip = $archive . '.schema18';
            copy($archive, $schema18Zip);
            $this->rewriteBackupZip($schema18Zip, static function (array &$doc, array &$manifest): void {
                $manifest['schema_version'] = 18;
                self::removeChangeHistoryContract($doc, $manifest);
            });
            $this->commitIdBackup($this->previewIdBackup($schema18Zip));
            $this->assertSame([], $db->query('SELECT * FROM change_history')->fetchAll(\PDO::FETCH_ASSOC));

            // 不正なchange_historyデータの拒否
            foreach (['bad-date', 'bad-type', 'bad-op', 'bad-json', 'extra-key', 'schema18-with-history'] as $fault) {
                $bad = $archive . '.' . $fault;
                copy($archive, $bad);
                $this->rewriteBackupZip($bad, static function (array &$doc, array &$manifest) use ($fault): void {
                    $row = &$doc['tables']['change_history'][0];
                    if ($fault === 'bad-date') { $row['occurred_at'] = '2026-10-30 12:00:00'; }
                    if ($fault === 'bad-type') { $row['target_type'] = 'subnet'; }
                    if ($fault === 'bad-op') { $row['operation'] = 'merge'; }
                    if ($fault === 'bad-json') { $row['changes_json'] = '{"items":"invalid"}'; }
                    if ($fault === 'extra-key') { $row['secret'] = 'x'; }
                    if ($fault === 'schema18-with-history') {
                        $manifest['schema_version'] = 18;
                        unset($manifest['summary']['change_history']);
                    }
                });
                $this->previewIdBackup($bad, 400);
            }
        });
    }

    public function testSchema17MigrationPreservesAdditionalIdsAndUnclassifiesAllRecords(): void
    {
        require_once dirname(__DIR__, 2) . '/src/Core/DatabaseSchema.php';
        $db = new \PDO('sqlite::memory:', null, null, [\PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION]);
        $db->exec('PRAGMA foreign_keys=ON');
        foreach (range(1, 17) as $version) { ('migrateDatabaseToVersion' . $version)($db); }
        $db->exec("INSERT INTO devices(id,name,type,ip) VALUES(1,'旧機器','other','legacy invalid IP'),(2,'重複','other','198.51.100.1')");
        $db->exec("INSERT INTO device_ip_addresses(id,device_id,ip,label,sort_order)
            VALUES(71,1,'198.51.100.1','旧用途',4),(72,2,'203.0.113.1','',0)");
        $devices = $db->query('SELECT * FROM devices ORDER BY id')->fetchAll(\PDO::FETCH_ASSOC);
        $addresses = $db->query('SELECT * FROM device_ip_addresses ORDER BY id')->fetchAll(\PDO::FETCH_ASSOC);
        migrateDatabase($db);
        foreach ($devices as &$row) { $row['ip_segment_id'] = null; }
        unset($row);
        foreach ($addresses as &$row) { $row['segment_id'] = null; }
        unset($row);
        $this->assertSame($devices, $db->query('SELECT * FROM devices ORDER BY id')->fetchAll(\PDO::FETCH_ASSOC));
        $this->assertSame($addresses, $db->query('SELECT * FROM device_ip_addresses ORDER BY id')->fetchAll(\PDO::FETCH_ASSOC));
        $this->assertSame([], $db->query('SELECT * FROM address_spaces')->fetchAll());
        $this->assertSame([], $db->query('SELECT * FROM ip_segments')->fetchAll());
        $this->assertSame([], $db->query('PRAGMA foreign_key_check')->fetchAll());
    }

    public function testBackupCidrMembershipIncludesNetworkAndBroadcastBoundaries(): void
    {
        $db = new \PDO('sqlite::memory:');
        $service = new \Netarium\Services\Backup\BackupService($db);
        foreach ([
            ['0.0.0.0/0', ['0.0.0.0', '255.255.255.255']],
            ['192.0.2.0/31', ['192.0.2.0', '192.0.2.1']],
            ['192.0.2.1/32', ['192.0.2.1']],
        ] as [$cidr, $ips]) {
            $spaces = [['id' => 41, 'name' => '境界', 'memo' => '', 'ping_reachability' => 'unset']];
            $segments = [['id' => 51, 'address_space_id' => 41, 'cidr' => $cidr,
                'name' => '', 'purpose' => '', 'facility' => '', 'vlan_id' => null, 'memo' => '']];
            $devices = array_map(static fn($ip) => ['ip' => $ip, 'ip_segment_id' => 51], $ips);
            $this->assertSame(['address_spaces' => $spaces, 'ip_segments' => $segments],
                $service->validateBackupIpManagement($spaces, $segments, $devices, []));
        }
    }

    public function testAutomaticBackupRetentionProtectsCurrentSnapshotWhenTimestampsTie(): void
    {
        require_once dirname(__DIR__, 2) . '/bootstrap.php';
        $directory = sys_get_temp_dir() . '/netarium_backup_retention_' . bin2hex(random_bytes(6));
        $this->assertTrue(mkdir($directory, 0700, true));
        try {
            $service = new \Netarium\Services\Backup\BackupService(new \PDO('sqlite::memory:'));
            $timestamp = time() - 60;
            $current = $directory . '/pre-restore_20261028_120000_ffffffff.zip';
            $contents = 'current pre-restore snapshot';
            foreach ([
                'pre-restore_20261028_120000_00000000.zip' => 'older snapshot one',
                'pre-restore_20261028_120000_11111111.zip' => 'older snapshot two',
                basename($current) => $contents,
            ] as $filename => $bytes) {
                $path = $directory . '/' . $filename;
                $this->assertSame(strlen($bytes), file_put_contents($path, $bytes));
                $this->assertTrue(touch($path, $timestamp));
            }
            $this->assertTrue($service->cleanupAutomaticBackups($directory, 1, 7, $current));
            $this->assertSame([$current], glob($directory . '/pre-restore_*.zip'));
            $this->assertSame($contents, file_get_contents($current));
        } finally {
            $this->removeTreeRecursive($directory);
        }
    }

    private function saveBackupLinks(array $data, array $links): array
    {
        $this->client->postJson('/api.php?action=save', [
            'revision' => (int)$data['revision'],
            'views' => $data['views'],
            'devices' => $data['devices'],
            'placements' => $data['placements'],
            'links' => $links,
            'canvas_notes' => $data['canvas_notes'],
        ])->assertOk();
        return $this->client->get('/api.php?action=load')->assertOk()->getJson();
    }
    private function seedBackupImages(\Netarium\Tests\TestServer $server, int $floorPlanCount): array
    {
        $db = new \PDO('sqlite:' . $server->getDbPath());
        $db->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
        $db->exec('PRAGMA foreign_keys = ON');
        $floorDir = $server->getTempDir() . DIRECTORY_SEPARATOR . 'uploads' . DIRECTORY_SEPARATOR . 'floorplans';
        $imageDir = $server->getTempDir() . DIRECTORY_SEPARATOR . 'uploads' . DIRECTORY_SEPARATOR . 'device_images';
        if (!is_dir($imageDir)) {
            mkdir($imageDir, 0700, true);
        }

        $png = base64_decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', true);
        $now = date(DATE_ATOM);
        if ($floorPlanCount === 100) {
            $db->exec("UPDATE views SET view_type = 'floor' WHERE id = 1");
            $insertView = $db->prepare("INSERT INTO views (id, name, view_type, sort_order) VALUES (?, ?, 'floor', ?)");
            for ($id = 3; $id <= 100; $id++) {
                $insertView->execute([$id, '図面テスト' . $id, $id]);
            }
        }

        $insertFloor = $db->prepare(
            'INSERT INTO view_floor_plans (view_id, stored_name, original_name, mime_type, file_size, image_width, image_height, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?)'
        );
        $viewIds = $floorPlanCount === 100 ? range(1, 100) : [2];
        foreach ($viewIds as $viewId) {
            $storedName = sprintf('%032x.png', $viewId);
            file_put_contents($floorDir . DIRECTORY_SEPARATOR . $storedName, $png);
            $insertFloor->execute([$viewId, $storedName, '図面.png', 'image/png', strlen($png), $now, $now]);
        }

        $imageName = sprintf('%032x.png', 101);
        file_put_contents($imageDir . DIRECTORY_SEPARATOR . $imageName, $png);
        $insertImage = $db->prepare(
            'INSERT INTO device_images (device_id, stored_name, mime_type, file_size, image_width, image_height, sort_order, created_at, updated_at) VALUES (1, ?, ?, ?, 1, 1, 1, ?, ?)'
        );
        $insertImage->execute([$imageName, 'image/png', strlen($png), $now, $now]);
        return [$db, $floorDir, $imageDir, $imageName];
    }

    private function withStringBoundaryFixture(callable $test): void
    {
        $server = new \Netarium\Tests\TestServer();
        $originalClient = $this->client;
        try {
            $server->start();
            $this->client = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($this->client->login('admin', 'admin123'));
            $db = new \PDO('sqlite:' . $server->getDbPath());
            $db->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
            $test($server->getTempDir() . '/string-boundary.zip', $db, $server);
        } finally {
            $this->client = $originalClient;
            $db = null;
            $server->stop();
        }
    }

    private function saveStringBoundaryValues(array $data, string $location, string $vlan): array
    {
        $device = $data['devices'][0];
        $device['location'] = $location;
        $link = $data['links'][0];
        $viewId = (int)$link['view_id'];
        $view = array_column($data['views'], null, 'id')[$viewId];
        $links = array_values(array_filter($data['links'], static fn(array $row): bool => (int)$row['view_id'] === $viewId));
        $links[0]['vlan'] = $vlan;
        $this->client->postJson('/api.php?action=save_resources', [
            'devices' => [['operation' => 'update', 'id' => (int)$device['id'],
                'expected_revision' => (int)$device['resource_revision'], 'device' => $device]],
            'views' => [['operation' => 'update', 'id' => $viewId,
                'expected_revision' => (int)$view['resource_revision'], 'view' => $view,
                'placements' => array_values(array_filter($data['placements'], static fn(array $row): bool => (int)$row['view_id'] === $viewId)),
                'links' => $links,
                'canvas_notes' => array_values(array_filter($data['canvas_notes'], static fn(array $row): bool => (int)$row['view_id'] === $viewId))]],
        ])->assertOk();
        return $this->client->get('/api.php?action=load')->assertOk()->getJson();
    }

    private function assertStringBoundaryRoundTrip(string $field, int $oldLimit, int $limit): void
    {
        $this->withStringBoundaryFixture(function (string $path) use ($field, $oldLimit, $limit): void {
            foreach ([str_repeat('A', $oldLimit + 1), str_repeat('B', $limit), str_repeat('𠀀', $limit)] as $value) {
                $data = $this->client->get('/api.php?action=load')->assertOk()->getJson();
                $location = $field === 'location' ? $value : '';
                $vlan = $field === 'vlan' ? $value : '';
                $saved = $this->saveStringBoundaryValues($data, $location, $vlan);
                $this->assertSame($location, $saved['devices'][0]['location']);
                $this->assertSame($vlan, $saved['links'][0]['vlan']);
                file_put_contents($path, $this->client->postJson('/api.php?action=export_backup_zip', [])->assertStatus(200)->getBody());
                $zip = new ZipArchive();
                $this->assertTrue($zip->open($path) === true);
                try {
                    $document = json_decode((string)$zip->getFromName('data/netarium.json'), true, 512, JSON_THROW_ON_ERROR);
                    $manifest = json_decode((string)$zip->getFromName('manifest.json'), true, 512, JSON_THROW_ON_ERROR);
                    $this->assertSame('netarium-config', $manifest['format']);
                    $this->assertSame($location, $document['tables']['devices'][0]['location']);
                    $this->assertSame($vlan, $document['tables']['links'][0]['vlan']);
                } finally {
                    $zip->close();
                }
                $this->saveStringBoundaryValues($saved, '復元前の設置場所', '復元前のVLAN');
                $before = $this->client->get('/api.php?action=load')->assertOk()->getJson();
                // Exported ZIP is uploaded unchanged; preview must not apply its values.
                $preview = $this->client->postMultipart('/api.php?action=preview_backup_restore', [],
                    ['backup_zip' => ['path' => $path, 'filename' => 'boundary.zip', 'type' => 'application/zip']])->assertOk()->getJson();
                $this->assertSame($before, $this->client->get('/api.php?action=load')->assertOk()->getJson());
                $this->client->postJson('/api.php?action=commit_backup_restore', [
                    'restore_token' => $preview['restore_token'], 'confirmation' => 'バックアップから復元',
                ])->assertOk();
                $restored = $this->client->get('/api.php?action=load')->assertOk()->getJson();
                $this->assertSame($location, $restored['devices'][0]['location']);
                $this->assertSame($vlan, $restored['links'][0]['vlan']);
            }
        });
    }

    public function testSavedLocationBoundariesRoundTripThroughBackup(): void
    {
        $this->assertStringBoundaryRoundTrip('location', 100, 150);
    }

    public function testSavedVlanBoundariesRoundTripThroughBackup(): void
    {
        $this->assertStringBoundaryRoundTrip('vlan', 50, 100);
    }

    public function testOversizedBackupStringsRejectWithoutChangingCurrentData(): void
    {
        $this->withStringBoundaryFixture(function (string $path, \PDO $db): void {
            $validPath = $path . '.valid.zip';
            file_put_contents($validPath, $this->client->postJson('/api.php?action=export_backup_zip', [])->assertStatus(200)->getBody());
            $before = $this->client->get('/api.php?action=load')->assertOk()->getJson();
            $allocationState = static fn(): array => [
                $db->query('SELECT * FROM app_meta ORDER BY meta_key')->fetchAll(\PDO::FETCH_ASSOC),
                $db->query('SELECT * FROM resource_sequences ORDER BY 1')->fetchAll(\PDO::FETCH_ASSOC),
            ];
            $allocations = $allocationState();
            foreach ([['devices', 'location', 150], ['links', 'vlan', 100]] as [$table, $field, $limit]) {
                foreach (['A', '𠀀'] as $character) {
                    copy($validPath, $path);
                    $this->rewriteBackupZip($path, static function (array &$document, array &$manifest) use ($table, $field, $limit, $character): void {
                        $document['tables']['devices'][0]['memo'] = '拒否時に反映してはいけない';
                        $document['tables'][$table][0][$field] = str_repeat($character, $limit + 1);
                    });
                    // Checksums are valid, so the rejection must be field validation.
                    $result = $this->client->postMultipart('/api.php?action=preview_backup_restore', [],
                        ['backup_zip' => ['path' => $path, 'filename' => 'oversized.zip', 'type' => 'application/zip']])->assertStatus(400)->getJson();
                    $this->assertFalse(isset($result['restore_token']));
                    $this->assertSame($before, $this->client->get('/api.php?action=load')->assertOk()->getJson());
                    $this->assertSame($allocations, $allocationState());
                }
            }
        });
    }

    public function testPcSchemaMigrationPreservesRelatedRowsAndCounters(): void
    {
        require_once dirname(__DIR__, 2) . '/src/Core/DatabaseSchema.php';
        $db = new \PDO('sqlite::memory:', null, null, [\PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION]);
        $db->exec('PRAGMA foreign_keys=ON');
        foreach (range(1, 12) as $version) {
            ('migrateDatabaseToVersion' . $version)($db);
        }
        $db->exec("INSERT INTO views(id,name) VALUES (1,'Topology')");
        $db->exec("INSERT INTO views(id,name,view_type) VALUES (2,'Rack','rack')");
        $db->exec("INSERT INTO devices(id,name,type) VALUES (1,'Server','server'),(2,'Printer','printer')");
        $db->exec('INSERT INTO device_placements(id,device_id,view_id,x,y) VALUES (1,1,1,12,34)');
        $db->exec('INSERT INTO links(id,view_id,from_id,to_id) VALUES (1,1,1,2)');
        $db->exec("INSERT INTO device_monitor_status(device_id,status) VALUES (1,'green')");
        $db->exec("INSERT INTO rack_settings VALUES (2,42,'Room')");
        $db->exec("INSERT INTO rack_mounts VALUES (1,2,'both',1,2,'full')");
        $db->exec("INSERT INTO device_images(id,device_id,stored_name,mime_type,file_size,image_width,image_height,sort_order,created_at,updated_at)
            VALUES (100,1,'preserve.png','image/png',10,1,1,1,'2026-01-01','2026-01-01')");
        $db->exec('DELETE FROM device_images WHERE id=100');
        $db->exec("INSERT INTO device_images(device_id,stored_name,mime_type,file_size,image_width,image_height,sort_order,created_at,updated_at)
            VALUES (1,'keep.png','image/png',10,1,1,1,'2026-01-01','2026-01-01')");
        $tables = $db->query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")->fetchAll(\PDO::FETCH_COLUMN);
        $before = [];
        foreach ($tables as $table) {
            $before[$table] = $db->query("SELECT * FROM \"$table\" ORDER BY rowid")->fetchAll(\PDO::FETCH_ASSOC);
        }
        $objects = $db->query("SELECT type,name,tbl_name,sql FROM sqlite_master
            WHERE type IN ('trigger','index') AND name <> 'resource_owner_view_floor_plans_update'
            ORDER BY name")->fetchAll(\PDO::FETCH_ASSOC);
        migrateDatabase($db);
        $this->assertSame(APP_DATABASE_SCHEMA_VERSION, (int)$db->query('PRAGMA user_version')->fetchColumn());
        $this->assertSame(1, (int)$db->query('PRAGMA foreign_keys')->fetchColumn());
        $this->assertSame([], $db->query('PRAGMA foreign_key_check')->fetchAll());
        foreach ($before as $table => $rows) {
            if ($table === 'rack_mounts') {
                $rows = array_map(static fn($row) => $row + ['depth' => 'half'], $rows);
            }
            if ($table === 'devices') {
                $rows = array_map(static fn($row) => $row + ['ip_segment_id' => null], $rows);
            }
            $where = $table === 'resource_sequences' ? " WHERE name <> 'rack_shelves'" : '';
            $this->assertSame($rows, $db->query("SELECT * FROM \"$table\"$where ORDER BY rowid")->fetchAll(\PDO::FETCH_ASSOC));
        }
        $oldNames = array_column($objects, 'name');
        $newObjects = $db->query("SELECT type,name,tbl_name,sql FROM sqlite_master
            WHERE type IN ('trigger','index') ORDER BY name")->fetchAll(\PDO::FETCH_ASSOC);
        $this->assertSame($objects, array_values(array_filter($newObjects,
            static fn($row) => in_array($row['name'], $oldNames, true))));
        $revision = (int)$db->query('SELECT resource_revision FROM devices WHERE id=1')->fetchColumn();
        $db->exec("UPDATE devices SET type='pc' WHERE id=1");
        $this->assertTrue((int)$db->query('SELECT resource_revision FROM devices WHERE id=1')->fetchColumn() > $revision);
        $db->exec("INSERT INTO devices(id,name,type) VALUES (3,'PC','pc')");
        $db->exec("INSERT INTO device_images(device_id,stored_name,mime_type,file_size,image_width,image_height,sort_order,created_at,updated_at)
            VALUES (3,'next.png','image/png',10,1,1,1,'2026-01-01','2026-01-01')");
        $this->assertSame(102, (int)$db->lastInsertId());
        $db->exec('DELETE FROM devices WHERE id=1');
        foreach (['rack_mounts', 'device_placements', 'device_monitor_status', 'device_images'] as $table) {
            $this->assertSame(0, (int)$db->query("SELECT COUNT(*) FROM $table WHERE device_id=1")->fetchColumn());
        }
        $this->assertSame(0, (int)$db->query('SELECT COUNT(*) FROM links')->fetchColumn());
        $fresh = new \PDO('sqlite::memory:', null, null, [\PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION]);
        migrateDatabase($fresh);
        $fresh->exec("INSERT INTO devices(id,name,type) VALUES (1,'New PC','pc')");
        $this->assertSame('pc', $fresh->query('SELECT type FROM devices')->fetchColumn());
    }

    public function testAdditionalIpBackupRoundTripAndStrictSourceContract(): void
    {
        $this->withIdBoundaryFixture(function (string $path, \PDO $db): void {
            $ids = $db->query('SELECT id FROM devices ORDER BY id LIMIT 2')->fetchAll(\PDO::FETCH_COLUMN);
            $insert = $db->prepare('INSERT INTO device_ip_addresses(id,device_id,ip,label,sort_order) VALUES(?,?,?,?,?)');
            $insert->execute([71, $ids[0], '198.51.100.71', 'service', 1]);
            $insert->execute([72, $ids[0], '203.0.113.71', 'backup', 0]);
            $insert->execute([73, $ids[1], '198.51.100.71', 'isolated', 0]);
            $addresses = $db->query('SELECT * FROM device_ip_addresses ORDER BY id')->fetchAll(\PDO::FETCH_ASSOC);
            $archive = $path . '.addresses.zip';
            file_put_contents($archive, $this->client->postJson('/api.php?action=export_backup_zip', [])->assertStatus(200)->getBody());
            $db->exec('DELETE FROM device_ip_addresses');
            $this->commitIdBackup($this->previewIdBackup($archive));
            $this->assertSame($addresses, $db->query('SELECT * FROM device_ip_addresses ORDER BY id')->fetchAll(\PDO::FETCH_ASSOC));
            $before = $this->idBoundaryState($db);
            foreach (['invalid-ip', 'same-device', 'management', 'foreign-device', 'duplicate-id', 'label', 'sort', 'unknown', 'missing', 'old-schema'] as $fault) {
                $bad = $archive . '.' . $fault;
                copy($archive, $bad);
                $this->rewriteBackupZip($bad, static function (array &$doc, array &$manifest) use ($fault): void {
                    $row = &$doc['tables']['device_ip_addresses'][0];
                    if ($fault === 'invalid-ip') { $row['ip'] = '999.1.1.1'; }
                    if ($fault === 'same-device') { $row['ip'] = $doc['tables']['device_ip_addresses'][1]['ip']; }
                    if ($fault === 'management') { $doc['tables']['devices'][0]['ip'] = $row['ip']; }
                    if ($fault === 'foreign-device') { $row['device_id'] = 999999; }
                    if ($fault === 'duplicate-id') { $doc['tables']['device_ip_addresses'][1]['id'] = $row['id']; }
                    if ($fault === 'label') { $row['label'] = str_repeat('𠀀', 101); }
                    if ($fault === 'sort') { $row['sort_order'] = -1; }
                    if ($fault === 'unknown') { $row['unknown'] = null; }
                    if ($fault === 'missing') { unset($doc['tables']['device_ip_addresses']); }
                    if ($fault === 'old-schema') { $manifest['schema_version'] = 16; }
                });
                $this->previewIdBackup($bad, 400);
                $this->assertSame($before, $this->idBoundaryState($db));
            }
            $legacy = $archive . '.schema16';
            copy($archive, $legacy);
            $this->rewriteBackupZip($legacy, static function (array &$doc, array &$manifest): void {
                $manifest['schema_version'] = 16;
                self::removeIpManagementContract($doc, $manifest);
                unset($manifest['summary']['device_ip_addresses'], $doc['tables']['device_ip_addresses']);
            });
            $this->commitIdBackup($this->previewIdBackup($legacy));
            $this->assertSame([], $db->query('SELECT * FROM device_ip_addresses')->fetchAll(\PDO::FETCH_ASSOC));
        });
    }

    public function testFloorRackBackupRoundTripAndLegacyConversion(): void
    {
        $this->withIdBoundaryFixture(function (string $path, \PDO $db): void {
            $db->exec("INSERT INTO views(id,name,view_type) VALUES (90,'Placed rack','rack'),(91,'Rack floor','floor')");
            $db->exec("INSERT INTO rack_settings VALUES (90,42,'')");
            $db->exec('INSERT INTO floor_rack_placements VALUES (91,90,12.5,-20)');
            $archive = $path . '.floor-rack.zip';
            file_put_contents($archive, $this->client->postJson('/api.php?action=export_backup_zip', [])->assertStatus(200)->getBody());
            $db->exec('DELETE FROM floor_rack_placements');
            $this->commitIdBackup($this->previewIdBackup($archive));
            $this->assertSame(90, (int)$db->query('SELECT rack_view_id FROM floor_rack_placements')->fetchColumn());
            foreach (['duplicate', 'type', 'coordinate', 'missing'] as $fault) {
                $bad = $archive . '.' . $fault;
                copy($archive, $bad);
                $this->rewriteBackupZip($bad, static function (array &$doc) use ($fault): void {
                    if ($fault === 'duplicate') { $doc['tables']['floor_rack_placements'][] = $doc['tables']['floor_rack_placements'][0]; }
                    if ($fault === 'type') { $doc['tables']['floor_rack_placements'][0]['rack_view_id'] = 91; }
                    if ($fault === 'coordinate') { $doc['tables']['floor_rack_placements'][0]['x'] = '12'; }
                    if ($fault === 'missing') { unset($doc['tables']['floor_rack_placements']); }
                });
                $this->previewIdBackup($bad, 400);
            }
            foreach ([11, 12, 13, 14, 15] as $schema) {
                $bad = $archive . '.legacy' . $schema;
                copy($path, $bad);
                $this->rewriteBackupZip($bad, static function (array &$doc, array &$manifest) use ($schema): void {
                    $manifest['schema_version'] = $schema;
                    self::removeIpManagementContract($doc, $manifest);
                    unset($manifest['summary']['device_ip_addresses'], $doc['tables']['device_ip_addresses']);
                    unset($manifest['summary']['floor_rack_placements'], $doc['tables']['floor_rack_placements']);
                    if ($schema < 15) {
                        unset($manifest['summary']['rack_shelves'], $manifest['summary']['rack_shelf_devices']);
                        unset($doc['tables']['rack_shelves'], $doc['tables']['rack_shelf_devices']);
                    }
                    if ($schema === 11) {
                        unset($manifest['summary']['rack_settings'], $manifest['summary']['rack_mounts']);
                        unset($doc['tables']['rack_settings'], $doc['tables']['rack_mounts']);
                    }
                });
                $this->commitIdBackup($this->previewIdBackup($bad));
                $this->assertSame(0, (int)$db->query('SELECT COUNT(*) FROM floor_rack_placements')->fetchColumn());
            }
        });
    }

    public function testShelfBackupRoundTripAndStrictSourceSchemas(): void
    {
        $this->withIdBoundaryFixture(function (string $path, \PDO $db): void {
            $db->exec("INSERT INTO views(id,name,view_type) VALUES (90,'Shelf backup','rack')");
            $db->exec("INSERT INTO rack_settings VALUES (90,42,'')");
            $db->exec("INSERT INTO rack_shelves VALUES (7,90,'Backup shelf','rear',2,1,'full')");
            $deviceId = (int)$db->query('SELECT id FROM devices ORDER BY id LIMIT 1')->fetchColumn();
            $db->exec("INSERT INTO rack_shelf_devices VALUES ($deviceId,7,0)");
            $shelves = $db->query('SELECT * FROM rack_shelves')->fetchAll(\PDO::FETCH_ASSOC);
            $members = $db->query('SELECT * FROM rack_shelf_devices')->fetchAll(\PDO::FETCH_ASSOC);
            $archive = $path . '.shelves.zip';
            file_put_contents($archive, $this->client->postJson('/api.php?action=export_backup_zip', [])->assertStatus(200)->getBody());
            $db->exec('DELETE FROM rack_shelves');
            $this->commitIdBackup($this->previewIdBackup($archive));
            $this->assertSame($shelves, $db->query('SELECT * FROM rack_shelves')->fetchAll(\PDO::FETCH_ASSOC));
            $this->assertSame($members, $db->query('SELECT * FROM rack_shelf_devices')->fetchAll(\PDO::FETCH_ASSOC));
            $bad = $archive . '.bad';
            copy($archive, $bad);
            $this->rewriteBackupZip($bad, static function (array &$doc): void {
                $doc['tables']['rack_shelf_devices'][] = $doc['tables']['rack_shelf_devices'][0];
            });
            $this->previewIdBackup($bad, 400);
            $this->assertSame($members, $db->query('SELECT * FROM rack_shelf_devices')->fetchAll(\PDO::FETCH_ASSOC));
            copy($archive, $bad);
            $this->rewriteBackupZip($bad, static function (array &$doc): void {
                unset($doc['tables']['rack_shelves']);
            });
            $this->previewIdBackup($bad, 400);
            foreach ([11, 12, 13, 14] as $schema) {
                copy($path, $bad);
                $this->rewriteBackupZip($bad, static function (array &$doc, array &$manifest) use ($schema): void {
                    $manifest['schema_version'] = $schema;
                    self::removeIpManagementContract($doc, $manifest);
                    unset($manifest['summary']['device_ip_addresses'], $doc['tables']['device_ip_addresses']);
                    unset($manifest['summary']['floor_rack_placements'], $doc['tables']['floor_rack_placements']);
                    unset($manifest['summary']['rack_shelves'], $manifest['summary']['rack_shelf_devices']);
                    unset($doc['tables']['rack_shelves'], $doc['tables']['rack_shelf_devices']);
                    if ($schema === 11) {
                        unset($manifest['summary']['rack_settings'], $manifest['summary']['rack_mounts']);
                        unset($doc['tables']['rack_settings'], $doc['tables']['rack_mounts']);
                    }
                });
                $preview = $this->previewIdBackup($bad);
                $this->assertSame(1, count($preview['rack_removal']['rack_shelves']));
                $this->assertSame(1, count($preview['rack_removal']['rack_shelf_devices']));
                $this->commitIdBackup($preview);
                $this->assertSame(0, (int)$db->query('SELECT COUNT(*) FROM rack_shelves')->fetchColumn());
                $this->commitIdBackup($this->previewIdBackup($archive));
            }
        });
    }

    public function testPcBackupRoundTripAndStrictLegacyContracts(): void
    {
        $this->withIdBoundaryFixture(function (string $path, \PDO $db): void {
            $original = file_get_contents($path);
            foreach ([11, 12, 13, 14, 15] as $schema) {
                file_put_contents($path, $original);
                $this->rewriteBackupZip($path, static function (array &$doc, array &$manifest) use ($schema): void {
                    $manifest['schema_version'] = $schema;
                    self::removeIpManagementContract($doc, $manifest);
                    unset($manifest['summary']['device_ip_addresses'], $doc['tables']['device_ip_addresses']);
                    unset($manifest['summary']['floor_rack_placements'], $doc['tables']['floor_rack_placements']);
                    $doc['tables']['devices'][0]['type'] = 'pc';
                    if ($schema < 15) {
                        unset($manifest['summary']['rack_shelves'], $manifest['summary']['rack_shelf_devices']);
                        unset($doc['tables']['rack_shelves'], $doc['tables']['rack_shelf_devices']);
                    }
                    if ($schema === 11) {
                        unset($manifest['summary']['rack_settings'], $manifest['summary']['rack_mounts']);
                        unset($doc['tables']['rack_settings'], $doc['tables']['rack_mounts']);
                    }
                });
                $before = $this->idBoundaryState($db);
                if (!in_array($schema, [13, 14, 15], true)) {
                    $this->previewIdBackup($path, 400);
                    $this->assertSame($before, $this->idBoundaryState($db));
                    continue;
                }
                $this->commitIdBackup($this->previewIdBackup($path));
                $this->assertSame('pc', $db->query('SELECT type FROM devices ORDER BY id LIMIT 1')->fetchColumn());
                $roundTrip = $path . '.pc.zip';
                file_put_contents($roundTrip, $this->client->postJson('/api.php?action=export_backup_zip', [])->assertStatus(200)->getBody());
                $db->exec("UPDATE devices SET type='other'");
                $this->commitIdBackup($this->previewIdBackup($roundTrip));
                $this->assertSame('pc', $db->query('SELECT type FROM devices ORDER BY id LIMIT 1')->fetchColumn());
            }
            foreach ([11, 12] as $schema) {
                file_put_contents($path, $original);
                $this->rewriteBackupZip($path, static function (array &$doc, array &$manifest) use ($schema): void {
                    $manifest['schema_version'] = $schema;
                    self::removeIpManagementContract($doc, $manifest);
                    unset($manifest['summary']['device_ip_addresses'], $doc['tables']['device_ip_addresses']);
                    unset($manifest['summary']['floor_rack_placements'], $doc['tables']['floor_rack_placements']);
                    unset($manifest['summary']['rack_shelves'], $manifest['summary']['rack_shelf_devices']);
                    unset($doc['tables']['rack_shelves'], $doc['tables']['rack_shelf_devices']);
                    if ($schema === 11) {
                        unset($manifest['summary']['rack_settings'], $manifest['summary']['rack_mounts']);
                        unset($doc['tables']['rack_settings'], $doc['tables']['rack_mounts']);
                    }
                });
                $this->commitIdBackup($this->previewIdBackup($path));
                $this->assertFalse($db->query("SELECT 1 FROM devices WHERE type='pc'")->fetchColumn() !== false);
            }
        });
    }

    public function testRackBackupRoundTripAndLegacyConversion(): void
    {
        $this->withIdBoundaryFixture(function (string $path, \PDO $db, \Netarium\Tests\TestServer $server): void {
            $db->exec("INSERT INTO views (id,name,view_type) VALUES (90,'rack','rack')");
            $db->exec("INSERT INTO rack_settings VALUES (90,42,'server room')");
            $ids = $db->query('SELECT id FROM devices ORDER BY id LIMIT 2')->fetchAll(\PDO::FETCH_COLUMN);
            $db->exec("INSERT INTO rack_mounts VALUES ({$ids[0]},90,'rear',2,3,'left','full')");
            $db->exec("INSERT INTO canvas_notes (id,view_id,text,x,y,width,height,background_color,background_opacity,text_color,font_size)
                VALUES (9001,90,' ラック注釈 <b>文字</b> ',12.5,22,360,180,'#FFF3B0',0.4,'#ABCDEF',24)");
            $expectedNotes = $db->query('SELECT * FROM canvas_notes ORDER BY id')->fetchAll(\PDO::FETCH_ASSOC);
            $expectedApiNotes = $this->client->get('/api.php?action=load')->assertOk()->getJson()['canvas_notes'];
            $rackPath = $path . '.rack.zip';
            file_put_contents($rackPath, $this->client->postJson('/api.php?action=export_backup_zip', [])->assertStatus(200)->getBody());
            $expected = $db->query('SELECT * FROM rack_mounts')->fetchAll(\PDO::FETCH_ASSOC);
            $db->exec('DELETE FROM rack_mounts');
            $db->exec('DELETE FROM canvas_notes WHERE view_id=90');
            $this->commitIdBackup($this->previewIdBackup($rackPath));
            $this->assertSame($expected, $db->query('SELECT * FROM rack_mounts')->fetchAll(\PDO::FETCH_ASSOC));
            $this->assertSame($expectedNotes, $db->query('SELECT * FROM canvas_notes ORDER BY id')->fetchAll(\PDO::FETCH_ASSOC));
            $restored = $this->client->get('/api.php?action=load')->assertOk()->getJson();
            $this->assertSame($expectedApiNotes, $restored['canvas_notes']);
            foreach ([12, 13] as $sourceSchema) {
                $legacyRackPath = $rackPath . '.schema' . $sourceSchema;
                copy($rackPath, $legacyRackPath);
                $this->rewriteBackupZip($legacyRackPath, static function (array &$doc, array &$manifest) use ($sourceSchema): void {
                    $manifest['schema_version'] = $sourceSchema;
                    self::removeIpManagementContract($doc, $manifest);
                    unset($manifest['summary']['device_ip_addresses'], $doc['tables']['device_ip_addresses']);
                    unset($manifest['summary']['floor_rack_placements'], $doc['tables']['floor_rack_placements']);
                    unset($manifest['summary']['rack_shelves'], $manifest['summary']['rack_shelf_devices']);
                    unset($doc['tables']['rack_shelves'], $doc['tables']['rack_shelf_devices']);
                });
                $beforeLegacy = $this->client->get('/api.php?action=load')->assertOk()->getJson();
                // Depth must not be smuggled into a historical source contract.
                $this->previewIdBackup($legacyRackPath, 400);
                $this->assertSame($beforeLegacy, $this->client->get('/api.php?action=load')->assertOk()->getJson());
                $this->rewriteBackupZip($legacyRackPath, static function (array &$doc): void {
                    foreach ($doc['tables']['rack_mounts'] as &$mount) {
                        unset($mount['depth']);
                    }
                    unset($mount);
                });
                $this->commitIdBackup($this->previewIdBackup($legacyRackPath));
                $legacyExpected = array_map(static fn($row) => array_replace($row, ['depth' => 'half']), $expected);
                $this->assertSame($legacyExpected, $db->query('SELECT * FROM rack_mounts')->fetchAll(\PDO::FETCH_ASSOC));
                $this->assertSame($expectedNotes, $db->query('SELECT * FROM canvas_notes ORDER BY id')->fetchAll(\PDO::FETCH_ASSOC));
            }
            $this->commitIdBackup($this->previewIdBackup($rackPath));
            $users = $db->query('SELECT * FROM users ORDER BY id')->fetchAll(\PDO::FETCH_ASSOC);
            // The original no-rack archive is converted into a real schema11
            // source contract, including its own strict summary/table set.
            $this->rewriteBackupZip($path, static function (array &$doc, array &$manifest): void {
                $manifest['schema_version'] = 11;
                self::removeIpManagementContract($doc, $manifest);
                unset($manifest['summary']['device_ip_addresses'], $doc['tables']['device_ip_addresses']);
                unset($manifest['summary']['floor_rack_placements'], $doc['tables']['floor_rack_placements']);
                unset($manifest['summary']['rack_shelves'], $manifest['summary']['rack_shelf_devices']);
                unset($doc['tables']['rack_shelves'], $doc['tables']['rack_shelf_devices']);
                unset($manifest['summary']['rack_settings'], $manifest['summary']['rack_mounts']);
                unset($doc['tables']['rack_settings'], $doc['tables']['rack_mounts']);
            });
            $legacy = $this->previewIdBackup($path);
            $this->assertSame([90], $legacy['rack_removal']['rack_settings']);
            $this->assertSame([['device_id' => (int)$ids[0], 'view_id' => 90]], $legacy['rack_removal']['rack_mounts']);
            $this->commitIdBackup($legacy);
            $this->assertSame(0, (int)$db->query('SELECT COUNT(*) FROM rack_settings')->fetchColumn());
            $this->assertSame(0, (int)$db->query('SELECT COUNT(*) FROM rack_mounts')->fetchColumn());
            $this->assertSame(0, (int)$db->query('SELECT COUNT(*) FROM canvas_notes WHERE view_id=90')->fetchColumn());
            $this->assertSame($users, $db->query('SELECT * FROM users ORDER BY id')->fetchAll(\PDO::FETCH_ASSOC));
            $auto = glob($server->getTempDir() . '/backups/auto/*.zip') ?: [];
            $retainedRack = false;
            foreach ($auto as $candidate) {
                $zip = new ZipArchive();
                $this->assertTrue($zip->open($candidate) === true);
                $document = json_decode((string)$zip->getFromName('data/netarium.json'), true, 512, JSON_THROW_ON_ERROR);
                $zip->close();
                if ($document['tables']['rack_mounts'] === $expected && $document['tables']['canvas_notes'] === $expectedApiNotes) {
                    $retainedRack = true;
                }
            }
            $this->assertTrue($retainedRack, '復元前退避ZIPにラック搭載情報が残ること');
        });
    }

    public function testRackBackupInvalidSourcesAreNonDestructive(): void
    {
        $this->withIdBoundaryFixture(function (string $path, \PDO $db): void {
            $before = $this->idBoundaryState($db);
            foreach (['unknown-table', 'legacy-rack', 'unknown-column', 'collision', 'fractional', 'future',
                'xy-placement', 'xy-link', 'floor-plan', 'invalid-note'] as $fault) {
                $bad = $path . '.' . $fault;
                copy($path, $bad);
                $this->rewriteBackupZip($bad, static function (array &$doc, array &$manifest) use ($fault): void {
                    if ($fault === 'unknown-table') { $doc['tables']['extra'] = []; return; }
                    if ($fault === 'future') {
                        [$major, $minor, $patch] = explode('.', NETARIUM_VERSION);
                        $manifest['application_version'] = $major . '.' . $minor . '.' . ((int)$patch + 1);
                        return;
                    }
                    $doc['tables']['views'][] = ['id' => 90, 'resource_revision' => 1, 'name' => 'rack',
                        'facility' => '', 'floor' => '', 'view_type' => 'rack', 'sort_order' => 0, 'memo' => ''];
                    $doc['tables']['rack_settings'] = [['view_id' => 90, 'total_u' => 42, 'location' => '']];
                    $id = $doc['tables']['devices'][0]['id'];
                    $doc['tables']['rack_mounts'] = [['device_id' => $id, 'view_id' => 90, 'face' => 'both',
                        'start_u' => 1, 'height_u' => 2, 'width_slot' => 'full', 'depth' => 'half']];
                    if ($fault === 'legacy-rack') {
                        $manifest['schema_version'] = 11;
                        unset($manifest['summary']['rack_settings'], $manifest['summary']['rack_mounts']);
                        unset($doc['tables']['rack_settings'], $doc['tables']['rack_mounts']);
                    }
                    if ($fault === 'unknown-column') { $doc['tables']['rack_settings'][0]['extra'] = 1; }
                    if ($fault === 'collision') { $doc['tables']['rack_mounts'][] = $doc['tables']['rack_mounts'][0]; }
                    if ($fault === 'fractional') { $doc['tables']['rack_mounts'][0]['start_u'] = 1.5; }
                    foreach (['xy-placement' => 'device_placements', 'xy-link' => 'links', 'floor-plan' => 'view_floor_plans'] as $case => $table) {
                        if ($fault === $case) { $doc['tables'][$table][0]['view_id'] = 90; }
                    }
                    if ($fault === 'invalid-note') {
                        $doc['tables']['canvas_notes'][0]['view_id'] = 90;
                        $doc['tables']['canvas_notes'][0]['width'] = 119;
                    }
                });
                $this->previewIdBackup($bad, 400);
                $this->assertSame($before, $this->idBoundaryState($db));
            }
        });
    }

    private const RESTORE_ID_MAX = 9007199254740990;
    private const API_ID_MAX = 9007199254740991;

    private function withIdBoundaryFixture(callable $test, ?string $prepend = null): void
    {
        $server = new \Netarium\Tests\TestServer(null, $prepend);
        $originalClient = $this->client;
        $db = null;
        try {
            $server->start();
            $this->client = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($this->client->login('admin', 'admin123'));
            [$db] = $this->seedBackupImages($server, 1);
            $db->exec("INSERT INTO canvas_notes (id, view_id, text) VALUES (1, 1, 'ID境界メモ')");
            $db->exec("INSERT INTO link_systems (id, name, color_key) VALUES (1, 'ID境界系統', 'indigo')");
            $db->exec('UPDATE links SET system_id = 1');
            $path = $server->getTempDir() . '/id-boundary.zip';
            file_put_contents($path, $this->client->postJson('/api.php?action=export_backup_zip', [])->assertStatus(200)->getBody());
            $test($path, $db, $server);
        } finally {
            $this->client = $originalClient;
            $db = null;
            $server->stop();
        }
    }

    private function idBoundaryState(\PDO $db): array
    {
        $state = [];
        foreach (['devices', 'views', 'device_placements', 'links', 'canvas_notes', 'link_systems',
            'device_images', 'device_monitor_status', 'view_floor_plans', 'app_meta', 'rack_settings', 'rack_mounts',
            'resource_sequences', 'sqlite_sequence', 'device_ip_addresses', 'address_spaces', 'ip_segments', 'change_history',
            'device_configs', 'device_config_states'] as $table) {
            if (in_array($table, ['rack_settings', 'rack_mounts'], true)
                && (int)$db->query('PRAGMA user_version')->fetchColumn() === 11) {
                continue;
            }
            if ($table === 'device_ip_addresses' && (int)$db->query('PRAGMA user_version')->fetchColumn() < 17) {
                continue;
            }
            if (in_array($table, ['address_spaces', 'ip_segments'], true)
                && (int)$db->query('PRAGMA user_version')->fetchColumn() < 18) {
                continue;
            }
            if ($table === 'change_history' && (int)$db->query('PRAGMA user_version')->fetchColumn() < 19) {
                continue;
            }
            if (in_array($table, ['device_configs', 'device_config_states'], true)
                && (int)$db->query('PRAGMA user_version')->fetchColumn() < 20) {
                continue;
            }
            $rows = $db->query('SELECT * FROM ' . $table)->fetchAll(\PDO::FETCH_ASSOC);
            usort($rows, static fn(array $a, array $b): int => strcmp(serialize($a), serialize($b)));
            $state[$table] = $rows;
        }
        return $state;
    }

    private static function changeBackupId(array &$tables, string $table, mixed $id): void
    {
        $old = $tables[$table][0]['id'];
        $tables[$table][0]['id'] = $id;
        $references = match ($table) {
            'devices' => ['device_placements' => ['device_id'], 'links' => ['from_id', 'to_id'],
                'device_images' => ['device_id'], 'device_monitor_status' => ['device_id']],
            'views' => ['device_placements' => ['view_id'], 'links' => ['view_id'],
                'canvas_notes' => ['view_id'], 'view_floor_plans' => ['view_id']],
            'link_systems' => ['links' => ['system_id']],
            default => [],
        };
        foreach ($references as $referencingTable => $columns) {
            foreach ($tables[$referencingTable] as &$row) {
                foreach ($columns as $column) {
                    if (($row[$column] ?? null) === $old) {
                        $row[$column] = $id;
                    }
                }
            }
            unset($row);
        }
    }

    private function previewIdBackup(string $path, int $status = 200): array
    {
        return $this->client->postMultipart('/api.php?action=preview_backup_restore', [],
            ['backup_zip' => ['path' => $path, 'filename' => 'ids.zip', 'type' => 'application/zip']])
            ->assertStatus($status)->getJson();
    }

    private function commitIdBackup(array $preview, int $status = 200): void
    {
        $this->client->postJson('/api.php?action=commit_backup_restore', [
            'restore_token' => $preview['restore_token'], 'confirmation' => 'バックアップから復元',
        ])->assertStatus($status);
    }

    public function testRestoreRejectsUnsafePrimaryAndReferenceIdsWithoutDatabaseChanges(): void
    {
        $this->withIdBoundaryFixture(function (string $path, \PDO $db): void {
            $validPath = $path . '.valid.zip';
            copy($path, $validPath);
            $before = $this->idBoundaryState($db);
            $beforeLoad = $this->client->get('/api.php?action=load')->assertOk()->getJson();
            $dangerous = [self::API_ID_MAX, self::API_ID_MAX + 1, PHP_INT_MAX,
                '9007199254740991', '9007199254740992', '9223372036854775807',
                '9223372036854775808', '999999999999999999999999999999999999', 1.0e30, 1.5];
            foreach (['devices', 'views', 'device_placements', 'links', 'canvas_notes', 'link_systems', 'device_images'] as $table) {
                foreach ($dangerous as $id) {
                    copy($validPath, $path);
                    $this->rewriteBackupZip($path, static function (array &$document, array &$manifest) use ($table, $id): void {
                        self::changeBackupId($document['tables'], $table, $id);
                        $document['tables']['devices'][0]['memo'] = '拒否時に書き込まない';
                    });
                    $result = $this->previewIdBackup($path, 400);
                    $this->assertFalse(isset($result['restore_token']));
                    $this->assertSame($before, $this->idBoundaryState($db));
                    $this->assertSame($beforeLoad, $this->client->get('/api.php?action=load')->assertOk()->getJson());
                }
            }
            foreach (['device_placements' => ['device_id', 'view_id'], 'links' => ['from_id', 'to_id', 'view_id', 'system_id'],
                'canvas_notes' => ['view_id'], 'device_images' => ['device_id'],
                'device_monitor_status' => ['device_id'], 'view_floor_plans' => ['view_id']] as $table => $columns) {
                foreach ($columns as $column) {
                    copy($validPath, $path);
                    $this->rewriteBackupZip($path, static function (array &$document, array &$manifest) use ($table, $column): void {
                        $document['tables'][$table][0][$column] = self::API_ID_MAX;
                    });
                    $this->assertFalse(isset($this->previewIdBackup($path, 400)['restore_token']));
                    $this->assertSame($before, $this->idBoundaryState($db));
                }
            }
        });
    }

    public function testRestoreRejectsExhaustedCurrentCountersAndCurrentRowIds(): void
    {
        $this->withIdBoundaryFixture(function (string $path, \PDO $db): void {
            foreach (['devices', 'views', 'placements', 'links', 'canvas_notes', 'link_systems'] as $name) {
                $original = (int)$db->query("SELECT value FROM resource_sequences WHERE name = '{$name}'")->fetchColumn();
                foreach ([self::API_ID_MAX, self::API_ID_MAX + 1, PHP_INT_MAX] as $id) {
                    $db->exec("UPDATE resource_sequences SET value = {$id} WHERE name = '{$name}'");
                    $before = $this->idBoundaryState($db);
                    $this->assertFalse(isset($this->previewIdBackup($path, 400)['restore_token']));
                    $this->assertSame($before, $this->idBoundaryState($db));
                }
                $db->exec("UPDATE resource_sequences SET value = {$original} WHERE name = '{$name}'");
            }
            $originalImageSequence = (int)$db->query("SELECT seq FROM sqlite_sequence WHERE name = 'device_images'")->fetchColumn();
            foreach ([self::API_ID_MAX, self::API_ID_MAX + 1, PHP_INT_MAX] as $id) {
                $db->exec("UPDATE sqlite_sequence SET seq = {$id} WHERE name = 'device_images'");
                $before = $this->idBoundaryState($db);
                $this->assertFalse(isset($this->previewIdBackup($path, 400)['restore_token']));
                $this->assertSame($before, $this->idBoundaryState($db));
            }
            $db->exec("UPDATE sqlite_sequence SET seq = {$originalImageSequence} WHERE name = 'device_images'");
            // Updating a primary key does not run the INSERT counter trigger.
            foreach (['devices', 'views', 'device_placements', 'links', 'canvas_notes', 'link_systems', 'device_images'] as $table) {
                $db->exec('PRAGMA foreign_keys = OFF');
                $old = (int)$db->query("SELECT MIN(id) FROM {$table}")->fetchColumn();
                $db->exec("UPDATE {$table} SET id = " . self::API_ID_MAX . " WHERE id = {$old}");
                $before = $this->idBoundaryState($db);
                $this->assertFalse(isset($this->previewIdBackup($path, 400)['restore_token']));
                $this->assertSame($before, $this->idBoundaryState($db));
                $db->exec("UPDATE {$table} SET id = {$old} WHERE id = " . self::API_ID_MAX);
                $db->exec('PRAGMA foreign_keys = ON');
            }
        });
    }

    public function testRestoreCommitRechecksCountersWithoutBusinessRevisionChanges(): void
    {
        $this->withIdBoundaryFixture(function (string $path, \PDO $db, \Netarium\Tests\TestServer $server): void {
            foreach (['devices', 'views', 'placements', 'links', 'canvas_notes', 'link_systems', 'device_images'] as $name) {
                $preview = $this->previewIdBackup($path);
                $meta = $db->query('SELECT * FROM app_meta ORDER BY meta_key')->fetchAll(\PDO::FETCH_ASSOC);
                if ($name === 'device_images') {
                    $old = (int)$db->query("SELECT seq FROM sqlite_sequence WHERE name = 'device_images'")->fetchColumn();
                    $db->exec("UPDATE sqlite_sequence SET seq = " . self::API_ID_MAX . " WHERE name = 'device_images'");
                } else {
                    $old = (int)$db->query("SELECT value FROM resource_sequences WHERE name = '{$name}'")->fetchColumn();
                    $db->exec("UPDATE resource_sequences SET value = " . self::API_ID_MAX . " WHERE name = '{$name}'");
                }
                $this->assertSame($meta, $db->query('SELECT * FROM app_meta ORDER BY meta_key')->fetchAll(\PDO::FETCH_ASSOC));
                $before = $this->idBoundaryState($db);
                $this->commitIdBackup($preview, 400);
                $this->assertSame($before, $this->idBoundaryState($db));
                $this->expireRestorePreview($server, $preview);
                if ($name === 'device_images') {
                    $db->exec("UPDATE sqlite_sequence SET seq = {$old} WHERE name = 'device_images'");
                } else {
                    $db->exec("UPDATE resource_sequences SET value = {$old} WHERE name = '{$name}'");
                }
            }
        });
    }

    public function testRestoreCommitRejectsChangedSourceZip(): void
    {
        $this->withIdBoundaryFixture(function (string $path, \PDO $db, \Netarium\Tests\TestServer $server): void {
            $preview = $this->previewIdBackup($path);
            $uploadPath = $server->getTempDir() . '/temp/backup-restore/' . $preview['restore_token'] . '/upload.zip';
            $this->rewriteBackupZip($uploadPath, static function (array &$document): void {
                $document['tables']['devices'][0]['id'] = '9223372036854775808';
            });
            $before = $this->idBoundaryState($db);
            $this->commitIdBackup($preview, 400);
            $this->assertSame($before, $this->idBoundaryState($db));
        });
    }

    private function createIdBoundaryDevice(int $status = 200): array
    {
        return $this->client->postJson('/api.php?action=save_resources', [
            'devices' => [['operation' => 'create', 'id' => 800001,
                'device' => ['id' => 800001, 'name' => '復元後の機器', 'type' => 'switch', 'ip' => '']]],
            'views' => [],
        ])->assertStatus($status)->getJson();
    }

    public function testRestoreBoundaryAllowsLastDeviceIdButNeverReusesDeletedId(): void
    {
        $this->withIdBoundaryFixture(function (string $path, \PDO $db): void {
            $this->rewriteBackupZip($path, static function (array &$document, array &$manifest): void {
                foreach (['devices', 'views', 'device_placements', 'links', 'canvas_notes', 'link_systems', 'device_images'] as $table) {
                    self::changeBackupId($document['tables'], $table, self::RESTORE_ID_MAX);
                }
            });
            $this->commitIdBackup($this->previewIdBackup($path));
            foreach (['devices', 'views', 'device_placements', 'links', 'canvas_notes', 'link_systems', 'device_images'] as $table) {
                $this->assertSame(self::RESTORE_ID_MAX, (int)$db->query("SELECT MAX(id) FROM {$table}")->fetchColumn());
            }
            $this->createIdBoundaryDevice();
            $this->assertSame(self::API_ID_MAX, (int)$db->query('SELECT MAX(id) FROM devices')->fetchColumn());
            $data = $this->client->get('/api.php?action=load')->assertOk()->getJson();
            $device = array_column($data['devices'], null, 'id')[self::API_ID_MAX];
            $this->client->postJson('/api.php?action=save_resources', [
                'devices' => [['operation' => 'delete', 'id' => self::API_ID_MAX,
                    'expected_revision' => (int)$device['resource_revision']]], 'views' => [],
            ])->assertOk();
            $before = $this->idBoundaryState($db);
            $this->createIdBoundaryDevice(409);
            $this->assertSame($before, $this->idBoundaryState($db));
        });
    }

    public function testRestoreBoundaryPreservesLastAllocationAndNonReuseForEveryResourceKind(): void
    {
        foreach (['views', 'device_placements', 'links', 'canvas_notes', 'link_systems'] as $table) {
            $this->withIdBoundaryFixture(function (string $path, \PDO $db) use ($table): void {
                $this->rewriteBackupZip($path, static function (array &$document, array &$manifest) use ($table): void {
                    self::changeBackupId($document['tables'], $table, self::RESTORE_ID_MAX);
                });
                $this->commitIdBackup($this->previewIdBackup($path));
                if ($table === 'link_systems') {
                    $payload = ['name' => '最後の系統', 'color_key' => 'teal'];
                    $this->client->postJson('/api.php?action=create_link_system', $payload)->assertOk();
                    $this->assertSame(self::API_ID_MAX, (int)$db->query('SELECT MAX(id) FROM link_systems')->fetchColumn());
                    $revision = (int)$db->query('SELECT resource_revision FROM link_systems WHERE id = ' . self::API_ID_MAX)->fetchColumn();
                    $this->client->postJson('/api.php?action=delete_link_system', [
                        'id' => self::API_ID_MAX, 'expected_revision' => $revision,
                    ])->assertOk();
                    $before = $this->idBoundaryState($db);
                    $this->client->postJson('/api.php?action=create_link_system', $payload)->assertStatus(409);
                    $this->assertSame($before, $this->idBoundaryState($db));
                    return;
                }
                $data = $this->client->get('/api.php?action=load')->assertOk()->getJson();
                $operation = [
                    'operation' => 'create', 'id' => 800002,
                    'view' => ['id' => 800002, 'name' => '最後の採番ビュー', 'view_type' => 'topology'],
                    'placements' => [], 'links' => [], 'canvas_notes' => [],
                ];
                if ($table === 'device_placements') {
                    $operation['placements'][] = [
                        'id' => 800003, 'view_id' => 800002, 'device_id' => $data['devices'][0]['id'],
                        'x' => 0, 'y' => 0,
                    ];
                } elseif ($table === 'links') {
                    $link = $data['links'][0];
                    $link['id'] = 800004;
                    $link['view_id'] = 800002;
                    $operation['links'][] = $link;
                    foreach ([$link['from_id'], $link['to_id']] as $index => $deviceId) {
                        $operation['placements'][] = [
                            'id' => 800005 + $index, 'view_id' => 800002, 'device_id' => $deviceId,
                            'x' => $index * 100, 'y' => 0,
                        ];
                    }
                } elseif ($table === 'canvas_notes') {
                    $operation['canvas_notes'][] = [
                        'id' => 800007, 'view_id' => 800002, 'text' => '最後の採番メモ',
                    ];
                }
                $payload = ['devices' => [], 'views' => [$operation]];
                $saved = $this->client->postJson('/api.php?action=save_resources', $payload)->assertOk()->getJson();
                $this->assertSame(self::API_ID_MAX, (int)$db->query("SELECT MAX(id) FROM {$table}")->fetchColumn());
                $view = $saved['views'][0];
                $this->client->postJson('/api.php?action=save_resources', [
                    'devices' => [], 'views' => [[
                        'operation' => 'delete', 'id' => (int)$view['id'],
                        'expected_revision' => (int)$view['resource_revision'],
                    ]],
                ])->assertOk();
                $before = $this->idBoundaryState($db);
                $this->client->postJson('/api.php?action=save_resources', $payload)->assertStatus(409);
                $this->assertSame($before, $this->idBoundaryState($db));
            });
        }
    }

    public function testRestorePreservesHigherPreexistingIdCounters(): void
    {
        $this->withIdBoundaryFixture(function (string $path, \PDO $db): void {
            foreach (['devices', 'views', 'placements', 'links', 'canvas_notes', 'link_systems'] as $name) {
                $db->exec("UPDATE resource_sequences SET value = 700000 WHERE name = '{$name}'");
            }
            $db->exec("UPDATE sqlite_sequence SET seq = 700000 WHERE name = 'device_images'");
            $this->commitIdBackup($this->previewIdBackup($path));
            foreach (['devices', 'views', 'placements', 'links', 'canvas_notes', 'link_systems'] as $name) {
                $this->assertSame(700000, (int)$db->query("SELECT value FROM resource_sequences WHERE name = '{$name}'")->fetchColumn());
            }
            $this->assertSame(700000, (int)$db->query("SELECT seq FROM sqlite_sequence WHERE name = 'device_images'")->fetchColumn());
            $this->createIdBoundaryDevice();
            $this->assertSame(700001, (int)$db->query('SELECT MAX(id) FROM devices')->fetchColumn());
            $data = $this->client->get('/api.php?action=load')->assertOk()->getJson();
            $link = $data['links'][0];
            $link['id'] = 810003;
            $link['view_id'] = 810001;
            $placements = [];
            foreach ([$link['from_id'], $link['to_id']] as $index => $deviceId) {
                $placements[] = ['id' => 810004 + $index, 'view_id' => 810001,
                    'device_id' => $deviceId, 'x' => $index * 100, 'y' => 0];
            }
            $this->client->postJson('/api.php?action=save_resources', [
                'devices' => [], 'views' => [[
                    'operation' => 'create', 'id' => 810001,
                    'view' => ['id' => 810001, 'name' => '保持カウンターの採番', 'view_type' => 'topology'],
                    'placements' => $placements, 'links' => [$link],
                    'canvas_notes' => [['id' => 810002, 'view_id' => 810001, 'text' => '保持カウンター']],
                ]],
            ])->assertOk();
            $this->client->postJson('/api.php?action=create_link_system', [
                'name' => '保持カウンターの系統', 'color_key' => 'teal',
            ])->assertOk();
            foreach (['views', 'device_placements', 'links', 'canvas_notes', 'link_systems'] as $table) {
                $this->assertTrue((int)$db->query("SELECT MAX(id) FROM {$table}")->fetchColumn() > 700000);
            }
        });
    }

    public function testRestorePreservesInitialSetupStateWithoutExportingIt(): void
    {
        $server = new \Netarium\Tests\TestServer();
        try {
            $server->start();
            $db = \Netarium\Core\Database::connect($server->getDbPath());
            $meta = new \Netarium\Repositories\AppMetaRepository($db);
            $setup = \Netarium\Services\Auth\InitialSetup::class;
            $digest = hash('sha256', bin2hex(random_bytes(32)));
            $meta->set($setup::SECRET_KEY, $digest);
            $meta->set($setup::COMPLETED_KEY, '0');
            $client = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($client->login('admin', 'admin123'));
            $path = $server->getTempDir() . '/setup-state-backup.zip';
            file_put_contents($path, $client->postJson('/api.php?action=export_backup_zip', [])->assertStatus(200)->getBody());
            $zip = new ZipArchive();
            $this->assertTrue($zip->open($path) === true);
            try {
                $document = json_decode((string)$zip->getFromName('data/netarium.json'), true, 512, JSON_THROW_ON_ERROR);
                $keys = array_column($document['tables']['app_meta'], 'meta_key');
                $this->assertFalse(in_array($setup::SECRET_KEY, $keys, true));
                $this->assertFalse(in_array($setup::COMPLETED_KEY, $keys, true));
            } finally {
                $zip->close();
            }
            // ZIP取得時ではなく、復元時の認証状態を保持する。
            $meta->set($setup::COMPLETED_KEY, '1');
            $preview = $client->postMultipart('/api.php?action=preview_backup_restore', [],
                ['backup_zip' => ['path' => $path, 'filename' => 'backup.zip', 'type' => 'application/zip']])->assertOk()->getJson();
            $client->postJson('/api.php?action=commit_backup_restore', [
                'restore_token' => $preview['restore_token'], 'confirmation' => 'バックアップから復元',
            ])->assertOk();
            $this->assertSame($digest, $meta->get($setup::SECRET_KEY));
            $this->assertSame('1', $meta->get($setup::COMPLETED_KEY));
            $db->exec('DELETE FROM users');
            $anonymous = new TestHttpClient($server->getBaseUrl());
            $anonymous->get('/setup.php')->assertStatus(302);
            $anonymous->get('/login.php')->assertStatus(200);
            $this->assertTrue($setup::isClosed($db));
        } finally {
            $server->stop();
        }
    }







    public function testExportBackupZip(): string
    {
        $res = $this->client->postJson('/api.php?action=export_backup_zip', []);
        $res->assertStatus(200);

        $contentType = $res->getHeader('Content-Type');
        $this->assertNotNull($contentType);
        $this->assertStringContains('application/zip', $contentType);

        $disposition = $res->getHeader('Content-Disposition');
        $this->assertNotNull($disposition);
        $this->assertStringContains('.zip', $disposition);

        $body = $res->getBody();
        $this->assertTrue(strlen($body) > 100, 'ZIP body should not be empty');

        // Verify ZIP contents using ZipArchive
        $tempZip = tempnam(sys_get_temp_dir(), 'net_zip_');
        file_put_contents($tempZip, $body);

        $zip = new ZipArchive();
        $openResult = $zip->open($tempZip);
        $this->assertTrue($openResult === true, 'Downloaded content should be a valid ZIP archive');

        $hasMeta = false;
        $hasManifest = false;
        $manifestData = null;
        for ($i = 0; $i < $zip->numFiles; $i++) {
            $filename = $zip->getNameIndex($i);
            if ($filename === 'data/netarium.json') {
                $hasMeta = true;
            }
            if ($filename === 'manifest.json') {
                $hasManifest = true;
                $manifestData = json_decode((string)$zip->getFromIndex($i), true);
            }
        }
        $zip->close();
        $this->assertTrue($hasMeta, 'ZIP archive must contain data/netarium.json');
        $this->assertTrue($hasManifest, 'ZIP archive must contain manifest.json');
        $this->assertNotNull($manifestData);
        $this->assertSame('netarium-config', $manifestData['format']);
        $this->assertSame(APP_DATABASE_SCHEMA_VERSION, (int)($manifestData['schema_version'] ?? 0));
        $this->assertArrayHasKey('device_images', $manifestData['summary'] ?? []);
        $this->assertArrayHasKey('canvas_notes', $manifestData['summary'] ?? []);
        $this->assertArrayHasKey('link_systems', $manifestData['summary'] ?? []);
        return $tempZip;
    }

    public function testRestoreFlow(): void
    {
        $this->withIdBoundaryFixture(function (string $path, \PDO $db, \Netarium\Tests\TestServer $server): void {
            $before = $this->idBoundaryState($db);
            $users = $db->query('SELECT * FROM users ORDER BY id')->fetchAll(\PDO::FETCH_ASSOC);
            $imageFiles = $this->restoreFiles($server->getTempDir() . '/uploads');
            $db->exec("UPDATE devices SET name = '復元前の変更' WHERE id = 1");
            $db->exec('UPDATE view_floor_plans SET x = 77, opacity = 0.3');
            $preview = $this->previewIdBackup($path);
            $this->assertSame(2, $preview['image_resolution']['matched']);
            $this->commitIdBackup($preview);
            // 再ログインしなくても現在の認証状態を保持する。
            $this->client->get('/api.php?action=load')->assertOk();
            $after = $this->idBoundaryState($db);
            foreach (['view_floor_plans', 'device_images', 'device_monitor_status', 'device_placements', 'links', 'canvas_notes'] as $table) {
                $this->assertSame($before[$table], $after[$table]);
            }
            $this->assertSame($before['devices'][0]['name'], $after['devices'][0]['name']);
            $this->assertSame($users, $db->query('SELECT * FROM users ORDER BY id')->fetchAll(\PDO::FETCH_ASSOC));
            $this->assertSame($imageFiles, $this->restoreFiles($server->getTempDir() . '/uploads'));
            $this->assertSame([], $db->query('PRAGMA foreign_key_check')->fetchAll());
            $this->assertSame([], $db->query('SELECT * FROM device_image_gc')->fetchAll());
        });
    }


    public function testManualRouteBackupRoundTrip(): void
    {
        $before = $this->client->get('/api.php?action=load')->assertOk()->getJson();
        $links = $before['links'];
        // 重複と同一直線の点を含む最大8点を、そのまま保存・復元する。
        $route = [
            ['x' => -200000, 'y' => 10], ['x' => -200000, 'y' => 10],
            ['x' => -200000, 'y' => 20], ['x' => -200000, 'y' => 30],
            ['x' => 40.5, 'y' => 30], ['x' => 50.5, 'y' => 30],
            ['x' => 50.5, 'y' => 60], ['x' => 200000, 'y' => 60],
        ];
        $links[0]['route_mode'] = 'manual';
        $links[0]['manual_route'] = $route;
        $saved = $this->saveBackupLinks($before, $links);
        $this->assertSame($route, $saved['links'][0]['manual_route']);
        $zipPath = $this->testExportBackupZip();
        try {
            $zip = new ZipArchive();
            $this->assertTrue($zip->open($zipPath) === true);
            $document = json_decode((string)$zip->getFromName('data/netarium.json'), true);
            $zip->close();
            $this->assertSame('manual', $document['tables']['links'][0]['route_mode']);
            $this->assertSame($route, $document['tables']['links'][0]['manual_route']);
            $changedLinks = $saved['links'];
            $changedLinks[0]['manual_route'][0]['x'] = -300000;
            $changedLinks[0]['manual_route'][1]['x'] = -300000;
            // 第2→第3点も直交を維持する。
            $changedLinks[0]['manual_route'][2]['x'] = -300000;
            $changedLinks[0]['manual_route'][3]['x'] = -300000;
            $changed = $this->saveBackupLinks($saved, $changedLinks);
            $this->assertSame($changedLinks[0]['manual_route'], $changed['links'][0]['manual_route']);
            $preview = $this->client->postMultipart('/api.php?action=preview_backup_restore', [],
                ['backup_zip' => ['path' => $zipPath, 'filename' => 'manual.zip', 'type' => 'application/zip']])->assertOk()->getJson();
            $this->client->postJson('/api.php?action=commit_backup_restore', [
                'restore_token' => $preview['restore_token'], 'confirmation' => 'バックアップから復元',
            ])->assertOk();
            $restored = $this->client->get('/api.php?action=load')->assertOk()->getJson();
            $this->assertSame($links, $restored['links']);
        } finally {
            @unlink($zipPath);
            $current = $this->client->get('/api.php?action=load')->assertOk()->getJson();
            $this->saveBackupLinks($current, $before['links']);
        }
    }


    public function testBackupRejectsInvalidRoutesAndVersionPairs(): void
    {
        $before = $this->client->get('/api.php?action=load')->assertOk()->getJson();
        $validZip = $this->testExportBackupZip();
        $cases = [
            ['route_mode' => 'invalid', 'manual_route' => []],
            ['route_mode' => null, 'manual_route' => []],
            ['route_mode' => 'manual', 'manual_route' => null],
            ['route_mode' => 'manual', 'manual_route' => '[]'],
            ['route_mode' => 'manual', 'manual_route' => (object)[]],
            ['route_mode' => 'auto', 'manual_route' => (object)[]],
            ['route_mode' => 'manual', 'manual_route' => (object)['0' => ['x' => 1, 'y' => 2]]],
            ['route_mode' => 'manual', 'manual_route' => (object)['point' => ['x' => 1, 'y' => 2]]],
            ['route_mode' => 'auto', 'manual_route' => [['x' => 1, 'y' => 2]]],
            ['route_mode' => 'manual', 'manual_route' => [['x' => '1', 'y' => 2]]],
            ['route_mode' => 'manual', 'manual_route' => [['x' => true, 'y' => 2]]],
            ['route_mode' => 'manual', 'manual_route' => [['x' => '__NONFINITE__', 'y' => 2]]],
            ['route_mode' => 'manual', 'manual_route' => [['x' => 1]]],
            ['route_mode' => 'manual', 'manual_route' => [['x' => 1, 'y' => 2, 'extra' => 3]]],
            ['route_mode' => 'manual', 'manual_route' => [['x' => 1, 'y' => 2], ['x' => 3, 'y' => 4]]],
            ['route_mode' => 'manual', 'manual_route' => array_fill(0, 9, ['x' => 1, 'y' => 2])],
            ['extra' => 'unknown'],
            ['remove' => 'route_mode'],
            ['remove' => 'manual_route'],
        ];
        try {
            foreach ($cases as $case) {
                $path = tempnam(sys_get_temp_dir(), 'net_route_invalid_');
                try {
                    copy($validZip, $path);
                    $this->rewriteBackupZip($path, static function (array &$document, array &$manifest) use ($case): void {
                        if (isset($case['remove'])) {
                            unset($document['tables']['links'][0][$case['remove']]);
                        } else {
                            $document['tables']['links'][0] = array_replace($document['tables']['links'][0], $case);
                        }
                    }, static fn(string $json): string => str_replace('"__NONFINITE__"', '1e309', $json));
                    $this->client->postMultipart('/api.php?action=preview_backup_restore', [],
                        ['backup_zip' => ['path' => $path, 'filename' => 'invalid-route.zip', 'type' => 'application/zip']])->assertStatus(400);
                } finally {
                    @unlink($path);
                }
            }
            $after = $this->client->get('/api.php?action=load')->assertOk()->getJson();
            $this->assertSame($before['revision'], $after['revision']);
            $this->assertSame($before['links'], $after['links']);
        } finally {
            @unlink($validZip);
        }
    }


    public function testRestorePreviewRejectsChangedCurrentData(): void
    {
        $this->withStringBoundaryFixture(function (): void {
            $this->assertRestorePreviewRejectsChangedCurrentData();
        });
    }

    private function assertRestorePreviewRejectsChangedCurrentData(): void
    {
        $zipPath = $this->testExportBackupZip();

        try {
            $baseline = $this->client->get('/api.php?action=load');
            $baseline->assertOk();
            $baselineData = $baseline->getJson();
            $devices = $baselineData['devices'];
            $devices[0]['name'] = 'プレビュー後変更前';

            $changed = $this->client->postJson('/api.php?action=save', [
                'revision' => (int)$baselineData['revision'],
                'views' => $baselineData['views'],
                'devices' => $devices,
                'placements' => $baselineData['placements'],
                'links' => $baselineData['links'],
                'canvas_notes' => $baselineData['canvas_notes'],
            ]);
            $changed->assertOk();

            $preview = $this->client->postMultipart(
                '/api.php?action=preview_backup_restore',
                [],
                ['backup_zip' => ['path' => $zipPath, 'filename' => 'preview.zip', 'type' => 'application/zip']]
            );
            $preview->assertOk();
            $previewJson = $preview->getJson();

            $current = $this->client->get('/api.php?action=load');
            $current->assertOk();
            $currentData = $current->getJson();
            $devices = $currentData['devices'];
            $devices[0]['name'] = 'プレビュー後変更';

            $changedAfterPreview = $this->client->postJson('/api.php?action=save', [
                'revision' => (int)$currentData['revision'],
                'views' => $currentData['views'],
                'devices' => $devices,
                'placements' => $currentData['placements'],
                'links' => $currentData['links'],
                'canvas_notes' => $currentData['canvas_notes'],
            ]);
            $changedAfterPreview->assertOk();

            $commit = $this->client->postJson('/api.php?action=commit_backup_restore', [
                'restore_token' => (string)$previewJson['restore_token'],
                'confirmation' => 'バックアップから復元',
            ]);
            $commit->assertError(409, '再度プレビューしてください');

            // 変更後の現行世代を基準に再プレビューすれば復元できる。
            $freshPreview = $this->client->postMultipart(
                '/api.php?action=preview_backup_restore',
                [],
                ['backup_zip' => ['path' => $zipPath, 'filename' => 'preview-again.zip', 'type' => 'application/zip']]
            );
            $freshPreview->assertOk();
            $freshPreviewJson = $freshPreview->getJson();

            $freshCommit = $this->client->postJson('/api.php?action=commit_backup_restore', [
                'restore_token' => (string)$freshPreviewJson['restore_token'],
                'confirmation' => 'バックアップから復元',
            ]);
            $freshCommit->assertOk();
            $this->assertTrue($freshCommit->getJson()['post_processing_required'] === false);
            $this->client->get('/api.php?action=load')->assertOk();
        } finally {
            @unlink($zipPath);
        }
    }

    public function testRestorePreviewRejectsLaterLinkSystemChanges(): void
    {
        $this->withStringBoundaryFixture(function (string $path, \PDO $db, \Netarium\Tests\TestServer $server): void {
            $this->assertRestorePreviewRejectsLaterLinkSystemChanges($server);
        });
    }

    private function assertRestorePreviewRejectsLaterLinkSystemChanges(\Netarium\Tests\TestServer $server): void
    {
        $system = null;
        foreach (['create', 'update', 'delete'] as $operation) {
            $zipPath = $this->testExportBackupZip();
            try {
                $preview = $this->client->postMultipart('/api.php?action=preview_backup_restore', [],
                    ['backup_zip' => ['path' => $zipPath, 'filename' => 'systems-preview.zip', 'type' => 'application/zip']]
                )->assertOk()->getJson();
                $before = $this->client->get('/api.php?action=load')->assertOk()->getJson();
                $input = $system ? ['id' => (int)$system['id'], 'expected_revision' => (int)$system['resource_revision']] : [];
                if ($operation !== 'delete') {
                    $input += ['name' => '復元保護の合成系統', 'color_key' => $operation === 'create' ? 'teal' : 'violet'];
                }
                $result = $this->client->postJson('/api.php?action=' . $operation . '_link_system', $input)->assertOk()->getJson();
                if ($operation !== 'delete') {
                    foreach ($result['link_systems'] as $row) {
                        if ($row['name'] === '復元保護の合成系統') $system = $row;
                    }
                }
                $after = $this->client->get('/api.php?action=load')->assertOk()->getJson();
                $this->assertSame($before['views'], $after['views']);
                $this->client->postJson('/api.php?action=commit_backup_restore', [
                    'restore_token' => $preview['restore_token'], 'confirmation' => 'バックアップから復元',
                ])->assertStatus(409);
                $this->assertSame($after, $this->client->get('/api.php?action=load')->assertOk()->getJson());
                $this->expireRestorePreview($server, $preview);
            } finally {
                @unlink($zipPath);
            }
        }
    }

    public function testTamperedBackupRejected(): void
    {
        $validZip = $this->testExportBackupZip();
        $tempTamperedZip = tempnam(sys_get_temp_dir(), 'net_tampered_');
        $tempInjectedZip = tempnam(sys_get_temp_dir(), 'net_injected_');

        try {
            // 1. data/netarium.json を改ざんしたZIP
            copy($validZip, $tempTamperedZip);
            $zip = new ZipArchive();
            $zip->open($tempTamperedZip);
            $zip->addFromString('data/netarium.json', '{"tampered":true}');
            $zip->close();

            $res = $this->client->postMultipart(
                '/api.php?action=preview_backup_restore',
                [],
                ['backup_zip' => ['path' => $tempTamperedZip, 'filename' => 'tampered.zip', 'type' => 'application/zip']]
            );
            $res->assertStatus(400);
            $this->assertStringContains('整合性検証に失敗しました', $res->getJson()['error']);

            // 2. manifest に未登録の図面ファイルを混入させたZIP
            copy($validZip, $tempInjectedZip);
            $zip2 = new ZipArchive();
            $zip2->open($tempInjectedZip);
            $zip2->addFromString('floorplans/view-999.png', 'fake_png_data');
            $zip2->close();

            $res2 = $this->client->postMultipart(
                '/api.php?action=preview_backup_restore',
                [],
                ['backup_zip' => ['path' => $tempInjectedZip, 'filename' => 'injected.zip', 'type' => 'application/zip']]
            );
            $res2->assertStatus(400);
        } finally {
            @unlink($validZip);
            @unlink($tempTamperedZip);
            @unlink($tempInjectedZip);
        }
    }

    public function testBackupRestoreValidation(): void
    {
        // 有効な境界プレビューを残す試験は、後続試験の保持枠を消費しないよう隔離する。
        $this->withStringBoundaryFixture(function (): void {
            $this->assertBackupRestoreValidation();
        });
    }

    private function assertBackupRestoreValidation(): void
    {
        $loadRes = $this->client->get('/api.php?action=load');
        $loadRes->assertOk();
        $currentRevision = (int)$loadRes->getJson()['revision'];
        $viewId = 2;
        $tempPng = tempnam(sys_get_temp_dir(), 'net_fp_validation_');
        $validZip = null;
        $tempZips = [];
        $uploaded = false;
        $baselineRevision = null;

        $pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
        file_put_contents($tempPng, base64_decode($pngBase64));

        try {
            $uploadRes = $this->client->postMultipart(
                '/image_upload.php?action=upload_floor_plan',
                [
                    'view_id' => (string)$viewId,
                    'expected_revision' => (string)$this->viewRevision($viewId),
                ],
                [
                    'floor_plan' => [
                        'path' => $tempPng,
                        'filename' => 'validation_test_plan.png',
                        'type' => 'image/png',
                    ],
                ]
            );
            $uploadRes->assertOk();
            $uploaded = true;

            $baselineLoadRes = $this->client->get('/api.php?action=load');
            $baselineLoadRes->assertOk();
            $baselineData = $baselineLoadRes->getJson();
            $baselineRevision = (int)$baselineData['revision'];
            $baselineFloorPlans = $baselineData['floor_plans'];

            $baselineImageRes = $this->client->get("/floor_plan.php?view_id={$viewId}");
            $baselineImageRes->assertStatus(200);
            $baselineImageBytes = $baselineImageRes->getBody();

            $validZip = $this->testExportBackupZip();

            $cases = [
                [
                    'values' => ['scale' => 0],
                    'status' => 400,
                ],
                [
                    'values' => ['opacity' => 2.0],
                    'status' => 400,
                ],
                [
                    'values' => ['x' => 200000],
                    'status' => 400,
                ],
                [
                    'values' => ['is_visible' => 2],
                    'status' => 400,
                ],
                [
                    'values' => [
                        'x' => -100000,
                        'y' => -100000,
                        'scale' => 0.05,
                        'opacity' => 0.1,
                        'is_visible' => 0,
                    ],
                    'status' => 200,
                ],
                [
                    'values' => [
                        'x' => 100000,
                        'y' => 100000,
                        'scale' => 2.0,
                        'opacity' => 1.0,
                        'is_visible' => 1,
                    ],
                    'status' => 200,
                ],
            ];

            foreach ($cases as $case) {
                $tempZip = tempnam(sys_get_temp_dir(), 'net_validation_');
                $tempZips[] = $tempZip;
                copy($validZip, $tempZip);

                $this->rewriteBackupZip($tempZip, static function (array &$document, array &$manifest) use ($case): void {
                    foreach ($case['values'] as $field => $value) {
                        $document['tables']['view_floor_plans'][0][$field] = $value;
                    }
                });

                $res = $this->client->postMultipart(
                    '/api.php?action=preview_backup_restore',
                    [],
                    ['backup_zip' => ['path' => $tempZip, 'filename' => 'validation.zip', 'type' => 'application/zip']]
                );

                if ($case['status'] === 200) {
                    $res->assertOk();
                } else {
                    $res->assertStatus(400);
                }
            }

            $afterLoadRes = $this->client->get('/api.php?action=load');
            $afterLoadRes->assertOk();
            $afterData = $afterLoadRes->getJson();
            $this->assertSame($baselineRevision, (int)$afterData['revision']);
            $this->assertSame($baselineFloorPlans, $afterData['floor_plans']);

            $afterImageRes = $this->client->get("/floor_plan.php?view_id={$viewId}");
            $afterImageRes->assertStatus(200);
            $this->assertSame($baselineImageBytes, $afterImageRes->getBody());
        } finally {
            if ($uploaded && $baselineRevision !== null) {
                $deleteRes = $this->client->postJson('/api.php?action=delete_floor_plan', [
                    'view_id' => $viewId,
                    'expected_revision' => $this->viewRevision($viewId),
                ]);
                $deleteRes->assertOk();
            }

            @unlink($tempPng);

            if ($validZip !== null) {
                @unlink($validZip);
            }

            foreach ($tempZips as $file) {
                @unlink($file);
            }
        }
    }
    public function testCanvasNoteBackupRoundTrip(): void
    {
        $before = $this->client->get('/api.php?action=load')->assertOk()->getJson();
        $data = $before;
        $this->assertTrue(count($data['links']) > 0);
        $data['links'][0]['route_mode'] = 'manual';
        $data['links'][0]['manual_route'] = [['x' => 11, 'y' => 22], ['x' => 33, 'y' => 22]];
        $viewId = (int)$data['views'][0]['id'];
        $data['canvas_notes'][] = [
            'id' => 940001, 'view_id' => $viewId, 'text' => " 先頭\n末尾 <b>本文</b> ",
            'x' => 0, 'y' => 123.5, 'width' => 120, 'height' => 2000,
            'background_color' => '#123ABC', 'background_opacity' => 0.2,
            'text_color' => '#ABC123', 'font_size' => 12,
        ];
        $saved = $this->client->postJson('/api.php?action=save', $data)->assertOk()->getJson();
        $noteId = (int)$saved['id_maps']['canvas_notes'][940001];
        $zipPath = $this->testExportBackupZip();
        try {
            $zip = new ZipArchive();
            $this->assertTrue($zip->open($zipPath) === true);
            $document = json_decode((string)$zip->getFromName('data/netarium.json'), true);
            $manifest = json_decode((string)$zip->getFromName('manifest.json'), true);
            $zip->close();
            $this->assertSame(json_encode($saved['canvas_notes']), json_encode($document['tables']['canvas_notes']));
            $this->assertSame(count($saved['canvas_notes']), (int)$manifest['summary']['canvas_notes']);
            $changed = $this->client->get('/api.php?action=load')->assertOk()->getJson();
            $changed['canvas_notes'] = [];
            $changed['canvas_notes'][] = ['id' => 940002, 'view_id' => $viewId, 'text' => '復元で消すメモ'];
            $changed = $this->client->postJson('/api.php?action=save', $changed)->assertOk()->getJson();
            $highId = (int)$changed['id_maps']['canvas_notes'][940002];
            $preview = $this->client->postMultipart('/api.php?action=preview_backup_restore', [],
                ['backup_zip' => ['path' => $zipPath, 'filename' => 'notes.zip', 'type' => 'application/zip']])->assertOk()->getJson();
            $this->assertSame(count($saved['canvas_notes']), (int)$preview['backup']['counts']['canvas_notes']);
            $this->client->postJson('/api.php?action=commit_backup_restore', [
                'restore_token' => $preview['restore_token'], 'confirmation' => 'バックアップから復元',
            ])->assertOk();
            $restored = $this->client->get('/api.php?action=load')->assertOk()->getJson();
            $this->assertSame($saved['canvas_notes'], $restored['canvas_notes']);
            $this->assertSame($noteId, (int)$restored['canvas_notes'][count($restored['canvas_notes']) - 1]['id']);
            $staleView = array_values(array_filter($changed['views'], static fn($v) => (int)$v['id'] === $viewId))[0];
            $this->client->postJson('/api.php?action=save_resources', ['devices' => [], 'views' => [[
                'operation' => 'update', 'id' => $viewId, 'expected_revision' => (int)$staleView['resource_revision'],
                'view' => $staleView, 'placements' => [], 'links' => [], 'canvas_notes' => [],
            ]]])->assertStatus(409);
            $restored['canvas_notes'][] = ['id' => 940003, 'view_id' => $viewId, 'text' => '復元後の新規メモ'];
            $next = $this->client->postJson('/api.php?action=save', $restored)->assertOk()->getJson();
            $this->assertTrue((int)$next['id_maps']['canvas_notes'][940003] > $highId);
        } finally {
            @unlink($zipPath);
            $current = $this->client->get('/api.php?action=load')->assertOk()->getJson();
            $current['canvas_notes'] = $before['canvas_notes'];
            $current['links'] = $before['links'];
            $this->client->postJson('/api.php?action=save', $current)->assertOk();
        }
    }

    public function testBackupRejectsInvalidCanvasNoteData(): void
    {
        $before = $this->client->get('/api.php?action=load')->assertOk()->getJson();
        $validZip = $this->testExportBackupZip();
        $note = ['id' => 950001, 'view_id' => (int)$before['views'][0]['id'], 'text' => '検証メモ',
            'x' => 0, 'y' => 0, 'width' => 220, 'height' => 120, 'background_color' => '#FFF3B0',
            'background_opacity' => 0.85, 'text_color' => '#263238', 'font_size' => 14];
        $cases = [
            ['x' => -1], ['y' => '__NONFINITE__'], ['x' => '12'], ['x' => true],
            ['width' => 119], ['width' => 2001], ['height' => 59], ['height' => 2001],
            ['background_color' => '#fff'], ['text_color' => 'red'],
            ['background_opacity' => 0.1], ['background_opacity' => 1.1],
            ['font_size' => 11], ['font_size' => 33], ['text' => str_repeat('あ', 1001)],
            ['view_id' => 999999], ['extra' => '未知列'], ['remove' => 'text'],
        ];
        try {
            foreach ($cases as $case) {
                $path = tempnam(sys_get_temp_dir(), 'net_note_invalid_');
                try {
                    copy($validZip, $path);
                    $this->rewriteBackupZip($path, static function (array &$document, array &$manifest) use ($note, $case): void {
                        $row = array_replace($note, $case);
                        if (isset($case['remove'])) {
                            unset($row['remove'], $row[$case['remove']]);
                        }
                        $document['tables']['canvas_notes'] = [$row];
                    }, static fn(string $json): string => str_replace('"__NONFINITE__"', '1e309', $json));
                    $this->client->postMultipart('/api.php?action=preview_backup_restore', [],
                        ['backup_zip' => ['path' => $path, 'filename' => 'invalid-note.zip', 'type' => 'application/zip']])->assertStatus(400);
                } finally {
                    @unlink($path);
                }
            }
            foreach (['missing', 'duplicate', 'object'] as $case) {
                $path = tempnam(sys_get_temp_dir(), 'net_note_structure_');
                try {
                    copy($validZip, $path);
                    $this->rewriteBackupZip($path, static function (array &$document, array &$manifest) use ($case, $note): void {
                        if ($case === 'missing') {
                            unset($document['tables']['canvas_notes']);
                        } elseif ($case === 'duplicate') {
                            $document['tables']['canvas_notes'] = [$note, $note];
                        } elseif ($case === 'object') {
                            $document['tables']['canvas_notes'] = (object)[];
                        }
                    });
                    $this->client->postMultipart('/api.php?action=preview_backup_restore', [],
                        ['backup_zip' => ['path' => $path, 'filename' => 'invalid-structure.zip', 'type' => 'application/zip']])->assertStatus(400);
                } finally {
                    @unlink($path);
                }
            }
            $after = $this->client->get('/api.php?action=load')->assertOk()->getJson();
            $this->assertSame($before['canvas_notes'], $after['canvas_notes']);
            $this->assertSame((int)$before['revision'], (int)$after['revision']);
        } finally {
            @unlink($validZip);
        }
    }
    public function testLinkSystemBackupRoundTrip(): void
    {
        $before = $this->client->get('/api.php?action=load')->assertOk()->getJson();
        $created = $this->client->postJson('/api.php?action=create_link_system', [
            'name' => 'バックアップ対象の系統', 'color_key' => 'magenta',
        ])->assertOk()->getJson();
        $system = $created['link_systems'][count($created['link_systems']) - 1];
        $id = (int)$system['id'];
        $path = null;
        try {
            $data = $this->client->get('/api.php?action=load')->assertOk()->getJson();
            $data['links'][0]['system_id'] = $id;
            $saved = $this->saveBackupLinks($data, $data['links']);
            $path = $this->testExportBackupZip();
            $zip = new ZipArchive();
            $this->assertTrue($zip->open($path) === true);
            $document = json_decode((string)$zip->getFromName('data/netarium.json'), true);
            $zip->close();
            $this->assertSame($id, $document['tables']['links'][0]['system_id']);
            $this->assertSame('magenta', array_column($document['tables']['link_systems'], 'color_key', 'id')[$id]);
            $this->client->postJson('/api.php?action=update_link_system', [
                'id' => $id, 'expected_revision' => (int)$system['resource_revision'],
                'name' => '復元で戻す名称', 'color_key' => 'brown',
            ])->assertOk();
            $saved = $this->client->get('/api.php?action=load')->assertOk()->getJson();
            $saved['links'][0]['system_id'] = null;
            $preRestore = $this->saveBackupLinks($saved, $saved['links']);
            $preRestoreSystem = array_column($preRestore['link_systems'], null, 'id')[$id];
            $preview = $this->client->postMultipart('/api.php?action=preview_backup_restore', [],
                ['backup_zip' => ['path' => $path, 'filename' => 'systems6.zip', 'type' => 'application/zip']])->assertOk()->getJson();
            $this->assertTrue((int)$preview['backup']['counts']['link_systems'] > 0);
            $this->client->postJson('/api.php?action=commit_backup_restore', [
                'restore_token' => $preview['restore_token'], 'confirmation' => 'バックアップから復元',
            ])->assertOk();
            $restored = $this->client->get('/api.php?action=load')->assertOk()->getJson();
            $this->assertSame($id, (int)$restored['links'][0]['system_id']);
            $restoredSystem = array_column($restored['link_systems'], null, 'id')[$id];
            $this->assertSame($system['name'], $restoredSystem['name']);
            $this->assertSame('magenta', $restoredSystem['color_key']);
            $this->assertTrue((int)$restoredSystem['resource_revision'] > (int)$preRestoreSystem['resource_revision']);
            $this->client->postJson('/api.php?action=delete_link_system', [
                'id' => $id, 'expected_revision' => (int)$preRestoreSystem['resource_revision'],
            ])->assertStatus(409);
            $staleDevice = $preRestore['devices'][0];
            $staleDevice['memo'] = '復元前の画面から上書きしてはいけない';
            $this->client->postJson('/api.php?action=save_resources', [
                'devices' => [['operation' => 'update', 'id' => (int)$staleDevice['id'],
                    'expected_revision' => (int)$staleDevice['resource_revision'], 'device' => $staleDevice]],
                'views' => [],
            ])->assertStatus(409);
            $staleView = $preRestore['views'][0];
            $viewId = (int)$staleView['id'];
            $this->client->postJson('/api.php?action=save_resources', [
                'devices' => [],
                'views' => [['operation' => 'update', 'id' => $viewId,
                    'expected_revision' => (int)$staleView['resource_revision'], 'view' => $staleView,
                    'placements' => array_values(array_filter($preRestore['placements'], static fn($row) => (int)$row['view_id'] === $viewId)),
                    'links' => array_values(array_filter($preRestore['links'], static fn($row) => (int)$row['view_id'] === $viewId)),
                    'canvas_notes' => array_values(array_filter($preRestore['canvas_notes'], static fn($row) => (int)$row['view_id'] === $viewId))]],
            ])->assertStatus(409);
            $unchanged = $this->client->get('/api.php?action=load')->assertOk()->getJson();
            foreach (['revision', 'devices', 'views', 'placements', 'links', 'canvas_notes', 'link_systems'] as $key) {
                $this->assertSame($restored[$key], $unchanged[$key]);
            }
        } finally {
            if ($path !== null) {
                @unlink($path);
            }
            $current = $this->client->get('/api.php?action=load')->assertOk()->getJson();
            $this->saveBackupLinks($current, $before['links']);
            foreach ($current['link_systems'] as $remaining) {
                if ((int)$remaining['id'] === $id) {
                    $this->client->postJson('/api.php?action=delete_link_system', [
                        'id' => $id, 'expected_revision' => (int)$remaining['resource_revision'],
                    ])->assertOk();
                }
            }
        }
    }

    public function testBackupRejectsMalformedLinkSystemsAndUnknownAssignments(): void
    {
        $before = $this->client->get('/api.php?action=load')->assertOk()->getJson();
        $validPath = $this->testExportBackupZip();
        try {
            $validSystem = ['id' => 987654, 'name' => '検証系統', 'color_key' => 'indigo', 'resource_revision' => 1];
            foreach (['missing', 'duplicate', 'blank', 'long', 'color', 'revision', 'id', 'reference', 'string', 'zero'] as $case) {
                $path = tempnam(sys_get_temp_dir(), 'net_system_invalid_');
                try {
                    copy($validPath, $path);
                    $this->rewriteBackupZip($path, static function (array &$document, array &$manifest) use ($case, $validSystem): void {
                        $document['tables']['link_systems'] = [$validSystem];
                        if ($case === 'missing') {
                            unset($document['tables']['link_systems']);
                        } elseif ($case === 'duplicate') {
                            $document['tables']['link_systems'][] = $validSystem;
                        } elseif ($case === 'reference') {
                            $document['tables']['links'][0]['system_id'] = 987655;
                        } elseif ($case === 'string') {
                            $document['tables']['links'][0]['system_id'] = '987654';
                        } elseif ($case === 'zero') {
                            $document['tables']['links'][0]['system_id'] = 0;
                        } else {
                            $field = ['blank' => 'name', 'long' => 'name', 'color' => 'color_key', 'revision' => 'resource_revision', 'id' => 'id'][$case];
                            $document['tables']['link_systems'][0][$field] = ['blank' => '　 ', 'long' => str_repeat('系', 101), 'color' => 'red', 'revision' => 0, 'id' => '987654'][$case];
                        }
                    });
                    $this->client->postMultipart('/api.php?action=preview_backup_restore', [],
                        ['backup_zip' => ['path' => $path, 'filename' => 'invalid-system.zip', 'type' => 'application/zip']])->assertStatus(400);
                } finally {
                    @unlink($path);
                }
            }
            $this->assertSame($before, $this->client->get('/api.php?action=load')->assertOk()->getJson());
        } finally {
            @unlink($validPath);
        }
    }

    public function testConfigZipContainsOnlyMetadataAndRejectsOldFormat(): void
    {
        $this->withIdBoundaryFixture(function (string $path, \PDO $db): void {
            $zip = new ZipArchive();
            $zip->open($path);
            $names = [];
            for ($i = 0; $i < $zip->numFiles; $i++) {
                $names[] = $zip->getNameIndex($i);
            }
            sort($names);
            $this->assertSame(['data/netarium.json', 'manifest.json'], $names);
            $doc = json_decode($zip->getFromName('data/netarium.json'), true, 512, JSON_THROW_ON_ERROR);
            $this->assertArrayNotHasKey('users', $doc['tables']);
            $this->assertSame(64, strlen($doc['tables']['device_images'][0]['sha256']));
            $zip->close();
            $before = $this->idBoundaryState($db);
            $this->rewriteBackupZip($path, static function (array &$document, array &$manifest): void {
                $manifest['format'] = 'netarium-backup';
                unset($manifest['format_version']);
            });
            $this->previewIdBackup($path, 400);
            $this->assertSame($before, $this->idBoundaryState($db));
        });
    }

    public function testMissingAndMismatchedImagesNeverBindOrDeleteFiles(): void
    {
        foreach (['missing', 'size', 'digest', 'content', 'other-environment', 'empty-environment'] as $case) {
            $this->withIdBoundaryFixture(function (string $path, \PDO $db, \Netarium\Tests\TestServer $server) use ($case): void {
                $directory = $server->getTempDir() . '/uploads/device_images';
                $row = $db->query('SELECT * FROM device_images LIMIT 1')->fetch(\PDO::FETCH_ASSOC);
                $imagePath = $directory . '/' . $row['stored_name'];
                if (in_array($case, ['missing', 'other-environment', 'empty-environment'], true)) {
                    rename($imagePath, $imagePath . '.held');
                } elseif ($case === 'content') {
                    $bytes = (string)file_get_contents($imagePath);
                    $bytes[strlen($bytes) - 1] = chr(ord($bytes[strlen($bytes) - 1]) ^ 1);
                    file_put_contents($imagePath, $bytes);
                } else {
                    $this->rewriteBackupZip($path, static function (array &$document) use ($case): void {
                        if ($case === 'size') {
                            $document['tables']['device_images'][0]['file_size']++;
                        } else {
                            $document['tables']['device_images'][0]['sha256'] = str_repeat('0', 64);
                        }
                    });
                }
                if ($case === 'other-environment') {
                    // 同じ機器ID・画像IDでも、保存名の異なる別画像へは関連付けない。
                    $name = str_repeat('a', 32) . '.png';
                    copy($imagePath . '.held', $directory . '/' . $name);
                    $db->exec("UPDATE device_images SET stored_name = '$name'");
                }
                if ($case === 'empty-environment') {
                    $floorName = $db->query('SELECT stored_name FROM view_floor_plans LIMIT 1')->fetchColumn();
                    $floorPath = $server->getTempDir() . '/uploads/floorplans/' . $floorName;
                    rename($floorPath, $floorPath . '.held');
                }
                $files = $this->restoreFiles($server->getTempDir() . '/uploads');
                $users = $db->query('SELECT * FROM users ORDER BY id')->fetchAll(\PDO::FETCH_ASSOC);
                $preview = $this->previewIdBackup($path);
                $report = $preview['image_resolution'];
                $this->assertSame($case === 'empty-environment' ? 0 : 1, $report['matched']);
                $this->assertSame($case === 'empty-environment' ? 2 : 1, $report['missing'] + $report['mismatched']);
                $deviceIssues = array_values(array_filter($report['items'], static fn(array $item): bool => $item['kind'] === 'device_images'));
                $this->assertSame((int)$row['device_id'], $deviceIssues[0]['id']);
                $this->commitIdBackup($preview);
                $this->assertSame(0, (int)$db->query('SELECT COUNT(*) FROM device_images')->fetchColumn());
                if ($case === 'empty-environment') {
                    $this->assertSame(0, (int)$db->query('SELECT COUNT(*) FROM view_floor_plans')->fetchColumn());
                }
                $this->assertSame($files, $this->restoreFiles($server->getTempDir() . '/uploads'));
                $this->assertSame($users, $db->query('SELECT * FROM users ORDER BY id')->fetchAll(\PDO::FETCH_ASSOC));
                $this->client->get('/api.php?action=load')->assertOk();
            });
        }
    }

    public function testChangedImagesAfterPreviewRejectWithoutDatabaseMutation(): void
    {
        $this->withIdBoundaryFixture(function (string $path, \PDO $db, \Netarium\Tests\TestServer $server): void {
            $preview = $this->previewIdBackup($path);
            $name = $db->query('SELECT stored_name FROM view_floor_plans LIMIT 1')->fetchColumn();
            $imagePath = $server->getTempDir() . '/uploads/floorplans/' . $name;
            rename($imagePath, $imagePath . '.held');
            $before = $this->idBoundaryState($db);
            $files = $this->restoreFiles($server->getTempDir() . '/uploads');
            $this->commitIdBackup($preview, 409);
            $this->assertSame($before, $this->idBoundaryState($db));
            $this->assertSame($files, $this->restoreFiles($server->getTempDir() . '/uploads'));
        });
    }

    public function testFailedDatabaseReplacementPreservesImagesAndAuthentication(): void
    {
        $this->withIdBoundaryFixture(function (string $path, \PDO $db, \Netarium\Tests\TestServer $server): void {
            $preview = $this->previewIdBackup($path);
            $before = $this->idBoundaryState($db);
            $files = $this->restoreFiles($server->getTempDir() . '/uploads');
            $db->exec("CREATE TRIGGER reject_restore BEFORE INSERT ON links BEGIN SELECT RAISE(ABORT, 'restore failure'); END");
            $this->commitIdBackup($preview, 500);
            $this->assertSame($before, $this->idBoundaryState($db));
            $this->assertSame($files, $this->restoreFiles($server->getTempDir() . '/uploads'));
            $this->client->get('/api.php?action=load')->assertOk();
            $db->exec('DROP TRIGGER reject_restore');
            $this->commitIdBackup($preview);
        });
    }

    public function testRestoredImageSurvivesPreviouslyQueuedGarbageCollection(): void
    {
        $this->withIdBoundaryFixture(function (string $path, \PDO $db, \Netarium\Tests\TestServer $server): void {
            $row = $db->query('SELECT * FROM device_images LIMIT 1')->fetch(\PDO::FETCH_ASSOC);
            $db->prepare('INSERT INTO device_image_gc(stored_name, queued_at) VALUES(?,?)')->execute([$row['stored_name'], date(DATE_ATOM)]);
            $db->exec('DELETE FROM device_images');
            $preview = $this->previewIdBackup($path);
            $this->assertSame(2, $preview['image_resolution']['matched']);
            $this->commitIdBackup($preview);
            $directory = $server->getTempDir() . '/uploads/device_images';
            $files = $this->restoreFiles($directory);
            (new \Netarium\Services\DeviceImage\DeviceImageService($db))->processGcQueue([
                'device_image_directory' => $directory,
                'device_image_thumb_directory' => $directory . '/thumbs',
            ]);
            $this->assertSame([], $db->query('SELECT * FROM device_image_gc')->fetchAll());
            $this->assertSame($files, $this->restoreFiles($directory));
            $this->client->get('/device_image.php?image_id=' . $row['id'])->assertStatus(200);
        });
    }

    public function testDigestMigrationRollsBackAndPreservesExistingImageMetadata(): void
    {
        require_once dirname(__DIR__, 2) . '/bootstrap.php';
        $db = new \PDO('sqlite::memory:');
        $db->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
        $db->setAttribute(\PDO::ATTR_DEFAULT_FETCH_MODE, \PDO::FETCH_ASSOC);
        for ($version = 1; $version <= 10; $version++) {
            ('migrateDatabaseToVersion' . $version)($db);
        }
        $db->exec("INSERT INTO views(id,name,view_type) VALUES(1,'legacy floor','floor')");
        $db->exec("INSERT INTO view_floor_plans(view_id,stored_name,original_name,mime_type,file_size,image_width,image_height,created_at,updated_at)
            VALUES(1,'00000000000000000000000000000001.png','floor.png','image/png',100,1,1,'before','before')");
        $before = $db->query('SELECT * FROM view_floor_plans')->fetchAll();
        $db->exec("ALTER TABLE device_images ADD COLUMN sha256 TEXT NOT NULL DEFAULT ''");
        $schema = $db->query('SELECT type,name,sql FROM sqlite_master ORDER BY type,name')->fetchAll();
        try {
            \migrateDatabaseToVersion11($db);
            $this->fail('Conflicting digest column must reject migration');
        } catch (\PDOException) {
            $this->assertSame(10, (int)$db->query('PRAGMA user_version')->fetchColumn());
        }
        $this->assertSame($schema, $db->query('SELECT type,name,sql FROM sqlite_master ORDER BY type,name')->fetchAll());
        $this->assertSame($before, $db->query('SELECT * FROM view_floor_plans')->fetchAll());
        $db->exec('ALTER TABLE device_images DROP COLUMN sha256');
        \migrateDatabaseToVersion11($db);
        \migrateDatabaseToVersion11($db);
        $after = $db->query('SELECT * FROM view_floor_plans')->fetchAll();
        $this->assertSame('', $after[0]['sha256']);
        unset($after[0]['sha256']);
        $this->assertSame($before, $after);
        $this->assertSame(11, (int)$db->query('PRAGMA user_version')->fetchColumn());
    }

    public function testInsufficientRestoreSpacePreservesDatabaseImagesAndSession(): void
    {
        $prepend = tempnam(sys_get_temp_dir(), 'netarium-restore-space-');
        $blocked = $prepend . '.blocked';
        file_put_contents($prepend, '<?php namespace Netarium\Services\Storage; function disk_free_space(string $directory): float|false {'
            . 'return is_file(' . var_export($blocked, true) . ') ? 0.0 : \disk_free_space($directory); }');
        try {
            $this->withIdBoundaryFixture(function (string $path, \PDO $db, \Netarium\Tests\TestServer $server) use ($blocked): void {
                $before = $this->idBoundaryState($db);
                $users = $db->query('SELECT * FROM users ORDER BY id')->fetchAll(\PDO::FETCH_ASSOC);
                $files = $this->restoreFiles($server->getTempDir() . '/uploads');
                file_put_contents($blocked, 'disk-full');
                $this->previewIdBackup($path, 507);
                $this->assertSame($before, $this->idBoundaryState($db));
                unlink($blocked);
                $preview = $this->previewIdBackup($path);
                file_put_contents($blocked, 'disk-full');
                $this->commitIdBackup($preview, 507);
                $this->assertSame($before, $this->idBoundaryState($db));
                $this->assertSame($files, $this->restoreFiles($server->getTempDir() . '/uploads'));
                $this->assertSame($users, $db->query('SELECT * FROM users ORDER BY id')->fetchAll(\PDO::FETCH_ASSOC));
                $this->client->get('/api.php?action=load')->assertOk();
                unlink($blocked);
                $this->commitIdBackup($preview);
            }, $prepend);
        } finally {
            @unlink($blocked);
            unlink($prepend);
        }
    }

    public function testInitialDigestBackfillPreservesResourceRevisions(): void
    {
        $this->withIdBoundaryFixture(function (string $path, \PDO $db): void {
            $db->exec("UPDATE view_floor_plans SET sha256 = ''");
            $db->exec("UPDATE device_images SET sha256 = ''");
            $viewRev = (int)$db->query("SELECT resource_revision FROM views WHERE id = 2")->fetchColumn();
            $deviceRev = (int)$db->query("SELECT resource_revision FROM devices WHERE id = 1")->fetchColumn();
            $seqRev = (int)$db->query("SELECT value FROM resource_sequences WHERE name = 'revision'")->fetchColumn();

            $this->client->postJson('/api.php?action=export_backup_zip', [])->assertStatus(200);

            $this->assertNotSame('', $db->query("SELECT sha256 FROM view_floor_plans WHERE view_id = 2")->fetchColumn());
            $this->assertNotSame('', $db->query("SELECT sha256 FROM device_images WHERE id = 1")->fetchColumn());
            $this->assertSame($viewRev, (int)$db->query("SELECT resource_revision FROM views WHERE id = 2")->fetchColumn());
            $this->assertSame($deviceRev, (int)$db->query("SELECT resource_revision FROM devices WHERE id = 1")->fetchColumn());
            $this->assertSame($seqRev, (int)$db->query("SELECT value FROM resource_sequences WHERE name = 'revision'")->fetchColumn());
        });
    }

    private function copyProjectTreeWithVersion(string $sourceRoot, string $targetRoot, string $version): void
    {
        $releaseRoot = getenv('NETARIUM_BACKUP_V' . str_replace('.', '', $version) . '_ROOT');
        if (!is_string($releaseRoot) || $releaseRoot === '') {
            // Archive actual release code; never relabel the schema12 candidate.
            $archive = $targetRoot . '.zip';
            $pipes = [];
            $process = proc_open(['git', '-C', $sourceRoot, 'archive', '--format=zip',
                '--output=' . $archive, 'v' . $version],
                [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
            if (!is_resource($process)) { throw new \RuntimeException('Cannot materialize release fixture'); }
            fclose($pipes[0]);
            $stdout = stream_get_contents($pipes[1]); fclose($pipes[1]);
            $stderr = stream_get_contents($pipes[2]); fclose($pipes[2]);
            $status = proc_close($process);
            if ($status !== 0) {
                @unlink($archive);
                throw new \RuntimeException('Release fixture v' . $version . ' unavailable: '
                    . $stdout . $stderr . '; fetch release tags or set NETARIUM_BACKUP_V'
                    . str_replace('.', '', $version) . '_ROOT');
            }
            mkdir($targetRoot, 0700, true);
            $zip = new ZipArchive();
            try {
                if ($zip->open($archive) !== true || !$zip->extractTo($targetRoot)) {
                    throw new \RuntimeException('Cannot extract release fixture');
                }
                $zip->close();
            } finally { @unlink($archive); }
            return;
        }
        $copyRoot = $releaseRoot;
        foreach (['public', 'src', 'templates', 'resources', 'scripts', 'config'] as $dir) {
            $this->copyDirectoryRecursive($copyRoot . DIRECTORY_SEPARATOR . $dir, $targetRoot . DIRECTORY_SEPARATOR . $dir);
        }
        copy($copyRoot . DIRECTORY_SEPARATOR . 'bootstrap.php', $targetRoot . DIRECTORY_SEPARATOR . 'bootstrap.php');
        copy($copyRoot . DIRECTORY_SEPARATOR . 'version.php', $targetRoot . DIRECTORY_SEPARATOR . 'version.php');
    }

    private function copyDirectoryRecursive(string $source, string $destination): void
    {
        if (!is_dir($destination)) {
            mkdir($destination, 0700, true);
        }
        foreach (scandir($source) ?: [] as $entry) {
            if ($entry === '.' || $entry === '..') {
                continue;
            }
            $srcPath = $source . DIRECTORY_SEPARATOR . $entry;
            $dstPath = $destination . DIRECTORY_SEPARATOR . $entry;
            if (is_dir($srcPath)) {
                $this->copyDirectoryRecursive($srcPath, $dstPath);
            } else {
                copy($srcPath, $dstPath);
            }
        }
    }

    private function removeTreeRecursive(string $dir): void
    {
        if (!is_dir($dir)) {
            return;
        }
        foreach (scandir($dir) ?: [] as $entry) {
            if ($entry === '.' || $entry === '..') {
                continue;
            }
            $path = $dir . DIRECTORY_SEPARATOR . $entry;
            if (is_dir($path) && !is_link($path)) {
                $this->removeTreeRecursive($path);
            } else {
                @unlink($path);
            }
        }
        @rmdir($dir);
    }

    public function testDeviceConfigWebBackupPreservesDeletedGenerationWatermarksAndRejectsInvalidPayload(): void
    {
        $this->withIdBoundaryFixture(function (string $path, \PDO $db): void {
            $db->exec("INSERT INTO device_config_states(device_id,revision,next_generation) VALUES(1,12,19),(2,8,22)");
            $insert = $db->prepare('INSERT INTO device_configs(id,device_id,generation,content,created_at,actor_user_id,actor_name,memo) VALUES(?,?,?,?,?,?,?,?)');
            $insert->execute([41, 1, 3, "hostname old\n", '2026-01-02T00:00:00Z', null, '退職済み管理者', '旧版']);
            $insert->execute([49, 1, 17, "hostname kept\n", '2026-01-02T00:00:00Z', 1, 'admin', '保存版']);
            $kept = [];
            foreach (['device_configs', 'device_config_states'] as $table) {
                $kept[$table] = $db->query('SELECT * FROM ' . $table . ' ORDER BY ' . ($table === 'device_configs' ? 'id' : 'device_id'))->fetchAll(\PDO::FETCH_ASSOC);
            }
            $archive = $path . '.configs.zip';
            file_put_contents($archive, $this->client->postJson('/api.php?action=export_backup_zip', [])->assertStatus(200)->getBody());
            $zip = new ZipArchive();
            $this->assertTrue($zip->open($archive) === true);
            $document = json_decode((string)$zip->getFromName('data/netarium.json'), true, 512, JSON_THROW_ON_ERROR);
            $manifest = json_decode((string)$zip->getFromName('manifest.json'), true, 512, JSON_THROW_ON_ERROR);
            $zip->close();
            $this->assertSame([$kept['device_configs'][1]], $document['tables']['device_configs']);
            $this->assertSame(1, $manifest['summary']['device_configs']);
            $this->assertSame($kept['device_config_states'], $document['tables']['device_config_states']);
            $this->commitIdBackup($this->previewIdBackup($archive));
            $this->assertSame([$kept['device_configs'][1]], $db->query('SELECT * FROM device_configs ORDER BY id')->fetchAll(\PDO::FETCH_ASSOC));
            $this->assertSame($kept['device_config_states'], $db->query('SELECT * FROM device_config_states ORDER BY device_id')->fetchAll(\PDO::FETCH_ASSOC));

            // 直近1世代化は新規出力だけに適用し、旧形式1の全世代ZIPも取り込める。
            $legacyArchive = $archive . '.all-versions';
            copy($archive, $legacyArchive);
            $this->rewriteBackupZip($legacyArchive, static function (array &$doc) use ($kept): void {
                $doc['tables']['device_configs'] = $kept['device_configs'];
            });
            $archive = $legacyArchive;
            $db->exec('DELETE FROM device_configs; DELETE FROM device_config_states');
            $this->commitIdBackup($this->previewIdBackup($archive));
            foreach ($kept as $table => $rows) {
                $this->assertSame($rows, $db->query('SELECT * FROM ' . $table . ' ORDER BY ' . ($table === 'device_configs' ? 'id' : 'device_id'))->fetchAll(\PDO::FETCH_ASSOC));
            }
            foreach (['missing-state', 'foreign-device', 'duplicate-id', 'duplicate-generation', 'watermark', 'revision', 'order', 'too-many', 'oversize', 'blank', 'nul', 'control', 'crlf', 'bom', 'memo', 'date', 'unknown',
                'id-exhausted', 'revision-exhausted', 'generation-exhausted', 'empty-generation-exhausted'] as $fault) {
                $bad = $archive . '.' . $fault;
                copy($archive, $bad);
                $this->rewriteBackupZip($bad, static function (array &$doc) use ($fault): void {
                    $rows = &$doc['tables']['device_configs'];
                    $states = &$doc['tables']['device_config_states'];
                    if ($fault === 'missing-state') { $states = []; }
                    if ($fault === 'foreign-device') { $rows[0]['device_id'] = 99999; }
                    if ($fault === 'duplicate-id') { $rows[1]['id'] = $rows[0]['id']; }
                    if ($fault === 'duplicate-generation') { $rows[1]['generation'] = $rows[0]['generation']; }
                    if ($fault === 'watermark') { $states[0]['next_generation'] = 17; }
                    if ($fault === 'revision') { $states[0]['revision'] = 0; }
                    if ($fault === 'id-exhausted') { $rows[1]['id'] = \Netarium\Core\ResourceId::MAX; }
                    if ($fault === 'revision-exhausted') { $states[0]['revision'] = \Netarium\Core\ResourceId::MAX; }
                    if ($fault === 'generation-exhausted') { $states[0]['next_generation'] = PHP_INT_MAX; }
                    if ($fault === 'empty-generation-exhausted') { $states[1]['next_generation'] = PHP_INT_MAX; }
                    if ($fault === 'order') { $rows[1]['created_at'] = '2025-01-01T00:00:00Z'; }
                    if ($fault === 'too-many') {
                        for ($i = 0; $i < 4; $i++) {
                            $row = $rows[1]; $row['id'] = 50 + $i; $row['generation'] = 18 + $i; $rows[] = $row;
                        }
                        $states[0]['next_generation'] = 30;
                    }
                    if ($fault === 'oversize') { $rows[0]['content'] = str_repeat('x', 262145); }
                    if ($fault === 'blank') { $rows[0]['content'] = " \t\n"; }
                    if ($fault === 'nul') { $rows[0]['content'] = "secret-marker\0"; }
                    if ($fault === 'control') { $rows[0]['content'] = "secret-marker\x01"; }
                    if ($fault === 'crlf') { $rows[0]['content'] = "secret-marker\r\n"; }
                    if ($fault === 'bom') { $rows[0]['content'] = "\xEF\xBB\xBFsecret-marker"; }
                    if ($fault === 'memo') { $rows[0]['memo'] = str_repeat('長', 201); }
                    if ($fault === 'date') { $rows[0]['created_at'] = '2026-02-30T00:00:00Z'; }
                    if ($fault === 'unknown') { $rows[0]['filename'] = 'unknown.cfg'; }
                });
                $result = $this->previewIdBackup($bad, 400);
                $this->assertFalse(str_contains(json_encode($result, JSON_THROW_ON_ERROR), 'secret-marker'));
                foreach ($kept as $table => $rows) {
                    $this->assertSame($rows, $db->query('SELECT * FROM ' . $table . ' ORDER BY ' . ($table === 'device_configs' ? 'id' : 'device_id'))->fetchAll(\PDO::FETCH_ASSOC));
                }
            }
            $invalidUtf8 = $archive . '.invalid-utf8';
            copy($archive, $invalidUtf8);
            $this->rewriteBackupZip($invalidUtf8, static function (array &$doc): void {}, static fn(string $json): string => str_replace('hostname old', "secret-marker\xFF", $json));
            $result = $this->previewIdBackup($invalidUtf8, 400);
            $this->assertFalse(str_contains(json_encode($result, JSON_THROW_ON_ERROR), 'secret-marker'));
            $legacy = $archive . '.schema19';
            copy($archive, $legacy);
            $this->rewriteBackupZip($legacy, static function (array &$doc, array &$manifest): void {
                $manifest['schema_version'] = 19;
                foreach ($doc['tables']['address_spaces'] ?? [] as $index => $space) {
                    unset($doc['tables']['address_spaces'][$index]['ping_reachability']);
                }
                foreach ($doc['tables']['view_floor_plans'] as &$plan) { unset($plan['rotation']); }
                unset($plan);
                unset($doc['tables']['device_configs'], $doc['tables']['device_config_states'],
                    $manifest['summary']['device_configs'], $manifest['summary']['device_config_states']);
            });
            $this->commitIdBackup($this->previewIdBackup($legacy));
            $this->assertSame([], $db->query('SELECT * FROM device_configs')->fetchAll(\PDO::FETCH_ASSOC));
            $this->assertSame([], $db->query('SELECT * FROM device_config_states')->fetchAll(\PDO::FETCH_ASSOC));
        });
    }

    public function testRestorePreviewRejectsConcurrentConfigSaveAndDelete(): void
    {
        $this->withIdBoundaryFixture(function (string $path, \PDO $db): void {
            $deviceRevision = (int)$db->query('SELECT resource_revision FROM devices WHERE id=1')->fetchColumn();
            $preview = $this->previewIdBackup($path);
            $saved = $this->client->postJson('/api.php?action=save_device_config', [
                'device_id' => 1, 'expected_device_revision' => $deviceRevision,
                'expected_revision' => 0, 'content' => "hostname concurrent\n", 'memo' => '',
            ])->assertStatus(200)->getJson();
            $beforeCommit = $this->idBoundaryState($db);
            $this->commitIdBackup($preview, 409);
            $this->assertSame($beforeCommit, $this->idBoundaryState($db));
            $this->assertSame($deviceRevision, (int)$db->query('SELECT resource_revision FROM devices WHERE id=1')->fetchColumn());

            $archive = $path . '.with-config.zip';
            file_put_contents($archive, $this->client->postJson('/api.php?action=export_backup_zip', [])->assertStatus(200)->getBody());
            $preview = $this->previewIdBackup($archive);
            $this->client->postJson('/api.php?action=delete_device_configs', [
                'device_id' => 1, 'expected_device_revision' => $deviceRevision,
                'expected_revision' => $saved['revision'], 'ids' => [$saved['items'][0]['id']],
            ])->assertStatus(200);
            $beforeCommit = $this->idBoundaryState($db);
            $this->commitIdBackup($preview, 409);
            $this->assertSame($beforeCommit, $this->idBoundaryState($db));
            $this->assertSame([], $db->query('SELECT * FROM device_configs')->fetchAll(\PDO::FETCH_ASSOC));
            $this->assertSame($deviceRevision, (int)$db->query('SELECT resource_revision FROM devices WHERE id=1')->fetchColumn());
        });
    }
    public function testDeviceConfigMultiDeviceMultiVersionBackupExportAndRestoreRoundTrip(): void
    {
        $this->withIdBoundaryFixture(function (string $path, \PDO $db): void {
            // 32機器×5世代×256KiB = 実バイト40MiB。各機器の5世代目は登録APIを通す。
            $insertDevice = $db->prepare("INSERT INTO devices (id, name, type, ip, resource_revision) VALUES (?, ?, 'switch', ?, 1)");
            for ($i = 5; $i <= 34; $i++) {
                $insertDevice->execute([$i, "SW-{$i}", "192.0.2.{$i}"]);
            }
            $deviceIds = array_merge([1, 2], range(5, 34));
            $insertConfig = $db->prepare('INSERT INTO device_configs (device_id, generation, content, created_at, actor_user_id, actor_name, memo) VALUES (?, ?, ?, ?, 1, ?, ?)');
            $insertState = $db->prepare('INSERT INTO device_config_states (device_id, revision, next_generation) VALUES (?, 4, 11)');
            $makeContent = static function (int $deviceId, int $generation): string {
                $prefix = "hostname SW-{$deviceId} generation {$generation}\n";
                $unit = "あ\n\"\\\t";
                $content = $prefix . str_repeat($unit, intdiv(262144 - strlen($prefix), strlen($unit)));
                return str_pad($content, 262144, 'x');
            };
            foreach ($deviceIds as $deviceId) {
                foreach ([2, 4, 6, 8] as $generation) {
                    $insertConfig->execute([$deviceId, $generation, $makeContent($deviceId, $generation),
                        sprintf('2026-01-%02dT00:00:00Z', $generation), 'admin', '過去版']);
                }
                $insertState->execute([$deviceId]);
            }
            $db->exec('INSERT INTO device_config_states(device_id, revision, next_generation) VALUES(3,8,22)');
            foreach ($deviceIds as $deviceId) {
                $deviceRevision = (int)$db->query("SELECT resource_revision FROM devices WHERE id={$deviceId}")->fetchColumn();
                $saved = $this->client->postJson('/api.php?action=save_device_config', [
                    'device_id' => $deviceId, 'expected_device_revision' => $deviceRevision,
                    'expected_revision' => 4, 'content' => $makeContent($deviceId, 11), 'memo' => '最新の日本語版',
                ])->assertStatus(200)->getJson();
                $this->assertSame(5, count($saved['items']));
                $this->assertSame(11, $saved['items'][0]['generation']);
            }
            unset($saved);
            $this->assertSame(41943040, (int)$db->query('SELECT SUM(LENGTH(CAST(content AS BLOB))) FROM device_configs')->fetchColumn());
            $latest = $db->query('SELECT * FROM device_configs WHERE generation=11 ORDER BY id')->fetchAll(\PDO::FETCH_ASSOC);
            $sourceStates = $db->query('SELECT * FROM device_config_states ORDER BY device_id')->fetchAll(\PDO::FETCH_ASSOC);
            $archive = $path . '.multi-configs.zip';
            file_put_contents($archive, $this->client->postJson('/api.php?action=export_backup_zip', [])->assertStatus(200)->getBody());
            $zip = new ZipArchive();
            $this->assertTrue($zip->open($archive) === true);
            $manifest = json_decode((string)$zip->getFromName('manifest.json'), true, 512, JSON_THROW_ON_ERROR);
            $document = json_decode((string)$zip->getFromName('data/netarium.json'), true, 512, JSON_THROW_ON_ERROR);
            $zip->close();
            $this->assertSame(32, $manifest['summary']['device_configs']);
            $this->assertSame(33, $manifest['summary']['device_config_states']);
            $this->assertSame($latest, $document['tables']['device_configs']);
            $this->assertSame($sourceStates, $document['tables']['device_config_states']);
            unset($document);

            // 置換復元により過去4世代は残らず、ID・世代・空履歴の高水位は維持される。
            $this->commitIdBackup($this->previewIdBackup($archive));
            $this->assertSame($latest, $db->query('SELECT * FROM device_configs ORDER BY id')->fetchAll(\PDO::FETCH_ASSOC));
            $this->assertSame($sourceStates, $db->query('SELECT * FROM device_config_states ORDER BY device_id')->fetchAll(\PDO::FETCH_ASSOC));
            $deviceRevision = (int)$db->query('SELECT resource_revision FROM devices WHERE id=1')->fetchColumn();
            $saved = $this->client->postJson('/api.php?action=save_device_config', [
                'device_id' => 1, 'expected_device_revision' => $deviceRevision,
                'expected_revision' => 5, 'content' => 'hostname after-restore', 'memo' => '',
            ])->assertStatus(200)->getJson();
            $this->assertSame(12, $saved['items'][0]['generation']);
        });
    }

    public function testConfigWebExportChecksSerializedBytesAndFailsWithoutPublishingPartialZip(): void
    {
        $this->withIdBoundaryFixture(function (string $path, \PDO $db, \Netarium\Tests\TestServer $server): void {
            $content = "日本語\n" . str_repeat("x\n\"\\\t", 4096);
            $db->exec('INSERT INTO device_config_states(device_id, revision, next_generation) VALUES(1,1,2)');
            $db->prepare("INSERT INTO device_configs(device_id,generation,content,created_at,actor_name,memo) VALUES(1,1,?,'2026-01-01T00:00:00Z','admin','')")
                ->execute([$content]);
            $service = new \Netarium\Services\Backup\BackupService($db);
            $config = [
                'application_version' => '1.3.0',
                'backup_export_directory' => $server->getTempDir() . '/export-boundary',
                'backup_auto_directory' => $server->getTempDir() . '/auto-boundary',
                'floor_plan_directory' => $server->getTempDir() . '/floorplans',
                'device_image_directory' => $server->getTempDir() . '/device_images',
            ];
            $root = $service->prepareBackupExportRoot($config['backup_export_directory']);
            $work = $service->createBackupWorkDirectory($root);
            $result = $service->buildBackupZipFile($config, $work, $work . '/boundary.zip');
            $bytes = filesize($work . '/data/netarium.json') + filesize($work . '/manifest.json');
            $this->assertTrue($bytes > strlen($content), 'JSONエスケープ・メタデータを含む実サイズで判定する');
            $service->removeDirectoryTree($work);
            $before = $this->idBoundaryState($db);

            // 展開後の実サイズちょうどは許可し、1バイト不足と圧縮後上限超過は拒否する。
            $exact = $config;
            $exact['storage_capacity']['backup']['max_uncompressed_bytes'] = $bytes;
            $work = $service->createBackupWorkDirectory($root);
            $service->buildBackupZipFile($exact, $work, $work . '/exact.zip');
            $service->removeDirectoryTree($work);
            foreach ([
                ['max_uncompressed_bytes' => $bytes - 1],
                ['max_zip_bytes' => 1],
            ] as $limits) {
                $limited = $config;
                $limited['storage_capacity']['backup'] = $limits;
                ob_start();
                try {
                    $service->exportBackupZip($limited);
                    $this->fail('容量超過のWeb ZIPを出力してはいけない');
                } catch (\Netarium\Core\ApiException $e) {
                    $this->assertSame(400, $e->getHttpStatus());
                    $this->assertStringContains('上限', $e->getMessage());
                    $this->assertStringContains('停止型完全バックアップ', $e->getMessage());
                } finally {
                    $output = ob_get_clean();
                }
                $this->assertSame('', $output, '拒否時はZIPを一部も送信しない');
                $this->assertSame([], glob($root . '/*'));
                $this->assertSame($before, $this->idBoundaryState($db));
            }
            $limited = $config;
            $limited['storage_capacity']['backup']['max_zip_bytes'] = 1;
            $this->assertRestoreStatus(400, static fn() => $service->createPreRestoreBackup($limited));
            $this->assertSame([], glob($config['backup_auto_directory'] . '/*'), '失敗した自動退避ZIPは公開・残置しない');
            $this->assertSame($before, $this->idBoundaryState($db));
        });
    }


    public function testVersionCompatibilityPolicyAndCrossVersionWebRestore(): void
    {
        require_once dirname(__DIR__, 2) . '/bootstrap.php';
        $policy = \Netarium\Services\Backup\BackupCompatibilityPolicy::class;
        foreach (['netarium-config', 'netarium-full'] as $format) {
            foreach (range(11, APP_DATABASE_SCHEMA_VERSION) as $schema) {
                $this->assertTrue($policy::isCompatible($format, $format, 1, $schema, '1.2.0', APP_DATABASE_SCHEMA_VERSION, '1.3.0'));
            }
            foreach ([
                ['1.3.0', '1.3.0'], ['1.3.0', '1.3.1'], ['1.3.2', '1.3.10'],
                ['1.9.0', '1.10.0'], ['1.3.99', '1.4.0'], ['1.0.4', '1.3.0'],
                ['1.3.9223372036854775808', '1.3.9223372036854775809'],
            ] as [$source, $target]) {
                $this->assertTrue($policy::isCompatible($format, $format, 1, 16, $source, 16, $target));
                if ($source !== $target) {
                    $this->assertFalse($policy::isCompatible($format, $format, 1, 16, $target, 16, $source));
                }
            }
            foreach (['', 'v1.3.0', '1.3', '1.3.0.0', '01.3.0', '1.03.0', '1.3.00',
                '1.3.0-beta.1', '1.3.0+build.1', '1.3.0 ', "1.3.0\n", null, 130] as $invalid) {
                $this->assertFalse($policy::isCompatible($format, $format, 1, 16, $invalid, 16, '1.3.0'));
                if (is_string($invalid)) {
                    $this->assertFalse($policy::isCompatible($format, $format, 1, 16, '1.3.0', 16, $invalid));
                }
            }
            foreach ([
                [1, 16, '1.3.1', 16, '1.3.0'], [1, 16, '0.3.0', 16, '1.3.0'],
                [1, 16, '1.3.0', 16, '2.0.0'], [1, 16, '2.0.0', 16, '1.3.0'],
                [1, 10, '1.2.0', 16, '1.3.0'], [1, 17, '1.2.0', 16, '1.3.0'],
                [1, '16', '1.2.0', 16, '1.3.0'], [1, 16, '1.2.0', 15, '1.3.0'],
                [1, 16, '1.2.0', APP_DATABASE_SCHEMA_VERSION + 1, '1.3.0'], [1, 19, '1.2.0', 18, '1.3.0'],
                [1, 20, '1.3.0', 19, '1.3.0'],
                [1, 18, '1.2.0', 17, '1.3.0'], [2, 16, '1.2.0', 16, '1.3.0'],
                ['1', 16, '1.2.0', 16, '1.3.0'],
            ] as [$formatVersion, $schema, $source, $targetSchema, $target]) {
                $this->assertFalse($policy::isCompatible($format, $format, $formatVersion, $schema, $source, $targetSchema, $target));
            }
            $other = $format === 'netarium-config' ? 'netarium-full' : 'netarium-config';
            $this->assertFalse($policy::isCompatible($format, $other, 1, 16, '1.2.0', 16, '1.3.0'));
        }

        $repoRoot = (string)realpath(dirname(__DIR__, 2));
        $releaseRoot = sys_get_temp_dir() . '/netarium_v120_app_' . bin2hex(random_bytes(6));
        $candidateRoot = sys_get_temp_dir() . '/netarium_current_candidate_' . bin2hex(random_bytes(6));
        $this->copyProjectTreeWithVersion($repoRoot, $releaseRoot, '1.2.0');
        // Exercise the actual source version, not a relabeled legacy application.
        foreach (['public', 'src', 'templates', 'resources', 'scripts', 'config'] as $dir) {
            $this->copyDirectoryRecursive($repoRoot . '/' . $dir, $candidateRoot . '/' . $dir);
        }
        copy($repoRoot . '/bootstrap.php', $candidateRoot . '/bootstrap.php');
        copy($repoRoot . '/version.php', $candidateRoot . '/version.php');
        $release = new \Netarium\Tests\TestServer($releaseRoot);
        $candidate = new \Netarium\Tests\TestServer($candidateRoot);
        $originalClient = $this->client;
        $sourceDb = $db = null;
        try {
            $release->start();
            $candidate->start();
            $sourceClient = new TestHttpClient($release->getBaseUrl());
            $this->assertTrue($sourceClient->login('admin', 'admin123'));
            [$sourceDb] = $this->seedBackupImages($release, 1);
            $sourceDb->exec("INSERT INTO canvas_notes(id,view_id,text) VALUES(1,1,'公開版の構成メモ')");
            $sourceDb->exec("INSERT INTO link_systems(id,name,color_key) VALUES(1,'公開版の系統','indigo')");
            $sourceDb->exec('UPDATE links SET system_id=1');
            $archive = $release->getTempDir() . '/public-v120.zip';
            file_put_contents($archive, $sourceClient->postJson('/api.php?action=export_backup_zip', [])->assertStatus(200)->getBody());
            $zip = new ZipArchive();
            $this->assertTrue($zip->open($archive) === true);
            $manifest = json_decode((string)$zip->getFromName('manifest.json'), true, 512, JSON_THROW_ON_ERROR);
            $sourceData = json_decode((string)$zip->getFromName('data/netarium.json'), true, 512, JSON_THROW_ON_ERROR);
            $zip->close();
            $this->assertSame('1.2.0', $manifest['application_version']);
            $this->assertSame(11, $manifest['schema_version']);

            $this->client = new TestHttpClient($candidate->getBaseUrl());
            $viewer = new TestHttpClient($candidate->getBaseUrl());
            $this->assertTrue($this->client->login('admin', 'admin123'));
            $this->assertTrue($viewer->login('viewer', 'viewer123'));
            [$db] = $this->seedBackupImages($candidate, 1);
            $users = $db->query('SELECT * FROM users ORDER BY id')->fetchAll(\PDO::FETCH_ASSOC);
            $files = $this->restoreFiles($candidate->getTempDir() . '/uploads');
            $preview = $this->previewIdBackup($archive);
            $this->assertSame('1.2.0', $preview['backup']['application_version']);
            $this->assertSame(2, $preview['image_resolution']['matched']);
            $this->commitIdBackup($preview);
            $roundTrip = $candidate->getTempDir() . '/current-schema.zip';
            file_put_contents($roundTrip, $this->client->postJson('/api.php?action=export_backup_zip', [])->assertStatus(200)->getBody());
            $this->assertTrue($zip->open($roundTrip) === true);
            $restored = json_decode((string)$zip->getFromName('data/netarium.json'), true, 512, JSON_THROW_ON_ERROR);
            $zip->close();
            foreach (['devices', 'views', 'device_placements', 'links', 'link_systems', 'canvas_notes',
                'view_floor_plans', 'device_images'] as $table) {
                // Web復元は古い編集要求を失効させるため、resource_revisionを再発行する。
                $withoutRevision = static fn(array $rows): array => array_map(
                    static fn(array $row): array => array_diff_key($row, ['resource_revision' => true]), $rows
                );
                $restoredRows = $restored['tables'][$table];
                if ($table === 'devices') {
                    foreach ($restoredRows as &$row) {
                        $this->assertTrue(array_key_exists('ip_segment_id', $row));
                        $this->assertSame(null, $row['ip_segment_id']);
                        unset($row['ip_segment_id']);
                    }
                    unset($row);
                }
                if ($table === 'view_floor_plans') {
                    foreach ($restoredRows as &$row) {
                        $this->assertSame(0, $row['rotation']);
                        unset($row['rotation']);
                    }
                    unset($row);
                }
                $this->assertSame($withoutRevision($sourceData['tables'][$table]), $withoutRevision($restoredRows), $table);
            }
            foreach (['rack_settings', 'rack_mounts', 'rack_shelves', 'rack_shelf_devices', 'floor_rack_placements', 'device_ip_addresses', 'address_spaces', 'ip_segments', 'change_history', 'device_configs', 'device_config_states'] as $table) {
                $this->assertSame([], $restored['tables'][$table]);
            }

            // All current-schema features survive a real HTTP export/preview/commit.
            $db->exec("UPDATE devices SET type='pc' WHERE id=1");
            $db->exec("INSERT INTO views(id,name,view_type) VALUES(90,'Rack','rack'),(91,'Floor','floor')");
            $db->exec("INSERT INTO rack_settings VALUES(90,42,'room')");
            $db->exec("INSERT INTO rack_mounts VALUES(1,90,'rear',2,3,'left','full')");
            $db->exec("INSERT INTO rack_shelves VALUES(7,90,'Shelf','front',10,1,'full')");
            $db->exec('INSERT INTO rack_shelf_devices VALUES(2,7,0)');
            $db->exec('INSERT INTO floor_rack_placements VALUES(91,90,12.5,-20)');
            $db->exec("INSERT INTO device_ip_addresses(id,device_id,ip,label,sort_order)
                VALUES (7,1,'198.51.100.71','service',1),(8,1,'203.0.113.71','backup',0),(9,2,'198.51.100.71','isolated',0)");
            $kept = [];
            foreach (['rack_settings', 'rack_mounts', 'rack_shelves', 'rack_shelf_devices', 'floor_rack_placements', 'device_ip_addresses'] as $table) {
                $kept[$table] = $db->query('SELECT * FROM ' . $table)->fetchAll(\PDO::FETCH_ASSOC);
            }
            file_put_contents($roundTrip, $this->client->postJson('/api.php?action=export_backup_zip', [])->assertStatus(200)->getBody());
            $db->exec("UPDATE devices SET type='other' WHERE id=1");
            $db->exec('DELETE FROM floor_rack_placements; DELETE FROM rack_shelf_devices; DELETE FROM rack_shelves; DELETE FROM rack_mounts; DELETE FROM device_ip_addresses');
            $this->commitIdBackup($this->previewIdBackup($roundTrip));
            $this->assertSame('pc', $db->query('SELECT type FROM devices WHERE id=1')->fetchColumn());
            foreach ($kept as $table => $rows) {
                $this->assertSame($rows, $db->query('SELECT * FROM ' . $table)->fetchAll(\PDO::FETCH_ASSOC));
            }

            $before = $this->idBoundaryState($db);
            foreach (['reverse', 'major', 'invalid', 'schema', 'format', 'corrupt', 'contract'] as $fault) {
                $bad = $roundTrip . '.' . $fault;
                copy($roundTrip, $bad);
                if ($fault === 'corrupt') {
                    file_put_contents($bad, 'not a zip');
                } else {
                    $this->rewriteBackupZip($bad, static function (array &$doc, array &$m) use ($fault): void {
                        if ($fault === 'reverse') {
                            [$major, $minor, $patch] = explode('.', NETARIUM_VERSION);
                            $m['application_version'] = $major . '.' . $minor . '.' . ((int)$patch + 1);
                        }
                        if ($fault === 'major') { $m['application_version'] = '2.0.0'; }
                        if ($fault === 'invalid') { $m['application_version'] = '1.3.0-beta.1'; }
                        if ($fault === 'schema') { $m['schema_version'] = APP_DATABASE_SCHEMA_VERSION + 1; }
                        if ($fault === 'format') { $m['format_version'] = 2; }
                        if ($fault === 'contract') { $doc['tables']['devices'][0]['unknown'] = 'x'; }
                    });
                }
                $this->previewIdBackup($bad, 400);
                $this->assertSame($before, $this->idBoundaryState($db));
                foreach ($kept as $table => $rows) {
                    $this->assertSame($rows, $db->query('SELECT * FROM ' . $table)->fetchAll(\PDO::FETCH_ASSOC));
                }
            }
            $this->assertSame($users, $db->query('SELECT * FROM users ORDER BY id')->fetchAll(\PDO::FETCH_ASSOC));
            $this->assertSame($files, $this->restoreFiles($candidate->getTempDir() . '/uploads'));
            $viewer->get('/api.php?action=load')->assertOk();
            $this->client->get('/api.php?action=load')->assertOk();
        } finally {
            $this->client = $originalClient;
            $sourceDb = $db = null;
            $release->stop();
            $candidate->stop();
            $this->removeTreeRecursive($releaseRoot);
            $this->removeTreeRecursive($candidateRoot);
        }
    }
}
