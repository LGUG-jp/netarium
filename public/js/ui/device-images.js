/**
 * Netarium - ui/device-images.js
 */

import { appState } from '../core/state.js';
import { isCurrentUserAdmin } from './access-control.js';
import { showToast, showStatusMessage } from './toast.js';
import { getDeviceImageBlockReason, uploadDeviceImage } from '../core/device-image-api.js';
import { eventBus } from '../core/event-bus.js';
import { setInputError } from './field-errors.js';

const captionDrafts = new Map();
const captionKey = (deviceId, imageId) => `${deviceId}:${imageId}`;
const captionError = value => [...String(value).trim()].length > 100 ? '画像説明は100文字以内で入力してください' : '';

export function bindDeviceImageCaptionInput(input, { deviceId, imageId, errorId, onSave }) {
    const key = captionKey(deviceId, imageId);
    const original = input.value;
    if (captionDrafts.has(key)) input.value = captionDrafts.get(key);
    const error = document.createElement('div');
    error.id = errorId;
    error.className = 'form-error';
    error.hidden = true;
    const validate = () => {
        const message = captionError(input.value);
        setInputError(input, error, message);
        return !message;
    };
    input.addEventListener('input', () => {
        captionDrafts.set(key, input.value);
        validate();
    });
    input.addEventListener('change', () => {
        if (input.disabled || !isCurrentUserAdmin() || appState.authExpired || appState.isPinging || !validate()) return;
        const value = input.value.trim();
        if (value !== original) onSave(value);
        else captionDrafts.delete(key);
    });
    validate();
    return error;
}
import { handleAuthExpired } from '../core/api-client.js';
function getCsrfToken() {
    return window.APP_CONFIG?.csrfToken || '';
}
import { registerModalClose, registerModalOpen } from '../core/modal-focus.js';

let pendingReplaceImageId = null;
let zoomImages = [];
let zoomImageIndex = 0;
eventBus.on('resources:saved', () => renderDeviceImages(appState.editingDeviceId));
eventBus.on('device-images:changed', deviceId => {
    if (Number(deviceId) === Number(appState.editingDeviceId)) renderDeviceImages(deviceId);
});

/**
 * 機器画像一覧の描画
 */
