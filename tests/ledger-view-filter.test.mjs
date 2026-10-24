import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WorkspaceElement } from './helpers/workspace-dom.mjs';

// 台帳で使う子孫セレクタとdatasetを、共有fixtureを変えずに補う。
class LedgerElement extends WorkspaceElement {
    get selected() { return this._selected ?? false; }
    set selected(value) { this._selected = Boolean(value); }
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
    getAttribute(name) {
        if (name.startsWith('data-')) {
            const key = name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
            return this.dataset[key] ?? null;
        }
        return super.getAttribute(name);
    }
    querySelectorAll(selector) {
        const groups = selector.split(',').map(group => group.trim().split(/\s+/));
        const matchesGroup = (node, parts) => {
            if (!node.matches(parts.at(-1))) return false;
            let ancestor = node.parentElement;
            for (let index = parts.length - 2; index >= 0; index--) {
                while (ancestor && !ancestor.matches(parts[index])) ancestor = ancestor.parentElement;
                if (!ancestor) return false;
                ancestor = ancestor.parentElement;
            }
            return true;
        };
        const result = [];
        const walk = node => {
            for (const child of node.children) {
                if (groups.some(parts => matchesGroup(child, parts))) result.push(child);
                walk(child);
            }
        };
        walk(this);
        return result;
    }
    closest(selector) {
        const parts = selector.trim().split(/\s+/);
        for (let node = this; node; node = node.parentElement) {
            if (!node.matches(parts.at(-1))) continue;
            let ancestor = node.parentElement;
            let index = parts.length - 2;
            for (; index >= 0; index--) {
                while (ancestor && !ancestor.matches(parts[index])) ancestor = ancestor.parentElement;
                if (!ancestor) break;
                ancestor = ancestor.parentElement;
            }
            if (index < 0) return node;
        }
        return null;
    }
}

const filterIds = ['ledger-search', 'ledger-view-filter', 'ledger-facility-filter', 'ledger-floor-filter', 'ledger-status-filter', 'ledger-type-filter', 'ledger-ip-presence-filter', 'ledger-placement-filter', 'ledger-maintenance-expiry-filter'];

