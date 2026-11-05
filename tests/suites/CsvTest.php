<?php
declare(strict_types=1);

namespace Netarium\Tests\Suites;

use Netarium\Tests\TestCase;
use Netarium\Tests\TestHttpClient;

class CsvTest extends TestCase
{
    private TestHttpClient $client;

    private const CSV_COLUMNS = ['id', 'name', 'type', 'ip', 'additional_ips', 'facility', 'floor',
        'location', 'manufacturer', 'model', 'asset_number', 'serial_number', 'mac_address', 'memo',
        'management_scheme', 'management_port', 'department', 'maintenance_vendor',
        'install_date', 'maintenance_expiry'];

    public function __construct(TestHttpClient $client)
    {
        $this->client = $client;
    }

    public function testDownloadTemplate(): void
    {
        $res = $this->client->get('/api.php?action=download_devices_csv_template');
        $res->assertStatus(200);

        $contentType = $res->getHeader('Content-Type');
        $this->assertNotNull($contentType);
        $this->assertStringContains('text/csv', $contentType);

        $disposition = $res->getHeader('Content-Disposition');
        $this->assertNotNull($disposition);
        $this->assertStringContains('netarium-devices-template.csv', $disposition);

        $body = $res->getBody();
        $this->assertStringContains('"id"', $body);
        $this->assertSame(self::CSV_COLUMNS, $this->parseCsv($body)[0]);
        $this->assertStringContains('"name"', $body);
        $this->assertStringContains('"type"', $body);
        $this->assertStringContains('"ip"', $body);
        $this->assertStringContains('"additional_ips"', $body);
        $this->assertStringContains('"memo"', $body);
        $this->assertStringContains('"management_scheme"', $body);
        $this->assertStringContains('"management_port"', $body);
        $this->assertStringContains('"department"', $body);
        $this->assertStringContains('"maintenance_vendor"', $body);
        $this->assertStringContains('"install_date"', $body);
        $this->assertStringContains('"maintenance_expiry"', $body);
    }

    public function testExportDevicesCsv(): void
    {
        $res = $this->client->get('/api.php?action=export_devices_csv');
        $res->assertStatus(200);

        $contentType = $res->getHeader('Content-Type');
        $this->assertNotNull($contentType);
        $this->assertStringContains('text/csv', $contentType);

        $body = $res->getBody();
        $this->assertStringContains('ルータ01', $body);
        $this->assertStringContains('コアSW01', $body);
        $this->assertStringContains('テストサーバ', $body);
    }

    public function testRejectLegacy13ColumnCsv(): void
    {
        $loadRes = $this->client->get('/api.php?action=load');
        $currentRev = (int)$loadRes->getJson()['revision'];

        $tempCsv = tempnam(sys_get_temp_dir(), 'net_old_csv_');
        $csvContent = "\xEF\xBB\xBF"
            . "\"id\",\"name\",\"type\",\"ip\",\"facility\",\"floor\",\"location\",\"manufacturer\",\"model\",\"asset_number\",\"serial_number\",\"mac_address\",\"memo\"\n"
            . ",\"旧CSV機器\",\"switch\",\"192.168.1.98\",\"本庁舎\",\"2F\",\"会議室\",\"Cisco\",\"C9200\",\"AST-OLD\",\"SER-OLD\",\"00:AA:BB:CC:DD:EE\",\"旧CSV\"\n";
        file_put_contents($tempCsv, $csvContent);

        try {
            $previewRes = $this->client->postMultipart(
                '/api.php?action=preview_devices_csv_import',
                ['revision' => (string)$currentRev],
                ['devices_csv' => ['path' => $tempCsv, 'filename' => 'legacy.csv', 'type' => 'text/csv']]
            );

            $previewRes->assertStatus(400);
            $previewJson = $previewRes->getJson();
            $this->assertFalse($previewJson['ok']);
            $this->assertStringContains('CSVヘッダーの列数が不正です', $previewJson['error']);
        } finally {
            @unlink($tempCsv);
        }
    }

    public function testCsvImportValidationForNewFields(): void
    {
        $loadRes = $this->client->get('/api.php?action=load');
        $currentRev = (int)$loadRes->getJson()['revision'];

        $tempCsv = tempnam(sys_get_temp_dir(), 'net_val_csv_');
        $header = "\"id\",\"name\",\"type\",\"ip\",\"additional_ips\",\"facility\",\"floor\",\"location\",\"manufacturer\",\"model\",\"asset_number\",\"serial_number\",\"mac_address\",\"memo\",\"management_scheme\",\"management_port\",\"department\",\"maintenance_vendor\",\"install_date\",\"maintenance_expiry\"\n";
        // 行1: 方式なしポート指定エラー
        // 行2: 存在しない実在日付(2026-02-29)エラー
        // 行3: 保守期限が導入年月より前エラー
        $rows = ",\"Err1\",\"switch\",\"192.168.1.101\",,,,,,,,,,,\"\",8080,\"\",\"\",\"\",\"\"\n"
            . ",\"Err2\",\"switch\",\"192.168.1.102\",,,,,,,,,,,\"http\",80,\"\",\"\",\"2026-02-29\",\"\"\n"
            . ",\"Err3\",\"switch\",\"192.168.1.103\",,,,,,,,,,,\"https\",443,\"\",\"\",\"2025-05\",\"2025-04\"\n";
        file_put_contents($tempCsv, "\xEF\xBB\xBF" . $header . $rows);

        try {
            $previewRes = $this->client->postMultipart(
                '/api.php?action=preview_devices_csv_import',
                ['revision' => (string)$currentRev],
                ['devices_csv' => ['path' => $tempCsv, 'filename' => 'val.csv', 'type' => 'text/csv']]
            );

            $previewRes->assertOk();
            $json = $previewRes->getJson();
            $this->assertSame(3, $json['summary']['error']);
            $this->assertFalse($json['can_commit']);
        } finally {
            @unlink($tempCsv);
        }
    }

