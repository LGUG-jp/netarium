    <aside
        id="link-panel"
        class="hidden"
        hidden
        aria-label="接続情報編集パネル"
    >
        <div class="panel-header">
            <h3>接続情報</h3>
            <button
                id="lp-close-btn"
                type="button"
                class="modal-close-btn panel-close-btn"
                aria-label="パネルを閉じる"
                title="パネルを閉じる"
            >×</button>
        </div>

        <label for="lp-label" class="form-label">
            ラベル
        </label>
        <input
            id="lp-label"
            type="text"
            data-max-length="100"
            autocomplete="off"
            placeholder="例: 庁内LAN"
        >
        <div id="lp-label-error" class="form-error" hidden></div>

        <label for="lp-system" class="form-label">系統</label>
        <div class="link-system-selector">
            <button id="lp-system" type="button" class="link-system-trigger" role="combobox"
                aria-haspopup="listbox" aria-expanded="false" aria-controls="lp-system-options" aria-describedby="lp-system-error">
                <span id="lp-system-swatch" class="link-system-swatch" aria-hidden="true"></span>
                <span id="lp-system-name" class="link-system-option-name">未設定</span>
            </button>
            <div id="lp-system-options" class="link-system-options" role="listbox" aria-label="接続系統" hidden></div>
        </div>
        <div id="lp-system-error" class="form-error" hidden></div>

        <label for="lp-vlan" class="form-label">
            VLAN
        </label>
        <input
            id="lp-vlan"
            type="text"
            data-max-length="100"
            autocomplete="off"
            placeholder="例: 10,20,30"
        >
        <div id="lp-vlan-error" class="form-error" hidden></div>

        <div class="link-endpoints">
            <div role="group" aria-labelledby="lp-from-heading">
                <span id="lp-from-heading" class="form-label">接続元</span>
                <strong id="lp-from-device">-</strong>
                <label for="lp-from-port" class="form-label">ポート</label>
                <input
                    id="lp-from-port"
                    type="text"
                    data-max-length="50"
                    autocomplete="off"
                    placeholder="例: Gi1/0/12"
                >
                <div id="lp-from-port-error" class="form-error" hidden></div>
            </div>

            <button id="lp-swap-btn" type="button" class="btn btn-secondary btn-sm admin-only"
                >↑↓入れ替え</button>

            <div role="group" aria-labelledby="lp-to-heading">
                <span id="lp-to-heading" class="form-label">接続先</span>
                <strong id="lp-to-device">-</strong>
                <label for="lp-to-port" class="form-label">ポート</label>
                <input
                    id="lp-to-port"
                    type="text"
                    data-max-length="50"
                    autocomplete="off"
                    placeholder="例: LAN1"
                >
                <div id="lp-to-port-error" class="form-error" hidden></div>
            </div>
        </div>

        <div class="admin-only">
            <span class="form-label">経路</span>
            <div class="link-route-controls">
                <button id="lp-route-edit-btn" type="button" class="btn btn-secondary btn-sm">経路調整</button>
                <button id="lp-route-auto-btn" type="button" class="btn btn-secondary btn-sm">自動経路</button>
                <button id="lp-route-help-btn" type="button" class="btn btn-secondary btn-sm"
                    aria-label="経路調整の使い方" title="経路調整の使い方"
                    aria-haspopup="dialog" aria-controls="link-route-help-dialog">？使い方</button>
            </div>
        </div>

        <label for="lp-memo" class="form-label">
            備考
        </label>
        <textarea
            id="lp-memo"
            data-max-length="1000"
            rows="4"
        ></textarea>
        <div id="lp-memo-count" class="character-counter" aria-live="polite">0/1000</div>
        <div id="lp-memo-error" class="form-error" hidden></div>

        <p class="hint">「変更を取り消す」は未適用の入力だけを破棄し、前回適用した値に戻します。</p>
        <div class="panel-actions">
            <button
                id="lp-apply-btn"
                type="button"
                class="btn btn-primary btn-sm admin-only"
            >
                適用
            </button>

            <button
                id="lp-revert-btn"
                type="button"
                class="btn btn-secondary btn-sm admin-only"
            >
                変更を取り消す
            </button>
            <button id="lp-reload-conflict-btn" type="button" class="btn btn-secondary btn-sm admin-only" hidden>
                競合したビューを再読込
            </button>

            <button
                id="lp-delete-btn"
                type="button"
                class="btn btn-danger btn-secondary btn-sm admin-only"
            >
                削除
            </button>

        </div>
    </aside>
