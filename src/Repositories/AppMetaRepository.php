<?php
declare(strict_types=1);

namespace Netarium\Repositories;

use PDO;
use Netarium\Core\ApiException;

class AppMetaRepository
{
    private PDO $db;

    public function __construct(PDO $db)
    {
        $this->db = $db;
    }

    public function get(string $key, string $default = ''): string
    {
        $stmt = $this->db->prepare("
            SELECT meta_value
            FROM app_meta
            WHERE meta_key = :meta_key
        ");

        $stmt->execute([
            ':meta_key' => $key,
        ]);

        $value = $stmt->fetchColumn();

        return $value === false ? $default : (string)$value;
    }

    public function set(string $key, string $value): void
    {
        $stmt = $this->db->prepare("
            INSERT INTO app_meta (
                meta_key,
                meta_value
            ) VALUES (
                :meta_key,
                :meta_value
            )
            ON CONFLICT(meta_key)
            DO UPDATE SET
                meta_value = excluded.meta_value
        ");

        $stmt->execute([
            ':meta_key' => $key,
            ':meta_value' => $value,
        ]);
    }

    public function getDataRevision(): int
    {
        return max(1, (int)$this->get('data_revision', '1'));
    }

    public function getMonitorRevision(): int
    {
        return max(1, (int)$this->get('monitor_revision', '1'));
    }

    public function incrementMonitorRevision(): int
    {
        $this->db->exec("
            INSERT INTO app_meta (
                meta_key,
                meta_value
            ) VALUES (
                'monitor_revision',
                '2'
            )
            ON CONFLICT(meta_key)
            DO UPDATE SET
                meta_value =
                    CAST(app_meta.meta_value AS INTEGER) + 1
        ");

        return $this->getMonitorRevision();
    }

    public function requireMatchingDataRevision(int $requestedRevision): int
    {
        if ($requestedRevision <= 0) {
            throw new ApiException(
                'データリビジョンが指定されていません。画面を再読み込みしてください',
                400
            );
        }

        $currentRevision = $this->getDataRevision();

        if ($requestedRevision !== $currentRevision) {
            throw new ApiException(
                '他の利用者または別画面でデータが更新されています。再読み込みしてください',
                409
            );
        }

        return $currentRevision;
    }

    public function claimDataRevision(int $requestedRevision): int
    {
        $newRevision = $requestedRevision + 1;

        $stmt = $this->db->prepare("
            UPDATE app_meta
            SET meta_value = :new_revision
            WHERE meta_key = 'data_revision'
            AND meta_value = :requested_revision
        ");

        $stmt->execute([
            ':new_revision' => (string)$newRevision,
            ':requested_revision' => (string)$requestedRevision,
        ]);

        if ($stmt->rowCount() !== 1) {
            throw new ApiException(
                '他の利用者または別画面でデータが更新されています。再読み込みしてください',
                409
            );
        }

        return $newRevision;
    }

    public function getResourceRevision(string $table, int $id): int
    {
        if (!in_array($table, ['devices', 'views'], true)) {
            throw new \InvalidArgumentException('不正なリソース種別です');
        }
        $stmt = $this->db->prepare("SELECT resource_revision FROM {$table} WHERE id = :id");
        $stmt->execute([':id' => $id]);
        return (int)$stmt->fetchColumn();
    }

    public function requireMatchingResourceRevision(string $table, int $id, int $expectedRevision): void
    {
        if ($expectedRevision <= 0) {
            throw new ApiException('リソースリビジョンが指定されていません。再読み込みしてください', 400);
        }
        if ($this->getResourceRevision($table, $id) !== $expectedRevision) {
            $label = $table === 'views' ? 'ビュー' : '機器';
            throw new ApiException("{$label}ID {$id} は他の利用者または別画面で更新・削除されています。再読み込みしてください", 409);
        }
    }

    public function claimResourceRevision(string $table, int $id, int $expectedRevision): int
    {
        $this->db->exec("UPDATE resource_sequences SET value = value WHERE name = 'revision'");
        $this->requireMatchingResourceRevision($table, $id, $expectedRevision);
        $this->db->exec("UPDATE app_meta SET meta_value = CAST(meta_value AS INTEGER) + 1 WHERE meta_key = 'data_revision'");
        return $this->getDataRevision();
    }
}
