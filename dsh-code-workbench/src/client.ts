/**
 * dsh-code-workbench — client half source (bundled by build.mts into client.js).
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
 *                         (implemented in src/host/index.ts; the only mutation path)
 *  - non-text files     → the OFFICIAL document preview, through
 *                         `ctx.sidebarRight.openResource(fileAddressFor(…))`; this tab
 *                         type registers no `pattern`, so it never shadows that
 *                         `dsh-resource://file/**` fallback (see `openInDocumentPreview`)
 *
 * The bundle contract: exports { inject, apply, name }; `require` is limited to
 * the frozen browser module table (`react`). Monaco is inlined at build time.
 *
 * Types: the DSH client SDK declares `"types"` but ships no `.d.ts`, so the
 * surface this file talks to is declared by hand in `types/dsh-client.d.ts`.
 */

import React from 'react'
import type * as Monaco from 'monaco-editor/editor/editor.api.js'
import { fileAddressFor } from '@deepseek-ai/dsh-util-workspace-path'
import './workbench.css'
import { serializeSnippet, splitSnippets } from './snippets.mjs'
import { COMPLETION_PREFIX_CHARS, COMPLETION_SUFFIX_CHARS } from './completion-window.mjs'

const { useCallback, useEffect, useRef, useState } = React
const h = React.createElement
const SETTINGS_NS = 'code-workbench'
const defaultSettings: PluginSettings = { autoSave: false, completionEnabled: true, completionBaseUrl: 'https://api.deepseek.com/beta', completionApiModel: 'deepseek-flash' }

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The plugin's own settings.
 *
 * Every field is optional because this is what the settings form *resolves*:
 * before the form has synced, and for a field the user never set, the value is
 * simply absent and the caller falls back to {@link defaultSettings}.
 */
type PluginSettings = Partial<{
  autoSave: boolean
  completionEnabled: boolean
  completionBaseUrl: string
  completionApiModel: string
}>

/** The slim monaco entry, as the dynamic import resolves it. */
type MonacoApi = typeof import('./monaco-entry.mjs')

/** The editor instance `monaco.editor.create` hands back. */
type Editor = Monaco.editor.IStandaloneCodeEditor

/** The text model behind one open buffer. */
type TextModel = Monaco.editor.ITextModel

/** A saved scroll/selection snapshot, as `saveViewState` reports it. */
type ViewState = Monaco.editor.ICodeEditorViewState

/** The listener monaco attaches to the provider's change announcement. */
type CompletionsChangedListener = (hint: Monaco.languages.IInlineCompletionChangeHint | void) => void

/** One entry in a directory listing, as the read route reports it. */
interface TreeEntry {
  name: string
  type: string
}

/** A row's identity in the tree: a path plus whether it is a directory. */
interface TreeRow {
  path: string
  isDir: boolean
}

/**
 * A row as it is on screen, in visual order.
 *
 * This is the data a movement key needs rather than a DOM node, and `walk`
 * fills it in the same pass that builds the rendered rows, so the two can never
 * disagree about what is visible.
 */
interface FlatRow extends TreeRow {
  key: string
  isOpen: boolean
  depth: number
  parent: string | null
}

/** What a directory's children resolve to, keyed by directory path. */
type TreeChildren = Record<string, TreeEntry[] | string>

/** The in-tree name field's mode and target. */
type TreeEditor =
  | { mode: 'createFile' | 'createDirectory'; parent: string }
  | { mode: 'rename'; path: string; isDir: boolean }

/** The row the toolbar's create actions target. */
interface Selection {
  path: string
  isDir: boolean
}

/** The open context menu and where it sits. */
interface TreeMenu extends Selection {
  element: EventTarget | null
  x: number
  y: number
}

/** The in-flight tree drag. */
interface TreeDrag {
  path: string
  isDir: boolean
  sources: string[]
}

/** The file clipboard a copy/cut fills. */
interface TreeClipboard extends Selection {
  operation: 'copy' | 'cut'
}

/** Every action the tree can ask the host to perform. */
type TreeAction =
  | 'createFile' | 'createDirectory' | 'rename' | 'delete'
  | 'copy' | 'cut' | 'paste' | 'move' | 'reveal'
  | 'copyPath' | 'copyRelativePath' | 'addToChat' | 'openTerminal'

/** What a tree action applies to. */
interface TreeActionTarget {
  path: string
  isDir: boolean
  /** The name typed into the in-tree field, for a create or rename. */
  newName?: string
  /** The paths a batch delete or drag-move acts on. */
  sources?: string[]
  /** Where a drag-move lands. */
  destination?: string
}

/** What a tree action reports back; `undefined` means "handled elsewhere". */
interface ActionResult {
  ok: boolean
  error?: string
}

/** Where a search hit should be revealed. */
interface Reveal {
  line: number
  column?: number
  length?: number
}

/** One search hit. */
interface SearchMatch {
  path: string
  line: number
  column: number
  length: number
  text: string
}

/** The search route's report. */
interface SearchReport {
  matches: SearchMatch[]
  truncated?: boolean
  filesScanned: number
  elapsedMs: number
}

/** One save-journal entry. */
interface HistoryEntry {
  id: string
  at: number
  operation: string
  note: string
  lines: number
  rollbackable: boolean
}

/** The history route's report. */
interface HistoryReport {
  entries: HistoryEntry[]
}

/** A published release, as the update check reports it. */
interface Release {
  latest: string
  needsRestart: boolean
}

/** The modal the tree uses for destructive confirmations. */
interface Dialog {
  title: string
  input: boolean
}

/** The reference a chat chip carries. */
interface ChatReference {
  source: 'code-workbench'
  ref: {
    path: string
    directory?: boolean
    pathOnly?: boolean
    startLine?: number
    endLine?: number
    language?: string
    code?: string
  }
  label: string
  appearance: 'file'
  clipboardText: string
}

/** One open file's buffer: its model, its disk version, and its dirty flag. */
interface Buffer {
  path: string
  version: unknown
  dirty: boolean
  text: string
  model: TextModel
  saving?: boolean
  viewState?: ViewState | null
}

/** The editor state before any file is open. */
interface NoBuffer {
  path: null
  version: null
  dirty: false
  text: ''
  model: null
  saving?: boolean
  viewState?: ViewState | null
}

/** What the editor holds: one open file, or the empty placeholder. */
type EditorState = Buffer | NoBuffer

/** The caret context one completion request carries. */
interface CompletionRequest {
  sessionId: string
  path: string
  language: string
  prefix: string
  suffix: string
}

/** The outcome of one in-flight completion. */
interface CompletionAnswer {
  ok: boolean
  text: string
}

/** The props a `conversation.chat.node` occupant receives. */
interface ChatNodeProps {
  node?: { data?: { content?: unknown } }
  [key: string]: unknown
}

/**
 * A slot occupant's component, as the registry stores it.
 *
 * Not always a function: the official entries include `memo` / `forwardRef`
 * wrappers, which are objects carrying `$$typeof`. The renderer accepts both,
 * so this does too.
 */
type StoredComponent =
  | React.ComponentType<Record<string, unknown>>
  | { $$typeof: unknown }

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function usePluginSettings(form: DSH.ConfigFormController | undefined): DSH.ConfigFormSnapshot {
  const [snapshot, setSnapshot] = useState<DSH.ConfigFormSnapshot>(() => form?.getSnapshot?.() ?? { value: defaultSettings, revision: 0, writable: false })
  useEffect(() => {
    const refresh = () => setSnapshot(form?.getSnapshot?.() ?? { value: defaultSettings, revision: 0, writable: false })
    refresh()
    return form?.subscribe?.(refresh)
  }, [form])
  return snapshot
}

