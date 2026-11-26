<?php
declare(strict_types=1);

namespace Netarium\Actions\Topology;

use PDO;
use Netarium\Actions\ActionInterface;
use Netarium\Core\AuditLog;
use Netarium\Core\Request;
use Netarium\Core\Response;
use Netarium\Services\Topology\BuildingHierarchyService;

final class BuildingHierarchyAction implements ActionInterface
{
    public function handle(PDO $db, array $config): void
    {
        $service = new BuildingHierarchyService($db);
        if (strtoupper($_SERVER['REQUEST_METHOD'] ?? '') === 'GET') {
            Response::json($service->load());
            return;
        }
        Request::requireMethod('POST');
        $result = $service->mutate(Request::readJsonBody());
        $logged = AuditLog::finish('success', ['target_type' => 'building_hierarchy'], 200);
        if (AuditLog::id() !== null) { $result['request_id'] = AuditLog::id(); }
        if (!$logged) { $result['audit_warning'] = true; }
        Response::json($result);
    }
}
