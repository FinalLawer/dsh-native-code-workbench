# DSH Code Workbench

## 安装

推荐直接用 GitHub 链接安装，不必先下载压缩包。在 DSH 侧边栏的**插件**页点**添加插件**，粘贴：

```
https://github.com/FinalLawer/dsh-native-code-workbench#path:/dsh-code-workbench
```

装完点**立即启用**；已安装但没启用的组合包，之后也能在插件页开启。

⚠️ **`#path:/dsh-code-workbench` 这一段不能省。** 这个仓库的根目录不是包——插件在 `dsh-code-workbench/` 子目录里，根目录没有 `package.json`。省略它时 pnpm 仍会报告安装成功，但装出来的是一个名为 `dsh-native-code-workbench.git`、版本 `0.0.0` 的占位包（清单是 pnpm 生成的 `{"_pnpmPlaceholder": …}`），既没有包清单也没有 `dsh.bundle` 声明，DSH 读不到组合包，插件不会出现。这个失败发生在安装**之后**，光看安装过程看不出来。

固定版本请把 tag 一起带上：

```
https://github.com/FinalLawer/dsh-native-code-workbench#v0.5.1&path:/dsh-code-workbench
```

命令行等价写法（需先完全退出 DSH）：

```
dsh plugin --profile desktop add "https://github.com/FinalLawer/dsh-native-code-workbench#v0.5.1&path:/dsh-code-workbench"
```

也可以从压缩包安装：把 `dsh-code-workbench-<版本>.tgz` 放到任意位置，在同一个对话框里填它的**绝对路径**。两条路径装进 profile 的内容一致（按 `files` 白名单，13 个文件）。

安装需要目标机器有 **pnpm**；走 GitHub 链接还需要 **git**，压缩包不需要。包里的 `client.js` 是预构建产物，安装过程**不执行任何构建脚本**，所以不会触发 pnpm 的依赖脚本拦截。

**升级**：profile 安装的插件不支持自动更新，升级要「卸载 → 装新版」——所以对外分发建议带 tag，而不是跟最新 master。

## 工作台布局

左侧图标栏切换文件、搜索和历史视图，再次点击当前视图可收起导航。文件树顶部提供新建文件、新建文件夹、刷新和全部折叠。编辑区显示多文件标签和当前文件的路径面包屑，配色与控件跟随 DSH 主题。

文件树里单击空白处会清空选中；顶部的新建按钮于是回到「在工作区根目录创建」，选中某个目录时则改为在该目录中创建。编辑区的标签可以拖动：在标签条内左右拖可以换位，拖进主对话输入框则落成一枚引用胶囊（与拖文件树行同形）。

每个打开的文件保留独立编辑内容、撤销记录和光标/滚动位置，切换标签不丢失未保存修改。标签上的圆点表示未保存；关闭时可确认放弃或取消后保存。开启自动保存后，切换文件也会保存原文件。重命名、移动或删除前必须先保存受影响的打开文件；标签随后同步更新。刷新文件树会重新加载已展开目录。

工作台只渲染 UTF-8 文本，所以 PDF、Excel/CSV、Word/PPT、图片这类文件在这里没有可显示的内容：点击它们**不会开标签页**，而是把文件地址交给右栏的 DSH 官方文档预览打开（状态栏会说明文件去了哪里），右栏因此多出一个预览标签，可与「代码工作台」并排。若当前环境没有注册能认领该地址的预览实现，工作台退回自己的错误提示并注明该去哪看，不会假装打开过。

## 文件树右键菜单

右键点击文件、目录或文件树空白处，可以新建文件和文件夹、在资源管理器中显示、添加路径引用到当前对话、剪切/复制/粘贴、复制路径、重命名及删除。新建和重命名使用工作台内的名称弹窗，删除使用确认弹窗。剪切和复制后，在目标文件夹右键选择粘贴；复制遇到同名文件会自动生成副本名称。「添加路径引用」或把文件树行拖进输入框会落成一枚引用胶囊，发送时展开为与官方 `@` 引用同形的 **`@路径` mention**（目录带尾斜杠）：聊天记录里因此渲染回同一个胶囊、点按在右栏预览，Agent 则按系统提示里那条 `@` 指引先读再下结论。文件操作要求会话允许工作区写入，禁止覆盖已有目标和修改工作区外路径；删除需要确认且不能撤销。

