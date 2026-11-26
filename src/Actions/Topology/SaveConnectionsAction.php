<?php
declare(strict_types=1);

namespace Netarium\Actions\Topology;

use PDO;
use Netarium\Actions\ActionInterface;
use Netarium\Core\AuditLog;
use Netarium\Core\Request;
use Netarium\Core\Response;
use Netarium\Services\Topology\ConnectionSaveService;

final class SaveConnectionsAction implements ActionInterface
{
    public function handle(PDO $db, array $config): void
    {
        Request::requireMethod('POST');
        $result = (new ConnectionSaveService($db))->save(Request::readJsonBody(), $config);
        $target = isset($result['completed_legacy_vlan_link_id'])
            ? ['target_type' => 'legacy_link_vlan', 'target_id' => $result['completed_legacy_vlan_link_id'], 'target_count' => 1]
            : [
                'target_type' => 'device',
                'target_count' => count($result['links']) + count($result['device_ports']) +
                    count($result['deleted_link_ids']) + count($result['deleted_device_port_ids']),
            ];
        $logged = AuditLog::finish('success', $target, 200);
        if (AuditLog::id() !== null) { $result['request_id'] = AuditLog::id(); }
        if (!$logged) { $result['audit_warning'] = true; }
        Response::json($result);
    }
}
