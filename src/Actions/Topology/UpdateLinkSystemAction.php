<?php
declare(strict_types=1);

namespace Netarium\Actions\Topology;

use PDO;
use Netarium\Actions\ActionInterface;
use Netarium\Core\AuditLog;
use Netarium\Core\Request;
use Netarium\Core\Response;
use Netarium\Services\Topology\LinkSystemService;

final class UpdateLinkSystemAction implements ActionInterface
{
    public function handle(PDO $db, array $config): void
    {
        Request::requireMethod('POST');
        $input = Request::readJsonBody();
        $result = (new LinkSystemService($db))->mutate('update', $input);
        $auditSuccess = AuditLog::finish('success', ['target_type' => 'link_system', 'target_count' => 1], 200);
        if (AuditLog::id() !== null) {
            $result['request_id'] = AuditLog::id();
        }
        if (!$auditSuccess) {
            $result['audit_warning'] = true;
        }
        Response::json($result);
    }
}
