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

if (
    ($_SERVER['REQUEST_METHOD'] ?? '') !==
    'GET'
) {
    http_response_code(405);
    header('Allow: GET');
    exit;
}

$viewId = filter_input(
    INPUT_GET,
    'view_id',
    FILTER_VALIDATE_INT,
    [
        'options' => [
            'min_range' => 1,
        ],
    ]
);

if ($viewId === false || $viewId === null) {
    http_response_code(400);
    exit;
}

try {
    $config = \Netarium\Core\Config::create();
    $operationGate = new OperationGate(
        (string)$config['operation_lock_file']
    );
    $operationGate->acquireShared();

    $db = authDatabase();

    $stmt = $db->prepare("
        SELECT
            stored_name,
            mime_type,
            file_size
        FROM view_floor_plans
        WHERE view_id = :view_id
    ");

    $stmt->execute([
        ':view_id' => $viewId,
    ]);

    $floorPlan = $stmt->fetch();

    if (!$floorPlan) {
        http_response_code(404);
        exit;
    }

    $storedName =
        (string)$floorPlan['stored_name'];

    if (
        preg_match(
            '/\A[a-f0-9]{32}\.(?:png|jpg)\z/',
            $storedName
        ) !== 1
    ) {
        error_log(
            '[Floor Plan] Invalid stored name: '
            . $storedName
        );

        http_response_code(404);
        exit;
    }

    $storageDirectory = (string)$config['floor_plan_directory'];

    $storageRealPath =
        realpath($storageDirectory);

    $filePath =
        $storageDirectory .
        DIRECTORY_SEPARATOR .
        $storedName;

    $fileRealPath =
        realpath($filePath);

    if (
        $storageRealPath === false ||
        $fileRealPath === false ||
        !is_file($fileRealPath) ||
        !is_readable($fileRealPath)
    ) {
        http_response_code(404);
        exit;
    }

    $storagePrefix =
        rtrim(
            $storageRealPath,
            DIRECTORY_SEPARATOR
        ) . DIRECTORY_SEPARATOR;

    if (
        strncmp(
            $fileRealPath,
            $storagePrefix,
            strlen($storagePrefix)
        ) !== 0
    ) {
        error_log(
            '[Floor Plan] Invalid file path: '
            . $fileRealPath
        );

        http_response_code(404);
        exit;
    }

    $mimeType =
        (string)$floorPlan['mime_type'];

    if (
        !in_array(
            $mimeType,
            [
                'image/png',
                'image/jpeg',
            ],
            true
        )
    ) {
        http_response_code(404);
        exit;
    }

    $actualSize = filesize($fileRealPath);

    if ($actualSize === false) {
        http_response_code(500);
        exit;
    }

    header(
        'Content-Type: ' . $mimeType
    );

    header(
        'Content-Length: ' .
        (string)$actualSize
    );

    header(
        'Content-Disposition: inline'
    );


    readfile($fileRealPath);
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

    error_log(
        '[Floor Plan] '
        . get_class($e)
        . ': '
        . $e->getMessage()
    );

    http_response_code(500);
    exit;
}
