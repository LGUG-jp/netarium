import { isValidIpv4 } from './utils.js';

// Preview the same cross-device ambiguity used by the server's Ping policy.
export function pingReachabilityWarnings(records = [], spaces = [], segments = []) {
    const byIp = new Map();
    for (const record of records) {
        if (!record.ip) continue;
        const segment = segments.find(row => Number(row.id) === Number(record.segment_id));
        const space = record.segment_id == null ? null : spaces.find(row =>
            Number(row.id) === Number(segment?.address_space_id ?? record.address_space_id));
        const row = { ...record, address_space_id: space?.id ?? null, ping_reachability: space?.ping_reachability || 'unset', address_space_name: space?.name || '未分類' };
        if (!byIp.has(row.ip)) byIp.set(row.ip, []);
        byIp.get(row.ip).push(row);
    }
    return [...byIp].filter(([, rows]) => rows.some(target => {
        if (target.kind !== 'management' || target.ping_reachability === 'unreachable') return false;
        const others = rows.filter(row => Number(row.device_id) !== Number(target.device_id));
        return target.ping_reachability === 'reachable'
            ? others.some(row => row.ping_reachability === 'unset' ||
                (row.ping_reachability === 'reachable' && Number(row.address_space_id) !== Number(target.address_space_id)))
            : others.some(row => row.ping_reachability === 'reachable');
    })).map(([ip, records]) => ({ ip, records }));
}

