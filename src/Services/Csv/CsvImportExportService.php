<?php
declare(strict_types=1);

namespace Netarium\Services\Csv;

use PDO;
use PDOException;
use RuntimeException;
use Throwable;
use Netarium\Core\ApiException;
use Netarium\Core\Database;
use Netarium\Core\Request;
use Netarium\Core\ResourceId;
use Netarium\Repositories\AppMetaRepository;
use Netarium\Repositories\DeviceRepository;
use Netarium\Services\FloorPlan\FloorPlanService;
use Netarium\Services\Topology\DeviceFields;

class CsvImportExportService
{
    private PDO $db;
    private AppMetaRepository $appMetaRepo;
    private DeviceRepository $deviceRepo;

    public function __construct(PDO $db)
    {
        $this->db = $db;
        $this->appMetaRepo = new AppMetaRepository($db);
        $this->deviceRepo = new DeviceRepository($db);
    }

    /**
     * 機器台帳CSVの列定義。
     *
     * v8.4.2のCSV取込でも同じ順序を使用する。
     */
    public function getDeviceCsvColumns(): array
    {
        return [
            'id',
            'name',
            'type',
            'ip',
            'facility',
            'floor',
            'location',
            'manufacturer',
            'model',
            'asset_number',
            'serial_number',
            'mac_address',
            'memo',
            'management_scheme',
            'management_port',
            'department',
            'maintenance_vendor',
            'install_date',
            'maintenance_expiry',
        ];
    }

    /**
     * 表計算ソフトで数式として評価される可能性がある
     * 文字列をCSV出力時だけ無害化する。
     *
     * DBの値自体は変更しない。
     */
    public function sanitizeCsvSpreadsheetCell(string $value): string
    {
        if ($value === '') {
            return '';
        }

        if (preg_match('/\A[=\-+@\t\r\n]/u', $value) === 1) {
            return "'" . $value;
        }

        return $value;
    }

    /**
     * CSV出力時に数式対策の対象となる値か確認する。
     */
    public function requiresCsvSpreadsheetSanitization(string $value): bool
    {
        if ($value === '') {
            return false;
        }

        return preg_match('/\A[=\-+@\t\r\n]/u', $value) === 1;
    }

    /**
     * CSVセルが、出力時に安全化された形か確認する。
     */
    public function isSanitizedCsvSpreadsheetCell(string $value): bool
    {
        if (strlen($value) < 2 || $value[0] !== "'") {
            return false;
        }

        return $this->requiresCsvSpreadsheetSanitization(substr($value, 1));
    }

    /**
     * CSV出力時に付与されたアポストロフィを、
     * DB既存値と一致する場合だけ復元する。
     */
    public function restoreDeviceCsvSpreadsheetCell(
        string $csvValue,
        string $existingValue,
        string $field,
        string $label
    ): array {
        if (!$this->isSanitizedCsvSpreadsheetCell($csvValue)) {
            return [
                'value' => $csvValue,
                'transformation' => null,
            ];
        }

        $restoredValue = substr($csvValue, 1);

        if ($restoredValue !== $existingValue) {
            return [
                'value' => $csvValue,
                'transformation' => null,
            ];
        }

        return [
            'value' => $restoredValue,
            'transformation' => [
                'code' => 'restore_spreadsheet_sanitization',
                'field' => $field,
                'label' => $label,
                'before' => $csvValue,
                'after' => $restoredValue,
                'message' => 'CSV出力時に付与された安全化文字を復元しました',
            ],
        ];
    }

    /**
     * 全項目をダブルクォートで囲み、
     * CRLFで終わるCSV行を生成する。
     */
    public function encodeCsvRow(array $values): string
    {
        $escaped = [];

        foreach ($values as $value) {
            $text = (string)$value;
            $escaped[] = '"' . str_replace('"', '""', $text) . '"';
        }

        return implode(',', $escaped) . "\r\n";
    }

    /**
     * CSVダウンロード用ヘッダーと
     * UTF-8 BOMを出力する。
     */
    public function beginCsvDownload(string $filename): void
    {
        if (preg_match('/\A[A-Za-z0-9._-]+\.csv\z/', $filename) !== 1) {
            throw new ApiException('CSVファイル名が不正です', 500);
        }

        if (headers_sent()) {
            throw new ApiException('CSVヘッダーを送信できません', 500);
        }

        header_remove('Content-Type');
        header('Content-Type: text/csv; charset=UTF-8', true);
        header('Content-Disposition: attachment; filename="' . $filename . '"', true);
        header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0', true);
        header('Pragma: no-cache', true);
        header('Expires: 0', true);
        header('X-Content-Type-Options: nosniff', true);

        /*
         * IISやPHPの出力バッファに既存内容が
         * 残っている場合は、CSVへ混入させない。
         */
        while (ob_get_level() > 0) {
            if (!@ob_end_clean()) {
                break;
            }
        }

        echo "\xEF\xBB\xBF";
    }

    /**
     * 全項目をダブルクォートで囲み、
     * CRLFでCSVを1行出力する。
     */
    public function writeCsvRow($stream, array $values): void
    {
        $line = $this->encodeCsvRow($values);

        $length = strlen($line);
        $offset = 0;
        while ($offset < $length) {
            $written = fwrite($stream, $offset === 0 ? $line : substr($line, $offset));
            if ($written === false || $written === 0) {
                throw new RuntimeException('CSVを出力できません');
            }
            $offset += $written;
        }
    }

