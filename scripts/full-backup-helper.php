<?php
declare(strict_types=1);

// Private, administrator-only JSON RPC worker. The same PHP flock as Web/CLI
// writers remains held until this worker exits, including the placement phase.
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
$appRoot = (isset($argv[1]) && !str_starts_with($argv[1], '-')) ? $argv[1] : dirname(__DIR__);
require_once $appRoot . '/bootstrap.php';
require_once $appRoot . '/src/Core/DatabaseSchema.php';

function fullSafeName(string $name): void
{
    if (!preg_match('~\A(?:db/data\.sqlite|(?:floorplans|device_images)/[A-Za-z0-9][A-Za-z0-9_.-]*)\z~D', $name)
        || str_contains($name, '..') || preg_match('~/(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)~i', $name)
        || str_ends_with($name, '.')) {
        throw new RuntimeException('Unsafe archive path: ' . $name);
    }
}

function fullDatabase(string $file, string $root, bool $prepare = false): array
{
    if (!is_file($file)) { throw new RuntimeException('Database missing'); }
    $db = new PDO('sqlite:' . $file, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    if ($prepare) { $db->beginTransaction(); } else { $db->exec('PRAGMA query_only=ON'); }
    try {
        if ((int)$db->query('PRAGMA user_version')->fetchColumn() !== APP_DATABASE_SCHEMA_VERSION) {
            throw new RuntimeException('Incompatible database schema');
        }
        if ($db->query('PRAGMA integrity_check')->fetchAll(PDO::FETCH_COLUMN) !== ['ok']
            || $db->query('PRAGMA foreign_key_check')->fetch() !== false) {
            throw new RuntimeException('SQLite integrity/foreign key check failed');
        }
        foreach (['view_floor_plans' => 'floorplans', 'device_images' => 'device_images'] as $table => $directory) {
            $key = $table === 'view_floor_plans' ? 'view_id' : 'id';
            foreach ($db->query("SELECT * FROM $table") as $row) {
                $name = $directory . '/' . $row['stored_name'];
                fullSafeName($name);
                $path = $root . '/' . $name;
                if (!is_file($path) || is_link($path) || filesize($path) !== (int)$row['file_size']) {
                    throw new RuntimeException('Image reference/size mismatch: ' . $name);
                }
                $sha = hash_file('sha256', $path);
                if ($sha === false) { throw new RuntimeException('Cannot hash image: ' . $name); }
                if ($prepare && $row['sha256'] === '') {
                    // Only the private backup snapshot may acquire a legacy digest.
                    $image = getimagesize($path);
                    if ($image === false || $image[0] !== (int)$row['image_width']
                        || $image[1] !== (int)$row['image_height'] || $image['mime'] !== $row['mime_type']) {
                        throw new RuntimeException('Image attributes mismatch: ' . $name);
                    }
                    $stmt = $db->prepare("UPDATE $table SET sha256 = ? WHERE $key = ? AND sha256 = ''");
                    $stmt->execute([$sha, $row[$key]]);
                } elseif (!is_string($row['sha256']) || !hash_equals($row['sha256'], $sha)) {
                    throw new RuntimeException('Image reference hash mismatch: ' . $name);
                }
            }
        }
        $counts = [];
        foreach ($db->query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'") as $row) {
            $table = $row['name'];
            $counts[$table] = (int)$db->query('SELECT COUNT(*) FROM "' . str_replace('"', '""', $table) . '"')->fetchColumn();
        }
        if ($prepare) { $db->commit(); }
        return $counts;
    } catch (Throwable $e) {
        if ($db->inTransaction()) { $db->rollBack(); }
        throw $e;
    }
}

function fullInventory(string $root): array
{
    $files = [];
    foreach (['db', 'floorplans', 'device_images'] as $directory) {
        if (!is_dir($root . '/' . $directory)) { throw new RuntimeException('Missing logical directory'); }
        foreach (new DirectoryIterator($root . '/' . $directory) as $item) {
            if ($item->isDot()) { continue; }
            $name = $directory . '/' . $item->getFilename();
            fullSafeName($name);
            if (!$item->isFile() || $item->isLink()) { throw new RuntimeException('Non-regular archive member'); }
            $files[$name] = ['bytes' => $item->getSize(), 'sha256' => hash_file('sha256', $item->getPathname())];
        }
    }
    ksort($files);
    return $files;
}

function fullExtract(string $archive, string $root, int $maxBytes, int $maxFiles): array
{
    $zip = new ZipArchive();
    if ($zip->open($archive, ZipArchive::CHECKCONS) !== true) { throw new RuntimeException('Invalid ZIP'); }
    try {
        if ($zip->numFiles < 2 || $zip->numFiles > $maxFiles + 1) { throw new RuntimeException('ZIP entry limit'); }
        $maxManifestBytes = min(64 * 1024 * 1024, max(2 * 1024 * 1024, $maxFiles * 512));
        $manifestText = $zip->getFromName('manifest.json', $maxManifestBytes + 1);
        if (!is_string($manifestText) || strlen($manifestText) > $maxManifestBytes) { throw new RuntimeException('Manifest missing/oversize'); }
        $m = json_decode($manifestText, true, 512, JSON_THROW_ON_ERROR);
        if (!is_array($m) || !\Netarium\Services\Backup\BackupCompatibilityPolicy::isCompatible(
                \Netarium\Services\Backup\BackupCompatibilityPolicy::FORMAT_FULL,
                $m['format'] ?? null,
                $m['format_version'] ?? null,
                $m['schema_version'] ?? null,
                $m['application_version'] ?? null,
                APP_DATABASE_SCHEMA_VERSION,
                NETARIUM_VERSION
            )) {
            throw new RuntimeException(
                \Netarium\Services\Backup\BackupCompatibilityPolicy::describeFullIncompatibility(
                    is_array($m) ? ($m['format'] ?? null) : null,
                    is_array($m) ? ($m['format_version'] ?? null) : null,
                    is_array($m) ? ($m['schema_version'] ?? null) : null,
                    is_array($m) ? ($m['application_version'] ?? null) : null,
                    APP_DATABASE_SCHEMA_VERSION,
                    NETARIUM_VERSION
                )
            );
        }
        $expectedManifestKeys = ['application_version', 'counts', 'created_at', 'file_count', 'files', 'format', 'format_version', 'logical_paths', 'schema_version', 'total_bytes'];
        $manifestKeys = array_keys($m);
        sort($manifestKeys);
        $expectedLogicalPaths = ['db' => 'db/data.sqlite', 'floor_plan_directory' => 'floorplans', 'device_image_directory' => 'device_images'];
        if ($manifestKeys !== $expectedManifestKeys || !is_array($m['files'] ?? null) || !is_array($m['counts'] ?? null)
            || ($m['logical_paths'] ?? null) !== $expectedLogicalPaths || !is_string($m['created_at'] ?? null) || $m['created_at'] === '') {
            throw new RuntimeException('Incompatible full backup manifest');
        }
        $seen = []; $total = 0;
        for ($i = 0; $i < $zip->numFiles; $i++) {
            $s = $zip->statIndex($i);
            $name = $s['name'];
            $key = strtolower($name);
            if (isset($seen[$key])) { throw new RuntimeException('Duplicate archive path'); }
            $seen[$key] = true;
            $opsys = 0; $attr = 0;
            if (!$zip->getExternalAttributesIndex($i, $opsys, $attr) || ($opsys === 3 && (($attr >> 16) & 0170000) !== 0 && (($attr >> 16) & 0170000) !== 0100000)) {
                throw new RuntimeException('ZIP special file rejected');
            }
            if ($name === 'manifest.json') { continue; }
            fullSafeName($name);
            $expected = $m['files'][$name] ?? null;
            if (!is_array($expected) || count($expected) !== 2 || !is_int($expected['bytes'] ?? null) || $expected['bytes'] < 0
                || $s['size'] !== $expected['bytes'] || !preg_match('/\A[0-9a-f]{64}\z/', $expected['sha256'] ?? '')) {
                throw new RuntimeException('Unexpected/malformed ZIP entry');
            }
            $total += $s['size'];
            if ($total > $maxBytes) { throw new RuntimeException('ZIP expansion limit'); }
        }
        if (count($seen) !== count($m['files']) + 1 || !isset($m['files']['db/data.sqlite'])
            || ($m['file_count'] ?? null) !== count($m['files']) || ($m['total_bytes'] ?? null) !== $total) {
            throw new RuntimeException('Missing archive members/totals');
        }
        if (disk_free_space($root) < $total + 64 * 1024 * 1024) { throw new RuntimeException('Insufficient staging disk'); }
        foreach (['db', 'floorplans', 'device_images'] as $dir) { mkdir($root . '/' . $dir, 0700); }
        foreach ($m['files'] as $name => $expected) {
            $in = $zip->getStream($name); $out = fopen($root . '/' . $name, 'xb');
            if ($in === false || $out === false) { throw new RuntimeException('Cannot extract entry'); }
            try {
                $bytes = stream_copy_to_stream($in, $out, $expected['bytes'] + 1);
                if ($bytes !== $expected['bytes'] || !fflush($out)) { throw new RuntimeException('Extraction length/write failure'); }
            } finally { fclose($in); fclose($out); }
            if (!hash_equals($expected['sha256'], hash_file('sha256', $root . '/' . $name))) { throw new RuntimeException('SHA-256 mismatch'); }
        }
        $counts = fullDatabase($root . '/db/data.sqlite', $root);
        if ($counts !== $m['counts']) { throw new RuntimeException('Database count mismatch'); }
        return $m;
    } finally { $zip->close(); }
}

if (!defined('NETARIUM_FULL_BACKUP_HELPER_NO_LOOP')) {
$config = \Netarium\Core\Config::create();
$gate = new \Netarium\Core\OperationGate((string)$config['operation_lock_file']);
while (($line = fgets(STDIN)) !== false) {
    $trimmed = trim($line);
    if (str_starts_with($trimmed, "\xEF\xBB\xBF")) {
        $trimmed = substr($trimmed, 3);
    }
    if ($trimmed === '') { continue; }
    try {
        $r = json_decode($trimmed, true, 512, JSON_THROW_ON_ERROR);
        $result = null;
        switch ($r['command']) {
            case 'config': $result = $config; break;
            case 'exit': exit(0);
            case 'lock': $gate->acquireExclusive(); break;
            case 'unlock': $gate->release(); break;
            case 'checkpoint':
                if (is_file($config['db_file'])) {
                    $db = new PDO('sqlite:' . $config['db_file'], null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
                    $db->exec('PRAGMA busy_timeout=0');
                    $check = $db->query('PRAGMA wal_checkpoint(TRUNCATE)')->fetch(PDO::FETCH_NUM);
                    if ((int)$check[0] !== 0 || $db->query('PRAGMA integrity_check')->fetchAll(PDO::FETCH_COLUMN) !== ['ok']) {
                        throw new RuntimeException('Live database checkpoint/integrity failure');
                    }
                    $db = null;
                }
                break;
            case 'snapshot':
                // VACUUM INTO uses SQLite's pager and includes committed WAL data.
                $db = new PDO('sqlite:' . $config['db_file'], null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
                $db->exec('PRAGMA busy_timeout=0');
                $db->exec('VACUUM INTO ' . $db->quote($r['destination']));
                $db = null;
                break;
            case 'prepare':
                $file = $r['root'] . '/db/data.sqlite';
                if (realpath($file) === realpath($config['db_file'])) { throw new RuntimeException('Cannot prepare live database'); }
                $result = fullDatabase($file, $r['root'], true);
                break;
            case 'validate': $result = fullDatabase($r['root'] . '/db/data.sqlite', $r['root']); break;
            case 'pack':
                $files = fullInventory($r['root']);
                $manifest = ['format' => 'netarium-full', 'format_version' => 1, 'created_at' => gmdate(DATE_ATOM),
                    'application_version' => NETARIUM_VERSION, 'schema_version' => APP_DATABASE_SCHEMA_VERSION,
                    'logical_paths' => ['db' => 'db/data.sqlite', 'floor_plan_directory' => 'floorplans', 'device_image_directory' => 'device_images'],
                    'file_count' => count($files), 'total_bytes' => array_sum(array_column($files, 'bytes')),
                    'counts' => fullDatabase($r['root'] . '/db/data.sqlite', $r['root']), 'files' => $files];
                $zip = new ZipArchive();
                if ($zip->open($r['destination'], ZipArchive::CREATE | ZipArchive::EXCL) !== true) { throw new RuntimeException('Cannot create ZIP'); }
                try {
                    if (!$zip->addFromString('manifest.json', json_encode($manifest, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES))) { throw new RuntimeException('Manifest write failure'); }
                    foreach ($files as $name => $metadata) {
                        if (!$zip->addFile($r['root'] . '/' . $name, $name)) { throw new RuntimeException('ZIP add failure'); }
                    }
                } catch (Throwable $e) { $zip->close(); throw $e; }
                if (!$zip->close()) { throw new RuntimeException('ZIP close failure'); }
                $result = $manifest;
                break;
            case 'extract': $result = fullExtract($r['archive'], $r['root'], $r['max_bytes'], $r['max_files']); break;
            default: throw new RuntimeException('Unknown command');
        }
        echo json_encode(['ok' => true, 'result' => $result], JSON_THROW_ON_ERROR | JSON_INVALID_UTF8_SUBSTITUTE) . "\n";
    } catch (Throwable $e) {
        echo json_encode(['ok' => false, 'error' => $e->getMessage()], JSON_THROW_ON_ERROR | JSON_INVALID_UTF8_SUBSTITUTE) . "\n";
    }
    flush();
}
}
