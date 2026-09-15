import test from 'node:test';
import assert from 'node:assert/strict';
import { capture } from '../src/source';
import { newDocument, appendEntries, parseDocument, arrange, renameGroup, dissolveGroup, entryText, rewriteLinks } from '../src/document';
import { buildCanvas } from '../src/canvas';
import { Binding, emptyState, SerialQueue } from '../src/model';
import { commitCapture, finishPending, Storage } from '../src/engine';
const binding: Binding = { id: 'book1', source: '课本/生物.md', target: '重点/生物.md' };
function collect(source: string) { const captured = capture(source, binding.target); return { captured, note: appendEntries(newDocument(binding, '生物'), binding, captured.chapters, captured.entries) }; }

test('imports by chapter, skips code and links, preserves identical words at distinct locations', () => {
  const { captured, note } = collect('==前言==\n\n# 第一章\n\n==细胞==和==结构==。\n\n## 特点\n\n==细胞==\n\n# 第二章\n\n## 特点\n\n==膜==\n\n```txt\n==不收录==\n```\n\n`==代码==` 与 [==链接==](url)');
  assert.equal(captured.entries.length, 5);
  assert.equal(new Set(captured.entries.map(e => e.id)).size, 5);
  const parsed = parseDocument(note);
  assert.equal(parsed.chapters.length, 5);
  assert.equal(parsed.chapters.filter(c => c.meta.title === '特点').length, 2);
  assert.notEqual(captured.entries[2].chapter, captured.entries[3].chapter);
  assert.match(captured.source, /\[重点\]/);
  assert.match(note, /\[返回原文\]/);
  assert.equal(capture(captured.source, binding.target).entries.length, 0);
  assert.equal(capture(captured.source, binding.target).duplicates, 5);
});
test('selected highlight is idempotent and siblings share source block', () => {
  const source = '# 章节\n\n细胞膜和细胞壁。';
  const from = source.indexOf('细胞膜');
  const first = capture(source, binding.target, { from, to: from + 3 });
  const repeated = capture(first.source, binding.target, { from: first.source.indexOf('细胞膜'), to: first.source.indexOf('细胞膜') + 3 });
  assert.equal(repeated.entries.length, 0);
  const secondFrom = first.source.indexOf('细胞壁');
  const second = capture(first.source, binding.target, { from: secondFrom, to: secondFrom + 3 });
  assert.equal(first.entries[0].sourceBlock, second.entries[0].sourceBlock);
  assert.equal(first.entries[0].chapter, second.entries[0].chapter);
  assert.equal((second.source.match(/\^hc-src-/g) ?? []).length, 1);
});
test('rejects multi-block selections and inline code', () => {
  assert.throws(() => capture('第一段\n\n第二段', binding.target, { from: 0, to: 8 }), /一个正文/);
  assert.throws(() => capture('`abc`', binding.target, { from: 1, to: 4 }), /普通正文/);
});
test('reuses an existing source block id and handles lists', () => {
  const one = capture('- ==关键词== ^existing-id', binding.target);
  assert.equal(one.entries[0].sourceBlock, 'existing-id');
  assert.equal((one.source.match(/\^existing-id/g) ?? []).length, 1);
  assert.equal(capture(one.source, binding.target).entries.length, 0);
});
test('preserves full heading chain and does not interpret front matter as a chapter', () => {
  const { captured } = collect('---\ntitle: 教材\n---\n\n==前言==\n\n# 第一章\n\n### 小节\n\n==重点==');
  assert.equal(captured.entries[0].chapter, 'unsectioned');
  assert.equal(captured.chapters.find(c => c.title === '小节')?.parents.length, 1);
});
test('setext headings retain stable IDs across captures', () => {
  const first = capture('章节\n====\n\n==一==', binding.target);
  const next = capture(first.source + '\n\n==二==', binding.target);
  assert.equal(first.entries[0].chapter, next.entries[0].chapter);
});
test('groups preserve handwritten notes, can rename, move and dissolve', () => {
  const { note, captured } = collect('# 章节\n\n==甲==和==乙==和==丙==');
  const firstId = captured.entries[0].id;
  let edited = note.replace(`<!--hc:/entry:${firstId}-->`, `\n  我自己补充的解释。\n<!--hc:/entry:${firstId}-->`);
  edited = arrange(edited, captured.entries.slice(0, 2).map(e => e.id), { type: 'create', title: '一个重点' });
  let parsed = parseDocument(edited); assert.equal(parsed.groups.length, 1); assert.equal(parsed.groups[0].children.length, 2);
  const id = parsed.groups[0].id;
  edited = renameGroup(edited, id, '新的重点'); assert.match(edited, /新的重点/);
  edited = arrange(edited, [captured.entries[2].id], { type: 'add', group: id });
  assert.equal(parseDocument(edited).groups[0].children.length, 3);
  edited = arrange(edited, [firstId], { type: 'remove' });
  assert.equal(parseDocument(edited).groups[0].children.length, 2);
  edited = dissolveGroup(edited, id); parsed = parseDocument(edited);
  assert.equal(parsed.groups.length, 0); assert.equal(parsed.entries.length, 3); assert.match(edited, /我自己补充的解释/);
});
test('cross-chapter grouping and malformed markers do not modify content', () => {
  const { note, captured } = collect('# 甲\n\n==一==\n\n# 乙\n\n==二==');
  assert.throws(() => arrange(note, captured.entries.map(e => e.id), { type: 'create', title: '跨章节' }), /同一章节/);
  assert.throws(() => appendEntries(note.replace('<!--hc:/entry:', '<!--hc:/entry-broken:'), binding, [], []), /标识/);
  assert.throws(() => parseDocument(note.replace('<!--hc:/chapter:', '<!--hc:/entry:')), /标识/);
});
test('append is idempotent and preserves user edits', () => {
  const { note, captured } = collect('==重点==');
  const edited = note + '\n我的总结不变。';
  assert.equal(appendEntries(edited, binding, captured.chapters, captured.entries), edited);
});
test('incremental Canvas preserves edits, deletion, custom nodes and connection edits', () => {
  const first = collect('# 章节\n\n==甲==和==乙==');
  let canvas = JSON.parse(buildCanvas(first.note, binding));
  const tombstone = canvas.nodes.at(-1).id;
  canvas.nodes.pop(); canvas.edges = canvas.edges.filter((e: any) => e.toNode !== tombstone);
  canvas.nodes[0].text = '手写根节点'; canvas.nodes[0].x = -777;
  canvas.nodes.push({ id: 'manual', type: 'text', x: 100, y: 100, width: 300, height: 200, text: '手绘内容' });
  canvas.customProperty = 'keep';
  const before = structuredClone(canvas);
  const second = capture(first.captured.source + '\n\n==丙==', binding.target);
  const note = appendEntries(first.note, binding, second.chapters, second.entries);
  const after = JSON.parse(buildCanvas(note, binding, JSON.stringify(canvas)));
  assert.deepEqual(after.nodes.slice(0, before.nodes.length), before.nodes);
  assert.deepEqual(after.edges.slice(0, before.edges.length), before.edges);
  assert.equal(after.nodes.length, before.nodes.length + 1);
  assert(!after.nodes.some((n: any) => n.id === tombstone));
  assert.equal(after.customProperty, 'keep');
  assert.equal(buildCanvas(note, binding, JSON.stringify(after)), JSON.stringify(after, null, 2));
  const fresh = JSON.parse(buildCanvas(note, binding)); assert(fresh.nodes.length > 0);
});
test('rename only changes generated links and supports special path characters', () => {
  const text = '[返回原文](<%E8%AF%BE%E6%9C%AC/a%23b.md#^block>) [其他](<keep>)';
  assert.equal(rewriteLinks(text, '课本/a#b.md', '新目录/a b.md'), '[返回原文](<%E6%96%B0%E7%9B%AE%E5%BD%95/a%20b.md#^block>) [其他](<keep>)');
});
test('interrupted two-file capture resumes after restart without duplicate entries', async () => {
  let state = emptyState(); state.bindings.push(binding);
  const before = '==甲==', result = capture(before, binding.target);
  const files = new Map([[binding.source, before], [binding.target, newDocument(binding, '课本')]]);
  let persisted: any; let fail = true;
  const io: Storage = {
    read: async p => { if (!files.has(p)) throw new Error('missing'); return files.get(p)!; },
    change: async (p, fn) => { if (p === binding.target && fail) throw new Error('disk full'); files.set(p, fn(files.get(p)!)); },
    save: async () => { persisted = structuredClone(state); }
  };
  await assert.rejects(commitCapture(state, io, binding, { before, after: result.source, chapters: result.chapters, entries: result.entries }), /disk full/);
  assert.equal(files.get(binding.source), result.source);
  state = persisted; fail = false; await finishPending(state, io);
  assert.equal(parseDocument(files.get(binding.target)!).entries.length, 1);
  assert.equal(state.pending, undefined);
  await finishPending(state, io); assert.equal(parseDocument(files.get(binding.target)!).entries.length, 1);
});
test('missing destination and changed source fail safely', async () => {
  const state = emptyState(); state.bindings.push(binding);
  const result = capture('==甲==', binding.target); let source = 'changed';
  const io: Storage = { read: async () => newDocument(binding, '课本'), change: async (p, fn) => { if (p === binding.source) source = fn(source); }, save: async () => {} };
  await assert.rejects(commitCapture(state, io, binding, { before: '==甲==', after: result.source, chapters: result.chapters, entries: result.entries }), /原文已变化/);
  assert.equal(source, 'changed'); assert(state.pending);
});
test('queue serializes quick operations and continues after a failure', async () => {
  const queue = new SerialQueue(), log: number[] = [];
  const tasks = [queue.run(async () => { await new Promise(r => setTimeout(r, 15)); log.push(1); }), queue.run(async () => { log.push(2); throw new Error('fail'); }), queue.run(async () => { log.push(3); })];
  await Promise.allSettled(tasks); assert.deepEqual(log, [1, 2, 3]);
});

