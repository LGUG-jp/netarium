<?php
declare(strict_types=1);

namespace Netarium\Core;

use PDO;
use PDOException;
use Throwable;

final class ApiDispatcher
{
    public static function run(bool $imageUpload = false): void
    {
        date_default_timezone_set('Asia/Tokyo');

        header('Content-Type: application/json; charset=UTF-8');
        header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');

        $config = Config::create();

        $actionMap = [
            'list_users' => \Netarium\Actions\Auth\ListUsersAction::class,
            'create_user' => \Netarium\Actions\Auth\CreateUserAction::class,
            'update_user' => \Netarium\Actions\Auth\UpdateUserAction::class,
            'reset_user_password' => \Netarium\Actions\Auth\ResetUserPasswordAction::class,
            'change_own_password' => \Netarium\Actions\Auth\ChangeOwnPasswordAction::class,
            'data_quality' => \Netarium\Actions\Quality\DataQualityAction::class,
            'export_devices_csv' => \Netarium\Actions\Csv\ExportDevicesCsvAction::class,
            'download_devices_csv_template' => \Netarium\Actions\Csv\DownloadDevicesCsvTemplateAction::class,
            'preview_devices_csv_import' => \Netarium\Actions\Csv\PreviewDevicesCsvImportAction::class,
            'commit_devices_csv_import' => \Netarium\Actions\Csv\CommitDevicesCsvImportAction::class,
            'export_backup_zip' => \Netarium\Actions\Backup\ExportBackupZipAction::class,
            'preview_backup_restore' => \Netarium\Actions\Backup\PreviewBackupRestoreAction::class,
            'commit_backup_restore' => \Netarium\Actions\Backup\CommitBackupRestoreAction::class,
            'load' => \Netarium\Actions\Topology\LoadAction::class,
            'save' => \Netarium\Actions\Topology\SaveAction::class,
            'save_resources' => \Netarium\Actions\Topology\SaveResourcesAction::class,
            'list_link_systems' => \Netarium\Actions\Topology\ListLinkSystemsAction::class,
            'create_link_system' => \Netarium\Actions\Topology\CreateLinkSystemAction::class,
            'update_link_system' => \Netarium\Actions\Topology\UpdateLinkSystemAction::class,
            'delete_link_system' => \Netarium\Actions\Topology\DeleteLinkSystemAction::class,
            'upload_floor_plan' => \Netarium\Actions\FloorPlan\UploadFloorPlanAction::class,
            'delete_floor_plan' => \Netarium\Actions\FloorPlan\DeleteFloorPlanAction::class,
            'update_floor_plan_settings' => \Netarium\Actions\FloorPlan\UpdateFloorPlanSettingsAction::class,
            'upload_device_image' => \Netarium\Actions\DeviceImage\UploadDeviceImageAction::class,
            'delete_device_image' => \Netarium\Actions\DeviceImage\DeleteDeviceImageAction::class,
            'update_device_images' => \Netarium\Actions\DeviceImage\UpdateDeviceImagesAction::class,
            'ping' => \Netarium\Actions\Monitoring\PingAction::class,
            'test_exec' => \Netarium\Actions\Monitoring\TestExecAction::class,
            'test_ping' => \Netarium\Actions\Monitoring\TestPingAction::class,
        ];

        if ($imageUpload) {
            $actionMap = array_intersect_key($actionMap, array_flip(['upload_floor_plan', 'upload_device_image']));
        } else {
            unset($actionMap['upload_floor_plan'], $actionMap['upload_device_image']);
        }

        $adminActions = [
            'list_users',
            'create_user',
            'update_user',
            'reset_user_password',
            'data_quality',
            'save',
            'save_resources',
            'create_link_system',
            'update_link_system',
            'delete_link_system',
            'upload_floor_plan',
            'delete_floor_plan',
            'update_floor_plan_settings',
            'upload_device_image',
            'delete_device_image',
            'update_device_images',
            'export_devices_csv',
            'download_devices_csv_template',
            'preview_devices_csv_import',
            'commit_devices_csv_import',
            'export_backup_zip',
            'preview_backup_restore',
            'commit_backup_restore',
            'ping',
            'test_exec',
            'test_ping',
        ];

        $sharedOperationActions = [
            'data_quality',
            'export_devices_csv',
            'download_devices_csv_template',
            'preview_devices_csv_import',
            'commit_devices_csv_import',
            'export_backup_zip',
            'preview_backup_restore',
            'load',
            'save',
            'save_resources',
            'list_link_systems',
            'create_link_system',
            'update_link_system',
            'delete_link_system',
            'upload_floor_plan',
            'delete_floor_plan',
            'update_floor_plan_settings',
            'upload_device_image',
            'delete_device_image',
            'update_device_images',
            'ping',
            'test_ping',
        ];
        $auditedActionMap = [
            'create_user' => 'create_user',
            'update_user' => 'update_user',
            'reset_user_password' => 'reset_user_password',
            'change_own_password' => 'change_own_password',
            'save' => 'topology.save',
            'save_resources' => 'topology.save_resources',
            'create_link_system' => 'link_system.create',
            'update_link_system' => 'link_system.update',
            'delete_link_system' => 'link_system.delete',
            'upload_floor_plan' => 'upload_floor_plan',
            'delete_floor_plan' => 'delete_floor_plan',
            'update_floor_plan_settings' => 'update_floor_plan_settings',
            'upload_device_image' => 'upload_device_image',
            'delete_device_image' => 'delete_device_image',
            'update_device_images' => 'update_device_images',
            'preview_devices_csv_import' => 'preview_devices_csv_import',
            'commit_devices_csv_import' => 'commit_devices_csv_import',
            'export_devices_csv' => 'export_devices_csv',
            'export_backup_zip' => 'export_backup_zip',
            'preview_backup_restore' => 'preview_backup_restore',
            'commit_backup_restore' => 'commit_backup_restore',
        ];


        $operationGate = null;
        try {
            requireApiAuthentication(!$imageUpload && ($_GET['action'] ?? '') === 'change_own_password');

            $requestMethod = strtoupper($_SERVER['REQUEST_METHOD'] ?? '');

            if ($imageUpload) {
                $contentLength = (int)($_SERVER['CONTENT_LENGTH'] ?? 0);
                $postMaxBytes = (int)ini_parse_quantity((string)ini_get('post_max_size'));
                $requestMaxBytes = (int)$config['image_upload_max_request_bytes'];
                if ($contentLength > $requestMaxBytes) {
                    $requestMaxMiB = $requestMaxBytes / (1024 * 1024);
                    throw new ApiException("画像の送信全体は{$requestMaxMiB}MiB以下にしてください（multipartを含む）", 413);
                }
                if ($requestMethod === 'POST' && $postMaxBytes > 0 && $contentLength > $postMaxBytes) {
                    throw new ApiException('PHPのpost_max_sizeが画像の送信容量に不足しています。管理者にPHP設定の確認を依頼してください', 413);
                }
            }

            if ($requestMethod === 'POST') {
                requireCsrfToken();
            }

            $action = $_GET['action'] ?? '';

            if (!isset($actionMap[$action])) {
                throw new ApiException('不明なactionです', 404);
            }

            if (in_array($action, $adminActions, true)) {
                requireAdminApiRole();
            }

            if (session_status() === PHP_SESSION_ACTIVE) {
                session_write_close();
            }

            $db = Database::open($config['db_file']);

            $operationGate = new OperationGate((string)$config['operation_lock_file']);

            if ($action === 'commit_backup_restore') {
                $operationGate->acquireExclusive();
            } elseif (in_array($action, $sharedOperationActions, true)) {
                $operationGate->acquireShared();
            }

            if (isset($auditedActionMap[$action])) {
                AuditLog::begin(
                    $config,
                    $auditedActionMap[$action],
                    currentUserId(),
                    $db
                );
            }

            $actionClass = $actionMap[$action];
            /** @var \Netarium\Actions\ActionInterface $handler */
            $handler = new $actionClass();
            $handler->handle($db, $config);

        } catch (ApiException $e) {
            if ($operationGate instanceof OperationGate) {
                $operationGate->release();
            }

            if (isset($db) && $db instanceof PDO && $db->inTransaction()) {
                $db->rollBack();
            }
            if (AuditLog::id() !== null && !AuditLog::isFinished()) {
                AuditLog::finish('failure', [], $e->getHttpStatus(), $e->getHttpStatus() === 429 ? ['rate_limited'] : []);
            }

            $payload = [
                'ok' => false,
                'error' => $e->getMessage(),
            ];
            if ($e->getDetails() !== []) {
                $payload['details'] = $e->getDetails();
            }

            if (AuditLog::id() !== null) {
                $payload['request_id'] = AuditLog::id();
            }

            Response::json($payload, $e->getHttpStatus());
        } catch (Throwable $e) {
            if ($operationGate instanceof OperationGate) {
                $operationGate->release();
            }

            if (isset($db) && $db instanceof PDO && $db->inTransaction()) {
                $db->rollBack();
            }

            /*
             * 詳細はブラウザではなく、
             * WebサーバーまたはPHPのエラーログへ記録する。
             */
            error_log('[Netarium API] ' . get_class($e) . ': ' . $e->getMessage());
            $isBusy = $e instanceof PDOException && Database::isBusy($e);
            $errorStatus = $isBusy ? 503 : 500;

            if (AuditLog::id() !== null && !AuditLog::isFinished()) {
                AuditLog::finish('failure', [], $errorStatus);
            }
            $response = [
                'ok' => false,
                'error' => $isBusy
                    ? '現在、別の更新処理が実行されています。少し待ってから再度実行してください'
                    : 'サーバーエラーが発生しました',
            ];

            if (AuditLog::id() !== null) {
                $response['request_id'] = AuditLog::id();
            }

            if ((bool)($config['expose_error_detail'] ?? false)) {
                $response['detail'] = $e->getMessage();
            }

            Response::json($response, $errorStatus);
        }
    }
}
