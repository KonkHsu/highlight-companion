import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import path from 'node:path';
import { capture } from '../src/source';
import { newDocument, appendEntries, parseDocument, addCustomEntry } from '../src/document';
import { buildCanvas } from '../src/canvas';
import { Binding } from '../src/model';
import { finishPending } from '../src/engine';
const bundle = await build({ entryPoints: ['tests/adapter-harness.ts'], bundle: true, write: false, platform: 'node', format: 'esm', alias: { obsidian: path.resolve('tests/obsidian-mock.ts') } });
const { HighlightCompanion, TFile, MarkdownView } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const binding: Binding = { id: 'book', source: '课本.md', target: '重点.md', canvas: '重点.canvas' };
test('mobile editor actions wait for release, suppress the sheet and use the final selection', async () => {
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const timers = new Map<number, () => void>(); let timerId = 0;
  const bars: any[] = [], listeners = new Map<string, (event: any) => void>();
  const doc = {
    body: { classList: { contains: () => true }, createDiv: () => {
      const bar: any = { buttons: [], style: {}, removed: false, classList: { toggle() {} }, setAttribute() {}, contains: (target: any) => bar.buttons.includes(target), remove: () => bar.removed = true, getBoundingClientRect: () => ({ width: 200 }), createEl: (_tag: string, options: any) => { const button = { ...options }; bar.buttons.push(button); return button; } };
      bars.push(bar); return bar;
    } },
    getSelection: () => ({ rangeCount: 1, anchorNode: {}, getRangeAt: () => ({ getBoundingClientRect: () => ({ left: 40, top: 200, bottom: 225, width: 90, height: 25 }) }) })
  };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { innerWidth: 320, setTimeout: (fn: () => void) => { timers.set(++timerId, fn); return timerId; }, clearTimeout: (id: number) => timers.delete(id) } });
  try {
    const plugin = new HighlightCompanion(), view = new MarkdownView();
    let to = 1, cleanup = () => {}, captured: any;
    view.file = new TFile('课本.md'); view.containerEl = { contains: () => true };
    view.editor = { getValue: () => '甲乙丙', getCursor: (side: string) => ({ ch: side === 'from' ? 0 : to }), posToOffset: (pos: any) => pos.ch };
    plugin.app = { workspace: { getActiveViewOfType: () => view } };
    plugin.registerDomEvent = (_target: any, event: string, fn: any) => listeners.set(event, fn);
    plugin.register = (fn: any) => cleanup = fn;
    plugin.collectSnapshot = async (_file: any, snapshot: any) => captured = snapshot;
    plugin.registerMobileEditorActions();
    const fire = (name: string, event: any = {}) => listeners.get(name)!(event);
    const flush = () => { const jobs = [...timers.values()]; timers.clear(); jobs.forEach(fn => fn()); };
    fire('touchstart'); fire('selectionchange'); flush(); assert.equal(bars.length, 0);
    let prevented = false, stopped = false;
    fire('contextmenu', { target: {}, preventDefault: () => prevented = true, stopImmediatePropagation: () => stopped = true });
    assert(prevented && stopped); flush(); assert.equal(bars.length, 0);
    to = 3; fire('selectionchange'); fire('touchend'); flush();
    assert.equal(bars.length, 1);
    assert.deepEqual(bars[0].buttons.map((b: any) => b.text), ['高亮并收录', '撤销高亮并移除重点']);
    fire('pointerdown', { target: bars[0].buttons[0] });
    assert(!bars[0].removed);
    bars[0].buttons[0].onclick(); await plugin.queue.run(async () => {});
    assert.equal(captured.to, 3); assert.equal(captured.source, '甲乙丙');
    fire('touchstart'); fire('selectionchange'); cleanup(); flush();
    assert.equal(bars.length, 1);
  } finally {
    if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument); else delete (globalThis as any).document;
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow); else delete (globalThis as any).window;
  }
});
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
test('custom-only and mixed removal restore exactly through the normal adapter journal', async () => {
  for (const mixed of [false, true]) {
    const { plugin, files, note } = setup();
    const captured = parseDocument(note).entries[0];
    const added = addCustomEntry(note, captured.meta.chapter, '甲');
    await plugin.change(binding.target, () => added.note);
    const before = files.get(binding.source);
    await plugin.undoEntries(binding, mixed ? [added.entry.id, captured.id] : [added.entry.id]);
    assert.equal(parseDocument(files.get(binding.target)!).entries.length, mixed ? 0 : 1);
    if (!mixed) assert.equal(files.get(binding.source), before);
    else assert(!files.get(binding.source)!.includes(`<!--hc-h:${captured.id}-->`));
    await plugin.restoreUndo();
    assert.equal(files.get(binding.source), before);
    assert.equal(files.get(binding.target), added.note);
  }
});
test('reading-view snapshots support collection, undo, and stale-selection protection', async () => {
  const { plugin, files } = setup();
  const file = new TFile(binding.source), source = files.get(binding.source)!;
  const from = source.indexOf('甲');
  await plugin.undoSnapshot(file, { source, from, to: from + 1 });
  assert.equal(parseDocument(files.get(binding.target)!).entries.length, 0);
  await assert.rejects(plugin.undoSnapshot(file, { source, from, to: from + 1 }), /笔记已变化/);
  const next = files.get(binding.source)!;
  await plugin.collectSnapshot(file, { source: next, from: next.indexOf('甲'), to: next.indexOf('甲') + 1 });
  assert.equal(parseDocument(files.get(binding.target)!).entries.length, 1);
});
test('adapter blocks missing regions before changing a source document', async () => {
  const { plugin, files, note } = setup();
  const r = parseDocument(note).entries[0]; files.set(binding.target, note.slice(0, r.from) + note.slice(r.to));
  await assert.rejects(plugin.io.read(binding.target), /收录区域被手动删除/);
  await assert.rejects(plugin.change(binding.target, (text: string) => text + 'new'), /收录区域被手动删除/);
});
test('Canvas export creates its folder, avoids collisions and can supplement an archived map', async () => {
  const { plugin, files } = setup();
  const b = plugin.state.bindings[0];
  const folders = new Set<string>();
  const lookup = plugin.app.vault.getAbstractFileByPath;
  plugin.app.vault.getAbstractFileByPath = (p: string) => folders.has(p) ? { path: p } : lookup(p);
  plugin.app.vault.createFolder = async (p: string) => { folders.add(p); };
  plugin.app.vault.create = async (p: string, text: string) => {
    assert(folders.has(p.slice(0, p.lastIndexOf('/'))));
    assert(!files.has(p)); files.set(p, text);
  };
  plugin.open = async () => {};
  assert.deepEqual(plugin.canvasChoices(b), []); // The previously recorded file is missing.
  await plugin.exportCanvas(b, true);
  const first = b.canvas;
  assert.equal(first, '思维导图/重点-思维导图.canvas');
  const custom = JSON.parse(files.get(first)!);
  custom.nodes[0].text = '手动编辑'; custom.nodes[0].x = 1234;
  files.set(first, JSON.stringify(custom));
  await plugin.exportCanvas(b, true);
  assert.equal(b.canvas, '思维导图/重点-思维导图-2.canvas');
  assert.equal(plugin.canvasChoices(b).length, 2);
  const secondBefore = files.get(b.canvas);
  const original = files.get(b.source)!;
  const source = original + '\n\n乙'; files.set(b.source, source);
  await plugin.collectSnapshot(new TFile(b.source), { source, from: source.length - 1, to: source.length });
  await plugin.exportCanvas(b, false, first);
  const supplemented = JSON.parse(files.get(first)!);
  assert.equal(supplemented.nodes[0].text, '手动编辑');
  assert.equal(supplemented.nodes[0].x, 1234);
  assert(supplemented.nodes.length > custom.nodes.length);
  assert.equal(files.get('思维导图/重点-思维导图-2.canvas'), secondBefore);
  assert.equal(b.canvas, first);
  files.delete(first);
  await assert.rejects(plugin.exportCanvas(b, false, first), /已丢失/);
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
  const element: any = { createEl: (_tag: string, options: any) => { const el = { ...options, createEl: element.createEl }; rendered.push(el); return el; }, createDiv: () => element };
  const panel = new CapturePanel(plugin.app, plugin, new TFile(binding.source), { source: '触屏选择', from: 0, to: 2 });
  panel.modalEl = { addClass() {} }; panel.contentEl = element; panel.setTitle = () => {};
  // Obsidian Modal owns this property and may replace it when opening.
  panel.selection = { nativeSelection: true };
  panel.onOpen();
  assert.equal(rendered.find(el => el.cls === 'hc-capture-preview').text, '触屏');
  assert.equal(rendered.find(el => el.text === '高亮并收录所选文字').disabled, false);
});

