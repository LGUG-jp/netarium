<?php
declare(strict_types=1);

namespace Netarium\Services\Topology;

use PDO;
use Throwable;
use Netarium\Core\ApiException;
use Netarium\Core\ResourceId;
use Netarium\Repositories\AppMetaRepository;

final class DeviceConfigService
{
    public const MAX_BYTES = 262144;
    public const MAX_VERSIONS = 5;
    public const DEFAULT_MAX_TOTAL_BYTES = 41943040; // 40 MiB

    public function __construct(private PDO $db, private array $config = []) {}

    private function maxTotalBytes(): int
    {
        return \Netarium\Services\Storage\CapacityService::limits($this->config)['device_configs']['max_total_bytes']
            ?? self::DEFAULT_MAX_TOTAL_BYTES;
    }

    public function load(array $input): array
    {
        $id = self::integer($input['device_id'] ?? null, 1);
        $this->db->beginTransaction();
        try {
            $result = $this->snapshot($id, $this->deviceRevision($id, false));
            $this->db->commit();
            return $result;
        } catch (Throwable $e) {
            if ($this->db->inTransaction()) { $this->db->rollBack(); }
            throw $e;
        }
    }

    public function mutate(string $action, array $input): array
    {
        $id = self::integer($input['device_id'] ?? null, 1);
        $expected = self::integer($input['expected_revision'] ?? null, 0);
        $expectedDevice = self::integer($input['expected_device_revision'] ?? null, 1);
        $content = $action === 'save_device_config' ? self::normalizeContent($input['content'] ?? null) : null;
        $memo = $action === 'save_device_config' ? self::text($input['memo'] ?? '', 200) : '';
        $ids = [];
        if ($action === 'delete_device_configs') {
            if (!is_array($input['ids'] ?? null) || !array_is_list($input['ids']) || count($input['ids']) < 1 || count($input['ids']) > self::MAX_VERSIONS) {
                throw new ApiException('削除するConfig履歴を1件以上選択してください', 400);
            }
            foreach ($input['ids'] as $value) {
                $value = self::integer($value, 1);
                if (isset($ids[$value])) { throw new ApiException('削除対象の指定が不正です', 400); }
                $ids[$value] = true;
            }
        } elseif ($action !== 'save_device_config') {
            throw new ApiException('不明なConfig操作です', 400);
        }
        $this->db->beginTransaction();
        try {
            // Take SQLite's writer lock before checking either revision.
            $this->db->exec("UPDATE resource_sequences SET value = value WHERE name = 'revision'");
            $deviceRevision = $this->deviceRevision($id, true);
            $before = $this->snapshot($id, $deviceRevision);
            if ($deviceRevision !== $expectedDevice || $before['revision'] !== $expected) { self::conflict(); }
            if ($action === 'save_device_config') {
                if (isset($before['items'][0]) && $before['items'][0]['content'] === $content) {
                    $before['unchanged'] = true;
                    $this->db->commit();
                    return $before;
                }
                $stmt = $this->db->prepare('SELECT next_generation FROM device_config_states WHERE device_id = ?');
                $stmt->execute([$id]);
                $next = $stmt->fetchColumn();
                $generation = $next === false ? 1 : (int)$next;
                $lastId = (int)$this->db->query("SELECT seq FROM sqlite_sequence WHERE name = 'device_configs'")->fetchColumn();
                if ($generation >= ResourceId::MAX || $expected >= ResourceId::MAX || $lastId >= ResourceId::MAX) { self::conflict(); }
                $created = gmdate('Y-m-d\TH:i:s\Z');
                if (isset($before['items'][0]) && $created < $before['items'][0]['created_at']) { $created = $before['items'][0]['created_at']; }
                $stmt = $this->db->prepare('INSERT INTO device_configs (device_id, generation, content, created_at, actor_user_id, actor_name, memo) VALUES (?, ?, ?, ?, ?, ?, ?)');
                $stmt->execute([$id, $generation, $content, $created, currentUserId() ?: null, currentUsername(), $memo]);
                $stmt = $this->db->prepare('INSERT INTO device_config_states (device_id, revision, next_generation) VALUES (?, ?, ?) ON CONFLICT(device_id) DO UPDATE SET revision = excluded.revision, next_generation = excluded.next_generation');
                $stmt->execute([$id, $expected + 1, $generation + 1]);
                $stmt = $this->db->prepare('DELETE FROM device_configs WHERE device_id = ? AND id NOT IN (SELECT id FROM device_configs WHERE device_id = ? ORDER BY created_at DESC, generation DESC LIMIT 5)');
                $stmt->execute([$id, $id]);
                $totalBytes = (int)$this->db->query('SELECT COALESCE(SUM(LENGTH(CAST(content AS BLOB))), 0) FROM device_configs')->fetchColumn();
                $maxTotal = $this->maxTotalBytes();
                if ($totalBytes > $maxTotal) {
                    $maxMiB = (int)ceil($maxTotal / (1024 * 1024));
                    throw new ApiException("Configのシステム保存容量（{$maxMiB}MiB）を超えるため登録できません。不要なConfig履歴を削除してください", 400);
                }
                $stmtName = $this->db->prepare('SELECT name FROM devices WHERE id = ?');
                $stmtName->execute([$id]);
                $deviceName = (string)($stmtName->fetchColumn() ?: '');
                $isFirst = !isset($before['items'][0]);
                $summary = $isFirst
                    ? "Configを新規登録（第{$generation}世代）"
                    : "Configを更新（第{$generation}世代）";
                $historyItems = [
                    [
                        'label' => 'Config世代',
                        'before' => $isFirst ? '—' : "第{$before['items'][0]['generation']}世代",
                        'after' => "第{$generation}世代",
                    ],
                ];
                (new ChangeHistoryService($this->db))->recordConfigChange($id, $deviceName, 'update', $summary, $historyItems);
            } else {
                $existing = array_fill_keys(array_column($before['items'], 'id'), true);
                foreach ($ids as $selected => $_) { if (!isset($existing[$selected])) { self::conflict(); } }
                if ($expected >= ResourceId::MAX) { self::conflict(); }
                $stmt = $this->db->prepare('DELETE FROM device_configs WHERE device_id = ? AND id IN (' . implode(',', array_fill(0, count($ids), '?')) . ')');
                $stmt->execute(array_merge([$id], array_keys($ids)));
                $stmt = $this->db->prepare('UPDATE device_config_states SET revision = revision + 1 WHERE device_id = ?');
                $stmt->execute([$id]);
                $stmtName = $this->db->prepare('SELECT name FROM devices WHERE id = ?');
                $stmtName->execute([$id]);
                $deviceName = (string)($stmtName->fetchColumn() ?: '');
                $deletedCount = count($ids);
                $isAllDeleted = $deletedCount === count($before['items']);
                $summary = $isAllDeleted
                    ? "Config履歴を全件削除（{$deletedCount}件）"
                    : "Config履歴を選択削除（{$deletedCount}件）";
                $historyItems = [
                    [
                        'label' => 'Config履歴削除',
                        'before' => "{$deletedCount}件",
                        'after' => '—（削除）',
                    ],
                ];
                (new ChangeHistoryService($this->db))->recordConfigChange($id, $deviceName, 'update', $summary, $historyItems);
            }
            $meta = new AppMetaRepository($this->db);
            $meta->claimDataRevision($meta->getDataRevision());
            $result = $this->snapshot($id, $deviceRevision);
            $this->db->commit();
            return $result;
        } catch (Throwable $e) {
            if ($this->db->inTransaction()) { $this->db->rollBack(); }
            throw $e;
        }
    }

