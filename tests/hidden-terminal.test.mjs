import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installWorkspaceDom } from './helpers/workspace-dom.mjs';
import { initializeHiddenTerminal } from '../public/js/modals/hidden-terminal.js';
import { appState, normalizeDevice } from '../public/js/core/state.js';
import { getDeviceDraft, discardDeviceDrafts } from '../public/js/core/device-drafts.js';
import { eventBus } from '../public/js/core/event-bus.js';
import { getFocusableElements, getTopModalContainer, initModalFocusTrap } from '../public/js/core/modal-focus.js';
import { onKeyDown } from '../public/js/canvas/selection.js';

function setup(t) {
    const keys = ['window', 'document', 'HTMLElement', 'Element', 'performance', 'fetch', 'localStorage', 'sessionStorage'];
    const globals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const originalState = { ...appState };
    let dispose = () => {};
    const unsubscribe = [];
    t.after(() => {
        try {
            dispose();
        } finally {
            unsubscribe.forEach(off => off());
            discardDeviceDrafts('hidden-terminal-test');
            Object.assign(appState, originalState);
            for (const [key, descriptor] of globals) {
                if (descriptor) Object.defineProperty(globalThis, key, descriptor);
                else delete globalThis[key];
            }
        }
    });
    const dom = installWorkspaceDom({
        templates: ['templates/components/toolbar.php', 'templates/modals/hidden_terminal.php'],
        phpSetup: "define('NETARIUM_VERSION', 'test'); $isAdmin = true; $username = 'Synthetic user'; $userRole = 'admin'; $csrfToken = 'test-only-token';"
    });
    let now = 0;
    Object.defineProperty(globalThis, 'performance', { configurable: true, value: { now: () => now } });
    window.performance = performance;
    window.removeEventListener = () => {};
    window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    const effects = { network: 0, storage: 0, save: 0, finishFloorPlan: 0 };
    globalThis.fetch = window.fetch = async () => {
        effects.network++;
        throw new Error('Hidden terminal must not access the network');
    };
    const storage = {
        getItem() { effects.storage++; return null; },
        setItem() { effects.storage++; },
        removeItem() { effects.storage++; },
        clear() { effects.storage++; }
    };
    for (const key of ['localStorage', 'sessionStorage']) {
        Object.defineProperty(globalThis, key, { configurable: true, value: storage });
        window[key] = storage;
    }
    for (const name of ['save-state:changed', 'resources:saved', 'floor-plan:saved']) {
        unsubscribe.push(eventBus.on(name, () => effects.save++));
    }
    unsubscribe.push(eventBus.on('floor-plan:finish', () => effects.finishFloorPlan++));
    Object.assign(appState, {
        devices: [normalizeDevice({ id: 901, name: 'Synthetic terminal fixture', type: 'switch' })],
        views: [{ id: 901, name: 'Synthetic view', view_type: 'topology' }],
        placements: [{ id: 901, device_id: 901, view_id: 901, x: 120, y: 80 }],
        links: [], currentViewId: 901, selectedPlacementIds: new Set([901]),
        selectedCanvasNoteId: 902, editingDeviceId: 901, editingLinkId: null,
        appStatus: { dirty: true, state: 'pending', lastSavedAt: null, lastMonitoredAt: null, lastError: null },
        viewState: { scale: 1.5, panX: 40, panY: 60, minScale: 0.05, maxScale: 3 },
        viewStates: new Map([[901, { scale: 1.5, panX: 40, panY: 60 }]])
    });
    const draft = getDeviceDraft('hidden-terminal-test', 901);
    draft.name = 'Synthetic unapplied draft';
    const stateBefore = structuredClone(appState);
    const draftBefore = structuredClone(draft);
    const selectedIds = appState.selectedPlacementIds;
    const get = name => dom.get(`hidden-terminal-${name}`);
    const logo = dom.get('toolbar-brand-trigger');
    assert.equal(logo.tagName, 'BUTTON');
    assert.equal(logo.getAttribute('type'), 'button');
    assert.ok(logo.querySelector('.toolbar-brand-logo'));
    assert.equal(get('overlay').hidden, true);
    assert.equal(get('console').hidden, true);
    assert.equal(get('input').getAttribute('maxlength'), '256');
    // No routes: the shared helper's synchronous RAF is for focus, not animation.
    const world = dom.add('div', 'world');
    dom.add('svg', 'link-layer', world);
    initModalFocusTrap();
    dispose = initializeHiddenTerminal();
    assert.equal(typeof dispose, 'function');
    const click = async (times = 5, interval = 100) => {
        logo.focus();
        for (let index = 0; index < times; index++) {
            await logo.click();
            now += interval;
        }
    };
    const submit = async command => {
        get('input').value = command;
        let prevented = false;
        await get('form').dispatch('submit', { preventDefault() { prevented = true; } });
        assert.equal(prevented, true, '送信はページ遷移せずローカルで完結する');
        return get('output').textContent;
    };
    const enter = async () => {
        await click();
        assert.equal(get('discovery').hidden, false);
        await get('enter').click();
        assert.equal(get('discovery').hidden, true);
        assert.equal(get('console').hidden, false);
        assert.equal(document.activeElement, get('input'));
    };
    const assertUntouched = () => {
        assert.deepEqual(appState, stateBefore, '業務state・座標・選択・保存状態を変えない');
        assert.equal(appState.selectedPlacementIds, selectedIds, '選択Setも置き換えない');
        assert.equal(getDeviceDraft('hidden-terminal-test', 901), draft);
        assert.deepEqual(draft, draftBefore, '未適用draftを確定・破棄しない');
        assert.deepEqual(effects, { network: 0, storage: 0, save: 0, finishFloorPlan: 0 });
    };
    return { dom, get, logo, click, submit, enter, assertUntouched, advance: value => { now += value; }, dispose: () => dispose() };
}

