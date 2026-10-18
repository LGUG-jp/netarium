# Netarium配備ガイド

## 方針

Netariumの配備は原則HTTPSとし、インターネットに到達可能な本番環境ではHTTPSを必須とします。閉域・隔離・信頼されたネットワークでは、管理者が条件とリスクを明示的に受容した場合にHTTPを選択できます。どちらも接続元を制限し、IISの物理パスは公開領域`<InstallRoot>\public`だけにします。リポジトリルートを公開しません。

新規配備（fresh setup）と既存Siteのsetup再実行には`scripts/setup-iis.ps1`を使用します。スクリプトを使わない新規配備は[手動配備・全損復旧ガイド](deployment-manual.md)を参照してください。旧配置からの移行は対象外です。

既存配備の更新・ロールバックは[更新ガイド](update.md)、全損復旧・撤去は[運用ガイド](operations.md)に分けています。[開発ガイド（配備の確認）](development.md#配備スクリプトの確認)のライフサイクル試験は隔離環境専用であり、新規導入のコマンドではありません。

<a id="http運用の許容条件と記録202"></a>

### HTTP運用の許容条件と記録

HTTPでも初期セットアップ、ログイン、管理、図面・機器情報の編集と保存、画像、CSV、バックアップ・復元を利用できます。アプリはHTTPSへの自動リダイレクトやHTTPの一律拒否を行いません。ただしHTTPは通信を暗号化せず、パスワード・初期登録用秘密・セッション・画像・業務情報の盗聴と改ざんを防ぎません。CSP、HttpOnly、SameSite、Cookie prefixは通信路の保護の代わりになりません。

管理者はHTTPを選ぶ前に、承認済み構成記録へ対象FQDN・ポート、閉域／隔離の範囲、許可する接続元と制限方法、盗聴・改ざんの受容理由、判断者・承認日、見直し条件を記録します。インターネットへ到達する本番配備の例外にはしません。初期登録もこの判断の対象です。設定・信頼プロキシIP・証明書秘密鍵はアクセス制限した組織の保管先で管理し、Git・業務バックアップZIP・公開ログへ混入させません。

<a id="csphstsセッションcookieの設定202"></a>

### CSP・HSTS・セッションCookieの設定

`config/app.php`はsetup生成時にHSTSを有効化せず、再実行・更新では既存値を保持します。必要な値を管理者が追加し、対象Poolの停止・再起動と全HTTP workerの実応答確認で適用を判定します。OPcache有効環境ではファイルの変更だけで反映を判定しません。

```php
// config/app.phpの既存return配列へ必要な項目だけ追加する。
'trusted_https_proxies' => [], // TLS終端プロキシの直前接続元IPだけを列挙
'hsts_max_age' => null,        // null=無効、0=HTTPSで記憶解除を通知、正整数=秒
'csp_report_only' => false,    // 検証時だけtrue、受入後はfalse
```

通常のHTTPS判定はIIS／FastCGIが設定する`HTTPS=on`または`1`を使用し、443というポート番号だけでは判定しません。TLS終端プロキシでは`trusted_https_proxies`へ直前の接続元IPを完全一致で登録し、プロキシが受信した`X-Forwarded-Proto`を破棄して単一の`http`または`https`へ上書きする必要があります。この接続元では転送値を優先し、バックエンド間がTLSでも外部HTTPをHTTPSと扱いません。不正・欠落の転送値もHTTPSと判定しないため、登録前に上書き契約を確認します。バックエンドへの直接接続もネットワークで制限します。任意端末や転送チェーン、CIDRを登録する方式は提供しません。`Forwarded`や複数値の`X-Forwarded-Proto`を信用しません。証明書・TLS終端の設定は組織の管理者が行い、自動TLS配備は追加しません。

HTTPSのCookieは`__Host-netarium_session`（Secure、HttpOnly、SameSite=Strict、Path=/、Domainなし）、HTTPは従来の`netarium_session`（Secureなし、その他は同じ）です。更新後の旧HTTPSセッションやHTTP↔HTTPSの切替では認証を引き継がず、再ログインします。利用者へ未適用入力を確定してからログアウトし、新しいURLでログインするよう案内します。Cookie名を入れ替えても認証済みセッションは再利用できません。HTTPS証明書の更新はCookie名を変えませんが、HTTPへ戻す場合はHSTSの復帰制約も確認します。

PHPのCSPはレスポンス単位のnonceでAPP_CONFIGと印刷styleを許可します。inlineイベント・style属性・evalは許可しません。IIS静的応答は`public/web.config`のnonce不要のCSPを使用し、各PHP入口はその継承を外して二重適用を避けます。`frame-ancestors 'self'`は`X-Frame-Options: SAMEORIGIN`と同じ方針です。HTTPを破壊する`upgrade-insecure-requests`、`block-all-mixed-content`、HTTPS固定の取得先は追加しません。

更新前の隔離受入ではPHPを`csp_report_only=true`とし、静的応答も`web.config`のCSPの`add`名だけを`Content-Security-Policy-Report-Only`へ変更して違反をブラウザのコンソールで確認します。外部レポート送信先は不要です。ログイン・初期登録・編集・自動保存・画像・印刷・CSV・バックアップ・復元・ガイドを確認した後、PHPをfalse、静的応答の名前を元に戻して同じ操作を強制CSPで受入します。上位IIS／プロキシのCSPも含め、実効ヘッダーが一つだけであることを確認します。

HSTSはHTTPS専用ホストで管理者が選んだ場合だけ使用します。PHP応答で管理する場合は`hsts_max_age=300`から始め、HTTPSでの接続と証明書更新を受入してから86400などへ段階的に延長します。許容範囲は0〜31536000秒です。`includeSubDomains`・`preload`は追加しません。同じホスト名でHTTPとHTTPSを切り替える運用ではnullを維持します。

静的応答も含むホスト全体のHSTSは、対応するIISのSite単位HSTSまたはTLS終端プロキシを管理者が明示設定して管理できます。その場合はPHPをnullとし、HSTSの発行元を一つにします。HTTPS応答だけに付与し、`includeSubDomains=false`、`preload=false`、HTTPリダイレクト無効の設定とします。上位からの一律customHeadersは使いません。`web.config`は継承されたcustomHeadersのHSTSを除去しますが、SiteのHSTS・プロキシの後付けはアプリから除去できないため実応答で確認します。

切戻しは、証明書が有効なHTTPSを維持したまま発行元で`max-age=0`を送信し、対象端末が受信したことを確認してから無効化します。nullへ変えるだけではブラウザの記憶は即時消えず、未接続端末は以前の期間が満了するまでHTTPへ戻れない場合があります。Cookieの再ログイン、証明書期限・名前・信頼性、過去の上位HSTSも含めて[開発ガイド（配備の確認）](development.md#配備スクリプトの確認)へ記録します。

## 前提条件

- Windows Serverに管理者権限でログインできること。IISのWebサーバー、CGI（FastCGIを含む）、IIS管理ツールとIIS管理用PowerShellを導入する。更新時の要求排出にはIISの要求監視機能も必要
- PHP 8.5.5以上（Windows x64のNon Thread Safe版）の`php.exe`と`php-cgi.exe`、SQLite Library 3.51.3以上を用意する
- CLIと実IIS FastCGIの両方でArgon2idの生成・照合ができるPHPビルドを用意する。初期costは`memory_cost=19456` KiB、`time_cost=2`、`threads=1`。非対応時は配備を中止し、bcryptへ暗黙に代替しない。CLI／CGIの事前検査だけで実FastCGIの対応・負荷を測定済みとせず、[開発ガイド（配備の確認）](development.md#配備スクリプトの確認)を別途実施する
- IIS実行IDから`php-cgi.exe`と、Ping利用時は`ping.exe`を実行できること。Ping利用時はPHPの`exec`を無効化しない
- `SourcePath`、`InstallRoot`、`RollbackRoot`が互いに危険な包含関係にならないこと。`InstallRoot`と`RollbackRoot`は別領域にする
- Application Poolは各Site専用とし、実行IDには仮想アカウント（`ApplicationPoolIdentity`）を強く推奨する。独自のユーザーアカウント（`SpecificUser`）を使用する場合は本Site専用とし、他のApplication Poolやサービスとユーザーアカウントを共有してはならない。同一ユーザーを複数Poolで共有すると、Windows NTFSのファイル所有者権限（WRITE_DAC）によりセッション領域等の分離が破られる。`LocalSystem`や`NetworkService`等の共有システムIDも使用禁止。事前検査ではアカウント名の表記ではなくSIDを比較する。対象Poolまたは他の`SpecificUser` PoolのSIDを解決できない場合や、Pool列挙・実行ID設定の読み取りに失敗した場合、未対応の実行IDの場合は、分離を確認できないため配備を中止する

SQLiteは`<InstallRoot>\data\db`へDB本体と一時ファイルを作成します。ACLは`data.sqlite`単体ではなく`data/db`全体への変更権限を必要とします。プログラム領域へ書き込みを許可しません。

### IISと管理用PowerShellを用意する

Windows Serverの管理者PowerShellでIIS、CGI、およびIIS管理用PowerShell（`WebAdministration`）を導入します。[MicrosoftのIIS CGIの説明](https://learn.microsoft.com/en-us/iis/configuration/system.webserver/cgi)のとおり、CGI機能にはFastCGIが含まれます。既に導入済みの場合は状態だけ確認してください。

```powershell
Install-WindowsFeature Web-Server,Web-CGI,Web-Mgmt-Tools,Web-Scripting-Tools,Web-Request-Monitor -IncludeManagementTools
Get-WindowsFeature Web-Server,Web-CGI,Web-Scripting-Tools,Web-Request-Monitor
Import-Module WebAdministration
```

`Get-WindowsFeature`の対象がすべて`Installed`で、`Import-Module`が成功することを確認します。WindowsクライアントOSでは`Install-WindowsFeature`を使用できないため、この例はWindows Server向けです。接続元制限を先に用意し、HTTPSでは証明書も準備します。HTTPを選ぶ場合は[許容条件](#http運用の許容条件と記録202)を記録します。

### PHPを配置してphp.iniを設定する

公式の[Windows向けPHP ZIP](https://windows.php.net/download/)を取得し、`C:\php`などWeb公開領域の外に展開します。`C:\php\php.exe`、`C:\php\php-cgi.exe`、`C:\php\ext\`が存在することを確認してください。[PHP公式のWindows導入要件](https://www.php.net/manual/en/install.windows.manual.php)に従ってx64版のVisual C++ランタイムも導入します。PHPとSQLiteの版数は配布物ごとに異なるため、後述のpreflightで確認します。

`C:\php\php.ini`がなければ、次のコマンドで`php.ini-production`をコピーします。既存の`php.ini`を変更する場合は上書きせず、先に日時を付けたバックアップを保存してください。`php.ini`の該当行（先頭の`;`はコメントなので外す）を次のように設定します。同じ項目を複数定義しないでください。

```powershell
if (-not (Test-Path -LiteralPath C:\php\php.ini)) {
    Copy-Item C:\php\php.ini-production C:\php\php.ini
}
```

```ini
extension_dir = "C:\php\ext"
extension=pdo_sqlite
extension=sqlite3
extension=zip
extension=gd
extension=mbstring
extension=exif
extension=intl
upload_max_filesize = 32M
post_max_size = 34M
max_file_uploads = 20
memory_limit = 512M
max_execution_time = 300
date.timezone = Asia/Tokyo
log_errors = On
error_log = "C:\php\logs\Netarium\php-errors.log"
```

`exif`は`mbstring`の後に記載します。`fileinfo`が`php-cgi.exe -m`に表示されない配布物では`extension=fileinfo`も有効化します。`PDO`、`session`、`json`は通常組み込みのため、`-m`に表示されれば追加の`extension=`行は不要です。`mbstring`は台帳文字列のコードポイント制限やCSV取込のために必須です。`intl`は推奨します。`pdo_sqlite`、`sqlite3`、`fileinfo`、`zip`、`gd`、`exif`、`mbstring`は必須です。

`log_errors = On`と`error_log = "C:\php\logs\Netarium\php-errors.log"`を指定し、Web公開領域外の専用ファイルへ記録します。未設定または書込不能な保存先では、PHPの`error_log()`出力がFastCGIの`STDERR`へ流れます。IISの既定設定（`stderrMode="ReturnStdErrIn500"`）では、データベースbusy等のHTTP 503応答がHTTP 500へ変換されるため、パス指定だけでは不十分です。

<a id="php-error-log"></a>
setupの実行前に、専用Poolとログディレクトリを準備します。以下は`Netarium`専用の例です。他用途の既存ディレクトリには適用せず、Pool名・パスを実際の構成に合わせてください。既存Poolの実行IDは無断で変更しません。

```powershell
Import-Module WebAdministration
$PoolName = 'Netarium'
$PhpLogDir = 'C:\php\logs\Netarium'
if (-not (Test-Path "IIS:\AppPools\$PoolName")) {
    New-WebAppPool -Name $PoolName | Out-Null
    Set-ItemProperty "IIS:\AppPools\$PoolName" -Name managedRuntimeVersion -Value ''
    Set-ItemProperty "IIS:\AppPools\$PoolName" -Name processModel.identityType -Value ApplicationPoolIdentity
    Stop-WebAppPool -Name $PoolName
}
New-Item -ItemType Directory -Path $PhpLogDir -Force | Out-Null
& icacls.exe $PhpLogDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)(F)' '*S-1-5-32-544:(OI)(CI)(F)' "IIS AppPool\${PoolName}:(OI)(CI)(M)"
if ($LASTEXITCODE -ne 0) { throw 'PHPログディレクトリのACL設定に失敗しました。' }
```

事前検査は絶対ファイルパスと親ディレクトリの存在を確認しますが、Pool実行IDによる書込成功までは保証しません。利用開始前に、隔離IISでSQLite busy等のログ記録を伴う要求を送り、HTTP 503が維持されることと指定ファイルへの追記を確認します。管理者CLIからの書込みだけで代替しません。PHPを共用する場合は他Siteへの設定変更の影響も確認します。

```powershell
& C:\php\php.exe -v
& C:\php\php-cgi.exe -v
& C:\php\php.exe -m
& C:\php\php-cgi.exe -m
& C:\php\php-cgi.exe -i | Select-String 'Loaded Configuration File|upload_max_filesize|post_max_size|memory_limit|max_execution_time|max_input_time'
```

両実行ファイルのPHP版数・拡張一覧と、CGIが読み込んだ`php.ini`のパスを確認します。`setup-iis.ps1`は指定したCGIのSQLite版数とINI設定値を検査します。`C:\php`以外へ展開した場合は、`extension_dir`と`-PhpCgiPath`を配置先に合わせてください。

既存配備の`php.ini`はリリース更新では自動変更されません。CLIとCGIそれぞれの`Loaded Configuration File`で有効なファイルを特定し、既存の`upload_max_filesize`を`32M`、`post_max_size`を`34M`へ変更します（PHPの`M`はMiB）。メモリ512Mと実行時間300秒は縮小しません。変更後はIISの対象Poolをリサイクルし、上記コマンドと`scripts/check-install.php`で有効値を確認してください。

### 暫定最低閾値と運用マージン

- **暫定最低閾値**: PHP `memory_limit >= 512M`、PHP `max_execution_time >= 180` 秒、IIS FastCGI `activityTimeout >= 180` 秒、`requestTimeout >= 180` 秒。
- **運用例（300秒）との差**: 180秒は上限近傍（5,000台、7,000リンク、40図面80MiB）におけるバックアップ・復元処理およびPing 100件ソフト期限（120秒）に対する暫定の最低閾値です。配備スクリプトの入力例（300秒）は、低速ストレージや本番環境での遅延に備えた安全マージンを含む運用値です。
- **複数 PHP worker のメモリ条件**: FastCGIで複数workerプロセス（例: 2〜4プロセス）が同時稼働する場合、上限近傍で1プロセスあたり最大約70〜100MiB（一時的ピークで512MiB）を消費し得るため、サーバー全体で `worker数 × 512MiB` の空きメモリを確保することを推奨します。
- **ディスク共存容量条件**: Web復元ではアップロードZIP（最大24MiB）、展開JSON（合計最大64MiB）、構成情報の自動退避と作業用JSONが共存します。自動退避は画像を含まず、復元で新旧画像を配備・置換することもありません。保存済み画像、DB、ログの使用量に加え、構成退避の作業領域と保持中プレビュー全件の実使用量を見込んで空き容量を確保してください。
- **100件無応答 Ping の理論上の所要時間**: 100件の無応答対象に対し、個別タイムアウト1,000ms（1秒）で順次実行された場合、理論上100秒＋プロセス起動オーバーヘッドを要します。Ping全体のソフト期限120秒は対象機器間で判定します。期限後は新たなPingを開始せず、残りをスキップとして完了済みの結果とともに保存します。実行中の1台は中断しないため、配備環境の要求タイムアウトには余裕が必要です。

画像保存は1機器最大3枚、保存1枚10MiB、図面入力30MiB・保存10MiB、最大ビュー100等の安全上限を維持し、全体108ファイル／200MiBの一律上限は撤去します。全体件数・総量はディスク空き容量および任意の運用クォータで扱います。Web構成情報ZIPは24MiB以下・展開後合計64MiB以下で、`manifest.json`と`data/netarium.json`のJSON2ファイルだけです。

要求上限は通常要求をIIS Siteの32MiB（`33554432` bytes）、画像投稿専用の`image_upload.php`を31MiB（`32505856` bytes）とします。PHP推奨値は`upload_max_filesize=32M`、`post_max_size=34M`です。multipart overheadを含め30MiB図面が通り、通常要求が32MiB・画像URLが31MiBで遮断される設計です。IISの404.13はPHP到達前の拒否、PHPの`post_max_size`不足はINI設定不備として区別して案内します。

図面はPNG/JPEG、入力30MiB・各辺7,000px・3,500万画素以下を検査し、GDでEXIF向き1〜8を補正して長辺4,096px以下へ縮小します。同形式で再エンコードし、小画像は拡大せずPNG透過を保持します。JPEG品質95・PNG圧縮8を初期採用し、変換後の実バイト数が10MiB以下であることを確認して保存します。原本はPHPのアップロード一時ファイルに限り、永続保存しません。写真は入力10MiB・各辺4,000px・1,200万画素、保存長辺2,048pxを維持します。Web復元では既存画像の属性とSHA-256を照合して参照だけを戻し、画像実体を変更しません。図面変換は[アーキテクチャ](architecture.md)、Web ZIPは[運用ガイド（復元）](operations.md#復元)を参照してください。

保存寸法が小さくても入力のデコード負荷は残ります。A3・300dpiの例（約4,961×3,508px、約1,740万画素）に加え、約3,100万画素や上限3,500万画素の入力では、GDの入力画像・向き補正・縮小先が処理中に共存します。`memory_limit=512M`とPHP／FastCGIの運用例300秒は維持し、実IIS上でプロセス全体のピークメモリ、処理時間、複数worker時の余裕を測定してください。`max_input_time`も大きな図面・ZIP送信で実効値を確認します。実スキャン図面がないため4,096px・品質95での文字・細線の可読性は未確認です。実ブラウザーで透過・EXIF・非拡大・差し替え後の調整、IISで通常登録・31MiB超過・PHP INI不足の区別・大きなZIP復元を人が受け入れる必要があります。

## fresh setup

### 1. リリースを用意する

`SourcePath`は、`public/`、`src/`、`templates/`、`resources/`、`scripts/`、`bootstrap.php`、`version.php`、`config/app.example.php`を含むリリースルートです。拒否リストと出典metadataは`resources/password-blocklist/`へ含め、`public/`へ置きません。認証とDBの実装は`src/`に含め、旧ルートの`auth.php`・`database.php`は配布しません。`data/`、`config/app.php`、DB、ログ、バックアップをリリースへ混在させません。

fresh setupの配置先は、未作成または空の`InstallRoot`、もしくは直下に`public`・`src`・`templates`・`resources`・`scripts`・`config`の空ディレクトリだけがある状態に限ります。既存の空`public`を指すSiteでも、`public/web.config`へ正しく配置し、`public/public`は作成しません。未管理ファイル、非空ディレクトリ、既存`data`、配置先・祖先のreparse point（junction等）はsnapshot作成・配置・IIS変更前に拒否します。既存資材を削除して回避せず、所有と保全先を確認してください。`config/app.php`と対応する既存Siteがある配備は、[再実行](#再実行と冪等性)の経路で扱います。

fresh setupの失敗時はsnapshotから元の構造・公開ディレクトリのACL・IIS状態へ切り戻します。既存Siteに配備中作成したIIS locationは、snapshotで元は存在しなかったと確認できる場合だけ除去します。初期状態で`data`がなかった内部ストレージ構成では、失敗した配備が新規作成したbootstrap秘密・ログも残しません。既存データや外部ストレージを含む旧snapshotでは、それらをこの後始末の対象にしません。

### 2. 配備を実行する

管理者PowerShellでリリースルートへ移動し、次のコマンドを実行します。`SourcePath`を省略するとスクリプト自身のあるリリースルートを使用します。引数を省略した対話実行では設置先、サイト名、プール名、PHP CGI、Binding方式などを順に選択・入力します。自動実行では必要な引数をすべて指定し、`-NonInteractive`で不足時に停止させます。

```powershell
Set-Location C:\staging\netarium
powershell -ExecutionPolicy Bypass -File .\scripts\setup-iis.ps1
```

標準構成はNetarium専用の独立IIS Siteです。`-HostName`には利用者がアクセスする**サービスFQDN**（例: `netarium.example.local`）を指定します。WindowsホストのFQDNとは別に設定でき、両者が一致する必要はありません。DNS登録と接続元制限を事前に確認してください。アプリケーションはサイトのルート`/`で公開し、`/netarium`などのサブパス配備はサポートしません。

```powershell
Resolve-DnsName netarium.example.local
Test-NetConnection netarium.example.local -Port 443
```

`Resolve-DnsName`でサービスFQDNが予定した接続先に解決されること、`Test-NetConnection`で利用端末から対象ポートへ到達できることを確認します。DNS/ネットワークの結果だけでは証明書やアプリの正常性は証明できません。HTTPSではサービスFQDNをSANに含み、Server Authentication EKUを持つ有効な証明書（秘密鍵付き）を`Cert:\LocalMachine\My`に配置して、その拇印を`-CertificateThumbprint`へ指定します。共有IP:443で複数のホスト名を扱う場合はSNIを使用し、他サイトのBindingとの競合を避けます。

`-Protocol https`は証明書を用いたHTTPS Binding（既定443）、`-Protocol http`は証明書不要のHTTP Binding（既定80）を選びます。HTTPは[許容条件](#http運用の許容条件と記録202)を満たす場合だけ使用します。既存のIIS Site/Bindingを変更したくない場合は`-Protocol existing`を選びます。この方式では先に同名サイトとBindingを用意し、物理パスを`<InstallRoot>\public`に合わせてください。サイトが存在しなければ失敗します。`-HostName`の旧名`-HostHeader`は互換aliasです。`-VerificationUrl`はBindingから導出される確認先URLを変更したい場合だけ指定します（例: DNS切替前の検証）。確認先は実際に到達できるサイトのルートURLとし、別のアプリを指さないようにしてください。旧`-BaseUrl`は確認先の互換aliasでありBinding選択には使用しません。既存の`-BaseUrl`指定手順を移行する際は`-Protocol`、`-HostName`、HTTPSの場合は証明書拇印を明示してください。

既存Bindingから確認先を導出する際、選ばれたBindingにHost nameがない場合（例: `*:443:`、`192.0.2.10:8443:`）はFQDNを決められません。`-Protocol existing`では到達可能で証明書名と一致するサービスURLを`-VerificationUrl`で明示してください。選ばれたBindingがHost nameを持たずURLも省略された場合は配備前検査で停止し、`localhost`へ代替接続しません。

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-iis.ps1 `
  -SourcePath C:\staging\netarium `
  -InstallRoot C:\Netarium\app `
  -SiteName Netarium `
  -ApplicationPoolName Netarium `
  -PhpCgiPath C:\php\php-cgi.exe `
  -Protocol https `
  -HostName netarium.example.local `
  -CertificateThumbprint '<LocalMachine\Myの証明書拇印>' `
  -MinimumPhpMemoryLimitMiB 512 `
  -MinimumPhpMaxExecutionTimeSeconds 300 `
  -FastCgiActivityTimeoutSeconds 300 `
  -FastCgiRequestTimeoutSeconds 300 `
  -NonInteractive
```

HTTPの許容条件を満たす業務環境・開発環境では`-Protocol http -HostName netarium.example.local`（必要に応じて`-Port 8080`）を指定し、証明書拇印は不要です。組織管理の既存HTTPS Bindingを維持する場合は`-Protocol existing -VerificationUrl https://netarium.example.local/`を指定します。既存Bindingの証明書・ポート・SNIは事前にIISで確認してください。`512 MiB`と`300秒`は運用マージンを含む入力例です（最低閾値は512MiB / 180秒以上）。`php.ini`の`max_execution_time`も、入力したPHP実行時間以上に設定してください。スクリプトは指定したPHPの実行環境、SQLite、拡張、アップロード上限、実行時間を検証します。
fresh setupでは次を作成・設定します。

- IISサイトの物理パスを`<InstallRoot>\public`に設定
- `<InstallRoot>\data\db`、`uploads\floorplans`、`backups\auto`、`logs`、`temp`、`sessions`を作成
- `<InstallRoot>\config\app.php`を生成し、`storage_dir`を実行時データへ固定
- PHP FastCGI、`.php`ハンドラー、要求サイズ、FastCGI時間を設定
- プログラムは読み取り・実行、実行時データ（`bootstrap`を除く）は対象アプリケーションプールへ変更権限を設定
- CLIの`check-install.php`でDBを作成・移行し、スキーマと図面ファイルを確認
- `login.php`、API、`setup.php`、非公開パスをプローブ

ACL適用ではプログラム領域と機密領域を分けます。プログラム領域は継承を遮断して広範な書込Allow ACEを除去し、書込みを含まない読取りACEを一律には削除しません。一方、`data/`と`config/`は既存の明示Readも含めて一般利用者・別PoolのAllow ACEを除去し、`SYSTEM`・`Administrators`と対象Poolだけに限定します。`bootstrap`とスナップショットは対象Poolにも許可しません。必要主体と権限は[運用ガイドのACL表](operations.md#機密領域のaclとスナップショット)を参照してください。独自の管理用ACEを機密領域に残す運用にはしません。

ステージング領域でCLIの設置確認を済ませた後、既存サイトが稼働中なら停止してからリリースと実行時データを`InstallRoot`へ配置します。`public/web.config`を確認し、アプリケーションプールを停止してからIISサイトとFastCGIを設定します。実配備DBのCLI検査とACL適用後、`data/bootstrap`を継承遮断した`SYSTEM`・`Administrators`専用ACLで保護し、一回限りの初期登録用秘密をファイルへ発行してからプールとサイトを起動します。Pool Identityにはこのディレクトリの読取権限も付与しません。更新・ACL再適用・ロールバックでも専用ACLを維持し、平文の秘密コピーはスナップショットに含めません。新規サイトは作成直後に停止します。

アプリのfilesセッション保存先は有効な`storage_dir`配下の`sessions`です。PHPの旧`session.save_path`は使わず、実効保存先にも実行時データのACLを適用します。セッションファイルはスナップショットへ退避せず、復元もしません。旧保存先に残るファイルを配備時に一括削除しないため、更新後の再ログインと旧セッションの扱いは[更新ガイド](update.md#自動ロールバック)に従います。

`setup-iis.ps1`はFastCGI登録と`.php`ハンドラーをIIS構成から再読込し、指定した`php-cgi.exe`とFastCGIの時間設定が一致しない場合はSite起動前に失敗します。配備後は、次のコマンドでも実際の登録値を確認してください。`fullPath`と`scriptProcessor`が指定した`-PhpCgiPath`に一致することを照合します。

```powershell
Get-WebConfiguration -PSPath 'MACHINE/WEBROOT/APPHOST' -Filter 'system.webServer/fastCgi/application' |
  Select-Object fullPath,activityTimeout,requestTimeout
Get-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' -Location Netarium `
  -Filter 'system.webServer/handlers/add' -Name '.' |
  Where-Object { $_.path -eq '*.php' } |
  Select-Object path,scriptProcessor
```

既存サイト名・アプリケーションプール名を再利用する場合、既存の物理パスが`<InstallRoot>\public`でなければfresh setupを中止します。既存の別配置を上書き・移行しません。

fresh setup中に失敗した場合は、開始前のスナップショットからファイルとIIS設定を復元し、作業用のstagingディレクトリの削除を試みます。新しいスナップショットのIIS資格情報はDPAPI LocalMachineで暗号化し、秘密を書き込む前に管理専用ACLを設定します。同一ホストの別管理者は復元できますが、別ホストでは秘密を復号できません。形式と復元制約は[運用ガイド](operations.md#機密領域のaclとスナップショット)を参照してください。開始前に対象サイトやアプリケーションプールが存在しなかった場合は、作成途中のものを削除します。

開始前に`InstallRoot`がなければ作成したディレクトリも削除します。既存の`InstallRoot`では新たに作成された空の設定・実行時ディレクトリを取り除き、既存のログは保持します。失敗原因とスナップショットのパスをエラーに表示するため、再実行前に確認してください。

IISの`handlers`、`requestFiltering`、`defaultDocument`は、サーバ全体のunlockではなく`applicationHost.config`の対象Site限定location設定で適用します。setup開始前に対象セクションをサーバ構成から読み取り、既存Siteがある場合はSiteの構成も確認します。Siteがないのに同名のlocation設定がある場合は、既存設定を変更しないよう配置前に中止します。管理者が設定を確認し、必要なら保全したうえでlocation設定を整理するか、対象Siteを用意してから再実行してください。

fresh setup、setup再実行、更新では、対象Siteの既定ドキュメントを有効にし、`index.php`が未登録なら追加します。既存の一覧は保持し、更新中は`app_offline.htm`の優先順位を変えません。`public\web.config`で一覧を上書きしないため、保守画面の表示と両立します。fresh setupと`verify-security.ps1`では、未ログインのルートURLが`login.php`への302になることも確認します。

Site固有の`handlers`等は対象Siteのlocationに設定し、FastCGI applicationはサーバー全体の構成に登録します。fresh setupが失敗した場合は、今回作成したlocation設定を削除してからSiteを削除し、その後AppPoolを削除します。SiteとAppPoolは稼働中の場合だけ停止します。FastCGI設定と`InstallRoot`も開始前のsnapshotへ戻し、rollback後にSite/AppPoolとlocation設定の存在、FastCGI設定、`InstallRoot`の存在状態を照合します。既存のSite/AppPoolや配置領域はsnapshotに記録した開始前状態へ復元します。

### 3. 初期管理者を作成する

1. ローカル管理者が配備出力に示された`data/bootstrap/setup-<識別子>.secret`を安全なローカルエディターで開き、初期登録を担当する管理者へ組織承認済みの安全な経路で渡します。`Get-Content`などでコンソールやPowerShell transcriptへ内容を出力せず、ログ、URL、チャット履歴へも残しません。
2. 選択したサービスURL（HTTPS推奨、許容条件を記録済みの場合はHTTP）で`/login.php`へアクセスし、未登録なら`setup.php`へ移動します。接続元制限を維持します。
3. 初期登録用秘密、初期管理者のユーザー名、12～128文字（Unicodeコードポイント）・UTF-8最大512バイトのパスワードを入力します。詳細は[管理者ガイド](administrator-guide.md#初回起動)を参照してください。
4. 成功画面を確認した直後、ローカル管理者が発行ファイルと受渡し用コピーを削除します。アプリはDBの照合用SHA-256を消去して秘密を失効させますが、物理ファイルは削除しません。
5. ログイン、保存、Ping、CSV、図面、バックアップとセキュリティを確認します。

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\verify-security.ps1 `
  -VerificationUrl https://netarium.example.local/
```

`setup.php`がログイン画面への302または404になれば初期設定は閉じています。初期設定ページを手動削除しません。

CLIの[整合性確認](#cli確認)も実施します。管理者は実ブラウザでログイン、ビュー・機器の保存と再読み込み、Ping、CSV、フロア図面・機器画像の登録と表示、バックアップ取得を確認します。画像は認証済みの`floor_plan.php`・`device_image.php`経由で取得し、登録した画像のURLが未ログインの別ブラウザで取得できないことも確認してください。`verify-security.ps1`は列挙した認証境界・非公開パスを検査するもので、画像各URLの認証確認や画面操作を代替しません。


## 再実行と冪等性

同じ引数で`setup-iis.ps1`を再実行できます。既に`<InstallRoot>\public`を公開している場合は、DBとプログラムを上書きせず整合性を確認し、ACL・FastCGI・ハンドラー・要求サイズの設定を確認して必要な値を反映します。

再実行しても、`config/app.php`の環境固有値と`data/`の実データは上書きしません。別の公開ルートやPHP CGI実行ファイルを同名サイトへ適用する場合は中止し、対象サイトと設定を確認してください。

整合性の事前検査後、対象Siteの受付を停止し（Starting/Stopping遷移中を含む）、進行中要求の排出（上限120秒）と対象Poolの停止を確認してからACLとIIS設定を変更します。正常完了時だけ、開始時に稼働（Startingを含む）していたPool・Siteの順に再開します。開始時に停止していたものは起動しません。同じPoolを共有する他のSiteにも停止の影響があるため、事前に共有範囲と作業時間を確認してください。

要求排出・ACL適用・所有者確認・IIS設定・再開のいずれかで失敗した場合は、SiteとPoolの両方を停止する処理（遷移中状態の停止完了までポーリング待機）を試み、自動再開しません。停止自体に失敗した場合は、その対象と原因もエラーに表示します。機密資材の保護は途中までしか適用されていない可能性があるため、原因を修正し、再実行で全対象のACLと所有者の確認を完了してから管理者が再開を判断してください。停止状態からの再実行が成功しても、自動起動はしません。

初期登録が未完了でも、setup再実行は秘密を再発行しません。登録の入力・監査・DB障害は原因を修正して同じ秘密で再試行します。紛失・漏えいの疑い、または秘密の発行自体が失敗した場合は[秘密の再発行](#初期登録用秘密の再発行)に従います。

### 初期登録用秘密の再発行

登録の入力誤りや監査・DB障害を修正した後は、同じ秘密で再試行できます。秘密を紛失した場合や発行自体が失敗した場合は、管理者PowerShellで親ディレクトリの専用ACLを再設定し、必ず新しいファイル名を指定して明示的に発行します。

```powershell
. "$InstallRoot\scripts\deployment-common.ps1"
Set-NetariumBootstrapAcl -StorageDir "$InstallRoot\data"
$SecretFile = Join-Path "$InstallRoot\data\bootstrap" ('setup-' + [Guid]::NewGuid().ToString('N') + '.secret')
& C:\php\php.exe "$InstallRoot\scripts\issue-bootstrap-secret.php" `
    --secret-file $SecretFile --db "$InstallRoot\data\db\data.sqlite"
if ($LASTEXITCODE -ne 0) { throw '秘密発行に失敗しました。初期登録状態とACLを確認してください。' }
```

CLIは既存ファイルを上書きせず、秘密自体は出力しません。`--secret-file`は必須の絶対パス、`--db`は省略時に構成済みDBを使用し、DBは既存である必要があります。親ディレクトリは事前作成し、公開範囲外へ置きます。Windowsでは継承を遮断し所有者とAllow ACEを`SYSTEM`・`Administrators`だけに制限したACLをCLIが確認します。Unixでは親を`0700`、生成ファイルを`0600`に制限します。ファイルを排他作成してflush/fsyncした後にDBへSHA-256だけを保存するため、失敗で残った未登録ファイルは無効です。再発行成功時に旧秘密は失効します。不要な旧コピーを削除し、新値で登録を再試行してください。

利用者が既に存在する場合、または初期登録完了がDBに記録されている場合、再発行は拒否されます。登録済み管理者の復旧は`recover-admin.php`を使います。DBを過去の状態へ戻した場合は秘密の照合状態も戻るため、未完了DBなら公開前に再発行し、古い物理コピーを再利用しません。

## CLI確認

```powershell
php C:\Netarium\app\scripts\check-install.php `
  --app-root C:\Netarium\app `
  --storage-dir C:\Netarium\app\data
```

成功時はJSON一行を出力します。アプリケーション版、DBスキーマ、外部キー違反、実行時ディレクトリの書き込み、図面・機器画像の件数とファイルサイズ、Argon2id生成・照合、拒否リストの可用性を確認します。`legacy_bcrypt_users`（停止済みを含む）、`allow_legacy_bcrypt`、`must_change_password_users`も確認してください。異常時はJSONを標準エラーへ出力して終了コード1になります。CLI診断の成功は実IIS FastCGIの対応・性能や実ACLの受入合格を意味しません。

## セキュリティ確認

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\verify-security.ps1 `
  -VerificationUrl https://netarium.example.local/
```

確認対象はログイン、未認証 API（画像登録 URL を含む）、初期設定、`data/db/data.sqlite`、`db/data.sqlite`、`src/Autoloader.php`、`templates/components/toolbar.php`、`config/app.php`、`scripts/recover-admin.php`、`resources/password-blocklist/pwdb-policy-top-3000.txt` と `pwdb-metadata.json`、`data/password-blocklist.json`、`password-blocklist.json`、`data/logs/audit/.lock` です。非公開対象は 403 または 404 を必須とし、200 やその他の状態は失敗します。任意追加辞書は[運用手順](operations.md#任意追加辞書)に従って Web 公開領域外へ配置します。

