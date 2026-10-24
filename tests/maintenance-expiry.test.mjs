import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    classifyMaintenanceExpiry, getMaintenanceExpiryDate, aggregateMaintenanceExpiry
} from '../public/js/core/maintenance-expiry.js';

test('期限5区分は今日・暦年境界を含め相互排他的、不正値は未登録と区別する', () => {
    const today = new Date(2026, 9, 23, 23, 59);
    const cases = [
        ['2026-10-22', 'expired'], ['2026-10-23', 'within1Year'],
        ['2027-10-23', 'within1Year'], ['2027-10-24', 'within2Years'],
        ['2028-10-23', 'within2Years'], ['2028-10-24', 'beyond2Years'],
        ['', 'unset'], [null, 'unset'], [undefined, 'unset'], ['  ', 'unset'],
        ['2026-02-30', null], ['2026-13', null], ['not-a-date', null]
    ];
    for (const [value, expected] of cases) assert.equal(classifyMaintenanceExpiry(value, today), expected, String(value));
    const devices = cases.map(([maintenance_expiry]) => ({ maintenance_expiry }));
    const before = structuredClone(devices);
    assert.deepEqual(aggregateMaintenanceExpiry(devices, today), {
        expired: 1, within1Year: 2, within2Years: 2, beyond2Years: 1, unset: 4
    });
    assert.deepEqual(devices, before);
    assert.deepEqual(aggregateMaintenanceExpiry([], today), {
        expired: 0, within1Year: 0, within2Years: 0, beyond2Years: 0, unset: 0
    });
});

test('年月のみは月末期限、うるう日基準の暦年加算は対象年の2月末へ丸める', () => {
    assert.equal(getMaintenanceExpiryDate('2024-02'), '2024-02-29');
    assert.equal(getMaintenanceExpiryDate('2025-02'), '2025-02-28');
    assert.equal(getMaintenanceExpiryDate('2026-04'), '2026-04-30');
    assert.equal(getMaintenanceExpiryDate('2026-12'), '2026-12-31');
    assert.equal(getMaintenanceExpiryDate('2025-02-29'), null);
    const leapDay = new Date(2024, 1, 29, 12);
    for (const [value, category] of [
        ['2024-02', 'within1Year'], ['2025-02', 'within1Year'],
        ['2025-03-01', 'within2Years'], ['2026-02', 'within2Years'],
        ['2026-03-01', 'beyond2Years']
    ]) assert.equal(classifyMaintenanceExpiry(value, leapDay), category, value);
    assert.equal(classifyMaintenanceExpiry('2024-02', new Date(2024, 2, 1)), 'expired');
    assert.equal(classifyMaintenanceExpiry('2025-02', new Date(2024, 1, 28)), 'within1Year');
    assert.equal(classifyMaintenanceExpiry('2028-02-29', new Date(2027, 1, 28)), 'within2Years');
});

test('UTC日付ではなくブラウザ相当のローカル年月日を基準にする', () => {
    const localMidnight = new Date(2026, 9, 23, 0, 1);
    const localNight = new Date(2026, 9, 23, 23, 59);
    for (const reference of [localMidnight, localNight]) {
        assert.equal(classifyMaintenanceExpiry('2026-10-23', reference), 'within1Year');
        assert.equal(classifyMaintenanceExpiry('2026-10-22', reference), 'expired');
    }
});
