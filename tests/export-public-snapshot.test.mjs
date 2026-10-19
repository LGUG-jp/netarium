import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { test } from 'node:test';

function snapshotFixture(t, readme, files = {}, options = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'netarium-public-export-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const repo = path.join(root, 'repo');
    const output = path.join(root, 'public-candidate');
    fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(root, 'tmp'));
    // Only the implementation under test comes from the checkout. All exported
    // fixture content is committed in this isolated repository, never HEAD here.
    fs.copyFileSync(new URL('../scripts/export-public-snapshot.mjs', import.meta.url), path.join(repo, 'scripts/export-public-snapshot.mjs'));
    fs.writeFileSync(path.join(repo, 'README.md'), readme);
    fs.writeFileSync(path.join(repo, 'THIRD_PARTY_NOTICES.md'), '# Third-party notices\n\nSynthetic attribution fixture.\n');
    for (const [relative, content] of Object.entries(files)) {
        const target = path.join(repo, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
    }
    const git = args => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    git(['init', '-q']);
    git(['config', 'core.autocrlf', 'false']);
    git(['add', '-f', 'README.md', 'THIRD_PARTY_NOTICES.md', 'scripts/export-public-snapshot.mjs', ...Object.keys(files)]);
    git(['-c', 'user.name=Snapshot Fixture', '-c', 'user.email=snapshot@example.test', '-c', 'commit.gpgsign=false',
        '-c', 'core.hooksPath=' + path.join(root, 'no-hooks'), 'commit', '-qm', 'Synthetic export fixture']);
    if (options.ancestorLeakPath) {
        const parentSha = git(['rev-parse', 'HEAD']).toString('utf8').trim();
        const leakedFile = path.join(repo, options.ancestorLeakPath);
        fs.mkdirSync(path.dirname(leakedFile), { recursive: true });
        fs.writeFileSync(leakedFile, `Private parent ${options.uppercaseAncestor ? parentSha.toUpperCase() : parentSha}\n`);
        git(['add', '-f', options.ancestorLeakPath]);
        git(['-c', 'user.name=Snapshot Fixture', '-c', 'user.email=snapshot@example.test', '-c', 'commit.gpgsign=false',
            '-c', 'core.hooksPath=' + path.join(root, 'no-hooks'), 'commit', '-qm', 'Child containing forbidden parent reference']);
    }
    // These must not become the generated documentation.
    fs.writeFileSync(path.join(repo, 'README.md'), 'UNCOMMITTED WORKTREE CONTENT');
    fs.writeFileSync(path.join(repo, 'docs-untracked.md'), 'UNTRACKED CONTENT');
    const manifestDir = path.join(root, 'private-ledger');
    const result = spawnSync(process.execPath, [path.join(repo, 'scripts/export-public-snapshot.mjs'), '--commit', 'HEAD', '--out-dir', output, ...(options.separateManifest ? ['--manifest-dir', manifestDir] : [])], {
        cwd: repo, encoding: 'utf8'
    });
    assert.ifError(result.error);
    return { output, result, repo, manifestDir };
}

const repositories = ['netarium', 'netarium-dev'];
const routes = ['issues', 'pull', 'commit'];
const ports = ['', ':443', ':8443'];
const privateSha = 'a1b2c3d4'.repeat(5);
const externalSha = 'e5f6a7b8'.repeat(5);

