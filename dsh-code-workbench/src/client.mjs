/**
 * dsh-code-workbench — client half source (bundled by build.mjs into client.js).
 *
 * A right-sidebar tab type ("code-workbench") that renders a VS Code-style code
 * workspace: recursive file tree + Monaco (the VS Code editor core) with full
 * editing, syntax highlighting, multi-selection, find, and undo.
 *
 * Mechanisms composed (nothing private):
 *  - listing / reading  → `ctx.remote.workspaceFiles` (`list`, `read`, `stat`)
 *  - the workspace root → standard `useSessions` prop (`byId[sessionId].cwd`)
 *  - writing            → the package's own host half, `POST /api/code-workbench/write`,
 *                         version-guarded via `ctx.fs.writeText` on the Host
 *                         (implemented in index.js; the only mutation path)
 *  - non-text files     → the OFFICIAL document preview, through
 *                         `ctx.sidebarRight.openResource(fileAddressFor(…))`; this tab
 *                         type registers no `pattern`, so it never shadows that
 *                         `dsh-resource://file/**` fallback (see `openInDocumentPreview`)
 *
 * The bundle contract: exports { inject, apply, name }; `require` is limited to
 * the frozen browser module table (`react`). Monaco is inlined at build time.
 */

import React from 'react'
import { fileAddressFor } from '@deepseek-ai/dsh-util-workspace-path'
import './workbench.css'
import { serializeSnippet, splitSnippets } from './snippets.mjs'
import { COMPLETION_PREFIX_CHARS, COMPLETION_SUFFIX_CHARS } from './completion-window.mjs'

const { useCallback, useEffect, useMemo, useRef, useState } = React
const h = React.createElement
const SETTINGS_NS = 'code-workbench'
const defaultSettings = { autoSave: false, completionEnabled: true, completionBaseUrl: 'https://api.deepseek.com/beta', completionApiModel: 'deepseek-flash' }
function usePluginSettings(form) {
  const [snapshot, setSnapshot] = useState(() => form?.getSnapshot?.() ?? { value: defaultSettings, writable: false })
  useEffect(() => {
    const refresh = () => setSnapshot(form?.getSnapshot?.() ?? { value: defaultSettings, writable: false })
    refresh()
    return form?.subscribe?.(refresh)
  }, [form])
  return snapshot
}

// Monaco (inlined, slimmed) initializes lazily: the factory stays cheap for the
// module runtime and the contract harness, and the GUI only pays the parse cost
// when the panel is first opened. The test override lets the render smoke suite
// substitute a fake namespace without touching the production path.
let monacoPromise = null
const completionCache = new Map()
function loadMonaco() {
  if (monacoPromise === null) {
    monacoPromise = globalThis.__CODE_WORKBENCH_TEST_MONACO__ !== undefined
      ? Promise.resolve(globalThis.__CODE_WORKBENCH_TEST_MONACO__)
      : import('./monaco-entry.mjs')
  }
  return monacoPromise
}

/** This plugin's identity in the tab system; also the body's slot key. */
const TAB_ID = 'dsh-code-workbench'
/** The page kind users open. */
const TAB_KIND = 'code-workbench'
/** Tab chip and guide-capsule label. */
const TAB_LABEL = '代码工作台'
/** Guide-capsule description. */
const TAB_DESCRIPTION = '编辑工作区代码，使用 AI 补全，将选中代码加入对话'

/**
 * The read failures that mean "this is not text this panel can page through",
 * and therefore the only two that hand a file to the official preview.
 *
 * Decided on the error CODE, never on message text, and never on a suffix list.
 * A suffix list would be a second copy of a rule the Host already owns — the
 * text channel is the only thing that actually knows whether a file is text —
 * and it would have to track the official preview's own registry to stay right
 * about which suffixes it can render. The code is exact: `not-text` is invalid
 * UTF-8 or a NUL byte, `too-large` is the page cap.
 */
const NON_TEXT_CODES = new Set(['workspace-file/not-text', 'workspace-file/too-large'])
/** Status after a non-text file was handed to the official document preview. */
const NON_TEXT_HANDOFF_STATUS = '此文件不是文本，已在右栏「文档预览」中打开'
/** Status suffix for a non-text file when no preview claimed it, so nothing can show it. */
const NON_TEXT_NO_PREVIEW_SUFFIX = '（此类文件需在右栏「文档预览」中打开）'

/**
 * The private drag flavor for tree rows.
 *
 * Deliberately NOT `text/uri-list` and NOT a `Files` payload: DSH's own
 * document-level drop pipeline (`dsh-client-ui-attachment`
 * `installDocumentDropEvents`) accepts a drop only when
 * `dataTransfer.types.includes("Files")`, so a distinct flavor guarantees the
 * two never fight over the same gesture. The payload is the row's workspace
 * relative path, with a leading `d`/`f` marking directory vs file.
 */
const TREE_DRAG_MIME = 'application/x-code-workbench-tree'

/** Workspace-relative path for an absolute tree path. */
function relativeToCwd(path, cwd) {
  if (typeof path !== 'string' || path === '') return ''
  return path.startsWith(cwd) ? path.slice(cwd.length).replace(/^[\\/]+/, '') : path
}

/**
 * The `@path` mention a workspace-path chip becomes, in the spelling the shared
 * reference grammar defines (`@deepseek-ai/dsh-file-reference`): a trailing
 * slash marks a directory, and whitespace switches to the quoted `@"…"` form.
 *
 * Spelling it once, for both the chip's clipboard text and its submit-time
 * expansion, keeps the logged message identical to what the composer showed —
 * which matters because the transcript decorates that same text back into a
 * chip, and because the committed-draft suffix rule compares the two verbatim.
 *
 * The leading space is deliberate. The grammar only opens a mention at the start
 * of the text or after whitespace, while a dragged chip lands wherever the caret
 * happens to be and the official insert path guarantees only a *trailing* space
 * (`insertReference`); opening the token here is what keeps a row dropped after
 * a typed word a mention instead of a dead `word@path` run.
 *
 * @param path - workspace-relative path.
 * @param directory - whether the path names a directory.
 * @returns the mention, or the bare path when the grammar cannot represent it.
 */
