<?php
declare(strict_types=1);

namespace Netarium\Actions\Backup;

use PDO;
use Throwable;
use Netarium\Actions\ActionInterface;
use Netarium\Core\AuditLog;
use Netarium\Core\Request;
use Netarium\Services\Backup\BackupService;
class ExportBackupZipAction implements ActionInterface
{
    public function handle(PDO $db, array $config): void
    {
        Request::requireMethod('POST');
        $service = new BackupService($db);
        $previousAbortSetting = ignore_user_abort(true);
        try {
            $service->exportBackupZip($config);
            if (connection_aborted()) {
                throw new \RuntimeException('ダウンロード接続が中断されました');
            }
            AuditLog::finish('success', [
                'target_type' => 'backup',
            ], 200);
        } catch (Throwable $e) {
            AuditLog::finish('failure', [
                'target_type' => 'backup',
            ], 500);

            error_log(sprintf(
                '[Netarium ExportBackupZip] Export failed: request_id=%s %s: %s',
                (string)AuditLog::id(),
                get_class($e),
                $e->getMessage()
            ));

            if (!headers_sent()) {
                throw $e;
            }
        } finally {
            ignore_user_abort((bool)$previousAbortSetting);
        }
        exit;
    }
}
