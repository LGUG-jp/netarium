<?php
declare(strict_types=1);

namespace Netarium\Tests\Suites;

use PDO;
use Netarium\Services\DeviceImage\DeviceImageService;
use Netarium\Tests\TestCase;
use Netarium\Tests\TestHttpClient;

class DeviceImageTest extends TestCase
{
    private TestHttpClient $client;

    public function __construct(TestHttpClient $client)
    {
        $this->client = $client;
    }

    public function testImageIdBoundaryPreservesSequenceAndRejectsExhaustion(): void
    {
        $server = new \Netarium\Tests\TestServer();
        try {
            $server->start();
            $client = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($client->login('admin', 'admin123'));
            $db = new PDO('sqlite:' . $server->getDbPath());
            $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
            $max = \Netarium\Core\ResourceId::MAX;
            $db->exec("INSERT INTO sqlite_sequence (name, seq) VALUES ('device_images', " . ($max - 1) . ")");
            $path = $server->getTempDir() . '/boundary.png';
            $image = imagecreatetruecolor(1, 1);
            imagepng($image, $path);
            unset($image);
            $before = $client->get('/api.php?action=load')->assertOk()->getJson();
            $uploaded = $client->postMultipart('/image_upload.php?action=upload_device_image', [
                'device_id' => '1', 'revision' => (string)$before['revision'],
            ], ['image' => ['path' => $path, 'type' => 'image/png']])->assertOk()->getJson();
            $this->assertSame($max, $uploaded['images'][0]['id']);
            $client->postJson('/api.php?action=delete_device_image', [
                'device_id' => 1, 'image_id' => $max, 'revision' => $uploaded['revision'],
            ])->assertOk();
            $this->assertSame($max, (int)$db->query("SELECT seq FROM sqlite_sequence WHERE name = 'device_images'")->fetchColumn());
            $before = $client->get('/api.php?action=load')->assertOk()->getJson();
            $state = static fn(): array => [
                $db->query('SELECT * FROM resource_sequences ORDER BY name')->fetchAll(PDO::FETCH_ASSOC),
                $db->query('SELECT * FROM sqlite_sequence ORDER BY name')->fetchAll(PDO::FETCH_ASSOC),
                $db->query('SELECT * FROM app_meta ORDER BY meta_key')->fetchAll(PDO::FETCH_ASSOC),
            ];
            $allocation = $state();
            $files = glob($server->getTempDir() . '/uploads/device_images/*');
            $client->postMultipart('/image_upload.php?action=upload_device_image', [
                'device_id' => '1', 'revision' => (string)$before['revision'],
            ], ['image' => ['path' => $path, 'type' => 'image/png']])->assertStatus(409);
            $this->assertSame($before, $client->get('/api.php?action=load')->assertOk()->getJson());
            $this->assertSame($allocation, $state());
            $this->assertSame($files, glob($server->getTempDir() . '/uploads/device_images/*'));
        } finally {
            $db = null;
            $server->stop();
        }
    }

