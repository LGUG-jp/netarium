    <div
        id="devices-csv-import-overlay"
        class="placement-manager-overlay"
        hidden
    >
        <section
            class="placement-manager-dialog devices-csv-import-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="devices-csv-import-title"
        >
            <header class="placement-manager-header">
                <div>
                    <h2 id="devices-csv-import-title">
                        機器台帳CSV取込
                    </h2>

                    <p>
                        CSVを検証し、既存機器の更新と新規機器の追加を行います。
                    </p>
                </div>

                <button
                    type="button"
                    class="modal-close-btn"
                    id="close-devices-csv-import-btn"
                    aria-label="閉じる"
                >
                    ×
                </button>
            </header>

            <div class="devices-csv-import-body">
                <section class="devices-csv-import-file">
                    <label for="devices-csv-import-file">
                        CSVファイル
                    </label>

                    <input
                        id="devices-csv-import-file"
                        type="file"
                        accept=".csv,text/csv"
                        aria-describedby="devices-csv-import-file-help"
                    >
                    <p id="devices-csv-import-file-error" class="form-error" aria-live="polite" hidden></p>

                    <p id="devices-csv-import-file-help">
                        検証だけではデータは変更されません。結果を確認して「取込を実行」を押してください。
                    </p>

                    <button
                        id="devices-csv-preview-btn"
                        type="button"
                        class="btn btn-primary btn-sm"
                        disabled
                    >
                        CSVを検証
                    </button>
                </section>

                <section class="devices-csv-import-spec" aria-labelledby="devices-csv-import-spec-title">
                    <h3 id="devices-csv-import-spec-title">CSV取込仕様</h3>
                    <div class="devices-csv-import-spec-body">
                        <section>
                            <h4>ファイル仕様</h4>
                            <ul>
                                <li>UTF-8（BOM付きも可）、2MB以下、最大5,000データ行。</li>
                                <li>CSV出力したヘッダー名と列順を変更しないでください。</li>
                            </ul>
                        </section>
                        <section>
                            <h4>IDと更新ルール</h4>
                            <ul>
                                <li>idが空欄なら新規登録し、取込実行時に自動採番します。</li>
                                <li>既存idの行は該当機器を更新し、変更がなければ「変更なし」と判定します。</li>
                                <li>同じidの重複指定はできません。</li>
                            </ul>
                        </section>
                        <section>
                            <h4>安全化文字の扱い</h4>
                            <ul>
                                <li>数式実行を防ぐため、出力時に先頭が =、+、-、@、タブ、改行の値へアポストロフィを付けます。</li>
                                <li>既存機器の更新でDBの既存値と一致した場合だけ復元し、「安全化文字を復元」とプレビュー表示します。</li>
                                <li>新規行や既存値と一致しない値では自動除去しません。</li>
                            </ul>
                        </section>
                        <section>
                            <h4>検証結果と取込実行</h4>
                            <ul>
                                <li>エラーが1件でもあるとCSV全体を取り込めません。警告は内容を確認したうえで取込を実行できます。</li>
                                <li>更新行は変更前後を表示し、IPアドレスの変更で監視状態を未確認へ戻します。</li>
                                <li>全行が「変更なし」なら、取り込む変更はありません。</li>
                            </ul>
                        </section>
                        <section>
                            <h4>CSV取込の対象外</h4>
                            <ul>
                                <li>ビュー配置・機器間の接続・図面・ビュー設定は変更しません。</li>
                                <li>新規機器は取込後も未配置です。</li>
                            </ul>
                        </section>
                    </div>
                </section>

                <section
                    id="devices-csv-import-result"
                    class="devices-csv-import-result"
                    hidden
                >
                    <h3>検証結果</h3>
                    <div class="devices-csv-import-summary">
                        <span>
                            合計
                            <strong id="devices-csv-total">0</strong>
                        </span>
                        <span class="csv-import-insert">
                            新規
                            <strong id="devices-csv-insert">0</strong>
                        </span>
                        <span class="csv-import-update">
                            更新
                            <strong id="devices-csv-update">0</strong>
                        </span>
                        <span class="csv-import-unchanged">
                            変更なし
                            <strong id="devices-csv-unchanged">0</strong>
                        </span>
                        <span class="csv-import-warning">
                            警告
                            <strong id="devices-csv-warning">0</strong>
                        </span>
                        <span class="csv-import-error">
                            エラー
                            <strong id="devices-csv-error">0</strong>
                        </span>
                    </div>

                    <div class="devices-csv-import-filter">
                        <label>
                            <input
                                id="devices-csv-problems-only"
                                type="checkbox"
                            >
                            エラー・警告・変換行のみ表示
                        </label>

                        <span
                            id="devices-csv-import-expiry"
                        ></span>
                    </div>

                    <div class="devices-csv-import-table-wrap">
                        <table class="devices-csv-import-table">
                            <thead>
                                <tr>
                                    <th class="csv-import-column-line">行</th>
                                    <th class="csv-import-column-operation">処理</th>
                                    <th class="csv-import-column-id">ID</th>
                                    <th class="csv-import-column-name">名称</th>
                                    <th class="csv-import-column-ip">IPアドレス</th>
                                    <th class="csv-import-column-changes">変更内容</th>
                                    <th class="csv-import-column-validation">検証結果</th>
                                </tr>
                            </thead>
                            <tbody
                                id="devices-csv-import-rows"
                            ></tbody>
                        </table>
                    </div>
                </section>
            </div>

            <footer class="placement-manager-footer">
                <p id="devices-csv-import-message"></p>

                <div>
                    <button
                        type="button"
                        class="btn btn-cancel"
                        id="close-devices-csv-import-btn-2"
                    >
                        キャンセル
                    </button>

                    <button
                        id="devices-csv-commit-btn"
                        type="button"
                        class="btn btn-primary btn-sm"
                        disabled
                    >
                        取込を実行
                    </button>
                </div>
            </footer>
        </section>
    </div>