export function renderDeviceImages(deviceId) {
    if (typeof document === 'undefined') return;

    const listContainer = document.getElementById('p-device-images-list');
    const countBadge = document.getElementById('p-device-images-count');
    const dirtyWarning = document.getElementById('p-device-images-dirty-warning');
    const addBtn = document.getElementById('p-device-image-add-btn');

    if (!listContainer || deviceId == null) return;

    const images = (appState.deviceImages || [])
        .filter(img => Number(img.device_id) === Number(deviceId))
        .sort((a, b) => Number(a.sort_order) - Number(b.sort_order));

    if (countBadge) {
        countBadge.textContent = `${images.length}/3枚`;
    }

    // サーバーに存在する機器は、属性下書きや別resourceの保存待ちと独立して画像を操作できる。
    const blockReason = getDeviceImageBlockReason(deviceId);
    const hasDirty = Boolean(blockReason);
    const isAdmin = isCurrentUserAdmin();

    if (dirtyWarning) {
        dirtyWarning.hidden = !hasDirty;
        dirtyWarning.textContent = blockReason;
    }

    if (addBtn) {
        addBtn.disabled = !isAdmin || hasDirty || images.length >= 3;
        if (images.length >= 3) {
            addBtn.title = '画像は最大3枚までです（満杯時は差替えを行ってください）';
        } else if (hasDirty) {
            addBtn.title = blockReason;
        } else {
            addBtn.removeAttribute('title');
        }
    }

    listContainer.replaceChildren();

    if (images.length === 0) {
        const emptyMsg = document.createElement('div');
        emptyMsg.className = 'device-images-empty form-support';
        emptyMsg.textContent = '登録されている画像はありません。';
        listContainer.appendChild(emptyMsg);
        return;
    }

    images.forEach((img, index) => {
        const item = document.createElement('div');
        item.className = 'device-image-item';
        item.dataset.imageId = String(img.id);

        // サムネイル表示
        const thumbWrap = document.createElement('div');
        thumbWrap.className = 'device-image-thumb-wrap';

        const thumbImg = document.createElement('img');
        thumbImg.src = `${img.image_url}&size=thumb`;
        thumbImg.alt = img.caption || `機器画像 ${index + 1}`;
        thumbImg.className = 'device-image-thumb';
        thumbImg.loading = 'lazy';
        thumbImg.addEventListener('click', () => {
            openDeviceImageZoom(img);
        });

        const zoomBtn = document.createElement('button');
        zoomBtn.type = 'button';
        zoomBtn.className = 'device-image-zoom-trigger';
        zoomBtn.setAttribute('aria-label', `${img.caption || `画像${index + 1}`}を拡大表示`);
        zoomBtn.textContent = '🔍';
        zoomBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openDeviceImageZoom(img);
        });

        thumbWrap.appendChild(thumbImg);
        thumbWrap.appendChild(zoomBtn);
        item.appendChild(thumbWrap);

        // メタ情報と操作エリア
        const metaArea = document.createElement('div');
        metaArea.className = 'device-image-meta';

        // 説明入力欄
        const captionInput = document.createElement('input');
        captionInput.type = 'text';
        captionInput.className = 'device-image-caption-input';
        captionInput.value = img.caption || '';
        captionInput.dataset.maxLength = '100';
        captionInput.placeholder = '説明（100文字以内）';
        captionInput.disabled = !isAdmin || hasDirty;
        captionInput.setAttribute('aria-label', `画像${index + 1}の説明`);

        const captionErrorEl = bindDeviceImageCaptionInput(captionInput, {
            deviceId, imageId: img.id, errorId: `p-image-${img.id}-caption-error`,
            onSave: value => updateImageCaption(Number(deviceId), Number(img.id), value)
        });

        metaArea.appendChild(captionInput);
        metaArea.appendChild(captionErrorEl);

        // 操作ボタン群（管理者かつ未保存変更なし）
        if (isAdmin) {
            const actionsWrap = document.createElement('div');
            actionsWrap.className = 'device-image-actions';

            // 上へ移動ボタン
            if (index > 0) {
                const upBtn = document.createElement('button');
                upBtn.type = 'button';
                upBtn.className = 'btn btn-secondary btn-sm';
                upBtn.textContent = '↑';
                upBtn.title = '前へ移動';
                upBtn.disabled = hasDirty;
                upBtn.setAttribute('aria-label', `画像${index + 1}を前へ移動`);
                upBtn.addEventListener('click', () => {
                    const newImages = [...images];
                    const temp = newImages[index - 1];
                    newImages[index - 1] = newImages[index];
                    newImages[index] = temp;
                    reorderDeviceImages(Number(deviceId), newImages);
                });
                actionsWrap.appendChild(upBtn);
            }

            // 下へ移動ボタン
            if (index < images.length - 1) {
                const downBtn = document.createElement('button');
                downBtn.type = 'button';
                downBtn.className = 'btn btn-secondary btn-sm';
                downBtn.textContent = '↓';
                downBtn.title = '次へ移動';
                downBtn.disabled = hasDirty;
                downBtn.setAttribute('aria-label', `画像${index + 1}を次へ移動`);
                downBtn.addEventListener('click', () => {
                    const newImages = [...images];
                    const temp = newImages[index + 1];
                    newImages[index + 1] = newImages[index];
                    newImages[index] = temp;
                    reorderDeviceImages(Number(deviceId), newImages);
                });
                actionsWrap.appendChild(downBtn);
            }

            // 差替えボタン
            const replaceBtn = document.createElement('button');
            replaceBtn.type = 'button';
            replaceBtn.className = 'btn btn-secondary btn-sm';
            replaceBtn.textContent = '差替え';
            replaceBtn.disabled = hasDirty;
            replaceBtn.setAttribute('aria-label', `画像${index + 1}を別の画像へ差替え`);
            replaceBtn.addEventListener('click', () => {
                triggerDeviceImageUpload(Number(img.id));
            });
            actionsWrap.appendChild(replaceBtn);

            // 削除ボタン
            const deleteBtn = document.createElement('button');
            deleteBtn.type = 'button';
            deleteBtn.className = 'btn btn-secondary btn-sm btn-danger';
            deleteBtn.textContent = '削除';
            deleteBtn.disabled = hasDirty;
            deleteBtn.setAttribute('aria-label', `画像${index + 1}を削除`);
            deleteBtn.addEventListener('click', () => {
                deleteDeviceImage(Number(deviceId), Number(img.id));
            });
            actionsWrap.appendChild(deleteBtn);

            metaArea.appendChild(actionsWrap);
        }

        item.appendChild(metaArea);
        listContainer.appendChild(item);
    });
}

