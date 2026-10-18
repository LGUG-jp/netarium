<?php
declare(strict_types=1);

namespace Netarium\Tests\Suites;

use Netarium\Tests\TestCase;
use Netarium\Tests\TestHttpClient;
use Netarium\Tests\TestResponse;
use Netarium\Tests\TestServer;

class TransportSecurityTest extends TestCase
{
    public function testStrictConfigurationAndTransportTrustBoundary(): void
    {
        $root = sys_get_temp_dir() . '/netarium_transport_' . bin2hex(random_bytes(8));
        mkdir($root . '/src/Core', 0700, true);
        mkdir($root . '/config', 0700);
        foreach (['Config', 'TransportSecurity'] as $class) {
            copy(dirname(__DIR__, 2) . '/src/Core/' . $class . '.php', $root . '/src/Core/' . $class . '.php');
        }
        try {
            $valid = [
                [],
                ['hsts_max_age' => null], ['hsts_max_age' => 0], ['hsts_max_age' => 31536000],
                ['csp_report_only' => false], ['csp_report_only' => true],
                ['trusted_https_proxies' => ['127.0.0.1', '::1', '192.0.2.1']],
            ];
            foreach ($valid as $config) {
                $result = $this->configurationProcess($root, $config, []);
                $this->assertSame(true, $result['valid']);
            }
            $defaults = $this->configurationProcess($root, [], [])['config'];
            $this->assertSame([], $defaults['trusted_https_proxies']);
            $this->assertNull($defaults['hsts_max_age']);
            $this->assertSame(false, $defaults['csp_report_only']);
            foreach ([
                ['hsts_max_age' => -1], ['hsts_max_age' => 31536001],
                ['hsts_max_age' => '0'], ['hsts_max_age' => 1.0], ['hsts_max_age' => false],
                ['csp_report_only' => 0], ['csp_report_only' => 'false'], ['csp_report_only' => null],
                ['trusted_https_proxies' => null], ['trusted_https_proxies' => '127.0.0.1'],
                ['trusted_https_proxies' => ['localhost']], ['trusted_https_proxies' => ['192.0.2.0/24']],
                ['trusted_https_proxies' => [' 127.0.0.1']], ['trusted_https_proxies' => [123]],
                ['trusted_https_proxies' => ['proxy' => '127.0.0.1']],
            ] as $config) {
                $this->assertSame(false, $this->configurationProcess($root, $config, [])['valid']);
            }
            foreach ([
                [[], [], false],
                [[], ['HTTPS' => 'on', 'SERVER_PORT' => '8443'], true],
                [[], ['HTTPS' => '1'], true],
                [[], ['HTTPS' => 'off', 'SERVER_PORT' => '443'], false],
                [[], ['HTTPS' => 'true'], false],
                [[], ['REMOTE_ADDR' => '127.0.0.1', 'HTTP_X_FORWARDED_PROTO' => 'https'], false],
                [['127.0.0.1'], ['REMOTE_ADDR' => '127.0.0.2', 'HTTP_X_FORWARDED_PROTO' => 'https'], false],
                [['127.0.0.1'], ['REMOTE_ADDR' => '127.0.0.1', 'HTTP_X_FORWARDED_PROTO' => 'https'], true],
                [['::1'], ['REMOTE_ADDR' => '::1', 'HTTP_X_FORWARDED_PROTO' => 'https'], true],
                [['127.0.0.1'], ['REMOTE_ADDR' => '127.0.0.1', 'HTTP_X_FORWARDED_PROTO' => 'http'], false],
                [['127.0.0.1'], ['REMOTE_ADDR' => '127.0.0.1', 'HTTP_FORWARDED' => 'proto=https'], false],
                [['127.0.0.1'], ['REMOTE_ADDR' => '127.0.0.1', 'HTTPS' => 'on', 'HTTP_X_FORWARDED_PROTO' => 'http'], false],
                [['127.0.0.1'], ['REMOTE_ADDR' => '127.0.0.1', 'HTTPS' => 'on', 'HTTP_X_FORWARDED_PROTO' => 'https'], true],
                [['127.0.0.1'], ['REMOTE_ADDR' => '127.0.0.1', 'HTTPS' => 'on'], false],
                [['127.0.0.1'], ['REMOTE_ADDR' => '127.0.0.2', 'HTTPS' => 'on', 'HTTP_X_FORWARDED_PROTO' => 'http'], true],
            ] as [$proxies, $server, $expected]) {
                $this->assertSame($expected, $this->configurationProcess($root, ['trusted_https_proxies' => $proxies], $server)['https']);
            }
            foreach (['HTTPS', ' https', 'https ', 'https,http', 'https, https', '', 'ftp'] as $proto) {
                $this->assertSame(false, $this->configurationProcess($root,
                    ['trusted_https_proxies' => ['127.0.0.1']],
                    ['REMOTE_ADDR' => '127.0.0.1', 'HTTPS' => 'on', 'HTTP_X_FORWARDED_PROTO' => $proto])['https']);
            }
        } finally {
            unlink($root . '/config/app.php');
            foreach (['Config', 'TransportSecurity'] as $class) unlink($root . '/src/Core/' . $class . '.php');
            rmdir($root . '/src/Core');
            rmdir($root . '/src');
            rmdir($root . '/config');
            rmdir($root);
        }
    }

