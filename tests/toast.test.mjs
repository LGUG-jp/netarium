import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as notifications from '../public/js/ui/toast.js';
import { handleAuthExpired } from '../public/js/core/api-client.js';
import { appState } from '../public/js/core/state.js';

function installDom(t) {
    const previous = new Map(['window', 'document'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const elements = new Map();
    const timers = new Map();
    let now = 0;
    let nextId = 0;
    const add = id => {
        const attributes = new Map();
        const element = { id, hidden: true, textContent: '', title: '', className: '', disabled: false,
            setAttribute: (key, value) => attributes.set(key, String(value)),
            getAttribute: key => attributes.get(key) ?? null,
            classList: { add: name => { element.className += ` ${name}`; } } };
        if (id) elements.set(id, element);
        return element;
    };
    globalThis.document = {
        getElementById: id => elements.get(id) ?? null,
        createElement: () => add(null),
        body: { appendChild: element => elements.set(element.id, element) }
    };
    globalThis.window = {
        setTimeout: (fn, delay) => { const id = ++nextId; timers.set(id, { fn, at: now + delay }); return id; },
        clearTimeout: id => timers.delete(id)
    };
    const advance = duration => {
        now += duration;
        for (const [id, timer] of timers) {
            if (timer.at <= now) { timers.delete(id); timer.fn(); }
        }
    };
    t.after(() => {
        appState.authExpired = false;
        for (const [key, descriptor] of previous) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    });
    return { add, advance, elements };
}

test('軽量通知は置換から3秒後に消え、保存状態を変更しない', t => {
    const { add, advance, elements } = installDom(t);
    const status = add('status-toast-message');
    const save = add('status-save-state'); save.textContent = '保存中';
    notifications.showStatusMessage('CSVのダウンロードを開始しました', 'info');
    assert.equal(status.textContent, 'CSVのダウンロードを開始しました');
    assert.equal(status.title, status.textContent);
    assert.equal(elements.has('toast'), false);
    advance(2000);
    notifications.showStatusMessage('バックアップを出力しました', 'success');
    advance(1000);
    assert.equal(status.textContent, 'バックアップを出力しました');
    advance(2000);
    assert.equal(status.textContent, '');
    assert.equal(status.title, '');
    assert.equal(save.textContent, '保存中');
});

test('警告とエラーはステータスへ重複せず、置換後の表示時間と読み上げを維持する', t => {
    const { add, advance, elements } = installDom(t);
    const status = add('status-toast-message');
    notifications.showToast('同一機器同士はリンクできません', 'warning');
    const toast = elements.get('toast');
    assert.equal(toast.hidden, false);
    assert.equal(toast.textContent, '! 同一機器同士はリンクできません');
    assert.equal(toast.getAttribute('aria-live'), 'polite');
    assert.equal(status.textContent, '');
    advance(4000);
    assert.equal(toast.hidden, false);
    notifications.showToast('保存に失敗しました', 'error');
    advance(1000);
    assert.equal(toast.hidden, false);
    assert.equal(toast.textContent, '! 保存に失敗しました');
    assert.equal(toast.getAttribute('aria-live'), 'assertive');
    advance(5000);
    assert.equal(toast.hidden, true);
    assert.equal(status.textContent, '');
});

test('同じ文言を別領域へ出し直しても二重表示せず、空文言で消去できる', t => {
    const { add, elements, advance } = installDom(t);
    const status = add('status-toast-message');
    notifications.showStatusMessage('処理結果を確認してください');
    notifications.showToast('処理結果を確認してください', 'warning');
    assert.equal(status.textContent, '');
    notifications.showStatusMessage('処理結果を確認してください');
    assert.equal(elements.get('toast').hidden, true);
    notifications.showStatusMessage('  ');
    assert.equal(status.textContent, '');
    assert.equal(status.title, '');
    notifications.showToast('別の警告', 'warning');
    notifications.showToast('  ');
    advance(6000);
    assert.equal(elements.get('toast').hidden, true);
});

test('認証失効は永続バナーと保存禁止に残し、繰り返し一時通知しない', t => {
    const { add, elements } = installDom(t);
    const banner = add('status-auth-expired-banner');
    const save = add('saveBtn');
    appState.authExpired = false;
    handleAuthExpired();
    handleAuthExpired();
    assert.equal(appState.authExpired, true);
    assert.equal(banner.hidden, false);
    assert.equal(save.disabled, true);
    assert.equal(elements.has('toast'), false);
});
