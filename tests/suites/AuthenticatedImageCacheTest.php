<?php
declare(strict_types=1);

namespace Netarium\Tests\Suites;

use Netarium\Tests\TestCase;
use Netarium\Tests\TestHttpClient;
use Netarium\Tests\TestResponse;
use Netarium\Tests\TestServer;
use PDO;

class AuthenticatedImageCacheTest extends TestCase
{
    public function __construct(TestHttpClient $client)
    {
    }

    public function testImageUrlsMigrateAndDeliverWithoutStorage(): void
    {
        $this->withImages(function (TestServer $server, TestHttpClient $client, PDO $db, array $urls): void {
            $loaded = $client->get('/api.php?action=load')->assertOk()->getJson();
            $this->assertSame(ltrim($urls[0], '/'), $loaded['device_images'][0]['image_url']);
            $this->assertSame(ltrim($urls[2], '/'), $loaded['floor_plans'][0]['image_url']);
            foreach ($urls as $index => $url) {
                parse_str((string)parse_url($url, PHP_URL_QUERY), $query);
                $this->assertSame('200-1', $query['cache_policy'] ?? null);
                $this->assertTrue(isset($query['v']));
                $oldUrl = str_replace('&cache_policy=200-1', '', $url);
                $this->assertNotSame($oldUrl, $url);
                $response = $client->get($url)->assertStatus(200);
                $this->assertNoStore($response);
                $this->assertSame('image/png', $response->getHeader('Content-Type'));
                $this->assertSame('nosniff', $response->getHeader('X-Content-Type-Options'));
                $info = getimagesizefromstring($response->getBody());
                $this->assertSame($index === 1 ? 320 : 640, $info[0]);
                $this->assertSame($index === 1 ? 160 : 320, $info[1]);
                $oldResponse = $client->get($oldUrl)->assertStatus(200);
                $this->assertNoStore($oldResponse);
                $this->assertSame($response->getBody(), $oldResponse->getBody());
                $conditional = $client->get($url, [
                    'If-None-Match' => '"old-image"',
                    'If-Modified-Since' => 'Wed, 01 Jan 2031 00:00:00 GMT',
                ])->assertStatus(200);
                $this->assertNoStore($conditional);
                $this->assertSame($response->getBody(), $conditional->getBody());
            }
            $this->assertTrue(is_file($server->getTempDir() . '/cache/thumbnails/thumb_320_' . $db->query('SELECT stored_name FROM device_images')->fetchColumn()));
        });
    }

    public function testRevokedSessionsCannotReadOldOrNewImageUrls(): void
    {
        $this->withImages(function (TestServer $server, TestHttpClient $admin, PDO $db, array $urls): void {
            $denied = function (TestHttpClient $client) use ($urls): void {
                foreach ($urls as $url) {
                    foreach ([$url, str_replace('&cache_policy=200-1', '', $url)] as $path) {
                        $response = $client->get($path)->assertStatus(302);
                        $this->assertNoStore($response);
                        $this->assertSame('login.php', $response->getHeader('Location'));
                        $this->assertSame('', $response->getBody());
                    }
                }
            };
            $denied(new TestHttpClient($server->getBaseUrl()));
            $viewer = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($viewer->login('viewer', 'viewer123'));
            foreach ($urls as $url) {
                $this->assertNoStore($viewer->get($url)->assertStatus(200));
            }
            $replay = new TestHttpClient($server->getBaseUrl());
            copy($viewer->cookieFile, $replay->cookieFile);
            $viewer->postForm('/logout.php', ['csrf_token' => $viewer->getCsrfToken()])->assertStatus(302);
            $denied($viewer);
            $denied($replay);

            $this->assertTrue($viewer->login('viewer', 'viewer123'));
            $db->exec("UPDATE users SET is_active = 0 WHERE username = 'viewer'");
            $denied($viewer);
            $db->exec("UPDATE users SET is_active = 1 WHERE username = 'viewer'");

            foreach (['last_activity' => 3601, 'authenticated_at' => 43201] as $field => $age) {
                $this->assertTrue($viewer->login('viewer', 'viewer123'));
                $cookies = file_get_contents($viewer->cookieFile);
                if (!preg_match('/netarium_session\s+([^\s]+)/', $cookies, $match)) {
                    throw new \RuntimeException('試験CookieにセッションIDがありません');
                }
                $sessionFile = $server->getTempDir() . '/sessions/sess_' . $match[1];
                $session = file_get_contents($sessionFile);
                $session = preg_replace('/\b' . $field . '\|i:\d+;/', $field . '|i:' . (time() - $age) . ';', $session, 1, $count);
                $this->assertSame(1, $count);
                file_put_contents($sessionFile, $session);
                $denied($viewer);
            }
        });
    }

