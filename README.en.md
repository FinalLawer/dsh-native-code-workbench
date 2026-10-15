# DSH Code Workbench

[简体中文](README.md) · **English** · [繁體中文](README.zh-TW.md)

A **VS Code-style code workbench** for the DSH Web GUI's right sidebar: browse and edit workspace files with **Monaco (the editor core of VS Code itself)** — syntax highlighting, multiple cursors, find, undo, all identical to VS Code. On top of that: workspace-wide search, Tab completion, save checkpoints with rollback, and adding code to the conversation.

**Design rule: compose the official mechanisms, invent no parallel protocol.** Writes go through the official Connection channel plus `ctx.fs`; reads go through the official `workspaceFiles` Remote; previews are handed to the official document preview; chat references ride the official chip channel. The plugin invents no protocol and copies no registry.

## Installation

In DSH's sidebar, open the **Plugins** page, click **Add plugin**, paste one of the specs below, then click **Enable now** once it is installed. A bundle that is installed but not enabled can still be switched on from the Plugins page later.

### From npm (simplest)

```
dsh-code-workbench
```

Pin a version by naming it:

```
dsh-code-workbench@0.6.3
```

### From GitHub

```
https://github.com/FinalLawer/dsh-native-code-workbench#path:/dsh-code-workbench
```

To pin, carry the tag with it:

```
https://github.com/FinalLawer/dsh-native-code-workbench#v0.6.3&path:/dsh-code-workbench
```

⚠️ **The `#path:/dsh-code-workbench` fragment is not optional.** This repository's root is not a package — the plugin lives in the `dsh-code-workbench/` subdirectory, and the root has no `package.json`. Omit it and pnpm still reports a successful install, but what lands is a placeholder package named `dsh-native-code-workbench.git` at version `0.0.0` (its manifest is pnpm's generated `{"_pnpmPlaceholder": …}`), with neither a package manifest nor a `dsh.bundle` declaration — DSH cannot read a bundle out of it and the plugin never appears. That failure happens *after* the install, so nothing about the install process shows it. npm and the tarball do not have this problem.

### From a tarball

Put `dsh-code-workbench-<version>.tgz` anywhere and paste its **absolute path** into the same dialog. All three routes put the same content into the profile (per the `files` whitelist, 20 files).

### Dependencies and upgrading

Installing needs **pnpm** on the target machine; the GitHub link additionally needs **git**, while npm and the tarball do not. The `client.js` in the package is a prebuilt artifact, so **no build script runs during installation** and pnpm's dependency-script gate is never tripped.

**Upgrading**: the official installer only installs and removes — there is no `update` subcommand. The plugin carries its own *Check for updates / One-click upgrade* (see "What it does" below). You can also upgrade by hand: paste the new spec into the install box and press Enter — the same-name guard compares the **bare package name** only, so a full URL is never blocked. For distribution, prefer a tag or a version over tracking the latest master.

## Workbench layout

The icon rail on the left switches between the file, search and history views; clicking the current view again collapses the navigation. The top of the file tree offers new file, new folder, refresh and collapse-all. The editor area shows multi-file tabs and a breadcrumb for the current file's path, and its colours and controls follow the DSH theme.

Clicking empty space in the file tree clears the selection; the toolbar's create button then returns to "create at the workspace root", and selecting a directory redirects it into that directory. The tree marks the **selection** and nothing else — **the file you have open carries no marker in the tree**; which file is open is answered by the tab strip (exactly one active tab). Editor tabs are draggable: dragging sideways within the strip reorders them, and dragging one into the main conversation composer drops a reference chip (the same shape a dragged tree row produces).

Every open file keeps its own edits, undo history and cursor/scroll position, so switching tabs never loses unsaved work. A dot on a tab means unsaved; closing it offers to discard, or to save and then close. With auto-save on, switching files also saves the one you left. Renaming, moving or deleting requires the affected open files to be saved first; the tabs then follow. Refreshing the tree reloads every expanded directory.

