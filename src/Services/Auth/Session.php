<?php
declare(strict_types=1);

const APP_SESSION_IDLE_SECONDS = 3600;
const APP_SESSION_ABSOLUTE_SECONDS = 43200;

function startAppSession(): void
{
    $config = \Netarium\Core\Config::create();
    $directory = rtrim((string)$config['storage_dir'], '/\\')
        . DIRECTORY_SEPARATOR . 'sessions';
    $isHttps = \Netarium\Core\TransportSecurity::isHttps();
    $cookieName = $isHttps ? '__Host-netarium_session' : 'netarium_session';

    if (session_status() === PHP_SESSION_ACTIVE) {
        if (
            session_module_name() !== 'files'
            || session_save_path() !== $directory
            || session_name() !== $cookieName
        ) {
            @session_abort();
            throw new RuntimeException('セッション保存先が一致しません');
        }
        return;
    }
    if (is_link($directory)) {
        throw new RuntimeException('セッション保存先にアクセスできません');
    }
    if (!is_dir($directory) && !@mkdir($directory, 0700, true) && !is_dir($directory)) {
        throw new RuntimeException('セッション保存先を作成できません');
    }
    if (PHP_OS_FAMILY !== 'Windows') {
        $perms = @fileperms($directory);
        if ($perms !== false && ($perms & 0077) !== 0) {
            @chmod($directory, 0700);
            clearstatcache(true, $directory);
            $perms = @fileperms($directory);
            if ($perms !== false && ($perms & 0077) !== 0) {
                throw new RuntimeException('セッション保存先にアクセスできません');
            }
        }
    }
    if (!is_readable($directory) || !is_writable($directory)) {
        throw new RuntimeException('セッション保存先にアクセスできません');
    }

    if (
        @session_module_name('files') === false
        || @session_save_path($directory) === false
        || session_module_name() !== 'files'
        || session_save_path() !== $directory
    ) {
        throw new RuntimeException('セッション保存先を設定できません');
    }

    ini_set('session.use_strict_mode', '1');
    ini_set('session.use_only_cookies', '1');

    if ($isHttps && isset($_COOKIE['netarium_session'])) {
        expireLegacyAppSession();
    }

    session_name($cookieName);

    session_set_cookie_params([
        'lifetime' => 0,
        'path' => '/',
        'domain' => '',
        'secure' => $isHttps,
        'httponly' => true,
        'samesite' => 'Strict',
    ]);

    ini_set('session.use_cookies', '1');

    if (!@session_start()) {
        throw new RuntimeException('セッションを開始できません');
    }
    $transport = $isHttps ? 'https' : 'http';
    $storedTransport = $_SESSION['transport'] ?? null;
    if (
        ($storedTransport !== null && $storedTransport !== $transport)
        || ($isHttps && $storedTransport === null && $_SESSION !== [])
    ) {
        // 別方式のIDを別名Cookieで送っても認証を継承しない。
        session_abort();
        session_id('');
        unset($_COOKIE[$cookieName]);
        if (!@session_start()) {
            throw new RuntimeException('セッションを開始できません');
        }
    }
    $_SESSION['transport'] = $transport;

    enforceIdleTimeout();
}

function expireLegacyAppSession(): void
{
    $legacyId = $_COOKIE['netarium_session'];
    $currentId = $_COOKIE['__Host-netarium_session'] ?? null;
    // Cookieの別名に現行IDをコピーしただけでは現行認証を失効させない。
    if (
        is_string($legacyId)
        && $legacyId !== $currentId
        && preg_match('/\A[A-Za-z0-9,-]{1,256}\z/', $legacyId) === 1
    ) {
        session_name('netarium_session');
        session_id($legacyId);
        $cacheLimiter = session_cache_limiter();
        if (!@session_start(['use_cookies' => false, 'cache_limiter' => ''])) {
            throw new RuntimeException('旧セッションを確認できません');
        }
        if (($_SESSION['transport'] ?? null) !== 'https') {
            $_SESSION = [];
            session_destroy();
        } else {
            session_abort();
        }
        session_id('');
        session_cache_limiter($cacheLimiter);
    }

    setcookie('netarium_session', '', [
        'expires' => time() - 42000,
        'path' => '/',
        'secure' => true,
        'httponly' => true,
        'samesite' => 'Strict',
    ]);
    unset($_COOKIE['netarium_session']);

    // 同一要求内の再開始ではCookieを再選択しないPHPの状態に依存しない。
    // IDの存在確認と未登録IDの拒否はuse_strict_modeで維持する。
    if (is_string($currentId) && preg_match('/\A[A-Za-z0-9,-]{1,256}\z/', $currentId) === 1) {
        session_id($currentId);
    }
}

function enforceIdleTimeout(): void
{
    if (empty($_SESSION['user_id'])) {
        return;
    }

    $now = time();

    $authenticatedAt =
        (int)(
            $_SESSION[
                'authenticated_at'
            ] ?? 0
        );

    if (
        $authenticatedAt <= 0 ||
        $now - $authenticatedAt >
            APP_SESSION_ABSOLUTE_SECONDS
    ) {
        clearAuthenticationSession();
        return;
    }

    $lastActivity =
        (int)(
            $_SESSION[
                'last_activity'
            ] ?? 0
        );

    if (
        $lastActivity > 0 &&
        $now - $lastActivity >
            APP_SESSION_IDLE_SECONDS
    ) {
        clearAuthenticationSession();
        return;
    }

    $_SESSION['last_activity'] =
        $now;
}

function clearAuthenticationSession(): void
{
    $_SESSION = [];

    if (ini_get('session.use_cookies')) {
        $params = session_get_cookie_params();

        setcookie(session_name(), '', [
            'expires' => time() - 42000,
            'path' => $params['path'],
            'domain' => $params['domain'],
            'secure' => $params['secure'],
            'httponly' => $params['httponly'],
            'samesite' => $params['samesite'] ?? 'Strict',
        ]);
    }

    session_destroy();
}

function requireCsrfToken(): void
{
    startAppSession();

    $expected = (string)($_SESSION['csrf_token'] ?? '');
    $received = (string)($_SERVER['HTTP_X_CSRF_TOKEN'] ?? '');

    if (
        $expected === '' ||
        $received === '' ||
        !hash_equals($expected, $received)
    ) {
        sendAuthDenial([
            'ok' => false,
            'error' => 'セキュリティトークンが無効です。画面を再読み込みしてください',
        ], 403, 'invalid_csrf');
    }
}

function getCsrfToken(): string
{
    startAppSession();

    if (empty($_SESSION['csrf_token'])) {
        $_SESSION['csrf_token'] = bin2hex(random_bytes(32));
    }

    return (string)$_SESSION['csrf_token'];
}
