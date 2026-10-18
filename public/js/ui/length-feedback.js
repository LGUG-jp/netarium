import { setInputError } from './field-errors.js';

/** サーバーのテキスト上限と同じUnicodeコードポイントで数える。 */
export function updateLengthFeedback(input) {
    const maximum = Number(input?.dataset?.maxLength || 0);
    if (!maximum) return true;
    const length = Array.from(String(input.value || '').trim()).length;
    const overLimit = !input.disabled && length > maximum;
    const error = document.getElementById(`${input.id}-error`);
    if (overLimit) {
        setInputError(input, error, `${maximum}文字以内で入力してください`);
        input.dataset.lengthError = 'true';
    } else if (input.dataset.lengthError === 'true') {
        setInputError(input, error, '');
        delete input.dataset.lengthError;
    }
    // 単一行にはcounter DOMも更新処理も持たせない。
    if (input.tagName === 'TEXTAREA') {
        const counter = document.getElementById(`${input.id}-count`);
        if (counter) {
            counter.textContent = `${Array.from(String(input.value || '')).length}/${maximum}`;
            counter.classList.toggle('is-over-limit', overLimit);
        }
    }
    return !overLimit;
}

export function updateFormLengthFeedback(root = document) {
    root.querySelectorAll('[data-max-length]').forEach(updateLengthFeedback);
}
