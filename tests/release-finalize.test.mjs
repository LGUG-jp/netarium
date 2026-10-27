import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFinalizer, githubTransport } from '../scripts/release-finalize.mjs';

const REPO = 'LGUG-jp/netarium';
const prefix = `/repos/${REPO}`;
const sha = digit => digit.repeat(40);
const mergedSha = sha('a'), headSha = sha('b'), treeSha = sha('c'), tagSha = sha('d');
const date = '2026-10-20T00:00:00Z';
const identity = { name: 'netarium-release-publisher-lgug[bot]', email: '344701945+netarium-release-publisher-lgug[bot]@users.noreply.github.com', date };
const legacyIdentity = { name: 'Netarium Release', email: 'release@users.noreply.github.com', date };
const env = { GITHUB_REPOSITORY: REPO, GITHUB_EVENT_NAME: 'push', GITHUB_SHA: mergedSha, GITHUB_REF: 'refs/heads/main' };
const releaseBody = `Release v1.0.2.\n\n[CHANGELOG](https://github.com/${REPO}/blob/v1.0.2/CHANGELOG.md)\n\n[Security policy](https://github.com/${REPO}/security/policy)`;
function fixture() {
    const pr = { number: 12, title: 'Release v1.0.2', body: 'Release v1.0.2.', state: 'closed', merged: true,
        merged_at: date, merge_commit_sha: mergedSha, head: { ref: 'release/v1.0.2', sha: headSha, repo: { id: 42 } }, base: { ref: 'main', repo: { id: 42 } } };
    const head = { sha: headSha, message: 'Release v1.0.2', parents: [{ sha: sha('e') }], tree: { sha: treeSha }, author: { ...identity }, committer: { ...identity } };
    const merged = { sha: mergedSha, parents: [{ sha: sha('e') }], tree: { sha: treeSha } };
    const state = { pr, head, merged, ref: null, annotated: null, release: null, latest: null, branch: headSha,
        version: "<?php\nconst NETARIUM_VERSION = '1.0.2';\n", changelog: '# Changelog\n\n## [v1.0.2] - 2026-10-20\n',
        associated: [pr], closed: [pr], otherReleases: [], writes: [], calls: [], sleeps: [], deny: null, failAfter: null, failBefore: null,
        main: mergedSha, comparison: 'identical', conflict: false };
    const ok = (data, status = 200) => ({ status, data: structuredClone(data) });
    const request = async (method, route, body) => {
        assert.ok(route === prefix || route.startsWith(prefix + '/'));
        state.calls.push({ method, route, body });
        if (state.deny) return { status: state.deny, data: { message: 'secret-response-must-not-appear' } };
        const suffix = route.slice(prefix.length);
        if (method !== 'GET') {
            state.writes.push({ method, route, body });
            if (state.failBefore === suffix) { state.failBefore = null; throw new Error('secret-transport-error'); }
        }
        if (method === 'GET') {
            if (!suffix) return ok({ id: 42, full_name: REPO });
            if (suffix.startsWith(`/commits/${mergedSha}/pulls?`)) return ok(state.associated);
            if (suffix.startsWith('/pulls?')) return ok(state.closed);
            if (suffix === '/pulls/12') return ok(state.pr);
            if (suffix === '/git/ref/heads/main') return ok({ object: { type: 'commit', sha: state.main } });
            if (suffix.startsWith('/compare/')) return ok({ status: state.comparison });
            if (suffix === `/git/commits/${headSha}`) return ok(state.head);
            if (suffix === `/git/commits/${mergedSha}`) return ok(state.merged);
            if (suffix.startsWith('/contents/')) {
                const text = suffix.startsWith('/contents/version.php?') ? state.version : state.changelog;
                return ok({ type: 'file', encoding: 'base64', content: Buffer.from(text).toString('base64') });
            }
            if (suffix.startsWith('/releases?')) {
                const all = [...state.otherReleases, ...(state.release ? [state.release] : [])];
                const page = Number(new URL('https://example.test' + suffix).searchParams.get('page'));
                return ok(all.slice((page - 1) * 100, page * 100));
            }
            if (suffix === '/git/ref/tags/v1.0.2') return ok(state.ref, state.ref ? 200 : 404);
            if (suffix === `/git/tags/${tagSha}`) return ok(state.annotated);
            if (suffix === '/releases/tags/v1.0.2') return ok(state.release, state.release ? 200 : 404);
            if (suffix === '/releases/latest') return ok(state.latest, state.latest ? 200 : 404);
            if (suffix === '/git/ref/heads/release/v1.0.2') return ok(state.branch ? { object: { type: 'commit', sha: state.branch } } : null, state.branch ? 200 : 404);
        }
        let result;
        if (method === 'POST' && suffix === '/git/tags') {
            state.annotated = { ...body, object: { type: body.type, sha: body.object }, sha: tagSha };
            result = ok(state.annotated, 201);
        } else if (method === 'POST' && suffix === '/git/refs') {
            state.ref = { object: { type: 'tag', sha: body.sha } };
            result = ok(state.ref, state.conflict ? 422 : 201);
        } else if (method === 'POST' && suffix === '/releases') {
            state.release = { ...body, id: 123, assets: [], html_url: `https://github.com/${REPO}/releases/tag/v1.0.2`,
                zipball_url: `https://api.github.com/repos/${REPO}/zipball/v1.0.2`, tarball_url: `https://api.github.com/repos/${REPO}/tarball/v1.0.2` };
            state.latest = structuredClone(state.release);
            result = ok(state.release, 201);
        } else if (method === 'PATCH' && suffix === '/releases/123') {
            state.latest = structuredClone(state.release);
            result = ok(state.release);
        } else if (method === 'DELETE' && suffix === '/git/refs/heads/release/v1.0.2') {
            state.branch = null;
            result = ok(null, 204);
        } else assert.fail(`Unexpected API: ${method} ${suffix}`);
        if (state.failAfter === suffix) { state.failAfter = null; throw new Error('secret-transport-error'); }
        return result;
    };
    state.run = overrides => createFinalizer({ request, sleep: async ms => state.sleeps.push(ms) }).run({ ...env, ...overrides });
    return state;
}