**选中只由用户放下**：单击（左键）文件树的空白处会清空选中。落在行上、行内控件、工具栏（包括工具栏自己的空白）或输入框里的点击不算空白——否则「选中一行」和「清空选中」会重合成一个手势，而选中目录后往右上走点「新建文件」的擦边点击会先把目标打回根目录。清空后顶部新建按钮回到在工作区根目录创建；当前打开的文件不受影响（选中是「操作目标」，不是「正在看的文件」）。

已移除「打开工作区终端」和「在文件夹中查找」。菜单不包含运行测试、调试测试、运行覆盖率测试，目前未加入「添加到新对话」。

## Tab 补全（仅 FIM）

Tab 补全走 **FIM（fill-in-the-middle）**：光标前的代码作 `prompt`、光标后的代码作 `suffix` 一起交给补全接口，服务端补出中间一段。没有提示词、没有对话框架，返回的就是代码本身，贴合度最高。

请求形态固定，**一次请求一次响应，不流式**：

```
POST {baseUrl}/completions        # baseUrl 已以 /completions 结尾则原样使用
{ "model": …, "prompt": "<光标前>", "suffix": "<光标后>", "stream": false, "temperature": 0.2, "max_tokens": 128 }
```

⚠️ **`suffix` 这个键必须始终存在，即使它是空串**。DeepSeek 按请求体的**形状**分流：一旦这个键消失，请求就不再被当成 fill-in-the-middle，而是退化成普通续写——模型于是接着写自己的训练数据（CSDN 教程页的「时间: … 浏览: …」、markdown 围栏那一整套），而不是写代码。实测同一提示词的 A/B：省略该键 **0/4 干净**，显式传空串 **8/8 干净**。所以光标在文件末尾（后缀为空）时走的是 `"suffix": ""`，不是不发这个字段。

**为什么不用流式**：ghost text 只会以「完整建议」的形式出现——Monaco 的 inline-completions provider 只答复一次，无法修订已经返回的结果——所以渐进渲染拿不到任何收益，反而要多养一个 SSE 解析器和一套帧协议。实测两者在噪声范围内没有差别。真正占时间的是**首字节（TTFT）**，400–800ms 的网络 + 服务端排队，客户端改不动。

响应对 `choices[0]` 依次识别 `text`、`message.content`、`delta.content` 三种字段，因此 DeepSeek 之外的兼容服务也能直接用。请求带 10 秒硬超时；打字打断会立即中止在途请求。

### 设置项

在 DSH 设置的「代码工作台」里：

| 设置 | 默认值 | 说明 |
|---|---|---|
| 启用 Tab 补全 | 开 | 关掉后按 Tab 只说缩进，不发请求 |
| 补全接口地址 | `https://api.deepseek.com/beta` | 自动补 `/completions`；也接受完整端点（如 `https://api.mistral.ai/v1/fim/completions`） |
| 补全模型 | `deepseek-flash` | 该端点只接受 `deepseek-flash` 与 `deepseek-v4-pro`，两者都支持 FIM |
| 补全 API Key | 空 | 秘密字段，留空时不显示、不回显；填了就是最高优先级的凭据 |

设置页顶部有一块 **「当前补全链路」**，实际展示请求会落到哪个接口、哪个模型、用的是哪一路凭据——不用猜为什么没补全。

### 凭据优先级

按顺序尝试，第一个可用的胜出；**任何一路都不可用时不报错，只是没有 ghost text**：

