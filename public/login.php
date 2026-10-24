<?php
declare(strict_types=1);

require_once dirname(__DIR__) . '/bootstrap.php';

use Netarium\Core\ApiException;
use Netarium\Core\AuditLog;
use Netarium\Core\Config;
use Netarium\Services\Auth\InitialSetup;

header('Content-Type: text/html; charset=UTF-8');

startAppSession();

$config = Config::create();
$error = '';
$usernameValid = false;
try {
    $db = authDatabase();
    if (!InitialSetup::isClosed($db)) {
        header('Location: setup.php');
        exit;
    }

    if (isAuthenticated() && refreshAuthenticatedUser()) {
        header('Location: ' . (mustChangePassword() ? 'change-password.php' : consumeAuthenticationReturnUrl()));
        exit;
    }
} catch (PDOException $e) {
    if (!\Netarium\Core\Database::isBusy($e)) {
        throw $e;
    }
    http_response_code(503);
    header('Content-Type: text/plain; charset=UTF-8');
    header('Cache-Control: no-store');
    exit('現在、認証状態を確認できません。少し待ってから再度実行してください');
}

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    try {
        AuditLog::begin($config, 'auth.login', null, $db);
    } catch (ApiException $e) {
        http_response_code($e->getHttpStatus());
        $error = '現在、ログイン機能を利用できません。管理者へお問い合わせください';
    } catch (Throwable $e) {
        http_response_code(500);
        $error = '現在、ログイン機能を利用できません。管理者へお問い合わせください';
    }

    if ($error === '') {
        try {
        $username = trim((string)($_POST['username'] ?? ''));
        $usernameValid = validateUsername($username) === null;
        $receivedToken = (string)($_POST['csrf_token'] ?? '');
        $csrfValid = $receivedToken !== '' && hash_equals(getCsrfToken(), $receivedToken);
        $lockRemaining = $usernameValid && $csrfValid
            ? reserveLoginAttempt($db, $username)
            : 0;

        if ($lockRemaining > 0) {
            AuditLog::finish('failure', [
                'subject_username' => $username,
            ], 429, ['rate_limited']);

            $error = 'ログインが一時的に制限されています。'
                . $lockRemaining
                . '秒後に再試行してください';
        } else {

            if (!$csrfValid) {
                AuditLog::finish('failure', [
                    'subject_username' => $username,
                ], 403, ['csrf_invalid']);

                $error = '画面の有効期限が切れました。再読み込みしてください';
            } elseif (!$usernameValid) {
                AuditLog::finish('failure', [], 401, ['auth_failed']);
                $error = 'ユーザー名またはパスワードが正しくありません';
            } else {
            $password = (string)($_POST['password'] ?? '');

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
                WHERE username = :username
                LIMIT 1
            ");
            $stmt->execute([':username' => $username]);
            $user = $stmt->fetch();
            // A live SELECT cursor otherwise retains a read lock/snapshot through verify.
            $stmt->closeCursor();

            $valid =
                is_array($user) &&
                (int)$user['is_active'] === 1 &&
                \Netarium\Services\Auth\PasswordHashing::verify(
                    $password,
                    (string)$user['password_hash'],
                    $config['allow_legacy_bcrypt']
                );
            if (!$valid) {
                $db->exec('BEGIN IMMEDIATE');
                try {
                    $spray = \Netarium\Services\Auth\PasswordSprayDetector::recordFailure(
                        $db, $username, 'login', (string)($_SERVER['REMOTE_ADDR'] ?? '')
                    );
                    $db->commit();
                } catch (Throwable $e) {
                    if ($db->inTransaction()) {
                        $db->rollBack();
                    }
                    throw $e;
                }
                AuditLog::finish('failure', [
                    'subject_username' => $username,
                ], 401, $spray === null ? ['auth_failed'] : [
                    'auth_failed', 'password_spray_suspected', 'source_sha256:' . $spray['source_digest'],
                ]);

                $error = 'ユーザー名またはパスワードが正しくありません';
            } else {
                $db->exec('BEGIN IMMEDIATE');
                try {
                    $verifyStmt = $db->prepare("
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
                        WHERE id = :id AND is_active = 1
                        LIMIT 1
                    ");
                    $verifyStmt->execute([':id' => (int)$user['id']]);
                    $freshUser = $verifyStmt->fetch();
                    $verifyStmt->closeCursor();

                    if (
                        !is_array($freshUser) ||
                        (int)$freshUser['password_revision'] !== (int)$user['password_revision'] ||
                        (int)$freshUser['auth_revision'] !== (int)$user['auth_revision'] ||
                        (string)$freshUser['password_hash'] !== (string)$user['password_hash']
                    ) {
                        $db->rollBack();
                        AuditLog::finish('failure', [
                            'subject_username' => $username,
                        ], 401, ['auth_failed']);
                        $error = 'ユーザー名またはパスワードが正しくありません';
                    } else {
                        clearLoginFailures($db, $username);

                        $update = $db->prepare("
                            UPDATE users
                            SET last_login_at = :last_login_at
                            WHERE id = :id
                        ");
                        $update->execute([
                            ':last_login_at' => date('Y-m-d H:i:s'),
                            ':id' => (int)$freshUser['id'],
                        ]);
                        $db->commit();

                        signInUser($freshUser);

                        $auditSuccess = AuditLog::finish('success', [
                            'target_type' => 'user',
                            'target_id' => (int)$freshUser['id'],
                        ], 200);

                        if (!$auditSuccess) {
                            error_log(sprintf(
                                '[Netarium Login] Session established but audit log finish failed: request_id=%s user_id=%d',
                                (string)AuditLog::id(),
                                (int)$freshUser['id']
                            ));
                        }

                        header('Location: ' . (mustChangePassword() ? 'change-password.php' : consumeAuthenticationReturnUrl()));
                        exit;
                    }
                } catch (Throwable $e) {
                    if ($db->inTransaction()) {
                        $db->rollBack();
                    }
                    throw $e;
                }
            }
        }
    }
        } catch (Throwable $e) {
            $status = $e instanceof ApiException ? $e->getHttpStatus()
                : ($e instanceof PDOException && \Netarium\Core\Database::isBusy($e) ? 503 : 500);
            if (AuditLog::id() !== null && !AuditLog::isFinished()) {
                AuditLog::finish('failure', [], $status);
            }
            error_log(sprintf(
                '[Netarium Login] Processing failed: request_id=%s exception=%s',
                (string)AuditLog::id(),
                get_class($e)
            ));
            http_response_code($status);
            $error = '現在、ログイン機能を利用できません。管理者へお問い合わせください';
        }
}
}
?>
<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ログイン - Netarium</title>
    <link rel="icon" type="image/svg+xml" sizes="any" href="assets/icons/brand/netarium-mark-compact.svg">
    <link
        rel="stylesheet"
        href="style.css?v=<?= rawurlencode(
            (string)filemtime(__DIR__ . '/style.css')
        ) ?>"
    >
