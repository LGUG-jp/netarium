<?php
declare(strict_types=1);

namespace Netarium\Tests\Suites;

use Netarium\Core\ApiException;
use Netarium\Core\Database;
use Netarium\Services\Auth\InitialSetup;
use Netarium\Tests\TestCase;
use Netarium\Tests\TestHttpClient;
use Netarium\Tests\TestServer;
use PDO;

class InitialSetupTest extends TestCase
{
    private const PASSWORD = 'initial-indigo-lagoon-73';

    private function database(TestServer $server): PDO
    {
        $db = new PDO('sqlite:' . $server->getDbPath());
        Database::configure($db);
        return $db;
    }

    private function token(TestHttpClient $client): string
    {
        $page = $client->get('/setup.php')->assertStatus(200)->getBody();
        $this->assertTrue(preg_match('/name="csrf_token"\s+value="([^"]+)"/', $page, $matches) === 1);
        return $matches[1];
    }

    private function form(string $token, string $secret, string $username = 'setup-owner'): array
    {
        return ['csrf_token' => $token, 'bootstrap_secret' => $secret, 'username' => $username,
            'password' => self::PASSWORD, 'password_confirm' => self::PASSWORD];
    }

    private function assertPending(PDO $db, string $secret): void
    {
        $this->assertSame(0, (int)$db->query('SELECT COUNT(*) FROM users')->fetchColumn());
        $stmt = $db->prepare('SELECT meta_value FROM app_meta WHERE meta_key = ?');
        $stmt->execute([InitialSetup::SECRET_KEY]);
        $this->assertSame(hash('sha256', $secret), $stmt->fetchColumn());
        $stmt->execute([InitialSetup::COMPLETED_KEY]);
        $this->assertSame(false, $stmt->fetchColumn());
    }

    private function assertConsumed(PDO $db): void
    {
        $this->assertSame(1, (int)$db->query("SELECT COUNT(*) FROM users WHERE role = 'admin'")->fetchColumn());
        $this->assertSame(1, (int)$db->query('SELECT COUNT(*) FROM users')->fetchColumn());
        $stmt = $db->prepare('SELECT meta_value FROM app_meta WHERE meta_key = ?');
        $stmt->execute([InitialSetup::SECRET_KEY]);
        $this->assertSame(false, $stmt->fetchColumn());
        $stmt->execute([InitialSetup::COMPLETED_KEY]);
        $this->assertSame('1', $stmt->fetchColumn());
    }

    private function resetUninitializedDatabase(PDO $db): void
    {
        $db->exec('DELETE FROM users');
        $db->exec("DELETE FROM app_meta WHERE meta_key IN ('" . InitialSetup::SECRET_KEY . "', '" . InitialSetup::COMPLETED_KEY . "')");
    }

