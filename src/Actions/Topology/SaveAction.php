<?php
declare(strict_types=1);

namespace Netarium\Actions\Topology;

use PDO;
use Netarium\Actions\ActionInterface;
use Netarium\Core\AuditLog;
use Netarium\Core\Request;
use Netarium\Core\Response;
use Netarium\Services\Topology\TopologyService;

class SaveAction implements ActionInterface
{
    public function handle(PDO $db, array $config): void
    {
        Request::requireMethod('POST');

        $input = Request::readJsonBody();
        $service = new TopologyService($db);
        $result = $service->save($input, $config);

        $auditCounts = $result['audit_counts'] ?? [];
        unset($result['audit_counts']);

        $deletedDeviceCount = (int)($auditCounts['deleted_device_count'] ?? 0);
        $deletedViewCount = (int)($auditCounts['deleted_view_count'] ?? 0);

        $auditSuccess = AuditLog::finish('success', [
            'target_count' => $deletedDeviceCount,
            'counts' => [
                'deleted_device_count' => $deletedDeviceCount,
                'deleted_view_count' => $deletedViewCount,
            ],
        ], 200);

        if ($deletedDeviceCount > 0) {
            $relatedSuccess = AuditLog::recordRelated('topology.device_delete', [
                'target_type' => 'device',
                'target_count' => $deletedDeviceCount,
            ]);
            if (!$relatedSuccess) {
                $auditSuccess = false;
            }
        }

        if (AuditLog::id() !== null) {
            $result['request_id'] = AuditLog::id();
        }
        if (!$auditSuccess) {
            $result['audit_warning'] = true;
        }

        Response::json($result);
    }
}
