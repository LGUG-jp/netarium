# Netarium運用ガイド

サーバーの保守、バックアップ、全損復旧、撤去の手順です。画面操作と利用者管理は[管理者ガイド](administrator-guide.md)、新規配備は[配備ガイド](deployment.md)、更新・ロールバックと保守状態の解除は[更新ガイド](update.md)を参照してください。

## 配備後の確認

IISのDocumentRootは`<InstallRoot>\public`、実行時データは`<InstallRoot>\data`です。`data/`をHTTPで公開しません。配備後は次を実行します。

```powershell
php C:\Netarium\app\scripts\check-install.php `
  --app-root C:\Netarium\app `
  --storage-dir C:\Netarium\app\data
powershell -ExecutionPolicy Bypass -File scripts/verify-security.ps1 `
  -VerificationUrl https://netarium.example.local/
```

`check-install.php`はPHP CLIから実行するため、実際の配備先の`--app-root`と`--storage-dir`を必要に応じて指定します。`verify-security.ps1`の`-VerificationUrl`は実際のサービスFQDNとBindingを指すルートURLにします（旧`-BaseUrl`は互換alias）。`login.php`が200、`api.php`が401、`setup.php`がログインへの302または404、非公開パスが403または404であることを確認します。DNS切替前など確認先を上書きする場合も別サイトを検査しないよう注意してください。

## サーバ全損への備え

ハードウェア故障、データセンター障害、OS/ストレージ破損等のサーバ全損時に備え、復旧責任、保護対象、および手動での復旧方針を定めます。

### 復旧の考え方

構成変更時と定期保守時にWeb構成情報ZIPを取得してサーバ外へ保管します。ただし、このZIPには画像実体・利用者・環境設定が含まれず、全損復旧用の完全バックアップにはなりません。

サーバー管理者用の停止型完全バックアップCLI（`scripts/backup-full.ps1`／`scripts/restore-full.ps1`）を使用し、DB全体（users・パスワードハッシュ・権限含む）と画像実体を同一世代として取得・復元します。Web構成情報ZIP（構成メタデータのみ）と組み合わせて運用します。

### 復旧責任と保護対象

| 保護対象 | 保管・再作成方法 | 主担当 | 備考 |
|---|---|---|---|
| 構成・ビュー・監視状態、画像参照メタデータ | Web構成情報ZIPをサーバ外へ保管 | アプリ運用担当 | 画像実体は対象外。保守接続情報を含む |
| 利用者アカウント・パスワード・権限 | 組織の別系統の権限付与台帳に基づき、初期adminで再登録・パスワード初期化 | アプリ管理者 | 台帳に平文パスワードは記載しない |
| フロア図面・機器画像の実体 | サーバー側停止型完全バックアップ（`scripts/backup-full.ps1`）でDBと一体取得し、サーバ外へ保管 | サーバ管理者 | Web ZIPでは保護・復旧不可 |
| `config/app.php`、環境固有設定（環境変数含む） | 承認済み構成記録と照合し、[手動配備ガイド](deployment-manual.md)で再作成するか、`setup-iis.ps1`の生成値を確認・再設定 | サーバ管理者 | GitやバックアップZIPへ混入させない |
| IISサイト、Binding、アプリプール、FastCGI、PHP、OS設定、接続元制限 | 承認済みの構築記録と同じリリースを使い、`setup-iis.ps1`または[手動配備ガイド](deployment-manual.md)で再構築 | サーバ管理者 | 標準は独立SiteのHTTPS。既存Bindingを維持する場合は組織の既存構成に従う |
| HTTPSサーバー証明書・秘密鍵 | 組織の証明書管理庫から安全に払い出して`Cert:\LocalMachine\My`へインポートまたは再発行 | 証明書管理者 | サービスFQDNのSAN、Server Authentication EKU、拇印、必要なSNIを確認。ZIPやGitへ保管しない |
| アプリケーション配布物・バージョン | サーバ外に保管された検証済みリリース成果物から再配備 | リリース管理担当 | 本番適用済みバージョンと照合 |
| 監査ログ（`data/logs/audit`） | 必要に応じて別系統でのログ保管・転送等を確認（バックアップZIPでは復元不可） | サーバ管理者 | 既存の90日保管方針を維持 |

※ `data/backups/auto` 配下の復元前自動バックアップや、`scripts/update.ps1` によるローカルスナップショットはサーバ内の短期退避であり、サーバ全損時には利用できません。

初期登録用秘密は復旧資材として保管しません。`data/bootstrap`は管理者/SYSTEM専用で、Pool Identityには読取権限も付与せず、初期登録成功直後に平文コピーを削除します。業務バックアップZIPには初期登録用の`app_meta`キー、秘密、利用者が含まれず、ZIP復元は現在の初期登録状態を保持します。全損時は新DB用に新しい秘密を公開前に発行します。DB全体を退避から戻す場合は照合用digestと完了状態も復元されるため、利用者が存在するか完了済みなら`recover-admin.php`で復旧し、未完了なら公開前に明示的に再発行して古いコピーを再利用しません。更新スナップショットは秘密の物理コピーを含めず、ロールバックでは現在のコピーを保持して専用ACLを再適用します。

### 機密領域のACLとスナップショット

機密領域は継承を遮断し、必要な主体だけにAllow ACEを限定します。`Everyone`、`Authenticated Users`、`BUILTIN\Users`、`IIS_IUSRS`等の広範なReadや、別利用者・別Poolの明示Readを残しません。プログラム領域のReadを一律に削除する方針とは区別します。

| 対象 | SYSTEM・Administrators | 対象アプリケーションプール | 一般利用者・別Pool |
|---|---|---|---|
| スナップショットのルートと配下（DB・設定・IIS秘密を含む） | FullControl | 許可なし | 許可なし |
| 有効な`storage_dir`配下の実行時データ・`db`（DB本体と一時ファイル） | FullControl | Modify | 許可なし |
| `config/`（`app.php`を含む） | FullControl | ReadAndExecute | 許可なし |
| 有効な`storage_dir`配下の`sessions`（実効filesセッション保存先） | FullControl | Modify | 許可なし |
| 有効な`storage_dir`配下の`bootstrap` | FullControl | 許可なし | 許可なし |

新しいスナップショットは`manifest.json`の`Version=2`とし、`Iis.AppPool.Password`は`null`です。Poolのパスワードは別ファイル`iis-secrets.bin`へDPAPI LocalMachineで暗号化して保存します。スナップショットのルートは秘密の書込み前にSYSTEM・Administrators専用ACLで保護します。LocalMachineは同一ホストに結び付く暗号化方式であり、暗号化だけでは別ローカル利用者の復号を拒否する保証になりません。アクセス主体の制限はACLで行います。

復元時はファイル・IISを変更する前に秘密の復号可能性を検査します。同一ホストでは別の管理者も復元できますが、別ホストでは暗号化した秘密を復号できず、このスナップショットによるrollbackはできません。ホスト移行・全損時には、Web構成情報ZIPではなく、サーバー側停止型完全バックアップ（`scripts/backup-full.ps1`／`scripts/restore-full.ps1`）と承認済み構成記録を用いて復旧します。

旧スナップショットには平文のIIS秘密が残る場合があります。復旧資材を勝手に削除せず、ルートと配下を同じ管理専用ACLで保護して保管します。旧形式の復元でも機密領域のACLを緩めません。セッションファイルは新しいスナップショットに退避せず、復元もしません。


### バックアップ運用と情報管理

1. **取得手順とタイミング**:
   - アプリ管理者がWeb画面の「その他」→「バックアップと復元」からバックアップZIPを手動で取得します。
   - 機器台帳や図面を大幅に追加・変更した際、定期保守時、およびプログラム更新・DB変更前に必ず取得します。
2. **保管先と世代管理**:
   - ダウンロードしたZIPは、Webサーバ上にとどめず、直ちにサーバ外のアクセス制限された保管領域（管理用ファイルサーバや安全な端末）へ移します。
   - トラブルに備えて直近数世代を残し、不要になった古いバックアップは手動で整理します。
3. **機密区分とアクセス管理**:
   - バックアップZIPには機器の保守接続情報が含まれるため機密情報として扱い、アクセス権限をアプリ管理者・運用担当者に限定します。
   - サーバー証明書の秘密鍵や環境固有の機密設定はバックアップZIPには含めず、組織の所定の管理庫から別途安全に管理・取得します。
4. **取得確認と定期復元試験**:
   - バックアップ出力時はダウンロード完了とファイルサイズを目視確認します。
   - 定期保守（月次等）に合わせて、隔離された検証環境で実際にZIPの読み込み・プレビューを行い、正常に復旧できることを確認します。


<a id="id上限採番余地不足への対応196"></a>

### ID上限・採番余地不足への対応

ZIP復元で受け入れる業務IDは1～9,007,199,254,740,990です。次の1件をJavaScriptの安全整数上限内で発行できることを、ZIP内のID、現行の採番カウンター、現存の最大IDから検査します。プレビュー後に採番状態が変わった場合も確定時に再検査します。上限超過・余地不足の復元は400、新規登録の採番枯渇は409で拒否し、業務データと採番情報を保持します。

既に危険なIDを復元した環境では、正常なZIPを同じDBへ復元してもカウンターは下がりません。採番余地不足が表示された場合は、新規登録と復元の再試行を止め、サーバー管理者へ引き継ぎます。保守状態でDB・画像・ログを退避し、DBのコピーで`resource_sequences`の6種類のID値、`sqlite_sequence`の`device_images`、各業務表の`MAX(id)`を読取り確認してください。9,007,199,254,740,991以上は復元不可で、通常採番の上限にも達しています。`resource_sequences.revision`はID値ではなく世代カウンターです。

カウンターの直接引下げや機器の再採番は行いません。過去に発行したIDを再利用すると旧画面や外部の参照と衝突するためです。復旧候補は、危険IDを含まない保管ZIPを新しい隔離DBへ復元し、新規作成まで確認してから、管理者の承認を得て別環境への切替を判断します。切替時には旧環境の全セッション・復元／CSVトークンを無効化し、利用者に旧画面を閉じて再ログインさせます。既存DBのカウンターを自動修復する処理はありません。

## サーバ全損からの再構築
ハードウェア故障やデータセンター障害等によりサーバが全損した場合、空の隔離された Windows / IIS ホスト上へ新規セットアップ（`setup-iis.ps1`または[手動配備ガイド](deployment-manual.md)）を行った後、外部保管された完全バックアップZIPから`scripts/restore-full.ps1`を用いてDB・画像・利用者を一体復元します。

### 停止型完全バックアップの仕様と取得手順

`scripts/backup-full.ps1`は、管理者権限の PowerShell から実行する停止型完全バックアップ CLI です。
Site と Application Pool の双方が開始（Started）している環境では、全バインディングの site-root URL を `-VerificationUrl` に指定します。

```powershell
# 実行例（管理者PowerShell）
& .\scripts\backup-full.ps1 `
    -InstallRoot C:\Netarium\app `
    -SiteName Netarium `
    -ApplicationPoolName Netarium `
    -BackupDirectory D:\Backups\Netarium `
    -VerificationUrl @('http://localhost/') `
    -DrainTimeoutSeconds 120
