import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appState } from '../public/js/core/state.js';

function installDom(t) {
    const globals = new Map(['window', 'document', 'HTMLElement'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const elements = new Map();
    const cleanup = [];
    class Element {
        constructor(tag = 'div') {
            this.tagName = tag.toUpperCase();
            this.children = []; this.attributes = new Map(); this.style = {}; this.dataset = {};
            this.hidden = false; this.disabled = false; this.className = ''; this.value = '';
            this.classList = {
                contains: name => this.className.split(' ').includes(name),
                add: name => { if (!this.classList.contains(name)) this.className += ` ${name}`; },
                remove: name => { this.className = this.className.split(' ').filter(value => value !== name).join(' '); },
                toggle: (name, force) => { if (force) this.classList.add(name); else this.classList.remove(name); }
            };
        }
        set id(value) { this._id = value; elements.set(value, this); }
        get id() { return this._id; }
        setAttribute(name, value) { this.attributes.set(name, String(value)); }
        getAttribute(name) { return this.attributes.get(name) ?? null; }
        removeAttribute(name) { this.attributes.delete(name); }
        appendChild(child) { child.parentElement = this; this.children.push(child); }
        replaceChildren(...children) { this.children = []; children.forEach(child => this.appendChild(child)); }
        contains(element) { return this === element || this.children.some(child => child.contains(element)); }
        closest(selector) {
            if (selector === '[hidden]' && this.hidden) return this;
            if (selector === '.admin-only' && this.classList.contains('admin-only')) return this;
            return this.parentElement?.closest(selector) || null;
        }
        querySelectorAll(selector) {
            const matches = [];
            for (const child of this.children) {
                if ((selector === '[role="dialog"]' && child.getAttribute('role') === 'dialog')
                    || (selector === 'button' && child.tagName === 'BUTTON')
                    || (selector === '.admin-only' && child.classList.contains('admin-only'))) matches.push(child);
                matches.push(...child.querySelectorAll(selector));
            }
            return matches;
        }
        querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
        addEventListener() {}
        focus() { document.activeElement = this; }
    }
    globalThis.HTMLElement = Element;
    const body = new Element();
    globalThis.document = {
        body, activeElement: body, addEventListener() {},
        getElementById: id => elements.get(id) || null,
        createElement: tag => new Element(tag),
        querySelector: selector => body.querySelector(selector),
        querySelectorAll: selector => body.querySelectorAll(selector)
    };
    globalThis.window = {
        APP_CONFIG: { user: { isAdmin: true } }, clearTimeout, setTimeout,
        requestAnimationFrame: fn => fn(), addEventListener() {},
        getComputedStyle: element => ({ display: element.hidden ? 'none' : 'block', visibility: 'visible' })
    };
    const add = (id, tag = 'div', parent = body) => {
        const element = new Element(tag); element.id = id; parent.appendChild(element); return element;
    };
    t.after(async () => {
        for (const callback of cleanup) callback();
        const { showToast } = await import('../public/js/ui/toast.js');
        clearTimeout(showToast._timer);
        for (const [key, descriptor] of globals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
        }
    });
    return { add, cleanup };
}


test('拡大画像は機器内の表示順で前後へ切り替え、端と1枚だけの場合を区別する', async t => {
    const { add, cleanup } = installDom(t);
    const opener = add('image-opener', 'button'); opener.focus();
    const overlay = add('device-image-zoom-overlay'); overlay.hidden = true;
    const dialog = add('image-dialog', 'div', overlay); dialog.setAttribute('role', 'dialog');
    add('image-close', 'button', dialog);
    const image = add('device-image-zoom-img', 'img', dialog);
    add('device-image-zoom-caption', 'h3', dialog);
    const previous = add('device-image-zoom-previous', 'button', dialog);
    const next = add('device-image-zoom-next', 'button', dialog);
    const position = add('device-image-zoom-position', 'span', dialog);
    appState.deviceImages = [
        { id: 22, device_id: 1, sort_order: 2, image_url: '/second', caption: '2枚目' },
        { id: 99, device_id: 2, sort_order: 1, image_url: '/other' },
        { id: 33, device_id: 1, sort_order: 3, image_url: '/third' },
        { id: 11, device_id: 1, sort_order: 1, image_url: '/first' }
    ];
    const { openDeviceImageZoom, changeDeviceImageZoom, closeDeviceImageZoom } = await import('../public/js/ui/device-images.js');
    cleanup.push(closeDeviceImageZoom);
    openDeviceImageZoom(appState.deviceImages[0]);
    assert.equal(image.src, '/second');
    assert.equal(position.textContent, '2/3枚');
    assert.equal(previous.disabled, false); assert.equal(next.disabled, false);
    changeDeviceImageZoom(-1);
    assert.equal(image.src, '/first'); assert.equal(previous.disabled, true);
    changeDeviceImageZoom(-1);
    assert.equal(image.src, '/first');
    changeDeviceImageZoom(1); changeDeviceImageZoom(1);
    assert.equal(image.src, '/third'); assert.equal(next.disabled, true);
    changeDeviceImageZoom(1);
    assert.equal(image.src, '/third');
    closeDeviceImageZoom();
    assert.equal(document.activeElement, opener);
    openDeviceImageZoom(appState.deviceImages[1]);
    assert.equal(image.src, '/other'); assert.equal(position.textContent, '1/1枚');
    assert.equal(previous.disabled, true); assert.equal(next.disabled, true);
});
