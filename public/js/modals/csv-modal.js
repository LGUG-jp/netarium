/**
 * Netarium - modals/csv-modal.js
 */

import { appState } from '../core/state.js';
import {
    loadData,
    setBusy
} from '../ui/toolbar.js';
import {
    isCurrentUserAdmin
} from '../ui/access-control.js';
import {
    apiFetch,
    startAuthenticatedDownload
} from '../core/api-client.js';
import {
    formatStatusTime,
    setTextContent
} from '../core/utils.js';
import {
    showToast, showStatusMessage
} from '../ui/toast.js';
import { setInputError } from '../ui/field-errors.js';
import {
    markConflict,
    markSaved
} from '../ui/status-bar.js';
import {
    registerModalClose,
    registerModalOpen
} from '../core/modal-focus.js';
import {
    renderLedgerTable,
    updateLedgerFilters
} from './ledger-modal.js';

let devicesCsvImportToken = null;
let devicesCsvImportRows = [];
let devicesCsvImportSummary = null;
let devicesCsvImportCanCommit = false;

/**
 * CSV出力を開始できる状態か確認する。
 */
export function canStartDeviceCsvDownload() {
    if (!isCurrentUserAdmin()) {
        showToast(
            'この操作を実行する権限がありません',
            'warning'
        );

        return false;
    }

    if (appState.isSaving) {
        showToast(
            '保存処理中です。完了後に実行してください',
            'warning'
        );

        return false;
    }

    if (appState.isPinging) {
        showToast(
            'Ping実行中です。完了後に実行してください',
            'warning'
        );

        return false;
    }

    if (appState.appStatus.dirty) {
        showToast(
            '保存待ちの変更があります。保存完了を待ち、保存失敗時は「保存」で再試行してください',
            'warning'
        );

        return false;
    }

    return true;
}

/**
 * 保存済みの機器台帳全件をCSV出力する。
 */

/**
 * 保存済みの機器台帳全件をCSV出力する。
 */
export function exportDevicesCsv() {
    if (!canStartDeviceCsvDownload()) {
        return;
    }

    startAuthenticatedDownload(
        'export_devices_csv'
    );

    showStatusMessage(
        '機器台帳CSVのダウンロードを開始しました',
        'info'
    );
}

/**
 * CSV取込用テンプレートを出力する。
 *
 * テンプレートはDBデータに依存しないが、
 * 権限と処理中状態は通常CSVと揃える。
 */

/**
 * CSV取込用テンプレートを出力する。
 *
 * テンプレートはDBデータに依存しないが、
 * 権限と処理中状態は通常CSVと揃える。
 */
export function downloadDevicesCsvTemplate() {
    if (!isCurrentUserAdmin()) {
        showToast(
            'この操作を実行する権限がありません',
            'warning'
        );

        return;
    }

    if (appState.isSaving || appState.isPinging) {
        showToast(
            '処理完了後に実行してください',
            'warning'
        );

        return;
    }

    startAuthenticatedDownload(
        'download_devices_csv_template'
    );

    showStatusMessage(
        'CSV取込テンプレートのダウンロードを開始しました',
        'info'
    );
}


export function openDevicesCsvImport() {
    if (!canStartDeviceCsvDownload()) {
        return;
    }

    const overlay =
        document.getElementById(
            'devices-csv-import-overlay'
        );

    if (!overlay) {
        showToast(
            'CSV取込画面が見つかりません',
            'error'
        );
        return;
    }

    devicesCsvImportToken = null;
    devicesCsvImportRows = [];
    devicesCsvImportSummary = null;
    devicesCsvImportCanCommit = false;

    const fileInput =
        document.getElementById(
            'devices-csv-import-file'
        );

    if (fileInput) {
        fileInput.value = '';
    }
    setCsvFileError('');

    const problemsOnly =
        document.getElementById(
            'devices-csv-problems-only'
        );

    if (problemsOnly) {
        problemsOnly.checked = false;
    }

    document
        .getElementById(
            'devices-csv-import-result'
        )
        ?.setAttribute(
            'hidden',
            ''
        );

    setTextContent('devices-csv-import-message', '');

    setTextContent(
        'devices-csv-import-expiry',
        ''
    );

    overlay.hidden = false;

    updateDevicesCsvImportButtons();
    registerModalOpen('csv_import', overlay, fileInput, { onClose: closeDevicesCsvImport });
}


