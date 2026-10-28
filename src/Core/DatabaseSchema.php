<?php
declare(strict_types=1);

const APP_DATABASE_SCHEMA_VERSION = 16;


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

