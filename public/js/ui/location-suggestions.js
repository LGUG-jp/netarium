import { appState } from '../core/state.js';
import { uniqueSortedValues } from '../core/utils.js';

// 候補は既存のtrim・完全一致重複除去規則に従う。値の正規化や入力制限は行わない。
export function buildLocationSuggestions(devices) {
    return {
        location: uniqueSortedValues(devices, 'location')
    };
}

export function refreshLocationSuggestions() {
    const candidates = buildLocationSuggestions(appState.devices || []);
    for (const [field, values] of Object.entries(candidates)) {
        const id = `location-suggestions-${field}`;
        let list = document.getElementById(id);
        if (!list) {
            list = document.createElement('datalist');
            list.id = id;
            document.body.appendChild(list);
        }
        list.replaceChildren(...values.map(value => {
            const option = document.createElement('option');
            option.value = value;
            return option;
        }));
    }
}

// ネイティブdatalistで文字入力、候補選択、キーボード操作を提供する。
export function bindLocationSuggestion(input, field) {
    if (!input || field !== 'location' || input.dataset.locationSuggestion) return;
    input.dataset.locationSuggestion = field;
    input.setAttribute('list', `location-suggestions-${field}`);
    input.addEventListener('focus', refreshLocationSuggestions);
}
