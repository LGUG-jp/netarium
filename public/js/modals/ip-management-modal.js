import { appState, normalizeDevice } from '../core/state.js';
import { DEVICE_TYPES } from '../core/constants.js';
import { apiFetch } from '../core/api-client.js';
import { eventBus } from '../core/event-bus.js';
import { registerModalOpen, registerModalClose } from '../core/modal-focus.js';
import { hasAnyDeviceDraftChanges } from '../core/device-drafts.js';
import { hasPendingChanges, runResourceMutation } from '../core/save-queue.js';
import { resetResourceBaseline } from '../core/resource-save.js';
import { isCurrentUserAdmin } from '../ui/access-control.js';
import { showToast } from '../ui/toast.js';
import {
    cidrDetails, numberIpv4, ipv4Number, segmentContains, segmentCandidates,
    segmentLabel, segmentAddressPage, segmentIpPageIndex, unclassifiedIpPage,
    ipStatistics, segmentStatistics, pingReachabilityWarnings
} from '../core/ip-management.js';
import { openLedgerDetail } from './ledger-modal.js';

let overlay, content, status, noticeBar, noticeCloseButton, recoveryButton;
let busy = false, loaded = false, records = [], spaceId = null, segmentId = null, query = '', candidateFilter = '', page = 0, form = null;
let masterRevision = 0, includeUnregistered = false, recoveryRequired = false, highlightedIp = '';
let target = null, targetReady = false, focusTarget = false, refreshButton, closeButton, searchInput;
let activeConfirmPromise = null, finishActiveConfirm = null;
const membershipSelections = new Map();
let membershipDestination = '';
const deviceTypes = new Map();

const node = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text != null) element.textContent = text;
    if (className) element.className = className;
    return element;
};
const admin = () => isCurrentUserAdmin() && !appState.authExpired && !appState.isPinging;
const clean = () => !hasPendingChanges() && !hasAnyDeviceDraftChanges();
const keyOf = row => `${row.device_id}:${row.kind}:${row.id ?? ''}`;

function syncNoticeVisibility() {
    if (!noticeBar || !status) return;
    if (recoveryButton) {
        recoveryButton.hidden = !recoveryRequired;
        recoveryButton.disabled = busy || !admin();
    }
    const hasText = Boolean(status.textContent);
    if (noticeCloseButton) {
        noticeCloseButton.hidden = !hasText || recoveryRequired;
        noticeCloseButton.disabled = busy;
    }
    noticeBar.hidden = !hasText && !recoveryRequired;
}

function message(text, tone = 'info') {
    const normalized = String(text ?? '');
    const transient = !recoveryRequired && (tone === 'info' || tone === 'success');
    const effectiveTone = normalized ? tone : (recoveryRequired ? 'warning' : 'info');
    if (transient) showToast(normalized, tone);
    if (status) {
        status.textContent = transient ? '' : normalized;
        status.setAttribute('aria-live', effectiveTone === 'error' ? 'assertive' : 'polite');
    }
    if (noticeBar) {
        noticeBar.className = `ip-management-notice is-${effectiveTone}`;
    }
    syncNoticeVisibility();
}

function button(text, action, parent, write = false, primary = false) {
    if (write && !admin()) return null;
    const element = node('button', text, `btn ${primary ? 'btn-primary' : 'btn-secondary'} btn-sm`);
    element.type = 'button'; element.disabled = busy;
    if (write) element.dataset.write = 'true';
    element.addEventListener('click', event => { void action(event); });
    if (parent) parent.appendChild(element);
    return element;
}

function cardIcon(kind) {
    const svg = document.createElementNS ? document.createElementNS('http://www.w3.org/2000/svg', 'svg') : node('svg');
    svg.setAttribute('class', 'ip-management-card-icon');
    svg.setAttribute('width', '20');
    svg.setAttribute('height', '20');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS ? document.createElementNS('http://www.w3.org/2000/svg', 'path') : node('path');
    if (kind === 'segment') {
        path.setAttribute('d', 'M4 6h16M4 12h16M4 18h10');
    } else if (kind === 'unclassified') {
        path.setAttribute('d', 'M12 8v4m0 4h.01M4 6h16v12H4z');
    } else {
        path.setAttribute('d', 'M12 3L2 8l10 5 10-5-10-5zM2 13l10 5 10-5M2 18l10 5 10-5');
    }
    svg.appendChild(path);
    return svg;
}

function formFieldDefs(kind, existing = null) {
    if (kind === 'network') {
        return [['name', 'ネットワーク区分名'], ['ping_reachability', 'Netariumサーバーからの到達性'], ['segment_name', 'セグメント名'], ['cidr', 'IPv4 CIDR'], ['memo', '区分メモ（任意）'], ['purpose', '用途（任意）'], ['facility', '施設（任意）'], ['vlan_id', 'VLAN ID（任意）'], ['segment_memo', 'セグメントメモ（任意）']];
    }
    if (kind === 'segment') {
        return [...(existing ? [['address_space_id', 'ネットワーク区分']] : []), ['name', 'セグメント名'], ['cidr', 'IPv4 CIDR'], ['purpose', '用途（任意）'], ['facility', '施設（任意）'], ['vlan_id', 'VLAN ID（任意）'], ['memo', 'メモ（任意）']];
    }
    return [['name', 'ネットワーク区分名'], ['ping_reachability', 'Netariumサーバーからの到達性'], ['memo', 'メモ（任意）']];
}

function buildInitialFormValues(kind, existing = null) {
    const initial = {};
    for (const [key] of formFieldDefs(kind, existing)) {
        if (key === 'ping_reachability') {
            initial[key] = existing?.[key] || 'unset';
        } else if (key === 'address_space_id') {
            const raw = existing?.address_space_id ?? spaceId ?? appState.addressSpaces?.[0]?.id ?? '';
            initial[key] = String(raw);
        } else {
            initial[key] = String(existing?.[key] ?? '');
        }
    }
    return initial;
}

function isFormDirty() {
    if (!form) return false;
    if (Object.keys(form.conflicts || {}).length > 0) return true;
    const initial = form.initialValues || {};
    return Object.keys(initial).some(key => String(form.values?.[key] ?? '') !== String(initial[key] ?? ''));
}

function hasUnsavedInput() {
    return isFormDirty() || membershipSelections.size > 0;
}

function closeActiveConfirm(result = false) {
    if (finishActiveConfirm) finishActiveConfirm(result);
}

function openConfirmDialog({ title = '確認', messageText = '', detailsNode = null, confirmLabel = '確定', cancelLabel = 'キャンセル', danger = false }) {
    if (activeConfirmPromise) return activeConfirmPromise;
    const confirmOverlay = node('div', null, 'placement-manager-overlay unsaved-changes-overlay ip-management-confirm-overlay');
    confirmOverlay.id = 'ip-management-confirm-overlay';
    const dialog = node('section', null, 'placement-manager-dialog unsaved-changes-dialog ip-management-confirm-dialog');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'ip-management-confirm-title');
    dialog.setAttribute('aria-describedby', 'ip-management-confirm-message');

    const header = node('div', null, 'placement-manager-header unsaved-changes-header');
    const heading = node('h2', title);
    heading.id = 'ip-management-confirm-title';
    const closeBtn = node('button', '×', 'modal-close-btn');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', '閉じる');
    header.append(heading, closeBtn);

    const body = node('div', null, 'unsaved-changes-message ip-management-confirm-body');
    body.id = 'ip-management-confirm-message';
    if (messageText) body.appendChild(node('p', messageText, 'ip-management-confirm-text'));
    if (detailsNode) body.appendChild(detailsNode);

    const actions = node('div', null, 'unsaved-changes-actions ip-management-confirm-actions');
    const cancelBtn = node('button', cancelLabel, 'btn btn-secondary btn-sm btn-cancel');
    cancelBtn.type = 'button';
    cancelBtn.dataset.confirmAction = 'cancel';
    const confirmBtn = node('button', confirmLabel, `btn ${danger ? 'btn-danger' : 'btn-primary'} btn-sm`);
    confirmBtn.type = 'button';
    confirmBtn.dataset.confirmAction = 'confirm';
    actions.append(cancelBtn, confirmBtn);

    let resolvePromise;
    const promise = new Promise(resolve => { resolvePromise = resolve; });
    const finish = result => {
        if (activeConfirmPromise !== promise) return;
        activeConfirmPromise = null;
        finishActiveConfirm = null;
        confirmOverlay.hidden = true;
        registerModalClose('ip-management-confirm');
        confirmOverlay.remove();
        resolvePromise(Boolean(result));
    };
    finishActiveConfirm = finish;
    cancelBtn.addEventListener('click', () => finish(false));
    closeBtn.addEventListener('click', () => finish(false));
    confirmBtn.addEventListener('click', () => finish(true));
    confirmOverlay.addEventListener('keydown', event => {
        if (event.key !== 'Tab') event.stopPropagation();
    });

    dialog.append(header, body, actions);
    confirmOverlay.appendChild(dialog);
    document.body.appendChild(confirmOverlay);
    activeConfirmPromise = promise;
    registerModalOpen('ip-management-confirm', confirmOverlay, cancelBtn, { onClose: () => finish(false), finishFloorPlan: false });
    return promise;
}

async function confirmDiscard() {
    if (!hasUnsavedInput()) return true;
    return openConfirmDialog({
        title: '変更の破棄確認',
        messageText: '入力中の設定を破棄しますか？',
        cancelLabel: '編集を続ける',
        confirmLabel: '変更を破棄',
        danger: true
    });
}

function accept(data, mutated = false) {
    appState.addressSpaces = data.address_spaces || [];
    appState.ipSegments = data.ip_segments || [];
    records = data.ip_records || [];
    masterRevision = Number(data.revision);
    appState.dataRevision = Math.max(Number(appState.dataRevision) || 0, masterRevision);
    const monitorRevision = Number(data.monitor_revision);
    if (Number.isInteger(monitorRevision) && monitorRevision >= 0) appState.monitorRevision = monitorRevision;
    loaded = true;
    deviceTypes.clear();
    for (const dev of (Array.isArray(data.devices) ? data.devices : appState.devices || [])) {
        if (dev && dev.id != null) deviceTypes.set(Number(dev.id), dev.type);
    }
    if (mutated && Array.isArray(data.devices)) {
        appState.devices = data.devices.map(normalizeDevice); resetResourceBaseline(appState);
        eventBus.emit('devices:changed'); eventBus.emit('ledger:selection-changed');
    }
    if (!mutated && Array.isArray(data.devices)) {
        const byId = new Map(data.devices.map(row => [Number(row.id), normalizeDevice(row)]));
        // A master refresh must not replace local device edits, but old Ping results
        // are no longer authoritative after a reachability/membership change.
        for (const device of appState.devices || []) {
            const latest = byId.get(Number(device.id));
            if (!latest || device.ip !== latest.ip) continue;
            for (const key of ['status', 'last_checked_at', 'last_error', 'last_response_ms']) device[key] = latest[key];
        }
        eventBus.emit('devices:changed'); eventBus.emit('ledger:selection-changed');
    }
    eventBus.emit('ip-management:changed');
}

