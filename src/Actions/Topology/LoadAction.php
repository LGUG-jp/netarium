<?php
declare(strict_types=1);

namespace Netarium\Actions\Topology;

use PDO;
use Netarium\Actions\ActionInterface;
use Netarium\Core\Request;
use Netarium\Core\Response;
use Netarium\Services\Topology\TopologyService;

class LoadAction implements ActionInterface
{
    public function handle(PDO $db, array $config): void
    {
        Request::requireMethod('GET');

        $service = new TopologyService($db);
        $result = $service->load();

        Response::json($result);
    }
}
