<?php
declare(strict_types=1);

namespace Netarium\Tests;

use PDO;
use RuntimeException;
use Throwable;

class TestServer
{
    private string $tempDir;
    private string $projectRoot;
    private string $docRoot;
    private string $host = '127.0.0.1';
    private int $port = 0;
    private $process = null;
    private array $pipes = [];
    private bool $isRunning = false;

    private $logHandle = null;
    private string $logFile = '';
    private string $dbPath = '';
    private ?string $prependFile = null;
    private bool $skipInit = false;
    public function __construct(?string $projectRoot = null, ?string $prependFile = null)
    {
        $this->projectRoot = $projectRoot
            ?? (string)realpath(__DIR__ . '/..');
        $this->prependFile = $prependFile;
        $this->docRoot = $this->projectRoot
            . DIRECTORY_SEPARATOR
            . 'public';
        $this->tempDir = sys_get_temp_dir()
            . DIRECTORY_SEPARATOR
            . 'netarium_test_'
            . bin2hex(random_bytes(8));
        $this->logFile = $this->tempDir . DIRECTORY_SEPARATOR . 'server.log';
        $this->dbPath = $this->tempDir
            . DIRECTORY_SEPARATOR
            . 'db'
            . DIRECTORY_SEPARATOR
            . 'data.sqlite';

        register_shutdown_function([$this, 'stop']);
    }

    public function getTempDir(): string
    {
        return $this->tempDir;
    }
    public function getDbPath(): string
    {
        return $this->dbPath;
    }

    public function getPort(): int
    {
        return $this->port;
    }

    public function getHost(): string
    {
        return $this->host;
    }

    public function getBaseUrl(): string
    {
        if ($this->port === 0) {
            throw new RuntimeException("Server is not running");
        }
        return "http://{$this->host}:{$this->port}";
    }

    public function spawnWorker(): self
    {
        $worker = new self($this->projectRoot, $this->prependFile);
        $worker->tempDir = $this->tempDir;
        $worker->dbPath = $this->dbPath;
        $worker->logFile = $this->tempDir . DIRECTORY_SEPARATOR . 'server_' . bin2hex(random_bytes(4)) . '.log';
        $worker->skipInit = true;
        $worker->start();
        return $worker;
    }

    public function start(): void
    {
        if ($this->isRunning) {
            return;
        }

        if (!$this->skipInit) {
            // 1. Prepare directory structure
            $this->createDirectoryStructure();

            // 2. Initialize SQLite database & seed data
            $this->initDatabaseAndSeed();
        }
        // 3. Find available port
        $this->port = $this->findAvailablePort(8091, 8199);

        // 4. Launch PHP built-in web server with output redirected to log file to avoid pipe buffer blocking
        $this->logHandle = fopen($this->logFile, 'a+');
        $nullDevice = stripos(PHP_OS, 'WIN') === 0 ? 'NUL' : '/dev/null';

        $descriptors = [
            0 => ['file', $nullDevice, 'r'],
            1 => $this->logHandle,
            2 => $this->logHandle,
        ];

        $phpBinary = PHP_BINARY;
        $sessionDir = $this->tempDir . DIRECTORY_SEPARATOR . 'sessions';
        $prependOption = '';
        if ($this->prependFile !== null && $this->prependFile !== '') {
            $prependOption = sprintf(' -d auto_prepend_file="%s"', $this->prependFile);
        }
        // Evaluate replaced PHP fixtures immediately, independently of the host OPcache settings.
        $cmd = sprintf(
            '"%s" -d opcache.enable=0 -d session.save_path="%s" -d upload_max_filesize=128M -d post_max_size=128M -d memory_limit=512M -d max_execution_time=300%s -S %s:%d -t "%s"',
            $phpBinary,
            $sessionDir,
            $prependOption,
            $this->host,
            $this->port,
            $this->docRoot
        );

        $parentEnv = getenv();
        $env = array_merge(is_array($parentEnv) ? $parentEnv : [], [
            'NETARIUM_STORAGE_DIR' => $this->tempDir,
            'NETARIUM_DB_FILE' => $this->dbPath,
            'TEMP' => sys_get_temp_dir(),
            'TMP' => sys_get_temp_dir(),
            'SystemRoot' => getenv('SystemRoot') ?: 'C:\Windows',
        ]);

        $this->process = proc_open($cmd, $descriptors, $this->pipes, $this->docRoot, $env);
        if (!is_resource($this->process)) {
            throw new RuntimeException("Failed to start PHP built-in server with command: {$cmd}");
        }

        // 5. Wait for server to become responsive
        $this->waitForServer();
        $this->isRunning = true;
    }

