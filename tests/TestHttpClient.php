<?php
declare(strict_types=1);

namespace Netarium\Tests;

use CURLFile;
use RuntimeException;

class TestResponse
{
    private int $statusCode;
    private array $headers;
    private string $body;
    private ?array $json = null;
    private bool $jsonParsed = false;

    public function __construct(int $statusCode, array $headers, string $body)
    {
        $this->statusCode = $statusCode;
        $this->headers = $headers;
        $this->body = $body;
    }

    public function getStatusCode(): int
    {
        return $this->statusCode;
    }

    public function getHeaders(): array
    {
        return $this->headers;
    }

    public function getHeader(string $name): ?string
    {
        $lowerName = strtolower($name);
        foreach ($this->headers as $key => $value) {
            if (strtolower((string)$key) === $lowerName) {
                return is_array($value) ? implode(', ', $value) : (string)$value;
            }
        }
        return null;
    }

    public function getBody(): string
    {
        return $this->body;
    }

    public function getJson(): ?array
    {
        if (!$this->jsonParsed) {
            $decoded = json_decode($this->body, true);
            $this->json = is_array($decoded) ? $decoded : null;
            $this->jsonParsed = true;
        }
        return $this->json;
    }

    public function assertStatus(int $expectedStatus): self
    {
        if ($this->statusCode !== $expectedStatus) {
            $bodyPreview = mb_substr($this->body, 0, 300);
            throw new TestAssertionException(
                "Expected HTTP status {$expectedStatus}, but received {$this->statusCode}. Response body preview:\n{$bodyPreview}"
            );
        }
        return $this;
    }

    public function assertOk(): self
    {
        $this->assertStatus(200);
        $json = $this->getJson();
        if ($json === null) {
            throw new TestAssertionException("Expected JSON response with 'ok' => true, but body is not valid JSON:\n" . mb_substr($this->body, 0, 300));
        }
        if (($json['ok'] ?? null) !== true) {
            $errorMsg = $json['error'] ?? 'Unknown error';
            throw new TestAssertionException("Expected response JSON 'ok' to be true, but got false. Error: {$errorMsg}");
        }
        return $this;
    }

    public function assertError(int $expectedStatus, ?string $expectedErrorSubstring = null): self
    {
        $this->assertStatus($expectedStatus);
        $json = $this->getJson();
        if ($json === null) {
            throw new TestAssertionException("Expected JSON response with error, but body is not valid JSON:\n" . mb_substr($this->body, 0, 300));
        }
        if (($json['ok'] ?? null) !== false) {
            throw new TestAssertionException("Expected response JSON 'ok' to be false, but was true.");
        }
        if ($expectedErrorSubstring !== null) {
            $errorMsg = (string)($json['error'] ?? '');
            if (!str_contains($errorMsg, $expectedErrorSubstring)) {
                throw new TestAssertionException("Expected error message to contain '{$expectedErrorSubstring}', but got '{$errorMsg}'.");
            }
        }
        return $this;
    }
}

class TestHttpClient
{
    private string $baseUrl;
    public string $cookieFile;
    private ?string $csrfToken = null;
    private int $timeout = 15;

    public function __construct(string $baseUrl)
    {
        $this->baseUrl = rtrim($baseUrl, '/');
        $this->cookieFile = tempnam(sys_get_temp_dir(), 'net_ck_');
    }

    public function __destruct()
    {
        if (file_exists($this->cookieFile)) {
            @unlink($this->cookieFile);
        }
    }

    public function getBaseUrl(): string
    {
        return $this->baseUrl;
    }

    public function getCsrfToken(): ?string
    {
        return $this->csrfToken;
    }

    public function setCsrfToken(?string $token): void
    {
        $this->csrfToken = $token;
    }

    public function setTimeout(int $timeout): void
    {
        $this->timeout = $timeout;
    }

    public function getTimeout(): int
    {
        return $this->timeout;
    }

    public function clearCookies(): void
    {
        if (file_exists($this->cookieFile)) {
            @unlink($this->cookieFile);
        }
        $this->cookieFile = tempnam(sys_get_temp_dir(), 'net_ck_');
        $this->csrfToken = null;
    }

    public function login(string $username, string $password): bool
    {
        // 1. GET login.php to receive initial session cookie and CSRF token
        $loginPage = $this->get('/login.php');
        if (!preg_match('/name="csrf_token"\s+value="([^"]+)"/', $loginPage->getBody(), $matches)) {
            throw new RuntimeException("Failed to find csrf_token on login.php");
        }
        $formCsrfToken = $matches[1];

        // 2. POST login credentials
        $response = $this->postForm('/login.php', [
            'csrf_token' => $formCsrfToken,
            'username' => $username,
            'password' => $password,
        ]);

        if ($response->getStatusCode() !== 302) {
            return false;
        }

        // ログイン後の通常画面または初回変更画面から、そのセッションのCSRFを取得する。
        $landingPage = $this->get('/' . ($response->getHeader('Location') ?? 'index.php'));
        if (preg_match('/csrfToken:\s*"([a-f0-9]+)"/', $landingPage->getBody(), $matches)
            || preg_match('/name="csrf_token"\s+value="([^"]+)"/', $landingPage->getBody(), $matches)) {
            $this->csrfToken = $matches[1];
        }

        return true;
    }

