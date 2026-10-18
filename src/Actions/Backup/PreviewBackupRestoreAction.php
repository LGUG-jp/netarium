<?php
declare(strict_types=1);

namespace Netarium\Actions\Backup;

use PDO;
use Netarium\Actions\ActionInterface;
use Netarium\Core\ApiException;
use Netarium\Core\AuditLog;
use Netarium\Core\Request;
use Netarium\Core\Response;
use Netarium\Services\Backup\BackupService;

class PreviewBackupRestoreAction implements ActionInterface
{
    public function handle(PDO $db, array $config): void
    {
        Request::requireMethod('POST');

        if (!isset($_FILES['backup_zip']) || !is_array($_FILES['backup_zip'])) {
            throw new ApiException('復元するバックアップZIPを選択してください', 400);
        }

        $service = new BackupService($db);
        $result = $service->previewBackupRestore($_FILES['backup_zip'], $config);

        $auditSuccess = AuditLog::finish('success', [
            'target_type' => 'backup',
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
