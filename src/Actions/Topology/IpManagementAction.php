<?php
declare(strict_types=1);

namespace Netarium\Actions\Topology;

use PDO;
use Netarium\Actions\ActionInterface;
use Netarium\Core\AuditLog;
use Netarium\Core\Request;
use Netarium\Core\Response;
use Netarium\Services\Topology\IpManagementService;

final class IpManagementAction implements ActionInterface
{
    public function handle(PDO $db, array $config): void
    {
        $action = (string)($_GET['action'] ?? '');
        $service = new IpManagementService($db);
        if ($action === 'load_ip_management') {
            Request::requireMethod('GET');
            Response::json($service->load());
            return;
        }
        if ($action === 'load_ip_management_summary') {
            Request::requireMethod('GET');
            Response::json($service->summary());
            return;
        }
        Request::requireMethod('POST');
        $result = $service->mutate($action, Request::readJsonBody());
        $success = AuditLog::finish('success', ['target_type' => 'ip_management', 'target_count' => 1], 200);
        if (AuditLog::id() !== null) { $result['request_id'] = AuditLog::id(); }
        if (!$success) { $result['audit_warning'] = true; }
        Response::json($result);
    }
}