```

1. **取得対象**:
   - SQLite DB 全体（`db/data.sqlite`。users、パスワードハッシュ、権限、採番情報、初期登録状態を含む）。
   - フロア図面（`uploads/floorplans`）および機器画像（`uploads/device_images`）のファイル実体。
   - `manifest.json`（形式 `netarium-full`／format_version 1、アプリ版 `NETARIUM_VERSION === '1.0.0'`、スキーマ版 `schema_version === 11`、全ファイル SHA-256、テーブル別件数）。
2. **対象外（責任分界）**:
   - セッションファイル（`data/sessions`）、監査ログ（`data/logs/audit`）、復元ログ、IIS 設定・サーバー証明書、`config/app.php`等の環境秘密はバックアップに含めません。
   環境設定や証明書は組織の管理記録から別途設定・復元します。
3. **保守取得シーケンス（A順序）と停止時間の最小化**:
   - **共通原子的保守ロックの取得**: 同一インストールを対象とする 3 つの CLI（`backup-full.ps1`、`restore-full.ps1`、`update.ps1`）で共通の排他ロックを `ProgramData\Netarium\maintenance\<InstallRootハッシュ>\owner.lock` に対して `FileShare.None` で取得します。
   公開用の操作 ID と内部の秘密所有トークンは分離して管理します。
   バックアップではオフライン ZIP 圧縮が完了するまでこの排他ロックを保持します。
   - **元状態の保存**: Site と Application Pool の稼働状態、および IIS の明示設定、継承関係、コレクションの順序を `journal.json` に保存します。
   - **.php 拒否と静的応答の設置**: IIS の RequestFiltering で `.php` の実行を拒否し（`allowed="false"`）、httpErrors（404.7、`responseMode="File"`）で厳密な 5 キーを持つ静的拒否 JSON（`public/netarium-maintenance-<公開operationID>.json`）を設定します。
   httpProtocol で `Cache-Control: no-store` を設定します。
   この静的ファイルを直接 URL で GET した場合は HTTP 200 となり、元 API URL から外れるため、クライアント JS 側で保守拒否とは判定されません。
   - **実効プローブの成立待機**: Site と Application Pool の双方が開始（Started）している場合のみ実行します。
   `-VerificationUrl` で指定されたすべてのバインディングのルート URL に対し、リダイレクトなし、厳密な契約、操作 ID の一致、`no-store` ヘッダーを確認します。
   プローブの固定タイムアウトは 30 秒、各要求は 3 秒です。
   停止対象の Site や Pool をプローブのために起動することはありません。
   - **処理中要求の排出**: Application Pool の処理中要求がゼロになるまで待機します（既定タイムアウト 120 秒、`-DrainTimeoutSeconds` で変更可能）。
   - **排他ゲートの取得と停止**: `OperationGate` の排他ロックを取得し、Site と Application Pool を停止します。
   - **整合スナップショット採取**: 生きた DB の無検査コピーではなく、SQLite `VACUUM INTO` による一貫した時点のスナップショットを保護領域へ取得します。
   画像実体を作業領域へコピーし、SQLite integrity_check、foreign_key_check、画像実体とメタデータの整合性を検証します。
   - **補完と安全復旧**: schema10→11 移行直後の画像で SHA-256 が空の場合は、安全な保存パス、存在、サイズ、MIME、寸法を確認した上で、隔離スナップショットの DB だけに実体の SHA-256 を補完します。
   - **元状態への復旧**: 検証成功後、IIS 設定を Microsoft.Web.Administration のセクション変更で元に戻し、Site と Pool の初期状態を復元します。
   `OperationGate` の排他は再開前に解放し、共通保守ロックはオフライン ZIP 圧縮が完了するまで保持します。
   - **オフライン圧縮**: サイト再開後に一時コピーをオフラインで ZIP 圧縮し、停止時間を最小限に抑えます。
   生成された ZIP には SYSTEM/Administrators 専用 ACL を適用します。

4. **Site と Pool の 4 初期状態の復元**:
   - Site と Pool の開始（Started）と停止（Stopped）の 4 通りの組み合わせを検知し、完了時に開始前の状態へ正確に戻します。
   - Started / Started: プローブを実施し、要求を排出して停止後、復旧時に両方を再開します。
   - Started / Stopped: Pool が停止しているため PHP は実行できず、プローブは不要です。設定退避、要求排出、停止を行い、復旧時は Site のみを開始して Pool は停止を維持します。
   - Stopped / Started: プローブは不要です。復旧時は Pool のみを開始して Site は停止を維持します。
   - Stopped / Stopped: プローブは不要です。復旧時も両方を停止のまま維持します。
   - 遷移状態は安全のため実行を拒否します。
   停止対象をプローブのために起動することはありません。

空SHA-256の補完は、ライブDBへ初回補完するWeb構成情報ZIPとは処理対象が異なります。
完全バックアップでは補完をトランザクションで確定した後のDBを検証・ハッシュ計算してZIPとmanifestへ記録します。
復元時には空値を補完せず、DBの画像参照と実体のSHA-256を厳格に照合します。
初回補完は保存メタデータとの一致確認であり、移行前の画像が過去に改ざんされていないことの証明ではありません。

### 停止型完全復元の仕様と全損復旧手順

`scripts/restore-full.ps1`は、完全バックアップ ZIP から DB、画像、利用者を検証した上で安全に切り替える CLI です。
Site と Application Pool の双方が開始（Started）している環境では、全バインディングの site-root URL を `-VerificationUrl` に指定します。

```powershell
# 実行例（管理者PowerShell）
& .\scripts\restore-full.ps1 `
    -InstallRoot C:\Netarium\app `
    -SiteName Netarium `
    -ApplicationPoolName Netarium `
    -Archive D:\Backups\Netarium\netarium-full-20261015-120000.zip `
    -WorkRoot D:\Temp\NetariumRestore `
    -VerificationUrl @('http://localhost/') `
    -DrainTimeoutSeconds 120
```

1. **前段検査（非破壊）**:
   - 既存環境へ直接上書きせず、一時隔離ディレクトリへ ZIP を展開し、zip-slip、重複、再解析ポイント、特殊属性を拒否します。
   - パス、マニフェスト構造と全ファイル SHA-256、SQLite integrity_check、foreign_key_check、画像実体と参照整合性、スキーマ版（`schema_version === 11`）、および復元先アプリ版に対して明示的に許可されたバックアップ元アプリ版（復元先 `1.0.1` では `1.0.1` または `1.0.0`、復元先 `1.0.0` では `1.0.0`）を検証します。
   - 旧版（`0.3.0` 以前）環境で取得したバックアップ、新版から旧版への逆方向復元（`1.0.1 → 1.0.0`）、未検証の将来版、スキーマ不一致は前段検査で安全に拒否されます。
   - 前段検査の失敗時は IIS の停止を行わず、本番データ（ライブ DB・画像・利用者・セッション）と IIS 状態は一切変更されず不変に保たれます。
   - 完全バックアップの復元は、SQLite DB 全体・利用者／認証状態・画像実体をバックアップ取得時点の一世代へ戻します。`1.0.1` 環境へ過去の `1.0.0` 完全バックアップを復元すると、更新後に追加・変更したデータも過去時点へ戻るため、**復元実行前に必ず現在の最新世代の完全バックアップを新規取得して別領域へ保全してください**。アプリケーション更新自体の失敗を切り戻す場合は、データ復元ではなく更新時のスナップショットによるロールバックを使用します。
