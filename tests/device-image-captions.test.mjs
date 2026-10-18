import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installWorkspaceDom } from './helpers/workspace-dom.mjs';
import { appState } from '../public/js/core/state.js';

test('画像説明は超過入力と再描画の下書きを保持し、100 codepointへの修正後だけ送信する', async t => {
    const globals = new Map(['window', 'document', 'fetch', 'Element', 'HTMLElement'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const state = new Map(['authExpired', 'isPinging', 'deviceImages'].map(key => [key, Object.getOwnPropertyDescriptor(appState, key)]));
    installWorkspaceDom();
    Object.assign(appState, { authExpired: false, isPinging: false, deviceImages: [] });
    t.after(() => {
        for (const [key, descriptor] of state) {
            if (descriptor) Object.defineProperty(appState, key, descriptor); else delete appState[key];
        }
        for (const [key, descriptor] of globals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
        }
    });
    const { bindDeviceImageCaptionInput, updateImageCaption } = await import('../public/js/ui/device-images.js');
    const saves = [];
    const make = () => {
        const input = document.createElement('input');
        input.value = '保存済み';
        const error = bindDeviceImageCaptionInput(input, {
            deviceId: 810, imageId: 920, errorId: 'test-caption-error', onSave: value => saves.push(value)
        });
        return { input, error };
    };
    let { input, error } = make();
    input.value = '😀'.repeat(101);
    await input.dispatch('input');
    await input.dispatch('change');
    assert.equal(input.value, '😀'.repeat(101));
    assert.equal(input.getAttribute('aria-invalid'), 'true');
    assert.match(error.textContent, /100文字以内/);
    assert.equal(saves.length, 0);
    ({ input, error } = make());
    assert.equal(input.value, '😀'.repeat(101));
    assert.equal(error.hidden, false);
    input.value = '😀'.repeat(100);
    await input.dispatch('input');
    await input.dispatch('change');
    assert.equal(input.getAttribute('aria-invalid'), null);
    assert.equal(error.hidden, true);
    assert.deepEqual(saves, ['😀'.repeat(100)]);
    let requests = 0;
    globalThis.fetch = () => { requests++; throw new Error('超過説明は送信してはいけません'); };
    assert.equal(await updateImageCaption(810, 920, '😀'.repeat(101)), false);
    assert.equal(requests, 0);
});
