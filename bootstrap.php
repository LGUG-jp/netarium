<?php
declare(strict_types=1);

require_once __DIR__ . '/version.php';
require_once __DIR__ . '/src/Autoloader.php';

\Netarium\Autoloader::register();

require_once __DIR__ . '/src/Core/Database.php';

if (!defined('APP_DB_FILE')) {
    $config = \Netarium\Core\Config::create();
    define('APP_DB_FILE', (string)$config['db_file']);
}

if (PHP_SAPI !== 'cli') {
    \Netarium\Core\SecurityHeaders::send();
}

require_once __DIR__ . '/src/Services/Auth/Session.php';
require_once __DIR__ . '/src/Services/Auth/Authentication.php';
require_once __DIR__ . '/src/Services/Auth/LoginRateLimit.php';
require_once __DIR__ . '/src/Services/Auth/CredentialValidation.php';
require_once __DIR__ . '/src/Services/Auth/HttpAccess.php';
