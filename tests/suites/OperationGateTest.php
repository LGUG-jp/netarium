<?php
declare(strict_types=1);

namespace Netarium\Tests\Suites;

use Netarium\Core\ApiException;
use Netarium\Core\OperationGate;
use Netarium\Tests\TestCase;

require_once __DIR__ . '/../../src/Autoloader.php';
\Netarium\Autoloader::register();

class OperationGateTest extends TestCase
{
    public function testRestoreLockRejectsConcurrentOperations(): void
    {
        $lockPath = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'netarium-gate-' . bin2hex(random_bytes(8)) . '.lock';
        $restoreGate = new OperationGate($lockPath);
        $sharedGate = new OperationGate($lockPath);
        $normalGate = new OperationGate($lockPath);

        try {
            $restoreGate->acquireExclusive();

            try {
                $sharedGate->acquireShared();
                $this->assertTrue(false, 'Shared operations must be rejected during restore');
            } catch (ApiException $e) {
                $this->assertSame(409, $e->getHttpStatus());
            }

            $restoreGate->release();
            $sharedGate->acquireShared();

            try {
                $normalGate->acquireExclusive();
                $this->assertTrue(false, 'Restore must be rejected while a shared operation is active');
            } catch (ApiException $e) {
                $this->assertSame(409, $e->getHttpStatus());
            }
        } finally {
            $restoreGate->release();
            $sharedGate->release();
            $normalGate->release();
            @unlink($lockPath);
        }
    }
}