1. **设置页填写的 API Key** → 发送 `Authorization: Bearer <key>`
2. **DSH 凭据库里名为 `DEEPSEEK_API_KEY` 的那条**（`$DSH_HOME/.credentials.yaml` 的 `refs`，同名的环境变量也算）→ 同样是 `Bearer`。分发出去时对方机器上**只要他自己配过这个 key，就完全不用碰设置页**。
3. **DSH 登录账号的凭据授权**（`records.deepseek-account-platform/*`）→ **不发 `Authorization`**，改发 DSH 私有头 `x-dsh-auth-token`。仅当目标地址的 **origin** 属于该账号服务信任的推理源（默认 `https://api.deepseek.com`）时才会签发。

API Key 通过 Host 设置服务保存，标记为秘密字段，设置页不会回显。密钥输入框留空保留原密钥。

### 失败时静默

接口地址不合法、找不到凭据、上游拒绝（401/403/5xx）、网络超时——这些**都不会弹错**：Host 半边记一条 `logger.warn`（含接口、模型、凭据来源），回给编辑器的是**一个正常的 200 响应、只是 `text` 为空**，编辑器不显示任何 ghost text，也不弹任何错误。只有请求体本身格式错误（即我们自己客户端半边坏了）才会返回 400。

编辑器状态栏会写一行结果：`AI 补全生成中…` / `Tab 接受 AI 建议` / `AI 未返回补全` / `AI 补全已取消`，便于现场判断到底走没走通。

所以排查补全完全不工作时，看 **DSH 主机日志**里的 `code-workbench: completion skipped — …`（那行带接口、模型和凭据来源），状态栏只告诉你「本地这一侧认为发生了什么」。

给 DSH Web GUI 的右侧栏加一个 **VS Code 风格的代码工作台**：用 **Monaco（VS Code 编辑器内核本体）** 浏览和编辑工作区文件——语法高亮、多光标、查找、撤销，全部与 VS Code 同款。

**设计原则：只组合官方机制，不自建平行协议。** 写盘走官方 Connection 通道 + `ctx.fs`，读盘走官方 `workspaceFiles` Remote。

---

## 当前能力：编辑器 / 检索 / Tab 补全 / 检查点 / 加到对话

