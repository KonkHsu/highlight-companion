import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder, normalizePath, MarkdownRenderChild, Platform, Menu } from 'obsidian';
import { Binding, State, emptyState, uid, SerialQueue, ExamType, examTypes } from './model';
import { capture } from './source';
import { newDocument, parseDocument, appendEntries, arrange, renameGroup, dissolveGroup, entryText, groupTitle, rewriteBinding, rewriteLinks, addManualGroup, addCustomEntry, setExamTypes, migrateGroupDisplays } from './document';
import { buildCanvas, CanvasLedger } from './canvas';
import { commitCapture, commitUndo, finishPending, Storage } from './engine';
import { removeEntries, removeHighlights, selectedEntryIds } from './undo';
import { hideInternalMarkers } from './editor';
import { snapshotSelection, selectionPreview, SelectionSnapshot, readingSelection, readingActionPosition } from './selection';
import { SelectionMemory, rememberEditorSelection } from './selection-memory';

export default class HighlightCompanion extends Plugin {
  state: State = emptyState();
  queue = new SerialQueue();
  selectionMemory = new SelectionMemory();
  io: Storage = { read: async path => {
    const text = await this.read(path), b = this.state.bindings.find(b => b.target === path);
    if (b) this.validateIndex(text, b);
    return text;
  }, change: (path, fn) => this.change(path, fn), save: () => this.saveData(this.state) };
  async onload() {
    const loaded = await this.loadData();
    if (loaded && (loaded.version !== 1 || !Array.isArray(loaded.bindings))) throw new Error('重点收录数据版本无法读取，请恢复 data.json 备份。');
    this.state = loaded ?? emptyState();
    this.registerEditorExtension(hideInternalMarkers);
    this.registerEditorExtension(rememberEditorSelection(this.selectionMemory));
    this.addSettingTab(new Settings(this.app, this));
    this.addCommand({ id: 'bind-note', name: '绑定重点笔记', icon: 'link', callback: () => this.run(() => this.bindActive()) });
    this.addCommand({ id: 'highlight-collect', name: '高亮并收录', icon: 'highlighter', editorCallback: (editor, view) => { if (view.file) this.collect(view.file, editor); } });
    this.addCommand({ id: 'undo-highlight', name: '撤销高亮并移除重点', icon: 'undo-2', callback: () => {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (view?.file && view.getMode() === 'source') this.undoSelection(view.file, view.editor);
      else this.run(async () => this.showUndoPicker());
    } });
    this.addCommand({ id: 'restore-undo', name: '恢复上次撤销', icon: 'redo-2', callback: () => this.run(() => this.restoreUndo()) });
    this.addCommand({ id: 'capture-panel', name: '收录与整理面板', icon: 'panel-bottom', callback: () => this.showPanel() });
    this.addCommand({ id: 'import-highlights', name: '收录当前课本已有高亮', icon: 'list-plus', callback: () => this.run(() => this.importActive()) });
    this.addCommand({ id: 'open-note', name: '打开重点笔记', icon: 'notebook-pen', callback: () => this.run(async () => { const b = await this.contextBinding(); await this.open(b.target); }) });
    this.addCommand({ id: 'organize', name: '整理重点', icon: 'list-tree', callback: () => this.run(async () => { const b = await this.contextBinding(); new OrganizeModal(this.app, this, b).open(); }) });
    this.addCommand({ id: 'manual-point', name: '手动增加重点', callback: () => this.run(async () => new ManualGroupModal(this.app, this, await this.contextBinding()).open()) });
    this.addCommand({ id: 'canvas-selected', name: '勾选内容创建导图', callback: () => this.run(async () => new CanvasSelectionModal(this.app, this, await this.contextBinding()).open()) });
    this.addCommand({ id: 'canvas-update', name: '生成或增补思维导图', icon: 'git-fork', callback: () => this.run(async () => this.chooseCanvas(await this.contextBinding())) });
    this.addCommand({ id: 'canvas-new', name: '另存完整思维导图', icon: 'copy-plus', callback: () => this.run(async () => this.exportCanvas(await this.contextBinding(), true)) });
    this.addCommand({ id: 'recover', name: '恢复未完成收录并检查绑定', icon: 'refresh-cw', callback: () => this.run(async () => { await finishPending(this.state, this.io); await this.reconcile(true); new Notice('恢复与检查完成。'); }) });
    this.addRibbonIcon('highlighter', '重点收录：收录与整理', () => this.showPanel());
    this.registerEvent(this.app.workspace.on('editor-menu', (menu, editor, view) => {
      if (!view.file || view.file.extension !== 'md') return;
      const file = view.file;
      if (Platform.isMobileApp || document.body.classList.contains('is-mobile')) return;
      menu.addItem(i => i.setTitle('高亮并收录').setIcon('highlighter').onClick(() => this.collect(file, editor)));
      menu.addItem(i => i.setTitle('撤销高亮并移除重点').setIcon('undo-2').onClick(() => this.undoSelection(file, editor)));
      menu.addItem(i => i.setTitle('整理重点').setIcon('list-tree').onClick(() => this.run(async () => new OrganizeModal(this.app, this, await this.contextBinding()).open())));
    }));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      if (file instanceof TFile || file instanceof TFolder) this.run(() => this.renamed(oldPath, file.path));
    }));
    this.registerEvent(this.app.workspace.on('layout-change', () => this.run(() => this.refreshCanvasLinks())));
    this.registerMarkdownPostProcessor((element, context) => {
      const listener = new MarkdownRenderChild(element); context.addChild(listener);
      element.addClass('hc-reading-selection');
      listener.register(() => element.removeClass('hc-reading-selection'));
      type ReadingPick = { text: string; info: ReturnType<typeof context.getSectionInfo>; range: Range; file: TFile; neighbours: { before: string; after: string } };
      let mobileActions: HTMLElement | undefined;
      let selectionTimer: number | undefined;
      let dragging = false;
      const clearMobileActions = () => { mobileActions?.remove(); mobileActions = undefined; };
      const readingPick = (): ReadingPick | undefined => {
        const selection = element.ownerDocument.defaultView?.getSelection();
        if (!selection || selection.isCollapsed || !selection.rangeCount) return;
        const range = selection.getRangeAt(0);
        if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) return;
        const startElement = range.startContainer.nodeType === 1 ? range.startContainer as HTMLElement : range.startContainer.parentElement;
        const block = startElement?.closest('p, li') as HTMLElement | null;
        const scope = block && element.contains(block) && block.contains(range.endContainer) ? block : element;
        const info = context.getSectionInfo(scope) ?? context.getSectionInfo(element), selectedText = range.toString();
        if (!info || !selectedText.trim()) return;
        const file = this.app.vault.getAbstractFileByPath(context.sourcePath);
        if (!(file instanceof TFile)) return;
        const before = range.cloneRange(); before.selectNodeContents(scope); before.setEnd(range.startContainer, range.startOffset);
        const after = range.cloneRange(); after.selectNodeContents(scope); after.setStart(range.endContainer, range.endOffset);
        return { text: selectedText, info, range: range.cloneRange(), file, neighbours: { before: before.toString(), after: after.toString() } };
      };
      const act = (pick: ReadingPick, undo: boolean) => this.run(async () => {
          clearMobileActions();
          const source = await this.read(pick.file.path);
          if (!pick.info || source !== pick.info.text) throw new Error('笔记已变化，请重新选择文字。');
          const snapshot = readingSelection(source, pick.text, pick.info.lineStart, pick.info.lineEnd, pick.neighbours);
          if (undo) await this.undoSnapshot(pick.file, snapshot);
          else await this.collectSnapshot(pick.file, snapshot);
      });
      listener.registerDomEvent(element, 'contextmenu', event => {
        if (Platform.isMobileApp || element.ownerDocument.body.classList.contains('is-mobile')) {
          event.preventDefault(); event.stopImmediatePropagation(); scheduleMobileActions(); return;
        }
        const pick = readingPick();
        if (!pick) return;
        event.preventDefault(); event.stopPropagation(); clearMobileActions();
        const menu = new Menu();
        menu.addItem(i => i.setTitle('高亮并收录').setIcon('highlighter').onClick(() => act(pick, false)));
        menu.addItem(i => i.setTitle('撤销高亮并移除重点').setIcon('undo-2').onClick(() => act(pick, true)));
        menu.showAtMouseEvent(event);
      }, true);
      const scheduleMobileActions = () => {
        if (!Platform.isMobileApp && !element.ownerDocument.body.classList.contains('is-mobile')) return;
        clearMobileActions();
        if (selectionTimer !== undefined) element.ownerDocument.defaultView?.clearTimeout(selectionTimer);
        selectionTimer = element.ownerDocument.defaultView?.setTimeout(() => {
          if (dragging) return;
          const pick = readingPick();
          if (!pick) return;
          const rect = pick.range.getBoundingClientRect();
          if (!rect.width && !rect.height) return;
          const bar = element.ownerDocument.body.createDiv({ cls: 'hc-reading-actions' });
          bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', '选中文字操作');
          mobileActions = bar;
          const add = (label: string, undo: boolean) => {
            const button = bar.createEl('button', { text: label });
            listener.registerDomEvent(button, 'pointerdown', event => event.preventDefault());
            listener.registerDomEvent(button, 'click', () => act(pick, undo));
          };
          add('高亮并收录', false); add('撤销高亮并移除重点', true);
          const win = element.ownerDocument.defaultView!, viewport = win.visualViewport;
          const position = readingActionPosition(rect, bar.getBoundingClientRect(), {
            left: viewport?.offsetLeft ?? 0, top: viewport?.offsetTop ?? 0,
            width: viewport?.width ?? win.innerWidth, height: viewport?.height ?? win.innerHeight
          });
          bar.style.transform = 'none';
          bar.style.left = `${position.left}px`; bar.style.top = `${position.top}px`;
        }, 120);
      };
      listener.registerDomEvent(element.ownerDocument, 'selectionchange', scheduleMobileActions);
      const start = (event: Event) => { if (mobileActions?.contains(event.target as Node)) return; dragging = true; clearMobileActions(); };
      const end = (event: Event) => { if (mobileActions?.contains(event.target as Node)) return; dragging = false; scheduleMobileActions(); };
      listener.registerDomEvent(element.ownerDocument, 'touchstart', start, { passive: true });
      listener.registerDomEvent(element.ownerDocument, 'pointerdown', start, { passive: true });
      listener.registerDomEvent(element.ownerDocument, 'touchend', end, { passive: true });
      listener.registerDomEvent(element.ownerDocument, 'pointerup', end, { passive: true });
      listener.registerDomEvent(element.ownerDocument, 'touchcancel', end, { passive: true });
      listener.registerDomEvent(element.ownerDocument, 'pointercancel', end, { passive: true });
      // iOS scrolls the reading pane while a selection handle is being moved.
      // Reposition after that scroll instead of immediately hiding the actions.
      listener.registerDomEvent(element.ownerDocument, 'scroll', scheduleMobileActions, true);
      listener.register(() => {
        if (selectionTimer !== undefined) element.ownerDocument.defaultView?.clearTimeout(selectionTimer);
        clearMobileActions();
      });
      const b = this.state.bindings.find(b => b.target === context.sourcePath);
      if (!b) return;
      // Only the document title section gets a toolbar, not every rendered paragraph.
      const info = context.getSectionInfo(element);
      if (info?.lineStart !== 0 && !element.querySelector('h1')) return;
      const toolbar = element.createDiv({ cls: 'hc-toolbar' });
      const child = new MarkdownRenderChild(toolbar); context.addChild(child);
      toolbar.setAttribute('role', 'group'); toolbar.setAttribute('aria-label', '重点笔记操作');
      const add = (name: string, fn: () => void, primary = false) => {
        const button = toolbar.createEl('button', { text: name, cls: primary ? 'mod-cta' : '' });
        child.registerDomEvent(button, 'click', fn); return button;
      };
      add('整理重点', () => new OrganizeModal(this.app, this, b).open(), true);
      add('新增重点', () => new ManualGroupModal(this.app, this, b).open());
      add('思维导图', () => this.chooseCanvas(b));
      const more = add('更多', () => this.showNoteMenu(b, more));
      more.setAttribute('aria-haspopup', 'menu');
    });
    this.registerMobileEditorActions();
    this.app.workspace.onLayoutReady(() => this.run(async () => {
      await finishPending(this.state, this.io); await this.reconcile();
      for (const binding of this.state.bindings) await this.change(binding.target, migrateGroupDisplays);
    }));
  }
  showNoteMenu(binding: Binding, anchor: HTMLElement) {
    const menu = new Menu();
    menu.addItem(i => i.setTitle('返回原文').setIcon('book-open').onClick(() => this.run(() => this.open(binding.source))));
    menu.addSeparator();
    menu.addItem(i => i.setTitle('移除收录…').setIcon('trash-2').onClick(() => new OrganizeModal(this.app, this, binding, 'remove').open()));
    menu.addItem(i => i.setTitle('恢复上次撤销').setIcon('redo-2').setDisabled(!this.state.lastUndo).onClick(() => this.run(() => this.restoreUndo())));
    menu.addSeparator();
    menu.addItem(i => i.setTitle('检查绑定并恢复未完成操作').setIcon('refresh-cw').onClick(() => this.run(async () => { await finishPending(this.state, this.io); await this.reconcile(true); new Notice('恢复与检查完成。'); })));
    const rect = anchor.getBoundingClientRect(); menu.showAtPosition({ x: rect.left, y: rect.bottom + 6 });
  }
  registerMobileEditorActions() {
    let bar: HTMLElement | undefined, timer: number | undefined, dragging = false;
    const mobile = () => Platform.isMobileApp || document.body.classList.contains('is-mobile');
    const clear = () => { bar?.remove(); bar = undefined; if (timer !== undefined) window.clearTimeout(timer); };
    const schedule = () => {
      clear();
      if (!mobile() || dragging) return;
      timer = window.setTimeout(() => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (dragging || !view?.file || view.getMode() !== 'source') return;
        const snapshot = snapshotSelection(view.editor);
        if (!snapshot || snapshot.from === snapshot.to) return;
        const range = document.getSelection();
        if (!range?.rangeCount || !view.containerEl.contains(range.anchorNode)) return;
        const rect = range.getRangeAt(0).getBoundingClientRect();
        if (!rect.width && !rect.height) return;
        const file = view.file;
        bar = document.body.createDiv({ cls: 'hc-reading-actions' });
        bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', '选中文字操作');
        for (const [label, undo] of [['高亮并收录', false], ['撤销高亮并移除重点', true]] as const) {
          const button = bar.createEl('button', { text: label });
          button.onpointerdown = event => event.preventDefault();
          button.onclick = () => { clear(); this.run(() => undo ? this.undoSnapshot(file, snapshot) : this.collectSnapshot(file, snapshot)); };
        }
        const half = bar.getBoundingClientRect().width / 2;
        bar.style.left = `${Math.max(half + 8, Math.min(rect.left + rect.width / 2, window.innerWidth - half - 8))}px`;
        bar.style.top = `${rect.top > 110 ? rect.top - 10 : rect.bottom + 10}px`;
        bar.classList.toggle('hc-reading-actions-below', rect.top <= 110);
      }, 180);
    };
    this.registerDomEvent(document, 'contextmenu', event => {
      if (!mobile()) return;
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!view || view.getMode() !== 'source' || !view.containerEl.contains(event.target as Node)) return;
      event.preventDefault(); event.stopImmediatePropagation(); schedule();
    }, true);
    const start = (event: Event) => { if (bar?.contains(event.target as Node)) return; dragging = true; clear(); };
    const end = () => { dragging = false; schedule(); };
    this.registerDomEvent(document, 'pointerdown', start, { passive: true });
    this.registerDomEvent(document, 'touchstart', start, { passive: true });
    this.registerDomEvent(document, 'pointerup', end, { passive: true });
    this.registerDomEvent(document, 'touchend', end, { passive: true });
    this.registerDomEvent(document, 'pointercancel', end, { passive: true });
    this.registerDomEvent(document, 'touchcancel', end, { passive: true });
    this.registerDomEvent(document, 'selectionchange', schedule);
    this.registerDomEvent(document, 'scroll', schedule, true);
    this.registerDomEvent(window, 'resize', schedule);
    this.registerDomEvent(document, 'keydown', event => { if (event.key === 'Escape') clear(); });
    this.register(clear);
  }
  showUndoPicker(file = this.app.workspace.getActiveFile()) {
    const binding = this.state.bindings.find(b => b.source === file?.path || b.target === file?.path);
    if (!binding) throw new Error('请打开已绑定的课本或重点笔记，再撤销收录。');
    new OrganizeModal(this.app, this, binding, 'remove').open();
  }
  showPanel() {
    const file = this.app.workspace.getActiveFile();
    if (!file || !['md', 'canvas'].includes(file.extension)) { new Notice('请先打开课本、重点笔记或导图。'); return; }
    const view = this.editor(file.path);
    const selection = view ? this.selectionMemory.take(file.path, snapshotSelection(view.editor)) : undefined;
    new CapturePanel(this.app, this, file, selection).open();
  }
  run(task: () => Promise<unknown>) { void this.queue.run(task).catch(error => { console.error('[重点收录]', error); new Notice(error instanceof Error ? error.message : String(error), 9000); }); }
  file(path: string) { const file = this.app.vault.getAbstractFileByPath(path); if (!(file instanceof TFile)) throw new Error(`找不到「${path}」。请用“绑定重点笔记”重新定位，或恢复该文件。`); return file; }
  editor(path: string): MarkdownView | undefined {
    return this.app.workspace.getLeavesOfType('markdown').map(l => l.view).find((v): v is MarkdownView => v instanceof MarkdownView && v.file?.path === path && v.getMode() === 'source');
  }
  async read(path: string) { const file = this.file(path); return this.editor(path)?.editor.getValue() ?? await this.app.vault.read(file); }
  validateIndex(text: string, binding: Binding) {
    const parsed = parseDocument(text);
    if (parsed.binding.id !== binding.id) throw new Error('重点笔记绑定标识不匹配。');
    const expected = this.state.indexes?.[binding.id] ?? [];
    const pending = this.state.undoPending;
    const completedUndo = pending?.binding === binding.id && text === pending.targetAfter;
    if (!completedUndo && expected.some(id => !parsed.regions.some(r => r.id === id))) throw new Error('收录区域被手动删除，已停止自动修改。请恢复原区域，避免丢失整理内容。');
  }
  async change(path: string, update: (text: string) => string) {
    const file = this.file(path), view = this.editor(path);
    const binding = this.state.bindings.find(b => b.target === path);
    let updatedIndex: string[] | undefined;
    const checkedUpdate = (text: string) => {
      if (binding) {
        this.validateIndex(text, binding);
      }
      const after = update(text);
      if (binding) updatedIndex = parseDocument(after).regions.map(r => r.id);
      return after;
    };
    if (view) {
      const before = view.editor.getValue(), after = checkedUpdate(before);
      if (before !== after) {
        const cursor = view.editor.getCursor();
        view.editor.transaction({ changes: [{ from: { line: 0, ch: 0 }, to: view.editor.offsetToPos(before.length), text: after }] });
        view.editor.setCursor(cursor);
      }
      await view.save();
    } else await this.app.vault.process(file, checkedUpdate);
    if (binding && updatedIndex) { this.state.indexes ??= {}; this.state.indexes[binding.id] = updatedIndex; await this.io.save(); }
  }
  async open(path: string) { await this.app.workspace.getLeaf(false).openFile(this.file(path)); }
  active() { const file = this.app.workspace.getActiveFile(); if (!file || file.extension !== 'md') throw new Error('请先打开 Markdown 课本或重点笔记。'); return file; }
  async contextBinding(file = this.app.workspace.getActiveFile()) {
    if (!file) throw new Error('请先打开 Markdown 课本或重点笔记。');
    const ledger = this.state.canvasLedgers?.[file.path];
    const binding = this.state.bindings.find(b => b.source === file.path || b.target === file.path || b.canvas === file.path || b.id === ledger?.binding);
    if (binding) { this.file(binding.target); return binding; }
    if (file.extension !== 'md') throw new Error('该文件没有绑定重点笔记。');
    return this.ensureBinding(file);
  }
  async ensureBinding(file: TFile): Promise<Binding> {
    if (this.state.bindings.some(b => b.target === file.path)) throw new Error('请在原始课本中划重点，不能重复收录重点笔记。');
    const existing = this.state.bindings.find(b => b.source === file.path);
    if (existing) { this.file(existing.target); return existing; }
    return this.chooseBinding(file);
  }
  async bindActive() {
    const file = this.active();
    const existing = this.state.bindings.find(b => b.target === file.path);
    await this.chooseBinding(existing ? this.file(existing.source) : file);
  }
  async chooseBinding(source: TFile): Promise<Binding> {
    const current = this.state.bindings.find(b => b.source === source.path);
    const result = await new BindModal(this.app, current?.target ?? normalizePath(`${this.state.folder}/${source.basename}-重点.md`)).choose();
    if (!result) throw new Error('已取消绑定。');
    const path = normalizePath(result.path.trim());
    if (!path.endsWith('.md') || path.startsWith('/') || path.split('/').some(p => p === '..' || p === '.' || !p) || /[\x00-\x1f]/.test(path) || path.startsWith(this.app.vault.configDir + '/')) throw new Error('请输入库内有效的 .md 笔记路径。');
    if (path === source.path || this.state.bindings.some(b => b.id !== current?.id && (b.target === path || b.source === path))) throw new Error('课本和重点笔记必须不同，且目标不能被其他课本占用。');
    const target = this.app.vault.getAbstractFileByPath(path);
    if (target && result.mode === 'new') throw new Error('该路径已存在。请重新绑定，明确选择“使用已有笔记”或更换路径。');
    if (!target && result.mode === 'existing') throw new Error('所选笔记不存在，请检查路径或选择新建。');
    let binding: Binding = { id: current?.id ?? uid(), source: source.path, target: path, canvas: current?.canvas };
    if (target instanceof TFile) {
      const content = await this.read(path);
      if (content.includes('<!--hc:')) {
        const parsed = parseDocument(content);
        if (parsed.binding.id !== current?.id && parsed.binding.source !== source.path) throw new Error('该重点笔记已经绑定其他课本。');
        binding = { ...parsed.binding, source: source.path, target: path };
      } else if (current) throw new Error('重新定位时请选择包含原收录标识的重点笔记；移动已有笔记即可保留历史记录。');
      else await this.change(path, text => text + '\n\n' + newDocument(binding, source.basename));
    } else if (target) throw new Error('目标是文件夹，请选择笔记文件。');
    else {
      if (current) throw new Error('已有绑定请通过移动原重点笔记或恢复原文件来更换位置，以保留收录历史。');
      await this.ensureFolder(path);
      await this.app.vault.create(path, newDocument(binding, source.basename));
    }
    this.state.bindings = this.state.bindings.filter(b => b.id !== current?.id && b.id !== binding.id);
    this.state.bindings.push(binding); await this.io.save();
    await this.change(path, text => rewriteBinding(text, binding));
    if (current && current.target !== path) await this.change(source.path, text => rewriteLinks(text, current.target, path));
    new Notice(`已绑定：${path}`); return binding;
  }
  async ensureFolder(path: string) {
    const parts = path.split('/').slice(0, -1); let folder = '';
    for (const part of parts) { folder = folder ? folder + '/' + part : part; if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder); }
  }
  collect(file: TFile, editor: Editor) {
    const selection = this.selectionMemory.take(file.path, snapshotSelection(editor));
    this.run(() => this.collectSnapshot(file, selection));
  }
  undoSelection(file: TFile, editor: Editor) {
    const selection = this.selectionMemory.take(file.path, snapshotSelection(editor));
    this.run(() => this.undoSnapshot(file, selection));
  }
  async undoSnapshot(file: TFile, selection: SelectionSnapshot) {
      await finishPending(this.state, this.io);
      const b = this.state.bindings.find(b => b.source === file.path || b.target === file.path);
      if (!b) throw new Error('这篇笔记尚未绑定重点笔记。');
      if (await this.read(file.path) !== selection.source) throw new Error('笔记已变化，请重新选择后撤销。');
      const parsed = parseDocument(await this.io.read(b.target));
      const ids = file.path === b.target
        ? parsed.entries.filter(e => selection.from === selection.to ? selection.from >= e.from && selection.from < e.to : selection.from < e.to && selection.to > e.from).map(e => e.id)
        : selectedEntryIds(selection.source, parsed.entries.map(e => e.meta), selection.from, selection.to);
      await this.undoEntries(b, ids);
  }
  async undoEntries(binding: Binding, ids: string[]) {
    await finishPending(this.state, this.io);
    if (!ids.length) throw new Error('请将光标放在已收录高亮内，或在“整理重点”中勾选要撤销的条目。');
    const sourceBefore = await this.read(binding.source), targetBefore = await this.io.read(binding.target);
    const removed = removeEntries(targetBefore, ids);
    const sourceAfter = removeHighlights(sourceBefore, removed.entries);
    await commitUndo(this.state, this.io, { binding: binding.id, sourceBefore, sourceAfter, targetBefore, targetAfter: removed.note, count: removed.entries.length });
    new Notice(`已撤销 ${removed.entries.length} 条高亮与重点。误操作可执行“恢复上次撤销”；已有导图保持原样。`, 9000);
  }
  async restoreUndo() {
    await finishPending(this.state, this.io);
    const p = this.state.lastUndo;
    if (!p) throw new Error('没有可恢复的撤销记录。');
    const b = this.state.bindings.find(b => b.id === p.binding);
    if (!b) throw new Error('对应课本绑定已丢失。');
    if (await this.read(b.source) !== p.sourceAfter || await this.io.read(b.target) !== p.targetAfter) throw new Error('撤销后笔记已有新修改，无法直接恢复，以免覆盖修改。请通过文件恢复找回需要的内容。');
    await commitUndo(this.state, this.io, { ...p, sourceBefore: p.sourceAfter, sourceAfter: p.sourceBefore, targetBefore: p.targetAfter, targetAfter: p.targetBefore }, true);
    new Notice(`已恢复 ${p.count} 条高亮与重点。`);
  }
  async collectSnapshot(file: TFile, selection: SelectionSnapshot) {
      const { source: snapshot, from, to } = selection;
      if (from === to) throw new Error('请先选中关键词或句段。');
      await finishPending(this.state, this.io);
      const b = await this.ensureBinding(file);
      if (await this.read(file.path) !== snapshot) throw new Error('原文已变化，请重新选择文字后收录。');
      const result = capture(snapshot, b.target, { from, to });
      if (!result.entries.length) { new Notice('这处高亮已经收录。'); return; }
      await commitCapture(this.state, this.io, b, { before: snapshot, after: result.source, chapters: result.chapters, entries: result.entries });
      new Notice(`已收录到「${this.file(b.target).basename}」。`);
  }
  async importActive(file = this.active()) {
    await finishPending(this.state, this.io);
    const b = await this.ensureBinding(file), before = await this.read(file.path), result = capture(before, b.target);
    if (!result.entries.length) { new Notice(`没有新的可收录高亮，已跳过 ${result.duplicates} 条。`); return; }
    await commitCapture(this.state, this.io, b, { before, after: result.source, chapters: result.chapters, entries: result.entries });
    new Notice(`已收录 ${result.entries.length} 条，跳过 ${result.duplicates} 条已收录高亮。`);
  }
  canvasChoices(binding: Binding): string[] {
    return [...new Set([binding.canvas, ...Object.entries(this.state.canvasLedgers ?? {}).filter(([, ledger]) => ledger.binding === binding.id).map(([path]) => path)])]
      .filter((path): path is string => !!path && this.app.vault.getAbstractFileByPath(path) instanceof TFile);
  }
  chooseCanvas(binding: Binding) { new CanvasExportModal(this.app, this, binding).open(); }
  async exportCanvas(binding: Binding, fresh: boolean, selectedPath?: string, selection?: string[]) {
    const note = await this.read(binding.target);
    this.validateIndex(note, binding);
    let path = selectedPath ?? binding.canvas;
    if (selectedPath && !this.canvasChoices(binding).includes(selectedPath)) throw new Error('所选导图已丢失或不属于这篇重点笔记，请重新选择或新建导图。');
    if (!path || fresh) {
      const parent = binding.target.includes('/') ? binding.target.slice(0, binding.target.lastIndexOf('/') + 1) : '';
      const base = parent + '思维导图/' + this.file(binding.target).basename + '-思维导图'; path = base + '.canvas';
      let suffix = 2; while (this.app.vault.getAbstractFileByPath(path)) path = `${base}-${suffix++}.canvas`;
      const generated = buildCanvas(note, binding, undefined, undefined, selection);
      await this.ensureFolder(path);
      await this.app.vault.create(path, generated);
      this.state.canvasLedgers ??= {}; this.state.canvasLedgers[path] = { ...JSON.parse(generated).highlightCompanion, target: binding.target };
      binding.canvas = path; await this.io.save();
      await this.change(binding.target, text => rewriteBinding(text, binding));
    } else {
      this.file(path);
      // An open Canvas has its own delayed save queue: require it closed before external merge.
      const open = this.app.workspace.getLeavesOfType('canvas').some(l => (l.view as any).file?.path === path);
      if (open) throw new Error('请先关闭该导图标签页，再执行增补，以保留 Canvas 尚未保存的手动编辑。');
      let ledger: CanvasLedger | undefined;
      await this.change(path, current => {
        const saved = this.state.canvasLedgers?.[path!];
        if (saved?.target && saved.target !== binding.target) {
          const data = JSON.parse(current);
          for (const n of data.nodes ?? []) if (typeof n.text === 'string') n.text = rewriteLinks(n.text, saved.target, binding.target);
          current = JSON.stringify(data);
        }
        const result = buildCanvas(note, binding, current, saved);
        ledger = { ...JSON.parse(result).highlightCompanion, target: binding.target };
        return result;
      });
      this.state.canvasLedgers ??= {}; this.state.canvasLedgers[path] = ledger!;
      binding.canvas = path; await this.io.save();
      await this.change(binding.target, text => rewriteBinding(text, binding));
    }
    await this.open(path); new Notice(selection ? '已按勾选内容创建导图。' : fresh ? '已另存完整导图。' : '导图已生成或增补，已有卡片编辑保持不变。');
  }
  async reconcile(fullScan = false) {
    const found: Binding[] = [];
    // Known bindings avoid rereading an entire textbook vault on each mobile launch.
    const needsDiscovery = fullScan || !this.state.bindings.length || this.state.bindings.some(b => !this.app.vault.getAbstractFileByPath(b.target));
    const candidates = needsDiscovery ? this.app.vault.getMarkdownFiles() : this.state.bindings.map(b => this.file(b.target));
    for (const f of candidates) {
      const text = await this.app.vault.cachedRead(f);
      if (!text.includes('<!--hc:book:')) continue;
      try {
        const parsed = parseDocument(text), b = { ...parsed.binding, target: f.path };
        if (found.some(x => x.id === b.id)) { new Notice(`发现重点笔记副本「${f.path}」，请保留唯一的收录笔记。`, 9000); continue; }
        found.push(b);
        const known = this.state.bindings.find(x => x.id === b.id);
        if (!known) this.state.bindings.push(b);
        else if (!this.app.vault.getAbstractFileByPath(known.target)) known.target = f.path;
      } catch (error) { new Notice(`${f.path}：${(error as Error).message}`, 9000); }
    }
    for (const b of this.state.bindings) {
      if (!this.app.vault.getAbstractFileByPath(b.target) || !this.app.vault.getAbstractFileByPath(b.source)) new Notice(`「${b.source}」绑定的文件缺失，请重新定位或恢复。`, 9000);
      else { try {
        const parsed = parseDocument(await this.read(b.target));
        const expected = this.state.indexes?.[b.id];
        if (expected?.some(id => !parsed.regions.some(r => r.id === id))) throw new Error('重点笔记有区域被删除，请恢复收录标识后继续。');
        this.state.indexes ??= {}; this.state.indexes[b.id] = parsed.regions.map(r => r.id);
      } catch (e) { new Notice((e as Error).message, 9000); } }
    }
    await this.io.save();
  }
  async renamed(oldPath: string, newPath: string) {
    const remap = (path: string) => path === oldPath ? newPath : path.startsWith(oldPath + '/') ? newPath + path.slice(oldPath.length) : path;
    for (const [path, ledger] of Object.entries(this.state.canvasLedgers ?? {})) {
      const next = remap(path);
      if (next !== path) { this.state.canvasLedgers![next] = ledger; delete this.state.canvasLedgers![path]; }
    }
    for (const b of this.state.bindings) {
      const old = { ...b }; b.source = remap(b.source); b.target = remap(b.target); if (b.canvas) b.canvas = remap(b.canvas);
      if (old.source === b.source && old.target === b.target && old.canvas === b.canvas) continue;
      for (const record of [this.state.undoPending, this.state.lastUndo]) if (record?.binding === b.id) {
        record.sourceBefore = rewriteLinks(record.sourceBefore, old.target, b.target);
        record.sourceAfter = rewriteLinks(record.sourceAfter, old.target, b.target);
        record.targetBefore = rewriteBinding(rewriteLinks(record.targetBefore, old.source, b.source), b);
        record.targetAfter = rewriteBinding(rewriteLinks(record.targetAfter, old.source, b.source), b);
      }
      await this.io.save();
      if (this.state.pending?.binding === b.id) {
        this.state.pending.before = rewriteLinks(this.state.pending.before, old.target, b.target);
        this.state.pending.after = rewriteLinks(this.state.pending.after, old.target, b.target);
        await this.io.save();
      }
      if (this.app.vault.getAbstractFileByPath(b.source)) await this.change(b.source, t => rewriteLinks(t, old.target, b.target));
      if (this.app.vault.getAbstractFileByPath(b.target)) await this.change(b.target, t => rewriteBinding(rewriteLinks(t, old.source, b.source), b));
    }
    await this.refreshCanvasLinks();
    await this.io.save();
  }
  async refreshCanvasLinks() {
    for (const [path, ledger] of Object.entries(this.state.canvasLedgers ?? {})) {
      const b = this.state.bindings.find(b => b.id === ledger.binding);
      if (!b || !ledger.target || ledger.target === b.target || !this.app.vault.getAbstractFileByPath(path)) continue;
      if (this.app.workspace.getLeavesOfType('canvas').some(l => (l.view as any).file?.path === path)) continue;
      await this.change(path, text => {
        const data = JSON.parse(text);
        if (!Array.isArray(data.nodes)) throw new Error('导图结构异常，无法更新链接。');
        for (const n of data.nodes) if (typeof n.text === 'string') n.text = rewriteLinks(n.text, ledger.target!, b.target);
        return JSON.stringify(data, null, 2);
      });
      ledger.target = b.target; await this.io.save();
    }
  }
}