test('Obsidian wiki links and escaped highlighter syntax are never captured', () => {
  const result = capture('[[==不要改==]] 与 ![[==图片==]] 和 \\==转义==\n\n==正常==', binding.target);
  assert.equal(result.entries.length, 1); assert.equal(result.entries[0].text, '正常');
});
test('copied internal source identifiers are rejected rather than silently deduplicated', () => {
  const first = capture('==甲==', binding.target);
  assert.throws(() => capture(first.source + '\n\n' + first.source, binding.target), /重复/);
});
test('removed block anchors stop mutation', () => {
  const { note, captured } = collect('==甲==');
  assert.throws(() => parseDocument(note.replace('^hc-' + captured.entries[0].id, '')), /定位标识/);
});
test('Canvas ledger survives saves that omit custom JSON metadata', () => {
  const { note } = collect('==甲==');
  const first = JSON.parse(buildCanvas(note, binding));
  const ledger = first.highlightCompanion;
  first.nodes.pop(); first.edges = []; delete first.highlightCompanion;
  const next = JSON.parse(buildCanvas(note, binding, JSON.stringify(first), ledger));
  assert.equal(next.nodes.length, first.nodes.length);
});
test('generated tree keeps sibling branches separate and parents vertically centered', () => {
  const { note } = collect('# 章\n\n## 节甲\n\n==一==\n\n## 节乙\n\n==二==');
  const canvas = JSON.parse(buildCanvas(note, binding));
  for (const node of canvas.nodes) {
    const children = canvas.edges.filter((e: any) => e.fromNode === node.id).map((e: any) => canvas.nodes.find((n: any) => n.id === e.toNode));
    if (children.length === 1) assert.equal(node.y + node.height / 2, children[0].y + children[0].height / 2);
  }
});
test('missing target does not alter source, and a failed journal save never writes files', async () => {
  const state = emptyState(); state.bindings.push(binding);
  const result = capture('==甲==', binding.target); let writes = 0;
  const io: Storage = { read: async () => { throw new Error('missing target'); }, change: async () => { writes++; }, save: async () => {} };
  await assert.rejects(commitCapture(state, io, binding, { before: '==甲==', after: result.source, chapters: result.chapters, entries: result.entries }), /missing target/);
  assert.equal(writes, 0);
  state.pending = undefined; io.save = async () => { throw new Error('journal failed'); };
  await assert.rejects(commitCapture(state, io, binding, { before: '==甲==', after: result.source, chapters: result.chapters, entries: result.entries }), /journal failed/);
  assert.equal(writes, 0); assert.equal(state.pending, undefined);
});
