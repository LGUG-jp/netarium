import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CORE_PUBLIC_PHP = new Set([
    'login.php', 'logout.php', 'setup.php', 'api.php', 'image_upload.php',
    'floor_plan.php', 'device_image.php', 'healthcheck.php', 'change-password.php'
]);
const DOCKER_WORKFLOWS = new Set([
    '.github/workflows/docker-poc.yml',
    '.github/workflows/public-snapshot-check.yml'
]);

/** Dockerが実行する経路への影響を、変更一覧全体で保守的に分類する。 */
export function classifyDockerChanges(paths, { forceFull = false } = {}) {
    if (forceFull) return 'full';
    let mode = 'none';
    for (const changedPath of paths) {
        // 文書は配備資材・テスト・src配下でもDocker実行対象にしない。
        if (/\.(?:md|markdown)(?![\s\S])/i.test(changedPath)) continue;
        if (DOCKER_WORKFLOWS.has(changedPath)
            || changedPath === 'tests/ci-docker-scope.test.mjs'
            || /^(?:Dockerfile(?:\.[^/]+)?|\.dockerignore|compose[^/]*\.ya?ml)$/.test(changedPath)
            || /^(?:docker|config|resources|scripts)\//.test(changedPath)
            || /^tests\/(?:docker-|full-backup)/.test(changedPath)) return 'full';
        if (changedPath.startsWith('src/')) {
            if (/^src\/(?:Actions|Services)\/(?:Quality|Monitoring)\/.+\.php$/.test(changedPath)) {
                mode = 'smoke';
                continue;
            }
            // 未知のsrc経路もDB・認証・保存処理へ影響し得るためfullとする。
            return 'full';
        }
        if (changedPath === 'public/web.config'
            || (changedPath.startsWith('public/') && CORE_PUBLIC_PHP.has(changedPath.slice(7)))
            || /^[^/]+\.php$/.test(changedPath)) return 'full';
        if (/^(?:templates|public)\/.+\.php$/.test(changedPath)) mode = 'smoke';
    }
    return mode;
}

function parseArgs(args) {
    if (args.length === 1 && args[0] === '--full') return { forceFull: true };
    const options = {};
    for (let index = 0; index < args.length; index += 2) {
        const flag = args[index];
        const value = args[index + 1];
        if (!['--base', '--head'].includes(flag) || options[flag] !== undefined
            || typeof value !== 'string' || !/^[a-f0-9]{40}(?![\s\S])/i.test(value)) {
            throw new Error('--base SHA --head SHA または --full を指定してください（SHAは40桁の16進数）');
        }
        options[flag] = value;
    }
    if (!options['--base'] || !options['--head']) {
        throw new Error('--base SHA --head SHA または --full を指定してください');
    }
    return { base: options['--base'], head: options['--head'], forceFull: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const { base, head, forceFull } = parseArgs(process.argv.slice(2));
        // PR差分はmerge-baseから求め、base側だけの更新でfullへ広げない。
        // --no-renamesにより、renameの旧経路・新経路を両方とも分類する。
        const paths = forceFull ? [] : execFileSync('git', [
            'diff', '--name-only', '-z', '--no-renames', `${base}...${head}`, '--'
        ], { encoding: 'utf8', stdio: 'pipe' }).split('\0').filter(Boolean);
        const mode = classifyDockerChanges(paths, { forceFull });
        const output = `mode=${mode}\n`;
        if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, output);
        process.stdout.write(output);
    } catch (error) {
        console.error(`[ERROR] Docker CI範囲の判定に失敗しました: ${error.message}`);
        process.exitCode = 1;
    }
}
