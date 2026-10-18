<?php
declare(strict_types=1);

namespace Netarium\Actions\FloorPlan;

use PDO;
use Netarium\Actions\ActionInterface;
use Netarium\Core\ApiException;
use Netarium\Core\AuditLog;
use Netarium\Core\Request;
use Netarium\Core\Response;
use Netarium\Services\FloorPlan\FloorPlanService;

class UploadFloorPlanAction implements ActionInterface
{
    public function handle(PDO $db, array $config): void
    {
        Request::requireMethod('POST');

        $viewId = (int)($_POST['view_id'] ?? 0);
        $requestedRevision = (int)($_POST['expected_revision'] ?? 0);

        if (!isset($_FILES['floor_plan']) || !is_array($_FILES['floor_plan'])) {
            throw new ApiException('アップロードする図面を選択してください', 400);
        }

        $service = new FloorPlanService($db);
        $result = $service->uploadFloorPlan($viewId, $requestedRevision, $_FILES['floor_plan'], $config);
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
