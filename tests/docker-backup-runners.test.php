<?php
declare(strict_types=1);

// Test suite for docker-backup-runner.php and docker-restore-runner.php
require_once dirname(__DIR__) . '/bootstrap.php';
require_once dirname(__DIR__) . '/src/Core/DatabaseSchema.php';

$root = sys_get_temp_dir() . '/netarium-docker-backup-test-' . bin2hex(random_bytes(8));
mkdir($root, 0700);

$assertions = 0;
function check(bool $ok, string $message): void
{
    $GLOBALS['assertions']++;
    if (!$ok) {
        throw new RuntimeException($message);
    }
}

function removeTree(string $dir): void
{
    if (!is_dir($dir)) {
        return;
    }
    foreach (new DirectoryIterator($dir) as $item) {
        if ($item->isDot()) {
            continue;
        }
        if ($item->isDir() && !$item->isLink()) {
            removeTree($item->getPathname());
        } else {
            @unlink($item->getPathname());
        }
    }
    @rmdir($dir);
}

try {
    $storage = $root . '/storage';
    foreach ([
        'db/csv-import',
        'uploads/floorplans',
        'uploads/device_images',
        'cache/thumbnails',
        'temp/backup-export',
        'temp/backup-restore',
        'backups/auto',
        'logs/audit',
        'sessions'
    ] as $dir) {
        mkdir($storage . '/' . $dir, 0700, true);
    }
    touch($storage . '/temp/operation.lock');

    $dbFile = $storage . '/db/data.sqlite';
    $db = new PDO('sqlite:' . $dbFile, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    for ($version = 1; $version <= 11; $version++) {
        ('migrateDatabaseToVersion' . $version)($db);
    }

    $png = base64_decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=');
    $sha256 = hash('sha256', $png);

    $db->exec("INSERT INTO devices (id, name, type, ip) VALUES (1, 'DOCKER-TEST-01', 'switch', '192.168.10.1')");
    $db->exec("INSERT INTO views (id, name, view_type) VALUES (1, 'Test View', 'floor')");
    $planName = md5('plan-1') . '.png';
    $devName = md5('dev-1') . '.png';
    $db->prepare("INSERT INTO view_floor_plans (view_id, stored_name, original_name, mime_type, file_size, image_width, image_height, sha256, created_at, updated_at)
        VALUES (1, ?, 'plan.png', 'image/png', ?, 1, 1, ?, '2026-01-01', '2026-01-01')")->execute([$planName, strlen($png), $sha256]);
    $db->prepare("INSERT INTO device_images (device_id, stored_name, mime_type, file_size, image_width, image_height, sha256, sort_order, created_at, updated_at)
        VALUES (1, ?, 'image/png', ?, 1, 1, ?, 1, '2026-01-01', '2026-01-01')")->execute([$devName, strlen($png), $sha256]);

    file_put_contents($storage . '/uploads/floorplans/' . $planName, $png);
    file_put_contents($storage . '/uploads/device_images/' . $devName, $png);

    $passwordHash = password_hash('DockerTestSecret-99!', PASSWORD_ARGON2ID);
    $now = date(DATE_ATOM);
    $db->prepare("INSERT INTO users (username, password_hash, role, created_at, updated_at) VALUES ('docker-admin', ?, 'admin', ?, ?)")
        ->execute([$passwordHash, $now, $now]);
    $db->exec("INSERT OR REPLACE INTO app_meta (meta_key, meta_value) VALUES ('setup_completed', '1')");
    $db = null;

    // Create dummy session file
    file_put_contents($storage . '/sessions/sess_dummy_session_123', 'user_id|s:1:"1";');
    check(is_file($storage . '/sessions/sess_dummy_session_123'), 'Session file seeded');

    // 1. Test docker-backup-runner.php
    $backupOut = $root . '/backup.zip';
    $parentEnv = getenv();
    $baseEnv = array_merge(is_array($parentEnv) ? $parentEnv : [], [
        'NETARIUM_STORAGE_DIR' => $storage,
        'NETARIUM_DB_FILE' => $dbFile
    ]);
    if (stripos(PHP_OS, 'WIN') === 0) {
        $baseEnv['SystemRoot'] = getenv('SystemRoot') ?: 'C:\Windows';
    }

    $descriptors = [
        0 => ['pipe', 'r'],
        1 => ['pipe', 'w'],
        2 => ['pipe', 'w']
    ];

    $cmdBackup = [
        PHP_BINARY,
        dirname(__DIR__) . '/scripts/docker-backup-runner.php',
        '--output=' . $backupOut
    ];

    $proc = proc_open($cmdBackup, $descriptors, $pipes, dirname(__DIR__), $baseEnv);
    check(is_resource($proc), 'Failed to spawn docker-backup-runner');
    fclose($pipes[0]);
    $stdout = stream_get_contents($pipes[1]);
    $stderr = stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    $code = proc_close($proc);
    check($code === 0, 'Backup runner exited with ' . $code . ': stdout=' . $stdout . ' stderr=' . $stderr);
    check(is_file($backupOut), 'Backup archive created');
    $backupJson = json_decode($stdout, true);
    check(is_array($backupJson) && ($backupJson['ok'] ?? false) === true, 'Backup JSON response valid');
    check(($backupJson['file_count'] ?? 0) === 3, 'Backup file_count is 3 (db + 2 images)');
    if (PHP_OS_FAMILY !== 'Windows') {
        check((fileperms($backupOut) & 0777) === 0600, 'Backup archive permissions are 0600');
    }

    // 2. Test docker-restore-runner.php --verify-only
    $cmdVerify = [
        PHP_BINARY,
        dirname(__DIR__) . '/scripts/docker-restore-runner.php',
        '--verify-only',
        '--archive=' . $backupOut
    ];

    $proc = proc_open($cmdVerify, $descriptors, $pipes, dirname(__DIR__), $baseEnv);
    check(is_resource($proc), 'Failed to spawn docker-restore-runner --verify-only');
    fclose($pipes[0]);
    $stdout = stream_get_contents($pipes[1]);
    $stderr = stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    $code = proc_close($proc);

    check($code === 0, 'Verify runner exited with non-zero: ' . $stderr);
    $verifyJson = json_decode($stdout, true);
    check(is_array($verifyJson) && ($verifyJson['verified'] ?? false) === true, 'Verify JSON response valid');

    // 3. Mutate live database and delete an image to simulate corruption/data loss
    $db = new PDO('sqlite:' . $dbFile, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    $db->exec("UPDATE devices SET name = 'MUTATED-DEVICE' WHERE id = 1");
    $db->exec("DELETE FROM users WHERE username = 'docker-admin'");
    $db = null;
    unlink($storage . '/uploads/floorplans/' . $planName);

    // Add another dummy session
    file_put_contents($storage . '/sessions/sess_another_session_456', 'temp');

    // 4. Test docker-restore-runner.php --apply
    $cmdApply = [
        PHP_BINARY,
        dirname(__DIR__) . '/scripts/docker-restore-runner.php',
        '--apply',
        '--archive=' . $backupOut
    ];

    $proc = proc_open($cmdApply, $descriptors, $pipes, dirname(__DIR__), $baseEnv);
    check(is_resource($proc), 'Failed to spawn docker-restore-runner --apply');
    fclose($pipes[0]);
    $stdout = stream_get_contents($pipes[1]);
    $stderr = stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    $code = proc_close($proc);

    check($code === 0, 'Restore apply exited with non-zero: ' . $stderr);
    $applyJson = json_decode($stdout, true);
    check(is_array($applyJson) && ($applyJson['restored'] ?? false) === true, 'Restore apply JSON response valid');

    // 5. Verify restored state
    $db = new PDO('sqlite:' . $dbFile, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    $deviceName = $db->query("SELECT name FROM devices WHERE id = 1")->fetchColumn();
    check($deviceName === 'DOCKER-TEST-01', 'Device name restored to original');
    $userCount = (int)$db->query("SELECT COUNT(*) FROM users WHERE username = 'docker-admin'")->fetchColumn();
    check($userCount === 1, 'Admin user restored');
    $db = null;

    check(is_file($storage . '/uploads/floorplans/' . $planName), 'Floorplan image restored');
    check(hash_file('sha256', $storage . '/uploads/floorplans/' . $planName) === $sha256, 'Floorplan image SHA-256 matches');
    check(is_file($storage . '/uploads/device_images/' . $devName), 'Device image exists');

    // Verify session files were cleared
    check(!is_file($storage . '/sessions/sess_dummy_session_123'), 'Old session 1 cleared');
    check(!is_file($storage . '/sessions/sess_another_session_456'), 'Old session 2 cleared');
    // 6. Negative tests: invalid archive rejected by verify-only and apply
    $badZip = $root . '/corrupt.zip';
    file_put_contents($badZip, 'not-a-valid-zip-content');
    $cmdBadVerify = [
        PHP_BINARY,
        dirname(__DIR__) . '/scripts/docker-restore-runner.php',
        '--verify-only',
        '--archive=' . $badZip
    ];
    $proc = proc_open($cmdBadVerify, $descriptors, $pipes, dirname(__DIR__), $baseEnv);
    fclose($pipes[0]);
    stream_get_contents($pipes[1]);
    stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    $code = proc_close($proc);
    check($code === 1, 'Corrupted ZIP rejected by verify-only with exit code 1');

    $cmdBadApply = [
        PHP_BINARY,
        dirname(__DIR__) . '/scripts/docker-restore-runner.php',
        '--apply',
        '--archive=' . $badZip
    ];
    $proc = proc_open($cmdBadApply, $descriptors, $pipes, dirname(__DIR__), $baseEnv);
    fclose($pipes[0]);
    stream_get_contents($pipes[1]);
    stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    $code = proc_close($proc);
    check($code === 1, 'Corrupted ZIP rejected by apply with exit code 1');

    // Verify live DB remains untouched
    $db = new PDO('sqlite:' . $dbFile, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    check($db->query("SELECT name FROM devices WHERE id = 1")->fetchColumn() === 'DOCKER-TEST-01', 'Live DB intact after rejected restore');
    $db = null;

    // 7. Fault injection: trigger post-restore check failure and verify safe rollback
    $db = new PDO('sqlite:' . $dbFile, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    $db->exec("UPDATE devices SET name = 'LIVE-BEFORE-FAULT' WHERE id = 1");
    $db = null;

    // Remove a required directory so check-install.php fails after placement
    $removedDir = $storage . '/backups/auto';
    rmdir($removedDir);

    $cmdFaultApply = [
        PHP_BINARY,
        dirname(__DIR__) . '/scripts/docker-restore-runner.php',
        '--apply',
        '--archive=' . $backupOut
    ];
    $proc = proc_open($cmdFaultApply, $descriptors, $pipes, dirname(__DIR__), $baseEnv);
    fclose($pipes[0]);
    $stdout = stream_get_contents($pipes[1]);
    $stderr = stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    $code = proc_close($proc);

    check($code === 1, 'Restore with post-check failure exited with 1 (rollback ok): ' . $stderr);
    check(str_contains($stderr, 'Rollback succeeded'), 'Stderr confirms rollback succeeded: ' . $stderr);

    // Verify prior live database was restored and NOT overwritten/corrupted by reference bug
    $db = new PDO('sqlite:' . $dbFile, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    check($db->query("SELECT name FROM devices WHERE id = 1")->fetchColumn() === 'LIVE-BEFORE-FAULT', 'Prior live DB restored on rollback');
    $db = null;

    // Restore the directory
    mkdir($removedDir, 0700, true);

    // 8. Corrupt live database check: failure before swap occurs
    file_put_contents($dbFile, 'not-a-valid-sqlite-database');
    $proc = proc_open($cmdFaultApply, $descriptors, $pipes, dirname(__DIR__), $baseEnv);
    fclose($pipes[0]);
    $stdout = stream_get_contents($pipes[1]);
    $stderr = stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    $code = proc_close($proc);
    check($code === 1, 'Corrupted live DB rejected prior to swap with code 1');
    check(str_contains($stderr, 'Live database checkpoint or integrity failure'), 'Stderr mentions live integrity failure: ' . $stderr);

    // 9. Custom NETARIUM_DB_FILE path: verify check-install.php receives --db-file correctly
    $customDbFile = $storage . '/db/custom-data.sqlite';
    if (file_exists($storage . '/db/data.sqlite')) {
        unlink($storage . '/db/data.sqlite');
    }
    if (file_exists($customDbFile)) {
        unlink($customDbFile);
    }
    $customEnv = array_merge($baseEnv, [
        'NETARIUM_DB_FILE' => $customDbFile
    ]);
    $cmdCustomApply = [
        PHP_BINARY,
        dirname(__DIR__) . '/scripts/docker-restore-runner.php',
        '--apply',
        '--archive=' . $backupOut
    ];
    $proc = proc_open($cmdCustomApply, $descriptors, $pipes, dirname(__DIR__), $customEnv);
    fclose($pipes[0]);
    $stdout = stream_get_contents($pipes[1]);
    $stderr = stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    $code = proc_close($proc);
    check($code === 0, 'Restore apply with custom NETARIUM_DB_FILE succeeded: ' . $stderr);
    check(is_file($customDbFile), 'Custom db file exists after restore');
    check(!file_exists($storage . '/db/data.sqlite'), 'Default data.sqlite was not erroneously initialized by check-install');
    $db = new PDO('sqlite:' . $customDbFile, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    check($db->query("SELECT name FROM devices WHERE id = 1")->fetchColumn() === 'DOCKER-TEST-01', 'Custom db has restored data');
    $db = null;

    // 10. Disaster recovery onto empty host storage (all targets initially absent)
    $emptyStorage = $root . '/empty-storage';
    foreach ([
        'db/csv-import',
        'cache/thumbnails',
        'temp/backup-export',
        'temp/backup-restore',
        'backups/auto',
        'logs/audit',
        'sessions'
    ] as $dir) {
        mkdir($emptyStorage . '/' . $dir, 0700, true);
    }
    touch($emptyStorage . '/temp/operation.lock');
    $emptyEnv = array_merge($baseEnv, [
        'NETARIUM_STORAGE_DIR' => $emptyStorage,
        'NETARIUM_DB_FILE' => $emptyStorage . '/db/data.sqlite',
    ]);
    $cmdEmptyApply = [
        PHP_BINARY,
        dirname(__DIR__) . '/scripts/docker-restore-runner.php',
        '--apply',
        '--archive=' . $backupOut
    ];
    $proc = proc_open($cmdEmptyApply, $descriptors, $pipes, dirname(__DIR__), $emptyEnv);
    fclose($pipes[0]);
    $stdout = stream_get_contents($pipes[1]);
    $stderr = stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    $code = proc_close($proc);
    check($code === 0, 'Disaster recovery on empty host storage succeeded: ' . $stderr);
    check(is_file($emptyStorage . '/db/data.sqlite'), 'DB restored on empty storage');
    check(is_dir($emptyStorage . '/uploads/floorplans'), 'Floorplans directory restored on empty storage');
    check(is_dir($emptyStorage . '/uploads/device_images'), 'Device images directory restored on empty storage');
    $emptyDb = new PDO('sqlite:' . $emptyStorage . '/db/data.sqlite', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    check($emptyDb->query("SELECT name FROM devices WHERE id = 1")->fetchColumn() === 'DOCKER-TEST-01', 'Empty storage has restored devices');
    check($emptyDb->query("SELECT username FROM users WHERE id = 1")->fetchColumn() === 'docker-admin', 'Empty storage has restored users');
    $emptyDb = null;
    echo "PASS: docker-backup-runner and docker-restore-runner ({$assertions} assertions)\n";
} finally {
    removeTree($root);
}
