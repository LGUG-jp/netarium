<?php
declare(strict_types=1);

/*
 * 全adminがログインできない場合だけ使用する緊急復旧CLI。
 * 通常の利用者管理は、ログイン後の管理画面から実施する。
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

require_once dirname(__DIR__) . '/bootstrap.php';

function readRecoveryInput(string $prompt): string
{
    if (function_exists('readline')) {
        return (string)readline($prompt);
    }

    fwrite(STDOUT, $prompt);
    $line = fgets(STDIN);

    return $line === false ? '' : rtrim($line, "\r\n");
}

$options = getopt('', [
    'db:',
    'username:',
    'password-file:',
]);

$isCustomDb = isset($options['db']) && is_string($options['db']) && trim($options['db']) !== '';
$config = \Netarium\Core\Config::create();
$dbFile = (string)($options['db'] ?? $config['db_file']);

if ($isCustomDb) {
    $realDbFile = realpath($dbFile) ?: $dbFile;
    $parentDir = dirname($realDbFile);
    if (basename($parentDir) === 'db') {
        $storageBase = dirname($parentDir);
    } else {
        $storageBase = $parentDir;
    }
    $config['audit_log_directory'] = $storageBase . DIRECTORY_SEPARATOR . 'logs' . DIRECTORY_SEPARATOR . 'audit';
    $config['operation_lock_file'] = $storageBase . DIRECTORY_SEPARATOR . 'temp' . DIRECTORY_SEPARATOR . 'operation.lock';
    // --dbで選んだ配備先の追加辞書も、監査・排他と同じ領域から検査する。
    putenv('NETARIUM_STORAGE_DIR=' . $storageBase);
}
if ($dbFile === '' || !is_file($dbFile)) {
    fwrite(STDERR, "DBファイルが見つかりません: {$dbFile}\n");
    exit(1);
}

$username = trim((string)($options['username'] ?? ''));

if ($username === '') {
    $username = trim(readRecoveryInput('復旧するadminのユーザー名: '));
}

$usernameError = validateUsername($username);

if ($usernameError !== null) {
    fwrite(STDERR, $usernameError . "\n");
    exit(1);
}

$passwordFile = (string)($options['password-file'] ?? '');

if ($passwordFile !== '') {
    if (!is_readable($passwordFile)) {
        fwrite(STDERR, "パスワードファイルを読み込めません: {$passwordFile}\n");
        exit(1);
    }

    // ファイルはUTF-8のパスワードそのもの。空白や改行も秘密の一部として保持する。
    $password = (string)file_get_contents($passwordFile);
} else {
    $password = readRecoveryInput(
        '新しいパスワード（入力内容は表示されます）: '
    );
    $passwordConfirm = readRecoveryInput('新しいパスワード（確認）: ');

    if ($password !== $passwordConfirm) {
        fwrite(STDERR, "確認用パスワードが一致しません。\n");
        exit(1);
    }
}

$passwordError = validatePassword($password, $username);

if ($passwordError !== null) {
    fwrite(STDERR, $passwordError . "\n");
    exit(1);
}
$operationGate = new \Netarium\Core\OperationGate((string)$config['operation_lock_file']);
$operationGate->acquireShared();

try {
    $db = new PDO('sqlite:' . $dbFile);

    \Netarium\Core\AuditLog::begin($config, 'recover_admin', null, $db);
} catch (Throwable $e) {
    fwrite(STDERR, "監査ログの記録に失敗したため、復旧を中断しました: " . $e->getMessage() . "\n");
    exit(1);
}

try {
    $passwordHash = \Netarium\Services\Auth\PasswordHashing::hash($password);
    \Netarium\Core\Database::initialize($db);
    $db->beginTransaction();
    $find = $db->prepare(
        'SELECT id FROM users WHERE username = :username LIMIT 1'
    );
    $find->execute([':username' => $username]);
    $userId = $find->fetchColumn();
    $now = date('Y-m-d H:i:s');

    if ($userId === false) {
        $stmt = $db->prepare("
            INSERT INTO users (
                username,
                password_hash,
                role,
                is_active,
                auth_revision,
                password_revision,
                password_changed_at,
                must_change_password,
                created_at,
                updated_at
            ) VALUES (
                :username,
                :password_hash,
                'admin',
                1,
                1,
                1,
                :password_changed_at,
                1,
                :created_at,
                :updated_at
            )
        ");
        $stmt->execute([
            ':username' => $username,
            ':password_hash' => $passwordHash,
            ':password_changed_at' => $now,
            ':created_at' => $now,
            ':updated_at' => $now,
        ]);
        $targetUserId = (int)$db->lastInsertId();
        $message = '新しいadminを作成しました';
    } else {
        $stmt = $db->prepare("
            UPDATE users
            SET
                password_hash = :password_hash,
                role = 'admin',
                is_active = 1,
                auth_revision = auth_revision + 1,
                password_revision = password_revision + 1,
                password_changed_at = :password_changed_at,
                must_change_password = 1,
                updated_at = :updated_at
            WHERE id = :id
        ");
        $stmt->execute([
            ':password_hash' => $passwordHash,
            ':password_changed_at' => $now,
            ':updated_at' => $now,
            ':id' => (int)$userId,
        ]);
        $targetUserId = (int)$userId;
        $message = '既存利用者をadminとして復旧しました';
    }

    clearLoginFailures($db, $username);
    \Netarium\Services\Auth\ReauthenticationLimit::clear($db, $targetUserId);

    $db->commit();

    $auditSuccess = \Netarium\Core\AuditLog::finish('success', [
        'target_type' => 'user',
        'target_id' => $targetUserId,
    ], 200);

    if (!$auditSuccess) {
        fwrite(STDERR, sprintf(
            "警告: 復旧は成功しましたが、監査ログの最終記録に失敗しました (調査ID: %s)\n",
            (string)\Netarium\Core\AuditLog::id()
        ));
    }

    fwrite(STDOUT, $message . "。login.phpからログインし、仮パスワードと異なる値へ本人変更してください。\n");
} catch (Throwable $e) {
    if (isset($db) && $db instanceof PDO && $db->inTransaction()) {
        $db->rollBack();
    }

    if (\Netarium\Core\AuditLog::id() !== null && !\Netarium\Core\AuditLog::isFinished()) {
        \Netarium\Core\AuditLog::finish('failure', [
            'target_type' => 'user',
        ], 500);
    }

    fwrite(STDERR, '復旧に失敗しました: ' . $e->getMessage() . "\n");
    exit(1);
}
