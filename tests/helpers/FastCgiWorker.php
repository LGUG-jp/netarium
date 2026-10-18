<?php
declare(strict_types=1);

namespace Netarium\Tests\Helpers;

use RuntimeException;
use Throwable;

/**
 * Direct php-cgi transport for the Issue #204 regression, not an IIS substitute.
 * Each worker owns one process; callers own the shared storage and database.
 */
final class FastCgiWorker
{
    private const HOST = '127.0.0.1';
    private const REQUEST_ID = 1;
    private const REQUEST_TIMEOUT = 30.0;
    private const START_TIMEOUT = 10.0;

    private string $cgiBinary;
    private string $projectRoot;
    private string $storageDir;
    private string $dbPath;
    private ?string $prependFile;
    private string $publicRoot = '';
    private int $port = 0;
    private int $pid = 0;
    /** @var resource|null */
    private $process = null;
    /** @var array<int, array{socket: resource, deadline: float}> */
    private array $requests = [];

    public function __construct(
        string $cgiBinary,
        string $projectRoot,
        string $storageDir,
        string $dbPath,
        ?string $prependFile = null
    ) {
        $this->cgiBinary = $cgiBinary;
        $this->projectRoot = $projectRoot;
        $this->storageDir = $storageDir;
        $this->dbPath = $dbPath;
        $this->prependFile = $prependFile;
    }

    public function __destruct()
    {
        $this->stop();
    }

    public function start(): void
    {
        if (is_resource($this->process)) {
            if (proc_get_status($this->process)['running']) {
                return;
            }
            $this->stop();
        }

        $publicRoot = realpath($this->projectRoot . DIRECTORY_SEPARATOR . 'public');
        $storageDir = realpath($this->storageDir);
        if ($publicRoot === false || !is_dir($publicRoot)
            || $storageDir === false || !is_dir($storageDir)) {
            throw new RuntimeException('FastCGI requires an existing public directory and prepared storage.');
        }
        $this->publicRoot = $publicRoot;
        $this->storageDir = $storageDir;
        $sessionDir = $storageDir . DIRECTORY_SEPARATOR . 'sessions';
        if (!is_dir($sessionDir) && !@mkdir($sessionDir, 0700, true) && !is_dir($sessionDir)) {
            throw new RuntimeException('Unable to prepare the FastCGI session directory.');
        }
        // Resolve relative database paths against the caller, not the child cwd.
        $dbDirectory = realpath(dirname($this->dbPath));
        if ($dbDirectory === false) {
            throw new RuntimeException('FastCGI requires a prepared database directory.');
        }
        $dbPath = $dbDirectory . DIRECTORY_SEPARATOR . basename($this->dbPath);
        $prependFile = null;
        if ($this->prependFile !== null) {
            $prependFile = realpath($this->prependFile);
            if ($prependFile === false || !is_file($prependFile)) {
                throw new RuntimeException('The FastCGI prepend file is unavailable.');
            }
        }

        $reservation = @stream_socket_server('tcp://' . self::HOST . ':0', $errno, $error);
        if ($reservation === false) {
            throw new RuntimeException('Unable to reserve a loopback port for FastCGI.');
        }
        $address = stream_socket_get_name($reservation, false);
        $this->port = $address === false ? 0 : (int)substr($address, strrpos($address, ':') + 1);
        fclose($reservation);
        if ($this->port === 0) {
            throw new RuntimeException('Unable to determine the reserved FastCGI port.');
        }

        try {
            $logPath = $storageDir . DIRECTORY_SEPARATOR . 'fastcgi_' . bin2hex(random_bytes(8)) . '.log';
            $command = [
                $this->cgiBinary,
                '-d', 'opcache.enable=0',
                '-d', 'display_errors=0',
                '-d', 'log_errors=1',
                '-d', 'error_log=' . $logPath,
                '-d', 'session.save_path=' . $sessionDir,
            ];
            if ($prependFile !== null) {
                $command[] = '-d';
                $command[] = 'auto_prepend_file=' . $prependFile;
            }
            $command[] = '-b';
            $command[] = self::HOST . ':' . $this->port;
            $parentEnvironment = getenv();
            $environment = array_merge(is_array($parentEnvironment) ? $parentEnvironment : [], [
                'NETARIUM_STORAGE_DIR' => $storageDir,
                'NETARIUM_DB_FILE' => $dbPath,
                // A worker must not fork children or retire halfway through a scenario.
                'PHP_FCGI_CHILDREN' => '0',
                'PHP_FCGI_MAX_REQUESTS' => '0',
            ]);
            $nullDevice = PHP_OS_FAMILY === 'Windows' ? 'NUL' : '/dev/null';
            $descriptors = [
                0 => ['file', $nullDevice, 'r'],
                1 => ['file', $logPath, 'a'],
                2 => ['file', $logPath, 'a'],
            ];
            $pipes = [];
            $this->process = @proc_open(
                $command,
                $descriptors,
                $pipes,
                $this->projectRoot,
                $environment,
                ['bypass_shell' => true]
            );
            if (!is_resource($this->process)) {
                throw new RuntimeException('Unable to launch the FastCGI worker.');
            }
            $status = proc_get_status($this->process);
            $this->pid = (int)$status['pid'];
            $deadline = microtime(true) + self::START_TIMEOUT;
            do {
                if (!proc_get_status($this->process)['running']) {
                    throw new RuntimeException('The FastCGI worker exited during startup.');
                }
                $socket = @stream_socket_client(
                    'tcp://' . self::HOST . ':' . $this->port,
                    $errno,
                    $error,
                    0.1
                );
                if ($socket !== false) {
                    try {
                        // GET_VALUES verifies a FastCGI response without executing the app.
                        $this->sendRecord($socket, 9, $this->encodeParams(['FCGI_MAX_CONNS' => '']), $deadline, 0);
                        [$type, $requestId] = $this->readRecord($socket, $deadline);
                        if ($type !== 10 || $requestId !== 0) {
                            throw new RuntimeException('Unexpected FastCGI startup response.');
                        }
                    } finally {
                        fclose($socket);
                    }
                    return;
                }
                usleep(20000);
            } while (microtime(true) < $deadline);
            throw new RuntimeException('Timed out waiting for the FastCGI worker.');
        } catch (Throwable $exception) {
            $this->stop();
            throw $exception;
        }
    }

