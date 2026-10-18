<?php
declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

require_once dirname(__DIR__) . '/bootstrap.php';

$options = getopt('', ['secret-file:', 'db:']);
$file = $options['secret-file'] ?? null;
$handle = null;

try {
    if (!is_string($file) || $file === '' || !preg_match('~^(?:[A-Za-z]:[\\\\/]|\\\\\\\\|/)~', $file)) {
        throw new RuntimeException('秘密ファイルの絶対パスを --secret-file で指定してください。');
    }
    $parent = realpath(dirname($file));
    if ($parent === false || !is_dir($parent)) {
        throw new RuntimeException('保護済みの親ディレクトリを先に作成してください。');
    }
    $public = realpath(dirname(__DIR__) . '/public');
    $normalizedParent = str_replace('\\', '/', $parent);
    $normalizedPublic = $public === false ? '' : str_replace('\\', '/', $public);
    if (PHP_OS_FAMILY === 'Windows') {
        $normalizedParent = strtolower($normalizedParent);
        $normalizedPublic = strtolower($normalizedPublic);
    }
    if ($normalizedPublic !== '' && ($normalizedParent === $normalizedPublic || str_starts_with($normalizedParent, $normalizedPublic . '/'))) {
        throw new RuntimeException('公開ディレクトリへ秘密を保存できません。');
    }
    if (PHP_OS_FAMILY !== 'Windows') {
        $permissions = fileperms($parent);
        if ($permissions === false || ($permissions & 0077) !== 0) {
            throw new RuntimeException('親ディレクトリの権限を所有者だけに制限してください（0700）。');
        }
    }
    if (PHP_OS_FAMILY === 'Windows') {
        $quotedParent = "'" . str_replace("'", "''", $parent) . "'";
        $command = '$ErrorActionPreference = "Stop"; try { '
            . '$item = Get-Item -LiteralPath ' . $quotedParent . '; '
            . 'if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { exit 1 }; '
            . '$acl = Get-Acl -LiteralPath ' . $quotedParent . '; '
            . 'if (-not $acl.AreAccessRulesProtected) { exit 1 }; '
            . '$allowed = @("S-1-5-18", "S-1-5-32-544"); '
            . 'if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $allowed) { exit 1 }; '
            . '$rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])); '
            . 'if (@($rules | Where-Object { $_.AccessControlType -eq "Allow" -and $_.IdentityReference.Value -notin $allowed }).Count) { exit 1 }; '
            . 'foreach ($sid in $allowed) { if (-not @($rules | Where-Object { $_.IdentityReference.Value -eq $sid -and $_.AccessControlType -eq "Allow" -and $_.FileSystemRights -eq "FullControl" }).Count) { exit 1 } }; '
            . 'exit 0 } catch { exit 1 }';
        $process = proc_open(
            ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', $command],
            [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
            $pipes
        );
        if (!is_resource($process)) {
            throw new RuntimeException('親ディレクトリのACLを確認できません。');
        }
        fclose($pipes[0]);
        stream_get_contents($pipes[1]);
        stream_get_contents($pipes[2]);
        fclose($pipes[1]);
        fclose($pipes[2]);
        if (proc_close($process) !== 0) {
            throw new RuntimeException('親ディレクトリをSYSTEM/Administrators専用に保護してください。');
        }
    }
    // Windowsでは生成前にSYSTEM/Administratorsだけの専用ACLを設定する。
    $config = \Netarium\Core\Config::create();
    $dbFile = $options['db'] ?? $config['db_file'];
    if (isset($options['db']) && is_string($options['db']) && trim($options['db']) !== '') {
        $realDbFile = realpath((string)$options['db']) ?: (string)$options['db'];
        $parentDir = dirname($realDbFile);
        $storageBase = basename($parentDir) === 'db' ? dirname($parentDir) : $parentDir;
        $config['operation_lock_file'] = $storageBase . DIRECTORY_SEPARATOR . 'temp' . DIRECTORY_SEPARATOR . 'operation.lock';
    }
    $operationGate = new \Netarium\Core\OperationGate((string)$config['operation_lock_file']);
    $operationGate->acquireShared();
    if (!is_string($dbFile) || $dbFile === '' || !is_file($dbFile)) {
        throw new RuntimeException('初期化済みの既存DBを指定してください。');
    }
    $db = \Netarium\Core\Database::connect($dbFile);
    if (\Netarium\Services\Auth\InitialSetup::isClosed($db)) {
        throw new RuntimeException('初期登録は完了済みです。管理者復旧には recover-admin.php を使用してください。');
    }
    $secret = bin2hex(random_bytes(32));
    $oldMask = umask(0077);
    try {
        $handle = @fopen($file, 'x+b');
    } finally {
        umask($oldMask);
    }
    if ($handle === false) {
        throw new RuntimeException('秘密ファイルを新規作成できません。既存ファイルは上書きしません。');
    }
    if (PHP_OS_FAMILY !== 'Windows' && !chmod($file, 0600)) {
        throw new RuntimeException('秘密ファイルの権限を設定できません。');
    }
    if (fwrite($handle, $secret) !== strlen($secret) || !fflush($handle) || !fsync($handle)) {
        throw new RuntimeException('秘密ファイルを永続化できません。');
    }
    if (!fclose($handle)) {
        $handle = null;
        throw new RuntimeException('秘密ファイルを閉じられません。');
    }
    $handle = null;
    \Netarium\Services\Auth\InitialSetup::issueSecret($db, $secret);
    fwrite(STDOUT, "初期登録用の秘密ファイルを発行しました: {$file}\n");
} catch (Throwable $e) {
    if (is_resource($handle)) {
        fclose($handle);
    }
    // 例外メッセージやDB診断を転送せず、秘密の出力を防ぐ。
    fwrite(STDERR, "初期登録用秘密の発行に失敗しました。既存ファイル、親ディレクトリの保護、DBと初期登録状態を確認してください。DB未登録のファイルは無効です。\n");
    exit(1);
}