2. **保守シーケンスと切替保護**:
   - バックアップと同様に、共通保守ロック（`owner.lock`）の取得、IIS 設定退避、`.php` 拒否設置、実効プローブ待機（Started / Started 時のみ）、要求排出（`-DrainTimeoutSeconds`）、`OperationGate` 排他取得、Site/Pool 停止の A 順序で処理を進めます。
   - ライブ DB のチェックポイント（`PRAGMA wal_checkpoint(TRUNCATE)`）および残存 sidecar（`-wal`、`-shm`、`-journal`）の非存在を確認します。
   - 同一ボリューム内の退避ディレクトリへ旧 DB と旧画像を移動（アトミック退避）し、新 DB と新画像を配置して専用 ACL を適用します。
   - アプリ固有のセッションファイル（`data/sessions/sess_*`）を削除し、旧認証世代の再利用を防止します（他 Site や共有セッション領域は破壊しません）。
   - `scripts/check-install.php` を実行して配備状態を確認します。
   - 配置や検査が失敗した場合は、新ファイルを撤去して旧 DB と旧画像を退避から元のパスへ復旧（ロールバック）し、部分復元状態で無条件に再開しません。
   - 正常完了後、IIS 設定を元に戻し、Site/Pool を開始時の初期状態へ復旧して保守ロックを解放します。

3. **全損時の復旧手順**:
   - 隔離された新規ホストに `setup-iis.ps1` で空のSite/Poolを構築。
   - 外部保管先から取得した完全バックアップZIPを指定して `scripts/restore-full.ps1` を実行。
   - `check-install.php` および `verify-security.ps1` で正常性を確認。
   - DB・画像・利用者アカウント（パスワードハッシュ・権限含む）が復元され、即座に通常運用を再開できます。

### 保守所有の運用制約と異常終了時の管理者手動復旧

保守機能では、IIS 構成の完全性と安全性を担保するため以下の運用制約を設けており、不適合な構成では設定適用前に処理を安全拒否します。

- **共有 IIS 構成の禁止**: `redirection.config` で `configurationRedirection` が有効化されている環境はサポートせず、設定前に拒否します。
- **ネストされたアプリケーションの分離**: 同一 Site 配下にネストされた別の Web アプリケーションが存在する場合、境界分離のためサイト全体の保守操作を安全拒否します。
- **MWA による完全再現性の保証**: IIS 設定内に、既存コレクションに存在しない要素に対する冗長な `remove` ディレクティブなど、Microsoft.Web.Administration で正確に再現・復元できない設定が存在する場合、コミット前に処理を安全拒否します。

