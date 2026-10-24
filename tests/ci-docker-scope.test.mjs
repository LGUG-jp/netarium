import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { classifyDockerChanges } from '../scripts/ci-docker-scope.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/ci-docker-scope.mjs', import.meta.url));

for (const [mode, paths] of Object.entries({
    none: [
        'README.md', 'docs/deployment.md', 'docs/example.txt', 'docs/example.php',
        'docker/README.md', 'scripts/run.markdown', 'resources/NOTICE.MD',
        'config/README.md', 'src/Core/README.md', 'templates/README.md',
        'tests/docker-backup.md', 'tests/full-backup.md',
        'public/js/app.js', 'public/js/editor.mjs', 'public/css/app.css',
        'tests/regression_test.php', 'tests/link-router.test.mjs',
        '.github/workflows/unrelated.yml'
    ],
    smoke: [
        'templates/modals/data_quality.php', 'templates/components/canvas.php',
        'public/index.php', 'public/new-page.php',
        'src/Actions/Quality/Check.php', 'src/Services/Quality/Report.php',
        'src/Actions/Monitoring/Ping.php', 'src/Services/Monitoring/Ping.php'
    ],
    full: [
        'Dockerfile', 'Dockerfile.test', '.dockerignore', 'compose.yaml',
        'compose.image.yaml', 'compose.test.yml', 'docker/php.ini', 'config/app.php',
        'resources/password-blocklist/pwdb.txt', 'scripts/docker-update.sh',
        'scripts/export-public-snapshot.mjs', 'scripts/ci-docker-scope.mjs',
        'scripts/example.css', 'tests/ci-docker-scope.test.mjs',
        '.github/workflows/docker-poc.yml', '.github/workflows/public-snapshot-check.yml',
        'tests/docker-backup-runners.test.php', 'tests/full-backup.test.php',
        'tests/full-backup.test.ps1', 'src/Core/Database.php', 'src/Autoloader.php',
        'src/Repositories/DeviceRepository.php', 'src/Services/AuthService.php',
        'src/Actions/Save.php', 'src/NewSubsystem/NewFile.php',
        'src/Services/Quality/NewRuntime.json', 'src/unknown.js',
        'public/login.php', 'public/logout.php', 'public/setup.php', 'public/api.php',
        'public/image_upload.php', 'public/floor_plan.php', 'public/device_image.php',
        'public/healthcheck.php', 'public/change-password.php', 'public/web.config',
        'bootstrap.php', 'new-root.php'
    ]
})) {
    for (const changedPath of paths) {
        test(`${changedPath} は ${mode} に分類する`, () => {
            assert.equal(classifyDockerChanges([changedPath]), mode);
        });
    }
}

test('空差分と文書・ブラウザーJS/CSSだけの混在はnoneになる', () => {
    assert.equal(classifyDockerChanges([]), 'none');
    assert.equal(classifyDockerChanges(['README.md', 'public/js/app.js', 'public/css/app.css']), 'none');
});

test('混在順序にかかわらずfullがsmokeより、smokeがnoneより優先する', () => {
    const docs = 'scripts/README.md';
    const smoke = 'templates/modals/account.php';
    const full = 'src/Core/Database.php';
    for (const paths of [[docs, smoke], [smoke, docs]]) {
        assert.equal(classifyDockerChanges(paths), 'smoke');
    }
    for (const paths of [
        [docs, smoke, full], [full, smoke, docs], [smoke, full, docs],
        [docs, full, smoke], [full, docs, smoke], [smoke, docs, full]
    ]) assert.equal(classifyDockerChanges(paths), 'full');
});

test('手動full指定は空差分や文書だけでもfullになる', () => {
    for (const paths of [[], ['README.md'], ['public/index.php']]) {
        assert.equal(classifyDockerChanges(paths, { forceFull: true }), 'full');
    }
});

function tempDirectory(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'netarium-docker-scope-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

function runCli(cwd, args, outputFile) {
    const env = { ...process.env };
    delete env.GITHUB_OUTPUT;
    if (outputFile) env.GITHUB_OUTPUT = outputFile;
    const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, env, encoding: 'utf8' });
    assert.ifError(result.error);
    return result;
}

function assertMode(result, mode) {
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout, `mode=${mode}\n`);
    assert.equal(result.stderr, '');
}