test('undo and restore preserve full note content, indexes and existing Canvas', async () => {
  const { plugin, files, note } = setup();
  const source = files.get(binding.source)!;
  files.set('重点.canvas', buildCanvas(note, binding)); const canvas = files.get('重点.canvas');
  await plugin.undoEntries(binding, [parseDocument(note).entries[0].id]);
  assert.equal(parseDocument(await plugin.io.read(binding.target)).entries.length, 0);
  assert(!files.get(binding.source)!.includes('==甲=='));
  await plugin.restoreUndo();
  assert.equal(files.get(binding.source), source); assert.equal(files.get(binding.target), note);
  assert.equal(files.get('重点.canvas'), canvas); assert.equal(plugin.state.lastUndo, undefined);
  await plugin.io.read(binding.target);
});
test('restoring an undo refuses to overwrite subsequent handwritten edits', async () => {
  const { plugin, files, note } = setup();
  await plugin.undoEntries(binding, [parseDocument(note).entries[0].id]);
  const modified = files.get(binding.target)! + '\n新说明'; files.set(binding.target, modified);
  await assert.rejects(plugin.restoreUndo(), /已有新修改/);
  assert.equal(files.get(binding.target), modified);
});
test('undo retry accepts a completed target write whose updated index was not saved', async () => {
  const { plugin, files, note } = setup();
  const before = JSON.parse(JSON.stringify(plugin.state)); let saved: any;
  plugin.saveData = async (state: any) => {
    if (state.undoPending && parseDocument(files.get(binding.target)!).entries.length === 0) throw new Error('index disk');
    saved = JSON.parse(JSON.stringify(state));
  };
  await assert.rejects(plugin.undoEntries(binding, [parseDocument(note).entries[0].id]), /index disk/);
  assert.deepEqual(saved.indexes, before.indexes);
  plugin.state = saved; plugin.saveData = async () => {};
  await finishPending(plugin.state, plugin.io);
  assert.equal(parseDocument(await plugin.io.read(binding.target)).entries.length, 0);
  await plugin.restoreUndo(); assert.equal(files.get(binding.target), note);
});
test('rename after undo preserves the ability to restore at the new paths', async () => {
  const { plugin, files, note } = setup();
  await plugin.undoEntries(binding, [parseDocument(note).entries[0].id]);
  files.set('新重点.md', files.get(binding.target)!); files.delete(binding.target);
  await plugin.renamed(binding.target, '新重点.md');
  await plugin.restoreUndo();
  assert.equal(parseDocument(files.get('新重点.md')!).entries.length, 1);
  assert.match(files.get(binding.source)!, /%E6%96%B0%E9%87%8D%E7%82%B9/);
});
