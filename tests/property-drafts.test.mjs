import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { appState, normalizeDevice, normalizeLink, normalizeView } from '../public/js/core/state.js';
import { resetResourceBaseline, buildResourceSave } from '../public/js/core/resource-save.js';
import { registerModalOpen, registerModalClose } from '../public/js/core/modal-focus.js';

class Element {
    constructor(id = '') {
        this._id = id;
        this.value = '';
        this.hidden = true;
        this.dataset = {};
        this.style = {};
        this.attributes = new Map();
        this.classes = new Set();
        this.classList = {
            add: name => this.classes.add(name), remove: name => this.classes.delete(name),
            contains: name => this.classes.has(name), toggle: (name, on) => on ? this.classes.add(name) : this.classes.delete(name)
        };
        this.handlers = {};
        this.children = [];
        this.parentElement = null;
    }
    set id(val) {
        this._id = val;
        if (val) elements.set(val, this);
    }
    get id() { return this._id || ''; }
    setAttribute(name, value) { this.attributes.set(name, value); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    querySelectorAll() { return []; }
    querySelector(selector) {
        return this.children.find(child => selector.startsWith('.')
            && (child.className || '').split(/\s+/).includes(selector.slice(1))) || null;
    }
    appendChild(child) {
        child.remove();
        child.parentElement = this;
        this.children.push(child);
        if (child.id) elements.set(child.id, child);
        return child;
    }
    append(...children) { children.forEach(child => this.appendChild(child)); }
    get nextSibling() {
        return this.parentElement?.children[this.parentElement.children.indexOf(this) + 1] ?? null;
    }
    get previousSibling() {
        return this.parentElement?.children[this.parentElement.children.indexOf(this) - 1] ?? null;
    }
    get nextElementSibling() { return this.nextSibling; }
    get previousElementSibling() { return this.previousSibling; }
    after(...children) {
        const parent = this.parentElement;
        if (!parent) return;
        children = children.filter((child, index) => children.lastIndexOf(child) === index);
        let next = this.nextSibling;
        while (next && children.includes(next)) next = next.nextSibling;
        children.forEach(child => child.remove());
        let index = next ? parent.children.indexOf(next) : parent.children.length;
        for (const child of children) {
            child.remove();
            child.parentElement = parent;
            parent.children.splice(index++, 0, child);
            if (child.id) elements.set(child.id, child);
        }
    }
    replaceChildren(...children) {
        this.children.forEach(child => { child.parentElement = null; });
        this.children = [];
        this.append(...children);
    }
    focus() {}
    closest(selector) {
        if (selector === '#panel' && this.id.startsWith('p-')) return elements.get('panel');
        if (selector === '#link-panel' && this.id.startsWith('lp-')) return elements.get('link-panel');
        if (selector.includes(`#${this.id}`)) return this;
        return null;
    }
    addEventListener(name, fn) { (this.handlers[name] ||= []).push(fn); }
    removeEventListener(name, fn) {
        if (!this.handlers[name]) return;
        this.handlers[name] = this.handlers[name].filter(cb => cb !== fn);
    }
    click() {
        for (const handler of this.handlers['click'] || []) handler({ target: this });
    }
    remove() {
        if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
        this.parentElement = null;
        if (this.id) elements.delete(this.id);
    }
    contains(target) {
        return this === target || this.children.some(child => typeof child.contains === 'function' && child.contains(target));
    }
}
const elements = new Map();
const listeners = new Map();
const panelInputs = ['name', 'type', 'ip', 'floor-id', 'location', 'manufacturer', 'model', 'asset-number', 'serial-number', 'mac-address', 'memo', 'install-date', 'management-scheme', 'management-port', 'department', 'maintenance-vendor', 'maintenance-expiry', 'coord-x', 'coord-y'];
const linkInputs = ['label', 'from-port', 'to-port', 'memo', 'system'];

// DOM events and queue API are exercised together; drafts never enter the persistence snapshot.
test('詳細パネルは明示適用まで確定値と保存対象を変更しない', async t => {
    const globals = ['window', 'document', 'fetch', 'confirm', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement'];
    const originals = new Map(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const id of ['panel', 'link-panel', 'toast', 'p-apply-btn', 'lp-apply-btn', 'p-reload-conflict-btn', 'lp-reload-conflict-btn', ...panelInputs.map(id => `p-${id}`), ...linkInputs.map(id => `lp-${id}`)]) elements.set(id, new Element(id));
    for (const id of ['lp-system-name', 'lp-system-swatch', 'lp-system-options']) elements.set(id, new Element(id));
    for (const id of ['lp-legacy-vlan', 'lp-legacy-vlan-value', 'lp-delete-legacy-vlan-btn']) elements.set(id, new Element(id));
    const endpoints = new Element();
    elements.get('link-panel').append(endpoints);
    for (const side of ['from', 'to']) {
        const endpointId = `lp-${side}-endpoint`;
        const endpoint = new Element(endpointId);
        endpoints.append(endpoint);
        endpoint.append(new Element(`lp-${side}-device`), elements.get(`lp-${side}-port`),
            new Element(`lp-${side}-port-error`), new Element(`lp-${side}-vlan`));
        for (const suffix of ['vlan-summary', 'vlan-editor', 'vlan-input', 'vlan-input-error']) {
            const id = `lp-${side}-${suffix}`;
            elements.set(id, new Element(id));
        }
    }
    const summaryIds = ['basic', 'placement', 'asset', 'management', 'extra'].map(group => `p-summary-${group}`);
    for (const id of [...summaryIds, 'p-last-checked', 'p-response-ms', 'p-last-error']) elements.set(id, new Element(id));
    for (const id of panelInputs.map(id => `p-${id}`)) elements.get('panel').appendChild(elements.get(id));
    elements.get('lp-system').tagName = 'BUTTON';
    elements.get('lp-system').setAttribute('role', 'combobox');
    elements.get('lp-system').setAttribute('aria-controls', 'lp-system-options');
    elements.get('lp-system-name').className = 'link-system-option-name';
    elements.get('lp-system-swatch').className = 'link-system-swatch';
    elements.get('lp-system').appendChild(elements.get('lp-system-name'));
    elements.get('lp-system').appendChild(elements.get('lp-system-swatch'));
    globalThis.HTMLElement = Element;
    globalThis.HTMLInputElement = Element;
    globalThis.HTMLTextAreaElement = Element;
    globalThis.window = {
        APP_CONFIG: { user: { isAdmin: true }, csrfToken: 'test-token' },
        addEventListener() {}, clearTimeout() {}, setTimeout(cb) { cb(); return 0; }, confirm() { return true; },
        requestAnimationFrame(cb) { cb(); return 0; }, cancelAnimationFrame() {},
        getComputedStyle() { return { display: 'block', visibility: 'visible' }; }
    };
    globalThis.confirm = message => window.confirm(message);
    globalThis.document = {
        body: new Element('body'), getElementById: id => elements.get(id) || null,
        querySelector() { return null; }, querySelectorAll() { return []; },
        createElement: (tag = '') => {
            const el = new Element();
            el.tagName = tag.toUpperCase();
            return el;
        },
        addEventListener(name, callback) {
            if (!listeners.has(name)) listeners.set(name, []);
            listeners.get(name).push(callback);
        },
        removeEventListener(name, callback) {
            if (!listeners.has(name)) return;
            listeners.set(name, listeners.get(name).filter(cb => cb !== callback));
        }
    };
    const panel = await import('../public/js/ui/property-panel.js');
    const selection = await import('../public/js/canvas/selection.js');
    const queue = await import('../public/js/core/save-queue.js');
    const drafts = await import('../public/js/core/device-drafts.js');
    const { eventBus } = await import('../public/js/core/event-bus.js');
    t.after(() => {
        queue.clearPendingSave();
        drafts.discardDeviceDrafts();
        for (const [key, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    });
    let requests = [];
    let failSave = false;
    let portConflict = false;
    globalThis.fetch = async (url, options) => {
        const payload = JSON.parse(options.body);
        requests.push(payload);
        if (failSave) return new Response(JSON.stringify({ ok: false, error: '保存失敗' }), { status: 422 });
        if (portConflict) return Response.json({ ok: false, error: 'ポートが更新されました', details: {
            conflicts: [{ resource: 'device_ports', id: 41, expected_revision: 1, actual_revision: 2 }]
        } }, { status: 409 });
        if (url.includes('action=save_connections')) {
            const ports = appState.devicePorts.map(port => ({ ...port }));
            const portIds = {};
            for (const op of payload.device_ports) {
                if (op.operation === 'create') {
                    const id = Math.max(0, ...ports.map(row => row.id)) + 1;
                    portIds[op.id] = id;
                    ports.push({ ...op.port, id, resource_revision: 2 });
                } else if (op.operation === 'update') {
                    Object.assign(ports.find(row => row.id === op.id), op.port, { resource_revision: op.expected_revision + 1 });
                }
            }
            const savedLinks = payload.links.filter(row => row.operation !== 'delete');
            const links = savedLinks.map(({ id, link, expected_revision }) => {
                const { from_port_name, to_port_name, ...saved } = { ...appState.links.find(row => row.id === id), ...link };
                for (const [side, name] of [['from', from_port_name], ['to', to_port_name]]) {
                    if (name === undefined) continue;
                    const device_id = saved[`${side}_id`];
                    let port = ports.find(row => row.device_id === device_id && row.name === name);
                    if (!port && name !== '') {
                        port = { id: Math.max(0, ...ports.map(row => row.id)) + 1, device_id, name, resource_revision: 2 };
                        ports.push(port);
                    }
                    saved[`${side}_port_id`] = port?.id ?? null;
                }
                return { ...saved, id, resource_revision: expected_revision + 1 };
            });
            return new Response(JSON.stringify({
                ok: true, revision: 2, id_maps: { device_ports: portIds }, device_ports: ports, links,
                ...(payload.complete_legacy_vlan == null ? {} : { completed_legacy_vlan_link_id: payload.complete_legacy_vlan }),
                views: [], deleted_link_ids: payload.links.filter(row => row.operation === 'delete').map(row => row.id),
                deleted_device_port_ids: [], removed_view_link_routes: []
            }));
        }
        return new Response(JSON.stringify({
            ok: true, revision: 2, saved_at: '2026-10-03T00:00:00Z',
            id_maps: { devices: {}, views: {}, placements: {} },
            devices: payload.devices.filter(row => row.operation !== 'delete').map(row => ({ ...row.device, resource_revision: 2 })),
            views: payload.views.filter(row => row.operation !== 'delete').map(row => ({ ...row.view, resource_revision: 2 })),
            placements: payload.views.flatMap(row => row.placements || []),
            view_link_routes: payload.views.flatMap(row => row.view_link_routes || []),
            canvas_notes: [],
            deleted_device_ids: payload.devices.filter(row => row.operation === 'delete').map(row => row.id),
            deleted_view_ids: [], affected_view_ids: payload.views.map(row => row.id)
        }));
    };
    function reset() {
        queue.clearPendingSave();
        window.APP_CONFIG.user.isAdmin = true;
        drafts.discardDeviceDrafts();
        appState.devices = [normalizeDevice({ id: 1, resource_revision: 1, name: '機器A', type: 'switch', ip: '192.0.2.1' }), normalizeDevice({ id: 2, resource_revision: 1, name: '機器B', type: 'server', ip: '192.0.2.2' })];
        appState.buildings = [{ id: 1, name: '建物A' }, { id: 2, name: '建物B' }];
        appState.floors = [{ id: 11, building_id: 1, name: '1F' }, { id: 21, building_id: 2, name: '1F' }];
        appState.views = [normalizeView({ id: 10, resource_revision: 1, name: 'ビューA' })];
        appState.currentViewId = 10;
        appState.placements = [
            { id: 30, device_id: 1, view_id: 10, x: 100, y: 100 },
            { id: 31, device_id: 2, view_id: 10, x: 200, y: 100 }
        ];
        appState.links = [normalizeLink({ id: 20, from_id: 1, to_id: 2, resource_revision: 1, label: 'リンクA', from_port_id: 41 })];
        appState.devicePorts = [{ id: 41, device_id: 1, name: 'Gi1', resource_revision: 1 }];
        appState.legacyLinkVlans = [];
        appState.viewLinkRoutes = [];
        appState.linkSystems = [];
        appState.deviceImages = [];
        appState.editingDeviceId = null;
        appState.editingLinkId = null;
        appState.editingLinkGroupKey = null;
        appState.resourceConflicts = { devices: new Map(), views: new Map(), links: new Map(), device_ports: new Map() };
        appState.appStatus = { state: 'saved', dirty: false, lastError: null };
        appState.authExpired = false;
        for (const id of ['panel', 'link-panel']) { elements.get(id).hidden = true; elements.get(id).classList.add('hidden'); }
        resetResourceBaseline(appState);
        requests = [];
        failSave = false;
        window.confirm = () => true;
    }
    function edit(id, value, eventName = 'input') {
        const target = elements.get(id);
        target.value = value;
        for (const callback of listeners.get(eventName) || []) callback({ target, relatedTarget: elements.get('p-ip') });
    }
    const settle = async () => { await setImmediate(); await setImmediate(); };
    const chooseAction = async (action) => {
        await settle();
        const btn = elements.get(`unsaved-changes-${action}`);
        if (btn) btn.click();
        await settle();
    };

    await t.test('他画面で同期した管理IPを元の値へ貼り戻すとセグメント候補を再計算する', async t => {
        reset();
        const originalSegments = appState.ipSegments;
        t.after(() => { appState.ipSegments = originalSegments; });
        appState.ipSegments = [
            { id: 101, cidr: '192.0.2.0/24' },
            { id: 102, cidr: '198.51.100.0/24' }
        ];
        const device = appState.devices[0];
        device.ip_segment_id = 101;
        assert.equal(await panel.openPanel(device), true);
        const ip = elements.get('p-ip');
        assert.equal(ip.value, '192.0.2.1');

        Object.assign(device, { ip: '198.51.100.10', ip_segment_id: 102 });
        panel.syncPanelIfOpen();
        assert.equal(ip.value, '198.51.100.10');
        assert.equal(drafts.getDeviceDraft('panel', 1).ip_segment_id, 102);

        ip.value = '192.0.2.1';
        for (const callback of ip.handlers.input) callback({ target: ip });
        for (const callback of listeners.get('input') || []) callback({ target: ip });
        const draft = drafts.getDeviceDraft('panel', 1);
        assert.equal(draft.ip, '192.0.2.1');
        assert.equal(draft.ip_segment_id, 101);
    });
    function dispatchPointer(type, pointerId = 7, clientX = 100, clientY = 100) {
        for (const callback of [...(listeners.get(type) || [])]) callback({ type, pointerId, clientX, clientY });
    }
    function setupRangeSelection(child) {
        const keys = ['canvas', 'selectionBox', 'deviceLayer', 'selectedPlacementIds', 'isRangeSelecting', 'cancelActiveRangeSelection'];
        const previous = new Map(keys.map(key => [key, appState[key]]));
        const canvas = new Element('canvas');
        const capturedPointers = new Set();
        const captureAttempts = [];
        canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 500, height: 500 });
        canvas.setPointerCapture = id => { captureAttempts.push(id); capturedPointers.add(id); };
        canvas.hasPointerCapture = id => capturedPointers.has(id);
        canvas.releasePointerCapture = id => capturedPointers.delete(id);
        const placement = new Element();
        placement.dataset.placementId = '30';
        placement.getBoundingClientRect = () => ({ left: 40, top: 40, right: 60, bottom: 60 });
        appState.canvas = canvas;
        appState.selectionBox = new Element();
        appState.selectionBox.style = {};
        appState.deviceLayer = { querySelectorAll: () => [placement] };
        appState.selectedPlacementIds = new Set([31]);
        appState.isRangeSelecting = false;
        appState.cancelActiveRangeSelection = null;
        child.after(() => {
            appState.cancelActiveRangeSelection?.();
            for (const [key, value] of previous) appState[key] = value;
        });
        let prevented = false;
        return {
            event: { pointerId: 7, clientX: 10, clientY: 10, preventDefault() { prevented = true; } },
            isPrevented: () => prevented,
            captureAttempts,
            capturedPointers
        };
    }
    function assertRangeSelectionClean() {
        assert.equal(appState.isRangeSelecting, false);
        assert.equal(appState.cancelActiveRangeSelection, null);
        assert.equal(appState.selectionBox.hidden, true);
        assert.equal(appState.canvas.classList.contains('selecting'), false);
    }
    await t.test('設置フロアの選択・未設定解除は明示適用し、旧文字列を原文保存する', async () => {
        reset();
        const device = appState.devices[0];
        Object.assign(device, { facility: ' 旧施設 ', floor: ' 旧階 ', floor_id: 11 });
        resetResourceBaseline(appState);
        panel.openPanel(device);
        assert.deepEqual(elements.get('p-floor-id').children.map(option => option.textContent), ['未分類', '建物A / 1F', '建物B / 1F']);
        edit('p-floor-id', '21', 'change');
        assert.equal(device.floor_id, 11);
        assert.equal(drafts.getDeviceDraft('panel', 1).floor_id, 21);
        assert.equal(buildResourceSave().devices.length, 0);
        assert.equal(panel.applyPanelValues(), true);
        await queue.flushSaveQueue({ silent: true });
        assert.equal(appState.devices[0].floor_id, 21);
        assert.equal(requests.at(-1).devices[0].device.floor_id, 21);
        assert.equal(requests.at(-1).devices[0].device.facility, ' 旧施設 ');
        assert.equal(requests.at(-1).devices[0].device.floor, ' 旧階 ');
        edit('p-floor-id', '', 'change');
        assert.equal(drafts.hasDeviceDraftChanges('panel', 1), true);
        assert.equal(panel.applyPanelValues(), true);
        await queue.flushSaveQueue({ silent: true });
        assert.equal(appState.devices[0].floor_id, null);
        assert.equal(requests.at(-1).devices[0].device.floor_id, null);
    });
    await t.test('管理ポートを22→2222→22へ戻すと下書きも未変更になり、不要な三択を開かない', () => {
        reset();
        Object.assign(appState.devices[0], { management_scheme: 'ssh', management_port: 22 });
        resetResourceBaseline(appState);
        panel.openPanel(appState.devices[0]);
        edit('p-management-port', '22');
        assert.equal(drafts.getDeviceDraft('panel', 1).management_port, 22);
        assert.equal(drafts.hasDeviceDraftChanges('panel', 1), false);
        edit('p-management-port', '2222');
        assert.equal(drafts.getDeviceDraft('panel', 1).management_port, 2222);
        assert.equal(panel.hasUnappliedPanelChanges(), true);
        edit('p-management-port', '22');
        assert.equal(drafts.hasAnyDeviceDraftChanges(), false);
        assert.equal(panel.hasUnappliedPanelChanges(), false);
        assert.equal(elements.get('p-apply-btn').disabled, true);
        edit('p-management-port', '');
        assert.equal(drafts.getDeviceDraft('panel', 1).management_port, null);
        assert.equal(panel.hasUnappliedPanelChanges(), true);
        edit('p-management-port', '22');
        assert.equal(drafts.hasAnyDeviceDraftChanges(), false);
        assert.equal(panel.closePanel(), true, '未変更なら確認待ちのPromiseを返さない');
        assert.equal(elements.has('unsaved-changes-overlay'), false);
        assert.equal(buildResourceSave().devices.length, 0);
        assert.equal(requests.length, 0);
    });
    await t.test('監視同期と再入力は未適用の各要約・備考を保持し、監視値だけ最新へ更新する', () => {
        reset();
        panel.openPanel(appState.devices[0]);
        for (const [id, value] of [
            ['p-name', '未適用の名称'], ['p-ip', '192.0.2.50'],
            ['p-floor-id', '21'], ['p-location', '未適用の設置場所'],
            ['p-manufacturer', '未適用のメーカー'], ['p-model', '未適用の型番'],
            ['p-management-scheme', 'ssh'], ['p-management-port', '2222'],
            ['p-department', '未適用の部署'], ['p-memo', '未適用の備考']
        ]) edit(id, value);
        const before = new Map(summaryIds.map(id => [id, elements.get(id).textContent]));
        const draft = { ...drafts.getDeviceDraft('panel', 1) };
        Object.assign(appState.devices[0], {
            status: 'green', last_response_ms: 7,
            last_checked_at: '2026-10-09 12:00:00', last_error: null
        });
        panel.syncPanelIfOpen();
        for (const id of summaryIds.filter(id => id !== 'p-summary-extra')) {
            assert.equal(elements.get(id).textContent, before.get(id), `${id}の未適用要約を保持`);
        }
        assert.equal(elements.get('p-summary-extra').textContent.split(' / ')[0], before.get('p-summary-extra').split(' / ')[0]);
        assert.notEqual(elements.get('p-summary-extra').textContent, before.get('p-summary-extra'));
        assert.ok(elements.get('p-summary-extra').title.includes('7 ms'));
        assert.equal(elements.get('p-response-ms').textContent, '7ms');
        assert.equal(elements.get('p-last-checked').textContent, appState.devices[0].last_checked_at);
        assert.deepEqual(drafts.getDeviceDraft('panel', 1), draft);
        assert.equal(elements.get('p-name').value, draft.name);
        assert.equal(appState.devices[0].name, '機器A');
        assert.equal(buildResourceSave().devices.length, 0);
        assert.equal(requests.length, 0);
        edit('p-name', '監視更新後の未適用名称');
        assert.ok(elements.get('p-summary-extra').title.includes('7 ms'), '再入力でも古い下書き監視値へ戻さない');
    });
    for (const target of ['device', 'link']) {
        for (const type of ['pointerup', 'pointercancel']) {
            await t.test(`${target}の確認待ちで${type}が発生しても終了済みの矩形選択を開始しない`, async child => {
                reset();
                const gesture = setupRangeSelection(child);
                if (target === 'device') {
                    panel.openPanel(appState.devices[0]);
                    edit('p-name', '未適用の機器名');
                } else {
                    panel.openLinkPanel(appState.links[0]);
                    edit('lp-label', '未適用のリンク名');
                }
                const begin = selection.beginCanvasRangeSelection(gesture.event);
                assert.equal(gesture.isPrevented(), true, 'preventDefaultは確認を待たず同期実行する');
                await settle();
                assert.equal(elements.has('unsaved-changes-overlay'), true);
                assert.equal(appState.isRangeSelecting, false);
                dispatchPointer(type);
                await chooseAction('discard');
                await begin;
                assert.deepEqual(gesture.captureAttempts, []);
                assert.deepEqual([...appState.selectedPlacementIds], [31]);
                assertRangeSelectionClean();
            });
        }
    }
    await t.test('矩形選択の確認キャンセルは入力と選択を保持し、待機リスナーを解除する', async child => {
        reset();
        const gesture = setupRangeSelection(child);
        panel.openPanel(appState.devices[0]);
        edit('p-name', '確認キャンセル後も保持');
        const begin = selection.beginCanvasRangeSelection(gesture.event);
        await chooseAction('cancel');
        await begin;
        assert.equal(elements.get('p-name').value, '確認キャンセル後も保持');
        assert.deepEqual([...appState.selectedPlacementIds], [31]);
        assert.deepEqual(gesture.captureAttempts, []);
        assertRangeSelectionClean();
    });
    await t.test('別pointerの終了では確認中の元pointerを中断せず、確認後のドラッグを継続する', async child => {
        reset();
        const gesture = setupRangeSelection(child);
        panel.openPanel(appState.devices[0]);
        edit('p-name', '未適用');
        const begin = selection.beginCanvasRangeSelection(gesture.event);
        dispatchPointer('pointerup', 8);
        dispatchPointer('pointercancel', 8);
        await chooseAction('discard');
        await begin;
        assert.equal(appState.isRangeSelecting, true);
        assert.deepEqual(gesture.captureAttempts, [7]);
        dispatchPointer('pointerup');
        assert.deepEqual([...appState.selectedPlacementIds], [31, 30]);
        assert.equal(gesture.capturedPointers.size, 0);
        assertRangeSelectionClean();
    });
    await t.test('未変更パネルの通常Shift矩形選択は既存選択へ追加し、小さい操作では選択を維持する', async child => {
        reset();
        const gesture = setupRangeSelection(child);
        panel.openPanel(appState.devices[0]);
        await selection.beginCanvasRangeSelection(gesture.event);
        assert.equal(gesture.isPrevented(), true);
        assert.equal(elements.has('unsaved-changes-overlay'), false);
        assert.equal(appState.isRangeSelecting, true);
        dispatchPointer('pointerup');
        assert.deepEqual([...appState.selectedPlacementIds], [31, 30]);
        assert.equal(gesture.capturedPointers.size, 0);
        assertRangeSelectionClean();
        await selection.beginCanvasRangeSelection(gesture.event);
        dispatchPointer('pointerup', 7, 11, 11);
        assert.deepEqual([...appState.selectedPlacementIds], [31, 30]);
        assertRangeSelectionClean();
    });
    await t.test('入力停止・項目移動で保存せず、外部保存に機器下書きを混入させない', async child => {
        reset();
        panel.openPanel(appState.devices[0]);
        child.mock.timers.enable({ apis: ['setTimeout'] });
        edit('p-name', '編集中の機器名');
        edit('p-management-scheme', 'ssh', 'change');
        edit('p-management-port', '2222');
        edit('p-name', '編集中の機器名', 'focusout');
        child.mock.timers.tick(1000);
        assert.equal(requests.length, 0);
        assert.equal(appState.devices[0].name, '機器A');
        assert.equal(panel.hasUnappliedPanelChanges(), true);
        appState.devices[1].name = '別機器の確定値';
        queue.scheduleSave({ immediate: true });
        await settle();
        assert.deepEqual(requests[0].devices.map(row => row.id), [2]);
        panel.openPanel(appState.devices[0]);
        assert.equal(elements.get('p-name').value, '編集中の機器名');
        assert.equal(elements.get('p-management-port').value, '2222');
    });
    await t.test('適用が保存キューへ投入し、次の下書きは応答待ちに失われない', async () => {
        reset();
        panel.openPanel(appState.devices[0]);
        edit('p-name', '確定した機器名');
        assert.equal(panel.applyPanelValues({ showMessage: false }), true);
        assert.equal(elements.get('p-apply-btn').disabled, true);
        edit('p-memo', '次の入力');
        assert.equal(elements.get('p-apply-btn').disabled, false, '通信中でも次の未適用入力があれば適用できる');
        await settle();
        panel.openPanel(appState.devices[0]);
        assert.equal(requests.length, 1);
        assert.equal(requests[0].devices[0].device.name, '確定した機器名');
        assert.equal(requests[0].devices[0].device.memo, '');
        assert.equal(elements.get('p-memo').value, '次の入力');
        assert.equal(appState.devices[0].memo, '');
    });
    await t.test('復元キャンセルは入力保持、破棄は開いた時点でなく最新の確定値へ戻す', () => {
        reset();
        panel.openPanel(appState.devices[0]);
        edit('p-name', '未適用');
        appState.devices[0].name = '他画面で確定した機器名';
        window.confirm = () => false;
        assert.equal(panel.revertPanelValues(), false);
        assert.equal(elements.get('p-name').value, '未適用');
        window.confirm = () => true;
        assert.equal(panel.revertPanelValues(), true);
        assert.equal(elements.get('p-name').value, '他画面で確定した機器名');
        assert.equal(appState.devices[0].name, '他画面で確定した機器名');
        assert.equal(requests.length, 0);
    });
    await t.test('対象変更はキャンセル・破棄・適用を区別する', async () => {
        reset();
        panel.openPanel(appState.devices[0]);
        edit('p-name', '未適用');
        let openPromise = panel.openPanel(appState.devices[1]);
        await chooseAction('cancel');
        assert.equal(await openPromise, false);
        assert.equal(appState.editingDeviceId, 1);
        assert.equal(elements.get('p-name').value, '未適用');

        openPromise = panel.openPanel(appState.devices[1]);
        await chooseAction('discard');
        assert.equal(await openPromise, true);
        assert.equal(appState.devices[0].name, '機器A');
        assert.equal(requests.length, 0);

        edit('p-name', '適用して移動');
        openPromise = panel.openPanel(appState.devices[0]);
        await chooseAction('save');
        assert.equal(await openPromise, true);
        await settle();
        assert.equal(requests[0].devices[0].device.name, '適用して移動');
    });
    await t.test('リンク入力は検証完了まで一括反映せず、適用でのみ保存する', async () => {
        reset();
        panel.openLinkPanel(appState.links[0]);
        edit('lp-label', '未適用リンク');
        edit('lp-from-port', 'x'.repeat(51), 'change');
        edit('lp-label', '未適用リンク', 'focusout');
        assert.equal(panel.applyLinkPanel({ showMessage: false }), false);
        assert.equal(appState.links[0].label, 'リンクA');
        assert.equal(requests.length, 0);
        appState.devices[1].memo = '他対象の確定値';
        queue.scheduleSave({ immediate: true });
        await settle();
        assert.equal(requests[0].views.length, 0);
        panel.openLinkPanel(appState.links[0]);
        assert.equal(elements.get('lp-label').value, '未適用リンク');
        assert.equal(elements.get('lp-from-port').value, 'x'.repeat(51));
        edit('lp-from-port', 'Gi2');
        assert.equal(buildResourceSave().views.length, 0);
        assert.equal(panel.applyLinkPanel({ showMessage: false }), true);
        assert.equal(elements.get('lp-apply-btn').disabled, true);
        edit('lp-memo', '応答待ちの下書き');
        assert.equal(elements.get('lp-apply-btn').disabled, false, '通信中でもリンクの次の入力を禁止しない');
        await settle();
        panel.openLinkPanel(appState.links[0]);
        assert.equal(requests.at(-1).links[0].link.label, '未適用リンク');
        assert.equal(elements.get('lp-memo').value, '応答待ちの下書き');
        window.confirm = () => false;
        assert.equal(panel.revertLinkPanelValues(), false);
        let closePromise = panel.closeLinkPanel();
        await chooseAction('cancel');
        assert.equal(await closePromise, false);
        window.confirm = () => true;
        assert.equal(panel.revertLinkPanelValues(), true);
        assert.equal(elements.get('lp-memo').value, '');
    });
    await t.test('系統の下書きは明示適用で保存し、未設定で解除し、未知系統とviewer変更を拒否する', async () => {
        reset();
        appState.linkSystems = [{ id: 1, name: '合成庁内LAN', color_key: 'teal' }];
        panel.openLinkPanel(appState.links[0]);
        edit('lp-system', '1', 'change');
        assert.equal(appState.links[0].system_id, null);
        assert.equal(buildResourceSave().views.length, 0);
        assert.equal(panel.hasUnappliedLinkPanelChanges(), true);
        assert.equal(panel.applyLinkPanel({ showMessage: false }), true);
        await settle();
        assert.equal(requests[0].links[0].link.system_id, 1);
        assert.equal(appState.links[0].system_id, 1);
        edit('lp-system', '', 'change');
        panel.applyLinkPanel({ showMessage: false });
        await settle();
        assert.equal(requests[1].links[0].link.system_id, null);
        edit('lp-system', '999', 'change');
        assert.equal(panel.applyLinkPanel({ showMessage: false }), false);
        assert.equal(appState.links[0].system_id, null);
        assert.equal(requests.length, 2);
        panel.revertLinkPanelValues();
        window.APP_CONFIG.user.isAdmin = false;
        panel.setLinkPanelReadOnly(true);
        assert.equal(elements.get('lp-system').disabled, true);
        edit('lp-system', '1', 'change');
        assert.equal(panel.applyLinkPanel({ showMessage: false }), false);
        assert.equal(requests.length, 2);
        window.APP_CONFIG.user.isAdmin = true;
        panel.setLinkPanelReadOnly(false);
        panel.revertLinkPanelValues();
    });
    await t.test('右パネルの VLAN設定は端点の入力と保存通知に追従し、閲覧者には値だけを表示する', () => {
        reset();
        appState.devicePorts[0].vlan = 'access 10';
        appState.devicePorts.push(
            { id: 42, device_id: 2, name: 'Gi1', vlan: 'access 20', resource_revision: 1 },
            { id: 43, device_id: 1, name: 'Gi2', vlan: '', resource_revision: 1 }
        );
        const vlanInput = side => elements.get(`lp-${side}-vlan-input`);
        const readVlans = () => ['from', 'to'].map(side => vlanInput(side).value);
        panel.openLinkPanel(appState.links[0]);
        assert.deepEqual(readVlans(), ['access 10', '']);
        assert.equal(vlanInput('from').disabled, false);
        assert.equal(vlanInput('to').disabled, true);

        edit('lp-to-port', ' Ｇｉ１ ');
        assert.deepEqual(readVlans(), ['access 10', 'access 20']);
        edit('lp-from-port', 'Gi2');
        assert.deepEqual(readVlans(), ['', 'access 20']);
        edit('lp-from-port', '未登録ポート');
        assert.deepEqual(readVlans(), ['', 'access 20']);

        appState.devicePorts[1].vlan = 'trunk 30';
        eventBus.emit('resources:saved', { device_ports: [appState.devicePorts[1]] });
        assert.deepEqual(readVlans(), ['', 'trunk 30']);
        assert.equal(elements.get('lp-from-port').value, '未登録ポート');
        assert.equal(panel.revertLinkPanelValues(), true);
        assert.deepEqual(readVlans(), ['access 10', '']);
        assert.equal(requests.length, 0);

        window.APP_CONFIG.user.isAdmin = false;
        panel.setLinkPanelReadOnly(true);
        for (const side of ['from', 'to']) {
            assert.equal(elements.get(`lp-${side}-vlan-editor`).hidden, true);
            assert.equal(elements.get(`lp-${side}-vlan-summary`).hidden, false);
        }
        assert.equal(elements.get('lp-from-vlan').textContent, 'access 10');
        assert.equal(elements.get('lp-to-vlan').textContent, '未指定');
        assert.equal(panel.applyLinkPanel({ showMessage: false }), false);
    });
    await t.test('通常の接続でも両端の VLAN を「適用」でポートに保存する', async () => {
        reset();
        appState.devicePorts[0].vlan = 'access 10';
        resetResourceBaseline(appState);
        panel.openLinkPanel(appState.links[0]);
        edit('lp-from-vlan-input', '');
        edit('lp-to-port', 'LAN1');
        edit('lp-to-vlan-input', 'access 20');
        assert.equal(panel.hasUnappliedLinkPanelChanges(), true);
        assert.equal(requests.length, 0);
        assert.equal(appState.devicePorts[0].vlan, 'access 10');
        assert.equal(appState.links[0].to_port_id, null);

        assert.equal(await panel.applyLinkPanel({ showMessage: false }), true);
        const [batch] = requests;
        assert.deepEqual(batch.links, [{ operation: 'update', id: 20, expected_revision: 1, link: { to_port_name: 'LAN1' } }]);
        assert.equal(Object.hasOwn(batch, 'complete_legacy_vlan'), false);
        assert.deepEqual(batch.device_ports[0], { operation: 'update', id: 41, expected_revision: 1, port: { vlan: '' } });
        assert.equal(batch.device_ports[1].operation, 'create');
        assert.deepEqual(batch.device_ports[1].port, { device_id: 2, name: 'LAN1', vlan: 'access 20' });
        assert.equal(appState.links[0].to_port_id, 42);
        assert.deepEqual(appState.devicePorts.map(port => port.vlan), ['', 'access 20']);
        assert.equal(elements.get('lp-to-vlan-input').value, 'access 20');
        assert.equal(elements.get('lp-to-vlan-input').disabled, false);
        assert.equal(panel.hasUnappliedLinkPanelChanges(), false);
    });
    await t.test('未移行VLANは閲覧でき、管理者だけが名前のある端点を編集できる', () => {
        reset();
        appState.legacyLinkVlans = [{ link_id: '20', vlan: '旧 access 20' }];
        appState.placements.pop(); // 一方だけ配置されたビューからも明細を開ける。
        appState.devicePorts[0].vlan = '既存 access 10';
        window.APP_CONFIG.user.isAdmin = false;
        assert.equal(panel.openLinkPanel(appState.links[0]), true);
        assert.equal(elements.get('lp-legacy-vlan').hidden, false);
        assert.equal(elements.get('lp-legacy-vlan-value').textContent, '旧 access 20');
        assert.equal(elements.get('lp-delete-legacy-vlan-btn').hidden, true);
        assert.equal(elements.get('lp-from-vlan-editor').hidden, true);
        assert.equal(elements.get('lp-from-vlan').textContent, '既存 access 10');

        window.APP_CONFIG.user.isAdmin = true;
        panel.setLinkPanelReadOnly(false);
        assert.equal(elements.get('lp-delete-legacy-vlan-btn').hidden, false);
        assert.equal(elements.get('lp-from-vlan-editor').hidden, false);
        assert.equal(elements.get('lp-from-vlan-input').value, '既存 access 10');
        assert.equal(elements.get('lp-to-vlan-input').disabled, true);
        edit('lp-to-port', '新しいポート');
        assert.equal(elements.get('lp-to-vlan-input').disabled, false);
        assert.equal(elements.get('lp-delete-legacy-vlan-btn').disabled, true);
        assert.match(elements.get('lp-delete-legacy-vlan-btn').title, /先に入力を適用/);
        assert.equal(elements.get('lp-to-vlan-input').value, '', '旧設定を自動コピーしない');
    });
    await t.test('ポート名だけの登録では未移行VLANを残す', async () => {
        reset();
        appState.legacyLinkVlans = [{ link_id: 20, vlan: '旧設定' }];
        panel.openLinkPanel(appState.links[0]);
        edit('lp-to-port', 'LAN1');
        edit('lp-to-vlan-input', '   ');
        assert.equal(await panel.applyLinkPanel({ showMessage: false }), true);
        assert.equal(requests[0].complete_legacy_vlan, undefined);
        assert.equal(appState.devicePorts.find(port => port.id === appState.links[0].to_port_id)?.name, 'LAN1');
        assert.equal(appState.legacyLinkVlans[0].vlan, '旧設定');
    });

    await t.test('ポート競合後は入力を戻しても再読込でき、適用はできない', async () => {
        reset();
        panel.openLinkPanel(appState.links[0]);
        edit('lp-from-vlan-input', 'access 10');
        portConflict = true;
        try {
            assert.equal(await panel.applyLinkPanel({ showMessage: false }), false);
        } finally {
            portConflict = false;
        }
        const reload = elements.get('lp-reload-conflict-btn');
        const assertBlocked = () => {
            assert.equal(reload.hidden, false);
            assert.equal(reload.textContent, '競合したポートを再読込');
            assert.equal(elements.get('lp-apply-btn').disabled, true);
        };
        assertBlocked();
        edit('lp-from-vlan-input', '');
        assertBlocked();
        edit('lp-from-vlan-input', 'access 20');
        assert.equal(panel.revertLinkPanelValues(), true);
        assertBlocked();
        assert.equal(panel.closeLinkPanel(), true);
        assert.equal(panel.openLinkPanel(appState.links[0]), true);
        edit('lp-label', '別の下書き');
        assertBlocked();
        assert.equal(panel.applyLinkPanel({ showMessage: false }), false);
        assert.equal(requests.length, 1);
    });

    await t.test('未移行VLANのある接続でもラベルだけの適用では旧設定を残す', async () => {
        reset();
        appState.legacyLinkVlans = [{ link_id: 20, vlan: '旧設定' }];
        panel.openLinkPanel(appState.links[0]);
        edit('lp-label', '新しいラベル');
        assert.equal(panel.applyLinkPanel({ showMessage: false }), true);
        await settle();
        assert.equal(requests[0].links[0].link.label, '新しいラベル');
        assert.equal(requests[0].complete_legacy_vlan, undefined);
        assert.equal(appState.legacyLinkVlans[0].vlan, '旧設定');
    });
    await t.test('未移行VLANは逆向きの端点でもポートと同時に保存し、失敗時は閉じず入力を保持する', async () => {
        reset();
        appState.links[0] = normalizeLink({ id: 20, from_id: 2, to_id: 1, resource_revision: 3, to_port_id: 41 });
        Object.assign(appState.devicePorts[0], { vlan: 'access 10', resource_revision: 4 });
        appState.legacyLinkVlans = [{ link_id: 20, vlan: '旧 access 20' }];
        resetResourceBaseline(appState);
        panel.openLinkPanel(appState.links[0]);
        assert.deepEqual(endpoints.children.map(row => row.id), ['lp-to-endpoint', 'lp-from-endpoint']);
        edit('lp-from-port', ' ＬＡＮ１ ');
        edit('lp-from-vlan-input', 'x'.repeat(201));
        assert.equal(panel.applyLinkPanel({ showMessage: false }), false);
        assert.equal(elements.get('lp-from-vlan-input').getAttribute('aria-invalid'), 'true');
        assert.equal(requests.length, 0);
        edit('lp-from-vlan-input', 'access 40');
        edit('lp-to-vlan-input', 'trunk 10,40');
        edit('lp-memo', '両端確認済み');
        failSave = true;
        const close = panel.closeLinkPanel();
        await chooseAction('save');
        assert.equal(await close, false);
        assert.equal(elements.get('link-panel').hidden, false);
        assert.equal(elements.get('lp-from-vlan-input').value, 'access 40');
        assert.equal(elements.get('lp-to-vlan-input').value, 'trunk 10,40');
        assert.equal(appState.links[0].from_port_id, null);
        assert.equal(appState.devicePorts[0].vlan, 'access 10');
        assert.equal(appState.legacyLinkVlans.length, 1);

        failSave = false;
        const saved = panel.applyLinkPanel({ showMessage: false });
        assert.equal(appState.devicePorts.length, 1);
        assert.equal(appState.legacyLinkVlans.length, 1);
        assert.equal(await saved, true);
        const batch = requests.at(-1);
        assert.equal(batch.complete_legacy_vlan, 20);
        assert.deepEqual(batch.links, [{ operation: 'update', id: 20, expected_revision: 3,
            link: { memo: '両端確認済み', from_port_name: 'LAN1' } }]);
        assert.deepEqual(batch.device_ports[0], { operation: 'update', id: 41, expected_revision: 4, port: { vlan: 'trunk 10,40' } });
        assert.equal(batch.device_ports[1].operation, 'create');
        assert.deepEqual(batch.device_ports[1].port, { device_id: 2, name: 'LAN1', vlan: 'access 40' });
        assert.equal(appState.links[0].from_port_id, 42);
        assert.equal(appState.links[0].to_port_id, 41);
        assert.deepEqual(appState.devicePorts.map(row => row.vlan), ['trunk 10,40', 'access 40']);
        assert.equal(appState.legacyLinkVlans.length, 0);
        assert.equal(elements.get('lp-legacy-vlan').hidden, true);
        assert.equal(elements.get('lp-from-vlan-editor').hidden, false);
        assert.equal(elements.get('lp-from-vlan-input').value, 'access 40');
        assert.equal(panel.hasUnappliedLinkPanelChanges(), false);
    });
    await t.test('現行VLANの未編集値は上書きせず、下書き中のポート競合は再適用しない', async () => {
        reset();
        appState.legacyLinkVlans = [{ link_id: 20, vlan: '旧設定' }];
        appState.devicePorts[0].vlan = 'access 10';
        appState.devicePorts.push({ id: 42, device_id: 2, name: 'Gi1', vlan: '既存設定', resource_revision: 1 });
        resetResourceBaseline(appState);
        panel.openLinkPanel(appState.links[0]);
        edit('lp-to-port', 'Gi1');
        assert.equal(elements.get('lp-to-vlan-input').value, '既存設定');
        edit('lp-from-vlan-input', '自分の下書き');
        appState.devicePorts[0].vlan = '別の更新';
        appState.devicePorts[0].resource_revision = 2;
        eventBus.emit('resources:saved', { device_ports: [appState.devicePorts[0]] });
        assert.equal(panel.applyLinkPanel({ showMessage: false }), false);
        assert.equal(requests.length, 0);
        assert.equal(elements.get('lp-from-vlan-input').value, '自分の下書き');
        assert.match(elements.get('lp-from-vlan-input-error').textContent, /変更されました/);
        assert.equal(panel.revertLinkPanelValues(), true);
        assert.equal(elements.get('lp-from-vlan-input').value, '別の更新');

        edit('lp-to-port', 'Gi1');
        resetResourceBaseline(appState);
        assert.equal(await panel.applyLinkPanel({ showMessage: false }), true);
        assert.deepEqual(requests[0].device_ports, []);
        assert.deepEqual(requests[0].links[0].link, { to_port_id: 42 });
        assert.equal(requests[0].complete_legacy_vlan, 20);
        assert.deepEqual(appState.legacyLinkVlans, []);
        assert.equal(appState.devicePorts[1].vlan, '既存設定');
    });
    await t.test('下書き中に同名の新規ポートが登録されたら、そのポートへ VLAN を上書きしない', () => {
        reset();
        appState.legacyLinkVlans = [{ link_id: 20, vlan: '旧設定' }];
        panel.openLinkPanel(appState.links[0]);
        edit('lp-to-port', 'LAN2');
        edit('lp-to-vlan-input', '下書き');
        appState.devicePorts.push({ id: 42, device_id: 2, name: 'LAN2', vlan: '別の設定', resource_revision: 2 });
        eventBus.emit('resources:saved', { device_ports: [appState.devicePorts[1]] });
        assert.equal(panel.applyLinkPanel({ showMessage: false }), false);
        assert.equal(requests.length, 0);
        assert.equal(elements.get('lp-to-vlan-input').value, '下書き');
        assert.equal(appState.devicePorts[1].vlan, '別の設定');
        assert.equal(appState.links[0].to_port_id, null);
    });
    await t.test('接続属性を変えずに既存ポートの VLAN だけでも再設定できる', async () => {
        reset();
        appState.legacyLinkVlans = [{ link_id: 20, vlan: '旧設定' }];
        panel.openLinkPanel(appState.links[0]);
        edit('lp-from-vlan-input', '再設定');
        assert.equal(await panel.applyLinkPanel({ showMessage: false }), true);
        assert.equal(requests[0].complete_legacy_vlan, 20);
        assert.deepEqual(requests[0].links, [{ operation: 'update', id: 20, expected_revision: 1, link: {} }]);
        assert.deepEqual(requests[0].device_ports, [{ operation: 'update', id: 41, expected_revision: 1, port: { vlan: '再設定' } }]);
        assert.equal(appState.devicePorts[0].vlan, '再設定');
        assert.equal(panel.hasUnappliedLinkPanelChanges(), false);
    });
    await t.test('保存順と逆の機器 ID 順で端点を表示し、ポート編集・検証は元の機器に対応する', async () => {
        reset();
        const points = [{ x: 150, y: 143 }, { x: 150, y: 180 }, { x: 230, y: 180 }, { x: 230, y: 143 }];
        appState.devices[0].id = 10;
        appState.placements[0].device_id = 10;
        Object.assign(appState.devicePorts[0], { device_id: 10, name: 'LAN1', vlan: 'access 10' });
        appState.devicePorts.push(
            { id: 42, device_id: 2, name: 'LAN1', vlan: 'native 20', resource_revision: 1 },
            { id: 43, device_id: 2, name: 'LAN2', vlan: 'access 30', resource_revision: 1 }
        );
        Object.assign(appState.links[0], { from_id: 10, to_id: 2, to_port_id: 42, memo: '保存する備考' });
        appState.viewLinkRoutes = [{ view_id: 10, device_a_id: 2, device_b_id: 10, manual_route: points }];
        resetResourceBaseline(appState);
        const before = { ...appState.links[0] };
        panel.openLinkPanel(appState.links[0]);
        const displayed = () => endpoints.children.map(row => row.children
            .filter(element => !element.id.endsWith('-error'))
            .map(element => element.id.endsWith('-port') ? element.value : element.textContent));
        assert.deepEqual(displayed(), [['機器B', 'LAN1', 'native 20'], ['機器A', 'LAN1', 'access 10']]);
        assert.equal(panel.hasUnappliedLinkPanelChanges(), false);
        assert.equal(elements.get('lp-apply-btn').disabled, true);

        const firstPort = endpoints.children[0].children[1];
        edit(firstPort.id, 'x'.repeat(51));
        assert.equal(panel.applyLinkPanel({ showMessage: false }), false);
        assert.equal(firstPort.getAttribute('aria-invalid'), 'true');
        assert.deepEqual(appState.links[0], before);
        assert.equal(requests.length, 0);
        edit(firstPort.id, 'LAN2');
        assert.deepEqual(displayed(), [['機器B', 'LAN2', 'access 30'], ['機器A', 'LAN1', 'access 10']]);
        assert.equal(panel.applyLinkPanel({ showMessage: false }), true);
        await settle();

        assert.equal(requests.length, 1);
        const saved = requests[0].links[0].link;
        assert.deepEqual([saved.from_id, saved.to_id, saved.from_port_id, saved.to_port_name], [10, 2, 41, 'LAN2']);
        assert.deepEqual([appState.links[0].from_port_id, appState.links[0].to_port_id], [41, 43]);
        assert.deepEqual([saved.label, saved.memo], ['リンクA', '保存する備考']);
        assert.equal(Object.hasOwn(saved, 'vlan'), false);
        assert.deepEqual(requests[0].device_ports, []);
        assert.deepEqual(appState.devicePorts.map(port => port.vlan), ['access 10', 'native 20', 'access 30']);
        assert.deepEqual(appState.viewLinkRoutes[0].manual_route, points);
        assert.equal(buildResourceSave().views.length, 0);
        assert.equal(panel.hasUnappliedLinkPanelChanges(), false);

        reset();
        panel.openLinkPanel(appState.links[0]);
        assert.deepEqual(displayed(), [['機器A', 'Gi1', '未設定'], ['機器B', '', '未指定']]);
    });
    await t.test('他画面で同じ項目が確定された場合は適用失敗でも入力を保持する', () => {
        reset();
        panel.openPanel(appState.devices[0]);
        edit('p-name', 'このパネルの入力');
        appState.devices[0].name = '別画面の確定値';
        assert.equal(panel.applyPanelValues({ showMessage: false }), false);
        assert.equal(appState.devices[0].name, '別画面の確定値');
        assert.equal(elements.get('p-name').value, 'このパネルの入力');
        assert.equal(requests.length, 0);
    });
    await t.test('適用ボタンは下書き・権限・認証状態に追従する', () => {
        reset();
        panel.openPanel(appState.devices[0]);
        const deviceApply = elements.get('p-apply-btn');
        assert.equal(deviceApply.disabled, true);
        edit('p-name', '');
        assert.equal(deviceApply.disabled, false);
        assert.equal(panel.applyPanelValues({ showMessage: false }), false);
        assert.equal(deviceApply.disabled, false, '入力検証の失敗後も修正して適用できる');
        appState.authExpired = true;
        eventBus.emit('save-state:changed', 'saved');
        assert.equal(deviceApply.disabled, true);
        appState.authExpired = false;
        window.APP_CONFIG.user.isAdmin = false;
        panel.setDevicePanelReadOnly(true);
        assert.equal(deviceApply.disabled, true);
        window.APP_CONFIG.user.isAdmin = true;
        panel.setDevicePanelReadOnly(false);
        assert.equal(deviceApply.disabled, false);
        edit('p-name', '機器A');
        panel.setDevicePanelReadOnly(false);
        assert.equal(deviceApply.disabled, true, '管理者への復帰で未変更ボタンを活性化しない');
        panel.openLinkPanel(appState.links[0]);
        const linkApply = elements.get('lp-apply-btn');
        assert.equal(linkApply.disabled, true);
        edit('lp-label', '未適用リンク');
        assert.equal(linkApply.disabled, false);
        appState.authExpired = true;
        eventBus.emit('save-state:changed', 'saved');
        assert.equal(linkApply.disabled, true);
        appState.authExpired = false;
        window.APP_CONFIG.user.isAdmin = false;
        panel.setLinkPanelReadOnly(true);
        assert.equal(linkApply.disabled, true);
        window.APP_CONFIG.user.isAdmin = true;
        panel.setLinkPanelReadOnly(false);
        assert.equal(linkApply.disabled, false);
        edit('lp-label', 'リンクA');
        panel.setLinkPanelReadOnly(false);
        assert.equal(linkApply.disabled, true);
    });
    await t.test('競合対象は適用禁止、別対象は編集と確定を継続できる', async () => {
        reset();
        appState.resourceConflicts.devices.set(1, { name: '機器A', message: '競合' });
        panel.openPanel(appState.devices[0]);
        edit('p-name', '競合中の入力');
        assert.equal(panel.applyPanelValues({ showMessage: false }), false);
        assert.equal(elements.get('p-name').value, '競合中の入力');
        assert.equal(elements.get('p-reload-conflict-btn').hidden, false);
        assert.equal(elements.get('p-apply-btn').disabled, true);
        assert.equal(requests.length, 0);
        let openPromise = panel.openPanel(appState.devices[1]);
        await chooseAction('discard');
        assert.equal(await openPromise, true);
        edit('p-name', '独立した編集');
        assert.equal(panel.applyPanelValues({ showMessage: false }), true);
        await settle();
        assert.deepEqual(requests[0].devices.map(row => row.id), [2]);
        appState.resourceConflicts.links.set(20, { name: 'リンクA', message: '競合' });
        panel.openLinkPanel(appState.links[0]);
        edit('lp-label', '競合リンク');
        assert.equal(panel.applyLinkPanel({ showMessage: false }), false);
        assert.equal(elements.get('lp-reload-conflict-btn').hidden, false);
        assert.equal(elements.get('lp-apply-btn').disabled, true);
        assert.equal(elements.get('lp-label').value, '競合リンク');
    });
    await t.test('対象再読込はその下書きのみ破棄する', () => {
        reset();
        drafts.getDeviceDraft('sheet', 2).memo = '別対象の未適用';
        panel.openPanel(appState.devices[0]);
        edit('p-name', '再読込前の下書き');
        appState.devices[0].name = 'サーバーの最新値';
        eventBus.emit('resource:reloaded', { kind: 'devices', id: 1 });
        assert.equal(elements.get('p-name').value, 'サーバーの最新値');
        assert.equal(panel.hasUnappliedPanelChanges(), false);
        assert.equal(drafts.hasDeviceDraftChanges('sheet', 2), true);
    });
    await t.test('保存失敗後も入力を保持し、再適用で実通信を再試行する', async child => {
        reset();
        child.mock.method(console, 'error', () => {});
        panel.openPanel(appState.devices[0]);
        edit('p-name', '保存したい値');
        failSave = true;
        panel.applyPanelValues({ showMessage: false });
        assert.equal(elements.get('p-apply-btn').disabled, true, '通信中だけでは再適用を有効にしない');
        await settle();
        assert.equal(elements.get('p-name').value, '保存したい値');
        assert.equal(appState.devices[0].name, '保存したい値');
        assert.equal(elements.get('p-apply-btn').disabled, false, '失敗後は同じ対象の適用ボタンで再試行できる');
        failSave = false;
        panel.applyPanelValues({ showMessage: false });
        await settle();
        assert.equal(requests.length, 2);
        assert.equal(requests[1].devices[0].device.name, '保存したい値');
        assert.equal(elements.get('p-apply-btn').disabled, true, '再試行成功後は未変更の適用ボタンを無効に戻す');
    });
    await t.test('リンクも失敗後の適用ボタンから再試行できる', async child => {
        reset();
        child.mock.method(console, 'error', () => {});
        panel.openLinkPanel(appState.links[0]);
        edit('lp-label', '保存したいリンク');
        failSave = true;
        panel.applyLinkPanel({ showMessage: false });
        assert.equal(elements.get('lp-apply-btn').disabled, true);
        await settle();
        assert.equal(elements.get('lp-label').value, '保存したいリンク');
        assert.equal(elements.get('lp-apply-btn').disabled, false);
        failSave = false;
        panel.applyLinkPanel({ showMessage: false });
        await settle();
        assert.equal(requests.length, 2);
        assert.equal(requests[1].links[0].link.label, '保存したいリンク');
        assert.equal(elements.get('lp-apply-btn').disabled, true);
    });
    await t.test('リンクDeleteは入力中・モーダル・viewer・確認キャンセルでは削除しない', async () => {
        reset();
        panel.openLinkPanel(appState.links[0]);
        const key = target => ({ key: 'Delete', target, preventDefault() {}, stopImmediatePropagation() {} });
        for (const target of [{ tagName: 'INPUT' }, { tagName: 'TEXTAREA' }, { tagName: 'SELECT' }, { isContentEditable: true }]) {
            document.activeElement = target;
            await selection.onKeyDown(key(target));
            assert.equal(appState.links[0].id, 20);
        }
        document.activeElement = null;
        const modal = new Element('view-manager-overlay');
        modal.hidden = false;
        elements.set(modal.id, modal);
        registerModalOpen('delete-blocker', modal);
        try {
            await selection.onKeyDown(key(null));
            assert.equal(appState.links[0].id, 20);
        } finally {
            registerModalClose('delete-blocker', { restoreFocus: false });
            elements.delete(modal.id);
        }
        window.APP_CONFIG.user.isAdmin = false;
        await selection.onKeyDown(key(null));
        assert.equal(appState.links[0].id, 20);
        window.APP_CONFIG.user.isAdmin = true;
        let message;
        window.confirm = text => { message = text; return false; };
        appState.legacyLinkVlans = [{ link_id: 21, vlan: 'access 21' }];
        await selection.onKeyDown(key(null));
        assert.doesNotMatch(message, /未移行VLAN/);
        assert.equal(appState.links[0].id, 20);
        assert.equal(requests.length, 0);
        appState.legacyLinkVlans.push({ link_id: '20', vlan: 'access 20' });
        await selection.onKeyDown(key(null));
        assert.match(message, /未移行VLANも削除されます/);
        assert.equal(appState.links[0].id, 20);
        assert.equal(requests.length, 0);
        window.confirm = () => true;
        await selection.onKeyDown(key(null));
        await settle();
        assert.deepEqual(appState.links, []);
        assert.equal(appState.editingLinkId, null);
        assert.deepEqual(requests[0].links, [{ operation: 'delete', id: 20, expected_revision: 1 }]);
    });
    await t.test('パネルの複数エラーを同時表示し、支援説明を残して修正項目だけ解除する', () => {
        reset();
        panel.openPanel(appState.devices[0]);
        for (const id of ['p-ip-error', 'p-management-port-error', 'p-maintenance-expiry-error']) elements.set(id, new Element(id));
        elements.get('p-ip').setAttribute('aria-describedby', 'p-ip-help');
        edit('p-ip', '192.0.2.999');
        edit('p-management-scheme', 'https');
        edit('p-management-port', '65536');
        edit('p-maintenance-expiry', '2026-02-30');
        assert.equal(panel.applyPanelValues({ showMessage: false }), false);
        assert.equal(requests.length, 0);
        for (const id of ['p-ip', 'p-management-port', 'p-maintenance-expiry']) {
            assert.equal(elements.get(id).getAttribute('aria-invalid'), 'true');
            assert.equal(elements.get(`${id}-error`).hidden, false);
        }
        edit('p-ip', '192.0.2.1');
        assert.equal(elements.get('p-ip').getAttribute('aria-invalid'), null);
        assert.equal(elements.get('p-ip').getAttribute('aria-describedby'), 'p-ip-help');
        assert.equal(elements.get('p-management-port').getAttribute('aria-invalid'), 'true');
    });
    await t.test('対象機器の再読込で接続が消えたときは未適用入力がない場合だけ接続パネルを閉じる', () => {
        reset();
        appState.editingLinkGroupKey = null;
        panel.openLinkPanel(appState.links[0]);
        edit('lp-label', '保持したい入力');
        appState.links = [];
        eventBus.emit('resource:reloaded', { kind: 'devices', id: 1 });
        assert.equal(elements.get('link-panel').hidden, false);
        assert.equal(elements.get('lp-label').value, '保持したい入力');

        reset();
        for (const id of ['lp-group-summary', 'lp-group-title', 'lp-group-endpoints', 'lp-group-connections',
            'lp-detail-id', 'lp-detail-fields', 'lp-detail-actions', 'lp-group-back']) {
            elements.set(id, new Element(id));
        }
        appState.links.push(normalizeLink({ id: 21, from_id: 1, to_id: 2, resource_revision: 1, label: 'リンクB' }));
        panel.openLinkGroup({ display_key: '10:1:2', link_ids: [20, 21], view_id: 10, from_id: 1, to_id: 2 });
        assert.equal(appState.editingLinkGroupKey, '10:1:2');
        assert.equal(elements.get('link-panel').hidden, false);
        appState.devices = appState.devices.filter(row => row.id !== 1);
        appState.placements = appState.placements.filter(row => row.device_id !== 1);
        appState.links = [];
        eventBus.emit('resource:reloaded', { kind: 'devices', id: 1 });
        assert.equal(elements.get('link-panel').hidden, true);
        assert.equal(appState.editingLinkGroupKey, null);
    });
    await t.test('applyPanelValuesは他画面更新の未編集DOMを上書きせずsyncPanelIfOpenは未変更DOMを同期する', () => {
        reset();
        panel.openPanel(appState.devices[0]);
        drafts.getDeviceDraft('panel', 1).memo = '別画面で更新された備考';
        edit('p-name', 'パネル入力名');
        assert.equal(panel.applyPanelValues({ showMessage: false }), true);
        assert.equal(appState.devices[0].name, 'パネル入力名');
        assert.equal(appState.devices[0].memo, '別画面で更新された備考');

        reset();
        panel.openPanel(appState.devices[0]);
        appState.devices[0].location = '同期された設置場所';
        panel.syncPanelIfOpen();
        assert.equal(elements.get('p-location').value, '同期された設置場所');
    });
    await t.test('deleteDeviceCompletelyは認証切れや未確認状態で拒否し削除確定時に両スコープの下書きを破棄する', async () => {
        reset();
        panel.openPanel(appState.devices[0]);
        drafts.getDeviceDraft('panel', 1).memo = 'panel draft';
        drafts.getDeviceDraft('ledger', 1).memo = 'ledger draft';

        appState.authExpired = true;
        assert.equal(await panel.deleteDeviceCompletely([1]), false);
        assert.equal(appState.devices.length, 2);

        appState.authExpired = false;
        appState.appStatus.state = 'unconfirmed';
        assert.equal(await panel.deleteDeviceCompletely([1]), false);
        assert.equal(appState.devices.length, 2);

        appState.appStatus.state = 'saved';
        window.confirm = () => true;
        assert.equal(await panel.deleteDeviceCompletely([1]), true);
        await settle();
        queue.clearPendingSave();
        assert.equal(appState.devices.some(d => d.id === 1), false);
        assert.equal(drafts.hasDeviceDraftChanges('panel', 1), false);
        assert.equal(drafts.hasDeviceDraftChanges('ledger', 1), false);
    });
});
