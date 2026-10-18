<?php
declare(strict_types=1);

namespace Netarium\Actions\Csv;

use PDO;
use Netarium\Actions\ActionInterface;
use Netarium\Core\ApiException;
use Netarium\Core\AuditLog;
use Netarium\Core\Request;
use Netarium\Core\Response;
use Netarium\Services\Csv\CsvImportExportService;

class PreviewDevicesCsvImportAction implements ActionInterface
{
    public function handle(PDO $db, array $config): void
    {
        Request::requireMethod('POST');

        $requestedRevision = (int)($_POST['revision'] ?? 0);

        if (!isset($_FILES['devices_csv']) || !is_array($_FILES['devices_csv'])) {
            throw new ApiException('取込CSVを選択してください', 400);
        }

        $service = new CsvImportExportService($db);
        $result = $service->previewImport($requestedRevision, $_FILES['devices_csv'], $config);

        $auditSuccess = AuditLog::finish('success', [
            'target_type' => 'csv',
        ], 200);

        if (AuditLog::id() !== null) {
            $result['request_id'] = AuditLog::id();
        }
        if (!$auditSuccess) {
            $result['audit_warning'] = true;
        }

        Response::json($result);
    }
}
