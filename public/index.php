<?php
declare(strict_types=1);

require_once dirname(__DIR__) . '/bootstrap.php';


$appConfig = \Netarium\Core\Config::create();
$storageCapacity = $appConfig['storage_capacity'];


header('Content-Type: text/html; charset=UTF-8');

requirePageAuthentication();

$csrfToken = getCsrfToken();
$username = currentUsername();
$userRole = currentUserRole();
$isAdmin = isAdminUser();

?>
<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>
        Netarium v<?= htmlspecialchars(
            NETARIUM_VERSION,
            ENT_QUOTES,
            'UTF-8'
        ) ?>
    </title>
    <link rel="icon" type="image/svg+xml" sizes="any" href="assets/icons/brand/netarium-mark-compact.svg">
    <script nonce="<?= htmlspecialchars(\Netarium\Core\SecurityHeaders::nonce(), ENT_QUOTES, 'UTF-8') ?>">
        window.APP_CONFIG = Object.freeze({
            csrfToken: <?= json_encode(
                $csrfToken,
                JSON_UNESCAPED_UNICODE |
                JSON_UNESCAPED_SLASHES |
                JSON_HEX_TAG |
                JSON_HEX_AMP |
                JSON_HEX_APOS |
                JSON_HEX_QUOT
            ) ?>,
            capacity: Object.freeze({
                floorPlanMaxBytes:
                    <?= (int)$appConfig['floor_plan_upload_max_bytes'] ?>,
                floorPlanMaxDimension:
                    <?= (int)$appConfig['floor_plan_upload_max_dimension'] ?>,
                floorPlanMaxPixels:
                    <?= (int)$appConfig['floor_plan_upload_max_pixels'] ?>,
                imageUploadMaxRequestBytes:
                    <?= (int)$appConfig['image_upload_max_request_bytes'] ?>,
                deviceImageMaxBytes:
                    <?= (int)$storageCapacity['images']['max_entry_bytes'] ?>,
                deviceImageMaxWidth:
                    <?= (int)$appConfig['max_device_image_width'] ?>,
                deviceImageMaxHeight:
                    <?= (int)$appConfig['max_device_image_height'] ?>,
                deviceImageMaxPixels:
                    <?= (int)$appConfig['max_device_image_pixels'] ?>,
                deviceImageMaxDimension:
                    <?= (int)$appConfig['device_image_max_dimension'] ?>,
                floorPlanMaxFiles:
                    <?= (int)$storageCapacity['floor_plans']['max_files'] ?>,
                imageMaxTotalBytes:
                    <?= (int)$storageCapacity['images']['max_total_bytes'] ?>,
                backupMaxZipBytes:
                    <?= (int)$storageCapacity['backup']['max_zip_bytes'] ?>
            }),
            linkRoute: Object.freeze({
                maxPoints: <?= \Netarium\Services\Topology\LinkRoute::MAX_POINTS ?>
            }),

            user: Object.freeze({
                id: <?= (int)currentUserId() ?>,
                username: <?= json_encode(
                    $username,
                    JSON_UNESCAPED_UNICODE |
                    JSON_UNESCAPED_SLASHES |
                    JSON_HEX_TAG |
                    JSON_HEX_AMP |
                    JSON_HEX_APOS |
                    JSON_HEX_QUOT
                ) ?>,
                role: <?= json_encode(
                    $userRole,
                    JSON_UNESCAPED_UNICODE |
                    JSON_UNESCAPED_SLASHES |
                    JSON_HEX_TAG |
                    JSON_HEX_AMP |
                    JSON_HEX_APOS |
                    JSON_HEX_QUOT
                ) ?>,
                isAdmin:
                    <?= $isAdmin ? 'true' : 'false' ?>
            })
        });
    </script>
    <link
        rel="stylesheet"
        href="style.css?v=<?= rawurlencode(
            (string)filemtime(__DIR__ . '/style.css')
        ) ?>"
    >

</head>
<body>

    <?php require dirname(__DIR__) . '/templates/components/toolbar.php'; ?>

    <?php require dirname(__DIR__) . '/templates/components/tool_palette.php'; ?>

    <?php require dirname(__DIR__) . '/templates/components/canvas.php'; ?>

    <?php require dirname(__DIR__) . '/templates/components/property_panel.php'; ?>

    <?php require dirname(__DIR__) . '/templates/components/link_panel.php'; ?>

    <?php require dirname(__DIR__) . '/templates/components/status_bar.php'; ?>

    <?php require dirname(__DIR__) . '/templates/components/toast.php'; ?>


    <?php require dirname(__DIR__) . '/templates/modals/device_search.php'; ?>

    <?php require dirname(__DIR__) . '/templates/modals/ledger.php'; ?>

    <?php require dirname(__DIR__) . '/templates/modals/backup.php'; ?>

    <?php require dirname(__DIR__) . '/templates/modals/csv_import.php'; ?>

    <?php require dirname(__DIR__) . '/templates/modals/view_manager.php'; ?>

    <?php require dirname(__DIR__) . '/templates/modals/floor_plan_manager.php'; ?>

    <?php require dirname(__DIR__) . '/templates/components/canvas_context_toolbar.php'; ?>

    <?php require dirname(__DIR__) . '/templates/modals/placement_manager.php'; ?>

    <?php require dirname(__DIR__) . '/templates/modals/dashboard.php'; ?>

    <?php require dirname(__DIR__) . '/templates/modals/data_quality.php'; ?>

    <?php require dirname(__DIR__) . '/templates/modals/management_connection.php'; ?>

    <?php require dirname(__DIR__) . '/templates/modals/account.php'; ?>

    <?php require dirname(__DIR__) . '/templates/modals/link_display_settings.php'; ?>

    <?php require dirname(__DIR__) . '/templates/modals/print.php'; ?>

    <?php require dirname(__DIR__) . '/templates/modals/link_systems.php'; ?>
    <?php require dirname(__DIR__) . '/templates/modals/link_bulk.php'; ?>
    <?php require dirname(__DIR__) . '/templates/modals/ping_results.php'; ?>
    <?php require dirname(__DIR__) . '/templates/modals/hidden_terminal.php'; ?>

    <script
        type="module"
        src="js/main.js?v=<?= rawurlencode(
            (string)filemtime(__DIR__ . '/js/main.js')
        ) ?>"
    ></script>

</body>
</html>
