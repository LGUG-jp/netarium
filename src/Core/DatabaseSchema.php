<?php
declare(strict_types=1);

const APP_DATABASE_SCHEMA_VERSION = 29;


function migrateDatabase(PDO $db): void
{
    $currentVersion = (int)$db
        ->query('PRAGMA user_version')
        ->fetchColumn();

    if (
        $currentVersion >
        APP_DATABASE_SCHEMA_VERSION
    ) {
        throw new RuntimeException(
            'データベースのバージョンがプログラムより新しいため起動できません'
        );
    }

    while (
        $currentVersion <
        APP_DATABASE_SCHEMA_VERSION
    ) {
        $nextVersion =
            $currentVersion + 1;

        switch ($nextVersion) {
            case 1:
                migrateDatabaseToVersion1(
                    $db
                );
                break;

            case 2:
                migrateDatabaseToVersion2(
                    $db
                );
                break;

            case 3:
                migrateDatabaseToVersion3(
                    $db
                );
                break;

            case 4:
                migrateDatabaseToVersion4(
                    $db
                );
                break;
            case 5:
                migrateDatabaseToVersion5(
                    $db
                );
                break;
            case 6:
                migrateDatabaseToVersion6($db);
                break;
            case 7:
                migrateDatabaseToVersion7($db);
                break;
            case 8:
                migrateDatabaseToVersion8($db);
                break;
            case 9:
                migrateDatabaseToVersion9($db);
                break;
            case 10:
                migrateDatabaseToVersion10($db);
                break;
            case 11:
                migrateDatabaseToVersion11($db);
                break;
            case 12:
                migrateDatabaseToVersion12($db);
                break;
            case 13:
                migrateDatabaseToVersion13($db);
                break;
            case 14:
                migrateDatabaseToVersion14($db);
                break;
            case 15:
                migrateDatabaseToVersion15($db);
                break;
            case 16:
                migrateDatabaseToVersion16($db);
                break;
            case 17:
                migrateDatabaseToVersion17($db);
                break;
            case 18:
                migrateDatabaseToVersion18($db);
                break;
            case 19:
                migrateDatabaseToVersion19($db);
                break;
            case 20:
                migrateDatabaseToVersion20($db);
                break;
            case 21:
                migrateDatabaseToVersion21($db);
                break;
            case 22:
                migrateDatabaseToVersion22($db);
                break;
            case 23:
                migrateDatabaseToVersion23($db);
                break;
            case 24:
                migrateDatabaseToVersion24($db);
                break;
            case 25:
                migrateDatabaseToVersion25($db);
                break;
            case 26:
                migrateDatabaseToVersion26($db);
                break;
            case 27:
                migrateDatabaseToVersion27($db);
                break;
            case 28:
                migrateDatabaseToVersion28($db);
                break;
            case 29:
                migrateDatabaseToVersion29($db);
                break;

            default:
                throw new RuntimeException(
                    "データベース更新処理がありません: バージョン{$nextVersion}"
                );
        }

        $currentVersion =
            $nextVersion;
    }
}