    public function testSecretRequiredReissueConsumptionAndPermanentClosure(): void
    {
        $server = new TestServer();
        try {
            $server->start();
            $db = $this->database($server);
            $this->resetUninitializedDatabase($db);
            $client = new TestHttpClient($server->getBaseUrl());
            $token = $this->token($client);
            $client->postForm('/setup.php', $this->form($token, ''))->assertStatus(403);
            $this->assertSame(0, (int)$db->query('SELECT COUNT(*) FROM users')->fetchColumn());
            $first = bin2hex(random_bytes(32));
            InitialSetup::issueSecret($db, $first);
            foreach (['', str_repeat('0', 64), strtoupper($first)] as $invalid) {
                $response = $client->postForm('/setup.php', $this->form($token, $invalid))->assertStatus(403);
                if ($invalid !== '') $this->assertFalse(str_contains($response->getBody(), $invalid));
                $this->assertPending($db, $first);
            }
            foreach (['', 'invalid-csrf'] as $invalidToken) {
                $response = $client->postForm('/setup.php', $this->form($invalidToken, $first))->assertStatus(200);
                $this->assertStringContains('画面の有効期限', $response->getBody());
                $this->assertFalse(str_contains($response->getBody(), $first));
                $this->assertPending($db, $first);
            }
            $second = bin2hex(random_bytes(32));
            InitialSetup::issueSecret($db, $second);
            $client->postForm('/setup.php', $this->form($token, $first))->assertStatus(403);
            $this->assertPending($db, $second);
            $response = $client->postForm('/setup.php', $this->form($token, $second))->assertStatus(200);
            $this->assertStringContains('初期管理者を登録しました', $response->getBody());
            $this->assertFalse(str_contains($response->getBody(), $second));
            $this->assertConsumed($db);
            $this->assertTrue($client->login('setup-owner', self::PASSWORD));
            $client->get('/setup.php')->assertStatus(302);
            $client->postForm('/setup.php', $this->form($token, $second))->assertStatus(409);
            try {
                InitialSetup::issueSecret($db, bin2hex(random_bytes(32)));
                $this->fail('完了後の再発行が許可されました');
            } catch (ApiException $e) {
                $this->assertSame(409, $e->getHttpStatus());
            }
            $this->assertConsumed($db);
            $logs = (string)file_get_contents($server->getTempDir() . '/server.log');
            foreach (glob($server->getTempDir() . '/logs/audit/*.log') ?: [] as $path) {
                $logs .= file_get_contents($path);
            }
            $this->assertFalse(str_contains($logs, $first));
            $this->assertFalse(str_contains($logs, $second));
            // usersを失っても完了記録だけで再開を拒否する。
            $db->exec('DELETE FROM users');
            $client->get('/setup.php')->assertStatus(302);
            $client->postForm('/setup.php', $this->form($token, $second))->assertStatus(409);
            try {
                InitialSetup::issueSecret($db, bin2hex(random_bytes(32)));
                $this->fail('完了記録があるDBへの再発行が許可されました');
            } catch (ApiException $e) {
                $this->assertSame(409, $e->getHttpStatus());
            }
        } finally {
            $db = null;
            $server->stop();
        }
    }

    public function testInsertAndAuditFailuresRollbackAndPermitRetry(): void
    {
        $prepend = tempnam(sys_get_temp_dir(), 'netarium-setup-audit-');
        $marker = $prepend . '.mode';
        // 実際のAuditLogを通し、startedは保存し、finishのファイルopenだけ失敗させる。
        file_put_contents($prepend, '<?php namespace Netarium\\Core; '
            . 'function fopen($path, $mode) { static $writes = 0; $failure = @file_get_contents('
            . var_export($marker, true) . '); '
            . 'if ($failure === "begin" && basename($path) === ".lock") return false; '
            . 'if ($mode === "cb" && ++$writes === 2 && $failure === "finish") return false; '
            . 'return \\fopen($path, $mode); }');
        $server = new TestServer(null, $prepend);
        try {
            $server->start();
            $db = $this->database($server);
            $this->resetUninitializedDatabase($db);
            $client = new TestHttpClient($server->getBaseUrl());
            $token = $this->token($client);
            foreach (['insert', 'metadata', 'begin', 'finish'] as $failure) {
                $secret = bin2hex(random_bytes(32));
                InitialSetup::issueSecret($db, $secret);
                if ($failure === 'insert') {
                    $db->exec("CREATE TRIGGER setup_insert_failure BEFORE INSERT ON users BEGIN SELECT RAISE(ABORT, 'fixture insert failure'); END");
                } elseif ($failure === 'metadata') {
                    $db->exec("CREATE TRIGGER setup_meta_failure BEFORE INSERT ON app_meta WHEN NEW.meta_key = 'setup_completed' BEGIN SELECT RAISE(ABORT, 'fixture metadata failure'); END");
                } else {
                    file_put_contents($marker, $failure);
                }
                $response = $client->postForm('/setup.php', $this->form($token, $secret))->assertStatus(503);
                $this->assertFalse(str_contains($response->getBody(), $secret));
                $this->assertPending($db, $secret);
                if ($failure === 'finish') {
                    $entries = [];
                    foreach (glob($server->getTempDir() . '/logs/audit/*.log') ?: [] as $path) {
                        foreach (file($path, FILE_IGNORE_NEW_LINES) as $line) $entries[] = json_decode($line, true);
                    }
                    $last = end($entries);
                    $this->assertSame('setup.create_admin', $last['event']);
                    $this->assertSame('started', $last['outcome']);
                }
                if ($failure === 'insert') $db->exec('DROP TRIGGER setup_insert_failure');
                if ($failure === 'metadata') $db->exec('DROP TRIGGER setup_meta_failure');
                if (is_file($marker)) unlink($marker);
                $client->postForm('/setup.php', $this->form($token, $secret))->assertStatus(200);
                $this->assertConsumed($db);
                // 次の障害も未設定DBから独立して確認する。
                $this->resetUninitializedDatabase($db);
            }
        } finally {
            $db = null;
            $server->stop();
            if (is_file($marker)) unlink($marker);
            unlink($prepend);
        }
    }

