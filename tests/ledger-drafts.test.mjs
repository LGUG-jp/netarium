import assert from 'node:assert/strict';
import { test } from 'node:test';

const elements = new Map();
class Element {
    constructor(tag = 'div', id = '') {
        this.tagName = tag.toUpperCase(); this._id = id; this.children = []; this.parentElement = null;
        if (id) elements.set(id, this);
        this.dataset = {}; this.style = {}; this.value = ''; this.textContent = ''; this.hidden = false;
        this.selected = false;
        this.listeners = new Map(); this.attributes = new Map(); this.selectionStart = 0; this.selectionEnd = 0;
        this.classList = { add() {}, remove() {}, toggle() {}, contains() { return false; } };
    }
    set id(val) {
        this._id = val;
        if (val) elements.set(val, this);
    }
    get id() { return this._id || ''; }
    get options() { return this.children.filter(child => child.tagName === 'OPTION'); }
    get selectedOptions() { return this.options.filter(option => option.selected); }
    get value() { return this.tagName === 'SELECT' ? this.selectedOptions[0]?.value ?? '' : this._value ?? ''; }
    set value(value) {
        if (this.tagName !== 'SELECT') { this._value = String(value); return; }
        let matched = false;
        for (const option of this.options) {
            option.selected = !matched && option.value === String(value);
            if (option.selected) matched = true;
        }
    }
    appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
    insertAdjacentElement(position, child) {
        if (position !== 'afterend') throw new Error(`Unsupported fixture position: ${position}`);
        if (!this.parentElement) return null;
        const parent = this.parentElement;
        child.parentElement = parent;
        parent.children.splice(parent.children.indexOf(this) + 1, 0, child);
        return child;
    }
    append(...children) { children.forEach(child => this.appendChild(child)); }
    replaceChildren(...children) { this.children.forEach(child => { child.parentElement = null; }); this.children = []; this.append(...children); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    addEventListener(name, listener) { if (!this.listeners.has(name)) this.listeners.set(name, []); this.listeners.get(name).push(listener); }
    removeEventListener() {}
    emit(name, extra = {}) { for (const listener of this.listeners.get(name) || []) listener({ target: this, currentTarget: this, stopPropagation() {}, stopImmediatePropagation() {}, preventDefault() {}, ...extra }); }
    click() { this.emit('click'); }
    remove() { if (this.id && typeof elements !== 'undefined') elements.delete(this.id); }
    contains(element) { return element === this || this.children.some(child => child.contains(element)); }
    focus() { document.activeElement = this; }
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
    matches(selector) {
        if (selector.startsWith('#')) return this.id === selector.slice(1);
        const role = selector.match(/^\[role="([^"]+)"\]$/);
        if (role) return this.getAttribute('role') === role[1];
        const field = selector.match(/\[data-field="([^"]+)"\]/);
        if (field) return this.dataset.field === field[1];
        if (selector === '[data-field]') return Boolean(this.dataset.field);
        if (selector === '[aria-invalid="true"]') return this.getAttribute('aria-invalid') === 'true';
        const id = selector.match(/\[data-device-id="([^"]+)"\]/);
        if (id && this.dataset.deviceId !== id[1]) return false;
        if (selector.includes('[data-device-id]') && !this.dataset.deviceId) return false;
        const tag = selector.match(/^[a-z]+/i)?.[0];
        return tag ? this.tagName === tag.toUpperCase() : selector === '[data-device-id]' && Boolean(this.dataset.deviceId);
    }
    querySelectorAll(selector) {
        const parts = selector.split(/\s+/);
        const last = parts.pop();
        const result = [];
        const walk = node => node.children.forEach(child => {
            if (child.matches(last) && (!parts.length || child.closest(parts.join(' ')))) result.push(child);
            walk(child);
        });
        walk(this); return result;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    closest(selector) {
        const parts = selector.split(/\s+/); const last = parts.pop();
        for (let node = this; node; node = node.parentElement) {
            if (node.matches(last) && (!parts.length || node.parentElement?.closest(parts.join(' ')))) return node;
        }
        return null;
    }
}

test('台帳の行境界と個票の明示適用は入力を保存応答から分離する', async t => {
    const originals = new Map(['window', 'document', 'fetch', 'confirm', 'localStorage', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLTextAreaElement', 'HTMLButtonElement'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    t.after(() => { for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
    const body = new Element('body');
    for (const id of ['ledger-overlay', 'ledger-table-body', 'ledger-device-sheet-overlay', 'ledger-sheet-tabs', 'ledger-sheet-body', 'ledger-sheet-save-btn', 'ledger-sheet-title', 'ledger-save-btn']) {
        const element = new Element(id.endsWith('btn') ? 'button' : 'div', id); elements.set(id, element); body.appendChild(element);
    }
    elements.get('ledger-device-sheet-overlay').hidden = true;
    for (const [id, values] of [
        ['ledger-view-filter', ['1']], ['ledger-building-filter', []],
        ['ledger-floor-filter', []], ['ledger-type-filter', ['switch']],
        ['ledger-status-filter', ['green', 'red', 'unknown']],
        ['ledger-ip-presence-filter', ['registered', 'empty']],
        ['ledger-placement-filter', ['placed', 'unplaced']]
    ]) {
        const select = body.appendChild(new Element('select', id)); select.multiple = true;
        for (const value of values) select.appendChild(Object.assign(new Element('option'), { value }));
    }
    globalThis.document = { body, activeElement: null, addEventListener() {}, removeEventListener() {}, createElement: tag => new Element(tag), createTextNode: text => Object.assign(new Element('span'), { textContent: text }), getElementById: id => elements.get(id) || null, querySelector: selector => body.querySelector(selector), querySelectorAll: selector => body.querySelectorAll(selector) };
    globalThis.window = { APP_CONFIG: { user: { isAdmin: true }, csrfToken: 'test' }, addEventListener() {}, requestAnimationFrame: fn => fn(), getComputedStyle: () => ({ display: 'block', visibility: 'visible' }), setTimeout, clearTimeout };
    globalThis.HTMLElement = Element;
    globalThis.HTMLInputElement = globalThis.HTMLSelectElement = globalThis.HTMLTextAreaElement = globalThis.HTMLButtonElement = Element;
    let preset = 'all'; globalThis.localStorage = { getItem: () => preset, setItem: (_, value) => { preset = value; } };
    globalThis.confirm = () => false;
    const { appState, normalizeDevice } = await import('../public/js/core/state.js');
    const { resetResourceBaseline } = await import('../public/js/core/resource-save.js');
    const { eventBus } = await import('../public/js/core/event-bus.js');
    const drafts = await import('../public/js/core/device-drafts.js');
    const ledger = await import('../public/js/modals/ledger-modal.js');
    const queue = await import('../public/js/core/save-queue.js');
    appState.devices = [normalizeDevice({ id: 1, name: 'SW1', type: 'switch', management_scheme: 'https', resource_revision: 1 }), normalizeDevice({ id: 2, name: 'SW2', type: 'switch', resource_revision: 1 })];
    appState.buildings = [{ id: 1, name: '庁舎A' }, { id: 2, name: '庁舎B' }];
    appState.floors = [{ id: 11, building_id: 1, name: '1F' }, { id: 21, building_id: 2, name: '2F' }];
    appState.views = [{ id: 1, name: 'Floor', view_type: 'topology', resource_revision: 1 }];
    appState.placements = []; appState.links = []; appState.resourceConflicts = { devices: new Map(), views: new Map() };
    resetResourceBaseline(appState);
    let calls = []; let release = null; let failNextSave = false;
    globalThis.fetch = async (url, options) => {
        assert.ok(url.includes('action=save_resources'));
        const payload = JSON.parse(options.body); calls.push(payload);
        if (release === 'defer') await new Promise(resolve => { release = resolve; });
        if (failNextSave) {
            failNextSave = false;
            return new Response(JSON.stringify({ ok: false, error: '入力を確認してください' }), { status: 422 });
        }
        return new Response(JSON.stringify({ ok: true, revision: calls.length + 1, id_maps: {}, devices: payload.devices.filter(row => row.operation !== 'delete').map(row => ({ ...row.device, resource_revision: (row.expected_revision || 1) + 1 })), views: [], placements: [], view_link_routes: [], canvas_notes: [], deleted_device_ids: [], deleted_view_ids: [], affected_view_ids: [] }));
    };
    const table = elements.get('ledger-table-body');
    const row = id => table.querySelector(`tr[data-device-id="${id}"]`);
    const field = (container, name) => container.querySelector(`[data-field="${name}"]`);
    const input = (element, value) => { element.value = value; element.emit('input'); };
    const chooseAction = async (action) => {
        await new Promise(resolve => setTimeout(resolve, 0));
        const btn = elements.get(`unsaved-changes-${action}`);
        if (btn) btn.click();
        await new Promise(resolve => setTimeout(resolve, 0));
    };
    await t.test('台帳と個票の設置フロア選択は下書き保護と明示保存・解除を保つ', async () => {
        Object.assign(appState.devices[0], { facility: ' 旧施設 ', floor: ' 旧階 ', floor_id: 11 });
        resetResourceBaseline(appState);
        ledger.renderLedgerTable();
        const select = field(row(1), 'floor_id');
        assert.deepEqual(select.options.map(option => option.textContent), ['未分類', '庁舎A / 1F', '庁舎B / 2F']);
        select.value = '21'; select.emit('change');
        assert.equal(appState.devices[0].floor_id, 11);
        assert.equal(drafts.getDeviceDraft('ledger', 1).floor_id, 21);
        assert.equal(calls.length, 0);
        row(1).emit('focusout', { target: select, relatedTarget: elements.get('ledger-save-btn') });
        await queue.flushSaveQueue({ silent: true });
        assert.equal(appState.devices[0].floor_id, 21);
        assert.equal(calls.at(-1).devices[0].device.floor_id, 21);
        await ledger.openLedgerDetail(1);
        const sheetSelect = field(elements.get('ledger-sheet-body'), 'floor_id');
        sheetSelect.value = ''; sheetSelect.emit('change');
        assert.equal(appState.devices[0].floor_id, 21);
        assert.equal(drafts.hasDeviceDraftChanges('sheet', 1), true);
        assert.equal(await ledger.saveLedgerSheet(), true);
        assert.equal(appState.devices[0].floor_id, null);
        assert.equal(calls.at(-1).devices[0].device.floor_id, null);
        assert.equal(calls.at(-1).devices[0].device.facility, ' 旧施設 ');
        assert.equal(calls.at(-1).devices[0].device.floor, ' 旧階 ');
        await ledger.closeLedgerDetailPane();
        calls = [];
    });
    await t.test('行内のTab/Enter/change/blurは送信せず、管理ポートも再描画で保持', async () => {
        ledger.renderLedgerTable();
        const first = row(1); const name = field(first, 'name'); const port = field(first, 'management_port');
        input(name, 'SW1 draft'); input(port, '8443'); port.focus();
        port.emit('change'); port.emit('blur'); port.emit('keydown', { key: 'Tab' }); port.emit('keydown', { key: 'Enter' });
        first.emit('focusout', { target: name, relatedTarget: port });
        assert.equal(appState.devices[0].name, 'SW1'); assert.equal(appState.devices[0].management_port, null); assert.equal(calls.length, 0);
        ledger.renderLedgerTable();
        assert.equal(field(row(1), 'name').value, 'SW1 draft'); assert.equal(field(row(1), 'management_port').value, '8443');
        assert.equal(document.activeElement, field(row(1), 'management_port'));
        ledger.setLedgerColumnPreset('standard'); ledger.setLedgerColumnPreset('all');
        assert.equal(field(row(1), 'management_port').value, '8443');
        const current = row(1); current.emit('focusout', { target: field(current, 'name'), relatedTarget: field(row(2), 'name') });
        await queue.flushSaveQueue({ silent: true });
        assert.equal(calls.length, 1); assert.equal(calls[0].devices[0].device.management_port, 8443); assert.equal(appState.devices[0].name, 'SW1 draft');
    });

    await t.test('台帳外へ移ると確定、invalidは保持して閉じない', async () => {
        ledger.renderLedgerTable(); const first = row(1); input(field(first, 'name'), 'SW1 outside');
        first.emit('focusout', { target: field(first, 'name'), relatedTarget: elements.get('ledger-save-btn') });
        await queue.flushSaveQueue({ silent: true }); assert.equal(appState.devices[0].name, 'SW1 outside');
        ledger.renderLedgerTable(); input(field(row(1), 'name'), '');
        input(field(row(2), 'memo'), 'must not partly commit');
        const before = calls.length; assert.equal(await ledger.saveLedger(), false); assert.equal(await ledger.closeLedger(), false);
        assert.equal(calls.length, before); assert.equal(field(row(1), 'name').value, '');
        assert.equal(appState.devices[1].memo, '');
        assert.equal(field(row(2), 'memo').value, 'must not partly commit');
        drafts.discardDeviceDrafts('ledger');
    });

    await t.test('台帳は100 codepoint超過を保持して欄内エラーを出し、修正まで送信しない', async () => {
        ledger.renderLedgerTable();
        const name = field(row(1), 'name');
        const before = calls.length;
        input(name, '😀'.repeat(101));
        assert.equal(name.value, '😀'.repeat(101));
        assert.equal(name.getAttribute('aria-invalid'), 'true');
        assert.match(elements.get('ledger-1-name-error').textContent, /100文字以内/);
        assert.equal(await ledger.saveLedger(), false);
        assert.equal(calls.length, before);
        ledger.renderLedgerTable();
        assert.equal(field(row(1), 'name').value, '😀'.repeat(101));
        input(field(row(1), 'name'), '😀'.repeat(100));
        assert.equal(field(row(1), 'name').getAttribute('aria-invalid'), null);
        assert.equal(await ledger.saveLedger(), true);
        assert.equal(calls.at(-1).devices[0].device.name, '😀'.repeat(100));
        input(field(row(1), 'name'), 'SW1 outside');
        await ledger.saveLedger();
    });

    await t.test('個票は適用のみ、保存応答中の新入力は消さない', async () => {
        await ledger.openLedgerDetail(1); const sheet = elements.get('ledger-sheet-body');
        input(field(sheet, 'name'), 'sheet applied'); field(sheet, 'name').emit('change'); field(sheet, 'name').emit('blur');
        assert.equal(appState.devices[0].name, 'SW1 outside');
        release = 'defer'; const saving = ledger.saveLedgerSheet();
        await new Promise(resolve => setImmediate(resolve));
        input(field(sheet, 'name'), 'sheet next input'); const next = field(sheet, 'name'); next.focus(); next.setSelectionRange(4, 7);
        release(); release = null; await saving;
        assert.equal(appState.devices[0].name, 'sheet applied'); assert.equal(field(sheet, 'name').value, 'sheet next input'); assert.equal(document.activeElement, next);
        assert.equal(elements.get('ledger-sheet-save-btn').disabled, false);
        ledger.renderLedgerDeviceSheet(appState.devices[0]);
        assert.equal(field(sheet, 'name').value, 'sheet next input'); assert.equal(document.activeElement, field(sheet, 'name')); assert.equal(document.activeElement.selectionStart, 4);
        let closeDetail = ledger.closeLedgerDetailPane(); await chooseAction('cancel'); assert.equal(await closeDetail, false);
        let openDetail2 = ledger.openLedgerDetail(2); await chooseAction('cancel'); assert.equal(await openDetail2, false);
        assert.equal(ledger.activeLedgerDeviceId, 1);
        await ledger.saveLedgerSheet(); assert.equal(elements.get('ledger-sheet-save-btn').disabled, true);
        input(field(sheet, 'name'), 'dirty sheet before overlay click');
        elements.get('ledger-device-sheet-overlay').click();
        await chooseAction('cancel');
        assert.equal(elements.get('ledger-device-sheet-overlay').hidden, false);
        assert.equal(ledger.activeLedgerDeviceId, 1);
        elements.get('ledger-device-sheet-overlay').click();
        await chooseAction('discard');
        assert.equal(elements.get('ledger-device-sheet-overlay').hidden, true);
        assert.equal(ledger.activeLedgerDeviceId, null);
        await ledger.openLedgerDetail(1);
        assert.equal(elements.get('ledger-device-sheet-overlay').hidden, false);
    });

    await t.test('個票の前後移動は未適用入力の保存・破棄・編集継続を反映し、移動先のフォームを表示する', async () => {
        ledger.renderLedgerTable();
        const sheet = elements.get('ledger-sheet-body');
        const originalName = appState.devices[0].name;
        input(field(sheet, 'name'), 'cancel navigation');
        let moving = window.navigateLedgerDevice(1);
        await chooseAction('cancel');
        await moving;
        assert.equal(ledger.activeLedgerDeviceId, 1);
        assert.equal(field(sheet, 'name').value, 'cancel navigation');
        assert.equal(appState.devices[0].name, originalName);

        moving = window.navigateLedgerDevice(1);
        await chooseAction('discard');
        await moving;
        assert.equal(ledger.activeLedgerDeviceId, 2);
        assert.equal(field(sheet, 'name').value, appState.devices[1].name);
        assert.equal(appState.devices[0].name, originalName);
        assert.equal(drafts.hasDeviceDraftChanges('sheet', 1), false);

        await window.navigateLedgerDevice(-1);
        assert.equal(ledger.activeLedgerDeviceId, 1);
        assert.equal(field(sheet, 'name').value, originalName);
        input(field(sheet, 'name'), 'saved before navigation');
        moving = window.navigateLedgerDevice(1);
        await chooseAction('save');
        await moving;
        assert.equal(ledger.activeLedgerDeviceId, 2);
        assert.equal(field(sheet, 'name').value, appState.devices[1].name);
        assert.equal(await queue.flushSaveQueue({ silent: true }), true);
        assert.equal(appState.devices[0].name, 'saved before navigation');
        assert.equal(calls.at(-1).devices[0].device.name, 'saved before navigation');
        await window.navigateLedgerDevice(-1);
        assert.equal(field(sheet, 'name').value, 'saved before navigation');
    });

    await t.test('個票のタブ切替は両タブの下書きとDOMを保持し、非表示タブのエラーへ戻れる', async () => {
        const sheet = elements.get('ledger-sheet-body');
        const before = calls.length;
        const name = field(sheet, 'name');
        input(name, 'two-tab draft');
        elements.get('ledger-sheet-tab-1').click();
        assert.equal(elements.get('ledger-sheet-panel-0').hidden, true);
        assert.equal(elements.get('ledger-sheet-panel-1').hidden, false);
        input(field(sheet, 'management_port'), '70000');
        elements.get('ledger-sheet-tab-0').click();
        assert.equal(field(sheet, 'name'), name);
        assert.equal(name.value, 'two-tab draft');
        assert.equal(calls.length, before);
        assert.equal(await ledger.saveLedgerSheet(), false);
        assert.equal(elements.get('ledger-sheet-panel-1').hidden, false);
        assert.equal(document.activeElement, field(sheet, 'management_port'));
        input(field(sheet, 'management_port'), '8443');
        ledger.renderLedgerDeviceSheet(appState.devices[0]);
        assert.equal(elements.get('ledger-sheet-panel-1').hidden, false);
        assert.equal(field(sheet, 'name').value, 'two-tab draft');
        input(field(sheet, 'name'), appState.devices[0].name);
        input(field(sheet, 'management_port'), appState.devices[0].management_port);
        assert.equal(await ledger.closeLedgerDetailPane(), true);
        await ledger.openLedgerDetail(1);
        assert.equal(elements.get('ledger-sheet-panel-0').hidden, false);
    });

    await t.test('個票の文字数超過は即時エラーと下書きを保持し、適用を拒否する', async () => {
        const sheet = elements.get('ledger-sheet-body');
        const before = calls.length;
        const name = field(sheet, 'name');
        input(name, '😀'.repeat(101));
        assert.equal(name.getAttribute('aria-invalid'), 'true');
        assert.match(elements.get('ledger-sheet-name-error').textContent, /100文字以内/);
        assert.equal(await ledger.saveLedgerSheet(), false);
        assert.equal(calls.length, before);
        ledger.renderLedgerDeviceSheet(appState.devices[0]);
        assert.equal(field(sheet, 'name').value, '😀'.repeat(101));
        assert.equal(field(sheet, 'name').getAttribute('aria-invalid'), 'true');
        input(field(sheet, 'name'), appState.devices[0].name);
        assert.equal(field(sheet, 'name').getAttribute('aria-invalid'), null);
    });

    await t.test('個票の適用が422で失敗した後も同じ入力を再送できる', async () => {
        const sheet = elements.get('ledger-sheet-body');
        input(field(sheet, 'memo'), 'retry the same input');
        failNextSave = true;
        const before = calls.length;
        assert.equal(await ledger.saveLedgerSheet(), false);
        assert.equal(calls.length, before + 1);
        assert.equal(field(sheet, 'memo').value, 'retry the same input');
        assert.equal(elements.get('ledger-sheet-save-btn').disabled, false);
        assert.equal(elements.get('ledger-sheet-save-btn').hidden, false);
        assert.equal(drafts.hasDeviceDraftChanges('sheet', 1), false);
        assert.equal(await ledger.saveLedgerSheet(), true);
        assert.equal(calls.length, before + 2);
        assert.equal(calls.at(-1).devices[0].device.memo, 'retry the same input');
        assert.equal(field(sheet, 'memo').value, 'retry the same input');
        assert.equal(elements.get('ledger-sheet-save-btn').disabled, true);
        assert.equal(elements.get('ledger-sheet-save-btn').hidden, true);
    });

    await t.test('仮ID再採番後も同じ入力を編集し、適用する', async () => {
        const sheet = elements.get('ledger-sheet-body'); input(field(sheet, 'memo'), 'before remap');
        const oldPort = field(row(1), 'management_port'); input(oldPort, '9000');
        appState.devices[0].id = 101; eventBus.emit('resources:ids-remapped', { devices: { 1: 101 } });
        resetResourceBaseline(appState);
        input(oldPort, '9001');
        assert.equal(drafts.getDeviceDraft('ledger', 101).management_port, 9001);
        await ledger.saveLedger();
        assert.equal(appState.devices[0].management_port, 9001);
        input(field(sheet, 'memo'), 'after remap');
        assert.equal(ledger.activeLedgerDeviceId, 101); assert.equal(drafts.getDeviceDraft('sheet', 101).memo, 'after remap');
        await ledger.saveLedgerSheet(); assert.equal(appState.devices[0].memo, 'after remap');
        assert.equal(calls.at(-1).devices[0].id, 101);
        assert.equal(drafts.hasDeviceDraftChanges('sheet', 101), false);
    });

    await t.test('競合機器は入力保持、他機器の台帳編集は保存できる', async () => {
        const sheet = elements.get('ledger-sheet-body'); input(field(sheet, 'memo'), 'keep conflict input');
        appState.resourceConflicts.devices.set(101, { message: 'conflict' }); eventBus.emit('device-drafts:changed');
        assert.equal(elements.get('ledger-sheet-save-btn').textContent, '競合を再読込');
        let closeConflicted = ledger.closeLedgerDetailPane(); await chooseAction('cancel'); assert.equal(await closeConflicted, false);
        assert.equal(field(sheet, 'memo').value, 'keep conflict input');
        const before = calls.length;
        closeConflicted = ledger.closeLedgerDetailPane(); await chooseAction('save');
        assert.equal(await closeConflicted, false);
        assert.equal(calls.length, before);
        assert.equal(field(sheet, 'memo').value, 'keep conflict input');
        globalThis.confirm = () => false;
        assert.equal(await ledger.saveLedgerSheet(), false);
        assert.equal(field(sheet, 'memo').value, 'keep conflict input');
        ledger.renderLedgerTable(); input(field(row(2), 'memo'), 'other device');
        await ledger.saveLedger(); assert.equal(appState.devices[1].memo, 'other device'); assert.equal(drafts.getDeviceDraft('sheet', 101).memo, 'keep conflict input');
        appState.resourceConflicts.devices.clear(); drafts.discardDeviceDrafts(); queue.clearPendingSave();
    });
    await t.test('個票は複数の入力エラーを各項目に同時表示し、修正項目だけ解除する', async () => {
        await ledger.openLedgerDetail(101);
        const sheet = elements.get('ledger-sheet-body');
        input(field(sheet, 'ip'), '192.0.2.999');
        input(field(sheet, 'management_port'), '65536');
        input(field(sheet, 'maintenance_expiry'), '2026-02-30');
        const before = calls.length;
        assert.equal(await ledger.saveLedgerSheet(), false);
        assert.equal(calls.length, before);
        for (const key of ['ip', 'management_port', 'maintenance_expiry']) {
            assert.equal(field(sheet, key).getAttribute('aria-invalid'), 'true');
            const error = elements.get(`ledger-sheet-${key}-error`);
            assert.equal(error.hidden, false);
            assert.equal(field(sheet, key).getAttribute('aria-describedby'), error.id);
        }
        input(field(sheet, 'ip'), '192.0.2.9');
        assert.equal(field(sheet, 'ip').getAttribute('aria-invalid'), null);
        assert.equal(field(sheet, 'management_port').getAttribute('aria-invalid'), 'true');
        drafts.discardDeviceDrafts('sheet');
    });

    await t.test('一括編集は表示外選択も固定して確認し、空欄化後に選択解除して既存キューで保存する', async () => {
        drafts.discardDeviceDrafts();
        appState.resourceConflicts.devices.clear();
        for (const id of ['ledger-bulk-edit-overlay', 'ledger-bulk-edit-body', 'ledger-bulk-edit-fields', 'ledger-bulk-edit-title', 'ledger-bulk-edit-count', 'ledger-bulk-edit-next', 'ledger-bulk-edit-form', 'ledger-bulk-edit-confirm', 'ledger-bulk-edit-preview', 'ledger-bulk-edit-warning', 'ledger-bulk-edit-apply', 'ledger-bulk-edit-error', 'ledger-bulk-edit-btn', 'ledger-selection-summary', 'ledger-building-filter']) {
            body.appendChild(new Element(id.endsWith('filter') ? 'select' : id.endsWith('btn') ? 'button' : 'div', id));
        }
        const overlay = elements.get('ledger-bulk-edit-overlay'); overlay.hidden = true;
        const firstId = Number(appState.devices[0].id);
        appState.devices[0].facility = '庁舎A'; appState.devices[1].facility = '庁舎B';
        appState.devices[0].floor = '1F'; appState.devices[1].floor = '2F';
        appState.devices[0].floor_id = 11; appState.devices[1].floor_id = 21;
        appState.placements = [{ id: 1, view_id: 1, device_id: firstId, x: 10, y: 20 }];
        resetResourceBaseline(appState);
        ledger.updateLedgerFilters();
        ledger.ledgerSelectedDeviceIds.clear(); ledger.updateLedgerSelectionUI();
        assert.equal(elements.get('ledger-bulk-edit-btn').disabled, true);
        ledger.ledgerSelectedDeviceIds.add(firstId); ledger.ledgerSelectedDeviceIds.add(2);
        elements.get('ledger-building-filter').value = '1'; ledger.renderLedgerTable();
        assert.equal(table.children.length, 1);
        await ledger.openLedgerBulkEdit();
        assert.equal(overlay.hidden, false);
        assert.equal(ledger.activeLedgerDeviceId, null);
        assert.equal(elements.get('ledger-bulk-edit-title').textContent, '2台の機器を一括編集');
        assert.equal(elements.get('ledger-bulk-edit-next').disabled, true);
        ledger.ledgerSelectedDeviceIds.clear();
        const change = elements.get('ledger-bulk-change-floor_id');
        change.checked = true; change.emit('change');
        assert.equal(elements.get('ledger-bulk-value-floor_id').disabled, false);
        elements.get('ledger-bulk-value-floor_id').value = '';
        for (const key of ['management_scheme', 'management_port']) {
            const checkbox = elements.get(`ledger-bulk-change-${key}`);
            checkbox.checked = true; checkbox.emit('change');
        }
        elements.get('ledger-bulk-value-management_scheme').value = 'ssh';
        elements.get('ledger-bulk-value-management_port').value = '65536';
        const beforeInvalid = structuredClone(appState.devices);
        const bulkBody = elements.get('ledger-bulk-edit-body');
        bulkBody.scrollTop = 500;
        elements.get('ledger-bulk-value-management_port').focus();
        ledger.previewLedgerBulkEdit();
        assert.equal(elements.get('ledger-bulk-edit-confirm').hidden, true);
        assert.deepEqual(appState.devices, beforeInvalid);
        assert.equal(bulkBody.scrollTop, 0);
        assert.equal(document.activeElement, elements.get('ledger-bulk-edit-error'));
        assert.equal(elements.get('ledger-bulk-value-management_port').value, '65536');
        assert.equal(elements.get('ledger-bulk-change-management_port').checked, true);
        elements.get('ledger-bulk-value-management_port').value = '2222';
        ledger.previewLedgerBulkEdit();
        assert.equal(elements.get('ledger-bulk-edit-confirm').hidden, false);
        assert.match(elements.get('ledger-bulk-edit-warning').textContent, /1台/);
        ledger.backLedgerBulkEdit();
        assert.equal(change.checked, true);
        ledger.previewLedgerBulkEdit();
        const before = calls.length;
        appState.resourceConflicts.devices.set(2, {});
        bulkBody.scrollTop = 500;
        elements.get('ledger-bulk-edit-apply').focus();
        ledger.confirmLedgerBulkEdit();
        assert.equal(overlay.hidden, false);
        assert.equal(elements.get('ledger-bulk-edit-confirm').hidden, false);
        assert.equal(bulkBody.scrollTop, 0);
        assert.equal(document.activeElement, elements.get('ledger-bulk-edit-error'));
        assert.deepEqual(appState.devices, beforeInvalid);
        assert.equal(calls.length, before);
        appState.resourceConflicts.devices.clear();
        ledger.confirmLedgerBulkEdit();
        assert.equal(overlay.hidden, true);
        assert.deepEqual(appState.devices.map(device => device.floor_id), [null, null]);
        assert.deepEqual(appState.devices.map(device => device.floor), ['1F', '2F']);
        assert.deepEqual(appState.devices.map(device => device.facility), ['庁舎A', '庁舎B']);
        assert.deepEqual(appState.devices.map(device => [device.management_scheme, device.management_port]), [['ssh', 2222], ['ssh', 2222]]);
        assert.equal(table.children.length, 0);
        assert.deepEqual([...ledger.ledgerSelectedDeviceIds], []);
        await queue.flushSaveQueue({ silent: true });
        assert.equal(calls.length, before + 1);
        assert.equal(calls.at(-1).devices.length, 2);
        assert.deepEqual(calls.at(-1).views, []);
        assert.deepEqual(appState.placements, [{ id: 1, view_id: 1, device_id: firstId, x: 10, y: 20 }]);
        elements.get('ledger-building-filter').value = '';
        ledger.renderLedgerTable();
        await ledger.openLedgerDetail(firstId);
        assert.equal(field(elements.get('ledger-sheet-body'), 'floor_id').value, '');
        await ledger.closeLedgerDetailPane();
        ledger.ledgerSelectedDeviceIds.add(firstId);
        window.APP_CONFIG.user.isAdmin = false;
        await ledger.openLedgerBulkEdit();
        assert.equal(overlay.hidden, true);
        ledger.updateLedgerSelectionUI();
        assert.equal(elements.get('ledger-bulk-edit-btn').disabled, true);
        window.APP_CONFIG.user.isAdmin = true;
    });

    await t.test('一般閲覧者はinputイベントでも下書きを変更しない', () => {
        window.APP_CONFIG.user.isAdmin = false; ledger.renderLedgerTable(); const memo = field(row(2), 'memo');
        input(memo, 'forbidden'); assert.equal(drafts.hasDeviceDraftChanges('ledger', 2), false); assert.equal(appState.devices[1].memo, 'other device');
    });

    await t.test('台帳の競合下書きは確認取消・非競合入力の確定失敗・個票の閉鎖取消では残る', async t => {
        window.APP_CONFIG.user.isAdmin = true;
        drafts.discardDeviceDrafts('ledger');
        appState.resourceConflicts.devices.clear();
        elements.get('ledger-overlay').hidden = false;
        ledger.renderLedgerTable();
        const [target, other] = appState.devices;
        input(field(row(target.id), 'name'), '競合中編集');
        appState.resourceConflicts.devices.set(target.id, { id: target.id, name: target.name });
        assert.equal(await ledger.openLedgerDetail(target.id), true);
        let confirmed = false;
        let confirmations = 0;
        window.confirm = message => {
            assert.match(message, /競合機器の入力を破棄/);
            confirmations++;
            return confirmed;
        };
        t.after(() => {
            appState.resourceConflicts.devices.clear();
            delete window.confirm;
        });
        const assertRetained = () => {
            assert.equal(elements.get('ledger-overlay').hidden, false);
            assert.equal(elements.get('ledger-device-sheet-overlay').hidden, false);
            assert.equal(drafts.getDeviceDraft('ledger', target.id).name, '競合中編集');
        };
        assert.equal(await ledger.closeLedger(), false);
        assertRetained();

        confirmed = true;
        const originalMemo = other.memo;
        input(field(row(other.id), 'memo'), '台帳の入力');
        other.memo = '他画面で確定した同じ項目';
        try {
            assert.equal(await ledger.closeLedger(), false);
            assertRetained();
            assert.equal(drafts.getDeviceDraft('ledger', other.id).memo, '台帳の入力');
        } finally {
            other.memo = originalMemo;
            drafts.discardDeviceDraft('ledger', other.id);
        }

        assert.equal(await ledger.openLedgerDetail(other.id), true);
        input(field(elements.get('ledger-sheet-body'), 'name'), '個票の入力');
        const cancelled = ledger.closeLedger();
        await chooseAction('cancel');
        assert.equal(await cancelled, false);
        assertRetained();

        const closing = ledger.closeLedger();
        await chooseAction('discard');
        assert.equal(await closing, true);
        assert.equal(confirmations, 4);
        assert.equal(elements.get('ledger-overlay').hidden, true);
        assert.equal(elements.get('ledger-device-sheet-overlay').hidden, true);
        assert.equal(drafts.hasDeviceDraftChanges('ledger', target.id), false);
    });

    await t.test('階層からの全再読込で台帳・個票を新しい値に更新し消えた個票だけ閉じる', async () => {
        elements.get('ledger-overlay').hidden = false;
        ledger.renderLedgerTable();
        const previous = appState.devices;
        const target = previous[0];
        assert.equal(await ledger.openLedgerDetail(target.id), true);
        const refresh = () => {
            eventBus.emit('resources:reloaded', { source: 'hierarchy-editor' });
            ledger.refreshOpenLedgerAfterReload();
        };
        try {
            appState.devices = [{ ...target, name: 'サーバーから再取得' }, ...previous.slice(1)];
            refresh();
            assert.equal(field(row(target.id), 'name').value, 'サーバーから再取得');
            assert.equal(field(elements.get('ledger-sheet-body'), 'name').value, 'サーバーから再取得');
            assert.equal(elements.get('ledger-device-sheet-overlay').hidden, false);

            appState.devices = previous.slice(1);
            refresh();
            assert.equal(row(target.id), null);
            assert.equal(elements.get('ledger-device-sheet-overlay').hidden, true);
            assert.equal(elements.get('ledger-overlay').hidden, false);
        } finally {
            appState.devices = previous;
            ledger.renderLedgerTable();
        }
    });

    await t.test('management_portのvalidity.badInput時はnullクリアせずエラー扱いにして送信しない', async () => {
        window.APP_CONFIG.user.isAdmin = true;
        drafts.discardDeviceDrafts('ledger');
        elements.get('ledger-overlay').hidden = false;
        ledger.renderLedgerTable();
        const target = appState.devices[0];
        const port = field(row(target.id), 'management_port');
        Object.defineProperty(port, 'validity', { get() { return { badInput: true }; }, configurable: true });
        port.value = '';
        port.emit('input');
        assert.equal(drafts.getDeviceDraft('ledger', target.id).management_port, 'invalid');
        const before = calls.length;
        assert.equal(await ledger.saveLedger(), false);
        assert.equal(calls.length, before);
        drafts.discardDeviceDrafts('ledger');
    });

    await t.test('台帳の選択を維持したまま自動保存が終わると一括操作を再開できる', async t => {
        body.append(
            new Element('span', 'status-save-state'),
            new Element('button', 'ledger-bulk-place-btn'),
            new Element('button', 'ledger-delete-btn')
        );
        elements.get('ledger-overlay').hidden = false;
        const stopRender = eventBus.on('ledger:render', ledger.renderLedgerTable);
        t.after(() => {
            if (typeof release === 'function') release();
            stopRender();
            ledger.clearLedgerSelection();
        });
        ledger.renderLedgerTable();
        const target = appState.devices[0];
        const selected = row(target.id);
        const checkbox = selected.querySelectorAll('input').find(input => input.type === 'checkbox');
        checkbox.checked = true;
        checkbox.emit('change');
        const actions = ['ledger-bulk-place-btn', 'ledger-delete-btn'].map(id => elements.get(id));
        assert.deepEqual(actions.map(button => button.disabled), [false, false]);

        const name = field(selected, 'name');
        input(name, '自動保存後も選択した機器');
        release = 'defer';
        selected.emit('focusout', { target: name, relatedTarget: actions[0] });
        const saving = queue.flushSaveQueue({ silent: true });
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(actions.map(button => button.disabled), [true, true]);

        release(); release = null;
        assert.equal(await saving, true);
        assert.equal(calls.at(-1).devices[0].device.name, '自動保存後も選択した機器');
        assert.deepEqual(ledger.getLedgerSelectedDeviceIds(), [target.id]);
        assert.deepEqual(actions.map(button => button.disabled), [false, false]);
    });
});
