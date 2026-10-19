# Netarium テストスイート構成ガイド

Netarium の自動テストは、外部パッケージ（PHPUnit や Jest 等）を必要とせず、各実行基盤の標準機能（PHP 組み込みサーバー + cURL、Node.js 組み込みテストランナー `node:test`、PowerShell）で完全に自己完結して動作します。

---

## 1. 概要と実行方法

### PHP API 回帰テスト
```powershell
php tests/regression_test.php
# または
powershell -ExecutionPolicy Bypass -File scripts/run-tests.ps1
```
一時的な隔離ディレクトリおよび一時 SQLite DB を自動生成し、バックエンド API（Phase 0 基準）の振る舞いを検証します。

<a id="ログインの直接fastcgi並行回帰204"></a>

### ログインの直接FastCGI並行回帰

```powershell
php tests/login-fastcgi.php --php-cgi=C:\php\php-cgi.exe
```

PATHまたは明示した`php-cgi`だけを使い、隔離DBを共有する2プロセスへFastCGI要求を送ります。DELETE／WALの両方で、残り1枠の誤値／正値・成功時解除、照合中の別接続による業務書込み、CSRF不正、予約前／照合後のDB busyと再試行、worker中断による枠保持を検証します。実`password_verify`の直前で停止し、候補やハッシュを記録せずPID・版・SAPI・照合結果だけを観測します。期限後の回復は隔離DBの期限を過去へ設定した条件です。JSONLのPASSと終了コード0が合格、失敗は終了コード1、引数不足は2です。

認証世代の競合試験では、専用の合成利用者の旧パスワード照合を待機させ、実`reset_user_password` APIでハッシュ・世代を更新し、別workerの5回の実ログイン失敗で新ロックを形成します。6回目を拒否した後に旧要求を再開し、ロック行・`last_login_at`の不変、旧要求の失敗監査、未認証状態、7回目も照合前拒否を確認します。単なる直列の旧パスワード要求はこの競合の証拠として扱いません。

