# Netarium クイックスタートガイド

本書は、Windows Server / IIS 環境のサーバー管理者を対象に、Netarium の基本的な運用操作を最短で把握できるようまとめた簡潔な手順書です。

各操作のコマンドは、**管理者権限の PowerShell** で実行します。コマンド中のホスト名、パス、パラメータは環境に合わせて置換してください。

---

## バックアップとリストアの区別

Netarium には、**Web画面からの構成情報バックアップ** と、**サーバー管理者による完全バックアップ** の2系統があります。目的と復元範囲が異なるため、混同しないよう注意してください。

| 項目 | Web構成情報バックアップ | サーバー完全バックアップ |
|---|---|---|
| **主な対象** | 機器・ビュー・配置・接続等の構成情報（メタデータ） | SQLite DB全体・画像実体・ユーザー情報 |
| **フロア図面・機器画像** | 参照情報のみ（画像実体は含まない） | 実体ファイルを完全収録 |
| **ユーザー・認証情報** | 含まない（アカウント・パスワードは対象外） | 含む（アカウント、パスワードハッシュ、権限） |
| **実行方法** | Web画面（「その他」→「バックアップと復元」） | CLI（`scripts/backup-full.ps1`） |
| **復元方法** | Web画面（「その他」→「バックアップと復元」） | CLI（`scripts/restore-full.ps1`） |
| **サービス一時停止** | なし（稼働したまま取得・復元） | **あり**（Site / AppPool が一時停止） |
| **既存セッション** | 影響なし（維持される） | **復元時に失効**（復元後は全ユーザー再ログインが必要。※バックアップ作成時は失効しません） |
| **既存画像の物理ファイル** | 復元時に削除しない | バックアップ時の状態へ完全置換 |
| **全損復旧への適合** | **不可**（全損復旧には使用できない） | **適合**（空ホストからの再構築・復旧に対応） |
| **保管上の注意** | 構成情報を含むため機密管理 | DB・画像・ハッシュを含むため厳重に暗号化・保護し、サーバー外へ保管 |

日常の構成変更の保全にはWeb構成情報バックアップを用い、バージョン更新前や障害・全損に備えた定期保全にはサーバー完全バックアップを使用します。

---

## 1. インストール（新規導入）

### 目的
Windows Server + IIS + PHP 環境へ Netarium を新規セットアップし、専用の IIS Site および Application Pool を作成してサービスを開始します。

### 実行コマンド例
管理者 PowerShell で展開したリリースディレクトリに移動し、セットアップスクリプトを対話モードで実行します（最短手順）。

```powershell
Set-Location C:\staging\netarium
powershell -ExecutionPolicy Bypass -File .\scripts\setup-iis.ps1
```

プロンプトに従い、設置先ディレクトリ、Site 名、Application Pool 名、`php-cgi.exe` パス、Binding 方式（https / http / existing）等を入力します。

※ 自動化スクリプト等で引数をすべて指定して非対話実行する場合は、`-NonInteractive` を指定します。

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
  -NonInteractive
```

### 実行後の確認方法と初期管理者の作成
1. インストール検証スクリプトを実行し、正常終了することを確認します。
   ```powershell
   php C:\Netarium\app\scripts\check-install.php --app-root C:\Netarium\app --storage-dir C:\Netarium\app\data
   powershell -ExecutionPolicy Bypass -File .\scripts\verify-security.ps1 -VerificationUrl https://netarium.example.local/
   ```
2. **初期管理者の作成（初回セットアップ）**:
   - 初回アクセス時、ブラウザでサービス URL（例: `https://netarium.example.local/`）を開くと初期管理者作成画面（`setup.php`）が表示されます。登録には**一回限りの初期登録用秘密（ワンタイムコード）**が必要です。
   - **コードの確認方法**: セットアップ完了時にコンソール末尾に表示された秘密ファイルのパス（例: `C:\Netarium\app\data\bootstrap\setup-<識別子>.secret`）を確認し、サーバー上のローカルエディタ（メモ帳等）で開いて記載されている64文字のコードを確認します（※PowerShellコンソール出力やチャット等へ平文で残さないでください）。
   - **画面での登録**: 画面の案内に従い、ワンタイムコード、管理者ユーザー名（3〜50文字の半角英数字等）、パスワード（12〜128文字）を入力して初期管理者を登録します。
   - **登録後の整理**: 登録成功後、サーバー上の秘密ファイル（および受渡し用コピー）を削除してください（登録完了により秘密のハッシュはDBから消去され、`setup.php` は自動的に閉鎖されます）。

### 特に重要な注意点
- 管理者権限の PowerShell で実行してください。
- 前提条件として、IIS（CGI / FastCGI 含む）、PHP 8.5.5以上（必要な拡張機能有効化済み）、URL Rewrite、有効な証明書（HTTPS利用時）が準備されている必要があります。
- 本番環境では原則として HTTPS を使用してください。HTTP は閉域・隔離環境かつリスク受容が承認された場合に限られます。