export class CapturePanel extends Modal {
  submitted = false;
  constructor(app: App, private plugin: HighlightCompanion, private file: TFile, private capturedSelection?: SelectionSnapshot) {
    super(app); this.shouldRestoreSelection = false;
  }
  onOpen() {
    this.modalEl.addClass('hc-panel', 'hc-responsive-modal');
    this.setTitle('收录与整理');
    this.contentEl.createEl('p', { cls: 'hc-subtitle', text: this.file.basename });
    const isSource = this.file.extension === 'md' && !this.plugin.state.bindings.some(b => b.target === this.file.path);
    const preview = isSource ? selectionPreview(this.capturedSelection) : '';
    if (isSource) this.contentEl.createEl('p', { cls: 'hc-capture-preview', text: preview || '先在原文中选中文字，即可高亮并收录。' });
    const actions = this.contentEl.createDiv({ cls: 'hc-panel-actions' });
    const add = (label: string, action: () => Promise<unknown>, enabled = true, primary = false) => {
      const button = actions.createEl('button', { text: label, cls: primary ? 'mod-cta' : '' });
      button.disabled = !enabled;
      button.onclick = () => {
        if (this.submitted) return;
        this.submitted = true; this.close(); this.plugin.run(action);
      };
    };
    if (isSource) {
      add('高亮并收录所选文字', () => this.plugin.collectSnapshot(this.file, this.capturedSelection!), !!preview, true);
      add('批量收录已有高亮', () => this.plugin.importActive(this.file));
      add('打开重点笔记', async () => this.plugin.open((await this.plugin.contextBinding(this.file)).target));
    } else {
      if (this.file.extension === 'canvas') add('返回重点笔记', async () => this.plugin.open((await this.plugin.contextBinding(this.file)).target));
      add('整理重点', async () => new OrganizeModal(this.app, this.plugin, await this.plugin.contextBinding(this.file)).open(), true, true);
      add('新增重点', async () => new ManualGroupModal(this.app, this.plugin, await this.plugin.contextBinding(this.file)).open());
      add('思维导图', async () => this.plugin.chooseCanvas(await this.plugin.contextBinding(this.file)));
    }
    const recovery = this.contentEl.createEl('details', { cls: 'hc-manage' });
    recovery.createEl('summary', { text: '移除与恢复' });
    const remove = recovery.createEl('button', { text: '移除收录…' });
    remove.disabled = !this.plugin.state.bindings.some(b => b.source === this.file.path || b.target === this.file.path);
    remove.onclick = () => { this.close(); this.plugin.run(async () => this.plugin.showUndoPicker(this.file)); };
    const restore = recovery.createEl('button', { text: '恢复上次撤销' }); restore.disabled = !this.plugin.state.lastUndo;
    restore.onclick = () => { this.close(); this.plugin.run(() => this.plugin.restoreUndo()); };
    const close = this.contentEl.createEl('button', { text: '关闭', cls: 'hc-close' }); close.onclick = () => this.close();
  }
  onClose() { this.contentEl.empty(); }
}

