<?php
declare(strict_types=1);

namespace Netarium\Services\Topology;

use Netarium\Core\ApiException;
use Netarium\Core\Request;

class DeviceFields
{
    public const ALLOWED_SCHEMES = ['', 'http', 'https', 'ssh'];
    public const MAX_DEPARTMENT_LENGTH = 100;
    public const MAX_MAINTENANCE_VENDOR_LENGTH = 100;

    /**
     * 日付文字列が YYYY-MM または YYYY-MM-DD の実在日付であるか検証
     */
    public static function isValidDateString(string $date): bool
    {
        $trimmed = trim($date);
        if ($trimmed === '') {
            return true;
        }

        if (preg_match('/\A(\d{4})-(0[1-9]|1[0-2])\z/', $trimmed, $m)) {
            $year = (int)$m[1];
            return $year >= 1000 && $year <= 9999;
        }

        if (preg_match('/\A(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\z/', $trimmed, $m)) {
            $year = (int)$m[1];
            $month = (int)$m[2];
            $day = (int)$m[3];
            return checkdate($month, $day, $year);
        }

        return false;
    }

    /**
     * 導入年月と保守期限年月の順序を検証
     * 両方が指定されている場合、期限年月が導入年月より早ければ false
     */
    public static function validateDateOrder(string $installDate, string $maintenanceExpiry): bool
    {
        $install = trim($installDate);
        $expiry = trim($maintenanceExpiry);

        if ($install === '' || $expiry === '') {
            return true;
        }

        $installYm = substr($install, 0, 7);
        $expiryYm = substr($expiry, 0, 7);

        if ($expiryYm < $installYm) {
            return false;
        }

        if (strlen($install) === 10 && strlen($expiry) === 10) {
            if ($expiry < $install) {
                return false;
            }
        }

        return true;
    }

    /**
     * 保守・接続項目の検証と正規化
     *
     * @param array $device
     * @param string $prefix
     * @return array{
     *     management_scheme: string,
     *     management_port: ?int,
     *     department: string,
     *     maintenance_vendor: string,
     *     install_date: string,
     *     maintenance_expiry: string
     * }
     */
    public static function normalizeAndValidate(array $device, string $prefix = ''): array
    {
        $scheme = trim((string)($device['management_scheme'] ?? ''));
        if (!in_array($scheme, self::ALLOWED_SCHEMES, true)) {
            throw new ApiException("{$prefix}管理接続方式が不正です: {$scheme}", 400);
        }

        $rawPort = $device['management_port'] ?? null;
        $port = null;
        if ($rawPort !== null && trim((string)$rawPort) !== '') {
            $portStr = trim((string)$rawPort);
            if (preg_match('/\A[0-9]+\z/', $portStr) !== 1) {
                throw new ApiException("{$prefix}管理接続ポートは1〜65535の整数で入力してください", 400);
            }
            $portNum = (int)$portStr;
            if ($portNum < 1 || $portNum > 65535) {
                throw new ApiException("{$prefix}管理接続ポートは1〜65535の範囲で入力してください", 400);
            }
            if ($scheme === '') {
                throw new ApiException("{$prefix}管理接続方式が設定されていない場合、ポートは指定できません", 400);
            }
            $port = $portNum;
        }

        $installDate = trim((string)($device['install_date'] ?? ''));
        if ($installDate !== '' && !self::isValidDateString($installDate)) {
            throw new ApiException("{$prefix}導入年月は実在する年月(YYYY-MM)または年月日(YYYY-MM-DD)で入力してください", 400);
        }

        $maintenanceExpiry = trim((string)($device['maintenance_expiry'] ?? ''));
        if ($maintenanceExpiry !== '' && !self::isValidDateString($maintenanceExpiry)) {
            throw new ApiException("{$prefix}保守期限は実在する年月(YYYY-MM)または年月日(YYYY-MM-DD)で入力してください", 400);
        }

        if ($installDate !== '' && $maintenanceExpiry !== '' && !self::validateDateOrder($installDate, $maintenanceExpiry)) {
            throw new ApiException("{$prefix}保守期限は導入年月以降の日付を指定してください", 400);
        }

        $department = Request::normalizeLedgerText($device['department'] ?? '', self::MAX_DEPARTMENT_LENGTH);
        $vendor = Request::normalizeLedgerText($device['maintenance_vendor'] ?? '', self::MAX_MAINTENANCE_VENDOR_LENGTH);

        return [
            'management_scheme' => $scheme,
            'management_port' => $port,
            'department' => $department,
            'maintenance_vendor' => $vendor,
            'install_date' => $installDate,
            'maintenance_expiry' => $maintenanceExpiry,
        ];
    }
}
