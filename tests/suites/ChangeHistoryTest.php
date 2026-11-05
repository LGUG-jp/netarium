<?php
declare(strict_types=1);

namespace Netarium\Tests\Suites;

use Netarium\Tests\TestCase;
use Netarium\Tests\TestHttpClient;
use Netarium\Tests\TestServer;
use PDO;

class ChangeHistoryTest extends TestCase
{
    public function __construct(private TestHttpClient $client) {}

    private function fixture(callable $run): void
    {
        $server = new TestServer();
        try {
            $server->start();
            $admin = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($admin->login('admin', 'admin123'));
            $viewer = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($viewer->login('viewer', 'viewer123'));
            $db = new PDO('sqlite:' . $server->getDbPath());
            $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
            $run($admin, $viewer, $db, $server);
        } finally {
            $server->stop();
        }
    }

    private function history(TestHttpClient $client, string $query = ''): array
    {
        $suffix = $query !== '' ? '&' . ltrim($query, '&') : '';
        return $client->get('/api.php?action=load_change_history' . $suffix)->assertOk()->getJson();
    }

    public function testViewerAccessDeniedAndLoadExcludesChangeHistory(): void
    {
        $this->fixture(function (TestHttpClient $admin, TestHttpClient $viewer, PDO $db, TestServer $server): void {
            $unauth = new TestHttpClient($server->getBaseUrl());
            $unauth->get('/api.php?action=load_change_history')->assertStatus(401);
            $viewer->get('/api.php?action=load_change_history')->assertStatus(403);
            $viewer->get('/api.php?action=load_change_history&target_type=device&target_id=1')->assertStatus(403);
            $admin->postJson('/api.php?action=load_change_history', [])->assertStatus(405);

            // 機器作成で履歴が存在しても、通常の load 応答に change_history を混入させない
            $admin->postJson('/api.php?action=save_resources', [
                'devices' => [[
                    'operation' => 'create',
                    'id' => 910001,
                    'device' => ['name' => '秘匿境界確認SW', 'type' => 'switch', 'ip' => '192.0.2.10'],
                ]],
                'views' => [],
            ])->assertOk();

            $adminLoad = $admin->get('/api.php?action=load')->assertOk()->getJson();
            $viewerLoad = $viewer->get('/api.php?action=load')->assertOk()->getJson();
            $this->assertFalse(array_key_exists('change_history', $adminLoad));
            $this->assertFalse(array_key_exists('change_history', $viewerLoad));

            // 秘密値（password_hash等）がDB履歴に含まれないこと
            $hashes = $db->query('SELECT password_hash FROM users')->fetchAll(PDO::FETCH_COLUMN);
            $rawHistory = json_encode($db->query('SELECT * FROM change_history')->fetchAll(PDO::FETCH_ASSOC));
            foreach ($hashes as $hash) {
                $this->assertFalse(str_contains((string)$rawHistory, (string)$hash));
            }
        });
    }