export class BindModal extends Modal {
  resolve?: (value: { path: string; mode: string } | null) => void;
  path: string; mode = 'new'; submitted = false;
  constructor(app: App, suggested: string) { super(app); this.path = suggested; }
  choose(): Promise<{ path: string; mode: string } | null> { return new Promise(resolve => { this.resolve = resolve; this.open(); }); }
  onOpen() {
    this.modalEl.addClass('hc-bind', 'hc-responsive-modal');
    this.setTitle('为课本绑定重点笔记');
    this.contentEl.createEl('p', { text: '只需绑定一次，以后的高亮会按章节续加到这里。' });
    let pathInput: HTMLInputElement, modeInput: HTMLSelectElement;
    new Setting(this.contentEl).setName('保存路径').addText(t => {
      pathInput = t.inputEl; pathInput.setAttribute('autocapitalize', 'none'); pathInput.spellcheck = false;
      t.setValue(this.path).setPlaceholder('重点笔记/课本名-重点.md').onChange(v => this.path = v);
    });
    new Setting(this.contentEl).setName('目标类型').addDropdown(d => {
      modeInput = d.selectEl;
      d.addOption('new', '新建笔记（不覆盖同名文件）').addOption('existing', '使用已有笔记（追加收录区）').onChange(v => this.mode = v);
    });
    const files = this.app.vault.getMarkdownFiles();
    new Setting(this.contentEl).setName('或选择已有笔记').addDropdown(d => {
      d.addOption('', '请选择…'); for (const f of files) d.addOption(f.path, f.path);
      d.onChange(v => { if (v) { this.path = v; this.mode = 'existing'; pathInput.value = v; modeInput.value = 'existing'; } });
    });
    new Setting(this.contentEl).addButton(b => b.setButtonText('绑定').setCta().onClick(() => { this.submitted = true; this.resolve?.({ path: this.path, mode: this.mode }); this.close(); })).addButton(b => b.setButtonText('取消').onClick(() => this.close()));
  }
  onClose() { if (!this.submitted) this.resolve?.(null); this.contentEl.empty(); }
}

