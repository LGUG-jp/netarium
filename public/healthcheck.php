<?php
declare(strict_types=1);

require_once dirname(__DIR__) . '/bootstrap.php';

header('Content-Type: application/json; charset=UTF-8');
header('Cache-Control: no-store, no-cache, must-revalidate');

try {
    $config = \Netarium\Core\Config::create();
    $storageDir = (string)$config['storage_dir'];
    $dbDir = dirname(APP_DB_FILE);

    if (!is_dir($storageDir) || !is_writable($storageDir) || !is_dir($dbDir) || !is_writable($dbDir)) {
        throw new \RuntimeException('Storage unavailable');
    }

    if (is_file(APP_DB_FILE)) {
        $db = new \PDO('sqlite:' . APP_DB_FILE, null, null, [
            \PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION,
        ]);
        $db->exec('PRAGMA busy_timeout = 1000');
        $db->exec('PRAGMA query_only = ON');
        $schemaVersion = (int)$db->query('PRAGMA user_version')->fetchColumn();
        if ($schemaVersion !== APP_DATABASE_SCHEMA_VERSION) {
            throw new \RuntimeException('Unexpected schema version');
        }
    }

    echo json_encode(['status' => 'ok'], JSON_UNESCAPED_SLASHES);
} catch (\Throwable) {
    http_response_code(503);
    echo json_encode(['status' => 'unavailable'], JSON_UNESCAPED_SLASHES);
}
