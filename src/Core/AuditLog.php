<?php
declare(strict_types=1);

namespace Netarium\Core;

use DateInterval;
use DateTimeImmutable;
use DateTimeZone;
use PDO;
use Throwable;
use Netarium\Repositories\AppMetaRepository;

final class AuditLog
{
    public const MAX_FILE_BYTES = 10485760; // 10 MiB
    public const MAX_TOTAL_BYTES = 268435456; // 256 MiB
    public const RETENTION_DAYS = 90;
    public const RESERVED_TERMINAL_BYTES = 65536; // 64 KiB: begin時に終端・関連レコード用の空き容量を確保
    public const LOCK_FILE = '.lock';
    public const SECURITY_WINDOW_SECONDS = 60;
    public const SECURITY_WINDOW_LIMIT = 10;
    public const SECURITY_BUSINESS_HEADROOM_BYTES = 16777216; // 16 MiB: 拒否洪水に通常業務用の空きを使わせない
    public const SECURITY_STATE_FILE = '.security-window';
    private const SECURITY_EVENTS = [
        'authentication_required' => ['auth.authentication_denied', 'failure', 401],
        'password_change_required' => ['auth.authorization_denied', 'failure', 403],
        'insufficient_role' => ['auth.authorization_denied', 'failure', 403],
        'invalid_csrf' => ['auth.csrf_denied', 'failure', 403],
        'logout' => ['auth.logout', 'success', 302],
    ];
    public const FILENAME_PATTERN = '/\Aaudit-(\d{4})(\d{2})(\d{2})-(\d{3})\.log\z/';
    private const RESERVATION_PATTERN = '/\A\.pending-[0-9a-f]{32}\z/';
    private const ALLOWED_COUNTS_KEYS = [
        'deleted_device_count',
        'deleted_view_count',
        'insert_count',
        'update_count',
    ];

    private static ?array $config = null;
    private static ?string $requestId = null;
    private static ?string $event = null;
    private static ?int $actorUserId = null;
    private static ?PDO $db = null;
    private static bool $finished = false;
    private static $reservationFile = null;
    private static ?string $reservationPath = null;

    public static function begin(
        array $config,
        string $event,
        ?int $actorId,
        ?PDO $db
    ): void {
        self::reset();
        self::$config = $config;
        self::$requestId = bin2hex(random_bytes(16));
        self::$event = $event;
        self::$actorUserId = $actorId;
        self::$db = $db;
        self::$finished = false;

        $dataRevision = self::getRevision($db);

        $entry = [
            'timestamp' => self::formatTimestamp(),
            'request_id' => self::$requestId,
            'event' => $event,
            'outcome' => 'started',
            'actor_user_id' => $actorId,
            'subject_username' => null,
            'target_type' => null,
            'target_id' => null,
            'target_count' => null,
            'counts' => null,
            'data_revision' => $dataRevision,
            'http_status' => null,
            'codes' => [],
        ];
        try {
            self::writeEntry($config, $entry, true, true);
        } catch (Throwable $e) {
            self::reset();
            throw $e;
        }
    }

    public static function id(): ?string
    {
        return self::$requestId;
    }

    public static function event(): ?string
    {
        return self::$event;
    }

    public static function isFinished(): bool
    {
        return self::$finished;
    }

    public static function finish(
        string $outcome,
        array $target = [],
        ?int $httpStatus = null,
        array $codes = []
    ): bool {
        if (self::$requestId === null || self::$finished) {
            return false;
        }

        self::$finished = true;

        $dataRevision = self::getRevision(self::$db);

        $targetType = isset($target['target_type']) && is_string($target['target_type'])
            ? $target['target_type']
            : null;

        $targetId = null;
        if (isset($target['target_id'])) {
            if (is_int($target['target_id'])) {
                $targetId = $target['target_id'];
            } elseif (is_numeric($target['target_id'])) {
                $targetId = (int)$target['target_id'];
            }
        }

        $targetCount = null;
        if (isset($target['target_count'])) {
            if (is_int($target['target_count'])) {
                $targetCount = $target['target_count'];
            } elseif (is_numeric($target['target_count'])) {
                $targetCount = (int)$target['target_count'];
            }
        }

        $counts = self::sanitizeCounts($target['counts'] ?? null);

        $subjectUsername = null;
        if (
            self::$event === 'auth.login'
            && $outcome === 'failure'
            && isset($target['subject_username'])
            && is_string($target['subject_username'])
        ) {
            $rawUsername = $target['subject_username'];
            if (self::isValidUsernameFormat($rawUsername)) {
                $subjectUsername = mb_substr($rawUsername, 0, 50);
            }
        }

        $filteredCodes = [];
        foreach ($codes as $code) {
            if (is_string($code) && $code !== '') {
                $filteredCodes[] = $code;
            }
        }

        $entry = [
            'timestamp' => self::formatTimestamp(),
            'request_id' => self::$requestId,
            'event' => self::$event,
            'outcome' => $outcome,
            'actor_user_id' => self::$actorUserId,
            'subject_username' => $subjectUsername,
            'target_type' => $targetType,
            'target_id' => $targetId,
            'target_count' => $targetCount,
            'counts' => $counts,
            'data_revision' => $dataRevision,
            'http_status' => $httpStatus,
            'codes' => $filteredCodes,
        ];

        $written = self::writeEntry(self::$config ?? [], $entry, false);
        if (!$written) {
            error_log(sprintf(
                '[AuditLog] Failed to record finish log: request_id=%s event=%s outcome=%s',
                (string)self::$requestId,
                (string)self::$event,
                $outcome
            ));
            return false;
        }

        return true;
    }

