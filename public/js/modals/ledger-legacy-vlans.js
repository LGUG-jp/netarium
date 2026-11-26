import { deleteLegacyLinkVlan, legacyVlanEndpoints, unmigratedVlanForLink } from '../core/legacy-link-vlans.js';
import { getPendingSave, isSaveInFlight } from '../core/save-queue.js';
import { appState } from '../core/state.js';
import { isCurrentUserAdmin } from '../ui/access-control.js';
import { showToast } from '../ui/toast.js';
import { confirmPortVlanAction } from './ledger-port-vlan-dialog.js';

let deleting = false;

export async function deleteUnmigratedVlan(record, { canAct = () => true, onBusyChange = () => {} } = {}) {
    const available = () => isCurrentUserAdmin() && !appState.authExpired && !appState.isPinging &&
        !getPendingSave() && !isSaveInFlight() && canAct();
    if (deleting || !available() || unmigratedVlanForLink(record.link_id) !== record) return false;
    const link = appState.links.find(row => Number(row.id) === Number(record.link_id));
    const linkRevision = Number(link?.resource_revision);
    if (!linkRevision) return false;
    const revision = appState.dataRevision;
    deleting = true;
    try {
        const confirmed = await confirmPortVlanAction({
            title: '未移行VLANの削除',
            lines: [
                `共通接続 #${record.link_id}`,
                `未移行VLAN：${record.vlan}`,
                'ポートのVLAN設定は変更せず、未移行VLANを削除します。',
            ],
            comparison: legacyVlanEndpoints(link).map(({ deviceName, portName, vlan }) => ({
                label: deviceName,
                endpoint: `ポート：${portName ?? '未指定'}`,
                value: `現在の VLAN設定：${portName ? (vlan || '未設定') : '—'}`,
            })),
            confirmLabel: '未移行設定削除',
            destructive: true,
        });
        if (!confirmed || !available()) return false;
        onBusyChange(true);
        const result = await deleteLegacyLinkVlan(record, linkRevision, revision);
        showToast(result.audit_warning ? '未移行VLANを削除しましたが、監査ログを記録できませんでした。' :
            '未移行VLANを削除しました。', result.audit_warning ? 'warning' : 'success');
        return true;
    } catch (error) {
        showToast(`未移行VLANを削除できませんでした：${error.message}`, 'warning');
        return false;
    } finally {
        deleting = false;
        onBusyChange(false);
    }
}
