<?php
declare(strict_types=1);

namespace Netarium\Actions\DeviceImage;

use PDO;
use Netarium\Actions\ActionInterface;
use Netarium\Core\ApiException;
use Netarium\Core\AuditLog;
use Netarium\Core\Request;
use Netarium\Core\Response;
use Netarium\Services\DeviceImage\DeviceImageService;

class UpdateDeviceImagesAction implements ActionInterface
{
    public function handle(PDO $db, array $config): void
    {
        Request::requireMethod('POST');

        $input = Request::readJsonBody();
        if ($input === []) {
            $input = $_POST;
        }

        $deviceId = (int)($input['device_id'] ?? 0);
        $requestedRevision = (int)($input['revision'] ?? 0);
        $images = $input['images'] ?? null;

        if ($deviceId <= 0 || !is_array($images)) {
            throw new ApiException('パラメータが不正です', 400);
        }

        $service = new DeviceImageService($db);
        $result = $service->updateDeviceImages(
            $deviceId,
            $requestedRevision,
            $images,
            $config
        );

        $auditSuccess = AuditLog::finish('success', [
            'target_type' => 'device',
            'target_id' => $deviceId,
        ], 200);

        if (AuditLog::id() !== null) {
            $result['request_id'] = AuditLog::id();
        }
        if (!$auditSuccess) {
            $result['audit_warning'] = true;
        }

        Response::json($result);
    }
}
