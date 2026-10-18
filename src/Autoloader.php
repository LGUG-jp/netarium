<?php
declare(strict_types=1);

namespace Netarium;

/**
 * Composer非依存の軽量PSR-4オートローダー
 *
 * Netarium\ 名前空間配下のクラスを src/ 配下の対応するPHPファイルパスへマッピングします。
 */
final class Autoloader
{
    private static bool $registered = false;

    public static function register(): void
    {
        if (self::$registered) {
            return;
        }

        spl_autoload_register([self::class, 'loadClass']);
        self::$registered = true;
    }

    public static function loadClass(string $class): void
    {
        $prefix = 'Netarium\\';
        $baseDir = __DIR__ . '/';

        $len = strlen($prefix);
        if (strncmp($prefix, $class, $len) !== 0) {
            return;
        }

        $relativeClass = substr($class, $len);
        $file = $baseDir . str_replace('\\', '/', $relativeClass) . '.php';

        if (is_file($file)) {
            require_once $file;
        }
    }
}
