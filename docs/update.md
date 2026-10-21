# Netarium更新・ロールバックガイド

既に`<InstallRoot>\public`を公開している同じIIS Siteを、`scripts/update.ps1`で更新する手順です。新規配備とsetup再実行は[配備ガイド](deployment.md)、サーバ全損復旧・撤去は[運用ガイド](operations.md)を参照してください。旧配置からの移行、別Siteへの切り替え、手作業でのプログラム上書きは本手順の対象外です。

## 更新前の確認

- [配備ガイドの前提条件](deployment.md#前提条件)を満たし、管理者PowerShellとIIS管理用`WebAdministration`を用意します。要求排出にはIISの要求監視機能が必要です。
- 対象SiteとApplication Poolが存在し、Siteの物理パスが`<InstallRoot>\public`であることを確認します。PHP Handler、`php-cgi.exe`、サービスFQDN、Binding、HTTPS証明書と確認先URLを照合し、別Siteを検査しないようにします。
- `SourcePath`に新リリースを用意します。必要なファイルと実行時データを混在させない条件は[リリースの準備](deployment.md#1-リリースを用意する)に従います。
- `SourcePath`、`InstallRoot`、`RollbackRoot`を相互に重複・包含しないパスにします。`RollbackRoot`の省略値は`<InstallRoot>-rollback`です。スナップショットを保管できる空き容量とアクセス権を確認します。
- 利用者へ停止時間を周知し、未保存変更がないことを確認します。
更新前にバックアップを取得してサーバー外に保管します。
全損に備える場合は完全バックアップ CLI（`scripts/backup-full.ps1`）で SQLite DB 全体と画像実体を一体取得します。
現行の Web 構成情報 ZIP は `netarium-config` 形式 1／DB スキーマ 11 専用であり、旧画像同梱形式 2〜7 は復元できません。
完全バックアップおよび Web 構成情報バックアップは、DB スキーマ 11 と明示的に許可したアプリ版の組を要求します。
復元先 `1.0.3` ではバックアップ元 `1.0.3`・`1.0.2`・`1.0.1`・`1.0.0`、復元先 `1.0.2` では `1.0.2`・`1.0.1`・`1.0.0`、復元先 `1.0.1` では `1.0.1`・`1.0.0`、復元先 `1.0.0` では `1.0.0` のみを受け付けます。
`0.3.0` 以前のバックアップや、新版から旧版への逆方向（`1.0.3 → 1.0.2`、`1.0.2 → 1.0.1` など）は直接復元できません。
そのため、更新前に取得した旧版のバックアップは、対応する旧版のプログラム資材および更新時スナップショットとともに外部へ保全してください。
利用者アカウント・監査ログ・環境固有設定は Web ZIP に含まれないため、[保護対象と保管方法](operations.md#復旧責任と保護対象)も確認します。
- 新リリースの `check-password-runtime.php` を PHP CLI と指定 CGI で実行し、Argon2id 生成・全入力照合と初期 cost を確認します。
`update.ps1` も保守・差替え前に検査し、非対応時の bcrypt fallback は行いません。
直接 CGI 検査は [開発ガイド（配備の確認）](development.md#配備スクリプトの確認) を代替しません。

## 更新手順

管理者PowerShellで、配布元の新リリースルートから実行します。`VerificationUrl`は実際に到達できる対象SiteのルートURLです。

```powershell
Set-Location C:\staging\netarium
powershell -ExecutionPolicy Bypass -File .\scripts\update.ps1 `
  -SourcePath C:\staging\netarium `
  -InstallRoot C:\Netarium\app `
  -SiteName Netarium `
  -ApplicationPoolName Netarium `
  -PhpCgiPath C:\php\php-cgi.exe `
  -VerificationUrl https://netarium.example.local/
```

スクリプトは`<RollbackRoot>\update.lock`を排他的に取得し、`app_offline.htm`と対象SiteのIIS規則で新規要求を保守応答にします。要求排出が`-DrainTimeoutSeconds`（既定120秒）以内に完了しなければ、データとプログラムを変更せず、保守状態を残して終了します。排出後はSite・Poolを停止し、スナップショットを作成してからプログラムを差し替えます。

更新対象はリリースマニフェスト内の`public/`、`src/`、`templates/`、`resources/`、`scripts/`、`bootstrap.php`、`version.php`、`config/app.example.php`です。`resources/password-blocklist/`はWeb非公開で、実行IDは読取のみとします。`data/`と`config/app.php`は保持します。DBスキーマの更新にはアプリケーションの既存マイグレーションを使用します。スキーマを手動SQLで変更しません。

旧構成移行前の旧版にあるルート`auth.php`・`database.php`は、新配布物には含みません。配備スクリプトは`RetiredFiles`として旧配布物を管理し、更新前snapshotへ元の存在・内容を退避してから撤去します。rollbackでは存在していた旧ファイルを元の内容で復元し、元から存在しなかった場合は作成しません。手動で先に削除・新版への上書きを行うと旧版復帰に必要なファイルを失うため、退避・撤去は`update.ps1`に任せます。`deployment-manual.md`を手動更新へ転用しません。

CLI確認は保守状態で実行します。その後、保守応答を確認し、保守状態を解除してHTTP確認と`verify-security.ps1`を行います。`login.php`が200、未認証`api.php`が401、`setup.php`が302または404、非公開パスが403または404であることを確認します。HTTP確認に失敗した場合も自動ロールバックの対象です。

成功時に表示されるスナップショットのパスと実行ログを保管し、管理者がブラウザで再ログインし、保存・図面など必要な操作を確認してから利用再開を通知します。
1.0.0 への更新完了後は、正常稼働を確認した後に速やかに 1.0.0 環境の停止型完全バックアップ（`scripts/backup-full.ps1`）を新規に取得し、外部へ保管してください。
files セッションの保存先は有効な `storage_dir` 配下の `sessions` へ固定するため、旧 PHP 設定の保存先からセッションを引き継ぎません。
旧保存先に残るファイルは自動で一括削除せず、対象アプリ・handler・共有有無を特定した後に運用上の失効を行います。
機械試験と人手確認の範囲は [開発ガイド（配備の確認）](development.md#配備スクリプトの確認) を参照してください。

更新前に、[PHPログ保存先とACL](deployment.md#php-error-log)を確認します。`update.ps1`はsetupのPHPランタイム事前検査を実行しません。`error_log`の設定値が非空でも、実際のPoolが追記できなければ正常な503応答がIISで500へ変わることがあるため、設定変更後は隔離IISで応答とログ追記を確認してから適用します。

## 自動ロールバック

更新途中でスナップショット作成後に失敗すると、プログラム、DB、図面・機器画像、バックアップ、一時領域、`config/app.php`、IISのSite・Pool・FastCGI・Handler・要求制限・環境変数を同じスナップショットから復元します。セッションファイルは退避も復元も行いません。監査履歴と復元ログを保全するため、既存の`data/logs`は削除・上書きしません。ログ領域がない場合だけスナップショットから復元します。

スナップショットには`InstallRoot`、`public`、`src`、`templates`、`resources`、`scripts`、`config`、実行時データディレクトリのアクセスACLも保存します。IIS再開前にACLを復元しますが、機密領域は保存済みの広範なReadを戻さず、[必要主体だけのACL](operations.md#機密領域のaclとスナップショット)を再適用します。ACL記録のない旧スナップショットでも機密領域を保護し、管理者が復元後の権限を確認します。要求サイズ上限は数値として保存します。削除済みSiteを再作成するときは保存済みBindingの接続先を使い、一時的なホスト名なしの80番Bindingを作成しません。

新しいスナップショットは`Version=2`で、manifestの`Iis.AppPool.Password`は`null`、IIS秘密は`iis-secrets.bin`へDPAPI LocalMachineで暗号化して保存します。秘密の書込み前からスナップショット全体をSYSTEM・Administrators専用ACLで保護し、復元対象のファイル・IISを変更する前に復号可能性を検査します。同一ホストの別管理者は復元できますが、別ホストでは秘密を復号できずrollbackできません。ホスト移行・全損復旧はバックアップZIPと承認済み構成記録による再構築を使い、IIS資格情報を再設定します。旧形式の平文秘密を含む退避は勝手に削除せず、管理専用ACLで保護して復旧用に保管します。

Bindingの削除は`applicationHost.config`の対象Siteを名前で指定した`bindings`コレクションに限定します。同じBindingを持つ別Siteへ削除が及ばないよう、`Remove-WebBinding -Name ... -BindingInformation ...`には依存しません。HTTPS新規配備時の一時HTTP Binding削除も同じSite限定方式です。

自動ロールバックでは復元した旧リリースでCLI確認を実行し、短時間だけ保守ページを再設定してからSiteを再開し、HTTP確認を行います。ロールバックに成功しても更新自体は失敗であり、元の失敗理由を表示して終了コード1になります。復旧後は`check-install.php`と`verify-security.ps1`を実行し、更新の原因調査を行ってから再適用を判断してください。

<a id="パスワード移行後のrollback169"></a>

### パスワード移行後のrollback

全SQLite・設定の復元は旧bcrypt、旧秘密、旧世代と`allow_legacy_bcrypt=true`を復活させ得ます。ZIPはusersを含まないため、ZIP復元とは扱いが異なります。旧コードの`password_verify()`は対応PHP上でArgon2idを照合できますが、旧アプリの新規設定ではbcryptが再生成されます。Argon2id非対応PHPへの復帰は認めず、PHP・アプリ・DB・設定を組み合わせて隔離確認します。旧コードは新しい設定キーを拒否するため、旧設定への復元による移行期間再開も運用判断です。

PHPセッションはDBと別管理であり、Site・Pool停止だけでは失効しません。DB世代を巻き戻すと、変更後にまだ要求していない旧セッションが再び一致する可能性があります。自動rollbackはセッション掃除やアカウント再移行を行わないため、その成功だけで利用再開を許可しません。対象アプリの保存先・セッションhandler・共有有無を確認し、承認した復元では停止・要求排出後に対象セッションを失効させ、旧秘密の再移行と旧照合許可を確認してから再開します。他アプリと共有するセッション領域を一括削除しません。継続利用者がいる移行後のrollbackは、自動復帰の利用可否と停止維持を事前に運用承認してください。

旧アプリへrollbackすると、その版がPHP設定の旧session保存先を再び使う場合があります。保存先・共有範囲・実効ACLを再確認し、対象の旧セッションを失効させてから再開します。今回の`sessions`固定だけで、復元した旧コードの保存先も保護済みとは扱いません。

<a id="初回変更補完対策導入後のrollback170"></a>

### 初回変更・補完対策導入後のrollback

更新でDBスキーマ9から10へ移行します。既存利用者の強制状態は0のままです。更新後の新規発行・管理者再設定・CLI復旧には初回本人変更が必要となります。`check-install.php`の`password_blocklist_available=true`と`must_change_password_users`を確認し、データ欠損を無効化で回避しません。

スキーマ10への移行後は、対応しない旧アプリが起動を拒否します。現行のスキーマは11です。列を削除したり`user_version`だけを戻したりせず、同じsnapshotのプログラム・DB・設定を組として復元してください。新版を含むsnapshotでは拒否リストと`resources`のACLも復元します。Web ZIPは`netarium-config`形式1／スキーマ11で構成と画像参照メタデータだけを出力し、[互換性マトリクス](#バックアップ互換性と切戻し手順)で明示的に許可されたアプリ版とスキーマ11を要求します。旧画像同梱形式2〜7は非対応です。画像実体・users・強制状態・制限・実行者を含む全セッションを変更しません。現行契約は[運用ガイド（復元）](operations.md#復元)を参照してください。

全SQLite／snapshot復元は強制状態・試行制限・旧秘密・世代も巻き戻します。前節の停止・要求排出・対象セッション失効と利用者状態再確認を行います。旧版への復帰ではA/B/Cの対策が失われるため、運用承認なしに通常利用を再開しません。実際の更新・rollback・ACLは[開発ガイド（配備の確認）](development.md#配備スクリプトの確認)で確認します。

<a id="pwdb辞書追加後のrollback201"></a>

### PWDB辞書追加後のrollback

辞書構成の変更は DB スキーマ・ZIP 形式・既存ハッシュを変えません。更新では PWDB 本文 `pwdb-policy-top-3000.txt` と `pwdb-metadata.json` を `resources` として実装と同時に入れ替え、`check-install.php` が成功するまで配備成功としません。NCSC 本文・専用 metadata は新版へ持ち越しません。検査失敗時に固定検証を無効化しません。

rollback は snapshot のプログラムと標準 `resources` を組で復元します。任意追加辞書の `<StorageDir>\password-blocklist` と兄弟 manifest `password-blocklist.json` は更新・rollback とも保持し、snapshot に混入させません。同じ世代の本文と manifest は別系統で保管し、導入・更新・解除・復旧は[運用手順](operations.md#任意追加辞書)に従います。任意辞書を参照しない旧版へ戻すと追加の拒否対象を失うため、運用責任者が再開を承認します。PWDB 追加前の旧版への復帰も拒否範囲が縮小します。実 ACL・配備・負荷は[開発ガイド（配備の確認）](development.md#配備スクリプトの確認)で確認し、既存利用者の停止やハッシュ移行を追加しません。

### バックアップ互換性と切戻し手順

完全バックアップ（`netarium-full` 形式 1）および Web 構成情報バックアップ（`netarium-config` 形式 1）は、PATCH／MINOR更新において同一MAJORバージョンの過去正式版から新版への復元互換性を維持する方針とします。ただし、SemVer やパッチ番号の大小比較で任意の旧版を自動許可せず、データ契約の同一性が検証された組み合わせだけを明示的マトリクスで許可します（fail-closed）。

- **復元先 `1.0.3` 環境（スキーマ 11）**: `1.0.3`・`1.0.2`・`1.0.1`・`1.0.0` で作成した両 ZIP を復元できます。`1.0.3 → 1.0.2`、`1.0.3 → 1.0.1` および `1.0.3 → 1.0.0` は許可しません。
- **復元先 `1.0.2` 環境（スキーマ 11）**: `1.0.2`・`1.0.1`・`1.0.0` で作成した両 ZIP を復元できます。`1.0.2 → 1.0.1` および `1.0.2 → 1.0.0` は許可しません。
- **復元先 `1.0.1` 環境（スキーマ 11）**: `1.0.1` および `1.0.0` で作成した Web 構成情報 ZIP・停止型完全バックアップ ZIP を復元できます（ZIP マニフェストの `application_version` はバックアップ元の版として保持されます）。
- **復元先 `1.0.0` 環境（スキーマ 11）**: `1.0.0` で作成した両 ZIP のみ復元できます（`1.0.1 → 1.0.0` の逆方向復元は拒否されます）。
- **非対応のバックアップ**: 異なるMAJORバージョン（`0.3.0` 以前など）で取得したバックアップの直接復元、旧 Web 画像同梱形式 2〜7、未検証の将来版、スキーマ不一致は前段検査で安全に拒否され、ライブ DB・画像・利用者・IIS 状態は変更されません。異なるMAJOR間の移行が必要な場合は専用の移行手段を提供します。

「過去時点のバックアップデータの復元」と「アプリケーション更新失敗時のロールバック」は別の操作です。

- `1.0.3` 稼働中に過去時点（`1.0.0`・`1.0.1`・`1.0.2`・`1.0.3`）のデータを戻す場合は、`1.0.3` のまま復元機能を使用できます。ただし、停止型完全バックアップを復元すると DB・利用者・画像実体がすべてバックアップ時点へ戻るため、**復元前に現在の最新データの完全バックアップを取得して保全してください**。
- アプリケーション更新自体の失敗や、`0.3.0` 等の非互換な旧版へ切り戻す（ロールバックする）場合は、次節の手順で更新時のスナップショットから同時点のプログラム・DB・画像・設定を一括復元するか、旧版プログラム資材へ戻した上で対応する旧版バックアップを復元します。
- 更新完了後は、正常稼働を確認した後に速やかに新版環境の完全バックアップを新規取得して外部へ保管してください。

今後のリリースでバックアップ互換対象を更新する際は、全バージョンの網羅的実機再試験ではなく、直前版および最古の対応版など代表的な旧版実ZIP（公開タグ実プログラム生成物）による自動回帰試験を基本とします。保存データ契約や復元処理に変更が生じた場合は影響範囲に応じて追加試験を実施し、変更がない中間版は過去の試験結果を再利用できます。未検証の組み合わせは自動許可せず、安全拒否を維持します。スキーマ変更を伴う場合は安全なデータ移行処理を検証し、互換性を維持できない変更はメジャーバージョンアップとして扱うことを検討します。

## 失敗時の保全と手動ロールバック

自動ロールバックが失敗した場合、スクリプトはPHPと要求を拒否する保守状態を残す処理を試みます。保守応答を確認できない場合はSite・Poolを停止し、利用者の要求が入らない状態を維持します。更新失敗を戻すためにアンインストールや新規setupを実行しないでください。

作業前に次を保全します。

- 表示されたスナップショット全体（`manifest.json`と`iis-secrets.bin`を含む）。コピー先もSYSTEM・Administrators専用ACLで保護
- PowerShellの標準出力・エラー
- IISログ、PHPログ、Windowsイベントログ
- 現在の`data/logs`と、調査に必要な失敗後の配置・DB・設定

手動ロールバックは、プログラムだけを旧版へ戻す操作ではありません。同じスナップショットのDB・画像・設定・IIS状態を戻すため、スナップショット取得後のデータ変更は失われます。対象と取得時点を承認し、他の更新処理が実行中でないことを確認してください。

1. 管理者PowerShellで対象Site・Poolを停止します。共用Poolでは他Siteも停止するため、事前に利用先管理者と調整します。
2. 信頼できるスナップショットの`manifest.json`で、`Stage`が`update`、`TargetPath`・`StoragePath`・`SnapshotPath`・`SiteName`・`ApplicationPoolName`が復旧対象と一致することを確認します。`ProgramItems`、各ファイルのInventoryと実体、ACL、IIS構成も照合します。復元関数はこれらの所有権を全面検証するものではないため、不一致や欠損があれば続行しません。
   - 旧構成移行前の旧版へ戻す場合、退避されたルート`auth.php`・`database.php`のInventory、元の存在記録と実体を確認します。新配布物一覧にないという理由でsnapshotから除外したり、復元時に捨てたりしません。手動退避資料を補助的に使う場合も同じ取得時点・対象配備と照合し、元からないファイルを追加しません。
3. IIS構成を保全し、スナップショット取得後に他Siteや共用FastCGIへ変更がないかIIS構成管理者と確認します。復元はFastCGIのサーバー単位構成も戻すため、他Siteの後続変更を巻き戻すおそれがある場合は先に調整します。サーバ全体のunlockや無関係なBindingの削除は行いません。
4. 保全した信頼できるリリースの`deployment-common.ps1`を読み込み、`Restore-NetariumSnapshot`を`-KeepIisStopped`付きで実行します。次の例のスナップショットパスは実際に選んだものへ置き換えます。

```powershell
Import-Module WebAdministration
if ((Get-WebSiteState -Name Netarium).Value -eq 'Started') { Stop-Website -Name Netarium }
if ((Get-WebAppPoolState -Name Netarium).Value -eq 'Started') { Stop-WebAppPool -Name Netarium }
. C:\staging\netarium\scripts\deployment-common.ps1
$SnapshotPath = 'C:\Netarium\app-rollback\<表示されたスナップショット名>'
Restore-NetariumSnapshot -SnapshotPath $SnapshotPath `
  -InstallRoot C:\Netarium\app -StorageDir C:\Netarium\app\data -KeepIisStopped | Out-Null
```

5. Site・Poolを停止したまま、復元した旧リリースでCLI確認を行います。`ok:true`と終了コード0を確認し、公開パス、PHP Handler、Binding、証明書、ACL、保存先をスナップショットと照合します。失敗したら起動せず原因を調査します。

```powershell
& C:\php\php.exe C:\Netarium\app\scripts\check-install.php `
  --app-root C:\Netarium\app --storage-dir C:\Netarium\app\data
if ($LASTEXITCODE -ne 0) { throw '復元後のCLI確認に失敗しました。IISを起動せず調査してください。' }
```

6. 復元されたIIS状態と`public/app_offline.htm`を確認します。更新スナップショットでは保守設定を適用する前のIIS状態と、保守ページを除いたプログラムを保存しています。復元に成功した場合はその状態で再開できるため、サーバ全体の規則解除や不明なPHP拒否規則の削除を行いません。
7. 接続元制限を維持してPool・Siteを起動し、HTTP・セキュリティ確認を行います。失敗時は再度Site・Poolを停止します。正常なログインと必要な画面操作を確認してから利用再開を通知します。

```powershell
Start-WebAppPool -Name Netarium
Start-Website -Name Netarium
powershell -ExecutionPolicy Bypass -File C:\Netarium\app\scripts\verify-security.ps1 `
  -VerificationUrl https://netarium.example.local/
if ($LASTEXITCODE -ne 0) {
    Stop-Website -Name Netarium
    Stop-WebAppPool -Name Netarium
    throw '復元後のHTTP確認に失敗しました。停止状態で調査してください。'
}
```

## 要求排出タイムアウト後の保守状態

要求排出前に停止した場合は、更新用スナップショットをまだ作成していません。表示された失敗理由とログを保全し、Site・Poolを停止して要求がなくなったことと、プログラム・DBが未変更であることを確認します。保守ページだけを削除して再開しても、PHP拒否規則や既定ドキュメントの変更が残るため、解除手順にはなりません。

IIS構成管理者は対象Siteの`defaultDocument/files`に追加された`app_offline.htm`と`requestFiltering/fileExtensions`の`.php`拒否規則を開始前の構成記録と照合し、今回追加した設定だけを元へ戻します。元から存在した設定、他Siteのlocation、サーバ全体のロックを変更しません。対象の`public/app_offline.htm`も今回作成したものと確認してから削除します。開始前の状態を特定できなければ保守・停止状態を維持して引き継ぎます。解除後はCLI確認、Site・Poolの再開、HTTP・画面確認の順に行い、失敗時は再度停止します。
