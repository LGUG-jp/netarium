<?php
declare(strict_types=1);

namespace Netarium\Services\Quality;

use Netarium\Core\ApiException;
use Netarium\Core\ResourceId;
use PDO;
use Throwable;

final class QualityNotApplicable
{
    private const RECOMMENDABLE_FIELDS = [
        'floor_id', 'location', 'manufacturer', 'model', 'asset_number', 'serial_number', 'mac_address', 'memo',
    ];
    public const DEVICE_FIELDS = ['ip', ...self::RECOMMENDABLE_FIELDS, 'maintenance_expiry'];
    public const LINK_FIELDS = ['from_port', 'to_port'];

    public function __construct(private PDO $db)
    {
    }

    public static function recommendedDeviceFields(array $config): array
    {
        $configured = $config['quality_recommended_device_fields'] ?? [];
        if (!is_array($configured)) {
            return [];
        }
        $fields = array_filter($configured, static fn($field): bool => in_array($field, self::RECOMMENDABLE_FIELDS, true));
        return array_values(array_unique($fields));
    }

    public static function isMissing(array $row, string $field): bool
    {
        if (in_array($field, self::LINK_FIELDS, true)) {
            return ($row[$field . '_id'] ?? null) === null;
        }
        if ($field === 'floor_id') {
            return ($row[$field] ?? null) === null;
        }
        return trim((string)($row[$field] ?? '')) === '';
    }

    public function set(array $input, array $config): array
    {
        $field = $input['field'] ?? null;
        $code = $input['code'] ?? null;
        $notApplicable = $input['not_applicable'] ?? null;
        $isLink = $code === 'link_ports_missing';
        $allowed = match ($code) {
            'monitoring_not_applicable' => $field === 'ip',
            'maintenance_expiry_missing' => $field === 'maintenance_expiry',
            'missing_recommended_fields' => in_array($field, self::recommendedDeviceFields($config), true),
            'link_ports_missing' => in_array($field, self::LINK_FIELDS, true),
            default => false,
        };
        if (!$allowed || !is_bool($notApplicable) || (!$isLink && isset($input['link_id']))) {
            throw new ApiException('設定不要を変更できる診断項目を指定してください', 400);
        }

        $deviceId = ResourceId::parse($input['device_id'] ?? null, 'device_id');
        $linkId = $isLink ? ResourceId::parse($input['link_id'] ?? null, 'link_id') : null;
        $expectedRevision = $input['expected_revision'] ?? null;
        if (!is_int($expectedRevision) || $expectedRevision <= 0 || $expectedRevision > ResourceId::MAX) {
            throw new ApiException('expected_revisionを整数で指定してください', 400);
        }
        $this->db->beginTransaction();
        try {
            // 検証前に書き込みロックを取得し、構成の保存世代は進めない。
            $this->db->exec("UPDATE app_meta SET meta_value = meta_value WHERE meta_key = 'data_revision'");
            if ($isLink) {
                $side = $field === 'from_port' ? 'from' : 'to';
                $stmt = $this->db->prepare("SELECT l.{$field}_id, l.resource_revision FROM links l
                    JOIN devices d ON d.id = l.{$side}_id WHERE l.id = ? AND d.id = ?");
                $stmt->execute([$linkId, $deviceId]);
            } else {
                $stmt = $this->db->prepare("SELECT {$field}, resource_revision FROM devices WHERE id = ?");
                $stmt->execute([$deviceId]);
            }
            $target = $stmt->fetch(PDO::FETCH_ASSOC);
            if ($target === false || (int)$target['resource_revision'] !== $expectedRevision
                || ($notApplicable && !self::isMissing($target, $field))) {
                throw new ApiException('対象の項目が更新または削除されました。再診断してください', 409);
            }

            $stmt = $this->db->prepare($notApplicable
                ? 'INSERT INTO quality_not_applicable (device_id, link_id, field) VALUES (?, ?, ?) ON CONFLICT DO NOTHING'
                : 'DELETE FROM quality_not_applicable WHERE device_id = ? AND link_id IS ? AND field = ?');
            $stmt->execute([$deviceId, $linkId, $field]);
            $result = [
                'ok' => true,
                'device_id' => $deviceId,
                'link_id' => $linkId,
                'field' => $field,
                'not_applicable' => $notApplicable,
                'unchanged' => $stmt->rowCount() === 0,
            ];
            if ($result['unchanged']) {
                $this->db->rollBack();
            } else {
                $this->db->commit();
            }
            return $result;
        } catch (Throwable $e) {
            if ($this->db->inTransaction()) { $this->db->rollBack(); }
            throw $e;
        }
    }
}