/**
 * ファイル選択ダイアログの起動
 */
export function triggerDeviceImageUpload(replaceImageId = null) {
    if (!isCurrentUserAdmin()) return;
    if (appState.authExpired) return;

    const reason = getDeviceImageBlockReason(appState.editingDeviceId);
    if (reason) {
        showToast(reason, 'warning');
        return;
    }

    pendingReplaceImageId = replaceImageId;
    const fileInput = document.getElementById('p-device-image-file-input');
    if (!fileInput) return;

    fileInput.value = '';
    fileInput.click();
}

/**
 * 画像アップロードAPI呼び出し
 */
export async function uploadDeviceImageFile(file, replaceImageId = null) {
    if (!file || appState.editingDeviceId === null) return;
    if (appState.authExpired) return;

    const deviceId = Number(appState.editingDeviceId);
    try {
        await uploadDeviceImage(deviceId, file, replaceImageId);
        renderDeviceImages(deviceId);
        showStatusMessage(replaceImageId ? '画像を差替えました' : '画像を登録しました', 'success');

    } catch (err) {
        if (err.status !== 401 && !appState.authExpired) showToast(err.message, 'error');
        // 409や不整合の疑いがある場合は画面状態の照合を推奨
    }
}

/**
 * 画像削除API呼び出し
 */
export async function deleteDeviceImage(deviceId, imageId) {
    if (!window.confirm('この画像を削除しますか？（この操作は即時確定されます）')) {
        return;
    }

    try {
        const csrfToken = getCsrfToken();
        const response = await fetch('api.php?action=delete_device_image', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Requested-With': 'XMLHttpRequest',
                ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {})
            },
            body: JSON.stringify({
                device_id: deviceId,
                image_id: imageId,
                revision: appState.dataRevision,
                csrf_token: csrfToken
            }),
        });

        if (response.status === 401) { handleAuthExpired(); return; }
        const data = await response.json();
        if (!response.ok || !data.ok) {
            throw new Error(data.error || '画像の削除に失敗しました');
        }

        appState.dataRevision = Number(data.revision);
        replaceDeviceImagesInState(deviceId, data.images);
        renderDeviceImages(deviceId);
        showStatusMessage('画像を削除しました', 'success');

    } catch (err) {
        showToast(err.message, 'error');
    }
}

/**
 * 順序入替API呼び出し
 */
export async function reorderDeviceImages(deviceId, newImages) {
    try {
        const csrfToken = getCsrfToken();
        const response = await fetch('api.php?action=update_device_images', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Requested-With': 'XMLHttpRequest',
                ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {})
            },
            body: JSON.stringify({
                device_id: deviceId,
                revision: appState.dataRevision,
                images: newImages.map(img => ({ id: Number(img.id), caption: img.caption || '' })),
                csrf_token: csrfToken
            }),
        });

        if (response.status === 401) { handleAuthExpired(); return; }
        const data = await response.json();
        if (!response.ok || !data.ok) {
            throw new Error(data.error || '画像順序の更新に失敗しました');
        }

        appState.dataRevision = Number(data.revision);
        replaceDeviceImagesInState(deviceId, data.images);
        renderDeviceImages(deviceId);

    } catch (err) {
        showToast(err.message, 'error');
    }
}

/**
 * 説明文更新API呼び出し
 */
