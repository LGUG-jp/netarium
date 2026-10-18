<?php
declare(strict_types=1);

namespace Netarium\Services\FloorPlan;

use PDO;
use PDOException;
use Throwable;
use Netarium\Core\ApiException;
use Netarium\Core\Database;
use Netarium\Core\Request;
use Netarium\Repositories\AppMetaRepository;
use Netarium\Repositories\FloorPlanRepository;
use Netarium\Repositories\ViewRepository;
use Netarium\Repositories\DeviceImageRepository;

use Netarium\Services\Storage\CapacityService;

class FloorPlanService
{
    private PDO $db;
    private AppMetaRepository $appMetaRepo;
    private FloorPlanRepository $floorPlanRepo;
    private ViewRepository $viewRepo;

    public function __construct(PDO $db)
    {
        $this->db = $db;
        $this->appMetaRepo = new AppMetaRepository($db);
        $this->floorPlanRepo = new FloorPlanRepository($db);
        $this->viewRepo = new ViewRepository($db);
    }

    public function getFloorPlanView(int $viewId): ?array
    {
        return $this->viewRepo->getById($viewId);
    }

    public function sanitizeOriginalFilename(string $filename): string
    {
        $filename = basename(str_replace('\\', '/', $filename));
        $filename = preg_replace('/[\x00-\x1F\x7F]/u', '', $filename) ?? '';
        $filename = trim($filename);

        if ($filename === '') {
            return 'floor-plan';
        }

        if (function_exists('mb_substr')) {
            return mb_substr($filename, 0, 255, 'UTF-8');
        }

        if (function_exists('iconv_substr')) {
            $result = @iconv_substr($filename, 0, 255, 'UTF-8');
            if ($result !== false) {
                return $result;
            }
        }

        if (@preg_match('/^.{0,255}/us', $filename, $matches)) {
            return $matches[0];
        }

        return substr($filename, 0, 255);
    }

    public function deleteFloorPlanFile(string $directory, ?string $storedName): void
    {
        if (
            $storedName === null ||
            preg_match('/\A[a-f0-9]{32}\.(?:png|jpg)\z/', $storedName) !== 1
        ) {
            return;
        }

        $path = $directory . DIRECTORY_SEPARATOR . $storedName;

        if (is_file($path) && !@unlink($path)) {
            error_log('[Floor Plan] Failed to delete: ' . $path);
        }
    }