    public function stop(): void
    {
        if (!$this->isRunning && $this->process === null) {
            return;
        }

        $this->isRunning = false;

        if (is_resource($this->process)) {
            $status = proc_get_status($this->process);
            $pid = $status['pid'] ?? 0;

            if ($pid > 0) {
                if (stripos(PHP_OS, 'WIN') === 0) {
                    exec(sprintf('taskkill /F /T /PID %d 2>&1', $pid));
                } else {
                    posix_kill($pid, SIGKILL);
                }
            }

            @proc_terminate($this->process);
            @proc_close($this->process);
            $this->process = null;
        }

        if (is_resource($this->logHandle)) {
            fclose($this->logHandle);
            $this->logHandle = null;
        }

        // Cleanup temporary directory
        if (!$this->skipInit) {
            $this->removeDirectory($this->tempDir);
        }
    }

    private function createDirectoryStructure(): void
    {
        $dirs = [
            $this->tempDir,
            $this->tempDir . DIRECTORY_SEPARATOR . 'db',
            $this->tempDir . DIRECTORY_SEPARATOR . 'db' . DIRECTORY_SEPARATOR . 'csv-import',
            $this->tempDir . DIRECTORY_SEPARATOR . 'uploads',
            $this->tempDir . DIRECTORY_SEPARATOR . 'uploads' . DIRECTORY_SEPARATOR . 'floorplans',
            $this->tempDir . DIRECTORY_SEPARATOR . 'backups',
            $this->tempDir . DIRECTORY_SEPARATOR . 'backups' . DIRECTORY_SEPARATOR . 'auto',
            $this->tempDir . DIRECTORY_SEPARATOR . 'temp',
            $this->tempDir . DIRECTORY_SEPARATOR . 'temp' . DIRECTORY_SEPARATOR . 'backup-export',
            $this->tempDir . DIRECTORY_SEPARATOR . 'temp' . DIRECTORY_SEPARATOR . 'backup-restore',
            $this->tempDir . DIRECTORY_SEPARATOR . 'logs',
            $this->tempDir . DIRECTORY_SEPARATOR . 'sessions',
        ];

        foreach ($dirs as $dir) {
            if (!is_dir($dir) && !mkdir($dir, 0777, true)) {
                throw new RuntimeException("Failed to create directory: {$dir}");
            }
        }
    }