function escape() {
    return onKeyDown({ key: 'Escape', preventDefault() {}, stopImmediatePropagation() {} });
}

async function assertTabCycle(dom, overlay) {
    const focusables = getFocusableElements(overlay);
    assert.ok(focusables.length >= 2);
    for (const [from, to, shiftKey] of [
        [focusables.at(-1), focusables[0], false],
        [focusables[0], focusables.at(-1), true]
    ]) {
        from.focus();
        let prevented = false;
        await dom.events.dispatch('keydown', { key: 'Tab', shiftKey, preventDefault() { prevented = true; } });
        assert.equal(prevented, true);
        assert.equal(document.activeElement, to);
    }
}

test('実ロゴの5クリックは最初のクリックから3秒以内だけ有効で、反復起動しない', async t => {
    const ui = setup(t);
    await ui.click(4, 0);
    assert.equal(ui.get('overlay').hidden, true);
    ui.advance(3001);
    await ui.click(1, 0);
    assert.equal(ui.get('overlay').hidden, true, '期限切れの4クリックを引き継がない');
    await ui.click(4, 0);
    assert.equal(ui.get('overlay').hidden, false);
    const title = ui.get('title').textContent;
    await ui.click(10, 0);
    assert.equal(ui.get('title').textContent, title);
    assert.equal(getTopModalContainer(), ui.get('overlay'));
    await ui.get('cancel').click();
    assert.equal(getTopModalContainer(), null, '二重stackを残さない');
    assert.equal(document.activeElement, ui.logo);
    await ui.click(4, 750);
    assert.equal(ui.get('overlay').hidden, true);
    await ui.click(1, 0);
    assert.equal(ui.get('overlay').hidden, false, '3000msの境界を含む');
    await ui.get('cancel').click();
    await ui.click(4, 751);
    await ui.click(1, 0);
    assert.equal(ui.get('overlay').hidden, true, '各隣接クリックではなく最初からの経過時間を測る');
    ui.assertUntouched();
});

