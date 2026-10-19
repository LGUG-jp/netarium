<?php
declare(strict_types=1);

// セッションや認証拒否のヘッダーに上書きされないよう、送信直前に適用する。
header_register_callback(static function (): void {
    header('Cache-Control: private, no-store');
});

require_once dirname(__DIR__) . '/bootstrap.php';

use Netarium\Core\ApiException;
use Netarium\Core\OperationGate;

requirePageAuthentication();

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'GET') {
    http_response_code(405);
    header('Allow: GET');
    exit;
}

$imageId = filter_input(
    INPUT_GET,
    'image_id',
    FILTER_VALIDATE_INT,
    [
        'options' => [
            'min_range' => 1,
        ],
    ]
);

if ($imageId === false || $imageId === null) {
    http_response_code(400);
    exit;
}

$size = (string)($_GET['size'] ?? '');

$operationGate = null;
try {
    $config = \Netarium\Core\Config::create();
    $operationGate = new OperationGate(
        (string)$config['operation_lock_file']
    );
    $operationGate->acquireShared();

    $db = authDatabase();

    $stmt = $db->prepare("
        SELECT
            id,
            device_id,
            stored_name,
            mime_type,
            file_size
        FROM device_images
        WHERE id = :id
    ");

    $stmt->execute([':id' => $imageId]);
    $imageRecord = $stmt->fetch();

    if (!$imageRecord) {
        http_response_code(404);
        exit;
    }

    $storedName = (string)$imageRecord['stored_name'];
    if (preg_match('/\A[a-f0-9]{32}\.(?:png|jpg)\z/', $storedName) !== 1) {
        error_log('[Device Image] Invalid stored name: ' . $storedName);
        http_response_code(404);
        exit;
    }

    $storageDirectory = (string)$config['device_image_directory'];
    $storageRealPath = realpath($storageDirectory);
    $filePath = $storageDirectory . DIRECTORY_SEPARATOR . $storedName;
    $fileRealPath = realpath($filePath);

    if (
        $storageRealPath === false ||
        $fileRealPath === false ||
        !is_file($fileRealPath) ||
        !is_readable($fileRealPath)
    ) {
        http_response_code(404);
        exit;
    }

    $storagePrefix = rtrim($storageRealPath, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR;
    if (strncmp($fileRealPath, $storagePrefix, strlen($storagePrefix)) !== 0) {
        error_log('[Device Image] Path traversal attempt: ' . $fileRealPath);
        http_response_code(404);
        exit;
    }

    $mimeType = (string)$imageRecord['mime_type'];
    if (!in_array($mimeType, ['image/png', 'image/jpeg'], true)) {
        http_response_code(404);
        exit;
    }

    $servePath = $fileRealPath;

    // サムネイル配信 (size=thumb)
    if ($size === 'thumb' && extension_loaded('gd')) {
        $thumbDir = (string)$config['device_image_thumb_directory'];
        if (!is_dir($thumbDir)) {
            @mkdir($thumbDir, 0755, true);
        }

        $thumbName = 'thumb_320_' . $storedName;
        $thumbPath = $thumbDir . DIRECTORY_SEPARATOR . $thumbName;

        if (!is_file($thumbPath)) {
            $srcImage = $mimeType === 'image/jpeg' ? @imagecreatefromjpeg($fileRealPath) : @imagecreatefrompng($fileRealPath);
            if ($srcImage instanceof \GdImage) {
                $origW = imagesx($srcImage);
                $origH = imagesy($srcImage);
                $maxDim = (int)($config['device_image_thumb_max_dimension'] ?? 320);

                if ($origW > $maxDim || $origH > $maxDim) {
                    if ($origW >= $origH) {
                        $targetW = $maxDim;
                        $targetH = max(1, (int)round($origH * ($maxDim / $origW)));
                    } else {
                        $targetH = $maxDim;
                        $targetW = max(1, (int)round($origW * ($maxDim / $origH)));
                    }

                    $thumbImage = imagecreatetruecolor($targetW, $targetH);
                    if ($mimeType === 'image/png') {
                        imagealphablending($thumbImage, false);
                        imagesavealpha($thumbImage, true);
                    }
                    imagecopyresampled($thumbImage, $srcImage, 0, 0, 0, 0, $targetW, $targetH, $origW, $origH);
                    $srcImage = $thumbImage;
                    unset($thumbImage);
                }

                if ($mimeType === 'image/jpeg') {
                    imagejpeg($srcImage, $thumbPath, 85);
                } else {
                    imagealphablending($srcImage, false);
                    imagesavealpha($srcImage, true);
                    imagepng($srcImage, $thumbPath, 8);
                }
                unset($srcImage);
            }
        }

        if (is_file($thumbPath) && is_readable($thumbPath)) {
            $servePath = $thumbPath;
        }
    }

    $actualSize = filesize($servePath);
    if ($actualSize === false) {
        http_response_code(500);
        exit;
    }

    header('Content-Type: ' . $mimeType);
    header('Content-Length: ' . (string)$actualSize);
    header('Content-Disposition: inline');

    readfile($servePath);
    $operationGate->release();
    exit;

} catch (ApiException $e) {
    if (isset($operationGate) && $operationGate instanceof OperationGate) {
        $operationGate->release();
    }
    http_response_code($e->getHttpStatus());
    exit;
} catch (Throwable $e) {
    if (isset($operationGate) && $operationGate instanceof OperationGate) {
        $operationGate->release();
    }
    error_log('[Device Image] ' . get_class($e) . ': ' . $e->getMessage());
    http_response_code(500);
    exit;
}
