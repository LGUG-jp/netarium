<?php
declare(strict_types=1);

function authDatabase(): PDO
{
    $directory = dirname(APP_DB_FILE);

    if (!is_dir($directory) || !is_writable($directory)) {
        throw new RuntimeException('データ保存先に書き込み権限がありません');
    }

    return \Netarium\Core\Database::connect(APP_DB_FILE);
}

function hasAnyUser(PDO $db): bool
{
    return (int)$db->query('SELECT COUNT(*) FROM users')->fetchColumn() > 0;
}

function isAuthenticated(): bool
{
    return isset($_SESSION['user_id']) && (int)$_SESSION['user_id'] > 0;
}

function signInUser(array $user): void
{
    startAppSession();
    session_regenerate_id(true);

    $_SESSION['user_id'] = (int)$user['id'];
    $_SESSION['username'] = (string)$user['username'];
    $_SESSION['role'] = (string)$user['role'];
    $_SESSION['auth_revision'] = (int)($user['auth_revision'] ?? 1);
    $_SESSION['password_revision'] = (int)($user['password_revision'] ?? 1);
    $_SESSION['password_changed_at'] = $user['password_changed_at'] ?? null;
    $_SESSION['must_change_password'] = (int)($user['must_change_password'] ?? 0) === 1;
    $_SESSION['authenticated_at'] = time();
    $_SESSION['last_activity'] = time();
    $_SESSION['csrf_token'] = bin2hex(random_bytes(32));

    unset(
        $_SESSION['login_failures'],
        $_SESSION['login_locked_until']
    );
}

function currentUsername(): string
{
    return (string)($_SESSION['username'] ?? '');
}

function currentUserId(): int
{
    return (int)($_SESSION['user_id'] ?? 0);
}

function currentUserRole(): string
{
    return (string)($_SESSION['role'] ?? '');
}

/**
 * DB上の利用者状態を、保護対象リクエストのたびに反映する。
 *
 * role変更は新しいroleへ切り替え、停止またはパスワード変更は
 * 既存セッションを失効させる。
 */
function refreshAuthenticatedUser(): bool
{
    if (!isAuthenticated()) {
        return false;
    }

    try {
        $db = authDatabase();
        $stmt = $db->prepare("
            SELECT
                id,
                username,
                password_hash,
                role,
                is_active,
                auth_revision,
                password_revision,
                password_changed_at,
                must_change_password
            FROM users
            WHERE id = :id
            LIMIT 1
        ");
        $stmt->execute([':id' => currentUserId()]);
        $user = $stmt->fetch();
        \Netarium\Services\Auth\PasswordHashing::assertSupported();
        $config = \Netarium\Core\Config::create();
    } catch (Throwable $e) {
        error_log(
            '[Netarium Auth] 利用者状態の確認に失敗: '
            . get_class($e)
            . ': '
            . $e->getMessage()
        );

        if ($e instanceof PDOException && \Netarium\Core\Database::isBusy($e)) {
            // A transient lock prevents verification, but does not revoke credentials.
            throw $e;
        }

        clearAuthenticationSession();
        return false;
    }

    if (!is_array($user) || (int)$user['is_active'] !== 1) {
        clearAuthenticationSession();
        return false;
    }

    if (
        !$config['allow_legacy_bcrypt'] &&
        password_get_info((string)$user['password_hash'])['algoName'] === 'bcrypt'
    ) {
        clearAuthenticationSession();
        return false;
    }

    if (
        (int)($_SESSION['password_revision'] ?? 1) !==
        (int)$user['password_revision']
    ) {
        clearAuthenticationSession();
        return false;
    }

    if (
        (int)($_SESSION['auth_revision'] ?? 0) !==
            (int)$user['auth_revision'] ||
        currentUsername() !== (string)$user['username'] ||
        currentUserRole() !== (string)$user['role']
    ) {
        $_SESSION['username'] = (string)$user['username'];
        $_SESSION['role'] = (string)$user['role'];
        $_SESSION['auth_revision'] = (int)$user['auth_revision'];
    }

    $_SESSION['password_revision'] = (int)$user['password_revision'];
    $_SESSION['password_changed_at'] = $user['password_changed_at'] ?? null;
    $_SESSION['must_change_password'] = (int)$user['must_change_password'] === 1;

    return true;
}

function mustChangePassword(): bool
{
    return (bool)($_SESSION['must_change_password'] ?? false);
}

function isAdminUser(): bool
{
    return (
        isAuthenticated() &&
        currentUserRole() === 'admin'
    );
}
