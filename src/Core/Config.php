<?php
declare(strict_types=1);

namespace Netarium\Core;

use RuntimeException;

final class Config
{
    public static function create(?string $installRoot = null): array
    {
        $installRoot = $installRoot ?? dirname(__DIR__, 2);
        $localConfig = self::loadLocalConfig($installRoot);

        $environmentStorageDir = getenv('NETARIUM_STORAGE_DIR');
        if (
            is_string($environmentStorageDir)
            && trim($environmentStorageDir) !== ''
        ) {
            if (
                trim($environmentStorageDir) !== $environmentStorageDir
                || !self::isAbsolutePath($environmentStorageDir)
            ) {
                throw new RuntimeException(
                    'NETARIUM_STORAGE_DIR must be an absolute path'
                );
            }
            $storageDir = rtrim($environmentStorageDir, '/\\');
        } else {
            $storageDir = $localConfig['storage_dir']
                ?? self::joinPath($installRoot, 'data');
        }

        $environmentDbFile = getenv('NETARIUM_DB_FILE');
        if (
            is_string($environmentDbFile)
            && trim($environmentDbFile) !== ''
        ) {
            if (
                trim($environmentDbFile) !== $environmentDbFile
                || !self::isAbsolutePath($environmentDbFile)
            ) {
                throw new RuntimeException(
                    'NETARIUM_DB_FILE must be an absolute path'
                );
            }
            $dbFile = $environmentDbFile;
        } else {
            $dbFile = $localConfig['db_file']
                ?? self::joinPath($storageDir, 'db/data.sqlite');
        }
        $localCapacity = $localConfig['storage_capacity'] ?? [];
        $localImages = is_array($localCapacity['images'] ?? null) ? $localCapacity['images'] : [];

        return [
            'storage_dir' => $storageDir,
            'db_file' => $dbFile,
            // 旧bcryptの明示移行期間のみtrue。移行完了後はfalseにする。
            'allow_legacy_bcrypt' => $localConfig['allow_legacy_bcrypt'] ?? true,
            'trusted_https_proxies' => $localConfig['trusted_https_proxies'] ?? [],
            'hsts_max_age' => $localConfig['hsts_max_age'] ?? null,
            'csp_report_only' => $localConfig['csp_report_only'] ?? false,

            'ping_timeout_ms' => 1000,
            'ping_max_duration_ms' => 120000,
            'max_ping_targets' => 100,
            'restrict_private_ip_only' => true,
            'quality_stale_monitor_days' => 30,
            'quality_identifier_case_insensitive' => true,
            'quality_recommended_device_fields' => [
                'facility',
                'floor',
                'location',
                'manufacturer',
                'model',
            ],
            'quality_similar_name_enabled' => true,
            'enable_diagnostics' => false,
            'expose_error_detail' => false,

            'max_views' => 100,
            // 旧図面を再変換せず復元するための寸法契約。新規登録は別の長辺上限を使う。
            'max_floor_plan_width' => 10000,
            'max_floor_plan_height' => 10000,
            'max_floor_plan_pixels' => 50000000,
            'floor_plan_upload_max_bytes' => 30 * 1024 * 1024,
            'floor_plan_upload_max_dimension' => 7000,
            'floor_plan_upload_max_pixels' => 35000000,
            'floor_plan_max_dimension' => 4096,
            'image_upload_max_request_bytes' => 31 * 1024 * 1024,

            'max_placements_per_view' => 2000,
            'max_links_per_view' => 5000,

            'floor_plan_directory' =>
                self::joinPath($storageDir, 'uploads/floorplans'),
            'device_image_directory' =>
                self::joinPath($storageDir, 'uploads/device_images'),
            'device_image_thumb_directory' =>
                self::joinPath($storageDir, 'cache/thumbnails'),
            'max_device_images_per_device' => 3,
            'max_device_image_caption_length' => 100,
            'max_device_image_width' => 4000,
            'max_device_image_height' => 4000,
            'max_device_image_pixels' => 12000000,
            'device_image_max_dimension' => 2048,
            'device_image_thumb_max_dimension' => 320,
            'device_csv_import_directory' =>
                self::joinPath($storageDir, 'db/csv-import'),
            'max_device_csv_import_bytes' => 2 * 1024 * 1024,
            'max_device_csv_import_rows' => 5000,
            'device_csv_import_ttl_seconds' => 600,

            'backup_export_directory' =>
                self::joinPath($storageDir, 'temp/backup-export'),
            'backup_restore_directory' =>
                self::joinPath($storageDir, 'temp/backup-restore'),
            'operation_lock_file' =>
                self::joinPath($storageDir, 'temp/operation.lock'),
            'ping_lock_file' =>
                self::joinPath($storageDir, 'temp/ping.lock'),
            'backup_auto_directory' =>
                self::joinPath($storageDir, 'backups/auto'),
            'backup_restore_log_file' =>
                self::joinPath($storageDir, 'logs/restore.log'),
            'audit_log_directory' =>
                self::joinPath($storageDir, 'logs/audit'),
            'backup_restore_ttl_seconds' => 600,
            // 最大ZIP＋展開物にメタデータの余裕を取り、管理者4人が各2件を比較できる枠。
            'backup_restore_workspace' => [
                'max_count' => 8,
                'max_bytes' => 4 * 1024 * 1024 * 1024,
                'max_user_count' => 2,
                'max_user_bytes' => 1024 * 1024 * 1024,
            ],
            'backup_restore_confirmation' => 'バックアップから復元',
            'backup_auto_keep_count' => 2,
            'backup_auto_keep_days' => 7,

            /*
             * 画像保存とWeb構成ZIPは独立した容量契約。
             * 画像全体の件数・総量はnull（0も同義）で無制限。
             * Web構成ZIPはmanifest.jsonとdata/netarium.jsonのみ。
             */
            'storage_capacity' => [
                'warning_ratio' => 0.8,
                'workspace_reserve_bytes' => 16 * 1024 * 1024,
                'images' => [
                    'max_files' => array_key_exists('max_files', $localImages) ? $localImages['max_files'] : null,
                    'max_total_bytes' => array_key_exists('max_total_bytes', $localImages) ? $localImages['max_total_bytes'] : null,
                    'max_entry_bytes' => 10 * 1024 * 1024,
                ],
                'floor_plans' => [
                    'max_files' => 100,
                ],
                'backup' => [
                    'max_zip_bytes' => 24 * 1024 * 1024,
                    'max_uncompressed_bytes' => 64 * 1024 * 1024,
                    'max_entry_bytes' => 64 * 1024 * 1024,
                    'max_files' => 2,
                ],
            ],

            'application_version' => defined('NETARIUM_VERSION')
                ? NETARIUM_VERSION
                : '1.0.0',
        ];
    }

