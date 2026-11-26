<?php
declare(strict_types=1);

// Private, administrator-only JSON RPC worker. The same PHP flock as Web/CLI
// writers remains held until this worker exits, including the placement phase.
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
$appRoot = (isset($argv[1]) && !str_starts_with($argv[1], '-')) ? $argv[1] : dirname(__DIR__);
require_once $appRoot . '/bootstrap.php';
require_once $appRoot . '/src/Core/DatabaseSchema.php';

function fullSafeName(string $name): void
{
    if (!preg_match('~\A(?:db/data\.sqlite|(?:floorplans|device_images)/[A-Za-z0-9][A-Za-z0-9_.-]*)\z~D', $name)
        || str_contains($name, '..') || preg_match('~/(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)~i', $name)
        || str_ends_with($name, '.')) {
        throw new RuntimeException('Unsafe archive path: ' . $name);
    }
}

function fullValidateSchema(PDO $db, int $schemaVersion): void
{
    global $appRoot;
    if (!\Netarium\Services\Backup\BackupCompatibilityPolicy::isSupportedSchema($schemaVersion)) {
        throw new RuntimeException('Unsupported source schema');
    }
    $reference = new PDO('sqlite::memory:', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    for ($version = 1; $version <= $schemaVersion; $version++) {
        ('migrateDatabaseToVersion' . $version)($reference);
    }
    // Verify tables, columns, CHECKs, FKs, indexes and triggers before any source
    // migration executes. user_version alone is not a database contract.
    $sql = "SELECT type, name, tbl_name, sql FROM sqlite_master
        WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name";
    $normalize = static function (PDO $connection) use ($sql): array {
        $rows = $connection->query($sql)->fetchAll(PDO::FETCH_ASSOC);
        foreach ($rows as &$row) { $row['sql'] = preg_replace('/\s+/', ' ', trim((string)$row['sql'])); }
        return $rows;
    };
    if ($normalize($db) !== $normalize($reference)) { throw new RuntimeException('Database schema contract mismatch'); }
    $types = $schemaVersion >= 13
        ? "'switch','l3_switch','router','firewall','ap','server','pc','printer','other'"
        : "'switch','l3_switch','router','firewall','ap','server','printer','other'";
    if ($db->query("SELECT 1 FROM devices WHERE type NOT IN ($types) LIMIT 1")->fetchColumn() !== false) {
        throw new RuntimeException('Invalid source device type');
    }
    if ($schemaVersion === 11 && $db->query("SELECT 1 FROM views WHERE view_type NOT IN ('topology','floor') LIMIT 1")->fetchColumn() !== false) {
        throw new RuntimeException('Invalid source view type');
    }
    if ($schemaVersion >= 12) {
        \Netarium\Services\Topology\RackLayout::validate(
            $db->query('SELECT * FROM rack_settings')->fetchAll(PDO::FETCH_ASSOC),
            $db->query('SELECT * FROM rack_mounts')->fetchAll(PDO::FETCH_ASSOC),
            $db->query('SELECT * FROM views')->fetchAll(PDO::FETCH_ASSOC),
            $db->query('SELECT * FROM devices')->fetchAll(PDO::FETCH_ASSOC),
            $schemaVersion >= 15 ? $db->query('SELECT * FROM rack_shelves')->fetchAll(PDO::FETCH_ASSOC) : [],
            $schemaVersion >= 15 ? $db->query('SELECT * FROM rack_shelf_devices')->fetchAll(PDO::FETCH_ASSOC) : []
        );
        foreach (['device_placements', $schemaVersion < 27 ? 'links' : 'view_link_routes', 'view_floor_plans'] as $table) {
            if ($db->query("SELECT 1 FROM $table t JOIN views v ON v.id=t.view_id WHERE v.view_type='rack' LIMIT 1")->fetchColumn() !== false) {
                throw new RuntimeException('Rack view contains XY content');
            }
        }
    }
    if ($schemaVersion >= 16) {
        \Netarium\Services\Topology\FloorRackPlacement::normalizeRows(
            $db->query('SELECT * FROM floor_rack_placements')->fetchAll(PDO::FETCH_ASSOC),
            $db->query('SELECT * FROM views')->fetchAll(PDO::FETCH_ASSOC)
        );
    }
    if ($schemaVersion >= 17) {
        $devices = [];
        foreach ($db->query('SELECT id, ip FROM devices')->fetchAll(PDO::FETCH_ASSOC) as $device) {
            $devices[$device['id']] = $device;
        }
        (new \Netarium\Services\Backup\BackupService($db))->validateBackupDeviceIpAddresses(
            $db->query('SELECT * FROM device_ip_addresses ORDER BY id')->fetchAll(PDO::FETCH_ASSOC), $devices, $schemaVersion
        );
    }
    if ($schemaVersion >= 18) {
        (new \Netarium\Services\Backup\BackupService($db))->validateBackupIpManagement(
            $db->query('SELECT * FROM address_spaces ORDER BY id')->fetchAll(PDO::FETCH_ASSOC),
            $db->query('SELECT * FROM ip_segments ORDER BY id')->fetchAll(PDO::FETCH_ASSOC),
            $db->query('SELECT id, ip, ip_segment_id FROM devices')->fetchAll(PDO::FETCH_ASSOC),
            $db->query('SELECT * FROM device_ip_addresses ORDER BY id')->fetchAll(PDO::FETCH_ASSOC), $schemaVersion
        );
    }
    if ($schemaVersion >= 19) {
        \Netarium\Services\Topology\ChangeHistoryService::validateBackupRows(
            $db->query('SELECT * FROM change_history ORDER BY id')->fetchAll(PDO::FETCH_ASSOC)
        );
    }
    if ($schemaVersion >= 20) {
        $limits = \Netarium\Services\Storage\CapacityService::limits(
            class_exists(\Netarium\Core\Config::class) ? \Netarium\Core\Config::create($appRoot) : []
        );
        $maxConfigBytes = $limits['device_configs']['max_total_bytes'] ?? \Netarium\Services\Topology\DeviceConfigService::DEFAULT_MAX_TOTAL_BYTES;
        \Netarium\Services\Topology\DeviceConfigService::validateBackupRows(
            $db->query('SELECT * FROM device_configs ORDER BY id')->fetchAll(PDO::FETCH_ASSOC),
            $db->query('SELECT * FROM device_config_states ORDER BY device_id')->fetchAll(PDO::FETCH_ASSOC),
            $db->query('SELECT id FROM devices ORDER BY id')->fetchAll(PDO::FETCH_COLUMN),
            $maxConfigBytes
        );
    }
    if ($schemaVersion >= 23 && $db->query("SELECT 1 FROM view_floor_plans
        WHERE rotation IS NULL OR typeof(rotation) NOT IN ('integer', 'real')
            OR rotation NOT BETWEEN -180 AND 180 LIMIT 1")->fetchColumn() !== false) {
        throw new RuntimeException('Invalid floor plan rotation');
    }
    if ($schemaVersion >= 24) {
        \Netarium\Services\Topology\BuildingHierarchyService::validateBackupRows(
            $db->query('SELECT * FROM buildings ORDER BY id')->fetchAll(PDO::FETCH_ASSOC),
            $db->query('SELECT * FROM floors ORDER BY id')->fetchAll(PDO::FETCH_ASSOC),
            $db->query('SELECT * FROM views ORDER BY id')->fetchAll(PDO::FETCH_ASSOC),
            $schemaVersion >= 26
        );
        foreach (['buildings', 'floors'] as $table) {
            $sequence = $db->query("SELECT value FROM resource_sequences WHERE name = '$table'")->fetchColumn();
            if (!is_int($sequence) || $sequence < 0 || $sequence > \Netarium\Core\ResourceId::MAX_RESTORE) {
                throw new RuntimeException('Invalid sequence: ' . $table);
            }
            foreach ($db->query("SELECT id FROM $table") as $row) {
                \Netarium\Core\ResourceId::parse($row['id'], "$table.id", \Netarium\Core\ResourceId::MAX_RESTORE);
            }
        }
    }
    if ($schemaVersion >= 25) {
        $floorIds = array_fill_keys($db->query('SELECT id FROM floors')->fetchAll(PDO::FETCH_COLUMN), true);
        foreach ($db->query('SELECT floor_id FROM devices') as $device) {
            \Netarium\Services\Topology\BuildingHierarchyService::normalizeFloorId($device['floor_id'], $floorIds);
        }
    }
    foreach (['address_spaces' => 18, 'ip_segments' => 18, 'change_history' => 19, 'device_configs' => 20] as $table => $introducedIn) {
        if ($schemaVersion < $introducedIn) { continue; }
        $stmt = $db->prepare('SELECT seq FROM sqlite_sequence WHERE name = ?');
        $stmt->execute([$table]);
        $sequence = $stmt->fetchColumn();
        if ($sequence !== false && (!is_int($sequence) || $sequence < 0 || $sequence > \Netarium\Core\ResourceId::MAX_RESTORE)) {
            throw new RuntimeException('Invalid sequence: ' . $table);
        }
    }
    $backup = new \Netarium\Services\Backup\BackupService($db);
    if ($schemaVersion < 27) {
        $linkCounter = $db->query("SELECT value FROM resource_sequences WHERE name = 'links'")->fetchColumn();
        $maxLink = (int)$db->query('SELECT COALESCE(MAX(id), 0) FROM links')->fetchColumn();
        if (!is_int($linkCounter) || $linkCounter < $maxLink || $linkCounter > \Netarium\Core\ResourceId::MAX_RESTORE
            || $db->query('SELECT 1 FROM links WHERE id <= 0 OR from_id = to_id LIMIT 1')->fetchColumn() !== false) {
            throw new RuntimeException('Invalid legacy links or sequence');
        }
        foreach ($db->query('SELECT vlan FROM links') as $row) {
            if (!is_string($row['vlan']) || preg_match('/\A.{0,100}\z/su', $row['vlan']) !== 1) {
                throw new RuntimeException('Invalid legacy link VLAN');
            }
        }
    } else {
        if ($schemaVersion >= 28 && $db->query("SELECT 1 FROM legacy_link_vlans WHERE typeof(vlan) <> 'text' LIMIT 1")->fetchColumn() !== false) {
            throw new RuntimeException('Invalid pending legacy link VLAN type');
        }
        $connections = $backup->validateBackupConnectionTables(
            ['links' => $db->query('SELECT * FROM links ORDER BY id')->fetchAll(PDO::FETCH_ASSOC)] + $backup->fetchBackupConnectionTables($schemaVersion),
            array_fill_keys($db->query('SELECT id FROM devices')->fetchAll(PDO::FETCH_COLUMN), true),
            array_column($db->query('SELECT id, view_type FROM views')->fetchAll(PDO::FETCH_ASSOC), null, 'id'),
            array_fill_keys($db->query('SELECT id FROM link_systems')->fetchAll(PDO::FETCH_COLUMN), true),
            $schemaVersion
        );
        if ($schemaVersion >= 29) {
            if ($db->query("SELECT 1 FROM quality_not_applicable WHERE typeof(field) <> 'text' LIMIT 1")->fetchColumn() !== false) {
                throw new RuntimeException('Invalid quality not applicable field type');
            }
            $rows = $db->query('SELECT device_id, link_id, field FROM quality_not_applicable')->fetchAll(PDO::FETCH_ASSOC);
            if ($rows !== []) {
                $fields = implode(', ', \Netarium\Services\Quality\QualityNotApplicable::DEVICE_FIELDS);
                $devices = $db->query("SELECT id, $fields FROM devices WHERE id IN (SELECT device_id FROM quality_not_applicable)")
                    ->fetchAll(PDO::FETCH_UNIQUE | PDO::FETCH_ASSOC);
                $backup->validateBackupQualityNotApplicable($rows, $devices, $connections['links']);
            }
        }
    }
}

function fullDatabase(string $file, string $root, bool $prepare = false, int $schemaVersion = APP_DATABASE_SCHEMA_VERSION): array
{
    if (!is_file($file)) { throw new RuntimeException('Database missing'); }
    $db = new PDO('sqlite:' . $file, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    if ($prepare) { $db->beginTransaction(); } else { $db->exec('PRAGMA query_only=ON'); }
    try {
        if ((int)$db->query('PRAGMA user_version')->fetchColumn() !== $schemaVersion) {
            throw new RuntimeException('Incompatible database schema');
        }
        fullValidateSchema($db, $schemaVersion);
        if ($db->query('PRAGMA integrity_check')->fetchAll(PDO::FETCH_COLUMN) !== ['ok']
            || $db->query('PRAGMA foreign_key_check')->fetch() !== false) {
            throw new RuntimeException('SQLite integrity/foreign key check failed');
        }
        foreach (['view_floor_plans' => 'floorplans', 'device_images' => 'device_images'] as $table => $directory) {
            $key = $table === 'view_floor_plans' ? 'view_id' : 'id';
            foreach ($db->query("SELECT * FROM $table") as $row) {
                $name = $directory . '/' . $row['stored_name'];
                fullSafeName($name);
                $path = $root . '/' . $name;
                if (!is_file($path) || is_link($path) || filesize($path) !== (int)$row['file_size']) {
                    throw new RuntimeException('Image reference/size mismatch: ' . $name);
                }
                $sha = hash_file('sha256', $path);
                if ($sha === false) { throw new RuntimeException('Cannot hash image: ' . $name); }
                $image = getimagesize($path);
                if ($image === false || $image[0] !== (int)$row['image_width']
                    || $image[1] !== (int)$row['image_height'] || $image['mime'] !== $row['mime_type']) {
                    throw new RuntimeException('Image attributes mismatch: ' . $name);
                }
                if ($prepare && $row['sha256'] === '') {
                    // Only the private backup snapshot may acquire a legacy digest.
                    $stmt = $db->prepare("UPDATE $table SET sha256 = ? WHERE $key = ? AND sha256 = ''");
                    $stmt->execute([$sha, $row[$key]]);
                } elseif (!is_string($row['sha256']) || !hash_equals($row['sha256'], $sha)) {
                    throw new RuntimeException('Image reference hash mismatch: ' . $name);
                }
            }
        }
        $counts = [];
        foreach ($db->query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'") as $row) {
            $table = $row['name'];
            $counts[$table] = (int)$db->query('SELECT COUNT(*) FROM "' . str_replace('"', '""', $table) . '"')->fetchColumn();
        }
        if ($prepare) { $db->commit(); }
        return $counts;
    } catch (Throwable $e) {
        if ($db->inTransaction()) { $db->rollBack(); }
        throw $e;
    }
}

function fullInventory(string $root): array
{
    $files = [];
    foreach (['db', 'floorplans', 'device_images'] as $directory) {
        if (!is_dir($root . '/' . $directory)) { throw new RuntimeException('Missing logical directory'); }
        foreach (new DirectoryIterator($root . '/' . $directory) as $item) {
            if ($item->isDot()) { continue; }
            $name = $directory . '/' . $item->getFilename();
            fullSafeName($name);
            if (!$item->isFile() || $item->isLink()) { throw new RuntimeException('Non-regular archive member'); }
            $files[$name] = ['bytes' => $item->getSize(), 'sha256' => hash_file('sha256', $item->getPathname())];
        }
    }
    ksort($files);
    return $files;
}

/** Hash only source columns, one row at a time; serialized values preserve types and binary data. */
function fullTableFingerprint(PDO $db, string $table, array $columns, int $sourceSchemaVersion = APP_DATABASE_SCHEMA_VERSION): array
{
    $quotedTable = '"' . str_replace('"', '""', $table) . '"';
    $quotedColumns = array_map(static fn(string $column): string => '"' . str_replace('"', '""', $column) . '"', $columns);
    $excludedSequences = $sourceSchemaVersion < 15 ? ['rack_shelves'] : [];
    if ($sourceSchemaVersion < 25) { array_push($excludedSequences, 'buildings', 'floors', 'revision'); }
    $excludedMeta = $sourceSchemaVersion < 25 ? ['legacy_hierarchy_migration'] : [];
    if ($sourceSchemaVersion < 27 && APP_DATABASE_SCHEMA_VERSION >= 27) {
        array_push($excludedSequences, 'device_ports', 'revision');
        $excludedMeta[] = 'legacy_link_migration';
    }
    $where = match ($table) {
        'resource_sequences' => $excludedSequences === [] ? '' :
            ' WHERE name NOT IN (' . implode(', ', array_map($db->quote(...), array_unique($excludedSequences))) . ')',
        'app_meta' => $excludedMeta === [] ? '' :
            ' WHERE meta_key NOT IN (' . implode(', ', array_map($db->quote(...), $excludedMeta)) . ')',
        default => '',
    };
    $rows = $db->query('SELECT ' . implode(', ', $quotedColumns) . " FROM $quotedTable$where ORDER BY rowid");
    $hashContext = hash_init('sha256');
    $count = 0;
    while (($row = $rows->fetch(PDO::FETCH_NUM)) !== false) {
        hash_update($hashContext, serialize($row));
        $count++;
    }
    $rows->closeCursor();
    return ['count' => $count, 'sha256' => hash_final($hashContext)];
}

function fullExtract(string $archive, string $root, int $maxBytes, int $maxFiles): array
{
    $zip = new ZipArchive();
    if ($zip->open($archive, ZipArchive::CHECKCONS) !== true) { throw new RuntimeException('Invalid ZIP'); }
    try {
        if ($zip->numFiles < 2 || $zip->numFiles > $maxFiles + 1) { throw new RuntimeException('ZIP entry limit'); }
        $maxManifestBytes = min(64 * 1024 * 1024, max(2 * 1024 * 1024, $maxFiles * 512));
        $manifestText = $zip->getFromName('manifest.json', $maxManifestBytes + 1);
        if (!is_string($manifestText) || strlen($manifestText) > $maxManifestBytes) { throw new RuntimeException('Manifest missing/oversize'); }
        $m = json_decode($manifestText, true, 512, JSON_THROW_ON_ERROR);
        if (!is_array($m) || !\Netarium\Services\Backup\BackupCompatibilityPolicy::isCompatible(
                \Netarium\Services\Backup\BackupCompatibilityPolicy::FORMAT_FULL,
                $m['format'] ?? null,
                $m['format_version'] ?? null,
                $m['schema_version'] ?? null,
                $m['application_version'] ?? null,
                APP_DATABASE_SCHEMA_VERSION,
                NETARIUM_VERSION
            )) {
            throw new RuntimeException(
                \Netarium\Services\Backup\BackupCompatibilityPolicy::describeFullIncompatibility(
                    is_array($m) ? ($m['format'] ?? null) : null,
                    is_array($m) ? ($m['format_version'] ?? null) : null,
                    is_array($m) ? ($m['schema_version'] ?? null) : null,
                    is_array($m) ? ($m['application_version'] ?? null) : null,
                    APP_DATABASE_SCHEMA_VERSION,
                    NETARIUM_VERSION
                )
            );
        }
        $expectedManifestKeys = ['application_version', 'counts', 'created_at', 'file_count', 'files', 'format', 'format_version', 'logical_paths', 'schema_version', 'total_bytes'];
        $manifestKeys = array_keys($m);
        sort($manifestKeys);
        $expectedLogicalPaths = ['db' => 'db/data.sqlite', 'floor_plan_directory' => 'floorplans', 'device_image_directory' => 'device_images'];
        if ($manifestKeys !== $expectedManifestKeys || !is_array($m['files'] ?? null) || !is_array($m['counts'] ?? null)
            || ($m['logical_paths'] ?? null) !== $expectedLogicalPaths || !is_string($m['created_at'] ?? null) || $m['created_at'] === '') {
            throw new RuntimeException('Incompatible full backup manifest');
        }
        $seen = []; $total = 0;
        for ($i = 0; $i < $zip->numFiles; $i++) {
            $s = $zip->statIndex($i);
            $name = $s['name'];
            $key = strtolower($name);
            if (isset($seen[$key])) { throw new RuntimeException('Duplicate archive path'); }
            $seen[$key] = true;
            $opsys = 0; $attr = 0;
            if (!$zip->getExternalAttributesIndex($i, $opsys, $attr) || ($opsys === 3 && (($attr >> 16) & 0170000) !== 0 && (($attr >> 16) & 0170000) !== 0100000)) {
                throw new RuntimeException('ZIP special file rejected');
            }
            if ($name === 'manifest.json') { continue; }
            fullSafeName($name);
            $expected = $m['files'][$name] ?? null;
            if (!is_array($expected) || count($expected) !== 2 || !is_int($expected['bytes'] ?? null) || $expected['bytes'] < 0
                || $s['size'] !== $expected['bytes'] || !preg_match('/\A[0-9a-f]{64}\z/', $expected['sha256'] ?? '')) {
                throw new RuntimeException('Unexpected/malformed ZIP entry');
            }
            $total += $s['size'];
            if ($total > $maxBytes) { throw new RuntimeException('ZIP expansion limit'); }
        }
        if (count($seen) !== count($m['files']) + 1 || !isset($m['files']['db/data.sqlite'])
            || ($m['file_count'] ?? null) !== count($m['files']) || ($m['total_bytes'] ?? null) !== $total) {
            throw new RuntimeException('Missing archive members/totals');
        }
        if (disk_free_space($root) < $total + 64 * 1024 * 1024) { throw new RuntimeException('Insufficient staging disk'); }
        foreach (['db', 'floorplans', 'device_images'] as $dir) { mkdir($root . '/' . $dir, 0700); }
        foreach ($m['files'] as $name => $expected) {
            $in = $zip->getStream($name); $out = fopen($root . '/' . $name, 'xb');
            if ($in === false || $out === false) { throw new RuntimeException('Cannot extract entry'); }
            try {
                $bytes = stream_copy_to_stream($in, $out, $expected['bytes'] + 1);
                if ($bytes !== $expected['bytes'] || !fflush($out)) { throw new RuntimeException('Extraction length/write failure'); }
            } finally { fclose($in); fclose($out); }
            if (!hash_equals($expected['sha256'], hash_file('sha256', $root . '/' . $name))) { throw new RuntimeException('SHA-256 mismatch'); }
        }
        $file = $root . '/db/data.sqlite';
        $sourceSchemaVersion = $m['schema_version'];
        $counts = fullDatabase($file, $root, false, $sourceSchemaVersion);
        if ($counts !== $m['counts']) { throw new RuntimeException('Database count mismatch'); }
        if ($sourceSchemaVersion < APP_DATABASE_SCHEMA_VERSION) {
            // Extraction uses exclusive-created files in a private workspace.
            // Only this isolated DB is migrated, after all source checks finish.
            $db = new PDO('sqlite:' . $file, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
            $before = [];
            $migratesHierarchy = $sourceSchemaVersion < 25 && APP_DATABASE_SCHEMA_VERSION >= 25;
            if ($migratesHierarchy) {
                $expectedHierarchy = [];
                foreach (['buildings', 'floors', 'views', 'devices'] as $table) {
                    $expectedHierarchy[$table] = $sourceSchemaVersion >= 24 || !in_array($table, ['buildings', 'floors'], true)
                        ? $db->query("SELECT * FROM {$table} ORDER BY id")->fetchAll(PDO::FETCH_ASSOC) : [];
                }
                \Netarium\Services\Topology\LegacyHierarchyMigration::convert($expectedHierarchy,
                    $db->query('SELECT name, value FROM resource_sequences')->fetchAll(PDO::FETCH_KEY_PAIR));
            }
            $migratesLinks = $sourceSchemaVersion < 27 && APP_DATABASE_SCHEMA_VERSION >= 27;
            if ($migratesLinks) {
                $expectedConnections = \Netarium\Services\Topology\LegacyLinkMigration::convert(
                    $db->query('SELECT * FROM links ORDER BY id')->fetchAll(PDO::FETCH_ASSOC)
                );
                $viewRevisions = $db->query('SELECT id, resource_revision FROM views')->fetchAll(PDO::FETCH_KEY_PAIR);
                $routeOwners = array_fill_keys(array_column($expectedConnections['view_link_routes'], 'view_id'), true);
                $previousRevision = (int)$db->query("SELECT value FROM resource_sequences WHERE name = 'revision'")->fetchColumn();
            }
            $migratesVlans = $sourceSchemaVersion < 28 && APP_DATABASE_SCHEMA_VERSION >= 28;
            if ($migratesVlans) {
                $expectedVlans = \Netarium\Services\Backup\BackupService::pendingLegacyLinkVlans(
                    $migratesLinks ? $expectedConnections['links']
                        : $db->query('SELECT id, vlan FROM links ORDER BY id')->fetchAll(PDO::FETCH_ASSOC)
                );
                usort($expectedVlans, static fn(array $a, array $b): int => $a['link_id'] <=> $b['link_id']);
            }
            foreach (array_keys($counts) as $table) {
                if ($migratesLinks && $table === 'links') { continue; }
                $columns = [];
                foreach ($db->query('PRAGMA table_info("' . str_replace('"', '""', $table) . '")') as $column) {
                    if ($migratesHierarchy && in_array($table, ['views', 'devices'], true)
                        && in_array($column['name'], ['resource_revision', 'floor_id'], true)) { continue; }
                    if ($migratesLinks && $table === 'views' && $column['name'] === 'resource_revision') { continue; }
                    if ($migratesVlans && $table === 'links' && $column['name'] === 'vlan') { continue; }
                    $columns[] = $column['name'];
                }
                $before[$table] = ['columns' => $columns, 'fingerprint' => fullTableFingerprint($db, $table, $columns, $sourceSchemaVersion)];
            }
            migrateDatabase($db);
            if ($sourceSchemaVersion < 26 && APP_DATABASE_SCHEMA_VERSION >= 26
                && $db->query('SELECT 1 FROM buildings WHERE building_view_enabled IS NOT 1 LIMIT 1')->fetchColumn() !== false) {
                throw new RuntimeException('Migration did not enable all existing buildings');
            }
            if ($migratesHierarchy) {
                foreach (['buildings', 'floors'] as $table) {
                    $columns = $table === 'buildings' ? 'id, name, sort_order' : '*';
                    $actual = $db->query("SELECT {$columns} FROM {$table} ORDER BY id")->fetchAll(PDO::FETCH_ASSOC);
                    $expected = $expectedHierarchy[$table];
                    usort($expected, static fn(array $a, array $b): int => $a['id'] <=> $b['id']);
                    if ($actual != $expected) { throw new RuntimeException('Unexpected hierarchy conversion: ' . $table); }
                }
                foreach (['views', 'devices'] as $table) {
                    $actual = $db->query("SELECT id, floor_id FROM {$table} ORDER BY id")->fetchAll(PDO::FETCH_KEY_PAIR);
                    if ($actual !== array_column($expectedHierarchy[$table], 'floor_id', 'id')) {
                        throw new RuntimeException('Unexpected membership conversion: ' . $table);
                    }
                }
            }
            if ($migratesLinks) {
                if ($db->query('SELECT 1 FROM views WHERE show_connections IS NOT 1 LIMIT 1')->fetchColumn() !== false) {
                    throw new RuntimeException('Migration did not enable connections in all existing views');
                }
                $backup = new \Netarium\Services\Backup\BackupService($db);
                $actual = ['links' => $db->query('SELECT id, from_id, to_id, system_id, label, memo, from_port_id, to_port_id'
                    . ($migratesVlans ? '' : ', vlan') . ' FROM links ORDER BY id')->fetchAll(PDO::FETCH_ASSOC)]
                    + $backup->fetchBackupConnectionTables();
                foreach (['device_ports', 'links', 'view_link_routes', 'legacy_link_conflicts'] as $table) {
                    $expected = $expectedConnections[$table];
                    if ($migratesVlans && $table === 'links') {
                        foreach ($expected as &$row) { unset($row['vlan']); }
                        unset($row);
                    }
                    usort($expected, static fn(array $a, array $b): int => match ($table) {
                        'view_link_routes' => [$a['view_id'], $a['device_a_id'], $a['device_b_id']]
                            <=> [$b['view_id'], $b['device_a_id'], $b['device_b_id']],
                        'legacy_link_conflicts' => $a['legacy_link_id'] <=> $b['legacy_link_id'],
                        default => $a['id'] <=> $b['id'],
                    });
                    if ($table === 'device_ports') {
                        foreach ($actual[$table] as &$row) { unset($row['resource_revision'], $row['vlan']); }
                        unset($row);
                    }
                    $normalize = static function (array $row): array { ksort($row); return $row; };
                    if (json_encode(array_map($normalize, $actual[$table]), JSON_THROW_ON_ERROR)
                        !== json_encode(array_map($normalize, $expected), JSON_THROW_ON_ERROR)) {
                        throw new RuntimeException('Unexpected connection conversion: ' . $table);
                    }
                }
                $linkCounts = json_decode((string)$db->query("SELECT meta_value FROM app_meta
                    WHERE meta_key = 'legacy_link_migration'")->fetchColumn(), true, 512, JSON_THROW_ON_ERROR);
                if ($linkCounts !== $expectedConnections['counts'] || $linkCounts['total'] !== $counts['links']
                    || $linkCounts['total'] !== $linkCounts['converted'] + $linkCounts['held']
                    || $linkCounts['held'] !== count($actual['legacy_link_conflicts'])) {
                    throw new RuntimeException('Migration did not account for all source links');
                }
                if (!$migratesHierarchy) {
                    foreach ($db->query('SELECT id, resource_revision FROM views') as $row) {
                        if (isset($routeOwners[$row['id']]) ? $row['resource_revision'] <= $viewRevisions[$row['id']]
                            : $row['resource_revision'] !== $viewRevisions[$row['id']]) {
                            throw new RuntimeException('Unexpected migration change to view revisions');
                        }
                    }
                    $revision = (int)$db->query("SELECT value FROM resource_sequences WHERE name = 'revision'")->fetchColumn();
                    if ($revision !== $previousRevision + count($actual['links']) + count($actual['device_ports']) + count($actual['view_link_routes'])) {
                        throw new RuntimeException('Unexpected migration change to the revision sequence');
                    }
                }
            }
            if ($migratesVlans && ($db->query('SELECT * FROM legacy_link_vlans ORDER BY link_id')->fetchAll(PDO::FETCH_ASSOC) !== $expectedVlans
                || $db->query("SELECT 1 FROM device_ports WHERE vlan IS NOT '' LIMIT 1")->fetchColumn() !== false)) {
                throw new RuntimeException('Unexpected legacy VLAN conversion');
            }
            if ($sourceSchemaVersion < 29 && APP_DATABASE_SCHEMA_VERSION >= 29
                && $db->query('SELECT 1 FROM quality_not_applicable LIMIT 1')->fetchColumn() !== false) {
                throw new RuntimeException('Migration invented quality not applicable rows');
            }
            foreach ($before as $table => $source) {
                if ($migratesHierarchy && in_array($table, ['buildings', 'floors'], true)) { continue; }
                if (fullTableFingerprint($db, $table, $source['columns'], $sourceSchemaVersion) !== $source['fingerprint']) {
                    throw new RuntimeException('Migration changed existing data: ' . $table);
                }
            }
            $db = null;
            // Revalidate the resulting contract and image references, not the
            // old manifest hash/counts: those describe the unmodified source.
            fullDatabase($file, $root);
        }
        // All source hashes/counts and migration-preservation checks must pass
        // before retention changes this isolated restore DB. Never prune the
        // live source or the archived snapshot during backup creation.
        if (APP_DATABASE_SCHEMA_VERSION >= 19) {
            $db = new PDO('sqlite:' . $file, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
            $pruned = (new \Netarium\Services\Topology\ChangeHistoryService($db))->pruneExpired();
            $db = null;
            if ($pruned > 0) {
                // Manifest hashes/counts describe the original archive, not this
                // retention-adjusted payload. Recheck the current DB contract.
                fullDatabase($file, $root);
            }
        }
        if (APP_DATABASE_SCHEMA_VERSION >= 21) {
            $db = new PDO('sqlite:' . $file, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
            $db->beginTransaction();
            try {
                (new \Netarium\Services\Monitoring\PingReachabilityMonitor($db))->reconcile([]);
                $db->commit();
            } catch (Throwable $e) {
                if ($db->inTransaction()) { $db->rollBack(); }
                throw $e;
            }
            $db = null;
        }
        return $m;
    } finally { $zip->close(); }
}

if (!defined('NETARIUM_FULL_BACKUP_HELPER_NO_LOOP')) {
$config = \Netarium\Core\Config::create();
$gate = new \Netarium\Core\OperationGate((string)$config['operation_lock_file']);
while (($line = fgets(STDIN)) !== false) {
    $trimmed = trim($line);
    if (str_starts_with($trimmed, "\xEF\xBB\xBF")) {
        $trimmed = substr($trimmed, 3);
    }
    if ($trimmed === '') { continue; }
    try {
        $r = json_decode($trimmed, true, 512, JSON_THROW_ON_ERROR);
        $result = null;
        switch ($r['command']) {
            case 'config': $result = $config; break;
            case 'exit': exit(0);
            case 'lock': $gate->acquireExclusive(); break;
            case 'unlock': $gate->release(); break;
            case 'checkpoint':
                if (is_file($config['db_file'])) {
                    $db = new PDO('sqlite:' . $config['db_file'], null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
                    $db->exec('PRAGMA busy_timeout=0');
                    $check = $db->query('PRAGMA wal_checkpoint(TRUNCATE)')->fetch(PDO::FETCH_NUM);
                    if ((int)$check[0] !== 0 || $db->query('PRAGMA integrity_check')->fetchAll(PDO::FETCH_COLUMN) !== ['ok']) {
                        throw new RuntimeException('Live database checkpoint/integrity failure');
                    }
                    $db = null;
                }
                break;
            case 'snapshot':
                // VACUUM INTO uses SQLite's pager and includes committed WAL data.
                $db = new PDO('sqlite:' . $config['db_file'], null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
                $db->exec('PRAGMA busy_timeout=0');
                $db->exec('VACUUM INTO ' . $db->quote($r['destination']));
                $db = null;
                break;
            case 'prepare':
                $file = $r['root'] . '/db/data.sqlite';
                if (realpath($file) === realpath($config['db_file'])) { throw new RuntimeException('Cannot prepare live database'); }
                $result = fullDatabase($file, $r['root'], true);
                break;
            case 'validate': $result = fullDatabase($r['root'] . '/db/data.sqlite', $r['root']); break;
            case 'pack':
                $files = fullInventory($r['root']);
                $manifest = ['format' => 'netarium-full', 'format_version' => 1, 'created_at' => gmdate(DATE_ATOM),
                    'application_version' => NETARIUM_VERSION, 'schema_version' => APP_DATABASE_SCHEMA_VERSION,
                    'logical_paths' => ['db' => 'db/data.sqlite', 'floor_plan_directory' => 'floorplans', 'device_image_directory' => 'device_images'],
                    'file_count' => count($files), 'total_bytes' => array_sum(array_column($files, 'bytes')),
                    'counts' => fullDatabase($r['root'] . '/db/data.sqlite', $r['root']), 'files' => $files];
                $zip = new ZipArchive();
                if ($zip->open($r['destination'], ZipArchive::CREATE | ZipArchive::EXCL) !== true) { throw new RuntimeException('Cannot create ZIP'); }
                try {
                    if (!$zip->addFromString('manifest.json', json_encode($manifest, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES))) { throw new RuntimeException('Manifest write failure'); }
                    foreach ($files as $name => $metadata) {
                        if (!$zip->addFile($r['root'] . '/' . $name, $name)) { throw new RuntimeException('ZIP add failure'); }
                    }
                } catch (Throwable $e) { $zip->close(); throw $e; }
                if (!$zip->close()) { throw new RuntimeException('ZIP close failure'); }
                $result = $manifest;
                break;
            case 'extract': $result = fullExtract($r['archive'], $r['root'], $r['max_bytes'], $r['max_files']); break;
            default: throw new RuntimeException('Unknown command');
        }
        echo json_encode(['ok' => true, 'result' => $result], JSON_THROW_ON_ERROR | JSON_INVALID_UTF8_SUBSTITUTE) . "\n";
    } catch (Throwable $e) {
        echo json_encode(['ok' => false, 'error' => $e->getMessage()], JSON_THROW_ON_ERROR | JSON_INVALID_UTF8_SUBSTITUTE) . "\n";
    }
    flush();
}
}
