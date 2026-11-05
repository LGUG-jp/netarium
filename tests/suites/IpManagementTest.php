<?php
declare(strict_types=1);

namespace Netarium\Tests\Suites;

use Netarium\Tests\TestCase;
use Netarium\Tests\TestHttpClient;
use Netarium\Tests\TestServer;
use PDO;

class IpManagementTest extends TestCase
{
    public function __construct(private TestHttpClient $client) {}

    private function fixture(callable $run): void
    {
        $server = new TestServer();
        try {
            $server->start();
            $client = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($client->login('admin', 'admin123'));
            $db = new PDO('sqlite:' . $server->getDbPath());
            $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
            $run($client, $db);
        } finally { $server->stop(); }
    }

    private function load(TestHttpClient $client): array
    {
        return $client->get('/api.php?action=load_ip_management')->assertOk()->getJson();
    }

    private function master(TestHttpClient $client, string $action, array $row): array
    {
        return $client->postJson('/api.php?action=' . $action, $row + ['expected_revision' => $this->load($client)['revision']])->assertOk()->getJson();
    }

    private function create(TestHttpClient $client, int $localId, array $device): array
    {
        $result = $client->postJson('/api.php?action=save_resources', ['devices' => [[
            'operation' => 'create', 'id' => $localId, 'device' => $device,
        ]], 'views' => []])->assertOk()->getJson();
        return array_column($result['devices'], null, 'id')[$result['id_maps']['devices'][$localId]];
    }

    private function operation(array $device): array
    {
        return ['operation' => 'update', 'id' => $device['id'], 'expected_revision' => $device['resource_revision'], 'device' => $device];
    }

    public function testConflictLimitRollsBackBatchAndDoesNotBlockUnchangedDuplicates(): void
    {
        $this->fixture(function (TestHttpClient $client, PDO $db): void {
            $before = $this->load($client);
            $sequences = $db->query('SELECT * FROM resource_sequences ORDER BY name')->fetchAll(PDO::FETCH_ASSOC);
            $operations = [];
            for ($i = 0; $i < 46; $i++) {
                $operations[] = ['operation' => 'create', 'id' => 981000 + $i, 'device' => [
                    'name' => 'Limited-' . $i, 'ip' => '192.0.2.205', 'ip_conflicts_confirmed' => true,
                ]];
            }
            $response = $client->postJson('/api.php?action=save_resources', ['devices' => $operations, 'views' => []])
                ->assertStatus(400)->getJson();
            $this->assertSame('ip_conflict_limit', $response['details']['reason']);
            $this->assertSame($before, $this->load($client));
            $this->assertSame($sequences, $db->query('SELECT * FROM resource_sequences ORDER BY name')->fetchAll(PDO::FETCH_ASSOC));

            // Historical duplicates are not new diagnostics and must not block unrelated edits.
            $insert = $db->prepare('INSERT INTO devices (name, ip) VALUES (?, ?)');
            for ($i = 0; $i < 46; $i++) { $insert->execute(['Existing-' . $i, '192.0.2.205']); }
            $device = $client->get('/api.php?action=load')->assertOk()->getJson()['devices'][0];
            $device['name'] = 'Unrelated edit remains allowed';
            $saved = $client->postJson('/api.php?action=save_resources', [
                'devices' => [$this->operation($device)], 'views' => [],
            ])->assertOk()->getJson();
            $this->assertSame($device['name'], array_column($saved['devices'], 'name', 'id')[$device['id']]);
        });
    }

    public function testReachabilitySettingsResetOnlyAffectedMonitorsAndPreserveConflictGuards(): void
    {
        $this->fixture(function (TestHttpClient $client, PDO $db): void {
            $a = $this->master($client, 'create_ip_network', ['name' => 'A', 'ping_reachability' => 'reachable',
                'segment' => ['name' => 'A', 'cidr' => '192.0.2.0/24']]);
            $b = $this->master($client, 'create_ip_network', ['name' => 'B', 'ping_reachability' => 'unreachable',
                'segment' => ['name' => 'B', 'cidr' => '192.0.2.0/24']]);
            $first = $this->create($client, 980901, ['name' => 'reachable', 'ip' => '192.0.2.10', 'ip_segment_id' => $a['created_segment_id']]);
            $second = $this->create($client, 980902, ['name' => 'unreachable', 'ip' => '192.0.2.10', 'ip_segment_id' => $b['created_segment_id']]);
            $other = $this->create($client, 980903, ['name' => 'unrelated', 'ip' => '203.0.113.9', 'ip_segment_id' => null]);
            $db->exec("UPDATE device_monitor_status SET status='green',last_response_ms=8,last_checked_at='2026-01-01 00:00:00',last_error=NULL");
            $before = $this->load($client);
            $unrelated = array_column($before['devices'], null, 'id')[$other['id']];
            $changed = $this->master($client, 'save_address_space', ['id' => $b['created_address_space_id'], 'name' => 'B', 'ping_reachability' => 'unset']);
            $rows = array_column($changed['devices'], null, 'id');
            $this->assertSame('unknown', $rows[$first['id']]['status']);
            $this->assertNull($rows[$first['id']]['last_response_ms']);
            $this->assertStringContains('未設定・未分類', $rows[$first['id']]['last_error']);
            $this->assertSame('unknown', $rows[$second['id']]['status']);
            $this->assertSame($unrelated, $rows[$other['id']]);
            $this->assertSame($before['monitor_revision'] + 1, $changed['monitor_revision']);
            $client->postJson('/api.php?action=save_address_space', ['id' => $b['created_address_space_id'], 'name' => 'B',
                'ping_reachability' => 'reachable', 'expected_revision' => $before['revision']])->assertStatus(409);
            $afterConflict = $this->load($client);
            foreach (['revision', 'monitor_revision', 'address_spaces', 'ip_segments', 'ip_records', 'devices'] as $field) {
                $this->assertSame($changed[$field], $afterConflict[$field], '409で' . $field . 'を変更しない');
            }
            $noChange = $this->master($client, 'save_address_space', ['id' => $b['created_address_space_id'], 'name' => 'B renamed']);
            $this->assertSame($changed['monitor_revision'], $noChange['monitor_revision']);
            $this->assertSame('unset', array_column($noChange['address_spaces'], null, 'id')[$b['created_address_space_id']]['ping_reachability']);
            $viewer = new TestHttpClient($client->getBaseUrl());
            $this->assertTrue($viewer->login('viewer', 'viewer123'));
            $this->assertSame($noChange['address_spaces'], $this->load($viewer)['address_spaces']);
            $viewer->postJson('/api.php?action=save_address_space', ['id' => $b['created_address_space_id'], 'name' => 'B',
                'ping_reachability' => 'reachable', 'expected_revision' => $noChange['revision']])->assertStatus(403);
            $client->postJson('/api.php?action=save_address_space', ['id' => $b['created_address_space_id'], 'name' => 'B',
                'ping_reachability' => 'invalid', 'expected_revision' => $noChange['revision']])->assertStatus(400);
            $db->prepare("UPDATE device_monitor_status SET status='green',last_response_ms=6,last_error=NULL WHERE device_id=?")->execute([$first['id']]);
            $reclassified = $this->master($client, 'reclassify_ips', ['records' => [[
                'device_id' => $second['id'], 'kind' => 'management', 'id' => null,
                'from_segment_id' => $b['created_segment_id'], 'segment_id' => null,
                'ip_conflicts_confirmed' => true,
            ]]]);
            $rows = array_column($reclassified['devices'], null, 'id');
            $this->assertSame('unknown', $rows[$first['id']]['status']);
            $this->assertNull($rows[$first['id']]['last_response_ms']);
            $this->assertStringContains('未設定・未分類', $rows[$first['id']]['last_error']);
            $this->assertSame($unrelated, $rows[$other['id']]);
            $this->assertSame($noChange['monitor_revision'] + 1, $reclassified['monitor_revision']);
        });
    }

