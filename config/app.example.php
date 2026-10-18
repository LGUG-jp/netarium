<?php
declare(strict_types=1);

return [
    'storage_dir' => 'C:\\Netarium\\data',
    // 旧bcryptの移行期間だけtrue。全利用者の再設定後はfalseにする。
    'allow_legacy_bcrypt' => true,
    // TLS終端プロキシの接続元IPだけを列挙する。CIDRやホスト名は指定できない。
    'trusted_https_proxies' => [],
    // HTTPS専用ホストで明示設定する。nullは送信なし、0はHSTS解除通知。
    'hsts_max_age' => null,
    // CSP違反の受入確認時だけtrue。通常は強制適用する。
    'csp_report_only' => false,
    // 任意の画像保存クォータ（省略時はnullで無制限）。
    // 'storage_capacity' => [
    //     'images' => [
    //         'max_files' => 1200,
    //         'max_total_bytes' => 1200 * 1024 * 1024,
    //     ],
    // ],
];
