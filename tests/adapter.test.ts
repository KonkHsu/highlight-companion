import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import path from 'node:path';
import { capture } from '../src/source';
import { newDocument, appendEntries, parseDocument } from '../src/document';
import { buildCanvas } from '../src/canvas';
import { Binding } from '../src/model';
const bundle = await build({ entryPoints: ['tests/adapter-harness.ts'], bundle: true, write: false, platform: 'node', format: 'esm', alias: { obsidian: path.resolve('tests/obsidian-mock.ts') } });
const { HighlightCompanion, TFile, MarkdownView } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const binding: Binding = { id: 'book', source: '课本.md', target: '重点.md', canvas: '重点.canvas' };
function setup() {
  const result = capture('# 章\n\n==甲==', binding.target);
  const note = appendEntries(newDocument(binding, '课本'), binding, result.chapters, result.entries);
  const files = new Map<string, string>([[binding.source, result.source], [binding.target, note]]);
  const plugin = new HighlightCompanion();
  plugin.state.bindings = [{ ...binding }]; plugin.state.indexes = { book: parseDocument(note).regions.map(r => r.id) };
  let leaves: any[] = [];
  plugin.app = { vault: { getAbstractFileByPath: (p: string) => files.has(p) ? new TFile(p) : null, read: async (f: any) => files.get(f.path), process: async (f: any, fn: any) => files.set(f.path, fn(files.get(f.path))) }, workspace: { getLeavesOfType: () => leaves } };
  plugin.saveData = async () => {};
  return { plugin, files, note, setLeaves: (value: any[]) => leaves = value };
}
test('adapter blocks missing regions before changing a source document', async () => {
  const { plugin, files, note } = setup();
  const r = parseDocument(note).entries[0]; files.set(binding.target, note.slice(0, r.from) + note.slice(r.to));
  await assert.rejects(plugin.io.read(binding.target), /收录区域被手动删除/);
  await assert.rejects(plugin.change(binding.target, (text: string) => text + 'new'), /收录区域被手动删除/);
});
test('renames update all recorded Canvas versions and defer edits for an open Canvas', async () => {
  const { plugin, files, note, setLeaves } = setup();
  const canvas = buildCanvas(note, binding), parsed = JSON.parse(canvas);
  files.set('重点.canvas', canvas); files.set('历史.canvas', canvas);
  plugin.state.canvasLedgers = Object.fromEntries(['重点.canvas', '历史.canvas'].map(p => [p, { ...structuredClone(parsed.highlightCompanion), target: binding.target }]));
  files.set('新重点.md', note); files.delete(binding.target);
  setLeaves([{ view: { file: { path: '历史.canvas' } } }]);
  await plugin.renamed(binding.target, '新重点.md');
  assert.equal(plugin.state.bindings[0].target, '新重点.md');
  assert.match(files.get(binding.source)!, /%E6%96%B0%E9%87%8D%E7%82%B9/);
  assert.match(files.get('重点.canvas')!, /%E6%96%B0%E9%87%8D%E7%82%B9/);
  assert.equal(files.get('历史.canvas'), canvas);
  setLeaves([]); await plugin.refreshCanvasLinks();
  assert.match(files.get('历史.canvas')!, /%E6%96%B0%E9%87%8D%E7%82%B9/);
});
test('renaming source rewrites backlinks and the recovery binding', async () => {
  const { plugin, files } = setup();
  files.set('移动/新课本.md', files.get(binding.source)!); files.delete(binding.source);
  await plugin.renamed(binding.source, '移动/新课本.md');
  const parsed = parseDocument(files.get(binding.target)!);
  assert.equal(parsed.binding.source, '移动/新课本.md');
  assert.match(files.get(binding.target)!, /%E7%A7%BB%E5%8A%A8\/%E6%96%B0%E8%AF%BE%E6%9C%AC/);
});
test('file updates use unsaved editor content and save the current view', async () => {
  const { plugin, files, note, setLeaves } = setup();
  const view = new MarkdownView(); view.file = new TFile(binding.target);
  let content = note + '\n刚写的说明'; let saved = false;
  view.editor = { getValue: () => content, getCursor: () => ({ line: 0, ch: 0 }), offsetToPos: () => ({ line: 99, ch: 0 }), transaction: (tr: any) => content = tr.changes[0].text, setCursor: () => {} };
  view.save = async () => { saved = true; files.set(binding.target, content); };
  setLeaves([{ view }]); await plugin.change(binding.target, (value: string) => value + '\n新的说明');
  assert.match(content, /刚写的说明\n新的说明/); assert(saved);
});