    public function testDeviceImageUploadLifecycleAndPermissions(): void
    {
        // 1. 画像なしの新規機器を作成して構成保存
        $loadRes = $this->client->get('/api.php?action=load');
        $loadRes->assertOk();
        $loadData = $loadRes->getJson();
        $currentRev = (int)$loadData['revision'];

        $deviceId = 888;
        $devices = $loadData['devices'];
        $devices[] = [
            'id' => $deviceId,
            'name' => '画像検証用新規スイッチ',
            'type' => 'switch',
            'ip' => '192.168.88.88',
            'facility' => '新庁舎',
            'floor' => '3F',
            'location' => '機器室',
            'manufacturer' => 'VendorX',
            'model' => 'ModelX',
            'asset_number' => 'AST-888',
            'serial_number' => 'SER-888',
            'mac_address' => '00:11:22:33:44:99',
            'memo' => '画像テスト用',
            'management_scheme' => 'https',
            'management_port' => 443,
            'department' => '電算課',
            'maintenance_vendor' => '保守サポート社',
            'install_date' => '2024-01-01',
            'maintenance_expiry' => '2028-12-31',
        ];

        $saveRes = $this->client->postJson('/api.php?action=save', [
            'revision' => $currentRev,
            'views' => $loadData['views'],
            'devices' => $devices,
            'placements' => $loadData['placements'],
            'links' => $loadData['links'],
            'canvas_notes' => $loadData['canvas_notes'],
        ]);
        $saveRes->assertOk();
        $currentRev = (int)$saveRes->getJson()['revision'];
        // 2. Prepare test PNG image (1x1 red dot)
        $pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
        $tempPng = tempnam(sys_get_temp_dir(), 'test_img_png_');
        file_put_contents($tempPng, base64_decode($pngBase64));

        // Prepare test JPEG image
        $tempJpg = tempnam(sys_get_temp_dir(), 'test_img_jpg_');
        $im = imagecreatetruecolor(10, 10);
        imagejpeg($im, $tempJpg);
        unset($im);

        try {
            // 3. Upload first image (PNG)
            $uploadRes1 = $this->client->postMultipart(
                '/image_upload.php?action=upload_device_image',
                [
                    'device_id' => (string)$deviceId,
                    'revision' => (string)$currentRev,
                    'caption' => '前面写真',
                ],
                [
                    'image' => [
                        'path' => $tempPng,
                        'filename' => 'front.png',
                        'type' => 'image/png',
                    ],
                ]
            );

            $uploadRes1->assertOk();
            $json1 = $uploadRes1->getJson();
            $this->assertTrue($json1['ok']);
            $this->assertSame($currentRev + 1, (int)$json1['revision']);
            $this->assertCount(1, $json1['images']);
            $img1 = $json1['images'][0];
            $this->assertSame('前面写真', $img1['caption']);
            $this->assertSame(1, (int)$img1['sort_order']);
            $this->assertStringContains('device_image.php?image_id=' . $img1['id'], $img1['image_url']);
            $currentRev = (int)$json1['revision'];
            $img1Id = (int)$img1['id'];

            // 4. Download original and thumbnail via GET
            $thumbRes = $this->client->get('/' . $img1['image_url'] . '&size=thumb');
            $thumbRes->assertStatus(200);
            $this->assertSame('image/png', $thumbRes->getHeader('Content-Type'));
            $this->assertSame('nosniff', $thumbRes->getHeader('X-Content-Type-Options'));

            $origRes = $this->client->get('/' . $img1['image_url']);
            $origRes->assertStatus(200);
            $this->assertSame('image/png', $origRes->getHeader('Content-Type'));

            // 5. Test unauthenticated access fails
            $unauthClient = new TestHttpClient($this->client->getBaseUrl());
            $unauthRes = $unauthClient->get('/' . $img1['image_url']);
            // requirePageAuthentication redirects (302) to login or returns 401/403
            $this->assertTrue(in_array($unauthRes->getStatusCode(), [302, 401, 403], true));

            // 6. Test viewer role cannot upload or delete images
            $viewerClient = new TestHttpClient($this->client->getBaseUrl());
            $this->assertTrue($viewerClient->login('viewer', 'viewer123'));

            // Viewer can view image GET
            $viewerGetRes = $viewerClient->get('/' . $img1['image_url']);
            $viewerGetRes->assertStatus(200);

            // Viewer cannot upload image
            $viewerUploadRes = $viewerClient->postMultipart(
                '/image_upload.php?action=upload_device_image',
                [
                    'device_id' => (string)$deviceId,
                    'revision' => (string)$currentRev,
                ],
                [
                    'image' => [
                        'path' => $tempJpg,
                        'filename' => 'viewer.jpg',
                        'type' => 'image/jpeg',
                    ],
                ]
            );
            $viewerUploadRes->assertStatus(403);

            // 7. Stale revision fails with 409
            $staleRes = $this->client->postMultipart(
                '/image_upload.php?action=upload_device_image',
                [
                    'device_id' => (string)$deviceId,
                    'revision' => (string)($currentRev - 1),
                ],
                [
                    'image' => [
                        'path' => $tempJpg,
                        'filename' => 'stale.jpg',
                        'type' => 'image/jpeg',
                    ],
                ]
            );
            $staleRes->assertStatus(409);

            // 8. Upload 2nd image (JPEG)
            $uploadRes2 = $this->client->postMultipart(
                '/image_upload.php?action=upload_device_image',
                [
                    'device_id' => (string)$deviceId,
                    'revision' => (string)$currentRev,
                    'caption' => '背面写真',
                ],
                [
                    'image' => [
                        'path' => $tempJpg,
                        'filename' => 'rear.jpg',
                        'type' => 'image/jpeg',
                    ],
                ]
            );
            $uploadRes2->assertOk();
            $json2 = $uploadRes2->getJson();
            $this->assertCount(2, $json2['images']);
            $currentRev = (int)$json2['revision'];
            $img2Id = (int)$json2['images'][1]['id'];

            // 9. Upload 3rd image (PNG)
            $uploadRes3 = $this->client->postMultipart(
                '/image_upload.php?action=upload_device_image',
                [
                    'device_id' => (string)$deviceId,
                    'revision' => (string)$currentRev,
                    'caption' => 'ポート部拡大',
                ],
                [
                    'image' => [
                        'path' => $tempPng,
                        'filename' => 'ports.png',
                        'type' => 'image/png',
                    ],
                ]
            );
            $uploadRes3->assertOk();
            $json3 = $uploadRes3->getJson();
            $this->assertCount(3, $json3['images']);
            $currentRev = (int)$json3['revision'];
            $img3Id = (int)$json3['images'][2]['id'];

            // 10. Upload 4th image without replace fails with 400
            $uploadRes4 = $this->client->postMultipart(
                '/image_upload.php?action=upload_device_image',
                [
                    'device_id' => (string)$deviceId,
                    'revision' => (string)$currentRev,
                ],
                [
                    'image' => [
                        'path' => $tempJpg,
                        'filename' => 'fourth.jpg',
                        'type' => 'image/jpeg',
                    ],
                ]
            );
            $uploadRes4->assertStatus(400);
            $this->assertStringContains('最大3枚', $uploadRes4->getJson()['error']);

            // 11. Upload with replace_image_id replaces the targeted image
            $replaceRes = $this->client->postMultipart(
                '/image_upload.php?action=upload_device_image',
                [
                    'device_id' => (string)$deviceId,
                    'revision' => (string)$currentRev,
                    'replace_image_id' => (string)$img2Id,
                    'caption' => '背面写真(差替済)',
                ],
                [
                    'image' => [
                        'path' => $tempPng,
                        'filename' => 'replaced.png',
                        'type' => 'image/png',
                    ],
                ]
            );
            $replaceRes->assertOk();
            $replaceJson = $replaceRes->getJson();
            $this->assertCount(3, $replaceJson['images']);
            $currentRev = (int)$replaceJson['revision'];

            $foundReplaced = false;
            foreach ($replaceJson['images'] as $img) {
                if ((int)$img['id'] === $img2Id) {
                    $foundReplaced = true;
                    $this->assertSame('背面写真(差替済)', $img['caption']);
                    $this->assertSame('image/png', $img['mime_type']);
                }
            }
            $this->assertTrue($foundReplaced);

            // 12. Update images order and captions
            $updateOrderRes = $this->client->postJson('/api.php?action=update_device_images', [
                'device_id' => $deviceId,
                'revision' => $currentRev,
                'images' => [
                    ['id' => $img3Id, 'caption' => 'ポート部(1番目)'],
                    ['id' => $img1Id, 'caption' => '前面写真(2番目)'],
                    ['id' => $img2Id, 'caption' => '背面写真(3番目)'],
                ],
            ]);
            $updateOrderRes->assertOk();
            $orderJson = $updateOrderRes->getJson();
            $currentRev = (int)$orderJson['revision'];
            $this->assertSame($img3Id, (int)$orderJson['images'][0]['id']);
            $this->assertSame('ポート部(1番目)', $orderJson['images'][0]['caption']);
            $this->assertSame(1, (int)$orderJson['images'][0]['sort_order']);
            $this->assertSame($img1Id, (int)$orderJson['images'][1]['id']);
            $this->assertSame(2, (int)$orderJson['images'][1]['sort_order']);
            $this->assertSame($img2Id, (int)$orderJson['images'][2]['id']);
            $this->assertSame(3, (int)$orderJson['images'][2]['sort_order']);

            // 13. Delete one image
            $deleteRes = $this->client->postJson('/api.php?action=delete_device_image', [
                'device_id' => $deviceId,
                'image_id' => $img1Id,
                'revision' => $currentRev,
            ]);
            $deleteRes->assertOk();
            $deleteJson = $deleteRes->getJson();
            $this->assertCount(2, $deleteJson['images']);
            $currentRev = (int)$deleteJson['revision'];

            // Deleted image GET now returns 404
            $deletedGetRes = $this->client->get('/' . $img1['image_url']);
            $deletedGetRes->assertStatus(404);

            // 14. Verify load response returns the current device_images
            $finalLoadRes = $this->client->get('/api.php?action=load');
            $finalLoadRes->assertOk();
            $finalLoadData = $finalLoadRes->getJson();
            $this->assertArrayHasKey('device_images', $finalLoadData);
            $this->assertCount(2, $finalLoadData['device_images']);

            // 15. 機器完全削除のテスト (Topology saveで該当機器を除外して保存)
            $finalLoadRes2 = $this->client->get('/api.php?action=load');
            $finalLoadRes2->assertOk();
            $finalLoadData2 = $finalLoadRes2->getJson();
            $cleanDevices = array_values(array_filter($finalLoadData2['devices'], static fn($d) => (int)$d['id'] !== $deviceId));

            $deleteSaveRes = $this->client->postJson('/api.php?action=save', [
                'revision' => (int)$finalLoadData2['revision'],
                'views' => $finalLoadData2['views'],
                'devices' => $cleanDevices,
                'placements' => $finalLoadData2['placements'],
                'links' => $finalLoadData2['links'],
                'canvas_notes' => $finalLoadData2['canvas_notes'],
            ]);
            $deleteSaveRes->assertOk();

            // 削除後、残存画像のGETが404になること
            $afterDelLoad = $this->client->get('/api.php?action=load');
            $this->assertCount(0, array_filter($afterDelLoad->getJson()['device_images'], static fn($im) => (int)$im['device_id'] === $deviceId));

        } finally {
            @unlink($tempPng);
            @unlink($tempJpg);
        }
    }

