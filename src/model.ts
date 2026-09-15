export interface Chapter { id: string; title: string; depth: number; parents: string[] }
export interface Entry { id: string; text: string; chapter: string; sourceBlock: string; created: string }
export interface Group { id: string; title: string; chapter: string }
export interface Binding { id: string; source: string; target: string; canvas?: string }
export interface Pending { binding: string; before: string; after: string; chapters: Chapter[]; entries: Entry[] }
export interface UndoRecord { binding: string; sourceBefore: string; sourceAfter: string; targetBefore: string; targetAfter: string; count: number }
export interface State { version: 1; folder: string; bindings: Binding[]; pending?: Pending; undoPending?: UndoRecord & { restoring?: boolean }; lastUndo?: UndoRecord; indexes?: Record<string, string[]>; canvasLedgers?: Record<string, import('./canvas').CanvasLedger> }
export const emptyState = (): State => ({ version: 1, folder: '重点笔记', bindings: [] });
export const uid = () => {
  // getRandomValues is available in mobile WebViews without randomUUID's secure-context requirement.
  const bytes = new Uint8Array(8); globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
};
export const cloneData = <T>(value: T): T => JSON.parse(JSON.stringify(value));
export const encode = (value: unknown) => encodeURIComponent(JSON.stringify(value));
export const decode = <T>(value: string): T => JSON.parse(decodeURIComponent(value));
export const escapeText = (value: string) => value.replace(/[\\`*_[\]<>#]/g, '\\$&').replace(/\r?\n/g, ' ');
export const link = (path: string, block?: string, label = '返回原文') => `[${label}](<${path.split('/').map(encodeURIComponent).join('/')}${block ? '#^' + block : ''}>)`;
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
