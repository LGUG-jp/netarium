<?php
declare(strict_types=1);

namespace Netarium\Services\Storage;

use Netarium\Core\ApiException;

final class CapacityService
{
    public const BYTES_PER_MIB = 1048576;

    public static function limits(array $config): array
    {
        $configured = $config['storage_capacity'] ?? [];
        $images = is_array($configured['images'] ?? null)
            ? $configured['images']
            : [];
        $floorPlans = is_array($configured['floor_plans'] ?? null)
            ? $configured['floor_plans']
            : [];
        $backup = is_array($configured['backup'] ?? null)
            ? $configured['backup']
            : [];

        return [
            'warning_ratio' => self::normalizeRatio(
                $configured['warning_ratio'] ?? 0.8
            ),
            'workspace_reserve_bytes' => self::positiveInt(
                $configured['workspace_reserve_bytes'] ?? 16 * self::BYTES_PER_MIB,
                16 * self::BYTES_PER_MIB
            ),
            'images' => [
                'max_files' => self::optionalQuota($images['max_files'] ?? null),
                'max_total_bytes' => self::optionalQuota($images['max_total_bytes'] ?? null),
                'max_entry_bytes' => self::positiveInt(
                    $images['max_entry_bytes'] ?? 10 * self::BYTES_PER_MIB,
                    10 * self::BYTES_PER_MIB
                ),
            ],
            'floor_plans' => [
                'max_files' => self::positiveInt(
                    $floorPlans['max_files'] ?? $config['max_views'] ?? 100,
                    100
                ),
            ],
            'backup' => [
                'max_zip_bytes' => self::positiveInt(
                    $backup['max_zip_bytes'] ?? 24 * self::BYTES_PER_MIB,
                    24 * self::BYTES_PER_MIB
                ),
                'max_uncompressed_bytes' => self::positiveInt(
                    $backup['max_uncompressed_bytes'] ?? 64 * self::BYTES_PER_MIB,
                    64 * self::BYTES_PER_MIB
                ),
                'max_entry_bytes' => self::positiveInt(
                    $backup['max_entry_bytes'] ?? 64 * self::BYTES_PER_MIB,
                    64 * self::BYTES_PER_MIB
                ),
                'max_files' => self::positiveInt(
                    $backup['max_files'] ?? 2,
                    2
                ),
            ],
        ];
    }

    public static function imageUsage(int $files, int $bytes, array $config): array
    {
        $limits = self::limits($config);
        $files = max(0, $files);
        $bytes = max(0, $bytes);

        return [
            'files' => $files,
            'bytes' => $bytes,
            'limits' => [
                'files' => $limits['images']['max_files'],
                'bytes' => $limits['images']['max_total_bytes'],
                'entry_bytes' => $limits['images']['max_entry_bytes'],
            ],
            'near_limit' => self::isNearLimit(
                $files,
                $limits['images']['max_files'],
                $limits['warning_ratio']
            ) || self::isNearLimit(
                $bytes,
                $limits['images']['max_total_bytes'],
                $limits['warning_ratio']
            ),
            'warnings' => self::imageWarnings($files, $bytes, $limits),
        ];
    }

    public static function backupUsage(
        int $files,
        int $uncompressedBytes,
        int $zipBytes,
        int $imageFiles,
        int $imageBytes,
        array $config
    ): array {
        $limits = self::limits($config);
        $files = max(0, $files);
        $uncompressedBytes = max(0, $uncompressedBytes);
        $zipBytes = max(0, $zipBytes);

        return [
            'files' => $files,
            'uncompressed_bytes' => $uncompressedBytes,
            'zip_bytes' => $zipBytes,
            'images' => [
                'files' => max(0, $imageFiles),
                'bytes' => max(0, $imageBytes),
            ],
            'limits' => [
                'files' => $limits['backup']['max_files'],
                'uncompressed_bytes' => $limits['backup']['max_uncompressed_bytes'],
                'zip_bytes' => $limits['backup']['max_zip_bytes'],
            ],
            'near_limit' => self::isNearLimit(
                $uncompressedBytes,
                $limits['backup']['max_uncompressed_bytes'],
                $limits['warning_ratio']
            ) || self::isNearLimit(
                $zipBytes,
                $limits['backup']['max_zip_bytes'],
                $limits['warning_ratio']
            ),
            'warnings' => self::backupWarnings(
                $files,
                $uncompressedBytes,
                $zipBytes,
                $limits
            ),
        ];
    }

    public static function assertImageEntrySize(int $bytes, array $config, string $label): void
    {
        $limit = self::limits($config)['images']['max_entry_bytes'];

        if ($bytes <= 0 || $bytes > $limit) {
            throw new ApiException(
                "{$label}は" . self::formatBytes($limit) . '以下にしてください',
                400
            );
        }
    }