function reconcileNavigationState() {
    if (!loaded || form) return '';
    if (segmentId !== null) {
        const segment = appState.ipSegments?.find(row => Number(row.id) === Number(segmentId));
        if (!segment) {
            segmentId = null;
            page = 0;
            query = '';
            includeUnregistered = false;
            highlightedIp = '';
            membershipSelections.clear();
            membershipDestination = '';
            const spaceExists = spaceId !== null && spaceId !== '' &&
                appState.addressSpaces?.some(row => Number(row.id) === Number(spaceId));
            if (spaceExists) {
                return '表示していたセグメントが見つからないため、セグメント一覧へ戻りました。';
            }
            spaceId = null;
            return '表示していたネットワーク区分が見つからないため、ネットワーク区分一覧へ戻りました。';
        }
        spaceId = String(segment.address_space_id);
        return '';
    }
    if (spaceId !== null && spaceId !== '') {
        const space = appState.addressSpaces?.find(row => Number(row.id) === Number(spaceId));
        if (!space) {
            spaceId = null;
            segmentId = null;
            page = 0;
            query = '';
            return '表示していたネットワーク区分が見つからないため、ネットワーク区分一覧へ戻りました。';
        }
    }
    return '';
}

async function go(space = null, segment = null) {
    if (busy || !(await confirmDiscard())) return;
    form = null; membershipSelections.clear();
    membershipDestination = '';
    target = null; highlightedIp = '';
    spaceId = space; segmentId = segment; page = 0; query = ''; candidateFilter = ''; includeUnregistered = false;
    message(''); render();
}

function targetRecord() {
    return targetReady && target && records.find(row => keyOf(row) === keyOf(target) && row.ip === target.ip && row.segment_id == null);
}

function checkTarget() {
    if (!target) return;
    targetReady = true;
    const current = records.find(row => keyOf(row) === keyOf(target));
    if (!current) message('対象のIP登録は削除されました。最新の未分類IPを表示しています。', 'warning');
    else if (current.ip !== target.ip) message('対象のIPアドレスは変更されました。元のIPとは異なるため、対象として表示しません。', 'warning');
    else if (current.segment_id != null && target.allowClassified) {
        const segment = appState.ipSegments.find(row => Number(row.id) === Number(current.segment_id));
        if (segment) {
            segmentId = Number(segment.id); spaceId = String(segment.address_space_id);
            query = current.ip; page = 0; highlightedIp = current.ip;
            message('対象IPの所属セグメントを表示しています。ネットワーク区分から到達性を確認してください。', 'info');
        }
    }
    else if (current.segment_id != null) message('対象のIPは分類済みです。最新の未分類IPを表示しています。', 'info');
    else {
        query = '';
        candidateFilter = '';
        const pageInfo = unclassifiedIpPage(records, appState.ipSegments, 0, { targetKey: keyOf(target) });
        page = pageInfo.targetPage;
        message('対象の未分類IPを表示しています。', 'info');
        focusTarget = true;
    }
}

async function refresh(discarded = false) {
    if (busy || (!discarded && !(await confirmDiscard()))) return;
    busy = true; disableControls();
    try {
        accept(await apiFetch('load_ip_management'));
        form = null; membershipSelections.clear(); recoveryRequired = false;
        membershipDestination = '';
        const navNotice = reconcileNavigationState();
        message(navNotice, 'info');
        checkTarget();
    } catch (error) { message(error.message, 'error'); }
    finally { busy = false; render(); }
}

async function recoverInput() {
    if (busy || !admin() || !recoveryRequired) return;
    if (!clean()) { message('機器・配置の未保存変更または編集中の入力があります。保存または破棄してください。入力は保持しています。', 'warning'); return; }
    busy = true; disableControls();
    try {
        await runResourceMutation(async () => {
            if (!clean()) throw new Error('未保存の変更があります。入力は保持しています。');
            const data = await apiFetch('load_ip_management');
            // 通信中に始まった機器編集も保護し、採用できたsnapshotだけをbaselineにする。
            if (!clean()) throw new Error('取得中に未保存の変更が発生しました。入力は保持しています。');
            if (!Array.isArray(data.devices)) throw new Error('機器の最新情報を取得できませんでした。入力は保持しています。');
            let notice = '';
            if (form) {
                if (form.existing) {
                    const latest = (form.kind === 'segment' ? data.ip_segments : data.address_spaces)?.find(row => Number(row.id) === Number(form.existing.id));
                    if (!latest || (form.kind === 'segment' && Number(latest.address_space_id) !== Number(form.existing.address_space_id))) {
                        form.unavailable = '編集対象は削除または移動されました。保存できません。入力はコピーできます。';
                    } else {
                        form.conflicts = {};
                        for (const key of Object.keys(form.values)) {
                            if (key === 'id') continue;
                            const fallback = key === 'ping_reachability' ? 'unset' : '';
                            const before = String(form.baseline[key] ?? fallback), mine = String(form.values[key] ?? fallback), current = String(latest[key] ?? fallback);
                            if (mine === before) {
                                form.values[key] = current;
                                if (form.initialValues) form.initialValues[key] = current;
                            } else if (current !== before && current !== mine) {
                                form.conflicts[key] = { mine, latest: current };
                            }
                            if (!form.conflicts[key]) form.baseline[key] = latest[key];
                        }
                        if (Object.keys(form.conflicts).length) notice = '同じ項目が変更されています。差分を確認し、使用する値を選択してください。';
                        else form.baseline = { ...latest };
                        form.existing = latest;
                    }
                } else if (form.kind === 'segment' && !data.address_spaces?.some(row => Number(row.id) === Number(spaceId))) {
                    form.unavailable = '追加先のネットワーク区分は削除されました。保存できません。入力はコピーできます。';
                }
                if (form.kind === 'segment' && form.values.address_space_id != null &&
                    !data.address_spaces?.some(row => Number(row.id) === Number(form.values.address_space_id))) {
                    notice = '選択したネットワーク区分が削除されました。再選択してください。';
                }
            }
            for (const [key, before] of membershipSelections) {
                const latest = data.ip_records?.find(row => keyOf(row) === key);
                if (!latest || before.ip !== latest.ip || before.segment_id !== latest.segment_id ||
                    (before.candidateSignature !== undefined && before.candidateSignature !== JSON.stringify(segmentCandidates(latest.ip, data.ip_segments || [])))) {
                    notice = '選択した登録または再分類候補が変更・削除されました。選択を解除し、最新の登録を選び直してください。';
                }
            }
            accept(data, true); recoveryRequired = false;
            const navNotice = reconcileNavigationState();
            const hasWarning = Boolean(form?.unavailable || notice);
            message(form?.unavailable || notice || navNotice || '入力を保持して最新情報を取得しました。内容を確認して保存してください。', hasWarning ? 'warning' : 'info');
            checkTarget();
        });
    } catch (error) { message(error.message, 'error'); }
    finally { busy = false; render(); }
}

async function mutate(action, payload, confirmation = null) {
    if (busy || !admin()) return;
    if (recoveryRequired) { message('入力を保持して最新情報を取得してから、内容を確認して保存してください。', 'warning'); return; }
    if (form?.unavailable) { message(form.unavailable, 'warning'); return; }
    if (Object.keys(form?.conflicts || {}).length) { message('競合する項目で使用する値を選択してください。', 'warning'); return; }
    if (!clean()) { message('機器・配置の未保存変更または編集中の入力があります。保存または破棄してください。入力は保持しています。', 'warning'); return; }
    if (confirmation) {
        const config = typeof confirmation === 'string'
            ? { title: '操作の確認', messageText: confirmation, confirmLabel: '実行', cancelLabel: 'キャンセル' }
            : confirmation;
        if (!(await openConfirmDialog(config))) return;
    }
    busy = true; disableControls();
    let succeeded = false;
    try {
        await runResourceMutation(async () => {
            if (!clean()) throw new Error('未保存の変更があります。先に保存してください。');
            const data = await apiFetch(action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, expected_revision: masterRevision }) });
            accept(data, true); form = null;
            if (action === 'reclassify_ips') {
                for (const rec of payload.records || []) {
                    const key = `${rec.device_id}:${rec.kind}:${rec.id ?? ''}`;
                    membershipSelections.delete(key);
                }
            } else {
                membershipSelections.clear();
            }
            if (!membershipSelections.size) membershipDestination = '';
            if (action === 'create_ip_network') {
                spaceId = String(data.created_address_space_id); segmentId = Number(data.created_segment_id); query = ''; candidateFilter = ''; includeUnregistered = false;
            } else if (action === 'save_ip_segment' && !payload.id) {
                const created = data.ip_segments?.find(row => Number(row.address_space_id) === Number(payload.address_space_id) && row.cidr === cidrDetails(payload.cidr)?.normalized);
                if (created) segmentId = Number(created.id);
                query = ''; candidateFilter = ''; includeUnregistered = false;
            } else if (action === 'save_ip_segment') {
                spaceId = String(payload.address_space_id); segmentId = Number(payload.id);
            } else if (action === 'delete_ip_segment') segmentId = null;
            else if (action === 'delete_address_space') { spaceId = null; segmentId = null; }
            page = 0; message(`保存しました。所属変更 ${Number(data.affected_count) || 0}件。`, 'success');
            checkTarget();
            succeeded = true;
        });
    } catch (error) {
        if (error.status === 409) recoveryRequired = true;
        message(error.status === 409 ? '他の操作で情報が更新されました。入力は保持しています。「入力を保持して最新情報を取得」で確認してください。' : error.message, error.status === 409 ? 'warning' : 'error');
    } finally { busy = false; if (!succeeded && (form || membershipSelections.size)) disableControls(); else render(); }
}

function disableControls() {
    if (!content) return;
    for (const element of content.querySelectorAll('button, input, select, textarea')) {
        element.disabled = busy || (element.dataset.write === 'true' && !admin()) || element.dataset.unavailable === 'true';
    }
    if (refreshButton) refreshButton.disabled = busy;
    if (closeButton) closeButton.disabled = busy;
    syncNoticeVisibility();
}

