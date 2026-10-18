/**
 * Netarium - イベントバス
 * コンポーネント間の疎結合な連携を行うためのイベント管理
 */

export class EventBus {
    constructor() {
        this.listeners = new Map();
    }

    /**
     * イベントリスナーを登録する
     * @param {string} event イベント名
     * @param {Function} callback コールバック関数
     * @returns {Function} 登録解除用関数
     */
    on(event, callback) {
        if (!this.listeners.has(event)) {
            this.listeners.set(event, new Set());
        }
        this.listeners.get(event).add(callback);
        return () => this.off(event, callback);
    }

    /**
     * イベントリスナーを解除する
     * @param {string} event イベント名
     * @param {Function} callback コールバック関数
     */
    off(event, callback) {
        if (this.listeners.has(event)) {
            this.listeners.get(event).delete(callback);
        }
    }

    /**
     * イベントを発行する
     * @param {string} event イベント名
     * @param {...*} args 引数
     */
    emit(event, ...args) {
        if (this.listeners.has(event)) {
            for (const callback of this.listeners.get(event)) {
                try {
                    callback(...args);
                } catch (err) {
                    console.error(`[EventBus] Error in listener for event "${event}":`, err);
                }
            }
        }
    }
}

export const eventBus = new EventBus();
