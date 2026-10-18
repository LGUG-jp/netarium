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
    for (const id of ['ledger-overlay', 'ledger-table-body', 'ledger-device-sheet-overlay', 'ledger-sheet-body', 'ledger-sheet-save-btn', 'ledger-sheet-title', 'ledger-save-btn']) {
        const element = new Element(id.endsWith('btn') ? 'button' : 'div', id); elements.set(id, element); body.appendChild(element);
    }
    elements.get('ledger-device-sheet-overlay').hidden = true;
    for (const [id, values] of [
        ['ledger-view-filter', ['1']], ['ledger-facility-filter', []],
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
        return new Response(JSON.stringify({ ok: true, revision: calls.length + 1, id_maps: {}, devices: payload.devices.filter(row => row.operation !== 'delete').map(row => ({ ...row.device, resource_revision: (row.expected_revision || 1) + 1 })), views: [], placements: [], links: [], canvas_notes: [], deleted_device_ids: [], deleted_view_ids: [], affected_view_ids: [] }));
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
        assert.equal(drafts.hasDeviceDraftChanges('sheet', 1), false);
        assert.equal(await ledger.saveLedgerSheet(), true);
        assert.equal(calls.length, before + 2);
        assert.equal(calls.at(-1).devices[0].device.memo, 'retry the same input');
        assert.equal(field(sheet, 'memo').value, 'retry the same input');
        assert.equal(elements.get('ledger-sheet-save-btn').disabled, true);
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
        for (const id of ['ledger-bulk-edit-overlay', 'ledger-bulk-edit-body', 'ledger-bulk-edit-fields', 'ledger-bulk-edit-title', 'ledger-bulk-edit-count', 'ledger-bulk-edit-next', 'ledger-bulk-edit-form', 'ledger-bulk-edit-confirm', 'ledger-bulk-edit-preview', 'ledger-bulk-edit-warning', 'ledger-bulk-edit-apply', 'ledger-bulk-edit-error', 'ledger-bulk-edit-btn', 'ledger-selection-summary', 'ledger-facility-filter']) {
            body.appendChild(new Element(id.endsWith('filter') ? 'select' : id.endsWith('btn') ? 'button' : 'div', id));
        }
        const overlay = elements.get('ledger-bulk-edit-overlay'); overlay.hidden = true;
        const firstId = Number(appState.devices[0].id);
        appState.devices[0].facility = '庁舎A'; appState.devices[1].facility = '庁舎B';
        appState.devices[0].floor = '1F'; appState.devices[1].floor = '2F';
        appState.placements = [{ id: 1, view_id: 1, device_id: firstId, x: 10, y: 20 }];
        resetResourceBaseline(appState);
        ledger.updateLedgerFilters();
        ledger.ledgerSelectedDeviceIds.clear(); ledger.updateLedgerSelectionUI();
        assert.equal(elements.get('ledger-bulk-edit-btn').disabled, true);
        ledger.ledgerSelectedDeviceIds.add(firstId); ledger.ledgerSelectedDeviceIds.add(2);
        elements.get('ledger-facility-filter').value = '庁舎A'; ledger.renderLedgerTable();
        assert.equal(table.children.length, 1);
        await ledger.openLedgerBulkEdit();
        assert.equal(overlay.hidden, false);
        assert.equal(ledger.activeLedgerDeviceId, null);
        assert.equal(elements.get('ledger-bulk-edit-title').textContent, '2台の機器を一括編集');
        assert.equal(elements.get('ledger-bulk-edit-next').disabled, true);
        ledger.ledgerSelectedDeviceIds.clear();
        const change = elements.get('ledger-bulk-change-floor');
        change.checked = true; change.emit('change');
        assert.equal(elements.get('ledger-bulk-value-floor').disabled, false);
        const facilityChange = elements.get('ledger-bulk-change-facility');
        facilityChange.checked = true; facilityChange.emit('change');
        elements.get('ledger-bulk-value-facility').value = '庁舎C';
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
        assert.deepEqual(appState.devices.map(device => device.floor), ['', '']);
        assert.deepEqual(appState.devices.map(device => device.facility), ['庁舎C', '庁舎C']);
        assert.deepEqual(appState.devices.map(device => [device.management_scheme, device.management_port]), [['ssh', 2222], ['ssh', 2222]]);
        assert.equal(table.children.length, 0);
        assert.deepEqual([...ledger.ledgerSelectedDeviceIds], []);
        await queue.flushSaveQueue({ silent: true });
        assert.equal(calls.length, before + 1);
        assert.equal(calls.at(-1).devices.length, 2);
        assert.deepEqual(calls.at(-1).views, []);
        assert.deepEqual(appState.placements, [{ id: 1, view_id: 1, device_id: firstId, x: 10, y: 20 }]);
        elements.get('ledger-facility-filter').value = '';
        ledger.renderLedgerTable();
        await ledger.openLedgerDetail(firstId);
        assert.equal(field(elements.get('ledger-sheet-body'), 'floor').value, '');
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
});
