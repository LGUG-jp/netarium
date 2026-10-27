/**
 * Netarium - modals/backup-modal.js
 */

import {
    BACKUP_RESTORE_CONFIRMATION
} from '../core/constants.js';

import { appState } from '../core/state.js';
import {
    setBusy
} from '../ui/toolbar.js';
import {
    isCurrentUserAdmin
} from '../ui/access-control.js';
import {
    apiFetch
} from '../core/api-client.js';
import {
    formatStatusTime,
    setTextContent
} from '../core/utils.js';
import {
    showToast
} from '../ui/toast.js';
import { setInputError } from '../ui/field-errors.js';
import {
    registerModalClose,
    registerModalOpen
} from '../core/modal-focus.js';

let isBackupRestoring = false;
let backupRestoreToken = null;
let backupRestoreCanCommit = false;

export function openBackupRestore() {
    if (!isCurrentUserAdmin()) {
        showToast(
            'この操作を実行する権限がありません',
            'warning'
        );
        return;
    }

    if (
        appState.isSaving ||
        appState.isPinging ||
        appState.isDevicesCsvImporting ||
        appState.isFloorPlanUpdating ||
        appState.isBackupExporting ||
        isBackupRestoring
    ) {
        showToast(
            '実行中の処理が完了してから復元してください',
            'warning'
        );
        return;
    }

    if (appState.appStatus.dirty) {
        showToast(
            '保存待ちの変更があります。保存完了を待ち、保存失敗時は「保存」で再試行してください',
            'warning'
        );
        return;
    }

    const overlay =
        document.getElementById(
            'backup-restore-overlay'
        );

    if (!overlay) {
        showToast(
            'バックアップ復元画面が見つかりません',
            'error'
        );
        return;
    }

    backupRestoreToken = null;
    backupRestoreCanCommit = false;

    const fileInput =
        document.getElementById(
            'backup-restore-file'
        );

    const confirmation =
        document.getElementById(
            'backup-restore-confirmation'
        );

    if (fileInput) {
        fileInput.value = '';
    }

    if (confirmation) {
        confirmation.value = '';
    }
    setBackupInputError('backup-restore-file', '');
    setBackupInputError('backup-restore-confirmation', '');

    const result =
        document.getElementById(
            'backup-restore-result'
        );

    if (result) {
        result.hidden = true;
    }
    const initialCapacityWarning =
        document.getElementById(
            'backup-restore-capacity-warning'
        );

    if (initialCapacityWarning) {
        initialCapacityWarning.hidden = true;
        initialCapacityWarning.textContent = '';
    }


    setTextContent('backup-restore-message', '');

    overlay.hidden = false;
    updateBackupRestoreButtons();
    registerModalOpen('backup', overlay, fileInput, { onClose: closeBackupRestore });
}


export function closeBackupRestore() {
    if (isBackupRestoring) {
        return;
    }
    const fileInput = document.getElementById('backup-restore-file');
    const confirmation = document.getElementById('backup-restore-confirmation');
    if ((fileInput?.files?.length || fileInput?.value || backupRestoreToken || confirmation?.value) &&
        !window.confirm('未確定のバックアップ復元を破棄して閉じますか？')) return false;
    finishBackupRestore();
}

function finishBackupRestore() {
    const fileInput = document.getElementById('backup-restore-file');
    const confirmation = document.getElementById('backup-restore-confirmation');
    if (fileInput) fileInput.value = '';
    if (confirmation) confirmation.value = '';

    const overlay =
        document.getElementById(
            'backup-restore-overlay'
        );

    if (overlay) {
        overlay.hidden = true;
    }

    registerModalClose('backup');
    backupRestoreToken = null;
    backupRestoreCanCommit = false;
}


export function resetBackupRestorePreview() {
    backupRestoreToken = null;
    backupRestoreCanCommit = false;
    setBackupInputError('backup-restore-file', '');
    setBackupInputError('backup-restore-confirmation', '');

    const result =
        document.getElementById(
            'backup-restore-result'
        );

    if (result) {
        result.hidden = true;
    }
    const resetCapacityWarning =
        document.getElementById(
            'backup-restore-capacity-warning'
        );

    if (resetCapacityWarning) {
        resetCapacityWarning.hidden = true;
        resetCapacityWarning.textContent = '';
    }


    const confirmation =
        document.getElementById(
            'backup-restore-confirmation'
        );

    if (confirmation) {
        confirmation.value = '';
    }

    setTextContent(
        'backup-restore-message',
        '選択したバックアップZIPを検証してください。'
    );

    updateBackupRestoreButtons();
}


