<?php
declare(strict_types=1);

namespace Netarium\Actions\Auth;

use PDO;
use Netarium\Actions\ActionInterface;
use Netarium\Core\AuditLog;
use Netarium\Core\Request;
use Netarium\Core\Response;
use Netarium\Services\Auth\UserManagementService;

class ChangeOwnPasswordAction implements ActionInterface
{
    public function handle(PDO $db, array $config): void
    {
        Request::requireMethod('POST');

        $input = Request::readJsonBody();
        $targetId = \currentUserId();

        $result = (new UserManagementService($db))->changeOwnPassword($input, $config['allow_legacy_bcrypt']);

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
