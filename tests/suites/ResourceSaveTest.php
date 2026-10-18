<?php
declare(strict_types=1);

namespace Netarium\Tests\Suites;

use Netarium\Tests\TestCase;
use Netarium\Tests\TestHttpClient;
use PDO;

class ResourceSaveTest extends TestCase
{
    public function __construct(private TestHttpClient $client) {}

    private function load(?TestHttpClient $client = null): array
    {
        return ($client ?? $this->client)->get('/api.php?action=load')->assertOk()->getJson();
    }

    private function secondClient(): TestHttpClient
    {
        $client = new TestHttpClient($this->client->getBaseUrl());
        $this->assertTrue($client->login('admin', 'admin123'));
        return $client;
    }

    private function save(array $devices = [], array $views = [], ?TestHttpClient $client = null): array
    {
        return ($client ?? $this->client)->postJson('/api.php?action=save_resources', [
            'devices' => $devices, 'views' => $views,
        ])->assertOk()->getJson();
    }

    private function deviceOperation(array $device, string $operation = 'update'): array
    {
        return ['operation' => $operation, 'id' => (int)$device['id'],
            'expected_revision' => (int)$device['resource_revision'], 'device' => $device];
    }

    private function viewOperation(array $data, array $view): array
    {
        $id = (int)$view['id'];
        return ['operation' => 'update', 'id' => $id,
            'expected_revision' => (int)$view['resource_revision'], 'view' => $view,
            'placements' => array_values(array_filter($data['placements'], static fn($p) => (int)$p['view_id'] === $id)),
            'links' => array_values(array_filter($data['links'], static fn($l) => (int)$l['view_id'] === $id)),
            'canvas_notes' => array_values(array_filter($data['canvas_notes'], static fn($n) => (int)$n['view_id'] === $id))];
    }

    private function find(array $rows, int $id): array
    {
        foreach ($rows as $row) {
            if ((int)$row['id'] === $id) {
                return $row;
            }
        }
        $this->fail("対象ID {$id} が見つかりません");
    }


    public function testUnsafeIdsAndExhaustionPreserveResourceState(): void
    {
        $server = new \Netarium\Tests\TestServer();
        $originalClient = $this->client;
        $db = null;
        try {
            $server->start();
            $this->client = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($this->client->login('admin', 'admin123'));
            $db = new PDO('sqlite:' . $server->getDbPath());
            $before = $this->load();
            foreach (['9007199254740992', '9007199254740993', '999999999999999999999999999999', 1.5] as $id) {
                $this->client->postJson('/api.php?action=save_resources', [
                    'devices' => [['operation' => 'create', 'id' => $id,
                        'device' => ['name' => 'Unsafe ID', 'type' => 'switch']]],
                    'views' => [],
                ])->assertStatus(400);
                $this->assertSame($before, $this->load());
            }
            $db->exec("UPDATE resource_sequences SET value = 9007199254740990 WHERE name = 'devices'");
            $created = $this->save([['operation' => 'create', 'id' => 980001,
                'device' => ['name' => 'Last safe resource ID', 'type' => 'switch']]]);
            $this->assertSame(9007199254740991, $created['id_maps']['devices'][980001]);
            $before = $this->load();
            $sequences = $db->query('SELECT * FROM resource_sequences ORDER BY name')->fetchAll(PDO::FETCH_ASSOC);
            $exhaustedRes = $this->client->postJson('/api.php?action=save_resources', [
                'devices' => [['operation' => 'create', 'id' => 980002,
                    'device' => ['name' => 'Exhausted ID', 'type' => 'switch']]],
                'views' => [],
            ])->assertStatus(409)->getJson();
            $this->assertSame('id_exhausted', $exhaustedRes['details']['reason'] ?? null);
            $this->assertSame('devices', $exhaustedRes['details']['resource'] ?? null);
            $this->assertSame($before, $this->load());
            $this->assertSame($sequences, $db->query('SELECT * FROM resource_sequences ORDER BY name')->fetchAll(PDO::FETCH_ASSOC));
        } finally {
            $db = null;
            $this->client = $originalClient;
            $server->stop();
        }
    }
    public function testDifferentDevicesSaveAndStaleSameDeviceIsRejected(): void
    {
        $other = $this->secondClient();
        $a = $this->load();
        $b = $this->load($other);
        $first = $a['devices'][0];
        $second = $b['devices'][1];
        $first['memo'] = '利用者Aの変更';
        $second['memo'] = '利用者Bの変更';
        $savedA = $this->save([$this->deviceOperation($first)]);
        $savedB = $this->save([$this->deviceOperation($second)], [], $other);
        $this->assertTrue((int)$savedB['revision'] > (int)$savedA['revision']);
        $current = $this->load();
        $this->assertSame($first['memo'], $this->find($current['devices'], (int)$first['id'])['memo']);
        $this->assertSame($second['memo'], $this->find($current['devices'], (int)$second['id'])['memo']);
        $stale = $this->find($b['devices'], (int)$first['id']);
        $stale['memo'] = '古い画面の上書き';
        $other->postJson('/api.php?action=save_resources', ['devices' => [$this->deviceOperation($stale)], 'views' => []])->assertStatus(409);
        $this->assertSame($first['memo'], $this->find($this->load()['devices'], (int)$first['id'])['memo']);
        $this->assertTrue((int)$this->find($current['devices'], (int)$first['id'])['resource_revision'] > (int)$first['resource_revision']);
    }

    public function testDifferentViewsSaveAndStaleSameViewIsRejected(): void
    {
        $other = $this->secondClient();
        $data = $this->load();
        $viewA = $data['views'][0];
        $viewB = $data['views'][1];
        $viewA['memo'] = 'ビューA変更';
        $viewB['memo'] = 'ビューB変更';
        $operationA = $this->viewOperation($data, $viewA);
        if ($operationA['placements'] !== []) {
            $operationA['placements'][0]['x'] = 321;
        }
        $this->save([], [$operationA]);
        $this->save([], [$this->viewOperation($data, $viewB)], $other);
        $current = $this->load();
        $this->assertSame($viewA['memo'], $this->find($current['views'], (int)$viewA['id'])['memo']);
        $this->assertSame($viewB['memo'], $this->find($current['views'], (int)$viewB['id'])['memo']);
        if ($operationA['placements'] !== []) {
            $p = $operationA['placements'][0];
            $matches = array_values(array_filter($current['placements'], static fn($row) => (int)$row['device_id'] === (int)$p['device_id'] && (int)$row['view_id'] === (int)$viewA['id']));
            $this->assertSame(321.0, (float)$matches[0]['x']);
        }
        $other->postJson('/api.php?action=save_resources', ['devices' => [], 'views' => [$operationA]])->assertStatus(409);
        $this->assertTrue((int)$this->find($current['views'], (int)$viewA['id'])['resource_revision'] > (int)$viewA['resource_revision']);
    }

    public function testPendingLikeViewNamesAllowMemoAndPlacementUpdates(): void
    {
        $server = new \Netarium\Tests\TestServer();
        $originalClient = $this->client;
        $db = null;
        try {
            $server->start();
            $this->client = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($this->client->login('admin', 'admin123'));
            $data = $this->load();
            $view = $data['views'][0];
            $creates = [];
            foreach (['__pending_' . $view['id'], '__PENDING_2', '__pending_3'] as $offset => $name) {
                $id = 970001 + $offset;
                $creates[] = ['operation' => 'create', 'id' => $id,
                    'view' => ['id' => $id, 'name' => $name, 'view_type' => 'topology'],
                    'placements' => [], 'links' => [], 'canvas_notes' => []];
            }
            $this->save([], $creates);
            $before = $this->load();
            $view = $this->find($before['views'], (int)$view['id']);
            $view['memo'] = '内部仮名に似たビューがあっても保存する';
            $this->save([], [$this->viewOperation($before, $view)]);
            $afterMemo = $this->load();
            $savedView = $this->find($afterMemo['views'], (int)$view['id']);
            $this->assertSame($view['memo'], $savedView['memo']);
            $this->assertSame($view['name'], $savedView['name']);
            $this->assertTrue((int)$savedView['resource_revision'] > (int)$view['resource_revision']);
            $this->assertSame((int)$before['revision'] + 1, (int)$afterMemo['revision']);
            $this->assertSame($before['placements'], $afterMemo['placements']);

            $operation = $this->viewOperation($afterMemo, $savedView);
            $placement = $operation['placements'][0];
            $operation['placements'][0]['x'] = 321;
            $operation['placements'][0]['y'] = 654;
            $this->save([], [$operation]);
            $afterPlacement = $this->load();
            $savedPlacement = $this->find($afterPlacement['placements'], (int)$placement['id']);
            $this->assertSame(321.0, (float)$savedPlacement['x']);
            $this->assertSame(654.0, (float)$savedPlacement['y']);
            $this->assertSame($view['memo'], $this->find($afterPlacement['views'], (int)$view['id'])['memo']);
            $this->assertSame((int)$afterMemo['revision'] + 1, (int)$afterPlacement['revision']);
            foreach ($before['views'] as $otherView) {
                if ((int)$otherView['id'] !== (int)$view['id']) {
                    $this->assertSame($otherView, $this->find($afterMemo['views'], (int)$otherView['id']));
                    $this->assertSame($otherView, $this->find($afterPlacement['views'], (int)$otherView['id']));
                }
            }
            foreach ($before['placements'] as $otherPlacement) {
                if ((int)$otherPlacement['id'] !== (int)$placement['id']) {
                    $this->assertSame($otherPlacement, $this->find($afterPlacement['placements'], (int)$otherPlacement['id']));
                }
            }
            foreach (['devices', 'links', 'canvas_notes', 'monitor_revision'] as $key) {
                $this->assertSame($before[$key], $afterMemo[$key]);
                $this->assertSame($before[$key], $afterPlacement[$key]);
            }
            $db = new PDO('sqlite:' . $server->getDbPath());
            $this->assertSame([], $db->query('PRAGMA foreign_key_check')->fetchAll(PDO::FETCH_ASSOC));
        } finally {
            $db = null;
            $this->client = $originalClient;
            $server->stop();
        }
    }

