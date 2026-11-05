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
                                <li>20 列のヘッダー名と列順は CSV 出力のまま使用してください。旧 19 列や列名・順序が異なる CSV は取り込めません。最新の CSV を出力してテンプレートにしてください。</li>
                            </ul>
                        </section>
                        <section>
                            <h4>IDと更新ルール</h4>
                            <ul>
                                <li>idが空欄なら新規登録し、取込実行時に自動採番します。</li>
                                <li>既存idの行は該当機器を更新し、変更がなければ「変更なし」と判定します。</li>
                                <li>同じidの重複指定はできません。</li>
                                <li>additional_ips 以外の空欄は空値として反映します。additional_ips の空欄は既存機器では保持、新規機器では追加 IP なしになります。</li>
                                <li>additional_ips は [] で全削除、JSON 配列で全置換します。配列順を表示順とし、用途ラベルは label に指定します。例: <code>[{"ip":"192.0.2.20","label":"業務"},{"ip":"192.0.2.21","label":"保守"}]</code>（CSV セル内の二重引用符は二重にします）。出力時、追加 IP がなければ [] です。</li>
                                <li>セグメント所属用の列は増やしません。管理 IP、および追加 IP の IP・用途が不変なら所属を保持します。変更・新規 IP は一意候補へ分類し、複数候補または候補なしは未分類として警告します。</li>
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
                                <li>追加 IP は新規行でも表示し、更新行は変更前後を表示します。管理 IP の変更で監視状態を未確認へ戻します。追加 IP だけの変更では監視状態を変えません。</li>
                                <li>不正な JSON、配列以外、不正な IPv4、同一機器内の IP 重複はエラーです。同じアドレス空間内の新たな IP 重複は拒否し、別空間の同じ IP は許容します。未分類を含む新たな重複は対象と空間候補を警告し、確定時に確認します。既存重複に無関係な変更では再警告しません。</li>
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
