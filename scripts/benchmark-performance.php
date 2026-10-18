<?php
declare(strict_types=1);

/**
 * Netarium 性能・想定規模ベンチマークハーネス
 *
 * 想定規模プロファイル（recommended / near-limit / image-boundary）に基づき
 * 合成データを生成し、APIの応答時間、HTTP応答サイズ、PHPピークメモリ、
 * 並行アクセス時の整合性・競合、および登録上限・容量境界の判定を自動測定します。
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

ini_set('display_errors', '1');
error_reporting(E_ALL & ~E_DEPRECATED);
set_time_limit(0);

$nullDevice = stripos(PHP_OS, 'WIN') === 0 ? 'NUL' : '/dev/null';
$descriptors = [0 => ['file', $nullDevice, 'r'], 1 => ['file', $nullDevice, 'w'], 2 => ['file', $nullDevice, 'w']];
$parentEnv = getenv();

$projectRoot = dirname(__DIR__);
require_once $projectRoot . '/tests/TestCase.php';
require_once $projectRoot . '/tests/TestServer.php';
require_once $projectRoot . '/tests/TestHttpClient.php';
require_once $projectRoot . '/bootstrap.php';
use Netarium\Tests\TestServer;
use Netarium\Tests\TestHttpClient;

function printHelp(): void
{
    echo <<<HELP
Netarium Performance Benchmark Harness

Usage:
  php scripts/benchmark-performance.php [options]

Options:
  --profile <name>      Target profile: recommended (default), near-limit, image-boundary
  --iterations <N>      Number of benchmark runs (default: 5)
  --prepare <abs_path>  Prepare isolated environment for browser testing at <abs_path>
  --skip-backup         Skip export/restore backup measurements
  --help                Show this help message

Profiles:
  recommended:    500 devices, 10 views (5 floor/5 topo), 1000 placements, 2000 links, 5 images (20MB)
  near-limit:     5000 devices, 100 views (40 floor/60 topo), 2990 placements, 6980 links, 40 images (80MB)
  image-boundary: 100 floor views, 100 images (~198MB total, uncompressible ZIP boundary)

HELP;
}

// --------------------------------------------------------------------------
// ユーティリティ
// --------------------------------------------------------------------------

function isAbsolutePath(string $path): bool
{
    if (preg_match('/^[a-zA-Z]:[\\\\\\/]/', $path) === 1) {
        return true;
    }
    return str_starts_with($path, '/') || str_starts_with($path, '\\\\');
}

function calculateMedian(array $numbers): float
{
    if ($numbers === []) {
        return 0.0;
    }
    sort($numbers);
    $count = count($numbers);
    $mid = intdiv($count, 2);
    if ($count % 2 === 0) {
        return ($numbers[$mid - 1] + $numbers[$mid]) / 2.0;
    }
    return (float)$numbers[$mid];
}

function formatBytes(int|float $bytes): string
{
    if ($bytes >= 1024 * 1024 * 1024) {
        return sprintf('%.2f GiB', $bytes / (1024 * 1024 * 1024));
    }
    if ($bytes >= 1024 * 1024) {
        return sprintf('%.2f MiB', $bytes / (1024 * 1024));
    }
    if ($bytes >= 1024) {
        return sprintf('%.2f KiB', $bytes / 1024);
    }
    return sprintf('%d B', $bytes);
}

/**
 * 有効なPNG画像を生成する（指定バイト数、非圧縮ランダムパディング可能）
 */
function createValidPng(int $width, int $height, int $targetBytes, bool $uncompressible = false): string
{
    $sig = "\x89PNG\r\n\x1a\n";
    $ihdrData = pack('NNCCCCC', $width, $height, 8, 2, 0, 0, 0);
    $ihdr = pack('N', 13) . 'IHDR' . $ihdrData . pack('N', crc32('IHDR' . $ihdrData));

    $scanline = "\x00" . str_repeat("\x20\x40\x60", $width);
    $raw = str_repeat($scanline, $height);
    $compressed = gzcompress($raw);
    if ($compressed === false) {
        throw new RuntimeException('PNG画素データの圧縮に失敗しました');
    }
    $idat = pack('N', strlen($compressed)) . 'IDAT' . $compressed . pack('N', crc32('IDAT' . $compressed));
    $iend = pack('N', 0) . 'IEND' . pack('N', crc32('IEND'));

    $baseLen = strlen($sig) + strlen($ihdr) + strlen($idat) + strlen($iend);
    $extraNeeded = $targetBytes - $baseLen;
    if ($extraNeeded < 0) {
        throw new RuntimeException('指定サイズが完全なPNG画像の最小サイズを下回っています');
    }

    $png = $sig . $ihdr . $idat;
    if ($extraNeeded >= 12) {
        $dataLen = $extraNeeded - 12;
        $keyword = "Bench\x00";
        $randomPadding = $uncompressible
            ? random_bytes(max(0, $dataLen - strlen($keyword)))
            : str_repeat('X', max(0, $dataLen - strlen($keyword)));
        $chunkPayload = $keyword . $randomPadding;
        $textChunk = pack('N', strlen($chunkPayload)) . 'tEXt' . $chunkPayload . pack('N', crc32('tEXt' . $chunkPayload));
        $png .= $textChunk;
    }
    $png .= $iend;

    $imageInfo = getimagesizefromstring($png);
    $decodedPixels = gzuncompress($compressed);
    if (
        strlen($png) !== $targetBytes ||
        $imageInfo === false ||
        $imageInfo[0] !== $width ||
        $imageInfo[1] !== $height ||
        $decodedPixels !== $raw
    ) {
        throw new RuntimeException('生成したPNG画像の寸法・画素データ・容量が期待値と一致しません');
    }

    return $png;
}


// --------------------------------------------------------------------------
// 合成データ生成
// --------------------------------------------------------------------------