    public function testIssuanceRejectsExistingUsersAndRollsBackFailedReissue(): void
    {
        $server = new TestServer();
        try {
            $server->start();
            $db = $this->database($server);
            $before = $db->query('SELECT * FROM users ORDER BY id')->fetchAll();
            try {
                InitialSetup::issueSecret($db, bin2hex(random_bytes(32)));
                $this->fail('既存ユーザーがあるDBへの発行が許可されました');
            } catch (ApiException $e) {
                $this->assertSame(409, $e->getHttpStatus());
            }
            $this->assertSame($before, $db->query('SELECT * FROM users ORDER BY id')->fetchAll());
            $this->resetUninitializedDatabase($db);
            $secret = bin2hex(random_bytes(32));
            InitialSetup::issueSecret($db, $secret);
            try {
                InitialSetup::issueSecret($db, 'invalid');
                $this->fail('不正な秘密が発行されました');
            } catch (ApiException $e) {
                $this->assertSame(403, $e->getHttpStatus());
            }
            $this->assertPending($db, $secret);
            $db->exec("CREATE TRIGGER setup_reissue_failure BEFORE UPDATE ON app_meta WHEN NEW.meta_key = 'setup_bootstrap_sha256' BEGIN SELECT RAISE(ABORT, 'fixture reissue failure'); END");
            try {
                InitialSetup::issueSecret($db, bin2hex(random_bytes(32)));
                $this->fail('DB更新失敗が成功として扱われました');
            } catch (ApiException $e) {
                $this->assertSame(503, $e->getHttpStatus());
            }
            $this->assertPending($db, $secret);
            $db->exec('DROP TRIGGER setup_reissue_failure');
            $client = new TestHttpClient($server->getBaseUrl());
            $client->postForm('/setup.php', $this->form($this->token($client), $secret))->assertStatus(200);
            $this->assertConsumed($db);
        } finally {
            $db = null;
            $server->stop();
        }
    }