    public function testDeviceAdditionalMembershipChangeInvalidatesOtherManagementTarget(): void
    {
        $this->fixture(function (TestHttpClient $client, PDO $db): void {
            $a = $this->master($client, 'create_ip_network', ['name' => 'A', 'ping_reachability' => 'reachable',
                'segment' => ['name' => 'A', 'cidr' => '192.0.2.0/24']]);
            $b = $this->master($client, 'create_ip_network', ['name' => 'B', 'ping_reachability' => 'unreachable',
                'segment' => ['name' => 'B', 'cidr' => '192.0.2.0/24']]);
            $first = $this->create($client, 980911, ['name' => 'A', 'ip' => '192.0.2.10', 'ip_segment_id' => $a['created_segment_id']]);
            $second = $this->create($client, 980912, ['name' => 'B', 'ip' => '203.0.113.2', 'ip_segment_id' => null,
                'additional_ips' => [['ip' => '192.0.2.10', 'segment_id' => $b['created_segment_id']]]]);
            $db->exec("UPDATE device_monitor_status SET status='green',last_response_ms=9,last_error=NULL");
            $before = $this->load($client);
            $second['additional_ips'][0]['segment_id'] = null;
            $second['ip_conflicts_confirmed'] = true;
            $saved = $client->postJson('/api.php?action=save_resources', ['devices' => [$this->operation($second)], 'views' => []])->assertOk()->getJson();
            $rows = array_column($saved['devices'], null, 'id');
            $this->assertSame('unknown', $rows[$first['id']]['status']);
            $this->assertNull($rows[$first['id']]['last_response_ms']);
            $this->assertStringContains('未設定・未分類', $rows[$first['id']]['last_error']);
            $this->assertSame('green', $rows[$second['id']]['status']);
            $this->assertSame(9, $rows[$second['id']]['last_response_ms']);
            $this->assertSame($before['monitor_revision'] + 1, $saved['monitor_revision']);
        });
    }

    public function testSummaryCountsPersistedRecordsAndRefreshesWithRevision(): void
    {
        $this->fixture(function (TestHttpClient $client, PDO $db): void {
            $db->exec("UPDATE devices SET ip = ''");
            $summary = static fn(TestHttpClient $http): array =>
                $http->get('/api.php?action=load_ip_management_summary')->assertOk()->getJson();
            $empty = $summary($client);
            $this->assertSame(['ok', 'status', 'revision', 'summary'], array_keys($empty));
            $this->assertTrue($empty['ok']);
            $this->assertSame('success', $empty['status']);
            $this->assertSame((int)$db->query("SELECT meta_value FROM app_meta WHERE meta_key = 'data_revision'")->fetchColumn(), $empty['revision']);
            $this->assertSame(['address_spaces' => 0, 'ip_segments' => 0, 'registered_ips' => 0, 'unclassified_ips' => 0], $empty['summary']);

            $a = $this->master($client, 'create_ip_network', ['name' => 'Summary A',
                'segment' => ['name' => 'LAN A', 'cidr' => '192.0.2.0/24']]);
            $b = $this->master($client, 'create_ip_network', ['name' => 'Summary B',
                'segment' => ['name' => 'LAN B', 'cidr' => '192.0.2.0/24']]);
            $masters = $summary($client);
            $this->assertSame($b['revision'], $masters['revision']);
            $this->assertSame(['address_spaces' => 2, 'ip_segments' => 2, 'registered_ips' => 0, 'unclassified_ips' => 0], $masters['summary']);
            $device = $this->create($client, 980301, ['name' => 'Summary primary', 'ip' => '192.0.2.10',
                'ip_segment_id' => $a['created_segment_id'], 'additional_ips' => [
                    ['ip' => '192.0.2.11', 'segment_id' => $a['created_segment_id']],
                    ['ip' => '192.0.2.12', 'segment_id' => null],
                ]]);
            $this->create($client, 980302, ['name' => 'Summary other space', 'ip' => '192.0.2.10',
                'ip_segment_id' => $b['created_segment_id'], 'additional_ips' => [
                    ['ip' => '203.0.113.10', 'segment_id' => null],
                ]]);
            $populated = $summary($client);
            // Identical IPs in different spaces remain separate registered records.
            $this->assertSame(['address_spaces' => 2, 'ip_segments' => 2, 'registered_ips' => 5, 'unclassified_ips' => 2], $populated['summary']);
            $this->assertSame((int)$db->query("SELECT meta_value FROM app_meta WHERE meta_key = 'data_revision'")->fetchColumn(), $populated['revision']);
            $this->assertTrue($populated['revision'] > $masters['revision']);
            $this->assertSame($populated, $summary($client));

            $device['ip'] = '203.0.113.20';
            $device['ip_segment_id'] = null;
            $device['additional_ips'] = [$device['additional_ips'][0]];
            $updated = $client->postJson('/api.php?action=save_resources', [
                'devices' => [$this->operation($device)], 'views' => [],
            ])->assertOk()->getJson();
            $changed = $summary($client);
            $this->assertSame($updated['revision'], $changed['revision']);
            $this->assertTrue($changed['revision'] > $populated['revision']);
            $this->assertSame(['address_spaces' => 2, 'ip_segments' => 2, 'registered_ips' => 4, 'unclassified_ips' => 2], $changed['summary']);
            $deleted = $this->master($client, 'delete_ip_segment', ['id' => $a['created_segment_id']]);
            $afterDelete = $summary($client);
            $this->assertSame($deleted['revision'], $afterDelete['revision']);
            $this->assertSame(['address_spaces' => 2, 'ip_segments' => 1, 'registered_ips' => 4, 'unclassified_ips' => 3], $afterDelete['summary']);

            $viewer = new TestHttpClient($client->getBaseUrl());
            $this->assertTrue($viewer->login('viewer', 'viewer123'));
            $this->assertSame($afterDelete, $summary($viewer));
            $client->postJson('/api.php?action=load_ip_management_summary', [])->assertStatus(405);
            $unauthenticated = new TestHttpClient($client->getBaseUrl());
            $denied = $unauthenticated->get('/api.php?action=load_ip_management_summary')->assertStatus(401)->getJson();
            $this->assertFalse($denied['ok']);
            $this->assertTrue($denied['login_required']);
        });
    }

