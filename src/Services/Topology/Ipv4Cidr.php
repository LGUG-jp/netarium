<?php
declare(strict_types=1);

namespace Netarium\Services\Topology;

use Netarium\Core\ApiException;

/** IPv4 ranges use 64-bit integers; never enumerate a subnet to compare ranges. */
final class Ipv4Cidr
{
    public static function number(string $ip): int
    {
        if (!filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4)) {
            throw new ApiException('IPv4形式で入力してください', 400);
        }
        return (int)sprintf('%u', ip2long($ip));
    }

    public static function parse(string $cidr): array
    {
        if (preg_match('~^([^/]+)/([0-9]|[12][0-9]|3[0-2])$~D', trim($cidr), $matches) !== 1) {
            throw new ApiException('CIDRはIPv4/0〜32で指定してください', 400);
        }
        $number = self::number($matches[1]);
        $prefix = (int)$matches[2];
        $size = 1 << (32 - $prefix);
        $start = intdiv($number, $size) * $size;
        return ['cidr' => long2ip($start) . '/' . $prefix, 'start' => $start, 'end' => $start + $size - 1, 'size' => $size];
    }

    public static function contains(string $cidr, string $ip): bool
    {
        if (!filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4)) { return false; }
        $range = self::parse($cidr);
        $number = self::number($ip);
        return $number >= $range['start'] && $number <= $range['end'];
    }
}