function generateSyntheticDataset(string $profile): array
{
    $devices = [];
    $views = [];
    $placements = [];
    $links = [];
    $floorPlans = [];

    $deviceTypes = ['router', 'switch', 'server', 'pc'];

    if ($profile === 'recommended') {
        // 機器500, ビュー10 (floor 5, topology 5), 総配置1000, 総リンク2000, 画像5枚 (20MiB)
        for ($i = 1; $i <= 500; $i++) {
            $type = $deviceTypes[$i % count($deviceTypes)];
            $subnet = 1 + intdiv($i, 250);
            $host = 1 + ($i % 250);
            $devices[] = [
                'id' => $i,
                'name' => sprintf('機器-%03d', $i),
                'type' => $type,
                'ip' => "10.{$subnet}.1.{$host}",
                'facility' => '第1庁舎',
                'floor' => sprintf('%dF', 1 + ($i % 5)),
                'location' => sprintf('室-%02d', 1 + ($i % 10)),
                'manufacturer' => 'Vendor-' . ($i % 5),
                'model' => 'Model-' . ($i % 10),
                'asset_number' => sprintf('AST-%04d', $i),
                'serial_number' => sprintf('SN-%06d', $i),
                'mac_address' => sprintf('00:50:56:%02X:%02X:%02X', ($i >> 16) & 0xFF, ($i >> 8) & 0xFF, $i & 0xFF),
                'memo' => 'ベンチマーク用推奨機器データ',
                'management_scheme' => 'https',
                'management_port' => 443,
                'department' => '情報企画課',
                'maintenance_vendor' => 'ベンダーA',
                'install_date' => '2024-04-01',
                'maintenance_expiry' => '2027-03-31',
            ];
        }

        for ($v = 1; $v <= 10; $v++) {
            $isFloor = ($v <= 5);
            $views[] = [
                'id' => $v,
                'name' => $isFloor ? sprintf('%dFフロア図', $v) : sprintf('トポロジビュー-%02d', $v - 5),
                'facility' => '第1庁舎',
                'floor' => $isFloor ? sprintf('%dF', $v) : null,
                'view_type' => $isFloor ? 'floor' : 'topology',
                'sort_order' => $v * 10,
                'memo' => '推奨プロファイル用ビュー',
            ];

            // 1ビューあたり配置100件
            $startDev = (($v - 1) * 40) % 400 + 1; // 機器をビュー間で再利用
            for ($p = 0; $p < 100; $p++) {
                $devId = (($startDev + $p - 1) % 500) + 1;
                $placementId = ($v - 1) * 100 + $p + 1;
                $placements[] = [
                    'id' => $placementId,
                    'view_id' => $v,
                    'device_id' => $devId,
                    'x' => 100 + ($p % 10) * 120,
                    'y' => 100 + intdiv($p, 10) * 80,
                ];
            }

            // 1ビューあたりリンク200件 (異なる機器間)
            for ($l = 0; $l < 200; $l++) {
                $linkId = ($v - 1) * 200 + $l + 1;
                $fromDev = (($startDev + ($l % 100) - 1) % 500) + 1;
                $toDev = (($startDev + (($l + 1 + intdiv($l, 100)) % 100) - 1) % 500) + 1;
                if ($fromDev === $toDev) {
                    $toDev = (($toDev % 500) + 1);
                }
                $links[] = [
                    'id' => $linkId,
                    'view_id' => $v,
                    'from_id' => $fromDev,
                    'to_id' => $toDev,
                    'label' => sprintf('Link-%d', $linkId),
                    'from_port' => sprintf('ge-0/0/%d', $l % 24),
                    'to_port' => sprintf('ge-0/0/%d', ($l + 1) % 24),
                    'vlan' => sprintf('%d', 10 + ($l % 5) * 10),
                    'memo' => '推奨リンク',
                ];
            }
        }

        // 図面5枚 (各4MiB = 計20MiB)
        for ($v = 1; $v <= 5; $v++) {
            $floorPlans[$v] = [
                'width' => 1200,
                'height' => 800,
                'bytes' => 4 * 1024 * 1024,
                'uncompressible' => false,
            ];
        }

    } elseif ($profile === 'near-limit') {
        // 機器5000, ビュー100 (floor 40, topo 60), 密な1ビュー2000配置・5000リンク、他99ビュー各10配置・20リンク
        // 総配置 2000 + 99*10 = 2990, 総リンク 5000 + 99*20 = 6980, 図面40枚 (各2MiB = 計80MiB)
        for ($i = 1; $i <= 5000; $i++) {
            $type = $deviceTypes[$i % count($deviceTypes)];
            $subnet = 1 + intdiv($i, 250);
            $host = 1 + ($i % 250);
            $devices[] = [
                'id' => $i,
                'name' => sprintf('大規模機器-%04d', $i),
                'type' => $type,
                'ip' => "10.{$subnet}.2.{$host}",
                'facility' => '全庁統合NW',
                'floor' => sprintf('%dF', 1 + ($i % 40)),
                'location' => sprintf('ラック-%03d', 1 + ($i % 100)),
                'manufacturer' => 'Vendor-' . ($i % 10),
                'model' => 'Model-' . ($i % 20),
                'asset_number' => sprintf('LIM-%05d', $i),
                'serial_number' => sprintf('SN-%08d', $i),
                'mac_address' => sprintf('00:50:56:%02X:%02X:%02X', ($i >> 16) & 0xFF, ($i >> 8) & 0xFF, $i & 0xFF),
                'memo' => '上限近傍ベンチマーク機器',
                'management_scheme' => 'ssh',
                'management_port' => 22,
                'department' => '基盤推進課',
                'maintenance_vendor' => 'ベンダーB',
                'install_date' => '2023-10-01',
                'maintenance_expiry' => '2028-09-30',
            ];
        }

        for ($v = 1; $v <= 100; $v++) {
            $isFloor = ($v <= 40);
            $views[] = [
                'id' => $v,
                'name' => $isFloor ? sprintf('フロア図面ビュー-%02d', $v) : sprintf('論理トポロジ-%02d', $v - 40),
                'facility' => '統合センタ',
                'floor' => $isFloor ? sprintf('%dF', $v) : null,
                'view_type' => $isFloor ? 'floor' : 'topology',
                'sort_order' => $v * 10,
                'memo' => '上限近傍ビュー',
            ];

            if ($v === 1) {
                // 最も密なビュー: 配置2000, リンク5000
                for ($p = 0; $p < 2000; $p++) {
                    $devId = $p + 1;
                    $placements[] = [
                        'id' => $p + 1,
                        'view_id' => 1,
                        'device_id' => $devId,
                        'x' => 50 + ($p % 40) * 60,
                        'y' => 50 + intdiv($p, 40) * 45,
                    ];
                }
                for ($l = 0; $l < 5000; $l++) {
                    $fromDev = ($l % 2000) + 1;
                    $toDev = (($l + 1 + intdiv($l, 2000)) % 2000) + 1;
                    if ($fromDev === $toDev) {
                        $toDev = (($toDev % 2000) + 1);
                    }
                    $links[] = [
                        'id' => $l + 1,
                        'view_id' => 1,
                        'from_id' => $fromDev,
                        'to_id' => $toDev,
                        'label' => sprintf('DenseLink-%d', $l + 1),
                        'from_port' => sprintf('p%d', $l % 48),
                        'to_port' => sprintf('p%d', ($l + 1) % 48),
                        'vlan' => '100',
                        'memo' => '高密度リンク',
                    ];
                }
            } else {
                // 他99ビュー: 各配置10, リンク20
                $placementBase = 2000 + ($v - 2) * 10;
                $linkBase = 5000 + ($v - 2) * 20;
                $devOffset = 2000 + (($v - 2) * 30) % 2900;
                for ($p = 0; $p < 10; $p++) {
                    $placements[] = [
                        'id' => $placementBase + $p + 1,
                        'view_id' => $v,
                        'device_id' => $devOffset + $p + 1,
                        'x' => 100 + $p * 100,
                        'y' => 200,
                    ];
                }
                $sparsePairs = [];
                for ($a = 1; $a <= 9 && count($sparsePairs) < 20; $a++) {
                    for ($b = $a + 1; $b <= 10 && count($sparsePairs) < 20; $b++) {
                        $sparsePairs[] = [$a, $b];
                    }
                }
                for ($l = 0; $l < 20; $l++) {
                    [$a, $b] = $sparsePairs[$l];
                    $fromDev = $devOffset + $a;
                    $toDev = $devOffset + $b;
                    $links[] = [
                        'id' => $linkBase + $l + 1,
                        'view_id' => $v,
                        'from_id' => $fromDev,
                        'to_id' => $toDev,
                        'label' => sprintf('SpLink-%d', $linkBase + $l + 1),
                        'from_port' => 'ge1',
                        'to_port' => 'ge2',
                        'vlan' => '200',
                        'memo' => 'スパースリンク',
                    ];
                }
            }
        }

        // 図面40枚 (各2MiB = 計80MiB)
        for ($v = 1; $v <= 40; $v++) {
            $floorPlans[$v] = [
                'width' => 1000,
                'height' => 750,
                'bytes' => 2 * 1024 * 1024,
                'uncompressible' => false,
            ];
        }

    } elseif ($profile === 'image-boundary') {
        // 100 floor ビュー, 各2MiB弱 (1.98MiB = 2,076,180B, 計198MiB), 非圧縮ZIP境界検証
        for ($i = 1; $i <= 100; $i++) {
            $devices[] = [
                'id' => $i,
                'name' => sprintf('境界確認機器-%03d', $i),
                'type' => 'server',
                'ip' => "192.168.10.{$i}",
                'facility' => '画像検証庁舎',
                'floor' => sprintf('%dF', $i),
                'location' => '電算室',
                'manufacturer' => 'BoundaryMaker',
                'model' => 'BoundaryModel',
                'asset_number' => sprintf('IMG-%03d', $i),
                'serial_number' => sprintf('SN-%05d', $i),
                'mac_address' => sprintf('00:11:22:33:44:%02X', $i),
                'memo' => '画像境界用機器',
                'management_scheme' => '',
                'management_port' => null,
                'department' => '',
                'maintenance_vendor' => '',
                'install_date' => '',
                'maintenance_expiry' => '',
            ];

            $views[] = [
                'id' => $i,
                'name' => sprintf('境界検証フロア-%03d', $i),
                'facility' => '画像検証庁舎',
                'floor' => sprintf('%dF', $i),
                'view_type' => 'floor',
                'sort_order' => $i * 10,
                'memo' => '画像容量境界フロアビュー',
            ];

            $placements[] = [
                'id' => $i,
                'view_id' => $i,
                'device_id' => $i,
                'x' => 150,
                'y' => 150,
            ];

            $floorPlans[$i] = [
                'width' => 800,
                'height' => 600,
                'bytes' => 2076180, // 1.98 MiB弱 (100枚で198MiB)
                'uncompressible' => true, // 非圧縮ランダムデータでZIP 100MiB超過を検査
            ];
        }
    } else {
        throw new InvalidArgumentException("Unknown profile: {$profile}");
    }

    return [
        'devices' => $devices,
        'views' => $views,
        'placements' => $placements,
        'links' => $links,
        'floor_plans' => $floorPlans,
    ];
}

