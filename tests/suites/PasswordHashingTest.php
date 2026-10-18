<?php
declare(strict_types=1);

namespace Netarium\Tests\Suites;

use Netarium\Services\Auth\PasswordHashing;
use Netarium\Tests\TestCase;
use Netarium\Tests\TestHttpClient;
use Netarium\Tests\TestServer;
use PDO;

class PasswordHashingTest extends TestCase
{
    public function __construct(TestHttpClient $client)
    {
    }

    private function database(TestServer $server): PDO
    {
        $db = new PDO('sqlite:' . $server->getDbPath());
        $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $db->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        return $db;
    }

    private function credentials(PDO $db, string $username): array
    {
        $stmt = $db->prepare('SELECT id, password_hash, auth_revision, password_revision, password_changed_at, must_change_password FROM users WHERE username = ?');
        $stmt->execute([$username]);
        return $stmt->fetch();
    }

    private function command(array $arguments): array
    {
        $process = proc_open($arguments, [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
        fclose($pipes[0]);
        $output = stream_get_contents($pipes[1]) . stream_get_contents($pipes[2]);
        fclose($pipes[1]);
        fclose($pipes[2]);
        return [proc_close($process), $output];
    }

    public function testFullInputAndUnicodeBoundaries(): void
    {
        require_once dirname(__DIR__, 2) . '/bootstrap.php';
        foreach ([str_repeat('a', 11) . 'b', str_repeat('a', 127) . 'b', str_repeat('あ', 127) . 'い', str_repeat('😀', 127) . '😃'] as $password) {
            $this->assertNull(\validatePassword($password));
            $hash = PasswordHashing::hash($password);
            $this->assertSame('argon2id', password_get_info($hash)['algoName']);
            $this->assertTrue(PasswordHashing::verify($password, $hash, false));
            $this->assertFalse(PasswordHashing::verify($password . 'a', $hash, false));
        }
        foreach ([str_repeat('a', 11), str_repeat('a', 129), str_repeat('😀', 128) . 'a', "invalid\xC0\xAFunicode", "invalid\xED\xA0\x80unicode", str_repeat('a', 12) . "\0"] as $invalid) {
            $this->assertNotNull(\validatePassword($invalid));
        }
        $password = str_repeat('a', 72) . 'original-tail';
        $hash = PasswordHashing::hash($password);
        $this->assertFalse(PasswordHashing::verify(str_repeat('a', 72), $hash, true));
        $this->assertFalse(PasswordHashing::verify(str_repeat('a', 72) . 'other-tail', $hash, true));
        $raw = ' ' . str_repeat("e\u{0301}", 6) . ' ';
        $hash = PasswordHashing::hash($raw);
        $this->assertTrue(PasswordHashing::verify($raw, $hash, false));
        $this->assertFalse(PasswordHashing::verify(trim($raw), $hash, false));
        $this->assertFalse(PasswordHashing::verify(' ' . str_repeat('é', 6) . ' ', $hash, false));
        $this->assertFalse(PasswordHashing::verify($password, password_hash($password, PASSWORD_ARGON2I), true));
    }

    public function testLegacyLoginExplicitMigrationAndDatabaseRestore(): void
    {
        $server = new TestServer();
        try {
            $server->start();
            $db = $this->database($server);
            $prefix = str_repeat('a', 72);
            $legacyHash = password_hash($prefix . 'original', PASSWORD_BCRYPT, ['cost' => 4]);
            $db->prepare("UPDATE users SET password_hash = ? WHERE username = 'viewer'")->execute([$legacyHash]);
            $before = $this->credentials($db, 'viewer');
            $snapshot = $server->getTempDir() . '/before-migration.sqlite';
            $db->exec('VACUUM INTO ' . $db->quote($snapshot));
            $legacy = new TestHttpClient($server->getBaseUrl());
            $second = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($legacy->login('viewer', $prefix . 'different'));
            $this->assertTrue($second->login('viewer', $prefix));
            $this->assertSame($before, $this->credentials($db, 'viewer'), 'Successful bcrypt login must not rehash or change credential revisions');
            $newPassword = str_repeat('😀', 127) . '😃';
            $legacy->postJson('/api.php?action=change_own_password', [
                'current_password' => $prefix . 'different',
                'new_password' => $newPassword,
                'new_password_confirm' => $newPassword,
            ])->assertOk();
            $after = $this->credentials($db, 'viewer');
            $this->assertSame('argon2id', password_get_info($after['password_hash'])['algoName']);
            $this->assertSame((int)$before['password_revision'] + 1, (int)$after['password_revision']);
            $legacy->get('/api.php?action=load')->assertStatus(401);
            $second->get('/api.php?action=load')->assertStatus(401);
            $this->assertFalse((new TestHttpClient($server->getBaseUrl()))->login('viewer', $prefix));
            $migrated = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($migrated->login('viewer', $newPassword));
            $migrated->get('/api.php?action=load')->assertOk();

            // SQLite全体復元はハッシュと世代を巻き戻す。実ファイルを差し戻して再移行する。
            $db = null;
            $this->assertTrue(copy($snapshot, $server->getDbPath()));
            $db = $this->database($server);
            $this->assertSame($before, $this->credentials($db, 'viewer'));
            $migrated->get('/api.php?action=load')->assertStatus(401);
            $restored = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($restored->login('viewer', $prefix . 'restored-tail'));
            $admin = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($admin->login('admin', 'admin123'));
            $resetPassword = $prefix . 'reset-tail';
            $admin->postJson('/api.php?action=reset_user_password', [
                'id' => (int)$before['id'], 'password' => $resetPassword, 'password_confirm' => $resetPassword,
            ])->assertOk();
            $this->assertSame('argon2id', password_get_info($this->credentials($db, 'viewer')['password_hash'])['algoName']);
            $restored->get('/api.php?action=load')->assertStatus(401);
            $reset = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($reset->login('viewer', $resetPassword));
            $reset->get('/api.php?action=load')->assertError(403);
            $this->assertFalse((new TestHttpClient($server->getBaseUrl()))->login('viewer', $prefix . 'different-tail'));
            $this->assertSame(APP_DATABASE_SCHEMA_VERSION, (int)$db->query('PRAGMA user_version')->fetchColumn());
        } finally {
            $db = null;
            $server->stop();
        }
    }

    public function testLegacyCutoffRevokesSessionsWithoutAffectingArgon2id(): void
    {
        $fixture = sys_get_temp_dir() . '/netarium-policy-' . bin2hex(random_bytes(8));
        mkdir($fixture . '/src/Core', 0700, true);
        mkdir($fixture . '/config', 0700, true);
        copy(dirname(__DIR__, 2) . '/src/Core/Config.php', $fixture . '/src/Core/Config.php');
        $configPath = $fixture . '/config/app.php';
        file_put_contents($configPath, "<?php return ['allow_legacy_bcrypt' => true];");
        $prepend = $fixture . '/prepend.php';
        file_put_contents($prepend, '<?php require_once ' . var_export($fixture . '/src/Core/Config.php', true) . ';');
        $server = new TestServer(null, $prepend);
        try {
            $server->start();
            $db = $this->database($server);
            $hash = password_hash('legacy-password', PASSWORD_BCRYPT, ['cost' => 4]);
            $db->prepare("UPDATE users SET password_hash = ? WHERE username = 'viewer'")->execute([$hash]);
            $viewer = new TestHttpClient($server->getBaseUrl());
            $admin = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($viewer->login('viewer', 'legacy-password'));
            $this->assertTrue($admin->login('admin', 'admin123'));
            file_put_contents($configPath, "<?php return ['allow_legacy_bcrypt' => false];");
            $viewer->get('/api.php?action=load')->assertStatus(401);
            $this->assertFalse((new TestHttpClient($server->getBaseUrl()))->login('viewer', 'legacy-password'));
            $this->assertFalse(PasswordHashing::verify('legacy-password', $hash, false));
            $admin->get('/api.php?action=load')->assertOk();
            $admin->postJson('/api.php?action=reset_user_password', [
                'id' => (int)$this->credentials($db, 'viewer')['id'],
                'password' => 'argon-reset-password', 'password_confirm' => 'argon-reset-password',
            ])->assertOk();
            $fresh = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($fresh->login('viewer', 'argon-reset-password'));
            $fresh->get('/api.php?action=load')->assertError(403);
        } finally {
            $db = null;
            $server->stop();
            unlink($prepend);
            unlink($configPath);
            unlink($fixture . '/src/Core/Config.php');
            rmdir($fixture . '/config');
            rmdir($fixture . '/src/Core');
            rmdir($fixture . '/src');
            rmdir($fixture);
        }
    }

    public function testUnavailableOrFailedHashingPreservesAllWritePathsAndHidesSecrets(): void
    {
        $prepend = tempnam(sys_get_temp_dir(), 'netarium-hash-failure-');
        $marker = $prepend . '.mode';
        file_put_contents($prepend, '<?php namespace Netarium\\Services\\Auth; '
            . 'function password_algos(): array { return @file_get_contents(' . var_export($marker, true) . ') === "unsupported" ? ["2y"] : \\password_algos(); } '
            . 'function password_hash($password, $algorithm, $options): string { if (@file_get_contents(' . var_export($marker, true) . ') === "failed") { throw new \\RuntimeException($password); } return \\password_hash($password, $algorithm, $options); }');
        $server = new TestServer(null, $prepend);
        try {
            $server->start();
            $db = $this->database($server);
            $admin = new TestHttpClient($server->getBaseUrl());
            $viewer = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($admin->login('admin', 'admin123'));
            $this->assertTrue($viewer->login('viewer', 'viewer123'));
            $before = $db->query('SELECT * FROM users ORDER BY id')->fetchAll();
            $secret = 'synthetic-secret-for-failure';
            $passwordFile = $server->getTempDir() . '/password.txt';
            file_put_contents($passwordFile, $secret);
            foreach (['failed', 'unsupported'] as $mode) {
                file_put_contents($marker, $mode);
                if ($mode === 'failed') {
                    foreach ([
                        ['create_user', ['username' => 'failure-user', 'password' => $secret, 'password_confirm' => $secret]],
                        ['reset_user_password', ['id' => 2, 'password' => $secret, 'password_confirm' => $secret]],
                    ] as [$action, $input]) {
                        $response = $admin->postJson('/api.php?action=' . $action, $input)->assertError(503);
                        $this->assertFalse(str_contains($response->getBody(), $secret));
                    }
                    $response = $viewer->postJson('/api.php?action=change_own_password', [
                        'current_password' => 'viewer123', 'new_password' => $secret, 'new_password_confirm' => $secret,
                    ])->assertError(503);
                    $this->assertFalse(str_contains($response->getBody(), $secret));
                } else {
                    $admin->postJson('/api.php?action=create_user', [
                        'username' => 'unsupported-user', 'password' => $secret, 'password_confirm' => $secret,
                    ])->assertStatus(401);
                    $viewer->get('/api.php?action=load')->assertStatus(401);
                    $login = new TestHttpClient($server->getBaseUrl());
                    preg_match('/name="csrf_token"\\s+value="([^"]+)"/', $login->get('/login.php')->getBody(), $matches);
                    $login->postForm('/login.php', ['csrf_token' => $matches[1], 'username' => 'viewer',
                        'password' => 'viewer123'])->assertStatus(503);
                }
                [$status, $output] = $this->command([PHP_BINARY, '-d', 'auto_prepend_file=' . $prepend,
                    dirname(__DIR__, 2) . '/scripts/recover-admin.php', '--db=' . $server->getDbPath(),
                    '--username=admin', '--password-file=' . $passwordFile]);
                $this->assertSame(1, $status);
                $this->assertFalse(str_contains($output, $secret));
                $this->assertSame($before, $db->query('SELECT * FROM users ORDER BY id')->fetchAll());
            }
            unlink($marker);
            $this->assertTrue($viewer->login('viewer', 'viewer123'));
            $this->assertTrue($admin->login('admin', 'admin123'));
            $viewer->get('/api.php?action=load')->assertOk();
            $admin->get('/api.php?action=load')->assertOk();
            $db->exec('DELETE FROM users');
            $db->exec("DELETE FROM app_meta WHERE meta_key IN ('setup_bootstrap_sha256', 'setup_completed')");
            $bootstrapSecret = bin2hex(random_bytes(32));
            \Netarium\Services\Auth\InitialSetup::issueSecret($db, $bootstrapSecret);
            foreach (['failed', 'unsupported'] as $mode) {
                file_put_contents($marker, $mode);
                $setup = new TestHttpClient($server->getBaseUrl());
                preg_match('/name="csrf_token"\\s+value="([^"]+)"/', $setup->get('/setup.php')->getBody(), $matches);
                $response = $setup->postForm('/setup.php', ['csrf_token' => $matches[1], 'username' => 'setup-admin',
                    'bootstrap_secret' => $bootstrapSecret,
                    'password' => $secret, 'password_confirm' => $secret])->assertStatus(503);
                $this->assertFalse(str_contains($response->getBody(), $secret));
                $this->assertSame(0, (int)$db->query('SELECT COUNT(*) FROM users')->fetchColumn());
            }
            $logs = (string)file_get_contents($server->getTempDir() . '/server.log');
            foreach (glob($server->getTempDir() . '/logs/audit/*') ?: [] as $path) {
                if (is_file($path)) $logs .= file_get_contents($path);
            }
            $this->assertFalse(str_contains($logs, $secret));
            foreach ($before as $user) {
                $this->assertFalse(str_contains($logs, $user['password_hash']));
            }
        } finally {
            $db = null;
            $server->stop();
            if (is_file($marker)) unlink($marker);
            unlink($prepend);
        }
    }

    public function testRecoveryCreatesAndMigratesWithoutTrimmingPasswordFile(): void
    {
        $server = new TestServer();
        try {
            $server->start();
            $db = $this->database($server);
            $db->prepare("UPDATE users SET password_hash = ? WHERE username = 'admin'")
                ->execute([password_hash('admin123', PASSWORD_BCRYPT, ['cost' => 4])]);
            $old = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($old->login('admin', 'admin123'));
            $before = $this->credentials($db, 'admin');
            $password = ' ' . str_repeat('あ', 125) . 'い ';
            $passwordFile = $server->getTempDir() . '/recovery-password.txt';
            file_put_contents($passwordFile, $password);
            foreach (['admin', 'recovery-new-admin'] as $username) {
                [$status, $output] = $this->command([PHP_BINARY, dirname(__DIR__, 2) . '/scripts/recover-admin.php',
                    '--db=' . $server->getDbPath(), '--username=' . $username, '--password-file=' . $passwordFile]);
                $this->assertSame(0, $status);
                $this->assertFalse(str_contains($output, $password));
                $credentials = $this->credentials($db, $username);
                $this->assertSame('argon2id', password_get_info($credentials['password_hash'])['algoName']);
                $fresh = new TestHttpClient($server->getBaseUrl());
                $this->assertTrue($fresh->login($username, $password));
                $fresh->get('/api.php?action=load')->assertError(403);
                $this->assertFalse((new TestHttpClient($server->getBaseUrl()))->login($username, trim($password)));
            }
            $this->assertSame((int)$before['password_revision'] + 1, (int)$this->credentials($db, 'admin')['password_revision']);
            $old->get('/api.php?action=load')->assertStatus(401);
        } finally {
            $db = null;
            $server->stop();
        }
    }

    public function testBackupZipRestoreDoesNotRevertMigratedCredentials(): void
    {
        $server = new TestServer();
        try {
            $server->start();
            $db = $this->database($server);
            $db->prepare("UPDATE users SET password_hash = ? WHERE username = 'viewer'")
                ->execute([password_hash('legacy-password', PASSWORD_BCRYPT, ['cost' => 4])]);
            $admin = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($admin->login('admin', 'admin123'));
            $zipPath = $server->getTempDir() . '/legacy-backup.zip';
            file_put_contents($zipPath, $admin->postJson('/api.php?action=export_backup_zip', [])->assertStatus(200)->getBody());
            $zip = new \ZipArchive();
            $this->assertTrue($zip->open($zipPath) === true);
            $document = json_decode((string)$zip->getFromName('data/netarium.json'), true, 512, JSON_THROW_ON_ERROR);
            $this->assertArrayNotHasKey('users', $document['tables']);
            $zip->close();
            $before = $this->credentials($db, 'viewer');
            $admin->postJson('/api.php?action=reset_user_password', [
                'id' => (int)$before['id'], 'password' => 'migrated-password', 'password_confirm' => 'migrated-password',
            ])->assertOk();
            $migrated = $this->credentials($db, 'viewer');
            $preview = $admin->postMultipart('/api.php?action=preview_backup_restore', [],
                ['backup_zip' => ['path' => $zipPath, 'filename' => 'backup.zip', 'type' => 'application/zip']])->assertOk()->getJson();
            $admin->postJson('/api.php?action=commit_backup_restore', [
                'restore_token' => $preview['restore_token'], 'confirmation' => 'バックアップから復元',
            ])->assertOk();
            $this->assertSame($migrated, $this->credentials($db, 'viewer'));
            $fresh = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($fresh->login('viewer', 'migrated-password'));
            $fresh->get('/api.php?action=load')->assertError(403);
            $this->assertFalse((new TestHttpClient($server->getBaseUrl()))->login('viewer', 'legacy-password'));
        } finally {
            $db = null;
            $server->stop();
        }
    }
}