export function closeDevicesCsvImport() {
    if (appState.isDevicesCsvImporting) {
        return;
    }
    const fileInput = document.getElementById('devices-csv-import-file');
    if ((fileInput?.files?.length || fileInput?.value || devicesCsvImportToken) &&
        !window.confirm('未確定のCSV取込を破棄して閉じますか？')) return false;
    finishDevicesCsvImport();
}

function finishDevicesCsvImport() {
    const fileInput = document.getElementById('devices-csv-import-file');
    if (fileInput) fileInput.value = '';

    const overlay =
        document.getElementById(
            'devices-csv-import-overlay'
        );

    if (overlay) {
        overlay.hidden = true;
    }

    registerModalClose('csv_import');
    devicesCsvImportToken = null;
    devicesCsvImportRows = [];
    devicesCsvImportSummary = null;
    devicesCsvImportCanCommit = false;
}


export function resetDevicesCsvImportPreview() {
    devicesCsvImportToken = null;
    devicesCsvImportRows = [];
    devicesCsvImportSummary = null;
    devicesCsvImportCanCommit = false;
    setCsvFileError('');

    const result =
        document.getElementById(
            'devices-csv-import-result'
        );

    if (result) {
        result.hidden = true;
    }

    setTextContent(
        'devices-csv-import-message',
        '選択したCSVを検証してください。'
    );

    setTextContent(
        'devices-csv-import-expiry',
        ''
    );

    updateDevicesCsvImportButtons();
}


export function updateDevicesCsvImportButtons() {
    const fileInput =
        document.getElementById(
            'devices-csv-import-file'
        );

    const previewButton =
        document.getElementById(
            'devices-csv-preview-btn'
        );

    const commitButton =
        document.getElementById(
            'devices-csv-commit-btn'
        );

    if (previewButton) {
        previewButton.disabled =
            appState.isDevicesCsvImporting ||
            !fileInput?.files?.length;
    }

    if (commitButton) {
        commitButton.disabled =
            appState.isDevicesCsvImporting ||
            !devicesCsvImportCanCommit ||
            !devicesCsvImportToken;
    }
}


export function getDevicesCsvOperationLabel(
    operation
) {
    const labels = {
        insert: '新規',
        update: '更新',
        unchanged: '変更なし',
        error: 'エラー'
    };

    return labels[operation] ||
        operation ||
        '-';
}


export function formatDevicesCsvChangeValue(
    value
) {
    const text =
        value == null
            ? ''
            : String(value);

    return text === ''
        ? '(空欄)'
        : text;
}


export function createDevicesCsvValueElement(
    value,
    className
) {
    const span =
        document.createElement('span');

    span.className =
        className;

    span.textContent =
        formatDevicesCsvChangeValue(
            value
        );

    return span;
}


export function createDevicesCsvChangesElement(
    row
) {
    const container =
        document.createElement('div');

    container.className =
        'csv-import-change-list';

    const operation =
        String(
            row?.operation || ''
        );

    const changedFields =
        Array.isArray(
            row?.changed_fields
        )
            ? row.changed_fields
            : [];

    const changes =
        row?.changes &&
        typeof row.changes === 'object'
            ? row.changes
            : {};

    if (operation === 'insert') {
        container.textContent =
            '新規登録';

        return container;
    }

    if (changedFields.length === 0) {
        container.textContent =
            operation === 'unchanged'
                ? '変更なし'
                : '-';

        return container;
    }

    changedFields.forEach(field => {
        const change =
            changes[field];

        if (
            !change ||
            typeof change !== 'object'
        ) {
            const fallback =
                document.createElement(
                    'div'
                );

            fallback.className =
                'csv-import-change-item';

            fallback.textContent =
                String(field);

            container.appendChild(
                fallback
            );

            return;
        }

        const item =
            document.createElement('div');

        item.className =
            'csv-import-change-item';

        if (field === 'ip') {
            item.classList.add(
                'csv-import-change-ip'
            );
        }

        const label =
            document.createElement('strong');

        label.className =
            'csv-import-change-label';

        label.textContent =
            String(
                change.label ||
                field
            );

        const values =
            document.createElement('span');

        values.className =
            'csv-import-change-values';

        values.appendChild(
            createDevicesCsvValueElement(
                change.before,
                'csv-import-change-before'
            )
        );

        const arrow =
            document.createElement('span');

        arrow.className =
            'csv-import-change-arrow';

        arrow.textContent = '→';

        values.appendChild(arrow);

        values.appendChild(
            createDevicesCsvValueElement(
                change.after,
                'csv-import-change-after'
            )
        );

        item.appendChild(label);
        item.appendChild(values);
        container.appendChild(item);
    });

    return container;
}