| 能力 | 实现 | 机制 |
|---|---|---|
| 编辑器 | **Monaco 内联**（约 5.13 MiB bundle，懒加载） | `monaco-editor` 打进 bundle（浏览器模块表冻结，无 Monaco，必须内联） |
| Worker | Blob URL 内嵌 `editor.worker` | `self.MonacoEnvironment.getWorker`，无 CSP 拦截 |
| 文件树 | 递归、懒展开 | `ctx.remote.workspaceFiles.list`（官方只读 Remote） |
| 读文件 | 分页读全量、按扩展名选语言 | `ctx.remote.workspaceFiles.read`（按行分页，`eof` 收尾） |
| **非文本文件转交** | 点击 PDF / Excel / Word / PPT / 图片等非文本文件 → 不建模型、不开自家标签，改在右栏「文档预览」中打开 | 官方 `fileAddressFor`（`@deepseek-ai/dsh-util-workspace-path`）+ `ctx.sidebarRight.openResource`，落到官方 `dsh-resource://file/**` 预览档位；本插件 tab 类型不注册 pattern，因此不抢官方 fallback |
| **写文件** | `POST /api/code-workbench/write`，**版本守卫**（`FS_STALE_VERSION` 拒绝覆盖并发修改），沙箱策略 = 会话标准策略 | host 半体 `ctx.connection.fetch.register`（与官方 `/api/file` 同一通道）→ `ctx.fs.writeText(target, text, intent, signal, sandboxPolicy)` |
| **代码库检索** | 左栏「搜索」模式：正则/大小写搜索、结果列表、点击跳转到行并高亮 | `POST /api/code-workbench/search`：`ctx.fs` 有界遍历（忽略 `node_modules`/二进制扩展）+ 行匹配，文件数/匹配数/时间三重预算 |
| **@codebase（Agent 工具）** | 对话里的 Agent 自带 `codebase_search` 工具：自然语言多词**排序检索**，返回 top 片段（补官方 `grep` 的精确正则） | `ctx.tools.register`（官方 Tool Runtime）+ 同一检索核心（terms 模式 + 词覆盖率排序） |
| **Tab 补全** | 打字停顿 180ms 后灰色 ghost 建议，**Tab 接受**、继续打字即取消；同一时刻最多一个请求 | Monaco `registerInlineCompletionsProvider`（ghost 渲染/接受全是内建）+ `POST /api/code-workbench/complete`（**纯 FIM、非流式** `prompt`/`suffix`，128 token 预算，凭据三级兜底，10s 硬超时；失败静默）+ `POST /api/code-workbench/completion-status`（只读，回报实际链路） |
| **检查点 / 回滚** | 每次保存自动入账本；左栏「历史」列出检查点，**一键回滚**到任意保存之前；回滚本身也是检查点，可再回滚 | `POST /api/code-workbench/history` / `rollback`（host 内存账本，每文件 20 条、每侧 200KB 上限）+ `ctx.fs.writeText` 版本守卫 |
| **检查更新 / 一键升级** | 有新版发布时面板顶部出现提示条，点「升级」原地替换安装目录里的文件；只动了**运行期不参与启动加载**的文件（`client.js`，以及 `src/*` 构建输入、`build.mjs`、README 等）就**免重启**——`client.js` 由 HMR 自己重载面板；改了 Host 半边启动时加载过的文件（`index.js` 及其 import）才提示「重启 DSH 后生效」 | `POST /api/code-workbench/update-check`（`api.github.com` REST：`/tags` → 该 tag 的 `update.json` → 与本机逐文件摘要比对）与 `POST /api/code-workbench/update-apply`（每个文件先按清单摘要校验、再 `rename` 原子替换）。清单由 `tools/make-update-manifest.py` 生成，摘要统一对 **LF 归一化**后的字节计算 |
| **外部改动自动重载** | Agent/外部改了盘上文件 → 干净缓冲区**自动刷新**；有未保存修改时警告不覆盖 | 官方 `workspaceFiles.changes` 流（`ctx.remote.$stream`），按打开文件订阅 |
| **加到对话（Add to Chat）** | 右栏**选中多行代码** → `Ctrl+L`/按钮 → 主对话输入框里出现**引用胶囊**（只显示 `文件:行号 · N 行`），**发送时才展开**成完整代码块给 Agent | 官方 chip 机制：`slash/input-insert-reference` 事件插 `ReferenceChipNode` + 自注册 reference codec（`inputTriggers.registerSource` 的 `codec.serialize` 做提交展开） |
| **拖拽行到输入框** | 文件树行（文件或目录）拖进主对话输入框 → 落成引用胶囊；**发送时展开为共享 `@路径` mention**（目录带尾斜杠、含空格走 `@"…"`），聊天记录里渲染回同一个胶囊 | 私有 MIME「三重收窄」在 document 捕获阶段接管拖放 → 同一个官方 `slash/input-insert-reference` 通道；提交展开走同一个 reference codec（`clipboardText` 与展开文案逐字一致） |
| **拖拽标签页** | 标签条上的标签同样可拖：拖进主对话输入框 → 与拖文件树行**完全相同的引用胶囊**；在标签条内左右拖 → **换位**，落点那一侧的边缘出现插入标记 | 复用同一个私有 MIME 和同一个官方通道，因此胶囊只有一个出处；条内换位由各自的 drag ref 分流——**两个手势互不认领**（树行拖过标签条不换位，标签拖到文件夹行也不移动文件） |
| **点空白处取消选中** | 单击文件树空白处 → 清空选中；顶部新建按钮随之回到在工作区根目录创建 | 树的容器 `onClick`，用 `closest('.code-workbench-tree-row, button, input, .code-workbench-tree-toolbar')` 排除落在行、行内控件和工具栏上的点击：行点击本来就会冒泡到容器，而工具栏是右对齐的，**选中目录后的下一个动作就是往右上走点「新建文件」，擦边落在它的空白处**——没有这道守卫时，两个手势会重合成一个，近失手又会把目标悄悄打回根目录。清空 `selected` 的同时一并清掉 Shift 多选集合与锚点 |
| 可追溯 | 每次保存记 Session 备注 | `sessionFeedback.record` |
| 主题 | 跟随 DSH 明暗主题 | `body[data-ds-dark-theme]` MutationObserver → `monaco.editor.setTheme` |
| 快捷键 | `Ctrl+S` 保存、`Ctrl+L` 将选中代码加入对话、`Tab` 接受补全（编辑器内） | `editor.addCommand` |