    public function testAtomicNetworkCreationValidationPermissionsAndRevision(): void
    {
        $this->fixture(function (TestHttpClient $client, PDO $db): void {
            $before = $this->load($client);
            $payload = ['name' => '  Network A  ', 'memo' => '  space memo  ', 'segment' => [
                'name' => '  LAN  ', 'cidr' => '192.0.2.27/24', 'purpose' => '  service  ',
                'facility' => '  Tokyo  ', 'vlan_id' => 42, 'memo' => '  segment memo  ',
            ]];
            $created = $client->postJson('/api.php?action=create_ip_network',
                $payload + ['expected_revision' => $before['revision']])->assertOk()->getJson();
            $this->assertSame($before['revision'] + 1, $created['revision']);
            $space = array_column($created['address_spaces'], null, 'id')[$created['created_address_space_id']];
            $segment = array_column($created['ip_segments'], null, 'id')[$created['created_segment_id']];
            $this->assertSame('Network A', $space['name']);
            $this->assertSame('space memo', $space['memo']);
            $this->assertSame($space['id'], $segment['address_space_id']);
            $this->assertSame('LAN', $segment['name']);
            $this->assertSame('192.0.2.0/24', $segment['cidr']);
            $this->assertSame('service', $segment['purpose']);
            $this->assertSame('Tokyo', $segment['facility']);
            $this->assertSame(42, $segment['vlan_id']);
            $this->assertSame('segment memo', $segment['memo']);
            $saved = $this->load($client);
            foreach (['revision', 'address_spaces', 'ip_segments', 'devices', 'ip_records'] as $field) {
                $this->assertSame($created[$field], $saved[$field]);
            }
            $invalid = [
                array_replace($payload, ['name' => '  ']),
                array_replace($payload, ['segment' => null]),
                array_replace($payload, ['segment' => array_replace($payload['segment'], ['name' => '  '])]),
                array_replace($payload, ['segment' => array_replace($payload['segment'], ['cidr' => ''])]),
                array_replace($payload, ['segment' => array_replace($payload['segment'], ['cidr' => '192.0.2.0/33'])]),
                array_replace($payload, ['segment' => array_replace($payload['segment'], ['vlan_id' => 4095])]),
            ];
            foreach ($invalid as $row) {
                $client->postJson('/api.php?action=create_ip_network', $row + ['expected_revision' => $saved['revision']])->assertStatus(400);
                $this->assertSame($saved, $this->load($client));
                $this->assertSame(count($saved['address_spaces']), (int)$db->query('SELECT COUNT(*) FROM address_spaces')->fetchColumn());
                $this->assertSame(count($saved['ip_segments']), (int)$db->query('SELECT COUNT(*) FROM ip_segments')->fetchColumn());
            }
            $client->postJson('/api.php?action=create_ip_network', $payload + ['expected_revision' => $before['revision']])->assertStatus(409);
            $this->assertSame($saved, $this->load($client));
            $viewer = new TestHttpClient($client->getBaseUrl());
            $this->assertTrue($viewer->login('viewer', 'viewer123'));
            $viewer->postJson('/api.php?action=create_ip_network', $payload + ['expected_revision' => $saved['revision']])->assertStatus(403);
            $this->assertSame($saved, $this->load($client));
            $minimal = $this->master($client, 'create_ip_network', ['name' => 'Minimal', 'segment' => ['name' => 'LAN', 'cidr' => '198.51.100.7/24']]);
            $minimalSegment = array_column($minimal['ip_segments'], null, 'id')[$minimal['created_segment_id']];
            $this->assertNull($minimalSegment['vlan_id']);
            $this->assertSame('', $minimalSegment['memo']);
            // Existing segment creation keeps accepting an omitted name.
            $legacy = $this->master($client, 'save_ip_segment', ['address_space_id' => $space['id'], 'cidr' => '203.0.113.0/24']);
            $unnamed = array_values(array_filter($legacy['ip_segments'], static fn($s) => $s['cidr'] === '203.0.113.0/24'))[0];
            $this->assertSame('', $unnamed['name']);
        });
    }

    public function testAmbiguousReclassificationChoiceAndAtomicConflictRejection(): void
    {
        $this->fixture(function (TestHttpClient $client, PDO $db): void {
            $a = $this->master($client, 'create_ip_network', ['name' => 'A', 'segment' => ['name' => 'A LAN', 'cidr' => '192.0.2.0/24']]);
            $b = $this->master($client, 'create_ip_network', ['name' => 'B', 'segment' => ['name' => 'B LAN', 'cidr' => '192.0.2.0/24']]);
            $segmentA = $a['created_segment_id']; $segmentB = $b['created_segment_id'];
            $outside = $this->master($client, 'create_ip_network', ['name' => 'Outside', 'segment' => ['name' => 'Outside LAN', 'cidr' => '198.51.100.0/24']]);
            $device = $this->create($client, 980151, ['name' => 'Ambiguous', 'ip' => '192.0.2.10',
                'additional_ips' => [['ip' => '192.0.2.11', 'label' => 'secondary']]]);
            $this->assertNull($device['ip_segment_id']);
            $this->assertNull($device['additional_ips'][0]['segment_id']);
            $management = ['device_id' => $device['id'], 'kind' => 'management', 'id' => null, 'segment_id' => $segmentA];
            $additional = ['device_id' => $device['id'], 'kind' => 'additional', 'id' => $device['additional_ips'][0]['id'], 'segment_id' => $segmentB];
            $before = $this->load($client);
            $client->postJson('/api.php?action=reclassify_ips', ['expected_revision' => $before['revision'],
                'records' => [$management, array_replace($additional, ['segment_id' => $outside['created_segment_id']])]])->assertStatus(409);
            $this->assertSame($before, $this->load($client));
            $client->postJson('/api.php?action=reclassify_ips', ['expected_revision' => $b['revision'],
                'records' => [$management, $additional]])->assertStatus(409);
            $this->assertSame($before, $this->load($client));
            $result = $this->master($client, 'reclassify_ips', ['records' => [$management, $additional]]);
            $current = array_column($result['devices'], null, 'id')[$device['id']];
            $this->assertSame($before['revision'] + 1, $result['revision']);
            $this->assertSame($segmentA, $current['ip_segment_id']);
            $this->assertSame($segmentB, $current['additional_ips'][0]['segment_id']);
            $this->assertSame($device['additional_ips'][0]['id'], $current['additional_ips'][0]['id']);
            $before = $this->load($client);
            $client->postJson('/api.php?action=reclassify_ips', ['expected_revision' => $before['revision'],
                'records' => [array_replace($management, ['segment_id' => $segmentB])]])->assertStatus(409);
            $this->assertSame($before, $this->load($client));
            $duplicate = $this->create($client, 980152, ['name' => 'Duplicate', 'ip' => '192.0.2.10', 'ip_conflicts_confirmed' => true,
                'additional_ips' => [['ip' => '192.0.2.12', 'label' => 'must roll back']]]);
            $before = $this->load($client);
            $response = $client->postJson('/api.php?action=reclassify_ips', ['expected_revision' => $before['revision'], 'records' => [
                ['device_id' => $duplicate['id'], 'kind' => 'additional', 'id' => $duplicate['additional_ips'][0]['id'], 'segment_id' => $segmentB],
                ['device_id' => $duplicate['id'], 'kind' => 'management', 'id' => null, 'segment_id' => $segmentA],
            ]])->assertStatus(400)->getJson();
            $this->assertSame('ip_space_conflict', $response['details']['reason']);
            $this->assertSame($before, $this->load($client));
        });
    }

