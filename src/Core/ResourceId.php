<?php
declare(strict_types=1);

namespace Netarium\Core;

use PDO;

final class ResourceId
{
    // JavaScriptのNumberで正確に往復できる整数。復元には次の1件分を残す。
    public const MAX = 9007199254740991;
    public const MAX_RESTORE = self::MAX - 1;

    public static function parse(mixed $value, string $field, int $max = self::MAX): int
    {
        if (is_string($value) && ctype_digit($value)) {
            $digits = ltrim($value, '0');
            $bound = (string)$max;
            if ($digits === '' || strlen($digits) > strlen($bound) ||
                (strlen($digits) === strlen($bound) && strcmp($digits, $bound) > 0)) {
                throw new ApiException("{$field}が許容範囲外です", 400);
            }
            $value = (int)$digits;
        }
        if (!is_int($value) || $value < 1 || $value > $max) {
            throw new ApiException("{$field}が許容範囲外です", 400);
        }
        return $value;
    }

    // 呼出元のトランザクション内で使用する。失敗時にはカウンターを変更しない。
    public static function allocate(PDO $db, string $name): int
    {
        $stmt = $db->prepare('UPDATE resource_sequences SET value = value + 1
            WHERE name = :name AND typeof(value) = \'integer\' AND value >= 0 AND value < :max');
        $stmt->bindValue(':name', $name);
        $stmt->bindValue(':max', self::MAX, PDO::PARAM_INT);
        $stmt->execute();
        if ($stmt->rowCount() !== 1) {
            throw new ApiException('IDの採番余地がありません。管理者に連絡してください', 409, [
                'reason' => 'id_exhausted',
                'resource' => $name,
            ]);
        }
        $stmt = $db->prepare('SELECT value FROM resource_sequences WHERE name = :name');
        $stmt->execute([':name' => $name]);
        return (int)$stmt->fetchColumn();
    }
}
