<?php
declare(strict_types=1);

namespace Netarium\Actions\Csv;

use PDO;
use Netarium\Actions\ActionInterface;
use Netarium\Core\Request;
use Netarium\Services\Csv\CsvImportExportService;

class DownloadDevicesCsvTemplateAction implements ActionInterface
{
    public function handle(PDO $db, array $config): void
    {
        Request::requireMethod('GET');

        $service = new CsvImportExportService($db);
        $service->downloadDevicesCsvTemplate();
    }
}
