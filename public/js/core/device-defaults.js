import { DEVICE_TYPES } from './constants.js';
import { appState } from './state.js';

/**
 * 機器種別ごとの初期名称
 */
export function getDefaultDeviceName(type) {
    const definition =
        DEVICE_TYPES[type] ||
        DEVICE_TYPES.other;

    const baseName = definition.label;

    const sameTypeCount = appState.devices.filter(
        device => device.type === type
    ).length;

    return `${baseName}${sameTypeCount + 1}`;
}