test('発見のcancelと再開、同一モーダル内の進行、Tab循環、全閉鎖方法でロゴへ復帰する', async t => {
    const ui = setup(t);
    await ui.click();
    const discoveryTitle = ui.get('title').textContent;
    await assertTabCycle(ui.dom, ui.get('overlay'));
    await ui.get('overlay').dispatch('click', { target: ui.get('title') });
    assert.equal(ui.get('overlay').hidden, false, '内部クリックは背景閉鎖ではない');
    await ui.get('cancel').click();
    assert.equal(ui.get('overlay').hidden, true);
    assert.equal(document.activeElement, ui.logo);
    for (const dismiss of [
        () => ui.get('close').click(), escape,
        () => ui.get('overlay').click(), () => ui.submit('exit')
    ]) {
        await ui.enter();
        assert.notEqual(ui.get('title').textContent, discoveryTitle);
        assert.match(ui.get('output').textContent, /terminal/i);
        assert.match(ui.get('output').textContent, /help/i);
        await assertTabCycle(ui.dom, ui.get('overlay'));
        await dismiss();
        assert.equal(ui.get('overlay').hidden, true);
        assert.equal(getTopModalContainer(), null);
        assert.equal(document.activeElement, ui.logo);
    }
    ui.assertUntouched();
});

test('許可コマンドのみを固定解釈しhelpに隠しコマンドを載せず、疑似結果を明示する', async t => {
    const ui = setup(t);
    await ui.enter();
    await ui.submit('help');
    const output = ui.get('output').children.at(-1).textContent;
    for (const command of ['help', 'about', 'whoami', 'ping 127.0.0.1', 'clear', 'exit']) {
        assert.ok(output.includes(command), `${command}を案内する`);
    }
    for (const command of ['coffee', 'layer8', 'netarium', 'konami']) assert.ok(!output.includes(command));
    const cases = [
        ['about', /net\s*\(network\)|network.*arium/i],
        ['whoami', /keeper|cables|vlan/i],
        ['ping 127.0.0.1', /simulation|simulated/i],
        ['coffee', /418.*teapot/i],
        ['layer8', /joke.*not a real check/i],
        [' NeTaRiUm ', /no routes.*coffee break/i]
    ];
    for (const [command, expected] of cases) {
        await ui.submit('clear');
        const result = await ui.submit(command);
        assert.match(result, expected);
        assert.doesNotMatch(result, /command not found/i);
        assert.equal(ui.get('input').value, '');
        assert.equal(document.activeElement, ui.get('input'));
        if (command === 'whoami') {
            assert.ok(!result.includes(window.APP_CONFIG.csrfToken));
            assert.ok(!result.includes('Synthetic terminal fixture'));
        }
        ui.assertUntouched();
    }
    for (const command of ['netarimu', 'konami', 'ping 192.0.2.1', 'ping 127.0.0.1 extra', 'about now', 'help; exit']) {
        await ui.submit('clear');
        assert.match(await ui.submit(command), /command not found/i);
        assert.equal(ui.get('overlay').hidden, false);
    }
    ui.assertUntouched();
});