    private static function loadLocalConfig(string $installRoot): array
    {
        $configPath = self::joinPath($installRoot, 'config/app.php');

        if (!is_file($configPath)) {
            return [];
        }

        $config = require $configPath;

        if (!is_array($config)) {
            throw new RuntimeException(
                'config/app.php must return an array'
            );
        }

        $unknownKeys = array_diff(
            array_keys($config),
            [
                'storage_dir', 'db_file', 'allow_legacy_bcrypt',
                'trusted_https_proxies', 'hsts_max_age', 'csp_report_only',
                'storage_capacity',
            ]
        );

        if ($unknownKeys !== []) {
            throw new RuntimeException(
                'config/app.php contains unknown keys: '
                . implode(', ', array_map('strval', $unknownKeys))
            );
        }

        foreach ($config as $key => $value) {
            if ($key === 'allow_legacy_bcrypt' || $key === 'csp_report_only') {
                if (!is_bool($value)) {
                    throw new RuntimeException("config/app.php {$key} must be a boolean");
                }
                continue;
            }
            if ($key === 'hsts_max_age') {
                if ($value !== null && (!is_int($value) || $value < 0 || $value > 31536000)) {
                    throw new RuntimeException('config/app.php hsts_max_age must be null or an integer from 0 to 31536000');
                }
                continue;
            }
            if ($key === 'trusted_https_proxies') {
                if (!is_array($value) || !array_is_list($value)) {
                    throw new RuntimeException('config/app.php trusted_https_proxies must be a list of IP addresses');
                }
                foreach ($value as $address) {
                    if (!is_string($address) || filter_var($address, FILTER_VALIDATE_IP) === false) {
                        throw new RuntimeException('config/app.php trusted_https_proxies must contain valid IP addresses');
                    }
                }
                continue;
            }
            if ($key === 'storage_capacity') {
                if (!is_array($value)) {
                    throw new RuntimeException('config/app.php storage_capacity must be an array');
                }
                $unknownSections = array_diff(array_keys($value), ['images']);
                if ($unknownSections !== []) {
                    throw new RuntimeException('config/app.php storage_capacity contains unknown sections: ' . implode(', ', array_map('strval', $unknownSections)));
                }
                if (isset($value['images'])) {
                    if (!is_array($value['images'])) {
                        throw new RuntimeException('config/app.php storage_capacity.images must be an array');
                    }
                    $unknownImageKeys = array_diff(array_keys($value['images']), ['max_files', 'max_total_bytes']);
                    if ($unknownImageKeys !== []) {
                        throw new RuntimeException('config/app.php storage_capacity.images contains unknown keys: ' . implode(', ', array_map('strval', $unknownImageKeys)));
                    }
                    foreach (['max_files', 'max_total_bytes'] as $field) {
                        if (array_key_exists($field, $value['images'])) {
                            $quotaVal = $value['images'][$field];
                            if ($quotaVal !== null && (!is_int($quotaVal) || $quotaVal < 0)) {
                                throw new RuntimeException("config/app.php storage_capacity.images.{$field} must be null or a non-negative integer");
                            }
                        }
                    }
                }
                continue;
            }
            if (
                !is_string($value)
                || trim($value) === ''
                || trim($value) !== $value
                || !self::isAbsolutePath($value)
            ) {
                throw new RuntimeException(
                    "config/app.php {$key} must be a non-empty absolute path"
                );
            }
        }

        if (
            isset($config['storage_dir'], $config['db_file'])
            && !self::isPathWithin(
                $config['db_file'],
                $config['storage_dir']
            )
        ) {
            throw new RuntimeException(
                'config/app.php db_file must be inside storage_dir'
            );
        }

        return $config;
    }

