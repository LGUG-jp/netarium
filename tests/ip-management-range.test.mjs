import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cidrDetails, segmentStatistics, segmentAddressPage, segmentIpPageIndex, unclassifiedIpPage } from '../public/js/core/ip-management.js';
import { execFileSync } from 'node:child_process';

test('CIDRは正規化・マスク・ホスト境界を算出し、/31と/32は全IPをホストとして扱う', () => {
    const range = cidrDetails('192.0.2.129/24');
    assert.equal(range.normalized, '192.0.2.0/24');
    assert.equal(range.mask, '255.255.255.0');
    assert.equal(range.network, '192.0.2.0');
    assert.equal(range.broadcast, '192.0.2.255');
    assert.equal(range.hostCount, 254);
    assert.equal(range.hostStart, range.start + 1);
    assert.equal(range.hostEnd, range.end - 1);
    const pair = cidrDetails('192.0.2.1/31');
    assert.equal(pair.hostCount, 2); assert.equal(pair.hostStart, pair.start); assert.equal(pair.hostEnd, pair.end);
    assert.equal(pair.broadcast, null);
    const single = cidrDetails('192.0.2.1/32');
    assert.equal(single.hostCount, 1); assert.equal(single.hostStart, single.hostEnd);
    assert.equal(single.broadcast, null);
    const all = cidrDetails('255.255.255.255/0');
    assert.equal(all.normalized, '0.0.0.0/0'); assert.equal(all.mask, '0.0.0.0');
    for (const invalid of ['192.0.2.0/33', '256.1.1.1/24', '192.0.2.0', '192.0.2.0/-1']) assert.equal(cidrDetails(invalid), null);
});

test('CIDRの正規プレフィックスと前後空白の受入境界をPHPパーサーと揃える', () => {
    const inputs = [
        ...Array.from({ length: 33 }, (_, prefix) => `192.0.2.1/${prefix}`),
        ' \t192.0.2.1/24\r\n', '\0\v192.0.2.1/32\0',
        '192.0.2.1/00', '192.0.2.1/01', '192.0.2.1/032', '192.0.2.1/33',
        '192.0.2.1/-1', '192.0.2.1/+1', '192.0.2.1/1.0', '192.0.2.1/1e1',
        '192.0.2.1/ 24', '192.0.2.1/24/1', '192.0.2.1/２４', '192.0.2.256/24',
        '\u00a0192.0.2.1/24', '192.0.2.1/24\u00a0'
    ];
    const server = JSON.parse(execFileSync('php', ['-r', `
        require 'bootstrap.php';
        $result = [];
        foreach (json_decode(stream_get_contents(STDIN), true, 512, JSON_THROW_ON_ERROR) as $cidr) {
            try { $result[] = \\Netarium\\Services\\Topology\\Ipv4Cidr::parse($cidr)['cidr']; }
            catch (\\Netarium\\Core\\ApiException $e) { $result[] = null; }
        }
        echo json_encode($result, JSON_THROW_ON_ERROR);
    `], { input: JSON.stringify(inputs), encoding: 'utf8' }));
    inputs.forEach((input, index) => assert.equal(cidrDetails(input)?.normalized ?? null, server[index], JSON.stringify(input)));
    for (const input of ['192.0.2.1/00', '192.0.2.1/032']) assert.equal(cidrDetails(input), null);
});

test('登録率はホスト範囲内uniqueのみ、ネットワークとブロードキャストも登録件数に残す', () => {
    const rows = ['192.0.2.0', '192.0.2.1', '192.0.2.1', '192.0.2.3'].map(ip => ({ ip }));
    const stats = segmentStatistics({ cidr: '192.0.2.0/30' }, rows);
    assert.deepEqual(stats, { unique: 3, records: 4, duplicates: 1, hosts: 1, hostCount: 2, rate: 50 });
    assert.equal(segmentStatistics({ cidr: '192.0.2.0/31' }, rows).rate, 100);
    assert.equal(segmentStatistics({ cidr: '192.0.2.1/32' }, rows).rate, 100);
    assert.equal(segmentStatistics({ cidr: '192.0.2.0/24' }).rate, 0);
});