保守実行中にプロセスが強制終了された場合や、保守解除処理に失敗した場合、IIS の `.php` 拒否設定や停止状態が残ることがあります。
保守状態の情報（`journal.json`）、秘密所有トークン（`owner.token`）、排他ロック（`owner.lock`）は `ProgramData\Netarium\maintenance\<InstallRootハッシュ>\` に保存され、SYSTEM および Administrators 専用のアクセス権が設定されています（Application Pool Identity には権限を与えません）。
`journal.json` は Windows DPAPI（LocalMachine スコープ）で暗号化されており、同一マシン上の管理者のみが復号できます。

障害発生時、管理者がこれらのファイルを単に手動削除して復旧してはいけません。
手動削除を行うと、IIS 設定の不整合や、他の生きた CLI プロセスとの競合を引き起こす原因になります。
管理者はサーバー上で PowerShell を管理者権限で起動し、`scripts/deployment-common.ps1` をドットソースで読み込んで手動復旧コマンドを実行します。

```powershell
# 手動復旧の実行（管理者PowerShell）
. C:\Netarium\app\scripts\deployment-common.ps1
Repair-NetariumMaintenance -InstallRoot C:\Netarium\app
```

`Repair-NetariumMaintenance` は共通保守ロックを再取得し、他プロセスの排他を確認した上で `journal.json` のトークン、設置設定、元設定を照合します。
他者による変更や設定競合を検知した場合は安全のため停止状態を維持します。
正常に照合できた場合は、IIS 設定を元に戻し、Site と Application Pool を開始前の状態へ復旧してジャーナルとロックを整理します。

データ書き換え中（Phase が `mutating`）に中断した場合は、安全のため即座の自動復旧を拒否します。
管理者はまず停止状態のまま DB や画像ファイルの実体を手動で検査し、データの安全性を確認または復旧した上で、明示的に `-DataSafetyConfirmed` スイッチを指定して復旧を実行してください。

```powershell
# データ安全確認後の手動復旧
Repair-NetariumMaintenance -InstallRoot C:\Netarium\app -DataSafetyConfirmed
```

## バックアップ

Web バックアップは `netarium-config` 形式 1／DB スキーマ 11 の構成情報 ZIP です。
`manifest.json` と `data/netarium.json` だけを含み、構成 10 テーブルと画像参照メタデータを保存します。
画像実体・利用者・パスワード・認証状態・監査ログは含めません。
安全仕様として、DB スキーマバージョン（`schema_version === 11`）の一致と、明示的に互換検証されたアプリケーションバージョンの組み合わせ（復元先 `1.0.1` ではバックアップ元 `1.0.1` および `1.0.0`、復元先 `1.0.0` では `1.0.0` のみ）を要求します。
旧版（`0.3.0` 以前）で取得したバックアップ、逆方向（`1.0.1 → 1.0.0`）、旧画像同梱形式 2〜7 は非対応です。
固定テーブル、`app_meta` 4 キー、互換マトリクスと安全ルールは [運用ガイド（復元）](operations.md#復元) を参照してください。

- 機器台帳や図面の変更時、定期保守時、およびプログラム変更前に手動でバックアップ ZIP を取得する
- 取得した ZIP は Web サーバー外の安全な領域へ保管し、数世代を管理する
- 完全な全損復旧（画像実体・利用者を含む）には、サーバー側停止型完全バックアップ（`scripts/backup-full.ps1`）を使用する
- プログラム更新（1.0.0 への更新）後は、正常稼働を確認した後に速やかに 1.0.0 環境の完全バックアップを新規取得して外部保管する
- 定期的に隔離された検証環境で復元試験を行う

復元前自動バックアップも同じ構成情報ZIPとして`data/backups/auto`へ保存します。画像・利用者の退避や長期バックアップの代替ではありません。
Web ZIPは24MiB以下、展開後合計64MiB以下、2ファイルに制限します。画像保存の全体108ファイル／200MiB一律上限は撤去し、ディスク空き容量および任意の運用クォータで管理します。1機器最大3枚、写真保存1枚10MiB以下、図面保存1枚10MiB以下・最大100枚の安全上限は維持します。

写真は入力10MiB・各辺4,000px・1,200万画素以内を長辺2,048px以下にして保存し、原本は保持しません。図面は入力PNG/JPEG 30MiB・各辺7,000px・3,500万画素以下を向き補正後に長辺4,096px以下へ自動縮小し、同形式・10MiB以下の変換結果だけを保存します。小画像は拡大せずPNG透過を保持します。必要な原本は別途保管してください。画像投稿専用URLのIIS要求上限31MiB、Site通常要求32MiB、PHP推奨upload_max_filesize=32M／post_max_size=34Mとします。

DB移行11で画像に`sha256`列を追加し、登録時に保存用実体のSHA-256を記録します。旧行の空digestは初回出力時に保存名・サイズ・MIME・寸法が一致する実体だけをハッシュして補完します。復元プレビューでは、これらの属性とSHA-256がすべて一致する実体だけを参照可能とし、欠損・不一致件数と機器ID／ビューIDを示します。元メタデータはZIP内に残ります。

復元は画像実体を作成・上書き・移動・削除・再変換せず、画像GCも行いません。利用者・パスワード・全セッションを実行者を含め維持します。再ログインではなく画面の再読み込みが必要です。復元前はアップロードZIP、JSON展開物、構成情報の自動退避と作業領域の空き容量を確認し、不足時はDB置換前に拒否します。

## 復元

復元処理（Web 構成情報復元、停止型完全復元 CLI のいずれも）では、PATCH／MINOR更新において同一MAJORバージョンの過去正式版から新版への復元互換性を維持する方針とします。ただし無条件には許可せず、ZIP形式・DB スキーマバージョン（`schema_version === 11`）・保存データ契約が明示的に検証・許可されたアプリケーションバージョンの組だけを受け付けます（fail-closed）。新版から旧版への逆方向復元や異なるMAJORバージョン間の直接復元は保証しません。

| 復元先アプリ版 | Web 構成情報 ZIP（`netarium-config` 形式 1） | 停止型完全バックアップ ZIP（`netarium-full` 形式 1） | 非対応（前段で拒否） |
|---|---|---|---|
| `1.0.0` | バックアップ元 `1.0.0`（スキーマ 11） | バックアップ元 `1.0.0`（スキーマ 11） | `1.0.1`（逆方向）、`0.3.0` 以前、旧 Web 形式 2〜7、別スキーマ、未検証版 |
| `1.0.1` | バックアップ元 `1.0.1`, `1.0.0`（スキーマ 11） | バックアップ元 `1.0.1`, `1.0.0`（スキーマ 11） | `0.3.0` 以前、旧 Web 形式 2〜7、将来版（`1.0.2` 等）、別スキーマ、未検証版 |

非対応のバックアップファイルを指定した場合は前段検査で安全に拒否され、データベース、画像ファイル、利用者、セッション、IIS 状態などの既存データは一切変更されず不変に保たれます。
`0.3.0` 以前のデータを復元する必要が生じた場合は、対応する旧版プログラム資材へ切り戻してから復元を実行してください。
また、プログラム更新完了後は正常稼働確認後に速やかに新版環境の完全バックアップを新規取得し、過去時点の完全バックアップを復元する前にも最新の完全バックアップを別途保全してください。

Web 画面からの復元では構成と照合済み画像参照を置き換えます。
画像実体、利用者、パスワード、実行者を含む全セッションは変更しません。
復元前の画面からの保存・CSV・画像操作・Ping は世代不一致として拒否されるため、画面を再読み込みしてください。

復元前に他の利用者へ作業停止を連絡し、未保存変更がないことと現在の構成情報 ZIP を取得したことを確認してください。
復元中は更新操作、画像配信、別の復元を拒否します。
プレビュー後に現行データが変更された場合は再プレビューが必要です。
「後処理要対応」の場合は DB 復元が確定済みなので繰り返さず、復元ログ・監査ログ、一時領域、自動バックアップを確認してください。
画像実体を削除する後処理はありません。

<a id="復元プレビューの保持上限と回収197"></a>

### 復元プレビューの保持上限と回収

復元プレビューの作業領域は`backup_restore_directory`（既定は`data/temp/backup-restore`）です。保持上限は全体8件・4GiB、ユーザーごと2件・1GiBで、ZIP、展開JSON、メタデータの実バイト数を合算します。単体ZIP24MiB・展開後64MiBとは別の上限です。ディスク空き容量は保証しないため、構成情報の自動退避と一時領域の共存容量も確認します。

プレビュー成功時から600秒は復元トークンの利用期限です。期限時刻と現在時刻が等しい間は有効で、現在時刻が期限を超えると失効します。失効した作業領域の回収は、次のプレビュー開始、復元確定（commit）開始、または清掃CLI実行時に行います。常駐タイマーによる「600秒後の即時削除」は保証しません。新しい`workspace.json`に所有者と期限を保存し、旧プレビューは`preview.json`から読み取ります。メタデータがない・壊れた孤児領域はディレクトリ更新時刻とTTL（最低60秒）を基準に回収し、シンボリックリンク先は追跡しません。所有者不明の領域は、ユーザーごとの容量・件数にも保守的に算入します。

保持上限を超える要求はHTTP 413で拒否し、等しい場合は受け入れます。単体ZIP・展開後の上限超過は従来どおりHTTP 400です。ZIPと展開予定量は作業領域作成・ZIP移動前に検査し、プレビューメタデータも書込み前に正確なバイト数を追加検査します。拒否時は業務DB・既存画像を変更せず、有効トークンを容量確保のために削除しません。413では不要なプレビューの期限切れと回収を待ちます。
なお、画像アップロード専用 URL（`image_upload.php`）の受信上限は 31 MiB であり、超過時は HTTP 413（IIS 413.1）で拒否されます。
サーバー保守作業中は、この 413.1 より RequestFiltering による `.php` 拒否（IIS 404.7、専用 JSON 拒否）が優先されます。
`public/web.config` には 404.13 のマッピングが保持されていますが、実環境での 404.13 実応答は未検証です。

プレビュー、復元確定、清掃CLIは作業領域直下の`.workspace.lock`で同じ非待機の排他ロックを取得します。処理競合はHTTP 409で即時拒否し、保持上限超過の413とは区別します。清掃CLIのロック競合は非ゼロ終了となるため、処理終了後の次回実行へ回します。稼働中に`.workspace.lock`を削除すると別ファイルで処理が並行し得るため、削除しません。

要求のない時間帯にも回収する場合は、アプリのインストール先を作業ディレクトリとして、配備先のPHP CLIで次を定期実行します。認証やDB接続は不要です。

```powershell
php scripts/prune-restore-previews.php
```

定期実行は自動登録されません。必要ならWindowsタスクスケジューラに登録し、実行アカウントに対象作業領域とロックファイルの読取り・書込み・削除に必要なACLを付与して、終了コードを監視します。ロック競合なら次回へ回し、削除失敗による非ゼロ終了ならACL、使用中ファイル、ディスク状態を調べて対処します。削除できなかった領域は残件数・残容量に含めます。OSのファイルロックなどで容量を計量できない場合は、新規受付をHTTP 503で停止し、CLIも非ゼロ終了します。清掃を実行しただけで容量が空いたと判断しません。

肥大化が続く場合は利用者のいない保守時間帯にIIS Site／Application Poolを停止し、処理中のFastCGI要求と清掃CLIの終了を確認してから手動で整理します。有効トークンの領域を空き容量確保のために削除しない方針は、手動整理でも維持します。

配備先の人による受入では、隔離環境と合成データで期限前の利用、期限後の拒否と次回要求／CLIによる回収、413時の変更前拒否と有効トークン保持、409競合、削除失敗時の残量計上・ACL復旧を確認します。ディスク枯渇は本番で再現せず隔離環境で確認し、実施環境と結果を記録してから受入を判断します。秘密情報や本物の業務データを試験記録に含めません。


## 更新とロールバック

手作業でファイルを上書きせず、`scripts/update.ps1`を使用します。
対象確認、更新コマンド、自動・手動ロールバック、保守状態の解除は[更新ガイド](update.md)に従ってください。
更新処理においても共通の保守ロック（`owner.lock`）、IIS 設定退避、`.php` 拒否設置、実効プローブ、要求排出、4 初期状態の復旧という同一の A 順序を適用します。
更新後の正常性確認用 URL（`-VerificationUrl`、単一文字列）に加え、複数バインディング環境での保守プローブ用として `-MaintenanceVerificationUrl [string[]]`、および排出タイムアウト用の `-DrainTimeoutSeconds` を指定できます。
全損に備える場合は、サーバー管理者用の停止型完全バックアップCLI（`scripts/backup-full.ps1`）で一体取得してください。

<a id="認証付き画像のキャッシュ方針と更新後の再読込200"></a>

### 認証付き画像のキャッシュ方針と更新後の再読込

機器画像の原寸（`device_image.php`）、サムネイル（`device_image.php?size=thumb`）、フロア図面（`floor_plan.php`）の3種は、`Cache-Control: private, no-store`で配信します。サーバーへの画像要求ごとに認証を確認し、再読込時は画像を再転送するため、通信量と応答時間が増える可能性があります。サーバー側のサムネイル保存は維持し、ETagや304応答は追加しません。

旧版の`private, max-age=86400`で保存されたHTTPキャッシュは、更新後のヘッダー変更だけでは消えず、最大24時間再利用され得ます。この旧URLを新しく読み込んだ画面で使わないため、画像URLの全生成箇所で既存の`v`を保持したまま`&cache_policy=200-1`を付けます。URLの変更は旧キャッシュの削除ではなく、新しいURLへの要求を発生させるための対処です。

更新後は、利用者に未保存編集を既存の保存手順で保全してから画面を再読み込みするよう案内します。更新を理由に未保存編集を自動破棄せず、localStorageや入力、自動保存の処理には干渉しません。更新前から開いている画面や旧URLには残余リスクがあり、既表示の画像、保存済み画像、スクリーンショットを含む回収は保証しません。

実IIS・実ブラウザの確認は[開発ガイド（配備の確認）](development.md#配備スクリプトの確認)に従います。旧URLのキャッシュ残存と、新URLへのHTTP応答を分けて記録してください。

<a id="パスワードの明示移行169"></a>

### パスワードの明示移行

新規設定はArgon2id（`memory_cost=19456` KiB、`time_cost=2`、`threads=1`）で保存します。非対応PHPへの代替保存はありません。全bcryptが移行対象で、元の長さにかかわらずログイン成功によるrehashは行いません。本人変更、管理者再設定、緊急時の`recover-admin.php`で新しい秘密を明示設定します。

1. `scripts/check-install.php`の`password_algorithm`、`password_options`、`allow_legacy_bcrypt`、`legacy_bcrypt_users`を記録します。件数は停止済みも含む全bcryptです。平文・ハッシュを運用記録やIssueへ出しません。
2. 正式利用前のテストアカウントは全件再設定を第一候補とします。継続利用者への影響は未確認のため、再設定の安全な別経路での受渡し、本人変更の案内、期限と連絡方法を運用責任者が承認します。未移行者の停止・削除は別承認とし、実装判断で強制しません。
3. 承認した移行期間は`config/app.php`のbool `allow_legacy_bcrypt=true`で旧照合を許可します。ログイン／現在値には新規設定の長さ条件を再適用しません。新規生成はこの設定にかかわらずArgon2idです。
4. 原則としてv1.0.0前に`legacy_bcrypt_users=0`を確認し、下記の反映確認を経て`allow_legacy_bcrypt=false`で移行期間を終了します。`false`では旧bcryptのログイン・現在値照合と、その利用者の既存セッションを次の保護要求で拒否します。残存者が本人変更できなくなるため、管理者再設定とadmin緊急復旧CLIの担当・利用経路を確保します。

<a id="認証設定の適用とhttp-worker反映確認185"></a>

### 認証設定の適用とHTTP worker反映確認

`config/app.php`の書換えとHTTP workerでの設定評価は、OPcacheにより一時的に一致しない場合があります。設定ファイルとHTTP workerの評価値が一致しない場合があります。CLIの`opcache.enable_cli=Off`もHTTP SAPIのOPcache無効を保証しません。**設定変更の完了は、実HTTP workerの評価値と認証結果で判定します。** `check-install.php`の成功やファイルの内容確認だけでは完了にしません。

1. **対象と適用方法を確定する（サーバ管理者）**：実HTTPのPHP版・SAPI・読込INI、`opcache.enable`、`opcache.validate_timestamps`、`opcache.revalidate_freq`、`opcache.file_update_protection`、`opcache.file_cache`と関連設定を記録します。全配備ノード、Site／Application Pool、FastCGI application・worker、OPcacheとセッションの共有範囲、同じPool／PHPを使う他アプリを特定します。timestamp検証が無効なら待機だけでは反映を期待できず、有効でも固定秒数の待機を完了条件にしません。
2. **保守と影響を承認する（運用責任者）**：専用Poolなら、要求受付を止めて処理中要求を排出し、対象Poolを完全停止して旧FastCGI workerの終了を確認してから起動する方法を第一候補とします。Pool単位でキャッシュが分離されるとは推定せず、再起動後も設定評価を確認します。Site停止だけや、旧workerが並存するoverlapped recycleだけを反映の証拠にしません。共有Pool／キャッシュや永続file cacheがある場合は、対象ファイルの無効化を含め、配備先で実証した方法と他アプリへの影響を確認します。影響のない方法を確定できなければ停止を維持し、専用化または保守調整を判断します。IIS全体の再起動、共有キャッシュの一括reset・削除、本番OPcacheの無効化を既定の対処にしません。
3. **設定を適用する（サーバ管理者）**：復旧用に現在の設定を非公開領域へ退避し、承認した保守状態で要求を排出してからbool `allow_legacy_bcrypt=false`を保存します。構文・保存内容・CLI診断を確認し、手順2で選んだキャッシュ反映／worker起動を実施します。構文不備や要求排出失敗では先へ進まず、一般利用者の受付を止めたまま原因を修正します。試験要求だけを許可する状態で次の確認を行います。
4. **全対象workerの反映を確認する（サーバ管理者・検証担当）**：[開発ガイド（配備の確認）](development.md#配備スクリプトの確認)に従い、実サービスと同じBinding・PHP・実行ID・設定読込経路へのHTTP要求で、設定評価値`false`と認証結果を確認します。ノード・worker PID／起動時刻と確認要求を対応づけ、起動し得るworkerも含めた対象一覧と照合します。無作為な繰返し要求や1 workerの成功だけで全worker確認としません。反映漏れ・到達未確認のworkerがあれば適用未完了です。
5. **再開を判定する（運用責任者）**：全対象workerで旧bcryptの新規ログイン拒否・切替前セッションの次保護要求拒否と、Argon2idの新規ログイン・既存セッションの権限内利用を確認してから受付を再開します。検証用の旧bcryptは隔離IISの合成利用者で確認し、件数ゼロの実環境に試験用旧ハッシュを追加しません。配備先の件数・評価値と、同じ構成の隔離IISでの旧方式拒否の証跡は区別して記録します。診断用一時ファイル・アクセス許可は撤去し、設定復旧が必要な場合も旧方式を再許可する判断を別途承認して、反映確認を繰り返します。

この設定切替だけを理由にセッション保存領域を一括削除しません。旧セッションを残した拒否試験が必要であり、Argon2id利用者まで失効させる操作は設定反映の代わりになりません。各workerの確認には独立した切替前旧セッションを用い、先行workerの拒否に伴うセッション破棄で未反映workerを誤認しないようにします。全SQLite復元／rollbackで旧世代が復活する場合の対象セッション失効は、次節の別手順です。

実IISの反映時間、複数worker、timestamp検証無効時、他アプリへの影響を配備先で確認し、適用方法・結果・未確認範囲を運用記録に残します。文書整備や隔離HTTPの結果をIISでの合格と扱いません。

### 全SQLite復元・rollback時のパスワード再確認

Web構成情報ZIP（`netarium-config`形式1／DBスキーマ11）は`users`・初回変更状態・認証試行制限を含まず、それらを置き換えません。SQLite全体の復元や更新rollback snapshotは旧ハッシュ・旧秘密・旧パスワード世代に加え、強制状態・試行制限も巻き戻します。実施前にSiteを停止して要求を排出し、対象アプリのセッションhandler・保存先・共有有無を確認して既存セッションを失効させます。Site・Pool停止だけでは失効せず、旧世代と一致した休眠中の旧セッションが再認証されることを隔離HTTPで確認しました。共有領域を一括削除しません。自動rollbackはセッション掃除・再移行を実施しないため、継続利用者がいる移行後の自動復帰は利用可否と停止維持を運用承認します。復元後は件数・設定・復活した旧秘密と強制状態を確認し、再設定・再移行後に再開します。[更新ガイド](update.md#初回変更補完対策導入後のrollback170)を参照し、ZIP復元と全SQLite復元を同じ手順として扱いません。

Argon2id非対応の旧PHPへrollbackできません。旧アプリへ戻すと新規設定でbcryptを再生成する危険があります。旧コードでは`allow_legacy_bcrypt`が未知キーとして拒否されるため、旧設定を復元する必要もあります。その結果、終了した移行期間が再開されるリスクを含め、PHP・アプリ・設定・DBの組合せを隔離環境で確認し、運用承認を得ます。再開後に作られたbcryptも再移行対象です。

<a id="補完対策の保守170"></a>

### 補完対策の保守

仮パスワードの受渡し・期限管理・本人変更・制限解除・復旧は[管理者ガイド](administrator-guide.md#仮パスワードの発行と初回本人変更170)を参照します。標準辞書は `resources/password-blocklist/pwdb-policy-top-3000.txt` と `pwdb-metadata.json` の固定 PWDB 3,000 件です。固定 SHA-256、件数、抽出条件、原配布元と再配布元の両 MIT 本文を検証します。欠損・改変・metadata 不整合では新規設定と配備診断を拒否します。既存ログインと現在値照合には新規設定条件を再適用しません。

更新責任はリリース資材管理者が担います。定期保守と新しい漏えい資料の評価時に、[アーキテクチャ](architecture.md#認証と権限)と辞書メタデータ（`pwdb-metadata.json`）を確認します。原配布元・SecListsの固定commit、順位説明、両MITの本文・表示、元ファイルの件数・blob・SHA-256を検証し、元頻度順の構造適合上位3,000照合値を再抽出します。追加／削除による新規設定の拒否条件への影響を評価し、資材・metadata・固定定数・挙動回帰を一緒にPRでレビューします。実行時の自動取得は行いません。原配布元の更新停止やリストにない値を安全性の証拠にしません。

配備先管理者は fresh setup・更新後に `check-install.php` の成功を確認し、標準本文と metadata が Web 非公開・対象 Pool 読取専用であることを検査します。失敗時は同一リリースの正規資材を復元し、固定検証を無効化しません。rollback はプログラムと標準 `resources` を同じ snapshot から戻します。[更新ガイド](update.md#pwdb辞書追加後のrollback201)で旧版の拒否範囲と再開可否を確認します。

`check-install.php`の`password_blocklist_available`と`must_change_password_users`、監査の`password_spray_suspected`を確認します。集計は失敗時に1時間超過と保存上限（失敗10,000・警告2,000行）を清掃し、警告間隔は300秒です。接続元digestは匿名化の保証ではないため、監査・DBのACLと90日／256MiBの既存ログ管理を維持してください。共有IPの誤入力だけでアカウントを一律停止せず、IIS・プロキシ境界の記録と本人確認で判断します。

#### 任意追加辞書

追加辞書は未設定でも正常に動作します。
サーバー管理者は、出典と利用・再配布条件を自ら確認した辞書だけを、非公開の実行時ストレージへ登録します。
Web 管理画面、外部 API、自動ダウンロードはありません。
NCSC 本文とその専用 metadata は同梱せず、標準辞書への転載も行いません。

入力仕様は、BOM なし UTF-8、1 行 1 値、末尾改行あり、LF または CRLF です。
最大 16 MiB、100,000 行、各値 1〜128 Unicode コードポイントかつ 512 byte 以内とします。
空行、単独 CR、NUL、タブを含む制御文字、ASCII 大小文字だけを同一視した重複を拒否します。
CRLF を LF に統一する以外は、空白の trim、文字の変更、Unicode 正規化を行いません。
新規パスワード自体の最低 12 文字は変わりません。

管理者 PowerShell で、実際のストレージと既存 Application Pool を指定します。
入力原本は `public/` と Git 管理対象の外に置きます。

```powershell
# 初回登録・更新（同じコマンド）
.\scripts\set-password-blocklist.ps1 `
  -StorageDir C:\NetariumData `
  -ApplicationPoolName Netarium `
  -DictionaryFile C:\ProtectedInputs\additional-passwords.txt

# 明示的な解除
.\scripts\set-password-blocklist.ps1 `
  -StorageDir C:\NetariumData `
  -ApplicationPoolName Netarium `
  -Disable

