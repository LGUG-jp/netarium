/**
 * Netarium - modals/management-modal.js
 */

import {
    MANAGEMENT_DEFAULT_PORTS
} from '../core/constants.js';

import { appState } from '../core/state.js';
import {
    isValidIpv4,
    normalizeText
} from '../core/utils.js';
import {
    getDeviceById
} from '../core/state.js';
import {
    showToast
} from '../ui/toast.js';
import {
    registerModalClose,
    registerModalOpen
} from '../core/modal-focus.js';

let managementConnectionState = null;
let managementConnectionPreviousFocus = null;

export function getEditingDeviceManagementTarget() {
    if (appState.editingDeviceId === null) {
        return null;
    }

    const device =
        getDeviceById(appState.editingDeviceId);

    if (!device) {
        return null;
    }

    const savedIp =
        normalizeText(
            device.ip
        ).trim();

    const input =
        document.getElementById(
            'p-ip'
        );

    const inputIp =
        input
            ? normalizeText(
                input.value
            ).trim()
            : savedIp;

    return {
        device,
        ip: inputIp,
        isValid:
            isValidIpv4(inputIp),
        hasUnappliedChange:
            inputIp !== savedIp
    };
}

export function getDeviceManagementUnavailableReason(
    target = getEditingDeviceManagementTarget()
) {
    if (!target) {
        return '接続対象の機器がありません';
    }

    if (!target.ip) {
        return 'IPアドレスが設定されていません';
    }

    if (!target.isValid) {
        return '有効なIPアドレスが設定されていません';
    }

    if (target.hasUnappliedChange) {
        return 'IPアドレスの変更を「適用」してから接続してください';
    }

    if (appState.isPinging) {
        return 'Ping実行中は接続できません';
    }

    return '';
}


export function isSupportedManagementScheme(scheme) {
    return Object.prototype.hasOwnProperty.call(
        MANAGEMENT_DEFAULT_PORTS,
        scheme
    );
}


export function getDefaultManagementPort(scheme) {
    if (!isSupportedManagementScheme(scheme)) {
        return null;
    }

    return MANAGEMENT_DEFAULT_PORTS[scheme];
}


export function normalizeManagementPort(value, scheme) {
    const defaultPort =
        getDefaultManagementPort(scheme);

    if (defaultPort === null) {
        return {
            isValid: false,
            port: null,
            isDefault: false,
            message: '接続方式が不正です'
        };
    }

    const normalizedValue =
        normalizeText(value).trim();

    if (normalizedValue === '') {
        return {
            isValid: true,
            port: defaultPort,
            isDefault: true,
            message: ''
        };
    }

    if (!/^\d+$/.test(normalizedValue)) {
        return {
            isValid: false,
            port: null,
            isDefault: false,
            message: 'ポート番号は1～65535の整数で入力してください'
        };
    }

    const port = Number(normalizedValue);

    if (
        !Number.isSafeInteger(port) ||
        port < 1 ||
        port > 65535
    ) {
        return {
            isValid: false,
            port: null,
            isDefault: false,
            message: 'ポート番号は1～65535の整数で入力してください'
        };
    }

    return {
        isValid: true,
        port,
        isDefault: port === defaultPort,
        message: ''
    };
}


export function buildManagementUrl(
    scheme,
    ip,
    port = null
) {
    if (!isSupportedManagementScheme(scheme)) {
        return null;
    }

    const normalizedIp =
        normalizeText(ip).trim();

    if (!normalizedIp) {
        return null;
    }

    const portResult =
        normalizeManagementPort(
            port === null ? '' : port,
            scheme
        );

    if (!portResult.isValid) {
        return null;
    }

    const portPart =
        portResult.isDefault
            ? ''
            : `:${portResult.port}`;

    if (scheme === 'ssh') {
        return `ssh://${normalizedIp}${portPart}`;
    }

    return `${scheme}://${normalizedIp}${portPart}/`;
}


