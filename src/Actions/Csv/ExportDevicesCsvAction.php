<?php
declare(strict_types=1);

namespace Netarium\Actions\Csv;

use PDO;
use Throwable;
use Netarium\Actions\ActionInterface;
use Netarium\Core\AuditLog;
use Netarium\Core\Request;
use Netarium\Services\Csv\CsvImportExportService;
class ExportDevicesCsvAction implements ActionInterface
{
    public function handle(PDO $db, array $config): void
    {
        Request::requireMethod('GET');

        $service = new CsvImportExportService($db);
        $previousAbortSetting = ignore_user_abort(true);
        try {
            $exportedCount = $service->exportDevicesCsv();
            if (connection_aborted()) {
                throw new \RuntimeException('ダウンロード接続が中断されました');
            }
            AuditLog::finish('success', [
                'target_type' => 'csv',
                'target_count' => $exportedCount,
            ], 200);
        } catch (Throwable $e) {
            AuditLog::finish('failure', [
                'target_type' => 'csv',
            ], 500);

            error_log(sprintf(
                '[Netarium ExportDevicesCsv] Stream failed: request_id=%s %s: %s',
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
