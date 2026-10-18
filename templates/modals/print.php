<div id="print-overlay" class="placement-manager-overlay" hidden>
    <style id="print-page-style" media="print" nonce="<?= htmlspecialchars(\Netarium\Core\SecurityHeaders::nonce(), ENT_QUOTES, 'UTF-8') ?>"></style>
    <section class="placement-manager-dialog print-dialog" role="dialog" aria-modal="true"
        aria-labelledby="print-dialog-title" aria-describedby="print-description" tabindex="-1">
        <header class="placement-manager-header">
            <h2 id="print-dialog-title">印刷設定</h2>
            <button id="print-close" type="button" class="modal-close-btn" aria-label="閉じる">×</button>
        </header>
        <div class="print-workspace">
        <div id="print-settings" class="print-settings-body">
            <p id="print-description" class="form-support">チェックした項目を印刷します。</p>
            <fieldset class="print-field">
                <legend>印刷範囲</legend>
                <div class="print-options">
                    <label class="print-choice"><input type="radio" name="print-range" value="all" checked><span><strong>全体</strong></span></label>
                    <label class="print-choice"><input type="radio" name="print-range" value="viewport"><span><strong>現在の表示範囲</strong></span></label>
                </div>
            </fieldset>
            <fieldset class="print-field">
                <legend>印刷する機器</legend>
                <div class="print-bulk-actions">
                    <button id="print-select-all" type="button" class="btn btn-secondary btn-sm">すべて選択</button>
                    <button id="print-clear-all" type="button" class="btn btn-tertiary btn-sm print-neutral">すべて解除</button>
                    <span id="print-device-count" class="form-support" role="status"></span>
                </div>
                <div id="print-device-types" class="print-options"></div>
            </fieldset>
            <fieldset class="print-field">
                <legend>印刷する表示内容</legend>
                <div class="print-options">
                    <label class="print-choice"><input id="print-links" type="checkbox" checked><span><strong>接続</strong></span></label>
                    <label class="print-choice"><input id="print-labels" type="checkbox" checked><span><strong>接続ラベル</strong></span></label>
                    <label class="print-choice"><input id="print-floorPlan" type="checkbox" checked><span><strong>フロア図面</strong></span></label>
                    <label class="print-choice"><input id="print-notes" type="checkbox" checked><span><strong>キャンバスメモ</strong></span></label>
                    <label class="print-choice"><input id="print-deviceName" type="checkbox" checked><span><strong>機器名</strong></span></label>
                    <label class="print-choice"><input id="print-deviceType" type="checkbox" checked><span><strong>機器種別</strong></span></label>
                    <label class="print-choice"><input id="print-ip" type="checkbox" checked><span><strong>IPアドレス</strong></span></label>
                    <label class="print-choice"><input id="print-title" type="checkbox" checked><span><strong>タイトル</strong></span></label>
                </div>
            </fieldset>
            <fieldset class="print-field">
                <legend>印刷の向き</legend>
                <div class="print-orientation-options">
                    <label class="print-choice"><input type="radio" name="print-orientation" value="auto" checked><span>自動</span></label>
                    <label class="print-choice"><input type="radio" name="print-orientation" value="landscape"><span>横</span></label>
                    <label class="print-choice"><input type="radio" name="print-orientation" value="portrait"><span>縦</span></label>
                </div>
            </fieldset>
        </div>
        <section id="print-preview" class="print-preview-body" aria-labelledby="print-preview-title" aria-busy="false">
            <div class="print-preview-heading">
                <h3 id="print-preview-title">印刷プレビュー</h3>
                <span id="print-preview-orientation" class="form-support"></span>
            </div>
            <p id="print-preview-status" class="form-support" role="status" hidden></p>
            <p id="print-preview-error" class="form-error" role="alert" hidden></p>
            <div id="print-sheet-container" class="print-sheet-container"></div>
        </section>
        </div>
        <footer class="placement-manager-footer">
            <button id="print-cancel" type="button" class="btn btn-cancel">キャンセル</button>
            <button id="print-execute" type="button" class="btn btn-primary" disabled>印刷</button>
        </footer>
    </section>
</div>