    private function deviceRevision(int $id, bool $writing): int
    {
        $stmt = $this->db->prepare('SELECT resource_revision FROM devices WHERE id = ?');
        $stmt->execute([$id]);
        $revision = $stmt->fetchColumn();
        if ($revision === false) {
            if ($writing) { self::conflict(); }
            throw new ApiException('対象機器が見つかりません', 404);
        }
        return (int)$revision;
    }

    private function snapshot(int $id, int $deviceRevision): array
    {
        $stmt = $this->db->prepare('SELECT revision FROM device_config_states WHERE device_id = ?');
        $stmt->execute([$id]);
        $revision = (int)$stmt->fetchColumn();
        $stmt = $this->db->prepare('SELECT id, generation, content, created_at, actor_user_id, actor_name, memo FROM device_configs WHERE device_id = ? ORDER BY created_at DESC, generation DESC');
        $stmt->execute([$id]);
        $items = $stmt->fetchAll(PDO::FETCH_ASSOC);
        foreach ($items as &$item) {
            $item['id'] = (int)$item['id'];
            $item['generation'] = (int)$item['generation'];
            $item['actor_user_id'] = $item['actor_user_id'] === null ? null : (int)$item['actor_user_id'];
        }
        unset($item);
        return ['ok' => true, 'success' => true, 'device_id' => $id, 'device_revision' => $deviceRevision,
            'data_revision' => (new AppMetaRepository($this->db))->getDataRevision(), 'revision' => $revision, 'items' => $items];
    }

    public static function normalizeContent(mixed $content): string
    {
        if (!is_string($content) || preg_match('//u', $content) !== 1) { throw new ApiException('Config本文はUTF-8テキストで指定してください', 400); }
        if (str_starts_with($content, "\xEF\xBB\xBF")) { $content = substr($content, 3); }
        $content = str_replace(["\r\n", "\r"], "\n", $content);
        if (strlen($content) > self::MAX_BYTES) { throw new ApiException('Config本文は256 KiB以下にしてください', 400); }
        if (preg_match('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\x{0080}-\x{009F}]/u', $content) === 1) { throw new ApiException('Config本文にバイナリ制御文字は使用できません', 400); }
        if (preg_match('/[^\s\p{Z}]/u', $content) !== 1) { throw new ApiException('Config本文を入力してください', 400); }
        return $content;
    }

