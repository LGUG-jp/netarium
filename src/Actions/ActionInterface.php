<?php
declare(strict_types=1);

namespace Netarium\Actions;

use PDO;

interface ActionInterface
{
    public function handle(PDO $db, array $config): void;
}