    public static function recordRelated(string $event, array $target): bool
    {
        if (self::$requestId === null) {
            return false;
        }

        $dataRevision = self::getRevision(self::$db);

        $targetType = isset($target['target_type']) && is_string($target['target_type'])
            ? $target['target_type']
            : null;

        $targetId = null;
        if (isset($target['target_id'])) {
            if (is_int($target['target_id'])) {
                $targetId = $target['target_id'];
            } elseif (is_numeric($target['target_id'])) {
                $targetId = (int)$target['target_id'];
            }
        }

        $targetCount = null;
        if (isset($target['target_count'])) {
            if (is_int($target['target_count'])) {
                $targetCount = $target['target_count'];
            } elseif (is_numeric($target['target_count'])) {
                $targetCount = (int)$target['target_count'];
            }
        }

        $counts = self::sanitizeCounts($target['counts'] ?? null);

        $entry = [
            'timestamp' => self::formatTimestamp(),
            'request_id' => self::$requestId,
            'event' => $event,
            'outcome' => 'success',
            'actor_user_id' => self::$actorUserId,
            'subject_username' => null,
            'target_type' => $targetType,
            'target_id' => $targetId,
            'target_count' => $targetCount,
            'counts' => $counts,
            'data_revision' => $dataRevision,
            'http_status' => 200,
            'codes' => [],
        ];

        $written = self::writeEntry(self::$config ?? [], $entry, false);
        if (!$written) {
            error_log(sprintf(
                '[AuditLog] Failed to record related log: request_id=%s event=%s',
                (string)self::$requestId,
                $event
            ));
            return false;
        }

        return true;
    }

    public static function recordSecurityEvent(array $config, string $reason, ?int $actorId): ?string
    {
        if (!isset(self::SECURITY_EVENTS[$reason])) {
            return null;
        }

        try {
            [$event, $outcome, $httpStatus] = self::SECURITY_EVENTS[$reason];
            $requestId = bin2hex(random_bytes(16));
            $entry = [
                'timestamp' => self::formatTimestamp(),
                'request_id' => $requestId,
                'event' => $event,
                'outcome' => $outcome,
                'actor_user_id' => $actorId,
                'subject_username' => null,
                'target_type' => null,
                'target_id' => null,
                'target_count' => null,
                'counts' => null,
                'data_revision' => null,
                'http_status' => $httpStatus,
                'codes' => [$reason],
            ];

            // 拒否処理を優先し、反復する保存障害を別のログへ流さない。
            return @self::writeEntry($config, $entry, false, false, $reason) ? $requestId : null;
        } catch (Throwable $e) {
            return null;
        }
    }

    public static function prune(array $config): void
    {
        $dir = (string)($config['audit_log_directory'] ?? '');
        if ($dir === '' || !is_dir($dir)) {
            return;
        }

        $lockFile = $dir . DIRECTORY_SEPARATOR . self::LOCK_FILE;
        $lockFp = @fopen($lockFile, 'c+');
        if ($lockFp === false) {
            throw new \RuntimeException('監査ログの排他制御ファイルを開けません: ' . $lockFile);
        }

        if (!@flock($lockFp, LOCK_EX)) {
            fclose($lockFp);
            throw new \RuntimeException('監査ログの排他制御ロックを取得できません: ' . $lockFile);
        }

        try {
            self::pruneExpiredFiles($dir, true);
        } finally {
            @flock($lockFp, LOCK_UN);
            fclose($lockFp);
        }
    }

