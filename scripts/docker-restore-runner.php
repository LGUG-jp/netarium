<?php
declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit(1);
}

define('NETARIUM_FULL_BACKUP_HELPER_NO_LOOP', true);
require_once __DIR__ . '/full-backup-helper.php';

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

function setRecursivePermissions(string $path, int $dirMode, int $fileMode, string $userGroup): void
{
    if (!file_exists($path)) {
        return;
    }
    @chown($path, explode(':', $userGroup)[0]);
    @chgrp($path, explode(':', $userGroup)[1] ?? explode(':', $userGroup)[0]);
    if (is_dir($path)) {
        @chmod($path, $dirMode);
        foreach (new DirectoryIterator($path) as $item) {
            if ($item->isDot()) {
                continue;
            }
            setRecursivePermissions($item->getPathname(), $dirMode, $fileMode, $userGroup);
        }
    } else {
        @chmod($path, $fileMode);
    }
}


$longOptions = ['archive:', 'verify-only', 'apply', 'max-bytes::', 'max-files::'];
$options = getopt('', $longOptions);

$archive = $options['archive'] ?? null;
if (!is_string($archive) || !is_file($archive)) {
    fwrite(STDERR, "Archive file missing or unreadable: " . var_export($archive, true) . "\n");
    exit(1);
}

$verifyOnly = isset($options['verify-only']);
$apply = isset($options['apply']);
if (!$verifyOnly && !$apply) {
    fwrite(STDERR, "Either --verify-only or --apply must be specified.\n");
    exit(1);
}

$maxBytes = isset($options['max-bytes']) ? (int)$options['max-bytes'] : 107374182400; // 100GB
$maxFiles = isset($options['max-files']) ? (int)$options['max-files'] : 100000;

$config = \Netarium\Core\Config::create();
$storageDir = (string)$config['storage_dir'];

$token = bin2hex(random_bytes(16));
$workRoot = $storageDir . '/temp/backup-restore/' . $token;
$payload = $workRoot . '/payload';

if (!mkdir($payload, 0700, true) && !is_dir($payload)) {
    fwrite(STDERR, "Cannot create payload directory: {$payload}\n");
    exit(1);
}

// 1. Verification phase (extract and check manifest, sha256, db integrity)
try {
    $manifest = fullExtract($archive, $payload, $maxBytes, $maxFiles);
} catch (Throwable $e) {
    removeDirectoryRecursive($workRoot);
    fwrite(STDERR, "Archive verification failed: " . $e->getMessage() . "\n");
    exit(1);
}

if ($verifyOnly) {
    removeDirectoryRecursive($workRoot);
    echo json_encode([
        'ok' => true,
        'verified' => true,
        'archive' => $archive,
        'format' => $manifest['format'],
        'application_version' => $manifest['application_version'],
        'schema_version' => $manifest['schema_version'],
        'file_count' => $manifest['file_count'],
        'total_bytes' => $manifest['total_bytes'],
        'counts' => $manifest['counts']
    ], JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES) . "\n";
    exit(0);
}

// 2. Apply phase: atomic replacement with rollback safety
$gate = new \Netarium\Core\OperationGate((string)$config['operation_lock_file']);
$gate->acquireExclusive();
$targets = [
    'db' => [
        'target' => (string)$config['db_file'],
        'source' => $payload . '/db/data.sqlite',
        'is_dir' => false,
        'parent' => dirname((string)$config['db_file']),
        'file_mode' => 0600,
        'dir_mode' => 0700,
    ],
    'floorplans' => [
        'target' => (string)$config['floor_plan_directory'],
        'source' => $payload . '/floorplans',
        'is_dir' => true,
        'parent' => dirname((string)$config['floor_plan_directory']),
        'file_mode' => 0600,
        'dir_mode' => 0700,
    ],
    'device_images' => [
        'target' => (string)$config['device_image_directory'],
        'source' => $payload . '/device_images',
        'is_dir' => true,
        'parent' => dirname((string)$config['device_image_directory']),
        'file_mode' => 0600,
        'dir_mode' => 0700,
    ],
];

