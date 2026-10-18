import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { installWorkspaceDom } from './helpers/workspace-dom.mjs';

function setup(t, page) {
    const keys = ['window', 'document', 'HTMLElement', 'Element'];
    const globals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const dom = installWorkspaceDom();
    const source = readFileSync(new URL(`../public/${page}.php`, import.meta.url), 'utf8');
    const form = source.match(/<form\b[\s\S]*?<\/form>/)[0].replace(/<\?[\s\S]*?\?>/g, '');
    document.body.innerHTML = form;
    t.after(() => {
        for (const [key, descriptor] of globals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    });
    return dom;
}

const tooShort = 'パスワードは12文字以上で入力してください';
const tooManyCharacters = 'パスワードは128文字以内で入力してください';
const tooManyBytes = 'パスワードは512バイト以内で入力してください';
const invalidUnicode = 'パスワードに使用できない文字が含まれています';
const passwordCases = [
    ['空値', '', tooShort],
    ['ASCII 11文字', 'a'.repeat(11), tooShort],
    ['ASCII 12文字', 'a'.repeat(12), ''],
    ['ASCII 13文字', 'a'.repeat(13), ''],
    ['日本語11文字', 'あ'.repeat(11), tooShort],
    ['日本語12文字', 'あ'.repeat(12), ''],
    ['絵文字11コードポイント', '😀'.repeat(11), tooShort],
    ['絵文字12コードポイント', '😀'.repeat(12), ''],
    ['絵文字128コードポイント・512バイト', '😀'.repeat(128), ''],
    ['絵文字513バイトはコードポイント上限より優先', '😀'.repeat(128) + 'a', tooManyBytes],
    ['絵文字129コードポイント・516バイト', '😀'.repeat(129), tooManyBytes],
    ['結合文字11コードポイント', 'e\u0301'.repeat(5) + 'e', tooShort],
    ['結合文字12コードポイント', 'e\u0301'.repeat(6), ''],
    ['複合絵文字14コードポイント', '👨‍👩‍👧‍👦'.repeat(2), ''],
    ['ASCII 128コードポイント', 'a'.repeat(128), ''],
    ['ASCII 129コードポイント', 'a'.repeat(129), tooManyCharacters],
    ['日本語128コードポイント', 'あ'.repeat(128), ''],
    ['日本語129コードポイント・387バイト', 'あ'.repeat(129), tooManyCharacters],
    ['結合文字128コードポイント', 'e\u0301'.repeat(64), ''],
    ['結合文字129コードポイント', 'e\u0301'.repeat(64) + 'e', tooManyCharacters],
    ['空白のみ', ' '.repeat(12), ''],
    ['前後空白', '  あいうえおかきくけこ  ', ''],
    ['記号のみ', '!'.repeat(12), ''],
    ['NUL', 'a'.repeat(12) + '\0', invalidUnicode],
    ['NULは両上限より優先', '😀'.repeat(128) + '\0', invalidUnicode],
    ['NULは下限より優先', '\0', invalidUnicode],
    ['孤立high surrogate', 'a'.repeat(12) + '\uD800', invalidUnicode],
    ['孤立low surrogate', 'a'.repeat(12) + '\uDC00', invalidUnicode],
    ['孤立surrogateは両上限より優先', '😀'.repeat(128) + '\uD800', invalidUnicode],
    ['孤立surrogateは下限より優先', '\uDC00', invalidUnicode]
];

for (const [label, value, error] of passwordCases) {
    test(`setup: ${label}の送信判定と入力保持`, async t => {
        const dom = setup(t, 'setup');
        const { initializeAuthForms } = await import('../public/js/ui/auth-forms.js');
        initializeAuthForms();
        const form = document.querySelector('form');
        const password = dom.get('setup-password');
        const confirmation = dom.get('setup-password-confirm');
        dom.get('setup-username').value = 'valid-user';
        password.value = value;
        confirmation.value = value;
        await form.dispatch('input', { target: password });
        assert.equal(dom.get('setup-password-error').hidden, !error || value === '');
        let prevented = false;
        await form.dispatch('submit', { preventDefault() { prevented = true; } });
        assert.equal(prevented, Boolean(error));
        assert.equal(dom.get('setup-password-error').textContent, error ? `! ${error}` : '');
        assert.equal(dom.get('setup-password-error').hidden, !error);
        assert.equal(password.value, value);
        assert.equal(confirmation.value, value);
        if (error) assert.equal(document.activeElement, password);
    });
}

test('setup: 先頭不正項目へフォーカスし、確認不一致を保持する', async t => {
    const dom = setup(t, 'setup');
    const { initializeAuthForms } = await import('../public/js/ui/auth-forms.js');
    initializeAuthForms();
    const form = document.querySelector('form');
    const username = dom.get('setup-username');
    const password = dom.get('setup-password');
    const confirmation = dom.get('setup-password-confirm');
    username.value = 'u'.repeat(51);
    password.value = 'p'.repeat(129);
    confirmation.value = password.value;
    let prevented = false;
    await form.dispatch('submit', { preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(document.activeElement, username);
    assert.equal(password.value, 'p'.repeat(129));
    username.value = 'valid-user';
    password.value = 'あ'.repeat(12);
    confirmation.value = 'different-password';
    await form.dispatch('submit', { preventDefault() {} });
    assert.equal(document.activeElement, confirmation);
    assert.match(dom.get('setup-password-confirm-error').textContent, /一致/);
    assert.equal(confirmation.value, 'different-password');
    confirmation.value = password.value;
    await form.dispatch('input', { target: confirmation });
    assert.equal(dom.get('setup-password-confirm-error').hidden, true);
});

test('setup: 確認欄も不正Unicode・バイト数・文字数・下限の順に判定し、一致エラーより優先する', async t => {
    const dom = setup(t, 'setup');
    const { initializeAuthForms } = await import('../public/js/ui/auth-forms.js');
    initializeAuthForms();
    const form = document.querySelector('form');
    const password = dom.get('setup-password');
    const confirmation = dom.get('setup-password-confirm');
    dom.get('setup-username').value = 'valid-user';
    password.value = 'valid-password';
    for (const [value, error] of [
        ['😀'.repeat(128) + '\uD800', invalidUnicode],
        ['😀'.repeat(128) + 'a', tooManyBytes],
        ['a'.repeat(129), tooManyCharacters],
        ['short', tooShort],
        ['different-password', '確認用パスワードが一致しません']
    ]) {
        confirmation.value = value;
        let prevented = false;
        await form.dispatch('submit', { preventDefault() { prevented = true; } });
        assert.equal(prevented, true);
        assert.equal(document.activeElement, confirmation);
        assert.equal(dom.get('setup-password-confirm-error').textContent, `! ${error}`);
        assert.equal(password.value, 'valid-password');
        assert.equal(confirmation.value, value);
    }
});

test('login: 既存照合は新規ポリシーも旧200文字上限も適用せず、空値のみ必須エラー', async t => {
    const dom = setup(t, 'login');
    const { initializeAuthForms } = await import('../public/js/ui/auth-forms.js');
    initializeAuthForms();
    const form = document.querySelector('form');
    const password = dom.get('login-password');
    dom.get('login-username').value = 'valid-user';
    for (const value of ['short', 'あ'.repeat(201), 'p'.repeat(513), '😀'.repeat(128) + 'a', '\0', '\uD800']) {
        password.value = value;
        await form.dispatch('input', { target: password });
        let prevented = false;
        await form.dispatch('submit', { preventDefault() { prevented = true; } });
        assert.equal(prevented, false);
        assert.equal(dom.get('login-password-error').hidden, true);
        assert.equal(password.value, value);
    }
    password.value = '';
    let prevented = false;
    await form.dispatch('submit', { preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(dom.get('login-password-error').textContent, '! 入力してください');
    assert.equal(document.activeElement, password);
});