export function updateBackupRestoreButtons() {
    const fileInput =
        document.getElementById(
            'backup-restore-file'
        );

    const previewButton =
        document.getElementById(
            'backup-restore-preview-btn'
        );

    const commitButton =
        document.getElementById(
            'backup-restore-commit-btn'
        );

    const confirmation =
        String(
            document.getElementById(
                'backup-restore-confirmation'
            )?.value || ''
        );

    setTextContent(
        'backup-restore-file-name',
        fileInput?.files?.[0]?.name || 'ファイルが選択されていません。'
    );

    if (previewButton) {
        previewButton.disabled =
            isBackupRestoring ||
            !fileInput?.files?.length;
    }

    if (commitButton) {
        commitButton.disabled =
            isBackupRestoring ||
            !backupRestoreCanCommit ||
            !backupRestoreToken ||
            confirmation !==
                BACKUP_RESTORE_CONFIRMATION;
    }
}


function setBackupInputError(id, message) {
    const input = document.getElementById(id);
    setInputError(input, document.getElementById(`${id}-error`), message);
    if (message) input?.focus();
}

export async function previewBackupRestore() {
    if (isBackupRestoring) {
        return;
    }

    const file =
        document.getElementById(
            'backup-restore-file'
        )?.files?.[0];
    setBackupInputError('backup-restore-file', '');

    if (!file) {
        setBackupInputError('backup-restore-file', 'バックアップZIPを選択してください');
        return;
    }

    const maxZipBytes =
        Number(
            window.APP_CONFIG?.capacity?.backupMaxZipBytes
        ) || 24 * 1024 * 1024;

    if (
        file.size <= 0 ||
        file.size > maxZipBytes
    ) {
        setBackupInputError('backup-restore-file',
            `バックアップZIPは${Math.floor(maxZipBytes / (1024 * 1024))}MiB以下にしてください`);
        return;
    }

    const formData =
        new FormData();

    formData.append(
        'backup_zip',
        file
    );

    try {
        isBackupRestoring = true;
        setBusy(
            true,
            'バックアップ検証中...'
        );

        const data =
            await apiFetch(
                'preview_backup_restore',
                {
                    method: 'POST',
                    body: formData
                }
            );

        backupRestoreToken =
            data.restore_token || null;

        backupRestoreCanCommit =
            data.can_restore === true;

        const backup =
            data.backup || {};

        const counts =
            backup.counts || {};

        setTextContent(
            'backup-restore-name',
            backup.name || '-'
        );

        setTextContent(
            'backup-restore-created-at',
            backup.created_at
                ? formatStatusTime(
                    backup.created_at
                )
                : '-'
        );

        setTextContent(
            'backup-restore-version',
            backup.application_version ||
                '-'
        );

        setTextContent(
            'backup-restore-expiry',
            data.expires_at
                ? formatStatusTime(
                    data.expires_at
                )
                : '-'
        );

        setTextContent(
            'backup-restore-views',
            counts.views || 0
        );
        setTextContent(
            'backup-restore-devices',
            counts.devices || 0
        );
        setTextContent(
            'backup-restore-monitor',
            counts.device_monitor_status ||
                0
        );
        setTextContent(
            'backup-restore-placements',
            counts.device_placements || 0
        );
        setTextContent(
            'backup-restore-links',
            counts.links || 0
        );
        setTextContent('backup-restore-link-systems', counts.link_systems || 0);
        setTextContent('backup-restore-notes', counts.canvas_notes || 0);
        setTextContent('backup-restore-racks', counts.rack_settings || 0);
        setTextContent('backup-restore-mounts', counts.rack_mounts || 0);
        const removal = data.rack_removal || {};
        const rackIds = removal.rack_settings || [];
        const removedMounts = removal.rack_mounts || [];
        const removedShelves = removal.rack_shelves || [];
        const removedShelfDevices = removal.rack_shelf_devices || [];
        setTextContent('backup-restore-rack-removal', rackIds.length || removedMounts.length || removedShelves.length || removedShelfDevices.length
            ? `構成全体の置換により、現在のラック ${rackIds.length}件・直付け搭載 ${removedMounts.length}件・棚板 ${removedShelves.length}件・棚板上の所属 ${removedShelfDevices.length}件が削除または移設されます（ラックID: ${rackIds.join(', ') || 'なし'}、直付け機器ID: ${removedMounts.map(row => row.device_id).join(', ') || 'なし'}）。復元前の構成ZIPへ自動退避します。利用者・セッション・画像実体は変更しません。`
            : 'ラック属性・搭載情報・棚板・棚板上の所属も構成全体の置換対象です。');
        setTextContent(
            'backup-restore-floor-plans',
            counts.floor_plans || 0
        );
        setTextContent(
            'backup-restore-device-images',
            counts.device_images || 0
        );
        const images = data.image_resolution || {};
        setTextContent('backup-restore-images',
            `画像関連付け: 一致 ${images.matched || 0}件 / 欠損 ${images.missing || 0}件 / 不一致 ${images.mismatched || 0}件 / 復元後未参照 ${images.unreferenced || 0}件。画像ファイルは削除しません。`);
        const issues = document.getElementById('backup-restore-image-issues');
        if (issues) {
            issues.replaceChildren();
            for (const item of images.items || []) {
                const li = document.createElement('li');
                li.textContent = `${item.kind === 'device_images' ? '機器' : 'ビュー'} ID ${item.id}: ${item.stored_name}（${item.reason === 'missing' ? '実体欠損' : '同一性不一致'}・参照を復元しません）`;
                issues.appendChild(li);
            }
        }

        const result =
            document.getElementById(
                'backup-restore-result'
            );

        if (result) {
            result.hidden = false;
        }

        const capacityWarnings =
            Array.isArray(data.capacity?.warnings)
                ? data.capacity.warnings
                : [];
        const capacityWarning =
            document.getElementById(
                'backup-restore-capacity-warning'
            );

        if (capacityWarning) {
            capacityWarning.hidden =
                capacityWarnings.length === 0;
            capacityWarning.textContent =
                capacityWarnings.join('、');
        }

        setTextContent(
            'backup-restore-message',
            data.message ||
                '検証に成功しました。確認文言を入力して復元を実行してください。'
        );

    } catch (err) {
        console.error(err);

        backupRestoreToken = null;
        backupRestoreCanCommit = false;

        setTextContent(
            'backup-restore-message',
            `検証エラー: ${err.message}`
        );

        if (err.status === 401) return;
        showToast(
            `バックアップ検証エラー: ${err.message}`,
            'error'
        );
    } finally {
        isBackupRestoring = false;
        setBusy(false);
        updateBackupRestoreButtons();
    }
}


