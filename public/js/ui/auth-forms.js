import { validateAuthForm } from './auth-validation.js';

export function initializeAuthForms(root = document) {
    root.querySelectorAll('form[data-auth-form]').forEach(form => {
        form.noValidate = true;
        form.addEventListener('input', () => validateAuthForm(form));
        form.addEventListener('submit', event => {
            if (!validateAuthForm(form, { submit: true })) event.preventDefault();
        });
    });
}

initializeAuthForms();
