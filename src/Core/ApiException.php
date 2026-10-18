<?php
declare(strict_types=1);

namespace Netarium\Core;

use Exception;

class ApiException extends Exception
{
    private int $httpStatus;
    private array $details;

    public function __construct(string $message, int $httpStatus = 400, array $details = [])
    {
        parent::__construct($message);
        $this->httpStatus = $httpStatus;
        $this->details = $details;
    }

    public function getHttpStatus(): int
    {
        return $this->httpStatus;
    }

    public function getDetails(): array
    {
        return $this->details;
    }
}
