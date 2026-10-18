import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WorkspaceElement } from './helpers/workspace-dom.mjs';
import { syncLedgerFilterPicker, closeLedgerFilterPickers } from '../public/js/ui/ledger-filter-picker.js';

class SelectElement extends WorkspaceElement {
    get options() { return this.children.filter(child => child.tagName === 'OPTION'); }
    get selectedOptions() { return this.options.filter(option => option.selected); }
}

function fixture(t) {
    const originals = new Map(['document', 'window'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const body = new SelectElement('body');
    const events = new SelectElement();
    globalThis.document = {
        body, activeElement: body, createElement: tag => new SelectElement(tag),
        addEventListener: events.addEventListener.bind(events)
    };
    globalThis.window = { innerWidth: 1000, innerHeight: 700, addEventListener() {} };
    t.after(() => {
        closeLedgerFilterPickers();
        for (const [key, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    });
    const add = (id, values) => {
        const parent = body.appendChild(new SelectElement('div'));
        const select = parent.appendChild(new SelectElement('select', id));
        values.forEach(([value, label]) => {
            const option = select.appendChild(new SelectElement('option'));
            option.value = value; option.textContent = label; option.selected = false;
        });
        let applied = [];
        const changed = () => { applied = select.selectedOptions.map(option => option.value); syncLedgerFilterPicker(select, id, changed); };
        syncLedgerFilterPicker(select, id, changed);
        const trigger = parent.querySelector('button');
        trigger.getBoundingClientRect = () => ({ left: 10, top: 80, bottom: 112, width: 160 });
        return { select, trigger, popup: parent.querySelector('[role="listbox"]'), applied: () => applied };
    };
    return { add, events, body };
}

test('矢印とEnter/Spaceで複数候補を追加・解除し、閉じても選択を保持する', async t => {
    const { add } = fixture(t);
    const { select, trigger, popup, applied } = add('types', [['switch', 'L2スイッチ'], ['l3_switch', 'L3スイッチ'], ['router', 'ルータ']]);
    trigger.focus();
    await trigger.dispatch('keydown', { key: 'ArrowDown' });
    await trigger.dispatch('keydown', { key: 'Enter' });
    await trigger.dispatch('keydown', { key: 'ArrowDown' });
    await trigger.dispatch('keydown', { key: ' ' });
    assert.deepEqual(applied(), ['switch', 'l3_switch']);
    assert.equal(popup.hidden, false);
    assert.equal(document.activeElement, trigger);
    assert.deepEqual(popup.children.map(item => item.getAttribute('aria-selected')), ['true', 'true', 'false']);
    await trigger.dispatch('keydown', { key: 'Home' });
    await trigger.dispatch('keydown', { key: ' ' });
    assert.deepEqual(applied(), ['l3_switch']);
    let stopped = false;
    await trigger.dispatch('keydown', { key: 'Escape', stopPropagation() { stopped = true; } });
    assert.equal(stopped, true, 'Escは親モーダルまで伝播しない');
    assert.equal(popup.hidden, true);
    assert.deepEqual(select.selectedOptions.map(option => option.value), ['l3_switch']);
    await trigger.dispatch('click');
    assert.equal(trigger.getAttribute('aria-activedescendant'), popup.children[1].id);
    await trigger.dispatch('keydown', { key: 'End' });
    await trigger.dispatch('keydown', { key: 'Enter' });
    assert.deepEqual(applied(), ['l3_switch', 'router']);
    await trigger.dispatch('keydown', { key: 'Tab' });
    assert.equal(popup.hidden, true);
    assert.equal(trigger.getAttribute('aria-activedescendant'), null);
});

test('他項目の外側クリック監視が開いた候補を閉じず、外側・blurは選択を保持して閉じる', async t => {
    const { add, events, body } = fixture(t);
    const first = add('facility', [['a', '施設A'], ['b', '施設B']]);
    const second = add('floor', [['1', '1F'], ['2', '2F']]);
    await first.trigger.dispatch('click');
    await events.dispatch('pointerdown', { target: first.popup.children[1] });
    assert.equal(first.popup.hidden, false);
    await first.popup.children[1].dispatch('click');
    assert.deepEqual(first.applied(), ['b']);
    await second.trigger.dispatch('click');
    assert.equal(first.popup.hidden, true);
    assert.equal(second.popup.hidden, false);
    await events.dispatch('pointerdown', { target: body });
    assert.equal(second.popup.hidden, true);
    await first.trigger.dispatch('click');
    await first.trigger.dispatch('blur');
    assert.equal(first.popup.hidden, true);
    assert.deepEqual(first.select.selectedOptions.map(option => option.value), ['b']);
});

test('候補の追加・改名・削除後は古い候補を操作せず、現在の候補を操作する', async t => {
    const { add } = fixture(t);
    const { select, trigger, popup } = add('views', [['7', '同名 (ID: 7)'], ['8', '同名 (ID: 8)']]);
    await trigger.dispatch('click');
    await popup.children[1].dispatch('click');
    select.options[1].value = '108';
    select.options[1].textContent = '改名 (ID: 108)';
    syncLedgerFilterPicker(select, '表示ビュー', () => {});
    assert.equal(popup.hidden, false);
    await popup.children[1].dispatch('click');
    assert.deepEqual(select.selectedOptions.map(option => option.value), []);
    select.options[0].remove();
    syncLedgerFilterPicker(select, '表示ビュー', () => {});
    await popup.children[0].dispatch('click');
    assert.deepEqual(select.selectedOptions.map(option => option.value), ['108']);
    select.replaceChildren();
    syncLedgerFilterPicker(select, '表示ビュー', () => {});
    assert.equal(popup.hidden, true);
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
});

test('処理中の無効化は開いた候補の値を変えず、解除後に操作を再開できる', async t => {
    const { add } = fixture(t);
    const { select, trigger, popup } = add('status', [['green', 'OK'], ['red', 'NG']]);
    await trigger.dispatch('click');
    await popup.children[0].dispatch('click');
    select.disabled = true;
    await popup.children[1].dispatch('click');
    assert.deepEqual(select.selectedOptions.map(option => option.value), ['green']);
    syncLedgerFilterPicker(select, '状態', () => {});
    assert.equal(trigger.disabled, true);
    assert.equal(popup.hidden, true);
    await trigger.dispatch('click');
    assert.equal(popup.hidden, true);
    select.disabled = false;
    syncLedgerFilterPicker(select, '状態', () => {});
    assert.equal(trigger.disabled, false);
    await trigger.dispatch('click');
    await trigger.dispatch('keydown', { key: 'End' });
    await trigger.dispatch('keydown', { key: 'Enter' });
    assert.deepEqual(select.selectedOptions.map(option => option.value), ['green', 'red']);
});
