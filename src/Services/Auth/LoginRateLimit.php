<?php
declare(strict_types=1);

const APP_LOGIN_MAX_FAILURES = 5;
const APP_LOGIN_LOCK_SECONDS = 300;
const APP_LOGIN_MAX_ROWS = 10000;

function normalizeLoginUsername(string $username): string
{
    return strtolower(trim($username));
}

function cleanupLoginFailures(PDO $db, int $now): void
{
    $stmt = $db->prepare('DELETE FROM login_rate_limits
        WHERE (locked_until > 0 AND locked_until <= :now)
           OR (locked_until = 0 AND updated_at <= :cutoff)');
    $stmt->execute([':now' => $now, ':cutoff' => date('Y-m-d H:i:s', $now - APP_LOGIN_LOCK_SECONDS)]);
    // Active users' unexpired locks must survive an unknown-name flood.
    // If protected locks alone exceed the cap, only those rows may exceed it.
    $stmt = $db->prepare('DELETE FROM login_rate_limits WHERE username IN (
        SELECT limits.username FROM login_rate_limits AS limits
        WHERE NOT (limits.locked_until > :now AND EXISTS (
            SELECT 1 FROM users WHERE users.username = limits.username COLLATE NOCASE AND users.is_active = 1
        ))
        ORDER BY limits.updated_at ASC, limits.username ASC
        LIMIT MAX(0, (SELECT COUNT(*) FROM login_rate_limits) - :cap)
    )');
    $stmt->bindValue(':now', $now, PDO::PARAM_INT);
    $stmt->bindValue(':cap', APP_LOGIN_MAX_ROWS, PDO::PARAM_INT);
    $stmt->execute();
}

function isLoginLocked(PDO $db, string $username, ?int $now = null): bool
{
    $now ??= time();
    cleanupLoginFailures($db, $now);
    return loginLockRemainingSeconds($db, $username, $now) > 0;
}

function loginLockRemainingSeconds(PDO $db, string $username, ?int $now = null): int
{
    $stmt = $db->prepare('SELECT locked_until FROM login_rate_limits WHERE username = ?');
    $stmt->execute([normalizeLoginUsername($username)]);
    return max(0, (int)$stmt->fetchColumn() - ($now ?? time()));
}

/**
 * Reserve before password verification, without retaining a database writer lock.
 * failure_count includes in-flight attempts; interrupted attempts remain consumed.
 */
function reserveLoginAttempt(PDO $db, string $username, ?int $now = null): int
{
    $now ??= time();
    $db->exec('BEGIN IMMEDIATE');
    try {
        cleanupLoginFailures($db, $now);
        $remaining = loginLockRemainingSeconds($db, $username, $now);
        if ($remaining === 0) {
            recordLoginFailure($db, $username, $now);
        }
        $db->exec('COMMIT');
        return $remaining;
    } catch (Throwable $e) {
        if ($db->inTransaction()) {
            $db->exec('ROLLBACK');
        }
        throw $e;
    }
}

function recordLoginFailure(PDO $db, string $username, ?int $now = null): void
{
    // Keep every persisted key within the account username contract.
    if (validateUsername(trim($username)) !== null) {
        return;
    }
    $now ??= time();
    // Atomic UPSERT; caller may include this in its BEGIN IMMEDIATE transaction.
    $stmt = $db->prepare('INSERT INTO login_rate_limits (username, failure_count, locked_until, updated_at)
        VALUES (:username, 1, 0, :updated_at)
        ON CONFLICT(username) DO UPDATE SET
            failure_count = CASE
                WHEN (locked_until > 0 AND locked_until <= :now) OR (locked_until = 0 AND updated_at <= :cutoff) THEN 1
                ELSE MIN(failure_count + 1, :max_failures) END,
            locked_until = CASE
                WHEN locked_until > :now THEN locked_until
                WHEN (locked_until > 0 AND locked_until <= :now) OR (locked_until = 0 AND updated_at <= :cutoff) THEN 0
                WHEN failure_count + 1 >= :max_failures THEN :until ELSE 0 END,
            updated_at = :updated_at');
    $stmt->bindValue(':username', normalizeLoginUsername($username), PDO::PARAM_STR);
    $stmt->bindValue(':now', $now, PDO::PARAM_INT);
    $stmt->bindValue(':updated_at', date('Y-m-d H:i:s', $now), PDO::PARAM_STR);
    $stmt->bindValue(':cutoff', date('Y-m-d H:i:s', $now - APP_LOGIN_LOCK_SECONDS), PDO::PARAM_STR);
    $stmt->bindValue(':max_failures', APP_LOGIN_MAX_FAILURES, PDO::PARAM_INT);
    $stmt->bindValue(':until', $now + APP_LOGIN_LOCK_SECONDS, PDO::PARAM_INT);
    $stmt->execute();
    cleanupLoginFailures($db, $now);
}

function clearLoginFailures(PDO $db, string $username): void
{
    $stmt = $db->prepare(
        'DELETE FROM login_rate_limits WHERE username = :username'
    );
    $stmt->execute([
        ':username' => normalizeLoginUsername($username),
    ]);
}
