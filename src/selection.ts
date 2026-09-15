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

/** Reading view text may omit Markdown syntax. Only accept a unique literal match in its rendered section. */
export function readingSelection(source: string, text: string, lineStart: number, lineEnd: number): SelectionSnapshot {
  if (!text.trim()) throw new Error('请先选中文字。');
  const lines = source.split('\n');
  const start = lines.slice(0, lineStart).reduce((n, line) => n + line.length + 1, 0);
  const section = lines.slice(lineStart, lineEnd + 1).join('\n');
  const offset = section.indexOf(text);
  if (offset < 0 || section.indexOf(text, offset + 1) >= 0) throw new Error('阅读视图选区无法唯一定位，请切换编辑视图后操作，或通过“整理重点”勾选撤销。');
  return { source, from: start + offset, to: start + offset + text.length };
}
