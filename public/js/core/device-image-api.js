import { apiFetch } from './api-client.js';
import { appState, getDeviceById } from './state.js';
import { eventBus } from './event-bus.js';
import { waitForActiveResourceSave } from './save-queue.js';

export function getDeviceImageBlockReason(deviceId) {
    if (appState.authExpired) return '認証の有効期限が切れています。再認証して新しい画面を開いてください';
    const device = getDeviceById(deviceId);
    if (!device) return '対象機器が見つかりません';
    if (!(Number(device.resource_revision) > 0)) return '新規機器の登録がまだ完了していません。機器の保存完了後に画像を登録してください';
    return '';
}
export async function uploadDeviceImage(deviceId, file, replaceImageId = null) {
    if (!file) throw new Error('アップロードする画像を選択してください');
    if (file.type && !['image/png', 'image/jpeg'].includes(file.type)) {
        throw new Error('PNGまたはJPEG画像を選択してください');
    }
    const maxBytes = Number(window.APP_CONFIG?.capacity?.deviceImageMaxBytes) || 10 * 1024 * 1024;
    if (file.size <= 0 || file.size > maxBytes) {
        throw new Error(`画像ファイルは${Math.floor(maxBytes / (1024 * 1024))}MiB以下にしてください`);
    }
    await waitForActiveResourceSave();
    const reason = getDeviceImageBlockReason(deviceId);
    if (reason) throw new Error(reason);
    const body = new FormData();
    body.append('image', file);
    body.append('device_id', String(deviceId));
    body.append('revision', String(appState.dataRevision));
    body.append('caption', '');
    if (replaceImageId !== null && replaceImageId > 0) body.append('replace_image_id', String(replaceImageId));
    const data = await apiFetch('upload_device_image', { method: 'POST', body });
    appState.dataRevision = Math.max(Number(appState.dataRevision), Number(data.revision));
    appState.deviceImages = [
        ...(appState.deviceImages || []).filter(image => Number(image.device_id) !== Number(deviceId)),
        ...(data.images || [])
    ];
    eventBus.emit('device-images:changed', deviceId);
    return data;
}
