import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    buildManagementUrl,
    closeManagementConnectionDialog,
    closeManagementSshHelpDialog,
    getDefaultManagementPort,
    normalizeManagementPort,
    openManagementConnectionDialog,
    openManagementSshHelpDialog
} from '../public/js/modals/management-modal.js';
import { onKeyDown } from '../public/js/canvas/selection.js';


test('URI生成およびポート正規化の既存動作が維持されている', () => {
    assert.strictEqual(getDefaultManagementPort('http'), 80);
    assert.strictEqual(getDefaultManagementPort('https'), 443);
    assert.strictEqual(getDefaultManagementPort('ssh'), 22);

    assert.strictEqual(buildManagementUrl('http', '192.168.1.1', null), 'http://192.168.1.1/');
    assert.strictEqual(buildManagementUrl('https', '192.168.1.1', 8443), 'https://192.168.1.1:8443/');
    assert.strictEqual(buildManagementUrl('ssh', '192.168.1.1', null), 'ssh://192.168.1.1');
    assert.strictEqual(buildManagementUrl('ssh', '192.168.1.1', 2222), 'ssh://192.168.1.1:2222');

    const portResultValid = normalizeManagementPort('22', 'ssh');
    assert.strictEqual(portResultValid.isValid, true);
    assert.strictEqual(portResultValid.port, 22);

    const portResultInvalid = normalizeManagementPort('99999', 'ssh');
    assert.strictEqual(portResultInvalid.isValid, false);
});

class FakeHTMLElement {
    constructor(id = '', initialProps = {}) {
        this.id = id;
        this.value = initialProps.value || '';
        this.textContent = initialProps.textContent || '';
        this.hidden = initialProps.hidden !== undefined ? initialProps.hidden : false;
        this.disabled = initialProps.disabled !== undefined ? initialProps.disabled : false;
        this.checked = initialProps.checked || false;
        this.type = initialProps.type || 'text';
        this.name = initialProps.name || '';
        this.children = [];
        this.attributes = new Map();
        this.listeners = new Map();
        this.isConnected = true;
        this.offsetParent = {};
        this.classList = {
            contains: () => false,
            add: () => {},
            remove: () => {},
            toggle: () => {}
        };
    }

    setAttribute(k, v) {
        this.attributes.set(k, String(v));
    }

    removeAttribute(k) {
        this.attributes.delete(k);
    }

    getAttribute(k) {
        return this.attributes.get(k) || null;
    }

    addEventListener(type, callback) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type).add(callback);
    }

    contains(element) {
        return this === element || this.children.some(child => child.contains(element));
    }
    focus() {
        this._focused = true;
        if (globalThis.document) {
            globalThis.document.activeElement = this;
        }
    }

    closest() {
        return null;
    }

    querySelectorAll() {
        return [];
    }

    querySelector() {
        return null;
    }
}

class FakeHTMLInputElement extends FakeHTMLElement {}
class FakeHTMLButtonElement extends FakeHTMLElement {}

