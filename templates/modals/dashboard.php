    <div
        id="dashboard-overlay"
        class="placement-manager-overlay"
        hidden
    >
        <section
            class="placement-manager-dialog dashboard-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="dashboard-title"
            tabindex="-1"
        >
            <header class="placement-manager-header">
                <div>
                    <h2 id="dashboard-title">
                        ダッシュボード
                    </h2>
                </div>

                <div class="dashboard-header-actions">
                    <button
                        id="dashboard-refresh-btn"
                        type="button"
                    >
                        更新
                    </button>
                    <button
                        type="button"
                        class="modal-close-btn"
                        id="close-dashboard-btn"
                        aria-label="閉じる"
                    >
                        ×
                    </button>
                </div>
            </header>

            <div id="dashboard-tabs" class="dashboard-tabs" role="tablist" aria-label="ダッシュボードの表示">
                <button id="dashboard-tab-operations" type="button" role="tab" aria-selected="true" aria-controls="dashboard-panel-operations" tabindex="0" data-dashboard-tab="operations">運用状況</button>
                <button id="dashboard-tab-assets" type="button" role="tab" aria-selected="false" aria-controls="dashboard-panel-assets" tabindex="-1" data-dashboard-tab="assets">資産・保守</button>
            </div>

            <div class="dashboard-body">
                <div
                    id="dashboard-notices"
                    class="dashboard-notices"
                    aria-live="polite"
                    hidden
                ></div>


                <div
                    id="dashboard-status"
                    class="dashboard-status"
                    role="status"
                    aria-live="polite"
                >
                    ダッシュボードを読み込んでいません。
                </div>

                <div
                    id="dashboard-content"
                    class="dashboard-content"
                    hidden
                >
                    <div id="dashboard-panel-operations" class="dashboard-tab-panel" role="tabpanel" aria-labelledby="dashboard-tab-operations">
                    <section
                        class="dashboard-kpi-bar"
                        aria-label="主要KPIサマリー"
                    >
                        <button
                            type="button"
                            class="dashboard-kpi-item dashboard-kpi-total"
                            data-dashboard-action="ledger-all"
                            title="台帳に登録されたすべての機器を機器台帳で表示"
                        >
                            <span class="dashboard-kpi-label">総機器数</span>
                            <span class="dashboard-kpi-value-wrap">
                                <strong id="dashboard-devices-count" class="dashboard-kpi-value">0</strong>
                                <small class="dashboard-kpi-unit">台</small>
                            </span>
                        </button>

                        <button
                            type="button"
                            class="dashboard-kpi-item dashboard-kpi-green"
                            data-dashboard-action="ledger-green"
                            title="OK（疎通正常）の機器を機器台帳で表示"
                        >
                            <span class="dashboard-kpi-label">
                                <span class="dashboard-kpi-dot is-green" aria-hidden="true">●</span>
                                OK
                            </span>
                            <span class="dashboard-kpi-value-wrap">
                                <strong id="dashboard-green-count" class="dashboard-kpi-value">0</strong>
                                <small class="dashboard-kpi-unit">台</small>
                            </span>
                        </button>

                        <button
                            type="button"
                            class="dashboard-kpi-item dashboard-kpi-red"
                            data-dashboard-action="ledger-red"
                            title="NG（疎通不可）の機器を機器台帳で表示"
                        >
                            <span class="dashboard-kpi-label">
                                <span class="dashboard-kpi-dot is-red" aria-hidden="true">●</span>
                                NG
                            </span>
                            <span class="dashboard-kpi-value-wrap">
                                <strong id="dashboard-red-count" class="dashboard-kpi-value">0</strong>
                                <small class="dashboard-kpi-unit">台</small>
                            </span>
                        </button>

                        <button
                            type="button"
                            class="dashboard-kpi-item dashboard-kpi-unknown"
                            data-dashboard-action="ledger-unknown"
                            title="未確認・確認中の機器を機器台帳で表示"
                        >
                            <span class="dashboard-kpi-label">
                                <span class="dashboard-kpi-dot is-unknown" aria-hidden="true">●</span>
                                未確認
                            </span>
                            <span class="dashboard-kpi-value-wrap">
                                <strong id="dashboard-unknown-count" class="dashboard-kpi-value">0</strong>
                                <small class="dashboard-kpi-unit">台</small>
                            </span>
                        </button>

                        <button
                            type="button"
                            class="dashboard-kpi-item dashboard-kpi-unplaced"
                            data-dashboard-action="quality-unplaced"
                            title="どのビューにも配置されていない機器をデータ品質診断で表示"
                        >
                            <span class="dashboard-kpi-label">
                                <span class="dashboard-kpi-dot is-unplaced" aria-hidden="true">▲</span>
                                未配置
                            </span>
                            <span class="dashboard-kpi-value-wrap">
                                <strong id="dashboard-unplaced-count" class="dashboard-kpi-value">0</strong>
                                <small class="dashboard-kpi-unit">台</small>
                            </span>
                        </button>

                        <button
                            type="button"
                            class="dashboard-kpi-item dashboard-kpi-incomplete"
                            data-dashboard-action="quality-incomplete"
                            title="必須・推奨項目が不足している機器をデータ品質診断で表示"
                        >
                            <span class="dashboard-kpi-label">
                                <span class="dashboard-kpi-dot is-incomplete" aria-hidden="true">▲</span>
                                入力不足
                            </span>
                            <span class="dashboard-kpi-value-wrap">
                                <strong id="dashboard-incomplete-count" class="dashboard-kpi-value">0</strong>
                                <small class="dashboard-kpi-unit">台</small>
                            </span>
                        </button>

                        <button
                            type="button"
                            class="dashboard-kpi-item dashboard-kpi-quality-total"
                            data-dashboard-action="quality-all"
                            title="データ品質診断の問題一覧を表示（エラー・警告の合計）"
                        >
                            <span class="dashboard-kpi-label">
                                <span class="dashboard-kpi-dot is-quality-total" aria-hidden="true">!</span>
                                品質問題
                            </span>
                            <span class="dashboard-kpi-value-wrap">
                                <strong id="dashboard-quality-total-count" class="dashboard-kpi-value">0</strong>
                                <small class="dashboard-kpi-unit">件</small>
                            </span>
                        </button>
                    </section>

                    <!-- Phase 2.6C: 監視状態・データ品質のグラフィカル表示 -->
                    <div class="dashboard-visual-grid">
                        <section
                            class="dashboard-visual-panel"
                            aria-labelledby="dashboard-monitoring-visual-title"
                        >
                            <header class="dashboard-visual-header">
                                <div>
                                    <h4 id="dashboard-monitoring-visual-title">
                                        監視状態
                                    </h4>
                                    <p>疎通確認の最新集計と構成比</p>
                                </div>
                                <div class="dashboard-monitoring-rates">
                                    <span id="dashboard-monitoring-coverage" class="dashboard-visual-badge">
                                        OK率 0.0%
                                    </span>
                                </div>
                            </header>

                            <div class="dashboard-stacked-bar" aria-hidden="true" title="監視状態の構成比">
                                <div id="dashboard-bar-green" class="dashboard-stacked-segment is-green"></div>
                                <div id="dashboard-bar-red" class="dashboard-stacked-segment is-red"></div>
                                <div id="dashboard-bar-unknown" class="dashboard-stacked-segment is-unknown"></div>
                            </div>

                            <div class="dashboard-monitoring-list">
                                <button
                                    type="button"
                                    class="dashboard-status-row is-green"
                                    data-dashboard-action="ledger-green"
                                    title="OK（疎通正常）の機器を機器台帳で表示"
                                >
                                    <div class="dashboard-status-row-info">
                                        <span class="dashboard-status-badge is-green" aria-hidden="true">✓</span>
                                        <span class="dashboard-status-row-label">OK（疎通正常）</span>
                                    </div>
                                    <div class="dashboard-status-row-bar-wrap" aria-hidden="true">
                                        <div id="dashboard-row-bar-green" class="dashboard-status-row-bar is-green"></div>
                                    </div>
                                    <div class="dashboard-status-row-values">
                                        <strong id="dashboard-monitoring-green-count">0台</strong>
                                        <small id="dashboard-monitoring-green-percent">0.0%</small>
                                    </div>
                                </button>

                                <button
                                    type="button"
                                    class="dashboard-status-row is-red"
                                    data-dashboard-action="ledger-red"
                                    title="NG（疎通不可）の機器を機器台帳で表示"
                                >
                                    <div class="dashboard-status-row-info">
                                        <span class="dashboard-status-badge is-red" aria-hidden="true">!</span>
                                        <span class="dashboard-status-row-label">NG（疎通不可）</span>
                                    </div>
                                    <div class="dashboard-status-row-bar-wrap" aria-hidden="true">
                                        <div id="dashboard-row-bar-red" class="dashboard-status-row-bar is-red"></div>
                                    </div>
                                    <div class="dashboard-status-row-values">
                                        <strong id="dashboard-monitoring-red-count">0台</strong>
                                        <small id="dashboard-monitoring-red-percent">0.0%</small>
                                    </div>
                                </button>

                                <button
                                    type="button"
                                    class="dashboard-status-row is-unknown"
                                    data-dashboard-action="ledger-unknown"
                                    title="未確認・確認中の機器を機器台帳で表示"
                                >
                                    <div class="dashboard-status-row-info">
                                        <span class="dashboard-status-badge is-unknown" aria-hidden="true">?</span>
                                        <span class="dashboard-status-row-label">未確認</span>
                                    </div>
                                    <div class="dashboard-status-row-bar-wrap" aria-hidden="true">
                                        <div id="dashboard-row-bar-unknown" class="dashboard-status-row-bar is-unknown"></div>
                                    </div>
                                    <div class="dashboard-status-row-values">
                                        <strong id="dashboard-monitoring-unknown-count">0台</strong>
                                        <small id="dashboard-monitoring-unknown-percent">0.0%</small>
                                    </div>
                                </button>
                            </div>
                        </section>

                        <section
                            class="dashboard-visual-panel"
                            aria-labelledby="dashboard-quality-visual-title"
                        >
                            <header class="dashboard-visual-header">
                                <div>
                                    <h4 id="dashboard-quality-visual-title">
                                        データ品質
                                    </h4>
                                    <p>保存済みDB基準の診断結果内訳</p>
                                </div>
                                <div class="dashboard-quality-summary-header">
                                    <button
                                        type="button"
                                        class="dashboard-visual-badge dashboard-quality-total-badge"
                                        data-dashboard-action="quality-all"
                                        title="データ品質診断で全問題を表示（エラー・警告の合計）"
                                    >
                                        問題合計 <strong id="dashboard-quality-panel-total">0</strong>件
                                    </button>
                                </div>
                            </header>

                            <div class="dashboard-quality-list">
                                <button
                                    type="button"
                                    class="dashboard-quality-row is-error"
                                    data-dashboard-action="quality-error"
                                    title="重大度「エラー」の問題を品質診断で表示"
                                >
                                    <div class="dashboard-quality-row-info">
                                        <span class="dashboard-quality-badge is-error">エラー</span>
                                        <span class="dashboard-quality-row-desc">整合性・識別等の重大な問題</span>
                                    </div>
                                    <div class="dashboard-quality-row-values">
                                        <strong id="dashboard-quality-error-count">0</strong>
                                        <small>件</small>
                                    </div>
                                </button>

                                <button
                                    type="button"
                                    class="dashboard-quality-row is-warning"
                                    data-dashboard-action="quality-warning"
                                    title="重大度「警告」の問題を品質診断で表示"
                                >
                                    <div class="dashboard-quality-row-info">
                                        <span class="dashboard-quality-badge is-warning">警告</span>
                                        <span class="dashboard-quality-row-desc">確認・是正を推奨する問題</span>
                                    </div>
                                    <div class="dashboard-quality-row-values">
                                        <strong id="dashboard-quality-warning-count">0</strong>
                                        <small>件</small>
                                    </div>
                                </button>

                                <button
                                    type="button"
                                    class="dashboard-quality-row is-floor-plan"
                                    data-dashboard-action="quality-floor-plan"
                                    title="図面が未登録のフロアビューを品質診断で表示"
                                >
                                    <div class="dashboard-quality-row-info">
                                        <span class="dashboard-quality-badge is-floor-plan">図面未登録</span>
                                        <span class="dashboard-quality-row-desc">背景図面がないフロアビュー</span>
                                    </div>
                                    <div class="dashboard-quality-row-values">
                                        <strong id="dashboard-floor-plan-missing-count">0</strong>
                                        <small>件</small>
                                    </div>
                                </button>
                            </div>
                        </section>
                    </div>

                    </div>

                    <div id="dashboard-panel-assets" class="dashboard-tab-panel" role="tabpanel" aria-labelledby="dashboard-tab-assets" hidden>
                    <section class="dashboard-section dashboard-breakdown-section dashboard-maintenance-section" aria-labelledby="dashboard-maintenance-title">
                        <div class="dashboard-section-header">
                            <div>
                                <h3 id="dashboard-maintenance-title">保守期限の見通し</h3>
                            </div>
                        </div>
                        <div class="dashboard-maintenance-grid">
                            <button type="button" class="dashboard-kpi-item dashboard-kpi-unplaced" data-dashboard-action="ledger-maintenance-expired">
                                <span class="dashboard-kpi-label">期限超過</span>
                                <span class="dashboard-kpi-value-wrap"><strong id="dashboard-maintenance-expired-count" class="dashboard-kpi-value">0</strong><small class="dashboard-kpi-unit">台</small></span>
                            </button>
                            <button type="button" class="dashboard-kpi-item dashboard-kpi-total" data-dashboard-action="ledger-maintenance-within1Year">
                                <span class="dashboard-kpi-label">残り1年以内</span>
                                <span class="dashboard-kpi-value-wrap"><strong id="dashboard-maintenance-within1Year-count" class="dashboard-kpi-value">0</strong><small class="dashboard-kpi-unit">台</small></span>
                            </button>
                            <button type="button" class="dashboard-kpi-item" data-dashboard-action="ledger-maintenance-within2Years">
                                <span class="dashboard-kpi-label">残り1〜2年</span>
                                <span class="dashboard-kpi-value-wrap"><strong id="dashboard-maintenance-within2Years-count" class="dashboard-kpi-value">0</strong><small class="dashboard-kpi-unit">台</small></span>
                            </button>
                        </div>
                        <p class="dashboard-maintenance-summary">
                            <span>2年超：<strong id="dashboard-maintenance-beyond2Years-count">0</strong>台</span>
                            <span>期限未登録：<strong id="dashboard-maintenance-unset-count">0</strong>台</span>
                            <span class="dashboard-maintenance-note">年月のみの期限は月末として暫定集計します。</span>
                        </p>
                    </section>
                    <section
                        class="dashboard-section dashboard-breakdown-section"
                        aria-labelledby="dashboard-breakdown-title"
                    >
                        <div class="dashboard-section-header">
                            <div>
                                <h3 id="dashboard-breakdown-title">
                                    機器内訳
                                </h3>

                            </div>
                        </div>

                        <div class="dashboard-breakdown-grid">
                            <section
                                class="dashboard-breakdown-panel"
                                aria-labelledby="dashboard-facility-title"
                            >
                                <header class="dashboard-breakdown-header">
                                    <div>
                                        <h4 id="dashboard-facility-title">
                                            施設別
                                        </h4>

                                        <p>
                                            施設ごとの登録台数
                                        </p>
                                    </div>

                                    <span
                                        id="dashboard-facility-group-count"
                                        class="dashboard-breakdown-count"
                                    >
                                        0分類
                                    </span>
                                </header>

                                <div
                                    id="dashboard-facility-list"
                                    class="dashboard-breakdown-list"
                                ></div>
                            </section>

                            <section
                                class="dashboard-breakdown-panel"
                                aria-labelledby="dashboard-floor-title"
                            >
                                <header class="dashboard-breakdown-header">
                                    <div>
                                        <h4 id="dashboard-floor-title">
                                            施設・フロア別
                                        </h4>

                                        <p>
                                            施設・フロアの組み合わせ
                                        </p>
                                    </div>

                                    <span
                                        id="dashboard-floor-group-count"
                                        class="dashboard-breakdown-count"
                                    >
                                        0分類
                                    </span>
                                </header>

                                <div
                                    id="dashboard-floor-list"
                                    class="dashboard-breakdown-list"
                                ></div>
                            </section>

                            <section
                                class="dashboard-breakdown-panel"
                                aria-labelledby="dashboard-type-title"
                            >
                                <header class="dashboard-breakdown-header">
                                    <div>
                                        <h4 id="dashboard-type-title">
                                            機器種別別
                                        </h4>

                                        <p>
                                            種別ごとの構成比
                                        </p>
                                    </div>

                                    <span
                                        id="dashboard-type-group-count"
                                        class="dashboard-breakdown-count"
                                    >
                                        0分類
                                    </span>
                                </header>

                                <div
                                    id="dashboard-type-list"
                                    class="dashboard-breakdown-list"
                                ></div>
                            </section>
                        </div>
                    </section>
                    </div>
                </div>
            </div>

        </section>
    </div>
