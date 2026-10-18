<?php
declare(strict_types=1);

namespace Netarium\Core;

final class SecurityHeaders
{
    private static ?string $nonce = null;

    public static function nonce(): string
    {
        return self::$nonce ??= base64_encode(random_bytes(32));
    }

    public static function send(): void
    {
        $config = Config::create();
        $nonce = self::nonce();
        $policy = "default-src 'self'; script-src 'self' 'nonce-{$nonce}'; "
            . "script-src-attr 'none'; style-src 'self' 'nonce-{$nonce}'; "
            . "style-src-attr 'none'; img-src 'self' data: blob:; connect-src 'self'; "
            . "font-src 'self'; object-src 'none'; base-uri 'self'; "
            . "form-action 'self'; frame-ancestors 'self'";

        header_remove('Content-Security-Policy');
        header_remove('Content-Security-Policy-Report-Only');
        header(($config['csp_report_only']
            ? 'Content-Security-Policy-Report-Only: '
            : 'Content-Security-Policy: ') . $policy);
        header('X-Content-Type-Options: nosniff');
        header('Referrer-Policy: same-origin');
        header('X-Frame-Options: SAMEORIGIN');

        // HTTPへHSTSを送らず、HTTPSであっても管理者の選択なしに有効化しない。
        header_remove('Strict-Transport-Security');
        if ($config['hsts_max_age'] !== null && TransportSecurity::isHttps()) {
            header('Strict-Transport-Security: max-age=' . $config['hsts_max_age']);
        }
    }
}