    public static function reset(): void
    {
        if (is_resource(self::$reservationFile)) {
            fclose(self::$reservationFile);
        }
        if (self::$reservationPath !== null) {
            @unlink(self::$reservationPath);
        }
        self::$reservationFile = null;
        self::$reservationPath = null;
        self::$config = null;
        self::$requestId = null;
        self::$event = null;
        self::$actorUserId = null;
        self::$db = null;
        self::$finished = false;
    }

    private static function activeReservations(string $dir): int
    {
        $items = @scandir($dir);
        if ($items === false) {
            throw new ApiException('監査ログの予約一覧を取得できません', 503);
        }

        $count = 0;
        foreach ($items as $item) {
            if (preg_match(self::RESERVATION_PATTERN, $item) !== 1) {
                continue;
            }
            $path = $dir . DIRECTORY_SEPARATOR . $item;
            $file = @fopen($path, 'c+');
            if ($file === false) {
                $count++;
                continue;
            }
            if (@flock($file, LOCK_EX | LOCK_NB)) {
                @flock($file, LOCK_UN);
                fclose($file);
                if (!@unlink($path)) {
                    throw new ApiException('失効した監査ログ予約を削除できません', 503);
                }
            } else {
                fclose($file);
                $count++;
            }
        }
        return $count;
    }

    private static function reserve(string $dir): void
    {
        $path = $dir . DIRECTORY_SEPARATOR . '.pending-' . self::$requestId;
        $file = @fopen($path, 'x+b');
        if ($file === false) {
            throw new ApiException('監査ログの容量予約を作成できません', 503);
        }
        if (!@flock($file, LOCK_EX | LOCK_NB)) {
            fclose($file);
            @unlink($path);
            throw new ApiException('監査ログの容量予約を取得できません', 503);
        }
        self::$reservationFile = $file;
        self::$reservationPath = $path;
        register_shutdown_function([self::class, 'reset']);
    }

    /**
     * .lock取得中にのみ呼ぶ。nullは保存不能または窓内抑制済み、
     * falseは今回が抑制開始、trueは通常のsecurity行を意味する。
     */
    private static function consumeSecurityQuota(string $dir, string $reason): ?bool
    {
        $path = $dir . DIRECTORY_SEPARATOR . self::SECURITY_STATE_FILE;
        $file = @fopen($path, 'x+b');
        $created = $file !== false;
        if (!$created) {
            $file = @fopen($path, 'r+b');
        }
        if ($file === false) {
            return null;
        }

        try {
            $window = intdiv(time(), self::SECURITY_WINDOW_SECONDS);
            if ($created) {
                $state = [];
                foreach (self::SECURITY_EVENTS as $key => $_event) {
                    $state[$key] = ['window' => $window, 'count' => 0];
                }
            } else {
                $raw = fread($file, 4097);
                if ($raw === false || strlen($raw) > 4096) {
                    return null;
                }
                $state = json_decode($raw, true);
                if (!is_array($state) || count($state) !== count(self::SECURITY_EVENTS)) {
                    return null;
                }
                foreach (self::SECURITY_EVENTS as $key => $_event) {
                    $value = $state[$key] ?? null;
                    if (
                        !is_array($value)
                        || count($value) !== 2
                        || !isset($value['window'], $value['count'])
                        || !is_int($value['window'])
                        || $value['window'] < 0
                        || $value['window'] > $window
                        || !is_int($value['count'])
                        || $value['count'] < 0
                        || $value['count'] > self::SECURITY_WINDOW_LIMIT + 1
                    ) {
                        return null;
                    }
                }
            }

            if ($state[$reason]['window'] !== $window) {
                $state[$reason] = ['window' => $window, 'count' => 0];
            }
            if ($state[$reason]['count'] > self::SECURITY_WINDOW_LIMIT) {
                return null;
            }
            $state[$reason]['count']++;
            $serialized = json_encode($state, JSON_UNESCAPED_SLASHES);
            if (!is_string($serialized) || strlen($serialized) > 4096) {
                return null;
            }
            if (
                !rewind($file)
                || fwrite($file, $serialized) !== strlen($serialized)
                || !ftruncate($file, strlen($serialized))
                || !fflush($file)
            ) {
                return null;
            }

            return $state[$reason]['count'] <= self::SECURITY_WINDOW_LIMIT;
        } finally {
            fclose($file);
        }
    }