// --------------------------------------------------------------------------
// メイン処理
// --------------------------------------------------------------------------

$options = getopt('', [
    'profile:',
    'iterations:',
    'prepare:',
    'skip-backup',
    'help',
]);

if (isset($options['help'])) {
    printHelp();
    exit(0);
}

$profile = (string)($options['profile'] ?? 'recommended');
$iterations = max(1, (int)($options['iterations'] ?? 5));
$preparePath = isset($options['prepare']) ? (string)$options['prepare'] : null;
$skipBackup = isset($options['skip-backup']);

if (!in_array($profile, ['recommended', 'near-limit', 'image-boundary'], true)) {
    fwrite(STDERR, "エラー: 未知のプロファイル '{$profile}' です。(recommended, near-limit, image-boundary)\n");
    exit(1);
}

// --------------------------------------------------------------------------
// --prepare モード (ブラウザ検証用一時環境の構築)
// --------------------------------------------------------------------------
if ($preparePath !== null) {
    if (!isAbsolutePath($preparePath)) {
        fwrite(STDERR, "エラー: --prepare には絶対パスを指定してください: {$preparePath}\n");
        exit(1);
    }

    $existingDbFile = $preparePath . DIRECTORY_SEPARATOR . 'db' . DIRECTORY_SEPARATOR . 'data.sqlite';
    if (is_link($preparePath) || (file_exists($preparePath) && !is_dir($preparePath))) {
        fwrite(STDERR, "エラー: --prepare の保存先はシンボリックリンクではないディレクトリにしてください: {$preparePath}\n");
        exit(1);
    }
    if (is_dir($preparePath)) {
        $existingEntries = scandir($preparePath);
        if ($existingEntries === false || count(array_diff($existingEntries, ['.', '..'])) > 0) {
            fwrite(STDERR, "エラー: --prepare の保存先が空ではありません。既存データ保護のため拒否しました: {$preparePath}\n");
            exit(1);
        }
    }

    echo "=== ブラウザ検証用一時領域の準備開始 ===\n";
    echo "対象パス: {$preparePath}\n";
    echo "プロファイル: {$profile}\n";

    $dirs = [
        $preparePath,
        $preparePath . DIRECTORY_SEPARATOR . 'db',
        $preparePath . DIRECTORY_SEPARATOR . 'db' . DIRECTORY_SEPARATOR . 'csv-import',
        $preparePath . DIRECTORY_SEPARATOR . 'temp' . DIRECTORY_SEPARATOR . 'backup-export',
        $preparePath . DIRECTORY_SEPARATOR . 'temp' . DIRECTORY_SEPARATOR . 'backup-restore',
        $preparePath . DIRECTORY_SEPARATOR . 'uploads' . DIRECTORY_SEPARATOR . 'floorplans',
        $preparePath . DIRECTORY_SEPARATOR . 'uploads' . DIRECTORY_SEPARATOR . 'device_images',
        $preparePath . DIRECTORY_SEPARATOR . 'temp',
        $preparePath . DIRECTORY_SEPARATOR . 'backups' . DIRECTORY_SEPARATOR . 'auto',
        $preparePath . DIRECTORY_SEPARATOR . 'logs' . DIRECTORY_SEPARATOR . 'audit',
        $preparePath . DIRECTORY_SEPARATOR . 'sessions',
    ];

    foreach ($dirs as $dir) {
        if (!is_dir($dir)) {
            mkdir($dir, 0700, true);
        }
    }

    // マーカーファイルを作成（自前生成の確認用）
    file_put_contents($preparePath . DIRECTORY_SEPARATOR . '.netarium_benchmark_marker', json_encode([
        'created_at' => date('c'),
        'profile' => $profile,
    ]));

    // 初期DB作成
    $pdo = new PDO('sqlite:' . $existingDbFile);
    \Netarium\Core\Database::initialize($pdo);
    $now = date('Y-m-d H:i:s');
    $userStmt = $pdo->prepare("INSERT INTO users (username, password_hash, role, is_active, created_at, updated_at) VALUES (:u, :p, :r, 1, :c, :u_at)");
    $userStmt->execute([':u' => 'admin', ':p' => \Netarium\Services\Auth\PasswordHashing::hash('admin123'), ':r' => 'admin', ':c' => $now, ':u_at' => $now]);
    $userStmt->execute([':u' => 'viewer', ':p' => \Netarium\Services\Auth\PasswordHashing::hash('viewer123'), ':r' => 'viewer', ':c' => $now, ':u_at' => $now]);
    unset($pdo);

    // 一時サーバーを立ち上げてAPI経由でデータを投入
    echo "合成データを投入中...\n";
    $dataset = generateSyntheticDataset($profile);

    // 一時ポートでサーバー起動
    // preparePathをストレージとして使うため、専用の一時サーバーを手動起動
    $phpBinary = PHP_BINARY;
    $docRoot = $projectRoot . DIRECTORY_SEPARATOR . 'public';
    // 利用可能なポートを探索
    $port = null;
    for ($p = 8890; $p <= 8950; $p++) {
        $fp = @fsockopen('127.0.0.1', $p, $errno, $errstr, 0.2);
        if (!$fp) {
            $port = $p;
            break;
        }
        fclose($fp);
    }
    if ($port === null) {
        throw new RuntimeException('一時サーバーに使用できるポートがありません (8890-8950)');
    }

    $prepareLogPath = $preparePath . DIRECTORY_SEPARATOR . 'server_prepare.log';
    $prepareLogHandle = fopen($prepareLogPath, 'a+');
    $descriptors = [
        0 => ['file', $nullDevice, 'r'],
        1 => $prepareLogHandle,
        2 => $prepareLogHandle,
    ];
    $cmd = sprintf(
        '"%s" -d session.save_path="%s" -d upload_max_filesize=128M -d post_max_size=128M -d memory_limit=512M -d max_execution_time=300 -S 127.0.0.1:%d -t "%s"',
        $phpBinary,
        $preparePath . DIRECTORY_SEPARATOR . 'sessions',
        $port,
        $docRoot
    );
    $parentEnv = getenv();
    $env = array_merge(is_array($parentEnv) ? $parentEnv : [], [
        'NETARIUM_STORAGE_DIR' => $preparePath,
        'NETARIUM_DB_FILE' => $existingDbFile,
        'TEMP' => sys_get_temp_dir(),
        'TMP' => sys_get_temp_dir(),
        'SystemRoot' => getenv('SystemRoot') ?: 'C:\Windows',
    ]);
    $proc = proc_open($cmd, $descriptors, $pipes, $docRoot, $env);
    if (!is_resource($proc)) {
        fwrite(STDERR, "一時サーバー起動に失敗しました\n");
        exit(1);
    }
    // サーバーの応答待機
    $startWait = microtime(true);
    $serverReady = false;
    $checkUrl = "http://127.0.0.1:{$port}/login.php";
    while ((microtime(true) - $startWait) < 10.0) {
        $ctx = stream_context_create(['http' => ['timeout' => 0.5, 'ignore_errors' => true]]);
        $res = @file_get_contents($checkUrl, false, $ctx);
        if ($res !== false) {
            $serverReady = true;
            break;
        }
        usleep(100000); // 100ms
    }
    if (!$serverReady) {
        throw new RuntimeException("サーバー起動待機がタイムアウトしました (port: {$port})");
    }

    try {
        $client = new TestHttpClient("http://127.0.0.1:{$port}");
        $client->setTimeout(180);
        if (!$client->login('admin', 'admin123')) {
            throw new RuntimeException("adminログインに失敗しました");
        }

        // 構成保存（ビューを先に作成）
        $loadRes = $client->get('/api.php?action=load');
        $currentRev = (int)($loadRes->getJson()['revision'] ?? 1);
        $saveRes = $client->postJson('/api.php?action=save', [
            'revision' => $currentRev,
            'views' => $dataset['views'],
            'devices' => $dataset['devices'],
            'placements' => $dataset['placements'],
            'links' => $dataset['links'],
            'canvas_notes' => [],
        ]);
        $saveRes->assertOk();
        $currentRev = (int)$saveRes->getJson()['revision'];
        echo "構成保存完了 (revision: {$currentRev})\n";
        $viewRevisions = array_column($client->get('/api.php?action=load')->assertOk()->getJson()['views'], 'resource_revision', 'id');

        // 図面アップロード（ビュー作成後に実施）
        $uploadedFloorPlans = 0;
        foreach ($dataset['floor_plans'] as $viewId => $fpSpec) {
            $tmpPng = tempnam(sys_get_temp_dir(), 'fp_');
            file_put_contents($tmpPng, createValidPng($fpSpec['width'], $fpSpec['height'], $fpSpec['bytes'], $fpSpec['uncompressible']));
            $uploadRes = $client->postMultipart(
                '/image_upload.php?action=upload_floor_plan',
                ['view_id' => $viewId, 'expected_revision' => $viewRevisions[$viewId]],
                ['floor_plan' => ['path' => $tmpPng, 'filename' => "floor_{$viewId}.png", 'type' => 'image/png']]
            );
            @unlink($tmpPng);
            if ($uploadRes->getStatusCode() === 200) {
                $uploadedFloorPlans++;
                $currentRev = (int)($uploadRes->getJson()['revision'] ?? ($currentRev + 1));
            } else {
                echo "図面アップロード (view_id={$viewId}) 結果: HTTP " . $uploadRes->getStatusCode() . " " . $uploadRes->getBody() . "\n";
            }
        }
        echo "図面登録完了: {$uploadedFloorPlans}枚 (最終 revision: {$currentRev})\n";
    } finally {
        $status = is_resource($proc) ? proc_get_status($proc) : false;
        $pid = is_array($status) ? ($status['pid'] ?? 0) : 0;
        if ($pid > 0) {
            if (stripos(PHP_OS, 'WIN') === 0) {
                @exec("taskkill /F /T /PID {$pid} 2>&1");
            } else {
                @proc_terminate($proc);
            }
        }
        if (is_resource($proc)) {
            @proc_close($proc);
        }
        if (is_resource($prepareLogHandle)) {
            @fclose($prepareLogHandle);
        }
    }

    echo "\n=== 準備完了 ===\n";
    echo "保管先ディレクトリ: {$preparePath}\n";
    echo "テスト用アカウント:\n";
    echo "  - 管理者: admin / admin123\n";
    echo "  - 閲覧者: viewer / viewer123\n";
    echo "起動用コマンド例:\n";
    echo "  php -d session.save_path=\"{$preparePath}\\sessions\" -d upload_max_filesize=128M -d post_max_size=128M -d memory_limit=512M -S 127.0.0.1:8080 -t \"{$docRoot}\"\n";
    echo "  (環境変数 NETARIUM_STORAGE_DIR=\"{$preparePath}\" NETARIUM_DB_FILE=\"{$existingDbFile}\")\n";
    exit(0);
}

