    <div
        id="toolbar"
        role="toolbar"
        aria-label="ネットワーク管理ツールバー"
    >
        <div class="toolbar-brand">
            <button id="toolbar-brand-trigger" type="button" aria-label="Netarium" aria-haspopup="dialog">
                <picture>
                    <source media="(max-width: 1150px)" srcset="assets/icons/brand/netarium-mark-compact.svg" type="image/svg+xml">
                    <img class="toolbar-brand-logo" src="assets/icons/brand/netarium-logo.svg" width="95" height="24" alt="">
                </picture>
            </button>
            <span
                class="toolbar-version"
                aria-label="バージョン <?= htmlspecialchars(
                    NETARIUM_VERSION,
                    ENT_QUOTES,
                    'UTF-8'
                ) ?>"
            >
                v<?= htmlspecialchars(
                    NETARIUM_VERSION,
                    ENT_QUOTES,
                    'UTF-8'
                ) ?>
            </span>
        </div>

        <span class="sep">|</span>

        <div id="view-switcher" class="view-switcher">
            <input
                id="view-search-input"
                type="text"
                role="combobox"
                aria-label="表示するビューを検索"
                aria-autocomplete="list"
                aria-controls="view-search-results"
                aria-expanded="false"
                autocomplete="off"
                placeholder="ビューを検索"
                title="ビュー名・施設・フロア・種別で検索"
            >
            <span class="view-search-arrow" aria-hidden="true">▾</span>
            <div id="view-search-popup" class="view-search-popup" hidden>
                <div id="view-search-summary" class="view-search-summary" role="status" aria-live="polite"></div>
                <div id="view-search-results" role="listbox" aria-label="ビュー候補"></div>
            </div>
        </div>
        <button id="view-copy-link-btn" type="button" class="toolbar-btn" aria-label="現在のビューのリンクをコピー" title="現在のビューのリンクをコピー（保存後に利用できます）">
            <svg class="toolbar-btn-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" focusable="false">
                <rect x="8" y="8" width="12" height="12" rx="2"></rect>
                <path d="M16 8V4H4v12h4"></path>
            </svg>
        </button>

        <div
            id="device-search"
            class="device-search"
        >
            <label
                for="device-search-input"
                class="visually-hidden"
            >機器を検索</label>
            <div class="device-search-field">
                <input
                    id="device-search-input"
                    type="search"
                    placeholder="機器を検索"
                    autocomplete="off"
                    aria-autocomplete="list"
                    aria-controls="device-search-results"
                    aria-expanded="false"
                    title="機器検索 (Ctrl+K)"
                >

                <button
                    id="device-search-clear"
                    type="button"
                    aria-label="検索条件を消去"
                    title="検索条件を消去"
                    hidden
                >
                    ×
                </button>
            </div>

            <div
                id="device-search-popup"
                class="device-search-popup"
                hidden
            >
                <div
                    id="device-search-summary"
                    class="device-search-summary"
                    aria-live="polite"
                ></div>

                <div
                    id="device-search-results"
                    class="device-search-results"
                    role="listbox"
                    aria-label="機器検索結果"
                ></div>
            </div>
        </div>

        <span class="sep toolbar-nav-divider">|</span>

        <!-- アプリ全体の画面移動・共通操作ボタングループ -->
        <div
            class="toolbar-nav-group"
            role="group"
            aria-label="画面移動と共通操作"
        >
            <!-- ダッシュボード -->
            <button
                id="dashboard-btn"
                class="toolbar-btn admin-only"
                type="button"
                title="ダッシュボード (全体状況・品質サマリー)"
            >
                <img class="toolbar-btn-icon" src="assets/icons/app/dashboard.svg" width="20" height="20" alt="" aria-hidden="true">
                <span class="toolbar-btn-label">ダッシュボード</span>
            </button>

            <!-- 機器台帳 -->
            <button
                id="ledgerBtn"
                class="toolbar-btn"
                type="button"
                title="機器台帳 (機器一覧・検索・編集)"
            >
                <img class="toolbar-btn-icon" src="assets/icons/app/inventory.svg" width="20" height="20" alt="" aria-hidden="true">
                <span class="toolbar-btn-label">台帳</span>
            </button>

            <!-- 更新 (再読み込み) -->
            <button
                id="loadBtn"
                class="toolbar-btn"
                type="button"
                title="更新 (最新の構成を再読み込み)"
            >
                <img class="toolbar-btn-icon" src="assets/icons/app/refresh.svg" width="20" height="20" alt="" aria-hidden="true">
                <span class="toolbar-btn-label">更新</span>
            </button>

            <!-- 保存 (確定済みの保留分を送信・再試行) -->
            <button
                id="saveBtn"
                class="toolbar-btn toolbar-btn-primary admin-only"
                type="button"
                title="確定済みの変更を送信・再試行します。未適用の入力は確定しません"
            >
                <img class="toolbar-btn-icon" src="assets/icons/app/save.svg" width="20" height="20" alt="" aria-hidden="true">
                <span class="toolbar-btn-label">保存</span>
            </button>

            <!-- ヘルプ -->
            <button
                id="help-btn"
                class="toolbar-btn"
                type="button"
                title="ヘルプ (利用ガイドを表示)"
            >
                <img class="toolbar-btn-icon" src="assets/icons/app/help.svg" width="20" height="20" alt="" aria-hidden="true">
                <span class="toolbar-btn-label">ヘルプ</span>
            </button>
        </div>

        <span class="sep">|</span>

        <!-- 管理メニュー (低頻度・管理系機能) -->
        <details
            id="toolbar-manage-menu"
            class="toolbar-menu"
        >
            <summary
                class="toolbar-btn"
                aria-label="管理メニュー"
                title="管理メニュー"
            >
                <img class="toolbar-btn-icon" src="assets/icons/app/admin.svg" width="20" height="20" alt="" aria-hidden="true">
                <span class="toolbar-btn-label">管理</span>
                <span class="toolbar-btn-caret" aria-hidden="true">▾</span>
            </summary>

            <div class="toolbar-menu-popup">
                <div class="toolbar-menu-heading">
                    構成・表示
                </div>

                <button
                    id="view-manage-btn"
                    class="admin-only"
                    type="button"
                >
                    ビュー管理
                </button>


                <button
                    id="link-display-settings-btn"
                    type="button"
                >
                    表示設定
                </button>

                <button id="link-systems-settings-btn" type="button" >
                    接続系統設定
                </button>

                <div class="toolbar-menu-separator admin-only"></div>
                <div class="toolbar-menu-heading admin-only">品質診断</div>
                <button
                    id="data-quality-btn"
                    class="admin-only"
                    type="button"
                >
                    データ品質診断
                </button>

                <div class="toolbar-menu-separator admin-only"></div>

                <div class="toolbar-menu-heading admin-only">
                    バックアップ
                </div>
                <button
                    id="backup-export-btn"
                    class="admin-only"
                    type="button"
                >
                    構成情報の出力
                </button>

                <button
                    id="backup-restore-btn"
                    class="admin-only"
                    type="button"
                >
                    構成情報の復元
                </button>

                <div class="toolbar-menu-separator admin-only"></div>

                <div class="toolbar-menu-heading admin-only">
                    システム
                </div>
                <button
                    id="user-management-btn"
                    class="admin-only"
                    type="button"
                >
                    利用者管理
                </button>
            </div>
        </details>

        <!-- ユーザーメニュー (上部右端) -->
        <details
            id="toolbar-user-menu"
            class="toolbar-menu toolbar-user-menu"
        >
            <summary
                class="toolbar-btn"
                aria-label="ユーザーメニュー: <?= htmlspecialchars($username, ENT_QUOTES, 'UTF-8') ?>"
                title="<?= htmlspecialchars($username, ENT_QUOTES, 'UTF-8') ?>"
            >
                <img class="toolbar-btn-icon" src="assets/icons/app/user.svg" width="20" height="20" alt="" aria-hidden="true">
                <span class="toolbar-btn-label"><?= htmlspecialchars($username, ENT_QUOTES, 'UTF-8') ?></span>
                <span class="toolbar-btn-caret" aria-hidden="true">▾</span>
            </summary>

            <div class="toolbar-menu-popup toolbar-user-popup">
                <div class="toolbar-menu-user-info">
                    <div class="toolbar-menu-user-role">
                        <?= htmlspecialchars(
                            $userRole === 'admin' ? '管理者' : '閲覧者',
                            ENT_QUOTES,
                            'UTF-8'
                        ) ?>
                    </div>
                    <div class="toolbar-menu-user-name">
                        <?= htmlspecialchars(
                            $username,
                            ENT_QUOTES,
                            'UTF-8'
                        ) ?>
                    </div>
                </div>

                <div class="toolbar-menu-separator"></div>

                <button
                    id="password-change-btn"
                    type="button"
                >
                    パスワード変更
                </button>

                <div class="toolbar-menu-separator"></div>

                <form
                    method="post"
                    action="logout.php"
                    class="toolbar-menu-logout"
                >
                    <input
                        type="hidden"
                        name="csrf_token"
                        value="<?= htmlspecialchars(
                            $csrfToken,
                            ENT_QUOTES,
                            'UTF-8'
                        ) ?>"
                    >
                    <button
                        id="logout-btn"
                        type="submit"
                    >
                        ログアウト
                    </button>
                </form>
            </div>
        </details>
    </div>