    private function initDatabaseAndSeed(): void
    {
        $dbFile = $this->dbPath;

        require_once $this->projectRoot . '/bootstrap.php';

        $pdo = new PDO('sqlite:' . $dbFile);
        \Netarium\Core\Database::initialize($pdo);

        $now = date('Y-m-d H:i:s');

        // 1. Seed users (admin & viewer)
        $userStmt = $pdo->prepare("
            INSERT INTO users (username, password_hash, role, is_active, created_at, updated_at)
            VALUES (:username, :password_hash, :role, 1, :created_at, :updated_at)
        ");

        $userStmt->execute([
            ':username' => 'admin',
            ':password_hash' => \Netarium\Services\Auth\PasswordHashing::hash('admin123'),
            ':role' => 'admin',
            ':created_at' => $now,
            ':updated_at' => $now,
        ]);

        $userStmt->execute([
            ':username' => 'viewer',
            ':password_hash' => \Netarium\Services\Auth\PasswordHashing::hash('viewer123'),
            ':role' => 'viewer',
            ':created_at' => $now,
            ':updated_at' => $now,
        ]);

        // 2. Ensure floor view (Default topology view is created by ensureDefaultView as id=1)
        $pdo->exec("
            INSERT INTO views (id, name, facility, floor, view_type, sort_order, memo)
            VALUES (2, '1Fフロア図', '本庁舎', '1F', 'floor', 20, '1階フロア配置図')
        ");

        // 3. Seed devices
        $pdo->exec("
            INSERT INTO devices (id, name, type, ip, facility, floor, location, manufacturer, model, asset_number, serial_number, mac_address, memo)
            VALUES 
            (1, 'ルータ01', 'router', '192.168.1.1', '本庁舎', '1F', '電算室', 'Yamaha', 'RTX1210', 'AST-001', 'SER-001', '00:11:22:33:44:55', 'コアルータ'),
            (2, 'コアSW01', 'switch', '192.168.1.2', '本庁舎', '1F', '電算室', 'Cisco', 'Catalyst2960', 'AST-002', 'SER-002', '00:11:22:33:44:66', 'フロアスイッチ'),
            (3, 'テストサーバ', 'server', '127.0.0.1', '本庁舎', '1F', '電算室', 'Dell', 'PowerEdge', 'AST-003', 'SER-003', '00:11:22:33:44:77', 'Webサーバー'),
            (4, '外部DNS', 'server', '8.8.8.8', '外部', '1F', 'データセンタ', 'Google', 'DNS', 'AST-004', 'SER-004', '00:11:22:33:44:99', '外部公開DNS')
        ");

        // 4. Seed placements
        $pdo->exec("
            INSERT INTO device_placements (id, device_id, view_id, x, y)
            VALUES
            (1, 1, 1, 100, 100),
            (2, 2, 1, 300, 100),
            (3, 1, 2, 150, 150)
        ");

        // 5. Seed links
        $pdo->exec("
            INSERT INTO links (id, view_id, from_id, to_id, label, from_port, to_port, vlan, memo)
            VALUES
            (1, 1, 1, 2, 'Trunk', 'ge0/1', 'ge0/24', '1,10,20', '幹線リンク')
        ");

        // 6. Seed app_meta revision
        $pdo->exec("
            INSERT OR REPLACE INTO app_meta (meta_key, meta_value)
            VALUES ('data_revision', '1'), ('monitor_revision', '1')
        ");

        // Close PDO so file locks are released
        unset($pdo);
    }

    private function findAvailablePort(int $start, int $end): int
    {
        for ($p = $start; $p <= $end; $p++) {
            $fp = @fsockopen($this->host, $p, $errno, $errstr, 0.2);
            if (!$fp) {
                return $p;
            }
            fclose($fp);
        }
        throw new RuntimeException("No available port found in range {$start}-{$end}");
    }

    private function waitForServer(int $timeoutMs = 5000): void
    {
        $start = microtime(true);
        $url = "http://{$this->host}:{$this->port}/login.php";

        while ((microtime(true) - $start) * 1000 < $timeoutMs) {
            $fp = @fsockopen($this->host, $this->port, $errno, $errstr, 0.2);
            if ($fp) {
                fclose($fp);
                return;
            }
            usleep(50000); // 50ms
        }

        $errorLog = file_exists($this->logFile) ? (string)file_get_contents($this->logFile) : '';

        throw new RuntimeException("Timed out waiting for test server to start on {$this->host}:{$this->port}. Server log: {$errorLog}");
    }

    private function removeDirectory(string $dir): void
    {
        if (!is_dir($dir)) {
            return;
        }

        // Retry a few times in case of transient file locks on Windows
        for ($attempt = 0; $attempt < 5; $attempt++) {
            try {
                $this->recursiveRmdir($dir);
                return;
            } catch (Throwable) {
                usleep(100000); // 100ms
            }
        }
    }

    private function recursiveRmdir(string $dir): void
    {
        $items = scandir($dir);
        if ($items === false) {
            return;
        }

        foreach ($items as $item) {
            if ($item === '.' || $item === '..') {
                continue;
            }
            $path = $dir . DIRECTORY_SEPARATOR . $item;
            if (is_dir($path)) {
                $this->recursiveRmdir($path);
            } else {
                @chmod($path, 0777);
                @unlink($path);
            }
        }
        @rmdir($dir);
    }
}