## 组成

| 半体 | 文件 | 职责 |
|---|---|---|
| Host | [`index.js`](dsh-code-workbench/index.js) | 版本守卫写盘、文件操作、检索、Tab 补全、检查点与回滚、检查更新与升级，以及 `codebase_search` 工具 |
| Client 源码 | [`src/client.mjs`](dsh-code-workbench/src/client.mjs) | 右栏 tab `code-workbench`：文件树 + Monaco + Tab 补全 + 代码引用 |
| 构建 | [`build.mjs`](dsh-code-workbench/build.mjs) | esbuild：Monaco/Worker/CSS 全部内联，产出 `client.js`（`__ModuleLoader__` factory 形式） |

## 开发

配置位于 DSH 官方设置页中的「代码工作台」设置项：编辑自动保存（默认关闭，停顿 900ms 后保存）与 Tab 补全的接口地址 / 模型 / API Key。配置由 DSH 持久化，**首次更新 Host schema 后需要重启 DSH**（Host 半边是启动快照；`client.js` 走 HMR，改完即生效）。

```powershell
node dsh-code-workbench/build.mjs        # 重新构建 client.js（Monaco 内联）
node tools/test-client-contract.mjs   # 客户端契约（bundle 资产/导出/注册/注入）
node tools/test-host-write.mjs        # 写盘路由（沙箱策略戳/版本守卫/鉴权）
node tools/test-file-operations.mjs   # 文件操作（权限/范围/禁止覆盖）
node tools/test-host-search.mjs       # 检索路由（有界遍历/忽略规则/正则/上限）
node tools/test-host-tool.mjs         # codebase_search 工具（注册契约/排序/上限）
node tools/test-host-complete.mjs     # Tab 补全路由（FIM 调用/凭据优先级/静默失败/状态路由）
node tools/test-completion-api.mjs    # FIM 传输（端点拼接/鉴权头/取消传播/响应三形态）
node tools/test-host-history.mjs      # 检查点账本（入账/回滚/可回滚性）
node tools/test-host-update.mjs       # 检查更新与升级（tag 排序/摘要校验/换行归一化/原子替换/越界清单）
node tools/test-bundle-slim.mjs       # bundle 瘦身（体积门槛/该有的在/该删的不在）
node tools/test-client-smoke.mjs      # 客户端渲染冒烟（真实 React 渲染 + 驱动交互链路）
node tools/analyze-bundle.mjs         # bundle 体积归因（哪个模块最胖）
node tools/fim-mock-server.mjs        # 本地 FIM 镜像：打印真实请求形状、判定 FIM/chat、回一段合法 JSON 让 ghost text 真的出现
node tools/probe-completion-credential.mjs          # 打印凭据链会选中哪一路（只读，不联网）
node tools/probe-completion-credential.mjs --live    # 再对每一路真实各发一个小请求，验证真的能补
# 改 client.js 不需要重启：HMR 按文件元数据（mtime/ctime/size）算修订号，重写即重载
# 改 index.js（host 半体）需要重启 DSH：桌面 boot 图是启动快照
```

**构建管线**：`src/*.mjs` → esbuild(CJS, `react` external) → 包一层
`window.__ModuleLoader__.load({ id, factory(require) { … } })`；Monaco 的 CSS/字体
转成注入 `<style>`，`editor.worker` 转成 Blob URL。factory 只 `require('react')`
（冻结模块表），其余全部内联——这是 bundle 契约。

**客户端依赖**：`src/client.mjs` 只多引一个官方包 `@deepseek-ai/dsh-util-workspace-path`（版本与 DSH `0.2.0-rc.2` 对齐，devDependency），用它的 `fileAddressFor` 拼官方预览地址——地址语法归官方所有，不自建一份。构建期内联进 `client.js`，bundle 契约不变（factory 仍只 `require('react')`）。

