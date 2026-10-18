/**
 * Netarium - APIクライアント (API Client)
 */

import { API_URL } from './constants.js';
import { appState } from './state.js';
import { eventBus } from './event-bus.js';

export function handleAuthExpired() {
    appState.authExpired = true;
    eventBus.emit('auth:expired');
    const banner = document.getElementById('status-auth-expired-banner');
    if (banner) {
        banner.hidden = false;
    }
    const saveBtn = document.getElementById('saveBtn');
    if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.title = '認証が失効しているため保存できません。別タブで再認証後に新画面へ再入力してください';
    }
}

if (typeof window !== 'undefined') {
    window.handleAuthExpired = handleAuthExpired;
}

// 保守拒否は元PHP入口の直接応答だけを信頼する。静的契約の直接GETは対象外。
function isMaintenanceRejection(res, data, url) {
    if (res.status !== 404 || res.redirected !== false ||
        !/^application\/json(?:\s*;|$)/i.test(res.headers.get('Content-Type') || '') ||
        !data || typeof data !== 'object' || Array.isArray(data)) return false;
    const keys = ['ok', 'error_code', 'contract_version', 'request_execution', 'operation_id'];
    if (Object.keys(data).length !== keys.length || !keys.every(key => Object.hasOwn(data, key)) ||
        data.ok !== false || data.error_code !== 'NETARIUM_MAINTENANCE_REJECTED' ||
        data.contract_version !== 1 || data.request_execution !== 'not_started' ||
        typeof data.operation_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(data.operation_id)) return false;
    try {
        const requested = new URL(url, window.location.href);
        return /\/(?:api|image_upload)\.php$/.test(requested.pathname) && res.url === requested.href;
    } catch (_) {
        return false;
    }
}

/**
 * API呼び出し共通処理
 */
export async function apiFetch(action, options = {}) {
    const isImageUpload = action === 'upload_floor_plan' || action === 'upload_device_image';
    const url = `${isImageUpload ? 'image_upload.php' : API_URL}?action=${encodeURIComponent(action)}`;
    const method = String(options.method || 'GET').toUpperCase();

    const headers = new Headers(options.headers || {});

    if (method !== 'GET' && method !== 'HEAD') {
        const csrfToken = window.APP_CONFIG?.csrfToken || '';

        if (!csrfToken) {
            const error = new Error('CSRFトークンを取得できません。画面を再読み込みしてください');
            error.requestNotSent = true;
            throw error;
        }

        headers.set('X-CSRF-Token', csrfToken);
    }

    const res = await fetch(url, {
        method,
        headers,
        body: options.body,
        credentials: 'same-origin'
    });

    let text;
    try {
        text = await res.text();
    } catch (error) {
        if (!res.ok) error.status = res.status;
        throw error;
    }

    const phpLimitExceeded = /POST Content-Length of \d+ bytes exceeds the limit|exceeds.*post_max_size/i.test(text);
    const iisLimitExceeded = res.status === 404
        && /404[.\s,-]*13|CONTENT_LENGTH_TOO_LARGE|request (?:content )?length|content length.*too large/i.test(text);
    if (isImageUpload && (phpLimitExceeded || iisLimitExceeded || (res.status === 413 && !text.trimStart().startsWith('{')))) {
        const maxBytes = Number(window.APP_CONFIG?.capacity?.imageUploadMaxRequestBytes) || 31 * 1024 * 1024;
        const error = new Error(phpLimitExceeded
            ? 'PHPのpost_max_sizeが画像の送信容量に不足しています。管理者にPHP設定の確認を依頼してください'
            : `${iisLimitExceeded ? 'IISで' : ''}画像の送信全体が上限を超えています。multipartを含め${maxBytes / (1024 * 1024)}MiB以下にしてください`);
        error.status = 413;
        throw error;
    }

    let data;

    try {
        data = text ? JSON.parse(text) : {};
    } catch (err) {
        const preview =
            text.length > 300
                ? text.slice(0, 300) + '...'
                : text;

        const error = new Error(`APIの応答がJSONではありません: ${preview}`);
        if (!res.ok) error.status = res.status;
        throw error;
    }

    if (isMaintenanceRejection(res, data, url)) {
        const error = new Error('保守作業中のため保存は受け付けられていません。入力を保持しています。保守終了後に「保存」を押して再開してください');
        error.status = res.status;
        error.maintenanceRejected = true;
        error.operationId = data.operation_id;
        throw error;
    }

    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('APIの応答形式が不正です。保存状態を確認してください');
    }

    if (res.status === 401 || data.login_required === true) {
        handleAuthExpired();
        const error = new Error('ログインの有効期限が切れました');
        error.status = 401;
        error.data = data;
        throw error;
    }

    if (!res.ok || data.ok === false) {
        const error = new Error(
            data.detail ||
            data.error ||
            `APIエラー: HTTP ${res.status}`
        );

        error.status = res.status;
        error.data = data;
        error.details = data.details || {};
        // 通常404・未知の契約は未実行の証明ではない。
        error.apiRejected = data.ok === false && res.status !== 404 && !res.redirected;

        throw error;
    }
    if (action === 'load' && data.canvas_notes === undefined) data.canvas_notes = [];


    return data;
}

/**
 * データ読み込み
 */

export function getDownloadFilename(
    contentDisposition,
    fallback
) {
    const header = String(
        contentDisposition || ''
    );

    const utf8Match = header.match(
        /filename\*=UTF-8''([^;]+)/i
    );

    if (utf8Match) {
        try {
            return decodeURIComponent(
                utf8Match[1]
            );
        } catch (err) {
            console.warn(
                'UTF-8ファイル名を解析できません',
                err
            );
        }
    }

    const quotedMatch = header.match(
        /filename="([^"]+)"/i
    );

    if (quotedMatch) {
        return quotedMatch[1];
    }

    const plainMatch = header.match(
        /filename=([^;]+)/i
    );

    if (plainMatch) {
        return plainMatch[1].trim();
    }

    return fallback;
}


/**
 * DB上の正式データをダウンロードする。
 *
 * apiFetch()はJSON専用なので使用しない。
 */
export function startAuthenticatedDownload(
    action
) {
    const url =
        `${API_URL}?action=` +
        encodeURIComponent(action);

    const link =
        document.createElement('a');

    link.href = url;
    link.hidden = true;

    document.body.appendChild(link);
    link.click();
    link.remove();
}

/**
 * CSV出力を開始できる状態か確認する。
 */

