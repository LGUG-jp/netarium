<?php
declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

ini_set('display_errors', '0');
require_once dirname(__DIR__) . '/bootstrap.php';

use Netarium\Services\Auth\AdditionalPasswordBlocklist;

try {
    if ($argc !== 2 || !str_starts_with($argv[1], '--validate-file=')) {
        throw new RuntimeException('検証対象の絶対パスを指定してください。');
    }
    $path = substr($argv[1], strlen('--validate-file='));
    if (preg_match('~\A(?:[A-Za-z]:[\\\\/]|/(?!/))~', $path) !== 1 || !is_file($path)) {
        throw new RuntimeException('検証対象の絶対パスが不正です。');
    }
    // CRLF入力は、正規化後の容量上限に各行のCR分だけを加えた範囲まで読む。
    $limit = AdditionalPasswordBlocklist::MAX_BYTES + AdditionalPasswordBlocklist::MAX_ENTRIES;
    $data = @file_get_contents($path, false, null, 0, $limit + 1);
    if ($data === false || strlen($data) > $limit) {
        throw new RuntimeException('検証対象を読み込めません。');
    }
    $data = str_replace("\r\n", "\n", $data);
    $entries = AdditionalPasswordBlocklist::parse($data);
    echo json_encode([
        'sha256' => hash('sha256', $data),
        'bytes' => strlen($data),
        'entries' => count($entries),
    ], JSON_THROW_ON_ERROR) . PHP_EOL;
} catch (Throwable) {
    // 値・入力パス・例外詳細を出力しない。登録や設定変更は行わない。
    fwrite(STDERR, "追加パスワード辞書を検証できません。形式と読取権限を確認してください。\n");
    exit(1);
}
