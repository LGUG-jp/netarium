/**
 * netarium 公開用スナップショット生成スクリプト
 * 
 * 機能:
 * 1. 指定Git SHAから git archive (execFileSync) によりクリーンなGitオブジェクトを直接抽出（未コミット変更・未追跡ファイルを完全排除）
 * 2. シェルを介さない引数配列実行方式およびコミットRef入力バリデーションによるコマンド注入防止
 * 3. 厳格な出力先安全ガード（リポジトリ内部、ドライブ直下、無関係な既存ディレクトリの誤削除防止）
 * 4. 明示的 allowlist と denylist により内部文書（ADR, release-candidate, repository-rules等）を厳格に除外
 * 5. 公開用Markdownの開発履歴を除外し、内部参照を公開手順へ変換（Private原本は変更しない）
 * 6. 公開Markdownの内部参照残存・相対リンクと実在アンカーを検査（fail-closed）
 * 7. 秘密情報・危険ファイル検査（tests/含む全数走査、fail-closed、機密値非出力）
 * 8. 公開PowerShellスクリプト文字コード検査（配備用scripts/*.ps1のASCII厳格検査、fail-closed）
 * 9. ステージング領域での生成・全検査PASS後のみ最終出力先へアトミック反映（不完全成果物の残置・旧成果物の破壊を防止）
 * 10. Private側管理用SHA-256マニフェスト台帳の出力（Public内へは混入させない）
 * ※ 独自配布ZIPは生成せず、GitHub標準ソース配布と一致させる。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

// コマンドライン引数解析
const args = process.argv.slice(2);
function getArg(name, defaultValue) {
    const idx = args.indexOf(name);
    if (idx !== -1 && args[idx + 1]) {
        return args[idx + 1];
    }
    return defaultValue;
}

const targetCommit = getArg('--commit', 'HEAD');
const outDir = path.resolve(getArg('--out-dir', path.join(REPO_ROOT, '../tmp/netarium-public-candidate')));
const manifestDir = path.resolve(getArg('--manifest-dir', path.join(REPO_ROOT, 'docs/release-candidate')));
if (manifestDir === outDir || manifestDir.startsWith(outDir + path.sep)) {
    throw new Error('Privateマニフェストを公開出力先に保存することはできません');
}

console.log('=== netarium 公開スナップショット生成 ===');
console.log(`Repository Root:   ${REPO_ROOT}`);
console.log(`Target Commit/Ref: ${targetCommit}`);
console.log(`Target Output Dir: ${outDir}`);

// -------------------------------------------------------------
// 1. 安全ガード: 出力先ディレクトリの厳格なバリデーション
// -------------------------------------------------------------
function assertSafeOutputDir(targetDir) {
    const normalizedTarget = path.normalize(targetDir);
    const parsed = path.parse(normalizedTarget);

    // ドライブ直下（C:\ 等）は拒否
    if (normalizedTarget.toLowerCase() === parsed.root.toLowerCase()) {
        throw new Error(`安全ガード違反: ドライブ直下を出力先に指定することはできません: ${targetDir}`);
    }

    // パス解決（シンボリックリンクやジャンクションを解決した実体パスを取得）
    let realTarget = normalizedTarget;
    if (fs.existsSync(normalizedTarget)) {
        try { realTarget = fs.realpathSync(normalizedTarget); } catch (_) {}
    }
    let realRepo = REPO_ROOT;
    try { realRepo = fs.realpathSync(REPO_ROOT); } catch (_) {}

    const realTargetLower = realTarget.toLowerCase();
    const realRepoLower = realRepo.toLowerCase();

    // リポジトリルート自体の指定を拒否
    if (realTargetLower === realRepoLower) {
        throw new Error(`安全ガード違反: リポジトリルートを出力先に指定することはできません: ${targetDir}`);
    }

    // リポジトリの上位（親）ディレクトリを拒否
    if (realRepoLower.startsWith(realTargetLower) && realTargetLower !== realRepoLower) {
        throw new Error(`安全ガード違反: リポジトリの上位ディレクトリを出力先に指定することはできません: ${targetDir}`);
    }

    // リポジトリ内部のすべての保護ディレクトリ（src, docs, .git, data 等）を拒否
    const dangerousSubdirs = [
        'data', '.git', '.github', 'src', 'public', 'templates',
        'scripts', 'config', 'resources', 'tests', 'docs'
    ];
    for (const sub of dangerousSubdirs) {
        const dangerousPath = path.join(realRepoLower, sub);
        if (realTargetLower === dangerousPath || realTargetLower.startsWith(dangerousPath + path.sep)) {
            throw new Error(`安全ガード違反: リポジトリ内保護領域 (${sub}) を出力先に指定することはできません: ${targetDir}`);
        }
    }

    // 出力先が既に存在する場合、空ディレクトリのみ許可（既存成果物の自動削除・上書きを禁止）
    if (fs.existsSync(normalizedTarget)) {
        const stat = fs.statSync(normalizedTarget);
        if (!stat.isDirectory()) {
            throw new Error(`安全ガード違反: 出力先がディレクトリではありません: ${targetDir}`);
        }
        const entries = fs.readdirSync(normalizedTarget);
        if (entries.length > 0) {
            throw new Error(
                `安全ガード違反: 出力先ディレクトリ (${targetDir}) は既に存在し、空ではありません。既存成果物の誤削除や上書きを防ぐため、新規のパスまたは空のディレクトリを指定してください。`
            );
        }
    }
}

try {
    assertSafeOutputDir(outDir);
} catch (err) {
    console.error(`[ERROR] ${err.message}`);
    process.exit(1);
}

// -------------------------------------------------------------
// 2. コミットRefのサニタイズおよびGit SHAの取得（シェル不使用）
// -------------------------------------------------------------
// コマンド注入防止: 有効なGit Ref文字列（英数字、ハイフン、アンダースコア、スラッシュ、ピリオド、チルダ、キャレット）のみ許可
if (!/^[a-zA-Z0-9_\-./~^]+$/.test(targetCommit)) {
    console.error(`[ERROR] 不正なコミット指定です（許可されていない文字が含まれています）: ${targetCommit}`);
    process.exit(1);
}

let sourceSha = '';
try {
    // シェルを介さない引数配列方式で実行
    sourceSha = execFileSync('git', ['rev-parse', '--verify', `${targetCommit}^{commit}`], {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
} catch (err) {
    console.error(`[ERROR] 指定されたコミット/Ref (${targetCommit}) を解決できませんでした: ${err.message}`);
    process.exit(1);
}
console.log(`Source Commit SHA: ${sourceSha}`);

// 公開候補の履歴に属する識別子はPrivate情報。外部upstreamのSHAはこの集合に含めない。
let privateAncestry;
try {
    const options = { cwd: REPO_ROOT, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 };
    if (execFileSync('git', ['rev-parse', '--is-shallow-repository'], options).trim() !== 'false') {
        throw new Error('履歴が不完全です');
    }
    const hashes = execFileSync('git', ['rev-list', sourceSha], options).trim().split(/\r?\n/);
    if (!hashes.length || hashes.some(hash => !/^[a-f0-9]{40}$/.test(hash))) throw new Error('履歴が不正です');
    privateAncestry = new Set(hashes);
    if (!privateAncestry.has(sourceSha)) throw new Error('元commitが履歴にありません');
} catch {
    console.error('[ERROR] Private祖先commitの完全な一覧を取得できませんでした');
    process.exit(1);
}

// -------------------------------------------------------------
// 3. git archive を用いたGitオブジェクトからの安全な抽出 (シェル不使用)
// -------------------------------------------------------------
// 一時作業ディレクトリ（ステージング領域）
const tmpBase = os.tmpdir();
fs.mkdirSync(tmpBase, { recursive: true });
const stagingDir = path.resolve(path.join(tmpBase, 'netarium-snapshot-staging-' + crypto.randomBytes(6).toString('hex')));
const archiveTarPath = path.resolve(path.join(tmpBase, 'netarium-git-archive-' + crypto.randomBytes(6).toString('hex') + '.tar'));

function cleanupStaging() {
    if (fs.existsSync(stagingDir)) {
        try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch (_) {}
    }
    if (fs.existsSync(archiveTarPath)) {
        try { fs.unlinkSync(archiveTarPath); } catch (_) {}
    }
}

process.on('exit', cleanupStaging);
process.on('SIGINT', () => { cleanupStaging(); process.exit(1); });

console.log('\n[1/6] Gitオブジェクトの安全な抽出 (git archive / execFileSync)...');
try {
    // git archive (引数配列方式)
    execFileSync('git', ['archive', '--format=tar', `--output=${archiveTarPath}`, sourceSha], {
        cwd: REPO_ROOT,
        stdio: ['ignore', 'ignore', 'pipe']
    });

    fs.mkdirSync(stagingDir, { recursive: true });

    // GNU tar / bsdtar 共通のtar形式を抽出する（ZIP対応には依存しない）。
    execFileSync('tar', ['-xf', path.relative(stagingDir, archiveTarPath)], {
        cwd: stagingDir,
        stdio: ['ignore', 'ignore', 'pipe']
    });
} catch (err) {
    console.error(`[ERROR] git archive の抽出に失敗しました: ${err.message}`);
    cleanupStaging();
    process.exit(1);
}

// -------------------------------------------------------------
// 4. 明示的 allowlist / denylist による公開ファイル選定
// -------------------------------------------------------------
console.log('\n[2/6] 公開対象ファイルの選定 (allowlist / denylist)...');

const ALLOWED_TOP_LEVEL = new Set([
    'public',
    'src',
    'templates',
    'scripts',
    'resources',
    'tests',
    'docs',
    '.github',
    'config',
    'bootstrap.php',
    'version.php',
    'LICENSE',
    'THIRD_PARTY_NOTICES.md',
    'README.md',
    'SECURITY.md',
    'CONTRIBUTING.md',
    'CHANGELOG.md',
    '.gitattributes',
    '.gitignore'
]);

const EXCLUDED_PATHS = new Set([
    'AGENTS.md',
    'config/app.php',
    'scripts/release-sync.mjs',
    'tests/release-sync.test.mjs',
    'scripts/release-control.mjs',
    'tests/release-control.test.mjs',
    '.github/workflows/release-check.yml',
    '.github/workflows/release-candidate.yml',
    '.github/workflows/release-publish.yml',
    'docs/repository-rules.md',
    'docs/release.md',
    'docs/deployment-testing.md',
    'docs/password-blocklist-research.md',
    'resources/password-blocklist/ncsc-100k.txt',
    'resources/password-blocklist/metadata.json',
]);

const EXCLUDED_PREFIXES = [
    'docs/decisions/',
    'docs/design/',
    'docs/release-candidate/',
    'data/',
    'storage/',
    '.git/',
    'tmp/',
    'node_modules/',
    'vendor/',
];

function isPathPublicAllowed(relPath) {
    const norm = relPath.replace(/\\/g, '/');
    const top = norm.split('/')[0];
    if (!ALLOWED_TOP_LEVEL.has(top)) {
        return false;
    }
    if (EXCLUDED_PATHS.has(norm)) {
        return false;
    }
    for (const prefix of EXCLUDED_PREFIXES) {
        if (norm.startsWith(prefix) || norm === prefix.slice(0, -1)) {
            return false;
        }
    }
    // 配布用の辞書資材はPWDBの固定2ファイルだけ。任意辞書の混入も拒否する。
    if (norm.startsWith('resources/password-blocklist/')
        && !['resources/password-blocklist/pwdb-policy-top-3000.txt',
            'resources/password-blocklist/pwdb-metadata.json'].includes(norm)) {
        return false;
    }
    if (/(?:^|\/)(?:password-blocklist\.json|password-blocklist\/(?:active\.json|dictionary-[a-f0-9]{64}\.txt)|ncsc-100k\.txt)$/i.test(norm)) {
        return false;
    }
    // 禁止拡張子（DB、ログ、一時ファイル）
    const ext = path.extname(norm).toLowerCase();
    if (['.sqlite', '.sqlite3', '.db', '.log', '.tmp', '.bak'].includes(ext)) {
        return false;
    }
    return true;
}

// ステージング内の全ファイルを再帰走査
function collectFiles(dir, base = '') {
    const results = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
        const rel = base ? `${base}/${ent.name}` : ent.name;
        const full = path.join(dir, ent.name);
        if (ent.isSymbolicLink()) {
            throw new Error(`シンボリックリンクが検出されました: ${rel}`);
        } else if (ent.isDirectory()) {
            results.push(...collectFiles(full, rel));
        } else if (ent.isFile()) {
            results.push(rel);
        }
    }
    return results;
}

let allStagingFiles = [];
try {
    allStagingFiles = collectFiles(stagingDir);
} catch (err) {
    console.error(`[ERROR] ファイル走査失敗: ${err.message}`);
    cleanupStaging();
    process.exit(1);
}

const publicFiles = [];
const excludedFiles = [];

for (const rel of allStagingFiles) {
    if (isPathPublicAllowed(rel)) {
        publicFiles.push(rel);
    } else {
        excludedFiles.push(rel);
    }
}

// 許可外のファイルをステージングから削除
for (const rel of excludedFiles) {
    const target = path.join(stagingDir, rel);
    if (fs.existsSync(target)) {
        fs.unlinkSync(target);
    }
}

// 空ディレクトリのクリーンアップ
function cleanEmptyDirs(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
        if (ent.isDirectory()) {
            const full = path.join(dir, ent.name);
            cleanEmptyDirs(full);
            if (fs.readdirSync(full).length === 0) {
                fs.rmdirSync(full);
            }
        }
    }
}
cleanEmptyDirs(stagingDir);

console.log(`抽出元全ファイル数: ${allStagingFiles.length}`);
console.log(`公開許可ファイル数: ${publicFiles.length}`);
console.log(`除外ファイル数:     ${excludedFiles.length}`);

// -------------------------------------------------------------
// 5. 公開用ドキュメント内の内部リンクの決定論的置換
// -------------------------------------------------------------
console.log('\n[3/6] ドキュメント内部リンクの公開向け変換...');

// 公開するのは現在の契約と再利用できる手順。Privateの実施証跡は転記しない。
function headingSlug(text) {
    return text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/<[^>]*>/g, '').replace(/[`*~]/g, '').toLowerCase()
        .replace(/[^\p{L}\p{M}\p{N}_\-\s]/gu, '').replace(/\s/g, '-');
}

function publicLink(relPath, target, fragment = '') {
    const relative = path.posix.relative(path.posix.dirname(relPath), target);
    return `${relative}${fragment ? '#' + fragment : ''}`;
}

function removeDocSections(content, shouldRemove) {
    const lines = content.split('\n');
    let removedLevel = 0;
    let fence = '';
    return lines.filter(line => {
        const marker = line.match(/^\s*(`{3,}|~{3,})/);
        if (marker) {
            if (!fence) fence = marker[1][0];
            else if (marker[1][0] === fence) fence = '';
            return !removedLevel;
        }
        if (fence) return !removedLevel;
        const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
        if (heading) {
            const level = heading[1].length;
            if (removedLevel && level <= removedLevel) removedLevel = 0;
            if (!removedLevel && shouldRemove(heading[2], level)) removedLevel = level;
        }
        return !removedLevel;
    }).join('\n');
}

// URL・コード・明示アンカーは本文置換から分離する。色コードもIssue番号と区別する。
const privateNumber = /(?<![\w&])(?:(?:Issue|PR|Pull Request)\s*)?#\d+(?![\da-fA-F])\b/g;
const commitToken = /\b(?=[0-9a-f]{7,40}\b)(?=[0-9a-f]*[a-f])[0-9a-f]+\b/gi;
function externalCommitIds(content) {
    return new Set([...content.matchAll(/https:\/\/github\.com(?::\d+)?\/(?!LGUG-jp\/netarium(?:-dev)?(?:\/|$))[^/\s)]+\/[^/\s)]+\/commit\/([0-9a-f]{40})\b/gi)]
        .map(match => match[1].toLowerCase()));
}
const removedDocAnchors = new Map();
function publicProse(text) {
    return text
        .replace(/[（(]\s*(?:(?:Issue|PR)\s*)?#\d+(?:[、,・／/]\s*(?:(?:Issue|PR)\s*)?#\d+)*(?:\s+Phase\s+[A-Z0-9 ]+)?\s*[）)]/g, '')
        .replace(/#84(?:より前|以前)/g, '旧構成移行前')
        .replace(privateNumber, '関連変更')
        .replace(/\bADR\s*\d{4}(?:（[^）]*）)?/g, '設計方針')
        .replace(/\bADR\b/g, '設計方針')
        .replace(/専用受入(?:記録)?/g, '実環境での確認')
        .replace(/Private(?:側)?(?:の)?(?:短縮)?SHA/gi, '内部コミット識別子');
}

// 番号を消すだけでは参照不能な引継ぎ文が残るため、公開文書ごとに現在の説明へ整える。
function summarizePublicDoc(content, relPath) {
    let c = content;
    if (relPath === 'CHANGELOG.md') {
        c = removeDocSections(c, title => title === '旧仕様の追跡と未受入');
        c = c.replace(/(## 0\.3\.0\n)\n[^\n]+/, '$1\n以下は 0.3.0 当時の変更と仕様の履歴です。\n1.0.0 の現行仕様・互換性・更新時の注意は、この文書の「1.0.0」と各運用ガイドを参照してください。\n過去の実装・検証記録は、現在の環境での試験合格を示しません。');
        c = c.replace(/。実ブラウザ受入は関連変更(?:へ引き継ぎ|で確認)/g, '');
        c = c.replace(/。実A3画質・IISメモリと負荷は関連変更で確認/g, '');
        c = c.replace(/。実ACL復元は既知の`SeSecurityPrivilege`不足による未確認を関連変更へ引き継ぐ/g, '');
        c = c.replace(/。設計方針の履歴を保持し、0001〜0008は採用判断によりAccepted/g, '');
        c = c.replace(/^- 現行DBはスキーマ10、/m, '- 0.3.0 当時の DB はスキーマ10、');
    }
    if (relPath === 'docs/development.md') {
        c = c.replace(/関連変更の総合監査と関連変更のリリース判断は、このworkflowの確認と分けて扱います。/, '総合セキュリティ監査とリリース判断は、この workflow の確認と分けて扱います。');
        c = c.replace(/関連変更で作成したSVGを、関連変更で用途別に整理して既存画面へ適用しています。/, '');
        c = c.replace(/今回の全件回帰では[^\n]*?合格しました。/, '');
        c = c.replace(/^(?:2026-\d{2}-\d{2}の(?:切れ目方式の測定|ブリッジ方式)|Phase Cの再測定)[^\n]*(?:\n|$)/gm, '');
    }
    if (relPath === 'docs/architecture.md') {
        c = c.replace(/関連変更のCanvas内フローティング配置を関連変更で変更し、[^\n]*?関連変更は過去の判断として保持します。/,
            '右パネルの開閉・幅変更で操作位置が移動せず、図面・機器に重ならない配置とします。');
        c = c.replace(/保存状態判定・確認処理と関連変更のズーム計算・Fit・標準表示復帰は変更しません。/,
            '保存状態判定・確認処理とズーム計算・Fit・標準表示復帰を共用します。');
        c = c.replace(/関連変更のレビュー対応では、一覧クリック側での追加の全経路計算を撤去しました。/,
            '一覧クリック側では全経路を追加計算しません。');
        c = c.replace(/決定と運用残余は\[[^\]]+\]\([^)]+\)、実FastCGIの受入は関連変更を参照してください。/,
            '明示移行と HTTP worker への設定反映は[運用ガイド](operations.md#パスワードの明示移行169)に従い、実 FastCGI の生成・照合と単発／同時負荷を配備先で確認します。');
    }
    if (relPath === 'docs/operations.md') {
        c = c.replace(/本変更の実IIS／FastCGI、実時間600秒の待機、実ブラウザ、ディスク枯渇の試験は未実施です。/, '');
        c = c.replace(/別系統のログ保管と自動警告通知は今回追加せず、週次点検を継続します。/,
            '別系統のログ保管と自動警告通知は備えていないため、週次点検を継続します。');
        c = c.replace(/受容した運用上の制約として関連変更・関連変更で追跡します。/, '運用上の制約として運用記録に残し、定期点検で見直します。');
    }
    if (relPath === 'docs/design-guidelines.md') {
        c = c.replace(/関連変更の横断監査ではこの用途差を維持した。対象画面・検証結果・人による確認事項は\[[^\]]+\]\([^)]+\)を参照する。/, '');
        c = c.replace(/関連変更のデザインシステム統一監査において、/, '');
        c = c.replace(/一覧は関連変更の2段表示を維持し、/, '一覧は2段表示を維持し、');
    }
    if (relPath === 'docs/deployment-manual.md') {
        c = c.replace(/関連変更で画像登録の全体一律上限（108ファイル・200MiB）を撤去し、/, '画像登録の全体一律上限は設けず、');
        c = c.replace(/IIS通常要求上限を32MiBへ縮小しました。/, 'IIS通常要求上限を32MiBとします。');
    }
    if (relPath === 'tests/README.md') {
        c = c.replace(/関連変更の世代競合は、/, '認証世代の競合試験では、');
        c = c.replace(/に従って関連変更で確認します。/, 'に従って隔離 IIS で確認します。');
        c = c.replace(/関連変更のWeb復元では、/, 'Web 復元の試験では、');
    }
    return c;
}

function transformDocContent(content, relPath) {
    let c = content.replace(/\r\n/g, '\n');
    if (relPath === 'docs/development.md') {
        const start = c.indexOf('\n## 必要な環境');
        if (start === -1) throw new Error('開発ガイドの公開手順開始位置が見つかりません');
        c = '# Netarium開発ガイド\n\n開発環境、変更に応じた確認、回帰テストと性能評価の実行手順です。現在の構造は[アーキテクチャ](architecture.md)を参照してください。\n' + c.slice(start);
        c = removeDocSections(c, title => title === '3. 計測記録の扱い');
        c = c.replace(/#125の制作時には[\s\S]*?(?=実ブラウザーでの確認は)/, '');
        c = c.replace(/実ブラウザーでの確認は、[\s\S]*?再確認時は、/, '実ブラウザーでは、');
        c = c.replace(/ADR 0001（Phase 0）に基づき、/, '');
        c = c.replace(/privateリポジトリのcheckoutに読取りが必要で、/, 'リポジトリのcheckoutに読取りが必要で、');
        c = c.replace(/将来の設計や互換性へ影響する判断は`docs\/decisions`へADRとして記録します。/, '将来の設計や互換性へ影響する判断はPull Requestに理由と制約を記録します。');
        c = c.split(/(`{3,}[\s\S]*?`{3,}|~{3,}[\s\S]*?~{3,})/g).map((part, index) => index % 2 ? part :
            part.split(/\n\s*\n/).filter(paragraph =>
                !/(?:成功しました|通過しました|通過しています|確認しました|描画しています|一括合格|今回実行していません)/.test(paragraph)
            ).join('\n\n')).join('');
    }
    if (relPath === 'docs/README.md') {
        c = removeDocSections(c, title => title.startsWith('文書の正本とPhase 7C棚卸し'));
        c = c.replace(/検証専用の失敗注入や削除試験は、次の試験ガイドに分離しています。/, '実環境での確認は、開発ガイドの「配備スクリプトの確認」に従います。');
        c = c.replace(/^\|[^\n]*\]\((?:deployment-testing|release|repository-rules)\.md\)[^\n]*\n/gm, '');
        c = c.replace(/^- \[設計判断記録（ADR）\][^\n]*\n/gm, '');
    }
    if (relPath === 'docs/operations.md') {
        c = c.replace(/#185の隔離PHP組込みHTTPでは、[\s\S]*?成功しました。/, '設定ファイルとHTTP workerの評価値が一致しない場合があります。');
        c = c.replace(/実IISの反映時間・複数worker・timestamp検証無効時・他アプリへの影響は未検証です。[\s\S]*?#132の総合監査とは別扱いです。/,
            '実IISの反映時間、複数worker、timestamp検証無効時、他アプリへの影響を配備先で確認し、適用方法・結果・未確認範囲を運用記録に残します。文書整備や隔離HTTPの結果をIISでの合格と扱いません。');
    }
    if (relPath === 'docs/update.md') {
        c = c.replace(/M-08の差が戻るため、配備先責任者が#132／#109で/, '追加の拒否条件が失われるため、配備先責任者が運用記録で');
    }
    if (relPath === 'docs/architecture.md') {
        c = removeDocSections(c, title => title === '関連する設計判断');
        c = c.replace(/採用理由と過去の移行計画は[\s\S]*?参照してください。/, '開発と検証の手順は[開発ガイド](development.md)を参照してください。');
    }

    // 除外文書へのリンクは、参照元の深さに応じた公開ガイドへのリンクに置換する。
    c = c.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (whole, label, url) => {
        if (/^https:\/\/github\.com(?::\d+)?\/LGUG-jp\/netarium(?:-dev)?\/(?:issues|pull|commit)\//i.test(url)) {
            return publicProse(label);
        }
        if (/^(?:https?:|mailto:|#)/i.test(url)) return whole;
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(relPath), url.split('#')[0]));
        let replacement;
        if (target.startsWith('docs/decisions/')) {
            replacement = /0004-/.test(target)
                ? ['運用ガイド（復元）', 'docs/operations.md', '復元']
                : ['アーキテクチャ', 'docs/architecture.md', /000[289]-/.test(target) ? '認証と権限' : ''];
        } else if (target === 'docs/deployment-testing.md') {
            replacement = ['開発ガイド（配備の確認）', 'docs/development.md', '配備スクリプトの確認'];
        } else if (target === 'docs/repository-rules.md') {
            replacement = ['コントリビューションガイド', 'CONTRIBUTING.md', ''];
        } else if (target === 'docs/release.md') {
            replacement = ['変更履歴', 'CHANGELOG.md', ''];
        } else if (target === 'docs/password-blocklist-research.md') {
            return '辞書メタデータ（`pwdb-metadata.json`）';
        }
        return replacement ? `[${replacement[0]}](${publicLink(relPath, replacement[1], replacement[2])})` : whole;
    });
    // 生URL・自動リンク・コード内にもPrivateのURLや元SHAを残さない。
    c = c.replace(/https:\/\/github\.com(?::\d+)?\/LGUG-jp\/netarium(?:-dev)?\/(?:issues|pull|commit)\/[^\s<>"'`)]+/gi, '関連変更');

    // 見出しの表示から番号を除きつつ、既存の参照先IDは明示アンカーとして維持する。
    c = c.replace(/^(#{1,6}) (.+)$/gm, (whole, level, title) => {
        const cleaned = publicProse(title).trim();
        return cleaned === title ? whole : `<a id="${headingSlug(title)}"></a>\n\n${level} ${cleaned}`;
    });
    c = c.split(/(`{3,}[\s\S]*?`{3,}|~{3,}[\s\S]*?~{3,}|`[^`\n]+`|\]\([^)]+\)|<[^>\n]+>)/g)
        .map((part, index) => index % 2 ? part : publicProse(part)).join('');
    c = summarizePublicDoc(c, relPath);
    const externalIds = externalCommitIds(c);
    c = c.replace(commitToken, token => externalIds.has(token.toLowerCase()) ? token : '対象変更');
    const retainedAnchors = documentAnchors(c);
    removedDocAnchors.set(relPath, new Set([...documentAnchors(content)].filter(anchor => !retainedAnchors.has(anchor))));
    return c;
}

let transformedCount = 0;
for (const rel of publicFiles) {
    if (rel.endsWith('.md')) {
        const full = path.join(stagingDir, rel);
        const original = fs.readFileSync(full, 'utf-8');
        const transformed = transformDocContent(original, rel);
        if (transformed !== original) {
            fs.writeFileSync(full, transformed, 'utf-8');
            transformedCount++;
        }
    }
}
console.log(`置換適用Markdown文書数: ${transformedCount}`);

// -------------------------------------------------------------
// 6. 公開Markdownの内部参照残存・相対リンク・アンカー全数検査
// -------------------------------------------------------------
console.log('\n[4/6] 公開Markdownの残存参照・相対リンク・アンカー検査...');
const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
const brokenLinks = [];
const privateReferences = [];
const markdownDocs = new Map(publicFiles.filter(rel => /\.md$/i.test(rel))
    .map(rel => [rel, fs.readFileSync(path.join(stagingDir, rel), 'utf-8')]));

function documentAnchors(content) {
    const anchors = new Set();
    const duplicates = new Map();
    const cleaned = content.replace(/^\s*(`{3,}|~{3,})[\s\S]*?^\s*\1\s*$/gm, '');
    for (const match of cleaned.matchAll(/^(#{1,6})\s+(.+)$/gm)) {
        const slug = headingSlug(match[2]);
        const count = duplicates.get(slug) || 0;
        anchors.add(count ? `${slug}-${count}` : slug);
        duplicates.set(slug, count + 1);
    }
    for (const match of cleaned.matchAll(/<(?:a|[a-z][a-z0-9-]*)\b[^>]*\b(?:id|name)=["']([^"']+)["']/gi)) anchors.add(match[1]);
    return anchors;
}
const anchorIndex = new Map([...markdownDocs].map(([rel, content]) => [rel, documentAnchors(content)]));

for (const [rel, content] of markdownDocs) {
    const externalIds = externalCommitIds(content);
    const prose = content.replace(/\]\([^)]+\)/g, '').replace(/<[^>\n]+>/g, '');
    privateNumber.lastIndex = 0;
    if (privateNumber.test(prose)) privateReferences.push(`${rel}: Private Issue/PR番号`);
    if (/\bADR\b|(?:docs\/)?decisions\/|deployment-testing\.md|専用受入|github\.com(?::\d+)?\/LGUG-jp\/netarium(?:-dev)?\/(?:issues|pull|commit)\//i.test(content)) {
        privateReferences.push(`${rel}: 内部文書・受入記録への参照`);
    }
    if ([...content.matchAll(commitToken)].some(match => !externalIds.has(match[0].toLowerCase()))) {
        privateReferences.push(`${rel}: 内部コミット識別子`);
    }
    if (/関連変更(?:で|へ|を参照|のレビュー|時点)|各Issue／PR、設計方針|今回の全件回帰では|Phase Cの再測定/.test(prose)) {
        privateReferences.push(`${rel}: 内部履歴・参照不能な引継ぎ説明`);
    }

    const cleaned = content.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, '');
    for (const match of cleaned.matchAll(linkRegex)) {
        const text = match[1];
        const url = match[2].trim();
        if (/^(?:https?:|mailto:)/i.test(url)) continue;
        const [targetFile, encodedFragment] = url.split('#');
        const targetRel = targetFile
            ? path.posix.normalize(path.posix.join(path.posix.dirname(rel), decodeURIComponent(targetFile)))
            : rel;
        let fragment = encodedFragment ? decodeURIComponent(encodedFragment) : '';
        // 公開から除いた実施履歴への参照は、現在の確認手順へ誘導する。
        if (fragment && targetRel === 'docs/development.md' && removedDocAnchors.get(targetRel)?.has(fragment)) {
            const replacement = publicLink(rel, targetRel, '変更に応じた確認');
            markdownDocs.set(rel, markdownDocs.get(rel).replaceAll(`](${url})`, `](${replacement})`));
            fragment = '変更に応じた確認';
        }
        if (fragment && targetRel === 'docs/README.md' && removedDocAnchors.get(targetRel)?.has(fragment)) {
            const replacement = publicLink(rel, targetRel);
            markdownDocs.set(rel, markdownDocs.get(rel).replaceAll(`](${url})`, `](${replacement})`));
            fragment = '';
        }
        const resolved = path.join(stagingDir, targetRel);
        if (!fs.existsSync(resolved) || (fragment && anchorIndex.has(targetRel) && !anchorIndex.get(targetRel).has(fragment))) {
            brokenLinks.push({ source: rel, target: url, resolved: targetRel, text });
        }
    }
}
if (privateReferences.length || brokenLinks.length) {
    console.error('[FAIL] 公開Markdown検査に失敗しました (fail-closed 中断):');
    for (const violation of privateReferences) console.error(`  ${violation}`);
    for (const link of brokenLinks) console.error(`  ${link.source} -> ${link.target} (${link.resolved})`);
    cleanupStaging();
    process.exit(1);
}
for (const [rel, content] of markdownDocs) fs.writeFileSync(path.join(stagingDir, rel), content, 'utf-8');
console.log('公開Markdown検査: PASS (内部参照・リンク切れ・存在しないMarkdownアンカー 0件)');

// -------------------------------------------------------------
// 7. 秘密情報・危険ファイル検査（fail-closed、tests/含む全走査）
// -------------------------------------------------------------
console.log('\n[5/6] 秘密情報・危険ファイル検査 (fail-closed)...');

const SECRET_PATTERNS = [
    {
        name: 'GitHub Token',
        regex: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
        allowInTests: false
    },
    {
        name: 'Private Key',
        regex: /-----BEGIN (?:[A-Z0-9_-]+ )?PRIVATE KEY-----/,
        allowInTests: false
    },
    {
        name: 'Embedded Credentials in URL',
        regex: /https?:\/\/[^:\/\s"']+:[^@\/\s"']+@[^\/\s"']+/,
        allowInTests: false
    },
    {
        name: 'Hardcoded Secret / API Token',
        regex: /(?:api[_-]?key|secret[_-]?token|access[_-]?token)\s*[:=]\s*['"][a-zA-Z0-9_\-]{20,}['"]/i,
        allowInTests: true,
        // テスト内で許容される既知の安全な合成モックトークン
        testAllowlist: [
            /test-token/,
            /test-only-token/,
            /Synthetic user/
        ]
    },
    {
        name: 'Internal Domain URL (.local / .internal / .corp)',
        regex: /https?:\/\/[a-zA-Z0-9\-]+\.(?:local|internal|corp)(?::\d+)?(?:\/|\b)/i,
        allowInTests: false
    }
];

let secretViolations = 0;

for (const rel of publicFiles) {
    const full = path.join(stagingDir, rel);
    const ext = path.extname(rel).toLowerCase();

    // 危険な拡張子の検査
    if (['.sqlite', '.sqlite3', '.db', '.log', '.tmp', '.bak', '.env', '.pem', '.key', '.pfx'].includes(ext)) {
        console.error(`[FAIL] 禁止されたファイル形式が検出されました: ${rel} (fail-closed 中断)`);
        secretViolations++;
        continue;
    }

    const bytes = fs.readFileSync(full);
    const content = bytes.toString('utf-8');
    // G3-Bで権利未確定とした旧辞書は、改名・CRLF変換されても拒否する。
    const forbiddenNcsc = 'c2e5696882c603b76bb67a47ee970897e5a76fc4c3f5547abe3d0ca340c576e0';
    if (crypto.createHash('sha256').update(Buffer.from(bytes.toString('latin1').replace(/\r\n/g, '\n'), 'latin1')).digest('hex') === forbiddenNcsc
        || new RegExp(`"canonical_sha256"\\s*:\\s*"${forbiddenNcsc}"`, 'i').test(content)) {
        console.error(`[FAIL] 禁止辞書資材が検出されました: ${rel} (fail-closed 中断)`);
        secretViolations++;
    }
    if (content.toLowerCase().includes(sourceSha)
        || [...content.matchAll(/(?<![a-f0-9])[a-f0-9]{40}(?![a-f0-9])/gi)].some(match => privateAncestry.has(match[0].toLowerCase()))
        || /github\.com(?::\d+)?\/LGUG-jp\/netarium-dev\/(?:issues|pull|commit)\//i.test(content)) {
        console.error(`[FAIL] Private参照が検出されました: ${rel} (fail-closed 中断)`);
        secretViolations++;
    }
    const isTest = rel.startsWith('tests/');
    const lines = content.split(/\r?\n/);

    for (const pat of SECRET_PATTERNS) {
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (pat.regex.test(line)) {
                if (isTest && pat.allowInTests && pat.testAllowlist) {
                    const allowed = pat.testAllowlist.some(al => al.test(line));
                    if (allowed) {
                        continue;
                    }
                }
                // 機密値そのものは出力せず、ファイルと行番号、パターン名のみ報告
                console.error(`[FAIL] 秘密情報パターン (${pat.name}) が検出されました: ${rel}:${i + 1} (fail-closed 中断)`);
                secretViolations++;
            }
        }
    }
}

if (secretViolations > 0) {
    console.error(`[FAIL] 秘密情報スキャンで ${secretViolations} 件の違反が検出されました。公開候補を破棄します。`);
    cleanupStaging();
    process.exit(1);
}
console.log('秘密情報・機密ファイル検査: PASS');

// -------------------------------------------------------------
// 7.5 公開PowerShellスクリプト文字コード検査 (fail-closed)
// -------------------------------------------------------------
// Windows PowerShell 5.1（CP932/Shift-JIS環境）における文字コード誤認や
// 改行破壊（句点「。」等の末尾バイトによるCRLF消失）を防止するため、
// 配備・運用スクリプト（scripts/*.ps1）はBOMを含めず純粋なASCII（0x00-0x7F）のみで記述する。
console.log('\n[5.5/6] 公開PowerShellスクリプト文字コード検査 (fail-closed)...');
let ps1EncodingViolations = 0;
const ps1Scripts = publicFiles.filter(rel => /^scripts\/.*\.ps1$/i.test(rel));

for (const rel of ps1Scripts) {
    const full = path.join(stagingDir, rel);
    const buf = fs.readFileSync(full);

    // BOM (0xEF, 0xBB, 0xBF) 検査
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
        console.error(`[FAIL] 配備PowerShellスクリプトにBOMが含まれています: ${rel} (fail-closed 中断)`);
        ps1EncodingViolations++;
    }

    // 非ASCII文字検査
    const lines = buf.toString('utf-8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/[^\x00-\x7F]/.test(line)) {
            console.error(`[FAIL] 配備PowerShellスクリプトに非ASCII文字が検出されました: ${rel}:${i + 1} (fail-closed 中断)`);
            ps1EncodingViolations++;
        }
    }
}

if (ps1EncodingViolations > 0) {
    console.error(`[FAIL] 公開PowerShellスクリプト文字コード検査で ${ps1EncodingViolations} 件の違反が検出されました。公開候補を破棄します。`);
    cleanupStaging();
    process.exit(1);
}
console.log(`公開PowerShellスクリプト文字コード検査: PASS (${ps1Scripts.length} scripts verified pure ASCII)`);

// -------------------------------------------------------------
// 8. 安全な出力先への反映（全検査合格後のみ）
// -------------------------------------------------------------
console.log('\n[6/6] 公開スナップショットの配備とハッシュマニフェスト生成...');

// 全検査が合格したので、安全に出力先を作成（存在しない場合）して配置
if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
}

// ステージングから出力先へ全公開ファイルをコピー
for (const rel of publicFiles) {
    const src = path.join(stagingDir, rel);
    const dest = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
}

// SHA-256 ハッシュリストの生成（Private側台帳用）
const manifest = {
    source_private_sha: sourceSha,
    generated_at: new Date().toISOString(),
    total_files: publicFiles.length,
    files: {}
};
const hashLines = [];

for (const rel of publicFiles.slice().sort()) {
    const full = path.join(outDir, rel);
    const buf = fs.readFileSync(full);
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    const norm = rel.replace(/\\/g, '/');
    manifest.files[norm] = sha;
    hashLines.push(`${sha}  ${norm}`);
}

// Private側管理ディレクトリにのみ保存（Public候補内には配置しない）
const privateManifestDir = manifestDir;
const jsonPath = path.join(privateManifestDir, 'public-snapshot-sha256.json');
const txtPath = path.join(privateManifestDir, 'public-snapshot-sha256.txt');
fs.mkdirSync(privateManifestDir, { recursive: true });

let needsUpdate = true;
if (fs.existsSync(jsonPath)) {
    try {
        const existing = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
        if (existing.source_private_sha === sourceSha &&
            JSON.stringify(existing.files) === JSON.stringify(manifest.files)) {
            // 同一コミットかつ全ファイルハッシュ一致のため不要な更新を抑止
            needsUpdate = false;
        }
    } catch (_) {}
}

if (needsUpdate) {
    fs.writeFileSync(jsonPath, JSON.stringify(manifest, null, 2), 'utf-8');
    fs.writeFileSync(txtPath, hashLines.join('\n') + '\n', 'utf-8');
    console.log(`Private台帳出力更新: docs/release-candidate/public-snapshot-sha256.json (${publicFiles.length} files)`);
} else {
    console.log(`Private台帳検証: 既存台帳と完全一致（不要な変更なし: ${publicFiles.length} files）`);
}
console.log(`Publicスナップショット配置完了: ${outDir}`);

// ステージングのクリーンアップ
cleanupStaging();

console.log('\n=== 公開スナップショット生成完了 (PASS) ===\n');
