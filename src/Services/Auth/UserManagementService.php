<?php
declare(strict_types=1);

namespace Netarium\Services\Auth;

use PDO;
use PDOException;
use Netarium\Core\ApiException;

class UserManagementService
{
    public function __construct(
        private PDO $db
    ) {
    }

    public function listUsers(): array
    {
        $users = $this->db->query("
            SELECT
                id,
                username,
                role,
                is_active,
                must_change_password,
                created_at,
                updated_at,
                last_login_at
            FROM users
            ORDER BY username COLLATE NOCASE, id
        ")->fetchAll();

        return [
            'ok' => true,
            'users' => array_map(
                static function (array $user): array {
                    $user['id'] = (int)$user['id'];
                    $user['is_active'] = (int)$user['is_active'] === 1;
                    $user['must_change_password'] = (int)$user['must_change_password'] === 1;

                    return $user;
                },
                $users
            ),
        ];
    }

    public function createUser(array $input): array
    {
        $username = trim((string)($input['username'] ?? ''));
        $password = (string)($input['password'] ?? '');
        $passwordConfirm = (string)($input['password_confirm'] ?? '');
        $role = (string)($input['role'] ?? 'viewer');

        $this->validateUserInput(
            $username,
            $password,
            $passwordConfirm,
            $role
        );

        $now = date('Y-m-d H:i:s');

        try {
            $stmt = $this->db->prepare("
                INSERT INTO users (
                    username,
                    password_hash,
                    role,
                    is_active,
                    auth_revision,
                    password_revision,
                    password_changed_at,
                    must_change_password,
                    created_at,
                    updated_at
                ) VALUES (
                    :username,
                    :password_hash,
                    :role,
                    1,
                    1,
                    1,
                    :password_changed_at,
                    1,
                    :created_at,
                    :updated_at
                )
            ");
            $stmt->execute([
                ':username' => $username,
                ':password_hash' => PasswordHashing::hash($password),
                ':role' => $role,
                ':password_changed_at' => $now,
                ':created_at' => $now,
                ':updated_at' => $now,
            ]);
        } catch (PDOException $e) {
            if (str_contains(strtolower($e->getMessage()), 'unique')) {
                throw new ApiException(
                    '同じユーザー名は既に登録されています',
                    409
                );
            }

            throw $e;
        }

        return [
            'ok' => true,
            'message' => '利用者を登録しました',
            'user_id' => (int)$this->db->lastInsertId(),
        ];
    }

    public function updateUser(array $input): array
    {
        $id = (int)($input['id'] ?? 0);
        $role = (string)($input['role'] ?? '');
        $isActive = $this->normalizeActive($input['is_active'] ?? null);

        if ($id <= 0) {
            throw new ApiException('利用者IDが不正です', 400);
        }

        if (!in_array($role, ['admin', 'viewer'], true)) {
            throw new ApiException('権限が不正です', 400);
        }

        if ($isActive === null) {
            throw new ApiException('利用者状態が不正です', 400);
        }

        $this->db->exec('BEGIN IMMEDIATE');

        try {
            $userStmt = $this->db->prepare("
                SELECT id, role, is_active
                FROM users
                WHERE id = :id
                LIMIT 1
            ");
            $userStmt->execute([':id' => $id]);
            $user = $userStmt->fetch();

            if (!is_array($user)) {
                throw new ApiException('利用者が見つかりません', 404);
            }

            $otherAdminStmt = $this->db->prepare("
                SELECT COUNT(*)
                FROM users
                WHERE is_active = 1
                AND role = 'admin'
                AND id <> :id
            ");
            $otherAdminStmt->execute([':id' => $id]);
            $otherActiveAdmins = (int)$otherAdminStmt->fetchColumn();

            if (
                ($role !== 'admin' || !$isActive) &&
                $otherActiveAdmins < 1
            ) {
                throw new ApiException(
                    '最後の有効なadminは停止またはviewerへ変更できません',
                    409
                );
            }

            $changed =
                (string)$user['role'] !== $role ||
                (int)$user['is_active'] !== ($isActive ? 1 : 0);

            if ($changed) {
                $stmt = $this->db->prepare("
                    UPDATE users
                    SET
                        role = :role,
                        is_active = :is_active,
                        auth_revision = auth_revision + 1,
                        updated_at = :updated_at
                    WHERE id = :id
                ");
                $stmt->execute([
                    ':role' => $role,
                    ':is_active' => $isActive ? 1 : 0,
                    ':updated_at' => date('Y-m-d H:i:s'),
                    ':id' => $id,
                ]);
            }

            $this->db->commit();
        } catch (\Throwable $e) {
            if ($this->db->inTransaction()) {
                $this->db->rollBack();
            }

            throw $e;
        }

        $isCurrentUser = $id === \currentUserId();

        return [
            'ok' => true,
            'message' => $changed
                ? '利用者情報を更新しました'
                : '変更はありません',
            'current_user_changed' => $isCurrentUser && $changed,
            'session_ended' => $isCurrentUser && !$isActive,
        ];
    }

    public function resetPassword(array $input): array
    {
        $id = (int)($input['id'] ?? 0);
        $password = (string)($input['password'] ?? '');
        $passwordConfirm = (string)($input['password_confirm'] ?? '');
        if ($id <= 0) {
            throw new ApiException('利用者IDが不正です', 400);
        }
        $this->db->exec('BEGIN IMMEDIATE');
        try {
            $stmt = $this->db->prepare('SELECT username FROM users WHERE id = :id');
            $stmt->execute([':id' => $id]);
            $username = $stmt->fetchColumn();
            if ($username === false) {
                throw new ApiException('利用者が見つかりません', 404);
            }
            $this->validatePasswordInput($password, $passwordConfirm, (string)$username);
            $update = $this->db->prepare("
                UPDATE users SET
                    password_hash = :password_hash,
                    password_changed_at = :now,
                    must_change_password = 1,
                    auth_revision = auth_revision + 1,
                    password_revision = password_revision + 1,
                    updated_at = :now
                WHERE id = :id
            ");
            $update->execute([
                ':password_hash' => PasswordHashing::hash($password),
                ':now' => date('Y-m-d H:i:s'),
                ':id' => $id,
            ]);
            ReauthenticationLimit::clear($this->db, $id);
            \clearLoginFailures($this->db, (string)$username);
            $this->db->commit();
        } catch (\Throwable $e) {
            if ($this->db->inTransaction()) {
                $this->db->rollBack();
            }
            throw $e;
        }
        $isCurrentUser = $id === \currentUserId();
        return [
            'ok' => true,
            'message' => '仮パスワードを再設定しました。対象利用者は再ログイン後に本人変更が必要です',
            'current_user_changed' => $isCurrentUser,
            'session_ended' => $isCurrentUser,
        ];
    }

    public function changeOwnPassword(array $input, bool $allowLegacyBcrypt): array
    {
        $currentPassword = (string)($input['current_password'] ?? '');
        $newPassword = (string)($input['new_password'] ?? '');
        $newPasswordConfirm = (string)($input['new_password_confirm'] ?? '');
        $id = \currentUserId();

        // セッションではなく利用者行を直列化する。管理者再設定・並行変更と世代を再照合する。
        $this->db->exec('BEGIN IMMEDIATE');
        try {
            $stmt = $this->db->prepare('SELECT username, password_hash, password_revision FROM users WHERE id = :id AND is_active = 1');
            $stmt->execute([':id' => $id]);
            $user = $stmt->fetch();
            if (!is_array($user) || (int)$user['password_revision'] !== (int)($_SESSION['password_revision'] ?? 1)) {
                throw new ApiException('認証が必要です', 401);
            }
            $this->validatePasswordInput($newPassword, $newPasswordConfirm, (string)$user['username']);
            ReauthenticationLimit::assertAllowed($this->db, $id);
            if (!PasswordHashing::verify($currentPassword, (string)$user['password_hash'], $allowLegacyBcrypt)) {
                ReauthenticationLimit::recordFailure($this->db, $id);
                $spray = PasswordSprayDetector::recordFailure(
                    $this->db, (string)$user['username'], 'reauth',
                    (string)($_SERVER['REMOTE_ADDR'] ?? '')
                );
                // 認証失敗の記録は例外によるrollbackの前に確定する。
                $this->db->commit();
                if ($spray !== null) {
                    \Netarium\Core\AuditLog::finish('failure', [
                        'target_type' => 'user', 'target_id' => $id,
                    ], 400, ['auth_failed', 'password_spray_suspected', 'source_sha256:' . $spray['source_digest']]);
                }
                throw new ApiException('現在のパスワードが正しくありません', 400);
            }
            ReauthenticationLimit::clear($this->db, $id);
            if (PasswordHashing::verify($newPassword, (string)$user['password_hash'], $allowLegacyBcrypt)) {
                $this->db->commit();
                throw new ApiException('新しいパスワードは現在のパスワードと異なる値にしてください', 400);
            }
            $update = $this->db->prepare("
                UPDATE users SET
                    password_hash = :password_hash,
                    password_changed_at = :now,
                    must_change_password = 0,
                    auth_revision = auth_revision + 1,
                    password_revision = password_revision + 1,
                    updated_at = :now
                WHERE id = :id
            ");
            $update->execute([
                ':password_hash' => PasswordHashing::hash($newPassword),
                ':now' => date('Y-m-d H:i:s'),
                ':id' => $id,
            ]);
            $this->db->commit();
        } catch (\Throwable $e) {
            if ($this->db->inTransaction()) {
                $this->db->rollBack();
            }
            throw $e;
        }
        return [
            'ok' => true,
            'message' => 'パスワードを変更しました。再ログインしてください',
            'session_ended' => true,
        ];
    }

    private function validateUserInput(
        string $username,
        string $password,
        string $passwordConfirm,
        string $role
    ): void {
        $usernameError = \validateUsername($username);

        if ($usernameError !== null) {
            throw new ApiException($usernameError, 400);
        }

        if (!in_array($role, ['admin', 'viewer'], true)) {
            throw new ApiException('権限が不正です', 400);
        }

        $this->validatePasswordInput($password, $passwordConfirm, $username);
    }

    private function validatePasswordInput(
        string $password,
        string $passwordConfirm,
        string $username
    ): void {
        $passwordError = \validatePassword($password, $username);

        if ($passwordError !== null) {
            throw new ApiException($passwordError, 400);
        }

        if ($password !== $passwordConfirm) {
            throw new ApiException('確認用パスワードが一致しません', 400);
        }
    }

    private function normalizeActive($value): ?bool
    {
        if (is_bool($value)) {
            return $value;
        }

        if ($value === 1 || $value === '1') {
            return true;
        }

        if ($value === 0 || $value === '0') {
            return false;
        }

        return null;
    }
}