    public static function assertImageUsage(
        int $files,
        int $bytes,
        array $config,
        string $label = '画像'
    ): void {
        $limits = self::limits($config);
        if ($files < 0 || $bytes < 0) {
            throw new ApiException("{$label}の使用量が不正です", 400);
        }

        if ($limits['images']['max_files'] !== null && $files > $limits['images']['max_files']) {
            throw new ApiException(
                "{$label}のファイル数が上限を超えています（最大{$limits['images']['max_files']}件）",
                400
            );
        }

        if ($limits['images']['max_total_bytes'] !== null && $bytes > $limits['images']['max_total_bytes']) {
            throw new ApiException(
                "{$label}の総容量が上限を超えています（最大" .
                self::formatBytes($limits['images']['max_total_bytes']) . '）',
                400
            );
        }
    }

    public static function assertBackupUsage(
        int $files,
        int $uncompressedBytes,
        int $zipBytes,
        array $config
    ): void {
        $limits = self::limits($config)['backup'];

        if ($files < 1 || $files > $limits['max_files']) {
            throw new ApiException('バックアップ内のファイル数が上限外です', 400);
        }

        if ($uncompressedBytes < 0 || $uncompressedBytes > $limits['max_uncompressed_bytes']) {
            throw new ApiException('バックアップ展開後の総容量が上限を超えています', 400);
        }

        if ($zipBytes < 0 || $zipBytes > $limits['max_zip_bytes']) {
            throw new ApiException('バックアップZIPの容量が上限を超えています', 400);
        }
    }

    public static function requireFreeSpace(
        string $directory,
        int $requiredBytes,
        string $label
    ): void {
        $requiredBytes = max(0, $requiredBytes);
        $probe = $directory;

        while ($probe !== '' && !is_dir($probe)) {
            $parent = dirname($probe);
            if ($parent === $probe) {
                break;
            }
            $probe = $parent;
        }

        $free = $probe !== '' ? @disk_free_space($probe) : false;

        if ($free === false || $free === null) {
            throw new ApiException("{$label}の空き容量を確認できません", 507);
        }

        if ((float)$free < $requiredBytes) {
            throw new ApiException(
                "{$label}の空き容量が不足しています。必要量: " .
                self::formatBytes($requiredBytes) .
                '、空き容量: ' . self::formatBytes((int)$free),
                507
            );
        }
    }

    public static function formatBytes(int $bytes): string
    {
        $bytes = max(0, $bytes);

        if ($bytes >= self::BYTES_PER_MIB && $bytes % self::BYTES_PER_MIB === 0) {
            return (string)intdiv($bytes, self::BYTES_PER_MIB) . 'MiB';
        }

        return number_format($bytes) . 'B';
    }

    private static function imageWarnings(int $files, int $bytes, array $limits): array
    {
        $warnings = [];

        if (self::isNearLimit($files, $limits['images']['max_files'], $limits['warning_ratio'])) {
            $warnings[] = '画像ファイル数が上限に近づいています';
        }

        if (self::isNearLimit($bytes, $limits['images']['max_total_bytes'], $limits['warning_ratio'])) {
            $warnings[] = '画像総容量が上限に近づいています';
        }

        return $warnings;
    }

    private static function backupWarnings(
        int $files,
        int $uncompressedBytes,
        int $zipBytes,
        array $limits
    ): array {
        $warnings = [];


        if (self::isNearLimit($uncompressedBytes, $limits['backup']['max_uncompressed_bytes'], $limits['warning_ratio'])) {
            $warnings[] = 'バックアップ展開後の容量が復元上限に近づいています';
        }

        if (self::isNearLimit($zipBytes, $limits['backup']['max_zip_bytes'], $limits['warning_ratio'])) {
            $warnings[] = 'バックアップZIP容量が復元上限に近づいています';
        }

        return $warnings;
    }

    private static function isNearLimit(int $usage, ?int $limit, float $ratio): bool
    {
        return $limit !== null && $limit > 0 && $usage >= (int)ceil($limit * $ratio);
    }

    private static function optionalQuota($value): ?int
    {
        $value = filter_var($value, FILTER_VALIDATE_INT);
        return is_int($value) && $value > 0 ? $value : null;
    }

    private static function positiveInt($value, int $fallback): int
    {
        $value = filter_var($value, FILTER_VALIDATE_INT);
        return is_int($value) && $value > 0 ? $value : $fallback;
    }

    private static function normalizeRatio($value): float
    {
        $ratio = is_numeric($value) ? (float)$value : 0.8;
        return min(0.99, max(0.5, $ratio));
    }
}
