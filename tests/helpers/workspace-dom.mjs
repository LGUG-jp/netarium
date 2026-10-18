import { execFileSync } from 'node:child_process';

// 実フォームのイベントとフォーカスを通す、ブラウザー起動不要の軽量DOM。
export class WorkspaceElement {
    constructor(tagName = 'div', id = '') {
        this.tagName = tagName.toUpperCase(); this.id = id;
        this.children = []; this.parentElement = null; this.dataset = {}; this.style = {};
        this.attributes = new Map(); this.listeners = new Map(); this.classes = new Set();
        this.value = ''; this.checked = false; this.disabled = false; this.hidden = false;
        this.tabIndex = -1; this.scrollTop = 0; this._text = '';
        this.selectionStart = 0; this.selectionEnd = 0;
        this.ownerDocument = globalThis.document;
        this.captures = new Set();
        this.classList = {
            add: (...names) => names.forEach(name => this.classes.add(name)),
            remove: (...names) => names.forEach(name => this.classes.delete(name)),
            contains: name => this.classes.has(name),
            toggle: (name, force) => {
                const enabled = force ?? !this.classes.has(name);
                if (enabled) this.classes.add(name); else this.classes.delete(name);
                return enabled;
            }
        };
    }
    set value(value) {
        this._value = String(value);
        if (this.type === 'file' && this._value === '') this.files = [];
        if (this.tagName === 'SELECT') {
            let matched = false;
            for (const option of this.options) {
                option.selected = !matched && option.value === this._value;
                matched ||= option.selected;
            }
        }
    }
    get value() {
        return this.tagName === 'SELECT' ? this.selectedOptions[0]?.value || '' : this._value;
    }
    get options() { return this.querySelectorAll('option'); }
    get selectedOptions() { return this.options.filter(option => option.selected); }
    get selectedIndex() { return this.options.findIndex(option => option.selected); }
    set selectedIndex(index) { this.options.forEach((option, position) => { option.selected = position === Number(index); }); }
    set className(value) { this.classes = new Set(value.split(/\s+/).filter(Boolean)); }
    get className() { return [...this.classes].join(' '); }
    set textContent(value) { this._text = String(value); this.replaceChildren(); }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set innerHTML(html) {
        this._text = '';
        this.replaceChildren();
        appendHtml(this, tag => new WorkspaceElement(tag), String(html));
    }
    reset() {
        for (const input of this.querySelectorAll('input, select, textarea')) {
            input.value = input.tagName === 'SELECT'
                ? (input.querySelector('option[selected]') || input.querySelector('option'))?.value || ''
                : input.attributes.get('value') || '';
            input.checked = input.attributes.has('checked');
            if (input.type === 'file') input.files = [];
        }
    }
    setAttribute(name, value) {
        value = String(value); this.attributes.set(name, value);
        if (name === 'id') this.id = value;
        if (name === 'class') this.className = value;
        if (['type', 'name', 'value'].includes(name)) this[name] = value;
        if (['hidden', 'checked', 'disabled', 'selected', 'multiple'].includes(name)) this[name] = true;
        if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
    }
    getAttribute(name) {
        if (name === 'id') return this.id || null;
        if (name === 'class') return this.className;
        if (name === 'tabindex') return String(this.tabIndex);
        if (['href', 'target', 'rel'].includes(name)) return this[name] ?? this.attributes.get(name) ?? null;
        if (name.startsWith('data-')) {
            const key = name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
            return this.dataset[key] ?? null;
        }
        return this.attributes.get(name) ?? null;
    }
    removeAttribute(name) { this.attributes.delete(name); }
    appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
    append(...children) { children.forEach(child => this.appendChild(child)); }
    prepend(child) { child.parentElement = this; this.children.unshift(child); }
    insertAdjacentElement(position, child) {
        const where = position.toLowerCase();
        if (!['beforebegin', 'afterbegin', 'beforeend', 'afterend'].includes(where)) throw new SyntaxError('Invalid position');
        const inside = where === 'afterbegin' || where === 'beforeend';
        const parent = inside ? this : this.parentElement;
        if (!parent) return null;
        child.remove();
        const index = inside ? (where === 'afterbegin' ? 0 : parent.children.length)
            : parent.children.indexOf(this) + (where === 'afterend' ? 1 : 0);
        child.parentElement = parent;
        parent.children.splice(index, 0, child);
        return child;
    }
    replaceChildren(...children) {
        this.children.forEach(child => { child.parentElement = null; });
        this.children = []; this.append(...children);
    }
    remove() {
        if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
        this.parentElement = null;
    }
    matches(selector) {
        return selector.split(',').some(part => {
            let query = part.trim();
            if (!query) return false;
            const excluded = [...query.matchAll(/:not\(([^)]+)\)/g)].map(match => match[1]);
            query = query.replace(/:not\([^)]+\)/g, '');
            if (excluded.some(part => this.matches(part))) return false;
            if (query.includes(':checked')) { if (!this.checked) return false; query = query.replace(':checked', ''); }
            const tag = query.match(/^[a-z]+/i)?.[0];
            if (tag && this.tagName !== tag.toUpperCase()) return false;
            const id = query.match(/#([\w-]+)/)?.[1];
            if (id && this.id !== id) return false;
            for (const match of query.matchAll(/\.([\w-]+)/g)) if (!this.classes.has(match[1])) return false;
            for (const match of query.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) {
                const [_, name, value] = match;
                const actual = name === 'hidden' ? (this.hidden ? '' : null)
                    : name === 'disabled' ? (this.disabled ? '' : null)
                    : name === 'type' ? this.type ?? null : this.getAttribute(name);
                if (actual === null || (value !== undefined && actual !== value)) return false;
            }
            return true;
        });
    }
    querySelectorAll(selector) {
        const results = [];
        for (const child of this.children) {
            if (child.matches(selector)) results.push(child);
            results.push(...child.querySelectorAll(selector));
        }
        return results;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    closest(selector) {
        for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node;
        return null;
    }
    contains(node) { return node === this || this.children.some(child => child.contains(node)); }
    focus() { document.activeElement = this; }
    get isConnected() { return document.body.contains(this); }
    setPointerCapture(id) { this.captures.add(id); }
    hasPointerCapture(id) { return this.captures.has(id); }
    releasePointerCapture(id) { this.captures.delete(id); }
    click() { return this.dispatch('click'); }
    scrollIntoView() {}
    setSelectionRange(start, end) {
        this.selectionStart = Number(start);
        this.selectionEnd = Number(end);
    }
    getBoundingClientRect() { return { left: 0, top: 0, width: 1200, height: 800 }; }
    addEventListener(type, callback) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type).add(callback);
    }
    removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
    async dispatch(type, options = {}) {
        const event = { type, target: this, currentTarget: this, preventDefault() {}, stopPropagation() {},
            stopImmediatePropagation() { this.stopped = true; }, ...options };
        for (const callback of [...(this.listeners.get(type) || [])]) {
            await callback(event);
            if (event.stopped) break;
        }
        return event;
    }
}

