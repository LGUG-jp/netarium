<?php
declare(strict_types=1);

namespace Netarium\Tests\Suites;

use Netarium\Tests\TestCase;
use Netarium\Tests\TestHttpClient;
use Netarium\Tests\TestResponse;

class AuthTest extends TestCase
{
    private TestHttpClient $client;

    public function __construct(TestHttpClient $client)
    {
        $this->client = $client;
    }

    private function submitLoginForm(
        TestHttpClient $client,
        string $username = 'viewer',
        string $password = 'viewer123',
        string $path = '/login.php'
    ): TestResponse {
        $page = $client->get($path);
        $page->assertStatus(200);
        $this->assertSame(1, preg_match('/name="csrf_token"\s+value="([^"]+)"/', $page->getBody(), $matches));
        return $client->postForm($path, [
            'csrf_token' => $matches[1],
            'username' => $username,
            'password' => $password,
        ]);
    }

    public function testDirectLinkLoginReturnsOnlyValidatedIds(): void
    {
        foreach ([
            'view=12' => 'index.php?view=12',
            'device=305' => 'index.php?device=305',
            'device=305&view=12' => 'index.php?view=12&device=305',
            '%76iew=00012&device=000305' => 'index.php?view=12&device=305',
            'view=1&device=9007199254740991' => 'index.php?view=1&device=9007199254740991',
            'view=12&next=https%3A%2F%2Fevil.example&returnUrl=%2F%2Fevil.example&token=secret&name=private&ip=192.0.2.1'
                => 'index.php?view=12',
        ] as $query => $expected) {
            $client = new TestHttpClient($this->client->getBaseUrl());
            $response = $client->get('/index.php?' . $query);
            $response->assertStatus(302);
            $this->assertSame('login.php', $response->getHeader('Location'));
            $client->get('/api.php?action=load')->assertStatus(401);
            $login = $this->submitLoginForm($client);
            $login->assertStatus(302);
            $this->assertSame($expected, $login->getHeader('Location'), $query);
            $client->get('/' . $expected)->assertStatus(200);
            $this->assertSame('index.php', $client->get('/login.php')->getHeader('Location'));
        }
    }

    public function testDirectLinkLoginRejectsMalformedAndDuplicateIds(): void
    {
        foreach ([
            'view=',
            'view=0',
            'view=000',
            'view=-1',
            'view=1.5',
            'view=1e2',
            'view=%2B1',
            'view=%201',
            'view=9007199254740992',
            'view=99999999999999999999999999999999',
            'view=https%3A%2F%2Fevil.example',
            'view=1%0D%0ALocation%3A%20https%3A%2F%2Fevil.example',
            'view=1&view=2',
            'view=1&%76iew=1',
            'view[]=1',
            'view=1&view[x]=2',
            'view=12&device=',
            'view=12&device=0',
            'view=12&device=1e2',
            'view=12&device=9007199254740992',
            'view=12&device=305&device=306',
            'device[]=305',
            'next=https%3A%2F%2Fevil.example&returnUrl=%2F%2Fevil.example',
        ] as $query) {
            $client = new TestHttpClient($this->client->getBaseUrl());
            $response = $client->get('/index.php?' . $query);
            $response->assertStatus(302);
            $this->assertSame('login.php', $response->getHeader('Location'));
            $login = $this->submitLoginForm($client);
            $login->assertStatus(302);
            $this->assertSame('index.php', $login->getHeader('Location'), $query);
        }
    }

    public function testDirectLinkSurvivesFailedLoginWithoutAcceptingNewDestinations(): void
    {
        $client = new TestHttpClient($this->client->getBaseUrl());
        $client->get('/index.php?view=12&device=305')->assertStatus(302);
        $client->postForm('/login.php?view=99&next=https%3A%2F%2Fevil.example', [
            'csrf_token' => 'invalid',
            'username' => 'viewer',
            'password' => 'viewer123',
        ])->assertStatus(200);
        $failed = $this->submitLoginForm($client, 'viewer', 'wrong-password');
        $failed->assertStatus(200);
        $this->assertStringContains('ユーザー名またはパスワードが正しくありません', $failed->getBody());
        $login = $this->submitLoginForm($client, 'viewer', 'viewer123', '/login.php?returnUrl=%2F%2Fevil.example');
        $login->assertStatus(302);
        $this->assertSame('index.php?view=12&device=305', $login->getHeader('Location'));
    }

    public function testNormalLoginAndNonIndexPagesDoNotCreateReturnTargets(): void
    {
        foreach (['viewer' => 'viewer123', 'admin' => 'admin123'] as $username => $password) {
            $client = new TestHttpClient($this->client->getBaseUrl());
            $client->get('/change-password.php?view=12')->assertStatus(302);
            $login = $this->submitLoginForm(
                $client, $username, $password,
                '/login.php?view=99&next=https%3A%2F%2Fevil.example&returnUrl=%2F%2Fevil.example'
            );
            $login->assertStatus(302);
            $this->assertSame('index.php', $login->getHeader('Location'));
        }
        $client = new TestHttpClient($this->client->getBaseUrl());
        $client->get('/index.php?view=12')->assertStatus(302);
        $client->get('/index.php?view=0')->assertStatus(302);
        $this->assertSame('index.php', $this->submitLoginForm($client)->getHeader('Location'));
    }

