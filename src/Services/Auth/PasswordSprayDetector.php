<?php
declare(strict_types=1);

namespace Netarium\Services\Auth;

use InvalidArgumentException;
use PDO;

final class PasswordSprayDetector
{
    public const WINDOW_SECONDS = 300;
    public const DISTINCT_ACCOUNTS = 5;
    public const COOLDOWN_SECONDS = 300;
    public const RETENTION_SECONDS = 3600;
    public const MAX_FAILURE_ROWS = 10000;
    public const MAX_WARNING_ROWS = 2000;

    // Call only for failed credentials, inside the caller's BEGIN IMMEDIATE.
    // remoteAddr must come from REMOTE_ADDR, never a forwarding header. This
    // detector reports warnings only: shared/NAT sources are never locked out.
    // Use the same canonical account subject for login and reauthentication.
    public static function recordFailure(
        PDO $db,
        string $subject,
        string $context,
        string $remoteAddr,
        ?int $now = null
    ): ?array {
        if (!in_array($context, ['login', 'reauth'], true)) {
            throw new InvalidArgumentException('Unsupported authentication context');
        }
        $now ??= time();
        self::cleanup($db, $now);
        if ($remoteAddr === '') {
            return null;
        }
        // Canonicalize equivalent IPv6 forms without consulting proxy headers.
        $packed = @inet_pton($remoteAddr);
        $sourceDigest = hash('sha256', 'source:' . ($packed === false ? $remoteAddr : $packed));
        $subjectDigest = hash('sha256', 'account:' . strtolower(trim($subject)));
        $stmt = $db->prepare('INSERT INTO password_spray_failures (source_digest, subject_digest, failed_at) VALUES (?, ?, ?)
            ON CONFLICT(source_digest, subject_digest) DO UPDATE SET failed_at = excluded.failed_at');
        $stmt->execute([$sourceDigest, $subjectDigest, $now]);
        $count = $db->prepare('SELECT COUNT(*) FROM password_spray_failures WHERE source_digest = ? AND failed_at > ?');
        $count->execute([$sourceDigest, $now - self::WINDOW_SECONDS]);
        $distinct = (int)$count->fetchColumn();
        $metadata = null;
        if ($distinct >= self::DISTINCT_ACCOUNTS) {
            $warning = $db->prepare('INSERT INTO password_spray_warnings (source_digest, warned_at) VALUES (:source, :now)
                ON CONFLICT(source_digest) DO UPDATE SET warned_at = excluded.warned_at
                WHERE password_spray_warnings.warned_at <= :cutoff');
            $warning->execute([':source' => $sourceDigest, ':now' => $now, ':cutoff' => $now - self::COOLDOWN_SECONDS]);
            if ($warning->rowCount() > 0) {
                $metadata = [
                    'source_digest' => $sourceDigest,
                    'subject_digest' => $subjectDigest,
                    'context' => $context,
                    'distinct_accounts' => $distinct,
                    'window_seconds' => self::WINDOW_SECONDS,
                    'threshold' => self::DISTINCT_ACCOUNTS,
                ];
            }
        }
        self::trim($db);
        return $metadata;
    }

    private static function cleanup(PDO $db, int $now): void
    {
        $stmt = $db->prepare('DELETE FROM password_spray_failures WHERE failed_at <= ?');
        $stmt->execute([$now - self::RETENTION_SECONDS]);
        $stmt = $db->prepare('DELETE FROM password_spray_warnings WHERE warned_at <= ?');
        $stmt->execute([$now - self::RETENTION_SECONDS]);
        self::trim($db);
    }

    private static function trim(PDO $db): void
    {
        $db->exec('DELETE FROM password_spray_failures WHERE rowid IN (
            SELECT rowid FROM password_spray_failures ORDER BY failed_at DESC, rowid DESC
            LIMIT -1 OFFSET ' . self::MAX_FAILURE_ROWS . ')');
        $db->exec('DELETE FROM password_spray_warnings WHERE rowid IN (
            SELECT rowid FROM password_spray_warnings ORDER BY warned_at DESC, rowid DESC
            LIMIT -1 OFFSET ' . self::MAX_WARNING_ROWS . ')');
    }
}
