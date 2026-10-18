import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    DEFAULT_CANVAS_NOTE, CANVAS_NOTE_LIMITS, normalizeCanvasNote, toSaveCanvasNote, validateCanvasNote
} from '../public/js/core/canvas-note-data.js';
import {
    appState, getCurrentCanvasNotes, normalizeView, recalculateNextIds, removeDevicesFromState,
    validateAllDataBeforeSave
} from '../public/js/core/state.js';
import {
    applyResourceSaveResult, buildResourceSave, confirmedResourceResult, createPendingResourceSave,
    createResourceBaseline, hasResourceChangesSince, inspectPendingResourceSave, reloadResourceFromData,
    resetResourceBaseline, resourceSaveValidationData
} from '../public/js/core/resource-save.js';

const note = (id, view_id = 1, text = '') => normalizeCanvasNote({ id, view_id, text });
const fixture = (notes = []) => {
    Object.assign(appState, {
        views: [1, 2].map(id => normalizeView({ id, resource_revision: 1, name: `View-${id}` })),
        devices: [], placements: [], links: [], canvasNotes: notes, currentViewId: 1,
        selectedCanvasNoteId: null, selectedPlacementIds: new Set(), editingDeviceId: null, editingLinkId: null,
        floorPlans: [], deviceImages: [], floorPlanAutoFittedViews: new Set(), viewStates: new Map(),
        resourceConflicts: { devices: new Map(), views: new Map() }
    });
    resetResourceBaseline(appState);
    recalculateNextIds();
};
const response = (pending, canvas_notes, id_maps = {}) => ({
    revision: 2, id_maps, devices: [], placements: [], links: [], canvas_notes,
    views: pending.payload.views.filter(row => row.operation !== 'delete').map(row => ({
        ...row.view, id: Number(id_maps.views?.[row.id] ?? row.id), resource_revision: (row.expected_revision || 0) + 1
    })),
    deleted_device_ids: [], deleted_view_ids: [],
    affected_view_ids: pending.payload.views.map(row => Number(id_maps.views?.[row.id] ?? row.id))
});

test('メモの既定値と保存形式は改行・空白を維持して色を大文字化する', () => {
    const normalized = normalizeCanvasNote({ id: '1', view_id: '2', text: '  <script>\nメモ\n  ', background_color: '#aabbcc', text_color: '#ddee00' });
    assert.deepEqual(normalized, { ...DEFAULT_CANVAS_NOTE, id: 1, view_id: 2, text: '  <script>\nメモ\n  ', background_color: '#AABBCC', text_color: '#DDEE00' });
    assert.deepEqual(toSaveCanvasNote(normalized), normalized);
    assert.equal(normalizeCanvasNote({ id: 1, view_id: 1, x: Infinity, width: 0, height: 3000 }).x, 0);
    assert.equal(normalizeCanvasNote({ id: 1, view_id: 1, width: 0 }).width, CANVAS_NOTE_LIMITS.minWidth);
    assert.equal(normalizeCanvasNote({ id: 1, view_id: 1, height: 3000 }).height, CANVAS_NOTE_LIMITS.maxHeight);
});

test('本文のUnicode文字数・数値範囲・参照・重複を保存前に検証する', () => {
    const valid = note(1, 1, '😀'.repeat(CANVAS_NOTE_LIMITS.maxTextLength));
    assert.doesNotThrow(() => validateCanvasNote(valid));
    assert.throws(() => validateCanvasNote({ ...valid, text: `${valid.text}字` }), /1000文字/);
    for (const invalid of [
        { x: -1 }, { y: Infinity }, { width: 119 }, { width: 2001 }, { height: 59 }, { height: 2001 },
        { font_size: 11 }, { font_size: 33 }, { background_opacity: 0.19 }, { background_opacity: 1.01 },
        { background_color: 'red' }, { text_color: '#ABC' }
    ]) assert.throws(() => validateCanvasNote({ ...valid, ...invalid }));
    for (const boundary of [
        { width: 120, height: 60, font_size: 12, background_opacity: 0.2 },
        { width: 2000, height: 2000, font_size: 32, background_opacity: 1 }
    ]) assert.doesNotThrow(() => validateCanvasNote({ ...valid, ...boundary }));
    fixture([note(1, 99)]);
    assert.throws(() => validateAllDataBeforeSave(), /ビューが見つかりません/);
    appState.canvasNotes = [note(1), note(1)];
    assert.throws(() => validateAllDataBeforeSave(), /重複/);
});