function statistics(parent, rows, segment = null) {
    const values = segment ? segmentStatistics(segment, rows) : ipStatistics(rows);
    parent.appendChild(node('p', `IPv4 ${values.unique}種類 / 登録 ${values.records}件 / 重複IP ${values.duplicates}種類${segment ? ` / ホスト用IP登録率 ${values.rate.toFixed(2)}%（${values.hosts}/${values.hostCount}）` : ''}`, 'form-support ip-management-stats-line'));
}

function navigationCard(parent, title, summary, description, action, { kind = 'space', badges = [], warning = false } = {}) {
    const card = button('', action, parent);
    card.className = `ip-management-card is-${kind}${warning ? ' has-warning' : ''}`;
    card.setAttribute('aria-label', title);
    const body = node('span', null, 'ip-management-card-body');
    const headerRow = node('span', null, 'ip-management-card-header');
    headerRow.appendChild(cardIcon(kind));
    headerRow.appendChild(node('strong', title, 'ip-management-card-title'));
    if (badges.length) {
        const badgeGroup = node('span', null, 'ip-management-card-badges');
        for (const badge of badges) {
            badgeGroup.appendChild(node('span', badge.text, `ip-management-badge is-${badge.tone || 'neutral'}`));
        }
        headerRow.appendChild(badgeGroup);
    }
    body.appendChild(headerRow);
    body.appendChild(node('span', summary, 'ip-management-card-summary'));
    if (description) body.appendChild(node('span', description, 'ip-management-description'));
    const arrow = node('span', '›', 'ip-management-card-arrow'); arrow.setAttribute('aria-hidden', 'true');
    card.append(body, arrow);
    return card;
}

function segmentOverview(parent, segment, rows) {
    const details = cidrDetails(segment.cidr);
    if (!details) return;
    const values = segmentStatistics(segment, rows);
    const overview = node('dl', null, 'ip-management-overview');
    for (const [label, value, mono] of [
        ['CIDR', details.normalized, true], ['サブネットマスク', details.mask, true],
        ['ネットワークアドレス', details.network, true], ['ブロードキャスト', details.broadcast ?? 'なし（/31・/32）', Boolean(details.broadcast)],
        ['ホスト範囲', `${numberIpv4(details.hostStart)} ～ ${numberIpv4(details.hostEnd)}`, true],
        ['ホスト数', String(details.hostCount), false],
        ['登録済みIP数', `${values.unique}種類（登録 ${values.records}件）`, false],
        ['ホスト用IP登録率', `${values.rate.toFixed(2)}%（${values.hosts}/${values.hostCount}）`, false]
    ]) {
        const item = node('div', null, 'ip-management-overview-item');
        const dd = node('dd', value, mono ? 'ip-management-mono' : '');
        item.append(node('dt', label), dd);
        overview.appendChild(item);
    }
    parent.appendChild(overview);
    parent.appendChild(node('p', '登録率は台帳への登録状況であり、実際の使用率や空きIPを示すものではありません。', 'form-support'));
}

function hasDuplicateDeviceName(deviceName, deviceId) {
    const normalized = String(deviceName || '').trim();
    if (!normalized) return true;
    return records.some(row => Number(row.device_id) !== Number(deviceId) && String(row.device_name || '').trim() === normalized);
}

function formatDeviceDisplayName(row) {
    const rawName = String(row.device_name || '').trim();
    const baseName = rawName || '名称未設定';
    if (!rawName || hasDuplicateDeviceName(rawName, row.device_id)) {
        return `${baseName}（機器ID ${row.device_id}）`;
    }
    return baseName;
}

function deviceTypeDefinition(row) {
    const typeKey = row.device_type || deviceTypes.get(Number(row.device_id)) ||
        appState.devices?.find(dev => Number(dev.id) === Number(row.device_id))?.type || 'other';
    return DEVICE_TYPES[typeKey] || DEVICE_TYPES.other;
}

function deviceLinks(parent, rows) {
    for (const row of rows) {
        const definition = deviceTypeDefinition(row);
        const displayName = formatDeviceDisplayName(row);
        const kindLabel = row.kind === 'management' ? '管理IP' : `追加IP${row.label ? ': ' + row.label : ''}`;
        const link = button('', async () => {
            if (await closeIpManagement()) void openLedgerDetail(Number(row.device_id));
        }, parent);
        link.classList.add('ip-management-device-link');
        link.dataset.deviceId = String(row.device_id);
        link.title = `機器個票を開く: ${row.device_name || '名称未設定'}（機器ID ${row.device_id} / ${definition.label} / ${kindLabel}）`;
        link.setAttribute('aria-label', `${displayName}（${kindLabel}）の機器個票を開く`);
        const icon = node('img', null, 'ip-management-device-icon');
        icon.src = definition.icon;
        icon.width = 18;
        icon.height = 18;
        icon.alt = '';
        icon.setAttribute('aria-hidden', 'true');
        const nameNode = node('span', displayName, 'ip-management-device-name');
        const kindNode = node('span', `（${kindLabel}）`, `ip-management-ip-kind ${row.kind === 'management' ? 'is-management' : 'is-additional'}`);
        link.append(icon, nameNode, kindNode);
    }
}

async function editMaster(kind, existing = null) {
    if (!admin() || busy || !(await confirmDiscard())) return;
    membershipSelections.clear(); target = null; highlightedIp = '';
    membershipDestination = '';
    query = ''; candidateFilter = ''; page = 0;
    const initialValues = buildInitialFormValues(kind, existing);
    form = { kind, existing, baseline: { ...existing }, initialValues, conflicts: {}, values: { ...initialValues } };
    render();
}

function renderCidrPreview(preview, rawCidr, showInvalid) {
    const details = cidrDetails(rawCidr);
    preview.replaceChildren();
    preview.classList.toggle('ip-management-invalid', !details && showInvalid);
    if (!details) {
        preview.textContent = showInvalid
            ? '有効なIPv4 CIDRを入力してください。（例: 192.168.11.0/24）'
            : 'IPv4 CIDRを入力すると、範囲とホスト数を確認できます。（例: 192.168.11.0/24）';
        return null;
    }
    const grid = node('div', null, 'ip-management-cidr-grid');
    for (const [label, value] of [
        ['正規化CIDR', details.normalized],
        ['サブネットマスク', details.mask],
        ['ネットワーク', details.network],
        ['ブロードキャスト', details.broadcast ?? 'なし（/31・/32）'],
        ['ホスト範囲', `${numberIpv4(details.hostStart)} ～ ${numberIpv4(details.hostEnd)} / ホスト数: ${details.hostCount}`]
    ]) {
        const cell = node('div', null, 'ip-management-cidr-item');
        cell.append(node('span', `${label}: `, 'ip-management-cidr-label'), node('strong', value, 'ip-management-cidr-value ip-management-mono'));
        grid.appendChild(cell);
    }
    preview.appendChild(grid);
    return details;
}

const reachabilityLabels = { unset: '未設定', reachable: '到達可能', unreachable: '到達不可（Ping対象外）' };

function reachabilityField(values, existing) {
    const field = node('fieldset', null, 'ip-management-reachability');
    field.appendChild(node('legend', 'Netariumサーバーからの到達性'));
    const warning = node('div', null, 'ip-management-reachability-warning');
    warning.setAttribute('aria-live', 'polite');
    const updateWarning = () => {
        warning.replaceChildren();
        const spaces = appState.addressSpaces.map(space => Number(space.id) === Number(existing?.id)
            ? { ...space, ping_reachability: values.ping_reachability } : space);
        const warnings = existing ? pingReachabilityWarnings(records, spaces, appState.ipSegments)
            .filter(group => group.records.some(row => Number(row.address_space_id) === Number(existing.id))) : [];
        warning.hidden = warnings.length === 0;
        if (!warnings.length) return;
        warning.appendChild(node('strong', '通信先を特定できないため、対象管理IPのPingはスキップされます。設定は保存できます。'));
        const list = node('ul');
        for (const group of warnings) {
            const item = node('li', `IP ${group.ip}`);
            const related = node('ul');
            for (const row of group.records) {
                related.appendChild(node('li', `${row.device_name || '名称未設定'}（機器ID ${row.device_id}・${row.kind === 'management' ? '管理IP' : '追加IP'}） / ${row.address_space_name} / ${reachabilityLabels[row.ping_reachability]}`));
            }
            item.appendChild(related); list.appendChild(item);
        }
        warning.appendChild(list);
    };
    const descriptions = {
        unset: '一意なIPは従来どおりPingし、重複IPはスキップします。',
        reachable: 'サーバーから実際に到達可能と運用者が確認した区分です。',
        unreachable: '一意なIPを含め、この区分のIPにはPingしません。'
    };
    for (const [value, title] of Object.entries(reachabilityLabels)) {
        const label = node('label', null, 'ip-management-reachability-option');
        const radio = node('input');
        radio.type = 'radio'; radio.name = 'ping_reachability'; radio.setAttribute('name', radio.name);
        radio.value = value; radio.checked = values.ping_reachability === value; radio.dataset.write = 'true';
        radio.addEventListener('change', () => {
            if (!radio.checked) return;
            values.ping_reachability = value;
            updateWarning();
        });
        const text = node('span');
        text.append(node('strong', title), node('span', descriptions[value], 'form-support'));
        label.append(radio, text); field.appendChild(label);
    }
    const notes = node('ul', null, 'ip-management-reachability-notes form-support');
    notes.appendChild(node('li', '実際のネットワーク構成・通信経路を確認して設定してください。'));
    notes.appendChild(node('li', 'この設定では、サーバーの通信経路は変更されません。'));
    notes.appendChild(node('li', '重複IPは、到達可能な登録先が1つに特定できる場合のみPingします。'));
    field.appendChild(notes);
    const conflict = form.conflicts?.ping_reachability;
    if (conflict) {
        const difference = node('div', null, 'ip-management-conflict');
        difference.append(node('strong', '到達性の変更が競合しています'),
            node('span', `入力した値: ${reachabilityLabels[conflict.mine]}`),
            node('span', `最新の値: ${reachabilityLabels[conflict.latest]}`));
        const resolve = value => {
            values.ping_reachability = value;
            delete form.conflicts.ping_reachability;
            form.baseline.ping_reachability = form.existing.ping_reachability || 'unset';
            render();
        };
        button('入力した値を使用', () => resolve(conflict.mine), difference, true);
        button('最新の値を使用', () => resolve(conflict.latest), difference, true);
        field.appendChild(difference);
    }
    field.appendChild(warning); updateWarning();
    return field;
}

