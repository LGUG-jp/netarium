/**
 * Netarium - 一時通知 (Toast / Status Message)
 */

let toastMessage = '';
let statusMessage = '';

/**
 * 追加操作が不要な結果をステータスバー中央へ短時間表示する。
 */
export function showStatusMessage(message, type = 'info') {
    if (type !== 'info' && type !== 'success') {
        throw new TypeError('ステータスメッセージはinfoまたはsuccessを指定してください');
    }
    const status = document.getElementById('status-toast-message');
    if (!status) return;

    const text = String(message ?? '').trim();
    if (text && text === toastMessage) showToast('');
    window.clearTimeout(showStatusMessage._timer);
    statusMessage = text;
    if (status.textContent !== text) status.textContent = text;
    status.title = text;
    if (!text) return;

    showStatusMessage._timer = window.setTimeout(() => {
        status.textContent = '';
        status.title = '';
        statusMessage = '';
    }, 3000);
}

/**
 * 操作不能・注意はwarning、横断的な処理失敗はerrorで表示する。
 */
export function showToast(message, type = 'warning') {
    if (type !== 'warning' && type !== 'error') {
        throw new TypeError('トーストはwarningまたはerrorを指定してください');
    }
    let toast = document.getElementById('toast');
    const text = String(message ?? '').trim();
    window.clearTimeout(showToast._timer);
    toastMessage = text;
    if (!text) {
        if (toast) {
            toast.hidden = true;
            toast.textContent = '';
        }
        return;
    }
    if (text === statusMessage) showStatusMessage('');

    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'toast';
        toast.hidden = true;
        toast.setAttribute('aria-atomic', 'true');
        document.body.appendChild(toast);
    }

    toast.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');
    toast.className = `toast toast-${type}`;
    const fullMessage = text.startsWith('!') ? text : `! ${text}`;
    if (toast.textContent !== fullMessage) toast.textContent = fullMessage;
    toast.hidden = false;

    showToast._timer = window.setTimeout(() => {
        toast.hidden = true;
        toast.textContent = '';
        toastMessage = '';
    }, type === 'error' ? 6000 : 5000);
}