### 詳細ドキュメント
- [配備ガイド](deployment.md)：前提条件、PHP・IIS の設定詳細、パラメータ一覧
- [手動配備・全損復旧ガイド](deployment-manual.md)：スクリプトを使用せず手動で構築する場合の手順

---

## 2. アップデート（バージョン更新）

### 目的
既存の Netarium 環境のデータ・設定を維持したまま、プログラムを新しいリリース版へ安全に更新します。

### 実行コマンド例
管理者 PowerShell で新しいリリースのディレクトリへ移動し、更新スクリプトを実行します。

```powershell
Set-Location C:\staging\netarium-new
powershell -ExecutionPolicy Bypass -File .\scripts\update.ps1 `
  -SourcePath C:\staging\netarium-new `
  -InstallRoot C:\Netarium\app `
  -SiteName Netarium `
  -ApplicationPoolName Netarium `
  -PhpCgiPath C:\php\php-cgi.exe `
  -VerificationUrl https://netarium.example.local/
```

### 実行後の確認方法
1. コンソールに更新完了メッセージが表示されることを確認します。
2. セキュリティ検証を実行して正常性を確認します。
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\scripts\verify-security.ps1 -VerificationUrl https://netarium.example.local/
   ```
3. 管理者ブラウザで再ログインし、バージョン表記および主要機能（機器台帳、図面表示等）が正常に動作することを確認します。

### 特に重要な注意点
- **更新前に必ずデータを保全してください。** 予期せぬトラブルに備え、後述の「サーバー完全バックアップ」を取得してサーバー外へ退避しておくことが強く推奨されます。
- 更新中は要求排出と一時停止が行われ、一時的に保守画面が表示されます。
- 更新処理中にエラーが発生した場合は自動的にロールバック（元の版への復元）が行われます。失敗時に手動でアンインストールや新規セットアップを実行しないでください。

### 詳細ドキュメント
- [更新ガイド](update.md)：更新前の準備、要求排出、自動・手動ロールバックの詳細

---

## 3. バックアップ（データの保全）

### 目的
データベース全体、登録画像の実体、ユーザー情報などを一体として取得し、サーバー全損や障害時に完全復旧できるバックアップアーカイブ（ZIP）を作成します。

### 実行コマンド例
管理者 PowerShell で設置先ディレクトリへ移動し、完全バックアップスクリプトを実行します（またはスクリプトを絶対パスで指定します）。

```powershell
Set-Location C:\Netarium\app
powershell -ExecutionPolicy Bypass -File .\scripts\backup-full.ps1 `
  -InstallRoot C:\Netarium\app `
  -SiteName Netarium `
  -ApplicationPoolName Netarium `
  -BackupDirectory D:\Backups\Netarium
```

※ Web画面（「その他」→「バックアップと復元」）から取得できる構成情報ZIPは、構成メタデータのみの保存となります（画像実体やアカウントは含まれません）。

### 実行後の確認方法
1. スクリプトの出力オブジェクト（`Archive` パス、`SHA256`、`Files`、`Bytes`）を確認します。
2. 指定したバックアップディレクトリに `netarium-full-YYYYMMDD-HHMMSS-*.zip` が生成されていることを確認します。
3. IIS の Site および Application Pool が**開始前の状態に戻っていること**を確認します（バックアップ開始時点で停止していた場合は停止状態が維持されます）。

### 特に重要な注意点
- 整合性確保のため、実行中に **Site および Application Pool の一時停止が発生します**（停止時間は通常数秒〜十数秒程度）。利用者の少ない時間帯に実施してください。
- 生成された ZIP にはユーザーのパスワードハッシュや機器の保守情報が含まれるため、**機密情報としてアクセス制限を行い、速やかにサーバー外の安全な保管場所へ転送してください**。
- IIS 設定、SSL/TLS サーバー証明書、`config/app.php`、監査ログはバックアップ対象外です。組織の構成管理台帳で別途管理してください。

### 詳細ドキュメント
- [運用ガイド（完全バックアップの仕様と取得手順）](operations.md#停止型完全バックアップの仕様と取得手順)

---

## 4. リストア（データの復元）

### 目的
サーバー完全バックアップ ZIP から、データベース、画像実体、ユーザー情報を既存環境（または新規構築した空環境）へ一括復元します。

### 実行コマンド例
管理者 PowerShell で設置先ディレクトリへ移動し、完全復元スクリプトを実行します（またはスクリプトを絶対パスで指定します）。復元対象のアーカイブパスと作業用ディレクトリ（`-WorkRoot`）を指定します。

```powershell
Set-Location C:\Netarium\app
powershell -ExecutionPolicy Bypass -File .\scripts\restore-full.ps1 `
  -InstallRoot C:\Netarium\app `
  -SiteName Netarium `
  -ApplicationPoolName Netarium `
  -Archive D:\Backups\Netarium\netarium-full-20261015-120000.zip `
  -WorkRoot D:\Temp\NetariumRestore
```