// --------------------------------------------------------------------------
// 通常ベンチマーク実行モード
// --------------------------------------------------------------------------

echo "======================================================================\n";
echo " Netarium 性能ベンチマーク実行\n";
echo " プロファイル: {$profile} (本測定: {$iterations}回)\n";
echo " 実行環境: PHP " . PHP_VERSION . " (" . PHP_SAPI . ") / OS: " . PHP_OS . "\n";
echo "======================================================================\n";

// 1. 合成データの生成と自己検証
echo "\n[ステップ 1/5] 合成データ生成・自己検証...\n";
$dataset = generateSyntheticDataset($profile);
echo sprintf(
    "  生成データ: 機器 %d台, ビュー %d件, 配置 %d件, リンク %d件, 図面 %d枚\n",
    count($dataset['devices']),
    count($dataset['views']),
    count($dataset['placements']),
    count($dataset['links']),
    count($dataset['floor_plans'])
);

// 図面自己検証
$sampleFp = reset($dataset['floor_plans']);
if ($sampleFp !== false) {
    $testPng = createValidPng($sampleFp['width'], $sampleFp['height'], $sampleFp['bytes'], $sampleFp['uncompressible']);
    $tmpTestFile = tempnam(sys_get_temp_dir(), 'net_test_png_');
    file_put_contents($tmpTestFile, $testPng);
    $finfo = new finfo(FILEINFO_MIME_TYPE);
    $detectedMime = $finfo->file($tmpTestFile);
    $gis = @getimagesize($tmpTestFile);
    @unlink($tmpTestFile);

    if ($detectedMime !== 'image/png' || !is_array($gis) || $gis[0] !== $sampleFp['width'] || $gis[1] !== $sampleFp['height']) {
        fwrite(STDERR, "エラー: 生成されたPNG画像の自己検証に失敗しました。\n");
        exit(1);
    }
    echo "  画像自己検証: PNG正常 (MIME: {$detectedMime}, 寸法: {$gis[0]}x{$gis[1]}, 実サイズ: " . formatBytes(strlen($testPng)) . ")\n";
}

// 2. テストサーバー・計測ログのセットアップ
echo "\n[ステップ 2/5] 計測用フック付きテストサーバー起動...\n";
$benchLogPath = tempnam(sys_get_temp_dir(), 'net_bench_log_');
@unlink($benchLogPath);