    public function testErrorsAndPasswordRestrictionDoNotStoreImages(): void
    {
        $this->withImages(function (TestServer $server, TestHttpClient $client, PDO $db, array $urls): void {
            foreach (['/device_image.php?image_id=', '/floor_plan.php?view_id='] as $base) {
                foreach ([['invalid', 400], ['900000', 404]] as [$id, $status]) {
                    $response = $client->get($base . $id)->assertStatus($status);
                    $this->assertNoStore($response);
                    $this->assertSame('', $response->getBody());
                }
                $response = $client->postForm($base . '1', [])->assertStatus(405);
                $this->assertNoStore($response);
                $this->assertSame('GET', $response->getHeader('Allow'));
                $this->assertSame('', $response->getBody());
            }
            $db->exec('BEGIN EXCLUSIVE');
            try {
                foreach ($urls as $url) {
                    $response = $client->get($url)->assertStatus(503);
                    $this->assertNoStore($response);
                    $this->assertSame('text/plain; charset=UTF-8', $response->getHeader('Content-Type'));
                }
            } finally {
                $db->exec('ROLLBACK');
            }
            foreach ($urls as $url) {
                $this->assertNoStore($client->get($url)->assertStatus(200));
            }
            // 隔離DBだけで保存済みメタデータの破損を注入する。
            $db->exec('PRAGMA ignore_check_constraints = ON');
            $db->exec("UPDATE device_images SET mime_type = 'text/html'");
            $db->exec("UPDATE view_floor_plans SET mime_type = 'text/html'");
            $db->exec('PRAGMA ignore_check_constraints = OFF');
            foreach ($urls as $url) {
                $response = $client->get($url)->assertStatus(404);
                $this->assertNoStore($response);
                $this->assertSame('', $response->getBody());
            }
            $db->exec("UPDATE users SET must_change_password = 1 WHERE username = 'admin'");
            foreach ($urls as $url) {
                $response = $client->get($url)->assertStatus(302);
                $this->assertNoStore($response);
                $this->assertSame('change-password.php', $response->getHeader('Location'));
                $this->assertSame('', $response->getBody());
            }
        });
    }

    private function assertNoStore(TestResponse $response): void
    {
        $this->assertSame('private, no-store', $response->getHeader('Cache-Control'));
    }

    private function withImages(callable $check): void
    {
        $server = new TestServer();
        $db = null;
        try {
            $server->start();
            $client = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($client->login('admin', 'admin123'));
            $db = new PDO('sqlite:' . $server->getDbPath());
            $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
            $path = $server->getTempDir() . '/cache-policy.png';
            $image = imagecreatetruecolor(640, 320);
            imagepng($image, $path);
            imagedestroy($image);
            $before = $client->get('/api.php?action=load')->assertOk()->getJson();
            $device = $client->postMultipart('/image_upload.php?action=upload_device_image', [
                'device_id' => '1', 'revision' => (string)$before['revision'],
            ], ['image' => ['path' => $path, 'type' => 'image/png']])->assertOk()->getJson();
            $viewRevision = array_column($before['views'], 'resource_revision', 'id')[2];
            $floor = $client->postMultipart('/image_upload.php?action=upload_floor_plan', [
                'view_id' => '2', 'expected_revision' => (string)$viewRevision,
            ], ['floor_plan' => ['path' => $path, 'type' => 'image/png']])->assertOk()->getJson();
            $deviceUrl = '/' . $device['images'][0]['image_url'];
            $check($server, $client, $db, [$deviceUrl, $deviceUrl . '&size=thumb', '/' . $floor['floor_plan']['image_url']]);
        } finally {
            $db = null;
            $server->stop();
        }
    }
}