### 実行後の確認方法
1. スクリプトの出力で `Restored: True` が返ることを確認します。
2. 診断スクリプトおよびセキュリティ検証を実行します。
   ```powershell
   php C:\Netarium\app\scripts\check-install.php --app-root C:\Netarium\app --storage-dir C:\Netarium\app\data
   powershell -ExecutionPolicy Bypass -File .\scripts\verify-security.ps1 -VerificationUrl https://netarium.example.local/
   ```
3. ブラウザでアクセスし、管理アカウントでログインして登録データや図面が意図通り復元されていることを確認します。

### 特に重要な注意点
- **完全リストアは既存のデータベースおよび画像データを置換します。** 復元対象のアーカイブが正しい世代であることを事前に確認してください。
- 実行中に **Site および Application Pool の一時停止が発生します**。
- 復元後は不正な旧セッション再利用を防ぐためセッションファイルが初期化され、**全ユーザーの既存セッションが失効します**。復元完了後に再ログインを案内してください。
- 復元途中でエラーが発生した場合は自動的にロールバック（退避した旧データへの復元）が行われます。

### 詳細ドキュメント
- [運用ガイド（完全復元の仕様と全損復旧手順）](operations.md#停止型完全復元の仕様と全損復旧手順)
- [手動配備・全損復旧ガイド](deployment-manual.md)：サーバー全損時に空のホストから再構築する手順

---

## 5. アンインストール（環境の撤去）

### 目的
Netarium の IIS Site、Application Pool、およびプログラムファイルを安全に撤去・停止します。

### 実行コマンド例
管理者 PowerShell でアンインストールスクリプトを実行します。**予期しない削除を防ぐため、最初に必ず `-WhatIf` を付けて削除予定内容を確認します。**

```powershell
# 1. 影響確認（変更は行われません）
Set-Location C:\staging\netarium
powershell -ExecutionPolicy Bypass -File .\scripts\uninstall-iis.ps1 `
  -InstallRoot C:\Netarium\app `
  -SiteName Netarium `
  -ApplicationPoolName Netarium `
  -PhpCgiPath C:\php\php-cgi.exe `
  -WhatIf
```

`-WhatIf` の結果を確認後、`-WhatIf` を外して本実行します。

```powershell
# 2. 通常アンインストール本実行（データ・設定は保持）
powershell -ExecutionPolicy Bypass -File .\scripts\uninstall-iis.ps1 `
  -InstallRoot C:\Netarium\app `
  -SiteName Netarium `
  -ApplicationPoolName Netarium `
  -PhpCgiPath C:\php\php-cgi.exe
```

※ 運用終了に伴いデータ、設定ファイル、ロールバックスナップショットも含めて完全に廃棄する場合は、明示的な廃棄承認の上で `-RemoveData` を追加します（対話確認で `REMOVE` と入力、または非対話時は `-Force -NonInteractive` を併用）。

```powershell
# 3. データ完全廃棄を含むアンインストール（明示的な廃棄承認がある場合のみ）
powershell -ExecutionPolicy Bypass -File .\scripts\uninstall-iis.ps1 `
  -InstallRoot C:\Netarium\app `
  -SiteName Netarium `
  -ApplicationPoolName Netarium `
  -PhpCgiPath C:\php\php-cgi.exe `
  -RemoveData -Force -NonInteractive
```

### 実行後の確認方法
1. IIS マネージャーまたは PowerShell で、対象 Site および Application Pool が削除されていることを確認します。
   ```powershell
   Import-Module WebAdministration
   Get-Website -Name Netarium
   Test-Path "IIS:\AppPools\Netarium"
   ```
2. ファイルシステムの確認：
   - 通常アンインストールの場合：プログラムファイル（`public/`, `src/` 等）が削除され、`data/`、`config/app.php`、ロールバックスナップショットが保持されていることを確認します。
   - `-RemoveData` を指定した場合：`InstallRoot` 配下のデータおよびスナップショットが削除されていることを確認します。

### 特に重要な注意点
- **最初に必ず `-WhatIf` を実行し、削除対象と保持対象を確認してください。**
- **通常のアンインストールではデータベースや画像実体などのデータ、設定ファイル、スナップショットは保持されます。** 再インストール時に既存データを引き継ぐことが可能です。
- **`-RemoveData` はすべてのデータが不可逆的に削除されるため、明示的な廃棄承認がある場合に限って使用してください。**
- 共有 FastCGI 設定や他サイトで利用中の Application Pool は自動削除されません。

### 詳細ドキュメント
- [運用ガイド（アンインストール）](operations.md#アンインストール)
