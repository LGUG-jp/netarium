import { appState } from '../core/state.js';
import { apiFetch } from '../core/api-client.js';
import { eventBus } from '../core/event-bus.js';
import { LINK_SYSTEM_COLORS, getLinkColor } from '../core/link-systems.js';
import { registerModalOpen, registerModalClose } from '../core/modal-focus.js';
import { isCurrentUserAdmin, requireAdminUiAction } from '../ui/access-control.js';
import { render } from '../canvas/renderer.js';
import { updateLengthFeedback } from '../ui/length-feedback.js';

let selected = null;
let lastSelectedId = null;
let baseline = { name: '', color_key: 'indigo' };
let draftColorKey = baseline.color_key;
let busy = false;
let generation = 0;
const element = name => document.getElementById(`link-systems-${name}`);
const values = () => ({ name: element('name').value.trim(), color_key: draftColorKey });
const dirty = () => JSON.stringify(values()) !== JSON.stringify(baseline);
const canDiscard = () => !dirty() || window.confirm('未確定の系統設定を破棄しますか？');

function setStatus(message, error = false) {
    element('status').textContent = message;
    element('status').classList.toggle('is-error', error);
}
function syncControls() {
    const readOnly = !isCurrentUserAdmin() || appState.authExpired;
    for (const option of element('color-options').children) option.disabled = busy || readOnly;
    for (const name of ['name', 'save', 'new']) element(name).disabled = busy || readOnly;
    element('refresh').disabled = busy;
    element('delete').hidden = !selected || readOnly;
    element('delete').disabled = busy || readOnly || Number(selected?.usage_count) > 0;
    element('delete').title = Number(selected?.usage_count) > 0 ? '使用中の系統は削除できません' : '';
    element('save').hidden = readOnly;
    element('cancel').hidden = Boolean(selected) || readOnly;
    element('cancel').disabled = busy || readOnly;
    element('actions').hidden = readOnly;
}
function selectSystem(system) {
    selected = system ? { ...system } : null;
    baseline = { name: system?.name || '', color_key: system?.color_key || 'indigo' };
    element('name').value = baseline.name;
    updateLengthFeedback(element('name'));
    draftColorKey = baseline.color_key;
    element('form-title').textContent = system ? '系統の設定' : '系統の新規作成';
    element('save').textContent = system ? '適用' : '登録';
    syncColor();
    syncControls();
}
function syncColor() {
    for (const option of element('color-options').children) {
        const checked = option.value === draftColorKey;
        option.setAttribute('aria-checked', String(checked));
        option.setAttribute('tabindex', checked ? '0' : '-1');
    }
}
function initializeColorOptions() {
    const options = element('color-options');
    options.replaceChildren();
    for (const color of LINK_SYSTEM_COLORS) {
        const option = document.createElement('button');
        option.id = `link-systems-color-option-${color.key}`;
        option.type = 'button';
        option.className = 'btn btn-secondary btn-sm link-systems-color-option';
        option.value = color.key;
        option.setAttribute('role', 'radio');
        const swatch = document.createElement('span');
        swatch.className = 'link-system-swatch';
        swatch.setAttribute('aria-hidden', 'true');
        swatch.style.backgroundColor = `var(--link-system-${color.key}, ${color.color})`;
        const name = document.createElement('span');
        name.className = 'link-systems-color-name';
        name.textContent = color.name;
        option.append(swatch, name);
        const choose = () => {
            if (option.disabled || busy || !isCurrentUserAdmin() || appState.authExpired) return;
            draftColorKey = color.key;
            syncColor();
        };
        option.addEventListener('click', choose);
        option.addEventListener('keydown', event => {
            if (event.isComposing || option.disabled || busy || !isCurrentUserAdmin() || appState.authExpired) return;
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                choose();
                return;
            }
            const delta = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 2, ArrowUp: -2 }[event.key];
            if (delta == null && !['Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const buttons = [...options.children];
            const index = buttons.indexOf(option);
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
                : (index + delta + buttons.length) % buttons.length;
            draftColorKey = buttons[next].value;
            syncColor();
            buttons[next].focus();
        });
        options.appendChild(option);
    }
}
function renderList() {
    const list = element('list');
    list.replaceChildren();
    if (!appState.linkSystems.length) {
        const empty = document.createElement('p');
        empty.textContent = '接続系統は登録されていません。';
        list.appendChild(empty);
    }
    for (const system of appState.linkSystems) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'link-systems-row';
        button.id = `link-systems-row-${system.id}`;
        button.disabled = busy;
        const isSelected = Number(selected?.id) === Number(system.id);
        button.setAttribute('aria-pressed', String(isSelected));
        const swatch = document.createElement('span');
        swatch.className = 'link-system-swatch';
        swatch.setAttribute('aria-hidden', 'true');
        swatch.style.backgroundColor = getLinkColor({ system_id: system.id });
        const name = document.createElement('span');
        name.className = 'link-systems-row-name';
        name.textContent = system.name;
        const usage = document.createElement('span');
        usage.className = 'link-systems-row-usage';
        usage.textContent = `${Number(system.usage_count) || 0}件`;
        const marker = document.createElement('span');
        marker.className = 'link-systems-row-marker';
        marker.setAttribute('aria-hidden', 'true');
        marker.textContent = '✓';
        button.append(swatch, name, usage, marker);
        button.addEventListener('click', () => {
            if (busy || !canDiscard()) return;
            selectSystem(system);
            setStatus('');
            renderList();
            document.getElementById(button.id)?.focus();
        });
        list.appendChild(button);
    }
}
function acceptSystems(data) {
    if (!Array.isArray(data.link_systems)) throw new Error('接続系統の応答が不完全です。再読込してください');
    appState.linkSystems = data.link_systems;
    if (Number.isSafeInteger(data.revision) && data.revision > 0) appState.dataRevision = data.revision;
    eventBus.emit('link-systems:changed');
    render();
}
async function refresh(selectFirst = false) {
    if (busy || !canDiscard()) return;
    busy = true;
    const requestGeneration = ++generation;
    syncControls();
    try {
        const data = await apiFetch('list_link_systems');
        if (requestGeneration !== generation) return;
        const previousId = selected?.id;
        acceptSystems(data);
        selectSystem(appState.linkSystems.find(row => Number(row.id) === Number(previousId))
            || (selectFirst ? appState.linkSystems[0] : null) || null);
        setStatus('');
    } catch (error) {
        if (requestGeneration === generation) setStatus(error.message, true);
    } finally {
        if (requestGeneration === generation) {
            busy = false;
            syncControls();
            renderList();
        }
    }
}
export async function openLinkSystems() {
    const overlay = element('overlay');
    if (!overlay || !overlay.hidden) return;
    lastSelectedId = null;
    selectSystem(null);
    renderList();
    overlay.hidden = false;
    registerModalOpen('link-systems', overlay, '#link-systems-refresh', { onClose: closeLinkSystems });
    await refresh(true);
}
export function closeLinkSystems() {
    if (busy || !canDiscard()) return false;
    generation++;
    element('overlay').hidden = true;
    registerModalClose('link-systems');
    return true;
}
async function mutate(action, deleting = false) {
    if (busy || !requireAdminUiAction() || appState.authExpired) return false;
    const input = values();
    if (!deleting && !updateLengthFeedback(element('name'))) {
        element('name').focus();
        return false;
    }
    if (!deleting && (!input.name || [...input.name].length > 100 || !LINK_SYSTEM_COLORS.some(color => color.key === input.color_key))) {
        setStatus('名称は1〜100文字で入力し、用意された色を選択してください。', true);
        element('name').focus();
        return false;
    }
    if (deleting && (!selected || Number(selected.usage_count) > 0)) {
        setStatus('使用中の系統は削除できません。', true);
        return false;
    }
    if (deleting && !window.confirm(`「${selected.name}」を削除しますか？`)) return false;
    const payload = selected ? { id: Number(selected.id), expected_revision: Number(selected.resource_revision) } : {};
    if (!deleting) Object.assign(payload, input);
    busy = true;
    syncControls();
    renderList();
    try {
        const data = await apiFetch(action, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
        });
        acceptSystems(data);
        const selectedId = selected?.id ?? data.created_id;
        selectSystem(deleting ? null : appState.linkSystems.find(row => Number(row.id) === Number(selectedId)) || null);
        setStatus('');
        return true;
    } catch (error) {
        setStatus(error.status === 409 ? `${error.message} 入力を保持しています。「再読込」で最新の設定を確認してください。` : error.message, true);
        return false;
    } finally {
        busy = false;
        syncControls();
        renderList();
    }
}
export function initializeLinkSystemsModal() {
    const overlay = element('overlay');
    if (!overlay) return;
    initializeColorOptions();
    element('form').addEventListener('submit', event => {
        event.preventDefault();
        void mutate(selected ? 'update_link_system' : 'create_link_system');
    });
    element('delete').addEventListener('click', () => void mutate('delete_link_system', true));
    element('new').addEventListener('click', () => {
        if (busy || !isCurrentUserAdmin() || appState.authExpired || !canDiscard()) return;
        if (selected) lastSelectedId = selected.id;
        selectSystem(null);
        setStatus('');
        renderList();
        element('name').focus();
    });
    element('cancel').addEventListener('click', () => {
        if (busy || selected || !isCurrentUserAdmin() || appState.authExpired || !canDiscard()) return;
        const previous = appState.linkSystems.find(row => Number(row.id) === Number(lastSelectedId))
            || appState.linkSystems[0] || null;
        selectSystem(previous);
        setStatus('');
        renderList();
        if (previous) document.getElementById(`link-systems-row-${previous.id}`)?.focus();
        else closeLinkSystems();
    });
    element('refresh').addEventListener('click', () => void refresh());
    element('close').addEventListener('click', closeLinkSystems);
}