export async function commitBackupRestore() {
    if (
        isBackupRestoring ||
        !backupRestoreToken ||
        !backupRestoreCanCommit
    ) {
        return;
    }

    const confirmation =
        String(
            document.getElementById(
                'backup-restore-confirmation'
            )?.value || ''
        );
    setBackupInputError('backup-restore-confirmation', '');

    if (
        confirmation !==
        BACKUP_RESTORE_CONFIRMATION
    ) {
        setBackupInputError('backup-restore-confirmation', '確認文言が一致しません');
        return;
    }

    if (
        !confirm(
            'バックアップから復元を実行しますか?\n\n' +
            '現在の構成と画像の関連情報を置き換えます。画像実体は変更しません。\n' +
            '復元直前の自動バックアップを作成してから実行します。'
        )
    ) {
        return;
    }

    try {
        isBackupRestoring = true;
        setBusy(
            true,
            'バックアップ復元中...'
        );

        const data =
            await apiFetch(
                'commit_backup_restore',
                {
                    method: 'POST',
                    headers: {
                        'Content-Type':
                            'application/json'
                    },
                    body: JSON.stringify({
                        restore_token:
                            backupRestoreToken,
                        confirmation
                    })
                }
            );
        finishBackupRestore();

        if (
            data.post_processing_required ===
            true
        ) {
            alert(
                `${
                    data.message ||
                    'バックアップから復元しました（後処理要対応）'
                }\n\n` +
                '復元は完了しています。再実行せず、' +
                'data/logs/restore.log、data/logs/auditおよび一時領域を確認してください。'
            );

            window.location.replace('index.php');
            return;
        }

        window.location.replace('index.php');
    } catch (err) {
        console.error(err);

        if (err.status === 401) return;
        showToast(
            `バックアップ復元エラー: ${err.message}`,
            'error'
        );
    } finally {
        isBackupRestoring = false;
        setBusy(false);
        updateBackupRestoreButtons();
    }
}
