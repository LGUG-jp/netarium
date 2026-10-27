# Netarium開発ガイド

開発環境、変更に応じた確認、回帰テストと性能評価の実行手順です。現在の構造は[アーキテクチャ](architecture.md)を参照してください。

## 必要な環境

- WindowsとIIS（配備確認時）
- PHP 8.5.5以上
- SQLite Library 3.51.3以上
- IIS FastCGI（配備確認時）
- Git

実行時に必要なPHP拡張はREADMEを参照してください。アプリケーションの公開ルートはリポジトリルートではなく`public/`です。

## 開発データ

- 実在の機器名、IPアドレス、シリアル番号、管理番号を使用しないでください。
- 開発用DBは`data/db/data.sqlite`として生成してください。`config/app.php`または`NETARIUM_STORAGE_DIR`で別の隔離領域を指定できます。
- フロア図面には架空または公開可能な画像を使用してください。
- `config/app.php`、`data/`、バックアップ、ログをGitへ追加しないでください。

Gitへ追加しないデータと生成物は、[コントリビューションガイド](../CONTRIBUTING.md)に従います。

## 変更手順

1. [コントリビューションガイド](../CONTRIBUTING.md)に従い、必要な場合は`.github/ISSUE_TEMPLATE`のテンプレートからGitHub Issueを作成します。
2. `main`を最新化します。
3. [コントリビューションガイド](../CONTRIBUTING.md)に従って作業ブランチを作成します。
4. 実装と変更に応じた確認を行います。
5. 文書や変更履歴への影響を反映します。将来の設計や互換性へ影響する判断はPull Requestに理由と制約を記録します。
6. Pull Requestを作成します。関連Issueの記載とレビュー方針は[コントリビューションガイド](../CONTRIBUTING.md)に従います。

## 変更に応じた確認

変更種別に応じて、次の確認を行います。複数の種別に該当する場合は、該当する確認を組み合わせます。実施できない確認や人手による確認が必要な事項がある場合は、その内容と理由をPull Requestへ記載します。

