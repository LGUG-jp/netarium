<?php
declare(strict_types=1);

require_once dirname(__DIR__) . '/bootstrap.php';

use Netarium\Core\ApiException;
use Netarium\Core\AuditLog;
use Netarium\Core\Config;
use Netarium\Services\Auth\UserManagementService;

requirePageAuthentication(true);
header('Content-Type: text/html; charset=UTF-8');
header('Cache-Control: no-store');
if (!mustChangePassword()) {
    header('Location: ' . consumeAuthenticationReturnUrl());
    exit;
}
$config = Config::create();
$db = authDatabase();
$error = '';
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'POST') {
    $token = (string)($_POST['csrf_token'] ?? '');
    if ($token === '' || !hash_equals(getCsrfToken(), $token)) {
        http_response_code(403);
        $error = '画面の有効期限が切れました。再読み込みしてください';
    } else {
        try {
            $id = currentUserId();
            AuditLog::begin($config, 'change_own_password', $id, $db);
            (new UserManagementService($db))->changeOwnPassword($_POST, $config['allow_legacy_bcrypt']);
            AuditLog::finish('success', ['target_type' => 'user', 'target_id' => $id], 200);
            $returnParameters = authenticationDirectLinkParameters();
            clearAuthenticationSession();
            if ($returnParameters !== []) {
                // Password changes still end authentication. Only the link IDs
                // survive in a fresh anonymous session for the required login.
                session_id('');
                startAppSession();
                $_SESSION['direct_link_return'] = $returnParameters;
            }
            header('Location: login.php');
            exit;
        } catch (Throwable $e) {
            $status = $e instanceof ApiException ? $e->getHttpStatus() : 503;
            if (AuditLog::id() !== null && !AuditLog::isFinished()) {
                AuditLog::finish('failure', [], $status, $status === 429 ? ['rate_limited'] : []);
            }
            http_response_code($status);
            $error = $e instanceof ApiException ? $e->getMessage() : '現在、パスワードを変更できません。管理者へお問い合わせください';
        }
    }
}
?>
<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>初回パスワード変更 - Netarium</title>
    <link rel="icon" type="image/svg+xml" sizes="any" href="assets/icons/brand/netarium-mark-compact.svg">
    <link rel="stylesheet" href="style.css">
</head>
<body class="auth-page">
<main class="auth-shell">
    <section class="auth-card" aria-labelledby="change-title">
        <h1><img src="assets/icons/brand/netarium-logo.svg" width="127" height="32" alt="Netarium"></h1>
        <h2 id="change-title">初回パスワード変更</h2>
        <p>管理者から受け取った仮パスワードを、本人だけが知る別のパスワードへ変更してください。変更が完了するまで通常の画面は利用できません。</p>
        <?php if ($error !== ''): ?>
            <div class="auth-error" role="alert"><?= htmlspecialchars($error, ENT_QUOTES, 'UTF-8') ?></div>
        <?php endif; ?>
        <form method="post" data-auth-form>
            <input type="hidden" name="csrf_token" value="<?= htmlspecialchars(getCsrfToken(), ENT_QUOTES, 'UTF-8') ?>">
            <label for="current-password">仮パスワード（現在のパスワード）</label>
            <input id="current-password" name="current_password" type="password" data-auth-kind="required" required autocomplete="current-password">
            <span id="current-password-error" class="auth-field-error" hidden aria-live="polite"></span>
            <label for="new-password">新しいパスワード</label>
            <input id="new-password" name="new_password" type="password" data-auth-kind="password" data-auth-create="true" aria-describedby="new-password-hint" required autocomplete="new-password">
            <?php $passwordRequirementsId = 'new-password-hint'; require dirname(__DIR__) . '/templates/components/password_requirements.php'; ?>
            <span id="new-password-error" class="auth-field-error" hidden aria-live="polite"></span>
            <label for="new-password-confirm">新しいパスワード（確認）</label>
            <input id="new-password-confirm" name="new_password_confirm" type="password" data-auth-kind="password" data-auth-create="true" data-auth-match="new-password" required autocomplete="new-password">
            <span id="new-password-confirm-error" class="auth-field-error" hidden aria-live="polite"></span>
            <p>頻出・既知漏えい値や推測しやすい値は使用できません。変更後はログアウトします。新しいパスワードで再ログインしてください。</p>
            <button type="submit" class="btn btn-primary">パスワードを変更</button>
        </form>
        <form method="post" action="logout.php">
            <input type="hidden" name="csrf_token" value="<?= htmlspecialchars(getCsrfToken(), ENT_QUOTES, 'UTF-8') ?>">
            <button type="submit" class="btn btn-secondary">ログアウト</button>
        </form>
    </section>
</main>
<script type="module" src="js/ui/auth-forms.js"></script>
</body>
</html>