    public function testSpaceOverlapPermissionsAndImpactPreserveRecords(): void
    {
        $this->fixture(function (TestHttpClient $client, PDO $db): void {
            $first = $this->master($client, 'save_address_space', ['name' => 'Space A'])['address_spaces'][0]['id'];
            $second = $this->master($client, 'save_address_space', ['name' => 'Space B'])['address_spaces'][1]['id'];
            $created = $this->master($client, 'save_ip_segment', ['address_space_id' => $first, 'cidr' => '192.0.2.20/24', 'name' => 'A', 'vlan_id' => 12]);
            $segment = $created['ip_segments'][0];
            $this->assertSame('192.0.2.0/24', $segment['cidr']);
            $before = $this->load($client);
            foreach (['192.0.2.0/25', '192.0.0.0/16', '192.0.2.0/24'] as $cidr) {
                $client->postJson('/api.php?action=save_ip_segment', ['address_space_id' => $first, 'cidr' => $cidr, 'expected_revision' => $created['revision']])->assertStatus(400);
                $this->assertSame($before, $this->load($client));
            }
            $this->master($client, 'save_ip_segment', ['address_space_id' => $second, 'cidr' => '192.0.2.0/24', 'name' => 'B']);
            $device = $this->create($client, 980101, ['name' => 'Impact', 'ip' => '192.0.2.254', 'ip_segment_id' => $segment['id'], 'additional_ips' => [['ip' => '192.0.2.253', 'label' => 'secondary', 'segment_id' => $segment['id']]]]);
            $before = $this->load($client);
            $viewer = new TestHttpClient($client->getBaseUrl());
            $this->assertTrue($viewer->login('viewer', 'viewer123'));
            $this->assertSame($before['ip_records'], $this->load($viewer)['ip_records']);
            foreach (['save_address_space', 'delete_address_space', 'save_ip_segment', 'delete_ip_segment', 'reclassify_ips'] as $action) {
                $viewer->postJson('/api.php?action=' . $action, ['expected_revision' => $before['revision'], 'id' => $segment['id']])->assertStatus(403);
            }
            $client->postJson('/api.php?action=delete_address_space', ['id' => $first, 'expected_revision' => $before['revision']])->assertStatus(400);
            $narrowed = $this->master($client, 'save_ip_segment', array_replace($segment, ['cidr' => '192.0.2.0/25']));
            $this->assertSame(2, $narrowed['affected_count']);
            $after = array_column($narrowed['devices'], null, 'id')[$device['id']];
            $this->assertSame($device['ip'], $after['ip']);
            $this->assertNull($after['ip_segment_id']);
            $this->assertSame($device['additional_ips'][0]['id'], $after['additional_ips'][0]['id']);
            $this->assertNull($after['additional_ips'][0]['segment_id']);
            $client->postJson('/api.php?action=save_resources', ['devices' => [$this->operation($device)], 'views' => []])->assertStatus(409);
            $client->postJson('/api.php?action=delete_ip_segment', ['id' => $segment['id'], 'expected_revision' => $before['revision']])->assertStatus(409);
            $this->master($client, 'delete_ip_segment', ['id' => $segment['id']]);
            $this->assertSame(2, count(array_filter($this->load($client)['ip_records'], static fn($r) => $r['device_id'] === $device['id'])));
        });
    }

    public function testFinalStateDuplicateRulesAndExplicitUnclassifiedConfirmation(): void
    {
        $this->fixture(function (TestHttpClient $client, PDO $db): void {
            $spaceA = $this->master($client, 'save_address_space', ['name' => 'A'])['address_spaces'][0]['id'];
            $a = $this->master($client, 'save_ip_segment', ['address_space_id' => $spaceA, 'cidr' => '198.51.100.0/24'])['ip_segments'][0]['id'];
            $unique = $this->create($client, 980111, ['name' => 'Auto', 'ip' => '198.51.100.1']);
            $this->assertSame($a, $unique['ip_segment_id']);
            $spaceB = $this->master($client, 'save_address_space', ['name' => 'B'])['address_spaces'][1]['id'];
            $b = $this->master($client, 'save_ip_segment', ['address_space_id' => $spaceB, 'cidr' => '198.51.100.0/24'])['ip_segments'][1]['id'];
            $other = $this->create($client, 980112, ['name' => 'Other space', 'ip' => '198.51.100.1', 'ip_segment_id' => $b]);
            $this->assertSame($b, $other['ip_segment_id']);
            $diagnostic = $client->get('/api.php?action=data_quality')->assertOk()->getJson();
            $this->assertSame([], array_values(array_filter($diagnostic['issues'],
                static fn($issue) => $issue['code'] === 'duplicate_ip' && ($issue['details']['value'] ?? '') === '198.51.100.1')));
            $before = $this->load($client);
            $client->postJson('/api.php?action=save_resources', ['devices' => [['operation' => 'create', 'id' => 980113,
                'device' => ['name' => 'Blocked', 'additional_ips' => [['ip' => '198.51.100.1', 'segment_id' => $a]]]]], 'views' => []])->assertStatus(400);
            $this->assertSame($before, $this->load($client));
            $ambiguous = ['name' => 'Ambiguous', 'ip' => '198.51.100.1', 'ip_segment_id' => null];
            $response = $client->postJson('/api.php?action=save_resources', ['devices' => [['operation' => 'create', 'id' => 980114, 'device' => $ambiguous]], 'views' => []])->assertStatus(400)->getJson();
            $this->assertSame('ip_confirmation_required', $response['details']['reason']);
            $saved = $this->create($client, 980114, $ambiguous + ['ip_conflicts_confirmed' => true]);
            $this->assertNull($saved['ip_segment_id']);
            // Existing duplicate does not block an unrelated edit, without another acknowledgement.
            $saved['memo'] = 'unrelated';
            $client->postJson('/api.php?action=save_resources', ['devices' => [$this->operation($saved)], 'views' => []])->assertOk();
            $fresh = array_column($this->load($client)['devices'], null, 'id');
            $first = $fresh[$unique['id']]; $second = $fresh[$other['id']];
            $first['ip'] = '198.51.100.2'; $second['ip'] = '198.51.100.2';
            $client->postJson('/api.php?action=save_resources', ['devices' => [$this->operation($first), $this->operation($second)], 'views' => []])->assertOk();
            $first = array_column($this->load($client)['devices'], null, 'id')[$first['id']];
            $first['ip'] = '203.0.113.8';
            $changed = $client->postJson('/api.php?action=save_resources', ['devices' => [$this->operation($first)], 'views' => []])->assertOk()->getJson();
            $this->assertNull(array_column($changed['devices'], null, 'id')[$first['id']]['ip_segment_id']);
            // Legacy classified duplicates survive, while a new same-space pair is rejected.
            $db->exec('UPDATE devices SET ip_segment_id = ' . $a . ', ip = \'198.51.100.1\' WHERE id = ' . $saved['id']);
            $db->exec('UPDATE devices SET ip_segment_id = ' . $a . ', ip = \'198.51.100.1\' WHERE id = ' . $unique['id']);
            $legacy = array_column($this->load($client)['devices'], null, 'id')[$saved['id']];
            $legacy['memo'] = 'legacy duplicate kept';
            $client->postJson('/api.php?action=save_resources', ['devices' => [$this->operation($legacy)], 'views' => []])->assertOk();
            $this->assertSame(2, (int)$db->query('SELECT COUNT(*) FROM devices WHERE ip_segment_id = ' . $a . " AND ip = '198.51.100.1'")->fetchColumn());
            $diagnostic = $client->get('/api.php?action=data_quality')->assertOk()->getJson();
            $duplicate = array_values(array_filter($diagnostic['issues'],
                static fn($issue) => $issue['code'] === 'duplicate_ip' && ($issue['details']['value'] ?? '') === '198.51.100.1'))[0];
            $this->assertSame([$unique['id'], $saved['id']], $duplicate['entity_ids']);
            // Moving an existing IP between management/additional records is not a new use.
            $legacy = array_column($this->load($client)['devices'], null, 'id')[$saved['id']];
            $legacy['additional_ips'] = [['ip' => $legacy['ip'], 'label' => 'management moved', 'segment_id' => $legacy['ip_segment_id']]];
            $legacy['ip'] = '';
            $legacy['ip_segment_id'] = null;
            $client->postJson('/api.php?action=save_resources', ['devices' => [$this->operation($legacy)], 'views' => []])->assertOk();
        });
    }

