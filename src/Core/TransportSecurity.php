<?php
declare(strict_types=1);

namespace Netarium\Core;

final class TransportSecurity
{
    public static function isHttps(): bool
    {
        $remoteAddress = $_SERVER['REMOTE_ADDR'] ?? null;
        $config = Config::create();
        if (is_string($remoteAddress) && in_array($remoteAddress, $config['trusted_https_proxies'], true)) {
            // 信頼済みTLS終端では外部接続方式を優先し、バックエンドTLSを証拠にしない。
            // 複数値・空白・大文字・欠落・他の転送ヘッダーは受け入れない。
            return ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? null) === 'https';
        }

        return in_array($_SERVER['HTTPS'] ?? null, ['on', '1', 1], true);
    }
}