export function openManagementUrl(scheme, url) {
    if (
        !isSupportedManagementScheme(scheme) ||
        !url
    ) {
        showToast(
            '接続先URLを生成できませんでした',
            'error'
        );
        return false;
    }

    if (
        scheme === 'http' ||
        scheme === 'https'
    ) {
        const opened = window.open(
            url,
            '_blank',
            'noopener,noreferrer'
        );

        if (!opened) {
            showToast(
                '新しいタブを開けませんでした。ポップアップ設定を確認してください',
                'warning'
            );
            return false;
        }

        return true;
    }

    window.location.href = url;
    return true;
}


export function getManagementSchemeLabel(scheme) {
    const labels = {
        http: 'HTTP',
        https: 'HTTPS',
        ssh: 'SSH'
    };

    return labels[scheme] || '';
}


export function getManagementConnectionOverlay() {
    return document.getElementById(
        'management-connection-overlay'
    );
}


export function getManagementConnectionDialog() {
    return document.getElementById(
        'management-connection-dialog'
    );
}


export function getManagementConnectionPortInput() {
    return document.getElementById(
        'management-connection-port'
    );
}


export function getManagementSshHelpOverlay() {
    return document.getElementById(
        'management-ssh-help-overlay'
    );
}


export function getManagementSshHelpDialog() {
    return document.getElementById(
        'management-ssh-help-dialog'
    );
}


export function getSelectedManagementScheme() {
    const selected =
        document.querySelector(
            'input[name="management-connection-scheme"]:checked'
        );

    if (
        !(selected instanceof HTMLInputElement) ||
        !isSupportedManagementScheme(
            selected.value
        )
    ) {
        return null;
    }

    return selected.value;
}


export function setSelectedManagementScheme(scheme) {
    const normalizedScheme =
        isSupportedManagementScheme(scheme)
            ? scheme
            : 'https';

    const input =
        document.querySelector(
            `input[name="management-connection-scheme"][value="${normalizedScheme}"]`
        );

    if (
        input instanceof HTMLInputElement
    ) {
        input.checked = true;
    }

    return normalizedScheme;
}


export function getManagementConnectionFocusableElements() {
    const dialog =
        getManagementConnectionDialog();

    if (!dialog) {
        return [];
    }

    return Array.from(
        dialog.querySelectorAll(
            'button:not([disabled]), ' +
            '[href], ' +
            'input:not([disabled]), ' +
            'select:not([disabled]), ' +
            'textarea:not([disabled]), ' +
            '[tabindex]:not([tabindex="-1"])'
        )
    ).filter(element => {
        return (
            element instanceof HTMLElement &&
            !element.hidden &&
            element.offsetParent !== null &&
            element.getAttribute(
                'aria-hidden'
            ) !== 'true'
        );
    });
}


export function getManagementConnectionDeviceName(target) {
    if (!target || !target.device) {
        return '(名称未設定)';
    }

    return (
        normalizeText(
            target.device.name
        ).trim() ||
        `機器ID ${target.device.id}`
    );
}


export function updateManagementConnectionPreview() {
    const state =
        managementConnectionState;

    const input =
        getManagementConnectionPortInput();

    const error =
        document.getElementById(
            'management-connection-port-error'
        );

    const help =
        document.getElementById(
            'management-connection-port-help'
        );

    const preview =
        document.getElementById(
            'management-connection-url'
        );

    const openButton =
        document.getElementById(
            'management-connection-open-btn'
        );

    if (
        !state ||
        !input ||
        !error ||
        !help ||
        !preview ||
        !openButton
    ) {
        return false;
    }

    const selectedScheme =
        getSelectedManagementScheme();

    const sshHelpButton =
        document.getElementById(
            'management-connection-ssh-help-btn'
        );

    if (sshHelpButton) {
        sshHelpButton.hidden =
            selectedScheme !== 'ssh';
    }

    if (!selectedScheme) {
        error.textContent =
            '接続方式を選択してください';

        error.hidden = false;
        preview.textContent = '-';
        openButton.disabled = true;
        openButton.textContent =
            'ブラウザで開く';

        return false;
    }

    openButton.textContent =
        selectedScheme === 'ssh'
            ? 'SSHで開く'
            : 'ブラウザで開く';

    /*
     * ラジオボタンの選択を、
     * ダイアログ状態へ反映する。
     */
    state.scheme =
        selectedScheme;

    const defaultPort =
        getDefaultManagementPort(
            selectedScheme
        );

    help.textContent =
        `空欄の場合は${getManagementSchemeLabel(
            selectedScheme
        )}の標準ポート${defaultPort}を使用します。`;

    input.placeholder =
        `標準: ${defaultPort}`;

    const portResult =
        normalizeManagementPort(
            input.value,
            selectedScheme
        );

    if (!portResult.isValid) {
        input.setAttribute(
            'aria-invalid',
            'true'
        );

        error.textContent =
            portResult.message;

        error.hidden = false;
        preview.textContent = '-';
        openButton.disabled = true;

        return false;
    }

    const url =
        buildManagementUrl(
            selectedScheme,
            state.ip,
            portResult.port
        );

    if (!url) {
        input.setAttribute(
            'aria-invalid',
            'true'
        );

        error.textContent =
            '接続先URLを生成できませんでした';

        error.hidden = false;
        preview.textContent = '-';
        openButton.disabled = true;

        return false;
    }

    input.removeAttribute(
        'aria-invalid'
    );

    error.textContent = '';
    error.hidden = true;
    preview.textContent = url;
    openButton.disabled = false;

    return true;
}