    private static function isAbsolutePath(string $path): bool
    {
        return preg_match(
            '/\A(?:[A-Za-z]:[\\\\\/]|\/|\\\\\\\\)/',
            $path
        ) === 1;
    }

    private static function isPathWithin(
        string $path,
        string $parent
    ): bool {
        $normalizedPath = self::normalizePath($path);
        $normalizedParent = rtrim(
            self::normalizePath($parent),
            '/'
        );

        return str_starts_with(
            $normalizedPath,
            $normalizedParent . '/'
        );
    }

    private static function normalizePath(string $path): string
    {
        $path = str_replace('\\', '/', $path);
        $prefix = '';

        if (preg_match('/\A([A-Za-z]:)(?:\/|$)/', $path, $match)) {
            $prefix = strtolower($match[1]);
            $path = substr($path, 2);
        } elseif (str_starts_with($path, '//')) {
            $prefix = '//';
            $path = substr($path, 2);
        } elseif (str_starts_with($path, '/')) {
            $prefix = '/';
            $path = ltrim($path, '/');
        }

        $segments = [];
        foreach (explode('/', $path) as $segment) {
            if ($segment === '' || $segment === '.') {
                continue;
            }

            if ($segment === '..') {
                array_pop($segments);
                continue;
            }

            $segments[] = $segment;
        }

        $normalized = $prefix . implode('/', $segments);

        return $prefix === '//'
            || preg_match('/\A[a-z]:/', $prefix) === 1
            ? strtolower($normalized)
            : $normalized;
    }

    private static function joinPath(
        string $base,
        string $relative
    ): string {
        return rtrim($base, '/\\')
            . DIRECTORY_SEPARATOR
            . str_replace(
                '/',
                DIRECTORY_SEPARATOR,
                ltrim($relative, '/\\')
            );
    }
}
