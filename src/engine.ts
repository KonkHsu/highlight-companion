import { Binding, Pending, State } from './model';
import { appendEntries } from './document';
export interface Storage {
  read(path: string): Promise<string>;
  change(path: string, update: (text: string) => string): Promise<void>;
  save(): Promise<void>;
}
/** A persisted, idempotent two-file operation. Never undo or overwrite unrelated edits. */
export async function finishPending(state: State, io: Storage) {
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
export async function commitCapture(state: State, io: Storage, binding: Binding, operation: Omit<Pending, 'binding'>) {
  if (state.pending) throw new Error('请先恢复上次未完成的收录。');
  state.pending = { binding: binding.id, ...operation };
  try { await io.save(); } catch (error) { state.pending = undefined; throw error; }
  await finishPending(state, io);
}