class ManualGroupModal extends Modal {
  saving = false;
  constructor(app: App, private plugin: HighlightCompanion, private binding: Binding) { super(app); }
  onOpen() { this.modalEl.addClass('hc-responsive-modal'); this.setTitle('新增重点'); this.plugin.run(() => this.render()); }
  async render() {
    const parsed = parseDocument(await this.plugin.read(this.binding.target));
    let chapter = parsed.chapters[0]?.id ?? '', title = '', content = '';
    const types = new Set<ExamType>();
    new Setting(this.contentEl).setName('所属章节').addDropdown(d => {
      d.addOption('', '新建“手写重点”章节');
      parsed.chapters.forEach(c => d.addOption(c.id, c.meta.title));
      d.setValue(chapter).onChange(v => chapter = v);
    });
    new Setting(this.contentEl).setName('重点名称').addText(t => t.onChange(v => title = v));
    new Setting(this.contentEl).setName('重点内容').setDesc('保存到重点笔记后，可继续直接书写和修改。支持 Markdown。').addTextArea(t => {
      t.inputEl.rows = 6; t.setPlaceholder('书写重点内容…').onChange(v => content = v);
    });
    for (const type of examTypes) new Setting(this.contentEl).setName(type).addToggle(t => t.onChange(on => { if (on) types.add(type); else types.delete(type); }));
    new Setting(this.contentEl).addButton(b => b.setButtonText('添加并打开重点笔记').setCta().onClick(() => {
      const values = { chapter, title, content, types: [...types] };
      if (this.saving) return;
      this.saving = true;
      this.plugin.run(async () => {
        try {
          let groupId = '';
          await this.plugin.change(this.binding.target, text => {
            const before = new Set(parseDocument(text).groups.map(g => g.id));
            const result = addManualGroup(text, values.chapter, values.title, values.content, values.types);
            groupId = parseDocument(result).groups.find(g => !before.has(g.id))!.id;
            return result;
          });
          this.close(); await this.plugin.open(this.binding.target);
          const view = this.app.workspace.getActiveViewOfType(MarkdownView);
          if (view?.file?.path === this.binding.target) {
            await view.leaf.setViewState({ type: 'markdown', state: { file: this.binding.target, mode: 'source' } });
            const editor = view.editor, text = editor.getValue();
            const group = parseDocument(text).groups.find(g => g.id === groupId);
            if (group) {
              const contentStart = text.indexOf(values.content.trim() || '在这里书写重点内容。', group.bodyFrom);
              if (contentStart >= 0) {
                const pos = editor.offsetToPos(contentStart);
                editor.setCursor(pos); editor.scrollIntoView({ from: pos, to: pos }, true); editor.focus();
              }
            }
          }
          new Notice('已添加重点，可在笔记中继续书写。');
        } finally { this.saving = false; }
      });
    }));
  }
  onClose() { this.contentEl.empty(); }
}

