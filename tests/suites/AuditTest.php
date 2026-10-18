<?php
declare(strict_types=1);

namespace Netarium\Tests\Suites;

use DateInterval;
use DateTimeImmutable;
use DateTimeZone;
use Netarium\Core\ApiException;
use Netarium\Core\AuditLog;
use Netarium\Tests\TestCase;
use Netarium\Tests\TestHttpClient;
use Netarium\Tests\TestServer;
use PDO;
use Throwable;
use ZipArchive;

class AuditTest extends TestCase
{
    private TestHttpClient $client;

    public function __construct(TestHttpClient $client)
    {
        $this->client = $client;
    }

    private function readAuditEntries(string $auditDir): array
    {
        if (!is_dir($auditDir)) {
            return [];
        }

        $files = scandir($auditDir);
        if ($files === false) {
            return [];
        }

        $entries = [];
        sort($files);
        foreach ($files as $file) {
            if (preg_match(AuditLog::FILENAME_PATTERN, $file) === 1) {
                $path = $auditDir . DIRECTORY_SEPARATOR . $file;
                $lines = file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
                if (is_array($lines)) {
                    foreach ($lines as $line) {
                        $decoded = json_decode($line, true);
                        if (is_array($decoded)) {
                            $entries[] = $decoded;
                        }
                    }
                }
            }
        }

        return $entries;
    }

    private function readRawAuditContent(string $auditDir): string
    {
        if (!is_dir($auditDir)) {
            return '';
        }

        $files = scandir($auditDir);
        if ($files === false) {
            return '';
        }

        $content = '';
        foreach ($files as $file) {
            if (preg_match(AuditLog::FILENAME_PATTERN, $file) === 1) {
                $content .= (string)file_get_contents($auditDir . DIRECTORY_SEPARATOR . $file);
            }
        }

        return $content;
    }

    private function assertSecurityEntry(array $entry, string $reason, ?int $actorId): void
    {
        $events = [
            'authentication_required' => ['auth.authentication_denied', 'failure', 401],
            'password_change_required' => ['auth.authorization_denied', 'failure', 403],
            'insufficient_role' => ['auth.authorization_denied', 'failure', 403],
            'invalid_csrf' => ['auth.csrf_denied', 'failure', 403],
            'logout' => ['auth.logout', 'success', 302],
        ];
        [$event, $outcome, $status] = $events[$reason];
        $this->assertSame($event, $entry['event']);
        $this->assertSame($outcome, $entry['outcome']);
        $this->assertSame($status, $entry['http_status']);
        $this->assertSame($actorId, $entry['actor_user_id']);
        $this->assertSame([$reason], $entry['codes']);
        $this->assertMatchesRegex('/\A[0-9a-f]{32}\z/', $entry['request_id']);
        foreach (['subject_username', 'target_type', 'target_id', 'target_count', 'counts', 'data_revision'] as $key) {
            $this->assertArrayHasKey($key, $entry);
            $this->assertNull($entry[$key]);
        }
        $keys = array_keys($entry);
        sort($keys);
        $expectedKeys = [
            'timestamp', 'request_id', 'event', 'outcome', 'actor_user_id', 'subject_username',
            'target_type', 'target_id', 'target_count', 'counts', 'data_revision', 'http_status', 'codes',
        ];
        sort($expectedKeys);
        $this->assertSame($expectedKeys, $keys, 'Security records must not add request-derived fields');
    }

    private function assertApiSecurityDenial(
        TestHttpClient $client,
        string $auditDir,
        string $path,
        array $payload,
        string $reason,
        ?int $actorId,
        array $headers = []
    ): void {
        $before = count($this->readAuditEntries($auditDir));
        $response = $client->postJson($path, $payload, $headers);
        $response->assertStatus($reason === 'authentication_required' ? 401 : 403);
        $json = $response->getJson();
        $this->assertFalse($json['ok']);
        if ($reason === 'authentication_required') {
            $this->assertTrue($json['login_required']);
        } elseif ($reason === 'password_change_required') {
            $this->assertTrue($json['password_change_required']);
        }
        $this->assertArrayHasKey('request_id', $json);
        $entries = $this->readAuditEntries($auditDir);
        $this->assertCount($before + 1, $entries, 'A denial has one terminal record, not a started/finished pair');
        $entry = $entries[$before];
        $this->assertSecurityEntry($entry, $reason, $actorId);
        $this->assertSame($json['request_id'], $entry['request_id']);
    }