    /**
     * フロア図面のアップロード登録
     */
    public function uploadFloorPlan(int $viewId, int $requestedRevision, array $uploadedFile, array $config): array
    {
        if ($viewId <= 0) {
            throw new ApiException('ビューIDが不正です', 400);
        }

        $this->appMetaRepo->requireMatchingResourceRevision('views', $viewId, $requestedRevision);

        $view = $this->getFloorPlanView($viewId);

        if (!$view) {
            throw new ApiException('対象のビューが見つかりません', 404);
        }

        if ((string)$view['view_type'] !== 'floor') {
            throw new ApiException('フロア図面は物理・フロア配置図にだけ登録できます', 400);
        }

        $uploadError = (int)($uploadedFile['error'] ?? UPLOAD_ERR_NO_FILE);

        if ($uploadError !== UPLOAD_ERR_OK) {
            $message = match ($uploadError) {
                UPLOAD_ERR_INI_SIZE => 'PHPのupload_max_filesize上限を超えています。' .
                    CapacityService::formatBytes(max(1, (int)($config['floor_plan_upload_max_bytes'] ?? 30 * 1024 * 1024))) .
                    'までの図面を受け付けるにはサーバー設定を確認してください',
                UPLOAD_ERR_FORM_SIZE => '図面ファイルの容量が上限を超えています',
                UPLOAD_ERR_PARTIAL => '図面ファイルのアップロードが完了しませんでした',
                UPLOAD_ERR_NO_FILE => 'アップロードする図面を選択してください',
                UPLOAD_ERR_NO_TMP_DIR => 'アップロード一時ディレクトリがありません',
                UPLOAD_ERR_CANT_WRITE => 'アップロードファイルを書き込めませんでした',
                UPLOAD_ERR_EXTENSION => 'PHP拡張機能によりアップロードが中止されました',
                default => '図面ファイルをアップロードできませんでした',
            };

            throw new ApiException($message, 400);
        }

        $temporaryPath = (string)($uploadedFile['tmp_name'] ?? '');

        if ($temporaryPath === '' || !is_uploaded_file($temporaryPath)) {
            throw new ApiException('アップロードファイルを確認できません', 400);
        }

        $storageDirectory = (string)$config['floor_plan_directory'];
        $converted = (new FloorPlanImageConverter())->convert($temporaryPath, $storageDirectory, $config);
        $storedName = $converted['stored_name'];
        $mimeType = $converted['mime_type'];
        $fileSize = $converted['file_size'];
        $imageWidth = $converted['image_width'];
        $imageHeight = $converted['image_height'];

        $originalName = $this->sanitizeOriginalFilename((string)($uploadedFile['name'] ?? 'floor-plan'));
        $oldStoredName = null;
        $newRevision = 0;
        $floorPlanRevision = 1;
        $savedAt = date(DATE_ATOM);

        try {
            $this->db->beginTransaction();

            $newRevision = $this->appMetaRepo->claimResourceRevision('views', $viewId, $requestedRevision);

            /*
             * 更新競合の検証後に旧ファイルを取得する。
             */
            $oldFloorPlan = $this->floorPlanRepo->getByViewId($viewId);

            if ($oldFloorPlan) {
                $oldStoredName = (string)$oldFloorPlan['stored_name'];
                $floorPlanRevision = max(1, (int)$oldFloorPlan['revision'] + 1);
            }

            // The revision claim acquires SQLite's write lock before reading shared usage.
            // Recheck both the plan count and final encoded bytes in the committing transaction.
            $existingFloorPlans = $this->floorPlanRepo->getAll();
            $existingBytes = 0;
            foreach ($existingFloorPlans as $existing) {
                $existingBytes += max(0, (int)($existing['file_size'] ?? 0));
            }
            $nextFileCount = count($existingFloorPlans) + ($oldFloorPlan === null ? 1 : 0);
            $nextTotalBytes = max(0, $existingBytes - max(0, (int)($oldFloorPlan['file_size'] ?? 0))) + $fileSize;
            $floorPlanLimits = CapacityService::limits($config)['floor_plans'];
            if ($nextFileCount > $floorPlanLimits['max_files']) {
                throw new ApiException('フロア図面の登録数が上限を超えています（最大' . $floorPlanLimits['max_files'] . '件）', 400);
            }
            $deviceImageUsage = (new DeviceImageRepository($this->db))->getTotalUsage();
            CapacityService::assertImageUsage(
                $nextFileCount + $deviceImageUsage['count'],
                $nextTotalBytes + $deviceImageUsage['bytes'],
                $config,
                '画像'
            );

            $this->floorPlanRepo->upsert([
                'view_id' => $viewId,
                'stored_name' => $storedName,
                'original_name' => $originalName,
                'mime_type' => $mimeType,
                'file_size' => $fileSize,
                'sha256' => $converted['sha256'],
                'image_width' => $imageWidth,
                'image_height' => $imageHeight,
                'revision' => $floorPlanRevision,
                'created_at' => $savedAt,
                'updated_at' => $savedAt,
            ]);
            $savedFloorPlan = $this->floorPlanRepo->getByViewId($viewId);

            $this->appMetaRepo->set('last_saved_at', $savedAt);

            $viewRevision = $this->appMetaRepo->getResourceRevision('views', $viewId);
            $this->db->commit();
        } catch (Throwable $e) {
            if ($this->db->inTransaction()) {
                $this->db->rollBack();
            }

            $this->deleteFloorPlanFile($storageDirectory, $storedName);

            if ($e instanceof PDOException && Database::isBusy($e)) {
                throw new ApiException(
                    '現在、別の更新処理が実行されています。少し待ってから再度実行してください',
                    409
                );
            }

            throw $e;
        }

        if ($oldStoredName !== null && $oldStoredName !== $storedName) {
            $this->deleteFloorPlanFile($storageDirectory, $oldStoredName);
        }

        return [
            'ok' => true,
            'message' => $oldStoredName === null ? 'フロア図面を登録しました' : 'フロア図面を差し替えました',
            'revision' => $newRevision,
            'view_revision' => $viewRevision,
            'saved_at' => $savedAt,
            'floor_plan' => [
                'view_id' => $viewId,
                'original_name' => $originalName,
                'mime_type' => $mimeType,
                'file_size' => $fileSize,
                'image_width' => $imageWidth,
                'image_height' => $imageHeight,
                'x' => (float)$savedFloorPlan['x'],
                'y' => (float)$savedFloorPlan['y'],
                'scale' => (float)$savedFloorPlan['scale'],
                'opacity' => (float)$savedFloorPlan['opacity'],
                'is_visible' => (int)$savedFloorPlan['is_visible'],
                'revision' => $floorPlanRevision,
                'created_at' => (string)$savedFloorPlan['created_at'],
                'updated_at' => $savedAt,
                'image_url' =>
                    'floor_plan.php?view_id=' .
                    rawurlencode((string)$viewId) .
                    '&v=' .
                    rawurlencode((string)$floorPlanRevision) .
                    '&cache_policy=200-1',
            ],
            'capacity' => CapacityService::imageUsage(
                $nextFileCount + $deviceImageUsage['count'],
                $nextTotalBytes + $deviceImageUsage['bytes'],
                $config
            ),
        ];
    }

