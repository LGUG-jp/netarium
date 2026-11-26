import { registerModalOpen, registerModalClose } from '../core/modal-focus.js';

const modalId = 'ledger-port-vlan-confirm';
let active = false;

function node(tag, className, text = '') {
    const element = document.createElement(tag);
    element.className = className;
    if (text) element.textContent = text;
    return element;
}

export function confirmPortVlanAction({ title, lines, comparison, confirmLabel, destructive = false }) {
    if (active) return Promise.resolve(false);

    const overlay = node('div', 'placement-manager-overlay unsaved-changes-overlay');
    overlay.id = `${modalId}-overlay`;
    const dialog = node('section', 'placement-manager-dialog unsaved-changes-dialog port-vlan-confirm-dialog');
    if (comparison) dialog.classList.add('port-vlan-confirm-comparison-dialog');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    const header = node('div', 'placement-manager-header unsaved-changes-header');
    const heading = node('h2', '', title);
    heading.id = `${modalId}-title`;
    dialog.setAttribute('aria-labelledby', heading.id);
    const close = node('button', 'modal-close-btn', '×');
    close.type = 'button';
    close.setAttribute('aria-label', '閉じる');
    header.append(heading, close);

    const description = node('div', 'unsaved-changes-message port-vlan-confirm-message');
    description.id = `${modalId}-message`;
    dialog.setAttribute('aria-describedby', description.id);
    for (const line of lines) description.append(node('p', '', line));
    if (comparison) {
        const columns = node('div', 'port-vlan-confirm-comparison');
        for (const { label, endpoint, value } of comparison) {
            const column = node('div', 'port-vlan-confirm-endpoint');
            column.append(node('h3', '', label), node('p', '', endpoint), node('p', '', value));
            columns.append(column);
        }
        description.append(columns);
    }

    const actions = node('div', 'unsaved-changes-actions');
    const cancel = node('button', 'btn btn-secondary btn-sm', 'キャンセル');
    const confirm = node('button', `btn ${destructive ? 'btn-danger' : 'btn-primary'} btn-sm`, confirmLabel);
    cancel.type = confirm.type = 'button';
    actions.append(cancel, confirm);
    dialog.append(header, description, actions);
    overlay.append(dialog);

    return new Promise(resolve => {
        const finish = approved => {
            if (overlay.hidden) return;
            active = false;
            overlay.hidden = true;
            registerModalClose(modalId);
            overlay.remove();
            resolve(approved);
        };
        close.addEventListener('click', () => finish(false));
        cancel.addEventListener('click', () => finish(false));
        confirm.addEventListener('click', () => finish(true));
        overlay.addEventListener('keydown', event => {
            if (event.key !== 'Tab') event.stopPropagation();
        });
        active = true;
        document.body.append(overlay);
        registerModalOpen(modalId, overlay, cancel, { onClose: () => finish(false), finishFloorPlan: false });
    });
}
