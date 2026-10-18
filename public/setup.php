<?php
declare(strict_types=1);

require_once dirname(__DIR__) . '/bootstrap.php';

use Netarium\Core\ApiException;
use Netarium\Core\Config;
use Netarium\Services\Auth\InitialSetup;

header('Content-Type: text/html; charset=UTF-8');

startAppSession();

$config = Config::create();
$db = authDatabase();
$error = '';
$completed = false;

try {
    if (InitialSetup::isClosed($db)) {
        if ($_SERVER['REQUEST_METHOD'] === 'POST') {
            http_response_code(409);
            $error = '初期設定は完了しています';
        } else {
            header('Location: login.php');
            exit;
        }
    }
} catch (Throwable $e) {
    http_response_code(503);
    $error = '現在、初期設定を実行できません。管理者へお問い合わせください';
}

if ($_SERVER['REQUEST_METHOD'] === 'POST' && $error === '') {
    $receivedToken = (string)($_POST['csrf_token'] ?? '');
    $expectedToken = getCsrfToken();

    if (
        $receivedToken === '' ||
        !hash_equals($expectedToken, $receivedToken)
    ) {
        $error = '画面の有効期限が切れました。再読み込みしてください';
    } else {
        $username = trim((string)($_POST['username'] ?? ''));
        $password = (string)($_POST['password'] ?? '');
        $passwordConfirm = (string)($_POST['password_confirm'] ?? '');

        try {
            InitialSetup::createAdmin(
                $db,
                $config,
                (string)($_POST['bootstrap_secret'] ?? ''),
                $username,
                $password,
                $passwordConfirm
            );
            $completed = true;
        } catch (ApiException $e) {
            // 入力条件のエラーは、従来どおり同じフォームで訂正できる。
            http_response_code($e->getHttpStatus() === 400 ? 200 : $e->getHttpStatus());
            $error = $e->getMessage();
        } catch (Throwable $e) {
            http_response_code(503);
            $error = '現在、初期設定を実行できません。管理者へお問い合わせください';
        }
    }
}
?>
<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>初期セットアップ - Netarium</title>
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
    <section class="auth-card" aria-labelledby="setup-title">
        <h1><img src="assets/icons/brand/netarium-logo.svg" width="127" height="32" alt="Netarium"></h1>
        <h2 id="setup-title">初期セットアップ</h2>

        <?php if ($completed): ?>
            <div class="auth-success" role="status">
                初期管理者を登録しました。
            </div>
            <p>
                初期設定用の秘密ファイルを削除し、管理者向けのセキュリティ確認を実行してください。
            </p>
            <a class="auth-link" href="login.php">ログイン画面へ</a>
        <?php else: ?>
            <p>初期管理者を登録します。</p>

            <?php if ($error !== ''): ?>
                <div class="auth-error" role="alert">
                    <?= htmlspecialchars($error, ENT_QUOTES, 'UTF-8') ?>
                </div>
            <?php endif; ?>

            <form method="post" autocomplete="off" data-auth-form>
                <input
                    type="hidden"
                    name="csrf_token"
                    value="<?= htmlspecialchars(getCsrfToken(), ENT_QUOTES, 'UTF-8') ?>"
                >

                <label>
                    初期設定用の秘密
                    <input
                        type="password"
                        name="bootstrap_secret"
                        required
                        autocomplete="off"
                    >
                    <span class="auth-field-hint">配備管理者から受け取った秘密を入力してください。</span>
                </label>

                <label>
                    ユーザー名
                    <input
                        type="text"
                        name="username"
                        id="setup-username"
                        data-auth-kind="username"
                        data-auth-create="true"
                        aria-describedby="setup-username-hint"
                        value="<?= htmlspecialchars((string)($_POST['username'] ?? ''), ENT_QUOTES, 'UTF-8') ?>"
                        required
                        autofocus
                        autocomplete="username"
                    >
                    <span id="setup-username-hint" class="auth-field-hint">3～50文字の半角英数字、_、-、.</span>
                    <span id="setup-username-error" class="auth-field-error" hidden aria-live="polite"></span>
                </label>

                <label>
                    パスワード
                    <input
                        type="password"
                        name="password"
                        id="setup-password"
                        data-auth-kind="password"
                        data-auth-create="true"
                        aria-describedby="setup-password-hint"
                        required
                        autocomplete="new-password"
                    >
                    <span id="setup-password-error" class="auth-field-error" hidden aria-live="polite"></span>
                </label>
                <?php
                $passwordRequirementsId = 'setup-password-hint';
                require dirname(__DIR__) . '/templates/components/password_requirements.php';
                ?>

                <label>
                    パスワード確認
                    <input
                        type="password"
                        name="password_confirm"
                        id="setup-password-confirm"
                        data-auth-kind="password"
                        data-auth-create="true"
                        data-auth-match="setup-password"
                        aria-describedby="setup-password-confirm-hint"
                        required
                        autocomplete="new-password"
                    >
                    <span id="setup-password-confirm-hint" class="auth-field-hint">パスワードと同じ値を入力</span>
                    <span id="setup-password-confirm-error" class="auth-field-error" hidden aria-live="polite"></span>
                </label>

                <button type="submit">管理者を登録</button>
            </form>
        <?php endif; ?>
    </section>
</main>
<script type="module" src="js/ui/auth-forms.js?v=<?= rawurlencode((string)filemtime(__DIR__ . '/js/ui/auth-forms.js')) ?>"></script>
</body>
</html>
