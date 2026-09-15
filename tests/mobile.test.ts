import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { build } from 'esbuild';
import { snapshotSelection, selectionPreview, readingSelection } from '../src/selection';
import { uid, cloneData } from '../src/model';
test('reading selection resolves within its section and rejects ambiguous or formatted matches', () => {
  const source = '# 标题\n\n细胞膜。\n\n这里有==细胞膜==与结构。';
  const selected = readingSelection(source, '细胞膜', 4, 4);
  assert.equal(selected.from, source.lastIndexOf('细胞膜'));
  assert.equal(source.slice(selected.from, selected.to), '细胞膜');
  assert.throws(() => readingSelection('甲和甲', '甲', 0, 0), /无法唯一定位/);
  assert.throws(() => readingSelection('**细胞**膜', '细胞膜', 0, 0), /无法唯一定位/);
});
test('selection snapshot is independent of later editor selection collapse', () => {
  let pos = { from: { line: 0, ch: 1 }, to: { line: 0, ch: 4 } };
  const editor = { getValue: () => '甲细胞膜乙', getCursor: (end: 'from' | 'to') => pos[end], posToOffset: (p: { ch: number }) => p.ch };
  const selected = snapshotSelection(editor as any);
  pos = { from: { line: 0, ch: 4 }, to: { line: 0, ch: 4 } };
  assert.equal(selectionPreview(selected), '细胞膜');
  assert.equal(selectionPreview(snapshotSelection(editor as any)), '');
});
test('mobile identifiers use random bytes without requiring randomUUID', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')!;
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { getRandomValues: (bytes: Uint8Array) => bytes.fill(15) } });
  try { assert.equal(uid(), '0f0f0f0f0f0f0f0f'); } finally { Object.defineProperty(globalThis, 'crypto', descriptor); }
});
test('Canvas JSON ledger clone does not share mutable state', () => {
  const original = { exported: { first: 'id1' } };
  const cloned = cloneData(original); cloned.exported.first = 'new';
  assert.equal(original.exported.first, 'id1');
});
test('mobile release bundles no Node or Electron runtime dependencies', async () => {
  const result = await build({ entryPoints: ['src/main.ts'], bundle: true, write: false, metafile: true, platform: 'browser', format: 'cjs', target: ['safari15.4', 'chrome100'], external: ['obsidian', '@codemirror/*', '@lezer/*'] });
  const imports = Object.values(result.metafile!.outputs).flatMap(o => o.imports.map(i => i.path));
  assert(imports.every(p => p === 'obsidian' || p.startsWith('@codemirror/') || p.startsWith('@lezer/')));
  assert.equal(JSON.parse(fs.readFileSync('manifest.json', 'utf8')).isDesktopOnly, false);
});
