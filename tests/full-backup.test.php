<?php
declare(strict_types=1);
// Standalone subprocess tests: no IIS and no production storage access.
require_once dirname(__DIR__) . '/bootstrap.php';
require_once dirname(__DIR__) . '/src/Core/DatabaseSchema.php';
$root = sys_get_temp_dir() . '/netarium-full-test-' . bin2hex(random_bytes(8));
mkdir($root, 0700);
$workers = [];
$assertions = 0;
function check(bool $ok, string $message): void
{
    $GLOBALS['assertions']++;
    if (!$ok) { throw new RuntimeException($message); }
}
function rpc(array $worker, array $request, bool $ok = true): mixed
{
    fwrite($worker[1][0], json_encode($request, JSON_THROW_ON_ERROR) . "\n"); fflush($worker[1][0]);
    $line = fgets($worker[1][1]);
    check(is_string($line), 'Worker stopped');
    $r = json_decode($line, true, 512, JSON_THROW_ON_ERROR);
    check($r['ok'] === $ok, 'Unexpected worker result: ' . $line);
    return $r['result'] ?? null;
}
function removeTree(string $dir): void
{
    if (!is_dir($dir)) { return; }
    foreach (new DirectoryIterator($dir) as $entry) {
        if ($entry->isDot()) { continue; }
        if ($entry->isDir() && !$entry->isLink()) { removeTree($entry->getPathname()); } else { @unlink($entry->getPathname()); }
    }
    @rmdir($dir);
}
try {
    $storage = $root . '/storage'; mkdir($storage, 0700);
    mkdir($storage . '/db'); mkdir($storage . '/uploads'); mkdir($storage . '/uploads/floorplans'); mkdir($storage . '/uploads/device_images');
    $dbFile = $storage . '/db/data.sqlite';
    $db = new PDO('sqlite:' . $dbFile, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    // Populate schema10 first; schema11 must supply the real migration defaults.
    for ($version = 1; $version <= 10; $version++) { ('migrateDatabaseToVersion' . $version)($db); }
    $png = base64_decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=');
    $imageFiles = [];
    $db->exec("INSERT INTO devices (id, name) VALUES (1, 'backup-fixture')");
    foreach ([1, 2] as $id) {
        $db->exec("INSERT INTO views (id, name, view_type) VALUES ($id, 'floor-$id', 'floor')");
        $floor = $db->prepare("INSERT INTO view_floor_plans (view_id, stored_name, original_name, mime_type, file_size, image_width, image_height, created_at, updated_at)
            VALUES (?, ?, 'fixture.png', 'image/png', ?, 1, 1, '2026-01-01', '2026-01-01')");
        $floor->execute([$id, "floor-$id.png", strlen($png)]);
        $photo = $db->prepare("INSERT INTO device_images (device_id, stored_name, mime_type, file_size, image_width, image_height, sort_order, created_at, updated_at)
            VALUES (1, ?, 'image/png', ?, 1, 1, ?, '2026-01-01', '2026-01-01')");
        $photo->execute(["photo-$id.png", strlen($png), $id]);
        $imageFiles["floorplans/floor-$id.png"] = $png;
        $imageFiles["device_images/photo-$id.png"] = $png;
    }
    migrateDatabase($db);
    foreach (['view_floor_plans', 'device_images'] as $table) {
        check($db->query("SELECT sha256 FROM $table")->fetchAll(PDO::FETCH_COLUMN) === ['', ''], 'Migration did not leave empty digests');
    }
    $imageFiles['device_images/orphan.png'] = random_bytes(4096);
    foreach ($imageFiles as $name => $bytes) { file_put_contents($storage . '/uploads/' . $name, $bytes); }
    $password = password_hash('FullBackup-test-93!', PASSWORD_ARGON2ID);
    $now = date(DATE_ATOM);
    $insert = $db->prepare("INSERT INTO users (username, password_hash, role, created_at, updated_at) VALUES ('full-admin', ?, 'admin', ?, ?)");
    $insert->execute([$password, $now, $now]);
    $db->exec('PRAGMA journal_mode=WAL');
    $db->exec("INSERT OR REPLACE INTO app_meta (meta_key,meta_value) VALUES ('setup_completed','1')");
    $environment = getenv(); $environment['NETARIUM_STORAGE_DIR'] = $storage; $environment['NETARIUM_DB_FILE'] = $dbFile;
    for ($i = 0; $i < 2; $i++) {
        $pipes = [];
        $process = proc_open([PHP_BINARY, dirname(__DIR__) . '/scripts/full-backup-helper.php', dirname(__DIR__)],
            [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['file', $root . '/stderr-' . $i, 'a']], $pipes, null, $environment);
        check(is_resource($process), 'Cannot launch helper'); $workers[] = [$process, $pipes];
    }
    rpc($workers[0], ['command' => 'lock']);
    rpc($workers[1], ['command' => 'lock'], false);
    $stage = $root . '/snapshot'; mkdir($stage); mkdir($stage . '/db'); mkdir($stage . '/floorplans'); mkdir($stage . '/device_images');
    foreach ($imageFiles as $name => $bytes) { copy($storage . '/uploads/' . $name, $stage . '/' . $name); }
    $liveDbHash = hash_file('sha256', $dbFile);
    $liveWalHash = hash_file('sha256', $dbFile . '-wal');
    $liveRows = [];
    foreach (['users', 'view_floor_plans', 'device_images', 'app_meta', 'resource_sequences'] as $table) {
        $liveRows[$table] = $db->query("SELECT * FROM $table")->fetchAll(PDO::FETCH_ASSOC);
    }
    rpc($workers[0], ['command' => 'snapshot', 'destination' => $stage . '/db/data.sqlite']);
    $legacyDb = $root . '/legacy.sqlite'; copy($stage . '/db/data.sqlite', $legacyDb);
    foreach (['view_floor_plans' => 'floorplans/floor-1.png', 'device_images' => 'device_images/photo-1.png'] as $table => $name) {
        foreach (['digest', 'missing', 'size', 'path', 'width', 'mime', 'foreign-key'] as $fault) {
            $badStage = $root . '/stage-' . $table . '-' . $fault;
            foreach (['', '/db', '/floorplans', '/device_images'] as $dir) { mkdir($badStage . $dir); }
            copy($legacyDb, $badStage . '/db/data.sqlite');
            foreach ($imageFiles as $imageName => $bytes) { file_put_contents($badStage . '/' . $imageName, $bytes); }
            $badDb = new PDO('sqlite:' . $badStage . '/db/data.sqlite', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
            if ($fault === 'digest') { $badDb->exec("UPDATE $table SET sha256 = '" . str_repeat('0', 64) . "'"); }
            if ($fault === 'missing') { unlink($badStage . '/' . $name); }
            if ($fault === 'size') { $badDb->exec("UPDATE $table SET file_size = file_size + 1"); }
            if ($fault === 'path') { $badDb->exec("UPDATE $table SET stored_name = '../outside.png' WHERE stored_name = '" . basename($name) . "'"); }
            if ($fault === 'width') { $badDb->exec("UPDATE $table SET image_width = 2"); }
            if ($fault === 'mime') { $badDb->exec("UPDATE $table SET mime_type = 'image/jpeg'"); }
            if ($fault === 'foreign-key') {
                $owner = $table === 'view_floor_plans' ? 'view_id' : 'device_id';
                $badDb->exec("UPDATE $table SET $owner = $owner + 1000");
            }
            $beforeRows = [];
            foreach (['view_floor_plans', 'device_images'] as $t) { $beforeRows[$t] = $badDb->query("SELECT * FROM $t")->fetchAll(PDO::FETCH_ASSOC); }
            rpc($workers[0], ['command' => 'prepare', 'root' => $badStage], false);
            foreach ($beforeRows as $t => $rows) {
                check($badDb->query("SELECT * FROM $t")->fetchAll(PDO::FETCH_ASSOC) === $rows, 'Preparation failed to roll back: ' . $table . '/' . $fault);
            }
            $badDb = null;
            $badArchive = $root . '/rejected-' . $table . '-' . $fault . '.zip';
            rpc($workers[0], ['command' => 'pack', 'root' => $badStage, 'destination' => $badArchive], false);
            check(!file_exists($badArchive), 'Rejected preparation produced archive');
        }
    }
    // A backup without preparation, and a preparation aimed at the live DB, fail closed.
    rpc($workers[0], ['command' => 'pack', 'root' => $stage, 'destination' => $root . '/unprepared.zip'], false);
    check(!file_exists($root . '/unprepared.zip'), 'Empty digests were packed without preparation');
    rpc($workers[0], ['command' => 'prepare', 'root' => $storage], false);
    rpc($workers[0], ['command' => 'prepare', 'root' => $stage]);
    rpc($workers[0], ['command' => 'validate', 'root' => $stage]);
    $preparedHash = hash_file('sha256', $stage . '/db/data.sqlite');
    rpc($workers[0], ['command' => 'prepare', 'root' => $stage]);
    check(hash_file('sha256', $stage . '/db/data.sqlite') === $preparedHash, 'Repeated preparation changed DB');
    rpc($workers[0], ['command' => 'unlock']); rpc($workers[1], ['command' => 'lock']); rpc($workers[1], ['command' => 'unlock']);
    $archive = $root . '/good.zip';
    $manifest = rpc($workers[0], ['command' => 'pack', 'root' => $stage, 'destination' => $archive]);
    check($manifest['files']['db/data.sqlite']['sha256'] === $preparedHash, 'Manifest hashed DB before completion');
    $zip = new ZipArchive(); check($zip->open($archive) === true, 'Cannot open backup ZIP');
    foreach ($manifest['files'] as $name => $metadata) {
        $bytes = $zip->getFromName($name);
        check(is_string($bytes) && strlen($bytes) === $metadata['bytes'] && hash('sha256', $bytes) === $metadata['sha256'], 'ZIP/manifest mismatch: ' . $name);
    }
    $zip->close();
    $restored = $root . '/restored'; mkdir($restored);
    rpc($workers[0], ['command' => 'extract', 'archive' => $archive, 'root' => $restored, 'max_bytes' => 10000000, 'max_files' => 100]);
    $copy = new PDO('sqlite:' . $restored . '/db/data.sqlite');
    $user = $copy->query("SELECT * FROM users WHERE username='full-admin'")->fetch(PDO::FETCH_ASSOC);
    check($user['role'] === 'admin' && $user['password_hash'] === $password && password_verify('FullBackup-test-93!', $user['password_hash']), 'Credentials/role lost');
    check($copy->query("SELECT meta_value FROM app_meta WHERE meta_key='setup_completed'")->fetchColumn() === '1', 'WAL/setup marker lost');
    check(hash_file('sha256', $restored . '/device_images/orphan.png') === hash_file('sha256', $stage . '/device_images/orphan.png'), 'Physical image lost');
    foreach (['view_floor_plans' => 'floorplans', 'device_images' => 'device_images'] as $table => $directory) {
        foreach ($copy->query("SELECT * FROM $table") as $row) {
            $name = $directory . '/' . $row['stored_name'];
            check($row['sha256'] === hash('sha256', $imageFiles[$name])
                && $row['sha256'] === $manifest['files'][$name]['sha256']
                && $row['sha256'] === hash_file('sha256', $restored . '/' . $name), 'Restored reference/manifest mismatch');
        }
    }
    $copy = null;
    foreach (['tamper', 'missing', 'extra', 'slip', 'schema', 'app', 'corrupt', 'limit', 'count', 'integrity', 'empty-digest'] as $case) {
        $bad = $root . '/' . $case . '.zip'; copy($archive, $bad);
        $zip = new ZipArchive(); check($zip->open($bad) === true, 'Cannot mutate test ZIP');
        if ($case === 'tamper') { $zip->addFromString('device_images/orphan.png', str_repeat('x', 4096)); }
        if ($case === 'missing') { $zip->deleteName('db/data.sqlite'); }
        if ($case === 'extra') { $zip->addFromString('device_images/extra.png', 'x'); }
        if ($case === 'slip') { $zip->addFromString('../outside', 'x'); }
        $m = $manifest;
        if ($case === 'schema') { $m['schema_version']++; }
        if ($case === 'app') { $m['application_version'] = '0.invalid'; }
        if ($case === 'count') { $m['counts']['users']++; }
        if ($case === 'integrity') {
            $bytes = str_repeat('x', filesize($stage . '/db/data.sqlite'));
            $zip->addFromString('db/data.sqlite', $bytes);
            $m['files']['db/data.sqlite']['sha256'] = hash('sha256', $bytes);
        }
        if ($case === 'empty-digest') {
            $zip->addFile($legacyDb, 'db/data.sqlite');
            $m['files']['db/data.sqlite']['bytes'] = filesize($legacyDb);
            $m['files']['db/data.sqlite']['sha256'] = hash_file('sha256', $legacyDb);
            $m['total_bytes'] = array_sum(array_column($m['files'], 'bytes'));
        }
        if (in_array($case, ['schema','app','count','integrity','empty-digest'], true)) { $zip->addFromString('manifest.json', json_encode($m, JSON_THROW_ON_ERROR)); }
        $zip->close();
        if ($case === 'corrupt') { file_put_contents($bad, 'not a zip'); }
        $dest = $root . '/reject-' . $case; mkdir($dest);
        $before = hash_file('sha256', $dbFile);
        rpc($workers[0], ['command' => 'extract', 'archive' => $bad, 'root' => $dest, 'max_bytes' => $case === 'limit' ? 1 : 10000000, 'max_files' => 100], false);
        check($before === hash_file('sha256', $dbFile), 'Preflight touched live DB: ' . $case);
    }
    check(hash_file('sha256', $dbFile) === $liveDbHash && hash_file('sha256', $dbFile . '-wal') === $liveWalHash, 'Backup changed live DB/WAL bytes');
    foreach ($liveRows as $table => $rows) {
        check($db->query("SELECT * FROM $table")->fetchAll(PDO::FETCH_ASSOC) === $rows, 'Backup changed live rows: ' . $table);
    }
    foreach ($imageFiles as $name => $bytes) {
        check(hash_file('sha256', $storage . '/uploads/' . $name) === hash('sha256', $bytes), 'Backup changed live image');
    }
    $db = null;
    echo "PASS full backup: schema10->11 snapshot completion, 14 image fault cases, 11 archive fault cases, WAL/live invariance, ZIP/manifest/reference SHA, users/login, lock contention; $assertions assertions\n";
} finally {
    if (isset($copy)) { $copy = null; } if (isset($db)) { $db = null; }
    foreach ($workers as [$process, $pipes]) {
        @fwrite($pipes[0], json_encode(['command' => 'exit']) . "\n");
        @fflush($pipes[0]);
        @fclose($pipes[0]);
        @fclose($pipes[1]);
        proc_close($process);
    }
    gc_collect_cycles();
    removeTree($root);
}
