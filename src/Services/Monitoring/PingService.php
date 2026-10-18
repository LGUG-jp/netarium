<?php
declare(strict_types=1);

namespace Netarium\Services\Monitoring;

use PDO;
use PDOException;
use RuntimeException;
use Throwable;
use Netarium\Core\ApiException;
use Netarium\Core\Database;
use Netarium\Core\Request;
use Netarium\Repositories\AppMetaRepository;
use Netarium\Repositories\DeviceRepository;

class PingService
{
    private PDO $db;
    private AppMetaRepository $appMetaRepo;
    private DeviceRepository $deviceRepo;

    public function __construct(PDO $db)
    {
        $this->db = $db;
        $this->appMetaRepo = new AppMetaRepository($db);
        $this->deviceRepo = new DeviceRepository($db);
    }

    /**
     * Windows Ping実行
     */
    public function pingHostWindows(
        string $ip,
        int $timeoutMs,
        bool $restrictPrivateOnly
    ): array {
        if ($ip === '') {
            return [
                'status' => 'unknown',
                'outcome' => 'skipped',
                'response_ms' => null,
                'error' => 'IPアドレスが未設定です',
            ];
        }

        if (!filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4)) {
            return [
                'status' => 'unknown',
                'outcome' => 'skipped',
                'response_ms' => null,
                'error' => 'IPアドレスの形式が不正です',
            ];
        }

        if ($restrictPrivateOnly && !Request::isPrivateIpv4($ip)) {
            return [
                'status' => 'unknown',
                'outcome' => 'skipped',
                'response_ms' => null,
                'error' => '許可されていないIPアドレスです',
            ];
        }

        $timeoutMs = max(100, min($timeoutMs, 10000));

        /*
         * $ipは上でIPv4検証済みなので、そのまま渡してよい。
         * Windowsではescapeshellarg()が単一引用符を付け、
         * pingがIPアドレスとして解釈できない場合がある。
         */
        $command = sprintf(
            'ping.exe -4 -n 1 -w %d %s 2>&1',
            $timeoutMs,
            $ip
        );

        $output = [];
        $returnCode = 1;

        exec($command, $output, $returnCode);

        $rawText = implode("\n", $output);
        $text = $this->convertWindowsCommandOutputToUtf8($rawText);

