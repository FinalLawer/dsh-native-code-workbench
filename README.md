# DSH Code Workbench

## 工作台布局

左侧图标栏切换文件、搜索和历史视图，再次点击当前视图可收起导航。文件树顶部提供新建文件、新建文件夹、刷新和全部折叠。编辑区显示多文件标签和当前文件的路径面包屑，配色与控件跟随 DSH 主题。

每个打开的文件保留独立编辑内容、撤销记录和光标/滚动位置，切换标签不丢失未保存修改。标签上的圆点表示未保存；关闭时可确认放弃或取消后保存。开启自动保存后，切换文件也会保存原文件。重命名、移动或删除前必须先保存受影响的打开文件；标签随后同步更新。刷新文件树会重新加载已展开目录。

## 文件树右键菜单

右键点击文件、目录或文件树空白处，可以新建文件和文件夹、在资源管理器中显示、添加路径引用到当前对话、剪切/复制/粘贴、复制路径、重命名及删除。新建和重命名使用工作台内的名称弹窗，删除使用确认弹窗。剪切和复制后，在目标文件夹右键选择粘贴；复制遇到同名文件会自动生成副本名称。目录引用会提示 Agent 按需读取路径。文件操作要求会话允许工作区写入，禁止覆盖已有目标和修改工作区外路径；删除需要确认且不能撤销。

已移除「打开工作区终端」和「在文件夹中查找」。菜单不包含运行测试、调试测试、运行覆盖率测试，目前未加入「添加到新对话」。

## 独立补全 API

在 DSH 设置的「代码工作台」中开启「使用独立补全 API」，填写 API Base URL（例如 `https://api.example.com/v1`）、模型 ID 和 API Key，然后点击「保存补全模型」。独立 API 仅用于 Tab 补全；独立接口支持 OpenAI 兼容的 `/chat/completions` SSE 流式接口，也支持填写完整端点地址；本地免鉴权服务可以不填密钥。

API Key 通过 Host 设置服务保存，标记为秘密字段，设置页不会回显。密钥输入框留空保留原密钥，勾选「清除已保存的 API Key」并保存可删除密钥。关闭独立 API 后，使用已配置的 DSH Provider / Model，两项留空则跟随 Agent。当前独立接口不支持 FIM、Anthropic Messages 或厂商特有参数。

给 DSH Web GUI 的右侧栏加一个 **VS Code 风格的代码工作台**：用 **Monaco（VS Code 编辑器内核本体）** 浏览和编辑工作区文件——语法高亮、多光标、查找、撤销，全部与 VS Code 同款。

**设计原则：只组合官方机制，不自建平行协议。** 写盘走官方 Connection 通道 + `ctx.fs`，读盘走官方 `workspaceFiles` Remote。

---

## 当前能力：编辑器 / 检索 / Tab 补全 / 检查点 / 加到对话

| 能力 | 实现 | 机制 |
|---|---|---|
| 编辑器 | **Monaco 内联**（约 5.12 MiB bundle，懒加载） | `monaco-editor` 打进 bundle（浏览器模块表冻结，无 Monaco，必须内联） |
| Worker | Blob URL 内嵌 `editor.worker` | `self.MonacoEnvironment.getWorker`，无 CSP 拦截 |
| 文件树 | 递归、懒展开 | `ctx.remote.workspaceFiles.list`（官方只读 Remote） |
| 读文件 | 分页读全量、按扩展名选语言 | `ctx.remote.workspaceFiles.read`（按行分页，`eof` 收尾） |
| **写文件** | `POST /api/code-workbench/write`，**版本守卫**（`FS_STALE_VERSION` 拒绝覆盖并发修改），沙箱策略 = 会话标准策略 | host 半体 `ctx.connection.fetch.register`（与官方 `/api/file` 同一通道）→ `ctx.fs.writeText(target, text, intent, signal, sandboxPolicy)` |
| **代码库检索** | 左栏「搜索」模式：正则/大小写搜索、结果列表、点击跳转到行并高亮 | `POST /api/code-workbench/search`：`ctx.fs` 有界遍历（忽略 `node_modules`/二进制扩展）+ 行匹配，文件数/匹配数/时间三重预算 |
| **@codebase（Agent 工具）** | 对话里的 Agent 自带 `codebase_search` 工具：自然语言多词**排序检索**，返回 top 片段（补官方 `grep` 的精确正则） | `ctx.tools.register`（官方 Tool Runtime）+ 同一检索核心（terms 模式 + 词覆盖率排序） |
| **Tab 补全** | 打字停顿后灰色 ghost 建议，**Tab 接受**、继续打字即取消；同一时刻最多一个请求 | Monaco `registerInlineCompletionsProvider`（ghost 渲染/接受全是内建）+ `POST /api/code-workbench/complete`（光标前后文 JSON 帧，128 token 小预算） |
| **检查点 / 回滚** | 每次保存自动入账本；左栏「历史」列出检查点，**一键回滚**到任意保存之前；回滚本身也是检查点，可再回滚 | `POST /api/code-workbench/history` / `rollback`（host 内存账本，每文件 20 条、每侧 200KB 上限）+ `ctx.fs.writeText` 版本守卫 |
| **外部改动自动重载** | Agent/外部改了盘上文件 → 干净缓冲区**自动刷新**；有未保存修改时警告不覆盖 | 官方 `workspaceFiles.changes` 流（`ctx.remote.$stream`），按打开文件订阅 |
| **加到对话（Add to Chat）** | 右栏**选中多行代码** → `Ctrl+L`/按钮 → 主对话输入框里出现**引用胶囊**（只显示 `文件:行号 · N 行`），**发送时才展开**成完整代码块给 Agent | 官方 chip 机制：`slash/input-insert-reference` 事件插 `ReferenceChipNode` + 自注册 reference codec（`inputTriggers.registerSource` 的 `codec.serialize` 做提交展开） |
| 可追溯 | 每次保存记 Session 备注 | `sessionFeedback.record` |
| 主题 | 跟随 DSH 明暗主题 | `body[data-ds-dark-theme]` MutationObserver → `monaco.editor.setTheme` |
| 快捷键 | `Ctrl+S` 保存、`Ctrl+L` 将选中代码加入对话、`Tab` 接受补全（编辑器内） | `editor.addCommand` |