- コードを変更した場合は、変更箇所に対応する動作・回帰を確認します。全件実行のタイミングと再実行の判断は以下の「確認の範囲と再実行」に従います。
- 画面を変更した場合は、人による実ブラウザでの表示・操作・レイアウト・操作感の確認を前提とします。AIによる日常的な実装・修正ではブラウザの起動、UI操作、スクリーンショット取得、Headless Browser（Chromium等）による検証を必須とせず、コードベースの確認（構文確認、差分確認、直接関係するテスト）にとどめ、確認が必要な画面や操作をPull Requestへ未確認事項として引き継ぎます。
- IIS、PHP ランタイム、配備処理・設定を変更した場合は、検証環境で変更した設定と関連する動作を確認します。通常の PHP コード変更だけで毎回 IIS 配備を行うものではありません。配備の統合確認は[配備スクリプトの確認](#配備スクリプトの確認)、公開範囲と初回起動は[配備ガイド](deployment.md)に従います。
- 文書を変更した場合は、参照先、記述、バージョン表記、差分の整合性を確認します。
- 容量制限を変更した場合は、登録、出力、復元の上限直前・一致・超過を合成データで確認し、旧図面・新図面・ZIP・展開物・自動退避の共存容量を確認します。

次は動作に関係する変更で確認対象となる項目です。変更していない領域を一律に手作業で確認する必要はありません。

- PHPファイルの構文エラーがない
- ログイン、ログアウト、セッション期限が動作する
- adminとviewerの権限制御が一致する
- 読み込み、保存、リビジョン競合が動作する
- 機器、ビュー、配置、リンクを保存できる
- Ping、CSV、図面、品質診断が動作する
- バックアップの出力、検証、復元が動作する
- `data/`、`src/`、`templates/`、`config/`、`scripts/`へHTTPで直接アクセスできない

### 確認の範囲と再実行

**通常の機能追加・不具合修正は、変更箇所と直接影響する経路の確認を基本とし、PR 提出や commit のたびの全件回帰は必須にしません。**
全件回帰や実環境での入念な確認は、コア改修、影響が広い変更、影響範囲を特定できない変更、リリース判定に合わせて行います。
変更行数や実行時間だけで検証範囲を決めず、壊れた場合の影響と呼出元・共有処理への波及を判断します。

| 変更区分 | ローカルで行う確認 | 広範囲の検証を行う条件 |
| --- | --- | --- |
| 文書のみ | 差分、記述、リンク・アンカー・コマンド例の整合性 | 実装を変えない限り、動作確認・全件回帰は行わない |
| 通常の機能追加・限定的な不具合修正 | 変更ファイルの構文、直接関係するテスト、対象経路の短い動作確認 | 共有処理への波及や対象外の不具合が判明した場合に範囲を広げる |
| コア改修・広範な変更 | 対象経路と失敗条件を重点確認し、影響する言語・領域の回帰を全件実行 | 無関係な言語・配備環境まで一律に広げず、複数領域へ波及する場合は組み合わせる |
| リリース判定 | 固定した候補で PHP・JavaScript の全件回帰、適用対象の CI、公開前検査を確認 | 実ブラウザ、配備・更新・復元、互換性・性能・セキュリティの必要な受入を[変更履歴](../CHANGELOG.md)に従って確認 |

コアには、認証・認可・セッション、共通 API、DB スキーマ・移行、保存キュー・リビジョン競合・採番、CSV 取込・バックアップ復元によるデータ更新、配備・更新・ロールバック・公開処理、共通状態管理・テスト基盤を含みます。
これらの動作契約を変える場合は通常の表示変更として扱いません。
一方、これらを呼び出す画面の表示だけを変え、保存や権限の契約に影響しない場合は、直接関係する経路の確認から始めます。

通常の変更は、次の順で確認します。

1. 変更箇所の呼出元と依存先を確認し、壊れ得る動作と必要なテストを選びます。起動処理・import・イベント登録を変える場合は起動テストを最初の対象に含めます。
2. 変更ファイルの構文、対象テスト、変更した経路の動作を確認します。画面表示は既存の DOM 代替を利用できますが、実ブラウザの見た目・操作感を検証したとは扱いません。
3. 対象外の失敗や共通基盤への波及が見つかった場合に、関連スイート、必要なら全件へ広げます。PHP の `tests/regression_test.php` と `scripts/run-tests.ps1` はスイート指定に対応していないため、対象確認の代わりに毎回全件を起動せず、既存の個別実行コマンドや隔離環境の対象操作を使います。
4. 選んだ経路の確認が完了したら、安心のためだけに無関係なテストや追加のスモークを重ねません。既存テストで不足する重要な境界・失敗条件や不具合の再発条件には回帰テストを追加しますが、機能追加ごとの恒久テストの件数目標は設けません。

失敗時は、ログから実装・テスト・環境のどこに原因があるかを確認してから対応します。
修正後は失敗したテストと直接影響する周辺を再実行し、コアへの波及がない import 漏れや局所修正だけで全件をやり直しません。
原因を調べず合格するまで再実行したり、期待値の緩和で失敗を消したりしません。

前回合格した関連コード・依存関係・実行環境・データ条件が変わっていなければ、対象コミットと実行範囲を明示して結果を再利用できます。
関連条件が変わった部分や、合格結果のない部分は今回確認します。
ベンチマークは対象処理・計測条件・生成データを変更した場合に、影響するプロファイルを再測定します。
配備変更の統合確認は[配備スクリプトの確認](#配備スクリプトの確認)に従い、途中の局所修正では影響する手順を優先します。

AI の通常作業に実ブラウザの起動、UI 操作、スクリーンショット、Headless Browser の検証は含めず、人による確認が必要な画面・操作を引き継ぎます。
実環境での受入や性能測定を廃止する方針ではなく、必要なタイミングで人または明示的に委任された AI が実施します。

PR または完了報告には、確認した範囲と選定理由、実行コマンド・結果、再利用した結果の対象コミットや CI URL、未実施・未確認の範囲を短く記載します。
通常変更で本方針に従って全件を省略するための個別承認や別帳票は不要です。
未実施を合格扱いせず、実行した CI に失敗があれば原因と対応を確認し、未解決のまま検証完了とはしません。

<a id="ラックビュー機能の短縮確認290"></a>

### ラックビュー機能の短縮確認

ラックビュー機能の開発・修正時は、変更内容に応じて次の短縮コマンドを実行して確認します。

1. **JavaScript レイアウト・UI 検査**:
   `node --test tests/rack-layout.test.mjs tests/rack-depth.test.mjs tests/rack-ui.test.mjs tests/rack-transfer.test.mjs tests/canvas-notes.test.mjs`
   ラックの U 範囲、物理左右、奥行きと反対面占有、移設確認、メモの領域所属、および DOM 状態遷移を確認します。
2. **PHP API の保存・復元検査**:
   `php tests/regression_test.php`
   `ResourceSaveTest` で移行・衝突・移設・競合・通常保存時の搭載保持、`BackupTest` と `BackupAcceptanceTest` で構成変換・事前退避・復元失敗時の非破壊を確認します。
   この入口は PHP 全件回帰です。局所修正後は失敗したメソッドと直接関係する周辺だけを、既存の `TestServer`・`TestHttpClient` を使う隔離 runner で再実行できます。
3. **完全バックアップの隔離移行検査**:
   `php tests/full-backup.test.php`
   元スキーマ 11・12・13 の検証、隔離 DB の 14 への移行、ラック・PC・奥行きの往復、旧契約への PC・depth 混入、未知版・破損 ZIP の拒否とライブデータ保護を確認します。

自動テストで検証できる範囲はデータモデル、API 契約、保存・衝突判定、およびバックアップ移行ロジックに限られます。
実ブラウザでの外見・操作感、IIS FastCGI 環境、Docker 環境での配備・更新、および用紙への物理印刷結果は未確認であり、Pull Request 提出後の人手による受入確認へ引き継ぎます。

### ローカルとCIの役割分担

ローカルは短いフィードバックと変更経路の確認、CI は統一環境での共通検査を担当します。
CI で同じ検証を行う場合は、早期の原因切り分けや環境差の確認が必要な場合を除き、ローカルでの重複実行を必須にしません。

| 検証 | ローカル | 現行の CI |
| --- | --- | --- |
| PHP 構文 | 変更した PHP ファイルを確認。PHP 未変更なら原則不要 | [PHP Syntax Check](../.github/workflows/php-syntax-check.yml) が全 PHP ファイルを確認 |
| PowerShell 構文・文字コード | 変更したスクリプトの構文・ASCII/BOM 条件を確認。未変更なら原則不要 | 同 workflow は `scripts/*.ps1` の ASCII/BOM を検査。PowerShell の構文・動作までは保証しない |
| JavaScript | 通常は対象ファイルを明示したテストと関連する起動・結合確認 | アプリの JavaScript 全件・対象機能のテストを一律に実行する CI はないため、CI 成功だけで代替しない |
| PHP API 回帰 | 通常は対象経路、コア改修・リリース判定は必要な全件回帰 | PHP 構文検査や Docker smoke を PHP API 全件回帰の代わりにしない |
| 公開・リリース安全性 | 公開処理・抽出ルールの変更時は該当テストを実行。無関係な機能変更では重複実行不要 | `Private release safety checks`（開発リポジトリ専用の `.github/workflows/release-check.yml`。公開配布には含めない）が export-public-snapshot / release-sync / release-control / release-finalize の 4 テストファイルを実行 |
| Docker 統合 | Docker・配備・実行環境依存の変更時に必要な経路を確認。通常の画面変更ではローカル再現不要 | [Docker 検証ワークフロー](../.github/workflows/docker-poc.yml) が起動・HTTP・永続化・バックアップ復元・更新などを確認。起動条件と実行範囲は workflow 定義を参照 |

起動条件と実行範囲の正本は workflow 定義です。
PHP Syntax Check と Private release safety checks は `main` への push と `main` 向け PR が対象です。
Docker 検証の起動条件と実行範囲は workflow 定義で確認し、範囲判定コードを使用する構成では、そのコードも確認します。
CI の構成変更はこの方針と分けて扱い、説明だけで検査が削減済みとはみなしません。
ローカルの commit だけでは Actions は起動せず、PR 作成や PR ブランチへの push などに応じて実行されます。
文書変更で CI が起動しても、それを理由にローカルで同じ検査を追加実行しません。
CI に任せた検証は対象コミットと実行結果を確認し、未起動・スキップ・実行中を成功とみなしません。
workflow の変更時はこの表も更新し、検査範囲や起動条件を削減する場合は、その変更の影響を別途検討します。

<a id="github-actionsの固定参照と更新203"></a>

### GitHub Actionsの固定参照と更新

[`php-syntax-check.yml`](../.github/workflows/php-syntax-check.yml)は、`main`へのpushと`main`向けPull RequestでPHP 8.5の全PHPファイルを構文確認します。第三者Actionsの`uses`は40桁のfull commit SHAへ固定し、対応するリリース版をコメントへ記録します。

| Actionの公式配布元 | 採用版 | 固定commit SHA |
| --- | --- | --- |
| [actions/checkout](https://github.com/actions/checkout) | [v4.4.0](https://github.com/actions/checkout/releases/tag/v4.4.0) | [`11d5960a326750d5838078e36cf38b85af677262`](https://github.com/actions/checkout/commit/11d5960a326750d5838078e36cf38b85af677262) |
| [shivammathur/setup-php](https://github.com/shivammathur/setup-php) | [2.40.0](https://github.com/shivammathur/setup-php/releases/tag/2.40.0) | [`eb7c497e18156a6bbabfef1d3a82760b9eda3962`](https://github.com/shivammathur/setup-php/commit/eb7c497e18156a6bbabfef1d3a82760b9eda3962) |

token権限はworkflow全体で`contents: read`だけを指定します。リポジトリのcheckoutに読取りが必要で、PHPのセットアップと`php -l`に書込み権限は不要です。他の指定可能なtoken権限は`none`となり、job単位の権限追加は行いません。これはworkflowの要求権限の明示であり、組織・リポジトリの実効token権限、Ruleset、ブランチ保護の確認や変更を意味しません。

更新時は次の手順で確認します。

1. 上表の公式配布元で正式リリースと変更内容を確認します。Actionの入力、Node.js runtime、runner要件、使用中のイベントへの影響を照合し、メジャー版の変更は必要性を別途判断します。
2. 公式リポジトリのタグを`git ls-remote --tags`で照合します。注釈付きタグはタグオブジェクトのSHAではなく、`^{}`行のcommit SHAを採用します。次は採用版の照合例です。

   ```bash
   git ls-remote --tags https://github.com/actions/checkout.git 'v4.4.0' 'v4.4.0^{}'
   git ls-remote --tags https://github.com/shivammathur/setup-php.git '2.40.0' '2.40.0^{}'
   ```

3. 公式配布元のcommitページでSHAと変更内容を確認し、`uses`のfull SHA、版コメント、上表を同じPull Requestで更新します。mutableなメジャータグだけの参照には戻しません。
4. `contents: read`以外を必要とする処理が増えていないことを確認し、既存の全PHPファイルの構文確認を実行します。実GitHub Actionsでもcheckout、PHPセットアップ、構文確認、後処理の成功を確認し、実行URLと対象コミットをPull Requestへ記録します。PR実行ではhead SHAとcheckoutされたmerge SHAを区別します。ローカルの成功だけを実Actions成功として扱いません。

SHA固定の対象はAction本体です。`ubuntu-latest`のイメージ、PHP 8.5のパッチ版、setup-phpが取得する外部配布物まで固定する変更ではなく、外部依存全体の不変性を保証しません。総合セキュリティ監査とリリース判断は、この workflow の確認と分けて扱います。

<a id="ci-ワークフローの実行範囲と検証段階299"></a>

### CI ワークフローの実行範囲と検証段階

Netarium の継続的インテグレーション（CI）は、変更内容に応じて実行コストと検証深度を分離しています。
すべての変更に対して画一的なコンテナ検証を実行せず、変更経路に応じた段階的検証を実施します。

#### 公開スナップショット検証（Public snapshot check）

公開スナップショットの整合性検査（`.github/workflows/public-snapshot-check.yml`）は、すべての Pull Request および `main` ブランチへの push を契機として自動起動します。
Docker コンテナを起動せず、Node.js 環境で `scripts/export-public-snapshot.mjs` を直接実行します。
このワークフローは、マニフェスト出力先を公開資材ディレクトリ外の一時領域（`RUNNER_TEMP` 配下）へ隔離した上で、公開資材の抽出可能性とマニフェスト整合性を短時間で検証します。

#### Docker CI の段階制御（Docker CI）

Docker 環境の検証（`.github/workflows/docker-poc.yml`）は、すべての Pull Request および手動起動（`workflow_dispatch`）で動作します。
Pull Request では paths フィルターによる事前除外を行わず、全 PR を対象として前段の判定ジョブ（`scope` ジョブ）を起動します。
判定ジョブは `scripts/ci-docker-scope.mjs` を実行し、基底コミット（`base`）と先端コミット（`head`）の共通祖先から PR 側の Git 差分を求めます。
base 側だけの更新は含めず、削除・改名では旧経路も判定します。

判定結果（`mode` 出力）に応じて、後続のコンテナ検証ジョブ（`smoke` ジョブ）の挙動を次の 3 段階に制御します。

- **`none`（コンテナ検証スキップ）**：コンテナ検証ジョブを起動せず、CI 実行を終了します。
- **`smoke`（基本動作スモーク）**：Docker Compose の構文確認、PoC イメージのビルド、PHP 拡張と SQLite バージョンの照合、Linux ping 疎通確認、配備初期化診断、特権 bootstrap 秘密の Volume 外発行、操作ロック検証、HTTP 疎通（404 応答、`nosniff` ヘッダー、ヘルスチェック）、および `tests/docker-poc-http-smoke.sh` による認証付き API 疎通を検証します。
- **`full`（全段検証）**：`smoke` の全検証に加え、SQLite データおよびセッションの永続化確認（コンテナ再作成前後の整合性照合）、停止型完全バックアップの採取と復元、更新・復旧スクリプト（`scripts/docker-update.sh` および `scripts/docker-restore.sh`）による実動作検証、ならびに公開スナップショットからの Docker ビルドを検証します。

変更ファイルと判定モードの対応規則は以下のとおりです。
未知の `src/` 配下のコードは `full` とし、複数区分が混在する場合は `full`、`smoke`、`none` の順で最も上位のモードを選択します。

| 変更対象 | 判定モード | 理由と範囲 |
| --- | --- | --- |
| ドキュメント（`*.md`、`*.markdown`） | `none` | Docker コンテナの実行経路に影響しないため |
| ブラウザ用資材（`public/js/**`、`public/css/**`） | `none` | Docker CI はブラウザ側 JavaScript を実行しないため |
| 一般テスト（`tests/*.test.mjs` のうち下記以外） | `none` | コンテナ検証経路外のフロントエンド単体テストであるため |
| PHP テンプレート（`templates/**/*.php`） | `smoke` | 画面描画用 PHP の構文および基本表示の検証を要するため |
| 監視・品質診断 PHP（`src/Actions/Quality/`、`src/Services/Quality/`、`src/Actions/Monitoring/`、`src/Services/Monitoring/`） | `smoke` | 診断および監視ロジックの動作確認を要するため |
| 一般公開 PHP（`public/*.php` のうち下記コア以外） | `smoke` | 公開画面の基本疎通確認を要するため |
| コアバックエンド PHP（上記以外の `src/**/*.php`、未知の新規コード） | `full` | 認証、DB、データ保存、整合性保護など全体へ影響するため |
| コア公開エントリポイント（`login.php`、`logout.php`、`setup.php`、`api.php`、`image_upload.php`、`floor_plan.php`、`device_image.php`、`healthcheck.php`）および `public/web.config` | `full` | 認証、主要 API、設定受取など基幹経路に該当するため |
| ルート PHP コード（`bootstrap.php` およびルート直下の全 `*.php`） | `full` | アプリケーションの初期化および共通基盤に該当するため |
| Docker・構成・配備資材（`Dockerfile*`、`.dockerignore`、`compose*.yaml`、`docker/**`、`config/**`、`resources/**`、`scripts/**` ※Markdown を除く） | `full` | コンテナ構成、実行環境設定、配備スクリプトの変更であるため |
| CI ワークフロー定義および判定コード（`.github/workflows/docker-poc.yml`、`.github/workflows/public-snapshot-check.yml`、`tests/ci-docker-scope.test.mjs`） | `full` | CI 自身の動作契約および判定精度の検証を要するため |
| Docker・バックアップテスト（`tests/docker-*`、`tests/full-backup*`） | `full` | コンテナ・バックアップの回帰試験に直結するため |

手動実行（`workflow_dispatch`）では入力パラメータを受け付けず、選択したブランチまたはタグに対して常に `full` モードで動作します。
固定したリリース候補コミットに対する最終確認には、この手動実行を用います。

#### その他のワークフローとローカル検証の切り分け

既存の PHP 構文検査ワークフロー（`.github/workflows/php-syntax-check.yml`）および開発リポジトリ専用の安全性検査ワークフロー（`.github/workflows/release-check.yml`）の責務と実行契機は変更していません。

GitHub Actions はアプリケーションの全 JavaScript 単体テスト（`node --test tests/*.test.mjs`）を一括実行する構成にはなっていません。
フロントエンドの単体テストや UI ロジックの検証は、開発者がローカル環境で対象テストを実行して確認します。
CI の合格をもって全 JavaScript テストの合格とは見なしません。

### 機器SVGアイコン

PC を含む9種類の機器アイコンは`public/assets/icons/devices/`で管理し、`public/js/core/constants.js`の`DEVICE_TYPES`から参照します。キャンバス、配置パレット、配置ゴースト、印刷、機器台帳の一覧・個票で同じSVGを使います。ファイル名はハイフン表記へ揃えていますが、保存する種別値の`switch`・`l3_switch`・`ap`は変更しません。ビュー内一覧は引き続き種別を文字で表示します。

共通仕様は次のとおりです。種類を追加するときも、この仕様と既存の種別mappingに合わせてください。

- `viewBox="0 0 64 64"`、`width="64"`、`height="64"`、背景透過。
- 描画は外周からおおむね4単位以上離し、外形の線幅は3、線端と線の接合は丸める。
- 筐体の角丸は4を基本とし、縦長ラックは5、内部の区画は1〜2とする。
- 同系色の明るい面と濃い輪郭、白い主要記号を基本とし、グラデーション、影、文字要素、外部依存は使わない。L3SWの数字「3」はフォントに依存しないパスで描く。
- ポート数や模様は実機を再現せず、縮小表示で残したい主要記号に絞る。
- 本体色は種別専用とし、固定の状態LEDは描かない。Pingは既存UIのアイコン外枠と状態テキスト、選択は機器カードの外枠で示す。

| 種別 / ファイル名 | 配色 | 主な識別要素 |
| --- | --- | --- |
| `l2-switch.svg` | 青 | 横長筐体とポート列 |
| `l3-switch.svg` | 青緑 | L2と共通の筐体とポート列、右端から張り出す白い六角形内の数字「3」 |
| `router.svg` | 緑 | 円筒筐体と四方向矢印 |
| `firewall.svg` | 赤 | 横長筐体と前面の盾 |
| `access-point.svg` | オレンジ | 円盤筐体と上方の電波記号 |
| `server.svg` | 紫 | 縦長ラックと三段のドライブ |
| `printer.svg` | 黄橙 | 給紙用紙、筐体、排紙用紙 |
| `pc.svg` | 青紫と水色 | 正面向きノートPCの画面とキーボード |
| `other.svg` | グレー | 横長筐体と丸・四角・菱形の接続記号 |

変更時は9種類のXML、サイズ、参照先、外部依存の有無と、状態クラスがSVG本体を変更しないことを確認します。実画面では人が9種類を並べ、配置パレットの32px表示、キャンバスのUI 100%（内部倍率0.5）とUI 50%、多数配置、白・淡色・暗色の背景、選択・hover・Ping正常／異常／未確認の組合せを確認してください。キャンバスのSVG指定サイズは36pxで、UI 100%での表示は18px相当です。色味、種別の判別性、状態表示との見分けやすさは、構文チェックや自動テストだけでは判定できません。

<a id="操作用ブランドsvg資産124125"></a>

### 操作用・ブランドSVG資産

`public/assets/icons/`配下の分類は`brand/`（ブランド5種）、`devices/`（PC を含む機器9種）、`toolbar/`（左作業パレット8種）、`app/`（上部操作7種）の4つです。PNG原案は画面用資産に使いません。追加するときもこの分類へ配置し、同じ意味のアイコンは画面ごとに複製せず再利用してください。

| 用途 | ファイル（icons/からの相対パス） | viewBox |
| --- | --- | --- |
| 左ツール8種 | `toolbar/select.svg`、`toolbar/place.svg`、`toolbar/link.svg`、`toolbar/ping.svg`、`toolbar/list.svg`、`toolbar/floor-plan.svg`、`toolbar/memo.svg`、`toolbar/print.svg` | `0 0 64 64` |
| 上部操作7種 | `app/dashboard.svg`、`app/inventory.svg`、`app/refresh.svg`、`app/save.svg`、`app/help.svg`、`app/admin.svg`、`app/user.svg` | `0 0 64 64` |
| 横組み正式ロゴ | `brand/netarium-logo.svg` | `0 0 254 64` |
| フルカラーNode N | `brand/netarium-mark.svg` | `0 0 64 64` |
| favicon・16〜32px用の専用Node N | `brand/netarium-mark-compact.svg` | `0 0 64 64` |
| 単色Node N | `brand/netarium-mark-mono.svg` | `0 0 64 64` |
| 単色横組みロゴ | `brand/netarium-logo-mono.svg` | `0 0 254 64` |

操作用15種は64×64・透過背景とし、原案の主要シルエットを残して影・グラデーション・固定LEDを省いています。外形は線幅3と丸い線端・接合を基本に、主要記号を大きく描いています。配色済みのSVGなので、画面へ適用するときはhover・active・disabledの背景・外枠・不透明度との組合せを確認してください。`currentColor`による単色化は行っていません。

各画面は外部SVGを`<img>`で参照し、既存のページ相対URLを維持しています。上部操作と左作業パレットは装飾画像（`alt=""`・`aria-hidden="true"`）に置換し、操作のラベル・`title`・ARIA属性・既存の状態表示を維持します。正式ロゴは上部ヘッダー、ログイン、初期設定、利用ガイドのサービス名へ適用し、代替テキストを`Netarium`としています。同じ4画面の`<link rel="icon" type="image/svg+xml" sizes="any">`はCompactを参照します。単体マークと単色2種もブランド資産として保持し、favicon専用の重複SVGは追加しません。

画像枠は上部操作20px、左作業パレット22px、機器台帳24pxです。左作業パレットは既存の最小高さ48pxを維持し、22pxの画像・14pxのラベル（line-height 1.1）・2pxの間隔・上下4pxの余白を収めます。ロゴはヘッダー24px、ログイン・初期設定・利用ガイド32pxの高さで配置しています。ヘッダーは既存の縮退基準に合わせ、画面幅1150px以下で`<picture>`の画像を24×24pxのCompact Node Nへ切り替え、バージョンを非表示にします。1150pxを超えると横組みロゴとバージョンを表示します。画像要素は1つとし、どちらの場合も代替テキストは`Netarium`です。ボタンと領域の配置・並び順、ビュー切替・機器検索の処理は変更しません。

ブランド5種はブランドロゴ参考PNGを基に再構成しています。フルカラー版は濃紺`#0B2A6B`の輪郭と、左上Green・右上Orange・右下Blue/Cyan・左下Purpleの配置を維持します。濃紺の下地に線とノードの色面を重ね、輪郭はN全体の外周に残し、丸と線の接合部には濃紺の境界を描きません。斜線はGreen→Cyan系の線形グラデーション、ノードは左上からの控えめな放射グラデーション、縦線は淡い線形グラデーションとしています。各グラデーションは2-stopだけとし、影・glow・filter・mask・clipPathは使いません。

グラデーションIDは`netarium-mark-`、`netarium-logo-`、`netarium-compact-`の接頭辞で区別しています。今回の画面適用では外部SVGを再利用し、インライン化・sprite化・CSS mask化は行いません。

横組みロゴはNode Nを頭文字Nとして扱い、続く「etarium」をフォントに依存しないパスで描いています。原案に近いMarkと文字の比率になるよう、Node Nは単体版と同じ100%の倍率へ戻し、文字は字形を変えず85%の倍率で配置しています。文字の下端は58、eとの輪郭間隔はフルカラー版4.75・単色版6.5単位です。フルカラー版の外周輪郭は片側2.25単位です。正式版・単色版の文字と配置は共通です。自然な単語として読めるかは人による確認が必要です。

CompactはFull版の単純縮小ではありません。ノード中心を15/49から14/50へ広げ、ノード外径を22、線の外幅を12・色面の幅を8としています。原案と同じ淡い縦線、Green→Cyan系の斜線、4色のノードを残し、輪郭はN全体の外周にだけ描きます。ノードと斜線は2-stopのグラデーション、縦線は淡い単色です。16px相当ではノード外径5.5px・隣接ノード間の余白3.5px・縦線と斜線の色面幅2pxを確保します。faviconにもCompact版を再利用し、専用の重複SVGは作成しません。

単色版は`currentColor`で塗りと線を揃えています。原案の丸と線の比率に寄せ、ノード径21、縦線幅8・長さ11.5、斜線幅9とし、ノードとの境界には細い透過の隙間を残しています。SVG内部に適用する色で濃紺・白などを切り替えます。外部SVGを`<img>`で表示する場合、親要素の`color`はSVG内部へそのまま継承されません。

実ブラウザーでは、上部ヘッダー・左作業パレットの実寸と狭幅、白・淡色・暗色背景、hover・active・disabled、配置・キャンバス・機器台帳の8種の判別性、台帳の種別編集、各画面の正式ロゴの可読性とfavicon、実際のサブパス配備を確認してください。構造・HTTP配信・DOM代替の確認だけで可読性や実レイアウトを保証するものではありません。

<a id="キャンバスの印刷の確認118"></a>

### キャンバスの印刷の確認

`tests/print-model.test.mjs`は8種フィルタと端点整合、別ビューの除外、ON要素によるbounds、floor図面優先、pan/zoomの逆変換、IP省略時の中心維持、手動経路・bridge/gap、独立snapshotと機密情報の除外を確認します。`tests/print-ui.test.mjs`は実PHPテンプレートから組み立てたDOM代替で、viewer、設定とプレビューの同時表示、各設定・一括選択／解除の自動反映、入力フォーカス維持、取消・Esc、選択とmode・pan/zoom・保存状態の不変、配線とラベルの依存、画像準備待ち・失敗からの復帰・閉鎖後の遅延完了・連続変更時の世代制御を確認します。

```powershell
node --test tests/print-model.test.mjs tests/print-ui.test.mjs tests/main-init.test.mjs tests/modal-stack.test.mjs tests/canvas-notes.test.mjs tests/link-route-editor.test.mjs
```

印刷CSSは独立DOMだけを印刷対象にし、用紙寸法を固定せず向きを指定する構造をコードで確認します。CSSの実描画・改ページ・SVGの紙／PDF出力はDOM代替では判定できません。人が実ブラウザーで広いモーダルの左右配置、13pxの設定文字・12pxの説明の可読性、設定とプレビューの連動、主操作の青塗り・補助操作の青枠・取消と解除の中立色、チェック／無効表示、Tab・Esc・フォーカス復帰を確認してください。850px以下の上下配置とスクロールも確認対象です。

紙／PDFでは論理構成図・フロア配置図、全体／現在範囲、8種フィルタ、IP ON/OFF、長い機器名、図面画像と背景グラフィック設定のON/OFF、メモ装飾、ラベル、手動経路とbridge/gap、自動／横／縦、異なる用紙サイズでの1ページ収まり・文字の可読性・通常UIの除外を確認します。印刷取消後も元の選択・mode・pan/zoomが維持されることを確認してください。IIS配備・性能測定はこのスモークの対象外です。

<a id="キャンバスメモの確認113"></a>

### キャンバスメモの確認

`tests/canvas-notes.test.mjs`はDOM代替で作成直後の入力、本文確定、保存応答中の下書き保持、pan/zoom中の移動、非負座標・サイズ制限、pointerupだけの確定、pointercancelの破棄、装飾preview、入力中のショートカット除外、モード排他、削除確認、viewer、409、メモを含む全体表示を確認します。`canvas-note-data.test.mjs`は本文・数値・色の検証、保存snapshotの独立性とID採番を確認します。共通キューの追加入力、応答喪失、独立ビュー保存・再読込は`save-queue-resilience.test.mjs`、複製・切替・削除は`view-save-races.test.mjs`で確認します。

```powershell
node --test tests/canvas-notes.test.mjs tests/canvas-note-data.test.mjs tests/save-queue-resilience.test.mjs tests/view-save-races.test.mjs tests/canvas-view.test.mjs
php tests/regression_test.php
```

PHP回帰ではスキーマ7→8の移行と所属ビューのトリガー、全体／ビュー保存、採番・cascade、同一ビュー409・別ビューの独立性、viewerの保存拒否、不正値を含むbatch rollbackを確認します。現行バックアップは形式6／スキーマ9の本文・座標・サイズ・装飾の往復と、旧形式2〜4のメモ空配列補完を確認します。復元後の再ログインでスキーマの再作成が起きないことも既存の復元シナリオで確認します。

レビュー回帰として、全体保存のメモ省略・null・不正型を400で拒否し、既存本文・ビュー・revisionを維持することを確認します。本文入力はDOM代替で補助平面文字1000文字の保存、1001文字の非送信・保持、上限以内への修正後の再保存を確認します。

<a id="キャンバスコンテキストツールバーの確認112-phase-a"></a>

### キャンバス・コンテキストツールバーの確認

`tests/canvas-context-toolbar.test.mjs`はcontext切替・終了通知の排他性、不明なcontextで編集中の状態を失わないこと、図面調整のESCと取消の違い、図面全体表示、保存成功時の終了と取消基準の更新、409時の編集保持、状態クリア、viewerの編集拒否、ツールバー上の操作による誤配置・選択解除・パンの防止を確認します。保存応答後の画面状態は合成応答で確認し、API・DBの図面保存と競合はPHP回帰テストで確認します。

```powershell
node --test tests/canvas-context-toolbar.test.mjs tests/canvas-view.test.mjs tests/placement-mode.test.mjs tests/main-init.test.mjs tests/modal-stack.test.mjs
```

図面調整では、PHPで生成した実ツールバーテンプレートを使ったDOM代替操作で、「保存」「取消」とESCによる終了を実行しました。右下の「全体」と同じハンドラーによる図面Fitと調整モードの維持、ESC終了時の位置保持、取消時の開始設定への復帰、合成API応答による保存・終了とフォーカス復帰を確認しています。実テンプレートが保存・取消の2ボタン構成で、常設説明を含まないことも確認しています。ブラウザによるCSSの描画確認ではありません。

人による実画面確認では、図面調整ツールバーのモード名・保存・取消が1段に並び、常設説明と重複する全体表示ボタンがないこと、上下余白、青の保存ボタン・赤枠の取消ボタン、hover・disabledの表示を確認してください。幅320px程度では、ボタンが縦に折り返さず、必要なら横スクロールできること、Tabによる各ボタンへの移動とフォーカス枠が見切れないことを確認します。右下の「全体」で調整中の図面を表示範囲に収め、「保存」「取消」を操作してください。ESCは座標変更を保持して管理画面へ戻り、取消は開始時の設定へ戻ること、終了後のフォーカスが非表示ツールバーへ残らないことも確認します。図面ドラッグの操作感と、ツールバー操作で機器配置・選択解除・パンが起きないことも確認対象です。

<a id="手動経路データの確認112-phase-b"></a>

### 手動経路データの確認

`tests/link-route-data.test.mjs`は旧リンクのauto補完、最大8点・9点拒否、不正な型・非有限座標・斜線の拒否、経路変更のview dirty判定、保存snapshotと応答待ちの追加入力、競合再読込を確認します。保存データの重複点・同一直線上の点は削りません。描画時の正規化はPhase Cのテストで確認します。

```powershell
node --test tests/link-route-data.test.mjs
php tests/regression_test.php
```

PHP回帰では、全体保存とview保存の経路往復、不正経路を含むbatchの全件rollback、古いview世代の409、スキーマ6→7の既存リンク保持、経路列変更によるview世代更新を確認します。バックアップは形式4／スキーマ7の手動経路往復と、旧形式2／スキーマ5・旧形式3／スキーマ6のauto補完、不正経路・未知列・版の不整合の拒否を確認します。IISへの更新・ロールバック・実画面の確認は別途必要です。

<a id="手動経路の生成描画の確認112-phase-c"></a>

### 手動経路の生成・描画の確認

`tests/manual-link-route.test.mjs`は0・1・2・4・8点、9点拒否、厳密な重複・共線点整理、折り返し・微小な折れの保持、片端・両端移動と寸法変更後の接続、端点一致、最大8折れ、入力不変を確認します。`tests/link-route-resolver.test.mjs`は旧autoの互換性、auto/manual混在、manual→auto、配置移動、不正manualだけのフォールバック、配置欠落、501件の高密度経路を確認します。有限座標`1e20`によるセル走査の停止再発は、監視付きの子プロセスで検出します。

`tests/link-crossings.test.mjs`では、混在する多段manual経路へbridge/gapを適用し、機器移動後の交差位置・経路全長のラベル位置・入力不変も確認します。描画処理のスモークはDOM代替環境で実際の`renderLinks`を呼び、完全hit経路、hover解除後の選択強調、クリックによる右パネル表示、viewer表示とdirty不変を確認します。これはブラウザによる表示・操作感の確認を代替しません。

```powershell
node --test tests/manual-link-route.test.mjs tests/link-route-resolver.test.mjs tests/link-router.test.mjs tests/link-crossings.test.mjs tests/link-display-settings.test.mjs
```

人による確認では、保存済み手動経路の多段表示、機器移動・寸法変更後の端点と内部経路、bridge/gap、hover・選択・クリック・Delete・ラベルを確認してください。

<a id="手動経路の編集確認112-phase-d"></a>

### 手動経路の編集確認

`tests/manual-link-route-edit.test.mjs`は水平・垂直の拘束、機器端点の固定、直線からのU字、多段への段差追加、部分削除、必要最小のL字、6・8点境界、非有限値・overflow拒否、微小折れと折り返し、入力不変と保存後のgeometry再現を確認します。`tests/link-route-editor.test.mjs`はDOM代替操作から実際の保存キューを使い、pointermoveの非保存、pointerup確定、ドラッグ中の拡縮・パン、保存中の追加編集、ID再採番、preview取消、context排他、floorビュー、capture失敗・別pointer、409・viewer・権限失効を確認します。右パネルの自動経路についても、auto時の無効化、調整開始後・終了後のmanualからの復帰、確認取消、preview破棄、操作制限と保存内容を確認します。保存応答は合成データです。

```powershell
node --test tests/manual-link-route-edit.test.mjs tests/link-route-editor.test.mjs tests/canvas-context-toolbar.test.mjs tests/property-drafts.test.mjs tests/view-save-races.test.mjs tests/main-init.test.mjs
```

人による接続情報の表示確認では、ラベル・系統・VLAN・接続元・入れ替え・接続先・経路・備考の順、系統selectorのswatchと名称、各端点枠内の機器名・IPアドレス・ポート、入れ替えボタンの中央配置、経路見出しと等幅3操作を確認してください。長い機器名やIPアドレス、幅320px程度での表示、Tab順とフォーカス、入れ替え後の入力エラー位置も確認対象です。

実ブラウザは未確認です。人が論理構成図・フロア配置図で区間の掴みやすさ、ドラッグの方向・拡縮時の追従、直線→2折れ→多段→部分削除、機器移動後の折り返しの復旧、bridge/gapを保った選択表示を確認してください。右パネルの3操作が等幅・等間隔で「自動経路」を中央に配置することと、有効・無効表示を確認します。フローティングの状態表示・自動復帰ボタンがないこと、追加の青枠・削除の赤枠・完了の青塗りとhover・disabledの表示も確認します。幅320px程度での右パネルの3列配置・文字の見切れ、ツールバーの折り返し、ミニヘルプの寸法・本文スクロール・開閉、Tab・矢印キーとDADSフォーカス表示、ESC／完了後のフォーカス、図面調整との切替、既存図面の保存・取消も確認対象です。UI性能・IIS受入確認をこのスモークで代替しません。

<a id="手動経路の保存競合確認112-phase-e"></a>

### 手動経路の保存・競合確認

`tests/link-route-editor.test.mjs`に、応答待ちの連続ドラッグ・矢印キーによる最新経路への集約、同じ待機中のmanual→auto復帰、409時の最新確定経路の保留とpreview破棄、独立ビューの保存、既存再読込ボタンの確認取消・実行・編集再開を確認する回帰ケースを追加しています。送信snapshotを後続編集で変更しないこと、旧応答のビュー世代を使うこと、再読込した経路を重複送信しないことも確認します。

```powershell
node --test tests/link-route-editor.test.mjs tests/link-route-data.test.mjs tests/save-queue-resilience.test.mjs tests/auto-save.test.mjs tests/view-save-races.test.mjs tests/property-drafts.test.mjs tests/main-init.test.mjs
```

実テンプレートを使ったDOM代替スモークでは、隔離したPHP API・SQLiteへ実際に接続し、開始・連続ドラッグ・キー操作・折れ追加／削除・auto復帰を保存しました。`pointermove`での送信0件、応答待ちの3回の確定を初回保存と最新経路の計2要求へ集約すること、API応答のビュー世代を次の要求へ使うこと、DBから読み直した経路と未適用属性の分離を確認しています。別セッションで同じビューを更新した後の409、ローカルの確定経路保持・preview破棄、独立ビューの保存、既存ボタンからの対象再読込も実行しました。viewerのload成功と保存済みmanual経路の読取、編集操作からの保存要求0件、実APIの保存403を確認しています。検証用サーバーは終了しました。

ブラウザ描画・IIS・性能測定は未確認です。人による確認では、遅い保存中の連続操作、同じビューを2画面で編集した場合の競合表示・操作制限・対象再読込、別ビューの変更保持、viewerでの手動経路表示と編集操作の非表示を確認してください。

<a id="手動経路の最終回帰112-phase-f"></a>

### 手動経路の最終回帰

`tests/link-crossings.test.mjs`はauto/manual混在に加え、manual同士の3交差をbridge/gapの両方式で確認します。保存上限8点に含まれる重複・共線点を描画時だけ整理し、折り返し、方向反転、両端移動、低ID線の維持、入力順の不変を確認します。500件では3区間の240交差を描画し、501件では各区間8候補以下へ制限します。両方式の交差境界とラベル位置は一致し、保存データを変更しません。

`tests/link-route-editor.test.mjs`では実際の`renderLinks`を使い、多段manualの全長ラベル、切れ目を含めて選択できる完全hit経路、hover終了後の選択強調、端点を固定したpreviewと取消、viewerの表示・接続情報の閲覧・編集拒否を確認します。表示方式変更やこれらの操作で保存要求を出さないことも確認します。

```powershell
node --test tests/link-crossings.test.mjs tests/link-route-editor.test.mjs tests/manual-link-route.test.mjs tests/link-route-resolver.test.mjs tests/manual-link-route-edit.test.mjs
```

人による多段経路の使いやすさ、狭幅・キーボード・図面上の操作、bridge/gapの視認性、IISの配備・更新・ロールバック、性能測定はPRの未確認事項として引き継ぎます。

<a id="配線経路交差表示の確認83"></a>

### 配線経路・交差表示の確認

`tests/link-router.test.mjs`はL2SWと複数APの縦横配置、同じ機器対の多重リンク、部分共有、近接平行線、機器密集、移動、501件以上の高速経路を合成データで再現します。`tests/link-crossings.test.mjs`は山形ブリッジと透過切れ目の双方について、直交・斜め・折れ点の交差、逆向き、共有端点、近接交差の結合、短区間、ラベル移動、入力順の安定性、500件超の評価上限を確認します。`tests/link-display-settings.test.mjs`はブラウザー側設定の保持、未使用・読込／保存失敗時のフォールバック、構成データ・保存状態の不変を確認します。

```powershell
node --test tests/link-router.test.mjs tests/link-crossings.test.mjs tests/link-display-settings.test.mjs
node scripts/benchmark-link-routing.mjs
```

ベンチマークは実描画と同じresolverを使い、全リンクautoの100配置・200リンクと、2,000配置・5,000リンクの疎／密配置を、ウォームアップ1回＋5回で計測します。経路計算と交差表示計算の中央値・最大値を分けて出力します。DOM生成、ブラウザ描画、ドラッグ追従時間は含まないため、画面性能の受入確認を代替しません。他のテストや重い処理を並行実行せず、同じ端末・合成データで比較してください。




人による実画面確認では、次をPull Requestの未確認事項として引き継ぎます。

- L2SWの片側にAPを5台、接続先の高さを変えて並べる。縦横を入れ替えた配置でも、スイッチから伸びる共通幹線と長い平行線を追えること。テストの横配置はSW `(0, 300)`、APのxを`600`、yを`0 / 180 / 360 / 540 / 720`としています。
- 配線を縦横・斜めに交差させ、「管理 > 表示設定」で山形ブリッジ／切れ目（透過）を選ぶこと。admin・viewerの双方で即時反映され、再読み込み後も方式が維持されること。両方式で交差の優先順位が同じで、図面画像を背景色で隠さないこと。
- 重なる配線のhover・選択で選んだ交差表現を維持し、hover解除で選択中の強調へ戻ること。山・切れ目の部分からリンク詳細を開け、選択・編集・Delete、ラベル表示・位置調整の既存操作が変わらないこと。
- UI 100%・50%・拡大時の山／切れ目の大きさ、縁取り、平行間隔、長いラベルの読みやすさ、設定画面の分かりやすさを確認すること。座標上の24単位間隔は画面上の24pxを保証しません。
- 同じ表示設定で接続関係の強調を ON にし、単一選択・別機器への選択変更・接続 0 件・複数選択・範囲選択・選択解除・ビュー切替・パネル閉鎖を確認すること。強調の設定は維持し、現在ビューの直接接続先だけを対象とすること。半透明の機器・接続もクリック・hover でき、系統色・Ping 状態・手動経路・ドラッグ・接続作成・印刷を妨げないこと。admin・viewer 双方で、再読み込み後の復元と交差設定との独立保存を確認すること。
- 機器移動で経路が更新され、位置を変えない再描画では経路が変わらないこと。密集配置や500リンク超では重なり・ブリッジの省略が残る条件も確認すること。

<a id="ビュー検索切替の確認116"></a>

### ビュー検索・切替の確認

`tests/view-combobox.test.mjs`は名称・施設・フロア・種別と複数語の検索、全角・半角と英字大小の正規化、表示順、0件、矢印キー・Enter・Esc、IME確定、ARIA状態、未選択時と選択拒否時の現在名復元、再読込・名称変更・削除への同期を確認します。`tests/view-save-races.test.mjs`では実際のコンボボックス操作を既存の`switchView`へ通し、機器・配線パネルの未適用入力を保持する取消と、破棄後の切替を確認します。

```powershell
node --test tests/view-combobox.test.mjs tests/view-save-races.test.mjs tests/main-init.test.mjs tests/placement-mode.test.mjs tests/canvas-context-toolbar.test.mjs tests/link-route-editor.test.mjs
```

人による実画面確認では、20件以上のビューで名称・施設・フロア・種別検索、候補の情報量、現在ビューの識別、内部スクロール、マウスとキーボードでの切替を確認してください。1366pxと狭幅での入力幅・他のツールバー要素との干渉・長い名称の省略・候補の画面内表示・フォーカス枠も確認対象です。DOM代替操作はブラウザによるCSS描画や操作感の確認を代替しません。

<a id="一時通知の確認115"></a>

### 一時通知の確認

`tests/toast.test.mjs`は軽量通知の置換・3秒後の本文/title消去、保存状態の不変、警告/エラーの表示時間とARIA、別領域へ同一文言を出し直した場合の二重表示防止、認証失効の永続バナーと保存禁止を確認します。

```powershell
node --test tests/toast.test.mjs tests/auto-save.test.mjs tests/property-drafts.test.mjs tests/view-save-races.test.mjs tests/placement-mode.test.mjs tests/canvas-context-toolbar.test.mjs tests/management-modal.test.mjs tests/main-init.test.mjs
```

人による実画面確認では、通常操作の通知頻度、下部中央の警告/エラーの視認性、ステータスバー中央の省略/titleと右側の保存状態、認証失効バナーを確認してください。幅320px程度を含む狭幅、長文の折り返し/スクロール、右下ズーム操作・左右パネル・モーダルとの重なり、上部コンテキストツールバーへの非干渉、スクリーンリーダーの読み上げも確認対象です。表示時間で消える通知だけを復旧手順の根拠にせず、保存状態と画面内のエラーを確認します。

## 想定規模・性能基準・評価手順

### 1. 想定規模プロファイル

Netariumの現行データ構造（全構成の一括load、通常編集のリソース単位保存）において、運用上の目安となるプロファイルおよび境界条件を以下のように定めます。安全上限（`src/Core/Config.php`で定義されるビュー100件、1ビュー配置2,000件・リンク5,000件、写真保存1枚10MiB・1機器3枚、図面保存1枚10MiB・100枚、Ping 100件）は維持し、画像全体の件数・総量は無制限（任意クォータ時のみ制限）とします。推奨値は配備先での評価・承認前の暫定運用目安であり、登録可能量の保証ではありません。

- **推奨プロファイル（日常運用の目安）**:
  - 機器: 500台
  - ビュー: 10件（うち floor ビュー 5件、topology ビュー 5件）
  - 総配置: 1,000件（1ビューあたり最大100件、機器はビュー間で再使用）
  - 総リンク: 2,000件（1ビューあたり最大200件、同一ビュー内の異なる機器を結ぶ有効データ）
  - 図面画像: 5枚（計20MiB）
  - 同時利用条件: 閲覧3者・編集1者
- **上限近傍プロファイル（配備・リソース限界の確認）**:
  - 機器: 5,000台
  - ビュー: 100件（うち floor ビュー 40件、topology ビュー 60件）
  - 配置・リンク: 最も密な1ビューに配置2,000件・リンク5,000件、他99ビューに各配置10件・リンク20件（総配置2,990件、総リンク6,980件）
  - 図面画像: 40枚（計80MiB）
  - 同時利用条件: 閲覧5者・編集2者
- **画像容量境界プロファイル（ストレージ・ZIP限界の検証）**:
  - ビュー: 100件（すべて floor ビュー）
  - 図面画像: 100枚（各2MiB〜10MiB）
  - 写真画像: 機器あたり最大3枚（400台×3枚=1,200枚、各1MiB〜10MiB）
  - 画像保存の108ファイル・200MiB一律上限は撤去され、400台×3枚＋図面の登録に対応します。Web ZIPは画像実体を含めないため画像圧縮率と切り離し、ZIP24MiB・展開後64MiB・JSON2ファイルの境界を独立に検証します。

### 2. 評価指標と暫定目標値

同一端末・同一データを用いて「ウォームアップ1回＋5回本測定」を行い、中央値、最大値、成功率、HTTP応答サイズ、PHP各要求のピークメモリ、ブラウザJS heap、Long Taskを記録します。

| 対象操作 | 暫定目標値（推奨規模） | 備考 |
|---|---|---|
| API `load` | 3.0秒以内 | 初期表示・ビュー切替データ取得 |
| API `save_resources` / 全体操作`save` | 5.0秒以内 | 変更リソース／全体構成の保存と世代更新。既存の計測スクリプトは全体`save`を測定 |
| クイック検索 | 入力完了から描画完了まで 300ms 以内 | ツールバー検索インクリメンタル反映 |
| 台帳モーダル検索 | 入力完了から描画完了まで 300ms 以内 | 機器台帳一覧フィルタリング |
| ドラッグ中描画 | pointermove→次フレーム描画 p95 50ms 以内 | 機器配置移動時の追従性 |
| 1ビュー全リンク経路再計算 | 200ms 以内 | 100配置・200リンク時の自動経路計算 |
| データ品質診断 (`data_quality`) | 5.0秒以内 | 参照整合・未配置・類似名診断 |
| バックアップ出力 (`export_backup_zip`) | 60.0秒以内 | 実データとZIP作成、作業領域空き容量確認 |
| 復元プレビュー (`preview_backup_restore`) | 60.0秒以内 | ZIP展開・JSONパース・検証 |
| 復元確定 (`commit_backup_restore`) | 120.0秒以内 | 自動バックアップ退避・DB置換・画像反映 |
| PHP要求ピークメモリ | 1要求 256MiB 以下 | バックアップ出力・復元含む |
| ブラウザ JS heap | 通常表示 256MiB 以下 | Canvasおよび内部キャッシュ含む |

#### 並行利用条件
- **推奨規模**: 閲覧3者＋編集1者の同時アクセスにおいて、API `load` が10秒以内かつ5xxエラーなしで応答すること。編集2者が同一機器または同一ビューの同じ`resource_revision`から`save_resources`を実行した場合は、一方が200、他方が409となること。別機器・別ビューは両方200で保存できること。全体操作`save`は従来どおり全体世代の競合を検出する。復元実行中は409排他エラーで通常処理が安全に拒否されること。
- **上限近傍**: 閲覧5者＋編集2者で同様の指標を記録する。PHPメモリ512MiB／1要求120秒以内という暫定配備境界と、正しい成功または明示的な400/409を確認する。ただし推奨規模の応答時間を上限近傍での保証と取り違えてはならない。

#### 目標未達時の判定ルール
測定結果が目標値に未達であった場合、後から目標値を都合よく緩和・書き換えることは禁止します。未達の事実はそのまま課題として明記します。推奨規模を下方修正する場合は、半分のプロファイル（機器250台、ビュー5件、総配置500件、総リンク1,000件、図面10MiB）を同手順で測定した結果に基づいてのみ判断します。

### 4. 実行方法

以下のコマンドで合成データによるAPI計測と境界確認を実行します。ブラウザ操作の計測は、`--prepare`で作成した隔離環境で別途行います。保存先には、運用データのない新規または空のディレクトリを指定してください。

```powershell
# 推奨プロファイルの測定（ウォームアップ1回＋5回本測定）
php scripts/benchmark-performance.php --profile recommended --iterations 5

# 上限近傍プロファイルの測定
php scripts/benchmark-performance.php --profile near-limit --iterations 5

# 画像容量境界プロファイルの測定
php scripts/benchmark-performance.php --profile image-boundary --iterations 1

# ブラウザ検証用一時領域の構築
php scripts/benchmark-performance.php --prepare "C:\temp\netarium_bench" --profile recommended
```

## 自動テスト（回帰確認テスト）

主要APIの振る舞い・スキーマ・状態変化・競合検知を固定する自動回帰テスト基盤を整備しています。全件実行と再実行の要否は、上記の「確認の範囲と再実行」に従って判断してください。

### 特徴

- **完全隔離**: テスト実行時に専用の一時SQLite DBおよび一時ディレクトリ（システム一時ディレクトリ配下）を自動作成し、テスト終了時に自動削除します。本番DB（`data/db/data.sqlite`）や運用ディレクトリに副作用を与えません。
- **公開ルート分離**: `tests/TestServer.php`はプロジェクトルートを受け取り、ビルトインサーバーのDocumentRootを`public/`へ設定します。
- **外部依存なし**: ComposerやPHPUnitなどの外部パッケージを必要とせず、PHP標準機能（ビルトインWebサーバー、cURL、PDO SQLite）で動作します。

### 実行方法

#### PowerShell（推奨）

```powershell
powershell -ExecutionPolicy Bypass -File scripts/run-tests.ps1
```

#### PHP CLIからの直接実行

```powershell
php tests/regression_test.php
```

### テスト対象スイート

- `AuthTest`: 認証・権限制御（admin / viewerのアクセス可否、未認証401、CSRFトークン不備403）、利用者管理、最後のadmin保護、既存セッション失効、パスワード変更、セッションをまたぐログイン試行制限、親プロセス環境変数（`NETARIUM_DB_FILE`）に対するテスト用DBの完全隔離検証、初期設定ページのリダイレクト
- `LoadSaveTest`: データ読み込み（スキーマ・初期シード検証）、保存とリビジョン加算、`data_revision`による409競合検知、入力バリデーション
- `ResourceSaveTest`: 別機器・別ビューの独立保存、同一対象の409、batch rollback、同時writerの競合、ID採番・関連参照、削除cascadeと画像整理失敗時の保存確定維持、全体保存によるresource失効、busy時の503、スキーマ5・6・7・8からの移行、手動経路とメモの保存・削除・採番・不正入力の全件rollback、メモ変更と所属変更によるビュー世代更新、系統マスタCRUD・使用中削除保護・権限・系統割当の検証と世代分離
- `PingTest`: 疎通確認と結果構造、混在outcome、監視世代更新と未選択保持、構成世代の409、プライベートIP制限、個別タイムアウト理由、全体期限後の部分保存、100件上限、Ping排他
- `CsvTest`: テンプレートCSVダウンロード、機器台帳CSVエクスポート、CSV取込プレビュー（multipart/form-data）およびコミット
- `BackupTest`: `netarium-config`形式1／スキーマ11のJSON専用ZIP生成、構成・手動経路・メモ・系統と割当の復元、画像SHAと初回補完、画像影響プレビューと不一致参照の除外、画像実体非破壊、利用者・全セッション保全、旧形式2〜7・アプリ版／スキーマ不一致・未知列の拒否、容量・ID境界、世代非再利用、操作ロックと自動構成退避の確認
- `OperationGateTest`: 復元排他ロックと通常処理の共有ロックの相互拒否
- `DataQualityTest`: データ品質診断の実行と診断結果スキーマ検証
- `FloorPlanTest`: フロア図面アップロード（PNG画像検証）、認証付き画像配信（`public/floor_plan.php`）、表示設定更新、図面削除
- `AuditTest`: 認証・保存・削除・CSV・バックアップ・図面・系統マスタ変更の監査記録、記録不能時の更新拒否、ログイン時のDBエラー、期限超過整理、ローテーションと容量境界

<a id="複数画面複数利用者での受入確認103"></a>

### 複数画面・複数利用者での受入確認

人が別ブラウザまたは別プロファイルのadminセッションで同じ初期データを開き、次を確認します。AIのAPI・状態モデル確認は画面表示や操作感の確認を代替しません。

- 別機器の属性を各画面で編集・保存し、両方の変更が再読み込み後も残る。同じ機器の別フィールドでは後の保存が409となり、先の変更を上書きしない。
- 別ビューで配置移動・配線・ビュー設定を編集し、両方保存できる。同じビューでは別配置の編集でも後の保存が409となり、対象ビューと再読み込みの案内が表示される。
- 両画面から新規機器・ビューを作成し、ID重複や別機器への接続が起きない。保存後も選択、個票、配置、配線、表示位置が正しい対象を示す。
- 複数ビューに置いた機器を削除し、配置・リンク・画像・監視状態が消える。削除前の別画面から古いビューを保存すると409になる。別画面が削除影響ビュー上に他利用者の新規機器配置を持つ場合、削除側の応答適用後にその配置が消えないことを確認する。
- 新規作成を含む保存の応答を遮断し、「未確認」から再保存できないことと、再読み込みで登録結果を確認できることを確認する。既存対象だけの保存では「保存状態を確認」で対象外の更新を競合と誤認しない。
- 保存状態の確認までに行った追加編集・削除が消えない。DB busyの503でも入力と保留保存を維持し、既存対象は保存状態確認後に再試行できる。新規作成を含む場合は503後も再送せず再読み込みで登録結果を確認する。
- CSV取込・構成復元後の古い画面は世代不一致で拒否される。`netarium-config`形式1／スキーマ11の出力・復元、画像影響と機器ID／ビューIDの表示、画像実体と全セッションの保持、再ログインせず再読み込みできること、旧形式2〜7の拒否を確認する。
- 画面Aで機器の属性を編集せず画像のみ操作した後、画面Bで同じ機器の属性を変更・保存し、画面Aから同じ機器の属性を編集・保存すると409になること。画像操作だけでは属性の競合検出をすり抜けない。
- 2つのビューの名前を交換して保存し、HTTP 500にならず名前が入れ替わること。

## 配備スクリプトの確認

IIS の配備・更新・ロールバックの処理や設定を変更した場合は、統合確認として次の順で確認します。
通常の画面・機能変更のたびにこの全手順を実行するものではありません。

1. 全PHPの`php -l`と全PowerShellスクリプトの構文解析を実行する。
2. `scripts/run-tests.ps1`を実行する。
3. 隔離した一時領域で`scripts/check-install.php`を実行する。
4. 検証IISで`scripts/setup-iis.ps1`のfresh setup、再実行、`scripts/update.ps1`の更新と失敗時ロールバックに加え、`scripts/uninstall-iis.ps1`の専用・共用環境での保持・完全削除・再実行を確認する。
5. `scripts/verify-security.ps1`でログイン、API、初期設定、非公開パスを確認する。

検証IISを用意できない場合は、実施できなかった範囲と理由をPull Requestへ記載します。

IISを利用できない開発端末では、次のテストで`config/app.php`の生成、HTTP/HTTPS/既存BindingとSNI・証明書、確認URLの導出・上書き、IISサイト設定前の`public/web.config`配置、サイト・アプリケーションプールとFastCGIの復元、および隔離した模擬IIS環境でのアンインストールを確認できます。IIS操作はテスト内で模擬するため、検証IISでのfresh setup・更新・アンインストールの確認の代わりにはなりません。

```powershell
powershell -ExecutionPolicy Bypass -File tests/setup-iis.test.ps1
powershell -ExecutionPolicy Bypass -File tests/deployment-rollback.test.ps1
powershell -ExecutionPolicy Bypass -File tests/fresh-setup-order.test.ps1
powershell -ExecutionPolicy Bypass -File tests/uninstall-iis.test.ps1
powershell -ExecutionPolicy Bypass -File tests/iis-lifecycle.test.ps1
```

検証IISでの自動スナップショット・シナリオ実行・JSON報告と手動判定は[開発ガイド（配備の確認）](development.md#配備スクリプトの確認)を参照してください。非IISテストは実機での受入判定の代わりにはなりません。