# アプリと同じストレージを指定して診断
php .\scripts\check-install.php --app-root=C:\Netarium --storage-dir=C:\NetariumData
```

CLI は `<StorageDir>\password-blocklist` に LF 統一済み本文を `dictionary-<SHA-256>.txt` として保存し、SHA-256・byte 数・件数を記録した兄弟ファイル `<StorageDir>\password-blocklist.json` をアトミックに切り替えます。
SYSTEM と Administrators だけに書込みを許可し、対象 Pool は読取専用とします。
継承 ACL、所有者、再解析ポイント、容量、入力検証が不適合なら登録を拒否します。
更新失敗時は既存の有効 manifest を維持し、未登録データを有効扱いしません。

有効登録後の manifest・本文の欠損、本文領域全体の欠損、改変、件数不一致では、新規パスワード設定と配備診断が失敗します。
自動で PWDB だけへ戻しません。
本文の手編集や `password-blocklist.json` の削除で解除せず、`-Disable` で明示的に切り替えます。
切替中の要求は開始時に読んだ世代を使うため、切替直後に古い本文を削除しません。
不要世代を削除する場合は、受付停止・要求排出・Pool 停止後に有効 manifest が参照しない本文だけを削除します。

追加辞書はプログラム更新・rollback で保持し、Web ZIP、完全バックアップ ZIP、更新 rollback snapshot には含めません。
管理者が本文領域 `password-blocklist` と兄弟 manifest `password-blocklist.json` を組として、別系統の保護された保管先へ退避します。
全損復旧では、一般利用の再開前に両方を復元して専用 ACL を適用し、同じストレージで `check-install.php` を実行します。
破損時は正規原本を CLI で再登録するか、保全した世代全体を停止中に復元します。
追加辞書を使う運用で復旧資材がない場合、未設定での再開を自動承認しません。
旧アプリへの rollback では任意辞書を参照しないため、拒否範囲の縮小を運用責任者が判断します。

<a id="ログインの並行試行と中断204"></a>

### ログインの並行試行と中断

ログインは照合前にユーザー名単位の枠をDBへ予約します。失敗と照合中の予約を合わせて5枠に達すると300秒間制限し、照合成功時は予約を含めて解除します。残り1枠で別セッションから同時送信した場合は一方だけが照合へ進み、他方は正しい値でも制限表示になります。先行要求が成功した場合は再試行できます。CSRF不正と不適合なユーザー名は枠を消費しません。

worker停止や照合後のDB保存障害でも、取得済みの枠は消費したまま残します。中断を利用した枠の再利用を防ぐためです。DB busyの503を認証失敗の確定や資格失効と同一視せず、競合解除後に再試行します。制限が残る場合は期限まで待つか、本人確認のうえで既存の管理者再設定・復旧CLIを使います。DB全体のロックを照合中に保持する方式は採用していません。




## Ping

Pingは管理者がWindowsの`ping.exe`で行う手動疎通確認です。機器台帳でチェックした機器を対象とし、表示外の選択も含めた件数を確認して実行します。NGだけ再実行する場合は「選択を解除」→状態「NG」→再チェック→「Ping」の順に操作します。閲覧者は結果の確認のみ可能です。

既定ではプライベートIPv4だけを許可し、一回100件まで、1台ずつ実行します。個別タイムアウトは1,000ミリ秒、全体のソフト期限は120秒です。全体期限後は未実行の機器をスキップし、完了済みの結果を保存します。IPなし・形式不正・許可外IPもスキップ理由として表示します。構成更新による409では結果を保存せず、通信切断時は再読み込みで保存結果を確認してください。

Ping成功はHTTP、HTTPS、SSHサービスの正常性を保証しません。ICMPを拒否する機器は稼働中でもNGになる場合があります。

## CSV

CSV出力は保存済みの機器台帳全件を19列（保守接続情報を含む新形式）で出力します。CSV取込はUTF-8、最大2MiB、最大5,000データ行です。19列のヘッダー完全一致が必須であり、旧13列CSVや未知の列はエラーとして拒否されます。エラーが一件でもある場合は確定できません。

CSV取込は機器台帳だけを変更し、配置、リンク、ビュー、図面、機器画像は変更しません。新規機器は未配置として登録されます。

## 監査ログ運用

### 保管先とファイル仕様

監査ログは`<storage_dir>/logs/audit`（既定は`<InstallRoot>\data\logs\audit`）へJSON Lines形式で保存されます。IISのDocumentRootである`public/`の外に配置され、Web経由での直接参照はできません。また、閲覧用のHTTP API（viewer/admin向け）は提供せず、サーバー管理者のみがOSのファイルアクセス権限を用いて直接閲覧・確認します。

各行はUTC RFC3339タイムスタンプ、32桁16進数の調査用ID（`request_id`）、イベント名、結果（`started` / `success` / `failure` / `post_processing_required`）、操作者ID、対象種別・ID・件数、データリビジョン、HTTPステータス等を含みます。パスワードや秘密情報、リクエスト本文などの任意データは記録されません。

ファイル名は`audit-YYYYMMDD-NNN.log`形式で管理され、1ファイル最大10MiBでローテーションします。

<a id="認証認可csrf拒否とログアウト199"></a>

### 認証・認可・CSRF拒否とログアウト

API・通常ページのアクセス拒否とログアウトは、開始行を作らず単一の終端行で記録します。API拒否では保存に成功した場合だけ応答に`request_id`を付けます。通常ページの認証拒否は既存のログイン／本人パスワード変更ページへのリダイレクトを維持し、監査上は拒否の種別を401／403で示します。

| イベント | `codes`の理由 | 結果・監査上のHTTPステータス |
| --- | --- | --- |
| `auth.authentication_denied` | `authentication_required` | `failure`・401 |
| `auth.authorization_denied` | `password_change_required` | `failure`・403 |
| `auth.authorization_denied` | `insufficient_role` | `failure`・403 |
| `auth.csrf_denied` | `invalid_csrf` | `failure`・403（API・ログアウト） |
| `auth.logout` | `logout` | `success`・302 |

記録する主体はセッション上の利用者IDだけです。未認証・失効済みセッションでは`null`とし、ログアウトでは破棄前のIDを保持してセッション破棄後に記録します。これらの行にユーザー名、パスワード、hash、CSRF・session token、Cookie、IP、URL・action、入力本文、任意の対象情報は含めません。既存のログイン監査（`auth.login`）と業務操作の開始・終端監査は変更しません。

反復要求の記録は、全worker・全利用者で共有する理由別の上限で抑制します。Unix時刻を60秒ごとに区切った各窓で最初の10件を記録し、11件目は`audit.security_suppressed`（`failure`、主体・HTTPステータスは`null`、`codes=[理由, "rate_limited"]`）を1件だけ記録します。以後はその窓の追記を省略します。これは抑制開始の印であり、抑制総件数や個々の主体を示すものではありません。他の理由の枠は維持し、次の窓で記録を再開します。

枠は監査追記前に消費するため、容量不足などで保存できなかった試行も上限に含まれます。共有状態は`.security-window`の固定5キー・最大4KiBで管理し、既存の`.lock`内で更新します。ファイルの破損・容量超過・読書き不能では拒否／ログアウト監査を省略します。週次点検時に状態ファイルの読書きとJSON形式も確認し、修復は要求を停止してから行ってください。正常な状態ファイルを定期削除すると洪水制限がリセットされるため、削除は保守手順に含めません。

監査ロックの競合・保存不能時にも、401／403の拒否、通常ページのリダイレクト、ログアウトのセッション破棄を維持します。これらの記録はロックを待たず、業務操作の最終記録用予約と通常業務用の16MiBの空き容量を残せない場合も省略します。要求ごとの保存障害をPHPエラーログへ転記せず、この監査処理に由来する別ログへの洪水を防ぎます。IISアクセスログ等の記録量は別管理です。一方、省略された要求をアプリ監査だけから復元することはできず、通常業務自体が残り容量を消費すれば従来どおり監査付き操作が503になります。

別系統のログ保管と自動警告通知は備えていないため、週次点検を継続します。検知遅延とローカルログの改ざんリスクは運用上の制約として運用記録に残し、定期点検で見直します。SIEM・SMTP等の新基盤は組み込みません。

### 保持期間と容量制限

監査ログの保持期間は90日です。追記時に90日を経過した古い監査ファイルのみが自動的に削除されます。容量不足を理由に90日以内のファイルを自動削除することはありません。

監査ログファイルの合計容量上限は256MiBです。合計サイズが256MiBを超える追記は拒否され、監査を必要とする業務操作ではWeb APIがHTTP 503、CLIが非ゼロ終了となり、PHPエラーログへ固定文言が記録されます。上記の拒否・ログアウト監査は例外で、追記できなくても既存の拒否・セッション破棄を維持します。共有状態ファイル（最大4KiB）と排他・予約ファイルは別に管理します。

同時実行中の操作には、開始時点で最終記録用の容量を個別に確保します。空き容量が上限に近い場合は、現在のファイル合計が256MiB未満でも新しい操作を拒否します。操作中の予約ファイル（`.pending-<request_id>`）は終了時に削除し、異常終了で残ったものは次の操作開始時に整理します。

### 保守と障害調査

1. **定期保守（週次）**:
   停止期間中などに90日を超過した監査ログを整理するため、管理者用CLIを定期実行します。
   ```powershell
   php C:\Netarium\app\scripts\prune-audit-logs.php
   ```
   併せて、`data/logs/audit`配下の合計ファイルサイズを点検してください。期限切れファイルを削除できない場合、CLIは非ゼロで終了するため、権限やファイルの状態を確認してください。

2. **HTTP 503エラー発生時の対処**:
   管理操作時にHTTP 503（または「監査ログの記録に失敗しました」「監査ログの容量上限を超過しました」）が発生した場合、データ整合性を保護するため操作前の状態のまま安全に処理が停止しています。ディスクの空き容量、`data/logs/audit`および`.lock`に対するIIS実行ユーザーの書込権限を確認・復旧した後に、再度操作を実行してください。

3. **未完了記録の調査**:
   監査ログ内に`outcome="started"`行のみが存在し、対応する`success`または`failure`の行が存在しない場合、Webサーバープロセスの強制終了、PHPのタイムアウト、またはサーバーマシンの停止等の中断が発生した可能性があります。調査ID（`request_id`）をもとに、同時刻のIISログ、PHPエラーログ、Windowsイベントログを照合して原因を特定してください。

4. **復元ログとの照合**:
   バックアップ復元操作の成否は、`data/logs/restore.log`に記録される新規行の`request_id`と、`data/logs/audit`内の同一`request_id`の記録を照合することで、復元トランザクションおよび付随する後処理の実行結果を追跡できます。

5. **特定の調査ID（`request_id`）の抽出と確認**:
   画面エラーやAPIレスポンスに表示された調査IDをもとに該当レコードを確認する場合、サーバー上のPowerShellで次のように抽出・JSON展開して確認します。
   ```powershell
   Get-Content C:\Netarium\app\data\logs\audit\audit-*.log |
     Select-String "<調査ID (32桁hex)>" |
     ForEach-Object { $_.Line | ConvertFrom-Json }
   ```
   特定日のファイル（例: `audit-20260923-*.log`）に絞り込んで検索することも推奨されます。

## 定期確認

週次でIIS・PHPエラーログ、`data/logs/restore.log`、`data/logs/audit`の容量点検と`scripts/prune-audit-logs.php`の実行、`data/temp`、データ品質診断を確認します。復元作業領域の件数・容量と`scripts/prune-restore-previews.php`の終了コードも点検し、残留や削除失敗は[復元プレビューの回収手順](#復元プレビューの保持上限と回収197)で対処します。月次または定期保守時にサーバ外バックアップの確認、隔離された検証環境での復元試験、アカウント棚卸し、証明書期限を確認します。

## アンインストール

NetariumのIIS Siteとリリース配布物を撤去する手順です。隔離環境で[開発ガイド（配備の確認）](development.md#配備スクリプトの確認)のために空の環境へ入れ直す場合は、退避を確認したうえで`-RemoveData`を選び、旧DBと旧設定を再利用しないようにします。更新の失敗を元に戻す場合はアンインストールせず、[更新ガイドのロールバック](update.md#自動ロールバック)を使用してください。実行するスクリプトは、削除する`InstallRoot`内ではなく、保全したリリースまたは`C:\staging\netarium`など別の場所から呼び出します。管理者PowerShellとIIS管理用`WebAdministration`が必要です。

### 撤去前の確認

1. 利用停止を周知し、対象Site名、Application Pool名、物理パス`<InstallRoot>\public`、PHP Handlerの`php-cgi.exe`、BindingをIISで照合します。撤去前に`version.php`の配備版数を記録します。同名Siteでも物理パスやPoolが違う場合は停止し、別配備を巻き込まないよう調査してください。`-PhpCgiPath`は省略できますが、指定する場合は実際のPHP Handlerと一致させます。
2. Web構成情報ZIPまたはサーバー完全バックアップ（`scripts/backup-full.ps1`）を取得してサーバ外に保存し、`data/`（利用者、監査ログ、DB、画像を含む）と`config/app.php`、更新のrollback snapshotに必要な情報を別途保全します。Web構成情報ZIPに利用者アカウントと監査ログは含まれません。`-RemoveData`を指定する場合は、サーバ外の退避先と復元方法を確認してから作業します。
3. 同じPoolを使用する他Site・アプリケーション、同じFastCGI登録を参照する他SiteのHandlerを確認します。共用中ならPoolやFastCGIを無断で削除せず、利用先の構成管理者と切り離しを調整します。Site限定`location`はNetarium Siteのものだけを対象とし、サーバ全体のセクションロックや他Siteの設定は変更しません。
4. `-Protocol existing`でsetup前から存在した同名SiteとBindingを再利用した構成でも、撤去時は**SiteとそのBindingを削除**します。既存Siteの廃止について運用承認を取り、Bindingが必要なら事前に別の管理対象へ移行してください。DNS、証明書・秘密鍵、PHP本体、`php.ini`、サーバ全体のIIS機能と接続元制限はこのスクリプトの撤去対象ではありません。

対話実行で`-InstallRoot`、`-SiteName`、`-ApplicationPoolName`を省略すると、それぞれ`InstallRoot [C:\Netarium\app]`、`SiteName [Netarium]`、`ApplicationPoolName [Netarium]`が表示され、Enterで標準値を選べます。Pool名の既定値は選択したSite名です。引数で指定した値が優先されます。`C:\Netarium`は標準構成の設置先ではなく親ディレクトリのため、IISの物理パス`C:\Netarium\app\public`と照合してから選択してください。`-NonInteractive`では既定値を自動採用せず、3つとも明示的に指定しないと撤去前に停止します。対話・非対話のどちらも所有権確認と`-RemoveData`の確認条件は同じです。

まず、削除対象を変更せず表示する`-WhatIf`を実行し、表示したSite、Pool、FastCGI、パスと保持対象を確認します。`-RollbackRoot`の省略値は`<InstallRoot>-rollback`（例: `C:\Netarium\app-rollback`）です。別の場所にsnapshotを作成した場合は、その実際のパスを明示してください。

```powershell
Set-Location C:\staging\netarium
powershell -ExecutionPolicy Bypass -File .\scripts\uninstall-iis.ps1 `
  -InstallRoot C:\Netarium\app `
  -SiteName Netarium `
  -ApplicationPoolName Netarium `
  -PhpCgiPath C:\php\php-cgi.exe `
  -WhatIf
```

