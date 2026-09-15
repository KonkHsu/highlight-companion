import { ViewPlugin, EditorView, ViewUpdate } from '@codemirror/view';
import { editorInfoField } from 'obsidian';
import { SelectionSnapshot } from './selection';

export class SelectionMemory {
  private saved = new Map<string, { owner: object; selection: SelectionSnapshot }>();
  observe(path: string, owner: object, source: string, from: number, to: number, focused: boolean, changed = false) {
    if (changed) this.saved.delete(path);
    if (!focused) return;
    if (from === to) { this.saved.delete(path); return; }
    this.saved.set(path, { owner, selection: { source, from, to } });
  }
  forget(path: string, owner: object) { if (this.saved.get(path)?.owner === owner) this.saved.delete(path); }
  take(path: string, current: SelectionSnapshot): SelectionSnapshot {
    const cached = this.saved.get(path)?.selection; this.saved.delete(path);
    if (current.from !== current.to) return current;
    return cached?.source === current.source ? cached : current;
  }
}

export function rememberEditorSelection(memory: SelectionMemory) {
  return ViewPlugin.fromClass(class {
    path?: string;
    constructor(view: EditorView) { this.observe(view); }
    observe(view: EditorView, changed = false) {
      const path = view.state.field(editorInfoField, false)?.file?.path;
      if (this.path && this.path !== path) memory.forget(this.path, this);
      this.path = path;
      if (!path) return;
      const { from, to } = view.state.selection.main;
      memory.observe(path, this, view.state.doc.toString(), from, to, view.hasFocus, changed);
    }
    update(update: ViewUpdate) { if (update.selectionSet || update.docChanged || update.focusChanged) this.observe(update.view, update.docChanged); }
    destroy() { if (this.path) memory.forget(this.path, this); }
  });
}
