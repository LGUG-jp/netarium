    <!-- 図面管理ダイアログ -->
    <div id="floor-plan-manager-overlay" class="placement-manager-overlay" hidden>
        <section class="placement-manager-dialog floor-plan-manager-dialog" role="dialog"
            aria-modal="true" aria-labelledby="floor-plan-manager-title">
            <header class="ledger-header">
                <div>
                    <h2 id="floor-plan-manager-title">フロア図面</h2>
                    <p id="floor-plan-manager-view">-</p>
                </div>
                <button type="button" class="modal-close-btn" id="close-floor-plan-manager-btn"
                    aria-label="閉じる">×</button>
            </header>
            <div class="floor-plan-manager-body">
                <p id="floor-plan-empty" class="floor-plan-empty">図面が登録されていません。</p>
                <div id="floor-plan-information" class="floor-plan-information" hidden>
                    <div class="floor-plan-thumbnail-frame">
                        <img id="floor-plan-thumbnail" alt="登録済みのフロア図面" hidden>
                        <span id="floor-plan-thumbnail-fallback" class="form-support">プレビューなし</span>
                    </div>
                    <div class="floor-plan-metadata">
                        <p>取り込み元名 <strong id="floor-plan-file-name">-</strong></p>
                        <p>保存形式・容量 <span id="floor-plan-file-type">-</span> ・ <span id="floor-plan-file-size">-</span></p>
                        <p>保存寸法 <span id="floor-plan-dimensions">-</span></p>
                        <p>更新日時 <span id="floor-plan-updated-at">-</span></p>
                    </div>
                </div>
                <div id="floor-plan-settings" class="floor-plan-settings" hidden>
                    <label class="floor-plan-visible-option">
                        <input id="floor-plan-visible" type="checkbox" checked>
                        Canvasにフロア図面を表示する
                    </label>
                    <div>
                        <button id="floor-plan-drag-mode-btn" type="button" class="btn btn-primary btn-sm"
                            >図面を調整</button>
                    </div>
                </div>
                <div class="floor-plan-file-area">
                    <div class="floor-plan-file-actions">
                        <strong id="floor-plan-file-management" hidden>ファイル管理</strong>
                        <div>
                            <button id="floor-plan-upload-btn" type="button" class="btn btn-primary btn-sm"
                                >図面を登録</button>
                            <button id="floor-plan-delete-btn" type="button" class="btn btn-danger btn-secondary btn-sm"
                                 hidden>削除</button>
                        </div>
                    </div>
                    <input id="floor-plan-file" type="file" accept=".png,.jpg,.jpeg,image/png,image/jpeg"
                        tabindex="-1" hidden aria-label="登録または差し替える図面ファイル">
                    <div id="floor-plan-file-error" class="form-error" aria-live="polite" hidden></div>
                    <p class="form-support">
                        入力はPNG/JPEG（最大<?= (int)($appConfig['floor_plan_upload_max_bytes'] / (1024 * 1024)) ?>MiB）。長辺<?= (int)$appConfig['floor_plan_max_dimension'] ?>px以下へ自動縮小して保存します。詳細は<a href="help.html#floor-plans" target="_blank" rel="noopener">ヘルプ</a>を参照してください。
                    </p>
                </div>
            </div>
        </section>
    </div>