function masterForm(parent) {
    const { kind, existing, values } = form;
    const network = kind === 'network', segment = kind === 'segment' || network;
    const requiredKeys = new Set(['name', 'segment_name', 'cidr', 'address_space_id']);
    if (kind === 'segment' && existing) requiredKeys.delete('name');
    const panel = node('form', null, 'ip-management-form');
    panel.appendChild(node('h3', network ? 'ネットワークを登録' : `${segment ? 'セグメント' : 'ネットワーク区分'}${existing ? 'を編集' : 'を追加'}`));
    const fields = formFieldDefs(kind, existing);
    let cidrInput, preview;
    const optional = node('details', null, 'ip-management-optional');
    optional.open = Boolean(existing);
    optional.appendChild(node('summary', segment ? '任意項目（用途・施設・VLAN・メモ）' : '任意項目（メモ）'));
    const updatePreview = () => {
        const details = renderCidrPreview(preview, values.cidr, Boolean(form.cidrTouched || String(values.cidr).trim()));
        cidrInput.setCustomValidity?.(details ? '' : '有効なIPv4 CIDRを入力してください。');
    };
    for (const [key, title] of fields) {
        if (key === 'ping_reachability') {
            panel.appendChild(reachabilityField(values, existing));
            continue;
        }
        const label = node('label', title);
        const input = node(key === 'address_space_id' ? 'select' : key.includes('memo') ? 'textarea' : 'input');
        if (key === 'address_space_id') for (const space of appState.addressSpaces) {
            const option = node('option', space.name); option.value = String(space.id); input.appendChild(option);
        }
        if (key === 'address_space_id' && values[key] != null && !appState.addressSpaces.some(space => Number(space.id) === Number(values[key]))) {
            const option = node('option', '選択中の区分が見つかりません（再選択してください）'); option.value = String(values[key]); input.appendChild(option);
        }
        input.name = key; input.setAttribute('name', key); input.dataset.write = 'true'; input.value = values[key] ?? ''; values[key] = input.value;
        input.required = requiredKeys.has(key);
        if (key === 'vlan_id') { input.type = 'number'; input.min = '1'; input.max = '4094'; }
        if (key === 'cidr') { input.placeholder = '192.168.11.0/24'; input.classList.add('ip-management-mono'); }
        if (key.includes('name')) input.maxLength = 100;
        if (key.includes('memo')) input.maxLength = 1000;
        const update = () => {
            values[key] = input.value;
            if (formError) { formError.textContent = ''; formError.hidden = true; }
            if (key === 'cidr') { form.cidrTouched = true; updatePreview(); }
        };
        input.addEventListener('input', update); input.addEventListener('change', update);
        label.appendChild(input);
        const conflict = form.conflicts?.[key];
        if (conflict) {
            const difference = node('div', null, 'ip-management-conflict');
            difference.appendChild(node('strong', `${title}の変更が競合しています`));
            difference.appendChild(node('span', `入力した値: ${conflict.mine || '（空欄）'}`));
            difference.appendChild(node('span', `最新の値: ${conflict.latest || '（空欄）'}`));
            const resolve = value => {
                values[key] = value; delete form.conflicts[key]; form.baseline[key] = form.existing[key];
                render();
            };
            button('入力した値を使用', () => resolve(conflict.mine), difference, true);
            button('最新の値を使用', () => resolve(conflict.latest), difference, true);
            label.appendChild(difference);
        }
        (['name', 'segment_name', 'cidr', 'address_space_id'].includes(key) ? panel : optional).appendChild(label);
        if (key === 'cidr') {
            cidrInput = input;
            input.addEventListener('invalid', () => { form.cidrTouched = true; updatePreview(); });
            preview = node('div', null, 'ip-management-cidr-preview form-support');
            preview.setAttribute('aria-live', 'polite');
            panel.appendChild(preview);
            updatePreview();
        }
    }
    panel.appendChild(optional);
    if (segment && existing) panel.appendChild(node('p', '範囲外になった登録は未分類に戻します。IP・機器は削除しません。', 'form-support'));
    if (form.unavailable) panel.appendChild(node('p', form.unavailable, 'form-support ip-management-invalid'));
    const formError = node('p', '', 'form-error ip-management-form-error');
    formError.hidden = true;
    formError.setAttribute('role', 'alert');
    const showFormError = (text, focusEl = null) => {
        formError.textContent = text;
        formError.hidden = false;
        focusEl?.focus?.();
    };
    panel.addEventListener('submit', event => {
        event.preventDefault(); if (busy || !admin()) return;
        if (form.unavailable) { showFormError(form.unavailable); return; }
        if (Object.keys(form.conflicts || {}).length) { showFormError('競合する項目で使用する値を選択してください。'); return; }
        if (segment) { form.cidrTouched = true; updatePreview(); }
        if (segment && !network && !appState.addressSpaces.some(space => Number(space.id) === Number(values.address_space_id ?? spaceId))) {
            showFormError('ネットワーク区分を再選択してください', panel.querySelector('[name="address_space_id"]'));
            return;
        }
        const missingKey = fields.map(([key]) => key).find(key => requiredKeys.has(key) && !String(values[key]).trim());
        if (missingKey) {
            showFormError('必須項目を入力してください', panel.querySelector(`[name="${missingKey}"]`));
            return;
        }
        if (segment && !cidrDetails(values.cidr)) {
            showFormError('有効なIPv4 CIDRを入力してください。', cidrInput);
            return;
        }
        formError.textContent = ''; formError.hidden = true;
        const payload = { ...values, ...(existing ? { id: Number(existing.id) } : {}) };
        if (segment) { payload.vlan_id = payload.vlan_id === '' ? null : Number(payload.vlan_id); payload.cidr = cidrDetails(payload.cidr).normalized; }
        if (network) {
            void mutate('create_ip_network', { name: payload.name, memo: payload.memo, ping_reachability: payload.ping_reachability, segment: { name: payload.segment_name, cidr: payload.cidr, purpose: payload.purpose, facility: payload.facility, vlan_id: payload.vlan_id, memo: payload.segment_memo } });
        } else {
            if (segment) payload.address_space_id = Number(payload.address_space_id ?? spaceId);
            const affected = segment && existing ? records.filter(row => Number(row.segment_id) === Number(existing.id) &&
                (!segmentContains(payload, row.ip) || Number(existing.address_space_id) !== payload.address_space_id)).length : 0;
            void mutate(
                segment ? 'save_ip_segment' : 'save_address_space',
                payload,
                existing ? {
                    title: '設定変更の確認',
                    messageText: `設定を変更しますか？${segment ? ` 所属を再確認する登録は${affected}件です。範囲外のIPは未分類になります。` : ''}`,
                    confirmLabel: '保存',
                    cancelLabel: 'キャンセル'
                } : null
            );
        }
    });
    const actions = node('div', null, 'ip-management-actions');
    if (existing && !form.unavailable) {
        const remove = button('削除', () => {
            const children = !segment ? appState.ipSegments.filter(row => Number(row.address_space_id) === Number(existing.id)) : [];
            if (children.length) { showFormError(`配下に${children.length}件のセグメントがあります。先に削除してください。`); message(`配下に${children.length}件のセグメントがあります。先に削除してください。`, 'warning'); return; }
            const affected = segment ? records.filter(row => Number(row.segment_id) === Number(existing.id)).length : 0;
            void mutate(
                segment ? 'delete_ip_segment' : 'delete_address_space',
                { id: Number(existing.id) },
                {
                    title: '削除の確認',
                    messageText: `「${existing.name || existing.cidr}」を削除しますか？${segment ? ` ${affected}件のIPの所属は未分類になります。IP・機器は削除しません。` : ''}`,
                    confirmLabel: '削除',
                    cancelLabel: 'キャンセル',
                    danger: true
                }
            );
        }, actions, true);
        if (remove) { remove.classList.add('btn-danger', 'ip-management-delete'); }
    }
    const cancel = button('キャンセル', async () => { if (await confirmDiscard()) { form = null; render(); } }, actions);
    cancel.classList.add('btn-cancel');
    const submit = node('button', existing ? '保存' : '登録', 'btn btn-primary btn-sm');
    submit.type = 'submit';
    submit.dataset.write = 'true';
    submit.dataset.unavailable = String(Boolean(form.unavailable) || Object.keys(form.conflicts || {}).length > 0);
    actions.appendChild(submit);
    panel.append(actions, formError);
    parent.appendChild(panel);
}

function renderPagingControls(parent, currentPage, totalPages, summaryText) {
    const paging = node('div', null, 'ip-management-controls ip-management-paging');
    if (totalPages <= 1) {
        paging.appendChild(node('span', summaryText, 'ip-management-paging-summary'));
        parent.appendChild(paging);
        return;
    }
    const previous = button('前の50件', () => { page--; renderResultsWithFocus('[aria-label="表示ページ"]'); }, paging);
    previous.dataset.unavailable = String(currentPage === 0);
    previous.disabled = busy || currentPage === 0;
    paging.appendChild(node('span', summaryText, 'ip-management-paging-summary'));
    const next = button('次の50件', () => { page++; renderResultsWithFocus('[aria-label="表示ページ"]'); }, paging);
    next.dataset.unavailable = String(currentPage + 1 >= totalPages);
    next.disabled = busy || currentPage + 1 >= totalPages;
    const jump = node('input');
    jump.type = 'number';
    jump.min = '1';
    jump.max = String(Math.max(1, totalPages));
    jump.value = String(currentPage + 1);
    jump.setAttribute('aria-label', '表示ページ');
    paging.appendChild(jump);
    button('ページへ移動', () => { page = Number(jump.value) - 1; renderResultsWithFocus('[aria-label="表示ページ"]'); }, paging);
    parent.appendChild(paging);
}

function buildReclassifyConfirmation(entries, hiddenCount) {
    const list = node('ul', null, 'ip-management-confirm-list');
    for (const { row, segment } of entries) {
        const kindLabel = row.kind === 'management' ? '管理IP' : `追加IP${row.label ? ': ' + row.label : ''}`;
        list.appendChild(node('li', `${row.ip} / ${row.device_name || '名称未設定'}（機器ID ${row.device_id}・${kindLabel}） → ${segmentLabel(segment, appState.addressSpaces)}`));
    }
    return {
        title: '再分類の確認',
        messageText: `現在表示中のページで選択した登録 ${entries.length}件を再分類しますか？ 非表示の選択 ${hiddenCount}件は変更しません。`,
        detailsNode: list,
        confirmLabel: '再分類を実行',
        cancelLabel: 'キャンセル'
    };
}