    public function testCsvImportPreviewAndCommit(): void
    {
        // 1. Fetch current revision
        $loadRes = $this->client->get('/api.php?action=load');
        $currentRev = (int)$loadRes->getJson()['revision'];

        // 2. Prepare temporary CSV file for import with 20 columns
        $tempCsv = tempnam(sys_get_temp_dir(), 'net_csv_');
        $header = "\"id\",\"name\",\"type\",\"ip\",\"additional_ips\",\"facility\",\"floor\",\"location\",\"manufacturer\",\"model\",\"asset_number\",\"serial_number\",\"mac_address\",\"memo\",\"management_scheme\",\"management_port\",\"department\",\"maintenance_vendor\",\"install_date\",\"maintenance_expiry\"\n";
        $row = ",\"CSV取込新設SW\",\"switch\",\"192.168.1.99\",,\"本庁舎\",\"2F\",\"会議室\",\"Cisco\",\"C9200\",\"AST-CSV99\",\"SER-CSV99\",\"00:AA:BB:CC:DD:EE\",\"CSVインポート機器\",\"https\",8443,\"情報政策課\",\"ベンダーA\",\"2024-04-01\",\"2027-03-31\"\n";
        file_put_contents($tempCsv, "\xEF\xBB\xBF" . $header . $row);

        try {
            // 3. Post preview
            $previewRes = $this->client->postMultipart(
                '/api.php?action=preview_devices_csv_import',
                ['revision' => (string)$currentRev],
                ['devices_csv' => ['path' => $tempCsv, 'filename' => 'devices.csv', 'type' => 'text/csv']]
            );

            $previewRes->assertOk();
            $previewJson = $previewRes->getJson();

            $this->assertTrue($previewJson['ok']);
            $this->assertArrayHasKey('import_token', $previewJson);
            $this->assertArrayHasKey('summary', $previewJson);
            $this->assertSame(1, $previewJson['summary']['insert']);
            $this->assertSame(0, $previewJson['summary']['error']);
            $this->assertTrue($previewJson['can_commit']);

            $importToken = $previewJson['import_token'];

            // 4. Commit CSV import
            $commitRes = $this->client->postJson('/api.php?action=commit_devices_csv_import', [
                'import_token' => $importToken,
                'revision' => $currentRev,
            ]);

            $commitRes->assertOk();
            $commitJson = $commitRes->getJson();
            $this->assertSame('機器台帳CSVを取り込みました', $commitJson['message']);
            $this->assertSame($currentRev + 1, $commitJson['revision']);

            // 5. Verify imported device exists in load
            $newLoad = $this->client->get('/api.php?action=load');
            $devices = $newLoad->getJson()['devices'];
            $found = false;
            foreach ($devices as $d) {
                if ($d['name'] === 'CSV取込新設SW') {
                    $found = true;
                    $this->assertSame('192.168.1.99', $d['ip']);
                    $this->assertSame('switch', $d['type']);
                    $this->assertSame('https', $d['management_scheme']);
                    $this->assertSame(8443, (int)$d['management_port']);
                    $this->assertSame('情報政策課', $d['department']);
                    $this->assertSame('ベンダーA', $d['maintenance_vendor']);
                    $this->assertSame('2024-04-01', $d['install_date']);
                    $this->assertSame('2027-03-31', $d['maintenance_expiry']);
                    break;
                }
            }
            $this->assertTrue($found, 'Imported device should be in database with new fields');

        } finally {
            @unlink($tempCsv);
        }
    }

    private function withCsvFixture(callable $test): void
    {
        $server = new \Netarium\Tests\TestServer();
        $path = tempnam(sys_get_temp_dir(), 'net_csv_boundary_');
        try {
            $server->start();
            $client = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($client->login('admin', 'admin123'));
            $db = new \PDO('sqlite:' . $server->getDbPath());
            $db->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
            $test($client, $db, $path);
        } finally {
            @unlink($path);
            $server->stop();
        }
    }

    private function csvDatabaseState(\PDO $db): array
    {
        $state = [];
        // Authentication and audit records may change when requests are rejected.
        // Snapshot every topology, monitoring, image and allocation table instead.
        foreach (['views', 'devices', 'device_monitor_status', 'device_placements', 'links',
            'device_ip_addresses', 'link_systems', 'canvas_notes', 'view_floor_plans', 'device_images', 'app_meta',
            'resource_sequences'] as $table) {
            $rows = $db->query('SELECT * FROM ' . $table)->fetchAll(\PDO::FETCH_ASSOC);
            usort($rows, static fn(array $a, array $b): int => strcmp(serialize($a), serialize($b)));
            $state[$table] = $rows;
        }
        return $state;
    }

    private function parseCsv(string $csv): array
    {
        $stream = fopen('php://temp', 'w+b');
        try {
            fwrite($stream, str_starts_with($csv, "\xEF\xBB\xBF") ? substr($csv, 3) : $csv);
            rewind($stream);
            $rows = [];
            while (($row = fgetcsv($stream, null, ',', '"', '')) !== false) {
                $rows[] = $row;
            }
            return $rows;
        } finally {
            fclose($stream);
        }
    }

    private function csvDeviceRow(array $device, string $additionalIps = ''): array
    {
        return array_map(static fn(string $column): string => $column === 'additional_ips'
            ? $additionalIps : (string)($device[$column] ?? ''), self::CSV_COLUMNS);
    }

    private function additionalIpValues(array $rows): array
    {
        return array_map(static fn(array $row): array => ['ip' => $row['ip'], 'label' => $row['label']], $rows);
    }

    private function writeCsvRows(TestHttpClient $client, string $path, array $rows): void
    {
        $template = $client->get('/api.php?action=download_devices_csv_template')->assertStatus(200)->getBody();
        $header = substr($template, 0, strpos($template, "\n") + 1);
        $stream = fopen($path, 'wb');
        try {
            fwrite($stream, $header);
            foreach ($rows as $row) {
                fputcsv($stream, $row, ',', '"', '');
            }
        } finally {
            fclose($stream);
        }
    }

    private function previewCsv(TestHttpClient $client, string $path, int $revision): array
    {
        return $client->postMultipart('/api.php?action=preview_devices_csv_import',
            ['revision' => (string)$revision],
            ['devices_csv' => ['path' => $path, 'filename' => 'boundary.csv', 'type' => 'text/csv']]
        )->assertOk()->getJson();
    }

