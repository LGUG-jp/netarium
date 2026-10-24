import { isValidDateString } from './device-validation.js';

export const MAINTENANCE_EXPIRY_LABELS = Object.freeze({
    expired: '期限超過',
    within1Year: '残り1年以内',
    within2Years: '残り1〜2年',
    beyond2Years: '2年超',
    unset: '期限未登録'
});

/** 年月は月末を暫定期限とする。空欄・形式不正はnull。元の値は変更しない。 */
export function getMaintenanceExpiryDate(value) {
    const text = String(value ?? '').trim();
    if (!text || !isValidDateString(text)) return null;
    if (text.length === 10) return text;
    const [year, month] = text.split('-').map(Number);
    return `${text}-${new Date(year, month, 0).getDate()}`;
}

function calendarDate(year, month, day) {
    const lastDay = new Date(year, month + 1, 0).getDate();
    return `${year}-${String(month + 1).padStart(2, '0')}-${String(Math.min(day, lastDay)).padStart(2, '0')}`;
}

/** ローカル日付で比較し、うるう日の暦年加算は対象月末へ丸める。 */
export function classifyMaintenanceExpiry(value, referenceDate = new Date()) {
    if (String(value ?? '').trim() === '') return 'unset';
    const expiry = getMaintenanceExpiryDate(value);
    if (!expiry) return null;
    const year = referenceDate.getFullYear();
    const month = referenceDate.getMonth();
    const day = referenceDate.getDate();
    if (expiry < calendarDate(year, month, day)) return 'expired';
    if (expiry <= calendarDate(year + 1, month, day)) return 'within1Year';
    if (expiry <= calendarDate(year + 2, month, day)) return 'within2Years';
    return 'beyond2Years';
}

export function aggregateMaintenanceExpiry(devices, referenceDate = new Date()) {
    const counts = Object.fromEntries(Object.keys(MAINTENANCE_EXPIRY_LABELS).map(key => [key, 0]));
    for (const device of devices) {
        const category = classifyMaintenanceExpiry(device?.maintenance_expiry, referenceDate);
        if (category) counts[category]++;
    }
    return counts;
}
