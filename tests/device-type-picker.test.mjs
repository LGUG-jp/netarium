import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appState } from '../public/js/core/state.js';
import { DEVICE_TYPES } from '../public/js/core/constants.js';
import { WorkspaceElement } from './helpers/workspace-dom.mjs';

class PickerElement extends WorkspaceElement {
    get isConnected() { return globalThis.document?.body?.contains(this) ?? false; }
    getBoundingClientRect() {
        return this.rect ?? { left: 0, right: 160, top: 0, bottom: 32, width: 160, height: 32 };
    }
}

let fixtureId = 0;
async function fixture(t) {
    const originals = new Map(['document', 'window', 'HTMLElement', 'Element'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const state = new Map(['authExpired', 'isPinging'].map(key => [key, Object.getOwnPropertyDescriptor(appState, key)]));
    const body = new PickerElement('body');
    const overlay = new PickerElement('div');
    overlay.className = 'ledger-overlay';
    body.appendChild(overlay);
    const documentEvents = new PickerElement();
    const windowEvents = new PickerElement();
    globalThis.HTMLElement = globalThis.Element = PickerElement;
    globalThis.document = {
        body, activeElement: body,
        createElement: tag => new PickerElement(tag),
        getElementById: id => body.querySelector(`#${id}`),
        querySelector: selector => body.querySelector(selector),
        querySelectorAll: selector => body.querySelectorAll(selector),
        addEventListener: documentEvents.addEventListener.bind(documentEvents),
        removeEventListener: documentEvents.removeEventListener.bind(documentEvents)
    };
    globalThis.window = {
        APP_CONFIG: { user: { isAdmin: true } }, innerWidth: 1000, innerHeight: 700,
        addEventListener: windowEvents.addEventListener.bind(windowEvents),
        removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
        requestAnimationFrame: fn => fn(),
        getComputedStyle: () => ({ display: 'block', visibility: 'visible' })
    };
    Object.assign(appState, { authExpired: false, isPinging: false });
    let picker;
    t.after(() => {
        try { picker?.closeDeviceTypePicker(); }
        finally {
            body.replaceChildren();
            for (const [key, descriptor] of state) {
                if (descriptor) Object.defineProperty(appState, key, descriptor);
                else delete appState[key];
            }
            for (const [key, descriptor] of originals) {
                if (descriptor) Object.defineProperty(globalThis, key, descriptor);
                else delete globalThis[key];
            }
        }
    });
    // 各fixtureで常設監視の参照先も隔離し、他テストのdocumentへ持ち越さない。
    picker = await import('../public/js/ui/device-type-picker.js');
    let nextId = 1;
    const add = ({ value = 'router', disabled = false, onChange } = {}) => {
        const changes = [];
        const result = picker.createDeviceTypePicker({
            deviceId: nextId++, value, disabled,
            onChange: control => {
                changes.push({ control, value: control.value, label: control.textContent, icon: control.querySelector('img')?.src });
                onChange?.(control);
            }
        });
        overlay.appendChild(result.element);
        result.control.rect = { left: 40, right: 200, top: 80, bottom: 112, width: 160, height: 32 };
        return { ...result, changes };
    };
    return { add, body, documentEvents, windowEvents, close: picker.closeDeviceTypePicker, picker };
}

const popup = () => document.body.querySelector('.device-type-options');
const options = () => popup()?.querySelectorAll('[role="option"]') ?? [];
const optionFor = value => options().find(option => option.value === value);
const activeOption = control => options().find(option => option.id === control.getAttribute('aria-activedescendant'));
function assertClosed(control) {
    assert.equal(popup(), null, '閉じたpopupはbodyから除去される');
    assert.equal(control.getAttribute('aria-expanded'), 'false');
    assert.equal(control.getAttribute('aria-activedescendant'), null);
    assert.equal(control.getAttribute('aria-controls'), null, '存在しないpopupのIDを参照しない');
}

function assertInsideViewport(list) {
    assert.ok(list, '候補を開いたまま位置を更新する');
    const width = parseFloat(list.style.width);
    const left = parseFloat(list.style.left);
    const maxHeight = parseFloat(list.style.maxHeight);
    assert.ok(Number.isFinite(width) && width > 0 && width <= window.innerWidth);
    assert.ok(Number.isFinite(left) && left >= 0 && left + width <= window.innerWidth);
    assert.ok(Number.isFinite(maxHeight) && maxHeight >= 0 && maxHeight <= window.innerHeight);
    if (list.style.top && list.style.top !== 'auto') {
        const top = parseFloat(list.style.top);
        assert.ok(top >= 0 && top + maxHeight <= window.innerHeight);
    } else {
        const bottom = parseFloat(list.style.bottom);
        assert.ok(Number.isFinite(bottom) && bottom >= 0 && bottom + maxHeight <= window.innerHeight);
    }
}

test('初期種別と全アイコン候補を表示し、クリック確定前に値・表示・ariaを同期する', async t => {
    const { add, documentEvents } = await fixture(t);
    const { control } = add();
    assert.equal(control.getAttribute('aria-label'), `種別: ${DEVICE_TYPES.router.label}`);
    assert.equal(control.getAttribute('aria-controls'), null);
    assert.equal(control.value, 'router');
    assert.equal(control.textContent, DEVICE_TYPES.router.label);
    assert.equal(control.querySelector('img').src, DEVICE_TYPES.router.icon);
    control.focus();
    await control.dispatch('click');
    const list = popup();
    assert.equal(list.getAttribute('role'), 'listbox');
    assert.equal(control.getAttribute('aria-expanded'), 'true');
    assert.equal(control.getAttribute('aria-controls'), list.id);
    assert.equal(document.getElementById(control.getAttribute('aria-controls')), list);
    assert.equal(activeOption(control).value, 'router');
    assert.deepEqual(options().map(option => option.value), Object.keys(DEVICE_TYPES));
    for (const option of options()) {
        assert.equal(option.querySelector('img').classList.contains('device-type-icon'), true);
        assert.equal(option.querySelector('img').src, DEVICE_TYPES[option.value].icon);
        assert.equal(option.querySelector('span').textContent, DEVICE_TYPES[option.value].label);
        assert.equal(option.getAttribute('aria-selected'), String(option.value === 'router'));
    }
    const target = optionFor('server');
    await documentEvents.dispatch('pointerdown', { target });
    assert.equal(popup(), list, '候補内のpointerdownは外側クリックではない');
    let prevented = false;
    // WorkspaceElementはbubbleしないため、候補をtargetにした実popupイベントを送る。
    await list.dispatch('pointerdown', { target, preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(document.activeElement, control);
    await target.dispatch('click');
    assert.equal(control.value, 'server');
    assert.equal(control.textContent, DEVICE_TYPES.server.label);
    assert.equal(control.getAttribute('aria-label'), `種別: ${DEVICE_TYPES.server.label}`);
    assert.equal(control.querySelector('img').src, DEVICE_TYPES.server.icon);
    assertClosed(control);
    await control.dispatch('click');
    assert.equal(document.getElementById(control.getAttribute('aria-controls')), popup());
    assert.equal(activeOption(control).value, 'server');
    assert.equal(optionFor('server').getAttribute('aria-selected'), 'true');
});

test('矢印・Home・Endは未確定候補だけを移動し、EnterとSpaceで単一選択を確定する', async t => {
    const { add } = await fixture(t);
    const { control, changes } = add();
    control.focus();
    await control.dispatch('keydown', { key: 'ArrowDown' });
    assert.equal(control.getAttribute('aria-expanded'), 'true');
    await control.dispatch('keydown', { key: 'Home' });
    assert.equal(activeOption(control).value, Object.keys(DEVICE_TYPES)[0]);
    await control.dispatch('keydown', { key: 'ArrowDown' });
    assert.equal(activeOption(control).value, Object.keys(DEVICE_TYPES)[1]);
    await control.dispatch('keydown', { key: 'ArrowUp' });
    assert.equal(activeOption(control).value, Object.keys(DEVICE_TYPES)[0]);
    await control.dispatch('keydown', { key: 'End' });
    assert.equal(activeOption(control).value, Object.keys(DEVICE_TYPES).at(-1));
    assert.equal(control.value, 'router');
    assert.equal(changes.length, 0);
    assert.equal(document.activeElement, control);
    await control.dispatch('keydown', { key: 'Enter' });
    assert.equal(control.value, Object.keys(DEVICE_TYPES).at(-1));
    assert.equal(changes.length, 1);
    assertClosed(control);
    await control.dispatch('click');
    await control.dispatch('keydown', { key: 'Home' });
    await control.dispatch('keydown', { key: ' ' });
    assert.equal(control.value, Object.keys(DEVICE_TYPES)[0]);
    assert.equal(changes.length, 2);
    assertClosed(control);
});

test('Esc・Tab・外側クリック・blurで未確定移動を破棄し、IME中のキーを横取りしない', async t => {
    const { add, body, documentEvents } = await fixture(t);
    const { control, changes } = add();
    let prevented = false;
    await control.dispatch('keydown', { key: 'ArrowDown', isComposing: true, preventDefault() { prevented = true; } });
    assert.equal(popup(), null);
    assert.equal(prevented, false);
    for (const action of ['Escape', 'Tab', 'outside', 'blur']) {
        await control.dispatch('click');
        await control.dispatch('keydown', { key: 'End' });
        const beforeActive = activeOption(control);
        await control.dispatch('keydown', { key: 'Home', isComposing: true });
        assert.equal(activeOption(control), beforeActive);
        await control.dispatch('keydown', { key: 'Enter', isComposing: true });
        assert.equal(control.value, 'router');
        if (action === 'outside') await documentEvents.dispatch('pointerdown', { target: body });
        else if (action === 'blur') await control.dispatch('blur');
        else {
            let stopped = false;
            let tabPrevented = false;
            await control.dispatch('keydown', {
                key: action, stopPropagation() { stopped = true; },
                preventDefault() { tabPrevented = true; }
            });
            if (action === 'Escape') assert.equal(stopped, true, '親モーダルのEscに伝播しない');
            if (action === 'Tab') assert.equal(tabPrevented, false, '通常のTabフォーカス移動を妨げない');
        }
        assertClosed(control);
        assert.equal(control.value, 'router');
        assert.equal(changes.length, 0);
    }
});
test('documentのEscapeキャプチャ監視時も開いている候補だけを閉じ、台帳の閉鎖を抑止する', async t => {
    const { add, close } = await fixture(t);
    const { control } = add();
    const { onKeyDown } = await import('../public/js/canvas/selection.js');
    const { registerModalOpen, registerModalClose } = await import('../public/js/core/modal-focus.js');
    const ledgerOverlay = document.querySelector('.ledger-overlay');
    ledgerOverlay.id = 'ledger-overlay';
    registerModalOpen('ledger', ledgerOverlay);

    await control.dispatch('click');
    assert.notEqual(popup(), null, '種別候補が開いている');

    let ledgerClosed = false;
    let stopped = false;
    const escapeEvent = {
        key: 'Escape',
        preventDefault() {},
        stopImmediatePropagation() { stopped = true; }
    };

    await onKeyDown(escapeEvent);
    assert.equal(stopped, true, 'Escapeの伝播が停止する');
    assertClosed(control);
    assert.equal(ledgerOverlay.hidden, false, '台帳自体は閉じない');
    registerModalClose('ledger');
});


test('画面端の候補位置をclampし、scrollとresizeで現在の矩形・viewportに追従する', async t => {
    const { add, windowEvents } = await fixture(t);
    const { control } = add();
    control.rect = { left: 980, right: 1140, top: 650, bottom: 682, width: 160, height: 32 };
    await control.dispatch('click');
    const list = popup();
    assertInsideViewport(list);
    const initialPosition = [list.style.left, list.style.top, list.style.bottom];
    control.rect = { left: -30, right: 130, top: 40, bottom: 72, width: 160, height: 32 };
    await windowEvents.dispatch('scroll');
    assert.equal(popup(), list);
    assertInsideViewport(list);
    assert.notDeepEqual([list.style.left, list.style.top, list.style.bottom], initialPosition);
    window.innerWidth = 120;
    window.innerHeight = 180;
    await windowEvents.dispatch('resize');
    assert.equal(popup(), list);
    assertInsideViewport(list);
    assert.ok(parseFloat(list.style.width) < control.rect.width);
});

for (const guard of ['disabled', 'viewer', 'authExpired', 'isPinging']) {
    test(`${guard}は開く操作と、開いた後に届いたクリック・キー確定を拒否する`, async t => {
        const { add } = await fixture(t);
        const { control, changes } = add();
        const block = enabled => {
            if (guard === 'disabled') control.disabled = enabled;
            else if (guard === 'viewer') window.APP_CONFIG.user.isAdmin = !enabled;
            else appState[guard] = enabled;
        };
        block(true);
        await control.dispatch('click');
        await control.dispatch('keydown', { key: 'ArrowDown' });
        assert.equal(popup(), null);
        assert.equal(changes.length, 0);
        for (const action of ['click', 'keyboard']) {
            block(false);
            await control.dispatch('click');
            const target = optionFor('server');
            block(true);
            if (action === 'click') await target.dispatch('click');
            else {
                await control.dispatch('keydown', { key: 'End' });
                await control.dispatch('keydown', { key: 'Enter' });
            }
            assert.equal(control.value, 'router');
            assert.equal(control.textContent, DEVICE_TYPES.router.label);
            assert.equal(changes.length, 0);
            assertClosed(control);
        }
        block(false);
    });
}

test('disabled指定の生成時にも開かず、再作成・行切替・明示closeでpopupを残さない', async t => {
    const { add, body, documentEvents, close } = await fixture(t);
    const disabled = add({ disabled: true });
    assert.equal(disabled.control.disabled, true);
    await disabled.control.dispatch('click');
    assert.equal(popup(), null);
    const first = add();
    await first.control.dispatch('click');
    const oldPopup = popup();
    const second = add({ value: 'ap' });
    await second.control.dispatch('click');
    assert.equal(oldPopup.isConnected, false);
    assert.equal(first.control.getAttribute('aria-expanded'), 'false');
    assert.equal(body.querySelectorAll('.device-type-options').length, 1);
    assert.equal(activeOption(second.control).value, 'ap');
    close();
    close();
    assertClosed(second.control);
    assert.equal(first.changes.length, 0);
    assert.equal(second.changes.length, 0);
    first.element.remove();
    second.element.remove();
    const replacement = add({ value: 'printer' });
    await replacement.control.dispatch('click');
    assert.equal(body.querySelectorAll('.device-type-options').length, 1);
    assert.equal(activeOption(replacement.control).value, 'printer');
    await documentEvents.dispatch('pointerdown', { target: body });
    assertClosed(replacement.control);
});

test('個票の候補をdialog内へ置き、既存panelボタンの再初期化で変更callbackを増殖させない', async t => {
    const { body, picker } = await fixture(t);
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    body.appendChild(dialog);
    const control = document.createElement('button');
    control.id = 'p-type';
    dialog.appendChild(control);
    let changes = 0;
    picker.createDeviceTypePicker({ control, value: 'router', onChange: () => { changes += 100; } });
    await control.dispatch('click');
    assert.equal(dialog.contains(popup()), true, 'モーダルのフォーカス境界から候補を外へ出さない');
    picker.createDeviceTypePicker({ control, value: 'switch', onChange: () => { changes++; } });
    assertClosed(control);
    assert.equal(control.textContent, DEVICE_TYPES.switch.label);
    await control.dispatch('click');
    await optionFor('server').dispatch('click');
    assert.equal(changes, 1);
    assert.equal(control.querySelectorAll('img').length, 1);
    assert.equal(control.getAttribute('aria-label'), `種別: ${DEVICE_TYPES.server.label}`);
});
