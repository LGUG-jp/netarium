<?php
declare(strict_types=1);

namespace Netarium\Tests\Suites;

use Netarium\Core\ApiException;
use Netarium\Core\Config;
use Netarium\Services\Storage\CapacityService;
use Netarium\Tests\TestCase;

final class CapacityTest extends TestCase
{
    public function testDefaultImageStorageAcceptsTwelveHundredImagesAndFloorPlans(): void
    {
        $config = Config::create();
        $mib = CapacityService::BYTES_PER_MIB;
        // Capacity arithmetic deliberately avoids allocating 1.2GiB of fixture images.
        foreach ([[108, 200 * $mib], [1200, 1200 * $mib], [1300, 2200 * $mib]] as [$files, $bytes]) {
            CapacityService::assertImageUsage($files, $bytes, $config);
            $usage = CapacityService::imageUsage($files, $bytes, $config);
            $this->assertSame($files, $usage['files']);
            $this->assertSame($bytes, $usage['bytes']);
            $this->assertNull($usage['limits']['files']);
            $this->assertNull($usage['limits']['bytes']);
            $this->assertFalse($usage['near_limit']);
            $this->assertSame([], $usage['warnings']);
        }
        $this->assertSame(3, $config['max_device_images_per_device']);
        $this->assertSame(30 * $mib, $config['floor_plan_upload_max_bytes']);
        $this->assertSame(31 * $mib, $config['image_upload_max_request_bytes']);
        $this->assertSame(100, CapacityService::limits($config)['floor_plans']['max_files']);
    }

    public function testZeroAndNullQuotasAreUnlimitedAndLegacyBackupKeysAreIgnored(): void
    {
        foreach ([0, null] as $quota) {
            $config = [
                'max_backup_restore_files' => 1,
                'max_backup_restore_bytes' => 1,
                'max_backup_restore_uncompressed_bytes' => 1,
                'max_backup_restore_entry_bytes' => 1,
                'max_floor_plan_total_bytes' => 1,
                'max_floor_plan_bytes' => 1,
                'storage_capacity' => ['images' => ['max_files' => $quota, 'max_total_bytes' => $quota]],
            ];
            $limits = CapacityService::limits($config);
            $this->assertNull($limits['images']['max_files']);
            $this->assertNull($limits['images']['max_total_bytes']);
            $this->assertSame(10 * CapacityService::BYTES_PER_MIB, $limits['images']['max_entry_bytes']);
            $this->assertSame(24 * CapacityService::BYTES_PER_MIB, $limits['backup']['max_zip_bytes']);
            CapacityService::assertImageUsage(1201, 1201 * CapacityService::BYTES_PER_MIB, $config);
        }
    }

    public function testOptionalQuotasKeepInclusiveBoundariesAndWarnings(): void
    {
        $config = ['storage_capacity' => ['images' => ['max_files' => 1200, 'max_total_bytes' => 2000]]];
        CapacityService::assertImageUsage(1200, 2000, $config);
        $this->assertFalse(CapacityService::imageUsage(959, 1599, $config)['near_limit']);
        $this->assertSame(['画像ファイル数が上限に近づいています'], CapacityService::imageUsage(960, 1599, $config)['warnings']);
        $this->assertSame(['画像総容量が上限に近づいています'], CapacityService::imageUsage(959, 1600, $config)['warnings']);
        foreach ([[1201, 2000], [1200, 2001], [-1, 0], [0, -1]] as [$files, $bytes]) {
            $this->assertRejected(static fn() => CapacityService::assertImageUsage($files, $bytes, $config));
        }
        $this->assertRejected(static fn() => CapacityService::assertImageUsage(0, -1, []));
    }

    public function testImageEntryAndWebZipHaveIndependentBoundaries(): void
    {
        $config = Config::create();
        $mib = CapacityService::BYTES_PER_MIB;
        CapacityService::assertImageEntrySize(10 * $mib, $config, '画像');
        $this->assertRejected(static fn() => CapacityService::assertImageEntrySize(10 * $mib + 1, $config, '画像'));
        $this->assertRejected(static fn() => CapacityService::assertImageEntrySize(0, $config, '画像'));
        $limits = CapacityService::limits($config)['backup'];
        $this->assertSame(['max_zip_bytes' => 24 * $mib, 'max_uncompressed_bytes' => 64 * $mib, 'max_entry_bytes' => 64 * $mib, 'max_files' => 2], $limits);
        CapacityService::assertBackupUsage(2, 64 * $mib, 24 * $mib, $config);
        foreach ([[3, 64 * $mib, 24 * $mib], [2, 64 * $mib + 1, 24 * $mib], [2, 64 * $mib, 24 * $mib + 1]] as [$files, $bytes, $zip]) {
            $this->assertRejected(static fn() => CapacityService::assertBackupUsage($files, $bytes, $zip, $config));
        }
        // Two required JSON entries do not themselves warrant a capacity warning.
        $usage = CapacityService::backupUsage(2, 1024, 512, 1200, 1200 * $mib, $config);
        $this->assertFalse($usage['near_limit']);
        $this->assertSame([], $usage['warnings']);
    }
    public function testLocalConfigLoadsAndValidatesOptionalQuotas(): void
    {
        $dir = sys_get_temp_dir() . '/netarium_test_quota_' . bin2hex(random_bytes(8));
        mkdir($dir . '/config', 0700, true);
        mkdir($dir . '/data', 0700, true);
        $appPhp = $dir . '/config/app.php';
        try {
            file_put_contents($appPhp, "<?php return [
                'storage_dir' => " . var_export($dir . '/data', true) . ",
                'storage_capacity' => [
                    'images' => [
                        'max_files' => 1200,
                        'max_total_bytes' => 2000000,
                    ],
                ],
            ];");
            $config = Config::create($dir);
            $limits = CapacityService::limits($config);
            $this->assertSame(1200, $limits['images']['max_files']);
            $this->assertSame(2000000, $limits['images']['max_total_bytes']);

            foreach ([
                "['storage_capacity' => 'invalid']",
                "['storage_capacity' => ['unknown' => []]]",
                "['storage_capacity' => ['images' => 'invalid']]",
                "['storage_capacity' => ['images' => ['unknown' => 1]]]",
                "['storage_capacity' => ['images' => ['max_files' => -1]]]",
                "['storage_capacity' => ['images' => ['max_files' => 'not-int']]]",
            ] as $invalidSnippet) {
                file_put_contents($appPhp, "<?php return array_merge(['storage_dir' => " . var_export($dir . '/data', true) . "], {$invalidSnippet});");
                try {
                    Config::create($dir);
                    $this->fail('Expected rejection for invalid storage_capacity: ' . $invalidSnippet);
                } catch (\RuntimeException $e) {
                    $this->assertStringContains('storage_capacity', $e->getMessage());
                }
            }
        } finally {
            @unlink($appPhp);
            @rmdir($dir . '/config');
            @rmdir($dir . '/data');
            @rmdir($dir);
        }
    }

    private function assertRejected(callable $operation): void
    {
        try {
            $operation();
        } catch (ApiException $exception) {
            $this->assertSame(400, $exception->getHttpStatus());
            return;
        }
        $this->fail('Expected capacity limit rejection');
    }
}
