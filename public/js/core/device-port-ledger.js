import { normalizePortName } from './connection-data.js';

const collator = new Intl.Collator('ja', { numeric: true });
const idText = id => id == null ? '' : String(id);

export function projectPortLedger(state, deviceId) {
    const byPort = new Map();
    const portsById = new Map(state.devicePorts.map(port => [port.id, port]));
    const unmigratedVlans = new Map(state.legacyLinkVlans.map(record => [Number(record.link_id), record]));
    const unspecified = [];
    for (const link of state.links) {
        const side = link.from_id === deviceId ? 'from' : link.to_id === deviceId ? 'to' : null;
        if (!side) continue;
        const peer = side === 'from' ? 'to' : 'from';
        const portId = link[`${side}_port_id`];
        const peerPortId = link[`${peer}_port_id`];
        const peerPort = portsById.get(peerPortId);
        const row = { link, side, peerId: link[`${peer}_id`], peerPort,
            unmigratedVlan: unmigratedVlans.get(Number(link.id)),
            peerPortName: link[`${peer}_port_name`] ?? peerPort?.name ?? '' };
        if (portId == null) unspecified.push({ ...row, key: `link-${link.id}` });
        else byPort.set(portId, row);
    }
    const held = state.legacyLinkConflicts.filter(row => Number(row.device_a_id) === deviceId || Number(row.device_b_id) === deviceId);
    const heldNames = new Set(held.map(({ payload }) => normalizePortName(
        Number(payload.from_id) === deviceId ? payload.from_port : payload.to_port)));
    const ports = state.devicePorts.filter(port => port.device_id === deviceId)
        .sort((a, b) => collator.compare(a.name, b.name) || a.id - b.id)
        .map(port => ({ ...byPort.get(port.id), key: `port-${port.id}`, port, held: heldNames.has(port.name) }));
    return { ports, unspecified: unspecified.sort((a, b) => a.link.id - b.link.id), held };
}

export function portLedgerValues(row) {
    return {
        portName: row.port?.name ?? '', vlan: row.port?.vlan ?? '', portMemo: row.port?.memo ?? '', peerId: idText(row.peerId),
        peerPortName: row.peerPortName ?? '', systemId: idText(row.link?.system_id),
        label: row.link?.label ?? '', linkMemo: row.link?.memo ?? ''
    };
}