    public function testDeviceCrudAdditionalIpsWhitelistAndDeletedUserPreservation(): void
    {
        $this->fixture(function (TestHttpClient $admin, TestHttpClient $viewer, PDO $db): void {
            $db->exec("DELETE FROM change_history");

            // 1. 機器作成（追加IPv4・管理情報含む）
            $created = $admin->postJson('/api.php?action=save_resources', [
                'devices' => [[
                    'operation' => 'create',
                    'id' => 910101,
                    'device' => [
                        'name' => 'Core-SW-01',
                        'type' => 'l3_switch',
                        'ip' => '192.0.2.1',
                        'x' => 555,
                        'y' => 777,
                        'facility' => '本庁舎',
                        'floor' => '3F',
                        'location' => '電算室A',
                        'manufacturer' => 'ExampleCorp',
                        'model' => 'EX-4800',
                        'department' => '情報政策課',
                        'management_scheme' => 'ssh',
                        'management_port' => 2222,
                        'additional_ips' => [
                            ['ip' => '192.0.2.2', 'label' => '保守系', 'sort_order' => 0],
                        ],
                    ],
                ]],
                'views' => [],
            ])->assertOk()->getJson();

            $deviceId = (int)$created['id_maps']['devices']['910101'];
            $device = $created['devices'][0];
            $this->assertTrue(is_string($created['request_id'] ?? null) && $created['request_id'] !== '');

            $list1 = $this->history($admin, "target_type=device&target_id={$deviceId}");
            $this->assertSame(1, $list1['total']);
            $entry1 = $list1['items'][0];
            $this->assertSame('create', $entry1['operation']);
            $this->assertSame('Core-SW-01', $entry1['target_name']);
            $this->assertTrue($entry1['target_exists']);
            $this->assertSame('admin', $entry1['actor_name']);
            $this->assertSame($created['request_id'], $entry1['request_id']);

            $labels1 = array_column($entry1['items'], 'after', 'label');
            $this->assertSame('L3スイッチ', $labels1['種別']);
            $this->assertSame('192.0.2.1', $labels1['管理IP']);
            $this->assertSame('192.0.2.2 (保守系)', $labels1['追加IPv4']);
            $this->assertSame('ssh:2222', $labels1['管理接続']);
            // x/y 互換列や resource_revision はホワイトリスト外
            $this->assertFalse(isset($labels1['x']));
            $this->assertFalse(isset($labels1['resource_revision']));

            // 2. 実差分がない保存（no-op: x/y互換列のみ変更）は履歴を増やさない
            $noop = $admin->postJson('/api.php?action=save_resources', [
                'devices' => [[
                    'operation' => 'update',
                    'id' => $deviceId,
                    'expected_revision' => $device['resource_revision'],
                    'device' => array_replace($device, ['x' => 999, 'y' => 888]),
                ]],
                'views' => [],
            ])->assertOk()->getJson();
            $device = $noop['devices'][0];
            $this->assertSame(1, $this->history($admin, "target_type=device&target_id={$deviceId}")['total']);

            // 3. 409競合および400入力エラーでは履歴を記録しない
            $admin->postJson('/api.php?action=save_resources', [
                'devices' => [[
                    'operation' => 'update',
                    'id' => $deviceId,
                    'expected_revision' => 999999,
                    'device' => array_replace($device, ['name' => '競合変更']),
                ]],
                'views' => [],
            ])->assertStatus(409);

            $admin->postJson('/api.php?action=save_resources', [
                'devices' => [[
                    'operation' => 'update',
                    'id' => $deviceId,
                    'expected_revision' => $device['resource_revision'],
                    'device' => array_replace($device, ['ip' => '999.999.999.999']),
                ]],
                'views' => [],
            ])->assertStatus(400);
            $this->assertSame(1, $this->history($admin, "target_type=device&target_id={$deviceId}")['total']);

            // 4. 主要項目と追加IPの更新
            $updated = $admin->postJson('/api.php?action=save_resources', [
                'devices' => [[
                    'operation' => 'update',
                    'id' => $deviceId,
                    'expected_revision' => $device['resource_revision'],
                    'device' => array_replace($device, [
                        'name' => 'Core-SW-01-Renamed',
                        'ip' => '192.0.2.10',
                        'location' => '電算室B',
                        'additional_ips' => [
                            ['ip' => '192.0.2.20', 'label' => '監視系', 'sort_order' => 0],
                        ],
                    ]),
                ]],
                'views' => [],
            ])->assertOk()->getJson();
            $device = $updated['devices'][0];

            $list2 = $this->history($admin, "target_type=device&target_id={$deviceId}");
            $this->assertSame(2, $list2['total']);
            $latest = $list2['items'][0];
            $this->assertSame('update', $latest['operation']);
            $this->assertSame('Core-SW-01-Renamed', $latest['target_name']);
            $byLabel = array_column($latest['items'], null, 'label');
            $this->assertSame('Core-SW-01', $byLabel['名称']['before']);
            $this->assertSame('Core-SW-01-Renamed', $byLabel['名称']['after']);
            $this->assertSame('192.0.2.1', $byLabel['管理IP']['before']);
            $this->assertSame('192.0.2.10', $byLabel['管理IP']['after']);
            $this->assertSame('192.0.2.2 (保守系)', $byLabel['追加IPv4']['before']);
            $this->assertSame('192.0.2.20 (監視系)', $byLabel['追加IPv4']['after']);

            // 操作者ユーザーが改名・削除された後も履歴上の actor_name が保持され検索可能
            $db->exec("INSERT INTO change_history (event_id, request_id, occurred_at, actor_user_id, actor_name, target_type, target_id, target_name, operation, summary, changes_json)
                VALUES (900, '', '" . gmdate('Y-m-d\TH:i:s\Z') . "', 9999, 'retired-operator', 'device', {$deviceId}, 'Core-SW-01-Renamed', 'update', '担当者変更', '{\"items\":[{\"label\":\"備考\",\"before\":\"—\",\"after\":\"確認済\"}]}')");
            $filteredByRetired = $this->history($admin, 'actor=retired-operator');
            $this->assertSame(1, $filteredByRetired['total']);
            $this->assertSame('retired-operator', $filteredByRetired['items'][0]['actor_name']);
            $this->assertTrue(in_array('retired-operator', $filteredByRetired['actors'], true));
        });
    }

    public function testRackMountsShelvesTransfersFloorMovesAndDeviceDeletionCascade(): void
    {
        $this->fixture(function (TestHttpClient $admin, TestHttpClient $viewer, PDO $db): void {
            $db->exec('DELETE FROM change_history');

            // 機器2台 + ラック2本 + フロア2枚を作成
            $setup = $admin->postJson('/api.php?action=save_resources', [
                'devices' => [
                    ['operation' => 'create', 'id' => 920001, 'device' => ['name' => 'Rack-Server-1', 'type' => 'server', 'ip' => '198.51.100.11']],
                    ['operation' => 'create', 'id' => 920002, 'device' => ['name' => 'Shelf-Modem-1', 'type' => 'router', 'ip' => '198.51.100.12']],
                ],
                'views' => [
                    [
                        'operation' => 'create', 'id' => 930001,
                        'view' => ['name' => 'Rack-A', 'view_type' => 'rack', 'facility' => '東館', 'floor' => '2F', 'sort_order' => 10, 'memo' => ''],
                        'placements' => [], 'links' => [], 'canvas_notes' => [],
                        'rack_settings' => ['total_u' => 42, 'location' => '列1'],
                        'rack_mounts' => [
                            ['device_id' => 920001, 'face' => 'front', 'start_u' => 10, 'height_u' => 2, 'width_slot' => 'full', 'depth' => 'half'],
                        ],
                        'rack_shelves' => [
                            ['id' => -1, 'name' => '棚板1', 'face' => 'front', 'start_u' => 5, 'height_u' => 1, 'depth' => 'half'],
                        ],
                        'rack_shelf_devices' => [
                            ['device_id' => 920002, 'shelf_id' => -1, 'sort_order' => 0],
                        ],
                    ],
                    [
                        'operation' => 'create', 'id' => 930002,
                        'view' => ['name' => 'Rack-B', 'view_type' => 'rack', 'facility' => '東館', 'floor' => '2F', 'sort_order' => 20, 'memo' => ''],
                        'placements' => [], 'links' => [], 'canvas_notes' => [],
                        'rack_settings' => ['total_u' => 42, 'location' => '列2'],
                        'rack_mounts' => [], 'rack_shelves' => [], 'rack_shelf_devices' => [],
                    ],
                    [
                        'operation' => 'create', 'id' => 930003,
                        'view' => ['name' => 'Floor-1F', 'view_type' => 'floor', 'facility' => '東館', 'floor' => '1F', 'sort_order' => 30, 'memo' => ''],
                        'placements' => [
                            ['id' => 940001, 'device_id' => 920001, 'x' => 100, 'y' => 200],
                            ['id' => 940002, 'device_id' => 920002, 'x' => 300, 'y' => 200],
                        ],
                        'links' => [
                            ['id' => 950001, 'from_id' => 920001, 'to_id' => 920002, 'from_port' => 'Gi0/1', 'to_port' => 'Gi0/2', 'vlan' => '100', 'label' => '幹線', 'memo' => '', 'route_mode' => 'auto', 'manual_route' => []],
                        ],
                        'canvas_notes' => [],
                        'floor_rack_placements' => [
                            ['rack_view_id' => 930001, 'x' => 50, 'y' => 60],
                        ],
                    ],
                    [
                        'operation' => 'create', 'id' => 930004,
                        'view' => ['name' => 'Floor-2F', 'view_type' => 'floor', 'facility' => '東館', 'floor' => '2F', 'sort_order' => 40, 'memo' => ''],
                        'placements' => [], 'links' => [], 'canvas_notes' => [], 'floor_rack_placements' => [],
                    ],
                ],
            ])->assertOk()->getJson();

            $dev1 = (int)$setup['id_maps']['devices']['920001'];
            $dev2 = (int)$setup['id_maps']['devices']['920002'];
            $rackA = (int)$setup['id_maps']['views']['930001'];
            $rackB = (int)$setup['id_maps']['views']['930002'];
            $floor1 = (int)$setup['id_maps']['views']['930003'];
            $floor2 = (int)$setup['id_maps']['views']['930004'];
            $shelfId = (int)$setup['id_maps']['rack_shelves']['-1'];
            $viewsById = array_column($setup['views'], null, 'id');

            // ラック間移設（Rack-A -> Rack-B）を1回の保存で実施：同一 event_id で双方から追跡可能
            $transfer = $admin->postJson('/api.php?action=save_resources', [
                'devices' => [],
                'views' => [
                    [
                        'operation' => 'update', 'id' => $rackA, 'expected_revision' => $viewsById[$rackA]['resource_revision'],
                        'view' => $viewsById[$rackA], 'placements' => [], 'links' => [], 'canvas_notes' => [],
                        'rack_settings' => ['total_u' => 45, 'location' => '列1-改'],
                        'rack_mounts' => [],
                        'rack_shelves' => [
                            ['id' => $shelfId, 'name' => '棚板1-改', 'face' => 'rear', 'start_u' => 6, 'height_u' => 2, 'depth' => 'full'],
                        ],
                        'rack_shelf_devices' => [
                            ['device_id' => $dev2, 'shelf_id' => $shelfId, 'sort_order' => 1],
                        ],
                    ],
                    [
                        'operation' => 'update', 'id' => $rackB, 'expected_revision' => $viewsById[$rackB]['resource_revision'],
                        'view' => $viewsById[$rackB], 'placements' => [], 'links' => [], 'canvas_notes' => [],
                        'rack_settings' => ['total_u' => 42, 'location' => '列2'],
                        'rack_mounts' => [
                            ['device_id' => $dev1, 'face' => 'rear', 'start_u' => 20, 'height_u' => 2, 'width_slot' => 'left', 'depth' => 'full'],
                        ],
                        'rack_shelves' => [], 'rack_shelf_devices' => [],
                    ],
                ],
            ])->assertOk()->getJson();
            foreach ($transfer['views'] as $v) { $viewsById[$v['id']] = $v; }

            $rackAHistory = $this->history($admin, "target_type=view&target_id={$rackA}")['items'][0];
            $rackBHistory = $this->history($admin, "target_type=view&target_id={$rackB}")['items'][0];
            $this->assertSame($rackAHistory['event_id'], $rackBHistory['event_id']);
            $this->assertSame('rack', $rackAHistory['view_type']);
            $this->assertStringContains('ラック間移設（搬出1件）', $rackAHistory['summary']);
            $this->assertStringContains('ラック間移設（搬入1件）', $rackBHistory['summary']);
            $this->assertSame($rackB, $rackAHistory['related_targets'][0]['target_id']);
            $this->assertSame($rackA, $rackBHistory['related_targets'][0]['target_id']);

            // フロア間のラック移動（Floor-1F -> Floor-2F）＋配置座標変更＋接続更新
            $placementRows = array_values(array_filter($setup['placements'], static fn($p) => (int)$p['view_id'] === $floor1));
            $placementRows[0]['x'] = 180;
            $placementRows[0]['y'] = 260;
            $linkRow = array_values(array_filter($setup['links'], static fn($l) => (int)$l['view_id'] === $floor1))[0];
            $linkRow['vlan'] = '200';
            $linkRow['route_mode'] = 'manual';
            $linkRow['manual_route'] = [['x' => 180, 'y' => 200]];

            $floorMove = $admin->postJson('/api.php?action=save_resources', [
                'devices' => [],
                'views' => [
                    [
                        'operation' => 'update', 'id' => $floor1, 'expected_revision' => $viewsById[$floor1]['resource_revision'],
                        'view' => $viewsById[$floor1],
                        'placements' => $placementRows,
                        'links' => [$linkRow],
                        'canvas_notes' => [],
                        'floor_rack_placements' => [],
                    ],
                    [
                        'operation' => 'update', 'id' => $floor2, 'expected_revision' => $viewsById[$floor2]['resource_revision'],
                        'view' => $viewsById[$floor2],
                        'placements' => [], 'links' => [], 'canvas_notes' => [],
                        'floor_rack_placements' => [
                            ['rack_view_id' => $rackA, 'x' => 410, 'y' => 520],
                        ],
                    ],
                ],
            ])->assertOk()->getJson();
            foreach ($floorMove['views'] as $v) { $viewsById[$v['id']] = $v; }

            $f1Entry = $this->history($admin, "target_type=view&target_id={$floor1}")['items'][0];
            $f2Entry = $this->history($admin, "target_type=view&target_id={$floor2}")['items'][0];
            $this->assertSame($f1Entry['event_id'], $f2Entry['event_id']);
            $this->assertStringContains('座標変更1件', $f1Entry['summary']);
            $this->assertStringContains('接続変更1件', $f1Entry['summary']);
            $this->assertStringContains('フロア間ラック移動（搬出1件）', $f1Entry['summary']);
            $this->assertStringContains('フロア間ラック移動（搬入1件）', $f2Entry['summary']);

            // 機器削除：削除済み対象も履歴検索・閲覧でき、関連ビュー・ラックの自動整理も同じイベントで追跡できる
            $dev1Current = $admin->get('/api.php?action=load')->assertOk()->getJson();
            $dev1Row = array_column($dev1Current['devices'], null, 'id')[$dev1];
            $admin->postJson('/api.php?action=save_resources', [
                'devices' => [['operation' => 'delete', 'id' => $dev1, 'expected_revision' => $dev1Row['resource_revision']]],
                'views' => [],
            ])->assertOk();

            $deletedSearch = $this->history($admin, 'q=Rack-Server-1');
            $this->assertTrue($deletedSearch['total'] >= 2);
            $deleteEntry = $deletedSearch['items'][0];
            $this->assertSame('delete', $deleteEntry['operation']);
            $this->assertFalse($deleteEntry['target_exists']);
            $relatedViewIds = array_column($deleteEntry['related_targets'], 'target_id');
            $this->assertTrue(in_array($floor1, $relatedViewIds, true));
            $this->assertTrue(in_array($rackB, $relatedViewIds, true));
        });
    }

    public function testLargeEventRelatedTargetsStayBoundedAcrossPagesAndFilters(): void
    {
        $this->fixture(function (TestHttpClient $admin, TestHttpClient $viewer, PDO $db): void {
            $snap = $admin->get('/api.php?action=load')->assertOk()->getJson();
            $deviceId = (int)$snap['devices'][0]['id'];
            $viewId = (int)$snap['views'][0]['id'];
            $db->exec('DELETE FROM change_history');
            $insert = $db->prepare("INSERT INTO change_history (
                event_id, request_id, occurred_at, actor_user_id, actor_name,
                target_type, target_id, target_name, operation, summary, changes_json
            ) VALUES (7001, 'large-event', ?, 1, 'admin', ?, ?, ?, ?, '大量変更', ?)");
            $now = time();
            $ids = [];
            $db->beginTransaction();
            for ($i = 1; $i <= 3000; $i++) {
                $type = in_array($i, [2, 4], true) ? 'view' : 'device';
                $targetId = match ($i) {
                    1 => $deviceId,
                    2 => $viewId,
                    3, 4 => 2147000000,
                    default => 2000000 + $i,
                };
                $insert->execute([
                    gmdate('Y-m-d\TH:i:s\Z', $now - ($i === 3000 ? 60 * 86400 : 0)),
                    $type,
                    $targetId,
                    "大量対象-{$i}",
                    in_array($i, [3, 4], true) ? 'delete' : 'update',
                    json_encode(['items' => [], 'view_type' => $i === 2 ? $snap['views'][0]['view_type'] : '']),
                ]);
                $ids[$i] = (int)$db->lastInsertId();
            }
            // 同一イベントでも保存期限外の対象は集計・表示の両方から除外する。
            $insert->execute([
                gmdate('Y-m-d\TH:i:s\Z', $now - 91 * 86400),
                'device', 2147000001, '期限切れ対象', 'delete', '{"items":[]}',
            ]);
            $db->commit();

            // 先頭候補の外側・11番目・10番目・先頭の各対象で、自分自身だけを除いて最大10件。
            foreach ([1 => 2999, 2989 => 11, 2990 => 10, 2999 => 1] as $page => $index) {
                $result = $this->history($admin, "per_page=1&page={$page}");
                $this->assertSame(2999, $result['total']);
                $this->assertSame(2999, $result['total_pages']);
                $this->assertSame($page, $result['page']);
                $this->assertSame(1, count($result['items']));
                $entry = $result['items'][0];
                $this->assertSame($ids[$index], $entry['id']);
                $expectedIds = array_values(array_filter(
                    array_slice($ids, 0, 11),
                    static fn(int $id): bool => $id !== $ids[$index]
                ));
                $this->assertSame(array_slice($expectedIds, 0, 10), array_column($entry['related_targets'], 'id'));
                $this->assertSame(2989, $entry['related_omitted_count']);
            }

            // 一覧の対象・名前フィルターでイベント内の関連対象を絞り込まない。
            $focused = $this->history($admin, "target_type=device&target_id={$deviceId}&q=" . rawurlencode('大量対象-1'));
            $this->assertSame(1, $focused['total']);
            $entry = $focused['items'][0];
            $this->assertSame(array_slice(array_values($ids), 1, 10), array_column($entry['related_targets'], 'id'));
            $this->assertSame(2989, $entry['related_omitted_count']);
            $related = $entry['related_targets'];
            $this->assertSame('view', $related[0]['target_type']);
            $this->assertTrue($related[0]['target_exists']);
            $this->assertSame('device', $related[1]['target_type']);
            $this->assertFalse($related[1]['target_exists']);
            $this->assertSame('delete', $related[1]['operation']);
            $this->assertSame('view', $related[2]['target_type']);
            $this->assertSame($related[1]['target_id'], $related[2]['target_id']);
            $this->assertFalse($related[2]['target_exists']);
            $this->assertSame('大量対象-4', $related[2]['target_name']);
            $this->assertSame('delete', $related[2]['operation']);

            $view = $this->history($admin, "target_type=view&target_id={$viewId}")['items'][0];
            $this->assertSame($snap['views'][0]['view_type'], $view['view_type']);
            $this->assertSame('device', $view['related_targets'][0]['target_type']);
            $this->assertTrue($view['related_targets'][0]['target_exists']);
            // 60日前の対象は30日一覧の外でも、90日以内の関連対象件数には含まれる。
            $older = $this->history($admin, 'days=90&q=' . rawurlencode('大量対象-3000'));
            $this->assertSame(1, $older['total']);
            $this->assertSame($ids[3000], $older['items'][0]['id']);
            $this->assertSame(2989, $older['items'][0]['related_omitted_count']);
        });
    }

    public function testRelatedTargetLimitBoundariesAndSeparateEvents(): void
    {
        $this->fixture(function (TestHttpClient $admin, TestHttpClient $viewer, PDO $db): void {
            $db->exec('DELETE FROM change_history');
            $insert = $db->prepare("INSERT INTO change_history (
                event_id, request_id, occurred_at, actor_user_id, actor_name,
                target_type, target_id, target_name, operation, summary, changes_json
            ) VALUES (?, '', ?, 1, 'admin', 'device', ?, ?, 'update', '境界変更', '{\"items\":[]}')");
            $now = gmdate('Y-m-d\TH:i:s\Z');
            $eventIds = [];
            foreach ([1, 10, 11, 12] as $size) {
                for ($i = 1; $i <= $size; $i++) {
                    $insert->execute([8000 + $size, $now, 2100000 + $size * 100 + $i, "境界{$size}-{$i}"]);
                    $eventIds[$size][] = (int)$db->lastInsertId();
                }
            }
            $result = $this->history($admin, 'per_page=100');
            $this->assertSame(34, $result['total']);
            $this->assertSame(34, count($result['items']));
            foreach ($result['items'] as $entry) {
                $size = $entry['event_id'] - 8000;
                $expected = array_values(array_filter(
                    $eventIds[$size],
                    static fn(int $id): bool => $id !== $entry['id']
                ));
                $this->assertSame(array_slice($expected, 0, 10), array_column($entry['related_targets'], 'id'));
                $this->assertSame(max(0, $size - 11), $entry['related_omitted_count']);
                $this->assertSame(min(10, $size - 1), count($entry['related_targets']));
                foreach ($entry['related_targets'] as $related) {
                    $this->assertFalse($related['target_exists']);
                    $this->assertSame('device', $related['target_type']);
                }
            }
        });
    }

    public function testFullSaveNoOpCsvImportLargeEditSummarizationAndRetention(): void
    {
        $this->fixture(function (TestHttpClient $admin, TestHttpClient $viewer, PDO $db): void {
            $db->exec('DELETE FROM change_history');

            // 従来 save の同一内容再保存は内部再挿入を行っても no-op（履歴0件）
            $snap = $admin->get('/api.php?action=load')->assertOk()->getJson();
            $admin->postJson('/api.php?action=save', [
                'revision' => $snap['revision'],
                'views' => $snap['views'],
                'devices' => $snap['devices'],
                'placements' => $snap['placements'],
                'links' => $snap['links'],
                'canvas_notes' => $snap['canvas_notes'],
                'rack_settings' => $snap['rack_settings'],
                'rack_mounts' => $snap['rack_mounts'],
                'rack_shelves' => $snap['rack_shelves'],
                'rack_shelf_devices' => $snap['rack_shelf_devices'],
                'floor_rack_placements' => $snap['floor_rack_placements'],
            ])->assertOk();
            $this->assertSame(0, (int)$db->query('SELECT COUNT(*) FROM change_history')->fetchColumn());

            // 大量配置変更の要約・サイズ制限確認（1ビューに12台一括配置）
            $snap = $admin->get('/api.php?action=load')->assertOk()->getJson();
            $view = $snap['views'][0];
            $bulkDevices = [];
            $bulkPlacements = [];
            for ($i = 1; $i <= 12; $i++) {
                $localId = 960000 + $i;
                $bulkDevices[] = [
                    'operation' => 'create',
                    'id' => $localId,
                    'device' => ['name' => "Bulk-AP-{$i}", 'type' => 'ap', 'ip' => "203.0.113.{$i}"],
                ];
                $bulkPlacements[] = [
                    'id' => 970000 + $i,
                    'device_id' => $localId,
                    'x' => $i * 40,
                    'y' => 120,
                ];
            }
            $bulkSaved = $admin->postJson('/api.php?action=save_resources', [
                'devices' => $bulkDevices,
                'views' => [[
                    'operation' => 'update',
                    'id' => $view['id'],
                    'expected_revision' => $view['resource_revision'],
                    'view' => $view,
                    'placements' => array_merge(
                        array_values(array_filter($snap['placements'], static fn($p) => (int)$p['view_id'] === (int)$view['id'])),
                        $bulkPlacements
                    ),
                    'links' => array_values(array_filter($snap['links'], static fn($l) => (int)$l['view_id'] === (int)$view['id'])),
                    'canvas_notes' => array_values(array_filter($snap['canvas_notes'], static fn($n) => (int)$n['view_id'] === (int)$view['id'])),
                ]],
            ])->assertOk()->getJson();

            $viewEntry = $this->history($admin, 'target_type=view&target_id=' . (int)$view['id'])['items'][0];
            $this->assertTrue($viewEntry['omitted_count'] > 0);
            $this->assertStringContains('配置追加12件', $viewEntry['summary']);

            // CSV取込による作成・更新履歴の記録
            $csvExport = $admin->get('/api.php?action=export_devices_csv')->assertStatus(200)->getBody();
            $csvExport = preg_replace('/^\xEF\xBB\xBF/', '', $csvExport) ?? $csvExport;
            $csvLines = preg_split("/\r\n|\n|\r/", trim($csvExport));
            $header = $csvLines[0];
            $csvContent = $header . "\r\n" .
                ',CSV新規ルータ,router,203.0.113.200,"[]",本社,1F,ラック1,Vendor,R-100,AST-1,SN-1,00:11:22:33:44:55,CSV備考,https,8443,NW課,保守A,2026-01,2030-12';
            $csvFile = $bulkSaved['saved_at'] ? sys_get_temp_dir() . '/chg_csv_' . bin2hex(random_bytes(4)) . '.csv' : '';
            file_put_contents($csvFile, $csvContent);
            try {
                $latestLoad = $admin->get('/api.php?action=load')->assertOk()->getJson();
                $preview = $admin->postMultipart(
                    '/api.php?action=preview_devices_csv_import',
                    ['revision' => (string)$latestLoad['revision']],
                    ['devices_csv' => ['path' => $csvFile, 'filename' => 'import.csv', 'type' => 'text/csv']]
                )->assertOk()->getJson();
                $admin->postJson('/api.php?action=commit_devices_csv_import', [
                    'import_token' => $preview['import_token'],
                    'revision' => $latestLoad['revision'],
                ])->assertOk();
            } finally {
                @unlink($csvFile);
            }
            $csvHistory = $this->history($admin, 'q=' . rawurlencode('CSV新規ルータ'));
            $this->assertSame(1, $csvHistory['total']);
            $this->assertStringContains('CSV取込で機器を作成', $csvHistory['items'][0]['summary']);

            // 期間 7日 / 30日 / 90日 境界、90日超の非表示と自動削除、100件上限廃止（105件保持）
            $db->exec('DELETE FROM change_history');
            $ins = $db->prepare("INSERT INTO change_history (
                event_id, request_id, occurred_at, actor_user_id, actor_name,
                target_type, target_id, target_name, operation, summary, changes_json
            ) VALUES (?, '', ?, 1, 'admin', 'device', 1, '境界検証機器', 'update', ?, '{\"items\":[{\"label\":\"備考\",\"before\":\"旧\",\"after\":\"新\"}]}')");

            $now = time();
            $ins->execute([1, gmdate('Y-m-d\TH:i:s\Z', $now - 91 * 86400), '91日前（期限切れ）']);
            $ins->execute([2, gmdate('Y-m-d\TH:i:s\Z', $now - 60 * 86400), '60日前（90日枠のみ）']);
            $ins->execute([3, gmdate('Y-m-d\TH:i:s\Z', $now - 15 * 86400), '15日前（30日・90日枠）']);
            for ($i = 1; $i <= 105; $i++) {
                $ins->execute([10 + $i, gmdate('Y-m-d\TH:i:s\Z', $now - 2 * 86400 + $i), "2日前 #{$i}"]);
            }

            // 保存前でも 91日前は days=90 に表示されない
            $this->assertSame(105, $this->history($admin, 'days=7')['total']);
            $this->assertSame(106, $this->history($admin)['total']); // 初期表示 = 30日
            $res90 = $this->history($admin, 'days=90&per_page=50&page=3');
            $this->assertSame(107, $res90['total']); // 105 + 15日前 + 60日前（100件上限なし）
            $this->assertSame(3, $res90['total_pages']);
            $this->assertSame(7, count($res90['items']));

            // 不正な期間指定は 400
            $admin->get('/api.php?action=load_change_history&days=91')->assertStatus(400);
            $admin->get('/api.php?action=load_change_history&days=0')->assertStatus(400);

            // 次回の成功保存時に 91日前のレコードが DB から物理削除される
            $admin->postJson('/api.php?action=save_resources', [
                'devices' => [[
                    'operation' => 'create',
                    'id' => 989999,
                    'device' => ['name' => '整理起動機器', 'type' => 'pc', 'ip' => ''],
                ]],
                'views' => [],
            ])->assertOk();
            $this->assertSame(0, (int)$db->query("SELECT COUNT(*) FROM change_history WHERE summary='91日前（期限切れ）'")->fetchColumn());
            $this->assertSame(108, (int)$db->query('SELECT COUNT(*) FROM change_history')->fetchColumn());
        });
    }
}
