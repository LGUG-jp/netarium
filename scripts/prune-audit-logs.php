<?php
declare(strict_types=1);

/*
 * 停止期間中の期限超過分（90日超過）を整理する管理者用CLI。
 * 週次保守等で定期実行する。
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

require_once dirname(__DIR__) . '/bootstrap.php';

use Netarium\Core\AuditLog;
use Netarium\Core\Config;

$options = getopt('', [
    'storage-dir:',
    'audit-log-dir:',
]);

$config = Config::create();

if (isset($options['audit-log-dir']) && is_string($options['audit-log-dir']) && trim($options['audit-log-dir']) !== '') {
    $config['audit_log_directory'] = trim($options['audit-log-dir']);
} elseif (isset($options['storage-dir']) && is_string($options['storage-dir']) && trim($options['storage-dir']) !== '') {
    $storageDir = rtrim(trim($options['storage-dir']), '\\/');
    $config['audit_log_directory'] = $storageDir . DIRECTORY_SEPARATOR . 'logs' . DIRECTORY_SEPARATOR . 'audit';
}
$operationGate = new \Netarium\Core\OperationGate((string)$config['operation_lock_file']);
$operationGate->acquireShared();

try {
    AuditLog::prune($config);
    fwrite(STDOUT, "監査ログの期限超過ファイルの整理が完了しました。\n");
    exit(0);
} catch (Throwable $e) {
    fwrite(STDERR, '監査ログの整理に失敗しました: ' . $e->getMessage() . "\n");
    exit(1);
}