// Setup sibling staging containers in the same filesystems as targets
$placements = [];
foreach ($targets as $key => $info) {
    $container = $info['parent'] . '/.stage-' . $token . '-' . $key;
    $new = $container . '/new';
    $old = $container . '/old';
    if (!is_dir($info['parent'])) {
        @mkdir($info['parent'], 0700, true);
        @chown($info['parent'], 'www-data');
        @chgrp($info['parent'], 'www-data');
        @chmod($info['parent'], 0700);
    }
    if (!mkdir($container, 0700, true)) {
        removeDirectoryRecursive($workRoot);
        $gate->release();
        fwrite(STDERR, "Cannot create sibling staging directory: {$container}\n");
        exit(1);
    }
    // Move extracted payload to sibling staging `new`
    if (!rename($info['source'], $new)) {
        removeDirectoryRecursive($container);
        removeDirectoryRecursive($workRoot);
        $gate->release();
        fwrite(STDERR, "Cannot move payload to sibling staging: {$new}\n");
        exit(1);
    }
    $placements[$key] = [
        'target' => $info['target'],
        'container' => $container,
        'new' => $new,
        'old' => $old,
        'is_dir' => $info['is_dir'],
        'file_mode' => $info['file_mode'],
        'dir_mode' => $info['dir_mode'],
        'saved' => false,
        'installed' => false,
    ];
}

$safeToResume = true;
$succeeded = false;