function reclassification(parent) {
    const highlightedRecord = targetRecord();
    const pageData = unclassifiedIpPage(records, appState.ipSegments, page, {
        query, candidateFilter,
        targetKey: highlightedRecord ? keyOf(highlightedRecord) : null
    });
    page = pageData.page;
    const selected = pageData.rows.filter(({ row }) => membershipSelections.has(keyOf(row)));
    const hiddenCount = membershipSelections.size - selected.length;
    const currentSelection = selected.every(({ row, candidates }) => {
        const before = membershipSelections.get(keyOf(row));
        return before.ip === row.ip && before.segment_id === row.segment_id &&
            before.candidateSignature === JSON.stringify(candidates);
    });
    const allUnique = selected.length > 0 && selected.every(item => item.candidates.length === 1);
    const commonCandidates = selected.length ? selected[0].candidates.filter(segment =>
        selected.every(item => item.candidates.some(candidate => Number(candidate.id) === Number(segment.id)))) : [];
    const save = mode => {
        if (!selected.length || !currentSelection || busy || !admin()) return;
        const destination = commonCandidates.find(segment => String(segment.id) === membershipDestination);
        if (mode === 'unique' ? !allUnique : !destination) return;
        const entries = selected.map(({ row, candidates }) => ({
            row, segment: mode === 'unique' ? candidates[0] : destination
        }));
        void mutate('reclassify_ips', {
            records: entries.map(({ row, segment }) => ({
                device_id: row.device_id, kind: row.kind, id: row.id, segment_id: Number(segment.id)
            }))
        }, buildReclassifyConfirmation(entries, hiddenCount));
    };

    const operations = content.querySelector('.ip-management-reclassify-panel');
    operations.replaceChildren();
    const panel = node('div', null, 'ip-management-membership-control');
    panel.appendChild(node('h4', '再分類操作'));
    panel.appendChild(node('p',
        `未分類全体の候補: 一意 ${pageData.summary.unique}件 / 複数 ${pageData.summary.multiple}件 / なし ${pageData.summary.none}件`,
        'form-support ip-management-candidate-summary'));
    operations.appendChild(panel);
    if (admin()) {
        const summary = node('div', null, 'ip-management-membership-summary');
        const counts = node('span', '選択中 ', 'ip-management-selection-count');
        const count = node('output', String(selected.length));
        count.setAttribute('aria-label', 'このページの選択件数');
        counts.append(count, node('span', '件'));
        summary.appendChild(counts);
        const clear = button('選択をすべて解除', () => {
            membershipSelections.clear(); membershipDestination = '';
            renderResultsWithFocus('[aria-label="現在のページを全選択"]');
        }, summary, true);
        clear.dataset.unavailable = String(!membershipSelections.size);
        panel.append(summary, node('p', '現在のページで選択したIPだけを変更します。', 'form-support ip-management-selection-scope'));
        if (hiddenCount) {
            const hidden = node('p', `ほかに${hiddenCount}件選択中（今回は変更しない）`, 'ip-management-hidden-selection');
            hidden.dataset.count = String(hiddenCount);
            panel.appendChild(hidden);
        }
        const automatic = node('div', null, 'ip-management-reclassify-operation');
        const uniqueBtn = button('一意候補で自動再分類', () => save('unique'), automatic, true);
        uniqueBtn.classList.add('ip-management-auto-reclassify-btn');
        uniqueBtn.dataset.unavailable = String(!allUnique || !currentSelection);
        const autoReason = node('p', !currentSelection
            ? '登録または候補が変更されています。選択を解除して選び直してください。'
            : '複数候補の登録を含むため自動再分類できません。指定先を選ぶか、選択を見直してください。',
        'form-support ip-management-auto-reclassify-reason');
        autoReason.hidden = !selected.length || (allUnique && currentSelection);
        automatic.appendChild(autoReason);
        panel.appendChild(automatic);

        const specified = node('div', null, 'ip-management-membership-actions ip-management-reclassify-operation');
        const label = node('label', '再分類先', 'ip-management-membership-label');
        const select = node('select', null, 'ip-management-membership-select');
        select.dataset.write = 'true';
        select.setAttribute('aria-label', '再分類先');
        const placeholder = node('option', '再分類先を選択'); placeholder.value = '';
        select.appendChild(placeholder);
        for (const segment of commonCandidates) {
            const option = node('option', segmentLabel(segment, appState.addressSpaces));
            option.value = String(segment.id); select.appendChild(option);
        }
        if (membershipDestination && !commonCandidates.some(segment => String(segment.id) === membershipDestination)) {
            const invalid = node('option', '選択済みの移動先は現在の対象では無効です');
            invalid.value = membershipDestination; invalid.disabled = true; select.appendChild(invalid);
        }
        select.value = membershipDestination;
        select.addEventListener('change', () => {
            membershipDestination = select.value;
            renderResultsWithFocus('.ip-management-membership-select');
        });
        label.appendChild(select);
        specified.appendChild(label);
        const valid = currentSelection && commonCandidates.some(segment => String(segment.id) === membershipDestination);
        const move = button('指定先へ再分類', () => save('specified'), specified, true, true);
        move.classList.add('ip-management-membership-btn');
        move.dataset.unavailable = String(!valid);
        const noCommon = node('p', '選択した登録すべてに共通する候補がありません。選択を見直してください。',
            'form-support ip-management-membership-candidates');
        noCommon.hidden = !selected.length || commonCandidates.length > 0;
        specified.appendChild(noCommon);
        panel.appendChild(specified);
    }

    statistics(parent, pageData.filtered.map(item => item.row));
    const filteredLabel = (query.trim() || candidateFilter) ? '絞り込み一致 ' : '未分類 ';
    renderPagingControls(parent, page, pageData.pages, `${pageData.total ? page + 1 : 0} / ${pageData.pages}ページ（${filteredLabel}${pageData.total}件）`);
    const table = node('table', null, 'ledger-sheet-table ip-management-table ip-management-unclassified-table');
    const columns = node('colgroup');
    for (const name of ['selection', 'ip', 'devices', 'candidates']) columns.appendChild(node('col', null, `ip-management-col-${name}`));
    table.appendChild(columns);
    const thead = node('thead'), heading = node('tr');
    for (const title of ['選択', 'IPアドレス', '登録機器', '候補状態']) {
        const th = node('th', title === '選択' ? null : title);
        th.setAttribute('scope', 'col');
        if (title === '選択') th.setAttribute('aria-label', title);
        heading.appendChild(th);
    }
    if (admin()) {
        const eligible = pageData.rows.filter(item => item.candidates.length > 0);
        const all = node('input');
        all.type = 'checkbox'; all.dataset.write = 'true';
        all.setAttribute('aria-label', '現在のページを全選択');
        all.checked = eligible.length > 0 && eligible.every(item => membershipSelections.has(keyOf(item.row)));
        all.indeterminate = !all.checked && eligible.some(item => membershipSelections.has(keyOf(item.row)));
        all.dataset.unavailable = String(!eligible.length);
        all.addEventListener('change', () => {
            for (const { row, candidates } of eligible) {
                if (all.checked) membershipSelections.set(keyOf(row), { ...row, candidateSignature: JSON.stringify(candidates) });
                else membershipSelections.delete(keyOf(row));
            }
            renderResultsWithFocus('[aria-label="現在のページを全選択"]');
        });
        heading.querySelector('th').appendChild(all);
    }
    thead.appendChild(heading);
    const tbody = node('tbody');
    table.append(thead, tbody);
    for (const { row, candidates } of pageData.rows) {
        const entry = node('tr', null, 'ip-management-record');
        entry.dataset.recordKey = keyOf(row);
        const selectionCell = node('td', null, 'ip-management-selection-cell');
        if (admin()) {
            const checkbox = node('input');
            checkbox.type = 'checkbox'; checkbox.dataset.write = 'true';
            checkbox.dataset.membershipKey = keyOf(row);
            checkbox.setAttribute('aria-label', `${row.ip} 機器ID ${row.device_id} ${row.kind === 'management' ? '管理IP' : `追加IP ${row.label || ''}`}を選択`);
            checkbox.checked = membershipSelections.has(keyOf(row));
            checkbox.dataset.unavailable = String(!candidates.length);
            if (!candidates.length) checkbox.title = '該当するセグメントがないため再分類できません';
            checkbox.addEventListener('change', () => {
                if (!candidates.length) return;
                if (checkbox.checked) membershipSelections.set(keyOf(row), { ...row, candidateSignature: JSON.stringify(candidates) });
                else membershipSelections.delete(keyOf(row));
                renderResultsWithFocus(`[data-membership-key="${keyOf(row)}"]`);
            });
            selectionCell.appendChild(checkbox);
        }
        const ipCell = node('td', null, 'ip-management-ip-cell');
        ipCell.appendChild(node('span', row.ip, 'ip-management-ip-address ip-management-mono'));
        if (highlightedRecord === row) {
            entry.classList.add('ip-management-target');
            entry.tabIndex = -1;
            entry.setAttribute('aria-label', `診断対象のIP ${row.ip} ${row.device_name || `機器ID ${row.device_id}`}`);
            ipCell.appendChild(node('span', '診断対象', 'ip-management-target-label'));
        }
        const devicesCell = node('td', null, 'ip-management-devices-cell');
        deviceLinks(devicesCell, [row]);
        const candidateCell = node('td', candidates.length === 1 ? '一意' : candidates.length ? `複数（${candidates.length}）` : '候補なし',
            'ip-management-candidate-cell');
        if (!candidates.length) {
            candidateCell.appendChild(node('small', '該当するセグメントがありません'));
        }
        entry.append(selectionCell, ipCell, devicesCell, candidateCell);
        tbody.appendChild(entry);
    }
    const scroller = node('div', null, 'ip-management-table-scroll ip-management-unclassified-scroll');
    scroller.setAttribute('role', 'region');
    scroller.setAttribute('aria-label', '未分類IP一覧');
    scroller.tabIndex = 0;
    scroller.appendChild(table);
    parent.appendChild(scroller);
    if (!pageData.rows.length) {
        parent.appendChild(node('p', (query.trim() || candidateFilter) ? '条件に一致する未分類IPはありません。' : '該当する未分類IPはありません。'));
    }
}

