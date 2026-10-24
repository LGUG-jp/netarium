import {
    getConnectionHighlightEnabled,
    setConnectionHighlightEnabled,
    getLinkCrossingStyle,
    setLinkCrossingStyle
} from '../core/link-display-settings.js';
import {
    registerModalClose,
    registerModalOpen
} from '../core/modal-focus.js';
import { showToast } from '../ui/toast.js';

function syncLinkDisplaySettings() {
    const style = getLinkCrossingStyle();
    document.querySelectorAll('input[name="link-crossing-style"]').forEach(input => {
        input.checked = input.value === style;
    });
    const checkbox = document.getElementById('connection-highlight-enabled');
    if (checkbox) checkbox.checked = getConnectionHighlightEnabled();
}

export function openLinkDisplaySettings() {
    const overlay = document.getElementById('link-display-settings-overlay');
    if (!overlay) return;
    syncLinkDisplaySettings();
    overlay.hidden = false;
    registerModalOpen(
        'link-display-settings',
        overlay,
        'input[name="link-crossing-style"]:checked',
        { onClose: closeLinkDisplaySettings }
    );
}

export function closeLinkDisplaySettings() {
    const overlay = document.getElementById('link-display-settings-overlay');
    if (overlay) overlay.hidden = true;
    registerModalClose('link-display-settings');
}

export function initializeLinkDisplayModal() {
    const overlay = document.getElementById('link-display-settings-overlay');
    if (!overlay) return;
    overlay.querySelectorAll('input[name="link-crossing-style"]').forEach(input => {
        input.addEventListener('change', () => {
            if (!input.checked) return;
            const actualStyle = setLinkCrossingStyle(input.value);
            syncLinkDisplaySettings();
            if (actualStyle !== input.value) {
                showToast('表示設定を保存できないため、山形ブリッジに戻しました', 'warning');
            }
        });
    });
    const checkbox = document.getElementById('connection-highlight-enabled');
    if (checkbox) {
        checkbox.addEventListener('change', () => {
            const requestedEnabled = checkbox.checked;
            const actualEnabled = setConnectionHighlightEnabled(requestedEnabled);
            syncLinkDisplaySettings();
            if (actualEnabled !== requestedEnabled) {
                showToast('このブラウザーの表示設定を保存できないため、接続関係の強調をオフに戻しました', 'warning');
            }
        });
    }
}
