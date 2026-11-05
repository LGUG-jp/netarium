<?php
declare(strict_types=1);

namespace Netarium\Actions\Topology;

use PDO;
use Netarium\Actions\ActionInterface;
use Netarium\Core\AuditLog;
use Netarium\Core\Request;
use Netarium\Core\Response;
use Netarium\Services\Topology\DeviceConfigService;

final class DeviceConfigAction implements ActionInterface
{
    public function handle(PDO $db, array $config): void
    {
        $action = (string)($_GET['action'] ?? '');
        $service = new DeviceConfigService($db, $config);
        if ($action === 'load_device_configs') {
            Request::requireMethod('GET');
            Response::json($service->load($_GET));
            return;
        }
        Request::requireMethod('POST');
        $result = $service->mutate($action, Request::readJsonBody());
        $logged = AuditLog::finish('success', ['target_type' => 'device_config', 'target_count' => count($result['items'])], 200);
        if (AuditLog::id() !== null) { $result['request_id'] = AuditLog::id(); }
        if (!$logged) { $result['audit_warning'] = true; }
        Response::json($result);
    }
}
