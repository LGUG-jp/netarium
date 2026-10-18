<?php
declare(strict_types=1);

namespace Netarium\Actions\Topology;

use PDO;
use Netarium\Actions\ActionInterface;
use Netarium\Core\AuditLog;
use Netarium\Core\Request;
use Netarium\Core\Response;
use Netarium\Services\Topology\ResourceSaveService;

final class SaveResourcesAction implements ActionInterface
{
    public function handle(PDO $db, array $config): void
    {
        Request::requireMethod('POST');
        $result = (new ResourceSaveService($db))->save(Request::readJsonBody(), $config);
        $deletedDeviceCount = count($result['deleted_device_ids']);
        $auditSuccess = AuditLog::finish(!empty($result['post_processing_required']) ? 'post_processing_required' : 'success', [
            'target_count' => count($result['devices']) + count($result['affected_view_ids']) + $deletedDeviceCount,
            'counts' => [
                'deleted_device_count' => $deletedDeviceCount,
                'deleted_view_count' => count($result['deleted_view_ids']),
            ],
        ], 200);
        if ($deletedDeviceCount > 0 && !AuditLog::recordRelated('topology.device_delete', [
            'target_type' => 'device', 'target_count' => $deletedDeviceCount,
        ])) {
            $auditSuccess = false;
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
