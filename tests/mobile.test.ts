import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { build } from 'esbuild';
import { snapshotSelection, selectionPreview, readingSelection, readingActionPosition } from '../src/selection';
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
test('reading selection uses DOM neighbours for repeated words and normalized soft breaks', () => {
  const source = '# 章\n\n甲与甲不同。\n\n细胞\n膜有结构。';
  const pick = readingSelection(source, '甲', 2, 2, { before: '甲与', after: '不同。' });
  assert.equal(pick.from, source.indexOf('甲不同'));
  const wrapped = readingSelection(source, '细胞 膜', 4, 5, { before: '', after: '有结构。' });
  assert.equal(source.slice(wrapped.from, wrapped.to), '细胞\n膜');
  assert.throws(() => readingSelection('甲和甲', '甲', 0, 0, { before: '', after: '' }), /无法唯一定位/);
  assert.throws(() => readingSelection('甲和甲', '甲', 0, 0, { before: '不存在', after: '' }), /无法唯一定位/);
});
test('reading mapping ignores formatting, highlight markers and hidden metadata around plain selections', () => {
  const source = '**说明**：==甲==[重点](<note.md#^hc-one>)<!--hc-h:one-->与甲。 ^hc-src-one';
  const pick = readingSelection(source, '甲', 0, 0, { before: '说明：甲重点与', after: '。' });
  assert.equal(pick.from, source.lastIndexOf('甲'));
  assert.throws(() => readingSelection('**细胞**膜', '细胞膜', 0, 0, { before: '', after: '' }), /无法唯一定位/);
});
test('reading actions reserve native-menu space and respect visual viewport bounds', () => {
  const viewport = { left: 0, top: 0, width: 390, height: 700 }, size = { width: 240, height: 100 };
  const middle = readingActionPosition({ left: 10, width: 60, top: 250, bottom: 280 }, size, viewport);
  assert.equal(middle.top, 360); assert.equal(middle.left, 8);
  const bottom = readingActionPosition({ left: 360, width: 20, top: 600, bottom: 625 }, size, viewport);
  assert.equal(bottom.top, 420); assert.equal(bottom.left, 142);
  const zoomed = readingActionPosition({ left: 100, width: 10, top: 55, bottom: 75 }, size, { left: 30, top: 40, width: 280, height: 300 });
  assert(zoomed.top >= 48 && zoomed.top + size.height <= 332); assert(zoomed.left >= 38);
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
