import { Binding, link, uid, cloneData } from './model';
import { parseDocument, entryText, groupTitle } from './document';
export interface CanvasNode { id: string; type: string; x: number; y: number; width: number; height: number; text?: string; [key: string]: unknown }
export interface CanvasData { nodes: CanvasNode[]; edges: { id: string; fromNode: string; toNode: string; [key: string]: unknown }[]; [key: string]: unknown }
interface Desired { key: string; parent?: string; text: string; depth: number }
export interface CanvasLedger { binding: string; exported: Record<string, string>; target?: string; parents?: Record<string, string>; branchEdges?: Record<string, string>; selection?: string[] }
export function buildCanvas(note: string, binding: Binding, previous?: string, savedLedger?: CanvasLedger, selection?: string[]): string {
  const parsed = parseDocument(note);
  let canvas: CanvasData = { nodes: [], edges: [] };
  if (previous) {
    try { canvas = JSON.parse(previous); } catch { throw new Error('导图文件不是有效 JSON，已停止更新。'); }
    if (!Array.isArray(canvas.nodes) || !Array.isArray(canvas.edges) || canvas.nodes.some(n => !n.id || !Number.isFinite(n.x) || !Number.isFinite(n.y) || !Number.isFinite(n.height))) throw new Error('导图结构异常，已停止更新。');
    if ((savedLedger ?? canvas.highlightCompanion as any)?.binding !== binding.id) throw new Error('该导图缺少本插件的导出记录，请另存完整导图。');
  }
  // Persist tombstones in the Canvas itself: deleted cards stay deleted on incremental export.
  const metadata = cloneData(savedLedger ?? canvas.highlightCompanion ?? { binding: binding.id, exported: {} }) as CanvasLedger;
  if (!metadata.exported || typeof metadata.exported !== 'object') throw new Error('导图导出记录损坏。');
  metadata.parents ??= {};
  metadata.branchEdges ??= {};
  // Older exports have no edge ledger. Adopt only an unambiguous standard branch.
  const keys = new Map(Object.entries(metadata.exported).map(([key, id]) => [id, key]));
  for (const [key, id] of Object.entries(metadata.exported)) {
    if (metadata.parents[key]) continue;
    const incoming = canvas.edges.filter(edge => edge.toNode === id && keys.has(edge.fromNode) && edge.fromSide === 'right' && edge.toSide === 'left' && edge.toEnd === 'arrow');
    if (incoming.length === 1) {
      metadata.parents[key] = keys.get(incoming[0].fromNode)!;
      metadata.branchEdges[key] = incoming[0].id;
    }
  }
  let desired: Desired[] = [{ key: 'book', text: `# ${binding.source.split('/').at(-1)!.replace(/\.md$/, '')}\n\n${link(binding.target, undefined, '打开重点笔记')}`, depth: 0 }];
  for (const c of parsed.chapters) desired.push({ key: 'c-' + c.id, parent: c.meta.parents.length ? 'c-' + c.meta.parents.at(-1) : 'book', text: c.meta.title, depth: c.meta.parents.length + 1 });
  for (const c of parsed.chapters) {
    for (const item of c.children) {
      if (item.kind === 'group') {
        const intro = note.slice(item.bodyFrom, item.children[0]?.from ?? item.bodyTo).trim();
        desired.push({ key: 'g-' + item.id, parent: 'c-' + c.id, text: `${intro || groupTitle(note, item)}\n\n${link(binding.target, 'hcg-' + item.id, '查看重点')}`, depth: c.meta.parents.length + 2 });
      }
      const entries = item.kind === 'group' ? item.children : [item];
      for (const e of entries) if (e.kind === 'entry') desired.push({ key: 'e-' + e.id, parent: item.kind === 'group' ? 'g-' + item.id : 'c-' + c.id, text: `${entryText(note, e)}\n\n${link(binding.target, 'hc-' + e.id, '查看重点')}`, depth: c.meta.parents.length + (item.kind === 'group' ? 3 : 2) });
    }
  }
  const chosen = selection ?? metadata.selection;
  if (chosen) {
    if (!chosen.length || (!previous && chosen.some(key => !desired.some(d => d.key === key && /^[eg]-/.test(key))))) throw new Error('请勾选有效的重点或关键词。');
    const keep = new Set<string>(['book']);
    for (const item of desired) {
      if (!chosen.includes(item.key) && !(item.parent?.startsWith('g-') && chosen.includes(item.parent))) continue;
      let node: Desired | undefined = item;
      while (node && !keep.has(node.key)) { keep.add(node.key); node = desired.find(d => d.key === node!.parent); }
    }
    desired = desired.filter(d => keep.has(d.key));
    metadata.selection = [...chosen];
  }
  const heightFor = (item: Desired) => Math.max(120, Math.min(600, 60 + Math.ceil(item.text.replace(/\]\(<[^>]+>\)/g, ']').length / 20) * 24));
  const layout = new Map<string, number>();
  const subtree = (item: Desired): number => Math.max(heightFor(item), desired.filter(d => d.parent === item.key).reduce((sum, d) => sum + subtree(d) + 40, -40));
  const place = (item: Desired, top: number) => {
    const size = subtree(item); layout.set(item.key, top + (size - heightFor(item)) / 2);
    let cursor = top;
    for (const child of desired.filter(d => d.parent === item.key)) { place(child, cursor); cursor += subtree(child) + 40; }
  };
  if (!previous) place(desired[0], 0);
  let y = canvas.nodes.length ? Math.max(...canvas.nodes.map(n => n.y + n.height)) + 100 : 0;
  const existingIds = new Set(canvas.nodes.map(n => n.id));
  for (const item of desired) {
    if (metadata.exported[item.key]) continue;
    const id = uid(); metadata.exported[item.key] = id;
    const height = heightFor(item);
    canvas.nodes.push({ id, type: 'text', text: item.text, x: item.depth * 360, y: layout.get(item.key) ?? y, width: 280, height, color: item.key === 'book' ? '4' : item.key.startsWith('c-') ? '5' : item.key.startsWith('g-') ? '3' : undefined });
    existingIds.add(id); y += height + 50;
    let parentKey = item.parent;
    // If the user deleted a parent, attach new content to the nearest surviving ancestor.
    while (parentKey && !existingIds.has(metadata.exported[parentKey])) parentKey = desired.find(d => d.key === parentKey)?.parent;
    if (parentKey) {
      const edgeId = uid();
      canvas.edges.push({ id: edgeId, fromNode: metadata.exported[parentKey], toNode: id, fromSide: 'right', toSide: 'left', toEnd: 'arrow' });
      metadata.parents[item.key] = item.parent!;
      metadata.branchEdges[item.key] = edgeId;
    }
  }
  // Regrouped keywords already exist: update their branch without replacing cards.
  for (const item of desired.filter(item => item.key.startsWith('e-'))) {
    const id = metadata.exported[item.key], parent = item.parent!;
    if (!existingIds.has(id) || !existingIds.has(metadata.exported[parent])) continue;
    if (metadata.parents[item.key] === parent) continue;
    if (!metadata.parents[item.key] && !parent.startsWith('g-')) {
      metadata.parents[item.key] = parent;
      continue;
    }
    const old = canvas.edges.find(edge => edge.id === metadata.branchEdges![item.key]);
    if (old && old.toNode === id && old.fromNode === metadata.exported[metadata.parents[item.key]]) {
      old.fromNode = metadata.exported[parent];
    } else {
      const edgeId = uid();
      canvas.edges.push({ id: edgeId, fromNode: metadata.exported[parent], toNode: id, fromSide: 'right', toSide: 'left', toEnd: 'arrow' });
      metadata.branchEdges[item.key] = edgeId;
    }
    metadata.parents[item.key] = parent;
  }
  canvas.highlightCompanion = metadata;
  return JSON.stringify(canvas, null, 2);
}
