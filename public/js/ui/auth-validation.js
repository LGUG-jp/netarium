import { setInputError } from './field-errors.js';

const passwordEncoder = new TextEncoder();

function newPasswordError(value) {
    let characters = 0;
    for (const character of value) {
        const codePoint = character.codePointAt(0);
        if (codePoint === 0 || (codePoint >= 0xD800 && codePoint <= 0xDFFF)) {
            return 'パスワードに使用できない文字が含まれています';
        }
        characters++;
    }
    if (passwordEncoder.encode(value).length > 512) {
        return 'パスワードは512バイト以内で入力してください';
    }
    if (characters > 128) return 'パスワードは128文字以内で入力してください';
    if (characters < 12) return 'パスワードは12文字以上で入力してください';
    return '';
}

function validateInput(input, submit) {
    const value = input.value;
    const kind = input.dataset.authKind;
    let message = '';
    if (kind === 'password' && input.dataset.authCreate === 'true' && (value || submit)) {
        message = newPasswordError(value);
    } else if (submit && !value) {
        message = '入力してください';
    } else if (kind === 'username' && (value || submit)) {
        if (input.dataset.authCreate === 'true') {
            const username = value.replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, '');
            if (!/^[A-Za-z0-9_.-]{3,50}$/.test(username)) {
                message = 'ユーザー名は3～50文字の半角英数字、_、-、.で入力してください';
            }
        } else if (value.length > 50) {
            message = 'ユーザー名は50文字以内で入力してください';
        }
    }
    if (!message && input.dataset.authMatch && (value || submit)) {
        const original = document.getElementById(input.dataset.authMatch);
        if (original && value !== original.value) message = '確認用パスワードが一致しません';
    }
    setInputError(input, document.getElementById(`${input.id}-error`), message);
    return !message;
}

export function validatePasswordInput(input, { submit = false } = {}) {
    if (!input) return false;
    const valid = validateInput(input, submit);
    if (!valid && submit) input.focus();
    return valid;
}

export function validateAuthForm(form, { submit = false } = {}) {
    if (!form) return false;
    let firstInvalid = null;
    form.querySelectorAll('[data-auth-kind]').forEach(input => {
        if (!validateInput(input, submit) && !firstInvalid) firstInvalid = input;
    });
    if (firstInvalid && submit) firstInvalid.focus();
    return !firstInvalid;
}

export function clearAuthErrors(root) {
    root?.querySelectorAll('[data-auth-kind]').forEach(input => {
        setInputError(input, document.getElementById(`${input.id}-error`), '');
    });
}
