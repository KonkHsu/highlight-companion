import { Binding, Chapter, Entry, Group, encode, decode, escapeText, link, uid } from './model';

export interface Region<T = any> { kind: string; id: string; meta: T; from: number; bodyFrom: number; bodyTo: number; to: number; parent?: Region; children: Region[] }
export interface Parsed { binding: Binding; regions: Region[]; chapters: Region<Chapter>[]; entries: Region<Entry>[]; groups: Region<Group>[] }
const token = /<!--hc:(\/?)(book|chapter|entry|group)(?::([^\s]*))?-->/g;
const open = (kind: string, meta: unknown) => `<!--hc:${kind}:${encode(meta)}-->`;
const close = (kind: string, id: string) => `<!--hc:/${kind}:${id}-->`;
export const bookMarker = (b: Binding) => open('book', b);
export const newDocument = (b: Binding, title: string) => `# ${escapeText(title)} · 重点\n\n${bookMarker(b)}\n\n在阅读视图点击「整理重点」可多选关键词分组。可直接在条目内补充说明。\n`;

export function parseDocument(text: string): Parsed {
  const stack: Region[] = [], regions: Region[] = [];
  let binding: Binding | undefined;
  const hits = [...text.matchAll(token)];
  if ((text.match(/<!--hc:/g) ?? []).length !== hits.length) throw new Error('重点笔记中的收录标识损坏，请恢复标识或从备份还原。');
  for (const m of hits) {
    const [, closing, kind, value] = m;
    if (kind === 'book') {
      if (closing || binding || stack.length) throw new Error('重点笔记的课本绑定标识重复或损坏。');
      try { binding = decode<Binding>(value); } catch { throw new Error('课本绑定标识无法读取。'); }
      if (!binding?.id || typeof binding.source !== 'string' || typeof binding.target !== 'string') throw new Error('课本绑定标识不完整。');
    } else if (closing) {
      const region = stack.pop();
      if (!region || region.kind !== kind || region.id !== value) throw new Error('重点笔记的区域标识不匹配，已停止修改。');
      region.bodyTo = m.index!; region.to = m.index! + m[0].length;
    } else {
      let meta: any;
      try { meta = decode(value); } catch { throw new Error('重点条目标识无法读取。'); }
      if (!meta?.id || regions.some(r => r.id === meta.id)) throw new Error('重点条目标识缺失或重复。');
      const parent = stack.at(-1);
      if (kind === 'chapter' && parent || kind === 'group' && parent?.kind !== 'chapter' || kind === 'entry' && !['chapter', 'group'].includes(parent?.kind ?? '')) throw new Error('重点笔记区域层级损坏。');
      const region: Region = { kind, id: meta.id, meta, from: m.index!, bodyFrom: m.index! + m[0].length, bodyTo: 0, to: 0, parent, children: [] };
      parent?.children.push(region); regions.push(region); stack.push(region);
    }
  }
  if (stack.length || !binding) throw new Error('重点笔记缺少完整收录标识，请重新定位正确笔记或恢复标识。');
  const parsed = { binding, regions, chapters: regions.filter(r => r.kind === 'chapter'), entries: regions.filter(r => r.kind === 'entry'), groups: regions.filter(r => r.kind === 'group') };
  for (const r of [...parsed.entries, ...parsed.groups]) {
    const chapter = r.parent?.kind === 'chapter' ? r.parent : r.parent?.parent;
    if (r.meta.chapter !== chapter?.id) throw new Error('条目的章节标识不一致，已停止修改。');
    const anchor = r.kind === 'entry' ? 'hc-' + r.id : 'hcg-' + r.id;
    if (!text.slice(r.bodyFrom, r.bodyTo).includes('^' + anchor)) throw new Error('重点条目的定位标识被删除，请恢复 ^' + anchor + '。');
  }
  return parsed;
}

export function validateExpected(text: string, expected: Parsed) {
  const current = parseDocument(text);
  for (const r of expected.regions) if (!current.regions.some(x => x.id === r.id)) throw new Error('重点笔记有区域被删除，请先检查内容并重新打开整理窗口。');
  return current;
}

export function appendEntries(text: string, b: Binding, chapters: Chapter[], entries: Entry[]) {
  let parsed = parseDocument(text);
  if (parsed.binding.id !== b.id) throw new Error('目标笔记属于另一份课本。');
  for (const c of chapters) {
    if (parsed.chapters.some(r => r.id === c.id)) continue;
    const section = `\n\n${open('chapter', c)}\n${'#'.repeat(Math.min(c.parents.length + 2, 6))} ${escapeText(c.title)}\n\n${close('chapter', c.id)}\n`;
    const siblings = parsed.chapters.filter(r => r.id === c.parents.at(-1) || r.meta.parents.includes(c.parents.at(-1) ?? ''));
    const offset = c.parents.length && siblings.length ? siblings.at(-1)!.to : text.length;
    text = text.slice(0, offset) + section + text.slice(offset);
    parsed = parseDocument(text);
  }
  for (const entry of entries) {
    if (parsed.entries.some(r => r.id === entry.id)) continue;
    const chapter = parsed.chapters.find(c => c.id === entry.chapter);
    if (!chapter) throw new Error('找不到条目所属章节。');
    const content = `\n${open('entry', entry)}\n- ${escapeText(entry.text)} ${link(b.source, entry.sourceBlock)} ^hc-${entry.id}\n${close('entry', entry.id)}\n`;
    text = text.slice(0, chapter.bodyTo) + content + text.slice(chapter.bodyTo);
    parsed = parseDocument(text);
  }
  return text;
}

