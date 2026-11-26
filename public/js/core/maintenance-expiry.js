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
    return calendarDate(year, month, 31);
}

function calendarDate(year, month, day) {
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return `${year}-${String(month).padStart(2, '0')}-${String(Math.min(day, lastDay)).padStart(2, '0')}`;
}

function expiryBoundaries(referenceDate) {
    const year = referenceDate.getFullYear();
    const month = referenceDate.getMonth() + 1;
    const day = referenceDate.getDate();
    return {
        today: calendarDate(year, month, day),
        inOneYear: calendarDate(year + 1, month, day),
        inTwoYears: calendarDate(year + 2, month, day)
    };
}

function classifyExpiryDate(expiry, { today, inOneYear, inTwoYears }) {
    if (expiry < today) return 'expired';
    if (expiry <= inOneYear) return 'within1Year';
    if (expiry <= inTwoYears) return 'within2Years';
    return 'beyond2Years';
}

/** ローカル日付で比較し、うるう日の暦年加算は対象月末へ丸める。 */
export function classifyMaintenanceExpiry(value, referenceDate = new Date()) {
    if (String(value ?? '').trim() === '') return 'unset';
    const expiry = getMaintenanceExpiryDate(value);
    return expiry ? classifyExpiryDate(expiry, expiryBoundaries(referenceDate)) : null;
}

function aggregateExpiryCounts(devices, boundaries, fiscalYears) {
    const counts = { expired: 0, within1Year: 0, within2Years: 0, beyond2Years: 0, unset: 0, invalid: 0 };
    for (const device of devices) {
        const value = String(device?.maintenance_expiry ?? '').trim();
        if (!value) {
            counts.unset++;
            continue;
        }
        const expiry = getMaintenanceExpiryDate(value);
        if (!expiry) {
            counts.invalid++;
            continue;
        }
        const category = classifyExpiryDate(expiry, boundaries);
        counts[category]++;
        if (category === 'expired') continue;
        const fiscalYear = fiscalYears.find(range => range.end === null || expiry <= range.end);
        if (fiscalYear) fiscalYear.count++;
    }
    return counts;
}

export function aggregateMaintenanceExpiry(devices, referenceDate = new Date(), fiscalYearStartMonth = 4) {
    const month = Number(fiscalYearStartMonth);
    const startMonth = Number.isInteger(month) && month >= 1 && month <= 12 ? month : 4;
    const currentYear = referenceDate.getFullYear() - (referenceDate.getMonth() + 1 < startMonth ? 1 : 0);
    const endMonth = startMonth === 1 ? 12 : startMonth - 1;
    const boundaries = expiryBoundaries(referenceDate);
    const fiscalYears = Array.from({ length: 5 }, (_, index) => {
        const year = currentYear + index;
        const fiscalStart = calendarDate(year, startMonth, 1);
        const end = calendarDate(year + (startMonth === 1 ? 0 : 1), endMonth, 31);
        const startLabel = fiscalStart.slice(0, 7).replace('-', '/');
        const endLabel = end.slice(0, 7).replace('-', '/');
        return {
            label: `${year}年度（${startLabel}〜${endLabel}）`,
            start: index === 0 ? boundaries.today : fiscalStart,
            end,
            count: 0
        };
    });
    const laterYear = currentYear + 5;
    fiscalYears.push({
        label: `${laterYear}年度以降`,
        start: calendarDate(laterYear, startMonth, 1),
        end: null,
        count: 0
    });
    return { ...aggregateExpiryCounts(devices, boundaries, fiscalYears), fiscalYears };
}