    public function testReclassificationAndCidrEdges(): void
    {
        $this->fixture(function (TestHttpClient $client, PDO $db): void {
            $space = $this->master($client, 'save_address_space', ['name' => 'Boundaries'])['address_spaces'][0]['id'];
            $device = $this->create($client, 980121, ['name' => 'Existing', 'ip' => '203.0.113.0', 'additional_ips' => [['ip' => '203.0.113.1']]]);
            $segment = $this->master($client, 'save_ip_segment', ['address_space_id' => $space, 'cidr' => '203.0.113.0/31'])['ip_segments'][0];
            $data = $this->load($client);
            $current = array_column($data['devices'], null, 'id')[$device['id']];
            $this->assertNull($current['ip_segment_id']);
            $records = array_values(array_filter($data['ip_records'], static fn($r) => $r['device_id'] === $device['id']));
            $request = array_map(static fn($r) => ['device_id' => $r['device_id'], 'kind' => $r['kind'], 'id' => $r['id'], 'segment_id' => $segment['id']], $records);
            $result = $this->master($client, 'reclassify_ips', ['records' => $request]);
            $current = array_column($result['devices'], null, 'id')[$device['id']];
            $this->assertSame($segment['id'], $current['ip_segment_id']);
            $this->assertSame($segment['id'], $current['additional_ips'][0]['segment_id']);
            $this->assertSame($device['additional_ips'][0]['id'], $current['additional_ips'][0]['id']);
            $expanded = $this->master($client, 'save_ip_segment', array_replace($segment, ['cidr' => '203.0.113.0/30']));
            $this->assertSame(0, $expanded['affected_count']);
            $narrowed = $this->master($client, 'save_ip_segment', array_replace($segment, ['cidr' => '203.0.113.0/32']));
            $this->assertSame(1, $narrowed['affected_count']);
            $current = array_column($narrowed['devices'], null, 'id')[$device['id']];
            $this->assertSame($segment['id'], $current['ip_segment_id']);
            $this->assertNull($current['additional_ips'][0]['segment_id']);
            $deleted = $this->master($client, 'delete_ip_segment', ['id' => $segment['id']]);
            $this->assertSame(1, $deleted['affected_count']);
            $this->assertNull(array_column($deleted['devices'], null, 'id')[$device['id']]['ip_segment_id']);
            $single = $this->master($client, 'save_ip_segment', ['address_space_id' => $space, 'cidr' => '255.255.255.255/32']);
            $this->assertSame('255.255.255.255/32', $single['ip_segments'][0]['cidr']);
            $this->master($client, 'delete_ip_segment', ['id' => $single['ip_segments'][0]['id']]);
            $all = $this->master($client, 'save_ip_segment', ['address_space_id' => $space, 'cidr' => '0.0.0.0/0']);
            $this->assertSame('0.0.0.0/0', $all['ip_segments'][0]['cidr']);
            foreach (['2001:db8::/32', '192.0.2.0/33', '999.0.0.0/24'] as $cidr) {
                $client->postJson('/api.php?action=save_ip_segment', ['address_space_id' => $space, 'cidr' => $cidr, 'expected_revision' => $all['revision']])->assertStatus(400);
            }
            $this->assertSame([], $db->query('PRAGMA foreign_key_check')->fetchAll());
        });
    }

    public function testCsvMembershipPreservationReclassificationAndFinalCollision(): void
    {
        $this->fixture(function (TestHttpClient $client, PDO $db): void {
            $spaceA = $this->master($client, 'save_address_space', ['name' => 'A'])['address_spaces'][0]['id'];
            $segmentA = $this->master($client, 'save_ip_segment', ['address_space_id' => $spaceA, 'cidr' => '198.51.100.0/24'])['ip_segments'][0]['id'];
            $spaceB = $this->master($client, 'save_address_space', ['name' => 'B'])['address_spaces'][1]['id'];
            $this->master($client, 'save_ip_segment', ['address_space_id' => $spaceB, 'cidr' => '198.51.100.0/24']);
            $unique = $this->master($client, 'save_ip_segment', ['address_space_id' => $spaceA, 'cidr' => '203.0.113.0/24'])['ip_segments'];
            $uniqueId = array_values(array_filter($unique, static fn($s) => $s['cidr'] === '203.0.113.0/24'))[0]['id'];
            $first = $this->create($client, 980131, ['name' => 'CSV A', 'ip' => '198.51.100.7', 'ip_segment_id' => $segmentA,
                'additional_ips' => [['ip' => '198.51.100.8', 'label' => 'service', 'segment_id' => $segmentA]]]);
            $second = $this->create($client, 980132, ['name' => 'CSV B', 'ip' => '198.51.100.9', 'ip_segment_id' => $segmentA]);
            $this->master($client, 'save_address_space', ['id' => $spaceA, 'name' => 'A', 'ping_reachability' => 'unreachable']);
            $this->master($client, 'save_address_space', ['id' => $spaceB, 'name' => 'B', 'ping_reachability' => 'reachable']);
            $segmentB = array_values(array_filter($this->load($client)['ip_segments'], static fn(array $s): bool => $s['address_space_id'] === $spaceB))[0]['id'];
            $pingTarget = $this->create($client, 980133, ['name' => 'CSV monitored peer', 'ip' => '198.51.100.8', 'ip_segment_id' => $segmentB]);
            $columns = ['id','name','type','ip','additional_ips','facility','floor','location','manufacturer','model','asset_number','serial_number','mac_address','memo',
                'management_scheme','management_port','department','maintenance_vendor','install_date','maintenance_expiry'];
            $path = tempnam(sys_get_temp_dir(), 'net_ipam_csv_');
            $preview = function (array $devices) use ($client, $columns, $path): array {
                $stream = fopen($path, 'wb');
                fputcsv($stream, $columns, ',', '"', '');
                foreach ($devices as $device) {
                    $row = [];
                    foreach ($columns as $column) {
                        $row[] = $column === 'additional_ips'
                            ? json_encode(array_map(static fn($a) => ['ip' => $a['ip'], 'label' => $a['label']], $device['additional_ips']))
                            : ($device[$column] ?? '');
                    }
                    fputcsv($stream, $row, ',', '"', '');
                }
                fclose($stream);
                return $client->postMultipart('/api.php?action=preview_devices_csv_import',
                    ['revision' => $this->load($client)['revision']], ['devices_csv' => ['path' => $path, 'filename' => 'ipam.csv', 'type' => 'text/csv']])->assertOk()->getJson();
            };
            $commit = static function (array $preview) use ($client): void {
                $client->postJson('/api.php?action=commit_devices_csv_import', ['revision' => $preview['revision'], 'import_token' => $preview['import_token']])->assertOk();
            };
            try {
                $beforeId = $first['additional_ips'][0]['id'];
                $first['memo'] = 'membership kept';
                $p = $preview([$first]); $this->assertTrue($p['can_commit']); $commit($p);
                $current = array_column($this->load($client)['devices'], null, 'id')[$first['id']];
                $this->assertSame($segmentA, $current['ip_segment_id']);
                $this->assertSame($segmentA, $current['additional_ips'][0]['segment_id']);
                $this->assertSame($beforeId, $current['additional_ips'][0]['id']);
                $first = $current;
                $db->prepare("UPDATE device_monitor_status SET status='green',last_response_ms=7,last_error=NULL WHERE device_id IN (?,?)")->execute([$pingTarget['id'], $second['id']]);
                $beforeMonitor = $this->load($client)['monitor_revision'];
                $first['additional_ips'][0]['label'] = 'changed ambiguous purpose';
                $p = $preview([$first]); $commit($p);
                $current = array_column($this->load($client)['devices'], null, 'id')[$first['id']];
                $this->assertNull($current['additional_ips'][0]['segment_id']);
                $this->assertSame($beforeId, $current['additional_ips'][0]['id']);
                $monitors = array_column($this->load($client)['devices'], null, 'id');
                $this->assertSame('unknown', $monitors[$pingTarget['id']]['status']);
                $this->assertNull($monitors[$pingTarget['id']]['last_response_ms']);
                $this->assertStringContains('未設定・未分類', $monitors[$pingTarget['id']]['last_error']);
                $this->assertSame('green', $monitors[$second['id']]['status']);
                $this->assertSame(7, $monitors[$second['id']]['last_response_ms']);
                $this->assertSame($beforeMonitor + 1, $this->load($client)['monitor_revision']);
                $current['ip'] = '203.0.113.7';
                $current['additional_ips'][] = ['ip' => '203.0.113.8', 'label' => 'new'];
                $p = $preview([$current]); $commit($p);
                $current = array_column($this->load($client)['devices'], null, 'id')[$first['id']];
                $this->assertSame($uniqueId, $current['ip_segment_id']);
                $this->assertSame($uniqueId, $current['additional_ips'][1]['segment_id']);
                $second['ip'] = '203.0.113.8';
                $p = $preview([$second]);
                $this->assertSame(1, $p['summary']['error']);
                $this->assertFalse($p['can_commit']);
                $client->postJson('/api.php?action=commit_devices_csv_import', ['revision' => $p['revision'], 'import_token' => $p['import_token']])->assertStatus(400);
                // One batch can release an address before another device takes it.
                $current['additional_ips'][1]['ip'] = '203.0.113.9';
                $p = $preview([$current, $second]);
                $this->assertSame(0, $p['summary']['error']); $commit($p);
                $loaded = array_column($this->load($client)['devices'], null, 'id');
                $this->assertSame('203.0.113.8', $loaded[$second['id']]['ip']);
                $this->assertSame($uniqueId, $loaded[$second['id']]['ip_segment_id']);
                $this->assertSame([], $db->query('PRAGMA foreign_key_check')->fetchAll());
            } finally { @unlink($path); }
        });
    }

