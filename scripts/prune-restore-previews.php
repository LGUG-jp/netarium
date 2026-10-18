<?php
declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

require_once dirname(__DIR__) . '/bootstrap.php';

use Netarium\Core\Config;
use Netarium\Services\Backup\RestoreWorkspace;

$workspace = null;
try {
    $config = Config::create();
    $options = getopt('', ['storage-dir:']);
    if (isset($options['storage-dir']) && is_string($options['storage-dir']) && trim($options['storage-dir']) !== '') {
        $config['backup_restore_directory'] = rtrim(trim($options['storage-dir']), '\\/') . DIRECTORY_SEPARATOR . 'temp' . DIRECTORY_SEPARATOR . 'backup-restore';
    }
    $operationGate = new \Netarium\Core\OperationGate((string)$config['operation_lock_file']);
    $operationGate->acquireShared();
    $workspace = new RestoreWorkspace($config);
    $result = $workspace->cleanupExpired();
    fwrite(STDOUT, sprintf("復元プレビュー整理: 回収%d件、残存%d件、%dバイト、削除失敗%d件\n", $result['removed'], $result['remaining'], $result['bytes'], $result['failed']));
    if ($result['failed'] !== 0) {
        fwrite(STDERR, "期限切れ領域を削除できません。保存先のACLとファイルの状態を確認してください。\n");
    }
    $exitCode = $result['failed'] === 0 ? 0 : 1;
} catch (Throwable $e) {
    fwrite(STDERR, '復元プレビューの整理に失敗しました: ' . $e->getMessage() . "\n");
    $exitCode = 1;
} finally {
    $workspace?->release();
}
exit($exitCode);