test('ビュー限定台帳は配置IDを使い、既存台帳の操作と条件遷移を保つ', async t => {
    const keys = ['window', 'document', 'fetch', 'confirm', 'localStorage', 'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLTextAreaElement', 'HTMLButtonElement'];
    const originals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    let cleanup;
    t.after(() => {
        cleanup?.();
        for (const [key, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    });
    const body = new LedgerElement('body');
    const add = (tag, id, parent = body) => parent.appendChild(new LedgerElement(tag, id));
    const get = id => body.querySelector(`#${id}`);
    const overlay = add('div', 'ledger-overlay');
    const table = add('table', 'ledger-table', overlay);
    add('thead', '', table);
    const rows = add('tbody', 'ledger-table-body', table);
    const presetSelect = add('select', 'ledger-column-preset', overlay);
    for (const value of ['standard', 'placement', 'asset', 'maintenance', 'monitoring', 'all']) {
        const option = add('option', '', presetSelect);
        option.value = value;
    }
    for (const id of filterIds) {
        const element = add(id === 'ledger-search' ? 'input' : 'select', id, overlay);
        if (element.tagName === 'SELECT') element.multiple = true;
    }
    for (const [id, values] of [
        ['ledger-status-filter', ['green', 'red', 'unknown']],
        ['ledger-ip-presence-filter', ['registered', 'empty']],
        ['ledger-placement-filter', ['placed', 'unplaced']]
    ]) {
        for (const value of values) {
            const option = add('option', '', get(id));
            option.value = value;
        }
    }
    for (const id of ['ledger-active-filters', 'ledger-active-filter-list', 'ledger-count', 'ledger-selection-summary']) add('div', id, overlay);
    for (const id of ['ledger-filter-reset-btn', 'ledger-bulk-edit-btn', 'ledger-save-btn', 'ledger-ping-btn', 'ledger-clear-selection-btn']) add('button', id, overlay);
    for (const id of ['ledger-device-sheet-overlay', 'ledger-sheet-body', 'ledger-sheet-title', 'ledger-bulk-edit-overlay', 'ledger-bulk-edit-body', 'ledger-bulk-edit-fields', 'ledger-bulk-edit-title', 'ledger-bulk-edit-count', 'ledger-bulk-edit-form', 'ledger-bulk-edit-confirm', 'ledger-bulk-edit-preview', 'ledger-bulk-edit-warning', 'ledger-bulk-edit-error', 'status-toast-message']) add('div', id);
    for (const id of ['ledger-sheet-save-btn', 'ledger-sheet-prev-btn', 'ledger-sheet-next-btn', 'ledger-bulk-edit-next', 'ledger-bulk-edit-apply']) add('button', id);
    get('ledger-device-sheet-overlay').hidden = get('ledger-bulk-edit-overlay').hidden = true;
    globalThis.document = {
        body, activeElement: body, getElementById: get,
        querySelector: selector => body.querySelector(selector), querySelectorAll: selector => body.querySelectorAll(selector),
        createElement: tag => new LedgerElement(tag), createTextNode: text => Object.assign(new LedgerElement('span'), { textContent: text }),
        addEventListener() {}, removeEventListener() {}
    };
    globalThis.window = {
        APP_CONFIG: { user: { isAdmin: true }, csrfToken: 'test-only-token' },
        addEventListener() {}, requestAnimationFrame: callback => callback(),
        getComputedStyle: () => ({ display: 'block', visibility: 'visible' }), clearTimeout,
        setTimeout(callback, delay) { const timer = setTimeout(callback, delay); timer.unref(); return timer; }
    };
    for (const key of keys.filter(key => key === 'Element' || key.startsWith('HTML'))) globalThis[key] = LedgerElement;
    const storage = new Map();
    const presetWrites = [];
    globalThis.localStorage = {
        getItem: key => storage.get(key) ?? null,
        setItem(key, value) { storage.set(key, value); presetWrites.push([key, value]); }
    };
    globalThis.confirm = () => false;
    const { appState, normalizeDevice } = await import('../public/js/core/state.js');
    const { eventBus } = await import('../public/js/core/event-bus.js');
    const { resetResourceBaseline } = await import('../public/js/core/resource-save.js');
    const drafts = await import('../public/js/core/device-drafts.js');
    const ledger = await import('../public/js/modals/ledger-modal.js');
    const queue = await import('../public/js/core/save-queue.js');
    const stopLedgerRender = eventBus.on('ledger:render', ledger.renderLedgerTable);
    t.after(stopLedgerRender);
    const seed = () => {
        // 機器順はID順/名称順ではなく、配置順も意図的に異なる。
        appState.devices = [
            { id: 30, name: '対象 Z', type: 'switch', facility: '施設A', floor: '1F', ip: '192.0.2.30' },
            { id: 10, name: '対象 A', type: 'router', facility: '施設A', floor: '1F' },
            { id: 20, name: '対象 M', type: 'switch', facility: '施設B', floor: '2F' },
            { id: 40, name: '対象 Other', type: 'switch', facility: '施設A', floor: '1F' },
            { id: 50, name: '対象 Unplaced', type: 'switch', facility: '施設A', floor: '1F' }
        ].map(device => normalizeDevice({ ...device, resource_revision: 1 }));
        appState.views = [{ id: 7, name: '同名ビュー', view_type: 'topology' }, { id: 8, name: '同名ビュー', view_type: 'topology' }, { id: 9, name: '空ビュー', view_type: 'topology' }];
        appState.placements = [
            { id: 1, view_id: 7, device_id: 20, x: 0, y: 0 },
            { id: 2, view_id: 7, device_id: 30, x: 1, y: 1 },
            { id: 3, view_id: 7, device_id: 10, x: 2, y: 2 },
            { id: 4, view_id: 8, device_id: 40, x: 3, y: 3 },
            { id: 5, view_id: 8, device_id: 30, x: 4, y: 4 }
        ];
        appState.currentViewId = 7;
        appState.links = []; appState.deviceImages = [];
        appState.resourceConflicts = { devices: new Map(), views: new Map() };
        drafts.discardDeviceDrafts(); queue.clearPendingSave();
        storage.set(ledger.LEDGER_COLUMN_PRESET_KEY, 'standard');
        presetWrites.length = 0;
        ledger.ledgerSelectedDeviceIds.clear();
        filterIds.forEach(id => { get(id).value = ''; });
        window.APP_CONFIG.user.isAdmin = true;
        resetResourceBaseline(appState);
        appState.appStatus.dirty = false; appState.authExpired = false; appState.isPinging = false;
        ledger.openLedger();
        get('status-toast-message').textContent = '';
    };
    const visibleIds = () => rows.querySelectorAll('tr[data-device-id]').map(row => Number(row.dataset.deviceId));
    const row = id => rows.querySelector(`tr[data-device-id="${id}"]`);
    const chooseValues = (id, values) => {
        const selected = new Set(values.map(String));
        for (const option of get(id).options) option.selected = selected.has(option.value);
    };
    const removeChip = async (key, value) => {
        const index = ledger.getLedgerActiveFilterItems().findIndex(item => item.key === key && String(item.value) === String(value));
        assert.notEqual(index, -1, `${key}=${value} のチップが存在する`);
        await get('ledger-active-filter-list').querySelectorAll('button')[index].dispatch('click');
    };
    const select = async id => {
        const checkbox = row(id).querySelector('input[type="checkbox"]');
        checkbox.checked = true;
        await checkbox.dispatch('change');
    };
    cleanup = () => { drafts.discardDeviceDrafts(); queue.clearPendingSave(); };
    await t.test('7項目は各項目内ORで機器順を保ち、ビュー和集合も重複しない', () => {
        seed();
        appState.devices[0].status = 'green'; appState.devices[1].status = 'red';
        const cases = [
            ['ledger-view-filter', [7, 8], [30, 10, 20, 40]],
            ['ledger-facility-filter', ['施設A', '施設B'], [30, 10, 20, 40, 50]],
            ['ledger-floor-filter', ['1F', '2F'], [30, 10, 20, 40, 50]],
            ['ledger-status-filter', ['green', 'red'], [30, 10]],
            ['ledger-type-filter', ['switch', 'router'], [30, 10, 20, 40, 50]],
            ['ledger-ip-presence-filter', ['registered', 'empty'], [30, 10, 20, 40, 50]],
            ['ledger-placement-filter', ['placed', 'unplaced'], [30, 10, 20, 40, 50]]
        ];
        for (const [id, values, expected] of cases) {
            ledger.resetLedgerFilters(); chooseValues(id, values); ledger.renderLedgerTable();
            assert.deepEqual(visibleIds(), expected, id);
            assert.deepEqual(new Set(get(id).selectedOptions.map(option => option.value)), new Set(values.map(String)));
        }
    });

    await t.test('全項目と検索はANDし、0件でも全値とチップを保持する', () => {
        seed();
        ledger.openLedgerWithFilters({
            viewId: [7, 8], facility: ['施設A', '施設B'], floor: ['1F', '2F'],
            status: ['unknown', 'green'], type: ['switch', 'router'],
            ipPresence: ['registered', 'empty'], placement: ['placed', 'unplaced'], maintenanceExpiry: 'unset'
        });
        get('ledger-search').value = '対象'; ledger.renderLedgerTable();
        assert.deepEqual(visibleIds(), [30, 10, 20, 40]);
        chooseValues('ledger-facility-filter', ['施設B']); chooseValues('ledger-type-filter', ['switch']);
        ledger.renderLedgerTable(); assert.deepEqual(visibleIds(), [20]);
        const before = ledger.getLedgerFilterValues();
        get('ledger-search').value = '存在しない検索'; ledger.renderLedgerTable();
        assert.deepEqual(visibleIds(), []);
        assert.deepEqual(ledger.getLedgerFilterValues(), { ...before, keyword: '存在しない検索' });
        assert.equal(ledger.getLedgerActiveFilterItems().length, 14);
    });

    await t.test('各項目の1値チップと検索だけを解除でき、全解除は全値を消す', async () => {
        const cases = [
            ['viewIds', 'viewId', [7, 8], 'ledger-view-filter'],
            ['facility', 'facility', ['施設A', '施設B'], 'ledger-facility-filter'],
            ['floor', 'floor', ['1F', '2F'], 'ledger-floor-filter'],
            ['status', 'status', ['unknown', 'green'], 'ledger-status-filter'],
            ['type', 'type', ['switch', 'router'], 'ledger-type-filter'],
            ['ipPresence', 'ipPresence', ['registered', 'empty'], 'ledger-ip-presence-filter'],
            ['placement', 'placement', ['placed', 'unplaced'], 'ledger-placement-filter'],
            ['maintenanceExpiry', 'maintenanceExpiry', ['expired', 'unset'], 'ledger-maintenance-expiry-filter']
        ];
        for (const [key, inputKey, values, id] of cases) {
            seed(); ledger.openLedgerWithFilters({ [inputKey]: values });
            get('ledger-search').value = '対象'; ledger.renderLedgerTable();
            await removeChip(key, values[0]);
            assert.deepEqual(get(id).selectedOptions.map(option => option.value), [String(values[1])]);
            assert.equal(get('ledger-search').value, '対象');
            await removeChip('keyword', '対象');
            assert.equal(get('ledger-search').value, '');
            assert.deepEqual(get(id).selectedOptions.map(option => option.value), [String(values[1])]);
            ledger.resetLedgerFilters();
            assert.deepEqual(ledger.getLedgerFilterValues(), {
                viewIds: [], keyword: '', facility: [], floor: [], status: [], type: [], ipPresence: [], placement: [], maintenanceExpiry: []
            });
            assert.deepEqual(visibleIds(), [30, 10, 20, 40, 50]);
        }
    });

    const withExpiryReference = async callback => {
        const OriginalDate = globalThis.Date;
        globalThis.Date = class extends OriginalDate {
            constructor(...args) { super(...(args.length ? args : [2026, 9, 23, 12])); }
            static now() { return new OriginalDate(2026, 9, 23, 12).getTime(); }
        };
        try { await callback(); } finally { globalThis.Date = OriginalDate; }
    };
    const seedExpiry = () => {
        seed();
        const values = ['2027-10-23', '2026-10-22', '2028-10-23', '2028-10-24', ''];
        appState.devices.forEach((device, index) => { device.maintenance_expiry = values[index]; });
        appState.devices.push(
            normalizeDevice({ id: 60, name: '不正期限', maintenance_expiry: '2026-02-30' }),
            normalizeDevice({ id: 70, name: '月精度', maintenance_expiry: '2026-10', facility: '施設A', type: 'switch' }),
            normalizeDevice({ id: 80, name: '当日期限', maintenance_expiry: '2026-10-23', facility: '施設A', type: 'switch' }),
            normalizeDevice({ id: 90, name: '月末期限', maintenance_expiry: '2026-10-31', facility: '施設A', type: 'switch' })
        );
        resetResourceBaseline(appState);
    };

    await t.test('期限5区分は境界日を含めて分類し、不正を除外して年月を月末順に並べる', () => withExpiryReference(async () => {
        seedExpiry();
        const original = structuredClone(appState.devices);
        for (const [category, expected] of [
            ['expired', [10]], ['within1Year', [80, 70, 90, 30]],
            ['within2Years', [20]], ['beyond2Years', [40]], ['unset', [50]]
        ]) {
            ledger.openLedgerWithFilters({ maintenanceExpiry: category });
            assert.deepEqual(visibleIds(), expected, category);
            assert.equal(ledger.getActiveLedgerPreset(), 'standard');
        }
        ledger.openLedgerWithFilters({ maintenanceExpiry: ['unset', 'within2Years', 'expired', 'within1Year', 'beyond2Years'] });
        assert.deepEqual(visibleIds(), [10, 80, 70, 90, 30, 20, 40, 50]);
        assert.deepEqual(appState.devices, original);
        ledger.resetLedgerFilters();
        assert.deepEqual(visibleIds(), original.map(device => device.id));
    }));

    await t.test('期限のORとビュー・施設・種別・検索のANDを保ち、期限チップと全解除を統合する', () => withExpiryReference(async () => {
        seedExpiry();
        ledger.openLedgerWithFilters({ maintenanceExpiry: ['expired', 'within1Year'], viewId: 7, facility: '施設A', type: 'switch', keyword: '対象' });
        assert.deepEqual(visibleIds(), [30]);
        await removeChip('maintenanceExpiry', 'within1Year');
        assert.deepEqual(visibleIds(), []);
        assert.deepEqual(ledger.getLedgerFilterValues().maintenanceExpiry, ['expired']);
        await removeChip('maintenanceExpiry', 'expired');
        assert.deepEqual(visibleIds(), [30]);
        assert.deepEqual(ledger.getLedgerFilterValues().viewIds, [7]);
        ledger.resetLedgerFilters();
        assert.equal(ledger.getLedgerActiveFilterItems().length, 0);
        assert.deepEqual(visibleIds(), [30, 10, 20, 40, 50, 60, 70, 80, 90]);
    }));

    await t.test('期限カードだけ保守列を一時表示し、解除・閉じる・通常入口では保存済み列に戻る', () => withExpiryReference(async () => {
        seedExpiry();
        storage.set(ledger.LEDGER_COLUMN_PRESET_KEY, 'asset');
        ledger.openDashboardLedger({ maintenanceExpiry: ['expired', 'within1Year'] });
        assert.equal(ledger.getActiveLedgerPreset(), 'maintenance');
        assert.equal(presetSelect.value, 'maintenance');
        assert.equal(storage.get(ledger.LEDGER_COLUMN_PRESET_KEY), 'asset');
        assert.deepEqual(presetWrites, []);
        await removeChip('maintenanceExpiry', 'expired');
        assert.equal(ledger.getActiveLedgerPreset(), 'maintenance');
        await removeChip('maintenanceExpiry', 'within1Year');
        assert.equal(ledger.getActiveLedgerPreset(), 'asset');
        assert.equal(presetSelect.value, 'asset');
        ledger.openDashboardLedger({ maintenanceExpiry: 'expired' });
        ledger.resetLedgerFilters();
        assert.equal(ledger.getActiveLedgerPreset(), 'asset');
        ledger.openDashboardLedger({ maintenanceExpiry: 'expired' });
        assert.equal(await ledger.closeLedger(), true);
        assert.equal(ledger.getActiveLedgerPreset(), 'asset');
        ledger.openDashboardLedger({ maintenanceExpiry: 'expired' });
        ledger.openLedger();
        assert.equal(ledger.getActiveLedgerPreset(), 'asset');
        assert.deepEqual(ledger.getLedgerFilterValues().maintenanceExpiry, ['expired']);
        ledger.openDashboardLedger({ maintenanceExpiry: 'expired' });
        ledger.openLedgerWithFilters({ viewId: 7 });
        assert.equal(ledger.getActiveLedgerPreset(), 'asset');
        ledger.openDashboardLedger({ placement: 'unplaced' });
        assert.equal(ledger.getActiveLedgerPreset(), 'asset');
        assert.deepEqual(presetWrites, []);
        ledger.openDashboardLedger({ maintenanceExpiry: 'expired' });
        ledger.setLedgerColumnPreset('monitoring');
        assert.equal(storage.get(ledger.LEDGER_COLUMN_PRESET_KEY), 'monitoring');
        assert.equal(ledger.getActiveLedgerPreset(), 'monitoring');
        ledger.resetLedgerFilters();
        assert.equal(ledger.getActiveLedgerPreset(), 'monitoring');
        assert.deepEqual(presetWrites, [[ledger.LEDGER_COLUMN_PRESET_KEY, 'monitoring']]);
    }));

    await t.test('個票の保守期限編集を適用・保存すると、元の年月精度を保ち期限条件を再分類する', () => withExpiryReference(async () => {
        seedExpiry();
        appState.views[1].name = '別ビュー';
        resetResourceBaseline(appState);
        const calls = [];
        globalThis.fetch = async (_url, options) => {
            const payload = JSON.parse(options.body); calls.push(payload);
            return new Response(JSON.stringify({ ok: true, revision: 2, id_maps: {},
                devices: payload.devices.map(change => ({ ...change.device, resource_revision: 2 })),
                views: [], placements: [], links: [], canvas_notes: [], deleted_device_ids: [], deleted_view_ids: [], affected_view_ids: [] }));
        };
        ledger.openLedgerWithFilters({ maintenanceExpiry: 'expired' });
        assert.equal(await ledger.openLedgerDetail(10), true);
        const input = get('ledger-sheet-body').querySelector('[data-field="maintenance_expiry"]');
        input.value = '2026-10'; await input.dispatch('input');
        assert.equal(await ledger.saveLedgerSheet(), true);
        assert.deepEqual(visibleIds(), []);
        assert.equal(appState.devices.find(device => device.id === 10).maintenance_expiry, '2026-10');
        assert.equal(calls.at(-1).devices[0].device.maintenance_expiry, '2026-10');
        await ledger.closeLedgerDetailPane();
        ledger.openLedgerWithFilters({ maintenanceExpiry: 'within1Year' });
        assert.deepEqual(visibleIds(), [80, 10, 70, 90, 30]);
    }));

    await t.test('候補から消えた施設・フロア・種別も条件を保持し、復帰後に再び一致する', async () => {
        seed();
        ledger.openLedgerWithFilters({ facility: ['施設A', '施設B'], floor: ['1F', '2F'], type: ['switch', 'router'] });
        await select(20);
        const filters = ledger.getLedgerFilterValues(); const original = structuredClone(appState.devices);
        for (const device of appState.devices) {
            device.facility = '別施設'; device.floor = '9F'; device.type = 'ap';
        }
        ledger.renderLedgerTable();
        assert.deepEqual(ledger.getLedgerFilterValues(), filters);
        assert.deepEqual(visibleIds(), []);
        assert.deepEqual(ledger.getLedgerSelectedDeviceIds(), [20]);
        appState.devices = original; ledger.renderLedgerTable();
        assert.deepEqual(visibleIds(), [30, 10, 20, 40, 50]);
        assert.deepEqual(ledger.getLedgerFilterValues(), filters);
    });

    await t.test('複数ビュー再採番はチェックを保持し、片方の削除だけ条件から除去する', async () => {
        seed(); ledger.openLedgerWithFilters({ viewId: [7, 8] }); await select(30);
        for (const view of appState.views) if (view.id !== 9) view.id += 100;
        for (const placement of appState.placements) placement.view_id += 100;
        eventBus.emit('resources:ids-remapped', { views: { 7: 107, 8: 108 } }); ledger.renderLedgerTable();
        assert.deepEqual(ledger.getLedgerFilterValues().viewIds, [107, 108]);
        assert.deepEqual(visibleIds(), [30, 10, 20, 40]);
        assert.deepEqual(ledger.getLedgerSelectedDeviceIds(), [30]);
        appState.views = appState.views.filter(view => view.id !== 107);
        appState.placements = appState.placements.filter(placement => placement.view_id !== 107);
        eventBus.emit('resource:reloaded', { kind: 'views', id: 107 }); ledger.renderLedgerTable();
        assert.deepEqual(ledger.getLedgerFilterValues().viewIds, [108]);
        assert.deepEqual(visibleIds(), [30, 40]);
        assert.deepEqual(ledger.getLedgerSelectedDeviceIds(), []);
    });

    await t.test('複数ビューの全選択・解除は表示外選択を保持し、同集合の入口は選択を保持する', async () => {
        seed(); ledger.openLedgerWithFilters({ viewId: [7, 8] }); await select(20);
        chooseValues('ledger-facility-filter', ['施設A']); ledger.renderLedgerTable();
        const master = get('ledger-select-all');
        master.checked = true; ledger.toggleAllLedgerCheckboxes(master);
        assert.deepEqual(new Set(ledger.getLedgerSelectedDeviceIds()), new Set([30, 10, 20, 40]));
        master.checked = false; ledger.toggleAllLedgerCheckboxes(master);
        assert.deepEqual(ledger.getLedgerSelectedDeviceIds(), [20]);
        ledger.openLedgerWithFilters({ viewId: [8, 7] });
        assert.deepEqual(ledger.getLedgerSelectedDeviceIds(), [20]);
        ledger.openLedgerWithFilters({ viewId: [7] });
        assert.deepEqual(ledger.getLedgerSelectedDeviceIds(), []);
    });


    await t.test('同名・改名に影響されず、複数ビュー配置を重複させず既存の機器順で表示する', () => {
        seed(); ledger.openLedgerWithFilters({ viewId: '7' });
        assert.deepEqual(ledger.getLedgerFilterValues().viewIds, [7]);
        assert.deepEqual(visibleIds(), [30, 10, 20]);
        assert.ok(get('ledger-active-filter-list').textContent.includes(appState.views[0].name));
        appState.views[0].name = '改名後ビュー';
        ledger.renderLedgerTable();
        assert.deepEqual(visibleIds(), [30, 10, 20]);
        assert.ok(get('ledger-active-filter-list').textContent.includes('改名後ビュー'));
        ledger.openLedgerWithFilters({ viewId: 8 });
        assert.deepEqual(visibleIds(), [30, 40]);
        ledger.openLedgerWithFilters({ viewId: 9 });
        assert.deepEqual(visibleIds(), []);
        assert.deepEqual(ledger.getLedgerFilterValues().viewIds, [9]);
    });

    await t.test('ビュー候補は表示順と同順位のID順に並び、元の配列・選択・対象機器を保持する', async () => {
        seed();
        appState.views = [...appState.views].reverse().map(view => ({
            ...view, sort_order: view.id === 9 ? 20 : 10
        }));
        ledger.openLedgerWithFilters({ viewId: 8 });
        const viewSelect = get('ledger-view-filter');
        assert.deepEqual(viewSelect.options.map(option => option.value), ['7', '8', '9']);
        assert.deepEqual(appState.views.map(view => view.id), [9, 8, 7]);
        assert.equal(viewSelect.value, '8');
        assert.deepEqual(visibleIds(), [30, 40]);
        await select(30);
        appState.views[0].sort_order = -10;
        eventBus.emit('resources:ids-remapped', {});
        ledger.renderLedgerTable();
        assert.deepEqual(viewSelect.options.map(option => option.value), ['9', '7', '8']);
        assert.deepEqual(appState.views.map(view => view.id), [9, 8, 7]);
        assert.equal(viewSelect.value, '8');
        assert.deepEqual(visibleIds(), [30, 40]);
        assert.deepEqual(ledger.getLedgerSelectedDeviceIds(), [30]);
    });

    await t.test('ビュー条件は検索・種別・施設・配置状態とANDし、chipだけ解除すると他条件を保つ', async () => {
        seed(); ledger.openLedgerWithFilters({ viewId: 7 });
        get('ledger-search').value = '対象'; get('ledger-type-filter').value = 'switch'; get('ledger-facility-filter').value = '施設A';
        ledger.renderLedgerTable();
        assert.deepEqual(visibleIds(), [30]);
        get('ledger-placement-filter').value = 'unplaced'; ledger.renderLedgerTable();
        assert.deepEqual(visibleIds(), []);
        get('ledger-placement-filter').value = ''; ledger.renderLedgerTable();
        await select(30);
        const removeView = get('ledger-active-filter-list').querySelector('button');
        assert.ok(removeView, '表示中のビュー条件を単独で解除できる');
        await removeView.dispatch('click');
        assert.deepEqual(ledger.getLedgerFilterValues().viewIds, []);
        assert.deepEqual(ledger.getLedgerSelectedDeviceIds(), []);
        assert.equal(get('ledger-search').value, '対象');
        assert.equal(get('ledger-type-filter').value, 'switch');
        assert.equal(get('ledger-facility-filter').value, '施設A');
        assert.deepEqual(visibleIds(), [30, 40, 50]);
        ledger.openLedgerWithFilters({ viewId: 7 });
        await select(30);
        get('ledger-floor-filter').value = '1F'; get('ledger-status-filter').value = 'unknown';
        get('ledger-ip-presence-filter').value = 'registered'; get('ledger-placement-filter').value = 'placed';
        ledger.resetLedgerFilters();
        assert.deepEqual(ledger.getLedgerFilterValues().viewIds, []);
        assert.deepEqual(ledger.getLedgerSelectedDeviceIds(), []);
        assert.ok(filterIds.every(id => get(id).value === ''));
        assert.deepEqual(visibleIds(), [30, 10, 20, 40, 50]);
        assert.equal(get('ledger-active-filters').hidden, true);
    });

    await t.test('通常入口・別ビュー入口は古いビューとcheckbox選択を持ち越さず、通常検索の表示外選択は保つ', async () => {
        seed(); ledger.openLedgerWithFilters({ viewId: 7 }); await select(20);
        get('ledger-search').value = '対象 Z'; ledger.renderLedgerTable();
        assert.deepEqual(visibleIds(), [30]);
        assert.deepEqual(ledger.getLedgerSelectedDeviceIds(), [20]);
        get('ledger-search').value = '対象'; get('ledger-type-filter').value = 'switch';
        ledger.openLedger();
        assert.deepEqual(ledger.getLedgerFilterValues().viewIds, []);
        assert.deepEqual(visibleIds(), [30, 20, 40, 50]);
        assert.deepEqual(ledger.getLedgerSelectedDeviceIds(), []);
        ledger.openLedgerWithFilters({ viewId: 7 }); await select(30);
        ledger.openLedgerWithFilters({ viewId: 8 });
        assert.deepEqual(visibleIds(), [30, 40]);
        assert.deepEqual(ledger.getLedgerSelectedDeviceIds(), []);
        assert.equal(row(30).querySelector('input[type="checkbox"]').checked, false);
    });

    await t.test('期限条件の後も検索・品質診断から指定した別区分の機器を表示する', () => withExpiryReference(async () => {
        for (const navigate of [
            () => ledger.openLedgerForSearchedDevice(30),
            () => ledger.openDataQualityDeviceInLedger(30)
        ]) {
            seedExpiry();
            ledger.openDashboardLedger({ maintenanceExpiry: 'expired' });
            assert.deepEqual(visibleIds(), [10]);
            await navigate();
            assert.deepEqual(ledger.getLedgerFilterValues().maintenanceExpiry, []);
            assert.ok(visibleIds().includes(30));
            assert.equal(row(30).classList.contains('search-highlight'), true);
            assert.equal(ledger.getActiveLedgerPreset(), 'standard');
        }
    }));

    await t.test('表示ビューを台帳で変更・解除でき、条件付き入口はダッシュボードと同じく前の条件を初期化する', async () => {
        seed();
        for (const id of filterIds) get(id).value = '前の条件';
        ledger.openLedgerWithFilters({ viewId: 7 });
        assert.equal(get('ledger-view-filter').value, '7');
        assert.ok(filterIds.filter(id => id !== 'ledger-view-filter').every(id => get(id).value === ''));
        assert.deepEqual(visibleIds(), [30, 10, 20]);
        await select(20);
        get('ledger-view-filter').value = '8';
        ledger.renderLedgerTable();
        assert.deepEqual(visibleIds(), [30, 40]);
        assert.deepEqual(ledger.getLedgerSelectedDeviceIds(), []);
        get('ledger-search').value = 'Other';
        ledger.renderLedgerTable();
        assert.deepEqual(visibleIds(), [40]);
        get('ledger-view-filter').value = '';
        ledger.renderLedgerTable();
        assert.deepEqual(ledger.getLedgerFilterValues().viewIds, []);
        assert.deepEqual(visibleIds(), [40]);
        assert.equal(appState.currentViewId, 7);
        ledger.openDashboardLedger({ placement: 'unplaced' });
        assert.equal(get('ledger-view-filter').value, '');
        assert.equal(get('ledger-search').value, '');
        assert.deepEqual(visibleIds(), [50]);
        ledger.openLedgerWithFilters({ viewId: 8 });
        assert.equal(get('ledger-placement-filter').value, '');
        assert.deepEqual(visibleIds(), [30, 40]);
    });

    await t.test('負の仮ビューIDは再採番後も同じビューを指す', () => {
        seed(); appState.views[0].id = -7;
        appState.placements.forEach(placement => { if (placement.view_id === 7) placement.view_id = -7; });
        ledger.openLedgerWithFilters({ viewId: '-7' });
        assert.deepEqual(visibleIds(), [30, 10, 20]);
        appState.views[0].id = 107;
        appState.placements.forEach(placement => { if (placement.view_id === -7) placement.view_id = 107; });
        eventBus.emit('resources:ids-remapped', { views: { '-7': 107 } });
        ledger.renderLedgerTable();
        assert.deepEqual(ledger.getLedgerFilterValues().viewIds, [107]);
        assert.equal(get('ledger-view-filter').value, '107');
        assert.deepEqual(visibleIds(), [30, 10, 20]);
    });

    await t.test('ビュー削除・全再読込・ビュー再読込・不存在IDは条件を安全に解除し、既存条件を維持する', () => {
        for (const event of [null, 'resources:reloaded', 'resource:reloaded']) {
            seed(); ledger.openLedgerWithFilters({ viewId: 7 });
            get('ledger-type-filter').value = 'router';
            appState.views = appState.views.filter(view => view.id !== 7);
            appState.placements = appState.placements.filter(placement => placement.view_id !== 7);
            if (event) eventBus.emit(event, { kind: 'views', id: 7 });
            ledger.renderLedgerTable();
            assert.deepEqual(ledger.getLedgerFilterValues().viewIds, []);
            assert.equal(get('ledger-type-filter').value, 'router');
            assert.deepEqual(visibleIds(), [10]);
        }
        seed(); ledger.openLedgerWithFilters({ viewId: 999 });
        assert.deepEqual(ledger.getLedgerFilterValues().viewIds, []);
        assert.deepEqual(visibleIds(), [30, 10, 20, 40, 50]);
    });

    await t.test('限定範囲の表示中全選択から既存一括編集へ同じ機器だけ渡し、個票もその機器を開く', async () => {
        seed();
        // 保存の確認では、既存のビュー名重複検証を満たすデータを使う。
        appState.views[1].name = '別ビュー';
        resetResourceBaseline(appState);
        ledger.openLedgerWithFilters({ viewId: [7, 8], type: ['switch', 'router'] });
        const master = get('ledger-select-all'); master.checked = true; await master.dispatch('click');
        assert.deepEqual(ledger.getLedgerSelectedDeviceIds(), [30, 10, 20, 40]);
        const calls = [];
        globalThis.fetch = async (url, options) => {
            assert.ok(url.includes('action=save_resources'));
            const payload = JSON.parse(options.body); calls.push(payload);
            return new Response(JSON.stringify({ ok: true, revision: 2, id_maps: {}, devices: payload.devices.map(change => ({ ...change.device, resource_revision: 2 })), views: [], placements: [], links: [], canvas_notes: [], deleted_device_ids: [], deleted_view_ids: [], affected_view_ids: [] }));
        };
        await ledger.openLedgerBulkEdit();
        const change = get('ledger-bulk-change-floor'); change.checked = true; await change.dispatch('change');
        get('ledger-bulk-value-floor').value = '合成一括変更';
        ledger.previewLedgerBulkEdit(); ledger.confirmLedgerBulkEdit();
        await queue.flushSaveQueue({ silent: true });
        assert.deepEqual(appState.devices.map(device => device.floor), ['合成一括変更', '合成一括変更', '合成一括変更', '合成一括変更', '1F']);
        assert.deepEqual(calls.flatMap(call => call.devices.map(change => change.id)).sort((a, b) => a - b), [10, 20, 30, 40]);
        assert.deepEqual(visibleIds(), [30, 10, 20, 40]);
        assert.equal(await ledger.openLedgerDetail(20), true);
        assert.equal(ledger.activeLedgerDeviceId, 20);
        assert.equal(get('ledger-sheet-body').querySelector('[data-field="name"]').value, '対象 M');
        assert.equal(get('ledger-sheet-prev-btn').disabled, false);
        assert.equal(get('ledger-sheet-next-btn').disabled, false);
        await ledger.closeLedgerDetailPane();
    });

    await t.test('Pingは表示外を含む明示選択だけを処理し、混在結果を保持してNGだけ再選択できる', async () => {
        seed();
        ledger.openLedgerWithFilters({ viewId: [7, 8], type: ['switch', 'router'] });
        let release;
        const calls = [];
        globalThis.fetch = async (url, options) => {
            assert.ok(url.includes('action=ping'));
            const payload = JSON.parse(options.body); calls.push(payload);
            if (calls.length === 1) await new Promise(resolve => { release = resolve; });
            const outcomes = new Map([[30, ['success', 'green', null]], [20, ['timeout', 'red', '要求がタイムアウトしました']], [10, ['skipped', 'unknown', 'IPアドレスが未設定です']], [40, ['failure', 'red', '宛先ホストに到達できません']]]);
            return new Response(JSON.stringify({ ok: true, monitor_revision: calls.length + 1,
                last_monitored_at: '2026-10-08 12:00:00',
                results: payload.targets.map(({ id }) => {
                    const [outcome, status, error] = calls.length === 1 ? outcomes.get(id) : ['success', 'green', null];
                    return { id, outcome, status, error, checked_at: '2026-10-08 12:00:00', response_ms: status === 'green' ? 1 : null };
                }) }));
        };
        ledger.updateLedgerSelectionUI();
        assert.equal(get('ledger-ping-btn').disabled, true);
        await ledger.pingLedgerSelected();
        assert.equal(calls.length, 0);
        for (const id of [30, 20, 10, 40]) await select(id);
        get('ledger-facility-filter').value = '施設A'; ledger.renderLedgerTable();
        assert.match(get('ledger-selection-summary').textContent, /表示外 1件/);
        const originalUntargeted = { ...appState.devices.find(device => device.id === 50) };
        const ping = ledger.pingLedgerSelected();
        try {
            assert.equal(appState.isPinging, true);
            assert.equal(get('ledger-ping-btn').disabled, true);
            assert.deepEqual(calls[0].targets.map(target => target.id), [30, 20, 10, 40]);
            assert.equal(appState.devices.find(device => device.id === 20).status, 'checking');
            ledger.clearLedgerSelection();
            assert.deepEqual(ledger.getLedgerSelectedDeviceIds(), [30, 20, 10, 40]);
            await ledger.pingLedgerSelected();
            assert.equal(calls.length, 1);
        } finally { release(); }
        await ping;
        assert.deepEqual(appState.devices.find(device => device.id === 50), originalUntargeted);
        assert.deepEqual(appState.devices.slice(0, 4).map(device => device.status), ['green', 'unknown', 'red', 'red']);
        assert.equal(get('ledger-ping-btn').disabled, false);
        // 表示外選択も解除してからNGだけを明示的にチェックし直す。
        ledger.clearLedgerSelection();
        assert.deepEqual(ledger.getLedgerSelectedDeviceIds(), []);
        assert.equal(get('ledger-ping-btn').disabled, true);
        get('ledger-facility-filter').value = ''; get('ledger-status-filter').value = 'red'; ledger.renderLedgerTable();
        assert.deepEqual(visibleIds(), [20, 40]);
        const master = get('ledger-select-all'); master.checked = true;
        ledger.toggleAllLedgerCheckboxes(master);
        await ledger.pingLedgerSelected();
        assert.deepEqual(calls[1].targets.map(target => target.id), [20, 40]);
        assert.deepEqual(visibleIds(), []);
        assert.match(get('ledger-selection-summary').textContent, /表示外 2件/);
    });

    await t.test('単独Pingと通信失敗・403・409・504は未選択と直前の監視結果を壊さず再実行できる', async () => {
        seed(); await select(30);
        const before = structuredClone(appState.devices);
        const originalError = console.error;
        console.error = () => {};
        try {
            for (const status of [403, 409, 504, 0]) {
                globalThis.fetch = async () => {
                    if (!status) throw new TypeError('synthetic disconnect');
                    return new Response(JSON.stringify({ ok: false, error: '合成エラー' }), { status });
                };
                await ledger.pingLedgerSelected();
                assert.deepEqual(appState.devices, before);
                assert.equal(appState.isPinging, false);
                assert.equal(get('ledger-ping-btn').disabled, false);
            }
            globalThis.fetch = async (_url, options) => {
                assert.deepEqual(JSON.parse(options.body).targets, [{ id: 30, ip: '192.0.2.30' }]);
                return new Response(JSON.stringify({ ok: true, results: [{ id: 30, outcome: 'success', status: 'green', response_ms: 1, checked_at: '2026-10-08 12:00:01' }] }));
            };
            await ledger.pingLedgerSelected();
            assert.equal(appState.devices[0].status, 'green');
            assert.deepEqual(appState.devices.slice(1), before.slice(1));
        } finally { console.error = originalError; }
    });

    await t.test('viewer・認証失効・未保存・未適用のPingは送信しない', async () => {
        seed(); await select(30);
        let calls = 0; globalThis.fetch = async () => { calls++; throw new Error('送信不可'); };
        window.APP_CONFIG.user.isAdmin = false;
        ledger.updateLedgerSelectionUI(); assert.equal(get('ledger-ping-btn').disabled, true);
        await ledger.pingLedgerSelected();
        window.APP_CONFIG.user.isAdmin = true; appState.authExpired = true;
        await ledger.pingLedgerSelected();
        appState.authExpired = false; appState.appStatus.dirty = true;
        await ledger.pingLedgerSelected();
        appState.appStatus.dirty = false;
        drafts.getDeviceDraft('ledger', 30).ip = '192.0.2.99';
        await ledger.pingLedgerSelected();
        assert.equal(calls, 0);
        assert.equal(drafts.getDeviceDraft('ledger', 30).ip, '192.0.2.99');
        drafts.discardDeviceDrafts();
    });

    await t.test('viewerも限定台帳と個票を閲覧できるが既存read-only境界を越えない', async () => {
        seed(); window.APP_CONFIG.user.isAdmin = false; ledger.openLedgerWithFilters({ viewId: 7, maintenanceExpiry: 'unset' });
        assert.deepEqual(visibleIds(), [30, 10, 20]);
        const name = row(30).querySelector('[data-field="name"]');
        assert.equal(name.readOnly, true);
        assert.equal(await ledger.openLedgerDetail(30), true);
        assert.equal(get('ledger-sheet-body').querySelector('[data-field="name"]').readOnly, true);
        const checkbox = row(30).querySelector('input[type="checkbox"]'); checkbox.checked = true; await checkbox.dispatch('change');
        assert.equal(get('ledger-bulk-edit-btn').disabled, true);
        await ledger.openLedgerBulkEdit();
        assert.equal(get('ledger-bulk-edit-overlay').hidden, true);
        assert.equal(drafts.hasDeviceDraftChanges('ledger', 30), false);
        await ledger.closeLedgerDetailPane();
    });
});