    private static function text(mixed $value, int $max): string
    {
        if (!is_string($value) || preg_match('//u', $value) !== 1 || preg_match('/[\x00-\x1F\x7F]/u', $value) === 1 || preg_match('/\A.{0,' . $max . '}\z/us', $value) !== 1) {
            throw new ApiException('Configメタ情報の形式または文字数が不正です', 400);
        }
        return $value;
    }

    private static function integer(mixed $value, int $min, int $max = ResourceId::MAX): int
    {
        if ((!is_int($value) && !(is_string($value) && preg_match('/\A(?:0|[1-9][0-9]*)\z/', $value) === 1)) || filter_var($value, FILTER_VALIDATE_INT) === false || (int)$value < $min || (int)$value > $max) {
            throw new ApiException('ConfigのIDまたはリビジョンが不正です', 400);
        }
        return (int)$value;
    }

    private static function conflict(): never
    {
        throw new ApiException('機器またはConfig履歴が更新・削除されています。再読み込みしてください', 409);
    }

    /** Validate both backup formats without exposing any row values in errors. */
    public static function validateBackupRows(array $configs, array $states, array $deviceIds, int $maxTotalBytes = self::DEFAULT_MAX_TOTAL_BYTES): array
    {
        try {
            if (!array_is_list($configs) || !array_is_list($states)) { throw new ApiException('invalid', 400); }
            $devices = [];
            foreach ($deviceIds as $id) { $devices[self::integer($id, 1)] = true; }
            $stateMap = [];
            $normalizedStates = [];
            foreach ($states as $row) {
                if (!is_array($row) || count($row) !== 3) { throw new ApiException('invalid', 400); }
                $id = self::integer($row['device_id'] ?? null, 1);
                if (!isset($devices[$id]) || isset($stateMap[$id])) { throw new ApiException('invalid', 400); }
                $state = ['device_id' => $id, 'revision' => self::integer($row['revision'] ?? null, 1, ResourceId::MAX_RESTORE),
                    'next_generation' => self::integer($row['next_generation'] ?? null, 1, ResourceId::MAX_RESTORE)];
                $stateMap[$id] = $state;
                $normalizedStates[] = $state;
            }
            $items = [];
            $seen = [];
            $byDevice = [];
            $totalBytes = 0;
            foreach ($configs as $row) {
                if (!is_array($row) || count($row) !== 8) { throw new ApiException('invalid', 400); }
                $id = self::integer($row['id'] ?? null, 1, ResourceId::MAX_RESTORE);
                $device = self::integer($row['device_id'] ?? null, 1);
                $generation = self::integer($row['generation'] ?? null, 1, ResourceId::MAX_RESTORE);
                if (isset($seen[$id]) || !isset($devices[$device], $stateMap[$device]) || $generation >= $stateMap[$device]['next_generation']) { throw new ApiException('invalid', 400); }
                $seen[$id] = true;
                $content = self::normalizeContent($row['content'] ?? null);
                if ($content !== $row['content']) { throw new ApiException('invalid', 400); }
                $totalBytes += strlen($content);
                $date = $row['created_at'] ?? null;
                if (!is_string($date)) { throw new ApiException('invalid', 400); }
                $parsed = \DateTimeImmutable::createFromFormat('!Y-m-d\TH:i:s\Z', $date, new \DateTimeZone('UTC'));
                if ($parsed === false || $parsed->format('Y-m-d\TH:i:s\Z') !== $date) { throw new ApiException('invalid', 400); }
                if (!array_key_exists('actor_user_id', $row)) { throw new ApiException('invalid', 400); }
                $item = ['id' => $id, 'device_id' => $device, 'generation' => $generation, 'content' => $content, 'created_at' => $date,
                    'actor_user_id' => $row['actor_user_id'] === null ? null : self::integer($row['actor_user_id'], 1),
                    'actor_name' => self::text($row['actor_name'] ?? null, 100), 'memo' => self::text($row['memo'] ?? null, 200)];
                $items[] = $item;
                $byDevice[$device][] = $item;
            }
            if ($totalBytes > $maxTotalBytes) { throw new ApiException('invalid', 400); }
            foreach ($byDevice as $rows) {
                if (count($rows) > self::MAX_VERSIONS) { throw new ApiException('invalid', 400); }
                usort($rows, static fn(array $a, array $b): int => $a['generation'] <=> $b['generation']);
                $previous = null;
                foreach ($rows as $row) {
                    if ($previous !== null && ($previous['generation'] >= $row['generation'] || $previous['id'] >= $row['id'] || $previous['created_at'] > $row['created_at'])) { throw new ApiException('invalid', 400); }
                    $previous = $row;
                }
            }
            return ['device_configs' => $items, 'device_config_states' => $normalizedStates];
        } catch (Throwable) {
            throw new ApiException('バックアップのConfig履歴または状態が不正です', 400);
        }
    }
}