export function openManagementConnectionDialog(target) {
    const overlay =
        getManagementConnectionOverlay();

    if (!overlay) {
        showToast(
            '接続確認画面が見つかりません',
            'error'
        );
        return;
    }

    const activeElement =
        document.activeElement;

    managementConnectionPreviousFocus =
        activeElement instanceof HTMLElement
            ? activeElement
            : null;

    const savedScheme = target.device?.management_scheme;
    const initialScheme =
        setSelectedManagementScheme(
            savedScheme && isSupportedManagementScheme(savedScheme)
                ? savedScheme
                : 'https'
        );

    managementConnectionState = {
        scheme: initialScheme,
        ip: target.ip,
        device: target.device
    };

    const deviceElement =
        document.getElementById(
            'management-connection-device'
        );

    const ipElement =
        document.getElementById(
            'management-connection-ip'
        );

    const input =
        getManagementConnectionPortInput();

    if (
        !deviceElement ||
        !ipElement ||
        !input
    ) {
        managementConnectionState = null;

        showToast(
            '接続確認画面を初期化できませんでした',
            'error'
        );
        return;
    }

    deviceElement.textContent =
        getManagementConnectionDeviceName(
            target
        );

    ipElement.textContent =
        target.ip;

    input.value = target.device?.management_port != null ? String(target.device.management_port) : '';

    overlay.hidden = false;

    updateManagementConnectionPreview();
    registerModalOpen('management', overlay, input, { onClose: () => closeManagementConnectionDialog() });
}


export function closeManagementConnectionDialog(
    restoreFocus = true
) {
    const helpOverlay =
        getManagementSshHelpOverlay();

    if (
        helpOverlay &&
        !helpOverlay.hidden
    ) {
        helpOverlay.hidden = true;
        registerModalClose(
            'management_ssh_help'
        );
    }

    const overlay =
        getManagementConnectionOverlay();

    if (
        !overlay ||
        overlay.hidden
    ) {
        return;
    }
    overlay.hidden = true;
    registerModalClose('management');
    managementConnectionState = null;
    const previousFocus =
        managementConnectionPreviousFocus;

    managementConnectionPreviousFocus = null;

    if (
        restoreFocus &&
        previousFocus instanceof HTMLElement &&
        previousFocus.isConnected
    ) {
        window.requestAnimationFrame(
            () => {
                previousFocus.focus();
            }
        );
    }
}


export function openManagementSshHelpDialog() {
    const overlay =
        getManagementSshHelpOverlay();

    if (!overlay) {
        return;
    }

    overlay.hidden = false;

    const closeBtn =
        document.getElementById(
            'management-ssh-help-close-btn'
        );

    registerModalOpen(
        'management_ssh_help',
        overlay,
        closeBtn,
        { onClose: closeManagementSshHelpDialog }
    );
}


