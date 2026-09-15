import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder, normalizePath, MarkdownRenderChild, Platform } from 'obsidian';
import { Binding, State, emptyState, uid, SerialQueue } from './model';
import { capture } from './source';
import { newDocument, parseDocument, appendEntries, arrange, renameGroup, dissolveGroup, entryText, groupTitle, rewriteBinding, rewriteLinks } from './document';
import { buildCanvas, CanvasLedger } from './canvas';
import { commitCapture, finishPending, Storage } from './engine';
import { hideInternalMarkers } from './editor';
import { snapshotSelection, selectionPreview, SelectionSnapshot } from './selection';
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
    this.addCommand({ id: 'capture-panel', name: '收录与整理面板', icon: 'panel-bottom', callback: () => this.showPanel() });
    this.addCommand({ id: 'import-highlights', name: '收录当前课本已有高亮', icon: 'list-plus', callback: () => this.run(() => this.importActive()) });
    this.addCommand({ id: 'open-note', name: '打开重点笔记', icon: 'notebook-pen', callback: () => this.run(async () => { const b = await this.contextBinding(); await this.open(b.target); }) });
    this.addCommand({ id: 'organize', name: '整理重点', icon: 'list-tree', callback: () => this.run(async () => { const b = await this.contextBinding(); new OrganizeModal(this.app, this, b).open(); }) });
    this.addCommand({ id: 'canvas-update', name: '生成或增补思维导图', icon: 'git-fork', callback: () => this.run(async () => this.exportCanvas(await this.contextBinding(), false)) });
    this.addCommand({ id: 'canvas-new', name: '另存完整思维导图', icon: 'copy-plus', callback: () => this.run(async () => this.exportCanvas(await this.contextBinding(), true)) });
    this.addCommand({ id: 'recover', name: '恢复未完成收录并检查绑定', icon: 'refresh-cw', callback: () => this.run(async () => { await finishPending(this.state, this.io); await this.reconcile(true); new Notice('恢复与检查完成。'); }) });
    this.addRibbonIcon('highlighter', '重点收录：收录与整理', () => this.showPanel());
    this.registerEvent(this.app.workspace.on('editor-menu', (menu, editor, view) => {
      if (!view.file || view.file.extension !== 'md') return;
      const file = view.file;
      menu.addItem(i => i.setTitle('高亮并收录').setIcon('highlighter').onClick(() => this.collect(file, editor)));
      menu.addItem(i => i.setTitle('整理重点').setIcon('list-tree').onClick(() => this.run(async () => new OrganizeModal(this.app, this, await this.contextBinding()).open())));
    }));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      if (file instanceof TFile || file instanceof TFolder) this.run(() => this.renamed(oldPath, file.path));
    }));
    this.registerEvent(this.app.workspace.on('layout-change', () => this.run(() => this.refreshCanvasLinks())));
    this.registerMarkdownPostProcessor((element, context) => {
      const b = this.state.bindings.find(b => b.target === context.sourcePath);
      if (!b) return;
      // Only the document title section gets a toolbar, not every rendered paragraph.
      const info = context.getSectionInfo(element);
      if (info?.lineStart !== 0 && !element.querySelector('h1')) return;
      const toolbar = element.createDiv({ cls: 'hc-toolbar' });
      const child = new MarkdownRenderChild(toolbar); context.addChild(child);
      const add = (name: string, fn: () => void) => { const button = toolbar.createEl('button', { text: name }); child.registerDomEvent(button, 'click', fn); };
      add('整理重点', () => new OrganizeModal(this.app, this, b).open());
      add('生成 / 增补导图', () => this.run(() => this.exportCanvas(b, false)));
      add('另存完整导图', () => this.run(() => this.exportCanvas(b, true)));
    });
    this.app.workspace.onLayoutReady(() => this.run(async () => { await this.reconcile(); await finishPending(this.state, this.io); }));
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
    if (expected.some(id => !parsed.regions.some(r => r.id === id))) throw new Error('收录区域被手动删除，已停止自动修改。请恢复原区域，避免丢失整理内容。');
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
  async exportCanvas(binding: Binding, fresh: boolean) {
    const note = await this.read(binding.target);
    this.validateIndex(note, binding);
    let path = binding.canvas;
    if (!path || fresh) {
      const base = binding.target.replace(/\.md$/, '') + '-思维导图'; path = base + '.canvas';
      let suffix = 2; while (this.app.vault.getAbstractFileByPath(path)) path = `${base}-${suffix++}.canvas`;
      const generated = buildCanvas(note, binding);
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
      this.state.canvasLedgers ??= {}; this.state.canvasLedgers[path] = ledger!; await this.io.save();
    }
    await this.open(path); new Notice(fresh ? '已另存完整导图。' : '导图已生成或增补，已有卡片编辑保持不变。');
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
    this.contentEl.createEl('p', { cls: 'hc-capture-preview', text: preview || '在课本编辑视图长按并选择文字，再使用“高亮并收录”。' });
    const actions = this.contentEl.createDiv({ cls: 'hc-panel-actions' });
    const add = (label: string, action: () => Promise<unknown>, enabled = true, primary = false) => {
      const button = actions.createEl('button', { text: label, cls: primary ? 'mod-cta' : '' });
      button.disabled = !enabled;
      button.onclick = () => {
        if (this.submitted) return;
        this.submitted = true; this.close(); this.plugin.run(action);
      };
    };
    add('高亮并收录所选文字', () => this.plugin.collectSnapshot(this.file, this.capturedSelection!), !!preview, true);
    add('收录已有高亮', () => this.plugin.importActive(this.file), isSource);
    add('打开重点笔记', async () => this.plugin.open((await this.plugin.contextBinding(this.file)).target));
    add('整理关键词', async () => new OrganizeModal(this.app, this.plugin, await this.plugin.contextBinding(this.file)).open());
    add('生成 / 增补导图', async () => this.plugin.exportCanvas(await this.plugin.contextBinding(this.file), false));
    this.contentEl.createEl('p', { cls: 'hc-subtitle', text: '手机上可在“设置 → 移动端 → 管理工具栏”添加“高亮并收录”，选中文字后直接点击工具栏图标。' });
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

export class OrganizeModal extends Modal {
  selected = new Set<string>(); title = ''; group = ''; chapter = ''; alive = true; busy = false;
  constructor(app: App, private plugin: HighlightCompanion, private binding: Binding) { super(app); }
  onOpen() { this.modalEl.addClass('hc-organizer', 'hc-responsive-modal'); this.setTitle('整理重点'); void this.render().catch(e => new Notice(e.message)); }
  async render() {
    const text = await this.plugin.read(this.binding.target), parsed = parseDocument(text);
    if (!this.alive) return;
    this.contentEl.empty();
    this.contentEl.createEl('p', { cls: 'hc-subtitle', text: '多选同章节关键词，归为一个重点。补充说明可直接在重点笔记中编辑。' });
    new Setting(this.contentEl).setName('章节筛选').addDropdown(d => {
      d.addOption('', '全部章节');
      for (const c of parsed.chapters.filter(c => parsed.entries.some(e => e.meta.chapter === c.id))) {
        const label = [...c.meta.parents.map(id => parsed.chapters.find(x => x.id === id)?.meta.title ?? ''), c.meta.title].join(' / ');
        d.addOption(c.id, label);
      }
      d.setValue(this.chapter).onChange(v => { this.chapter = v; this.selected.clear(); void this.render().catch(e => new Notice(e.message)); });
    });
    new Setting(this.contentEl).setName('重点名称').addText(t => t.setPlaceholder('例如：细胞膜的结构特点').setValue(this.title).onChange(v => this.title = v));
    new Setting(this.contentEl).setName('已有重点').addDropdown(d => {
      d.addOption('', '选择要编辑的重点…');
      for (const g of parsed.groups) { const c = parsed.chapters.find(c => c.id === g.meta.chapter)!; d.addOption(g.id, `${c.meta.title} / ${groupTitle(text, g)}`); }
      d.setValue(this.group).onChange(v => this.group = v);
    });
    const controls = this.contentEl.createDiv({ cls: 'hc-actions' });
    const button = (title: string, fn: (value: string, ids: string[], name: string, group: string) => string, primary = false) => {
      const b = controls.createEl('button', { text: title, cls: primary ? 'mod-cta' : '' });
      b.onclick = () => {
        if (this.busy) return;
        this.busy = true;
        const ids = [...this.selected], name = this.title, group = this.group;
        controls.querySelectorAll('button').forEach(b => b.disabled = true);
        this.plugin.run(async () => {
          try {
          await this.plugin.change(this.binding.target, current => {
            // Preserve concurrent handwritten edits; region operations always use latest content.
            const latest = parseDocument(current);
            if (ids.some(id => !latest.entries.some(e => e.id === id))) throw new Error('部分关键词已被删除，请重新打开整理窗口。');
            return fn(current, ids, name, group);
          });
          this.selected.clear(); await this.render(); new Notice('重点已更新。');
          } finally { this.busy = false; controls.querySelectorAll('button').forEach(b => b.disabled = false); }
        });
      };
    };
    button('归为新重点', (t, ids, title) => arrange(t, ids, { type: 'create', title }), true);
    button('加入已有重点', (t, ids, _title, group) => arrange(t, ids, { type: 'add', group }));
    button('移出重点', (t, ids) => arrange(t, ids, { type: 'remove' }));
    button('重命名重点', (t, _ids, title, group) => renameGroup(t, group, title));
    button('解散重点', (t, _ids, _title, group) => dissolveGroup(t, group));
    const count = this.contentEl.createEl('p', { cls: 'hc-selection', text: `已选择 ${this.selected.size} 个关键词` });
    count.setAttribute('role', 'status'); count.setAttribute('aria-live', 'polite');
    if (!parsed.entries.length) this.contentEl.createEl('p', { text: '还没有收录内容。请回到课本选择文字，使用“高亮并收录”。' });
    for (const c of parsed.chapters) {
      if (this.chapter && c.id !== this.chapter || !parsed.entries.some(e => e.meta.chapter === c.id)) continue;
      const section = this.contentEl.createDiv({ cls: 'hc-chapter' });
      const path = [...c.meta.parents.map(id => parsed.chapters.find(x => x.id === id)?.meta.title ?? ''), c.meta.title].join(' / ');
      section.createEl('h3', { text: path });
      for (const e of parsed.entries.filter(e => e.meta.chapter === c.id)) {
        const row = section.createEl('label', { cls: 'hc-row' });
        const checkbox = row.createEl('input', { type: 'checkbox' }); checkbox.checked = this.selected.has(e.id);
        checkbox.onchange = () => { if (checkbox.checked) this.selected.add(e.id); else this.selected.delete(e.id); count.setText(`已选择 ${this.selected.size} 个关键词`); };
        const copy = row.createDiv(); copy.createEl('span', { text: entryText(text, e) });
        if (e.parent?.kind === 'group') copy.createEl('small', { text: '重点：' + groupTitle(text, e.parent), cls: 'hc-group-label' });
      }
    }
    const done = this.contentEl.createEl('button', { text: '完成', cls: 'hc-close' }); done.onclick = () => this.close();
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
