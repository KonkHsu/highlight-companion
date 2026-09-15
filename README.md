# 重点收录 · Highlight Companion

支持电脑、手机和平板的 Obsidian Markdown 课本学习插件。选中文字即可高亮并持续收录，保留章节与双向来源链接；同章节关键词可以归为一个重点，再生成可手动编辑的 Canvas 思维导图。

## 开始使用

1. 在课本的编辑视图选中一个关键词或句段，右键选择 **高亮并收录**。也可在命令面板中执行同名命令。
2. 首次选择保存路径，默认 `重点笔记/课本名-重点.md`。若使用已有笔记，明确选择「使用已有笔记」；插件会追加收录区。
3. 以后操作自动沿用绑定，并追加到对应章节末尾。可使用 **收录当前课本已有高亮** 批量收录原生 `==高亮==`。
4. 原文中的 **重点** 链接跳到条目；条目中的 **返回原文** 跳到来源段落。在编辑视图中按住 Cmd（Windows 为 Ctrl）点击链接，或切换阅读视图直接点击。
5. 在重点笔记阅读视图点击 **整理重点**，勾选同章节的关键词、填写名称、点击 **归为新重点**。也可以加入已有重点、移出、重命名或解散。
6. 点击 **生成 / 增补导图**。生成的 `.canvas` 可直接改字、拖动卡片、修改连线。

在 Obsidian 的「设置 → 快捷键」搜索「重点收录」，给 **高亮并收录** 分配快捷键。插件不占用默认快捷键。

## 手机和平板（0.2.0）

1. 把发布包里的 `highlight-companion` 文件夹放入手机仓库的 `.obsidian/plugins/`，或使用你现有的仓库同步方式同步插件。文件夹中需有 `main.js`、`manifest.json`、`styles.css`。在该设备的社区插件设置中启用「重点收录」。本插件尚未发布到社区插件市场。
2. 在 Obsidian 的 **设置 → 移动端 → 管理工具栏选项** 中添加全局命令 **重点收录：高亮并收录** 和 **重点收录：收录与整理面板**。不同语言或版本的设置名称可能略有不同。
3. 在课本编辑视图长按选中文字，点击工具栏的高亮命令；也可打开收录面板，核对选词预览后点击 **高亮并收录所选文字**。首次绑定时选区会保留。
4. 在重点笔记阅读视图点击 **整理重点**。可先按章节筛选，再勾选关键词分组。弹窗支持纵向滚动、较大的触控按钮和明确的完成入口。
5. 使用 **生成 / 增补导图**；返回重点笔记再增补，让 Canvas 手动编辑先保存。收录面板也能从已绑定的导图打开重点笔记。

更新插件时替换上述三个运行文件，保留已有 `data.json`。绑定和笔记格式兼容 0.1.0。同步到其他设备时应包含笔记、Canvas 和插件数据；本版不提供多设备同时修改同一笔记的冲突合并，请等待同步完成再切换设备继续操作。

已在桌面 Obsidian 的官方移动端模拟模式中检查 320px 和约 451px 窄屏、分组及首次收录流程。尚未在真实 iOS / Android 设备上验收系统键盘、长按选区和文件同步。

## 追加、编辑与导图规则

- 每本课本绑定一篇重点笔记，目标笔记不能同时被另一课本占用。
- 单次选择限于一个正文段落或列表项。标题、引用块、代码、图片和链接不作为首版高亮来源。
- 章节来自 Markdown 标题，保留父级路径；重名章节通过来源标识区分。首个标题前的内容归入「未分章节」。
- 同一处高亮重复执行会跳过；不同出处的相同词各自保留。收录是快照，修改或取消原文高亮不会删除已收录内容。
- 普通 Markdown 笔记可以手动编辑。请把条目的补充说明写在该条目内容后、其结束标识前；实时阅览隐藏内部标识，源码模式可查看完整标识。请勿删除 `hc` 注释或 `^hc-...` 定位标识。
- 分组只允许同一个最近级标题下的关键词，每条同时属于一个重点。解散分组会保留旧标题和手写说明，避免丢失内容。
- 导图首次按课本、章节、重点、关键词生成树状布局。**增补前先关闭对应 Canvas 标签页，或返回重点笔记**，让手动编辑完成保存。
- 增补只加入尚未导出的内容，放在已有卡片下方的空白区域。已有文字、位置和连线保持原样；删除过的卡片不会被自动恢复。
- 已导出的关键词重新分组或改名后，旧导图不会自动重排。使用 **另存完整思维导图** 生成当前结构的新版本；此后增补面向这个最新版本。
- 使用 Obsidian 自带文件改名或移动操作会维护绑定和生成链接。如果改名时导图仍打开，请返回重点笔记后增补，以更新导图中的旧链接。