対象と保全先を確認した後、同じ引数で`-WhatIf`を外して実行します。自動実行では`-NonInteractive`を指定します。既定では`data/`、`config/app.php`、rollback snapshotを保持し、リリースマニフェストの`public/`、`src/`、`templates/`、`scripts/`、ルートPHPと`config/app.example.php`を削除します。`config/app.php`を含む`config/`全体、`data/`、`RollbackRoot`も廃棄するときだけ`-RemoveData`を追加してください。`-RemoveData -NonInteractive`には、保全を確認した操作者の明示的な承認として`-Force`も必要です。`-Force`だけではデータ削除を要求しません。
対象Siteが既になく、指定したPoolだけが残る場合、そのPoolが当該配備のものとは確認できません。スクリプトはPoolを保持して警告を出し、他の確認済み対象だけを撤去します。残ったPoolは管理者が撤去前のIIS構成と利用状況を照合し、所有者を確認してから手動で削除してください。Site削除後にPool削除が失敗した場合も同じ扱いです。

通常撤去ではApplication Poolのユーザープロファイルも保持します。`-RemoveData`では、指定Pool名に対応する仮想アカウントのSID（`S-1-5-82-…`）でプロファイルを特定し、Poolの撤去後にWindowsのプロファイル削除機能で登録情報とフォルダーを削除します。フォルダー名だけでは判定せず、通常のローカルユーザーや独自の実行アカウントのプロファイルは削除しません。通常撤去後に`-RemoveData`を実行する場合も、保持した`config/app.php`等で配備先を確認したうえで対象にします。他Site・アプリケーションのPool参照が残る場合は撤去を中止し、所有不明のPoolを保持する場合はそのプロファイルも保持します。

