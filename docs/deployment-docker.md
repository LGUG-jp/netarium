# Docker / Linux Compose 配備・運用ガイド

Netarium は、Windows Server + IIS 版に加え、Docker / Docker Compose による Linux コンテナ配備を公式にサポートします。
PHP アプリケーション本体、SQLite DB スキーマ（スキーマ 16）、認証仕様、および停止型完全バックアップ（`netarium-full` 形式 1）のデータ形式は IIS 版と共通です。

---

## 1. 構成概要と前提条件

### 実行アーキテクチャ
- **Webサーバー / ランタイム**: 公式 `php:8.5-apache` ベースの単一コンテナ（Apache + mod_php）。
  - PHP: 8.5 系（配布イメージのビルド時に `php:8.5-apache` から取得）
  - SQLite: 3.54.1（列メタデータAPI有効化、ハッシュ検証ビルド）
  - 必須拡張: `pdo_sqlite`, `sqlite3`, `fileinfo`, `zip`, `gd`, `exif`, `mbstring`, `intl`
- **権限分離**: Webサーバーおよびワーカープロセスは非rootの `www-data`（UID/GID 33）で動作します。コンテナ内のアプリケーションコード領域（`/var/www/html`）は読取専用です。
- **公開面**: DocumentRootは `/var/www/html/public` のみ。ドットファイル、SQLite DB、ログ、バックアップZIP、設定ファイルへのHTTP直接アクセスはApacheレイヤーで拒否されます。
- **永続化**: 名前付きVolume `netarium_data` を `/var/lib/netarium` にマウントし、SQLite DB、図面・写真アップロード、セッション、キャッシュ、監査ログを保持します。
- **ヘルスチェック**: `public/healthcheck.php` を使用し、Docker標準の `HEALTHCHECK` 機構でコンテナの稼働状態を監視します。

### 前提条件
- Linuxコンテナを実行可能な Docker Engine 24.0+ および Docker Compose v2（WSL2 / Linuxネイティブ / VM環境）。
- AWS 環境で運用する場合の参考構成と留意点は [AWS の ALB + EC2 構成で Docker 版を運用する場合の留意点](deployment-aws-alb.md) を参照。
- ホスト側の公開ポート: デフォルトは `127.0.0.1:8080`（直接のインターネット公開は禁止。リバースプロキシ配下での運用を基本とします）。
- 管理用 checkout とバックアップ出力先には、所有者限定の POSIX 権限を実効的に適用できる Linux ファイルシステムを使用します。WSL2 では原則として `/home/...` 配下へ配置してください。`/mnt/c/...` 等の DrvFS で権限が固定される構成はバックアップ出力先に使用できません。空ファイルによる権限検査に失敗した場合は、ZIP 作成前に拒否します。

---

## 2. 配備手順

Netarium Docker版には、ソースからビルドする方式（A）と、GitHub Container Registry（GHCR）の事前ビルド済みイメージを利用する方式（B）の2通りがあります。

### 方式A: ソースビルド（開発・通常リポジトリ配備）

リポジトリルートで `compose.yaml` を使用します。
公式配布イメージに合わせ、ビルド・実行プラットフォームを `linux/amd64` に固定しています。
ARM64 ホストでは amd64 エミュレーションを利用できる Docker 環境が必要です。これは ARM64 ネイティブ対応ではなく、エミュレーションによる性能低下が生じる場合があります。

~~~sh
# 1. イメージのビルドと設定検証
docker compose build
docker compose config --quiet

# 2. 初期DBの検証・作成
docker compose run --rm --no-deps web php scripts/check-install.php \
  --app-root=/var/www/html --storage-dir=/var/lib/netarium
~~~

### 方式B: GHCR事前ビルド済みイメージ（推奨本番配備）

ビルド環境を必要とせず、固定バージョンタグの公式イメージを利用します。`compose.image.yaml` を使用します。
公式イメージは GitHub Container Registry（GHCR）より `linux/amd64` 向けに配布されます。固定タグは `ghcr.io/lgug-jp/netarium:1.3.0` です。候補版の検証や独自ビルドには方式 A のローカルビルドを利用します。

公式イメージが GitHub Packages 上で Public として公開された後は、認証なし（匿名 pull）で取得できます。GitHub Releases と GitHub Packages で公開状況を確認し、利用環境からイメージを取得できることを確認してください。

~~~sh
# 1. 設定検証とイメージ取得
docker compose -f compose.image.yaml pull web
docker compose -f compose.image.yaml config --quiet

# 2. 初期DBの検証・作成
docker compose -f compose.image.yaml run --rm --no-deps web php scripts/check-install.php \
  --app-root=/var/www/html --storage-dir=/var/lib/netarium
