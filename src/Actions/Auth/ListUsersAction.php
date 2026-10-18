<?php
declare(strict_types=1);

namespace Netarium\Actions\Auth;

use PDO;
use Netarium\Actions\ActionInterface;
use Netarium\Core\Request;
use Netarium\Core\Response;
use Netarium\Services\Auth\UserManagementService;

class ListUsersAction implements ActionInterface
{
    public function handle(PDO $db, array $config): void
    {
        Request::requireMethod('GET');

        Response::json(
            (new UserManagementService($db))->listUsers()
        );
    }
}
