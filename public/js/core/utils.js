/**
 * Netarium - 共通ユーティリティ (Utils)
 */

import {
    DEVICE_TYPES
} from './constants.js';

/**
 * ズーム・パン用関数
 */

export function clampNumber(value, min, max) {
    return Math.max(min, Math.min(value, max))
}


export function normalizeText(value) {
    return value == null ? '' : String(value);
}




export function setInputValue(id, value) {
    const element = document.getElementById(id);

    if (element) {
        element.value = normalizeText(value);
    }
}


export function setTextContent(id, value) {
    const element = document.getElementById(id);

    if (element) {
        element.textContent = normalizeText(value);
    }
}




/**
 * 編集パネルの内容反映
 */

export function normalizeMacAddress(value) {
    const text = String(value || '').trim().toUpperCase();

    const compact = text.replace(/[^0-9A-F]/g, '');

    if (compact.length !== 12) {
        return text;
    }

    return compact
        .match(/.{2}/g)
        .join(':');
}


/**
 * パネルを閉じる
 */

export function formatStatusTime(value) {
    const date =
        value instanceof Date
            ? value
            : new Date(value);

    if (
        Number.isNaN(
            date.getTime()
        )
    ) {
        return '-';
    }

    return new Intl.DateTimeFormat(
        'ja-JP',
        {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        }
    ).format(date);
}




/**
 * デバッグ用: 現在データを取得
 */

export function uniqueSortedValues(items, key) {
    return Array.from(
        new Set(
            items
                .map(item => String(item[key] || '').trim())
                .filter(Boolean)
        )
    ).sort((a, b) => a.localeCompare(b, 'ja'));
}


export function isValidIpv4(value) {
    const parts = String(value).split('.');

    if (parts.length !== 4) {
        return false;
    }

    return parts.every(part => {
        if (!/^\d{1,3}$/.test(part)) {
            return false;
        }

        const number = Number(part);

        return (
            number >= 0 &&
            number <= 255 &&
            String(number) === part
        );
    });
}


export function formatFileSize(bytes) {
    const size =
        Math.max(
            0,
            Number(bytes) || 0
        );

    if (size < 1024) {
        return `${size} B`;
    }

    if (size < 1024 * 1024) {
        return `${
            (
                size / 1024
            ).toFixed(1)
        } KB`;
    }

    return `${
        (
            size /
            (1024 * 1024)
        ).toFixed(1)
    } MB`;
}


export function normalizeMatchText(value) {
    return normalizeText(value)
        .normalize('NFKC')
        .trim()
        .replace(/\s+/g, ' ')
        .toLocaleLowerCase('ja');
}


export function normalizeFloorForMatch(value) {
    return normalizeMatchText(value)
        .replace(/階$/, 'f');
}


export function getDeviceTypeSearchText(device) {
    const definition =
        DEVICE_TYPES[device.type] ||
        DEVICE_TYPES.other;

    return [
        device.type,
        definition.label
    ].join(' ');
}


