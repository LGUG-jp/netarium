    <aside
        id="panel"
        class="hidden"
        hidden
        aria-label="機器情報編集パネル"
    >
        <div class="panel-header">
            <h3>機器情報</h3>
            <button
                id="p-close-btn"
                type="button"
                class="modal-close-btn panel-close-btn"
                aria-label="パネルを閉じる"
                title="パネルを閉じる"
            >×</button>
        </div>

        <!-- 日常操作: 機器へ接続 -->
        <section
            class="device-management-links"
            aria-label="機器へ接続"
        >
            <button
                id="p-open-management-btn"
                type="button"
                class="btn btn-secondary btn-sm device-connect-btn"
                title="機器への接続確認画面を開く"
            >
                機器へ接続
            </button>

            <button
                id="p-jump-management-settings-btn"
                type="button"
                class="device-settings-jump-link"
                title="管理・保守情報の接続設定へ移動"
            >
                接続設定 ⚙
            </button>
        </section>
        <button id="p-copy-link-btn" type="button" class="btn btn-secondary btn-sm" title="現在のビューと機器のリンクをコピー（保存後に利用できます）">
            機器のリンクをコピー
        </button>

        <!-- 第1分類: 基本情報 (初期展開) -->
        <details id="p-group-basic" class="panel-group" open>
            <summary class="panel-group-summary">
                <span class="panel-group-title">基本情報</span>
                <span id="p-summary-basic" class="panel-group-summary-text"></span>
            </summary>
            <div class="panel-group-body">
                <label for="p-name" class="form-label">
                    名称 <span class="required" aria-hidden="true">*</span>
                </label>
                <input
                    id="p-name"
                    type="text"
                    data-max-length="100"
                    autocomplete="off"
                    placeholder="例: 1F-L2SW-01"
                >
                <div id="p-name-error" class="form-error" hidden></div>

                <label for="p-type" class="form-label">
                    種別
                </label>
                <button id="p-type" type="button" class="device-type-trigger" value="other" aria-label="種別"></button>

                <label for="p-ip" class="form-label">
                    IPアドレス
                </label>
                <input
                    id="p-ip"
                    type="text"
                    data-max-length="45"
                    inputmode="decimal"
                    autocomplete="off"
                    placeholder="例: 192.168.1.1"
                >
                <div id="p-ip-error" class="form-error" hidden></div>
            </div>
        </details>

        <!-- 第2分類: 設置情報 (初期閉鎖) -->
        <details id="p-group-placement" class="panel-group">
            <summary class="panel-group-summary">
                <span class="panel-group-title">設置情報</span>
                <span id="p-summary-placement" class="panel-group-summary-text"></span>
            </summary>
            <div class="panel-group-body">
                <label for="p-facility" class="form-label">
                    施設名
                </label>
                <input
                    id="p-facility"
                    type="text"
                    data-max-length="100"
                    autocomplete="off"
                    placeholder="例: 本庁舎"
                >
                <div id="p-facility-error" class="form-error" hidden></div>

                <label for="p-floor" class="form-label">
                    フロア
                </label>
                <input
                    id="p-floor"
                    type="text"
                    data-max-length="50"
                    autocomplete="off"
                    placeholder="例: 2F"
                >
                <div id="p-floor-error" class="form-error" hidden></div>

                <label for="p-location" class="form-label">
                    設置場所
                </label>
                <input
                    id="p-location"
                    type="text"
                    data-max-length="150"
                    autocomplete="off"
                    placeholder="例: サーバ室 ラックA"
                >
                <div id="p-location-error" class="form-error" hidden></div>

                <!-- 表示するビュー選択 -->
                <section
                    class="device-placement-summary"
                    aria-labelledby="device-placement-title"
                >
                    <div class="device-placement-summary-header">
                        <h4 id="device-placement-title">
                            表示するビュー
                        </h4>

                        <span
                            id="p-placement-count"
                            class="badge badge-info"
                        >
                            0件
                        </span>
                    </div>

                    <div
                        id="p-placement-view-list"
                        class="device-placement-view-list"
                    >
                        配置なし
                    </div>

                    <button
                        id="p-manage-placements-btn"
                        class="btn btn-secondary btn-sm admin-only"
                        type="button"
                    >
                        表示するビューを選択
                    </button>
                </section>

                <!-- 現在ビューの配置座標 (キーボード代替) -->
                <div class="current-placement-coords admin-only">
                    <span class="form-label">現在ビューの配置座標</span>
                    <div class="coord-inputs">
                        <label for="p-coord-x" class="coord-label">
                            X:
                            <input
                                id="p-coord-x"
                                type="number"
                                step="1"
                                class="input-sm coord-input"
                                aria-label="X座標"
                            >
                        </label>
                        <label for="p-coord-y" class="coord-label">
                            Y:
                            <input
                                id="p-coord-y"
                                type="number"
                                step="1"
                                class="input-sm coord-input"
                                aria-label="Y座標"
                            >
                        </label>
                        <button
                            id="p-apply-coord-btn"
                            type="button"
                            class="btn btn-secondary btn-sm"
                        >
                            座標を適用
                        </button>
                    </div>
                    <div id="p-coord-error" class="form-error" hidden></div>
                </div>
            </div>
        </details>

        <!-- 第3分類: 機器・資産情報 (初期閉鎖) -->
        <details id="p-group-asset" class="panel-group">
            <summary class="panel-group-summary">
                <span class="panel-group-title">機器・資産情報</span>
                <span id="p-summary-asset" class="panel-group-summary-text"></span>
            </summary>
            <div class="panel-group-body">
                <label for="p-manufacturer" class="form-label">
                    メーカー
                </label>
                <input
                    id="p-manufacturer"
                    type="text"
                    data-max-length="100"
                    autocomplete="off"
                >
                <div id="p-manufacturer-error" class="form-error" hidden></div>

                <label for="p-model" class="form-label">
                    型番
                </label>
                <input
                    id="p-model"
                    type="text"
                    data-max-length="100"
                    autocomplete="off"
                >
                <div id="p-model-error" class="form-error" hidden></div>

                <label for="p-asset-number" class="form-label">
                    管理番号
                </label>
                <input
                    id="p-asset-number"
                    type="text"
                    data-max-length="100"
                    autocomplete="off"
                >
                <div id="p-asset-number-error" class="form-error" hidden></div>

                <label for="p-serial-number" class="form-label">
                    シリアル番号
                </label>
                <input
                    id="p-serial-number"
                    type="text"
                    data-max-length="100"
                    autocomplete="off"
                >
                <div id="p-serial-number-error" class="form-error" hidden></div>

                <label for="p-mac-address" class="form-label">
                    MACアドレス
                </label>
                <input
                    id="p-mac-address"
                    type="text"
                    data-max-length="50"
                    autocomplete="off"
                    placeholder="例: 00:11:22:33:44:55"
                >
                <div id="p-mac-address-error" class="form-error" hidden></div>

                <label for="p-install-date" class="form-label">
                    導入年月
                </label>
                <input
                    id="p-install-date"
                    type="text"
                    data-max-length="10"
                    autocomplete="off"
                    placeholder="例: 2024-04 または 2024-04-01"
                >
                <div id="p-install-date-error" class="form-error" hidden></div>

                <!-- 機器画像 (最大3枚) -->
                <section class="device-images-section" aria-labelledby="device-images-section-title">
                    <div class="device-images-header">
                        <h4 id="device-images-section-title">機器画像 (最大3枚)</h4>
                        <span id="p-device-images-count" class="badge badge-info">0/3枚</span>
                    </div>

                    <p class="form-support">
                        PNGまたはJPEG、入力は<?= (int)(($storageCapacity['images']['max_entry_bytes'] ?? 10485760) / (1024 * 1024)) ?>MiB以下。各辺<?= (int)($appConfig['max_device_image_width'] ?? 4000) ?>px以下。詳細は<a href="help.html#devices" target="_blank" rel="noopener">ヘルプ</a>を参照してください。
                    </p>

                    <div id="p-device-images-dirty-warning" class="device-images-notice form-support" hidden>
                        新規機器の保存完了後に画像を登録できます。
                    </div>

                    <div id="p-device-images-list" class="device-images-list" aria-live="polite">
                        <!-- JSで描画 -->
                    </div>

                    <div id="p-device-images-upload-container" class="admin-only">
                        <input
                            id="p-device-image-file-input"
                            type="file"
                            accept="image/png,image/jpeg"
                            class="hidden"
                            hidden
                        >
                        <button
                            id="p-device-image-add-btn"
                            type="button"
                            class="btn btn-secondary btn-sm"
                        >
                            画像を登録
                        </button>
                    </div>
                </section>
            </div>
        </details>

        <!-- 第4分類: 管理・保守情報 (初期閉鎖) -->
        <details id="p-group-management" class="panel-group">
            <summary class="panel-group-summary">
                <span class="panel-group-title">管理・保守情報</span>
                <span id="p-summary-management" class="panel-group-summary-text"></span>
            </summary>
            <div class="panel-group-body">
                <label for="p-management-scheme" class="form-label">
                    接続方式
                </label>
                <select id="p-management-scheme">
                    <option value="">未設定</option>
                    <option value="https">HTTPS</option>
                    <option value="http">HTTP</option>
                    <option value="ssh">SSH</option>
                </select>
                <div id="p-management-scheme-error" class="form-error" hidden></div>

                <label for="p-management-port" class="form-label">
                    ポート番号
                </label>
                <input
                    id="p-management-port"
                    type="number"
                    min="1"
                    max="65535"
                    step="1"
                    autocomplete="off"
                    placeholder="標準ポート（HTTPS: 443 / HTTP: 80 / SSH: 22）"
                >
                <div id="p-management-port-error" class="form-error" hidden></div>

                <label for="p-department" class="form-label">
                    担当部署
                </label>
                <input
                    id="p-department"
                    type="text"
                    data-max-length="100"
                    autocomplete="off"
                    placeholder="例: 情報政策課"
                >
                <div id="p-department-error" class="form-error" hidden></div>

                <label for="p-maintenance-vendor" class="form-label">
                    保守ベンダー
                </label>
                <input
                    id="p-maintenance-vendor"
                    type="text"
                    data-max-length="100"
                    autocomplete="off"
                    placeholder="例: ○○保守サービス株式会社"
                >
                <div id="p-maintenance-vendor-error" class="form-error" hidden></div>

                <label for="p-maintenance-expiry" class="form-label">
                    保守期限
                </label>
                <input
                    id="p-maintenance-expiry"
                    type="text"
                    data-max-length="10"
                    autocomplete="off"
                    placeholder="例: 2027-03 または 2027-03-31"
                >
                <div id="p-maintenance-expiry-error" class="form-error" hidden></div>
            </div>
        </details>

        <!-- 第5分類: 補足・状態 (初期閉鎖) -->
        <details id="p-group-extra" class="panel-group">
            <summary class="panel-group-summary">
                <span class="panel-group-title">補足・状態</span>
                <span id="p-summary-extra" class="panel-group-summary-text"></span>
            </summary>
            <div class="panel-group-body">
                <label for="p-memo" class="form-label">
                    備考
                </label>
                <textarea
                    id="p-memo"
                    data-max-length="1000"
                    rows="4"
                ></textarea>
                <div id="p-memo-count" class="character-counter" aria-live="polite">0/1000</div>
                <div id="p-memo-error" class="form-error" hidden></div>

                <div class="panel-status">
                    <div>
                        最終確認:
                        <span id="p-last-checked">-</span>
                    </div>
                    <div>
                        応答時間:
                        <span id="p-response-ms">-</span>
                    </div>
                    <div>
                        エラー:
                        <span id="p-last-error">-</span>
                    </div>
                </div>
                <button id="p-ping-help-btn" type="button" class="btn btn-tertiary btn-sm"
                     aria-haspopup="dialog" aria-controls="ping-help-dialog">
                    Ping結果について
                </button>
            </div>
        </details>

        <!-- 固定動線: アクションボタン群 -->
        <div class="panel-actions">
            <button
                id="p-apply-btn"
                type="button"
                class="btn btn-primary btn-sm admin-only"
            >
                適用
            </button>
            <button
                id="p-revert-btn"
                type="button"
                class="btn btn-secondary btn-sm admin-only"
            >
                変更を取り消す
            </button>
            <button id="p-reload-conflict-btn" type="button" class="btn btn-secondary btn-sm admin-only" hidden>
                競合した機器を再読込
            </button>
            <button
                id="p-delete-btn"
                type="button"
                class="btn btn-secondary btn-sm admin-only"
            >
                このビューから外す
            </button>
            <button
                id="p-delete-complete-btn"
                type="button"
                class="btn btn-danger btn-secondary btn-sm admin-only"
            >
                機器を完全削除
            </button>
        </div>
    </aside>

    <div id="ping-help-overlay" class="placement-manager-overlay" hidden>
        <section id="ping-help-dialog" class="placement-manager-dialog link-route-help-dialog"
            role="dialog" aria-modal="true" aria-labelledby="ping-help-title"
            aria-describedby="ping-help-description" tabindex="-1">
            <header class="placement-manager-header">
                <h2 id="ping-help-title">Ping結果について</h2>
                <button id="ping-help-close-btn" type="button" class="modal-close-btn"
                     aria-label="閉じる">×</button>
            </header>
            <div class="link-route-help-content">
                <p id="ping-help-description">PingのNGは機器停止を断定するものではありません。ICMP応答の無効化、ファイアウォール、ネットワーク経路などによって応答しない場合があります。</p>
                <ul>
                    <li>OK: Pingへの応答を確認しました。機器のすべての機能が正常であることを保証するものではありません。</li>
                    <li>未確認: Ping結果が未取得、またはIPアドレスの変更などでリセットされた状態です。</li>
                    <li>確認中: Pingを実行しています。完了後に結果を確認してください。</li>
                </ul>
            </div>
        </section>
    </div>

    <!-- 機器画像 拡大表示ダイアログ -->
    <div id="device-image-zoom-overlay" class="device-image-zoom-overlay" hidden>
        <div
            id="device-image-zoom-dialog"
            class="device-image-zoom-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="device-image-zoom-caption"
        >
            <div class="device-image-zoom-header">
                <h3 id="device-image-zoom-caption">機器画像</h3>
                <button
                    type="button"
                    class="modal-close-btn"
                    id="close-device-image-zoom-btn"
                    aria-label="閉じる"
                >
                    ×
                </button>
            </div>
            <div class="device-image-zoom-body">
                <img id="device-image-zoom-img" src="" alt="拡大画像">
            </div>
            <div class="device-image-zoom-navigation" role="group" aria-label="機器画像の切替">
                <button id="device-image-zoom-previous" type="button" class="btn btn-tertiary btn-sm"  disabled>前の画像</button>
                <span id="device-image-zoom-position" role="status" aria-live="polite"></span>
                <button id="device-image-zoom-next" type="button" class="btn btn-tertiary btn-sm"  disabled>次の画像</button>
            </div>
        </div>
    </div>
