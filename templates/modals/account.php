<div
    id="account-overlay"
    class="placement-manager-overlay"
    hidden
>
    <section
        id="account-dialog"
        class="placement-manager-dialog account-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="account-title"
        tabindex="-1"
    >
        <header class="placement-manager-header">
            <div>
                <h2 id="account-title">利用者管理</h2>
            </div>

            <button
                type="button"
                class="modal-close-btn"
                id="close-account-management-btn"
                aria-label="閉じる"
            >
                ×
            </button>
        </header>

        <div
            id="account-status"
            class="account-status"
            role="status"
            aria-live="polite"
        ></div>

        <div id="user-management-content" class="account-body">
            <form id="user-create-form" class="account-create-form" aria-labelledby="user-create-title" novalidate>
                <h3 id="user-create-title">利用者の登録</h3>

                <div class="account-form-grid">
                    <label>
                        ユーザー名
                        <input
                            id="user-create-username"
                            type="text"
                            data-auth-kind="username"
                            data-auth-create="true"
                            required
                            autocomplete="off"
                        >
                        <span id="user-create-username-error" class="account-field-error" hidden aria-live="polite"></span>
                    </label>

                    <label>
                        権限
                        <select id="user-create-role">
                            <option value="viewer">viewer（閲覧者）</option>
                            <option value="admin">admin（管理者）</option>
                        </select>
                    </label>

                    <div class="account-password-field">
                        <label>
                            初期パスワード
                            <input
                                id="user-create-password"
                                type="password"
                                data-auth-kind="password"
                                data-auth-create="true"
                                aria-describedby="user-create-password-hint"
                                required
                                autocomplete="new-password"
                            >
                            <span id="user-create-password-error" class="account-field-error" hidden aria-live="polite"></span>
                        </label>
                        <?php
                        $passwordRequirementsId = 'user-create-password-hint';
                        require __DIR__ . '/../components/password_requirements.php';
                        ?>
                    </div>
                    <label>
                        初期パスワード（確認）
                        <input
                            id="user-create-password-confirm"
                            type="password"
                            data-auth-kind="password"
                            data-auth-create="true"
                            data-auth-match="user-create-password"
                            aria-describedby="user-create-password-confirm-hint"
                            required
                            autocomplete="new-password"
                        >
                        <span id="user-create-password-confirm-hint" class="account-field-hint">初期パスワードと同じ値を入力</span>
                        <span id="user-create-password-confirm-error" class="account-field-error" hidden aria-live="polite"></span>
                    </label>
                </div>

                <div class="account-form-actions">
                    <button type="submit" class="btn btn-primary btn-sm">
                        利用者を登録
                    </button>
                </div>
            </form>

            <section class="account-user-section" aria-labelledby="user-list-title">
                <div class="account-section-heading">
                    <h3 id="user-list-title">登録済み利用者</h3>
                    <button
                        id="user-list-refresh-btn"
                        type="button"
                        class="btn btn-sm btn-secondary"
                    >
                        更新
                    </button>
                </div>

                <div class="account-user-list-wrap">
                    <table class="account-user-list">
                        <thead>
                            <tr>
                                <th>ユーザー名</th>
                                <th>権限</th>
                                <th>状態</th>
                                <th>最終ログイン</th>
                                <th>操作</th>
                            </tr>
                        </thead>
                        <tbody id="account-user-list-body"></tbody>
                    </table>
                </div>
            </section>
        </div>

        <form id="password-change-content" class="account-body account-password-form" aria-describedby="password-change-notice" hidden novalidate>

            <label>
                現在のパスワード
                <input
                    id="own-current-password"
                    type="password"
                    data-auth-kind="required"
                    required
                    autocomplete="current-password"
                >
                <span id="own-current-password-error" class="account-field-error" hidden aria-live="polite"></span>
            </label>

            <label>
                新しいパスワード
                <input
                    id="own-new-password"
                    type="password"
                    data-auth-kind="password"
                    data-auth-create="true"
                    aria-describedby="own-new-password-hint"
                    required
                    autocomplete="new-password"
                >
                <span id="own-new-password-error" class="account-field-error" hidden aria-live="polite"></span>
            </label>
            <?php
            $passwordRequirementsId = 'own-new-password-hint';
            require __DIR__ . '/../components/password_requirements.php';
            ?>

            <label>
                新しいパスワード（確認）
                <input
                    id="own-new-password-confirm"
                    type="password"
                    data-auth-kind="password"
                    data-auth-create="true"
                    data-auth-match="own-new-password"
                    aria-describedby="own-new-password-confirm-hint"
                    required
                    autocomplete="new-password"
                >
                <span id="own-new-password-confirm-hint" class="account-field-hint">新しいパスワードと同じ値を入力</span>
                <span id="own-new-password-confirm-error" class="account-field-error" hidden aria-live="polite"></span>
            </label>

            <p id="password-change-notice">変更後はログアウトします。再ログインしてください。</p>

            <div class="account-form-actions">
                <button type="submit" class="btn btn-primary btn-sm">
                    パスワードを変更
                </button>
            </div>
        </form>

    </section>
</div>