function referenceMention(path, directory) {
  const raw = typeof path === 'string' ? path : ''
  const spelled = directory === true ? `${raw}/` : raw
  // Control characters and an embedded quote have no quoted spelling; a bare
  // path still reads correctly to the model and simply is not a chip.
  if (/[\u0000-\u001f\u007f-\u009f"]/u.test(spelled)) return spelled
  return ` ${/\s/u.test(spelled) ? `@"${spelled}"` : `@${spelled}`}`
}

/**
 * Hand a file this panel cannot show to the official document preview.
 *
 * The panel only ever renders UTF-8 text in Monaco, so a PDF, a spreadsheet or
 * an Office container is a dead end here — but not in the product. DSH ships a
 * right-sidebar preview that renders exactly those (PDF; xlsx/xls/csv/tsv;
 * doc/docx/ppt/pptx through the Host conversion service; images; HTML), and this
 * tab type registers no `pattern`, so it never shadows that
 * `dsh-resource://file/**` fallback. Addressing the file and opening it is the
 * official way to reach it — the same `fileAddressFor` + `openResource` pair the
 * official file tree uses — so nothing here is a private channel.
 *
 * `openResource` throws when no registered type claims the address (a build
 * without the preview package) and the panel must not pretend it opened
 * something it did not: the boolean is the caller's licence to report success.
 *
 * @param sidebarRight - the right-sidebar navigation controller, or undefined.
 * @param sessionId - the Session that authorizes the read.
 * @param cwd - the Session workspace root, so a native absolute path relativizes.
 * @param path - the file to preview.
 * @returns true when the official preview took the file.
 */
function openInDocumentPreview(sidebarRight, sessionId, cwd, path) {
  if (typeof sidebarRight?.openResource !== 'function') return false
  try {
    sidebarRight.openResource(fileAddressFor(sessionId, cwd, path))
    return true
  } catch {
    return false
  }
}

/**
 * Open the official terminal in the right panel.
 *
 * `openTab` is the navigation controller's own entry point and it expands the
 * panel by itself; `ctx.layout.openRightbar` only reports geometry and would
 * leave the panel closed. The kind is `'terminal'` — the *package* is
 * `dsh-client-ui-sidebar-terminal`, and that is not the string to pass here. An
 * unregistered kind throws, hence the try/catch and the boolean answer.
 *
 * What opens is the official terminal tab: its shell, its working directory (the
 * session workspace) and its PTY all belong to that package. So this opens a
 * terminal and deliberately does not run anything — a command for the clicked
 * row would need the terminal's undocumented client service.
 *
 * @param sidebarRight - the right-sidebar navigation controller, or undefined.
 * @returns true when the panel was asked for a terminal.
 */
function openWorkspaceTerminal(sidebarRight) {
  if (typeof sidebarRight?.openTab !== 'function') return false
  try {
    sidebarRight.openTab('terminal')
    return true
  } catch {
    return false
  }
}

/** The drag payload for one tree row. */
function treeDragPayload(path, cwd, isDir) {
  return `${isDir ? 'd' : 'f'}${relativeToCwd(path, cwd) || '.'}`
}

/** Decode a {@link TREE_DRAG_MIME} payload back into a reference's `ref`. */
function parseTreeDragPayload(raw) {
  if (typeof raw !== 'string' || raw.length < 2) return null
  const kind = raw[0]
  if (kind !== 'd' && kind !== 'f') return null
  const path = raw.slice(1)
  if (path === '') return null
  return { path, directory: kind === 'd' }
}

/** Whether a path is the given directory or sits inside it. */
function isAtOrUnder(path, directory) {
  return path === directory || path.startsWith(`${directory}/`) || path.startsWith(`${directory}\\`)
}

/**
 * Point the open tabs at a moved or renamed path, keeping subtrees together.
 *
 * The deduplication is the point, not an optimisation. `from` and `to` can both
 * already be open — a tab outlives the file it points at, so a name that is free
 * on disk can still be taken in the tab strip — and a plain rewrite then leaves
 * two tabs on one path. React reports that only as a duplicate-key warning in
 * the console, and the person sees two tabs where closing either one leaves the
 * other behind. The first occurrence keeps its position, so the tab that was
 * already open does not jump.
 * @param paths - the open tab paths, in strip order.
 * @param from - the path being moved.
 * @param to - where it lands.
 * @returns the rewritten paths, without duplicates.
 */
function rewriteOpenPaths(paths, from, to) {
  return [...new Set(paths.map((path) => isAtOrUnder(path, from) ? to + path.slice(from.length) : path))]
}

/** Theme-token vocabulary: the only shared styling dependency. */
const T = {
  bg: 'var(--dsw-alias-bg-base)',
  bgRaised: 'var(--dsw-alias-bg-layer-1)',
  bgHover: 'var(--dsw-alias-interactive-bg-hover)',
  border: 'var(--dsw-alias-border-l2)',
  fg: 'var(--dsw-alias-label-primary)',
  fgMuted: 'var(--dsw-alias-label-secondary)',
  accent: 'var(--dsw-alias-brand-primary)',
  danger: 'var(--dsw-alias-state-error-primary, #e5484d)',
}

// ---------------------------------------------------------------------------
// Monaco plumbing
// ---------------------------------------------------------------------------

/** extension → monaco language id, derived once from the loaded grammars. */
let EXT_TO_LANG = null
function languageForPath(monaco, path) {
  if (EXT_TO_LANG === null) {
    EXT_TO_LANG = new Map()
    for (const lang of monaco.languages.getLanguages()) {
      for (const ext of lang.extensions ?? []) EXT_TO_LANG.set(ext.toLowerCase(), lang.id)
    }
    const fileToLang = new Map()
    for (const lang of monaco.languages.getLanguages()) {
      for (const name of lang.filenames ?? []) fileToLang.set(name.toLowerCase(), lang.id)
    }
    EXT_TO_LANG.fileToLang = fileToLang
  }
  const base = path.split(/[\\/]/).pop().toLowerCase()
  const byName = EXT_TO_LANG.fileToLang.get(base)
  if (byName !== undefined) return byName
  const dot = base.lastIndexOf('.')
  if (dot < 0) return 'plaintext'
  return EXT_TO_LANG.get(base.slice(dot)) ?? 'plaintext'
}

/** Follow the shell theme: `vs-dark` on dark, `vs` on light. */
function monacoTheme() {
  return document.body.hasAttribute('data-ds-dark-theme') ? 'vs-dark' : 'vs'
}

// ---------------------------------------------------------------------------
// Host endpoints and Tab-completion streaming
// ---------------------------------------------------------------------------

/** The host half's codebase search endpoint. */
const SEARCH_PATH = '/api/code-workbench/search'
/** The host half's Tab-completion endpoint (ghost text at the caret). */
const COMPLETE_PATH = '/api/code-workbench/complete'
/** Host route reporting which credential a completion would use (values never leave the Host). */
const COMPLETION_STATUS_PATH = '/api/code-workbench/completion-status'
/** Host route answering this installation's own version and repository (the About panel). */
const ABOUT_PATH = '/api/code-workbench/about'
/** How each credential source is described to the person configuring the plugin. */
const CREDENTIAL_SOURCE_LABELS = {
  manual: '设置页填写的 API Key',
  store: 'DSH 凭据库 · DEEPSEEK_API_KEY',
  account: 'DSH 登录账号',
  none: '未找到可用凭据',
}
/** The save journal endpoints (checkpoints: list and roll back saves). */
const HISTORY_PATH = '/api/code-workbench/history'
const ROLLBACK_PATH = '/api/code-workbench/rollback'
/** The update endpoints: is a newer release published, and install it. */
const UPDATE_CHECK_PATH = '/api/code-workbench/update-check'
const UPDATE_APPLY_PATH = '/api/code-workbench/update-apply'

/**
 * How often the version fallback ticks. The tick is local and free; what costs
 * anything is the `stat` it issues, and that is what the rule below throttles.
 */
const POLL_INTERVAL_MS = 1500
/**
 * While the official change stream is delivering, the fallback is only a net
 * under the case where it stays open but silent — the one failure that leaves no
 * trace, since an error would put the fallback back on its own. So it is allowed
 * one `stat` per this long (measured from the moment the stream reported ready)
 * instead of one per tick. Throttling the request and not the timer is
 * deliberate: the moment the stream stops, the very next tick is a real `stat`,
 * so recovery does not have to wait out a long interval.
 */
const POLL_NET_MS = 15000

/**
 * Ask the Host for one Tab completion.
 *
 * One request, one response — nothing is streamed. Ghost text is only ever
 * shown as a finished suggestion, so progressive rendering would buy nothing;
 * the wait is dominated by the provider's time-to-first-token, which no client
 * change can shorten.
 *
 * A configuration problem answers `{ok:true,text:''}` rather than an error, so
 * the empty string here is the normal "nothing to suggest" case and not a
 * failure. Only a malformed request or a transport problem throws.
 * @param body - the framed caret-context request.
 * @param signal - cancellation when typing invalidates the suggestion.
 * @returns the completion text, possibly empty.
 */
async function streamCompletion(body, signal) {
  const response = await fetch(COMPLETE_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  const payload = await response.json().catch(() => undefined)
  if (!response.ok || payload === undefined) {
    throw new Error(payload?.error?.message ?? payload?.error?.code ?? `HTTP ${response.status}`)
  }
  return typeof payload.text === 'string' ? payload.text : ''
}

/** Models occasionally fence despite instructions; strip one wrapping fence. */
function stripFences(text, preserveWhitespace = false) {
  if (preserveWhitespace && !text.trimStart().startsWith('```')) return text
  let t = text.trim()
  if (t.startsWith('```')) {
    const firstNl = t.indexOf('\n')
    if (firstNl >= 0) t = t.slice(firstNl + 1)
    const lastFence = t.lastIndexOf('```')
    if (lastFence >= 0 && t.slice(lastFence).trim() === '```') t = t.slice(0, lastFence)
  }
  return t
}

/**
 * Format an expanded chat chip as model context: the file:line anchor line,
 * then the code in one fence.
 * @param anchor - `path:start` or `path:start-end` (workspace-relative).
 * @param range - `{ language, code }`.
 * @returns the text spliced into the prompt at submit time.
 */
function formatSnippet(anchor, range) {
  return serializeSnippet(anchor, range.language, range.code)
}

// ---------------------------------------------------------------------------
// Small UI atoms (no external UI imports; theme tokens only)
// ---------------------------------------------------------------------------

const rowStyle = (depth) => ({
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  padding: `3px 8px 3px ${8 + depth * 12}px`,
  // Reserved for future drag-to-move; see the tree's drag source below.
  cursor: 'default',
  color: T.fg,
  fontSize: '12.5px',
  lineHeight: '18px',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
})

/** The indent step, in px, shared by `rowStyle`'s padding and the guide rails. */
const INDENT = 12
/** Left padding of a row before its depth indentation, mirroring `rowStyle`. */
const ROW_PADDING = 8

/**
 * The indent rails that draw a row's ancestry.
 *
 * There is one rail per depth level to the row's left. A rail is a 1px column
 * painted at the horizontal centre of the level it belongs to, which is where a
 * VS Code-style guide sits. Rails are always laid out — they occupy real space so
 * indentation is stable — but only the ones whose `data-on` is true are painted,
 * which is what lets the tree show either the whole hierarchy (while the pointer
 * is over the rows) or just the selected row's ancestry (once it leaves).
 *
 * @param depth - the row's depth; a root row (0) has no rails.
 * @param onCount - how many rails, counting from the innermost, should paint.
 * @returns an array of rail spans, outermost first.
 */
const guideRails = (depth, onCount) => {
  const rails = []
  for (let level = 0; level < depth; level++) {
    // The innermost rail is `depth - 1`; a rail counts as on when it is within
    // `onCount` of the innermost one.
    const on = level >= depth - onCount
    rails.push(h('span', {
      key: `rail-${level}`,
      className: 'code-workbench-tree-rail',
      'data-on': on ? 'true' : 'false',
      style: { left: `${ROW_PADDING + level * INDENT + INDENT / 2}px` },
    }))
  }
  return rails
}

function icon(kind) {
  return kind === 'directory' ? '▸' : '·'
}

// ---------------------------------------------------------------------------
// File tree (lazy, recursive)
// ---------------------------------------------------------------------------

function workbenchIcon(name) {
  const paths = {
    files: 'M8 3h10v14H8z M5 7H3v14h11v-2',
    search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14 M16 16l5 5',
    history: 'M3 10a9 9 0 1 1 1 7 M3 4v6h6 M12 7v5l3 2',
    createFile: 'M14 3H5v18h8 M14 3v6h6 M14 3l6 6 M18 14v8 M14 18h8',
    createDirectory: 'M13 19H3V5h7l2 3h9v5 M18 14v8 M14 18h8',
    refresh: 'M20 7a9 9 0 1 0 1 8 M20 3v5h-5',
    collapse: 'M8 3h13v13 M3 8h13v13H3z M6 14h7',
  }
  return h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, h('path', { d: paths[name] }))
}

function FileTree({ list, cwd, activePath, onOpen, joinPath, onAction, refreshRevision, clipboard, closeMenuSignal, onMenuOpen }) {
  const [expanded, setExpanded] = useState(() => new Set([cwd]))
  const [children, setChildren] = useState({}) // dir path -> entries | 'loading' | error string
  const [menu, setMenu] = useState(null)
  /**
   * The row the toolbar's create actions target.
   *
   * Distinct from `activePath`, which tracks the file a tab has open — a
   * directory can be selected but never active. Kept as `{path, isDir}` so the
   * target rule matches the context menu exactly: a directory creates inside
   * itself, a file creates alongside it.
   */
  const [selected, setSelected] = useState(null)
  /**
   * The extra rows a modifier-click has added to the selection.
   *
   * The tree's primary selection stays in `selected` so every existing caller —
   * the toolbar's create target, the keyboard cursor, the context menu — keeps
   * working unchanged. This set only ever holds the *additional* rows, so a
   * plain click (which clears it) restores single-selection semantics exactly.
   * Entries are `{path, isDir}` keyed by `path:isDir`, matching `selectedKey`.
   */
  const [extraSelection, setExtraSelection] = useState(() => new Set())
  /** Where a Shift range starts from; see `selectRow`. */
  const selectionAnchorRef = useRef(null)
  /**
   * Whether the pointer is currently over the row list.
   *
   * The indentation rails show either the whole hierarchy (pointer inside) or
   * just the selected row's ancestry (pointer outside), so the tree needs to
   * know which side of that line it is on. Tracked with React state rather than
   * CSS `:hover` because the choice affects *sibling* rows: a rail on the
   * selected row must stay painted while the pointer sits over a different row.
   */
  const [pointerInTree, setPointerInTree] = useState(false)
  /** The folder a drag is currently hovering, so its row can show a drop hint. */
  const [dropTarget, setDropTarget] = useState(null)
  /**
   * The in-flight drag, or null.
   *
   * `dataTransfer` is not readable during `dragover` for security, so the tree
   * remembers what it is dragging in a ref. `path` drives the "cannot drop into
   * yourself" check and `sources` is what a drop actually moves.
   */
  const dragRef = useRef(null)
  /** The scrolling row list, so a refresh can hold the user's place. */
  const scrollerRef = useRef(null)
  /**
   * An in-tree name field, in place of a modal dialog.
   *
   * VS Code creates and renames *inside the tree*: the row itself becomes a
   * text field, so the new name appears where it will live and the surrounding
   * files stay visible for reference. Shape:
   * `{ mode: 'createFile'|'createDirectory', parent } | { mode: 'rename', path, isDir } | null`.
   * Indentation is derived when the tree renders, not stored here.
   */
  const [editor, setEditor] = useState(null)
  const [editorValue, setEditorValue] = useState('')
  /** Set when a commit fails, so the field stays open and explains itself. */
  const [editorError, setEditorError] = useState(null)
  const editorInputRef = useRef(null)
  /** Guards against onBlur firing a second commit after Enter already did. */
  const editorSettledRef = useRef(false)
  useEffect(() => {
    const close = () => setMenu(null)
    const keydown = (event) => { if (event.key === 'Escape') close() }
    document.addEventListener?.('click', close)
    document.addEventListener?.('keydown', keydown)
    return () => { document.removeEventListener?.('click', close); document.removeEventListener?.('keydown', keydown) }
  }, [])

  const load = useCallback((dir) => {
    setChildren((prev) => (prev[dir] !== undefined ? prev : { ...prev, [dir]: 'loading' }))
    list(dir).then(
      (entries) => setChildren((prev) => ({ ...prev, [dir]: entries })),
      (error) => setChildren((prev) => ({ ...prev, [dir]: `加载失败: ${error}` })),
    )
  }, [list])

  useEffect(() => { load(cwd) }, [cwd, load])
  /**
   * Reload every open directory when the revision changes.
   *
   * `expanded` is deliberately *not* reset — a refresh must not collapse a tree
   * the user opened. The scroller's offset is captured first and restored after
   * the new rows paint, so a refresh that happens to finish while the user is
   * scrolled down does not jump them back to the top.
   */
  useEffect(() => {
    const scroller = scrollerRef.current
    const offset = scroller?.scrollTop ?? 0
    for (const dir of expanded) load(dir)
    // Restore after paint, once the rebuilt list has its new height. Guarded
    // because `requestAnimationFrame` does not exist in a bare Node test host.
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => setTimeout(fn, 0)
    const cancel = typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : clearTimeout
    const frame = raf(() => { if (scroller) scroller.scrollTop = offset })
    return () => cancel(frame)
  }, [refreshRevision, list, expanded, load])
  useEffect(() => { setMenu(null) }, [closeMenuSignal])
  const contextMenu = (event, path, isDir) => {
    event.preventDefault()
    event.stopPropagation()
    onMenuOpen?.()
    setMenu({ path, isDir, element: event.currentTarget, x: Math.max(0, Math.min(event.clientX, window.innerWidth - 230)), y: Math.max(0, Math.min(event.clientY, window.innerHeight - 380)) })
  }

  /** Put DOM focus on a row and keep it inside the scroller. */
  const focusRow = (path) => {
    const node = nodesRef.current.get(path)
    if (!node) return
    node.focus?.()
    node.scrollIntoView?.({ block: 'nearest' })
  }

  /** A row's identity in the selection: the same path can never be both a file and a directory. */
  const selectedKey = (row) => `${row.path}:${row.isDir ? 'd' : 'f'}`

  /**
   * Every row currently selected, primary first.
   *
   * Consumers that act on "the selection" (delete, drag, the toolbar target)
   * read this instead of `selected`, so multi-select reaches them without each
   * call site learning about `extraSelection`.
   */
  const selectionRows = () => {
    if (selected === null) return []
    const extras = flat.filter((row) => extraSelection.has(selectedKey(row)))
    return [selected, ...extras]
  }

  /**
   * Apply a click's selection intent, honouring the platform's modifiers.
   *
   * Plain click replaces the selection, Ctrl/Cmd-click toggles one row, and
   * Shift-click takes everything between the anchor and the clicked row in
   * *visual* order — `flat` is what the user sees, so it is what a range means.
   */
  const selectRow = (row, event) => {
    const additive = event?.ctrlKey === true || event?.metaKey === true
    const range = event?.shiftKey === true
    if (range && selectionAnchorRef.current !== null) {
      const from = flat.findIndex((item) => selectedKey(item) === selectionAnchorRef.current)
      const to = flat.findIndex((item) => selectedKey(item) === selectedKey(row))
      if (from >= 0 && to >= 0) {
        const [low, high] = from <= to ? [from, to] : [to, from]
        const span = flat.slice(low, high + 1)
        setSelected(row)
        setExtraSelection(new Set(span.filter((item) => selectedKey(item) !== selectedKey(row)).map(selectedKey)))
        return
      }
    }
    if (additive) {
      setExtraSelection((prev) => {
        const next = new Set(prev)
        if (next.has(selectedKey(row))) next.delete(selectedKey(row))
        else if (selected !== null) next.add(selectedKey(row))
        return next
      })
      selectionAnchorRef.current = selectedKey(row)
      return
    }
    // A plain click always collapses back to one row, which is what keeps the
    // toolbar target and the keyboard cursor unambiguous.
    setSelected(row)
    setExtraSelection(new Set())
    selectionAnchorRef.current = selectedKey(row)
  }

  /**
   * How many rails to paint on a row, counting from the innermost outward.
   *
   * While the pointer is over the list every rail paints, which reads as the
   * full hierarchy. Once it leaves, only the primary selection's ancestry stays
   * — the row itself plus each of its ancestors — so the tree keeps showing
   * where the selection came from without the rest of the noise.
   */
  const railCountFor = (depth, isAncestorOfSelection) => {
    if (pointerInTree) return depth
    return isAncestorOfSelection ? depth : 0
  }

  /**
   * How much of a name to preselect when the field opens.
   *
   * Renaming usually means changing the stem, not the type, so the extension is
   * left out of the selection. A name with no extension is selected whole —
   * otherwise a file like `Makefile` could not be replaced by typing. Dotfiles
   * count as extension-less: `.gitignore` selects entirely rather than
   * preselecting the empty stem before the dot.
   */
  const selectableEnd = (name) => {
    const dot = name.lastIndexOf('.')
    return dot > 0 ? dot : name.length
  }
  /** Open the in-tree field for a create, anchored on the destination folder. */
  const openCreate = (action, target) => {
    const isDir = target?.isDir === true
    const parent = isDir
      ? target.path
      : target.path.slice(0, Math.max(target.path.lastIndexOf('/'), target.path.lastIndexOf('\\')))
    const folder = parent === '' ? cwd : parent
    // A new child of a collapsed folder needs the folder open to be visible —
    // the field renders inside that folder's entry list.
    if (!expanded.has(folder)) toggle(folder)
    setEditor({ mode: action, parent: folder })
    setEditorValue('')
    setEditorError(null)
    editorSettledRef.current = false
  }
  /** Open the in-tree field over an existing row to rename it. */
  const openRename = (target) => {
    setEditor({ mode: 'rename', path: target.path, isDir: target.isDir })
    setEditorValue(target.path.split(/[\\/]/).at(-1))
    setEditorError(null)
    editorSettledRef.current = false
  }
  const closeEditor = () => {
    editorSettledRef.current = true
    setEditor(null)
    setEditorValue('')
    setEditorError(null)
  }
  /**
   * Hand the typed name to the host, which owns every write. The field stays
   * open and shows the reason if the name is rejected, so a typo never costs
   * the user their input.
   */
  const commitEditor = async () => {
    if (editor === null || editorSettledRef.current) return
    const name = editorValue.trim()
    if (name === '') { closeEditor(); return }
    editorSettledRef.current = true
    const result = await onAction(editor.mode, {
      path: editor.mode === 'rename' ? editor.path : editor.parent,
      isDir: editor.mode === 'rename' ? editor.isDir : true,
      newName: name,
    })
    if (result?.ok === false) {
      // Reopen the guard so the user can correct the name and retry.
      editorSettledRef.current = false
      setEditorError(result.error ?? '操作失败')
      editorInputRef.current?.focus?.()
      return
    }
    // Unmounting the field fires `onBlur`; close the guard so that cannot start
    // a second submit for a name that is already being written.
    editorSettledRef.current = true
    setEditor(null)
    setEditorValue('')
    setEditorError(null)
  }
  // The field takes focus and preselects the stem as soon as it appears. Done
  // after paint so the node exists; `select()` on a detached input is a no-op.
  useEffect(() => {
    if (editor === null) return
    const field = editorInputRef.current
    if (!field) return
    field.focus?.()
    if (editor.mode === 'rename') {
      const end = selectableEnd(field.value ?? '')
      field.setSelectionRange?.(0, end)
    }
  }, [editor])
  const toggle = useCallback((dir) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(dir)) next.delete(dir)
      else { next.add(dir); load(dir) }
      return next
    })
  }, [load])

  /**
   * Where a toolbar create action should land, mirroring the context menu's
   * rule: a directory holds the new entry, a file shares its parent folder, and
   * with no selection the workspace root is the fallback.
   */
  const createTarget = (() => {
    if (selected === null) return { path: cwd, isDir: true }
    if (selected.isDir) return { path: selected.path, isDir: true }
    const parent = selected.path.slice(0, Math.max(selected.path.lastIndexOf('/'), selected.path.lastIndexOf('\\')))
    return { path: parent === '' ? cwd : parent, isDir: true }
  })()

  const rows = []
  /**
   * Every row that is actually on screen, in visual order, as the data a
   * movement key needs rather than as a DOM node. `walk` fills this in the same
   * pass that builds `rows`, so the two can never disagree.
   * @type {{key: string, path: string, isDir: boolean, isOpen: boolean, depth: number, parent: string|null}[]}
   */
  const flat = []
  /** Row path → its live DOM node, so a selection can be focused and revealed. */
  const nodesRef = useRef(new Map())
  nodesRef.current = new Map()
  const pushRow = (spec) => {
    flat.push(spec)
  }
  /**
   * The in-tree name field, rendered where a row would be.
   *
   * It is a real `<input>` inside the tree rather than a modal, so the files
   * around it stay visible and the field sits exactly where the name will land.
   * Escape and blur both abandon the edit; Enter commits it.
   */
  const pushEditorRow = (depth) => {
    const isRename = editor.mode === 'rename'
    const placeholder = editor.mode === 'createDirectory' ? '文件夹名' : '文件名'
    rows.push(h('div', {
      key: 'code-workbench-inline-editor',
      className: 'code-workbench-tree-row code-workbench-tree-editor',
      'data-depth': depth,
      style: { ...rowStyle(depth), padding: '1px 5px' },
    },
      h('span', { style: { color: T.fgMuted, width: '10px', display: 'inline-block' } }, isRename ? (editor.isDir ? '▸' : ' ') : ' '),
      h('input', {
        ref: editorInputRef,
        className: 'code-workbench-tree-editor-input',
        type: 'text',
        value: editorValue,
        placeholder,
        'aria-label': isRename ? '新的名称' : placeholder,
        'aria-invalid': editorError !== null,
        spellCheck: false,
        autoComplete: 'off',
        // The tree's own key handler must not treat typing as navigation.
        onKeyDown: (event) => {
          event.stopPropagation()
          if (event.key === 'Escape') { event.preventDefault(); closeEditor() }
          else if (event.key === 'Enter') { event.preventDefault(); commitEditor() }
        },
        onChange: (event) => { setEditorValue(event.target.value); if (editorError !== null) setEditorError(null) },
        // Clicking away commits an explicit name but silently drops an empty
        // one, so opening the field by accident costs nothing.
        onBlur: () => { commitEditor() },
      })),
    editorError === null ? null : h('div', { key: 'code-workbench-inline-error', className: 'code-workbench-tree-editor-error', style: { color: T.danger } }, editorError))
  }
  const walk = (dir, depth, parent) => {
    const entries = children[dir]
    if (entries === undefined || entries === 'loading') {
      rows.push(h('div', { key: `${dir}#loading`, style: rowStyle(depth) }, '加载中…'))
      return
    }
    if (typeof entries === 'string') {
      rows.push(h('div', { key: `${dir}#err`, style: { ...rowStyle(depth), color: T.danger } }, entries))
      return
    }
    // A create field belongs at the top of its destination folder, ahead of the
    // existing entries — that is where the new name will land.
    if (editor !== null && editor.mode !== 'rename' && editor.parent === dir) pushEditorRow(depth + 1)
    for (const entry of entries) {
      const full = joinPath(dir, entry.name)
      const isDir = entry.type === 'directory'
      const isOpen = isDir && expanded.has(full)
      // Renaming replaces the row: the field stands where the old name was.
      if (editor?.mode === 'rename' && editor.path === full) { pushEditorRow(depth) }
      else {
        const row = { path: full, isDir }
        const isPrimary = selected?.path === full && selected.isDir === isDir
        const isExtra = extraSelection.has(selectedKey(row))
        // An ancestor of the primary selection keeps its rails once the pointer
        // leaves, which is what draws the chain from the selection back to the
        // root. Files and directories both qualify: the chain is about position
        // in the tree, not about what the row is.
        const carriesChain = selected !== null && (isPrimary || selected.path.startsWith(`${full}/`) || selected.path.startsWith(`${full}\\`))
        pushRow({ key: full, path: full, isDir, isOpen, depth, parent })
        rows.push(h('div', {
          key: full,
          className: 'code-workbench-tree-row',
          'data-active': !isDir && full === activePath,
          'data-selected': isPrimary,
          'data-depth': depth,
          role: 'treeitem',
          tabIndex: 0,
          // The focus target for keyboard navigation. The callback ref files the
          // node under its path and clears itself on unmount, so the map only ever
          // holds rows that are on screen right now.
          ref: (node) => { if (node === null) nodesRef.current.delete(full); else nodesRef.current.set(full, node) },
          'aria-level': depth + 1,
          'aria-selected': isPrimary || isExtra,
          'aria-expanded': isDir ? isOpen : undefined,
          'aria-pressed': isDir ? undefined : full === activePath,
          // The drop target for a drag-to-move. Only directories accept a drop --
          // a file has no children to move into -- and the guard lives in the
          // handler because the browser fires dragenter/dragover on every row.
          onDragOver: (event) => {
            if (!isDir || dragRef.current === null) return
            // Dropping a folder into itself (or into its own descendant) would
            // detach that subtree from the tree, so those targets stay inert.
            if (isAtOrUnder(full, dragRef.current.path)) return
            event.preventDefault()
            event.dataTransfer.dropEffect = 'move'
            if (dropTarget !== full) setDropTarget(full)
          },
          onDragLeave: () => {
            if (dropTarget === full) setDropTarget(null)
          },
          onDrop: (event) => {
            if (!isDir || dragRef.current === null) return
            const drag = dragRef.current
            if (isAtOrUnder(full, drag.path)) return
            event.preventDefault()
            event.stopPropagation()
            dragRef.current = null
            setDropTarget(null)
            // The tree's own drop is a move into the folder. The composer's drop
            // target reads the same drag but claims a different flavor, so both
            // gestures share one drag source without colliding.
            onAction('move', { path: drag.path, isDir: drag.isDir, sources: drag.sources, destination: full })
          },
          style: { ...rowStyle(depth), position: 'relative', ...(dropTarget === full ? { boxShadow: `inset 0 0 0 1px ${T.accent}` } : {}) },
          // Selecting and opening are separate concerns: a click both marks the
          // row (so the toolbar knows where to create) and does what the row
          // normally does -- expand a directory, or open a file.
          onClick: (event) => {
            selectRow(row, event)
            // A modifier-click is about building a selection, so it must not
            // also toggle a folder or swap the open file out from under the user.
            if (event?.ctrlKey || event?.metaKey || event?.shiftKey) return
            isDir ? toggle(full) : onOpen(full)
          },
          // Only Enter/space belong to the row itself. Movement keys bubble to the
          // container handler, which is what makes the arrow keys work while a
          // row has focus.
          onKeyDown: (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.preventDefault()
            selectRow(row, event)
            isDir ? toggle(full) : onOpen(full)
          },
          onContextMenu: (event) => {
            // Right-clicking inside an existing multi-selection acts on all of
            // it; right-clicking outside retargets to the row under the pointer.
            if (!isExtra && !isPrimary) selectRow(row, event)
            contextMenu(event, full, isDir)
          },
          // Drag source. The row hands out its workspace-relative path so the
          // composer drop target can turn it into a reference chip, and the tree
          // itself uses the same gesture to move the file into a folder. The
          // private flavor keeps this disjoint from DSH's own file-drop pipeline.
          draggable: true,
          onDragStart: (event) => {
            // Dragging a selected row carries the whole selection; dragging an
            // unselected row carries just that row, as every file manager does.
            const inSelection = isPrimary || isExtra
            const sources = inSelection ? selectionRows().map((item) => item.path) : [full]
            dragRef.current = { path: full, isDir, sources }
            event.dataTransfer.effectAllowed = 'copyMove'
            event.dataTransfer.setData(TREE_DRAG_MIME, treeDragPayload(full, cwd, isDir))
            // A plain-text flavor as the universal fallback; Lexical would render
            // this as raw text if our interceptor ever declined the drop.
            event.dataTransfer.setData('text/plain', relativeToCwd(full, cwd) || full)
          },
          onDragEnd: () => {
            dragRef.current = null
            setDropTarget(null)
          },
          title: full,
        }, guideRails(depth, railCountFor(depth, carriesChain)),
          h('span', { style: { color: T.fgMuted, width: '10px', display: 'inline-block' } }, isDir ? (isOpen ? '▾' : '▸') : ' '),
          h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, entry.name)))
      }
      if (isOpen) walk(full, depth + 1, full)
    }
  }
  walk(cwd, 0, null)
  /**
   * Move the selection one row up or down and put focus on it. Crossing a
   * directory boundary is *not* automatic: the child row only exists in `flat`
   * once its parent has been expanded, so ↑/↓ naturally stop at a collapsed
   * folder and the user opens it with → first. `flush` re-runs this after the
   * rows rebuild, which is what carries the selection from a directory into the
   * child it just expanded.
   */
  const moveSelection = useCallback((step, extend) => {
    const current = selected === null ? -1 : flat.findIndex((row) => row.path === selected.path && row.isDir === selected.isDir)
    if (current < 0) {
      const edge = step > 0 ? flat[0] : flat.at(-1)
      if (edge) setSelected({ path: edge.path, isDir: edge.isDir })
      return
    }
    const nextIndex = current + step
    if (nextIndex < 0 || nextIndex >= flat.length) return
    const next = flat[nextIndex]
    // Shift+arrow grows the selection instead of replacing it, anchored where
    // the plain-key navigation last started.
    if (extend) {
      if (selectionAnchorRef.current === null) selectionAnchorRef.current = selectedKey(flat[current])
      setSelected({ path: next.path, isDir: next.isDir })
      const anchor = flat.findIndex((row) => selectedKey(row) === selectionAnchorRef.current)
      if (anchor >= 0) {
        const [low, high] = anchor <= nextIndex ? [anchor, nextIndex] : [nextIndex, anchor]
        setExtraSelection(new Set(flat.slice(low, high + 1).filter((row) => selectedKey(row) !== selectedKey(next)).map(selectedKey)))
      }
      focusRow(next.path)
      return
    }
    setSelected({ path: next.path, isDir: next.isDir })
    setExtraSelection(new Set())
    selectionAnchorRef.current = selectedKey(next)
    // The row's keys are stable, so the node can be focused directly instead of
    // waiting for the re-render that `setSelected` schedules.
    focusRow(next.path)
  }, [selected, flat])
  const handleTreeKeys = (event) => {
    // While the name field is open it owns every key — arrows move the caret,
    // Delete erases characters. `stopPropagation` in the field usually keeps
    // events from arriving here, but this guard makes it airtight.
    if (editor !== null) return
    const row = selected === null ? -1 : flat.findIndex((item) => item.path === selected.path && item.isDir === selected.isDir)
    const target = row >= 0 ? flat[row] : null
    switch (event.key) {
      case 'ArrowDown':
        // Focus is about to move to another row; that is not a typing context.
        event.preventDefault()
        moveSelection(1, event.shiftKey)
        return
      case 'ArrowUp':
        event.preventDefault()
        moveSelection(-1, event.shiftKey)
        return
      case 'ArrowRight': {
        event.preventDefault()
        if (!target) return
        // On a collapsed folder this expands it, which reveals the child the
        // next ↓ will land on. On an open folder it steps onto the first child.
        if (!target.isDir) return
        if (!target.isOpen) { toggle(target.path); return }
        const child = flat[row + 1]
        if (child && child.parent === target.path) { setSelected({ path: child.path, isDir: child.isDir }); focusRow(child.path) }
        return
      }
      case 'ArrowLeft': {
        event.preventDefault()
        if (!target) return
        // Open folder → close it; anything else → step up to the parent folder.
        if (target.isDir && target.isOpen) { toggle(target.path); return }
        if (!target.parent || target.parent === cwd) return
        setSelected({ path: target.parent, isDir: true })
        focusRow(target.parent)
        return
      }
      case 'F2':
        event.preventDefault()
        if (target && !(target.path === cwd && target.isDir)) openRename({ path: target.path, isDir: target.isDir })
        return
      case 'Delete':
        event.preventDefault()
        // The workspace root is the only thing the tree refuses to delete; the
        // dialog that guards the rest belongs to the action itself. Delete acts
        // on the whole selection, so a multi-select is one confirmation.
        if (target && !(target.path === cwd && target.isDir)) {
          const rowsToDelete = selectionRows().filter((row) => !(row.path === cwd && row.isDir))
          onAction('delete', rowsToDelete.length > 1
            ? { path: target.path, isDir: target.isDir, sources: rowsToDelete.map((row) => row.path) }
            : { path: target.path, isDir: target.isDir })
        }
        return
      default:
    }
  }
  // Keyboard navigation drives the selection, so the selection drives reveal.
  useEffect(() => {
    if (selected === null) return
    focusRow(selected.path)
  }, [selected?.path, selected?.isDir, refreshRevision, expanded])
  const items = menu ? [
    ['createFile', '新建文件…'], ['createDirectory', '新建文件夹…'],
    ['reveal', '在资源管理器中显示'],
    ['addToChat', menu.isDir ? '添加目录到对话' : '添加文件到对话'],
    // The terminal entry is back, and this time it can actually open one: the
    // navigation controller exposes `openTab` and the terminal package registers
    // the kind it takes. It says *workspace* because that is where the official
    // terminal starts — the row under the pointer does not choose its directory,
    // so the label must not promise one.
    ['openTerminal', '打开工作区终端'],
    ['cut', '剪切'], ['copy', '复制'], ['paste', '粘贴'],
    ['copyPath', '复制路径'], ['copyRelativePath', '复制相对路径'],
    ['rename', '重命名…'], ['delete', '删除…'],
  ] : []
  /**
   * The context menu's create/rename entries open the field directly, the same
   * way the toolbar does — no dialog. The host action is only called once the
   * name is committed, so the menu stays a pure front-end.
   */
  const menuAction = (action, target) => {
    if (action === 'createFile' || action === 'createDirectory') return openCreate(action, target)
    if (action === 'rename') {
      // Renaming several rows to one name is not a rename. The field edits a
      // single name, so a multi-selection falls back to the row that was
      // right-clicked and the rest of the selection stays untouched.
      return openRename(target)
    }
    if (action === 'delete') {
      // Right-clicking a row inside a multi-selection deletes the whole
      // selection in one go; right-clicking outside it deletes just that row.
      const rowsToDelete = selectionRows().filter((row) => !(row.path === cwd && row.isDir))
      const inSelection = rowsToDelete.some((row) => row.path === target.path && row.isDir === target.isDir)
      return onAction('delete', inSelection && rowsToDelete.length > 1
        ? { ...target, sources: rowsToDelete.map((row) => row.path) }
        : target)
    }
    return onAction(action, target)
  }
  /**
   * Clear the selection when a click lands on blank space.
   *
   * The empty area below the rows is not a control, so a click there means
   * "nothing is selected" — which is also how the toolbar gets back to creating
   * in the workspace root instead of inside whatever was last clicked. Rows, the
   * in-tree name field and the toolbar's own buttons are excluded, because each
   * of them owns its click.
   *
   * `selected` is the whole of the selection: `extraSelection` and the range
   * anchor hang off it, so leaving either behind would make the next Shift-click
   * measure a range from a row the user can no longer see as selected.
   */
  const clearSelection = (event) => {
    const target = event?.target
    // Spare the rows, the controls inside them, and the toolbar — including the
    // toolbar's own empty space. Moving up to press "new file" is the common
    // next move after selecting a folder, so a near miss has to keep the
    // target rather than silently reset it to the workspace root.
    if (typeof target?.closest === 'function'
      && target.closest('.code-workbench-tree-row, button, input, .code-workbench-tree-toolbar') !== null) return
    setSelected(null)
    setExtraSelection(new Set())
    selectionAnchorRef.current = null
    setDropTarget(null)
  }
  return h('div', {
    className: 'code-workbench-tree',
    // This box has to be the one that fills the column. The click handler below
    // is what "clicking empty space" means, and an empty space outside this
    // element never reaches it — a content-height tree left every click under
    // the last row on the caller's wrapper, which listens to nothing. The
    // scrolling belongs to the row list inside, not to this box: see there.
    style: { display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0, overflow: 'hidden', padding: '4px 0' },
    onClick: clearSelection,
    onContextMenu: (event) => contextMenu(event, cwd, true),
  },
    h('div', { className: 'code-workbench-tree-toolbar' },
      h('button', {
        title: selected === null ? '新建文件' : `在 ${relativeToCwd(createTarget.path, cwd) || '工作区'} 中新建文件`,
        'aria-label': '新建文件',
        onClick: () => openCreate('createFile', createTarget),
      }, workbenchIcon('createFile')),
      h('button', {
        title: selected === null ? '新建文件夹' : `在 ${relativeToCwd(createTarget.path, cwd) || '工作区'} 中新建文件夹`,
        'aria-label': '新建文件夹',
        onClick: () => openCreate('createDirectory', createTarget),
      }, workbenchIcon('createDirectory')),
      h('button', { title: '刷新', 'aria-label': '刷新文件树', onClick: () => { for (const dir of expanded) load(dir) } }, workbenchIcon('refresh')),
      h('button', { title: '全部折叠', 'aria-label': '全部折叠', onClick: () => setExpanded(new Set([cwd])) }, workbenchIcon('collapse')),
    ),
    h('div', { style: rowStyle(0), onContextMenu: (event) => contextMenu(event, cwd, true) }, cwd.split(/[\\/]/).filter(Boolean).at(-1)),
    // The keyboard handler sits on the scroller, not on each row: with focus on
    // a row, ↑/↓/←/→/F2/Delete bubble here, so every row shares one
    // implementation and there is no per-row listener to keep in sync.
    //
    // The pointer listeners live here too. "Inside the tree" means this row
    // list, so the toolbar and the root label do not count as being in it —
    // moving up to press a button swaps the rails back to the selection chain.
    h('div', {
      className: 'code-workbench-tree-body',
      role: 'tree',
      tabIndex: -1,
      // The row list fills what is left of the tree and scrolls it, so the empty
      // space under the last row is part of this element — which is what a blank
      // click lands on, and the reason the tree's click handler sees it at all.
      // It is also the box `scrollerRef` measures: a ref on an element that never
      // overflows reads a scroll offset of zero forever, which quietly turned the
      // "a refresh must not jump you to the top" restore into a no-op.
      style: { flex: '1 1 auto', minHeight: 0, overflow: 'auto' },
      ref: scrollerRef,
      onKeyDown: handleTreeKeys,
      onMouseEnter: () => setPointerInTree(true),
      onMouseLeave: () => { setPointerInTree(false); setDropTarget(null) },
    }, rows),
    menu ? h('div', { role: 'menu', className: 'code-workbench-context-menu', style: { left: menu.x, top: menu.y }, onClick: (event) => event.stopPropagation() },
      items.map(([action, label]) => h('button', { key: action, type: 'button', role: 'menuitem', disabled: action === 'paste' && !clipboard || ['cut', 'rename', 'delete'].includes(action) && menu.path === cwd, onClick: () => { const target = menu; setMenu(null); menuAction(action, target) } }, label))) : null)
}

