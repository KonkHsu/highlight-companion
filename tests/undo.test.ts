import test from 'node:test';
import assert from 'node:assert/strict';
import { capture } from '../src/source';
import { appendEntries, newDocument, parseDocument, arrange } from '../src/document';
import { removeEntries, removeHighlights, selectedEntryIds } from '../src/undo';
import { emptyState, Binding, cloneData } from '../src/model';
import { commitUndo, finishPending, Storage } from '../src/engine';
const binding: Binding = { id: 'book', source: '课本.md', target: '重点.md' };
function sample() {
  const captureResult = capture('# 第一章\n\n==词==与==词==。 ^existing\n\n# 第二章\n\n==另一词==', binding.target);
  const note = appendEntries(newDocument(binding, '课本'), binding, captureResult.chapters, captureResult.entries);
  return { ...captureResult, note };
}
test('undo targets a stable occurrence, preserving same-word siblings and shared block anchors', () => {
  const s = sample(), [entry, sibling] = s.entries;
  const next = removeHighlights(s.source, [entry]);
  assert(!next.includes(`hc-h:${entry.id}`));
  assert(next.includes(`hc-h:${sibling.id}`));
  assert(next.includes('^existing'));
  assert.equal(capture(next, binding.target).entries.length, 0);
  const start = s.source.indexOf('==词==');
  assert.deepEqual(selectedEntryIds(s.source, s.entries, start + 2, start + 2), [entry.id]);
});
test('undo preserves changed source text and supports already unhighlighted text', () => {
  const s = sample();
  assert.match(removeHighlights(s.source.replace('==词==', '==修改后的词=='), [s.entries[0]]), /修改后的词与==词==/);
  assert.match(removeHighlights(s.source.replace('==词==', '词'), [s.entries[0]]), /词与==词==/);
});
test('undo rejects missing, duplicated, or damaged source markers', () => {
  const s = sample(), e = s.entries[0];
  assert.throws(() => removeHighlights(s.source.replace(`<!--hc-h:${e.id}-->`, ''), [e]), /唯一/);
  assert.throws(() => removeHighlights(s.source + `<!--hc-h:${e.id}-->`, [e]), /唯一/);
  assert.throws(() => removeHighlights(s.source.replace(`#^hc-${e.id}>`, '#^different>'), [e]), /链接/);
});
test('grouped and cross-chapter undo removes only selected entries and preserves group explanations', () => {
  const s = sample();
  const grouped = arrange(s.note, s.entries.slice(0, 2).map(e => e.id), { type: 'create', title: '分组' });
  const g = parseDocument(grouped).groups[0];
  const withNote = grouped.slice(0, g.bodyFrom) + '\n保留分组说明\n' + grouped.slice(g.bodyFrom);
  const result = removeEntries(withNote, [s.entries[0].id, s.entries[2].id]);
  assert.equal(parseDocument(result.note).entries.length, 1);
  assert.equal(parseDocument(result.note).groups.length, 1);
  assert(result.note.includes('保留分组说明'));
});
test('journal resumes a half-completed undo after restart and retains a restore snapshot', async () => {
  const s = sample(), state = emptyState(); state.bindings = [binding];
  const targetAfter = removeEntries(s.note, [s.entries[0].id]).note;
  const record = { binding: binding.id, sourceBefore: s.source, sourceAfter: removeHighlights(s.source, [s.entries[0]]), targetBefore: s.note, targetAfter, count: 1 };
  const files = new Map([[binding.source, s.source], [binding.target, s.note]]); let fail = true;
  let persisted = cloneData(state);
  const io: Storage = { read: async p => files.get(p)!, change: async (p, fn) => { if (p === binding.target && fail) { fail = false; throw new Error('disk'); } files.set(p, fn(files.get(p)!)); }, save: async () => { persisted = cloneData(state); } };
  await assert.rejects(commitUndo(state, io, record), /disk/);
  assert.equal(files.get(binding.source), record.sourceAfter);
  const restarted = cloneData(persisted);
  await finishPending(restarted, { ...io, save: async () => {} });
  assert.equal(files.get(binding.target), targetAfter);
  assert.deepEqual(restarted.lastUndo, record);
  assert.equal(restarted.undoPending, undefined);
  await finishPending(restarted, io);
  assert.equal(files.get(binding.target), targetAfter);
});
test('undo checks both documents and journals successfully before any write', async () => {
  const s = sample(), state = emptyState(); state.bindings = [binding];
  const record = { binding: binding.id, sourceBefore: s.source, sourceAfter: '', targetBefore: s.note, targetAfter: '', count: 1 };
  let writes = 0;
  const io: Storage = { read: async p => p === binding.source ? s.source : s.note + 'changed', change: async () => { writes++; }, save: async () => {} };
  await assert.rejects(commitUndo(state, io, record), /笔记已变化/); assert.equal(writes, 0);
  state.undoPending = undefined;
  await assert.rejects(commitUndo(state, { ...io, save: async () => { throw new Error('save'); } }, record), /save/);
  assert.equal(writes, 0); assert.equal(state.undoPending, undefined);
});
