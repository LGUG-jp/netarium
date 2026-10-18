<?php
declare(strict_types=1);

namespace Netarium\Services\Backup;

use DateTimeImmutable;
use PDO;
use PDOException;
use RuntimeException;
use Throwable;
use ZipArchive;
use Netarium\Core\ApiException;
use Netarium\Core\Database;
use Netarium\Core\Request;
use Netarium\Core\ResourceId;
use Netarium\Repositories\AppMetaRepository;
use Netarium\Services\FloorPlan\FloorPlanService;
use Netarium\Services\Storage\CapacityService;
use Netarium\Services\Topology\DeviceFields;
use Netarium\Services\Topology\LinkRoute;
use Netarium\Services\Topology\CanvasNote;
use Netarium\Services\Topology\LinkSystemService;


class BackupService
{
    private PDO $db;
    private AppMetaRepository $appMetaRepo;

    public function __construct(PDO $db)
    {
        $this->db = $db;
        $this->appMetaRepo = new AppMetaRepository($db);
    }

    public function prepareBackupExportRoot(string $directory): string
    {
        if (!is_dir($directory)) {
            if (!@mkdir($directory, 0700, true) && !is_dir($directory)) {
                throw new ApiException('バックアップ一時保存先を作成できません', 500);
            }
        }

        if (!is_writable($directory)) {
            throw new ApiException('バックアップ一時保存先へ書き込めません', 500);
        }

        return $directory;
    }

    public function createBackupWorkDirectory(string $rootDirectory): string
    {
        $name = 'export-' . date('Ymd-His') . '-' . bin2hex(random_bytes(8));
        $directory = $rootDirectory . DIRECTORY_SEPARATOR . $name;

        if (!mkdir($directory, 0700, true)) {
            throw new ApiException('バックアップ作業領域を作成できません', 500);
        }

        return $directory;
    }

    public function removeDirectoryTree(string $directory): void
    {
        if ($directory === '' || !is_dir($directory)) {
            return;
        }

        $items = scandir($directory);

        if ($items === false) {
            error_log('[Backup Export] Failed to scan: ' . $directory);
            return;
        }

        foreach ($items as $item) {
            if ($item === '.' || $item === '..') {
                continue;
            }

            $path = $directory . DIRECTORY_SEPARATOR . $item;

            if (is_dir($path) && !is_link($path)) {
                $this->removeDirectoryTree($path);
            } else {
                if (!@unlink($path)) {
                    error_log('[Backup Export] Failed to delete file: ' . $path);
                }
            }
        }

        if (!@rmdir($directory)) {
            error_log('[Backup Export] Failed to delete directory: ' . $directory);
        }
    }

    public function writeBackupJsonFile(string $path, array $data): void
    {
        $json = json_encode(
            $data,
            JSON_UNESCAPED_UNICODE |
            JSON_UNESCAPED_SLASHES |
            JSON_PRETTY_PRINT |
            JSON_THROW_ON_ERROR
        );

        if (file_put_contents($path, $json, LOCK_EX) !== strlen($json)) {
            throw new RuntimeException('バックアップJSONを書き込めません');
        }
    }

    public function createBackupFileEntry(string $absolutePath, string $archivePath): array
    {
        $size = filesize($absolutePath);

        if ($size === false) {
            throw new RuntimeException('バックアップファイルのサイズを取得できません');
        }

        $hash = hash_file('sha256', $absolutePath);

        if ($hash === false) {
            throw new RuntimeException('バックアップファイルのハッシュを計算できません');
        }

        return [
            'path' => str_replace('\\', '/', $archivePath),
            'size' => $size,
            'sha256' => $hash,
        ];
    }

