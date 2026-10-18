<?php
declare(strict_types=1);

namespace Netarium\Services\Auth;

use Netarium\Core\ApiException;
use Throwable;

final class PasswordHashing
{
    public const OPTIONS = [
        'memory_cost' => 19456,
        'time_cost' => 2,
        'threads' => 1,
    ];

    public static function assertSupported(): void
    {
        if (!defined('PASSWORD_ARGON2ID') || !in_array('argon2id', password_algos(), true)) {
            throw new ApiException('このPHP環境はArgon2idに対応していません。管理者へお問い合わせください', 503);
        }
    }

    public static function hash(#[\SensitiveParameter] string $password): string
    {
        self::assertSupported();
        try {
            $hash = password_hash($password, PASSWORD_ARGON2ID, self::OPTIONS);
        } catch (Throwable $e) {
            // ハッシュ実装の例外詳細や入力をHTTP応答・ログへ渡さない。
            throw new ApiException('パスワードを保存できませんでした。管理者へお問い合わせください', 503);
        }
        if (!is_string($hash) || !str_starts_with($hash, '$argon2id$')) {
            throw new ApiException('パスワードを保存できませんでした。管理者へお問い合わせください', 503);
        }
        return $hash;
    }

    public static function verify(
        #[\SensitiveParameter] string $password,
        #[\SensitiveParameter] string $hash,
        bool $allowLegacyBcrypt
    ): bool {
        self::assertSupported();
        $algorithm = password_get_info($hash)['algoName'];
        if ($algorithm !== 'argon2id' && !($allowLegacyBcrypt && $algorithm === 'bcrypt')) {
            return false;
        }
        // 旧bcryptの成功入力から末尾の正当性は判定できない。照合だけで移行しない。
        return password_verify($password, $hash);
    }
}
