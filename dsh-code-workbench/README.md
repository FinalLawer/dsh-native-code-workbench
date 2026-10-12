# dsh-code-workbench — TypeScript

DSH Web GUI 右栏的代码工作台插件，**TypeScript 重写版**。

本目录是 `dsh-code-workbench` 的一次完整 TypeScript 重构：行为与 0.5.5 版逐字等价，
源码全部改为带类型的 `.ts` / `.mts`，并新增了一套手写的 DSH SDK 类型声明。
原 JS 版项目未被改动，两者可以并存对照。

---

## 快速开始

```bash
npm install          # 依赖（含 typescript 与 @types/react）
npm run typecheck    # 类型门禁：tsc --noEmit，strict 全开
npm run build        # 转译 Host 半边 + 打包 client 半边
npm test             # 11 个测试套件
npm run manifest     # 重新生成 update.json
```

`npm run verify` = `typecheck && build`。

`tools/` 下是原项目测试套件的副本，只改动了指向包目录的相对路径（`../dsh-code-workbench/X`
→ `../X`），断言一字未改。这样本目录可以独立自测，不依赖仓库布局。

---

## 目录结构

源码与产物同名同目录——这是刻意的，因为 `index.js` 的相对导入必须逐字保留：

| 源文件 | 产物 | 说明 |
|---|---|---|
| `index.ts` | `index.js` | Host 半边，DSH 启动时加载 |
| `completion-api.mts` | `completion-api.mjs` | FIM 补全的唯一线上协议 |
| `src/client.ts` | `client.js` | 客户端半边，**被打包**（含 Monaco） |
| `src/snippets.mts` | `src/snippets.mjs` | 聊天片段编解码 |
| `src/completion-window.mts` | `src/completion-window.mjs` | 补全上下文窗口的两个数字，两半共享 |
| `src/monaco-entry.mts` | `src/monaco-entry.mjs` | 精简版 Monaco 入口 |
| `src/workbench.css` | （内联进 `client.js`） | 样式 |

为什么是 `.mts` 而不是 `.ts`：TypeScript 的扩展名替换规则里，`.mjs` 只映射到
`.mts`。`index.ts` 里写的是 `./completion-api.mjs`（这是**产物**的真实名字，必须
逐字保留），所以对应源文件必须是 `.mts` 才能被解析。同时 `.mts` 让 tsc 直接产出
`.mjs`，无需改名。

`types/` 下是手写的 DSH SDK 类型声明：

| 文件 | 内容 |
|---|---|
| `types/dsh-client.d.ts` | 客户端面：`ctx`、slot 注册表、右栏控制器、Remote 命名空间、`CodePanel` 的 props |
| `types/dsh-host.d.ts` | Host 面：`ctx.connection` / `fs` / `sessions` / `tools` / `settings`，以及 `ctx.get` 的重载 |
| `types/globals.d.ts` | CSS 导入、`__ModuleLoader__`、测试用的 Monaco 替身 |
| `types/monaco-contributions.d.ts` | 10 个没有 `.d.ts` 的 Monaco 副作用入口 |

`vendor/schemastery.d.mts` 是上游包 `lib/types/index.d.ts` 的**逐字副本**，所以
`Config` schema 保留了真实推导（`.volatile()` 字段推导为 `Volatile<T>`，这正是
`preference()` 必须调 `.get()` 的原因）。

---

## 几个决定，以及为什么

**1. 类型声明是手写的。**
已装 SDK 的 `package.json` 普遍声明了 `"types": "lib/types/index.d.ts"`，但
**包里没有该文件**——`ref/dsh/node_modules/@deepseek-ai/` 下 289 个包、286 个声明了
`types`、实际 `.d.ts` 数量为 **0**。所以 `ctx` 只能手写。声明的范围是刻意的：**只写
这个插件真正调用的那部分**。试图覆盖整个 SDK 的声明会成为它的第二份、无法校验的副本。

**2. Host 半边用 `tsc` 转译，不是 esbuild。**
esbuild 会剥掉全部注释——实测从 `index.js` 里抹掉了 **136 处**注释块。安装后的
`index.js` 是排障时唯一能读的东西，不能这样丢。`tsconfig.build.json` 开了
`noEmitOnError`，所以类型错误会**构建失败**，不会进入产物。

