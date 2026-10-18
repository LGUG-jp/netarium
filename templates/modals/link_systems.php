<div id="link-systems-overlay" class="placement-manager-overlay" hidden>
    <section class="placement-manager-dialog link-systems-dialog" role="dialog" aria-modal="true"
        aria-labelledby="link-systems-title" tabindex="-1">
        <header class="placement-manager-header">
            <h2 id="link-systems-title">接続系統設定</h2>
            <div class="link-systems-header-actions">
                <a id="link-systems-help" class="btn btn-tertiary btn-sm" href="help.html#link-systems"
                    target="_blank" rel="noopener" aria-label="接続系統のヘルプ（別タブで開く）"
                    title="接続系統のヘルプ（別タブで開く）">？設定方法</a>
                <button type="button" class="modal-close-btn" id="link-systems-close" aria-label="閉じる">×</button>
            </div>
        </header>
        <div class="link-systems-body">
            <div id="link-systems-status" role="status" aria-live="polite"></div>
            <div class="link-systems-workspace">
                <section class="link-systems-list-area" aria-labelledby="link-systems-list-title">
                    <h3 id="link-systems-list-title">接続系統</h3>
                    <div class="link-systems-list-actions">
                        <button type="button" class="btn btn-secondary admin-only" id="link-systems-new"><span aria-hidden="true">＋</span>新規作成</button>
                        <button type="button" class="btn btn-tertiary btn-sm" id="link-systems-refresh">再読込</button>
                    </div>
                    <div id="link-systems-list" class="link-systems-list" aria-labelledby="link-systems-list-title"></div>
                </section>
                <form id="link-systems-form" class="link-systems-form" aria-labelledby="link-systems-form-title">
                    <h3 id="link-systems-form-title">系統の新規作成</h3>
                    <div class="link-systems-fields">
                        <div class="link-systems-field">
                            <label for="link-systems-name" class="form-label">名称</label>
                            <input id="link-systems-name" type="text" data-max-length="100" autocomplete="off" required>
                            <p id="link-systems-name-error" class="form-error" aria-live="polite" hidden></p>
                        </div>
                        <div class="link-systems-field">
                            <span id="link-systems-color-label" class="form-label">色</span>
                            <div id="link-systems-color-options" class="link-systems-color-options" role="radiogroup" aria-labelledby="link-systems-color-label"></div>
                        </div>
                    </div>
                    <div id="link-systems-actions" class="link-systems-actions admin-only">
                        <button type="button" class="btn btn-cancel" id="link-systems-cancel">キャンセル</button>
                        <button type="submit" class="btn btn-primary" id="link-systems-save">登録</button>
                        <button type="button" class="btn btn-danger btn-secondary" id="link-systems-delete" hidden>削除</button>
                    </div>
                </form>
            </div>
        </div>
    </section>
</div>