    private function configurationProcess(string $root, array $config, array $server): array
    {
        file_put_contents($root . '/config/app.php', '<?php return ' . var_export($config, true) . ';');
        $script = 'require $argv[1] . "/src/Core/Config.php"; require $argv[1] . "/src/Core/TransportSecurity.php";'
            . '$_SERVER = json_decode($argv[2], true); try { $config = \\Netarium\\Core\\Config::create();'
            . 'echo json_encode(["valid" => true, "config" => $config, "https" => \\Netarium\\Core\\TransportSecurity::isHttps()]);'
            . '} catch (RuntimeException $e) { echo json_encode(["valid" => false]); }';
        $process = proc_open([PHP_BINARY, '-r', $script, $root, json_encode($server, JSON_THROW_ON_ERROR)],
            [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
        $this->assertTrue(is_resource($process));
        fclose($pipes[0]);
        $output = stream_get_contents($pipes[1]) . stream_get_contents($pipes[2]);
        fclose($pipes[1]);
        fclose($pipes[2]);
        $this->assertSame(0, proc_close($process), $output);
        return json_decode($output, true, 512, JSON_THROW_ON_ERROR);
    }

    public function testCookieCoexistenceSwitchingLogoutAndTimeout(): void
    {
        // 合成HTTPSはPHPの分岐と応答属性だけを検証する。実TLS、IIS、ブラウザのprefix受理は別途受入する。
        $prepend = tempnam(sys_get_temp_dir(), 'net_transport_');
        file_put_contents($prepend, '<?php if (($_SERVER["HTTP_X_NETARIUM_TEST_HTTPS"] ?? "") === "on") { $_SERVER["HTTPS"] = "on"; }');
        $server = new TestServer(null, $prepend);
        try {
            $server->start();
            $client = new TestHttpClient($server->getBaseUrl());
            $forged = $client->get('/login.php', ['X-Forwarded-Proto' => 'https', 'Forwarded' => 'proto=https']);
            $this->assertCookieAttributes((string)$forged->getHeader('Set-Cookie'), false);
            [$httpId] = $this->signIn($client, false);
            $httpCookie = 'netarium_session=' . $httpId;
            $this->load($client, false, $httpCookie)->assertOk();
            $this->load($client, false, $httpCookie . '; __Host-netarium_session=unrelated')->assertOk();
            $this->load($client, true, '__Host-netarium_session=' . $httpId)->assertStatus(401);
            $this->load($client, false, $httpCookie)->assertOk();

            [$httpsId] = $this->signIn($client, true);
            $httpsCookie = '__Host-netarium_session=' . $httpsId;
            $this->load($client, true, $httpsCookie)->assertOk();
            $this->load($client, false, 'netarium_session=' . $httpsId)->assertStatus(401);
            $this->load($client, true, $httpsCookie)->assertOk();
            $alias = $this->load($client, true, $httpsCookie . '; netarium_session=' . $httpsId)->assertOk();
            $this->assertStringContains('netarium_session=deleted', (string)$alias->getHeader('Set-Cookie'));
            $coexisting = $this->load($client, true, $httpsCookie . '; ' . $httpCookie)->assertOk();
            $this->assertStringContains('netarium_session=deleted', (string)$coexisting->getHeader('Set-Cookie'));
            $this->load($client, false, $httpCookie)->assertStatus(401);
            $this->load($client, true, $httpsCookie)->assertOk();
            // マーカーのない既存HTTPセッションは保持し、既存HTTPS legacy Cookieは失効する。
            [$legacyId] = $this->signIn($client, false);
            $legacyFile = $server->getTempDir() . '/sessions/sess_' . $legacyId;
            file_put_contents($legacyFile, preg_replace('/transport\|s:4:"http";/', '', file_get_contents($legacyFile)));
            $this->load($client, false, 'netarium_session=' . $legacyId)->assertOk();
            file_put_contents($legacyFile, preg_replace('/transport\|s:4:"http";/', '', file_get_contents($legacyFile)));
            $this->load($client, true, '__Host-netarium_session=' . $legacyId)->assertStatus(401);
            $this->load($client, true, 'netarium_session=' . $legacyId)->assertStatus(401);
            $this->load($client, false, 'netarium_session=' . $legacyId)->assertStatus(401);

            foreach ([false, true] as $https) {
                [$id, $token] = $this->signIn($client, $https);
                $cookie = ($https ? '__Host-netarium_session=' : 'netarium_session=') . $id;
                $client->clearCookies();
                $logout = $client->postForm('/logout.php', ['csrf_token' => $token], $this->headers($https, $cookie));
                $logout->assertStatus(302);
                $this->assertCookieAttributes((string)$logout->getHeader('Set-Cookie'), $https);
                $this->load($client, $https, $cookie)->assertStatus(401);
                [$id] = $this->signIn($client, $https);
                $file = $server->getTempDir() . '/sessions/sess_' . $id;
                file_put_contents($file, preg_replace('/last_activity\|i:\d+;/', 'last_activity|i:' . (time() - 3601) . ';', file_get_contents($file)));
                $cookie = ($https ? '__Host-netarium_session=' : 'netarium_session=') . $id;
                $this->load($client, $https, $cookie)->assertStatus(401);
                $this->load($client, $https, $cookie)->assertStatus(401);
                [$id] = $this->signIn($client, $https);
                $file = $server->getTempDir() . '/sessions/sess_' . $id;
                file_put_contents($file, preg_replace('/authenticated_at\|i:\d+;/', 'authenticated_at|i:' . (time() - 43201) . ';', file_get_contents($file)));
                $cookie = ($https ? '__Host-netarium_session=' : 'netarium_session=') . $id;
                $this->load($client, $https, $cookie)->assertStatus(401);
                $this->load($client, $https, $cookie)->assertStatus(401);
            }
        } finally {
            $server->stop();
            unlink($prepend);
        }
    }

    private function headers(bool $https, string $cookie = ''): array
    {
        return ['X-Netarium-Test-Https' => $https ? 'on' : 'off', 'Cookie' => $cookie];
    }

    private function load(TestHttpClient $client, bool $https, string $cookie): TestResponse
    {
        $client->clearCookies();
        return $client->get('/api.php?action=load', $this->headers($https, $cookie));
    }

    private function signIn(TestHttpClient $client, bool $https): array
    {
        $client->clearCookies();
        $page = $client->get('/login.php', $this->headers($https));
        $name = $https ? '__Host-netarium_session' : 'netarium_session';
        $this->assertCookieAttributes((string)$page->getHeader('Set-Cookie'), $https);
        preg_match('/' . preg_quote($name, '/') . '=([^; ,]+)/', (string)$page->getHeader('Set-Cookie'), $id);
        $this->assertTrue(isset($id[1]));
        preg_match('/name="csrf_token"\s+value="([^"]+)"/', $page->getBody(), $token);
        $this->assertTrue(isset($token[1]));
        $client->clearCookies();
        $login = $client->postForm('/login.php', [
            'csrf_token' => $token[1], 'username' => 'admin', 'password' => 'admin123',
        ], $this->headers($https, $name . '=' . $id[1]));
        $login->assertStatus(302);
        $this->assertCookieAttributes((string)$login->getHeader('Set-Cookie'), $https);
        preg_match('/' . preg_quote($name, '/') . '=([^; ,]+)/', (string)$login->getHeader('Set-Cookie'), $signedId);
        $this->assertTrue(isset($signedId[1]));
        $client->clearCookies();
        $landing = $client->get('/index.php', $this->headers($https, $name . '=' . $signedId[1]));
        $landing->assertStatus(200);
        preg_match('/csrfToken:\s*"([a-f0-9]+)"/', $landing->getBody(), $signedToken);
        $this->assertTrue(isset($signedToken[1]));
        return [$signedId[1], $signedToken[1]];
    }

    private function assertCookieAttributes(string $header, bool $https): void
    {
        $this->assertStringContains(($https ? '__Host-netarium_session' : 'netarium_session') . '=', $header);
        $this->assertStringContains('path=/', strtolower($header));
        $this->assertStringContains('httponly', strtolower($header));
        $this->assertStringContains('samesite=strict', strtolower($header));
        $this->assertFalse(str_contains(strtolower($header), 'domain='));
        $this->assertSame($https, preg_match('/;\s*secure(?:;|$)/i', $header) === 1);
        if (!$https) $this->assertFalse(str_contains($header, '__Host-netarium_session='));
    }
}