test('公開成果物は両リポジトリ名の内部リンク・生URL・自動リンク・コード内URLを除き、通常URLと第三者コミットを保持する', t => {
    const internal = [];
    for (const repository of repositories) {
        for (const uppercase of [false, true]) {
            for (const route of routes) {
                for (const port of ports) {
                    let url = `https://github.com${port}/LGUG-jp/${repository}/${route}/${route === 'commit' ? privateSha : '217'}`;
                    if (uppercase) url = url.toUpperCase();
                    internal.push(`[リンク表示](${url})`, url, `<${url}>`, '`' + url + '`');
                }
            }
        }
    }
    const retained = repositories.flatMap(repository => [
        `https://github.com/LGUG-jp/${repository}`,
        `https://github.com/LGUG-jp/${repository}.git`,
        `https://github.com/LGUG-jp/${repository}/security/policy`,
        `https://github.com/LGUG-jp/${repository}/releases/tag/v1.0.0`
    ].flatMap(url => [url, url.replace('github.com/', 'github.com:443/')]));
    retained.push(`https://github.com/third-party/library/commit/${externalSha}`,
        `https://github.com/LGUG-jp/netarium-devtools/commit/${externalSha}`,
        `https://github.com:443/third-party/library/commit/${externalSha}`);
    const { output, result } = snapshotFixture(t, '# Snapshot fixture\n\n' + internal.join('\n\n') + '\n\n' +
        retained.map(url => `[通常リンク](${url})\n\n${url}`).join('\n\n') + '\n');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const readme = fs.readFileSync(path.join(output, 'README.md'), 'utf8');
    assert.doesNotMatch(readme, /github\.com(?::\d+)?\/LGUG-jp\/netarium(?:-dev)?\/(?:issues|pull|commit)\//i);
    assert.ok(!readme.toLowerCase().includes(privateSha));
    assert.ok(readme.includes('リンク表示'));
    for (const url of retained) {
        assert.ok(readme.includes(`[通常リンク](${url})`), `Link changed: ${url}`);
        assert.ok(readme.includes('\n\n' + url), `Raw URL changed: ${url}`);
    }
    assert.doesNotMatch(readme, /UNCOMMITTED|UNTRACKED/);
    assert.ok(!fs.existsSync(path.join(output, 'docs-untracked.md')));
    assert.equal(fs.readFileSync(path.join(output, 'THIRD_PARTY_NOTICES.md'), 'utf8'),
        '# Third-party notices\n\nSynthetic attribution fixture.\n');
});

for (const repository of repositories) {
    for (const route of routes) {
        for (const port of ports) {
            test(`残存する ${repository}${port}/${route} 参照は公開成果物の配置前に拒否される`, t => {
                // Protocol-relative references are not transformed. They must still
                // trip the independent residual guard, including mixed-case paths and ports.
                const url = `//GitHub.Com${port}/LGUG-JP/${repository.toUpperCase()}/${route.toUpperCase()}/${route === 'commit' ? privateSha : '217'}`;
                const { output, result } = snapshotFixture(t, `# Residual fixture\n\n<${url}>\n`);
                assert.notEqual(result.status, 0, result.stdout + result.stderr);
                assert.match(result.stderr, /公開Markdown検査に失敗/);
                assert.match(result.stderr, /内部文書・受入記録への参照/);
                assert.ok(!fs.existsSync(output), 'Rejected snapshot was deployed');
            });
        }
    }
}

test('旧NCSC資材・専用metadataと実行時追加辞書を公開せず、標準PWDBを保持する', t => {
    const forbidden = [
        'resources/password-blocklist/ncsc-100k.txt',
        'resources/password-blocklist/metadata.json',
        'resources/password-blocklist/renamed-local-dictionary.txt',
        'data/password-blocklist.json',
        'storage/password-blocklist.json',
        'tests/password-blocklist.json',
        `tests/password-blocklist/dictionary-${'a'.repeat(64)}.txt`,
        'docs/ncsc-100k.txt'
    ];
    const standard = [
        'resources/password-blocklist/pwdb-policy-top-3000.txt',
        'resources/password-blocklist/pwdb-metadata.json'
    ];
    const files = Object.fromEntries([...forbidden, ...standard].map(name => [name, `Synthetic fixture for ${name}\n`]));
    const { output, result } = snapshotFixture(t, '# Dictionary export fixture\n', files);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    for (const name of forbidden) assert.ok(!fs.existsSync(path.join(output, name)), `Forbidden export: ${name}`);
    for (const name of standard) assert.equal(fs.readFileSync(path.join(output, name), 'utf8'), files[name]);
    assert.ok(!fs.existsSync(path.join(output, '.git')));
});
test('配備PowerShellスクリプトに非ASCII文字やBOMが含まれる場合は公開候補を拒否する', t => {
    // 非ASCII文字（日本語コメント）が含まれる場合
    const { output: outNonAscii, result: resNonAscii } = snapshotFixture(t, '# Non-ASCII ps1 fixture\n', {
        'scripts/setup-iis.ps1': '# Setup IIS\n# 日本語コメント。\nWrite-Host "hello"\n'
    });
    assert.notEqual(resNonAscii.status, 0, resNonAscii.stdout + resNonAscii.stderr);
    assert.match(resNonAscii.stderr, /公開PowerShellスクリプト文字コード検査で 1 件の違反が検出されました/);
    assert.ok(!fs.existsSync(outNonAscii), 'Rejected snapshot was deployed');

    // UTF-8 BOMが含まれる場合
    const bomBuffer = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Write-Host "hello"\n', 'utf8')]);
    const { output: outBom, result: resBom } = snapshotFixture(t, '# BOM ps1 fixture\n', {
        'scripts/setup-iis.ps1': bomBuffer.toString('utf8')
    });
    assert.notEqual(resBom.status, 0, resBom.stdout + resBom.stderr);
    assert.match(resBom.stderr, /配備PowerShellスクリプトにBOMが含まれています/);
    assert.ok(!fs.existsSync(outBom), 'Rejected snapshot was deployed');

    // 純粋なASCIIのみの場合
    const { output: outAscii, result: resAscii } = snapshotFixture(t, '# Pure ASCII ps1 fixture\n', {
        'scripts/setup-iis.ps1': '# Pure ASCII setup script\nWrite-Host "hello"\n'
    });
    assert.equal(resAscii.status, 0, resAscii.stdout + resAscii.stderr);
    assert.ok(fs.existsSync(path.join(outAscii, 'scripts/setup-iis.ps1')));
});

test('release専用ツールとworkflowを除外し、manifest-dirを公開候補から分離する', t => {
    const excluded = ['scripts/release-sync.mjs', 'scripts/release-control.mjs', 'tests/release-sync.test.mjs', 'tests/release-control.test.mjs',
        '.github/workflows/release-candidate.yml', '.github/workflows/release-publish.yml', '.github/workflows/release-check.yml'];
    const { output, result, repo, manifestDir } = snapshotFixture(t, '# Public fixture\n', Object.fromEntries(excluded.map(name => [name, 'Private release implementation\n'])), { separateManifest: true });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    for (const name of excluded) assert.ok(!fs.existsSync(path.join(output, name)), name);
    assert.ok(fs.existsSync(path.join(manifestDir, 'public-snapshot-sha256.json')));
    assert.ok(!fs.existsSync(path.join(repo, 'docs/release-candidate/public-snapshot-sha256.json')));
    assert.ok(!fs.existsSync(path.join(output, 'public-snapshot-sha256.json')));
});

for (const prefix of ['ghp_', 'ghs_', 'github_pat_']) {
    test(`${prefix} tokenは拡張子にかかわらず公開前に拒否し、値を出力しない`, t => {
        const token = prefix + 'Z'.repeat(40);
        const { output, result } = snapshotFixture(t, '# Token fixture\n', { 'public/image.png': token });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /GitHub Token/);
        assert.ok(!result.stderr.includes(token));
        assert.ok(!fs.existsSync(output));
    });
}