    public function testDisplayResizePreservesOrientationAlphaAndSmallImages(): void
    {
        $prepend = tempnam(sys_get_temp_dir(), 'net_image_lifecycle_');
        $errorLog = $prepend . '.log';
        file_put_contents($prepend, '<?php error_reporting(E_ALL); ini_set("display_errors", "0");'
            . ' ini_set("log_errors", "1"); ini_set("error_log", ' . var_export($errorLog, true) . ');');
        $server = new \Netarium\Tests\TestServer(null, $prepend);
        try {
            $server->start();
            $client = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($client->login('admin', 'admin123'));
            $path = $server->getTempDir() . DIRECTORY_SEPARATOR . 'resize-input';
            $imageId = null;
            foreach ([
                [3000, 2000, 'png', 1, 2048, 1365],
                [2000, 3000, 'png', 1, 1365, 2048],
                [4000, 3000, 'jpeg', 6, 1536, 2048],
                [13, 7, 'png', 1, 13, 7],
            ] as [$width, $height, $format, $orientation, $expectedWidth, $expectedHeight]) {
                $image = imagecreatetruecolor($width, $height);
                imagealphablending($image, false);
                imagesavealpha($image, true);
                imagefilledrectangle($image, 0, 0, $width - 1, $height - 1, 0x30336699);
                if ($format === 'png') {
                    imagepng($image, $path);
                } else {
                    imagejpeg($image, $path, 95);
                    $jpeg = (string)file_get_contents($path);
                    $tiff = "II\x2a\0\x08\0\0\0\x01\0\x12\x01\x03\0\x01\0\0\0"
                        . pack('v', $orientation) . "\0\0\0\0\0\0";
                    $exif = "Exif\0\0" . $tiff;
                    file_put_contents($path, substr($jpeg, 0, 2) . "\xff\xe1"
                        . pack('n', strlen($exif) + 2) . $exif . substr($jpeg, 2));
                }
                unset($image);
                $load = $client->get('/api.php?action=load')->assertOk()->getJson();
                $fields = ['device_id' => '1', 'revision' => (string)$load['revision']];
                if ($imageId !== null) {
                    $fields['replace_image_id'] = (string)$imageId;
                }
                $upload = $client->postMultipart('/image_upload.php?action=upload_device_image',
                    $fields, ['image' => ['path' => $path, 'type' => 'image/' . $format]])
                    ->assertOk()->getJson();
                $record = $upload['images'][0];
                $imageId = (int)$record['id'];
                $response = $client->get('/' . $record['image_url'])->assertStatus(200);
                $info = getimagesizefromstring($response->getBody());
                $this->assertSame($expectedWidth, (int)$record['image_width']);
                $this->assertSame($expectedHeight, (int)$record['image_height']);
                $this->assertSame([$expectedWidth, $expectedHeight], [$info[0], $info[1]]);
                $this->assertSame('image/' . $format, $info['mime']);
                $this->assertSame(strlen($response->getBody()), (int)$record['file_size']);
                if ($format === 'png') {
                    $decoded = imagecreatefromstring($response->getBody());
                    $this->assertSame(48, (imagecolorat($decoded, 0, 0) >> 24) & 0x7f);
                    unset($decoded);
                } else {
                    $this->assertFalse(str_contains($response->getBody(), "Exif\0\0"));
                }
                $thumbnail = $client->get('/' . $record['image_url'] . '&size=thumb')->assertStatus(200);
                $thumbInfo = getimagesizefromstring($thumbnail->getBody());
                $ratio = min(1, 320 / max($expectedWidth, $expectedHeight));
                $this->assertSame(max(1, (int)round($expectedWidth * $ratio)), $thumbInfo[0]);
                $this->assertSame(max(1, (int)round($expectedHeight * $ratio)), $thumbInfo[1]);
                $this->assertSame('image/' . $format, $thumbInfo['mime']);
                if ($format === 'png') {
                    $decoded = imagecreatefromstring($thumbnail->getBody());
                    $this->assertSame(48, (imagecolorat($decoded, 0, 0) >> 24) & 0x7f);
                    unset($decoded);
                }
            }

            // デコード前の入力制限は縮小機能があっても緩和しない。
            foreach ([[4001, 1], [4000, 3001]] as [$width, $height]) {
                $before = $client->get('/api.php?action=load')->assertOk()->getJson();
                $oldRecord = $before['device_images'][0];
                $oldBytes = $client->get('/' . $oldRecord['image_url'])->getBody();
                $image = imagecreatetruecolor($width, $height);
                imagepng($image, $path);
                unset($image);
                $client->postMultipart('/image_upload.php?action=upload_device_image', [
                    'device_id' => '1', 'revision' => (string)$before['revision'],
                    'replace_image_id' => (string)$imageId,
                ], ['image' => ['path' => $path, 'type' => 'image/png']])->assertStatus(400);
                $after = $client->get('/api.php?action=load')->assertOk()->getJson();
                $this->assertSame($before['revision'], $after['revision']);
                $this->assertSame($oldRecord, $after['device_images'][0]);
                $this->assertSame($oldBytes, $client->get('/' . $oldRecord['image_url'])->getBody());
            }
            $this->assertFalse(str_contains(
                is_file($errorLog) ? (string)file_get_contents($errorLog) : '',
                'imagedestroy'
            ), '画像登録・差替え・縮小・サムネイルで非推奨GD呼出しを記録しない');
        } finally {
            $server->stop();
            @unlink($prepend);
            @unlink($errorLog);
        }
    }

