<?php
declare(strict_types=1);

function validateUsername(string $username): ?string
{
    if (!preg_match('/\A[A-Za-z0-9_.-]{3,50}\z/', $username)) {
        return 'ユーザー名は3～50文字の半角英数字、_、-、.で入力してください';
    }

    return null;
}

function validatePassword(string $password, string $username = ''): ?string
{
    // 設定時だけ適用する。既存パスワードの照合では受理条件を変更しない。
    if (preg_match('/\A[^\x00]*\z/u', $password) !== 1) {
        return 'パスワードに使用できない文字が含まれています';
    }

    if (strlen($password) > 512) {
        return 'パスワードは512バイト以内で入力してください';
    }

    $characters = preg_match_all('/./us', $password);
    if ($characters > 128) {
        return 'パスワードは128文字以内で入力してください';
    }

    if ($characters < 12) {
        return 'パスワードは12文字以上で入力してください';
    }

    return \Netarium\Services\Auth\PasswordBlocklist::validate($password, $username);
}