test('mobile capture uses saved selection after the keyboard loses focus', async () => {
  const { plugin, files } = setup();
  const file = new TFile(binding.source);
  const source = files.get(binding.source)! + '\n\n新关键词'; files.set(binding.source, source);
  const start = source.indexOf('新关键词');
  const selection = { source, from: start, to: start + 4 };
  plugin.app.workspace.getActiveFile = () => new TFile('其他笔记.md');
  await plugin.collectSnapshot(file, selection);
  assert.match(files.get(binding.source)!, /==新关键词==/);
  assert.equal(parseDocument(files.get(binding.target)!).entries.length, 2);
});
test('mobile saved selection is rejected if source changed while a panel was open', async () => {
  const { plugin, files } = setup();
  const source = files.get(binding.source)! + '\n\n新关键词';
  const start = source.indexOf('新关键词'); files.set(binding.source, source + '外部修改');
  await assert.rejects(plugin.collectSnapshot(new TFile(binding.source), { source, from: start, to: start + 4 }), /原文已变化/);
  assert.equal(parseDocument(files.get(binding.target)!).entries.length, 1);
});
test('mobile panel can return from current or archived Canvas to the bound note', async () => {
  const { plugin } = setup();
  plugin.state.canvasLedgers = { '历史.canvas': { binding: binding.id, exported: {} } };
  const latest = new TFile('重点.canvas'); latest.extension = 'canvas';
  const archived = new TFile('历史.canvas'); archived.extension = 'canvas';
  assert.equal((await plugin.contextBinding(latest)).target, binding.target);
  assert.equal((await plugin.contextBinding(archived)).target, binding.target);
});

test('blur preserves selection, while an intentional cursor move or document change clears it', async () => {
  const { SelectionMemory } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
  const memory = new SelectionMemory(), owner = {};
  const empty = { source: '触屏选择', from: 2, to: 2 };
  memory.observe('a.md', owner, empty.source, 0, 2, true);
  memory.observe('a.md', owner, empty.source, 2, 2, false);
  assert.equal(memory.take('a.md', empty).from, 0);
  assert.deepEqual(memory.take('a.md', empty), empty, 'a cached selection can only be consumed once');
  memory.observe('a.md', owner, empty.source, 0, 2, true);
  memory.observe('a.md', owner, empty.source, 2, 2, true);
  assert.deepEqual(memory.take('a.md', empty), empty);
  memory.observe('a.md', owner, empty.source, 0, 2, true);
  memory.observe('a.md', owner, 'changed', 0, 0, false, true);
  assert.deepEqual(memory.take('a.md', empty), empty);
});


test('capture preview survives native Modal selection bookkeeping', async () => {
  const { CapturePanel } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
  const { plugin } = setup();
  const rendered: any[] = [];
  const element: any = { createEl: (_tag: string, options: any) => { const el = { ...options }; rendered.push(el); return el; }, createDiv: () => element };
  const panel = new CapturePanel(plugin.app, plugin, new TFile(binding.source), { source: '触屏选择', from: 0, to: 2 });
  panel.modalEl = { addClass() {} }; panel.contentEl = element; panel.setTitle = () => {};
  // Obsidian Modal owns this property and may replace it when opening.
  panel.selection = { nativeSelection: true };
  panel.onOpen();
  assert.equal(rendered.find(el => el.cls === 'hc-capture-preview').text, '触屏');
  assert.equal(rendered.find(el => el.text === '高亮并收录所选文字').disabled, false);
});