function membershipCandidates(rows) {
    if (!rows.length) return [];
    return appState.ipSegments.filter(segment => rows.every(row =>
        Number(segment.id) !== Number(row.segment_id) && segmentContains(segment, row.ip)));
}

function confirmAndMoveMembership(rows) {
    if (!rows.length || !membershipDestination || busy || !admin()) return;
    if (rows.some(row => {
        const before = membershipSelections.get(keyOf(row));
        return !before || before.ip !== row.ip || before.segment_id !== row.segment_id;
    })) {
        message('選択した登録が変更されています。選択を解除して選び直してください。', 'warning');
        return;
    }
    const toSegment = membershipCandidates(rows).find(segment => String(segment.id) === membershipDestination);
    if (membershipDestination !== 'unclassified' && !toSegment) {
        message('選択したすべてのIPに共通する移動先を選んでください。', 'warning');
        return;
    }
    const unclassify = membershipDestination === 'unclassified';
    const hasUnclassifiedDuplicate = unclassify && rows.some(row =>
        records.some(other => other.ip === row.ip && Number(other.device_id) !== Number(row.device_id)));
    const toLabel = toSegment ? segmentLabel(toSegment, appState.addressSpaces) : '未分類';
    const detailsNode = node('div', null, 'ip-management-transfer-details');
    for (const row of rows) {
        const fromSegment = appState.ipSegments.find(segment => Number(segment.id) === Number(row.segment_id));
        const kindLabel = row.kind === 'management' ? '管理IP' : `追加IP${row.label ? ': ' + row.label : ''}`;
        detailsNode.appendChild(node('p', `${row.ip} / ${row.device_name || '名称未設定'}（機器ID ${row.device_id}・${kindLabel}）`, 'ip-management-transfer-target'));
        const flow = node('div', null, 'ip-management-transfer-flow');
        const fromBox = node('div', null, 'ip-management-transfer-box is-from');
        fromBox.append(node('span', '変更元', 'ip-management-transfer-badge'),
            node('strong', fromSegment ? segmentLabel(fromSegment, appState.addressSpaces) : '未分類'));
        const arrow = node('span', '→', 'ip-management-transfer-arrow');
        arrow.setAttribute('aria-hidden', 'true');
        const toBox = node('div', null, 'ip-management-transfer-box is-to');
        toBox.append(node('span', '変更先', 'ip-management-transfer-badge'), node('strong', toLabel));
        flow.append(fromBox, arrow, toBox);
        detailsNode.appendChild(flow);
    }
    if (unclassify) detailsNode.appendChild(node('p',
        '機器・IP登録は残り、所属だけ未分類になります。既存の未分類IP再分類から再割当できます。台帳未登録にはなりません。',
        'ip-management-transfer-warning'));
    if (hasUnclassifiedDuplicate) detailsNode.appendChild(node('p',
        '他の機器と同じIPがあります。ネットワークの分離を確認してください。', 'ip-management-transfer-warning'));
    void mutate('reclassify_ips', {
        records: rows.map(row => ({
            device_id: Number(row.device_id), kind: row.kind,
            id: row.id == null ? null : Number(row.id),
            from_segment_id: row.segment_id == null ? null : Number(row.segment_id),
            segment_id: toSegment ? Number(toSegment.id) : null
        })),
        ...(hasUnclassifiedDuplicate ? { ip_conflicts_confirmed: true } : {})
    }, {
        title: '所属変更の確認',
        messageText: `現在表示中のページで選択した登録 ${rows.length}件を変更しますか？ 非表示の選択 ${membershipSelections.size - rows.length}件は変更しません。`,
        detailsNode, confirmLabel: '所属を変更', cancelLabel: 'キャンセル'
    });
}

function renderResultsWithFocus(selector) {
    const scrollTop = content?.querySelector('.ip-management-table-scroll')?.scrollTop || 0;
    renderResults();
    content?.querySelector(selector)?.focus({ preventScroll: true });
    const scroller = content?.querySelector('.ip-management-table-scroll');
    if (scroller) scroller.scrollTop = scrollTop;
}

function renderMembershipControls(parent, visibleRows) {
    if (!admin()) return;
    const selected = visibleRows.filter(row => membershipSelections.has(keyOf(row)));
    const wrap = node('div', null, 'ip-management-membership-control');
    wrap.appendChild(node('h4', '所属変更'));
    const summary = node('div', null, 'ip-management-membership-summary');
    const counts = node('span', '選択中 ', 'ip-management-selection-count');
    const count = node('output', String(selected.length));
    count.setAttribute('aria-label', 'このページの選択件数');
    counts.append(count, node('span', '件'));
    summary.appendChild(counts);
    const hiddenCount = membershipSelections.size - selected.length;
    const hiddenSelection = node('p', hiddenCount ? `ほかに${hiddenCount}件選択中（今回は変更しない）` : '', 'ip-management-hidden-selection');
    hiddenSelection.dataset.count = String(hiddenCount);
    hiddenSelection.hidden = hiddenCount === 0;
    const scope = node('p', '現在のページで選択したIPだけを変更します。', 'ip-management-selection-scope');
    scope.id = 'ip-management-selection-scope';
    wrap.append(summary, scope, hiddenSelection);
    const actions = node('div', null, 'ip-management-membership-actions');
    const label = node('label', '所属変更先', 'ip-management-membership-label');
    const select = node('select', null, 'ip-management-membership-select');
    select.dataset.write = 'true';
    select.setAttribute('aria-label', '所属変更先');
    select.setAttribute('aria-describedby', scope.id);
    const placeholder = node('option', '所属変更先を選択');
    placeholder.value = '';
    select.appendChild(placeholder);
    const candidates = membershipCandidates(selected);
    for (const segment of candidates) {
        const option = node('option', segmentLabel(segment, appState.addressSpaces));
        option.value = String(segment.id); select.appendChild(option);
    }
    const unclassified = node('option', '未分類に戻す');
    unclassified.value = 'unclassified'; select.appendChild(unclassified);
    if (membershipDestination && membershipDestination !== 'unclassified' &&
        !candidates.some(segment => String(segment.id) === membershipDestination)) {
        const invalid = node('option', '選択済みの移動先は現在の対象では無効です');
        invalid.value = membershipDestination; invalid.disabled = true; select.appendChild(invalid);
    }
    select.value = membershipDestination;
    select.addEventListener('change', () => {
        membershipDestination = select.value;
        renderResultsWithFocus('.ip-management-membership-select');
    });
    label.appendChild(select);
    actions.appendChild(label);
    const valid = selected.length > 0 && (membershipDestination === 'unclassified' ||
        candidates.some(segment => String(segment.id) === membershipDestination));
    const move = button('変更', () => confirmAndMoveMembership(selected), actions, true, true);
    move.classList.add('ip-management-membership-btn'); move.dataset.unavailable = String(!valid);
    wrap.appendChild(actions);
    const noCandidates = node('p',
        '選択したIPを含む共通の変更先はありません。未分類に戻すことはできます。', 'form-support ip-management-membership-candidates');
    noCandidates.hidden = !selected.length || candidates.length > 0;
    wrap.append(noCandidates, node('p', '複数のIPを選択して、一括で所属を変更できます。選択はページ移動・検索後も保持されます。', 'form-support ip-management-membership-help'));
    parent.appendChild(wrap);
}

function createSearchInput(placeholder) {
    const input = node('input', null, 'ip-management-search');
    input.type = 'search';
    input.value = query;
    input.placeholder = placeholder;
    input.setAttribute('aria-label', placeholder);
    let composing = false;
    input.addEventListener('compositionstart', () => { composing = true; });
    input.addEventListener('compositionend', () => {
        if (!composing) return;
        composing = false;
        query = input.value;
        page = 0;
        highlightedIp = '';
        renderResults();
    });
    input.addEventListener('input', event => {
        if (composing || event.isComposing) return;
        query = input.value;
        page = 0;
        highlightedIp = '';
        renderResults();
    });
    return input;
}

