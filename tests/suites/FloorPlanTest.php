<?php
declare(strict_types=1);

namespace Netarium\Tests\Suites;

use Netarium\Tests\TestCase;
use Netarium\Tests\TestHttpClient;

class FloorPlanTest extends TestCase
{
    private TestHttpClient $client;

    public function __construct(TestHttpClient $client)
    {
        $this->client = $client;
    }

    public function testFloorPlanFullLifecycle(): void
    {
        // 1. Fetch current revision
        $loadRes = $this->client->get('/api.php?action=load');
        $currentRev = (int)$loadRes->getJson()['revision'];
        $viewRevision = (int)array_column($loadRes->getJson()['views'], 'resource_revision', 'id')[2];

        $tempPng = tempnam(sys_get_temp_dir(), 'net_fp_');
        $image = imagecreatetruecolor(1, 1);
        imagepng($image, $tempPng);
        unset($image);

        $viewId = 2; // Seeded floor view

        try {
            // 3. Upload floor plan
            $uploadRes = $this->client->postMultipart(
                '/image_upload.php?action=upload_floor_plan',
                [
                    'view_id' => (string)$viewId,
                    'expected_revision' => (string)$viewRevision,
                ],
                [
                    'floor_plan' => [
                        'path' => $tempPng,
                        'filename' => 'floor1.png',
                        'type' => 'image/png',
                    ],
                ]
            );

            $uploadRes->assertOk();
            $uploadJson = $uploadRes->getJson();
            $this->assertTrue($uploadJson['ok']);
            $this->assertSame($currentRev + 1, $uploadJson['revision']);

            $currentRev = (int)$uploadJson['revision'];
            $viewRevision = (int)$uploadJson['view_revision'];

            // 4. Verify floor plan delivery via floor_plan.php
            $imageRes = $this->client->get("/floor_plan.php?view_id={$viewId}");
            $imageRes->assertStatus(200);
            $contentType = $imageRes->getHeader('Content-Type');
            $this->assertNotNull($contentType);
            $this->assertStringContains('image/png', $contentType);
            $this->assertTrue(strlen($imageRes->getBody()) > 10);

            // 別機器の保存で全体世代が変わっても、このビューの設定は保存できる。
            $snapshot = $this->client->get('/api.php?action=load')->assertOk()->getJson();
            $device = $snapshot['devices'][0];
            $device['memo'] = '図面表示設定と独立した機器編集';
            $deviceSave = $this->client->postJson('/api.php?action=save_resources', [
                'devices' => [['operation' => 'update', 'id' => (int)$device['id'],
                    'expected_revision' => (int)$device['resource_revision'], 'device' => $device]],
                'views' => [],
            ])->assertOk()->getJson();
            $currentRev = (int)$deviceSave['revision'];
            $staleViewRevision = $viewRevision;
            // 5. Update floor plan settings
            $updateRes = $this->client->postJson('/api.php?action=update_floor_plan_settings', [
                'view_id' => $viewId,
                'expected_revision' => $viewRevision,
                'x' => 50,
                'y' => 80,
                'scale' => 1.5,
                'opacity' => 0.8,
                'is_visible' => 1,
            ]);

            $updateRes->assertOk();
            $updateJson = $updateRes->getJson();
            $this->assertTrue($updateJson['ok']);
            $this->assertSame($currentRev + 1, $updateJson['revision']);

            $currentRev = (int)$updateJson['revision'];
            $viewRevision = (int)$updateJson['view_revision'];
            $conflict = $this->client->postJson('/api.php?action=update_floor_plan_settings', [
                'view_id' => $viewId, 'expected_revision' => $staleViewRevision,
                'x' => 999, 'y' => 999, 'scale' => 1, 'opacity' => 1, 'is_visible' => 1,
            ])->assertStatus(409)->getJson();
            $this->assertSame('views', $conflict['details']['conflicts'][0]['kind']);
            $this->assertSame($viewId, $conflict['details']['conflicts'][0]['id']);
            $floorPlans = $this->client->get('/api.php?action=load')->assertOk()->getJson()['floor_plans'];
            $this->assertSame(50.0, (float)$floorPlans[0]['x']);
            $this->assertSame(80.0, (float)$floorPlans[0]['y']);

            // 6. Delete floor plan
            $deleteRes = $this->client->postJson('/api.php?action=delete_floor_plan', [
                'view_id' => $viewId,
                'expected_revision' => $viewRevision,
            ]);

            $deleteRes->assertOk();
            $deleteJson = $deleteRes->getJson();
            $this->assertTrue($deleteJson['ok']);
            $this->assertSame($currentRev + 1, $deleteJson['revision']);

            // 7. Verify floor_plan.php now returns 404
            $notExistRes = $this->client->get("/floor_plan.php?view_id={$viewId}");
            $notExistRes->assertStatus(404);

        } finally {
            @unlink($tempPng);
        }
    }