    public function testDirectLinkDoesNotBypassForcedPasswordChangeAndReturnsAfterRelogin(): void
    {
        foreach (['normal' => '', 'linked' => '?view=12&device=305'] as $suffix => $query) {
            $username = 'issue291' . $suffix;
            $created = $this->client->postJson('/api.php?action=create_user', [
                'username' => $username,
                'password' => 'temporary-orbit-291',
                'password_confirm' => 'temporary-orbit-291',
                'role' => 'viewer',
            ])->assertOk();
            $client = new TestHttpClient($this->client->getBaseUrl());
            $client->get('/index.php' . $query)->assertStatus(302);
            $login = $this->submitLoginForm($client, $username, 'temporary-orbit-291');
            $login->assertStatus(302);
            $this->assertSame('change-password.php', $login->getHeader('Location'));
            $client->get('/api.php?action=load')->assertStatus(403);
            $this->assertSame('change-password.php', $client->get('/login.php')->getHeader('Location'));
            $this->assertSame('change-password.php', $client->get('/index.php' . $query)->getHeader('Location'));
            $client->postForm('/change-password.php', [
                'csrf_token' => 'invalid',
            ])->assertStatus(403);
            $page = $client->get('/change-password.php');
            $page->assertStatus(200);
            $this->assertSame(1, preg_match('/name="csrf_token"\s+value="([^"]+)"/', $page->getBody(), $matches));
            $change = $client->postForm('/change-password.php', [
                'csrf_token' => $matches[1],
                'current_password' => 'temporary-orbit-291',
                'new_password' => 'private-galaxy-291',
                'new_password_confirm' => 'private-galaxy-291',
            ]);
            $change->assertStatus(302);
            $this->assertSame('login.php', $change->getHeader('Location'));
            $client->get('/api.php?action=load')->assertStatus(401);
            $relogin = $this->submitLoginForm($client, $username, 'private-galaxy-291');
            $relogin->assertStatus(302);
            $this->assertSame('index.php' . $query, $relogin->getHeader('Location'));

            // A revoked session is destroyed during refresh. Its replacement
            // must still remember the link, without retaining authentication.
            $this->client->postJson('/api.php?action=update_user', [
                'id' => $created->getJson()['user_id'],
                'role' => 'viewer',
                'is_active' => false,
            ])->assertOk();
            $denied = $client->get('/index.php' . $query);
            $denied->assertStatus(302);
            $this->assertSame('login.php', $denied->getHeader('Location'));
            $client->get('/api.php?action=load')->assertStatus(401);
            $this->client->postJson('/api.php?action=update_user', [
                'id' => $created->getJson()['user_id'],
                'role' => 'viewer',
                'is_active' => true,
            ])->assertOk();
            $restored = $this->submitLoginForm($client, $username, 'private-galaxy-291');
            $restored->assertStatus(302);
            $this->assertSame('index.php' . $query, $restored->getHeader('Location'));
        }
    }