export async function updateImageCaption(deviceId, imageId, newCaption) {
    if (captionError(newCaption)) return false;
    const images = (appState.deviceImages || [])
        .filter(img => Number(img.device_id) === Number(deviceId))
        .sort((a, b) => Number(a.sort_order) - Number(b.sort_order));

    const updated = images.map(img => ({
        id: Number(img.id),
        caption: Number(img.id) === imageId ? newCaption : (img.caption || '')
    }));

    try {
        const csrfToken = getCsrfToken();
        const response = await fetch('api.php?action=update_device_images', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Requested-With': 'XMLHttpRequest',
                ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {})
            },
            body: JSON.stringify({
                device_id: deviceId,
                revision: appState.dataRevision,
                images: updated,
                csrf_token: csrfToken
            }),
        });

        if (response.status === 401) { handleAuthExpired(); return; }
        const data = await response.json();
        if (!response.ok || !data.ok) {
            throw new Error(data.error || '画像説明の更新に失敗しました');
        }

        appState.dataRevision = Number(data.revision);
        const key = captionKey(deviceId, imageId);
        if (captionDrafts.get(key)?.trim() === newCaption) captionDrafts.delete(key);
        replaceDeviceImagesInState(deviceId, data.images);
        eventBus.emit('device-images:changed', deviceId);

    } catch (err) {
        showToast(err.message, 'error');
    }
}

/**
 * 拡大表示ダイアログを開く
 */
export function openDeviceImageZoom(image) {
    const overlay = document.getElementById('device-image-zoom-overlay');
    const imgEl = document.getElementById('device-image-zoom-img');
    const closeBtn = overlay?.querySelector('button');

    if (!overlay || !imgEl || !image) return;

    zoomImages = (appState.deviceImages || [])
        .filter(item => Number(item.device_id) === Number(image.device_id))
        .sort((a, b) => Number(a.sort_order) - Number(b.sort_order));
    zoomImageIndex = zoomImages.findIndex(item => Number(item.id) === Number(image.id));
    if (zoomImageIndex < 0) {
        zoomImages = [image];
        zoomImageIndex = 0;
    }
    renderDeviceImageZoom();

    overlay.hidden = false;
    registerModalOpen('device-image-zoom', overlay, closeBtn, { onClose: closeDeviceImageZoom });
}

function renderDeviceImageZoom() {
    const image = zoomImages[zoomImageIndex];
    if (!image) return;
    const imgEl = document.getElementById('device-image-zoom-img');
    const captionEl = document.getElementById('device-image-zoom-caption');
    imgEl.src = image.image_url;
    imgEl.alt = image.caption || '機器画像';
    if (captionEl) captionEl.textContent = image.caption ? `機器画像: ${image.caption}` : '機器画像';
    const position = document.getElementById('device-image-zoom-position');
    if (position) position.textContent = `${zoomImageIndex + 1}/${zoomImages.length}枚`;
    const previous = document.getElementById('device-image-zoom-previous');
    const next = document.getElementById('device-image-zoom-next');
    if (previous) previous.disabled = zoomImageIndex === 0;
    if (next) next.disabled = zoomImageIndex === zoomImages.length - 1;
}

export function changeDeviceImageZoom(direction) {
    const nextIndex = zoomImageIndex + direction;
    if (nextIndex < 0 || nextIndex >= zoomImages.length) return;
    zoomImageIndex = nextIndex;
    renderDeviceImageZoom();
}

/**
 * 拡大表示ダイアログを閉じる
 */
export function closeDeviceImageZoom() {
    const overlay = document.getElementById('device-image-zoom-overlay');
    if (!overlay) return;

    const imgEl = document.getElementById('device-image-zoom-img');
    if (imgEl) {
        imgEl.src = '';
    }

    overlay.hidden = true;
    zoomImages = [];
    zoomImageIndex = 0;
    registerModalClose('device-image-zoom');
}

/**
 * state内の対象機器画像を置換
 */
function replaceDeviceImagesInState(deviceId, newDeviceImages) {
    if (!Array.isArray(appState.deviceImages)) {
        appState.deviceImages = [];
    }
    const otherImages = appState.deviceImages.filter(img => Number(img.device_id) !== Number(deviceId));
    appState.deviceImages = [...otherImages, ...(newDeviceImages || [])];
}

// ファイル選択入力のイベント初期化
if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => {
        const fileInput = document.getElementById('p-device-image-file-input');
        if (fileInput) {
            fileInput.addEventListener('change', () => {
                const file = fileInput.files?.[0];
                if (file) {
                    uploadDeviceImageFile(file, pendingReplaceImageId);
                }
                pendingReplaceImageId = null;
            });
        }

    });
}
