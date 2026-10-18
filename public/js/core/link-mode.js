import { appState } from './state.js';

// 接続元固定は作成操作の一時状態。保存snapshotには含めない。
export function resetLinkCreationState() {
    appState.linkSourceId = null;
    appState.linkSourceFixed = false;
    appState.linkSourceConnected = false;
}

export function endLinkMode() {
    appState.linkMode = false;
    resetLinkCreationState();
}
