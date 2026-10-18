<?php
declare(strict_types=1);

namespace Netarium\Tests\Suites;

use Netarium\Tests\TestCase;
use Netarium\Tests\TestHttpClient;
use Netarium\Tests\TestServer;

final class SecurityHeadersTest extends TestCase
{
    public function __construct(private TestHttpClient $client) {}

    public function testNonceMatchesExecutableElementsAndChangesEveryResponse(): void
    {
        $first = $this->client->get('/index.php')->assertStatus(200);
        $second = $this->client->get('/index.php')->assertStatus(200);
        $nonces = [];
        foreach ([$first, $second] as $response) {
            $policy = $response->getHeader('Content-Security-Policy') ?? '';
            $this->assertMatchesRegex("/'nonce-([A-Za-z0-9+\/=]+)'/", $policy);
            preg_match("/'nonce-([A-Za-z0-9+\/=]+)'/", $policy, $match);
            $nonce = $match[1];
            $this->assertSame(32, strlen((string)base64_decode($nonce, true)));
            $nonces[] = $nonce;
            preg_match_all('/<(script|style)\b([^>]*)>(.*?)<\/\1>/s', $response->getBody(), $elements, PREG_SET_ORDER);
            foreach ($elements as $element) {
                if ($element[1] === 'script' && preg_match('/\bsrc=/', $element[2])) continue;
                preg_match('/\bnonce="([^"]+)"/', $element[2], $attribute);
                $this->assertSame($nonce, html_entity_decode($attribute[1] ?? '', ENT_QUOTES, 'UTF-8'));
            }
            $this->assertStringContains("script-src-attr 'none'", $policy);
            $this->assertStringContains("style-src-attr 'none'", $policy);
            $this->assertFalse(str_contains($policy, 'unsafe-inline'));
            $this->assertFalse(str_contains($policy, 'unsafe-eval'));
            $this->assertFalse(str_contains($policy, 'upgrade-insecure-requests'));
            $this->assertFalse(str_contains($policy, 'block-all-mixed-content'));
            $this->assertSame('SAMEORIGIN', $response->getHeader('X-Frame-Options'));
            $this->assertStringContains("frame-ancestors 'self'", $policy);
        }
        $this->assertNotSame($nonces[0], $nonces[1]);
    }

    public function testDenialsAndRedirectsRetainCspWithoutForcingHttps(): void
    {
        $client = new TestHttpClient($this->client->getBaseUrl());
        $page = $client->get('/index.php', ['Host' => 'netarium.example.test', 'X-Forwarded-Proto' => 'https'])->assertStatus(302);
        $this->assertSame('login.php', $page->getHeader('Location'));
        $api = $client->get('/api.php?action=load')->assertStatus(401);
        foreach ([$page, $api] as $response) {
            $this->assertStringContains("object-src 'none'", $response->getHeader('Content-Security-Policy') ?? '');
            $this->assertNull($response->getHeader('Strict-Transport-Security'));
            $this->assertNull($response->getHeader('Content-Security-Policy-Report-Only'));
        }
    }

    public function testReportOnlyAndExplicitHstsOnTrustedHttpsOnly(): void
    {
        // HTTPSは試験専用prependで合成する。TLS／ブラウザのHSTS記憶は実IIS受入で確認する。
        $fixture = sys_get_temp_dir() . '/netarium_headers_' . bin2hex(random_bytes(8));
        mkdir($fixture . '/src/Core', 0700, true);
        mkdir($fixture . '/config', 0700, true);
        copy(dirname(__DIR__, 2) . '/src/Core/Config.php', $fixture . '/src/Core/Config.php');
        $config = $fixture . '/config/app.php';
        $prepend = $fixture . '/prepend.php';
        file_put_contents($config, "<?php return ['csp_report_only'=>true, 'hsts_max_age'=>300];");
        file_put_contents($prepend, '<?php require_once ' . var_export($fixture . '/src/Core/Config.php', true)
            . '; if (($_SERVER["HTTP_X_NETARIUM_TEST_HTTPS"] ?? "") === "on") { $_SERVER["HTTPS"] = "on"; }');
        $server = new TestServer(null, $prepend);
        try {
            $server->start();
            $client = new TestHttpClient($server->getBaseUrl());
            $http = $client->get('/login.php', ['X-Forwarded-Proto' => 'https'])->assertStatus(200);
            $https = $client->get('/login.php', ['X-Netarium-Test-Https' => 'on'])->assertStatus(200);
            $this->assertNull($http->getHeader('Strict-Transport-Security'));
            $this->assertSame('max-age=300', $https->getHeader('Strict-Transport-Security'));
            foreach ([$http, $https] as $response) {
                $this->assertNull($response->getHeader('Content-Security-Policy'));
                $this->assertStringContains("script-src-attr 'none'", $response->getHeader('Content-Security-Policy-Report-Only') ?? '');
            }
            file_put_contents($config, "<?php return ['hsts_max_age'=>0];");
            $reset = $client->get('/login.php', ['X-Netarium-Test-Https' => 'on'])->assertStatus(200);
            $this->assertSame('max-age=0', $reset->getHeader('Strict-Transport-Security'));
            $this->assertNull($reset->getHeader('Content-Security-Policy-Report-Only'));
            $this->assertStringContains("script-src-attr 'none'", $reset->getHeader('Content-Security-Policy') ?? '');
            file_put_contents($config, '<?php return [];');
            $disabled = $client->get('/login.php', ['X-Netarium-Test-Https' => 'on'])->assertStatus(200);
            $this->assertNull($disabled->getHeader('Strict-Transport-Security'));
        } finally {
            $server->stop();
            unlink($prepend);
            unlink($config);
            unlink($fixture . '/src/Core/Config.php');
            rmdir($fixture . '/src/Core');
            rmdir($fixture . '/src');
            rmdir($fixture . '/config');
            rmdir($fixture);
        }
    }
}