    public function testGcRemovesCachedThumbnailsAndRetriesFailures(): void
    {
        require_once dirname(__DIR__, 2) . '/bootstrap.php';

        $db = new PDO('sqlite::memory:');
        $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        \migrateDatabase($db);

        $root = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'netarium_image_gc_' . bin2hex(random_bytes(8));
        $originalDir = $root . DIRECTORY_SEPARATOR . 'uploads';
        $thumbDir = $root . DIRECTORY_SEPARATOR . 'cache' . DIRECTORY_SEPARATOR . 'thumbnails';
        mkdir($originalDir, 0700, true);
        mkdir($thumbDir, 0700, true);
        $config = [
            'device_image_directory' => $originalDir,
            'device_image_thumb_directory' => $thumbDir,
        ];
        $service = new DeviceImageService($db);
        $names = [
            str_repeat('a', 32) . '.png',
            str_repeat('b', 32) . '.jpg',
            str_repeat('c', 32) . '.png',
        ];
        $extraNames = [];

        try {
            // 差替え・削除・機器完全削除の予約は、いずれも同じGC経路で消化される。
            foreach ($names as $name) {
                $stmt = $db->prepare('INSERT INTO device_image_gc (stored_name, queued_at) VALUES (?, ?)');
                $stmt->execute([$name, date(DATE_ATOM)]);
                file_put_contents($thumbDir . DIRECTORY_SEPARATOR . 'thumb_320_' . $name, 'cached');
            }
            file_put_contents($originalDir . DIRECTORY_SEPARATOR . $names[0], 'original');
            file_put_contents($originalDir . DIRECTORY_SEPARATOR . $names[1], 'original');
            // 原本消失後にも残ったサムネイルを回収する。
            $this->assertSame(3, $service->processGcQueue($config));
            foreach ($names as $name) {
                $this->assertFalse(file_exists($originalDir . DIRECTORY_SEPARATOR . $name));
                $this->assertFalse(file_exists($thumbDir . DIRECTORY_SEPARATOR . 'thumb_320_' . $name));
            }
            $this->assertSame(0, (int)$db->query('SELECT COUNT(*) FROM device_image_gc')->fetchColumn());

            $retryName = str_repeat('d', 32) . '.png';
            $retryThumb = $thumbDir . DIRECTORY_SEPARATOR . 'thumb_320_' . $retryName;
            file_put_contents($originalDir . DIRECTORY_SEPARATOR . $retryName, 'original');
            // 削除できないサムネイルがある場合、原本の削除後も予約を維持する。
            mkdir($retryThumb);
            $stmt->execute([$retryName, '2000-01-01T00:00:00+00:00']);
            $this->assertSame(0, $service->processGcQueue($config));
            $this->assertFalse(file_exists($originalDir . DIRECTORY_SEPARATOR . $retryName));
            $this->assertSame(1, (int)$db->query('SELECT COUNT(*) FROM device_image_gc')->fetchColumn());

            // 100件を超える復元後GCでも、先頭の失敗予約が後続を塞がない。
            for ($i = 0; $i < 101; $i++) {
                $name = sprintf('%032x', $i + 256) . '.png';
                $extraNames[] = $name;
                $stmt->execute([$name, '2020-01-01T00:00:00+00:00']);
                file_put_contents($thumbDir . DIRECTORY_SEPARATOR . 'thumb_320_' . $name, 'cached');
            }
            $this->assertSame(101, $service->processGcQueue($config));
            $this->assertSame(1, (int)$db->query('SELECT COUNT(*) FROM device_image_gc')->fetchColumn());
            foreach ($extraNames as $name) {
                $this->assertFalse(file_exists($thumbDir . DIRECTORY_SEPARATOR . 'thumb_320_' . $name));
            }

            rmdir($retryThumb);
            file_put_contents($retryThumb, 'cached');
            $this->assertSame(1, $service->processGcQueue($config));
            $this->assertFalse(file_exists($retryThumb));
            $this->assertSame(0, (int)$db->query('SELECT COUNT(*) FROM device_image_gc')->fetchColumn());
        } finally {
            foreach ([...$names, str_repeat('d', 32) . '.png', ...$extraNames] as $name) {
                @unlink($originalDir . DIRECTORY_SEPARATOR . $name);
                $thumb = $thumbDir . DIRECTORY_SEPARATOR . 'thumb_320_' . $name;
                if (is_dir($thumb)) {
                    @rmdir($thumb);
                } else {
                    @unlink($thumb);
                }
            }
            @rmdir($thumbDir);
            @rmdir(dirname($thumbDir));
            @rmdir($originalDir);
            @rmdir($root);
        }
    }

