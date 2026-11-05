import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateDeviceValues } from '../public/js/core/device-validation.js';

test('複数エラーを全フィールドで返し、修正した項目だけ解除する', () => {
    const input = { id: 1, name: '架空機器', ip: '192.0.2.999', management_scheme: 'https', management_port: '65536', maintenance_expiry: '2026-02-30' };
    const first = validateDeviceValues(input);
    assert.deepEqual(Object.keys(first.errors).sort(), ['ip', 'maintenance_expiry', 'management_port']);
    input.ip = '192.0.2.1';
    assert.deepEqual(Object.keys(validateDeviceValues(input).errors).sort(), ['maintenance_expiry', 'management_port']);
});

test('日付の実在性、前後関係、ポートの境界を検証する', () => {
    const input = { id: 1, name: '架空機器', ip: '192.0.2.1', management_scheme: 'ssh', management_port: '1', install_date: '2024-02-29', maintenance_expiry: '2024-02-29' };
    assert.deepEqual(validateDeviceValues(input).errors, {});
    assert.equal(validateDeviceValues({ ...input, management_port: '65535' }).values.management_port, 65535);
    for (const port of ['0', '65536', '1.5', '1e2']) assert.ok(validateDeviceValues({ ...input, management_port: port }).errors.management_port);
    assert.ok(validateDeviceValues({ ...input, maintenance_expiry: '2024-02-28' }).errors.maintenance_expiry);
});

test('機器文字数の境界はUTF-16単位ではなくUnicodeコードポイントで検証する', () => {
    const input = { name: '😀'.repeat(100), floor: '𠮷'.repeat(50), memo: '😀'.repeat(1000) };
    assert.deepEqual(validateDeviceValues(input).errors, {});
    const errors = validateDeviceValues({ ...input, name: input.name + 'a', floor: input.floor + '階', memo: input.memo + '。' }).errors;
    assert.deepEqual(Object.keys(errors).sort(), ['floor', 'memo', 'name']);
});

test('追加IPは管理IP空欄を許可し、IPv4・機器内重複・用途100文字を検証する', () => {
    const input = { id: 1, name: '機器', ip: '', additional_ips: [{ id: 7, ip: '192.0.2.8', label: '😀'.repeat(100) }] };
    assert.deepEqual(validateDeviceValues(input).errors, {});
    assert.equal(validateDeviceValues(input).values.additional_ips[0].id, 7);
    for (const row of [
        { ip: '::1', label: '' }, { ip: '', label: '' }, { ip: '192.0.2.8', label: '😀'.repeat(101) }
    ]) assert.ok(validateDeviceValues({ ...input, additional_ips: [row] }).errors.additional_ips);
    assert.ok(validateDeviceValues({ ...input, ip: '192.0.2.8' }).errors.additional_ips);
    assert.ok(validateDeviceValues({ ...input, additional_ips: [...input.additional_ips, { ip: '192.0.2.8', label: '' }] }).errors.additional_ips);
});