プロファイル内の一時ファイルや保存データも削除されるため、`-RemoveData`の実行前に必要なものを退避してください。削除時にプロファイルがまだロードされている場合、スクリプトはエラーで停止し、プロファイルと配備先のデータ・設定を保持します。ワーカープロセスの終了とプロファイルの解放を確認してから、同じ引数で再実行してください。`-WhatIf`ではプロファイルのパスとSIDを表示するだけで、削除しません。

`-RemoveData`では、撤去前に`RollbackRoot`直下の各snapshotディレクトリの`manifest.json`を検査します。`TargetPath`が`InstallRoot`、`SnapshotPath`がそのディレクトリの絶対パス、`SiteName`と`ApplicationPoolName`が指定値に一致しないsnapshotは削除しません。`update.lock`というファイル以外の不明なファイル、`manifest.json`を持たないディレクトリも検査で拒否します。拒否されたら内容と所有者を調べ、別配備のsnapshotや未確認ファイルをこの操作で削除しないでください。

```powershell
# データとrollback snapshotも廃棄する承認を得た非対話実行例
powershell -ExecutionPolicy Bypass -File .\scripts\uninstall-iis.ps1 `
  -InstallRoot C:\Netarium\app `
  -SiteName Netarium `
  -ApplicationPoolName Netarium `
  -PhpCgiPath C:\php\php-cgi.exe `
  -RemoveData -Force -NonInteractive
