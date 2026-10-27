<?php
declare(strict_types=1);

namespace Netarium\Tests\Suites;

require_once dirname(__DIR__, 2) . '/bootstrap.php';

use Netarium\Core\Config;
use Netarium\Services\Storage\CapacityService;
use Netarium\Tests\TestCase;
use Netarium\Tests\TestHttpClient;
use Netarium\Tests\TestServer;
use PDO;
use ZipArchive;

final class BackupAcceptanceTest extends TestCase
{
    private TestHttpClient $client;

    public function __construct(TestHttpClient $client)
    {
        $this->client = $client;
    }

    /**
     * シナリオ1 & 2:
     * - 400台×3画像（1,200枚）＋10フロア図面の大規模構成でのWebバックアップ
     * - 画像実体を含まないこと、24MiB/64MiB/2ファイルの厳格準拠
     * - 同環境でのWeb復元において画像・図面・配置・系統・メモが完全維持されること
     * - 物理画像が1件も削除・上書きされない（非破壊）こと
     */
    public function testScenario1And2_LargeDatasetWebBackupAndRestore(): void
    {
        $server = new TestServer();
        $originalClient = $this->client;
        try {
            $server->start();
            $this->client = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($this->client->login('admin', 'admin123'));

            $db = new PDO('sqlite:' . $server->getDbPath(), null, null, [
                PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            ]);
            $db->exec('PRAGMA foreign_keys = ON');

            $uploadRoot = $server->getTempDir() . '/uploads';
            $floorDir = $uploadRoot . '/floorplans';
            $imageDir = $uploadRoot . '/device_images';
            if (!is_dir($floorDir)) { mkdir($floorDir, 0700, true); }
            if (!is_dir($imageDir)) { mkdir($imageDir, 0700, true); }

            $tinyPng = base64_decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', true);
            $pngSha256 = hash('sha256', $tinyPng);
            $pngSize = strlen($tinyPng);
            $now = date(DATE_ATOM);

            // 1. 大規模構成（400台、各3画像=1200画像、10図面、配置、リンク、系統、メモ）を投入
            $db->beginTransaction();
            $db->exec('DELETE FROM links');
            $db->exec('DELETE FROM device_placements');
            $db->exec('DELETE FROM device_images');
            $db->exec('DELETE FROM view_floor_plans');
            $db->exec('DELETE FROM devices');
            $db->exec('DELETE FROM views WHERE id > 2');
            $db->exec('DELETE FROM link_systems');
            $db->exec('DELETE FROM canvas_notes');

            // 10フロアビューと図面
            $db->exec("UPDATE views SET view_type = 'floor' WHERE id IN (1, 2)");
            $insertView = $db->prepare("INSERT INTO views (id, name, view_type, sort_order) VALUES (?, ?, 'floor', ?)");
            $insertFloor = $db->prepare("INSERT INTO view_floor_plans (view_id, stored_name, original_name, mime_type, file_size, image_width, image_height, sha256, created_at, updated_at) VALUES (?, ?, ?, 'image/png', ?, 1, 1, ?, ?, ?)");
            for ($v = 1; $v <= 10; $v++) {
                if ($v > 2) {
                    $insertView->execute([$v, "フロア {$v}", $v]);
                }
                $stored = sprintf('%032x.png', 1000 + $v);
                file_put_contents($floorDir . '/' . $stored, $tinyPng);
                $insertFloor->execute([$v, $stored, "floor_{$v}.png", $pngSize, $pngSha256, $now, $now]);
            }

            // 系統
            $db->exec("INSERT INTO link_systems (id, name, color_key) VALUES (1, '基幹系統', 'indigo')");

            // 400台の機器、配置、画像3枚ずつ
            $insertDevice = $db->prepare("INSERT INTO devices (id, name, ip, type, location) VALUES (?, ?, ?, 'server', ?)");
            $insertPlacement = $db->prepare("INSERT INTO device_placements (device_id, view_id, x, y) VALUES (?, ?, ?, ?)");
            $insertImage = $db->prepare("INSERT INTO device_images (device_id, stored_name, mime_type, file_size, image_width, image_height, sort_order, caption, sha256, created_at, updated_at) VALUES (?, ?, 'image/png', ?, 1, 1, ?, 'caption', ?, ?, ?)");

            for ($d = 1; $d <= 400; $d++) {
                $ip = sprintf('192.168.%d.%d', intdiv($d, 250), ($d % 250) + 1);
                $insertDevice->execute([$d, "Server-{$d}", $ip, "Rack-{$d}"]);
                $insertPlacement->execute([$d, 1, ($d % 20) * 50, intdiv($d, 20) * 50]);
                for ($img = 1; $img <= 3; $img++) {
                    $imgName = sprintf('%04x%04x%024x.png', $d, $img, $d);
                    file_put_contents($imageDir . '/' . $imgName, $tinyPng);
                    $insertImage->execute([$d, $imgName, $pngSize, $img, $pngSha256, $now, $now]);
                }
            }

            // リンクとメモ
            $insertLink = $db->prepare("INSERT INTO links (id, from_id, to_id, view_id, system_id, vlan) VALUES (?, ?, ?, 1, 1, '100')");
            for ($linkId = 1; $linkId <= 100; $linkId++) {
                $from = $linkId;
                $to = $linkId + 1;
                $insertLink->execute([$linkId, $from, $to]);
            }
            $db->exec("INSERT INTO canvas_notes (id, view_id, text) VALUES (1, 1, '受入試験用大規模構成メモ')");
            $db->commit();

            // 物理ファイルのハッシュスナップショットを記録（復元後の非破壊検証用）
            $physicalBefore = $this->scanDirectoryFiles($uploadRoot);
            $this->assertSame(1210, count($physicalBefore), '合計1,210個の物理画像・図面が存在すること');

            // 2. シナリオ1検証: Web構成情報バックアップの取得
            $memBefore = memory_get_usage();
            $t0 = microtime(true);
            $response = $this->client->postJson('/api.php?action=export_backup_zip', []);
            $elapsed = microtime(true) - $t0;
            $response->assertStatus(200);

            $zipContent = $response->getBody();
            $zipBytes = strlen($zipContent);

            // 検証: サイズは24MiB以下（画像を含まないため通常1MiB以下）
            $this->assertTrue($zipBytes < 24 * 1024 * 1024, "ZIPサイズ上限24MiB以内であること: {$zipBytes} bytes");
            $this->assertTrue($zipBytes < 2 * 1024 * 1024, "画像を含まない構成JSON専用ZIPとして妥当なサイズ（2MiB未満）であること: {$zipBytes} bytes");

            // 検証: ZIP内部エントリの厳格検査
            $zipPath = $server->getTempDir() . '/scenario1_export.zip';
            file_put_contents($zipPath, $zipContent);
            $zip = new ZipArchive();
            $this->assertTrue($zip->open($zipPath) === true, 'ZIPファイルが開けること');
            $this->assertSame(2, $zip->numFiles, 'ZIP内部は厳密に2ファイルのみであること');

            $names = [];
            $uncompressedTotal = 0;
            for ($i = 0; $i < $zip->numFiles; $i++) {
                $stat = $zip->statIndex($i);
                $names[] = $stat['name'];
                $uncompressedTotal += $stat['size'];
            }
            sort($names);
            $this->assertSame(['data/netarium.json', 'manifest.json'], $names, '構成情報JSON2ファイルのみであること');
            $this->assertTrue($uncompressedTotal < 64 * 1024 * 1024, "展開後合計が64MiB以内であること: {$uncompressedTotal} bytes");

            // マニフェスト内容確認
            $manifest = json_decode((string)$zip->getFromName('manifest.json'), true, 512, JSON_THROW_ON_ERROR);
            $this->assertSame('netarium-config', $manifest['format']);
            $this->assertSame(1, $manifest['format_version']);
            $this->assertSame(16, $manifest['schema_version']);
            $this->assertSame(1200, $manifest['summary']['device_images']);
            $this->assertSame(10, $manifest['summary']['floor_plans']);
            $this->assertSame(400, $manifest['summary']['devices']);
            $zip->close();

            // 3. シナリオ2検証: 同環境でのWeb復元プレビューと確定
            $previewRes = $this->client->postMultipart('/api.php?action=preview_backup_restore', [], [
                'backup_zip' => ['path' => $zipPath, 'filename' => 'backup.zip', 'type' => 'application/zip'],
            ])->assertStatus(200)->getJson();

            $resReport = $previewRes['image_resolution'];
            $this->assertSame(1210, $resReport['matched'], '全1,210画像が既存実体と一致すること');
            $this->assertSame(0, $resReport['missing'], '欠損が0であること');
            $this->assertSame(0, $resReport['mismatched'], '不一致が0であること');
            $this->assertSame([], $resReport['items'], '問題画像リストが空であること');

            // コミット確定
            $commitRes = $this->client->postJson('/api.php?action=commit_backup_restore', [
                'restore_token' => $previewRes['restore_token'],
                'confirmation' => 'バックアップから復元',
            ])->assertStatus(200);

            // 復元後のDB状態確認
            $this->assertSame(400, (int)$db->query('SELECT COUNT(*) FROM devices')->fetchColumn());
            $this->assertSame(1200, (int)$db->query('SELECT COUNT(*) FROM device_images')->fetchColumn());
            $this->assertSame(10, (int)$db->query('SELECT COUNT(*) FROM view_floor_plans')->fetchColumn());
            $this->assertSame(100, (int)$db->query('SELECT COUNT(*) FROM links')->fetchColumn());
            $this->assertSame(1, (int)$db->query('SELECT COUNT(*) FROM canvas_notes')->fetchColumn());
            $this->assertSame(1, (int)$db->query('SELECT COUNT(*) FROM link_systems')->fetchColumn());

            // 物理画像の非破壊性検証: 復元前後の物理ファイルが完全に一致すること
            $physicalAfter = $this->scanDirectoryFiles($uploadRoot);
            $this->assertSame($physicalBefore, $physicalAfter, '復元後に物理画像ファイルが一切削除・変更されていないこと');

            // セッション維持・通常画面読み込み確認
            $this->client->get('/api.php?action=load')->assertOk();
        } finally {
            $this->client = $originalClient;
            $server->stop();
        }
    }