    public function testIpConflictDiagnosticLimitRejectsWholePreviewWithoutChangingData(): void
    {
        $this->withCsvFixture(function (TestHttpClient $client, \PDO $db, string $path): void {
            $before = $this->csvDatabaseState($db);
            $revision = (int)$client->get('/api.php?action=load')->assertOk()->getJson()['revision'];
            $rows = [];
            // 45 choose 2 + 5 choose 2 = exactly 1,000 new conflict pairs.
            foreach ([45, 5] as $group => $count) {
                for ($i = 0; $i < $count; $i++) {
                    $rows[] = $this->csvDeviceRow([
                        'name' => "Diagnostic-{$group}-{$i}", 'type' => 'pc',
                        'ip' => '192.0.2.' . (200 + $group),
                    ], '[]');
                }
            }
            $this->writeCsvRows($client, $path, $rows);
            $preview = $this->previewCsv($client, $path, $revision);
            $this->assertSame(50, $preview['summary']['insert']);
            $this->assertSame(50, $preview['summary']['warning']);
            $this->assertSame(0, $preview['summary']['error']);
            foreach ($preview['rows'] as $index => $row) {
                $duplicates = array_values(array_filter($row['warnings'],
                    static fn(array $warning): bool => $warning['code'] === 'duplicate_ip'));
                $this->assertSame($index < 45 ? 44 : 4, count($duplicates));
                foreach ($duplicates as $warning) {
                    $this->assertSame($row['ip'], $warning['ip']);
                }
            }
            $this->assertSame($before, $this->csvDatabaseState($db));

            foreach ([0, 1] as $i) {
                $rows[] = $this->csvDeviceRow(['name' => 'Over-limit-' . $i, 'type' => 'pc', 'ip' => '192.0.2.202'], '[]');
            }
            $this->writeCsvRows($client, $path, $rows);
            $rejected = $client->postMultipart('/api.php?action=preview_devices_csv_import',
                ['revision' => (string)$revision],
                ['devices_csv' => ['path' => $path, 'filename' => 'over-limit.csv', 'type' => 'text/csv']]
            )->assertStatus(400)->getJson();
            $this->assertSame('ip_conflict_limit', $rejected['details']['reason']);
            $this->assertFalse(isset($rejected['import_token']));
            $this->assertSame($before, $this->csvDatabaseState($db));
        });
    }

