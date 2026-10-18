import { appendPhpTemplates } from './workspace-dom.mjs';

/** 実PHPテンプレートから要素・属性を読み込むDOM代替。CSS描画・実画像読込は対象外。 */
export function installPrintDom({ main = false, templates = [] } = {}) {
    const keys = ['window', 'document', 'HTMLElement', 'fetch', 'confirm'];
    const globals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const elements = new Map();
    let printCalls = 0;
    let decodeImage = () => Promise.resolve();
    class Element {
        constructor(tag = 'div') {
            this.tagName = tag.toUpperCase(); this.children = []; this.attributes = new Map();
            this.style = {}; this.dataset = {}; this.listeners = new Map(); this.hidden = false;
            this.disabled = false; this.checked = false; this.className = ''; this.value = ''; this.textContent = '';
            this.classList = {
                contains: value => this.className.split(/\s+/).includes(value),
                add: (...values) => { for (const value of values) if (!this.classList.contains(value)) this.className += ` ${value}`; },
                remove: (...values) => { this.className = this.className.split(/\s+/).filter(value => !values.includes(value)).join(' '); },
                toggle: (value, force) => {
                    const add = force ?? !this.classList.contains(value);
                    this.classList[add ? 'add' : 'remove'](value); return add;
                }
            };
        }
        set id(value) { this._id = value; elements.set(value, this); }
        get id() { return this._id || ''; }
        setAttribute(key, value) {
            value = String(value); this.attributes.set(key, value);
            if (key === 'id') this.id = value;
            else if (key === 'class') this.className = value;
            else if (['type', 'name', 'value'].includes(key)) this[key] = value;
            else if (['hidden', 'checked', 'disabled'].includes(key)) this[key] = true;
        }
        getAttribute(key) { return this.attributes.get(key) ?? null; }
        removeAttribute(key) { this.attributes.delete(key); }
        appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
        append(...children) { children.forEach(child => this.appendChild(child)); }
        replaceChildren(...children) { this.children = []; this.append(...children); }
        remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); }
        contains(value) { return this === value || this.children.some(child => child.contains(value)); }
        closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
        matches(selector) {
            if (selector.startsWith('#')) return this.id === selector.slice(1);
            if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
            if (selector === '[hidden]') return this.hidden;
            if (selector === '[role="dialog"]') return this.getAttribute('role') === 'dialog';
            const inputName = /^input\[name="([^"]+)"\](:checked)?$/.exec(selector);
            if (inputName) return this.tagName === 'INPUT' && this.name === inputName[1] && (!inputName[2] || this.checked);
            if (selector.includes(':not([disabled])')) return !this.disabled && ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(this.tagName);
            if (selector === '[tabindex]:not([tabindex="-1"])') return this.attributes.has('tabindex') && this.getAttribute('tabindex') !== '-1';
            return this.tagName === selector.toUpperCase();
        }
        querySelectorAll(selector) {
            const selectors = selector.split(',').map(value => value.trim());
            const found = [];
            for (const child of this.children) {
                if (selectors.some(value => child.matches(value))) found.push(child);
                found.push(...child.querySelectorAll(selector));
            }
            return found;
        }
        querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
        addEventListener(type, listener) {
            if (!this.listeners.has(type)) this.listeners.set(type, []);
            this.listeners.get(type).push(listener);
        }
        removeEventListener() {}
        async dispatch(type, extra = {}) {
            const event = { type, target: this, currentTarget: this,
                preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {}, ...extra };
            for (const listener of this.listeners.get(type) || []) await listener(event);
        }
        focus() { document.activeElement = this; }
        getBoundingClientRect() { return { x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }; }
        decode() { return decodeImage(this); }
    }
    const body = new Element('body');
    const docListeners = new Map();
    globalThis.HTMLElement = Element;
    globalThis.document = {
        body, activeElement: body, readyState: main ? 'complete' : 'loading',
        fonts: { ready: Promise.resolve() },
        getElementById: id => {
            if (!elements.has(id) && main) { const element = new Element(); element.id = id; body.appendChild(element); }
            return elements.get(id) || null;
        },
        createElement: tag => new Element(tag), createElementNS: (_, tag) => new Element(tag),
        querySelector: selector => body.querySelector(selector), querySelectorAll: selector => body.querySelectorAll(selector),
        addEventListener: (type, listener) => {
            if (!docListeners.has(type)) docListeners.set(type, []);
            docListeners.get(type).push(listener);
        }
    };
    globalThis.window = {
        APP_CONFIG: { user: { isAdmin: true, role: 'admin' }, csrfToken: 'synthetic-token' },
        requestAnimationFrame: fn => fn(), addEventListener() {}, setTimeout, clearTimeout,
        getComputedStyle: element => ({ display: element.hidden ? 'none' : 'block', visibility: 'visible' }),
        print: () => { printCalls++; }, location: { reload() {} }
    };
    globalThis.confirm = () => true;
    const includes = ['templates/components/tool_palette.php', 'templates/modals/print.php', ...templates];
    appendPhpTemplates(body, tag => new Element(tag), includes, "require 'src/Core/SecurityHeaders.php'; ");
    return {
        get: id => document.getElementById(id),
        printCalls: () => printCalls,
        setDecode: callback => { decodeImage = callback; },
        async keydown(event) { for (const callback of docListeners.get('keydown') || []) await callback(event); },
        restore() {
            for (const [key, descriptor] of globals) {
                if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
            }
        }
    };
}
