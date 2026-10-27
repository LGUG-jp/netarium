function node(tag, className, text) {
    const element = document.createElement(tag);
    element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
}

export function createRackTransferConfirmation() {
    const element = node('div', 'rack-mount-body rack-transfer-confirmation');
    element.hidden = true;
    element.setAttribute('role', 'group');
    element.setAttribute('aria-label', '機器の移設確認');
    const message = node('p', 'rack-transfer-message');
    const flow = node('div', 'rack-transfer-flow');
    const fromCard = node('div', 'rack-transfer-card rack-transfer-from');
    const arrow = node('div', 'rack-transfer-arrow', '→');
    arrow.setAttribute('aria-hidden', 'true');
    const toCard = node('div', 'rack-transfer-card rack-transfer-to');
    flow.append(fromCard, arrow, toCard);
    const notice = node('p', 'rack-warning rack-transfer-notice', '※ 元の所属は解除されます。');
    element.append(message, flow, notice);
    function fillCard(card, label, location) {
        card.replaceChildren(
            node('span', 'rack-transfer-badge', label),
            node('strong', 'rack-transfer-rack', location.rack),
            node('span', 'rack-transfer-detail', location.detail)
        );
    }
    return {
        element,
        show({ name, from, to }) {
            message.textContent = `「${name}」を移設しますか？`;
            fillCard(fromCard, '移設元', from);
            fillCard(toCard, '移設先', to);
            element.hidden = false;
        },
        hide() { element.hidden = true; }
    };
}
