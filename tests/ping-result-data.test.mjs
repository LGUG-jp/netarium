import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    createPingResultRun,
    completePingResultRun,
    getPingResultSummary,
    filterPingResultRows,
    serializePingResultCsv,
    getPingResultCsvFilename
} from '../public/js/core/ping-result-data.js';

const START = new Date('2026-10-08T03:04:05.678Z');
const END = new Date('2026-10-08T03:04:20.000Z');

function makeRun(count = 5, startedAt = START) {
    const targets = Array.from({ length: count }, (_, index) => ({ id: index + 1, ip: `10.0.0.${index + 1}` }));
    const devices = targets.map(target => ({ id: target.id, name: `機器${target.id}` }));
    return createPingResultRun(targets, devices, startedAt);
}

function freezeTree(value) {
    if (value && typeof value === 'object') {
        Object.values(value).forEach(freezeTree);
        Object.freeze(value);
    }
    return value;
}

/** 実CSVを再読し、引用の二重化と引用外のCRLF区切りを検証する。 */
function parseCsv(csv) {
    assert.equal(csv[0], '\uFEFF', 'UTF-8 BOMを含む');
    const records = [];
    let cursor = 1;
    while (cursor < csv.length) {
        const record = [];
        while (true) {
            assert.equal(csv[cursor++], '"', '全セルを引用する');
            let field = '';
            let closed = false;
            while (cursor < csv.length) {
                const char = csv[cursor++];
                if (char !== '"') {
                    field += char;
                } else if (csv[cursor] === '"') {
                    field += '"';
                    cursor++;
                } else {
                    closed = true;
                    break;
                }
            }
            assert.equal(closed, true, '引用セルが閉じている');
            record.push(field);
            if (csv[cursor] === ',') {
                cursor++;
                continue;
            }
            assert.equal(csv.slice(cursor, cursor + 2), '\r\n', 'レコード区切りはCRLF');
            cursor += 2;
            break;
        }
        records.push(record);
    }
    return records;
}

test('開始時に名前と対象IPをコピーし、後続の編集・削除やDate変更の影響を受けない', () => {
    const targets = [{ id: 2, ip: '192.0.2.2' }, { id: 1, ip: '192.0.2.1' }, { id: 3, ip: '' }];
    const devices = [
        { id: 1, name: '開始時ルーター', ip: '別のIP', status: 'red', last_error: '以前の障害' },
        { id: '2', name: '開始時SW', status: 'green' }
    ];
    const date = new Date(START);
    const run = createPingResultRun(targets, devices, date);
    const before = structuredClone(run);
    assert.deepEqual(run, {
        startedAt: START.toISOString(), completedAt: null, phase: 'running', error: null,
        rows: [
            { id: 2, name: '開始時SW', ip: '192.0.2.2', outcome: 'unknown', response_ms: null, error: null },
            { id: 1, name: '開始時ルーター', ip: '192.0.2.1', outcome: 'unknown', response_ms: null, error: null },
            { id: 3, name: 'ID 3', ip: '', outcome: 'unknown', response_ms: null, error: null }
        ]
    });
    targets[0].id = 999;
    targets[0].ip = '変更後IP';
    targets.pop();
    devices[0].name = '変更後の名前';
    devices.splice(1);
    date.setFullYear(2030);
    assert.deepEqual(run, before);
    assert.equal(devices[0].status, 'red');
    assert.equal(devices[0].last_error, '以前の障害');
});