~~~

> **注記**: 方式B（`compose.image.yaml`）を採用した場合、以降の手順で実行する `docker compose` コマンドおよび管理スクリプト（`docker-update.sh`, `docker-backup.sh`, `docker-restore.sh`）には `-f compose.image.yaml` を付与してください。

---

## 3. 初期管理者の登録（新規導入時のみ）

**初期管理者が存在しない新規DBに限り**、一時管理者コンテナ（root）で初期登録用シークレットを発行します。

~~~sh
mkdir -m 0700 .docker-bootstrap
docker compose run --rm --no-deps --user 0:0 \
  --volume "$(pwd)/.docker-bootstrap:/run/netarium-bootstrap" web \
  php scripts/issue-bootstrap-secret.php \
  --secret-file=/run/netarium-bootstrap/bootstrap-secret
# 方式Bの場合: docker compose -f compose.image.yaml run --rm --no-deps --user 0:0 ...
~~~

- 発行されたシークレットファイルはホスト側の `.docker-bootstrap/bootstrap-secret` にモード0600で保存されます。
- `cat .docker-bootstrap/bootstrap-secret`（必要に応じて `sudo cat`）で秘密値を確認します。**端末ログやチャット、Issueへ秘密値をコピーしないでください。**
- Webコンテナを起動します。

~~~sh
docker compose up -d web
# 方式Bの場合: docker compose -f compose.image.yaml up -d web
~~~

- ブラウザで `http://127.0.0.1:8080/setup.php` にアクセスし、確認したシークレットを入力して最初の管理者アカウントを登録します。
- 登録完了後、シークレットファイルを直ちに削除します。

~~~sh
rm -f .docker-bootstrap/bootstrap-secret
rmdir .docker-bootstrap
~~~

`setup.php` は登録完了後、DB内のシークレットダイジェストを削除して恒久的に再登録を拒否します。

---

## 4. 管理者の緊急復旧

全管理者のパスワードを喪失した場合など、ログイン不能になった際は、ワンショットコンテナで `scripts/recover-admin.php` を実行します。

~~~sh
docker compose run --rm web php scripts/recover-admin.php --username=admin
# 方式Bの場合: docker compose -f compose.image.yaml run --rm web php scripts/recover-admin.php --username=admin
~~~

対話形式で新しいパスワードを設定できます。この操作は監査ログに記録され、`OperationGate` により排他制御されます。

---

## 5. HTTPS / リバースプロキシ構成

組織のTLS終端リバースプロキシ（Nginx, Apache, Envoy, ALB等）の背後に配置する構成を基本とします。

```text
クライアント (HTTPS:443)
       ↓ TLS終端
Reverse Proxy (X-Forwarded-Proto: https)
       ↓ HTTP
Netarium Docker Container (127.0.0.1:8080)
```

### 設定方法
1. **リバースプロキシの設定**:
   - `Host` ヘッダーおよび `X-Forwarded-Proto: https` をコンテナの `127.0.0.1:8080` へ転送します。
2. **Netarium側の信頼設定**:
   - リバースプロキシのIPアドレスを `config/app.php` に登録します。
   - 例: `./config/app.php` を作成（ホスト側からマウント）:

~~~php
<?php
return [
    'trusted_https_proxies' => ['127.0.0.1', '172.18.0.1'],
    'hsts_max_age' => 31536000,
];
~~~

- `compose.yaml` の `volumes` に設定を追加:
~~~yaml
    volumes:
      - netarium_data:/var/lib/netarium
      - ./config/app.php:/var/www/html/config/app.php:ro
~~~

### セキュリティ境界
- Netariumの `TransportSecurity` は、`trusted_https_proxies` に登録されたIPからの接続でのみ `X-Forwarded-Proto: https` を信頼します。未登録のクライアントからのヘッダースプーフィングは拒否されます。
- HTTPS認識時、セッションCookie属性は自動的に `__Host-netarium_session`（`Secure; HttpOnly; SameSite=Strict`、`Path=/`、`Domain` 指定なしの `__Host-` プレフィックス要件を満たす属性）に昇格し、設定された場合は `Strict-Transport-Security` ヘッダーが送出されます。

---

## 6. ヘルスチェックと監視

### Docker標準ヘルスチェック
コンテナには標準でヘルスチェックが組み込まれています。

- **エンドポイント**: `GET /healthcheck.php`
- **検証内容**:
  - Apache / mod_php ランタイムの応答性
  - ストレージディレクトリの存在・書込可能性、および SQLite DB の読み取り専用疎通・スキーマ整合性（DBファイルが存在する場合）
  - セッションやCookieは一切生成せず、ディスクやinodeの不要な消費を防止
  - 秘密情報、内部ファイルパス、バージョン番号の非露出