export function formatDevicesCsvTransformations(
    row
) {
    const transformations =
        Array.isArray(
            row?.transformations
        )
            ? row.transformations
            : [];

    return transformations
        .map(transformation => {
            if (
                !transformation ||
                typeof transformation !==
                    'object'
            ) {
                return '';
            }

            const label =
                String(
                    transformation.label ||
                    transformation.field ||
                    '項目'
                );

            const before =
                formatDevicesCsvChangeValue(
                    transformation.before
                );

            const after =
                formatDevicesCsvChangeValue(
                    transformation.after
                );

            return (
                `安全化文字を復元: ` +
                `${label}: ` +
                `${before} → ${after}`
            );
        })
        .filter(Boolean);
}


export function formatDevicesCsvValidationResult(
    row
) {
    const errors =
        Array.isArray(row?.errors)
            ? row.errors
            : [];

    const warnings =
        Array.isArray(row?.warnings)
            ? row.warnings
            : [];

    const transformations =
        formatDevicesCsvTransformations(
            row
        );

    const messages = [];

    errors.forEach(error => {
        messages.push(
            `エラー: ${String(error)}`
        );
    });

    warnings.forEach(warning => {
        const message =
            warning &&
            typeof warning === 'object'
                ? warning.message
                : warning;

        messages.push(
            `警告: ${String(
                message || ''
            )}`
        );
    });

    transformations.forEach(
        transformation => {
            messages.push(
                transformation
            );
        }
    );

    return messages.length > 0
        ? messages.join('\n')
        : '問題なし';
}




