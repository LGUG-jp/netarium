# Netarium IIS手動配備・全損復旧ガイド

この手順は、`scripts/setup-iis.ps1`を使わず、Windows Server + IIS + PHP FastCGIへNetariumを新規配備するための公式手順です。自動配備と同じ構築状態を目指します。Web構成情報ZIPだけでは全損時の画像・利用者を復旧できません。

通常のfresh setupでは[配備ガイド](deployment.md)のスクリプトを使用します。自動setupが利用できない場合のfresh installと、隔離環境の構築部分に本手順を使用できます。全損時のデータ復旧は[第8節の制約とWeb構成復元](#8-全損時の制約とweb構成復元)を確認してください。手動配備には自動スナップショットと自動ロールバックがありません。入力値・開始前のIIS状態・実行ログを記録し、既存環境の更新や移行には使用しないでください。既存配置からの移行は提供対象外です。

既存配備の更新・ロールバックは[更新ガイド](update.md)、全損復旧の担当・保管対象・中止基準は[運用ガイド](operations.md#サーバ全損からの再構築)、自動・手動の撤去は[運用ガイドのアンインストール](operations.md#アンインストール)を参照してください。

## 構成と担当範囲

- IISの物理パスは`<InstallRoot>\public`だけにします。リポジトリルートや`data/`を公開しません。
- 標準はNetarium専用のIIS Siteと専用Application Poolです。サイトのルート`/`で公開し、`/netarium`などのサブパス配備は対象外です。
- サーバのホストFQDNと、利用者がアクセスするサービスFQDNは別々に設定できます。
- DNS登録、証明書の発行・秘密鍵管理、ネットワーク到達性・接続元制限は組織側で行います。AD CSなど特定のCA製品は前提にしません。
- HTTPSを原則とし、インターネットに到達可能な本番環境では必須です。HTTPは管理者が閉域・隔離の条件、接続元制限、盗聴・改ざんリスクを明示受容・記録した場合だけ選択できます。[HTTP許容条件とCSP・HSTS・Cookie設定](deployment.md#http運用の許容条件と記録202)を適用してください。
- 既存IIS Site、Reverse Proxy、Load Balancerを利用する場合、Netarium側の責任は指定されたSiteの公開ルートとアプリケーション設定までです。外部URL、転送規則、TLS終端、DNSは管理者が維持します。

## 1. 前提条件

### Windows Server・IIS

管理者権限のPowerShellで、IIS Web Server、CGI（FastCGIを含む）、IIS管理ツール、`WebAdministration`が利用できることを確認します。

```powershell
Get-WindowsFeature Web-Server,Web-CGI,Web-Mgmt-Tools,Web-Scripting-Tools
Import-Module WebAdministration
```

機能の追加自体は本手順の対象外です。必要なWindows Server機能が未導入の場合は、組織のサーバー構築手順に従ってから続行してください。

### PHP

次を満たすWindows x64・Non Thread Safe版PHPをWeb公開領域外（例:`C:\php`）に配置します。

- PHP 8.5.5以上。同じPHP配布物の`php.exe`（CLI）と`php-cgi.exe`（IIS FastCGI）を使用
- SQLite Library 3.51.3以上
- 必須拡張: `PDO`、`pdo_sqlite`、`sqlite3`、`fileinfo`、`zip`、`gd`、`exif`、`session`、`json`、`mbstring`
- 推奨拡張: `intl`
- CLIと実IIS FastCGIの両方でArgon2idの生成・照合に対応するPHPビルド。初期costは`memory_cost=19456` KiB、`time_cost=2`、`threads=1`。非対応なら作業を中止し、bcryptで代替しない

`PDO`、`session`、`json`は通常PHP本体に含まれます。その他の拡張は`php.ini`で有効にし、`php.exe`と`php-cgi.exe`の両方が同じ設定を読むことを確認します。`fileinfo`が`-m`に表示されない配布物では有効化してください。`exif`は`mbstring`の後に記載します。

```ini
extension_dir = "C:\php\ext"
extension=pdo_sqlite
extension=sqlite3
extension=fileinfo
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

`mbstring`は台帳文字列のコードポイント制限やCSV取込のために必須です。`intl`は任意の推奨拡張です。`log_errors = On`と`error_log = "C:\php\logs\Netarium\php-errors.log"`を指定します。未設定または書込不能な保存先ではFastCGIのSTDERR出力検知（`stderrMode="ReturnStdErrIn500"`）により、データベースbusy等のHTTP 503応答がIISによってHTTP 500へ変換されるため、[ログディレクトリ作成・PoolへのACL付与・実IISでの追記確認](deployment.md#php-error-log)も実施します。手動配備では第3節のPool作成後、Site開始前にログ領域を準備します。`php.ini`を変更した場合は同じ拡張設定を重複させず、実際に読まれているファイルを確認します。FastCGIの`activityTimeout`と`requestTimeout`も最低180秒、通常は300秒にします。

```powershell
$PhpCli = 'C:\php\php.exe'
$PhpCgi = 'C:\php\php-cgi.exe'
& $PhpCli -v
& $PhpCgi -v
& $PhpCli -m
& $PhpCgi -m
& $PhpCli -i | Select-String 'Loaded Configuration File|SQLite Library|upload_max_filesize|post_max_size|memory_limit|max_execution_time'
& $PhpCgi -i | Select-String 'Loaded Configuration File|SQLite Library|upload_max_filesize|post_max_size|memory_limit|max_execution_time'
```


既存の手動編集済み`php.ini`はリリース更新では書き換わりません。上記のCLI／CGIが実際に読んでいるファイルで、アップロード上限を32M、POST全体を34Mへ変更し、対象Poolをリサイクルします。PHPの`M`はMiBです。メモリ512Mと実行時間300秒は縮小しません。実FastCGIの有効値とIIS要求上限との整合を、上記コマンドと`scripts/check-install.php`で確認してください。
CLIとCGIの設定確認に加え、[開発ガイド（配備の確認）](development.md#配備スクリプトの確認)で実FastCGIのgeneration・verifyと単発／同時負荷を確認します。受入基準は配備先承認で定め、CLI結果だけで実IISの対応・性能を合格にしません。

PHPの両実行ファイルが8.5.5以上であること、SQLite Libraryが3.51.3以上であること、必須拡張が両方に読み込まれていること、`php-cgi.exe`が意図した`php.ini`を読んでいることを確認します。IIS実行IDから`php-cgi.exe`を実行できる必要があります。Pingを利用する場合は、さらに`exec`を無効化せず、同じ実行IDから`ping.exe`を実行できるようにします。

## 2. リリースと実行時領域を用意する

以降のPowerShell例は同じ管理者セッションで実行する構成です。別セッションを使う場合は、必要な変数を再定義してください。

以下は標準配置例です。既存の`InstallRoot`を再利用する場合は、上書きせず既存Site・設定・データを調査してください。

```powershell
$ReleaseRoot = 'C:\staging\netarium'
$InstallRoot = 'C:\Netarium\app'
$StorageDir = Join-Path $InstallRoot 'data'
if (-not (Test-Path -LiteralPath $ReleaseRoot -PathType Container)) {
    throw '検証済みリリースの配置先が見つかりません。'
}
if (Test-Path -LiteralPath $InstallRoot) {
    if (@(Get-ChildItem -LiteralPath $InstallRoot -Force).Count -gt 0) {
        throw 'InstallRootに既存ファイルがあります。上書きせず、対象環境を確認してください。'
    }
}


New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
foreach ($directory in @('public', 'src', 'templates', 'resources', 'scripts', 'config')) {
    Copy-Item -LiteralPath (Join-Path $ReleaseRoot $directory) -Destination $InstallRoot -Recurse
}
foreach ($file in @('bootstrap.php', 'version.php')) {
    Copy-Item -LiteralPath (Join-Path $ReleaseRoot $file) -Destination $InstallRoot
}
```

コピー後、公開物理パスが`C:\Netarium\app\public`になっていることを確認します。次に、実行時データの全ディレクトリを作成します。

```powershell
$runtimeDirectories = @(
    '',
    'db',
    'db/csv-import',
    'uploads',
    'uploads/floorplans',
    'uploads/device_images',
    'backups',
    'backups/auto',
    'logs',
    'temp',
    'temp/backup-export',
    'temp/backup-restore'
)
foreach ($relativePath in $runtimeDirectories) {
    New-Item -ItemType Directory -Path (Join-Path $StorageDir $relativePath) -Force | Out-Null
}
```

### `config/app.php`を作成する

`config/app.php`は環境固有ファイルです。`storage_dir`を実際の実行時領域へ設定し、UTF-8 BOMなしで保存します。次の例は`C:\Netarium\app\data`を使います。

```powershell
$configPath = Join-Path $InstallRoot 'config/app.php'
$config = @'
<?php
declare(strict_types=1);

return [
    'storage_dir' => 'C:\\Netarium\\app\\data',
    'allow_legacy_bcrypt' => true,
];
'@
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
if (Test-Path -LiteralPath $configPath -PathType Leaf) {
    throw 'config/app.phpが既にあります。内容と承認済み構成記録を確認してから作業してください。'
}
[System.IO.File]::WriteAllText($configPath, $config, $utf8NoBom)
```

別の配置先を使う場合は、PHP文字列内のパスを変更します。既に`config/app.php`がある場合は内容と承認済み構成記録を照合し、無断で上書きしません。パスワード、秘密鍵、トークンをこのファイルやGitへ記録しないでください。

`allow_legacy_bcrypt`はboolで指定します。`true`は承認した移行期間の旧bcrypt照合だけを許可し、新規生成をbcryptへ戻す設定ではありません。全bcryptの明示移行後、v1.0.0前に残存ゼロを確認して`false`へ移行期間を終了します。OPcache有効環境では設定ファイルの書換えだけで完了と判定せず、実HTTP workerへの反映確認が必要です。安全な適用手順（要求受付停止・排出・worker反映確認・再開判定）および残存利用者への対応は[運用ガイド](operations.md#認証設定の適用とhttp-worker反映確認185)に従います。

## 3. 専用Application PoolとIIS Siteを作成する

以下は`Netarium`という専用Application Poolの例です。管理者PowerShellで作成します。

```powershell
$SiteName = 'Netarium'
$PoolName = 'Netarium'

New-WebAppPool -Name $PoolName
Set-ItemProperty "IIS:\AppPools\$PoolName" -Name managedRuntimeVersion -Value ''
Set-ItemProperty "IIS:\AppPools\$PoolName" -Name processModel.identityType -Value ApplicationPoolIdentity
```

.NET CLRは`No Managed Code`、実行IDは`ApplicationPoolIdentity`にします。他のSiteと共用せず、既存の同名Poolがある場合は設定と利用Siteを確認してから使用します。独自の実行アカウント（`SpecificUser`）を使用する場合は、本Site専用のアカウントとし、他のApplication Poolやサービスとユーザーアカウントを共有してはなりません（同一ユーザーを複数Poolで共有すると、Windows NTFSのファイル所有者権限によりセッション分離が破られます）。`LocalSystem`や`NetworkService`等の共有システムIDも使用禁止です。

IIS Managerで`Sites`を右クリックして`Add Website`を選びます。

- Site name: `Netarium`
- Application Pool: `Netarium`
- Physical path: `C:\Netarium\app\public`
- Binding: 次のHTTPまたはHTTPSのいずれか
- `Start Website immediately`はオフにし、権限・PHP・Site設定を確認するまでSiteを停止状態に保つ

既存のSite名、Binding、Application Poolを無断で置換しません。同一IP・ポート・ホスト名のBindingが既にある場合は、競合を解消する責任者と調整してから進めます。

### HTTP Binding

閉域の検証環境など、組織の方針でHTTPが許可される場合に使用します。

- Type: `http`
- Host name: サービスFQDN（例:`netarium.intra.local`）
- Port: 通常`80`。非標準ポートなら組織の構成記録に従う

### HTTPS Binding

HTTPSを推奨します。DNS管理者はサービスFQDNをIISサーバーまたは承認済みの入口へ向けます。証明書管理者は、そのサービスFQDNをSANに含み、有効期限内・秘密鍵付き・Server Authentication EKUの証明書を用意し、`Cert:\LocalMachine\My`へ安全に配置します。ホストFQDN用の証明書を流用せず、サービスFQDNに一致する証明書を選びます。

```powershell
Resolve-DnsName netarium.intra.local
Get-ChildItem Cert:\LocalMachine\My |
    Select-Object Subject, DnsNameList, Thumbprint, NotAfter, HasPrivateKey, EnhancedKeyUsageList
```

DNSが予定した宛先を返すこと、利用端末からポートへ到達できること、証明書のSAN・EKU・有効期限・秘密鍵・クライアントからの信頼性を確認します。DNS登録と証明書発行はNetariumが自動化しません。

IIS ManagerのSite Bindingで次を設定します。

- Type: `https`
- Host name: サービスFQDN
- Port: 通常`443`
- SSL certificate: 上記証明書
- `Require Server Name Indication`（SNI）: 有効


同一IPの443番ポートで複数のHTTPS Siteを運用する場合、ホスト名とSNIでSiteを識別し、Binding競合を避けます。TLS終端をReverse Proxy等へ委任する構成では、証明書と外部Bindingはその管理者が設定し、Netarium側には承認済みの内部Bindingを設定します。`VerificationUrl`には利用者が実際に到達するSiteルートを指定します。

### 既存Bindingを維持する場合

既存のIIS SiteやReverse Proxy構成を利用する場合は、管理者が指定したSiteとBindingだけを使います。SiteのApplication Poolと物理パスを確認し、公開パスを`<InstallRoot>\public`に限定します。既存Binding・証明書・SNI・Proxy転送規則を変更しません。IIS内外のURLが異なる場合は、外部のサービスFQDNを使った`VerificationUrl`で検査します。

### IIS実行時の保存先上書きを確認する

Siteを起動する前に、使用するSite、Application Pool、PHP FastCGIに`NETARIUM_STORAGE_DIR`や`NETARIUM_DB_FILE`が設定されていないことを確認します。これらは`config/app.php`より優先されます。一方、`check-install.php`は検査時に保存先を`--storage-dir`へ置き換えるため、CLI検査の成功だけではIIS実行時の保存先を保証できません。新規Site・既存Siteのどちらでも、構成を確定した後、Site起動前に実行します。

```powershell
$MachinePath = 'MACHINE/WEBROOT/APPHOST'
$site = Get-Website -Name $SiteName -ErrorAction Stop
if ($null -eq $site -or [string]$site.ApplicationPool -ine $PoolName) {
    throw '対象SiteのApplication Poolが指定値と一致しません。実際の割り当てを確認してください。'
}
$siteEnvironment = @(
    Get-WebConfiguration -PSPath "IIS:\Sites\$SiteName" `
        -Filter 'system.webServer/asp/environmentVariables/add' -ErrorAction Stop
)
$poolEnvironment = @(
    Get-WebConfiguration -PSPath $MachinePath `
        -Filter "system.applicationHost/applicationPools/add[@name='$PoolName']/environmentVariables/add" `
        -ErrorAction Stop
)
$fastCgiEnvironment = @(
    Get-WebConfiguration -PSPath $MachinePath `
        -Filter 'system.webServer/fastCgi/application' -ErrorAction Stop |
        Where-Object { [string]$_.fullPath -ieq $PhpCgi } |
        ForEach-Object {
            if ($_.PSObject.Properties.Name -contains 'environmentVariables' -and
                $null -ne $_.environmentVariables) {
                @($_.environmentVariables.add)
            }
        }
)
$storageOverrides = @(
    @($siteEnvironment) + @($poolEnvironment) + @($fastCgiEnvironment) |
        Where-Object {
            $null -ne $_ -and [string]$_.name -in @('NETARIUM_STORAGE_DIR', 'NETARIUM_DB_FILE')
        }
)
if ($storageOverrides.Count -gt 0) {
    throw 'IISに保存先の環境変数が設定されています。Siteを起動せず構成管理者に確認してください。'
}
```

`$SiteName`、`$PoolName`、`$PhpCgi`には実際に使う値を指定します。既存の上書き設定は空値でも安易に無視・削除せず、用途と他Siteへの影響を確認してください。組織がプロセスの環境変数をIIS以外（Windowsのシステム環境変数等）で設定している場合も、同じ2変数がPHPに渡らないことを管理者と確認します。

## 4. FastCGI、PHP Handler、要求サイズを設定する

### FastCGI登録

FastCGIの`application`登録はサーバー単位で、追加・変更にはIIS構成管理者の権限が必要です。既存のPHP FastCGIエントリを調べ、他Siteが同じ実行ファイルを使う場合は共用影響とタイムアウト値を確認します。共用設定を他Siteに影響する形で変更しません。

```powershell
$MachinePath = 'MACHINE/WEBROOT/APPHOST'
$PhpCgi = 'C:\php\php-cgi.exe'
$ActivityTimeoutSeconds = 300
$RequestTimeoutSeconds = 300
$phpApplications = @(
    Get-WebConfiguration -PSPath $MachinePath `
        -Filter 'system.webServer/fastCgi/application' -ErrorAction Stop |
        Where-Object { [string]$_.fullPath -ieq $PhpCgi }
)

if ($phpApplications.Count -eq 0) {
    Add-WebConfigurationProperty -PSPath $MachinePath `
        -Filter 'system.webServer/fastCgi/application' -Name '.' `
        -Value @{ fullPath = $PhpCgi; activityTimeout = $ActivityTimeoutSeconds; requestTimeout = $RequestTimeoutSeconds } `
        -ErrorAction Stop
} else {
    $usedByOtherSite = $false
    foreach ($site in @(Get-Website)) {
        if ([string]$site.Name -ieq $SiteName) {
            continue
        }
        $sitePath = "IIS:\Sites\$($site.Name)"
        $siteHandlers = @(
            Get-WebConfiguration -PSPath $sitePath `
                -Filter 'system.webServer/handlers/add' -ErrorAction Stop
        )
        if (@($siteHandlers | Where-Object { [string]$_.scriptProcessor -ieq $PhpCgi }).Count -gt 0) {
            $usedByOtherSite = $true
            break
        }
    }

    foreach ($application in $phpApplications) {
        $filter = "system.webServer/fastCgi/application[@fullPath='$PhpCgi']"
        $hasDifferentTimeouts = (
            [int]$application.activityTimeout -ne $ActivityTimeoutSeconds -or
            [int]$application.requestTimeout -ne $RequestTimeoutSeconds
        )
        if ($usedByOtherSite -and $hasDifferentTimeouts) {
            throw 'PHP FastCGI設定を他のSiteと共用しており、要求タイムアウト値が一致しません。共用先を確認してください。'
        }
        if (-not $usedByOtherSite) {
            Set-WebConfigurationProperty -PSPath $MachinePath -Filter $filter `
                -Name activityTimeout -Value $ActivityTimeoutSeconds -ErrorAction Stop
            Set-WebConfigurationProperty -PSPath $MachinePath -Filter $filter `
                -Name requestTimeout -Value $RequestTimeoutSeconds -ErrorAction Stop
        }
    }
}
```

同じ`php-cgi.exe`を他Siteが利用中で時間値が異なる場合は、共用Siteへの影響を評価するまで変更を止めます。PHPの`max_execution_time`とFastCGIの両タイムアウトを最低180秒以上にし、通常は300秒に揃えます。

### Site単位のPHP Handler

`.php`を`FastCgiModule`へ割り当てます。`$SiteName`と`$PhpCgi`を実際のSite名・実行ファイルへ置き換えます。IISの構成セクションがロックされている場合は、後述のSite限定手順を先に完了してください。既存の同じSiteに`*.php` Handlerがある場合は、別の実行ファイルを使っていないか確認し、重複追加しません。

```powershell
$handlers = @(
    Get-WebConfiguration -PSPath $MachinePath -Location $SiteName `
        -Filter 'system.webServer/handlers/add'
)
$phpHandlers = @($handlers | Where-Object { [string]$_.path -eq '*.php' })
if ($phpHandlers.Count -eq 0) {
    Add-WebConfigurationProperty -PSPath $MachinePath -Location $SiteName `
        -Filter 'system.webServer/handlers' -Name '.' `
        -Value @{
            name = 'Netarium-PHP'
            path = '*.php'
            verb = '*'
            modules = 'FastCgiModule'
            scriptProcessor = $PhpCgi
            resourceType = 'Either'
            requireAccess = 'Script'
        }
} elseif (@($phpHandlers | Where-Object { [string]$_.scriptProcessor -ine $PhpCgi }).Count -gt 0) {
    throw '既存のPHP Handlerは別のphp-cgi.exeを参照しています。IIS Siteの設定を確認してください。'
}
```

### Site単位の既定ドキュメント

ルートURLから`index.php`を実行できるよう、対象Siteだけで既定ドキュメントを有効にして登録します。未登録のままだと、`login.php`を直接指定できてもルートURLが403になることがあります。既存の一覧を消去せず、重複登録もしません。

```powershell
Set-WebConfigurationProperty -PSPath $MachinePath -Location $SiteName `
    -Filter 'system.webServer/defaultDocument' -Name enabled -Value $true
$defaultDocuments = @(
    (Get-WebConfiguration -PSPath $MachinePath -Location $SiteName `
        -Filter 'system.webServer/defaultDocument/files').Collection
)
if (@($defaultDocuments | Where-Object { [string]$_.value -ieq 'index.php' }).Count -eq 0) {
    Add-WebConfigurationProperty -PSPath $MachinePath -Location $SiteName `
        -Filter 'system.webServer/defaultDocument/files' -Name '.' `
        -AtIndex $defaultDocuments.Count -Value @{ value = 'index.php' }
}
```

`index.php`は一覧末尾へ追加します。更新時に保守用の`app_offline.htm`を先頭へ追加する処理を妨げないよう、`public\web.config`で既定ドキュメント一覧を消去しません。

### Site単位の要求サイズ

Netariumの通常SiteのIIS要求上限は32MiB（`33554432` bytes）にします。IISの構成セクションがロックされている場合は、下記のSite限定手順を先に完了してから設定します。

```powershell
Set-WebConfigurationProperty -PSPath $MachinePath -Location $SiteName `
    -Filter 'system.webServer/security/requestFiltering/requestLimits' `
    -Name maxAllowedContentLength -Value 33554432
```

リリースに含まれる`public\web.config`は、ディレクトリ参照の無効化、非公開ディレクトリ・拡張子の遮断、セキュリティヘッダー、要求上限を定義します。改変せずに配置し、Site設定と合わせて使います。

画像投稿専用の`image_upload.php`には、同じ`web.config`の`location`で31MiB（`32505856` bytes）の要求上限を適用し、IISが返す404.13専用エラーページ（`error-404-13.html`）を定義します。図面の入力は30MiB・各辺7,000px・3,500万画素以下、写真の入力は10MiB以下で、multipartを含む要求全体が31MiB以下です。図面は向き補正後に長辺4,096px以下へ自動縮小し、同形式・10MiB以下の変換結果だけを保存します。小画像を拡大せずPNG透過を保持し、原本は永続保存しません。JPEG品質95・PNG圧縮8は初期採用値で、実スキャンの可読性は未確認です。Siteの通常要求32MiB（33554432 bytes）、PHPの`upload_max_filesize=32M`、`post_max_size=34M`、`memory_limit=512M`、実行期限300秒とします。約3,100万画素や上限3,500万画素のGD処理では入力・向き補正・縮小先のメモリが共存するため、実IISでピークメモリ・処理時間・複数worker時の余裕を測定します。通常APIと同様にPHPハンドラー・認証・CSRFを使用します。新URLの未認証401、通常登録、31MiB超過のIIS404.13とPHP INI不足の案内の区別、実ブラウザーでの表示・差し替え調整、実A3スキャンの文字・細線の可読性を配備受入で確認してください。

#### IIS構成セクションがロックされている環境

`public\web.config`は`requestFiltering`および画像入口の`httpErrors`を含みます。IISでこれらのセクションがロックされている場合、子の`web.config`から設定するとHTTP 500.19等の構成エラーになります。IIS構成管理者が許可する場合は、サーバ全体ではなくNetarium Siteだけに委任を設定します。Microsoftの[IIS構成ロック手順](https://learn.microsoft.com/en-us/iis/get-started/planning-for-security/how-to-use-locking-in-iis-configuration)では、`applicationHost.config`の`<location path="SiteName" overrideMode="Allow">`で対象パスだけを許可する方法が説明されています。

管理者PowerShellでIIS構成バックアップを作成し、ロックされているセクションだけをSite単位で解除します。既に解除済みのセクションには実行不要です。

```powershell
$appcmd = Join-Path $env:windir 'System32\inetsrv\appcmd.exe'
$backupName = 'netarium-before-site-unlock-' + (Get-Date -Format 'yyyyMMddHHmmss')
& $appcmd add backup $backupName
if ($LASTEXITCODE -ne 0) { throw 'IIS構成のバックアップに失敗しました。' }

& $appcmd unlock config $SiteName /section:system.webServer/handlers
if ($LASTEXITCODE -ne 0) { throw 'Netarium Siteのhandlersセクションを解除できません。' }
& $appcmd unlock config $SiteName /section:system.webServer/security/requestFiltering
if ($LASTEXITCODE -ne 0) { throw 'Netarium SiteのrequestFilteringセクションを解除できません。' }
& $appcmd unlock config $SiteName /section:system.webServer/httpErrors
if ($LASTEXITCODE -ne 0) { throw 'Netarium SiteのhttpErrorsセクションを解除できません。' }
```

`$SiteName`は対象のIIS Site名です。この`appcmd unlock config <SiteName>`指定は当該Siteだけに作用し、サーバ全体の既定値や他Siteのロックを変更しません。Site限定の変更を承認されてから実行し、続けて上記のSite単位Handlerと要求上限を設定します。IIS Managerを使う場合も、対象Siteのスコープで該当セクションを許可します。

対象Site単位の許可が組織ポリシーで認められない場合、またはロックエラーが解消しない場合は作業を止めてIIS構成管理者へ引き継ぎます。`Unlock-WebConfiguration`等によるサーバ全体へのunlock、`overrideModeDefault`の全体変更、他Siteの設定変更は行いません。Site単位で変更した後は、`applicationHost.config`の対象Site以外に差分がないことと、SiteのHTTP応答を確認します。

## 5. Application PoolのACLを設定する

ApplicationPoolIdentityには、アプリケーション領域への読み取り・実行と、実行時データ領域への変更権限だけを付与します。`public/`、`src/`、`templates/`、`resources/`、`scripts/`、`config/`へ書き込みを許可しません。

新規の隔離した配置先で、管理者PowerShellから以下を実行する例です。

```powershell
. "$InstallRoot\scripts\deployment-common.ps1"
Set-NetariumAcl -InstallRoot $InstallRoot -StorageDir $StorageDir -ApplicationPoolName $PoolName
icacls "$StorageDir\bootstrap"
```

共通ACL関数はプログラム領域へ読み取り・実行、実行時領域へ変更権限を設定します。プログラム領域では広範な書込ACEを除去しますが、Readを一律に削除しません。`data/`と`config/`では一般利用者・別Poolの既存明示Readも除去し、`SYSTEM`・`Administrators`と対象Poolだけに限定します。必要主体は[運用ガイドのACL表](operations.md#機密領域のaclとスナップショット)を参照してください。最後に`data/bootstrap`を作成し、継承を遮断して所有者とアクセス権を`SYSTEM`・`Administrators`だけに設定します。Pool Identityには秘密領域の読取権限も与えません。専用ACLは秘密の生成前に必要です。独自の管理用ACEは秘密領域では保持しません。生成後に`icacls /T`でプール権限を再付与せず、変更時にも共通ACL関数で専用ACLを維持してください。

実行時ストレージ配下の任意追加辞書領域（本文ディレクトリ `password-blocklist` および兄弟 manifest `password-blocklist.json`）には、親ストレージの変更権限（Modify）の継承を許しません。
`Set-NetariumAcl` は `Set-NetariumPasswordBlocklistAcl` を呼び出し、親ストレージの削除権限を明示的に拒否したうえで、所有者と書込み権限を `SYSTEM` と `Administrators` だけに限定し、ApplicationPoolIdentity には読取りのみを許可する専用 ACL を適用します。
手動でアクセス権を再設定する場合も、親ストレージの変更権限が追加辞書へ継承されないように設定します。
追加辞書の登録・更新手順やアクセス権仕様の詳細は、[運用ガイド](operations.md#任意追加辞書)を参照します。

アプリのfilesセッション保存先は有効な`storage_dir`配下の`sessions`です。PHP設定の旧保存先ではなく、実際にこのディレクトリへファイルが作成され、対象Poolだけが利用できることを確認します。旧保存先のファイルを一括削除せず、対象アプリと共有有無を特定してから運用上の失効を判断します。

## 6. CLIで初期化・検査する

Siteを停止した状態で、IIS実行IDの書き込み権限、`config/app.php`、PHP CLIの拡張を確認してから実行します。`check-install.php`はDBを初期化・マイグレーションし、スキーマ・外部キー・実行時ディレクトリ・図面と画像ファイルを検査します。

```powershell
$PhpCli = 'C:\php\php.exe'
& $PhpCli "$InstallRoot\scripts\check-install.php" `
    --app-root $InstallRoot `
    --storage-dir $StorageDir
if ($LASTEXITCODE -ne 0) {
    throw 'NetariumのCLI導入検査に失敗しました。IISを起動せず、出力されたエラーを調査してください。'
}
```

成功時は`{"ok":true,...}`を確認します。失敗時はエラーを記録し、エラー原因が解消するまでSiteを起動しません。

続けて、SiteとPoolを停止したまま実配備DBへ初期登録用秘密を発行します。

```powershell
$SecretFile = Join-Path "$StorageDir\bootstrap" ('setup-' + [Guid]::NewGuid().ToString('N') + '.secret')
& $PhpCli "$InstallRoot\scripts\issue-bootstrap-secret.php" `
    --secret-file $SecretFile --db "$StorageDir\db\data.sqlite"
if ($LASTEXITCODE -ne 0) { throw '初期登録用秘密を発行できません。IISを起動しません。' }
```

CLIは32バイトの乱数を64文字の小文字16進数として新規ファイルへ保存し、flush/fsync成功後にSHA-256だけをDBへ登録します。既存ファイルを上書きせず、画面出力はパスだけです。ローカル管理者が保護済みファイルを安全なエディターで開き、初期管理者へ承認済みの安全な経路で渡します。秘密をログ、URL、PowerShell transcript、チャット履歴に出力しません。入力はHTTPSを推奨し、承認済みHTTPでは初期登録用秘密も盗聴・改ざんされ得ることを受容して接続元制限下で行います。


## 7. Siteを起動し、初期管理者を作成する

DNS、HTTP/HTTPS Binding、証明書、接続元制限、Site物理パスを確認し、IIS ManagerでApplication PoolとSiteを開始してから、疎通確認と`/login.php`への接続を行います。

```powershell
$ServiceFqdn = 'netarium.intra.local'
$BindingPort = 443 # HTTPなら80または組織指定のポートに変更
Resolve-DnsName $ServiceFqdn
Test-NetConnection $ServiceFqdn -Port $BindingPort
```


1. 初回は`login.php`から`setup.php`へ移動することを確認します。
2. 初期登録用秘密と、12～128文字（Unicodeコードポイント）・UTF-8最大512バイトのパスワードで初期管理者を作成します。条件の詳細は[管理者ガイド](administrator-guide.md#初回起動)を参照してください。成功直後にローカル管理者が秘密の発行ファイルと受渡し用コピーを削除します。全損復旧時は復旧作業用の一時adminとして扱います。
3. ログインし、画面が読み込めることを確認します。
4. 初期設定ページを手動削除しません。利用者登録後はアプリケーションが初期設定を閉じます。

登録に失敗した場合は入力・監査・DB環境を修正して同じ秘密で再試行できます。紛失・漏えいの疑い・発行失敗時は[再発行手順](deployment.md#初期登録用秘密の再発行)で新しいファイル名へ発行します。成功した再発行は旧秘密を失効させます。未登録の失敗ファイルを有効な秘密として渡しません。登録済みの場合は再発行せず`recover-admin.php`を使用します。

## 8. 全損時の制約とWeb構成復元

Web構成情報ZIPは全損復旧用の完全バックアップではありません。画像実体・利用者・環境設定を含まず、旧画像同梱形式2〜7も受け付けません。画像実体・利用者を含む全損復旧にはサーバー管理者用の停止型完全バックアップCLI（`scripts/backup-full.ps1`／`scripts/restore-full.ps1`）を使用します。

全損時はサーバを隔離し、残存DB・画像・ログと外部資材を保全して、[運用ガイド](operations.md#サーバ全損からの再構築)の制約を確認してください。本ガイドの新規配備部分で空環境を構築できますが、Web ZIPを読み込んだだけで画像・利用者まで復旧したとは判断できません。`data/backups/auto`や更新スナップショットもサーバ外の完全バックアップの代替ではありません。

サーバー管理者用の停止型完全バックアップ CLI も任意追加辞書を対象外とします（Web 構成情報 ZIP や更新スナップショットにも含まれません）。
追加辞書を運用する環境では、サーバー管理者が本文領域 `<StorageDir>\password-blocklist` と兄弟 manifest `<StorageDir>\password-blocklist.json` を組として、別系統の保護された保管場所へ退避・管理します。
全損復旧の際は、一般利用を再開する前に、管理者がこの組をストレージへ復元して専用 ACL を適用し、アプリケーションと同じストレージを指定して `check-install.php` を実行します。
有効登録後に兄弟 manifest や本文の欠損・改変・不整合があると、新規パスワード設定と配備診断は fail-closed として失敗します。
本文領域と manifest の両方を全損した状態は、アプリケーションから未設定環境と区別できません。
追加辞書を使う運用では復旧資材がなくても自動で再開せず、未設定状態で再開するか原本から再登録するかを運用責任者が判断します。
バックアップ・復元・解除手順の詳細は、[運用ガイド](operations.md#任意追加辞書)を参照します。

画像実体が残る環境で構成を戻す場合は、次の順に確認します。

1. 復元先と同じアプリ版・スキーマ11の`netarium-config`形式1を用意します。ZIPはJSONの`manifest.json`と`data/netarium.json`だけで、24MiB以下・展開後合計64MiB以下です。
2. 管理者が「バックアップと復元」でZIPを選択し、機器・ビュー・構成の件数と画像影響を確認します。画像は保存名・サイズ・MIME・寸法・SHA-256がすべて一致する既存実体だけを参照します。欠損・不一致件数と機器ID／ビューIDを確認し、元メタデータを含むZIPを保管します。
3. 確認欄に「バックアップから復元」と入力して確定します。現行構成は同じ構成情報ZIPで自動退避します。画像実体は作成・上書き・移動・削除せず、復元の画像GCも行いません。
4. 利用者・パスワード・全セッションは実行者を含め維持するため、再ログインせず画面を再読み込みします。構成と照合済み画像参照を確認し、「後処理要対応」があれば二重復元せずログを確認します。

登録時のhash保存と旧行の初回出力時補完、固定JSONテーブル・互換・安全ルールは[運用ガイド（復元）](operations.md#復元)を参照してください。画像登録の全体一律上限は設けず、PHP推奨設定を`upload_max_filesize=32M`／`post_max_size=34M`、IIS通常要求上限を32MiBとします。


## 9. セキュリティと最終確認

初期管理者作成後、および全損復旧時のデータ復元・利用者再作成後に、次の検査を行います。
任意追加辞書を運用している環境では、標準 PWDB に加えて兄弟 manifest と本文の整合性も検査します。
第 8 節の手順に従って、資材の復元と専用 ACL の適用を完了させてから実行します。


```powershell
& $PhpCli "$InstallRoot\scripts\check-install.php" `
    --app-root $InstallRoot `
    --storage-dir $StorageDir
if ($LASTEXITCODE -ne 0) {
    throw 'NetariumのCLI導入検査に失敗しました。'
}

$VerificationUrl = 'https://netarium.intra.local/'
powershell -ExecutionPolicy Bypass -File "$InstallRoot\scripts\verify-security.ps1" `
    -VerificationUrl $VerificationUrl
if ($LASTEXITCODE -ne 0) {
    throw 'HTTP公開範囲・認証境界の検査に失敗しました。Siteを公開せず原因を調査してください。'
}
```

HTTPを使う環境では`$VerificationUrl`を`http://<サービスFQDN>/`にします。非標準ポートやReverse Proxyを使う場合は、利用者が実際に到達する正しいSiteルートURLを指定します。別のIIS Siteを検査しないよう、名前解決、Binding、証明書を先に確認してください。

`verify-security.ps1`で以下を確認します。

- `login.php`: HTTP 200
- 未認証`api.php?action=load`: HTTP 401
- 初期設定済み`setup.php`: ログイン画面へのHTTP 302、またはHTTP 404
- `data/db/data.sqlite`、`config/app.php`、`src/Autoloader.php`等の非公開パス: HTTP 403または404で拒否

アプリケーション管理者は実ブラウザでログイン、ビュー・機器の保存と再読み込み、図面・機器画像の登録と表示、主要画面、必要なアップロードを確認します。自動・CLI検査は実ブラウザでの表示・操作確認を代替しません。確認できない項目がある場合は業務公開前に担当者へ引き継ぎます。

登録したフロア図面・機器画像が認証済みの`floor_plan.php`・`device_image.php`経由で表示され、未ログインの別ブラウザでは同じ画像URLを取得できないことを確認します。この確認は`verify-security.ps1`の非公開パス検査とは別に行います。

## 10. 自動setupとの処理対応

手動で設定する対象と`scripts/setup-iis.ps1`内の処理の対応です。実装変更時はこの表と両方の手順を確認します。

| 手動作業 | `setup-iis.ps1`の処理 |
|---|---|
| 実行時ディレクトリ作成 | `New-NetariumRuntimeTree` |
| `config/app.php`作成 | `New-NetariumAppConfig` |
| Application Pool作成 | `Ensure-NetariumAppPool` |
| IIS Site作成 | `Ensure-NetariumSite` |
| HTTP/HTTPS Binding・証明書 | `Ensure-NetariumBinding` |
| IIS保存先環境変数の確認 | `Get-NetariumEnvironmentMap`と既存設定の拒否 |
| PHP FastCGI登録・timeout | `Ensure-NetariumPhpFastCgi` |
| Site単位PHP Handler | `Ensure-NetariumPhpHandler` |
| Site単位要求上限 | `Ensure-NetariumRequestLimit` |
| Application Pool ACL | `Set-NetariumAcl` |
| CLI初期化・検査 | `Invoke-NetariumInstallCheck` |
| fresh setupのHTTP検査 | `Assert-NetariumFreshProbe`、`verify-security.ps1` |

自動setupは開始前のスナップショット、失敗時のロールバック、構成差分確認も行います。手動手順ではこれらを自動実行しないため、開始前の状態を記録し、エラー時はSiteを停止して変更箇所を調査してください。

## 検証環境での確認

手動配備と全損復旧の検証は[開発ガイド（配備の確認）](development.md#配備スクリプトの確認)に従います。実IISの機械判定と人によるブラウザ確認を分けて記録し、未実施項目を合格扱いにしません。
