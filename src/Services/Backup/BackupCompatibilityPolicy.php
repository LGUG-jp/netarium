<?php
declare(strict_types=1);

namespace Netarium\Services\Backup;

/**
 * バックアップZIP（Web構成情報・停止型完全バックアップ）の復元互換性ポリシー。
 *
 * 同一メジャー内の順方向と、明示的に対応する 1.x → 2.x の復元を受け付ける。
 * この入口判定だけでは許可しない。各復元処理で元契約の厳密検証・移行・
 * 復元先契約の再検証を行ってから配置する。
 */
final class BackupCompatibilityPolicy
{
    public const FORMAT_CONFIG = 'netarium-config';
    public const FORMAT_FULL = 'netarium-full';

    public const CONFIG_FORMAT_VERSION = 1;
    public const FULL_FORMAT_VERSION = 1;

    // 両復元処理に元契約の検証と 11→29 の移行が実装済み。
    // 将来のスキーマは、検証・移行を実装するまでこの一覧へ追加しない。
    private const SUPPORTED_SCHEMAS = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29];

    public static function isSupportedSchema(mixed $schemaVersion): bool
    {
        return in_array($schemaVersion, self::SUPPORTED_SCHEMAS, true);
    }

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
        return self::incompatibilityReason(
            $sourceSchemaVersion, $sourceAppVersion, $targetSchemaVersion, $targetAppVersion
        ) === null;
    }

    private static function incompatibilityReason(
        mixed $sourceSchemaVersion,
        mixed $sourceAppVersion,
        int $targetSchemaVersion,
        string $targetAppVersion
    ): ?string {
        // 安定版 MAJOR.MINOR.PATCH のみ。先頭ゼロ・接頭辞・プレリリース等は非対応。
        $pattern = '/\A(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\z/';
        if (!is_string($sourceAppVersion)
            || preg_match($pattern, $sourceAppVersion, $source) !== 1
            || preg_match($pattern, $targetAppVersion, $target) !== 1) {
            return 'invalid application version';
        }
        $crossMajor = $source[1] !== $target[1];
        if ($crossMajor && ($source[1] !== '1' || $target[1] !== '2')) {
            return 'different major version';
        }
        // 1.x → 2.x は、公開済みの安定版 1.0.0〜1.5.2 に限定する。
        $upperVersion = $crossMajor ? [2 => '5', 3 => '2'] : $target;
        // 桁数→同桁の数字の順で比較し、文字列辞書順や整数オーバーフローを避ける。
        for ($part = 2; $part <= 3; $part++) {
            $order = (strlen($source[$part]) <=> strlen($upperVersion[$part]))
                ?: strcmp($source[$part], $upperVersion[$part]);
            if ($order > 0) {
                return $crossMajor ? 'unsupported 1.x application version' : 'reverse application version';
            }
            if ($order < 0) {
                break;
            }
        }
        if (!self::isSupportedSchema($sourceSchemaVersion) || !self::isSupportedSchema($targetSchemaVersion)) {
            return 'unsupported schema contract or migration path';
        }
        if ($sourceSchemaVersion > $targetSchemaVersion) {
            return 'reverse schema migration';
        }
        if ($crossMajor && ($sourceSchemaVersion > 23 || $targetSchemaVersion < 29)) {
            return 'unsupported 1.x to 2.x schema path';
        }
        return null;
    }

    public static function describeConfigIncompatibility(
        mixed $sourceSchemaVersion,
        mixed $sourceAppVersion,
        int $targetSchemaVersion,
        string $targetAppVersion
    ): string {
        $reason = match (self::incompatibilityReason(
            $sourceSchemaVersion, $sourceAppVersion, $targetSchemaVersion, $targetAppVersion
        )) {
            'invalid application version' => 'アプリ版の表記が不正または非対応です',
            'different major version' => 'メジャーバージョンが異なります',
            'unsupported 1.x application version' => '2.x への復元はアプリ版 1.0.0〜1.5.2 が対象です',
            'unsupported 1.x to 2.x schema path' => '1.x から 2.x への復元ではこのスキーマの組は未対応です',
            'reverse application version' => '新版から旧版への逆方向復元はできません',
            'reverse schema migration' => 'DBスキーマの逆方向移行はできません',
            default => 'スキーマの保存契約または移行経路が未対応です',
        };
        $sourceAppText = is_string($sourceAppVersion) && $sourceAppVersion !== '' ? $sourceAppVersion : '不明';
        $sourceSchemaText = is_int($sourceSchemaVersion) ? (string)$sourceSchemaVersion : '不明';

        return sprintf(
            '構成情報ZIPを復元できません: %s（ZIP: アプリ版 %s / スキーマ版 %s、復元先: アプリ版 %s / スキーマ版 %d）',
            $reason,
            $sourceAppText,
            $sourceSchemaText,
            $targetAppVersion,
            $targetSchemaVersion
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
        $reason = !self::isSupportedFormat(self::FORMAT_FULL, $actualFormat, $actualFormatVersion)
            ? 'unsupported ZIP format'
            : self::incompatibilityReason(
                $sourceSchemaVersion, $sourceAppVersion, $targetSchemaVersion, $targetAppVersion
            );
        $formatText = is_string($actualFormat) && $actualFormat !== '' ? $actualFormat : 'unknown';
        $formatVersionText = is_int($actualFormatVersion) ? (string)$actualFormatVersion : 'unknown';
        $sourceAppText = is_string($sourceAppVersion) && $sourceAppVersion !== '' ? $sourceAppVersion : 'unknown';
        $sourceSchemaText = is_int($sourceSchemaVersion) ? (string)$sourceSchemaVersion : 'unknown';

        return sprintf(
            'Incompatible full backup manifest (%s; format=%s v%s, source_app=%s, source_schema=%s, target_app=%s, target_schema=%d)',
            $reason,
            $formatText,
            $formatVersionText,
            $sourceAppText,
            $sourceSchemaText,
            $targetAppVersion,
            $targetSchemaVersion
        );
    }
}
