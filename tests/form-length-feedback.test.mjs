import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installWorkspaceDom } from './helpers/workspace-dom.mjs';
import { updateLengthFeedback } from '../public/js/ui/length-feedback.js';

test('単一行の超過入力を保持して理由を示し、修正するとエラーだけ解除する', () => {
    const globals = ['document', 'window', 'Element', 'HTMLElement'];
    const originals = new Map(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    try {
        const dom = installWorkspaceDom();
        const input = dom.add('input', 'name');
        input.dataset.maxLength = '100';
        input.setAttribute('aria-describedby', 'name-help');
        const error = dom.add('p', 'name-error');
        input.value = '😀'.repeat(101);
        assert.equal(updateLengthFeedback(input), false);
        assert.equal(input.value, '😀'.repeat(101));
        assert.equal(error.hidden, false);
        assert.match(error.textContent, /100文字以内/);
        assert.equal(input.getAttribute('aria-invalid'), 'true');
        assert.equal(input.getAttribute('aria-describedby'), 'name-help name-error');
        input.value = '😀'.repeat(100);
        assert.equal(updateLengthFeedback(input), true);
        assert.equal(error.hidden, true);
        assert.equal(input.getAttribute('aria-invalid'), null);
        assert.equal(input.getAttribute('aria-describedby'), 'name-help');
        // 上限とは別の形式エラーを、有効な長さだけで消さない。
        input.setAttribute('aria-invalid', 'true');
        error.textContent = '形式が不正です';
        error.hidden = false;
        updateLengthFeedback(input);
        assert.equal(error.textContent, '形式が不正です');
        assert.equal(input.getAttribute('aria-invalid'), 'true');
    } finally {
        for (const [key, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    }
});

test('長文カウンタもコードポイントで数え、空白を含む原文を保持する', () => {
    const globals = ['document', 'window', 'Element', 'HTMLElement'];
    const originals = new Map(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    try {
        const dom = installWorkspaceDom();
        const input = dom.add('textarea', 'memo');
        input.dataset.maxLength = '1000';
        dom.add('p', 'memo-error');
        const counter = dom.add('div', 'memo-count');
        input.value = ' 😀' + '😀'.repeat(999) + ' ';
        assert.equal(updateLengthFeedback(input), true);
        assert.equal(counter.textContent, '1002/1000');
        input.value = '😀'.repeat(1001);
        assert.equal(updateLengthFeedback(input), false);
        assert.equal(counter.textContent, '1001/1000');
        assert.equal(counter.classList.contains('is-over-limit'), true);
        assert.equal(input.value, '😀'.repeat(1001));
    } finally {
        for (const [key, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    }
});
