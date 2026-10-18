<?php
declare(strict_types=1);

namespace Netarium\Services\Topology;

use PDO;
use Throwable;
use Netarium\Core\ApiException;
use Netarium\Core\Database;
use Netarium\Core\ResourceId;

final class LinkSystemService
{
    public const COLOR_KEYS = ['indigo', 'teal', 'violet', 'cyan', 'slate', 'brown', 'magenta', 'olive'];

    public function __construct(private PDO $db)
    {
    }

    public function list(): array
    {
        return ['ok' => true, 'link_systems' => $this->db->query('SELECT s.id, s.name, s.color_key, s.resource_revision,
            COUNT(l.id) AS usage_count FROM link_systems s LEFT JOIN links l ON l.system_id = s.id
            GROUP BY s.id ORDER BY s.id')->fetchAll(PDO::FETCH_ASSOC)];
    }

    public static function positiveInteger(mixed $value, string $field): int
    {
        if (!is_int($value) || $value <= 0) {
            throw new ApiException("{$field}は正の整数で指定してください", 400);
        }
        return $value;
    }

    public static function normalizeFields(array $input): array
    {
        $name = $input['name'] ?? null;
        if (!is_string($name) || preg_match('//u', $name) !== 1) {
            throw new ApiException('接続系統名は文字列で指定してください', 400);
        }
        $name = preg_replace('/\A\s+|\s+\z/u', '', $name);
        $length = preg_match_all('/./us', $name);
        if ($length < 1 || $length > 100) {
            throw new ApiException('接続系統名は1〜100文字で指定してください', 400);
        }
        $colorKey = $input['color_key'] ?? null;
        if (!is_string($colorKey) || !in_array($colorKey, self::COLOR_KEYS, true)) {
            throw new ApiException('接続系統の色が不正です', 400);
        }
        return ['name' => $name, 'color_key' => $colorKey];
    }

    public static function normalizeSystemId(mixed $value, array $systems): ?int
    {
        if ($value === null) {
            return null;
        }
        $id = ResourceId::parse(self::positiveInteger($value, 'system_id'), 'system_id');
        if (!isset($systems[$id])) {
            throw new ApiException('接続系統が存在しません', 400);
        }
        return $id;
    }

    public function mutate(string $operation, array $input): array
    {
        $fields = $operation === 'delete' ? [] : self::normalizeFields($input);
        $id = $operation === 'create' ? null : ResourceId::parse(self::positiveInteger($input['id'] ?? null, 'id'), 'id');
        $expected = $operation === 'create' ? null : self::positiveInteger($input['expected_revision'] ?? null, 'expected_revision');
        try {
            $this->db->beginTransaction();
            $this->db->exec("UPDATE resource_sequences SET value = value WHERE name = 'revision'");
            if ($operation !== 'create') {
                $stmt = $this->db->prepare('SELECT resource_revision FROM link_systems WHERE id = :id');
                $stmt->execute([':id' => $id]);
                if ((int)$stmt->fetchColumn() !== $expected) {
                    throw new ApiException('接続系統が他の利用者または別画面で更新・削除されています。再読み込みしてください', 409);
                }
            }
            if ($operation === 'create') {
                $id = ResourceId::allocate($this->db, 'link_systems');
                $stmt = $this->db->prepare('INSERT INTO link_systems (id, name, color_key) VALUES (:id, :name, :color_key)');
                $stmt->execute(['id' => $id] + $fields);
            } elseif ($operation === 'update') {
                $stmt = $this->db->prepare('UPDATE link_systems SET name = :name, color_key = :color_key WHERE id = :id');
                $stmt->execute(['id' => $id] + $fields);
            } else {
                $stmt = $this->db->prepare('SELECT COUNT(*) FROM links WHERE system_id = :id');
                $stmt->execute([':id' => $id]);
                if ((int)$stmt->fetchColumn() > 0) {
                    throw new ApiException('使用中の接続系統は削除できません', 400);
                }
                $stmt = $this->db->prepare('DELETE FROM link_systems WHERE id = :id');
                $stmt->execute([':id' => $id]);
            }
            // 復元プレビュー後のマスタ変更も全体操作の既存世代で検出する。
            // 接続系統自身の世代と、各ビューの世代は引き続き独立する。
            $this->db->exec("UPDATE app_meta SET meta_value = CAST(meta_value AS INTEGER) + 1 WHERE meta_key = 'data_revision'");
            $result = $this->list();
            if ($operation === 'create') {
                $result['created_id'] = $id;
            }
            $result['revision'] = (int)$this->db->query("SELECT meta_value FROM app_meta WHERE meta_key = 'data_revision'")->fetchColumn();
            $this->db->commit();
            return $result;
        } catch (Throwable $e) {
            if ($this->db->inTransaction()) {
                $this->db->rollBack();
            }
            if ($e instanceof \PDOException && Database::isBusy($e)) {
                throw new ApiException('現在、別の更新処理が実行されています。少し待ってから再度実行してください', 503);
            }
            throw $e;
        }
    }
}
