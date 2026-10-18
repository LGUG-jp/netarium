<?php
declare(strict_types=1);

namespace Netarium\Services\Auth;

use Netarium\Core\ApiException;
use PDO;

final class ReauthenticationLimit
{
    public const MAX_FAILURES = 5;
    public const LOCK_SECONDS = 300;

    // The caller owns BEGIN IMMEDIATE through credential verification and update.
    // Failed attempts must be committed before throwing the credential error.
    // updated_at anchors the first failure in the 300-second counting window;
    // later failures do not slide that window or extend an existing lock.
    public static function assertAllowed(PDO $db, int $userId, ?int $now = null): void
    {
        $now ??= time();
        $cleanup = $db->prepare('DELETE FROM reauthentication_limits WHERE (locked_until > 0 AND locked_until <= ?) OR (locked_until = 0 AND updated_at <= ?)');
        $cleanup->execute([$now, $now - self::LOCK_SECONDS]);
        $stmt = $db->prepare('SELECT locked_until FROM reauthentication_limits WHERE user_id = ?');
        $stmt->execute([$userId]);
        if ((int)$stmt->fetchColumn() > $now) {
            throw new ApiException('再認証の試行回数が上限に達しました。しばらく待ってから再試行してください', 429);
        }
    }

    public static function recordFailure(PDO $db, int $userId, ?int $now = null): void
    {
        $now ??= time();
        $stmt = $db->prepare('INSERT INTO reauthentication_limits (user_id, failure_count, locked_until, updated_at)
            VALUES (:user_id, 1, 0, :now)
            ON CONFLICT(user_id) DO UPDATE SET
                failure_count = CASE
                    WHEN (locked_until > 0 AND locked_until <= :now) OR (locked_until = 0 AND updated_at <= :cutoff) THEN 1
                    ELSE MIN(failure_count + 1, :max_failures) END,
                locked_until = CASE
                    WHEN locked_until > :now THEN locked_until
                    WHEN (locked_until > 0 AND locked_until <= :now) OR (locked_until = 0 AND updated_at <= :cutoff) THEN 0
                    WHEN failure_count + 1 >= :max_failures THEN :until ELSE 0 END,
                updated_at = CASE
                    WHEN (locked_until > 0 AND locked_until <= :now) OR (locked_until = 0 AND updated_at <= :cutoff) THEN :now
                    ELSE updated_at END');
        $stmt->bindValue(':user_id', $userId, PDO::PARAM_INT);
        $stmt->bindValue(':now', $now, PDO::PARAM_INT);
        $stmt->bindValue(':cutoff', $now - self::LOCK_SECONDS, PDO::PARAM_INT);
        $stmt->bindValue(':max_failures', self::MAX_FAILURES, PDO::PARAM_INT);
        $stmt->bindValue(':until', $now + self::LOCK_SECONDS, PDO::PARAM_INT);
        $stmt->execute();
    }

    public static function clear(PDO $db, int $userId): void
    {
        $stmt = $db->prepare('DELETE FROM reauthentication_limits WHERE user_id = ?');
        $stmt->execute([$userId]);
    }
}
