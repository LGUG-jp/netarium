<?php
declare(strict_types=1);
// Standalone subprocess tests: no IIS and no production storage access.
require_once dirname(__DIR__) . '/bootstrap.php';
require_once dirname(__DIR__) . '/src/Core/DatabaseSchema.php';
define('NETARIUM_FULL_BACKUP_HELPER_NO_LOOP', true);
require_once dirname(__DIR__) . '/scripts/full-backup-helper.php';
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
function copyTree(string $source, string $destination): void
{
    if (!is_dir($destination)) { mkdir($destination, 0700, true); }
    foreach (new DirectoryIterator($source) as $entry) {
        if ($entry->isDot()) { continue; }
        $target = $destination . '/' . $entry->getFilename();
        if ($entry->isDir()) { copyTree($entry->getPathname(), $target); } else { copy($entry->getPathname(), $target); }
    }
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
function pinLegacyFixtureSchema(string $app, int $version = 11): void
{
    // Pin an actual old migration chain, never just falsify archive metadata.
    $path = $app . '/src/Core/DatabaseSchema.php';
    $schema = (string)file_get_contents($path);
    file_put_contents($path, str_replace('const APP_DATABASE_SCHEMA_VERSION = 16;',
        'const APP_DATABASE_SCHEMA_VERSION = ' . $version . ';', $schema));
}

try {
    $fingerprintDb = new PDO('sqlite::memory:', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    $fingerprintDb->exec("CREATE TABLE kept (id INTEGER PRIMARY KEY, value, optional, bytes BLOB)");
    $fingerprintDb->exec("INSERT INTO kept VALUES (1,1,NULL,X'00FF'), (2,'1','',X'610062')");
    $oldColumns = ['id', 'value', 'optional', 'bytes'];
    $oldFingerprint = fullTableFingerprint($fingerprintDb, 'kept', $oldColumns);
    $fingerprintDb->exec('ALTER TABLE kept ADD COLUMN new_value TEXT NOT NULL DEFAULT \'new\'');
    check(fullTableFingerprint($fingerprintDb, 'kept', $oldColumns) === $oldFingerprint,
        'New columns must not alter preservation of old values');
    $fingerprintDb->exec("UPDATE kept SET value='1' WHERE id=1");
    check(fullTableFingerprint($fingerprintDb, 'kept', $oldColumns) !== $oldFingerprint,
        'Old-column type changes must alter the preservation digest');
    $fingerprintDb->exec('DELETE FROM kept WHERE id=2');
    check(fullTableFingerprint($fingerprintDb, 'kept', $oldColumns)['count'] === 1,
        'Preservation must count rows independently of their serialized values');
    $fingerprintDb = null;
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
    migrateDatabaseToVersion11($db);
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
    // Pin legacy workers independently of the candidate version.php.
    $v100App = $root . '/app-v100'; mkdir($v100App, 0700);
    mkdir($v100App . '/scripts', 0700);
    $v100Source = getenv('NETARIUM_BACKUP_V100_ROOT') ?: dirname(__DIR__);
    copy($v100Source . '/bootstrap.php', $v100App . '/bootstrap.php');
    file_put_contents($v100App . '/version.php', "<?php\ndeclare(strict_types=1);\nconst NETARIUM_VERSION = '1.0.0';\n");
    if ($v100Source !== dirname(__DIR__)) { copy($v100Source . '/version.php', $v100App . '/version.php'); }
    copyTree($v100Source . '/src', $v100App . '/src');
    if ($v100Source === dirname(__DIR__)) { pinLegacyFixtureSchema($v100App); }
    copy($v100Source . '/scripts/full-backup-helper.php', $v100App . '/scripts/full-backup-helper.php');
    for ($i = 0; $i < 2; $i++) {
        $pipes = [];
        $process = proc_open([PHP_BINARY, $v100App . '/scripts/full-backup-helper.php', $v100App],
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
    // Legacy programs produce compatibility archives; current code owns rejection coverage.
    $negativeWorker = $workers[0];
    if ($v100Source !== dirname(__DIR__)) {
        $validationApp = $root . '/app-validation'; mkdir($validationApp, 0700);
        mkdir($validationApp . '/scripts', 0700);
        copy(dirname(__DIR__) . '/bootstrap.php', $validationApp . '/bootstrap.php');
        copy($v100App . '/version.php', $validationApp . '/version.php');
        copyTree(dirname(__DIR__) . '/src', $validationApp . '/src');
        pinLegacyFixtureSchema($validationApp);
        copy(dirname(__DIR__) . '/scripts/full-backup-helper.php', $validationApp . '/scripts/full-backup-helper.php');
        $validationPipes = [];
        $validationProcess = proc_open([PHP_BINARY, $validationApp . '/scripts/full-backup-helper.php', $validationApp],
            [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['file', $root . '/stderr-validation', 'a']], $validationPipes, null, $environment);
        check(is_resource($validationProcess), 'Cannot launch current validation helper');
        $negativeWorker = [$validationProcess, $validationPipes]; $workers[] = $negativeWorker;
    }
    foreach (['tamper', 'missing', 'extra', 'slip', 'schema', 'app', 'reverse-101', 'legacy-030', 'unknown-manifest-key', 'unknown-file-key', 'corrupt', 'limit', 'count', 'integrity', 'empty-digest'] as $case) {
        $bad = $root . '/' . $case . '.zip'; copy($archive, $bad);
        $zip = new ZipArchive(); check($zip->open($bad) === true, 'Cannot mutate test ZIP');
        if ($case === 'tamper') { $zip->addFromString('device_images/orphan.png', str_repeat('x', 4096)); }
        if ($case === 'missing') { $zip->deleteName('db/data.sqlite'); }
        if ($case === 'extra') { $zip->addFromString('device_images/extra.png', 'x'); }
        if ($case === 'slip') { $zip->addFromString('../outside', 'x'); }
        $m = $manifest;
        if ($case === 'schema') { $m['schema_version']++; }
        if ($case === 'app') { $m['application_version'] = '0.invalid'; }
        if ($case === 'reverse-101') { $m['application_version'] = '1.0.1'; }
        if ($case === 'legacy-030') { $m['application_version'] = '0.3.0'; }
        if ($case === 'unknown-manifest-key') { $m['unexpected_field'] = 'x'; }
        if ($case === 'unknown-file-key') { $m['files']['db/data.sqlite']['unexpected'] = 'x'; }
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
        if (in_array($case, ['schema','app','reverse-101','legacy-030','unknown-manifest-key','unknown-file-key','count','integrity','empty-digest'], true)) { $zip->addFromString('manifest.json', json_encode($m, JSON_THROW_ON_ERROR)); }
        $zip->close();
        if ($case === 'corrupt') { file_put_contents($bad, 'not a zip'); }
        $dest = $root . '/reject-' . $case; mkdir($dest);
        $before = hash_file('sha256', $dbFile);
        rpc($negativeWorker, ['command' => 'extract', 'archive' => $bad, 'root' => $dest, 'max_bytes' => $case === 'limit' ? 1 : 10000000, 'max_files' => 100], false);
        check($before === hash_file('sha256', $dbFile), 'Preflight touched live DB: ' . $case);
    }

    // Isolated v1.0.1 worker: accepts older/same archives, rejects major/reverse versions.
    $v101App = $root . '/app-v101'; mkdir($v101App, 0700);
    mkdir($v101App . '/scripts', 0700);
    $v101Source = getenv('NETARIUM_BACKUP_V101_ROOT') ?: dirname(__DIR__);
    copy($v101Source . '/bootstrap.php', $v101App . '/bootstrap.php');
    file_put_contents($v101App . '/version.php', "<?php\ndeclare(strict_types=1);\nconst NETARIUM_VERSION = '1.0.1';\n");
    if ($v101Source !== dirname(__DIR__)) { copy($v101Source . '/version.php', $v101App . '/version.php'); }
    copyTree($v101Source . '/src', $v101App . '/src');
    if ($v101Source === dirname(__DIR__)) { pinLegacyFixtureSchema($v101App); }
    copy($v101Source . '/scripts/full-backup-helper.php', $v101App . '/scripts/full-backup-helper.php');
    $v101Pipes = [];
    $v101Process = proc_open([PHP_BINARY, $v101App . '/scripts/full-backup-helper.php', $v101App],
        [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['file', $root . '/stderr-v101', 'a']], $v101Pipes, null, $environment);
    check(is_resource($v101Process), 'Cannot launch v1.0.1 helper');
    $workers[] = [$v101Process, $v101Pipes];
    $v101Worker = [$v101Process, $v101Pipes];

    $restored100On101 = $root . '/restored-100-on-101'; mkdir($restored100On101);
    $extracted100Manifest = rpc($v101Worker, ['command' => 'extract', 'archive' => $archive, 'root' => $restored100On101, 'max_bytes' => 10000000, 'max_files' => 100]);
    check(($extracted100Manifest['application_version'] ?? null) === '1.0.0', 'v1.0.0 manifest version altered on v1.0.1 extract');
    $copy101 = new PDO('sqlite:' . $restored100On101 . '/db/data.sqlite');
    $user101 = $copy101->query("SELECT * FROM users WHERE username='full-admin'")->fetch(PDO::FETCH_ASSOC);
    check($user101['role'] === 'admin' && password_verify('FullBackup-test-93!', $user101['password_hash']), 'v1.0.0->v1.0.1 credentials lost');
    $copy101 = null;

    $archive101 = $root . '/good-101.zip';
    $manifest101 = rpc($v101Worker, ['command' => 'pack', 'root' => $stage, 'destination' => $archive101]);
    check(($manifest101['application_version'] ?? null) === '1.0.1', 'v1.0.1 pack did not record 1.0.1');
    $restored101On101 = $root . '/restored-101-on-101'; mkdir($restored101On101);
    $extracted101Manifest = rpc($v101Worker, ['command' => 'extract', 'archive' => $archive101, 'root' => $restored101On101, 'max_bytes' => 10000000, 'max_files' => 100]);
    check(($extracted101Manifest['application_version'] ?? null) === '1.0.1', 'v1.0.1->v1.0.1 extract failed');

    // Historical helpers retain their original reverse/major rejection behavior.
    $rejectReverse = $root . '/reject-real-101-on-100'; mkdir($rejectReverse);
    rpc($workers[0], ['command' => 'extract', 'archive' => $archive101, 'root' => $rejectReverse, 'max_bytes' => 10000000, 'max_files' => 100], false);
    foreach (['0.3.0', '1.0.2', '1.0.3', '2.0.0'] as $badVer) {
        $badVerZip = $root . '/reject-v101-' . $badVer . '.zip'; copy($archive, $badVerZip);
        $zip = new ZipArchive(); check($zip->open($badVerZip) === true, 'Cannot open badVerZip');
        $m = $manifest; $m['application_version'] = $badVer;
        $zip->addFromString('manifest.json', json_encode($m, JSON_THROW_ON_ERROR));
        $zip->close();
        $dest = $root . '/reject-v101-dest-' . $badVer; mkdir($dest);
        rpc($v101Worker, ['command' => 'extract', 'archive' => $badVerZip, 'root' => $dest, 'max_bytes' => 10000000, 'max_files' => 100], false);
    }
    $v102App = $root . '/app-v102'; mkdir($v102App, 0700);
    mkdir($v102App . '/scripts', 0700);
    copy(dirname(__DIR__) . '/bootstrap.php', $v102App . '/bootstrap.php');
    file_put_contents($v102App . '/version.php', "<?php\ndeclare(strict_types=1);\nconst NETARIUM_VERSION = '1.0.2';\n");
    copyTree(dirname(__DIR__) . '/src', $v102App . '/src');
    pinLegacyFixtureSchema($v102App);
    copy(dirname(__DIR__) . '/scripts/full-backup-helper.php', $v102App . '/scripts/full-backup-helper.php');
    $pipes102 = [];
    $process102 = proc_open([PHP_BINARY, $v102App . '/scripts/full-backup-helper.php', $v102App],
        [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['file', $root . '/stderr-v102', 'a']], $pipes102, null, $environment);
    check(is_resource($process102), 'Cannot launch v1.0.2 helper');
    $worker102 = [$process102, $pipes102]; $workers[] = $worker102;
    $archive102 = $root . '/good-102.zip';
    rpc($worker102, ['command' => 'pack', 'root' => $stage, 'destination' => $archive102]);
    foreach (['1.0.0' => $archive, '1.0.1' => $archive101, '1.0.2' => $archive102] as $sourceVersion => $sourceArchive) {
        $destination = $root . '/restored-' . $sourceVersion . '-on-102'; mkdir($destination);
        $extracted = rpc($worker102, ['command' => 'extract', 'archive' => $sourceArchive, 'root' => $destination, 'max_bytes' => 10000000, 'max_files' => 100]);
        check($extracted['application_version'] === $sourceVersion, 'Source version changed on v1.0.2 restore');
        check(hash_file('sha256', $destination . '/db/data.sqlite') === hash_file('sha256', $stage . '/db/data.sqlite'), 'Database bytes changed on v1.0.2 restore');
        foreach ($imageFiles as $name => $bytes) {
            check(hash_file('sha256', $destination . '/' . $name) === hash('sha256', $bytes), 'Image bytes changed on v1.0.2 restore');
        }
    }
    $reverse102 = $root . '/reject-102-on-101'; mkdir($reverse102);
    rpc($v101Worker, ['command' => 'extract', 'archive' => $archive102, 'root' => $reverse102, 'max_bytes' => 10000000, 'max_files' => 100], false);
    foreach (['1.0.3', '0.3.0'] as $unsupportedVersion) {
        $badZip = $root . '/reject-102-' . $unsupportedVersion . '.zip'; copy($archive102, $badZip);
        $zip = new ZipArchive(); check($zip->open($badZip) === true, 'Cannot open rejection ZIP');
        $badManifest = json_decode((string)$zip->getFromName('manifest.json'), true, 512, JSON_THROW_ON_ERROR);
        $badManifest['application_version'] = $unsupportedVersion;
        $zip->addFromString('manifest.json', json_encode($badManifest, JSON_THROW_ON_ERROR)); $zip->close();
        $destination = $root . '/reject-102-dest-' . $unsupportedVersion; mkdir($destination);
        rpc($worker102, ['command' => 'extract', 'archive' => $badZip, 'root' => $destination, 'max_bytes' => 10000000, 'max_files' => 100], false);
    }
    $v103App = $root . '/app-v103'; mkdir($v103App, 0700);
    mkdir($v103App . '/scripts', 0700);
    $v103Source = getenv('NETARIUM_BACKUP_V103_ROOT') ?: dirname(__DIR__);
    copy($v103Source . '/bootstrap.php', $v103App . '/bootstrap.php');
    file_put_contents($v103App . '/version.php', "<?php\ndeclare(strict_types=1);\nconst NETARIUM_VERSION = '1.0.3';\n");
    if ($v103Source !== dirname(__DIR__)) { copy($v103Source . '/version.php', $v103App . '/version.php'); }
    copyTree($v103Source . '/src', $v103App . '/src');
    if ($v103Source === dirname(__DIR__)) { pinLegacyFixtureSchema($v103App); }
    copy($v103Source . '/scripts/full-backup-helper.php', $v103App . '/scripts/full-backup-helper.php');
    $pipes103 = [];
    $process103 = proc_open([PHP_BINARY, $v103App . '/scripts/full-backup-helper.php', $v103App],
        [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['file', $root . '/stderr-v103', 'a']], $pipes103, null, $environment);
    check(is_resource($process103), 'Cannot launch v1.0.3 helper');
    $worker103 = [$process103, $pipes103]; $workers[] = $worker103;
    $archive103 = $root . '/good-103.zip';
    rpc($worker103, ['command' => 'pack', 'root' => $stage, 'destination' => $archive103]);
    foreach (['1.0.0' => $archive, '1.0.1' => $archive101, '1.0.2' => $archive102, '1.0.3' => $archive103] as $sourceVersion => $sourceArchive) {
        $destination = $root . '/restored-' . $sourceVersion . '-on-103'; mkdir($destination);
        $extracted = rpc($worker103, ['command' => 'extract', 'archive' => $sourceArchive, 'root' => $destination, 'max_bytes' => 10000000, 'max_files' => 100]);
        check($extracted['application_version'] === $sourceVersion, 'Source version changed on v1.0.3 restore');
        check(hash_file('sha256', $destination . '/db/data.sqlite') === hash_file('sha256', $stage . '/db/data.sqlite'), 'Database bytes changed on v1.0.3 restore');
        foreach ($imageFiles as $name => $bytes) {
            check(hash_file('sha256', $destination . '/' . $name) === hash('sha256', $bytes), 'Image bytes changed on v1.0.3 restore');
        }
    }
    $reverse103On102 = $root . '/reject-103-on-102'; mkdir($reverse103On102);
    rpc($worker102, ['command' => 'extract', 'archive' => $archive103, 'root' => $reverse103On102, 'max_bytes' => 10000000, 'max_files' => 100], false);
    foreach (['1.0.4', '0.3.0'] as $unsupportedVersion) {
        $badZip = $root . '/reject-103-' . $unsupportedVersion . '.zip'; copy($archive103, $badZip);
        $zip = new ZipArchive(); check($zip->open($badZip) === true, 'Cannot open rejection ZIP');
        $badManifest = json_decode((string)$zip->getFromName('manifest.json'), true, 512, JSON_THROW_ON_ERROR);
        $badManifest['application_version'] = $unsupportedVersion;
        $zip->addFromString('manifest.json', json_encode($badManifest, JSON_THROW_ON_ERROR)); $zip->close();
        $destination = $root . '/reject-103-dest-' . $unsupportedVersion; mkdir($destination);
        rpc($worker103, ['command' => 'extract', 'archive' => $badZip, 'root' => $destination, 'max_bytes' => 10000000, 'max_files' => 100], false);
    }
    $v110App = $root . '/app-v110'; mkdir($v110App, 0700);
    mkdir($v110App . '/scripts', 0700);
    $v110Source = getenv('NETARIUM_BACKUP_V110_ROOT') ?: dirname(__DIR__);
    copy($v110Source . '/bootstrap.php', $v110App . '/bootstrap.php');
    file_put_contents($v110App . '/version.php', "<?php\ndeclare(strict_types=1);\nconst NETARIUM_VERSION = '1.1.0';\n");
    if ($v110Source !== dirname(__DIR__)) { copy($v110Source . '/version.php', $v110App . '/version.php'); }
    copyTree($v110Source . '/src', $v110App . '/src');
    if ($v110Source === dirname(__DIR__)) { pinLegacyFixtureSchema($v110App); }
    copy($v110Source . '/scripts/full-backup-helper.php', $v110App . '/scripts/full-backup-helper.php');
    $pipes110 = [];
    $process110 = proc_open([PHP_BINARY, $v110App . '/scripts/full-backup-helper.php', $v110App],
        [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['file', $root . '/stderr-v110', 'a']], $pipes110, null, $environment);
    check(is_resource($process110), 'Cannot launch v1.1.0 helper');
    $worker110 = [$process110, $pipes110]; $workers[] = $worker110;
    $archive110 = $root . '/good-110.zip';
    $manifest110 = rpc($worker110, ['command' => 'pack', 'root' => $stage, 'destination' => $archive110]);
    check($manifest110['application_version'] === '1.1.0', 'v1.1.0 pack did not record 1.1.0');
    $reverse110On103 = $root . '/reject-110-on-103'; mkdir($reverse110On103);
    rpc($worker103, ['command' => 'extract', 'archive' => $archive110, 'root' => $reverse110On103, 'max_bytes' => 10000000, 'max_files' => 100], false);
    // Candidate version is isolated: repository version.php remains unchanged.
    $candidateVersion = '1.3.0';
    $candidateApp = $root . '/app-candidate'; mkdir($candidateApp); mkdir($candidateApp . '/scripts');
    copy(dirname(__DIR__) . '/bootstrap.php', $candidateApp . '/bootstrap.php');
    file_put_contents($candidateApp . '/version.php', "<?php\ndeclare(strict_types=1);\nconst NETARIUM_VERSION = '$candidateVersion';\n");
    copyTree(dirname(__DIR__) . '/src', $candidateApp . '/src');
    copy(dirname(__DIR__) . '/scripts/full-backup-helper.php', $candidateApp . '/scripts/full-backup-helper.php');
    $currentPipes = [];
    $currentProcess = proc_open([PHP_BINARY, $candidateApp . '/scripts/full-backup-helper.php', $candidateApp],
        [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['file', $root . '/stderr-current', 'a']], $currentPipes, null, $environment);
    check(is_resource($currentProcess), 'Cannot launch current helper');
    $currentWorker = [$currentProcess, $currentPipes]; $workers[] = $currentWorker;
    $currentStage = $root . '/current-snapshot';
    copyTree($stage, $currentStage);
    $currentDb = new PDO('sqlite:' . $currentStage . '/db/data.sqlite', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    migrateDatabase($currentDb);
    $currentDb->exec("UPDATE devices SET type='pc' WHERE id=1");
    $currentDb->exec("INSERT INTO views (id,name,view_type) VALUES (90,'full-rack','rack')");
    $currentDb->exec("INSERT INTO rack_settings VALUES (90,42,'room')");
    $currentDb->exec("INSERT INTO rack_mounts VALUES (1,90,'rear',2,3,'left','full')");
    $currentDb->exec("INSERT INTO devices(id,name) VALUES (2,'shelf child')");
    $currentDb->exec("INSERT INTO rack_shelves VALUES (1,90,'Backup shelf','front',10,1,'full')");
    $currentDb->exec('INSERT INTO rack_shelf_devices VALUES (2,1,0)');
    $currentDb->exec("INSERT INTO views(id,name,view_type) VALUES (91,'Rack floor','floor')");
    $currentDb->exec('INSERT INTO floor_rack_placements VALUES (91,90,12.5,-20)');
    $currentFloorRacks = $currentDb->query('SELECT * FROM floor_rack_placements')->fetchAll(PDO::FETCH_ASSOC);
    $currentDb->exec("INSERT INTO canvas_notes (id,view_id,text,x,y,width,height,background_color,background_opacity,text_color,font_size)
        VALUES (9001,90,' ラック注釈 <b>文字</b> ',12.5,22,360,180,'#FFF3B0',0.4,'#ABCDEF',24)");
    $currentNotes = $currentDb->query('SELECT * FROM canvas_notes WHERE view_id=90 ORDER BY id')->fetchAll(PDO::FETCH_ASSOC);
    $currentMounts = $currentDb->query('SELECT * FROM rack_mounts')->fetchAll(PDO::FETCH_ASSOC);
    $currentDb = null;
    $currentArchive = $root . '/good-current.zip';
    $candidateManifest = rpc($currentWorker, ['command' => 'pack', 'root' => $currentStage, 'destination' => $currentArchive]);
    check($candidateManifest['application_version'] === '1.3.0' && $candidateManifest['schema_version'] === 16,
        'Candidate helper must use isolated app1.3.0/schema16');
    // Prefer the unchanged official public v1.2.0 source tree (schema11).
    // Without that root, this is explicitly a current-code/schema11 fixture,
    // not evidence that the historical release helper produced the archive.
    $legacy120App = $root . '/app-legacy120'; mkdir($legacy120App); mkdir($legacy120App . '/scripts');
    $v120Source = getenv('NETARIUM_BACKUP_V120_ROOT') ?: dirname(__DIR__);
    copy($v120Source . '/bootstrap.php', $legacy120App . '/bootstrap.php');
    if ($v120Source !== dirname(__DIR__)) {
        copy($v120Source . '/version.php', $legacy120App . '/version.php');
    } else {
        file_put_contents($legacy120App . '/version.php', "<?php\ndeclare(strict_types=1);\nconst NETARIUM_VERSION = '1.2.0';\n");
    }
    copyTree($v120Source . '/src', $legacy120App . '/src');
    if ($v120Source === dirname(__DIR__)) { pinLegacyFixtureSchema($legacy120App); }
    copy($v120Source . '/scripts/full-backup-helper.php', $legacy120App . '/scripts/full-backup-helper.php');
    $legacy120Pipes = [];
    $legacy120Process = proc_open([PHP_BINARY, $legacy120App . '/scripts/full-backup-helper.php', $legacy120App],
        [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['file', $root . '/stderr-legacy120', 'a']], $legacy120Pipes, null, $environment);
    check(is_resource($legacy120Process), 'Cannot launch schema11 v1.2.0 source helper');
    $legacy120Worker = [$legacy120Process, $legacy120Pipes]; $workers[] = $legacy120Worker;
    $legacy120Archive = $root . '/legacy120.zip';
    $legacy120Manifest = rpc($legacy120Worker, ['command' => 'pack', 'root' => $stage, 'destination' => $legacy120Archive]);
    check($legacy120Manifest['application_version'] === '1.2.0' && $legacy120Manifest['schema_version'] === 11,
        'v1.2.0 source helper did not create a schema11 archive');
    $legacy120Destination = $root . '/restored-legacy120'; mkdir($legacy120Destination);
    $source120 = rpc($currentWorker, ['command' => 'extract', 'archive' => $legacy120Archive, 'root' => $legacy120Destination, 'max_bytes' => 10000000, 'max_files' => 100]);
    check($source120['application_version'] === '1.2.0' && $source120['schema_version'] === 11, 'Legacy1.2 source metadata was falsified');
    $legacy120Db = new PDO('sqlite:' . $legacy120Destination . '/db/data.sqlite');
    check((int)$legacy120Db->query('PRAGMA user_version')->fetchColumn() === 16, 'Legacy1.2 was not migrated');
    check($legacy120Db->query('SELECT * FROM users ORDER BY id')->fetchAll(PDO::FETCH_ASSOC) === $liveRows['users'],
        'v1.2.0->v1.3.0 changed users or password hashes');
    foreach ($imageFiles as $name => $bytes) {
        check(hash_file('sha256', $legacy120Destination . '/' . $name) === hash('sha256', $bytes),
            'v1.2.0->v1.3.0 changed image bytes');
    }
    $legacy120Db = null;
    $schema12App = $root . '/app-schema12'; mkdir($schema12App); mkdir($schema12App . '/scripts');
    copy(dirname(__DIR__) . '/bootstrap.php', $schema12App . '/bootstrap.php');
    copy(dirname(__DIR__) . '/version.php', $schema12App . '/version.php');
    copyTree(dirname(__DIR__) . '/src', $schema12App . '/src');
    pinLegacyFixtureSchema($schema12App, 12);
    copy(dirname(__DIR__) . '/scripts/full-backup-helper.php', $schema12App . '/scripts/full-backup-helper.php');
    $schema12Process = proc_open([PHP_BINARY, $schema12App . '/scripts/full-backup-helper.php', $schema12App],
        [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['file', $root . '/stderr-schema12', 'a']], $schema12Pipes, null, $environment);
    check(is_resource($schema12Process), 'Cannot launch schema12 fixture');
    $schema12Worker = [$schema12Process, $schema12Pipes]; $workers[] = $schema12Worker;
    $schema12Stage = $root . '/schema12-snapshot';
    copyTree($stage, $schema12Stage);
    $schema12Db = new PDO('sqlite:' . $schema12Stage . '/db/data.sqlite', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    migrateDatabaseToVersion12($schema12Db);
    $schema12Db->exec("INSERT INTO views(id,name,view_type) VALUES (90,'Old rack','rack')");
    $schema12Db->exec("INSERT INTO rack_settings VALUES (90,42,'Legacy room')");
    $schema12Db->exec("INSERT INTO rack_mounts VALUES (1,90,'rear',2,3,'left')");
    $schema12Db = null;
    $schema12Archive = $root . '/schema12.zip';
    rpc($schema12Worker, ['command' => 'pack', 'root' => $schema12Stage, 'destination' => $schema12Archive]);
    $schema12Destination = $root . '/restored-schema12'; mkdir($schema12Destination);
    $schema12Source = rpc($currentWorker, ['command' => 'extract', 'archive' => $schema12Archive,
        'root' => $schema12Destination, 'max_bytes' => 10000000, 'max_files' => 100]);
    check($schema12Source['schema_version'] === 12, 'Schema12 source metadata changed');
    $schema12Restored = new PDO('sqlite:' . $schema12Destination . '/db/data.sqlite', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    check((int)$schema12Restored->query('PRAGMA user_version')->fetchColumn() === 16, 'Schema12 not migrated');
    check($schema12Restored->query('PRAGMA foreign_key_check')->fetch() === false, 'Schema12 migration broke foreign keys');
    check($schema12Restored->query('SELECT location FROM rack_settings WHERE view_id=90')->fetchColumn() === 'Legacy room', 'Schema12 rack data lost');
    check($schema12Restored->query('SELECT depth FROM rack_mounts')->fetchColumn() === 'half', 'Schema12 depth default missing');
    $schema12Restored->exec("UPDATE devices SET type='pc' WHERE id=1");
    $schema12Restored = null;
    $migratedArchive = $root . '/schema12-to13.zip';
    rpc($currentWorker, ['command' => 'pack', 'root' => $schema12Destination, 'destination' => $migratedArchive]);
    $migratedDestination = $root . '/schema12-to13-roundtrip'; mkdir($migratedDestination);
    rpc($currentWorker, ['command' => 'extract', 'archive' => $migratedArchive,
        'root' => $migratedDestination, 'max_bytes' => 10000000, 'max_files' => 100]);
    check(hash_file('sha256', $migratedDestination . '/db/data.sqlite')
        === hash_file('sha256', $schema12Destination . '/db/data.sqlite'), 'Migrated PC DB did not round trip');
    $reverse12 = $root . '/reject13-on12'; mkdir($reverse12);
    rpc($schema12Worker, ['command' => 'extract', 'archive' => $currentArchive,
        'root' => $reverse12, 'max_bytes' => 10000000, 'max_files' => 100], false);
    $schema13App = $root . '/app-schema13'; mkdir($schema13App); mkdir($schema13App . '/scripts');
    copy(dirname(__DIR__) . '/bootstrap.php', $schema13App . '/bootstrap.php');
    copy(dirname(__DIR__) . '/version.php', $schema13App . '/version.php');
    copyTree(dirname(__DIR__) . '/src', $schema13App . '/src');
    pinLegacyFixtureSchema($schema13App, 13);
    copy(dirname(__DIR__) . '/scripts/full-backup-helper.php', $schema13App . '/scripts/full-backup-helper.php');
    $schema13Process = proc_open([PHP_BINARY, $schema13App . '/scripts/full-backup-helper.php', $schema13App],
        [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['file', $root . '/stderr-schema13', 'a']], $schema13Pipes, null, $environment);
    check(is_resource($schema13Process), 'Cannot launch schema13 fixture');
    $schema13Worker = [$schema13Process, $schema13Pipes]; $workers[] = $schema13Worker;
    $schema13Stage = $root . '/schema13-snapshot'; copyTree($schema12Stage, $schema13Stage);
    $schema13Db = new PDO('sqlite:' . $schema13Stage . '/db/data.sqlite', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    migrateDatabaseToVersion13($schema13Db);
    $schema13Db->exec("UPDATE devices SET type='pc' WHERE id=1");
    $schema13Before = $schema13Db->query('SELECT * FROM rack_mounts')->fetchAll(PDO::FETCH_ASSOC);
    $schema13Db = null;
    $schema13Archive = $root . '/schema13.zip';
    rpc($schema13Worker, ['command' => 'pack', 'root' => $schema13Stage, 'destination' => $schema13Archive]);
    $schema13Destination = $root . '/restored-schema13'; mkdir($schema13Destination);
    $schema13Source = rpc($currentWorker, ['command' => 'extract', 'archive' => $schema13Archive,
        'root' => $schema13Destination, 'max_bytes' => 10000000, 'max_files' => 100]);
    check($schema13Source['schema_version'] === 13, 'Schema13 source metadata changed');
    $schema13Restored = new PDO('sqlite:' . $schema13Destination . '/db/data.sqlite');
    check((int)$schema13Restored->query('PRAGMA user_version')->fetchColumn() === 16, 'Schema13 not migrated');
    check($schema13Restored->query('SELECT * FROM rack_mounts')->fetchAll(PDO::FETCH_ASSOC)
        === array_map(static fn($row) => $row + ['depth' => 'half'], $schema13Before), 'Schema13 mount values changed');
    check($schema13Restored->query('SELECT type FROM devices WHERE id=1')->fetchColumn() === 'pc', 'Schema13 PC lost');
    $schema13Restored = null;
    $schema14App = $root . '/app-schema14'; mkdir($schema14App); mkdir($schema14App . '/scripts');
    copy(dirname(__DIR__) . '/bootstrap.php', $schema14App . '/bootstrap.php');
    copy(dirname(__DIR__) . '/version.php', $schema14App . '/version.php');
    copyTree(dirname(__DIR__) . '/src', $schema14App . '/src');
    pinLegacyFixtureSchema($schema14App, 14);
    copy(dirname(__DIR__) . '/scripts/full-backup-helper.php', $schema14App . '/scripts/full-backup-helper.php');
    $schema14Process = proc_open([PHP_BINARY, $schema14App . '/scripts/full-backup-helper.php', $schema14App],
        [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['file', $root . '/stderr-schema14', 'a']], $schema14Pipes, null, $environment);
    check(is_resource($schema14Process), 'Cannot launch schema14 fixture');
    $schema14Worker = [$schema14Process, $schema14Pipes]; $workers[] = $schema14Worker;
    $schema14Stage = $root . '/schema14-snapshot'; copyTree($schema13Stage, $schema14Stage);
    $schema14Db = new PDO('sqlite:' . $schema14Stage . '/db/data.sqlite');
    migrateDatabaseToVersion14($schema14Db);
    $schema14Db->exec("UPDATE rack_mounts SET depth='full'");
    $schema14Before = $schema14Db->query('SELECT * FROM rack_mounts')->fetchAll(PDO::FETCH_ASSOC);
    $schema14Db = null;
    $schema14Archive = $root . '/schema14.zip';
    rpc($schema14Worker, ['command' => 'pack', 'root' => $schema14Stage, 'destination' => $schema14Archive]);
    $schema14Destination = $root . '/restored-schema14'; mkdir($schema14Destination);
    $schema14Source = rpc($currentWorker, ['command' => 'extract', 'archive' => $schema14Archive,
        'root' => $schema14Destination, 'max_bytes' => 10000000, 'max_files' => 100]);
    check($schema14Source['schema_version'] === 14, 'Schema14 source metadata changed');
    $schema14Restored = new PDO('sqlite:' . $schema14Destination . '/db/data.sqlite');
    check((int)$schema14Restored->query('PRAGMA user_version')->fetchColumn() === 16, 'Schema14 not migrated');
    check($schema14Restored->query('SELECT * FROM rack_mounts')->fetchAll(PDO::FETCH_ASSOC) === $schema14Before, 'Schema14 depth lost');
    check((int)$schema14Restored->query('SELECT COUNT(*) FROM rack_shelves')->fetchColumn() === 0, 'Migration invented shelves');
    $schema14Restored = null;
    $schema15App = $root . '/app-schema15'; mkdir($schema15App); mkdir($schema15App . '/scripts');
    copy(dirname(__DIR__) . '/bootstrap.php', $schema15App . '/bootstrap.php');
    copy(dirname(__DIR__) . '/version.php', $schema15App . '/version.php');
    copyTree(dirname(__DIR__) . '/src', $schema15App . '/src');
    pinLegacyFixtureSchema($schema15App, 15);
    copy(dirname(__DIR__) . '/scripts/full-backup-helper.php', $schema15App . '/scripts/full-backup-helper.php');
    $schema15Process = proc_open([PHP_BINARY, $schema15App . '/scripts/full-backup-helper.php', $schema15App],
        [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['file', $root . '/stderr-schema15', 'a']], $schema15Pipes, null, $environment);
    check(is_resource($schema15Process), 'Cannot launch schema15 fixture');
    $schema15Worker = [$schema15Process, $schema15Pipes]; $workers[] = $schema15Worker;
    $schema15Stage = $root . '/schema15-snapshot'; copyTree($schema14Stage, $schema15Stage);
    $schema15Db = new PDO('sqlite:' . $schema15Stage . '/db/data.sqlite');
    migrateDatabaseToVersion15($schema15Db);
    $schema15Db->exec("INSERT INTO rack_shelves VALUES (1,90,'Legacy shelf','front',10,1,'full')");
    $schema15Shelves = $schema15Db->query('SELECT * FROM rack_shelves')->fetchAll(PDO::FETCH_ASSOC);
    $schema15Db = null;
    $schema15Archive = $root . '/schema15.zip';
    rpc($schema15Worker, ['command' => 'pack', 'root' => $schema15Stage, 'destination' => $schema15Archive]);
    $schema15Destination = $root . '/restored-schema15'; mkdir($schema15Destination);
    $schema15Source = rpc($currentWorker, ['command' => 'extract', 'archive' => $schema15Archive,
        'root' => $schema15Destination, 'max_bytes' => 10000000, 'max_files' => 100]);
    check($schema15Source['schema_version'] === 15, 'Schema15 source metadata changed');
    $schema15Restored = new PDO('sqlite:' . $schema15Destination . '/db/data.sqlite');
    check((int)$schema15Restored->query('PRAGMA user_version')->fetchColumn() === 16, 'Schema15 not migrated');
    check($schema15Restored->query('SELECT * FROM rack_shelves')->fetchAll(PDO::FETCH_ASSOC) === $schema15Shelves, 'Schema15 shelf lost');
    check((int)$schema15Restored->query('SELECT COUNT(*) FROM floor_rack_placements')->fetchColumn() === 0, 'Migration invented floor references');
    $schema15Restored = null;
    $reverse13 = $root . '/reject14-on13'; mkdir($reverse13);
    rpc($schema13Worker, ['command' => 'extract', 'archive' => $currentArchive,
        'root' => $reverse13, 'max_bytes' => 10000000, 'max_files' => 100], false);
    foreach ([12 => [$schema12Stage, $schema12Archive], 13 => [$schema13Stage, $schema13Archive]] as $sourceSchema => [$sourceStage, $sourceArchive]) {
        $mixedDbFile = $root . '/legacy-depth-' . $sourceSchema . '.sqlite';
        copy($sourceStage . '/db/data.sqlite', $mixedDbFile);
        $mixedDb = new PDO('sqlite:' . $mixedDbFile);
        $mixedDb->exec("ALTER TABLE rack_mounts ADD COLUMN depth TEXT NOT NULL DEFAULT 'full'");
        $mixedDb = null;
        $mixedArchive = $root . '/legacy-depth-' . $sourceSchema . '.zip'; copy($sourceArchive, $mixedArchive);
        $zip = new ZipArchive(); check($zip->open($mixedArchive) === true, 'Cannot mutate legacy depth ZIP');
        $mixedManifest = json_decode((string)$zip->getFromName('manifest.json'), true, 512, JSON_THROW_ON_ERROR);
        $mixedManifest['total_bytes'] += filesize($mixedDbFile) - $mixedManifest['files']['db/data.sqlite']['bytes'];
        $mixedManifest['files']['db/data.sqlite'] = ['bytes' => filesize($mixedDbFile), 'sha256' => hash_file('sha256', $mixedDbFile)];
        $zip->addFile($mixedDbFile, 'db/data.sqlite');
        $zip->addFromString('manifest.json', json_encode($mixedManifest, JSON_THROW_ON_ERROR)); $zip->close();
        $mixedDestination = $root . '/reject-legacy-depth-' . $sourceSchema; mkdir($mixedDestination);
        rpc($currentWorker, ['command' => 'extract', 'archive' => $mixedArchive,
            'root' => $mixedDestination, 'max_bytes' => 10000000, 'max_files' => 100], false);
        $mixedRestored = new PDO('sqlite:' . $mixedDestination . '/db/data.sqlite');
        check((int)$mixedRestored->query('PRAGMA user_version')->fetchColumn() === $sourceSchema, 'Mixed depth source migrated before rejection');
        $mixedRestored = null;
    }
    foreach ([11 => [$stage, $legacy120Archive], 12 => [$schema12Stage, $schema12Archive]] as $schema => [$sourceStage, $sourceArchive]) {
        $invalidDbFile = $root . '/legacy-pc-' . $schema . '.sqlite';
        copy($sourceStage . '/db/data.sqlite', $invalidDbFile);
        $invalidDb = new PDO('sqlite:' . $invalidDbFile, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        $invalidDb->exec('PRAGMA ignore_check_constraints=ON');
        $invalidDb->exec("UPDATE devices SET type='pc' WHERE id=1");
        $invalidDb = null;
        $invalidArchive = $root . '/legacy-pc-' . $schema . '.zip'; copy($sourceArchive, $invalidArchive);
        $zip = new ZipArchive(); check($zip->open($invalidArchive) === true, 'Cannot mutate legacy PC ZIP');
        $invalidManifest = json_decode((string)$zip->getFromName('manifest.json'), true, 512, JSON_THROW_ON_ERROR);
        $invalidManifest['total_bytes'] += filesize($invalidDbFile) - $invalidManifest['files']['db/data.sqlite']['bytes'];
        $invalidManifest['files']['db/data.sqlite'] = ['bytes' => filesize($invalidDbFile), 'sha256' => hash_file('sha256', $invalidDbFile)];
        $zip->addFile($invalidDbFile, 'db/data.sqlite');
        $zip->addFromString('manifest.json', json_encode($invalidManifest, JSON_THROW_ON_ERROR)); $zip->close();
        $invalidDestination = $root . '/reject-legacy-pc-' . $schema; mkdir($invalidDestination);
        rpc($currentWorker, ['command' => 'extract', 'archive' => $invalidArchive,
            'root' => $invalidDestination, 'max_bytes' => 10000000, 'max_files' => 100], false);
        $invalidRestored = new PDO('sqlite:' . $invalidDestination . '/db/data.sqlite');
        check((int)$invalidRestored->query('PRAGMA user_version')->fetchColumn() === $schema,
            'Invalid legacy PC source was migrated before rejection');
        $invalidRestored = null;
    }
    // A DB larger than the worker's PHP limit must restore without materializing its rows.
    $largeStage = $root . '/large-legacy';
    copyTree($stage, $largeStage);
    $largeDb = new PDO('sqlite:' . $largeStage . '/db/data.sqlite', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    $largeDb->beginTransaction();
    $largeNote = str_repeat('old-data-', 111) . 'x';
    $largeInsert = $largeDb->prepare('INSERT INTO canvas_notes (id,view_id,text) VALUES (?,1,?)');
    for ($id = 1; $id <= 32768; $id++) { $largeInsert->execute([$id, $largeNote]); }
    $largeDb->commit();
    $largeInsert = null;
    $largeDb = null;
    $largeArchive = $root . '/large-legacy.zip';
    rpc($legacy120Worker, ['command' => 'pack', 'root' => $largeStage, 'destination' => $largeArchive]);
    $largeSourceHash = hash_file('sha256', $largeStage . '/db/data.sqlite');
    $limitedDestination = $root . '/restored-limited-memory'; mkdir($limitedDestination);
    $limitedCode = 'define("NETARIUM_FULL_BACKUP_HELPER_NO_LOOP", true); require $argv[1] . "/scripts/full-backup-helper.php";'
        . '$manifest = fullExtract($argv[2], $argv[3], 64 * 1024 * 1024, 100);'
        . 'echo json_encode(["schema_version" => $manifest["schema_version"], "peak_bytes" => memory_get_peak_usage(true)], JSON_THROW_ON_ERROR);';
    $limitedProcess = proc_open([PHP_BINARY, '-d', 'memory_limit=24M', '-d', 'display_errors=stderr',
        '-r', $limitedCode, dirname(__DIR__), $largeArchive, $limitedDestination],
        [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $limitedPipes, null, $environment);
    check(is_resource($limitedProcess), 'Cannot launch memory-limited restore');
    fclose($limitedPipes[0]);
    $limitedOutput = stream_get_contents($limitedPipes[1]); fclose($limitedPipes[1]);
    $limitedError = stream_get_contents($limitedPipes[2]); fclose($limitedPipes[2]);
    $limitedExit = proc_close($limitedProcess);
    check($limitedExit === 0, 'Large legacy restore failed with 24 MiB: ' . $limitedOutput . $limitedError);
    $limitedResult = json_decode($limitedOutput, true, 512, JSON_THROW_ON_ERROR);
    $limitedDb = new PDO('sqlite:' . $limitedDestination . '/db/data.sqlite');
    check((int)$limitedDb->query('PRAGMA user_version')->fetchColumn() === 16 && $limitedResult['schema_version'] === 11,
        'Memory-limited restore did not preserve source metadata and migrate the staged DB');
    check((int)$limitedDb->query('SELECT COUNT(*) FROM canvas_notes')->fetchColumn() === 32768, 'Large restore lost note rows');
    $differentNotes = $limitedDb->prepare('SELECT COUNT(*) FROM canvas_notes WHERE text <> ?');
    $differentNotes->execute([$largeNote]);
    check((int)$differentNotes->fetchColumn() === 0, 'Large restore changed old note content');
    $differentNotes = null;
    $limitedDb = null;
    check(hash_file('sha256', $largeStage . '/db/data.sqlite') === $largeSourceHash, 'Large restore changed the source DB');
    check(hash_file('sha256', $dbFile) === $liveDbHash && hash_file('sha256', $dbFile . '-wal') === $liveWalHash,
        'Large restore changed the live DB');
    echo 'PASS bounded-memory legacy restore: 32768 notes, PHP limit 24 MiB, peak ' . $limitedResult['peak_bytes'] . " bytes\n";
    $failureApp = $root . '/app-migration-failure'; mkdir($failureApp); mkdir($failureApp . '/scripts');
    copy(dirname(__DIR__) . '/bootstrap.php', $failureApp . '/bootstrap.php');
    copy(dirname(__DIR__) . '/version.php', $failureApp . '/version.php');
    copyTree(dirname(__DIR__) . '/src', $failureApp . '/src');
    copy(dirname(__DIR__) . '/scripts/full-backup-helper.php', $failureApp . '/scripts/full-backup-helper.php');
    $failureSchema = $failureApp . '/src/Core/DatabaseSchema.php';
    file_put_contents($failureSchema, str_replace('migrateDatabaseToVersion12($db);',
        'migrateDatabaseToVersion12($db); throw new RuntimeException("Injected post-migration failure");',
        (string)file_get_contents($failureSchema)));
    $failurePipes = [];
    $failureProcess = proc_open([PHP_BINARY, $failureApp . '/scripts/full-backup-helper.php', $failureApp],
        [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['file', $root . '/stderr-migration-failure', 'a']], $failurePipes, null, $environment);
    check(is_resource($failureProcess), 'Cannot launch failing migration fixture');
    $failureWorker = [$failureProcess, $failurePipes]; $workers[] = $failureWorker;
    $failureDestination = $root . '/failed-migration'; mkdir($failureDestination);
    rpc($failureWorker, ['command' => 'extract', 'archive' => $legacy120Archive, 'root' => $failureDestination, 'max_bytes' => 10000000, 'max_files' => 100], false);
    $failureDb = new PDO('sqlite:' . $failureDestination . '/db/data.sqlite');
    check((int)$failureDb->query('PRAGMA user_version')->fetchColumn() === 12, 'Migration failure injection was not exercised');
    $failureDb = null;
    check(hash_file('sha256', $dbFile) === $liveDbHash && hash_file('sha256', $dbFile . '-wal') === $liveWalHash, 'Failed isolated migration touched live DB');
    $legacyArchiveHash = hash_file('sha256', $legacy120Archive);
    foreach (['content', 'deleted-row'] as $fault) {
        $mutationApp = $root . '/app-migration-' . $fault; mkdir($mutationApp); mkdir($mutationApp . '/scripts');
        copy(dirname(__DIR__) . '/bootstrap.php', $mutationApp . '/bootstrap.php');
        copy(dirname(__DIR__) . '/version.php', $mutationApp . '/version.php');
        copyTree(dirname(__DIR__) . '/src', $mutationApp . '/src');
        copy(dirname(__DIR__) . '/scripts/full-backup-helper.php', $mutationApp . '/scripts/full-backup-helper.php');
        $mutationSql = $fault === 'content' ? "UPDATE users SET password_hash='changed-by-migration'" : 'DELETE FROM users';
        $mutationSchema = $mutationApp . '/src/Core/DatabaseSchema.php';
        file_put_contents($mutationSchema, str_replace('migrateDatabaseToVersion12($db);',
            'migrateDatabaseToVersion12($db); $db->exec(' . var_export($mutationSql, true) . ');',
            (string)file_get_contents($mutationSchema)));
        $mutationProcess = proc_open([PHP_BINARY, $mutationApp . '/scripts/full-backup-helper.php', $mutationApp],
            [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['file', $root . '/stderr-migration-' . $fault, 'a']],
            $mutationPipes, null, $environment);
        check(is_resource($mutationProcess), 'Cannot launch data-changing migration fixture');
        $mutationWorker = [$mutationProcess, $mutationPipes]; $workers[] = $mutationWorker;
        $mutationDestination = $root . '/rejected-migration-' . $fault; mkdir($mutationDestination);
        rpc($mutationWorker, ['command' => 'extract', 'archive' => $legacy120Archive, 'root' => $mutationDestination,
            'max_bytes' => 10000000, 'max_files' => 100], false);
        $mutationDb = new PDO('sqlite:' . $mutationDestination . '/db/data.sqlite');
        check((int)$mutationDb->query('PRAGMA user_version')->fetchColumn() === 16,
            'Data-changing migration was not exercised');
        check($fault === 'content'
            ? $mutationDb->query('SELECT password_hash FROM users')->fetchColumn() === 'changed-by-migration'
            : (int)$mutationDb->query('SELECT COUNT(*) FROM users')->fetchColumn() === 0,
            'Expected old data mutation was not injected');
        $mutationDb = null;
    }
    check(hash_file('sha256', $legacy120Archive) === $legacyArchiveHash
        && hash_file('sha256', $dbFile) === $liveDbHash && hash_file('sha256', $dbFile . '-wal') === $liveWalHash,
        'Rejected data-changing migration modified source archive or live DB');
    foreach (['unknown-column', 'collision', 'depth-collision', 'invalid-depth', 'both-half', 'outside', 'xy-placement', 'xy-link', 'floor-plan'] as $fault) {
        $badDbFile = $root . '/rack-invalid-' . $fault . '.sqlite';
        copy($currentStage . '/db/data.sqlite', $badDbFile);
        $badDb = new PDO('sqlite:' . $badDbFile, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        if ($fault === 'unknown-column') { $badDb->exec('ALTER TABLE rack_mounts ADD COLUMN extra TEXT'); }
        if ($fault === 'collision') {
            $badDb->exec("INSERT INTO devices (id,name) VALUES (99,'collision')");
            $badDb->exec("INSERT INTO rack_mounts VALUES (99,90,'both',2,1,'full','half')");
        }
        if ($fault === 'depth-collision') {
            $badDb->exec("INSERT INTO devices (id,name) VALUES (99,'opposite depth collision')");
            $badDb->exec("INSERT INTO rack_mounts VALUES (99,90,'front',4,1,'left','half')");
        }
        if ($fault === 'invalid-depth') {
            $badDb->exec('PRAGMA ignore_check_constraints=ON');
            $badDb->exec("UPDATE rack_mounts SET depth='quarter'");
        }
        if ($fault === 'both-half') {
            $badDb->exec('PRAGMA ignore_check_constraints=ON');
            $badDb->exec("UPDATE rack_mounts SET face='both',width_slot='left'");
        }
        if ($fault === 'outside') { $badDb->exec('UPDATE rack_mounts SET start_u=42,height_u=3'); }
        if ($fault === 'xy-placement') { $badDb->exec('INSERT INTO device_placements (id,device_id,view_id,x,y) VALUES (9001,1,90,12,34)'); }
        if ($fault === 'xy-link') {
            $badDb->exec("INSERT INTO devices (id,name) VALUES (99,'link target')");
            $badDb->exec('INSERT INTO links (id,view_id,from_id,to_id) VALUES (9001,90,1,99)');
        }
        if ($fault === 'floor-plan') { $badDb->exec('UPDATE view_floor_plans SET view_id=90 WHERE view_id=1'); }
        $badCounts = [];
        foreach ($badDb->query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'") as $row) {
            $badCounts[$row['name']] = (int)$badDb->query('SELECT COUNT(*) FROM "' . $row['name'] . '"')->fetchColumn();
        }
        $badDb = null;
        $badArchive = $root . '/rack-invalid-' . $fault . '.zip'; copy($currentArchive, $badArchive);
        $zip = new ZipArchive(); check($zip->open($badArchive) === true, 'Cannot mutate rack archive');
        $badManifest = json_decode((string)$zip->getFromName('manifest.json'), true, 512, JSON_THROW_ON_ERROR);
        $badManifest['counts'] = $badCounts;
        $badManifest['total_bytes'] += filesize($badDbFile) - $badManifest['files']['db/data.sqlite']['bytes'];
        $badManifest['files']['db/data.sqlite'] = ['bytes' => filesize($badDbFile), 'sha256' => hash_file('sha256', $badDbFile)];
        $zip->addFile($badDbFile, 'db/data.sqlite');
        $zip->addFromString('manifest.json', json_encode($badManifest, JSON_THROW_ON_ERROR));
        $zip->close();
        $badDestination = $root . '/rack-invalid-dest-' . $fault; mkdir($badDestination);
        rpc($currentWorker, ['command' => 'extract', 'archive' => $badArchive, 'root' => $badDestination, 'max_bytes' => 10000000, 'max_files' => 100], false);
    }
    foreach (['1.0.0' => $archive, '1.0.1' => $archive101, '1.0.2' => $archive102, '1.0.3' => $archive103, '1.1.0' => $archive110, '1.2.0' => $legacy120Archive, $candidateVersion => $currentArchive] as $sourceVersion => $sourceArchive) {
        $destination = $root . '/restored-' . $sourceVersion . '-on-current'; mkdir($destination);
        $extracted = rpc($currentWorker, ['command' => 'extract', 'archive' => $sourceArchive, 'root' => $destination, 'max_bytes' => 10000000, 'max_files' => 100]);
        check($extracted['application_version'] === $sourceVersion, 'Source version changed on current restore');
        if ($sourceVersion === $candidateVersion) {
            check(hash_file('sha256', $destination . '/db/data.sqlite') === hash_file('sha256', $currentStage . '/db/data.sqlite'), 'Current database bytes changed on restore');
        }
        foreach ($imageFiles as $name => $bytes) {
            check(hash_file('sha256', $destination . '/' . $name) === hash('sha256', $bytes), 'Image changed on current restore');
        }
        $restoredDb = new PDO('sqlite:' . $destination . '/db/data.sqlite');
        check((int)$restoredDb->query('PRAGMA user_version')->fetchColumn() === 16, 'Old archive was not migrated to schema16');
        check($extracted['schema_version'] === ($sourceVersion === $candidateVersion ? 16 : 11), 'Source schema metadata changed');
        if ($sourceVersion === $candidateVersion) {
            check($restoredDb->query('SELECT * FROM rack_mounts')->fetchAll(PDO::FETCH_ASSOC) === $currentMounts, 'Rack physical fields lost');
            check($restoredDb->query('SELECT * FROM canvas_notes WHERE view_id=90 ORDER BY id')->fetchAll(PDO::FETCH_ASSOC) === $currentNotes, 'Rack note fields lost');
            check($restoredDb->query('SELECT type FROM devices WHERE id=1')->fetchColumn() === 'pc', 'PC type lost on full round trip');
            check($restoredDb->query('SELECT name FROM rack_shelves WHERE id=1')->fetchColumn() === 'Backup shelf', 'Shelf lost on full round trip');
            check($restoredDb->query('SELECT shelf_id FROM rack_shelf_devices WHERE device_id=2')->fetchColumn() === 1, 'Shelf membership lost on full round trip');
            check($restoredDb->query('SELECT * FROM floor_rack_placements')->fetchAll(PDO::FETCH_ASSOC) === $currentFloorRacks, 'Floor rack reference lost');
        } else {
            check((int)$restoredDb->query('SELECT COUNT(*) FROM rack_settings')->fetchColumn() === 0
                && (int)$restoredDb->query('SELECT COUNT(*) FROM rack_mounts')->fetchColumn() === 0, 'Old source invented rack data');
            $sourceDb = new PDO('sqlite:' . $stage . '/db/data.sqlite');
            foreach (array_keys($manifest['counts']) as $table) {
                $where = $table === 'resource_sequences' ? " WHERE name <> 'rack_shelves'" : '';
                check($restoredDb->query("SELECT * FROM \"$table\"$where ORDER BY rowid")->fetchAll(PDO::FETCH_ASSOC)
                    === $sourceDb->query("SELECT * FROM \"$table\" ORDER BY rowid")->fetchAll(PDO::FETCH_ASSOC), 'Migration changed source rows: ' . $table);
            }
            $sourceDb = null;
        }
        $restoredUser = $restoredDb->query("SELECT * FROM users WHERE username='full-admin'")->fetch(PDO::FETCH_ASSOC);
        check($restoredUser['role'] === 'admin' && password_verify('FullBackup-test-93!', $restoredUser['password_hash']), 'Credentials lost on current restore');
        $restoredDb = null;
    }
    // Representative same-schema minor and multi-digit patch ordering, not
    // a release cross-product. These are isolated current-code version fixtures.
    $numericWorkers = [];
    foreach (['1.2.9', '1.3.2', '1.3.10'] as $numericVersion) {
        $numericApp = $root . '/app-numeric-' . $numericVersion;
        copyTree($candidateApp, $numericApp);
        file_put_contents($numericApp . '/version.php', "<?php\ndeclare(strict_types=1);\nconst NETARIUM_VERSION = '$numericVersion';\n");
        $numericProcess = proc_open([PHP_BINARY, $numericApp . '/scripts/full-backup-helper.php', $numericApp],
            [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['file', $root . '/stderr-numeric-' . $numericVersion, 'a']],
            $numericPipes, null, $environment);
        check(is_resource($numericProcess), 'Cannot launch numeric version fixture: ' . $numericVersion);
        $numericWorkers[$numericVersion] = [$numericProcess, $numericPipes];
        $workers[] = $numericWorkers[$numericVersion];
    }
    foreach (['1.2.9' => [$currentWorker, '1.3.0'], '1.3.2' => [$numericWorkers['1.3.10'], '1.3.10']] as $sourceVersion => [$targetWorker, $targetVersion]) {
        $numericArchive = $root . '/numeric-' . $sourceVersion . '.zip';
        $numericManifest = rpc($numericWorkers[$sourceVersion], ['command' => 'pack', 'root' => $currentStage, 'destination' => $numericArchive]);
        check($numericManifest['application_version'] === $sourceVersion && $numericManifest['schema_version'] === 16,
            'Numeric source fixture did not pack its own version/schema');
        $numericDestination = $root . '/numeric-' . $sourceVersion . '-on-' . $targetVersion; mkdir($numericDestination);
        $numericExtracted = rpc($targetWorker, ['command' => 'extract', 'archive' => $numericArchive,
            'root' => $numericDestination, 'max_bytes' => 10000000, 'max_files' => 100]);
        check($numericExtracted === $numericManifest, 'Forward numeric restore changed source manifest');
        check(hash_file('sha256', $numericDestination . '/db/data.sqlite') === hash_file('sha256', $currentStage . '/db/data.sqlite'),
            'Forward numeric restore changed same-schema DB (including users/rack/shelf/floor data)');
        foreach ($imageFiles as $name => $bytes) {
            check(hash_file('sha256', $numericDestination . '/' . $name) === hash('sha256', $bytes),
                'Forward numeric restore changed image: ' . $name);
        }
    }
    foreach (['100' => $workers[0], '101' => $v101Worker, '102' => $worker102, '103' => $worker103, '110' => $worker110, '120' => $legacy120Worker] as $targetVersion => $oldWorker) {
        $reverseDestination = $root . '/reject-current-on-' . $targetVersion; mkdir($reverseDestination);
        rpc($oldWorker, ['command' => 'extract', 'archive' => $currentArchive, 'root' => $reverseDestination, 'max_bytes' => 10000000, 'max_files' => 100], false);
    }
    // Metadata mutations below are rejection fixtures, not historical release archives.
    foreach (['0.3.0', '1.3.1', '2.0.0', '1.3', '01.3.0', '1.03.0', '1.3.00', 'v1.3.0', '1.3.0-rc.1', '1.3.0+build.1', '', 'corrupt', 'schema', 'future-schema', 'format', 'format-name'] as $unsupportedVersion) {
        $badZip = $root . '/reject-current-' . $unsupportedVersion . '.zip'; copy($currentArchive, $badZip);
        if ($unsupportedVersion === 'corrupt') {
            file_put_contents($badZip, 'not a zip');
        } else {
            $zip = new ZipArchive(); check($zip->open($badZip) === true, 'Cannot open rejection ZIP');
            $m = json_decode((string)$zip->getFromName('manifest.json'), true, 512, JSON_THROW_ON_ERROR);
            if ($unsupportedVersion === 'schema') {
                $m['schema_version'] = 10;
            } elseif ($unsupportedVersion === 'future-schema') {
                $m['schema_version'] = 17;
            } elseif ($unsupportedVersion === 'format-name') {
                $m['format'] = 'netarium-config';
            } elseif ($unsupportedVersion === 'format') {
                $m['format_version'] = 2;
            } else {
                $m['application_version'] = $unsupportedVersion;
            }
            $zip->addFromString('manifest.json', json_encode($m, JSON_THROW_ON_ERROR)); $zip->close();
        }
        $destination = $root . '/reject-current-dest-' . $unsupportedVersion; mkdir($destination);
        rpc($currentWorker, ['command' => 'extract', 'archive' => $badZip, 'root' => $destination, 'max_bytes' => 10000000, 'max_files' => 100], false);
    }
    check(hash_file('sha256', $dbFile) === $liveDbHash && hash_file('sha256', $dbFile . '-wal') === $liveWalHash, 'Backup changed live DB/WAL bytes');
    foreach ($liveRows as $table => $rows) {
        check($db->query("SELECT * FROM $table")->fetchAll(PDO::FETCH_ASSOC) === $rows, 'Backup changed live rows: ' . $table);
    }
    foreach ($imageFiles as $name => $bytes) {
        check(hash_file('sha256', $storage . '/uploads/' . $name) === hash('sha256', $bytes), 'Backup changed live image');
    }
    $db = null;
    echo "PASS full backup: schema11/12/13/14/15 source verification and isolated schema16 migration, rack/depth/shelf/floor reference roundtrip, image/archive rejection, numeric patch/minor forward compatibility, reverse/invalid/major/schema/format rejection, WAL/live invariance, ZIP/manifest/reference SHA, users/login, lock contention; $assertions assertions\n";
} finally {
    if (isset($copy)) { $copy = null; } if (isset($db)) { $db = null; }
    unset($largeDb, $limitedDb, $largeInsert, $differentNotes, $mutationDb, $fingerprintDb);
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