    private static function writeEntry(
        array $config,
        array $entry,
        bool $throwOnFailure,
        bool $reserveHeadroom = false,
        ?string $securityReason = null
    ): bool {
        $dir = (string)($config['audit_log_directory'] ?? '');
        if ($dir === '') {
            if ($throwOnFailure) {
                throw new ApiException('監査ログ保存先が設定されていません', 503);
            }
            return false;
        }

        if (!is_dir($dir)) {
            if (!@mkdir($dir, 0700, true) && !is_dir($dir)) {
                if ($throwOnFailure) {
                    throw new ApiException('監査ログ保存先を作成できません', 503);
                }
                return false;
            }
        }

        $lockFile = $dir . DIRECTORY_SEPARATOR . self::LOCK_FILE;
        $lockFp = @fopen($lockFile, 'c+');
        if ($lockFp === false) {
            if ($throwOnFailure) {
                throw new ApiException('監査ログの排他制御ファイルを開けません', 503);
            }
            return false;
        }

        if (!@flock($lockFp, LOCK_EX | ($securityReason !== null ? LOCK_NB : 0))) {
            fclose($lockFp);
            if ($throwOnFailure) {
                throw new ApiException('監査ログの排他制御ロックを取得できません', 503);
            }
            return false;
        }

        try {
            $securityAllowed = true;
            if ($securityReason !== null) {
                $securityAllowed = self::consumeSecurityQuota($dir, $securityReason);
                if ($securityAllowed === null) {
                    return false;
                }
                if (!$securityAllowed) {
                    $entry['event'] = 'audit.security_suppressed';
                    $entry['outcome'] = 'failure';
                    $entry['actor_user_id'] = null;
                    $entry['http_status'] = null;
                    $entry['codes'] = [$securityReason, 'rate_limited'];
                }
            }
            self::pruneExpiredFiles($dir);

            $line = json_encode($entry, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
            if (!is_string($line)) {
                if ($throwOnFailure) {
                    throw new ApiException('監査ログのJSON変換に失敗しました', 503);
                }
                return false;
            }
            $line .= "\n";
            $lineBytes = strlen($line);

            $existingFiles = self::listAuditFiles($dir, $throwOnFailure);
            if ($existingFiles === null) {
                return false;
            }
            $totalBytes = 0;
            foreach ($existingFiles as $fileInfo) {
                $totalBytes += $fileInfo['size'];
            }

            $pending = ($reserveHeadroom || $securityReason !== null)
                ? self::activeReservations($dir)
                : 0;
            $requiredBytes = $lineBytes
                + (($pending + ($reserveHeadroom ? 1 : 0)) * self::RESERVED_TERMINAL_BYTES)
                + ($securityReason !== null ? self::SECURITY_BUSINESS_HEADROOM_BYTES : 0);
            if ($totalBytes + $requiredBytes > self::MAX_TOTAL_BYTES) {
                if ($securityReason === null) {
                    error_log('[AuditLog] Audit log directory exceeded total capacity limit of 256MiB');
                }
                if ($throwOnFailure) {
                    throw new ApiException('監査ログの容量上限を超過しました', 503);
                }
                return false;
            }

            if ($reserveHeadroom) {
                self::reserve($dir);
            }
            $todayUtc = (new DateTimeImmutable('now', new DateTimeZone('UTC')))->format('Ymd');
            $targetFilename = self::determineTargetFile($existingFiles, $todayUtc, $lineBytes);
            $targetFilePath = $dir . DIRECTORY_SEPARATOR . $targetFilename;

            $logFp = @fopen($targetFilePath, 'cb');
            if ($logFp === false) {
                if ($throwOnFailure) {
                    throw new ApiException('監査ログファイルを開けません', 503);
                }
                return false;
            }

            try {
                if (fseek($logFp, 0, SEEK_END) !== 0) {
                    if ($throwOnFailure) {
                        throw new ApiException('監査ログの終端シークに失敗しました', 503);
                    }
                    return false;
                }

                $startPos = ftell($logFp);
                if ($startPos === false) {
                    if ($throwOnFailure) {
                        throw new ApiException('監査ログの位置取得に失敗しました', 503);
                    }
                    return false;
                }

                $written = fwrite($logFp, $line);
                $flushed = fflush($logFp);

                if ($written !== $lineBytes || !$flushed) {
                    ftruncate($logFp, $startPos);
                    if ($securityReason === null) {
                        error_log(sprintf(
                            '[AuditLog] Incomplete audit write truncated: expected=%d written=%d',
                            $lineBytes,
                            (int)$written
                        ));
                    }
                    if ($throwOnFailure) {
                        throw new ApiException('監査ログの書き込みに失敗しました', 503);
                    }
                    return false;
                }

                return $securityAllowed;
            } finally {
                fclose($logFp);
            }
        } finally {
            @flock($lockFp, LOCK_UN);
            fclose($lockFp);
        }
    }

    private static function determineTargetFile(
        array $existingFiles,
        string $todayUtc,
        int $lineBytes
    ): string {
        $todayFiles = [];
        foreach ($existingFiles as $file) {
            if ($file['date'] === $todayUtc) {
                $todayFiles[] = $file;
            }
        }

        if ($todayFiles === []) {
            return sprintf('audit-%s-001.log', $todayUtc);
        }

        usort($todayFiles, static function (array $a, array $b): int {
            return $a['seq'] <=> $b['seq'];
        });

        $lastFile = end($todayFiles);
        if ($lastFile['size'] + $lineBytes > self::MAX_FILE_BYTES) {
            $nextSeq = $lastFile['seq'] + 1;
            return sprintf('audit-%s-%03d.log', $todayUtc, $nextSeq);
        }

        return (string)$lastFile['filename'];
    }

    private static function pruneExpiredFiles(string $dir, bool $strict = false): void
    {
        $today = new DateTimeImmutable('today', new DateTimeZone('UTC'));
        $cutoffDate = $today->sub(new DateInterval('P' . self::RETENTION_DAYS . 'D'));

        $items = @scandir($dir);
        if ($items === false) {
            if ($strict) {
                throw new \RuntimeException('監査ログの一覧を取得できません: ' . $dir);
            }
            return;
        }

        foreach ($items as $item) {
            if ($item === '.' || $item === '..' || $item === self::LOCK_FILE) {
                continue;
            }

            if (preg_match(self::FILENAME_PATTERN, $item, $m) === 1) {
                $year = (int)$m[1];
                $month = (int)$m[2];
                $day = (int)$m[3];

                if (!checkdate($month, $day, $year)) {
                    continue;
                }

                $fileDate = DateTimeImmutable::createFromFormat(
                    '!Ymd',
                    sprintf('%04d%02d%02d', $year, $month, $day),
                    new DateTimeZone('UTC')
                );

                if ($fileDate instanceof DateTimeImmutable && $fileDate < $cutoffDate) {
                    if (!@unlink($dir . DIRECTORY_SEPARATOR . $item) && $strict) {
                        throw new \RuntimeException('期限切れ監査ログを削除できません: ' . $item);
                    }
                }
            }
        }
    }

    private static function listAuditFiles(string $dir, bool $throwOnFailure): ?array
    {
        $files = [];
        $items = @scandir($dir);
        if ($items === false) {
            if ($throwOnFailure) {
                throw new ApiException('監査ログの一覧を取得できません', 503);
            }
            return null;
        }

        foreach ($items as $item) {
            if (preg_match(self::FILENAME_PATTERN, $item, $m) === 1) {
                $path = $dir . DIRECTORY_SEPARATOR . $item;
                if (is_file($path)) {
                    clearstatcache(true, $path);
                    $size = @filesize($path);
                    if ($size === false) {
                        if ($throwOnFailure) {
                            throw new ApiException('監査ログのサイズを取得できません', 503);
                        }
                        return null;
                    }
                    $files[] = [
                        'filename' => $item,
                        'date' => $m[1] . $m[2] . $m[3],
                        'seq' => (int)$m[4],
                        'size' => $size,
                    ];
                }
            }
        }

        return $files;
    }

    private static function formatTimestamp(): string
    {
        return (new DateTimeImmutable('now', new DateTimeZone('UTC')))
            ->format('Y-m-d\TH:i:s\Z');
    }

    private static function getRevision(?PDO $db): ?int
    {
        if ($db === null) {
            return null;
        }

        try {
            $repo = new AppMetaRepository($db);
            return $repo->getDataRevision();
        } catch (Throwable $e) {
            return null;
        }
    }

    private static function sanitizeCounts(?array $counts): ?array
    {
        if (!is_array($counts)) {
            return null;
        }

        $sanitized = [];
        foreach (self::ALLOWED_COUNTS_KEYS as $key) {
            if (isset($counts[$key])) {
                if (is_int($counts[$key])) {
                    $sanitized[$key] = $counts[$key];
                } elseif (is_numeric($counts[$key])) {
                    $sanitized[$key] = (int)$counts[$key];
                }
            }
        }

        return $sanitized === [] ? null : $sanitized;
    }

    private static function isValidUsernameFormat(string $username): bool
    {
        if (function_exists('validateUsername')) {
            return validateUsername($username) === null;
        }

        return preg_match('/\A[A-Za-z0-9_.-]{3,50}\z/', $username) === 1;
    }
}