    public function testDeletedSegmentIdentityCannotRetargetAnUnclassifiedDraft(): void
    {
        $this->fixture(function (TestHttpClient $client, PDO $db): void {
            $spaceA = $this->master($client, 'save_address_space', ['name' => 'Original'])['address_spaces'][0]['id'];
            $segment = $this->master($client, 'save_ip_segment', ['address_space_id' => $spaceA, 'cidr' => '192.0.2.0/24'])['ip_segments'][0];
            $draft = $this->create($client, 980141, ['name' => 'Unclassified draft', 'ip' => '192.0.2.71', 'ip_segment_id' => null]);
            $draft['ip_segment_id'] = $segment['id'];
            $this->master($client, 'delete_ip_segment', ['id' => $segment['id']]);
            $spaceB = $this->master($client, 'save_address_space', ['name' => 'Replacement'])['address_spaces'][1]['id'];
            $replacement = $this->master($client, 'save_ip_segment', ['address_space_id' => $spaceB, 'cidr' => '192.0.2.0/24'])['ip_segments'][0];
            $client->postJson('/api.php?action=save_resources', ['devices' => [$this->operation($draft)], 'views' => []])->assertStatus(400);
            $current = array_column($this->load($client)['devices'], null, 'id')[$draft['id']];
            $this->assertNull($current['ip_segment_id']);
            $this->assertNotSame($segment['id'], $replacement['id']);
            $this->assertSame($draft['resource_revision'], $current['resource_revision']);
        });
    }

    public function testClassifiedIpMembershipChangeAndUnclassificationRules(): void
    {
        $this->fixture(function (TestHttpClient $client, PDO $db): void {
            $a = $this->master($client, 'create_ip_network', ['name' => 'Space A', 'segment' => ['name' => 'Seg A', 'cidr' => '192.0.2.0/24']]);
            $b = $this->master($client, 'create_ip_network', ['name' => 'Space B', 'segment' => ['name' => 'Seg B', 'cidr' => '192.0.2.0/24']]);
            $c = $this->master($client, 'create_ip_network', ['name' => 'Space C', 'segment' => ['name' => 'Seg C', 'cidr' => '198.51.100.0/24']]);
            $segA = $a['created_segment_id'];
            $segB = $b['created_segment_id'];
            $segC = $c['created_segment_id'];

            $device1 = $this->create($client, 980301, [
                'name' => 'Router 1',
                'ip' => '192.0.2.10',
                'ip_segment_id' => $segA,
                'additional_ips' => [['ip' => '192.0.2.11', 'label' => 'mgmt-sub', 'segment_id' => $segA]],
            ]);
            $device2 = $this->create($client, 980302, [
                'name' => 'Router 2',
                'ip' => '192.0.2.10',
                'ip_segment_id' => $segB,
            ]);
            $additionalId = $device1['additional_ips'][0]['id'];

            // Cross-space move of additional IP (Seg A -> Seg B) preserves IP, device, and label.
            $moved = $this->master($client, 'reclassify_ips', ['records' => [[
                'device_id' => $device1['id'], 'kind' => 'additional', 'id' => $additionalId,
                'from_segment_id' => $segA, 'segment_id' => $segB,
            ]]]);
            $this->assertSame(1, $moved['affected_count']);
            $after1 = array_column($moved['devices'], null, 'id')[$device1['id']];
            $this->assertSame('192.0.2.10', $after1['ip']);
            $this->assertSame($segA, $after1['ip_segment_id']);
            $this->assertSame('192.0.2.11', $after1['additional_ips'][0]['ip']);
            $this->assertSame('mgmt-sub', $after1['additional_ips'][0]['label']);
            $this->assertSame($segB, $after1['additional_ips'][0]['segment_id']);

            // Moving additional IP back to unclassified (segment_id: null) when no duplicate exists succeeds without confirmation.
            $unclassified = $this->master($client, 'reclassify_ips', ['records' => [[
                'device_id' => $device1['id'], 'kind' => 'additional', 'id' => $additionalId,
                'from_segment_id' => $segB, 'segment_id' => null,
            ]]]);
            $this->assertNull(array_column($unclassified['devices'], null, 'id')[$device1['id']]['additional_ips'][0]['segment_id']);

            // Stale from_segment_id or out-of-range CIDR segment is rejected with 409; same from/to segment is rejected with 400.
            $before = $this->load($client);
            $client->postJson('/api.php?action=reclassify_ips', ['expected_revision' => $before['revision'], 'records' => [[
                'device_id' => $device1['id'], 'kind' => 'management', 'id' => null,
                'from_segment_id' => $segB, 'segment_id' => $segB,
            ]]])->assertStatus(400);
            $client->postJson('/api.php?action=reclassify_ips', ['expected_revision' => $before['revision'], 'records' => [[
                'device_id' => $device1['id'], 'kind' => 'management', 'id' => null,
                'from_segment_id' => $segB, 'segment_id' => null,
            ]]])->assertStatus(409);
            $client->postJson('/api.php?action=reclassify_ips', ['expected_revision' => $before['revision'], 'records' => [[
                'device_id' => $device1['id'], 'kind' => 'management', 'id' => null,
                'from_segment_id' => $segA, 'segment_id' => $segC,
            ]]])->assertStatus(409);

            // Moving management IP (192.0.2.10) from Space A to Space B collides with Router 2 in Space B -> 400 ip_space_conflict.
            $conflictResp = $client->postJson('/api.php?action=reclassify_ips', ['expected_revision' => $before['revision'], 'records' => [[
                'device_id' => $device1['id'], 'kind' => 'management', 'id' => null,
                'from_segment_id' => $segA, 'segment_id' => $segB,
            ]]])->assertStatus(400)->getJson();
            $this->assertSame('ip_space_conflict', $conflictResp['details']['reason']);
            $this->assertSame($before, $this->load($client));

            // Moving management IP (192.0.2.10) to unclassified when Router 2 has 192.0.2.10 requires confirmation.
            $unconfirmedResp = $client->postJson('/api.php?action=reclassify_ips', ['expected_revision' => $before['revision'], 'records' => [[
                'device_id' => $device1['id'], 'kind' => 'management', 'id' => null,
                'from_segment_id' => $segA, 'segment_id' => null,
            ]]])->assertStatus(400)->getJson();
            $this->assertSame('ip_confirmation_required', $unconfirmedResp['details']['reason']);
            $this->assertSame($before, $this->load($client));

            // Confirming unclassified duplicate allows unclassifying management IP.
            $confirmedUnclassify = $this->master($client, 'reclassify_ips', [
                'ip_conflicts_confirmed' => true,
                'records' => [[
                    'device_id' => $device1['id'], 'kind' => 'management', 'id' => null,
                    'from_segment_id' => $segA, 'segment_id' => null,
                ]],
            ]);
            $this->assertNull(array_column($confirmedUnclassify['devices'], null, 'id')[$device1['id']]['ip_segment_id']);
            $this->assertSame($segB, array_column($confirmedUnclassify['devices'], null, 'id')[$device2['id']]['ip_segment_id']);
        });
    }