class CanvasSelectionModal extends Modal {
  constructor(app: App, private plugin: HighlightCompanion, private binding: Binding) { super(app); }
  onOpen() { this.modalEl.addClass('hc-responsive-modal'); this.setTitle('选择导图内容'); this.plugin.run(() => this.render()); }
  async render() {
    const text = await this.plugin.read(this.binding.target), parsed = parseDocument(text);
    const selected = new Set<string>();
    this.contentEl.createEl('p', { text: '可跨章节勾选。选择重点会包含其全部关键词；单独选择关键词只包含该词及所属重点、章节。' });
    const boxes: HTMLInputElement[] = [];
    let submit: HTMLButtonElement;
    const tools = this.contentEl.createDiv({ cls: 'hc-selection-tools' });
    tools.createEl('button', { text: '全选' }).onclick = () => { boxes.forEach(b => { b.checked = true; selected.add(b.value); }); submit.disabled = !selected.size; };
    tools.createEl('button', { text: '清空' }).onclick = () => { boxes.forEach(b => b.checked = false); selected.clear(); submit.disabled = true; };
    const row = (key: string, label: string, nested = false) => {
      const el = this.contentEl.createEl('label', { cls: 'hc-row' });
      if (nested) el.addClass('hc-nested-keyword');
      const box = el.createEl('input', { type: 'checkbox' }); box.value = key; boxes.push(box);
      el.createEl('span', { text: label });
      box.onchange = () => { if (box.checked) selected.add(key); else selected.delete(key); submit.disabled = !selected.size; };
    };
    for (const c of parsed.chapters) {
      this.contentEl.createEl('h3', { text: [...c.meta.parents.map(id => parsed.chapters.find(p => p.id === id)?.meta.title ?? ''), c.meta.title].join(' / ') });
      for (const item of c.children) {
        if (item.kind === 'group') {
          row('g-' + item.id, '重点：' + groupTitle(text, item));
          item.children.forEach(e => row('e-' + e.id, entryText(text, e), true));
        } else row('e-' + item.id, entryText(text, item));
      }
    }
    const footer = this.contentEl.createDiv({ cls: 'hc-merge-footer' });
    const actions = footer.createDiv({ cls: 'hc-batch-actions' });
    actions.createEl('button', { text: '返回' }).onclick = () => { this.close(); this.plugin.chooseCanvas(this.binding); };
    submit = actions.createEl('button', { text: '创建导图', cls: 'mod-cta' }); submit.disabled = true;
    let submitting = false;
    submit.onclick = () => {
      if (submitting) return;
      submitting = true; submit.disabled = true;
      const ids = [...selected]; this.plugin.run(async () => {
        try { await this.plugin.exportCanvas(this.binding, true, undefined, ids); this.close(); }
        finally { submitting = false; submit.disabled = !selected.size; }
      });
    };
  }
  onClose() { this.contentEl.empty(); }
}

