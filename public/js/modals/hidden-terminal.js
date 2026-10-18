import { getTopModalContainer, registerModalOpen, registerModalClose } from '../core/modal-focus.js';
import { createPacketEffect } from '../canvas/hidden-packets.js';

const initialized = new WeakMap();
const MAX_INPUT = 256;
const MAX_OUTPUT = 200;
const MAX_HISTORY = 100;

// 業務stateを参照せず、許可済み入力にだけ固定のローカル応答を返す。
export function initializeHiddenTerminal() {
    const overlay = document.getElementById('hidden-terminal-overlay');
    const trigger = document.getElementById('toolbar-brand-trigger');
    if (!overlay || !trigger) return;
    if (initialized.has(overlay)) return initialized.get(overlay);
    const el = suffix => document.getElementById(`hidden-terminal-${suffix}`);
    const discovery = el('discovery');
    const consolePanel = el('console');
    const output = el('output');
    const input = el('input');
    const packets = createPacketEffect({ overlay });
    const listeners = [];
    let clicks = 0;
    let firstClick = 0;
    let history = [];
    let historyIndex = 0;
    let draft = '';

    function append(text) {
        const block = document.createElement('div');
        block.textContent = text;
        output.appendChild(block);
        while (output.children.length > MAX_OUTPUT) output.children[0].remove();
        output.scrollTop = output.scrollHeight;
    }
    function close() {
        packets.stop();
        clicks = 0;
        history = [];
        historyIndex = 0;
        draft = '';
        input.value = '';
        output.replaceChildren();
        if (overlay.hidden) return;
        overlay.hidden = true;
        registerModalClose('hidden_terminal');
    }
    function activate() {
        if (!overlay.hidden || getTopModalContainer()) return;
        const now = performance.now();
        if (clicks === 0 || now - firstClick > 3000) {
            clicks = 0;
            firstClick = now;
        }
        if (++clicks !== 5) return;
        clicks = 0;
        trigger.focus();
        discovery.hidden = false;
        consolePanel.hidden = true;
        el('title').textContent = '隠されたポートが見つかりました。';
        overlay.hidden = false;
        registerModalOpen('hidden_terminal', overlay, el('cancel'), {
            onClose: close,
            finishFloorPlan: false
        });
    }
    function enter() {
        if (overlay.hidden || discovery.hidden || getTopModalContainer() !== overlay) return;
        discovery.hidden = true;
        consolePanel.hidden = false;
        el('title').textContent = 'Netarium — Hidden Terminal';
        append("NETARIUM TERMINAL\nConnected to /dev/fun\nType 'help' to see available commands.");
        input.focus();
    }
    function submit(event) {
        event.preventDefault();
        if (overlay.hidden || consolePanel.hidden || getTopModalContainer() !== overlay) return;
        const raw = input.value;
        input.value = '';
        if (raw.length > MAX_INPUT) {
            append('Input too long (maximum 256 characters).');
            return;
        }
        const text = raw.trim();
        if (!text) return;
        const command = text.replace(/\s+/g, ' ').toLowerCase();
        history.push(text);
        if (history.length > MAX_HISTORY) history.shift();
        historyIndex = history.length;
        draft = '';
        append(`netarium:~$ ${text}`);
        switch (command) {
            case 'help':
                append('Available commands:\n  help\n  about\n  whoami\n  ping 127.0.0.1\n  clear\n  exit');
                break;
            case 'about':
                append('Netarium = Net (network) + -arium (a place to gather and observe).\nA little home for networks, cables, and their untold stories.');
                break;
            case 'whoami':
                append('You are the keeper of cables and undocumented VLANs.\nMay your diagrams always match reality.');
                break;
            case 'ping 127.0.0.1':
                append('[SIMULATION — NO PACKETS SENT]\nPING 127.0.0.1 (yourself):\nReply from 127.0.0.1: time<1ms\nReply from 127.0.0.1: time<1ms\n2 packets transmitted, 2 received (simulated).');
                break;
            case 'clear':
                output.replaceChildren();
                break;
            case 'exit':
                close();
                return;
            case 'coffee':
                append("HTTP 418 — I'm a teapot.\nコーヒーの抽出には対応していません。ネットワーク管理に専念してください。");
                break;
            case 'layer8':
                append('[JOKE DIAGNOSTIC — NOT A REAL CHECK]\nLayer 1–7: 異常なし（ということにしておきます）。\nLayer 8: キーボードの前に原因があるかもしれません。');
                break;
            case 'netarium':
                append(packets.start());
                break;
            default:
                append(`command not found: ${text}  (type 'help')`);
        }
        input.focus();
    }
    function navigateHistory(event) {
        if (event.isComposing || event.keyCode === 229) {
            if (event.key === 'Enter') event.preventDefault();
            return;
        }
        if (!['ArrowUp', 'ArrowDown'].includes(event.key) || !history.length) return;
        event.preventDefault();
        if (historyIndex === history.length) draft = input.value;
        historyIndex = Math.max(0, Math.min(history.length,
            historyIndex + (event.key === 'ArrowUp' ? -1 : 1)));
        input.value = historyIndex === history.length ? draft : history[historyIndex];
        input.setSelectionRange(input.value.length, input.value.length);
    }
    function listen(target, event, callback) {
        target.addEventListener(event, callback);
        listeners.push(() => target.removeEventListener(event, callback));
    }
    listen(trigger, 'click', activate);
    listen(el('cancel'), 'click', close);
    listen(el('close'), 'click', close);
    listen(el('enter'), 'click', enter);
    listen(el('form'), 'submit', submit);
    listen(input, 'keydown', navigateHistory);
    listen(input, 'input', () => { historyIndex = history.length; draft = input.value; });
    const dispose = () => {
        close();
        listeners.forEach(remove => remove());
        initialized.delete(overlay);
    };
    initialized.set(overlay, dispose);
    return dispose;
}
