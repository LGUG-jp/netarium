import { isValidIpv4, normalizeMacAddress } from './utils.js';

const fields = {
    name: ['機器名称', 100], ip: ['IPアドレス', 45], facility: ['施設名', 100],
    floor: ['フロア', 50], location: ['設置場所', 150], manufacturer: ['メーカー', 100],
    model: ['型番', 100], asset_number: ['管理番号', 100], serial_number: ['シリアル番号', 100],
    mac_address: ['MACアドレス', 50], memo: ['備考', 1000], department: ['担当部署', 100],
    maintenance_vendor: ['保守ベンダー', 100]
};

/** 実在日付文字列の検証 (YYYY-MM または YYYY-MM-DD) */
export function isValidDateString(value) {
    if (!value) return true;
    const match = /^(\d{4})-(0[1-9]|1[0-2])(?:-(0[1-9]|[12]\d|3[01]))?$/.exec(value);
    if (!match || Number(match[1]) < 1000) return false;
    if (!match[3]) return true;
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    return date.getUTCMonth() === Number(match[2]) - 1 && date.getUTCDate() === Number(match[3]);
}

/** 導入年月と保守期限年月の順序検証 */
export function validateDateOrder(install, expiry) {
    return !install || !expiry || (expiry.slice(0, 7) >= install.slice(0, 7)
        && !(install.length === 10 && expiry.length === 10 && expiry < install));
}

// UIに依存しないフィールド名で返す。複数機器編集も同じ制約を利用する。
export function validateDeviceValues(input, devices = []) {
    const values = { ...input };
    const errors = {};
    for (const [field, [label, limit]] of Object.entries(fields)) {
        values[field] = String(values[field] ?? '').trim();
        if (Array.from(values[field]).length > limit) errors[field] = `${label}は${limit}文字以内で入力してください`;
    }
    if (!values.name) errors.name = '機器名称を入力してください';
    if (!errors.ip && values.ip && !isValidIpv4(values.ip)) errors.ip = 'IPアドレスの形式が不正です';
    if (!errors.ip && values.ip) {
        const duplicate = devices.find(row => Number(row.id) !== Number(values.id) && String(row.ip ?? '').trim() === values.ip);
        if (duplicate) errors.ip = `IPアドレス ${values.ip} は「${duplicate.name || `機器ID ${duplicate.id}`}」で使用されています`;
    }
    values.mac_address = normalizeMacAddress(values.mac_address);
    values.management_scheme = String(values.management_scheme ?? '').trim();
    if (!['', 'http', 'https', 'ssh'].includes(values.management_scheme)) errors.management_scheme = '管理接続方式が不正です';
    const port = String(values.management_port ?? '').trim();
    if (port && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) {
        errors.management_port = 'ポート番号は1〜65535の整数で入力してください';
    } else if (port && !values.management_scheme) {
        errors.management_port = '管理接続方式が未設定の場合、ポートは指定できません';
    }
    values.management_port = port === '' ? null : Number(port);
    for (const [field, label] of [['install_date', '導入年月'], ['maintenance_expiry', '保守期限']]) {
        values[field] = String(values[field] ?? '').trim();
        if (!isValidDateString(values[field])) errors[field] = `${label}は実在する年月(YYYY-MM)または年月日(YYYY-MM-DD)で入力してください`;
    }
    if (!errors.install_date && !errors.maintenance_expiry && !validateDateOrder(values.install_date, values.maintenance_expiry)) {
        errors.maintenance_expiry = '保守期限は導入年月以降の日付を指定してください';
    }
    return { values, errors };
}
