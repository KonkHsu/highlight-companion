import type { Editor } from 'obsidian';
export interface SelectionSnapshot { source: string; from: number; to: number }
/** Capture before opening any modal so the touch keyboard losing focus cannot lose the range. */
export function snapshotSelection(editor: Editor): SelectionSnapshot {
  return { source: editor.getValue(), from: editor.posToOffset(editor.getCursor('from')), to: editor.posToOffset(editor.getCursor('to')) };
}
export function selectionPreview(selection?: SelectionSnapshot) {
  if (!selection || selection.from === selection.to) return '';
  return selection.source.slice(selection.from, selection.to).trim();
}