## 异常恢复

- 每次跨文件收录先保存待完成记录，再修改原文并追加重点笔记。中断后执行 **恢复未完成收录并检查绑定**，或重新启用插件；已写入的条目不会重复追加。
- 目标文件缺失时不会静默新建；恢复文件，或执行 **绑定重点笔记** 选择包含原收录标识的笔记。
- 标识损坏、条目整段被手动删除或原文在未完成操作期间发生无法匹配的变化时，插件停止对应写入并提示。可使用 Obsidian 的「文件恢复」还原，再重试。
- `data.json` 保存绑定、区域索引、未完成记录及导图导出映射。普通重点 Markdown 还保存恢复标识；Canvas 同时保存导出映射。开发与备份时请保留它们。

## GitHub Release 与 BRAT 安装

GitHub 仓库：[KonkHsu/highlight-companion](https://github.com/KonkHsu/highlight-companion)。在 BRAT 的添加测试插件入口填入 `KonkHsu/highlight-companion`，选择 0.2.0 测试版并安装；也可从 [Releases](https://github.com/KonkHsu/highlight-companion/releases) 手动下载运行文件。

仓库根目录应是本插件目录，包含 `manifest.json`、`README.md`、`LICENSE`、源码与构建配置。不要上传整个开发 Vault 或 `data.json`。

发布前运行 `npm ci` 和 `npm run release:check`。检查通过后，`release/0.2.0/` 中提供运行文件、说明与 SHA-256 校验值。GitHub Release tag 使用 **0.2.0**，与 manifest 完全一致。将 **main.js、manifest.json、styles.css 分别作为 Release 附件上传**；仅上传 ZIP 不能代替 BRAT 所需的独立附件。当前移动端仍需真实设备测试，可先用于测试发布。

版本升级后应同步更新 `package.json`、锁文件、`manifest.json` 和 `versions.json`。依赖升级时还需更新 `THIRD_PARTY_NOTICES.md`；发布检查会核对实际打包依赖与声明版本。

依据：[Obsidian 发布要求](https://docs.obsidian.md/plugins/releasing/submit-plugin)、[BRAT 开发者说明](https://github.com/TfTHacker/obsidian42-brat/blob/main/BRAT-DEVELOPER-GUIDE.md)。

## 许可

本项目采用 [MIT License](LICENSE)。打包依赖的许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)，构建产物也内嵌这些声明。

## 开发

工作目录是本文件所在的 `.obsidian/plugins/highlight-companion/`。

```sh
npm ci
npm test
npm run build
# 开发时监听构建
npm run dev
```

构建生成 `main.js`；运行所需文件为 `manifest.json`、`main.js`、`styles.css`。源码按收录解析、Markdown 区域操作、跨文件恢复、Canvas 导出和 Obsidian 界面分层。生成文件采用 Obsidian 原生格式；不调用网络、不包含 AI 服务，不依赖其他社区插件。

本版声明电脑和移动端兼容，最低版本为 Obsidian 1.7.2；开发验收使用 macOS 的 Obsidian 1.13.7 及其移动端模拟模式。PDF 不在本版范围。

## 参考

- [Obsidian 官方插件示例](https://github.com/obsidianmd/obsidian-sample-plugin)
- [官方插件开发指南](https://docs.obsidian.md/Plugins/Getting%20started/Build%20a%20plugin)
- [JSON Canvas 1.0](https://jsoncanvas.org/spec/1.0/)

- [官方移动端插件开发说明](https://docs.obsidian.md/Plugins/Getting%20started/Mobile%20development)
- [Obsidian 移动端工具栏说明](https://obsidian.md/help/mobile)