    /**
     * フロア図面の削除
     */
    public function deleteFloorPlan(int $viewId, int $requestedRevision, array $config): array
    {
        if ($viewId <= 0) {
            throw new ApiException('ビューIDが不正です', 400);
        }

        $this->appMetaRepo->requireMatchingResourceRevision('views', $viewId, $requestedRevision);

        $view = $this->getFloorPlanView($viewId);

        if (!$view) {
            throw new ApiException('対象のビューが見つかりません', 404);
        }

        $storedName = null;
        $newRevision = 0;
        $savedAt = date(DATE_ATOM);

        $this->db->beginTransaction();

        try {
            $newRevision = $this->appMetaRepo->claimResourceRevision('views', $viewId, $requestedRevision);

            $oldFloorPlan = $this->floorPlanRepo->getByViewId($viewId);

            if (!$oldFloorPlan) {
                throw new ApiException('削除するフロア図面がありません', 404);
            }

            $storedName = (string)$oldFloorPlan['stored_name'];

            $this->floorPlanRepo->delete($viewId);
            $this->appMetaRepo->set('last_saved_at', $savedAt);

            $viewRevision = $this->appMetaRepo->getResourceRevision('views', $viewId);
            $this->db->commit();
        } catch (Throwable $e) {
            if ($this->db->inTransaction()) {
                $this->db->rollBack();
            }

            if ($e instanceof PDOException && Database::isBusy($e)) {
                throw new ApiException(
                    '現在、別の更新処理が実行されています。少し待ってから再度実行してください',
                    409
                );
            }

            throw $e;
        }

        $this->deleteFloorPlanFile((string)$config['floor_plan_directory'], $storedName);

        return [
            'ok' => true,
            'message' => 'フロア図面を削除しました',
            'revision' => $newRevision,
            'view_revision' => $viewRevision,
            'saved_at' => $savedAt,
            'view_id' => $viewId,
        ];
    }

