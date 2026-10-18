<?php
declare(strict_types=1);

if (!in_array(PHP_SAPI, ['cli', 'cgi-fcgi'], true)) {
    http_response_code(404);
    exit;
}

ini_set('display_errors', '0');
require_once dirname(__DIR__) . '/bootstrap.php';

use Netarium\Services\Auth\PasswordHashing;

try {
    $password = bin2hex(random_bytes(40));
    $started = hrtime(true);
    $hash = PasswordHashing::hash($password);
    $generated = hrtime(true);
    if (!PasswordHashing::verify($password, $hash, false) || PasswordHashing::verify($password . 'different', $hash, false)) {
        throw new RuntimeException('Argon2id verification failed');
    }
    echo json_encode([
        'ok' => true,
        'sapi' => PHP_SAPI,
        'algorithm' => password_get_info($hash)['algoName'],
        'options' => password_get_info($hash)['options'],
        'generation_ms' => ($generated - $started) / 1000000,
    ], JSON_UNESCAPED_SLASHES) . PHP_EOL;
} catch (Throwable $e) {
    // 入力・ハッシュ・例外詳細は出力しない。
    echo json_encode(['ok' => false, 'error' => 'Argon2id generation/verification is unavailable']) . PHP_EOL;
    exit(1);
}
