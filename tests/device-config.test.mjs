import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeConfigText, validateConfigText, compareConfigLines, CONFIG_MAX_BYTES, CONFIG_MAX_DIFF_LINES } from '../public/js/core/device-config.js';

function assertCompared(before, after) {
    const result = compareConfigLines(before, after);
    assert.ok(result, '上限内の差分を比較できる');
    assert.equal(result.identical, false);
    assert.ok(result.rows.length <= CONFIG_MAX_DIFF_LINES);
    assert.equal(result.rows.filter(row => row.left !== null).map(row => row.left).join('\n'), before);
    assert.equal(result.rows.filter(row => row.right !== null).map(row => row.right).join('\n'), after);
    return result.rows;
}

test('Configの改行・UTF-8サイズ・空/バイナリ入力の境界', () => {
    assert.equal(normalizeConfigText('\uFEFFa\r\nb\rc\n'), 'a\nb\nc\n');
    assert.equal(validateConfigText('あ'.repeat(87381) + 'a'), 'あ'.repeat(87381) + 'a');
    assert.equal(validateConfigText('x'.repeat(CONFIG_MAX_BYTES)).length, CONFIG_MAX_BYTES);
    for (const value of ['', ' \t\r\n', 'abc\u0000', 'abc\u0001', '\ud800', 'あ'.repeat(87382)]) {
        assert.throws(() => validateConfigText(value));
    }
});

test('行単位の変更・追加・削除・末尾改行を区別し両本文を再構成できる', () => {
    for (const [before, after] of [
        ['hostname old\ninterface a\n', 'hostname new\ninterface a\n description test\n'],
        ['a\nb\nc', 'a\nc'], ['a\nc', 'a\nb\nc'], ['a\n', 'a'],
        ['same\na\nb\nsame', 'same\nb\na\nsame'], ['', 'a']
    ]) {
        assertCompared(before, after);
    }
    assert.deepEqual(compareConfigLines('a', 'b').rows, [{ kind: 'change', left: 'a', right: 'b' }]);
    assert.deepEqual(compareConfigLines('a\nb', 'a\nb'), { identical: true, rows: [] });
});

test('2001行の末尾1行変更を共通行も欠落させず比較できる', () => {
    const prefix = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n') + '\n';
    const rows = assertCompared(prefix + 'old', prefix + 'new');
    assert.equal(rows.length, 2001);
    assert.ok(rows.slice(0, -1).every(row => row.kind === 'equal'));
    assert.deepEqual(rows.at(-1), { kind: 'change', left: 'old', right: 'new' });
});

test('数千行の重複行を含む共通前後部分と追加・削除を比較できる', () => {
    const prefix = 'same\n'.repeat(2000);
    const suffix = '\nsame'.repeat(1500);
    const rows = assertCompared(prefix + 'old\nsame\nkeep' + suffix, prefix + 'same\nkeep\nnew' + suffix);
    assert.deepEqual(rows.slice(2000, -1500), [
        { kind: 'delete', left: 'old', right: null },
        { kind: 'equal', left: 'same', right: 'same' },
        { kind: 'equal', left: 'keep', right: 'keep' },
        { kind: 'add', left: null, right: 'new' }
    ]);
    assert.ok(rows.slice(0, 2000).every(row => row.kind === 'equal'));
    assert.ok(rows.slice(-1500).every(row => row.kind === 'equal'));
    assert.deepEqual(assertCompared(prefix + 'keep' + suffix, prefix + 'added\nkeep' + suffix)[2000],
        { kind: 'add', left: null, right: 'added' });
    assert.deepEqual(assertCompared(prefix + 'removed\nkeep' + suffix, prefix + 'keep' + suffix)[2000],
        { kind: 'delete', left: 'removed', right: null });
});

test('共通部分を除いてもLCS計算量が上限を超える差分は比較しない', () => {
    assert.equal(compareConfigLines('a\n'.repeat(2100), 'b\n'.repeat(2100)), null);
    assert.equal(compareConfigLines('a\n'.repeat(1100), 'b\n'.repeat(1100)), null);
    const prefix = 'same\n'.repeat(2000);
    assert.equal(compareConfigLines(prefix + 'a\n'.repeat(1000), prefix + 'b\n'.repeat(1000)), null);
});

test('描画上限4000行までは比較し、超過時は部分的なrowsではなくnullを返す', () => {
    const prefix = 'same\n'.repeat(CONFIG_MAX_DIFF_LINES - 1);
    assert.equal(assertCompared(prefix + 'old', prefix + 'new').length, CONFIG_MAX_DIFF_LINES);
    assert.equal(compareConfigLines(prefix + 'same\nold', prefix + 'same\nnew'), null);
    assert.equal(assertCompared(prefix + 'old', prefix.slice(0, -1)).at(-1).kind, 'delete');
    assert.equal(assertCompared(prefix.slice(0, -1), prefix + 'new').at(-1).kind, 'add');

    // 各版は上限内でも、削除と追加が別々の行に並ぶと描画行数は増える。
    const boundary = 'same\n'.repeat(CONFIG_MAX_DIFF_LINES - 3);
    assert.equal(assertCompared(boundary + 'old\nanchor', boundary + 'anchor\nnew').length, CONFIG_MAX_DIFF_LINES);
    const over = 'same\n' + boundary;
    assert.equal(compareConfigLines(over + 'old\nanchor', over + 'anchor\nnew'), null);
    assert.deepEqual(compareConfigLines(prefix + 'same\nsame', prefix + 'same\nsame'), { identical: true, rows: [] });
});