test('push finalizes reviewed squash, annotated tag, Release, Latest and branch; repeat writes nothing', async () => {
    const state = fixture();
    assert.equal((await state.run()).state, 'complete');
    assert.deepEqual(state.writes.map(value => value.method), ['POST', 'POST', 'POST', 'DELETE']);
    assert.equal(state.annotated.object.sha, mergedSha);
    assert.deepEqual(state.annotated.tagger, identity);
    assert.equal(state.release.body, releaseBody);
    assert.equal(state.latest.id, state.release.id);
    assert.equal(state.branch, null);
    assert.deepEqual(state.sleeps, [1000, 1000, 1000]);
    const writes = state.writes.length;
    await state.run();
    assert.equal(state.writes.length, writes);
    for (const write of state.writes) {
        assert.ok(write.route.startsWith(prefix + '/'));
        assert.doesNotMatch(JSON.stringify(write), /source_private|candidate_run|ledger|RELEASE_TOKEN/);
    }
});

for (const [label, point, before] of [
    ['after annotated object', '/git/tags', false], ['after tag ref', '/git/refs', false],
    ['after Release', '/releases', false], ['before branch delete', '/git/refs/heads/release/v1.0.2', true]
]) {
    test(`manual rerun resumes ${label} without duplicate ref or Release`, async () => {
        const state = fixture();
        state[before ? 'failBefore' : 'failAfter'] = point;
        await assert.rejects(state.run(), /通信に失敗/);
        assert.equal(state.writes.filter(value => value.route === prefix + point).length, 1, 'no blind retry');
        await state.run();
        assert.equal(state.latest.id, 123);
        assert.equal(state.branch, null);
        assert.equal(state.writes.filter(value => value.route === prefix + '/git/refs').length, 1);
        assert.equal(state.writes.filter(value => value.route === prefix + '/releases').length, 1);
    });
}

test('non-release push is ignored without writes', async () => {
    const state = fixture(); state.associated = [];
    assert.deepEqual(await state.run(), { state: 'ignored' });
    assert.equal(state.writes.length, 0);
});

