export const PING_RESULT_LABELS = Object.freeze({
    success: 'OK',
    failure: 'NG',
    timeout: 'タイムアウト',
    skipped: 'スキップ',
    unknown: '未確認'
});

/** 実行時の対象と機器名をコピーし、以後の機器編集とは切り離す。 */
export function createPingResultRun(targets, devices, startedAt = new Date()) {
    const deviceById = new Map(devices.map(device => [String(device.id), device]));
    return {
        startedAt: new Date(startedAt).toISOString(),
        completedAt: null,
        phase: 'running',
        error: null,
        rows: targets.map(target => ({
            id: target.id,
            name: String(deviceById.get(String(target.id))?.name ?? `ID ${target.id}`),
            ip: String(target.ip ?? ''),
            outcome: 'unknown',
            response_ms: null,
            error: null
        }))
    };
}

function normalizeResponseMs(value) {
    if (typeof value !== 'number' && typeof value !== 'string') return null;
    if (typeof value === 'string' && value.trim() === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

/** 対象順を維持して今回の結果だけを突合する。監視状態や入力は変更しない。 */
export function completePingResultRun(run, results, completedAt = new Date(), error = null) {
    const runError = error ? String(error) : null;
    const resultById = new Map((results ?? []).map(result => [String(result.id), result]));
    return {
        startedAt: run.startedAt,
        completedAt: new Date(completedAt).toISOString(),
        phase: runError ? 'failed' : 'completed',
        error: runError,
        rows: run.rows.map(row => {
            const result = runError ? null : resultById.get(String(row.id));
            return {
                id: row.id,
                name: row.name,
                ip: row.ip,
                outcome: result && Object.hasOwn(PING_RESULT_LABELS, result.outcome)
                    ? result.outcome : 'unknown',
                response_ms: result ? normalizeResponseMs(result.response_ms) : null,
                error: runError ?? (result?.error == null ? null : String(result.error))
            };
        })
    };
}

export function getPingResultSummary(run) {
    const summary = { total: run.rows.length, success: 0, failure: 0, timeout: 0, skipped: 0, unknown: 0 };
    for (const row of run.rows) {
        const outcome = Object.hasOwn(PING_RESULT_LABELS, row.outcome) ? row.outcome : 'unknown';
        summary[outcome]++;
    }
    return summary;
}

/** 「失敗」はNGとタイムアウトのみ。スキップと未確認は含めない。 */
export function filterPingResultRows(run, filter) {
    return run.rows.filter(row => {
        if (filter === 'failed') return row.outcome === 'failure' || row.outcome === 'timeout';
        if (filter === 'success') return row.outcome === 'success';
        return true;
    });
}

function quoteCsvCell(value) {
    let text = value == null ? '' : String(value);
    // PHP側と同じ先頭アポストロフィ方式。空白・制御文字で隠した数式も出力時だけ保護する。
    if (/^[\s\p{Cc}\p{Cf}]*[=+\-@\t\r\n]/u.test(text)) text = "'" + text;
    return `"${text.replaceAll('"', '""')}"`;
}

/** 表示フィルターに関係なく実行全件を、BOM付きRFC 4180 CSVとして出力する。 */
export function serializePingResultCsv(run) {
    const records = [['実行日時', '機器名', 'IPアドレス', '結果', '応答時間(ms)', 'エラー概要']];
    for (const row of run.rows) {
        records.push([
            run.startedAt,
            row.name,
            row.ip,
            PING_RESULT_LABELS[row.outcome] ?? PING_RESULT_LABELS.unknown,
            row.response_ms,
            row.error
        ]);
    }
    return '\uFEFF' + records.map(record => record.map((value, index) => {
        // 正常な数値の負号は数式ではないため、そのまま出力する。
        if (index === 4 && typeof value === 'number' && Number.isFinite(value)) return `"${value}"`;
        return quoteCsvCell(value);
    }).join(',')).join('\r\n') + '\r\n';
}

export function getPingResultCsvFilename(run) {
    const date = new Date(run.startedAt);
    const pad = value => String(value).padStart(2, '0');
    const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
    const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
    return `ping_${day}_${time}.csv`;
}