export function installWorkspaceDom({ templates = [], phpSetup = '' } = {}) {
    const body = new WorkspaceElement('body');
    const events = new WorkspaceElement();
    globalThis.Element = globalThis.HTMLElement = WorkspaceElement;
    globalThis.document = {
        body, activeElement: body,
        getElementById: id => body.querySelector(`#${id}`),
        querySelector: selector => body.querySelector(selector),
        querySelectorAll: selector => body.querySelectorAll(selector),
        createElementNS: (_namespace, tag) => new WorkspaceElement(tag),
        createElement: tag => new WorkspaceElement(tag),
        createTextNode: text => {
            const node = new WorkspaceElement('span');
            node.textContent = text;
            return node;
        },
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events)
    };
    globalThis.window = {
        APP_CONFIG: { user: { isAdmin: true }, csrfToken: 'test-only-token' }, innerWidth: 1200, innerHeight: 900,
        addEventListener() {},
        requestAnimationFrame: callback => callback(), getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
        clearTimeout, setTimeout(callback, delay) { const timer = setTimeout(callback, delay); timer.unref(); return timer; }
    };
    const add = (tag, id, parent = body) => parent.appendChild(new WorkspaceElement(tag, id));
    if (templates.length) appendPhpTemplates(body, tag => new WorkspaceElement(tag), templates, phpSetup);
    return { add, events, get: id => document.getElementById(id) };
}

// 印刷・作業領域の両テストで実テンプレートの要素・属性を共有する。
export function appendPhpTemplates(body, createElement, templates, phpSetup = '') {
    const html = execFileSync('php', ['-r',
        phpSetup + templates.map(path => `require '${path}';`).join(' ')], { encoding: 'utf8' });
    appendHtml(body, createElement, html);
}

function appendHtml(body, createElement, html) {
    const stack = [body];
    const voidTags = new Set(['input', 'img', 'br', 'hr', 'meta', 'link']);
    for (const match of html.matchAll(/<!--[\s\S]*?-->|<\/?([a-z][\w-]*)([^>]*)>|([^<]+)/gi)) {
        if (!match[1]) {
            if (match[3]?.trim()) {
                const text = createElement('span');
                text.textContent = match[3].trim();
                stack.at(-1).appendChild(text);
            }
            continue;
        }
        const tag = match[1].toLowerCase();
        if (match[0].startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
        const element = createElement(tag);
        for (const attribute of match[2].matchAll(/([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g)) {
            element.setAttribute(attribute[1], attribute[2] ?? attribute[3] ?? '');
        }
        stack.at(-1).appendChild(element);
        if (!voidTags.has(tag) && !match[0].endsWith('/>')) stack.push(element);
    }
    const selects = body.tagName === 'SELECT' ? [body] : body.querySelectorAll('select');
    for (const select of selects) {
        if (select.multiple) {
            for (const option of select.querySelectorAll('option')) option.selected = option.attributes.has('selected');
        } else {
            select.value = (select.querySelector('option[selected]') || select.querySelector('option'))?.value || '';
        }
    }
}