function migrateDatabaseToVersion1(
    PDO $db
): void {
    $db->beginTransaction();

    try {
        $db->exec("
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY
                    AUTOINCREMENT,

                username TEXT NOT NULL
                    UNIQUE COLLATE NOCASE,

                password_hash TEXT NOT NULL,

                role TEXT NOT NULL
                    DEFAULT 'admin'
                    CHECK (
                        role IN (
                            'admin',
                            'viewer'
                        )
                    ),

                is_active INTEGER NOT NULL
                    DEFAULT 1
                    CHECK (
                        is_active IN (0, 1)
                    ),

                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                last_login_at TEXT
            )
        ");

        $db->exec("
            CREATE TABLE IF NOT EXISTS app_meta (
                meta_key TEXT PRIMARY KEY,
                meta_value TEXT NOT NULL
            )
        ");

        $db->exec("
            CREATE TABLE IF NOT EXISTS views (
                id INTEGER PRIMARY KEY,

                name TEXT NOT NULL
                    COLLATE NOCASE,

                facility TEXT NOT NULL
                    DEFAULT '',

                floor TEXT NOT NULL
                    DEFAULT '',

                view_type TEXT NOT NULL
                    DEFAULT 'topology'
                    CHECK (
                        view_type IN (
                            'topology',
                            'floor'
                        )
                    ),

                sort_order INTEGER NOT NULL
                    DEFAULT 0,

                memo TEXT NOT NULL
                    DEFAULT ''
            )
        ");

        $db->exec("
            CREATE TABLE IF NOT EXISTS devices (
                id INTEGER PRIMARY KEY,

                name TEXT NOT NULL,

                type TEXT NOT NULL
                    DEFAULT 'other'
                    CHECK (
                        type IN (
                            'switch',
                            'l3_switch',
                            'router',
                            'firewall',
                            'ap',
                            'server',
                            'printer',
                            'other'
                        )
                    ),

                ip TEXT NOT NULL
                    DEFAULT '',

                x REAL NOT NULL
                    DEFAULT 0
                    CHECK (x >= 0),

                y REAL NOT NULL
                    DEFAULT 0
                    CHECK (y >= 0),

                facility TEXT NOT NULL
                    DEFAULT '',

                floor TEXT NOT NULL
                    DEFAULT '',

                location TEXT NOT NULL
                    DEFAULT '',

                manufacturer TEXT NOT NULL
                    DEFAULT '',

                model TEXT NOT NULL
                    DEFAULT '',

                asset_number TEXT NOT NULL
                    DEFAULT '',

                serial_number TEXT NOT NULL
                    DEFAULT '',

                mac_address TEXT NOT NULL
                    DEFAULT '',

                memo TEXT NOT NULL
                    DEFAULT ''
            )
        ");

        $db->exec("
            CREATE TABLE IF NOT EXISTS
                device_monitor_status (
                    device_id INTEGER
                        PRIMARY KEY,

                    status TEXT NOT NULL
                        DEFAULT 'unknown'
                        CHECK (
                            status IN (
                                'unknown',
                                'green',
                                'red'
                            )
                        ),

                    last_checked_at TEXT,

                    last_response_ms INTEGER
                        CHECK (
                            last_response_ms
                                IS NULL
                            OR last_response_ms >= 0
                        ),

                    last_error TEXT,

                    FOREIGN KEY (device_id)
                        REFERENCES devices(id)
                        ON DELETE CASCADE
                )
        ");

        $db->exec("
            CREATE TABLE IF NOT EXISTS
                device_placements (
                    id INTEGER PRIMARY KEY,

                    device_id INTEGER NOT NULL,
                    view_id INTEGER NOT NULL,

                    x REAL NOT NULL
                        DEFAULT 0
                        CHECK (x >= 0),

                    y REAL NOT NULL
                        DEFAULT 0
                        CHECK (y >= 0),

                    UNIQUE (
                        device_id,
                        view_id
                    ),

                    FOREIGN KEY (device_id)
                        REFERENCES devices(id)
                        ON DELETE CASCADE,

                    FOREIGN KEY (view_id)
                        REFERENCES views(id)
                        ON DELETE CASCADE
                )
        ");

        $db->exec("
            CREATE TABLE IF NOT EXISTS links (
                id INTEGER PRIMARY KEY,

                view_id INTEGER NOT NULL,
                from_id INTEGER NOT NULL,
                to_id INTEGER NOT NULL,

                label TEXT NOT NULL
                    DEFAULT '',

                from_port TEXT NOT NULL
                    DEFAULT '',

                to_port TEXT NOT NULL
                    DEFAULT '',

                vlan TEXT NOT NULL
                    DEFAULT '',

                memo TEXT NOT NULL
                    DEFAULT '',

                CHECK (
                    from_id <> to_id
                ),

                FOREIGN KEY (view_id)
                    REFERENCES views(id)
                    ON DELETE CASCADE,

                FOREIGN KEY (from_id)
                    REFERENCES devices(id)
                    ON DELETE CASCADE,

                FOREIGN KEY (to_id)
                    REFERENCES devices(id)
                    ON DELETE CASCADE
            )
        ");

        $db->exec("
            CREATE UNIQUE INDEX IF NOT EXISTS
                idx_views_name_unique
            ON views(name)
        ");

        $db->exec("
            CREATE INDEX IF NOT EXISTS
                idx_views_sort_order
            ON views(sort_order, id)
        ");

        $db->exec("
            CREATE INDEX IF NOT EXISTS
                idx_placements_view
            ON device_placements(
                view_id,
                id
            )
        ");

        $db->exec("
            CREATE INDEX IF NOT EXISTS
                idx_placements_device
            ON device_placements(
                device_id,
                id
            )
        ");

        $db->exec("
            CREATE INDEX IF NOT EXISTS
                idx_links_view
            ON links(view_id, id)
        ");

        $db->exec("
            CREATE INDEX IF NOT EXISTS
                idx_links_from_device
            ON links(from_id)
        ");

        $db->exec("
            CREATE INDEX IF NOT EXISTS
                idx_links_to_device
            ON links(to_id)
        ");

        $metaStmt = $db->prepare("
            INSERT OR IGNORE INTO app_meta (
                meta_key,
                meta_value
            ) VALUES (
                :meta_key,
                :meta_value
            )
        ");

        $initialMeta = [
            'data_revision' => '1',
            'monitor_revision' => '1',
            'last_saved_at' => '',
            'last_monitored_at' => '',
        ];

        foreach (
            $initialMeta as $key => $value
        ) {
            $metaStmt->execute([
                ':meta_key' => $key,
                ':meta_value' => $value,
            ]);
        }

        $db->exec(
            'PRAGMA user_version = 1'
        );

        $db->commit();
    } catch (Throwable $e) {
        if ($db->inTransaction()) {
            $db->rollBack();
        }

        error_log(
            '[DB Migration v1] '
            . get_class($e)
            . ': '
            . $e->getMessage()
        );

        throw $e;
    }
}

function migrateDatabaseToVersion2(
    PDO $db
): void {
    $db->beginTransaction();

    try {
        $db->exec("
            CREATE TABLE IF NOT EXISTS
                view_floor_plans (
                    view_id INTEGER PRIMARY KEY,

                    stored_name TEXT NOT NULL,

                    original_name TEXT NOT NULL,

                    mime_type TEXT NOT NULL
                        CHECK (
                            mime_type IN (
                                'image/png',
                                'image/jpeg'
                            )
                        ),

                    file_size INTEGER NOT NULL
                        CHECK (
                            file_size > 0
                        ),

                    image_width INTEGER NOT NULL
                        CHECK (
                            image_width > 0
                        ),

                    image_height INTEGER NOT NULL
                        CHECK (
                            image_height > 0
                        ),

                    x REAL NOT NULL
                        DEFAULT 0,

                    y REAL NOT NULL
                        DEFAULT 0,

                    scale REAL NOT NULL
                        DEFAULT 1
                        CHECK (
                            scale >= 0.01
                            AND scale <= 20
                        ),

                    opacity REAL NOT NULL
                        DEFAULT 1
                        CHECK (
                            opacity >= 0
                            AND opacity <= 1
                        ),

                    is_visible INTEGER NOT NULL
                        DEFAULT 1
                        CHECK (
                            is_visible IN (
                                0,
                                1
                            )
                        ),

                    revision INTEGER NOT NULL
                        DEFAULT 1
                        CHECK (
                            revision >= 1
                        ),

                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,

                    FOREIGN KEY (view_id)
                        REFERENCES views(id)
                        ON DELETE CASCADE
                )
        ");

        $db->exec(
            'PRAGMA user_version = 2'
        );

        $db->commit();

    } catch (Throwable $e) {
        if ($db->inTransaction()) {
            $db->rollBack();
        }

        error_log(
            '[DB Migration v2] '
            . get_class($e)
            . ': '
            . $e->getMessage()
        );

        throw $e;
    }
}

function migrateDatabaseToVersion3(
    PDO $db
): void {
    $db->beginTransaction();

    try {
        $db->exec("
            ALTER TABLE users
            ADD COLUMN auth_revision INTEGER NOT NULL DEFAULT 1
        ");

        $db->exec("
            ALTER TABLE users
            ADD COLUMN password_changed_at TEXT
        ");

        $db->exec("
            CREATE TABLE IF NOT EXISTS login_rate_limits (
                username TEXT PRIMARY KEY COLLATE NOCASE,
                failure_count INTEGER NOT NULL DEFAULT 0,
                locked_until INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL
            )
        ");

        $db->exec(
            'PRAGMA user_version = 3'
        );

        $db->commit();

    } catch (Throwable $e) {
        if ($db->inTransaction()) {
            $db->rollBack();
        }

        error_log(
            '[DB Migration v3] '
            . get_class($e)
            . ': '
            . $e->getMessage()
        );

        throw $e;
    }
}

function migrateDatabaseToVersion4(
    PDO $db
): void {
    $db->beginTransaction();

    try {
        $db->exec("
            ALTER TABLE users
            ADD COLUMN password_revision INTEGER NOT NULL DEFAULT 1
        ");

        $db->exec(
            'PRAGMA user_version = 4'
        );

        $db->commit();

    } catch (Throwable $e) {
        if ($db->inTransaction()) {
            $db->rollBack();
        }

        error_log(
            '[DB Migration v4] '
            . get_class($e)
            . ': '
            . $e->getMessage()
        );

        throw $e;
    }
}

function migrateDatabaseToVersion5(
    PDO $db
): void {
    $db->beginTransaction();

    try {
        $db->exec("
            ALTER TABLE devices
            ADD COLUMN management_scheme TEXT NOT NULL DEFAULT '' CHECK (management_scheme IN ('','http','https','ssh'))
        ");

        $db->exec("
            ALTER TABLE devices
            ADD COLUMN management_port INTEGER DEFAULT NULL CHECK (management_port IS NULL OR (management_scheme <> '' AND management_port BETWEEN 1 AND 65535))
        ");

        $db->exec("
            ALTER TABLE devices
            ADD COLUMN department TEXT NOT NULL DEFAULT ''
        ");

        $db->exec("
            ALTER TABLE devices
            ADD COLUMN maintenance_vendor TEXT NOT NULL DEFAULT ''
        ");

        $db->exec("
            ALTER TABLE devices
            ADD COLUMN install_date TEXT NOT NULL DEFAULT ''
        ");

        $db->exec("
            ALTER TABLE devices
            ADD COLUMN maintenance_expiry TEXT NOT NULL DEFAULT ''
        ");

        $db->exec("
            CREATE TABLE IF NOT EXISTS device_images (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                device_id INTEGER NOT NULL,
                stored_name TEXT NOT NULL UNIQUE,
                mime_type TEXT NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg')),
                file_size INTEGER NOT NULL CHECK (file_size > 0),
                image_width INTEGER NOT NULL CHECK (image_width > 0),
                image_height INTEGER NOT NULL CHECK (image_height > 0),
                caption TEXT NOT NULL DEFAULT '',
                sort_order INTEGER NOT NULL CHECK (sort_order BETWEEN 1 AND 3),
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY (device_id)
                    REFERENCES devices(id)
                    ON DELETE CASCADE
            )
        ");

        $db->exec("
            CREATE INDEX IF NOT EXISTS idx_device_images_device_sort
            ON device_images(device_id, sort_order)
        ");

        $db->exec("
            CREATE TABLE IF NOT EXISTS device_image_gc (
                stored_name TEXT PRIMARY KEY,
                queued_at TEXT NOT NULL
            )
        ");

        $db->exec(
            'PRAGMA user_version = 5'
        );

        $db->commit();

    } catch (Throwable $e) {
        if ($db->inTransaction()) {
            $db->rollBack();
        }

        error_log(
            '[DB Migration v5] '
            . get_class($e)
            . ': '
            . $e->getMessage()
        );

        throw $e;
    }
}

function migrateDatabaseToVersion6(PDO $db): void
{
    $db->beginTransaction();
    try {
        $db->exec("UPDATE app_meta SET meta_value = meta_value WHERE meta_key = 'data_revision'");
        // Another process may have completed this migration while we waited for the writer.
        if ((int)$db->query('PRAGMA user_version')->fetchColumn() >= 6) {
            $db->commit();
            return;
        }
        $db->exec('ALTER TABLE devices ADD COLUMN resource_revision INTEGER NOT NULL DEFAULT 1');
        $db->exec('ALTER TABLE views ADD COLUMN resource_revision INTEGER NOT NULL DEFAULT 1');
        // These counters are deliberately not restored from a backup.
        $db->exec("CREATE TABLE resource_sequences (name TEXT PRIMARY KEY, value INTEGER NOT NULL CHECK (typeof(value) = 'integer' AND value >= 0))");
        $db->exec("INSERT INTO resource_sequences (name, value) VALUES ('revision', 1)");
        foreach (['devices' => 'devices', 'views' => 'views', 'placements' => 'device_placements', 'links' => 'links'] as $name => $table) {
            $db->exec("INSERT INTO resource_sequences (name, value) SELECT '{$name}', COALESCE(MAX(id), 0) FROM {$table}");
            $db->exec("CREATE TRIGGER resource_id_{$name} AFTER INSERT ON {$table} BEGIN
                UPDATE resource_sequences SET value = MAX(value, NEW.id) WHERE name = '{$name}';
            END");
        }
        foreach (['devices', 'views'] as $table) {
            $columns = $db->query("PRAGMA table_info({$table})")->fetchAll(PDO::FETCH_ASSOC);
            $fields = array_column($columns, 'name');
            $fields = array_values(array_diff($fields, ['id', 'resource_revision']));
            $changes = implode(' OR ', array_map(static fn(string $field): string => "OLD.{$field} IS NOT NEW.{$field}", $fields));
            $db->exec("CREATE TRIGGER resource_revision_{$table}_insert AFTER INSERT ON {$table} BEGIN
                UPDATE resource_sequences SET value = value + 1 WHERE name = 'revision';
                UPDATE {$table} SET resource_revision = (SELECT value FROM resource_sequences WHERE name = 'revision') WHERE id = NEW.id;
            END");
            $db->exec("CREATE TRIGGER resource_revision_{$table}_update AFTER UPDATE OF " . implode(', ', $fields) . " ON {$table}
                WHEN {$changes} BEGIN
                UPDATE resource_sequences SET value = value + 1 WHERE name = 'revision';
                UPDATE {$table} SET resource_revision = (SELECT value FROM resource_sequences WHERE name = 'revision') WHERE id = NEW.id;
            END");
        }
        foreach ([
            'device_placements' => ['views', 'view_id'],
            'links' => ['views', 'view_id'],
            'view_floor_plans' => ['views', 'view_id'],
            'device_images' => ['devices', 'device_id'],
        ] as $table => [$owner, $foreignKey]) {
            foreach (['INSERT', 'UPDATE', 'DELETE'] as $event) {
                $references = $event === 'INSERT' ? ["NEW.{$foreignKey}"] : ($event === 'DELETE' ? ["OLD.{$foreignKey}"] : ["OLD.{$foreignKey}", "NEW.{$foreignKey}"]);
                $db->exec("CREATE TRIGGER resource_owner_{$table}_" . strtolower($event) . " AFTER {$event} ON {$table} BEGIN
                    UPDATE resource_sequences SET value = value + 1 WHERE name = 'revision';
                    UPDATE {$owner} SET resource_revision = (SELECT value FROM resource_sequences WHERE name = 'revision')
                    WHERE id IN (" . implode(', ', $references) . ");
                END");
            }
        }
        $db->exec('PRAGMA user_version = 6');
        $db->commit();
    } catch (Throwable $e) {
        if ($db->inTransaction()) {
            $db->rollBack();
        }
        throw $e;
    }
}

function migrateDatabaseToVersion7(PDO $db): void
{
    $db->beginTransaction();
    try {
        // writer取得後に再確認し、同時起動による二重ALTERを防ぐ。
        $db->exec("UPDATE app_meta SET meta_value = meta_value WHERE meta_key = 'data_revision'");
        if ((int)$db->query('PRAGMA user_version')->fetchColumn() >= 7) {
            $db->commit();
            return;
        }
        $db->exec("ALTER TABLE links ADD COLUMN route_mode TEXT NOT NULL DEFAULT 'auto'
            CHECK (route_mode IN ('auto', 'manual'))");
        // 8点はschema 7の固定契約。上限変更には新しいmigrationを用意する。
        $db->exec("ALTER TABLE links ADD COLUMN manual_route TEXT NOT NULL DEFAULT '[]'
            CHECK (json_valid(manual_route) AND json_type(manual_route) = 'array'
                AND json_array_length(manual_route) <= 8
                AND (route_mode = 'manual' OR json_array_length(manual_route) = 0))");
        // resource_owner_links_updateは全列UPDATEを対象とし、新列も既存のview世代へ統合される。
        $db->exec('PRAGMA user_version = 7');
        $db->commit();
    } catch (Throwable $e) {
        if ($db->inTransaction()) {
            $db->rollBack();
        }
        throw $e;
    }
}

function migrateDatabaseToVersion8(PDO $db): void
{
    $db->beginTransaction();
    try {
        $db->exec("UPDATE app_meta SET meta_value = meta_value WHERE meta_key = 'data_revision'");
        if ((int)$db->query('PRAGMA user_version')->fetchColumn() >= 8) {
            $db->commit();
            return;
        }
        $db->exec("CREATE TABLE canvas_notes (
            id INTEGER PRIMARY KEY CHECK (id > 0),
            view_id INTEGER NOT NULL,
            text TEXT NOT NULL DEFAULT '' CHECK (length(text) <= 1000),
            x REAL NOT NULL DEFAULT 0 CHECK (x >= 0 AND x <= 1.7976931348623157e308),
            y REAL NOT NULL DEFAULT 0 CHECK (y >= 0 AND y <= 1.7976931348623157e308),
            width REAL NOT NULL DEFAULT 220 CHECK (width BETWEEN 120 AND 2000),
            height REAL NOT NULL DEFAULT 120 CHECK (height BETWEEN 60 AND 2000),
            background_color TEXT NOT NULL DEFAULT '#FFF3B0'
                CHECK (length(background_color) = 7 AND substr(background_color, 1, 1) = '#'
                    AND substr(background_color, 2) NOT GLOB '*[^0-9A-F]*'),
            background_opacity REAL NOT NULL DEFAULT 0.85 CHECK (background_opacity BETWEEN 0.2 AND 1),
            text_color TEXT NOT NULL DEFAULT '#263238'
                CHECK (length(text_color) = 7 AND substr(text_color, 1, 1) = '#'
                    AND substr(text_color, 2) NOT GLOB '*[^0-9A-F]*'),
            font_size REAL NOT NULL DEFAULT 14 CHECK (font_size BETWEEN 12 AND 32),
            FOREIGN KEY (view_id) REFERENCES views(id) ON DELETE CASCADE
        )");
        $db->exec('CREATE INDEX idx_canvas_notes_view ON canvas_notes(view_id)');
        $db->exec("INSERT INTO resource_sequences (name, value) VALUES ('canvas_notes', 0)");
        $db->exec("CREATE TRIGGER resource_id_canvas_notes AFTER INSERT ON canvas_notes BEGIN
            UPDATE resource_sequences SET value = MAX(value, NEW.id) WHERE name = 'canvas_notes';
        END");
        foreach (['INSERT', 'UPDATE', 'DELETE'] as $event) {
            $references = $event === 'INSERT' ? ['NEW.view_id'] : ($event === 'DELETE' ? ['OLD.view_id'] : ['OLD.view_id', 'NEW.view_id']);
            $db->exec("CREATE TRIGGER resource_owner_canvas_notes_" . strtolower($event) . " AFTER {$event} ON canvas_notes BEGIN
                UPDATE resource_sequences SET value = value + 1 WHERE name = 'revision';
                UPDATE views SET resource_revision = (SELECT value FROM resource_sequences WHERE name = 'revision')
                WHERE id IN (" . implode(', ', $references) . ");
            END");
        }
        $db->exec('PRAGMA user_version = 8');
        $db->commit();
    } catch (Throwable $e) {
        if ($db->inTransaction()) {
            $db->rollBack();
        }
        throw $e;
    }
}

function migrateDatabaseToVersion9(PDO $db): void
{
    $db->beginTransaction();
    try {
        $db->exec("UPDATE app_meta SET meta_value = meta_value WHERE meta_key = 'data_revision'");
        if ((int)$db->query('PRAGMA user_version')->fetchColumn() >= 9) {
            $db->commit();
            return;
        }
        $db->exec("CREATE TABLE link_systems (
            id INTEGER PRIMARY KEY CHECK (id > 0),
            name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
            color_key TEXT NOT NULL CHECK (color_key IN ('indigo','teal','violet','cyan','slate','brown','magenta','olive')),
            resource_revision INTEGER NOT NULL DEFAULT 1 CHECK (resource_revision > 0)
        )");
        $db->exec("INSERT INTO resource_sequences (name, value) VALUES ('link_systems', 0)");
        $db->exec("CREATE TRIGGER resource_id_link_systems AFTER INSERT ON link_systems BEGIN
            UPDATE resource_sequences SET value = MAX(value, NEW.id) WHERE name = 'link_systems';
        END");
        $db->exec("CREATE TRIGGER resource_revision_link_systems_insert AFTER INSERT ON link_systems BEGIN
            UPDATE resource_sequences SET value = value + 1 WHERE name = 'revision';
            UPDATE link_systems SET resource_revision = (SELECT value FROM resource_sequences WHERE name = 'revision') WHERE id = NEW.id;
        END");
        $db->exec("CREATE TRIGGER resource_revision_link_systems_update AFTER UPDATE OF name, color_key ON link_systems
            WHEN OLD.name IS NOT NEW.name OR OLD.color_key IS NOT NEW.color_key BEGIN
            UPDATE resource_sequences SET value = value + 1 WHERE name = 'revision';
            UPDATE link_systems SET resource_revision = (SELECT value FROM resource_sequences WHERE name = 'revision') WHERE id = NEW.id;
        END");
        $db->exec('ALTER TABLE links ADD COLUMN system_id INTEGER DEFAULT NULL
            CHECK (system_id IS NULL OR (typeof(system_id) = \'integer\' AND system_id > 0))
            REFERENCES link_systems(id) ON DELETE RESTRICT');
        $db->exec('CREATE INDEX idx_links_system ON links(system_id)');
        $db->exec('PRAGMA user_version = 9');
        $db->commit();
    } catch (Throwable $e) {
        if ($db->inTransaction()) {
            $db->rollBack();
        }
        throw $e;
    }
}


function migrateDatabaseToVersion10(PDO $db): void
{
    $db->beginTransaction();
    try {
        // 先行workerが移行済みでも、writer取得後の状態で判断する。
        $db->exec("UPDATE app_meta SET meta_value = meta_value WHERE meta_key = 'data_revision'");
        if ((int)$db->query('PRAGMA user_version')->fetchColumn() >= 10) {
            $db->commit();
            return;
        }
        // 既存利用者には遡及しない。新規発行・再設定のみ明示的に1を保存する。
        $db->exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1))');
        $db->exec('CREATE TABLE reauthentication_limits (
            user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            failure_count INTEGER NOT NULL DEFAULT 0,
            locked_until INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL
        )');
        $db->exec('CREATE TABLE password_spray_failures (
            source_digest TEXT NOT NULL,
            subject_digest TEXT NOT NULL,
            failed_at INTEGER NOT NULL,
            PRIMARY KEY (source_digest, subject_digest)
        )');
        $db->exec('CREATE INDEX idx_password_spray_failures_time ON password_spray_failures(failed_at)');
        $db->exec('CREATE TABLE password_spray_warnings (source_digest TEXT PRIMARY KEY, warned_at INTEGER NOT NULL)');
        $db->exec('CREATE INDEX idx_password_spray_warnings_time ON password_spray_warnings(warned_at)');
        $db->exec('PRAGMA user_version = 10');
        $db->commit();
    } catch (Throwable $e) {
        if ($db->inTransaction()) {
            $db->rollBack();
        }
        throw $e;
    }
}

function migrateDatabaseToVersion11(PDO $db): void
{
    $db->beginTransaction();
    try {
        $db->exec("UPDATE app_meta SET meta_value = meta_value WHERE meta_key = 'data_revision'");
        if ((int)$db->query('PRAGMA user_version')->fetchColumn() >= 11) {
            $db->commit();
            return;
        }
        foreach (['view_floor_plans', 'device_images'] as $table) {
            $db->exec("ALTER TABLE {$table} ADD COLUMN sha256 TEXT NOT NULL DEFAULT ''
                CHECK (sha256 = '' OR (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'))");
        }
        $db->exec('DROP TRIGGER IF EXISTS resource_owner_view_floor_plans_update');
        $db->exec("CREATE TRIGGER resource_owner_view_floor_plans_update AFTER UPDATE ON view_floor_plans
            WHEN OLD.stored_name IS NOT NEW.stored_name
                OR OLD.original_name IS NOT NEW.original_name
                OR OLD.mime_type IS NOT NEW.mime_type
                OR OLD.file_size IS NOT NEW.file_size
                OR OLD.image_width IS NOT NEW.image_width
                OR OLD.image_height IS NOT NEW.image_height
                OR OLD.x IS NOT NEW.x
                OR OLD.y IS NOT NEW.y
                OR OLD.scale IS NOT NEW.scale
                OR OLD.opacity IS NOT NEW.opacity
                OR OLD.is_visible IS NOT NEW.is_visible
                OR OLD.revision IS NOT NEW.revision BEGIN
            UPDATE resource_sequences SET value = value + 1 WHERE name = 'revision';
            UPDATE views SET resource_revision = (SELECT value FROM resource_sequences WHERE name = 'revision')
            WHERE id IN (OLD.view_id, NEW.view_id);
        END");
        $db->exec('DROP TRIGGER IF EXISTS resource_owner_device_images_update');
        $db->exec("CREATE TRIGGER resource_owner_device_images_update AFTER UPDATE ON device_images
            WHEN OLD.device_id IS NOT NEW.device_id
                OR OLD.stored_name IS NOT NEW.stored_name
                OR OLD.mime_type IS NOT NEW.mime_type
                OR OLD.file_size IS NOT NEW.file_size
                OR OLD.image_width IS NOT NEW.image_width
                OR OLD.image_height IS NOT NEW.image_height
                OR OLD.caption IS NOT NEW.caption
                OR OLD.sort_order IS NOT NEW.sort_order BEGIN
            UPDATE resource_sequences SET value = value + 1 WHERE name = 'revision';
            UPDATE devices SET resource_revision = (SELECT value FROM resource_sequences WHERE name = 'revision')
            WHERE id IN (OLD.device_id, NEW.device_id);
        END");
        $db->exec('PRAGMA user_version = 11');
        $db->commit();
    } catch (Throwable $e) {
        if ($db->inTransaction()) {
            $db->rollBack();
        }
        throw $e;
    }
}

function migrateDatabaseToVersion12(PDO $db): void
{
    // SQLite requires foreign_keys OFF outside the transaction while rebuilding a referenced table.
    $foreignKeys = (int)$db->query('PRAGMA foreign_keys')->fetchColumn();
    $db->exec('PRAGMA foreign_keys = OFF');
    $legacyAlter = (int)$db->query('PRAGMA legacy_alter_table')->fetchColumn();
    $db->exec('PRAGMA legacy_alter_table = ON');
    $db->beginTransaction();
    try {
        $db->exec("UPDATE app_meta SET meta_value = meta_value WHERE meta_key = 'data_revision'");
        if ((int)$db->query('PRAGMA user_version')->fetchColumn() < 12) {
            $objects = $db->query("SELECT sql FROM sqlite_master WHERE tbl_name = 'views'
                AND type IN ('index', 'trigger') AND sql IS NOT NULL")->fetchAll(PDO::FETCH_COLUMN);
            $db->exec("CREATE TABLE views_new (
                id INTEGER PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE,
                facility TEXT NOT NULL DEFAULT '', floor TEXT NOT NULL DEFAULT '',
                view_type TEXT NOT NULL DEFAULT 'topology' CHECK (view_type IN ('topology','floor','rack')),
                sort_order INTEGER NOT NULL DEFAULT 0, memo TEXT NOT NULL DEFAULT '',
                resource_revision INTEGER NOT NULL DEFAULT 1
            )");
            $db->exec('INSERT INTO views_new SELECT id,name,facility,floor,view_type,sort_order,memo,resource_revision FROM views');
            $db->exec('DROP TABLE views');
            $db->exec('ALTER TABLE views_new RENAME TO views');
            foreach ($objects as $sql) {
                $db->exec($sql);
            }
            $db->exec("CREATE TABLE rack_settings (
                view_id INTEGER PRIMARY KEY REFERENCES views(id) ON DELETE CASCADE,
                total_u INTEGER NOT NULL CHECK (typeof(total_u) = 'integer' AND total_u BETWEEN 1 AND 60),
                location TEXT NOT NULL DEFAULT '' CHECK (length(location) <= 150)
            )");
            $db->exec("CREATE TABLE rack_mounts (
                device_id INTEGER PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
                view_id INTEGER NOT NULL REFERENCES rack_settings(view_id) ON DELETE CASCADE,
                face TEXT NOT NULL CHECK (face IN ('front','rear','both')),
                start_u INTEGER NOT NULL CHECK (typeof(start_u) = 'integer' AND start_u > 0),
                height_u INTEGER NOT NULL CHECK (typeof(height_u) = 'integer' AND height_u > 0),
                width_slot TEXT NOT NULL CHECK (width_slot IN ('full','left','right')),
                CHECK (face <> 'both' OR width_slot = 'full')
            )");
            $db->exec('CREATE INDEX idx_rack_mounts_view ON rack_mounts(view_id)');
            foreach (['rack_settings', 'rack_mounts'] as $table) {
                foreach (['INSERT', 'UPDATE', 'DELETE'] as $event) {
                    $refs = $event === 'INSERT' ? 'NEW.view_id' : ($event === 'DELETE' ? 'OLD.view_id' : 'OLD.view_id, NEW.view_id');
                    $db->exec("CREATE TRIGGER resource_owner_{$table}_" . strtolower($event) . " AFTER {$event} ON {$table} BEGIN
                        UPDATE resource_sequences SET value = value + 1 WHERE name = 'revision';
                        UPDATE views SET resource_revision = (SELECT value FROM resource_sequences WHERE name = 'revision')
                        WHERE id IN ({$refs});
                    END");
                }
            }
            if ($db->query('PRAGMA foreign_key_check')->fetch() !== false) {
                throw new RuntimeException('ラック移行後の外部キー検証に失敗しました');
            }
            $db->exec('PRAGMA user_version = 12');
        }
        $db->commit();
    } catch (Throwable $e) {
        if ($db->inTransaction()) {
            $db->rollBack();
        }
        throw $e;
    } finally {
        $db->exec('PRAGMA foreign_keys = ' . $foreignKeys);
        $db->exec('PRAGMA legacy_alter_table = ' . $legacyAlter);
    }
}

function migrateDatabaseToVersion13(PDO $db): void
{
    // Rebuild without renaming the original: dependent foreign keys and trigger
    // bodies must continue to reference devices, without firing delete cascades.
    $foreignKeys = (int)$db->query('PRAGMA foreign_keys')->fetchColumn();
    $legacyAlter = (int)$db->query('PRAGMA legacy_alter_table')->fetchColumn();
    $db->exec('PRAGMA foreign_keys = OFF');
    $db->exec('PRAGMA legacy_alter_table = ON');
    try {
        $db->beginTransaction();
        $db->exec("UPDATE app_meta SET meta_value = meta_value WHERE meta_key = 'data_revision'");
        if ((int)$db->query('PRAGMA user_version')->fetchColumn() < 13) {
            $objects = $db->query("SELECT sql FROM sqlite_master WHERE tbl_name = 'devices'
                AND type IN ('index', 'trigger') AND sql IS NOT NULL")->fetchAll(PDO::FETCH_COLUMN);
            $sql = (string)$db->query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'devices'")->fetchColumn();
            $sql = str_replace('CREATE TABLE devices', 'CREATE TABLE devices_new', $sql, $tableCount);
            $sql = str_replace("'printer'", "'pc', 'printer'", $sql, $typeCount);
            if ($tableCount !== 1 || $typeCount !== 1) {
                throw new RuntimeException('機器スキーマの移行元が不正です');
            }
            $db->exec($sql);
            // Copy before restoring triggers so revisions and ID counters stay unchanged.
            $db->exec('INSERT INTO devices_new SELECT * FROM devices');
            $db->exec('DROP TABLE devices');
            $db->exec('ALTER TABLE devices_new RENAME TO devices');
            foreach ($objects as $objectSql) {
                $db->exec($objectSql);
            }
            if ($db->query('PRAGMA foreign_key_check')->fetch() !== false) {
                throw new RuntimeException('PC種別移行後の外部キー検証に失敗しました');
            }
            $db->exec('PRAGMA user_version = 13');
        }
        $db->commit();
    } catch (Throwable $e) {
        if ($db->inTransaction()) {
            $db->rollBack();
        }
        throw $e;
    } finally {
        $db->exec('PRAGMA foreign_keys = ' . $foreignKeys);
        $db->exec('PRAGMA legacy_alter_table = ' . $legacyAlter);
    }
}

function migrateDatabaseToVersion14(PDO $db): void
{
    $db->beginTransaction();
    try {
        $db->exec("UPDATE app_meta SET meta_value = meta_value WHERE meta_key = 'data_revision'");
        // Adding a defaulted column preserves every existing value and revision;
        // historical schema12/13 definitions remain unchanged for ZIP validation.
        if ((int)$db->query('PRAGMA user_version')->fetchColumn() < 14) {
            $db->exec("ALTER TABLE rack_mounts ADD COLUMN depth TEXT NOT NULL DEFAULT 'half' CHECK (depth IN ('half','full'))");
            $db->exec('PRAGMA user_version = 14');
        }
        $db->commit();
    } catch (Throwable $e) {
        if ($db->inTransaction()) {
            $db->rollBack();
        }
        throw $e;
    }
}

function migrateDatabaseToVersion15(PDO $db): void
{
    $db->beginTransaction();
    try {
        $db->exec("UPDATE app_meta SET meta_value = meta_value WHERE meta_key = 'data_revision'");
        if ((int)$db->query('PRAGMA user_version')->fetchColumn() < 15) {
            $db->exec("CREATE TABLE rack_shelves (
                id INTEGER PRIMARY KEY,
                view_id INTEGER NOT NULL REFERENCES rack_settings(view_id) ON DELETE CASCADE,
                name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
                face TEXT NOT NULL CHECK (face IN ('front','rear')),
                start_u INTEGER NOT NULL CHECK (typeof(start_u) = 'integer' AND start_u > 0),
                height_u INTEGER NOT NULL CHECK (typeof(height_u) = 'integer' AND height_u > 0),
                depth TEXT NOT NULL CHECK (depth IN ('half','full'))
            )");
            $db->exec('CREATE INDEX idx_rack_shelves_view ON rack_shelves(view_id)');
            $db->exec("CREATE TABLE rack_shelf_devices (
                device_id INTEGER PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
                shelf_id INTEGER NOT NULL REFERENCES rack_shelves(id) ON DELETE CASCADE,
                sort_order INTEGER NOT NULL CHECK (typeof(sort_order) = 'integer' AND sort_order >= 0)
            )");
            $db->exec('CREATE INDEX idx_rack_shelf_devices_shelf ON rack_shelf_devices(shelf_id)');
            $db->exec("INSERT INTO resource_sequences(name,value) VALUES ('rack_shelves',0)");
            $db->exec("CREATE TRIGGER resource_id_rack_shelves_insert AFTER INSERT ON rack_shelves BEGIN
                UPDATE resource_sequences SET value = MAX(value, NEW.id) WHERE name = 'rack_shelves';
            END");
            foreach (['INSERT', 'UPDATE', 'DELETE'] as $event) {
                $suffix = strtolower($event);
                $refs = $event === 'INSERT' ? 'NEW.view_id' : ($event === 'DELETE' ? 'OLD.view_id' : 'OLD.view_id, NEW.view_id');
                $db->exec("CREATE TRIGGER resource_owner_rack_shelves_{$suffix} AFTER {$event} ON rack_shelves BEGIN
                    UPDATE resource_sequences SET value = value + 1 WHERE name = 'revision';
                    UPDATE views SET resource_revision = (SELECT value FROM resource_sequences WHERE name = 'revision')
                    WHERE id IN ({$refs});
                END");
                $shelfRefs = $event === 'INSERT' ? 'NEW.shelf_id' : ($event === 'DELETE' ? 'OLD.shelf_id' : 'OLD.shelf_id, NEW.shelf_id');
                $db->exec("CREATE TRIGGER resource_owner_rack_shelf_devices_{$suffix} AFTER {$event} ON rack_shelf_devices BEGIN
                    UPDATE resource_sequences SET value = value + 1 WHERE name = 'revision';
                    UPDATE views SET resource_revision = (SELECT value FROM resource_sequences WHERE name = 'revision')
                    WHERE id IN (SELECT view_id FROM rack_shelves WHERE id IN ({$shelfRefs}));
                END");
            }
            $db->exec('PRAGMA user_version = 15');
        }
        $db->commit();
    } catch (Throwable $e) {
        if ($db->inTransaction()) { $db->rollBack(); }
        throw $e;
    }
}

function migrateDatabaseToVersion16(PDO $db): void
{
    $db->beginTransaction();
    try {
        $db->exec("UPDATE app_meta SET meta_value = meta_value WHERE meta_key = 'data_revision'");
        if ((int)$db->query('PRAGMA user_version')->fetchColumn() < 16) {
            $db->exec("CREATE TABLE floor_rack_placements (
                floor_view_id INTEGER NOT NULL REFERENCES views(id) ON DELETE CASCADE,
                rack_view_id INTEGER PRIMARY KEY REFERENCES views(id) ON DELETE CASCADE,
                x REAL NOT NULL CHECK (typeof(x) IN ('integer','real') AND abs(x) <= 1.7976931348623157e308),
                y REAL NOT NULL CHECK (typeof(y) IN ('integer','real') AND abs(y) <= 1.7976931348623157e308)
            )");
            $db->exec('CREATE INDEX idx_floor_rack_placements_floor ON floor_rack_placements(floor_view_id)');
            foreach (['INSERT', 'UPDATE'] as $event) {
                $suffix = strtolower($event);
                $db->exec("CREATE TRIGGER floor_rack_placements_types_{$suffix} BEFORE {$event} ON floor_rack_placements
                    WHEN COALESCE((SELECT view_type FROM views WHERE id = NEW.floor_view_id), '') <> 'floor'
                      OR COALESCE((SELECT view_type FROM views WHERE id = NEW.rack_view_id), '') <> 'rack'
                    BEGIN SELECT RAISE(ABORT, 'Invalid floor rack view types'); END");
            }
            $db->exec("CREATE TRIGGER floor_rack_placements_view_type BEFORE UPDATE OF view_type ON views
                WHEN (NEW.view_type <> 'floor' AND EXISTS (SELECT 1 FROM floor_rack_placements WHERE floor_view_id = OLD.id))
                  OR (NEW.view_type <> 'rack' AND EXISTS (SELECT 1 FROM floor_rack_placements WHERE rack_view_id = OLD.id))
                BEGIN SELECT RAISE(ABORT, 'Placed rack view types cannot change'); END");
            foreach (['INSERT', 'UPDATE', 'DELETE'] as $event) {
                $suffix = strtolower($event);
                $refs = $event === 'INSERT' ? 'NEW.floor_view_id' : ($event === 'DELETE' ? 'OLD.floor_view_id' : 'OLD.floor_view_id, NEW.floor_view_id');
                $db->exec("CREATE TRIGGER resource_owner_floor_rack_placements_{$suffix} AFTER {$event} ON floor_rack_placements BEGIN
                    UPDATE resource_sequences SET value = value + 1 WHERE name = 'revision';
                    UPDATE views SET resource_revision = (SELECT value FROM resource_sequences WHERE name = 'revision')
                    WHERE id IN ({$refs});
                END");
            }
            $db->exec('PRAGMA user_version = 16');
        }
        $db->commit();
    } catch (Throwable $e) {
        if ($db->inTransaction()) { $db->rollBack(); }
        throw $e;
    }
}

function migrateDatabaseToVersion17(PDO $db): void
{
    $db->beginTransaction();
    try {
        $db->exec("UPDATE app_meta SET meta_value = meta_value WHERE meta_key = 'data_revision'");
        if ((int)$db->query('PRAGMA user_version')->fetchColumn() < 17) {
            $db->exec("CREATE TABLE device_ip_addresses (
                id INTEGER PRIMARY KEY,
                device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
                ip TEXT NOT NULL CHECK (length(trim(ip)) > 0),
                label TEXT NOT NULL DEFAULT '' CHECK (length(label) <= 100),
                sort_order INTEGER NOT NULL DEFAULT 0 CHECK (typeof(sort_order) = 'integer' AND sort_order >= 0)
            )");
            $db->exec('CREATE INDEX idx_device_ip_addresses_device ON device_ip_addresses(device_id, sort_order, id)');
            foreach (['INSERT', 'UPDATE', 'DELETE'] as $event) {
                $suffix = strtolower($event);
                $refs = $event === 'INSERT' ? 'NEW.device_id' : ($event === 'DELETE' ? 'OLD.device_id' : 'OLD.device_id, NEW.device_id');
                $when = $event === 'UPDATE'
                    ? ' WHEN OLD.device_id IS NOT NEW.device_id OR OLD.ip IS NOT NEW.ip OR OLD.label IS NOT NEW.label OR OLD.sort_order IS NOT NEW.sort_order'
                    : '';
                $db->exec("CREATE TRIGGER resource_owner_device_ip_addresses_{$suffix} AFTER {$event} ON device_ip_addresses{$when} BEGIN
                    UPDATE resource_sequences SET value = value + 1 WHERE name = 'revision';
                    UPDATE devices SET resource_revision = (SELECT value FROM resource_sequences WHERE name = 'revision')
                    WHERE id IN ({$refs});
                END");
            }
            $db->exec('PRAGMA user_version = 17');
        }
        $db->commit();
    } catch (Throwable $e) {
        if ($db->inTransaction()) { $db->rollBack(); }
        throw $e;
    }
}

function migrateDatabaseToVersion18(PDO $db): void
{
    $db->beginTransaction();
    try {
        $db->exec("UPDATE app_meta SET meta_value = meta_value WHERE meta_key = 'data_revision'");
        if ((int)$db->query('PRAGMA user_version')->fetchColumn() < 18) {
            $db->exec("CREATE TABLE address_spaces (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
                memo TEXT NOT NULL DEFAULT '' CHECK (length(memo) <= 1000)
            )");
            $db->exec("CREATE TABLE ip_segments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                address_space_id INTEGER NOT NULL REFERENCES address_spaces(id) ON DELETE RESTRICT,
                cidr TEXT NOT NULL,
                name TEXT NOT NULL DEFAULT '' CHECK (length(name) <= 100),
                purpose TEXT NOT NULL DEFAULT '' CHECK (length(purpose) <= 100),
                facility TEXT NOT NULL DEFAULT '' CHECK (length(facility) <= 100),
                vlan_id INTEGER CHECK (vlan_id IS NULL OR (typeof(vlan_id) = 'integer' AND vlan_id BETWEEN 1 AND 4094)),
                memo TEXT NOT NULL DEFAULT '' CHECK (length(memo) <= 1000)
            )");
            $db->exec('CREATE INDEX idx_ip_segments_space ON ip_segments(address_space_id)');
            $db->exec('ALTER TABLE devices ADD COLUMN ip_segment_id INTEGER REFERENCES ip_segments(id) ON DELETE SET NULL');
            $db->exec('ALTER TABLE device_ip_addresses ADD COLUMN segment_id INTEGER REFERENCES ip_segments(id) ON DELETE SET NULL');
            $db->exec('CREATE INDEX idx_devices_ip_segment ON devices(ip_segment_id)');
            $db->exec('CREATE INDEX idx_device_ip_addresses_segment ON device_ip_addresses(segment_id)');
            $db->exec("CREATE TRIGGER resource_owner_device_ip_segment AFTER UPDATE OF segment_id ON device_ip_addresses
                WHEN OLD.segment_id IS NOT NEW.segment_id BEGIN
                    UPDATE resource_sequences SET value = value + 1 WHERE name = 'revision';
                    UPDATE devices SET resource_revision = (SELECT value FROM resource_sequences WHERE name = 'revision')
                    WHERE id = NEW.device_id;
                END");
            $db->exec("CREATE TRIGGER resource_owner_management_ip_segment AFTER UPDATE OF ip_segment_id ON devices
                WHEN OLD.ip_segment_id IS NOT NEW.ip_segment_id BEGIN
                    UPDATE resource_sequences SET value = value + 1 WHERE name = 'revision';
                    UPDATE devices SET resource_revision = (SELECT value FROM resource_sequences WHERE name = 'revision')
                    WHERE id = NEW.id;
                END");
            $db->exec('PRAGMA user_version = 18');
        }
        $db->commit();
    } catch (Throwable $e) {
        if ($db->inTransaction()) { $db->rollBack(); }
        throw $e;
    }
}

function migrateDatabaseToVersion19(PDO $db): void
{
    $db->beginTransaction();
    try {
        $db->exec("UPDATE app_meta SET meta_value = meta_value WHERE meta_key = 'data_revision'");
        if ((int)$db->query('PRAGMA user_version')->fetchColumn() < 19) {
            $db->exec("CREATE TABLE change_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_id INTEGER NOT NULL CHECK (typeof(event_id) = 'integer' AND event_id > 0),
                request_id TEXT NOT NULL DEFAULT '' CHECK (length(request_id) <= 64),
                occurred_at TEXT NOT NULL CHECK (
                    length(occurred_at) = 20
                    AND substr(occurred_at, 5, 1) = '-'
                    AND substr(occurred_at, 8, 1) = '-'
                    AND substr(occurred_at, 11, 1) = 'T'
                    AND substr(occurred_at, 14, 1) = ':'
                    AND substr(occurred_at, 17, 1) = ':'
                    AND substr(occurred_at, 20, 1) = 'Z'
                ),
                actor_user_id INTEGER NULL CHECK (actor_user_id IS NULL OR (typeof(actor_user_id) = 'integer' AND actor_user_id > 0)),
                actor_name TEXT NOT NULL DEFAULT '' CHECK (length(actor_name) <= 100),
                target_type TEXT NOT NULL CHECK (target_type IN ('device', 'view')),
                target_id INTEGER NOT NULL CHECK (typeof(target_id) = 'integer' AND target_id > 0),
                target_name TEXT NOT NULL CHECK (length(target_name) BETWEEN 1 AND 200),
                operation TEXT NOT NULL CHECK (operation IN ('create', 'update', 'delete')),
                summary TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 500),
                changes_json TEXT NOT NULL CHECK (length(changes_json) BETWEEN 2 AND 16384)
            )");
            $db->exec('CREATE INDEX idx_change_history_occurred ON change_history(occurred_at DESC, id DESC)');
            $db->exec('CREATE INDEX idx_change_history_target ON change_history(target_type, target_id, occurred_at DESC, id DESC)');
            $db->exec('CREATE INDEX idx_change_history_event ON change_history(event_id, id)');
            $db->exec('PRAGMA user_version = 19');
        }
        $db->commit();
    } catch (Throwable $e) {
        if ($db->inTransaction()) { $db->rollBack(); }
        throw $e;
    }
}

function migrateDatabaseToVersion20(PDO $db): void
{
    $db->beginTransaction();
    try {
        $db->exec("UPDATE app_meta SET meta_value = meta_value WHERE meta_key = 'data_revision'");
        if ((int)$db->query('PRAGMA user_version')->fetchColumn() < 20) {
            $db->exec("CREATE TABLE device_config_states (
                device_id INTEGER PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
                revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision > 0),
                next_generation INTEGER NOT NULL CHECK (typeof(next_generation) = 'integer' AND next_generation > 0)
            )");
            $db->exec("CREATE TABLE device_configs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
                generation INTEGER NOT NULL CHECK (typeof(generation) = 'integer' AND generation > 0),
                content TEXT NOT NULL,
                created_at TEXT NOT NULL,
                actor_user_id INTEGER NULL CHECK (actor_user_id IS NULL OR (typeof(actor_user_id) = 'integer' AND actor_user_id > 0)),
                actor_name TEXT NOT NULL CHECK (length(actor_name) <= 100),
                memo TEXT NOT NULL DEFAULT '' CHECK (length(memo) <= 200),
                UNIQUE(device_id, generation)
            )");
            $db->exec('CREATE INDEX idx_device_configs_order ON device_configs(device_id, created_at DESC, generation DESC)');
            $db->exec('PRAGMA user_version = 20');
        }
        $db->commit();
    } catch (Throwable $e) {
        if ($db->inTransaction()) { $db->rollBack(); }
        throw $e;
    }
}

function migrateDatabaseToVersion21(PDO $db): void
{
    $db->beginTransaction();
    try {
        $db->exec("UPDATE app_meta SET meta_value = meta_value WHERE meta_key = 'data_revision'");
        if ((int)$db->query('PRAGMA user_version')->fetchColumn() < 21) {
            $db->exec("ALTER TABLE address_spaces ADD COLUMN ping_reachability TEXT NOT NULL DEFAULT 'unset' CHECK (ping_reachability IN ('unset', 'reachable', 'unreachable'))");
            $db->exec('PRAGMA user_version = 21');
        }
        $db->commit();
    } catch (Throwable $e) {
        if ($db->inTransaction()) { $db->rollBack(); }
        throw $e;
    }
}

function migrateDatabaseToVersion22(PDO $db): void
{
    $db->beginTransaction();
    try {
        $db->exec("UPDATE app_meta SET meta_value = meta_value WHERE meta_key = 'data_revision'");
        if ((int)$db->query('PRAGMA user_version')->fetchColumn() < 22) {
            // 論理削除。削除済み利用者は is_active=0 かつ deleted_at 設定済み。既存利用者はNULL。
            $db->exec('ALTER TABLE users ADD COLUMN deleted_at TEXT');
            $db->exec('PRAGMA user_version = 22');
        }
        $db->commit();
    } catch (Throwable $e) {
        if ($db->inTransaction()) { $db->rollBack(); }
        throw $e;
    }
}

function migrateDatabaseToVersion23(PDO $db): void
{
    $db->beginTransaction();
    try {
        $db->exec("UPDATE app_meta SET meta_value = meta_value WHERE meta_key = 'data_revision'");
        if ((int)$db->query('PRAGMA user_version')->fetchColumn() < 23) {
            $db->exec("ALTER TABLE view_floor_plans ADD COLUMN rotation REAL NOT NULL DEFAULT 0
                CHECK (typeof(rotation) IN ('integer', 'real') AND rotation BETWEEN -180 AND 180)");
            $db->exec('DROP TRIGGER resource_owner_view_floor_plans_update');
            $db->exec("CREATE TRIGGER resource_owner_view_floor_plans_update AFTER UPDATE ON view_floor_plans
                WHEN OLD.stored_name IS NOT NEW.stored_name
                    OR OLD.original_name IS NOT NEW.original_name
                    OR OLD.mime_type IS NOT NEW.mime_type
                    OR OLD.file_size IS NOT NEW.file_size
                    OR OLD.image_width IS NOT NEW.image_width
                    OR OLD.image_height IS NOT NEW.image_height
                    OR OLD.x IS NOT NEW.x
                    OR OLD.y IS NOT NEW.y
                    OR OLD.scale IS NOT NEW.scale
                    OR OLD.opacity IS NOT NEW.opacity
                    OR OLD.rotation IS NOT NEW.rotation
                    OR OLD.is_visible IS NOT NEW.is_visible
                    OR OLD.revision IS NOT NEW.revision BEGIN
                UPDATE resource_sequences SET value = value + 1 WHERE name = 'revision';
                UPDATE views SET resource_revision = (SELECT value FROM resource_sequences WHERE name = 'revision')
                WHERE id IN (OLD.view_id, NEW.view_id);
            END");
            $db->exec('PRAGMA user_version = 23');
        }
        $db->commit();
    } catch (Throwable $e) {
        if ($db->inTransaction()) { $db->rollBack(); }
        throw $e;
    }
}

function migrateDatabaseToVersion24(PDO $db): void
{
    $db->beginTransaction();
    try {
        $db->exec("UPDATE app_meta SET meta_value = meta_value WHERE meta_key = 'data_revision'");
        if ((int)$db->query('PRAGMA user_version')->fetchColumn() < 24) {
            $db->exec("CREATE TABLE buildings (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
                sort_order INTEGER NOT NULL DEFAULT 0 CHECK (typeof(sort_order) = 'integer' AND sort_order BETWEEN -999999 AND 999999)
            )");
            $db->exec("CREATE TABLE floors (
                id INTEGER PRIMARY KEY,
                building_id INTEGER NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
                name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
                sort_order INTEGER NOT NULL DEFAULT 0 CHECK (typeof(sort_order) = 'integer' AND sort_order BETWEEN -999999 AND 999999),
                representative_view_id INTEGER NULL REFERENCES views(id) ON DELETE SET NULL,
                scale REAL NOT NULL DEFAULT 1 CHECK (typeof(scale) IN ('integer', 'real') AND scale > 0 AND scale <= 1.7976931348623157e308),
                offset_x REAL NOT NULL DEFAULT 0 CHECK (typeof(offset_x) IN ('integer', 'real') AND abs(offset_x) <= 1.7976931348623157e308),
                offset_y REAL NOT NULL DEFAULT 0 CHECK (typeof(offset_y) IN ('integer', 'real') AND abs(offset_y) <= 1.7976931348623157e308),
                rotation REAL NOT NULL DEFAULT 0 CHECK (typeof(rotation) IN ('integer', 'real') AND rotation BETWEEN -180 AND 180)
            )");
            $db->exec('ALTER TABLE views ADD COLUMN floor_id INTEGER NULL REFERENCES floors(id) ON DELETE SET NULL');
            $db->exec('CREATE INDEX idx_floors_building ON floors(building_id, sort_order, id)');
            $db->exec('CREATE INDEX idx_views_floor ON views(floor_id)');
            foreach (['buildings', 'floors'] as $table) {
                $db->exec("INSERT INTO resource_sequences(name, value) VALUES ('{$table}', 0)");
                $db->exec("CREATE TRIGGER resource_id_{$table} AFTER INSERT ON {$table} BEGIN
                    UPDATE resource_sequences SET value = MAX(value, NEW.id) WHERE name = '{$table}';
                END");
            }
            $db->exec("CREATE TRIGGER resource_revision_views_floor AFTER UPDATE OF floor_id ON views
                WHEN OLD.floor_id IS NOT NEW.floor_id BEGIN
                    UPDATE resource_sequences SET value = value + 1 WHERE name = 'revision';
                    UPDATE views SET resource_revision = (SELECT value FROM resource_sequences WHERE name = 'revision') WHERE id = NEW.id;
                END");
            $db->exec("CREATE TRIGGER clear_floor_representative AFTER UPDATE OF floor_id, view_type ON views
                WHEN OLD.floor_id IS NOT NEW.floor_id OR OLD.view_type IS NOT NEW.view_type BEGIN
                    UPDATE floors SET representative_view_id = NULL WHERE representative_view_id = NEW.id
                        AND (id IS NOT NEW.floor_id OR NEW.view_type <> 'floor');
                END");
            $db->exec('PRAGMA user_version = 24');
        }
        $db->commit();
    } catch (Throwable $e) {
        if ($db->inTransaction()) { $db->rollBack(); }
        throw $e;
    }
}

function migrateDatabaseToVersion25(PDO $db): void
{
    $db->beginTransaction();
    try {
        $db->exec("UPDATE app_meta SET meta_value = meta_value WHERE meta_key = 'data_revision'");
        if ((int)$db->query('PRAGMA user_version')->fetchColumn() < 25) {
            $db->exec('ALTER TABLE devices ADD COLUMN floor_id INTEGER NULL REFERENCES floors(id) ON DELETE SET NULL');
            $db->exec('CREATE INDEX idx_devices_floor ON devices(floor_id)');
            $db->exec("CREATE TRIGGER resource_revision_devices_floor AFTER UPDATE OF floor_id ON devices
                WHEN OLD.floor_id IS NOT NEW.floor_id BEGIN
                    UPDATE resource_sequences SET value = value + 1 WHERE name = 'revision';
                    UPDATE devices SET resource_revision = (SELECT value FROM resource_sequences WHERE name = 'revision') WHERE id = NEW.id;
                END");
            \Netarium\Services\Topology\LegacyHierarchyMigration::migrate($db);
            $db->exec('PRAGMA user_version = 25');
        }
        $db->commit();
    } catch (Throwable $e) {
        if ($db->inTransaction()) { $db->rollBack(); }
        throw $e;
    }
}

function migrateDatabaseToVersion26(PDO $db): void
{
    $db->beginTransaction();
    try {
        $db->exec("UPDATE app_meta SET meta_value = meta_value WHERE meta_key = 'data_revision'");
        if ((int)$db->query('PRAGMA user_version')->fetchColumn() < 26) {
            $db->exec("ALTER TABLE buildings ADD COLUMN building_view_enabled INTEGER NOT NULL DEFAULT 0
                CHECK (typeof(building_view_enabled) = 'integer' AND building_view_enabled IN (0, 1))");
            $db->exec('UPDATE buildings SET building_view_enabled = 1');
            $db->exec('PRAGMA user_version = 26');
        }
        $db->commit();
    } catch (Throwable $e) {
        if ($db->inTransaction()) { $db->rollBack(); }
        throw $e;
    }
}

function migrateDatabaseToVersion27(PDO $db): void
{
    $db->beginTransaction();
    try {
        $db->exec("UPDATE app_meta SET meta_value = meta_value WHERE meta_key = 'data_revision'");
        if ((int)$db->query('PRAGMA user_version')->fetchColumn() >= 27) {
            $db->commit();
            return;
        }

        $oldLinks = $db->query('SELECT * FROM links ORDER BY id')->fetchAll(PDO::FETCH_ASSOC);
        $converted = \Netarium\Services\Topology\LegacyLinkMigration::convert($oldLinks);
        // 統合・保留した接続の ID も、今後の接続に再利用しない。
        $db->exec("UPDATE resource_sequences SET value = MAX(value, (SELECT COALESCE(MAX(id), 0) FROM links))
            WHERE name = 'links'");
        // DROP TABLE で旧 resource_owner_links_* と旧採番トリガーも削除される。
        $db->exec('DROP TABLE links');
        $db->exec("ALTER TABLE views ADD COLUMN show_connections INTEGER NOT NULL DEFAULT 1
            CHECK (typeof(show_connections) = 'integer' AND show_connections IN (0, 1))");
        $db->exec(<<<'SQL'
            CREATE TABLE device_ports (
                id INTEGER PRIMARY KEY CHECK (id > 0),
                device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
                name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 50),
                memo TEXT NOT NULL DEFAULT '',
                resource_revision INTEGER NOT NULL DEFAULT 1 CHECK (resource_revision > 0),
                UNIQUE (device_id, name),
                UNIQUE (id, device_id)
            );
            CREATE TABLE links (
                id INTEGER PRIMARY KEY CHECK (id > 0),
                from_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
                to_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
                from_port_id INTEGER,
                to_port_id INTEGER,
                system_id INTEGER REFERENCES link_systems(id) ON DELETE RESTRICT,
                label TEXT NOT NULL DEFAULT '',
                vlan TEXT NOT NULL DEFAULT '',
                memo TEXT NOT NULL DEFAULT '',
                resource_revision INTEGER NOT NULL DEFAULT 1 CHECK (resource_revision > 0),
                CHECK (from_id <> to_id),
                FOREIGN KEY (from_port_id, from_id) REFERENCES device_ports(id, device_id),
                FOREIGN KEY (to_port_id, to_id) REFERENCES device_ports(id, device_id)
            );
            CREATE INDEX idx_links_from ON links(from_id);
            CREATE INDEX idx_links_to ON links(to_id);
            CREATE INDEX idx_links_from_port ON links(from_port_id);
            CREATE INDEX idx_links_to_port ON links(to_port_id);
            CREATE INDEX idx_links_system ON links(system_id);
            CREATE INDEX idx_links_pair ON links(min(from_id, to_id), max(from_id, to_id));
            CREATE TABLE view_link_routes (
                view_id INTEGER NOT NULL REFERENCES views(id) ON DELETE CASCADE,
                device_a_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
                device_b_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
                manual_route TEXT NOT NULL CHECK (json_valid(manual_route)
                    AND json_type(manual_route) = 'array' AND json_array_length(manual_route) <= 8),
                CHECK (device_a_id < device_b_id),
                PRIMARY KEY (view_id, device_a_id, device_b_id)
            );
            CREATE INDEX idx_view_link_routes_pair ON view_link_routes(device_a_id, device_b_id);
            CREATE INDEX idx_view_link_routes_device_b ON view_link_routes(device_b_id);
            CREATE TABLE legacy_link_conflicts (
                legacy_link_id INTEGER PRIMARY KEY CHECK (legacy_link_id > 0),
                view_id INTEGER NOT NULL,
                device_a_id INTEGER NOT NULL,
                device_b_id INTEGER NOT NULL,
                reason TEXT NOT NULL,
                payload TEXT NOT NULL CHECK (json_valid(payload) AND json_type(payload) = 'object'),
                CHECK (device_a_id < device_b_id)
            );
            CREATE INDEX idx_legacy_link_conflicts_pair ON legacy_link_conflicts(device_a_id, device_b_id);
            INSERT INTO resource_sequences(name, value) VALUES ('device_ports', 0);
            DROP TRIGGER resource_revision_views_update;
            DROP TRIGGER resource_revision_views_floor;
            SQL);
        foreach (['views', 'device_ports', 'links'] as $table) {
            if ($table !== 'views') {
                $db->exec("CREATE TRIGGER resource_id_{$table} AFTER INSERT ON {$table} BEGIN
                    UPDATE resource_sequences SET value = MAX(value, NEW.id) WHERE name = '{$table}';
                END");
                $db->exec("CREATE TRIGGER resource_revision_{$table}_insert AFTER INSERT ON {$table} BEGIN
                    UPDATE resource_sequences SET value = value + 1 WHERE name = 'revision';
                    UPDATE {$table} SET resource_revision = (SELECT value FROM resource_sequences WHERE name = 'revision') WHERE id = NEW.id;
                END");
            }
            createResourceRevisionUpdateTrigger($db, $table);
        }
        foreach (['insert' => 'NEW.view_id', 'update' => 'OLD.view_id, NEW.view_id', 'delete' => 'OLD.view_id'] as $event => $owners) {
            $db->exec("CREATE TRIGGER resource_owner_view_link_routes_{$event} AFTER {$event} ON view_link_routes BEGIN
                UPDATE resource_sequences SET value = value + 1 WHERE name = 'revision';
                UPDATE views SET resource_revision = (SELECT value FROM resource_sequences WHERE name = 'revision')
                WHERE id IN ({$owners});
            END");
        }
        foreach (['device_ports', 'links', 'view_link_routes', 'legacy_link_conflicts'] as $table) {
            if ($converted[$table] === []) { continue; }
            $fields = array_keys($converted[$table][0]);
            $values = implode(', ', array_fill(0, count($fields), '?'));
            $stmt = $db->prepare("INSERT INTO {$table} (" . implode(', ', $fields) . ") VALUES ({$values})");
            foreach ($converted[$table] as $row) {
                foreach (['manual_route', 'payload'] as $json) {
                    if (isset($row[$json])) {
                        $row[$json] = json_encode($row[$json], JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE);
                    }
                }
                $stmt->execute(array_values($row));
            }
        }
        $stmt = $db->prepare("INSERT INTO app_meta(meta_key, meta_value) VALUES ('legacy_link_migration', ?)
            ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value");
        $stmt->execute([json_encode($converted['counts'], JSON_THROW_ON_ERROR)]);
        $db->exec('PRAGMA user_version = 27');
        $db->commit();
    } catch (Throwable $e) {
        if ($db->inTransaction()) { $db->rollBack(); }
        throw $e;
    }
}

function createResourceRevisionUpdateTrigger(PDO $db, string $table): void
{
    $columns = $db->query("PRAGMA table_info({$table})")->fetchAll(PDO::FETCH_ASSOC);
    $fields = array_diff(array_column($columns, 'name'), ['id', 'resource_revision']);
    $changes = array_map(static fn(string $field): string => "OLD.{$field} IS NOT NEW.{$field}", $fields);
    $db->exec("CREATE TRIGGER resource_revision_{$table}_update AFTER UPDATE OF " . implode(', ', $fields) . " ON {$table}
        WHEN " . implode(' OR ', $changes) . " BEGIN
        UPDATE resource_sequences SET value = value + 1 WHERE name = 'revision';
        UPDATE {$table} SET resource_revision = (SELECT value FROM resource_sequences WHERE name = 'revision') WHERE id = NEW.id;
    END");
}

function migrateDatabaseToVersion28(PDO $db): void
{
    $db->beginTransaction();
    try {
        $db->exec("UPDATE app_meta SET meta_value = meta_value WHERE meta_key = 'data_revision'");
        if ((int)$db->query('PRAGMA user_version')->fetchColumn() >= 28) {
            $db->commit();
            return;
        }
        $db->exec(<<<'SQL'
            CREATE TABLE legacy_link_vlans (
                link_id INTEGER PRIMARY KEY REFERENCES links(id) ON DELETE CASCADE,
                vlan TEXT NOT NULL
            );
            INSERT INTO legacy_link_vlans (link_id, vlan)
            SELECT id, vlan FROM links
            WHERE trim(vlan, char(9, 10, 11, 12, 13, 32)) <> '';
            ALTER TABLE device_ports ADD COLUMN vlan TEXT NOT NULL DEFAULT '';
            DROP TRIGGER resource_revision_links_update;
            DROP TRIGGER resource_revision_device_ports_update;
            ALTER TABLE links DROP COLUMN vlan;
            SQL);
        createResourceRevisionUpdateTrigger($db, 'links');
        createResourceRevisionUpdateTrigger($db, 'device_ports');
        $db->exec('PRAGMA user_version = 28');
        $db->commit();
    } catch (Throwable $e) {
        if ($db->inTransaction()) { $db->rollBack(); }
        throw $e;
    }
}

function migrateDatabaseToVersion29(PDO $db): void
{
    $db->beginTransaction();
    try {
        $db->exec("UPDATE app_meta SET meta_value = meta_value WHERE meta_key = 'data_revision'");
        if ((int)$db->query('PRAGMA user_version')->fetchColumn() >= 29) {
            $db->commit();
            return;
        }
        // スキーマ29で扱う項目。将来の設定・診断コードの変更には追従させない。
        $textFields = ['ip', 'location', 'manufacturer', 'model', 'asset_number', 'serial_number', 'mac_address', 'memo', 'maintenance_expiry'];
        $deviceFields = "'" . implode("', '", [...$textFields, 'floor_id']) . "'";
        $db->exec(<<<SQL
            CREATE TABLE quality_not_applicable (
                device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
                link_id INTEGER REFERENCES links(id) ON DELETE CASCADE,
                field TEXT NOT NULL,
                CHECK ((link_id IS NULL AND field IN ({$deviceFields}))
                    OR (link_id IS NOT NULL AND field IN ('from_port', 'to_port')))
            );
            CREATE UNIQUE INDEX quality_not_applicable_device_field
                ON quality_not_applicable (device_id, field) WHERE link_id IS NULL;
            CREATE UNIQUE INDEX quality_not_applicable_link_field
                ON quality_not_applicable (link_id, field) WHERE link_id IS NOT NULL;
            CREATE INDEX quality_not_applicable_device ON quality_not_applicable (device_id);
            SQL);

        foreach ($textFields as $field) {
            // SQLite の trim() は除去文字に NUL を指定できないため、NUL があれば区切って調べる。
            $db->exec(<<<SQL
                CREATE TRIGGER quality_not_applicable_device_{$field} AFTER UPDATE OF {$field} ON devices
                WHEN OLD.{$field} IS NOT NEW.{$field} AND CASE
                    WHEN instr(NEW.{$field}, char(0)) = 0 THEN trim(NEW.{$field}, char(9, 10, 11, 13, 32)) <> ''
                    ELSE EXISTS (
                        WITH RECURSIVE chunks(part, rest) AS (
                            SELECT '', CAST(NEW.{$field} AS BLOB)
                            UNION ALL
                            SELECT CASE WHEN instr(rest, x'00') = 0 THEN rest ELSE substr(rest, 1, instr(rest, x'00') - 1) END,
                                   CASE WHEN instr(rest, x'00') <> 0 THEN substr(rest, instr(rest, x'00') + 1) END
                            FROM chunks WHERE rest IS NOT NULL
                        )
                        SELECT 1 FROM chunks WHERE trim(CAST(part AS TEXT), char(9, 10, 11, 13, 32)) <> ''
                    )
                END BEGIN
                    DELETE FROM quality_not_applicable WHERE device_id = NEW.id AND link_id IS NULL AND field = '{$field}';
                END;
                SQL);
        }
        $db->exec(<<<'SQL'
            CREATE TRIGGER quality_not_applicable_device_floor_id AFTER UPDATE OF floor_id ON devices
            WHEN OLD.floor_id IS NOT NEW.floor_id AND NEW.floor_id IS NOT NULL BEGIN
                DELETE FROM quality_not_applicable WHERE device_id = NEW.id AND link_id IS NULL AND field = 'floor_id';
            END;
            SQL);
        foreach (['from', 'to'] as $side) {
            $db->exec(<<<SQL
                CREATE TRIGGER quality_not_applicable_link_{$side} AFTER UPDATE OF {$side}_id, {$side}_port_id ON links
                WHEN OLD.{$side}_id IS NOT NEW.{$side}_id
                    OR (OLD.{$side}_port_id IS NOT NEW.{$side}_port_id AND NEW.{$side}_port_id IS NOT NULL) BEGIN
                    DELETE FROM quality_not_applicable WHERE link_id = NEW.id AND field = '{$side}_port';
                END;
                SQL);
        }
        $db->exec('PRAGMA user_version = 29');
        $db->commit();
    } catch (Throwable $e) {
        if ($db->inTransaction()) { $db->rollBack(); }
        throw $e;
    }
}

function ensureDefaultView(PDO $db): void
{
    $count = (int)$db
        ->query(
            'SELECT COUNT(*) FROM views'
        )
        ->fetchColumn();

    if ($count > 0) {
        return;
    }

    $ownsTransaction = !$db->inTransaction();
    if ($ownsTransaction) {
        $db->exec('BEGIN IMMEDIATE');
    }
    try {
        $count = (int)$db
            ->query(
                'SELECT COUNT(*) FROM views'
            )
            ->fetchColumn();

        if ($count > 0) {
            if ($ownsTransaction) {
                $db->commit();
            }
            return;
        }

        $stmt = $db->prepare("
            INSERT INTO views (
                name,
                facility,
                floor,
                view_type,
                sort_order,
                memo
            ) VALUES (
                :name,
                '',
                '',
                'topology',
                10,
                ''
            )
        ");

        $stmt->execute([
            ':name' =>
                '全体ネットワーク',
        ]);
        if ($ownsTransaction) {
            $db->commit();
        }
    } catch (Throwable $e) {
        if ($ownsTransaction && $db->inTransaction()) {
            $db->rollBack();
        }
        throw $e;
    }
}

function ensureSetupCompletedMarker(PDO $db): void
{
    if ($db->query("SELECT 1 FROM app_meta WHERE meta_key = 'setup_completed'")->fetchColumn() !== false) {
        return;
    }
    if ((int)$db->query('SELECT COUNT(*) FROM users')->fetchColumn() === 0) {
        return;
    }

    $db->exec("
        INSERT INTO app_meta (meta_key, meta_value)
        SELECT 'setup_completed', '1'
        WHERE (SELECT COUNT(*) FROM users) > 0
        ON CONFLICT(meta_key) DO NOTHING
    ");
}