try {
    // Checkpoint live database if present before mutation
    if (is_file($config['db_file'])) {
        try {
            $liveDb = new PDO('sqlite:' . $config['db_file'], null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
            $liveDb->exec('PRAGMA busy_timeout=0');
            $check = $liveDb->query('PRAGMA wal_checkpoint(TRUNCATE)')->fetch(PDO::FETCH_NUM);
            if ((int)($check[0] ?? -1) !== 0 || $liveDb->query('PRAGMA integrity_check')->fetchAll(PDO::FETCH_COLUMN) !== ['ok']) {
                throw new RuntimeException('Live database checkpoint or integrity check did not pass');
            }
            $liveDb = null;
            foreach (['-wal', '-shm', '-journal'] as $suffix) {
                $sidecar = (string)$config['db_file'] . $suffix;
                if (file_exists($sidecar)) {
                    if (@filesize($sidecar) === 0) {
                        @unlink($sidecar);
                    }
                    if (file_exists($sidecar)) {
                        throw new RuntimeException('SQLite sidecar remains after checkpoint: ' . $sidecar);
                    }
                }
            }
        } catch (Throwable $e) {
            throw new RuntimeException('Live database checkpoint or integrity failure prior to restore: ' . $e->getMessage(), 0, $e);
        }
    }

    $safeToResume = false;

    // Atomic replacement: move Target -> Old, then New -> Target
    foreach ($placements as $key => $p) {
        if (file_exists($p['target'])) {
            if (!rename($p['target'], $p['old'])) {
                throw new RuntimeException("Cannot move current target to old: {$p['target']}");
            }
            $placements[$key]['saved'] = true;
        }
        if (!rename($p['new'], $p['target'])) {
            throw new RuntimeException("Cannot move new data to target: {$p['target']}");
        }
        $placements[$key]['installed'] = true;
        setRecursivePermissions($p['target'], $p['dir_mode'], $p['file_mode'], 'www-data:www-data');
    }
    // Invalidate existing user sessions
    $sessionsDir = $storageDir . '/sessions';
    if (is_dir($sessionsDir)) {
        foreach (new DirectoryIterator($sessionsDir) as $item) {
            if ($item->isDot() || !$item->isFile()) {
                continue;
            }
            if (str_starts_with($item->getFilename(), 'sess_')) {
                @unlink($item->getPathname());
            }
        }
    }


    // Run check-install.php verification
    $appRoot = dirname(__DIR__);
    $checkCmd = escapeshellcmd(PHP_BINARY) . ' ' .
        escapeshellarg($appRoot . '/scripts/check-install.php') .
        ' --app-root=' . escapeshellarg($appRoot) .
        ' --storage-dir=' . escapeshellarg($storageDir) .
        ' --db-file=' . escapeshellarg((string)$config['db_file']) .
        ' --allow-orphan-images';

    exec($checkCmd, $checkOutput, $checkExitCode);
    if ($checkExitCode !== 0) {
        throw new RuntimeException("Post-restore check-install failed (exit {$checkExitCode}): " . implode("\n", $checkOutput));
    }
    foreach ($placements as $p) {
        setRecursivePermissions($p['target'], $p['dir_mode'], $p['file_mode'], 'www-data:www-data');
    }
    foreach (['-wal', '-shm', '-journal'] as $suffix) {
        $sidecar = (string)$config['db_file'] . $suffix;
        if (file_exists($sidecar)) {
            setRecursivePermissions($sidecar, 0700, 0600, 'www-data:www-data');
        }
    }
    $safeToResume = true;
    $succeeded = true;

    // Cleanup old data and sibling staging
    foreach ($placements as $p) {
        removeDirectoryRecursive($p['container']);
    }
    removeDirectoryRecursive($workRoot);

    echo json_encode([
        'ok' => true,
        'restored' => true,
        'archive' => $archive,
        'application_version' => $manifest['application_version'],
        'schema_version' => $manifest['schema_version'],
        'file_count' => $manifest['file_count'],
        'total_bytes' => $manifest['total_bytes'],
        'counts' => $manifest['counts']
    ], JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES) . "\n";
} catch (Throwable $e) {
    $restoreError = $e->getMessage();
    fwrite(STDERR, "Restore error encountered, attempting rollback: {$restoreError}\n");

    unset($p);
    // Attempt rollback: remove newly placed targets, restore old
    try {
        // Remove WAL sidecars only if a new DB was actually installed
        if (($placements['db']['installed'] ?? false) === true) {
            foreach (['-wal', '-shm', '-journal'] as $suffix) {
                @unlink($config['db_file'] . $suffix);
            }
        }
        foreach ($placements as $key => $p) {
            if ($p['installed'] && file_exists($p['target'])) {
                if ($p['is_dir']) {
                    removeDirectoryRecursive($p['target']);
                } else {
                    if (!@unlink($p['target'])) {
                        throw new RuntimeException("Rollback: cannot remove newly installed target: {$p['target']}");
                    }
                }
            }
            if ($p['saved'] && file_exists($p['old'])) {
                if (!rename($p['old'], $p['target'])) {
                    throw new RuntimeException("Rollback: cannot restore old target from {$p['old']} to {$p['target']}");
                }
                setRecursivePermissions($p['target'], $p['dir_mode'], $p['file_mode'], 'www-data:www-data');
            }
            removeDirectoryRecursive($p['container']);
        }
        removeDirectoryRecursive($workRoot);
        $safeToResume = true;
        fwrite(STDERR, "Rollback succeeded. Prior database and images restored.\n");
    } catch (Throwable $rollbackException) {
        $safeToResume = false;
        fwrite(STDERR, "FATAL: Rollback failed: " . $rollbackException->getMessage() . "\n");
        fwrite(STDERR, "Site must remain stopped. Rollback files preserved in sibling stage containers.\n");
    }

    $gate->release();
    $lockFile = (string)$config['operation_lock_file'];
    if (is_file($lockFile)) {
        @chown($lockFile, 'www-data');
        @chgrp($lockFile, 'www-data');
        @chmod($lockFile, 0600);
    }
    exit($safeToResume ? 1 : 2);
} finally {
    $gate->release();
    $lockFile = (string)$config['operation_lock_file'];
    if (is_file($lockFile)) {
        @chown($lockFile, 'www-data');
        @chgrp($lockFile, 'www-data');
        @chmod($lockFile, 0600);
    }
}
