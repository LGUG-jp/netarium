<?php
declare(strict_types=1);

function requirePageAuthentication(bool $allowPasswordChange = false): void
{
    startAppSession();

    try {
        $authenticated = isAuthenticated() && refreshAuthenticatedUser();
    } catch (PDOException $e) {
        if (!\Netarium\Core\Database::isBusy($e)) {
            throw $e;
        }
        http_response_code(503);
        header('Content-Type: text/plain; charset=UTF-8');
        header('Cache-Control: no-store');
        exit('現在、認証状態を確認できません。少し待ってから再度実行してください');
    }

    if (!$authenticated) {
        recordAccessDenial('authentication_required');
        header('Location: login.php');
        exit;
    }

    if (!$allowPasswordChange && mustChangePassword()) {
        recordAccessDenial('password_change_required');
        header('Location: change-password.php');
        exit;
    }
}

function requireApiAuthentication(bool $allowPasswordChange = false): void
{
    startAppSession();

    if (!isAuthenticated() || !refreshAuthenticatedUser()) {
        sendAuthDenial([
            'ok' => false,
            'error' => '認証が必要です',
            'login_required' => true,
        ], 401, 'authentication_required');
    }

    if (!$allowPasswordChange && mustChangePassword()) {
        sendAuthDenial([
            'ok' => false,
            'error' => '通常利用の前にパスワードを変更してください',
            'password_change_required' => true,
        ], 403, 'password_change_required');
    }
}

function requireAdminPageRole(): void
{
    requirePageAuthentication();

    if (!isAdminUser()) {
        recordAccessDenial('insufficient_role');
        http_response_code(403);

        header(
            'Content-Type: text/html; charset=UTF-8'
        );

        echo '<!DOCTYPE html>';
        echo '<html lang="ja">';
        echo '<head>';
        echo '<meta charset="UTF-8">';
        echo '<meta name="viewport" content="width=device-width, initial-scale=1.0">';
        echo '<title>権限がありません</title>';
        echo '</head>';
        echo '<body>';
        echo '<h1>403 Forbidden</h1>';
        echo '<p>この操作を実行する権限がありません。</p>';
        echo '</body>';
        echo '</html>';
        exit;
    }
}

function requireAdminApiRole(): void
{
    requireApiAuthentication();

    if (!isAdminUser()) {
        sendAuthDenial([
            'ok' => false,
            'error' =>
                'この操作を実行する権限がありません',
        ], 403, 'insufficient_role');
    }
}

function recordAccessDenial(string $reason): ?string
{
    try {
        $actorId = currentUserId();
        return \Netarium\Core\AuditLog::recordSecurityEvent(
            \Netarium\Core\Config::create(),
            $reason,
            $actorId > 0 ? $actorId : null
        );
    } catch (Throwable $e) {
        // Audit failures must never change the access decision.
        return null;
    }
}

function sendAuthDenial(array $data, int $status, string $reason): void
{
    $requestId = recordAccessDenial($reason);
    if ($requestId !== null) {
        $data['request_id'] = $requestId;
    }
    sendAuthJson($data, $status);
}

function sendAuthJson(array $data, int $status = 200): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=UTF-8');
    header('Cache-Control: no-store');

    echo json_encode(
        $data,
        JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES
    );
    exit;
}
