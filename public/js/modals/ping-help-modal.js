import { registerModalOpen, registerModalClose } from '../core/modal-focus.js';

export function openPingHelpDialog() {
    const overlay = document.getElementById('ping-help-overlay');
    if (!overlay || !overlay.hidden) return;
    overlay.hidden = false;
    registerModalOpen('ping_help', overlay, document.getElementById('ping-help-close-btn'), {
        onClose: closePingHelpDialog
    });
}

export function closePingHelpDialog() {
    const overlay = document.getElementById('ping-help-overlay');
    if (!overlay || overlay.hidden) return;
    overlay.hidden = true;
    registerModalClose('ping_help');
}