**依赖安装**：本机 npm 需走系统代理（`$env:HTTPS_PROXY='http://127.0.0.1:7897'`），否则被 DNS 劫持。

**发布清单**：每次发版、改完所有要发的文件**之后**跑一次
`python tools/make-update-manifest.py`，把 `dsh-code-workbench/update.json` 一起提交。它是
「检查更新」唯一的版本来源：列出本版每个文件的 SHA-256，并带上 `version`。两条约束：

- **`update.json` 的 `version` 必须与该 tag 上的 `package.json` 一致**（脚本从 `package.json` 读，不要手改）。不一致时，用户点升级会拿到一个「仓库从没发布过」的版本号。
- 摘要算的是**把 CRLF 归一化成 LF 之后**的字节。仓库根 `.gitattributes` 现在把所有文件在**检出时**也钉成 LF（`* text=auto eol=lf`），所以库里的、工作区的、tarball 里的、git 安装落地的字节如今是同一条流，脚本在正常仓库里不会再打印任何「被归一化」的行。归一化本身仍然保留：它对付的是 **`.gitattributes` 之前装下来的副本**——那些副本里 `index.js`、`src/client.mjs`、`client.js` 在 Windows 上是 CRLF，不归一化就会被永久判成「有更新」。这就是 `_fault_inject_update.py` 注入 A 要守的东西。

`update.json` 随仓库发布即可，**不进 npm `files`**：升级读的是 GitHub 上那个 tag 的副本，装在盘上的副本没有用处。

## 已知限制

