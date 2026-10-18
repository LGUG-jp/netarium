<?php
declare(strict_types=1);

namespace Netarium\Services\Auth;

use Netarium\Core\ApiException;
use Netarium\Core\AuditLog;
use Netarium\Repositories\AppMetaRepository;
use PDO;
use Throwable;

final class InitialSetup
{
    public const SECRET_KEY = 'setup_bootstrap_sha256';
    public const COMPLETED_KEY = 'setup_completed';

    public static function isClosed(PDO $db): bool
    {
        return \hasAnyUser($db)
            || (new AppMetaRepository($db))->get(self::COMPLETED_KEY) === '1';
    }

    public static function issueSecret(PDO $db, #[\SensitiveParameter] string $secret): void
    {
        $started = false;
        try {
            $db->exec('BEGIN IMMEDIATE');
            $started = true;
            self::requireOpen($db);
            if (preg_match('/\A[0-9a-f]{64}\z/', $secret) !== 1) {
                throw new ApiException('初期設定用の秘密が不正です', 403);
            }
            (new AppMetaRepository($db))->set(self::SECRET_KEY, hash('sha256', $secret));
            $db->exec('COMMIT');
            $started = false;
        } catch (Throwable $e) {
            if ($started) {
                $db->exec('ROLLBACK');
            }
            throw self::publicException($e);
        }
    }

    public static function createAdmin(
        PDO $db,
        array $config,
        #[\SensitiveParameter] string $secret,
        string $username,
        #[\SensitiveParameter] string $password,
        #[\SensitiveParameter] string $passwordConfirm
    ): void {
        $started = false;
        $auditStarted = false;
        try {
            $db->exec('BEGIN IMMEDIATE');
            $started = true;
            self::requireOpen($db);
            $meta = new AppMetaRepository($db);
            $digest = $meta->get(self::SECRET_KEY);
            if (preg_match('/\A[0-9a-f]{64}\z/', $secret) !== 1
                || $digest === '' || !hash_equals($digest, hash('sha256', $secret))) {
                throw new ApiException('初期設定用の秘密を確認してください', 403);
            }
            $error = \validateUsername($username) ?? \validatePassword($password, $username);
            if ($error !== null) {
                throw new ApiException($error, 400);
            }
            if ($password !== $passwordConfirm) {
                throw new ApiException('確認用パスワードが一致しません', 400);
            }
            $passwordHash = PasswordHashing::hash($password);
            AuditLog::begin($config, 'setup.create_admin', null, $db);
            $auditStarted = true;
            $now = date('Y-m-d H:i:s');
            $stmt = $db->prepare("INSERT INTO users
                (username, password_hash, role, is_active, created_at, updated_at)
                VALUES (:username, :password_hash, 'admin', 1, :created_at, :updated_at)");
            $stmt->execute([
                ':username' => $username,
                ':password_hash' => $passwordHash,
                ':created_at' => $now,
                ':updated_at' => $now,
            ]);
            $userId = (int)$db->lastInsertId();
            $stmt = $db->prepare('DELETE FROM app_meta WHERE meta_key = :key');
            $stmt->execute([':key' => self::SECRET_KEY]);
            $meta->set(self::COMPLETED_KEY, '1');
            if (!AuditLog::finish('success', ['target_type' => 'user', 'target_id' => $userId], 200)) {
                throw new ApiException('現在、初期設定を実行できません。管理者へお問い合わせください', 503);
            }
            $db->exec('COMMIT');
            $started = false;
        } catch (Throwable $e) {
            if ($started) {
                $db->exec('ROLLBACK');
            }
            if ($auditStarted && !AuditLog::isFinished()) {
                try {
                    AuditLog::finish('failure', ['target_type' => 'user'], 503);
                } catch (Throwable $auditError) {
                    // 監査側の障害でも、登録と秘密状態のロールバックを優先する。
                }
            }
            throw self::publicException($e);
        }
    }

    private static function requireOpen(PDO $db): void
    {
        if (self::isClosed($db)) {
            throw new ApiException('初期設定は完了しています', 409);
        }
    }

    private static function publicException(Throwable $e): ApiException
    {
        return $e instanceof ApiException ? $e : new ApiException(
            '現在、初期設定を実行できません。管理者へお問い合わせください',
            503
        );
    }
}