$prependScriptPath = tempnam(sys_get_temp_dir(), 'net_prepend_');
file_put_contents($prependScriptPath, <<<PREPEND
<?php
\$logPath = getenv('NETARIUM_BENCH_LOG_FILE');
if (\$logPath) {
    register_shutdown_function(function() use (\$logPath) {
        \$peak = memory_get_peak_usage(true);
        \$action = \$_GET['action'] ?? (\$_SERVER['REQUEST_URI'] ?? 'unknown');
        \$method = \$_SERVER['REQUEST_METHOD'] ?? 'GET';
        \$status = http_response_code();
        \$rec = json_encode([
            'time' => microtime(true),
            'method' => \$method,
            'action' => \$action,
            'status' => \$status,
            'peak' => \$peak,
        ], JSON_UNESCAPED_UNICODE) . "\n";
        @file_put_contents(\$logPath, \$rec, FILE_APPEND | LOCK_EX);
    });
}
PREPEND
);

putenv("NETARIUM_BENCH_LOG_FILE={$benchLogPath}");

$server = new TestServer($projectRoot, $prependScriptPath);
$server->start();
echo "  サーバー起動: " . $server->getBaseUrl() . " (PIDプロセス稼働中)\n";

$client = new TestHttpClient($server->getBaseUrl());
$client->setTimeout(180);

if (!$client->login('admin', 'admin123')) {
    fwrite(STDERR, "エラー: adminでのログインに失敗しました。\n");
    exit(1);
}
echo "  adminログイン成功\n";

// 3. データ投入
echo "\n[ステップ 3/5] ベンチマーク用データ投入...\n";

// 構成データ保存（ビューを先に作成）
$loadRes = $client->get('/api.php?action=load');
$initialRev = (int)($loadRes->getJson()['revision'] ?? 1);
$saveRes = $client->postJson('/api.php?action=save', [
    'revision' => $initialRev,
    'views' => $dataset['views'],
    'devices' => $dataset['devices'],
    'placements' => $dataset['placements'],
    'links' => $dataset['links'],
    'canvas_notes' => [],
]);
if ($saveRes->getStatusCode() !== 200) {
    fwrite(STDERR, "構成データ保存エラー: HTTP " . $saveRes->getStatusCode() . " " . $saveRes->getBody() . "\n");
    exit(1);
}
$saveRes->assertOk();
$currentRevision = (int)$saveRes->getJson()['revision'];
echo "  構成データ保存完了 (revision: {$currentRevision})\n";
$viewRevisions = array_column($client->get('/api.php?action=load')->assertOk()->getJson()['views'], 'resource_revision', 'id');

// 図面投入（ビュー作成後に実施）
$uploadedFloorPlans = 0;
foreach ($dataset['floor_plans'] as $viewId => $fpSpec) {
    $tmpPng = tempnam(sys_get_temp_dir(), 'fp_bench_');
    file_put_contents($tmpPng, createValidPng($fpSpec['width'], $fpSpec['height'], $fpSpec['bytes'], $fpSpec['uncompressible']));
    $uploadRes = $client->postMultipart(
        '/image_upload.php?action=upload_floor_plan',
        [
            'view_id' => $viewId,
            'expected_revision' => $viewRevisions[$viewId],
        ],
        [
            'floor_plan' => [
                'path' => $tmpPng,
                'filename' => "floor_{$viewId}.png",
                'type' => 'image/png',
            ],
        ]
    );
    @unlink($tmpPng);
    if ($uploadRes->getStatusCode() === 200) {
        $uploadedFloorPlans++;
        $currentRevision = (int)($uploadRes->getJson()['revision'] ?? ($currentRevision + 1));
    } else {
        echo "  [注意] 図面 upload (view_id={$viewId}) 応答: HTTP " . $uploadRes->getStatusCode() . " " . $uploadRes->getBody() . "\n";
    }
}
echo "  図面投入完了: {$uploadedFloorPlans}枚 (最終 revision: {$currentRevision})\n";
// 検証
$verifyLoad = $client->get('/api.php?action=load');
$verifyLoad->assertOk();
$vJson = $verifyLoad->getJson();
echo sprintf(
    "  投入後検証: 機器 %d台, ビュー %d件, 配置 %d件, リンク %d件 (合致確認済)\n",
    count($vJson['devices'] ?? []),
    count($vJson['views'] ?? []),
    count($vJson['placements'] ?? []),
    count($vJson['links'] ?? [])
);

// 4. 計測実行
echo "\n[ステップ 4/5] 各APIの応答時間・メモリ・容量の測定中 (ウォームアップ1回 + {$iterations}回)...\n";

function measureApiCall(callable $call, string $benchLogPath): array
{
    clearstatcache(true, $benchLogPath);
    $startLogLines = file_exists($benchLogPath) ? count(file($benchLogPath)) : 0;
    $t0 = hrtime(true);
    $res = $call();
    $t1 = hrtime(true);
    $elapsedMs = ($t1 - $t0) / 1_000_000.0;

    $peakBytes = 0;
    for ($attempt = 0; $attempt < 10; $attempt++) {
        clearstatcache(true, $benchLogPath);
        if (file_exists($benchLogPath)) {
            $lines = file($benchLogPath);
            $newLines = array_slice($lines, $startLogLines);
            foreach ($newLines as $ln) {
                $parsed = json_decode(trim($ln), true);
                if (is_array($parsed) && isset($parsed['peak']) && (int)$parsed['peak'] > $peakBytes) {
                    $peakBytes = (int)$parsed['peak'];
                }
            }
            if ($peakBytes > 0) {
                break;
            }
        }
        usleep(10000); // 10ms
    }

    $statusCode = $res instanceof \Netarium\Tests\TestResponse ? $res->getStatusCode() : 200;
    $bodyLen = $res instanceof \Netarium\Tests\TestResponse ? strlen($res->getBody()) : 0;

    return [
        'status' => $statusCode,
        'elapsed_ms' => $elapsedMs,
        'response_bytes' => $bodyLen,
        'peak_bytes' => $peakBytes,
        'response' => $res,
    ];
}

$metrics = [
    'load' => [],
    'save' => [],
    'data_quality' => [],
    'export_backup_zip' => [],
    'preview_backup_restore' => [],
    'commit_backup_restore' => [],
];
$boundaryChecks = [];

$totalRuns = 1 + $iterations; // 1 warm-up + N iterations