    public function testImageOperationsReturnDeviceRevisionAndAllowSubsequentResourceSave(): void
    {
        $server = new \Netarium\Tests\TestServer();
        try {
            $server->start();
            $client = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($client->login('admin', 'admin123'));

            $pngA = $server->getTempDir() . '/rev_a.png';
            $pngB = $server->getTempDir() . '/rev_b.png';
            foreach ([$pngA, $pngB] as $path) {
                $im = imagecreatetruecolor(2, 2);
                imagepng($im, $path);
                unset($im);
            }

            $findDevice = function (array $loadData, int $deviceId): array {
                foreach ($loadData['devices'] as $dev) {
                    if ((int)$dev['id'] === $deviceId) {
                        return $dev;
                    }
                }
                $this->fail("機器ID {$deviceId} が見つかりません");
            };

            $deviceId = 1;
            $load0 = $client->get('/api.php?action=load')->assertOk()->getJson();
            $dataRev = (int)$load0['revision'];
            $dev = $findDevice($load0, $deviceId);
            $initialDevRev = (int)$dev['resource_revision'];
            $devRev = $initialDevRev;

            // 1. 新規追加 (upload_device_image) が device_revision を返し、再読込なしで save_resources できる
            $up1 = $client->postMultipart(
                '/image_upload.php?action=upload_device_image',
                [
                    'device_id' => (string)$deviceId,
                    'revision' => (string)$dataRev,
                    'expected_device_revision' => (string)$devRev,
                    'caption' => '1枚目',
                ],
                ['image' => ['path' => $pngA, 'filename' => 'a.png', 'type' => 'image/png']]
            )->assertOk()->getJson();
            $this->assertSame($devRev, $up1['previous_device_revision']);
            $this->assertTrue(is_int($up1['device_revision']) && $up1['device_revision'] > $devRev);
            $dataRev = (int)$up1['revision'];
            $devRev = $up1['device_revision'];
            $img1Id = (int)$up1['images'][0]['id'];
            $loadedAfterUp1 = $findDevice($client->get('/api.php?action=load')->assertOk()->getJson(), $deviceId);
            $this->assertSame($devRev, (int)$loadedAfterUp1['resource_revision']);

            // 画像追加前の古い expected_revision では save_resources が 409 になる
            $staleSave = $dev;
            $staleSave['memo'] = 'stale-should-409';
            $client->postJson('/api.php?action=save_resources', [
                'devices' => [['operation' => 'update', 'id' => $deviceId, 'expected_revision' => $initialDevRev, 'device' => $staleSave]],
                'views' => [],
            ])->assertStatus(409);

            // 返却された device_revision を expected_revision に使えば save_resources が成功する
            $dev['memo'] = 'after-upload';
            $saveAfterUp1 = $client->postJson('/api.php?action=save_resources', [
                'devices' => [['operation' => 'update', 'id' => $deviceId, 'expected_revision' => $devRev, 'device' => $dev]],
                'views' => [],
            ])->assertOk()->getJson();
            $dataRev = (int)$saveAfterUp1['revision'];
            $dev = $saveAfterUp1['devices'][0];
            $this->assertSame('after-upload', $dev['memo']);
            $this->assertTrue((int)$dev['resource_revision'] > $devRev);
            $devRev = (int)$dev['resource_revision'];

            // 2. 2枚目を追加して差替え・並替の前提を作る
            $up2 = $client->postMultipart(
                '/image_upload.php?action=upload_device_image',
                [
                    'device_id' => (string)$deviceId,
                    'revision' => (string)$dataRev,
                    'expected_device_revision' => (string)$devRev,
                    'caption' => '2枚目',
                ],
                ['image' => ['path' => $pngB, 'filename' => 'b.png', 'type' => 'image/png']]
            )->assertOk()->getJson();
            $this->assertSame($devRev, $up2['previous_device_revision']);
            $this->assertTrue(is_int($up2['device_revision']) && $up2['device_revision'] > $devRev);
            $dataRev = (int)$up2['revision'];
            $devRev = $up2['device_revision'];
            $img2Id = (int)$up2['images'][1]['id'];

            // 3. 画像差替え (replace_image_id) も device_revision を返し、即 save_resources できる
            $rep = $client->postMultipart(
                '/image_upload.php?action=upload_device_image',
                [
                    'device_id' => (string)$deviceId,
                    'revision' => (string)$dataRev,
                    'expected_device_revision' => (string)$devRev,
                    'replace_image_id' => (string)$img1Id,
                    'caption' => '1枚目差替',
                ],
                ['image' => ['path' => $pngB, 'filename' => 'b2.png', 'type' => 'image/png']]
            )->assertOk()->getJson();
            $this->assertSame($devRev, $rep['previous_device_revision']);
            $this->assertTrue(is_int($rep['device_revision']) && $rep['device_revision'] > $devRev);
            $dataRev = (int)$rep['revision'];
            $devRev = $rep['device_revision'];
            $loadedAfterRep = $findDevice($client->get('/api.php?action=load')->assertOk()->getJson(), $deviceId);
            $this->assertSame($devRev, (int)$loadedAfterRep['resource_revision']);

            $dev['name'] = 'After-Replace-Name';
            $saveAfterRep = $client->postJson('/api.php?action=save_resources', [
                'devices' => [['operation' => 'update', 'id' => $deviceId, 'expected_revision' => $devRev, 'device' => $dev]],
                'views' => [],
            ])->assertOk()->getJson();
            $dataRev = (int)$saveAfterRep['revision'];
            $dev = $saveAfterRep['devices'][0];
            $this->assertSame('After-Replace-Name', $dev['name']);
            $devRev = (int)$dev['resource_revision'];

            // 4. 順序入替・説明文更新 (update_device_images) も device_revision を返し、即 save_resources できる
            $upd = $client->postJson('/api.php?action=update_device_images', [
                'device_id' => $deviceId,
                'revision' => $dataRev,
                'expected_device_revision' => $devRev,
                'images' => [
                    ['id' => $img2Id, 'caption' => '説明更新1'],
                    ['id' => $img1Id, 'caption' => '説明更新2'],
                ],
            ])->assertOk()->getJson();
            $this->assertSame($devRev, $upd['previous_device_revision']);
            $this->assertTrue(is_int($upd['device_revision']) && $upd['device_revision'] > $devRev);
            $dataRev = (int)$upd['revision'];
            $devRev = $upd['device_revision'];
            $loadedAfterUpd = $findDevice($client->get('/api.php?action=load')->assertOk()->getJson(), $deviceId);
            $this->assertSame($devRev, (int)$loadedAfterUpd['resource_revision']);

            $dev['memo'] = 'after-update-images';
            $saveAfterUpd = $client->postJson('/api.php?action=save_resources', [
                'devices' => [['operation' => 'update', 'id' => $deviceId, 'expected_revision' => $devRev, 'device' => $dev]],
                'views' => [],
            ])->assertOk()->getJson();
            $dataRev = (int)$saveAfterUpd['revision'];
            $dev = $saveAfterUpd['devices'][0];
            $devRev = (int)$dev['resource_revision'];

            // 5. 画像削除 (delete_device_image) も device_revision を返し、即 save_resources と別クライアント競合検知が成立する
            $del = $client->postJson('/api.php?action=delete_device_image', [
                'device_id' => $deviceId,
                'image_id' => $img1Id,
                'revision' => $dataRev,
                'expected_device_revision' => $devRev,
            ])->assertOk()->getJson();
            $this->assertSame($devRev, $del['previous_device_revision']);
            $this->assertTrue(is_int($del['device_revision']) && $del['device_revision'] > $devRev);
            $revBeforeConcurrentSave = $devRev;
            $devRev = $del['device_revision'];
            $loadedAfterDel = $findDevice($client->get('/api.php?action=load')->assertOk()->getJson(), $deviceId);
            $this->assertSame($devRev, (int)$loadedAfterDel['resource_revision']);

            // 削除前の expected_revision では 409 になる
            $staleAfterDel = $dev;
            $staleAfterDel['memo'] = 'stale-after-delete';
            $client->postJson('/api.php?action=save_resources', [
                'devices' => [['operation' => 'update', 'id' => $deviceId, 'expected_revision' => $revBeforeConcurrentSave, 'device' => $staleAfterDel]],
                'views' => [],
            ])->assertStatus(409);

            // 別クライアントとの同時更新競合では 409 になり後勝ち上書きしない
            $otherClient = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($otherClient->login('admin', 'admin123'));
            $otherLoad = $otherClient->get('/api.php?action=load')->assertOk()->getJson();
            $otherDev = $findDevice($otherLoad, $deviceId);
            $this->assertSame($devRev, (int)$otherDev['resource_revision']);

            $dev['name'] = 'First-Client-Wins';
            $client->postJson('/api.php?action=save_resources', [
                'devices' => [['operation' => 'update', 'id' => $deviceId, 'expected_revision' => $devRev, 'device' => $dev]],
                'views' => [],
            ])->assertOk();

            $otherDev['name'] = 'Second-Client-Must-Conflict';
            $otherClient->postJson('/api.php?action=save_resources', [
                'devices' => [['operation' => 'update', 'id' => $deviceId, 'expected_revision' => $devRev, 'device' => $otherDev]],
                'views' => [],
            ])->assertStatus(409);

            $finalDev = $findDevice($client->get('/api.php?action=load')->assertOk()->getJson(), $deviceId);
            $this->assertSame('First-Client-Wins', $finalDev['name']);
        } finally {
            $server->stop();
        }
    }

