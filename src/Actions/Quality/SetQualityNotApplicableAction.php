<?php
declare(strict_types=1);

namespace Netarium\Actions\Quality;

use Netarium\Actions\ActionInterface;
use Netarium\Core\AuditLog;
use Netarium\Core\Request;
use Netarium\Core\Response;
use Netarium\Services\Quality\QualityNotApplicable;
use PDO;

final class SetQualityNotApplicableAction implements ActionInterface
{
    public function handle(PDO $db, array $config): void
    {
        Request::requireMethod('POST');
        $input = Request::readJsonBody();
        $result = (new QualityNotApplicable($db))->set($input, $config);
        $logged = AuditLog::finish('success', [
            'target_type' => $result['link_id'] === null ? 'device' : 'link',
            'target_id' => $result['link_id'] ?? $result['device_id'],
            'target_count' => $result['unchanged'] ? 0 : 1,
        ], 200, [$result['not_applicable'] ? 'set' : 'clear', $result['field']]);
        if (AuditLog::id() !== null) { $result['request_id'] = AuditLog::id(); }
        if (!$logged) { $result['audit_warning'] = true; }
        Response::json($result);
    }
}