    public function testBusySettingsPreserveStoredPlanAndAllowRetry(): void
    {
        $server = new \Netarium\Tests\TestServer();
        $db = null;
        try {
            $server->start();
            $client = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($client->login('admin', 'admin123'));
            $initial = $client->get('/api.php?action=load')->assertOk()->getJson();
            $revision = (int)array_column($initial['views'], 'resource_revision', 'id')[2];
            $path = $server->getTempDir() . DIRECTORY_SEPARATOR . 'busy.png';
            $image = imagecreatetruecolor(16, 16);
            imagepng($image, $path);
            unset($image);
            $upload = $client->postMultipart('/image_upload.php?action=upload_floor_plan',
                ['view_id' => '2', 'expected_revision' => (string)$revision],
                ['floor_plan' => ['path' => $path, 'type' => 'image/png']])->assertOk()->getJson();
            $before = $client->get('/api.php?action=load')->assertOk()->getJson();
            $settings = ['view_id' => 2, 'expected_revision' => (int)$upload['view_revision'],
                'x' => 50, 'y' => 80, 'scale' => 1.5, 'opacity' => 0.6, 'is_visible' => 0];
            $db = new \PDO('sqlite:' . $server->getDbPath());
            $db->beginTransaction();
            $db->exec('UPDATE view_floor_plans SET x = x WHERE view_id = 2');
            $busy = $client->postJson('/api.php?action=update_floor_plan_settings', $settings)
                ->assertStatus(409)->getJson();
            $this->assertSame([], $busy['details']['conflicts'] ?? []);
            $this->assertStringContains('少し待って', $busy['error']);
            $db->rollBack();
            $unchanged = $client->get('/api.php?action=load')->assertOk()->getJson();
            $this->assertSame($before['floor_plans'], $unchanged['floor_plans']);
            $this->assertSame($before['revision'], $unchanged['revision']);
            $this->assertSame($before['views'], $unchanged['views']);
            $client->postJson('/api.php?action=update_floor_plan_settings', $settings)->assertOk();
            $saved = $client->get('/api.php?action=load')->assertOk()->getJson();
            $plan = array_column($saved['floor_plans'], null, 'view_id')[2];
            foreach (['x', 'y', 'scale', 'opacity', 'is_visible'] as $key) {
                $this->assertSame((float)$settings[$key], (float)$plan[$key]);
            }
            $this->assertSame((int)$before['revision'] + 1, (int)$saved['revision']);
        } finally {
            if ($db?->inTransaction()) {
                $db->rollBack();
            }
            $db = null;
            $server->stop();
        }
    }

