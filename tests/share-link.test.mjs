import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { appState } from '../public/js/core/state.js';

const elements = new Map();
const listeners = new Map();
class TestElement {
    constructor(tag = 'div') {
        this.tagName = tag.toUpperCase();
        this.children = [];
        this.dataset = {};
        this.attributes = new Map();
        this.listeners = new Map();
        this.hidden = false;
        this.style = { setProperty() {} };
    }
    setAttribute(name, value) { this.attributes.set(name, value); }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
    insertAdjacentElement(position, child) { assert.equal(position, 'afterend'); this.parentNode.appendChild(child); }
    querySelector() { return this.children.find(child => 'shareLinkFallback' in child.dataset) || null; }
    remove() { this.parentNode.children = this.parentNode.children.filter(child => child !== this); }
    focus() { document.activeElement = this; }
    select() { this.selected = true; }
    click() { this.listeners.get('click')?.(); }
    closest(selector) { return selector === `#${this.id}` ? this : null; }
    getBoundingClientRect() { return { left: 300 }; }
}
globalThis.Element = TestElement;
globalThis.document = {
    body: new TestElement(), activeElement: null,
    getElementById: id => elements.get(id) || null,
    createElement: tag => new TestElement(tag),
    addEventListener(name, callback) {
        if (!listeners.has(name)) listeners.set(name, []);
        listeners.get(name).push(callback);
    },
    querySelector: () => null,
    querySelectorAll: () => [],
};
globalThis.window = {
    location: { href: 'https://example.test/netarium/index.php?token=secret&device=99#private' },
    APP_CONFIG: { user: { isAdmin: false } },
    clearTimeout() {}, setTimeout() { return 0; }
};
const { buildShareLink, copyShareLink } = await import('../public/js/ui/share-link.js');
let button;
let copied;
beforeEach(() => {
    elements.clear();
    elements.set('toast', new TestElement());
    elements.set('status-toast-message', new TestElement());
    document.body = new TestElement();
    document.activeElement = null;
    button = document.body.appendChild(new TestElement('button'));
    copied = [];
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
        clipboard: { writeText: async text => { copied.push(text); } }
    } });
    appState.views = [{ id: 12, resource_revision: 1 }];
    appState.devices = [{ id: 305, resource_revision: 2 }];
    appState.currentViewId = 12;
});

test('deployment URL contains only canonical view/device IDs, never existing secrets or hash', () => {
    assert.equal(buildShareLink({ viewId: 12 }), 'https://example.test/netarium/index.php?view=12');
    assert.equal(buildShareLink({ deviceId: 305 }), 'https://example.test/netarium/index.php?device=305');
    assert.equal(buildShareLink({ viewId: '0012', deviceId: 305 }), 'https://example.test/netarium/index.php?view=12&device=305');
    const sourceUrl = new URL('https://example.test/nested/?token=secret#hash');
    sourceUrl.username = 'user';
    sourceUrl.password = 'test-value';
    assert.equal(buildShareLink({ deviceId: 305 }, sourceUrl.href),
        'https://example.test/nested/index.php?device=305');
});

test('invalid, missing and unsaved IDs do not produce links', () => {
    for (const id of [null, '', ' ', -1, 0, 1.1, '1e1', '+12', '12.0', '12&token=secret', true, [], {}, Number.MAX_SAFE_INTEGER + 1]) {
        assert.equal(buildShareLink({ viewId: id }), null, String(id));
        assert.equal(buildShareLink({ deviceId: id }), null, String(id));
    }
    assert.equal(buildShareLink({}), null);
    assert.equal(buildShareLink({ deviceId: 999 }), null);
    appState.devices.push({ id: 306 });
    assert.equal(buildShareLink({ deviceId: 306 }), null, 'positive local ID is not persisted');
    appState.devices[1].resource_revision = 0;
    assert.equal(buildShareLink({ deviceId: 306 }), null);
    appState.devices[1].resource_revision = 1;
    assert.equal(buildShareLink({ deviceId: 306 }), 'https://example.test/netarium/index.php?device=306');
    appState.views[0].resource_revision = 0;
    assert.equal(buildShareLink({ viewId: 12, deviceId: 305 }), null);
});

test('maximum safe integer saved ID remains exact', () => {
    appState.devices.push({ id: Number.MAX_SAFE_INTEGER, resource_revision: 1 });
    assert.equal(buildShareLink({ deviceId: '9007199254740991' }),
        'https://example.test/netarium/index.php?device=9007199254740991');
});