export function renderDevicesCsvImportRows() {
    const tbody =
        document.getElementById(
            'devices-csv-import-rows'
        );

    if (!tbody) {
        return;
    }

    const problemsOnly =
        Boolean(
            document.getElementById(
                'devices-csv-problems-only'
            )?.checked
        );

    const rows =
        devicesCsvImportRows.filter(
            row =>
                !problemsOnly ||
                row.operation === 'error' ||
                (
                    Array.isArray(
                        row.warnings
                    ) &&
                    row.warnings.length > 0
                ) ||
                (
                    Array.isArray(
                        row.transformations
                    ) &&
                    row.transformations.length >
                        0
                )
        );

    tbody.replaceChildren();

    rows.forEach(row => {
        const tr =
            document.createElement('tr');

        tr.classList.add(
            `csv-import-row-${row.operation}`
        );

        if (
            row.operation !== 'error' &&
            Array.isArray(row.warnings) &&
            row.warnings.length > 0
        ) {
            tr.classList.add(
                'csv-import-row-warning'
            );
        }

        if (
            row.operation !== 'error' &&
            (
                !Array.isArray(row.warnings) ||
                row.warnings.length === 0
            ) &&
            Array.isArray(
                row.transformations
            ) &&
            row.transformations.length > 0
        ) {
            tr.classList.add(
                'csv-import-row-transformation'
            );
        }


        [
            row.line,
            getDevicesCsvOperationLabel(
                row.operation
            ),
            row.id ?? '新規採番',
            row.name || '',
            row.ip || '',
            '',
            formatDevicesCsvValidationResult(
                row
            )
        ].forEach((value, index) => {
            const td =
                document.createElement('td');

            const columnClasses = [
                'csv-import-column-line',
                'csv-import-column-operation',
                'csv-import-column-id',
                'csv-import-column-name',
                'csv-import-column-ip',
                'csv-import-column-changes',
                'csv-import-column-validation'
            ];

            if (columnClasses[index]) {
                td.classList.add(
                    columnClasses[index]
                );
            }

            if (index === 6) {
                const hasErrors =
                    Array.isArray(row.errors) &&
                    row.errors.length > 0;

                const hasWarnings =
                    Array.isArray(row.warnings) &&
                    row.warnings.length > 0;

                const hasTransformations =
                    Array.isArray(
                        row.transformations
                    ) &&
                    row.transformations.length > 0;

                if (hasErrors) {
                    td.classList.add(
                        'csv-import-validation-error'
                    );
                } else if (hasWarnings) {
                    td.classList.add(
                        'csv-import-validation-warning'
                    );
                } else if (hasTransformations) {
                    td.classList.add(
                        'csv-import-validation-transformation'
                    );
                } else {
                    td.classList.add(
                        'csv-import-validation-ok'
                    );
                }
            }

            if (index === 5) {
                td.appendChild(
                    createDevicesCsvChangesElement(
                        row
                    )
                );
            } else {
                td.textContent =
                    String(value);
            }

            tr.appendChild(td);
        });

        tbody.appendChild(tr);
    });

    if (rows.length === 0) {
        const tr =
            document.createElement('tr');

        const td =
            document.createElement('td');

        td.colSpan = 7;
        td.textContent =
            '表示対象の行はありません';

        tr.appendChild(td);
        tbody.appendChild(tr);
    }
}


export function renderDevicesCsvImportPreview(
    data
) {
    devicesCsvImportToken =
        data.import_token || null;

    devicesCsvImportRows =
        Array.isArray(data.rows)
            ? data.rows
            : [];

    devicesCsvImportSummary =
        data.summary || {};

    devicesCsvImportCanCommit =
        data.can_commit === true;

    const result =
        document.getElementById(
            'devices-csv-import-result'
        );

    if (result) {
        result.hidden = false;
    }

    setTextContent(
        'devices-csv-total',
        devicesCsvImportSummary.total || 0
    );

    setTextContent(
        'devices-csv-insert',
        devicesCsvImportSummary.insert || 0
    );

    setTextContent(
        'devices-csv-update',
        devicesCsvImportSummary.update || 0
    );

    setTextContent(
        'devices-csv-unchanged',
        devicesCsvImportSummary.unchanged || 0
    );

    setTextContent(
        'devices-csv-error',
        devicesCsvImportSummary.error || 0
    );

    setTextContent(
        'devices-csv-import-expiry',
        data.expires_at
            ? `有効期限: ${formatStatusTime(
                data.expires_at
            )}`
            : ''
    );

    setTextContent(
        'devices-csv-warning',
        devicesCsvImportSummary.warning || 0
    );

    const errorCount =
        Number(
            devicesCsvImportSummary.error
        ) || 0;

    const warningCount =
        Number(
            devicesCsvImportSummary.warning
        ) || 0;

    if (errorCount > 0) {
        setTextContent(
            'devices-csv-import-message',
            'エラー行があります。CSVを修正して再度検証してください。警告だけの場合は取込を実行できます。'
        );
    } else if (
        devicesCsvImportCanCommit &&
        warningCount > 0
    ) {
        setTextContent(
            'devices-csv-import-message',
            '警告があります。内容を確認したうえで取込を実行できます。'
        );
    } else if (
        devicesCsvImportCanCommit
    ) {
        setTextContent(
            'devices-csv-import-message',
            '検証に成功しました。内容を確認して取込を実行してください。'
        );
    } else {
        setTextContent(
            'devices-csv-import-message',
            '変更対象はありません。'
        );
    }


    renderDevicesCsvImportRows();
    updateDevicesCsvImportButtons();
}


