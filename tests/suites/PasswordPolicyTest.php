<?php
declare(strict_types=1);

namespace Netarium\Tests\Suites;

use Netarium\Tests\TestCase;
use Netarium\Tests\TestHttpClient;
use Netarium\Tests\TestServer;
use PDO;

class PasswordPolicyTest extends TestCase
{
    public function __construct(TestHttpClient $client) {}

    private function db(TestServer $server): PDO
    {
        $db = new PDO('sqlite:' . $server->getDbPath());
        $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $db->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        $db->exec('PRAGMA busy_timeout = 10000');
        return $db;
    }

    private function change(TestHttpClient $client, string $current, string $next): \Netarium\Tests\TestResponse
    {
        return $client->postJson('/api.php?action=change_own_password', [
            'current_password' => $current, 'new_password' => $next, 'new_password_confirm' => $next,
        ]);
    }

    public function testForcedChangeForBothRolesAndAdminSelfReset(): void
    {
        $server = new TestServer();
        try {
            $server->start();
            $db = $this->db($server);
            $admin = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($admin->login('admin', 'admin123'));
            $admin->get('/api.php?action=load')->assertOk();
            $this->assertSame(0, (int)$db->query('SELECT SUM(must_change_password) FROM users')->fetchColumn());
            foreach (['viewer', 'admin'] as $role) {
                $username = 'temporary-' . $role;
                $temporary = 'issued-cobalt-forest-17';
                $private = 'private-indigo-river-29';
                $id = (int)$admin->postJson('/api.php?action=create_user', [
                    'username' => $username, 'role' => $role, 'password' => $temporary, 'password_confirm' => $temporary,
                ])->assertOk()->getJson()['user_id'];
                $client = new TestHttpClient($server->getBaseUrl());
                $other = new TestHttpClient($server->getBaseUrl());
                $this->assertTrue($client->login($username, $temporary));
                $this->assertTrue($other->login($username, $temporary));
                $this->assertSame('change-password.php', $client->get('/index.php')->assertStatus(302)->getHeader('Location'));
                $client->get('/change-password.php')->assertStatus(200);
                foreach (['load', 'list_users', 'export_devices_csv', 'export_backup_zip', 'unknown'] as $action) {
                    $response = $client->get('/api.php?action=' . $action)->assertError(403);
                    $this->assertTrue($response->getJson()['password_change_required']);
                }
                foreach (['save', 'save_resources', 'create_user', 'update_user', 'reset_user_password', 'ping'] as $action) {
                    $client->postJson('/api.php?action=' . $action, [])->assertError(403);
                }
                foreach (['upload_floor_plan', 'upload_device_image', 'change_own_password'] as $action) {
                    $client->postJson('/image_upload.php?action=' . $action, [])->assertError(403);
                }
                foreach (['device_image.php?image_id=1', 'floor_plan.php?view_id=1'] as $path) {
                    $this->assertSame('change-password.php', $client->get('/' . $path)->assertStatus(302)->getHeader('Location'));
                }
                $client->postJson('/api.php?action=change_own_password', [
                    'current_password' => $temporary, 'new_password' => $private, 'new_password_confirm' => $private,
                ], ['X-CSRF-Token' => 'invalid'])->assertError(403);
                $this->change($client, $temporary, $temporary)->assertError(400);
                $this->assertSame(1, (int)$db->query('SELECT must_change_password FROM users WHERE id=' . $id)->fetchColumn());
                $this->change($client, $temporary, $private)->assertOk();
                $client->get('/api.php?action=load')->assertStatus(401);
                $other->get('/api.php?action=load')->assertStatus(401);
                $this->assertSame(0, (int)$db->query('SELECT must_change_password FROM users WHERE id=' . $id)->fetchColumn());
                $this->assertTrue($client->login($username, $private));
                $client->get('/api.php?action=load')->assertOk();
                $admin->postJson('/api.php?action=reset_user_password', [
                    'id' => $id, 'password' => $temporary, 'password_confirm' => $temporary,
                ])->assertOk();
                $client->get('/api.php?action=load')->assertStatus(401);
                $this->assertTrue($client->login($username, $temporary));
                $client->get('/api.php?action=load')->assertError(403);
                $client->postForm('/logout.php', ['csrf_token' => $client->getCsrfToken()])->assertStatus(302);
                $client->get('/change-password.php')->assertStatus(302);
            }
            $admin->postJson('/api.php?action=reset_user_password', [
                'id' => 1, 'password' => 'self-issued-amber-47', 'password_confirm' => 'self-issued-amber-47',
            ])->assertOk();
            $admin->get('/api.php?action=load')->assertStatus(401);
            $this->assertTrue($admin->login('admin', 'self-issued-amber-47'));
            $admin->get('/api.php?action=list_users')->assertError(403);
            $page = $admin->get('/change-password.php')->assertStatus(200);
            $this->assertTrue(str_contains($page->getBody(), 'autocomplete="new-password"'));
            $admin->postForm('/change-password.php', [
                'csrf_token' => 'invalid', 'current_password' => 'self-issued-amber-47',
                'new_password' => 'self-private-teal-53', 'new_password_confirm' => 'self-private-teal-53',
            ])->assertStatus(403);
            $admin->postForm('/change-password.php', [
                'csrf_token' => $admin->getCsrfToken(), 'current_password' => 'self-issued-amber-47',
                'new_password' => 'self-private-teal-53', 'new_password_confirm' => 'self-private-teal-53',
            ])->assertStatus(302);
            $this->assertTrue($admin->login('admin', 'self-private-teal-53'));
            $admin->get('/api.php?action=list_users')->assertOk();
        } finally {
            $db = null;
            $server->stop();
        }
    }