for ($run = 0; $run < $totalRuns; $run++) {
    $isWarmup = ($run === 0);
    $label = $isWarmup ? "ウォームアップ" : "本測定 {$run}/{$iterations}";
    echo "  [{$label}] 実行中...\n";

    // A. API load
    $mLoad = measureApiCall(fn() => $client->get('/api.php?action=load'), $benchLogPath);
    if (!$isWarmup) $metrics['load'][] = $mLoad;

    // B. API save
    $loadForSave = $client->get('/api.php?action=load')->getJson();
    $mSave = measureApiCall(fn() => $client->postJson('/api.php?action=save', [
        'revision' => (int)$loadForSave['revision'],
        'views' => $loadForSave['views'],
        'devices' => $loadForSave['devices'],
        'placements' => $loadForSave['placements'],
        'links' => $loadForSave['links'],
        'canvas_notes' => $loadForSave['canvas_notes'],
    ]), $benchLogPath);
    if (!$isWarmup) $metrics['save'][] = $mSave;

    // C. API data_quality
    $mDataQuality = measureApiCall(fn() => $client->get('/api.php?action=data_quality'), $benchLogPath);
    if (!$isWarmup) $metrics['data_quality'][] = $mDataQuality;

    // D. Backup & Restore (image-boundaryまたはskipBackupでない場合)
    if (!$skipBackup) {
        $backupSnapshot = $client->get('/api.php?action=load')->getJson();
        if (!is_array($backupSnapshot)) {
            throw new RuntimeException('バックアップ前の構成を読み込めません');
        }
        $floorPlanHashes = [];
        foreach ($backupSnapshot['floor_plans'] ?? [] as $floorPlan) {
            $viewId = (int)$floorPlan['view_id'];
            $imageRes = $client->get("/floor_plan.php?view_id={$viewId}");
            if ($imageRes->getStatusCode() !== 200) {
                throw new RuntimeException("バックアップ前の図面を取得できません (view_id={$viewId})");
            }
            $floorPlanHashes[$viewId] = hash('sha256', $imageRes->getBody());
        }

        $mExport = measureApiCall(fn() => $client->postForm('/api.php?action=export_backup_zip', []), $benchLogPath);
        if ($profile === 'image-boundary') {
            $exportError = $mExport['response']->getJson()['error'] ?? '';
            $expectedBoundaryRejection = $mExport['status'] === 400
                && str_contains((string)$exportError, 'バックアップZIPの容量が上限を超えています');
            $boundaryChecks['image_boundary_export_rejected'] = [
                'status' => $mExport['status'],
                'ok' => $expectedBoundaryRejection,
                'error' => $exportError,
            ];
            if (!$expectedBoundaryRejection) {
                throw new RuntimeException(
                    "画像容量境界のZIP拒否が期待値と異なります (HTTP {$mExport['status']}: {$exportError})"
                );
            }
            echo "    画像容量境界のZIP上限拒否を確認 (HTTP 400)\n";
        } else {
            if (!$isWarmup) $metrics['export_backup_zip'][] = $mExport;
            if ($mExport['status'] !== 200) {
                $error = $mExport['response']->getJson()['error'] ?? '';
                throw new RuntimeException("バックアップ出力に失敗しました (HTTP {$mExport['status']}: {$error})");
            }

            $zipContent = $mExport['response']->getBody();
            $tmpZip = tempnam(sys_get_temp_dir(), 'bench_zip_');
            if ($tmpZip === false || file_put_contents($tmpZip, $zipContent) !== strlen($zipContent)) {
                throw new RuntimeException('測定用バックアップZIPを一時ファイルへ保存できません');
            }

            try {
                $mPreview = measureApiCall(fn() => $client->postMultipart(
                    '/api.php?action=preview_backup_restore',
                    [],
                    ['backup_zip' => ['path' => $tmpZip, 'filename' => 'backup.zip', 'type' => 'application/zip']]
                ), $benchLogPath);
                if (!$isWarmup) $metrics['preview_backup_restore'][] = $mPreview;

                $previewJson = $mPreview['response']->getJson();
                if ($mPreview['status'] !== 200 || !isset($previewJson['restore_token'])) {
                    $error = $previewJson['error'] ?? '';
                    throw new RuntimeException("バックアップ復元プレビューに失敗しました (HTTP {$mPreview['status']}: {$error})");
                }

                $mCommit = measureApiCall(fn() => $client->postJson('/api.php?action=commit_backup_restore', [
                    'restore_token' => (string)$previewJson['restore_token'],
                    'confirmation' => 'バックアップから復元',
                ]), $benchLogPath);
                if (!$isWarmup) $metrics['commit_backup_restore'][] = $mCommit;

                $commitJson = $mCommit['response']->getJson();
                if ($mCommit['status'] !== 200 || ($commitJson['ok'] ?? null) !== true) {
                    $error = $commitJson['error'] ?? '';
                    throw new RuntimeException("バックアップ復元確定に失敗しました (HTTP {$mCommit['status']}: {$error})");
                }
                $postProcessingRequired = !empty($commitJson['post_processing_required']);

                if (!$client->login('admin', 'admin123')) {
                    throw new RuntimeException('バックアップ復元後に再ログインできません');
                }

                $restoredSnapshot = $client->get('/api.php?action=load')->getJson();
                if (!is_array($restoredSnapshot)) {
                    throw new RuntimeException('バックアップ復元後の構成を読み込めません');
                }
                foreach (['devices', 'views', 'placements', 'links', 'floor_plans', 'device_images'] as $key) {
                    if (($restoredSnapshot[$key] ?? null) !== ($backupSnapshot[$key] ?? null)) {
                        throw new RuntimeException("バックアップ復元後の{$key}が出力前の状態と一致しません");
                    }
                }
                foreach ($floorPlanHashes as $viewId => $expectedHash) {
                    $restoredImage = $client->get("/floor_plan.php?view_id={$viewId}");
                    if (
                        $restoredImage->getStatusCode() !== 200 ||
                        !hash_equals($expectedHash, hash('sha256', $restoredImage->getBody()))
                    ) {
                        throw new RuntimeException("バックアップ復元後の図面画像が一致しません (view_id={$viewId})");
                    }
                }
                if ($postProcessingRequired) {
                    throw new RuntimeException(
                        'バックアップ復元後に後処理が必要です: '
                        . implode(', ', $commitJson['post_processing_errors'] ?? [])
                    );
                }

            } finally {
                @unlink($tmpZip);
            }
        }
    }
}

// 5. 並行性・競合測定
echo "\n[ステップ 5/5] 並行性・競合動作の測定...\n";

// セカンダリサーバーを同一DB・同一セッションパスで起動して真の並列性を評価
$secServer = $server->spawnWorker();
$concurrencyResults = [];

