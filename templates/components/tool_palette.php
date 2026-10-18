    <nav
        id="tool-palette"
        class="tool-palette"
        aria-label="操作パレット"
    >
        <div class="tool-palette-actions">
            <!-- 操作モード: 閲覧 / 配置 / 配線 -->
            <div class="palette-group" role="group" aria-label="作業モード">
                <!-- 選択モード (通常操作) -->
                <button
                    id="palette-view-btn"
                    type="button"
                    class="palette-btn active"
                    aria-pressed="true"
                    title="選択モード (機器の選択・移動)"
                >
                    <img class="palette-icon" src="assets/icons/toolbar/select.svg" width="22" height="22" alt="" aria-hidden="true">
                    <span class="palette-text">選択</span>
                </button>

                <!-- 機器配置モード起動 (admin-only) -->
                <div class="palette-popover-anchor admin-only">
                    <button
                        id="palette-place-btn"
                        type="button"
                        class="palette-btn"
                        aria-expanded="false"
                        aria-pressed="false"
                        aria-haspopup="dialog"
                        aria-controls="palette-place-panel"
                        title="機器配置モード (スタンプ・キュー配置)"
                    >
                        <img class="palette-icon" src="assets/icons/toolbar/place.svg" width="22" height="22" alt="" aria-hidden="true">
                        <span class="palette-text">配置</span>
                    </button>

                    <div
                        id="palette-place-panel"
                        class="palette-place-panel"
                        role="region"
                        aria-label="機器配置パレット"
                        hidden
                    >
                        <div class="palette-place-header">
                            <div class="palette-place-title">
                                <strong>機器配置</strong>
                                <span id="placement-mode-badge" class="placement-mode-badge">新規</span>
                            </div>
                            <button
                                type="button"
                                class="modal-close-btn palette-popover-close"
                                id="exit-placement-mode-btn"
                                aria-label="配置モードを終了"
                            >×</button>
                        </div>

                        <div class="palette-place-tabs" role="tablist">
                            <button
                                type="button"
                                id="place-tab-btn-new"
                                class="palette-place-tab is-active"
                                role="tab"
                                aria-selected="true"
                            >
                                新規機器
                            </button>
                            <button
                                type="button"
                                id="place-tab-btn-unplaced"
                                class="palette-place-tab"
                                role="tab"
                                aria-selected="false"
                            >
                                未配置機器
                            </button>
                        </div>

                        <!-- 新規機器スタンプ配置コンテンツ -->
                        <div id="place-content-new" class="palette-place-content">
                            <div class="palette-place-guide">
                                種別を選んでキャンバスをクリックすると連続配置できます
                            </div>
                            <div id="placement-type-grid" class="placement-type-grid" role="radiogroup" aria-label="機器種別選択"></div>
                            <div class="placement-current-status">
                                選択中: <strong id="placement-current-type-label">L2スイッチ</strong>
                            </div>
                        </div>

                        <!-- 未配置機器配置キューコンテンツ -->
                        <div id="place-content-unplaced" class="palette-place-content" hidden>
                            <div class="palette-place-guide">
                                キャンバスをクリックすると配置待ちの機器を順に配置できます
                            </div>
                            <!-- 配置待ちキュー表示 -->
                            <div class="placement-queue-section">
                                <div class="placement-queue-header">
                                    <strong>配置待ち (<span id="placement-queue-count">0</span>台)</strong>
                                    <button
                                        type="button"
                                        id="placement-queue-clear-btn"
                                        class="btn-text-action"
                                        hidden
                                    >クリア</button>
                                </div>
                                <div id="placement-queue-next" class="placement-queue-next">
                                    <span class="is-muted">下の候補から選択してください</span>
                                </div>
                                <div id="placement-queue-list" class="placement-queue-list"></div>
                            </div>

                            <div class="palette-place-separator" aria-hidden="true"></div>

                            <!-- 候補一覧・検索・スコープ切り替え -->
                            <div class="placement-unplaced-tools">
                                <div class="placement-scope-toggle">
                                    <button
                                        type="button"
                                        id="place-scope-current"
                                        class="placement-scope-btn is-active"
                                        aria-pressed="true"
                                    >
                                        このビューに未配置 (<span id="place-scope-current-count">0</span>)
                                    </button>
                                    <button
                                        type="button"
                                        id="place-scope-all"
                                        class="placement-scope-btn"
                                        aria-pressed="false"
                                    >
                                        全ビュー未配置 (<span id="place-scope-all-count">0</span>)
                                    </button>
                                </div>
                                <div class="placement-search-bar">
                                    <input
                                        type="search"
                                        id="placement-unplaced-search"
                                        aria-label="未配置機器を検索"
                                        class="form-input form-input-sm"
                                        placeholder="機器名、型番、IPなどで検索"
                                    >
                                </div>
                            </div>

                            <div id="placement-unplaced-list" class="placement-unplaced-list"></div>

                            <div class="placement-unplaced-actions">
                                <button
                                    type="button"
                                    id="placement-enqueue-btn"
                                    class="btn btn-primary btn-sm btn-full"
                                    disabled
                                >
                                    配置待ちに追加
                                </button>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- 接続作成モード切替 (admin-only) -->
                <div class="palette-popover-anchor admin-only">
                    <button
                        id="linkBtn"
                        type="button"
                        class="palette-btn admin-only"
                        aria-pressed="false"
                        aria-expanded="false"
                        aria-controls="wiring-controls"
                        title="接続モード"
                    >
                        <img class="palette-icon" src="assets/icons/toolbar/link.svg" width="22" height="22" alt="" aria-hidden="true">
                        <span class="palette-text">接続</span>
                    </button>
                    <div id="wiring-controls" class="workspace-nav-panel" role="region" aria-labelledby="wiring-controls-title" hidden>
                        <div class="workspace-nav-header wiring-header">
                            <div class="wiring-header-group">
                                <strong id="wiring-controls-title">接続</strong>
                                <button id="wiring-open-list" type="button" class="btn btn-tertiary btn-sm wiring-header-action"
                                    aria-label="接続一覧を開く" title="接続一覧を開く">接続一覧</button>
                            </div>
                            <div class="wiring-header-group">
                                <a id="wiring-help" class="btn btn-tertiary btn-sm wiring-header-action"
                                    href="help.html#connections" target="_blank" rel="noopener"
                                    aria-label="接続の使い方（別タブで開く）" title="接続の使い方（別タブで開く）"
                                    ><span><span aria-hidden="true">？</span><span class="wiring-help-text">使い方</span></span></a>
                                <button id="wiring-close-btn" type="button" class="modal-close-btn palette-popover-close"
                                     aria-label="接続モードを終了">×</button>
                            </div>
                        </div>
                        <div id="wiring-controls-content" class="workspace-nav-content wiring-controls-content"></div>
                    </div>
                </div>
                <button id="palette-note-btn" type="button" class="palette-btn admin-only"
                    aria-pressed="false" title="メモ配置（空白をクリックして連続配置）">
                    <img class="palette-icon" src="assets/icons/toolbar/memo.svg" width="22" height="22" alt="" aria-hidden="true">
                    <span class="palette-text">メモ</span>
                </button>
            </div>

            <div class="palette-separator" aria-hidden="true"></div>

            <!-- キャンバス操作: Ping / ビュー内一覧 / 図面 -->
            <div class="palette-group" role="group" aria-label="キャンバス操作">
                <!-- 選択Ping -->
                <button
                    id="pingSelectedBtn"
                    type="button"
                    class="palette-btn admin-only"
                    title="選択Ping (選択した機器の疎通確認)"
                >
                    <img class="palette-icon" src="assets/icons/toolbar/ping.svg" width="22" height="22" alt="" aria-hidden="true">
                    <span class="palette-text">Ping</span>
                </button>

                <!-- ビュー内一覧 (キーボード代替) -->
                <div class="palette-popover-anchor">
                    <button
                        id="palette-nav-btn"
                        type="button"
                        class="palette-btn"
                        aria-expanded="false"
                        aria-haspopup="dialog"
                        aria-controls="workspace-nav-panel"
                        title="ビュー内一覧 (現在のキャンバス内の機器・接続)"
                    >
                        <img class="palette-icon" src="assets/icons/toolbar/list.svg" width="22" height="22" alt="" aria-hidden="true">
                        <span class="palette-text">一覧</span>
                    </button>

                    <div
                        id="workspace-nav-panel"
                        class="workspace-nav-panel"
                        role="dialog"
                        aria-label="ビュー内の機器と接続"
                        hidden
                    >
                        <div class="workspace-nav-header">
                            <strong>ビュー内一覧</strong>
                            <button
                                type="button"
                                class="modal-close-btn palette-popover-close"
                                id="close-workspace-navigation-btn"
                                aria-label="閉じる"
                            >×</button>
                        </div>
                        <div id="workspace-nav-content" class="workspace-nav-content">
                            <!-- workspace-navigation.js にて動的描画 -->
                        </div>
                    </div>
                </div>

                <!-- フロア図面 (表示・登録・操作) -->
                <button
                    id="floor-plan-manage-btn"
                    type="button"
                    class="palette-btn admin-only"
                    title="フロア図面 (図面の表示・登録・操作)"
                >
                    <img class="palette-icon" src="assets/icons/toolbar/floor-plan.svg" width="22" height="22" alt="" aria-hidden="true">
                    <span class="palette-text">図面</span>
                </button>
            </div>
            <div class="palette-group print-palette-action" role="group" aria-label="出力">
                <button id="palette-print-btn" type="button" class="palette-btn"
                    aria-haspopup="dialog" aria-controls="print-overlay" title="現在のビューを印刷">
                    <img class="palette-icon" src="assets/icons/toolbar/print.svg" width="22" height="22" alt="" aria-hidden="true">
                    <span class="palette-text">印刷</span>
                </button>
            </div>
        </div>
    </nav>
