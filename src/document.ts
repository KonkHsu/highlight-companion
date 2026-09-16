import { Binding, Chapter, Entry, Group, ExamType, examTypes, encode, decode, escapeText, link, uid } from './model';

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
    const backlink = entry.origin === 'custom' ? '' : ` ${link(b.source, entry.sourceBlock)}`;
    const content = `\n${open('entry', entry)}\n- ${escapeText(entry.text)}${backlink} ^hc-${entry.id}\n${close('entry', entry.id)}\n`;
    text = text.slice(0, chapter.bodyTo) + content + text.slice(chapter.bodyTo);
    parsed = parseDocument(text);
  }
  return text;
}

export function addCustomEntry(text: string, chapterId: string, value: string) {
  const keyword = value.trim().replace(/\s*\r?\n\s*/g, ' ');
  if (!keyword) throw new Error('请输入关键词。');
  if (keyword.includes('<!--hc:')) throw new Error('关键词不能包含插件内部区域标识。');
  const parsed = parseDocument(text);
  let chapter = parsed.chapters.find(c => c.id === chapterId)?.meta;
  if (!chapter) {
    if (chapterId) throw new Error('所选章节已不存在，请重新选择。');
    chapter = parsed.chapters[0]?.meta ?? { id: uid(), title: '自定义关键词', depth: 1, parents: [] };
  }
  const entry: Entry = { id: uid(), text: keyword, chapter: chapter.id, sourceBlock: '', created: new Date().toISOString(), origin: 'custom' };
  return { note: appendEntries(text, parsed.binding, [chapter], [entry]), entry };
}

export function entryText(text: string, region: Region<Entry>) {
  return text.slice(region.bodyFrom, region.bodyTo).trim().replace(/^[-*+]\s+/, '').replace(/\[返回原文\]\(<[^>]*>\)/g, '').replace(/\s*\^hc-[a-z0-9]+/g, '').trim();
}
export function groupExamTypes(text: string, region: Region<Group>): ExamType[] {
  const fromMeta = Array.isArray(region.meta.examTypes) ? region.meta.examTypes : [];
  if (fromMeta.length) return examTypes.filter(type => fromMeta.includes(type));
  const legacy = text.slice(region.bodyFrom, region.bodyTo).match(/^考试题型：([^\n]*)$/m)?.[1]?.trim();
  if (!legacy || legacy === '未分类') return [];
  return examTypes.filter(type => legacy.split('、').includes(type));
}
function groupHeading(title: string, types: ExamType[]) {
  return `**重点：${escapeText(title)}${types.length ? `（${types.join('、')}）` : ''}**`;
}
function rewriteGroupIntro(intro: string, group: Region<Group>, types: ExamType[]) {
  const anchor = `^hcg-${group.id}`;
  const hadAnchor = intro.includes(anchor);
  intro = intro.replace(/^\*\*重点：[^\n]*?\*\*[^\n]*$/m, () => `${groupHeading(group.meta.title, types)}${hadAnchor ? ` ${anchor}` : ''}`);
  return intro.replace(/^考试题型：.*(?:\n|$)/m, '');
}
export function groupTitle(text: string, region: Region<Group>): string {
  const raw = text.slice(region.bodyFrom, region.bodyTo).match(/\*\*重点：([^\n]*?)\*\*/)?.[1] ?? region.meta.title;
  const types = groupExamTypes(text, region);
  const suffix = types.length ? `（${types.join('、')}）` : '';
  return raw.endsWith(suffix) ? raw : raw + suffix;
}
export function migrateGroupDisplays(text: string): string {
  let result = text;
  for (const original of [...parseDocument(text).groups].sort((a, b) => b.from - a.from)) {
    const group = parseDocument(result).groups.find(g => g.id === original.id);
    if (!group) continue;
    const before = result.slice(group.from, group.to);
    const body = rewriteGroupIntro(result.slice(group.bodyFrom, group.bodyTo), group, groupExamTypes(result, group));
    if (body !== result.slice(group.bodyFrom, group.bodyTo)) result = result.slice(0, group.bodyFrom) + body + result.slice(group.bodyTo);
    if (result.slice(group.from, group.to) === before) continue;
  }
  parseDocument(result); return result;
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
    const chunk = `\n${open('group', group)}\n${groupHeading(group.title, group.examTypes ?? [])} ^hcg-${group.id}\n\n${chunks}\n${close('group', group.id)}\n`;
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
  body = body.replace(/\*\*重点：[^\n]*?\*\*/, () => groupHeading(title.trim(), groupExamTypes(text, r)));
  return text.slice(0, r.from) + open('group', { ...r.meta, title: title.trim() }) + body + text.slice(r.bodyTo);
}
export function addManualGroup(text: string, chapterId: string, title: string, content: string, types: ExamType[] = []) {
  if (!title.trim()) throw new Error('请输入重点名称。');
  let parsed = parseDocument(text);
  let chapter = parsed.chapters.find(c => c.id === chapterId);
  if (!chapter) {
    if (chapterId) throw new Error('所选章节已不存在，请重新选择。');
    const meta: Chapter = { id: uid(), title: '手写重点', depth: 1, parents: [] };
    text = appendEntries(text, parsed.binding, [meta], []);
    parsed = parseDocument(text); chapter = parsed.chapters.find(c => c.id === meta.id)!;
  }
  // Reject reserved markers so handwritten Markdown cannot corrupt the envelope.
  if (content.includes('<!--hc:')) throw new Error('正文不能包含插件内部区域标识。');
  const group: Group = { id: uid(), chapter: chapter.id, title: title.trim(), examTypes: examTypes.filter(t => types.includes(t)) };
  const chunk = `\n${open('group', group)}\n${groupHeading(group.title, group.examTypes ?? [])} ^hcg-${group.id}\n\n${content.trim() || '在这里书写重点内容。'}\n${close('group', group.id)}\n`;
  const result = text.slice(0, chapter.bodyTo) + chunk + text.slice(chapter.bodyTo);
  parseDocument(result); return result;
}
export function setExamTypes(text: string, id: string, types: ExamType[]) {
  const group = parseDocument(text).groups.find(g => g.id === id);
  if (!group) throw new Error('该重点已不存在，请重新选择。');
  const selected = examTypes.filter(t => types.includes(t));
  const end = group.children[0]?.from ?? group.bodyTo;
  const intro = rewriteGroupIntro(text.slice(group.bodyFrom, end), group, selected);
  return text.slice(0, group.from) + open('group', { ...group.meta, examTypes: selected }) + intro + text.slice(end);
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