    public function testSessionStorageOverridesPhpDefaultAndSurvivesAnotherProcess(): void
    {
        $server = new \Netarium\Tests\TestServer();
        try {
            $server->start();
            $storage = $server->getTempDir() . '/isolated-storage';
            $common = $server->getTempDir() . '/php-common';
            mkdir($common, 0700);
            [$status, $output] = $this->sessionCommand($storage, $common, '
                startAppSession();
                $_SESSION["user_id"] = 42;
                $_SESSION["authenticated_at"] = time();
                $_SESSION["last_activity"] = time();
                $_SESSION["csrf_token"] = "session-round-trip";
                $id = session_id();
                startAppSession();
                session_write_close();
                echo json_encode(["id" => $id], JSON_THROW_ON_ERROR);
            ');
            $this->assertSame(0, $status, $output);
            $id = json_decode($output, true, 512, JSON_THROW_ON_ERROR)['id'];
            $this->assertTrue(is_file($storage . '/sessions/sess_' . $id));
            $this->assertSame([], glob($common . '/sess_*'));
            if (PHP_OS_FAMILY !== 'Windows') {
                $this->assertSame(0700, fileperms($storage . '/sessions') & 0777);
            }
            [$status, $output] = $this->sessionCommand($storage, $common, '
                session_id($argv[3]);
                startAppSession();
                $result = [currentUserId(), getCsrfToken(), session_id()];
                session_write_close();
                echo json_encode($result, JSON_THROW_ON_ERROR);
            ', $id);
            $this->assertSame(0, $status, $output);
            $this->assertSame([42, 'session-round-trip', $id],
                json_decode($output, true, 512, JSON_THROW_ON_ERROR));
            $this->assertSame([], glob($common . '/sess_*'));
        } finally {
            $server->stop();
        }
    }

    public function testPhpCommonSessionDoesNotAuthenticateAfterStorageSwitch(): void
    {
        $server = new \Netarium\Tests\TestServer();
        try {
            $server->start();
            $storage = $server->getTempDir() . '/isolated-storage';
            $common = $server->getTempDir() . '/php-common';
            mkdir($common, 0700);
            $legacyId = bin2hex(random_bytes(16));
            $legacyData = 'user_id|i:42;authenticated_at|i:' . time()
                . ';last_activity|i:' . time() . ';csrf_token|s:13:"legacy-secret";';
            $legacyFile = $common . '/sess_' . $legacyId;
            file_put_contents($legacyFile, $legacyData);
            [$status, $output] = $this->sessionCommand($storage, $common, '
                session_id($argv[3]);
                startAppSession();
                $result = [currentUserId(), $_SESSION["csrf_token"] ?? null, session_id()];
                session_write_close();
                echo json_encode($result, JSON_THROW_ON_ERROR);
            ', $legacyId);
            $this->assertSame(0, $status, $output);
            [$userId, $csrfToken, $newId] = json_decode($output, true, 512, JSON_THROW_ON_ERROR);
            $this->assertSame(0, $userId);
            $this->assertSame(null, $csrfToken);
            $this->assertNotSame($legacyId, $newId);
            $this->assertTrue(is_file($storage . '/sessions/sess_' . $newId));
            $this->assertSame($legacyData, file_get_contents($legacyFile));

            [$status, $output] = $this->sessionCommand($storage, $common, '
                session_id($argv[3]);
                session_start();
                $_SESSION["csrf_token"] = "must-not-be-written";
                try {
                    startAppSession();
                    echo "unexpected success";
                    exit(1);
                } catch (RuntimeException $e) {
                    echo json_encode([session_status()], JSON_THROW_ON_ERROR);
                }
            ', $legacyId);
            $this->assertSame(0, $status, $output);
            $this->assertSame([PHP_SESSION_NONE],
                json_decode($output, true, 512, JSON_THROW_ON_ERROR));
            $this->assertSame($legacyData, file_get_contents($legacyFile));
        } finally {
            $server->stop();
        }
    }

    public function testSessionStorageFailureDoesNotFallBackOrExposeSecrets(): void
    {
        $server = new \Netarium\Tests\TestServer();
        try {
            $server->start();
            $storage = $server->getTempDir() . '/isolated-storage';
            $common = $server->getTempDir() . '/php-common';
            mkdir($storage, 0700);
            mkdir($common, 0700);
            file_put_contents($storage . '/sessions', 'not-a-directory');
            [$status, $output] = $this->sessionCommand($storage, $common, '
                try {
                    startAppSession();
                    echo "unexpected success";
                    exit(1);
                } catch (RuntimeException $e) {
                    echo json_encode([session_status()], JSON_THROW_ON_ERROR);
                }
            ');
            $this->assertSame(0, $status, $output);
            $this->assertSame([PHP_SESSION_NONE],
                json_decode($output, true, 512, JSON_THROW_ON_ERROR));
            $this->assertSame([], glob($common . '/sess_*'));

            unlink($storage . '/sessions');
            [$status, $output] = $this->sessionCommand($storage, $common, '
                echo "headers-sent\n";
                try {
                    startAppSession();
                    echo "unexpected success";
                    exit(1);
                } catch (RuntimeException $e) {
                    echo json_encode([session_status()], JSON_THROW_ON_ERROR);
                }
            ');
            $this->assertSame(0, $status, $output);
            $this->assertSame("headers-sent\n" . json_encode(
                [PHP_SESSION_NONE],
                JSON_THROW_ON_ERROR
            ), $output);
            $this->assertSame([], glob($storage . '/sessions/sess_*'));
            $this->assertSame([], glob($common . '/sess_*'));
            if (PHP_OS_FAMILY !== 'Windows') {
                $leakyStorage = $server->getTempDir() . '/leaky-storage';
                mkdir($leakyStorage . '/sessions', 0777, true);
                chmod($leakyStorage . '/sessions', 0777);
                [$status, $output] = $this->sessionCommand($leakyStorage, $common, '
                    startAppSession();
                    echo "success";
                ');
                $this->assertSame(0, $status, $output);
                $this->assertSame(0700, fileperms($leakyStorage . '/sessions') & 0777);
            }
        } finally {
            $server->stop();
        }
    }

    public function testAuthenticatedSessionIsSharedAcrossWorkers(): void
    {
        $server = new \Netarium\Tests\TestServer();
        $worker = null;
        try {
            $server->start();
            $client = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($client->login('admin', 'admin123'));
            $before = $client->get('/api.php?action=load')->assertOk()->getJson();
            $worker = $server->spawnWorker();
            $workerClient = new TestHttpClient($worker->getBaseUrl());
            copy($client->cookieFile, $workerClient->cookieFile);
            $this->assertSame($before,
                $workerClient->get('/api.php?action=load')->assertOk()->getJson());
            $this->assertSame($before,
                $client->get('/api.php?action=load')->assertOk()->getJson());
        } finally {
            $worker?->stop();
            $server->stop();
        }
    }

    private function sessionCommand(
        string $storage,
        string $common,
        string $script,
        string $sessionId = ''
    ): array {
        $process = proc_open([
            PHP_BINARY, '-d', 'session.auto_start=0',
            '-d', 'session.save_handler=files', '-d', 'session.save_path=' . $common,
            '-d', 'output_buffering=0', '-d', 'display_errors=1',
            '-r', 'putenv("NETARIUM_STORAGE_DIR=" . $argv[2]); require $argv[1]; ' . $script,
            dirname(__DIR__, 2) . '/bootstrap.php', $storage, $sessionId,
        ], [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
        $this->assertTrue(is_resource($process));
        fclose($pipes[0]);
        $output = stream_get_contents($pipes[1]) . stream_get_contents($pipes[2]);
        fclose($pipes[1]);
        fclose($pipes[2]);
        return [proc_close($process), $output];
    }

    public function testCompletedSetupAllowsAuthenticatedReadsDuringWriterLock(): void
    {
        $server = new \Netarium\Tests\TestServer();
        $db = null;
        try {
            $server->start();
            $client = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($client->login('admin', 'admin123'));
            $before = $client->get('/api.php?action=load')->assertOk()->getJson();
            $db = new \PDO('sqlite:' . $server->getDbPath());
            $db->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
            $this->assertSame('1', $db->query("SELECT meta_value FROM app_meta WHERE meta_key = 'setup_completed'")->fetchColumn());
            $db->beginTransaction();
            $db->exec('UPDATE devices SET memo = memo WHERE id = 1');
            $during = $client->get('/api.php?action=load')->assertOk()->getJson();
            $this->assertSame($before, $during);
            $client->get('/index.php')->assertStatus(200);
            $db->rollBack();
            $this->assertSame($before, $client->get('/api.php?action=load')->assertOk()->getJson());
        } finally {
            if ($db?->inTransaction()) $db->rollBack();
            $db = null;
            $server->stop();
        }
    }

    public function testAuthenticationBusyRejectsRequestsWithoutEndingSession(): void
    {
        $server = new \Netarium\Tests\TestServer();
        $db = null;
        $locked = false;
        try {
            $server->start();
            $client = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($client->login('admin', 'admin123'));
            $before = $client->get('/api.php?action=load')->assertOk()->getJson();
            $db = new \PDO('sqlite:' . $server->getDbPath());
            $db->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
            foreach (['/api.php?action=save_resources', '/index.php', '/login.php'] as $path) {
                $db->exec('BEGIN EXCLUSIVE');
                $locked = true;
                $response = str_starts_with($path, '/api.php')
                    ? $client->postJson($path, ['devices' => [], 'views' => []])
                    : $client->get($path);
                $response->assertStatus(503);
                $this->assertSame(null, $response->getHeader('Location'));
                if (str_starts_with($path, '/api.php')) {
                    $this->assertFalse($response->getJson()['login_required'] ?? false);
                }
                $db->exec('ROLLBACK');
                $locked = false;
                $this->assertSame($before, $client->get('/api.php?action=load')->assertOk()->getJson());
            }
            // The original cookie and CSRF token must still authorize a write.
            $device = $before['devices'][0];
            $device['memo'] = '認証busy解除後の同じセッションから保存';
            $client->postJson('/api.php?action=save_resources', [
                'devices' => [['operation' => 'update', 'id' => (int)$device['id'],
                    'expected_revision' => (int)$device['resource_revision'], 'device' => $device]],
                'views' => [],
            ])->assertOk();
            $after = $client->get('/api.php?action=load')->assertOk()->getJson();
            $this->assertSame($device['memo'], $after['devices'][0]['memo']);
        } finally {
            if ($locked) $db->exec('ROLLBACK');
            $db = null;
            $server->stop();
        }
    }

    public function testUnauthenticatedAccessFails(): void
    {
        $unauthClient = new TestHttpClient($this->client->getBaseUrl());

        // 1. GET load without auth
        $res = $unauthClient->get('/api.php?action=load');
        $res->assertStatus(401);
        $json = $res->getJson();
        $this->assertFalse($json['ok']);
        $this->assertTrue($json['login_required']);
        $this->assertStringContains('認証が必要です', $json['error']);

        // 2. POST save without auth
        $resPost = $unauthClient->postJson('/api.php?action=save', ['revision' => 1]);
        $resPost->assertStatus(401);
        $jsonPost = $resPost->getJson();
        $this->assertFalse($jsonPost['ok']);
        $this->assertTrue($jsonPost['login_required']);

        foreach (['upload_floor_plan', 'upload_device_image'] as $action) {
            $response = $unauthClient->postJson("/image_upload.php?action={$action}", []);
            $response->assertStatus(401);
            $this->assertTrue($response->getJson()['login_required']);
        }
    }

    public function testSeededSetupRedirectsToLogin(): void
    {
        $response = $this->client->get('/setup.php');

        $response->assertStatus(302);
        $this->assertSame(
            'login.php',
            $response->getHeader('Location'),
            'Seeded installations must redirect setup.php to login.php'
        );
    }

    public function testViewerRolePermissions(): void
    {
        $viewerClient = new TestHttpClient($this->client->getBaseUrl());
        $loginOk = $viewerClient->login('viewer', 'viewer123');
        $this->assertTrue($loginOk, 'Viewer login should succeed');

        // 1. Viewer can read (load)
        $resLoad = $viewerClient->get('/api.php?action=load');
        $resLoad->assertOk();
        $jsonLoad = $resLoad->getJson();
        $this->assertSame('viewer', $jsonLoad['user']['role']);
        $this->assertFalse($jsonLoad['user']['is_admin']);

        // 2. Viewer cannot execute admin actions
        $adminActions = [
            ['method' => 'GET', 'action' => 'list_users', 'data' => null],
            ['method' => 'POST', 'action' => 'create_user', 'data' => []],
            ['method' => 'POST', 'action' => 'update_user', 'data' => []],
            ['method' => 'POST', 'action' => 'reset_user_password', 'data' => []],
            ['method' => 'POST', 'action' => 'save', 'data' => ['revision' => 1, 'views' => [], 'devices' => [], 'placements' => [], 'links' => []]],
            ['method' => 'GET', 'action' => 'data_quality', 'data' => null],
            ['method' => 'GET', 'action' => 'export_devices_csv', 'data' => null],
            ['method' => 'GET', 'action' => 'download_devices_csv_template', 'data' => null],
            ['method' => 'POST', 'action' => 'upload_floor_plan', 'data' => []],
            ['method' => 'POST', 'action' => 'upload_device_image', 'data' => []],
            ['method' => 'POST', 'action' => 'delete_floor_plan', 'data' => []],
            ['method' => 'POST', 'action' => 'update_floor_plan_settings', 'data' => []],
            ['method' => 'POST', 'action' => 'export_backup_zip', 'data' => []],
            ['method' => 'POST', 'action' => 'preview_backup_restore', 'data' => []],
            ['method' => 'POST', 'action' => 'commit_backup_restore', 'data' => []],
            ['method' => 'POST', 'action' => 'ping', 'data' => ['revision' => (int)$jsonLoad['revision'], 'targets' => [['id' => 3, 'ip' => '127.0.0.1']]]],
        ];

        foreach ($adminActions as $act) {
            $endpoint = in_array($act['action'], ['upload_floor_plan', 'upload_device_image'], true)
                ? '/image_upload.php' : '/api.php';
            if ($act['method'] === 'GET') {
                $res = $viewerClient->get("{$endpoint}?action={$act['action']}");
            } else {
                $res = $viewerClient->postJson("{$endpoint}?action={$act['action']}", $act['data'] ?? []);
            }

            $res->assertStatus(403);
            $json = $res->getJson();
            $this->assertFalse($json['ok'], "Action {$act['action']} should fail for viewer");
            $this->assertStringContains('この操作を実行する権限がありません', $json['error']);
        }
        $after = $viewerClient->get('/api.php?action=load');
        $after->assertOk();
        $this->assertSame($jsonLoad['monitor_revision'], $after->getJson()['monitor_revision']);
        $this->assertSame($jsonLoad['devices'], $after->getJson()['devices']);
    }

    public function testCsrfProtectionOnPost(): void
    {
        $adminClient = new TestHttpClient($this->client->getBaseUrl());
        $adminClient->login('admin', 'admin123');

        // Intentionally clear or corrupt CSRF token
        $res = $adminClient->request('POST', '/api.php?action=save', json_encode(['revision' => 1]), [
            'Content-Type' => 'application/json',
            'X-CSRF-Token' => 'invalid_csrf_token_value',
        ]);

        $res->assertStatus(403);
        $json = $res->getJson();
        $this->assertFalse($json['ok']);
        $this->assertStringContains('セキュリティトークンが無効です', $json['error']);

        foreach (['upload_floor_plan', 'upload_device_image'] as $action) {
            foreach (['', 'invalid_csrf_token_value'] as $token) {
                $response = $adminClient->request('POST', "/image_upload.php?action={$action}", '', [
                    'Content-Type' => 'multipart/form-data; boundary=csrf-test',
                    'X-CSRF-Token' => $token,
                ]);
                $response->assertStatus(403);
                $this->assertStringContains('セキュリティトークンが無効です', $response->getJson()['error']);
            }
        }
    }

    public function testUnknownActionReturns404(): void
    {
        $adminClient = new TestHttpClient($this->client->getBaseUrl());
        $adminClient->login('admin', 'admin123');

        $res = $adminClient->get('/api.php?action=non_existent_action_xyz');
        $res->assertStatus(404);
        $json = $res->getJson();
        $this->assertFalse($json['ok']);
        $this->assertStringContains('不明なactionです', $json['error']);
    }

    public function testImageUploadEndpointRejectsUnrelatedActionsAndOldRoutes(): void
    {
        $adminClient = new TestHttpClient($this->client->getBaseUrl());
        $this->assertTrue($adminClient->login('admin', 'admin123'));
        foreach (['upload_floor_plan', 'upload_device_image'] as $action) {
            $response = $adminClient->postJson("/api.php?action={$action}", []);
            $response->assertStatus(404);
            $this->assertStringContains('不明なactionです', $response->getJson()['error']);
        }
        foreach (['load', 'save', 'preview_backup_restore', 'non_existent_action_xyz'] as $action) {
            $response = $adminClient->postJson("/image_upload.php?action={$action}", []);
            $response->assertStatus(404);
            $this->assertStringContains('不明なactionです', $response->getJson()['error']);
        }
    }

    public function testImageUploadRequestCapacityIsRejectedBeforeActionValidation(): void
    {
        $adminClient = new TestHttpClient($this->client->getBaseUrl());
        $adminClient->setTimeout(120);
        $this->assertTrue($adminClient->login('admin', 'admin123'));
        foreach (['upload_floor_plan', 'upload_device_image'] as $action) {
            $adminClient->request('POST', "/image_upload.php?action={$action}",
                str_repeat('x', 31 * 1024 * 1024), [
                    'Content-Type' => 'application/octet-stream',
                    'X-CSRF-Token' => '',
                ])->assertStatus(403);
            $response = $adminClient->request('POST', "/image_upload.php?action={$action}",
                str_repeat('x', 31 * 1024 * 1024 + 1), [
                    'Content-Type' => 'application/octet-stream',
                    'X-CSRF-Token' => '',
                ]);
            $response->assertError(413);
        }
    }

    public function testDatabaseIsolationFromParentEnvironment(): void
    {
        // Set a dummy NETARIUM_DB_FILE in parent process environment
        $dummyDbFile = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'netarium_dummy_parent_' . uniqid() . '.sqlite';
        putenv("NETARIUM_DB_FILE={$dummyDbFile}");

        $isolatedServer = new \Netarium\Tests\TestServer();
        try {
            $isolatedServer->start();

            // Client against this isolated server
            $isoClient = new TestHttpClient($isolatedServer->getBaseUrl());
            $loginOk = $isoClient->login('admin', 'admin123');
            $this->assertTrue($loginOk, 'Isolated server login should succeed with seeded DB');

            $loadRes = $isoClient->get('/api.php?action=load');
            $loadRes->assertOk();
            $this->assertTrue($loadRes->getJson()['ok']);

            // Verify parent-specified dummy DB was NEVER created or touched
            $this->assertFalse(file_exists($dummyDbFile), 'Parent environment NETARIUM_DB_FILE must NOT be created or written to');
        } finally {
            $isolatedServer->stop();
            putenv('NETARIUM_DB_FILE'); // unset environment variable
            if (file_exists($dummyDbFile)) {
                @unlink($dummyDbFile);
            }
        }
    }

    public function testUserManagementAndSessionRevocation(): void
    {
        $adminClient = new TestHttpClient($this->client->getBaseUrl());
        $adminClient->login('admin', 'admin123');

        $create = $adminClient->postJson('/api.php?action=create_user', [
            'username' => 'issue27viewer',
            'password' => 'temporary-moon-27',
            'password_confirm' => 'temporary-moon-27',
            'role' => 'viewer',
        ]);
        $create->assertOk();

        $list = $adminClient->get('/api.php?action=list_users');
        $list->assertOk();
        $users = $list->getJson()['users'];
        $target = array_values(array_filter(
            $users,
            static fn(array $user): bool => $user['username'] === 'issue27viewer'
        ))[0] ?? null;
        $this->assertTrue(is_array($target), 'Created user should be listed');
        $targetId = (int)$target['id'];

        $viewerClient = new TestHttpClient($this->client->getBaseUrl());
        $this->assertTrue(
            $viewerClient->login('issue27viewer', 'temporary-moon-27'),
            'Created viewer should login'
        );
        $viewerClient->postJson('/api.php?action=change_own_password', [
            'current_password' => 'temporary-moon-27',
            'new_password' => 'private-planet-27',
            'new_password_confirm' => 'private-planet-27',
        ])->assertOk();
        $this->assertTrue($viewerClient->login('issue27viewer', 'private-planet-27'));
        $viewerClient->get('/api.php?action=load')->assertOk();

        $promote = $adminClient->postJson('/api.php?action=update_user', [
            'id' => $targetId,
            'role' => 'admin',
            'is_active' => true,
        ]);
        $promote->assertOk();

        $promotedLoad = $viewerClient->get('/api.php?action=load');
        $promotedLoad->assertOk();
        $this->assertSame('admin', $promotedLoad->getJson()['user']['role']);

        $selfDisablePrep = $adminClient->postJson('/api.php?action=update_user', [
            'id' => $targetId,
            'role' => 'admin',
            'is_active' => true,
        ]);
        $selfDisablePrep->assertOk();

        $targetAdminClient = new TestHttpClient($this->client->getBaseUrl());
        $this->assertTrue(
            $targetAdminClient->login('issue27viewer', 'private-planet-27'),
            'Promoted admin should login'
        );
        $selfDisable = $targetAdminClient->postJson('/api.php?action=update_user', [
            'id' => $targetId,
            'role' => 'admin',
            'is_active' => false,
        ]);
        $selfDisable->assertOk();
        $this->assertTrue($selfDisable->getJson()['session_ended']);
        $loginPage = $targetAdminClient->get('/login.php');
        $loginPage->assertStatus(200);
        $targetAdminClient->get('/api.php?action=load')->assertStatus(401);

        $disable = $adminClient->postJson('/api.php?action=update_user', [
            'id' => $targetId,
            'role' => 'admin',
            'is_active' => false,
        ]);
        $disable->assertOk();
        $viewerClient->get('/api.php?action=load')->assertStatus(401);

        $reenable = $adminClient->postJson('/api.php?action=update_user', [
            'id' => $targetId,
            'role' => 'viewer',
            'is_active' => true,
        ]);
        $reenable->assertOk();

        $lastAdmin = $adminClient->get('/api.php?action=load')->getJson()['user'];
        $demoteLastAdmin = $adminClient->postJson('/api.php?action=update_user', [
            'id' => (int)$lastAdmin['id'],
            'role' => 'viewer',
            'is_active' => true,
        ]);
        $demoteLastAdmin->assertStatus(409);
        $this->assertStringContains(
            '最後の有効なadmin',
            $demoteLastAdmin->getJson()['error']
        );

        $freshViewerClient = new TestHttpClient($this->client->getBaseUrl());
        $this->assertTrue(
            $freshViewerClient->login('issue27viewer', 'private-planet-27'),
            'Re-enabled viewer should login'
        );

        $reset = $adminClient->postJson('/api.php?action=reset_user_password', [
            'id' => $targetId,
            'password' => 'issue27reset123',
            'password_confirm' => 'issue27reset123',
        ]);
        $reset->assertOk();
        $freshViewerClient->get('/api.php?action=load')->assertStatus(401);
    }

    public function testOwnPasswordChangeInvalidatesSession(): void
    {
        $adminClient = new TestHttpClient($this->client->getBaseUrl());
        $adminClient->login('admin', 'admin123');

        $adminClient->postJson('/api.php?action=create_user', [
            'username' => 'issue27password',
            'password' => 'temporary-orbit-27',
            'password_confirm' => 'temporary-orbit-27',
            'role' => 'viewer',
        ])->assertOk();

        $passwordClient = new TestHttpClient($this->client->getBaseUrl());
        $this->assertTrue(
            $passwordClient->login('issue27password', 'temporary-orbit-27'),
            'Password test user should login'
        );

        $changed = $passwordClient->postJson('/api.php?action=change_own_password', [
            'current_password' => 'temporary-orbit-27',
            'new_password' => 'issue27newpassword123',
            'new_password_confirm' => 'issue27newpassword123',
        ]);
        $changed->assertOk();
        $passwordClient->get('/api.php?action=load')->assertStatus(401);

        $newPasswordClient = new TestHttpClient($this->client->getBaseUrl());
        $this->assertTrue(
            $newPasswordClient->login('issue27password', 'issue27newpassword123'),
            'Changed password should work for a new session'
        );
    }

    public function testUserCreationUsesUnicodePasswordBoundaries(): void
    {
        $adminClient = new TestHttpClient($this->client->getBaseUrl());
        $this->assertTrue($adminClient->login('admin', 'admin123'));

        $cases = [
            [str_repeat('a', 10) . 'b', false],
            [str_repeat('a', 11) . 'b', true],
            [str_repeat('a', 12) . 'b', true],
            [str_repeat('あ', 10) . 'い', false],
            [str_repeat('あ', 11) . 'い', true],
            [str_repeat('😀', 10) . '😃', false],
            [str_repeat('😀', 11) . '😃', true],
            [str_repeat("e\u{0301}", 5) . 'e', false],
            [str_repeat("e\u{0301}", 5) . 'ef', true],
            [' !@#$%^&*() ', true],
            [str_repeat('a', 70) . 'b', true],
            [str_repeat('a', 71) . 'b', true],
            [str_repeat('a', 72) . 'b', true],
            [str_repeat('あ', 23) . 'い', true],
            [str_repeat('あ', 24) . 'a', true],
            [str_repeat('a', 127) . 'b', true],
            [str_repeat('a', 128) . 'b', false],
            [str_repeat('あ', 127) . 'い', true],
            [str_repeat('あ', 128) . 'い', false],
            [str_repeat('😀', 127) . 'abcde', false],
            [str_repeat('😀', 127) . '😃', true],
            [str_repeat('😀', 128) . 'a', false],
            [str_repeat('a', 12) . "\0", false],
        ];
        foreach ($cases as $index => [$password, $accepted]) {
            $username = 'issue132unicode' . $index;
            $created = $adminClient->postJson('/api.php?action=create_user', [
                'username' => $username,
                'password' => $password,
                'password_confirm' => $password,
                'role' => 'viewer',
            ]);
            if ($accepted) {
                $created->assertOk();
                $viewerClient = new TestHttpClient($this->client->getBaseUrl());
                $this->assertTrue($viewerClient->login($username, $password));
                $viewerClient->get('/api.php?action=load')->assertError(403);
            } else {
                $created->assertError(400);
                $users = $adminClient->get('/api.php?action=list_users')->getJson()['users'];
                $this->assertFalse(in_array($username, array_column($users, 'username'), true));
            }
        }
    }

    public function testPasswordPolicyRejectionPreservesCredentialsAndSessions(): void
    {
        $adminClient = new TestHttpClient($this->client->getBaseUrl());
        $this->assertTrue($adminClient->login('admin', 'admin123'));
        $username = 'issue132transitions';
        $original = ' issue132!  ';
        $adminClient->postJson('/api.php?action=create_user', [
            'username' => $username,
            'password' => $original,
            'password_confirm' => $original,
            'role' => 'viewer',
        ])->assertOk();
        $users = $adminClient->get('/api.php?action=list_users')->getJson()['users'];
        $id = (int)array_values(array_filter(
            $users,
            static fn(array $user): bool => $user['username'] === $username
        ))[0]['id'];
        $viewerClient = new TestHttpClient($this->client->getBaseUrl());
        $this->assertTrue($viewerClient->login($username, $original));
        $viewerClient->postJson('/api.php?action=change_own_password', [
            'current_password' => $original,
            'new_password' => '本人だけの別の長い秘密です',
            'new_password_confirm' => '本人だけの別の長い秘密です',
        ])->assertOk();
        $original = '本人だけの別の長い秘密です';
        $this->assertTrue($viewerClient->login($username, $original));

        foreach ([
            str_repeat('あ', 11), str_repeat('a', 129), str_repeat('😀', 128) . 'a', str_repeat('a', 12) . "\0",
            'Telechargement', 'startfinding', 'STARTFINDING', 'q1w2e3r4t5y6',
        ] as $invalid) {
            $adminClient->postJson('/api.php?action=reset_user_password', [
                'id' => $id,
                'password' => $invalid,
                'password_confirm' => $invalid,
            ])->assertError(400);
            $viewerClient->postJson('/api.php?action=change_own_password', [
                'current_password' => $original,
                'new_password' => $invalid,
                'new_password_confirm' => $invalid,
            ])->assertError(400);
            $viewerClient->get('/api.php?action=load')->assertOk();
            $freshClient = new TestHttpClient($this->client->getBaseUrl());
            $this->assertTrue($freshClient->login($username, $original));
        }

        $changed = '新しく設定した日本語の秘密です';
        $viewerClient->postJson('/api.php?action=change_own_password', [
            'current_password' => $original,
            'new_password' => $changed,
            'new_password_confirm' => $changed,
        ])->assertOk();
        $viewerClient->get('/api.php?action=load')->assertStatus(401);
        $freshClient->get('/api.php?action=load')->assertStatus(401);
        $this->assertFalse((new TestHttpClient($this->client->getBaseUrl()))->login($username, $original));
        $changedClient = new TestHttpClient($this->client->getBaseUrl());
        $this->assertTrue($changedClient->login($username, $changed));
        $changedClient->get('/api.php?action=load')->assertOk();

        $reset = str_repeat('😀', 17) . '😃';
        $adminClient->postJson('/api.php?action=reset_user_password', [
            'id' => $id,
            'password' => $reset,
            'password_confirm' => $reset,
        ])->assertOk();
        $changedClient->get('/api.php?action=load')->assertStatus(401);
        $this->assertFalse((new TestHttpClient($this->client->getBaseUrl()))->login($username, $changed));
        $resetClient = new TestHttpClient($this->client->getBaseUrl());
        $this->assertTrue($resetClient->login($username, $reset));
        $resetClient->get('/api.php?action=load')->assertError(403);
    }

    public function testLoginRateLimitPersistsAcrossSessions(): void
    {
        $adminClient = new TestHttpClient($this->client->getBaseUrl());
        $adminClient->login('admin', 'admin123');

        $adminClient->postJson('/api.php?action=create_user', [
            'username' => 'issue27lock',
            'password' => 'temporary-lock-27',
            'password_confirm' => 'temporary-lock-27',
            'role' => 'viewer',
        ])->assertOk();

        for ($attempt = 0; $attempt < 5; $attempt++) {
            $failedClient = new TestHttpClient($this->client->getBaseUrl());
            $this->assertFalse(
                $failedClient->login('issue27lock', 'wrong-password'),
                'Invalid login should fail'
            );
        }

        $lockedClient = new TestHttpClient($this->client->getBaseUrl());
        $this->assertFalse(
            $lockedClient->login('issue27lock', 'temporary-lock-27'),
            'Rate limit should remain after changing sessions'
        );
    }
}