test('結果IDで突合し対象順を維持、欠落は未確認、対象外と結果側の名前/IPは混入しない', () => {
    const run = freezeTree(makeRun(4));
    const results = freezeTree([
        { id: 4, outcome: 'timeout', response_ms: null, error: '応答待ち時間超過' },
        { id: 900, outcome: 'failure', name: '対象外', ip: '203.0.113.99', response_ms: 100, error: '対象外' },
        { id: '1', outcome: 'success', response_ms: 1.25, error: null, name: 'rename後', ip: '変更後IP' },
        { id: 3, outcome: 'skipped', error: 'IPが変更されたため対象外' }
    ]);
    const inputRun = structuredClone(run);
    const inputResults = structuredClone(results);
    const completed = completePingResultRun(run, results, END);
    assert.equal(completed.phase, 'completed');
    assert.equal(completed.completedAt, END.toISOString());
    assert.equal(completed.startedAt, START.toISOString());
    assert.equal(completed.error, null);
    assert.deepEqual(completed.rows, [
        { id: 1, name: '機器1', ip: '10.0.0.1', outcome: 'success', response_ms: 1.25, error: null },
        { id: 2, name: '機器2', ip: '10.0.0.2', outcome: 'unknown', response_ms: null, error: null },
        { id: 3, name: '機器3', ip: '10.0.0.3', outcome: 'skipped', response_ms: null, error: 'IPが変更されたため対象外' },
        { id: 4, name: '機器4', ip: '10.0.0.4', outcome: 'timeout', response_ms: null, error: '応答待ち時間超過' }
    ]);
    assert.notEqual(completed, run);
    assert.notEqual(completed.rows, run.rows);
    completed.rows.forEach((row, index) => assert.notEqual(row, run.rows[index]));
    assert.deepEqual(run, inputRun);
    assert.deepEqual(results, inputResults);
});

