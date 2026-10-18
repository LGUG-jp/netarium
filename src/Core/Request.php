<?php
declare(strict_types=1);

namespace Netarium\Core;

class Request
{
    /**
     * HTTPメソッド確認
     */
    public static function requireMethod(string $method): void
    {
        $actual = $_SERVER['REQUEST_METHOD'] ?? '';

        if (strtoupper($actual) !== strtoupper($method)) {
            throw new ApiException("HTTPメソッドは{$method}を使用してください", 405);
        }
    }

    /**
     * JSON Body読み込み
     */
    public static function readJsonBody(): array
    {
        $raw = file_get_contents('php://input');

        if ($raw === false || trim($raw) === '') {
            return [];
        }

        try {
            $data = self::decodeJson($raw);
        } catch (\JsonException $e) {
            throw new ApiException('JSONの形式が不正です: ' . $e->getMessage(), 400);
        }
        if ($data instanceof \stdClass && get_object_vars($data) === []) {
            return [];
        }

        if (!is_array($data)) {
            throw new ApiException('JSON Bodyはオブジェクト形式で送信してください', 400);
        }

        return $data;
    }

    /**
     * 通常のJSONオブジェクトは連想配列へ変換するが、
     * 空・数値キーのオブジェクトをJSON配列と混同しない。
     */
    public static function decodeJson(string $json): mixed
    {
        return self::convertJsonValue(json_decode($json, false, 512, JSON_THROW_ON_ERROR));
    }

    private static function convertJsonValue(mixed $value): mixed
    {
        if ($value instanceof \stdClass) {
            $properties = get_object_vars($value);
            if (array_is_list($properties)) {
                return $value;
            }
            $value = $properties;
        }
        if (is_array($value)) {
            foreach ($value as $key => $item) {
                $value[$key] = self::convertJsonValue($item);
            }
        }
        return $value;
    }

    /**
     * nullable string整形
     */
    public static function normalizeNullableString($value): ?string
    {
        if ($value === null) {
            return null;
        }

        $value = trim((string)$value);

        return $value === '' ? null : $value;
    }

    /**
     * nullable int整形
     */
    public static function normalizeNullableInt($value): ?int
    {
        if ($value === null || $value === '') {
            return null;
        }

        if (!is_numeric($value)) {
            return null;
        }

        return (int)$value;
    }

    /**
     * 台帳文字列の正規化・長さ制限
     */
    public static function normalizeLedgerText($value, int $maxLength): string
    {
        if (is_array($value) || is_object($value)) {
            return '';
        }

        $text = trim((string)$value);

        if ($maxLength <= 0) {
            return '';
        }

        if (function_exists('mb_substr')) {
            return mb_substr($text, 0, $maxLength, 'UTF-8');
        }

        if (function_exists('iconv_substr')) {
            $result = @iconv_substr($text, 0, $maxLength, 'UTF-8');
            if ($result !== false) {
                return $result;
            }
        }

        if (@preg_match('/^.{0,' . $maxLength . '}/us', $text, $matches)) {
            return $matches[0];
        }

        return substr($text, 0, $maxLength);
    }

    /**
     * execが利用可能か確認
     */
    public static function isExecAvailable(): bool
    {
        if (!function_exists('exec')) {
            return false;
        }

        $disabled = ini_get('disable_functions');

        if ($disabled === false || trim($disabled) === '') {
            return true;
        }

        $disabledFunctions = array_map('trim', explode(',', strtolower($disabled)));

        return !in_array('exec', $disabledFunctions, true);
    }

    /**
     * プライベートIPv4判定
     */
    public static function isPrivateIpv4(string $ip): bool
    {
        if (!filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4)) {
            return false;
        }

        $long = ip2long($ip);

        if ($long === false) {
            return false;
        }

        $ranges = [
            ['10.0.0.0', '10.255.255.255'],
            ['172.16.0.0', '172.31.255.255'],
            ['192.168.0.0', '192.168.255.255'],
            ['127.0.0.0', '127.255.255.255'],
        ];

        foreach ($ranges as [$start, $end]) {
            $startLong = ip2long($start);
            $endLong = ip2long($end);

            if ($startLong !== false && $endLong !== false && $long >= $startLong && $long <= $endLong) {
                return true;
            }
        }

        return false;
    }

    /**
     * 有限小数の正規化
     */
    public static function normalizeFiniteNumber($value, float $default = 0): float
    {
        if (is_array($value) || is_object($value) || !is_numeric($value)) {
            return $default;
        }

        $number = (float)$value;

        if (is_nan($number) || is_infinite($number)) {
            return $default;
        }

        return $number;
    }
}