// ---------------------------------------------------------------------------
// The tab body
// ---------------------------------------------------------------------------

function CodePanel(props) {
  const {
    sessionId,
    sidebarRight,
    useSessions,
    inputActions,
    'remote.workspaceFiles': files,
    'remote.session': session,
    'remote.stream': watchStream,
    'sessions.scope': sessionsScope,
    'settings.form': settingsForm,
  } = props
  const pluginSettings = usePluginSettings(settingsForm).value ?? defaultSettings
  const settingsRef = useRef(pluginSettings)
  settingsRef.current = pluginSettings
  const cwd = useSessions((sessions) => sessions.byId?.[sessionId]?.cwd) ?? ''

  const hostRef = useRef(null)      // monaco container
  const editorRef = useRef(null)    // monaco editor instance
  const stateRef = useRef({ path: null, version: null, dirty: false, text: '' })
  const saveRef = useRef(null)      // latest save, for the editor keybinding
  const openFileRef = useRef(null)  // latest openFile, for the change watch
  const addToChatRef = useRef(null) // latest Add-to-Chat, for the editor keybinding
  // The ghost-text round trips currently on the wire, keyed by completion
  // context. A second ask for the same caret joins the first instead of
  // answering "no suggestion": Monaco records an empty answer as the verdict for
  // that model version, so a busy moment would cost the user another keystroke.
  const inFlightRef = useRef(new Map())
  // Whether the official change stream for the open file is delivering, and since
  // when. It decides how much the version fallback below is allowed to ask, so
  // the two effects share it through a ref — a state update would re-render.
  const watchHealthRef = useRef({ healthy: false, since: 0 })
  const openRequestRef = useRef(0)
  const buffersRef = useRef(new Map())
  const dialogResolveRef = useRef(null)
  const [dialog, setDialog] = useState(null)
  const [dialogValue, setDialogValue] = useState('')
  const askDialog = (title, value) => new Promise((resolve) => {
    dialogResolveRef.current?.(null)
    dialogResolveRef.current = resolve
    setDialogValue(value ?? '')
    setDialog({ title, input: value !== undefined })
  })
  const finishDialog = (accepted) => {
    dialogResolveRef.current?.(accepted ? dialog.input ? dialogValue : true : null)
    dialogResolveRef.current = null
    setDialog(null)
  }
  useEffect(() => () => { dialogResolveRef.current?.(null) }, [])

  const [monaco, setMonaco] = useState(null)
  const [activePath, setActivePath] = useState(null)
  const [openPaths, setOpenPaths] = useState([])
  const [status, setStatus] = useState('就绪')
  const [dirty, setDirty] = useState(false)
  const [leftMode, setLeftMode] = useState('tree')  // 'tree' | 'search' | 'history'
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [result, setResult] = useState(null)        // match report | { error }
  const [history, setHistory] = useState(null)      // { entries } | { error }
  const [hasSelection, setHasSelection] = useState(false)
  const [navigationOpen, setNavigationOpen] = useState(true)
  const [completionStatus, setCompletionStatus] = useState('AI 补全就绪')
  const [editRevision, setEditRevision] = useState(0)
  const [treeRevision, setTreeRevision] = useState(0)
  const [treeClipboard, setTreeClipboard] = useState(null)
  const [searchDirectory, setSearchDirectory] = useState(null)
  const [tabMenu, setTabMenu] = useState(null)
  /**
   * The tab strip's in-flight drag and where it would land.
   *
   * `dataTransfer` cannot be read during `dragover`, so the path being dragged
   * lives in a ref; `tabDrop` is `{path, side}` for the tab under the pointer,
   * which is what draws the insertion marker. Both are cleared on drag end,
   * including a drag that ended over the composer instead of the strip.
   */
  const tabDragRef = useRef(null)
  const [tabDrop, setTabDrop] = useState(null)

  // ---- published updates ---------------------------------------------------
  // Asked once per mount: the panel is opened constantly and a release is rare,
  // so one read per mount is the whole budget this costs anyone.
  const [release, setRelease] = useState(null) // { latest, needsRestart } | null
  const [updateBusy, setUpdateBusy] = useState(false)
  const [updateNote, setUpdateNote] = useState('')

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    fetch(UPDATE_CHECK_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: controller.signal })
      .then((response) => response.json())
      .then((answer) => {
        if (cancelled || answer?.ok !== true || answer.hasUpdate !== true) return
        setRelease({ latest: answer.latest, needsRestart: answer.needsRestart === true })
      })
      // A check that cannot run is not news: silence is the entire fallback, for
      // the same reason the completion route has one — nobody opened the panel
      // to hear about GitHub.
      .catch(() => {})
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [])

  /**
   * Install the published release.
   *
   * Success needs no announcement of its own: the Host replaces `client.js`, the
   * shipped module registry sees the new revision and reloads this panel, so for
   * a client-only release the banner disappears with the remount. A release that
   * also changed what the running Host already loaded can only be honest about
   * needing a restart — it must not report an update that is not in effect yet.
   */
  const runUpdate = async () => {
    if (updateBusy) return
    setUpdateBusy(true)
    setUpdateNote('正在下载新版本…')
    try {
      const response = await fetch(UPDATE_APPLY_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      const answer = await response.json()
      if (answer?.ok !== true) {
        setUpdateNote(answer?.error?.message ?? '更新失败，请稍后重试')
        return
      }
      setRelease(null)
      if (answer.applied !== true) setUpdateNote('已经是最新版本')
      else if (answer.needsRestart === true) setUpdateNote(`已更新到 ${answer.version}，重启 DSH 后生效`)
      else setUpdateNote(`已更新到 ${answer.version}，正在重新加载…`)
    } catch {
      setUpdateNote('更新失败，请检查网络后重试')
    } finally {
      setUpdateBusy(false)
    }
  }

  useEffect(() => {
    const close = () => setTabMenu(null)
    document.addEventListener?.('click', close)
    return () => document.removeEventListener?.('click', close)
  }, [])

  useEffect(() => {
    setCompletionStatus((current) => {
      if (pluginSettings.completionEnabled === false) return 'Tab 补全已关闭'
      return current === 'Tab 补全已关闭' ? 'AI 补全就绪' : current
    })
  }, [pluginSettings.completionEnabled])

  useEffect(() => {
    let live = true
    loadMonaco().then((m) => { if (live) setMonaco(m) }, (error) => setStatus(`Monaco 加载失败: ${error.message ?? error}`))
    return () => { live = false }
  }, [])

  const joinPath = useCallback((dir, name) => {
    const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/'
    return dir.endsWith(sep) ? dir + name : dir + sep + name
  }, [])

  /** Resolve the wire path (absolute under the workspace). */
  const list = useCallback((dir) => files.list(sessionId, dir, undefined).then((res) => {
    if (res?.ok) return res.value.entries
    throw new Error(res?.error?.code ?? 'list failed')
  }), [files, sessionId])

  // ---- editor lifecycle -------------------------------------------------
  useEffect(() => {
    if (!monaco || !hostRef.current || editorRef.current) return
    const editor = monaco.editor.create(hostRef.current, {
      value: '',
      language: 'plaintext',
      theme: monacoTheme(),
      automaticLayout: true,
      fontSize: 13,
      minimap: { enabled: false },
      inlineSuggest: { enabled: true, showToolbar: 'onHover' },
      suggest: { preview: true, showInlineDetails: true },
      padding: { top: 12, bottom: 12 },
      scrollBeyondLastLine: false,
      renderWhitespace: 'none',
      smoothScrolling: true,
      tabSize: 2,
    })
    editorRef.current = editor
    // Keybindings register exactly once per editor; the handlers read the
    // latest closures through refs.
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => { saveRef.current?.() })
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyL, () => { addToChatRef.current?.() })
    // The same action, in the editor's own context menu. Ctrl+L was the only way
    // to reach Add to Chat, and a right-click on a selection is where people look
    // for it first — the floating pill that would have answered this was dropped,
    // so the menu entry is the affordance instead.
    //
    // Two omissions are deliberate. No `keybinding`: Ctrl+L is registered once
    // above, and a second registration of the same chord is a silent duplicate
    // (the smoke suite also pins the editor's command list to exactly those two
    // chords). No `precondition`: a context key this build does not define
    // evaluates to false for ever, which would leave a permanently greyed-out
    // entry that reads as a broken feature — and with no selection `addToChat`
    // explains itself in the status line, which is more use than a dead row.
    // `contextMenuGroupId` is Monaco's cut/copy/paste group, ordered after Paste.
    editor.addAction({
      id: 'code-workbench.addToChat',
      label: '添加到对话',
      contextMenuGroupId: '9_cutcopypaste',
      contextMenuOrder: 100,
      run: () => addToChatRef.current?.(),
    })
    const selectionListener = editor.onDidChangeCursorSelection(() => {
      setHasSelection(!editor.getSelection().isEmpty())
    })
    // Tab-completion ghost text: Monaco renders the preview and accepts on Tab;
    // this provider only answers "what should be inserted at the caret".
    const completions = monaco.languages.registerInlineCompletionsProvider('*', {
      debounceDelayMs: 180,
      async provideInlineCompletions(model, position, context, token) {
        const settings = settingsRef.current
        if (settings.completionEnabled === false) return { items: [] }
        const st = stateRef.current
        if (st.path === null || model !== editor.getModel()) return { items: [] }
        const value = model.getValue()
        const offset = model.getOffsetAt(position)
        const prefix = value.slice(Math.max(0, offset - COMPLETION_PREFIX_CHARS), offset)
        const suffix = value.slice(offset, offset + COMPLETION_SUFFIX_CHARS)
        if (prefix.trim() === '') return { items: [] }
        const cacheKey = `${sessionId}\u0000${st.path}\u0000${settings.completionBaseUrl}\u0000${settings.completionApiModel}\u0000${model.getLanguageId()}\u0000${prefix}\u0000${suffix}`
        // Monaco only needs the text at the caret; the range is a caret insert.
        const ghostText = (text) => ({
          items: [{
            insertText: text,
            range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column),
          }],
        })
        const known = completionCache.get(cacheKey)
        if (known !== undefined) {
          setCompletionStatus('Tab 接受 AI 建议')
          return ghostText(known)
        }
        // Join the round trip already running for this exact caret rather than
        // reporting "no suggestion". To Monaco an empty answer is not "I don't
        // know" — it is the verdict for this model version, and
        // `UpdateRequest.satisfies` then short-circuits every later explicit ask
        // for that version. So answering empty while busy left the caret with no
        // ghost text until the next keystroke.
        const joined = inFlightRef.current.get(cacheKey)
        if (joined !== undefined) {
          await joined
          if (token.isCancellationRequested) return { items: [] }
          const answered = completionCache.get(cacheKey)
          if (answered !== undefined) {
            setCompletionStatus('Tab 接受 AI 建议')
            return ghostText(answered)
          }
          // The request we joined was abandoned before it answered; fall through
          // and ask again under this request's own cancellation.
        }
        const controller = new AbortController()
        const onCancel = token.onCancellationRequested?.(() => controller.abort())
        setCompletionStatus('AI 补全生成中…')
        // Never rejects, so a joined ask can await it bare, and the text reaches
        // the cache no matter which ask happened to own the connection.
        const pending = (async () => {
          try {
            const text = await streamCompletion({
              sessionId,
              path: st.path,
              language: model.getLanguageId(),
              prefix,
              suffix,
            }, controller.signal)
            const insertText = stripFences(text, true).slice(0, 2000)
            if (insertText !== '') {
              completionCache.set(cacheKey, insertText)
              while (completionCache.size > 40) completionCache.delete(completionCache.keys().next().value)
            }
            return { ok: true, text: insertText }
          } catch (error) {
            setCompletionStatus(controller.signal.aborted ? 'AI 补全已取消' : `AI 补全失败：${error.message ?? error}`)
            return { ok: false, text: '' }
          }
        })()
        inFlightRef.current.set(cacheKey, pending)
        try {
          const answer = await pending
          if (!answer.ok) return { items: [] }
          if (token.isCancellationRequested) {
            setCompletionStatus('AI 补全已取消')
            return { items: [] }
          }
          if (answer.text === '') {
            setCompletionStatus('AI 未返回补全')
            return { items: [] }
          }
          setCompletionStatus('Tab 接受 AI 建议')
          return ghostText(answer.text)
        } finally {
          inFlightRef.current.delete(cacheKey)
          onCancel?.dispose?.()
        }
      },
      disposeInlineCompletions: () => {},
    })
    const observer = new MutationObserver(() => monaco.editor.setTheme(monacoTheme()))
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
    return () => {
      completions.dispose()
      // The map outlives the editor; drop it so a torn-down panel cannot hand a
      // later instance a promise from the previous one.
      inFlightRef.current.clear()
      selectionListener.dispose()
      observer.disconnect()
      editor.dispose()
      editorRef.current = null
      for (const buffer of buffersRef.current.values()) buffer.model.dispose()
      buffersRef.current.clear()
    }
  }, [monaco, sessionId])

  // ---- save (Ctrl+S + button) ------------------------------------------
  const save = useCallback(async (note, target) => {
    const st = target ?? stateRef.current
    const editor = editorRef.current
    if (!editor || st.path === null) return
    if (st.saving) return
    st.saving = true
    const text = st.model.getValue()
    setStatus('保存中…')
    try {
      const response = await fetch('/api/code-workbench/write', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          path: st.path,
          text,
          expectedVersion: st.version,
          note: typeof note === 'string' ? note : undefined,
        }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok || body.ok === false) {
        const code = body.error?.code ?? `HTTP ${response.status}`
        const message = code === 'FS_STALE_VERSION'
          ? '保存失败: 文件已被其他进程修改（版本冲突），请重新打开后重试'
          : code === 'FS_SANDBOX_DENIED'
            ? '保存失败: 沙箱策略拒绝写入（会话文件策略为只读时无法保存；请在对话区把权限切到可写）'
            : `保存失败: ${code}`
        setStatus(message)
        return
      }
      st.text = text
      st.version = body.version ?? st.version
      st.dirty = st.model.getValue() !== text
      setEditRevision((revision) => revision + 1)
      if (stateRef.current === st) {
        setDirty(st.dirty)
        setStatus(`已保存 ${st.path}`)
      }
    } catch (error) {
      setStatus(`保存失败: ${error.message ?? error}`)
    } finally {
      st.saving = false
    }
  }, [sessionId])

  useEffect(() => {
    if (!pluginSettings.autoSave || !dirty || activePath === null) return
    const timer = setTimeout(() => save('自动保存'), 900)
    return () => clearTimeout(timer)
  }, [activePath, dirty, editRevision, pluginSettings.autoSave, save])

  // ---- open a file ------------------------------------------------------
  const openFile = useCallback(async (path, reveal, reload = false) => {
    const editor = editorRef.current
    if (!editor) return
    const requestId = ++openRequestRef.current
    const previous = stateRef.current
    const previousText = editor.getValue()
    if (previous.model) previous.viewState = editor.saveViewState?.()
    if (previous.path !== path && previous.dirty && settingsRef.current.autoSave) saveRef.current?.('自动保存', previous)
    setStatus(`读取 ${path} …`)
    try {
      let buffer = buffersRef.current.get(path)
      if (!buffer || reload) {
      let offset = 1
      let text = ''
      let version = null
      for (let page = 0; page < 40; page++) {
        const res = await files.read(sessionId, path, { offset }, undefined)
        if (!res?.ok) {
          // Carry the code, not just the message: whether this file belongs to
          // the official preview is a decision on the code (`NON_TEXT_CODES`).
          const failure = new Error(res?.error?.code ?? 'read failed')
          failure.code = res?.error?.code
          throw failure
        }
        text += res.value.text
        version = res.value.version ?? version
        if (res.value.eof) break
        offset += res.value.lines
      }
      if (requestId !== openRequestRef.current || editorRef.current !== editor) return
      if (previous.path === path && editor.getValue() !== previousText) {
        setStatus('文件读取期间发生编辑，保留未保存内容')
        return
      }
      const uri = monaco.Uri.parse(`inmemory://code-workbench/${sessionId}/${path}`)
      if (buffer?.dirty) {
        setStatus('磁盘文件已更新，保留未保存修改')
        return
      }
      if (buffer) {
        if (buffer.model.getValue() !== text) buffer.model.setValue(text)
        buffer.text = text
        buffer.version = version
        buffer.dirty = false
      } else {
      const existing = monaco.editor.getModel(uri)
      if (existing) existing.dispose()
      const model = monaco.editor.createModel(text, languageForPath(monaco, path), uri)
      buffer = { path, version, dirty: false, text, model }
      buffersRef.current.set(path, buffer)
      model.onDidChangeContent(() => {
        const st = buffer
        st.dirty = model.getValue() !== st.text
        setEditRevision((revision) => revision + 1)
        if (editor.getModel() !== model) return
        setDirty(st.dirty)
        // No nudge here on purpose. Monaco already asks on its own for every
        // typed character, for backspace and delete (they sit in its
        // `triggerCommands` list precisely because they never reach
        // `onDidType`), and for Tab and paste. Nudging it arrives as an
        // *Explicit* trigger, which never satisfies the automatic request
        // already on the wire: Monaco (`UpdateRequest.satisfies`) drops that one
        // and starts over, so every completion paid a second round trip plus a
        // fixed 400ms, and every extra keystroke pushed the ghost text another
        // 400ms out. That was the "I have to press space or delete to make it
        // appear" report.
      })
      }
      }
      if (requestId !== openRequestRef.current || editorRef.current !== editor) return
      const model = buffer.model
      editor.setModel(model)
      if (buffer.viewState) editor.restoreViewState?.(buffer.viewState)
      stateRef.current = buffer
      setActivePath(path)
      setOpenPaths((paths) => paths.includes(path) ? paths : [...paths, path])
      setDirty(buffer.dirty)
      setStatus(`${path} · ${model.getLineCount()} 行`)
      if (reveal !== undefined && Number.isFinite(reveal.line)) {
        const lineNumber = Math.min(Math.max(1, reveal.line), model.getLineCount())
        const column = Math.min(Math.max(1, reveal.column ?? 1), model.getLineMaxColumn(lineNumber))
        const endColumn = Math.min(model.getLineMaxColumn(lineNumber), column + (reveal.length ?? 0))
        const range = new monaco.Range(lineNumber, column, lineNumber, Math.max(column, endColumn))
        editor.setSelection(range)
        editor.revealLineInCenter(lineNumber)
        const decorations = editor.deltaDecorations([], [{ range, options: { className: 'code-workbench-flash' } }])
        setTimeout(() => { editor.deltaDecorations(decorations, []) }, 1500)
      }
    } catch (error) {
      // A file the text channel refuses is not a dead end. Hand it to the
      // official document preview instead of reporting a raw code the user can
      // do nothing with — and leave this panel exactly as it was: no tab, no
      // model, the open file still open.
      if (NON_TEXT_CODES.has(error?.code) && openInDocumentPreview(sidebarRight, sessionId, cwd, path)) {
        setStatus(NON_TEXT_HANDOFF_STATUS)
        return
      }
      const hint = NON_TEXT_CODES.has(error?.code) ? NON_TEXT_NO_PREVIEW_SUFFIX : ''
      setStatus(`读取失败: ${error.message ?? error}${hint}`)
    }
  }, [files, monaco, sessionId])

  // ---- external change watch (auto-reload on external edits) --------
  useEffect(() => {
    const path = activePath
    if (!path || typeof watchStream !== 'function') return
    let cancelled = false
    let dispose = null
    ;(async () => {
      try {
        const stream = watchStream({
          name: `code-workbench watch ${path}`,
          open: (signal) => files.changes(sessionId, path, signal),
          ended: () => new Error('watch ended'),
        })
        dispose = () => stream.dispose()
        for await (const item of stream) {
          if (cancelled) break
          const frame = item.value
          if (frame?.kind === 'ready') {
            watchHealthRef.current = { healthy: true, since: Date.now() }
            item.accept()
          } else if (frame?.kind === 'change') {
            if (stateRef.current.dirty) {
              setStatus('⚠ 文件已在磁盘上更改；你有未保存的修改（重新点开文件可查看最新内容）')
            } else {
              await openFileRef.current?.(path, undefined, true)
              setStatus(`已自动刷新 ${path}（磁盘上发生了更改）`)
            }
          }
        }
        // Reaching here means the stream ended without an error. Either way the
        // fallback below is on its own again, so it must go back to every tick.
        watchHealthRef.current = { healthy: false, since: 0 }
      } catch {
        // watch-unsupported or the stream ended; external reload is best-effort
        watchHealthRef.current = { healthy: false, since: 0 }
      }
    })()
    return () => {
      cancelled = true
      watchHealthRef.current = { healthy: false, since: 0 }
      dispose?.()
    }
  }, [activePath, files, sessionId, watchStream])

  useEffect(() => {
    const path = activePath
    if (!path || typeof files.stat !== 'function') return
    const controller = new AbortController()
    let checking = false
    const checkVersion = async (force = false) => {
      if (checking || controller.signal.aborted || document.visibilityState === 'hidden') return
      // A delivering stream means the fallback is only a net; an absent one means
      // it is the only signal there is, so ask on every tick.
      const watch = watchHealthRef.current
      if (!force && watch.healthy && Date.now() - watch.since < POLL_NET_MS) return
      checking = true
      try {
        const metadata = await files.stat(sessionId, path, controller.signal)
        const current = stateRef.current
        if (controller.signal.aborted || current.path !== path || !metadata?.ok) return
        if (JSON.stringify(metadata.value.version) === JSON.stringify(current.version)) return
        if (current.dirty) {
          setStatus('⚠ 磁盘文件已更新，保留你的未保存修改')
        } else {
          await openFileRef.current?.(path, undefined, true)
        }
      } catch (error) {
        if (!controller.signal.aborted) setStatus(`文件同步检查失败：${error.message ?? error}`)
      } finally {
        checking = false
      }
    }
    const onFocus = () => checkVersion(true)
    const timer = setInterval(checkVersion, POLL_INTERVAL_MS)
    window.addEventListener?.('focus', onFocus)
    checkVersion()
    return () => {
      controller.abort()
      clearInterval(timer)
      window.removeEventListener?.('focus', onFocus)
    }
  }, [activePath, files, sessionId])

  // ---- codebase search (@codebase retrieval) ----------
  const runSearch = useCallback(async () => {
    const q = query.trim()
    if (q === '') return
    setSearching(true)
    setResult(null)
    try {
      const response = await fetch(SEARCH_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, query: q, directory: searchDirectory }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok || body.ok === false) {
        throw new Error(body.error?.message ?? body.error?.code ?? `HTTP ${response.status}`)
      }
      setResult(body)
    } catch (error) {
      setResult({ error: String(error?.message ?? error) })
    } finally {
      setSearching(false)
    }
  }, [query, sessionId, searchDirectory])

  // ---- save journal (checkpoints) --------------------------------------
  const loadHistory = useCallback(async () => {
    const path = stateRef.current.path
    if (path === null) {
      setHistory({ error: '先打开一个文件' })
      return
    }
    setHistory(null)
    try {
      const response = await fetch(HISTORY_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, path }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok || body.ok === false) {
        throw new Error(body.error?.message ?? body.error?.code ?? `HTTP ${response.status}`)
      }
      setHistory({ entries: body.entries })
    } catch (error) {
      setHistory({ error: String(error?.message ?? error) })
    }
  }, [sessionId])

  const rollback = useCallback(async (id) => {
    const path = stateRef.current.path
    if (path === null) return
    if (stateRef.current.dirty || stateRef.current.saving) { setStatus('请先保存当前文件的修改，并等待保存完成后回滚'); return }
    setStatus('回滚中…')
    try {
      const response = await fetch(ROLLBACK_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, path, id }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok || body.ok === false) {
        throw new Error(body.error?.message ?? body.error?.code ?? `HTTP ${response.status}`)
      }
      setStatus('已回滚：文件恢复到该次保存之前的内容')
      await openFile(path, undefined, true)
      await loadHistory()
    } catch (error) {
      setStatus(`回滚失败: ${error?.message ?? error}`)
    }
  }, [loadHistory, openFile, sessionId])

  // ---- Add to Chat (selection → a reference chip in the main draft) -----
  // The chip look: the draft shows a small chip (`a.js:3-5 · 3 行`), and the
  // code expands only at submit through this plugin's reference codec.
  const addToChat = useCallback(() => {
    const editor = editorRef.current
    const model = editor?.getModel()
    if (!editor || !model) return
    const selection = editor.getSelection()
    if (selection.isEmpty()) {
      setStatus('先选中要添加到对话的代码，再按 Ctrl+L')
      return
    }
    const scope = typeof sessionsScope === 'function' ? sessionsScope(sessionId) : undefined
    if (scope === undefined || typeof inputActions?.captureInsertion !== 'function') {
      setStatus('对话输入框尚不可用，请稍后再试')
      return
    }
    const code = model.getValueInRange(selection)
    const path = stateRef.current.path ?? '(未保存文件)'
    const rel = path.startsWith(cwd) ? path.slice(cwd.length).replace(/^[\\/]+/, '') : path
    const startLine = selection.startLineNumber
    const endLine = selection.endLineNumber
    const lines = endLine - startLine + 1
    const anchor = lines === 1 ? `${rel}:${startLine}` : `${rel}:${startLine}-${endLine}`
    const reference = {
      source: 'code-workbench',
      ref: { path: rel, startLine, endLine, language: model.getLanguageId(), code },
      label: `${anchor} · ${lines} 行`,
      appearance: 'file',
      clipboardText: anchor,
    }
    const span = inputActions.captureInsertion()
    const applied = scope.bail(scope, 'slash/input-insert-reference', { reference, span }) === true
    setStatus(applied
      ? `已添加到对话：${anchor}（${lines} 行）— 去主对话输入你的问题`
      : '添加失败：对话输入框正忙（正在提交？），请重试')
  }, [cwd, inputActions, sessionId, sessionsScope])

  // ---- Drop a tree row onto the composer → a reference chip --------------
  // Reuses the same `slash/input-insert-reference` channel as `addToChat`, so a
  // dropped row lands as a proper chip rather than Lexical's plain-text
  // fallback (`insertRawText`, which is all the official code path would do).
  //
  // The listeners run in the CAPTURE phase on `document`: Lexical binds its own
  // `drop` handler to the contenteditable root (see `dsh-client-ui-conversation`
  // `["drop", Pn]`), and capture is the only way to settle the gesture first.
  // Interception is deliberately narrow — our private flavor AND a composer
  // target — so file drops keep flowing to DSH's attachment pipeline untouched.
  useEffect(() => {
    const accepts = (event) => {
      const types = event.dataTransfer?.types
      if (!types) return null
      // `types` is a DOMStringList in some engines; normalize before probing.
      const has = typeof types.includes === 'function'
        ? (name) => types.includes(name)
        : (name) => Array.from(types).includes(name)
      // Our flavor must be present *and* no real file payload, so an OS file
      // drag that merely passes over the tree is never hijacked.
      if (!has(TREE_DRAG_MIME) || has('Files')) return null
      const target = event.target
      if (!target || typeof target.closest !== 'function') return null
      return target.closest('[data-composer-input]') !== null ? event.dataTransfer : null
    }
    const onDragOver = (event) => {
      const dataTransfer = accepts(event)
      if (dataTransfer === null) return
      event.preventDefault()
      event.stopPropagation()
      dataTransfer.dropEffect = 'copy'
      setStatus(`松开即把文件加入对话`)
    }
    const onDrop = (event) => {
      const dataTransfer = accepts(event)
      if (dataTransfer === null) return
      // Claim the gesture from Lexical before it can insert raw text.
      event.preventDefault()
      event.stopPropagation()
      const parsed = parseTreeDragPayload(dataTransfer.getData(TREE_DRAG_MIME))
      if (parsed === null) {
        setStatus('拖入的文件无法识别，请重试')
        return
      }
      const scope = typeof sessionsScope === 'function' ? sessionsScope(sessionId) : undefined
      if (scope === undefined || typeof inputActions?.captureInsertion !== 'function') {
        setStatus('对话输入框尚不可用，请稍后再试')
        return
      }
      const label = `${parsed.path}${parsed.directory ? '/' : ''}`
      const reference = {
        source: 'code-workbench',
        ref: { path: parsed.path, directory: parsed.directory, pathOnly: true },
        label,
        appearance: 'file',
        clipboardText: referenceMention(parsed.path, parsed.directory === true),
      }
      const span = inputActions.captureInsertion()
      const applied = scope.bail(scope, 'slash/input-insert-reference', { reference, span }) === true
      setStatus(applied
        ? `已添加到对话：${label} — 去主对话输入你的问题`
        : '添加失败：对话输入框正忙（正在提交？），请重试')
    }
    // Capture phase, so these outrank Lexical's bubble-phase listeners.
    document.addEventListener?.('dragover', onDragOver, true)
    document.addEventListener?.('drop', onDrop, true)
    return () => {
      document.removeEventListener?.('dragover', onDragOver, true)
      document.removeEventListener?.('drop', onDrop, true)
    }
  }, [inputActions, sessionId, sessionsScope])

  const treeAction = async (action, target) => {
    const path = target.path
    const parent = path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')))
    const directory = target.isDir ? path : parent
    try {
      if (action === 'copyPath' || action === 'copyRelativePath') {
        await navigator.clipboard.writeText(action === 'copyPath' ? path : path.slice(cwd.length).replace(/^[\\/]+/, '') || '.')
      } else if (action === 'reveal') {
        await session.openWorkspacePath({ path, action: 'reveal' }, undefined)
      } else if (action === 'copy' || action === 'cut') {
        setTreeClipboard({ path, isDir: target.isDir, operation: action })
        setStatus('已加入文件剪贴板，请右键目标文件夹并选择粘贴')
        return
      } else if (action === 'addToChat') {
        const scope = sessionsScope?.(sessionId)
        if (!scope || !inputActions?.captureInsertion) throw new Error('对话输入框尚未就绪')
        const relative = path.slice(cwd.length).replace(/^[\\/]+/, '') || '.'
        const reference = { source: 'code-workbench', ref: { path: relative, directory: target.isDir, pathOnly: true }, label: relative, appearance: 'file', clipboardText: referenceMention(relative, target.isDir === true) }
        if (scope.bail(scope, 'slash/input-insert-reference', { reference, span: inputActions.captureInsertion() }) !== true) throw new Error('对话输入框正忙')
      } else if (action === 'openTerminal') {
        if (!openWorkspaceTerminal(sidebarRight)) throw new Error('无法打开终端：宿主未提供终端面板')
        // Early return like the clipboard branch: the tail of this function
        // reports a generic 「操作完成」, which would overwrite the one message
        // that says where the terminal went.
        setStatus('已在右侧打开终端')
        return
      } else if (action === 'move') {
        // Drag-to-move. Each source is a rename into the dropped folder, so it
        // reuses the rename path the host already guards; doing them one at a
        // time keeps a partial failure recoverable rather than all-or-nothing.
        const folder = target.destination
        const sources = target.sources ?? [path]
        const moves = sources
          .filter((item) => !isAtOrUnder(folder, item))
          .map((item) => ({ from: item, to: joinPath(folder, item.split(/[\\/]/).at(-1)) }))
          .filter((item) => item.to !== item.from)
        if (moves.length === 0) { setStatus('文件已经位于这个文件夹'); return { ok: true } }
        const moved = []
        for (const move of moves) {
          const response = await fetch('/api/code-workbench/file-operation', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, operation: 'rename', path: move.from, destination: move.to }) })
          const result = await response.json()
          if (!response.ok || !result.ok) { setStatus(`移动失败：${result.error?.message ?? `HTTP ${response.status}`}`); break }
          moved.push(move)
        }
        if (moved.length === 0) return { ok: false, error: '移动失败' }
        setTreeRevision((revision) => revision + 1)
        // Follow the open file and the tabs to their new homes, exactly as a
        // single rename does — a move is just a rename across folders.
        for (const move of moved) {
          for (const buffer of [...buffersRef.current.values()]) {
            if (!isAtOrUnder(buffer.path, move.from)) continue
            buffersRef.current.delete(buffer.path)
            buffer.model.dispose()
          }
          setOpenPaths((paths) => rewriteOpenPaths(paths, move.from, move.to))
        }
        const current = stateRef.current.path
        const followed = moved.find((move) => current !== null && isAtOrUnder(current, move.from))
        if (followed) {
          stateRef.current = { path: null, version: null, dirty: false, text: '' }
          setActivePath(null)
          setDirty(false)
          await openFile(followed.to + current.slice(followed.from.length))
        }
        setStatus(moved.length === 1 ? '已移动' : `已移动 ${moved.length} 项`)
        return { ok: true }
      } else {
        let operation = action
        let source = path
        let destination
        if (action === 'paste') {
          if (!treeClipboard) return
          source = treeClipboard.path
          destination = joinPath(directory, source.split(/[\\/]/).at(-1))
          operation = treeClipboard.operation === 'cut' ? 'rename' : 'copy'
          if (operation === 'rename' && destination === source) {
            setStatus('文件已经位于这个文件夹，请选择其他目标文件夹')
            return
          }
          if (operation === 'copy') {
            const entries = await list(directory)
            const names = new Set(entries.map((entry) => entry.name.toLowerCase()))
            const originalName = source.split(/[\\/]/).at(-1)
            let name = originalName
            for (let index = 1; names.has(name.toLowerCase()); index++) {
              const dot = treeClipboard.isDir ? -1 : originalName.lastIndexOf('.')
              const stem = dot > 0 ? originalName.slice(0, dot) : originalName
              const extension = dot > 0 ? originalName.slice(dot) : ''
              name = `${stem} - 副本${index > 1 ? ` (${index})` : ''}${extension}`
            }
            destination = joinPath(directory, name)
          }
        } else if (action === 'delete') {
          // A multi-select deletes as one batch: a single confirmation naming
          // everything, then one request per path. Deletion is not atomic on the
          // host, so the loop stops at the first failure and says how far it got
          // rather than reporting a success the tree cannot back up.
          const sources = target.sources ?? [path]
          const listing = sources.length === 1 ? path : `${sources.length} 个项目（${sources.map((item) => item.split(/[\\/]/).at(-1)).join('、')}）`
          if (!await askDialog(`确定删除 ${listing}？此操作无法撤销。`)) return
          if (sources.length > 1) {
            const done = []
            for (const item of sources) {
              const response = await fetch('/api/code-workbench/file-operation', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, operation: 'delete', path: item }) })
              const result = await response.json()
              if (!response.ok || !result.ok) { setStatus(`删除 ${item} 失败：${result.error?.message ?? `HTTP ${response.status}`}`); break }
              done.push(item)
            }
            if (done.length === 0) return { ok: false, error: '删除失败' }
            setTreeRevision((revision) => revision + 1)
            for (const item of done) {
              for (const buffer of [...buffersRef.current.values()]) {
                if (!isAtOrUnder(buffer.path, item)) continue
                if (buffer === stateRef.current) editorRef.current?.setModel(null)
                buffersRef.current.delete(buffer.path)
                buffer.model.dispose()
              }
              setOpenPaths((paths) => paths.filter((path_) => !isAtOrUnder(path_, item)))
            }
            const stillOpen = stateRef.current.path
            if (stillOpen !== null && done.some((item) => isAtOrUnder(stillOpen, item))) {
              editorRef.current?.setModel(null)
              stateRef.current = { path: null, version: null, dirty: false, text: '' }
              setActivePath(null)
              setDirty(false)
            }
            setStatus(`已删除 ${done.length} 项`)
            return { ok: true }
          }
        } else {
          // createFile / createDirectory / rename: the name comes from the
          // in-tree field. `newName` is absent when another caller (the context
          // menu's …) opens the field itself, so there is nothing to do here.
          const name = target.newName
          if (name === undefined) return
          if (!name.trim() || /[\\/]/.test(name) || ['.', '..'].includes(name.trim())) return { ok: false, error: '请输入有效名称，不能包含路径分隔符' }
          if (action === 'rename') {
            destination = joinPath(parent, name.trim())
            // A rename that changes nothing must not reach the host. `contains`
            // is reflexive, so a destination equal to the source trips the
            // host's "destination must not sit inside the source" clause and the
            // user is told their no-op is illegal. Worse, the dirty-buffer guard
            // below would answer with "请先保存受影响文件的修改", which misreports
            // an unchanged name as a save problem. Committing the prefilled name
            // is simply "nothing to do": report it and close the field.
            if (destination === path) { setStatus('名称未改变'); return { ok: true } }
            // A destination nested under the source is refused by the host too,
            // but there it is a bare rejection. Catch it here so the field can
            // explain itself and keep the typed name.
            if (destination.startsWith(`${path}/`) || destination.startsWith(`${path}\\`)) return { ok: false, error: '名称不能嵌套在自身之下' }
          } else source = joinPath(directory, name.trim())
        }
        const affected = [...buffersRef.current.values()].filter((buffer) => isAtOrUnder(buffer.path, source))
        if (['rename', 'delete'].includes(operation) && affected.some((buffer) => buffer.dirty || buffer.saving)) throw new Error('请先保存受影响文件的修改，并等待保存完成')
        const response = await fetch('/api/code-workbench/file-operation', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, operation, path: source, destination }) })
        const result = await response.json()
        if (!response.ok || !result.ok) throw new Error(result.error?.message ?? `HTTP ${response.status}`)
        if (action === 'paste' && treeClipboard.operation === 'cut') setTreeClipboard(null)
        setTreeRevision((revision) => revision + 1)
        const current = stateRef.current.path
        if (operation === 'rename' || operation === 'delete') {
          for (const buffer of affected) {
            buffersRef.current.delete(buffer.path)
            if (buffer === stateRef.current) editorRef.current?.setModel(null)
            buffer.model.dispose()
          }
          setOpenPaths((paths) => operation === 'rename'
            ? rewriteOpenPaths(paths, source, destination)
            : paths.filter((item) => !isAtOrUnder(item, source)))
        }
        if (current && isAtOrUnder(current, source)) {
          if (operation === 'rename') {
            stateRef.current = { path: null, version: null, dirty: false, text: '' }
            setActivePath(null)
            setDirty(false)
            await openFile(destination + current.slice(source.length))
          }
          else if (operation === 'delete') {
            editorRef.current?.setModel(null)
            stateRef.current = { path: null, version: null, dirty: false, text: '' }
            setActivePath(null)
            setDirty(false)
          }
        }
        if (action === 'createFile') await openFile(source)
      }
      setStatus('操作完成')
      return { ok: true }
    } catch (error) {
      const message = error.message ?? String(error)
      setStatus(`操作失败：${message}`)
      // The in-tree field reads this to explain itself and stay open.
      return { ok: false, error: message }
    }
  }

  const closeFile = useCallback(async (path) => {
    const buffer = buffersRef.current.get(path)
    if (buffer?.saving) { setStatus('文件正在保存，请稍后关闭'); return }
    if (buffer?.dirty && !await askDialog(`关闭 ${path} 并放弃未保存的修改？取消后可先按 Ctrl+S 保存。`)) return
    ++openRequestRef.current
    const remaining = openPaths.filter((item) => item !== path)
    setOpenPaths(remaining)
    buffersRef.current.delete(path)
    if (activePath !== path) { buffer?.model.dispose(); return }
    editorRef.current?.setModel(null)
    stateRef.current = { path: null, version: null, dirty: false, text: '' }
    buffer?.model.dispose()
    const next = remaining.at(-1)
    if (next) await openFile(next)
    else {
      editorRef.current?.setModel(null)
      stateRef.current = { path: null, version: null, dirty: false, text: '' }
      setActivePath(null)
      setDirty(false)
    }
  }, [activePath, openFile, openPaths])

  const copyPath = useCallback(async (path, relative = false) => {
    const value = relative && cwd
      ? path.startsWith(cwd) ? path.slice(cwd.length).replace(/^[\\/]+/, '') : path
      : path
    try {
      await globalThis.navigator?.clipboard?.writeText?.(value)
      setStatus(relative ? '已复制相对路径' : '已复制路径')
    } catch { setStatus('复制路径失败') }
  }, [cwd])

  const closeTabSet = useCallback(async (paths) => {
    const selected = openPaths.filter((path) => paths.includes(path))
    if (!selected.length) return
    const dirtyPaths = selected.filter((path) => buffersRef.current.get(path)?.dirty)
    if (dirtyPaths.length && !await askDialog(`关闭 ${dirtyPaths.length} 个未保存文件并放弃修改？取消后可先保存。`)) return
    ++openRequestRef.current
    const remaining = openPaths.filter((path) => !selected.includes(path))
    for (const path of selected) {
      const buffer = buffersRef.current.get(path)
      buffersRef.current.delete(path)
      buffer?.model.dispose()
    }
    setOpenPaths(remaining)
    if (selected.includes(activePath)) {
      const next = remaining.at(-1)
      editorRef.current?.setModel(null)
      stateRef.current = { path: null, version: null, dirty: false, text: '' }
      setActivePath(null)
      setDirty(false)
      if (next) await openFile(next)
    }
  }, [activePath, openFile, openPaths])

  // Keep the editor keybindings pointing at the latest closures.
  useEffect(() => {
    saveRef.current = save
    openFileRef.current = openFile
    addToChatRef.current = addToChat
  }, [addToChat, openFile, save])

  // ---- render ----------------------------------------------------------
  const header = {
    display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 12px',
    borderBottom: `1px solid ${T.border}`, fontSize: '12px', color: T.fgMuted, flex: '0 0 auto',
  }
  const button = {
    padding: '6px 10px', borderRadius: '8px', border: `1px solid ${T.border}`,
    background: T.bgRaised, color: T.fg, cursor: 'pointer', fontSize: '12px',
  }

  // ---- search panel (left column, mode = search) ------------------------
  const searchRows = []
  if (result?.matches) {
    for (const [index, hit] of result.matches.entries()) {
      const rel = hit.path.startsWith(cwd) ? hit.path.slice(cwd.length).replace(/^[\\/]+/, '') : hit.path
      searchRows.push(h('div', {
        key: `${hit.path}#${hit.line}#${index}`,
        style: { ...rowStyle(0), flexDirection: 'column', alignItems: 'flex-start', gap: '1px', padding: '4px 8px' },
        onClick: () => openFile(hit.path, { line: hit.line, column: hit.column, length: hit.length }),
        title: hit.path,
      },
        h('span', { style: { color: T.fgMuted, fontSize: '10.5px' } }, `${rel}:${hit.line}`),
        h('span', { style: { width: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, hit.text.trim()),
      ))
    }
  }
  const searchPanel = h('div', { style: { display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0 } },
    h('div', { style: { padding: '6px 8px', borderBottom: `1px solid ${T.border}`, display: 'flex', gap: '4px', flex: '0 0 auto' } },
      h('input', {
        value: query,
        placeholder: '在代码库中搜索… (Enter)',
        onChange: (e) => setQuery(e.target.value),
        onKeyDown: (e) => { if (e.key === 'Enter') runSearch() },
        style: {
          flex: '1 1 auto', minWidth: 0, padding: '3px 6px', fontSize: '11.5px',
          borderRadius: '4px', border: `1px solid ${T.border}`, background: T.bg, color: T.fg, outline: 'none',
        },
      }),
    ),
    h('div', { style: { padding: '4px 8px', fontSize: '10.5px', color: T.fgMuted, flex: '0 0 auto' } },
      searching ? '搜索中…'
        : result?.error ? h('span', { style: { color: T.danger } }, result.error)
          : result?.matches
            ? `${result.matches.length} 处${result.truncated ? '+' : ''} · ${result.filesScanned} 文件 · ${result.elapsedMs}ms`
            : '输入后回车搜索'),
    h('div', { style: { overflow: 'auto', minHeight: 0, flex: '1 1 auto' } }, searchRows),
  )

  // ---- history panel (left column, mode = history) ---------------------
  const tinyButton = {
    padding: '1px 8px', borderRadius: '4px', border: `1px solid ${T.border}`,
    background: T.bg, color: T.fg, cursor: 'pointer', fontSize: '10.5px',
  }
  const historyRows = []
  if (history?.entries) {
    for (const entry of history.entries) {
      historyRows.push(h('div', {
        key: entry.id,
        style: { ...rowStyle(0), flexDirection: 'column', alignItems: 'flex-start', gap: '2px', padding: '5px 8px' },
      },
        h('span', { style: { color: T.fgMuted, fontSize: '10.5px' } },
          `${new Date(entry.at).toLocaleString()} · ${entry.operation} · ${entry.lines} 行`),
        h('span', { style: { width: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
          entry.note || '(手动保存)'),
        h('button', {
          style: { ...tinyButton, opacity: entry.rollbackable ? 1 : 0.4 },
          disabled: !entry.rollbackable,
          onClick: () => rollback(entry.id),
        }, '回滚到此保存前'),
      ))
    }
  }
  const historyPanel = h('div', { style: { display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0 } },
    h('div', { style: { padding: '6px 8px', borderBottom: `1px solid ${T.border}`, display: 'flex', gap: '4px', flex: '0 0 auto' } },
      h('button', { style: tinyButton, onClick: loadHistory }, '刷新'),
      h('span', { style: { color: T.fgMuted, fontSize: '10.5px', alignSelf: 'center' } }, '每次保存都是一个检查点'),
    ),
    h('div', { style: { overflow: 'auto', minHeight: 0, flex: '1 1 auto' } },
      history?.error ? h('div', { style: { padding: '8px', color: T.danger, fontSize: '11px' } }, history.error)
        : history?.entries
          ? (historyRows.length > 0
              ? historyRows
              : h('div', { style: { padding: '8px', color: T.fgMuted, fontSize: '11px' } }, '还没有保存记录'))
          : h('div', { style: { padding: '8px', color: T.fgMuted, fontSize: '11px' } }, '加载中…')),
  )

  const relativePath = activePath?.startsWith(cwd) ? activePath.slice(cwd.length).replace(/^[\\/]+/, '') : activePath
  const showTabMenu = (event, path) => {
    event.preventDefault()
    event.stopPropagation()
    setTabMenu({ path, x: Math.max(0, Math.min(event.clientX, window.innerWidth - 230)), y: Math.max(0, Math.min(event.clientY, window.innerHeight - 220)) })
  }
  /**
   * Move a tab to another tab's position.
   *
   * The positions are read inside the update, not from the render that drew the
   * strip: a drop can arrive after a close has already shifted the indices, and
   * a stale pair would silently move the wrong tab.
   */
  const moveTab = (from, to) => {
    setOpenPaths((paths) => {
      const fromIndex = paths.indexOf(from)
      const toIndex = paths.indexOf(to)
      if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return paths
      const next = [...paths]
      next.splice(fromIndex, 1)
      next.splice(toIndex, 0, from)
      return next
    })
  }
  const tabs = openPaths.map((path) => {
    const name = path.split(/[\\/]/).at(-1)
    const tabDirty = buffersRef.current.get(path)?.dirty
    const side = tabDrop?.path === path ? tabDrop.side : null
    return h('div', {
      key: path,
      className: `code-workbench-tab${path === activePath ? ' active' : ''}${side === null ? '' : ` code-workbench-tab-drop-${side}`}`,
      onClick: () => openFile(path),
      onContextMenu: (event) => showTabMenu(event, path),
      // A tab is a drag source for the same two gestures a tree row offers: it
      // carries a workspace path to the composer, and it reorders the strip.
      // The private flavor is what keeps both disjoint from DSH's own file-drop
      // pipeline, so the composer's interceptor claims the drop and nothing else
      // does.
      draggable: true,
      onDragStart: (event) => {
        tabDragRef.current = path
        event.dataTransfer.effectAllowed = 'copyMove'
        event.dataTransfer.setData(TREE_DRAG_MIME, treeDragPayload(path, cwd, false))
        // The universal fallback, same as a tree row's: if the composer's
        // interceptor ever declined the drop, the text is still the path.
        event.dataTransfer.setData('text/plain', relativeToCwd(path, cwd) || path)
      },
      onDragOver: (event) => {
        const from = tabDragRef.current
        // A tree row's drag carries the same flavor but never sets this ref, so
        // it passes over the strip without reordering anything.
        if (from === null || from === path) return
        event.preventDefault()
        event.stopPropagation()
        event.dataTransfer.dropEffect = 'move'
        // Which edge the marker goes on is decided by direction: a tab dragged
        // rightwards lands after the one it is over, and the other way round.
        const nextSide = openPaths.indexOf(from) < openPaths.indexOf(path) ? 'after' : 'before'
        if (tabDrop?.path !== path || tabDrop.side !== nextSide) setTabDrop({ path, side: nextSide })
      },
      onDragLeave: (event) => {
        // Moving onto the tab's own name or close button fires `dragleave` too;
        // only a departure from the whole tab clears its marker.
        if (typeof event?.currentTarget?.contains === 'function' && event.currentTarget.contains(event.relatedTarget)) return
        if (tabDrop?.path === path) setTabDrop(null)
      },
      onDrop: (event) => {
        const from = tabDragRef.current
        if (from === null || from === path) return
        event.preventDefault()
        event.stopPropagation()
        tabDragRef.current = null
        setTabDrop(null)
        moveTab(from, path)
      },
      onDragEnd: () => {
        tabDragRef.current = null
        setTabDrop(null)
      },
    },
      h('span', { title: path }, `${name}${tabDirty ? ' ●' : ''}`),
      h('button', { title: `关闭 ${name}`, onClick: (event) => { event.stopPropagation(); closeFile(path) } }, '×'))
  })
  return h('div', { className: 'code-workbench', onContextMenuCapture: () => setTabMenu(null), style: { display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0, background: T.bg, color: T.fg } },
    dialog ? h('div', { className: 'code-workbench-dialog-backdrop', onKeyDown: (event) => { if (event.key === 'Escape') finishDialog(false) } },
      h('form', { className: 'code-workbench-dialog', role: 'dialog', 'aria-modal': true, 'aria-label': dialog.title, onSubmit: (event) => { event.preventDefault(); finishDialog(true) } },
        h('div', { className: 'code-workbench-dialog-title' }, dialog.title),
        dialog.input ? h('input', { autoFocus: true, value: dialogValue, 'aria-label': '名称', onChange: (event) => setDialogValue(event.target.value) }) : null,
        h('div', { className: 'code-workbench-dialog-actions' },
          h('button', { type: 'button', style: button, onClick: () => finishDialog(false) }, '取消'),
          h('button', { type: 'submit', autoFocus: !dialog.input, style: button, disabled: dialog.input && !dialogValue.trim() }, '确定')))) : null,
    h('div', { style: header },
      h('button', { style: button, onClick: () => setNavigationOpen(!navigationOpen), 'aria-expanded': navigationOpen }, navigationOpen ? '收起导航' : '工作区'),
      h('span', { title: activePath ?? cwd, style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: T.fg } },
        relativePath ?? '代码工作台'),
      h('span', { style: { color: dirty ? T.accent : T.fgMuted } }, dirty ? '● 未保存' : ''),
    ),
    h('div', { style: { ...header, flexWrap: 'wrap', gap: '6px', padding: '8px 12px' } },
      h('button', {
        style: { ...button, opacity: hasSelection ? 1 : 0.5 },
        onClick: addToChat,
        disabled: !hasSelection,
        title: '把选中代码添加到主对话输入框（Ctrl+L）',
      }, '加到对话'),
      h('button', { style: button, onClick: () => save(), disabled: !dirty }, '保存 (Ctrl+S)'),
    ),
    release === null && updateNote === '' ? null : h('div', {
      className: 'code-workbench-update',
      role: 'status',
      style: { ...header, borderBottom: `1px solid ${T.border}`, background: T.bgRaised, color: T.fg, padding: '8px 12px' },
    },
      h('span', { style: { flex: '1 1 auto', minWidth: 0, overflowWrap: 'anywhere' } },
        // The note never replaces the offer: a failure is something to read, not
        // something to hide the version behind — and the button beside it is
        // what a retry uses.
        release === null
          ? updateNote
          : `有新版本 ${release.latest}${release.needsRestart ? '（需要重启 DSH）' : ''}${updateNote === '' ? '' : ` · ${updateNote}`}`),
      release === null ? null : h('button', {
        type: 'button',
        style: { ...button, opacity: updateBusy ? 0.6 : 1, cursor: updateBusy ? 'default' : 'pointer' },
        disabled: updateBusy,
        onClick: runUpdate,
      }, updateBusy ? '更新中…' : '升级'),
    ),
    h('div', { className: 'code-workbench-body', style: { display: 'flex', flex: '1 1 auto', minHeight: 0 } },
      h('div', { className: 'code-workbench-activity', role: 'toolbar', 'aria-label': '工作区视图' },
        [['tree', '文件', 'files'], ['search', '搜索', 'search'], ['history', '历史', 'history']].map(([mode, label, icon]) => h('button', {
          key: mode, title: label, 'aria-label': label, 'aria-pressed': navigationOpen && leftMode === mode,
          onClick: () => { setNavigationOpen(leftMode === mode ? !navigationOpen : true); setLeftMode(mode); if (mode === 'history') loadHistory() },
        }, workbenchIcon(icon)))),
      h('div', { className: 'code-workbench-navigation', style: { width: 'clamp(150px, 28%, 210px)', flex: '0 0 auto', borderRight: `1px solid ${T.border}`, background: T.bgRaised, display: navigationOpen ? 'flex' : 'none', flexDirection: 'column', minHeight: 0 } },
        h('div', { className: 'code-workbench-navigation-title' }, leftMode === 'tree' ? '文件' : leftMode === 'search' ? '搜索' : '历史'),
        leftMode === 'search'
          ? searchPanel
          : leftMode === 'history'
            ? historyPanel
            // Hands its whole height to the tree and keeps no scroll box of its
            // own. Whoever holds the scroller holds the empty space under the
            // last row, and that space is the one a blank click lands on — a
            // scroller here puts it outside the tree's own element, where the
            // tree's click handler cannot see it.
            : h('div', { className: 'code-workbench-tree-column', style: { display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0 } },
              cwd
                ? h(FileTree, { list, cwd, activePath, onOpen: openFile, joinPath, onAction: treeAction, refreshRevision: treeRevision, clipboard: treeClipboard, closeMenuSignal: tabMenu?.path ?? null, onMenuOpen: () => setTabMenu(null) })
                : h('div', { style: { padding: '12px', color: T.fgMuted, fontSize: '12px' } }, '会话没有工作区目录')),
      ),
      h('div', { style: { display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0, minWidth: 0 } },
        h('div', { className: 'code-workbench-tabs', onClick: () => tabMenu && setTabMenu(null) }, tabs.length ? tabs : h('span', { className: 'code-workbench-no-tabs' }, '未打开文件')),
        tabMenu ? h('div', { role: 'menu', className: 'code-workbench-context-menu', style: { left: tabMenu.x, top: tabMenu.y }, onClick: (event) => event.stopPropagation() }, [
          ['close', '关闭', () => closeFile(tabMenu.path)],
          ['closeOthers', '关闭其他', () => closeTabSet(openPaths.filter((path) => path !== tabMenu.path))],
          ['closeRight', '关闭右侧标签页', () => closeTabSet(openPaths.slice(openPaths.indexOf(tabMenu.path) + 1))],
          ['closeSaved', '关闭已保存', () => closeTabSet(openPaths.filter((path) => !buffersRef.current.get(path)?.dirty))],
          ['closeAll', '全部关闭', () => closeTabSet(openPaths)],
          ['copyPath', '复制路径', () => copyPath(tabMenu.path)],
          ['copyRelativePath', '复制相对路径', () => copyPath(tabMenu.path, true)],
        ].map(([action, label, handler]) => h('button', { key: action, type: 'button', role: 'menuitem', onClick: () => { setTabMenu(null); handler() } }, label))) : null,
        h('div', { className: 'code-workbench-breadcrumb', title: relativePath ?? '' },
          (relativePath ?? '代码工作台').split(/[\\/]/).filter(Boolean).map((part, index) => h('span', { key: `${part}-${index}` }, index > 0 ? ` › ${part}` : part))),
        h('div', { style: { position: 'relative', display: 'flex', flex: '1 1 auto', minHeight: 0, minWidth: 0 } },
        h('div', { ref: hostRef, style: { flex: '1 1 auto', minHeight: 0, minWidth: 0, visibility: activePath ? 'visible' : 'hidden' } }),
        activePath === null ? h('div', { className: 'code-workbench-empty' },
          h('div', { style: { fontSize: '18px', fontWeight: 500, color: T.fg } }, '开始编辑代码'),
          h('div', null, '从工作区选择一个文件'),
          h('div', { style: { fontSize: '11px', lineHeight: 2 } }, 'Ctrl+L 加到对话', h('br'), '输入代码获取 AI 建议，Tab 接受'),
        ) : null,
        ),
      ),
    ),
    h('div', { style: { ...header, borderTop: `1px solid ${T.border}`, borderBottom: 'none', flexWrap: 'wrap', fontSize: '11px', padding: '6px 12px' } },
      h('span', { style: { flex: '1 1 auto', minWidth: 0, overflowWrap: 'anywhere' } }, status),
      h('span', { role: 'status', title: completionStatus }, completionStatus),
    ),
  )
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const inject = ['slots', 'sidebarRightTabs', 'sidebarRight', 'remote.workspaceFiles', 'remote.session', 'shortcuts', 'sessions', 'inputTriggers', 'configForms']

function CodeWorkbenchSettings({ form }) {
  const snapshot = usePluginSettings(form)
  const value = snapshot.value ?? defaultSettings
  const [autoSave, setAutoSave] = useState(value.autoSave === true)
  const [completionEnabled, setCompletionEnabled] = useState(value.completionEnabled !== false)
  const [baseUrl, setBaseUrl] = useState(value.completionBaseUrl ?? defaultSettings.completionBaseUrl)
  const [apiModel, setApiModel] = useState(value.completionApiModel ?? defaultSettings.completionApiModel)
  const [apiKey, setApiKey] = useState('')
  const [clearApiKey, setClearApiKey] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [status, setStatus] = useState(null)
  const [statusTick, setStatusTick] = useState(0)
  useEffect(() => {
    setAutoSave(value.autoSave === true)
    setCompletionEnabled(value.completionEnabled !== false)
    setBaseUrl(value.completionBaseUrl ?? defaultSettings.completionBaseUrl)
    setApiModel(value.completionApiModel ?? defaultSettings.completionApiModel)
  }, [value.autoSave, value.completionEnabled, value.completionBaseUrl, value.completionApiModel])
  // The credential lives Host-side only, so the editor cannot tell which source
  // a completion would use — it has to ask. Showing the Host's answer is the
  // only way to explain a quiet editor without handling a secret here.
  useEffect(() => {
    let live = true
    fetch(COMPLETION_STATUS_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => { if (live) setStatus(payload?.ok === true ? payload : null) })
      .catch(() => { if (live) setStatus(null) })
    return () => { live = false }
  }, [snapshot.revision, statusTick])
  const persist = async (operation) => {
    if (busy) return
    setBusy(true)
    setNotice('')
    try {
      if (!await operation()) throw new Error('设置未保存，请检查配置权限或重试')
      setNotice('设置已保存')
    } catch (error) { setNotice(error.message ?? String(error)) }
    finally { setBusy(false) }
  }
  const toggleAutoSave = () => {
    if (busy) return
    if (form === undefined) { setNotice('设置服务不可用，自动保存尚未更改'); return }
    const previous = autoSave
    const next = !previous
    setAutoSave(next)
    persist(async () => {
      try {
        const saved = await form.set('autoSave', next)
        if (!saved) setAutoSave(previous)
        return saved
      } catch (error) {
        setAutoSave(previous)
        throw error
      }
    })
  }
  const toggleCompletion = () => {
    if (busy) return
    if (form === undefined) { setNotice('设置服务不可用，Tab 补全尚未更改'); return }
    const previous = completionEnabled
    const next = !previous
    setCompletionEnabled(next)
    persist(async () => {
      try {
        const saved = await form.set('completionEnabled', next)
        if (!saved) setCompletionEnabled(previous)
        if (saved) completionCache.clear()
        return saved
      } catch (error) { setCompletionEnabled(previous); throw error }
    })
  }
  const disabled = busy
  const input = { width: '100%', boxSizing: 'border-box', padding: '7px 9px', borderRadius: '7px', border: `1px solid ${T.border}`, background: T.bg, color: T.fg, font: 'inherit' }
  return h('section', { className: 'code-workbench-settings', style: { color: T.fg, background: T.bgRaised, padding: '14px', borderBottom: `1px solid ${T.border}`, flexShrink: 0 } },
    h('div', { style: { fontSize: '14px', fontWeight: 500, marginBottom: '12px' } }, '代码工作台 · 插件设置'),
    h('div', { className: 'code-workbench-setting-row' },
      h('div', null,
        h('div', { id: 'code-workbench-auto-save-label', className: 'code-workbench-setting-title' }, '编辑后自动保存'),
        h('p', { id: 'code-workbench-auto-save-description' }, '停止输入 900ms 后保存。关闭时用 Ctrl+S。')),
      h('button', { type: 'button', role: 'switch', 'aria-checked': autoSave, 'aria-labelledby': 'code-workbench-auto-save-label', 'aria-describedby': 'code-workbench-auto-save-description', className: 'code-workbench-switch', disabled, onClick: toggleAutoSave },
        h('span', { className: 'code-workbench-switch-thumb' }))),
    h('div', { className: 'code-workbench-setting-row' },
      h('div', null,
        h('div', { id: 'code-workbench-completion-label', className: 'code-workbench-setting-title' }, 'Tab 补全'),
        h('p', { id: 'code-workbench-completion-description' }, '输入停顿后显示 AI 代码预览，按 Tab 接受。')),
      h('button', { type: 'button', role: 'switch', 'aria-checked': completionEnabled, 'aria-labelledby': 'code-workbench-completion-label', 'aria-describedby': 'code-workbench-completion-description', className: 'code-workbench-switch', disabled, onClick: toggleCompletion },
        h('span', { className: 'code-workbench-switch-thumb' }))),
    h('div', { style: { display: 'grid', gap: '12px', marginTop: '12px' } },
      h('p', { style: { color: T.fgMuted, fontSize: '12px', margin: 0 } }, '补全走 FIM（fill-in-the-middle）接口：把光标前后的代码直接交给服务端，由它补出中间部分，不需要提示词。'),
      h('label', null, 'API Base URL', h('input', { style: input, value: baseUrl, placeholder: 'https://api.deepseek.com/beta', disabled, onChange: (event) => setBaseUrl(event.target.value) })),
      h('label', null, '补全模型 ID', h('input', { style: input, value: apiModel, placeholder: 'deepseek-flash', disabled, onChange: (event) => setApiModel(event.target.value) })),
      h('label', null, 'API Key', h('input', { type: 'password', autoComplete: 'new-password', style: input, value: apiKey, placeholder: '留空则自动取用 DSH 凭据库或登录账号', disabled, onChange: (event) => { setApiKey(event.target.value); setClearApiKey(false) } })),
      h('label', null, h('input', { type: 'checkbox', checked: clearApiKey, disabled, onChange: (event) => { setClearApiKey(event.target.checked); setApiKey('') } }), '清除已保存的 API Key'),
      h('p', { style: { color: T.fgMuted, fontSize: '12px', margin: 0 } }, '留空时依次尝试：DSH 凭据库的 DEEPSEEK_API_KEY → 已登录的 DSH 账号。密钥由 Host 保存和使用，不回显到设置页。'),
      h('div', { style: { display: 'grid', gap: '4px', paddingTop: '6px', borderTop: `1px solid ${T.border}` } },
        h('div', { className: 'code-workbench-setting-title' }, '当前补全链路'),
        h('dl', { style: { margin: 0, fontSize: '12px', color: T.fgMuted, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 10px' } },
          h('dt', null, '接口'), h('dd', { style: { margin: 0, wordBreak: 'break-all' } }, status?.addressValid === false ? '地址无效' : (status?.endpoint || '读取中…')),
          h('dt', null, '模型'), h('dd', { style: { margin: 0 } }, status?.model || '—'),
          h('dt', null, '凭据'), h('dd', { style: { margin: 0, color: status !== null && status.source === 'none' ? T.danger : T.fg } }, status === null ? '读取中…' : (CREDENTIAL_SOURCE_LABELS[status.source] ?? status.source)))),
      h('p', { style: { color: T.fgMuted, fontSize: '12px', margin: 0 } }, '凭据缺失或接口不可用时，Tab 补全会静默停用，不弹错误提示。')),
    h('button', { disabled, onClick: () => {
      if (form === undefined || snapshot.status === 'unavailable') { setNotice('设置服务尚未同步，请重新打开设置页后重试'); return }
      try {
        const endpoint = new URL(baseUrl.trim())
        if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || !apiModel.trim()) throw new Error()
      } catch { setNotice('请填写有效的 HTTP(S) API 地址和补全模型 ID'); return }
      const ops = Object.entries({ completionEnabled, completionBaseUrl: baseUrl.trim(), completionApiModel: apiModel.trim() }).map(([field, setting]) => ({ op: 'set', path: [field], value: setting }))
      if (clearApiKey || apiKey.trim()) ops.push({ op: 'set', path: ['completionApiKey'], value: clearApiKey ? '' : apiKey.trim() })
      persist(async () => {
        const saved = await form.mutate(ops, snapshot.revision)
        if (saved) { setApiKey(''); setClearApiKey(false); completionCache.clear(); setStatusTick((tick) => tick + 1) }
        return saved
      })
    } }, busy ? '保存中…' : '保存补全设置'),
    h('div', { role: 'status', style: { fontSize: '12px', marginTop: '8px', color: notice && notice !== '设置已保存' ? T.danger : T.fgMuted } }, notice || (form === undefined || snapshot.status === 'unavailable' ? '设置服务同步中，保存按钮将在同步后生效' : '')),
  )
}

/**
 * The About row: what this installation is, where its source lives, and a nudge.
 *
 * One POST per mount — the panel is opened constantly and the answer changes
 * only with an update, so there is nothing worth re-asking. A route that
 * cannot run is not news: the row stays collapsed to its label, the same quiet
 * fallback the completion-status read uses.
 */
function CodeWorkbenchAbout() {
  const [about, setAbout] = useState(null) // { version, repository } | false | null
  useEffect(() => {
    let live = true
    fetch(ABOUT_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => { if (live) setAbout(payload?.ok === true ? payload : false) })
      .catch(() => { if (live) setAbout(false) })
    return () => { live = false }
  }, [])
  const available = about !== null && about !== false
  return h('details', { className: 'code-workbench-about', style: { marginTop: '12px', paddingTop: '10px', borderTop: `1px solid ${T.border}` } },
    h('summary', { style: { cursor: 'pointer', fontSize: '12px', color: T.fgMuted, userSelect: 'none' } }, '关于'),
    available ? h('div', { style: { display: 'grid', gap: '4px', marginTop: '8px', fontSize: '12px', color: T.fgMuted } },
      h('div', null, '当前版本：', about.version),
      h('div', null,
        '仓库：',
        h('a', { href: about.repository, target: '_blank', rel: 'noreferrer noopener', style: { color: T.accent, textDecoration: 'underline' } }, about.repository)),
      h('div', null, '觉得好用的话，欢迎到仓库点个 Star 支持一下。'),
    ) : null,
  )
}

function CodeWorkbenchSection({ renderSlot }) {
  return h('div', { style: { display: 'flex', flexDirection: 'column', minHeight: 0 } },
    h('h2', { style: { margin: '0 0 18px', fontSize: '20px', fontWeight: 500, color: T.fg } }, '代码工作台'),
    renderSlot('settings.code-workbench.item', {}),
    h(CodeWorkbenchAbout),
  )
}

/**
 * The editor's built-in keybindings, published as read-only reference rows
 * (`registerFixed`) so they show up in the shell's shortcut settings with the
 * rest of DSH's keyboard map. They are editor-reserved and not rebindable.
 */
function registerShortcuts(ctx) {
  const fixed = [
    {
      id: 'code-workbench.save',
      label: () => '保存文件（代码工作台）',
      keys: ['Ctrl+S'],
      bindings: [{ code: 'KeyS', modifiers: ['primary'] }],
      group: 'code-workbench',
    },
    {
      id: 'code-workbench.tabCompletion',
      label: () => '接受 Tab 补全建议（编辑器内 Tab）',
      keys: ['Tab'],
      bindings: [{ code: 'Tab', modifiers: [] }],
      group: 'code-workbench',
    },
    {
      id: 'code-workbench.addToChat',
      label: () => '把选中代码添加到主对话输入框（代码工作台，Ctrl+L）',
      keys: ['Ctrl+L'],
      bindings: [{ code: 'KeyL', modifiers: ['primary'] }],
      group: 'code-workbench',
    },
  ]
  for (const command of fixed) {
    ctx.effect(() => ctx.shortcuts.registerFixed(command), `code-workbench: shortcut ${command.id}`)
  }
}

function apply(ctx) {
  registerShortcuts(ctx)
  const settingsForm = ctx.configForms?.get(SETTINGS_NS)
  if (ctx.configForms) {
    ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: 'code-workbench',
      order: 25,
      label: () => '代码工作台',
      children: { 'settings.code-workbench.item': { kind: 'list', scope: 'root' } },
    }, CodeWorkbenchSection)), 'code-workbench: settings section')
    ctx.effect(() => ctx.slots.inject('settings.code-workbench.item', () => ctx.slots.register({
      name: 'settings.code-workbench.item',
      id: SETTINGS_NS,
      order: 0,
      inject: () => ({ form: settingsForm }),
    }, CodeWorkbenchSettings)), 'code-workbench: settings content')
  }
  ctx.effect(() => ctx.slots.inject('conversation.chat.node', () => {
    const disposers = []
    const entries = typeof ctx.slots.entries === 'function'
      ? ctx.slots.entries('conversation.chat.node')
      : []
    for (const key of ['user', 'steering']) {
      const options = { name: 'conversation.chat.node', key, priority: -10 }
      const original = entries.find((entry) => entry.options.key === key && (entry.options.priority ?? 0) >= 0)
      const Original = original?.component
      disposers.push(ctx.slots.register(options, (props) => {
        const content = props.node?.data?.content
        const hasOriginal = typeof Original === 'function' || (typeof Original === 'object' && Original !== null && Original.$$typeof !== undefined)
        if (!Array.isArray(content)) {
          return h('div', { className: 'code-workbench-chat-fallback' },
            hasOriginal ? h(Original, props) : typeof content === 'string' ? content : '',
          )
        }
        const snippets = []
        const compactContent = content.flatMap((part) => {
          if (part.type !== 'text') return [part]
          return splitSnippets(part.text).flatMap((piece) => {
            if (piece.anchor === undefined) return [{ ...part, text: piece.text }]
            snippets.push(piece)
            return []
          })
        })
        const renderMessage = (messageContent) => hasOriginal
          ? h(Original, { ...props, node: { ...props.node, data: { ...props.node.data, content: messageContent } } })
          : h('div', { className: 'code-workbench-chat-fallback' }, messageContent.map((part) => part.type === 'text' ? part.text : '').join('\n'))
        if (snippets.length === 0) return renderMessage(content)
        return h('div', { className: 'code-workbench-chat-reference' },
          renderMessage(compactContent),
          snippets.map((snippet, index) => h('details', { key: index, className: 'code-workbench-chat-snippet' },
            h('summary', null, `${snippet.anchor} · ${snippet.code.split('\n').length} 行`),
            h('pre', null, h('code', null, snippet.code)),
          )),
        )
      }))
    }
    return () => { for (const dispose of disposers) dispose() }
  }), 'code-workbench: compact chat references')
  // The reference codec: what a `code-workbench` chat chip expands to when the
  // draft is submitted. Registered under the `@` trigger so the input pipeline
  // can route serialization to it (`inputTriggers.serializeReference`).
  //
  // A workspace path answers with the shared `@path` mention rather than a
  // self-authored instruction block. That one spelling settles three things:
  // the transcript projects it back into the chip the composer showed (the
  // mention is the only thing `projectUserText` decorates), the model reads a
  // path it can hand to `read`, and the guidance for exactly this token is
  // already in the system prompt (`dsh-file-reference`'s `FILE_REFERENCE_PROMPT`,
  // installed by the local provider): relative from the workspace root, a
  // trailing slash marking a directory, read before claiming to have inspected.
  // Spelling a bespoke paragraph here only bought a duplicate of that guidance,
  // charged it to every message, and left the log with no chip to render.
  ctx.inject(['inputTriggers'], (scope) => {
    scope.effect(() => {
      try {
        return scope.inputTriggers.registerSource({
          trigger: '@',
          name: 'code-workbench',
          label: () => '选中代码',
          codec: {
            serialize: async (ref) => {
              if (ref?.pathOnly) return referenceMention(ref.path, ref.directory === true)
              const startLine = ref?.startLine ?? 1
              const endLine = ref?.endLine ?? startLine
              const anchor = endLine === startLine
                ? `${ref?.path ?? '(未知文件)'}:${startLine}`
                : `${ref?.path ?? '(未知文件)'}:${startLine}-${endLine}`
              return formatSnippet(anchor, {
                language: ref?.language ?? '',
                code: ref?.code ?? '',
              })
            },
          },
        })
      } catch (error) {
        console.error('[code-workbench] reference codec registration failed:', error)
        return () => {}
      }
    }, 'code-workbench: chat chip codec')
  })
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: TAB_ID,
    kind: TAB_KIND,
    title: () => TAB_LABEL,
    guide: [{
      id: 'code-workbench',
      order: 30,
      title: () => TAB_LABEL,
      description: () => TAB_DESCRIPTION,
    }],
  }), 'code-workbench: tab type')

  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: TAB_ID,
    // The renderer calls entry.inject(sessionId, actions) and hands the returned
    // face to the body as props, so the Remote namespaces travel here explicitly.
    // `remote.stream` wraps the Remote face's `$stream` helper for the file watch;
    // `sessions.scope` resolves the session scope carrying the composer's
    // `slash/input-*` insertion events.
    inject: () => ({
      'remote.workspaceFiles': ctx['remote.workspaceFiles'],
      'remote.session': ctx['remote.session'],
      // The navigation controller is what hands a non-text file to the official
      // preview; without it the panel keeps its own read error.
      'sidebarRight': ctx.sidebarRight,
      'settings.form': settingsForm,
      'remote.stream': (spec) => ctx.remote.$stream(spec),
      'sessions.scope': (id) => ctx.sessions.scope(id),
    }),
  }, CodePanel)), 'code-workbench: tab body')
}

export { inject, apply }
export const name = TAB_KIND