    public function get(string $path, array $headers = []): TestResponse
    {
        return $this->request('GET', $path, [], $headers);
    }

    public function postJson(string $path, array $data, array $headers = []): TestResponse
    {
        $headers['Content-Type'] = 'application/json';
        if ($this->csrfToken !== null && !isset($headers['X-CSRF-Token'])) {
            $headers['X-CSRF-Token'] = $this->csrfToken;
        }
        return $this->request('POST', $path, json_encode($data, JSON_UNESCAPED_UNICODE), $headers);
    }

    public function postForm(string $path, array $fields, array $headers = []): TestResponse
    {
        $headers['Content-Type'] = 'application/x-www-form-urlencoded';
        if ($this->csrfToken !== null && !isset($headers['X-CSRF-Token'])) {
            $headers['X-CSRF-Token'] = $this->csrfToken;
        }
        return $this->request('POST', $path, http_build_query($fields), $headers);
    }

    public function postMultipart(string $path, array $fields = [], array $files = [], array $headers = []): TestResponse
    {
        if ($this->csrfToken !== null && !isset($headers['X-CSRF-Token'])) {
            $headers['X-CSRF-Token'] = $this->csrfToken;
        }

        $postData = $fields;
        foreach ($files as $paramName => $fileInfo) {
            if ($fileInfo instanceof CURLFile) {
                $postData[$paramName] = $fileInfo;
            } elseif (is_array($fileInfo)) {
                $filePath = $fileInfo['path'];
                $mimeType = $fileInfo['type'] ?? 'application/octet-stream';
                $postName = $fileInfo['filename'] ?? basename($filePath);
                $postData[$paramName] = new CURLFile($filePath, $mimeType, $postName);
            } elseif (is_string($fileInfo)) {
                $postData[$paramName] = new CURLFile($fileInfo);
            }
        }

        return $this->request('POST', $path, $postData, $headers);
    }

    public function request(string $method, string $path, mixed $body = null, array $headers = []): TestResponse
    {
        $url = str_starts_with($path, 'http') ? $path : $this->baseUrl . '/' . ltrim($path, '/');
        $ch = curl_init($url);

        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_HEADER, true);
        curl_setopt($ch, CURLOPT_CUSTOMREQUEST, $method);
        curl_setopt($ch, CURLOPT_FOLLOWLOCATION, false);
        curl_setopt($ch, CURLOPT_TIMEOUT, $this->timeout);

        // Format headers
        $formattedHeaders = [];
        foreach ($headers as $k => $v) {
            $formattedHeaders[] = is_numeric($k) ? $v : "{$k}: {$v}";
        }

        // Cookie handling via cURL
        curl_setopt($ch, CURLOPT_COOKIEJAR, $this->cookieFile);
        curl_setopt($ch, CURLOPT_COOKIEFILE, $this->cookieFile);

        if ($formattedHeaders !== []) {
            curl_setopt($ch, CURLOPT_HTTPHEADER, $formattedHeaders);
        }

        // Body handling
        if ($method === 'POST') {
            if ($body !== null && $body !== '') {
                curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
            }
        }

        $rawResponse = curl_exec($ch);
        if ($rawResponse === false) {
            $curlError = curl_error($ch);
            curl_close($ch);
            throw new RuntimeException("cURL error connecting to {$url}: {$curlError}");
        }

        $statusCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $headerSize = curl_getinfo($ch, CURLINFO_HEADER_SIZE);
        curl_close($ch);

        $rawHeaderStr = substr((string)$rawResponse, 0, $headerSize);
        $responseBody = substr((string)$rawResponse, $headerSize);

        $parsedHeaders = $this->parseHeaders($rawHeaderStr);

        return new TestResponse($statusCode, $parsedHeaders, $responseBody);
    }

    private function parseHeaders(string $rawHeaderStr): array
    {
        $lines = preg_split('/\r?\n/', trim($rawHeaderStr));
        $parsed = [];

        foreach ($lines as $line) {
            if ($line === '' || str_starts_with($line, 'HTTP/')) {
                continue;
            }
            $parts = explode(':', $line, 2);
            if (count($parts) === 2) {
                $headerName = trim($parts[0]);
                $headerValue = trim($parts[1]);

                if (strtolower($headerName) === 'set-cookie') {
                    $this->parseSetCookie($headerValue);
                }

                if (!isset($parsed[$headerName])) {
                    $parsed[$headerName] = $headerValue;
                } elseif (is_array($parsed[$headerName])) {
                    $parsed[$headerName][] = $headerValue;
                } else {
                    $parsed[$headerName] = [$parsed[$headerName], $headerValue];
                }
            }
        }

        return $parsed;
    }

    private function parseSetCookie(string $headerValue): void
    {
        $parts = explode(';', $headerValue);
        $cookiePair = trim($parts[0]);
        $cookieParts = explode('=', $cookiePair, 2);
        if (count($cookieParts) === 2) {
            $cookieName = trim($cookieParts[0]);
            $cookieValue = trim($cookieParts[1]);
            $this->cookies[$cookieName] = $cookieValue;
        }
    }
}
