import { apiFetch } from './api-client.js';
import { appState, getDeviceById } from './state.js';
import { eventBus } from './event-bus.js';
import { syncResourceRevision } from './resource-save.js';
import { hasResourceConflict, runResourceMutation } from './save-queue.js';

export function getDeviceImageBlockReason(deviceId) {
    if (appState.authExpired) return '認証の有効期限が切れています。再認証して新しい画面を開いてください';
    const device = getDeviceById(deviceId);
    if (!device) return '対象機器が見つかりません';
    if (hasResourceConflict('devices', deviceId)) return 'この機器は保存競合しています。対象機器を再読込した後に画像を操作してください';
    if (!(Number(device.resource_revision) > 0)) return '新規機器の登録がまだ完了していません。機器の保存完了後に画像を登録してください';
    return '';
}

function replaceDeviceImagesInState(deviceId, newDeviceImages) {
    if (!Array.isArray(appState.deviceImages)) {
        appState.deviceImages = [];
    }
    const otherImages = appState.deviceImages.filter(img => Number(img.device_id) !== Number(deviceId));
    appState.deviceImages = [...otherImages, ...(newDeviceImages || [])];
}

function applyDeviceImageResult(deviceId, data, expectedDeviceRevision, beforeEmit) {
    const nextRevision = Number(data?.revision);
    if (Number.isInteger(nextRevision) && nextRevision > 0) {
        appState.dataRevision = Math.max(Number(appState.dataRevision) || 0, nextRevision);
    }
    if (Number.isInteger(expectedDeviceRevision) && expectedDeviceRevision > 0 &&
        Number(data?.previous_device_revision) === expectedDeviceRevision) {
        syncResourceRevision('devices', deviceId, data?.device_revision);
    }
    replaceDeviceImagesInState(deviceId, data?.images);
    if (typeof beforeEmit === 'function') {
        beforeEmit(data);
    }
    eventBus.emit('device-images:changed', deviceId);
}

async function runDeviceImageMutation(deviceId, requestFn, { beforeEmit } = {}) {
    return runResourceMutation(async () => {
        const reason = getDeviceImageBlockReason(deviceId);
        if (reason) throw new Error(reason);
        const expectedDeviceRevision = Number(getDeviceById(deviceId)?.resource_revision);
        const data = await requestFn(expectedDeviceRevision);
        applyDeviceImageResult(deviceId, data, expectedDeviceRevision, beforeEmit);
        return data;
    });
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
    return runDeviceImageMutation(deviceId, expectedDeviceRevision => {
        const body = new FormData();
        body.append('image', file);
        body.append('device_id', String(deviceId));
        body.append('revision', String(appState.dataRevision));
        body.append('expected_device_revision', String(expectedDeviceRevision));
        body.append('caption', '');
        if (replaceImageId !== null && replaceImageId > 0) body.append('replace_image_id', String(replaceImageId));
        return apiFetch('upload_device_image', { method: 'POST', body });
    });
}

export async function deleteDeviceImageRequest(deviceId, imageId) {
    return runDeviceImageMutation(deviceId, expectedDeviceRevision => apiFetch('delete_device_image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            device_id: deviceId,
            image_id: imageId,
            revision: appState.dataRevision,
            expected_device_revision: expectedDeviceRevision
        })
    }));
}

export async function updateDeviceImagesRequest(deviceId, buildImages, { beforeEmit } = {}) {
    return runDeviceImageMutation(deviceId, expectedDeviceRevision => {
        const images = typeof buildImages === 'function' ? buildImages() : buildImages;
        return apiFetch('update_device_images', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                device_id: deviceId,
                revision: appState.dataRevision,
                expected_device_revision: expectedDeviceRevision,
                images
            })
        });
    }, { beforeEmit });
}
