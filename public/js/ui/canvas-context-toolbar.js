/**
 * キャンバス上部の共通ツールバー。操作内容と終了後の処理は各機能が持つ。
 */
let activeContext = null;
const initializedToolbars = new WeakSet();

export function initCanvasContextToolbar() {
    const toolbar = document.getElementById('canvas-context-toolbar');
    if (!toolbar || initializedToolbars.has(toolbar)) return;
    initializedToolbars.add(toolbar);

    // ボタンだけでなく、説明文や外枠の操作もキャンバスへ伝えない。
    // pointerupはdocument側の既存ドラッグ終了処理へ届ける。
    for (const type of ['click', 'dblclick', 'pointerdown', 'pointermove', 'contextmenu', 'wheel']) {
        toolbar.addEventListener(type, event => event.stopPropagation());
    }
}

export function showCanvasContextToolbar(id, onFinish) {
    const toolbar = document.getElementById('canvas-context-toolbar');
    const panel = toolbar && [...toolbar.querySelectorAll('[data-canvas-context]')]
        .find(element => element.dataset.canvasContext === id);
    if (!panel) throw new Error(`キャンバスツールバーのcontextが見つかりません: ${id}`);
    if (activeContext?.id === id) return;

    finishCanvasContextToolbar('replace');
    activeContext = { id, onFinish };
    for (const element of toolbar.querySelectorAll('[data-canvas-context]')) {
        element.hidden = element !== panel;
    }
    toolbar.dataset.activeContext = id;
    toolbar.setAttribute('aria-label', panel.getAttribute('aria-label'));
    toolbar.setAttribute('aria-hidden', 'false');
    toolbar.hidden = false;
    panel.querySelector('button:not(:disabled)')?.focus();
}

// 別contextの終了通知で、現在表示中のツールバーを閉じない。
export function hideCanvasContextToolbar(id) {
    if (activeContext?.id !== id) return;
    activeContext = null;
    const toolbar = document.getElementById('canvas-context-toolbar');
    if (!toolbar) return;
    toolbar.hidden = true;
    toolbar.setAttribute('aria-hidden', 'true');
    toolbar.removeAttribute('data-active-context');
    for (const panel of toolbar.querySelectorAll('[data-canvas-context]')) {
        panel.hidden = true;
    }
}

export function finishCanvasContextToolbar(reason = 'finish') {
    if (!activeContext) return false;
    const context = activeContext;
    // 終了callbackで各機能がhideを呼んでも、二重終了しない。
    hideCanvasContextToolbar(context.id);
    if (typeof context.onFinish === 'function') context.onFinish(reason);
    return true;
}

export function handleCanvasContextToolbarKeydown(event) {
    if (event.key !== 'Escape' || !activeContext) return false;
    const target = event.target;
    if (target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)) {
        return false;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    finishCanvasContextToolbar('escape');
    return true;
}