    public function testCsvAdditionalIpPreservationFinalStateWarningsAndMonitoring(): void
    {
        $this->withCsvFixture(function (TestHttpClient $client, \PDO $db, string $path): void {
            $data = $client->get('/api.php?action=load')->assertOk()->getJson();
            $first = $data['devices'][0];
            $second = $data['devices'][1];
            $firstId = (int)$first['id'];
            $secondId = (int)$second['id'];
            $db->exec("UPDATE devices SET ip = '192.0.2.81' WHERE id = {$firstId}");
            $db->exec("UPDATE devices SET ip = '192.0.2.82' WHERE id = {$secondId}");
            $db->exec("INSERT INTO device_ip_addresses(device_id,ip,label,sort_order) VALUES ({$firstId},'192.0.2.83','追加保持',0)");
            $db->exec("INSERT INTO device_monitor_status(device_id,status,last_checked_at) VALUES ({$firstId},'green','2026-01-01 00:00:00')
                ON CONFLICT(device_id) DO UPDATE SET status='green',last_checked_at='2026-01-01 00:00:00'");
            $additional = $db->query('SELECT * FROM device_ip_addresses')->fetchAll(\PDO::FETCH_ASSOC);
            $makeRow = static function (array $device, string $ip, string $memo = ''): array {
                $row = array_fill(0, 20, '');
                $row[0] = (string)$device['id'];
                $row[1] = $device['name'];
                $row[2] = $device['type'];
                $row[3] = $ip;
                $row[13] = $memo;
                return $row;
            };
            // Swap uses the final state, not the row currently being processed.
            $this->writeCsvRows($client, $path, [$makeRow($first, '192.0.2.82'), $makeRow($second, '192.0.2.81')]);
            $preview = $this->previewCsv($client, $path, (int)$data['revision']);
            $this->assertSame(0, $preview['summary']['error']);
            foreach ($preview['rows'] as $row) {
                $this->assertFalse(in_array('duplicate_ip', array_column($row['warnings'], 'code'), true));
            }
            $this->writeCsvRows($client, $path, [$makeRow($second, '192.0.2.83')]);
            $preview = $this->previewCsv($client, $path, (int)$data['revision']);
            $this->assertSame(0, $preview['summary']['error']);
            $warnings = array_values(array_filter($preview['rows'][0]['warnings'], static fn(array $w): bool => $w['code'] === 'duplicate_ip'));
            $this->assertSame(1, count($warnings));
            $this->assertTrue(str_contains($warnings[0]['message'], '192.0.2.83'));
            $this->assertTrue(str_contains($warnings[0]['message'], '機器ID ' . $firstId));
            $this->assertTrue(str_contains($warnings[0]['message'], $first['name']));
            $client->postJson('/api.php?action=commit_devices_csv_import', [
                'import_token' => $preview['import_token'], 'revision' => (int)$data['revision'],
            ])->assertOk();
            $this->assertSame($additional, $db->query('SELECT * FROM device_ip_addresses')->fetchAll(\PDO::FETCH_ASSOC));
            $this->assertSame('green', $db->query("SELECT status FROM device_monitor_status WHERE device_id = {$firstId}")->fetchColumn());
            $data = $client->get('/api.php?action=load')->assertOk()->getJson();
            $this->writeCsvRows($client, $path, [$makeRow($second, '192.0.2.83', 'IP無関係更新')]);
            $preview = $this->previewCsv($client, $path, (int)$data['revision']);
            $this->assertFalse(in_array('duplicate_ip', array_column($preview['rows'][0]['warnings'], 'code'), true));
            $this->writeCsvRows($client, $path, [$makeRow($first, '192.0.2.83')]);
            $preview = $this->previewCsv($client, $path, (int)$data['revision']);
            $this->assertSame(1, $preview['summary']['error']);
            $this->assertFalse($preview['can_commit']);
            $this->writeCsvRows($client, $path, [
                $makeRow($first, '192.0.2.84'), $makeRow($second, '192.0.2.84'),
            ]);
            $preview = $this->previewCsv($client, $path, (int)$data['revision']);
            $this->assertSame(0, $preview['summary']['error']);
            foreach ($preview['rows'] as $row) {
                $this->assertTrue(in_array('duplicate_ip', array_column($row['warnings'], 'code'), true));
            }
        });
    }

    public function testPcCsvRoundTripKeepsTypeEmptyIpAndColumnOrder(): void
    {
        $this->withCsvFixture(function (TestHttpClient $client, \PDO $db, string $path): void {
            $data = $client->get('/api.php?action=load')->assertOk()->getJson();
            $row = array_fill(0, 20, '');
            $row[1] = 'CSV PC';
            $row[2] = 'pc';
            $row[13] = 'PCメモ';
            $this->writeCsvRows($client, $path, [$row]);
            $preview = $this->previewCsv($client, $path, (int)$data['revision']);
            $this->assertTrue($preview['can_commit']);
            $this->assertSame(1, $preview['summary']['insert']);
            $client->postJson('/api.php?action=commit_devices_csv_import', [
                'import_token' => $preview['import_token'], 'revision' => (int)$data['revision'],
            ])->assertOk();
            $saved = $db->query("SELECT * FROM devices WHERE name = 'CSV PC'")->fetch(\PDO::FETCH_ASSOC);
            $this->assertSame('pc', $saved['type']);
            $this->assertSame('', $saved['ip']);
            $export = $client->get('/api.php?action=export_devices_csv')->assertStatus(200)->getBody();
            $stream = fopen('php://temp', 'w+b');
            try {
                fwrite($stream, substr($export, 3));
                rewind($stream);
                $columns = fgetcsv($stream, null, ',', '"', '');
                $this->assertSame(['id', 'name', 'type', 'ip', 'additional_ips', 'facility', 'floor', 'location',
                    'manufacturer', 'model', 'asset_number', 'serial_number', 'mac_address', 'memo',
                    'management_scheme', 'management_port', 'department', 'maintenance_vendor',
                    'install_date', 'maintenance_expiry'], $columns);
                $exported = null;
                while (($values = fgetcsv($stream, null, ',', '"', '')) !== false) {
                    if ($values[1] === 'CSV PC') {
                        $exported = $values;
                    }
                }
                $row[0] = (string)$saved['id'];
                $row[4] = '[]';
                $this->assertSame($row, $exported);
            } finally {
                fclose($stream);
            }
            file_put_contents($path, $export);
            $db->exec("UPDATE devices SET type = 'other', memo = '変更' WHERE id = " . (int)$saved['id']);
            $current = $client->get('/api.php?action=load')->assertOk()->getJson();
            $preview = $this->previewCsv($client, $path, (int)$current['revision']);
            $this->assertTrue($preview['can_commit']);
            $client->postJson('/api.php?action=commit_devices_csv_import', [
                'import_token' => $preview['import_token'], 'revision' => (int)$current['revision'],
            ])->assertOk();
            $restored = $db->query("SELECT * FROM devices WHERE id = " . (int)$saved['id'])->fetch(\PDO::FETCH_ASSOC);
            $this->assertSame('pc', $restored['type']);
            $this->assertSame('', $restored['ip']);
            $this->assertSame('PCメモ', $restored['memo']);
        });
    }

    public function testUnsafeCsvIdsAreErrorsWithoutDatabaseChanges(): void
    {
        $this->withCsvFixture(function (TestHttpClient $client, \PDO $db, string $path): void {
            $data = $client->get('/api.php?action=load')->assertOk()->getJson();
            $before = $this->csvDatabaseState($db);
            foreach (['9007199254740992', '9007199254740993', '999999999999999999999999999999', '1.5'] as $id) {
                $row = array_fill(0, 20, '');
                $row[0] = $id;
                $row[1] = 'Unsafe CSV ID';
                $row[2] = 'switch';
                $this->writeCsvRows($client, $path, [$row]);
                $preview = $this->previewCsv($client, $path, (int)$data['revision']);
                $this->assertSame(1, $preview['summary']['error']);
                $this->assertFalse($preview['can_commit']);
                $this->assertSame($before, $this->csvDatabaseState($db));
            }
        });
    }

    public function testCsvAllocationExhaustionRollsBackAllInserts(): void
    {
        $this->withCsvFixture(function (TestHttpClient $client, \PDO $db, string $path): void {
            $db->exec("UPDATE resource_sequences SET value = 9007199254740990 WHERE name = 'devices'");
            $data = $client->get('/api.php?action=load')->assertOk()->getJson();
            $rows = [];
            foreach (['Last safe CSV ID', 'Exhausted CSV ID'] as $name) {
                $row = array_fill(0, 20, '');
                $row[1] = $name;
                $row[2] = 'switch';
                $row[4] = json_encode([['ip' => '198.51.100.' . (count($rows) + 101), 'label' => '採番ロールバック']]);
                $rows[] = $row;
            }
            $this->writeCsvRows($client, $path, $rows);
            $preview = $this->previewCsv($client, $path, (int)$data['revision']);
            $this->assertSame(2, $preview['summary']['insert']);
            $before = $this->csvDatabaseState($db);
            $client->postJson('/api.php?action=commit_devices_csv_import', [
                'import_token' => $preview['import_token'], 'revision' => (int)$data['revision'],
            ])->assertStatus(409);
            $this->assertSame($before, $this->csvDatabaseState($db));
            $this->writeCsvRows($client, $path, [$rows[0]]);
            $preview = $this->previewCsv($client, $path, (int)$data['revision']);
            $client->postJson('/api.php?action=commit_devices_csv_import', [
                'import_token' => $preview['import_token'], 'revision' => (int)$data['revision'],
            ])->assertOk();
            $this->assertSame('9007199254740991', (string)$db->query(
                "SELECT id FROM devices WHERE name = 'Last safe CSV ID'"
            )->fetchColumn());
            $this->assertSame('9007199254740991', (string)$db->query(
                "SELECT value FROM resource_sequences WHERE name = 'devices'"
            )->fetchColumn());
        });
    }


    public function testLocationBoundariesRoundTripAndOversizedCsvPreservesDatabase(): void
    {
        $this->withCsvFixture(function (TestHttpClient $client, \PDO $db, string $path): void {
            foreach ([str_repeat('A', 101), str_repeat('B', 150), str_repeat('𠀀', 150)] as $location) {
                $data = $client->get('/api.php?action=load')->assertOk()->getJson();
                $device = $data['devices'][0];
                $device['location'] = $location;
                $save = static function (array $row) use ($client): void {
                    $client->postJson('/api.php?action=save_resources', [
                        'devices' => [['operation' => 'update', 'id' => (int)$row['id'],
                            'expected_revision' => (int)$row['resource_revision'], 'device' => $row]],
                        'views' => [],
                    ])->assertOk();
                };
                $save($device);
                $saved = $client->get('/api.php?action=load')->assertOk()->getJson();
                $this->assertSame($location, $saved['devices'][0]['location']);
                file_put_contents($path, $client->get('/api.php?action=export_devices_csv')->assertStatus(200)->getBody());
                $changed = $saved['devices'][0];
                $changed['location'] = '取込前の設置場所';
                $save($changed);
                $before = $client->get('/api.php?action=load')->assertOk()->getJson();
                $preview = $this->previewCsv($client, $path, (int)$before['revision']);
                $this->assertTrue($preview['can_commit']);
                $this->assertSame(0, $preview['summary']['error']);
                $client->postJson('/api.php?action=commit_devices_csv_import', [
                    'import_token' => $preview['import_token'], 'revision' => (int)$before['revision'],
                ])->assertOk();
                $after = $client->get('/api.php?action=load')->assertOk()->getJson();
                $this->assertSame($location, $after['devices'][0]['location']);
                foreach (['views', 'placements', 'links', 'canvas_notes', 'floor_plans', 'device_images'] as $key) {
                    $this->assertSame($before[$key], $after[$key]);
                }
            }
            foreach (['A', '𠀀'] as $character) {
                $data = $client->get('/api.php?action=load')->assertOk()->getJson();
                $row = array_fill(0, 20, '');
                $row[0] = (string)$data['devices'][0]['id'];
                $row[1] = '拒否時に反映してはいけない';
                $row[2] = 'switch';
                $row[7] = str_repeat($character, 151);
                $this->writeCsvRows($client, $path, [$row]);
                $before = $this->csvDatabaseState($db);
                $preview = $this->previewCsv($client, $path, (int)$data['revision']);
                $this->assertSame(1, $preview['summary']['error']);
                $this->assertFalse($preview['can_commit']);
                $this->assertSame($before, $this->csvDatabaseState($db));
                $client->postJson('/api.php?action=commit_devices_csv_import', [
                    'import_token' => $preview['import_token'], 'revision' => (int)$data['revision'],
                ])->assertStatus(400);
                $this->assertSame($before, $this->csvDatabaseState($db));
            }
        });
    }

    public function testSanitizedLocationBoundaryRestoresBeforeValidation(): void
    {
        $this->withCsvFixture(function (TestHttpClient $client, \PDO $db, string $path): void {
            foreach (['=' => 'A', '+' => '𠀀', '-' => 'A', '@' => '𠀀'] as $prefix => $character) {
                $data = $client->get('/api.php?action=load')->assertOk()->getJson();
                $device = $data['devices'][0];
                $location = $prefix . str_repeat($character, 149);
                $device['location'] = $location;
                $client->postJson('/api.php?action=save_resources', [
                    'devices' => [['operation' => 'update', 'id' => (int)$device['id'],
                        'expected_revision' => (int)$device['resource_revision'], 'device' => $device]],
                    'views' => [],
                ])->assertOk();
                $saved = $client->get('/api.php?action=load')->assertOk()->getJson();
                file_put_contents($path, $client->get('/api.php?action=export_devices_csv')->assertStatus(200)->getBody());
                $before = $this->csvDatabaseState($db);
                $preview = $this->previewCsv($client, $path, (int)$saved['revision']);
                $this->assertSame(0, $preview['summary']['error']);
                $this->assertSame(count($saved['devices']), $preview['summary']['unchanged']);
                $this->assertFalse($preview['can_commit']); // No changes, not a validation error.
                $this->assertSame($before, $this->csvDatabaseState($db));
                $stream = fopen($path, 'rb');
                $rows = [];
                try {
                    fgetcsv($stream, 0, ',', '"', '');
                    while (($row = fgetcsv($stream, 0, ',', '"', '')) !== false) $rows[] = $row;
                } finally {
                    fclose($stream);
                }
                $this->assertSame("'" . $location, $rows[0][7]);
                $rows[0][13] = '安全化境界を保持してCSVから更新 ' . $prefix;
                $this->writeCsvRows($client, $path, $rows);
                $preview = $this->previewCsv($client, $path, (int)$saved['revision']);
                $this->assertTrue($preview['can_commit']);
                $this->assertSame(0, $preview['summary']['error']);
                $this->assertSame(['memo'], $preview['rows'][0]['changed_fields']);
                $client->postJson('/api.php?action=commit_devices_csv_import', [
                    'import_token' => $preview['import_token'], 'revision' => (int)$saved['revision'],
                ])->assertOk();
                $after = $client->get('/api.php?action=load')->assertOk()->getJson();
                $this->assertSame($location, $after['devices'][0]['location']);
                $this->assertSame($rows[0][13], $after['devices'][0]['memo']);
                foreach (['views', 'placements', 'links', 'canvas_notes', 'floor_plans', 'device_images'] as $key) {
                    $this->assertSame($saved[$key], $after[$key]);
                }
            }
        });
    }

    public function testSafetyPrefixDoesNotBypassLimitsOrAlterUnmatchedValues(): void
    {
        $this->withCsvFixture(function (TestHttpClient $client, \PDO $db, string $path): void {
            $data = $client->get('/api.php?action=load')->assertOk()->getJson();
            $device = $data['devices'][0];
            $device['location'] = '=' . str_repeat('A', 149);
            $client->postJson('/api.php?action=save_resources', [
                'devices' => [['operation' => 'update', 'id' => (int)$device['id'],
                    'expected_revision' => (int)$device['resource_revision'], 'device' => $device]],
                'views' => [],
            ])->assertOk();
            $saved = $client->get('/api.php?action=load')->assertOk()->getJson();
            $row = array_fill(0, 20, '');
            $row[0] = (string)$device['id'];
            $row[1] = '安全化の拒否境界';
            $row[2] = 'switch';
            foreach ([
                [$row[0], '=' . str_repeat('A', 150)],
                [$row[0], "'=" . str_repeat('B', 149)],
                ['', "'" . $device['location']],
            ] as [$id, $location]) {
                $row[0] = $id;
                $row[7] = $location;
                $this->writeCsvRows($client, $path, [$row]);
                $before = $this->csvDatabaseState($db);
                $preview = $this->previewCsv($client, $path, (int)$saved['revision']);
                $this->assertSame(1, $preview['summary']['error']);
                $this->assertFalse($preview['can_commit']);
                $this->assertSame($before, $this->csvDatabaseState($db));
                $client->postJson('/api.php?action=commit_devices_csv_import', [
                    'import_token' => $preview['import_token'], 'revision' => (int)$saved['revision'],
                ])->assertStatus(400);
                $this->assertSame($before, $this->csvDatabaseState($db));
            }
            $row[0] = (string)$device['id'];
            $row[7] = "'=既存値とは異なる文字列";
            $newRow = $row;
            $newRow[0] = '';
            $newRow[1] = '安全化を復元しない新規機器';
            $this->writeCsvRows($client, $path, [$row, $newRow]);
            $preview = $this->previewCsv($client, $path, (int)$saved['revision']);
            $this->assertTrue($preview['can_commit']);
            $this->assertSame(0, $preview['summary']['error']);
            $client->postJson('/api.php?action=commit_devices_csv_import', [
                'import_token' => $preview['import_token'], 'revision' => (int)$saved['revision'],
            ])->assertOk();
            $after = $client->get('/api.php?action=load')->assertOk()->getJson();
            $devices = array_column($after['devices'], null, 'name');
            $this->assertSame($row[7], $devices[$row[1]]['location']);
            $this->assertSame($newRow[7], $devices[$newRow[1]]['location']);
        });
    }

    public function testMixedValidAndInvalidCsvCommitPreservesDatabase(): void
    {
        $this->withCsvFixture(function (TestHttpClient $client, \PDO $db, string $path): void {
            $data = $client->get('/api.php?action=load')->assertOk()->getJson();
            $valid = array_fill(0, 20, '');
            $valid[1] = '反映してはいけない新規機器';
            $valid[2] = 'switch';
            $valid[4] = '[{"ip":"198.51.100.110","label":"反映禁止"}]';
            $update = $valid;
            $update[0] = (string)$data['devices'][0]['id'];
            $update[1] = '反映してはいけない更新';
            $invalid = $valid;
            $invalid[1] = '';
            $this->writeCsvRows($client, $path, [$valid, $update, $invalid]);
            $before = $this->csvDatabaseState($db);
            $preview = $this->previewCsv($client, $path, (int)$data['revision']);
            $this->assertSame(1, $preview['summary']['insert']);
            $this->assertSame(1, $preview['summary']['update']);
            $this->assertSame(1, $preview['summary']['error']);
            $this->assertFalse($preview['can_commit']);
            $this->assertSame($before, $this->csvDatabaseState($db));
            $client->postJson('/api.php?action=commit_devices_csv_import', [
                'import_token' => $preview['import_token'], 'revision' => (int)$data['revision'],
            ])->assertStatus(400);
            $this->assertSame($before, $this->csvDatabaseState($db));
        });
    }

    public function testExportImportPreservesQuotedMultilineJapaneseFieldsAndTopology(): void
    {
        $this->withCsvFixture(function (TestHttpClient $client, \PDO $db, string $path): void {
            $data = $client->get('/api.php?action=load')->assertOk()->getJson();
            $device = $data['devices'][0];
            $device['name'] = '日本語 "引用", 機器';
            $device['memo'] = "一行目, \"引用\"\n二行目 日本語";
            $device['department'] = '';
            $device['management_scheme'] = '';
            $device['management_port'] = null;
            $save = function (array $row) use ($client): void {
                $client->postJson('/api.php?action=save_resources', [
                    'devices' => [['operation' => 'update', 'id' => (int)$row['id'],
                        'expected_revision' => (int)$row['resource_revision'], 'device' => $row]],
                    'views' => [],
                ])->assertOk();
            };
            $save($device);
            $expected = $client->get('/api.php?action=load')->assertOk()->getJson();
            file_put_contents($path, $client->get('/api.php?action=export_devices_csv')->assertStatus(200)->getBody());
            $changed = $expected['devices'][0];
            $changed['name'] = '復元前の名称';
            $changed['memo'] = '復元前のメモ';
            $changed['department'] = '復元前の部署';
            $changed['management_scheme'] = 'https';
            $changed['management_port'] = 8443;
            $save($changed);
            $before = $client->get('/api.php?action=load')->assertOk()->getJson();
            $preview = $this->previewCsv($client, $path, (int)$before['revision']);
            $this->assertTrue($preview['can_commit']);
            $this->assertSame(1, $preview['summary']['update']);
            $this->assertSame(0, $preview['summary']['error']);
            $client->postJson('/api.php?action=commit_devices_csv_import', [
                'import_token' => $preview['import_token'], 'revision' => (int)$before['revision'],
            ])->assertOk();
            $after = $client->get('/api.php?action=load')->assertOk()->getJson();
            foreach (['name', 'memo', 'department', 'management_scheme', 'management_port'] as $field) {
                $this->assertSame($expected['devices'][0][$field], $after['devices'][0][$field]);
            }
            foreach (['views', 'placements', 'links', 'canvas_notes', 'floor_plans', 'device_images'] as $key) {
                $this->assertSame($before[$key], $after[$key]);
            }
        });
    }

    public function testCsvPreviewRejectsConcurrentChangeWithoutApplyingRows(): void
    {
        $this->withCsvFixture(function (TestHttpClient $client, \PDO $db, string $path): void {
            $data = $client->get('/api.php?action=load')->assertOk()->getJson();
            $row = array_fill(0, 20, '');
            $row[1] = '競合後に作成してはいけない機器';
            $row[2] = 'switch';
            $row[4] = '[{"ip":"198.51.100.111","label":"競合時反映禁止"}]';
            $this->writeCsvRows($client, $path, [$row]);
            $preview = $this->previewCsv($client, $path, (int)$data['revision']);
            $device = $data['devices'][0];
            $device['memo'] = 'プレビュー後の別操作';
            $client->postJson('/api.php?action=save_resources', [
                'devices' => [['operation' => 'update', 'id' => (int)$device['id'],
                    'expected_revision' => (int)$device['resource_revision'], 'device' => $device]],
                'views' => [],
            ])->assertOk();
            $before = $this->csvDatabaseState($db);
            $client->postJson('/api.php?action=commit_devices_csv_import', [
                'import_token' => $preview['import_token'], 'revision' => (int)$data['revision'],
            ])->assertStatus(409);
            $this->assertSame($before, $this->csvDatabaseState($db));
        });
    }

    public function testCsvCommitTokenCannotApplyInsertTwice(): void
    {
        $this->withCsvFixture(function (TestHttpClient $client, \PDO $db, string $path): void {
            $data = $client->get('/api.php?action=load')->assertOk()->getJson();
            $row = array_fill(0, 20, '');
            $row[1] = '一度だけ作成する機器';
            $row[2] = 'switch';
            $row[4] = '[{"ip":"198.51.100.112","label":"一度だけ"}]';
            $this->writeCsvRows($client, $path, [$row]);
            $preview = $this->previewCsv($client, $path, (int)$data['revision']);
            $request = ['import_token' => $preview['import_token'], 'revision' => (int)$data['revision']];
            $client->postJson('/api.php?action=commit_devices_csv_import', $request)->assertOk();
            $before = $this->csvDatabaseState($db);
            $matches = $db->prepare('SELECT COUNT(*) FROM devices WHERE name = ?');
            $matches->execute([$row[1]]);
            $this->assertSame(1, (int)$matches->fetchColumn());
            $matches->closeCursor();
            $client->postJson('/api.php?action=commit_devices_csv_import', $request)->assertStatus(410);
            $this->assertSame($before, $this->csvDatabaseState($db));
        });
    }

    public function testRejectLegacy19ColumnsAndMismatchedHeaders(): void
    {
        $this->withCsvFixture(function (TestHttpClient $client, \PDO $db, string $path): void {
            $data = $client->get('/api.php?action=load')->assertOk()->getJson();
            $legacy = self::CSV_COLUMNS;
            array_splice($legacy, 4, 1);
            $renamed = self::CSV_COLUMNS;
            $renamed[4] = 'additional_ip';
            $reordered = self::CSV_COLUMNS;
            [$reordered[3], $reordered[4]] = [$reordered[4], $reordered[3]];
            $before = $this->csvDatabaseState($db);
            foreach ([$legacy, $renamed, $reordered] as $columns) {
                $stream = fopen($path, 'wb');
                fputcsv($stream, $columns, ',', '"', '');
                fputcsv($stream, array_fill(0, count($columns), ''), ',', '"', '');
                fclose($stream);
                $response = $client->postMultipart('/api.php?action=preview_devices_csv_import',
                    ['revision' => (string)$data['revision']],
                    ['devices_csv' => ['path' => $path, 'filename' => 'old.csv', 'type' => 'text/csv']]
                )->assertStatus(400)->getJson();
                $this->assertFalse($response['ok']);
                $this->assertStringContains('テンプレート', $response['error']);
                $this->assertSame($before, $this->csvDatabaseState($db));
            }
        });
    }

    public function testAdditionalIpsInsertExportImportAndReexportRoundTrip(): void
    {
        $this->withCsvFixture(function (TestHttpClient $client, \PDO $db, string $path): void {
            $data = $client->get('/api.php?action=load')->assertOk()->getJson();
            $ips = [
                ['ip' => '198.51.100.91', 'label' => "日本語, \"引用\"\n二行目 C:\\用途\\\"引用\""],
                ['ip' => '198.51.100.92', 'label' => '=SUM(1,2)'],
                ['ip' => '198.51.100.93', 'label' => '+用途'],
                ['ip' => '198.51.100.94', 'label' => '-用途'],
                ['ip' => '198.51.100.95', 'label' => '@用途'],
            ];
            $json = json_encode($ips, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
            $row = $this->csvDeviceRow(['name' => '追加IP往復', 'type' => 'pc'], $json);
            $this->writeCsvRows($client, $path, [$row]);
            $preview = $this->previewCsv($client, $path, (int)$data['revision']);
            $this->assertTrue($preview['can_commit']);
            $this->assertSame(1, $preview['summary']['insert']);
            $changes = array_column($preview['rows'][0]['changes'], null, 'field');
            $this->assertArrayHasKey('additional_ips', $changes);
            $this->assertTrue(is_string($changes['additional_ips']['before']));
            $this->assertTrue(is_string($changes['additional_ips']['after']));
            $this->assertSame($ips, json_decode($changes['additional_ips']['after'], true));
            $client->postJson('/api.php?action=commit_devices_csv_import', [
                'import_token' => $preview['import_token'], 'revision' => (int)$data['revision'],
            ])->assertOk();
            $export = $client->get('/api.php?action=export_devices_csv')->assertStatus(200)->getBody();
            $rows = $this->parseCsv($export);
            $this->assertSame(self::CSV_COLUMNS, array_shift($rows));
            $exported = array_values(array_filter($rows, static fn(array $r): bool => $r[1] === '追加IP往復'))[0];
            $this->assertSame($ips, json_decode($exported[4], true));
            foreach ($rows as $values) {
                $this->assertSame(20, count($values));
                if ($values[0] !== $exported[0]) $this->assertSame('[]', $values[4]);
            }
            $id = (int)$exported[0];
            $db->exec("DELETE FROM device_ip_addresses WHERE device_id = {$id}");
            file_put_contents($path, $export);
            $current = $client->get('/api.php?action=load')->assertOk()->getJson();
            $preview = $this->previewCsv($client, $path, (int)$current['revision']);
            $this->assertTrue($preview['can_commit']);
            $client->postJson('/api.php?action=commit_devices_csv_import', [
                'import_token' => $preview['import_token'], 'revision' => (int)$current['revision'],
            ])->assertOk();
            $this->assertSame($export, $client->get('/api.php?action=export_devices_csv')->assertStatus(200)->getBody());
            $saved = $db->query("SELECT ip,label FROM device_ip_addresses WHERE device_id = {$id} ORDER BY sort_order,id")->fetchAll(\PDO::FETCH_ASSOC);
            $this->assertSame($ips, $saved);
        });
    }

    public function testAdditionalIpsBlankReplaceAndClearPreserveIdentityAndMonitoring(): void
    {
        $this->withCsvFixture(function (TestHttpClient $client, \PDO $db, string $path): void {
            $initial = $client->get('/api.php?action=load')->assertOk()->getJson();
            $id = (int)$initial['devices'][0]['id'];
            $db->exec("INSERT INTO device_ip_addresses(device_id,ip,label,sort_order) VALUES
                ({$id},'198.51.100.71','元の用途',0),({$id},'198.51.100.72','削除対象',1)");
            $db->exec("INSERT INTO device_monitor_status(device_id,status,last_checked_at,last_response_ms,last_error)
                VALUES ({$id},'red','2026-01-02 03:04:05',12.5,'保持するエラー')
                ON CONFLICT(device_id) DO UPDATE SET status='red',last_checked_at='2026-01-02 03:04:05',
                    last_response_ms=12.5,last_error='保持するエラー'");
            $data = $client->get('/api.php?action=load')->assertOk()->getJson();
            $device = $data['devices'][0];
            $children = $db->query("SELECT * FROM device_ip_addresses WHERE device_id = {$id} ORDER BY sort_order,id")->fetchAll(\PDO::FETCH_ASSOC);
            $this->writeCsvRows($client, $path, [$this->csvDeviceRow($device),
                $this->csvDeviceRow(['name' => '空欄追加IP新規', 'type' => 'pc'])]);
            $preview = $this->previewCsv($client, $path, (int)$data['revision']);
            $this->assertSame('unchanged', $preview['rows'][0]['operation']);
            $this->assertFalse(in_array('additional_ips', $preview['rows'][0]['changed_fields'], true));
            $client->postJson('/api.php?action=commit_devices_csv_import', [
                'import_token' => $preview['import_token'], 'revision' => (int)$data['revision'],
            ])->assertOk();
            $this->assertSame($children, $db->query("SELECT * FROM device_ip_addresses WHERE device_id = {$id} ORDER BY sort_order,id")->fetchAll(\PDO::FETCH_ASSOC));
            $this->assertSame(0, (int)$db->query("SELECT COUNT(*) FROM device_ip_addresses WHERE device_id = (SELECT id FROM devices WHERE name = '空欄追加IP新規')")->fetchColumn());
            $monitor = $db->query('SELECT * FROM device_monitor_status ORDER BY device_id')->fetchAll(\PDO::FETCH_ASSOC);
            $replacement = [
                ['ip' => '198.51.100.73', 'label' => '新規先頭', 'id' => (int)$children[0]['id'], 'sort_order' => 99],
                ['ip' => '198.51.100.71', 'label' => '用途変更', 'id' => (int)$children[1]['id'], 'sort_order' => 0],
            ];
            foreach ([$replacement, []] as $values) {
                $data = $client->get('/api.php?action=load')->assertOk()->getJson();
                $before = $db->query("SELECT ip,label FROM device_ip_addresses WHERE device_id = {$id} ORDER BY sort_order,id")->fetchAll(\PDO::FETCH_ASSOC);
                $this->writeCsvRows($client, $path, [$this->csvDeviceRow($device, json_encode($values, JSON_UNESCAPED_UNICODE))]);
                $preview = $this->previewCsv($client, $path, (int)$data['revision']);
                $this->assertTrue($preview['can_commit']);
                $this->assertSame(['additional_ips'], $preview['rows'][0]['changed_fields']);
                $changes = array_column($preview['rows'][0]['changes'], null, 'field');
                $this->assertTrue(is_string($changes['additional_ips']['before']));
                $this->assertTrue(is_string($changes['additional_ips']['after']));
                $this->assertSame($before, json_decode($changes['additional_ips']['before'], true));
                $this->assertSame($this->additionalIpValues($values), json_decode($changes['additional_ips']['after'], true));
                $client->postJson('/api.php?action=commit_devices_csv_import', [
                    'import_token' => $preview['import_token'], 'revision' => (int)$data['revision'],
                ])->assertOk();
                $saved = $db->query("SELECT * FROM device_ip_addresses WHERE device_id = {$id} ORDER BY sort_order,id")->fetchAll(\PDO::FETCH_ASSOC);
                $this->assertSame($this->additionalIpValues($values), $this->additionalIpValues($saved));
                if ($values !== []) {
                    $this->assertSame((int)$children[0]['id'], (int)$saved[1]['id']);
                    $this->assertFalse((int)$saved[0]['id'] === (int)$children[0]['id']);
                    $this->assertSame([0, 1], array_map('intval', array_column($saved, 'sort_order')));
                }
                $after = $client->get('/api.php?action=load')->assertOk()->getJson();
                $this->assertSame($data['monitor_revision'], $after['monitor_revision']);
                $this->assertSame($data['last_monitored_at'], $after['last_monitored_at']);
                $this->assertSame($monitor, $db->query('SELECT * FROM device_monitor_status ORDER BY device_id')->fetchAll(\PDO::FETCH_ASSOC));
            }
        });
    }

    public function testInvalidAdditionalIpsRejectWithoutAnyDatabaseChanges(): void
    {
        $this->withCsvFixture(function (TestHttpClient $client, \PDO $db, string $path): void {
            $data = $client->get('/api.php?action=load')->assertOk()->getJson();
            $before = $this->csvDatabaseState($db);
            foreach (['[', '{}', 'null', '"文字列"', '42',
                '[{"ip":"::1","label":""}]', '[{"ip":"192.0.2.999","label":""}]',
                '[{"ip":"","label":""}]',
                '[{"ip":"198.51.100.5","label":"A"},{"ip":"198.51.100.5","label":"B"}]',
                json_encode([['ip' => $data['devices'][0]['ip'], 'label' => '管理IPと重複']]),
            ] as $invalid) {
                $valid = $this->csvDeviceRow(['name' => 'エラーと一緒に保存しない', 'type' => 'pc'], '[]');
                $this->writeCsvRows($client, $path, [$valid, $this->csvDeviceRow($data['devices'][0], $invalid)]);
                $preview = $this->previewCsv($client, $path, (int)$data['revision']);
                $this->assertSame(1, $preview['summary']['error']);
                $this->assertFalse($preview['can_commit']);
                $this->assertTrue(count($preview['rows'][1]['errors']) > 0);
                $client->postJson('/api.php?action=commit_devices_csv_import', [
                    'import_token' => $preview['import_token'], 'revision' => (int)$data['revision'],
                ])->assertStatus(400);
                $this->assertSame($before, $this->csvDatabaseState($db));
            }
        });
    }

    public function testAdditionalIpFinalStateExchangeAndTargetedDuplicateWarnings(): void
    {
        $this->withCsvFixture(function (TestHttpClient $client, \PDO $db, string $path): void {
            $data = $client->get('/api.php?action=load')->assertOk()->getJson();
            [$first, $second] = array_slice($data['devices'], 0, 2);
            $db->exec("INSERT INTO device_ip_addresses(device_id,ip,label,sort_order) VALUES
                (" . (int)$first['id'] . ",'203.0.113.81','A',0),
                (" . (int)$second['id'] . ",'203.0.113.82','B',0)");
            $encode = static fn(string $ip, string $label): string => json_encode([['ip' => $ip, 'label' => $label]], JSON_UNESCAPED_UNICODE);
            $this->writeCsvRows($client, $path, [
                $this->csvDeviceRow($first, $encode('203.0.113.82', '交換A')),
                $this->csvDeviceRow($second, $encode('203.0.113.81', '交換B')),
            ]);
            $preview = $this->previewCsv($client, $path, (int)$data['revision']);
            $this->assertTrue($preview['can_commit']);
            foreach ($preview['rows'] as $row) {
                $this->assertFalse(in_array('duplicate_ip', array_column($row['warnings'], 'code'), true));
            }
            $client->postJson('/api.php?action=commit_devices_csv_import', [
                'import_token' => $preview['import_token'], 'revision' => (int)$data['revision'],
            ])->assertOk();
            $data = $client->get('/api.php?action=load')->assertOk()->getJson();
            $this->writeCsvRows($client, $path, [$this->csvDeviceRow($second, $encode('203.0.113.82', '重複'))]);
            $preview = $this->previewCsv($client, $path, (int)$data['revision']);
            $this->assertTrue($preview['can_commit']);
            $warnings = array_values(array_filter($preview['rows'][0]['warnings'], static fn(array $w): bool => $w['code'] === 'duplicate_ip'));
            $this->assertSame(1, count($warnings));
            foreach (['203.0.113.82', '機器ID ' . $first['id'], $first['name']] as $target) {
                $this->assertStringContains($target, $warnings[0]['message']);
            }
            $client->postJson('/api.php?action=commit_devices_csv_import', [
                'import_token' => $preview['import_token'], 'revision' => (int)$data['revision'],
            ])->assertOk();
            $data = $client->get('/api.php?action=load')->assertOk()->getJson();
            $second['memo'] = '重複保持の無関係更新';
            foreach (['', $encode('203.0.113.82', '用途だけ変更')] as $additional) {
                $this->writeCsvRows($client, $path, [$this->csvDeviceRow($second, $additional)]);
                $preview = $this->previewCsv($client, $path, (int)$data['revision']);
                $this->assertTrue($preview['can_commit']);
                $this->assertFalse(in_array('duplicate_ip', array_column($preview['rows'][0]['warnings'], 'code'), true));
            }
        });
    }

    public function testGetUtf8TextLengthCodepointAccuracy(): void
    {
        $db = new \PDO('sqlite::memory:');
        $service = new \Netarium\Services\Csv\CsvImportExportService($db);
        $surrogate38 = str_repeat('𠀀', 38);
        $this->assertSame(38, $service->getUtf8TextLength($surrogate38));
        $this->assertTrue($service->isValidUtf8Text($surrogate38));
    }
}