    /**
     * DB正式データを1件ずつ取得して、
     * CSVへ直接出力する。
     */
    public function exportDevicesCsv(): int
    {
        $columns = $this->getDeviceCsvColumns();

        /*
         * SQL実行はレスポンス開始前に行う。
         * SQL構文エラー等はJSONエラーとして返せる。
         */
        $stmt = $this->db->query("
            SELECT
                id,
                name,
                type,
                ip,
                facility,
                floor,
                location,
                manufacturer,
                model,
                asset_number,
                serial_number,
                mac_address,
                memo,
                management_scheme,
                management_port,
                department,
                maintenance_vendor,
                install_date,
                maintenance_expiry
            FROM devices
            ORDER BY id
        ");

        $filename = 'netarium-devices_' . date('Ymd_His') . '.csv';

        $this->beginCsvDownload($filename);

        $output = fopen('php://output', 'wb');

        if ($output === false) {
            throw new RuntimeException('CSV出力先を開けません');
        }
        $rowCount = 0;
        try {
            $this->writeCsvRow($output, $columns);

            while (($device = $stmt->fetch(PDO::FETCH_ASSOC)) !== false) {
                $row = [];

                foreach ($columns as $column) {
                    $value = (string)($device[$column] ?? '');

                    if ($column !== 'id') {
                        $value = $this->sanitizeCsvSpreadsheetCell($value);
                    }

                    $row[] = $value;
                }

                $this->writeCsvRow($output, $row);
                $rowCount++;
            }

        } finally {
            if (!fclose($output)) {
                throw new RuntimeException('CSV出力を完了できません');
            }
        }
        return $rowCount;
    }

    /**
     * CSV取込用の空テンプレートを出力する。
     */
    public function downloadDevicesCsvTemplate(): void
    {
        $this->beginCsvDownload('netarium-devices-template.csv');

        $output = fopen('php://output', 'wb');

        if ($output === false) {
            throw new RuntimeException('CSV出力先を開けません');
        }

        try {
            $this->writeCsvRow($output, $this->getDeviceCsvColumns());
        } catch (Throwable $e) {
            error_log('[Netarium CSV] ' . get_class($e) . ': ' . $e->getMessage());
        } finally {
            fclose($output);
        }

        exit;
    }

    /**
     * CSV取込で許可する機器種別。
     */
    public function getAllowedDeviceCsvTypes(): array
    {
        return [
            'switch',
            'l3_switch',
            'router',
            'firewall',
            'ap',
            'server',
            'printer',
            'other',
        ];
    }

    /**
     * CSV各列の最大文字数。
     */
    public function getDeviceCsvTextLimits(): array
    {
        return [
            'name' => 100,
            'facility' => 100,
            'floor' => 50,
            'location' => 150,
            'manufacturer' => 100,
            'model' => 100,
            'asset_number' => 100,
            'serial_number' => 100,
            'mac_address' => 50,
            'memo' => 1000,
            'department' => 100,
            'maintenance_vendor' => 100,
        ];
    }

    public function getUtf8TextLength(string $text): int
    {
        if (function_exists('mb_strlen')) {
            return mb_strlen($text, 'UTF-8');
        }

        if (function_exists('iconv_strlen')) {
            $len = @iconv_strlen($text, 'UTF-8');
            if ($len !== false) {
                return $len;
            }
        }

        $count = @preg_match_all('/./us', $text);
        if ($count !== false) {
            return $count;
        }

        return strlen($text);
    }

    public function isValidUtf8Text(string $text): bool
    {
        if ($text === '') {
            return true;
        }

        if (function_exists('mb_check_encoding')) {
            return mb_check_encoding($text, 'UTF-8');
        }

        return preg_match('//u', $text) === 1;
    }

    public function containsForbiddenCsvControlCharacters(string $text): bool
    {
        return preg_match('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/u', $text) === 1;
    }

    public function isEmptyCsvRow(array $row): bool
    {
        foreach ($row as $cell) {
            if (trim((string)$cell) !== '') {
                return false;
            }
        }

        return true;
    }

    public function removeUtf8Bom(string $text): string
    {
        if (str_starts_with($text, "\xEF\xBB\xBF")) {
            return substr($text, 3);
        }

        return $text;
    }

    public function normalizeDeviceCsvComparable(array $device): array
    {
        $normalized = [];

        foreach ($this->getDeviceCsvColumns() as $column) {
            if ($column === 'id') {
                $id = $device['id'] ?? null;
                $normalized['id'] = ($id !== null && $id !== '') ? ResourceId::parse($id, 'id') : null;
                continue;
            }

            $normalized[$column] = trim((string)($device[$column] ?? ''));
        }

        return $normalized;
    }

    public function getDeviceCsvColumnLabels(): array
    {
        return [
            'id' => '機器ID',
            'name' => '名称',
            'type' => '種別',
            'ip' => 'IPアドレス',
            'facility' => '施設',
            'floor' => 'フロア',
            'location' => '設置場所',
            'manufacturer' => 'メーカー',
            'model' => '型番',
            'asset_number' => '管理番号',
            'serial_number' => 'シリアル番号',
            'mac_address' => 'MACアドレス',
            'memo' => '備考',
            'management_scheme' => '管理接続方式',
            'management_port' => '管理接続ポート',
            'department' => '担当部署',
            'maintenance_vendor' => '保守ベンダー',
            'install_date' => '導入年月',
            'maintenance_expiry' => '保守期限',
        ];
    }

    public function compareDeviceCsvFields(array $currentDevice, array $newDevice): array
    {
        $currentNormalized = $this->normalizeDeviceCsvComparable($currentDevice);
        $newNormalized = $this->normalizeDeviceCsvComparable($newDevice);

        $labels = $this->getDeviceCsvColumnLabels();
        $changedFields = [];
        $changes = [];

        foreach ($this->getDeviceCsvColumns() as $column) {
            if ($column === 'id') {
                continue;
            }

            $before = (string)($currentNormalized[$column] ?? '');
            $after = (string)($newNormalized[$column] ?? '');

            if ($before !== $after) {
                $changedFields[] = $column;
                $changes[] = [
                    'field' => $column,
                    'label' => (string)($labels[$column] ?? $column),
                    'before' => $before,
                    'after' => $after,
                ];
            }
        }

        return [
            'changed_fields' => $changedFields,
            'changes' => $changes,
        ];
    }

    public function createDeviceCsvWarning(string $code, string $message, ?string $field = null): array
    {
        return [
            'code' => $code,
            'field' => $field,
            'message' => $message,
        ];
    }

    public function isCommonMacAddressFormat(string $mac): bool
    {
        $mac = trim($mac);

        if ($mac === '') {
            return true;
        }

        $patterns = [
            '/\A[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5}\z/',
            '/\A[0-9A-Fa-f]{2}(?:-[0-9A-Fa-f]{2}){5}\z/',
            '/\A[0-9A-Fa-f]{4}(?:\.[0-9A-Fa-f]{4}){2}\z/',
            '/\A[0-9A-Fa-f]{12}\z/',
        ];

        foreach ($patterns as $pattern) {
            if (preg_match($pattern, $mac) === 1) {
                return true;
            }
        }

        return false;
    }

    public function normalizeDeviceCsvDuplicateKey(string $key, bool $caseInsensitive = true): string
    {
        $key = trim($key);

        if ($key === '') {
            return '';
        }

        if (!$caseInsensitive) {
            return $key;
        }

        if (function_exists('mb_strtoupper')) {
            return mb_strtoupper($key, 'UTF-8');
        }

        return strtoupper($key);
    }

    public function hasDeviceCsvWarning(array $warnings, string $code, ?string $field = null): bool
    {
        foreach ($warnings as $warning) {
            if (
                is_array($warning) &&
                ($warning['code'] ?? '') === $code &&
                ($field === null || ($warning['field'] ?? null) === $field)
            ) {
                return true;
            }
        }

        return false;
    }

    public function parseAndValidateDevicesCsvImport(string $filePath, int $maxRows): array
    {
        if (!is_file($filePath)) {
            throw new ApiException('CSV取込ファイルが見つかりません', 400);
        }

        $stream = fopen($filePath, 'rb');

        if ($stream === false) {
            throw new ApiException('CSV取込ファイルを開けません', 500);
        }

        $columns = $this->getDeviceCsvColumns();
        $columnCount = count($columns);
        $devicesById = $this->deviceRepo->getDevicesByIdForCsvImport();

        $rows = [];
        $summary = [
            'total' => 0,
            'insert' => 0,
            'update' => 0,
            'unchanged' => 0,
            'warning' => 0,
            'error' => 0,
        ];

        $usedCsvIds = [];
        $usedIps = [];
        $dataRowCount = 0;
        $physicalLine = 1;

        try {
            $header = fgetcsv($stream);

            if ($header === false) {
                throw new ApiException('CSVヘッダーを読み取れません', 400);
            }

            $header = array_map(
                function ($value): string {
                    $text = trim($this->removeUtf8Bom((string)$value));

                    if (
                        strlen($text) >= 2 &&
                        $text[0] === '"' &&
                        $text[strlen($text) - 1] === '"'
                    ) {
                        $text = substr($text, 1, -1);
                        $text = str_replace('""', '"', $text);
                    }

                    return trim($text);
                },
                $header
            );

            if (count($header) !== $columnCount) {
                throw new ApiException('CSVヘッダーの列数が不正です', 400);
            }

            foreach ($columns as $index => $column) {
                if ((string)$header[$index] !== $column) {
                    $actual = (string)($header[$index] ?? '');

                    throw new ApiException(
                        'CSVヘッダーの' . ($index + 1) . '列目が不正です。期待値: ' . $column . ' / 実際: ' . $actual,
                        400
                    );
                }
            }

            while (($values = fgetcsv($stream)) !== false) {
                $physicalLine++;

                if ($this->isEmptyCsvRow($values)) {
                    continue;
                }

                $dataRowCount++;

                if ($dataRowCount > $maxRows) {
                    throw new ApiException("CSVのデータ行は最大{$maxRows}件です", 400);
                }

                $errors = [];
                $warnings = [];
                $transformations = [];

                if (count($values) !== $columnCount) {
                    $errors[] = "列数が{$columnCount}列ではありません";
                    $rows[] = [
                        'line' => $physicalLine,
                        'operation' => 'error',
                        'id' => null,
                        'name' => '',
                        'ip' => '',
                        'changed_fields' => [],
                        'changes' => [],
                        'transformations' => [],
                        'warnings' => [],
                        'errors' => $errors,
                        'data' => null,
                    ];
                    $summary['total']++;
                    $summary['error']++;
                    continue;
                }

                $record = array_combine(
                    $columns,
                    array_map(
                        static fn($value): string => trim((string)$value),
                        $values
                    )
                );

                if ($record === false) {
                    throw new RuntimeException('CSV行を解析できません');
                }

                foreach ($record as $column => $value) {
                    if (!$this->isValidUtf8Text($value)) {
                        $errors[] = "{$column}: UTF-8として読み取れません";
                    }

                    if ($this->containsForbiddenCsvControlCharacters($value)) {
                        $errors[] = "{$column}: 使用できない制御文字が含まれています";
                    }
                }

                $id = null;
                $idText = $record['id'];

                if ($idText !== '') {
                    try {
                        if (preg_match('/\A[1-9][0-9]*\z/', $idText) !== 1) {
                            throw new ApiException('id: 正の整数で指定してください', 400);
                        }
                        $id = ResourceId::parse($idText, 'id');
                    } catch (ApiException $e) {
                        $errors[] = $e->getMessage();
                    }
                    if ($id !== null) {
                        if (isset($usedCsvIds[$id])) {
                            $errors[] = "id: {$id}がCSV内で重複しています";
                        } else {
                            $usedCsvIds[$id] = true;

                            if (!isset($devicesById[$id])) {
                                $errors[] = "id: {$id}は既存台帳に存在しません。新規機器はidを空欄にしてください";
                            }
                        }
                    }
                }

                /*
                 * 既存機器の更新行だけ、
                 * CSV出力時に付与された安全化文字を復元する。
                 * 安全化文字を上限に数えないよう、項目検証より先に行う。
                 */
                if ($errors === [] && $id !== null && isset($devicesById[$id])) {
                    $labels = $this->getDeviceCsvColumnLabels();

                    foreach ($this->getDeviceCsvColumns() as $column) {
                        if ($column === 'id') {
                            continue;
                        }

                        $result = $this->restoreDeviceCsvSpreadsheetCell(
                            (string)($record[$column] ?? ''),
                            (string)($devicesById[$id][$column] ?? ''),
                            $column,
                            (string)($labels[$column] ?? $column)
                        );

                        $record[$column] = $result['value'];

                        if (is_array($result['transformation'])) {
                            $transformations[] = $result['transformation'];
                        }
                    }
                }

                if ($record['name'] === '') {
                    $errors[] = 'name: 名称は必須です';
                }

                if (!in_array($record['type'], $this->getAllowedDeviceCsvTypes(), true)) {
                    $errors[] = 'type: 使用できない機器種別です';
                }

                if ($record['ip'] !== '' && !filter_var($record['ip'], FILTER_VALIDATE_IP, FILTER_FLAG_IPV4)) {
                    $errors[] = 'ip: IPv4形式で入力してください';
                }

                foreach ($this->getDeviceCsvTextLimits() as $column => $maxLength) {
                    if ($this->getUtf8TextLength($record[$column]) > $maxLength) {
                        $errors[] = "{$column}: {$maxLength}文字以内で入力してください";
                    }
                }

                $scheme = $record['management_scheme'];
                if (!in_array($scheme, DeviceFields::ALLOWED_SCHEMES, true)) {
                    $errors[] = 'management_scheme: 使用できない管理接続方式です';
                }

                $portText = $record['management_port'];
                if ($portText !== '') {
                    if (preg_match('/\A[0-9]+\z/', $portText) !== 1) {
                        $errors[] = 'management_port: 1〜65535の整数で入力してください';
                    } else {
                        $portNum = (int)$portText;
                        if ($portNum < 1 || $portNum > 65535) {
                            $errors[] = 'management_port: 1〜65535の範囲で入力してください';
                        } elseif ($scheme === '') {
                            $errors[] = 'management_port: 管理接続方式が設定されていない場合、ポートは指定できません';
                        }
                    }
                }

                $installDate = $record['install_date'];
                if ($installDate !== '' && !DeviceFields::isValidDateString($installDate)) {
                    $errors[] = 'install_date: 実在する年月(YYYY-MM)または年月日(YYYY-MM-DD)で入力してください';
                }

                $maintenanceExpiry = $record['maintenance_expiry'];
                if ($maintenanceExpiry !== '' && !DeviceFields::isValidDateString($maintenanceExpiry)) {
                    $errors[] = 'maintenance_expiry: 実在する年月(YYYY-MM)または年月日(YYYY-MM-DD)で入力してください';
                }

                if ($installDate !== '' && $maintenanceExpiry !== '' &&
                    DeviceFields::isValidDateString($installDate) && DeviceFields::isValidDateString($maintenanceExpiry) &&
                    !DeviceFields::validateDateOrder($installDate, $maintenanceExpiry)) {
                    $errors[] = 'maintenance_expiry: 保守期限は導入年月以降の日付を指定してください';
                }

                $ip = $record['ip'];

                if ($ip !== '') {
                    if (isset($usedIps[$ip])) {
                        $errors[] = "ip: {$ip}がCSV内で重複しています";
                    } else {
                        $usedIps[$ip] = [
                            'line' => $physicalLine,
                            'id' => $id,
                        ];
                    }
                }

                $operation = 'insert';
                $comparison = [
                    'changed_fields' => [],
                    'changes' => [],
                ];

                if ($id !== null && isset($devicesById[$id])) {
                    $comparison = $this->compareDeviceCsvFields($devicesById[$id], $record);
                    $operation = $comparison['changed_fields'] === [] ? 'unchanged' : 'update';
                }

                /*
                 * 確定を妨げない行単位の警告。
                 */
                if ($errors === []) {
                    if ($operation === 'insert') {
                        $warnings[] = $this->createDeviceCsvWarning(
                            'new_device_unplaced',
                            '新規機器は取込後もどのビューにも配置されません',
                            null
                        );
                    }

                    if ($operation === 'update' && isset($devicesById[$id])) {
                        $oldIp = trim((string)$devicesById[$id]['ip']);
                        $newIp = trim((string)$record['ip']);

                        if ($oldIp !== '' && $newIp === '') {
                            $warnings[] = $this->createDeviceCsvWarning(
                                'ip_cleared',
                                'IPアドレスが空欄へ変更されます',
                                'ip'
                            );
                        }

                        if ($oldIp !== $newIp) {
                            $warnings[] = $this->createDeviceCsvWarning(
                                'monitor_reset',
                                'IP変更により監視状態が未確認へ戻ります',
                                'ip'
                            );
                        }
                    }

                    if ($record['mac_address'] !== '' && !$this->isCommonMacAddressFormat($record['mac_address'])) {
                        $warnings[] = $this->createDeviceCsvWarning(
                            'unusual_mac_format',
                            'MACアドレスが一般的な形式ではありません',
                            'mac_address'
                        );
                    }
                }

                $rows[] = [
                    'line' => $physicalLine,
                    'operation' => $errors === [] ? $operation : 'error',
                    'id' => $id,
                    'name' => $record['name'],
                    'ip' => $record['ip'],
                    'changed_fields' => $comparison['changed_fields'],
                    'changes' => $comparison['changes'],
                    'transformations' => $transformations,
                    'warnings' => $warnings,
                    'errors' => $errors,
                    'data' => $record,
                ];

                $summary['total']++;

                if ($errors !== []) {
                    $summary['error']++;
                } else {
                    $summary[$operation]++;
                }
            }
        } finally {
            fclose($stream);
        }

        if ($summary['total'] === 0) {
            throw new ApiException('CSVにデータ行がありません', 400);
        }

        /*
         * CSVに含まれない既存機器を含めた
         * 最終状態でIP重複を検証する。
         */
        $finalIpOwners = [];

        foreach ($devicesById as $existingId => $existing) {
            $existingIp = trim((string)$existing['ip']);

            if ($existingIp !== '') {
                $finalIpOwners[$existingIp] = (int)$existingId;
            }
        }

        foreach ($rows as &$row) {
            if ($row['data'] === null || $row['errors'] !== []) {
                continue;
            }

            $record = $row['data'];
            $id = $row['id'];

            /*
             * 更新の場合は、更新前IPの所有を解除する。
             */
            if ($id !== null && isset($devicesById[$id])) {
                $oldIp = trim((string)$devicesById[$id]['ip']);

                if ($oldIp !== '' && ($finalIpOwners[$oldIp] ?? null) === $id) {
                    unset($finalIpOwners[$oldIp]);
                }
            }

            $newIp = $record['ip'];

            if ($newIp === '') {
                continue;
            }

            if (isset($finalIpOwners[$newIp])) {
                $row['errors'][] = "ip: {$newIp}は機器ID {$finalIpOwners[$newIp]}で使用されています";
                $row['operation'] = 'error';

                $summary[$id === null ? 'insert' : (
                    $this->normalizeDeviceCsvComparable($devicesById[$id]) ===
                    $this->normalizeDeviceCsvComparable($record) ? 'unchanged' : 'update'
                )]--;

                $summary['error']++;
                continue;
            }

            if ($id !== null) {
                $finalIpOwners[$newIp] = $id;
            } else {
                /*
                 * 新規機器は負数の仮所有者として扱う。
                 */
                $finalIpOwners[$newIp] = -1 * (int)$row['line'];
            }
        }
        unset($row);

        /*
         * 管理番号とシリアル番号は、
         * CSV反映後の最終状態で重複を警告する。
         */
        $finalDevicesById = $devicesById;
        $newDeviceRowKeys = [];

        foreach ($rows as $rowIndex => $row) {
            if (
                !is_array($row) ||
                !is_array($row['data'] ?? null) ||
                $row['errors'] !== []
            ) {
                continue;
            }

            $record = $row['data'];
            $rowId = $row['id'];

            if ($rowId !== null && isset($finalDevicesById[$rowId])) {
                $finalDevicesById[$rowId] = array_merge(
                    $finalDevicesById[$rowId],
                    $record
                );
                continue;
            }

            /*
             * 新規行はDBの正式IDが未採番なので、
             * 行番号を一時キーとして保持する。
             */
            $temporaryKey = 'new:' . (string)$row['line'];
            $finalDevicesById[$temporaryKey] = $record;
            $newDeviceRowKeys[$temporaryKey] = $rowIndex;
        }

        $duplicateFields = [
            'asset_number' => '管理番号',
            'serial_number' => 'シリアル番号',
        ];

        foreach ($duplicateFields as $field => $label) {
            $owners = [];

            foreach ($finalDevicesById as $ownerKey => $device) {
                $value = trim((string)($device[$field] ?? ''));
                $normalizedValue = $this->normalizeDeviceCsvDuplicateKey($value);

                if ($normalizedValue === '') {
                    continue;
                }

                $owners[$normalizedValue][] = [
                    'owner_key' => (string)$ownerKey,
                    'value' => $value,
                ];
            }

            foreach ($owners as $items) {
                if (count($items) < 2) {
                    continue;
                }

                $ownerLabels = [];

                foreach ($items as $item) {
                    $ownerKey = (string)$item['owner_key'];

                    if (str_starts_with($ownerKey, 'new:')) {
                        $rowIndex = $newDeviceRowKeys[$ownerKey] ?? null;

                        if ($rowIndex !== null) {
                            $ownerLabels[] = 'CSV行' . (string)$rows[$rowIndex]['line'];
                        }
                        continue;
                    }

                    $ownerLabels[] = '機器ID ' . $ownerKey;
                }

                $ownerText = implode('、', $ownerLabels);

                foreach ($rows as &$targetRow) {
                    if (
                        !is_array($targetRow['data'] ?? null) ||
                        $targetRow['errors'] !== []
                    ) {
                        continue;
                    }

                    $targetValue = $this->normalizeDeviceCsvDuplicateKey(
                        (string)($targetRow['data'][$field] ?? '')
                    );

                    $duplicateValue = $this->normalizeDeviceCsvDuplicateKey(
                        (string)($items[0]['value'] ?? '')
                    );

                    if ($targetValue === '' || $targetValue !== $duplicateValue) {
                        continue;
                    }

                    $warningCode = $field === 'asset_number'
                        ? 'duplicate_asset_number'
                        : 'duplicate_serial_number';

                    if ($this->hasDeviceCsvWarning($targetRow['warnings'], $warningCode, $field)) {
                        continue;
                    }

                    $targetRow['warnings'][] = $this->createDeviceCsvWarning(
                        $warningCode,
                        "{$label}が重複しています（{$ownerText}）",
                        $field
                    );
                }
                unset($targetRow);
            }
        }

        /*
         * 警告行数を最終状態から集計する。
         */
        $summary['warning'] = 0;

        foreach ($rows as $row) {
            if (
                $row['errors'] === [] &&
                is_array($row['warnings'] ?? null) &&
                $row['warnings'] !== []
            ) {
                $summary['warning']++;
            }
        }

        return [
            'rows' => $rows,
            'summary' => $summary,
        ];
    }

    /**
     * 一時取込ディレクトリを準備する。
     */
    public function prepareDeviceCsvImportDirectory(array $config): string
    {
        $directory = (string)($config['device_csv_import_directory'] ?? '');

        if ($directory === '') {
            throw new ApiException('CSV取込一時保存先が設定されていません', 500);
        }

        if (
            !is_dir($directory) &&
            !@mkdir($directory, 0700, true) &&
            !is_dir($directory)
        ) {
            throw new ApiException('CSV取込一時保存先を作成できません', 500);
        }

        if (!is_writable($directory)) {
            throw new ApiException('CSV取込一時保存先へ書き込めません', 500);
        }

        return $directory;
    }

    /**
     * 期限切れのCSV取込一時ファイルを削除する。
     */
    public function cleanupExpiredDeviceCsvImports(string $directory, int $ttlSeconds): void
    {
        if (!is_dir($directory)) {
            return;
        }

        $now = time();
        $files = scandir($directory);

        if ($files === false) {
            return;
        }

        foreach ($files as $file) {
            if (!str_ends_with($file, '.json')) {
                continue;
            }

            $path = $directory . DIRECTORY_SEPARATOR . $file;

            if (!is_file($path)) {
                continue;
            }

            $mtime = filemtime($path);

            if ($mtime !== false && ($now - $mtime) > $ttlSeconds) {
                @unlink($path);
            }
        }
    }

    public function getDeviceCsvImportSigningKey(): string
    {
        return hash(
            'sha256',
            __FILE__ . '|' . currentUserId() . '|' . currentUsername()
        );
    }

    public function createDeviceCsvImportSignature(
        string $token,
        string $userId,
        int $revision,
        int $expiresAt
    ): string {
        return hash_hmac(
            'sha256',
            $token . '|' . $userId . '|' . $revision . '|' . $expiresAt,
            $this->getDeviceCsvImportSigningKey()
        );
    }

    public function loadDeviceCsvImportPreview(string $directory, string $token): array
    {
        if (preg_match('/\A[a-f0-9]{64}\z/', $token) !== 1) {
            throw new ApiException('CSV取込トークンが不正です', 400);
        }

        $path = $directory . DIRECTORY_SEPARATOR . $token . '.json';

        if (!is_file($path)) {
            throw new ApiException('CSV取込プレビューが見つからないか、既に使用されています', 410);
        }

        $json = file_get_contents($path);

        if ($json === false) {
            throw new ApiException('CSV取込プレビューを読み取れません', 500);
        }

        $payload = json_decode($json, true, 512, JSON_THROW_ON_ERROR);

        if (!is_array($payload)) {
            throw new ApiException('CSV取込プレビューが不正です', 400);
        }

        $payload['_path'] = $path;

        return $payload;
    }

    /**
     * CSV取込のプレビュー処理
     */
    public function previewImport(int $requestedRevision, array $upload, array $config): array
    {
        $this->appMetaRepo->requireMatchingDataRevision($requestedRevision);

        $uploadError = (int)($upload['error'] ?? UPLOAD_ERR_NO_FILE);

        if ($uploadError !== UPLOAD_ERR_OK) {
            throw new ApiException('CSVファイルをアップロードできませんでした', 400);
        }

        $temporaryPath = (string)($upload['tmp_name'] ?? '');

        if ($temporaryPath === '' || !is_uploaded_file($temporaryPath)) {
            throw new ApiException('アップロードされたCSVを確認できません', 400);
        }

        $fileSize = (int)($upload['size'] ?? 0);
        $maxBytes = max(1, (int)($config['max_device_csv_import_bytes'] ?? 2097152));

        if ($fileSize <= 0 || $fileSize > $maxBytes) {
            throw new ApiException('CSVファイルは2MB以下にしてください', 400);
        }

        $originalName = (new FloorPlanService($this->db))->sanitizeOriginalFilename(
            (string)($upload['name'] ?? 'devices.csv')
        );

        if (strtolower(pathinfo($originalName, PATHINFO_EXTENSION)) !== 'csv') {
            throw new ApiException('拡張子.csvのファイルを選択してください', 400);
        }

        $raw = file_get_contents($temporaryPath);

        if ($raw === false || !$this->isValidUtf8Text($this->removeUtf8Bom($raw))) {
            throw new ApiException('CSVはUTF-8形式で保存してください', 400);
        }

        $maxRows = max(1, (int)($config['max_device_csv_import_rows'] ?? 5000));
        $parsed = $this->parseAndValidateDevicesCsvImport($temporaryPath, $maxRows);

        $directory = $this->prepareDeviceCsvImportDirectory($config);
        $ttlSeconds = max(60, (int)($config['device_csv_import_ttl_seconds'] ?? 600));

        $this->cleanupExpiredDeviceCsvImports($directory, $ttlSeconds);

        $expiresAt = time() + $ttlSeconds;
        $userId = (string)currentUserId();

        $payload = [
            'user_id' => $userId,
            'username' => currentUsername(),
            'revision' => $requestedRevision,
            'expires_at' => $expiresAt,
            'original_name' => $originalName,
            'file_size' => $fileSize,
            'file_hash' => hash_file('sha256', $temporaryPath),
            'summary' => $parsed['summary'],
            'rows' => $parsed['rows'],
        ];

        /*
         * トークン生成後に署名を含めるため、
         * 先に仮トークンを生成して自前保存する。
         */
        $token = bin2hex(random_bytes(32));
        $payload['signature'] = $this->createDeviceCsvImportSignature(
            $token,
            $userId,
            $requestedRevision,
            $expiresAt
        );

        $path = $directory . DIRECTORY_SEPARATOR . $token . '.json';
        $json = json_encode(
            $payload,
            JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR
        );

        if (file_put_contents($path, $json, LOCK_EX) === false) {
            throw new ApiException('CSV取込プレビューを保存できません', 500);
        }

        @chmod($path, 0600);

        return [
            'ok' => true,
            'import_token' => $token,
            'revision' => $requestedRevision,
            'expires_at' => date(DATE_ATOM, $expiresAt),
            'file' => [
                'name' => $originalName,
                'size' => $fileSize,
            ],
            'summary' => $parsed['summary'],
            'rows' => array_map(
                static function (array $row): array {
                    unset($row['data']);
                    return $row;
                },
                $parsed['rows']
            ),
            'can_commit' => $parsed['summary']['error'] === 0 &&
                ($parsed['summary']['insert'] + $parsed['summary']['update']) > 0,
        ];
    }

    /**
     * CSV取込の確定処理
     */
    public function commitImport(string $token, int $requestedRevision, array $config): array
    {
        $directory = $this->prepareDeviceCsvImportDirectory($config);
        $payload = $this->loadDeviceCsvImportPreview($directory, $token);

        $path = (string)$payload['_path'];
        unset($payload['_path']);

        $userId = (string)currentUserId();
        $payloadUserId = (string)($payload['user_id'] ?? '');
        $payloadRevision = (int)($payload['revision'] ?? 0);
        $expiresAt = (int)($payload['expires_at'] ?? 0);
        $signature = (string)($payload['signature'] ?? '');

        $expectedSignature = $this->createDeviceCsvImportSignature(
            $token,
            $payloadUserId,
            $payloadRevision,
            $expiresAt
        );

        if ($payloadUserId !== $userId || !hash_equals($expectedSignature, $signature)) {
            throw new ApiException('CSV取込プレビューを利用できません', 403);
        }

        if ($expiresAt < time()) {
            @unlink($path);
            throw new ApiException('CSV取込プレビューの有効期限が切れました。再度検証してください', 410);
        }

        if ($requestedRevision <= 0 || $requestedRevision !== $payloadRevision) {
            throw new ApiException('CSV取込リビジョンが一致しません', 409);
        }

        $this->appMetaRepo->requireMatchingDataRevision($requestedRevision);

        $summary = is_array($payload['summary'] ?? null) ? $payload['summary'] : [];
        $rows = is_array($payload['rows'] ?? null) ? $payload['rows'] : [];

        if ((int)($summary['error'] ?? 1) !== 0) {
            throw new ApiException('エラーがあるCSVは確定できません', 400);
        }

        $insertCount = (int)($summary['insert'] ?? 0);
        $updateCount = (int)($summary['update'] ?? 0);

        if ($insertCount + $updateCount <= 0) {
            throw new ApiException('反映する変更がありません', 400);
        }


        $newRevision = 0;
        $newMonitorRevision = $this->appMetaRepo->getMonitorRevision();
        $changedIpCount = 0;
        $savedAt = date(DATE_ATOM);

        $this->db->beginTransaction();

        try {
            $newRevision = $this->appMetaRepo->claimDataRevision($requestedRevision);

            $insertStmt = $this->db->prepare("
                INSERT INTO devices (
                    id,
                    name,
                    type,
                    ip,
                    x,
                    y,
                    facility,
                    floor,
                    location,
                    manufacturer,
                    model,
                    asset_number,
                    serial_number,
                    mac_address,
                    memo,
                    management_scheme,
                    management_port,
                    department,
                    maintenance_vendor,
                    install_date,
                    maintenance_expiry
                ) VALUES (
                    :id,
                    :name,
                    :type,
                    :ip,
                    0,
                    0,
                    :facility,
                    :floor,
                    :location,
                    :manufacturer,
                    :model,
                    :asset_number,
                    :serial_number,
                    :mac_address,
                    :memo,
                    :management_scheme,
                    :management_port,
                    :department,
                    :maintenance_vendor,
                    :install_date,
                    :maintenance_expiry
                )
            ");

            $updateStmt = $this->db->prepare("
                UPDATE devices
                SET
                    name = :name,
                    type = :type,
                    ip = :ip,
                    facility = :facility,
                    floor = :floor,
                    location = :location,
                    manufacturer = :manufacturer,
                    model = :model,
                    asset_number = :asset_number,
                    serial_number = :serial_number,
                    mac_address = :mac_address,
                    memo = :memo,
                    management_scheme = :management_scheme,
                    management_port = :management_port,
                    department = :department,
                    maintenance_vendor = :maintenance_vendor,
                    install_date = :install_date,
                    maintenance_expiry = :maintenance_expiry
                WHERE id = :id
            ");

            $oldIpStmt = $this->db->prepare("
                SELECT ip
                FROM devices
                WHERE id = :id
            ");

            $resetMonitorStmt = $this->db->prepare("
                UPDATE device_monitor_status
                SET
                    status = 'unknown',
                    last_checked_at = NULL,
                    last_response_ms = NULL,
                    last_error = NULL
                WHERE device_id = :id
            ");

            $createMonitorStmt = $this->db->prepare("
                INSERT OR IGNORE INTO device_monitor_status (
                    device_id,
                    status,
                    last_checked_at,
                    last_response_ms,
                    last_error
                ) VALUES (
                    :id,
                    'unknown',
                    NULL,
                    NULL,
                    NULL
                )
            ");

            $assignedIds = [];

            foreach ($rows as $row) {
                if (!is_array($row) || !is_array($row['data'] ?? null)) {
                    throw new ApiException('CSV取込プレビューの行データが不正です', 400);
                }

                $operation = (string)($row['operation'] ?? '');

                if ($operation === 'unchanged') {
                    continue;
                }

                if (!in_array($operation, ['insert', 'update'], true)) {
                    throw new ApiException('CSV取込プレビューの操作が不正です', 400);
                }

                $record = $row['data'];
                $id = $operation === 'insert'
                    ? ResourceId::allocate($this->db, 'devices')
                    : ResourceId::parse($row['id'] ?? null, 'id');

                $params = [
                    ':id' => $id,
                    ':name' => (string)$record['name'],
                    ':type' => (string)$record['type'],
                    ':ip' => (string)$record['ip'],
                    ':facility' => (string)$record['facility'],
                    ':floor' => (string)$record['floor'],
                    ':location' => (string)$record['location'],
                    ':manufacturer' => (string)$record['manufacturer'],
                    ':model' => (string)$record['model'],
                    ':asset_number' => (string)$record['asset_number'],
                    ':serial_number' => (string)$record['serial_number'],
                    ':mac_address' => (string)$record['mac_address'],
                    ':memo' => (string)$record['memo'],
                    ':management_scheme' => (string)($record['management_scheme'] ?? ''),
                    ':management_port' => (isset($record['management_port']) && trim((string)$record['management_port']) !== '')
                        ? (int)$record['management_port']
                        : null,
                    ':department' => (string)($record['department'] ?? ''),
                    ':maintenance_vendor' => (string)($record['maintenance_vendor'] ?? ''),
                    ':install_date' => (string)($record['install_date'] ?? ''),
                    ':maintenance_expiry' => (string)($record['maintenance_expiry'] ?? ''),
                ];

                if ($operation === 'insert') {
                    $insertStmt->execute($params);
                    $createMonitorStmt->execute([':id' => $id]);

                    $assignedIds[] = [
                        'line' => (int)$row['line'],
                        'id' => $id,
                    ];
                    continue;
                }

                $oldIpStmt->execute([':id' => $id]);
                $oldIp = $oldIpStmt->fetchColumn();

                if ($oldIp === false) {
                    throw new ApiException("更新対象の機器ID {$id}が見つかりません", 409);
                }

                $updateStmt->execute($params);

                if ((string)$oldIp !== (string)$record['ip']) {
                    $resetMonitorStmt->execute([':id' => $id]);
                    $changedIpCount++;
                }
            }

            if ($changedIpCount > 0) {
                $newMonitorRevision = $this->appMetaRepo->incrementMonitorRevision();
            }

            $this->appMetaRepo->set('last_saved_at', $savedAt);

            $this->db->commit();
        } catch (Throwable $e) {
            if ($this->db->inTransaction()) {
                $this->db->rollBack();
            }

            if ($e instanceof PDOException && Database::isBusy($e)) {
                throw new ApiException(
                    '現在、別の更新処理が実行されています。少し待ってから再度取込してください',
                    409
                );
            }

            throw $e;
        }

        @unlink($path);

        return [
            'ok' => true,
            'message' => '機器台帳CSVを取り込みました',
            'revision' => $newRevision,
            'saved_at' => $savedAt,
            'monitor_revision' => $newMonitorRevision,
            'summary' => [
                'insert' => $insertCount,
                'update' => $updateCount,
                'unchanged' => (int)($summary['unchanged'] ?? 0),
            ],
            'assigned_ids' => $assignedIds,
        ];
    }
}
