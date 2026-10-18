    <div
        id="data-quality-overlay"
        class="placement-manager-overlay"
        hidden
    >
        <section
            class="placement-manager-dialog data-quality-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="data-quality-title"
            aria-describedby="data-quality-description"
            tabindex="-1"
        >
            <header class="placement-manager-header">
                <div>
                    <h2 id="data-quality-title">
                        データ品質診断
                    </h2>
                    <p id="data-quality-description">
                        機器・配置・図面・接続・監視状態を診断し、問題の修正先へ移動します。
                    </p>
                </div>

                <button
                    type="button"
                    class="modal-close-btn"
                    id="close-data-quality-btn"
                    aria-label="閉じる"
                >
                    ×
                </button>
            </header>

            <div class="data-quality-body">
                <section
                    class="data-quality-summary"
                    aria-label="診断件数"
                >
                    <button
                        type="button"
                        class="data-quality-summary-card data-quality-summary-error"
                        data-quality-severity="error"
                        id="select-data-quality-severity-btn"
                        title="エラーのみ表示"
                    >
                        <span class="data-quality-summary-label">
                            <span class="data-quality-summary-dot is-error" aria-hidden="true">●</span>
                            エラー
                        </span>
                        <strong id="data-quality-error-count">
                            0
                        </strong>
                    </button>

                    <button
                        type="button"
                        class="data-quality-summary-card data-quality-summary-warning"
                        data-quality-severity="warning"
                        id="select-data-quality-severity-btn-2"
                        title="警告のみ表示"
                    >
                        <span class="data-quality-summary-label">
                            <span class="data-quality-summary-dot is-warning" aria-hidden="true">▲</span>
                            警告
                        </span>
                        <strong id="data-quality-warning-count">
                            0
                        </strong>
                    </button>

                    <button
                        type="button"
                        class="data-quality-summary-card data-quality-summary-info"
                        data-quality-severity="info"
                        id="select-data-quality-severity-btn-3"
                        title="情報のみ表示"
                    >
                        <span class="data-quality-summary-label">
                            <span class="data-quality-summary-dot is-info" aria-hidden="true">ℹ</span>
                            情報
                        </span>
                        <strong id="data-quality-info-count">
                            0
                        </strong>
                    </button>

                    <button
                        type="button"
                        class="data-quality-summary-card data-quality-summary-total is-active"
                        data-quality-severity=""
                        id="select-data-quality-severity-btn-4"
                        title="すべての問題を表示"
                    >
                        <span class="data-quality-summary-label">
                            合計
                        </span>
                        <strong id="data-quality-total-count">
                            0
                        </strong>
                    </button>
                </section>

                <div class="data-quality-meta-row">
                    <p id="data-quality-meta">
                        未診断
                    </p>

                    <button
                        id="data-quality-refresh-btn"
                        type="button"
                    >
                        再診断
                    </button>
                </div>

                <div
                    id="data-quality-notices"
                    class="data-quality-notices"
                    aria-live="polite"
                    hidden
                ></div>

                <div class="data-quality-layout">
                    <aside
                        class="data-quality-sidebar"
                        aria-label="診断カテゴリ"
                    >
                        <h3>診断カテゴリ</h3>

                        <div
                            id="data-quality-category-list"
                            class="data-quality-category-list"
                        ></div>
                    </aside>

                    <main class="data-quality-main">
                        <div class="data-quality-list-header">
                            <div class="data-quality-list-header-info">
                                <h3 id="data-quality-list-title">
                                    すべての問題
                                </h3>

                                <p id="data-quality-filter-summary">
                                    0件
                                </p>
                            </div>

                            <div
                                id="data-quality-filter-chips"
                                class="data-quality-filter-chips"
                                hidden
                            ></div>

                            <button
                                id="data-quality-clear-filter-btn"
                                type="button"
                                disabled
                            >
                                すべて解除
                            </button>
                        </div>

                        <div
                            id="data-quality-status"
                            class="data-quality-status"
                            role="status"
                            aria-live="polite"
                        >
                            診断結果を読み込んでいません。
                        </div>

                        <div
                            id="data-quality-issue-list"
                            class="data-quality-issue-list"
                            hidden
                        ></div>
                    </main>
                </div>
            </div>

            <footer class="placement-manager-footer">
                <p>
                    問題件数は、機器数ではなく
                    診断問題のグループ数です。
                </p>

            </footer>
        </section>
    </div>