export function entryText(text: string, region: Region<Entry>) {
  return text.slice(region.bodyFrom, region.bodyTo).trim().replace(/^[-*+]\s+/, '').replace(/\[返回原文\]\(<[^>]*>\)/g, '').replace(/\s*\^hc-[a-z0-9]+/g, '').trim();
}
export function groupTitle(text: string, region: Region<Group>): string {
  return text.slice(region.bodyFrom, region.bodyTo).match(/\*\*重点：([^\n]*?)\*\*/)?.[1] ?? region.meta.title;
}
export function arrange(text: string, ids: string[], action: { type: 'create'; title: string } | { type: 'add'; group: string } | { type: 'remove' }) {
  let parsed = parseDocument(text);
  const selected = parsed.entries.filter(r => ids.includes(r.id));
  if (!selected.length || selected.length !== new Set(ids).size) throw new Error('请选择有效的关键词条目。');
  if (new Set(selected.map(r => r.meta.chapter)).size !== 1) throw new Error('只能将同一章节的关键词归为一个重点。');
  const chapter = selected[0].meta.chapter;
  if (action.type === 'create' && !action.title.trim()) throw new Error('请输入重点名称。');
  if (action.type === 'add' && !parsed.groups.some(g => g.id === action.group && g.meta.chapter === chapter)) throw new Error('目标重点不属于所选章节。');
  const chunks = selected.map(r => text.slice(r.from, r.to)).join('\n\n');
  for (const r of [...selected].sort((a, b) => b.from - a.from)) text = text.slice(0, r.from) + text.slice(r.to);
  parsed = parseDocument(text);
  if (action.type === 'create') {
    const group: Group = { id: uid(), title: action.title.trim(), chapter };
    const chunk = `\n${open('group', group)}\n**重点：${escapeText(group.title)}** ^hcg-${group.id}\n\n${chunks}\n${close('group', group.id)}\n`;
    const offset = parsed.chapters.find(r => r.id === chapter)!.bodyTo;
    text = text.slice(0, offset) + chunk + text.slice(offset);
  } else {
    const dest = action.type === 'add' ? parsed.groups.find(r => r.id === action.group)! : parsed.chapters.find(r => r.id === chapter)!;
    text = text.slice(0, dest.bodyTo) + '\n' + chunks + '\n' + text.slice(dest.bodyTo);
  }
  parseDocument(text); return text;
}
export function renameGroup(text: string, id: string, title: string) {
  const r = parseDocument(text).groups.find(r => r.id === id);
  if (!r || !title.trim()) throw new Error('请选择重点并输入名称。');
  let body = text.slice(r.bodyFrom, r.bodyTo);
  if (!/\*\*重点：[^\n]*?\*\*/.test(body)) throw new Error('重点名称行已被手动改写，请直接在笔记中修改。');
  body = body.replace(/\*\*重点：[^\n]*?\*\*/, () => `**重点：${escapeText(title.trim())}**`);
  return text.slice(0, r.from) + open('group', { ...r.meta, title: title.trim() }) + body + text.slice(r.bodyTo);
}
export function dissolveGroup(text: string, id: string) {
  const r = parseDocument(text).groups.find(r => r.id === id);
  if (!r) throw new Error('找不到该重点。');
  // Keep the heading and every handwritten note, removing only the group envelope.
  return text.slice(0, r.from) + text.slice(r.bodyFrom, r.bodyTo) + text.slice(r.to);
}
export function rewriteBinding(text: string, binding: Binding) {
  parseDocument(text);
  return text.replace(/<!--hc:book:[^\s]*-->/, () => bookMarker(binding));
}
export function rewriteLinks(text: string, oldPath: string, newPath: string) {
  const oldUrl = oldPath.split('/').map(encodeURIComponent).join('/');
  const newUrl = newPath.split('/').map(encodeURIComponent).join('/');
  return text.replace(/\[(重点|返回原文|查看重点|打开重点笔记)\]\(<([^>]+)>\)/g, (all, label, url: string) => {
    if (url === oldUrl || url.startsWith(oldUrl + '#')) return `[${label}](<${newUrl}${url.slice(oldUrl.length)}>)`;
    return all;
  });
}