test('メモ作成はビュー集約payloadと送信snapshotに入り、後続変更を分離する', () => {
    fixture();
    appState.canvasNotes.push(note(appState.nextCanvasNoteId++, 1, '送信本文'));
    const payload = buildResourceSave();
    assert.deepEqual(payload.devices, []);
    assert.equal(payload.views[0].expected_revision, 1);
    assert.deepEqual(payload.views[0].canvas_notes, [toSaveCanvasNote(appState.canvasNotes[0])]);
    validateAllDataBeforeSave(resourceSaveValidationData(payload));
    const pending = createPendingResourceSave(payload);
    assert.deepEqual(pending.newIds.canvas_notes, [1]);
    assert.equal(hasResourceChangesSince(pending), false);
    appState.canvasNotes[0].text = '後続本文';
    appState.canvasNotes[0].x = 30;
    assert.equal(hasResourceChangesSince(pending), true);
    assert.equal(pending.snapshot.canvasNotes[0].text, '送信本文');
    assert.equal(payload.views[0].canvas_notes[0].x, 0);
    assert.equal(getCurrentCanvasNotes().length, 1);
    appState.currentViewId = 2;
    assert.deepEqual(getCurrentCanvasNotes(), []);
});

test('新規ビューとメモのID置換は後続編集・選択と未送信仮ID衝突を保持する', () => {
    fixture();
    appState.views.push(normalizeView({ id: 3, name: '新規ビュー' }));
    appState.currentViewId = 3;
    appState.canvasNotes.push(note(1, 3, '送信本文'));
    const pending = createPendingResourceSave(buildResourceSave());
    appState.canvasNotes[0].text = '後続本文';
    appState.canvasNotes.push(note(2, 2, '未送信メモ'));
    appState.selectedCanvasNoteId = 2;
    const maps = applyResourceSaveResult(response(pending, [note(2, 30, '送信本文')], { views: { 3: 30 }, canvas_notes: { 1: 2 } }), pending);
    assert.deepEqual(maps.canvas_notes, { 1: 2, 2: 3 });
    assert.equal(appState.currentViewId, 30);
    assert.equal(appState.selectedCanvasNoteId, 3);
    assert.deepEqual(appState.canvasNotes.map(row => [row.id, row.view_id, row.text]), [[2, 30, '後続本文'], [3, 2, '未送信メモ']]);
    assert.equal(appState.nextCanvasNoteId, 4);
    const next = buildResourceSave();
    assert.equal(next.views.find(row => row.id === 30).expected_revision, 1);
    assert.equal(next.views.find(row => row.id === 30).canvas_notes[0].id, 2);
    assert.equal(next.views.find(row => row.id === 2).canvas_notes[0].id, 3);
    appState.selectedCanvasNoteId = 2;
    const followup = createPendingResourceSave(next);
    applyResourceSaveResult(response(followup, [note(2, 30, '後続本文'), note(300, 2, '未送信メモ')], { canvas_notes: { 3: 300 } }), followup);
    assert.equal(appState.selectedCanvasNoteId, 2);
    assert.deepEqual(buildResourceSave(), { devices: [], views: [] });
});

test('新規メモの応答を失った場合はID一致を推測せず、既存メモは送信本文で確定を確認する', () => {
    fixture();
    appState.canvasNotes.push(note(1, 1, '新規'));
    const created = createPendingResourceSave(buildResourceSave());
    const remote = { ...appState, views: appState.views.map(row => ({ ...row, resource_revision: 2 })), canvasNotes: [note(90, 1, '新規')] };
    assert.equal(inspectPendingResourceSave(created, appState), 'retry');
    assert.equal(inspectPendingResourceSave(created, remote), 'unknown');
    fixture([note(1, 1, '保存前')]);
    appState.canvasNotes[0].text = '送信本文';
    const pending = createPendingResourceSave(buildResourceSave());
    const saved = { revision: 2, devices: [], placements: [], links: [], views: appState.views.map(row => ({ ...row, resource_revision: 2 })), canvas_notes: [note(1, 1, '送信本文')] };
    appState.canvasNotes[0].text = '後続本文';
    assert.equal(inspectPendingResourceSave(pending, saved), 'saved');
    applyResourceSaveResult(confirmedResourceResult(pending, saved), pending);
    assert.equal(appState.canvasNotes[0].text, '後続本文');
    assert.equal(buildResourceSave().views[0].expected_revision, 2);
});