export function ipv4Number(ip) {
    if (!isValidIpv4(String(ip))) return null;
    return String(ip).split('.').reduce((value, part) => value * 256 + Number(part), 0);
}
export function numberIpv4(value) {
    return [24, 16, 8, 0].map(shift => Math.floor(value / 2 ** shift) % 256).join('.');
}
export function cidrRange(cidr) {
    // Match PHP trim() and Ipv4Cidr::parse(), including canonical prefix spelling.
    const parts = String(cidr).replace(/^[ \t\n\r\0\v]+|[ \t\n\r\0\v]+$/g, '').split('/');
    const ip = ipv4Number(parts[0]);
    if (parts.length !== 2 || !/^(?:[0-9]|[12][0-9]|3[0-2])$/.test(parts[1]) || ip === null) return null;
    const size = 2 ** (32 - Number(parts[1]));
    const start = Math.floor(ip / size) * size;
    return { start, end: start + size - 1, size };
}
export function cidrDetails(cidr) {
    const range = cidrRange(cidr);
    if (!range) return null;
    const prefix = 32 - Math.log2(range.size);
    const hostStart = range.start + (prefix < 31 ? 1 : 0);
    const hostEnd = range.end - (prefix < 31 ? 1 : 0);
    return { ...range, normalized: `${numberIpv4(range.start)}/${prefix}`, mask: numberIpv4(4294967296 - range.size),
        network: numberIpv4(range.start), broadcast: prefix < 31 ? numberIpv4(range.end) : null,
        hostStart, hostEnd, hostCount: hostEnd - hostStart + 1 };
}
export function segmentStatistics(segment, records = []) {
    const range = cidrDetails(segment.cidr);
    const values = ipStatistics(records);
    const hosts = new Set(records.filter(row => {
        const value = ipv4Number(row.ip);
        return range && value !== null && value >= range.hostStart && value <= range.hostEnd;
    }).map(row => row.ip)).size;
    return { ...values, hosts, hostCount: range?.hostCount || 0, rate: range ? hosts * 100 / range.hostCount : 0 };
}
export function segmentContains(segment, ip) {
    const range = cidrRange(segment.cidr);
    const value = ipv4Number(ip);
    return range !== null && value !== null && value >= range.start && value <= range.end;
}
export function segmentCandidates(ip, segments = []) {
    return segments.filter(segment => segmentContains(segment, ip));
}
export function segmentLabel(segment, spaces = []) {
    const space = spaces.find(row => Number(row.id) === Number(segment.address_space_id));
    return [space?.name, segment.name, segment.cidr, segment.facility, segment.vlan_id == null ? '' : `VLAN ${segment.vlan_id}`].filter(Boolean).join(' / ');
}
export function ipStatistics(records = []) {
    const counts = new Map();
    for (const row of records) if (ipv4Number(row.ip) !== null) counts.set(row.ip, (counts.get(row.ip) || 0) + 1);
    return { unique: counts.size, records: records.length, duplicates: [...counts.values()].filter(count => count > 1).length };
}
export function segmentAddressPage(segment, records = [], page = 0, { includeUnregistered = false, query = '' } = {}) {
    const range = cidrRange(segment.cidr);
    if (!range) return { rows: [], page: 0, pages: 0, total: 0 };
    const byIp = new Map();
    for (const record of records) {
        if (!segmentContains(segment, record.ip)) continue;
        if (!byIp.has(record.ip)) byIp.set(record.ip, []);
        byIp.get(record.ip).push(record);
    }
    const keyword = query.trim().toLocaleLowerCase();
    const matched = [...byIp].filter(([ip, rows]) => !keyword || rows.some(row =>
        [ip, row.device_name, row.device_id, row.label].join(' ').toLocaleLowerCase().includes(keyword)));
    if (includeUnregistered && keyword && segmentContains(segment, keyword) && !byIp.has(keyword)) {
        matched.push([keyword, []]);
    }
    const registered = matched.sort(([a], [b]) => ipv4Number(a) - ipv4Number(b));
    // A search always targets all registrations, not only the current range page.
    const all = includeUnregistered && !keyword;
    const total = all ? range.size : registered.length;
    const pages = Math.ceil(total / 50);
    page = Math.max(0, Math.min(Math.max(0, pages - 1), Math.floor(Number(page) || 0)));
    const rows = [];
    if (all) {
        for (let value = range.start + page * 50; value <= Math.min(range.end, range.start + page * 50 + 49); value++) {
            const ip = numberIpv4(value);
            rows.push({ ip, records: byIp.get(ip) || [] });
        }
    } else for (const [ip, records] of registered.slice(page * 50, page * 50 + 50)) rows.push({ ip, records });
    return { rows, page, pages, total };
}
export function segmentIpPageIndex(segment, ip) {
    const range = cidrRange(segment?.cidr);
    const value = ipv4Number(ip);
    if (!range || value === null || value < range.start || value > range.end) return null;
    return Math.floor((value - range.start) / 50);
}
export function unclassifiedIpPage(records = [], segments = [], page = 0, { query = '', candidateFilter = '', targetKey = null } = {}) {
    const keyOf = row => `${row.device_id}:${row.kind}:${row.id ?? ''}`;
    const all = records.filter(row => row.segment_id == null).map(row => ({
        row, key: keyOf(row), candidates: segmentCandidates(row.ip, segments)
    }));
    const summary = {
        total: all.length,
        unique: all.filter(item => item.candidates.length === 1).length,
        multiple: all.filter(item => item.candidates.length > 1).length,
        none: all.filter(item => item.candidates.length === 0).length
    };
    const keyword = query.trim().toLocaleLowerCase();
    const filtered = all.filter(({ row, candidates }) => {
        const matchesQuery = !keyword || [row.ip, row.device_name, row.device_id, row.label].join(' ').toLocaleLowerCase().includes(keyword);
        const matchesFilter = !candidateFilter ||
            (candidateFilter === 'unique' && candidates.length === 1) ||
            (candidateFilter === 'multiple' && candidates.length > 1) ||
            (candidateFilter === 'none' && candidates.length === 0);
        return matchesQuery && matchesFilter;
    });
    const total = filtered.length;
    const pages = Math.ceil(total / 50);
    page = Math.max(0, Math.min(Math.max(0, pages - 1), Math.floor(Number(page) || 0)));
    const rows = filtered.slice(page * 50, page * 50 + 50);
    const targetIndex = targetKey ? all.findIndex(item => item.key === targetKey) : -1;
    if (targetIndex >= 0 && !rows.some(item => item.key === targetKey)) {
        rows.unshift(all[targetIndex]);
    }
    return { all, filtered, rows, page, pages, total, summary, targetPage: targetIndex >= 0 ? Math.floor(targetIndex / 50) : 0 };
}
export function classifiedIpRecords(devices, segments = []) {
    return devices.flatMap(device => [
        { ip: device.ip, segment_id: device.ip_segment_id, kind: 'management', id: null },
        ...(device.additional_ips || []).map(row => ({ ...row, kind: 'additional' }))
    ].filter(row => row.ip).map(row => ({ ...row, device_id: Number(device.id), device_name: device.name,
        address_space_id: segments.find(segment => Number(segment.id) === Number(row.segment_id))?.address_space_id ?? null })));
}
