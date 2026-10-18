    <div
        id="device-search-view-overlay"
        class="placement-manager-overlay"
        hidden
    >
        <section
            class="placement-manager-dialog device-search-view-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="device-search-view-title"
        >
            <header class="placement-manager-header">
                <div>
                    <h2 id="device-search-view-title">
                        表示先を選択
                    </h2>

                    <p id="device-search-view-device">
                        -
                    </p>
                </div>

                <button
                    type="button"
                    class="modal-close-btn"
                    id="close-device-search-view-selector-btn"
                    aria-label="閉じる"
                >
                    ×
                </button>
            </header>

            <div
                id="device-search-view-list"
                class="device-search-view-list"
                role="group"
                aria-label="機器の表示先ビュー"
            ></div>

            <footer class="placement-manager-footer">
                <p>
                    機器を表示するビューを選択してください。
                </p>

                <div>
                    <button
                        type="button"
                        class="btn btn-cancel"
                        id="close-device-search-view-selector-btn-2"
                    >
                        キャンセル
                    </button>
                </div>
            </footer>
        </section>
    </div>