test('dispatch recovers older merged commit while main has advanced', async () => {
    const state = fixture(); state.main = sha('f'); state.comparison = 'ahead';
    await state.run({ GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_SHA: sha('f'), RELEASE_VERSION: '1.0.2' });
    assert.ok(state.calls.some(value => value.route.includes('head=LGUG-jp%3Arelease%2Fv1.0.2')));
    assert.equal(state.annotated.object.sha, mergedSha);
});

test('create-only ref conflict rereads and validates the existing tag', async () => {
    const state = fixture(); state.conflict = true;
    await state.run();
    assert.equal(state.writes.filter(value => value.route.endsWith('/git/refs')).length, 1);
});

const invalid = [
    ['title', state => { state.pr.title += '!'; }],
    ['body', state => { state.pr.body += '\n'; }],
    ['foreign head repository', state => { state.pr.head.repo.id = 99; }],
    ['foreign base repository', state => { state.pr.base.repo.id = 99; }],
    ['multi-parent merge', state => { state.merged.parents.push({ sha: sha('f') }); }],
    ['tree mismatch', state => { state.merged.tree.sha = sha('f'); }],
    ['foreign author', state => { state.head.author.name = 'Other'; }],
    ['foreign committer', state => { state.head.committer.email = 'other@example.test'; }],
    ['different dates', state => { state.head.committer.date = '2026-10-21T00:00:00Z'; }],
    ['head message', state => { state.head.message += '\n'; }],
    ['head has multiple parents', state => { state.head.parents.push({ sha: sha('f') }); }],
    ['version mismatch', state => { state.version = "<?php const NETARIUM_VERSION = '1.0.3';"; }],
    ['missing changelog heading', state => { state.changelog = '## 1.0.3\n'; }],
    ['closed unmerged', state => { state.pr.merged = false; }],
    ['wrong push SHA', state => { state.pr.merge_commit_sha = sha('f'); }],
    ['not an ancestor', state => { state.comparison = 'diverged'; }],
    ['ambiguous PR', state => { state.associated.push(structuredClone(state.pr)); }],
    ['branch changed', state => { state.branch = sha('f'); }],
    ['lightweight tag', state => { state.ref = { object: { type: 'commit', sha: mergedSha } }; }],
    ['foreign annotated tag', state => { state.ref = { object: { type: 'tag', sha: tagSha } }; state.annotated = { tag: 'v1.0.2', message: 'foreign', tagger: identity, object: { type: 'commit', sha: mergedSha } }; }],
    ['foreign Release', state => { state.release = { id: 123, tag_name: 'v1.0.2', body: 'foreign' }; }],
    ['newer stable Release on later page', state => { state.otherReleases = [...Array.from({ length: 100 }, () => ({ draft: true })), { draft: false, prerelease: false, tag_name: 'v1.0.10' }]; }]
];
for (const [label, mutate] of invalid) {
    test(`rejects ${label} before writes`, async () => {
        const state = fixture(); mutate(state);
        await assert.rejects(state.run());
        assert.equal(state.writes.length, 0);
    });
}

