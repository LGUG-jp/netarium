<?php
declare(strict_types=1);

namespace Netarium\Services\DeviceImage;

use finfo;
use GdImage;
use PDO;
use Throwable;
use Netarium\Core\ApiException;
use Netarium\Core\Request;
use Netarium\Repositories\AppMetaRepository;
use Netarium\Repositories\DeviceImageRepository;
use Netarium\Repositories\FloorPlanRepository;
use Netarium\Services\Storage\CapacityService;

class DeviceImageService
{
    private PDO $db;
    private AppMetaRepository $appMetaRepo;
    private DeviceImageRepository $deviceImageRepo;
    private FloorPlanRepository $floorPlanRepo;

    public function __construct(PDO $db)
    {
        $this->db = $db;
        $this->appMetaRepo = new AppMetaRepository($db);
        $this->deviceImageRepo = new DeviceImageRepository($db);
        $this->floorPlanRepo = new FloorPlanRepository($db);
    }

    /**
     * 機器画像のアップロード登録
     */
    public function uploadDeviceImage(
        int $deviceId,
        int $requestedRevision,
        array $uploadedFile,
        string $caption,
        ?int $replaceImageId,
        array $config
    ): array {
        if ($deviceId <= 0) {
            throw new ApiException('機器IDが不正です', 400);
        }

        // GDおよびEXIF拡張の確認（必須要件）
        if (!extension_loaded('gd') || !extension_loaded('exif')) {
            throw new ApiException('画像処理モジュール(GD/EXIF)が有効ではありません', 500);
        }

        $this->appMetaRepo->requireMatchingDataRevision($requestedRevision);

        // 機器の存在確認
        $deviceStmt = $this->db->prepare('SELECT id FROM devices WHERE id = :id');
        $deviceStmt->execute([':id' => $deviceId]);
        if ($deviceStmt->fetchColumn() === false) {
            throw new ApiException('対象の機器が見つかりません', 404);
        }

        $uploadError = (int)($uploadedFile['error'] ?? UPLOAD_ERR_NO_FILE);
        if ($uploadError !== UPLOAD_ERR_OK) {
            $message = match ($uploadError) {
                UPLOAD_ERR_INI_SIZE,
                UPLOAD_ERR_FORM_SIZE => '画像ファイルの容量が上限を超えています',
                UPLOAD_ERR_PARTIAL => '画像ファイルのアップロードが完了しませんでした',
                UPLOAD_ERR_NO_FILE => 'アップロードする画像を選択してください',
                default => '画像ファイルをアップロードできませんでした',
            };
            throw new ApiException($message, 400);
        }

        $temporaryPath = (string)($uploadedFile['tmp_name'] ?? '');
        if ($temporaryPath === '' || !is_uploaded_file($temporaryPath)) {
            throw new ApiException('アップロードファイルを確認できません', 400);
        }

        $rawFileSize = (int)($uploadedFile['size'] ?? 0);
        $imageLimits = CapacityService::limits($config)['images'];
        if ($rawFileSize <= 0 || $rawFileSize > $imageLimits['max_entry_bytes']) {
            throw new ApiException(
                '画像ファイルは' . CapacityService::formatBytes($imageLimits['max_entry_bytes']) . '以下にしてください',
                400
            );
        }

        // MIME判定
        $fileInfo = new finfo(FILEINFO_MIME_TYPE);
        $mimeType = (string)$fileInfo->file($temporaryPath);
        if (!in_array($mimeType, ['image/png', 'image/jpeg'], true)) {
            throw new ApiException('PNGまたはJPEG画像を選択してください', 400);
        }

        // 寸法・画素数・MIMEの一致検証
        $imageInfo = @getimagesize($temporaryPath);
        if (!is_array($imageInfo) || !isset($imageInfo[0], $imageInfo[1], $imageInfo['mime'])) {
            throw new ApiException('画像ファイルを解析できません', 400);
        }

        $rawWidth = (int)$imageInfo[0];
        $rawHeight = (int)$imageInfo[1];
        if ((string)$imageInfo['mime'] !== $mimeType) {
            throw new ApiException('画像ファイルの形式が一致しません', 400);
        }

        $maxWidth = (int)($config['max_device_image_width'] ?? 4000);
        $maxHeight = (int)($config['max_device_image_height'] ?? 4000);
        $maxPixels = (int)($config['max_device_image_pixels'] ?? 12000000);

        if ($rawWidth <= 0 || $rawHeight <= 0 || $rawWidth > $maxWidth || $rawHeight > $maxHeight || ($rawWidth * $rawHeight) > $maxPixels) {
            throw new ApiException(
                "画像寸法が上限を超えています。最大{$maxWidth}×{$maxHeight}px、総画素数{$maxPixels}以下にしてください",
                400
            );
        }

        // 既存画像の確認
        $existingImages = $this->deviceImageRepo->getByDeviceId($deviceId);
        $replaceImage = null;

        if ($replaceImageId !== null && $replaceImageId > 0) {
            foreach ($existingImages as $img) {
                if ((int)$img['id'] === $replaceImageId) {
                    $replaceImage = $img;
                    break;
                }
            }
            if ($replaceImage === null) {
                throw new ApiException('差替え対象の画像が見つかりません', 404);
            }
        } else {
            $maxPerDevice = (int)($config['max_device_images_per_device'] ?? 3);
            if (count($existingImages) >= $maxPerDevice) {
                throw new ApiException("1機器に登録できる画像は最大{$maxPerDevice}枚です", 400);
            }
        }

        // GDでデコードと方向補正
        $gdImage = $this->decodeAndOrientImage($temporaryPath, $mimeType);
        if (!$gdImage instanceof GdImage) {
            throw new ApiException('画像ファイルをデコードできません', 400);
        }

        // 一時ファイルに再符号化（EXIFや不要メタデータを除去）
        $tempProcessedDir = (string)$config['device_image_directory'];
        if (!is_dir($tempProcessedDir)) {
            @mkdir($tempProcessedDir, 0755, true);
        }

        $processedTempPath = tempnam($tempProcessedDir, 'proc_img_');
        if ($processedTempPath === false) {
            imagedestroy($gdImage);
            throw new ApiException('一時ファイルの作成に失敗しました', 500);
        }

        $reencodeSuccess = false;
        $resizedImage = null;
        try {
            // 向き補正後の寸法で縮小し、小さな画像は拡大しない。
            $width = imagesx($gdImage);
            $height = imagesy($gdImage);
            $maxDimension = max(1, (int)($config['device_image_max_dimension'] ?? 2048));
            $longEdge = max($width, $height);
            if ($longEdge > $maxDimension) {
                $targetWidth = max(1, (int)round($width * $maxDimension / $longEdge));
                $targetHeight = max(1, (int)round($height * $maxDimension / $longEdge));
                $resizedImage = imagecreatetruecolor($targetWidth, $targetHeight);
                if (!$resizedImage instanceof GdImage) {
                    throw new ApiException('画像の縮小に失敗しました', 500);
                }
                if ($mimeType === 'image/png') {
                    imagealphablending($resizedImage, false);
                    imagesavealpha($resizedImage, true);
                }
                if (!imagecopyresampled($resizedImage, $gdImage, 0, 0, 0, 0, $targetWidth, $targetHeight, $width, $height)) {
                    throw new ApiException('画像の縮小に失敗しました', 500);
                }
                imagedestroy($gdImage);
                $gdImage = $resizedImage;
                $resizedImage = null;
            }

            if ($mimeType === 'image/jpeg') {
                $reencodeSuccess = imagejpeg($gdImage, $processedTempPath, 90);
            } else {
                imagealphablending($gdImage, false);
                imagesavealpha($gdImage, true);
                $reencodeSuccess = imagepng($gdImage, $processedTempPath, 8);
            }
        } catch (Throwable $e) {
            @unlink($processedTempPath);
            throw $e;
        } finally {
            if ($resizedImage instanceof GdImage) {
                imagedestroy($resizedImage);
            }
            imagedestroy($gdImage);
        }

        if (!$reencodeSuccess || !is_file($processedTempPath)) {
            @unlink($processedTempPath);
            throw new ApiException('画像の再符号化に失敗しました', 500);
        }

        $processedSize = (int)filesize($processedTempPath);
        if ($processedSize <= 0 || $processedSize > $imageLimits['max_entry_bytes']) {
            @unlink($processedTempPath);
            throw new ApiException(
                '保存画像の容量が上限を超えています（最大' . CapacityService::formatBytes($imageLimits['max_entry_bytes']) . '）',
                400
            );
        }

        $processedInfo = @getimagesize($processedTempPath);
        if (!is_array($processedInfo)) {
            @unlink($processedTempPath);
            throw new ApiException('処理後画像を解析できません', 500);
        }
        $finalWidth = (int)$processedInfo[0];
        $finalHeight = (int)$processedInfo[1];

        // 全体容量・件数判定
        $floorPlans = $this->floorPlanRepo->getAll();
        $floorPlanFiles = count($floorPlans);
        $floorPlanBytes = 0;
        foreach ($floorPlans as $fp) {
            $floorPlanBytes += max(0, (int)($fp['file_size'] ?? 0));
        }

        $deviceImageUsage = $this->deviceImageRepo->getTotalUsage();
        $oldSizeToSubtract = $replaceImage !== null ? max(0, (int)$replaceImage['file_size']) : 0;
        $fileCountDelta = $replaceImage !== null ? 0 : 1;

        $nextTotalFiles = $floorPlanFiles + $deviceImageUsage['count'] + $fileCountDelta;
        $nextTotalBytes = $floorPlanBytes + max(0, $deviceImageUsage['bytes'] - $oldSizeToSubtract) + $processedSize;

        try {
            CapacityService::assertImageUsage($nextTotalFiles, $nextTotalBytes, $config, '画像');
            CapacityService::requireFreeSpace($tempProcessedDir, $processedSize, '画像保存先');
        } catch (Throwable $e) {
            @unlink($processedTempPath);
            throw $e;
        }

        // 保存ファイル名決定
        $extension = $mimeType === 'image/jpeg' ? 'jpg' : 'png';
        $storedName = bin2hex(random_bytes(16)) . '.' . $extension;
        $finalPath = $tempProcessedDir . DIRECTORY_SEPARATOR . $storedName;

        if (!@rename($processedTempPath, $finalPath)) {
            @unlink($processedTempPath);
            throw new ApiException('画像ファイルの配備に失敗しました', 500);
        }
        @chmod($finalPath, 0644);

        $captionText = Request::normalizeLedgerText($caption, (int)($config['max_device_image_caption_length'] ?? 100));
        $now = date(DATE_ATOM);
        $oldStoredName = $replaceImage !== null ? (string)$replaceImage['stored_name'] : null;

        $this->db->beginTransaction();
        try {
            $newRevision = $this->appMetaRepo->claimDataRevision($requestedRevision);

            $sha = hash_file('sha256', $finalPath);
            if ($sha === false) {
                throw new ApiException('画像のSHA-256を計算できません', 500);
            }
            if ($replaceImage !== null) {
                // 差替え
                $this->deviceImageRepo->enqueueGc($oldStoredName, $now);

                $updateStmt = $this->db->prepare("
                    UPDATE device_images
                    SET
                        stored_name = :stored_name,
                        mime_type = :mime_type,
                        file_size = :file_size,
                        image_width = :image_width,
                        image_height = :image_height,
                        caption = :caption,
                        updated_at = :updated_at
                    WHERE id = :id
                ");
                $updateStmt->execute([
                    ':id' => $replaceImage['id'],
                    ':stored_name' => $storedName,
                    ':mime_type' => $mimeType,
                    ':file_size' => $processedSize,
                    ':image_width' => $finalWidth,
                    ':image_height' => $finalHeight,
                    ':caption' => $captionText,
                    ':updated_at' => $now,
                ]);
            } else {
                // 新規追加: sort_orderは末尾
                $sortOrder = count($existingImages) + 1;
                $this->deviceImageRepo->insert(
                    $deviceId,
                    $storedName,
                    $mimeType,
                    $processedSize,
                    $finalWidth,
                    $finalHeight,
                    $captionText,
                    $sortOrder,
                    $now,
                    $now
                );
            }
            $digestStmt = $this->db->prepare('UPDATE device_images SET sha256 = :sha WHERE stored_name = :name');
            $digestStmt->execute([':sha' => $sha, ':name' => $storedName]);

            $this->db->commit();
        } catch (Throwable $e) {
            if ($this->db->inTransaction()) {
                $this->db->rollBack();
            }
            @unlink($finalPath);
            throw $e;
        }

        // コミット成功後、差替え対象の旧実体を削除
        if ($oldStoredName !== null) {
            $this->removeImageFileAndGc($config, $oldStoredName);
        }

        // 未処理GCキューを念のため消化
        $this->processGcQueue($config);

        return [
            'ok' => true,
            'revision' => $newRevision,
            'images' => $this->formatImagesResponse($deviceId),
        ];
    }

    /**
     * 機器画像の削除
     */
    public function deleteDeviceImage(
        int $deviceId,
        int $imageId,
        int $requestedRevision,
        array $config
    ): array {
        if ($deviceId <= 0 || $imageId <= 0) {
            throw new ApiException('パラメータが不正です', 400);
        }

        $this->appMetaRepo->requireMatchingDataRevision($requestedRevision);

        $image = $this->deviceImageRepo->getById($imageId);
        if (!$image || (int)$image['device_id'] !== $deviceId) {
            throw new ApiException('削除対象の画像が見つかりません', 404);
        }

        $now = date(DATE_ATOM);
        $storedName = (string)$image['stored_name'];
        $storageDir = (string)$config['device_image_directory'];

        $this->db->beginTransaction();
        try {
            $newRevision = $this->appMetaRepo->claimDataRevision($requestedRevision);
            $this->deviceImageRepo->enqueueGc($storedName, $now);
            $this->deviceImageRepo->delete($imageId);

            // 残った画像のsort_orderを1から再採番
            $remaining = $this->deviceImageRepo->getByDeviceId($deviceId);
            $order = 1;
            foreach ($remaining as $rem) {
                $this->deviceImageRepo->updateOrderAndCaption(
                    (int)$rem['id'],
                    $order++,
                    (string)$rem['caption'],
                    $now
                );
            }

            $this->db->commit();
        } catch (Throwable $e) {
            if ($this->db->inTransaction()) {
                $this->db->rollBack();
            }
            throw $e;
        }

        $this->removeImageFileAndGc($config, $storedName);
        $this->processGcQueue($config);

        return [
            'ok' => true,
            'revision' => $newRevision,
            'images' => $this->formatImagesResponse($deviceId),
        ];
    }

    /**
     * 機器画像の順序入替・説明文更新
     */
    public function updateDeviceImages(
        int $deviceId,
        int $requestedRevision,
        array $imagesInput,
        array $config
    ): array {
        if ($deviceId <= 0) {
            throw new ApiException('機器IDが不正です', 400);
        }

        $this->appMetaRepo->requireMatchingDataRevision($requestedRevision);

        $existing = $this->deviceImageRepo->getByDeviceId($deviceId);
        $existingById = [];
        foreach ($existing as $img) {
            $existingById[(int)$img['id']] = $img;
        }

        if (count($imagesInput) !== count($existing)) {
            throw new ApiException('画像の一覧が一致しません', 400);
        }

        $inputIds = [];
        foreach ($imagesInput as $item) {
            if (!is_array($item)) {
                throw new ApiException('画像データ形式が不正です', 400);
            }
            $id = (int)($item['id'] ?? 0);
            if ($id <= 0 || !isset($existingById[$id])) {
                throw new ApiException('指定された画像が存在しません', 400);
            }
            if (isset($inputIds[$id])) {
                throw new ApiException('画像IDが重複しています', 400);
            }
            $inputIds[$id] = true;
        }

        $now = date(DATE_ATOM);
        $maxCaptionLen = (int)($config['max_device_image_caption_length'] ?? 100);

        $this->db->beginTransaction();
        try {
            $newRevision = $this->appMetaRepo->claimDataRevision($requestedRevision);

            $order = 1;
            foreach ($imagesInput as $item) {
                $id = (int)$item['id'];
                $caption = Request::normalizeLedgerText($item['caption'] ?? '', $maxCaptionLen);
                $this->deviceImageRepo->updateOrderAndCaption($id, $order++, $caption, $now);
            }

            $this->db->commit();
        } catch (Throwable $e) {
            if ($this->db->inTransaction()) {
                $this->db->rollBack();
            }
            throw $e;
        }

        return [
            'ok' => true,
            'revision' => $newRevision,
            'images' => $this->formatImagesResponse($deviceId),
        ];
    }

    /**
     * GCキューの消化処理
     */
    public function processGcQueue(array $config): int
    {
        // 機器・画像削除が確定した後にGCを処理する。Web構成復元からは呼ばない。
        $items = $this->deviceImageRepo->getQueuedGc(PHP_INT_MAX);
        $processed = 0;

        foreach ($items as $item) {
            $storedName = (string)$item['stored_name'];
            if ($this->removeImageFileAndGc($config, $storedName)) {
                $processed++;
            }
        }

        return $processed;
    }

    /**
     * 原本とサムネイルの両方を削除できた場合だけGCキューから除く
     */
    private function removeImageFileAndGc(array $config, string $storedName): bool
    {
        if (preg_match('/\A[a-f0-9]{32}\.(?:png|jpg)\z/', $storedName) !== 1) {
            return false;
        }
        // 構成復元で再関連付けされた画像を、以前の削除待ちで消さない。
        $reference = $this->db->prepare('SELECT 1 FROM device_images WHERE stored_name = :name LIMIT 1');
        $reference->execute([':name' => $storedName]);
        $isReferenced = $reference->fetchColumn() !== false;
        $reference->closeCursor();
        if ($isReferenced) {
            $this->deviceImageRepo->dequeueGc($storedName);
            return true;
        }

        $original = (string)$config['device_image_directory'] . DIRECTORY_SEPARATOR . $storedName;
        $thumbnail = (string)$config['device_image_thumb_directory']
            . DIRECTORY_SEPARATOR . 'thumb_320_' . $storedName;
        $success = true;

        foreach ([$original, $thumbnail] as $path) {
            if ((file_exists($path) || is_link($path)) && !@unlink($path)) {
                $success = false;
            }
        }

        if ($success) {
            $this->deviceImageRepo->dequeueGc($storedName);
        }

        return $success;
    }

    /**
     * GDによる画像デコードとEXIF向き補正
     */
    private function decodeAndOrientImage(string $path, string $mimeType): ?GdImage
    {
        if ($mimeType === 'image/png') {
            $im = @imagecreatefrompng($path);
            return $im === false ? null : $im;
        }

        if ($mimeType !== 'image/jpeg') {
            return null;
        }

        $im = @imagecreatefromjpeg($path);
        if ($im === false) {
            return null;
        }

        // EXIF Orientationの取得
        $exif = @exif_read_data($path);
        $orientation = (int)($exif['Orientation'] ?? 1);

        switch ($orientation) {
            case 2:
                imageflip($im, IMG_FLIP_HORIZONTAL);
                break;
            case 3:
                $rotated = imagerotate($im, 180, 0);
                if ($rotated !== false) {
                    imagedestroy($im);
                    $im = $rotated;
                }
                break;
            case 4:
                imageflip($im, IMG_FLIP_VERTICAL);
                break;
            case 5:
                imageflip($im, IMG_FLIP_VERTICAL);
                $rotated = imagerotate($im, -90, 0);
                if ($rotated !== false) {
                    imagedestroy($im);
                    $im = $rotated;
                }
                break;
            case 6:
                $rotated = imagerotate($im, -90, 0);
                if ($rotated !== false) {
                    imagedestroy($im);
                    $im = $rotated;
                }
                break;
            case 7:
                imageflip($im, IMG_FLIP_HORIZONTAL);
                $rotated = imagerotate($im, -90, 0);
                if ($rotated !== false) {
                    imagedestroy($im);
                    $im = $rotated;
                }
                break;
            case 8:
                $rotated = imagerotate($im, 90, 0);
                if ($rotated !== false) {
                    imagedestroy($im);
                    $im = $rotated;
                }
                break;
            default:
                // 1 または未設定はそのまま
                break;
        }

        return $im;
    }

    /**
     * 応答用画像配列の整形
     */
    private function formatImagesResponse(int $deviceId): array
    {
        $rows = $this->deviceImageRepo->getByDeviceId($deviceId);
        return array_map(static function (array $r): array {
            return [
                'id' => (int)$r['id'],
                'device_id' => (int)$r['device_id'],
                'mime_type' => (string)$r['mime_type'],
                'file_size' => (int)$r['file_size'],
                'image_width' => (int)$r['image_width'],
                'image_height' => (int)$r['image_height'],
                'caption' => (string)$r['caption'],
                'sort_order' => (int)$r['sort_order'],
                'created_at' => (string)$r['created_at'],
                'updated_at' => (string)$r['updated_at'],
                'image_url' => 'device_image.php?image_id=' . (int)$r['id'] . '&v=' . rawurlencode((string)$r['updated_at']) . '&cache_policy=200-1',
            ];
        }, $rows);
    }
}