class CanvasExportModal extends Modal {
  constructor(app: App, private plugin: HighlightCompanion, private binding: Binding) { super(app); }
  onOpen() {
    this.modalEl.addClass('hc-responsive-modal');
    this.setTitle('思维导图');
    const paths = this.plugin.canvasChoices(this.binding);
    let selected = paths.includes(this.binding.canvas ?? '') ? this.binding.canvas! : paths[0];
    this.contentEl.createEl('h3', { text: '新建导图' });
    this.contentEl.createEl('p', { cls: 'hc-subtitle', text: '选择内容范围，生成一份新的可编辑导图。' });
    const choices = this.contentEl.createDiv({ cls: 'hc-export-choices' });
    const choice = (title: string, description: string, action: () => void) => {
      const button = choices.createEl('button', { cls: 'hc-choice' });
      button.createEl('strong', { text: title }); button.createEl('span', { text: description }); button.onclick = action;
    };
    choice('全部内容', '包含全部章节、重点和关键词', () => {
      this.close(); this.plugin.run(() => this.plugin.exportCanvas(this.binding, true));
    });
    choice('选择内容…', '勾选需要复习的重点和关键词', () => {
      this.close(); new CanvasSelectionModal(this.app, this.plugin, this.binding).open();
    });
    if (paths.length) {
      const update = this.contentEl.createDiv({ cls: 'hc-export-update' });
      update.createEl('h3', { text: '增补已有导图' });
      new Setting(update).setName('选择导图').setDesc('沿用原来的内容范围，补充新增内容并更新分组连线，保留卡片编辑。请先关闭所选导图。').addDropdown(d => {
        paths.forEach(path => d.addOption(path, path));
        d.setValue(selected).onChange(value => selected = value);
      });
      new Setting(update).addButton(button => button.setButtonText('增补这份导图').onClick(() => {
        this.close(); this.plugin.run(() => this.plugin.exportCanvas(this.binding, false, selected));
      }));
    }
    this.contentEl.createEl('p', { cls: 'hc-subtitle', text: '新导图保存在重点笔记旁的“思维导图”文件夹，同名文件会自动编号。' });
  }
  onClose() { this.contentEl.empty(); }
}

class ConfirmActionModal extends Modal {
  constructor(app: App, private heading: string, private description: string, private label: string, private action: () => void) { super(app); }
  onOpen() {
    this.modalEl.addClass('hc-responsive-modal'); this.setTitle(this.heading);
    this.contentEl.createEl('p', { text: this.description });
    new Setting(this.contentEl).addButton(b => b.setButtonText('取消').onClick(() => this.close()))
      .addButton(b => { b.setButtonText(this.label).setWarning().onClick(() => { this.close(); this.action(); }); });
  }
  onClose() { this.contentEl.empty(); }
}