    public function testIndependentWorkersAndCookiesCreateOnlyOneAdmin(): void
    {
        $prepend = tempnam(sys_get_temp_dir(), 'netarium-setup-race-');
        // 最初のworkerが書込ロックを保持する間に、別CookieのPOSTを到着させる。
        file_put_contents($prepend, '<?php namespace Netarium\\Services\\Auth; '
            . 'function password_hash($password, $algorithm, $options): string { '
            . 'if (($_SERVER["SCRIPT_NAME"] ?? "") === "/setup.php") usleep(500000); '
            . 'return \\password_hash($password, $algorithm, $options); }');
        $server = new TestServer(null, $prepend);
        $worker = null;
        $multi = curl_multi_init();
        $handles = [];
        $clients = [];
        try {
            $server->start();
            $worker = $server->spawnWorker();
            $db = $this->database($server);
            $this->resetUninitializedDatabase($db);
            $secret = bin2hex(random_bytes(32));
            InitialSetup::issueSecret($db, $secret);
            foreach ([$server, $worker] as $index => $instance) {
                $client = new TestHttpClient($instance->getBaseUrl());
                $clients[] = $client;
                $token = $this->token($client);
                $handle = curl_init($instance->getBaseUrl() . '/setup.php');
                curl_setopt_array($handle, [CURLOPT_POST => true, CURLOPT_RETURNTRANSFER => true,
                    CURLOPT_COOKIEFILE => $client->cookieFile, CURLOPT_TIMEOUT => 20,
                    CURLOPT_HTTPHEADER => ['Content-Type: application/x-www-form-urlencoded'],
                    CURLOPT_POSTFIELDS => http_build_query($this->form($token, $secret, 'parallel-owner-' . $index)),
                ]);
                curl_multi_add_handle($multi, $handle);
                $handles[] = $handle;
            }
            $this->assertNotSame($clients[0]->cookieFile, $clients[1]->cookieFile);
            do {
                $result = curl_multi_exec($multi, $running);
                if ($running) curl_multi_select($multi, 0.1);
            } while ($running && $result === CURLM_OK);
            $statuses = [];
            $successes = 0;
            foreach ($handles as $handle) {
                $this->assertSame(0, curl_errno($handle));
                $statuses[] = curl_getinfo($handle, CURLINFO_HTTP_CODE);
                $body = curl_multi_getcontent($handle);
                if (str_contains($body, '初期管理者を登録しました')) $successes++;
                $this->assertFalse(str_contains($body, $secret));
            }
            sort($statuses);
            $this->assertSame([200, 409], $statuses);
            $this->assertSame(1, $successes);
            $this->assertConsumed($db);
            $username = (string)$db->query('SELECT username FROM users')->fetchColumn();
            $this->assertTrue((new TestHttpClient($server->getBaseUrl()))->login($username, self::PASSWORD));
        } finally {
            foreach ($handles as $handle) curl_multi_remove_handle($multi, $handle);
            curl_multi_close($multi);
            $db = null;
            if ($worker !== null) $worker->stop();
            $server->stop();
            unlink($prepend);
        }
    }

    public function testPreexistingDatabaseWithUsersBackfillsSetupCompletedMarker(): void
    {
        $server = new TestServer();
        try {
            $server->start();
            $db = $this->database($server);
            // シード済みDBから完了マーカーを削除し、本変更前の初期化済みレガシーDBを再現
            $db->exec("DELETE FROM app_meta WHERE meta_key = '" . InitialSetup::COMPLETED_KEY . "'");
            $this->assertSame(false, $db->query("SELECT meta_value FROM app_meta WHERE meta_key = '" . InitialSetup::COMPLETED_KEY . "'")->fetchColumn());
            $this->assertTrue((int)$db->query('SELECT COUNT(*) FROM users')->fetchColumn() > 0);

            // 初期化・マイグレーション時の接続でマーカーがバックフィルされる
            Database::initialize($db);
            $this->assertSame('1', (string)$db->query("SELECT meta_value FROM app_meta WHERE meta_key = '" . InitialSetup::COMPLETED_KEY . "'")->fetchColumn());

            // その後、users行が全消去されても恒久閉鎖が維持される
            $db->exec('DELETE FROM users');
            $this->assertTrue(InitialSetup::isClosed($db));

            $client = new TestHttpClient($server->getBaseUrl());
            $client->get('/setup.php')->assertStatus(302);
            $loginPage = $client->get('/login.php')->assertStatus(200)->getBody();
            $this->assertTrue(preg_match('/name="csrf_token"\s+value="([^"]+)"/', $loginPage, $matches) === 1);
            $token = $matches[1];
            $client->postForm('/setup.php', $this->form($token, 'dummy'))->assertStatus(409);

            try {
                InitialSetup::issueSecret($db, bin2hex(random_bytes(32)));
                $this->fail('バックフィル済みDBでusersが消失しても秘密発行は拒否される必要があります');
            } catch (ApiException $e) {
                $this->assertSame(409, $e->getHttpStatus());
            }
        } finally {
            $db = null;
            $server->stop();
        }
    }
}