// The form's source rows provide the expected revisions; never rebase them silently at Apply.
export function buildPortLedgerBatch(state, deviceId, row, values, allocateId, action, selectedOwnPort) {
    const batch = { device_ports: [], links: [] };
    const before = portLedgerValues(row);
    const changed = (rows, source) => source && !rows.some(item =>
        item.id === source.id && item.resource_revision > 0 && item.resource_revision === source.resource_revision);
    if (changed(state.devicePorts, row.port) || changed(state.links, row.link) || (row.port && !row.link &&
        state.links.some(link => link.from_port_id === row.port.id || link.to_port_id === row.port.id))) {
        throw new Error('編集中の行が更新されました。入力を確認し、キャンセルしてから行を開き直してください');
    }
    const remove = row => ({ operation: 'delete', id: row.id, expected_revision: row.resource_revision });
    if (action === 'disconnect') {
        batch.links.push(remove(row.link));
        return batch;
    }
    if (action === 'delete') {
        batch.device_ports.push(remove(row.port));
        return batch;
    }

    if (!state.devices.some(device => Number(device.id) === deviceId && device.resource_revision > 0)) {
        throw new Error('この機器を保存してからポート・接続を適用してください');
    }

    const portName = normalizePortName(values.portName);
    const peerPortName = normalizePortName(values.peerPortName);
    const requiredPort = row.port || row.key === 'new-port';
    if (requiredPort && !portName) throw new Error('ポート名を入力してください');
    if ((row.link || row.key === 'new-link') && !values.peerId) throw new Error('接続先機器を選択してください');

    const sameName = (owner, name) => state.devicePorts.find(port => port.device_id === owner && port.name === name);
    const matchingPort = portName && sameName(deviceId, portName);
    if (matchingPort && requiredPort && matchingPort.id !== row.port?.id) {
        throw new Error('同じ機器に同名のポートが登録されています');
    }
    const selectingForMigration = row.unmigratedVlan && !row.port;
    if (selectingForMigration &&
        ((matchingPort?.id ?? null) !== (selectedOwnPort?.id ?? null) || changed(state.devicePorts, selectedOwnPort))) {
        throw new Error('ポートが更新されました。入力を確認し、キャンセルしてから行を開き直してください');
    }
    const ownPort = row.port || (selectingForMigration ? selectedOwnPort : matchingPort);
    const vlanChanged = values.vlan.replace(/^ +| +$/g, '') !==
        (selectingForMigration && ownPort ? ownPort.vlan ?? '' : before.vlan);
    const portNameChanged = portName !== before.portName;
    if ((portName && !ownPort) ||
        (row.port && (portNameChanged || values.portMemo !== before.portMemo || vlanChanged))) {
        batch.device_ports.push({
            ...(ownPort ? { operation: 'update', id: ownPort.id, expected_revision: ownPort.resource_revision } :
                { operation: 'create', id: allocateId('devicePorts') }),
            port: { device_id: deviceId, name: portName, memo: values.portMemo,
                ...(!ownPort || vlanChanged ? { vlan: values.vlan } : {}) }
        });
    }
    if (selectingForMigration && ownPort && vlanChanged) {
        batch.device_ports.push({
            operation: 'update', id: ownPort.id, expected_revision: ownPort.resource_revision, port: { vlan: values.vlan }
        });
    }
    if (!values.peerId) return batch;

    // Preserve the existing from/to orientation even when editing from the to side.
    const side = row.side || 'from';
    const peer = side === 'from' ? 'to' : 'from';
    const peerId = Number(values.peerId);
    const peerDevice = state.devices.find(device => Number(device.id) === peerId);
    if (peerId === deviceId || !peerDevice) {
        throw new Error('接続先機器を選び直してください');
    }
    if (!(peerDevice.resource_revision > 0)) {
        throw new Error('接続先の機器を保存してから適用してください');
    }
    const link = {};
    const peerChanged = values.peerId !== before.peerId || peerPortName !== before.peerPortName;
    const peerPort = peerChanged && peerPortName ? sameName(peerId, peerPortName) : null;
    const configuredPort = port => port?.resource_revision > 0 && Boolean(port.vlan);
    if (row.unmigratedVlan && (vlanChanged || (!row.port && portName && configuredPort(ownPort)) ||
        (configuredPort(peerPort) && peerPort.id !== row.link[`${peer}_port_id`]))) {
        const linkId = Number(row.link.id);
        if (!state.legacyLinkVlans.some(record =>
            Number(record.link_id) === linkId && record.vlan === row.unmigratedVlan.vlan)) {
            throw new Error('未移行VLANが更新されました。入力を確認し、キャンセルしてから行を開き直してください');
        }
        batch.complete_legacy_vlan = linkId;
    }
    if (!row.link) link[`${side}_id`] = deviceId;
    if (values.peerId !== before.peerId) link[`${peer}_id`] = peerId;
    if (!row.link || (portName && !row.port)) {
        if (ownPort) link[`${side}_port_id`] = ownPort.id;
        else if (portName) link[`${side}_port_name`] = portName;
    }
    // Unchanged assignments are left by ID, even if the peer renamed a port since the form opened.
    if (peerChanged) {
        if (peerPort || !peerPortName) link[`${peer}_port_id`] = peerPort ? peerPort.id : null;
        else link[`${peer}_port_name`] = peerPortName;
    }
    for (const [input, key] of [['label', 'label'], ['linkMemo', 'memo'], ['systemId', 'system_id']]) {
        if (values[input] !== before[input]) link[key] = input === 'systemId' ? (values[input] ? Number(values[input]) : null) : values[input];
    }
    if (Object.keys(link).length || batch.complete_legacy_vlan) batch.links.push({
        ...(row.link ? { operation: 'update', id: row.link.id, expected_revision: row.link.resource_revision } :
            { operation: 'create', id: allocateId('links') }), link
    });
    return batch;
}