// Monaco (inlined, slimmed) initializes lazily: the factory stays cheap for the
// module runtime and the contract harness, and the GUI only pays the parse cost
// when the panel is first opened. The test override lets the render smoke suite
// substitute a fake namespace without touching the production path.
let monacoPromise: Promise<MonacoApi> | null = null
const completionCache = new Map<string, string>()
function loadMonaco(): Promise<MonacoApi> {
  if (monacoPromise === null) {
    // Read through `globalThis`, never as a bare identifier.
    //
    // `__CODE_WORKBENCH_TEST_MONACO__` exists only inside the render smoke
    // suite, which installs it on `globalThis` before evaluating this bundle.
    // Declaring it as a bare global made a bare reference type-check — and then
    // throw `ReferenceError` in a real page, where nothing defines it: the tab
    // body crashed and the whole right panel went blank. A property access is
    // `undefined` when absent, at compile time and at runtime alike, which is
    // exactly the behaviour this needs.
    const seam = (globalThis as { __CODE_WORKBENCH_TEST_MONACO__?: unknown }).__CODE_WORKBENCH_TEST_MONACO__
    monacoPromise = seam !== undefined
      ? Promise.resolve(seam as MonacoApi)
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

/**
 * Workspace-relative path for an absolute tree path.
 *
 * Containment is decided by {@link isAtOrUnder}, not by a bare `startsWith`:
 * a sibling that merely shares the root's text prefix — `/w/app` beside
 * `/w/application/x.js` — would otherwise be relativised into `lication/x.js`,
 * which then shows up in the breadcrumb, the search rows and the copied path.
 */
function relativeToCwd(path: string, cwd: string): string {
  if (typeof path !== 'string' || path === '') return ''
  return isAtOrUnder(path, cwd) ? path.slice(cwd.length).replace(/^[\\/]+/, '') : path
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
function referenceMention(path: string, directory: boolean): string {
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
function openInDocumentPreview(sidebarRight: DSH.SidebarRight, sessionId: string, cwd: string, path: string): boolean {
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
function openWorkspaceTerminal(sidebarRight: DSH.SidebarRight): boolean {
  if (typeof sidebarRight?.openTab !== 'function') return false
  try {
    sidebarRight.openTab('terminal')
    return true
  } catch {
    return false
  }
}

/** The drag payload for one tree row. */
function treeDragPayload(path: string, cwd: string, isDir: boolean): string {
  return `${isDir ? 'd' : 'f'}${relativeToCwd(path, cwd) || '.'}`
}

/** Decode a {@link TREE_DRAG_MIME} payload back into a reference's `ref`. */
function parseTreeDragPayload(raw: string): { path: string; directory: boolean } | null {
  if (typeof raw !== 'string' || raw.length < 2) return null
  const kind = raw[0]
  if (kind !== 'd' && kind !== 'f') return null
  const path = raw.slice(1)
  if (path === '') return null
  return { path, directory: kind === 'd' }
}

/** Whether a path is the given directory or sits inside it. */
function isAtOrUnder(path: string, directory: string): boolean {
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
function rewriteOpenPaths(paths: string[], from: string, to: string): string[] {
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
} as const

/**
 * How serious a status line is.
 *
 * `idle` is the default and paints nothing: the dot exists to mark the states a
 * person has to notice — a failure, a warning, work still running — not to
 * decorate every save. A marker that shows on every success stops meaning
 * anything.
 */
type StatusLevel = 'idle' | 'busy' | 'done' | 'warn' | 'error'

/** The status dot's colour per level. `idle` is transparent, so nothing paints. */
const STATUS_DOT: Record<StatusLevel, string> = {
  idle: 'transparent',
  busy: 'var(--dsw-alias-state-idle-primary, #8b949e)',
  done: 'var(--dsw-alias-state-success-primary, #2da44e)',
  warn: 'var(--dsw-alias-state-warn-primary, #d29922)',
  error: 'var(--dsw-alias-state-error-primary, #e5484d)',
}

// ---------------------------------------------------------------------------
// Monaco plumbing
// ---------------------------------------------------------------------------

/**
 * extension → monaco language id, derived once from the loaded grammars.
 *
 * A Map carrying one extra member, so `fileToLang` travels with the index it
 * belongs to rather than in a second module-level variable that could go stale
 * independently.
 */
interface LanguageIndex extends Map<string, string> {
  fileToLang: Map<string, string>
}

let EXT_TO_LANG: LanguageIndex | null = null
function languageForPath(monaco: MonacoApi, path: string): string {
  if (EXT_TO_LANG === null) {
    const index = new Map<string, string>() as LanguageIndex
    for (const lang of monaco.languages.getLanguages()) {
      for (const ext of lang.extensions ?? []) index.set(ext.toLowerCase(), lang.id)
    }
    const fileToLang = new Map<string, string>()
    for (const lang of monaco.languages.getLanguages()) {
      for (const name of lang.filenames ?? []) fileToLang.set(name.toLowerCase(), lang.id)
    }
    index.fileToLang = fileToLang
    EXT_TO_LANG = index
  }
  const base = path.split(/[\\/]/).pop()?.toLowerCase() ?? ''
  const byName = EXT_TO_LANG.fileToLang.get(base)
  if (byName !== undefined) return byName
  const dot = base.lastIndexOf('.')
  if (dot < 0) return 'plaintext'
  return EXT_TO_LANG.get(base.slice(dot)) ?? 'plaintext'
}

/** One DSH theme token's computed value, or an empty string when the host cannot resolve it. */
function themeToken(name: string): string {
  if (typeof getComputedStyle !== 'function') return ''
  return getComputedStyle(document.body).getPropertyValue(name).trim()
}

/** The spellings Monaco's theme parser reads: `#RGB`, `#RGBA`, `#RRGGBB`, `#RRGGBBAA`. */
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i

/**
 * A serialised colour — `rgb()`, `rgba()` or `color(srgb …)` — back to hex.
 *
 * Those three are what a browser hands back as the computed value of `color`.
 * Anything else (a named colour, `currentColor`, a system colour) answers with
 * an empty string rather than a guess, and the caller then leaves the theme key
 * out.
 * @param css - the serialised colour.
 * @returns `#RRGGBB` or `#RRGGBBAA`, or `''` when the string is not one of the three.
 */
function channelHex(css: string): string {
  const srgb = /^color\(srgb\s+([^)]+)\)$/i.exec(css)
  const rgb = srgb === null ? /^rgba?\(([^)]+)\)$/i.exec(css) : null
  const body = srgb?.[1] ?? rgb?.[1]
  if (body === undefined) return ''
  const [redPart = '', greenPart = '', bluePart = '', alphaPart] = body.split(/[\s,/]+/).filter((part) => part !== '')
  // `rgb()` counts its channels in 0..255, `color(srgb …)` in 0..1. A percentage
  // means the same thing to either, so it is scaled by whichever full it belongs to.
  const full = srgb === null ? 255 : 1
  const channel = (part: string): number => {
    const value = Number.parseFloat(part)
    if (!Number.isFinite(value)) return -1
    const scaled = part.endsWith('%') ? (value / 100) * full : value
    return Math.round(Math.max(0, Math.min(full, scaled)) * (255 / full))
  }
  const red = channel(redPart)
  const green = channel(greenPart)
  const blue = channel(bluePart)
  if (red < 0 || green < 0 || blue < 0) return ''
  let alpha = 255
  if (alphaPart !== undefined) {
    const value = Number.parseFloat(alphaPart)
    if (!Number.isFinite(value)) return ''
    alpha = Math.round(Math.max(0, Math.min(1, alphaPart.endsWith('%') ? value / 100 : value)) * 255)
  }
  const byte = (value: number): string => value.toString(16).padStart(2, '0')
  return `#${byte(red)}${byte(green)}${byte(blue)}${alpha === 255 ? '' : byte(alpha)}`
}

/**
 * A theme token as a colour Monaco can actually read, or `''` to leave the key out.
 *
 * Reading a custom property substitutes its `var()` indirection but does not
 * evaluate colour *functions* — value computation happens where a token is
 * used — so a token spelled `color-mix(in srgb, var(--dsw-static-blue-500) 40%,
 * transparent)` arrives with the `color-mix()` still standing. Monaco's theme
 * parser reads hex and only hex (`Color.fromHex` → `Color.Format.CSS.parseHex`),
 * and its fallback for anything else is not a rejection or a warning but
 * `Color.red`: the key paints solid `#ff0000`, silently. That was the whole of a
 * red selection — `--dsw-alias-bg-document-selection` is the one token in this
 * palette whose value is a colour function rather than a literal, which is why
 * it was the only surface that broke.
 *
 * Using the token in a real `color` property is what makes the browser compute
 * it, so a throwaway span borrows that computation and `channelHex` reads the
 * answer back. When nothing readable comes out the key is dropped, and
 * `inherit: true` supplies Monaco's own colour — the same degradation an
 * unresolved token already gets.
 * @param value - the token's value, as the cascade reports it.
 * @returns a `#RRGGBB[AA]` string, or `''` when the value cannot be read as a colour.
 */
function monacoColor(value: string): string {
  // An empty value would leave the probe inheriting the page's colour, which
  // reads back as a perfectly valid colour that means nothing here.
  if (value === '') return ''
  if (HEX_COLOR.test(value)) return value
  if (typeof getComputedStyle !== 'function' || typeof document.createElement !== 'function') return ''
  const probe = document.createElement('span')
  probe.style.position = 'absolute'
  probe.style.display = 'none'
  probe.style.color = value
  document.body.appendChild(probe)
  const resolved = getComputedStyle(probe).color
  probe.remove()
  return channelHex(resolved)
}

/**
 * The editor's chrome, expressed in DSH's own palette.
 *
 * Monaco's built-in `vs` / `vs-dark` supply the syntax colours — those are
 * tuned, and re-deriving them is not this plugin's business — while the `colors`
 * map overrides the surfaces around them. That is the whole point: without it
 * the editor paints its own white (or black) inside a panel painted from
 * `--dsw-alias-*`, so the two read as two products sharing an edge rather than
 * as one. `inherit: true` is what lets the syntax rules stay put while the
 * chrome moves.
 *
 * `editor.background` is the code surface rather than the panel surface: DSH
 * already uses that token for fenced code in the transcript, so the editor
 * matches every other place in the product that shows code.
 *
 * Only colours Monaco can read are claimed. A token that resolves to nothing, or
 * to something the parser cannot read — a colour function, say, which is what
 * `monacoColor` explains — is left out of the map, so a palette this host cannot
 * express degrades to the built-in theme rather than to a broken one.
 * @param monacoApi - the loaded namespace.
 * @param dark - whether the shell is in its dark palette.
 * @returns the theme name to hand `setTheme` and `editor.create`.
 */
function workbenchTheme(monacoApi: MonacoApi, dark: boolean): string {
  const name = dark ? 'dsh-code-workbench-dark' : 'dsh-code-workbench-light'
  const colors: Record<string, string> = {}
  const take = (monacoKey: string, token: string): void => {
    const value = monacoColor(themeToken(token))
    if (value !== '') colors[monacoKey] = value
  }
  take('editor.background', '--dsw-alias-markdown-code-block')
  take('editor.foreground', '--dsw-alias-label-primary')
  take('editorGutter.background', '--dsw-alias-markdown-code-block')
  take('editorLineNumber.foreground', '--dsw-alias-label-tertiary')
  take('editorLineNumber.activeForeground', '--dsw-alias-label-secondary')
  take('editor.lineHighlightBackground', '--dsw-alias-fill-l1')
  take('editor.selectionBackground', '--dsw-alias-bg-document-selection')
  take('editorCursor.foreground', '--dsw-alias-brand-primary')
  take('editorIndentGuide.background1', '--dsw-alias-border-l1')
  take('editorIndentGuide.activeBackground1', '--dsw-alias-border-l2')
  take('editorWidget.background', '--dsw-alias-bg-layer-1')
  take('editorWidget.border', '--dsw-alias-border-l2')
  take('editorSuggestWidget.background', '--dsw-alias-bg-layer-1')
  take('editorSuggestWidget.selectedBackground', '--dsw-alias-interactive-bg-hover')
  take('editorHoverWidget.background', '--dsw-alias-bg-layer-1')
  take('scrollbarSlider.background', '--dsw-alias-scrollbar-bg-l1')
  take('scrollbarSlider.hoverBackground', '--dsw-alias-scrollbar-hover-l1')
  monacoApi.editor.defineTheme(name, { base: dark ? 'vs-dark' : 'vs', inherit: true, rules: [], colors })
  return name
}

/**
 * The theme to mount the editor with: this plugin's DSH-matched theme when the
 * namespace can build one, Monaco's built-in otherwise.
 *
 * The fallback is not decoration. `defineTheme` and `getComputedStyle` are both
 * host APIs, and the render smoke suite drives this code against a fake
 * namespace and a DOM stub that has neither — the same reason
 * `requestAnimationFrame` and `navigator.clipboard` are guarded elsewhere in
 * this file.
 * @param monacoApi - the loaded namespace, or null before it has loaded.
 * @returns the theme name.
 */
function monacoTheme(monacoApi: MonacoApi | null): string {
  const dark = document.body.hasAttribute('data-ds-dark-theme')
  if (monacoApi !== null && typeof monacoApi.editor.defineTheme === 'function') return workbenchTheme(monacoApi, dark)
  return dark ? 'vs-dark' : 'vs'
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
const CREDENTIAL_SOURCE_LABELS: Record<string, string> = {
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
 * How long a drag must rest on a collapsed folder before it opens.
 *
 * Long enough that dragging *across* a folder on the way somewhere else does
 * not open it, short enough that aiming at one feels like one gesture rather
 * than two. Dropping into a folder you cannot see inside is a guess, which is
 * what this removes.
 */
const DRAG_HOVER_EXPAND_MS = 700

/**
 * How long typing must pause before the codebase search runs.
 *
 * The search walks the workspace, so running it per keystroke spends the whole
 * budget on prefixes nobody asked about. Enter still searches immediately — the
 * debounce is for the pause, not for the intent.
 */
const SEARCH_DEBOUNCE_MS = 300

/** The completion-status payload the settings page renders. */
interface CompletionStatus {
  mode?: string
  endpoint?: string
  addressValid?: boolean
  model?: string
  source?: string
}

/** The About payload. */
interface AboutInfo {
  version: string
  repository: string
}

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
async function streamCompletion(body: CompletionRequest, signal: AbortSignal): Promise<string> {
  const response = await fetch(COMPLETE_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  const payload = await response.json().catch(() => undefined) as { text?: unknown; error?: { message?: string; code?: string } } | undefined
  if (!response.ok || payload === undefined) {
    throw new Error(payload?.error?.message ?? payload?.error?.code ?? `HTTP ${response.status}`)
  }
  return typeof payload.text === 'string' ? payload.text : ''
}

/** Models occasionally fence despite instructions; strip one wrapping fence. */
function stripFences(text: string, preserveWhitespace = false): string {
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
 * Whether an answer carries nothing to insert: empty, or only whitespace.
 *
 * A caret at the end of a line is exactly where a line ends, so "break the line
 * and indent" is a perfectly likely continuation and this model does return it —
 * a lone `\n`, a trailing indent, a fence whose body is blank. {@link
 * stripFences} with `preserveWhitespace` hands that back verbatim, which is
 * right: the leading blank of a real completion is part of the completion. But
 * whitespace *alone* is not a suggestion — Monaco would paint those spaces as
 * ghost text and Tab would insert them, leaving the caret on an indented empty
 * line and no code. So a blank answer reads the same way an empty one does:
 * nothing to suggest here.
 * @param text - the completion as it came back, fences already stripped.
 * @returns true when there is no content at all, only whitespace.
 */
function isBlankAnswer(text: string): boolean {
  return text.trim() === ''
}

// ---------------------------------------------------------------------------
// The selection capsule — Cursor's "Add to Chat" pill, on this side's editor.
//
// A small capsule that appears beside the selected lines and adds them to the
// main chat draft. The shape of it is Cursor's, read out of its shipped
// workbench bundle; the parts worth porting are the placement search, the
// mounting, and the rules for getting out of the way.
//
// **It is a Monaco content widget, not an overlay.** Cursor hands Monaco a line,
// a column and a side, and Monaco works out the pixels — so the capsule rides
// scrolling, wrapping and zoom without any bookkeeping of its own, and its own
// code never asks where anything is on screen. Cursor's `hoverWidget.js` does
// exactly this, and `IContentWidget` is public API.
//
// **The offset is ours, not the preference's.** Monaco lays ABOVE and BELOW out
// by clamping the box inside `getClientArea(body)` — the *window* — and lets it
// hang up to a box width outside the editor. In Cursor the editor is the window,
// so that is a good approximation; here the editor is a panel in the right
// sidebar, and the same clamp would carry the capsule over the panel's edge. The
// preference handed to Monaco is therefore always EXACT, which does no clamping
// and no offset at all, and the above/below/on-the-line choice is applied as a
// `transform` on the capsule itself — measured against a width this panel knows.
//
// The DOM is built by hand rather than through React. A content widget's node is
// owned by Monaco (added once, moved by Monaco, disposed by Monaco), the capsule
// is three elements, and the styles it needs are theme variables that
// `workbench.css` already defines.
// ---------------------------------------------------------------------------

/**
 * The capsule's label and the key hint printed beside it.
 *
 * The hint repeats what the editor's tooltip and the header button already say.
 * Cursor looks the chord up through the keybinding service; there is no such
 * service on this side, and the chord is registered by this file two screens
 * further down.
 */
const PILL_LABEL = '加到对话'
const PILL_KEY_LABEL = 'Ctrl+L'

/**
 * Room the capsule keeps free at the right of the longest line it may hang on.
 * Cursor's own constant is 80px, for a two-button capsule; this one is a single
 * button, and `workbench.css` holds it to at most this width, so the reserve and
 * the thing being reserved for cannot drift apart.
 */
const PILL_RESERVE_PX = 128

type PillSide = Monaco.editor.ContentWidgetPositionPreference

/**
 * Monaco's content-widget preferences, by value: `EXACT = 0`, `ABOVE = 1`,
 * `BELOW = 2` — the numbers the public API fixes in `editor.api.d.ts`.
 *
 * They are spelled out rather than read off `monaco.editor` for one reason: the
 * declaration is a `const enum`, so the value only exists at run time through the
 * mirror monaco happens to publish on its namespace object, while the placement
 * search below has to be usable with no monaco instance at all (the smoke suite
 * drives it through a stub). The cast is what makes the three numbers a type.
 */
const PILL_EXACT = 0 as PillSide
const PILL_ABOVE = 1 as PillSide
const PILL_BELOW = 2 as PillSide

/** Where the capsule hangs: a line, a column just past that line's text, a side. */
interface PillPlacement {
  lineNumber: number
  column: number
  side: PillSide
}

/** Everything the placement search reads, so that it needs no editor. */
interface PillGeometry {
  /** The caret's line. */
  caretLine: number
  /** The caret's column, which only survives as the fallback anchor. */
  caretColumn: number
  selectionStartLine: number
  selectionEndLine: number
  lineCount: number
  /** The model's line length, 1-based. */
  lineLength: (lineNumber: number) => number
  /** Characters that fit on a line before the capsule would leave the panel. */
  charBudget: number
  /** Whether the editor wraps, which widens the search band. */
  isWordWrap: boolean
}

/**
 * Pick where the capsule hangs — Cursor's search, ported.
 *
 * Anchoring on the caret does not work. The caret usually sits in the middle of
 * a line, so a capsule hung there covers code; and the end of *that* line can be
 * a long way to the right, far enough to leave the panel. Cursor's answer is to
 * look for a nearby line worth hanging a box *from*: short enough that the space
 * to the right of it is empty, close enough that the capsule still reads as
 * attached to the selection.
 *
 *  - **The band** is the caret's line ±2 — ±3 while the editor wraps, where one
 *    logical line is several visual rows.
 *  - **The line it hangs on** must be the longest of a three-line window around
 *    itself, so both its neighbours are no longer than it is and the column past
 *    its end is empty on all three rows.
 *  - **The side** is which window matched: one reaching up (`[n-2, n]`) hangs the
 *    capsule above the line, one reaching down (`[n, n+2]`) hangs it below, the
 *    centred one (`[n-1, n+1]`) leaves it on the line. All three positions are
 *    free for the same reason, which is what makes "any of them" safe. The window
 *    reaching up cannot match at the very top of a file, and that is deliberate
 *    and load-bearing — see the loop below.
 *  - **The cost** is `|length - 5| + 25 × lines from the band's centre`, so a
 *    nearly empty line wins outright and distance is the tie-break. The centre is
 *    the middle of the selection, and never above the caret's line minus two.
 *  - **The floor**: a line at or past `charBudget - 10` characters is dropped
 *    before its cost is looked at. That is not a style filter — it is the edge of
 *    the panel. `charBudget` is how many characters fit between the text's own
 *    origin and the content area's right edge, less the room the capsule needs,
 *    so a line that passes leaves the capsule somewhere to be.
 *
 * Ties between windows go to the earlier window (the cost comparison is strict),
 * and ties inside a window go to the earlier line. Both are Cursor's, and both
 * are what keep the answer still while the caret moves by one.
 *
 * @param geometry - everything the search reads.
 * @returns the anchor, and the side of it to hang on.
 */
function selectionPillPlacement(geometry: PillGeometry): PillPlacement {
  const { lineCount } = geometry
  const lineLength = (lineNumber: number): number =>
    geometry.lineLength(Math.max(1, Math.min(lineCount, lineNumber)))
  // Cursor's starting point, which survives only if nothing in the band costs less.
  let line = Math.max(1, Math.min(lineCount, geometry.caretLine < 4 ? geometry.selectionEndLine + 3 : geometry.caretLine - 2))
  let column = geometry.caretColumn
  let side = PILL_ABOVE
  let best = Number.MAX_VALUE
  const radius = geometry.isWordWrap ? 3 : 2
  const first = Math.max(1, geometry.caretLine - radius)
  const last = Math.min(lineCount - 1, geometry.caretLine + radius)
  const centre = Math.max(geometry.caretLine - 2, Math.floor((geometry.selectionEndLine + geometry.selectionStartLine) / 2) - 1)
  const limit = geometry.charBudget - 10
  const consider = (scanLine: number, from: number, to: number, windowSide: PillSide): void => {
    let longest = 0
    let longestLine = 0
    // The window index is kept exactly as Cursor keeps it: `from` and `to` are
    // used as given, even where they run past the ends of the model, and only the
    // *length* read above is clamped. The two are then compared unnormalised, so
    // a window that had to reach past the top of the file cannot match its own
    // middle line: for a candidate on line 1 the window index ends up on line 0
    // or -1, and for line 2 it does so unless line 2 is strictly longer than
    // line 1.
    //
    // That is load-bearing rather than incidental, so it is reproduced instead of
    // repaired. The window reaching up is the one that hangs the capsule *above*
    // the line, and a capsule hung above the editor's first row is outside the
    // editor's own clipped box — it would be positioned, reported as visible, and
    // seen by nobody. Losing that window near the top of a file is what keeps the
    // capsule below the line there, where it can be seen.
    for (let n = from; n <= to; n++) {
      const length = lineLength(n)
      if (length > longest) {
        longest = length
        longestLine = n
      }
    }
    // Not the longest in this window: the column past its end is not empty on
    // every row of the window, so this window cannot promise a free hang.
    if (longestLine !== scanLine) return
    if (longest >= limit) return
    const cost = Math.abs(longest - PILL_EMPTY_LINE) + Math.abs(scanLine - centre) * PILL_LINE_PENALTY
    if (cost < best) {
      best = cost
      line = scanLine
      column = longest
      side = windowSide
    }
  }
  for (let scanLine = first; scanLine <= last; scanLine++) {
    consider(scanLine, scanLine - 2, scanLine, PILL_ABOVE)
    consider(scanLine, scanLine, scanLine + 2, PILL_BELOW)
    consider(scanLine, scanLine - 1, scanLine + 1, PILL_EXACT)
  }
  // Two columns past the text: Cursor's own gap, wide enough that the capsule
  // does not read as part of the line it hangs from.
  return { lineNumber: line, column: column + 2, side }
}

/** The line length a window's cost treats as free. Cursor's constant. */
const PILL_EMPTY_LINE = 5

/** The cost of hanging one line away from the band's centre. Cursor's constant. */
const PILL_LINE_PENALTY = 25

/** What the capsule needs from the editor's layout, in pixels. */
interface PillMetrics {
  /** Characters that fit on a line before the capsule would leave the panel. */
  charBudget: number
  lineHeight: number
  spaceWidth: number
  /** Room between the text's own origin and the panel's right edge. */
  contentWidth: number
}

/**
 * Read the layout numbers the capsule needs, or report that they are not usable.
 *
 * `spaceWidth` is what turns "how many characters fit" into the only unit the
 * model speaks, and `lineHeight` is what the vertical offset is measured in. Both
 * come from the resolved font info, so a user's font size and family are already
 * accounted for; a build that reports no width at all gets no capsule rather than
 * a capsule placed by guesswork.
 *
 * Cursor derives the same budget from the editor's *full* width minus a handful of
 * constants (50, the decoration lane, the scrollbar, 80 for the capsule). The
 * text area's own width is measured here instead — the capsule is clamped against
 * the text area, and this panel is narrow enough that the difference shows. The
 * origin is the same one Monaco measures the anchor from: the content widget
 * layer is laid out at `contentLeft`, and `visibleRangeForPosition` already
 * excludes the gutter. The vertical scrollbar is the one thing taken back out,
 * because `contentWidth` runs to the editor's right edge and includes it.
 *
 * A panel with no room left over at all reports "not usable", which is the same
 * answer as a font with no measurable width — there is nowhere to put a capsule,
 * so one is not shown, rather than one placed off the edge and clipped.
 */
function pillMetrics(editor: Editor, monaco: MonacoApi): PillMetrics | undefined {
  const fontInfo = editor.getOption(monaco.editor.EditorOption.fontInfo)
  const spaceWidth = fontInfo?.spaceWidth ?? 0
  const lineHeight = fontInfo?.lineHeight ?? 0
  if (!(spaceWidth > 0) || !(lineHeight > 0)) return undefined
  const layout = editor.getLayoutInfo()
  const usable = layout.contentWidth - layout.verticalScrollbarWidth
  if (!(usable > PILL_RESERVE_PX)) return undefined
  return {
    spaceWidth,
    lineHeight,
    contentWidth: usable,
    charBudget: Math.floor((usable - PILL_RESERVE_PX) / spaceWidth),
  }
}

/** What the capsule needs to run; everything else it reads from the editor. */
interface SelectionPillOptions {
  editor: Editor
  monaco: MonacoApi
  /** The same action Ctrl+L and the context-menu entry run. */
  onPick: () => void
}

/**
 * The capsule itself: one content widget, added once, shown and hidden by
 * `getPosition()`.
 *
 * Adding and removing the widget on every selection change would be work done
 * for nothing — Monaco reads `getPosition()` on each `layoutContentWidget`, and a
 * null answer is its own "put it away". So the widget is registered when the
 * editor is created and torn down with it.
 *
 * Hiding has four causes, all of them Cursor's: nothing selected (or the
 * selection is in a buffer that is not on screen), the editor has neither text
 * nor widget focus, a Tab suggestion is on screen and owns the caret, or the
 * numbers are unusable. A drag passing over the capsule hides it too — the
 * pointer is selecting, and a box under it would swallow the rest of the gesture.
 */
class SelectionPill implements Monaco.editor.IContentWidget {
  /**
   * Monaco's own guard, and the reason the capsule can be clicked at all.
   *
   * A mousedown on a content widget never starts a selection drag — Monaco only
   * begins one when the target is inside the text itself — but without this flag
   * it is also not intercepted at all: nothing calls `preventDefault()`, nothing
   * puts the focus back where the click is about to be read from, and the
   * browser's default then hands focus to the button. The editor blurs, its
   * selection repaints in the inactive colour, and the capsule reads as a control
   * sitting on top of a selection that was just thrown away.
   */
  readonly suppressMouseDown = true
  private readonly editor: Editor
  private readonly monaco: MonacoApi
  private readonly onPick: () => void
  private readonly domNode: HTMLElement
  /** The visible capsule, which carries the offset. */
  private readonly body: HTMLElement
  /** What is on screen now: an anchor and the transform for it, or nothing. */
  private state: { placement: PillPlacement; transform: string } | null = null
  /** Set while a Tab suggestion is on screen for the open file. */
  private suppressed = false

  constructor(options: SelectionPillOptions) {
    this.editor = options.editor
    this.monaco = options.monaco
    this.onPick = options.onPick
    this.domNode = document.createElement('div')
    this.domNode.className = 'code-workbench-pill'
    const body = document.createElement('div')
    body.className = 'code-workbench-pill-body'
    const button = document.createElement('button')
    button.type = 'button'
    // Out of the tab order: keyboard users already have Ctrl+L, and a focusable
    // capsule would take focus away from the editor on the way past.
    button.tabIndex = -1
    button.className = 'code-workbench-pill-button'
    button.title = `${PILL_LABEL}（${PILL_KEY_LABEL}）`
    const text = document.createElement('span')
    text.className = 'code-workbench-pill-text'
    text.textContent = PILL_LABEL
    const key = document.createElement('span')
    key.className = 'code-workbench-pill-key'
    key.textContent = PILL_KEY_LABEL
    button.appendChild(text)
    button.appendChild(key)
    body.appendChild(button)
    this.domNode.appendChild(body)
    this.body = body
    // The mousedown is swallowed so that focus never leaves the editor: the
    // selection keeps its caret and does not fade to its inactive colour, and the
    // click still arrives. With `suppressMouseDown` above this is belt and braces,
    // but the two cover different halves — Monaco's flag protects the selection,
    // this protects the focus.
    this.domNode.addEventListener('mousedown', (event: MouseEvent) => {
      event.preventDefault()
      event.stopPropagation()
    })
    button.addEventListener('click', (event: MouseEvent) => {
      event.preventDefault()
      event.stopPropagation()
      this.editor.focus()
      this.onPick()
    })
  }

  getId(): string {
    return 'SelectionPill'
  }

  getDomNode(): HTMLElement {
    return this.domNode
  }

  /**
   * Monaco reads this on every layout: the anchor, or null to put the capsule
   * away. The preference is always EXACT — see the note at the head of this
   * section for why the side is carried by the transform instead.
   */
  getPosition(): Monaco.editor.IContentWidgetPosition | null {
    const state = this.state
    if (state === null) return null
    return {
      position: { lineNumber: state.placement.lineNumber, column: state.placement.column },
      preference: [PILL_EXACT],
    }
  }

  /**
   * Tell the capsule whether a Tab suggestion is on screen.
   *
   * Cursor hides the capsule's button row for as long as one is; hiding the whole
   * widget comes to the same thing through the one hide path, and a suggestion
   * owns the caret line the capsule would otherwise hang from.
   */
  setSuggestionVisible(visible: boolean): void {
    if (this.suppressed === visible) return
    this.suppressed = visible
    this.update()
  }

  hide(): void {
    if (this.state === null) return
    this.state = null
    this.editor.layoutContentWidget(this)
  }

  /**
   * Recompute the anchor. Five lines, three sliding windows and no allocation
   * worth counting, so it runs on every selection change, on every edit and
   * whenever a Tab suggestion comes and goes.
   */
  update(): void {
    const next = this.place()
    const current = this.state
    if (current !== null && next !== null
      && current.transform === next.transform
      && current.placement.lineNumber === next.placement.lineNumber
      && current.placement.column === next.placement.column) return
    if (current === null && next === null) return
    this.state = next
    if (next !== null) this.body.style.transform = next.transform
    this.editor.layoutContentWidget(this)
  }

  /** The anchor to hang on, or null when the capsule should not be up at all. */
  private place(): { placement: PillPlacement; transform: string } | null {
    if (this.suppressed) return null
    const model = this.editor.getModel()
    if (model === null) return null
    const selection = this.editor.getSelection()
    if (selection === null || selection.isEmpty()) return null
    // Cursor accepts widget focus as well as text focus, which is what keeps the
    // capsule up while the user is inside one of the editor's own inputs.
    if (!this.editor.hasTextFocus() && !this.editor.hasWidgetFocus()) return null
    const caret = this.editor.getPosition()
    if (caret === null) return null
    const metrics = pillMetrics(this.editor, this.monaco)
    if (metrics === undefined) return null
    const placement = selectionPillPlacement({
      caretLine: caret.lineNumber,
      caretColumn: caret.column,
      selectionStartLine: selection.startLineNumber,
      selectionEndLine: selection.endLineNumber,
      lineCount: model.getLineCount(),
      lineLength: (lineNumber) => model.getLineLength(lineNumber),
      charBudget: metrics.charBudget,
      isWordWrap: this.isWordWrap(),
    })
    return { placement, transform: this.offset(placement, metrics) }
  }

  /**
   * The capsule's own placement: the vertical side, and the horizontal clamp.
   *
   * The vertical half is Cursor's preference, moved to CSS: above means the
   * capsule's underside sits just over the line, below means its top sits just
   * under it, and "on the line" centres it on the line's row. A percentage moves
   * the box by its own height, which is what lets the two outer cases be written
   * without measuring anything.
   *
   * The horizontal half is the same clamp Monaco would have applied for ABOVE and
   * BELOW, done here against the content area: the anchor is one column past the
   * longest line, so the capsule only needs sliding when that line is long enough
   * to have been dropped by the search's own floor and the fallback anchor landed
   * far to the right. The clamp is exact for a monospace font, which is what a
   * code editor is set in.
   */
  private offset(placement: PillPlacement, metrics: PillMetrics): string {
    const anchor = (placement.column - 1) * metrics.spaceWidth
    const dx = Math.min(0, metrics.contentWidth - PILL_RESERVE_PX - anchor)
    const dy = placement.side === PILL_ABOVE
      ? 'calc(-100% - 4px)'
      : placement.side === PILL_BELOW
        ? `${Math.round(metrics.lineHeight + 4)}px`
        : `calc(-50% + ${Math.round(metrics.lineHeight / 2)}px)`
    return `translate(${Math.round(dx)}px, ${dy})`
  }

  /**
   * Whether the editor wraps, which the search reads as "one logical line may be
   * several visual rows" and answers with a wider band.
   *
   * The override chain is the one Cursor walks — the second override wins, then
   * the first, then the plain setting — spelled with option ids rather than the
   * numbers Cursor's build had frozen into it.
   */
  private isWordWrap(): boolean {
    const options = this.editor.getOptions()
    const second = options.get(this.monaco.editor.EditorOption.wordWrapOverride2)
    const first = second === 'inherit' ? options.get(this.monaco.editor.EditorOption.wordWrapOverride1) : second
    const wrap = first === 'inherit' ? options.get(this.monaco.editor.EditorOption.wordWrap) : first
    return wrap !== 'off'
  }
}

/**
 * Format an expanded chat chip as model context: the file:line anchor line,
 * then the code in one fence.
 * @param anchor - `path:start` or `path:start-end` (workspace-relative).
 * @param range - `{ language, code }`.
 * @returns the text spliced into the prompt at submit time.
 */
function formatSnippet(anchor: string, range: { language: string; code: string }): string {
  return serializeSnippet(anchor, range.language, range.code)
}

// ---------------------------------------------------------------------------
// Small UI atoms (no external UI imports; theme tokens only)
// ---------------------------------------------------------------------------

const rowStyle = (depth: number): React.CSSProperties => ({
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
const guideRails = (depth: number, onCount: number): React.ReactNode[] => {
  const rails: React.ReactNode[] = []
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

/** The toolbar glyphs, as SVG path data. */
const ICON_PATHS = {
  files: 'M8 3h10v14H8z M5 7H3v14h11v-2',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14 M16 16l5 5',
  history: 'M3 10a9 9 0 1 1 1 7 M3 4v6h6 M12 7v5l3 2',
  createFile: 'M14 3H5v18h8 M14 3v6h6 M14 3l6 6 M18 14v8 M14 18h8',
  createDirectory: 'M13 19H3V5h7l2 3h9v5 M18 14v8 M14 18h8',
  refresh: 'M20 7a9 9 0 1 0 1 8 M20 3v5h-5',
  collapse: 'M8 3h13v13 M3 8h13v13H3z M6 14h7',
} as const

function workbenchIcon(name: keyof typeof ICON_PATHS): React.ReactElement {
  return h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, h('path', { d: ICON_PATHS[name] }))
}

/**
 * The marker a file row shows where a folder shows its twisty.
 *
 * Coloured by language family rather than drawn as an icon set: the point is
 * that the *shape* of a tree — how much of it is code, config, markup, assets —
 * reads at a glance, and seven pixels of colour does that without shipping a
 * sprite sheet or a font. The hues are the languages' own, which is what makes
 * them recognisable, so they are literal values rather than DSH tokens.
 */
const FILE_KIND_COLOR: Record<string, string> = {
  js: '#d4a017', mjs: '#d4a017', cjs: '#d4a017', jsx: '#d4a017',
  ts: '#3178c6', mts: '#3178c6', cts: '#3178c6', tsx: '#3178c6',
  css: '#a45bd6', scss: '#a45bd6', less: '#a45bd6',
  html: '#e34c26', htm: '#e34c26', xml: '#e34c26', svg: '#e34c26',
  json: '#cbcb41', jsonc: '#cbcb41', yaml: '#cbcb41', yml: '#cbcb41', toml: '#cbcb41',
  md: '#7d8590', mdx: '#7d8590', txt: '#7d8590', rst: '#7d8590',
  py: '#3572a5', rb: '#701516', go: '#00add8', rs: '#dea584',
  java: '#b07219', kt: '#a97bff', swift: '#f05138', php: '#4f5d95',
  c: '#8a8a8a', h: '#8a8a8a', cpp: '#f34b7d', cs: '#178600',
  sh: '#89e051', bash: '#89e051', zsh: '#89e051', ps1: '#4a7fbd', lua: '#5b6fbd', dart: '#00b4ab',
  sql: '#e38c00', graphql: '#e10098', vue: '#41b883', svelte: '#ff3e00',
}

/** A file's language colour, or the muted token when the extension says nothing. */
function fileKindColor(name: string): string {
  const base = name.toLowerCase()
  const dot = base.lastIndexOf('.')
  if (dot < 0) return 'var(--dsw-alias-label-quaternary, #8b949e)'
  return FILE_KIND_COLOR[base.slice(dot + 1)] ?? 'var(--dsw-alias-label-quaternary, #8b949e)'
}

// ---------------------------------------------------------------------------
// File tree (lazy, recursive)
// ---------------------------------------------------------------------------

/** What the tree asks the panel to do. */
interface FileTreeProps {
  list: (dir: string) => Promise<TreeEntry[]>
  cwd: string
  activePath: string | null
  onOpen: (path: string) => void
  joinPath: (dir: string, name: string) => string
  onAction: (action: TreeAction, target: TreeActionTarget) => Promise<ActionResult | undefined>
  refreshRevision: number
  clipboard: TreeClipboard | null
  closeMenuSignal: string | null
  onMenuOpen: () => void
}

function FileTree({ list, cwd, activePath, onOpen, joinPath, onAction, refreshRevision, clipboard, closeMenuSignal, onMenuOpen }: FileTreeProps): React.ReactNode {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([cwd]))
  const [children, setChildren] = useState<TreeChildren>({}) // dir path -> entries | 'loading' | error string
  const [menu, setMenu] = useState<TreeMenu | null>(null)
  /**
   * The row the toolbar's create actions target.
   *
   * Distinct from `activePath`, which tracks the file a tab has open — a
   * directory can be selected but never active. Kept as `{path, isDir}` so the
   * target rule matches the context menu exactly: a directory creates inside
   * itself, a file creates alongside it.
   */
  const [selected, setSelected] = useState<Selection | null>(null)
  /**
   * The extra rows a modifier-click has added to the selection.
   *
   * The tree's primary selection stays in `selected` so every existing caller —
   * the toolbar's create target, the keyboard cursor, the context menu — keeps
   * working unchanged. This set only ever holds the *additional* rows, so a
   * plain click (which clears it) restores single-selection semantics exactly.
   * Entries are `{path, isDir}` keyed by `path:isDir`, matching `selectedKey`.
   */
  const [extraSelection, setExtraSelection] = useState<Set<string>>(() => new Set())
  /** Where a Shift range starts from; see `selectRow`. */
  const selectionAnchorRef = useRef<string | null>(null)
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
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  /**
   * The in-flight drag, or null.
   *
   * `dataTransfer` is not readable during `dragover` for security, so the tree
   * remembers what it is dragging in a ref. `path` drives the "cannot drop into
   * yourself" check and `sources` is what a drop actually moves.
   */
  const dragRef = useRef<TreeDrag | null>(null)
  /** The scrolling row list, so a refresh can hold the user's place. */
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  /**
   * An in-tree name field, in place of a modal dialog.
   *
   * VS Code creates and renames *inside the tree*: the row itself becomes a
   * text field, so the new name appears where it will live and the surrounding
   * files stay visible for reference. Shape:
   * `{ mode: 'createFile'|'createDirectory', parent } | { mode: 'rename', path, isDir } | null`.
   * Indentation is derived when the tree renders, not stored here.
   */
  const [editor, setEditor] = useState<TreeEditor | null>(null)
  const [editorValue, setEditorValue] = useState('')
  /** Set when a commit fails, so the field stays open and explains itself. */
  const [editorError, setEditorError] = useState<string | null>(null)
  const editorInputRef = useRef<HTMLInputElement | null>(null)
  /** Guards against onBlur firing a second commit after Enter already did. */
  const editorSettledRef = useRef(false)
  useEffect(() => {
    const close = () => setMenu(null)
    const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
    document.addEventListener?.('click', close)
    document.addEventListener?.('keydown', keydown)
    return () => { document.removeEventListener?.('click', close); document.removeEventListener?.('keydown', keydown) }
  }, [])

  const load = useCallback((dir: string) => {
    setChildren((prev) => (prev[dir] !== undefined ? prev : { ...prev, [dir]: 'loading' }))
    list(dir).then(
      (entries) => setChildren((prev) => ({ ...prev, [dir]: entries })),
      (error: unknown) => setChildren((prev) => ({ ...prev, [dir]: `加载失败: ${String(error)}` })),
    )
  }, [list])

  useEffect(() => { load(cwd) }, [cwd, load])
  /**
   * The open-directory set, readable from an effect that must not re-run when it
   * changes.
   *
   * `expanded` is a fresh Set on every toggle, so listing it as a dependency made
   * the refresh below fire on every expand and collapse — re-reading *every* open
   * directory each time, on top of the single fetch `toggle` had already issued
   * for the folder being opened. Synced in its own effect, declared above the
   * refresh, so it is current by the time that one runs.
   */
  const expandedRef = useRef(expanded)
  useEffect(() => { expandedRef.current = expanded }, [expanded])
  /**
   * Reload every open directory when the revision changes.
   *
   * `expanded` is deliberately *not* reset — a refresh must not collapse a tree
   * the user opened — and the reload is keyed on the revision alone: opening one
   * folder is not a reason to re-read the others. The scroller's offset is
   * captured first and restored after the new rows paint, so a refresh that
   * happens to finish while the user is scrolled down does not jump them back to
   * the top.
   */
  useEffect(() => {
    const scroller = scrollerRef.current
    const offset = scroller?.scrollTop ?? 0
    for (const dir of expandedRef.current) load(dir)
    // Restore after paint, once the rebuilt list has its new height. Guarded
    // because `requestAnimationFrame` does not exist in a bare Node test host.
    const raf: (callback: () => void) => number = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (fn) => { setTimeout(fn, 0); return 0 }
    const cancel: (handle: number) => void = typeof cancelAnimationFrame === 'function'
      ? cancelAnimationFrame
      : (handle) => { clearTimeout(handle) }
    const frame = raf(() => { if (scroller) scroller.scrollTop = offset })
    return () => cancel(frame)
  }, [refreshRevision, list, load])
  useEffect(() => { setMenu(null) }, [closeMenuSignal])
  const contextMenu = (event: React.MouseEvent, path: string, isDir: boolean) => {
    event.preventDefault()
    event.stopPropagation()
    onMenuOpen?.()
    setMenu({ path, isDir, element: event.currentTarget, x: Math.max(0, Math.min(event.clientX, window.innerWidth - 230)), y: Math.max(0, Math.min(event.clientY, window.innerHeight - 380)) })
  }

  /** Row path → its live DOM node, so a selection can be focused and revealed. */
  const nodesRef = useRef(new Map<string, HTMLElement>())

  /** Put DOM focus on a row and keep it inside the scroller. */
  const focusRow = (path: string) => {
    const node = nodesRef.current.get(path)
    if (!node) return
    node.focus?.()
    node.scrollIntoView?.({ block: 'nearest' })
  }

  /** A row's identity in the selection: the same path can never be both a file and a directory. */
  const selectedKey = (row: Selection): string => `${row.path}:${row.isDir ? 'd' : 'f'}`

  /**
   * Every row currently selected, primary first.
   *
   * Consumers that act on "the selection" (delete, drag, the toolbar target)
   * read this instead of `selected`, so multi-select reaches them without each
   * call site learning about `extraSelection`.
   */
  const selectionRows = (): Selection[] => {
    if (selected === null) return []
    // The primary row is filtered out of the extras on purpose: the two sets are
    // maintained separately, so a row that is somehow in both would otherwise be
    // handed to Delete/drag twice — one success and one 404.
    const primaryKey = selectedKey(selected)
    const extras = flat.filter((row) => selectedKey(row) !== primaryKey && extraSelection.has(selectedKey(row)))
    return [selected, ...extras]
  }

  /**
   * Apply a click's selection intent, honouring the platform's modifiers.
   *
   * Plain click replaces the selection, Ctrl/Cmd-click toggles one row, and
   * Shift-click takes everything between the anchor and the clicked row in
   * *visual* order — `flat` is what the user sees, so it is what a range means.
   */
  const selectRow = (row: Selection, event?: React.MouseEvent | React.KeyboardEvent) => {
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
      const key = selectedKey(row)
      // With nothing selected there is nothing to add to, so a modifier-click
      // starts the selection exactly as a plain one would. Without this the row
      // was left unselected (the extras set hangs off `selected`).
      if (selected === null) {
        setSelected(row)
        setExtraSelection(new Set())
        selectionAnchorRef.current = key
        return
      }
      // The primary row lives in `selected`, not in `extraSelection`, so testing
      // only the extras made Ctrl-clicking it *add* it a second time: it could
      // not be deselected, and `selectionRows` then carried it twice, which made
      // Delete and drag act on the same path twice. Removing the primary
      // promotes one of the extras, so the primary is always a selected row.
      if (key === selectedKey(selected)) {
        const promoted = flat.find((item) => extraSelection.has(selectedKey(item))) ?? null
        setSelected(promoted)
        setExtraSelection((prev) => {
          const next = new Set(prev)
          if (promoted !== null) next.delete(selectedKey(promoted))
          return next
        })
        selectionAnchorRef.current = promoted === null ? null : selectedKey(promoted)
        return
      }
      setExtraSelection((prev) => {
        const next = new Set(prev)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next
      })
      selectionAnchorRef.current = key
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
  const railCountFor = (depth: number, isAncestorOfSelection: boolean): number => {
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
  const selectableEnd = (name: string): number => {
    const dot = name.lastIndexOf('.')
    return dot > 0 ? dot : name.length
  }
  /** Open the in-tree field for a create, anchored on the destination folder. */
  const openCreate = (action: 'createFile' | 'createDirectory', target: Selection) => {
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
  const openRename = (target: Selection) => {
    setEditor({ mode: 'rename', path: target.path, isDir: target.isDir })
    setEditorValue(target.path.split(/[\\/]/).at(-1) ?? '')
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
  const toggle = useCallback((dir: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(dir)) next.delete(dir)
      else { next.add(dir); load(dir) }
      return next
    })
  }, [load])

  /** The collapsed folder a drag is resting on, and the timer that will open it. */
  const dragHoverRef = useRef<{ path: string; timer: ReturnType<typeof setTimeout> } | null>(null)
  /** Abandon a pending hover-open, whatever ended the hover. */
  const cancelDragHover = () => {
    if (dragHoverRef.current === null) return
    clearTimeout(dragHoverRef.current.timer)
    dragHoverRef.current = null
  }

  /**
   * Where a toolbar create action should land, mirroring the context menu's
   * rule: a directory holds the new entry, a file shares its parent folder, and
   * with no selection the workspace root is the fallback.
   */
  const createTarget: Selection = (() => {
    if (selected === null) return { path: cwd, isDir: true }
    if (selected.isDir) return { path: selected.path, isDir: true }
    const parent = selected.path.slice(0, Math.max(selected.path.lastIndexOf('/'), selected.path.lastIndexOf('\\')))
    return { path: parent === '' ? cwd : parent, isDir: true }
  })()

  const rows: React.ReactNode[] = []
  /**
   * Every row that is actually on screen, in visual order, as the data a
   * movement key needs rather than as a DOM node. `walk` fills this in the same
   * pass that builds `rows`, so the two can never disagree.
   */
  const flat: FlatRow[] = []
  // Cleared, not reallocated: the commit's ref callbacks refill it in this same
  // pass, so a fresh Map per render was pure garbage.
  nodesRef.current.clear()
  const pushRow = (spec: FlatRow) => {
    flat.push(spec)
  }
  /**
   * The in-tree name field, rendered where a row would be.
   *
   * It is a real `<input>` inside the tree rather than a modal, so the files
   * around it stay visible and the field sits exactly where the name will land.
   * Escape and blur both abandon the edit; Enter commits it.
   */
  const pushEditorRow = (depth: number) => {
    if (editor === null) return
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
        onKeyDown: (event: React.KeyboardEvent) => {
          event.stopPropagation()
          if (event.key === 'Escape') { event.preventDefault(); closeEditor() }
          else if (event.key === 'Enter') { event.preventDefault(); void commitEditor() }
        },
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => { setEditorValue(event.target.value); if (editorError !== null) setEditorError(null) },
        // Clicking away commits an explicit name but silently drops an empty
        // one, so opening the field by accident costs nothing.
        onBlur: () => { void commitEditor() },
      })),
    editorError === null ? null : h('div', { key: 'code-workbench-inline-error', className: 'code-workbench-tree-editor-error', style: { color: T.danger } }, editorError))
  }
  const walk = (dir: string, depth: number, parent: string | null) => {
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
        const row: Selection = { path: full, isDir }
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
          ref: (node: HTMLDivElement | null) => { if (node === null) nodesRef.current.delete(full); else nodesRef.current.set(full, node) },
          'aria-level': depth + 1,
          'aria-selected': isPrimary || isExtra,
          'aria-expanded': isDir ? isOpen : undefined,
          'aria-pressed': isDir ? undefined : full === activePath,
          // The drop target for a drag-to-move. Only directories accept a drop --
          // a file has no children to move into -- and the guard lives in the
          // handler because the browser fires dragenter/dragover on every row.
          onDragOver: (event: React.DragEvent) => {
            if (!isDir || dragRef.current === null) return
            // Dropping a folder into itself (or into its own descendant) would
            // detach that subtree from the tree, so those targets stay inert.
            if (isAtOrUnder(full, dragRef.current.path)) return
            event.preventDefault()
            event.dataTransfer.dropEffect = 'move'
            if (dropTarget !== full) setDropTarget(full)
            // Resting on a collapsed folder opens it, the way every file manager
            // does: dropping into a folder whose contents you cannot see is a
            // guess. Only a *new* target restarts the clock, so travelling
            // across a folder on the way elsewhere never opens it.
            if (!isOpen && dragHoverRef.current?.path !== full) {
              cancelDragHover()
              dragHoverRef.current = {
                path: full,
                timer: setTimeout(() => {
                  dragHoverRef.current = null
                  toggle(full)
                }, DRAG_HOVER_EXPAND_MS),
              }
            }
          },
          onDragLeave: () => {
            cancelDragHover()
            if (dropTarget === full) setDropTarget(null)
          },
          onDrop: (event: React.DragEvent) => {
            if (!isDir || dragRef.current === null) return
            const drag = dragRef.current
            if (isAtOrUnder(full, drag.path)) return
            event.preventDefault()
            event.stopPropagation()
            dragRef.current = null
            setDropTarget(null)
            cancelDragHover()
            // The tree's own drop is a move into the folder. The composer's drop
            // target reads the same drag but claims a different flavor, so both
            // gestures share one drag source without colliding.
            void onAction('move', { path: drag.path, isDir: drag.isDir, sources: drag.sources, destination: full })
          },
          style: { ...rowStyle(depth), position: 'relative', ...(dropTarget === full ? { boxShadow: `inset 0 0 0 1px ${T.accent}` } : {}) },
          // Selecting and opening are separate concerns: a click both marks the
          // row (so the toolbar knows where to create) and does what the row
          // normally does -- expand a directory, or open a file.
          onClick: (event: React.MouseEvent) => {
            selectRow(row, event)
            // A modifier-click is about building a selection, so it must not
            // also toggle a folder or swap the open file out from under the user.
            if (event?.ctrlKey || event?.metaKey || event?.shiftKey) return
            isDir ? toggle(full) : onOpen(full)
          },
          // Only Enter/space belong to the row itself. Movement keys bubble to the
          // container handler, which is what makes the arrow keys work while a
          // row has focus.
          onKeyDown: (event: React.KeyboardEvent) => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.preventDefault()
            selectRow(row, event)
            isDir ? toggle(full) : onOpen(full)
          },
          onContextMenu: (event: React.MouseEvent) => {
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
          onDragStart: (event: React.DragEvent) => {
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
            cancelDragHover()
          },
          title: full,
        }, guideRails(depth, railCountFor(depth, carriesChain)),
          // A folder turns its twisty; a file shows what kind of file it is.
          // Both sit in the same 12px box so names stay on one column.
          isDir
            ? h('svg', {
              className: 'code-workbench-tree-twisty',
              'data-open': isOpen ? 'true' : 'false',
              width: 12, height: 12, viewBox: '0 0 12 12',
              'aria-hidden': true,
              style: { color: T.fgMuted },
            }, h('path', { d: 'M4 2.5 L8 6 L4 9.5', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }))
            : h('span', { className: 'code-workbench-tree-kind', 'aria-hidden': true, style: { color: fileKindColor(entry.name) } }),
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
  // Deliberately not `useCallback`: `flat` is rebuilt on every render, so the
  // memo could never hit — it only paid for a dependency array that was new each
  // time. The handler is read straight from this render's scope, which is what it
  // needs to be anyway (it must see the rows that are on screen right now).
  const moveSelection = (step: number, extend: boolean) => {
    const current = selected === null ? -1 : flat.findIndex((row) => row.path === selected.path && row.isDir === selected.isDir)
    if (current < 0) {
      const edge = step > 0 ? flat[0] : flat.at(-1)
      if (edge) setSelected({ path: edge.path, isDir: edge.isDir })
      return
    }
    const nextIndex = current + step
    if (nextIndex < 0 || nextIndex >= flat.length) return
    const next = flat[nextIndex]
    if (next === undefined) return
    // Shift+arrow grows the selection instead of replacing it, anchored where
    // the plain-key navigation last started.
    if (extend) {
      if (selectionAnchorRef.current === null) selectionAnchorRef.current = selectedKey(flat[current] ?? next)
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
  }
  const handleTreeKeys = (event: React.KeyboardEvent) => {
    // While the name field is open it owns every key — arrows move the caret,
    // Delete erases characters. `stopPropagation` in the field usually keeps
    // events from arriving here, but this guard makes it airtight.
    if (editor !== null) return
    const row = selected === null ? -1 : flat.findIndex((item) => item.path === selected.path && item.isDir === selected.isDir)
    const target = row >= 0 ? flat[row] ?? null : null
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
          void onAction('delete', rowsToDelete.length > 1
            ? { path: target.path, isDir: target.isDir, sources: rowsToDelete.map((row) => row.path) }
            : { path: target.path, isDir: target.isDir })
        }
        return
      default:
    }
  }
  // Keyboard navigation drives the selection, so the selection drives reveal —
  // and nothing else does. A refresh or an expand is not a selection change, and
  // keying on them pulled the caret out of the editor after every file operation
  // (each one bumps `refreshRevision`), so a file created from the tree could not
  // be typed into until the user clicked back in.
  useEffect(() => {
    if (selected === null) return
    focusRow(selected.path)
  }, [selected?.path, selected?.isDir])
  const items: Array<[TreeAction, string]> = menu ? [
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
  const menuAction = (action: TreeAction, target: Selection) => {
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
      void onAction('delete', inSelection && rowsToDelete.length > 1
        ? { ...target, sources: rowsToDelete.map((row) => row.path) }
        : target)
      return
    }
    void onAction(action, target)
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
  const clearSelection = (event: React.MouseEvent) => {
    const target = event?.target as (EventTarget & { closest?: (selector: string) => Element | null }) | null
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
    onContextMenu: (event: React.MouseEvent) => contextMenu(event, cwd, true),
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
    h('div', { style: rowStyle(0), onContextMenu: (event: React.MouseEvent) => contextMenu(event, cwd, true) }, cwd.split(/[\\/]/).filter(Boolean).at(-1)),
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
      onMouseLeave: () => { setPointerInTree(false); setDropTarget(null); cancelDragHover() },
    }, rows),
    menu ? h('div', { role: 'menu', className: 'code-workbench-context-menu', style: { left: menu.x, top: menu.y }, onClick: (event: React.MouseEvent) => event.stopPropagation() },
      items.map(([action, label]) => h('button', { key: action, type: 'button', role: 'menuitem', disabled: action === 'paste' && !clipboard || ['cut', 'rename', 'delete'].includes(action) && menu.path === cwd, onClick: () => { const target = menu; setMenu(null); menuAction(action, target) } }, label))) : null)
}

// ---------------------------------------------------------------------------
// The tab body
// ---------------------------------------------------------------------------

function CodePanel(props: DSH.CodePanelProps): React.ReactNode {
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
  const pluginSettings: PluginSettings = usePluginSettings(settingsForm).value ?? defaultSettings
  const settingsRef = useRef(pluginSettings)
  settingsRef.current = pluginSettings
  const cwd = useSessions((sessions) => sessions.byId?.[sessionId]?.cwd) ?? ''

  const hostRef = useRef<HTMLDivElement | null>(null)   // monaco container
  const editorRef = useRef<Editor | null>(null)         // monaco editor instance
  const stateRef = useRef<EditorState>({ path: null, version: null, dirty: false, text: '', model: null })
  const saveRef = useRef<((note?: string, target?: EditorState) => Promise<void>) | null>(null)  // latest save, for the editor keybinding
  const openFileRef = useRef<((path: string, reveal?: Reveal, reload?: boolean) => Promise<void>) | null>(null)  // latest openFile, for the change watch
  const addToChatRef = useRef<(() => void) | null>(null)  // latest Add-to-Chat, for the editor keybinding
  // The provider's one official "ask me again" channel, published by the editor
  // effect below. It is not a keystroke — see the note where it is called.
  const refreshCompletionsRef = useRef<(() => void) | null>(null)
  // The ghost-text round trips currently on the wire, keyed by completion
  // context. A second ask for the same caret joins the first instead of
  // answering "no suggestion": Monaco records an empty answer as the verdict for
  // that model version, so a busy moment would cost the user another keystroke.
  const inFlightRef = useRef(new Map<string, Promise<CompletionAnswer>>())
  // Whether the official change stream for the open file is delivering, and since
  // when. It decides how much the version fallback below is allowed to ask, so
  // the two effects share it through a ref — a state update would re-render.
  const watchHealthRef = useRef({ healthy: false, since: 0 })
  const openRequestRef = useRef(0)
  const buffersRef = useRef(new Map<string, Buffer>())
  const dialogResolveRef = useRef<((value: boolean | string | null) => void) | null>(null)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [dialogValue, setDialogValue] = useState('')
  const askDialog = (title: string, value?: string): Promise<boolean | string | null> => new Promise((resolve) => {
    dialogResolveRef.current?.(null)
    dialogResolveRef.current = resolve
    setDialogValue(value ?? '')
    setDialog({ title, input: value !== undefined })
  })
  const finishDialog = (accepted: boolean) => {
    // Unreachable: both call sites live inside the `dialog ? …` branch below, so
    // a dialog is always mounted when this runs. Stated rather than assumed,
    // because the resolver below reads `dialog.input`.
    if (dialog === null) return
    dialogResolveRef.current?.(accepted ? dialog.input ? dialogValue : true : null)
    dialogResolveRef.current = null
    setDialog(null)
  }
  useEffect(() => () => { dialogResolveRef.current?.(null) }, [])

  const [monaco, setMonaco] = useState<MonacoApi | null>(null)
  const [activePath, setActivePath] = useState<string | null>(null)
  const [openPaths, setOpenPaths] = useState<string[]>([])
  const [status, setStatusText] = useState('就绪')
  /**
   * How the status line should read.
   *
   * `idle` paints nothing, and that is the point: the dot marks the states a
   * person has to *notice* — a failure, a warning, something still running —
   * rather than decorating every save. A marker that appears on every success
   * stops carrying information.
   */
  const [statusLevel, setStatusLevel] = useState<StatusLevel>('idle')
  /**
   * Report what just happened, and how it went.
   *
   * The level only drives the status dot; the sentence is unchanged, so every
   * existing caller keeps working by saying nothing about severity at all.
   */
  const setStatus = (text: string, level: StatusLevel = 'idle'): void => {
    setStatusText(text)
    setStatusLevel(level)
  }
  const [dirty, setDirty] = useState(false)
  const [leftMode, setLeftMode] = useState<'tree' | 'search' | 'history'>('tree')
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [result, setResult] = useState<SearchReport | { error: string } | null>(null)
  const [history, setHistory] = useState<HistoryReport | { error: string } | null>(null)
  const [hasSelection, setHasSelection] = useState(false)
  const [navigationOpen, setNavigationOpen] = useState(true)
  const [completionStatus, setCompletionStatus] = useState('AI 补全就绪')
  const [editRevision, setEditRevision] = useState(0)
  const [treeRevision, setTreeRevision] = useState(0)
  const [treeClipboard, setTreeClipboard] = useState<TreeClipboard | null>(null)
  const [tabMenu, setTabMenu] = useState<{ path: string; x: number; y: number } | null>(null)
  /**
   * The tab strip's in-flight drag and where it would land.
   *
   * `dataTransfer` cannot be read during `dragover`, so the path being dragged
   * lives in a ref; `tabDrop` is `{path, side}` for the tab under the pointer,
   * which is what draws the insertion marker. Both are cleared on drag end,
   * including a drag that ended over the composer instead of the strip.
   */
  const tabDragRef = useRef<string | null>(null)
  const [tabDrop, setTabDrop] = useState<{ path: string; side: 'before' | 'after' } | null>(null)
  /** The active tab's element, so the strip can keep it in view. */
  const activeTabRef = useRef<HTMLElement | null>(null)
  /**
   * Keep the tab you are editing inside the strip.
   *
   * The strip scrolls, and a tab opened from the tree or a search hit lands at
   * its far end — which is how "which file am I in" stops being answerable at a
   * glance, the one question the strip exists to answer. `block: 'nearest'`
   * keeps this from scrolling the panel vertically on the way past.
   */
  useEffect(() => {
    activeTabRef.current?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' })
  }, [activePath])

  // ---- published updates ---------------------------------------------------
  // Asked once per mount: the panel is opened constantly and a release is rare,
  // so one read per mount is the whole budget this costs anyone.
  const [release, setRelease] = useState<Release | null>(null)
  const [updateBusy, setUpdateBusy] = useState(false)
  const [updateNote, setUpdateNote] = useState('')

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    fetch(UPDATE_CHECK_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: controller.signal })
      .then((response) => response.json())
      .then((answer: { ok?: boolean; hasUpdate?: boolean; latest?: string; needsRestart?: boolean }) => {
        if (cancelled || answer?.ok !== true || answer.hasUpdate !== true) return
        setRelease({ latest: answer.latest ?? '', needsRestart: answer.needsRestart === true })
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
      const answer = await response.json() as { ok?: boolean; applied?: boolean; version?: string; needsRestart?: boolean; error?: { message?: string } }
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
    loadMonaco().then((m) => { if (live) setMonaco(m) }, (error: unknown) => setStatus(`Monaco 加载失败: ${error instanceof Error ? error.message : String(error)}`, 'error'))
    return () => { live = false }
  }, [])

  const joinPath = useCallback((dir: string, name: string): string => {
    const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/'
    return dir.endsWith(sep) ? dir + name : dir + sep + name
  }, [])

  /** Resolve the wire path (absolute under the workspace). */
  const list = useCallback((dir: string): Promise<TreeEntry[]> => files.list(sessionId, dir, undefined).then((res) => {
    if (res?.ok) return res.value.entries
    throw new Error(res?.error?.code ?? 'list failed')
  }), [files, sessionId])

  // ---- editor lifecycle -------------------------------------------------
  useEffect(() => {
    if (!monaco || !hostRef.current || editorRef.current) return
    const editor = monaco.editor.create(hostRef.current, {
      value: '',
      language: 'plaintext',
      theme: monacoTheme(monaco),
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
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => { void saveRef.current?.() })
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyL, () => { addToChatRef.current?.() })
    // The same action, in the editor's own context menu. Ctrl+L was the only way
    // to reach Add to Chat, and a right-click on a selection is where people look
    // for it first. The selection capsule below is the third way in.
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
    // The capsule. One widget for the life of the editor: showing and hiding is
    // `getPosition()` answering null, so nothing is added to or removed from the
    // editor's content-widget list while the user types.
    const pill = new SelectionPill({ editor, monaco, onPick: () => { addToChatRef.current?.() } })
    editor.addContentWidget(pill)
    const selectionListener = editor.onDidChangeCursorSelection(() => {
      setHasSelection(!editor.getSelection()?.isEmpty())
      // A selection the user drew by hand supersedes whatever suggestion was on
      // screen when it started, and the capsule reads the same event to move.
      pill.setSuggestionVisible(false)
      pill.update()
    })
    const blurListener = editor.onDidBlurEditorText(() => { pill.hide() })
    // Cursor hides the capsule when the line it hangs from has been deleted.
    // Re-running the search is that, plus the case an edit above the capsule
    // moved its line — and the search is cheap enough to just redo.
    const contentListener = editor.onDidChangeModelContent(() => {
      pill.setSuggestionVisible(false)
      pill.update()
    })
    // Tab-completion ghost text: Monaco renders the preview and accepts on Tab;
    // this provider only answers "what should be inserted at the caret".
    // `refreshListeners` holds the listeners Monaco attaches to the provider's
    // change announcement, declared below.
    const refreshListeners = new Set<CompletionsChangedListener>()
    const completions = monaco.languages.registerInlineCompletionsProvider('*', {
      debounceDelayMs: 180,
      // Monaco wires this up only for a provider that declares it, and only for
      // the focused editor. The trigger it fires is a plain one rather than an
      // *Explicit* one, so a request already in flight for the same caret is
      // reused instead of cancelled — which is precisely what the removed 400ms
      // nudge got wrong. This is the only channel through which this provider is
      // allowed to ask to be asked again.
      onDidChangeInlineCompletions(listener) {
        refreshListeners.add(listener)
        return { dispose() { refreshListeners.delete(listener) } }
      },
      async provideInlineCompletions(model, position, _context, token) {
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
        //
        // Handing back a suggestion is also the only moment this side knows one
        // is on screen, and a suggestion occupies the very strip the capsule
        // hangs in — Cursor reads the same fact off its suggestion service and
        // hides the capsule's button row for it. Suppressing here rather than at
        // each `return` means every path that produces ghost text, present and
        // future, carries the rule. `disposeInlineCompletions` below is the
        // other half, and Monaco calls it on a caret move, on Esc, on Tab, and
        // when a new request replaces the items this one returned.
        const ghostText = (text: string): Monaco.languages.InlineCompletions => {
          pill.setSuggestionVisible(true)
          return {
            items: [{
              insertText: text,
              range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column),
            }],
          }
        }
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
          // The request we joined answered nothing worth showing: abandoned, or
          // blank — and a blank answer is not remembered, for the reason the
          // cache write gives. Fall through and ask again under this request's
          // own cancellation.
        }
        const controller = new AbortController()
        const onCancel = token.onCancellationRequested?.(() => controller.abort())
        setCompletionStatus('AI 补全生成中…')
        // Never rejects, so a joined ask can await it bare, and the text reaches
        // the cache no matter which ask happened to own the connection.
        const pending: Promise<CompletionAnswer> = (async () => {
          try {
            const text = await streamCompletion({
              sessionId,
              path: st.path,
              language: model.getLanguageId(),
              prefix,
              suffix,
            }, controller.signal)
            const insertText = stripFences(text, true).slice(0, 2000)
            // Only an answer with something to insert is remembered. The cache
            // means "this caret has already been answered", and a remembered
            // blank would hand those spaces back to every later ask for it.
            if (!isBlankAnswer(insertText)) {
              completionCache.set(cacheKey, insertText)
              while (completionCache.size > 40) completionCache.delete(completionCache.keys().next().value as string)
            }
            return { ok: true, text: insertText }
          } catch (error: unknown) {
            setCompletionStatus(controller.signal.aborted ? 'AI 补全已取消' : `AI 补全失败：${error instanceof Error ? error.message : String(error)}`)
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
          // An empty answer and a blank one are the same news; the predicate
          // carries the reason a blank is one of them.
          if (isBlankAnswer(answer.text)) {
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
      // The ghost text has gone, so the caret is the capsule's again. Monaco
      // calls this even for an empty item list, so the flag cannot survive a
      // suggestion that was disposed without ever being shown.
      disposeInlineCompletions: () => { pill.setSuggestionVisible(false) },
    })
    // Announcing a change is how this plugin asks for a suggestion at a moment
    // Monaco would not ask at all. Monaco asks on a typed character, on paste,
    // and on Tab and Delete; it does *not* ask when the caret arrives by any
    // other route, and a cursor move actively drops the ghost text that is
    // showing. So opening a file, switching to its tab, watching it reload from
    // disk or rolling it back all left the caret bare until a keystroke. A 400ms
    // nudge after every content change used to cover those by accident — a load
    // is a content change — but so is a keystroke, and there the nudge cancelled
    // the automatic request that keystroke had just made. This announces the
    // change only where the content settled without typing.
    refreshCompletionsRef.current = () => { for (const listener of [...refreshListeners]) listener() }
    const observer = new MutationObserver(() => monaco.editor.setTheme(monacoTheme(monaco)))
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
    return () => {
      completions.dispose()
      refreshListeners.clear()
      refreshCompletionsRef.current = null
      // The map outlives the editor; drop it so a torn-down panel cannot hand a
      // later instance a promise from the previous one.
      inFlightRef.current.clear()
      selectionListener.dispose()
      blurListener.dispose()
      contentListener.dispose()
      // The capsule's node needs no unwinding of its own, and that is the second
      // reason it is registered once rather than on every selection change: it is
      // a child of the editor's own DOM, and `editor.dispose()` detaches that
      // whole subtree from the host. (`removeContentWidget` on its own is only
      // `domNode.remove()`; Monaco clears its content-widget map without touching
      // the DOM.) The listeners go first so nothing can fire mid-teardown.
      observer.disconnect()
      editor.dispose()
      editorRef.current = null
      for (const buffer of buffersRef.current.values()) buffer.model.dispose()
      buffersRef.current.clear()
    }
  }, [monaco, sessionId])

  // ---- save (Ctrl+S + button) ------------------------------------------
  const save = useCallback(async (note?: string, target?: EditorState): Promise<void> => {
    const st = target ?? stateRef.current
    const editor = editorRef.current
    if (!editor || st.path === null) return
    if (st.saving) return
    st.saving = true
    const text = st.model.getValue()
    setStatus('保存中…', 'busy')
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
      const body = await response.json().catch(() => ({})) as { ok?: boolean; version?: unknown; error?: { code?: string } }
      if (!response.ok || body.ok === false) {
        const code = body.error?.code ?? `HTTP ${response.status}`
        const message = code === 'FS_STALE_VERSION'
          ? '保存失败: 文件已被其他进程修改（版本冲突），请重新打开后重试'
          : code === 'FS_SANDBOX_DENIED'
            ? '保存失败: 沙箱策略拒绝写入（会话文件策略为只读时无法保存；请在对话区把权限切到可写）'
            : `保存失败: ${code}`
        setStatus(message, 'error')
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
    } catch (error: unknown) {
      setStatus(`保存失败: ${error instanceof Error ? error.message : String(error)}`, 'error')
    } finally {
      st.saving = false
    }
  }, [sessionId])

  useEffect(() => {
    if (!pluginSettings.autoSave || !dirty || activePath === null) return
    const timer = setTimeout(() => { void save('自动保存') }, 900)
    return () => clearTimeout(timer)
  }, [activePath, dirty, editRevision, pluginSettings.autoSave, save])

  // ---- open a file ------------------------------------------------------
  const openFile = useCallback(async (path: string, reveal?: Reveal, reload = false): Promise<void> => {
    const editor = editorRef.current
    // The editor is created from this namespace, so an editor implies it is
    // bound — but the guard below only narrows `editor`, and every use of the
    // namespace inside this closure would otherwise need a `!`. Binding it once
    // keeps that invariant stated in one place instead of asserted at each use.
    const monacoApi = monaco
    if (!editor || !monacoApi) return
    const requestId = ++openRequestRef.current
    const previous = stateRef.current
    const previousText = editor.getValue()
    if (previous.model) previous.viewState = editor.saveViewState?.()
    if (previous.path !== path && previous.dirty && settingsRef.current.autoSave) void saveRef.current?.('自动保存', previous)
    setStatus(`读取 ${path} …`, 'busy')
    try {
      let buffer = buffersRef.current.get(path)
      if (!buffer || reload) {
        let offset = 1
        let text = ''
        let version: unknown = null
        for (let page = 0; page < 40; page++) {
          const res = await files.read(sessionId, path, { offset }, undefined)
          if (!res?.ok) {
            // Carry the code, not just the message: whether this file belongs to
            // the official preview is a decision on the code (`NON_TEXT_CODES`).
            const failure = new Error(res?.error?.code ?? 'read failed') as Error & { code?: string }
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
          setStatus('文件读取期间发生编辑，保留未保存内容', 'warn')
          return
        }
        const uri = monacoApi.Uri.parse(`inmemory://code-workbench/${sessionId}/${path}`)
        if (buffer?.dirty) {
          setStatus('磁盘文件已更新，保留未保存修改', 'warn')
          return
        }
        if (buffer) {
          if (buffer.model.getValue() !== text) buffer.model.setValue(text)
          buffer.text = text
          buffer.version = version
          buffer.dirty = false
        } else {
          const existing = monacoApi.editor.getModel(uri)
          if (existing) existing.dispose()
          const model = monacoApi.editor.createModel(text, languageForPath(monacoApi, path), uri)
          buffer = { path, version, dirty: false, text, model }
          buffersRef.current.set(path, buffer)
          model.onDidChangeContent(() => {
            const st = buffer!
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
        const range = new monacoApi.Range(lineNumber, column, lineNumber, Math.max(column, endColumn))
        editor.setSelection(range)
        editor.revealLineInCenter(lineNumber)
        const decorations = editor.deltaDecorations([], [{ range, options: { className: 'code-workbench-flash' } }])
        setTimeout(() => { editor.deltaDecorations(decorations, []) }, 1500)
      }
      // Arriving at a file is the case Monaco never asks about: the text came
      // from the read route, not from a keystroke. Announce the change so the
      // suggestion can appear where the caret was left, without typing first.
      refreshCompletionsRef.current?.()
    } catch (error: unknown) {
      // A file the text channel refuses is not a dead end. Hand it to the
      // official document preview instead of reporting a raw code the user can
      // do nothing with — and leave this panel exactly as it was: no tab, no
      // model, the open file still open.
      const code = (error as { code?: string })?.code
      if (code !== undefined && NON_TEXT_CODES.has(code) && openInDocumentPreview(sidebarRight, sessionId, cwd, path)) {
        setStatus(NON_TEXT_HANDOFF_STATUS)
        return
      }
      const hint = code !== undefined && NON_TEXT_CODES.has(code) ? NON_TEXT_NO_PREVIEW_SUFFIX : ''
      setStatus(`读取失败: ${error instanceof Error ? error.message : String(error)}${hint}`, 'error')
    }
  }, [files, monaco, sessionId])

  // ---- external change watch (auto-reload on external edits) --------
  useEffect(() => {
    const path = activePath
    if (!path || typeof watchStream !== 'function') return
    let cancelled = false
    let dispose: (() => void) | null = null
    void (async () => {
      try {
        const stream = watchStream<DSH.WorkspaceFileWatchFrame>({
          name: `code-workbench watch ${path}`,
          open: (signal) => files.changes(sessionId, path, signal),
          ended: () => new Error('watch ended'),
        })
        dispose = () => stream.dispose()
        for await (const item of stream) {
          if (cancelled) break
          // A bare frame, not a `RemoteResult`: the transport reports a stream
          // failure by ending the iteration, so there is no error frame to
          // unwrap and an `ok === true` test here would drop every one of them.
          const frame = item.value
          if (frame?.kind === 'ready') {
            watchHealthRef.current = { healthy: true, since: Date.now() }
            item.accept()
          } else if (frame?.kind === 'change') {
            if (stateRef.current.dirty) {
              setStatus('⚠ 文件已在磁盘上更改；你有未保存的修改（重新点开文件可查看最新内容）', 'warn')
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
          setStatus('⚠ 磁盘文件已更新，保留你的未保存修改', 'warn')
        } else {
          await openFileRef.current?.(path, undefined, true)
        }
      } catch (error: unknown) {
        if (!controller.signal.aborted) setStatus(`文件同步检查失败：${error instanceof Error ? error.message : String(error)}`, 'error')
      } finally {
        checking = false
      }
    }
    const onFocus = () => { void checkVersion(true) }
    const timer = setInterval(() => { void checkVersion() }, POLL_INTERVAL_MS)
    window.addEventListener?.('focus', onFocus)
    void checkVersion()
    return () => {
      controller.abort()
      clearInterval(timer)
      window.removeEventListener?.('focus', onFocus)
    }
  }, [activePath, files, sessionId])

  // ---- codebase search (@codebase retrieval) ----------
  /**
   * The query the most recent search was issued for.
   *
   * The debounce below and Enter both want to run a search, and this is what
   * keeps them from running the same one twice: Enter marks the query here as it
   * fires, so the pending timer finds its work already done and stands down.
   */
  const lastSearchedRef = useRef<string | null>(null)
  const runSearch = useCallback(async (): Promise<void> => {
    const q = query.trim()
    if (q === '') return
    lastSearchedRef.current = q
    setSearching(true)
    setResult(null)
    try {
      const response = await fetch(SEARCH_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // No `directory`: the panel has no scope picker, so a search is always
        // the whole workspace. The Host route still accepts one.
        body: JSON.stringify({ sessionId, query: q }),
      })
      const body = await response.json().catch(() => ({})) as SearchReport & { ok?: boolean; error?: { message?: string; code?: string } }
      if (!response.ok || body.ok === false) {
        throw new Error(body.error?.message ?? body.error?.code ?? `HTTP ${response.status}`)
      }
      setResult(body)
    } catch (error: unknown) {
      setResult({ error: String(error instanceof Error ? error.message : error) })
    } finally {
      setSearching(false)
    }
  }, [query, sessionId])

  // Typing pauses into a search; Enter does not wait for the pause. Keyed on the
  // query, so each keystroke restarts the clock and only the last pause is ever
  // spent — and the guard inside means a search Enter already ran is not
  // repeated when the abandoned timer would have fired.
  useEffect(() => {
    const q = query.trim()
    if (q === '' || q === lastSearchedRef.current) return
    const timer = setTimeout(() => {
      if (lastSearchedRef.current === q) return
      void runSearch()
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query, runSearch])

  // ---- save journal (checkpoints) --------------------------------------
  const loadHistory = useCallback(async (): Promise<void> => {
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
      const body = await response.json().catch(() => ({})) as { ok?: boolean; entries?: HistoryEntry[]; error?: { message?: string; code?: string } }
      if (!response.ok || body.ok === false) {
        throw new Error(body.error?.message ?? body.error?.code ?? `HTTP ${response.status}`)
      }
      setHistory({ entries: body.entries ?? [] })
    } catch (error: unknown) {
      setHistory({ error: String(error instanceof Error ? error.message : error) })
    }
  }, [sessionId])

  const rollback = useCallback(async (id: string): Promise<void> => {
    const path = stateRef.current.path
    if (path === null) return
    if (stateRef.current.dirty || stateRef.current.saving) { setStatus('请先保存当前文件的修改，并等待保存完成后回滚', 'warn'); return }
    setStatus('回滚中…', 'busy')
    try {
      const response = await fetch(ROLLBACK_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, path, id }),
      })
      const body = await response.json().catch(() => ({})) as { ok?: boolean; error?: { message?: string; code?: string } }
      if (!response.ok || body.ok === false) {
        throw new Error(body.error?.message ?? body.error?.code ?? `HTTP ${response.status}`)
      }
      setStatus('已回滚：文件恢复到该次保存之前的内容')
      await openFile(path, undefined, true)
      await loadHistory()
    } catch (error: unknown) {
      setStatus(`回滚失败: ${error instanceof Error ? error.message : String(error)}`, 'error')
    }
  }, [loadHistory, openFile, sessionId])

  // ---- Add to Chat (selection → a reference chip in the main draft) -----
  // The chip look: the draft shows a small chip (`a.js:3-5 · 3 行`), and the
  // code expands only at submit through this plugin's reference codec.
  const addToChat = useCallback((): void => {
    const editor = editorRef.current
    const model = editor?.getModel()
    if (!editor || !model) return
    const selection = editor.getSelection()
    if (!selection || selection.isEmpty()) {
      setStatus('先选中要添加到对话的代码，再按 Ctrl+L', 'warn')
      return
    }
    const scope = typeof sessionsScope === 'function' ? sessionsScope(sessionId) : undefined
    if (scope === undefined || typeof inputActions?.captureInsertion !== 'function') {
      setStatus('对话输入框尚不可用，请稍后再试', 'warn')
      return
    }
    const code = model.getValueInRange(selection)
    const path = stateRef.current.path ?? '(未保存文件)'
    const rel = relativeToCwd(path, cwd) || path
    const startLine = selection.startLineNumber
    const endLine = selection.endLineNumber
    const lines = endLine - startLine + 1
    const anchor = lines === 1 ? `${rel}:${startLine}` : `${rel}:${startLine}-${endLine}`
    const reference: ChatReference = {
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
      : '添加失败：对话输入框正忙（正在提交？），请重试', applied ? 'done' : 'error')
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
    const accepts = (event: DragEvent): DataTransfer | null => {
      const types = event.dataTransfer?.types
      if (!types) return null
      // `types` is a DOMStringList in some engines; normalize before probing.
      const has = typeof types.includes === 'function'
        ? (name: string) => types.includes(name)
        : (name: string) => Array.from(types).includes(name)
      // Our flavor must be present *and* no real file payload, so an OS file
      // drag that merely passes over the tree is never hijacked.
      if (!has(TREE_DRAG_MIME) || has('Files')) return null
      const target = event.target as (EventTarget & { closest?: (selector: string) => Element | null }) | null
      if (!target || typeof target.closest !== 'function') return null
      return target.closest('[data-composer-input]') !== null ? event.dataTransfer : null
    }
    const onDragOver = (event: DragEvent) => {
      const dataTransfer = accepts(event)
      if (dataTransfer === null) return
      event.preventDefault()
      event.stopPropagation()
      dataTransfer.dropEffect = 'copy'
      setStatus(`松开即把文件加入对话`, 'busy')
    }
    const onDrop = (event: DragEvent) => {
      const dataTransfer = accepts(event)
      if (dataTransfer === null) return
      // Claim the gesture from Lexical before it can insert raw text.
      event.preventDefault()
      event.stopPropagation()
      const parsed = parseTreeDragPayload(dataTransfer.getData(TREE_DRAG_MIME))
      if (parsed === null) {
        setStatus('拖入的文件无法识别，请重试', 'warn')
        return
      }
      const scope = typeof sessionsScope === 'function' ? sessionsScope(sessionId) : undefined
      if (scope === undefined || typeof inputActions?.captureInsertion !== 'function') {
        setStatus('对话输入框尚不可用，请稍后再试', 'warn')
        return
      }
      const label = `${parsed.path}${parsed.directory ? '/' : ''}`
      const reference: ChatReference = {
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
        : '添加失败：对话输入框正忙（正在提交？），请重试', applied ? 'done' : 'error')
    }
    // Capture phase, so these outrank Lexical's bubble-phase listeners.
    document.addEventListener?.('dragover', onDragOver, true)
    document.addEventListener?.('drop', onDrop, true)
    return () => {
      document.removeEventListener?.('dragover', onDragOver, true)
      document.removeEventListener?.('drop', onDrop, true)
    }
  }, [inputActions, sessionId, sessionsScope])

  const treeAction = async (action: TreeAction, target: TreeActionTarget): Promise<ActionResult | undefined> => {
    const path = target.path
    const parent = path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')))
    const directory = target.isDir ? path : parent
    try {
      if (action === 'copyPath' || action === 'copyRelativePath') {
        await navigator.clipboard.writeText(action === 'copyPath' ? path : relativeToCwd(path, cwd) || '.')
      } else if (action === 'reveal') {
        await session.openWorkspacePath({ path, action: 'reveal' }, undefined)
      } else if (action === 'copy' || action === 'cut') {
        setTreeClipboard({ path, isDir: target.isDir, operation: action })
        setStatus('已加入文件剪贴板，请右键目标文件夹并选择粘贴')
        return
      } else if (action === 'addToChat') {
        const scope = sessionsScope?.(sessionId)
        if (!scope || !inputActions?.captureInsertion) throw new Error('对话输入框尚未就绪')
        const relative = relativeToCwd(path, cwd) || '.'
        const reference: ChatReference = { source: 'code-workbench', ref: { path: relative, directory: target.isDir, pathOnly: true }, label: relative, appearance: 'file', clipboardText: referenceMention(relative, target.isDir === true) }
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
        const folder = target.destination ?? path
        const sources = target.sources ?? [path]
        const moves = sources
          .filter((item) => !isAtOrUnder(folder, item))
          .map((item) => ({ from: item, to: joinPath(folder, item.split(/[\\/]/).at(-1) ?? '') }))
          .filter((item) => item.to !== item.from)
        if (moves.length === 0) { setStatus('文件已经位于这个文件夹', 'warn'); return { ok: true } }
        const moved: Array<{ from: string; to: string }> = []
        for (const move of moves) {
          const response = await fetch('/api/code-workbench/file-operation', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, operation: 'rename', path: move.from, destination: move.to }) })
          const result = await response.json() as { ok?: boolean; error?: { message?: string } }
          if (!response.ok || !result.ok) { setStatus(`移动失败：${result.error?.message ?? `HTTP ${response.status}`}`, 'error'); break }
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
            // Detach before disposing, exactly as the rename/delete paths do: the
            // editor must not be left holding a disposed model between here and
            // the `openFile` that re-opens the moved file below.
            if (buffer === stateRef.current) editorRef.current?.setModel(null)
            buffer.model.dispose()
          }
          setOpenPaths((paths) => rewriteOpenPaths(paths, move.from, move.to))
        }
        const current = stateRef.current.path
        const followed = moved.find((move) => current !== null && isAtOrUnder(current, move.from))
        if (followed && current !== null) {
          stateRef.current = { path: null, version: null, dirty: false, text: '', model: null }
          setActivePath(null)
          setDirty(false)
          await openFile(followed.to + current.slice(followed.from.length))
        }
        setStatus(moved.length === 1 ? '已移动' : `已移动 ${moved.length} 项`)
        return { ok: true }
      } else {
        let operation: string = action
        let source = path
        let destination: string | undefined
        if (action === 'paste') {
          if (!treeClipboard) return
          source = treeClipboard.path
          destination = joinPath(directory, source.split(/[\\/]/).at(-1) ?? '')
          operation = treeClipboard.operation === 'cut' ? 'rename' : 'copy'
          if (operation === 'rename' && destination === source) {
            setStatus('文件已经位于这个文件夹，请选择其他目标文件夹', 'warn')
            return
          }
          if (operation === 'copy') {
            const entries = await list(directory)
            const names = new Set(entries.map((entry) => entry.name.toLowerCase()))
            const originalName = source.split(/[\\/]/).at(-1) ?? ''
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
            const done: string[] = []
            for (const item of sources) {
              const response = await fetch('/api/code-workbench/file-operation', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, operation: 'delete', path: item }) })
              const result = await response.json() as { ok?: boolean; error?: { message?: string } }
              if (!response.ok || !result.ok) { setStatus(`删除 ${item} 失败：${result.error?.message ?? `HTTP ${response.status}`}`, 'error'); break }
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
              stateRef.current = { path: null, version: null, dirty: false, text: '', model: null }
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
            if (destination === path) { setStatus('名称未改变', 'warn'); return { ok: true } }
            // A destination nested under the source is refused by the host too,
            // but there it is a bare rejection. Catch it here so the field can
            // explain itself and keep the typed name.
            if (destination.startsWith(`${path}/`) || destination.startsWith(`${path}\\`)) return { ok: false, error: '名称不能嵌套在自身之下' }
          } else source = joinPath(directory, name.trim())
        }
        const affected = [...buffersRef.current.values()].filter((buffer) => isAtOrUnder(buffer.path, source))
        if (['rename', 'delete'].includes(operation) && affected.some((buffer) => buffer.dirty || buffer.saving)) throw new Error('请先保存受影响文件的修改，并等待保存完成')
        const response = await fetch('/api/code-workbench/file-operation', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, operation, path: source, destination }) })
        const result = await response.json() as { ok?: boolean; error?: { message?: string } }
        if (!response.ok || !result.ok) throw new Error(result.error?.message ?? `HTTP ${response.status}`)
        if (action === 'paste' && treeClipboard?.operation === 'cut') setTreeClipboard(null)
        setTreeRevision((revision) => revision + 1)
        const current = stateRef.current.path
        if (operation === 'rename' || operation === 'delete') {
          for (const buffer of affected) {
            buffersRef.current.delete(buffer.path)
            if (buffer === stateRef.current) editorRef.current?.setModel(null)
            buffer.model.dispose()
          }
          setOpenPaths((paths) => operation === 'rename'
            ? rewriteOpenPaths(paths, source, destination ?? source)
            : paths.filter((item) => !isAtOrUnder(item, source)))
        }
        if (current && isAtOrUnder(current, source)) {
          if (operation === 'rename') {
            stateRef.current = { path: null, version: null, dirty: false, text: '', model: null }
            setActivePath(null)
            setDirty(false)
            await openFile((destination ?? source) + current.slice(source.length))
          }
          else if (operation === 'delete') {
            editorRef.current?.setModel(null)
            stateRef.current = { path: null, version: null, dirty: false, text: '', model: null }
            setActivePath(null)
            setDirty(false)
          }
        }
        if (action === 'createFile') await openFile(source)
      }
      setStatus('操作完成')
      return { ok: true }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      setStatus(`操作失败：${message}`, 'error')
      // The in-tree field reads this to explain itself and stay open.
      return { ok: false, error: message }
    }
  }

  const closeFile = useCallback(async (path: string): Promise<void> => {
    const buffer = buffersRef.current.get(path)
    if (buffer?.saving) { setStatus('文件正在保存，请稍后关闭', 'warn'); return }
    if (buffer?.dirty && !await askDialog(`关闭 ${path} 并放弃未保存的修改？取消后可先按 Ctrl+S 保存。`)) return
    ++openRequestRef.current
    const remaining = openPaths.filter((item) => item !== path)
    setOpenPaths(remaining)
    buffersRef.current.delete(path)
    if (activePath !== path) { buffer?.model.dispose(); return }
    editorRef.current?.setModel(null)
    stateRef.current = { path: null, version: null, dirty: false, text: '', model: null }
    buffer?.model.dispose()
    const next = remaining.at(-1)
    if (next) await openFile(next)
    else {
      editorRef.current?.setModel(null)
      stateRef.current = { path: null, version: null, dirty: false, text: '', model: null }
      setActivePath(null)
      setDirty(false)
    }
  }, [activePath, openFile, openPaths])

  const copyPath = useCallback(async (path: string, relative = false): Promise<void> => {
    const value = relative && cwd ? relativeToCwd(path, cwd) : path
    try {
      await globalThis.navigator?.clipboard?.writeText?.(value)
      setStatus(relative ? '已复制相对路径' : '已复制路径')
    } catch { setStatus('复制路径失败', 'error') }
  }, [cwd])

  const closeTabSet = useCallback(async (paths: string[]): Promise<void> => {
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
    if (activePath !== null && selected.includes(activePath)) {
      const next = remaining.at(-1)
      editorRef.current?.setModel(null)
      stateRef.current = { path: null, version: null, dirty: false, text: '', model: null }
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
  const header: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 12px',
    borderBottom: `1px solid ${T.border}`, fontSize: '12px', color: T.fgMuted, flex: '0 0 auto',
  }
  const button: React.CSSProperties = {
    padding: '6px 10px', borderRadius: '8px', border: `1px solid ${T.border}`,
    background: T.bgRaised, color: T.fg, cursor: 'pointer', fontSize: '12px',
  }

  // ---- search panel (left column, mode = search) ------------------------
  const searchRows: React.ReactNode[] = []
  const searchReport = result !== null && 'matches' in result ? result : null
  const searchError = result !== null && 'error' in result ? result.error : null
  if (searchReport?.matches) {
    for (const [index, hit] of searchReport.matches.entries()) {
      const rel = relativeToCwd(hit.path, cwd)
      searchRows.push(h('div', {
        key: `${hit.path}#${hit.line}#${index}`,
        style: { ...rowStyle(0), flexDirection: 'column', alignItems: 'flex-start', gap: '1px', padding: '4px 8px' },
        onClick: () => { void openFile(hit.path, { line: hit.line, column: hit.column, length: hit.length }) },
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
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value),
        onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter') void runSearch() },
        style: {
          flex: '1 1 auto', minWidth: 0, padding: '3px 6px', fontSize: '11.5px',
          borderRadius: '4px', border: `1px solid ${T.border}`, background: T.bg, color: T.fg, outline: 'none',
        },
      }),
    ),
    h('div', { style: { padding: '4px 8px', fontSize: '10.5px', color: T.fgMuted, flex: '0 0 auto' } },
      searching ? '搜索中…'
        : searchError ? h('span', { style: { color: T.danger } }, searchError)
          : searchReport?.matches
            ? `${searchReport.matches.length} 处${searchReport.truncated ? '+' : ''} · ${searchReport.filesScanned} 文件 · ${searchReport.elapsedMs}ms`
            : '输入后回车搜索'),
    h('div', { style: { overflow: 'auto', minHeight: 0, flex: '1 1 auto' } }, searchRows),
  )

  // ---- history panel (left column, mode = history) ---------------------
  const tinyButton: React.CSSProperties = {
    padding: '1px 8px', borderRadius: '4px', border: `1px solid ${T.border}`,
    background: T.bg, color: T.fg, cursor: 'pointer', fontSize: '10.5px',
  }
  const historyRows: React.ReactNode[] = []
  const historyReport = history !== null && 'entries' in history ? history : null
  const historyError = history !== null && 'error' in history ? history.error : null
  if (historyReport?.entries) {
    for (const entry of historyReport.entries) {
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
          onClick: () => { void rollback(entry.id) },
        }, '回滚到此保存前'),
      ))
    }
  }
  const historyPanel = h('div', { style: { display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0 } },
    h('div', { style: { padding: '6px 8px', borderBottom: `1px solid ${T.border}`, display: 'flex', gap: '4px', flex: '0 0 auto' } },
      h('button', { style: tinyButton, onClick: () => { void loadHistory() } }, '刷新'),
      h('span', { style: { color: T.fgMuted, fontSize: '10.5px', alignSelf: 'center' } }, '每次保存都是一个检查点'),
    ),
    h('div', { style: { overflow: 'auto', minHeight: 0, flex: '1 1 auto' } },
      historyError ? h('div', { style: { padding: '8px', color: T.danger, fontSize: '11px' } }, historyError)
        : historyReport?.entries
          ? (historyRows.length > 0
              ? historyRows
              : h('div', { style: { padding: '8px', color: T.fgMuted, fontSize: '11px' } }, '还没有保存记录'))
          : h('div', { style: { padding: '8px', color: T.fgMuted, fontSize: '11px' } }, '加载中…')),
  )

  const relativePath = typeof activePath === 'string' ? relativeToCwd(activePath, cwd) : activePath
  const showTabMenu = (event: React.MouseEvent, path: string) => {
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
  const moveTab = (from: string, to: string) => {
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
      // Only the active tab carries the ref: the effect above is about the tab
      // being edited, and a ref on every tab would just be churn.
      ref: path === activePath ? activeTabRef : undefined,
      className: `code-workbench-tab${path === activePath ? ' active' : ''}${side === null ? '' : ` code-workbench-tab-drop-${side}`}`,
      onClick: () => { void openFile(path) },
      onContextMenu: (event: React.MouseEvent) => showTabMenu(event, path),
      // A tab is a drag source for the same two gestures a tree row offers: it
      // carries a workspace path to the composer, and it reorders the strip.
      // The private flavor is what keeps both disjoint from DSH's own file-drop
      // pipeline, so the composer's interceptor claims the drop and nothing else
      // does.
      draggable: true,
      onDragStart: (event: React.DragEvent) => {
        tabDragRef.current = path
        event.dataTransfer.effectAllowed = 'copyMove'
        event.dataTransfer.setData(TREE_DRAG_MIME, treeDragPayload(path, cwd, false))
        // The universal fallback, same as a tree row's: if the composer's
        // interceptor ever declined the drop, the text is still the path.
        event.dataTransfer.setData('text/plain', relativeToCwd(path, cwd) || path)
      },
      onDragOver: (event: React.DragEvent) => {
        const from = tabDragRef.current
        // A tree row's drag carries the same flavor but never sets this ref, so
        // it passes over the strip without reordering anything.
        if (from === null || from === path) return
        event.preventDefault()
        event.stopPropagation()
        event.dataTransfer.dropEffect = 'move'
        // Which edge the marker goes on is decided by direction: a tab dragged
        // rightwards lands after the one it is over, and the other way round.
        const nextSide: 'before' | 'after' = openPaths.indexOf(from) < openPaths.indexOf(path) ? 'after' : 'before'
        if (tabDrop?.path !== path || tabDrop.side !== nextSide) setTabDrop({ path, side: nextSide })
      },
      onDragLeave: (event: React.DragEvent) => {
        // Moving onto the tab's own name or close button fires `dragleave` too;
        // only a departure from the whole tab clears its marker.
        if (typeof event?.currentTarget?.contains === 'function' && event.currentTarget.contains(event.relatedTarget as Node | null)) return
        if (tabDrop?.path === path) setTabDrop(null)
      },
      onDrop: (event: React.DragEvent) => {
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
      h('button', { title: `关闭 ${name}`, onClick: (event: React.MouseEvent) => { event.stopPropagation(); void closeFile(path) } }, '×'))
  })
  return h('div', { className: 'code-workbench', onContextMenuCapture: () => setTabMenu(null), style: { display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0, background: T.bg, color: T.fg } },
    dialog ? h('div', { className: 'code-workbench-dialog-backdrop', onKeyDown: (event: React.KeyboardEvent) => { if (event.key === 'Escape') finishDialog(false) } },
      h('form', { className: 'code-workbench-dialog', role: 'dialog', 'aria-modal': true, 'aria-label': dialog.title, onSubmit: (event: React.FormEvent) => { event.preventDefault(); finishDialog(true) } },
        h('div', { className: 'code-workbench-dialog-title' }, dialog.title),
        dialog.input ? h('input', { autoFocus: true, value: dialogValue, 'aria-label': '名称', onChange: (event: React.ChangeEvent<HTMLInputElement>) => setDialogValue(event.target.value) }) : null,
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
      h('button', { style: button, onClick: () => { void save() }, disabled: !dirty }, '保存 (Ctrl+S)'),
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
        onClick: () => { void runUpdate() },
      }, updateBusy ? '更新中…' : '升级'),
    ),
    h('div', { className: 'code-workbench-body', style: { display: 'flex', flex: '1 1 auto', minHeight: 0 } },
      h('div', { className: 'code-workbench-activity', role: 'toolbar', 'aria-label': '工作区视图' },
        ([['tree', '文件', 'files'], ['search', '搜索', 'search'], ['history', '历史', 'history']] as Array<['tree' | 'search' | 'history', string, keyof typeof ICON_PATHS]>).map(([mode, label, icon]) => h('button', {
          key: mode, title: label, 'aria-label': label, 'aria-pressed': navigationOpen && leftMode === mode,
          onClick: () => { setNavigationOpen(leftMode === mode ? !navigationOpen : true); setLeftMode(mode); if (mode === 'history') void loadHistory() },
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
                ? h(FileTree, { list, cwd, activePath, onOpen: (path: string) => { void openFile(path) }, joinPath, onAction: treeAction, refreshRevision: treeRevision, clipboard: treeClipboard, closeMenuSignal: tabMenu?.path ?? null, onMenuOpen: () => setTabMenu(null) })
                : h('div', { style: { padding: '12px', color: T.fgMuted, fontSize: '12px' } }, '会话没有工作区目录')),
      ),
      h('div', { style: { display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0, minWidth: 0 } },
        h('div', { className: 'code-workbench-tabs', onClick: () => { if (tabMenu) setTabMenu(null) } }, tabs.length ? tabs : h('span', { className: 'code-workbench-no-tabs' }, '未打开文件')),
        tabMenu ? h('div', { role: 'menu', className: 'code-workbench-context-menu', style: { left: tabMenu.x, top: tabMenu.y }, onClick: (event: React.MouseEvent) => event.stopPropagation() }, ([
          ['close', '关闭', () => { void closeFile(tabMenu.path) }],
          ['closeOthers', '关闭其他', () => { void closeTabSet(openPaths.filter((path) => path !== tabMenu.path)) }],
          ['closeRight', '关闭右侧标签页', () => { void closeTabSet(openPaths.slice(openPaths.indexOf(tabMenu.path) + 1)) }],
          ['closeSaved', '关闭已保存', () => { void closeTabSet(openPaths.filter((path) => !buffersRef.current.get(path)?.dirty)) }],
          ['closeAll', '全部关闭', () => { void closeTabSet(openPaths) }],
          ['copyPath', '复制路径', () => { void copyPath(tabMenu.path) }],
          ['copyRelativePath', '复制相对路径', () => { void copyPath(tabMenu.path, true) }],
        ] as Array<[string, string, () => void]>).map(([action, label, handler]) => h('button', { key: action, type: 'button', role: 'menuitem', onClick: () => { setTabMenu(null); handler() } }, label))) : null,
        h('div', { className: 'code-workbench-breadcrumb', title: relativePath ?? '' },
          (relativePath ?? '代码工作台').split(/[\\/]/).filter(Boolean).map((part, index) => h('span', { key: `${part}-${index}` }, index > 0 ? ` › ${part}` : part))),
        h('div', { style: { position: 'relative', display: 'flex', flex: '1 1 auto', minHeight: 0, minWidth: 0 } },
        h('div', { ref: hostRef, style: { flex: '1 1 auto', minHeight: 0, minWidth: 0, visibility: activePath ? 'visible' : 'hidden' } }),
        activePath === null ? h('div', { className: 'code-workbench-empty' },
          h('div', { style: { fontSize: '18px', fontWeight: 500, color: T.fg } }, '开始编辑代码'),
          h('div', null, '从工作区选择一个文件'),
          h('div', { style: { fontSize: '11px', lineHeight: 2 } }, 'Ctrl+L 加到对话', h('br'), '输入代码获取 AI 建议，Tab 接受'),
        ) : null,
        // Monaco is five megabytes of JavaScript and its first parse is not
        // instant. Until it lands the editor host is an empty rectangle, and
        // saying so is the difference between "starting" and "broken".
        monaco === null ? h('div', { className: 'code-workbench-editor-boot' },
          h('span', { className: 'code-workbench-spinner', 'aria-hidden': true }),
          h('span', null, '正在启动编辑器…'),
        ) : null,
        ),
      ),
    ),
    h('div', { style: { ...header, borderTop: `1px solid ${T.border}`, borderBottom: 'none', flexWrap: 'wrap', fontSize: '11px', padding: '6px 12px' } },
      // The dot carries the severity; the sentence is unchanged, so a failure
      // is visible without reading the line at all.
      h('span', { className: 'code-workbench-status', style: { flex: '1 1 auto', minWidth: 0, overflowWrap: 'anywhere' } },
        h('span', { className: 'code-workbench-status-dot', 'data-level': statusLevel, 'aria-hidden': true, style: { background: STATUS_DOT[statusLevel] } }),
        h('span', null, status)),
      h('span', { role: 'status', title: completionStatus }, completionStatus),
    ),
  )
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const inject = ['slots', 'sidebarRightTabs', 'sidebarRight', 'remote.workspaceFiles', 'remote.session', 'shortcuts', 'sessions', 'inputTriggers', 'configForms']

function CodeWorkbenchSettings({ form }: DSH.SettingsItemProps): React.ReactNode {
  const snapshot = usePluginSettings(form)
  const value: PluginSettings = snapshot.value ?? defaultSettings
  const [autoSave, setAutoSave] = useState(value.autoSave === true)
  const [completionEnabled, setCompletionEnabled] = useState(value.completionEnabled !== false)
  const [baseUrl, setBaseUrl] = useState(value.completionBaseUrl ?? defaultSettings.completionBaseUrl ?? '')
  const [apiModel, setApiModel] = useState(value.completionApiModel ?? defaultSettings.completionApiModel ?? '')
  const [apiKey, setApiKey] = useState('')
  const [clearApiKey, setClearApiKey] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [status, setStatus] = useState<CompletionStatus | null>(null)
  const [statusTick, setStatusTick] = useState(0)
  useEffect(() => {
    setAutoSave(value.autoSave === true)
    setCompletionEnabled(value.completionEnabled !== false)
    setBaseUrl(value.completionBaseUrl ?? defaultSettings.completionBaseUrl ?? '')
    setApiModel(value.completionApiModel ?? defaultSettings.completionApiModel ?? '')
  }, [value.autoSave, value.completionEnabled, value.completionBaseUrl, value.completionApiModel])
  // The credential lives Host-side only, so the editor cannot tell which source
  // a completion would use — it has to ask. Showing the Host's answer is the
  // only way to explain a quiet editor without handling a secret here.
  useEffect(() => {
    let live = true
    fetch(COMPLETION_STATUS_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: (CompletionStatus & { ok?: boolean }) | null) => { if (live) setStatus(payload?.ok === true ? payload : null) })
      .catch(() => { if (live) setStatus(null) })
    return () => { live = false }
  }, [snapshot.revision, statusTick])
  const persist = async (operation: () => Promise<boolean>): Promise<void> => {
    if (busy) return
    setBusy(true)
    setNotice('')
    try {
      if (!await operation()) throw new Error('设置未保存，请检查配置权限或重试')
      setNotice('设置已保存')
    } catch (error: unknown) { setNotice(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  const toggleAutoSave = () => {
    if (busy) return
    if (form === undefined) { setNotice('设置服务不可用，自动保存尚未更改'); return }
    const previous = autoSave
    const next = !previous
    setAutoSave(next)
    void persist(async () => {
      try {
        const saved = await form.set('autoSave', next)
        if (!saved) setAutoSave(previous)
        return saved
      } catch (error: unknown) {
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
    void persist(async () => {
      try {
        const saved = await form.set('completionEnabled', next)
        if (!saved) setCompletionEnabled(previous)
        if (saved) completionCache.clear()
        return saved
      } catch (error: unknown) { setCompletionEnabled(previous); throw error }
    })
  }
  const disabled = busy
  const input: React.CSSProperties = { width: '100%', boxSizing: 'border-box', padding: '7px 9px', borderRadius: '7px', border: `1px solid ${T.border}`, background: T.bg, color: T.fg, font: 'inherit' }
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
      h('label', null, 'API Base URL', h('input', { style: input, value: baseUrl, placeholder: 'https://api.deepseek.com/beta', disabled, onChange: (event: React.ChangeEvent<HTMLInputElement>) => setBaseUrl(event.target.value) })),
      h('label', null, '补全模型 ID', h('input', { style: input, value: apiModel, placeholder: 'deepseek-flash', disabled, onChange: (event: React.ChangeEvent<HTMLInputElement>) => setApiModel(event.target.value) })),
      h('label', null, 'API Key', h('input', { type: 'password', autoComplete: 'new-password', style: input, value: apiKey, placeholder: '留空则自动取用 DSH 凭据库或登录账号', disabled, onChange: (event: React.ChangeEvent<HTMLInputElement>) => { setApiKey(event.target.value); setClearApiKey(false) } })),
      h('label', null, h('input', { type: 'checkbox', checked: clearApiKey, disabled, onChange: (event: React.ChangeEvent<HTMLInputElement>) => { setClearApiKey(event.target.checked); setApiKey('') } }), '清除已保存的 API Key'),
      h('p', { style: { color: T.fgMuted, fontSize: '12px', margin: 0 } }, '留空时依次尝试：DSH 凭据库的 DEEPSEEK_API_KEY → 已登录的 DSH 账号。密钥由 Host 保存和使用，不回显到设置页。'),
      h('div', { style: { display: 'grid', gap: '4px', paddingTop: '6px', borderTop: `1px solid ${T.border}` } },
        h('div', { className: 'code-workbench-setting-title' }, '当前补全链路'),
        h('dl', { style: { margin: 0, fontSize: '12px', color: T.fgMuted, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 10px' } },
          h('dt', null, '接口'), h('dd', { style: { margin: 0, wordBreak: 'break-all' } }, status?.addressValid === false ? '地址无效' : (status?.endpoint || '读取中…')),
          h('dt', null, '模型'), h('dd', { style: { margin: 0 } }, status?.model || '—'),
          h('dt', null, '凭据'), h('dd', { style: { margin: 0, color: status !== null && status.source === 'none' ? T.danger : T.fg } }, status === null ? '读取中…' : (CREDENTIAL_SOURCE_LABELS[status.source ?? ''] ?? status.source)))),
      h('p', { style: { color: T.fgMuted, fontSize: '12px', margin: 0 } }, '凭据缺失或接口不可用时，Tab 补全会静默停用，不弹错误提示。')),
    h('button', { disabled, onClick: () => {
      if (form === undefined || snapshot.status === 'unavailable') { setNotice('设置服务尚未同步，请重新打开设置页后重试'); return }
      try {
        const endpoint = new URL(baseUrl.trim())
        if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || !apiModel.trim()) throw new Error()
      } catch { setNotice('请填写有效的 HTTP(S) API 地址和补全模型 ID'); return }
      const ops: DSH.ConfigOperation[] = Object.entries({ completionEnabled, completionBaseUrl: baseUrl.trim(), completionApiModel: apiModel.trim() }).map(([field, setting]) => ({ op: 'set', path: [field], value: setting }))
      if (clearApiKey || apiKey.trim()) ops.push({ op: 'set', path: ['completionApiKey'], value: clearApiKey ? '' : apiKey.trim() })
      void persist(async () => {
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
function CodeWorkbenchAbout(): React.ReactNode {
  const [about, setAbout] = useState<AboutInfo | false | null>(null)
  useEffect(() => {
    let live = true
    fetch(ABOUT_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: (AboutInfo & { ok?: boolean }) | null) => { if (live) setAbout(payload?.ok === true ? payload : false) })
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

function CodeWorkbenchSection({ renderSlot }: DSH.SettingsSectionProps): React.ReactNode {
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
function registerShortcuts(ctx: DSH.ClientContext): void {
  const fixed: DSH.ShortcutCommand[] = [
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

function apply(ctx: DSH.ClientContext): void {
  registerShortcuts(ctx)
  const settingsForm = ctx.configForms?.get(SETTINGS_NS)
  if (ctx.configForms) {
    ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register<DSH.SettingsSectionProps>({
      name: 'settings.section',
      id: 'code-workbench',
      order: 25,
      label: () => '代码工作台',
      children: { 'settings.code-workbench.item': { kind: 'list', scope: 'root' } },
    }, CodeWorkbenchSection)), 'code-workbench: settings section')
    ctx.effect(() => ctx.slots.inject('settings.code-workbench.item', () => ctx.slots.register<DSH.SettingsItemProps>({
      name: 'settings.code-workbench.item',
      id: SETTINGS_NS,
      order: 0,
      inject: () => ({ form: settingsForm }),
    }, CodeWorkbenchSettings)), 'code-workbench: settings content')
  }
  ctx.effect(() => ctx.slots.inject('conversation.chat.node', () => {
    const disposers: DSH.Disposer[] = []
    const entries: DSH.SlotEntry[] = typeof ctx.slots.entries === 'function'
      ? ctx.slots.entries('conversation.chat.node')
      : []
    for (const key of ['user', 'steering']) {
      const options = { name: 'conversation.chat.node', key, priority: -10 }
      const original = entries.find((entry) => entry.options.key === key && (entry.options.priority ?? 0) >= 0)
      const Original = original?.component as StoredComponent | undefined
      disposers.push(ctx.slots.register<ChatNodeProps>(options, (props) => {
        const content = props.node?.data?.content
        const hasOriginal = typeof Original === 'function' || (typeof Original === 'object' && Original !== null && Original.$$typeof !== undefined)
        const RenderOriginal = Original as React.ComponentType<Record<string, unknown>> | undefined
        if (!Array.isArray(content)) {
          return h('div', { className: 'code-workbench-chat-fallback' },
            hasOriginal && RenderOriginal ? h(RenderOriginal, props) : typeof content === 'string' ? content : '',
          )
        }
        const snippets: Array<{ anchor: string; code: string }> = []
        const compactContent = (content as Array<{ type?: string; text?: string }>).flatMap((part) => {
          if (part.type !== 'text') return [part]
          return splitSnippets(part.text ?? '').flatMap((piece) => {
            if (piece.anchor === undefined) return [{ ...part, text: piece.text }]
            snippets.push({ anchor: piece.anchor, code: piece.code })
            return []
          })
        })
        const renderMessage = (messageContent: Array<{ type?: string; text?: string }>) => hasOriginal && RenderOriginal
          ? h(RenderOriginal, { ...props, node: { ...props.node, data: { ...props.node?.data, content: messageContent } } })
          : h('div', { className: 'code-workbench-chat-fallback' }, messageContent.map((part) => part.type === 'text' ? part.text : '').join('\n'))
        if (snippets.length === 0) return renderMessage(content as Array<{ type?: string; text?: string }>)
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
            serialize: async (reference) => {
              const ref = reference as { pathOnly?: boolean; path?: string; directory?: boolean; startLine?: number; endLine?: number; language?: string; code?: string }
              if (ref?.pathOnly) return referenceMention(ref.path ?? '', ref.directory === true)
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
      } catch (error: unknown) {
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

  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register<DSH.CodePanelProps>({
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
      'remote.stream': (spec: DSH.StreamSpec<unknown>) => ctx.remote.$stream(spec),
      'sessions.scope': (id: string) => ctx.sessions.scope(id),
    }),
  }, CodePanel)), 'code-workbench: tab body')
}

export { inject, apply }
export const name = TAB_KIND