</head>
<body class="auth-page">
<main class="auth-shell">
    <section class="auth-card" aria-labelledby="login-title">
        <h1><img src="assets/icons/brand/netarium-logo.svg" width="127" height="32" alt="Netarium"></h1>
        <h2 id="login-title">ログイン</h2>

        <?php if ($error !== ''): ?>
            <div class="auth-error" role="alert">
                <?= htmlspecialchars($error, ENT_QUOTES, 'UTF-8') ?>
            </div>
        <?php endif; ?>

        <form method="post" data-auth-form>
            <input
                type="hidden"
                name="csrf_token"
                value="<?= htmlspecialchars(getCsrfToken(), ENT_QUOTES, 'UTF-8') ?>"
            >

            <label>
                ユーザー名
                <input
                    type="text"
                    name="username"
                    id="login-username"
                    data-auth-kind="username"
                    value="<?= htmlspecialchars($usernameValid ? (string)($_POST['username'] ?? '') : '', ENT_QUOTES, 'UTF-8') ?>"
                    required
                    autofocus
                    autocomplete="username"
                >
                <span id="login-username-error" class="auth-field-error" hidden aria-live="polite"></span>
            </label>

            <label>
                パスワード
                <input
                    type="password"
                    name="password"
                    id="login-password"
                    data-auth-kind="password"
                    required
                    autocomplete="current-password"
                >
                <span id="login-password-error" class="auth-field-error" hidden aria-live="polite"></span>
            </label>

            <button type="submit">ログイン</button>
        </form>
    </section>
</main>
<script type="module" src="js/ui/auth-forms.js?v=<?= rawurlencode((string)filemtime(__DIR__ . '/js/ui/auth-forms.js')) ?>"></script>
</body>
</html>
