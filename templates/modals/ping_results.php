<div id="ping-results-overlay" class="placement-manager-overlay" hidden>
    <section class="placement-manager-dialog ping-results-dialog" role="dialog" aria-modal="true"
        aria-labelledby="ping-results-title" aria-describedby="ping-results-description" tabindex="-1">
        <header class="ledger-header">
            <h2 id="ping-results-title">Ping実行結果</h2>
            <button type="button" class="modal-close-btn" data-ping-results-close
                aria-label="閉じる">×</button>
        </header>
        <div class="ping-results-summary-area">
            <p id="ping-results-description" class="ledger-sheet-sub">直近の実行開始時の機器名・IPアドレスを表示します。</p>
            <div class="ping-results-times ledger-sheet-sub">
                <span>開始: <time id="ping-results-started-at">—</time></span>
                <span>完了: <time id="ping-results-completed-at">—</time></span>
            </div>
            <div class="ping-results-summary" role="group" aria-label="結果の集計">
                <span>対象 <strong id="ping-results-count-total">0</strong>件</span>
                <span class="status-ok">OK <strong id="ping-results-count-success">0</strong>件</span>
                <span class="status-ng">NG <strong id="ping-results-count-failure">0</strong>件</span>
                <span class="status-ng">タイムアウト <strong id="ping-results-count-timeout">0</strong>件</span>
                <span class="is-muted">スキップ <strong id="ping-results-count-skipped">0</strong>件</span>
                <span class="is-muted">未確認 <strong id="ping-results-count-unknown">0</strong>件</span>
            </div>
            <p id="ping-results-error" class="form-error" role="alert" hidden></p>
            <p id="ping-results-filter-help" class="ledger-sheet-sub">「失敗のみ」と台帳の「NG」は、NGとタイムアウトが対象です。スキップ・未確認は含みません。</p>
        </div>
        <div class="ledger-sheet-actions-bar">
            <div class="ping-results-filters" role="group" aria-label="結果の絞り込み" aria-describedby="ping-results-filter-help">
                <button type="button" class="btn btn-primary btn-sm" data-ping-results-filter="all" aria-pressed="true">すべて</button>
                <button type="button" class="btn btn-secondary btn-sm" data-ping-results-filter="failed" aria-pressed="false">失敗のみ</button>
                <button type="button" class="btn btn-secondary btn-sm" data-ping-results-filter="success" aria-pressed="false">成功のみ</button>
            </div>
            <span id="ping-results-visible-count" class="ledger-sheet-sub" role="status" aria-live="polite">表示 0件 / 対象 0件</span>
            <button id="ping-results-csv-btn" type="button" class="btn btn-secondary btn-sm"
                title="絞り込みにかかわらず、この実行の全件を出力します" disabled>CSVダウンロード</button>
        </div>
        <div id="ping-results-list" class="ping-results-list" role="region" aria-label="Ping結果一覧" tabindex="0">
            <table class="table-dense ping-results-table">
                <colgroup><col class="ping-results-col-device" /><col class="ping-results-col-outcome" /><col class="ping-results-col-response" /><col class="ping-results-col-detail" /></colgroup>
                <thead><tr><th scope="col">機器</th><th scope="col">結果</th><th scope="col">応答時間(ms)</th><th scope="col">詳細</th></tr></thead>
                <tbody id="ping-results-table-body"></tbody>
            </table>
            <p id="ping-results-empty" class="is-muted" hidden>この条件に一致する結果はありません。</p>
        </div>
    </section>
</div>
