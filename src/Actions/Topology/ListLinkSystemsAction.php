<?php
declare(strict_types=1);

namespace Netarium\Actions\Topology;

use PDO;
use Netarium\Actions\ActionInterface;
use Netarium\Core\Request;
use Netarium\Core\Response;
use Netarium\Services\Topology\LinkSystemService;

final class ListLinkSystemsAction implements ActionInterface
{
    public function handle(PDO $db, array $config): void
    {
        Request::requireMethod('GET');
        $result = (new LinkSystemService($db))->list();
        Response::json($result);
    }
}