## 组成

| 半体 | 文件 | 职责 |
|---|---|---|
| Host | [`index.js`](dsh-code-workbench/index.js) | 版本守卫写盘、文件操作、检索、Tab 补全、检查点与回滚，以及 `codebase_search` 工具 |
| Client 源码 | [`src/client.mjs`](dsh-code-workbench/src/client.mjs) | 右栏 tab `code-workbench`：文件树 + Monaco + Tab 补全 + 代码引用 |
| 构建 | [`build.mjs`](dsh-code-workbench/build.mjs) | esbuild：Monaco/Worker/CSS 全部内联，产出 `client.js`（`__ModuleLoader__` factory 形式） |

## 开发

配置位于 DSH 官方设置页中的「代码工作台」设置项：可配置编辑自动保存（默认关闭，停顿 900ms 后保存）及专用补全 Provider / Model。模型填写 DSH 已配置的标识，两项留空跟随 Agent；配置由 DSH 持久化。首次更新 Host schema 和客户端依赖后需要重启 DSH。

```powershell
node dsh-code-workbench/build.mjs        # 重新构建 client.js（Monaco 内联）
node tools/test-client-contract.mjs   # 客户端契约（bundle 资产/导出/注册/注入）
node tools/test-host-write.mjs        # 写盘路由（沙箱策略戳/版本守卫/鉴权）
node tools/test-file-operations.mjs   # 文件操作（权限/范围/禁止覆盖）
node tools/test-host-search.mjs       # 检索路由（有界遍历/忽略规则/正则/上限）
node tools/test-host-tool.mjs         # codebase_search 工具（注册契约/排序/上限）
node tools/test-host-complete.mjs     # Tab 补全路由（前后文帧/小 token 预算）
node tools/test-completion-api.mjs    # 独立补全 API（SSE/配置/密钥）
node tools/test-host-history.mjs      # 检查点账本（入账/回滚/可回滚性）
node tools/test-bundle-slim.mjs       # bundle 瘦身（体积门槛/该有的在/该删的不在）
node tools/test-client-smoke.mjs      # 客户端渲染冒烟（真实 React 渲染 + 驱动交互链路）
node tools/analyze-bundle.mjs         # bundle 体积归因（哪个模块最胖）

# 改 client.js 不需要重启：HMR 按文件元数据（mtime/ctime/size）算修订号，重写即重载
# 改 index.js（host 半体）需要重启 DSH：桌面 boot 图是启动快照
```

**构建管线**：`src/*.mjs` → esbuild(CJS, `react` external) → 包一层
`window.__ModuleLoader__.load({ id, factory(require) { … } })`；Monaco 的 CSS/字体
转成注入 `<style>`，`editor.worker` 转成 Blob URL。factory 只 `require('react')`
（冻结模块表），其余全部内联——这是 bundle 契约。

**依赖安装**：本机 npm 需走系统代理（`$env:HTTPS_PROXY='http://127.0.0.1:7897'`），否则被 DNS 劫持。

## 已知限制

- 文件同步使用官方 changes 流，并每 1.5 秒检查打开文件版本、窗口重新聚焦时检查；干净缓冲区自动重读，未保存修改保留。
- 新发送的代码引用在聊天记录中默认折叠为文件与行号，点击展开；模型仍收到完整选区。此前发送的普通代码块没有引用标记，保留原展示。
- Tab 补全采用 300ms 请求防抖、较小的前后文和 128 token 预算，并缓存最近 40 个光标上下文；目标是更快显示首个 ghost text。

- AI Tab 补全尚未完成桌面端验收；路由及客户端 provider 测试通过不代表实际建议渲染和 Tab 接受已验证。状态栏显示生成中、返回建议、空结果及失败原因，便于实测定位。
- 工作台使用 DSH 官方主题变量；导航可收起，窄面板改为上下布局，顶部文件路径与操作分行显示。

- bundle 5.12 MiB（Monaco 内核 minify 后 + 常用 28 种语法 + JSON 语言服务）；首次打开面板时解析（懒加载）。
- TS/JS 语义智能未启用（砍掉了 12MB 的 TS 语言服务）：TS/JS 有语法高亮 + 编辑器全套功能，但没有语义诊断/跳转；补全为词级 + AI ghost text。
- 单文件读取受官方 `workspaceFiles` 上限约束（默认 2 MiB / 5000 行一页，最多 40 页）。
- 检查点账本在 host 内存（每文件 20 条）：重启 DSH 后清零。
- 「语义检索」为词覆盖率排序的词汇检索（DeepSeek API 无 embeddings 端点，无法做向量语义）。
