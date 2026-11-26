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

        <p id="lp-group-endpoints" hidden></p>
        <p id="lp-route-reason" class="hint admin-only" hidden></p>
        <section id="lp-group-summary" aria-labelledby="lp-group-title" hidden>
            <h4 id="lp-group-title" tabindex="-1" aria-describedby="lp-group-endpoints lp-route-reason"></h4>
            <ul id="lp-group-connections" role="list"></ul>
        </section>
        <button id="lp-group-back" type="button" class="btn btn-secondary btn-sm" aria-describedby="lp-route-reason" hidden>接続の明細一覧に戻る</button>
        <p id="lp-detail-id" class="hint" hidden></p>

        <div id="lp-detail-fields">

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

        <div class="link-endpoints">
            <div id="lp-from-endpoint" role="group" aria-labelledby="lp-from-device">
                <strong id="lp-from-device">-</strong>
                <div class="link-port-field">
                    <label for="lp-from-port" class="form-label">ポート</label>
                    <input id="lp-from-port" type="text" data-max-length="50" autocomplete="off"
                        placeholder="例: Gi1/0/12">
                </div>
                <div id="lp-from-port-error" class="form-error" hidden></div>
                <p id="lp-from-vlan-summary" class="link-port-vlan">VLAN設定：<span id="lp-from-vlan">未指定</span></p>
                <div id="lp-from-vlan-editor" class="link-port-field link-vlan-field" hidden>
                    <label for="lp-from-vlan-input" class="form-label">VLAN設定</label>
                    <input id="lp-from-vlan-input" type="text" data-max-length="200" autocomplete="off" disabled>
                </div>
                <div id="lp-from-vlan-input-error" class="form-error" hidden></div>
            </div>

            <div id="lp-to-endpoint" role="group" aria-labelledby="lp-to-device">
                <strong id="lp-to-device">-</strong>
                <div class="link-port-field">
                    <label for="lp-to-port" class="form-label">ポート</label>
                    <input id="lp-to-port" type="text" data-max-length="50" autocomplete="off"
                        placeholder="例: LAN1">
                </div>
                <div id="lp-to-port-error" class="form-error" hidden></div>
                <p id="lp-to-vlan-summary" class="link-port-vlan">VLAN設定：<span id="lp-to-vlan">未指定</span></p>
                <div id="lp-to-vlan-editor" class="link-port-field link-vlan-field" hidden>
                    <label for="lp-to-vlan-input" class="form-label">VLAN設定</label>
                    <input id="lp-to-vlan-input" type="text" data-max-length="200" autocomplete="off" disabled>
                </div>
                <div id="lp-to-vlan-input-error" class="form-error" hidden></div>
            </div>
        </div>
        <div id="lp-legacy-vlan" hidden>
            <p class="link-port-vlan">未移行VLAN：<span id="lp-legacy-vlan-value"></span></p>
            <button id="lp-delete-legacy-vlan-btn" type="button" class="btn btn-danger btn-secondary btn-sm admin-only" hidden>未移行設定削除</button>
        </div>
        <label for="lp-memo" class="form-label">
            備考
        </label>
        <textarea
            id="lp-memo"
            data-max-length="1000"
            rows="3"
        ></textarea>
        <div id="lp-memo-count" class="character-counter" aria-live="polite">0/1000</div>
        <div id="lp-memo-error" class="form-error" hidden></div>

        </div>
        <div id="lp-route-section" class="link-route-controls admin-only" role="group" aria-label="経路操作" hidden>
            <button id="lp-route-edit-btn" type="button" class="btn btn-secondary btn-sm">経路調整</button>
            <button id="lp-route-auto-btn" type="button" class="btn btn-secondary btn-sm" hidden>自動経路</button>
            <button id="lp-route-help-btn" type="button" class="btn btn-secondary btn-sm"
                aria-label="経路調整の使い方" title="経路調整の使い方"
                aria-haspopup="dialog" aria-controls="link-route-help-dialog">？使い方</button>
        </div>
        <div id="lp-detail-actions" class="panel-actions">
            <button id="lp-delete-btn" type="button" class="btn btn-danger btn-secondary btn-sm admin-only">
                削除
            </button>
            <div class="panel-action-group panel-action-group-apply">
                <button id="lp-revert-btn" type="button" class="btn btn-secondary btn-sm admin-only">
                    変更を取り消す
                </button>
                <button id="lp-apply-btn" type="button" class="btn btn-primary btn-sm admin-only">
                    適用
                </button>
            </div>
        </div>
        <button id="lp-reload-conflict-btn" type="button" class="btn btn-secondary btn-sm admin-only" hidden>
            競合したビューを再読込
        </button>
    </aside>
