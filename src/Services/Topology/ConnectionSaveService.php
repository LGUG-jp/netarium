<?php
declare(strict_types=1);

namespace Netarium\Services\Topology;

use Netarium\Core\ApiException;
use Netarium\Core\Database;
use Netarium\Core\ResourceId;
use Netarium\Repositories\AppMetaRepository;
use PDO;
use PDOException;
use Throwable;

final class ConnectionSaveService
{
    public function __construct(private PDO $db)
    {
    }

    public function save(array $input, array $config): array
    {
        $ports = self::operations($input['device_ports'] ?? [], 'port');
        $links = self::operations($input['links'] ?? [], 'link');
        $migrationLinkId = null;
        if (array_key_exists('complete_legacy_vlan', $input)) {
            $marker = $input['complete_legacy_vlan'];
            $migrationLinkId = ResourceId::parse(is_int($marker) ? $marker : null, 'complete_legacy_vlan');
            if (count($links) !== 1 || $links[0]['operation'] !== 'update' || $links[0]['id'] !== $migrationLinkId) {
                throw new ApiException('未移行VLANの再設定では対象の共通接続だけを更新してください', 400);
            }
            if (in_array('delete', array_column($ports, 'operation'), true)) {
                throw new ApiException('未移行VLANの再設定ではポートを削除できません', 400);
            }
        }
        if ($ports === [] && $links === []) {
            throw new ApiException('ポート・接続の変更が指定されていません', 400);
        }

        $maps = ['device_ports' => (object)[], 'links' => (object)[]];
        $changedPorts = $changedLinks = $deletedPorts = $deletedLinks = $devices = $oldPairs = [];
        try {
            $this->db->beginTransaction();
            // 版の確認、ポート占有の検査、採番を同じ writer ロックの下で行う。
            $this->db->exec("UPDATE app_meta SET meta_value = CAST(meta_value AS INTEGER) + 1 WHERE meta_key = 'data_revision'");
            $conflicts = [];
            foreach (['device_ports' => &$ports, 'links' => &$links] as $table => &$operations) {
                foreach ($operations as &$op) {
                    if ($op['operation'] === 'create') { continue; }
                    $op['before'] = $this->row($table, $op['id']);
                    $actual = $op['before']['resource_revision'] ?? null;
                    if ($actual !== $op['expected_revision']) {
                        $conflicts[] = ['resource' => $table, 'id' => $op['id'],
                            'expected_revision' => $op['expected_revision'], 'actual_revision' => $actual];
                    }
                }
                unset($op);
            }
            unset($operations);
            if ($conflicts !== []) {
                throw new ApiException('ポート・接続が他の利用者または別画面で更新・削除されています', 409, ['conflicts' => $conflicts]);
            }
            $counts = array_count_values(array_column($links, 'operation'));
            $netNew = ($counts['create'] ?? 0) - ($counts['delete'] ?? 0);
            if ($netNew > 0 && (int)$this->db->query('SELECT COUNT(*) FROM links')->fetchColumn() + $netNew >
                max(1, (int)($config['max_links'] ?? 50000))) {
                throw new ApiException('共通接続の登録上限を超えています', 400);
            }

            $touchedLinks = [];
            $findPortLinks = $this->db->prepare('SELECT id, from_id, to_id FROM links WHERE from_port_id = ? OR to_port_id = ?');
            foreach ($ports as $op) {
                $before = $op['before'] ?? null;
                $owner = ResourceId::parse($op['data']['device_id'] ?? $before['device_id'] ?? null, 'device_id');
                if ($before !== null && $owner !== (int)$before['device_id']) {
                    throw new ApiException('既存ポートの所属機器は変更できません', 400);
                }
                $devices[$owner] = true;
                if ($before !== null) {
                    $findPortLinks->execute([$op['id'], $op['id']]);
                    foreach ($findPortLinks->fetchAll(PDO::FETCH_ASSOC) as $link) {
                        $devices[(int)$link['from_id']] = $devices[(int)$link['to_id']] = true;
                    }
                }
                if ($op['operation'] === 'delete') { $deletedPorts[$op['id']] = true; }
            }
            foreach ($links as $op) {
                $before = $op['before'] ?? null;
                if ($before !== null) {
                    $from = (int)$before['from_id'];
                    $to = (int)$before['to_id'];
                    $devices[$from] = $devices[$to] = true;
                    $oldPairs[min($from, $to) . ':' . max($from, $to)] = [min($from, $to), max($from, $to)];
                    $touchedLinks[$op['id']] = true;
                }
                if ($op['operation'] !== 'delete') {
                    foreach (['from_id', 'to_id'] as $field) {
                        $devices[ResourceId::parse($op['data'][$field] ?? $before[$field] ?? null, $field)] = true;
                    }
                } else {
                    $deletedLinks[$op['id']] = true;
                }
            }
            $deviceIds = array_keys($devices);
            $history = new ChangeHistoryService($this->db);
            $snapshot = $history->captureSnapshot($deviceIds, []);
            $knownDevices = $this->rows('devices', $devices, 'id');
            if (count($knownDevices) !== count($devices)) {
                throw new ApiException('ポート・接続が参照する機器が存在しません', 400);
            }

            // 同一バッチ内でのポート削除＋同名作成やポート名入れ替えで一意制約と競合しないよう一時退避する。
            $stageName = $this->db->prepare('UPDATE device_ports SET name = ? WHERE id = ?');
            foreach ($ports as $op) {
                if ($op['operation'] !== 'create') {
                    $stageName->execute(["\x01p_{$op['id']}", $op['id']]);
                }
            }

            foreach ($ports as $op) {
                if ($op['operation'] === 'delete') { continue; }
                $before = $op['before'] ?? [];
                $device = ResourceId::parse($op['data']['device_id'] ?? $before['device_id'] ?? null, 'device_id');
                $name = self::portName($op['data']['name'] ?? $before['name'] ?? null);
                if ($name === '') { throw new ApiException('ポート名を入力してください', 400); }
                $memo = self::text($op['data']['memo'] ?? $before['memo'] ?? '', 'ポート備考', 1000);
                $vlan = $before['vlan'] ?? '';
                if (array_key_exists('vlan', $op['data'])) {
                    $vlan = self::portVlan($op['data']['vlan']);
                }
                $id = $this->storePort($before['id'] ?? null, $device, $name, $memo, $vlan);
                if ($op['operation'] === 'create' && $op['id'] !== null) { $maps['device_ports']->{$op['id']} = $id; }
                $changedPorts[$id] = true;
            }

            $plannedLinks = [];
            $reservedPorts = $reservedPairs = [];
            $findPair = $this->db->prepare('SELECT id FROM links WHERE min(from_id,to_id) = ? AND max(from_id,to_id) = ?
                AND from_port_id IS NULL AND to_port_id IS NULL');
            foreach ($links as $op) {
                if ($op['operation'] === 'delete') { continue; }
                $before = $op['before'] ?? [];
                $body = $op['data'];
                $from = ResourceId::parse($body['from_id'] ?? $before['from_id'] ?? null, 'from_id');
                $to = ResourceId::parse($body['to_id'] ?? $before['to_id'] ?? null, 'to_id');
                if ($from === $to) { throw new ApiException('同じ機器には接続できません', 400); }
                $system = array_key_exists('system_id', $body) ? $body['system_id'] : ($before['system_id'] ?? null);
                if ($system !== null) {
                    $system = ResourceId::parse(LinkSystemService::positiveInteger($system, 'system_id'), 'system_id');
                    if ($this->row('link_systems', $system) === null) {
                        throw new ApiException('接続系統が存在しません', 400);
                    }
                }
                $fromPort = $this->resolvePort($body, $before, 'from', $from, $changedPorts, $deletedPorts);
                $toPort = $this->resolvePort($body, $before, 'to', $to, $changedPorts, $deletedPorts);
                if ($migrationLinkId !== null) {
                    foreach ($changedPorts as $portId => $_) {
                        if ($portId !== $fromPort && $portId !== $toPort) {
                            throw new ApiException('未移行VLANの再設定では接続端点のポートだけを変更できます', 400);
                        }
                    }
                }
                $id = $before['id'] ?? ResourceId::allocate($this->db, 'links');
                foreach ([$fromPort, $toPort] as $portId) {
                    if ($portId === null) { continue; }
                    $usedBy = $reservedPorts[$portId] ?? null;
                    if ($usedBy === null) {
                        $findPortLinks->execute([$portId, $portId]);
                        $usedBy = self::firstUntouched($findPortLinks, $touchedLinks);
                    }
                    if ($usedBy !== null) {
                        throw new ApiException("指定されたポートは接続 #{$usedBy} で使用されています", 400,
                            ['reason' => 'port_in_use', 'port_id' => $portId, 'link_id' => $usedBy]);
                    }
                    $reservedPorts[$portId] = $id;
                }
                if ($fromPort === null && $toPort === null) {
                    $pair = min($from, $to) . ':' . max($from, $to);
                    $usedBy = $reservedPairs[$pair] ?? null;
                    if ($usedBy === null) {
                        $findPair->bindValue(1, min($from, $to), PDO::PARAM_INT);
                        $findPair->bindValue(2, max($from, $to), PDO::PARAM_INT);
                        $findPair->execute();
                        $usedBy = self::firstUntouched($findPair, $touchedLinks);
                    }
                    if ($usedBy !== null) {
                        throw new ApiException("この機器の組にはポート未指定の接続 #{$usedBy} が既にあります", 400,
                            ['reason' => 'unspecified_pair_exists', 'link_id' => $usedBy]);
                    }
                    $reservedPairs[$pair] = $id;
                }
                $plannedLinks[] = [$op['operation'] === 'create', [
                    'id' => $id, 'from_id' => $from, 'to_id' => $to, 'from_port_id' => $fromPort,
                    'to_port_id' => $toPort, 'system_id' => $system,
                    'label' => self::text($body['label'] ?? $before['label'] ?? '', 'ラベル', 100),
                    'memo' => self::text($body['memo'] ?? $before['memo'] ?? '', '接続備考', 1000),
                ]];
                if ($op['operation'] === 'create' && $op['id'] !== null) { $maps['links']->{$op['id']} = $id; }
                $changedLinks[$id] = true;
            }
            $this->delete('links', $deletedLinks);
            foreach ($plannedLinks as [$create, $row]) {
                if ($create) {
                    $stmt = $this->db->prepare('INSERT INTO links (id,from_id,to_id,from_port_id,to_port_id,system_id,label,memo)
                        VALUES (:id,:from_id,:to_id,:from_port_id,:to_port_id,:system_id,:label,:memo)');
                } else {
                    $stmt = $this->db->prepare('UPDATE links SET from_id=:from_id,to_id=:to_id,from_port_id=:from_port_id,
                        to_port_id=:to_port_id,system_id=:system_id,label=:label,memo=:memo WHERE id=:id');
                }
                $stmt->execute($row);
            }
            foreach (array_keys($deletedPorts) as $id) {
                $findPortLinks->execute([$id, $id]);
                $usedBy = self::firstUntouched($findPortLinks, []);
                if ($usedBy !== null) {
                    throw new ApiException("接続 #{$usedBy} で使用中のポートは削除できません", 400,
                        ['reason' => 'port_in_use', 'port_id' => $id, 'link_id' => $usedBy]);
                }
            }
            $this->delete('device_ports', $deletedPorts);
            if ($migrationLinkId !== null) {
                $this->deleteUnmigratedVlanRecord($migrationLinkId);
            }
            [$removedRoutes, $viewRevisions] = $this->removeUnusedRoutes($oldPairs);
            $history->recordFromSnapshot($snapshot, $deviceIds, [], 'save_connections');

            $meta = new AppMetaRepository($this->db);
            $meta->set('last_saved_at', date(DATE_ATOM));
            $result = [
                'ok' => true, 'revision' => $meta->getDataRevision(), 'saved_at' => $meta->get('last_saved_at'),
                'id_maps' => $maps, 'links' => $this->rows('links', $changedLinks),
                'device_ports' => $this->rows('device_ports', $changedPorts),
                'deleted_link_ids' => array_keys($deletedLinks), 'deleted_device_port_ids' => array_keys($deletedPorts),
                'removed_view_link_routes' => $removedRoutes, 'views' => $viewRevisions,
            ];
            if ($migrationLinkId !== null) {
                $result['completed_legacy_vlan_link_id'] = $migrationLinkId;
            }
            $this->db->commit();
            return $result;
        } catch (Throwable $e) {
            if ($this->db->inTransaction()) { $this->db->rollBack(); }
            if ($e instanceof PDOException && Database::isBusy($e)) {
                throw new ApiException('現在、別の保存処理が実行されています。少し待ってから再度保存してください', 503);
            }
            throw $e;
        }
    }

    public function copyPortVlan(array $input): array
    {
        $linkId = ResourceId::parse($input['link_id'] ?? null, 'link_id');
        $sourceId = ResourceId::parse($input['source_port_id'] ?? null, 'source_port_id');
        $destinationId = ResourceId::parse($input['destination_port_id'] ?? null, 'destination_port_id');
        if ($sourceId === $destinationId) {
            throw new ApiException('コピー元とコピー先には異なるポートを指定してください', 400);
        }
        $sourceRevision = ResourceId::parse($input['source_expected_revision'] ?? null, 'source_expected_revision');
        $destinationRevision = ResourceId::parse($input['destination_expected_revision'] ?? null, 'destination_expected_revision');
        $meta = new AppMetaRepository($this->db);
        try {
            $this->db->beginTransaction();
            // 書き込みロックを先に取得する。同値なら保存世代を進めない。
            $this->db->exec("UPDATE app_meta SET meta_value = meta_value WHERE meta_key = 'data_revision'");
            $link = $this->row('links', $linkId);
            $from = $link['from_port_id'] ?? null;
            $to = $link['to_port_id'] ?? null;
            if (!(($from === $sourceId && $to === $destinationId) || ($from === $destinationId && $to === $sourceId))) {
                throw new ApiException('接続の両端ポートが変更されています。再読み込みしてください', 409,
                    ['reason' => 'link_endpoints_changed', 'link_id' => $linkId]);
            }
            $ports = array_column($this->rows('device_ports', [$sourceId => true, $destinationId => true]), null, 'id');
            $conflicts = [];
            foreach ([$sourceId => $sourceRevision, $destinationId => $destinationRevision] as $id => $expected) {
                $actual = $ports[$id]['resource_revision'] ?? null;
                if ($actual !== $expected) {
                    $conflicts[] = ['resource' => 'device_ports', 'id' => $id,
                        'expected_revision' => $expected, 'actual_revision' => $actual];
                }
            }
            if ($conflicts !== []) {
                throw new ApiException('ポートが他の利用者または別画面で更新・削除されています', 409, ['conflicts' => $conflicts]);
            }
            $vlan = $ports[$sourceId]['vlan'];
            if (trim($vlan) === '') {
                throw new ApiException('コピー元のポートに VLAN が設定されていません', 400);
            }
            $unchanged = $vlan === $ports[$destinationId]['vlan'];
            $revision = $meta->getDataRevision();
            $savedAt = $meta->get('last_saved_at');
            if ($unchanged) {
                $this->db->rollBack();
            } else {
                $deviceIds = [$ports[$destinationId]['device_id']];
                $history = new ChangeHistoryService($this->db);
                $snapshot = $history->captureSnapshot($deviceIds, []);
                $revision = $meta->claimDataRevision($revision);
                $stmt = $this->db->prepare('UPDATE device_ports SET vlan = ? WHERE id = ?');
                $stmt->execute([$vlan, $destinationId]);
                $history->recordFromSnapshot($snapshot, $deviceIds, [], 'copy_port_vlan');
                $savedAt = date(DATE_ATOM);
                $meta->set('last_saved_at', $savedAt);
                $ports[$destinationId] = $this->row('device_ports', $destinationId);
                $this->db->commit();
            }
            return [
                'ok' => true, 'revision' => $revision, 'saved_at' => $savedAt, 'unchanged' => $unchanged,
                'id_maps' => ['device_ports' => (object)[], 'links' => (object)[]],
                'links' => [$link], 'device_ports' => array_values($ports),
                'deleted_link_ids' => [], 'deleted_device_port_ids' => [], 'removed_view_link_routes' => [], 'views' => [],
            ];
        } catch (Throwable $e) {
            if ($this->db->inTransaction()) { $this->db->rollBack(); }
            if ($e instanceof PDOException && Database::isBusy($e)) {
                throw new ApiException('現在、別の保存処理が実行されています。少し待ってから再度保存してください', 503);
            }
            throw $e;
        }
    }

    public function deleteUnmigratedVlan(array $input): array
    {
        if (array_diff(array_keys($input), ['link_id', 'expected_revision', 'link_expected_revision']) !== []) {
            throw new ApiException('未移行VLANの削除ではポートや接続の変更を指定できません', 400);
        }
        $id = ResourceId::parse($input['link_id'] ?? null, 'link_id');
        $expected = ResourceId::parse($input['expected_revision'] ?? null, 'expected_revision', ResourceId::MAX_RESTORE);
        $linkRevision = ResourceId::parse($input['link_expected_revision'] ?? null, 'link_expected_revision');
        $meta = new AppMetaRepository($this->db);
        try {
            $this->db->beginTransaction();
            $revision = $meta->claimDataRevision($expected);
            $link = $this->row('links', $id);
            if (($link['resource_revision'] ?? null) !== $linkRevision) {
                throw new ApiException('接続が変更されています。再読み込みしてください', 409, [
                    'conflicts' => [['resource' => 'links', 'id' => $id,
                        'expected_revision' => $linkRevision, 'actual_revision' => $link['resource_revision'] ?? null]],
                ]);
            }
            $this->deleteUnmigratedVlanRecord($id);
            $savedAt = date(DATE_ATOM);
            $meta->set('last_saved_at', $savedAt);
            $this->db->commit();
            return ['ok' => true, 'revision' => $revision, 'saved_at' => $savedAt, 'link_id' => $id];
        } catch (Throwable $e) {
            if ($this->db->inTransaction()) { $this->db->rollBack(); }
            if ($e instanceof PDOException && Database::isBusy($e)) {
                throw new ApiException('現在、別の保存処理が実行されています。少し待ってから再度保存してください', 503);
            }
            throw $e;
        }
    }

    private function deleteUnmigratedVlanRecord(int $linkId): void
    {
        $delete = $this->db->prepare('DELETE FROM legacy_link_vlans WHERE link_id = ?');
        $delete->execute([$linkId]);
        if ($delete->rowCount() !== 1) {
            throw new ApiException('指定された未移行VLANはありません。再読み込みしてください', 409, [
                'link_id' => $linkId, 'reason' => 'unmigrated_vlan_missing',
            ]);
        }
    }

    private static function portVlan(mixed $value): string
    {
        if (!self::isValidPortVlan($value)) {
            throw new ApiException('VLAN設定は 1 行、200 文字以内で指定してください', 400);
        }
        return trim($value);
    }

    public static function isValidPortVlan(mixed $value): bool
    {
        return is_string($value) && preg_match('/\A[^\p{Cc}\p{Zl}\p{Zp}]{0,200}\z/u', $value) === 1;
    }

    public function resolveLegacyConflict(array $input): array
    {
        $id = ResourceId::parse($input['legacy_link_id'] ?? null, 'legacy_link_id');
        $viewId = ResourceId::parse($input['view_id'] ?? null, 'view_id');
        $expected = ResourceId::parse($input['expected_revision'] ?? null, 'expected_revision', ResourceId::MAX_RESTORE);
        $meta = new AppMetaRepository($this->db);
        try {
            $this->db->beginTransaction();
            $revision = $meta->claimDataRevision($expected);
            // 指定された元ビューの保留行だけ除外する。共通接続へは変換しない。
            $delete = $this->db->prepare('DELETE FROM legacy_link_conflicts WHERE legacy_link_id = ? AND view_id = ?
                RETURNING device_a_id, device_b_id');
            $delete->execute([$id, $viewId]);
            $pair = $delete->fetch(PDO::FETCH_NUM);
            $delete->closeCursor();
            if ($pair === false) {
                throw new ApiException('指定された旧接続はこのビューの保留一覧にありません。再読み込みしてください', 409);
            }
            [$routes, $views] = $this->removeUnusedRoutes([$pair]);
            $savedAt = date(DATE_ATOM);
            $meta->set('last_saved_at', $savedAt);
            $this->db->commit();
            return [
                'ok' => true, 'revision' => $revision, 'saved_at' => $savedAt, 'legacy_link_id' => $id,
                'removed_view_link_routes' => $routes, 'views' => $views,
            ];
        } catch (Throwable $e) {
            if ($this->db->inTransaction()) { $this->db->rollBack(); }
            if ($e instanceof PDOException && Database::isBusy($e)) {
                throw new ApiException('現在、別の保存処理が実行されています。少し待ってから再度保存してください', 503);
            }
            throw $e;
        }
    }

    private static function operations(mixed $rows, string $bodyKey): array
    {
        if (!is_array($rows) || !array_is_list($rows)) {
            throw new ApiException('ポート・接続の変更は配列で指定してください', 400);
        }
        $allowed = $bodyKey === 'port' ? ['device_id', 'name', 'memo', 'vlan'] : [
            'from_id', 'to_id', 'from_port_id', 'to_port_id', 'from_port_name', 'to_port_name', 'system_id', 'label', 'memo',
        ];
        $result = $seen = [];
        foreach ($rows as $row) {
            $operation = is_array($row) ? ($row['operation'] ?? null) : null;
            if (!in_array($operation, ['create', 'update', 'delete'], true)) {
                throw new ApiException('ポート・接続の操作が不正です', 400);
            }
            $id = $operation === 'create' && !isset($row['id']) ? null : ResourceId::parse($row['id'] ?? null, 'id');
            if ($id !== null && isset($seen[$id])) {
                throw new ApiException('操作の ID が重複しています', 400);
            }
            if ($id !== null) { $seen[$id] = true; }
            $data = $operation === 'delete' ? [] : ($row[$bodyKey] ?? null);
            if ($data instanceof \stdClass && get_object_vars($data) === []) {
                $data = [];
            }
            if (!is_array($data) || array_diff(array_keys($data), $allowed) !== []) {
                throw new ApiException('ポート・接続の入力項目が不正です', 400);
            }
            $result[] = ['operation' => $operation, 'id' => $id, 'data' => $data,
                'expected_revision' => $operation === 'create' ? null : ResourceId::parse($row['expected_revision'] ?? null, 'expected_revision')];
        }
        return $result;
    }

    private static function portName(mixed $name): string
    {
        if (!is_string($name) || !preg_match('//u', $name)) {
            throw new ApiException('ポート名は UTF-8 の文字列で指定してください', 400);
        }
        $name = LegacyLinkMigration::normalizePortName($name);
        if (!preg_match('/\A[^\p{Cc}]{0,50}\z/u', $name)) {
            throw new ApiException('ポート名は制御文字を除く 50 文字以内で指定してください', 400);
        }
        return $name;
    }

    private static function text(mixed $value, string $label, int $max): string
    {
        if (!is_string($value) || !preg_match('/\A[^\x00]{0,' . $max . '}\z/u', trim($value))) {
            throw new ApiException("{$label}は {$max} 文字以内で指定してください", 400);
        }
        return trim($value);
    }

    private function storePort(?int $id, int $device, string $name, string $memo, string $vlan): int
    {
        $existing = $this->findPortByName($device, $name);
        if ($existing !== null && $existing !== $id) {
            throw new ApiException('同じ機器に同名のポートが登録されています', 400, ['reason' => 'duplicate_port_name', 'port_id' => $existing]);
        }
        if ($id === null) {
            $id = ResourceId::allocate($this->db, 'device_ports');
            $this->db->prepare('INSERT INTO device_ports (id,device_id,name,memo,vlan) VALUES (?,?,?,?,?)')
                ->execute([$id, $device, $name, $memo, $vlan]);
        } else {
            $this->db->prepare('UPDATE device_ports SET name = ?, memo = ?, vlan = ? WHERE id = ?')
                ->execute([$name, $memo, $vlan, $id]);
        }
        return $id;
    }

    private function findPortByName(int $device, string $name): ?int
    {
        $stmt = $this->db->prepare('SELECT id FROM device_ports WHERE device_id = ? AND name = ?');
        $stmt->execute([$device, $name]);
        $id = $stmt->fetchColumn();
        return $id === false ? null : (int)$id;
    }

    private function resolvePort(array $body, array $before, string $side, int $owner, array &$changed, array $deleted): ?int
    {
        $idKey = $side . '_port_id';
        $nameKey = $side . '_port_name';
        if (array_key_exists($nameKey, $body)) {
            if (array_key_exists($idKey, $body)) {
                throw new ApiException('ポートの ID と名前は同時に指定できません', 400);
            }
            $name = self::portName($body[$nameKey]);
            if ($name === '') { return null; }
            $id = $this->findPortByName($owner, $name);
            if ($id === null) {
                $id = $this->storePort(null, $owner, $name, '', '');
            }
        } elseif (array_key_exists($idKey, $body)) {
            $id = $body[$idKey] === null ? null : ResourceId::parse($body[$idKey], $idKey);
        } else {
            $id = (int)($before[$side . '_id'] ?? 0) === $owner ? ($before[$idKey] ?? null) : null;
        }
        if ($id !== null) {
            if (isset($deleted[$id]) || (array_key_exists($idKey, $body) &&
                (int)($this->row('device_ports', $id)['device_id'] ?? 0) !== $owner)) {
                throw new ApiException('指定のポートは接続端点の機器に存在しません', 400);
            }
            $changed[$id] = true;
        }
        return $id;
    }

    private static function firstUntouched(\PDOStatement $stmt, array $touched): ?int
    {
        $id = null;
        while (($value = $stmt->fetchColumn()) !== false) {
            if (!isset($touched[$value])) { $id = (int)$value; break; }
        }
        $stmt->closeCursor();
        return $id;
    }

    private function row(string $table, int $id): ?array
    {
        $stmt = $this->db->prepare("SELECT * FROM {$table} WHERE id = ?");
        $stmt->execute([$id]);
        return $stmt->fetch(PDO::FETCH_ASSOC) ?: null;
    }

    private function rows(string $table, array $ids, string $columns = '*'): array
    {
        return $ids === [] ? [] : $this->db->query("SELECT {$columns} FROM {$table} WHERE id IN (" .
            implode(',', array_keys($ids)) . ') ORDER BY id')->fetchAll(PDO::FETCH_ASSOC);
    }

    private function delete(string $table, array $ids): void
    {
        if ($ids !== []) {
            $this->db->exec("DELETE FROM {$table} WHERE id IN (" . implode(',', array_keys($ids)) . ')');
        }
    }

    private function removeUnusedRoutes(array $pairs): array
    {
        $find = $this->db->prepare('SELECT r.view_id, v.resource_revision FROM view_link_routes r JOIN views v ON v.id=r.view_id
            WHERE r.device_a_id=:a AND r.device_b_id=:b
            AND NOT EXISTS (SELECT 1 FROM links WHERE min(from_id,to_id)=:a AND max(from_id,to_id)=:b)
            AND NOT EXISTS (SELECT 1 FROM legacy_link_conflicts WHERE device_a_id=:a AND device_b_id=:b)
            ORDER BY r.view_id');
        $delete = $this->db->prepare('DELETE FROM view_link_routes WHERE device_a_id = ? AND device_b_id = ?');
        $removed = $beforeViews = [];
        foreach ($pairs as [$a, $b]) {
            $find->bindValue(':a', $a, PDO::PARAM_INT);
            $find->bindValue(':b', $b, PDO::PARAM_INT);
            $find->execute();
            $rows = $find->fetchAll(PDO::FETCH_ASSOC);
            if ($rows === []) { continue; }
            foreach ($rows as $row) {
                $beforeViews[$row['view_id']] ??= $row['resource_revision'];
                $removed[] = ['view_id' => $row['view_id'], 'device_a_id' => $a, 'device_b_id' => $b];
            }
            $delete->execute([$a, $b]);
        }
        $views = $this->rows('views', $beforeViews, 'id, resource_revision');
        foreach ($views as &$view) { $view['previous_resource_revision'] = $beforeViews[$view['id']]; }
        unset($view);
        return [$removed, $views];
    }
}
