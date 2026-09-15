import { Entry } from './model';
import { parseDocument } from './document';

/** Match the stable marker and its immediately adjacent generated link, never keyword text elsewhere. */
function sourceOccurrence(source: string, entry: Entry) {
  const marker = `<!--hc-h:${entry.id}-->`;
  const offset = source.indexOf(marker);
  if (offset < 0 || source.indexOf(marker, offset + marker.length) >= 0) throw new Error('找不到唯一的原文收录标识，请恢复原文标识后再撤销。');
  const prefix = source.slice(0, offset);
  const link = prefix.match(/\[重点\]\(<[^>\n]+>\)$/);
  if (!link || !link[0].includes(`#^hc-${entry.id}>`)) throw new Error('原文重点链接已被修改，请恢复链接后再撤销。');
  const linkStart = offset - link[0].length;
  const highlight = source.slice(0, linkStart).match(/==((?:(?!<!--hc-h:)[^=])+?)==$/);
  if (!highlight && source.slice(0, linkStart).endsWith('==')) throw new Error('高亮语法已被修改，请恢复完整的高亮后再撤销。');
  // A user may have already removed the highlight delimiters; the linked marker still identifies the entry.
  return { from: highlight ? linkStart - highlight[0].length : linkStart, to: offset + marker.length, replacement: highlight?.[1] ?? '' };
}

export function removeHighlights(source: string, entries: Entry[]) {
  const edits = entries.map(e => sourceOccurrence(source, e)).sort((a, b) => b.from - a.from);
  for (let i = 1; i < edits.length; i++) if (edits[i].to > edits[i - 1].from) throw new Error('高亮标识重叠，已停止撤销。');
  for (const edit of edits) source = source.slice(0, edit.from) + edit.replacement + source.slice(edit.to);
  // Keep block anchors and chapter IDs: other highlights and user-authored links may rely on them.
  return source;
}

export function removeEntries(note: string, ids: string[]) {
  const parsed = parseDocument(note);
  const entries = parsed.entries.filter(e => ids.includes(e.id));
  if (!ids.length || entries.length !== new Set(ids).size) throw new Error('请选择有效的收录条目。');
  for (const entry of [...entries].sort((a, b) => b.from - a.from)) note = note.slice(0, entry.from) + note.slice(entry.to);
  parseDocument(note);
  return { note, entries: entries.map(e => e.meta) };
}

export function selectedEntryIds(source: string, entries: Entry[], from: number, to: number) {
  return entries.filter(entry => {
    try { const range = sourceOccurrence(source, entry); return from === to ? from >= range.from && from < range.to : from < range.to && to > range.from; }
    catch { return false; }
  }).map(e => e.id);
}
