<?php
declare(strict_types=1);

namespace Netarium\Core;

use PDO;
use PDOException;

require_once __DIR__ . '/DatabaseSchema.php';

class Database
{
    /**
     * DB接続
     */
    public static function open(string $dbFile): PDO
    {
        $dir = dirname($dbFile);

        if (!is_dir($dir)) {
            throw new ApiException(
                'DB保存先ディレクトリが存在しません: ' . $dir,
                500
            );
        }

        if (!is_writable($dir)) {
            throw new ApiException(
                'DB保存先ディレクトリに書き込み権限がありません: ' . $dir,
                500
            );
        }

        return self::connect($dbFile);
    }

    /**
     * 呼出元の保存先検証後に接続し、共通の設定・移行・初期データを適用する。
     */
    public static function connect(string $dbFile): PDO
    {
        $db = new PDO('sqlite:' . $dbFile);
        self::initialize($db);

        return $db;
    }

    public static function initialize(PDO $db): void
    {
        self::configure($db);
        \migrateDatabase($db);
        \ensureDefaultView($db);
        \ensureSetupCompletedMarker($db);
    }

    public static function configure(PDO $db): void
    {
        $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $db->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        $db->exec('PRAGMA busy_timeout = 5000');
        $db->exec('PRAGMA foreign_keys = ON');
        $db->exec('PRAGMA temp_store = MEMORY');
    }

    /**
     * SQLite busy例外の判定
     */
    public static function isBusy(PDOException $exception): bool
    {
        $message = strtolower($exception->getMessage());

        return (
            str_contains($message, 'database is locked') ||
            str_contains($message, 'database is busy') ||
            str_contains($message, 'sqlite_busy') ||
            str_contains($message, 'sqlite_locked')
        );
    }
}
