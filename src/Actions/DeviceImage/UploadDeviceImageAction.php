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

class UploadDeviceImageAction implements ActionInterface
{
    public function handle(PDO $db, array $config): void
    {
        Request::requireMethod('POST');

        $deviceId = (int)($_POST['device_id'] ?? 0);
        $requestedRevision = (int)($_POST['revision'] ?? 0);
        $caption = (string)($_POST['caption'] ?? '');
        $replaceImageId = isset($_POST['replace_image_id']) && trim((string)$_POST['replace_image_id']) !== ''
            ? (int)$_POST['replace_image_id']
            : null;

        if (!isset($_FILES['image']) || !is_array($_FILES['image'])) {
            throw new ApiException('アップロードする画像を選択してください', 400);
        }

        $service = new DeviceImageService($db);
        $result = $service->uploadDeviceImage(
            $deviceId,
            $requestedRevision,
            $_FILES['image'],
            $caption,
            $replaceImageId,
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
