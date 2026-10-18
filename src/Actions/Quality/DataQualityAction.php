<?php
declare(strict_types=1);

namespace Netarium\Actions\Quality;

use PDO;
use Netarium\Actions\ActionInterface;
use Netarium\Core\Request;
use Netarium\Core\Response;
use Netarium\Services\Quality\QualityDiagnosticService;

class DataQualityAction implements ActionInterface
{
    public function handle(PDO $db, array $config): void
    {
        Request::requireMethod('GET');

        $service = new QualityDiagnosticService($db);
        $result = $service->runDiagnosis($config);

        Response::json($result);
    }
}