function setupDomEnvironment(t) {
    const originalGlobals = new Map(
        ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement'].map(
            k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]
        )
    );

    t.after(() => {
        closeManagementConnectionDialog(false);
        for (const [key, desc] of originalGlobals) {
            if (desc) Object.defineProperty(globalThis, key, desc);
            else delete globalThis[key];
        }
    });

    globalThis.HTMLElement = FakeHTMLElement;
    globalThis.HTMLInputElement = FakeHTMLInputElement;
    globalThis.HTMLButtonElement = FakeHTMLButtonElement;

    const elements = new Map();

    // 基本DOMノード準備
    const portInput = new FakeHTMLInputElement('management-connection-port', { value: '' });
    const portError = new FakeHTMLElement('management-connection-port-error', { hidden: true });
    const portHelp = new FakeHTMLElement('management-connection-port-help');
    const urlPreview = new FakeHTMLElement('management-connection-url');
    const openBtn = new FakeHTMLButtonElement('management-connection-open-btn', { textContent: '接続する' });
    const sshHelpBtn = new FakeHTMLButtonElement('management-connection-ssh-help-btn', { hidden: true });

    const overlay = new FakeHTMLElement('management-connection-overlay', { hidden: true });
    const dialog = new FakeHTMLElement('management-connection-dialog');
    const deviceEl = new FakeHTMLElement('management-connection-device');
    const ipEl = new FakeHTMLElement('management-connection-ip');

    const sshHelpOverlay = new FakeHTMLElement('management-ssh-help-overlay', { hidden: true });
    const sshHelpDialog = new FakeHTMLElement('management-ssh-help-dialog');
    const sshHelpCloseBtn = new FakeHTMLButtonElement('management-ssh-help-close-btn');

    // ラジオボタン
    const httpRadio = new FakeHTMLInputElement('scheme-http', { name: 'management-connection-scheme', value: 'http', checked: false, type: 'radio' });
    const httpsRadio = new FakeHTMLInputElement('scheme-https', { name: 'management-connection-scheme', value: 'https', checked: true, type: 'radio' });
    const sshRadio = new FakeHTMLInputElement('scheme-ssh', { name: 'management-connection-scheme', value: 'ssh', checked: false, type: 'radio' });

    const radioList = [httpRadio, httpsRadio, sshRadio];

    elements.set('management-connection-port', portInput);
    elements.set('management-connection-port-error', portError);
    elements.set('management-connection-port-help', portHelp);
    elements.set('management-connection-url', urlPreview);
    elements.set('management-connection-open-btn', openBtn);
    elements.set('management-connection-ssh-help-btn', sshHelpBtn);
    elements.set('management-connection-overlay', overlay);
    elements.set('management-connection-dialog', dialog);
    elements.set('management-connection-device', deviceEl);
    elements.set('management-connection-ip', ipEl);
    elements.set('management-ssh-help-overlay', sshHelpOverlay);
    elements.set('management-ssh-help-dialog', sshHelpDialog);
    elements.set('management-ssh-help-close-btn', sshHelpCloseBtn);

    globalThis.document = {
        activeElement: null,
        body: { contains: () => true },
        getElementById(id) {
            return elements.get(id) || null;
        },
        querySelector(selector) {
            if (selector.includes('management-connection-scheme') && selector.includes(':checked')) {
                return radioList.find(r => r.checked) || null;
            }
            return null;
        },
        querySelectorAll(selector) {
            if (selector.includes('management-connection-scheme')) {
                return radioList;
            }
            return [];
        }
    };

    globalThis.window = {
        requestAnimationFrame(cb) {
            cb();
        },
        getComputedStyle() {
            return { display: 'block', visibility: 'visible' };
        }
    };

    return {
        elements,
        radios: { http: httpRadio, https: httpsRadio, ssh: sshRadio },
        portInput,
        openBtn,
        sshHelpBtn,
        overlay,
        sshHelpOverlay,
        setScheme(scheme) {
            radioList.forEach(r => {
                r.checked = (r.value === scheme);
            });
        }
    };
}


test('openManagementSshHelpDialog / closeManagementSshHelpDialog: ヘルプの開閉とfocus管理', (t) => {
    const env = setupDomEnvironment(t);

    openManagementConnectionDialog({
        ip: '192.168.1.100',
        device: { id: 1, name: 'テストSW', management_scheme: 'ssh', management_port: 22 }
    });

    assert.strictEqual(env.sshHelpOverlay.hidden, true);

    // ヘルプを開く
    openManagementSshHelpDialog();
    assert.strictEqual(env.sshHelpOverlay.hidden, false);

    // ヘルプを閉じる
    closeManagementSshHelpDialog();
    assert.strictEqual(env.sshHelpOverlay.hidden, true);

    closeManagementConnectionDialog();
});

test('closeManagementConnectionDialog: 親モーダルを閉じた際にSSHヘルプも同時に閉じる', (t) => {
    const env = setupDomEnvironment(t);

    openManagementConnectionDialog({
        ip: '192.168.1.100',
        device: { id: 1, name: 'テストSW', management_scheme: 'ssh', management_port: 22 }
    });

    openManagementSshHelpDialog();
    assert.strictEqual(env.sshHelpOverlay.hidden, false);
    assert.strictEqual(env.overlay.hidden, false);

    // 親モーダルを閉じる
    closeManagementConnectionDialog();
    assert.strictEqual(env.sshHelpOverlay.hidden, true);
    assert.strictEqual(env.overlay.hidden, true);
});

test('管理接続のEscはSSHヘルプだけを先に閉じ、次で親を閉じる', async (t) => {
    const env = setupDomEnvironment(t);

    openManagementConnectionDialog({
        ip: '192.168.1.100',
        device: { id: 1, name: 'テストSW', management_scheme: 'ssh', management_port: 22 }
    });

    openManagementSshHelpDialog();
    assert.strictEqual(env.sshHelpOverlay.hidden, false);
    assert.strictEqual(env.overlay.hidden, false);

    // ヘルプが開いている状態で Escape を押す
    let prevented = false;
    let stopped = false;
    const escEvent = {
        key: 'Escape',
        preventDefault: () => { prevented = true; },
        stopImmediatePropagation: () => { stopped = true; }
    };

    await onKeyDown(escEvent);
    assert.strictEqual(prevented, true);
    assert.strictEqual(stopped, true);

    // SSHヘルプは閉じるが、親ダイアログは開いたまま
    assert.strictEqual(env.sshHelpOverlay.hidden, true);
    assert.strictEqual(env.overlay.hidden, false);

    // 再度 Escape を押すと親ダイアログが閉じる
    await onKeyDown(escEvent);
    assert.strictEqual(env.overlay.hidden, true);
});