- **応答**: 正常時 `200 OK` (`{"status":"ok"}`), 異常時 `503 Service Unavailable` (`{"status":"unavailable"}`)

コンテナの状態は以下で確認できます:
~~~sh
docker compose ps
# STATUS 列に "(healthy)" と表示されます
~~~

---

## 7. 更新・ロールバック手順

アプリケーション更新および失敗時のロールバックは、専用CLI `scripts/docker-update.sh` で安全に自動実行できます。
IIS環境の更新スクリプト（`scripts/update.ps1`）がIIS SiteやApplication Poolを制御するのに対し、Docker環境では `scripts/docker-update.sh` がDocker Compose、コンテナ、および名前付きVolumeを制御します。更新前の完全バックアップ採取、DBマイグレーション検査、および失敗時の旧環境・旧データへの自動ロールバックという基本方針は両環境で共通です。

### 自動更新の実行

~~~sh
# 方式A: ソースビルド環境での更新（最新コードを取得後に実行）
bash scripts/docker-update.sh

# 方式B: 事前ビルド済みイメージ（compose.image.yaml）環境での更新
# ※ 次の版へ更新する際は、まず compose.image.yaml の image 参照を
<a id="---新しい正式固定版タグへ切り替えてから実行します"></a>

# 新しい正式固定版タグへ切り替えてから実行します。
bash scripts/docker-update.sh -f compose.image.yaml
~~~

#### 事前ビルド済みイメージ（GHCR固定タグ）利用時の更新手順
GHCR固定タグ（例: `ghcr.io/lgug-jp/netarium:1.3.0`）で運用している環境を新しい版へ更新する際は、以下の流れで実施します。
1. **イメージ参照の切り替え**: 稼働中の `compose.image.yaml` 内の `image:` を、新しい正式固定版タグ（例: `ghcr.io/lgug-jp/netarium:<新バージョン>`）へ書き換えます。架空のタグや digest（`@sha256:...`）ではなく、公式リリースで提供される固定タグを指定してください。
2. **更新スクリプトの実行**: `bash scripts/docker-update.sh -f compose.image.yaml` を実行します。
3. **事前バックアップと自動保護**: スクリプトが稼働中の現行バージョン（更新前）コンテナで自動的に事前バックアップ（`backups/pre-update-YYYYMMDD-HHMMSS-<token>.zip`）を生成し、新イメージの取得（pull）・DBマイグレーション検査・新コンテナ起動・ヘルスチェックを順次実施します。
4. **失敗時の復旧**: 途中で検査や起動が失敗した場合は、自動的に更新前の旧イメージタグを復元した上で事前バックアップからデータを復元し、安全に元のバージョンで再開（自動ロールバック）します。自動切戻しにも失敗した場合は停止を維持（終了コード 2）し、事前バックアップZIPと保全タグ（`netarium-rollback:<ランダム値>`）から手動復旧が可能です。

### 更新の動作フロー
1. **Web停止・自動事前バックアップ**: Webコンテナを停止し、更新前のイメージで `backups/pre-update-YYYYMMDD-HHMMSS-<token>.zip` を生成（メンテナンス完了まで停止状態を維持）。
2. **イメージ更新**: 更新前のイメージIDを記録した上で `docker compose build` または `pull` を実行。
3. **DBマイグレーション**: 一時コンテナで `scripts/check-install.php` を実行し、スキーマ整合性を検査。
4. **Web再開**: 更新されたイメージでWebコンテナを起動。
5. **ヘルスチェック検証**: コンテナ内の `healthcheck.php` が正常応答（`{"status":"ok"}`）を返すことを確認。
6. **自動ロールバック**: マイグレーション・起動・ヘルスチェックのいずれかが失敗した場合、直ちに更新前の旧イメージタグを復元した上で事前バックアップからデータを戻し、安全に旧バージョンで再開します。

旧イメージを固定できない参照（`image: repository@sha256:...` 等）では、更新スクリプトは Web 停止前に中断します。
`docker-update.sh` を利用する配備では固定バージョンタグを指定してください。
切戻し中に旧イメージへの復帰を確認できない場合は、データ復元・Web 再開へ進まず停止を維持して終了コード 2 を返します。
更新中は `netarium-rollback:<ランダム値>` のローカルタグで旧イメージを保全します。
正常更新時だけ保全タグを除去し、失敗時は手動復旧に使えるよう保持します。

---

## 8. 停止型完全バックアップ・復元・全損復旧