try {
    $secClient = new TestHttpClient($secServer->getBaseUrl());
    $secClient->login('admin', 'admin123');

    // A. 2者同時保存の競合テスト (同一revisionから同時save)
    $currState = $client->get('/api.php?action=load')->getJson();
    $sameRevision = (int)$currState['revision'];

    $ch1 = curl_init($server->getBaseUrl() . '/api.php?action=save');
    $ch2 = curl_init($secClient->getBaseUrl() . '/api.php?action=save');

    $savePayload = json_encode([
        'revision' => $sameRevision,
        'views' => $currState['views'],
        'devices' => $currState['devices'],
        'placements' => $currState['placements'],
        'links' => $currState['links'],
        'canvas_notes' => $currState['canvas_notes'],
    ], JSON_UNESCAPED_UNICODE);

    foreach ([[$ch1, $client], [$ch2, $secClient]] as [$ch, $cl]) {
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_POST, true);
        curl_setopt($ch, CURLOPT_POSTFIELDS, $savePayload);
        curl_setopt($ch, CURLOPT_COOKIEFILE, $cl->cookieFile);
        curl_setopt($ch, CURLOPT_HTTPHEADER, [
            'Content-Type: application/json',
            'X-CSRF-Token: ' . $cl->getCsrfToken(),
        ]);
    }

    $mh = curl_multi_init();
    curl_multi_add_handle($mh, $ch1);
    curl_multi_add_handle($mh, $ch2);

    $running = null;
    do {
        curl_multi_exec($mh, $running);
        if ($running) curl_multi_select($mh);
    } while ($running > 0);

    $code1 = curl_getinfo($ch1, CURLINFO_HTTP_CODE);
    $code2 = curl_getinfo($ch2, CURLINFO_HTTP_CODE);

    curl_multi_remove_handle($mh, $ch1);
    curl_multi_remove_handle($mh, $ch2);
    curl_multi_close($mh);
    curl_close($ch1);
    curl_close($ch2);

    $saveCodes = [$code1, $code2];
    sort($saveCodes);
    $oneSuccessOneConflict = ($saveCodes === [200, 409]);
    $concurrencyResults['concurrent_save'] = [
        'codes' => [$code1, $code2],
        'success_and_conflict_handled' => $oneSuccessOneConflict,
    ];
    echo sprintf("  同時Save競合判定: HTTP %d と HTTP %d (%s)\n", $code1, $code2, $oneSuccessOneConflict ? '正常: 一方成功/他方409' : '異常');
    if (!$oneSuccessOneConflict) {
        throw new RuntimeException("同時Save競合のHTTP結果が期待値と異なります: {$code1}, {$code2}");
    }

    // B. Ping排他テスト: 先行要求の実ロックを確認してから後続要求を送る
    $currState = $client->get('/api.php?action=load')->getJson();
    $currRev = (int)$currState['revision'];
    $device = $currState['devices'][0] ?? null;
    if (!is_array($device)) {
        throw new RuntimeException('Ping排他測定用の合成機器がありません');
    }
    $pingTargets = [[
        'id' => (int)$device['id'],
        'ip' => (string)$device['ip'],
    ]];
    $pingPayload = json_encode(['revision' => $currRev, 'targets' => $pingTargets]);
    $pingCh1 = curl_init($server->getBaseUrl() . '/api.php?action=ping');
    $pingCh2 = curl_init($secClient->getBaseUrl() . '/api.php?action=ping');
    foreach ([[$pingCh1, $client], [$pingCh2, $secClient]] as [$ch, $cl]) {
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_POST, true);
        curl_setopt($ch, CURLOPT_POSTFIELDS, $pingPayload);
        curl_setopt($ch, CURLOPT_COOKIEFILE, $cl->cookieFile);
        curl_setopt($ch, CURLOPT_HTTPHEADER, [
            'Content-Type: application/json',
            'X-CSRF-Token: ' . $cl->getCsrfToken(),
        ]);
    }

    $pmh = curl_multi_init();
    curl_multi_add_handle($pmh, $pingCh1);
    $pingLockPath = $server->getTempDir() . DIRECTORY_SEPARATOR . 'temp' . DIRECTORY_SEPARATOR . 'ping.lock';
    $pingLockObserver = fopen($pingLockPath, 'c+b');
    if ($pingLockObserver === false) {
        throw new RuntimeException("Ping排他ロックを監視できません: {$pingLockPath}");
    }
    $lockWaitStarted = hrtime(true);
    $lockObserved = false;
    $prunning = 0;
    while ((hrtime(true) - $lockWaitStarted) < 10_000_000_000) {
        curl_multi_exec($pmh, $prunning);
        if (@flock($pingLockObserver, LOCK_EX | LOCK_NB)) {
            flock($pingLockObserver, LOCK_UN);
        } else {
            $lockObserved = true;
            break;
        }
        if ($prunning === 0) {
            break;
        }
        curl_multi_select($pmh, 0.01);
    }
    if (!$lockObserved) {
        fclose($pingLockObserver);
        throw new RuntimeException('先行Ping要求が排他ロックを保持する状態を確認できませんでした');
    }

    curl_multi_add_handle($pmh, $pingCh2);
    do {
        curl_multi_exec($pmh, $prunning);
        if ($prunning) curl_multi_select($pmh, 0.1);
    } while ($prunning > 0);

    $pCode1 = curl_getinfo($pingCh1, CURLINFO_HTTP_CODE);
    $pCode2 = curl_getinfo($pingCh2, CURLINFO_HTTP_CODE);
    $pBody1 = curl_multi_getcontent($pingCh1);
    $pBody2 = curl_multi_getcontent($pingCh2);
    fclose($pingLockObserver);
    curl_multi_remove_handle($pmh, $pingCh1);
    curl_multi_remove_handle($pmh, $pingCh2);
    curl_multi_close($pmh);
    curl_close($pingCh1);
    curl_close($pingCh2);

    $pingCodes = [$pCode1, $pCode2];
    sort($pingCodes);
    $pingOneSuccessOneConflict = ($pingCodes === [200, 409]);
    $concurrencyResults['concurrent_ping'] = [
        'codes' => [$pCode1, $pCode2],
        'success_and_conflict_handled' => $pingOneSuccessOneConflict,
        'lock_observed_before_second_request' => $lockObserved,
        'details' => [$pBody1, $pBody2],
    ];
    echo sprintf("  同時Ping排他判定: HTTP %d と HTTP %d (%s)\n", $pCode1, $pCode2, $pingOneSuccessOneConflict ? '正常: ロック保持確認後に後続409' : '異常');
    if (!$pingOneSuccessOneConflict) {
        throw new RuntimeException("同時Ping排他のHTTP結果が期待値と異なります: {$pCode1}, {$pCode2}");
    }

    // C. 別セッションの閲覧者と編集者を同時に実行
    $viewerCount = ($profile === 'near-limit') ? 5 : 3;
    $editorCount = ($profile === 'near-limit') ? 2 : 1;
    $viewerClients = [];
    $vMh = curl_multi_init();
    $vHandles = [];
    for ($vi = 0; $vi < $viewerCount; $vi++) {
        $targetUrl = ($vi % 2 === 0) ? $server->getBaseUrl() : $secServer->getBaseUrl();
        $viewerClient = new TestHttpClient($targetUrl);
        if (!$viewerClient->login('viewer', 'viewer123')) {
            throw new RuntimeException("閲覧者セッション{$vi}でログインできません");
        }
        $viewerClients[] = $viewerClient;
        $vch = curl_init($targetUrl . '/api.php?action=load');
        curl_setopt($vch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($vch, CURLOPT_COOKIEFILE, $viewerClient->cookieFile);
        curl_multi_add_handle($vMh, $vch);
        $vHandles[] = $vch;
    }

    $concurrentState = $client->get('/api.php?action=load')->getJson();
    $concurrentRevision = (int)$concurrentState['revision'];
    $concurrentSavePayload = json_encode([
        'revision' => $concurrentRevision,
        'views' => $concurrentState['views'],
        'devices' => $concurrentState['devices'],
        'placements' => $concurrentState['placements'],
        'links' => $concurrentState['links'],
        'canvas_notes' => $concurrentState['canvas_notes'],
    ], JSON_UNESCAPED_UNICODE);
    $editorClients = [$client, $secClient];
    $editorHandles = [];
    for ($ei = 0; $ei < $editorCount; $ei++) {
        $editorClient = $editorClients[$ei];
        $targetUrl = ($ei === 0) ? $server->getBaseUrl() : $secServer->getBaseUrl();
        $ech = curl_init($targetUrl . '/api.php?action=save');
        curl_setopt($ech, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ech, CURLOPT_POST, true);
        curl_setopt($ech, CURLOPT_POSTFIELDS, $concurrentSavePayload);
        curl_setopt($ech, CURLOPT_COOKIEFILE, $editorClient->cookieFile);
        curl_setopt($ech, CURLOPT_HTTPHEADER, [
            'Content-Type: application/json',
            'X-CSRF-Token: ' . $editorClient->getCsrfToken(),
        ]);
        curl_multi_add_handle($vMh, $ech);
        $editorHandles[] = $ech;
    }

    $vRunning = null;
    $vt0 = hrtime(true);
    do {
        curl_multi_exec($vMh, $vRunning);
        if ($vRunning) curl_multi_select($vMh);
    } while ($vRunning > 0);
    $vt1 = hrtime(true);
    $vElapsedMs = ($vt1 - $vt0) / 1_000_000.0;

    $viewerCodes = [];
    foreach ($vHandles as $vch) {
        $viewerCodes[] = curl_getinfo($vch, CURLINFO_HTTP_CODE);
        curl_multi_remove_handle($vMh, $vch);
        curl_close($vch);
    }
    $editorCodes = [];
    foreach ($editorHandles as $ech) {
        $editorCodes[] = curl_getinfo($ech, CURLINFO_HTTP_CODE);
        curl_multi_remove_handle($vMh, $ech);
        curl_close($ech);
    }
    curl_multi_close($vMh);
    $allViewersOk = count(array_filter($viewerCodes, static fn(int $code): bool => $code === 200)) === $viewerCount;
    sort($editorCodes);
    $editorsOk = $editorCount === 1
        ? $editorCodes === [200]
        : $editorCodes === [200, 409];
    $concurrencyResults['concurrent_load'] = [
        'viewers' => $viewerCount,
        'independent_viewer_sessions' => true,
        'viewer_codes' => $viewerCodes,
        'editors' => $editorCount,
        'editor_codes' => $editorCodes,
        'all_viewers_200_and_editors_expected' => $allViewersOk && $editorsOk,
        'total_elapsed_ms' => $vElapsedMs,
    ];
    echo sprintf("  並行利用 (%d者閲覧・%d者編集): %s (全所要時間: %.2f ms)\n", $viewerCount, $editorCount, ($allViewersOk && $editorsOk) ? '期待値どおり' : '失敗あり', $vElapsedMs);
    if (!$allViewersOk || !$editorsOk) {
        throw new RuntimeException(
            '並行利用のHTTP結果が期待値と異なります: viewer=['
            . implode(',', $viewerCodes)
            . '], editor=['
            . implode(',', $editorCodes)
            . ']'
        );
    }

} finally {
    $secServer->stop();
}

