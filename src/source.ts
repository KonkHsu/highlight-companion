import { fromMarkdown } from 'mdast-util-from-markdown';
import { Chapter, Entry, uid, link } from './model';

type Node = { type: string; depth?: number; value?: string; children?: Node[]; position?: { start: { offset?: number }; end: { offset?: number } } };
const start = (n: Node) => n.position?.start.offset ?? 0;
const end = (n: Node) => n.position?.end.offset ?? 0;
const textOf = (n: Node): string => n.type === 'html' ? '' : n.value ?? n.children?.map(textOf).join('') ?? '';
interface Block { node: Node; chapter: Chapter[]; forbidden: [number, number][] }
interface Edit { start: number; end: number; text: string }
export interface Capture { source: string; chapters: Chapter[]; entries: Entry[]; duplicates: number }

function inspect(source: string) {
  const front = source.match(/^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)(?:\r?\n|$)/);
  const masked = front ? front[0].replace(/[^\r\n]/g, ' ') + source.slice(front[0].length) : source;
  const root = fromMarkdown(masked) as Node;
  const blocks: Block[] = [], headings: { node: Node; chapter: Chapter; marked: boolean }[] = [];
  let chain: Chapter[] = [];
  function visit(node: Node, ancestors: string[]) {
    if (node.type === 'heading' && ancestors.length === 1) {
      const raw = source.slice(start(node), end(node));
      const existing = raw.match(/<!--hc-heading:([a-z0-9]+)-->/)?.[1];
      chain = chain.filter(c => c.depth < node.depth!);
      const chapter: Chapter = { id: existing ?? uid(), title: textOf(node).trim() || '无标题', depth: node.depth!, parents: chain.map(c => c.id) };
      chain.push(chapter); headings.push({ node, chapter, marked: !!existing });
    }
    if (node.type === 'paragraph' && ancestors.every(t => ['root', 'list', 'listItem'].includes(t))) {
      // Front matter is a thematic break followed by a setext heading in CommonMark.
      const forbidden: [number, number][] = [];
      const protect = (n: Node) => {
        if (['inlineCode', 'link', 'linkReference', 'image', 'html'].includes(n.type)) forbidden.push([start(n), end(n)]);
        else n.children?.forEach(protect);
      };
      node.children?.forEach(protect);
      blocks.push({ node, chapter: [...chain], forbidden });
    }
    if (!['code', 'html', 'blockquote'].includes(node.type)) node.children?.forEach(c => visit(c, [...ancestors, node.type]));
  }
  visit(root, []);
  return { blocks: blocks.filter(b => !front || start(b.node) >= front[0].length), headings: headings.filter(h => !front || start(h.node) >= front[0].length) };
}

export function capture(source: string, target: string, selection?: { from: number; to: number }): Capture {
  const { blocks, headings } = inspect(source);
  const headingIds = headings.map(h => h.chapter.id);
  if (new Set(headingIds).size !== headingIds.length) throw new Error('原文存在重复的章节标识，可能复制了已收录章节。请先移除副本中的 hc-heading 标识。');
  const highlightIds = [...source.matchAll(/<!--hc-h:([a-z0-9]+)-->/g)].map(m => m[1]);
  if (new Set(highlightIds).size !== highlightIds.length) throw new Error('原文存在重复的高亮标识，请先移除复制段落中的高亮链接与 hc-h 标识。');
  const edits: Edit[] = [], entries: Entry[] = [], used = new Set<string>();
  let duplicates = 0;
  if (selection && (selection.from >= selection.to || !source.slice(selection.from, selection.to).trim())) throw new Error('请先选择一个关键词或句段。');
  let selectedBlock = false;
  for (const block of blocks) {
    const a = start(block.node), b = end(block.node), raw = source.slice(a, b);
    if (selection && !(selection.from >= a && selection.to <= b)) continue;
    selectedBlock = true;
    const wikiRanges = [...raw.matchAll(/!?\[\[[\s\S]*?\]\]/g)].map(m => [a + m.index!, a + m.index! + m[0].length]);
    const safe = (from: number, to: number) => ![...block.forbidden, ...wikiRanges].some(([x, y]) => from < y && to > x);
    const existing = [...raw.matchAll(/==([^=]+?)==/g)].filter(m => safe(a + m.index!, a + m.index! + m[0].length) && raw[m.index! - 1] !== '\\');
    let matches: { from: number; to: number; text: string; highlighted: boolean }[];
    if (selection) {
      const found = existing.find(m => selection.from >= a + m.index! && selection.to <= a + m.index! + m[0].length);
      if (found) matches = [{ from: a + found.index!, to: a + found.index! + found[0].length, text: found[1], highlighted: true }];
      else {
        if (!safe(selection.from, selection.to) || /==|<!--|\^hc-|\[|\]|`/.test(source.slice(selection.from, selection.to))) throw new Error('请选择普通正文文字，避开链接、代码或标识。');
        if (existing.some(m => selection.from < a + m.index! + m[0].length && selection.to > a + m.index!)) throw new Error('选区与已有高亮部分重叠，请完整选择该高亮。');
        matches = [{ from: selection.from, to: selection.to, text: source.slice(selection.from, selection.to), highlighted: false }];
      }
    } else matches = existing.map(m => ({ from: a + m.index!, to: a + m.index! + m[0].length, text: m[1], highlighted: true }));
    const blockId = raw.match(/\s\^([a-zA-Z0-9-]+)\s*$/)?.[1] ?? 'hc-src-' + uid();
    let added = false;
    for (const match of matches) {
      const tail = source.slice(match.to);
      if (/^(?:\[重点\]\(<[^\n]*?>\))?<!--hc-h:[a-z0-9]+-->/.test(tail)) { duplicates++; continue; }
      const id = uid();
      const chapter = block.chapter.at(-1)?.id ?? 'unsectioned';
      for (const c of block.chapter) used.add(c.id);
      if (!block.chapter.length) used.add('unsectioned');
      entries.push({ id, text: match.text.trim(), chapter, sourceBlock: blockId, created: new Date().toISOString() });
      edits.push({ start: match.from, end: match.to, text: `==${match.text}==${link(target, 'hc-' + id, '重点')}<!--hc-h:${id}-->` });
      added = true;
    }
    if (added && !raw.match(/\s\^[a-zA-Z0-9-]+\s*$/)) edits.push({ start: b, end: b, text: ' ^' + blockId });
  }
  if (selection && !selectedBlock) throw new Error('一次只能收录一个正文段落或列表项中的文字；请避开标题、代码块，并将跨段选区分次收录。');
  for (const h of headings) if (used.has(h.chapter.id) && !h.marked) {
    // Insert before a setext underline, otherwise at the ATX heading's end.
    const raw = source.slice(start(h.node), end(h.node));
    const underline = raw.match(/\r?\n[ \t]*(?:=+|-+)[ \t]*$/);
    const offset = underline ? end(h.node) - underline[0].length : end(h.node);
    edits.push({ start: offset, end: offset, text: ` <!--hc-heading:${h.chapter.id}-->` });
  }
  let result = source;
  // Insertions at a replacement's end must run before that replacement.
  edits.sort((x, y) => y.start - x.start || y.end - x.end);
  for (const e of edits) result = result.slice(0, e.start) + e.text + result.slice(e.end);
  const chapters = headings.filter(h => used.has(h.chapter.id)).map(h => h.chapter);
  if (used.has('unsectioned')) chapters.unshift({ id: 'unsectioned', title: '未分章节', depth: 1, parents: [] });
  return { source: result, entries, chapters, duplicates };
}