    public function stop(): void
    {
        foreach ($this->requests as $request) {
            if (is_resource($request['socket'])) {
                fclose($request['socket']);
            }
        }
        $this->requests = [];
        if (is_resource($this->process)) {
            if (proc_get_status($this->process)['running']) {
                @proc_terminate($this->process);
                $deadline = microtime(true) + 2.0;
                while (proc_get_status($this->process)['running'] && microtime(true) < $deadline) {
                    usleep(20000);
                }
                if (proc_get_status($this->process)['running']) {
                    @proc_terminate($this->process, 9);
                }
            }
            @proc_close($this->process);
        }
        $this->process = null;
        $this->pid = 0;
        $this->port = 0;
    }

    public function getPid(): int
    {
        if (!is_resource($this->process) || !proc_get_status($this->process)['running']) {
            throw new RuntimeException('The FastCGI worker is not running.');
        }
        return $this->pid;
    }

    /** @return resource */
    public function begin(string $path, string $method = 'GET', array $fields = [], string $cookie = '')
    {
        $this->getPid();
        $url = parse_url($path);
        if ($url === false || isset($url['scheme']) || isset($url['host']) || isset($url['fragment'])) {
            throw new RuntimeException('FastCGI requests require a local path and optional query.');
        }
        $scriptName = $url['path'] ?? '/';
        if ($scriptName === '/') {
            $scriptName = '/index.php';
        }
        $filename = realpath($this->publicRoot . DIRECTORY_SEPARATOR . ltrim(rawurldecode($scriptName), '/'));
        $prefix = $this->publicRoot . DIRECTORY_SEPARATOR;
        $insidePublic = $filename !== false && (PHP_OS_FAMILY === 'Windows'
            ? strncasecmp($filename, $prefix, strlen($prefix)) === 0
            : strncmp($filename, $prefix, strlen($prefix)) === 0);
        if (!$insidePublic || !is_file($filename) || strtolower(pathinfo($filename, PATHINFO_EXTENSION)) !== 'php') {
            throw new RuntimeException('The FastCGI request must target a PHP file inside public.');
        }
        $method = strtoupper($method);
        $query = $url['query'] ?? '';
        $encodedFields = http_build_query($fields, '', '&', PHP_QUERY_RFC3986);
        $body = '';
        if ($method === 'GET') {
            if ($encodedFields !== '') {
                $query .= ($query === '' ? '' : '&') . $encodedFields;
            }
        } else {
            $body = $encodedFields;
        }
        $requestPath = $url['path'] ?? '/';
        $params = [
            'GATEWAY_INTERFACE' => 'CGI/1.1',
            'SCRIPT_FILENAME' => $filename,
            'SCRIPT_NAME' => $scriptName,
            'DOCUMENT_ROOT' => $this->publicRoot,
            'REQUEST_URI' => $requestPath . ($query === '' ? '' : '?' . $query),
            'REQUEST_METHOD' => $method,
            'QUERY_STRING' => $query,
            'SERVER_PROTOCOL' => 'HTTP/1.1',
            'SERVER_NAME' => 'localhost',
            'SERVER_PORT' => (string)$this->port,
            'REMOTE_ADDR' => self::HOST,
            'CONTENT_TYPE' => $method === 'GET' ? '' : 'application/x-www-form-urlencoded',
            'CONTENT_LENGTH' => (string)strlen($body),
            'HTTP_COOKIE' => $cookie,
        ];
        // Storage, database and other environment configuration stay process-owned.
        $deadline = microtime(true) + self::REQUEST_TIMEOUT;
        $socket = @stream_socket_client(
            'tcp://' . self::HOST . ':' . $this->port,
            $errno,
            $error,
            self::REQUEST_TIMEOUT
        );
        if ($socket === false) {
            throw new RuntimeException('Unable to connect to the FastCGI worker.');
        }
        try {
            $this->sendRecord($socket, 1, pack('nCxxxxx', 1, 0), $deadline);
            $this->sendStream($socket, 4, $this->encodeParams($params), $deadline);
            $this->sendStream($socket, 5, $body, $deadline);
            $this->requests[(int)$socket] = ['socket' => $socket, 'deadline' => $deadline];
            return $socket;
        } catch (Throwable $exception) {
            fclose($socket);
            throw $exception;
        }
    }

