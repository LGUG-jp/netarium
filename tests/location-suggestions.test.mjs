import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildLocationSuggestions } from '../public/js/ui/location-suggestions.js';

test('詳細設置場所だけを候補化し、空欄と重複を除去する', () => {
    const values = buildLocationSuggestions([
        { facility: ' 本庁舎 ', floor: '1F', location: '収納棚' },
        { facility: '本庁舎', floor: '１F', location: '収納棚' },
        { facility: '', floor: null, location: '  ' }
    ], [{ facility: '本庁舎', floor: '2F' }, { facility: '別庁舎', floor: '1F' }]);
    assert.deepEqual(Object.keys(values), ['location']);
    assert.deepEqual(values.location, ['収納棚']);
});