test('5区分の合計は総数と一致し、表示失敗にはNGとタイムアウトだけを含める', () => {
    const outcomes = ['success', 'failure', 'timeout', 'skipped', 'unknown', 'failure', 'success'];
    const completed = completePingResultRun(makeRun(outcomes.length), outcomes.map((outcome, index) => ({ id: index + 1, outcome })), END);
    const summary = getPingResultSummary(completed);
    assert.deepEqual(summary, { total: 7, success: 2, failure: 2, timeout: 1, skipped: 1, unknown: 1 });
    assert.equal(summary.total, summary.success + summary.failure + summary.timeout + summary.skipped + summary.unknown);
    assert.deepEqual(filterPingResultRows(completed, 'all').map(row => row.id), [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(filterPingResultRows(completed, 'failed').map(row => row.id), [2, 3, 6]);
    assert.deepEqual(filterPingResultRows(completed, 'success').map(row => row.id), [1, 7]);
    assert.equal(completed.rows.length, 7);
});

test('5区分以外のoutcomeは監視statusやprototype名から推測せず未確認にする', () => {
    const outcomes = ['green', 'red', 'toString', '__proto__', 'success ', null, undefined];
    const run = completePingResultRun(makeRun(outcomes.length), outcomes.map((outcome, index) => ({
        id: index + 1, outcome, status: 'green'
    })), END);
    assert.ok(run.rows.every(row => row.outcome === 'unknown'));
    assert.deepEqual(getPingResultSummary(run), { total: 7, success: 0, failure: 0, timeout: 0, skipped: 0, unknown: 7 });
    assert.deepEqual(filterPingResultRows(run, 'failed'), []);
    assert.deepEqual(filterPingResultRows(run, 'success'), []);
});

test('API全体エラーは成功結果があっても全行未確認とし理由をCSVにも残す', () => {
    const original = freezeTree(makeRun(3));
    const error = 'API処理に失敗\n監視情報は保持されました';
    const run = completePingResultRun(original, [{ id: 1, outcome: 'success', response_ms: 12 }], END, error);
    assert.equal(run.phase, 'failed');
    assert.equal(run.error, error);
    assert.equal(run.completedAt, END.toISOString());
    assert.ok(run.rows.every(row => row.outcome === 'unknown' && row.response_ms === null && row.error === error));
    assert.deepEqual(getPingResultSummary(run), { total: 3, success: 0, failure: 0, timeout: 0, skipped: 0, unknown: 3 });
    assert.deepEqual(filterPingResultRows(run, 'failed'), []);
    const records = parseCsv(serializePingResultCsv(run));
    assert.equal(records.length, 4);
    records.slice(1).forEach(record => {
        assert.equal(record[3], '未確認');
        assert.equal(record[4], '');
        assert.equal(record[5], error);
    });
    assert.equal(original.phase, 'running');
    assert.ok(original.rows.every(row => row.error === null));
});

test('別runを作成すると前回結果を引き継がず、同じ対象の結果欠落も未確認になる', () => {
    const previous = completePingResultRun(makeRun(3), [
        { id: 1, outcome: 'success', response_ms: 15 },
        { id: 2, outcome: 'failure', error: '以前の障害' },
        { id: 3, outcome: 'timeout', error: '以前のタイムアウト' }
    ], END);
    const before = structuredClone(previous);
    const laterStart = new Date('2026-10-08T04:00:00Z');
    const current = createPingResultRun(
        [{ id: 2, ip: '192.0.2.22' }, { id: 4, ip: '192.0.2.4' }],
        [{ id: 2, name: '改名後SW' }, { id: 4, name: '新規SW' }], laterStart
    );
    assert.ok(current.rows.every(row => row.outcome === 'unknown' && row.error === null));
    const completed = completePingResultRun(current, [{ id: 4, outcome: 'success', response_ms: 0 }], new Date('2026-10-08T04:00:20Z'));
    assert.deepEqual(completed.rows[0], { id: 2, name: '改名後SW', ip: '192.0.2.22', outcome: 'unknown', response_ms: null, error: null });
    assert.equal(completed.rows[1].response_ms, 0);
    assert.equal(completed.startedAt, laterStart.toISOString());
    assert.deepEqual(previous, before);
});

test('応答未取得はnull/CSV空欄、0・小数・負の正常数値は数式保護なしで出力する', () => {
    const values = [undefined, null, '', '  ', NaN, Infinity, -Infinity, '未取得', '=1+1', false, 0, 0.75, -2, '3.5'];
    const expected = [null, null, null, null, null, null, null, null, null, null, 0, 0.75, -2, 3.5];
    const run = completePingResultRun(makeRun(values.length), values.map((response_ms, index) => ({ id: index + 1, outcome: 'success', response_ms })), END);
    assert.deepEqual(run.rows.map(row => row.response_ms), expected);
    assert.deepEqual(parseCsv(serializePingResultCsv(run)).slice(1).map(record => record[4]), expected.map(value => value == null ? '' : String(value)));
});

test('CSVを再読して日本語・comma・quote・embedded LF・Unicodeと全件出力を確認する', () => {
    const targets = [{ id: 1, ip: '2001:db8::1' }, { id: 2, ip: '192.0.2.2' }, { id: 3, ip: '' }];
    const devices = [{ id: 1, name: '東京,"中核"\nSW𠮷😀' }, { id: 2, name: '大阪AP' }, { id: 3, name: '予備機' }];
    const run = completePingResultRun(createPingResultRun(targets, devices, START), [
        { id: 1, outcome: 'success', response_ms: 1.5 },
        { id: 2, outcome: 'failure', error: '到達不可,"経路"\n次の確認' },
        { id: 3, outcome: 'skipped', error: 'IP未設定' }
    ], END);
    const before = structuredClone(run);
    assert.equal(filterPingResultRows(run, 'failed').length, 1);
    const csv = serializePingResultCsv(run);
    assert.deepEqual([...Buffer.from(csv, 'utf8').subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.deepEqual(parseCsv(csv), [
        ['実行日時', '機器名', 'IPアドレス', '結果', '応答時間(ms)', 'エラー概要'],
        [START.toISOString(), devices[0].name, targets[0].ip, 'OK', '1.5', ''],
        [START.toISOString(), '大阪AP', '192.0.2.2', 'NG', '', '到達不可,"経路"\n次の確認'],
        [START.toISOString(), '予備機', '', 'スキップ', '', 'IP未設定']
    ]);
    assert.deepEqual(run, before);
});

test('CSVの数式は空白・control・Unicode不可視文字で隠しても先頭アポストロフィで安全化する', () => {
    const dangerous = [
        '=SUM(1,2)', '+1+2', '-1+2', '@SUM(1,2)', '\t機器', '\r機器', '\n機器',
        '  =1+1', ' \t+1', '\u0000-1+2', '\u001f @SUM(1,2)', '\u007f=1',
        '\u0085+1', '\u00a0=1', '\u3000-1', '\u200b@SUM(1,2)', '\uFEFF=1',
        ' \n機器', '\u2060\u0001 =1', '=HYPERLINK("http://example.test","x")'
    ];
    const safe = ['通常の機器', '  通常の機器', "'=既に引用", 'IP-アドレス', '機器\n継続', 'Unicode𠮷😀'];
    const values = [...dangerous, ...safe];
    const targets = values.map((ip, index) => ({ id: index + 1, ip }));
    const devices = values.map((name, index) => ({ id: index + 1, name }));
    const run = freezeTree(completePingResultRun(createPingResultRun(targets, devices, START), values.map((error, index) => ({
        id: index + 1, outcome: 'failure', error
    })), END));
    const before = structuredClone(run);
    const records = parseCsv(serializePingResultCsv(run)).slice(1);
    records.forEach((record, index) => {
        const expected = index < dangerous.length ? "'" + values[index] : values[index];
        assert.equal(record[1], expected, `機器名 ${index}`);
        assert.equal(record[2], expected, `IP ${index}`);
        assert.equal(record[5], expected, `エラー ${index}`);
    });
    assert.deepEqual(run, before, '元データにはアポストロフィを加えない');
});

test('filenameは開始時のローカル日時で固定し、完了日時や年月日ゼロ埋めを取り違えない', () => {
    const start = new Date(2026, 0, 2, 3, 4, 5);
    const complete = new Date(2026, 8, 9, 20, 21, 22);
    const run = completePingResultRun(makeRun(1, start), [], complete);
    assert.equal(getPingResultCsvFilename(run), 'ping_20260102_030405.csv');
    assert.equal(parseCsv(serializePingResultCsv(run))[1][0], start.toISOString());
});

test('表示モデルは100超を切り捨てず、全件分類・フィルター・CSVに反映する', () => {
    const count = 237;
    const outcomes = ['success', 'failure', 'timeout', 'skipped', 'unknown'];
    const results = Array.from({ length: count }, (_, index) => ({ id: index + 1, outcome: outcomes[index % 5] })).reverse();
    const run = completePingResultRun(makeRun(count), results, END);
    assert.equal(run.rows.length, count);
    assert.deepEqual(run.rows.map(row => row.id), Array.from({ length: count }, (_, index) => index + 1));
    assert.deepEqual(getPingResultSummary(run), { total: count, success: 48, failure: 48, timeout: 47, skipped: 47, unknown: 47 });
    assert.equal(filterPingResultRows(run, 'failed').length, 95);
    assert.equal(filterPingResultRows(run, 'success').length, 48);
    const records = parseCsv(serializePingResultCsv(run));
    assert.equal(records.length, count + 1);
    assert.equal(records.at(-1)[1], '機器237');
    assert.equal(records.at(-1)[3], 'NG');
});

test('空実行の集計・filter・CSVと結果なし完了を扱う', () => {
    const run = completePingResultRun(createPingResultRun([], [], START), null, END);
    assert.deepEqual(getPingResultSummary(run), { total: 0, success: 0, failure: 0, timeout: 0, skipped: 0, unknown: 0 });
    for (const filter of ['all', 'failed', 'success']) assert.deepEqual(filterPingResultRows(run, filter), []);
    assert.deepEqual(parseCsv(serializePingResultCsv(run)), [['実行日時', '機器名', 'IPアドレス', '結果', '応答時間(ms)', 'エラー概要']]);
    const missing = completePingResultRun(makeRun(2), null, END);
    assert.ok(missing.rows.every(row => row.outcome === 'unknown' && row.response_ms === null && row.error === null));
});
