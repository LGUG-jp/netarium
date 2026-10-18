<?php
declare(strict_types=1);

namespace Netarium\Services\Auth;

use Netarium\Core\Config;
use Throwable;

final class PasswordBlocklist
{
    private const PWDB_SHA256 = '6906f8fd73b71d8ae3827876c539c216f3e42a163f712c06d9493464ce992de7';
    private const PWDB_BYTES = 42175;
    private const PWDB_ENTRIES = 3000;
    private const SECLISTS_LICENSE_SHA256 = '3dbdc93d5f8829de0941744841730a09c106d0732e5ae0e98ca1d77be7ded66c';
    private const PWDB_ORIGINAL_LICENSE_SHA256 = '4088d581cba171b1aa6f880ad3fb5327e2d6de415621cf8b80685ac506c0cae1';
    private const UNAVAILABLE = 'パスワード安全性データを確認できないため、設定できません。管理者に連絡してください';
    private const REJECTED = '漏えい・頻出または容易に推測できるパスワードは使用できません';

    /** @var array<string, true>|null */
    private ?array $entries = null;

    // 標準辞書の明示指定時は、追加領域も明示しない限り配備設定から隔離する。
    public function __construct(?string $directory = null, ?string $additionalDirectory = null)
    {
        $useConfiguredDirectory = $directory === null && $additionalDirectory === null;
        $directory ??= dirname(__DIR__, 3) . '/resources/password-blocklist';
        $data = @file_get_contents($directory . '/pwdb-policy-top-3000.txt');
        $metadataText = @file_get_contents($directory . '/pwdb-metadata.json');
        if ($data === false || $metadataText === false) {
            return;
        }
        $metadata = json_decode($metadataText, true);
        if (!is_array($metadata)
            || ($metadata['format_version'] ?? null) !== 1
            || ($metadata['canonical_sha256'] ?? null) !== self::PWDB_SHA256
            || ($metadata['source_lines'] ?? null) !== 1000000
            || !is_int($metadata['source_bytes'] ?? null)
            || $metadata['source_bytes'] <= 0
            || ($metadata['bundled_bytes'] ?? null) !== self::PWDB_BYTES
            || ($metadata['bundled_lines'] ?? null) !== self::PWDB_ENTRIES
            || ($metadata['ascii_casefold_unique_entries'] ?? null) !== self::PWDB_ENTRIES
            || ($metadata['source_rank_cutoff'] ?? null) !== 195756
            || ($metadata['license_spdx'] ?? null) !== 'MIT'
            || !is_string($metadata['license_text'] ?? null)
            || !hash_equals(self::SECLISTS_LICENSE_SHA256, hash('sha256', (string)($metadata['license_text'] ?? '')))
            || ($metadata['original_license_spdx'] ?? null) !== 'MIT'
            || !is_string($metadata['original_license_text'] ?? null)
            || !hash_equals(self::PWDB_ORIGINAL_LICENSE_SHA256, hash('sha256', (string)($metadata['original_license_text'] ?? '')))) {
            return;
        }
        $extraction = $metadata['extraction'] ?? null;
        if (!is_array($extraction)
            || ($extraction['minimum_code_points'] ?? null) !== 12
            || ($extraction['maximum_code_points'] ?? null) !== 128
            || ($extraction['maximum_bytes'] ?? null) !== 512
            || ($extraction['exclude_nul'] ?? null) !== true
            || ($extraction['ascii_casefold'] ?? null) !== true
            || ($extraction['unicode_normalization'] ?? null) !== false
            || ($extraction['trim'] ?? null) !== false
            || ($extraction['selection'] ?? null) !== 'first eligible ASCII-casefold-unique values in source order') {
            return;
        }
        // Apply the same packaging-only CRLF conversion, never trimming credentials.
        $data = str_replace("\r\n", "\n", $data);
        if (strlen($data) !== self::PWDB_BYTES
            || !hash_equals(self::PWDB_SHA256, hash('sha256', $data))) {
            return;
        }
        $lines = explode("\n", $data);
        if (array_pop($lines) !== '' || count($lines) !== self::PWDB_ENTRIES) {
            return;
        }
        $pwdbEntries = [];
        foreach ($lines as $line) {
            if (strlen($line) > 512 || str_contains($line, "\0")
                || preg_match('/\A.{12,128}\z/us', $line) !== 1) {
                return;
            }
            $pwdbEntries[self::foldAscii($line)] = true;
        }
        if (count($pwdbEntries) !== self::PWDB_ENTRIES) {
            return;
        }
        // 標準・追加の全検査が完了するまで照合値を公開しない。
        try {
            if ($useConfiguredDirectory) {
                $additionalDirectory = Config::create()['storage_dir'] . '/password-blocklist';
            }
            if ($additionalDirectory !== null) {
                $pwdbEntries += AdditionalPasswordBlocklist::load($additionalDirectory);
            }
        } catch (Throwable) {
            return;
        }
        $this->entries = $pwdbEntries;
    }

    public function isAvailable(): bool
    {
        return $this->entries !== null;
    }

    public static function validate(string $password, string $username = ''): ?string
    {
        static $blocklist = null;
        $blocklist ??= new self();
        return $blocklist->check($password, $username);
    }

    public function check(string $password, string $username = ''): ?string
    {
        if ($this->entries === null) {
            return self::UNAVAILABLE;
        }
        $candidate = self::foldAscii($password);
        if (isset($this->entries[$candidate])) {
            return self::REJECTED;
        }
        // Reject whole-input repetition, including longer words, whitespace and emoji.
        // A valid setting is at most 128 code points, so repeated units need at most 64.
        if (preg_match('/\A(.{1,64}?)\1+\z/us', $candidate) === 1) {
            return self::REJECTED;
        }
        foreach (['netarium', self::foldAscii($username)] as $base) {
            if ($base === '') {
                continue;
            }
            if ($candidate === $base || $candidate === $base . $base) {
                return self::REJECTED;
            }
            if (str_starts_with($candidate, $base)) {
                $suffix = substr($candidate, strlen($base));
                // Common numeric/year and punctuation suffixes, matched in full.
                if (preg_match('/\A(?:[!@#$%._-]{0,3}[0-9]{1,8}[!@#$%._-]{0,3}|[!@#$%._-]{1,3})\z/', $suffix) === 1) {
                    return self::REJECTED;
                }
            }
        }
        return null;
    }

    private static function foldAscii(string $value): string
    {
        return strtr($value, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz');
    }
}