class GroupDestinationModal extends Modal {
  constructor(app: App, private groups: { id: string; title: string }[], private choose: (id: string) => void) { super(app); }
  onOpen() {
    this.modalEl.addClass('hc-responsive-modal'); this.setTitle('加入哪个重点？');
    let selected = this.groups[0].id;
    new Setting(this.contentEl).setName('目标重点').addDropdown(d => { this.groups.forEach(g => d.addOption(g.id, g.title)); d.setValue(selected).onChange(id => selected = id); });
    new Setting(this.contentEl).addButton(b => b.setButtonText('取消').onClick(() => this.close()))
      .addButton(b => b.setButtonText('加入重点').setCta().onClick(() => { this.close(); this.choose(selected); }));
  }
  onClose() { this.contentEl.empty(); }
}

export class OrganizeModal extends Modal {
  keywordDraft = ''; addingKeyword = false;
  selected = new Set<string>(); title = ''; group = ''; chapter = ''; alive = true; busy = false; step: 'select' | 'name' = 'select';
  constructor(app: App, private plugin: HighlightCompanion, private binding: Binding, private mode: 'keywords' | 'groups' | 'remove' = 'keywords') { super(app); }
  onOpen() { this.modalEl.addClass('hc-organizer', 'hc-responsive-modal'); this.setTitle(this.mode === 'remove' ? '移除收录' : '整理重点'); void this.render().catch(e => new Notice(e.message)); }
  async updateNote(update: (text: string) => string, success = '重点已更新。') {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.plugin.change(this.binding.target, current => update(current));
      this.selected.clear(); this.title = ''; this.group = ''; this.step = 'select';
      await this.render(); new Notice(success);
    } finally { this.busy = false; }
  }
  async render() {
    const text = await this.plugin.read(this.binding.target), parsed = parseDocument(text);
    if (!this.alive) return;
    this.contentEl.empty();
    const chapters = this.mode === 'keywords' ? parsed.chapters : parsed.chapters.filter(c => c.children.length > 0);
    if (!(this.mode === 'remove' && this.chapter === '*') && (!this.chapter || !chapters.some(c => c.id === this.chapter))) this.chapter = this.mode === 'remove' ? '*' : (chapters.find(c => c.children.length > 0) ?? chapters[0])?.id ?? '';
    const picked = parsed.entries.filter(e => this.selected.has(e.id));
    if (this.step === 'name') {
      this.renderName(text, parsed, picked);
      return;
    }
    if (this.mode !== 'remove') {
      const tabs = this.contentEl.createDiv({ cls: 'hc-view-switch' }); tabs.setAttribute('role', 'group'); tabs.setAttribute('aria-label', '整理方式');
      for (const [mode, label] of [['keywords', '关键词归组'], ['groups', '重点管理']] as const) {
        const button = tabs.createEl('button', { text: label }); button.setAttribute('aria-pressed', String(this.mode === mode));
        button.onclick = () => { this.mode = mode; this.selected.clear(); this.plugin.run(async () => {
          await this.render(); this.contentEl.querySelector<HTMLButtonElement>('.hc-view-switch button[aria-pressed=true]')?.focus();
        }); };
      }
    }
    this.contentEl.createEl('p', { cls: 'hc-subtitle', text: this.mode === 'remove'
      ? '勾选要移除的条目。确认后会移除条目及其手写说明，并取消关联的原文高亮；自定义关键词不影响原文。'
      : this.mode === 'groups' ? '在对应重点下修改名称和题型，或解散重点。' : '先选择关键词，再创建重点或加入已有重点。' });
    new Setting(this.contentEl).setName('章节筛选').addDropdown(d => {
      if (this.mode === 'remove') d.addOption('*', '全部章节');
      for (const c of chapters) {
        const label = [...c.meta.parents.map(id => parsed.chapters.find(x => x.id === id)?.meta.title ?? ''), c.meta.title].join(' / ');
        d.addOption(c.id, label);
      }
      d.setValue(this.chapter).onChange(v => { this.chapter = v; this.selected.clear(); void this.render().catch(e => new Notice(e.message)); });
    });
    if (this.mode === 'groups') { this.renderGroups(text, parsed); return; }
    const chapterEntries = parsed.entries.filter(e => this.chapter === '*' || e.meta.chapter === this.chapter);
    let count: HTMLElement, next: HTMLButtonElement, hint: HTMLElement;
    const refreshSelection = () => {
      count?.setText(`已勾选 ${this.selected.size} 个关键词`);
      if (next) { next.disabled = this.selected.size === 0; next.setText(this.mode === 'remove' ? `移除所选 ${this.selected.size} 条…` : '创建重点…'); }
      hint?.setText(this.mode === 'remove' ? '移除后，可在继续编辑前通过“更多 → 恢复上次撤销”恢复。' : this.selected.size === 0 ? '勾选关键词后显示可用操作。' : '可以创建新重点，也可以放入已有重点。');
      batchControls?.forEach(button => button.disabled = this.selected.size === 0);
    };
    const batchControls: HTMLButtonElement[] = [];
    const selectionTools = this.contentEl.createDiv({ cls: 'hc-selection-tools' });
    const all = selectionTools.createEl('button', { text: this.chapter === '*' ? '全选' : '本章全选' });
    const clear = selectionTools.createEl('button', { text: '清空选择' });
    all.onclick = () => { chapterEntries.forEach(e => this.selected.add(e.id)); void this.render(); };
    clear.onclick = () => { this.selected.clear(); void this.render(); };
    if (!chapterEntries.length) this.contentEl.createEl('p', { text: '此处没有收录的关键词。可切换章节，或到“重点管理”查看手写重点。', cls: 'hc-empty' });
    const section = this.contentEl.createDiv({ cls: 'hc-chapter hc-keyword-list' });
    const current = chapters.find(c => c.id === this.chapter);
    if (current) section.createEl('h3', { text: [...current.meta.parents.map(id => parsed.chapters.find(x => x.id === id)?.meta.title ?? ''), current.meta.title].join(' / ') });
    for (const e of chapterEntries) {
      const row = section.createEl('label', { cls: 'hc-row' });
      const checkbox = row.createEl('input', { type: 'checkbox' }); checkbox.checked = this.selected.has(e.id);
      checkbox.onchange = () => { if (checkbox.checked) this.selected.add(e.id); else this.selected.delete(e.id); refreshSelection(); };
      const copy = row.createDiv(); copy.createEl('span', { text: entryText(text, e) });
      if (this.chapter === '*') copy.createEl('small', { text: parsed.chapters.find(c => c.id === e.meta.chapter)?.meta.title ?? '', cls: 'hc-group-label' });
      if (e.parent?.kind === 'group') copy.createEl('small', { text: '当前重点：' + groupTitle(text, e.parent), cls: 'hc-group-label' });
    }
    if (this.mode === 'keywords') {
      const custom = this.contentEl.createDiv({ cls: 'hc-custom-keyword' });
      const label = custom.createEl('label', { text: '自定义关键词' });
      const input = label.createEl('input', { type: 'text', placeholder: '输入关键词，按回车添加' });
      input.value = this.keywordDraft;
      const add = custom.createEl('button', { text: '添加关键词' });
      const refresh = () => { add.disabled = this.addingKeyword || !input.value.trim(); };
      input.oninput = () => { this.keywordDraft = input.value; refresh(); };
      add.onclick = () => {
        if (this.addingKeyword || this.busy || !input.value.trim()) return;
        const value = input.value, chapter = this.chapter;
        this.addingKeyword = true; input.disabled = true; refresh();
        this.plugin.run(async () => {
          try {
            await finishPending(this.plugin.state, this.plugin.io);
            let created: ReturnType<typeof addCustomEntry> | undefined;
            await this.plugin.change(this.binding.target, current => {
              created = addCustomEntry(current, chapter, value); return created.note;
            });
            this.chapter = created!.entry.chapter;
            this.selected.add(created!.entry.id); this.keywordDraft = '';
            this.addingKeyword = false;
            await this.render();
            this.contentEl.querySelector<HTMLInputElement>('.hc-custom-keyword input')?.focus();
            new Notice('关键词已添加并勾选。');
          } finally { this.addingKeyword = false; input.disabled = false; refresh(); }
        });
      };
      input.onkeydown = event => {
        if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); add.click(); }
      };
      custom.createEl('small', { text: '添加到当前章节，可和其他关键词一起归入重点、生成导图。', cls: 'hc-subtitle' });
      refresh();
    }
    const footer = this.contentEl.createDiv({ cls: 'hc-merge-footer' });
    count = footer.createEl('p', { cls: 'hc-selection', text: `已勾选 ${this.selected.size} 个关键词` });
    count.setAttribute('role', 'status'); count.setAttribute('aria-live', 'polite');
    const batch = footer.createDiv({ cls: 'hc-batch-actions' });
    next = batch.createEl('button', { text: '创建重点…', cls: this.mode === 'remove' ? 'mod-warning' : 'mod-cta' });
    next.disabled = this.selected.size === 0;
    next.onclick = () => {
      if (this.mode === 'remove') {
        const ids = [...this.selected];
        new ConfirmActionModal(this.app, '移除这些收录？', `将移除 ${ids.length} 条收录及条目内的手写说明，并取消关联的原文高亮。自定义关键词不影响原文；原文文字保留，已有导图不变。`, '确认移除', () => this.plugin.run(async () => {
          await this.plugin.undoEntries(this.binding, ids); this.selected.clear(); await this.render();
        })).open();
      } else { this.step = 'name'; void this.render(); }
    };
    if (this.mode !== 'remove') {
      const join = batch.createEl('button', { text: '加入已有重点…' }); batchControls.push(join);
      join.onclick = () => {
        const groups = parsed.groups.filter(g => g.meta.chapter === this.chapter);
        if (!groups.length) { new Notice('本章还没有重点，请先创建重点。'); return; }
        new GroupDestinationModal(this.app, groups.map(g => ({ id: g.id, title: groupTitle(text, g) })), id => {
          const ids = [...this.selected]; this.plugin.run(() => this.updateNote(current => arrange(current, ids, { type: 'add', group: id })));
        }).open();
      };
      const detach = batch.createEl('button', { text: '移出重点' }); batchControls.push(detach);
      detach.onclick = () => { const ids = [...this.selected]; this.plugin.run(() => this.updateNote(current => arrange(current, ids, { type: 'remove' }))); };
    }
    hint = footer.createEl('small');
    refreshSelection();
    const done = this.contentEl.createEl('button', { text: '完成', cls: 'hc-close' }); done.onclick = () => this.close();
  }
  renderName(text: string, parsed: ReturnType<typeof parseDocument>, picked: ReturnType<typeof parseDocument>['entries']) {
    if (!picked.length || new Set(picked.map(e => e.meta.chapter)).size !== 1) { this.step = 'select'; void this.render(); return; }
    this.contentEl.createEl('p', { cls: 'hc-subtitle', text: '第 2 步：确认关键词并给这个重点命名。' });
    const summary = this.contentEl.createDiv({ cls: 'hc-picked-keywords' });
    for (const entry of picked) summary.createEl('span', { text: entryText(text, entry) });
    let merge: HTMLButtonElement;
    new Setting(this.contentEl).setName('重点名称').setDesc('名称会显示在重点笔记和新生成的思维导图中。').addText(input => {
      input.setPlaceholder('例如：细胞的基本结构').setValue(this.title).onChange(value => { this.title = value; if (merge) merge.disabled = !value.trim(); });
      input.inputEl.setAttribute('enterkeyhint', 'done');
    });
    const actions = this.contentEl.createDiv({ cls: 'hc-name-actions' });
    const back = actions.createEl('button', { text: '返回修改选择' });
    merge = actions.createEl('button', { text: picked.length === 1 ? '创建命名重点' : `合并 ${picked.length} 个关键词`, cls: 'mod-cta' });
    merge.disabled = !this.title.trim();
    back.onclick = () => { this.step = 'select'; void this.render(); };
    merge.onclick = () => {
      const ids = picked.map(e => e.id), title = this.title;
      this.plugin.run(() => this.updateNote(current => {
        const latest = parseDocument(current);
        if (ids.some(id => !latest.entries.some(e => e.id === id))) throw new Error('部分关键词已被删除，请重新选择。');
        return arrange(current, ids, { type: 'create', title });
      }, ids.length === 1 ? `已创建重点「${title.trim()}」。` : `已将 ${ids.length} 个关键词合并为重点「${title.trim()}」。`));
    };
  }
  renderGroups(text: string, parsed: ReturnType<typeof parseDocument>) {
    const groups = parsed.groups.filter(g => g.meta.chapter === this.chapter);
    if (!groups.length) this.contentEl.createEl('p', { text: '本章还没有命名重点。可以先在“关键词归组”中创建，或回到笔记新增手写重点。', cls: 'hc-empty' });
    for (const group of groups) {
      const card = this.contentEl.createEl('details', { cls: 'hc-group-card' });
      card.createEl('summary', { text: groupTitle(text, group) });
      card.createEl('p', { cls: 'hc-subtitle', text: group.children.length ? `包含 ${group.children.length} 个关键词` : '手写重点' });
      let title = group.meta.title;
      const types = new Set(group.meta.examTypes ?? []);
      new Setting(card).setName('名称').addText(input => input.setValue(title).onChange(value => title = value));
      const choices = card.createEl('fieldset', { cls: 'hc-type-options' }); choices.createEl('legend', { text: '题型 · 可多选' });
      for (const type of examTypes) {
        const label = choices.createEl('label');
        const box = label.createEl('input', { type: 'checkbox' }); box.checked = types.has(type); label.createSpan({ text: type });
        box.onchange = () => { if (box.checked) types.add(type); else types.delete(type); };
      }
      const actions = card.createDiv({ cls: 'hc-batch-actions' });
      actions.createEl('button', { text: '保存修改', cls: 'mod-cta' }).onclick = () => {
        const values = { title, types: [...types] };
        this.plugin.run(() => this.updateNote(current => setExamTypes(renameGroup(current, group.id, values.title), group.id, values.types)));
      };
      actions.createEl('button', { text: '解散重点…', cls: 'hc-secondary-action' }).onclick = () => {
        new ConfirmActionModal(this.app, '解散这个重点？', '保留关键词、原标题和手写说明，取消它们的重点归类。', '解散重点', () => this.plugin.run(() => this.updateNote(current => dissolveGroup(current, group.id)))).open();
      };
    }
  }
  onClose() { this.alive = false; this.contentEl.empty(); }
}
class Settings extends PluginSettingTab {
  constructor(app: App, private plugin: HighlightCompanion) { super(app, plugin); }
  display() {
    this.containerEl.empty(); this.containerEl.createEl('h2', { text: '重点收录' });
    this.containerEl.addClass('hc-settings');
    new Setting(this.containerEl).setName('默认收录文件夹').setDesc('首次绑定时建议的位置；已有绑定不受影响。').addText(t => t.setValue(this.plugin.state.folder).onChange(value => this.plugin.run(async () => { this.plugin.state.folder = value.trim() || '重点笔记'; await this.plugin.io.save(); })));
    this.containerEl.createEl('p', { text: Platform.isMobileApp
      ? '在“设置 → 移动端 → 管理工具栏 → 添加全局命令”中添加“高亮并收录”和“收录与整理面板”。选中文字后点击工具栏图标即可收录。导图增补前请先返回重点笔记。'
      : '在“快捷键”中搜索“重点收录”，为“高亮并收录”设置顺手的快捷键。导图增补前请先关闭该 Canvas 标签页。' });
    for (const b of this.plugin.state.bindings) new Setting(this.containerEl).setName(b.source).setDesc(b.target).addButton(button => button.setButtonText('打开重点笔记').onClick(() => this.plugin.run(() => this.plugin.open(b.target))));
  }
}
