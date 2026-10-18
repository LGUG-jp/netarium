<div id="link-bulk-overlay" class="ledger-device-sheet-overlay" hidden>
    <section class="ledger-device-sheet-dialog" role="dialog" aria-modal="true"
        aria-labelledby="link-bulk-title" aria-describedby="link-bulk-description" tabindex="-1">
        <header class="ledger-sheet-header">
            <h3 id="link-bulk-title">接続の一括設定</h3>
            <button type="button" class="modal-close-btn" data-link-bulk-close aria-label="閉じる">×</button>
        </header>
        <div class="ledger-sheet-body link-bulk-body">
            <div id="link-bulk-description" class="ledger-bulk-edit-intro">
                <p id="link-bulk-clear-help"><strong>チェックした項目だけ変更します。</strong>空欄のまま適用すると、既存値を消去します。</p>
                <p>「割り当て解除」で系統を解除します。変更は「適用」で自動保存します。</p>
            </div>
            <p id="link-bulk-error" role="alert" tabindex="-1"></p>
            <div id="link-bulk-form">
                <h4 class="ledger-bulk-edit-section-title">1. 変更する項目と値を指定</h4>
                <div class="link-bulk-fields">
                    <div class="ledger-bulk-edit-field link-bulk-field">
                        <label><input id="link-bulk-use-system_id" type="checkbox"> 接続系統を変更</label>
                        <div class="link-system-selector">
                            <button id="link-bulk-system_id" type="button" class="link-system-trigger" role="combobox"
                                aria-label="新しい接続系統" aria-haspopup="listbox" aria-expanded="false"
                                aria-controls="link-bulk-system-options" aria-describedby="link-bulk-clear-help" disabled>
                                <span class="link-system-swatch" aria-hidden="true"></span>
                                <span class="link-system-option-name">未設定（割り当て解除）</span>
                            </button>
                            <div id="link-bulk-system-options" class="link-system-options" role="listbox" aria-label="新しい接続系統" hidden></div>
                        </div>
                    </div>
                    <div class="ledger-bulk-edit-field link-bulk-field">
                        <label><input id="link-bulk-use-vlan" type="checkbox"> VLANを変更</label>
                        <input id="link-bulk-vlan" class="form-input" type="text" data-max-length="100" aria-label="新しいVLAN" aria-describedby="link-bulk-clear-help link-bulk-vlan-limit" disabled>
                        <small id="link-bulk-vlan-limit" class="is-muted">100文字以内</small>
                        <p id="link-bulk-vlan-error" class="form-error" aria-live="polite" hidden></p>
                    </div>
                    <div class="ledger-bulk-edit-field link-bulk-field">
                        <label><input id="link-bulk-use-label" type="checkbox"> ラベルを変更</label>
                        <input id="link-bulk-label" class="form-input" type="text" data-max-length="100" aria-label="新しいラベル" aria-describedby="link-bulk-clear-help link-bulk-label-limit" disabled>
                        <small id="link-bulk-label-limit" class="is-muted">100文字以内</small>
                        <p id="link-bulk-label-error" class="form-error" aria-live="polite" hidden></p>
                    </div>
                    <div class="ledger-bulk-edit-field link-bulk-field">
                        <label><input id="link-bulk-use-memo" type="checkbox"> 備考を変更</label>
                        <textarea id="link-bulk-memo" class="form-input" rows="4" data-max-length="1000" aria-label="新しい備考" aria-describedby="link-bulk-clear-help link-bulk-memo-limit" disabled></textarea>
                        <small id="link-bulk-memo-limit" class="is-muted">1000文字以内</small>
                        <p id="link-bulk-memo-error" class="form-error" aria-live="polite" hidden></p>
                    </div>
                </div>
                <div class="ledger-bulk-edit-actions">
                    <p class="link-bulk-count" aria-live="polite">対象: <strong id="link-bulk-count">0</strong>件の接続</p>
                    <button type="button" class="btn btn-cancel" data-link-bulk-close>キャンセル</button>
                    <button id="link-bulk-next" type="button" class="btn btn-primary">変更内容を確認</button>
                </div>
            </div>
            <div id="link-bulk-confirm" hidden>
                <h4 class="ledger-bulk-edit-section-title">2. 変更内容を確認して適用</h4>
                <div id="link-bulk-preview"></div>
                <div class="ledger-bulk-edit-actions">
                    <button id="link-bulk-back" type="button" class="btn btn-secondary">戻る</button>
                    <button id="link-bulk-apply" type="button" class="btn btn-primary">適用</button>
                </div>
            </div>
        </div>
    </section>
</div>