    public function testSecurityDenialsAndLogoutHaveSecretFreeTerminalRecords(): void
    {
        $server = new TestServer();
        try {
            $server->start();
            $auditDir = $server->getTempDir() . '/logs/audit';
            $db = new PDO('sqlite:' . $server->getDbPath());
            $admin = new TestHttpClient($server->getBaseUrl());
            $viewer = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($admin->login('admin', 'admin123'));
            $this->assertTrue($viewer->login('viewer', 'viewer123'));
            $baseline = $admin->get('/api.php?action=load')->assertOk()->getJson();
            $hash = (string)$db->query("SELECT password_hash FROM users WHERE username='admin'")->fetchColumn();
            $csrf = (string)$admin->getCsrfToken();
            $cookie = (string)file_get_contents($admin->cookieFile);
            $cookieSecrets = [];
            foreach (file($admin->cookieFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
                $fields = explode("\t", $line);
                if (count($fields) === 7 && $fields[6] !== '') {
                    $cookieSecrets[] = $fields[6];
                }
            }
            $this->assertTrue($cookieSecrets !== [], 'Capture the actual session cookie for leak checks');
            $password = 'Synthetic_Denial_Password_199!';
            $invalidCsrf = 'Synthetic_Invalid_Csrf_199';
            $action = 'synthetic_untrusted_action_199';
            $bodyMarker = 'Synthetic_Huge_Body_199';
            $payload = [
                'password' => $password, 'password_hash' => $hash, 'csrf_token' => $invalidCsrf,
                'cookie' => $cookie, 'username' => 'Synthetic_Denial_User_199',
                'body' => str_repeat($bodyMarker, 32768),
            ];
            $anonymous = new TestHttpClient($server->getBaseUrl());
            $this->assertApiSecurityDenial(
                $anonymous, $auditDir, '/api.php?action=' . $action, $payload,
                'authentication_required', null, ['Cookie' => 'synthetic_secret_cookie_199=value']
            );
            $this->assertApiSecurityDenial(
                $viewer, $auditDir, '/api.php?action=create_user', $payload, 'insufficient_role', 2
            );
            $this->assertApiSecurityDenial(
                $admin, $auditDir, '/api.php?action=save', $payload, 'invalid_csrf', 1,
                ['X-CSRF-Token' => $invalidCsrf]
            );
            $db->exec('UPDATE users SET must_change_password=1 WHERE id=2');
            $this->assertApiSecurityDenial(
                $viewer, $auditDir, '/api.php?action=save', $payload, 'password_change_required', 2
            );
            $before = count($this->readAuditEntries($auditDir));
            $viewer->get('/index.php')->assertStatus(302);
            $entries = $this->readAuditEntries($auditDir);
            $this->assertCount($before + 1, $entries);
            $this->assertSecurityEntry($entries[$before], 'password_change_required', 2);
            $before = count($entries);
            $anonymous->get('/index.php')->assertStatus(302);
            $entries = $this->readAuditEntries($auditDir);
            $this->assertCount($before + 1, $entries);
            $this->assertSecurityEntry($entries[$before], 'authentication_required', null);
            $db->exec('UPDATE users SET must_change_password=0 WHERE id=2');
            $before = count($entries);
            $admin->postForm('/logout.php', ['csrf_token' => $invalidCsrf])->assertStatus(403);
            $entries = $this->readAuditEntries($auditDir);
            $this->assertCount($before + 1, $entries);
            $this->assertSecurityEntry($entries[$before], 'invalid_csrf', 1);
            $this->assertSame($baseline, $admin->get('/api.php?action=load')->assertOk()->getJson());
            $admin->get('/logout.php')->assertStatus(405);
            $this->assertCount(count($entries), $this->readAuditEntries($auditDir));
            $replay = new TestHttpClient($server->getBaseUrl());
            copy($admin->cookieFile, $replay->cookieFile);
            $logout = $admin->postForm('/logout.php', ['csrf_token' => $csrf])->assertStatus(302);
            $this->assertSame('login.php', $logout->getHeader('Location'));
            $afterLogout = $this->readAuditEntries($auditDir);
            $this->assertCount(count($entries) + 1, $afterLogout);
            $this->assertSecurityEntry($afterLogout[count($entries)], 'logout', 1);
            $admin->get('/api.php?action=load')->assertStatus(401);
            $replay->get('/api.php?action=load')->assertStatus(401);
            $viewerLoad = $viewer->get('/api.php?action=load')->assertOk()->getJson();
            foreach (['revision', 'monitor_revision', 'devices', 'views', 'links', 'placements', 'canvas_notes'] as $key) {
                $this->assertSame($baseline[$key], $viewerLoad[$key]);
            }
            $raw = $this->readRawAuditContent($auditDir);
            foreach ([$password, $hash, $csrf, $invalidCsrf, $cookie, $action, $bodyMarker,
                'Synthetic_Denial_User_199', 'synthetic_secret_cookie_199'] as $secret) {
                $this->assertFalse(str_contains($raw, $secret), 'Synthetic request secrets must not appear in audit logs');
            }
            foreach ($cookieSecrets as $secret) {
                $this->assertFalse(str_contains($raw, $secret), 'Session cookie values must not appear in audit logs');
            }
        } finally {
            $server->stop();
        }
    }

    public function testSecurityAuditStorageFailuresPreserveDenialAndReadAccess(): void
    {
        $server = new TestServer();
        try {
            $server->start();
            $admin = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($admin->login('admin', 'admin123'));
            $baseline = $admin->get('/api.php?action=load')->assertOk()->getJson();
            $auditDir = $server->getTempDir() . '/logs/audit';
            $before = $this->readRawAuditContent($auditDir);
            $lockPath = $auditDir . '/.lock';
            $statePath = $auditDir . '/.security-window';
            foreach (['lock_directory', 'lock_contention', 'corrupt_state', 'oversized_state', 'state_directory', 'capacity', 'business_headroom'] as $mode) {
                $capacityFile = $auditDir . '/audit-' . gmdate('Ymd') . '-999.log';
                $heldLock = null;
                if ($mode === 'lock_directory') {
                    unlink($lockPath);
                    mkdir($lockPath, 0700);
                } elseif ($mode === 'lock_contention') {
                    $heldLock = fopen($lockPath, 'c+');
                    $this->assertTrue(flock($heldLock, LOCK_EX | LOCK_NB));
                } elseif ($mode === 'state_directory') {
                    mkdir($statePath, 0700);
                } elseif ($mode === 'capacity' || $mode === 'business_headroom') {
                    $file = fopen($capacityFile, 'wb');
                    $capacityBytes = AuditLog::MAX_TOTAL_BYTES
                        - ($mode === 'business_headroom' ? AuditLog::SECURITY_BUSINESS_HEADROOM_BYTES : 0);
                    ftruncate($file, $capacityBytes);
                    fclose($file);
                } else {
                    file_put_contents($statePath, $mode === 'corrupt_state' ? '{"invalid":true}' : str_repeat('x', 4097));
                }
                try {
                    $anonymous = new TestHttpClient($server->getBaseUrl());
                    $anonymous->setTimeout(2);
                    $denied = $anonymous->postJson('/api.php?action=save', [])->assertStatus(401)->getJson();
                    $this->assertTrue($denied['login_required']);
                    $this->assertFalse(array_key_exists('request_id', $denied));
                    $csrf = $admin->postJson('/api.php?action=save', [], [
                        'X-CSRF-Token' => 'synthetic_storage_failure_csrf_199',
                    ])->assertStatus(403)->getJson();
                    $this->assertFalse(array_key_exists('request_id', $csrf));
                    $this->assertSame($baseline, $admin->get('/api.php?action=load')->assertOk()->getJson());
                    if ($mode === 'capacity' || $mode === 'business_headroom') {
                        clearstatcache(true, $capacityFile);
                        $this->assertSame($capacityBytes, filesize($capacityFile));
                    }
                } finally {
                    if (is_resource($heldLock)) {
                        flock($heldLock, LOCK_UN);
                        fclose($heldLock);
                    }
                    if (is_dir($lockPath)) {
                        rmdir($lockPath);
                    }
                    if (is_dir($statePath)) {
                        rmdir($statePath);
                    } elseif (is_file($statePath)) {
                        unlink($statePath);
                    }
                    if (is_file($capacityFile)) {
                        unlink($capacityFile);
                    }
                }
                $this->assertSame($before, $this->readRawAuditContent($auditDir), $mode . ' must not append a security record');
            }
            $this->assertApiSecurityDenial(
                new TestHttpClient($server->getBaseUrl()), $auditDir, '/api.php?action=save', [],
                'authentication_required', null
            );
            $beforeLogout = $this->readRawAuditContent($auditDir);
            unlink($lockPath);
            mkdir($lockPath, 0700);
            $admin->postForm('/logout.php', ['csrf_token' => $admin->getCsrfToken()])->assertStatus(302);
            $admin->get('/api.php?action=load')->assertStatus(401);
            $this->assertSame($beforeLogout, $this->readRawAuditContent($auditDir));
        } finally {
            $server->stop();
        }
    }

    public function testSecurityQuotaIsSharedAcrossWorkersAndFreshCookies(): void
    {
        $prepend = tempnam(sys_get_temp_dir(), 'netarium-security-clock-');
        $clock = $prepend . '.clock';
        file_put_contents($clock, '1700000040');
        file_put_contents($prepend, '<?php namespace Netarium\\Core; function time(): int { return (int)file_get_contents('
            . var_export($clock, true) . '); }');
        $server = new TestServer(null, $prepend);
        $worker = null;
        try {
            $server->start();
            $worker = $server->spawnWorker();
            $admin = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($admin->login('admin', 'admin123'));
            $baseline = $admin->get('/api.php?action=load')->assertOk()->getJson();
            $auditDir = $server->getTempDir() . '/logs/audit';
            $before = count($this->readAuditEntries($auditDir));
            $ids = [];
            for ($i = 0; $i < 12; $i++) {
                $client = new TestHttpClient(($i % 2 === 0 ? $server : $worker)->getBaseUrl());
                $response = $client->get('/api.php?action=load')->assertStatus(401)->getJson();
                $this->assertTrue($response['login_required']);
                if ($i < 10) {
                    $this->assertArrayHasKey('request_id', $response);
                    $ids[] = $response['request_id'];
                } else {
                    $this->assertFalse(array_key_exists('request_id', $response));
                }
            }
            $entries = array_slice($this->readAuditEntries($auditDir), $before);
            $this->assertCount(11, $entries);
            $this->assertCount(10, array_unique($ids));
            for ($i = 0; $i < 10; $i++) {
                $this->assertSecurityEntry($entries[$i], 'authentication_required', null);
                $this->assertSame($ids[$i], $entries[$i]['request_id']);
            }
            $suppression = $entries[10];
            $this->assertSame('audit.security_suppressed', $suppression['event']);
            $this->assertSame('failure', $suppression['outcome']);
            $this->assertSame(['authentication_required', 'rate_limited'], $suppression['codes']);
            $this->assertNull($suppression['actor_user_id']);
            $this->assertNull($suppression['http_status']);
            $stateRaw = (string)file_get_contents($auditDir . '/.security-window');
            $this->assertTrue(strlen($stateRaw) <= 4096);
            $state = json_decode($stateRaw, true, 512, JSON_THROW_ON_ERROR);
            $keys = array_keys($state);
            sort($keys);
            $this->assertSame(['authentication_required', 'insufficient_role', 'invalid_csrf', 'logout', 'password_change_required'], $keys);
            $this->assertSame(['window' => intdiv(1700000040, 60), 'count' => 11], $state['authentication_required']);
            $this->assertApiSecurityDenial(
                $admin, $auditDir, '/api.php?action=save', [], 'invalid_csrf', 1,
                ['X-CSRF-Token' => 'synthetic_quota_csrf_199']
            );
            $this->assertSame($baseline, $admin->get('/api.php?action=load')->assertOk()->getJson());
            file_put_contents($clock, '1700000100');
            $this->assertApiSecurityDenial(
                new TestHttpClient($worker->getBaseUrl()), $auditDir, '/api.php?action=save', [],
                'authentication_required', null
            );
            $state = json_decode((string)file_get_contents($auditDir . '/.security-window'), true, 512, JSON_THROW_ON_ERROR);
            $this->assertSame(['window' => intdiv(1700000100, 60), 'count' => 1], $state['authentication_required']);
        } finally {
            if ($worker !== null) {
                $worker->stop();
            }
            $server->stop();
            unlink($clock);
            unlink($prepend);
        }
    }

    public function testSecurityAuditCannotConsumePendingMutationTerminalReservation(): void
    {
        $server = new TestServer();
        $filler = null;
        try {
            $server->start();
            $auditDir = $server->getTempDir() . '/reserved-security-audit';
            mkdir($auditDir, 0700);
            $config = ['audit_log_directory' => $auditDir];
            AuditLog::begin($config, 'reserved_mutation', 1, null);
            $requestId = AuditLog::id();
            $securityId = AuditLog::recordSecurityEvent($config, 'logout', 1);
            $this->assertNotNull($securityId);
            $this->assertNotSame($requestId, $securityId);
            $this->assertSame($requestId, AuditLog::id());
            $this->assertFalse(AuditLog::isFinished());
            $pending = $auditDir . '/.pending-' . $requestId;
            $startedFile = $auditDir . '/audit-' . gmdate('Ymd') . '-001.log';
            $filler = $auditDir . '/audit-' . gmdate('Ymd') . '-002.log';
            $file = fopen($filler, 'wb');
            clearstatcache(true, $startedFile);
            ftruncate($file, AuditLog::MAX_TOTAL_BYTES - AuditLog::SECURITY_BUSINESS_HEADROOM_BYTES
                - AuditLog::RESERVED_TERMINAL_BYTES - 100 - filesize($startedFile));
            fclose($file);
            $this->assertNull(AuditLog::recordSecurityEvent($config, 'authentication_required', null));
            $this->assertSame($requestId, AuditLog::id());
            $this->assertSame('reserved_mutation', AuditLog::event());
            $this->assertFalse(AuditLog::isFinished());
            $this->assertTrue(is_file($pending), 'Security audit must not release a mutation reservation');
            $this->assertTrue(AuditLog::finish('success', [], 200), 'Reserved mutation terminal record must remain writable');
            $this->assertTrue(AuditLog::isFinished());
            $terminalFile = $auditDir . '/audit-' . gmdate('Ymd') . '-003.log';
            clearstatcache();
            $this->assertTrue(filesize($startedFile) + filesize($filler) + filesize($terminalFile) <= AuditLog::MAX_TOTAL_BYTES);
            unlink($filler);
            $filler = null;
            $entries = $this->readAuditEntries($auditDir);
            $this->assertCount(3, $entries);
            $this->assertSecurityEntry($entries[1], 'logout', 1);
            $this->assertSame($securityId, $entries[1]['request_id']);
            $this->assertSame($requestId, $entries[2]['request_id']);
            $this->assertSame('reserved_mutation', $entries[2]['event']);
            $this->assertSame('success', $entries[2]['outcome']);
            AuditLog::reset();
            $boundaryDir = $server->getTempDir() . '/business-headroom-audit';
            mkdir($boundaryDir, 0700);
            $boundaryConfig = ['audit_log_directory' => $boundaryDir];
            $filler = $boundaryDir . '/audit-' . gmdate('Ymd') . '-001.log';
            $file = fopen($filler, 'wb');
            ftruncate($file, AuditLog::MAX_TOTAL_BYTES - AuditLog::SECURITY_BUSINESS_HEADROOM_BYTES);
            fclose($file);
            $this->assertNull(AuditLog::recordSecurityEvent($boundaryConfig, 'authentication_required', null));
            AuditLog::begin($boundaryConfig, 'business_headroom_mutation', 1, null);
            $businessId = AuditLog::id();
            $this->assertNull(AuditLog::recordSecurityEvent($boundaryConfig, 'logout', 1));
            $this->assertSame($businessId, AuditLog::id());
            $this->assertTrue(AuditLog::finish('success', [], 200), 'Business mutations remain auditable after security capacity exhaustion');
            unlink($filler);
            $filler = null;
            $businessEntries = $this->readAuditEntries($boundaryDir);
            $this->assertCount(2, $businessEntries);
            $this->assertSame('started', $businessEntries[0]['outcome']);
            $this->assertSame('success', $businessEntries[1]['outcome']);
            $this->assertSame($businessId, $businessEntries[1]['request_id']);
        } finally {
            AuditLog::reset();
            if ($filler !== null && is_file($filler)) {
                unlink($filler);
            }
            $server->stop();
        }
    }

    public function testLoginUpdateFailureHasTerminalAuditWithoutSession(): void
    {
        $server = new TestServer();
        $server->start();
        try {
            $db = new PDO('sqlite:' . $server->getTempDir() . DIRECTORY_SEPARATOR . 'db' . DIRECTORY_SEPARATOR . 'data.sqlite');
            $db->exec("CREATE TRIGGER fail_last_login BEFORE UPDATE OF last_login_at ON users BEGIN SELECT RAISE(ABORT, 'synthetic login update failure'); END");

            $client = new TestHttpClient($server->getBaseUrl());
            $page = $client->get('/login.php');
            if (!preg_match('/name="csrf_token"\s+value="([^"]+)"/', $page->getBody(), $match)) {
                $this->fail('Failed to find csrf_token on login.php');
            }
            $login = $client->postForm('/login.php', [
                'csrf_token' => $match[1],
                'username' => 'admin',
                'password' => 'admin123',
            ]);
            $login->assertStatus(500);
            $client->get('/api.php?action=load')->assertStatus(401);

            $entries = $this->readAuditEntries($server->getTempDir() . DIRECTORY_SEPARATOR . 'logs' . DIRECTORY_SEPARATOR . 'audit');
            $this->assertSame('auth.login', $entries[0]['event']);
            $this->assertSame('started', $entries[0]['outcome']);
            $this->assertSame($entries[0]['request_id'], $entries[1]['request_id']);
            $this->assertSame('failure', $entries[1]['outcome']);
            $this->assertSame(500, $entries[1]['http_status']);
            $this->assertCount(3, $entries);
            $this->assertSecurityEntry($entries[2], 'authentication_required', null);
        } finally {
            $server->stop();
        }
    }

    public function testTopologySaveAndDeviceDeleteAudit(): void
    {
        $server = new TestServer();
        $server->start();

        try {
            $client = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($client->login('admin', 'admin123'));

            $auditDir = $server->getTempDir() . DIRECTORY_SEPARATOR . 'logs' . DIRECTORY_SEPARATOR . 'audit';

            // 1. Load topology
            $loadRes = $client->get('/api.php?action=load');
            $loadRes->assertOk();
            $loadData = $loadRes->getJson();
            $initialRev = (int)$loadData['revision'];
            $devices = $loadData['devices'];
            $this->assertTrue(count($devices) >= 2, 'Initial devices should exist');

            // 2. Save topology with 1 device deleted (remove the last device)
            $removedDevice = array_pop($devices);
            $savePayload = [
                'revision' => $initialRev,
                'views' => $loadData['views'],
                'devices' => $devices,
                'canvas_notes' => $loadData['canvas_notes'],
                'placements' => array_values(array_filter($loadData['placements'], static function (array $p) use ($removedDevice): bool {
                    return (int)$p['device_id'] !== (int)$removedDevice['id'];
                })),
                'links' => array_values(array_filter($loadData['links'], static function (array $l) use ($removedDevice): bool {
                    return (int)$l['from_id'] !== (int)$removedDevice['id'] && (int)$l['to_id'] !== (int)$removedDevice['id'];
                })),
            ];

            $saveRes = $client->postJson('/api.php?action=save', $savePayload);
            $saveRes->assertOk();
            $saveJson = $saveRes->getJson();
            $this->assertTrue($saveJson['ok']);
            $this->assertArrayHasKey('request_id', $saveJson);
            $this->assertSame($initialRev + 1, (int)$saveJson['revision']);
            $saveRequestId = (string)$saveJson['request_id'];

            // 3. Inspect audit log
            $entries = $this->readAuditEntries($auditDir);
            $saveEntries = array_values(array_filter($entries, static function (array $e) use ($saveRequestId): bool {
                return ($e['request_id'] ?? '') === $saveRequestId;
            }));

            // Should have: started, topology.save success, and topology.device_delete
            $this->assertTrue(count($saveEntries) >= 3, 'Should have started, topology.save and topology.device_delete');

            $startedEntry = $saveEntries[0];
            $this->assertSame('topology.save', $startedEntry['event']);
            $this->assertSame('started', $startedEntry['outcome']);

            $saveSuccessEntry = null;
            $deleteSuccessEntry = null;
            foreach ($saveEntries as $e) {
                if ($e['event'] === 'topology.save' && $e['outcome'] === 'success') {
                    $saveSuccessEntry = $e;
                }
                if ($e['event'] === 'topology.device_delete' && $e['outcome'] === 'success') {
                    $deleteSuccessEntry = $e;
                }
            }

            $this->assertNotNull($saveSuccessEntry, 'topology.save success entry must exist');
            $this->assertSame(1, (int)$saveSuccessEntry['target_count']);
            $this->assertSame(1, (int)($saveSuccessEntry['counts']['deleted_device_count'] ?? 0));
            $this->assertSame(0, (int)($saveSuccessEntry['counts']['deleted_view_count'] ?? 0));
            $this->assertSame($initialRev + 1, (int)$saveSuccessEntry['data_revision']);

            $this->assertNotNull($deleteSuccessEntry, 'topology.device_delete entry must exist');
            $this->assertSame('device', $deleteSuccessEntry['target_type']);
            $this->assertSame(1, (int)$deleteSuccessEntry['target_count']);
            $this->assertSame($saveRequestId, $deleteSuccessEntry['request_id']);

            // 4. Stale revision save attempt
            $staleRes = $client->postJson('/api.php?action=save', [
                'revision' => $initialRev, // stale
                'views' => $loadData['views'],
                'devices' => $devices,
                'placements' => [],
                'links' => [],
                'canvas_notes' => $loadData['canvas_notes'],
            ]);
            $staleRes->assertStatus(409);
            $staleJson = $staleRes->getJson();
            $this->assertFalse($staleJson['ok']);
            $this->assertArrayHasKey('request_id', $staleJson);
            $staleRequestId = (string)$staleJson['request_id'];

            $entriesAfterStale = $this->readAuditEntries($auditDir);
            $staleEntries = array_values(array_filter($entriesAfterStale, static function (array $e) use ($staleRequestId): bool {
                return ($e['request_id'] ?? '') === $staleRequestId;
            }));

            $this->assertSame(2, count($staleEntries));
            $this->assertSame('started', $staleEntries[0]['outcome']);
            $this->assertSame('failure', $staleEntries[1]['outcome']);
            $this->assertSame(409, (int)$staleEntries[1]['http_status']);

            // 5. DB device count remains unchanged after stale failure
            $reloadRes = $client->get('/api.php?action=load');
            $reloadRes->assertOk();
            $this->assertSame(count($devices), count($reloadRes->getJson()['devices']));

        } finally {
            $server->stop();
        }
    }

    public function testAuthLoginAndUserManagementAudit(): void
    {
        $server = new TestServer();
        $server->start();

        try {
            $client = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($client->login('admin', 'admin123'));

            $auditDir = $server->getTempDir() . DIRECTORY_SEPARATOR . 'logs' . DIRECTORY_SEPARATOR . 'audit';

            // 1. Create synthetic user
            $secretPassword = 'Secret_Synthetic_Pass_2026!';
            $createRes = $client->postJson('/api.php?action=create_user', [
                'username' => 'audit_synthetic_user',
                'password' => $secretPassword,
                'password_confirm' => $secretPassword,
                'role' => 'viewer',
            ]);
            $createRes->assertOk();
            $createJson = $createRes->getJson();
            $this->assertTrue($createJson['ok']);
            $createdUserId = (int)$createJson['user_id'];
            $createRequestId = (string)$createJson['request_id'];

            $entries = $this->readAuditEntries($auditDir);
            $createEntries = array_values(array_filter($entries, static function (array $e) use ($createRequestId): bool {
                return ($e['request_id'] ?? '') === $createRequestId;
            }));
            $this->assertSame(2, count($createEntries));
            $this->assertSame('create_user', $createEntries[1]['event']);
            $this->assertSame('success', $createEntries[1]['outcome']);
            $this->assertSame('user', $createEntries[1]['target_type']);
            $this->assertSame($createdUserId, (int)$createEntries[1]['target_id']);

            // 2. Wrong password login
            $unauthClient = new TestHttpClient($server->getBaseUrl());
            $loginPage = $unauthClient->get('/login.php');
            if (!preg_match('/name="csrf_token"\s+value="([^"]+)"/', $loginPage->getBody(), $m)) {
                $this->fail('Failed to find csrf_token on login.php');
            }
            $wrongPassword = 'WrongPasswordAttempt_999!';
            $loginRes = $unauthClient->postForm('/login.php', [
                'csrf_token' => $m[1],
                'username' => 'audit_synthetic_user',
                'password' => $wrongPassword,
            ]);
            $loginRes->assertStatus(200); // Renders login HTML with error

            $entries = $this->readAuditEntries($auditDir);
            $failedLoginEntry = end($entries);
            $this->assertSame('auth.login', $failedLoginEntry['event']);
            $this->assertSame('failure', $failedLoginEntry['outcome']);
            $this->assertSame(401, (int)$failedLoginEntry['http_status']);
            $this->assertSame(['auth_failed'], $failedLoginEntry['codes']);
            $this->assertSame('audit_synthetic_user', $failedLoginEntry['subject_username']);

            // 3. Lockout via 4 more wrong attempts
            for ($i = 0; $i < 4; $i++) {
                $lp = $unauthClient->get('/login.php');
                preg_match('/name="csrf_token"\s+value="([^"]+)"/', $lp->getBody(), $tokenMatch);
                $unauthClient->postForm('/login.php', [
                    'csrf_token' => $tokenMatch[1],
                    'username' => 'audit_synthetic_user',
                    'password' => 'Wrong_Again_1234!',
                ]);
            }
            // 6th attempt: should trigger rate limit lock
            $lp = $unauthClient->get('/login.php');
            preg_match('/name="csrf_token"\s+value="([^"]+)"/', $lp->getBody(), $tokenMatch);
            $unauthClient->postForm('/login.php', [
                'csrf_token' => $tokenMatch[1],
                'username' => 'audit_synthetic_user',
                'password' => 'Wrong_Again_1234!',
            ]);
            $entries = $this->readAuditEntries($auditDir);
            $lockedEntry = end($entries);
            $this->assertSame('auth.login', $lockedEntry['event']);
            $this->assertSame('failure', $lockedEntry['outcome']);
            $this->assertSame(429, (int)$lockedEntry['http_status']);
            $this->assertSame(['rate_limited'], $lockedEntry['codes']);
            // 4. Admin resets password
            $newPassword = 'NewSecretPass_AdminReset_777!';
            $resetRes = $client->postJson('/api.php?action=reset_user_password', [
                'id' => $createdUserId,
                'password' => $newPassword,
                'password_confirm' => $newPassword,
            ]);
            $resetRes->assertOk();
            $resetJson = $resetRes->getJson();
            $resetRequestId = (string)$resetJson['request_id'];

            $entries = $this->readAuditEntries($auditDir);
            $resetEntries = array_values(array_filter($entries, static function (array $e) use ($resetRequestId): bool {
                return ($e['request_id'] ?? '') === $resetRequestId;
            }));
            $this->assertSame('reset_user_password', $resetEntries[1]['event']);
            $this->assertSame('success', $resetEntries[1]['outcome']);
            $this->assertSame($createdUserId, (int)$resetEntries[1]['target_id']);

            // 5. Admin updates user (deactivates)
            $updateRes = $client->postJson('/api.php?action=update_user', [
                'id' => $createdUserId,
                'role' => 'viewer',
                'is_active' => 0,
            ]);
            $updateRes->assertOk();
            $updateJson = $updateRes->getJson();
            $updateRequestId = (string)$updateJson['request_id'];

            $entries = $this->readAuditEntries($auditDir);
            $updateEntries = array_values(array_filter($entries, static function (array $e) use ($updateRequestId): bool {
                return ($e['request_id'] ?? '') === $updateRequestId;
            }));
            $this->assertSame('update_user', $updateEntries[1]['event']);
            $this->assertSame('success', $updateEntries[1]['outcome']);
            $this->assertSame($createdUserId, (int)$updateEntries[1]['target_id']);

            // 6. Verify passwords never appear in the raw audit logs
            $rawLogs = $this->readRawAuditContent($auditDir);
            $this->assertFalse(str_contains($rawLogs, $secretPassword), 'Secret password must not exist in audit log');
            $this->assertFalse(str_contains($rawLogs, $wrongPassword), 'Wrong password must not exist in audit log');
            $this->assertFalse(str_contains($rawLogs, $newPassword), 'New password must not exist in audit log');

        } finally {
            $server->stop();
        }
    }

    public function testCsvBackupAndFloorPlanAudit(): void
    {
        $server = new TestServer();
        $server->start();

        try {
            $client = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($client->login('admin', 'admin123'));

            $auditDir = $server->getTempDir() . DIRECTORY_SEPARATOR . 'logs' . DIRECTORY_SEPARATOR . 'audit';
            $restoreLogFile = $server->getTempDir() . DIRECTORY_SEPARATOR . 'logs' . DIRECTORY_SEPARATOR . 'restore.log';

            // 1. Export backup ZIP
            $zipRes = $client->postJson('/api.php?action=export_backup_zip', []);
            $zipRes->assertStatus(200);
            usleep(100000);
            $zipContent = $zipRes->getBody();
            $this->assertTrue(strlen($zipContent) > 100);

            $entries = $this->readAuditEntries($auditDir);
            $zipExportEntry = end($entries);
            $this->assertSame('export_backup_zip', $zipExportEntry['event']);
            $this->assertSame('success', $zipExportEntry['outcome']);
            $this->assertSame('backup', $zipExportEntry['target_type']);

            // Save ZIP to temp file for restore test
            $tempZip = tempnam(sys_get_temp_dir(), 'audit_zip_');
            file_put_contents($tempZip, $zipContent);

            // 2. Preview and commit backup restore
            $previewRes = $client->postMultipart(
                '/api.php?action=preview_backup_restore',
                [],
                [
                    'backup_zip' => [
                        'path' => $tempZip,
                        'filename' => 'backup.zip',
                        'type' => 'application/zip',
                    ],
                ]
            );
            $previewRes->assertOk();
            $previewJson = $previewRes->getJson();
            $restoreToken = (string)$previewJson['restore_token'];

            $entries = $this->readAuditEntries($auditDir);
            $previewEntry = end($entries);
            $this->assertSame('preview_backup_restore', $previewEntry['event']);
            $this->assertSame('success', $previewEntry['outcome']);

            // Commit restore
            $commitRes = $client->postJson('/api.php?action=commit_backup_restore', [
                'restore_token' => $restoreToken,
                'confirmation' => 'バックアップから復元',
            ]);
            $commitRes->assertOk();
            $commitJson = $commitRes->getJson();
            $restoreRequestId = (string)$commitJson['request_id'];

            $entries = $this->readAuditEntries($auditDir);
            $commitEntries = array_values(array_filter($entries, static function (array $e) use ($restoreRequestId): bool {
                return ($e['request_id'] ?? '') === $restoreRequestId;
            }));
            $this->assertSame('commit_backup_restore', $commitEntries[1]['event']);
            $this->assertSame('success', $commitEntries[1]['outcome']);
            $this->assertSame('backup', $commitEntries[1]['target_type']);

            // Verify restore.log contains the request_id!
            $this->assertTrue(is_file($restoreLogFile), 'restore.log must exist');
            $restoreLogLines = file($restoreLogFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
            $lastRestoreLine = json_decode(end($restoreLogLines), true);
            $this->assertSame($restoreRequestId, $lastRestoreLine['request_id']);

            @unlink($tempZip);


            // 3. Floor plan upload and delete
            $loadRes = $client->get('/api.php?action=load');
            $currentRev = (int)$loadRes->getJson()['revision'];
            $viewRevision = (int)array_column($loadRes->getJson()['views'], 'resource_revision', 'id')[2];

            $pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
            $tempPng = tempnam(sys_get_temp_dir(), 'audit_png_');
            file_put_contents($tempPng, base64_decode($pngBase64));

            $uploadRes = $client->postMultipart(
                '/image_upload.php?action=upload_floor_plan',
                [
                    'view_id' => '2',
                    'expected_revision' => (string)$viewRevision,
                ],
                [
                    'floor_plan' => [
                        'path' => $tempPng,
                        'filename' => 'floor.png',
                        'type' => 'image/png',
                    ],
                ]
            );
            $uploadRes->assertOk();
            $uploadJson = $uploadRes->getJson();
            $uploadRequestId = (string)$uploadJson['request_id'];
            $currentRev = (int)$uploadJson['revision'];
            $viewRevision = (int)$uploadJson['view_revision'];

            $entries = $this->readAuditEntries($auditDir);
            $uploadEntries = array_values(array_filter($entries, static function (array $e) use ($uploadRequestId): bool {
                return ($e['request_id'] ?? '') === $uploadRequestId;
            }));
            $this->assertSame('upload_floor_plan', $uploadEntries[1]['event']);
            $this->assertSame('success', $uploadEntries[1]['outcome']);
            $this->assertSame('view', $uploadEntries[1]['target_type']);
            $this->assertSame(2, (int)$uploadEntries[1]['target_id']);

            // Delete floor plan
            $deleteRes = $client->postJson('/api.php?action=delete_floor_plan', [
                'view_id' => 2,
                'expected_revision' => $viewRevision,
            ]);
            $deleteRes->assertOk();
            $deleteJson = $deleteRes->getJson();
            $deleteRequestId = (string)$deleteJson['request_id'];
            $currentRev = (int)$deleteJson['revision'];

            $entries = $this->readAuditEntries($auditDir);
            $deleteEntries = array_values(array_filter($entries, static function (array $e) use ($deleteRequestId): bool {
                return ($e['request_id'] ?? '') === $deleteRequestId;
            }));
            $this->assertSame('delete_floor_plan', $deleteEntries[1]['event']);
            $this->assertSame('success', $deleteEntries[1]['outcome']);
            $this->assertSame('view', $deleteEntries[1]['target_type']);
            $this->assertSame(2, (int)$deleteEntries[1]['target_id']);

            @unlink($tempPng);

            // 4. CSV export and import
            $csvExportRes = $client->get('/api.php?action=export_devices_csv');
            $csvExportRes->assertStatus(200);
            usleep(100000);
            $csvContent = $csvExportRes->getBody();

            $entries = $this->readAuditEntries($auditDir);
            $csvExportEntry = end($entries);
            $this->assertSame('export_devices_csv', $csvExportEntry['event']);
            $this->assertSame('success', $csvExportEntry['outcome']);
            $this->assertSame('csv', $csvExportEntry['target_type']);

            // Import CSV with a secret marker
            $secretCsvMarker = 'Secret_CSV_Marker_Audit_Unique_12345';
            $csvData = "\xEF\xBB\xBF\"id\",\"name\",\"type\",\"ip\",\"facility\",\"floor\",\"location\",\"manufacturer\",\"model\",\"asset_number\",\"serial_number\",\"mac_address\",\"memo\",\"management_scheme\",\"management_port\",\"department\",\"maintenance_vendor\",\"install_date\",\"maintenance_expiry\"\n";
            $csvData .= ",\"{$secretCsvMarker}\",\"switch\",\"192.168.10.99\",\"本庁舎\",\"2F\",\"会議室\",\"Cisco\",\"C9200\",\"AST-CSV99\",\"SER-CSV99\",\"00:AA:BB:CC:DD:EE\",\"CSVインポート機器\",\"https\",8443,\"情報政策課\",\"ベンダーA\",\"2024-04-01\",\"2027-03-31\"\n";
            $tempCsv = tempnam(sys_get_temp_dir(), 'audit_csv_');
            file_put_contents($tempCsv, $csvData);

            $csvPreviewRes = $client->postMultipart(
                '/api.php?action=preview_devices_csv_import',
                ['revision' => (string)$currentRev],
                [
                    'devices_csv' => [
                        'path' => $tempCsv,
                        'filename' => 'import.csv',
                        'type' => 'text/csv',
                    ],
                ]
            );
            $csvPreviewRes->assertOk();
            $csvImportToken = (string)$csvPreviewRes->getJson()['import_token'];

            $csvCommitRes = $client->postJson('/api.php?action=commit_devices_csv_import', [
                'import_token' => $csvImportToken,
                'revision' => $currentRev,
            ]);
            $csvCommitRes->assertOk();
            $csvCommitJson = $csvCommitRes->getJson();
            $csvCommitRequestId = (string)$csvCommitJson['request_id'];

            $entries = $this->readAuditEntries($auditDir);
            $csvCommitEntries = array_values(array_filter($entries, static function (array $e) use ($csvCommitRequestId): bool {
                return ($e['request_id'] ?? '') === $csvCommitRequestId;
            }));
            $this->assertSame('commit_devices_csv_import', $csvCommitEntries[1]['event']);
            $this->assertSame('success', $csvCommitEntries[1]['outcome']);
            $this->assertSame(1, (int)($csvCommitEntries[1]['counts']['insert_count'] ?? 0));

            @unlink($tempCsv);

            // 5. Verify secrets (restore tokens and CSV text markers) do NOT leak into audit logs
            $rawLogs = $this->readRawAuditContent($auditDir);
            $this->assertFalse(str_contains($rawLogs, $restoreToken), 'Restore token must not be in audit logs');
            $this->assertFalse(str_contains($rawLogs, $secretCsvMarker), 'CSV body marker must not be in audit logs');

        } finally {
            $server->stop();
        }
    }

    public function testFailSafeLockErrorAndCapacityPruning(): void
    {
        $server = new TestServer();
        $server->start();

        try {
            $client = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($client->login('admin', 'admin123'));

            $auditDir = $server->getTempDir() . DIRECTORY_SEPARATOR . 'logs' . DIRECTORY_SEPARATOR . 'audit';
            if (!is_dir($auditDir)) {
                mkdir($auditDir, 0700, true);
            }

            // 1. Create a directory named '.lock' to block writing
            $lockPath = $auditDir . DIRECTORY_SEPARATOR . '.lock';
            if (is_file($lockPath)) {
                unlink($lockPath);
            }
            mkdir($lockPath, 0700);

            // Fetch current topology
            $loadRes = $client->get('/api.php?action=load');
            $loadRes->assertOk();
            $originalRev = (int)$loadRes->getJson()['revision'];
            $originalDeviceCount = count($loadRes->getJson()['devices']);

            // Attempt save with normal payload -> must fail with HTTP 503
            $saveRes = $client->postJson('/api.php?action=save', [
                'revision' => $originalRev,
                'views' => $loadRes->getJson()['views'],
                'devices' => $loadRes->getJson()['devices'],
                'placements' => $loadRes->getJson()['placements'],
                'links' => $loadRes->getJson()['links'],
                'canvas_notes' => $loadRes->getJson()['canvas_notes'],
            ]);
            $saveRes->assertStatus(503);
            $this->assertFalse($saveRes->getJson()['ok']);

            // Verify database was NOT changed
            $reloadRes = $client->get('/api.php?action=load');
            $reloadRes->assertOk();
            $this->assertSame($originalRev, (int)$reloadRes->getJson()['revision']);
            $this->assertSame($originalDeviceCount, count($reloadRes->getJson()['devices']));

            // Remove .lock directory to restore operation
            rmdir($lockPath);

            // Save should now succeed
            $saveRes2 = $client->postJson('/api.php?action=save', [
                'revision' => $originalRev,
                'views' => $loadRes->getJson()['views'],
                'devices' => $loadRes->getJson()['devices'],
                'placements' => $loadRes->getJson()['placements'],
                'links' => $loadRes->getJson()['links'],
                'canvas_notes' => $loadRes->getJson()['canvas_notes'],
            ]);
            $saveRes2->assertOk();
            $this->assertTrue($saveRes2->getJson()['ok']);
            $this->assertSame($originalRev + 1, (int)$saveRes2->getJson()['revision']);

            // 2. Test 90-day pruning directly in isolation
            $isolatedDir = $server->getTempDir() . DIRECTORY_SEPARATOR . 'isolated_audit';
            mkdir($isolatedDir, 0700, true);
            $isolatedConfig = ['audit_log_directory' => $isolatedDir];

            $today = new DateTimeImmutable('today', new DateTimeZone('UTC'));
            $oldDate = $today->sub(new DateInterval('P95D'))->format('Ymd');
            $recentDate = $today->sub(new DateInterval('P10D'))->format('Ymd');

            $oldFile = $isolatedDir . DIRECTORY_SEPARATOR . "audit-{$oldDate}-001.log";
            $recentFile = $isolatedDir . DIRECTORY_SEPARATOR . "audit-{$recentDate}-001.log";
            $unrelatedFile = $isolatedDir . DIRECTORY_SEPARATOR . "restore.log";

            file_put_contents($oldFile, "{}\n");
            file_put_contents($recentFile, "{}\n");
            file_put_contents($unrelatedFile, "keep-me\n");

            AuditLog::prune($isolatedConfig);

            $this->assertFalse(file_exists($oldFile), 'File older than 90 days must be pruned');
            $this->assertTrue(file_exists($recentFile), 'File within 90 days must be kept');
            $this->assertTrue(file_exists($unrelatedFile), 'restore.log must never be touched by audit prune');

            // Prune must throw if .lock is a directory
            $blockedDir = $server->getTempDir() . DIRECTORY_SEPARATOR . 'blocked_prune';
            mkdir($blockedDir, 0700, true);
            mkdir($blockedDir . DIRECTORY_SEPARATOR . AuditLog::LOCK_FILE, 0700);
            $pruneFailed = false;
            try {
                AuditLog::prune(['audit_log_directory' => $blockedDir]);
            } catch (\RuntimeException $e) {
                $pruneFailed = true;
                $this->assertStringContains('排他制御', $e->getMessage());
            }
            $this->assertTrue($pruneFailed, 'AuditLog::prune must throw RuntimeException when lock file cannot be opened');

            // A matching expired entry that cannot be removed must fail maintenance.
            $undeletableDir = $server->getTempDir() . DIRECTORY_SEPARATOR . 'failed_prune';
            mkdir($undeletableDir, 0700, true);
            $expiredEntry = $undeletableDir . DIRECTORY_SEPARATOR . 'audit-20200101-001.log';
            mkdir($expiredEntry, 0700);
            $pruneFailed = false;
            try {
                AuditLog::prune(['audit_log_directory' => $undeletableDir]);
            } catch (\RuntimeException $e) {
                $pruneFailed = true;
            }
            $this->assertTrue($pruneFailed, 'Prune must report deletion failure');
            $this->assertTrue(is_dir($expiredEntry), 'Prune must not report that an undeleted entry was removed');

            // 3. Test 10MiB file rotation
            $todayUtc = (new DateTimeImmutable('now', new DateTimeZone('UTC')))->format('Ymd');
            $rotationFile1 = $isolatedDir . DIRECTORY_SEPARATOR . "audit-{$todayUtc}-001.log";
            // Create 10MiB dummy file
            $fp = fopen($rotationFile1, 'wb');
            fseek($fp, AuditLog::MAX_FILE_BYTES - 10);
            fwrite($fp, "x\n");
            fclose($fp);
            $this->assertTrue(filesize($rotationFile1) >= AuditLog::MAX_FILE_BYTES - 10);

            // Write new entry via AuditLog::begin
            AuditLog::begin($isolatedConfig, 'rotation_test', null, null);
            AuditLog::finish('success');
            AuditLog::reset();

            $rotationFile2 = $isolatedDir . DIRECTORY_SEPARATOR . "audit-{$todayUtc}-002.log";
            $this->assertTrue(file_exists($rotationFile2), 'Rotated file -002.log must be created when -001.log reaches 10MiB');

            // 4. Test 256MiB capacity limit rejection without deleting <=90-day files
            $capacityDir = $server->getTempDir() . DIRECTORY_SEPARATOR . 'capacity_audit';
            mkdir($capacityDir, 0700, true);
            $capacityConfig = ['audit_log_directory' => $capacityDir];

            // Create files summing to 256MiB
            $capFile = $capacityDir . DIRECTORY_SEPARATOR . "audit-{$todayUtc}-001.log";
            $fp = fopen($capFile, 'wb');
            fseek($fp, AuditLog::MAX_TOTAL_BYTES);
            fwrite($fp, "x");
            fclose($fp);

            $exceptionCaught = false;
            try {
                AuditLog::begin($capacityConfig, 'capacity_test', null, null);
            } catch (ApiException $e) {
                $exceptionCaught = true;
                $this->assertSame(503, $e->getHttpStatus());
                $this->assertStringContains('容量上限', $e->getMessage());
            } catch (Throwable $e) {
                $this->fail('Unexpected exception: ' . $e->getMessage());
            } finally {
                AuditLog::reset();
            }

            $this->assertTrue($exceptionCaught, 'AuditLog::begin must reject when total size exceeds 256MiB');
            $this->assertTrue(file_exists($capFile), 'Capacity limit must not delete valid files within 90 days');

            // 5. Test headroom reservation for terminal record in begin()
            $headroomDir = $server->getTempDir() . DIRECTORY_SEPARATOR . 'headroom_audit';
            mkdir($headroomDir, 0700, true);
            $headroomConfig = ['audit_log_directory' => $headroomDir];
            $headroomFile = $headroomDir . DIRECTORY_SEPARATOR . "audit-{$todayUtc}-001.log";
            $fp = fopen($headroomFile, 'wb');
            fseek($fp, AuditLog::MAX_TOTAL_BYTES - 1000);
            fwrite($fp, "x");
            fclose($fp);

            $headroomRejected = false;
            try {
                AuditLog::begin($headroomConfig, 'headroom_test', null, null);
            } catch (ApiException $e) {
                $headroomRejected = true;
                $this->assertSame(503, $e->getHttpStatus());
            } finally {
                AuditLog::reset();
            }
            $this->assertTrue($headroomRejected, 'AuditLog::begin must reject when reserved headroom for terminal entries is breached');
        } finally {
            $server->stop();
        }
    }

    public function testLinkSystemMutationsHaveTerminalAuditRecords(): void
    {
        $server = new TestServer();
        try {
            $server->start();
            $client = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($client->login('admin', 'admin123'));
            $gate = new \Netarium\Core\OperationGate($server->getTempDir() . DIRECTORY_SEPARATOR . 'temp' . DIRECTORY_SEPARATOR . 'operation.lock');
            $gate->acquireExclusive();
            try {
                $client->get('/api.php?action=list_link_systems')->assertStatus(409);
                foreach (['create_link_system', 'update_link_system', 'delete_link_system'] as $action) {
                    $client->postJson('/api.php?action=' . $action, [
                        'name' => '復元中は禁止', 'color_key' => 'cyan',
                    ])->assertStatus(409);
                }
            } finally {
                $gate->release();
            }
            $created = $client->postJson('/api.php?action=create_link_system', [
                'name' => '監査対象系統', 'color_key' => 'indigo',
            ])->assertOk()->getJson();
            $system = $created['link_systems'][0];
            $updated = $client->postJson('/api.php?action=update_link_system', [
                'id' => (int)$system['id'], 'expected_revision' => (int)$system['resource_revision'],
                'name' => '変更後系統', 'color_key' => 'cyan',
            ])->assertOk()->getJson();
            $client->postJson('/api.php?action=delete_link_system', [
                'id' => (int)$system['id'], 'expected_revision' => (int)$system['resource_revision'],
            ])->assertStatus(409);
            $client->postJson('/api.php?action=delete_link_system', [
                'id' => (int)$system['id'], 'expected_revision' => (int)$updated['link_systems'][0]['resource_revision'],
            ])->assertOk();
            $entries = $this->readAuditEntries($server->getTempDir() . DIRECTORY_SEPARATOR . 'logs' . DIRECTORY_SEPARATOR . 'audit');
            foreach (['link_system.create', 'link_system.update', 'link_system.delete'] as $event) {
                $matching = array_values(array_filter($entries, static fn($entry) => $entry['event'] === $event));
                $success = array_values(array_filter($matching, static fn($entry) => $entry['outcome'] === 'success'));
                $this->assertCount(1, $success);
                $this->assertSame('link_system', $success[0]['target_type']);
                $this->assertSame(1, (int)$success[0]['target_count']);
                $this->assertSame(200, $success[0]['http_status']);
            }
            $failures = array_values(array_filter($entries, static fn($entry) =>
                $entry['event'] === 'link_system.delete' && $entry['outcome'] === 'failure'));
            $this->assertCount(1, $failures);
            $this->assertSame(409, $failures[0]['http_status']);
        } finally {
            $server->stop();
        }
    }
}
