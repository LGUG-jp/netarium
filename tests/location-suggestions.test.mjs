import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildLocationSuggestions } from '../public/js/ui/location-suggestions.js';

test('ビューと機器の候補を統合し、空欄と重複を除去するが表記を変更しない', () => {
    const values = buildLocationSuggestions([
        { facility: ' 本庁舎 ', floor: '1F', location: '収納棚' },
        { facility: '本庁舎', floor: '１F', location: '収納棚' },
        { facility: '', floor: null, location: '  ' }
    ], [{ facility: '本庁舎', floor: '2F' }, { facility: '別庁舎', floor: '1F' }]);
    assert.deepEqual(new Set(values.facility), new Set(['本庁舎', '別庁舎']));
    assert.deepEqual(new Set(values.floor), new Set(['1F', '１F', '2F']));
    assert.deepEqual(values.location, ['収納棚']);
});