test('空白と大小文字を正規化し、空入力・HTML・長文を安全に扱う', async t => {
    const ui = setup(t);
    await ui.enter();
    const initial = ui.get('output').textContent;
    const blocks = ui.get('output').children.length;
    await ui.submit(' \t\n ');
    assert.equal(ui.get('output').textContent, initial);
    assert.equal(ui.get('output').children.length, blocks);
    await ui.submit('clear');
    const normalized = await ui.submit(' \tPiNg  \t 127.0.0.1  ');
    assert.match(normalized, /simulation|simulated/i);
    assert.doesNotMatch(normalized, /command not found/i);
    await ui.submit('clear');
    const unknown = await ui.submit('  UNKNOWN \t ARG  ');
    assert.match(unknown, /command not found:\s*unknown\s+arg/i);
    const html = '<img src=x onerror="globalThis.terminalInjected=true"><script>throw 1</script>';
    await ui.submit('clear');
    const htmlResult = await ui.submit(html);
    assert.ok(htmlResult.includes('<img'));
    assert.ok(htmlResult.includes('<script>'));
    assert.equal(ui.get('output').querySelector('img, script'), null, '入力をHTMLノード化しない');
    await ui.submit('clear');
    const boundary = 'x'.repeat(256);
    assert.ok((await ui.submit(boundary)).includes(boundary));
    await ui.submit('clear');
    const long = await ui.submit('x'.repeat(257));
    assert.match(long, /too long|maximum|上限|長すぎ/i);
    assert.ok(!long.includes('x'.repeat(257)));
    assert.doesNotMatch(long, /command not found/i, '長文は切り詰めてコマンド実行しない');
    await ui.submit('clear');
    assert.match(await ui.submit('😀'.repeat(129)), /too long|maximum|上限|長すぎ/i, 'UTF-16の256文字上限');
    assert.equal(ui.get('overlay').hidden, false);
    ui.assertUntouched();
});

test('clearは表示だけ消去して入力を保持し、閉鎖・再起動でセッションをリセットする', async t => {
    const ui = setup(t);
    await ui.enter();
    const input = ui.get('input');
    const form = ui.get('form');
    await ui.submit('about');
    await ui.submit('clear');
    assert.equal(ui.get('output').textContent, '');
    assert.equal(ui.get('input'), input, '入力要素を破棄しない');
    assert.equal(ui.get('form'), form);
    assert.equal(document.activeElement, input);
    await input.dispatch('keydown', { key: 'ArrowUp' });
    assert.equal(input.value, 'clear', '表示clearでもセッション入力履歴は残す');
    await ui.submit('coffee');
    input.value = 'unfinished session input';
    await ui.get('close').click();
    await ui.click(4, 0);
    assert.equal(ui.get('overlay').hidden, true, '閉鎖前のクリック回数を持ち越さない');
    await ui.click(1, 0);
    assert.equal(ui.get('discovery').hidden, false);
    assert.equal(ui.get('console').hidden, true);
    await ui.get('enter').click();
    assert.equal(input.value, '');
    assert.doesNotMatch(ui.get('output').textContent, /teapot|unfinished session input/i);
    await input.dispatch('keydown', { key: 'ArrowUp' });
    assert.equal(input.value, '', '前セッションの入力履歴を持ち越さない');
    ui.assertUntouched();
});

test('表示200ブロック・履歴100件を超えて蓄積せず、dispose後は起動しない', async t => {
    const ui = setup(t);
    await ui.enter();
    for (let index = 0; index < 125; index++) await ui.submit(`unknown-${index}`);
    assert.ok(ui.get('output').children.length <= 200);
    assert.ok(!ui.get('output').textContent.includes('unknown-0'), '古い表示を退役させる');
    assert.ok(ui.get('output').textContent.includes('unknown-124'));
    for (let index = 0; index < 110; index++) await ui.get('input').dispatch('keydown', { key: 'ArrowUp' });
    assert.equal(ui.get('input').value, 'unknown-25', '保持する履歴は最新100件');
    for (let index = 0; index < 110; index++) await ui.get('input').dispatch('keydown', { key: 'ArrowDown' });
    assert.equal(ui.get('input').value, '');
    ui.dispose();
    assert.equal(ui.get('overlay').hidden, true);
    assert.equal(getTopModalContainer(), null);
    assert.equal(document.activeElement, ui.logo);
    await ui.click(10, 0);
    assert.equal(ui.get('overlay').hidden, true, 'disposeがロゴlistenerを解除する');
    ui.assertUntouched();
});