    /**
     * Header names are lowercase. Duplicate names retain the last value, including
     * Set-Cookie (never comma-joined); this helper needs only the app session cookie.
     *
     * @param resource $socket
     * @return array{status: int, headers: array<string, string>, body: string, stderr: string}
     */
    public function finish($socket): array
    {
        if (!is_resource($socket) || !isset($this->requests[(int)$socket])
            || $this->requests[(int)$socket]['socket'] !== $socket) {
            throw new RuntimeException('The socket is not an outstanding request of this worker.');
        }
        $key = (int)$socket;
        $deadline = $this->requests[$key]['deadline'];
        $stdout = '';
        $stderr = '';
        try {
            while (true) {
                [$type, $requestId, $content] = $this->readRecord($socket, $deadline);
                if ($requestId !== self::REQUEST_ID) {
                    throw new RuntimeException('Unexpected FastCGI response request ID.');
                }
                if ($type === 6) {
                    $stdout .= $content;
                } elseif ($type === 7) {
                    $stderr .= $content;
                } elseif ($type === 3) {
                    if (strlen($content) !== 8) {
                        throw new RuntimeException('Malformed FastCGI END_REQUEST.');
                    }
                    $end = unpack('NappStatus/CprotocolStatus', $content);
                    if ($end['appStatus'] !== 0 || $end['protocolStatus'] !== 0) {
                        // Never include response, request fields or environment secrets in exceptions.
                        throw new RuntimeException(sprintf(
                            'FastCGI END_REQUEST failed (application=%d, protocol=%d).',
                            $end['appStatus'],
                            $end['protocolStatus']
                        ));
                    }
                    return $this->parseResponse($stdout, $stderr);
                } else {
                    throw new RuntimeException('Unexpected FastCGI response record type.');
                }
            }
        } finally {
            unset($this->requests[$key]);
            fclose($socket);
        }
    }

    /** @return array{status: int, headers: array<string, string>, body: string, stderr: string} */
    public function request(string $path, string $method = 'GET', array $fields = [], string $cookie = ''): array
    {
        return $this->finish($this->begin($path, $method, $fields, $cookie));
    }

    private function encodeParams(array $params): string
    {
        $encoded = '';
        foreach ($params as $name => $value) {
            $nameLength = strlen($name);
            $valueLength = strlen($value);
            $encoded .= ($nameLength < 128 ? chr($nameLength) : pack('N', $nameLength | 0x80000000))
                . ($valueLength < 128 ? chr($valueLength) : pack('N', $valueLength | 0x80000000))
                . $name . $value;
        }
        return $encoded;
    }