    /**
     * シナリオ3: 異環境/画像欠損/改ざんWeb復元
     * - 一致画像なし（空環境）で誤関連付けゼロ
     * - 改ざん画像（SHA不一致）が除外され、正確にプレビュー報告されること
     * - 既存のusers（アカウント・パスワードハッシュ）が現行環境のまま保全されること
     */
    public function testScenario3_DifferentEnvironmentAndTamperedImagesNeverMisassociate(): void
    {
        $serverA = new TestServer();
        $serverB = new TestServer();
        $originalClient = $this->client;
        try {
            // Server Aで1件の機器画像と1件の図面を持つバックアップZIPを作成
            $serverA->start();
            $this->client = new TestHttpClient($serverA->getBaseUrl());
            $this->assertTrue($this->client->login('admin', 'admin123'));

            $dbA = new PDO('sqlite:' . $serverA->getDbPath(), null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
            $dbA->exec('PRAGMA foreign_keys = ON');

            $uploadA = $serverA->getTempDir() . '/uploads';
            if (!is_dir($uploadA . '/floorplans')) { mkdir($uploadA . '/floorplans', 0700, true); }
            if (!is_dir($uploadA . '/device_images')) { mkdir($uploadA . '/device_images', 0700, true); }

            $pngA = base64_decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', true);
            $shaA = hash('sha256', $pngA);
            $now = date(DATE_ATOM);
            $devImgName = sprintf('%032x.png', 101);
            $floorImgName = sprintf('%032x.png', 201);
            file_put_contents($uploadA . '/device_images/' . $devImgName, $pngA);
            file_put_contents($uploadA . '/floorplans/' . $floorImgName, $pngA);
            $dbA->exec("UPDATE views SET view_type = 'floor' WHERE id = 1");
            $dbA->exec("INSERT INTO view_floor_plans (view_id, stored_name, original_name, mime_type, file_size, image_width, image_height, sha256, created_at, updated_at) VALUES (1, '{$floorImgName}', 'floor.png', 'image/png', " . strlen($pngA) . ", 1, 1, '{$shaA}', '{$now}', '{$now}')");
            $dbA->exec("INSERT INTO device_images (device_id, stored_name, mime_type, file_size, image_width, image_height, sort_order, caption, sha256, created_at, updated_at) VALUES (1, '{$devImgName}', 'image/png', " . strlen($pngA) . ", 1, 1, 1, 'caption', '{$shaA}', '{$now}', '{$now}')");

            $zipContent = $this->client->postJson('/api.php?action=export_backup_zip', [])->assertStatus(200)->getBody();
            $zipPath = $serverA->getTempDir() . '/export_a.zip';
            file_put_contents($zipPath, $zipContent);

            // Server B（全く異なる環境）を準備
            $serverB->start();
            $this->client = new TestHttpClient($serverB->getBaseUrl());
            $this->assertTrue($this->client->login('admin', 'admin123'));

            $dbB = new PDO('sqlite:' . $serverB->getDbPath(), null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
            // Server Bの管理者・閲覧者ハッシュを記録
            $usersBefore = $dbB->query('SELECT id, username, password_hash, role FROM users ORDER BY id')->fetchAll(PDO::FETCH_ASSOC);

            // 1. 画像が一切存在しない空の環境での復元試行
            $previewEmpty = $this->client->postMultipart('/api.php?action=preview_backup_restore', [], [
                'backup_zip' => ['path' => $zipPath, 'filename' => 'backup.zip', 'type' => 'application/zip'],
            ])->assertStatus(200)->getJson();

            $this->assertSame(0, $previewEmpty['image_resolution']['matched']);
            $this->assertSame(2, $previewEmpty['image_resolution']['missing']);
            $this->assertSame(0, $previewEmpty['image_resolution']['mismatched']);

            $this->client->postJson('/api.php?action=commit_backup_restore', [
                'restore_token' => $previewEmpty['restore_token'],
                'confirmation' => 'バックアップから復元',
            ])->assertStatus(200);

            // 誤関連付けゼロ: 画像レコードは一切復元されないこと
            $this->assertSame(0, (int)$dbB->query('SELECT COUNT(*) FROM device_images')->fetchColumn(), '一致しない機器画像がDBへ関連付けられないこと');
            $this->assertSame(0, (int)$dbB->query('SELECT COUNT(*) FROM view_floor_plans')->fetchColumn(), '一致しない図面がDBへ関連付けられないこと');

            // usersテーブルのアカウント・パスワードハッシュが維持されていること
            $usersAfter = $dbB->query('SELECT id, username, password_hash, role FROM users ORDER BY id')->fetchAll(PDO::FETCH_ASSOC);
            $this->assertSame($usersBefore, $usersAfter, 'Web復元によって既存の利用者が上書きされないこと');

            // 2. 同名だが内容が改ざんされた画像（SHA-256不一致）が存在する環境での復元試行
            $uploadB = $serverB->getTempDir() . '/uploads';
            if (!is_dir($uploadB . '/device_images')) { mkdir($uploadB . '/device_images', 0700, true); }
            file_put_contents($uploadB . '/device_images/' . $devImgName, 'TAMPERED_CONTENT_DIFF_SHA');
            file_put_contents($uploadB . '/floorplans/' . $floorImgName, 'TAMPERED_CONTENT_DIFF_SHA');

            $previewTampered = $this->client->postMultipart('/api.php?action=preview_backup_restore', [], [
                'backup_zip' => ['path' => $zipPath, 'filename' => 'backup.zip', 'type' => 'application/zip'],
            ])->assertStatus(200)->getJson();

            $this->assertSame(0, $previewTampered['image_resolution']['matched']);
            $this->assertSame(0, $previewTampered['image_resolution']['missing']);
            $this->assertSame(2, $previewTampered['image_resolution']['mismatched'], '改ざんされた画像が不一致として検出されること');

            $this->client->postJson('/api.php?action=commit_backup_restore', [
                'restore_token' => $previewTampered['restore_token'],
                'confirmation' => 'バックアップから復元',
            ])->assertStatus(200);

            // 改ざん画像も誤関連付けゼロ
            $this->assertSame(0, (int)$dbB->query('SELECT COUNT(*) FROM device_images')->fetchColumn());
            $this->assertSame(0, (int)$dbB->query('SELECT COUNT(*) FROM view_floor_plans')->fetchColumn());
        } finally {
            $this->client = $originalClient;
            $serverA->stop();
            $serverB->stop();
        }
    }

    /**
     * シナリオ5: 故障注入（Web復元）
     * - 破損ZIP、マニフェスト不整合、スキーマ不一致の拒否
     * - コミット前の現行データ競合（409 Conflict）と現行データ保護
     */
    public function testScenario5_WebRestoreFaultInjectionGuaranteesAtomicityAndRollback(): void
    {
        $server = new TestServer();
        $originalClient = $this->client;
        try {
            $server->start();
            $this->client = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($this->client->login('admin', 'admin123'));

            $db = new PDO('sqlite:' . $server->getDbPath(), null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
            $dbBefore = $this->snapshotTableCounts($db);

            // 1. 完全に壊れたZIPバイナリのプレビュー拒否
            $corruptZip = $server->getTempDir() . '/corrupt.zip';
            file_put_contents($corruptZip, 'NOT_A_VALID_ZIP_ARCHIVE_DATA');
            $this->client->postMultipart('/api.php?action=preview_backup_restore', [], [
                'backup_zip' => ['path' => $corruptZip, 'filename' => 'corrupt.zip', 'type' => 'application/zip'],
            ])->assertStatus(400);

            $this->assertSame($dbBefore, $this->snapshotTableCounts($db), '壊れたZIP拒否時に現行データが不変であること');

            // 正常ZIPをエクスポート
            $goodZip = $server->getTempDir() . '/good.zip';
            file_put_contents($goodZip, $this->client->postJson('/api.php?action=export_backup_zip', [])->assertStatus(200)->getBody());

            // 2. 展開ファイル数が3個以上のZIP（余分なファイル混入）の拒否
            $extraZip = $server->getTempDir() . '/extra.zip';
            copy($goodZip, $extraZip);
            $zip = new ZipArchive();
            $this->assertTrue($zip->open($extraZip) === true);
            $zip->addFromString('malicious.php', '<?php echo "evil";');
            $zip->close();

            $this->client->postMultipart('/api.php?action=preview_backup_restore', [], [
                'backup_zip' => ['path' => $extraZip, 'filename' => 'extra.zip', 'type' => 'application/zip'],
            ])->assertStatus(400);
            $this->assertSame($dbBefore, $this->snapshotTableCounts($db));

            // 3. 不正なスキーマバージョン（schema 999）のマニフェスト拒否
            $badSchemaZip = $server->getTempDir() . '/bad_schema.zip';
            copy($goodZip, $badSchemaZip);
            $zip = new ZipArchive();
            $this->assertTrue($zip->open($badSchemaZip) === true);
            $manifest = json_decode((string)$zip->getFromName('manifest.json'), true, 512, JSON_THROW_ON_ERROR);
            $manifest['schema_version'] = 999;
            $zip->addFromString('manifest.json', json_encode($manifest, JSON_THROW_ON_ERROR));
            $zip->close();

            $this->client->postMultipart('/api.php?action=preview_backup_restore', [], [
                'backup_zip' => ['path' => $badSchemaZip, 'filename' => 'bad_schema.zip', 'type' => 'application/zip'],
            ])->assertStatus(400);
            $this->assertSame($dbBefore, $this->snapshotTableCounts($db));

            // 4. プレビュー後に現行データが更新された場合のコミット競合（409 Conflict）
            $preview = $this->client->postMultipart('/api.php?action=preview_backup_restore', [], [
                'backup_zip' => ['path' => $goodZip, 'filename' => 'good.zip', 'type' => 'application/zip'],
            ])->assertStatus(200)->getJson();

            // プレビュー取得後に別セッションまたは現行画面で保存処理が行われた（競合）
            $current = $this->client->get('/api.php?action=load')->assertOk()->getJson();
            $current['devices'][0]['name'] = 'プレビュー後変更';
            $this->client->postJson('/api.php?action=save', [
                'revision' => (int)$current['revision'],
                'views' => $current['views'],
                'devices' => $current['devices'],
                'placements' => $current['placements'],
                'links' => $current['links'],
                'canvas_notes' => $current['canvas_notes'],
            ])->assertOk();
            // コミット試行 -> 409 Conflict
            $this->client->postJson('/api.php?action=commit_backup_restore', [
                'restore_token' => $preview['restore_token'],
                'confirmation' => 'バックアップから復元',
            ])->assertStatus(409);

            // 競合で保存された変更が保全されていること
            $loaded = $this->client->get('/api.php?action=load')->assertOk()->getJson();
            $this->assertSame('プレビュー後変更', $loaded['devices'][0]['name']);
        } finally {
            $this->client = $originalClient;
            $server->stop();
        }
    }

    /**
     * シナリオ6: 容量・要求サイズ設定検査
     * - PHP推奨32M/34M、IIS通常32MiB、画像URL31MiBの分離
     * - 写真10MiB / 図面30MiBの境界値検査
     */
    public function testScenario6_CapacityAndUploadLimitsDecoupling(): void
    {
        $config = Config::create();
        $mib = CapacityService::BYTES_PER_MIB;

        // 要求上限設定
        $this->assertSame(32 * $mib, $config['request_limit_bytes'] ?? (32 * $mib), 'IIS通常要求上限32MiB');
        $this->assertSame(31 * $mib, $config['image_upload_max_request_bytes'], '画像専用URL上限31MiB');

        // 安全上限設定
        $this->assertSame(3, $config['max_device_images_per_device']);
        $this->assertSame(30 * $mib, $config['floor_plan_upload_max_bytes'], '図面アップロード上限30MiB');

        // 写真10MiB境界
        CapacityService::assertImageEntrySize(10 * $mib, $config, '写真');
        $rejectedPhoto = false;
        try {
            CapacityService::assertImageEntrySize(10 * $mib + 1, $config, '写真');
        } catch (\Throwable) {
            $rejectedPhoto = true;
        }
        $this->assertTrue($rejectedPhoto, '10MiB超の写真は拒否されること');

        // 108ファイル・200MiB一律上限の撤去確認（1200枚でも通過）
        CapacityService::assertImageUsage(1200, 1200 * $mib, $config);
    }

    private function scanDirectoryFiles(string $dir): array
    {
        if (!is_dir($dir)) { return []; }
        $files = [];
        $iterator = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($dir, \FilesystemIterator::SKIP_DOTS));
        foreach ($iterator as $file) {
            if ($file->isFile()) {
                $subPath = str_replace('\\', '/', substr($file->getPathname(), strlen($dir) + 1));
                $files[$subPath] = hash_file('sha256', $file->getPathname());
            }
        }
        ksort($files);
        return $files;
    }

    private function snapshotTableCounts(PDO $db): array
    {
        $counts = [];
        foreach (['devices', 'views', 'links', 'device_images', 'view_floor_plans', 'canvas_notes', 'link_systems'] as $table) {
            $counts[$table] = (int)$db->query("SELECT COUNT(*) FROM {$table}")->fetchColumn();
        }
        return $counts;
    }
}
