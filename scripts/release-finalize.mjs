/** Publicでレビュー済みのrelease PRをtag・Releaseへ確定する。 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY = 'LGUG-jp/netarium';
const PREFIX = `/repos/${REPOSITORY}`;
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?![\s\S])/;
const SHA = /^[a-f0-9]{40}(?![\s\S])/;
const IDENTITY = { name: 'Netarium Release', email: 'release@users.noreply.github.com' };
class ReleaseError extends Error {}
const requireThat = (condition, message) => { if (!condition) throw new ReleaseError(message); };
const newer = (left, right) => {
    const a = left.split('.').map(BigInt), b = right.split('.').map(BigInt);
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
    return false;
};
const branchVersion = ref => typeof ref === 'string' && ref.startsWith('release/v') && VERSION.test(ref.slice(9)) ? ref.slice(9) : null;
const identityMatches = value => value?.name === IDENTITY.name && value.email === IDENTITY.email;
const sameDate = (a, b) => typeof a === 'string' && typeof b === 'string' && Number.isFinite(Date.parse(a)) && Date.parse(a) === Date.parse(b);

export function githubTransport(token) {
    return async (method, route, body) => {
        requireThat((route === PREFIX || route.startsWith(PREFIX + '/')) && !route.includes('://'), '不正なAPIパスです');
        let response;
        try {
            response = await fetch('https://api.github.com' + route, {
                method, redirect: 'error',
                headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', Authorization: `Bearer ${token}`,
                    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
                ...(body === undefined ? {} : { body: JSON.stringify(body) })
            });
        } catch { throw new ReleaseError('GitHub API通信に失敗しました（詳細非表示）'); }
        let data;
        if (response.status !== 204) {
            try { data = await response.json(); } catch { throw new ReleaseError('GitHub API応答を解析できません'); }
        }
        return { status: response.status, data };
    };
}

export function createFinalizer({ request, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
    let wrote = false;
    async function api(method, route, body, allowed = []) {
        if (method !== 'GET') {
            if (wrote) await sleep(1000);
            wrote = true;
        }
        let result;
        try { result = await request(method, PREFIX + route, body); }
        catch { throw new ReleaseError('GitHub API通信に失敗しました（詳細非表示）'); }
        requireThat(Number.isInteger(result?.status), 'GitHub API応答statusが不正です');
        if (allowed.includes(result.status)) return null;
        const expected = method === 'GET' || method === 'PATCH' ? 200 : method === 'DELETE' ? 204 : 201;
        requireThat(result.status === expected, `GitHub API操作に失敗しました（HTTP ${result.status}）`);
        return result.data;
    }
    async function pages(route) {
        const values = [];
        for (let page = 1; ; page++) {
            const batch = await api('GET', `${route}${route.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
            requireThat(Array.isArray(batch), 'GitHub API一覧が不正です');
            values.push(...batch);
            if (batch.length < 100) return values;
        }
    }
    return {
        async run(env = process.env) {
            requireThat(env.GITHUB_REPOSITORY === REPOSITORY, '公開対象リポジトリが一致しません');
            requireThat(['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME), 'pushまたは手動実行が必要です');
            requireThat(SHA.test(env.GITHUB_SHA || ''), '実行SHAが不正です');
            // pushとworkflow_dispatchのどちらも、レビュー済みのmainで実行されたコードだけを許可する。
            requireThat(env.GITHUB_REF === 'refs/heads/main', 'mainで実行されたworkflowだけを許可します');
            if (!request) {
                const token = env.GH_TOKEN || env.GITHUB_TOKEN;
                requireThat(typeof token === 'string' && token.length > 0, 'GitHub tokenが必要です');
                request = githubTransport(token);
            }
            let version, candidates;
            if (env.GITHUB_EVENT_NAME === 'workflow_dispatch') {
                version = env.RELEASE_VERSION;
                requireThat(typeof version === 'string' && VERSION.test(version), '版は先頭ゼロなしのMAJOR.MINOR.PATCHが必要です');
                candidates = (await pages(`/pulls?state=closed&head=${encodeURIComponent('LGUG-jp:release/v' + version)}&base=main`))
                    .filter(pr => pr.head?.ref === `release/v${version}` && pr.base?.ref === 'main');
            } else {
                candidates = (await pages(`/commits/${env.GITHUB_SHA}/pulls`))
                    .filter(pr => branchVersion(pr.head?.ref) && pr.base?.ref === 'main');
                if (candidates.length === 0) return { state: 'ignored' };
            }
            requireThat(candidates.length === 1 && Number.isSafeInteger(candidates[0].number) && candidates[0].number > 0, '対象release PRを一意に確認できません');
            const pr = await api('GET', `/pulls/${candidates[0].number}`);
            version ||= branchVersion(pr.head?.ref);
            requireThat(version && VERSION.test(version) && !newer('1.0.2', version), '公開版は1.0.2以降が必要です');
            const title = `Release v${version}`, tag = `v${version}`, branch = `release/${tag}`;
            const repository = await api('GET', '');
            requireThat(repository.full_name === REPOSITORY && Number.isSafeInteger(repository.id) && repository.id > 0, 'Repository IDを確認できません');
            requireThat(pr.title === title && pr.body === `${title}.` && pr.head?.ref === branch && pr.base?.ref === 'main'
                && pr.head.repo?.id === repository.id && pr.base.repo?.id === repository.id
                && pr.state === 'closed' && pr.merged === true && Boolean(pr.merged_at)
                && SHA.test(pr.head.sha || '') && SHA.test(pr.merge_commit_sha || ''), 'マージ済みrelease PRの内容が一致しません');
            const mergedSha = pr.merge_commit_sha;
            if (env.GITHUB_EVENT_NAME === 'push') requireThat(mergedSha === env.GITHUB_SHA, 'pushとマージSHAが一致しません');
            const main = await api('GET', '/git/ref/heads/main');
            requireThat(main.object?.type === 'commit' && SHA.test(main.object.sha || ''), 'main SHAが不正です');
            const comparison = await api('GET', `/compare/${mergedSha}...${main.object.sha}`);
            requireThat(['identical', 'ahead'].includes(comparison.status), 'マージcommitがmainの祖先ではありません');
            const head = await api('GET', `/git/commits/${pr.head.sha}`);
            const merged = await api('GET', `/git/commits/${mergedSha}`);
            requireThat(head.sha === pr.head.sha && merged.sha === mergedSha && Array.isArray(head.parents) && head.parents.length === 1
                && head.message === title && identityMatches(head.author) && identityMatches(head.committer)
                && sameDate(head.author.date, head.committer.date), 'release head commitの内容・署名者が一致しません');
            requireThat(Array.isArray(merged.parents) && merged.parents.length === 1 && SHA.test(head.tree?.sha || '')
                && merged.tree?.sha === head.tree.sha, 'squash/rebase commitとrelease treeが一致しません');
            async function content(name) {
                const value = await api('GET', `/contents/${name}?ref=${mergedSha}`);
                requireThat(value.type === 'file' && value.encoding === 'base64' && typeof value.content === 'string', '公開ファイルを確認できません');
                return Buffer.from(value.content, 'base64').toString('utf8');
            }
            // PHPを実行せず、公開版の定数宣言だけをデータとして読む。
            const php = (await content('version.php')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\r\n]*|#[^\r\n]*/g, '');
            const declaration = /^\s*<\?php\s+(?:declare\s*\(\s*strict_types\s*=\s*1\s*\)\s*;\s*)?const\s+NETARIUM_VERSION\s*=\s*(['"])([^'"\r\n]*)\1\s*;\s*(?:\?>\s*)?(?![\s\S])/.exec(php);
            requireThat(declaration && declaration[2] === version, 'version.phpと版が一致しません');
            const escaped = version.replaceAll('.', '\\.');
            requireThat(new RegExp(`^## (?:v?${escaped}|\\[v?${escaped}\\])(?: (?:- )?(?:[0-9]{4}-[0-9]{2}-[0-9]{2}|\\([0-9]{4}-[0-9]{2}-[0-9]{2}\\)))?[ \\t]*\\r?$`, 'm').test(await content('CHANGELOG.md')), 'CHANGELOGに対象版のrelease見出しが必要です');
            async function orderGuard() {
                const releases = await pages('/releases');
                requireThat(!releases.some(value => value.draft === false && value.prerelease === false && typeof value.tag_name === 'string'
                    && value.tag_name.startsWith('v') && VERSION.test(value.tag_name.slice(1)) && newer(value.tag_name.slice(1), version)), '新しい正式Releaseが公開済みです');
            }
            await orderGuard();
            const releaseBody = `${title}.\n\n[CHANGELOG](https://github.com/${REPOSITORY}/blob/${tag}/CHANGELOG.md)\n\n[Security policy](https://github.com/${REPOSITORY}/security/policy)`;
            function validateRelease(value) {
                requireThat(Number.isSafeInteger(value?.id) && value.id > 0 && value.tag_name === tag && value.name === `Netarium ${tag}`
                    && value.body === releaseBody && value.target_commitish === mergedSha && value.draft === false && value.prerelease === false
                    && Array.isArray(value.assets) && value.assets.length === 0 && value.html_url === `https://github.com/${REPOSITORY}/releases/tag/${tag}`
                    && value.zipball_url === `https://api.github.com/repos/${REPOSITORY}/zipball/${tag}`
                    && value.tarball_url === `https://api.github.com/repos/${REPOSITORY}/tarball/${tag}`, '既存Releaseの内容・標準source配布URLが一致しません');
            }
            async function validateTag(ref) {
                requireThat(ref?.object?.type === 'tag' && SHA.test(ref.object.sha || ''), '既存tagは注釈付きではありません');
                const value = await api('GET', `/git/tags/${ref.object.sha}`);
                requireThat(value.tag === tag && value.message === title && identityMatches(value.tagger) && sameDate(value.tagger.date, head.committer.date)
                    && value.object?.type === 'commit' && value.object.sha === mergedSha, '既存tagの内容が一致しません');
            }
            let ref = await api('GET', `/git/ref/tags/${tag}`, undefined, [404]);
            let release = await api('GET', `/releases/tags/${tag}`, undefined, [404]);
            if (ref) await validateTag(ref);
            if (release) { validateRelease(release); requireThat(ref, 'tagなしの既存Releaseは再利用できません'); }
            const branchRef = await api('GET', `/git/ref/heads/${branch}`, undefined, [404]);
            requireThat(!branchRef || (branchRef.object?.type === 'commit' && branchRef.object.sha === pr.head.sha), '削除対象branchが変更されています');
            if (!ref) {
                const annotated = await api('POST', '/git/tags', { tag, message: title, object: mergedSha, type: 'commit', tagger: { ...IDENTITY, date: head.committer.date } });
                requireThat(SHA.test(annotated?.sha || ''), '注釈tagが不正です');
                await api('POST', '/git/refs', { ref: `refs/tags/${tag}`, sha: annotated.sha }, [422]);
                ref = await api('GET', `/git/ref/tags/${tag}`);
                await validateTag(ref);
            }
            if (!release) {
                await orderGuard();
                await api('POST', '/releases', { tag_name: tag, name: `Netarium ${tag}`, body: releaseBody,
                    target_commitish: mergedSha, draft: false, prerelease: false, make_latest: 'true' });
                release = await api('GET', `/releases/tags/${tag}`);
                validateRelease(release);
            }
            let latest = await api('GET', '/releases/latest', undefined, [404]);
            if (!latest || latest.id !== release.id) {
                await orderGuard();
                requireThat(!latest || (latest.draft === false && latest.prerelease === false && typeof latest.tag_name === 'string'
                    && latest.tag_name.startsWith('v') && VERSION.test(latest.tag_name.slice(1)) && newer(version, latest.tag_name.slice(1))), 'Latestが別の正式Releaseを指しています');
                validateRelease(await api('PATCH', `/releases/${release.id}`, { make_latest: 'true' }));
            }
            latest = await api('GET', '/releases/latest');
            validateRelease(latest);
            requireThat(latest.id === release.id, 'Latestの更新を確認できません');
            const finalBranch = await api('GET', `/git/ref/heads/${branch}`, undefined, [404]);
            if (finalBranch) {
                requireThat(finalBranch.object?.type === 'commit' && finalBranch.object.sha === pr.head.sha, '削除対象branchが変更されています');
                await api('DELETE', `/git/refs/heads/${branch}`);
            }
            return { state: 'complete', tag, release_url: release.html_url };
        }
    };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        requireThat(process.argv.length === 2, '引数は指定できません');
        const result = await createFinalizer().run();
        if (result.state !== 'ignored') {
            console.log(JSON.stringify(result));
            if (process.env.GITHUB_OUTPUT && result.state === 'complete') {
                const rawVersion = result.tag.startsWith('v') ? result.tag.slice(1) : result.tag;
                fs.appendFileSync(process.env.GITHUB_OUTPUT, `state=complete\ntag=${result.tag}\nversion=${rawVersion}\n`);
            }
        }
    } catch (error) {
        console.error(`[ERROR] リリース確定に失敗しました: ${error instanceof ReleaseError ? error.message : '内部処理に失敗しました（詳細非表示）'}`);
        process.exitCode = 1;
    }
}