function render() {
    if (!content) return;
    if (loaded && !form) {
        const navNotice = reconcileNavigationState();
        if (navNotice && !status?.textContent) message(navNotice, 'info');
    }
    content.replaceChildren();

    const space = appState.addressSpaces?.find(row => Number(row.id) === Number(spaceId));
    const segment = appState.ipSegments?.find(row => Number(row.id) === Number(segmentId));
    const isSegmentDetail = Boolean(!form && segmentId !== null && segment);
    overlay.querySelector('.ip-management-dialog').classList.toggle('is-segment-detail', isSegmentDetail);
    overlay.querySelector('.ip-management-dialog').classList.toggle('is-fixed-height', isSegmentDetail);
    const spaceTitle = space?.name || (form?.kind === 'space' ? form.existing?.name : null) || 'ネットワーク区分';
    const segmentTitle = segment?.name || segment?.cidr || (form?.kind === 'segment' ? form.existing?.name || form.existing?.cidr : null) || 'セグメント';

    const breadcrumb = node('nav', null, 'ip-management-breadcrumb');
    breadcrumb.setAttribute('aria-label', '現在位置');
    breadcrumb.appendChild(node('span', '現在位置: ', 'ip-management-breadcrumb-prefix'));
    const crumb = (title, action = null) => {
        if (action) {
            const linkBtn = button(title, action, breadcrumb);
            linkBtn.className = 'ip-management-breadcrumb-link';
        } else {
            const current = node('span', title, 'ip-management-breadcrumb-current');
            current.setAttribute('aria-current', 'page');
            breadcrumb.appendChild(current);
        }
    };
    crumb('ネットワーク区分一覧', spaceId !== null ? () => void go() : null);
    if (spaceId !== null) {
        breadcrumb.appendChild(node('span', ' › ', 'ip-management-breadcrumb-separator'));
        crumb(spaceId === '' ? '未分類' : spaceTitle, segmentId !== null ? () => void go(spaceId) : null);
    }
    if (segmentId !== null) {
        breadcrumb.appendChild(node('span', ' › ', 'ip-management-breadcrumb-separator'));
        crumb(segmentTitle);
    }
    content.appendChild(breadcrumb);

    if (form) { masterForm(content); disableControls(); return; }

    if (segmentId !== null && segment) {
        const segmentRows = records.filter(row => Number(row.segment_id) === Number(segment.id));
        const overview = node('section', null, 'ip-management-segment-overview');
        const header = node('div', null, 'ip-management-section-header');
        const headingGroup = node('div', null, 'ip-management-heading-group');
        if (segment.name) headingGroup.appendChild(node('h3', segment.name));
        headingGroup.appendChild(node('span', segment.cidr, 'ip-management-cidr-badge ip-management-mono'));
        header.appendChild(headingGroup);
        button('セグメントを編集', () => void editMaster('segment', segment), header, true);
        const details = node('div', null, 'ip-management-overview-details');
        details.id = 'ip-management-overview-details';
        details.hidden = true;
        const toggle = button('⌄', () => {
            details.hidden = !details.hidden;
            toggle.textContent = details.hidden ? '⌄' : '⌃';
            toggle.setAttribute('aria-expanded', String(!details.hidden));
            toggle.setAttribute('aria-label', details.hidden ? 'CIDR詳細を展開' : 'CIDR詳細を折りたたむ');
        }, header);
        toggle.classList.add('ip-management-overview-toggle');
        toggle.setAttribute('aria-expanded', 'false');
        toggle.setAttribute('aria-label', 'CIDR詳細を展開');
        toggle.setAttribute('aria-controls', details.id);
        const metaText = [segment.vlan_id == null ? '' : `VLAN ${segment.vlan_id}`, segment.purpose, segment.facility].filter(Boolean).join(' / ');
        if (metaText) details.appendChild(node('p', metaText, 'ip-management-segment-meta'));
        if (segment.memo) details.appendChild(node('p', segment.memo, 'ip-management-description'));
        segmentOverview(details, segment, segmentRows);
        overview.append(header, details);
        content.appendChild(overview);
        const workspace = node('div', null, 'ip-management-workspace');
        const listPanel = node('section', null, 'ip-management-list-panel');
        const membershipPanel = node('aside', null, 'ip-management-membership-panel');
        membershipPanel.setAttribute('aria-label', '所属変更');
        membershipPanel.hidden = !admin();
        if (!admin()) workspace.classList.add('is-readonly');
        workspace.append(listPanel, membershipPanel);
        content.appendChild(workspace);

        const listHeader = node('div', null, 'ip-management-section-header ip-management-list-heading');
        listHeader.appendChild(node('h4', 'IPアドレス一覧'));
        listPanel.appendChild(listHeader);

        const filterBar = node('div', null, 'ip-management-filter-bar');
        searchInput = createSearchInput('IP・機器名・機器ID・ラベルを検索');
        const label = node('label', '台帳未登録IPも表示', 'ip-management-checkbox-label');
        const checkbox = node('input');
        checkbox.type = 'checkbox';
        checkbox.checked = includeUnregistered;
        checkbox.addEventListener('change', () => { includeUnregistered = checkbox.checked; page = 0; renderResults(); });
        label.prepend(checkbox);
        filterBar.append(searchInput, label);
        listPanel.append(filterBar, node('div', null, 'ip-management-results'));
        renderResults();
        disableControls();
        return;
    } else {
        let sectionParent = content;
        if (spaceId === '') {
            const workspace = node('div', null, 'ip-management-workspace is-unclassified');
            sectionParent = node('section', null, 'ip-management-list-panel');
            const operations = node('aside', null, 'ip-management-membership-panel ip-management-reclassify-panel');
            operations.setAttribute('aria-label', '再分類操作');
            workspace.append(sectionParent, operations);
            content.appendChild(workspace);
        }
        const sectionHeader = node('div', null, 'ip-management-section-header');
        sectionHeader.appendChild(node(spaceId === '' ? 'h4' : 'h3', spaceId === null ? 'ネットワーク区分一覧' : spaceId === '' ? '未分類IP一覧' : spaceTitle));
        if (spaceId === null) button('ネットワークを登録', () => void editMaster('network'), sectionHeader, true, true);
        else if (spaceId !== '' && space) {
            const actions = node('div', null, 'ip-management-actions');
            button('ネットワーク区分を編集', () => void editMaster('space', space), actions, true);
            button('セグメントを追加', () => void editMaster('segment'), actions, true, true);
            sectionHeader.appendChild(actions);
        }
        sectionParent.appendChild(sectionHeader);
        if (spaceId !== null && spaceId !== '' && space?.memo) {
            content.appendChild(node('p', space.memo, 'ip-management-description'));
        }
        const filterBar = node('div', null, 'ip-management-filter-bar');
        searchInput = createSearchInput(
            spaceId === null ? 'ネットワーク区分名・メモを検索'
                : spaceId === '' ? 'IP・機器名・機器ID・用途ラベルを検索'
                : 'セグメント名・CIDR・VLAN・施設・用途を検索'
        );
        filterBar.appendChild(searchInput);
        if (spaceId === '') {
            const filterGroup = node('div', null, 'ip-management-candidate-filters');
            filterGroup.setAttribute('role', 'group');
            filterGroup.setAttribute('aria-label', '再分類候補の状態で絞り込み');
            const filterButtons = [];
            for (const [value, label] of [
                ['', 'すべての候補状態'],
                ['unique', '一意候補のみ'],
                ['multiple', '複数候補のみ'],
                ['none', '候補なしのみ']
            ]) {
                const filterBtn = button(label, () => {
                    candidateFilter = value;
                    page = 0;
                    for (const item of filterButtons) {
                        const active = item.dataset.candidateFilter === candidateFilter;
                        item.classList.toggle('is-active', active);
                        item.setAttribute('aria-pressed', String(active));
                    }
                    renderResults();
                }, filterGroup);
                filterBtn.className = `ip-management-filter-chip${candidateFilter === value ? ' is-active' : ''}`;
                filterBtn.dataset.candidateFilter = value;
                filterBtn.setAttribute('aria-pressed', String(candidateFilter === value));
                filterButtons.push(filterBtn);
            }
            filterBar.appendChild(filterGroup);
        }
        sectionParent.appendChild(filterBar);
        if (spaceId === '') {
            sectionParent.appendChild(node('div', null, 'ip-management-results'));
            renderResults();
            disableControls();
            return;
        }
    }

    content.appendChild(node('div', null, 'ip-management-results'));
    renderResults();
    disableControls();
}

