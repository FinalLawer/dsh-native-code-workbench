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
 *
 * The bundle contract: exports { inject, apply, name }; `require` is limited to
 * the frozen browser module table (`react`). Monaco is inlined at build time.
 */

import React from 'react'
import './workbench.css'
import { serializeSnippet, splitSnippets } from './snippets.mjs'

const { useCallback, useEffect, useMemo, useRef, useState } = React
const h = React.createElement
const SETTINGS_NS = 'code-workbench'
const defaultSettings = { autoSave: false, completionEnabled: true, completionProvider: '', completionModel: '' }
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
/** The save journal endpoints (checkpoints: list and roll back saves). */
const HISTORY_PATH = '/api/code-workbench/history'
const ROLLBACK_PATH = '/api/code-workbench/rollback'

/**
 * Read the Tab-completion NDJSON stream.
 * @param body - the framed caret-context request.
 * @param signal - cancellation when typing invalidates the suggestion.
 * @returns the final completion text.
 */
async function streamCompletion(body, signal) {
  const response = await fetch(COMPLETE_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!response.ok || !response.body) {
    const detail = await response.json().catch(() => ({}))
    throw new Error(detail.error?.message ?? detail.error?.code ?? `HTTP ${response.status}`)
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let nl
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (line === '') continue
      const frame = JSON.parse(line)
      if (frame.t === 'delta') {
        text += frame.text
      } else if (frame.t === 'done') {
        return text
      } else if (frame.t === 'error') {
        const route = frame.provider && frame.model ? `（${frame.provider} / ${frame.model}）` : ''
        throw new Error(`${frame.message ?? frame.code ?? 'completion failed'}${route}`)
      }
    }
  }
  return text
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
  cursor: 'pointer',
  color: T.fg,
  fontSize: '12.5px',
  lineHeight: '18px',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
})

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
  useEffect(() => { for (const dir of expanded) load(dir) }, [refreshRevision, list])
  useEffect(() => { setMenu(null) }, [closeMenuSignal])
  const contextMenu = (event, path, isDir) => {
    event.preventDefault()
    event.stopPropagation()
    onMenuOpen?.()
    setMenu({ path, isDir, element: event.currentTarget, x: Math.max(0, Math.min(event.clientX, window.innerWidth - 230)), y: Math.max(0, Math.min(event.clientY, window.innerHeight - 380)) })
  }

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
  const walk = (dir, depth) => {
    const entries = children[dir]
    if (entries === undefined || entries === 'loading') {
      rows.push(h('div', { key: `${dir}#loading`, style: rowStyle(depth) }, '加载中…'))
      return
    }
    if (typeof entries === 'string') {
      rows.push(h('div', { key: `${dir}#err`, style: { ...rowStyle(depth), color: T.danger } }, entries))
      return
    }
    for (const entry of entries) {
      const full = joinPath(dir, entry.name)
      const isDir = entry.type === 'directory'
      const isOpen = isDir && expanded.has(full)
      rows.push(h('div', {
        key: full,
        className: 'code-workbench-tree-row',
        'data-active': !isDir && full === activePath,
        'data-selected': selected?.path === full && selected.isDir === isDir,
        role: 'button',
        tabIndex: 0,
        'aria-expanded': isDir ? isOpen : undefined,
        'aria-pressed': isDir ? undefined : full === activePath,
        style: rowStyle(depth),
        // Selecting and opening are separate concerns: a click both marks the
        // row (so the toolbar knows where to create) and does what the row
        // normally does — expand a directory, or open a file.
        onClick: () => { setSelected({ path: full, isDir }); isDir ? toggle(full) : onOpen(full) },
        onKeyDown: (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          setSelected({ path: full, isDir })
          isDir ? toggle(full) : onOpen(full)
        },
        onContextMenu: (event) => { setSelected({ path: full, isDir }); contextMenu(event, full, isDir) },
        // Drag source: the row hands out its workspace-relative path so the
        // composer drop target can turn it into a reference chip. The private
        // flavor keeps this gesture disjoint from DSH's own file-drop pipeline.
        draggable: true,
        onDragStart: (event) => {
          event.dataTransfer.effectAllowed = 'copy'
          event.dataTransfer.setData(TREE_DRAG_MIME, treeDragPayload(full, cwd, isDir))
          // A plain-text flavor as the universal fallback; Lexical would render
          // this as raw text if our interceptor ever declined the drop.
          event.dataTransfer.setData('text/plain', relativeToCwd(full, cwd) || full)
        },
        title: full,
      }, h('span', { style: { color: T.fgMuted, width: '10px', display: 'inline-block' } }, isDir ? (isOpen ? '▾' : '▸') : ' '),
        h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, entry.name)))
      if (isOpen) walk(full, depth + 1)
    }
  }
  walk(cwd, 0)
  const items = menu ? [
    ['createFile', '新建文件…'], ['createDirectory', '新建文件夹…'],
    ['reveal', '在资源管理器中显示'],
    ['addToChat', menu.isDir ? '添加目录到对话' : '添加文件到对话'],
    ['cut', '剪切'], ['copy', '复制'], ['paste', '粘贴'],
    ['copyPath', '复制路径'], ['copyRelativePath', '复制相对路径'],
    ['rename', '重命名…'], ['delete', '删除…'],
  ] : []
  return h('div', { style: { overflow: 'auto', padding: '4px 0' }, onContextMenu: (event) => contextMenu(event, cwd, true) },
    h('div', { className: 'code-workbench-tree-toolbar' },
      h('button', {
        title: selected === null ? '新建文件' : `在 ${relativeToCwd(createTarget.path, cwd) || '工作区'} 中新建文件`,
        'aria-label': '新建文件',
        onClick: () => onAction('createFile', createTarget),
      }, workbenchIcon('createFile')),
      h('button', {
        title: selected === null ? '新建文件夹' : `在 ${relativeToCwd(createTarget.path, cwd) || '工作区'} 中新建文件夹`,
        'aria-label': '新建文件夹',
        onClick: () => onAction('createDirectory', createTarget),
      }, workbenchIcon('createDirectory')),
      h('button', { title: '刷新', 'aria-label': '刷新文件树', onClick: () => { for (const dir of expanded) load(dir) } }, workbenchIcon('refresh')),
      h('button', { title: '全部折叠', 'aria-label': '全部折叠', onClick: () => setExpanded(new Set([cwd])) }, workbenchIcon('collapse')),
    ),
    h('div', { style: rowStyle(0), onContextMenu: (event) => contextMenu(event, cwd, true) }, cwd.split(/[\\/]/).filter(Boolean).at(-1)), rows,
    menu ? h('div', { role: 'menu', className: 'code-workbench-context-menu', style: { left: menu.x, top: menu.y }, onClick: (event) => event.stopPropagation() },
      items.map(([action, label]) => h('button', { key: action, type: 'button', role: 'menuitem', disabled: action === 'paste' && !clipboard || ['cut', 'rename', 'delete'].includes(action) && menu.path === cwd, onClick: () => { const target = menu; setMenu(null); onAction(action, target) } }, label))) : null)
}