for (const overrides of [
    { GITHUB_REPOSITORY: 'other/project' }, { GITHUB_REF: 'refs/heads/other' },
    { GITHUB_EVENT_NAME: 'workflow_dispatch' }, { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/feature/unreviewed', RELEASE_VERSION: '1.0.2' },
    { GITHUB_EVENT_NAME: 'workflow_dispatch', RELEASE_VERSION: '01.0.2' }
]) {
    test(`rejects invalid execution ${JSON.stringify(overrides)}`, async () => {
        const state = fixture(); await assert.rejects(state.run(overrides)); assert.equal(state.writes.length, 0);
    });
}

for (const status of [403, 429]) {
    test(`HTTP ${status} denial does not leak token or response`, async () => {
        const state = fixture(); state.deny = status;
        await assert.rejects(state.run({ GH_TOKEN: 'secret-token-must-not-appear' }), error => {
            assert.match(error.message, new RegExp(`HTTP ${status}`));
            assert.doesNotMatch(error.message, /secret/);
            return true;
        });
        assert.equal(state.calls.length, 1);
        assert.equal(state.writes.length, 0);
    });
}

test('existing exact Release can recover Latest without recreating objects', async () => {
    const state = fixture(); await state.run();
    const start = state.writes.length;
    state.latest = null;
    await state.run();
    assert.deepEqual(state.writes.slice(start).map(value => value.method), ['PATCH']);
});

test('transport is fixed-host, redirect-error and sanitizes fetch failures', async t => {
    const original = globalThis.fetch;
    t.after(() => { globalThis.fetch = original; });
    globalThis.fetch = async (url, options) => {
        assert.equal(url, 'https://api.github.com' + prefix);
        assert.equal(options.redirect, 'error');
        throw new Error('secret-token-must-not-appear');
    };
    await assert.rejects(githubTransport('secret-token-must-not-appear')('GET', prefix), error => !error.message.includes('secret'));
    await assert.rejects(githubTransport('secret')('GET', 'https://example.test'), /不正なAPI/);
});

for (const [label, mutate] of [
    ['tag target', state => { state.annotated.object.sha = sha('f'); }],
    ['tag name', state => { state.annotated.tag = 'v1.0.3'; }],
    ['tag identity', state => { state.annotated.tagger.name = 'Other'; }],
    ['tag date', state => { state.annotated.tagger.date = '2026-10-21T00:00:00Z'; }],
    ['Release assets', state => { state.release.assets.push({ id: 1 }); }],
    ['Release name', state => { state.release.name = 'Other'; }],
    ['Release body', state => { state.release.body += '\n'; }],
    ['Release target', state => { state.release.target_commitish = 'main'; }],
    ['Release draft', state => { state.release.draft = true; }],
    ['Release prerelease', state => { state.release.prerelease = true; }],
    ['Release zipball', state => { state.release.zipball_url = 'https://example.test/download'; }],
    ['Release tarball', state => { state.release.tarball_url = 'https://example.test/download'; }]
]) {
    test(`existing ${label} mismatch is rejected without writes`, async () => {
        const state = fixture();
        await state.run();
        state.writes.length = 0;
        mutate(state);
        await assert.rejects(state.run());
        assert.equal(state.writes.length, 0);
    });
}

test('newer stable Release forbids even completed older recovery and preserves Latest', async () => {
    const state = fixture();
    await state.run();
    const newer = { id: 456, tag_name: 'v2.0.0', draft: false, prerelease: false };
    state.otherReleases.push(newer);
    state.latest = newer;
    state.writes.length = 0;
    await assert.rejects(state.run(), /新しい正式Release/);
    assert.equal(state.writes.length, 0);
    assert.equal(state.latest.id, 456);
});

test('newer draft and prerelease do not block a stable release', async () => {
    const state = fixture();
    state.otherReleases = [
        { tag_name: 'v2.0.0', draft: true, prerelease: false },
        { tag_name: 'v3.0.0', draft: false, prerelease: true }
    ];
    assert.equal((await state.run()).state, 'complete');
});

test('version file cannot masquerade as a declaration inside executable PHP or a string', async () => {
    const state = fixture();
    state.version = `<?php $value = "const NETARIUM_VERSION = '1.0.2';";`;
    await assert.rejects(state.run(), /version.php/);
    assert.equal(state.writes.length, 0);
});

test('legacy Netarium Release head commit is accepted for backward-compatible finalization', async () => {
    const state = fixture();
    state.head.author = { ...legacyIdentity };
    state.head.committer = { ...legacyIdentity };
    assert.equal((await state.run()).state, 'complete');
    // Newly generated tag uses the Bot identity even if the PR head was created by legacy identity.
    assert.deepEqual(state.annotated.tagger, identity);
});

test('legacy annotated tag identity is accepted during rerun validation', async () => {
    const state = fixture();
    await state.run();
    state.annotated.tagger = { ...legacyIdentity };
    const writes = state.writes.length;
    await state.run();
    assert.equal(state.writes.length, writes);
});

test('mismatched author and committer identities are rejected', async () => {
    const state = fixture();
    state.head.author = { ...identity };
    state.head.committer = { ...legacyIdentity };
    await assert.rejects(state.run(), /release head commitの内容・署名者が一致しません/);
    assert.equal(state.writes.length, 0);
});