    /**
     * フロア図面の表示設定更新
     */
    public function updateFloorPlanSettings(int $viewId, int $requestedRevision, array $input): array
    {
        if ($viewId <= 0) {
            throw new ApiException('ビューIDが不正です', 400);
        }

        $view = $this->getFloorPlanView($viewId);
        try {
            $this->appMetaRepo->requireMatchingResourceRevision('views', $viewId, $requestedRevision);
        } catch (ApiException $e) {
            if ($e->getHttpStatus() === 409) {
                throw new ApiException($e->getMessage(), 409, [
                    'conflicts' => [['kind' => 'views', 'id' => $viewId, 'name' => $view['name'] ?? '削除済み']],
                ]);
            }
            throw $e;
        }

        if (!$view) {
            throw new ApiException('対象のビューが見つかりません', 404);
        }

        if ((string)$view['view_type'] !== 'floor') {
            throw new ApiException('図面設定は物理・フロア配置図にだけ保存できます', 400);
        }

        foreach (['x', 'y', 'scale', 'opacity'] as $requiredKey) {
            if (!array_key_exists($requiredKey, $input) || !is_numeric($input[$requiredKey])) {
                throw new ApiException('図面設定の数値が不正です', 400);
            }
        }

        $x = Request::normalizeFiniteNumber($input['x'], 0);
        $y = Request::normalizeFiniteNumber($input['y'], 0);
        $scale = Request::normalizeFiniteNumber($input['scale'], 1);
        $opacity = Request::normalizeFiniteNumber($input['opacity'], 1);

        $visibleValue = $input['is_visible'] ?? null;

        if (!in_array($visibleValue, [0, 1, '0', '1', false, true], true)) {
            throw new ApiException('図面の表示設定が不正です', 400);
        }

        $isVisible = ($visibleValue === 1 || $visibleValue === '1' || $visibleValue === true) ? 1 : 0;

        if ($x < -100000 || $x > 100000 || $y < -100000 || $y > 100000) {
            throw new ApiException('図面位置は-100000から100000の範囲で指定してください', 400);
        }

        if ($scale < 0.05 || $scale > 2) {
            throw new ApiException('図面倍率は5%から200%の範囲で指定してください', 400);
        }

        if ($opacity < 0.1 || $opacity > 1) {
            throw new ApiException('図面の透明度は10%から100%の範囲で指定してください', 400);
        }

        $newRevision = 0;
        $floorPlanRevision = 0;
        $savedAt = date(DATE_ATOM);

        $this->db->beginTransaction();

        try {
            $newRevision = $this->appMetaRepo->claimResourceRevision('views', $viewId, $requestedRevision);

            $stmt = $this->db->prepare("
                UPDATE view_floor_plans
                SET
                    x = :x,
                    y = :y,
                    scale = :scale,
                    opacity = :opacity,
                    is_visible = :is_visible,
                    revision = revision + 1,
                    updated_at = :updated_at
                WHERE view_id = :view_id
            ");

            $stmt->execute([
                ':x' => $x,
                ':y' => $y,
                ':scale' => $scale,
                ':opacity' => $opacity,
                ':is_visible' => $isVisible,
                ':updated_at' => $savedAt,
                ':view_id' => $viewId,
            ]);

            if ($stmt->rowCount() !== 1) {
                throw new ApiException('保存するフロア図面がありません', 404);
            }

            $revisionStmt = $this->db->prepare("
                SELECT revision
                FROM view_floor_plans
                WHERE view_id = :view_id
            ");

            $revisionStmt->execute([':view_id' => $viewId]);
            $floorPlanRevision = (int)$revisionStmt->fetchColumn();

            $this->appMetaRepo->set('last_saved_at', $savedAt);

            $viewRevision = $this->appMetaRepo->getResourceRevision('views', $viewId);
            $this->db->commit();
        } catch (Throwable $e) {
            if ($this->db->inTransaction()) {
                $this->db->rollBack();
            }

            if ($e instanceof PDOException && Database::isBusy($e)) {
                throw new ApiException(
                    '現在、別の更新処理が実行されています。少し待ってから再度保存してください',
                    409
                );
            }

            if ($e instanceof ApiException && $e->getHttpStatus() === 409) {
                throw new ApiException($e->getMessage(), 409, [
                    'conflicts' => [['kind' => 'views', 'id' => $viewId, 'name' => $view['name']]],
                ]);
            }

            throw $e;
        }

        return [
            'ok' => true,
            'message' => 'フロア図面の表示設定を保存しました',
            'revision' => $newRevision,
            'view_revision' => $viewRevision,
            'saved_at' => $savedAt,
            'floor_plan_settings' => [
                'view_id' => $viewId,
                'x' => $x,
                'y' => $y,
                'scale' => $scale,
                'opacity' => $opacity,
                'is_visible' => $isVisible,
                'revision' => $floorPlanRevision,
                'updated_at' => $savedAt,
            ],
        ];
    }
}