export function closeManagementSshHelpDialog() {
    const overlay =
        getManagementSshHelpOverlay();

    if (
        !overlay ||
        overlay.hidden
    ) {
        return;
    }

    overlay.hidden = true;

    registerModalClose(
        'management_ssh_help'
    );
}


export function confirmManagementConnection() {
    const state =
        managementConnectionState;

    const input =
        getManagementConnectionPortInput();

    if (!state || !input) {
        showToast(
            '接続先情報を取得できませんでした',
            'error'
        );
        return;
    }

    const selectedScheme =
        getSelectedManagementScheme();

    if (!selectedScheme) {
        updateManagementConnectionPreview();


        return;
    }

    const currentTarget =
        getEditingDeviceManagementTarget();

    const unavailableReason =
        getDeviceManagementUnavailableReason(
            currentTarget
        );

    if (unavailableReason) {
        closeManagementConnectionDialog();

        showToast(
            unavailableReason,
            'warning'
        );

        return;
    }

    if (
        currentTarget.ip !== state.ip ||
        currentTarget.device?.id !==
            state.device?.id
    ) {
        closeManagementConnectionDialog();

        showToast(
            '接続対象が変更されました。もう一度接続操作を行ってください',
            'warning'
        );

        return;
    }

    const portResult =
        normalizeManagementPort(
            input.value,
            selectedScheme
        );

    if (!portResult.isValid) {
        updateManagementConnectionPreview();
        input.focus();
        return;
    }

    const url =
        buildManagementUrl(
            selectedScheme,
            state.ip,
            portResult.port
        );

    if (!url) {
        showToast(
            '接続先URLを生成できませんでした',
            'error'
        );
        return;
    }

    closeManagementConnectionDialog(
        false
    );

    openManagementUrl(
        selectedScheme,
        url
    );
}



export function handleManagementConnectionDialogKeydown(
    event
) {
    const helpOverlay =
        getManagementSshHelpOverlay();

    if (
        helpOverlay &&
        !helpOverlay.hidden
    ) {

        if (
            event.key === 'Enter' &&
            !event.isComposing
        ) {
            const target =
                event.target;

            if (
                target instanceof HTMLButtonElement &&
                target.id === 'management-ssh-help-close-btn'
            ) {
                return false;
            }

            event.preventDefault();
            event.stopImmediatePropagation();

            closeManagementSshHelpDialog();

            return true;
        }

        return false;
    }

    const overlay =
        getManagementConnectionOverlay();

    if (
        !overlay ||
        overlay.hidden
    ) {
        return false;
    }


    if (
        event.key === 'Enter' &&
        !event.isComposing
    ) {
        const target =
            event.target;

        if (
            target instanceof HTMLInputElement &&
            target.type === 'radio'
        ) {
            return false;
        }

        if (
            target instanceof HTMLButtonElement &&
            target.id !==
                'management-connection-open-btn'
        ) {
            return false;
        }

        event.preventDefault();
        event.stopImmediatePropagation();

        const openButton =
            document.getElementById(
                'management-connection-open-btn'
            );

        if (
            openButton &&
            !openButton.disabled
        ) {
            confirmManagementConnection();
        }

        return true;
    }

    if (event.key !== 'Tab') {
        return false;
    }

    const focusable =
        getManagementConnectionFocusableElements();

    if (focusable.length === 0) {
        event.preventDefault();

        getManagementConnectionDialog()
            ?.focus();

        return true;
    }

    const first =
        focusable[0];

    const last =
        focusable[
            focusable.length - 1
        ];

    if (
        event.shiftKey &&
        document.activeElement === first
    ) {
        event.preventDefault();
        last.focus();

        return true;
    }

    if (
        !event.shiftKey &&
        document.activeElement === last
    ) {
        event.preventDefault();
        first.focus();

        return true;
    }

    return false;
}



export function openEditingDeviceManagement() {
    const target =
        getEditingDeviceManagementTarget();

    const unavailableReason =
        getDeviceManagementUnavailableReason(
            target
        );

    if (unavailableReason) {
        showToast(
            unavailableReason,
            'warning'
        );
        return;
    }

    openManagementConnectionDialog(
        target
    );
}