test('旧loadは空配列、canvas_notesのない保存応答は編集を消さず不完全として拒否する', () => {
    const baseline = createResourceBaseline({ views: [normalizeView({ id: 1, resource_revision: 1, name: '旧ビュー' })] });
    assert.deepEqual(baseline.views.get(1).canvas_notes, []);
    fixture([note(1)]);
    appState.canvasNotes[0].text = '保存対象';
    const pending = createPendingResourceSave(buildResourceSave());
    const old = response(pending, []);
    delete old.canvas_notes;
    assert.throws(() => applyResourceSaveResult(old, pending), /保存応答が不完全/);
    assert.equal(appState.canvasNotes[0].text, '保存対象');
});

test('競合ビュー再読込はメモを置換し、別ビューの未送信仮IDと選択を退避する', () => {
    fixture([note(1, 1, '旧本文')]);
    appState.canvasNotes.push(note(2, 2, '独立編集'));
    appState.selectedCanvasNoteId = 2;
    const remote = { devices: [], placements: [], links: [], views: appState.views.map(row => ({ ...row, resource_revision: 4 })), canvas_notes: [note(2, 1, 'リモート本文')] };
    const maps = reloadResourceFromData('views', 1, remote);
    assert.deepEqual(maps.canvas_notes, { 2: 3 });
    assert.equal(appState.selectedCanvasNoteId, 3);
    assert.deepEqual(appState.canvasNotes.map(row => [row.id, row.view_id, row.text]), [[3, 2, '独立編集'], [2, 1, 'リモート本文']]);
    assert.deepEqual(buildResourceSave().views.map(row => row.id), [2]);
});

test('保存した新規メモの選択はサーバーIDに追従し採番対応欠落では変更しない', () => {
    fixture();
    appState.canvasNotes.push(note(1, 1, '作成本文'));
    appState.selectedCanvasNoteId = 1;
    const pending = createPendingResourceSave(buildResourceSave());
    assert.throws(() => applyResourceSaveResult(response(pending, [note(50, 1, '作成本文')]), pending), /ID対応/);
    assert.equal(appState.selectedCanvasNoteId, 1);
    assert.equal(appState.canvasNotes[0].id, 1);
    applyResourceSaveResult(response(pending, [note(50, 1, '作成本文')], { canvas_notes: { 1: 50 } }), pending);
    assert.equal(appState.selectedCanvasNoteId, 50);
    assert.deepEqual(buildResourceSave(), { devices: [], views: [] });
});

test('保存応答待ちに削除したメモは復元せず次のビュー世代で削除を保存する', () => {
    fixture([note(1, 1, '保存前')]);
    appState.canvasNotes[0].text = '送信本文';
    appState.selectedCanvasNoteId = 1;
    const pending = createPendingResourceSave(buildResourceSave());
    appState.canvasNotes = [];
    applyResourceSaveResult(response(pending, [note(1, 1, '送信本文')]), pending);
    assert.deepEqual(appState.canvasNotes, []);
    assert.equal(appState.selectedCanvasNoteId, null);
    const next = buildResourceSave().views[0];
    assert.equal(next.expected_revision, 2);
    assert.deepEqual(next.canvas_notes, []);
});

test('機器削除はメモを消さず、ビュー削除はそのメモと選択を除く', () => {
    fixture([note(1)]);
    appState.devices = [{ id: 10, name: '機器', type: 'switch', resource_revision: 1 }];
    appState.placements = [{ id: 100, device_id: 10, view_id: 1, x: 0, y: 0 }];
    resetResourceBaseline(appState);
    removeDevicesFromState([10]);
    assert.equal(appState.canvasNotes.length, 1);
    assert.deepEqual(buildResourceSave().views, []);
    appState.selectedCanvasNoteId = 1;
    reloadResourceFromData('views', 1, { devices: [], placements: [], links: [], views: [appState.views[1]], canvas_notes: [] });
    assert.deepEqual(appState.canvasNotes, []);
    assert.equal(appState.selectedCanvasNoteId, null);
});
