import { appState } from '../core/state.js';
import { showToast, showStatusMessage } from './toast.js';

function validId(value) {
    return (typeof value === 'number' || (typeof value === 'string' && /^[0-9]+$/.test(value))) &&
        Number.isSafeInteger(Number(value)) && Number(value) > 0;
}

function savedResource(kind, id) {
    return validId(id) && appState[kind].some(row => Number(row.id) === Number(id) &&
        Number.isSafeInteger(Number(row.resource_revision)) && Number(row.resource_revision) > 0);
}

/** ローカルの正数仮IDも、保存応答のrevisionが付くまで共有しない。 */
export function buildShareLink({ viewId, deviceId }, href = window.location.href) {
    if (viewId === undefined && deviceId === undefined) return null;
    if (viewId !== undefined && !savedResource('views', viewId)) return null;
    if (deviceId !== undefined && !savedResource('devices', deviceId)) return null;
    const url = new URL('index.php', href);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    if (viewId !== undefined) url.searchParams.set('view', String(Number(viewId)));
    if (deviceId !== undefined) url.searchParams.set('device', String(Number(deviceId)));
    return url.href;
}

function removeFallback(button) {
    button.parentNode?.querySelector?.('[data-share-link-fallback]')?.remove();
}

export function clearShareLinkFallback(buttonId) {
    const button = document.getElementById(buttonId);
    if (button) removeFallback(button);
}

function showManualCopy(url, button) {
    removeFallback(button);
    const container = document.createElement('div');
    container.dataset.shareLinkFallback = '';
    container.className = 'share-link-fallback';
    if (button.id === 'view-copy-link-btn') {
        container.style.setProperty('--share-link-left', `${button.getBoundingClientRect().left}px`);
    }
    const label = document.createElement('label');
    label.textContent = 'リンクを選択して手動でコピーしてください';
    const input = document.createElement('input');
    input.type = 'text';
    input.readOnly = true;
    input.value = url;
    input.setAttribute('aria-label', 'コピーするリンク');
    label.appendChild(input);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'btn btn-secondary btn-sm';
    close.textContent = '閉じる';
    close.addEventListener('click', () => {
        container.remove();
        button.focus();
    });
    container.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        close.click();
    });
    container.appendChild(label);
    container.appendChild(close);
    button.insertAdjacentElement('afterend', container);
    input.focus();
    input.select();
    showToast('自動コピーを利用できません。表示されたリンクを手動でコピーしてください');
}

export async function copyShareLink(target, button) {
    removeFallback(button);
    const url = buildShareLink(target);
    if (!url) {
        showToast('リンクは保存後に利用できます。対象のビュー・機器を保存してからお試しください');
        return false;
    }
    try {
        if (!globalThis.navigator?.clipboard?.writeText) throw new Error('Clipboard unavailable');
        await navigator.clipboard.writeText(url);
        showStatusMessage('リンクをコピーしました', 'success');
        return true;
    } catch {
        showManualCopy(url, button);
        return false;
    }
}

// property-panelから読み込まれるため、main/toolbarへの追加初期化は不要。
if (typeof document !== 'undefined') {
    document.addEventListener('click', event => {
        const button = event.target?.closest?.('#view-copy-link-btn');
        if (button) void copyShareLink({ viewId: appState.currentViewId }, button);
    });
}