test('登録済みuniqueを既定に50件ページングし全range切替と全登録検索を同じ一覧に適用する', () => {
    const segment = { cidr: '10.0.0.0/8' };
    const records = Array.from({ length: 120 }, (_, index) => ({ ip: `10.0.0.${index + 1}`, device_id: index, device_name: index > 54 ? '検索対象' : '通常' }));
    records.push({ ...records[119], device_id: 999 });
    const first = segmentAddressPage(segment, records);
    assert.equal(first.total, 120); assert.equal(first.pages, 3); assert.equal(first.rows.length, 50);
    assert.equal(first.rows[0].ip, '10.0.0.1');
    const last = segmentAddressPage(segment, records, 999);
    assert.equal(last.page, 2); assert.equal(last.rows.length, 20); assert.equal(last.rows.at(-1).records.length, 2);
    const found = segmentAddressPage(segment, records, 0, { query: '検索対象', includeUnregistered: true });
    assert.equal(found.total, 65); assert.equal(found.rows[0].ip, '10.0.0.56'); assert.equal(found.rows.length, 50);
    const foundLast = segmentAddressPage(segment, records, 1, { query: '検索対象' });
    assert.equal(foundLast.rows.length, 15); assert.equal(foundLast.rows.at(-1).records.length, 2);
    const full = segmentAddressPage(segment, records, 0, { includeUnregistered: true });
    assert.equal(full.total, 16777216); assert.equal(full.rows.length, 50); assert.equal(full.rows[0].ip, '10.0.0.0');
    assert.equal(segmentAddressPage(segment, records, 0, { query: 'missing' }).total, 0);
    assert.deepEqual(segmentAddressPage(segment), { rows: [], total: 0, pages: 0, page: 0 });
});

test('未分類IPの50件ページング・候補状態絞り込み・診断対象のページ位置特定と保護を行う', () => {
    const segments = [
        { id: 1, address_space_id: 1, cidr: '192.0.2.0/24', name: '本番A' },
        { id: 2, address_space_id: 2, cidr: '192.0.2.0/24', name: '検証B' },
        { id: 3, address_space_id: 1, cidr: '198.51.100.0/24', name: '単一C' }
    ];
    const records = [
        ...Array.from({ length: 55 }, (_, i) => ({
            device_id: i + 1, device_name: `一意機器${i + 1}`, kind: 'management', id: null,
            ip: `198.51.100.${i + 1}`, segment_id: null
        })),
        { device_id: 200, device_name: '複数候補機器', kind: 'management', id: null, ip: '192.0.2.10', segment_id: null },
        { device_id: 201, device_name: '候補なし機器', kind: 'additional', id: 9, ip: '203.0.113.5', label: '監視用', segment_id: null }
    ];
    const firstPage = unclassifiedIpPage(records, segments, 0);
    assert.deepEqual(firstPage.summary, { total: 57, unique: 55, multiple: 1, none: 1 });
    assert.equal(firstPage.pages, 2);
    assert.equal(firstPage.rows.length, 50);

    const multipleOnly = unclassifiedIpPage(records, segments, 0, { candidateFilter: 'multiple' });
    assert.equal(multipleOnly.total, 1);
    assert.equal(multipleOnly.rows[0].row.device_id, 200);

    const noneOnly = unclassifiedIpPage(records, segments, 0, { candidateFilter: 'none', query: '監視用' });
    assert.equal(noneOnly.total, 1);
    assert.equal(noneOnly.rows[0].row.device_id, 201);

    // 55件目以降にある診断対象でもtargetPageが算出され、別フィルター中でもrowsへ保持される
    const withTarget = unclassifiedIpPage(records, segments, 0, { candidateFilter: 'unique', targetKey: '201:additional:9' });
    assert.equal(withTarget.targetPage, 1);
    assert.equal(withTarget.rows[0].key, '201:additional:9');

    assert.equal(segmentIpPageIndex({ cidr: '192.0.2.0/24' }, '192.0.2.0'), 0);
    assert.equal(segmentIpPageIndex({ cidr: '192.0.2.0/24' }, '192.0.2.50'), 1);
    assert.equal(segmentIpPageIndex({ cidr: '192.0.2.0/24' }, '198.51.100.1'), null);
    const exactUnregistered = segmentAddressPage({ cidr: '192.0.2.0/24' }, [], 0, { includeUnregistered: true, query: '192.0.2.123' });
    assert.equal(exactUnregistered.total, 1);
    assert.equal(exactUnregistered.rows[0].ip, '192.0.2.123');
});
