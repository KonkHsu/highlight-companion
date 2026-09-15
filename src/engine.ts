import { Binding, Pending, State, UndoRecord } from './model';
import { appendEntries } from './document';
export interface Storage {
  read(path: string): Promise<string>;
  change(path: string, update: (text: string) => string): Promise<void>;
  save(): Promise<void>;
}
/** A persisted, idempotent two-file operation. Never undo or overwrite unrelated edits. */
export async function finishPending(state: State, io: Storage) {
  if (state.undoPending) { await finishUndo(state, io); }
  const p = state.pending;
  if (!p) return;
  const b = state.bindings.find(b => b.id === p.binding);
  if (!b) throw new Error('待恢复收录的课本绑定丢失。');
  // Validate destination before changing the source.
  appendEntries(await io.read(b.target), b, p.chapters, p.entries);
  await io.change(b.source, current => {
    if (current === p.before) return p.after;
    if (current === p.after) return current;
    if (p.entries.every(e => current.includes(`<!--hc-h:${e.id}-->`) && current.includes('^' + e.sourceBlock))) return current;
    throw new Error('上次收录未完成，原文已变化。请恢复原文后执行“恢复未完成收录”；重点笔记未被覆盖。');
  });
  await io.change(b.target, current => appendEntries(current, b, p.chapters, p.entries));
  state.pending = undefined;
  try { await io.save(); } catch (error) { state.pending = p; throw error; }
}
export async function commitUndo(state: State, io: Storage, record: UndoRecord, restoring = false) {
  if (state.pending || state.undoPending) throw new Error('请先恢复上次未完成的操作。');
  state.undoPending = { ...record, restoring };
  try { await io.save(); } catch (error) { state.undoPending = undefined; throw error; }
  await finishUndo(state, io);
}
async function finishUndo(state: State, io: Storage) {
  const p = state.undoPending!;
  const binding = state.bindings.find(b => b.id === p.binding);
  if (!binding) throw new Error('待恢复撤销的课本绑定丢失。');
  const check = (current: string, before: string, after: string) => {
    if (current !== before && current !== after) throw new Error('撤销期间笔记已变化，已停止写入。请恢复操作前的笔记版本后重试。');
    return after;
  };
  // Check both files before mutating either. A retry also accepts either completed side.
  check(await io.read(binding.source), p.sourceBefore, p.sourceAfter);
  check(await io.read(binding.target), p.targetBefore, p.targetAfter);
  await io.change(binding.source, current => check(current, p.sourceBefore, p.sourceAfter));
  await io.change(binding.target, current => check(current, p.targetBefore, p.targetAfter));
  const previous = state.lastUndo;
  state.lastUndo = p.restoring ? undefined : { binding: p.binding, sourceBefore: p.sourceBefore, sourceAfter: p.sourceAfter, targetBefore: p.targetBefore, targetAfter: p.targetAfter, count: p.count };
  state.undoPending = undefined;
  try { await io.save(); } catch (error) { state.undoPending = p; state.lastUndo = previous; throw error; }
}
export async function commitCapture(state: State, io: Storage, binding: Binding, operation: Omit<Pending, 'binding'>) {
  if (state.pending || state.undoPending) throw new Error('请先恢复上次未完成的操作。');
  state.pending = { binding: binding.id, ...operation };
  try { await io.save(); } catch (error) { state.pending = undefined; throw error; }
  await finishPending(state, io);
}
