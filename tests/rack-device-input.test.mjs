import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appState } from '../public/js/core/state.js';
import { DEVICE_TYPES } from '../public/js/core/constants.js';
import { getDefaultDeviceName } from '../public/js/core/device-defaults.js';
import { createRackDeviceInput } from '../public/js/ui/rack-device-input.js';
import { closeDeviceTypePicker } from '../public/js/ui/device-type-picker.js';
import { installWorkspaceDom } from './helpers/workspace-dom.mjs';

const devices = [
    { id: 11, name: '試験ルータ', type: 'router', ip: '192.0.2.11', model: '試験モデルA' },
    { id: 12, name: '試験サーバ', type: 'server', ip: '', model: '試験モデルB' },
    { id: 13, name: '予備ルータ', type: 'router', ip: '192.0.2.13', model: '試験モデルC' }
];

function fixture(t, options = {}) {
    const globals = new Map(['document', 'window', 'Element', 'HTMLElement'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const state = new Map(['devices', 'authExpired', 'isPinging'].map(key => [key, Object.getOwnPropertyDescriptor(appState, key)]));
    installWorkspaceDom();
    Object.assign(appState, { devices: devices.map(device => ({ ...device })), authExpired: false, isPinging: false });
    const changes = [];
    const input = createRackDeviceInput({
        idPrefix: 'test-mount', locationText: device => `現在地${device.id}`,
        ...options, onChange: () => changes.push({ selectedId: input.selectedId, mode: input.mode, values: input.values })
    });
    document.body.appendChild(input.element);
    t.after(() => {
        closeDeviceTypePicker();
        document.body.replaceChildren();
        for (const [key, descriptor] of state) {
            if (descriptor) Object.defineProperty(appState, key, descriptor);
            else delete appState[key];
        }
        for (const [key, descriptor] of globals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    });
    const get = suffix => input.element.querySelector(`#test-mount-${suffix}`);
    return { input, changes, get, options: () => get('candidates').querySelectorAll('[role="option"]') };
}

async function key(control, value, extra = {}) {
    let prevented = false;
    let stopped = false;
    await control.dispatch('keydown', { key: value, preventDefault() { prevented = true; }, stopPropagation() { stopped = true; }, ...extra });
    return { prevented, stopped };
}

async function edit(control, value) {
    control.value = value;
    await control.dispatch('input');
}

test('空の検索はfocusとclickの両方で全候補を開き、機器情報を表示する', async t => {
    const { input, changes, get, options } = fixture(t);
    assert.equal(changes.length, 0);
    assert.equal(input.mode, 'existing');
    assert.equal(input.selectedId, null);
    assert.equal(get('filter').value, '');
    assert.equal(get('filter').getAttribute('role'), 'combobox');
    assert.equal(get('filter').textContent, 'すべての種別');
    assert.equal(get('filter').querySelector('img').src, DEVICE_TYPES.other.icon);
    assert.equal(input.element.querySelector('.rack-device-summary').hidden, true);
    assert.equal(input.search.getAttribute('role'), 'combobox');
    assert.equal(get('candidates').getAttribute('role'), 'listbox');
    input.search.focus();
    await input.search.dispatch('focus');
    assert.equal(input.candidatesOpen, true);
    assert.equal(input.search.getAttribute('aria-expanded'), 'true');
    assert.equal(input.search.getAttribute('aria-controls'), get('candidates').id);
    assert.equal(options().length, 3);
    assert.equal(options()[0].querySelector('img').src, DEVICE_TYPES.router.icon);
    assert.match(options()[0].textContent, /試験ルータ.*ルータ.*192\.0\.2\.11.*現在地11/);
    assert.match(options()[1].textContent, /IP未設定/);
    const region = input.element.querySelector('.rack-device-candidate-region');
    input.hideCandidates();
    assert.equal(input.element.querySelector('.rack-device-candidate-region'), region);
    assert.equal(input.search.getAttribute('aria-activedescendant'), null);
    await input.search.dispatch('click');
    assert.equal(input.candidatesOpen, true);
    assert.equal(changes.length, 0);
});

test('矢印は候補だけを移動・スクロールし、Enterは開いている場合だけ送信を防ぐ', async t => {
    const { input, get, changes } = fixture(t);
    input.search.focus();
    assert.equal((await key(input.search, 'Enter')).prevented, false);
    await key(input.search, 'ArrowDown');
    assert.equal(input.search.getAttribute('aria-activedescendant'), get('option-11').id);
    let scrollOptions;
    get('option-12').scrollIntoView = options => { scrollOptions = options; };
    await key(input.search, 'ArrowDown');
    assert.deepEqual(scrollOptions, { block: 'nearest' });
    assert.equal(input.selectedId, null);
    assert.equal(changes.length, 0);
    await key(input.search, 'End');
    assert.equal(input.search.getAttribute('aria-activedescendant'), get('option-13').id);
    await key(input.search, 'Home');
    await key(input.search, 'ArrowUp');
    assert.equal(input.search.getAttribute('aria-activedescendant'), get('option-13').id);
    assert.equal((await key(input.search, 'Enter')).prevented, true);
    assert.equal(input.selectedId, 13);
    assert.equal(input.search.value, '予備ルータ');
    assert.equal(input.candidatesOpen, false);
    assert.equal(document.activeElement, input.search);
    assert.equal(changes.length, 1);
    const summary = input.element.querySelector('.rack-device-summary');
    assert.equal(summary.hidden, false);
    assert.match(summary.textContent, /予備ルータ.*ルータ.*192\.0\.2\.13/);
    assert.equal(summary.querySelector('img').src, DEVICE_TYPES.router.icon);
    assert.equal((await key(input.search, 'Enter')).prevented, false);
});

test('ポインター選択は検索のフォーカスを維持し、Escape・Tab・blurで候補を閉じる', async t => {
    const { input, get } = fixture(t);
    input.search.focus();
    await input.search.dispatch('click');
    let prevented = false;
    await get('option-12').dispatch('pointerdown', { preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    await get('option-12').dispatch('click');
    assert.equal(input.selectedId, 12);
    assert.equal(document.activeElement, input.search);
    await input.search.dispatch('click');
    assert.deepEqual(await key(input.search, 'Escape'), { prevented: true, stopped: true });
    assert.equal(input.candidatesOpen, false);
    assert.equal(document.activeElement, input.search);
    await input.search.dispatch('click');
    assert.equal((await key(input.search, 'Tab')).prevented, false);
    assert.equal(input.candidatesOpen, false);
    await input.search.dispatch('click');
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    await input.search.dispatch('blur', { relatedTarget: outside });
    assert.equal(input.candidatesOpen, false);
    assert.equal(document.activeElement, outside);
});

test('種別と検索はAND条件で絞り込み、一致する種別変更は選択を保ち、検索編集は必ず解除する', async t => {
    const { input, get, options } = fixture(t);
    await input.search.dispatch('click');
    await get('option-11').dispatch('click');
    get('filter').value = 'router';
    await get('filter').dispatch('change');
    assert.equal(input.selectedId, 11);
    assert.equal(get('filter').textContent, DEVICE_TYPES.router.label);
    assert.equal(get('filter').querySelector('img').src, DEVICE_TYPES.router.icon);
    assert.equal(options().length, 1);
    await edit(input.search, '192.0.2.13');
    assert.equal(input.selectedId, null);
    assert.equal(input.element.querySelector('.rack-device-summary').hidden, true);
    assert.deepEqual(options().map(option => option.id), ['test-mount-option-13']);
    await get('option-13').dispatch('click');
    await edit(input.search, input.search.value);
    assert.equal(input.selectedId, null, '同じ文字列の入力イベントでも古いIDを残さない');
    await get('option-13').dispatch('click');
    get('filter').value = 'server';
    await get('filter').dispatch('change');
    assert.equal(input.selectedId, null);
    assert.equal(options().length, 0);
    assert.match(get('candidates').textContent, /該当する機器がありません/);
    assert.equal((await key(input.search, 'Enter')).prevented, true);
    assert.equal(input.selectedId, null);
});

test('種別フィルターの全候補をキーボードで選び、未確定移動とキャンセルは検索条件を変えない', async t => {
    const { input, get, options, changes } = fixture(t);
    const filter = get('filter');
    const typeOptions = () => document.body.querySelector('.device-type-options')?.querySelectorAll('[role="option"]') ?? [];
    const activeType = () => typeOptions().find(option => option.id === filter.getAttribute('aria-activedescendant'));
    filter.focus();
    await filter.dispatch('focus');
    await key(filter, 'ArrowDown');
    assert.deepEqual(typeOptions().map(option => option.value), ['', ...Object.keys(DEVICE_TYPES)]);
    assert.equal(activeType().value, '');
    for (const option of typeOptions()) {
        const definition = DEVICE_TYPES[option.value] || DEVICE_TYPES.other;
        assert.equal(option.querySelector('img').src, definition.icon);
        assert.equal(option.textContent, option.value ? definition.label : 'すべての種別');
    }
    await key(filter, 'End');
    assert.equal(activeType().value, 'other');
    assert.equal(filter.value, '');
    assert.equal(changes.length, 0);
    await key(filter, 'Home');
    await key(filter, 'ArrowDown');
    await key(filter, 'ArrowDown');
    await key(filter, 'ArrowDown');
    assert.equal(activeType().value, 'router');
    await key(filter, 'Enter');
    assert.equal(filter.value, 'router');
    assert.equal(filter.textContent, DEVICE_TYPES.router.label);
    assert.equal(input.type.value, 'switch', '新規登録種別とは独立している');
    assert.deepEqual(options().map(option => option.id), ['test-mount-option-11', 'test-mount-option-13']);
    assert.equal(document.activeElement, filter);
    assert.equal(document.body.querySelector('.device-type-options'), null);
    assert.equal(changes.length, 1);
    await key(filter, ' ');
    assert.equal(activeType().value, 'router');
    await key(filter, 'Home');
    assert.deepEqual(await key(filter, 'Escape'), { prevented: true, stopped: true });
    assert.equal(filter.value, 'router');
    await key(filter, 'ArrowUp');
    await key(filter, 'Home');
    assert.equal((await key(filter, 'Tab')).prevented, false);
    assert.equal(filter.value, 'router');
    await filter.dispatch('click');
    await key(filter, 'Home');
    await key(filter, ' ');
    assert.equal(filter.value, '');
    assert.equal(filter.textContent, 'すべての種別');
    assert.equal(filter.querySelector('img').src, DEVICE_TYPES.other.icon);
    assert.equal(options().length, 3);
    assert.equal(changes.length, 2);
    await get('new-mode').dispatch('click');
    input.type.value = 'server';
    await input.type.dispatch('change');
    await get('existing-mode').dispatch('click');
    assert.equal(filter.value, '');
    assert.equal(input.type.value, 'server');
});

test('候補供給・モデル検索・現在地表示を利用側から差し替えられる', async t => {
    let available = devices.slice(1);
    const { input, get, options } = fixture(t, {
        getDevices: () => available,
        searchText: device => `${device.name} ${device.model}`,
        locationText: () => '棚の外'
    });
    await input.search.dispatch('click');
    assert.equal(options().length, 2);
    await edit(input.search, 'モデルB');
    assert.equal(options().length, 1);
    assert.match(get('option-12').textContent, /棚の外/);
    available = [];
    await input.search.dispatch('click');
    assert.equal(options().length, 0);
});

test('モード切替は選択・候補・種別popupを破棄し、対応する入力へフォーカスする', async t => {
    const { input, get, changes } = fixture(t);
    await input.search.dispatch('click');
    await get('option-11').dispatch('click');
    await get('new-mode').dispatch('click');
    assert.equal(input.mode, 'new');
    assert.equal(input.selectedId, null);
    assert.equal(input.candidatesOpen, false);
    assert.equal(input.element.querySelector('.rack-device-existing').hidden, true);
    assert.equal(input.element.querySelector('.rack-device-new').hidden, false);
    assert.equal(input.element.querySelector('.rack-device-summary').hidden, true);
    assert.equal(get('existing-mode').getAttribute('aria-pressed'), 'false');
    assert.equal(get('new-mode').getAttribute('aria-pressed'), 'true');
    assert.equal(document.activeElement, input.type);
    await input.type.dispatch('click');
    assert.ok(document.body.querySelector('.device-type-options'));
    await get('existing-mode').dispatch('click');
    assert.equal(document.body.querySelector('.device-type-options'), null);
    assert.equal(input.mode, 'existing');
    assert.equal(input.search.value, '');
    assert.equal(document.activeElement, input.search);
    assert.equal(changes.length, 3);
});

test('種別変更は自動機器名だけを更新し、カスタム名・空名の既定値・任意IPを扱う', async t => {
    const { input, get, changes } = fixture(t);
    assert.equal(input.type.value, 'switch');
    assert.equal(input.name.value, getDefaultDeviceName('switch'));
    await get('new-mode').dispatch('click');
    await input.type.dispatch('click');
    const server = document.body.querySelector('.device-type-options').querySelectorAll('[role="option"]').find(option => option.value === 'server');
    const before = changes.length;
    await server.dispatch('click');
    assert.equal(changes.length, before + 1);
    assert.equal(input.name.value, getDefaultDeviceName('server'));
    assert.equal(input.type.textContent, DEVICE_TYPES.server.label);
    await edit(input.name, '  試験機器  ');
    input.type.value = 'router';
    await input.type.dispatch('change');
    assert.equal(input.name.value, '  試験機器  ');
    assert.equal(input.type.textContent, DEVICE_TYPES.router.label);
    await edit(input.ip, '  192.0.2.99  ');
    assert.deepEqual(input.values, { name: '試験機器', ip: '192.0.2.99' });
    await edit(input.name, '   ');
    input.type.value = 'pc';
    await input.type.dispatch('change');
    assert.deepEqual(input.values, { name: getDefaultDeviceName('pc'), ip: '192.0.2.99' });
    await edit(input.ip, '');
    assert.equal(input.values.ip, '');
});

test('canChangeが偽の間は選択・モード・検索・種別・入力値を変更しない', async t => {
    let allowed = true;
    const { input, get, changes } = fixture(t, { canChange: () => allowed });
    await input.search.dispatch('click');
    allowed = false;
    await get('option-11').dispatch('click');
    await get('new-mode').dispatch('click');
    await edit(input.search, '変更不可');
    get('filter').value = 'server';
    await get('filter').dispatch('change');
    assert.equal(input.search.value, '');
    assert.equal(get('filter').value, '');
    assert.equal(get('filter').textContent, 'すべての種別');
    assert.equal(get('filter').querySelector('img').src, DEVICE_TYPES.other.icon);
    assert.equal(input.selectedId, null);
    assert.equal(input.mode, 'existing');
    assert.equal(changes.length, 0);
    allowed = true;
    await get('new-mode').dispatch('click');
    allowed = false;
    const saved = input.values;
    await edit(input.name, '変更不可');
    await edit(input.ip, '192.0.2.55');
    input.type.value = 'server';
    await input.type.dispatch('change');
    assert.equal(input.type.value, 'switch');
    assert.deepEqual(input.values, saved);
    assert.equal(changes.length, 1);
});

test('既存配置の編集は機器を固定し、検索・モード・種別フィルターを操作させない', async t => {
    const { input, get, changes } = fixture(t, { deviceId: 12 });
    assert.equal(input.selectedId, 12);
    assert.equal(input.search.value, '試験サーバ');
    assert.equal(input.search.readOnly, true);
    assert.equal(input.element.querySelector('.rack-device-existing').hidden, true);
    const summary = input.element.querySelector('.rack-device-summary');
    assert.equal(summary.hidden, false);
    assert.match(summary.textContent, /試験サーバ.*サーバ.*IP未設定/);
    assert.equal(summary.querySelector('img').src, DEVICE_TYPES.server.icon);
    assert.equal(summary.querySelector('input'), null);
    assert.equal(summary.querySelector('button'), null);
    assert.equal(input.element.querySelector('.rack-device-modes').hidden, true);
    await input.search.dispatch('click');
    await key(input.search, 'ArrowDown');
    await get('new-mode').dispatch('click');
    await edit(input.search, '別の機器');
    assert.equal(input.search.value, '試験サーバ');
    assert.equal(input.mode, 'existing');
    assert.equal(input.selectedId, 12);
    assert.equal(input.candidatesOpen, false);
    assert.equal(changes.length, 0);
});
