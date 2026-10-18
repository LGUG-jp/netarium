    <div
        id="ledger-overlay"
        class="ledger-overlay"
        hidden
    >
        <section
            id="ledger-dialog"
            class="ledger-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ledger-title"
        >
            <header class="ledger-header">
                <div>
                    <h2 id="ledger-title">機器台帳</h2>
                    <p>
                        <?= $isAdmin
                            ? '表内の項目を編集できます。機器の行を離れると、その行の変更を保存します。'
                            : '機器台帳を閲覧できます。' ?>
                    </p>
                </div>

                <button
                    type="button"
                    class="modal-close-btn"
                    id="close-ledger-btn"
                    aria-label="閉じる"
                >
                    ×
                </button>
            </header>

            <div class="ledger-tools ledger-filter-tools">
                <label class="ledger-search-control">
                    検索
                    <input
                        id="ledger-search"
                        type="search"
                        placeholder="名称、IP、施設、型番など"
                    >
                </label>
                <div class="ledger-filter-control">
                    <span>表示ビュー</span>
                    <select id="ledger-view-filter" multiple aria-label="表示ビュー"></select>
                </div>
                <div class="ledger-filter-control">
                    <span>施設</span>
                    <select id="ledger-facility-filter" multiple aria-label="施設"></select>
                </div>

                <div class="ledger-filter-control">
                    <span>フロア</span>
                    <select id="ledger-floor-filter" multiple aria-label="フロア"></select>
                </div>

                <div class="ledger-filter-control">
                    <span>状態</span>
                    <select id="ledger-status-filter" multiple aria-label="状態">
                        <option value="green">OK</option>
                        <option value="red">NG</option>
                        <option value="unknown">未確認</option>
                    </select>
                </div>

                <!-- ここから追加 -->
                <div class="ledger-filter-control">
                    <span>種別</span>
                    <select id="ledger-type-filter" multiple aria-label="種別"></select>
                </div>

                <div class="ledger-filter-control">
                    <span>IP登録</span>
                    <select id="ledger-ip-presence-filter" multiple aria-label="IP登録">
                        <option value="registered">登録あり</option>
                        <option value="empty">未登録</option>
                    </select>
                </div>

                <div class="ledger-filter-control">
                    <span>配置状態</span>
                    <select id="ledger-placement-filter" multiple aria-label="配置状態">
                        <option value="placed">配置済み</option>
                        <option value="unplaced">未配置</option>
                    </select>
                </div>
                <!-- 追加ここまで -->

                <button
                    id="ledger-filter-reset-btn"
                    type="button"
                    class="btn btn-secondary"
                    disabled
                >
                    条件を解除
                </button>

            </div>

            <div class="ledger-tools ledger-action-tools">
                <div
                    class="ledger-csv-actions admin-only"
                    role="group"
                    aria-label="機器台帳CSV"
                >
                    <button
                        id="ledger-csv-export-btn"
                        type="button"
                        class="btn btn-secondary"
                        title="保存済みの機器台帳全件をCSV出力"
                    >
                        CSV出力
                    </button>

                    <button
                        id="ledger-csv-import-btn"
                        type="button"
                        class="btn btn-secondary"
                        title="CSVを検証して機器台帳へ追加・更新"
                    >
                        CSV取込
                    </button>

                </div>

                <span class="sep">|</span>

                <div class="ledger-selection-controls" role="group" aria-label="選択機器操作">
                    <span id="ledger-selection-summary" class="ledger-selection-summary">0件選択中</span>
                    <button
                        id="ledger-clear-selection-btn"
                        type="button"
                        class="btn btn-secondary"
                        title="表示外も含むチェック選択をすべて解除します"
                        disabled
                    >
                        選択を解除
                    </button>

                    <button
                        id="ledger-bulk-edit-btn"
                        type="button"
                        class="admin-only btn btn-secondary"
                        disabled
                    >
                        一括編集
                    </button>
                    <button
                        id="ledger-ping-btn"
                        type="button"
                        class="admin-only btn btn-secondary"
                        title="チェックした機器だけをPingします。表示外の選択も対象です"
                        disabled
                    >
                        Ping（0件）
                    </button>
                    <button
                        id="ledger-ping-results-btn"
                        type="button"
                        class="btn btn-tertiary"
                        title="直近のPing実行結果を表示します"
                        disabled
                    >
                        結果を表示
                    </button>
                    <button
                        id="ledger-bulk-place-btn"
                        type="button"
                        class="btn btn-secondary"
                        title="選択した機器を指定のビューに配置します"
                        disabled
                    >
                        ビューに配置
                    </button>
                    <button
                        id="ledger-delete-btn"
                        type="button"
                        class="admin-only btn btn-danger btn-secondary"
                        disabled
                    >
                        選択機器を完全削除
                    </button>
                </div>

                <span class="sep">|</span>

                <button
                    id="ledger-save-btn"
                    class="admin-only btn btn-primary"
                    type="button"
                    disabled
                >
                    適用
                </button>
                <span id="ledger-count"></span>
                <label class="ledger-column-control">
                    表示項目
                    <select
                        id="ledger-column-preset"
                    >
                        <option value="standard">標準</option>
                        <option value="placement">設置管理</option>
                        <option value="asset">資産管理</option>
                        <option value="maintenance">保守管理</option>
                        <option value="monitoring">監視詳細</option>
                        <option value="all">すべて</option>
                    </select>
                </label>
            </div>

            <div
                id="ledger-active-filters"
                class="ledger-active-filters"
                aria-live="polite"
                hidden
            >
                <strong>適用中:</strong>

                <div
                    id="ledger-active-filter-list"
                    class="ledger-active-filter-list"
                ></div>
            </div>

            <div class="ledger-main-container" id="ledger-main-container">
                <div class="ledger-table-wrap" id="ledger-table-wrap">
                    <table id="ledger-table">
                        <colgroup id="ledger-table-columns"></colgroup>
                        <thead>
                            <tr>
                                <th class="ledger-sticky-check">
                                    <input
                                        id="ledger-select-all"
                                        type="checkbox"
                                        aria-label="すべて選択"
                                    >
                                </th>
                                <th class="ledger-sticky-id">ID</th>
                                <th class="ledger-sticky-name">名称</th>
                                <th>種別</th>
                                <th>IPアドレス</th>
                                <th>施設</th>
                                <th>フロア</th>
                                <th>設置場所</th>
                                <th>状態</th>
                                <th>操作</th>
                            </tr>
                        </thead>
                        <tbody id="ledger-table-body"></tbody>
                    </table>
                </div>
            </div>
        </section>
    </div>

    <div id="ledger-bulk-edit-overlay" class="ledger-device-sheet-overlay" hidden>
        <section class="ledger-device-sheet-dialog" role="dialog" aria-modal="true" aria-labelledby="ledger-bulk-edit-title">
            <header class="ledger-sheet-header">
                <h3 id="ledger-bulk-edit-title">機器を一括編集</h3>
                <button type="button" class="modal-close-btn" id="close-ledger-bulk-edit-btn" aria-label="閉じる">×</button>
            </header>
            <div id="ledger-bulk-edit-body" class="ledger-sheet-body">
                <div class="ledger-bulk-edit-intro">
                    <p><strong>チェックした項目だけ変更します。</strong>空欄のまま適用すると、既存値を消去します。</p>
                    <p>対象は開始時の選択で固定します。適用後は選択を解除し、変更を自動保存します。</p>
                </div>
                <p id="ledger-bulk-edit-error" role="alert" tabindex="-1"></p>
                <div id="ledger-bulk-edit-form">
                    <h4 class="ledger-bulk-edit-section-title">1. 変更する項目と値を指定</h4>
                    <div id="ledger-bulk-edit-fields"></div>
                    <div class="ledger-bulk-edit-actions">
                        <p id="ledger-bulk-edit-count" aria-live="polite">変更対象: 0項目</p>
                        <button type="button" class="btn btn-cancel" id="close-ledger-bulk-edit-btn-2">キャンセル</button>
                        <button id="ledger-bulk-edit-next" type="button" class="btn btn-primary"  disabled>変更内容を確認</button>
                    </div>
                </div>
                <div id="ledger-bulk-edit-confirm" hidden>
                    <h4 class="ledger-bulk-edit-section-title">2. 変更内容を確認して適用</h4>
                    <div id="ledger-bulk-edit-preview"></div>
                    <p id="ledger-bulk-edit-warning"></p>
                    <div class="ledger-bulk-edit-actions">
                        <button type="button" class="btn btn-secondary" id="back-ledger-bulk-edit-btn">戻る</button>
                        <button id="ledger-bulk-edit-apply" type="button" class="btn btn-primary" >適用</button>
                    </div>
                </div>
            </div>
        </section>
    </div>

    <!-- 機器台帳 個票モーダル（独立オーバーレイ：台帳および品質診断から直接呼び出し可能） -->
        <div
            id="ledger-device-sheet-overlay"
            class="ledger-device-sheet-overlay"
            hidden
        >
            <section
                id="ledger-device-sheet-dialog"
                class="ledger-device-sheet-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby="ledger-sheet-title"
            >
                <header class="ledger-sheet-header">
                    <h3 id="ledger-sheet-title" class="ledger-sheet-title">機器台帳 個票</h3>
                    <div class="ledger-sheet-header-actions">
                        <button
                            type="button"
                            class="modal-close-btn"
                            id="close-ledger-detail-pane-btn"
                            aria-label="閉じる"
                        >
                            ×
                        </button>
                    </div>
                </header>

                <div class="ledger-sheet-actions-bar" role="toolbar" aria-label="個票操作">
                    <button
                        type="button"
                        id="ledger-sheet-prev-btn"
                        class="btn btn-secondary btn-sm"
                        aria-label="一覧の前の機器を表示"
                        disabled
                    >
                        前へ
                    </button>
                    <button
                        type="button"
                        id="ledger-sheet-next-btn"
                        class="btn btn-secondary btn-sm"
                        aria-label="一覧の次の機器を表示"
                        disabled
                    >
                        次へ
                    </button>
                    <button
                        type="button"
                        id="ledger-sheet-canvas-btn"
                        class="btn btn-secondary btn-sm"
                        title="台帳を閉じて現在のビューで該当機器を選択表示します"
                    >
                        キャンバスで表示
                    </button>
                    <button
                        type="button"
                        id="ledger-sheet-view-manage-btn"
                        class="btn btn-secondary btn-sm admin-only"
                        title="この機器の配置ビューを管理します"
                    >
                        表示ビュー管理
                    </button>
                    <button
                        type="button"
                        id="ledger-sheet-save-btn"
                        class="btn btn-primary btn-sm admin-only"
                        title="個票の変更を適用し、自動保存します"
                        disabled
                    >
                        適用
                    </button>
                </div>

                <div id="ledger-sheet-body" class="ledger-sheet-body">
                    <!-- JSで動的に1台の台帳（個票シートテーブルおよび登録画像）を描画 -->
                </div>

                <input
                    type="file"
                    id="ledger-sheet-image-file-input"
                    accept="image/png,image/jpeg"
                    hidden
                >
            </section>
        </div>

        <!-- ビュー配置先 選択ダイアログ -->
        <div
            id="ledger-place-view-overlay"
            class="ledger-place-view-overlay"
            hidden
        >
            <section
                id="ledger-place-view-dialog"
                class="ledger-place-view-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby="ledger-place-view-title"
            >
                <header class="ledger-place-view-header">
                    <h3 id="ledger-place-view-title">選択機器をビューに配置</h3>
                    <button
                        type="button"
                        class="modal-close-btn"
                        id="close-ledger-place-view-modal-btn"
                        aria-label="閉じる"
                    >
                        ×
                    </button>
                </header>
                <div class="ledger-place-view-body">
                    <p id="ledger-place-view-summary" class="ledger-place-view-summary">
                        選択中の機器: <strong>0台</strong>
                    </p>
                    <div id="ledger-place-device-tags" class="ledger-place-device-tags"></div>

                    <div class="ledger-place-field">
                        <label for="ledger-place-view-select">配置先のビューを選択:</label>
                        <select id="ledger-place-view-select" class="ledger-place-view-select"></select>
                    </div>
                    <p class="form-support">
                        ※既に配置先のビューに配置されている機器は重複配置されません。
                    </p>
                </div>
                <footer class="ledger-place-view-footer">
                    <button
                        type="button"
                        class="btn btn-cancel btn-sm"
                        id="close-ledger-place-view-modal-btn-2"
                    >
                        キャンセル
                    </button>
                    <button
                        type="button"
                        id="ledger-place-view-submit-btn"
                        class="btn btn-primary btn-sm"
                    >
                        選択したビューに配置する
                    </button>
                </footer>
            </section>
        </div>
