    <!-- 1. 個別機器の配置先ビューを選択・管理するモーダル -->
    <div
        id="placement-manager-overlay"
        class="placement-manager-overlay"
        hidden
    >
        <section
            class="placement-manager-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="placement-manager-title"
        >
            <header class="placement-manager-header">
                <div>
                    <h2 id="placement-manager-title">
                        表示するビューを選択
                    </h2>

                    <p id="placement-manager-device">
                        -
                    </p>
                </div>

                <button
                    type="button"
                    class="modal-close-btn"
                    id="close-placement-manager-btn"
                    aria-label="閉じる"
                >
                    ×
                </button>
            </header>

            <div class="placement-manager-device-meta">
                <span>
                    施設:
                    <strong id="pm-device-facility">-</strong>
                </span>

                <span>
                    フロア:
                    <strong id="pm-device-floor">-</strong>
                </span>
            </div>

            <div class="placement-manager-tools">
                <label for="placement-manager-search">
                    ビュー検索
                </label>

                <input
                    id="placement-manager-search"
                    type="search"
                    placeholder="ビュー名、施設、フロアで検索"
                >

                <span id="placement-manager-count"></span>
            </div>

            <div
                id="placement-manager-list"
                class="placement-manager-list"
            ></div>

            <div
                id="placement-manager-impact"
                class="placement-manager-impact"
                aria-live="polite"
            ></div>

            <footer class="placement-manager-footer">
                <p>
                    「適用」で変更を確定し、自動保存します。
                </p>

                <div>
                    <button
                        type="button"
                        class="btn btn-cancel"
                        id="close-placement-manager-btn-2"
                    >
                        キャンセル
                    </button>

                    <button
                        id="placement-manager-apply-btn"
                        type="button"
                        class="btn btn-primary btn-sm"
                    >
                        適用
                    </button>
                </div>
            </footer>
        </section>
    </div>