完全バックアップ（`netarium-full` 形式 1）は、SQLite DB全体・全ユーザー・認証状態・図面・機器写真を同一世代としてZIPアーカイブに梱包します。IIS環境（`scripts/backup-full.ps1`／`scripts/restore-full.ps1`）と共通形式ですが、復元にはアプリ版・スキーマ・保存データ契約の検証が必要です。復元先 `1.3.0`（現行スキーマ 16）では、同一 MAJOR 内の順方向（source <= target）の正規 SemVer、および移行経路が存在するスキーマ 11〜16（11..16）のバックアップを受け付けます。

### 完全バックアップの採取

~~~sh
bash scripts/docker-backup.sh [-f compose.yaml|compose.image.yaml] [出力先ZIPパス]
~~~

- Webコンテナへの書き込みを停止（`docker compose stop web`）。
- 一時管理コンテナ（root）で `OperationGate` 排他ロックを取得し、`VACUUM INTO` によるコミット済みWALを含むDBスナップショットと画像ディレクトリを整合コピー。
- ZIP梱包後にWebコンテナを自動再開。
- ZIP は一時ファイルの生成開始時から所有者だけが読み書きできる権限で作成します。既存の共有出力ディレクトリ全体の権限は変更しません。

### 完全バックアップからの復元

~~~sh
bash scripts/docker-restore.sh [-f compose.yaml|compose.image.yaml] <バックアップZIPパス>
~~~

- **事前検証**: Web稼働中にZIPの整合性・manifest・ハッシュ・展開上限を検査。破損がある場合はWebを停止しません。
- **アトミック入替**: Webを停止し、永続Volume内で既存データを `old` に退避、新データをアトミックにリネーム配置。
- **セッション失効**: 旧セッションファイルを破棄。
- **安全停止（fail-closed）**: 復元失敗時は旧データへロールバック。万一ロールバックも失敗した場合はWeb停止を維持（終了コード 2）。

### 空ホスト・空Volumeからの全損復旧（Disaster Recovery）

ハードウェア故障やクラウド障害、誤操作等によりホストまたは永続Volume（`netarium_data`）が全損した場合、新しい空のDockerホストまたは空のVolumeから以下の全損復旧手順を実施します。

1. 新しいDockerホストを用意し、Netariumリポジトリまたはリリース資材を取得（または空の `netarium_data` Volume を用意）。
2. 保存済みの完全バックアップZIPを配置。
3. 初期化されていない空の状態で復元コマンドを実行:
   ~~~sh
   bash scripts/docker-restore.sh /path/to/backup.zip
   # 方式Bの場合: bash scripts/docker-restore.sh -f compose.image.yaml /path/to/backup.zip
   ~~~
   ※ スクリプトはVolume内の空状態を検知し、既存退避を行わずに安全にアーカイブを展開・配置します。
4. Webコンテナを起動（`docker-restore.sh` 完了時に自動起動されますが、明示的に確認・起動する場合）:
   ~~~sh
   docker compose up -d web
   # 方式Bの場合: docker compose -f compose.image.yaml up -d web
   ~~~
5. 健全性を確認:
   ~~~sh
   docker compose ps
   curl -fsS http://127.0.0.1:8080/healthcheck.php
   ~~~
   既存の管理者アカウントで通常通りログインできます（初期登録 `setup.php` を再実行する必要はありません）。

---

## 9. IIS版との互換性と未検証事項

### 形式互換性
- Docker版とIIS版の完全バックアップ形式（`netarium-full` 形式 1）は、同一のPHPバックアップエンジン（`scripts/full-backup-helper.php`）を基盤とし、manifest構造・SHA-256検証・DBスキーマ（スキーマ 11〜16）を共有します。形式が同じでも未許可のアプリ版や未対応スキーマは拒否します。互換性の範囲は [更新ガイド](update.md#バックアップ互換性と切戻し手順) を参照してください。

### 実機 ZIP の確認範囲

IIS v1.0.3 で取得した完全 ZIP を、隔離した Docker v1.1.0 の空 Volume へ復元し、DB と図面、利用者・パスワードハッシュの保持を確認しました。
別の復元コピーに追加した一時管理者で、HTTP ログイン・管理者 API・図面の認証付き配信も確認しています。
元の利用者の資格情報や稼働環境は変更していません。

### 未検証事項（人による実機確認が必要な項目）
- **元管理者の認証と実機写真**: 元管理者の実パスワードによるログインは未検証です。実機 ZIP に機器写真が含まれていないため、実機写真の復元・配信も今回の受入範囲には含みません。
- **ブラウザの確認範囲**: 隔離 Docker 上で Chrome によるログイン、機器保存、図面・機器画像の表示、更新後の保存内容保持を確認しました。実利用環境の画面・操作感、長時間運用、他ブラウザの確認を代替するものではありません。
