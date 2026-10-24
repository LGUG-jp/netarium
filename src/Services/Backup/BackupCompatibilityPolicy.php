<?php
declare(strict_types=1);

namespace Netarium\Services\Backup;

/**
 * バックアップZIP（Web構成情報・停止型完全バックアップ）の復元互換性ポリシー。
 *
 * SemVerやパッチ番号の大小比較で任意の旧版を機械的に許可せず、
 * ZIP形式・format_version・DBスキーマ版・保存データ契約・バックアップ元アプリ版・復元先アプリ版の組を
 * 個別に検証した組み合わせだけを明示的に許可する（fail-closed）。
 */
final class BackupCompatibilityPolicy
{
    public const FORMAT_CONFIG = 'netarium-config';
    public const FORMAT_FULL = 'netarium-full';

    public const CONFIG_FORMAT_VERSION = 1;
    public const FULL_FORMAT_VERSION = 1;

    /**
     * 形式・format_version・DBスキーマ版・復元先アプリ版ごとの許可されたバックアップ元アプリ版一覧。
     *
     * @var array<string, array<int, array<int, array<string, list<string>>>>>
     */
    private const ALLOWED_RESTORE_MATRIX = [
        self::FORMAT_CONFIG => [
            self::CONFIG_FORMAT_VERSION => [
                11 => [
                    '1.0.0' => ['1.0.0'],
                    '1.0.1' => ['1.0.1', '1.0.0'],
                    '1.0.2' => ['1.0.2', '1.0.1', '1.0.0'],
                    '1.0.3' => ['1.0.3', '1.0.2', '1.0.1', '1.0.0'],
                    '1.1.0' => ['1.1.0', '1.0.3', '1.0.2', '1.0.1', '1.0.0'],
                    '1.2.0' => ['1.2.0', '1.1.0', '1.0.3', '1.0.2', '1.0.1', '1.0.0'],
                ],
            ],
        ],
        self::FORMAT_FULL => [
            self::FULL_FORMAT_VERSION => [
                11 => [
                    '1.0.0' => ['1.0.0'],
                    '1.0.1' => ['1.0.1', '1.0.0'],
                    '1.0.2' => ['1.0.2', '1.0.1', '1.0.0'],
                    '1.0.3' => ['1.0.3', '1.0.2', '1.0.1', '1.0.0'],
                    '1.1.0' => ['1.1.0', '1.0.3', '1.0.2', '1.0.1', '1.0.0'],
                    '1.2.0' => ['1.2.0', '1.1.0', '1.0.3', '1.0.2', '1.0.1', '1.0.0'],
                ],
            ],
        ],
    ];

    public static function isSupportedFormat(
        string $expectedFormat,
        mixed $actualFormat,
        mixed $actualFormatVersion
    ): bool {
        if (!is_string($actualFormat) || !is_int($actualFormatVersion)) {
            return false;
        }
        $expectedVersion = match ($expectedFormat) {
            self::FORMAT_CONFIG => self::CONFIG_FORMAT_VERSION,
            self::FORMAT_FULL => self::FULL_FORMAT_VERSION,
            default => null,
        };
        return $expectedVersion !== null
            && $actualFormat === $expectedFormat
            && $actualFormatVersion === $expectedVersion;
    }

    /**
     * @return list<string>
     */
    public static function allowedSourceVersions(
        string $format,
        int $formatVersion,
        int $targetSchemaVersion,
        string $targetAppVersion
    ): array {
        return self::ALLOWED_RESTORE_MATRIX[$format][$formatVersion][$targetSchemaVersion][$targetAppVersion] ?? [];
    }

    public static function isCompatible(
        string $expectedFormat,
        mixed $actualFormat,
        mixed $actualFormatVersion,
        mixed $sourceSchemaVersion,
        mixed $sourceAppVersion,
        int $targetSchemaVersion,
        string $targetAppVersion
    ): bool {
        if (!self::isSupportedFormat($expectedFormat, $actualFormat, $actualFormatVersion)) {
            return false;
        }
        if (!is_int($sourceSchemaVersion) || $sourceSchemaVersion !== $targetSchemaVersion) {
            return false;
        }
        if (!is_string($sourceAppVersion) || $sourceAppVersion === '') {
            return false;
        }
        $allowed = self::allowedSourceVersions(
            $expectedFormat,
            $actualFormatVersion,
            $targetSchemaVersion,
            $targetAppVersion
        );
        return in_array($sourceAppVersion, $allowed, true);
    }

    public static function describeConfigIncompatibility(
        mixed $sourceSchemaVersion,
        mixed $sourceAppVersion,
        int $targetSchemaVersion,
        string $targetAppVersion
    ): string {
        $allowed = self::allowedSourceVersions(
            self::FORMAT_CONFIG,
            self::CONFIG_FORMAT_VERSION,
            $targetSchemaVersion,
            $targetAppVersion
        );
        $allowedText = $allowed !== [] ? implode(', ', $allowed) : 'なし';
        $sourceAppText = is_string($sourceAppVersion) && $sourceAppVersion !== '' ? $sourceAppVersion : '不明';
        $sourceSchemaText = is_int($sourceSchemaVersion) ? (string)$sourceSchemaVersion : '不明';

        return sprintf(
            '構成情報ZIPのスキーマ版またはアプリ版が一致しません（ZIP: アプリ版 %s / スキーマ版 %s、復元先: アプリ版 %s / スキーマ版 %d、対応するバックアップ元アプリ版: %s）',
            $sourceAppText,
            $sourceSchemaText,
            $targetAppVersion,
            $targetSchemaVersion,
            $allowedText
        );
    }

    public static function describeFullIncompatibility(
        mixed $actualFormat,
        mixed $actualFormatVersion,
        mixed $sourceSchemaVersion,
        mixed $sourceAppVersion,
        int $targetSchemaVersion,
        string $targetAppVersion
    ): string {
        $allowed = self::allowedSourceVersions(
            self::FORMAT_FULL,
            self::FULL_FORMAT_VERSION,
            $targetSchemaVersion,
            $targetAppVersion
        );
        $allowedText = $allowed !== [] ? implode(',', $allowed) : 'none';
        $formatText = is_string($actualFormat) && $actualFormat !== '' ? $actualFormat : 'unknown';
        $formatVersionText = is_int($actualFormatVersion) ? (string)$actualFormatVersion : 'unknown';
        $sourceAppText = is_string($sourceAppVersion) && $sourceAppVersion !== '' ? $sourceAppVersion : 'unknown';
        $sourceSchemaText = is_int($sourceSchemaVersion) ? (string)$sourceSchemaVersion : 'unknown';

        return sprintf(
            'Incompatible full backup manifest (format=%s v%s, source_app=%s, source_schema=%s, target_app=%s, target_schema=%d, supported_source_apps=%s)',
            $formatText,
            $formatVersionText,
            $sourceAppText,
            $sourceSchemaText,
            $targetAppVersion,
            $targetSchemaVersion,
            $allowedText
        );
    }
}
