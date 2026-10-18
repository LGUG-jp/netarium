<?php
declare(strict_types=1);

namespace Netarium\Tests;

use Exception;
use Throwable;

class TestAssertionException extends Exception
{
}

abstract class TestCase
{
    private int $assertionsCount = 0;

    public function getAssertionsCount(): int
    {
        return $this->assertionsCount;
    }

    public function resetAssertionsCount(): void
    {
        $this->assertionsCount = 0;
    }

    protected function assertTrue(bool $condition, string $message = ''): void
    {
        $this->assertionsCount++;
        if (!$condition) {
            $msg = $message !== '' ? $message : 'Failed asserting that condition is true.';
            throw new TestAssertionException($msg);
        }
    }

    protected function assertFalse(bool $condition, string $message = ''): void
    {
        $this->assertionsCount++;
        if ($condition) {
            $msg = $message !== '' ? $message : 'Failed asserting that condition is false.';
            throw new TestAssertionException($msg);
        }
    }

    protected function assertSame(mixed $expected, mixed $actual, string $message = ''): void
    {
        $this->assertionsCount++;
        if ($expected !== $actual) {
            $expectedStr = is_scalar($expected) || $expected === null ? var_export($expected, true) : json_encode($expected, JSON_UNESCAPED_UNICODE);
            $actualStr = is_scalar($actual) || $actual === null ? var_export($actual, true) : json_encode($actual, JSON_UNESCAPED_UNICODE);
            $msg = $message !== '' ? $message : "Failed asserting that {$actualStr} is identical to expected {$expectedStr}.";
            throw new TestAssertionException($msg);
        }
    }

    protected function assertNotSame(mixed $expected, mixed $actual, string $message = ''): void
    {
        $this->assertionsCount++;
        if ($expected === $actual) {
            $valStr = is_scalar($actual) || $actual === null ? var_export($actual, true) : json_encode($actual, JSON_UNESCAPED_UNICODE);
            $msg = $message !== '' ? $message : "Failed asserting that value is not identical to {$valStr}.";
            throw new TestAssertionException($msg);
        }
    }

    protected function assertNull(mixed $actual, string $message = ''): void
    {
        $this->assertSame(null, $actual, $message);
    }

    protected function assertNotNull(mixed $actual, string $message = ''): void
    {
        $this->assertionsCount++;
        if ($actual === null) {
            $msg = $message !== '' ? $message : 'Failed asserting that value is not null.';
            throw new TestAssertionException($msg);
        }
    }

    protected function assertArrayHasKey(string|int $key, array $array, string $message = ''): void
    {
        $this->assertionsCount++;
        if (!array_key_exists($key, $array)) {
            $msg = $message !== '' ? $message : "Failed asserting that array has key '{$key}'.";
            throw new TestAssertionException($msg);
        }
    }

    protected function assertArrayNotHasKey(string|int $key, array $array, string $message = ''): void
    {
        $this->assertionsCount++;
        if (array_key_exists($key, $array)) {
            $msg = $message !== '' ? $message : "Failed asserting that array does not have key '{$key}'.";
            throw new TestAssertionException($msg);
        }
    }

    protected function assertCount(int $expectedCount, array $array, string $message = ''): void
    {
        $this->assertionsCount++;
        $actualCount = count($array);
        if ($expectedCount !== $actualCount) {
            $msg = $message !== '' ? $message : "Failed asserting that array count {$actualCount} matches expected count {$expectedCount}.";
            throw new TestAssertionException($msg);
        }
    }

    protected function assertStringContains(string $needle, string $haystack, string $message = ''): void
    {
        $this->assertionsCount++;
        if (!str_contains($haystack, $needle)) {
            $msg = $message !== '' ? $message : "Failed asserting that '{$haystack}' contains '{$needle}'.";
            throw new TestAssertionException($msg);
        }
    }

    protected function assertMatchesRegex(string $pattern, string $string, string $message = ''): void
    {
        $this->assertionsCount++;
        if (preg_match($pattern, $string) !== 1) {
            $msg = $message !== '' ? $message : "Failed asserting that '{$string}' matches pattern '{$pattern}'.";
            throw new TestAssertionException($msg);
        }
    }

    protected function fail(string $message): void
    {
        throw new TestAssertionException($message);
    }
}
