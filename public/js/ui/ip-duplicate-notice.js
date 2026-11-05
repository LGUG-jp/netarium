import { appState } from '../core/state.js';
import { classifiedIpRecords, ipv4Number, segmentCandidates } from '../core/ip-management.js';

export function createIpDuplicateNotice({ getRecord, field = 'segment_id', canEdit, onChange, ipInput }) {
    const root = document.createElement('div');
    root.className = 'ip-duplicate-notice form-support';
    root.setAttribute('aria-live', 'polite');
    let lastIp = getRecord()?.ip || '';
    const refresh = (changedIp = false) => {
        const record = getRecord();
        if (!record) return;
        const candidates = segmentCandidates(record.ip, appState.ipSegments || []);
        if (changedIp) record[field] = candidates.length === 1 ? Number(candidates[0].id) : null;
        const valid = ipv4Number(record.ip) !== null;
        const messages = [];
        const segment = (appState.ipSegments || []).find(row => Number(row.id) === Number(record[field]));
        const deviceId = field === 'ip_segment_id' ? record.id : record.device_id;
        const duplicates = valid ? classifiedIpRecords(appState.devices || [], appState.ipSegments || []).filter(row =>
            row.ip === record.ip && Number(row.device_id) !== Number(deviceId) &&
            (segment == null || row.address_space_id == null || Number(row.address_space_id) === Number(segment.address_space_id))) : [];
        if (duplicates.length) messages.push('重複の可能性があります。保存時の警告を確認してください。');
        root.textContent = messages.join(' ');
        root.hidden = messages.length === 0;
    };
    if (ipInput) {
        if (ipInput._ipSegmentListener) ipInput.removeEventListener('input', ipInput._ipSegmentListener);
        ipInput._ipSegmentListener = () => {
            if (!canEdit()) return;
            const record = getRecord();
            const ip = ipInput.value.trim();
            if (lastIp === ip) { refresh(); return; }
            lastIp = ip;
            record.ip = ip;
            delete record.ip_conflicts_confirmed;
            refresh(true);
            onChange();
        };
        ipInput.addEventListener('input', ipInput._ipSegmentListener);
    }
    root.refresh = refresh;
    refresh();
    return root;
}
