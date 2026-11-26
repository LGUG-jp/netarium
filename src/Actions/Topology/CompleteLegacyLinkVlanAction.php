<?php
declare(strict_types=1);

namespace Netarium\Actions\Topology;

use Netarium\Actions\ActionInterface;
use Netarium\Core\AuditLog;
use Netarium\Core\Request;
use Netarium\Core\Response;
use Netarium\Services\Topology\ConnectionSaveService;
use PDO;

final class CompleteLegacyLinkVlanAction implements ActionInterface
{
    public function handle(PDO $db, array $config): void
    {
        Request::requireMethod('POST');
        $result = (new ConnectionSaveService($db))->deleteUnmigratedVlan(Request::readJsonBody());
        $logged = AuditLog::finish('success', [
            'target_type' => 'legacy_link_vlan',
            'target_id' => $result['link_id'],
            'target_count' => 1,
        ], 200);
        if (AuditLog::id() !== null) { $result['request_id'] = AuditLog::id(); }
        if (!$logged) { $result['audit_warning'] = true; }
        Response::json($result);
    }
}