**3. `build.mjs` 保持 JavaScript。**
它是编译 TypeScript 的工具。把它写成 TypeScript 会让构建依赖一次已完成的构建，
而它本身既不进浏览器也不被 DSH 加载，没有收益。类型检查是独立的门禁。

**4. 客户端半边仍然被打包。**
DSH 的客户端模块运行时把每个插件当一段自包含的经典脚本加载，工厂里只允许
`require` 基线模块表（`react` 等），Monaco 不在表里，所以必须内联。这条没变。

**5. 一处为类型让路的改动。**
`ctx.connection.admit()` 的返回值原本用 `'rejection' in admission` 判定。TS 无法
用 `in` 从「键可选」的联合里剔除 `undefined`，因此声明为 `rejection?: number`、
判定改为 `admission.rejection !== undefined`。对真实输入（`{}` 或
`{ rejection: <状态码> }`）两者完全等价，理由写在 `types/dsh-host.d.ts` 里。

**6. 一处顺带暴露的真实缺陷。**
`journalDropColdest` 等三处对 `pop()` 的结果直接取值，原 JS 在数组为空时会抛
TypeError（不可达，但靠的是未言明的约束）。`journalEntryChars` 现在接受
`JournalEntry | undefined` 并对 `undefined` 返回 0，把那个约束写进了签名。

---

## 类型门禁

`tsconfig.json` 开着 `strict`，并额外启用：

| 开关 | 挡的是什么 |
|---|---|
| `noUncheckedIndexedAccess` | 数组与索引访问返回 `T \| undefined` |
| `exactOptionalPropertyTypes` | 区分「键不存在」与「键存在但值为 `undefined`」 |
| `noUnusedLocals` / `noUnusedParameters` | 死变量、未用参数 |
| `noImplicitReturns` | 分支漏返回 |
| `noImplicitOverride` | 覆写漏写 `override` |
| `noFallthroughCasesInSwitch` | `case` 穿透 |
| `useUnknownInCatchVariables` | `catch` 变量是 `unknown` 而非 `any` |
| `verbatimModuleSyntax` | 类型导入必须显式 `import type`，esbuild 才敢安全擦除 |
| `isolatedModules` | 单文件转译安全 |
| `erasableSyntaxOnly` | **禁止 `enum` / `namespace` / 参数属性等 esbuild 擦不掉的语法** |

最后一条是这套门禁里最贴合本项目的一条：客户端半边由 esbuild 打包，`erasableSyntaxOnly`
保证源码永远能被安全剥离类型——不会出现「编译过了，但打包时行为变了」的意外。

当前状态：**0 错误**。

### 断言与逃逸点

| | 数量 |
|---|---|
| `as` 断言 | 30 |
| 非空断言 `!` | 0 |
| `any`（自写代码） | 0 |
| `@ts-ignore` / `@ts-expect-error` | 0 |

30 处 `as` 里最大的一簇（6 处）原本是 `new Error(msg) as CodedError`，现已改成真正的
`CodedError` 子类 + 三个窄化读取器（`thrownCode` / `thrownStatus` / `thrownMessage`）。
全文件只剩**一处**cast——`thrownProperty` 里把 `unknown` 读成对象，那是类型系统唯一
帮不上的地方，所以收进一个带注释的窄口子里。

`exactOptionalPropertyTypes` 打开时抓到一处真实的不精确：`CompletionConfig` 的
`apiKey?: string` 在调用方传 `string | undefined` 时是错的类型。改成 `string | undefined`
后——**注意 `completion-api.mjs` 的 sha256 完全没变**，因为这是纯类型层的修正，擦除后零影响。

---

### 移植过程中被发现的两个真实回归

**一、类型声明把运行时错误藏起来了（最值得记的一个）**

原版读测试替身用的是 `globalThis.__CODE_WORKBENCH_TEST_MONACO__`。转 TS 时我给它写了
`declare var __CODE_WORKBENCH_TEST_MONACO__: unknown`，于是写成裸标识符也能编译通过：

```ts
// 编译通过，运行必炸
monacoPromise = __CODE_WORKBENCH_TEST_MONACO__ !== undefined ? … : import('./monaco-entry.mjs')
```

编译通过是因为**我告诉编译器这个全局存在**；运行时炸是因为**没有任何东西定义它**——
裸引用未声明的标识符是 `ReferenceError`，不是 `undefined`。表现是整个右栏面板空白，
控制台里是：

