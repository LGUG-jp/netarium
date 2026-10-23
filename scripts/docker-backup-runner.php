<?php
declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit(1);
}

// Protect libzip temporary/output files from creation, including shared destinations.
umask(0077);

define('NETARIUM_FULL_BACKUP_HELPER_NO_LOOP', true);
require_once __DIR__ . '/full-backup-helper.php';

function copyDirectoryFiles(string $sourceDir, string $targetDir): void
{
    if (!is_dir($targetDir) && !mkdir($targetDir, 0700, true) && !is_dir($targetDir)) {
        throw new RuntimeException("Cannot create directory: {$targetDir}");
    }
    if (!is_dir($sourceDir)) {
        return;
    }
    foreach (new DirectoryIterator($sourceDir) as $item) {
        if ($item->isDot() || !$item->isFile() || $item->isLink()) {
            continue;
        }
        $name = $item->getFilename();
        fullSafeName(basename($targetDir) . '/' . $name);
        if (!copy($item->getPathname(), $targetDir . '/' . $name)) {
            throw new RuntimeException("Cannot copy file: {$name}");
        }
    }
}

function removeDirectoryRecursive(string $dir): void
{
    if (!is_dir($dir)) {
        return;
    }
    foreach (new DirectoryIterator($dir) as $item) {
        if ($item->isDot()) {
            continue;
        }
        if ($item->isDir() && !$item->isLink()) {
            removeDirectoryRecursive($item->getPathname());
        } else {
            @unlink($item->getPathname());
        }
    }
    @rmdir($dir);
}

$options = getopt('', ['output:', 'owner-uid:', 'owner-gid:']);
$outputPath = $options['output'] ?? null;
if (!is_string($outputPath) || $outputPath === '') {
    fwrite(STDERR, "Usage: php docker-backup-runner.php --output=/path/to/archive.zip [--owner-uid=UID] [--owner-gid=GID]\n");
    exit(1);
}

$ownerUid = null;
if (isset($options['owner-uid']) && is_string($options['owner-uid']) && preg_match('/^\d+$/', $options['owner-uid']) === 1) {
    $ownerUid = (int)$options['owner-uid'];
}
$ownerGid = null;
if (isset($options['owner-gid']) && is_string($options['owner-gid']) && preg_match('/^\d+$/', $options['owner-gid']) === 1) {
    $ownerGid = (int)$options['owner-gid'];
}

$outputDir = dirname($outputPath);
if (!is_dir($outputDir)) {
    if (!mkdir($outputDir, 0755, true) && !is_dir($outputDir)) {
        fwrite(STDERR, "Output directory does not exist and cannot be created: {$outputDir}\n");
        exit(1);
    }
}

// Some host mounts (for example DrvFS without metadata) ignore the POSIX mask.
// Probe with an empty file before writing any backup data to that filesystem.
if (PHP_OS_FAMILY !== 'Windows') {
    $probe = $outputDir . '/.netarium-permissions-' . bin2hex(random_bytes(16));
    $handle = fopen($probe, 'x');
    if ($handle === false) {
        throw new RuntimeException('Cannot verify output filesystem permissions');
    }
    fclose($handle);
    clearstatcache(true, $probe);
    $mode = fileperms($probe);
    unlink($probe);
    if ($mode === false || ($mode & 0077) !== 0) {
        throw new RuntimeException('Output filesystem must enforce owner-only POSIX permissions; use a protected Linux filesystem');
    }
}

$config = \Netarium\Core\Config::create();
$gate = new \Netarium\Core\OperationGate((string)$config['operation_lock_file']);

$token = bin2hex(random_bytes(16));
$workRoot = ((string)$config['storage_dir']) . '/temp/backup-export/' . $token;
$stage = $workRoot . '/stage';

$gate->acquireExclusive();
try {
    if (!mkdir($stage . '/db', 0700, true) ||
        !mkdir($stage . '/floorplans', 0700, true) ||
        !mkdir($stage . '/device_images', 0700, true)) {
        throw new RuntimeException('Cannot create staging directories');
    }

    if (!is_file($config['db_file'])) {
        throw new RuntimeException('Database missing: ' . $config['db_file']);
    }

    // SQLite snapshot via VACUUM INTO (includes committed WAL)
    $db = new PDO('sqlite:' . $config['db_file'], null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    $db->exec('PRAGMA busy_timeout=0');
    $db->exec('VACUUM INTO ' . $db->quote($stage . '/db/data.sqlite'));
    $db = null;

    copyDirectoryFiles((string)$config['floor_plan_directory'], $stage . '/floorplans');
    copyDirectoryFiles((string)$config['device_image_directory'], $stage . '/device_images');

    // Validate and prepare staging snapshot
    $counts = fullDatabase($stage . '/db/data.sqlite', $stage, true);
    $files = fullInventory($stage);

    $manifest = [
        'format' => 'netarium-full',
        'format_version' => 1,
        'created_at' => gmdate(DATE_ATOM),
        'application_version' => NETARIUM_VERSION,
        'schema_version' => APP_DATABASE_SCHEMA_VERSION,
        'logical_paths' => [
            'db' => 'db/data.sqlite',
            'floor_plan_directory' => 'floorplans',
            'device_image_directory' => 'device_images'
        ],
        'file_count' => count($files),
        'total_bytes' => array_sum(array_column($files, 'bytes')),
        'counts' => $counts,
        'files' => $files
    ];

    $partialPath = $outputPath . '.partial';
    if (is_file($partialPath)) {
        @unlink($partialPath);
    }

    $zip = new ZipArchive();
    if ($zip->open($partialPath, ZipArchive::CREATE | ZipArchive::EXCL) !== true) {
        throw new RuntimeException("Cannot create ZIP: {$partialPath}");
    }
    try {
        if (!$zip->addFromString('manifest.json', json_encode($manifest, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES))) {
            throw new RuntimeException('Manifest write failure');
        }
        foreach ($files as $name => $metadata) {
            if (!$zip->addFile($stage . '/' . $name, $name)) {
                throw new RuntimeException("ZIP add failure: {$name}");
            }
        }
    } catch (Throwable $e) {
        $zip->close();
        @unlink($partialPath);
        throw $e;
    }
    if (!$zip->close()) {
        @unlink($partialPath);
        throw new RuntimeException('ZIP close failure');
    }

    if (!rename($partialPath, $outputPath)) {
        @unlink($partialPath);
        throw new RuntimeException("Cannot rename partial archive to: {$outputPath}");
    }
    if ($ownerUid !== null && !chown($outputPath, $ownerUid)) {
        throw new RuntimeException('Cannot set archive owner');
    }
    if ($ownerGid !== null && !chgrp($outputPath, $ownerGid)) {
        throw new RuntimeException('Cannot set archive group');
    }
    if (!chmod($outputPath, 0600)) {
        throw new RuntimeException('Cannot protect archive permissions');
    }

    $sha256 = hash_file('sha256', $outputPath);

    echo json_encode([
        'ok' => true,
        'archive' => $outputPath,
        'sha256' => $sha256,
        'file_count' => $manifest['file_count'],
        'total_bytes' => $manifest['total_bytes'],
        'created_at' => $manifest['created_at'],
        'counts' => $counts
    ], JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES) . "\n";
} finally {
    removeDirectoryRecursive($workRoot);
    $gate->release();
    $lockFile = (string)$config['operation_lock_file'];
    if (is_file($lockFile)) {
        @chown($lockFile, 'www-data');
        @chgrp($lockFile, 'www-data');
        @chmod($lockFile, 0600);
    }
}
