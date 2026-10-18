<?php
declare(strict_types=1);

namespace Netarium\Tests\Suites;

use Netarium\Core\ApiException;
use Netarium\Services\Auth\PasswordSprayDetector;
use Netarium\Services\Auth\ReauthenticationLimit;
use Netarium\Tests\TestCase;
use Netarium\Tests\TestHttpClient;
use Netarium\Tests\TestServer;
use PDO;
use PDOException;

class AuthenticationLimitsTest extends TestCase
{
    public function __construct(TestHttpClient $client)
    {
    }

    private function database(?string $path = null): PDO
    {
        require_once dirname(__DIR__, 2) . '/bootstrap.php';
        $db = new PDO('sqlite:' . ($path ?? ':memory:'));
        $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $db->exec('PRAGMA foreign_keys = ON');
        $db->exec('PRAGMA busy_timeout = 0');
        $db->exec('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT UNIQUE COLLATE NOCASE, is_active INTEGER NOT NULL DEFAULT 1);
            CREATE TABLE IF NOT EXISTS login_rate_limits (username TEXT PRIMARY KEY COLLATE NOCASE, failure_count INTEGER NOT NULL, locked_until INTEGER NOT NULL, updated_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS reauthentication_limits (user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, failure_count INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS password_spray_failures (source_digest TEXT NOT NULL, subject_digest TEXT NOT NULL, failed_at INTEGER NOT NULL, PRIMARY KEY(source_digest, subject_digest));
            CREATE INDEX IF NOT EXISTS idx_password_spray_failures_time ON password_spray_failures(failed_at);
            CREATE TABLE IF NOT EXISTS password_spray_warnings (source_digest TEXT PRIMARY KEY, warned_at INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS idx_password_spray_warnings_time ON password_spray_warnings(warned_at);
            INSERT OR IGNORE INTO users (id, username) VALUES (1, \'alice\'), (2, \'bob\');');
        return $db;
    }

    private function failure(PDO $db, string $subject, string $source = '192.0.2.1', int $now = 1000, string $context = 'login'): ?array
    {
        $db->exec('BEGIN IMMEDIATE');
        try {
            $metadata = PasswordSprayDetector::recordFailure($db, $subject, $context, $source, $now);
            $db->exec('COMMIT');
            return $metadata;
        } catch (\Throwable $e) {
            $db->exec('ROLLBACK');
            throw $e;
        }
    }

    private function assertReauthenticationLocked(PDO $db, int $userId, int $now): void
    {
        try {
            ReauthenticationLimit::assertAllowed($db, $userId, $now);
            $this->fail('Expected a persistent reauthentication lock');
        } catch (ApiException $e) {
            $this->assertSame(429, $e->getHttpStatus());
        }
    }

    public function testReauthenticationThresholdSuccessExpiryAndIndependentAccounts(): void
    {
        $db = $this->database();
        for ($i = 0; $i < 5; $i++) {
            $db->exec('BEGIN IMMEDIATE');
            ReauthenticationLimit::assertAllowed($db, 1, 1000);
            ReauthenticationLimit::recordFailure($db, 1, 1000);
            $db->exec('COMMIT');
        }
        $this->assertReauthenticationLocked($db, 1, 1299);
        ReauthenticationLimit::assertAllowed($db, 2, 1000);
        ReauthenticationLimit::assertAllowed($db, 1, 1300);
        $this->assertSame(0, (int)$db->query('SELECT COUNT(*) FROM reauthentication_limits')->fetchColumn());
        ReauthenticationLimit::recordFailure($db, 1, 1400);
        ReauthenticationLimit::clear($db, 1);
        $this->assertSame(0, (int)$db->query('SELECT COUNT(*) FROM reauthentication_limits')->fetchColumn());
        ReauthenticationLimit::recordFailure($db, 1, 1500);
        ReauthenticationLimit::recordFailure($db, 1, 1800);
        $this->assertSame(1, (int)$db->query('SELECT failure_count FROM reauthentication_limits')->fetchColumn());
        ReauthenticationLimit::clear($db, 1);
        foreach ([1900, 2000, 2100, 2199] as $now) {
            ReauthenticationLimit::recordFailure($db, 1, $now);
        }
        ReauthenticationLimit::recordFailure($db, 1, 2200);
        $this->assertSame(1, (int)$db->query('SELECT failure_count FROM reauthentication_limits')->fetchColumn(), 'The first failure anchors the counting window');
        $db->exec('DELETE FROM users WHERE id = 1');
        $this->assertSame(0, (int)$db->query('SELECT COUNT(*) FROM reauthentication_limits')->fetchColumn());
    }

    public function testLoginThresholdExpiryAndStaleUnlockedCleanup(): void
    {
        $db = $this->database();
        for ($i = 0; $i < 5; $i++) {
            \recordLoginFailure($db, ' Alice ', 1000);
            $this->assertSame($i === 4, \isLoginLocked($db, 'ALICE', 1000));
        }
        $this->assertSame(300, \loginLockRemainingSeconds($db, 'alice', 1000));
        $this->assertTrue(\isLoginLocked($db, 'alice', 1299));
        $this->assertFalse(\isLoginLocked($db, 'alice', 1300));
        \recordLoginFailure($db, 'bob', 1400);
        \recordLoginFailure($db, 'bob', 1700);
        $this->assertSame(1, (int)$db->query("SELECT failure_count FROM login_rate_limits WHERE username = 'bob'")->fetchColumn());
        $this->assertFalse(\isLoginLocked($db, 'bob', 2000));
        $this->assertSame(0, (int)$db->query('SELECT COUNT(*) FROM login_rate_limits')->fetchColumn());
    }

    public function testLoginReservationsConsumeInterruptedAttemptsAndResetOnSuccessOrExpiry(): void
    {
        $db = $this->database();
        for ($i = 0; $i < 5; $i++) {
            $this->assertSame(0, \reserveLoginAttempt($db, ' Alice ', 1000));
            $this->assertSame($i + 1, (int)$db->query("SELECT failure_count FROM login_rate_limits WHERE username='alice'")->fetchColumn());
            $this->assertFalse($db->inTransaction());
        }
        $before = $db->query("SELECT * FROM login_rate_limits WHERE username='alice'")->fetch(PDO::FETCH_ASSOC);
        $this->assertSame(300, \reserveLoginAttempt($db, 'ALICE', 1000));
        $this->assertSame(1, \reserveLoginAttempt($db, 'alice', 1299));
        $this->assertSame($before, $db->query("SELECT * FROM login_rate_limits WHERE username='alice'")->fetch(PDO::FETCH_ASSOC));
        $this->assertSame(0, \reserveLoginAttempt($db, 'bob', 1000));
        \clearLoginFailures($db, 'alice');
        $this->assertSame(0, \reserveLoginAttempt($db, 'alice', 1100));
        $this->assertSame(1, (int)$db->query("SELECT failure_count FROM login_rate_limits WHERE username='alice'")->fetchColumn());
        $this->assertSame(0, \reserveLoginAttempt($db, 'alice', 1400));
        $this->assertSame(1, (int)$db->query("SELECT failure_count FROM login_rate_limits WHERE username='alice'")->fetchColumn());
        for ($i = 0; $i < 4; $i++) \reserveLoginAttempt($db, 'alice', 1500);
        $this->assertSame(0, \reserveLoginAttempt($db, 'alice', 1800));
        $this->assertSame(1, (int)$db->query("SELECT failure_count FROM login_rate_limits WHERE username='alice'")->fetchColumn());
    }

    public function testLoginRejectsInvalidKeysWithoutChangingExistingFailures(): void
    {
        $db = $this->database();
        foreach ([' AbC ', str_repeat('X', 50)] as $username) {
            \recordLoginFailure($db, $username, 1000);
        }
        $before = $db->query('SELECT * FROM login_rate_limits ORDER BY username')->fetchAll(PDO::FETCH_ASSOC);
        $this->assertSame(['abc', str_repeat('x', 50)], array_column($before, 'username'));
        foreach (['', 'ab', str_repeat('X', 51), str_repeat('a', 262144), 'invalid name', '日本語', "bad\0name", "bad\xFFname"] as $invalid) {
            \recordLoginFailure($db, $invalid, 1000);
            $this->assertSame($before, $db->query('SELECT * FROM login_rate_limits ORDER BY username')->fetchAll(PDO::FETCH_ASSOC));
        }
    }

    public function testInvalidLoginHttpPreservesDatabaseAndOmitsInput(): void
    {
        $server = new TestServer();
        $db = null;
        try {
            $server->start();
            $db = new PDO('sqlite:' . $server->getDbPath());
            $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
            $client = new TestHttpClient($server->getBaseUrl());
            $page = $client->get('/login.php');
            $this->assertSame(1, preg_match('/name="csrf_token"\s+value="([^"]+)"/', $page->getBody(), $token));
            $password = 'issue194-password-not-for-output';
            $post = static fn(string $username) => $client->request('POST', '/login.php', http_build_query([
                'username' => $username, 'password' => $password, 'csrf_token' => $token[1],
            ]), ['Content-Type' => 'application/x-www-form-urlencoded']);
            $baseline = $post('admin');
            $this->assertSame(200, $baseline->getStatusCode());
            $this->assertSame(1, preg_match('/<div class="auth-error"[^>]*>\s*(.*?)\s*<\/div>/s', $baseline->getBody(), $error));
            $before = $db->query('SELECT * FROM login_rate_limits')->fetchAll(PDO::FETCH_ASSOC);
            $pages = (int)$db->query('PRAGMA page_count')->fetchColumn();
            $spray = $db->query('SELECT * FROM password_spray_failures')->fetchAll(PDO::FETCH_ASSOC);
            foreach ([
                'issue194-a-' . str_repeat('a', 262133),
                'issue194-b-' . str_repeat('b', 262133),
                'issue194-c-' . str_repeat('c', 262133),
                str_repeat('X', 51), 'ab', 'invalid name', '日本語', "bad\0name", "bad\xFFname", '',
            ] as $invalid) {
                $response = $post($invalid);
                $this->assertSame($baseline->getStatusCode(), $response->getStatusCode());
                $this->assertSame(1, preg_match('/<div class="auth-error"[^>]*>\s*(.*?)\s*<\/div>/s', $response->getBody(), $actualError));
                $this->assertSame($error[1], $actualError[1]);
                $this->assertSame(1, preg_match('/id="login-username"[^>]*value="([^"]*)"/s', $response->getBody(), $field));
                $this->assertSame('', $field[1]);
                $this->assertFalse(str_contains($response->getBody(), $password));
                $this->assertSame($before, $db->query('SELECT * FROM login_rate_limits')->fetchAll(PDO::FETCH_ASSOC));
                $this->assertSame($pages, (int)$db->query('PRAGMA page_count')->fetchColumn());
                $this->assertSame($spray, $db->query('SELECT * FROM password_spray_failures')->fetchAll(PDO::FETCH_ASSOC));
            }
            $entries = [];
            foreach (glob($server->getTempDir() . '/logs/audit/audit-*.log') ?: [] as $file) {
                foreach (file($file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
                    $this->assertFalse(str_contains($line, $password));
                    $entry = json_decode($line, true, flags: JSON_THROW_ON_ERROR);
                    if ($entry['event'] === 'auth.login' && $entry['outcome'] === 'failure') {
                        $entries[] = $entry;
                    }
                }
            }
            $this->assertCount(11, $entries);
            foreach (array_slice($entries, 1) as $entry) {
                $this->assertNull($entry['subject_username']);
                $this->assertSame(401, $entry['http_status']);
                $this->assertSame(['auth_failed'], $entry['codes']);
            }
        } finally {
            $db = null;
            $server->stop();
        }
    }

    public function testUnknownLoginFloodPreservesExistingActiveLocks(): void
    {
        $db = $this->database();
        $stmt = $db->prepare('INSERT INTO login_rate_limits VALUES (?, 5, 1300, ?)');
        $stmt->execute(['alice', date('Y-m-d H:i:s', 999)]);
        $db->exec("WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i < 10001)
            INSERT INTO login_rate_limits SELECT 'unknown-' || i, 1, 0, " . $db->quote(date('Y-m-d H:i:s', 1000)) . ' FROM n');
        \recordLoginFailure($db, 'new-unknown', 1000);
        $this->assertSame(APP_LOGIN_MAX_ROWS, (int)$db->query('SELECT COUNT(*) FROM login_rate_limits')->fetchColumn());
        $this->assertTrue(\isLoginLocked($db, 'alice', 1000));
        \clearLoginFailures($db, 'alice');
        $this->assertFalse(\isLoginLocked($db, 'alice', 1000));
    }

    public function testSprayThresholdCrossContextDuplicateAndCooldown(): void
    {
        $db = $this->database();
        for ($i = 0; $i < 10; $i++) {
            $this->assertNull($this->failure($db, ' Alice ', context: $i % 2 ? 'login' : 'reauth'));
        }
        foreach (['bob', 'carol', 'dave'] as $subject) {
            $this->assertNull($this->failure($db, $subject));
        }
        $metadata = $this->failure($db, 'eve', context: 'reauth');
        $this->assertNotNull($metadata);
        $this->assertSame(5, $metadata['distinct_accounts']);
        $this->assertSame('reauth', $metadata['context']);
        $this->assertMatchesRegex('/^[a-f0-9]{64}$/', $metadata['source_digest']);
        $this->assertMatchesRegex('/^[a-f0-9]{64}$/', $metadata['subject_digest']);
        $this->assertFalse(str_contains(json_encode($metadata), '192.0.2.1'));
        $this->assertFalse(str_contains(json_encode($metadata), 'eve'));
        $this->assertNull($this->failure($db, 'frank', now: 1299));
        $this->assertNull($this->failure($db, 'alice', now: 1300), 'Expired subjects do not count at the boundary');
        foreach (['bob', 'carol', 'dave'] as $subject) {
            $result = $this->failure($db, $subject, now: 1300);
        }
        $this->assertNotNull($result);
        $this->assertNull($this->failure($db, 'eve', now: 1300));
    }

    public function testSpraySourcesAreIndependent(): void
    {
        $db = $this->database();
        foreach (['192.0.2.1', '192.0.2.2'] as $source) {
            foreach (['alice', 'bob', 'carol', 'dave'] as $subject) {
                $this->assertNull($this->failure($db, $subject, $source));
            }
        }
        $this->assertNotNull($this->failure($db, 'eve', '192.0.2.1'));
        $this->assertNotNull($this->failure($db, 'eve', '192.0.2.2'));
        $this->assertSame(2, (int)$db->query('SELECT COUNT(*) FROM password_spray_warnings')->fetchColumn());
        $this->assertNull($this->failure($db, 'sixth', ''));
    }

    public function testSprayRetentionAndRowCaps(): void
    {
        $db = $this->database();
        foreach (['alice', 'bob', 'carol', 'dave', 'eve'] as $subject) {
            $this->failure($db, $subject);
        }
        $this->assertNull($this->failure($db, 'new', now: 4600));
        $this->assertSame(1, (int)$db->query('SELECT COUNT(*) FROM password_spray_failures')->fetchColumn());
        $this->assertSame(0, (int)$db->query('SELECT COUNT(*) FROM password_spray_warnings')->fetchColumn());
        $db->exec("WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i < 10001)
            INSERT INTO password_spray_failures SELECT 'source-' || i, 'subject-' || i, 4600 FROM n");
        $db->exec("WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i < 2001)
            INSERT INTO password_spray_warnings SELECT 'source-' || i, 4600 FROM n");
        $this->failure($db, 'another', now: 4601);
        $this->assertSame(PasswordSprayDetector::MAX_FAILURE_ROWS, (int)$db->query('SELECT COUNT(*) FROM password_spray_failures')->fetchColumn());
        $this->assertSame(PasswordSprayDetector::MAX_WARNING_ROWS, (int)$db->query('SELECT COUNT(*) FROM password_spray_warnings')->fetchColumn());
    }

    public function testSeparateConnectionsSerializeReauthenticationAndSpray(): void
    {
        $path = tempnam(sys_get_temp_dir(), 'netarium-auth-limits-');
        $first = null;
        $second = null;
        try {
            $first = $this->database($path);
            $second = $this->database($path);
            for ($i = 0; $i < 4; $i++) {
                ReauthenticationLimit::recordFailure($first, 1, 1000);
                $this->failure($first, 'account-' . $i);
            }
            $first->exec('BEGIN IMMEDIATE');
            ReauthenticationLimit::assertAllowed($first, 1, 1000);
            ReauthenticationLimit::recordFailure($first, 1, 1000);
            $metadata = PasswordSprayDetector::recordFailure($first, 'account-4', 'reauth', '192.0.2.1', 1000);
            $this->assertNotNull($metadata);
            try {
                $second->exec('BEGIN IMMEDIATE');
                $second->exec('ROLLBACK');
                $this->fail('A competing writer must not enter the credential-check transaction');
            } catch (PDOException $e) {
                $this->assertSame(5, (int)($e->errorInfo[1] ?? 0));
            }
            $first->exec('COMMIT');
            $second->exec('BEGIN IMMEDIATE');
            $this->assertReauthenticationLocked($second, 1, 1000);
            $this->assertNull(PasswordSprayDetector::recordFailure($second, 'account-5', 'login', '192.0.2.1', 1000));
            $second->exec('COMMIT');
            $this->assertSame(5, (int)$first->query('SELECT failure_count FROM reauthentication_limits')->fetchColumn());
            $this->assertSame(1, (int)$first->query('SELECT COUNT(*) FROM password_spray_warnings')->fetchColumn());
        } finally {
            $first = null;
            $second = null;
            if (is_string($path) && is_file($path)) {
                unlink($path);
            }
        }
    }
}