```
slot entry crashed in "sidebar.right.pane.tab":
ReferenceError: __CODE_WORKBENCH_TEST_MONACO__ is not defined
```

而**冒烟测试抓不到它**：`test-client-smoke.mjs` 在求值 bundle 之前就把这个全局装好了，
所以裸引用在那里恰好能解析。测试永远定义它，就永远测不出「没定义会怎样」。

修法不是补回 `globalThis.` 就完事，而是**删掉那个 `declare var`**，改成类型化的属性访问：

```ts
const seam = (globalThis as { __CODE_WORKBENCH_TEST_MONACO__?: unknown }).__CODE_WORKBENCH_TEST_MONACO__
```

属性访问在缺失时是 `undefined`——编译期和运行期语义一致。删掉声明之后，裸引用**再也编译不过**。
另加 `tools/test-client-globals.mjs` 守住这条：它读构建产物，断言每一处引用都带 `globalThis.` 前缀。

**二、文件监听流被过度包装**

第一轮移植里，`changes` 被声明成 `AsyncIterable<RemoteResult<WorkspaceFileWatchFrame>>`——
看起来合理，实际错误：它产出的是**裸帧**（`{ kind: 'ready' }` / `{ kind: 'change' }`），流失败
是通过结束迭代表达的，没有错误帧。这层多余的 `ok === true` 解包让每一个帧都被丢弃，于是
「外部改动自动重载」和「ready 后限流轮询」静默失效，`test-client-smoke` 掉到 270 / 275。
修回裸帧后恢复 275 / 275。

两条教训是同一条：**给没有官方类型的 API 补声明时，「合理猜测」可能比不写更危险**——
它会把错误伪装成已校验的契约。这一条写在 `types/dsh-client.d.ts` 的 `WorkspaceFilesRemote`
和 `types/globals.d.ts` 里。

---

## 验证

产物与原版逐项对照通过：

- **12 / 12 测试套件全过**（`test-client-contract`、`test-host-write`、
  `test-file-operations`、`test-host-search`、`test-host-tool`、`test-host-complete`、
  `test-completion-api`、`test-host-history`、`test-host-update`、`test-bundle-slim`、
  `test-client-globals`、`test-client-smoke`）。
- **`test-client-smoke` 275 / 275 断言通过**，与原版计数完全一致。它加载真实的
  `client.js`，用 `react-test-renderer` 渲染真实的 `CodePanel`，并驱动打开文件、
  版本守卫保存、搜索跳转、拖拽、外链变更监听、更新横幅等全部流程。
- **导出面一致**：`index.js` 导出 `{ Config, apply }`，`completion-api.mjs` 导出
  `{ ACCOUNT_TOKEN_HEADER, completeFim, fimEndpoint }`，与原版相同。
- **`Config({})` 解析结果一致**（五项默认值逐一比对）。
- **`fimEndpoint` 推导一致**：根地址、带尾斜杠、完整端点三种输入。

---

## 体积

| | 原版 | TS 版 |
|---|---|---|
| `client.js` | 5,387,436 B | 5,394,539 B |
| `index.js` | 70,836 B | 79,411 B |
| `completion-api.mjs` | 8,379 B | 8,651 B |

`client.js` 的差异来自类型擦除后的少量代码形态变化，以及后面那轮观感/手感优化。
`index.js` 变大是因为新增了类型声明与设计理由处的注释——**多出来的字节全是注释，不是逻辑**。

---

## 一次针对性的优化（移植完成之后）

移植做完后按「收益 / 成本」筛过一轮，只做了前两组：

**第一组：打开四个开关（零代码改动）**

`erasableSyntaxOnly`、`noUnusedLocals`、`noUnusedParameters`、`exactOptionalPropertyTypes`。
前三个当场 0 错误；`exactOptionalPropertyTypes` 抓到一处真实的不精确（见上）。顺带清掉两处死物：
解构了但从未使用的 `useMemo`（**原版就有的**），以及 Monaco 接口要求但没用到的 `context` 参数（改名 `_context`）。

**第二组：消掉断言（局部改动）**

- 4 处 `monaco!` → 在 `openFile` 开头把命名空间绑定成 `monacoApi` 一次，让"有编辑器就有命名空间"
  这个不变量只声明一遍，而不是每次使用都断言一次。非空断言归零。
- 6 处 `as CodedError` → 真正的 `CodedError` 子类 + 三个窄化读取器。

