<?php
declare(strict_types=1);

namespace Netarium\Actions\Monitoring;

use PDO;
use Netarium\Actions\ActionInterface;
use Netarium\Core\ApiException;
use Netarium\Core\Request;
use Netarium\Core\Response;
use Netarium\Services\Monitoring\PingService;

class TestPingAction implements ActionInterface
{
    public function handle(PDO $db, array $config): void
    {
        if (!($config['enable_diagnostics'] ?? false)) {
            throw new ApiException('診断用APIは無効です', 404);
        }

        Request::requireMethod('GET');

        if (!Request::isExecAvailable()) {
            throw new ApiException('exec関数が使用できません', 500);
        }

        $service = new PingService($db);
        $result = $service->pingHost(
            '127.0.0.1',
            (int)($config['ping_timeout_ms'] ?? 1000),
            false
        );

        Response::json([
            'ok' => true,
            'target' => '127.0.0.1',
            'result' => $result,
        ]);
    }
}
