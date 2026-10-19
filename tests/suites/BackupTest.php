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
            'device_images', 'device_monitor_status', 'view_floor_plans', 'app_meta',
            'resource_sequences', 'sqlite_sequence'] as $table) {
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
                    'expect' => '図面倍率',
                ],
                [
                    'values' => ['opacity' => 2.0],
                    'status' => 400,
                    'expect' => '透明度',
                ],
                [
                    'values' => ['x' => 200000],
                    'status' => 400,
                    'expect' => '図面位置',
                ],
                [
                    'values' => ['is_visible' => 2],
                    'status' => 400,
                    'expect' => '表示設定',
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

                $zip = new ZipArchive();
                $zip->open($tempZip);
                $origData = json_decode($zip->getFromName('data/netarium.json'), true);
                $origManifest = json_decode($zip->getFromName('manifest.json'), true);
                $zip->close();

                foreach ($case['values'] as $field => $value) {
                    $origData['tables']['view_floor_plans'][0][$field] = $value;
                }
                $newJson = json_encode($origData, JSON_UNESCAPED_UNICODE);

                foreach ($origManifest['files'] as &$fileEntry) {
                    if ($fileEntry['path'] === 'data/netarium.json') {
                        $fileEntry['size'] = strlen($newJson);
                        $fileEntry['sha256'] = hash('sha256', $newJson);
                        break;
                    }
                }
                unset($fileEntry);
                $newManifest = json_encode($origManifest, JSON_UNESCAPED_UNICODE);

                $zip2 = new ZipArchive();
                $zip2->open($tempZip);
                $zip2->addFromString('data/netarium.json', $newJson);
                $zip2->addFromString('manifest.json', $newManifest);
                $zip2->close();

                $res = $this->client->postMultipart(
                    '/api.php?action=preview_backup_restore',
                    [],
                    ['backup_zip' => ['path' => $tempZip, 'filename' => 'validation.zip', 'type' => 'application/zip']]
                );

                if ($case['status'] === 200) {
                    $res->assertOk();
                } else {
                    $res->assertStatus(400);
                    $this->assertStringContains($case['expect'], $res->getJson()['error']);
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
        foreach (['public', 'src', 'templates', 'resources', 'scripts', 'config'] as $dir) {
            $this->copyDirectoryRecursive($sourceRoot . DIRECTORY_SEPARATOR . $dir, $targetRoot . DIRECTORY_SEPARATOR . $dir);
        }
        copy($sourceRoot . DIRECTORY_SEPARATOR . 'bootstrap.php', $targetRoot . DIRECTORY_SEPARATOR . 'bootstrap.php');
        file_put_contents(
            $targetRoot . DIRECTORY_SEPARATOR . 'version.php',
            "<?php\n\ndeclare(strict_types=1);\n\nconst NETARIUM_VERSION = " . var_export($version, true) . ";\n"
        );
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

    public function testVersionCompatibilityPolicyAndCrossVersionWebRestore(): void
    {
        $policy = \Netarium\Services\Backup\BackupCompatibilityPolicy::class;
        $this->assertTrue($policy::isCompatible('netarium-config', 'netarium-config', 1, 11, '1.0.0', 11, '1.0.0'));
        $this->assertTrue($policy::isCompatible('netarium-config', 'netarium-config', 1, 11, '1.0.0', 11, '1.0.1'));
        $this->assertTrue($policy::isCompatible('netarium-config', 'netarium-config', 1, 11, '1.0.1', 11, '1.0.1'));
        $this->assertTrue($policy::isCompatible('netarium-full', 'netarium-full', 1, 11, '1.0.0', 11, '1.0.0'));
        $this->assertTrue($policy::isCompatible('netarium-full', 'netarium-full', 1, 11, '1.0.0', 11, '1.0.1'));
        $this->assertTrue($policy::isCompatible('netarium-full', 'netarium-full', 1, 11, '1.0.1', 11, '1.0.1'));

        foreach ([
            ['netarium-config', 'netarium-config', 1, 11, '1.0.1', 11, '1.0.0'],
            ['netarium-full', 'netarium-full', 1, 11, '1.0.1', 11, '1.0.0'],
            ['netarium-config', 'netarium-config', 1, 11, '0.3.0', 11, '1.0.0'],
            ['netarium-config', 'netarium-config', 1, 11, '0.3.0', 11, '1.0.1'],
            ['netarium-config', 'netarium-config', 1, 11, '1.0.0', 11, '1.0.2'],
            ['netarium-config', 'netarium-config', 1, 11, '1.0.2', 11, '1.0.1'],
            ['netarium-config', 'netarium-config', 1, 11, '1.0.2', 11, '1.0.2'],
            ['netarium-config', 'netarium-config', 1, 10, '1.0.0', 11, '1.0.1'],
            ['netarium-config', 'netarium-config', 2, 11, '1.0.0', 11, '1.0.1'],
            ['netarium-config', 'netarium-full', 1, 11, '1.0.0', 11, '1.0.1'],
            ['netarium-full', 'netarium-config', 1, 11, '1.0.0', 11, '1.0.1'],
        ] as [$expectedFormat, $actualFormat, $formatVer, $srcSchema, $srcApp, $dstSchema, $dstApp]) {
            $this->assertFalse(
                $policy::isCompatible($expectedFormat, $actualFormat, $formatVer, $srcSchema, $srcApp, $dstSchema, $dstApp),
                "Unexpected compatibility for {$actualFormat} v{$formatVer} {$srcApp}(schema {$srcSchema}) -> {$dstApp}(schema {$dstSchema})"
            );
        }

        $repoRoot = (string)realpath(dirname(__DIR__, 2));
        $v101AppRoot = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'netarium_v101_app_' . bin2hex(random_bytes(6));
        $this->copyProjectTreeWithVersion($repoRoot, $v101AppRoot, '1.0.1');

        $server100 = new \Netarium\Tests\TestServer($repoRoot);
        $server101 = new \Netarium\Tests\TestServer($v101AppRoot);
        $originalClient = $this->client;

        try {
            $server100->start();
            $server101->start();

            $client100 = new TestHttpClient($server100->getBaseUrl());
            $client101 = new TestHttpClient($server101->getBaseUrl());
            $viewer101 = new TestHttpClient($server101->getBaseUrl());
            $this->assertTrue($client100->login('admin', 'admin123'));
            $this->assertTrue($client101->login('admin', 'admin123'));
            $this->assertTrue($viewer101->login('viewer', 'viewer123'));

            [$db100, $floorDir100, $imageDir100, $imageName100] = $this->seedBackupImages($server100, 1);
            $db100->exec("INSERT INTO canvas_notes (id, view_id, text) VALUES (1, 1, 'v1.0.0構成メモ')");
            $db100->exec("INSERT INTO link_systems (id, name, color_key) VALUES (1, 'v1.0.0基幹系統', 'indigo')");
            $db100->exec('UPDATE links SET system_id = 1');
            $extraImageName = sprintf('%032x.png', 202);
            $missingImageName = sprintf('%032x.png', 203);
            $pngBytes = (string)file_get_contents($imageDir100 . DIRECTORY_SEPARATOR . $imageName100);
            file_put_contents($imageDir100 . DIRECTORY_SEPARATOR . $extraImageName, $pngBytes);
            file_put_contents($imageDir100 . DIRECTORY_SEPARATOR . $missingImageName, $pngBytes);
            $now = date(DATE_ATOM);
            $insertImg = $db100->prepare(
                'INSERT INTO device_images (device_id, stored_name, mime_type, file_size, image_width, image_height, sort_order, created_at, updated_at) VALUES (1, ?, ?, ?, 1, 1, ?, ?, ?)'
            );
            $insertImg->execute([$extraImageName, 'image/png', strlen($pngBytes), 2, $now, $now]);
            $insertImg->execute([$missingImageName, 'image/png', strlen($pngBytes), 3, $now, $now]);

            $zip100Path = $server100->getTempDir() . DIRECTORY_SEPARATOR . 'v100-config.zip';
            file_put_contents($zip100Path, $client100->postJson('/api.php?action=export_backup_zip', [])->assertStatus(200)->getBody());

            $zip = new ZipArchive();
            $this->assertTrue($zip->open($zip100Path) === true);
            $manifest100 = json_decode((string)$zip->getFromName('manifest.json'), true, 512, JSON_THROW_ON_ERROR);
            $this->assertSame('1.0.0', $manifest100['application_version']);
            $this->assertSame(11, $manifest100['schema_version']);
            $zip->close();

            [$db101, $floorDir101, $imageDir101] = $this->seedBackupImages($server101, 1);
            // extraImageName has mismatched content of same length; missingImageName is absent on v1.0.1
            file_put_contents($imageDir101 . DIRECTORY_SEPARATOR . $extraImageName, str_repeat('X', strlen($pngBytes)));
            $unreferencedName = sprintf('%032x.png', 299);
            file_put_contents($imageDir101 . DIRECTORY_SEPARATOR . $unreferencedName, $pngBytes);

            // Advance counters and modify data on v1.0.1 before restoring v1.0.0 ZIP
            $db101->exec("UPDATE resource_sequences SET value = 500 WHERE name = 'devices'");
            $db101->exec("UPDATE devices SET name = 'v1.0.1変更後機器' WHERE id = 1");
            $usersBefore101 = $db101->query('SELECT * FROM users ORDER BY id')->fetchAll(\PDO::FETCH_ASSOC);
            $filesBefore101 = $this->restoreFiles($server101->getTempDir() . '/uploads');

            // 1. Restore v1.0.0 Web ZIP into v1.0.1 -> must succeed
            $preview101 = $client101->postMultipart(
                '/api.php?action=preview_backup_restore',
                [],
                ['backup_zip' => ['path' => $zip100Path, 'filename' => 'v100-config.zip', 'type' => 'application/zip']]
            )->assertStatus(200)->getJson();

            $this->assertSame('1.0.0', $preview101['backup']['application_version']);
            $this->assertSame(2, $preview101['image_resolution']['matched']);
            $this->assertSame(1, $preview101['image_resolution']['missing']);
            $this->assertSame(1, $preview101['image_resolution']['mismatched']);

            $client101->postJson('/api.php?action=commit_backup_restore', [
                'restore_token' => $preview101['restore_token'],
                'confirmation' => 'バックアップから復元',
            ])->assertStatus(200);

            // Verify restored data, non-destructive images, preserved sessions/users, and ID counter protection on v1.0.1
            $loaded101 = $client101->get('/api.php?action=load')->assertOk()->getJson();
            $viewer101->get('/api.php?action=load')->assertOk();
            $this->assertSame('v1.0.0構成メモ', $loaded101['canvas_notes'][0]['text']);
            $this->assertSame('v1.0.0基幹系統', $loaded101['link_systems'][0]['name']);
            $this->assertSame($usersBefore101, $db101->query('SELECT * FROM users ORDER BY id')->fetchAll(\PDO::FETCH_ASSOC));
            $this->assertSame($filesBefore101, $this->restoreFiles($server101->getTempDir() . '/uploads'));
            $this->assertSame(1, (int)$db101->query('SELECT COUNT(*) FROM device_images')->fetchColumn());
            $this->assertSame($imageName100, $db101->query('SELECT stored_name FROM device_images')->fetchColumn());
            $this->assertSame(500, (int)$db101->query("SELECT value FROM resource_sequences WHERE name = 'devices'")->fetchColumn());

            // Creating a new device after restore must allocate ID 501 (never reusing <= 500)
            $client101->postJson('/api.php?action=save_resources', [
                'devices' => [[
                    'operation' => 'create',
                    'id' => 800001,
                    'device' => ['id' => 800001, 'name' => '復元後新規機器', 'type' => 'switch', 'ip' => ''],
                ]],
                'views' => [],
            ])->assertStatus(200);
            $this->assertSame(501, (int)$db101->query('SELECT MAX(id) FROM devices')->fetchColumn());

            // 2. Export v1.0.1 Web ZIP and restore v1.0.1 -> v1.0.1 (same-version)
            $zip101Path = $server101->getTempDir() . DIRECTORY_SEPARATOR . 'v101-config.zip';
            file_put_contents($zip101Path, $client101->postJson('/api.php?action=export_backup_zip', [])->assertStatus(200)->getBody());
            $zip = new ZipArchive();
            $this->assertTrue($zip->open($zip101Path) === true);
            $manifest101 = json_decode((string)$zip->getFromName('manifest.json'), true, 512, JSON_THROW_ON_ERROR);
            $this->assertSame('1.0.1', $manifest101['application_version']);
            $zip->close();

            $previewSame101 = $client101->postMultipart(
                '/api.php?action=preview_backup_restore',
                [],
                ['backup_zip' => ['path' => $zip101Path, 'filename' => 'v101-config.zip', 'type' => 'application/zip']]
            )->assertStatus(200)->getJson();
            $this->assertSame('1.0.1', $previewSame101['backup']['application_version']);
            $client101->postJson('/api.php?action=commit_backup_restore', [
                'restore_token' => $previewSame101['restore_token'],
                'confirmation' => 'バックアップから復元',
            ])->assertStatus(200);

            // 3. Reverse restore v1.0.1 -> v1.0.0 must be rejected without mutating v1.0.0 state
            $stateBefore100 = $this->idBoundaryState($db100);
            $usersBefore100 = $db100->query('SELECT * FROM users ORDER BY id')->fetchAll(\PDO::FETCH_ASSOC);
            $filesBefore100 = $this->restoreFiles($server100->getTempDir() . '/uploads');
            $reverseRes = $client100->postMultipart(
                '/api.php?action=preview_backup_restore',
                [],
                ['backup_zip' => ['path' => $zip101Path, 'filename' => 'v101-config.zip', 'type' => 'application/zip']]
            )->assertStatus(400)->getJson();
            $this->assertStringContains('対応するバックアップ元アプリ版: 1.0.0', (string)($reverseRes['error'] ?? ''));
            $this->assertSame($stateBefore100, $this->idBoundaryState($db100));
            $this->assertSame($usersBefore100, $db100->query('SELECT * FROM users ORDER BY id')->fetchAll(\PDO::FETCH_ASSOC));
            $this->assertSame($filesBefore100, $this->restoreFiles($server100->getTempDir() . '/uploads'));

            // 4. Rejections on v1.0.1: unsupported versions, schema/format mismatch, unknown fields
            $stateBeforeReject101 = $this->idBoundaryState($db101);
            $filesBeforeReject101 = $this->restoreFiles($server101->getTempDir() . '/uploads');
            $rejectionMutations = [
                'legacy-0.3.0' => static function (array &$doc, array &$m): void { $m['application_version'] = '0.3.0'; },
                'future-1.0.2' => static function (array &$doc, array &$m): void { $m['application_version'] = '1.0.2'; },
                'future-2.0.0' => static function (array &$doc, array &$m): void { $m['application_version'] = '2.0.0'; },
                'schema-10' => static function (array &$doc, array &$m): void { $m['schema_version'] = 10; },
                'schema-12' => static function (array &$doc, array &$m): void { $m['schema_version'] = 12; },
                'format-v2' => static function (array &$doc, array &$m): void { $m['format_version'] = 2; },
                'unknown-manifest-key' => static function (array &$doc, array &$m): void { $m['unexpected_field'] = 'x'; },
                'unknown-summary-key' => static function (array &$doc, array &$m): void { $m['summary']['unexpected'] = 1; },
                'unknown-file-key' => static function (array &$doc, array &$m): void { $m['files'][0]['unexpected'] = 'x'; },
                'unknown-doc-key' => static function (array &$doc, array &$m): void { $doc['unexpected_field'] = 'x'; },
            ];
            foreach ($rejectionMutations as $label => $mutate) {
                $badZip = $server101->getTempDir() . DIRECTORY_SEPARATOR . "reject-{$label}.zip";
                copy($zip100Path, $badZip);
                $this->rewriteBackupZip($badZip, $mutate);
                $errJson = $client101->postMultipart(
                    '/api.php?action=preview_backup_restore',
                    [],
                    ['backup_zip' => ['path' => $badZip, 'filename' => "{$label}.zip", 'type' => 'application/zip']]
                )->assertStatus(400)->getJson();
                if (in_array($label, ['legacy-0.3.0', 'future-1.0.2', 'future-2.0.0', 'schema-10', 'schema-12'], true)) {
                    $this->assertStringContains('対応するバックアップ元アプリ版: 1.0.1, 1.0.0', (string)($errJson['error'] ?? ''));
                }
            }
            $this->assertSame($stateBeforeReject101, $this->idBoundaryState($db101));
            $this->assertSame($filesBeforeReject101, $this->restoreFiles($server101->getTempDir() . '/uploads'));
            $client101->get('/api.php?action=load')->assertOk();
            $viewer101->get('/api.php?action=load')->assertOk();
        } finally {
            $this->client = $originalClient;
            $db100 = null;
            $db101 = null;
            $server100->stop();
            $server101->stop();
            $this->removeTreeRecursive($v101AppRoot);
        }
    }
}
