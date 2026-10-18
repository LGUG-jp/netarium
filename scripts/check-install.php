<?php
declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

ini_set('display_errors', '0');

$fail = static function (string $message): never {
    fwrite(
        STDERR,
        json_encode(
            [
                'ok' => false,
                'error' => $message,
            ],
            JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES
        ) . PHP_EOL
    );
    exit(1);
};

try {
    $options = getopt('', [
        'app-root:',
        'storage-dir:',
        'db-file:',
        'allow-orphan-images',
    ]);
    $allowOrphanImages = isset($options['allow-orphan-images']);

    $appRoot = $options['app-root'] ?? null;
    $storageDir = $options['storage-dir'] ?? null;
    $customDbFile = $options['db-file'] ?? null;

    if (!is_string($appRoot) || !is_string($storageDir)) {
        $fail(
            'Usage: php scripts/check-install.php'
            . ' --app-root <path> --storage-dir <path>'
        );
    }

    if (!isAbsolutePath($appRoot) || !isAbsolutePath($storageDir)) {
        $fail('app-root and storage-dir must be absolute paths');
    }

    $appRoot = rtrim($appRoot, '/\\');
    $storageDir = rtrim($storageDir, '/\\');

    if (!is_dir($appRoot)) {
        $fail('Application root does not exist: ' . $appRoot);
    }

    if (!is_dir($storageDir)) {
        $fail('Storage directory does not exist: ' . $storageDir);
    }

    $oldStorage = getenv('NETARIUM_STORAGE_DIR');
    $oldDb = getenv('NETARIUM_DB_FILE');
    putenv('NETARIUM_STORAGE_DIR=' . $storageDir);
    if (is_string($customDbFile) && trim($customDbFile) !== '') {
        $customDbFile = trim($customDbFile);
        if (!isAbsolutePath($customDbFile)) {
            $fail('db-file must be an absolute path');
        }
        putenv('NETARIUM_DB_FILE=' . $customDbFile);
    } else {
        $customDbFile = null;
        putenv('NETARIUM_DB_FILE');
    }

    require_once $appRoot . DIRECTORY_SEPARATOR . 'bootstrap.php';

    $config = \Netarium\Core\Config::create();
    \Netarium\Services\Auth\PasswordHashing::assertSupported();
    $probePassword = bin2hex(random_bytes(16));
    $probeHash = \Netarium\Services\Auth\PasswordHashing::hash($probePassword);
    if (!\Netarium\Services\Auth\PasswordHashing::verify($probePassword, $probeHash, false)) {
        throw new RuntimeException('Argon2id generation/verification failed');
    }
    unset($probePassword, $probeHash);
    if (!(new \Netarium\Services\Auth\PasswordBlocklist())->isAvailable()) {
        throw new RuntimeException('Offline password blocklist is missing or corrupt');
    }
    $dbFile = $customDbFile ?? (string)$config['db_file'];
    $db = \Netarium\Core\Database::open($dbFile);

    if (!extension_loaded('gd')) {
        throw new RuntimeException('PHP extension gd is not loaded');
    }
    if (!extension_loaded('exif')) {
        throw new RuntimeException('PHP extension exif is not loaded');
    }
    if (!extension_loaded('mbstring')) {
        throw new RuntimeException('PHP extension mbstring is not loaded');
    }

    $schemaVersion = (int)$db
        ->query('PRAGMA user_version')
        ->fetchColumn();

    if ($schemaVersion !== APP_DATABASE_SCHEMA_VERSION) {
        throw new RuntimeException(
            'Unexpected database schema version: ' . $schemaVersion
        );
    }

    $foreignKeyErrors = $db
        ->query('PRAGMA foreign_key_check')
        ->fetchAll(PDO::FETCH_NUM);

    if ($foreignKeyErrors !== []) {
        throw new RuntimeException('PRAGMA foreign_key_check is not empty');
    }

    $runtimeDirectories = [
        $storageDir,
        dirname($dbFile),
        (string)$config['floor_plan_directory'],
        (string)$config['device_image_directory'],
        (string)$config['device_csv_import_directory'],
        (string)$config['backup_export_directory'],
        (string)$config['backup_restore_directory'],
        (string)$config['backup_auto_directory'],
        dirname((string)$config['backup_restore_log_file']),
        dirname((string)$config['operation_lock_file']),
    ];

    foreach (array_unique($runtimeDirectories) as $directory) {
        if (!is_dir($directory) || !is_writable($directory)) {
            throw new RuntimeException(
                'Runtime directory is missing or not writable: ' . $directory
            );
        }
    }
    $deviceImageDirectory = (string)$config['device_image_directory'];

    $floorPlanDirectory = (string)$config['floor_plan_directory'];
    $rows = $db
        ->query(
            'SELECT stored_name, file_size'
            . ' FROM view_floor_plans ORDER BY stored_name'
        )
        ->fetchAll(PDO::FETCH_ASSOC);

    $rowNames = [];
    foreach ($rows as $row) {
        $storedName = (string)($row['stored_name'] ?? '');
        $fileSize = (int)($row['file_size'] ?? -1);

        if (
            preg_match(
                '/\A[a-f0-9]{32}\.(?:png|jpg)\z/',
                $storedName
            ) !== 1
        ) {
            throw new RuntimeException(
                'Invalid floor-plan stored name: ' . $storedName
            );
        }

        if (isset($rowNames[$storedName])) {
            throw new RuntimeException(
                'Duplicate floor-plan stored name: ' . $storedName
            );
        }

        $rowNames[$storedName] = true;
        $filePath = $floorPlanDirectory
            . DIRECTORY_SEPARATOR
            . $storedName;

        if (!is_file($filePath)) {
            throw new RuntimeException(
                'Floor-plan file is missing: ' . $storedName
            );
        }

        $actualSize = filesize($filePath);
        if ($actualSize === false || (int)$actualSize !== $fileSize) {
            throw new RuntimeException(
                'Floor-plan file size does not match: ' . $storedName
            );
        }
    }

    $fileNames = [];
    $entries = scandir($floorPlanDirectory);
    if ($entries === false) {
        throw new RuntimeException(
            'Floor-plan directory cannot be read: ' . $floorPlanDirectory
        );
    }

    foreach ($entries as $entry) {
        if ($entry === '.' || $entry === '..') {
            continue;
        }

        $entryPath = $floorPlanDirectory
            . DIRECTORY_SEPARATOR
            . $entry;

        if (!is_file($entryPath)) {
            throw new RuntimeException(
                'Floor-plan directory contains a non-file entry: ' . $entry
            );
        }

        if (!$allowOrphanImages && !isset($rowNames[$entry])) {
            throw new RuntimeException(
                'Orphan floor-plan file: ' . $entry
            );
        }

        $fileNames[$entry] = true;
    }

    if (!$allowOrphanImages && count($fileNames) !== count($rowNames)) {
        throw new RuntimeException('Floor-plan row/file counts differ');
    }

    $deviceImageRows = $db
        ->query('SELECT stored_name, file_size FROM device_images ORDER BY stored_name')
        ->fetchAll(PDO::FETCH_ASSOC);

    $deviceImageRowNames = [];
    foreach ($deviceImageRows as $row) {
        $storedName = (string)($row['stored_name'] ?? '');
        $fileSize = (int)($row['file_size'] ?? -1);

        if (preg_match('/\A[a-f0-9]{32}\.(?:png|jpg)\z/', $storedName) !== 1) {
            throw new RuntimeException('Invalid device-image stored name: ' . $storedName);
        }
        if (isset($deviceImageRowNames[$storedName])) {
            throw new RuntimeException('Duplicate device-image stored name: ' . $storedName);
        }
        $deviceImageRowNames[$storedName] = true;
        $filePath = $deviceImageDirectory . DIRECTORY_SEPARATOR . $storedName;
        if (!is_file($filePath)) {
            throw new RuntimeException('Device-image file is missing: ' . $storedName);
        }
        $actualSize = filesize($filePath);
        if ($actualSize === false || (int)$actualSize !== $fileSize) {
            throw new RuntimeException('Device-image file size does not match: ' . $storedName);
        }
    }

    $deviceImageFileNames = [];
    $imageEntries = scandir($deviceImageDirectory);
    if ($imageEntries !== false) {
        foreach ($imageEntries as $entry) {
            if ($entry === '.' || $entry === '..') {
                continue;
            }
            $entryPath = $deviceImageDirectory . DIRECTORY_SEPARATOR . $entry;
            if (!is_file($entryPath)) {
                throw new RuntimeException('Device-image directory contains a non-file entry: ' . $entry);
            }
            if (!$allowOrphanImages && !isset($deviceImageRowNames[$entry])) {
                throw new RuntimeException('Orphan device-image file: ' . $entry);
            }
            $deviceImageFileNames[$entry] = true;
        }
    }
    if (!$allowOrphanImages && count($deviceImageFileNames) !== count($deviceImageRowNames)) {
        throw new RuntimeException('Device-image row/file counts differ');
    }

    $gcCount = (int)$db->query('SELECT COUNT(*) FROM device_image_gc')->fetchColumn();

    echo json_encode(
        [
            'ok' => true,
            'application_version' => defined('NETARIUM_VERSION')
                ? NETARIUM_VERSION
                : null,
            'schema_version' => $schemaVersion,
            'db_path' => $dbFile,
            'password_algorithm' => 'argon2id',
            'password_options' => \Netarium\Services\Auth\PasswordHashing::OPTIONS,
            'allow_legacy_bcrypt' => $config['allow_legacy_bcrypt'],
            'legacy_bcrypt_users' => (int)$db->query("SELECT COUNT(*) FROM users WHERE password_hash LIKE '\$2a\$%' OR password_hash LIKE '\$2b\$%' OR password_hash LIKE '\$2y\$%'")->fetchColumn(),
            'password_blocklist_available' => true,
            'must_change_password_users' => (int)$db->query('SELECT COUNT(*) FROM users WHERE must_change_password = 1')->fetchColumn(),
            'floor_plan_rows' => count($rows),
            'floor_plan_files' => count($fileNames),
            'device_image_rows' => count($deviceImageRows),
            'device_image_files' => count($deviceImageFileNames),
            'device_image_gc_rows' => $gcCount,
            // CLIの有効値。実FastCGIの値は別途IIS経由で確認する。
            'php_runtime' => [
                'sapi' => PHP_SAPI,
                'loaded_ini_file' => php_ini_loaded_file() ?: null,
                'upload_max_filesize' => ini_get('upload_max_filesize'),
                'post_max_size' => ini_get('post_max_size'),
                'memory_limit' => ini_get('memory_limit'),
                'max_execution_time' => ini_get('max_execution_time'),
            ],
            'storage_capacity' => \Netarium\Services\Storage\CapacityService::limits($config),
            'recommended_web_runtime' => [
                'upload_max_filesize' => '32M',
                'post_max_size' => '34M',
                'memory_limit' => '512M',
                'max_execution_time' => 300,
                'iis_request_bytes' => 33554432,
                'iis_image_upload_request_bytes' => 32505856,
            ],
        ],
        JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES
    ) . PHP_EOL;

    if ($oldStorage === false) {
        putenv('NETARIUM_STORAGE_DIR');
    } else {
        putenv('NETARIUM_STORAGE_DIR=' . $oldStorage);
    }

    if ($oldDb === false) {
        putenv('NETARIUM_DB_FILE');
    } else {
        putenv('NETARIUM_DB_FILE=' . $oldDb);
    }
} catch (Throwable $exception) {
    $fail($exception->getMessage());
}

function isAbsolutePath(string $path): bool
{
    return preg_match(
        '/\A(?:[A-Za-z]:[\\\\\/]|\/|\\\\\\\\)/',
        $path
    ) === 1;
}
