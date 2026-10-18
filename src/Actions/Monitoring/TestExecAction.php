<?php
declare(strict_types=1);

namespace Netarium\Actions\Monitoring;

use PDO;
use Netarium\Actions\ActionInterface;
use Netarium\Core\ApiException;
use Netarium\Core\Request;
use Netarium\Core\Response;

class TestExecAction implements ActionInterface
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

        $output = [];
        $code = 1;

        exec('whoami 2>&1', $output, $code);

        Response::json([
            'ok' => true,
            'code' => $code,
            'output' => $output,
        ]);
    }
}
