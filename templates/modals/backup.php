    <div
        id="backup-restore-overlay"
        class="placement-manager-overlay"
        hidden
    >
        <section
            class="placement-manager-dialog backup-restore-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="backup-restore-title"
        >
            <header class="placement-manager-header">
                <div>
                    <h2 id="backup-restore-title">
                        構成情報バックアップから復元
                    </h2>
                </div>

                <button
                    type="button"
                    class="modal-close-btn"
                    id="close-backup-restore-btn"
                    aria-label="閉じる"
                >
                    ×
                </button>
            </header>

            <div class="backup-restore-body">
                <section class="backup-restore-warning">
                    <strong>注意</strong>
                    <p id="backup-restore-guidance">まずバックアップZIPを選択し、検証してください。</p>
                    <p>
                        復元すると、現在のビュー、機器、監視状態、
                        配置、接続、接続系統、メモ、画像の関連情報が置き換わります。
                        利用者・パスワード・現在のログイン状態は変更しません。
                    </p>
                    <p>
                        ZIPに画像実体は含まれません。保存名・サイズ・形式・寸法・SHA-256が一致する既存画像だけを関連付けます。
                        欠損・不一致の画像参照は復元しません。未参照になる画像も含め、物理ファイルは削除しません。
                    </p>
                    <p>
                        実行直前に現在の構成情報ZIPを自動退避します。
                        画像・利用者を含む全損復旧には、サーバー側の完全バックアップが必要です。
                    </p>
                </section>

                <section class="backup-restore-file">
                    <label for="backup-restore-file">
                        バックアップZIP
                    </label>

                    <input
                        id="backup-restore-file"
                        type="file"
                        accept=".zip,application/zip"
                        aria-describedby="backup-restore-guidance backup-restore-file-name backup-restore-file-help"
                    >
                    <p id="backup-restore-file-name" class="backup-restore-file-name" aria-live="polite">ファイルが選択されていません。</p>
                    <p id="backup-restore-file-error" class="form-error" aria-live="polite" hidden></p>

                    <p id="backup-restore-file-help">
                        netarium-config形式1（対応元DBスキーマ11〜16）の構成情報ZIPを選択してください。同一メジャー内の同一版・旧版から、保存契約の検証と対応済みの移行を経て復元します。新版から旧版への逆方向復元（同一スキーマを含む）、異なるメジャー、不正な版表記、未対応スキーマや旧画像同梱形式2〜7は非対応です。
                        最大<?= (int)($storageCapacity['backup']['max_zip_bytes'] / (1024 * 1024)) ?>MiB、
                        展開後最大<?= (int)(($storageCapacity['backup']['max_uncompressed_bytes'] ?? (64 * 1024 * 1024)) / (1024 * 1024)) ?>MiB。JSON 2ファイルのみを受け付けます。
                    </p>

                    <button
                        id="backup-restore-preview-btn"
                        type="button"
                        class="btn btn-primary btn-sm"
                        disabled
                    >
                        バックアップを検証
                    </button>
                </section>

                <section
                    id="backup-restore-result"
                    class="backup-restore-result"
                    hidden
                >
                    <h3>検証結果</h3>

                    <p
                        id="backup-restore-capacity-warning"
                        class="backup-restore-capacity-warning"
                        aria-live="polite"
                        hidden
                    ></p>
                    <dl class="backup-restore-information">
                        <div>
                            <dt>ファイル</dt>
                            <dd id="backup-restore-name">-</dd>
                        </div>
                        <div>
                            <dt>作成日時</dt>
                            <dd id="backup-restore-created-at">-</dd>
                        </div>
                        <div>
                            <dt>アプリ版</dt>
                            <dd id="backup-restore-version">-</dd>
                        </div>
                        <div>
                            <dt>有効期限</dt>
                            <dd id="backup-restore-expiry">-</dd>
                        </div>
                    </dl>

                    <div class="backup-restore-summary">
                        <span>
                            ビュー
                            <strong id="backup-restore-views">0</strong>
                        </span>
                        <span>
                            機器
                            <strong id="backup-restore-devices">0</strong>
                        </span>
                        <span>
                            監視状態
                            <strong id="backup-restore-monitor">0</strong>
                        </span>
                        <span>
                            配置
                            <strong id="backup-restore-placements">0</strong>
                        </span>
                        <span>
                            接続
                            <strong id="backup-restore-links">0</strong>
                        </span>
                        <span>
                            接続系統
                            <strong id="backup-restore-link-systems">0</strong>
                        </span>
                        <span>
                            メモ
                            <strong id="backup-restore-notes">0</strong>
                        </span>
                        <span>
                            図面
                            <strong id="backup-restore-floor-plans">0</strong>
                        </span>
                        <span>
                            機器画像
                            <strong id="backup-restore-device-images">0</strong>
                        </span>
                        <span>ラック <strong id="backup-restore-racks">0</strong></span>
                        <span>ラック搭載 <strong id="backup-restore-mounts">0</strong></span>
                    </div>
                    <p id="backup-restore-images" aria-live="polite"></p>
                    <ul id="backup-restore-image-issues"></ul>
                    <p id="backup-restore-rack-removal" class="backup-restore-capacity-warning" role="alert"></p>

                    <label
                        class="backup-restore-confirmation"
                        for="backup-restore-confirmation"
                    >
                        確認のため
                        <strong>バックアップから復元</strong>
                        と入力してください。

                        <input
                            id="backup-restore-confirmation"
                            type="text"
                            autocomplete="off"
                        >
                    </label>
                    <p id="backup-restore-confirmation-error" class="form-error" aria-live="polite" hidden></p>
                </section>
            </div>

            <footer class="placement-manager-footer">
                <p id="backup-restore-message"></p>

                <div>
                    <button
                        type="button"
                        class="btn btn-cancel"
                        id="close-backup-restore-btn-2"
                    >
                        キャンセル
                    </button>

                    <button
                        id="backup-restore-commit-btn"
                        type="button"
                        class="btn btn-danger btn-sm"
                        disabled
                    >
                        復元を実行
                    </button>
                </div>
            </footer>
        </section>
    </div>
