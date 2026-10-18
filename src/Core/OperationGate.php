<?php
declare(strict_types=1);

namespace Netarium\Core;

use Throwable;

/**
 * 復元処理と通常処理の実行中区間をプロセス間で排他する。
 */
class OperationGate
{
    /** @var resource|null */
    private $handle = null;

    public function __construct(private string $lockFile)
    {
    }

    public function acquireShared(): void
    {
        $this->acquire(
            LOCK_SH,
            '現在、バックアップ復元処理中です。処理完了後に再度実行してください'
        );
    }

    public function acquireExclusive(?string $busyMessage = null): void
    {
        $this->acquire(
            LOCK_EX,
            $busyMessage ?? '現在、別の更新処理が実行されています。処理完了後に再度復元してください'
        );
    }

    public function release(): void
    {
        if (!is_resource($this->handle)) {
            return;
        }

        @flock($this->handle, LOCK_UN);
        @fclose($this->handle);
        $this->handle = null;
    }

    private function acquire(int $lockType, string $busyMessage): void
    {
        if (is_resource($this->handle)) {
            throw new ApiException('同一リクエストで操作ロックを二重取得できません', 500);
        }

        $parent = dirname($this->lockFile);

        if (
            !is_dir($parent) &&
            !@mkdir($parent, 0700, true) &&
            !is_dir($parent)
        ) {
            throw new ApiException('操作ロック保存先を作成できません', 500);
        }

        $handle = @fopen($this->lockFile, 'c+b');

        if ($handle === false) {
            throw new ApiException('操作ロックを取得できません', 500);
        }

        if (!@flock($handle, $lockType | LOCK_NB)) {
            @fclose($handle);
            throw new ApiException($busyMessage, 409);
        }

        $this->handle = $handle;
    }

    public function __destruct()
    {
        try {
            $this->release();
        } catch (Throwable) {
            // リクエスト終了時の解放失敗は、次のリクエストでOSが解放する。
        }
    }
}
