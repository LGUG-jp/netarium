/**
 * Netarium - 機器監視状態
 */

export function resetDeviceMonitoringState(device) {
    device.status = 'unknown';
    device.last_checked_at = null;
    device.last_response_ms = null;
    device.last_error = null;
}

export function getDeviceStatusLabel(status) {
    switch (status) {
        case 'green': return 'OK';
        case 'red': return 'NG';
        case 'checking': return '確認中';
        default: return '未確認';
    }
}

/** 確認中は過去の結果を今回の応答・エラーとして案内しない。 */
export function getDeviceStatusDescription(device) {
    const label = getDeviceStatusLabel(device.status);
    if (device.status === 'checking') return label;
    const parts = [label];
    if (device.status === 'green' && device.last_response_ms != null) {
        parts.push(`応答時間: ${device.last_response_ms} ms`);
    }
    if (device.last_checked_at) parts.push(`最終確認: ${device.last_checked_at}`);
    if (device.last_error) parts.push(`エラー: ${device.last_error}`);
    return parts.join(' / ');
}