    private function getImageStorageUsage(array $config): array
    {
        $usage = $this->db->query("
            SELECT COUNT(*) AS files, COALESCE(SUM(MAX(0, file_size)), 0) AS bytes
            FROM (
                SELECT file_size FROM view_floor_plans
                UNION ALL
                SELECT file_size FROM device_images
            )
        ")->fetch(PDO::FETCH_ASSOC);

        return CapacityService::imageUsage(
            (int)$usage['files'],
            (int)$usage['bytes'],
            $config
        );
    }

    public function estimateBackupSource(array $config): array
    {
        $tables = $this->fetchBackupTables();
        $bytes = strlen(json_encode($this->dataDocument($tables), JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR));
        $reserve = CapacityService::BYTES_PER_MIB;
        CapacityService::assertBackupUsage(2, $bytes + $reserve, 0, $config);
        return [
            'data_bytes' => $bytes,
            'file_count' => 2,
            'uncompressed_bytes' => $bytes + $reserve,
            'work_bytes' => $bytes + $reserve,
            'tables' => $tables,
        ];
    }

    private function dataDocument(array $tables): array
    {
        return [
            'format' => 'netarium-config-data',
            'version' => 1,
            'generated_at' => (new DateTimeImmutable())->format(DATE_ATOM),
            'tables' => $tables,
        ];
    }


    public function fetchBackupTables(): array
    {
        $views = $this->db->query("
            SELECT
                id,
                resource_revision,
                name,
                facility,
                floor,
                view_type,
                sort_order,
                memo
            FROM views
            ORDER BY sort_order, id
        ")->fetchAll();

        $devices = $this->db->query("
            SELECT
                id,
                resource_revision,
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
            FROM devices
            ORDER BY id
        ")->fetchAll();

        $monitorStatuses = $this->db->query("
            SELECT
                device_id,
                status,
                last_checked_at,
                last_response_ms,
                last_error
            FROM device_monitor_status
            ORDER BY device_id
        ")->fetchAll();

        $placements = $this->db->query("
            SELECT
                id,
                device_id,
                view_id,
                x,
                y
            FROM device_placements
            ORDER BY id
        ")->fetchAll();

        $links = $this->db->query("
            SELECT
                id,
                view_id,
                from_id,
                to_id,
                system_id,
                label,
                from_port,
                to_port,
                vlan,
                memo,
                route_mode,
                manual_route
            FROM links
            ORDER BY id
        ")->fetchAll();

        foreach ($links as &$link) {
            $link['manual_route'] = json_decode((string)$link['manual_route'], true, 512, JSON_THROW_ON_ERROR);
            $link = array_merge($link, LinkRoute::normalize($link));
        }
        unset($link);

        $floorPlans = $this->db->query("
            SELECT
                view_id,
                stored_name,
                original_name,
                mime_type,
                file_size,
                sha256,
                image_width,
                image_height,
                x,
                y,
                scale,
                opacity,
                is_visible,
                revision,
                created_at,
                updated_at
            FROM view_floor_plans
            ORDER BY view_id
        ")->fetchAll();

        $deviceImages = $this->db->query("
            SELECT
                id,
                device_id,
                stored_name,
                mime_type,
                file_size,
                sha256,
                image_width,
                image_height,
                caption,
                sort_order,
                created_at,
                updated_at
            FROM device_images
            ORDER BY device_id, sort_order, id
        ")->fetchAll();

        $metaStmt = $this->db->query("
            SELECT
                meta_key,
                meta_value
            FROM app_meta
            WHERE meta_key IN (
                'data_revision',
                'monitor_revision',
                'last_saved_at',
                'last_monitored_at'
            )
            ORDER BY meta_key
        ");

        $appMeta = $metaStmt->fetchAll();

        return [
            'views' => $views,
            'devices' => $devices,
            'device_monitor_status' => $monitorStatuses,
            'device_placements' => $placements,
            'links' => $links,
            'link_systems' => $this->db->query('SELECT id, name, color_key, resource_revision FROM link_systems ORDER BY id')->fetchAll(PDO::FETCH_ASSOC),
            'canvas_notes' => $this->db->query('SELECT ' . implode(', ', CanvasNote::COLUMNS) . ' FROM canvas_notes ORDER BY id')->fetchAll(PDO::FETCH_ASSOC),
            'view_floor_plans' => $floorPlans,
            'device_images' => $deviceImages,
            'app_meta' => $appMeta,
        ];
    }

    public function prepareWritableDirectory(string $directory, string $label): string
    {
        if ($directory === '') {
            throw new ApiException("{$label}が設定されていません", 500);
        }

        if (!is_dir($directory) && !@mkdir($directory, 0700, true) && !is_dir($directory)) {
            throw new ApiException("{$label}を作成できません", 500);
        }

        if (!is_writable($directory)) {
            throw new ApiException("{$label}へ書き込めません", 500);
        }

        return $directory;
    }

    public function buildBackupZipFile(
        array $config,
        string $workDirectory,
        string $zipPath
    ): array {
        if (!class_exists(ZipArchive::class)) {
            throw new ApiException('PHPのZipArchiveが利用できません', 500);
        }
        $limits = CapacityService::limits($config);
        $dataDirectory = $workDirectory . DIRECTORY_SEPARATOR . 'data';
        if (!mkdir($dataDirectory, 0700, true)) {
            throw new RuntimeException('構成情報の作業領域を作成できません');
        }
        $this->db->beginTransaction();
        try {
            $tables = $this->fetchBackupTables();
            if (count($tables['views']) > (int)($config['max_views'] ?? 100)) {
                throw new ApiException('ビュー数が登録上限を超えています', 400);
            }
            // 移行前の画像だけ初回にdigestを補完する。登録済みdigestのある実体は読み込まない。
            foreach (['view_floor_plans' => 'floor_plan_directory', 'device_images' => 'device_image_directory'] as $table => $directoryKey) {
                foreach ($tables[$table] as &$row) {
                    if ($row['sha256'] !== '') {
                        continue;
                    }
                    $path = $config[$directoryKey] . DIRECTORY_SEPARATOR . $row['stored_name'];
                    if ($this->matchesImageAttributes($row, $path)) {
                        $sha = hash_file('sha256', $path);
                        if ($sha !== false) {
                            $row['sha256'] = $sha;
                            $key = $table === 'view_floor_plans' ? 'view_id' : 'id';
                            $stmt = $this->db->prepare("UPDATE {$table} SET sha256 = :sha WHERE {$key} = :id AND sha256 = ''");
                            $stmt->execute([':sha' => $sha, ':id' => $row[$key]]);
                        }
                    }
                }
                unset($row);
            }
            $dataPath = $dataDirectory . DIRECTORY_SEPARATOR . 'netarium.json';
            $this->writeBackupJsonFile($dataPath, $this->dataDocument($tables));
            $this->db->commit();
        } catch (Throwable $e) {
            if ($this->db->inTransaction()) {
                $this->db->rollBack();
            }
            throw $e;
        }
        $entry = $this->createBackupFileEntry($dataPath, 'data/netarium.json');
        $manifest = [
            'format' => 'netarium-config',
            'format_version' => 1,
            'application_version' => (string)$config['application_version'],
            'schema_version' => APP_DATABASE_SCHEMA_VERSION,
            'created_at' => (new DateTimeImmutable())->format(DATE_ATOM),
            'summary' => [
                'views' => count($tables['views']),
                'devices' => count($tables['devices']),
                'placements' => count($tables['device_placements']),
                'links' => count($tables['links']),
                'link_systems' => count($tables['link_systems']),
                'canvas_notes' => count($tables['canvas_notes']),
                'floor_plans' => count($tables['view_floor_plans']),
                'device_images' => count($tables['device_images']),
                'files' => 1,
                'total_bytes' => $entry['size'],
            ],
            'files' => [$entry],
        ];
        $manifestPath = $workDirectory . DIRECTORY_SEPARATOR . 'manifest.json';
        $this->writeBackupJsonFile($manifestPath, $manifest);
        $bytes = $entry['size'] + (int)filesize($manifestPath);
        CapacityService::assertBackupUsage(2, $bytes, 0, $config);
        CapacityService::requireFreeSpace($workDirectory, $limits['backup']['max_zip_bytes'] + $limits['workspace_reserve_bytes'], '構成情報ZIP作業領域');
        $zip = new ZipArchive();
        if ($zip->open($zipPath, ZipArchive::CREATE | ZipArchive::EXCL) !== true) {
            throw new RuntimeException('構成情報ZIPを作成できません');
        }
        $added = $zip->addFile($manifestPath, 'manifest.json') && $zip->addFile($dataPath, 'data/netarium.json');
        $closed = $zip->close();
        if (!$added || !$closed) {
            throw new RuntimeException('構成情報ZIPの書込みに失敗しました');
        }
        $size = filesize($zipPath);
        $sha = hash_file('sha256', $zipPath);
        if ($size === false || $size <= 0 || $sha === false) {
            throw new RuntimeException('構成情報ZIPを確認できません');
        }
        CapacityService::assertBackupUsage(2, $bytes, $size, $config);
        return [
            'manifest' => $manifest,
            'zip_path' => $zipPath,
            'zip_size' => $size,
            'zip_sha256' => $sha,
            'capacity' => CapacityService::backupUsage(2, $bytes, $size, 0, 0, $config),
        ];
    }

    private function matchesImageAttributes(array $row, string $path): bool
    {
        clearstatcache(true, $path);
        if (!is_file($path) || is_link($path) || !is_readable($path) || @filesize($path) !== (int)$row['file_size']) {
            return false;
        }
        $info = @getimagesize($path);
        return is_array($info)
            && ($info['mime'] ?? '') === $row['mime_type']
            && (int)$info[0] === (int)$row['image_width']
            && (int)$info[1] === (int)$row['image_height'];
    }

    public function streamBackupZipFile(
        string $zipPath,
        string $downloadFilename,
        bool &$responseStarted,
        array $capacity = []
    ): void {
        if (!is_file($zipPath) || !is_readable($zipPath)) {
            throw new RuntimeException('ダウンロード対象のZIPが存在しません');
        }

        $size = filesize($zipPath);

        if ($size === false) {
            throw new RuntimeException('ダウンロード対象ZIPのサイズを取得できません');
        }

        while (ob_get_level() > 0) {
            if (!@ob_end_clean()) {
                break;
            }
        }

        header_remove('Content-Type');
        header('Content-Type: application/zip', true);
        header('Content-Disposition: attachment; filename="' . $downloadFilename . '"', true);
        header('Content-Length: ' . (string)$size, true);
        header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0', true);
        header('Pragma: no-cache', true);
        header('Expires: 0', true);
        header('X-Content-Type-Options: nosniff', true);
        if (($capacity['near_limit'] ?? false) === true) {
            header('X-Netarium-Capacity-Warning: 1', true);
        }


        $responseStarted = true;

        $stream = fopen($zipPath, 'rb');

        if ($stream === false) {
            throw new RuntimeException('ダウンロードZIPを開けません');
        }

        try {
            while (!feof($stream)) {
                $buffer = fread($stream, 1048576);

                if ($buffer === false) {
                    throw new RuntimeException('ZIPのストリーミングに失敗しました');
                }

                echo $buffer;
                flush();
                if (connection_aborted()) {
                    throw new RuntimeException('ダウンロード接続が中断されました');
                }
            }
        } finally {
            fclose($stream);
        }
    }

    public function exportBackupZip(array $config): void
    {
        $rootDirectory = $this->prepareBackupExportRoot((string)$config['backup_export_directory']);
        $workDirectory = '';
        $responseStarted = false;

        try {
            $workDirectory = $this->createBackupWorkDirectory($rootDirectory);
            $downloadFilename = 'netarium-config_' . date('Ymd_His') . '.zip';
            $zipPath = $workDirectory . DIRECTORY_SEPARATOR . $downloadFilename;

            $result = $this->buildBackupZipFile($config, $workDirectory, $zipPath);
            $this->streamBackupZipFile(
                $zipPath,
                $downloadFilename,
                $responseStarted,
                $result['capacity'] ?? []
            );
        } catch (Throwable $e) {
            error_log('[Backup Export] ' . get_class($e) . ': ' . $e->getMessage());
            throw $e;
        } finally {
            if ($workDirectory !== '') {
                $this->removeDirectoryTree($workDirectory);
            }
        }
    }

    public function validateBackupArchivePath(string $path): void
    {
        if (
            $path === '' ||
            str_contains($path, "\0") ||
            str_contains($path, '\\') ||
            str_starts_with($path, '/') ||
            preg_match('/\A[A-Za-z]:/', $path) === 1 ||
            str_contains($path, '../') ||
            str_contains($path, '/./') ||
            str_starts_with($path, './')
        ) {
            throw new ApiException('ZIP内に不正なパスがあります', 400);
        }

        $allowed =
            $path === 'manifest.json' ||
            $path === 'data/netarium.json';

        if (!$allowed) {
            throw new ApiException('ZIP内に許可されていないファイルがあります: ' . $path, 400);
        }
    }

    public function readBackupJsonFile(string $path, string $label): array
    {
        $json = file_get_contents($path);

        if ($json === false) {
            throw new ApiException("{$label}を読み取れません", 500);
        }

        try {
            $data = Request::decodeJson($json);
        } catch (Throwable $e) {
            throw new ApiException("{$label}のJSONが不正です", 400);
        }

        if (!is_array($data)) {
            throw new ApiException("{$label}はオブジェクト形式である必要があります", 400);
        }

        return $data;
    }

    public function inspectBackupZip(string $zipPath, array $config): array
    {
        if (!class_exists(ZipArchive::class)) {
            throw new ApiException('PHPのZipArchiveが利用できません', 500);
        }

        $limits = CapacityService::limits($config);
        $zipSize = @filesize($zipPath);

        if ($zipSize === false || $zipSize <= 0) {
            throw new ApiException('バックアップZIPのサイズを確認できません', 400);
        }

        if ($zipSize > $limits['backup']['max_zip_bytes']) {
            throw new ApiException('バックアップZIPの容量が上限を超えています', 400);
        }

        $zip = new ZipArchive();
        $result = $zip->open($zipPath, ZipArchive::RDONLY);

        if ($result !== true) {
            throw new ApiException('バックアップZIPを開けません', 400);
        }

        if ($zip->numFiles > $limits['backup']['max_files'] * 2) {
            $zip->close();
            throw new ApiException('ZIP内のエントリ数が上限を超えています', 400);
        }

        $seen = [];
        $fileCount = 0;
        $totalBytes = 0;
        $hasManifest = false;
        $hasData = false;

        try {
            for ($index = 0; $index < $zip->numFiles; $index++) {
                $stat = $zip->statIndex($index, ZipArchive::FL_UNCHANGED);

                if (!is_array($stat)) {
                    throw new ApiException('ZIP内のファイル情報を取得できません', 400);
                }

                $name = (string)($stat['name'] ?? '');

                if (!in_array($name, ['manifest.json', 'data/netarium.json'], true)) {
                    throw new ApiException('構成情報ZIPには指定のJSON 2ファイルだけを格納してください', 400);
                }

                $this->validateBackupArchivePath($name);
                $key = strtolower($name);

                if (isset($seen[$key])) {
                    throw new ApiException('ZIP内のファイル名が重複しています', 400);
                }

                $seen[$key] = true;
                $fileCount++;
                $size = (int)($stat['size'] ?? -1);

                if ($size < 0 || $size > $limits['backup']['max_entry_bytes']) {
                    throw new ApiException('ZIP内ファイルの容量が上限を超えています: ' . $name, 400);
                }


                $totalBytes += $size;

                if ($fileCount > $limits['backup']['max_files']) {
                    throw new ApiException('ZIP内のファイル数が上限外です', 400);
                }

                if ($totalBytes > $limits['backup']['max_uncompressed_bytes']) {
                    throw new ApiException('ZIP展開後の総容量が上限を超えています', 400);
                }

                $hasManifest = $hasManifest || $name === 'manifest.json';
                $hasData = $hasData || $name === 'data/netarium.json';
            }
        } finally {
            $zip->close();
        }

        if (
            $fileCount < 2 ||
            !$hasManifest ||
            !$hasData
        ) {
            throw new ApiException('必須ファイル（manifest.json, data/netarium.json）が不足しています', 400);
        }


        return [
            'files' => $fileCount,
            'uncompressed_bytes' => $totalBytes,
            'zip_bytes' => (int)$zipSize,
            'image_files' => 0,
            'image_bytes' => 0,
        ];
    }

    public function extractValidatedBackupZip(string $zipPath, string $destination, array $config): array
    {
        $archiveSummary = $this->inspectBackupZip($zipPath, $config);
        $limits = CapacityService::limits($config);
        $zip = new ZipArchive();
        $result = $zip->open($zipPath, ZipArchive::RDONLY);

        if ($result !== true) {
            throw new ApiException('バックアップZIPを開けません', 400);
        }

        if ($zip->numFiles > $limits['backup']['max_files'] * 2) {
            $zip->close();
            throw new ApiException('ZIP内のエントリ数が上限を超えています', 400);
        }

        $seen = [];
        $totalBytes = 0;
        $extracted = [];

        try {
            for ($index = 0; $index < $zip->numFiles; $index++) {
                $stat = $zip->statIndex($index, ZipArchive::FL_UNCHANGED);

                if (!is_array($stat)) {
                    throw new ApiException('ZIP内のファイル情報を取得できません', 400);
                }

                $name = (string)($stat['name'] ?? '');

                if (str_ends_with($name, '/')) {
                    continue;
                }

                $this->validateBackupArchivePath($name);
                $key = strtolower($name);

                if (isset($seen[$key])) {
                    throw new ApiException('ZIP内のファイル名が重複しています', 400);
                }

                $seen[$key] = true;
                $size = (int)($stat['size'] ?? -1);

                if ($size < 0 || $size > $limits['backup']['max_entry_bytes']) {
                    throw new ApiException('ZIP内ファイルの容量が上限を超えています: ' . $name, 400);
                }


                $totalBytes += $size;

                if (
                    $totalBytes > $limits['backup']['max_uncompressed_bytes'] ||
                    count($extracted) >= $limits['backup']['max_files']
                ) {
                    throw new ApiException('ZIP展開後の容量またはファイル数が上限を超えています', 400);
                }

                $source = $zip->getStream($name);

                if ($source === false) {
                    throw new ApiException('ZIP内ファイルを読み取れません: ' . $name, 400);
                }

                $destinationPath = $destination . DIRECTORY_SEPARATOR . str_replace('/', DIRECTORY_SEPARATOR, $name);
                $parent = dirname($destinationPath);

                if (!is_dir($parent) && !mkdir($parent, 0700, true)) {
                    fclose($source);
                    throw new RuntimeException('ZIP展開先を作成できません');
                }

                $target = fopen($destinationPath, 'xb');

                if ($target === false) {
                    fclose($source);
                    throw new RuntimeException('ZIP内ファイルを保存できません');
                }

                $hashContext = hash_init('sha256');
                $written = 0;

                while (!feof($source)) {
                    $chunk = fread($source, 1048576);

                    if ($chunk === false) {
                        fclose($source);
                        fclose($target);
                        throw new RuntimeException('ZIP内ファイルの展開に失敗しました');
                    }

                    $written += strlen($chunk);

                    if ($written > $size) {
                        fclose($source);
                        fclose($target);
                        throw new ApiException('ZIP内ファイルが宣言サイズを超過しました', 400);
                    }

                    hash_update($hashContext, $chunk);
                    if (fwrite($target, $chunk) === false) {
                        fclose($source);
                        fclose($target);
                        throw new RuntimeException('ZIP内ファイルを書き込めません');
                    }
                }

                fclose($source);
                fclose($target);

                if ($written !== $size) {
                    throw new ApiException('展開後サイズが一致しません: ' . $name, 400);
                }

                $extracted[$name] = [
                    'path' => $name,
                    'absolute_path' => $destinationPath,
                    'size' => $size,
                    'sha256' => hash_final($hashContext),
                ];
            }
        } finally {
            $zip->close();
        }

        if (
            count($extracted) !== $archiveSummary['files'] ||
            $totalBytes !== $archiveSummary['uncompressed_bytes']
        ) {
            throw new ApiException('ZIP検証結果が一致しません', 400);
        }

        return $extracted;
    }

    public function validateBackupManifest(array $manifest, array $extracted, string $expectedVersion): void
    {
        $format = (string)($manifest['format'] ?? '');

        if ($format !== 'netarium-config' || ($manifest['format_version'] ?? null) !== 1) {
            throw new ApiException('netarium-config形式1のみ復元できます。旧画像同梱ZIP（形式2〜7）は非対応です', 400);
        }
        if (($manifest['schema_version'] ?? null) !== APP_DATABASE_SCHEMA_VERSION
            || ($manifest['application_version'] ?? null) !== $expectedVersion) {
            throw new ApiException('構成情報ZIPのスキーマ版またはアプリ版が一致しません', 400);
        }

        $files = $manifest['files'] ?? null;

        if (!is_array($files)) {
            throw new ApiException('マニフェストのファイル一覧が不正です', 400);
        }

        $manifestEntries = [];

        foreach ($files as $file) {
            if (!is_array($file)) {
                throw new ApiException('マニフェストファイル行が不正です', 400);
            }

            $path = (string)($file['path'] ?? '');
            $size = (int)($file['size'] ?? -1);
            $sha = (string)($file['sha256'] ?? '');

            if ($path === '' || $size < 0 || preg_match('/\A[a-f0-9]{64}\z/', $sha) !== 1) {
                throw new ApiException('マニフェストファイル属性が不正です', 400);
            }

            if (isset($manifestEntries[$path])) {
                throw new ApiException('マニフェスト内でファイルパスが重複しています', 400);
            }

            if (!isset($extracted[$path])) {
                throw new ApiException('マニフェストに記載されたファイルがZIP内に存在しません: ' . $path, 400);
            }

            $actual = $extracted[$path];

            if ($actual['size'] !== $size || !hash_equals($sha, (string)$actual['sha256'])) {
                throw new ApiException('バックアップファイルの整合性検証に失敗しました: ' . $path, 400);
            }

            $manifestEntries[$path] = true;
        }

        if (!isset($manifestEntries['data/netarium.json'])) {
            throw new ApiException('マニフェストにdata/netarium.jsonがありません', 400);
        }

        foreach ($extracted as $extractedPath => $_) {
            if ($extractedPath === 'manifest.json') {
                continue;
            }

            if (!isset($manifestEntries[$extractedPath])) {
                throw new ApiException('マニフェストに未登録のファイルがあります: ' . $extractedPath, 400);
            }
        }
    }

    public function requireBackupTable(array $tables, string $tableName): array
    {
        $table = $tables[$tableName] ?? null;

        if (!is_array($table)) {
            throw new ApiException("データJSONにテーブル {$tableName} がありません", 400);
        }

        return $table;
    }

    public function requireJsonInteger($value, string $field, int $min = 1, ?int $max = null): int
    {
        if (is_string($value) && ctype_digit($value)) {
            $digits = ltrim($value, '0');
            $bound = (string)($max ?? PHP_INT_MAX);
            if (strlen($digits) > strlen($bound) ||
                (strlen($digits) === strlen($bound) && strcmp($digits, $bound) > 0)) {
                throw new ApiException("{$field}が許容範囲外です", 400);
            }
            $value = (int)$digits;
        }
        if (!is_int($value)) {
            throw new ApiException("{$field}は整数である必要があります", 400);
        }
        if ($value < $min || ($max !== null && $value > $max)) {
            throw new ApiException("{$field}が許容範囲外です", 400);
        }
        return $value;
    }

    public function requireJsonNumber($value, string $field): float
    {
        if (!is_numeric($value)) {
            throw new ApiException("{$field}は数値である必要があります", 400);
        }

        $val = (float)$value;

        if (is_nan($val) || is_infinite($val)) {
            throw new ApiException("{$field}の数値が不正です", 400);
        }

        return $val;
    }

    public function requireJsonString($value, string $field, int $maxLength, bool $allowEmpty = true): string
    {
        if (!is_string($value)) {
            throw new ApiException("{$field}は文字列である必要があります", 400);
        }

        $text = trim($value);

        if (!$allowEmpty && $text === '') {
            throw new ApiException("{$field}を入力してください", 400);
        }

        if (Request::normalizeLedgerText($text, $maxLength) !== $text) {
            throw new ApiException("{$field}は{$maxLength}文字以内で入力してください", 400);
        }

        return $text;
    }

    public function requireExactBackupKeys(array $row, array $expectedKeys, string $label): void
    {
        $keys = array_keys($row);
        sort($keys);
        $expected = $expectedKeys;
        sort($expected);

        if ($keys !== $expected) {
            throw new ApiException("{$label}の列構造が不正です", 400);
        }
    }

    public function requireNullableJsonString($value, string $field, int $maxLength): ?string
    {
        if ($value === null) {
            return null;
        }

        return $this->requireJsonString($value, $field, $maxLength, true);
    }

    public function requireNullableJsonInteger($value, string $field, ?int $min = null, ?int $max = null): ?int
    {
        if ($value === null) {
            return null;
        }

        $int = $this->requireJsonInteger($value, $field, $min ?? -2147483648, $max);

        return $int;
    }

    public function validateBackupTimestamp(?string $value, string $field, bool $nullable = false): ?string
    {
        if ($value === null || $value === '') {
            if ($nullable) {
                return null;
            }

            throw new ApiException("{$field}の日時が未設定です", 400);
        }

        try {
            new DateTimeImmutable($value);
        } catch (Throwable $e) {
            throw new ApiException("{$field}の日時形式が不正です", 400);
        }

        return $value;
    }

    public function validateBackupDataDocument(array $doc): array
    {
        if (($doc['format'] ?? '') !== 'netarium-config-data') {
            throw new ApiException('データJSONのフォーマット識別子が不正です', 400);
        }

        if (($doc['version'] ?? null) !== 1) {
            throw new ApiException('未対応のデータJSONバージョンです', 400);
        }

        $tables = $doc['tables'] ?? null;

        if (!is_array($tables)) {
            throw new ApiException('データJSONにテーブル群がありません', 400);
        }

        return $tables;
    }


    public function validateBackupViews(array $views, array $config = []): array
    {
        if (count($views) < 1) {
            throw new ApiException('ビューが1件も含まれていません', 400);
        }

        $maxViews = max(1, (int)($config['max_views'] ?? 100));

        if (count($views) > $maxViews) {
            throw new ApiException('ビュー数が登録上限を超えています', 400);
        }

        $expectedKeys = ['id', 'resource_revision', 'name', 'facility', 'floor', 'view_type', 'sort_order', 'memo'];
        $viewsById = [];

        foreach ($views as $view) {
            if (!is_array($view)) {
                throw new ApiException('viewsの行形式が不正です', 400);
            }

            $this->requireExactBackupKeys($view, $expectedKeys, 'views');

            $id = $this->requireJsonInteger($view['id'], 'views.id', 1);

            if (isset($viewsById[$id])) {
                throw new ApiException("views.id {$id} が重複しています", 400);
            }

            $name = $this->requireJsonString($view['name'], 'views.name', 100, false);
            $type = (string)$view['view_type'];

            if (!in_array($type, ['topology', 'floor'], true)) {
                throw new ApiException('views.view_typeが不正です', 400);
            }

            $viewsById[$id] = [
                'id' => $id,
                'resource_revision' => $this->requireJsonInteger($view['resource_revision'], 'views.resource_revision', 1),
                'name' => $name,
                'facility' => $this->requireJsonString($view['facility'] ?? '', 'views.facility', 100, true),
                'floor' => $this->requireJsonString($view['floor'] ?? '', 'views.floor', 50, true),
                'view_type' => $type,
                'sort_order' => $this->requireJsonInteger($view['sort_order'], 'views.sort_order', -10000, 10000),
                'memo' => $this->requireJsonString($view['memo'] ?? '', 'views.memo', 1000, true),
            ];
        }

        return $viewsById;
    }

    public function validateBackupDevices(array $devices): array
    {
        $expectedKeys = [
            'id', 'name', 'type', 'ip', 'x', 'y', 'facility', 'floor', 'location',
            'manufacturer', 'model', 'asset_number', 'serial_number', 'mac_address', 'memo',
            'management_scheme', 'management_port', 'department', 'maintenance_vendor', 'install_date', 'maintenance_expiry',
            'resource_revision',
        ];

        $devicesById = [];
        $allowedTypes = [
            'switch', 'l3_switch', 'router', 'firewall', 'ap', 'server', 'printer', 'other',
        ];

        foreach ($devices as $device) {
            if (!is_array($device)) {
                throw new ApiException('devicesの行形式が不正です', 400);
            }

            $this->requireExactBackupKeys($device, $expectedKeys, 'devices');

            $id = $this->requireJsonInteger($device['id'], 'devices.id', 1);

            if (isset($devicesById[$id])) {
                throw new ApiException("devices.id {$id} が重複しています", 400);
            }

            $type = (string)$device['type'];

            if (!in_array($type, $allowedTypes, true)) {
                throw new ApiException('devices.typeが不正です', 400);
            }

            $ip = $this->requireJsonString($device['ip'] ?? '', 'devices.ip', 50, true);

            if ($ip !== '' && !filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4)) {
                throw new ApiException('devices.ipの形式が不正です', 400);
            }

            $fields = DeviceFields::normalizeAndValidate($device, "devices[{$id}]: ");

            $devicesById[$id] = [
                'id' => $id,
                'resource_revision' => $this->requireJsonInteger($device['resource_revision'], 'devices.resource_revision', 1),
                'name' => $this->requireJsonString($device['name'], 'devices.name', 100, false),
                'type' => $type,
                'ip' => $ip,
                'x' => $this->requireJsonNumber($device['x'], 'devices.x'),
                'y' => $this->requireJsonNumber($device['y'], 'devices.y'),
                'facility' => $this->requireJsonString($device['facility'] ?? '', 'devices.facility', 100, true),
                'floor' => $this->requireJsonString($device['floor'] ?? '', 'devices.floor', 50, true),
                'location' => $this->requireJsonString($device['location'] ?? '', 'devices.location', 150, true),
                'manufacturer' => $this->requireJsonString($device['manufacturer'] ?? '', 'devices.manufacturer', 100, true),
                'model' => $this->requireJsonString($device['model'] ?? '', 'devices.model', 100, true),
                'asset_number' => $this->requireJsonString($device['asset_number'] ?? '', 'devices.asset_number', 100, true),
                'serial_number' => $this->requireJsonString($device['serial_number'] ?? '', 'devices.serial_number', 100, true),
                'mac_address' => $this->requireJsonString($device['mac_address'] ?? '', 'devices.mac_address', 50, true),
                'memo' => $this->requireJsonString($device['memo'] ?? '', 'devices.memo', 1000, true),
                'management_scheme' => $fields['management_scheme'],
                'management_port' => $fields['management_port'],
                'department' => $fields['department'],
                'maintenance_vendor' => $fields['maintenance_vendor'],
                'install_date' => $fields['install_date'],
                'maintenance_expiry' => $fields['maintenance_expiry'],
            ];
        }

        return $devicesById;
    }

    public function validateBackupDeviceImages(
        array $deviceImages,
        array $deviceIds,
        array $config = []
    ): array {
        $expectedKeys = [
            'id', 'device_id', 'stored_name', 'mime_type', 'file_size',
            'image_width', 'image_height', 'caption', 'sort_order',
            'created_at', 'updated_at', 'sha256',
        ];

        $result = [];
        $countsByDevice = [];
        $seenStoredNames = [];
        $maxPerDevice = (int)($config['max_device_images_per_device'] ?? 3);
        $maxCaptionLen = (int)($config['max_device_image_caption_length'] ?? 100);
        $maxDim = (int)($config['max_device_image_width'] ?? 4000);
        $maxPixels = (int)($config['max_device_image_pixels'] ?? 12000000);

        foreach ($deviceImages as $row) {
            if (!is_array($row)) {
                throw new ApiException('device_imagesの行形式が不正です', 400);
            }

            $this->requireExactBackupKeys($row, $expectedKeys, 'device_images');

            $id = $this->requireJsonInteger($row['id'], 'device_images.id', 1);
            $deviceId = $this->requireJsonInteger($row['device_id'], 'device_images.device_id', 1);

            if (!isset($deviceIds[$deviceId])) {
                throw new ApiException("device_images.device_id {$deviceId} の機器が存在しません", 400);
            }

            $countsByDevice[$deviceId] = ($countsByDevice[$deviceId] ?? 0) + 1;
            if ($countsByDevice[$deviceId] > $maxPerDevice) {
                throw new ApiException("機器ID {$deviceId} の画像が上限{$maxPerDevice}件を超えています", 400);
            }

            $storedName = (string)$row['stored_name'];
            if (preg_match('/\A[a-f0-9]{32}\.(?:png|jpg)\z/', $storedName) !== 1) {
                throw new ApiException('device_images.stored_nameが不正です: ' . $storedName, 400);
            }
            if (isset($seenStoredNames[$storedName])) {
                throw new ApiException('device_images.stored_nameが重複しています: ' . $storedName, 400);
            }
            $seenStoredNames[$storedName] = true;

            $mimeType = (string)$row['mime_type'];
            if (!in_array($mimeType, ['image/png', 'image/jpeg'], true)) {
                throw new ApiException('device_images.mime_typeが不正です', 400);
            }

            $fileSize = $this->requireJsonInteger($row['file_size'], 'device_images.file_size', 1);
            CapacityService::assertImageEntrySize($fileSize, $config, '機器画像ファイル');

            $imageWidth = $this->requireJsonInteger($row['image_width'], 'device_images.image_width', 1);
            $imageHeight = $this->requireJsonInteger($row['image_height'], 'device_images.image_height', 1);

            if ($imageWidth > $maxDim || $imageHeight > $maxDim || ($imageWidth * $imageHeight) > $maxPixels) {
                throw new ApiException('device_imagesの画像寸法が上限を超えています', 400);
            }

            $caption = $this->requireJsonString($row['caption'] ?? '', 'device_images.caption', $maxCaptionLen, true);
            $sortOrder = $this->requireJsonInteger($row['sort_order'], 'device_images.sort_order', 1, 3);
            $createdAt = $this->requireJsonString($row['created_at'], 'device_images.created_at', 50, false);
            $updatedAt = $this->requireJsonString($row['updated_at'], 'device_images.updated_at', 50, false);


            $result[] = [
                'id' => $id,
                'device_id' => $deviceId,
                'stored_name' => $storedName,
                'mime_type' => $mimeType,
                'file_size' => $fileSize,
                'sha256' => $this->validateImageDigest($row['sha256']),
                'image_width' => $imageWidth,
                'image_height' => $imageHeight,
                'caption' => $caption,
                'sort_order' => $sortOrder,
                'created_at' => $createdAt,
                'updated_at' => $updatedAt,
            ];
        }


        return $result;
    }

    public function validateBackupMonitorStatuses(array $statuses, array $deviceIds): array
    {
        $expectedKeys = ['device_id', 'status', 'last_checked_at', 'last_response_ms', 'last_error'];
        $result = [];
        $seenDeviceIds = [];

        foreach ($statuses as $row) {
            if (!is_array($row)) {
                throw new ApiException('device_monitor_statusの行形式が不正です', 400);
            }

            $this->requireExactBackupKeys($row, $expectedKeys, 'device_monitor_status');

            $deviceId = $this->requireJsonInteger($row['device_id'], 'device_monitor_status.device_id', 1);

            if (!isset($deviceIds[$deviceId])) {
                throw new ApiException('device_monitor_statusが存在しない機器を参照しています', 400);
            }

            if (isset($seenDeviceIds[$deviceId])) {
                throw new ApiException('device_monitor_status内で機器IDが重複しています', 400);
            }

            $seenDeviceIds[$deviceId] = true;
            $status = (string)$row['status'];

            if (!in_array($status, ['green', 'red', 'unknown'], true)) {
                throw new ApiException('device_monitor_status.statusが不正です', 400);
            }

            $result[] = [
                'device_id' => $deviceId,
                'status' => $status,
                'last_checked_at' => $this->validateBackupTimestamp($row['last_checked_at'] ?? null, 'last_checked_at', true),
                'last_response_ms' => $this->requireNullableJsonInteger($row['last_response_ms'] ?? null, 'last_response_ms', 0, 60000),
                'last_error' => $this->requireNullableJsonString($row['last_error'] ?? null, 'last_error', 1000),
            ];
        }

        return $result;
    }

    public function validateBackupPlacements(array $placements, array $deviceIds, array $viewsById): array
    {
        $expectedKeys = ['id', 'device_id', 'view_id', 'x', 'y'];
        $result = [];
        $seenPlacementIds = [];
        $seenPairs = [];

        foreach ($placements as $row) {
            if (!is_array($row)) {
                throw new ApiException('device_placementsの行形式が不正です', 400);
            }

            $this->requireExactBackupKeys($row, $expectedKeys, 'device_placements');

            $id = $this->requireJsonInteger($row['id'], 'device_placements.id', 1);

            if (isset($seenPlacementIds[$id])) {
                throw new ApiException('device_placements.idが重複しています', 400);
            }

            $seenPlacementIds[$id] = true;

            $deviceId = $this->requireJsonInteger($row['device_id'], 'device_placements.device_id', 1);
            $viewId = $this->requireJsonInteger($row['view_id'], 'device_placements.view_id', 1);

            if (!isset($deviceIds[$deviceId])) {
                throw new ApiException('device_placementsが存在しない機器を参照しています', 400);
            }

            if (!isset($viewsById[$viewId])) {
                throw new ApiException('device_placementsが存在しないビューを参照しています', 400);
            }

            $pairKey = $viewId . ':' . $deviceId;

            if (isset($seenPairs[$pairKey])) {
                throw new ApiException('同一ビュー内に同一機器の重複配置があります', 400);
            }

            $seenPairs[$pairKey] = true;

            $result[] = [
                'id' => $id,
                'device_id' => $deviceId,
                'view_id' => $viewId,
                'x' => $this->requireJsonNumber($row['x'], 'device_placements.x'),
                'y' => $this->requireJsonNumber($row['y'], 'device_placements.y'),
            ];
        }

        return $result;
    }

    public function validateBackupLinks(
        array $links,
        array $deviceIds,
        array $viewsById,
        array $placements,
        array $systems = []
    ): array {
        $expectedKeys = ['id', 'view_id', 'from_id', 'to_id', 'system_id', 'label', 'from_port', 'to_port', 'vlan', 'memo', 'route_mode', 'manual_route'];
        $result = [];
        $seenLinkIds = [];
        $placementPairs = [];

        foreach ($placements as $p) {
            $placementPairs[$p['view_id'] . ':' . $p['device_id']] = true;
        }

        foreach ($links as $row) {
            if (!is_array($row)) {
                throw new ApiException('linksの行形式が不正です', 400);
            }

            $this->requireExactBackupKeys($row, $expectedKeys, 'links');

            $id = $this->requireJsonInteger($row['id'], 'links.id', 1);

            if (isset($seenLinkIds[$id])) {
                throw new ApiException('links.idが重複しています', 400);
            }

            $seenLinkIds[$id] = true;

            $viewId = $this->requireJsonInteger($row['view_id'], 'links.view_id', 1);
            $fromId = $this->requireJsonInteger($row['from_id'], 'links.from_id', 1);
            $toId = $this->requireJsonInteger($row['to_id'], 'links.to_id', 1);

            if (!isset($viewsById[$viewId])) {
                throw new ApiException('linksが存在しないビューを参照しています', 400);
            }

            if (!isset($deviceIds[$fromId]) || !isset($deviceIds[$toId])) {
                throw new ApiException('linksが存在しない機器を参照しています', 400);
            }

            if ($fromId === $toId) {
                throw new ApiException('同一機器間の接続は登録できません', 400);
            }

            if (!isset($placementPairs[$viewId . ':' . $fromId]) || !isset($placementPairs[$viewId . ':' . $toId])) {
                throw new ApiException('linksの機器が対象ビューに配置されていません', 400);
            }
            $route = LinkRoute::normalize($row);

            $result[] = [
                'id' => $id,
                'view_id' => $viewId,
                'from_id' => $fromId,
                'to_id' => $toId,
                'system_id' => LinkSystemService::normalizeSystemId($row['system_id'], $systems),
                'label' => $this->requireJsonString($row['label'] ?? '', 'links.label', 100, true),
                'from_port' => $this->requireJsonString($row['from_port'] ?? '', 'links.from_port', 50, true),
                'to_port' => $this->requireJsonString($row['to_port'] ?? '', 'links.to_port', 50, true),
                'vlan' => $this->requireJsonString($row['vlan'] ?? '', 'links.vlan', 100, true),
                'memo' => $this->requireJsonString($row['memo'] ?? '', 'links.memo', 1000, true),
                'route_mode' => $route['route_mode'],
                'manual_route' => $route['manual_route'],
            ];
        }

        return $result;
    }

    public function validateBackupLinkSystems(array $rows): array
    {
        $systems = [];
        foreach ($rows as $row) {
            if (!is_array($row)) {
                throw new ApiException('link_systemsの行形式が不正です', 400);
            }
            $this->requireExactBackupKeys($row, ['id', 'name', 'color_key', 'resource_revision'], 'link_systems');
            $id = LinkSystemService::positiveInteger($row['id'], 'link_systems.id');
            if (isset($systems[$id])) {
                throw new ApiException('link_systems.idが重複しています', 400);
            }
            $systems[$id] = ['id' => $id] + LinkSystemService::normalizeFields($row) + [
                'resource_revision' => LinkSystemService::positiveInteger($row['resource_revision'], 'link_systems.resource_revision'),
            ];
        }
        return $systems;
    }

    public function validateBackupFloorPlans(
        array $floorPlans,
        array $viewsById,
        array $config = []
    ): array {
        $expectedKeys = [
            'view_id', 'stored_name', 'original_name', 'mime_type', 'file_size',
            'image_width', 'image_height', 'x', 'y', 'scale', 'opacity',
            'is_visible', 'revision', 'created_at', 'updated_at', 'sha256',
        ];
        $limits = CapacityService::limits($config);
        $maxWidth = max(1, (int)($config['max_floor_plan_width'] ?? 10000));
        $maxHeight = max(1, (int)($config['max_floor_plan_height'] ?? 10000));
        $maxPixels = max(1, (int)($config['max_floor_plan_pixels'] ?? 50000000));

        if (count($floorPlans) > $limits['floor_plans']['max_files']) {
            throw new ApiException(
                'フロア図面の登録数が上限を超えています',
                400
            );
        }

        $result = [];
        $seenViewIds = [];

        foreach ($floorPlans as $row) {
            if (!is_array($row)) {
                throw new ApiException('view_floor_plansの行形式が不正です', 400);
            }

            $this->requireExactBackupKeys($row, $expectedKeys, 'view_floor_plans');
            $viewId = $this->requireJsonInteger($row['view_id'], 'view_floor_plans.view_id', 1);

            if (!isset($viewsById[$viewId])) {
                throw new ApiException('view_floor_plansが存在しないビューを参照しています', 400);
            }

            if (($viewsById[$viewId]['view_type'] ?? '') !== 'floor') {
                throw new ApiException('floor以外のビューに図面情報が存在します', 400);
            }

            if (isset($seenViewIds[$viewId])) {
                throw new ApiException('view_floor_plans内でview_idが重複しています', 400);
            }

            $seenViewIds[$viewId] = true;
            $storedName = (string)$row['stored_name'];

            if (preg_match('/\A[a-f0-9]{32}\.(?:png|jpg)\z/', $storedName) !== 1) {
                throw new ApiException('view_floor_plans.stored_nameが不正です', 400);
            }

            $fileSize = $this->requireJsonInteger($row['file_size'], 'view_floor_plans.file_size', 1);

            CapacityService::assertImageEntrySize(
                (int)$fileSize,
                $config,
                '図面ファイル'
            );

            $mimeType = (string)$row['mime_type'];
            if (!in_array($mimeType, ['image/png', 'image/jpeg'], true)) {
                throw new ApiException('図面の画像形式が不正です', 400);
            }
            $declaredWidth = $this->requireJsonInteger(
                $row['image_width'],
                'view_floor_plans.image_width',
                1,
                $maxWidth
            );
            $declaredHeight = $this->requireJsonInteger(
                $row['image_height'],
                'view_floor_plans.image_height',
                1,
                $maxHeight
            );

            if ($declaredWidth * $declaredHeight > $maxPixels) {
                throw new ApiException('図面の総画素数が上限を超えています', 400);
            }
            $fpX     = $this->requireJsonNumber($row['x'], 'x');
            $fpY     = $this->requireJsonNumber($row['y'], 'y');
            $fpScale = $this->requireJsonNumber($row['scale'], 'scale');
            $fpOpacity = $this->requireJsonNumber($row['opacity'], 'opacity');
            $visibleValue = $row['is_visible'];

            if (!in_array($visibleValue, [0, 1, '0', '1', false, true], true)) {
                throw new ApiException('図面の表示設定が不正です', 400);
            }

            $isVisible = ($visibleValue === 1 || $visibleValue === '1' || $visibleValue === true) ? 1 : 0;

            if ($fpX < -100000 || $fpX > 100000 || $fpY < -100000 || $fpY > 100000) {
                throw new ApiException('図面位置は-100000から100000の範囲で指定してください', 400);
            }

            if ($fpScale < 0.05 || $fpScale > 2.0) {
                throw new ApiException('図面倍率は5%から200%の範囲で指定してください', 400);
            }

            if ($fpOpacity < 0.1 || $fpOpacity > 1.0) {
                throw new ApiException('図面の透明度は10%から100%の範囲で指定してください', 400);
            }

            $result[] = [
                'view_id' => $viewId,
                'stored_name' => $storedName,
                'original_name' => $this->requireJsonString($row['original_name'], 'original_name', 255, false),
                'mime_type' => $mimeType,
                'file_size' => (int)$fileSize,
                'image_width' => $declaredWidth,
                'image_height' => $declaredHeight,
                'x' => $fpX,
                'y' => $fpY,
                'scale' => $fpScale,
                'opacity' => $fpOpacity,
                'is_visible' => $isVisible,
                'revision' => $this->requireJsonInteger($row['revision'], 'revision', 1),
                'created_at' => $this->validateBackupTimestamp((string)$row['created_at'], 'created_at', false),
                'updated_at' => $this->validateBackupTimestamp((string)$row['updated_at'], 'updated_at', false),
                'sha256' => $this->validateImageDigest($row['sha256']),
            ];
        }


        return $result;
    }

    public function validateBackupAppMeta(array $appMeta): array
    {
        $expectedKeys = ['meta_key', 'meta_value'];
        $meta = [];

        foreach ($appMeta as $row) {
            if (!is_array($row)) {
                throw new ApiException('app_metaの行形式が不正です', 400);
            }

            $this->requireExactBackupKeys($row, $expectedKeys, 'app_meta');

            $key = (string)($row['meta_key'] ?? '');
            $val = (string)($row['meta_value'] ?? '');

            if (in_array($key, ['data_revision', 'monitor_revision', 'last_saved_at', 'last_monitored_at'], true)) {
                $meta[$key] = $val;
            }
        }

        return $meta;
    }

    public function validateCompleteBackupRestoreData(
        array $tables,
        array $config = []
    ): array
    {
        $this->requireExactBackupKeys($tables, ['views', 'devices', 'device_monitor_status',
            'device_placements', 'links', 'link_systems', 'canvas_notes', 'view_floor_plans', 'device_images', 'app_meta'], 'テーブル');
        $this->validateRestoreIds($tables);
        $notes = $this->requireBackupTable($tables, 'canvas_notes');
        foreach ($notes as $row) {
            if (!is_array($row)) {
                throw new ApiException('canvas_notesの行形式が不正です', 400);
            }
            $this->requireExactBackupKeys($row, CanvasNote::COLUMNS, 'canvas_notes');
        }
        $views = $this->requireBackupTable($tables, 'views');
        $devices = $this->requireBackupTable($tables, 'devices');
        $monitorStatuses = $this->requireBackupTable($tables, 'device_monitor_status');
        $placements = $this->requireBackupTable($tables, 'device_placements');
        $links = $this->requireBackupTable($tables, 'links');
        $floorPlans = $this->requireBackupTable($tables, 'view_floor_plans');
        $deviceImages = $this->requireBackupTable($tables, 'device_images');
        $appMeta = $this->requireBackupTable($tables, 'app_meta');
        $validatedSystems = $this->validateBackupLinkSystems($this->requireBackupTable($tables, 'link_systems'));

        $validatedViews = $this->validateBackupViews($views, $config);
        $validatedDevices = $this->validateBackupDevices($devices);
        $deviceIds = array_fill_keys(array_keys($validatedDevices), true);

        $validatedStatuses = $this->validateBackupMonitorStatuses($monitorStatuses, $deviceIds);
        $validatedPlacements = $this->validateBackupPlacements($placements, $deviceIds, $validatedViews);
        $validatedLinks = $this->validateBackupLinks($links, $deviceIds, $validatedViews, $validatedPlacements, $validatedSystems);
        $validatedNotes = CanvasNote::normalizeRows($notes, $validatedViews);
        $validatedFloorPlans = $this->validateBackupFloorPlans(
            $floorPlans,
            $validatedViews,
            $config
        );
        $validatedDeviceImages = $this->validateBackupDeviceImages(
            $deviceImages,
            $deviceIds,
            $config
        );
        $validatedMeta = $this->validateBackupAppMeta($appMeta);


        return [
            'views' => array_values($validatedViews),
            'devices' => array_values($validatedDevices),
            'device_monitor_status' => $validatedStatuses,
            'device_placements' => $validatedPlacements,
            'links' => $validatedLinks,
            'link_systems' => array_values($validatedSystems),
            'canvas_notes' => $validatedNotes,
            'view_floor_plans' => $validatedFloorPlans,
            'device_images' => $validatedDeviceImages,
            'app_meta' => $validatedMeta,
        ];
    }

    private function validateImageDigest(mixed $value): string
    {
        if (!is_string($value) || ($value !== '' && preg_match('/\A[a-f0-9]{64}\z/', $value) !== 1)) {
            throw new ApiException('画像のSHA-256が不正です', 400);
        }
        return $value;
    }

    private function resolveImageReferences(array &$data, array $config): array
    {
        $report = ['matched' => 0, 'missing' => 0, 'mismatched' => 0, 'unreferenced' => 0, 'items' => []];
        $fingerprints = [];
        foreach (['view_floor_plans' => 'floor_plan_directory', 'device_images' => 'device_image_directory'] as $table => $directoryKey) {
            $directory = (string)$config[$directoryKey];
            $matched = [];
            $referenced = [];
            foreach ($data[$table] as $row) {
                $name = $row['stored_name'];
                $path = $directory . DIRECTORY_SEPARATOR . $name;
                $reason = !is_file($path) ? 'missing' : 'mismatched';
                if ($row['sha256'] !== '' && $this->matchesImageAttributes($row, $path)) {
                    $hash = @hash_file('sha256', $path);
                    if (is_string($hash) && hash_equals($row['sha256'], $hash)) {
                        $reason = 'matched';
                        $matched[] = $row;
                        $referenced[$name] = true;
                    }
                }
                $report[$reason]++;
                if ($reason !== 'matched') {
                    $report['items'][] = [
                        'kind' => $table,
                        'id' => $row[$table === 'view_floor_plans' ? 'view_id' : 'device_id'],
                        'stored_name' => $name,
                        'reason' => $reason,
                    ];
                }
                $fingerprints[] = [$table, $name, $row['sha256'], $reason];
            }
            $data[$table] = $matched;
            // 認識できる保存名の実ファイルだけを数える。削除・移動はしない。
            foreach (is_dir($directory) ? (scandir($directory) ?: []) : [] as $name) {
                if (preg_match('/\A[a-f0-9]{32}\.(?:png|jpg)\z/', $name) === 1
                    && is_file($directory . DIRECTORY_SEPARATOR . $name) && !isset($referenced[$name])) {
                    $report['unreferenced']++;
                }
            }
        }
        $report['fingerprint'] = hash('sha256', json_encode($fingerprints, JSON_THROW_ON_ERROR));
        return $report;
    }

    private function validateRestoreIds(array $tables): void
    {
        foreach ([
            'views' => ['id'],
            'devices' => ['id'],
            'device_placements' => ['id', 'device_id', 'view_id'],
            'links' => ['id', 'view_id', 'from_id', 'to_id', 'system_id'],
            'link_systems' => ['id'],
            'canvas_notes' => ['id', 'view_id'],
            'device_images' => ['id', 'device_id'],
            'device_monitor_status' => ['device_id'],
            'view_floor_plans' => ['view_id'],
        ] as $table => $fields) {
            foreach ($this->requireBackupTable($tables, $table) as $row) {
                if (!is_array($row)) {
                    throw new ApiException("{$table}の行形式が不正です", 400);
                }
                foreach ($fields as $field) {
                    if ($table === 'links' && $field === 'system_id' && ($row[$field] ?? null) === null) {
                        continue;
                    }
                    ResourceId::parse($row[$field] ?? null, "{$table}.{$field}", ResourceId::MAX_RESTORE);
                }
            }
        }
    }

    private function validateRestoreIdState(): void
    {
        $sequences = $this->db->query('SELECT name, value FROM resource_sequences')->fetchAll(PDO::FETCH_KEY_PAIR);
        $imageSequence = $this->db->query("SELECT seq FROM sqlite_sequence WHERE name = 'device_images'")->fetchColumn();
        foreach ([
            'devices' => 'devices', 'views' => 'views', 'placements' => 'device_placements',
            'links' => 'links', 'canvas_notes' => 'canvas_notes', 'link_systems' => 'link_systems',
            'device_images' => 'device_images',
        ] as $name => $table) {
            $counter = $name === 'device_images' ? ($imageSequence === false ? 0 : $imageSequence) : ($sequences[$name] ?? null);
            $currentMax = $this->db->query("SELECT COALESCE(MAX(id), 0) FROM {$table}")->fetchColumn();
            if (!is_int($counter) || $counter < 0 || $counter > ResourceId::MAX_RESTORE ||
                !is_int($currentMax) || $currentMax > ResourceId::MAX_RESTORE) {
                throw new ApiException("{$table}のIDに後続採番の余地がありません。管理者に連絡してください", 400);
            }
        }
    }

    public function getBackupRestoreSigningKey(): string
    {
        return hash(
            'sha256',
            __FILE__ . '|backup-restore|' . currentUserId() . '|' . currentUsername()
        );
    }

    public function createBackupRestoreSignature(
        string $token,
        string $userId,
        string $zipHash,
        int $dataRevision,
        int $monitorRevision,
        int $sourceDataRevision,
        int $sourceMonitorRevision,
        int $expiresAt
    ): string {
        return hash_hmac(
            'sha256',
            implode('|', [
                $token,
                $userId,
                $zipHash,
                (string)$dataRevision,
                (string)$monitorRevision,
                (string)$sourceDataRevision,
                (string)$sourceMonitorRevision,
                (string)$expiresAt,
            ]),
            $this->getBackupRestoreSigningKey()
        );
    }

    public function previewBackupRestore(array $upload, array $config): array
    {
        $workspace = new RestoreWorkspace($config);
        try {
            $workspace->cleanupExpired();
            return $this->previewBackupRestoreLocked($upload, $config, $workspace);
        } finally {
            $workspace->release();
        }
    }

    private function previewBackupRestoreLocked(array $upload, array $config, RestoreWorkspace $workspace): array
    {
        $uploadError = (int)($upload['error'] ?? UPLOAD_ERR_NO_FILE);

        if ($uploadError !== UPLOAD_ERR_OK) {
            $message = match ($uploadError) {
                UPLOAD_ERR_INI_SIZE,
                UPLOAD_ERR_FORM_SIZE => 'バックアップZIPがアップロード上限を超えています',
                UPLOAD_ERR_PARTIAL => 'バックアップZIPのアップロードが完了しませんでした',
                UPLOAD_ERR_NO_FILE => '復元するバックアップZIPを選択してください',
                UPLOAD_ERR_NO_TMP_DIR => 'PHPのアップロード一時領域がありません',
                UPLOAD_ERR_CANT_WRITE => 'アップロードファイルを書き込めません',
                default => 'バックアップZIPをアップロードできませんでした',
            };

            throw new ApiException($message, 400);
        }

        $temporaryPath = (string)($upload['tmp_name'] ?? '');

        if ($temporaryPath === '' || !is_uploaded_file($temporaryPath)) {
            throw new ApiException('アップロードされたZIPを確認できません', 400);
        }

        $limits = CapacityService::limits($config);
        $size = (int)($upload['size'] ?? 0);
        $maxBytes = $limits['backup']['max_zip_bytes'];

        if ($size <= 0 || $size > $maxBytes) {
            throw new ApiException(
                'バックアップZIPは' . CapacityService::formatBytes($maxBytes) . '以下にしてください',
                400
            );
        }

        $originalName = (new FloorPlanService($this->db))->sanitizeOriginalFilename(
            (string)($upload['name'] ?? 'backup.zip')
        );

        if (strtolower(pathinfo($originalName, PATHINFO_EXTENSION)) !== 'zip') {
            throw new ApiException('拡張子.zipのファイルを選択してください', 400);
        }

        $root = $this->prepareWritableDirectory(
            (string)$config['backup_restore_directory'],
            'バックアップ復元一時保存先'
        );
        // 移動・展開より先に、既存保持量と今回のZIP／展開量を検査する。
        $archiveSummary = $this->inspectBackupZip($temporaryPath, $config);
        $userId = (string)currentUserId();
        $lease = ['user_id' => $userId, 'expires_at' => time() + max(60, (int)($config['backup_restore_ttl_seconds'] ?? 600))];
        $leaseJson = json_encode($lease, JSON_THROW_ON_ERROR);
        $workspace->assertCanAdd($userId, (int)$archiveSummary['zip_bytes'] + $archiveSummary['uncompressed_bytes'] + strlen($leaseJson));
        CapacityService::requireFreeSpace(
            $root,
            (int)$archiveSummary['zip_bytes'] + $archiveSummary['uncompressed_bytes'] + $limits['workspace_reserve_bytes'],
            'バックアップ復元作業領域'
        );

        $token = bin2hex(random_bytes(32));
        $workDirectory = $root . DIRECTORY_SEPARATOR . $token;

        if (!mkdir($workDirectory, 0700, true)) {
            throw new ApiException('バックアップ復元作業領域を作成できません', 500);
        }

        try {
            if (file_put_contents($workDirectory . DIRECTORY_SEPARATOR . 'workspace.json', $leaseJson, LOCK_EX) !== strlen($leaseJson)) {
                throw new RuntimeException('復元作業領域の期限情報を書き込めません');
            }
            $uploadedZip = $workDirectory . DIRECTORY_SEPARATOR . 'upload.zip';

            if (!move_uploaded_file($temporaryPath, $uploadedZip)) {
                throw new ApiException('バックアップZIPを一時保存できません', 500);
            }


            CapacityService::requireFreeSpace(
                $workDirectory,
                $archiveSummary['uncompressed_bytes'] +
                $limits['workspace_reserve_bytes'],
                'バックアップ復元作業領域'
            );

            $extractDirectory = $workDirectory . DIRECTORY_SEPARATOR . 'extracted';

            if (!mkdir($extractDirectory, 0700, true)) {
                throw new RuntimeException('ZIP展開領域を作成できません');
            }

            $extractedFiles = $this->extractValidatedBackupZip($uploadedZip, $extractDirectory, $config);

            $manifestData = $this->readBackupJsonFile(
                $extractedFiles['manifest.json']['absolute_path'],
                'manifest.json'
            );

            $this->validateBackupManifest(
                $manifestData,
                $extractedFiles,
                (string)($config['application_version'] ?? '1.0.0')
            );

            $rawDoc = $this->readBackupJsonFile(
                $extractedFiles['data/netarium.json']['absolute_path'],
                'data/netarium.json'
            );

            $tables = $this->validateBackupDataDocument($rawDoc);
            $validatedData = $this->validateCompleteBackupRestoreData(
                $tables,
                $config
            );
            $this->validateRestoreIdState();
            $imageResolution = $this->resolveImageReferences($validatedData, $config);
            $incomingImageBytes = 0;

            foreach ($validatedData['view_floor_plans'] as $floorPlan) {
                $incomingImageBytes += (int)$floorPlan['file_size'];
            }
            foreach ($validatedData['device_images'] as $deviceImage) {
                $incomingImageBytes += (int)$deviceImage['file_size'];
            }

            $incomingImageUsage = CapacityService::imageUsage(
                count($validatedData['view_floor_plans']) + count($validatedData['device_images']),
                $incomingImageBytes,
                $config
            );
            $currentImageUsage = $this->getImageStorageUsage($config);
            $backupUsage = CapacityService::backupUsage(
                $archiveSummary['files'],
                $archiveSummary['uncompressed_bytes'],
                (int)$archiveSummary['zip_bytes'],
                $incomingImageUsage['files'],
                $incomingImageUsage['bytes'],
                $config
            );
            $capacityWarnings = array_values(array_unique(array_merge(
                $incomingImageUsage['warnings'],
                $currentImageUsage['warnings'],
                $backupUsage['warnings']
            )));

            $zipHash = hash_file('sha256', $uploadedZip);

            if ($zipHash === false) {
                throw new RuntimeException('ZIPハッシュを計算できません');
            }

            $ttl = max(60, (int)($config['backup_restore_ttl_seconds'] ?? 600));
            $expiresAt = time() + $ttl;
            $userId = (string)currentUserId();
            $sourceDataRevision = $this->appMetaRepo->getDataRevision();
            $sourceMonitorRevision = $this->appMetaRepo->getMonitorRevision();
            $dataRevision = max(1, (int)($validatedData['app_meta']['data_revision'] ?? '1'));
            $monitorRevision = max(1, (int)($validatedData['app_meta']['monitor_revision'] ?? '1'));

            $signature = $this->createBackupRestoreSignature(
                $token,
                $userId,
                $zipHash,
                $dataRevision,
                $monitorRevision,
                $sourceDataRevision,
                $sourceMonitorRevision,
                $expiresAt
            );

            $capacity = [
                'incoming_images' => $incomingImageUsage,
                'current_images' => $currentImageUsage,
                'backup' => $backupUsage,
                'warnings' => $capacityWarnings,
                'near_limit' => $capacityWarnings !== [],
            ];
            $previewMeta = [
                'token' => $token,
                'user_id' => $userId,
                'username' => currentUsername(),
                'original_name' => $originalName,
                'zip_size' => (int)$archiveSummary['zip_bytes'],
                'zip_hash' => $zipHash,
                'data_revision' => $dataRevision,
                'monitor_revision' => $monitorRevision,
                'source_data_revision' => $sourceDataRevision,
                'source_monitor_revision' => $sourceMonitorRevision,
                'expires_at' => $expiresAt,
                'signature' => $signature,
                'manifest' => $manifestData,
                'archive_summary' => $archiveSummary,
                'capacity' => $capacity,
                'image_resolution' => $imageResolution,
            ];

            $previewJson = json_encode(
                $previewMeta,
                JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT | JSON_THROW_ON_ERROR
            );
            // プレビュー情報も実バイト数を含める。上限を超える書込みは行わない。
            $finalLeaseJson = json_encode(['user_id' => $userId, 'expires_at' => $expiresAt], JSON_THROW_ON_ERROR);
            $workspace->assertCanAdd($userId, strlen($previewJson) + max(0, strlen($finalLeaseJson) - strlen($leaseJson)), 0);
            if (file_put_contents($workDirectory . DIRECTORY_SEPARATOR . 'workspace.json', $finalLeaseJson, LOCK_EX) !== strlen($finalLeaseJson) ||
                file_put_contents($workDirectory . DIRECTORY_SEPARATOR . 'preview.json', $previewJson, LOCK_EX) !== strlen($previewJson)) {
                throw new RuntimeException('復元プレビューを書き込めません');
            }

            return [
                'ok' => true,
                'restore_token' => $token,
                'expires_at' => date(DATE_ATOM, $expiresAt),
                'backup' => [
                    'name' => $originalName,
                    'created_at' => $manifestData['created_at'] ?? null,
                    'application_version' => $manifestData['application_version'] ?? null,
                    'counts' => [
                        'views' => count($validatedData['views']),
                        'devices' => count($validatedData['devices']),
                        'device_monitor_status' => count($validatedData['device_monitor_status']),
                        'device_placements' => count($validatedData['device_placements']),
                        'links' => count($validatedData['links']),
                        'link_systems' => count($validatedData['link_systems']),
                        'canvas_notes' => count($validatedData['canvas_notes']),
                        'floor_plans' => count($validatedData['view_floor_plans']),
                        'device_images' => count($validatedData['device_images']),
                    ],
                ],
                'capacity' => $capacity,
                'image_resolution' => $imageResolution,
                'can_restore' => true,
                'message' => $capacityWarnings === []
                    ? '検証に成功しました。内容を確認して復元を実行してください。'
                    : '検証に成功しました。容量上限に近いため、空き容量と運用条件を確認して復元してください。',
            ];
        } catch (Throwable $e) {
            $this->removeDirectoryTree($workDirectory);
            throw $e;
        }
    }

    public function loadBackupRestorePreview(string $directory, string $token): array
    {
        if (preg_match('/\A[a-f0-9]{64}\z/', $token) !== 1) {
            throw new ApiException('復元トークンが不正です', 400);
        }

        $workDirectory = $directory . DIRECTORY_SEPARATOR . $token;
        $previewFile = $workDirectory . DIRECTORY_SEPARATOR . 'preview.json';

        if (!is_dir($workDirectory) || !is_file($previewFile)) {
            throw new ApiException('復元プレビューが見つからないか、期限切れです', 410);
        }

        $data = $this->readBackupJsonFile($previewFile, '復元プレビュー');
        $data['_work_dir'] = $workDirectory;

        return $data;
    }

    public function createPreRestoreBackup(array $config): array
    {
        $autoDirectory = $this->prepareWritableDirectory(
            (string)$config['backup_auto_directory'],
            '復元前自動バックアップ保存先'
        );

        $workRoot = $this->prepareBackupExportRoot((string)$config['backup_export_directory']);
        $workDirectory = $this->createBackupWorkDirectory($workRoot);
        $filename = 'pre-restore_' . date('Ymd_His') . '_' . bin2hex(random_bytes(4)) . '.zip';
        $zipPath = $autoDirectory . DIRECTORY_SEPARATOR . $filename;

        try {
            $result = $this->buildBackupZipFile($config, $workDirectory, $zipPath);

            return [
                'filename' => $filename,
                'path' => $zipPath,
                'size' => $result['zip_size'],
                'sha256' => $result['zip_sha256'],
            ];
        } finally {
            $this->removeDirectoryTree($workDirectory);
        }
    }





    public function cleanupAutomaticBackups(string $directory, int $keepCount, int $keepDays): bool
    {
        if (!is_dir($directory)) {
            return true;
        }

        $files = glob($directory . DIRECTORY_SEPARATOR . 'pre-restore_*.zip');

        if ($files === false) {
            return false;
        }

        if ($files === []) {
            return true;
        }

        $fileDetails = [];
        $cleanupSucceeded = true;
        $now = time();
        $cutoffTime = $now - ($keepDays * 86400);

        foreach ($files as $file) {
            $mtime = filemtime($file);

            if ($mtime === false) {
                $cleanupSucceeded = false;
                continue;
            }

            $fileDetails[] = [
                'path' => $file,
                'mtime' => $mtime,
            ];
        }

        usort(
            $fileDetails,
            static fn(array $a, array $b): int => $b['mtime'] <=> $a['mtime']
        );

        $kept = 0;

        foreach ($fileDetails as $item) {
            $kept++;

            if ($kept <= $keepCount && $item['mtime'] >= $cutoffTime) {
                continue;
            }

            if (!@unlink($item['path']) && is_file($item['path'])) {
                $cleanupSucceeded = false;
            }
        }

        return $cleanupSucceeded;
    }

    public function appendBackupRestoreLog(string $logFile, array $entry): bool
    {
        $parent = dirname($logFile);

        if (!is_dir($parent) && !@mkdir($parent, 0700, true) && !is_dir($parent)) {
            error_log('[Backup Restore] Failed to create log directory: ' . $parent);
            return false;
        }

        $line = json_encode(
            $entry,
            JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES
        );

        if (!is_string($line)) {
            error_log('[Backup Restore] Failed to encode restore log entry');
            return false;
        }

        return @file_put_contents(
            $logFile,
            $line . PHP_EOL,
            FILE_APPEND | LOCK_EX
        ) !== false;
    }


    public function replaceDatabaseFromBackup(
        array $backupData,
        int $dataRevision,
        int $monitorRevision,
        string $restoredAt
    ): void
    {
        $this->db->exec('DELETE FROM links');
        $this->db->exec('DELETE FROM link_systems');
        $this->db->exec('DELETE FROM device_placements');
        $this->db->exec('DELETE FROM canvas_notes');
        $this->db->exec('DELETE FROM view_floor_plans');
        $this->db->exec('DELETE FROM views');
        $this->db->exec('DELETE FROM device_images');
        $this->db->exec('DELETE FROM device_monitor_status');
        $this->db->exec('DELETE FROM devices');
        // Web構成ZIPが所有するキーだけを置換し、認証・環境の状態は保持する。
        $this->db->exec("DELETE FROM app_meta WHERE meta_key IN
            ('data_revision', 'monitor_revision', 'last_saved_at', 'last_monitored_at')");

        // 参照元を削除した後にマスタを復元。世代はtriggerで新規発行する。
        $systemStmt = $this->db->prepare('INSERT INTO link_systems (id, name, color_key) VALUES (:id, :name, :color_key)');
        foreach ($backupData['link_systems'] as $system) {
            $systemStmt->execute(['id' => $system['id'], 'name' => $system['name'], 'color_key' => $system['color_key']]);
        }

        $viewStmt = $this->db->prepare("
            INSERT INTO views (id, name, facility, floor, view_type, sort_order, memo)
            VALUES (:id, :name, :facility, :floor, :view_type, :sort_order, :memo)
        ");

        foreach ($backupData['views'] as $view) {
            $viewStmt->execute([
                ':id' => $view['id'],
                ':name' => $view['name'],
                ':facility' => $view['facility'],
                ':floor' => $view['floor'],
                ':view_type' => $view['view_type'],
                ':sort_order' => $view['sort_order'],
                ':memo' => $view['memo'],
            ]);
        }

        $deviceStmt = $this->db->prepare("
            INSERT INTO devices (
                id, name, type, ip, x, y, facility, floor, location,
                manufacturer, model, asset_number, serial_number, mac_address, memo,
                management_scheme, management_port, department, maintenance_vendor,
                install_date, maintenance_expiry
            ) VALUES (
                :id, :name, :type, :ip, :x, :y, :facility, :floor, :location,
                :manufacturer, :model, :asset_number, :serial_number, :mac_address, :memo,
                :management_scheme, :management_port, :department, :maintenance_vendor,
                :install_date, :maintenance_expiry
            )
        ");

        foreach ($backupData['devices'] as $dev) {
            $deviceStmt->execute([
                ':id' => $dev['id'],
                ':name' => $dev['name'],
                ':type' => $dev['type'],
                ':ip' => $dev['ip'],
                ':x' => $dev['x'],
                ':y' => $dev['y'],
                ':facility' => $dev['facility'],
                ':floor' => $dev['floor'],
                ':location' => $dev['location'],
                ':manufacturer' => $dev['manufacturer'],
                ':model' => $dev['model'],
                ':asset_number' => $dev['asset_number'],
                ':serial_number' => $dev['serial_number'],
                ':mac_address' => $dev['mac_address'],
                ':memo' => $dev['memo'],
                ':management_scheme' => $dev['management_scheme'] ?? '',
                ':management_port' => $dev['management_port'] ?? null,
                ':department' => $dev['department'] ?? '',
                ':maintenance_vendor' => $dev['maintenance_vendor'] ?? '',
                ':install_date' => $dev['install_date'] ?? '',
                ':maintenance_expiry' => $dev['maintenance_expiry'] ?? '',
            ]);
        }

        $statusStmt = $this->db->prepare("
            INSERT INTO device_monitor_status (
                device_id, status, last_checked_at, last_response_ms, last_error
            ) VALUES (
                :device_id, :status, :last_checked_at, :last_response_ms, :last_error
            )
        ");

        foreach ($backupData['device_monitor_status'] as $st) {
            $statusStmt->execute([
                ':device_id' => $st['device_id'],
                ':status' => $st['status'],
                ':last_checked_at' => $st['last_checked_at'],
                ':last_response_ms' => $st['last_response_ms'],
                ':last_error' => $st['last_error'],
            ]);
        }

        $placementStmt = $this->db->prepare("
            INSERT INTO device_placements (id, device_id, view_id, x, y)
            VALUES (:id, :device_id, :view_id, :x, :y)
        ");

        foreach ($backupData['device_placements'] as $pl) {
            $placementStmt->execute([
                ':id' => $pl['id'],
                ':device_id' => $pl['device_id'],
                ':view_id' => $pl['view_id'],
                ':x' => $pl['x'],
                ':y' => $pl['y'],
            ]);
        }

        $linkStmt = $this->db->prepare("
            INSERT INTO links (id, view_id, from_id, to_id, system_id, label, from_port, to_port, vlan, memo, route_mode, manual_route)
            VALUES (:id, :view_id, :from_id, :to_id, :system_id, :label, :from_port, :to_port, :vlan, :memo, :route_mode, :manual_route)
        ");

        foreach ($backupData['links'] as $lk) {
            $linkStmt->execute([
                ':id' => $lk['id'],
                ':view_id' => $lk['view_id'],
                ':from_id' => $lk['from_id'],
                ':to_id' => $lk['to_id'],
                ':system_id' => $lk['system_id'],
                ':label' => $lk['label'],
                ':from_port' => $lk['from_port'],
                ':to_port' => $lk['to_port'],
                ':vlan' => $lk['vlan'],
                ':memo' => $lk['memo'],
                ':route_mode' => $lk['route_mode'],
                ':manual_route' => json_encode($lk['manual_route'], JSON_THROW_ON_ERROR),
            ]);
        }

        $noteStmt = $this->db->prepare('INSERT INTO canvas_notes (' . implode(', ', CanvasNote::COLUMNS)
            . ') VALUES (:' . implode(', :', CanvasNote::COLUMNS) . ')');
        foreach ($backupData['canvas_notes'] as $note) {
            $noteStmt->execute($note);
        }

        $floorPlanStmt = $this->db->prepare("
            INSERT INTO view_floor_plans (
                view_id, stored_name, original_name, mime_type, file_size,
                image_width, image_height, x, y, scale, opacity, is_visible,
                revision, created_at, updated_at, sha256
            ) VALUES (
                :view_id, :stored_name, :original_name, :mime_type, :file_size,
                :image_width, :image_height, :x, :y, :scale, :opacity, :is_visible,
                :revision, :created_at, :updated_at, :sha256
            )
        ");

        foreach ($backupData['view_floor_plans'] as $fpRow) {
            $viewId = $fpRow['view_id'];

            $floorPlanStmt->execute([
                ':view_id' => $viewId,
                ':stored_name' => $fpRow['stored_name'],
                ':original_name' => $fpRow['original_name'],
                ':mime_type' => $fpRow['mime_type'],
                ':file_size' => $fpRow['file_size'],
                ':sha256' => $fpRow['sha256'],
                ':image_width' => $fpRow['image_width'],
                ':image_height' => $fpRow['image_height'],
                ':x' => $fpRow['x'],
                ':y' => $fpRow['y'],
                ':scale' => $fpRow['scale'],
                ':opacity' => $fpRow['opacity'],
                ':is_visible' => $fpRow['is_visible'],
                ':revision' => $fpRow['revision'],
                ':created_at' => $fpRow['created_at'],
                ':updated_at' => $fpRow['updated_at'],
            ]);
        }

        $imageStmt = $this->db->prepare("
            INSERT INTO device_images (
                id, device_id, stored_name, mime_type, file_size,
                image_width, image_height, caption, sort_order,
                created_at, updated_at, sha256
            ) VALUES (
                :id, :device_id, :stored_name, :mime_type, :file_size,
                :image_width, :image_height, :caption, :sort_order,
                :created_at, :updated_at, :sha256
            )
        ");

        foreach ($backupData['device_images'] as $imgRow) {
            $imgId = (int)$imgRow['id'];
            $imageStmt->execute([
                ':id' => $imgId,
                ':device_id' => $imgRow['device_id'],
                ':stored_name' => $imgRow['stored_name'],
                ':mime_type' => $imgRow['mime_type'],
                ':file_size' => $imgRow['file_size'],
                ':sha256' => $imgRow['sha256'],
                ':image_width' => $imgRow['image_width'],
                ':image_height' => $imgRow['image_height'],
                ':caption' => $imgRow['caption'],
                ':sort_order' => $imgRow['sort_order'],
                ':created_at' => $imgRow['created_at'],
                ':updated_at' => $imgRow['updated_at'],
            ]);
        }

        $this->db->exec('PRAGMA user_version = ' . APP_DATABASE_SCHEMA_VERSION);

        $metaStmt = $this->db->prepare("
            INSERT INTO app_meta (meta_key, meta_value)
            VALUES (:meta_key, :meta_value)
        ");

        $restoredMeta = $backupData['app_meta'];
        $restoredMeta['data_revision'] = (string)$dataRevision;
        $restoredMeta['monitor_revision'] = (string)$monitorRevision;
        $restoredMeta['last_saved_at'] = $restoredAt;

        foreach ($restoredMeta as $k => $v) {
            $metaStmt->execute([
                ':meta_key' => $k,
                ':meta_value' => (string)$v,
            ]);
        }
    }

    public function commitBackupRestore(string $token, string $confirmation, array $config): array
    {
        $workspace = new RestoreWorkspace($config);
        try {
            $workspace->cleanupExpired();
            return $this->commitBackupRestoreLocked($token, $confirmation, $config);
        } finally {
            $workspace->release();
        }
    }

    private function commitBackupRestoreLocked(string $token, string $confirmation, array $config): array
    {
        if (!hash_equals((string)($config['backup_restore_confirmation'] ?? 'バックアップから復元'), $confirmation)) {
            throw new ApiException('確認文言が一致しません', 400);
        }
        $preview = $this->loadBackupRestorePreview((string)$config['backup_restore_directory'], $token);
        $workDir = (string)$preview['_work_dir'];
        $userId = (string)currentUserId();
        $signature = $this->createBackupRestoreSignature(
            $token, (string)$preview['user_id'], (string)$preview['zip_hash'],
            (int)$preview['data_revision'], (int)$preview['monitor_revision'],
            (int)$preview['source_data_revision'], (int)$preview['source_monitor_revision'], (int)$preview['expires_at']
        );
        if ((string)$preview['user_id'] !== $userId || !hash_equals($signature, (string)$preview['signature'])) {
            throw new ApiException('復元プレビューを利用できません', 403);
        }
        if ((int)$preview['expires_at'] < time()) {
            $this->removeDirectoryTree($workDir);
            throw new ApiException('復元プレビューの有効期限が切れました。再度アップロードしてください', 410);
        }
        $currentDataRevision = $this->appMetaRepo->getDataRevision();
        $currentMonitorRevision = $this->appMetaRepo->getMonitorRevision();
        if ($currentDataRevision !== (int)$preview['source_data_revision']
            || $currentMonitorRevision !== (int)$preview['source_monitor_revision']) {
            throw new ApiException('プレビュー後に現行データが更新されています。再度プレビューしてください', 409);
        }
        $zipPath = $workDir . DIRECTORY_SEPARATOR . 'upload.zip';
        $hash = @hash_file('sha256', $zipPath);
        if (!is_string($hash) || !hash_equals((string)$preview['zip_hash'], $hash)) {
            throw new ApiException('構成情報ZIPの整合性を確認できません', 400);
        }
        $this->inspectBackupZip($zipPath, $config);
        $zip = new ZipArchive();
        if ($zip->open($zipPath, ZipArchive::RDONLY) !== true) {
            throw new ApiException('構成情報ZIPを開けません', 400);
        }
        try {
            $manifest = json_decode((string)$zip->getFromName('manifest.json'), true, 512, JSON_THROW_ON_ERROR);
            $json = (string)$zip->getFromName('data/netarium.json');
            $this->validateBackupManifest($manifest, [
                'data/netarium.json' => ['size' => strlen($json), 'sha256' => hash('sha256', $json)],
                'manifest.json' => [],
            ], (string)$config['application_version']);
            $data = $this->validateCompleteBackupRestoreData(
                $this->validateBackupDataDocument(json_decode($json, true, 512, JSON_THROW_ON_ERROR)), $config
            );
        } finally {
            $zip->close();
        }
        $resolution = $this->resolveImageReferences($data, $config);
        if ($resolution !== ($preview['image_resolution'] ?? null)) {
            throw new ApiException('プレビュー後に画像の状態が変わりました。再度プレビューしてください', 409);
        }
        $this->validateRestoreIdState();
        $limits = CapacityService::limits($config);
        $estimate = $this->estimateBackupSource($config);
        $requiredBytes = $estimate['work_bytes'] + $limits['backup']['max_zip_bytes'] + $limits['workspace_reserve_bytes'];
        foreach (['backup_export_directory', 'backup_auto_directory'] as $key) {
            $this->prepareWritableDirectory((string)$config[$key], '構成情報退避先');
            CapacityService::requireFreeSpace((string)$config[$key], $requiredBytes, '構成情報退避先');
        }
        $preRestoreBackup = $this->createPreRestoreBackup($config);
        $restoredAt = date(DATE_ATOM);
        try {
            $this->db->beginTransaction();
            $this->db->exec("UPDATE resource_sequences SET value = value WHERE name = 'revision'");
            if ($this->appMetaRepo->getDataRevision() !== $currentDataRevision
                || $this->appMetaRepo->getMonitorRevision() !== $currentMonitorRevision) {
                throw new ApiException('復元直前に現行データが更新されました。再度プレビューしてください', 409);
            }
            $this->validateRestoreIds($data);
            $this->validateRestoreIdState();
            $this->replaceDatabaseFromBackup($data, $currentDataRevision + 1, $currentMonitorRevision + 1, $restoredAt);
            $this->db->commit();
        } catch (Throwable $e) {
            if ($this->db->inTransaction()) {
                $this->db->rollBack();
            }
            if ($e instanceof PDOException && Database::isBusy($e)) {
                throw new ApiException('別の更新処理が実行されています。再度復元してください', 409);
            }
            throw $e;
        }
        // Web復元は物理画像・GC・認証セッションを変更しない。
        $errors = [];
        try {
            if (!$this->cleanupAutomaticBackups((string)$config['backup_auto_directory'],
                (int)($config['backup_auto_keep_count'] ?? 2), (int)($config['backup_auto_keep_days'] ?? 7))) {
                $errors[] = 'automatic_backup_cleanup';
            }
        } catch (Throwable $e) {
            error_log('[Config Restore] ' . $e->getMessage());
            $errors[] = 'automatic_backup_cleanup';
        }
        if (!$this->appendBackupRestoreLog((string)$config['backup_restore_log_file'], [
            'restored_at' => $restoredAt, 'user_id' => $userId, 'username' => currentUsername(),
            'request_id' => \Netarium\Core\AuditLog::id(),
            'original_name' => $preview['original_name'], 'pre_restore_backup' => $preRestoreBackup['filename'],
        ])) {
            $errors[] = 'restore_log';
        }
        $this->removeDirectoryTree($workDir);
        if (is_dir($workDir)) {
            $errors[] = 'restore_work_directory_cleanup';
        }
        return [
            'ok' => true,
            'message' => '構成情報を復元しました',
            'pre_restore_backup' => $preRestoreBackup['filename'],
            'session_ended' => false,
            'redirect' => 'index.php',
            'image_resolution' => $resolution,
            'capacity' => $preview['capacity'],
            'post_processing_required' => $errors !== [],
            'post_processing_errors' => $errors,
        ];
    }
}