    public function testUploadDimensionBoundaryPreservesStoredPlanOnFailure(): void
    {
        $server = new \Netarium\Tests\TestServer();
        try {
            $server->start();
            $client = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($client->login('admin', 'admin123'));
            $load = $client->get('/api.php?action=load')->assertOk()->getJson();
            $revision = (int)array_column($load['views'], 'resource_revision', 'id')[2];
            $path = $server->getTempDir() . DIRECTORY_SEPARATOR . 'boundary.png';
            $image = imagecreatetruecolor(7000, 16);
            imagepng($image, $path);
            unset($image);
            $inputBytes = (string)file_get_contents($path);
            $upload = $client->postMultipart('/image_upload.php?action=upload_floor_plan',
                ['view_id' => '2', 'expected_revision' => (string)$revision],
                ['floor_plan' => ['path' => $path, 'type' => 'image/png']])->assertOk()->getJson();
            $this->assertSame(4096, (int)$upload['floor_plan']['image_width']);
            $original = $client->get('/floor_plan.php?view_id=2')->assertStatus(200)->getBody();
            $this->assertNotSame($inputBytes, $original);
            $info = getimagesizefromstring($original);
            $this->assertSame(4096, $info[0]);
            $this->assertSame(9, $info[1]);
            $this->assertSame(strlen($original), (int)$upload['floor_plan']['file_size']);
            $defaults = ['x' => 0.0, 'y' => 0.0, 'scale' => 1.0, 'opacity' => 1.0, 'is_visible' => 1];
            $initial = $client->get('/api.php?action=load')->assertOk()->getJson();
            $initialPlan = array_column($initial['floor_plans'], null, 'view_id')[2];
            foreach ($defaults as $key => $value) {
                $this->assertSame($value, $key === 'is_visible' ? (int)$upload['floor_plan'][$key] : (float)$upload['floor_plan'][$key]);
                $this->assertSame($value, $key === 'is_visible' ? (int)$initialPlan[$key] : (float)$initialPlan[$key]);
            }

            $settings = ['x' => -123.5, 'y' => 87.25, 'scale' => 1.75, 'opacity' => 0.35, 'is_visible' => 0];
            $update = $client->postJson('/api.php?action=update_floor_plan_settings', array_merge([
                'view_id' => 2, 'expected_revision' => (int)$upload['view_revision'],
            ], $settings))->assertOk()->getJson();
            $configured = $client->get('/api.php?action=load')->assertOk()->getJson();
            $configuredPlan = array_column($configured['floor_plans'], null, 'view_id')[2];
            foreach ($settings as $key => $value) {
                $this->assertSame($value, $key === 'is_visible' ? (int)$configuredPlan[$key] : (float)$configuredPlan[$key]);
            }

            // A rejected replacement must retain the configured plan, bytes and both revision scopes.
            $client->postMultipart('/image_upload.php?action=upload_floor_plan',
                ['view_id' => '2', 'expected_revision' => (string)$upload['view_revision']],
                ['floor_plan' => ['path' => $path, 'type' => 'image/png']])->assertStatus(409);
            $rejected = $client->get('/api.php?action=load')->assertOk()->getJson();
            $this->assertSame($configured['revision'], $rejected['revision']);
            $this->assertSame($configured['views'], $rejected['views']);
            $this->assertSame($configured['floor_plans'], $rejected['floor_plans']);
            $this->assertSame($original, $client->get('/floor_plan.php?view_id=2')->assertStatus(200)->getBody());

            $image = imagecreatetruecolor(32, 16);
            imagepng($image, $path);
            unset($image);
            $replacement = $client->postMultipart('/image_upload.php?action=upload_floor_plan',
                ['view_id' => '2', 'expected_revision' => (string)$update['view_revision']],
                ['floor_plan' => ['path' => $path, 'filename' => 'replacement.png', 'type' => 'image/png']])->assertOk()->getJson();
            $this->assertSame((int)$configured['revision'] + 1, (int)$replacement['revision']);
            $this->assertSame((int)$update['view_revision'] + 1, (int)$replacement['view_revision']);
            $this->assertSame((int)$configuredPlan['revision'] + 1, (int)$replacement['floor_plan']['revision']);
            $this->assertSame($configuredPlan['created_at'], $replacement['floor_plan']['created_at']);
            $this->assertSame('replacement.png', $replacement['floor_plan']['original_name']);
            $this->assertSame(32, (int)$replacement['floor_plan']['image_width']);
            $replacementBytes = $client->get('/' . $replacement['floor_plan']['image_url'])->assertStatus(200)->getBody();
            $this->assertNotSame($original, $replacementBytes);
            $this->assertSame(32, getimagesizefromstring($replacementBytes)[0]);
            $this->assertSame(16, getimagesizefromstring($replacementBytes)[1]);
            $this->assertSame(strlen($replacementBytes), (int)$replacement['floor_plan']['file_size']);
            $before = $client->get('/api.php?action=load')->assertOk()->getJson();
            $reloadedPlan = array_column($before['floor_plans'], null, 'view_id')[2];
            foreach ($settings as $key => $value) {
                $this->assertSame($value, $key === 'is_visible' ? (int)$replacement['floor_plan'][$key] : (float)$replacement['floor_plan'][$key]);
                $this->assertSame($value, $key === 'is_visible' ? (int)$reloadedPlan[$key] : (float)$reloadedPlan[$key]);
            }
            $this->assertSame((int)$replacement['floor_plan']['revision'], (int)$reloadedPlan['revision']);
            $this->assertSame($replacement['floor_plan']['image_url'], $reloadedPlan['image_url']);
            foreach ([[7001, 16], [16, 7001], [6000, 6000], [9921, 7016]] as [$width, $height]) {
                $this->writePng($path, $width, $height, false);
                $client->postMultipart('/image_upload.php?action=upload_floor_plan',
                    ['view_id' => '2', 'expected_revision' => (string)$replacement['view_revision']],
                    ['floor_plan' => ['path' => $path, 'type' => 'image/png']])->assertStatus(400);
                $after = $client->get('/api.php?action=load')->assertOk()->getJson();
                $this->assertSame($before['revision'], $after['revision']);
                $this->assertSame($before['views'], $after['views']);
                $this->assertSame($before['floor_plans'], $after['floor_plans']);
                $this->assertSame($replacementBytes, $client->get('/floor_plan.php?view_id=2')->assertStatus(200)->getBody());
            }
        } finally {
            $server->stop();
        }
    }

