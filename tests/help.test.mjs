import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { installWorkspaceDom, WorkspaceElement } from './helpers/workspace-dom.mjs';
const helpScript = readFileSync(new URL('../public/js/help.js', import.meta.url), 'utf8');
const { initializeHelp } = runInNewContext(`${helpScript}\n({ initializeHelp });`);

const ids = ['screen', 'canvas', 'modes', 'devices', 'ledger', 'views', 'saving', 'accounts'];

function setup(t, { narrow = false, hash = '', nested = false } = {}) {
    const keys = ['window', 'document', 'HTMLElement', 'Element'];
    const globals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const dom = installWorkspaceDom();
    const doc = document;
    const win = window;
    t.after(() => {
        for (const [key, descriptor] of globals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    });
    doc.body.innerHTML = `<div class="help-layout">
        <aside class="help-toc"><details id="help-toc" open><summary>目次</summary>
        <nav aria-label="章目次"><ol>${ids.map(id => `<li><a href="#${id}">${id}</a>${nested && id === 'modes' ? '<ol id="toc-modes"><li><a href="#link-route">経路調整</a></li></ol>' : nested && id === 'devices' ? '<ol id="toc-devices"><li><a href="#device-sheet">機器個票</a></li></ol>' : ''}</li>`).join('')}</ol></nav>
        </details></aside>
        <main id="help-content" class="help-container">
        ${ids.map(id => `<h2 id="${id}" tabindex="-1">${id}</h2>${nested && id === 'modes' ? '<h3 id="link-route">経路調整</h3>' : nested && id === 'devices' ? '<h3 id="device-sheet">機器個票</h3>' : ''}`).join('')}
        <figure class="help-figure"><a data-help-image href="assets/help/screen.png"
            data-caption="画面全体の説明" aria-haspopup="dialog" aria-controls="help-image-dialog">
            <img alt="画面構成" src="assets/help/screen.png"></a></figure>
        <div class="footer-close">
            <button id="help-tab-close">このタブを閉じる</button>
            <p id="help-tab-close-notice" hidden>ブラウザのタブを閉じてください</p>
        </div></main></div>
        <dialog id="help-image-dialog" aria-labelledby="help-image-title">
            <h2 id="help-image-title">画像</h2>
            <button id="help-image-close" class="btn btn-secondary btn-sm">閉じる</button>
            <div class="help-image-scroll"><img id="help-image-preview"></div><p id="help-image-caption"></p>
        </dialog>`;
    const events = new WorkspaceElement();
    const media = new WorkspaceElement();
    media.matches = narrow;
    win.addEventListener = events.addEventListener.bind(events);
    win.matchMedia = query => {
        assert.equal(query, '(max-width: 900px)');
        return media;
    };
    win.close = () => {};
    win.location = { hash };
    win.scrollY = 0;
    win.innerHeight = 700;
    doc.documentElement = { scrollHeight: 4000, get scrollTop() { return win.scrollY; } };
    let frames = [];
    win.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
    const flush = () => {
        const callbacks = frames;
        frames = [];
        callbacks.forEach(callback => callback());
    };
    for (const [index, id] of ids.entries()) {
        dom.get(id).getBoundingClientRect = () => ({ top: 200 + index * 400 - win.scrollY });
    }
    if (nested) {
        dom.get('link-route').getBoundingClientRect = () => ({ top: 1200 - win.scrollY });
        dom.get('device-sheet').getBoundingClientRect = () => ({ top: 1600 - win.scrollY });
    }
    const dialog = dom.get('help-image-dialog');
    dialog.open = false;
    dialog.showModal = () => { dialog.open = true; };
    dialog.close = () => {
        dialog.open = false;
        return dialog.dispatch('close');
    };
    const preview = dom.get('help-image-preview');
    Object.defineProperty(preview, 'src', {
        get: () => preview.getAttribute('src') || '',
        set: value => preview.setAttribute('src', value)
    });
    dialog.getBoundingClientRect = () => ({ left: 100, top: 100, right: 900, bottom: 600 });
    return { dom, doc, win, events, media, dialog, flush, pending: () => frames.length,
        initialize: () => initializeHelp(doc, win),
        links: dom.get('help-toc').querySelectorAll('a'),
        imageLink: dom.get('help-content').querySelector('a[data-help-image]') };
}

function assertChapter(fixture, id) {
    assert.deepEqual(fixture.links.filter(link => link.getAttribute('aria-current') === 'location')
        .map(link => link.getAttribute('href')), [`#${id}`]);
}

test('目次: 初期章、固定offset、scrollのRAF抑制、最下端', t => {
    const f = setup(t);
    f.initialize();
    assertChapter(f, 'screen');
    f.flush();
    f.win.scrollY = 568;
    f.events.dispatch('scroll');
    f.events.dispatch('scroll');
    f.events.dispatch('scroll');
    assert.equal(f.pending(), 1);
    assertChapter(f, 'screen');
    f.flush();
    assertChapter(f, 'canvas');
    f.win.scrollY = 3300;
    f.events.dispatch('scroll');
    f.flush();
    assertChapter(f, 'accounts');
});

test('目次: 初期hashとhashchange、戻る相当の位置復元をnativeのまま追跡', t => {
    const f = setup(t, { hash: '#devices' });
    f.win.scrollY = 1368;
    f.initialize();
    assertChapter(f, 'devices');
    f.flush();
    assertChapter(f, 'devices');
    f.win.location.hash = '#canvas';
    f.win.scrollY = 568;
    f.events.dispatch('hashchange');
    assertChapter(f, 'canvas');
    f.flush();
    assert.equal(f.win.location.hash, '#canvas');
    f.win.scrollY = 2568;
    f.events.dispatch('pageshow');
    f.flush();
    assertChapter(f, 'saving');
});

test('目次: resizeと画像loadによる章位置変化、短いページの先頭', t => {
    const f = setup(t);
    f.initialize();
    f.flush();
    f.win.scrollY = 968;
    f.events.dispatch('resize');
    f.flush();
    assertChapter(f, 'modes');
    f.dom.get('modes').getBoundingClientRect = () => ({ top: 100 });
    f.dom.get('help-content').dispatch('load', { target: f.imageLink.querySelector('img') });
    f.flush();
    assertChapter(f, 'canvas');
    f.win.scrollY = 0;
    f.doc.documentElement.scrollHeight = 500;
    f.events.dispatch('resize');
    f.flush();
    assertChapter(f, 'screen');
});

test('狭幅目次: 媒体変更だけでopenを切り替え、手動操作を維持', t => {
    const f = setup(t, { narrow: true });
    f.initialize();
    const toc = f.dom.get('help-toc');
    assert.equal(toc.open, false);
    toc.open = true;
    f.events.dispatch('resize');
    f.events.dispatch('scroll');
    f.flush();
    assert.equal(toc.open, true);
    f.media.matches = false;
    f.media.dispatch('change');
    assert.equal(toc.open, true);
    toc.open = false;
    f.events.dispatch('resize');
    assert.equal(toc.open, false);
    f.media.matches = true;
    f.media.dispatch('change');
    assert.equal(toc.open, false);
});

for (const route of ['button', 'backdrop', 'escape']) {
    test(`画像拡大: ${route}で閉じ、previewをリセットして起点へフォーカス復帰`, async t => {
        const f = setup(t);
        f.initialize();
        f.imageLink.focus();
        let prevented = false;
        // Enter on a native anchor produces this same click; no key handler is required.
        await f.dom.get('help-content').dispatch('click', {
            target: f.imageLink.querySelector('img'), button: 0, detail: route === 'escape' ? 0 : 1,
            preventDefault() { prevented = true; }
        });
        assert.equal(prevented, true);
        assert.equal(f.dialog.open, true);
        assert.equal(f.dom.get('help-image-preview').src, 'assets/help/screen.png');
        assert.equal(f.dom.get('help-image-preview').alt, '画面構成');
        assert.equal(f.dom.get('help-image-title').textContent, '画面全体の説明');
        assert.equal(f.dom.get('help-image-caption').textContent, '画面構成');
        assert.equal(f.doc.activeElement, f.dom.get('help-image-close'));
        if (route === 'button') await f.dom.get('help-image-close').dispatch('click');
        if (route === 'backdrop') {
            await f.dialog.dispatch('click', { clientX: 120, clientY: 120 });
            assert.equal(f.dialog.open, true, 'dialogの余白は背景として扱わない');
            await f.dialog.dispatch('click', { clientX: 20, clientY: 20 });
        }
        if (route === 'escape') {
            // DOM substitute for the UA's unprevented Escape cancel/close sequence.
            let canceled = false;
            await f.dialog.dispatch('cancel', { preventDefault() { canceled = true; } });
            assert.equal(canceled, false);
            await f.dialog.close();
        }
        assert.equal(f.dialog.open, false);
        assert.equal(f.dom.get('help-image-preview').getAttribute('src'), null);
        assert.equal(f.dom.get('help-image-preview').alt, '');
        assert.equal(f.dom.get('help-image-caption').textContent, '');
        assert.equal(f.doc.activeElement, f.imageLink);
        assert.equal(f.imageLink.getAttribute('href'), 'assets/help/screen.png');
    });
}

test('画像拡大: 修飾クリックは原寸hrefを維持', async t => {
    const f = setup(t);
    f.initialize();
    for (const options of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
        let prevented = false;
        await f.dom.get('help-content').dispatch('click', { target: f.imageLink,
            preventDefault() { prevented = true; }, ...options });
        assert.equal(prevented, false);
        assert.equal(f.dialog.open, false);
    }
});

test('画像拡大: native dialog未対応ではクリックを横取りしない', async t => {
    const f = setup(t);
    f.dialog.showModal = undefined;
    f.initialize();
    let prevented = false;
    await f.dom.get('help-content').dispatch('click', { target: f.imageLink,
        preventDefault() { prevented = true; } });
    assert.equal(prevented, false);
    assert.equal(f.imageLink.getAttribute('href'), 'assets/help/screen.png');
});

test('目次: windowへ伝播しない本文のscrollも追跡する', async t => {
    const f = setup(t);
    f.initialize();
    f.flush();
    f.win.scrollY = 968;
    await f.dom.events.dispatch('scroll', { target: f.doc.body });
    f.flush();
    assertChapter(f, 'modes');
});

test('目次: 小項目の現在位置と親章を強調し、次章で旧強調を解除する', async t => {
    const f = setup(t, { nested: true });
    f.initialize();
    f.flush();
    f.win.scrollY = 1168;
    await f.dom.events.dispatch('scroll', { target: f.doc.body });
    f.flush();
    assertChapter(f, 'link-route');
    const parent = f.links.find(link => link.getAttribute('href') === '#modes');
    assert.equal(parent.classList.contains('is-current-chapter'), true);
    f.win.scrollY = 1368;
    await f.events.dispatch('scroll');
    f.flush();
    assertChapter(f, 'devices');
    assert.equal(parent.classList.contains('is-current-chapter'), false);
});

test('目次: 実スクロール要素の最下端を判定する', t => {
    const f = setup(t);
    f.doc.documentElement.scrollHeight = 700;
    f.doc.scrollingElement = { scrollHeight: 4000, scrollTop: 3300 };
    f.initialize();
    f.flush();
    assertChapter(f, 'accounts');
});

test('目次: 長い目次の画面外にある現在項目を目次内で表示する', async t => {
    const f = setup(t);
    const toc = f.dom.get('help-toc');
    toc.scrollHeight = 1000;
    toc.clientHeight = 200;
    toc.getBoundingClientRect = () => ({ top: 0, bottom: 200 });
    f.links[0].getBoundingClientRect = () => ({ top: 20, bottom: 50 });
    f.links[2].getBoundingClientRect = () => ({ top: 280, bottom: 310 });
    f.initialize();
    f.flush();
    f.win.scrollY = 968;
    await f.events.dispatch('scroll');
    f.flush();
    assertChapter(f, 'modes');
    assert.equal(toc.scrollTop, 110);
    assert.equal(f.win.scrollY, 968, '目次の表示調整で本文位置を変えない');
});

test('通常スクリプト: DOMContentLoadedで起動し、スクロール後の現在位置を更新する', async t => {
    const f = setup(t);
    f.doc.readyState = 'loading';
    runInNewContext(helpScript, { document: f.doc, window: f.win });
    await f.dom.events.dispatch('DOMContentLoaded');
    f.flush();
    assertChapter(f, 'screen');
    f.win.scrollY = 968;
    await f.dom.events.dispatch('scroll', { target: f.doc.body });
    f.flush();
    assertChapter(f, 'modes');
});

test('目次: アンカー移動の端数座標で現在項目を前項目へ戻さない', async t => {
    const f = setup(t, { nested: true });
    f.initialize();
    f.flush();
    for (const [index, id] of ids.entries()) {
        f.win.location.hash = `#${id}`;
        f.win.scrollY = 200 + index * 400 - 32.75;
        await f.events.dispatch('hashchange');
        f.flush();
        assertChapter(f, id);
    }
    f.win.location.hash = '#link-route';
    f.win.scrollY = 1200 - 32.75;
    await f.events.dispatch('hashchange');
    f.flush();
    assertChapter(f, 'link-route');
    f.win.scrollY -= 1;
    await f.events.dispatch('scroll');
    f.flush();
    assertChapter(f, 'modes', '境界から離れた見出しを先取りしない');
});

test('目次: 現在章だけ小項目を展開し、小項目内移動では開いたままにする', async t => {
    const f = setup(t, { nested: true });
    const group = f.dom.get('toc-modes');
    const nextGroup = f.dom.get('toc-devices');
    const parent = f.links.find(link => link.getAttribute('href') === '#modes');
    f.initialize();
    f.flush();
    assert.equal(group.hidden, true);
    assert.equal(nextGroup.hidden, true);
    assert.equal(parent.getAttribute('aria-expanded'), 'false');
    f.win.scrollY = 968;
    await f.events.dispatch('scroll');
    f.flush();
    assert.equal(group.hidden, false);
    assert.equal(nextGroup.hidden, true);
    assert.equal(parent.getAttribute('aria-expanded'), 'true');
    assert.equal(parent.getAttribute('aria-controls'), group.id);
    f.win.scrollY = 1168;
    await f.events.dispatch('scroll');
    f.flush();
    assertChapter(f, 'link-route');
    assert.equal(group.hidden, false);
    f.win.scrollY = 1368;
    await f.events.dispatch('scroll');
    f.flush();
    assert.equal(group.hidden, true);
    assert.equal(nextGroup.hidden, false);
    assert.equal(parent.getAttribute('aria-expanded'), 'false');
});

test('タブ閉鎖: window.closeを呼び出し、閉じない環境では案内を表示する', async t => {
    const f = setup(t);
    let closed = false;
    f.win.close = () => { closed = true; };
    f.initialize();
    const btn = f.dom.get('help-tab-close');
    const notice = f.dom.get('help-tab-close-notice');
    assert.equal(notice.hidden, true);
    await btn.dispatch('click');
    assert.equal(closed, true);
    assert.equal(notice.hidden, false);
});

test('タブ閉鎖: native closeで例外が発生しても案内を表示する', async t => {
    const f = setup(t);
    f.win.close = () => { throw new Error('Scripts may not close windows that were not opened by script'); };
    f.initialize();
    const btn = f.dom.get('help-tab-close');
    const notice = f.dom.get('help-tab-close-notice');
    await btn.dispatch('click');
    assert.equal(notice.hidden, false);
});