    public function testReauthenticationAcrossSessionsExpirySuccessAndAdminRecovery(): void
    {
        $server = new TestServer();
        try {
            $server->start();
            $db = $this->db($server);
            $one = new TestHttpClient($server->getBaseUrl());
            $two = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($one->login('viewer', 'viewer123'));
            $this->assertTrue($two->login('viewer', 'viewer123'));
            $next = 'different-lagoon-secret-39';
            $credentialsSql = 'SELECT password_hash, auth_revision, password_revision, must_change_password FROM users WHERE id=2';
            $before = $db->query($credentialsSql)->fetch();
            for ($i = 0; $i < 5; $i++) {
                $this->change($i % 2 === 0 ? $one : $two, 'wrong-synthetic-value', $next)->assertError(400);
            }
            $this->assertSame(5, (int)$db->query('SELECT failure_count FROM reauthentication_limits WHERE user_id=2')->fetchColumn());
            $fresh = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($fresh->login('viewer', 'viewer123'));
            $this->change($fresh, 'viewer123', $next)->assertError(429);
            $this->assertSame($before, $db->query($credentialsSql)->fetch());
            $db->exec('UPDATE reauthentication_limits SET locked_until=' . (time() - 1) . ' WHERE user_id=2');
            $this->change($fresh, 'wrong-synthetic-value', $next)->assertError(400);
            $this->assertSame(1, (int)$db->query('SELECT failure_count FROM reauthentication_limits WHERE user_id=2')->fetchColumn());
            $this->change($fresh, 'viewer123', $next)->assertOk();
            $this->assertSame(0, (int)$db->query('SELECT COUNT(*) FROM reauthentication_limits WHERE user_id=2')->fetchColumn());
            $one->get('/api.php?action=load')->assertStatus(401);
            $two->get('/api.php?action=load')->assertStatus(401);
            $this->assertTrue($fresh->login('viewer', $next));
            for ($i = 0; $i < 5; $i++) $this->change($fresh, 'wrong-again', 'subsequent-purple-secret')->assertError(400);
            $admin = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($admin->login('admin', 'admin123'));
            $admin->postJson('/api.php?action=reset_user_password', [
                'id' => 2, 'password' => 'reissued-silver-bay-41', 'password_confirm' => 'reissued-silver-bay-41',
            ])->assertOk();
            $this->assertSame(0, (int)$db->query('SELECT COUNT(*) FROM reauthentication_limits WHERE user_id=2')->fetchColumn());
            $this->assertTrue($fresh->login('viewer', 'reissued-silver-bay-41'));
            $this->change($fresh, 'reissued-silver-bay-41', 'private-turquoise-bay-43')->assertOk();
        } finally {
            $db = null;
            $server->stop();
        }
    }