The workbench renders UTF-8 text only, so PDFs, Excel/CSV, Word/PPT and images have nothing to show here: clicking one **does not open a tab**. Instead the file's address is handed to DSH's official document preview in the right sidebar (the status line says where the file went), which is why a preview tab can appear alongside Code Workbench. If the current environment has no preview implementation registered that will claim that address, the workbench falls back to its own message naming where to look, rather than pretending it opened something.

## File tree context menu

Right-clicking a file, a directory, or empty space in the tree offers new file and new folder, reveal in the OS file manager, add a path reference to the current conversation, open a workspace terminal, cut/copy/paste, copy path, rename and delete. Creating and renaming use an in-workbench name prompt; deleting uses a confirmation prompt. After cut or copy, right-click the destination folder and choose paste; copying onto an existing name generates a distinct one. *Add path reference*, or dragging a tree row into the composer, drops a reference chip that expands on send into an **`@path` mention** shaped exactly like the official `@` reference (directories carry a trailing slash): the transcript therefore decorates it back into the same chip and clicking it previews in the right sidebar, while the agent reads first and concludes after, per the `@` guidance in its system prompt. File operations require the session to allow workspace writes, and refuse to overwrite an existing target or to touch a path outside the workspace; deletion is confirmed and cannot be undone.

**Only the user puts a selection down**: a left-click on empty tree space clears it. Clicks that land on a row, a control inside a row, the toolbar (including the toolbar's own empty space) or an input do not count as empty — otherwise "select a row" and "clear the selection" would collapse into one gesture, and the glancing click that follows selecting a directory on the way up-right to *New file* would quietly reset the target to the root first. Clearing the selection also clears the Shift multi-select set and its anchor; the file you have open is unaffected (the selection is *what an action acts on*, not *what you are looking at*).

*Find in folder* still does not exist. The menu has no run tests, debug tests or run coverage, and *Add to new conversation* is not in it yet.

*Open workspace terminal* was **removed once** (there was no official channel for it) and is back. It calls the right-sidebar navigation controller's `openTab('terminal')` and opens the **official terminal** tab — the same kind as *New terminal* in that panel's own `+` menu (the kind is `terminal`; `dsh-client-ui-sidebar-terminal` is a **package name**, and passing it as a kind throws and opens nothing). What opens is the official terminal itself: shell, working directory and PTY all belong to that package, so this **only opens the terminal and runs nothing for you** — no row you click changes its working directory (the terminal starts in the session workspace), which is why the menu entry reads *Workspace terminal* rather than *Open terminal here*. If no terminal panel is registered, the menu says plainly that it cannot open one and why, rather than pretending it did.

## Tab completion (FIM only)

Tab completion uses **FIM (fill-in-the-middle)**: the code before the caret becomes `prompt` and the code after it becomes `suffix`, and the endpoint fills in the middle. No instructions, no chat framing — what comes back is code, which is what fits best.

The request shape is fixed, **one request, one response, no streaming**:

```
POST {baseUrl}/completions        # used as-is if baseUrl already ends in /completions
{ "model": …, "prompt": "<before caret>", "suffix": "<after caret>", "stream": false, "temperature": 0.2, "max_tokens": 128 }
```

⚠️ **The `suffix` key must always be present, even when it is an empty string.** DeepSeek routes on the **shape** of the request body: once that key disappears the request is no longer treated as fill-in-the-middle and degrades to ordinary continuation — the model then carries on writing its own training data (the `时间: … 浏览: …` of a CSDN tutorial page, the whole markdown-fence routine) instead of code. Measured A/B on one prompt: omitting the key **0/4 clean**, sending an explicit empty string **8/8 clean**. So with the caret at end-of-file (empty suffix) the request sends `"suffix": ""` rather than dropping the field.

**Why not streaming**: ghost text only ever appears as a *complete* suggestion — Monaco's inline-completions provider answers once and cannot revise a result it has already returned — so progressive rendering buys nothing while costing an SSE parser and a frame protocol. The two measured the same within noise. What actually takes the time is **time to first byte**, 400–800 ms of network and server queueing that the client cannot move.

Responses are read from `choices[0]` across `text`, `message.content` and `delta.content` in that order, so a compatible service other than DeepSeek works unchanged. Requests carry a hard 10-second timeout; typing interrupts and aborts the one in flight immediately.

Triggering is mostly left to Monaco: it issues its own request on every typed character (space included), on backspace/delete, on Tab, and on paste. The plugin adds exactly the one case Monaco never asks about: the **caret arriving** (a mouse click into a line, the arrow keys walking there) — after it settles for 250 ms, one ask goes out through the `onDidChangeInlineCompletions` channel. A caret move an edit dragged along, a landing inside a selection being drawn, and a move the program made on its own are not arrivals. It used to fire `editor.action.inlineSuggest.trigger` 400 ms after a content change, and that is an **Explicit** trigger, which does not satisfy an in-flight Automatic request — Monaco discards the one in flight and starts another, so every completion cost an extra round trip and a fixed extra 400 ms; worse, every further keystroke pushed the finish line another 400 ms out, which reads as "it only shows up if I type a space or delete something".

Concurrent requests for the same caret now share one round trip: the second ask awaits the first answer and prefers the cache, rather than replying `{items: []}` — an empty array is not "I don't know" to Monaco but a verdict that *this version has no suggestions*, and once recorded in state it short-circuits later asks on that version, so the user has to move the keyboard again to unlock it.

**On a blank line**: with the caret sitting on an empty (or indent-only) line, the model often answers with its end-of-line habit — a line break first, then indented code. But the line is already new, so the extra break leaves the ghost's first line as nothing but spaces or an indent, and Tab inserts a break plus indent. The plugin folds that redundant leading break onto the blank line so the code lands where the caret is (a suggestion landing at a line boundary needs that leading break stripped before it means anything at the caret); an answer that is still whitespace after the fold remains "no suggestion". At the end of a real line the very same break-and-indent is the right answer and is kept verbatim.

### Settings

Under *Code Workbench* in DSH's settings:

| Setting | Default | Notes |
|---|---|---|
| Enable Tab completion | on | Off means Tab only indents and sends nothing |
| Completion endpoint | `https://api.deepseek.com/beta` | `/completions` is appended automatically; a full endpoint works too (e.g. `https://api.mistral.ai/v1/fim/completions`) |
| Completion model | `deepseek-flash` | That endpoint accepts only `deepseek-flash` and `deepseek-v4-pro`; both support FIM |
| Completion API key | empty | A secret field: not shown, not echoed. Filling it in makes it the highest-priority credential |
| Auto-save edits | off | Once on, saves 900 ms after typing stops |

The top of the settings page carries a **Current completion path** block showing which endpoint the request will actually reach, with which model, on which credential — so you do not have to guess why nothing completes.

### Credential precedence

Tried in order, first available wins; **if none is available there is no error, just no ghost text**:

1. **The API key entered in settings** → sent as `Authorization: Bearer <key>`
2. **The entry named `DEEPSEEK_API_KEY` in DSH's credential store** (the `refs` of `$DSH_HOME/.credentials.yaml`; an environment variable of the same name counts too) → also `Bearer`. When you hand this out, **anyone who already configured that key on their own machine never has to touch the settings page**.
3. **The DSH account's credential grant** (`records.deepseek-account-platform/*`) → sends **no `Authorization`**, sending DSH's private `x-dsh-auth-token` header instead. It is only issued when the target address's **origin** belongs to an inference source that account service trusts (by default `https://api.deepseek.com`).

The API key is stored through the Host settings service, marked as a secret field, and never echoed back. Leaving the key input empty keeps the existing key.

### Silent on failure

An invalid endpoint, no credential found, an upstream refusal (401/403/5xx), a network timeout — none of these **raise anything**: the Host half records a `logger.warn` (naming the endpoint, model and credential source) and answers the editor with **an ordinary 200 whose `text` is empty**, so the editor shows no ghost text and no error. Only a malformed request body — that is, a fault in our own client half — returns 400.

The editor's status line writes one line of outcome: `AI 补全生成中…` / `Tab 接受 AI 建议` / `AI 未返回补全` / `AI 补全已取消`, so you can tell on the spot whether the path was exercised at all.

So when completion does not work at all, read the **DSH host log** for `code-workbench: completion skipped — …` (that line carries the endpoint, model and credential source). The status line only tells you what the local side believes happened.

## What it does

| Capability | Implementation | Mechanism |
|---|---|---|
| Editor | **Monaco inlined** (~5.13 MiB bundle, lazily loaded) | `monaco-editor` bundled in (the browser's module table is frozen and carries no Monaco, so inlining is the only option) |
| Worker | `editor.worker` embedded as a Blob URL | `self.MonacoEnvironment.getWorker`, no CSP interception |
| File tree | Recursive, lazily expanded; a row's type glyph comes from **DSH's own UI library** — the same component the official workspace-files tree renders | `ctx.remote.workspaceFiles.list` (the official read-only Remote); the glyph is `FileTypeIcon` + `classifyFileType` from `@deepseek-ai/dsh-client-ui-primitives`, an **implicit baseline module**: reached only through the loader's `require`, never listed as a dependency and never in `dsh.client.external` |
| Reading files | Paged read of the whole file, language picked by extension | `ctx.remote.workspaceFiles.read` (paged by line, terminated by `eof`) |
| **Non-text handoff** | Clicking a PDF / Excel / Word / PPT / image builds no model and opens no tab of ours — it opens in the right sidebar's document preview instead | Official `fileAddressFor` (`@deepseek-ai/dsh-util-workspace-path`) plus `ctx.sidebarRight.openResource`, landing on the official `dsh-resource://file/**` preview slot; this plugin's tab type registers no pattern, so it never takes the official fallback |
| **Writing files** | `POST /api/code-workbench/write`, **version-guarded** (`FS_STALE_VERSION` refuses to overwrite a concurrent edit), sandbox policy = the session's standard policy | Host half `ctx.connection.fetch.register` (the same channel as the official `/api/file`) → `ctx.fs.writeText(target, text, intent, signal, sandboxPolicy)` |
| **Workspace search** | The left rail's *Search* view: regex and case options, a result list, click to jump to the line and flash it | `POST /api/code-workbench/search`: a bounded walk over `ctx.fs` (ignoring `node_modules` and binary extensions) plus line matching, under three budgets — files, matches, time |
| **@codebase (agent tool)** | The agent in the conversation gains a `codebase_search` tool: natural-language multi-word **ranked** retrieval returning top snippets (complementing the official `grep`'s exact regexes) | `ctx.tools.register` (the official Tool Runtime) plus the same search core (terms mode, word-coverage ranking) |
| **Tab completion** | 180 ms after typing stops, a grey ghost suggestion; **Tab accepts**, typing on cancels; at most one request at a time | Monaco's `registerInlineCompletionsProvider` (ghost rendering and acceptance are built in) plus `POST /api/code-workbench/complete` (**pure FIM, non-streaming** `prompt`/`suffix`, a 128-token budget, three credential fallbacks, a hard 10 s timeout, silent on failure) and `POST /api/code-workbench/completion-status` (read-only, reporting the actual path) |
| **Checkpoints / rollback** | Every save is journalled; the left rail's *History* lists checkpoints and **rolls back** to before any of them in one click; a rollback is itself a checkpoint, so it can be rolled back too | `POST /api/code-workbench/history` / `rollback` (an in-memory host journal, 20 entries per file, 200 KB per side) plus the `ctx.fs.writeText` version guard |
| **Check for updates / one-click upgrade** | When a release exists a bar appears at the top of the panel; *Upgrade* replaces the files in the install directory in place. Touching only files that **do not take part in boot-time loading** (`client.js`, plus the `src/*` build inputs, `build.mjs`, the README) needs **no restart** — `client.js` is reloaded by HMR itself; touching a file the Host half loaded at boot (`index.js` and its imports) raises "takes effect after restarting DSH" | `POST /api/code-workbench/update-check` (`api.github.com` REST: `/tags` → that tag's `update.json` → a per-file digest comparison against the local install) and `POST /api/code-workbench/update-apply` (each file verified against its manifest digest, then replaced with an atomic `rename`) |
| **Reload on external change** | The agent or anything else edits a file on disk → a clean buffer **refreshes itself**; with unsaved edits it warns instead of overwriting | The official `workspaceFiles.changes` stream (`ctx.remote.$stream`), subscribed per open file |
| **Add to Chat** | Select lines in the right sidebar → `Ctrl+L`, the sidebar button, or the editor's context menu *Add to Chat* → a **reference chip** appears in the main composer (showing only `file:line · N lines`) and **expands on send** into the full code block for the agent | The official chip mechanism: a `slash/input-insert-reference` event inserting a `ReferenceChipNode`, plus a self-registered reference codec (the `codec.serialize` of `inputTriggers.registerSource` does the expansion on submit). All three entry points go through the **same** `addToChat`, so they produce the same chip. The context-menu item is registered by `editor.addAction` after the cut/copy/paste group, with **no `keybinding`** (`Ctrl+L` is already registered by `addCommand`, and registering the same chord twice is silent) and **no `precondition`** (a context key this build does not define is permanently false, which would grey the item out forever and look broken) |
| **Selection capsule** | Selecting code floats an **Add to Chat, Ctrl+L** capsule near the selection; one click adds it to the conversation. It goes away with the selection, and yields while ghost text is showing | A Monaco **content widget** (`editor.addContentWidget`): the capsule supplies a line/column anchor and Monaco turns it into pixels. The anchor search (pick the longest line inside a ±2-line window; cost = distance from a 5-character line + 25 × line offset), except that the **preference is always `EXACT`** and the vertical offset comes from the plugin's own `transform` — Monaco's `ABOVE`/`BELOW` clamp against the **whole window**, and this editor occupies one column of the sidebar |
| **Drag a row into the composer** | A tree row (file or directory) dragged into the main composer drops a reference chip; **on send it expands into the shared `@path` mention** (directories with a trailing slash, spaces via `@"…"`), and the transcript decorates it back into the same chip | A private MIME, narrowed three ways, takes over the drop during the document capture phase → the same official `slash/input-insert-reference` channel; the expansion on submit runs through the same reference codec (its `clipboardText` is word-for-word the expansion text) |
| **Drag a tab** | Tabs are draggable too: into the main composer gives **exactly the same reference chip** as a tree row; sideways within the strip **reorders** them, with an insertion marker on the edge the drop would land against | The same private MIME and the same official channel, so a chip has exactly one origin; reordering is routed by each tab's own drag ref — **neither gesture claims the other** (a tree row dragged over the strip does not reorder it, a tab dropped on a folder row does not move a file) |
| **Click empty space to deselect** | A left-click on empty tree space clears the selection; the create button returns to creating at the workspace root | The tree container's `onClick`, excluding clicks that land on a row, a control inside one, or the toolbar via `closest('.code-workbench-tree-row, button, input, .code-workbench-tree-toolbar')`: a row click bubbles to the container anyway, and the toolbar is right-aligned, so **the next action after selecting a directory is the trip up-right to *New file*, where a glancing click lands on the toolbar's empty space** — without this guard the two gestures collapse into one and a near-miss quietly resets the target to the root. Clearing `selected` also clears the Shift multi-select set and its anchor |
| **The tree marks the selection only** | In the tree, only the **selection** (where the create button lands, what the context menu and a drag act on) gets a fill and a hairline frame; **the file you have open gets no marker at all** | One click **both** opens a file and selects it, so two states sit on one row: any marker given to it reads as *part of the selection marker* — two identically drawn boxes are a box that will not clear, and a bar on top of that is one more thing. Which file is open is answered by the tab strip (exactly one active tab); the tree does not answer a second time. `:hover` stays — that is the pointer's own transient feedback and hangs off no state |
| Traceability | Every save records a session remark | `sessionFeedback.record` |
| Theme | Follows DSH's light/dark theme | `body[data-ds-dark-theme]` MutationObserver → `monaco.editor.setTheme`; the palette comes from `--dsw-alias-*` but is **normalised to `#RRGGBB[AA]` before Monaco sees it** — its theme parser reads hex spellings only, and a value it cannot read is not rejected but silently painted as solid `#ff0000` |
| Shortcuts / editor context menu | `Ctrl+S` saves, `Ctrl+L` adds the selection to the conversation, `Tab` accepts a completion (inside the editor); the editor's context menu carries one more item, *Add to Chat* | `editor.addCommand` for shortcuts, `editor.addAction` for the menu item, registered after the cut/copy/paste group |

## Anatomy and implementation

The plugin is **two halves**, loaded separately by DSH:

| Half | Source → artifact | Responsibility |
|---|---|---|
| Host | [`index.ts`](dsh-code-workbench/index.ts) → `index.js` | Version-guarded writes, file operations, search, Tab completion, checkpoints and rollback, update check and upgrade, and the `codebase_search` tool |
| Client | [`src/client.ts`](dsh-code-workbench/src/client.ts) → `client.js` | The right-sidebar `code-workbench` tab: file tree + Monaco + Tab completion + code references |

**Why the client half must inline Monaco.** DSH's client module runtime loads each plugin as one self-contained script, and the factory may only `require` the baseline module table (`react` and friends) — Monaco is not in it. So `client.js` is a single file bundling Monaco, its worker and all the CSS (~5.13 MiB, lazily loaded): the worker becomes an injected Blob URL, the CSS an injected `<style>`. That contract is a hard constraint, not a trade-off.

**Why the Host half is not bundled.** The installed `index.js` is the only thing a person can read when debugging one, so it is transpiled file-by-file by `tsc` and **keeps every comment**, rather than being handed to esbuild (which strips them all). A type error fails the build outright and never reaches the artifact.

**Source and artifact share a name and a directory.** `index.ts` → `index.js`, `src/client.ts` → `client.js` — the source sits beside what it produces. A few sources carry `.mts` extensions, because `index.ts` has to write `./completion-api.mjs` verbatim — that is the **artifact's** real name — and in TypeScript's extension-substitution rules `.mjs` maps only to `.mts`.

**The SDK's types are hand-written.** Every package of the DSH client SDK declares a `types` path in its `package.json`, and **the package does not contain those files**. So `types/` holds declarations for the part of the SDK this plugin actually calls, deliberately narrow: covering the whole SDK would only produce a second, unverifiable copy of it.

## Known limitations

- File sync uses the official changes stream, plus a version check on open files every 1.5 seconds and on window refocus; clean buffers re-read themselves, unsaved edits are kept.
- A newly sent code reference is collapsed to file and line numbers in the transcript and expands on click; the model still receives the whole selection. Plain code blocks sent earlier carry no reference marker and keep their original presentation.
- A path reference (the context menu's *Add path reference*, or dragging a tree row) appears in the transcript as the same chip the composer shows, and clicking it previews in the right sidebar — because what was submitted is the official `@path` mention, and the official projection decorates that text back into a chip. Directory chips are display-only: the official projection only wires navigation for files.
- Non-text files (PDF, xlsx/xls/csv/tsv, doc/docx/ppt/pptx, images) are not rendered in this panel: the workbench **hands their address** to the right sidebar's official document preview, so their tabs never appear inside Code Workbench. The handoff is decided by the error code of a failed read (`workspace-file/not-text` / `too-large`), **not by a list of extensions** — which extensions can be rendered belongs to the official preview's own registry, and this plugin does not keep a second copy of it. If no preview implementation is registered that will claim the address (`openResource` throws), the workbench keeps its own message naming where to look, and never reports a file it did not open.
- The update check reads `api.github.com` REST (`/tags`, `/contents`, `/git/blobs`) rather than the raw content domain, which is unreachable on some networks. The repository has no Release objects, so the version comes from the **tag list**: the plugin sorts it by semver itself (`/tags` promises no order) and takes the highest tag that carries an `update.json`, which is why tags published before this feature are skipped one by one instead of failing the whole check. GitHub unreachable, no manifest in the repository, already up to date — all three have one answer for the panel: show nothing. **A copy installed from npm still checks for updates through the GitHub tag**, because the manifest ships with the repository.
- Upgrading writes **only this package's own install directory** and never touches the workspace. A manifest carrying an absolute path, a `.`/`..` segment, a backslash or an empty segment is refused outright; the limits are 64 files, 32 MiB per file, 256 KiB of manifest.
- Replacement is a **per-file** `rename`: one file failing does not affect the ones already landed, and what a failure leaves behind is a tree that is individually valid but mixed in version, never a corrupted file. Verification uses the digests the publisher put in the manifest (a `rename` rather than a direct write, because every file in an installed tree is a pnpm hard link into the content store, and writing through would change the copy other profiles share).
- ⚠️ If an update says "takes effect after restarting DSH" and the user closes the panel without restarting, it will **not** say so again — `installedVersion()` reads the `package.json` on disk, which is already the new version by then. That is deliberate (the version on disk *is* the installed version; no false "there is always an update" signal), and the cost is that this one reminder is one-shot. The next DSH launch makes the new version fully effective.
- The no-restart decision looks only at whether `client.js` / `package.json` are among the changes; touching any file the Host half loaded at boot (`index.js`, `completion-api.mjs`, `vendor/schemastery.mjs`, `src/completion-window.mjs`, `cordis.patch.yml`) prompts for a restart — that code is already loaded into the process, and replacing the file is not enough to make it take effect.
- The two drag gestures share one private MIME and are routed by each side's own drag ref, so **neither works across the other**: dropping a tab on a tree folder row does not move a file, and dragging a tree row over the tab strip does not reorder it. To move a file, use an in-tree drag or cut/paste; to reorder, drag within the strip.
- The tree's *selection* and the editor's *current file* are two different things: clearing the selection closes no tab, and opening a file **from the tab strip** does not change the tree's selection. But **clicking a row in the tree does select that row** (the create button's target always follows the selection), so after opening a file that row wears the **selection** marker, not a "current file" marker. The tree draws nothing for the file you have open. A selected directory is not expanded automatically.
- Tab completion uses a 180 ms request debounce, a small context window (3200 characters of prefix, 900 of suffix) and a 128-token budget, and caches the last 40 caret contexts. ⚠️ **Network jitter on this machine measures ±300 ms, larger than most of the parameter effects** — any "this made it faster" claim needs several rounds of sampling; a single measurement means nothing.
- The third credential tier (the DSH account grant) is **verified against the real `/beta/completions` endpoint** (HTTP 200, using the private `x-dsh-auth-token` header and no `Authorization`). Note that it is only issued when the **origin** belongs to an inference source that account service trusts.
- The bundle is 5.13 MiB (the minified Monaco core plus 28 common grammars and the JSON language service); it is parsed the first time the panel opens (lazily loaded).
- TS/JS semantic intelligence is not enabled (the 12 MB TypeScript language service was dropped): TS/JS get syntax highlighting and the editor's full feature set, but no semantic diagnostics or go-to-definition; completion is word-level plus AI ghost text.
- Reading a single file is bounded by the official `workspaceFiles` limits (2 MiB, 5000 lines per page, at most 40 pages by default).
- The checkpoint journal lives in host memory (20 entries per file): it is empty again after a DSH restart.
- "Semantic search" is lexical retrieval ranked by word coverage (the DeepSeek API has no embeddings endpoint, so vector semantics is not available).
