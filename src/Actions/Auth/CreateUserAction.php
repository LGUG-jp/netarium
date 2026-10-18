<?php
declare(strict_types=1);

namespace Netarium\Actions\Auth;

use PDO;
use Netarium\Actions\ActionInterface;
use Netarium\Core\AuditLog;
use Netarium\Core\Request;
use Netarium\Core\Response;
use Netarium\Services\Auth\UserManagementService;

class CreateUserAction implements ActionInterface
{
    public function handle(PDO $db, array $config): void
    {
        Request::requireMethod('POST');

        $result = (new UserManagementService($db))->createUser(
            Request::readJsonBody()
        );

        $targetId = isset($result['user_id']) ? (int)$result['user_id'] : null;
        $auditSuccess = AuditLog::finish('success', [
            'target_type' => 'user',
            'target_id' => $targetId,
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