このコマンドはIIS構成を変更せず、IIS受入を`NOT_RUN`と報告します。実IISの`maxInstances`・worker到達・OPcache反映・実時間300秒の待機は[開発ガイド（配備の確認）](../docs/development.md#配備スクリプトの確認)で別に判定します。通常のPHP回帰には予約・解除・期限の固定時計試験を含みますが、`php-cgi`が必要な並行回帰は別コマンドです。ポート候補を共有するため、通常のPHP回帰と同時に起動しません。


<a id="停止型完全バックアップ復元cliテスト229"></a>

### 停止型完全バックアップ/復元CLIテスト

```powershell
php tests/full-backup.test.php
```

一時的な隔離ディレクトリで完全バックアップヘルパープロセスのRPC動作を直接検証します。WALスナップショット採取、users/パスワードハッシュ・権限の復元、未参照を含む画像実体の保持、ロック競合排他、およびZIP改ざん・欠損・余分パス・zip-slip・スキーマ/アプリ不一致・破損・展開上限・カウント不一致・整合性異常時の前段拒否と本番DB不変を検証します。

### JavaScript 単体・結合テスト
```powershell
# 全件実行
node --test tests/*.test.mjs

# 特定のテストのみ実行
node --test tests/link-router.test.mjs
```
Node.js 標準の `node:test` ランナーを使用し、フロントエンドの幾何計算・データモデル・軽量 DOM 代替による UI 操作を検証します。

### PowerShell 配備モックテスト
```powershell
# 一般権限で実行可能なモックテスト（3件）
powershell -ExecutionPolicy Bypass -File tests/uninstall-iis.test.ps1
powershell -ExecutionPolicy Bypass -File tests/iis-lifecycle.test.ps1
powershell -ExecutionPolicy Bypass -File tests/full-backup.test.ps1

# 一般権限で PWDB 辞書の fresh/update・欠損/破損拒否だけを実行（IIS/保護 ACL なし）
powershell -NoProfile -ExecutionPolicy Bypass -File tests/setup-iis.test.ps1 -PasswordBlocklistOnly

# ファイル配置・未管理資材／junctionの拒否だけを実行（PHP/IIS/保護ACLなし）
powershell -NoProfile -ExecutionPolicy Bypass -File tests/setup-iis.test.ps1 -ReleaseManifestOnly

# DPAPI実往復と非昇格時の拒否。snapshot作成成功・実ACLの項目は管理者のみ
powershell -ExecutionPolicy Bypass -File tests/snapshot-secrets.test.ps1

# 管理者権限（SeSecurityPrivilege / UAC 昇格）が必要なテスト（6件）
# ※実 Set-Acl と bootstrap 秘密の管理者専用保管、追加辞書専用 ACL を検証します
powershell -ExecutionPolicy Bypass -File tests/setup-iis.test.ps1
powershell -ExecutionPolicy Bypass -File tests/fresh-setup-order.test.ps1
powershell -ExecutionPolicy Bypass -File tests/deployment-rollback.test.ps1
powershell -ExecutionPolicy Bypass -File tests/deployment-acl.test.ps1
powershell -ExecutionPolicy Bypass -File tests/existing-setup-acl.test.ps1
powershell -ExecutionPolicy Bypass -File tests/password-blocklist-cli.test.ps1
```

IIS モックの試験は開発端末でも実行できます。`password-blocklist-cli.test.ps1` は実 IIS の専用 Application Pool・停止サイトを一時作成し、実 NTFS ACL と PHP を検証して終了時に撤去します。ACL を伴う試験には管理者権限が必要です。
---

## 2. PowerShell 配備モックテスト (`tests/*.test.ps1`)

配備スクリプトのモック試験と、実 NTFS ACL・専用 IIS 資材を使う追加辞書 CLI 試験です。実サービスへの更新・rollback の受入とは区別します。

| ファイル | 対象スクリプト | 実行権限 | 主な検証内容 |
| :--- | :--- | :---: | :--- |
| `setup-iis.test.ps1` | `scripts/setup-iis.ps1` | **管理者** (※)。`-PasswordBlocklistOnly`／`-ReleaseManifestOnly` は一般 | fresh の未作成／空 root／既存空 manifest ディレクトリへの正規配置、二重階層の防止、未管理ファイル・隠しファイル・junction の変更前拒否。PHP・INI・Site/Binding・FastCGI のモック検証、bootstrap 秘密の実発行・既存ファイル保全・非漏洩。辞書限定モードでは PWDB の fresh/update 後の全件拒否、標準本文・metadata の欠損／破損時の診断失敗、任意追加辞書の未設定許容と更新時の保持 |
| `uninstall-iis.test.ps1` | `scripts/uninstall-iis.ps1` | 一般 | サイト・プール削除、共用 FastCGI の保護、データ保持・完全削除（`-RemoveData`）のモック検証 |
| `fresh-setup-order.test.ps1` | `scripts/setup-iis.ps1`／`scripts/deployment-common.ps1` | **管理者** (※) | staging検査・配置・IIS構成・秘密発行・公開の順序、秘密生成前の専用ACL。未作成／空root／既存空publicのbootstrap発行後rollback、元の空public・ACL・IIS初期状態と残留物なし、旧snapshotの既存data／外部storageの保全 |
| `existing-setup-acl.test.ps1` | `scripts/setup-iis.ps1` | **管理者** (※) | 既存setupの受付停止・要求排出・Pool停止（Starting/Stopping遷移を含む）、実NTFSのACL書込み失敗／所有者不一致、失敗時停止維持・再開失敗・元の稼働状態とDB／設定本文の保持 |
| `iis-lifecycle.test.ps1` | `scripts/test-iis-lifecycle.ps1` | 一般 | 配備ライフサイクル監査ハーネスの JSON 差分比較・状態判定ロジックの検証 |
| `deployment-rollback.test.ps1` | `scripts/update.ps1`／`scripts/deployment-common.ps1` | **管理者** (※) | 更新失敗時のスナップショットからのファイル・DB 復元、旧 NCSC のみへの復元と PWDB 残置防止、同版 PWDB 資材の欠損・改変からの復元、スナップショットへの追加辞書非混入と保持。既存 Site の location が元は無し／有り／不明の場合の除去・保全 |
| `deployment-acl.test.ps1` | `scripts/deployment-common.ps1` | **管理者** (※) | プログラムの広範な書込除去・既存Read保持、DB/config/sessionの既存明示Read除去、対象Poolだけの必要権限、bootstrap管理専用ACL |
| `snapshot-secrets.test.ps1` | `scripts/deployment-common.ps1` | 一般／管理者 | 実DPAPIの空・ASCII・Unicode秘密の往復と破損拒否、非昇格時の書込前拒否。管理者ではUsers Read親下のsnapshot保護、manifest非漏洩・session除外・復号失敗時のDB不変 |
| `full-backup.test.ps1` | `scripts/full-backup-common.ps1` | 一般 | 完全バックアップ共通関数の単体テスト（UNCパス拒否、リパースポイント拒否、SQLite sidecar検出、容量不足拒否、元状態維持ロジック） |
| `password-blocklist-cli.test.ps1` | `scripts/set-password-blocklist.ps1` | **管理者** (※) | 追加パスワード辞書 CLI の登録・更新・解除（`-Disable`）、構文検証（UTF-8・改行・重複・制御文字・容量・件数の拒否）、兄弟 manifest（`password-blocklist.json`）と本文領域（`password-blocklist/`）のアトミック切替、更新失敗時の有効 manifest 保持、専用 ACL（SYSTEM/Administrators 書込、Pool 読取専用）と継承遮断の検証 |

※ 管理者と記した 6 件は実際の `Set-Acl` を呼び出します（`password-blocklist-cli.test.ps1` は `WebAdministration` モジュールも必要です）。bootstrap 秘密や追加辞書領域は SYSTEM/Administrators 専用 ACL や Pool 専用権限を検査するため、非昇格の環境で保護確認を省略して実行しません。ローカルで一部だけ実行した場合は、全件成功とせず未実施ケースを明記します。

`snapshot-secrets.test.ps1`は非昇格時にsnapshot作成成功・ACL／復元のケースをSKIPと明示します。これを全ケース合格と扱いません。機密領域のDACL／所有者設定はWindowsのAccessControl APIで行い、SACLを書き換えません。別主体の実読取拒否と実IISのPool資格情報復元は[開発ガイド（配備の確認）](../docs/development.md#配備スクリプトの確認)に従って隔離 IIS で確認します。
---

## 3. PHP API 回帰テスト基盤 & スイート (`tests/suites/*.php`)

`tests/TestCase.php`, `tests/TestServer.php`, `tests/TestHttpClient.php` を基盤とし、`tests/regression_test.php` から一括実行されます。

| スイート | 主な検証内容 |
| :--- | :--- |
| `AuthTest.php` | ログインセッション管理、実効storage配下のfiles保存・旧共通session拒否・保存先障害時の非フォールバック・独立worker認証維持、未認証アクセス拒否、viewer権限、CSRF保護、画像入口保護 |
| `InitialSetupTest.php` | bootstrap秘密の必須照合・再発行失効、成功消費・永久閉鎖、登録・監査失敗のrollbackと再試行、別Cookie・独立PHP workerの同時登録 |
| `PasswordHashingTest.php` | Argon2id ハッシュ生成・照合、Unicode/UTF-8 バイト境界、旧 bcrypt 明示移行、生成失敗時の安全停止 |
| `PasswordBlocklistTest.php` | PWDB 適合上位 3,000 値・ASCII 大小文字の全件拒否、全体反復・ユーザー名/製品名の拒否、結合文字・空白・部分一致の許容、PWDB 資材/metadata の欠損・破損・誤型での fail-closed。任意追加辞書の入力構文・上限、兄弟 manifest（`password-blocklist.json`）および本文の欠損・改変・不整合時の fail-closed、未設定時の正常動作、既存 hash 照合維持 |
| `AuthenticationLimitsTest.php` | ログイン失敗と照合枠予約（5枠/300秒・中断消費・成功／期限解除）、長大・不適合ユーザー名の非保存と隔離HTTP／DB容量・応答／監査の非漏えい、再認証制限、パスワードスプレー検知・監査警告 |
| `PasswordPolicyTest.php` | 初回パスワード変更強制（admin/viewer）、管理者再設定、DB スキーマ 9→10 移行、中途失敗時のロールバック |
| `LoadSaveTest.php` | 構成データ（機器・ビュー・配置・リンク）の初期ロード、保存、リビジョン不一致（409 Conflict）競合制御 |
| `ResourceSaveTest.php` | リソース単位（機器/ビュー/系統/メモ）の保存、リソースリビジョン競合、内部仮名衝突回避、バッチ rollback、隔離PHPでmbstring関数不在時のUnicode保存・ロード・ZIP復元（iconv／PCRE経路） |
| `BackupTest.php` | `netarium-config`形式1／スキーマ11のJSON専用ZIP、`BackupCompatibilityPolicy`による`v1.0.0→v1.0.1`および同一版復元・逆方向／未検証版／旧形式2〜7／未知フィールド拒否、構成・手動経路・系統・メモ復元、画像同一性と影響プレビュー・実体非破壊、利用者・セッション・bootstrap保全 |
| `OperationGateTest.php` | バックアップ復元や更新などの高負荷・破壊的操作時の排他ロック（多重実行防止） |
| `CsvTest.php` | 機器台帳 CSV エクスポート、インポートプレビュー/コミット、引用符・改行・日本語・空欄維持、異常系 CSV 拒否 |
| `PingTest.php` | 機器 Ping 疎通確認、ループバック対象、プライベート/パブリック IP 制限、タイムアウト分類、排他ロック |
| `DataQualityTest.php` | データ品質診断（未配置機器、孤立接続、重複 IP/名前等の検知）、保守期限警告 |
| `FloorPlanTest.php` | フロア図面登録、A3 自動縮小変換、EXIF 回転補正、透過 PNG 保持、寸法/容量上限（30MiB/7000px）境界 |
| `DeviceImageTest.php` | 機器写真登録、長辺 2048px 保存用縮小、サムネイル生成、ガベージコレクション（GC）処理 |
| `AuthenticatedImageCacheTest.php` | 原寸・サムネイル・図面の`private, no-store`、旧URLからの版更新、条件付き要求での画像読取、未認証・ログアウト・利用者停止・idle/absolute期限切れ・初回変更制限・エラー応答 |
| `AuditTest.php` | 監査ログ出力（認証、保存、利用者管理、復元等）、容量上限（256MiB）超過時の安全ローテーション |
| `SecurityHeadersTest.php` | 応答単位nonceとHTMLの一致・応答間非再利用、拒否／302のCSP、Report-Only切替、HSTSの明示opt-in・HTTP不送信・0による解除通知 |
| `TransportSecurityTest.php` | 設定の型・範囲、TLS／信頼IP限定XFP・バックエンドTLSとの優先順位、Cookie属性と共存、双方向ID再利用拒否、旧Cookie失効、logout・idle／absolute期限 |
| `CapacityTest.php` | 画像登録の全体108ファイル／200MiB一律上限撤去（任意クォータ）、1機器最大3枚、写真10MiB・図面30MiB境界、Web ZIP独立境界 |
| `BackupAcceptanceTest.php` | 400台×3画像（1,200枚）＋10図面でのWeb ZIP境界・非破壊復元、異環境での誤関連付けゼロ・users保全、障害注入・競合制御、容量分離の統合受入 |

Web 復元の試験では、24MiB／展開後64MiB／2ファイルの境界、スキーマ・アプリ版不一致、初回digest補完、画像欠損・不一致時の参照除外とID表示、全セッション維持を確認対象とします。ここに試験成功の証拠は追記していません。実IIS／実ブラウザでの新プレビューと復元後再読み込みは未確認です。固定仕様は[運用ガイド（復元）](../docs/operations.md#復元)を参照してください。

HTTPS分岐のHTTP試験は専用prependでサーバー変数を合成します。実TLS、IIS／FastCGI、ブラウザのCookie prefix受理・CSP違反・HSTS記憶は[開発ガイド（配備の確認）](../docs/development.md#配備スクリプトの確認)で別に確認します。JavaScriptのテンプレートfixtureは実`registerStaticListeners()`を使い、inlineイベント文字列を評価しません。

---

## 4. JavaScript フロントエンドテスト (`tests/*.test.mjs`)

Node.js 標準の `node:test` を使用。「純粋ロジック（`*-data`）」と「UI・ユーザー操作（`*-ui` や `*-editor`）」、「耐障害性・競合（`*-resilience` / `*-races`）」に責務分離されています。

### リンク・経路計算
- `link-router.test.mjs`: 自動配線ルーター（幾何計算、機器矩形迂回、500/501本探索上限分岐）
- `link-route-resolver.test.mjs`: トポロジ全体のリンク解決、自動経路と手動経路の統合
- `manual-link-route.test.mjs`: 手動経路データ構造（直交化、Uターン保持、端点追従の数学的計算）
- `manual-link-route-edit.test.mjs`: 手動経路の区間ドラッグ、折れ点追加・削除操作
- `link-route-editor.test.mjs`: Canvas 上での経路編集操作と保存キュー・API 連携
- `link-route-data.test.mjs`: リンクのデータモデル、ID 採番、差分抽出、保存用バリデーション
- `link-bulk-data.test.mjs`: 複数リンク一括設定のデータ整合性
- `link-systems-ui.test.mjs`: 接続系統管理モーダルの UI 操作（色変更、作成、削除禁止等）
- `link-crossings.test.mjs`: リンク交差判定、山形ブリッジ/透過ギャップ描画計算
- `link-display-settings.test.mjs`: 配線交差表示設定（bridge/gap 切り替え、localStorage 永続化、ラジオボタン同期）

### キャンバス & 描画・ビュー
- `canvas-view.test.mjs`: Canvas のパン・ズーム、倍率クランプ、中央寄せ、全体 Fit 計算
- `canvas-context-toolbar.test.mjs`: コンテキストツールバーの表示・切り替え、排他制御
- `view-combobox.test.mjs`: ビュー検索コンボボックス（検索、IME 確定、キーボード移動）

### モーダル & UI ナビゲーション
- `modal-stack.test.mjs`: モーダル多重起動時のスタック管理、フォーカストラップ
- `modal-close-ux.test.mjs`: Esc・×・背景クリック時の破棄確認ダイアログ制御、フォーカス復帰
- `modal-staging-close.test.mjs`: モーダル編集中に閉じる際の下書き（staging）保持・破棄境界
- `connection-mode.test.mjs`: 接続作成モード（接続元固定、連続作成、キャンセル）
- `placement-mode.test.mjs`: 機器配置モード（新規スタンプ配置、未配置キュー、ゴースト表示）
- `management-modal.test.mjs`: 管理接続先モーダル、SSH ヘルプダイアログ
- `workspace-navigation.test.mjs`: 左パレット・タブ切り替え、フォーカス移動

### 機器・台帳・編集
- `device-validation.test.mjs`: 機器入力バリデーション（Unicode 文字数、IP、日付）
- `device-type-picker.test.mjs`: 機器種別ピッカー（アイコン選択、キーボード移動）
- `device-bulk-edit.test.mjs`: 機器一括編集（空欄化、共通値、確認画面）
- `device-image-captions.test.mjs`: 機器写真のキャプション編集、文字数制限
- `ledger-view-filter.test.mjs`: 機器台帳のビュー連動フィルター
- `ledger-filter-picker.test.mjs`: 台帳フィルターのドロップダウン操作
- `ledger-review-fixes.test.mjs`: 台帳の表示・横スクロール・sticky 列の回帰検証
- `location-suggestions.test.mjs`: 設置場所・フロアのサジェスト補完

### メモ（付箋）
- `canvas-note-data.test.mjs`: 付箋メモの正規化、データモデル、文字数制限
- `canvas-notes.test.mjs`: Canvas 上の付箋作成、テキスト編集、ドラッグ移動、リサイズ、色変更

### フロア図面
- `floor-plan-editor.test.mjs`: Canvas 上での直接調整（四隅ハンドルドラッグ、アスペクト比固定、キーボード微調整）
- `floor-plan-transition.test.mjs`: 図面調整モードへの移行、Esc 復帰、自動保存・競合処理

### 保存キュー・自動保存・競合
- `auto-save.test.mjs`: 自動保存のデバウンス、確定時の即時 flush、キュー消化
- `save-queue-resilience.test.mjs`: 通信遅延・障害、409 競合時のキュー保持と再試行
- `view-save-races.test.mjs`: 保存処理中のビュー切り替え、未適用入力と確定値の分離
- `device-drafts.test.mjs`: 機器編集の下書き保持
- `ledger-drafts.test.mjs`: 台帳編集の下書き保持
- `property-drafts.test.mjs`: プロパティパネルの下書き保持

### 認証・フォーム
- `auth-forms.test.mjs`: 認証画面のクライアント側バリデーション（Unicode 境界、文字数、エラーフォーカス）
- `form-length-feedback.test.mjs`: フォーム入力の文字数カウント表示・フィードバック

### Ping・品質診断・ダッシュボード
- `ping-result-data.test.mjs`: Ping 結果の集計、CSV シリアライズ、数式エスケープ
- `ping-results-ui.test.mjs`: Ping 結果ダイアログの表示、絞り込み、CSV ダウンロード
- `ping-help-modal.test.mjs`: Ping ヘルプダイアログの開閉・フォーカス
- `data-quality.test.mjs`: データ品質診断モーダルのイシュー表示、修正導線
- `dashboard.test.mjs`: ダッシュボード集計モデル、グラフ・リスト表示

### 印刷
- `print-model.test.mjs`: 印刷用スケール計算、用紙境界判定、スタイルスナップショット
- `print-ui.test.mjs`: 印刷モーダル UI、設定変更とプレビュー即時反映、印刷実行

### その他
- `api-client.test.mjs`: フロントエンド共通 API クライアント（401 認証失効検知、容量エラー 404.13/413 ハンドリング、通信エラー処理）
- `help.test.mjs`: ブラウザ内操作ガイド（目次追従、小見出し自動展開、画像拡大ダイアログ、タブ閉鎖案内）
- `hidden-terminal.test.mjs`: 任意起動の表示専用ターミナル UI（起動、入力制限、閉鎖）
- `hidden-packets.test.mjs`: 表示専用演出（光点アニメーション、Canvas 非干渉、印刷除外）
- `main-init.test.mjs`: アプリケーション起動時の初期化シーケンス
- `palette-images.test.mjs`: 機器写真拡大ダイアログ（前後ナビゲーション、表示順序、端点制御、フォーカス復帰）
- `toast.test.mjs`: 軽量トースト通知（3秒自動消去、二重表示防止）

---

## 5. テストヘルパー (`tests/helpers/`)

- `workspace-dom.mjs`: DOM 代替環境でワークスペース全体の DOM ツリーを構築するヘルパー
- `print-dom.mjs`: 印刷モーダル用の DOM ツリーを構築するヘルパー
