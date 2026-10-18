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
            <h2 id="link-display-settings-title">接続表示設定</h2>
            <button
                type="button"
                class="modal-close-btn"
                id="close-link-display-settings-btn"
                aria-label="閉じる"
            >×</button>
        </header>
        <div class="link-display-settings-body">
            <p id="link-display-settings-description">
                選択するとすぐに反映され、次回もこのブラウザーで同じ表示方式を使います。構成データには影響しません。
            </p>
            <fieldset class="link-display-settings-field">
                <legend>交差の表現</legend>
                <div class="link-display-settings-options">
                    <label>
                        <input type="radio" name="link-crossing-style" value="bridge" checked>
                        <span>山形ブリッジ</span>
                        <svg class="link-display-settings-preview" viewBox="0 0 160 100" aria-hidden="true" focusable="false">
                            <path d="M 50 10 L 50 90 M 110 10 L 110 90"></path>
                            <path d="M 10 30 L 44 30 Q 50 18 56 30 L 104 30 Q 110 18 116 30 L 150 30
                                     M 10 70 L 44 70 Q 50 58 56 70 L 104 70 Q 110 58 116 70 L 150 70"></path>
                        </svg>
                    </label>
                    <label>
                        <input type="radio" name="link-crossing-style" value="gap">
                        <span>切れ目（透過）</span>
                        <svg class="link-display-settings-preview" viewBox="0 0 160 100" aria-hidden="true" focusable="false">
                            <path d="M 50 10 L 50 90 M 110 10 L 110 90"></path>
                            <path d="M 10 30 L 44 30 M 56 30 L 104 30 M 116 30 L 150 30
                                     M 10 70 L 44 70 M 56 70 L 104 70 M 116 70 L 150 70"></path>
                        </svg>
                    </label>
                </div>
            </fieldset>
        </div>
    </section>
</div>