    public function testStaleExpectedDeviceRevisionRejectedEvenWithCurrentDataRevision(): void
    {
        $server = new \Netarium\Tests\TestServer();
        try {
            $server->start();
            $clientA = new TestHttpClient($server->getBaseUrl());
            $clientB = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($clientA->login('admin', 'admin123'));
            $this->assertTrue($clientB->login('admin', 'admin123'));

            $png = $server->getTempDir() . '/stale_dev_rev.png';
            $im = imagecreatetruecolor(2, 2);
            imagepng($im, $png);
            unset($im);

            $findDevice = function (array $loadData, int $deviceId): array {
                foreach ($loadData['devices'] as $dev) {
                    if ((int)$dev['id'] === $deviceId) {
                        return $dev;
                    }
                }
                $this->fail("機器ID {$deviceId} が見つかりません");
            };

            // 機器1に初期画像を1枚登録し、無関係な機器2も作成した状態で両クライアントがロード
            $loadInit = $clientA->get('/api.php?action=load')->assertOk()->getJson();
            $dev1 = $findDevice($loadInit, 1);
            $upInit = $clientA->postMultipart(
                '/image_upload.php?action=upload_device_image',
                [
                    'device_id' => '1',
                    'revision' => (string)$loadInit['revision'],
                    'expected_device_revision' => (string)$dev1['resource_revision'],
                    'caption' => 'initial',
                ],
                ['image' => ['path' => $png, 'filename' => 'init.png', 'type' => 'image/png']]
            )->assertOk()->getJson();
            $img1Id = (int)$upInit['images'][0]['id'];

            $newDev2 = $dev1;
            unset($newDev2['id'], $newDev2['resource_revision']);
            $newDev2['name'] = 'Unrelated-Device-B';
            $newDev2['ip'] = '192.168.99.2';
            $saveDev2 = $clientA->postJson('/api.php?action=save_resources', [
                'devices' => [['operation' => 'create', 'id' => 980001, 'device' => $newDev2]],
                'views' => [],
            ])->assertOk()->getJson();
            $dev2 = $saveDev2['devices'][0];
            $dev2Id = (int)$dev2['id'];

            $loadA = $clientA->get('/api.php?action=load')->assertOk()->getJson();
            $loadB = $clientB->get('/api.php?action=load')->assertOk()->getJson();
            $dev1A = $findDevice($loadA, 1);
            $dev1B = $findDevice($loadB, 1);
            $staleDev1RevA = (int)$dev1A['resource_revision'];

            // 1. クライアントBが機器1の属性を更新（機器1の resource_revision が進む）
            $dev1B['name'] = 'ClientB-Updated-DeviceA';
            $saveB = $clientB->postJson('/api.php?action=save_resources', [
                'devices' => [['operation' => 'update', 'id' => 1, 'expected_revision' => (int)$dev1B['resource_revision'], 'device' => $dev1B]],
                'views' => [],
            ])->assertOk()->getJson();
            $remoteDev1Rev = (int)$saveB['devices'][0]['resource_revision'];

            // 2. クライアントAは無関係な機器2だけを保存して最新の全体 data_revision を得る（機器1は古いまま）
            $dev2['memo'] = 'ClientA-Saved-DeviceB';
            $saveDev2A = $clientA->postJson('/api.php?action=save_resources', [
                'devices' => [['operation' => 'update', 'id' => $dev2Id, 'expected_revision' => (int)$dev2['resource_revision'], 'device' => $dev2]],
                'views' => [],
            ])->assertOk()->getJson();
            $currentGlobalRevA = (int)$saveDev2A['revision'];

            // 不正な expected_device_revision (0) は 400 で拒否
            $clientA->postMultipart(
                '/image_upload.php?action=upload_device_image',
                [
                    'device_id' => '1',
                    'revision' => (string)$currentGlobalRevA,
                    'expected_device_revision' => '0',
                ],
                ['image' => ['path' => $png, 'filename' => 'bad.png', 'type' => 'image/png']]
            )->assertStatus(400);

            // 3. クライアントAは最新の全体 data_revision を持っていても、古い expected_device_revision では全画像APIが 409 になる
            $clientA->postMultipart(
                '/image_upload.php?action=upload_device_image',
                [
                    'device_id' => '1',
                    'revision' => (string)$currentGlobalRevA,
                    'expected_device_revision' => (string)$staleDev1RevA,
                    'caption' => 'stale-upload',
                ],
                ['image' => ['path' => $png, 'filename' => 'stale.png', 'type' => 'image/png']]
            )->assertStatus(409);

            $clientA->postJson('/api.php?action=update_device_images', [
                'device_id' => 1,
                'revision' => $currentGlobalRevA,
                'expected_device_revision' => $staleDev1RevA,
                'images' => [['id' => $img1Id, 'caption' => 'stale-caption']],
            ])->assertStatus(409);

            $clientA->postJson('/api.php?action=delete_device_image', [
                'device_id' => 1,
                'image_id' => $img1Id,
                'revision' => $currentGlobalRevA,
                'expected_device_revision' => $staleDev1RevA,
            ])->assertStatus(409);

            // 4. サーバー上の機器1の名前・resource_revision・画像は一切変更・上書きされていない
            $afterCheck = $clientB->get('/api.php?action=load')->assertOk()->getJson();
            $afterDev1 = $findDevice($afterCheck, 1);
            $this->assertSame('ClientB-Updated-DeviceA', $afterDev1['name']);
            $this->assertSame($remoteDev1Rev, (int)$afterDev1['resource_revision']);
            $this->assertCount(1, $afterCheck['device_images']);
            $this->assertSame('initial', $afterCheck['device_images'][0]['caption']);
        } finally {
            $server->stop();
        }
    }