    public function testBulkUnclassificationKeepsDuplicateConfirmationPerRecord(): void
    {
        $this->fixture(function (TestHttpClient $client, PDO $db): void {
            $a = $this->master($client, 'create_ip_network', ['name' => 'A', 'segment' => ['name' => 'A', 'cidr' => '192.0.2.0/24']]);
            $b = $this->master($client, 'create_ip_network', ['name' => 'B', 'segment' => ['name' => 'B', 'cidr' => '192.0.2.0/24']]);
            $segment = $a['created_segment_id'];
            $device = $this->create($client, 980321, [
                'name' => 'Record confirmation router', 'ip' => '192.0.2.10', 'ip_segment_id' => $segment,
                'model' => 'Test model', 'memo' => 'Preserve device details',
                'additional_ips' => [['ip' => '192.0.2.11', 'label' => 'service', 'segment_id' => $segment]],
            ]);
            $this->create($client, 980322, [
                'name' => 'Other space router', 'ip' => '192.0.2.10', 'ip_segment_id' => $b['created_segment_id'],
                'additional_ips' => [['ip' => '192.0.2.11', 'label' => 'other service', 'segment_id' => $b['created_segment_id']]],
            ]);
            $records = [
                ['device_id' => $device['id'], 'kind' => 'management', 'id' => null, 'from_segment_id' => $segment, 'segment_id' => null],
                ['device_id' => $device['id'], 'kind' => 'additional', 'id' => $device['additional_ips'][0]['id'], 'from_segment_id' => $segment, 'segment_id' => null],
            ];
            $before = $this->load($client);
            $meta = $db->query('SELECT * FROM app_meta ORDER BY meta_key')->fetchAll(PDO::FETCH_ASSOC);
            foreach ([[false, true], [true, false], [false, false], [1, true], ['true', true]] as $confirmations) {
                $mixed = array_map(static fn(array $record, mixed $confirmed): array =>
                    $record + ['ip_conflicts_confirmed' => $confirmed], $records, $confirmations);
                $unconfirmedIps = array_values(array_filter(['192.0.2.10', '192.0.2.11'],
                    static fn(string $ip, int $index): bool => $confirmations[$index] !== true, ARRAY_FILTER_USE_BOTH));
                foreach ([$mixed, array_reverse($mixed)] as $ordered) {
                    $response = $client->postJson('/api.php?action=reclassify_ips', [
                        'expected_revision' => $before['revision'], 'records' => $ordered,
                    ])->assertStatus(400)->getJson();
                    $this->assertSame('ip_confirmation_required', $response['details']['reason']);
                    $this->assertSame($unconfirmedIps, array_column($response['details']['warnings'], 'ip'));
                    $this->assertSame($before, $this->load($client));
                    $this->assertSame($meta, $db->query('SELECT * FROM app_meta ORDER BY meta_key')->fetchAll(PDO::FETCH_ASSOC));
                }
            }

            $confirmed = array_map(static fn(array $record): array => $record + ['ip_conflicts_confirmed' => true], $records);
            $result = $this->master($client, 'reclassify_ips', ['records' => $confirmed]);
            $this->assertSame(2, $result['affected_count']);
            $this->assertSame($before['revision'] + 1, $result['revision']);
            $current = array_column($result['devices'], null, 'id')[$device['id']];
            foreach (['name', 'model', 'memo', 'ip'] as $field) {
                $this->assertSame($device[$field], $current[$field], '所属変更で機器の' . $field . 'を変更しない');
            }
            $this->assertNull($current['ip_segment_id']);
            $this->assertSame([array_replace($device['additional_ips'][0], ['segment_id' => null])], $current['additional_ips']);

            $reclassify = array_map(static fn(array $record): array =>
                array_replace($record, ['from_segment_id' => null, 'segment_id' => $segment]), $records);
            $this->master($client, 'reclassify_ips', ['records' => $reclassify]);
            // Request-level confirmation still explicitly confirms the whole batch.
            $result = $this->master($client, 'reclassify_ips', ['records' => $records, 'ip_conflicts_confirmed' => true]);
            $this->assertSame(2, $result['affected_count']);
            $current = array_column($result['devices'], null, 'id')[$device['id']];
            $this->assertNull($current['ip_segment_id']);
            $this->assertNull($current['additional_ips'][0]['segment_id']);
        });
    }