**验证**：12/12 测试套件通过，冒烟仍是 **275/275**。另外对 `fileFailure` 做了**新旧逐一对拍**——
把安装副本里的旧 `index.js` 和新构建并排跑，喂 15 种错误形状：

```
FS_STALE_VERSION / FS_SANDBOX_DENIED / FS_NOT_FOUND / FS_TOO_LARGE / FS_IO_ERROR
ENOENT / EPERM / ENOTEMPTY / ENOSPC / 未知错误码 / 裸 Error
throw 'string' / throw null / throw undefined / 有码无消息的对象
```

**15/15 状态码与响应体完全一致。** 这是这次重构里风险最高的一处，所以用对拍而不是靠读代码来确认。

**没做的**：`noPropertyAccessFromIndexSignature`（19 个错误，全是噪音）；`client.ts` 拆分
（3,100 行单文件，值得做但要单独排期）；给手写声明写对账脚本（最有价值，也最花时间）。

---

## 一次观感与手感的优化

类型卫生做完后，按「用户看得见 / 摸得着」筛过一轮，做了八项。全部在客户端半边，
所以热换 `client.js` 后重载页面即可，不必重启。

**观感**

| | 改了什么 | 为什么 |
|---|---|---|
| Monaco 主题 | 从 `vs` / `vs-dark` 改为按 DSH 的 `--dsw-alias-*` 现算的主题 | 编辑区占面板绝大部分面积，之前它画的是自己的白/黑，跟面板的底色对不上，两块拼在一起 |
| 编辑器启动 | 加加载占位（转圈 + 「正在启动编辑器…」） | Monaco 是 5 MiB 的 JS，首次解析不瞬时；之前那段时间是一块无解释的空白矩形 |
| 状态栏 | 加严重性圆点（失败/警告/进行中） | 同一行同一色的 11px 句子里，「已保存」和「保存失败: 版本冲突」长得一模一样 |
| 文件类型 | 文件行用语言色标记替代空白占位 | 目录树里「多少是代码、多少是配置、多少是资源」以前只能靠读后缀 |
| 动效 | 12 处 120ms 过渡、可旋转的折叠三角、新行淡入 | 之前全库只有 2 处 transition、0 个 keyframes，展开目录是硬跳变 |

**手感**

| | 改了什么 | 为什么 |
|---|---|---|
| 活动标签 | 自动滚进视野 | 之前整个 `client.ts` 里 `scrollIntoView` 只出现一次（在树里）。标签栏溢出后，正在编辑的标签可能就在视野外 |
| 拖拽悬停 | 停在折叠目录上 700ms 自动展开 | 往看不见内容的目录里拖是盲猜 |
| 搜索 | 输入停顿 300ms 自动搜（回车仍立即搜） | 之前每次都要回车 |

**两个实现上的选择值得记**

1. **Monaco 主题只改「外壳」，不动语法高亮。** `defineTheme` 用 `base: 'vs' | 'vs-dark'`
   加 `inherit: true`，只覆盖 `colors` 里的背景、行号、当前行、选区、控件、滚动条。
   语法配色是调过的，不该由这个插件重新发明。`editor.background` 取的是
   `--dsw-alias-markdown-code-block`——DSH 自己给代码块用的那个 token，所以编辑器跟产品里
   其他显示代码的地方是同一个底色。
2. **新行淡入挂在行本身，不是挂在列表容器上。** React 只要 key（路径）还在屏幕上就会复用
   那个 DOM 节点，所以只有**真正新出现**的行会跑动画——展开目录时露出来的那些。因为别的原因
   重渲染整棵树，什么都不会重播。

**验证**：12/12 测试套件通过，冒烟仍是 **275/275**——这八项没有一个改动现有断言覆盖的行为。
`client.js` 从 5,388,251 B 增到 5,394,539 B（+6,288 B）。

**没做的**：第 7 项（补全反馈离光标太远）按用户要求跳过。大文件的静默截断是可靠性问题，
应当单独当 bug 修，不混在优化里。

---

## 安装

包名仍是 `dsh-code-workbench`，是原插件的**直接替换**（同名，不可同时安装）：

```bash
dsh plugin install <本目录>#path:.
```

改过 `index.ts` / `completion-api.mts` / `src/*.mts` 需要重启 DSH；只改
`src/client.ts` 时重新构建即可，客户端模块注册表会在 `client.js` 版本变化时热重载。

---

## 许可

MIT，与原项目一致。