    public function testViewNameSwapsAvoidExistingAndFinalPendingLikeNames(): void
    {
        $server = new \Netarium\Tests\TestServer();
        $originalClient = $this->client;
        try {
            $server->start();
            $this->client = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($this->client->login('admin', 'admin123'));
            $data = $this->load();
            [$first, $second] = $data['views'];
            [$first['name'], $second['name']] = [$second['name'], $first['name']];
            $this->save([], [$this->viewOperation($data, $first), $this->viewOperation($data, $second)]);
            $swapped = $this->load();
            $this->assertSame($first['name'], $this->find($swapped['views'], (int)$first['id'])['name']);
            $this->assertSame($second['name'], $this->find($swapped['views'], (int)$second['id'])['name']);

            $first = $this->find($swapped['views'], (int)$first['id']);
            $second = $this->find($swapped['views'], (int)$second['id']);
            $second['name'] = $first['name'];
            $first['name'] = '__pending_2';
            // 作成を先に書き込んでも、正規化後の最終名と仮名が衝突しない。
            $created = $this->save([], [
                ['operation' => 'create', 'id' => 970001,
                    'view' => ['id' => 970001, 'name' => '  __PENDING_1  ', 'view_type' => 'topology'],
                    'placements' => [], 'links' => [], 'canvas_notes' => []],
                $this->viewOperation($swapped, $first), $this->viewOperation($swapped, $second),
            ]);
            $current = $this->load();
            $thirdId = (int)$created['id_maps']['views'][970001];
            $this->assertSame('__PENDING_1', $this->find($current['views'], $thirdId)['name']);
            $this->assertSame('__pending_2', $this->find($current['views'], (int)$first['id'])['name']);
            $this->assertSame($second['name'], $this->find($current['views'], (int)$second['id'])['name']);

            $cycle = [$this->find($current['views'], (int)$first['id']),
                $this->find($current['views'], (int)$second['id']), $this->find($current['views'], $thirdId)];
            $names = array_column($cycle, 'name');
            $operations = [];
            foreach ($cycle as $index => $view) {
                $view['name'] = $names[($index + 1) % 3];
                $operations[] = $this->viewOperation($current, $view);
            }
            $this->save([], $operations);
            $rotated = $this->load();
            foreach ($operations as $operation) {
                $saved = $this->find($rotated['views'], $operation['id']);
                $this->assertSame($operation['view']['name'], $saved['name']);
                $this->assertTrue((int)$saved['resource_revision'] > $operation['expected_revision']);
            }
            foreach (['devices', 'placements', 'links', 'canvas_notes', 'monitor_revision'] as $key) {
                $this->assertSame($data[$key], $rotated[$key]);
            }
        } finally {
            $this->client = $originalClient;
            $server->stop();
        }
    }

