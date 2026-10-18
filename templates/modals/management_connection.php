    <!-- 機器管理画面への接続確認ダイアログ -->
    <div
        id="management-connection-overlay"
        class="placement-manager-overlay"
        hidden
    >
        <section
            id="management-connection-dialog"
            class="
                placement-manager-dialog
                management-connection-dialog
            "
            role="dialog"
            aria-modal="true"
            aria-labelledby="management-connection-title"
            aria-describedby="management-connection-description"
            tabindex="-1"
        >
            <header class="placement-manager-header">
                <div>
                    <h2 id="management-connection-title">
                        機器へ接続
                    </h2>
                    <p id="management-connection-description">
                        接続先を確認してから開いてください。
                    </p>
                </div>

                <button
                    type="button"
                    class="modal-close-btn"
                    id="close-management-connection-dialog-btn"
                    aria-label="閉じる"
                >
                    ×
                </button>
            </header>

            <div class="management-connection-content">
                <dl class="management-connection-summary">
                    <fieldset class="management-connection-scheme-field">
                        <legend>接続方式</legend>

                        <div class="management-connection-scheme-options">
                            <label>
                                <input
                                    type="radio"
                                    name="management-connection-scheme"
                                    value="http"
                                >
                                <span>HTTP</span>
                            </label>

                            <label>
                                <input
                                    type="radio"
                                    name="management-connection-scheme"
                                    value="https"
                                    checked
                                >
                                <span>HTTPS</span>
                            </label>

                            <label>
                                <input
                                    type="radio"
                                    name="management-connection-scheme"
                                    value="ssh"
                                >
                                <span>SSH</span>
                            </label>
                        </div>
                    </fieldset>

                    <div>
                        <dt>機器名</dt>
                        <dd id="management-connection-device">
                            -
                        </dd>
                    </div>

                    <div>
                        <dt>IPアドレス</dt>
                        <dd id="management-connection-ip">
                            -
                        </dd>
                    </div>
                </dl>

                <label
                    class="management-connection-port-field"
                    for="management-connection-port"
                >
                    <span>ポート番号</span>

                    <input
                        id="management-connection-port"
                        type="text"
                        inputmode="numeric"
                        autocomplete="off"
                        aria-describedby="
                            management-connection-port-help
                            management-connection-port-error
                        "
                    >
                </label>

                <p
                    id="management-connection-port-help"
                    class="management-connection-help"
                >
                    空欄の場合はHTTPSの標準ポート443を使用します。
                </p>

                <p
                    id="management-connection-port-error"
                    class="management-connection-error"
                    role="alert"
                    aria-live="polite"
                    hidden
                ></p>

                <div class="management-connection-preview">
                    <span>接続先URL</span>
                    <code
                        id="management-connection-url"
                        aria-live="polite"
                    >
                        -
                    </code>
                </div>

                <p class="management-connection-preview-note">
                    HTTP/HTTPSは新しいタブ、SSHは端末の関連付けで開きます。
                </p>
            </div>

            <footer class="placement-manager-footer">
                <div>
                    <button
                        id="management-connection-ssh-help-btn"
                        type="button"
                        class="btn btn-tertiary btn-sm management-connection-ssh-help-btn"
                        aria-haspopup="dialog"
                        aria-controls="management-ssh-help-dialog"
                        hidden
                    >
                        ? 接続方法
                    </button>
                </div>

                <div>
                    <button
                        type="button"
                        class="btn btn-cancel"
                        id="close-management-connection-dialog-btn-2"
                    >
                        キャンセル
                    </button>

                    <button
                        id="management-connection-open-btn"
                        type="button"
                        class="btn btn-primary"
                    >
                        ブラウザで開く
                    </button>
                </div>
            </footer>
        </section>
    </div>

    <!-- SSH接続事前設定ミニヘルプダイアログ -->
    <div
        id="management-ssh-help-overlay"
        class="placement-manager-overlay management-ssh-help-overlay"
        hidden
    >
        <section
            id="management-ssh-help-dialog"
            class="
                placement-manager-dialog
                management-ssh-help-dialog
            "
            role="dialog"
            aria-modal="true"
            aria-labelledby="management-ssh-help-title"
            tabindex="-1"
        >
            <header class="placement-manager-header">
                <div>
                    <h2 id="management-ssh-help-title">
                        SSH接続について
                    </h2>
                </div>

                <button
                    id="management-ssh-help-close-btn"
                    type="button"
                    class="modal-close-btn"
                    aria-label="閉じる"
                >
                    ×
                </button>
            </header>

            <div class="management-ssh-help-content">
                <p class="management-ssh-help-lead">
                    Netariumは <code>ssh://</code> URIを使用して、この端末に登録されているSSH対応アプリを起動します。
                </p>

                <div class="management-ssh-help-section">
                    <h3>事前に以下を確認してください</h3>
                    <ol class="management-ssh-help-steps">
                        <li>
                            <strong>SSH対応クライアントをインストールする</strong>
                            <span class="management-ssh-help-note">例: Tera Termなど</span>
                        </li>
                        <li>
                            <strong>Windows / OSで <code>ssh://</code> を処理するアプリとして登録・選択する</strong>
                        </li>
                        <li>
                            <strong>Netariumの機器情報に以下を設定する</strong>
                            <ul class="management-ssh-help-sublist">
                                <li>IPアドレス</li>
                                <li>管理接続方式: SSH</li>
                                <li>管理ポート</li>
                            </ul>
                        </li>
                    </ol>
                </div>

                <div class="management-ssh-help-notices">
                    <div class="management-ssh-help-notice-box">
                        <p>
                            <strong>認証情報について</strong><br>
                            ユーザー名、パスワード、秘密鍵等の認証情報はNetariumからSSHクライアントへ渡しません。
                        </p>
                    </div>

                    <p class="management-ssh-help-browser-note">
                        ※ ブラウザからSSHクライアントを開く際に、「外部アプリを開きますか」等の確認が表示される場合があります。
                    </p>
                </div>
            </div>

        </section>
    </div>