    public function testThumbEndpointRegeneratesCorruptedZeroByteCacheFile(): void
    {
        $server = new \Netarium\Tests\TestServer();
        try {
            $server->start();
            $client = new TestHttpClient($server->getBaseUrl());
            $this->assertTrue($client->login('admin', 'admin123'));

            $path = $server->getTempDir() . '/source-thumb.png';
            $img = imagecreatetruecolor(640, 480);
            imagepng($img, $path);
            unset($img);

            $before = $client->get('/api.php?action=load')->assertOk()->getJson();
            $uploaded = $client->postMultipart('/image_upload.php?action=upload_device_image', [
                'device_id' => '1',
                'revision' => (string)$before['revision'],
            ], ['image' => ['path' => $path, 'type' => 'image/png']])->assertOk()->getJson();

            $db = new PDO('sqlite:' . $server->getDbPath());
            $storedName = (string)$db->query('SELECT stored_name FROM device_images WHERE id = ' . (int)$uploaded['images'][0]['id'])->fetchColumn();
            $thumbDir = $server->getTempDir() . '/cache/thumbnails';
            if (!is_dir($thumbDir)) {
                mkdir($thumbDir, 0755, true);
            }
            $thumbPath = $thumbDir . '/thumb_320_' . $storedName;
            file_put_contents($thumbPath, '');
            $this->assertSame(0, filesize($thumbPath));

            $response = $client->get('/' . $uploaded['images'][0]['image_url'] . '&size=thumb')->assertStatus(200);
            $body = $response->getBody();
            $this->assertTrue(strlen($body) > 0);
            $this->assertTrue(getimagesizefromstring($body) !== false);
            clearstatcache(true, $thumbPath);
            $this->assertTrue(filesize($thumbPath) > 0);
        } finally {
            $db = null;
            $server->stop();
        }
    }
}
