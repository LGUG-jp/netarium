export const CONFIG_MAX_BYTES = 256 * 1024;
// 比較結果の描画行上限（左右の合計入力行数ではない）。
export const CONFIG_MAX_DIFF_LINES = 4000;
const MAX_DIFF_CELLS = 1000000;

export function normalizeConfigText(value) {
    return String(value).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

export function validateConfigText(value) {
    const content = normalizeConfigText(value);
    if (!content.trim()) throw new Error('Config本文を入力してください');
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u.test(content) || !content.isWellFormed()) {
        throw new Error('ConfigはUTF-8のプレーンテキストを指定してください（バイナリ・制御文字は登録できません）');
    }
    if (new TextEncoder().encode(content).length > CONFIG_MAX_BYTES) {
        throw new Error('Config本文は正規化後UTF-8で256 KiB以下にしてください');
    }
    return content;
}

/** 共通部分を除いたLCSを100万セル、返却する描画行を4000行に制限する。 */
export function compareConfigLines(before, after) {
    if (before === after) return { identical: true, rows: [] };
    const left = before.split('\n'), right = after.split('\n');
    if (Math.max(left.length, right.length) > CONFIG_MAX_DIFF_LINES) return null;
    let prefix = 0, suffix = 0;
    while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix++;
    while (suffix < left.length - prefix && suffix < right.length - prefix &&
        left[left.length - suffix - 1] === right[right.length - suffix - 1]) suffix++;
    const m = left.length - prefix - suffix, n = right.length - prefix - suffix;
    if ((m + 1) * (n + 1) > MAX_DIFF_CELLS) return null;
    const width = n + 1;
    const lcs = new Uint16Array((m + 1) * width);
    for (let i = m - 1; i >= 0; i--) {
        for (let j = n - 1; j >= 0; j--) {
            lcs[i * width + j] = left[prefix + i] === right[prefix + j]
                ? lcs[(i + 1) * width + j + 1] + 1
                : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
        }
    }
    const rows = [];
    const equal = index => rows.push({ kind: 'equal', left: left[index], right: right[index] });
    for (let i = 0; i < prefix; i++) equal(i);
    let i = 0, j = 0;
    while (i < m || j < n) {
        if (rows.length + suffix >= CONFIG_MAX_DIFF_LINES) return null;
        if (i < m && j < n && left[prefix + i] === right[prefix + j]) {
            rows.push({ kind: 'equal', left: left[prefix + i++], right: right[prefix + j++] });
            continue;
        }
        const removed = [], added = [];
        while (i < m || j < n) {
            if (i < m && j < n && left[prefix + i] === right[prefix + j]) break;
            if (i < m && (j === n || lcs[(i + 1) * width + j] >= lcs[i * width + j + 1])) {
                removed.push(left[prefix + i++]);
            } else {
                added.push(right[prefix + j++]);
            }
        }
        if (rows.length + Math.max(removed.length, added.length) + suffix > CONFIG_MAX_DIFF_LINES) return null;
        for (let k = 0; k < Math.max(removed.length, added.length); k++) {
            rows.push({ kind: k < removed.length && k < added.length ? 'change' : k < removed.length ? 'delete' : 'add',
                left: removed[k] ?? null, right: added[k] ?? null });
        }
    }
    for (let k = suffix; k > 0; k--) {
        rows.push({ kind: 'equal', left: left[left.length - k], right: right[right.length - k] });
    }
    return { identical: false, rows };
}
