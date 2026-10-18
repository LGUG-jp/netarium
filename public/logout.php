<?php
declare(strict_types=1);

require_once dirname(__DIR__) . '/bootstrap.php';

startAppSession();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    header('Allow: POST');
    exit('Method Not Allowed');
}

$receivedToken = (string)($_POST['csrf_token'] ?? '');
$expectedToken = (string)($_SESSION['csrf_token'] ?? '');

if (
    $receivedToken === '' ||
    $expectedToken === '' ||
    !hash_equals($expectedToken, $receivedToken)
) {
    recordAccessDenial('invalid_csrf');
    http_response_code(403);
    exit('Invalid CSRF token');
}

$actorId = currentUserId();
clearAuthenticationSession();

// Session invalidation takes priority over best-effort audit persistence.
\Netarium\Core\AuditLog::recordSecurityEvent(
    \Netarium\Core\Config::create(),
    'logout',
    $actorId > 0 ? $actorId : null
);

header('Location: login.php');
exit;