test('改名した旧NCSC metadataのcanonical hashを拒否する', t => {
    const hash = 'c2e5696882c603b76bb67a47ee970897e5a76fc4c3f5547abe3d0ca340c576e0';
    const { output, result } = snapshotFixture(t, '# Dictionary metadata fixture\n', {
        'resources/renamed-metadata.json': JSON.stringify({ canonical_sha256: hash })
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /禁止辞書資材/);
    assert.ok(!fs.existsSync(output));
});

test('Markdown以外に置いたPrivate Issue URLも公開配置前に拒否する', t => {
    const url = 'https://github.com/' + 'LGUG-jp/' + 'netarium-dev/issues/999';
    const { output, result } = snapshotFixture(t, '# Private URL fixture\n', { 'src/reference.txt': url });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Private参照/);
    assert.ok(!result.stderr.includes(url));
    assert.ok(!fs.existsSync(output));
});

for (const [name, uppercaseAncestor] of [['src/parent-reference.txt', false], ['public/parent-reference.png', true]]) {
    test(`Private祖先SHAを含む${name}は大小文字と拡張子にかかわらず公開前に拒否する`, t => {
        const { output, result } = snapshotFixture(t, '# Ancestor reference fixture\n', {}, { ancestorLeakPath: name, uppercaseAncestor });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /Private参照/);
        assert.ok(!fs.existsSync(output));
    });
}