    public function testFailureAfterViewRenamesRollsBackEntireBatch(): void
    {
        $server = new \Netarium\Tests\TestServer();
        $originalClient = $this->client;
        $db = null;
        try {
            $server->start();
            $this->client = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($this->client->login('admin', 'admin123'));
            $before = $this->load();
            $db = new PDO('sqlite:' . $server->getDbPath());
            $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
            $sequences = $db->query('SELECT * FROM resource_sequences ORDER BY name')->fetchAll(PDO::FETCH_ASSOC);
            [$first, $second] = $before['views'];
            [$first['name'], $second['name']] = [$second['name'], $first['name']];
            $device = $before['devices'][0];
            $device['memo'] = 'ビュー書込み失敗で機器も戻す';
            $operations = [
                ['operation' => 'create', 'id' => 970001,
                    'view' => ['id' => 970001, 'name' => '__pending_1', 'view_type' => 'topology'],
                    'placements' => [], 'links' => [], 'canvas_notes' => []],
                $this->viewOperation($before, $first), $this->viewOperation($before, $second),
            ];
            // 名前の退避・確定と既存配置の削除が済んだ後に失敗させる。
            $db->exec("CREATE TRIGGER fail_placement_insert BEFORE INSERT ON device_placements
                BEGIN SELECT RAISE(ABORT, 'injected placement failure'); END");
            $this->client->postJson('/api.php?action=save_resources', [
                'devices' => [$this->deviceOperation($device)], 'views' => $operations,
            ])->assertStatus(500);
            $this->assertSame($before, $this->load());
            $this->assertSame($sequences, $db->query('SELECT * FROM resource_sequences ORDER BY name')->fetchAll(PDO::FETCH_ASSOC));
            $this->assertSame([], $db->query('PRAGMA foreign_key_check')->fetchAll(PDO::FETCH_ASSOC));
            $db->exec('DROP TRIGGER fail_placement_insert');
            $this->save([$this->deviceOperation($device)], $operations);
            $after = $this->load();
            $this->assertSame($device['memo'], $this->find($after['devices'], (int)$device['id'])['memo']);
            $this->assertSame($first['name'], $this->find($after['views'], (int)$first['id'])['name']);
            $this->assertSame($second['name'], $this->find($after['views'], (int)$second['id'])['name']);
            $this->assertSame($before['placements'], $after['placements']);
            $this->assertSame($before['links'], $after['links']);
        } finally {
            $db = null;
            $this->client = $originalClient;
            $server->stop();
        }
    }

    public function testConflictingBatchRollsBackOtherResourceChanges(): void
    {
        $data = $this->load();
        $first = $data['devices'][0];
        $second = $data['devices'][1];
        $updated = $first;
        $updated['memo'] = '先に確定';
        $this->save([$this->deviceOperation($updated)]);
        $second['memo'] = '失敗するtransactionの変更';
        $response = $this->client->postJson('/api.php?action=save_resources', [
            'devices' => [$this->deviceOperation($second), $this->deviceOperation($first)], 'views' => [],
        ])->assertStatus(409)->getJson();
        $this->assertSame([['kind' => 'devices', 'id' => (int)$first['id'], 'name' => $first['name']]], $response['details']['conflicts']);
        $this->assertSame($data['devices'][1]['memo'], $this->find($this->load()['devices'], (int)$second['id'])['memo']);
    }

    public function testConflictDetailsIncludeAllStaleResourcesAndIndependentRetrySucceeds(): void
    {
        $data = $this->load();
        $device = $data['devices'][0];
        $view = $data['views'][0];
        $updatedDevice = $device;
        $updatedDevice['memo'] = '競合する機器の最新値';
        $updatedView = $view;
        $updatedView['memo'] = '競合するビューの最新値';
        $this->save([$this->deviceOperation($updatedDevice)], [$this->viewOperation($data, $updatedView)]);
        $independent = $data['devices'][1];
        $independent['memo'] = '独立して再試行する値';
        $response = $this->client->postJson('/api.php?action=save_resources', [
            'devices' => [$this->deviceOperation($independent), $this->deviceOperation($device)],
            'views' => [$this->viewOperation($data, $view)],
        ])->assertStatus(409)->getJson();
        $this->assertSame([
            ['kind' => 'devices', 'id' => (int)$device['id'], 'name' => $device['name']],
            ['kind' => 'views', 'id' => (int)$view['id'], 'name' => $view['name']],
        ], $response['details']['conflicts']);
        $afterRollback = $this->load();
        $this->assertSame($data['devices'][1]['memo'], $this->find($afterRollback['devices'], (int)$independent['id'])['memo']);
        $this->save([$this->deviceOperation($independent)]);
        $current = $this->load();
        $this->assertSame($independent['memo'], $this->find($current['devices'], (int)$independent['id'])['memo']);
        $this->assertSame($updatedDevice['memo'], $this->find($current['devices'], (int)$device['id'])['memo']);
        $this->assertSame($updatedView['memo'], $this->find($current['views'], (int)$view['id'])['memo']);
    }

    public function testServerMapsConcurrentCreationIdsAndRelatedReferences(): void
    {
        $other = $this->secondClient();
        $make = static fn(string $name): array => ['operation' => 'create', 'id' => 900001,
            'device' => ['id' => 900001, 'name' => $name, 'type' => 'switch', 'ip' => '']];
        $view = ['operation' => 'create', 'id' => 900001,
            'view' => ['id' => 900001, 'name' => '採番確認ビュー', 'view_type' => 'topology'],
            'placements' => [['id' => 900001, 'device_id' => 900001, 'view_id' => 900001, 'x' => 10, 'y' => 20]], 'links' => [], 'canvas_notes' => []];
        $a = $this->save([$make('採番確認A')], [$view]);
        $b = $this->save([$make('採番確認B')], [], $other);
        $idA = (int)$a['id_maps']['devices'][900001];
        $idB = (int)$b['id_maps']['devices'][900001];
        $viewId = (int)$a['id_maps']['views'][900001];
        $this->assertNotSame($idA, $idB);
        $this->assertSame($idA, (int)$a['placements'][0]['device_id']);
        $this->assertSame($viewId, (int)$a['placements'][0]['view_id']);
        $this->assertSame('採番確認A', $this->find($this->load()['devices'], $idA)['name']);
        $this->assertSame('採番確認B', $this->find($this->load()['devices'], $idB)['name']);
        $this->save([$this->deviceOperation($this->find($this->load()['devices'], $idB), 'delete')]);
        $c = $this->save([$make('採番確認C')]);
        $this->assertTrue((int)$c['id_maps']['devices'][900001] > $idB, '削除したIDを再利用しない');
        $latest = $this->load();
        $this->save([$this->deviceOperation($this->find($latest['devices'], $idA), 'delete'),
            $this->deviceOperation($this->find($latest['devices'], (int)$c['id_maps']['devices'][900001]), 'delete')],
            [['operation' => 'delete', 'id' => $viewId, 'expected_revision' => (int)$this->find($latest['views'], $viewId)['resource_revision']]]);
    }

    public function testDeviceDeletionInvalidatesAffectedViewsAndRemovesRelationships(): void
    {
        $data = $this->load();
        $placement = $data['placements'][0];
        $deviceId = (int)$placement['device_id'];
        $view = $this->find($data['views'], (int)$placement['view_id']);
        $this->save([$this->deviceOperation($this->find($data['devices'], $deviceId), 'delete')]);
        $latest = $this->load();
        foreach ($latest['placements'] as $row) {
            $this->assertNotSame($deviceId, (int)$row['device_id']);
        }
        foreach ($latest['links'] as $row) {
            $this->assertNotSame($deviceId, (int)$row['from_id']);
            $this->assertNotSame($deviceId, (int)$row['to_id']);
        }
        $this->assertTrue((int)$this->find($latest['views'], (int)$view['id'])['resource_revision'] > (int)$view['resource_revision']);
        $this->client->postJson('/api.php?action=save_resources', ['devices' => [], 'views' => [$this->viewOperation($data, $view)]])->assertStatus(409);
    }

    public function testWholeSaveInvalidatesOldResourceRevisions(): void
    {
        $data = $this->load();
        $snapshot = array_intersect_key($data, array_flip(['revision', 'views', 'devices', 'placements', 'links', 'canvas_notes']));
        $snapshot['devices'][0]['memo'] = '全体操作による更新';
        $snapshot['views'][0]['memo'] = '全体操作によるビュー更新';
        $this->client->postJson('/api.php?action=save', $snapshot)->assertOk();
        $this->client->postJson('/api.php?action=save_resources', ['devices' => [$this->deviceOperation($data['devices'][0])], 'views' => []])->assertStatus(409);
        $this->client->postJson('/api.php?action=save_resources', ['devices' => [], 'views' => [$this->viewOperation($data, $data['views'][0])]])->assertStatus(409);
        $this->assertSame('全体操作による更新', $this->load()['devices'][0]['memo']);
    }

    public function testResourceSaveRequiresCsrfAndAdmin(): void
    {
        $other = $this->secondClient();
        $other->setCsrfToken('invalid');
        $other->postJson('/api.php?action=save_resources', ['devices' => [], 'views' => []])->assertStatus(403);
        $viewer = new TestHttpClient($this->client->getBaseUrl());
        $this->assertTrue($viewer->login('viewer', 'viewer123'));
        $viewer->postJson('/api.php?action=save_resources', ['devices' => [], 'views' => []])->assertStatus(403);
    }

    public function testMissingRevisionAndDuplicateOperationsCannotBypassLock(): void
    {
        $data = $this->load();
        $device = $data['devices'][0];
        $operation = $this->deviceOperation($device);
        unset($operation['expected_revision']);
        $this->client->postJson('/api.php?action=save_resources', [
            'devices' => [$operation], 'views' => [],
        ])->assertStatus(400);
        $operation = $this->deviceOperation($device);
        $this->client->postJson('/api.php?action=save_resources', [
            'devices' => [$operation, $operation], 'views' => [],
        ])->assertStatus(400);
        $this->assertSame((int)$data['revision'], (int)$this->load()['revision']);
    }

    public function testInvalidTopologyRollsBackDeviceUpdate(): void
    {
        $data = $this->load();
        $device = $data['devices'][0];
        $device['memo'] = '不正な配線と同時に保存しない';
        $view = $this->viewOperation($data, $data['views'][0]);
        $view['links'][] = ['id' => 800001, 'view_id' => $view['id'],
            'from_id' => (int)$device['id'], 'to_id' => (int)$device['id']];
        $this->client->postJson('/api.php?action=save_resources', [
            'devices' => [$this->deviceOperation($device)], 'views' => [$view],
        ])->assertStatus(400);
        $current = $this->load();
        $this->assertSame((int)$data['revision'], (int)$current['revision']);
        $this->assertSame($data['devices'][0]['memo'], $current['devices'][0]['memo']);
    }

    public function testOrphanReferencesRollBackDeviceAndViewBatch(): void
    {
        $data = $this->load();
        $device = $data['devices'][0];
        $device['memo'] = '孤立参照を含むバッチでは保存しない';
        $missingId = max(array_map('intval', array_column($data['devices'], 'id'))) + 1000;
        foreach (['placement', 'link'] as $kind) {
            $view = $this->viewOperation($data, $data['views'][0]);
            if ($kind === 'placement') {
                $view['placements'][] = ['id' => 800001, 'view_id' => $view['id'],
                    'device_id' => $missingId, 'x' => 10, 'y' => 20];
            } else {
                $view['links'][] = ['id' => 800001, 'view_id' => $view['id'],
                    'from_id' => (int)$device['id'], 'to_id' => $missingId];
            }
            $this->client->postJson('/api.php?action=save_resources', [
                'devices' => [$this->deviceOperation($device)], 'views' => [$view],
            ])->assertStatus(400);
            $current = $this->load();
            foreach (['revision', 'monitor_revision', 'devices', 'views', 'placements', 'links', 'canvas_notes'] as $key) {
                $this->assertSame($data[$key], $current[$key]);
            }
        }
    }

    public function testTwoNewViewTopologiesCanUseSameLocalPlacementAndLinkIds(): void
    {
        $data = $this->load();
        $first = (int)$data['devices'][0]['id'];
        $second = (int)$data['devices'][1]['id'];
        $make = static fn(string $name): array => ['operation' => 'create', 'id' => 700001,
            'view' => ['id' => 700001, 'name' => $name, 'view_type' => 'topology'],
            'placements' => [
                ['id' => 700001, 'view_id' => 700001, 'device_id' => $first, 'x' => 10, 'y' => 20],
                ['id' => 700002, 'view_id' => 700001, 'device_id' => $second, 'x' => 30, 'y' => 40],
            ],
            'links' => [['id' => 700001, 'view_id' => 700001, 'from_id' => $first, 'to_id' => $second, 'label' => $name]], 'canvas_notes' => []];
        $a = $this->save([], [$make('独立構成A')]);
        $b = $this->save([], [$make('独立構成B')], $this->secondClient());
        $idA = (int)$a['id_maps']['views'][700001];
        $idB = (int)$b['id_maps']['views'][700001];
        $this->assertNotSame($idA, $idB);
        $this->assertNotSame((int)$a['placements'][0]['id'], (int)$b['placements'][0]['id']);
        $this->assertNotSame((int)$a['links'][0]['id'], (int)$b['links'][0]['id']);
        $current = $this->load();
        foreach ([$idA => '独立構成A', $idB => '独立構成B'] as $id => $name) {
            $links = array_values(array_filter($current['links'], static fn($l) => (int)$l['view_id'] === $id));
            $this->assertSame($name, $links[0]['label']);
            $this->assertSame($first, (int)$links[0]['from_id']);
            $this->assertSame($second, (int)$links[0]['to_id']);
        }
        $this->save([], [
            ['operation' => 'delete', 'id' => $idA, 'expected_revision' => (int)$this->find($current['views'], $idA)['resource_revision']],
            ['operation' => 'delete', 'id' => $idB, 'expected_revision' => (int)$this->find($current['views'], $idB)['resource_revision']],
        ]);
    }

    public function testConcurrentWritersUseResourceRevisions(): void
    {
        $server = new \Netarium\Tests\TestServer();
        $worker = null;
        try {
            $server->start();
            $worker = $server->spawnWorker();
            $a = new TestHttpClient($server->getBaseUrl());
            $b = new TestHttpClient($worker->getBaseUrl());
            $this->assertTrue($a->login('admin', 'admin123'));
            $this->assertTrue($b->login('admin', 'admin123'));
            $data = $this->load($a);
            $first = $data['devices'][0];
            $second = $data['devices'][1];
            $first['memo'] = '同時保存A';
            $second['memo'] = '同時保存B';
            $statuses = $this->concurrentDeviceSaves($a, $first, $b, $second);
            $this->assertSame([200, 200], $statuses);
            $current = $this->load($a);
            $this->assertSame($first['memo'], $this->find($current['devices'], (int)$first['id'])['memo']);
            $this->assertSame($second['memo'], $this->find($current['devices'], (int)$second['id'])['memo']);
            $sameA = $this->find($current['devices'], (int)$first['id']);
            $sameB = $sameA;
            $sameA['memo'] = '同じ対象A';
            $sameB['memo'] = '同じ対象B';
            $statuses = $this->concurrentDeviceSaves($a, $sameA, $b, $sameB);
            $winner = $statuses[0] === 200 ? $sameA : $sameB;
            sort($statuses);
            $this->assertSame([200, 409], $statuses);
            $this->assertSame($winner['memo'], $this->find($this->load($a)['devices'], (int)$first['id'])['memo']);
        } finally {
            $worker?->stop();
            $server->stop();
        }
    }

    private function concurrentDeviceSaves(TestHttpClient $a, array $first, TestHttpClient $b, array $second): array
    {
        $multi = curl_multi_init();
        $handles = [];
        try {
            foreach ([[$a, $first], [$b, $second]] as [$client, $device]) {
                $handle = curl_init($client->getBaseUrl() . '/api.php?action=save_resources');
                curl_setopt_array($handle, [
                    CURLOPT_POST => true,
                    CURLOPT_RETURNTRANSFER => true,
                    CURLOPT_TIMEOUT => 15,
                    CURLOPT_COOKIEFILE => $client->cookieFile,
                    CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'X-CSRF-Token: ' . $client->getCsrfToken()],
                    CURLOPT_POSTFIELDS => json_encode(['devices' => [$this->deviceOperation($device)], 'views' => []]),
                ]);
                $handles[] = $handle;
                curl_multi_add_handle($multi, $handle);
            }
            do {
                $result = curl_multi_exec($multi, $running);
                if ($running) {
                    curl_multi_select($multi, 1);
                }
            } while ($running && $result === CURLM_OK);
            $statuses = [];
            foreach ($handles as $handle) {
                $this->assertSame(0, curl_errno($handle));
                $statuses[] = (int)curl_getinfo($handle, CURLINFO_RESPONSE_CODE);
            }
            return $statuses;
        } finally {
            foreach ($handles as $handle) {
                curl_multi_remove_handle($multi, $handle);
            }
            curl_multi_close($multi);
        }
    }

