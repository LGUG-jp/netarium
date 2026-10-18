<?php
declare(strict_types=1);

namespace Netarium\Actions\FloorPlan;

use PDO;
use Netarium\Actions\ActionInterface;
use Netarium\Core\AuditLog;
use Netarium\Core\Request;
use Netarium\Core\Response;
use Netarium\Services\FloorPlan\FloorPlanService;

class DeleteFloorPlanAction implements ActionInterface
{
    public function handle(PDO $db, array $config): void
    {
        Request::requireMethod('POST');

        $input = Request::readJsonBody();
        $viewId = (int)($input['view_id'] ?? 0);
        $requestedRevision = (int)($input['expected_revision'] ?? 0);

        $service = new FloorPlanService($db);
        $result = $service->deleteFloorPlan($viewId, $requestedRevision, $config);
        $auditSuccess = AuditLog::finish('success', [
            'target_type' => 'view',
            'target_id' => $viewId,
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
