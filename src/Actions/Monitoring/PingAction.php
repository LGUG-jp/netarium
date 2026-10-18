<?php
declare(strict_types=1);

namespace Netarium\Actions\Monitoring;

use PDO;
use Netarium\Actions\ActionInterface;
use Netarium\Core\ApiException;
use Netarium\Core\OperationGate;
use Netarium\Core\Request;
use Netarium\Core\Response;
use Netarium\Services\Monitoring\PingService;

class PingAction implements ActionInterface
{
    public function handle(PDO $db, array $config): void
    {
        Request::requireMethod('POST');

        if (!Request::isExecAvailable()) {
            throw new ApiException(
                'PHPのexec関数が使用できません。php.iniのdisable_functionsを確認してください',
                500
            );
        }

        $input = Request::readJsonBody();
        $targets = $input['targets'] ?? null;

        if (!is_array($targets)) {
            throw new ApiException(
                'targetsが配列ではありません',
                400
            );
        }

        $requestedRevision = Request::normalizeNullableInt(
            $input['revision'] ?? null
        );

        if ($requestedRevision === null || $requestedRevision < 1) {
            throw new ApiException(
                'データリビジョンが不正です',
                400
            );
        }

        $pingGate = new OperationGate((string)($config['ping_lock_file'] ?? ''));
        $pingGate->acquireExclusive('現在、別のPingが実行中です。終了後に再度実行してください');

        try {
            $service = new PingService($db);
            $result = $service->executePing(
                $targets,
                $requestedRevision,
                $config
            );
        } finally {
            $pingGate->release();
        }

        Response::json($result);
    }
}
