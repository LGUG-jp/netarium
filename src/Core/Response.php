<?php
declare(strict_types=1);

namespace Netarium\Core;

class Response
{
    /**
     * JSON返却
     */
    public static function json(array $data, int $status = 200): void
    {
        http_response_code($status);
        echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        exit;
    }
}
