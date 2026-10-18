<?php
declare(strict_types=1);

namespace Netarium\Services\FloorPlan;

use finfo;
use GdImage;
use Throwable;
use Netarium\Core\ApiException;
use Netarium\Services\Storage\CapacityService;

final class FloorPlanImageConverter
{
    /** Only the re-encoded image is written; the original remains in PHP's upload temporary file. */
    public function convert(string $input, string $directory, array $config): array
    {
        clearstatcache(true, $input);
        $bytes = @filesize($input);
        $maxBytes = max(1, (int)($config['floor_plan_upload_max_bytes'] ?? 30 * 1024 * 1024));
        if ($bytes === false || $bytes <= 0 || $bytes > $maxBytes) {
            throw new ApiException('入力図面は' . CapacityService::formatBytes($maxBytes) . '以下にしてください', 400);
        }
        $mime = (string)(new finfo(FILEINFO_MIME_TYPE))->file($input);
        if (!in_array($mime, ['image/png', 'image/jpeg'], true)) {
            throw new ApiException('PNGまたはJPEG画像を選択してください', 400);
        }
        $info = @getimagesize($input);
        if (!is_array($info) || ($info['mime'] ?? '') !== $mime) {
            throw new ApiException('画像ファイルを解析できません', 400);
        }
        $width = (int)$info[0];
        $height = (int)$info[1];
        $maxDimension = max(1, (int)($config['floor_plan_upload_max_dimension'] ?? 7000));
        $maxPixels = max(1, (int)($config['floor_plan_upload_max_pixels'] ?? 35000000));
        if ($width <= 0 || $height <= 0 || max($width, $height) > $maxDimension) {
            throw new ApiException("入力図面の各辺は{$maxDimension}px以下にしてください", 400);
        }
        if ($width * $height > $maxPixels) {
            throw new ApiException("入力図面は{$maxPixels}画素以下にしてください", 400);
        }
        if (!extension_loaded('gd')) {
            throw new ApiException('図面変換に必要なGD拡張機能がありません', 500);
        }
        if (!is_dir($directory) || !is_writable($directory)) {
            throw new ApiException('図面保存先に書き込みできません', 500);
        }
        $orientation = 1;
        if ($mime === 'image/jpeg') {
            if (!function_exists('exif_read_data')) {
                throw new ApiException('図面の方向補正に必要なEXIF拡張機能がありません', 500);
            }
            $exif = @exif_read_data($input);
            $orientation = (int)($exif['Orientation'] ?? 1);
        }
        $swapsAxes = in_array($orientation, [5, 6, 7, 8], true);
        $orientedWidth = $swapsAxes ? $height : $width;
        $orientedHeight = $swapsAxes ? $width : $height;
        $outputLimit = max(1, (int)($config['floor_plan_max_dimension'] ?? 4096));
        $ratio = min(1.0, $outputLimit / max($width, $height));
        $outputWidth = max(1, (int)round($orientedWidth * $ratio));
        $outputHeight = max(1, (int)round($orientedHeight * $ratio));
        // GD source and simultaneous rotation surfaces, resampling surface, encoder buffers,
        // compressed input and allocator/headroom. This admits A3 400dpi under 512M.
        $rotates = in_array($orientation, [3, 5, 6, 7, 8], true);
        $requiredMemory = $width * $height * 4 * ($rotates ? 2 : 1)
            + $outputWidth * $outputHeight * 8 + $bytes + 32 * 1024 * 1024;
        $memoryLimit = trim((string)ini_get('memory_limit'));
        if ($memoryLimit !== '' && $memoryLimit !== '-1') {
            $unit = strtolower(substr($memoryLimit, -1));
            $multiplier = match ($unit) { 'g' => 1024 ** 3, 'm' => 1024 ** 2, 'k' => 1024, default => 1 };
            $available = (int)((float)$memoryLimit * $multiplier) - memory_get_usage(true);
            if ($requiredMemory > $available) {
                throw new ApiException('図面変換に必要なメモリが不足しています。画像を縮小してから選択してください', 400);
            }
        }
        // Reserve the worst-case encoded working file, not the compressed source size.
        CapacityService::requireFreeSpace($directory, $outputWidth * $outputHeight * 5 + 1024 * 1024, '図面変換先');
        $storedName = bin2hex(random_bytes(16)) . ($mime === 'image/png' ? '.png' : '.jpg');
        $path = $directory . DIRECTORY_SEPARATOR . $storedName;
        $image = null;
        $output = null;
        try {
            $image = $mime === 'image/png' ? @imagecreatefrompng($input) : @imagecreatefromjpeg($input);
            if (!$image instanceof GdImage) {
                throw new ApiException('画像ファイルをデコードできません', 400);
            }
            if (imagesx($image) !== $width || imagesy($image) !== $height) {
                throw new ApiException('画像ファイルの寸法が一致しません', 400);
            }
            $flip = match ($orientation) { 2, 7 => IMG_FLIP_HORIZONTAL, 4, 5 => IMG_FLIP_VERTICAL, default => null };
            if ($flip !== null && !imageflip($image, $flip)) {
                throw new ApiException('図面の方向を補正できません', 400);
            }
            $angle = match ($orientation) { 3 => 180, 5, 6, 7 => -90, 8 => 90, default => 0 };
            if ($angle !== 0) {
                $rotated = @imagerotate($image, $angle, 0);
                if (!$rotated instanceof GdImage) {
                    throw new ApiException('図面の方向を補正できません', 400);
                }
                $image = $rotated;
                unset($rotated);
            }
            if ($ratio < 1.0) {
                $output = imagecreatetruecolor($outputWidth, $outputHeight);
                if (!$output instanceof GdImage) {
                    throw new ApiException('図面を縮小できません', 500);
                }
                imagealphablending($output, false);
                imagesavealpha($output, true);
                if (!imagecopyresampled($output, $image, 0, 0, 0, 0, $outputWidth, $outputHeight, imagesx($image), imagesy($image))) {
                    throw new ApiException('図面を縮小できません', 500);
                }
                $image = null;
            } else {
                $output = $image;
            }
            imagesavealpha($output, true);
            $written = $mime === 'image/png' ? @imagepng($output, $path, 8) : @imagejpeg($output, $path, 95);
            if (!$written) {
                throw new ApiException('変換した図面ファイルを保存できませんでした', 500);
            }
            clearstatcache(true, $path);
            $size = @filesize($path);
            CapacityService::assertImageEntrySize($size === false ? 0 : $size, $config, '変換後の図面');
            $savedInfo = @getimagesize($path);
            if (!is_array($savedInfo) || $savedInfo[0] !== $outputWidth || $savedInfo[1] !== $outputHeight
                || ($savedInfo['mime'] ?? '') !== $mime || (new finfo(FILEINFO_MIME_TYPE))->file($path) !== $mime) {
                throw new ApiException('変換後の図面ファイルを確認できません', 500);
            }
            $sha = hash_file('sha256', $path);
            if ($sha === false) {
                throw new ApiException('図面のSHA-256を計算できません', 500);
            }
            return ['stored_name' => $storedName, 'mime_type' => $mime, 'file_size' => $size,
                'image_width' => $outputWidth, 'image_height' => $outputHeight, 'sha256' => $sha];
        } catch (Throwable $e) {
            @unlink($path);
            throw $e;
        } finally {
            $output = null;
            $image = null;
        }
    }
}