function setCsvFileError(message) {
    const input = document.getElementById('devices-csv-import-file');
    setInputError(input, document.getElementById('devices-csv-import-file-error'), message);
    if (message) input?.focus();
}

export async function previewDevicesCsvImport() {
    if (
        appState.isDevicesCsvImporting ||
        !canStartDeviceCsvDownload()
    ) {
        return;
    }

    const fileInput =
        document.getElementById(
            'devices-csv-import-file'
        );

    const file =
        fileInput?.files?.[0];
    setCsvFileError('');

    if (!file) {
        setCsvFileError('取込CSVを選択してください');
        return;
    }

    if (
        file.size <= 0 ||
        file.size >
            2 * 1024 * 1024
    ) {
        setCsvFileError('CSVファイルは2MB以下にしてください');
        return;
    }

    const formData =
        new FormData();

    formData.append(
        'revision',
        String(appState.dataRevision)
    );

    formData.append(
        'devices_csv',
        file
    );

    try {
        appState.isDevicesCsvImporting = true;

        setBusy(
            true,
            'CSV検証中...'
        );

        const data =
            await apiFetch(
                'preview_devices_csv_import',
                {
                    method: 'POST',
                    body: formData
                }
            );

        renderDevicesCsvImportPreview(
            data
        );


    } catch (err) {
        console.error(err);

        devicesCsvImportToken = null;
        devicesCsvImportCanCommit =
            false;

        setTextContent(
            'devices-csv-import-message',
            `検証エラー: ${err.message}`
        );

        if (err.status === 401) return;
        showToast(
            `CSV検証エラー: ${err.message}`,
            'error'
        );

    } finally {
        appState.isDevicesCsvImporting = false;
        setBusy(false);
        updateDevicesCsvImportButtons();
    }
}


export async function commitDevicesCsvImport() {
    if (
        appState.isDevicesCsvImporting ||
        !devicesCsvImportToken ||
        !devicesCsvImportCanCommit
    ) {
        return;
    }

    const summary =
        devicesCsvImportSummary || {};

    if (
        !confirm(
            'CSV取込を実行しますか?\n\n' +
            `新規: ${Number(summary.insert) || 0}件\n` +
            `更新: ${Number(summary.update) || 0}件\n` +
            `変更なし: ${Number(summary.unchanged) || 0}件\n` +
            `警告行: ${Number(summary.warning) || 0}件\n\n` +
            (
                Number(summary.warning) > 0
                    ? '警告内容を確認したうえで取込を実行してください。\n'
                    : ''
            ) +
            '配置と接続は変更されません。'
        )
    ) {
        return;
    }

    try {
        appState.isDevicesCsvImporting = true;

        setBusy(
            true,
            'CSV取込を実行中...'
        );

        const data =
            await apiFetch(
                'commit_devices_csv_import',
                {
                    method: 'POST',
                    headers: {
                        'Content-Type':
                            'application/json'
                    },
                    body: JSON.stringify({
                        import_token:
                            devicesCsvImportToken,
                        revision:
                            appState.dataRevision
                    })
                }
            );

        devicesCsvImportToken = null;
        devicesCsvImportCanCommit =
            false;

        markSaved(
            data.revision,
            data.saved_at ||
                new Date()
        );

        const responseMonitorRevision =
            Number(
                data.monitor_revision
            );

        if (
            Number.isInteger(
                responseMonitorRevision
            ) &&
            responseMonitorRevision > 0
        ) {
            appState.monitorRevision =
                responseMonitorRevision;
        }

        finishDevicesCsvImport();

        await loadData();

        updateLedgerFilters();
        renderLedgerTable();

        showStatusMessage(
            data.message ||
                '機器台帳CSVを取り込みました',
            'success'
        );

    } catch (err) {
        console.error(err);

        if (err.status === 409) {
            markConflict(
                err.message
            );
        }

        if (err.status === 401) return;
        showToast(
            `CSV取込エラー: ${err.message}`,
            'error'
        );

    } finally {
        appState.isDevicesCsvImporting = false;
        setBusy(false);
        updateDevicesCsvImportButtons();
    }
}