    private function writePng(string $path, int $width, int $height, bool $noise): void
    {
        $chunk = static fn(string $type, string $data): string =>
            pack('N', strlen($data)) . $type . $data . pack('N', crc32($type . $data));
        $bytes = "\x89PNG\r\n\x1a\n" . $chunk('IHDR', pack('NNCCCCC', $width, $height, 8, 2, 0, 0, 0));
        if ($noise) {
            $raw = '';
            for ($y = 0; $y < $height; $y++) {
                $raw .= "\0" . random_bytes($width * 3);
            }
            $bytes .= $chunk('IDAT', gzcompress($raw, 1));
        }
        file_put_contents($path, $bytes . $chunk('IEND', ''));
        clearstatcache(true, $path);
    }

    private function withExifOrientation(string $jpeg, int $orientation): string
    {
        $exif = "Exif\0\0II\x2a\0\x08\0\0\0\x01\0\x12\x01\x03\0\x01\0\0\0"
            . pack('v', $orientation) . "\0\0\0\0\0\0";
        return substr($jpeg, 0, 2) . "\xff\xe1" . pack('n', strlen($exif) + 2) . $exif . substr($jpeg, 2);
    }

    public function testA3ScansConvertWithoutKeepingOriginals(): void
    {
        $server = new \Netarium\Tests\TestServer();
        try {
            $server->start();
            $client = new TestHttpClient($server->getBaseUrl());
            $client->setTimeout(120);
            $this->assertTrue($client->login('admin', 'admin123'));
            $load = $client->get('/api.php?action=load')->assertOk()->getJson();
            $revision = (int)array_column($load['views'], 'resource_revision', 'id')[2];
            $path = $server->getTempDir() . DIRECTORY_SEPARATOR . 'scan';
            $photo = imagecreatetruecolor(16, 16);
            imagepng($photo, $path);
            unset($photo);
            $photoUpload = $client->postMultipart('/image_upload.php?action=upload_device_image',
                ['device_id' => '1', 'revision' => (string)$load['revision']],
                ['image' => ['path' => $path, 'type' => 'image/png']])->assertOk()->getJson();
            $photoBytes = (int)$photoUpload['images'][0]['file_size'];
            foreach ([[3307, 2339], [4961, 3508], [6614, 4677], [7000, 5000]] as [$width, $height]) {
                foreach (['png', 'jpeg'] as $format) {
                    $image = imagecreatetruecolor($width, $height);
                    imagefill($image, 0, 0, imagecolorallocate($image, 255, 255, 255));
                    imageline($image, 0, 0, $width - 1, $height - 1, imagecolorallocate($image, 0, 0, 0));
                    $format === 'png' ? imagepng($image, $path) : imagejpeg($image, $path, 99);
                    unset($image);
                    $input = (string)file_get_contents($path);
                    $rotated = $width === 6614 && $format === 'jpeg';
                    if ($rotated) {
                        $input = $this->withExifOrientation($input, 6);
                        file_put_contents($path, $input);
                    }
                    $upload = $client->postMultipart('/image_upload.php?action=upload_floor_plan',
                        ['view_id' => '2', 'expected_revision' => (string)$revision],
                        ['floor_plan' => ['path' => $path, 'type' => 'image/' . $format]])->assertOk()->getJson();
                    $revision = (int)$upload['view_revision'];
                    $body = $client->get('/floor_plan.php?view_id=2')->assertStatus(200)->getBody();
                    $info = getimagesizefromstring($body);
                    $ratio = min(1, 4096 / $width);
                    $this->assertSame((int)round(($rotated ? $height : $width) * $ratio), $info[0]);
                    $this->assertSame((int)round(($rotated ? $width : $height) * $ratio), $info[1]);
                    $this->assertSame('image/' . $format, $info['mime']);
                    $this->assertSame(strlen($body), (int)$upload['floor_plan']['file_size']);
                    $this->assertSame($info[0], (int)$upload['floor_plan']['image_width']);
                    $this->assertSame($info[1], (int)$upload['floor_plan']['image_height']);
                    $this->assertSame(2, (int)$upload['capacity']['files']);
                    $this->assertSame($photoBytes + strlen($body), (int)$upload['capacity']['bytes']);
                    $this->assertNotSame($input, $body);
                    $files = glob($server->getTempDir() . '/uploads/floorplans/*');
                    $this->assertSame(1, count($files));
                    $this->assertSame($body, file_get_contents($files[0]));
                }
            }
        } finally {
            $server->stop();
        }
    }