function gitFixture(t, files) {
    const root = tempDirectory(t);
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim();
    git(['init', '-q']);
    git(['config', 'core.autocrlf', 'false']);
    function writeFile(relative, content = 'Synthetic Docker scope fixture\n') {
        const target = path.join(repo, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
    }
    function commit() {
        git(['add', '-A']);
        git(['-c', 'user.name=Docker Scope Fixture', '-c', 'user.email=scope@example.test',
            '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=' + path.join(root, 'no-hooks'),
            'commit', '-qm', 'Synthetic scope fixture']);
        return git(['rev-parse', 'HEAD']);
    }
    for (const relative of files) writeFile(relative);
    const base = commit();
    return { root, repo, git, writeFile, commit, base };
}

test('CLI --fullはGitリポジトリ外でも差分なしで実行し、GITHUB_OUTPUTへ追記する', t => {
    const root = tempDirectory(t);
    const output = path.join(root, 'github-output');
    fs.writeFileSync(output, 'existing=value\n');
    assertMode(runCli(root, ['--full'], output), 'full');
    assert.equal(fs.readFileSync(output, 'utf8'), 'existing=value\nmode=full\n');
});

test('CLIは実Gitの空差分・文書差分をnoneにしてstdoutとGITHUB_OUTPUTに出す', t => {
    const fixture = gitFixture(t, ['README.md']);
    const output = path.join(fixture.root, 'github-output');
    assertMode(runCli(fixture.repo, ['--base', fixture.base, '--head', fixture.base], output), 'none');
    fixture.writeFile('README.md', 'Changed documentation\n');
    fixture.writeFile('public/js/a file.js');
    const head = fixture.commit();
    assertMode(runCli(fixture.repo, ['--head', head, '--base', fixture.base], output), 'none');
    assert.equal(fs.readFileSync(output, 'utf8'), 'mode=none\nmode=none\n');
});

test('CLIはbase側だけのコア更新をPRの変更に混入させない', t => {
    const fixture = gitFixture(t, ['README.md']);
    fixture.git(['checkout', '-qb', 'topic']);
    fixture.writeFile('README.md', 'Topic documentation\n');
    const head = fixture.commit();
    fixture.git(['checkout', '-qb', 'updated-base', fixture.base]);
    fixture.writeFile('src/Core/Database.php');
    const base = fixture.commit();
    assertMode(runCli(fixture.repo, ['--base', base, '--head', head]), 'none');
});

for (const [from, to, mode] of [
    ['src/Core/Database.php', 'docs/renamed.md', 'full'],
    ['docs/renamed.md', 'src/Core/Database.php', 'full'],
    ['templates/old page.php', 'docs/renamed.md', 'smoke'],
    ['docs/renamed.md', 'templates/new page.php', 'smoke']
]) {
    test(`CLIはrenameの両端を評価する: ${from} → ${to}`, t => {
        const fixture = gitFixture(t, [from]);
        fs.mkdirSync(path.dirname(path.join(fixture.repo, to)), { recursive: true });
        fixture.git(['mv', '--', from, to]);
        const head = fixture.commit();
        assertMode(runCli(fixture.repo, ['--base', fixture.base, '--head', head]), mode);
    });
}

for (const [deleted, mode] of [
    ['src/Core/Database.php', 'full'],
    ['templates/removed.php', 'smoke'],
    ['docs/removed.md', 'none']
]) {
    test(`CLIは削除済みの経路も評価する: ${deleted}`, t => {
        const fixture = gitFixture(t, ['README.md', deleted]);
        fs.rmSync(path.join(fixture.repo, deleted));
        const head = fixture.commit();
        assertMode(runCli(fixture.repo, ['--base', fixture.base, '--head', head]), mode);
    });
}

test('CLIはNUL区切りで特殊文字・改行を含む経路を分割し、shellとして実行しない', t => {
    // Windowsで作成できない改行入りファイル名はPOSIX環境だけで追加する。
    const fixture = gitFixture(t, ['README.md']);
    fixture.writeFile('public/js/$(not-a-command); app.js');
    if (process.platform !== 'win32') fixture.writeFile('public/js/newline\nbootstrap.php');
    const head = fixture.commit();
    assertMode(runCli(fixture.repo, ['--base', fixture.base, '--head', head]), 'none');
});

const sha = 'a'.repeat(40);
for (const args of [
    [], ['--base', sha], ['--head', sha], ['--base'], ['--unknown'],
    ['--full', '--base', sha, '--head', sha], ['--full', '--full'],
    ['--base', sha, '--base', sha, '--head', sha],
    ...['HEAD', 'main', '-bad', 'a'.repeat(39), 'a'.repeat(41), 'g'.repeat(40), `${sha}\n`, `${sha};echo bad`]
        .flatMap(value => [['--base', value, '--head', sha], ['--base', sha, '--head', value]])
]) {
    test(`CLIは不正な引数を失敗にする: ${JSON.stringify(args)}`, t => {
        const root = tempDirectory(t);
        const output = path.join(root, 'github-output');
        const result = runCli(root, args, output);
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.equal(result.stdout, '');
        assert.match(result.stderr, /\[ERROR\]/);
        assert.ok(!fs.existsSync(output));
    });
}

test('CLIはGit実行失敗や存在しないSHAをnoneに置き換えない', t => {
    const fixture = gitFixture(t, ['README.md']);
    const output = path.join(fixture.root, 'github-output');
    for (const [cwd, base, head] of [
        [fixture.root, fixture.base, fixture.base],
        [fixture.repo, '0'.repeat(40), fixture.base],
        [fixture.repo, fixture.base, '0'.repeat(40)]
    ]) {
        const result = runCli(cwd, ['--base', base, '--head', head], output);
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.equal(result.stdout, '');
        assert.match(result.stderr, /\[ERROR\]/);
        assert.ok(!fs.existsSync(output));
    }
});