    public function testBulkUnclassificationRequiresConfirmationOnlyForNewDuplicateRecords(): void
    {
        $this->fixture(function (TestHttpClient $client, PDO $db): void {
            $a = $this->master($client, 'create_ip_network', ['name' => 'A', 'segment' => ['name' => 'A', 'cidr' => '192.0.2.0/24']]);
            $b = $this->master($client, 'create_ip_network', ['name' => 'B', 'segment' => ['name' => 'B', 'cidr' => '192.0.2.0/24']]);
            $segment = $a['created_segment_id'];
            $device = $this->create($client, 980331, [
                'name' => 'Additional confirmation router', 'ip' => '192.0.2.20', 'ip_segment_id' => $segment,
                'additional_ips' => [
                    ['ip' => '192.0.2.21', 'label' => 'duplicate', 'segment_id' => $segment],
                    ['ip' => '192.0.2.22', 'label' => 'unique', 'segment_id' => $segment],
                ],
            ]);
            $this->create($client, 980332, ['name' => 'Other space router', 'ip' => '192.0.2.21', 'ip_segment_id' => $b['created_segment_id']]);
            $records = array_map(static fn(array $address): array => [
                'device_id' => $device['id'], 'kind' => 'additional', 'id' => $address['id'],
                'from_segment_id' => $segment, 'segment_id' => null,
                'ip_conflicts_confirmed' => $address['label'] === 'duplicate',
            ], $device['additional_ips']);
            foreach ([$records, array_reverse($records)] as $ordered) {
                $before = $this->load($client);
                $unconfirmed = array_map(static fn(array $record): array =>
                    array_replace($record, ['ip_conflicts_confirmed' => false]), $ordered);
                $response = $client->postJson('/api.php?action=reclassify_ips', [
                    'expected_revision' => $before['revision'], 'records' => $unconfirmed,
                ])->assertStatus(400)->getJson();
                $this->assertSame('ip_confirmation_required', $response['details']['reason']);
                $this->assertSame(['192.0.2.21'], array_column($response['details']['warnings'], 'ip'));
                $this->assertSame($before, $this->load($client));

                $result = $this->master($client, 'reclassify_ips', ['records' => $ordered]);
                $this->assertSame(2, $result['affected_count']);
                $current = array_column($result['devices'], null, 'id')[$device['id']];
                $this->assertSame($segment, $current['ip_segment_id']);
                $this->assertSame(array_map(static fn(array $address): array =>
                    array_replace($address, ['segment_id' => null]), $device['additional_ips']), $current['additional_ips']);
                $reclassify = array_map(static fn(array $record): array =>
                    array_replace($record, ['from_segment_id' => null, 'segment_id' => $segment]), $records);
                $this->master($client, 'reclassify_ips', ['records' => $reclassify]);
            }
        });
    }

    public function testBulkUnclassificationRequiresEachChangedDeviceToConfirm(): void
    {
        $this->fixture(function (TestHttpClient $client, PDO $db): void {
            $a = $this->master($client, 'create_ip_network', ['name' => 'A', 'segment' => ['name' => 'A', 'cidr' => '192.0.2.0/24']]);
            $b = $this->master($client, 'create_ip_network', ['name' => 'B', 'segment' => ['name' => 'B', 'cidr' => '192.0.2.0/24']]);
            $first = $this->create($client, 980341, ['name' => 'First router', 'ip' => '192.0.2.30', 'ip_segment_id' => $a['created_segment_id']]);
            $second = $this->create($client, 980342, ['name' => 'Second router', 'ip' => '192.0.2.30', 'ip_segment_id' => $b['created_segment_id']]);
            $records = array_map(static fn(array $device): array => [
                'device_id' => $device['id'], 'kind' => 'management', 'id' => null,
                'from_segment_id' => $device['ip_segment_id'], 'segment_id' => null,
                'ip_conflicts_confirmed' => $device['id'] === $first['id'],
            ], [$first, $second]);
            $before = $this->load($client);
            foreach ([$records, array_reverse($records)] as $ordered) {
                $response = $client->postJson('/api.php?action=reclassify_ips', [
                    'expected_revision' => $before['revision'], 'records' => $ordered,
                ])->assertStatus(400)->getJson();
                $this->assertSame('ip_confirmation_required', $response['details']['reason']);
                $this->assertSame(['192.0.2.30'], array_column($response['details']['warnings'], 'ip'));
                $this->assertSame($before, $this->load($client));
            }
            $confirmed = array_map(static fn(array $record): array =>
                array_replace($record, ['ip_conflicts_confirmed' => true]), $records);
            $result = $this->master($client, 'reclassify_ips', ['records' => $confirmed]);
            $this->assertSame(2, $result['affected_count']);
            foreach ([$first, $second] as $device) {
                $this->assertNull(array_column($result['devices'], null, 'id')[$device['id']]['ip_segment_id']);
            }
        });
    }

    public function testBulkMembershipWithDifferentSourcesIsAtomicAndCanBeReclassified(): void
    {
        $this->fixture(function (TestHttpClient $client, PDO $db): void {
            $segmentIds = [];
            foreach (['A', 'B', 'C'] as $name) {
                $network = $this->master($client, 'create_ip_network', [
                    'name' => $name, 'segment' => ['name' => $name, 'cidr' => '192.0.2.0/24'],
                ]);
                $segmentIds[] = $network['created_segment_id'];
            }
            [$a, $b, $c] = $segmentIds;
            $device = $this->create($client, 980311, [
                'name' => 'Bulk router', 'ip' => '192.0.2.10', 'ip_segment_id' => $a,
                'additional_ips' => [['ip' => '192.0.2.11', 'label' => 'service', 'segment_id' => $b]],
            ]);
            $other = $this->create($client, 980312, [
                'name' => 'Other router', 'ip' => '192.0.2.11', 'ip_segment_id' => $c,
            ]);
            $items = [
                ['device_id' => $device['id'], 'kind' => 'management', 'id' => null, 'from_segment_id' => $a, 'segment_id' => $c],
                ['device_id' => $device['id'], 'kind' => 'additional', 'id' => $device['additional_ips'][0]['id'], 'from_segment_id' => $b, 'segment_id' => $c],
            ];
            $before = $this->load($client);
            $client->postJson('/api.php?action=reclassify_ips', [
                'expected_revision' => $before['revision'], 'records' => $items,
            ])->assertStatus(400);
            $this->assertSame($before, $this->load($client));

            $unclassify = array_map(static fn($item) => array_replace($item, ['segment_id' => null]), $items);
            $stale = $unclassify;
            $stale[1]['from_segment_id'] = $a;
            $client->postJson('/api.php?action=reclassify_ips', [
                'expected_revision' => $before['revision'], 'records' => $stale, 'ip_conflicts_confirmed' => true,
            ])->assertStatus(409);
            $this->assertSame($before, $this->load($client));
            $client->postJson('/api.php?action=reclassify_ips', [
                'expected_revision' => $before['revision'], 'records' => $unclassify,
            ])->assertStatus(400);
            $this->assertSame($before, $this->load($client));

            $result = $this->master($client, 'reclassify_ips', ['records' => $unclassify, 'ip_conflicts_confirmed' => true]);
            $this->assertSame(2, $result['affected_count']);
            $current = array_column($result['devices'], null, 'id')[$device['id']];
            $this->assertNull($current['ip_segment_id']);
            $this->assertNull($current['additional_ips'][0]['segment_id']);
            $reassign = array_map(static fn($item) => array_replace($item, ['from_segment_id' => null, 'segment_id' => $a]), $items);
            $result = $this->master($client, 'reclassify_ips', ['records' => $reassign]);
            $current = array_column($result['devices'], null, 'id')[$device['id']];
            $this->assertSame($a, $current['ip_segment_id']);
            $this->assertSame(array_replace($device['additional_ips'][0], ['segment_id' => $a]), $current['additional_ips'][0]);
            $this->assertSame($c, array_column($result['devices'], null, 'id')[$other['id']]['ip_segment_id']);
            $this->assertSame(3, count($result['ip_segments']));
        });
    }
}
