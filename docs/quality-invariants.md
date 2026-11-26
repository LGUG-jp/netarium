# 品質不変条件チェックリスト

変更・レビュー時に、機能横断で崩してはいけない契約を層別に整理した参照文書です。
コンテキスト負荷を抑えるため、**変更ファイルのパスに対応する節だけ**を確認してください。

## 変更パス別ルーティング

| 変更パス | 読む節 |
|---|---|
| `public/js/core/`（`modal-focus.js`・`api-client.js` を除く）, `public/js/canvas/`, `public/js/ui/` | [§1 フロント状態・保存・操作ガード](#1-フロント状態保存操作ガード) |
| `public/js/modals/`, `public/js/core/modal-focus.js`, `public/js/core/api-client.js`, `templates/`, `public/css/` | [§2 モーダル・UI・a11y・HTTP 応答処理](#2-モーダルuia11yhttp-応答処理) |
| `src/`, `public/*.php`, `scripts/` | [§3 PHP API・SQLite・認証・CLI](#3-php-apisqlite認証cli) |
| `public/web.config`, `docker/`, `public/help*.html` | [§4 配備・配信設定](#4-配備配信設定) |

複数の層や責務にまたがる変更（例: 状態更新とモーダル・HTTP 応答処理を両方触る変更）では、該当するすべての節を確認してください。

### 適用基準（3 段階）
- **スキップ**: 文書のみ、誤字・文言修正、テストのみ、軽微な CSS 調整
- **通常チェック**: 上記ルーティングで該当する節だけを差分と照合
- **重点チェック**: 保存・認証・モーダル基盤（`save-queue.js`, `state.js`, `modal-focus.js`, `ApiDispatcher.php`, `DatabaseSchema.php` 等）の横断契約に影響する変更やリリース判定では関連節をすべて確認し、テスト範囲・全件回帰の要否は [開発ガイド（確認の範囲と再実行）](development.md#確認の範囲と再実行) に従う

---

## 1. フロント状態・保存・操作ガード

- **操作前ガードの統一**
  - 管理者操作・キャンバス移動・クリック配置・削除・ビュー配置の入口では、権限（`isCurrentUserAdmin()`）・`appState.authExpired`・`appState.isPinging`・`appState.appStatus?.state === 'unconfirmed'`・対象 `hasResourceConflict()` の確認を落とさない。
  - 保存完了を待つ必要がある操作（完全削除、台帳からのビュー配置、バックアップ／CSV 出力・復元入口など）は `isSaveInFlight()` も確認する。一方、保存中も操作を継続して保存キューへ順次積む設計の編集（接続経路編集や通常の保存キュー投入操作など）には `isSaveInFlight()` を一律に課さない。
  - キャンバス操作系は `appState.noteMode` / `appState.floorPlanAdjustMode` / 配置モードとの排他を確認する。
- **必須イベント購読**
  - ID を保持する画面・下書き・選択・ツールは `resources:ids-remapped` を購読し、仮 ID 保存後に新しい実 ID へ追従する。
  - `resources:reloaded` / `resource:reloaded` で古い入力状態・選択・配置キューをクリアまたは同期する（`source === 'hierarchy-editor'` のように背後画面の強制閉鎖を避けるべき経路は明示分岐する）。
  - ツールバー・一覧・操作ボタンは `auth:expired` / `ping:busy-changed` / `save-state:changed` へ追従し、終了後に `disabled` が固着しないようにする。
- **ID 採番・下書き・保存照合・削除整合**
  - `recalculateNextIds()` / `allocateLocalId()` は `savedBaseline` 等にある未コミット削除済み ID を予約し、削除保留中の ID 再利用を防ぐ。
  - 完全削除確定時は対象の全スコープ（`'panel'` / `'ledger'` / `'sheet'`）のドラフト破棄を忘れず、保存確定応答で不要になった `appState.legacyLinkConflicts` 等も同期除去する。
  - 未確認保存照合（`inspectPendingResourceSave()` / `inspectPendingConnectionSave()`）は PHP の `trim()` 仕様に合わせた `trimPhpText()` を使い、新規追加要素（`id: null` 等）や `operation_busy` 409 を版競合と誤判定しない。
  - 関連ビュー再読込（`reconcileFloorRackReload()` 等）で表示中の図面とサーバー版が一致しない場合、別ビューの保存基準や `resource_revision` を進めない。
  - **意図的契約**: キャンバス／ラックメモの 1,000 コードポイント超過時は `maxLength` による切り捨てを行わず、未確定入力として画面保持しつつ確定済み本文のみを保存対象とする。

---

## 2. モーダル・UI・a11y・HTTP 応答処理

- **モーダルスタックとフォーカス制御**
  - モーダルの開閉は `modal-focus.js`（`registerModalOpen()` / `registerModalClose()`）経由に統一し、`status-bar` 等背面操作の `inert` 隔離（CSS の `z-index` 上書きで覆い隠さない）を保つ。
  - モーダルコンテナ自身からの `Shift+Tab` 脱出抑止、`rAF` フォーカス復帰と連続オープン時の世代競合防止、閉じた `<details>` メニューや別モーダル経由で開いた際の可視起点への復帰を確認する。
- **a11y・スタイル整合**
  - 動的生成する表セル・`<select>`・`<input>`・`<textarea>`・操作ボタンには文脈が分かる `aria-label` を付与する。
  - コンボボックスは `role="combobox"`・`aria-expanded`・`aria-controls`・`aria-activedescendant` を揃え、候補再構築前に古い `aria-activedescendant` を必ず解除する。
  - 閲覧専用画面・項目で `input[readonly]:focus-visible` / `textarea[readonly]:focus-visible` のフォーカスリングを消さない。エラー領域のクラス名・`:empty` 非表示と CSS セレクタの整合を確認する。
- **HTTP 401 / 409 / 保守拒否 404**
  - 通信は原則 `apiFetch()` を使う。生 `fetch()` を使う場合は、`response.json()` 解析前に `response.status === 401` で `handleAuthExpired()` を呼び、`isMaintenanceRejection()` と `login_required` にも対応する。
  - HTTP 409 は `err.details?.reason === 'operation_busy'` を版競合・トークン失効と区別し、一時ビジーでは同じ入力／プレビュートークンで再試行できる状態を保つ。版競合は `recordResourceConflicts()` で対象を登録し、部分再読込での解消を妨げない。
- **UI 状態・フィルタの整合**
  - 完了メッセージ表示後に `refreshUserList()` 等の一覧再取得を行う場合、再取得によるステータス消去やエラー上書きが起きない順序・戻り値設計にする。
  - `setBusy(false)` で個別条件による `disabled` を一律解除しない。ダッシュボード集計と台帳遷移先フィルタ（例：`unknown` と `checking`）の条件を一致させる。

---

## 3. PHP API・SQLite・認証・CLI

- **認証・排他ロック・セッション順序**
  - API 入口はセッション確認（`requireApiSession()`）→ POST 時の CSRF 検証（`requireCsrfToken()`）→ 排他／共有ロック対象アクションでの `OperationGate` 取得 → SQLite ユーザー照会（`requireApiAuthentication()`）の順とし、読み取り専用 GET や対象外アクションに不要な制約を加えず、他処理排他中に SQLite ロック待ちを起こさない。`catch` 時はロールバック・監査終了後にロックを解放する。
  - 画像・図面配信や通常ページで認証後のセッション書込が不要な経路は早期に `session_write_close()` を呼び、並列読込のセッションロック競合を防ぐ。
- **SQLite トランザクションと競合契約**
  - スキーマ移行・初期データ作成・競合検査付き更新は `BEGIN IMMEDIATE` 相当の先行書込ロック保護内で実行する。
  - 一時ロック競合の HTTP 409 には `details.reason = 'operation_busy'`、版競合の HTTP 409 には `details.conflicts` を付与し、クライアントと契約を揃える。
- **書込安全性と入力境界**
  - サムネイル・キャッシュ等のファイル生成は一時ファイルへ書いてからアトミック置換（`rename`）し、0 バイト破損を配信・永続化しない。
  - `Request::decodeJson()` の空オブジェクト `{}`（`stdClass`）は配列期待箇所の 400 誤判定原因になるため境界で正規化する。
  - 既存レガシーデータ（未変更時の旧ラベルや空白差等）の後方互換と新規・変更時の厳格検証を両立させ、CSV 警告や監視リセット判定も確定処理の実比較（`trim` の有無など）と一致させる。
  - 親リソース削除時は関連テーブル（保留行・参照行）の整合削除を漏らさず、コミット後の後処理（画像 GC 等）失敗で全体を HTTP 500 にしない。
  - **意図的契約**: 監査ログの `.security-window` 破損・超過時は自己リセットせず拒否監査を省略する（fail-closed）契約を維持する。
- **CLI・認証・監視**
  - `--storage-dir` 指定可能な CLI は依存パス（`operation_lock_file` 等）も差し替え、ステージング途中の失敗は先行配置ファイルを清掃する。失敗時監査の HTTP ステータスは実例外に合わせる。
  - 認証判定のダミー検証コスト維持・レート制限レコード保持条件、Ping 出力の文字コード判定（UTF-8 先行判定）と失敗パターン漏れを確認する。

---

## 4. 配備・配信設定

- **Web サーバー設定の同期**
  - `public/web.config`（IIS）と `docker/apache.conf`（Apache）の間で、CSP 対象拡張子（`.html` 含む）および CSP 除外対象（`healthcheck.php` 等）を必ず一致させる。
- **セッション寿命の整合**
  - `src/Services/Auth/Session.php` のアイドル上限と `docker/php.ini` の `session.gc_maxlifetime` を整合させ、想定時間より先にサーバー側 GC でセッションが消えないようにする。
- **静的 HTML と CSP**
  - `public/help*.html` 等の静的 HTML にはインライン `style` 属性を書かず外部 CSS へ分離し、`style-src-attr 'none'` を守る。
