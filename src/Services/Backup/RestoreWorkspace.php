<?php
declare(strict_types=1);

namespace Netarium\Services\Backup;

use Netarium\Core\ApiException;
use Netarium\Core\OperationGate;

/** 復元領域の利用・回収・容量判定は、同じ排他ロックの保持中だけ行う。 */
final class RestoreWorkspace
{
    private OperationGate $gate;
    private string $root;
    private int $ttl;
    private array $limits;

    public function __construct(array $config)
    {
        $this->root = rtrim((string)$config['backup_restore_directory'], '\\/');
        $this->ttl = max(60, (int)($config['backup_restore_ttl_seconds'] ?? 600));
        $this->limits = array_replace([
            'max_count' => 8,
            'max_bytes' => 4 * 1024 * 1024 * 1024,
            'max_user_count' => 2,
            'max_user_bytes' => 1024 * 1024 * 1024,
        ], $config['backup_restore_workspace'] ?? []);
        foreach ($this->limits as $value) {
            if (!is_int($value) || $value <= 0) {
                throw new ApiException('復元作業領域の保持上限設定が不正です', 500);
            }
        }
        $this->gate = new OperationGate($this->root . DIRECTORY_SEPARATOR . '.workspace.lock');
        $this->gate->acquireExclusive('現在、復元プレビュー・復元・一時領域の清掃を実行中です。完了後に再度実行してください');
    }

    public function release(): void
    {
        $this->gate->release();
    }

    private function entries(): array
    {
        clearstatcache();
        $names = @scandir($this->root);
        if ($names === false) {
            throw new ApiException('復元作業領域を点検できません', 503);
        }
        return array_values(array_diff($names, ['.', '..', '.workspace.lock']));
    }

    private function metadata(string $directory): ?array
    {
        foreach (['workspace.json', 'preview.json'] as $name) {
            $path = $directory . DIRECTORY_SEPARATOR . $name;
            if (!is_file($path) || is_link($path)) {
                continue;
            }
            $json = @file_get_contents($path);
            $meta = is_string($json) ? json_decode($json, true) : null;
            if (is_array($meta) && is_int($meta['expires_at'] ?? null) &&
                is_string($meta['user_id'] ?? null) && $meta['user_id'] !== '') {
                return $meta;
            }
        }
        return null;
    }

    private function bytes(string $path): int
    {
        // 保存先のACL外へ追跡しない。計量不能時は新規受付を停止する。
        if (is_link($path)) {
            throw new ApiException('復元作業領域に計量できない項目があります。管理者に連絡してください', 503);
        }
        if (!is_dir($path)) {
            $size = @filesize($path);
            if ($size === false) {
                throw new ApiException('復元作業領域の容量を確認できません', 503);
            }
            return $size;
        }
        $names = @scandir($path);
        if ($names === false) {
            throw new ApiException('復元作業領域の容量を確認できません', 503);
        }
        $bytes = 0;
        foreach ($names as $name) {
            if ($name !== '.' && $name !== '..') {
                $bytes += $this->bytes($path . DIRECTORY_SEPARATOR . $name);
            }
        }
        return $bytes;
    }

    private function remove(string $path): bool
    {
        if (is_link($path) || !is_dir($path)) {
            return @unlink($path);
        }
        $names = @scandir($path);
        if ($names === false) {
            return false;
        }
        $success = true;
        foreach ($names as $name) {
            if ($name !== '.' && $name !== '..') {
                $success = $this->remove($path . DIRECTORY_SEPARATOR . $name) && $success;
            }
        }
        return $success && @rmdir($path);
    }

    public function cleanupExpired(): array
    {
        $now = time();
        $removed = 0;
        $failed = 0;
        foreach ($this->entries() as $name) {
            $path = $this->root . DIRECTORY_SEPARATOR . $name;
            if (preg_match('/\A[a-f0-9]{64}\z/', $name) !== 1 || is_link($path) || !is_dir($path)) {
                continue;
            }
            $meta = $this->metadata($path);
            $modified = @filemtime($path);
            if ($modified === false) {
                throw new ApiException('復元作業領域の期限を確認できません', 503);
            }
            $expiresAt = $meta['expires_at'] ?? ($modified + $this->ttl);
            if ($expiresAt < $now) {
                if ($this->remove($path)) {
                    $removed++;
                } else {
                    $failed++;
                }
            }
        }
        $usage = $this->usage('');
        return ['removed' => $removed, 'failed' => $failed, 'remaining' => $usage['count'], 'bytes' => $usage['bytes']];
    }

    private function usage(string $userId): array
    {
        $usage = ['count' => 0, 'bytes' => 0, 'user_count' => 0, 'user_bytes' => 0];
        foreach ($this->entries() as $name) {
            $path = $this->root . DIRECTORY_SEPARATOR . $name;
            $bytes = $this->bytes($path);
            $meta = is_dir($path) ? $this->metadata($path) : null;
            $usage['count']++;
            $usage['bytes'] += $bytes;
            // 所有者を確認できない残骸は、全利用者の枠でも数える。
            if ($meta === null || $meta['user_id'] === $userId) {
                $usage['user_count']++;
                $usage['user_bytes'] += $bytes;
            }
        }
        return $usage;
    }

    public function assertCanAdd(string $userId, int $additionalBytes, int $additionalCount = 1): void
    {
        $usage = $this->usage($userId);
        if ($additionalBytes < 0 || $additionalCount < 0) {
            throw new ApiException('復元作業領域の容量計算が不正です', 500);
        }
        foreach ([
            ['count', 'max_count', $additionalCount],
            ['bytes', 'max_bytes', $additionalBytes],
            ['user_count', 'max_user_count', $additionalCount],
            ['user_bytes', 'max_user_bytes', $additionalBytes],
        ] as [$field, $limit, $additional]) {
            if ($usage[$field] > $this->limits[$limit] || $additional > $this->limits[$limit] - $usage[$field]) {
                throw new ApiException('復元プレビューの保持件数または容量が上限を超えます。有効期限後に再度実行するか、管理者に連絡してください', 413);
            }
        }
    }
}