    public function testParallelReauthenticationDoesNotExceedFiveVerifications(): void
    {
        $server = new TestServer();
        $worker = null;
        $multi = curl_multi_init();
        $handles = [];
        $clients = [];
        try {
            $server->start();
            $worker = $server->spawnWorker();
            $db = $this->db($server);
            for ($i = 0; $i < 8; $i++) {
                $url = $i % 2 === 0 ? $server->getBaseUrl() : $worker->getBaseUrl();
                $client = new TestHttpClient($url);
                $this->assertTrue($client->login('viewer', 'viewer123'));
                $clients[] = $client;
                $handle = curl_init($url . '/api.php?action=change_own_password');
                curl_setopt_array($handle, [CURLOPT_POST => true, CURLOPT_RETURNTRANSFER => true,
                    CURLOPT_COOKIEFILE => $client->cookieFile, CURLOPT_TIMEOUT => 20,
                    CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'X-CSRF-Token: ' . $client->getCsrfToken()],
                    CURLOPT_POSTFIELDS => json_encode(['current_password' => 'wrong-parallel-secret',
                        'new_password' => 'parallel-indigo-secret', 'new_password_confirm' => 'parallel-indigo-secret']),
                ]);
                curl_multi_add_handle($multi, $handle);
                $handles[] = $handle;
            }
            do {
                $result = curl_multi_exec($multi, $running);
                if ($running) curl_multi_select($multi, 0.1);
            } while ($running && $result === CURLM_OK);
            $statuses = [];
            foreach ($handles as $handle) {
                $this->assertSame(0, curl_errno($handle));
                $statuses[] = curl_getinfo($handle, CURLINFO_HTTP_CODE);
            }
            sort($statuses);
            $this->assertSame([400, 400, 400, 400, 400, 429, 429, 429], $statuses);
            $this->assertSame(5, (int)$db->query('SELECT failure_count FROM reauthentication_limits WHERE user_id=2')->fetchColumn());
            $clients[0]->get('/api.php?action=load')->assertOk();
        } finally {
            foreach ($handles as $handle) curl_multi_remove_handle($multi, $handle);
            curl_multi_close($multi);
            $db = null;
            if ($worker !== null) $worker->stop();
            $server->stop();
        }
    }

    public function testSettingPolicyMatchesAllPathsWithoutRetroactiveLoginRejection(): void
    {
        $server = new TestServer();
        try {
            $server->start();
            $db = $this->db($server);
            $admin = new TestHttpClient($server->getBaseUrl());
            $viewer = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($admin->login('admin', 'admin123'));
            $this->assertTrue($viewer->login('viewer', 'viewer123'));
            $before = $db->query('SELECT * FROM users ORDER BY id')->fetchAll();
            $weak = 'password123456';
            foreach (['create_user', 'reset_user_password'] as $action) {
                $admin->postJson('/api.php?action=' . $action, [
                    'username' => 'weak-new-user', 'id' => 2, 'password' => $weak, 'password_confirm' => $weak,
                ])->assertError(400);
            }
            $this->change($viewer, 'viewer123', $weak)->assertError(400);
            $file = $server->getTempDir() . '/weak-password.txt';
            file_put_contents($file, $weak);
            $process = proc_open([PHP_BINARY, dirname(__DIR__, 2) . '/scripts/recover-admin.php',
                '--db=' . $server->getDbPath(), '--username=admin', '--password-file=' . $file],
                [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
            fclose($pipes[0]);
            $output = stream_get_contents($pipes[1]) . stream_get_contents($pipes[2]);
            fclose($pipes[1]); fclose($pipes[2]);
            $this->assertSame(1, proc_close($process));
            $this->assertFalse(str_contains($output, $weak));
            $this->assertSame($before, $db->query('SELECT * FROM users ORDER BY id')->fetchAll());
            $db->exec('DELETE FROM users');
            $db->exec("DELETE FROM app_meta WHERE meta_key IN ('setup_bootstrap_sha256', 'setup_completed')");
            $bootstrapSecret = bin2hex(random_bytes(32));
            \Netarium\Services\Auth\InitialSetup::issueSecret($db, $bootstrapSecret);
            $setup = new TestHttpClient($server->getBaseUrl());
            preg_match('/name="csrf_token"\s+value="([^"]+)"/', $setup->get('/setup.php')->getBody(), $matches);
            $setup->postForm('/setup.php', ['csrf_token' => $matches[1], 'username' => 'setup-owner',
                'bootstrap_secret' => $bootstrapSecret,
                'password' => $weak, 'password_confirm' => $weak])->assertStatus(200);
            $this->assertSame(0, (int)$db->query('SELECT COUNT(*) FROM users')->fetchColumn());
            $strong = ' 初期管理者の長い秘密と空白 ';
            $setup->postForm('/setup.php', ['csrf_token' => $matches[1], 'username' => 'setup-owner',
                'bootstrap_secret' => $bootstrapSecret,
                'password' => $strong, 'password_confirm' => $strong])->assertStatus(200);
            $this->assertSame(0, (int)$db->query('SELECT must_change_password FROM users')->fetchColumn());
            $this->assertTrue($setup->login('setup-owner', $strong));
            $setup->get('/api.php?action=load')->assertOk();
        } finally {
            $db = null;
            $server->stop();
        }
    }

    public function testVersionNineMigrationPreservesUsersAndRejectsOldRuntime(): void
    {
        require_once dirname(__DIR__, 2) . '/bootstrap.php';
        $db = new PDO('sqlite::memory:');
        $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $db->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        for ($version = 1; $version <= 9; $version++) {
            ('migrateDatabaseToVersion' . $version)($db);
        }
        $hash = \Netarium\Services\Auth\PasswordHashing::hash('old-owner-lilac-secret');
        $db->prepare("INSERT INTO users(username,password_hash,role,created_at,updated_at) VALUES('old-owner',?,'admin','before','before')")->execute([$hash]);
        $before = $db->query('SELECT * FROM users')->fetch();
        \migrateDatabase($db);
        $after = $db->query('SELECT * FROM users')->fetch();
        $this->assertSame(0, $after['must_change_password']);
        unset($after['must_change_password']);
        $this->assertSame($before, $after);
        // 古いuser_versionを読んだ後続workerも同じ移行関数へ到達し得る。
        \migrateDatabaseToVersion10($db);
        $this->assertSame($before, array_diff_key($db->query('SELECT * FROM users')->fetch(), ['must_change_password' => true]));
        \migrateDatabase($db);
        $this->assertSame(APP_DATABASE_SCHEMA_VERSION, (int)$db->query('PRAGMA user_version')->fetchColumn());
        $db->exec('PRAGMA user_version = ' . (APP_DATABASE_SCHEMA_VERSION + 1));
        try {
            \migrateDatabase($db);
            $this->fail('Future schemas must be rejected');
        } catch (\RuntimeException $e) {
            $this->assertStringContains('バージョン', $e->getMessage());
        }
    }

    public function testVersionTenMigrationFailureRollsBackSchemaAndAllowsRetry(): void
    {
        require_once dirname(__DIR__, 2) . '/bootstrap.php';
        $db = new PDO('sqlite::memory:');
        $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $db->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        for ($version = 1; $version <= 9; $version++) {
            ('migrateDatabaseToVersion' . $version)($db);
        }
        $hash = \Netarium\Services\Auth\PasswordHashing::hash('migration-owner-lilac-secret');
        $db->prepare("INSERT INTO users(username,password_hash,role,created_at,updated_at) VALUES('migration-owner',?,'admin','before','before')")->execute([$hash]);
        // Force failure after ALTER TABLE, without replacing the migration implementation.
        $db->exec('CREATE TABLE reauthentication_limits (marker TEXT NOT NULL)');
        $db->exec("INSERT INTO reauthentication_limits VALUES ('preserved fixture')");
        $schemaBefore = $db->query('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name')->fetchAll();
        $usersBefore = $db->query('SELECT * FROM users ORDER BY id')->fetchAll();
        try {
            \migrateDatabase($db);
            $this->fail('A conflicting table must reject the migration');
        } catch (\PDOException $e) {
            $this->assertStringContains('reauthentication_limits', $e->getMessage());
        }
        $this->assertFalse($db->inTransaction());
        $this->assertSame(9, (int)$db->query('PRAGMA user_version')->fetchColumn());
        $this->assertSame($schemaBefore, $db->query('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name')->fetchAll());
        $this->assertSame($usersBefore, $db->query('SELECT * FROM users ORDER BY id')->fetchAll());
        $this->assertSame(['marker' => 'preserved fixture'], $db->query('SELECT * FROM reauthentication_limits')->fetch());
        $db->exec('DROP TABLE reauthentication_limits');
        \migrateDatabase($db);
        $this->assertSame(APP_DATABASE_SCHEMA_VERSION, (int)$db->query('PRAGMA user_version')->fetchColumn());
        $after = $db->query('SELECT * FROM users ORDER BY id')->fetchAll();
        $this->assertSame(0, $after[0]['must_change_password']);
        unset($after[0]['must_change_password']);
        $this->assertSame($usersBefore, $after);
        $this->assertSame(0, (int)$db->query('SELECT COUNT(*) FROM reauthentication_limits')->fetchColumn());
    }

    public function testRecoveryUsesAdditionalDictionaryOfExplicitDatabase(): void
    {
        $server = new TestServer();
        try {
            $server->start();
            $db = $this->db($server);
            $storage = $server->getTempDir();
            $candidate = 'synthetic-recovery-dictionary-254';
            $data = $candidate . "\n";
            $sha = hash('sha256', $data);
            mkdir($storage . '/password-blocklist', 0700);
            $body = $storage . '/password-blocklist/dictionary-' . $sha . '.txt';
            file_put_contents($body, $data);
            file_put_contents($storage . '/password-blocklist.json', json_encode([
                'format_version' => 1, 'enabled' => true, 'sha256' => $sha,
                'bytes' => strlen($data), 'entries' => 1,
            ]));
            $before = $db->query('SELECT * FROM users ORDER BY id')->fetchAll();
            $file = $storage . '/recovery-input.txt';
            foreach ([$candidate, 'independent-recovery-phrase-254'] as $index => $password) {
                if ($index === 1) {
                    unlink($body);
                }
                file_put_contents($file, $password);
                // 別の親環境設定でも、--dbで指定した配備先の辞書を使う。
                $environment = getenv();
                $environment['NETARIUM_STORAGE_DIR'] = dirname(__DIR__, 2) . '/data';
                $process = proc_open([
                    PHP_BINARY, dirname(__DIR__, 2) . '/scripts/recover-admin.php',
                    '--db=' . $server->getDbPath(), '--username=admin', '--password-file=' . $file,
                ], [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, null, $environment);
                fclose($pipes[0]);
                $output = stream_get_contents($pipes[1]) . stream_get_contents($pipes[2]);
                fclose($pipes[1]);
                fclose($pipes[2]);
                $this->assertSame(1, proc_close($process));
                $this->assertFalse(str_contains($output, $password));
                $this->assertSame($before, $db->query('SELECT * FROM users ORDER BY id')->fetchAll());
            }
            $client = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($client->login('admin', 'admin123'));
            $client->get('/api.php?action=load')->assertOk();
        } finally {
            $db = null;
            $server->stop();
        }
    }
}
