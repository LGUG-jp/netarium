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
                <h2 id="dashboard-title">
                    ダッシュボード
                </h2>

                <div class="dashboard-header-actions">
                    <button
                        id="dashboard-refresh-btn"
                        type="button"
                    >
                        <img src="assets/icons/app/refresh.svg" width="16" height="16" alt="" aria-hidden="true">
                        <span id="dashboard-refresh-label">更新</span>
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
                <button id="dashboard-tab-network" type="button" role="tab" aria-selected="false" aria-controls="dashboard-panel-network" tabindex="-1" data-dashboard-tab="network">ネットワーク</button>
                <button id="dashboard-tab-quality" type="button" role="tab" aria-selected="false" aria-controls="dashboard-panel-quality" tabindex="-1" data-dashboard-tab="quality">データ品質</button>
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
                            class="dashboard-kpi-item dashboard-kpi-unplaced"
                            data-dashboard-action="quality-unplaced"
                            title="未配置の機器を機器台帳で表示"
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
                            class="dashboard-kpi-item dashboard-kpi-expired"
                            data-dashboard-action="ledger-maintenance-expired"
                            title="保守期限を過ぎた機器を機器台帳で表示"
                        >
                            <span class="dashboard-kpi-label">保守期限超過</span>
                            <span class="dashboard-kpi-value-wrap">
                                <strong id="dashboard-operations-expired-count" class="dashboard-kpi-value">0</strong>
                                <small class="dashboard-kpi-unit">台</small>
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
                                    <p>未確認には未実行・Ping対象外・IP重複によるスキップを含みます</p>
                                </div>
                                <div class="dashboard-monitoring-rates">
                                    <span id="dashboard-monitoring-coverage" class="dashboard-visual-badge" title="OK率は全登録機器が分母です。到達不可の機器も含みます">
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
                                    title="未実行・Ping対象外・IP重複によるスキップを含む、未確認・確認中の機器を機器台帳で表示"
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
                    <section class="dashboard-section dashboard-asset-card" aria-labelledby="dashboard-maintenance-title">
                        <div class="dashboard-section-header">
                            <h3 id="dashboard-maintenance-title">保守期限の見通し</h3>
                            <div class="dashboard-maintenance-settings">
                                <label for="dashboard-maintenance-mode">表示</label>
                                <select id="dashboard-maintenance-mode">
                                    <option value="fiscal">年度別</option>
                                    <option value="remaining">残存期間別</option>
                                </select>
                                <label id="dashboard-fiscal-start-label" for="dashboard-fiscal-start">年度開始月</label>
                                <select id="dashboard-fiscal-start">
                                    <option value="1">1月</option><option value="2">2月</option>
                                    <option value="3">3月</option><option value="4" selected>4月</option>
                                    <option value="5">5月</option><option value="6">6月</option>
                                    <option value="7">7月</option><option value="8">8月</option>
                                    <option value="9">9月</option><option value="10">10月</option>
                                    <option value="11">11月</option><option value="12">12月</option>
                                </select>
                            </div>
                        </div>
                        <div class="dashboard-inline-metrics">
                            <button type="button" class="dashboard-inline-metric" data-dashboard-action="ledger-maintenance-expired">
                                期限超過 <strong id="dashboard-maintenance-expired-count">0</strong>台
                            </button>
                            <button type="button" class="dashboard-inline-metric" data-dashboard-action="quality-code" data-code="maintenance_expiry_missing" disabled>
                                期限未登録 <strong id="dashboard-maintenance-unset-count">—</strong>台
                            </button>
                            <button type="button" class="dashboard-inline-metric" data-dashboard-action="quality-code" data-code="maintenance_expiry_missing" data-show-suppressed="true" disabled>
                                設定不要 <strong id="dashboard-maintenance-suppressed-count">—</strong>台
                            </button>
                            <button type="button" class="dashboard-inline-metric is-warning" data-dashboard-action="quality-code" data-code="invalid_maintenance_expiry_date" id="dashboard-maintenance-invalid" hidden>
                                形式不正 <strong id="dashboard-maintenance-invalid-count">0</strong>台
                            </button>
                        </div>
                        <div id="dashboard-maintenance-list" class="dashboard-maintenance-grid"></div>
                        <p class="dashboard-metric-note">期限の見通しは画面の機器データで集計し、年月のみの期限は月末として扱います。期限未登録と設定不要は保存済みデータが基準です。</p>
                    </section>
                    <section
                        class="dashboard-section dashboard-asset-card dashboard-assets-breakdown"
                        aria-labelledby="dashboard-breakdown-title"
                    >
                        <div class="dashboard-section-header">
                            <div>
                                <h3 id="dashboard-breakdown-title">
                                    機器内訳
                                </h3>

                            </div>
                            <button id="dashboard-breakdown-toggle" class="dashboard-details-toggle" type="button" data-expand-label="内訳を見る" aria-expanded="false" aria-controls="dashboard-breakdown-details">内訳を見る ▼</button>
                        </div>

                        <div class="dashboard-asset-summary">
                            <div class="dashboard-asset-metric">
                                <span class="dashboard-kpi-label">登録機器</span>
                                <span class="dashboard-kpi-value-wrap"><strong id="dashboard-assets-devices-count" class="dashboard-kpi-value">0</strong><small class="dashboard-kpi-unit">台</small></span>
                            </div>
                            <div class="dashboard-asset-metric">
                                <span class="dashboard-kpi-label">設置建物数</span>
                                <span class="dashboard-kpi-value-wrap"><strong id="dashboard-assets-facilities-count" class="dashboard-kpi-value">0</strong><small class="dashboard-kpi-unit">棟</small></span>
                            </div>
                        </div>
                        <div id="dashboard-breakdown-details" class="dashboard-breakdown-grid dashboard-asset-details" hidden>
                            <section
                                class="dashboard-breakdown-panel"
                                aria-labelledby="dashboard-facility-title"
                            >
                                <header class="dashboard-breakdown-header">
                                    <div>
                                        <h4 id="dashboard-facility-title">
                                            設置建物・フロア別
                                        </h4>

                                        <p>
                                            建物の割合は全機器、フロアの割合はその建物内の機器が分母です。
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
                    <section class="dashboard-section dashboard-asset-card dashboard-assets-racks" aria-labelledby="dashboard-racks-title">
                        <div class="dashboard-section-header">
                            <h3 id="dashboard-racks-title">ラック管理</h3>
                            <button id="dashboard-racks-toggle" class="dashboard-details-toggle" type="button" data-expand-label="ラック一覧を見る" aria-expanded="false" aria-controls="dashboard-rack-list">ラック一覧を見る ▼</button>
                        </div>
                        <div class="dashboard-asset-summary">
                            <div class="dashboard-asset-metric">
                                <span class="dashboard-kpi-label">登録ラック</span>
                                <span class="dashboard-kpi-value-wrap"><strong id="dashboard-racks-count" class="dashboard-kpi-value">0</strong><small class="dashboard-kpi-unit">ラック</small></span>
                            </div>
                            <div class="dashboard-asset-metric">
                                <span class="dashboard-kpi-label">搭載機器</span>
                                <span class="dashboard-kpi-value-wrap"><strong id="dashboard-rack-devices-count" class="dashboard-kpi-value">0</strong><small class="dashboard-kpi-unit">台</small></span>
                            </div>
                        </div>
                        <div id="dashboard-rack-list" class="dashboard-rack-list dashboard-asset-details" hidden></div>
                    </section>
                    </div>

                    <div id="dashboard-panel-network" class="dashboard-tab-panel" role="tabpanel" aria-labelledby="dashboard-tab-network" hidden>
                    <section class="dashboard-section dashboard-asset-card" aria-labelledby="dashboard-network-title">
                        <div class="dashboard-section-header">
                            <h3 id="dashboard-network-title">ポート・共通接続</h3>
                            <button type="button" class="dashboard-details-toggle" data-dashboard-action="ledger-all">機器台帳を開く →</button>
                        </div>
                        <div class="dashboard-asset-summary">
                            <div class="dashboard-asset-metric">
                                <span class="dashboard-kpi-label">登録ポート</span>
                                <span class="dashboard-kpi-value-wrap"><strong id="dashboard-network-port-count" class="dashboard-kpi-value">0</strong><small class="dashboard-kpi-unit">件</small></span>
                            </div>
                            <div class="dashboard-asset-metric">
                                <span class="dashboard-kpi-label">共通接続</span>
                                <span class="dashboard-kpi-value-wrap"><strong id="dashboard-network-link-count" class="dashboard-kpi-value">0</strong><small class="dashboard-kpi-unit">件</small></span>
                            </div>
                            <div class="dashboard-asset-metric">
                                <span class="dashboard-kpi-label">ポート登録機器</span>
                                <span class="dashboard-kpi-value-wrap"><strong id="dashboard-network-device-count" class="dashboard-kpi-value">0</strong><small class="dashboard-kpi-unit">台</small></span>
                            </div>
                        </div>
                        <div class="dashboard-network-grid">
                            <section class="dashboard-breakdown-panel">
                                <h4>登録ポートの接続状況</h4>
                                <p class="dashboard-metric-note">分母：登録ポート数。実機の空きポート数ではありません。</p>
                                <div id="dashboard-network-ports" class="dashboard-network-list"></div>
                            </section>
                            <section class="dashboard-breakdown-panel">
                                <h4>接続端点のポート指定状況</h4>
                                <p class="dashboard-metric-note">保存済みデータが基準です。分母：共通接続の端点数（1 接続につき 2 端点）。</p>
                                <div id="dashboard-network-endpoints" class="dashboard-network-list"></div>
                            </section>
                            <section class="dashboard-breakdown-panel">
                                <h4>共通接続の構成内訳</h4>
                                <p class="dashboard-metric-note">分母：共通接続数。機器の設置フロアで分類します。</p>
                                <div id="dashboard-network-topology" class="dashboard-network-list"></div>
                            </section>
                        </div>
                    </section>
                    <section class="dashboard-section dashboard-asset-card" aria-labelledby="dashboard-ip-title">
                        <div class="dashboard-section-header">
                            <h3 id="dashboard-ip-title">IPアドレス管理</h3>
                            <button type="button" class="dashboard-details-toggle" data-dashboard-action="ip-management">IP管理を開く →</button>
                        </div>
                        <div class="dashboard-asset-summary dashboard-ip-summary">
                            <div class="dashboard-asset-metric">
                                <span class="dashboard-kpi-label">ネットワーク区分数</span>
                                <span class="dashboard-kpi-value-wrap"><strong id="dashboard-ip-address_spaces-count" class="dashboard-kpi-value">—</strong><small class="dashboard-kpi-unit">区分</small></span>
                            </div>
                            <div class="dashboard-asset-metric">
                                <span class="dashboard-kpi-label">セグメント数</span>
                                <span class="dashboard-kpi-value-wrap"><strong id="dashboard-ip-ip_segments-count" class="dashboard-kpi-value">—</strong><small class="dashboard-kpi-unit">セグメント</small></span>
                            </div>
                            <div class="dashboard-asset-metric">
                                <span class="dashboard-kpi-label">登録IP件数</span>
                                <span class="dashboard-kpi-value-wrap"><strong id="dashboard-ip-registered_ips-count" class="dashboard-kpi-value">—</strong><small class="dashboard-kpi-unit">件</small></span>
                            </div>
                            <button type="button" id="dashboard-ip-unclassified" class="dashboard-asset-metric dashboard-ip-link" data-dashboard-action="ip-unclassified" disabled title="未分類IP一覧を開く">
                                <span class="dashboard-kpi-label">未分類IP件数 <span aria-hidden="true">→</span></span>
                                <span class="dashboard-kpi-value-wrap"><strong id="dashboard-ip-unclassified_ips-count" class="dashboard-kpi-value">—</strong><small class="dashboard-kpi-unit">件</small></span>
                            </button>
                        </div>
                        <p id="dashboard-ip-status" class="dashboard-ip-status" role="status" aria-live="polite">未取得</p>
                    </section>
                    </div>

                    <div id="dashboard-panel-quality" class="dashboard-tab-panel" role="tabpanel" aria-labelledby="dashboard-tab-quality" hidden>
                    <section class="dashboard-section dashboard-asset-card" aria-labelledby="dashboard-diagnosis-title">
                        <div class="dashboard-section-header">
                            <div class="dashboard-inline-metrics">
                                <h3 id="dashboard-diagnosis-title">品質診断</h3>
                                <button type="button" class="dashboard-diagnosis-total" data-dashboard-action="quality-all" title="エラーと警告を品質診断で表示" disabled>
                                    問題合計 <span><strong id="dashboard-diagnosis-problems-count">—</strong>件</span>
                                </button>
                                <p>保存済みデータが基準です。</p>
                            </div>
                            <div class="dashboard-inline-metrics dashboard-diagnosis-actions">
                                <div id="dashboard-diagnosis-migration" class="dashboard-inline-metrics dashboard-diagnosis-migration" hidden></div>
                                <button type="button" class="dashboard-details-toggle" data-dashboard-action="quality-diagnosis">品質診断を開く →</button>
                            </div>
                        </div>
                        <div id="dashboard-diagnosis-summary" class="dashboard-asset-summary">
                            <button type="button" class="dashboard-asset-metric dashboard-diagnosis-card is-error" data-dashboard-action="quality-error" disabled>
                                <span class="dashboard-kpi-label">エラー</span>
                                <span class="dashboard-kpi-value-wrap"><strong id="dashboard-diagnosis-error-count" class="dashboard-kpi-value">—</strong><small class="dashboard-kpi-unit">件</small></span>
                            </button>
                            <button type="button" class="dashboard-asset-metric dashboard-diagnosis-card is-warning" data-dashboard-action="quality-warning" disabled>
                                <span class="dashboard-kpi-label">警告</span>
                                <span class="dashboard-kpi-value-wrap"><strong id="dashboard-diagnosis-warning-count" class="dashboard-kpi-value">—</strong><small class="dashboard-kpi-unit">件</small></span>
                            </button>
                            <button type="button" class="dashboard-asset-metric dashboard-diagnosis-card is-info" data-dashboard-action="quality-info" disabled>
                                <span class="dashboard-kpi-label">情報</span>
                                <span class="dashboard-kpi-value-wrap"><strong id="dashboard-diagnosis-info-count" class="dashboard-kpi-value">—</strong><small class="dashboard-kpi-unit">件</small></span>
                            </button>
                            <button type="button" class="dashboard-asset-metric dashboard-diagnosis-card" data-dashboard-action="quality-suppressed" disabled>
                                <span class="dashboard-kpi-label">設定不要</span>
                                <span class="dashboard-kpi-value-wrap"><strong id="dashboard-diagnosis-suppressed-count" class="dashboard-kpi-value">—</strong><small class="dashboard-kpi-unit">項目</small></span>
                            </button>
                        </div>
                        <h4 class="dashboard-category-title">カテゴリ別内訳</h4>
                        <div id="dashboard-diagnosis-categories" class="dashboard-category-grid"></div>
                    </section>
                    <section class="dashboard-section dashboard-asset-card" aria-labelledby="dashboard-registration-title">
                        <div class="dashboard-section-header">
                            <h3 id="dashboard-registration-title">機器台帳の項目別登録状況</h3>
                            <div class="dashboard-inline-metrics dashboard-registration-meta">
                                <p>設定不要は登録率の分母から除外。入力内容の正確さは判定しません。</p>
                                <ul class="dashboard-registration-legend" role="list" aria-label="内訳バーの凡例">
                                    <li><span class="dashboard-legend-swatch is-registered" aria-hidden="true"></span>登録済み</li>
                                    <li><span class="dashboard-legend-swatch is-missing" aria-hidden="true"></span>未登録</li>
                                    <li><span class="dashboard-legend-swatch is-suppressed" aria-hidden="true"></span>設定不要</li>
                                </ul>
                            </div>
                        </div>
                        <p id="dashboard-registration-status" class="dashboard-breakdown-empty">—</p>
                        <table id="dashboard-registration-table" class="dashboard-registration-table" role="table" aria-labelledby="dashboard-registration-title" hidden>
                            <thead role="rowgroup">
                                <tr role="row">
                                    <th scope="col" role="columnheader">項目名</th>
                                    <th scope="col" role="columnheader">内訳</th>
                                    <th scope="col" role="columnheader">登録率</th>
                                    <th scope="col" role="columnheader">登録済み</th>
                                    <th scope="col" role="columnheader">未登録</th>
                                    <th scope="col" role="columnheader">設定不要</th>
                                </tr>
                            </thead>
                            <tbody id="dashboard-registration-rows" role="rowgroup"></tbody>
                        </table>
                    </section>
                    </div>
                </div>
            </div>

        </section>
    </div>
