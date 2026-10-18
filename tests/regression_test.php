<?php
declare(strict_types=1);

namespace Netarium\Tests;

use ReflectionClass;
use ReflectionMethod;
use Throwable;

require_once __DIR__ . '/TestCase.php';
require_once __DIR__ . '/TestHttpClient.php';
require_once __DIR__ . '/TestServer.php';

require_once __DIR__ . '/suites/AuthTest.php';
require_once __DIR__ . '/suites/PasswordHashingTest.php';
require_once __DIR__ . '/suites/InitialSetupTest.php';
require_once __DIR__ . '/suites/PasswordBlocklistTest.php';
require_once __DIR__ . '/suites/AuthenticationLimitsTest.php';
require_once __DIR__ . '/suites/PasswordPolicyTest.php';
require_once __DIR__ . '/suites/LoadSaveTest.php';
require_once __DIR__ . '/suites/PingTest.php';
require_once __DIR__ . '/suites/CsvTest.php';
require_once __DIR__ . '/suites/BackupTest.php';
require_once __DIR__ . '/suites/OperationGateTest.php';
require_once __DIR__ . '/suites/DataQualityTest.php';
require_once __DIR__ . '/suites/FloorPlanTest.php';
require_once __DIR__ . '/suites/AuditTest.php';
require_once __DIR__ . '/suites/DeviceImageTest.php';
require_once __DIR__ . '/suites/AuthenticatedImageCacheTest.php';
require_once __DIR__ . '/suites/ResourceSaveTest.php';
require_once __DIR__ . '/suites/TransportSecurityTest.php';
require_once __DIR__ . '/suites/SecurityHeadersTest.php';
require_once __DIR__ . '/suites/CapacityTest.php';
require_once __DIR__ . '/suites/BackupAcceptanceTest.php';

class RegressionTestRunner
{
    private array $suites = [
        Suites\SecurityHeadersTest::class,
        Suites\AuthTest::class,
        Suites\PasswordHashingTest::class,
        Suites\InitialSetupTest::class,
        Suites\PasswordBlocklistTest::class,
        Suites\AuthenticationLimitsTest::class,
        Suites\PasswordPolicyTest::class,
        Suites\LoadSaveTest::class,
        Suites\PingTest::class,
        Suites\CsvTest::class,
        Suites\BackupTest::class,
        Suites\OperationGateTest::class,
        Suites\DataQualityTest::class,
        Suites\FloorPlanTest::class,
        Suites\AuditTest::class,
        Suites\DeviceImageTest::class,
        Suites\AuthenticatedImageCacheTest::class,
        Suites\ResourceSaveTest::class,
        Suites\TransportSecurityTest::class,
        Suites\CapacityTest::class,
        Suites\BackupAcceptanceTest::class,
    ];

    public function run(): int
    {
        $startTime = microtime(true);
        echo "============================================================\n";
        echo " Netarium API 回帰確認テスト (Phase 0)\n";
        echo "============================================================\n\n";

        $server = new TestServer();
        echo "テスト環境を初期化中 (一時DB・マイグレーション・シード投入)... ";
        
        try {
            $server->start();
            echo "OK\n";
            echo "テスト用Webサーバー起動: " . $server->getBaseUrl() . "\n";
            echo "データ分離ディレクトリ: " . $server->getTempDir() . "\n\n";
        } catch (Throwable $e) {
            echo "FAILED\n";
            echo "サーバー起動エラー: " . $e->getMessage() . "\n";
            return 1;
        }

        $client = new TestHttpClient($server->getBaseUrl());
        echo "管理者ユーザーでログイン中... ";
        if (!$client->login('admin', 'admin123')) {
            echo "FAILED\n";
            $server->stop();
            return 1;
        }
        echo "OK\n\n";

        $totalTests = 0;
        $totalAssertions = 0;
        $passedCount = 0;
        $failedCount = 0;
        $failures = [];

        foreach ($this->suites as $suiteClass) {
            $refClass = new ReflectionClass($suiteClass);
            $suiteName = $refClass->getShortName();
            echo "------------------------------------------------------------\n";
            echo " [Suite] {$suiteName}\n";
            echo "------------------------------------------------------------\n";

            /** @var TestCase $suiteInstance */
            $suiteInstance = new $suiteClass($client);

            $methods = $refClass->getMethods(ReflectionMethod::IS_PUBLIC);
            foreach ($methods as $method) {
                if (!str_starts_with($method->getName(), 'test')) {
                    continue;
                }

                $testName = $method->getName();
                $totalTests++;
                $suiteInstance->resetAssertionsCount();

                try {
                    $method->invoke($suiteInstance);
                    $assertions = $suiteInstance->getAssertionsCount();
                    $totalAssertions += $assertions;
                    $passedCount++;
                    echo "  [PASS] {$testName} ({$assertions} assertions)\n";
                } catch (Throwable $e) {
                    $failedCount++;
                    $failures[] = [
                        'suite' => $suiteName,
                        'test' => $testName,
                        'message' => $e->getMessage(),
                        'file' => $e->getFile(),
                        'line' => $e->getLine(),
                        'trace' => $e->getTraceAsString(),
                    ];
                    echo "  [FAIL] {$testName}: " . $e->getMessage() . "\n";
                }
            }
            echo "\n";
        }

        echo "テストサーバーを停止・一時データを削除中... ";
        $server->stop();
        echo "OK\n\n";

        $duration = round(microtime(true) - $startTime, 2);

        echo "============================================================\n";
        echo " テスト実行サマリー\n";
        echo "============================================================\n";
        echo "実行時間: {$duration} 秒\n";
        echo "総テスト数: {$totalTests}\n";
        echo "総アサーション数: {$totalAssertions}\n";
        echo "成功: {$passedCount}\n";
        echo "失敗: {$failedCount}\n";

        if ($failedCount > 0) {
            echo "\n------------------------------------------------------------\n";
            echo " 失敗詳細:\n";
            echo "------------------------------------------------------------\n";
            foreach ($failures as $idx => $fail) {
                $num = $idx + 1;
                echo "{$num}) {$fail['suite']}::{$fail['test']}\n";
                echo "   {$fail['message']}\n";
                echo "   at {$fail['file']}:{$fail['line']}\n\n";
            }
            return 1;
        }

        echo "\n>>> 全テスト合格! 現行APIの振る舞いが正常に固定されています <<<\n";
        return 0;
    }
}

// Execute runner if invoked directly from CLI
if (php_sapi_name() === 'cli' && isset($argv[0]) && realpath($argv[0]) === realpath(__FILE__)) {
    $runner = new RegressionTestRunner();
    exit($runner->run());
}