- 文件同步使用官方 changes 流，并每 1.5 秒检查打开文件版本、窗口重新聚焦时检查；干净缓冲区自动重读，未保存修改保留。
- 新发送的代码引用在聊天记录中默认折叠为文件与行号，点击展开；模型仍收到完整选区。此前发送的普通代码块没有引用标记，保留原展示。
- 路径引用（右键「添加路径引用」或拖拽文件树行）在聊天记录里是与输入框同形的胶囊，点按在右栏预览——因为提交时展开的就是官方 `@路径` mention，官方投影再把这段文字装饰回胶囊。目录胶囊只作展示：官方投影只给文件接跳转。
- 非文本文件（PDF、xlsx/xls/csv/tsv、doc/docx/ppt/pptx、图片等）不在本面板渲染：工作台只把文件地址**转交**给右栏的官方文档预览，因此它们的标签页不会出现在「代码工作台」里。转交依据是读取失败的错误码（`workspace-file/not-text` / `too-large`），**不是后缀白名单**——能渲染哪些后缀由官方预览自己的注册表拥有，这里不复制一份。若当前环境没有注册能认领该地址的预览实现（`openResource` 会抛错），工作台保留自己的错误提示并注明该去哪看，不会报告一个它没能打开的文件。
- 更新读的是 `api.github.com` REST 接口（`/tags`、`/contents`、`/git/blobs`），不走 raw 内容域——后者在部分网络下不可达。仓库没有 Release 对象，所以版本从 **tag 列表**里取：这里自己按 semver 排序（`/tags` 不承诺顺序），取最高的那个带 `update.json` 的 tag，因此本特性之前发布的 tag 会被逐个跳过而不是让整次检查失败。GitHub 不可达、仓库里没有清单、本地已是最新——三者对面板都只有一个答案：不显示任何东西。
- 升级只写**本包自己的安装目录**，不触碰工作区。清单里出现绝对路径、`.`/`..` 段、反斜杠或空段会被直接拒绝；文件数上限 64、单文件上限 32 MiB、清单上限 256 KiB。
- 替换是**逐文件**的 `rename`：一个文件失败不影响已经落地的那些，失败时留下的是「逐个都合法但版本混合」的树，而不是写坏的文件。校验用的是发布方在清单里给出的摘要（用 `rename` 而不是直接写，是因为安装树里每个文件都是 pnpm 硬链接到内容库的，写穿会改到其他 profile 共用的那份）。
- ⚠️ 若某次更新提示「重启 DSH 后生效」而用户没有重启就关掉了面板：**不会**再次提示——`installedVersion()` 读的是盘上的 `package.json`，而那时盘上已经是最新版了。这是刻意的（盘上版本就是已安装版本，不制造「永远提示有更新」的假信号），代价是这次提醒是一次性的；下次启动 DSH 会让新版本全面生效。要让「待重启」也持续提醒，需要在启动时快照当前版本再与盘上比对。
- 免重启的判定只看 `client.js` / `package.json` 是否在改动之列；只要发布里动了 Host 半边加载过的文件（`index.js`、`completion-api.mjs`、`vendor/schemastery.mjs`、`src/completion-window.mjs`、`cordis.patch.yml`），就提示重启——那些代码进程已经加载在内存里，替换文件本身不足以让它们生效。
- 拖放的两个手势共用同一个私有 MIME，靠各自的 drag ref 分流，所以**跨手势不生效**：把标签拖到文件树的文件夹行上不会移动文件，把文件树行拖过标签条也不会换位。要移动文件请用树内拖放或右键剪切/粘贴，要换位请在标签条内拖。
- 文件树的「选中」和编辑区的「当前文件」是两件事：清空选中不会关闭任何标签，打开一个文件也不改变树里的选中（顶部新建按钮的落点始终跟着选中走）。选中的目录不会被自动展开。
- Tab 补全采用 180ms 请求防抖、较小的前后文（前缀 3200 字符 / 后缀 900 字符）和 128 token 预算，并缓存最近 40 个光标上下文。


  触发完全交给 Monaco：它在每个输入字符（含空格）、退格/删除、Tab、粘贴和显式光标移动上都会自己发请求，插件不再额外补一枪。

  此前插件在内容变更后 400ms 会自己发一次 `editor.action.inlineSuggest.trigger`，而那是 **Explicit** 触发，不满足已在途的 Automatic 请求（`UpdateRequest.satisfies` 要求 `this` 侧也是 Explicit）——Monaco 会丢掉在途那次并重开一次，于是每次补全都多一个往返、固定多等 400ms；更糟的是每多敲一个字终点就再后退 400ms，表现就是「要打个空格或删一下才会出来」。

  同一光标的并发请求现在共享一次往返：第二次询问 await 第一次的答案并优先读缓存，而不是回 `{items: []}`——空数组对 Monaco 不是「我不知道」而是「这一版没有建议」的判决，被记进 state 后 `satisfies` 会短路掉该版本上后续的显式询问，于是必须再动一次键盘才解锁。

  ⚠️ **本机网络抖动实测 ±300ms，比大部分参数效应还大**——任何「提速了」的判断都要多轮取样才作数，单次测量没有意义。目前真正能调的只剩防抖（180ms）和 `max_tokens`（128）。`max_tokens` 调小能省 150–400ms，但长建议会被截断，属于取舍不是白捡。

- 凭据第三级（DSH 账号授权）已**对真实 `/beta/completions` 端点验证通过**（HTTP 200，用私有头 `x-dsh-auth-token`、不带 `Authorization`）。用 `node tools/probe-completion-credential.mjs --live` 可随时复核三条链路。注意它只在 **origin** 属于该账号服务信任的推理源时才会签发。
- 工作台使用 DSH 官方主题变量；导航可收起，窄面板改为上下布局，顶部文件路径与操作分行显示。

- bundle 5.13 MiB（Monaco 内核 minify 后 + 常用 28 种语法 + JSON 语言服务）；首次打开面板时解析（懒加载）。
- TS/JS 语义智能未启用（砍掉了 12MB 的 TS 语言服务）：TS/JS 有语法高亮 + 编辑器全套功能，但没有语义诊断/跳转；补全为词级 + AI ghost text。
- 单文件读取受官方 `workspaceFiles` 上限约束（默认 2 MiB / 5000 行一页，最多 40 页）。
- 检查点账本在 host 内存（每文件 20 条）：重启 DSH 后清零。
- 「语义检索」为词覆盖率排序的词汇检索（DeepSeek API 无 embeddings 端点，无法做向量语义）。
