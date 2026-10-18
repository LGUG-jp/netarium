<?php
declare(strict_types=1);

namespace Netarium\Actions\Backup;

use PDO;
use Netarium\Actions\ActionInterface;
use Netarium\Core\AuditLog;
use Netarium\Core\Request;
use Netarium\Core\Response;
use Netarium\Services\Backup\BackupService;

class CommitBackupRestoreAction implements ActionInterface
{
    public function handle(PDO $db, array $config): void
    {
        Request::requireMethod('POST');

        $input = Request::readJsonBody();
        $token = (string)($input['restore_token'] ?? '');
        $confirmation = (string)($input['confirmation'] ?? '');

        $service = new BackupService($db);
        $result = $service->commitBackupRestore($token, $confirmation, $config);
        $postProcessingRequired = !empty($result['post_processing_required']);
        $outcome = $postProcessingRequired ? 'post_processing_required' : 'success';
        $postProcessingErrors = is_array($result['post_processing_errors'] ?? null)
            ? $result['post_processing_errors']
            : [];

        $auditSuccess = AuditLog::finish($outcome, [
            'target_type' => 'backup',
            'target_count' => null,
        ], 200, $postProcessingErrors);

        if (!$auditSuccess) {
            if (!in_array('audit_log', $postProcessingErrors, true)) {
                $postProcessingErrors[] = 'audit_log';
            }
            $result['post_processing_errors'] = $postProcessingErrors;
            $result['post_processing_required'] = true;
            $result['message'] = 'バックアップから復元しました（後処理要対応）';
            $result['audit_warning'] = true;
        }

        if (AuditLog::id() !== null) {
            $result['request_id'] = AuditLog::id();
        }

        Response::json($result);
    }
}