    private function sendStream($socket, int $type, string $content, float $deadline): void
    {
        $length = strlen($content);
        for ($offset = 0; $offset < $length; $offset += 65535) {
            $this->sendRecord($socket, $type, substr($content, $offset, 65535), $deadline);
        }
        $this->sendRecord($socket, $type, '', $deadline);
    }

    private function sendRecord($socket, int $type, string $content, float $deadline, int $requestId = self::REQUEST_ID): void
    {
        $length = strlen($content);
        if ($length > 65535) {
            throw new RuntimeException('FastCGI record exceeds the protocol length limit.');
        }
        $padding = (8 - ($length % 8)) % 8;
        $record = pack('CCnnCC', 1, $type, $requestId, $length, $padding, 0)
            . $content . str_repeat("\0", $padding);
        $length = strlen($record);
        $offset = 0;
        while ($offset < $length) {
            $this->setSocketTimeout($socket, $deadline);
            $written = @fwrite($socket, substr($record, $offset));
            if ($written === false || $written === 0) {
                $this->throwSocketFailure($socket, 'writing');
            }
            $offset += $written;
        }
    }

    /** @return array{int, int, string} */
    private function readRecord($socket, float $deadline): array
    {
        $header = unpack('Cversion/Ctype/nrequestId/nlength/Cpadding/Creserved', $this->readBytes($socket, 8, $deadline));
        if ($header['version'] !== 1) {
            throw new RuntimeException('Unsupported FastCGI response version.');
        }
        $content = $this->readBytes($socket, $header['length'], $deadline);
        $this->readBytes($socket, $header['padding'], $deadline);
        return [$header['type'], $header['requestId'], $content];
    }

    private function readBytes($socket, int $length, float $deadline): string
    {
        $bytes = '';
        while (strlen($bytes) < $length) {
            $this->setSocketTimeout($socket, $deadline);
            $chunk = @fread($socket, $length - strlen($bytes));
            if ($chunk === false || $chunk === '') {
                $this->throwSocketFailure($socket, 'reading');
            }
            $bytes .= $chunk;
        }
        return $bytes;
    }

    private function setSocketTimeout($socket, float $deadline): void
    {
        $remaining = $deadline - microtime(true);
        if ($remaining <= 0) {
            throw new RuntimeException('Timed out waiting for FastCGI transport.');
        }
        $seconds = (int)$remaining;
        stream_set_timeout($socket, $seconds, max(1, (int)(($remaining - $seconds) * 1000000)));
    }

    private function throwSocketFailure($socket, string $operation): void
    {
        $metadata = stream_get_meta_data($socket);
        if ($metadata['timed_out']) {
            throw new RuntimeException('Timed out ' . $operation . ' FastCGI transport.');
        }
        if (feof($socket)) {
            throw new RuntimeException('Unexpected EOF ' . $operation . ' FastCGI transport.');
        }
        throw new RuntimeException('Failed ' . $operation . ' FastCGI transport.');
    }

    private function parseResponse(string $stdout, string $stderr): array
    {
        if (!preg_match('/\r?\n\r?\n/', $stdout, $separator, PREG_OFFSET_CAPTURE)) {
            throw new RuntimeException('FastCGI stdout is missing the CGI header terminator.');
        }
        $offset = $separator[0][1];
        $headers = [];
        $status = null;
        foreach (preg_split('/\r?\n/', substr($stdout, 0, $offset)) as $line) {
            $colon = strpos($line, ':');
            if ($colon === false) {
                throw new RuntimeException('Malformed CGI response header.');
            }
            $name = strtolower(trim(substr($line, 0, $colon)));
            $value = ltrim(substr($line, $colon + 1), " \t");
            if ($name === 'status') {
                if (!preg_match('/^([1-5][0-9]{2})(?:\s|$)/', $value, $match)) {
                    throw new RuntimeException('Malformed CGI response status.');
                }
                $status = (int)$match[1];
            }
            $headers[$name] = $value;
        }
        return [
            'status' => $status ?? (isset($headers['location']) ? 302 : 200),
            'headers' => $headers,
            'body' => substr($stdout, $offset + strlen($separator[0][0])),
            'stderr' => $stderr,
        ];
    }
}
