        <!-- 認証失効永続バナー (401発生時に表示) -->
        <div
            id="status-auth-expired-banner"
            class="status-auth-banner"
            role="alert"
            hidden
        >
            <span class="auth-banner-text">
                ! 認証の有効期限が切れました。現在の編集内容は保持されています。別タブで再認証後に新画面へ再入力してください（本画面からの保存ボタンは失効済みトークンのため使用できません）。
            </span>
            <a
                href="login.php"
                target="_blank"
                rel="noopener"
                class="btn btn-primary btn-sm auth-relogin-link"
            >
                別タブでログイン
            </a>
        </div>
    <footer
        id="status-bar"
        class="status-bar"
        aria-label="ワークスペースの状態と表示操作"
    >
        <div class="status-bar-content" tabindex="0" role="group" aria-label="件数・保存状態・処理結果（狭幅では横スクロール）">
            <!-- 常時の状態 (機器数 / リンク数 / 選択数 / 保存状態) -->
            <div class="status-bar-left">
                <span id="status-counts" class="status-counts">
                    <span id="status-placement-count">0機器</span>
                    <span class="status-sep">/</span>
                    <span id="status-link-count">0接続</span>
                    <span class="status-sep">/</span>
                    <span id="status-selection-count">0選択</span>
                </span>
                <div class="status-save-group">
                    <!-- 未確認時だけ、保存バッジの左隣に表示する。 -->
                    <button
                        id="status-confirm-save-btn"
                        type="button"
                        class="btn btn-secondary btn-sm status-confirm-btn"
                        hidden
                    >保存状態を確認</button>
                    <span
                        id="status-save-state"
                        class="status-save-state status-saved"
                        aria-live="polite"
                    >✓ 保存済み</span>
                </div>
            </div>

            <!-- 処理進捗・Ping結果・一時通知。既存の表示条件を維持する。 -->
            <div class="status-bar-center">
                <span id="busy-label" role="status" aria-live="polite" aria-atomic="true"></span>
                <div id="status-ping-container" role="group" aria-label="Ping結果" hidden>
                    <span id="status-ping-message" role="status" aria-live="polite" aria-atomic="true"></span>
                    <button
                        id="status-ping-results-btn"
                        type="button"
                        class="btn btn-tertiary btn-sm"
                        hidden
                        disabled
                    >結果を表示</button>
                </div>
                <span
                    id="status-toast-message"
                    class="status-toast-message"
                    aria-live="polite"
                    aria-atomic="true"
                ></span>
            </div>
        </div>

        <!-- 画面全体の右端へ固定。Canvas初期化後、モーダル非表示時だけ操作可能。 -->
        <div class="status-bar-right">
            <div
                id="canvas-view-controls"
                class="canvas-view-controls"
                role="group"
                aria-label="キャンバス表示操作"
                hidden
            >
                <button id="zoom-fit-btn" type="button" class="btn btn-secondary btn-sm"
                    title="全体表示 (Fit to content)" aria-label="全体表示">全体</button>
                <button id="zoom-out-btn" type="button" class="btn btn-secondary btn-sm"
                    title="縮小" aria-label="縮小">−</button>
                <button id="zoom-reset-btn" type="button" class="btn btn-secondary btn-sm"
                    title="100%に戻す" aria-label="100%に戻す">
                    <span id="zoom-label" aria-live="polite">100%</span>
                </button>
                <button id="zoom-in-btn" type="button" class="btn btn-secondary btn-sm"
                    title="拡大" aria-label="拡大">＋</button>
            </div>
        </div>
    </footer>
