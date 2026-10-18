import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apiFetch } from '../public/js/core/api-client.js';
import { appState } from '../public/js/core/state.js';

function installClient(t, fetch) {
    const globals = new Map(['window', 'document', 'fetch'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const authExpired = appState.authExpired;
    globalThis.window = { location: { href: 'https://netarium.test/app/' }, APP_CONFIG: { csrfToken: 'test-csrf', capacity: { imageUploadMaxRequestBytes: 31 * 1024 * 1024 } } };
    globalThis.document = { getElementById: () => null };
    globalThis.fetch = fetch;
    t.after(() => {
        appState.authExpired = authExpired;
        for (const [key, descriptor] of globals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    });
}


test('画像入口のIIS 404.13と413を容量エラーとして案内する', async t => {
    let response;
    installClient(t, async () => response);
    const { readFileSync } = await import('node:fs');
    const errorPageHtml = readFileSync('public/error-404-13.html', 'utf8');
    for (const body of ['<html>HTTP Error 404.13 - CONTENT_LENGTH_TOO_LARGE</html>', errorPageHtml]) {
        for (const status of [404, 413]) {
            response = new Response(body, { status });
            await assert.rejects(apiFetch('upload_device_image', { method: 'POST' }), error => {
                assert.equal(error.status, 413);
                assert.match(error.message, /31MiB/);
                return true;
            });
        }
    }
    response = new Response(JSON.stringify({ ok: false, error: '送信容量が上限を超えています' }), { status: 413 });
    await assert.rejects(apiFetch('upload_floor_plan', { method: 'POST' }), /送信容量が上限を超えています/);
});

test('一般APIの非JSON・JSONエラーと画像入口の認証失効を維持する', async t => {
    let response;
    installClient(t, async () => response);
    response = new Response('<html>HTTP Error 404.13</html>', { status: 404 });
    await assert.rejects(apiFetch('save', { method: 'POST' }), error => error.status === 404 && /JSONではありません/.test(error.message));
    response = new Response('<br>Warning: POST Content-Length of 9437184 bytes exceeds the limit of 8388608 bytes<br>', { status: 200 });
    await assert.rejects(apiFetch('upload_floor_plan', { method: 'POST' }), error => error.status === 413 && /PHP.*post_max_size/.test(error.message));
    response = new Response('Not Found', { status: 404 });
    await assert.rejects(apiFetch('upload_device_image', { method: 'POST' }), error => error.status === 404 && /JSONではありません/.test(error.message));
    response = new Response(JSON.stringify({ ok: false, error: 'revision conflict', details: { revision: 3 } }), { status: 409 });
    await assert.rejects(apiFetch('save', { method: 'POST' }), error => error.status === 409 && error.details.revision === 3 && error.message === 'revision conflict');
    response = new Response(JSON.stringify({ ok: false, login_required: true }), { status: 401 });
    await assert.rejects(apiFetch('upload_floor_plan', { method: 'POST' }), error => error.status === 401);
    assert.equal(appState.authExpired, true);
});

test('専用拒否は5キー・version・元PHP応答URL・非redirect・JSON型を厳密に識別する', async t => {
    let response;
    installClient(t, async () => response);
    const contract = { ok: false, error_code: 'NETARIUM_MAINTENANCE_REJECTED', contract_version: 1,
        request_execution: 'not_started', operation_id: 'operation-246' };
    const reply = (body = contract, { status = 404, contentType = 'application/json; charset=utf-8',
        url = 'https://netarium.test/app/api.php?action=save_resources', redirected = false } = {}) => {
        const res = new Response(typeof body === 'string' ? body : JSON.stringify(body), {
            status, headers: { 'Content-Type': contentType }
        });
        Object.defineProperties(res, { url: { value: url }, redirected: { value: redirected } });
        return res;
    };
    for (const action of ['save_resources', 'update_floor_plan_settings', 'upload_floor_plan', 'upload_device_image']) {
        const entry = action.startsWith('upload_') ? 'image_upload.php' : 'api.php';
        response = reply(contract, { url: `https://netarium.test/app/${entry}?action=${action}` });
        await assert.rejects(apiFetch(action, { method: 'POST' }), error => {
            assert.equal(error.maintenanceRejected, true);
            assert.equal(error.operationId, 'operation-246');
            assert.equal(error.requestNotSent, undefined);
            return true;
        });
    }
    const incomplete = { ...contract };
    delete incomplete.request_execution;
    for (const invalid of [
        () => reply({ ...contract, contract_version: 2 }),
        () => reply({ ...contract, contract_version: '1' }),
        () => reply({ ...contract, extra: true }),
        () => reply(incomplete),
        () => reply({ ...contract, operation_id: '' }),
        () => reply({ ...contract, operation_id: 'secret/token' }),
        () => reply({ ...contract, operation_id: 'a'.repeat(129) }),
        () => reply({ ...contract, ok: 0 }),
        () => reply({ ...contract, request_execution: 'unknown' }),
        () => reply({ ok: false, error: 'Not found' }),
        () => reply('{broken'),
        () => reply(contract, { status: 503 }),
        () => reply(contract, { status: 413 }),
        () => reply(contract, { contentType: 'text/html' }),
        () => reply(contract, { redirected: true }),
        () => reply(contract, { url: 'https://netarium.test/app/maintenance.json' }),
        () => reply(contract, { url: 'https://elsewhere.test/app/api.php?action=save_resources' }),
        () => reply(contract, { url: 'https://netarium.test/app/api.php?action=load' })
    ]) {
        response = invalid();
        await assert.rejects(apiFetch('save_resources', { method: 'POST' }), error => {
            assert.notEqual(error.maintenanceRejected, true);
            assert.equal(error.requestNotSent, undefined);
            return true;
        });
    }
    globalThis.fetch = async () => { throw new Error('network lost'); };
    await assert.rejects(apiFetch('save_resources', { method: 'POST' }),
        error => error.maintenanceRejected === undefined && error.requestNotSent === undefined);
});