```

### スクリプトを使用できない場合の手動撤去

手動操作は自動の参照検査やロールバックを行いません。管理者が作業前のIIS構成をバックアップし、以下を同じ管理者PowerShellセッションで、各確認に成功した場合だけ順に実行します。`-RemoveData`相当の操作は最後の手順まで行いません。

1. `Import-Module WebAdministration`を実行し、`Get-Website -Name Netarium | Select-Object Name,PhysicalPath,ApplicationPool,Bindings`で対象Siteの物理パスが`C:\Netarium\app\public`、Poolが`Netarium`であることを確認します。`Get-WebApplication -Site Netarium`でSite配下の追加アプリケーションがないこと、`C:\Netarium\app\config\app.php`の`storage_dir`が当該配備の`data/`を指すことも照合します。`Get-WebConfigurationProperty -PSPath 'IIS:\Sites\Netarium' -Filter 'system.webServer/handlers/add' -Name '.'`でPHP Handlerの`scriptProcessor`が想定した`C:\php\php-cgi.exe`を指すことを確認し、違う場合は撤去を中止します。IIS構成の保存には`$appcmd = Join-Path $env:windir 'System32\inetsrv\appcmd.exe'`を設定し、`& $appcmd add backup ('netarium-before-uninstall-' + (Get-Date -Format 'yyyyMMddHHmmss'))`を実行します。`$LASTEXITCODE`が0以外なら続行しません。
2. `Get-Website`と`Get-WebApplication`で他Site・アプリケーションに同名Poolが割り当てられていないか調べます。FastCGIについては他Siteとその配下のアプリケーションのPHP Handlerを調べ、同じ`scriptProcessor`を使う場所を記録します。参照が残るPoolやFastCGIの削除は中止し、利用先の管理者と調整してください。
3. `if ((Get-WebSiteState -Name Netarium).Value -eq 'Started') { Stop-Website -Name Netarium }`で対象Siteを停止します。FastCGIをこの配備専用として廃止する場合は、SiteのPHP Handlerと他Site・アプリケーションの参照を再確認したうえで、`Remove-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' -Filter 'system.webServer/fastCgi' -Name '.' -AtElement @{fullPath='C:\php\php-cgi.exe'}`でその登録のみ削除します。共用または所有不明なら残します。FastCGI削除に失敗した場合はSiteを残し、原因を確認してから再実行してください。続けて`Get-WebConfigurationLocation -Name Netarium -PSPath 'MACHINE/WEBROOT/APPHOST'`で対象Siteの`location`だけを確認し、存在する場合は`Remove-WebConfigurationLocation -Name Netarium -PSPath 'MACHINE/WEBROOT/APPHOST'`で削除します。`Remove-Website -Name Netarium`でSiteとBindingを削除します。他Siteの`location`やサーバ全体のロック設定は残します。
4. 他Site・アプリケーションがPoolを使っておらず、手順1で対象Siteとの対応を確認した場合だけ、`Stop-WebAppPool -Name Netarium`（稼働中の場合）と`Remove-WebAppPool -Name Netarium`を実行します。作業開始時にSiteが既になくPoolの所有者を確認できない場合は、Poolを削除せず管理者が撤去前のIIS構成と利用状況を照合します。
5. 撤去する配布物を`C:\Netarium\app`で列挙し、配布物と親パスにシンボリックリンク・ジャンクション等の再解析ポイントがないことを確認します。`public/`、`src/`、`templates/`、`scripts/`、`bootstrap.php`、`version.php`、`config/app.example.php`だけを削除します。認証・DB実装は`src/`に含まれます。追加した独自ファイルは勝手に削除せず、管理者が所有者を確認してください。既定では`data/`、`config/app.php`、rollback snapshotを保持します。
   - 旧版の配布物としてルート`auth.php`・`database.php`が残る場合は、旧リリース／snapshotのInventoryと所有者を照合し、`RetiredFiles`に該当する旧配布物として撤去します。新配布物ではありません。通常の更新時は[更新ガイド](update.md)に従い、snapshot取得前に削除しません。

```powershell
$InstallRoot = 'C:\Netarium\app'
foreach ($relativePath in @(
    'public', 'src', 'templates', 'scripts',
    'bootstrap.php', 'version.php',
    'config/app.example.php'
)) {
    # 旧配布物を撤去する場合は、所有者とInventoryを確認した後に
    # auth.php / database.phpを削除対象へ追加する。
    $target = Join-Path $InstallRoot $relativePath
    if (Test-Path -LiteralPath $target) {
        Remove-Item -LiteralPath $target -Recurse -Force
    }
}
```

6. データ廃棄の承認とサーバ外バックアップを確認済みの場合に限り、`$RollbackRoot = 'C:\Netarium\app-rollback'`など実際のsnapshotの保存先を特定します。パスが他配備や`InstallRoot`と重複せず、削除対象ツリーに再解析ポイントがないことに加え、`RollbackRoot`直下の各ディレクトリの`manifest.json`で`TargetPath`、`SnapshotPath`、`SiteName`、`ApplicationPoolName`を前述の条件どおり照合してください。`update.lock`ファイル以外の未知の項目があれば削除を止めます。`config/`に独自設定があれば先に所有者を確認します。通常撤去ではここから手順8までを実行せず、プロファイルとデータ・設定を保持します。

7. 完全撤去では、手順1で配備先とPoolの対応を確認できた場合だけ、次のコードで仮想アカウント用プロファイルを削除します。通常撤去後に続けて完全撤去する場合も同じ指定Pool名を使います。別セッションで作業を再開する場合は、撤去前のIIS構成、保持した`config/app.php`とsnapshotの記録で対象との対応を確認してください。所有不明のPoolはプロファイルも保持し、確認なしでこのコードを実行しません。必要なプロファイル内のデータを退避し、Poolが撤去済みで他Site・アプリケーションの参照がないことを再確認します。フォルダー名からではなく、スクリプトと同じ方法でPool名から求めたSIDで特定します。

```powershell
$ErrorActionPreference = 'Stop'
$ApplicationPoolName = 'Netarium' # 実際の撤去対象Pool名
if (Test-Path -LiteralPath "IIS:\AppPools\$ApplicationPoolName") {
    throw 'Poolが残っているため、プロファイル削除を中止します。'
}
foreach ($site in @(Get-Website -ErrorAction Stop)) {
    $applications = @(Get-WebApplication -Site $site.Name -ErrorAction Stop)
    if ($site.ApplicationPool -ieq $ApplicationPoolName -or
        @($applications | Where-Object { $_.ApplicationPool -ieq $ApplicationPoolName }).Count -gt 0) {
        throw '他Site・アプリケーションのPool参照が残っています。'
    }
}
$sha = [System.Security.Cryptography.SHA1]::Create()
try {
    $hash = $sha.ComputeHash([System.Text.Encoding]::Unicode.GetBytes($ApplicationPoolName.ToLowerInvariant()))
} finally {
    $sha.Dispose()
}
$PoolProfileSid = 'S-1-5-82-' + ((0..4 | ForEach-Object {
    [System.BitConverter]::ToUInt32($hash, ($_ * 4))
}) -join '-')
$profile = Get-CimInstance -ClassName Win32_UserProfile -Filter "SID='$PoolProfileSid'" -ErrorAction Stop
$PoolProfilePath = $null
if ($profile) {
    $PoolProfilePath = $profile.LocalPath
    $profile | Select-Object SID, LocalPath, Loaded, Special | Format-List
    if ($profile.Loaded -or $profile.Special) {
        throw 'ロード中またはSpecialのため、プロファイルとデータ・設定を保持します。'
    }
    Remove-CimInstance -InputObject $profile -ErrorAction Stop
}
if ((Get-CimInstance -ClassName Win32_UserProfile -Filter "SID='$PoolProfileSid'" -ErrorAction Stop) -or
    ($PoolProfilePath -and (Test-Path -LiteralPath $PoolProfilePath))) {
    throw 'プロファイルの登録またはフォルダーが残っています。データ・設定の削除を中止します。'
}
```

ロード中または削除失敗で停止した場合は手順8へ進まず、データ・設定を保持してください。ワーカープロセスの終了とプロファイルの解放、失敗原因の解消を確認してから手順7を再実行します。通常ユーザーや独自の実行アカウントのプロファイルは、この仮想アカウントSIDに一致しないため削除対象になりません。

8. 手順6の対象確認と手順7のプロファイル削除・確認が成功した場合だけ、`Remove-Item -LiteralPath "$InstallRoot\data" -Recurse -Force`、`Remove-Item -LiteralPath "$InstallRoot\config" -Recurse -Force`、`Remove-Item -LiteralPath $RollbackRoot -Recurse -Force`を実行します。既に存在しないパスは削除不要です。`InstallRoot`の親やPHP本体は削除しません。

最後に、`Get-Website -Name Netarium`、`Test-Path 'IIS:\AppPools\Netarium'`、`Get-WebConfigurationLocation -Name Netarium -PSPath 'MACHINE/WEBROOT/APPHOST'`で撤去対象が残っていないことを確認します。FastCGIを専用として削除した場合はその登録も確認し、共用のため残した場合は利用先で動作を確認してください。ファイルはマニフェストの各パスがなくなったこと、保持指定なら`data/`、`config/app.php`、rollback snapshotが残っていることを`Test-Path`で照合します。サービスFQDNのDNS登録と証明書は別の管理者の責任範囲です。不要なら組織のDNS・証明書廃止手順で個別に整理してください。

完全撤去では、同じセッションの`$PoolProfileSid`を使って`Get-CimInstance -ClassName Win32_UserProfile -Filter "SID='$PoolProfileSid'" -ErrorAction Stop`が何も返さないことと、削除前に取得した`$PoolProfilePath`がある場合は`Test-Path -LiteralPath $PoolProfilePath`が`False`になることを確認します。`data/`、`config/`、`RollbackRoot`の各パスがなくなったことも確認してください。通常撤去ではこの削除確認を行わず、プロファイルを保持します。