function renderResults() {
    const parent = content?.querySelector('.ip-management-results');
    if (!parent) return;
    parent.replaceChildren();
    if (!loaded) { parent.appendChild(node('p', 'IPアドレス管理情報を読み込んでください。')); return; }
    const keyword = query.trim().toLocaleLowerCase();
    const matches = value => !keyword || String(value).toLocaleLowerCase().includes(keyword);

    if (spaceId === null) {
        const cards = node('div', null, 'ip-management-cards'); parent.appendChild(cards);
        for (const space of appState.addressSpaces) {
            const segments = appState.ipSegments.filter(row => Number(row.address_space_id) === Number(space.id));
            const rows = records.filter(row => row.segment_id != null && Number(row.address_space_id) === Number(space.id));
            if (!matches([space.name, space.memo].join(' '))) continue;
            const stats = ipStatistics(rows);
            const badges = [];
            const reachabilityTag = space.ping_reachability === 'reachable'
                ? { text: 'Ping到達：可能', tone: 'reachability-reachable' }
                : space.ping_reachability === 'unreachable'
                    ? { text: 'Ping到達：不可', tone: 'reachability-unreachable' }
                    : { text: 'Ping到達：未設定', tone: 'reachability-unset' };
            badges.push(reachabilityTag);
            if (stats.duplicates > 0) badges.push({ text: `要確認: 重複IP ${stats.duplicates}種類`, tone: 'warning' });
            navigationCard(
                cards,
                space.name,
                `${segments.length}セグメント / 登録IP ${rows.length}件`,
                space.memo,
                () => void go(String(space.id)),
                { kind: 'space', badges, warning: stats.duplicates > 0 }
            );
        }
        const unclassifiedRows = records.filter(row => row.segment_id == null);
        const unclassifiedStats = ipStatistics(unclassifiedRows);
        const unclassifiedBadges = [];
        if (unclassifiedRows.length > 0) unclassifiedBadges.push({ text: `要確認 ${unclassifiedRows.length}件`, tone: 'warning' });
        if (unclassifiedStats.duplicates > 0) unclassifiedBadges.push({ text: `重複IP ${unclassifiedStats.duplicates}種類`, tone: 'warning' });
        const unclassified = node('div', null, 'ip-management-unclassified');
        navigationCard(
            unclassified,
            '未分類IP',
            `登録IP ${unclassifiedRows.length}件`,
            'ネットワーク区分に所属していないIPを確認・再分類',
            () => void go(''),
            { kind: 'unclassified', badges: unclassifiedBadges, warning: unclassifiedRows.length > 0 }
        );
        parent.appendChild(unclassified);
        if (!appState.addressSpaces.length) parent.appendChild(node('p', 'ネットワークは未登録です。「ネットワークを登録」から区分と最初のセグメントを登録できます。'));
        disableControls();
        return;
    }

    if (spaceId === '') {
        reclassification(parent);
        if (focusTarget) {
            const entry = parent.querySelector('.ip-management-target');
            entry?.focus();
            entry?.scrollIntoView?.({ block: 'nearest' });
            focusTarget = false;
        }
        disableControls();
        return;
    }

    const space = appState.addressSpaces.find(row => Number(row.id) === Number(spaceId));
    if (!space) {
        const navNotice = reconcileNavigationState();
        if (navNotice) message(navNotice);
        render();
        return;
    }

    const segments = appState.ipSegments.filter(row => Number(row.address_space_id) === Number(spaceId));
    if (segmentId === null) {
        const cards = node('div', null, 'ip-management-cards'); parent.appendChild(cards);
        for (const segment of segments) {
            const rows = records.filter(row => Number(row.segment_id) === Number(segment.id));
            if (!matches([segment.name, segment.cidr, segment.purpose, segment.facility, segment.vlan_id].join(' '))) continue;
            const stats = segmentStatistics(segment, rows);
            const badges = [];
            if (stats.duplicates > 0) badges.push({ text: `要確認: 重複IP ${stats.duplicates}種類`, tone: 'warning' });
            navigationCard(
                cards,
                [segment.name, segment.cidr].filter(Boolean).join(' / '),
                [segment.vlan_id == null ? '' : `VLAN ${segment.vlan_id}`, segment.purpose, segment.facility, `登録IP ${rows.length}件`].filter(Boolean).join(' / '),
                segment.memo,
                () => void go(spaceId, Number(segment.id)),
                { kind: 'segment', badges, warning: stats.duplicates > 0 }
            );
        }
        if (!segments.length) parent.appendChild(node('p', 'セグメントは未登録です。「セグメントを追加」から登録できます。'));
        disableControls();
        return;
    }

    const segment = segments.find(row => Number(row.id) === Number(segmentId));
    if (!segment) {
        const navNotice = reconcileNavigationState();
        if (navNotice) message(navNotice, 'info');
        render();
        return;
    }

    const rows = records.filter(row => Number(row.segment_id) === Number(segment.id));
    const addressPage = segmentAddressPage(segment, rows, page, { includeUnregistered, query });
    page = addressPage.page;
    const summaryLabel = `${addressPage.total ? page + 1 : 0} / ${addressPage.pages}ページ（${keyword ? '検索一致 ' : includeUnregistered ? '全' : '登録済み '}${addressPage.total} IP）`;
    renderPagingControls(parent, page, addressPage.pages, summaryLabel);
    const visibleRows = addressPage.rows.flatMap(address => address.records);
    const membershipPanel = content.querySelector('.ip-management-membership-panel');
    if (membershipPanel) {
        membershipPanel.replaceChildren();
        renderMembershipControls(membershipPanel, visibleRows);
    }

    const exactIpPage = keyword && segmentContains(segment, keyword) ? segmentIpPageIndex(segment, keyword) : null;
    if (keyword && includeUnregistered) {
        const supportRow = node('div', null, 'ip-management-search-support');
        supportRow.appendChild(node('p', '検索中は全登録IP（および指定したCIDR内のIP）から一致するIPを表示します。', 'form-support'));
        if (exactIpPage !== null) {
            button(`前後のIP一覧（${exactIpPage + 1}ページ）へ移動`, () => {
                highlightedIp = keyword;
                query = '';
                if (searchInput) searchInput.value = '';
                includeUnregistered = true;
                const checkbox = content.querySelector('input[type="checkbox"]');
                if (checkbox) checkbox.checked = true;
                page = exactIpPage;
                renderResults();
            }, supportRow);
        }
        parent.appendChild(supportRow);
    } else if (exactIpPage !== null && !includeUnregistered) {
        const supportRow = node('div', null, 'ip-management-search-support');
        button(`台帳未登録IPを含めて前後のIP一覧（${exactIpPage + 1}ページ）へ移動`, () => {
            highlightedIp = keyword;
            query = '';
            if (searchInput) searchInput.value = '';
            includeUnregistered = true;
            const checkbox = content.querySelector('input[type="checkbox"]');
            if (checkbox) checkbox.checked = true;
            page = exactIpPage;
            renderResults();
        }, supportRow);
        parent.appendChild(supportRow);
    }

    if (!addressPage.total) {
        parent.appendChild(node('p', keyword ? '検索に一致する登録IPはありません。' : 'このセグメントに登録済みのIPはありません。台帳未登録IPも表示できます。'));
        disableControls();
        return;
    }

    const table = node('table', null, 'ledger-sheet-table ip-management-table');
    const columns = node('colgroup');
    for (const name of ['selection', 'ip', 'devices']) columns.appendChild(node('col', null, `ip-management-col-${name}`));
    table.appendChild(columns);
    const heading = node('tr');
    for (const title of ['選択', 'IPv4アドレス', '登録機器']) {
        const th = node('th', title === '選択' ? null : title);
        th.setAttribute('scope', 'col');
        if (title === '選択') th.setAttribute('aria-label', title);
        heading.appendChild(th);
    }
    const thead = node('thead');
    thead.appendChild(heading);
    const tbody = node('tbody');
    table.append(thead, tbody);
    if (admin()) {
        const all = node('input');
        all.type = 'checkbox'; all.dataset.write = 'true';
        all.setAttribute('aria-label', '現在のページを全選択');
        all.checked = visibleRows.length > 0 && visibleRows.every(row => membershipSelections.has(keyOf(row)));
        all.indeterminate = !all.checked && visibleRows.some(row => membershipSelections.has(keyOf(row)));
        all.dataset.unavailable = String(!visibleRows.length);
        all.addEventListener('change', () => {
            for (const row of visibleRows) {
                if (all.checked) membershipSelections.set(keyOf(row), { ...row });
                else membershipSelections.delete(keyOf(row));
            }
            renderResultsWithFocus('[aria-label="現在のページを全選択"]');
        });
        heading.querySelector('th').appendChild(all);
    }

    for (const address of addressPage.rows) {
        for (const row of address.records.length ? address.records : [null]) {
            const tr = node('tr');
            tr.dataset.ip = address.ip;
            const isHighlightedIp = (keyword && address.ip.toLocaleLowerCase() === keyword) || (highlightedIp && address.ip === highlightedIp);
            if (isHighlightedIp) tr.classList.add('ip-management-search-match');
            if (address.records.length > 1) tr.classList.add('ip-management-row-duplicate');
            if (row) tr.dataset.recordKey = keyOf(row);
            const selectionTd = node('td', null, 'ip-management-selection-cell');
            if (row && admin()) {
                const checkbox = node('input');
                checkbox.type = 'checkbox'; checkbox.dataset.write = 'true';
                checkbox.dataset.membershipKey = keyOf(row);
                checkbox.setAttribute('aria-label', `${row.ip} 機器ID ${row.device_id} ${row.kind === 'management' ? '管理IP' : `追加IP ${row.label || ''}`}を選択`);
                checkbox.checked = membershipSelections.has(keyOf(row));
                checkbox.addEventListener('change', () => {
                    if (checkbox.checked) membershipSelections.set(keyOf(row), { ...row });
                    else membershipSelections.delete(keyOf(row));
                    renderResultsWithFocus(`[data-membership-key="${keyOf(row)}"]`);
                });
                selectionTd.appendChild(checkbox);
            }
            tr.appendChild(selectionTd);

            const ipTd = node('td', null, 'ip-management-ip-cell');
            const ipWrap = node('div', null, 'ip-management-ip-wrap');
            ipWrap.appendChild(node('span', address.ip, 'ip-management-ip-address ip-management-mono'));
            if (address.records.length > 1) {
                ipWrap.appendChild(node('span', `重複・${address.records.length}件`, 'ip-management-status-badge is-duplicate'));
            }
            ipTd.appendChild(ipWrap);
            tr.appendChild(ipTd);

            const linksTd = node('td', null, 'ip-management-devices-cell');
            if (row) {
                deviceLinks(linksTd, [row]);
            } else {
                linksTd.appendChild(node('span', '台帳未登録', 'ip-management-status-badge is-unregistered'));
            }
            tr.appendChild(linksTd);
            tbody.appendChild(tr);
        }
    }
    const scroller = node('div', null, 'ip-management-table-scroll');
    scroller.setAttribute('role', 'region');
    scroller.setAttribute('aria-label', 'IPアドレス一覧');
    scroller.tabIndex = 0;
    scroller.appendChild(table);
    parent.appendChild(scroller);
    if (highlightedIp) {
        const matchedRow = table.querySelector('.ip-management-search-match');
        matchedRow?.scrollIntoView?.({ block: 'nearest' });
    }
    disableControls();
}

function hideIpManagement() {
    closeActiveConfirm(false);
    if (overlay) overlay.hidden = true;
    form = null; membershipSelections.clear();
    membershipDestination = '';
    registerModalClose('ip-management');
}

export function closeIpManagement() {
    if (busy) return false;
    if (!hasUnsavedInput()) {
        hideIpManagement();
        return true;
    }
    return confirmDiscard().then(confirmed => {
        if (!confirmed || busy) return false;
        hideIpManagement();
        return true;
    });
}

export async function openIpManagement(options = {}) {
    if (!overlay || overlay.ownerDocument !== document) {
        overlay = node('div', null, 'modal-overlay'); overlay.id = 'ip-management-overlay'; overlay.hidden = true;
        const dialog = node('section', null, 'modal-dialog ip-management-dialog');
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        dialog.setAttribute('aria-labelledby', 'ip-management-title');
        const header = node('div', null, 'modal-header'), title = node('h2', 'IPアドレス管理');
        title.id = 'ip-management-title';
        header.appendChild(title);
        const actions = node('div', null, 'ip-management-actions');
        refreshButton = button('', () => void refresh(), actions);
        refreshButton.classList.add('ip-management-refresh-btn');
        const refreshIcon = node('img', null, 'ip-management-refresh-icon');
        refreshIcon.src = 'assets/icons/app/refresh.svg';
        refreshIcon.width = 16;
        refreshIcon.height = 16;
        refreshIcon.alt = '';
        refreshIcon.setAttribute('aria-hidden', 'true');
        refreshButton.append(refreshIcon, node('span', '更新'));
        closeButton = button('×', () => void closeIpManagement(), actions);
        closeButton.className = 'modal-close-btn';
        closeButton.setAttribute('aria-label', '閉じる');
        header.appendChild(actions);
        content = node('div', null, 'modal-body');
        noticeBar = node('div', null, 'ip-management-notice is-info');
        noticeBar.hidden = true;
        status = node('span', '', 'ip-management-notice-text');
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        status.setAttribute('aria-atomic', 'true');
        recoveryButton = button('入力を保持して最新情報を取得', recoverInput, null, false);
        recoveryButton.classList.add('ip-management-recovery-btn');
        recoveryButton.dataset.recovery = 'true';
        recoveryButton.dataset.write = 'true';
        recoveryButton.hidden = true;
        noticeCloseButton = node('button', '×', 'ip-management-notice-close');
        noticeCloseButton.type = 'button';
        noticeCloseButton.setAttribute('aria-label', '通知を閉じる');
        noticeCloseButton.addEventListener('click', () => message(''));
        noticeBar.append(status, recoveryButton, noticeCloseButton);
        dialog.append(header, content, noticeBar);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
        overlay.addEventListener('click', event => { if (event.target === overlay) void closeIpManagement(); });
    }
    const alreadyOpen = !overlay.hidden;
    if (alreadyOpen && !options.target) return;
    if (busy || (alreadyOpen && !(await confirmDiscard()))) return;
    if (options.target) {
        target = { ...options.target, allowClassified: options.allowClassified === true }; targetReady = false; focusTarget = false;
        form = null; membershipSelections.clear();
        membershipDestination = '';
        spaceId = ''; segmentId = null; query = ''; candidateFilter = ''; page = 0; includeUnregistered = false; highlightedIp = '';
    } else {
        target = null; targetReady = false; focusTarget = false;
        form = null; membershipSelections.clear();
        membershipDestination = '';
        spaceId = options.unclassified ? '' : null; segmentId = null; query = ''; candidateFilter = ''; page = 0; includeUnregistered = false; highlightedIp = '';
        recoveryRequired = false;
    }
    overlay.hidden = false;
    render();
    if (!alreadyOpen) registerModalOpen('ip-management', overlay, options.target ? '.ip-management-target' : 'button', { onClose: closeIpManagement });
    await refresh(true);
}
