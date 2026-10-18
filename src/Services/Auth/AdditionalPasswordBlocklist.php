<?php
declare(strict_types=1);

namespace Netarium\Services\Auth;

use RuntimeException;

final class AdditionalPasswordBlocklist
{
    public const MAX_BYTES = 16777216;
    public const MAX_ENTRIES = 100000;

    /** @return array<string, true> */
    public static function parse(string $data): array
    {
        // 登録入力のCRLFだけを変換する。値の空白やUnicode表現は変更しない。
        $data = str_replace("\r\n", "\n", $data);
        if ($data === '' || strlen($data) > self::MAX_BYTES
            || str_starts_with($data, "\xEF\xBB\xBF") || !str_ends_with($data, "\n")) {
            throw new RuntimeException('追加辞書の形式または容量が不正です。');
        }
        $lines = explode("\n", $data);
        array_pop($lines);
        if (count($lines) > self::MAX_ENTRIES) {
            throw new RuntimeException('追加辞書の行数が上限を超えています。');
        }
        $entries = [];
        foreach ($lines as $line) {
            if (strlen($line) > 512 || preg_match('/\A.{1,128}\z/us', $line) !== 1
                || preg_match('/\p{Cc}/u', $line) !== 0) {
                throw new RuntimeException('追加辞書に不正な文字または長さの値があります。');
            }
            $key = strtr($line, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz');
            if (isset($entries[$key])) {
                throw new RuntimeException('追加辞書にASCII大小文字を区別しない重複があります。');
            }
            $entries[$key] = true;
        }
        return $entries;
    }

    /** @return array<string, true> */
    public static function load(string $directory): array
    {
        clearstatcache();
        // 設定は本文領域の外に置き、領域全体の欠損でも登録状態を失わない。
        $manifestPath = $directory . '.json';
        if (!file_exists($manifestPath) && !is_link($manifestPath)) {
            if (!file_exists($directory) && !is_link($directory)) {
                return [];
            }
            $files = is_dir($directory) ? @scandir($directory) : false;
            if ($files !== false && count($files) === 2) {
                return [];
            }
            throw new RuntimeException('追加辞書の設定を確認できません。');
        }
        $text = @file_get_contents($manifestPath, false, null, 0, 4097);
        if ($text === false || strlen($text) > 4096) {
            throw new RuntimeException('追加辞書の設定を確認できません。');
        }
        $manifest = json_decode($text, true);
        if (!is_array($manifest) || ($manifest['format_version'] ?? null) !== 1
            || !is_bool($manifest['enabled'] ?? null)) {
            throw new RuntimeException('追加辞書の設定が不正です。');
        }
        if ($manifest['enabled'] === false) {
            if (count($manifest) !== 2) {
                throw new RuntimeException('追加辞書の解除設定が不正です。');
            }
            return [];
        }
        if (count($manifest) !== 5 || !is_string($manifest['sha256'] ?? null)
            || preg_match('/\A[0-9a-f]{64}\z/', $manifest['sha256']) !== 1
            || !is_int($manifest['bytes'] ?? null) || $manifest['bytes'] < 1 || $manifest['bytes'] > self::MAX_BYTES
            || !is_int($manifest['entries'] ?? null) || $manifest['entries'] < 1 || $manifest['entries'] > self::MAX_ENTRIES) {
            throw new RuntimeException('追加辞書の整合性情報が不正です。');
        }
        // マニフェストからパスを受け取らず、確定したhash名だけを参照する。
        $data = @file_get_contents($directory . '/dictionary-' . $manifest['sha256'] . '.txt', false, null, 0, self::MAX_BYTES + 1);
        if ($data === false || strlen($data) !== $manifest['bytes']
            || str_contains($data, "\r") || !hash_equals($manifest['sha256'], hash('sha256', $data))) {
            throw new RuntimeException('追加辞書の本文を確認できません。');
        }
        $entries = self::parse($data);
        if (count($entries) !== $manifest['entries']) {
            throw new RuntimeException('追加辞書の件数が一致しません。');
        }
        return $entries;
    }
}
