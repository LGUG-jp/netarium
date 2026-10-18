export function setInputError(input, error, message) {
    if (!input || !error) return;
    const described = new Set((input.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean));
    if (message) {
        described.add(error.id);
        input.setAttribute('aria-invalid', 'true');
        input.classList.add('is-invalid');
    } else {
        described.delete(error.id);
        input.removeAttribute('aria-invalid');
        input.classList.remove('is-invalid');
    }
    if (described.size) input.setAttribute('aria-describedby', [...described].join(' '));
    else input.removeAttribute('aria-describedby');
    error.textContent = message ? `! ${message}` : '';
    error.hidden = !message;
}