    public function testBusyDatabaseRejectsWithoutApplyingChanges(): void
    {
        $server = new \Netarium\Tests\TestServer();
        $db = null;
        try {
            $server->start();
            $client = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($client->login('admin', 'admin123'));
            $data = $this->load($client);
            $device = $data['devices'][0];
            $device['memo'] = 'busy時に保存しない';
            $db = new PDO('sqlite:' . $server->getDbPath());
            $db->beginTransaction();
            $db->exec('UPDATE devices SET memo = memo WHERE id = ' . (int)$device['id']);
            $client->postJson('/api.php?action=save_resources', [
                'devices' => [$this->deviceOperation($device)], 'views' => [],
            ])->assertStatus(503);
            $db->rollBack();
            $current = $this->load($client);
            $this->assertSame($data['devices'][0]['memo'], $current['devices'][0]['memo']);
            $this->assertSame((int)$data['revision'], (int)$current['revision']);
        } finally {
            if ($db?->inTransaction()) {
                $db->rollBack();
            }
            $db = null;
            $server->stop();
        }
    }

    public function testDeletionKeepsCommittedStateWhenImageCleanupNeedsRetry(): void
    {
        $server = new \Netarium\Tests\TestServer();
        $db = null;
        try {
            $server->start();
            $client = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($client->login('admin', 'admin123'));
            $db = new PDO('sqlite:' . $server->getDbPath());
            $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
            $db->exec('PRAGMA foreign_keys = ON');
            $name = str_repeat('a', 32) . '.png';
            $original = $server->getTempDir() . '/uploads/device_images/' . $name;
            $thumbDir = $server->getTempDir() . '/cache/thumbnails';
            if (!is_dir($thumbDir)) mkdir($thumbDir, 0700, true);
            $thumbnail = $thumbDir . '/thumb_320_' . $name;
            // 原本の削除失敗を隔離領域内のディレクトリで再現する。
            mkdir($original, 0700, true);
            file_put_contents($thumbnail, 'temporary thumbnail');
            $stmt = $db->prepare('INSERT INTO device_images
                (device_id, stored_name, mime_type, file_size, image_width, image_height, sort_order, created_at, updated_at)
                VALUES (1, ?, ?, 1, 1, 1, 1, ?, ?)');
            $stmt->execute([$name, 'image/png', date(DATE_ATOM), date(DATE_ATOM)]);
            $db->exec("INSERT OR REPLACE INTO device_monitor_status (device_id, status) VALUES (1, 'green')");
            $data = $this->load($client);
            $deleted = $this->save([$this->deviceOperation($this->find($data['devices'], 1), 'delete')], [], $client);
            $this->assertTrue($deleted['post_processing_required']);
            $this->assertSame(0, (int)$db->query('SELECT COUNT(*) FROM devices WHERE id = 1')->fetchColumn());
            $this->assertSame(0, (int)$db->query('SELECT COUNT(*) FROM device_images WHERE device_id = 1')->fetchColumn());
            $this->assertSame(0, (int)$db->query('SELECT COUNT(*) FROM device_monitor_status WHERE device_id = 1')->fetchColumn());
            $this->assertSame(1, (int)$db->query('SELECT COUNT(*) FROM device_image_gc')->fetchColumn());
            $this->assertFalse(is_file($thumbnail));
            $client->postJson('/api.php?action=save_resources', [
                'devices' => [$this->deviceOperation($this->find($data['devices'], 1), 'delete')], 'views' => [],
            ])->assertStatus(409);
            rmdir($original);
            $current = $this->load($client);
            $next = $this->save([$this->deviceOperation($this->find($current['devices'], 2), 'delete')], [], $client);
            $this->assertFalse($next['post_processing_required']);
            $this->assertSame(0, (int)$db->query('SELECT COUNT(*) FROM device_image_gc')->fetchColumn());
        } finally {
            $db = null;
            $server->stop();
        }
    }

    private function routeFixture(string $name): array
    {
        return $this->save([
            ['operation' => 'create', 'id' => 910001, 'device' => ['id' => 910001, 'name' => $name . ' A', 'type' => 'switch']],
            ['operation' => 'create', 'id' => 910002, 'device' => ['id' => 910002, 'name' => $name . ' B', 'type' => 'switch']],
        ], [[
            'operation' => 'create', 'id' => 910000,
            'view' => ['id' => 910000, 'name' => $name, 'view_type' => 'topology'],
            'placements' => [
                ['id' => 910001, 'device_id' => 910001, 'view_id' => 910000, 'x' => 100, 'y' => 100],
                ['id' => 910002, 'device_id' => 910002, 'view_id' => 910000, 'x' => 500, 'y' => 400],
            ],
            'links' => [['id' => 910001, 'view_id' => 910000, 'from_id' => 910001, 'to_id' => 910002]],
            'canvas_notes' => [],
        ]]);
    }

    private function removeRouteFixture(array $fixture): void
    {
        $data = $this->load();
        $view = $this->find($data['views'], (int)$fixture['views'][0]['id']);
        $devices = [];
        foreach ($fixture['devices'] as $device) {
            $devices[] = $this->deviceOperation($this->find($data['devices'], (int)$device['id']), 'delete');
        }
        $this->save($devices, [['operation' => 'delete', 'id' => (int)$view['id'], 'expected_revision' => (int)$view['resource_revision']]]);
    }

    public function testManualRouteViewSaveLifecycle(): void
    {
        $fixture = $this->routeFixture('手動経路保持');
        try {
            $viewId = (int)$fixture['views'][0]['id'];
            $linkId = (int)$fixture['links'][0]['id'];
            $this->assertSame('auto', $fixture['links'][0]['route_mode']);
            $this->assertSame([], $fixture['links'][0]['manual_route']);
            $operation = $this->viewOperation($fixture, $fixture['views'][0]);
            $stale = $operation;
            $points = [
                ['x' => 120, 'y' => 10], ['x' => 120, 'y' => 80],
                ['x' => 240, 'y' => 80], ['x' => 240, 'y' => 160],
                ['x' => 360, 'y' => 160], ['x' => 360, 'y' => 240],
                ['x' => 480, 'y' => 240], ['x' => 480, 'y' => 320],
            ];
            $operation['links'][0]['route_mode'] = 'manual';
            $operation['links'][0]['manual_route'] = $points;
            $saved = $this->save([], [$operation]);
            $this->assertSame($points, $this->find($saved['links'], $linkId)['manual_route']);
            $this->assertTrue((int)$saved['views'][0]['resource_revision'] > (int)$operation['expected_revision']);
            $this->client->postJson('/api.php?action=save_resources', ['devices' => [], 'views' => [$stale]])->assertStatus(409);
            $current = $this->load();
            $this->assertSame($points, $this->find($current['links'], $linkId)['manual_route']);
            $moved = $this->viewOperation($current, $this->find($current['views'], $viewId));
            $moved['placements'][0]['x'] = 650;
            $this->save([], [$moved]);
            $current = $this->load();
            $this->assertSame($points, $this->find($current['links'], $linkId)['manual_route']);
            $automatic = $this->viewOperation($current, $this->find($current['views'], $viewId));
            $automatic['links'][0]['route_mode'] = 'auto';
            $automatic['links'][0]['manual_route'] = [];
            $this->save([], [$automatic]);
            $current = $this->load();
            $this->assertSame('auto', $this->find($current['links'], $linkId)['route_mode']);
            $this->assertSame([], $this->find($current['links'], $linkId)['manual_route']);
            // 全体保存経路でも配列のまま往復し、DBのJSON文字列を漏らさない。
            foreach ($current['links'] as &$link) {
                if ((int)$link['id'] === $linkId) {
                    $link['route_mode'] = 'manual';
                    $link['manual_route'] = [['x' => -0.5, 'y' => 25], ['x' => -0.5, 'y' => 75]];
                }
            }
            unset($link);
            $this->client->postJson('/api.php?action=save', array_intersect_key($current,
                array_flip(['revision', 'devices', 'views', 'placements', 'links', 'canvas_notes'])))->assertOk();
            $loaded = $this->find($this->load()['links'], $linkId);
            $this->assertSame('manual', $loaded['route_mode']);
            $this->assertSame([['x' => -0.5, 'y' => 25], ['x' => -0.5, 'y' => 75]], $loaded['manual_route']);
        } finally {
            $this->removeRouteFixture($fixture);
        }
    }

    public function testInvalidManualRouteRollsBackBatch(): void
    {
        $fixture = $this->routeFixture('手動経路検証');
        try {
            $device = $fixture['devices'][0];
            $originalMemo = $device['memo'];
            $device['memo'] = '不正経路と同時には保存しない';
            $operation = $this->viewOperation($fixture, $fixture['views'][0]);
            $revision = (int)$fixture['views'][0]['resource_revision'];
            $invalid = [
                ['route_mode' => 'unknown', 'manual_route' => []],
                ['route_mode' => null, 'manual_route' => []],
                ['route_mode' => 'manual'],
                ['route_mode' => 'manual', 'manual_route' => null],
                ['route_mode' => 'manual', 'manual_route' => '[]'],
                ['route_mode' => 'manual', 'manual_route' => new \stdClass()],
                ['route_mode' => 'manual', 'manual_route' => (object)[0 => ['x' => 1, 'y' => 2]]],
                ['route_mode' => 'auto', 'manual_route' => [['x' => 1, 'y' => 2]]],
                ['route_mode' => 'manual', 'manual_route' => array_fill(0, 9, ['x' => 1, 'y' => 2])],
                ['route_mode' => 'manual', 'manual_route' => [['x' => '1', 'y' => 2]]],
                ['route_mode' => 'manual', 'manual_route' => [['x' => true, 'y' => 2]]],
                ['route_mode' => 'manual', 'manual_route' => [['x' => 1, 'y' => null]]],
                ['route_mode' => 'manual', 'manual_route' => [['x' => 1]]],
                ['route_mode' => 'manual', 'manual_route' => [['x' => 1, 'y' => 2, 'z' => 3]]],
                ['route_mode' => 'manual', 'manual_route' => [['x' => 0, 'y' => 0], ['x' => 1, 'y' => 1]]],
            ];
            foreach ($invalid as $route) {
                $candidate = $operation;
                $candidate['links'][0] = array_merge(array_diff_key($candidate['links'][0],
                    array_flip(['route_mode', 'manual_route'])), $route);
                $this->client->postJson('/api.php?action=save_resources', [
                    'devices' => [$this->deviceOperation($device)], 'views' => [$candidate],
                ])->assertStatus(400);
                $loaded = $this->load();
                $this->assertSame($originalMemo, $this->find($loaded['devices'], (int)$device['id'])['memo']);
                $this->assertSame($revision, (int)$this->find($loaded['views'], (int)$operation['id'])['resource_revision']);
                $this->assertSame('auto', $this->find($loaded['links'], (int)$fixture['links'][0]['id'])['route_mode']);
            }
        } finally {
            $this->removeRouteFixture($fixture);
        }
    }

    public function testVersionSixMigrationPreservesAutoAndTracksRouteChanges(): void
    {
        require_once dirname(__DIR__, 2) . '/src/Core/Database.php';
        $db = new PDO('sqlite::memory:');
        \Netarium\Core\Database::configure($db);
        migrateDatabaseToVersion1($db);
        migrateDatabaseToVersion2($db);
        migrateDatabaseToVersion3($db);
        migrateDatabaseToVersion4($db);
        migrateDatabaseToVersion5($db);
        migrateDatabaseToVersion6($db);
        $db->exec("INSERT INTO devices (id, name, type) VALUES (1, '移行A', 'switch'), (2, '移行B', 'switch')");
        $db->exec("INSERT INTO views (id, name) VALUES (1, '旧経路')");
        $db->exec("INSERT INTO links (id, view_id, from_id, to_id, label) VALUES (1, 1, 1, 2, '既存リンク')");
        $revision = (int)$db->query('SELECT resource_revision FROM views WHERE id = 1')->fetchColumn();
        migrateDatabase($db);
        $link = $db->query('SELECT * FROM links WHERE id = 1')->fetch(PDO::FETCH_ASSOC);
        $this->assertSame('既存リンク', $link['label']);
        $this->assertSame('auto', $link['route_mode']);
        $this->assertSame('[]', $link['manual_route']);
        $this->assertSame($revision, (int)$db->query('SELECT resource_revision FROM views WHERE id = 1')->fetchColumn());
        $db->exec("UPDATE links SET route_mode = 'manual', manual_route = '[{\"x\":10,\"y\":20}]' WHERE id = 1");
        $manualRevision = (int)$db->query('SELECT resource_revision FROM views WHERE id = 1')->fetchColumn();
        $this->assertTrue($manualRevision > $revision);
        migrateDatabaseToVersion7($db);
        $this->assertSame('[{"x":10,"y":20}]', $db->query('SELECT manual_route FROM links WHERE id = 1')->fetchColumn());
        $this->assertSame($manualRevision, (int)$db->query('SELECT resource_revision FROM views WHERE id = 1')->fetchColumn());
        foreach (['{}', 'invalid-json', json_encode(array_fill(0, 9, ['x' => 1, 'y' => 2]))] as $invalid) {
            try {
                $db->prepare('UPDATE links SET manual_route = ? WHERE id = 1')->execute([$invalid]);
                $this->fail('DB制約違反の経路が保存されました');
            } catch (\PDOException $e) {
                $this->assertSame($manualRevision, (int)$db->query('SELECT resource_revision FROM views WHERE id = 1')->fetchColumn());
            }
        }
        $db->exec("UPDATE links SET route_mode = 'auto', manual_route = '[]' WHERE id = 1");
        $this->assertTrue((int)$db->query('SELECT resource_revision FROM views WHERE id = 1')->fetchColumn() > $manualRevision);
    }

    public function testVersionFiveMigrationPreservesExistingData(): void
    {
        require_once dirname(__DIR__, 2) . '/src/Core/Database.php';
        $db = new PDO('sqlite::memory:');
        \Netarium\Core\Database::configure($db);
        migrateDatabaseToVersion1($db);
        migrateDatabaseToVersion2($db);
        migrateDatabaseToVersion3($db);
        migrateDatabaseToVersion4($db);
        migrateDatabaseToVersion5($db);
        $db->exec("INSERT INTO devices (id, name, type) VALUES (123, '移行確認', 'switch')");
        $db->exec("INSERT INTO views (id, name) VALUES (123, '移行ビュー')");
        migrateDatabase($db);
        $this->assertSame(APP_DATABASE_SCHEMA_VERSION, (int)$db->query('PRAGMA user_version')->fetchColumn());
        $this->assertSame('移行確認', $db->query('SELECT name FROM devices WHERE id = 123')->fetchColumn());
        $this->assertTrue((int)$db->query('SELECT resource_revision FROM devices WHERE id = 123')->fetchColumn() > 0);
        $this->assertTrue((int)$db->query('SELECT resource_revision FROM views WHERE id = 123')->fetchColumn() > 0);
        migrateDatabase($db);
        $this->assertSame('移行ビュー', $db->query('SELECT name FROM views WHERE id = 123')->fetchColumn());
    }
    private function noteFixture(string $name): array
    {
        return $this->save([], [[
            'operation' => 'create', 'id' => 920000,
            'view' => ['id' => 920000, 'name' => $name, 'view_type' => 'floor'],
            'placements' => [], 'links' => [],
            'canvas_notes' => [['id' => 920001, 'view_id' => 920000, 'text' => " 行1\n行2 <b>文字</b> ",
                'background_color' => '#fff3b0', 'text_color' => '#abcdef']],
        ]]);
    }

    private function removeNoteFixture(array $fixture): void
    {
        $data = $this->load();
        foreach ($data['views'] as $view) {
            if ((int)$view['id'] === (int)$fixture['views'][0]['id']) {
                $this->save([], [['operation' => 'delete', 'id' => (int)$view['id'],
                    'expected_revision' => (int)$view['resource_revision']]]);
            }
        }
    }

    public function testCanvasNotesRoundTripUpdateDeleteAndViewCascade(): void
    {
        $fixture = $this->noteFixture('メモ保存操作');
        try {
            $viewId = (int)$fixture['views'][0]['id'];
            $noteId = (int)$fixture['id_maps']['canvas_notes'][920001];
            $this->assertNotSame(920001, $noteId);
            $note = $fixture['canvas_notes'][0];
            $this->assertSame($viewId, (int)$note['view_id']);
            $this->assertSame(" 行1\n行2 <b>文字</b> ", $note['text']);
            $this->assertSame('#FFF3B0', $note['background_color']);
            $this->assertSame('#ABCDEF', $note['text_color']);
            $this->assertSame(220.0, (float)$note['width']);
            $this->assertSame(120.0, (float)$note['height']);
            $this->assertSame(0.85, (float)$note['background_opacity']);
            $data = $this->load();
            $operation = $this->viewOperation($data, $this->find($data['views'], $viewId));
            $operation['view']['view_type'] = 'topology';
            $operation['canvas_notes'][0] = array_replace($note, [
                'text' => '', 'x' => 12.5, 'y' => 22, 'width' => 2000, 'height' => 60,
                'background_opacity' => 0.2, 'font_size' => 32, 'text_color' => '#123456',
            ]);
            $saved = $this->save([], [$operation]);
            $this->assertSame($noteId, (int)$saved['canvas_notes'][0]['id']);
            $this->assertSame('', $saved['canvas_notes'][0]['text']);
            $this->assertSame(12.5, (float)$saved['canvas_notes'][0]['x']);
            $this->assertSame(32.0, (float)$saved['canvas_notes'][0]['font_size']);
            $this->assertTrue((int)$saved['views'][0]['resource_revision'] > (int)$operation['expected_revision']);
            $data = $this->load();
            $operation = $this->viewOperation($data, $this->find($data['views'], $viewId));
            $operation['canvas_notes'] = [];
            $this->assertSame([], $this->save([], [$operation])['canvas_notes']);
            $data = $this->load();
            $operation = $this->viewOperation($data, $this->find($data['views'], $viewId));
            $operation['canvas_notes'] = [$note];
            $new = $this->save([], [$operation]);
            $this->assertTrue((int)$new['canvas_notes'][0]['id'] > $noteId);
            $this->removeNoteFixture($fixture);
            $this->assertSame([], array_values(array_filter($this->load()['canvas_notes'],
                static fn($row) => (int)$row['view_id'] === $viewId)));
        } finally {
            $this->removeNoteFixture($fixture);
        }
    }

    public function testCanvasNoteViewConflictsAndViewerCannotSave(): void
    {
        $a = $this->noteFixture('メモ競合A');
        $b = $this->noteFixture('メモ競合B');
        try {
            $data = $this->load();
            $opA = $this->viewOperation($data, $this->find($data['views'], (int)$a['views'][0]['id']));
            $opB = $this->viewOperation($data, $this->find($data['views'], (int)$b['views'][0]['id']));
            $opA['canvas_notes'][0]['text'] = '確定A';
            $this->save([], [$opA]);
            $opB['canvas_notes'][0]['text'] = '独立B';
            // 別ビューの実IDを仮IDとして送っても、そのビューのメモを上書きしない。
            $opB['canvas_notes'][0]['id'] = (int)$a['canvas_notes'][0]['id'];
            $savedB = $this->save([], [$opB], $this->secondClient());
            $this->assertNotSame((int)$a['canvas_notes'][0]['id'], (int)$savedB['canvas_notes'][0]['id']);
            $this->client->postJson('/api.php?action=save_resources', ['devices' => [], 'views' => [$opA]])->assertStatus(409);
            $latest = $this->load();
            $batchB = $this->viewOperation($latest, $this->find($latest['views'], (int)$b['views'][0]['id']));
            $batchB['canvas_notes'][0]['text'] = '競合batchで変更しない';
            $this->client->postJson('/api.php?action=save_resources', ['devices' => [], 'views' => [$opA, $batchB]])->assertStatus(409);
            $this->assertSame('独立B', $this->find($this->load()['canvas_notes'], (int)$savedB['canvas_notes'][0]['id'])['text']);
            $viewer = new TestHttpClient($this->client->getBaseUrl());
            $this->assertTrue($viewer->login('viewer', 'viewer123'));
            $visible = $this->load($viewer);
            $this->assertSame('確定A', $this->find($visible['canvas_notes'], (int)$a['canvas_notes'][0]['id'])['text']);
            $viewer->postJson('/api.php?action=save_resources', ['devices' => [], 'views' => [$opA]])->assertStatus(403);
            $viewer->postJson('/api.php?action=save', $visible)->assertStatus(403);
        } finally {
            $this->removeNoteFixture($a);
            $this->removeNoteFixture($b);
        }
    }

    public function testInvalidCanvasNotesRejectAndRollBackBatch(): void
    {
        $fixture = $this->noteFixture('メモ不正入力');
        try {
            $data = $this->load();
            $view = $this->find($data['views'], (int)$fixture['views'][0]['id']);
            $operation = $this->viewOperation($data, $view);
            $device = $data['devices'][0];
            $device['memo'] = '不正メモと同時に保存しない';
            $invalid = [
                ['x' => -1], ['x' => '10'], ['x' => true], ['x' => null], ['y' => -1],
                ['width' => 119], ['width' => 2001], ['height' => 59], ['height' => 2001],
                ['background_opacity' => 0.19], ['background_opacity' => 1.01],
                ['font_size' => 11], ['font_size' => 33], ['background_color' => '#fff'],
                ['text_color' => 'red'], ['background_color' => null], ['text' => null],
                ['text' => str_repeat('あ', 1001)], ['id' => '12'], ['view_id' => 999999],
            ];
            foreach ($invalid as $change) {
                $candidate = $operation;
                $candidate['canvas_notes'][0] = array_replace($candidate['canvas_notes'][0], $change);
                $this->client->postJson('/api.php?action=save_resources', [
                    'devices' => [$this->deviceOperation($device)], 'views' => [$candidate],
                ])->assertStatus(400);
                $loaded = $this->load();
                $this->assertSame((int)$data['revision'], (int)$loaded['revision']);
                $this->assertSame($data['devices'][0]['memo'], $this->find($loaded['devices'], (int)$device['id'])['memo']);
                $this->assertSame($data['canvas_notes'], $loaded['canvas_notes']);
            }
            $duplicate = $operation;
            $duplicate['canvas_notes'][] = $duplicate['canvas_notes'][0];
            $this->client->postJson('/api.php?action=save_resources', ['devices' => [], 'views' => [$duplicate]])->assertStatus(400);
            $missing = $operation;
            unset($missing['canvas_notes']);
            $this->client->postJson('/api.php?action=save_resources', ['devices' => [], 'views' => [$missing]])->assertStatus(400);
            $nonfinite = $operation;
            $nonfinite['canvas_notes'][0]['x'] = '__NONFINITE__';
            $json = str_replace('"__NONFINITE__"', '1e309', json_encode(['devices' => [], 'views' => [$nonfinite]]));
            $this->client->request('POST', '/api.php?action=save_resources', $json, [
                'Content-Type' => 'application/json', 'X-CSRF-Token' => $this->client->getCsrfToken(),
            ])->assertStatus(400);
            $this->assertSame((int)$data['revision'], (int)$this->load()['revision']);
            $candidate = $data;
            $candidate['canvas_notes'][0]['x'] = -1;
            $this->client->postJson('/api.php?action=save', $candidate)->assertStatus(400);
            $this->assertSame((int)$data['revision'], (int)$this->load()['revision']);
            // トランザクション内で採番した後の重複エラーでもカウンターを含めて戻す。
            $newNote = ['id' => 960001, 'view_id' => (int)$view['id'], 'text' => '採番rollback'];
            $duplicateNew = $operation;
            $duplicateNew['canvas_notes'] = [$newNote, $newNote];
            $this->client->postJson('/api.php?action=save_resources', ['devices' => [], 'views' => [$duplicateNew]])->assertStatus(400);
            $this->assertSame((int)$data['revision'], (int)$this->load()['revision']);
            $next = $operation;
            $next['canvas_notes'][] = $newNote;
            $saved = $this->save([], [$next]);
            $this->assertSame((int)$fixture['canvas_notes'][0]['id'] + 1, (int)$saved['id_maps']['canvas_notes'][960001]);
        } finally {
            $this->removeNoteFixture($fixture);
        }
    }

    public function testFullSaveCanvasNotesUsesSafeIdsAndPreservesText(): void
    {
        $fixture = $this->noteFixture('メモ全体保存');
        try {
            $data = $this->load();
            $data['canvas_notes'][] = ['id' => 930001, 'view_id' => (int)$fixture['views'][0]['id'],
                'text' => str_repeat('𠀀', 1000)];
            $saved = $this->client->postJson('/api.php?action=save', $data)->assertOk()->getJson();
            $id = (int)$saved['id_maps']['canvas_notes'][930001];
            $this->assertNotSame(930001, $id);
            $this->assertSame(str_repeat('𠀀', 1000), $this->find($saved['canvas_notes'], $id)['text']);
            $this->assertSame($fixture['canvas_notes'][0]['text'],
                $this->find($saved['canvas_notes'], (int)$fixture['canvas_notes'][0]['id'])['text']);
            $loaded = $this->load();
            $this->assertSame($saved['canvas_notes'], $loaded['canvas_notes']);
            foreach ([[], ['canvas_notes' => null], ['canvas_notes' => 'invalid'],
                ['canvas_notes' => ['unexpected' => []]]] as $invalidNotes) {
                $candidate = array_replace($loaded, $invalidNotes);
                if (!array_key_exists('canvas_notes', $invalidNotes)) {
                    unset($candidate['canvas_notes']);
                }
                $this->client->postJson('/api.php?action=save', $candidate)->assertStatus(400);
                $unchanged = $this->load();
                $this->assertSame($loaded['canvas_notes'], $unchanged['canvas_notes']);
                $this->assertSame($loaded['views'], $unchanged['views']);
                $this->assertSame($loaded['revision'], $unchanged['revision']);
            }
            $loaded['canvas_notes'] = array_values(array_filter($loaded['canvas_notes'], static fn($row) => (int)$row['id'] !== $id));
            $deleted = $this->client->postJson('/api.php?action=save', $loaded)->assertOk()->getJson();
            $this->assertSame($loaded['canvas_notes'], $deleted['canvas_notes']);
        } finally {
            $this->removeNoteFixture($fixture);
        }
    }

    public function testVersionSevenMigrationAddsNotesAndOwnerTriggers(): void
    {
        require_once dirname(__DIR__, 2) . '/src/Core/Database.php';
        $db = new PDO('sqlite::memory:');
        \Netarium\Core\Database::configure($db);
        foreach (range(1, 7) as $version) {
            ('migrateDatabaseToVersion' . $version)($db);
        }
        $db->exec("INSERT INTO views (id, name) VALUES (1, '移行前A'), (2, '移行前B')");
        $before = $db->query('SELECT id, resource_revision FROM views ORDER BY id')->fetchAll(PDO::FETCH_KEY_PAIR);
        migrateDatabase($db);
        $this->assertSame(0, (int)$db->query('SELECT COUNT(*) FROM canvas_notes')->fetchColumn());
        $this->assertSame($before, $db->query('SELECT id, resource_revision FROM views ORDER BY id')->fetchAll(PDO::FETCH_KEY_PAIR));
        $db->exec("INSERT INTO canvas_notes (id, view_id, text) VALUES (123, 1, '移行後')");
        $this->assertSame(123, (int)$db->query("SELECT value FROM resource_sequences WHERE name = 'canvas_notes'")->fetchColumn());
        $insertRevision = (int)$db->query('SELECT resource_revision FROM views WHERE id = 1')->fetchColumn();
        $this->assertTrue($insertRevision > (int)$before[1]);
        $db->exec('UPDATE canvas_notes SET view_id = 2 WHERE id = 123');
        $this->assertTrue((int)$db->query('SELECT resource_revision FROM views WHERE id = 1')->fetchColumn() > $insertRevision);
        $this->assertTrue((int)$db->query('SELECT resource_revision FROM views WHERE id = 2')->fetchColumn() > (int)$before[2]);
        migrateDatabaseToVersion8($db);
        $this->assertSame('移行後', $db->query('SELECT text FROM canvas_notes WHERE id = 123')->fetchColumn());
        foreach (["x = -1", "width = 119", "background_color = '#fff3b0'", 'background_opacity = 0.1', 'font_size = 33'] as $assignment) {
            try {
                $db->exec("UPDATE canvas_notes SET {$assignment} WHERE id = 123");
                $this->fail('不正メモがDBに保存されました');
            } catch (\PDOException $e) {
                $this->assertSame('移行後', $db->query('SELECT text FROM canvas_notes WHERE id = 123')->fetchColumn());
            }
        }
        $beforeDelete = (int)$db->query('SELECT resource_revision FROM views WHERE id = 2')->fetchColumn();
        $db->exec('DELETE FROM canvas_notes WHERE id = 123');
        $this->assertTrue((int)$db->query('SELECT resource_revision FROM views WHERE id = 2')->fetchColumn() > $beforeDelete);
        $db->exec("INSERT INTO canvas_notes (id, view_id, text) VALUES (124, 2, '連鎖削除')");
        $db->exec('DELETE FROM views WHERE id = 2');
        $this->assertSame(0, (int)$db->query('SELECT COUNT(*) FROM canvas_notes')->fetchColumn());
        $this->assertSame(124, (int)$db->query("SELECT value FROM resource_sequences WHERE name = 'canvas_notes'")->fetchColumn());
    }
    public function testLinkSystemMasterAndAssignmentRevisionsAreIndependent(): void
    {
        $server = new \Netarium\Tests\TestServer();
        $originalClient = $this->client;
        try {
            $server->start();
            $this->client = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($this->client->login('admin', 'admin123'));
            $this->checkLinkSystemMasterAndAssignmentRevisions();
        } finally {
            $this->client = $originalClient;
            $server->stop();
        }
    }

    public function testLinkSystemCreateReturnsItsOwnIdForDuplicateNames(): void
    {
        $server = new \Netarium\Tests\TestServer();
        $originalClient = $this->client;
        try {
            $server->start();
            $this->client = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($this->client->login('admin', 'admin123'));
            $first = $this->client->postJson('/api.php?action=create_link_system', [
                'name' => '同名系統', 'color_key' => 'indigo',
            ])->assertOk()->getJson();
            $original = $this->find($first['link_systems'], $first['created_id']);
            $second = $this->client->postJson('/api.php?action=create_link_system', [
                'name' => '同名系統', 'color_key' => 'teal',
            ])->assertOk()->getJson();
            $this->assertNotSame($first['created_id'], $second['created_id']);
            $created = $this->find($second['link_systems'], $second['created_id']);
            $this->assertSame('同名系統', $created['name']);
            $this->assertSame('teal', $created['color_key']);
            $this->assertSame($original, $this->find($second['link_systems'], $first['created_id']));
            $updated = $this->client->postJson('/api.php?action=update_link_system', [
                'id' => $second['created_id'], 'expected_revision' => (int)$created['resource_revision'],
                'name' => '新規系統を変更', 'color_key' => 'violet',
            ])->assertOk()->getJson();
            $changed = $this->find($updated['link_systems'], $second['created_id']);
            $this->assertSame('新規系統を変更', $changed['name']);
            $this->assertSame('violet', $changed['color_key']);
            $this->assertSame($original, $this->find($updated['link_systems'], $first['created_id']));
            $deleted = $this->client->postJson('/api.php?action=delete_link_system', [
                'id' => $second['created_id'], 'expected_revision' => (int)$changed['resource_revision'],
            ])->assertOk()->getJson();
            $this->assertSame([$original], $deleted['link_systems']);
        } finally {
            $this->client = $originalClient;
            $server->stop();
        }
    }

    private function checkLinkSystemMasterAndAssignmentRevisions(): void
    {
        $before = $this->load();
        $created = $this->client->postJson('/api.php?action=create_link_system', [
            'name' => '  基幹接続  ', 'color_key' => 'indigo',
        ])->assertOk()->getJson();
        $system = $created['link_systems'][count($created['link_systems']) - 1];
        $id = (int)$system['id'];
        try {
            $this->assertSame('基幹接続', $system['name']);
            $this->assertSame(0, (int)$system['usage_count']);
            $this->assertSame($before['views'], $this->load()['views']);
            $updated = $this->client->postJson('/api.php?action=update_link_system', [
                'id' => $id, 'expected_revision' => (int)$system['resource_revision'],
                'name' => '更新済み系統', 'color_key' => 'teal',
            ])->assertOk()->getJson();
            $currentSystem = $this->find($updated['link_systems'], $id);
            $this->assertTrue((int)$currentSystem['resource_revision'] > (int)$system['resource_revision']);
            $this->assertSame($before['views'], $this->load()['views']);
            foreach (['update_link_system', 'delete_link_system'] as $action) {
                $this->client->postJson('/api.php?action=' . $action, [
                    'id' => $id, 'expected_revision' => (int)$system['resource_revision'],
                    'name' => '古い変更', 'color_key' => 'cyan',
                ])->assertStatus(409);
            }
            $data = $this->load();
            $link = $data['links'][0];
            $view = $this->find($data['views'], (int)$link['view_id']);
            $operation = $this->viewOperation($data, $view);
            $operation['links'][0]['system_id'] = $id;
            $saved = $this->save([], [$operation]);
            $this->assertSame($id, (int)$saved['links'][0]['system_id']);
            $this->assertTrue((int)$saved['views'][0]['resource_revision'] > (int)$view['resource_revision']);
            $this->assertSame(1, (int)$this->find($this->client->get('/api.php?action=list_link_systems')->assertOk()->getJson()['link_systems'], $id)['usage_count']);
            $this->client->postJson('/api.php?action=delete_link_system', [
                'id' => $id, 'expected_revision' => (int)$currentSystem['resource_revision'],
            ])->assertStatus(400);

            $data = $this->load();
            foreach ([0, -1, '1', 1.5, true, [], 2147483647] as $invalid) {
                $op = $this->viewOperation($data, $this->find($data['views'], (int)$link['view_id']));
                $op['links'][0]['system_id'] = $invalid;
                $device = $data['devices'][0];
                $device['memo'] = '失敗するbatch';
                $this->client->postJson('/api.php?action=save_resources', [
                    'devices' => [$this->deviceOperation($device)], 'views' => [$op],
                ])->assertStatus(400);
                $this->assertSame($data, $this->load(), '未知・不正参照でbatch全体をrollback');
                $full = $data;
                $full['links'][0]['system_id'] = $invalid;
                $this->client->postJson('/api.php?action=save', $full)->assertStatus(400);
                $this->assertSame($data, $this->load());
            }
            $data['links'][0]['system_id'] = null;
            $full = $this->client->postJson('/api.php?action=save', $data)->assertOk()->getJson();
            $this->assertNull($full['links'][0]['system_id']);
            $this->assertSame($currentSystem['resource_revision'], $this->find($full['link_systems'], $id)['resource_revision']);
        } finally {
            $data = $this->load();
            foreach ($data['links'] as &$link) {
                if (($link['system_id'] ?? null) === $id) {
                    $link['system_id'] = null;
                }
            }
            unset($link);
            $this->client->postJson('/api.php?action=save', $data)->assertOk();
            $systems = $this->client->get('/api.php?action=list_link_systems')->assertOk()->getJson()['link_systems'];
            $system = $this->find($systems, $id);
            $this->client->postJson('/api.php?action=delete_link_system', [
                'id' => $id, 'expected_revision' => (int)$system['resource_revision'],
            ])->assertOk();
        }
    }

    public function testLinkSystemValidationAuthorizationAndMethods(): void
    {
        $before = $this->load();
        foreach (['', "　 \n ", str_repeat('接', 101), 123, []] as $name) {
            $this->client->postJson('/api.php?action=create_link_system', ['name' => $name, 'color_key' => 'indigo'])->assertStatus(400);
        }
        foreach (['red', '', null, []] as $color) {
            $this->client->postJson('/api.php?action=create_link_system', ['name' => '試験', 'color_key' => $color])->assertStatus(400);
        }
        $this->assertSame($before, $this->load());
        $viewer = new TestHttpClient($this->client->getBaseUrl());
        $this->assertTrue($viewer->login('viewer', 'viewer123'));
        $viewer->get('/api.php?action=list_link_systems')->assertOk();
        foreach (['create_link_system', 'update_link_system', 'delete_link_system'] as $action) {
            $viewer->postJson('/api.php?action=' . $action, ['name' => '禁止', 'color_key' => 'teal'])->assertStatus(403);
            $this->client->get('/api.php?action=' . $action)->assertStatus(405);
            $this->client->postJson('/api.php?action=' . $action, [], ['X-CSRF-Token' => 'invalid'])->assertStatus(403);
        }
        $this->client->postJson('/api.php?action=list_link_systems', [])->assertStatus(405);
        $valid = $this->client->postJson('/api.php?action=create_link_system', [
            'name' => str_repeat('接', 100), 'color_key' => 'olive',
        ])->assertOk()->getJson();
        $system = $valid['link_systems'][count($valid['link_systems']) - 1];
        foreach ([0, '1', true, 1.5] as $invalid) {
            $this->client->postJson('/api.php?action=delete_link_system', [
                'id' => $invalid, 'expected_revision' => (int)$system['resource_revision'],
            ])->assertStatus(400);
            $this->client->postJson('/api.php?action=delete_link_system', [
                'id' => (int)$system['id'], 'expected_revision' => $invalid,
            ])->assertStatus(400);
        }
        $this->client->postJson('/api.php?action=delete_link_system', [
            'id' => (int)$system['id'], 'expected_revision' => (int)$system['resource_revision'],
        ])->assertOk();
    }

    public function testVersionEightMigrationPreservesLinksAndViewRevisions(): void
    {
        require_once dirname(__DIR__, 2) . '/src/Core/Database.php';
        $db = new PDO('sqlite::memory:');
        \Netarium\Core\Database::configure($db);
        foreach (range(1, 8) as $version) {
            ('migrateDatabaseToVersion' . $version)($db);
        }
        $db->exec("INSERT INTO views (id, name) VALUES (1, '既存ビュー')");
        $db->exec("INSERT INTO devices (id, name) VALUES (1, '機器A'), (2, '機器B')");
        $db->exec("INSERT INTO links (id, view_id, from_id, to_id, label) VALUES (1, 1, 1, 2, '既存接続')");
        $before = $db->query('SELECT * FROM links')->fetchAll(PDO::FETCH_ASSOC);
        $revision = $db->query('SELECT resource_revision FROM views WHERE id = 1')->fetchColumn();
        migrateDatabase($db);
        $after = $db->query('SELECT * FROM links')->fetchAll(PDO::FETCH_ASSOC);
        $this->assertNull($after[0]['system_id']);
        unset($after[0]['system_id']);
        $this->assertSame($before, $after);
        $this->assertSame($revision, $db->query('SELECT resource_revision FROM views WHERE id = 1')->fetchColumn());
        $db->exec("INSERT INTO link_systems (id, name, color_key) VALUES (1, '共通', 'cyan')");
        $db->exec("UPDATE link_systems SET color_key = 'brown' WHERE id = 1");
        $this->assertSame($revision, $db->query('SELECT resource_revision FROM views WHERE id = 1')->fetchColumn());
        $db->exec('UPDATE links SET system_id = 1 WHERE id = 1');
        $this->assertTrue((int)$db->query('SELECT resource_revision FROM views WHERE id = 1')->fetchColumn() > (int)$revision);
        $db->exec("INSERT INTO views (id, name) VALUES (2, '別ビュー')");
        $db->exec('INSERT INTO links (id, view_id, from_id, to_id, system_id) VALUES (2, 2, 1, 2, 1)');
        $this->assertSame(2, (int)(new \Netarium\Services\Topology\LinkSystemService($db))->list()['link_systems'][0]['usage_count']);
        try {
            $db->exec('DELETE FROM link_systems WHERE id = 1');
            $this->fail('使用中マスタの参照整合が保護されていません');
        } catch (\PDOException $e) {
            $this->assertSame(1, (int)$db->query('SELECT system_id FROM links WHERE id = 1')->fetchColumn());
        }
        migrateDatabaseToVersion9($db);
        $this->assertSame('共通', $db->query('SELECT name FROM link_systems WHERE id = 1')->fetchColumn());
    }
    public function testLinkSystemUpdateAllowsRevisionExceedingIdLimit(): void
    {
        $server = new \Netarium\Tests\TestServer();
        $originalClient = $this->client;
        try {
            $server->start();
            $this->client = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($this->client->login('admin', 'admin123'));
            $db = new PDO('sqlite:' . $server->getDbPath());
            $created = $this->client->postJson('/api.php?action=create_link_system', [
                'name' => '世代上限超過系統', 'color_key' => 'indigo',
            ])->assertOk()->getJson();
            $system = $created['link_systems'][count($created['link_systems']) - 1];
            $id = (int)$system['id'];
            // 世代番号を ID 上限 (9007199254740991) より大きい値に設定
            $hugeRevision = \Netarium\Core\ResourceId::MAX + 100;
            $db->exec("UPDATE link_systems SET resource_revision = {$hugeRevision} WHERE id = {$id}");
            // expected_revision が ID 上限を超えていても、正の整数として受理される
            $updated = $this->client->postJson('/api.php?action=update_link_system', [
                'id' => $id,
                'expected_revision' => $hugeRevision,
                'name' => '世代更新成功',
                'color_key' => 'teal',
            ])->assertOk()->getJson();
            $current = $this->find($updated['link_systems'], $id);
            $this->assertSame('世代更新成功', $current['name']);
            // 不一致なら 409
            $this->client->postJson('/api.php?action=update_link_system', [
                'id' => $id,
                'expected_revision' => $hugeRevision,
                'name' => '競合',
                'color_key' => 'cyan',
            ])->assertStatus(409);
        } finally {
            $this->client = $originalClient;
            $db = null;
            $server->stop();
        }
    }

    public function testNormalizeLedgerTextUnicodeCodepointSafety(): void
    {
        // 38個の4バイト文字（38コードポイント、152バイト）。上限150文字で切断されず完全に保持される
        $surrogate38 = str_repeat('𠀀', 38);
        $normalized = \Netarium\Core\Request::normalizeLedgerText($surrogate38, 150);
        $this->assertSame($surrogate38, $normalized);
        $this->assertSame(152, strlen($normalized));
        $this->assertSame(1, preg_match('//u', $normalized));

        // 151個の4バイト文字（151コードポイント、604バイト）。正確に150文字（600バイト）へ切り詰められ、不正UTF-8にならない
        $surrogate151 = str_repeat('𠀀', 151);
        $truncated = \Netarium\Core\Request::normalizeLedgerText($surrogate151, 150);
        $this->assertSame(str_repeat('𠀀', 150), $truncated);
        $this->assertSame(600, strlen($truncated));
        $this->assertSame(1, preg_match('//u', $truncated));

        // 改行を含む複合テキスト
        $multiline = "1行目\r\n2行目\n" . str_repeat('界', 150);
        $normMulti = \Netarium\Core\Request::normalizeLedgerText($multiline, 20);
        $this->assertSame(1, preg_match('//u', $normMulti));

        // 境界値
        $this->assertSame('', \Netarium\Core\Request::normalizeLedgerText('abc', 0));
        $this->assertSame('', \Netarium\Core\Request::normalizeLedgerText('abc', -1));
        $this->assertSame('', \Netarium\Core\Request::normalizeLedgerText([], 10));
    }

    public function testUnicodeFallbacksPreserveSavedLocationsAndBackupRoundTrips(): void
    {
        $root = dirname(__DIR__, 2);
        $script = <<<'PHP'
require 'tests/TestCase.php';
require 'tests/TestHttpClient.php';
require 'tests/TestServer.php';
require 'tests/suites/ResourceSaveTest.php';
require 'tests/suites/CsvTest.php';
require 'tests/suites/BackupTest.php';
$server = new \Netarium\Tests\TestServer(getcwd(), getenv('NETARIUM_TEST_UNICODE_GUARD'));
try {
    $server->start();
    $client = new \Netarium\Tests\TestHttpClient($server->getBaseUrl());
    if (!$client->login('admin', 'admin123')) {
        throw new \RuntimeException('Synthetic login failed');
    }
    $resources = new \Netarium\Tests\Suites\ResourceSaveTest($client);
    $resources->testNormalizeLedgerTextUnicodeCodepointSafety();
    $csv = new \Netarium\Tests\Suites\CsvTest($client);
    $csv->testGetUtf8TextLengthCodepointAccuracy();
    // Exercise save/load/ZIP preview/restore at the 150-codepoint boundary.
    $backup = new \Netarium\Tests\Suites\BackupTest($client);
    $backup->testSavedLocationBoundariesRoundTripThroughBackup();
    $device = $client->get('/api.php?action=load')->assertOk()->getJson()['devices'][0];
    $value = str_repeat("\u{20000}", 38);
    $device['location'] = $value;
    $client->postJson('/api.php?action=save_resources', [
        'devices' => [['operation' => 'update', 'id' => $device['id'],
            'expected_revision' => $device['resource_revision'], 'device' => $device]],
        'views' => [],
    ])->assertOk();
    if ($client->get('/api.php?action=load')->assertOk()->getJson()['devices'][0]['location'] !== $value) {
        throw new \RuntimeException('38-codepoint location was corrupted');
    }
    $path = $server->getTempDir() . '/unicode-fallback.zip';
    file_put_contents($path, $client->postJson('/api.php?action=export_backup_zip', [])->assertStatus(200)->getBody());
    $zip = new \ZipArchive();
    if ($zip->open($path) !== true) {
        throw new \RuntimeException('Backup ZIP is invalid');
    }
    try {
        $data = json_decode($zip->getFromName('data/netarium.json'), true, 512, JSON_THROW_ON_ERROR);
        if ($data['tables']['devices'][0]['location'] !== $value) {
            throw new \RuntimeException('Backup location was corrupted');
        }
    } finally {
        $zip->close();
    }
    $preview = $client->postMultipart('/api.php?action=preview_backup_restore', [],
        ['backup_zip' => ['path' => $path, 'filename' => 'unicode.zip', 'type' => 'application/zip']])->assertOk()->getJson();
    $client->postJson('/api.php?action=commit_backup_restore', [
        'restore_token' => $preview['restore_token'], 'confirmation' => 'バックアップから復元',
    ])->assertOk();
    if ($client->get('/api.php?action=load')->assertOk()->getJson()['devices'][0]['location'] !== $value) {
        throw new \RuntimeException('Restored location was corrupted');
    }
} finally {
    $server->stop();
}
PHP;
        foreach (['mb_substr,mb_strlen', 'mb_substr,mb_strlen,iconv_substr,iconv_strlen'] as $disabled) {
            $directory = sys_get_temp_dir() . '/netarium-unicode-fallback-' . bin2hex(random_bytes(8));
            mkdir($directory, 0700);
            $ini = $directory . '/fallback.ini';
            $guard = $directory . '/guard.php';
            $functions = array_unique(array_filter(array_merge(
                explode(',', (string)ini_get('disable_functions')), explode(',', $disabled)
            )));
            file_put_contents($ini, 'disable_functions="' . implode(',', $functions) . '"' . "\n");
            file_put_contents($guard, '<?php foreach (' . var_export(explode(',', $disabled), true)
                . ' as $function) { if (function_exists($function)) { throw new \RuntimeException("Fallback is not active: " . $function); } }');
            $environment = getenv();
            $environment['PHP_INI_SCAN_DIR'] = (getenv('PHP_INI_SCAN_DIR') ?: '') . PATH_SEPARATOR . $directory;
            $environment['NETARIUM_TEST_UNICODE_GUARD'] = $guard;
            try {
                $process = proc_open([PHP_BINARY, '-r', 'require getenv("NETARIUM_TEST_UNICODE_GUARD");' . $script],
                    [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, $root, $environment);
                if (!is_resource($process)) {
                    throw new \RuntimeException('Cannot start isolated Unicode regression');
                }
                fclose($pipes[0]);
                $output = stream_get_contents($pipes[1]) . stream_get_contents($pipes[2]);
                fclose($pipes[1]);
                fclose($pipes[2]);
                $this->assertSame(0, proc_close($process), $disabled . ': ' . $output);
            } finally {
                unlink($guard);
                unlink($ini);
                rmdir($directory);
            }
        }
    }

}
