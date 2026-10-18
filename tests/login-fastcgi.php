<?php
declare(strict_types=1);

// Explicit binary only: this does not discover runtimes or modify IIS configuration.
require_once __DIR__ . '/TestCase.php';
require_once __DIR__ . '/TestHttpClient.php';
require_once __DIR__ . '/TestServer.php';
require_once __DIR__ . '/helpers/FastCgiWorker.php';

use Netarium\Core\Database;
use Netarium\Tests\Helpers\FastCgiWorker;
use Netarium\Tests\TestCase;
use Netarium\Tests\TestHttpClient;
use Netarium\Tests\TestServer;

final class LoginFastCgiTest extends TestCase
{
    private TestServer $fixture;
    private PDO $db;
    private array $workers = [];
    private string $trace;
    private string $release;

    private function entries(): array
    {
        return is_file($this->trace) ? array_map(
            static fn(string $line) => json_decode($line, true, flags: JSON_THROW_ON_ERROR),
            file($this->trace, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES)
        ) : [];
    }

    private function terminals(): array
    {
        $entries = [];
        foreach (glob($this->fixture->getTempDir() . '/logs/audit/*.log') ?: [] as $file) {
            foreach (file($file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
                $entry = json_decode($line, true, flags: JSON_THROW_ON_ERROR);
                if ($entry['event'] === 'auth.login' && $entry['outcome'] !== 'started') $entries[] = $entry;
            }
        }
        return $entries;
    }

    private function anonymous(int $worker): array
    {
        $page = $this->workers[$worker]->request('/login.php');
        $this->assertSame(200, $page['status']);
        $this->assertSame(1, preg_match('/name="csrf_token"\s+value="([^"]+)"/', $page['body'], $token));
        $cookie = explode(';', $page['headers']['set-cookie'] ?? '')[0];
        $this->assertTrue($cookie !== '');
        return ['cookie' => $cookie, 'token' => $token[1]];
    }

    private function form(array $session, bool $correct = false): array
    {
        return ['username' => ' ADMIN ', 'password' => $correct ? 'admin123' : 'synthetic-wrong-204', 'csrf_token' => $session['token']];
    }

    private function reset(int $failures): void
    {
        foreach ([$this->trace, $this->release] as $file) if (is_file($file)) unlink($file);
        $this->db->exec('DELETE FROM login_rate_limits');
        $this->db->exec('DELETE FROM password_spray_failures');
        for ($i = 0; $i < $failures; $i++) recordLoginFailure($this->db, 'admin');
    }

    private function waitForVerification(): void
    {
        $deadline = microtime(true) + 5;
        while ($this->entries() === [] && microtime(true) < $deadline) usleep(10000);
        $this->assertTrue($this->entries() !== [], 'FastCGI did not enter the real password verifier');
    }

    private function count(): int
    {
        return (int)$this->db->query("SELECT failure_count FROM login_rate_limits WHERE username='admin'")->fetchColumn();
    }

    private function report(string $scenario, string $journal, array $details = []): void
    {
        echo json_encode(['scenario' => $scenario, 'journal' => $journal, 'result' => 'PASS'] + $details,
            JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR) . "\n";
    }

    private function lastSlot(string $journal, bool $firstCorrect, bool $secondCorrect = false, string $authenticatedViewerCookie = ''): void
    {
        $this->reset(4);
        $a = $this->anonymous(0);
        $b = $this->anonymous(1);
        $before = count($this->terminals());
        $first = $this->workers[0]->begin('/login.php', 'POST', $this->form($a, $firstCorrect), $a['cookie']);
        $this->waitForVerification();
        try {
            $this->assertSame(5, $this->count(), 'The last slot must be committed before verification');
            // A separate writer must commit while Argon2 is deliberately paused, in both journals.
            $revision = (int)$this->db->query("SELECT meta_value FROM app_meta WHERE meta_key='data_revision'")->fetchColumn();
            $this->db->exec('PRAGMA busy_timeout=100');
            $this->db->exec("UPDATE app_meta SET meta_value=CAST(meta_value AS INTEGER)+1 WHERE meta_key='data_revision'");
            $this->assertSame($revision + 1, (int)$this->db->query("SELECT meta_value FROM app_meta WHERE meta_key='data_revision'")->fetchColumn());
            if ($authenticatedViewerCookie !== '') {
                $authenticatedRead = $this->workers[1]->request('/api.php?action=load', 'GET', [], $authenticatedViewerCookie);
                $this->assertSame(200, $authenticatedRead['status']);
                $this->assertSame('viewer', json_decode($authenticatedRead['body'], true, flags: JSON_THROW_ON_ERROR)['user']['role']);
            }
            $second = $this->workers[1]->request('/login.php', 'POST', $this->form($b, $secondCorrect), $b['cookie']);
            $this->assertSame(200, $second['status']);
            $this->assertCount(1, $this->entries(), 'A rejected candidate must never enter password_verify');
        } finally {
            $this->db->exec('PRAGMA busy_timeout=5000');
            file_put_contents($this->release, 'release');
        }
        $response = $this->workers[0]->finish($first);
        $this->assertSame($firstCorrect ? 302 : 200, $response['status']);
        if ($firstCorrect) {
            $signedInCookie = explode(';', $response['headers']['set-cookie'] ?? '')[0];
            $this->assertTrue($signedInCookie !== '');
            $load = $this->workers[1]->request('/api.php?action=load', 'GET', [], $signedInCookie);
            $this->assertSame(200, $load['status']);
            $this->assertSame(true, json_decode($load['body'], true, flags: JSON_THROW_ON_ERROR)['ok']);
        }
        $trace = $this->entries();
        $this->assertSame(['entered', 'verified'], array_column($trace, 'phase'));
        $this->assertSame($firstCorrect, $trace[1]['valid']);
        $this->assertSame($this->workers[0]->getPid(), $trace[0]['pid']);
        $this->assertSame('cgi-fcgi', $trace[0]['sapi']);
        $terminal = array_slice($this->terminals(), $before);
        $this->assertCount(2, $terminal);
        $this->assertSame([429, $firstCorrect ? 200 : 401], array_column($terminal, 'http_status'));
        $this->assertSame(['rate_limited'], $terminal[0]['codes']);
        $this->assertSame($firstCorrect ? 0 : 5, $this->count());
        $this->assertSame($firstCorrect ? 0 : 1, (int)$this->db->query('SELECT COUNT(*) FROM password_spray_failures')->fetchColumn());
        $scenarioName = $firstCorrect ? 'last_slot_success' : ($secondCorrect ? 'last_slot_wrong_correct' : 'last_slot_wrong_wrong');
        $this->report($scenarioName, $journal,
            ['verifications' => 1, 'response_statuses' => [$response['status'], $second['status']], 'audit_statuses' => array_column($terminal, 'http_status'), 'counter' => $this->count(), 'business_writer' => 'committed', 'authenticated_read' => $authenticatedViewerCookie !== '' ? 'allowed' : 'skipped']);
    }

    private function interrupted(string $journal): void
    {
        $this->reset(4);
        $a = $this->anonymous(0);
        $b = $this->anonymous(1);
        $this->workers[0]->begin('/login.php', 'POST', $this->form($a), $a['cookie']);
        $this->waitForVerification();
        $this->workers[0]->stop();
        $this->assertSame(5, $this->count());
        $before = count($this->terminals());
        $response = $this->workers[1]->request('/login.php', 'POST', $this->form($b, true), $b['cookie']);
        $this->assertSame(200, $response['status']);
        $this->assertCount(1, $this->entries());
        $terminal = array_slice($this->terminals(), $before);
        $this->assertSame([429], array_column($terminal, 'http_status'));
        $this->assertSame(5, $this->count());
        // Clock boundary is injected; this is not evidence of a real 300-second wait.
        $this->db->exec('UPDATE login_rate_limits SET locked_until=' . (time() - 1));
        file_put_contents($this->release, 'release');
        $response = $this->workers[1]->request('/login.php', 'POST', $this->form($b, true), $b['cookie']);
        $this->assertSame(302, $response['status']);
        $this->assertSame(0, $this->count());
        $this->workers[0]->start();
        $this->report('worker_interruption_and_expiry', $journal, ['counter_after_interruption' => 5, 'after_injected_expiry' => 302]);
    }

    private function delayedLoginPasswordChangeRace(string $journal): void
    {
        $this->reset(0);
        $admin = new TestHttpClient($this->fixture->getBaseUrl());
        $this->assertTrue($admin->login('admin', 'admin123'));
        $username = 'race222' . $journal;
        $oldPassword = 'Initial-password-222!';
        $newPassword = 'Changed-password-222!';
        $admin->postJson('/api.php?action=create_user', [
            'username' => $username, 'password' => $oldPassword,
            'password_confirm' => $oldPassword, 'role' => 'viewer',
        ])->assertOk();
        $userStmt = $this->db->prepare('SELECT id, password_hash, password_revision, auth_revision, last_login_at FROM users WHERE username = ?');
        $userStmt->execute([$username]);
        $original = $userStmt->fetch(PDO::FETCH_ASSOC);
        $userStmt->closeCursor();
        $this->assertTrue(is_array($original));
        $lockStmt = $this->db->prepare('SELECT failure_count, locked_until, updated_at FROM login_rate_limits WHERE username = ?');
        $lock = static function () use ($lockStmt, $username): array|false {
            $lockStmt->execute([$username]);
            $row = $lockStmt->fetch(PDO::FETCH_ASSOC);
            $lockStmt->closeCursor();
            return $row;
        };
        $a = $this->anonymous(0);
        $b = $this->anonymous(1);
        $before = count($this->terminals());
        $first = $this->workers[0]->begin('/login.php', 'POST', [
            'username' => $username, 'password' => $oldPassword, 'csrf_token' => $a['token'],
        ], $a['cookie']);
        $this->waitForVerification();
        $wrongForm = ['username' => $username, 'password' => 'synthetic-wrong-222', 'csrf_token' => $b['token']];
        try {
            $admin->postJson('/api.php?action=reset_user_password', [
                'id' => (int)$original['id'], 'password' => $newPassword, 'password_confirm' => $newPassword,
            ])->assertOk();
            $userStmt->execute([$username]);
            $changed = $userStmt->fetch(PDO::FETCH_ASSOC);
            $userStmt->closeCursor();
            $this->assertFalse($changed['password_hash'] === $original['password_hash']);
            $this->assertSame((int)$original['password_revision'] + 1, (int)$changed['password_revision']);
            $this->assertSame((int)$original['auth_revision'] + 1, (int)$changed['auth_revision']);
            $this->assertSame(false, $lock(), 'Password reset must remove the old reservation');
            for ($i = 1; $i <= 5; $i++) {
                $failed = $this->workers[1]->request('/login.php', 'POST', $wrongForm, $b['cookie']);
                $this->assertSame(200, $failed['status']);
                $this->assertSame($i, (int)$lock()['failure_count']);
            }
            $locked = $lock();
            $this->assertTrue((int)$locked['locked_until'] > time());
            $this->assertCount(11, $this->entries(), 'Old verification plus five real failures must enter the verifier');
            $sixth = $this->workers[1]->request('/login.php', 'POST', $wrongForm, $b['cookie']);
            $this->assertSame(200, $sixth['status']);
            $this->assertCount(11, $this->entries(), 'The sixth candidate must not enter password_verify');
            $this->assertSame($locked, $lock());
        } finally {
            file_put_contents($this->release, 'release');
        }
        $response = $this->workers[0]->finish($first);
        $this->assertSame(200, $response['status'], 'Delayed login with superseded credentials must be rejected');
        $this->assertSame($locked, $lock(), 'Delayed login must preserve the entire new lock row');
        $userStmt->execute([$username]);
        $after = $userStmt->fetch(PDO::FETCH_ASSOC);
        $userStmt->closeCursor();
        $this->assertSame($changed, $after, 'Delayed login must not update last_login_at or credentials');
        $seventh = $this->workers[1]->request('/login.php', 'POST', $wrongForm, $b['cookie']);
        $this->assertSame(200, $seventh['status']);
        $trace = $this->entries();
        $this->assertCount(12, $trace, 'The seventh candidate must remain blocked');
        $verified = array_values(array_filter($trace, static fn(array $entry) => $entry['phase'] === 'verified'));
        $this->assertSame([false, false, false, false, false, true], array_column($verified, 'valid'));
        $entered = array_values(array_filter($trace, static fn(array $entry) => $entry['phase'] === 'entered'));
        $this->assertSame([$this->workers[0]->getPid(), ...array_fill(0, 5, $this->workers[1]->getPid())], array_column($entered, 'pid'));
        $cookie = explode(';', $response['headers']['set-cookie'] ?? $a['cookie'])[0];
        $this->assertSame(401, $this->workers[1]->request('/api.php?action=load', 'GET', [], $cookie)['status']);
        $this->assertSame([401, 401, 401, 401, 401, 429, 401, 429],
            array_column(array_slice($this->terminals(), $before), 'http_status'));
        $this->report('delayed_login_password_change_race', $journal, [
            'counter' => (int)$lock()['failure_count'], 'delayed_status' => $response['status'],
            'reset_api' => 'committed', 'new_generation_failures' => 5,
            'lock_preserved' => true, 'last_login_preserved' => true, 'old_cookie_api_status' => 401,
        ]);
    }

    private function busy(string $journal, bool $afterReservation): void
    {
        $this->reset(0);
        $session = $this->anonymous(0);
        $before = count($this->terminals());
        if ($afterReservation) {
            $socket = $this->workers[0]->begin('/login.php', 'POST', $this->form($session, true), $session['cookie']);
            $this->waitForVerification();
        }
        $this->db->exec('BEGIN IMMEDIATE');
        try {
            file_put_contents($this->release, 'release');
            $response = $afterReservation ? $this->workers[0]->finish($socket)
                : $this->workers[0]->request('/login.php', 'POST', $this->form($session, true), $session['cookie']);
            $this->assertSame(503, $response['status']);
        } finally {
            $this->db->exec('ROLLBACK');
        }
        $this->assertSame($afterReservation ? 1 : 0, $this->count());
        $this->assertCount($afterReservation ? 2 : 0, $this->entries());
        $terminal = array_slice($this->terminals(), $before);
        $this->assertSame([503], array_column($terminal, 'http_status'));
        $this->assertSame('failure', $terminal[0]['outcome']);
        $this->assertSame(401, $this->workers[1]->request('/api.php?action=load', 'GET', [], $session['cookie'])['status']);
        // The same anonymous Cookie/CSRF still works after busy; no session is established on 503.
        $this->assertSame(302, $this->workers[0]->request('/login.php', 'POST', $this->form($session, true), $session['cookie'])['status']);
        $this->assertSame(0, $this->count());
        $this->report($afterReservation ? 'busy_after_verification' : 'busy_before_reservation', $journal,
            ['status' => 503, 'counter_on_busy' => $afterReservation ? 1 : 0, 'retry_status' => 302]);
    }

    private function invalidCsrf(string $journal): void
    {
        $this->reset(4);
        $session = $this->anonymous(0);
        $form = $this->form($session);
        $form['csrf_token'] = 'synthetic-invalid-csrf';
        $before = count($this->terminals());
        $this->assertSame(200, $this->workers[0]->request('/login.php', 'POST', $form, $session['cookie'])['status']);
        $this->assertSame(4, $this->count());
        $this->assertSame([], $this->entries());
        $this->assertSame([403], array_column(array_slice($this->terminals(), $before), 'http_status'));
        $this->report('csrf_does_not_consume_slot', $journal);
    }

    public function run(string $binary): void
    {
        $this->fixture = new TestServer();
        try {
            $this->fixture->start();
            $storage = $this->fixture->getTempDir();
            $this->trace = $storage . '/verify.jsonl';
            $this->release = $storage . '/release';
            $prepend = $storage . '/observe-verify.php';
            // Real password_verify is called; the seam only pauses and records non-secret outcomes.
            file_put_contents($prepend, '<?php namespace Netarium\\Services\\Auth; function password_verify($password, $hash): bool { '
                . 'if (!in_array($password, ["synthetic-wrong-204", "admin123", "Initial-password-222!", "synthetic-wrong-222"], true)) { return \\password_verify($password, $hash); } '
                . '$trace=' . var_export($this->trace, true) . '; $release=' . var_export($this->release, true) . '; '
                . 'file_put_contents($trace,json_encode(["phase"=>"entered","pid"=>getmypid(),"sapi"=>PHP_SAPI,"php"=>PHP_VERSION,"sqlite"=>\\SQLite3::version()["versionString"]])."\\n",FILE_APPEND|LOCK_EX); '
                . 'if ($password !== "synthetic-wrong-222") { $deadline=microtime(true)+15; while(!is_file($release)&&microtime(true)<$deadline){clearstatcache(true,$release);usleep(10000);} '
                . 'if(!is_file($release))throw new \\RuntimeException("Verification barrier timed out"); } '
                . '$valid=\\password_verify($password,$hash);file_put_contents($trace,json_encode(["phase"=>"verified","pid"=>getmypid(),"valid"=>$valid])."\\n",FILE_APPEND|LOCK_EX);return $valid; }');
            $this->db = new PDO('sqlite:' . $this->fixture->getDbPath());
            Database::configure($this->db);
            for ($i = 0; $i < 2; $i++) {
                $worker = new FastCgiWorker($binary, dirname(__DIR__), $storage, $this->fixture->getDbPath(), $prepend);
                $this->workers[] = $worker;
                $worker->start();
            }
            $this->assertNotSame($this->workers[0]->getPid(), $this->workers[1]->getPid());
            $viewerSession = $this->anonymous(1);
            $viewerLogin = $this->workers[1]->request('/login.php', 'POST', [
                'username' => 'viewer', 'password' => 'viewer123', 'csrf_token' => $viewerSession['token'],
            ], $viewerSession['cookie']);
            $this->assertSame(302, $viewerLogin['status']);
            $viewerCookie = explode(';', $viewerLogin['headers']['set-cookie'] ?? '')[0];
            $this->assertTrue($viewerCookie !== '');
            foreach (['delete', 'wal'] as $journal) {
                $this->assertSame($journal, $this->db->query('PRAGMA journal_mode=' . $journal)->fetchColumn());
                $this->lastSlot($journal, false, false, $viewerCookie);
                $this->lastSlot($journal, false, true, $viewerCookie);
                $this->lastSlot($journal, true, false, $viewerCookie);
                $this->invalidCsrf($journal);
                $this->busy($journal, false);
                $this->busy($journal, true);
                $this->interrupted($journal);
                $this->delayedLoginPasswordChangeRace($journal);
            }
            $entered = array_values(array_filter($this->entries(), static fn(array $entry) => $entry['phase'] === 'entered'));
            echo json_encode(['result' => 'PASS', 'scenarios' => 16, 'assertions' => $this->getAssertionsCount(),
                'sapi' => $entered[0]['sapi'], 'php' => $entered[0]['php'], 'sqlite' => $entered[0]['sqlite'],
                'workers' => 2, 'observed_verify_pids' => array_values(array_unique(array_column($entered, 'pid'))),
                'iis_acceptance' => 'NOT_RUN'], JSON_THROW_ON_ERROR) . "\n";
        } finally {
            if (isset($this->db) && $this->db->inTransaction()) $this->db->exec('ROLLBACK');
            foreach (array_reverse($this->workers) as $worker) $worker->stop();
            unset($this->db);
            $this->fixture->stop();
        }
    }
}

$options = getopt('', ['php-cgi:']);
if (!is_string($options['php-cgi'] ?? null) || $options['php-cgi'] === '') {
    fwrite(STDERR, "Usage: php tests/login-fastcgi.php --php-cgi=<explicit php-cgi binary or PATH command>\n");
    exit(2);
}
try {
    (new LoginFastCgiTest())->run($options['php-cgi']);
} catch (Throwable $e) {
    // Assertion diagnostics contain only statuses/counters; never dump responses, cookies or request fields.
    fwrite(STDERR, get_class($e) . ': ' . $e->getMessage() . "\n");
    exit(1);
}
