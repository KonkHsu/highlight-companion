import type { Editor } from 'obsidian';
import { fromMarkdown } from 'mdast-util-from-markdown';
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
export function readingSelection(source: string, text: string, lineStart: number, lineEnd: number, context?: { before: string; after: string }): SelectionSnapshot {
  if (!text.trim()) throw new Error('请先选中文字。');
  const lines = source.split('\n');
  const start = lines.slice(0, lineStart).reduce((n, line) => n + line.length + 1, 0);
  const section = lines.slice(lineStart, lineEnd + 1).join('\n');
  // Use rendered neighbours to distinguish repeated words; never guess the first occurrence.
  if (context) {
    const chars: string[] = [], offsets: number[] = [];
    const visit = (node: any) => {
      if (node.type === 'text') {
        const from = node.position.start.offset, raw = section.slice(from, node.position.end.offset);
        // Decoded entities and escapes need a separate mapping; do not fabricate offsets.
        if (raw !== node.value) return;
        const hidden = [...raw.matchAll(/==|\s\^[a-zA-Z0-9-]+\s*$/g)];
        for (let i = 0; i < raw.length; i++) {
          if (/\s/.test(raw[i]) || hidden.some(m => i >= m.index! && i < m.index! + m[0].length)) continue;
          chars.push(raw[i]); offsets.push(from + i);
        }
      } else if (!['html', 'code', 'inlineCode', 'image'].includes(node.type)) node.children?.forEach(visit);
    };
    visit(fromMarkdown(section));
    const normalize = (s: string) => s.replace(/\s/g, '');
    const rendered = chars.join(''), needle = normalize(text);
    const before = normalize(context.before).slice(-48), after = normalize(context.after).slice(0, 48);
    const matches: number[] = [];
    for (let at = rendered.indexOf(needle); at >= 0 && needle; at = rendered.indexOf(needle, at + 1)) {
      if (rendered.slice(0, at).endsWith(before) && rendered.slice(at + needle.length).startsWith(after)) matches.push(at);
    }
    if (matches.length === 1) {
      const from = offsets[matches[0]], to = offsets[matches[0] + needle.length - 1] + 1;
      // Keep Markdown delimiters balanced: only operate on a literal text span.
      if (normalize(section.slice(from, to)) === needle) return { source, from: start + from, to: start + to };
    }
    throw new Error('阅读视图选区无法唯一定位，请重新选择同一段内的普通正文文字。');
  }
  const offset = section.indexOf(text);
  if (offset < 0 || section.indexOf(text, offset + 1) >= 0) throw new Error('阅读视图选区无法唯一定位，请切换编辑视图后操作，或通过“整理重点”勾选撤销。');
  return { source, from: start + offset, to: start + offset + text.length };
}

/** Reserve room for the OS selection menu and stay inside the visual viewport. */
export function readingActionPosition(rect: { top: number; bottom: number; left: number; width: number }, size: { width: number; height: number }, viewport: { left: number; top: number; width: number; height: number }) {
  const gap = 80, pad = 8;
  const bottom = viewport.top + viewport.height - pad;
  const below = rect.bottom + gap;
  const top = below + size.height <= bottom ? below : rect.top - gap - size.height;
  return {
    left: Math.max(viewport.left + pad, Math.min(rect.left + rect.width / 2 - size.width / 2, viewport.left + viewport.width - size.width - pad)),
    top: Math.max(viewport.top + pad, Math.min(top, bottom - size.height))
  };
}