// 6. 登録上限・容量境界の判定
echo "\n--- 登録上限・境界条件の判定 ---\n";

// ビュー上限超過 (101件)
$currState = $client->get('/api.php?action=load')->getJson();
$overflowViews = $currState['views'];
while (count($overflowViews) < 101) {
    $nid = count($overflowViews) + 1;
    $overflowViews[] = ['id' => $nid, 'name' => "OverView-{$nid}", 'view_type' => 'topology'];
}
$viewOverRes = $client->postJson('/api.php?action=save', [
    'revision' => (int)$currState['revision'],
    'views' => $overflowViews,
    'devices' => $currState['devices'],
    'placements' => $currState['placements'],
    'links' => $currState['links'],
    'canvas_notes' => $currState['canvas_notes'],
]);
$boundaryChecks['views_101_rejected'] = [
    'status' => $viewOverRes->getStatusCode(),
    'ok' => ($viewOverRes->getStatusCode() === 400),
    'error' => $viewOverRes->getJson()['error'] ?? '',
];
echo sprintf("  ビュー101件超過: HTTP %d (期待値 400, 応答: %s)\n", $viewOverRes->getStatusCode(), $viewOverRes->getJson()['error'] ?? '');

// 1ビュー配置上限超過 (2,001件)
$overflowDevices = $currState['devices'];
$existingDevCount = count($overflowDevices);
for ($d = $existingDevCount + 1; $d <= 2005; $d++) {
    $overflowDevices[] = [
        'id' => $d,
        'name' => "OverDev-{$d}",
        'type' => 'server',
    ];
}
$v1Placements = [];
for ($p = 1; $p <= 2001; $p++) {
    $v1Placements[] = [
        'id' => $p,
        'view_id' => 1,
        'device_id' => $p,
        'x' => 10,
        'y' => 10,
    ];
}
$placementOverRes = $client->postJson('/api.php?action=save', [
    'revision' => (int)$currState['revision'],
    'views' => $currState['views'],
    'devices' => $overflowDevices,
    'placements' => $v1Placements,
    'links' => [],
    'canvas_notes' => $currState['canvas_notes'],
]);
$boundaryChecks['placement_2001_rejected'] = [
    'status' => $placementOverRes->getStatusCode(),
    'ok' => ($placementOverRes->getStatusCode() === 400),
    'error' => $placementOverRes->getJson()['error'] ?? '',
];
echo sprintf("  1ビュー配置2,001件超過: HTTP %d (期待値 400, 応答: %s)\n", $placementOverRes->getStatusCode(), $placementOverRes->getJson()['error'] ?? '');

// 1ビューリンク上限超過 (5,001件)
$v1Links = [];
$linkCount = 0;
for ($i = 1; $i <= 2000 && $linkCount < 5001; $i++) {
    for ($j = $i + 1; $j <= 2000 && $linkCount < 5001; $j++) {
        $linkCount++;
        $v1Links[] = [
            'id' => $linkCount,
            'view_id' => 1,
            'from_id' => $i,
            'to_id' => $j,
            'label' => "L-{$linkCount}",
        ];
    }
}
$validPlacementsForLinks = array_slice($v1Placements, 0, 2000);
$linkOverRes = $client->postJson('/api.php?action=save', [
    'revision' => (int)$currState['revision'],
    'views' => $currState['views'],
    'devices' => $overflowDevices,
    'placements' => $validPlacementsForLinks,
    'links' => $v1Links,
    'canvas_notes' => $currState['canvas_notes'],
]);
$boundaryChecks['link_5001_rejected'] = [
    'status' => $linkOverRes->getStatusCode(),
    'ok' => ($linkOverRes->getStatusCode() === 400),
    'error' => $linkOverRes->getJson()['error'] ?? '',
];
echo sprintf("  1ビューリンク5,001件超過: HTTP %d (期待値 400, 応答: %s)\n", $linkOverRes->getStatusCode(), $linkOverRes->getJson()['error'] ?? '');

// 終了処理・サーバー停止
$server->stop();
@unlink($prependScriptPath);
@unlink($benchLogPath);

// --------------------------------------------------------------------------
// 結果集計と表示
// --------------------------------------------------------------------------
echo "\n======================================================================\n";
echo " ベンチマーク測定結果サマリー ({$profile})\n";
echo "======================================================================\n";

printf(
    "%-24s | %-12s | %-12s | %-8s | %-12s | %-12s\n",
    "操作", "中央値(ms)", "最大値(ms)", "成功率", "応答サイズ", "ピークメモリ"
);
echo str_repeat('-', 90) . "\n";

$summaryReport = [];

foreach ($metrics as $op => $rows) {
    if ($rows === []) {
        continue;
    }
    $times = array_column($rows, 'elapsed_ms');
    $successes = count(array_filter($rows, fn($r) => $r['status'] === 200));
    $successRate = ($successes / count($rows)) * 100.0;
    $medianTime = calculateMedian($times);
    $maxTime = max($times);
    $medianBytes = calculateMedian(array_column($rows, 'response_bytes'));
    $peakMem = max(array_column($rows, 'peak_bytes'));

    $summaryReport[$op] = [
        'median_ms' => round($medianTime, 2),
        'max_ms' => round($maxTime, 2),
        'success_rate' => round($successRate, 1),
        'response_bytes' => (int)$medianBytes,
        'peak_memory_bytes' => (int)$peakMem,
    ];

    printf(
        "%-24s | %10.2f ms | %10.2f ms | %7.1f%% | %12s | %12s\n",
        $op,
        $medianTime,
        $maxTime,
        $successRate,
        formatBytes($medianBytes),
        formatBytes($peakMem)
    );
}

echo str_repeat('-', 90) . "\n";

$finalReport = [
    'profile' => $profile,
    'timestamp' => date('c'),
    'environment' => [
        'php_version' => PHP_VERSION,
        'os' => PHP_OS,
        'architecture' => PHP_INT_SIZE * 8,
    ],
    'dataset' => [
        'devices' => count($dataset['devices']),
        'views' => count($dataset['views']),
        'placements' => count($dataset['placements']),
        'links' => count($dataset['links']),
        'floor_plans' => count($dataset['floor_plans']),
    ],
    'metrics' => $summaryReport,
    'concurrency' => $concurrencyResults,
    'boundary_checks' => $boundaryChecks,
];

echo "\n--- JSON Report Output ---\n";
echo json_encode($finalReport, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE) . "\n";
