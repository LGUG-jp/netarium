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
    check(!str_contains($line, 'secret-marker'), 'Config body leaked in worker response');
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
function pinLegacyFixtureSchema(string $app, int $version = 11, ?string $appVersion = null): void
{
    // Pin an actual old migration chain, never just falsify archive metadata.
    $path = $app . '/src/Core/DatabaseSchema.php';
    $schema = (string)file_get_contents($path);
    file_put_contents($path, str_replace('const APP_DATABASE_SCHEMA_VERSION = ' . APP_DATABASE_SCHEMA_VERSION . ';',
        'const APP_DATABASE_SCHEMA_VERSION = ' . $version . ';', $schema));
    if ($appVersion !== null) {
        file_put_contents($app . '/version.php', "<?php\ndeclare(strict_types=1);\nconst NETARIUM_VERSION = '$appVersion';\n");
    }
}

function runFullBackupCli(string $app, array $arguments, array $environment): array
{
    $process = proc_open([PHP_BINARY, ...$arguments],
        [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, $app, $environment);
    check(is_resource($process), 'Cannot start full-backup smoke subprocess');
    fclose($pipes[0]);
    $stdout = stream_get_contents($pipes[1]);
    $stderr = stream_get_contents($pipes[2]);
    fclose($pipes[1]); fclose($pipes[2]);
    $exitCode = proc_close($process);
    check($exitCode === 0, "Full-backup smoke subprocess failed ($exitCode): $stdout$stderr");
    return json_decode($stdout, true, 512, JSON_THROW_ON_ERROR);
}

function smokePublicV152FullRestore(string $sourceApp, string $root, array $environment, string $png, string $password): void
{
    $sourceApp = realpath($sourceApp);
    check($sourceApp !== false, 'NETARIUM_BACKUP_V152_ROOT is not a readable release directory');
    $sourceStorage = $root . '/public-v152-source';
    $targetStorage = $root . '/public-v152-target';
    foreach ([$sourceStorage, $targetStorage] as $storage) {
        foreach (['db/csv-import', 'uploads/floorplans', 'uploads/device_images', 'temp/backup-export',
            'temp/backup-restore', 'backups/auto', 'logs', 'sessions'] as $directory) {
            mkdir($storage . '/' . $directory, 0700, true);
        }
    }
    $sourceDbFile = $sourceStorage . '/db/data.sqlite';
    $sourceEnv = array_replace($environment, ['NETARIUM_STORAGE_DIR' => $sourceStorage, 'NETARIUM_DB_FILE' => $sourceDbFile]);
    $initialized = runFullBackupCli($sourceApp, ['-r',
        'require "bootstrap.php"; $db = \Netarium\Core\Database::connect(APP_DB_FILE);'
        . ' echo json_encode([NETARIUM_VERSION, $db->query("PRAGMA user_version")->fetchColumn()], JSON_THROW_ON_ERROR);'], $sourceEnv);
    check($initialized === ['1.5.2', 23], 'Public full ZIP smoke must initialize a v1.5.2 schema23 DB');

    $source = new PDO('sqlite:' . $sourceDbFile, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    $source->exec(<<<'SQL'
        PRAGMA foreign_keys = ON;
        INSERT INTO devices (id,name,facility,floor) VALUES
            (10,'Public ZIP router',' Public building ',' 1F '),(11,'Public ZIP switch','',''),(12,'Unclassified','Unknown',' 2F ');
        INSERT INTO views (id,name,view_type,facility,floor) VALUES
            (20,'Public ZIP floor','floor',' Public building ',' 1F '),(21,'Public ZIP topology','topology','','');
        INSERT INTO device_placements (id,device_id,view_id,x,y) VALUES (30,10,20,24,36);
        INSERT INTO links (id,view_id,from_id,to_id,from_port,to_port,label,vlan,route_mode,manual_route) VALUES
            (41,20,10,11,'LAN 1','LAN 2','Public link',' Old VLAN ','manual','[{"x":1,"y":2},{"x":5,"y":2}]');
        INSERT INTO links (id,view_id,from_id,to_id) VALUES (51,21,11,12),(52,20,11,12);
        UPDATE resource_sequences SET value=200 WHERE name='links';
        INSERT INTO app_meta (meta_key,meta_value) VALUES ('setup_completed','1');
        SQL);
    $source->prepare("INSERT INTO users (username,password_hash,role,created_at,updated_at,auth_revision,password_revision,must_change_password)
        VALUES ('public-backup-admin',?,'admin','2026-01-01','2026-01-01',7,3,1)")->execute([$password]);
    $users = $source->query('SELECT * FROM users')->fetchAll(PDO::FETCH_ASSOC);
    $photo = str_repeat('a', 32) . '.png';
    $floorplan = str_repeat('b', 32) . '.png';
    $orphan = str_repeat('c', 32) . '.png';
    $source->prepare("INSERT INTO device_images (device_id,stored_name,mime_type,file_size,image_width,image_height,sort_order,created_at,updated_at)
        VALUES (10,?,'image/png',?,1,1,1,'2026-01-01','2026-01-01')")->execute([$photo, strlen($png)]);
    $source->prepare("INSERT INTO view_floor_plans (view_id,stored_name,original_name,mime_type,file_size,image_width,image_height,created_at,updated_at,rotation)
        VALUES (20,?,'fixture.png','image/png',?,1,1,'2026-01-01','2026-01-01',12.5)")->execute([$floorplan, strlen($png)]);
    $source = null;
    $imagePaths = ['device_images/' . $photo, 'floorplans/' . $floorplan, 'device_images/' . $orphan];
    foreach ($imagePaths as $path) { file_put_contents($sourceStorage . '/uploads/' . $path, $png); }

    $sourceHash = hash_file('sha256', $sourceDbFile);
    $archive = $root . '/public-v152.zip';
    $backup = runFullBackupCli($sourceApp, [$sourceApp . '/scripts/docker-backup-runner.php', '--output=' . $archive], $sourceEnv);
    $archiveHash = hash_file('sha256', $archive);
    check($backup['ok'] === true && $backup['file_count'] === 4 && $backup['sha256'] === $archiveHash,
        'Public v1.5.2 did not create the expected complete ZIP');

    $targetDbFile = $targetStorage . '/db/data.sqlite';
    $targetEnv = array_replace($environment, ['NETARIUM_STORAGE_DIR' => $targetStorage, 'NETARIUM_DB_FILE' => $targetDbFile]);
    file_put_contents($targetStorage . '/sessions/sess_public_smoke', 'existing target session');
    $candidate = dirname(__DIR__);
    $applied = runFullBackupCli($candidate, [$candidate . '/scripts/docker-restore-runner.php', '--apply', '--archive=' . $archive], $targetEnv);
    check($applied['restored'] === true && $applied['application_version'] === '1.5.2' && $applied['schema_version'] === 23,
        'Candidate did not directly apply the original v1.5.2 schema23 ZIP');
    check(scandir($targetStorage . '/sessions') === ['.', '..'], 'Public full ZIP restore did not invalidate target sessions');
    $restored = new PDO('sqlite:' . $targetDbFile, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    check($restored->query('PRAGMA user_version')->fetchColumn() === APP_DATABASE_SCHEMA_VERSION
        && $restored->query('PRAGMA integrity_check')->fetchAll(PDO::FETCH_COLUMN) === ['ok']
        && $restored->query('PRAGMA foreign_key_check')->fetch() === false, 'Public full ZIP DB did not migrate cleanly');
    check($restored->query('SELECT * FROM users')->fetchAll(PDO::FETCH_ASSOC) === $users
        && password_verify('FullBackup-test-93!', $users[0]['password_hash']), 'Public full ZIP changed credentials or auth revisions');
    check($restored->query("SELECT d.facility,d.floor,b.name,f.name FROM devices d JOIN floors f ON f.id=d.floor_id
        JOIN buildings b ON b.id=f.building_id JOIN views v ON v.floor_id=f.id WHERE d.id=10 AND v.id=20")->fetch(PDO::FETCH_NUM)
        === [' Public building ', ' 1F ', 'Public building', '1F']
        && $restored->query('SELECT floor_id FROM devices WHERE id=12')->fetchColumn() === null,
        'Public full ZIP changed original labels or migrated the hierarchy incorrectly');
    check($restored->query('SELECT device_id,view_id,x,y FROM device_placements WHERE id=30')->fetch(PDO::FETCH_NUM)
        === [10, 20, 24.0, 36.0], 'Public full ZIP lost device placement');
    check($restored->query('SELECT id,from_id,to_id,label FROM links')->fetchAll(PDO::FETCH_NUM) === [[41, 10, 11, 'Public link']]
        && $restored->query('SELECT name,vlan FROM device_ports ORDER BY device_id')->fetchAll(PDO::FETCH_NUM) === [['LAN 1', ''], ['LAN 2', '']]
        && $restored->query('SELECT link_id,vlan FROM legacy_link_vlans')->fetchAll(PDO::FETCH_NUM) === [[41, ' Old VLAN ']]
        && $restored->query('SELECT legacy_link_id,reason FROM legacy_link_conflicts ORDER BY legacy_link_id')->fetchAll(PDO::FETCH_NUM)
            === [[51, 'ambiguous_pair'], [52, 'ambiguous_pair']]
        && $restored->query("SELECT value FROM resource_sequences WHERE name='links'")->fetchColumn() === 200,
        'Public full ZIP lost converted or held link data, pending VLANs, or the link ID watermark');
    check($restored->query('SELECT view_id,device_a_id,device_b_id,manual_route FROM view_link_routes')->fetch(PDO::FETCH_NUM)
        === [20, 10, 11, '[{"x":1,"y":2},{"x":5,"y":2}]'], 'Public full ZIP lost manual route');
    $sha256 = hash('sha256', $png);
    check($restored->query('SELECT device_id,stored_name,sha256 FROM device_images')->fetch(PDO::FETCH_NUM) === [10, $photo, $sha256]
        && $restored->query('SELECT view_id,stored_name,sha256,rotation FROM view_floor_plans')->fetch(PDO::FETCH_NUM) === [20, $floorplan, $sha256, 12.5],
        'Public full ZIP lost image references, digests, or floor plan rotation');
    foreach ($imagePaths as $path) {
        check(hash_file('sha256', $targetStorage . '/uploads/' . $path) === $sha256, 'Public full ZIP changed image: ' . $path);
    }
    check(hash_file('sha256', $archive) === $archiveHash && hash_file('sha256', $sourceDbFile) === $sourceHash,
        'Public full ZIP smoke modified its source DB or ZIP');
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
    // Use the actual candidate files for current-schema output and all source-contract rejection checks.
    $candidateVersion = NETARIUM_VERSION;
    $candidateApp = $root . '/app-candidate'; mkdir($candidateApp); mkdir($candidateApp . '/scripts');
    copy(dirname(__DIR__) . '/bootstrap.php', $candidateApp . '/bootstrap.php');
    copy(dirname(__DIR__) . '/version.php', $candidateApp . '/version.php');
    copyTree(dirname(__DIR__) . '/src', $candidateApp . '/src');
    copy(dirname(__DIR__) . '/scripts/full-backup-helper.php', $candidateApp . '/scripts/full-backup-helper.php');
    $currentProcess = proc_open([PHP_BINARY, $candidateApp . '/scripts/full-backup-helper.php', $candidateApp],
        [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['file', $root . '/stderr-current', 'a']], $currentPipes, null, $environment);
    check(is_resource($currentProcess), 'Cannot launch current helper');
    $currentWorker = [$currentProcess, $currentPipes]; $workers[] = $currentWorker;
    foreach (['tamper', 'missing', 'extra', 'slip', 'schema', 'app',
        'unknown-manifest-key', 'unknown-file-key', 'corrupt', 'limit', 'count', 'integrity', 'empty-digest'] as $case) {
        $bad = $root . '/' . $case . '.zip'; copy($archive, $bad);
        $zip = new ZipArchive(); check($zip->open($bad) === true, 'Cannot mutate test ZIP');
        if ($case === 'tamper') { $zip->addFromString('device_images/orphan.png', str_repeat('x', 4096)); }
        if ($case === 'missing') { $zip->deleteName('db/data.sqlite'); }
        if ($case === 'extra') { $zip->addFromString('device_images/extra.png', 'x'); }
        if ($case === 'slip') { $zip->addFromString('../outside', 'x'); }
        $m = $manifest;
        if ($case === 'schema') { $m['schema_version']++; }
        if ($case === 'app') { $m['application_version'] = '0.invalid'; }
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
        if ($m !== $manifest) { $zip->addFromString('manifest.json', json_encode($m, JSON_THROW_ON_ERROR)); }
        $zip->close();
        if ($case === 'corrupt') { file_put_contents($bad, 'not a zip'); }
        $dest = $root . '/reject-' . $case; mkdir($dest);
        $before = hash_file('sha256', $dbFile);
        rpc($currentWorker, ['command' => 'extract', 'archive' => $bad, 'root' => $dest, 'max_bytes' => $case === 'limit' ? 1 : 10000000, 'max_files' => 100], false);
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
    $currentStage = $root . '/current-snapshot';
    copyTree($stage, $currentStage);
    $currentDb = new PDO('sqlite:' . $currentStage . '/db/data.sqlite', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    migrateDatabase($currentDb);
    check($currentDb->query('SELECT DISTINCT rotation FROM view_floor_plans')->fetchAll(PDO::FETCH_COLUMN) === [0.0],
        'Legacy floor plans did not receive zero rotation');
    $currentDb->exec('UPDATE view_floor_plans SET rotation=CASE view_id WHEN 1 THEN -0.1 ELSE 12.3 END');
    $currentRotations = $currentDb->query('SELECT view_id,rotation FROM view_floor_plans ORDER BY view_id')->fetchAll(PDO::FETCH_ASSOC);
    check($currentDb->query('SELECT * FROM buildings')->fetchAll() === []
        && $currentDb->query('SELECT * FROM floors')->fetchAll() === []
        && (int)$currentDb->query('SELECT COUNT(*) FROM views WHERE floor_id IS NOT NULL')->fetchColumn() === 0,
        'Legacy migration invented a building hierarchy');
    $currentDb->exec("INSERT INTO buildings(id,name,sort_order,building_view_enabled)
        VALUES(71,'Full building disabled',-999999,0),(72,'Full building enabled',0,1)");
    $currentDb->exec("INSERT INTO buildings(id,name) VALUES(73,'Full building default')");
    check($currentDb->query('SELECT building_view_enabled FROM buildings WHERE id=73')->fetchColumn() === 0,
        'A building inserted without a flag must be disabled');
    foreach (['2', '-1', '0.5', "'invalid'", 'NULL'] as $invalidFlag) {
        try {
            $currentDb->exec("UPDATE buildings SET building_view_enabled={$invalidFlag} WHERE id=73");
            check(false, 'Invalid SQLite building view flag accepted: ' . $invalidFlag);
        } catch (PDOException $error) {
            check(str_contains(strtolower($error->getMessage()), 'constraint'), 'Unexpected SQLite flag error');
        }
    }
    $currentDb->exec("INSERT INTO floors(id,building_id,name,sort_order,scale,offset_x,offset_y,rotation)
        VALUES(81,71,'Full floor',999999,0.125,-12.5,42.25,180)");
    $currentDb->exec('UPDATE views SET floor_id=81 WHERE id=1');
    $currentDb->exec('UPDATE devices SET floor_id=81 WHERE id=1');
    $currentDb->exec('UPDATE floors SET representative_view_id=1 WHERE id=81');
    $currentBuildings = $currentDb->query('SELECT * FROM buildings ORDER BY id')->fetchAll(PDO::FETCH_ASSOC);
    $currentFloors = $currentDb->query('SELECT * FROM floors ORDER BY id')->fetchAll(PDO::FETCH_ASSOC);
    $currentDb->exec("UPDATE devices SET type='pc' WHERE id=1");
    $currentDb->exec("INSERT INTO views (id,name,view_type) VALUES (90,'full-rack','rack')");
    $currentDb->exec("INSERT INTO rack_settings VALUES (90,42,'room')");
    $currentDb->exec("INSERT INTO rack_mounts VALUES (1,90,'rear',2,3,'left','full')");
    $currentDb->exec("INSERT INTO devices(id,name) VALUES (2,'shelf child')");
    $currentDb->exec("INSERT INTO rack_shelves VALUES (1,90,'Backup shelf','front',10,1,'full')");
    $currentDb->exec('INSERT INTO rack_shelf_devices VALUES (2,1,0)');
    $currentDb->exec("INSERT INTO views(id,name,view_type) VALUES (91,'Rack floor','floor')");
    $currentDb->exec('INSERT INTO floor_rack_placements VALUES (91,90,12.5,-20)');
    $currentDb->exec("UPDATE views SET show_connections = 0 WHERE id = 1");
    $currentDb->exec("INSERT INTO device_ports (id,device_id,name,memo,vlan) VALUES
        (7,1,'LAN 1','Port memo','access 10'),(12,2,'LAN 2','','trunk allowed 10,20 / native 99'),(13,2,'LAN 3','','isolated')");
    $currentDb->exec("INSERT INTO links (id,from_id,to_id,from_port_id,to_port_id,label) VALUES (40,1,2,7,12,'Common')");
    $currentDb->exec('INSERT INTO links (id,from_id,to_id) VALUES (41,1,2)');
    $currentDb->exec("INSERT INTO quality_not_applicable (device_id,link_id,field) VALUES
        (1,NULL,'maintenance_expiry'),(1,41,'from_port'),(2,41,'to_port')");
    $qualityRowsSql = 'SELECT device_id, link_id, field FROM quality_not_applicable ORDER BY device_id, link_id, field';
    $currentQualityNotApplicable = $currentDb->query($qualityRowsSql)->fetchAll(PDO::FETCH_ASSOC);
    $currentDb->exec("INSERT INTO view_link_routes VALUES (1,1,2,'[{\"x\":1,\"y\":2},{\"x\":5,\"y\":2}]')");
    $heldPayload = ['id' => 141, 'view_id' => 900, 'from_id' => 1, 'to_id' => 98, 'system_id' => null,
        'label' => 'Held', 'from_port' => 'LAN　1', 'to_port' => '', 'vlan' => '', 'memo' => 'Former device/view',
        'route_mode' => 'manual', 'manual_route' => [['x' => 1, 'y' => 2], ['x' => 5, 'y' => 6]]];
    $currentDb->prepare("INSERT INTO legacy_link_conflicts VALUES (141,900,1,98,'invalid_manual_route',?)")
        ->execute([json_encode($heldPayload, JSON_THROW_ON_ERROR)]);
    $currentDb->exec("INSERT INTO legacy_link_vlans (link_id,vlan) VALUES (40,' Old VLAN ')");
    check(array_column($currentDb->query('PRAGMA table_info(legacy_link_vlans)')->fetchAll(PDO::FETCH_ASSOC), 'name')
        === ['link_id', 'vlan'], 'Pending legacy VLAN table column contract changed');
    $pendingForeignKey = $currentDb->query('PRAGMA foreign_key_list(legacy_link_vlans)')->fetch(PDO::FETCH_ASSOC);
    check($pendingForeignKey !== false && $pendingForeignKey['table'] === 'links' && $pendingForeignKey['from'] === 'link_id'
        && $pendingForeignKey['to'] === 'id' && $pendingForeignKey['on_delete'] === 'CASCADE', 'Pending legacy VLAN must cascade with its link');
    $currentDb->exec("UPDATE resource_sequences SET value = 200 WHERE name IN ('links', 'device_ports')");
    $currentConnections = [];
    foreach (['links', 'device_ports', 'view_link_routes', 'legacy_link_conflicts', 'legacy_link_vlans'] as $table) {
        $currentConnections[$table] = $currentDb->query("SELECT * FROM $table ORDER BY rowid")->fetchAll(PDO::FETCH_ASSOC);
    }
    $connectionSequenceSql = "SELECT name, value FROM resource_sequences WHERE name IN ('devices', 'device_ports', 'links') ORDER BY name";
    $currentConnectionSequences = $currentDb->query($connectionSequenceSql)->fetchAll(PDO::FETCH_ASSOC);
    $currentFloorRacks = $currentDb->query('SELECT * FROM floor_rack_placements')->fetchAll(PDO::FETCH_ASSOC);
    $currentDb->exec("UPDATE devices SET ip='192.0.2.1' WHERE id=1");
    $currentDb->exec("INSERT INTO device_ip_addresses(id,device_id,ip,label,sort_order)
        VALUES (7,1,'198.51.100.1','service',1),(8,1,'203.0.113.1','backup',0),(9,2,'198.51.100.1','isolated',0)");
    $currentDb->exec("INSERT INTO address_spaces(id,name,memo,ping_reachability) VALUES(41,'本番','空間メモ','reachable'),(42,'隔離','','unreachable')");
    $currentDb->exec("INSERT INTO ip_segments(id,address_space_id,cidr,name,purpose,facility,vlan_id,memo)
        VALUES(51,41,'192.0.2.0/24','管理','管理用','本社',1,''),
        (52,41,'198.51.100.0/24','業務','','',4094,'メモ'),
        (53,42,'198.51.100.0/24','隔離','','',NULL,'')");
    $currentDb->exec('UPDATE devices SET ip_segment_id=51 WHERE id=1');
    $currentDb->exec('UPDATE device_ip_addresses SET segment_id=52 WHERE id IN (7,9)');
    $currentSpaces = $currentDb->query('SELECT * FROM address_spaces ORDER BY id')->fetchAll(PDO::FETCH_ASSOC);
    $currentSegments = $currentDb->query('SELECT * FROM ip_segments ORDER BY id')->fetchAll(PDO::FETCH_ASSOC);
    $currentAddresses = $currentDb->query('SELECT * FROM device_ip_addresses ORDER BY id')->fetchAll(PDO::FETCH_ASSOC);
    $currentDb->exec("INSERT INTO canvas_notes (id,view_id,text,x,y,width,height,background_color,background_opacity,text_color,font_size)
        VALUES (9001,90,' ラック注釈 <b>文字</b> ',12.5,22,360,180,'#FFF3B0',0.4,'#ABCDEF',24)");
    $currentNotes = $currentDb->query('SELECT * FROM canvas_notes WHERE view_id=90 ORDER BY id')->fetchAll(PDO::FETCH_ASSOC);
    $currentMounts = $currentDb->query('SELECT * FROM rack_mounts')->fetchAll(PDO::FETCH_ASSOC);
    $currentHistoryTime = gmdate('Y-m-d\TH:i:s\Z', time() - 3600);
    $currentHistoryJson = json_encode(['source' => 'save_resources', 'items' => [
        ['label' => '種別', 'before' => 'その他', 'after' => 'PC'],
        ['label' => '設置フロアID', 'before' => '12', 'after' => '15'],
        ['label' => '所属フロアID', 'before' => '12（旧本庁舎 / 1F）', 'after' => '15（旧別館 / 2F）'],
    ]], JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE);
    $currentDb->prepare("INSERT INTO change_history (id,event_id,request_id,occurred_at,actor_user_id,actor_name,target_type,target_id,target_name,operation,summary,changes_json)
        VALUES (31,31,'full-req-1',?,1,'full-admin','device',1,'backup-fixture','update','種別を変更',?)")->execute([$currentHistoryTime, $currentHistoryJson]);
    $currentHistory = $currentDb->query('SELECT * FROM change_history ORDER BY id')->fetchAll(PDO::FETCH_ASSOC);
    $currentDb->exec("INSERT INTO device_config_states(device_id,revision,next_generation) VALUES(1,12,19),(2,8,22)");
    $configInsert = $currentDb->prepare('INSERT INTO device_configs(id,device_id,generation,content,created_at,actor_user_id,actor_name,memo) VALUES(?,?,?,?,?,?,?,?)');
    $configInsert->execute([41, 1, 3, "hostname old\n", '2026-01-01T00:00:00Z', null, '削除済み登録者', '旧版']);
    $configInsert->execute([43, 1, 5, "hostname 日本語\nline 2\n", '2026-01-01T01:00:00Z', 1, 'full-admin', '日本語版']);
    $configInsert->execute([45, 1, 9, "hostname middle\n", '2026-01-01T02:00:00Z', 1, 'full-admin', '中間版']);
    $configInsert->execute([47, 1, 12, "hostname previous\n", '2026-01-02T00:00:00Z', 1, 'full-admin', '前版']);
    $configInsert->execute([49, 1, 17, "hostname kept\n", '2026-01-02T00:00:00Z', 1, 'full-admin', '保存版']);
    $configInsert = null;
    $currentConfigs = $currentDb->query('SELECT * FROM device_configs ORDER BY id')->fetchAll(PDO::FETCH_ASSOC);
    $currentConfigStates = $currentDb->query('SELECT * FROM device_config_states ORDER BY device_id')->fetchAll(PDO::FETCH_ASSOC);
    $currentDb = null;
    $currentArchive = $root . '/good-current.zip';
    $candidateManifest = rpc($currentWorker, ['command' => 'pack', 'root' => $currentStage, 'destination' => $currentArchive]);
    check($candidateManifest['counts']['legacy_link_vlans'] === 1, 'Current manifest omitted the pending legacy VLAN count');
    check($candidateManifest['counts']['quality_not_applicable'] === 3, 'Current manifest omitted the quality suppression count');
    foreach ([-180, -37, 0, 90, 180, 0.1, -0.1, 12.3, 12.3456789] as $index => $rotation) {
        $angleStage = $root . '/angle-stage-' . $index;
        copyTree($currentStage, $angleStage);
        $angleDb = new PDO('sqlite:' . $angleStage . '/db/data.sqlite', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        $angleDb->exec("UPDATE view_floor_plans SET rotation={$rotation}");
        $angleDb = null;
        $angleArchive = $root . '/angle-' . $index . '.zip';
        rpc($currentWorker, ['command' => 'pack', 'root' => $angleStage, 'destination' => $angleArchive]);
        $angleDestination = $root . '/angle-restored-' . $index; mkdir($angleDestination);
        rpc($currentWorker, ['command' => 'extract', 'archive' => $angleArchive,
            'root' => $angleDestination, 'max_bytes' => 10000000, 'max_files' => 100]);
        $angleDb = new PDO('sqlite:' . $angleDestination . '/db/data.sqlite');
        check($angleDb->query('SELECT DISTINCT rotation FROM view_floor_plans')->fetchAll(PDO::FETCH_COLUMN) === [(float)$rotation],
            'Fractional or integer rotation lost on full ZIP round trip');
        $angleDb = null;
    }
    check($candidateManifest['application_version'] === $candidateVersion && $candidateManifest['schema_version'] === APP_DATABASE_SCHEMA_VERSION,
        'Candidate helper must use the current schema');
    check((string)file_get_contents($root . '/stderr-current') === '',
        'Current-schema backup emitted PHP diagnostics');

    // Full output preserves expired rows; only a verified isolated restore is
    // pruned. Keep the no-expired archive above for byte-identical round trips.
    $retentionStage = $root . '/retention-snapshot';
    copyTree($currentStage, $retentionStage);
    $retentionDb = new PDO('sqlite:' . $retentionStage . '/db/data.sqlite', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    $retentionDb->prepare("INSERT INTO change_history (id,event_id,request_id,occurred_at,actor_user_id,actor_name,target_type,target_id,target_name,operation,summary,changes_json)
        VALUES (45,45,'full-expired',?,1,'full-admin','device',1,'backup-fixture','update','期限切れ変更',?)")
        ->execute([gmdate('Y-m-d\TH:i:s\Z', time() - 95 * 86400), $currentHistoryJson]);
    $retentionFingerprints = [];
    foreach ($retentionDb->query("SELECT name FROM sqlite_master WHERE type='table'") as $row) {
        $table = $row['name'];
        if ($table === 'change_history') { continue; }
        $columns = array_column($retentionDb->query('PRAGMA table_info("' . str_replace('"', '""', $table) . '")')->fetchAll(PDO::FETCH_ASSOC), 'name');
        $retentionFingerprints[$table] = ['columns' => $columns, 'fingerprint' => fullTableFingerprint($retentionDb, $table, $columns)];
    }
    $retentionDb = null;
    $retentionSourceHash = hash_file('sha256', $retentionStage . '/db/data.sqlite');
    $retentionPrepared = rpc($currentWorker, ['command' => 'prepare', 'root' => $retentionStage]);
    check($retentionPrepared['change_history'] === 2, 'Full preparation pruned source history');
    $retentionArchive = $root . '/retention.zip';
    $retentionManifest = rpc($currentWorker, ['command' => 'pack', 'root' => $retentionStage, 'destination' => $retentionArchive]);
    check($retentionManifest['counts']['change_history'] === 2, 'Full output omitted expired source history');
    check($retentionManifest['files']['db/data.sqlite']['sha256'] === $retentionSourceHash, 'Full output rewrote source DB');
    $retentionZip = new ZipArchive();
    check($retentionZip->open($retentionArchive) === true, 'Cannot inspect retention archive');
    check(hash('sha256', (string)$retentionZip->getFromName('db/data.sqlite')) === $retentionSourceHash, 'Archived DB does not match source');
    $retentionZip->close();
    $retentionArchiveHash = hash_file('sha256', $retentionArchive);
    $retentionDestination = $root . '/retention-restored'; mkdir($retentionDestination);
    $retentionExtracted = rpc($currentWorker, ['command' => 'extract', 'archive' => $retentionArchive,
        'root' => $retentionDestination, 'max_bytes' => 10000000, 'max_files' => 100]);
    check($retentionExtracted === $retentionManifest, 'Retention changed original manifest metadata');
    check(hash_file('sha256', $retentionArchive) === $retentionArchiveHash, 'Retention changed source archive');
    check(hash_file('sha256', $retentionStage . '/db/data.sqlite') === $retentionSourceHash, 'Retention changed source DB');
    $retentionDb = new PDO('sqlite:' . $retentionDestination . '/db/data.sqlite');
    check($retentionDb->query('SELECT * FROM change_history ORDER BY id')->fetchAll(PDO::FETCH_ASSOC) === $currentHistory,
        'Full restore must retain recent history and prune expired history');
    foreach ($retentionFingerprints as $table => $source) {
        check(fullTableFingerprint($retentionDb, $table, $source['columns']) === $source['fingerprint'],
            'Retention changed other restored data: ' . $table);
    }
    $retentionDb = null;
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
    check((int)$legacy120Db->query('PRAGMA user_version')->fetchColumn() === APP_DATABASE_SCHEMA_VERSION, 'Legacy1.2 was not migrated');
    $migratedUsers = $legacy120Db->query('SELECT * FROM users ORDER BY id')->fetchAll(PDO::FETCH_ASSOC);
    check(array_column($migratedUsers, 'deleted_at') === array_fill(0, count($migratedUsers), null), 'Legacy users must migrate as not deleted');
    check(array_map(static function (array $row): array { unset($row['deleted_at']); return $row; }, $migratedUsers) === $liveRows['users'],
        'Legacy restore changed users or password hashes');
    foreach ($imageFiles as $name => $bytes) {
        check(hash_file('sha256', $legacy120Destination . '/' . $name) === hash('sha256', $bytes),
            'Legacy restore changed image bytes');
    }
    $legacy120Db = null;
    // These current-code fixtures exercise the v1-to-v2 route for supported old schemas.
    // Untagged intermediate schemas model a migration step, not a public release.
    $schema12App = $root . '/app-schema12'; mkdir($schema12App); mkdir($schema12App . '/scripts');
    copy(dirname(__DIR__) . '/bootstrap.php', $schema12App . '/bootstrap.php');
    copyTree(dirname(__DIR__) . '/src', $schema12App . '/src');
    pinLegacyFixtureSchema($schema12App, 12, '1.3.0');
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
    check($schema12Source['schema_version'] === 12 && $schema12Source['application_version'] === '1.3.0', 'Schema12 source metadata changed');
    $schema12Restored = new PDO('sqlite:' . $schema12Destination . '/db/data.sqlite', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    check((int)$schema12Restored->query('PRAGMA user_version')->fetchColumn() === APP_DATABASE_SCHEMA_VERSION, 'Schema12 not migrated');
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
    copyTree(dirname(__DIR__) . '/src', $schema13App . '/src');
    pinLegacyFixtureSchema($schema13App, 13, '1.3.0');
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
    check($schema13Source['schema_version'] === 13 && $schema13Source['application_version'] === '1.3.0', 'Schema13 source metadata changed');
    $schema13Restored = new PDO('sqlite:' . $schema13Destination . '/db/data.sqlite');
    check((int)$schema13Restored->query('PRAGMA user_version')->fetchColumn() === APP_DATABASE_SCHEMA_VERSION, 'Schema13 not migrated');
    check($schema13Restored->query('SELECT * FROM rack_mounts')->fetchAll(PDO::FETCH_ASSOC)
        === array_map(static fn($row) => $row + ['depth' => 'half'], $schema13Before), 'Schema13 mount values changed');
    check($schema13Restored->query('SELECT type FROM devices WHERE id=1')->fetchColumn() === 'pc', 'Schema13 PC lost');
    $schema13Restored = null;
    $schema14App = $root . '/app-schema14'; mkdir($schema14App); mkdir($schema14App . '/scripts');
    copy(dirname(__DIR__) . '/bootstrap.php', $schema14App . '/bootstrap.php');
    copyTree(dirname(__DIR__) . '/src', $schema14App . '/src');
    pinLegacyFixtureSchema($schema14App, 14, '1.3.0');
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
    check($schema14Source['schema_version'] === 14 && $schema14Source['application_version'] === '1.3.0', 'Schema14 source metadata changed');
    $schema14Restored = new PDO('sqlite:' . $schema14Destination . '/db/data.sqlite');
    check((int)$schema14Restored->query('PRAGMA user_version')->fetchColumn() === APP_DATABASE_SCHEMA_VERSION, 'Schema14 not migrated');
    check($schema14Restored->query('SELECT * FROM rack_mounts')->fetchAll(PDO::FETCH_ASSOC) === $schema14Before, 'Schema14 depth lost');
    check((int)$schema14Restored->query('SELECT COUNT(*) FROM rack_shelves')->fetchColumn() === 0, 'Migration invented shelves');
    $schema14Restored = null;
    $schema15App = $root . '/app-schema15'; mkdir($schema15App); mkdir($schema15App . '/scripts');
    copy(dirname(__DIR__) . '/bootstrap.php', $schema15App . '/bootstrap.php');
    copyTree(dirname(__DIR__) . '/src', $schema15App . '/src');
    pinLegacyFixtureSchema($schema15App, 15, '1.3.0');
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
    check($schema15Source['schema_version'] === 15 && $schema15Source['application_version'] === '1.3.0', 'Schema15 source metadata changed');
    $schema15Restored = new PDO('sqlite:' . $schema15Destination . '/db/data.sqlite');
    check((int)$schema15Restored->query('PRAGMA user_version')->fetchColumn() === APP_DATABASE_SCHEMA_VERSION, 'Schema15 not migrated');
    check($schema15Restored->query('SELECT * FROM rack_shelves')->fetchAll(PDO::FETCH_ASSOC) === $schema15Shelves, 'Schema15 shelf lost');
    check((int)$schema15Restored->query('SELECT COUNT(*) FROM floor_rack_placements')->fetchColumn() === 0, 'Migration invented floor references');
    $schema15Restored = null;
    $schema16App = $root . '/app-schema16';
    copyTree($candidateApp, $schema16App);
    pinLegacyFixtureSchema($schema16App, 16, '1.3.0');
    $schema16Process = proc_open([PHP_BINARY, $schema16App . '/scripts/full-backup-helper.php', $schema16App],
        [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['file', $root . '/stderr-schema16', 'a']], $schema16Pipes, null, $environment);
    check(is_resource($schema16Process), 'Cannot launch schema16 helper');
    $schema16Worker = [$schema16Process, $schema16Pipes]; $workers[] = $schema16Worker;
    $schema16Stage = $root . '/schema16-stage';
    copyTree($stage, $schema16Stage);
    $schema16Db = new PDO('sqlite:' . $schema16Stage . '/db/data.sqlite');
    foreach (range(12, 16) as $version) { ('migrateDatabaseToVersion' . $version)($schema16Db); }
    $schema16Db->exec("UPDATE devices SET ip='192.0.2.16' WHERE id=1");
    $schema16Devices = $schema16Db->query('SELECT * FROM devices')->fetchAll(PDO::FETCH_ASSOC);
    $schema16Db = null;
    $schema16Archive = $root . '/schema16.zip';
    rpc($schema16Worker, ['command' => 'pack', 'root' => $schema16Stage, 'destination' => $schema16Archive]);
    $schema16Destination = $root . '/restored-schema16'; mkdir($schema16Destination);
    rpc($currentWorker, ['command' => 'extract', 'archive' => $schema16Archive,
        'root' => $schema16Destination, 'max_bytes' => 10000000, 'max_files' => 100]);
    $schema16Restored = new PDO('sqlite:' . $schema16Destination . '/db/data.sqlite');
    check((int)$schema16Restored->query('PRAGMA user_version')->fetchColumn() === APP_DATABASE_SCHEMA_VERSION, 'Schema16 not migrated');
    check($schema16Restored->query('SELECT * FROM devices')->fetchAll(PDO::FETCH_ASSOC)
        === array_map(static fn($row) => $row + ['ip_segment_id' => null, 'floor_id' => null], $schema16Devices), 'Schema16 management IP or device changed');
    check($schema16Restored->query('SELECT * FROM device_ip_addresses')->fetchAll(PDO::FETCH_ASSOC) === [], 'Schema16 migration invented additional IPs');
    $schema16Restored = null;
    $schema17App = $root . '/app-schema17';
    copyTree($candidateApp, $schema17App);
    pinLegacyFixtureSchema($schema17App, 17, '1.4.0');
    $schema17Process = proc_open([PHP_BINARY, $schema17App . '/scripts/full-backup-helper.php', $schema17App],
        [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['file', $root . '/stderr-schema17', 'a']], $schema17Pipes, null, $environment);
    check(is_resource($schema17Process), 'Cannot launch schema17 helper');
    $schema17Worker = [$schema17Process, $schema17Pipes]; $workers[] = $schema17Worker;
    $schema17Stage = $root . '/schema17-stage'; copyTree($schema16Stage, $schema17Stage);
    $schema17Db = new PDO('sqlite:' . $schema17Stage . '/db/data.sqlite');
    migrateDatabaseToVersion17($schema17Db);
    $schema17Db->exec("UPDATE devices SET ip='legacy invalid IP' WHERE id=1");
    $schema17Db->exec("INSERT INTO device_ip_addresses(id,device_id,ip,label,sort_order)
        VALUES(71,1,'198.51.100.71','旧用途',4)");
    $schema17Rows = $schema17Db->query('SELECT * FROM device_ip_addresses ORDER BY id')->fetchAll(PDO::FETCH_ASSOC);
    $schema17Db = null;
    $schema17Archive = $root . '/schema17.zip';
    rpc($schema17Worker, ['command' => 'pack', 'root' => $schema17Stage, 'destination' => $schema17Archive]);
    $schema17Destination = $root . '/restored-schema17'; mkdir($schema17Destination);
    rpc($currentWorker, ['command' => 'extract', 'archive' => $schema17Archive,
        'root' => $schema17Destination, 'max_bytes' => 10000000, 'max_files' => 100]);
    $schema17Restored = new PDO('sqlite:' . $schema17Destination . '/db/data.sqlite');
    check((int)$schema17Restored->query('PRAGMA user_version')->fetchColumn() === APP_DATABASE_SCHEMA_VERSION, 'Schema17 not migrated');
    check($schema17Restored->query('SELECT * FROM device_ip_addresses ORDER BY id')->fetchAll(PDO::FETCH_ASSOC)
        === array_map(static fn($row) => $row + ['segment_id' => null], $schema17Rows), 'Schema17 IDs or additional data changed');
    check($schema17Restored->query('SELECT ip_segment_id FROM devices')->fetchColumn() === null, 'Legacy membership not null');
    check($schema17Restored->query('SELECT * FROM address_spaces')->fetchAll() === []
        && $schema17Restored->query('SELECT * FROM ip_segments')->fetchAll() === [], 'Legacy migration invented IP masters');
    $schema17Restored = null;
    $schema18App = $root . '/app-schema18';
    copyTree($candidateApp, $schema18App);
    pinLegacyFixtureSchema($schema18App, 18, '1.4.0');
    $schema18Process = proc_open([PHP_BINARY, $schema18App . '/scripts/full-backup-helper.php', $schema18App],
        [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['file', $root . '/stderr-schema18', 'a']], $schema18Pipes, null, $environment);
    check(is_resource($schema18Process), 'Cannot launch schema18 helper');
    $schema18Worker = [$schema18Process, $schema18Pipes]; $workers[] = $schema18Worker;
    $schema18Stage = $root . '/schema18-stage'; copyTree($schema17Stage, $schema18Stage);
    $schema18Db = new PDO('sqlite:' . $schema18Stage . '/db/data.sqlite', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    migrateDatabaseToVersion18($schema18Db);
    $schema18Db->exec("UPDATE devices SET ip='198.51.100.10' WHERE id=1");
    $schema18Db = null;
    $schema18Archive = $root . '/schema18.zip';
    rpc($schema18Worker, ['command' => 'pack', 'root' => $schema18Stage, 'destination' => $schema18Archive]);
    $schema18Destination = $root . '/restored-schema18'; mkdir($schema18Destination);
    rpc($currentWorker, ['command' => 'extract', 'archive' => $schema18Archive,
        'root' => $schema18Destination, 'max_bytes' => 10000000, 'max_files' => 100]);
    $schema18Restored = new PDO('sqlite:' . $schema18Destination . '/db/data.sqlite');
    check((int)$schema18Restored->query('PRAGMA user_version')->fetchColumn() === APP_DATABASE_SCHEMA_VERSION, 'Schema18 not migrated');
    check($schema18Restored->query('SELECT * FROM change_history')->fetchAll(PDO::FETCH_ASSOC) === [], 'Schema18 migration invented change_history');
    $schema18Restored = null;
    $schema19App = $root . '/app-schema19';
    copyTree($candidateApp, $schema19App);
    pinLegacyFixtureSchema($schema19App, 19, '1.4.0');
    $schema19Process = proc_open([PHP_BINARY, $schema19App . '/scripts/full-backup-helper.php', $schema19App],
        [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['file', $root . '/stderr-schema19', 'a']], $schema19Pipes, null, $environment);
    check(is_resource($schema19Process), 'Cannot launch schema19 helper');
    $schema19Worker = [$schema19Process, $schema19Pipes]; $workers[] = $schema19Worker;
    $schema19Stage = $root . '/schema19-stage'; copyTree($schema18Stage, $schema19Stage);
    $schema19Db = new PDO('sqlite:' . $schema19Stage . '/db/data.sqlite', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    migrateDatabaseToVersion19($schema19Db);
    $schema19Db = null;
    $schema19Archive = $root . '/schema19.zip';
    rpc($schema19Worker, ['command' => 'pack', 'root' => $schema19Stage, 'destination' => $schema19Archive]);
    $schema20App = $root . '/app-schema20';
    copyTree($candidateApp, $schema20App);
    pinLegacyFixtureSchema($schema20App, 20, '1.4.0');
    $schema20Process = proc_open([PHP_BINARY, $schema20App . '/scripts/full-backup-helper.php', $schema20App],
        [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['file', $root . '/stderr-schema20', 'a']], $schema20Pipes, null, $environment);
    check(is_resource($schema20Process), 'Cannot launch schema20 helper');
    $schema20Worker = [$schema20Process, $schema20Pipes]; $workers[] = $schema20Worker;
    $schema20Stage = $root . '/schema20-stage'; copyTree($schema19Stage, $schema20Stage);
    $schema20Db = new PDO('sqlite:' . $schema20Stage . '/db/data.sqlite', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    migrateDatabaseToVersion20($schema20Db);
    $schema20Db->exec("INSERT INTO address_spaces(id,name,memo) VALUES(41,'旧区分','保存')");
    $schema20Db = null;
    $schema20Archive = $root . '/schema20.zip';
    rpc($schema20Worker, ['command' => 'pack', 'root' => $schema20Stage, 'destination' => $schema20Archive]);
    $schema20Destination = $root . '/restored-schema20'; mkdir($schema20Destination);
    rpc($currentWorker, ['command' => 'extract', 'archive' => $schema20Archive,
        'root' => $schema20Destination, 'max_bytes' => 10000000, 'max_files' => 100]);
    $schema20Db = new PDO('sqlite:' . $schema20Destination . '/db/data.sqlite');
    check($schema20Db->query('SELECT ping_reachability FROM address_spaces')->fetchColumn() === 'unset', 'Schema20 reachability must default to unset');
    check($schema20Db->query('SELECT memo FROM address_spaces')->fetchColumn() === '保存', 'Schema20 migration changed existing space data');
    $schema20Db = null;
    foreach (range(21, 28) as $legacySchema) {
        $legacyApp = $root . '/app-schema' . $legacySchema;
        copyTree($candidateApp, $legacyApp);
        // Schemas 24–28 were never released in v1; their fixtures stay within the candidate MAJOR.
        $legacyVersion = match (true) {
            $legacySchema <= 22 => '1.4.0',
            $legacySchema === 23 => '1.5.2',
            default => $candidateVersion,
        };
        pinLegacyFixtureSchema($legacyApp, $legacySchema, $legacySchema <= 23 ? $legacyVersion : null);
        $legacyProcess = proc_open([PHP_BINARY, $legacyApp . '/scripts/full-backup-helper.php', $legacyApp],
            [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['file', $root . '/stderr-schema' . $legacySchema, 'a']], $legacyPipes, null, $environment);
        check(is_resource($legacyProcess), 'Cannot launch legacy schema helper');
        $legacyWorker = [$legacyProcess, $legacyPipes]; $workers[] = $legacyWorker;
        $legacyStage = $root . '/schema' . $legacySchema . '-stage';
        copyTree($schema20Stage, $legacyStage);
        $legacyDatabase = new PDO('sqlite:' . $legacyStage . '/db/data.sqlite', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        for ($v = 21; $v <= $legacySchema; $v++) { ('migrateDatabaseToVersion' . $v)($legacyDatabase); }
        $legacyDatabase->exec("UPDATE views SET facility=' Legacy building ', floor=' B1 '");
        $legacyDatabase->exec("UPDATE devices SET facility=' Legacy building ', floor=' B1 '");
        $legacyDatabase->exec("INSERT INTO devices(name,facility,floor,x,y) VALUES
            ('Device-only location',' Device only ',' 1F ',12,34),
            ('Unmatched existing floor',' Legacy building ',' 2F ',56,78),
            ('Partial device location',' Device building only ','',90,12)");
        $legacyPlacements = $legacyDatabase->query('SELECT * FROM device_placements ORDER BY id')->fetchAll(PDO::FETCH_ASSOC);
        if ($legacySchema >= 24) {
            $legacyDatabase->exec("INSERT INTO buildings(id,name,sort_order) VALUES(71,'Existing hierarchy',-7)");
            $legacyDatabase->exec("INSERT INTO floors(id,building_id,name,sort_order,scale,offset_x,offset_y,rotation)
                VALUES(81,71,'Explicit floor',8,0.5,-12,34,90)");
            $legacyDatabase->exec('UPDATE views SET floor_id=81 WHERE id=1');
            $legacyDatabase->exec('UPDATE floors SET representative_view_id=1 WHERE id=81');
        }
        if ($legacySchema >= 25) {
            // A deliberately unassigned view still has legacy labels matching the explicit view.
            $legacyDatabase->exec('UPDATE devices SET floor_id=81 WHERE id=1');
        }
        if ($legacySchema === 26) {
            $sourceVlan = " \tOld VLAN\f ";
            $legacyDatabase->exec("INSERT INTO links (id,view_id,from_id,to_id,from_port,to_port,label,route_mode,manual_route) VALUES
                (41,1,2,1,'ＬＡＮ２','LAN　1','merge','manual','[{\"x\":5,\"y\":2},{\"x\":1,\"y\":2}]'),
                (42,2,1,2,'LAN 1','LAN2','merge','auto','[]'),
                (51,1,3,4,'','','hold','auto','[]'),
                (52,2,3,4,'','','hold','auto','[]'),
                (53,1,2,4,'free','free','bad route','manual','[{\"x\":1,\"y\":2},{\"x\":5,\"y\":6}]')");
            $legacyDatabase->prepare('UPDATE links SET vlan=? WHERE id IN (41,42)')->execute([$sourceVlan]);
            $legacyDatabase->exec("UPDATE links SET vlan='Held VLAN' WHERE id IN (51,52,53)");
            $legacyDatabase->exec("UPDATE resource_sequences SET value=200 WHERE name='links'");
            $heldRows = $legacyDatabase->query('SELECT * FROM links WHERE id IN (51,52,53) ORDER BY id')->fetchAll(PDO::FETCH_ASSOC);
            foreach ($heldRows as &$held) { $held['manual_route'] = json_decode($held['manual_route'], true, 512, JSON_THROW_ON_ERROR); }
            unset($held);
        } elseif ($legacySchema === 27) {
            $sourceVlan = " \t" . str_repeat('𠀀', 96) . "\n\f";
            $legacyDatabase->exec("INSERT INTO device_ports (id,device_id,name) VALUES (7,1,'LAN 1'),(12,2,'LAN 2')");
            $insertOldLink = $legacyDatabase->prepare('INSERT INTO links (id,from_id,to_id,from_port_id,to_port_id,vlan)
                VALUES (?,?,?,?,?,?)');
            $insertOldLink->execute([41, 1, 2, null, null, $sourceVlan]);
            $insertOldLink->execute([42, 1, 2, 7, 12, " \t\n\v\f\r "]);
            $insertOldLink->execute([43, 1, 3, null, null, '　']);
            $insertOldLink = null;
        } elseif ($legacySchema === 28) {
            $legacyDatabase->exec("INSERT INTO device_ports (id,device_id,name,vlan) VALUES (7,1,'LAN 1','access 10');
                INSERT INTO links (id,from_id,to_id,from_port_id) VALUES (41,1,2,7);
                INSERT INTO legacy_link_vlans (link_id,vlan) VALUES (41,' Old VLAN ')");
        }
        $legacyDatabase = null;
        $legacyArchive = $root . '/schema' . $legacySchema . '.zip';
        $legacyManifest = rpc($legacyWorker, ['command' => 'pack', 'root' => $legacyStage, 'destination' => $legacyArchive]);
        check($legacyManifest['schema_version'] === $legacySchema && $legacyManifest['application_version'] === $legacyVersion,
            'Legacy helper used the wrong source schema or version');
        check(!array_key_exists('quality_not_applicable', $legacyManifest['counts']), 'Legacy backup contains a future table');
        $legacyArchiveHash = hash_file('sha256', $legacyArchive);
        $legacyDestination = $root . '/restored-schema' . $legacySchema; mkdir($legacyDestination);
        $extractedManifest = rpc($currentWorker, ['command' => 'extract', 'archive' => $legacyArchive,
            'root' => $legacyDestination, 'max_bytes' => 10000000, 'max_files' => 100]);
        check($extractedManifest === $legacyManifest && hash_file('sha256', $legacyArchive) === $legacyArchiveHash,
            'Full restore changed the legacy source metadata or archive');
        $legacyDatabase = new PDO('sqlite:' . $legacyDestination . '/db/data.sqlite');
        check((int)$legacyDatabase->query('PRAGMA user_version')->fetchColumn() === APP_DATABASE_SCHEMA_VERSION,
            'Legacy archive was not migrated to the current schema');
        check($legacyDatabase->query($qualityRowsSql)->fetchAll(PDO::FETCH_ASSOC) === [],
            'Legacy migration invented quality suppressions');
        check($legacyDatabase->query('SELECT building_view_enabled FROM buildings ORDER BY id')->fetchAll(PDO::FETCH_COLUMN) === [$legacySchema >= 26 ? 0 : 1],
            'Legacy building visibility was not defaulted or preserved as appropriate');
        check($legacyDatabase->query('SELECT DISTINCT rotation FROM view_floor_plans')->fetchAll(PDO::FETCH_COLUMN) === [0.0],
            'Legacy schema rotation did not migrate to zero');
        check((int)$legacyDatabase->query('SELECT COUNT(*) FROM buildings')->fetchColumn() === 1
            && (int)$legacyDatabase->query('SELECT COUNT(*) FROM floors')->fetchColumn() === 1
            && (int)$legacyDatabase->query('SELECT COUNT(*) FROM devices WHERE floor_id IS NOT NULL')->fetchColumn() > 0,
            'Legacy schema did not migrate safe legacy locations');
        check($legacyDatabase->query('SELECT facility FROM devices WHERE id=1')->fetchColumn() === ' Legacy building ',
            'Legacy migration changed original text');
        $unclassifiedDevices = $legacyDatabase->query("SELECT name,facility,floor,floor_id,x,y FROM devices
            WHERE name IN ('Device-only location','Unmatched existing floor','Partial device location') ORDER BY name")->fetchAll(PDO::FETCH_ASSOC);
        check(count($unclassifiedDevices) === 3
            && array_column($unclassifiedDevices, 'floor_id') === [null, null, null],
            'Device-only, unmatched or partial locations must not create hierarchy or assign a floor');
        check(array_column($unclassifiedDevices, 'facility') === [' Device only ', ' Device building only ', ' Legacy building ']
            && array_column($unclassifiedDevices, 'floor') === [' 1F ', '', ' 2F ']
            && array_map('floatval', array_column($unclassifiedDevices, 'x')) === [12.0, 90.0, 56.0]
            && array_map('floatval', array_column($unclassifiedDevices, 'y')) === [34.0, 12.0, 78.0],
            'Legacy restore changed unclassified raw locations or device coordinates');
        check($legacyPlacements === $legacyDatabase->query('SELECT * FROM device_placements ORDER BY id')->fetchAll(PDO::FETCH_ASSOC),
            'Legacy restore changed placement references or coordinates');
        check($legacyDatabase->query('SELECT DISTINCT show_connections FROM views')->fetchAll(PDO::FETCH_COLUMN) === [1],
            'Migrated views must show connections by default');
        if ($legacySchema === 26) {
            check($legacyDatabase->query('SELECT id FROM links')->fetchAll(PDO::FETCH_COLUMN) === [41],
                'Equivalent old rows did not retain their smallest connection ID');
            check($legacyDatabase->query('SELECT name FROM device_ports ORDER BY name')->fetchAll(PDO::FETCH_COLUMN) === ['LAN 1', 'LAN2'],
                'Converted connection ports were not normalized');
            check($legacyDatabase->query('SELECT * FROM legacy_link_vlans')->fetchAll(PDO::FETCH_ASSOC)
                === [['link_id' => 41, 'vlan' => $sourceVlan]], 'Schema26 restore lost the converted VLAN or included a held link');
            check($legacyDatabase->query('SELECT DISTINCT vlan FROM device_ports')->fetchAll(PDO::FETCH_COLUMN) === [''],
                'Schema26 restore copied old VLAN onto ports');
            $routes = $legacyDatabase->query('SELECT * FROM view_link_routes')->fetchAll(PDO::FETCH_ASSOC);
            check($routes === [['view_id' => 1, 'device_a_id' => 1, 'device_b_id' => 2,
                'manual_route' => '[{"x":1,"y":2},{"x":5,"y":2}]']], 'Reversed route was not oriented by ascending device ID');
            $conflicts = $legacyDatabase->query('SELECT legacy_link_id,reason,payload FROM legacy_link_conflicts ORDER BY legacy_link_id')->fetchAll(PDO::FETCH_ASSOC);
            check(array_column($conflicts, 'legacy_link_id') === [51, 52, 53]
                && array_column($conflicts, 'reason') === ['ambiguous_pair', 'ambiguous_pair', 'invalid_manual_route'],
                'Ambiguous or invalid routes did not remain quarantined');
            check(array_map(static fn(string $payload): array => json_decode($payload, true, 512, JSON_THROW_ON_ERROR),
                array_column($conflicts, 'payload')) === $heldRows, 'Quarantined links lost source data');
            check($legacyDatabase->query("SELECT value FROM resource_sequences WHERE name='links'")->fetchColumn() === 200,
                'Legacy full restore reused deleted link IDs');
        } elseif ($legacySchema === 27) {
            check($legacyDatabase->query('SELECT link_id,vlan FROM legacy_link_vlans ORDER BY link_id')->fetchAll(PDO::FETCH_KEY_PAIR)
                === [41 => $sourceVlan, 43 => '　'], 'Schema27 restore changed raw VLANs or incorrectly treated a value as empty');
            check($legacyDatabase->query('SELECT DISTINCT vlan FROM device_ports')->fetchAll(PDO::FETCH_COLUMN) === [''],
                'Schema27 restore copied old VLAN onto ports');
        } elseif ($legacySchema === 28) {
            check($legacyDatabase->query('SELECT id,from_id,to_id,from_port_id,to_port_id FROM links')->fetch(PDO::FETCH_ASSOC)
                === ['id' => 41, 'from_id' => 1, 'to_id' => 2, 'from_port_id' => 7, 'to_port_id' => null],
                'Schema28 migration changed the shared connection');
            check($legacyDatabase->query('SELECT vlan FROM device_ports WHERE id=7')->fetchColumn() === 'access 10'
                && $legacyDatabase->query('SELECT vlan FROM legacy_link_vlans WHERE link_id=41')->fetchColumn() === ' Old VLAN ',
                'Schema28 migration changed current or pending VLANs');
        } else {
            check((int)$legacyDatabase->query('SELECT COUNT(*) FROM links')->fetchColumn() === 0,
                'Migration invented links for an empty source');
            check((int)$legacyDatabase->query('SELECT COUNT(*) FROM legacy_link_vlans')->fetchColumn() === 0,
                'Migration invented pending legacy VLANs for an empty source');
        }
        if ($legacySchema >= 24) {
            check($legacyDatabase->query('SELECT floor_id FROM devices WHERE id=1')->fetchColumn() === 81,
                'Explicit legacy hierarchy did not preserve or resolve the device floor');
            $preservedFloor = $legacyDatabase->query('SELECT * FROM floors WHERE id=81')->fetch(PDO::FETCH_ASSOC);
            check($preservedFloor['scale'] === 0.5 && $preservedFloor['offset_x'] === -12.0
                && $preservedFloor['rotation'] === 90.0 && $preservedFloor['representative_view_id'] === 1,
                'Migration changed explicit hierarchy transforms or representative');
        }
        if ($legacySchema >= 25) {
            check($legacyDatabase->query('SELECT floor_id FROM views WHERE id=2')->fetchColumn() === null,
                'Schema25 restore reclassified a deliberately unassigned view');
        }
        $legacyDatabase = null;
        $reverseDestination = $root . '/reject-current-on-' . $legacySchema; mkdir($reverseDestination);
        rpc($legacyWorker, ['command' => 'extract', 'archive' => $currentArchive,
            'root' => $reverseDestination, 'max_bytes' => 10000000, 'max_files' => 100], false);
        $mixedDbFile = $root . '/legacy-mixed-schema-' . $legacySchema . '.sqlite';
        copy($legacyStage . '/db/data.sqlite', $mixedDbFile);
        $mixedDb = new PDO('sqlite:' . $mixedDbFile);
        if ($legacySchema === 25) {
            migrateDatabaseToVersion26($mixedDb);
            $mixedDb->exec('PRAGMA user_version = 25');
        } elseif ($legacySchema === 26) {
            migrateDatabaseToVersion27($mixedDb);
            $mixedDb->exec('PRAGMA user_version = 26');
        } elseif ($legacySchema === 27) {
            migrateDatabaseToVersion28($mixedDb);
            $mixedDb->exec('PRAGMA user_version = 27');
        } elseif ($legacySchema === 28) {
            migrateDatabaseToVersion29($mixedDb);
            $mixedDb->exec('PRAGMA user_version = 28');
        } else {
            $mixedDb->exec($legacySchema < 23
                ? 'ALTER TABLE view_floor_plans ADD COLUMN rotation INTEGER NOT NULL DEFAULT 0'
                : ($legacySchema < 24 ? 'ALTER TABLE views ADD COLUMN floor_id INTEGER'
                    : 'ALTER TABLE devices ADD COLUMN floor_id INTEGER'));
        }
        $mixedDb = null;
        $mixedArchive = $root . '/legacy-mixed-schema-' . $legacySchema . '.zip';
        copy($legacyArchive, $mixedArchive);
        $zip = new ZipArchive(); check($zip->open($mixedArchive) === true, 'Cannot mutate legacy schema ZIP');
        $mixedManifest = json_decode((string)$zip->getFromName('manifest.json'), true, 512, JSON_THROW_ON_ERROR);
        $mixedManifest['total_bytes'] += filesize($mixedDbFile) - $mixedManifest['files']['db/data.sqlite']['bytes'];
        $mixedManifest['files']['db/data.sqlite'] = ['bytes' => filesize($mixedDbFile), 'sha256' => hash_file('sha256', $mixedDbFile)];
        $zip->addFile($mixedDbFile, 'db/data.sqlite');
        $zip->addFromString('manifest.json', json_encode($mixedManifest, JSON_THROW_ON_ERROR)); $zip->close();
        $mixedDestination = $root . '/reject-legacy-mixed-schema-' . $legacySchema; mkdir($mixedDestination);
        rpc($currentWorker, ['command' => 'extract', 'archive' => $mixedArchive,
            'root' => $mixedDestination, 'max_bytes' => 10000000, 'max_files' => 100], false);
        $mixedDb = new PDO('sqlite:' . $mixedDestination . '/db/data.sqlite');
        check((int)$mixedDb->query('PRAGMA user_version')->fetchColumn() === $legacySchema,
            'Mixed-schema source was migrated before source-contract rejection');
        $mixedDb = null;
    }

    // Full restore must retain the declaration but discard stale OK/latency
    // only for the intentionally excluded management IP.
    $reachabilityStage = $root . '/reachability-stage'; copyTree($currentStage, $reachabilityStage);
    $reachabilityDb = new PDO('sqlite:' . $reachabilityStage . '/db/data.sqlite', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    $reachabilityDb->exec("INSERT INTO ip_segments(id,address_space_id,cidr) VALUES(54,42,'192.0.2.0/24')");
    $reachabilityDb->exec("UPDATE devices SET ip='192.0.2.1',ip_segment_id=54 WHERE id=2");
    $reachabilityDb->exec("INSERT OR REPLACE INTO device_monitor_status(device_id,status,last_response_ms) VALUES(1,'green',8),(2,'green',9)");
    $reachableBefore = $reachabilityDb->query('SELECT * FROM device_monitor_status WHERE device_id=1')->fetch(PDO::FETCH_ASSOC);
    $reachabilityDb = null;
    $reachabilityArchive = $root . '/reachability.zip';
    rpc($currentWorker, ['command' => 'pack', 'root' => $reachabilityStage, 'destination' => $reachabilityArchive]);
    $reachabilityDestination = $root . '/reachability-restored'; mkdir($reachabilityDestination);
    rpc($currentWorker, ['command' => 'extract', 'archive' => $reachabilityArchive,
        'root' => $reachabilityDestination, 'max_bytes' => 10000000, 'max_files' => 100]);
    $reachabilityDb = new PDO('sqlite:' . $reachabilityDestination . '/db/data.sqlite');
    check($reachabilityDb->query('SELECT * FROM device_monitor_status WHERE device_id=1')->fetch(PDO::FETCH_ASSOC) === $reachableBefore, 'Restore changed permitted target monitor');
    $excluded = $reachabilityDb->query('SELECT * FROM device_monitor_status WHERE device_id=2')->fetch(PDO::FETCH_ASSOC);
    check($excluded['status'] === 'unknown' && $excluded['last_response_ms'] === null
        && str_contains($excluded['last_error'], '到達不可'), 'Restore retained obsolete excluded target OK or latency');
    check($reachabilityDb->query('SELECT ping_reachability FROM address_spaces WHERE id=42')->fetchColumn() === 'unreachable', 'Full restore lost reachability declaration');
    $reachabilityDb = null;
    foreach ([12 => $schema12Archive, 13 => $schema13Archive, 16 => $schema16Archive, 17 => $schema17Archive, 18 => $schema18Archive, 19 => $schema19Archive] as $sourceSchema => $sourceArchive) {
        $destination = $root . '/config-empty-from-' . $sourceSchema; mkdir($destination);
        rpc($currentWorker, ['command' => 'extract', 'archive' => $sourceArchive, 'root' => $destination, 'max_bytes' => 10000000, 'max_files' => 100]);
        $restoredConfigDb = new PDO('sqlite:' . $destination . '/db/data.sqlite');
        check($restoredConfigDb->query('SELECT * FROM device_configs')->fetchAll() === []
            && $restoredConfigDb->query('SELECT * FROM device_config_states')->fetchAll() === [], 'Legacy migration invented config history or watermarks');
        $restoredConfigDb = null;
    }
    $reverse19 = $root . '/reject20-on19'; mkdir($reverse19);
    rpc($schema19Worker, ['command' => 'extract', 'archive' => $currentArchive,
        'root' => $reverse19, 'max_bytes' => 10000000, 'max_files' => 100], false);
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
    check((int)$limitedDb->query('PRAGMA user_version')->fetchColumn() === APP_DATABASE_SCHEMA_VERSION && $limitedResult['schema_version'] === 11,
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
        check((int)$mutationDb->query('PRAGMA user_version')->fetchColumn() === APP_DATABASE_SCHEMA_VERSION,
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
    foreach (['hierarchy-scale', 'hierarchy-offset', 'hierarchy-rotation', 'hierarchy-building', 'hierarchy-membership', 'hierarchy-device-membership', 'hierarchy-representative', 'hierarchy-sequence',
        'hierarchy-building-view-range', 'hierarchy-building-view-type',
        'rotation-range', 'rotation-infinity', 'rotation-negative-infinity', 'rotation-text', 'rotation-null', 'rotation-unknown', 'unknown-column', 'collision', 'depth-collision', 'invalid-depth', 'both-half', 'outside', 'xy-placement', 'xy-link', 'floor-plan', 'ip-invalid', 'ip-duplicate', 'ip-management', 'ip-foreign',
        'wrong-port-owner', 'occupied-port', 'duplicate-unnamed-pair', 'port-name', 'link-counter', 'invalid-route', 'invalid-conflict',
        'port-vlan-long', 'port-vlan-multiline', 'port-vlan-padded', 'port-vlan-blank',
        'pending-extra-column', 'pending-vlan-empty', 'pending-vlan-long', 'pending-vlan-blob', 'pending-dangling-id',
        'quality-extra-column', 'quality-blob-field', 'quality-unknown-device', 'quality-unknown-link',
        'quality-wrong-endpoint', 'quality-assigned-port', 'quality-filled-field',
        'cidr-invalid', 'cidr-host-bits', 'space-foreign', 'segment-foreign', 'segment-range', 'segment-overlap', 'segment-vlan', 'history-bad-json', 'history-expired-bad-json',
        'space-sequence-exhausted', 'segment-sequence-exhausted', 'history-sequence-exhausted', 'history-sequence-negative', 'history-sequence-text',
        'config-state', 'config-foreign', 'config-watermark', 'config-order', 'config-count', 'config-size', 'config-empty', 'config-utf8', 'config-nul', 'config-control', 'config-crlf', 'config-bom', 'config-memo', 'config-date',
        'config-id-exhausted', 'config-revision-exhausted', 'config-generation-exhausted', 'config-empty-generation-exhausted', 'config-sequence-exhausted'] as $fault) {
        $badDbFile = $root . '/rack-invalid-' . $fault . '.sqlite';
        copy($currentStage . '/db/data.sqlite', $badDbFile);
        $badDb = new PDO('sqlite:' . $badDbFile, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        if (str_starts_with($fault, 'hierarchy-')) {
            $badDb->exec('PRAGMA ignore_check_constraints=ON');
            // Disable triggers only in the deliberately malformed source fixture.
            $hierarchyTriggers = $badDb->query("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name IN ('floors','views')")->fetchAll(PDO::FETCH_ASSOC);
            foreach ($hierarchyTriggers as $trigger) {
                $badDb->exec('DROP TRIGGER "' . str_replace('"', '""', $trigger['name']) . '"');
            }
            if ($fault === 'hierarchy-scale') { $badDb->exec('UPDATE floors SET scale=0'); }
            if ($fault === 'hierarchy-offset') { $badDb->exec('UPDATE floors SET offset_x=1e999'); }
            if ($fault === 'hierarchy-rotation') { $badDb->exec('UPDATE floors SET rotation=181'); }
            if ($fault === 'hierarchy-building') { $badDb->exec('UPDATE floors SET building_id=999'); }
            if ($fault === 'hierarchy-building-view-range') { $badDb->exec('UPDATE buildings SET building_view_enabled=2 WHERE id=71'); }
            if ($fault === 'hierarchy-building-view-type') { $badDb->exec('UPDATE buildings SET building_view_enabled=0.5 WHERE id=71'); }
            if ($fault === 'hierarchy-membership') { $badDb->exec('UPDATE views SET floor_id=999 WHERE id=1'); }
            if ($fault === 'hierarchy-device-membership') { $badDb->exec('UPDATE devices SET floor_id=999 WHERE id=1'); }
            if ($fault === 'hierarchy-representative') { $badDb->exec('UPDATE floors SET representative_view_id=90'); }
            if ($fault === 'hierarchy-sequence') { $badDb->exec("UPDATE resource_sequences SET value=-1 WHERE name='floors'"); }
            foreach ($hierarchyTriggers as $trigger) { $badDb->exec($trigger['sql']); }
        }
        if ($fault === 'unknown-column') { $badDb->exec('ALTER TABLE rack_mounts ADD COLUMN extra TEXT'); }
        if (str_starts_with($fault, 'rotation-')) {
            $badDb->exec('PRAGMA ignore_check_constraints=ON');
            if ($fault === 'rotation-range') { $badDb->exec('UPDATE view_floor_plans SET rotation=181'); }
            if ($fault === 'rotation-infinity') { $badDb->exec('UPDATE view_floor_plans SET rotation=1e999'); }
            if ($fault === 'rotation-negative-infinity') { $badDb->exec('UPDATE view_floor_plans SET rotation=-1e999'); }
            if ($fault === 'rotation-text') { $badDb->exec("UPDATE view_floor_plans SET rotation='invalid'"); }
            if ($fault === 'rotation-null') {
                $badDb->exec('PRAGMA writable_schema=ON');
                $badDb->exec("UPDATE sqlite_master SET sql=replace(sql, 'rotation REAL NOT NULL', 'rotation REAL') WHERE name='view_floor_plans'");
                $badDb->exec('PRAGMA writable_schema=OFF');
                $badDb = null;
                $badDb = new PDO('sqlite:' . $badDbFile, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
                $badDb->exec('PRAGMA ignore_check_constraints=ON');
                $badDb->exec('UPDATE view_floor_plans SET rotation=NULL');
            }
            if ($fault === 'rotation-unknown') { $badDb->exec('ALTER TABLE view_floor_plans ADD COLUMN unknown INTEGER'); }
        }
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
            $badDb->exec("INSERT INTO links (id,from_id,to_id) VALUES (9001,1,99);
                INSERT INTO view_link_routes VALUES (90,1,99,'[]')");
        }
        if ($fault === 'wrong-port-owner') { $badDb->exec('UPDATE links SET from_port_id=12 WHERE id=40'); }
        if ($fault === 'occupied-port') { $badDb->exec('INSERT INTO links (id,from_id,to_id,to_port_id) VALUES (9002,2,1,7)'); }
        if ($fault === 'duplicate-unnamed-pair') {
            $badDb->exec('INSERT INTO links (id,from_id,to_id) VALUES (9002,2,1),(9003,1,2)');
        }
        if ($fault === 'port-name') { $badDb->exec("UPDATE device_ports SET name='ＬＡＮ 1' WHERE id=7"); }
        if ($fault === 'link-counter') { $badDb->exec("UPDATE resource_sequences SET value=40 WHERE name='links'"); }
        if ($fault === 'invalid-route') {
            $badDb->exec("UPDATE view_link_routes SET manual_route='[{\"x\":1,\"y\":2},{\"x\":5,\"y\":6}]'");
        }
        if ($fault === 'invalid-conflict') { $badDb->exec("UPDATE legacy_link_conflicts SET payload=json_set(payload,'$.id',142)"); }
        if ($fault === 'port-vlan-long') {
            $badDb->prepare('UPDATE device_ports SET vlan=? WHERE id=7')->execute([str_repeat('𠀀', 201)]);
        }
        if ($fault === 'port-vlan-multiline') { $badDb->exec("UPDATE device_ports SET vlan='10'||char(10)||'20' WHERE id=7"); }
        if ($fault === 'port-vlan-padded') { $badDb->exec("UPDATE device_ports SET vlan=' access 10 ' WHERE id=7"); }
        if ($fault === 'port-vlan-blank') { $badDb->exec("UPDATE device_ports SET vlan='   ' WHERE id=7"); }
        if ($fault === 'pending-extra-column') { $badDb->exec('ALTER TABLE legacy_link_vlans ADD COLUMN migrated INTEGER DEFAULT 0'); }
        if ($fault === 'pending-vlan-empty') { $badDb->exec('UPDATE legacy_link_vlans SET vlan=char(9,11,12,32) WHERE link_id=40'); }
        if ($fault === 'pending-vlan-long') {
            $badDb->prepare('UPDATE legacy_link_vlans SET vlan=? WHERE link_id=40')->execute([str_repeat('𠀀', 101)]);
        }
        if ($fault === 'pending-vlan-blob') { $badDb->exec("UPDATE legacy_link_vlans SET vlan=CAST(vlan AS BLOB) WHERE link_id=40"); }
        if ($fault === 'pending-dangling-id') {
            $badDb->exec('PRAGMA foreign_keys=OFF; UPDATE legacy_link_vlans SET link_id=150 WHERE link_id=40');
        }
        if ($fault === 'quality-extra-column') { $badDb->exec('ALTER TABLE quality_not_applicable ADD COLUMN reason TEXT'); }
        if ($fault === 'quality-blob-field') {
            $badDb->exec('PRAGMA ignore_check_constraints=ON; UPDATE quality_not_applicable SET field=CAST(field AS BLOB)');
        }
        if ($fault === 'quality-unknown-device') {
            $badDb->exec('PRAGMA foreign_keys=OFF; UPDATE quality_not_applicable SET device_id=999 WHERE link_id IS NULL');
        }
        if ($fault === 'quality-unknown-link') {
            $badDb->exec('PRAGMA foreign_keys=OFF; UPDATE quality_not_applicable SET link_id=999 WHERE link_id=41');
        }
        if ($fault === 'quality-wrong-endpoint') {
            $badDb->exec("UPDATE quality_not_applicable SET device_id=2 WHERE link_id=41 AND field='from_port'");
        }
        if ($fault === 'quality-assigned-port') {
            $badDb->exec("UPDATE quality_not_applicable SET link_id=40 WHERE field='to_port'");
        }
        if ($fault === 'quality-filled-field') {
            $badDb->exec("UPDATE quality_not_applicable SET field='ip' WHERE device_id=1 AND link_id IS NULL");
        }
        if ($fault === 'floor-plan') { $badDb->exec('UPDATE view_floor_plans SET view_id=90 WHERE view_id=1'); }
        if ($fault === 'ip-invalid') { $badDb->exec("UPDATE device_ip_addresses SET ip='999.1.1.1' WHERE id=7"); }
        if ($fault === 'ip-duplicate') { $badDb->exec("UPDATE device_ip_addresses SET ip='203.0.113.1' WHERE id=7"); }
        if ($fault === 'ip-management') { $badDb->exec("UPDATE device_ip_addresses SET ip='192.0.2.1' WHERE id=7"); }
        if ($fault === 'ip-foreign') { $badDb->exec("UPDATE device_ip_addresses SET device_id=999 WHERE id=7"); }
        if ($fault === 'cidr-invalid') { $badDb->exec("UPDATE ip_segments SET cidr='192.0.2.0/33' WHERE id=51"); }
        if ($fault === 'cidr-host-bits') { $badDb->exec("UPDATE ip_segments SET cidr='192.0.2.1/24' WHERE id=51"); }
        if ($fault === 'space-foreign') { $badDb->exec('UPDATE ip_segments SET address_space_id=999999 WHERE id=51'); }
        if ($fault === 'segment-foreign') { $badDb->exec('UPDATE devices SET ip_segment_id=999999 WHERE id=1'); }
        if ($fault === 'segment-range') { $badDb->exec("UPDATE device_ip_addresses SET ip='203.0.113.2' WHERE id=7"); }
        if ($fault === 'segment-overlap') { $badDb->exec('UPDATE ip_segments SET address_space_id=41 WHERE id=53'); }
        if ($fault === 'segment-vlan') { $badDb->exec('PRAGMA ignore_check_constraints=ON; UPDATE ip_segments SET vlan_id=4095 WHERE id=51'); }
        if ($fault === 'history-bad-json') { $badDb->exec("UPDATE change_history SET changes_json='{\"items\":123}' WHERE id=31"); }
        if ($fault === 'history-expired-bad-json') {
            // Expiration must not bypass validation of the original payload.
            $badDb->prepare("UPDATE change_history SET changes_json='{\"items\":123}', occurred_at=? WHERE id=31")
                ->execute([gmdate('Y-m-d\TH:i:s\Z', time() - 95 * 86400)]);
        }
        $sequenceTable = match ($fault) {
            'space-sequence-exhausted' => 'address_spaces',
            'segment-sequence-exhausted' => 'ip_segments',
            'history-sequence-exhausted', 'history-sequence-negative', 'history-sequence-text' => 'change_history',
            default => null,
        };
        if ($sequenceTable !== null) {
            $value = match ($fault) {
                'history-sequence-negative' => -1,
                'history-sequence-text' => 'invalid',
                default => \Netarium\Core\ResourceId::MAX,
            };
            $sequenceUpdate = $badDb->prepare('UPDATE sqlite_sequence SET seq = ? WHERE name = ?');
            $sequenceUpdate->bindValue(1, $value, is_int($value) ? PDO::PARAM_INT : PDO::PARAM_STR);
            $sequenceUpdate->bindValue(2, $sequenceTable, PDO::PARAM_STR);
            $sequenceUpdate->execute();
        }
        if ($fault === 'config-state') { $badDb->exec('DELETE FROM device_config_states WHERE device_id=1'); }
        if ($fault === 'config-foreign') { $badDb->exec('UPDATE device_configs SET device_id=9999 WHERE id=41'); }
        if ($fault === 'config-watermark') { $badDb->exec('UPDATE device_config_states SET next_generation=17 WHERE device_id=1'); }
        if ($fault === 'config-id-exhausted') { $badDb->exec('UPDATE device_configs SET id=' . \Netarium\Core\ResourceId::MAX . ' WHERE id=49'); }
        if ($fault === 'config-revision-exhausted') { $badDb->exec('UPDATE device_config_states SET revision=' . \Netarium\Core\ResourceId::MAX . ' WHERE device_id=1'); }
        if ($fault === 'config-generation-exhausted') { $badDb->exec('UPDATE device_config_states SET next_generation=' . PHP_INT_MAX . ' WHERE device_id=1'); }
        if ($fault === 'config-empty-generation-exhausted') { $badDb->exec('UPDATE device_config_states SET next_generation=' . PHP_INT_MAX . ' WHERE device_id=2'); }
        if ($fault === 'config-sequence-exhausted') { $badDb->exec("UPDATE sqlite_sequence SET seq=" . PHP_INT_MAX . " WHERE name='device_configs'"); }
        if ($fault === 'config-order') { $badDb->exec("UPDATE device_configs SET created_at='2025-01-01T00:00:00Z' WHERE id=49"); }
        if ($fault === 'config-count') {
            $badDb->exec('UPDATE device_config_states SET next_generation=30 WHERE device_id=1');
            for ($i = 0; $i < 1; $i++) {
                $badDb->prepare("INSERT INTO device_configs(id,device_id,generation,content,created_at,actor_user_id,actor_name,memo) VALUES(?,1,?,'hostname extra','2026-01-02T00:00:00Z',NULL,'admin','')")
                    ->execute([50 + $i, 18 + $i]);
            }
        }
        $invalidContent = match ($fault) {
            'config-size' => str_repeat('x', 262145), 'config-empty' => " \t\n",
            'config-utf8' => "secret-marker\xFF", 'config-nul' => "secret-marker\0",
            'config-control' => "secret-marker\x01", 'config-crlf' => "secret-marker\r\n",
            'config-bom' => "\xEF\xBB\xBFsecret-marker", default => null,
        };
        if ($invalidContent !== null) { $badDb->prepare('UPDATE device_configs SET content=? WHERE id=41')->execute([$invalidContent]); }
        if ($fault === 'config-memo') {
            $badDb->exec('PRAGMA ignore_check_constraints=ON');
            $badDb->prepare('UPDATE device_configs SET memo=? WHERE id=41')->execute([str_repeat('長', 201)]);
        }
        if ($fault === 'config-date') { $badDb->exec("UPDATE device_configs SET created_at='2026-02-30T00:00:00Z' WHERE id=41"); }
        $badCounts = [];
        foreach ($badDb->query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'") as $row) {
            $badCounts[$row['name']] = (int)$badDb->query('SELECT COUNT(*) FROM "' . $row['name'] . '"')->fetchColumn();
        }
        $badDb = null;
        if (in_array($fault, ['pending-dangling-id', 'quality-wrong-endpoint'], true)) {
            $badStage = $root . '/invalid-stage-' . $fault;
            copyTree($currentStage, $badStage);
            copy($badDbFile, $badStage . '/db/data.sqlite');
            $packDestination = $root . '/rejected-' . $fault . '.zip';
            rpc($currentWorker, ['command' => 'pack', 'root' => $badStage, 'destination' => $packDestination], false);
            check(!file_exists($packDestination), 'Packing produced an archive with invalid state: ' . $fault);
            check(hash_file('sha256', $badStage . '/db/data.sqlite') === hash_file('sha256', $badDbFile),
                'Packing changed the DB instead of rejecting invalid state: ' . $fault);
        }
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
        if ($fault === 'pending-dangling-id') {
            check(hash_file('sha256', $badDestination . '/db/data.sqlite') === $badManifest['files']['db/data.sqlite']['sha256'],
                'Extraction changed DB bytes before rejecting a dangling VLAN reference');
        }
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
        check((int)$restoredDb->query('PRAGMA user_version')->fetchColumn() === APP_DATABASE_SCHEMA_VERSION, 'Old archive was not migrated to the current schema');
        check($extracted['schema_version'] === ($sourceVersion === $candidateVersion ? APP_DATABASE_SCHEMA_VERSION : 11), 'Source schema metadata changed');
        if ($sourceVersion === $candidateVersion) {
            check($restoredDb->query('SELECT * FROM buildings ORDER BY id')->fetchAll(PDO::FETCH_ASSOC) === $currentBuildings
                && $restoredDb->query('SELECT * FROM floors ORDER BY id')->fetchAll(PDO::FETCH_ASSOC) === $currentFloors,
                'Hierarchy identities, representative or transform lost on full round trip');
            check((int)$restoredDb->query('SELECT floor_id FROM views WHERE id=1')->fetchColumn() === 81,
                'View floor membership lost on full round trip');
            check((int)$restoredDb->query('SELECT floor_id FROM devices WHERE id=1')->fetchColumn() === 81,
                'Device physical floor lost on full round trip');
            check($restoredDb->query('SELECT view_id,rotation FROM view_floor_plans ORDER BY view_id')->fetchAll(PDO::FETCH_ASSOC) === $currentRotations,
                'Floor plan rotation lost on full round trip');
            check($restoredDb->query('SELECT show_connections FROM views WHERE id=1')->fetchColumn() === 0,
                'Connection visibility setting lost on full round trip');
            foreach ($currentConnections as $table => $expectedRows) {
                check($restoredDb->query("SELECT * FROM $table ORDER BY rowid")->fetchAll(PDO::FETCH_ASSOC) === $expectedRows,
                    'Connection state lost on full round trip: ' . $table);
            }
            check($restoredDb->query($qualityRowsSql)->fetchAll(PDO::FETCH_ASSOC) === $currentQualityNotApplicable,
                'Quality not applicable rows lost on full round trip');
            check($restoredDb->query($connectionSequenceSql)->fetchAll(PDO::FETCH_ASSOC) === $currentConnectionSequences,
                'Connection ID counters lost on full round trip');
            check($restoredDb->query('SELECT * FROM rack_mounts')->fetchAll(PDO::FETCH_ASSOC) === $currentMounts, 'Rack physical fields lost');
            check($restoredDb->query('SELECT * FROM canvas_notes WHERE view_id=90 ORDER BY id')->fetchAll(PDO::FETCH_ASSOC) === $currentNotes, 'Rack note fields lost');
            check($restoredDb->query('SELECT type FROM devices WHERE id=1')->fetchColumn() === 'pc', 'PC type lost on full round trip');
            check($restoredDb->query('SELECT name FROM rack_shelves WHERE id=1')->fetchColumn() === 'Backup shelf', 'Shelf lost on full round trip');
            check($restoredDb->query('SELECT shelf_id FROM rack_shelf_devices WHERE device_id=2')->fetchColumn() === 1, 'Shelf membership lost on full round trip');
            check($restoredDb->query('SELECT * FROM floor_rack_placements')->fetchAll(PDO::FETCH_ASSOC) === $currentFloorRacks, 'Floor rack reference lost');
            check($restoredDb->query('SELECT * FROM device_ip_addresses ORDER BY id')->fetchAll(PDO::FETCH_ASSOC) === $currentAddresses, 'Additional IP identities, labels or order lost');
            check($restoredDb->query('SELECT * FROM address_spaces ORDER BY id')->fetchAll(PDO::FETCH_ASSOC) === $currentSpaces, 'Address space identities or fields lost');
            check($restoredDb->query('SELECT * FROM ip_segments ORDER BY id')->fetchAll(PDO::FETCH_ASSOC) === $currentSegments, 'Segment identities or fields lost');
            check((int)$restoredDb->query('SELECT ip_segment_id FROM devices WHERE id=1')->fetchColumn() === 51, 'Management segment lost');
            check($restoredDb->query('SELECT * FROM change_history ORDER BY id')->fetchAll(PDO::FETCH_ASSOC) === $currentHistory, 'Change history lost on full round trip');
            check($restoredDb->query('SELECT * FROM device_configs ORDER BY id')->fetchAll(PDO::FETCH_ASSOC) === $currentConfigs, 'Config identities, generation gaps or contents lost');
            check($restoredDb->query('SELECT * FROM device_config_states ORDER BY device_id')->fetchAll(PDO::FETCH_ASSOC) === $currentConfigStates, 'Config revision/high watermark or empty-history state lost');
        } else {
            check($restoredDb->query('SELECT * FROM buildings')->fetchAll() === []
                && $restoredDb->query('SELECT * FROM floors')->fetchAll() === []
                && (int)$restoredDb->query('SELECT COUNT(*) FROM views WHERE floor_id IS NOT NULL')->fetchColumn() === 0,
                'Old source invented hierarchy');
            check($restoredDb->query('SELECT DISTINCT rotation FROM view_floor_plans')->fetchAll(PDO::FETCH_COLUMN) === [0.0],
                'Legacy floor plan rotation was not zero');
            check($restoredDb->query('SELECT * FROM device_ip_addresses')->fetchAll(PDO::FETCH_ASSOC) === [], 'Old source invented additional IPs');
            check($restoredDb->query('SELECT * FROM change_history')->fetchAll(PDO::FETCH_ASSOC) === [], 'Old source invented change history');
            check($restoredDb->query('SELECT * FROM device_configs')->fetchAll() === []
                && $restoredDb->query('SELECT * FROM device_config_states')->fetchAll() === [], 'Old source invented configs');
            check($restoredDb->query('SELECT * FROM address_spaces')->fetchAll() === []
                && $restoredDb->query('SELECT * FROM ip_segments')->fetchAll() === [], 'Old source invented IP masters');
            check((int)$restoredDb->query('SELECT COUNT(*) FROM devices WHERE ip_segment_id IS NOT NULL')->fetchColumn() === 0,
                'Old source invented management memberships');
            check((int)$restoredDb->query('SELECT COUNT(*) FROM rack_settings')->fetchColumn() === 0
                && (int)$restoredDb->query('SELECT COUNT(*) FROM rack_mounts')->fetchColumn() === 0, 'Old source invented rack data');
            $sourceDb = new PDO('sqlite:' . $stage . '/db/data.sqlite');
            foreach (array_keys($manifest['counts']) as $table) {
                if ($table === 'links') {
                    check((int)$restoredDb->query('SELECT COUNT(*) FROM links')->fetchColumn() === 0
                        && (int)$restoredDb->query('SELECT COUNT(*) FROM legacy_link_conflicts')->fetchColumn() === 0
                        && (int)$restoredDb->query('SELECT COUNT(*) FROM legacy_link_vlans')->fetchColumn() === 0,
                        'Empty legacy source invented connections or conflicts');
                    continue;
                }
                $where = $table === 'resource_sequences' ? " WHERE name NOT IN ('rack_shelves','buildings','floors','device_ports')" : '';
                if ($table === 'app_meta') { $where = " WHERE meta_key NOT IN ('legacy_hierarchy_migration','legacy_link_migration')"; }
                $columns = array_map(static fn(array $column): string => '"' . str_replace('"', '""', $column['name']) . '"',
                    $sourceDb->query("PRAGMA table_info(\"$table\")")->fetchAll(PDO::FETCH_ASSOC));
                $projection = implode(',', $columns);
                check($restoredDb->query("SELECT $projection FROM \"$table\"$where ORDER BY rowid")->fetchAll(PDO::FETCH_ASSOC)
                    === $sourceDb->query("SELECT $projection FROM \"$table\" ORDER BY rowid")->fetchAll(PDO::FETCH_ASSOC), 'Migration changed source rows: ' . $table);
            }
            $migrationReport = json_decode($restoredDb->query("SELECT meta_value FROM app_meta WHERE meta_key='legacy_hierarchy_migration'")->fetchColumn(), true, 512, JSON_THROW_ON_ERROR);
            check($migrationReport['assigned'] === 0 && $migrationReport['created_buildings'] === 0 && $migrationReport['created_floors'] === 0,
                'Empty legacy locations must not create hierarchy or assignments');
            $sourceDb = null;
        }
        $restoredUser = $restoredDb->query("SELECT * FROM users WHERE username='full-admin'")->fetch(PDO::FETCH_ASSOC);
        check($restoredUser['role'] === 'admin' && password_verify('FullBackup-test-93!', $restoredUser['password_hash']), 'Credentials lost on current restore');
        $restoredDb = null;
    }
    // Isolated v2.x fixtures for minor and multi-digit patch ordering at the current schema.
    $numericWorkers = [];
    foreach (['2.9.0', '2.10.2', '2.10.10'] as $numericVersion) {
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
    foreach (['2.9.0' => '2.10.2', '2.10.2' => '2.10.10'] as $sourceVersion => $targetVersion) {
        $numericArchive = $root . '/numeric-' . $sourceVersion . '.zip';
        $numericManifest = rpc($numericWorkers[$sourceVersion], ['command' => 'pack', 'root' => $currentStage, 'destination' => $numericArchive]);
        check($numericManifest['application_version'] === $sourceVersion && $numericManifest['schema_version'] === APP_DATABASE_SCHEMA_VERSION,
            'Numeric source fixture did not pack its own version/schema');
        $numericDestination = $root . '/numeric-' . $sourceVersion . '-on-' . $targetVersion; mkdir($numericDestination);
        $numericExtracted = rpc($numericWorkers[$targetVersion], ['command' => 'extract', 'archive' => $numericArchive,
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
    [$major, $minor, $patch] = explode('.', $candidateVersion);
    $futureVersion = $major . '.' . $minor . '.' . ((int)$patch + 1);
    $rejectionFixtures = [
        'legacy-major' => [$archive, ['application_version' => '0.3.0']],
        'out-of-range-v1' => [$archive, ['application_version' => '1.5.3']],
        'future-major' => [$currentArchive, ['application_version' => '3.0.0']],
        'future-patch' => [$currentArchive, ['application_version' => $futureVersion]],
        'v1-schema24' => [$root . '/schema24.zip', ['application_version' => '1.5.2']],
        'v1-schema29' => [$currentArchive, ['application_version' => '1.5.2']],
        'schema-below-minimum' => [$archive, ['schema_version' => 10]],
        'schema-future' => [$currentArchive, ['schema_version' => APP_DATABASE_SCHEMA_VERSION + 1]],
        'schema-string' => [$archive, ['schema_version' => '11']],
        'format-version' => [$currentArchive, ['format_version' => 2]],
        'format-version-string' => [$currentArchive, ['format_version' => '1']],
        'format-name' => [$currentArchive, ['format' => 'netarium-config']],
        'corrupt' => [$currentArchive, []],
    ];
    foreach (['1.3', '01.3.0', '1.03.0', '1.3.00', 'v1.3.0', '1.5.2-rc.1', '1.5.2+build.1', ''] as $index => $invalidVersion) {
        // Keep the v1 schema valid so the version itself is responsible for rejection.
        $rejectionFixtures['app-version-' . $index] = [$archive, ['application_version' => $invalidVersion]];
    }
    foreach ($rejectionFixtures as $case => [$sourceArchive, $overrides]) {
        $badZip = $root . '/reject-current-' . $case . '.zip'; copy($sourceArchive, $badZip);
        if ($case === 'corrupt') {
            file_put_contents($badZip, 'not a zip');
        } else {
            $zip = new ZipArchive(); check($zip->open($badZip) === true, 'Cannot open rejection ZIP');
            $m = array_replace(json_decode((string)$zip->getFromName('manifest.json'), true, 512, JSON_THROW_ON_ERROR), $overrides);
            $zip->addFromString('manifest.json', json_encode($m, JSON_THROW_ON_ERROR)); $zip->close();
        }
        $destination = $root . '/reject-current-dest-' . $case; mkdir($destination);
        rpc($currentWorker, ['command' => 'extract', 'archive' => $badZip, 'root' => $destination, 'max_bytes' => 10000000, 'max_files' => 100], false);
        check(scandir($destination) === ['.', '..'], 'Preflight rejection wrote payload: ' . $case);
    }
    check(hash_file('sha256', $dbFile) === $liveDbHash && hash_file('sha256', $dbFile . '-wal') === $liveWalHash, 'Backup changed live DB/WAL bytes');
    foreach ($liveRows as $table => $rows) {
        check($db->query("SELECT * FROM $table")->fetchAll(PDO::FETCH_ASSOC) === $rows, 'Backup changed live rows: ' . $table);
    }
    foreach ($imageFiles as $name => $bytes) {
        check(hash_file('sha256', $storage . '/uploads/' . $name) === hash('sha256', $bytes), 'Backup changed live image');
    }
    $db = null;
    if ($v120Source === dirname(__DIR__)) {
        echo "SKIP public v1.2.0 full ZIP smoke: NETARIUM_BACKUP_V120_ROOT not set (synthetic schema11 fixture passed)\n";
    } else {
        echo "PASS public v1.2.0 full ZIP smoke: unchanged release helper generated schema11 ZIP; restored on $candidateVersion\n";
    }
    $v152Source = getenv('NETARIUM_BACKUP_V152_ROOT');
    if ($v152Source === false || $v152Source === '') {
        echo "SKIP public v1.5.2 full ZIP smoke: NETARIUM_BACKUP_V152_ROOT not set\n";
    } else {
        smokePublicV152FullRestore($v152Source, $root, $environment, $png, $password);
        echo "PASS public v1.5.2 full ZIP smoke: unchanged release initialized schema23 DB and generated ZIP; applied on $candidateVersion\n";
    }
    echo "PASS full backup: source verification and isolated schema" . APP_DATABASE_SCHEMA_VERSION . " migration, Config identities/generation watermarks and bounds, IP reachability/master/membership and additional IP identity/order roundtrip, rack/depth/shelf/floor references, invalid data rejection, numeric patch/minor forward compatibility, reverse/major/schema/format rejection, WAL/live invariance, ZIP/manifest/reference SHA, users/login, lock contention; $assertions assertions\n";
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