// ---------------------------------------------------------------------------
// The tab body
// ---------------------------------------------------------------------------

function CodePanel(props) {
  const {
    sessionId,
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
  const inFlightRef = useRef(false) // one ghost-text request at a time
  const inlineTriggerTimerRef = useRef(null)
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
    const selectionListener = editor.onDidChangeCursorSelection(() => {
      setHasSelection(!editor.getSelection().isEmpty())
    })
    // Tab-completion ghost text: Monaco renders the preview and accepts on Tab;
    // this provider only answers "what should be inserted at the caret".
    const completions = monaco.languages.registerInlineCompletionsProvider('*', {
      debounceDelayMs: 300,
      async provideInlineCompletions(model, position, context, token) {
        if (settingsRef.current.completionEnabled === false) return { items: [] }
        const st = stateRef.current
        if (st.path === null || model !== editor.getModel() || inFlightRef.current) return { items: [] }
        const value = model.getValue()
        const offset = model.getOffsetAt(position)
        const prefix = value.slice(Math.max(0, offset - 3200), offset)
        const suffix = value.slice(offset, offset + 900)
        if (prefix.trim() === '') return { items: [] }
        const settings = settingsRef.current
        const cacheKey = `${sessionId}\u0000${st.path}\u0000${settings.completionProvider}\u0000${settings.completionModel}\u0000${settings.completionApiEnabled}\u0000${settings.completionBaseUrl}\u0000${settings.completionApiModel}\u0000${model.getLanguageId()}\u0000${prefix}\u0000${suffix}`
        const cached = completionCache.get(cacheKey)
        if (cached !== undefined) {
          setCompletionStatus('Tab 接受 AI 建议')
          return { items: [{ insertText: cached, range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column) }] }
        }
        const controller = new AbortController()
        const onCancel = token.onCancellationRequested?.(() => controller.abort())
        inFlightRef.current = true
        setCompletionStatus('AI 补全生成中…')
        try {
          const text = await streamCompletion({
            sessionId,
            path: st.path,
            language: model.getLanguageId(),
            prefix,
            suffix,
          }, controller.signal)
          const insertText = stripFences(text, true).slice(0, 2000)
          if (token.isCancellationRequested) {
            setCompletionStatus('AI 补全已取消')
            return { items: [] }
          }
          setCompletionStatus(insertText === '' ? 'AI 未返回补全' : 'Tab 接受 AI 建议')
          if (insertText === '') return { items: [] }
          completionCache.set(cacheKey, insertText)
          while (completionCache.size > 40) completionCache.delete(completionCache.keys().next().value)
          return {
            items: [{
              insertText,
              range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column),
            }],
          }
        } catch (error) {
          setCompletionStatus(controller.signal.aborted ? 'AI 补全已取消' : `AI 补全失败：${error.message ?? error}`)
          return { items: [] }
        } finally {
          inFlightRef.current = false
          onCancel?.dispose?.()
        }
      },
      disposeInlineCompletions: () => {},
    })
    const observer = new MutationObserver(() => monaco.editor.setTheme(monacoTheme()))
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
    return () => {
      completions.dispose()
      if (inlineTriggerTimerRef.current !== null) clearTimeout(inlineTriggerTimerRef.current)
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
        if (!res?.ok) throw new Error(res?.error?.code ?? 'read failed')
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
        if (inlineTriggerTimerRef.current !== null) clearTimeout(inlineTriggerTimerRef.current)
        if (settingsRef.current.completionEnabled === false) return
        inlineTriggerTimerRef.current = setTimeout(() => {
          inlineTriggerTimerRef.current = null
          if (editor.getModel() === model && editor.getPosition?.() && typeof editor.trigger === 'function') {
            editor.trigger('code-workbench', 'editor.action.inlineSuggest.trigger', {})
          }
        }, 400)
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
      setStatus(`读取失败: ${error.message ?? error}`)
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
      } catch {
        // watch-unsupported or the stream ended; external reload is best-effort
      }
    })()
    return () => {
      cancelled = true
      dispose?.()
    }
  }, [activePath, files, sessionId, watchStream])

  useEffect(() => {
    const path = activePath
    if (!path || typeof files.stat !== 'function') return
    const controller = new AbortController()
    let checking = false
    const checkVersion = async () => {
      if (checking || controller.signal.aborted || document.visibilityState === 'hidden') return
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
    const timer = setInterval(checkVersion, 1500)
    window.addEventListener?.('focus', checkVersion)
    checkVersion()
    return () => {
      controller.abort()
      clearInterval(timer)
      window.removeEventListener?.('focus', checkVersion)
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
        clipboardText: parsed.path,
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
        const reference = { source: 'code-workbench', ref: { path: relative, directory: target.isDir, pathOnly: true }, label: relative, appearance: 'file', clipboardText: relative }
        if (scope.bail(scope, 'slash/input-insert-reference', { reference, span: inputActions.captureInsertion() }) !== true) throw new Error('对话输入框正忙')
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
          if (!await askDialog(`确定删除 ${path}？此操作无法撤销。`)) return
        } else {
          const name = await askDialog(action === 'rename' ? '新的名称' : action === 'createDirectory' ? '新建文件夹名称' : '新建文件名称', action === 'rename' ? path.split(/[\\/]/).at(-1) : '')
          if (name === null) return
          if (!name.trim() || /[\\/]/.test(name) || ['.', '..'].includes(name.trim())) throw new Error('请输入有效名称，不能包含路径分隔符')
          if (action === 'rename') destination = joinPath(parent, name.trim())
          else source = joinPath(directory, name.trim())
        }
        const affected = [...buffersRef.current.values()].filter((buffer) => buffer.path === source || buffer.path.startsWith(`${source}/`) || buffer.path.startsWith(`${source}\\`))
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
          setOpenPaths((paths) => paths.flatMap((item) => {
            const matches = item === source || item.startsWith(`${source}/`) || item.startsWith(`${source}\\`)
            return matches ? operation === 'rename' ? [destination + item.slice(source.length)] : [] : [item]
          }))
        }
        if (current && (current === source || current.startsWith(`${source}/`) || current.startsWith(`${source}\\`))) {
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
    } catch (error) { setStatus(`操作失败：${error.message ?? error}`) }
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
  const tabs = openPaths.map((path) => {
    const name = path.split(/[\\/]/).at(-1)
    const tabDirty = buffersRef.current.get(path)?.dirty
    return h('div', { key: path, className: `code-workbench-tab${path === activePath ? ' active' : ''}`, onClick: () => openFile(path), onContextMenu: (event) => showTabMenu(event, path) },
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
            : h('div', { style: { flex: '1 1 auto', minHeight: 0, overflow: 'auto' } },
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

const inject = ['slots', 'sidebarRightTabs', 'remote.workspaceFiles', 'remote.session', 'shortcuts', 'sessions', 'inputTriggers', 'configForms']

function CodeWorkbenchSettings({ form }) {
  const snapshot = usePluginSettings(form)
  const value = snapshot.value ?? defaultSettings
  const [autoSave, setAutoSave] = useState(value.autoSave === true)
  const [completionEnabled, setCompletionEnabled] = useState(value.completionEnabled !== false)
  const [provider, setProvider] = useState(value.completionProvider)
  const [model, setModel] = useState(value.completionModel)
  const [apiEnabled, setApiEnabled] = useState(value.completionApiEnabled === true)
  const [baseUrl, setBaseUrl] = useState(value.completionBaseUrl ?? '')
  const [apiModel, setApiModel] = useState(value.completionApiModel ?? '')
  const [apiKey, setApiKey] = useState('')
  const [clearApiKey, setClearApiKey] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  useEffect(() => {
    setAutoSave(value.autoSave === true)
    setCompletionEnabled(value.completionEnabled !== false)
    setProvider(value.completionProvider ?? '')
    setModel(value.completionModel ?? '')
    setApiEnabled(value.completionApiEnabled === true)
    setBaseUrl(value.completionBaseUrl ?? '')
    setApiModel(value.completionApiModel ?? '')
  }, [value.autoSave, value.completionEnabled, value.completionProvider, value.completionModel, value.completionApiEnabled, value.completionBaseUrl, value.completionApiModel])
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
    h('label', null, '补全模型 Provider', h('input', { style: input, value: provider, placeholder: '例如 deepseek', disabled, onChange: (event) => setProvider(event.target.value) })),
    h('label', null, '补全模型 Model', h('input', { style: input, value: model, placeholder: '例如 deepseek-chat', disabled, onChange: (event) => setModel(event.target.value) })),
    h('p', { style: { color: T.fgMuted, fontSize: '12px' } }, '填写 DSH 已配置的 Provider 和模型 ID；两项留空跟随 Agent。'),
    h('label', null, h('input', { type: 'checkbox', checked: apiEnabled, disabled, onChange: (event) => setApiEnabled(event.target.checked) }), '使用独立补全 API'),
    apiEnabled ? h('div', { style: { display: 'grid', gap: '12px', marginTop: '12px' } },
      h('p', { style: { color: T.fgMuted, fontSize: '12px', margin: 0 } }, '独立 API 优先于上方 Provider，支持 OpenAI 兼容的 Chat Completions 流式接口。'),
      h('label', null, 'API Base URL', h('input', { style: input, value: baseUrl, placeholder: 'https://api.example.com/v1', disabled, onChange: (event) => setBaseUrl(event.target.value) })),
      h('label', null, '补全模型 ID', h('input', { style: input, value: apiModel, placeholder: '接口提供的模型 ID', disabled, onChange: (event) => setApiModel(event.target.value) })),
      h('label', null, 'API Key', h('input', { type: 'password', autoComplete: 'new-password', style: input, value: apiKey, placeholder: '留空保留已保存密钥；本地接口可不填', disabled, onChange: (event) => { setApiKey(event.target.value); setClearApiKey(false) } })),
      h('label', null, h('input', { type: 'checkbox', checked: clearApiKey, disabled, onChange: (event) => { setClearApiKey(event.target.checked); setApiKey('') } }), '清除已保存的 API Key'),
      h('p', { style: { color: T.fgMuted, fontSize: '12px', margin: 0 } }, '密钥由 DSH Host 保存和使用，不回显到设置页。')) : null,
    h('button', { disabled, onClick: () => {
      if (form === undefined || snapshot.status === 'unavailable') { setNotice('设置服务尚未同步，请重新打开设置页后重试'); return }
      if (apiEnabled) {
        try {
          const endpoint = new URL(baseUrl.trim())
          if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || !apiModel.trim()) throw new Error()
        } catch { setNotice('请填写有效的 HTTP(S) API 地址和补全模型 ID'); return }
      } else if (Boolean(provider.trim()) !== Boolean(model.trim())) { setNotice('Provider 和 Model 必须同时填写，或同时留空'); return }
      const ops = Object.entries({ completionEnabled, completionProvider: provider.trim(), completionModel: model.trim(), completionApiEnabled: apiEnabled, completionBaseUrl: baseUrl.trim(), completionApiModel: apiModel.trim() }).map(([field, setting]) => ({ op: 'set', path: [field], value: setting }))
      if (clearApiKey || apiKey.trim()) ops.push({ op: 'set', path: ['completionApiKey'], value: clearApiKey ? '' : apiKey.trim() })
      persist(async () => {
        const saved = await form.mutate(ops, snapshot.revision)
        if (saved) { setApiKey(''); setClearApiKey(false); completionCache.clear() }
        return saved
      })
    } }, busy ? '保存中…' : '保存补全模型'),
    h('div', { role: 'status', style: { fontSize: '12px', marginTop: '8px', color: notice && notice !== '设置已保存' ? T.danger : T.fgMuted } }, notice || (form === undefined || snapshot.status === 'unavailable' ? '设置服务同步中，保存按钮将在同步后生效' : '')),
  )
}

function CodeWorkbenchSection({ renderSlot }) {
  return h('div', { style: { display: 'flex', flexDirection: 'column', minHeight: 0 } },
    h('h2', { style: { margin: '0 0 18px', fontSize: '20px', fontWeight: 500, color: T.fg } }, '代码工作台'),
    renderSlot('settings.code-workbench.item', {}),
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
  ctx.inject(['inputTriggers'], (scope) => {
    scope.effect(() => {
      try {
        return scope.inputTriggers.registerSource({
          trigger: '@',
          name: 'code-workbench',
          label: () => '选中代码',
          codec: {
            serialize: async (ref) => {
              if (ref?.pathOnly) return `\n工作区${ref.directory ? '目录' : '文件'}引用：${ref.path}\n请根据需要读取该路径下的代码。\n`
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
      'settings.form': settingsForm,
      'remote.stream': (spec) => ctx.remote.$stream(spec),
      'sessions.scope': (id) => ctx.sessions.scope(id),
    }),
  }, CodePanel)), 'code-workbench: tab body')
}

export { inject, apply }
export const name = TAB_KIND