        return $this->parseWindowsPingOutput($text, $returnCode);
    }

    public function parseWindowsPingOutput(string $text, int $returnCode): array
    {

        /*
         * 成功応答では日本語版・英語版とも通常TTLが含まれる。
         * 大文字小文字と空白の差を許容する。
         */
        $hasTtl = preg_match('/TTL\s*[=:]\s*\d+/i', $text) === 1;

        /*
         * 宛先到達不能の場合、ルータ等の応答にTTLが含まれることがあるため、
         * 既知の失敗メッセージも確認する。
         */
        $failurePatterns = [
            '/Request\s+timed\s+out/i',
            '/Destination\s+(host|net|network)\s+unreachable/i',
            '/General\s+failure/i',
            '/could\s+not\s+find\s+host/i',
            '/transmit\s+failed/i',
            '/要求がタイムアウト/u',
            '/宛先ホストに到達できません/u',
            '/宛先ネットワークに到達できません/u',
            '/一般エラー/u',
            '/ホストが見つかりません/u',
            '/転送に失敗/u',
        ];

        $hasFailureMessage = false;

        foreach ($failurePatterns as $pattern) {
            if (preg_match($pattern, $text) === 1) {
                $hasFailureMessage = true;
                break;
            }
        }

        if ($hasTtl && !$hasFailureMessage) {
            return [
                'status' => 'green',
                'outcome' => 'success',
                'response_ms' => $this->extractResponseMsFlexible($text),
                'error' => null,
            ];
        }

        /*
         * 一部環境でTTLが取得できなくても、終了コード0かつ
         * 明確な失敗メッセージがなければ成功として扱う。
         */
        if ($returnCode === 0 && !$hasFailureMessage) {
            return [
                'status' => 'green',
                'outcome' => 'success',
                'response_ms' => $this->extractResponseMsFlexible($text),
                'error' => null,
            ];
        }

        return [
            'status' => 'red',
            'outcome' => preg_match('/Request\s+timed\s+out|要求がタイムアウト/iu', $text) === 1
                ? 'timeout'
                : 'failure',
            'response_ms' => null,
            'error' => $this->buildPingErrorMessage($text, $returnCode),
        ];
    }

    /**
     * Windows Ping出力から応答時間を取得
     */
    public function extractResponseMsFlexible(string $text): ?int
    {
        $patterns = [
            // time=1ms / time<1ms
            '/time\s*[=<]\s*(\d+)\s*ms/i',

            // 日本語版: 時間 = 1ms / 時間 < 1ms
            '/時間\s*[=<]\s*(\d+)\s*ms/u',

            // 念のため「1ms」の単純形式
            '/(?:^|\s)(\d+)\s*ms(?:\s|$)/i',
        ];

        foreach ($patterns as $pattern) {
            if (preg_match($pattern, $text, $matches) === 1) {
                $milliseconds = (int)$matches[1];

                /*
                 * time<1msは整数DBで扱うため、
                 * 1msとして記録する。
                 */
                return max(1, $milliseconds);
            }
        }

        return null;
    }

    public function convertWindowsCommandOutputToUtf8(string $text): string
    {
        if ($text === '') {
            return '';
        }

        /*
         * Windows日本語環境のコマンド出力は、
         * 通常CP932またはSJIS-win。
         */
        if (function_exists('mb_convert_encoding')) {
            return mb_convert_encoding(
                $text,
                'UTF-8',
                'CP932,SJIS-win,SJIS,UTF-8'
            );
        }

        if (function_exists('iconv')) {
            $converted = @iconv(
                'CP932',
                'UTF-8//IGNORE',
                $text
            );

            if ($converted !== false) {
                return $converted;
            }
        }

        return $text;
    }

    public function buildPingErrorMessage(string $text, int $returnCode): string
    {
        $text = trim($text);

        if ($text === '') {
            return 'Pingの出力がありません。終了コード: ' . $returnCode;
        }

        // 統計行だけでは失敗理由が消えるため、応答中の理由を先に残す。
        $lines = preg_split('/\R/u', $text);
        $lines = array_values(array_filter(
            $lines ?: [],
            static function ($line): bool {
                return trim((string)$line) !== '';
            }
        ));

        $reasonLines = array_values(array_filter(
            $lines,
            static function ($line): bool {
                return preg_match(
                    '/timed\s+out|unreachable|failure|could\s+not\s+find\s+host|transmit\s+failed|タイムアウト|到達できません|一般エラー|ホストが見つかりません|転送に失敗/iu',
                    (string)$line
                ) === 1;
            }
        ));
        $summaryLines = array_values(array_unique(array_merge($reasonLines, array_slice($lines, -3))));
        $summary = implode(' / ', $summaryLines);

        if (function_exists('mb_substr')) {
            $summary = mb_substr($summary, 0, 300, 'UTF-8');
        } elseif (function_exists('iconv_substr') && ($iconv = @iconv_substr($summary, 0, 300, 'UTF-8')) !== false) {
            $summary = $iconv;
        } elseif (@preg_match('/^.{0,300}/us', $summary, $matches)) {
            $summary = $matches[0];
        } else {
            $summary = substr($summary, 0, 300);
        }

        return 'Ping失敗（終了コード: ' . $returnCode . '） ' . $summary;
    }

    public function normalizePingStatus(string $status): string
    {
        if (in_array($status, ['green', 'red', 'unknown'], true)) {
            return $status;
        }

        return 'unknown';
    }

    public function countPingStatuses(array $results, string $status): int
    {
        $count = 0;

        foreach ($results as $result) {
            if (($result['status'] ?? '') === $status) {
                $count++;
            }
        }

        return $count;
    }

    /**
     * Ping対象リストに対する一括Ping実行および監視状態更新
     */
    public function executePing(
        array $targets,
        int $requestedDataRevision,
        array $config
    ): array {
        $startTime = hrtime(true);
        $maxDurationMs = max(
            1,
            (int)($config['ping_max_duration_ms'] ?? 120000)
        );
        $maxDurationNs = $maxDurationMs * 1_000_000;

        $maxPingTargets = max(
            1,
            (int)($config['max_ping_targets'] ?? 100)
        );

        if (count($targets) > $maxPingTargets) {
            throw new ApiException(
                "Ping対象は1回につき最大{$maxPingTargets}件です",
                400
            );
        }

        /*
         * Ping実行前に、リクエスト全体を検証する。
         */
        $normalizedTargets = [];
        $usedTargetIds = [];

        foreach ($targets as $index => $target) {
            if (!is_array($target)) {
                throw new ApiException(
                    'Ping対象' . ($index + 1) . '件目の形式が不正です',
                    400
                );
            }

            $id = (int)($target['id'] ?? 0);

            if ($id <= 0) {
                throw new ApiException(
                    'Ping対象' . ($index + 1) . '件目の機器IDが不正です',
                    400
                );
            }

            if (isset($usedTargetIds[$id])) {
                throw new ApiException(
                    "Ping対象の機器ID {$id} が重複しています",
                    400
                );
            }

            $usedTargetIds[$id] = true;

            $normalizedTargets[] = [
                'id' => $id,
                'requested_ip' => trim((string)($target['ip'] ?? '')),
            ];
        }

        if (
            $this->appMetaRepo->getDataRevision() !==
            $requestedDataRevision
        ) {
            throw new ApiException(
                'データが更新されています。画面を再読み込みしてください',
                409
            );
        }

        if ($normalizedTargets === []) {
            $lastMonitoredAt = $this->appMetaRepo->get('last_monitored_at', '');

            return [
                'ok' => true,
                'results' => [],
                'summary' => [
                    'total' => 0,
                    'green' => 0,
                    'red' => 0,
                    'unknown' => 0,
                    'success' => 0,
                    'failure' => 0,
                    'timeout' => 0,
                    'skipped' => 0,
                ],
                'monitor_revision' => $this->appMetaRepo->getMonitorRevision(),
                'last_monitored_at' => $lastMonitoredAt !== '' ? $lastMonitoredAt : null,
            ];
        }

        /*
         * Ping自体はトランザクション外で実行する。
         * 長時間DBをロックしないため。
         */
        $results = [];

        foreach ($normalizedTargets as $target) {
            $id = $target['id'];
            $requestedIp = $target['requested_ip'];
            $ip = '';

            try {
                $storedIp = $this->deviceRepo->getIpById($id);

                $ip = $storedIp ?? '';

                if ((hrtime(true) - $startTime) > $maxDurationNs) {
                    $pingResult = [
                        'status' => 'unknown',
                        'outcome' => 'skipped',
                        'response_ms' => null,
                        'error' => 'Ping全体の実行時間が上限を超えたため、実行していません',
                    ];
                } else {
                    if ($storedIp === null) {
                        throw new RuntimeException('対象機器が存在しません');
                    }
                    if ($requestedIp !== '' && $requestedIp !== $ip) {
                        throw new RuntimeException('機器情報が更新されています。画面を再読み込みしてください');
                    }
                    $pingResult = $this->pingHostWindows(
                        $ip,
                        (int)($config['ping_timeout_ms'] ?? 1000),
                        (bool)($config['restrict_private_ip_only'] ?? true)
                    );
                }
            } catch (Throwable $e) {
                $pingResult = [
                    'status' => 'red',
                    'outcome' => 'failure',
                    'response_ms' => null,
                    'error' => 'Ping処理エラー: ' . $e->getMessage(),
                ];
            }

            $results[] = [
                'id' => $id,
                'ip' => $ip,
                'status' => $this->normalizePingStatus((string)($pingResult['status'] ?? 'unknown')),
                'outcome' => $pingResult['outcome'],
                'checked_at' => date('Y-m-d H:i:s'),
                'response_ms' => Request::normalizeNullableInt($pingResult['response_ms'] ?? null),
                'error' => Request::normalizeNullableString($pingResult['error'] ?? null),
            ];
        }

        /*
         * Ping完了後、結果のDB反映だけを
         * 短いトランザクションで処理する。
         */
        $newMonitorRevision = $this->appMetaRepo->getMonitorRevision();
        $monitoredAt = $this->appMetaRepo->get('last_monitored_at', '');

        $this->db->beginTransaction();

        try {
            if (
                $this->appMetaRepo->getDataRevision() !==
                $requestedDataRevision
            ) {
                throw new ApiException(
                    'Ping実行中に構成が更新されました。画面を再読み込みしてください',
                    409
                );
            }

            $updatedDeviceCount = $this->deviceRepo->updateMonitorStatuses($results);

            if ($updatedDeviceCount > 0) {
                $newMonitorRevision = $this->appMetaRepo->incrementMonitorRevision();
                $monitoredAt = date(DATE_ATOM);
                $this->appMetaRepo->set('last_monitored_at', $monitoredAt);
            }

            $this->db->commit();
        } catch (Throwable $e) {
            if ($this->db->inTransaction()) {
                $this->db->rollBack();
            }

            if ($e instanceof PDOException && Database::isBusy($e)) {
                throw new ApiException(
                    '現在、別の更新処理が実行されています。少し待ってから再度Pingしてください',
                    409
                );
            }

            throw $e;
        }

        $outcomeCounts = array_count_values(array_column($results, 'outcome'));

        return [
            'ok' => true,
            'results' => $results,
            'summary' => [
                'total' => count($results),
                'green' => $this->countPingStatuses($results, 'green'),
                'red' => $this->countPingStatuses($results, 'red'),
                'unknown' => $this->countPingStatuses($results, 'unknown'),
                'success' => $outcomeCounts['success'] ?? 0,
                'failure' => $outcomeCounts['failure'] ?? 0,
                'timeout' => $outcomeCounts['timeout'] ?? 0,
                'skipped' => $outcomeCounts['skipped'] ?? 0,
            ],
            'monitor_revision' => $newMonitorRevision,
            'last_monitored_at' => $monitoredAt !== '' ? $monitoredAt : null,
        ];
    }
}