test('viewer can copy without saving or changing application resources', async () => {
    const before = JSON.stringify({ views: appState.views, devices: appState.devices });
    assert.equal(await copyShareLink({ viewId: 12, deviceId: 305 }, button), true);
    assert.deepEqual(copied, ['https://example.test/netarium/index.php?view=12&device=305']);
    assert.equal(elements.get('status-toast-message').textContent, 'リンクをコピーしました');
    assert.equal(JSON.stringify({ views: appState.views, devices: appState.devices }), before);
});

test('unsaved resource shows save guidance without invoking clipboard', async () => {
    appState.devices[0].resource_revision = 0;
    assert.equal(await copyShareLink({ deviceId: 305 }, button), false);
    assert.deepEqual(copied, []);
    assert.match(elements.get('toast').textContent, /保存後/);
    assert.equal(document.body.children.length, 1);
});

for (const failure of ['unavailable', 'rejected']) {
    test(`clipboard ${failure} offers selectable read-only URL and keyboard dismissal`, async () => {
        navigator.clipboard = failure === 'unavailable' ? undefined : {
            writeText: async () => { throw new Error('denied'); }
        };
        assert.equal(await copyShareLink({ deviceId: 305 }, button), false);
        const fallback = document.body.querySelector();
        const input = fallback.children[0].children[0];
        assert.equal(input.readOnly, true);
        assert.equal(input.value, 'https://example.test/netarium/index.php?device=305');
        assert.equal(input.selected, true);
        assert.equal(document.activeElement, input);
        assert.match(elements.get('toast').textContent, /手動/);
        await copyShareLink({ deviceId: 305 }, button);
        assert.equal(document.body.children.length, 2, 'repeat replaces previous fallback');
        const current = document.body.querySelector();
        let prevented = false;
        current.listeners.get('keydown')({ key: 'Escape', preventDefault() { prevented = true; }, stopPropagation() {} });
        assert.equal(prevented, true);
        assert.equal(document.body.children.length, 1);
        assert.equal(document.activeElement, button);
    });
}

test('view copy click is wired within share module and reads the current selection', async () => {
    button.id = 'view-copy-link-btn';
    for (const callback of listeners.get('click') || []) callback({ target: button });
    await Promise.resolve();
    assert.deepEqual(copied, ['https://example.test/netarium/index.php?view=12']);
    appState.views.push({ id: 13, resource_revision: 1 });
    appState.currentViewId = 13;
    for (const callback of listeners.get('click') || []) callback({ target: button });
    await Promise.resolve();
    assert.equal(copied[1], 'https://example.test/netarium/index.php?view=13');
});

test('canvas panel button copies current view and selected device for a viewer', async () => {
    await import('../public/js/ui/property-panel.js');
    appState.editingDeviceId = 305;
    button.id = 'p-copy-link-btn';
    for (const callback of listeners.get('click') || []) await callback({ target: button });
    assert.deepEqual(copied, ['https://example.test/netarium/index.php?view=12&device=305']);
});

test('ledger sheet button copies only its active device for a viewer', async () => {
    const { openLedgerDetail } = await import('../public/js/modals/ledger-modal.js');
    assert.equal(await openLedgerDetail(305), true);
    button.id = 'ledger-sheet-copy-link-btn';
    for (const callback of listeners.get('click') || []) await callback({ target: button });
    assert.deepEqual(copied, ['https://example.test/netarium/index.php?device=305']);
});

test('台帳個票の対象変更後に古い手動コピーURLを残さない', async () => {
    const { openLedgerDetail } = await import('../public/js/modals/ledger-modal.js');
    await openLedgerDetail(305);
    button.id = 'ledger-sheet-copy-link-btn';
    elements.set(button.id, button);
    navigator.clipboard = undefined;
    await copyShareLink({ deviceId: 305 }, button);
    assert.equal(document.body.querySelector().children[0].children[0].value, 'https://example.test/netarium/index.php?device=305');
    appState.devices.push({ id: 306, resource_revision: 1 });
    assert.equal(await openLedgerDetail(306), true);
    assert.equal(document.body.querySelector(), null);
    await copyShareLink({ deviceId: 306 }, button);
    assert.equal(document.body.querySelector().children[0].children[0].value, 'https://example.test/netarium/index.php?device=306');
});

test('ビュー変更時に前のビューの手動コピーURLを閉じる', async () => {
    const { syncViewCombobox } = await import('../public/js/ui/view-combobox.js');
    button.id = 'view-copy-link-btn';
    elements.set(button.id, button);
    navigator.clipboard = undefined;
    await copyShareLink({ viewId: 12 }, button);
    assert.equal(document.body.querySelector().children[0].children[0].value, 'https://example.test/netarium/index.php?view=12');
    appState.views.push({ id: 13, resource_revision: 1 });
    appState.currentViewId = 13;
    syncViewCombobox();
    assert.equal(document.body.querySelector(), null);
});
