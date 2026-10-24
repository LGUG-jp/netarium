<div
    id="link-display-settings-overlay"
    class="placement-manager-overlay"
    hidden
>
    <section
        class="placement-manager-dialog link-display-settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="link-display-settings-title"
        aria-describedby="link-display-settings-description"
        tabindex="-1"
    >
        <header class="placement-manager-header">
            <h2 id="link-display-settings-title">表示設定</h2>
            <button
                type="button"
                class="modal-close-btn"
                id="close-link-display-settings-btn"
                aria-label="閉じる"
            >×</button>
        </header>
        <div class="link-display-settings-body">
            <ul id="link-display-settings-description" class="link-display-settings-summary">
                <li>変更はすぐに画面へ反映されます。</li>
                <li>設定はこのブラウザーに保存されます。</li>
                <li>構成データには影響しません。</li>
            </ul>
            <fieldset class="link-display-settings-field" aria-describedby="link-crossing-style-description">
                <legend>交差の表現</legend>
                <p id="link-crossing-style-description">接続線が交差したときの表示方法を選びます。</p>
                <div class="link-display-settings-options">
                    <label>
                        <input type="radio" name="link-crossing-style" value="bridge" checked>
                        <span>山形ブリッジ</span>
                        <svg class="link-display-settings-preview" viewBox="0 0 160 64" aria-hidden="true" focusable="false">
                            <path d="M 80 8 L 80 56"></path>
                            <path d="M 10 32 L 72 32 Q 80 16 88 32 L 150 32"></path>
                        </svg>
                    </label>
                    <label>
                        <input type="radio" name="link-crossing-style" value="gap">
                        <span>切れ目（透過）</span>
                        <svg class="link-display-settings-preview" viewBox="0 0 160 64" aria-hidden="true" focusable="false">
                            <path d="M 80 8 L 80 56"></path>
                            <path d="M 10 32 L 72 32 M 88 32 L 150 32"></path>
                        </svg>
                    </label>
                </div>
            </fieldset>
            <fieldset class="link-display-settings-field" aria-describedby="connection-highlight-description">
                <legend>接続関係の強調</legend>
                <p id="connection-highlight-description">選択した機器に直接つながる機器・接続を見やすくします。</p>
                <label class="link-display-settings-switch">
                    <input type="checkbox" id="connection-highlight-enabled" role="switch">
                    <span class="link-display-settings-switch-track" aria-hidden="true"></span>
                    <span class="link-display-settings-switch-copy">
                        <span>接続関係を強調する</span>
                        <span class="link-display-settings-switch-state" aria-hidden="true">
                            <span class="link-display-settings-switch-off">OFF</span>
                            <span class="link-display-settings-switch-on">ON</span>
                        </span>
                    </span>
                </label>
            </fieldset>
        </div>
    </section>
</div>
