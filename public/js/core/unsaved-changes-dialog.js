import { registerModalOpen, registerModalClose } from './modal-focus.js';

let activeChoice = null;

/** 未適用の変更を適用・編集継続・破棄のいずれかで扱う。 */
export function chooseUnsavedChanges(message = '未適用の変更があります。どうしますか？') {
    // 確認中の別操作は進めず、先に開いた確認と入力を維持する。
    if (activeChoice) return Promise.resolve('cancel');

    const overlay = document.createElement('div');
    overlay.id = 'unsaved-changes-overlay';
    overlay.className = 'placement-manager-overlay unsaved-changes-overlay';
    const dialog = document.createElement('section');
    dialog.className = 'placement-manager-dialog unsaved-changes-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'unsaved-changes-title');
    dialog.setAttribute('aria-describedby', 'unsaved-changes-message');
    const header = document.createElement('div');
    header.className = 'placement-manager-header unsaved-changes-header';
    const title = document.createElement('h2');
    title.id = 'unsaved-changes-title';
    title.textContent = '変更の確認';
    header.appendChild(title);
    const description = document.createElement('p');
    description.id = 'unsaved-changes-message';
    description.className = 'unsaved-changes-message';
    description.textContent = message;
    const actions = document.createElement('div');
    actions.className = 'unsaved-changes-actions';
    let resolveChoice;
    const choice = new Promise(resolve => { resolveChoice = resolve; });
    const finish = value => {
        if (activeChoice !== choice) return;
        activeChoice = null;
        overlay.hidden = true;
        registerModalClose('unsaved-changes');
        overlay.remove();
        resolveChoice(value);
    };
    let cancelButton;
    for (const [value, label, className] of [
        ['discard', '変更を取り消す', 'btn btn-danger btn-sm'],
        ['cancel', '編集を続ける', 'btn btn-secondary btn-sm'],
        ['save', '適用', 'btn btn-primary btn-sm']
    ]) {
        const button = document.createElement('button');
        button.id = `unsaved-changes-${value}`;
        button.type = 'button';
        button.className = className;
        button.textContent = label;
        button.addEventListener('click', () => finish(value));
        actions.appendChild(button);
        if (value === 'cancel') cancelButton = button;
    }
    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'modal-close-btn';
    closeButton.setAttribute('aria-label', '閉じる');
    closeButton.textContent = '×';
    closeButton.addEventListener('click', () => finish('cancel'));
    header.appendChild(closeButton);
    overlay.addEventListener('keydown', event => {
        if (event.key !== 'Tab') event.stopPropagation();
    });
    dialog.appendChild(header);
    dialog.appendChild(description);
    dialog.appendChild(actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    activeChoice = choice;
    registerModalOpen('unsaved-changes', overlay, cancelButton, { onClose: () => finish('cancel') });
    return choice;
}