    public function testTransparencyAndAllExifOrientations(): void
    {
        $server = new \Netarium\Tests\TestServer();
        try {
            $server->start();
            $client = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($client->login('admin', 'admin123'));
            $revision = (int)array_column($client->get('/api.php?action=load')->assertOk()->getJson()['views'], 'resource_revision', 'id')[2];
            $path = $server->getTempDir() . '/oriented';
            foreach ([64, 5000] as $width) {
                $image = imagecreatetruecolor($width, 32);
                imagealphablending($image, false);
                imagesavealpha($image, true);
                imagefill($image, 0, 0, imagecolorallocatealpha($image, 20, 80, 150, 100));
                imagepng($image, $path);
                unset($image);
                $upload = $client->postMultipart('/image_upload.php?action=upload_floor_plan',
                    ['view_id' => '2', 'expected_revision' => (string)$revision],
                    ['floor_plan' => ['path' => $path, 'type' => 'image/png']])->assertOk()->getJson();
                $revision = (int)$upload['view_revision'];
                $decoded = imagecreatefromstring($client->get('/floor_plan.php?view_id=2')->assertStatus(200)->getBody());
                $this->assertSame(min(4096, $width), imagesx($decoded));
                $this->assertSame($width === 64 ? 32 : 26, imagesy($decoded));
                $this->assertSame(100, imagecolorsforindex($decoded, imagecolorat($decoded, 10, 10))['alpha']);
                unset($decoded);
            }
            $image = imagecreatetruecolor(80, 40);
            foreach ([[0, 0, 39, 19, 255, 0, 0], [40, 0, 79, 19, 0, 255, 0],
                [0, 20, 39, 39, 0, 0, 255], [40, 20, 79, 39, 255, 255, 0]] as $block) {
                [$x1, $y1, $x2, $y2, $r, $g, $b] = $block;
                imagefilledrectangle($image, $x1, $y1, $x2, $y2, imagecolorallocate($image, $r, $g, $b));
            }
            imagejpeg($image, $path, 100);
            unset($image);
            $jpeg = (string)file_get_contents($path);
            $orders = [1 => [0, 1, 2, 3], 2 => [1, 0, 3, 2], 3 => [3, 2, 1, 0],
                4 => [2, 3, 0, 1], 5 => [0, 2, 1, 3], 6 => [2, 0, 3, 1],
                7 => [3, 1, 2, 0], 8 => [1, 3, 0, 2]];
            $colors = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]];
            foreach ($orders as $orientation => $order) {
                file_put_contents($path, $this->withExifOrientation($jpeg, $orientation));
                $upload = $client->postMultipart('/image_upload.php?action=upload_floor_plan',
                    ['view_id' => '2', 'expected_revision' => (string)$revision],
                    ['floor_plan' => ['path' => $path, 'type' => 'image/jpeg']])->assertOk()->getJson();
                $revision = (int)$upload['view_revision'];
                $decoded = imagecreatefromstring($client->get('/floor_plan.php?view_id=2')->assertStatus(200)->getBody());
                $w = $orientation >= 5 ? 40 : 80;
                $h = $orientation >= 5 ? 80 : 40;
                $this->assertSame($w, imagesx($decoded));
                $this->assertSame($h, imagesy($decoded));
                foreach ([[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]] as $i => [$x, $y]) {
                    $actual = imagecolorsforindex($decoded, imagecolorat($decoded, (int)($w * $x), (int)($h * $y)));
                    foreach (['red', 'green', 'blue'] as $channel => $key) {
                        $this->assertTrue(abs($colors[$order[$i]][$channel] - $actual[$key]) < 25);
                    }
                }
                unset($decoded);
            }
        } finally {
            $server->stop();
        }
    }

    public function testConversionFailuresPreserveOldImageAndCleanWorkingFiles(): void
    {
        $prepend = tempnam(sys_get_temp_dir(), 'net_floor_memory_');
        file_put_contents($prepend, '<?php if (isset($_SERVER["HTTP_X_TEST_LOW_MEMORY"])) { ini_set("memory_limit", "32M"); }');
        $server = new \Netarium\Tests\TestServer(null, $prepend);
        $db = null;
        try {
            $server->start();
            $client = new TestHttpClient($server->getBaseUrl());
            $client->setTimeout(120);
            $this->assertTrue($client->login('admin', 'admin123'));
            $revision = (int)array_column($client->get('/api.php?action=load')->assertOk()->getJson()['views'], 'resource_revision', 'id')[2];
            $path = $server->getTempDir() . '/fail.png';
            $directory = $server->getTempDir() . '/uploads/floorplans';
            $image = imagecreatetruecolor(20, 10);
            imagepng($image, $path);
            unset($image);
            $upload = $client->postMultipart('/image_upload.php?action=upload_floor_plan',
                ['view_id' => '2', 'expected_revision' => (string)$revision],
                ['floor_plan' => ['path' => $path, 'type' => 'image/png']])->assertOk()->getJson();
            $revision = (int)$upload['view_revision'];
            $before = $client->get('/api.php?action=load')->assertOk()->getJson();
            $original = $client->get('/floor_plan.php?view_id=2')->assertStatus(200)->getBody();
            $files = glob($directory . '/*');
            $reject = function (int $status, array $headers = []) use ($client, $path, $revision, $directory, $before, $original, $files): void {
                $client->postMultipart('/image_upload.php?action=upload_floor_plan',
                    ['view_id' => '2', 'expected_revision' => (string)$revision],
                    ['floor_plan' => ['path' => $path, 'type' => 'image/png']], $headers)->assertStatus($status);
                $after = $client->get('/api.php?action=load')->assertOk()->getJson();
                foreach (['revision', 'views', 'floor_plans'] as $key) {
                    $this->assertSame($before[$key], $after[$key]);
                }
                $this->assertSame($original, $client->get('/floor_plan.php?view_id=2')->assertStatus(200)->getBody());
                $this->assertSame($files, glob($directory . '/*'));
            };
            // Valid header but missing image data must fail decode, not merely MIME detection.
            $this->writePng($path, 100, 100, false);
            $reject(400);
            $image = imagecreatetruecolor(2048, 1024);
            imagepng($image, $path);
            unset($image);
            $reject(400, ['X-Test-Low-Memory' => '1']);
            // Lossless noise is under the input limit but exceeds the encoded entry limit.
            $this->writePng($path, 2200, 2200, true);
            $this->assertTrue(filesize($path) > 10 * 1024 * 1024);
            $this->assertTrue(filesize($path) < 30 * 1024 * 1024);
            $reject(400);
            $image = imagecreatetruecolor(32, 16);
            imagepng($image, $path);
            unset($image);
            file_put_contents($path, str_repeat('x', 30 * 1024 * 1024), FILE_APPEND);
            $reject(400);
            $image = imagecreatetruecolor(32, 16);
            imagepng($image, $path);
            unset($image);
            // A write lock forces 409 after conversion; the newly encoded file must be removed.
            $db = new \PDO('sqlite:' . $server->getDbPath());
            $db->beginTransaction();
            $db->exec('UPDATE view_floor_plans SET x = x WHERE view_id = 2');
            $reject(409);
            $db->rollBack();
            // An unavailable destination rejects the write without losing the prior image.
            rename($directory, $directory . '-saved');
            file_put_contents($directory, 'not a directory');
            try {
                $client->postMultipart('/image_upload.php?action=upload_floor_plan',
                    ['view_id' => '2', 'expected_revision' => (string)$revision],
                    ['floor_plan' => ['path' => $path, 'type' => 'image/png']])->assertStatus(500);
            } finally {
                unlink($directory);
                rename($directory . '-saved', $directory);
            }
            $this->assertSame($original, $client->get('/floor_plan.php?view_id=2')->assertStatus(200)->getBody());
            $this->assertSame($before['floor_plans'], $client->get('/api.php?action=load')->assertOk()->getJson()['floor_plans']);
            $this->assertSame($files, glob($directory . '/*'));
        } finally {
            if ($db?->inTransaction()) {
                $db->rollBack();
            }
            $db = null;
            $server->stop();
            @unlink($prepend);
        }
    }

    public function testWholeTopologySavePreservesFloorPlanSha256Digest(): void
    {
        $server = new \Netarium\Tests\TestServer();
        $tempPng = null;
        try {
            $server->start();
            $client = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($client->login('admin', 'admin123'));
            $tempPng = tempnam(sys_get_temp_dir(), 'net_fp_sha_');
            $image = imagecreatetruecolor(1, 1);
            imagepng($image, $tempPng);
            unset($image);

            $loadRes = $client->get('/api.php?action=load')->assertOk()->getJson();
            $viewRevision = (int)array_column($loadRes['views'], 'resource_revision', 'id')[2];
            $client->postMultipart(
                '/image_upload.php?action=upload_floor_plan',
                ['view_id' => '2', 'expected_revision' => (string)$viewRevision],
                ['floor_plan' => ['path' => $tempPng, 'filename' => 'floor.png', 'type' => 'image/png']]
            )->assertOk();

            $db = new \PDO('sqlite:' . $server->getDbPath());
            $db->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
            $shaBefore = (string)$db->query('SELECT sha256 FROM view_floor_plans WHERE view_id = 2')->fetchColumn();
            $this->assertSame(64, strlen($shaBefore));

            $currentData = $client->get('/api.php?action=load')->assertOk()->getJson();
            $currentData['devices'][0]['memo'] = '全体保存後もSHA保持';
            $client->postJson('/api.php?action=save', [
                'revision' => (int)$currentData['revision'],
                'views' => $currentData['views'],
                'devices' => $currentData['devices'],
                'placements' => $currentData['placements'],
                'links' => $currentData['links'],
                'canvas_notes' => $currentData['canvas_notes'] ?? [],
            ])->assertOk();

            $shaAfter = $db->query('SELECT sha256 FROM view_floor_plans WHERE view_id = 2')->fetchColumn();
            $this->assertSame($shaBefore, $shaAfter);
        } finally {
            if ($tempPng !== null) {
                @unlink($tempPng);
            }
            $db = null;
            $server->stop();
        }
    }
}
