<?php
declare(strict_types=1);

namespace Netarium\Actions\Csv;

use PDO;
use Netarium\Actions\ActionInterface;
use Netarium\Core\AuditLog;
use Netarium\Core\Request;
use Netarium\Core\Response;
use Netarium\Services\Csv\CsvImportExportService;

class CommitDevicesCsvImportAction implements ActionInterface
{
    public function handle(PDO $db, array $config): void
    {
        Request::requireMethod('POST');

        $input = Request::readJsonBody();
        $token = (string)($input['import_token'] ?? '');
        $requestedRevision = (int)($input['revision'] ?? 0);

        $service = new CsvImportExportService($db);
        $result = $service->commitImport($token, $requestedRevision, $config);
        $summary = is_array($result['summary'] ?? null) ? $result['summary'] : [];
        $insertCount = (int)($summary['insert'] ?? 0);
        $updateCount = (int)($summary['update'] ?? 0);
        $totalCount = $insertCount + $updateCount;

        $auditSuccess = AuditLog::finish('success', [
            'target_type' => 'device',
            'target_count' => $totalCount,
            'counts' => [
                'insert_count' => $insertCount,
                'update_count' => $updateCount,
            ],
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
