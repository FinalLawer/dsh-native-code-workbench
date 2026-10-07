/**
 * Client render smoke test.
 *
 * Renders the REAL `CodePanel` from the shipped bundle with `react-test-renderer`
 * (no browser needed), substitutes a recording fake Monaco namespace, and
 * drives the flows a human verifies in the GUI: open a file from the tree,
 * edit + save with the version guard, run a search and jump to a hit. This is
 * the evidence layer between unit tests and eyeballs.
 *
 *   node tools/test-client-smoke.mjs
 */
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { splitSnippets } from '../dsh-code-workbench/src/snippets.mjs'

const requireFrom = createRequire(new URL('../dsh-code-workbench/package.json', import.meta.url))
const React = requireFrom('react')
const TestRenderer = requireFrom('react-test-renderer')
const { act, create } = TestRenderer
const h = React.createElement

let failures = 0
// React 19 requires this flag for `act` outside a test framework.
globalThis.IS_REACT_ACT_ENVIRONMENT = true
/** Assert one expectation. */
function check(label, condition, detail) {
  if (condition) console.log(`  ok   ${label}`)
  else {
    failures++
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  }
}

// ---------------------------------------------------------------------------
// Environment stubs: minimal DOM for the bundle prelude, MutationObserver for
// the theme probe, and a recording fake Monaco namespace.
// ---------------------------------------------------------------------------
// A listener registry, not a no-op: the composer drop interceptor installs
// capture-phase listeners on `document`, and the drag flow below dispatches
// through it. Capture listeners are kept separately so a test can prove the
// plugin settles the gesture before any bubble-phase handler would see it.
const documentListeners = { capture: [], bubble: [] }
function addDocumentListener(type, handler, capture) {
  documentListeners[capture === true ? 'capture' : 'bubble'].push({ type, handler })
}
function removeDocumentListener(type, handler, capture) {
  const list = documentListeners[capture === true ? 'capture' : 'bubble']
  const index = list.findIndex((row) => row.type === type && row.handler === handler)
  if (index >= 0) list.splice(index, 1)
}
/** Dispatch a synthetic event and report the listeners that ran. */
function dispatchDocument(type, event) {
  const ran = []
  for (const row of [...documentListeners.capture]) {
    if (row.type !== type) continue
    row.handler(event)
    ran.push({ phase: 'capture', handler: row.handler })
    if (event.__stoppedPropagation === true) return ran
  }
  for (const row of [...documentListeners.bubble]) {
    if (row.type !== type) continue
    row.handler(event)
    ran.push({ phase: 'bubble', handler: row.handler })
    if (event.__stoppedPropagation === true) return ran
  }
  return ran
}

globalThis.document = {
  head: { appendChild() {} },
  createElement: () => ({
    dataset: {}, style: {}, placeholder: '', textContent: '', value: '',
    append() {}, appendChild() {}, addEventListener() {}, remove() {},
  }),
  getElementById: () => null,
  body: { hasAttribute: () => false },
  addEventListener: addDocumentListener,
  removeEventListener: removeDocumentListener,
}
globalThis.window = {
  __ModuleLoader__: {
    load(registration) {
      globalThis.__factory = registration.factory
    },
  },
}
let copiedText = ''
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async (value) => { copiedText = value } } } })
globalThis.MutationObserver = class {
  observe() {}
  disconnect() {}
}

const calls = {
  editorCreate: 0,
  models: [],
  contentCb: null,
  reveals: 0,
  selections: 0,
  list: [],
  read: [],
  fetch: [],
  changes: [],
  watchSpecs: [],
  inserted: [],
  bailed: [],
}
const fakeActx = {
  bail(self, event, payload) {
    calls.bailed.push({ event, payload })
    return true
  },
}
// A controllable fake for `remote.stream`: the test pushes watch frames.
const watchState = { queue: [], notify: null, disposed: 0 }
function fakeWatchStream(spec) {
  calls.watchSpecs.push(spec)
  spec.open(new AbortController().signal)
  return {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (watchState.queue.length > 0) yield watchState.queue.shift()
        await new Promise((resolve) => {
          watchState.notify = resolve
        })
      }
    },
    dispose() {
      watchState.disposed++
    },
  }
}
function pushWatch(frame) {
  watchState.queue.push({ value: frame, accept() {} })
  watchState.notify?.()
  watchState.notify = null
}
let currentModel = null
let selectionEmpty = true
let modelText = 'const needle = 1\nconst b = 2\n'

const fakeModel = {
  getOffsetAt: () => 16,
  getLineCount: () => 2,
  getLineMaxColumn: () => 20,
  getLanguageId: () => 'javascript',
  getValue: () => modelText,
  getValueInRange: () => 'const needle = 1\nconst b = 2',
  onDidChangeContent(cb) {
    calls.contentCb = cb
    return { dispose() {} }
  },
}
const fakeEditor = {
  dispose() {},
  trigger(source, command) {
    calls.inlineTriggers = (calls.inlineTriggers ?? 0) + (command === 'editor.action.inlineSuggest.trigger' ? 1 : 0)
  },
  setModel(model) {
    currentModel = model
  },
  getModel: () => currentModel,
  getValue: () => (currentModel ?? fakeModel).getValue(),
  addCommand(keybinding, handler) {
    calls.commands ??= []
    calls.commands.push({ keybinding, handler })
  },
  getSelection: () => ({
    isEmpty: () => selectionEmpty,
    startLineNumber: 3,
    endLineNumber: 5,
  }),
  getPosition: () => ({ lineNumber: 1, column: 17 }),
  onDidChangeCursorSelection(cb) {
    calls.selectionListener = cb
    return { dispose() {} }
  },
  executeEdits() {},
  pushUndoStop() {},
  addContentWidget() {},
  updateContentWidget() {},
  removeContentWidget() {},
  deltaDecorations: () => [],
  setSelection() {
    calls.selections++
  },
  revealLineInCenter() {
    calls.reveals++
  },
}
const fakeMonaco = {
  editor: {
    create() {
      calls.editorCreate++
      return fakeEditor
    },
    getModel: () => null,
    createModel(text, language) {
      calls.models.push({ text, language })
      let value = text
      let listener
      return { ...fakeModel, getValue: () => value,
        setValue(next) { value = next; listener?.() },
        onDidChangeContent(callback) { listener = callback; return { dispose() {} } },
        dispose() {},
      }
    },
    setTheme() {},
    ContentWidgetPositionPreference: { BELOW: 1 },
  },
  languages: {
    getLanguages: () => [
      { id: 'javascript', extensions: ['.js'], filenames: [] },
      { id: 'plaintext', extensions: [], filenames: [] },
    ],
    registerInlineCompletionsProvider: (selector, provider) => {
      calls.completionProvider = provider
      return { dispose() {} }
    },
  },
  Range: class Range {
    constructor(sl, sc, el, ec) {
      this.startLineNumber = sl
      this.startColumn = sc
      this.endLineNumber = el
      this.endColumn = ec
    }
  },
  Uri: { parse: (value) => ({ toString: () => value }) },
  KeyMod: { CtrlCmd: 2048 },
  KeyCode: { KeyS: 49, KeyL: 47, KeyK: 46 },
}
globalThis.__CODE_WORKBENCH_TEST_MONACO__ = fakeMonaco

// ---------------------------------------------------------------------------
// Load the shipped bundle and capture the tab body through the real apply().
// ---------------------------------------------------------------------------
const source = fs.readFileSync(new URL('../dsh-code-workbench/client.js', import.meta.url), 'utf8')
// eslint-disable-next-line no-new-func
new Function(source)()
const bundle = globalThis.__factory((specifier) => {
  if (specifier === 'react') return React
  throw new Error(`unexpected external require("${specifier}")`)
})

const registered = { slots: [], shortcuts: [], sources: [] }
let settingsSnapshot = { status: 'ready', writable: true, revision: 1, value: { autoSave: false, completionProvider: '', completionModel: '' } }
const settingsObservers = new Set()
const settingsWrites = []
const settingsForm = {
  getSnapshot: () => settingsSnapshot,
  subscribe: (listener) => { settingsObservers.add(listener); return () => settingsObservers.delete(listener) },
  async set(field, value) {
    settingsWrites.push({ field, value })
    settingsSnapshot = { ...settingsSnapshot, value: { ...settingsSnapshot.value, [field]: value } }
    for (const listener of settingsObservers) listener()
    return true
  },
  async mutate(operations) {
    for (const operation of operations) await this.set(operation.path[0], operation.value)
    return true
  },
}
const originalChat = React.memo(({ node }) => h('div', { 'data-original-chat': true }, Array.isArray(node.data.content) ? node.data.content.map((part) => part.text ?? '').join('') : String(node.data.content ?? '')))
bundle.apply({
  configForms: { get: () => settingsForm, whileServed: (names, callback) => callback() },
  effect: (callback) => callback(),
  inject: (names, callback) => callback({
    effect: (inner) => inner(),
    inputTriggers: {
      registerSource(source) {
        registered.sources.push(source)
        return () => {}
      },
    },
  }),
  slots: {
    entries: () => [{ options: { name: 'conversation.chat.node', key: 'user' }, component: originalChat }],
    inject: (key, callback) => callback(),
    register(options, component) {
      registered.slots.push({ options, component })
      return () => {}
    },
  },
  sidebarRightTabs: { register: () => () => {} },
  shortcuts: {
    registerFixed(command) {
      registered.shortcuts.push(command)
      return () => {}
    },
  },
})
const CodePanel = registered.slots.find((row) => row.options?.name === 'sidebar.right.pane.tab')?.component
const SettingsPanel = registered.slots.find((row) => row.options?.name === 'settings.code-workbench.item')?.component

// ---------------------------------------------------------------------------
// Recording Remote stubs and a fetch stub that answers each endpoint.
// ---------------------------------------------------------------------------
const files = {
  stat: async () => ({ ok: true, value: { version: { v: 1 } } }),
  list: async (sessionId, dir) => {
    calls.list.push(dir)
    return { ok: true, value: { entries: [{ name: 'a.js', type: 'file' }, { name: 'b.js', type: 'file' }, { name: 'sub', type: 'directory' }], truncated: false } }
  },
  read: async (sessionId, path) => {
    calls.read.push(path)
    return { ok: true, value: { text: fakeModel.getValue(), version: { v: 1 }, lines: 2, eof: true } }
  },
  changes: (sessionId, path) => {
    calls.changes.push(path)
    // The test's fake stream never iterates this; the call records the wiring.
    return (async function* () {})()
  },
}
globalThis.fetch = async (url, options) => {
  calls.fetch.push({ url, body: JSON.parse(options.body) })
  const payload = url.includes('/workbench-context')
    ? { ok: true, workspace: 'C:\\repo' }
    : url.includes('/search')
    ? {
        ok: true,
        matches: [{ path: 'C:\\repo\\a.js', line: 1, column: 7, length: 6, text: 'const needle = 1' }],
        truncated: false,
        filesScanned: 3,
        elapsedMs: 2,
      }
    : url.includes('/history')
      ? { ok: true, entries: [] }
      : { ok: true, version: { v: 2 }, operation: 'update' }
  return { ok: true, status: 200, json: async () => payload }
}

// ---------------------------------------------------------------------------
// Tree walking helpers over the test-renderer JSON output.
// ---------------------------------------------------------------------------
function findAll(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out)
    return out
  }
  if (node.props !== undefined && predicate(node)) out.push(node)
  findAll(node.children, predicate, out)
  return out
}
function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  return textOf(node.children)
}

const props = {
  sessionId: 's1',
  useSessions: (select) => select({ byId: { s1: { cwd: 'C:\\repo' } } }),
  inputActions: {
    captureInsertion: () => ({ start: 0, end: 0, draftRev: 1 }),
    insertText: (text, span) => {
      calls.inserted.push({ text, span })
      return true
    },
  },
  'sessions.scope': () => fakeActx,
  'settings.form': settingsForm,
  'remote.workspaceFiles': files,
  'remote.session': {},
  'remote.stream': fakeWatchStream,
}

// ---------------------------------------------------------------------------
// Flows
// ---------------------------------------------------------------------------
console.log('render shell + file tree')
let renderer
await act(async () => {
  // createNodeMock gives host elements (the editor container div) a non-null
  // instance, so the panel's hostRef behaves as it does in a browser.
  renderer = create(h(CodePanel, props), { createNodeMock: () => ({}) })
})
await act(async () => {})
const tree = () => renderer.toJSON()
const allText = () => textOf(tree())
check('the panel shell renders', allText().includes('保存 (Ctrl+S)') && allText().includes('就绪'), allText().slice(0, 80))
check('the tree lists the workspace root', allText().includes('a.js') && allText().includes('sub'), calls.list)
check('the root listing used the session cwd', calls.list[0] === 'C:\\repo', calls.list)
check('the editor mounted', calls.editorCreate === 1, calls.editorCreate)
check('editor commands retain save and Add to Chat without inline editing',
  JSON.stringify(calls.commands?.map((row) => row.keybinding)) === JSON.stringify([
    fakeMonaco.KeyMod.CtrlCmd | fakeMonaco.KeyCode.KeyS,
    fakeMonaco.KeyMod.CtrlCmd | fakeMonaco.KeyCode.KeyL,
  ]), calls.commands?.map((row) => row.keybinding))
check('inline editing is absent from the interface and shortcut catalog',
  !allText().includes('改写') && !registered.shortcuts.some((row) => row.id === 'code-workbench.rewrite'))

console.log('\nopen a file from the tree')
const fileRow = findAll(tree(), (n) => n.type === 'div' && n.props.title === 'C:\\repo\\a.js')[0]
check('the file row is clickable', fileRow !== undefined)
check('file row exposes themed hover styling without an inline background override',
  fileRow?.props.className === 'code-workbench-tree-row' && fileRow.props.style.background === undefined)
const folderRow = findAll(tree(), (n) => n.type === 'div' && n.props.title === 'C:\\repo\\sub')[0]
check('folders share the hover frame and keyboard focus styling',
  folderRow?.props.className === 'code-workbench-tree-row' && folderRow.props.tabIndex === 0)
const css = fs.readFileSync(new URL('../dsh-code-workbench/src/workbench.css', import.meta.url), 'utf8')
check('hover uses theme background and an inset frame without layout shifts',
  /\.code-workbench-tree-row:hover\s*\{[^}]*background:\s*var\(--dsw-alias-interactive-bg-hover\);[^}]*box-shadow:\s*inset 0 0 0 1px var\(--dsw-alias-border-l2\);/s.test(css))
check('active row has a separate brand-colored frame',
  /\.code-workbench-tree-row\[data-active="true"\]\s*\{[^}]*box-shadow:\s*inset 0 0 0 1px var\(--dsw-alias-brand-primary\);/s.test(css))
await act(async () => {
  fileRow.props.onClick()
})
await act(async () => {})
check('the file was read through workspaceFiles', calls.read.at(-1) === 'C:\\repo\\a.js', calls.read)
check('the editor model carries the content and language',
  calls.models.at(-1)?.language === 'javascript' && calls.models.at(-1)?.text.includes('needle'), calls.models.at(-1))
check('status reports the open file', allText().includes('2 行'), allText().slice(-60))
const activeTreeRows = findAll(tree(), (n) => n.props.className === 'code-workbench-tree-row' && n.props['data-active'] === true)
check('opening a file marks only its tree row active',
  activeTreeRows.length === 1 && activeTreeRows[0].props.title === 'C:\\repo\\a.js',
  activeTreeRows.map((n) => ({ title: n.props.title, active: n.props['data-active'] })))

console.log('\nversion check fallback')
const readsBeforePolling = calls.read.length
files.stat = async () => ({ ok: true, value: { version: { v: 3 } } })
await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1600)) })
check('changed disk version refreshes without a watch notification', calls.read.length > readsBeforePolling)
files.stat = async () => ({ ok: true, value: { version: { v: 1 } } })

console.log('\nAI completion provider')
const originalFetch = globalThis.fetch
const completionToken = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }
globalThis.fetch = async (url, options) => {
  calls.fetch.push({ url, body: JSON.parse(options.body) })
  return new Response('{"t":"delta","text":" + 1"}\n{"t":"done"}\n', { headers: { 'content-type': 'application/x-ndjson' } })
}
let suggestions
await act(async () => {
  suggestions = await calls.completionProvider.provideInlineCompletions(currentModel, { lineNumber: 1, column: 17 }, {}, completionToken)
})
check('provider implements the installed Monaco disposal API', typeof calls.completionProvider.disposeInlineCompletions === 'function')
check('provider sends caret context to the completion route', calls.fetch.at(-1)?.url === '/api/code-workbench/complete' && calls.fetch.at(-1)?.body.prefix.length === 16)
check('streamed completion becomes an insertion suggestion', suggestions?.items?.[0]?.insertText === ' + 1', suggestions)
check('completion status is visible', allText().includes('Tab 接受 AI 建议'))
globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'model unavailable' } }), { status: 409 })
await act(async () => { currentModel.setValue(currentModel.getValue() + '\n// force a distinct completion context\n') })
await act(async () => {
  suggestions = await calls.completionProvider.provideInlineCompletions(currentModel, { lineNumber: 1, column: 17 }, {}, completionToken)
})
check('failed completion returns no suggestion and exposes the failure', suggestions?.items?.length === 0 && allText().includes('AI 补全失败'))
globalThis.fetch = originalFetch

console.log('\nedit + save with the version guard')
await act(async () => {
  currentModel.setValue(currentModel.getValue() + '// edited\n')
  await new Promise((resolve) => setTimeout(resolve, 720))
})
check('the dirty indicator appears', allText().includes('● 未保存'))
check('editing schedules a visible inline preview request', calls.inlineTriggers > 0, calls.inlineTriggers)
const saveButton = findAll(tree(), (n) => n.type === 'button' && textOf(n).includes('保存'))[0]
await act(async () => {
  saveButton.props.onClick()
})
await act(async () => {})
const write = calls.fetch.at(-1)
check('save posted to the write route', write?.url.includes('/write'), write?.url)
check('the body carries the observed version', write?.body.expectedVersion?.v === 1, write?.body)
check('the body carries the editor content', write?.body.text.includes('const needle = 1'), write?.body?.text)
check('status confirms the save', allText().includes('已保存'), allText().slice(-60))

console.log('\nexternal change watch (auto-reload)')
check('the open file is watched', calls.changes.includes('C:\\repo\\a.js'), calls.changes)
const readsBefore = calls.read.length
await act(async () => {
  pushWatch({ kind: 'change', change: { absolutePath: 'C:\\repo\\a.js', version: { v: 9 } } })
})
await act(async () => {})
check('a clean buffer re-reads on external change', calls.read.length === readsBefore + 1, { before: readsBefore, after: calls.read.length })
check('status reports the auto reload', allText().includes('已自动刷新'), allText().slice(-80))
await act(async () => {
  currentModel.setValue(currentModel.getValue() + '// unsaved\n')
})
await act(async () => {
  pushWatch({ kind: 'change', change: { absolutePath: 'C:\\repo\\a.js', version: { v: 10 } } })
})
await act(async () => {})
check('a dirty buffer warns instead of clobbering', allText().includes('未保存的修改'), allText().slice(-80))
check('the warning did not overwrite the buffer', calls.read.length === readsBefore + 1, calls.read.length)

console.log('\nmulti-file buffers and tree refresh')
const firstModel = currentModel
const unsavedText = firstModel.getValue()
await act(async () => {
  findAll(tree(), (node) => node.type === 'div' && node.props.title === 'C:\\repo\\b.js')[0].props.onClick()
})
check('opening another file creates an independent model', currentModel !== firstModel)
const secondModel = currentModel
await act(async () => { secondModel.setValue('unsaved second file') })
const tabFor = (name) => findAll(tree(), (node) => node.props?.className?.split(' ').includes('code-workbench-tab') && textOf(node).includes(name))[0]
await act(async () => { tabFor('a.js').props.onClick() })
check('switching tabs restores the unsaved model and content', currentModel === firstModel && currentModel.getValue() === unsavedText)
check('inactive tabs display their own dirty markers', textOf(tabFor('b.js')).includes('●'))
await act(async () => { findAll(tabFor('b.js'), (node) => node.type === 'button')[0].props.onClick({ stopPropagation() {} }) })
await act(async () => { findAll(tree(), (node) => node.type === 'button' && textOf(node) === '取消')[0].props.onClick() })
check('canceling dirty close keeps the tab and contents', !!tabFor('b.js') && secondModel.getValue() === 'unsaved second file')
await act(async () => { findAll(tabFor('b.js'), (node) => node.type === 'button')[0].props.onClick({ stopPropagation() {} }) })
await act(async () => { findAll(tree(), (node) => node.type === 'form')[0].props.onSubmit({ preventDefault() {} }) })
check('confirmed close removes only the selected tab', !tabFor('b.js') && currentModel === firstModel && currentModel.getValue() === unsavedText)
await act(async () => {
  tabFor('a.js').props.onContextMenu({ preventDefault() {}, stopPropagation() {}, clientX: 0, clientY: 0 })
})
const tabMenuLabels = findAll(tree(), (node) => node.props?.role === 'menuitem').map(textOf)
check('tab context menu includes the requested close actions', ['关闭', '关闭其他', '关闭右侧标签页', '关闭已保存', '全部关闭', '复制路径', '复制相对路径'].every((label) => tabMenuLabels.includes(label)), tabMenuLabels)
await act(async () => { findAll(tree(), (node) => node.props?.role === 'menuitem' && textOf(node) === '复制路径')[0].props.onClick() })
check('tab menu copies the full path', copiedText === 'C:\\repo\\a.js', copiedText)
await act(async () => {
  tabFor('a.js').props.onContextMenu({ preventDefault() {}, stopPropagation() {}, clientX: 0, clientY: 0 })
})
await act(async () => { findAll(tree(), (node) => node.props?.role === 'menuitem' && textOf(node) === '复制相对路径')[0].props.onClick() })
check('tab menu copies the relative path', copiedText === 'a.js', copiedText)
const listingsBeforeRefresh = calls.list.length
await act(async () => { findAll(tree(), (node) => node.type === 'button' && node.props.title === '刷新')[0].props.onClick() })
check('tree refresh reloads directories and retains file rows', calls.list.length > listingsBeforeRefresh && allText().includes('b.js'))

console.log('\nfile operation dialogs and clipboard')
const contextMenuFor = async (path) => {
  await act(async () => {
    findAll(tree(), (node) => node.type === 'div' && node.props.title === path)[0].props.onContextMenu({ preventDefault() {}, stopPropagation() {}, currentTarget: {}, clientX: 0, clientY: 0 })
  })
}
const menuAction = async (label) => {
  await act(async () => { findAll(tree(), (node) => node.props?.role === 'menuitem' && textOf(node) === label)[0].props.onClick() })
}
const submitName = async (name) => {
  await act(async () => { findAll(tree(), (node) => node.type === 'input' && node.props['aria-label'] === '名称')[0].props.onChange({ target: { value: name } }) })
  await act(async () => { findAll(tree(), (node) => node.type === 'form')[0].props.onSubmit({ preventDefault() {} }) })
}
await contextMenuFor('C:\\repo\\b.js')
check('removed context actions are absent', !allText().includes('打开工作区终端') && !allText().includes('在文件夹中查找'))
await menuAction('新建文件…')
check('new file uses an embedded dialog', !!findAll(tree(), (node) => node.props?.role === 'dialog')[0])
await submitName('new.js')
check('new file submits the selected parent directory', calls.fetch.some((call) => call.body.operation === 'createFile' && call.body.path === 'C:\\repo\\new.js'))
await contextMenuFor('C:\\repo\\b.js')
await menuAction('新建文件夹…')
await submitName('new-folder')
check('new folder submits its name', calls.fetch.some((call) => call.body.operation === 'createDirectory' && call.body.path === 'C:\\repo\\new-folder'))
await contextMenuFor('C:\\repo\\b.js')
await menuAction('复制')
await contextMenuFor('C:\\repo\\sub')
await menuAction('粘贴')
check('copy paste submits a copy into the target folder', calls.fetch.some((call) => call.body.operation === 'copy' && call.body.destination === 'C:\\repo\\sub\\b - 副本.js'))
await contextMenuFor('C:\\repo\\b.js')
await menuAction('剪切')
await contextMenuFor('C:\\repo\\sub')
await menuAction('粘贴')
check('cut paste submits a move into the target folder', calls.fetch.some((call) => call.body.operation === 'rename' && call.body.destination === 'C:\\repo\\sub\\b.js'))
await contextMenuFor('C:\\repo\\b.js')
check('paste is disabled after a completed cut', findAll(tree(), (node) => node.props?.role === 'menuitem' && textOf(node) === '粘贴')[0].props.disabled)
await menuAction('重命名…')
await submitName('renamed.js')
check('rename submits the source and destination', calls.fetch.some((call) => call.body.operation === 'rename' && call.body.destination === 'C:\\repo\\renamed.js'))
await contextMenuFor('C:\\repo\\b.js')
await menuAction('删除…')
await act(async () => { findAll(tree(), (node) => node.type === 'form')[0].props.onSubmit({ preventDefault() {} }) })
check('delete requires confirmation and submits the selected file', calls.fetch.some((call) => call.body.operation === 'delete' && call.body.path === 'C:\\repo\\b.js'))
await act(async () => { tabFor('a.js').props.onClick() })

console.log('\nsearch + jump to a hit')
const searchButton = findAll(tree(), (n) => n.type === 'button' && n.props['aria-label'] === '搜索')[0]
await act(async () => {
  searchButton.props.onClick()
})
const searchInput = findAll(tree(), (n) => n.type === 'input')[0]
check('the search input appears', searchInput !== undefined)
await act(async () => {
  searchInput.props.onChange({ target: { value: 'needle' } })
})
// The state update re-renders with a fresh handler closure; drive THAT element.
await act(async () => {
  findAll(tree(), (n) => n.type === 'input')[0].props.onKeyDown({ key: 'Enter' })
})
await act(async () => {})
const searchCall = calls.fetch.at(-1)
check('the query posted to the search route', searchCall?.url.includes('/search') && searchCall?.body.query === 'needle', searchCall)
check('the hit renders as path:line', allText().includes('a.js:1'), allText().slice(0, 120))
const hitRow = findAll(tree(), (n) => n.type === 'div' && n.props.title === 'C:\\repo\\a.js')[0]
await act(async () => {
  hitRow.props.onClick()
})
await act(async () => {})
check('jumping reveals the line', calls.reveals >= 1 && calls.selections >= 1, { reveals: calls.reveals, selections: calls.selections })

console.log('\nadd to chat (selection -> chip in the main conversation draft)')
await act(async () => {
  selectionEmpty = false
  calls.selectionListener()
})
const chatButton = findAll(tree(), (n) => n.type === 'button' && textOf(n).includes('加到对话'))[0]
check('the Add-to-Chat button enables on selection', chatButton !== undefined && chatButton.props.disabled === false)
await act(async () => {
  chatButton.props.onClick()
})
await act(async () => {})
const insert = calls.bailed.at(-1)
check('the chip went through the reference-insert channel',
  insert?.event === 'slash/input-insert-reference', calls.bailed)
check('the chip is a compact label, not the code',
  insert?.payload.reference.label.includes('a.js:3-5') && insert.payload.reference.label.includes('行')
  && !insert.payload.reference.label.includes('const needle'), insert?.payload.reference.label)
check('the chip carries the code in its private ref payload',
  insert?.payload.reference.ref.code.includes('const needle = 1'), insert?.payload.reference.ref)
check('the chip insertion used a captured draft span', insert?.payload.span?.draftRev === 1, insert?.payload.span)
const codec = registered.sources.find((source) => source.name === 'code-workbench')?.codec
const expanded = await codec?.serialize(insert?.payload.reference.ref)
check('submit-time codec expands the chip to the anchored fenced code',
  expanded?.includes('a.js:3-5') && expanded.includes('```javascript') && expanded.includes('const needle = 1'),
  expanded)
check('status reports the add', allText().includes('已添加到对话'), allText().slice(-80))

console.log('\ndrag a tree row onto the composer (drop -> reference chip)')
const dragMime = 'application/x-code-workbench-tree'
// The search/jump flow above left the left pane on the search view; the drag
// gesture starts from a tree row, so bring the file tree back first.
await act(async () => {
  findAll(tree(), (n) => n.type === 'button' && n.props['aria-label'] === '文件')[0].props.onClick()
})
await act(async () => {})
// A composer input as the real client renders it: `data-composer-input` on the
// contenteditable root (`ComposerContentEditable` in dsh-client-ui-conversation).
const composerInput = { closest: (selector) => (selector === '[data-composer-input]' ? {} : null) }
const outsideInput = { closest: () => null }
function makeDataTransfer(entries) {
  const store = new Map(entries)
  return {
    types: [...store.keys()],
    effectAllowed: 'unset',
    dropEffect: 'unset',
    setData: (kind, value) => store.set(kind, value),
    getData: (kind) => store.get(kind) ?? '',
  }
}
function makeEvent(type, { dataTransfer, target }) {
  return {
    type, dataTransfer, target,
    __stoppedPropagation: false,
    __prevented: false,
    preventDefault() { this.__prevented = true },
    stopPropagation() { this.__stoppedPropagation = true },
  }
}
const treeRowFor = (title) => findAll(tree(), (n) => n.props?.className === 'code-workbench-tree-row' && n.props.title === title)[0]
const fileRowProps = treeRowFor('C:\\repo\\a.js').props
check('every tree row is a drag source', fileRowProps.draggable === true && typeof fileRowProps.onDragStart === 'function')

const dragTransfer = makeDataTransfer([])
await act(async () => {
  fileRowProps.onDragStart({ dataTransfer: dragTransfer })
})
check('the row publishes its workspace-relative path under the private flavor',
  dragTransfer.getData(dragMime) === 'fa.js', dragTransfer.getData(dragMime))
check('the drag advertises a copy operation', dragTransfer.effectAllowed === 'copy', dragTransfer.effectAllowed)
check('a plain-text fallback rides along for non-composer targets',
  dragTransfer.getData('text/plain') === 'a.js', dragTransfer.getData('text/plain'))

const folderRowProps = treeRowFor('C:\\repo\\sub').props
const folderTransfer = makeDataTransfer([])
await act(async () => { folderRowProps.onDragStart({ dataTransfer: folderTransfer }) })
check('a dropped directory is marked as one', folderTransfer.getData(dragMime) === 'dsub', folderTransfer.getData(dragMime))

// Dragging over the composer must be claimed (preventDefault) so the browser
// shows a copy affordance instead of refusing the drop.
const dragOverEvent = makeEvent('dragover', { dataTransfer: makeDataTransfer([[dragMime, 'fa.js']]), target: composerInput })
await act(async () => { dispatchDocument('dragover', dragOverEvent) })
check('dragover over the composer is claimed with a copy affordance',
  dragOverEvent.__prevented === true && dragOverEvent.dataTransfer.dropEffect === 'copy', dragOverEvent.dataTransfer.dropEffect)

const bailCountBeforeDrop = calls.bailed.length
const dropEvent = makeEvent('drop', { dataTransfer: makeDataTransfer([[dragMime, 'fa.js'], ['text/plain', 'a.js']]), target: composerInput })
const ranForDrop = await act(async () => dispatchDocument('drop', dropEvent))
check('the drop is claimed in the capture phase and stopped before Lexical sees it',
  dropEvent.__prevented === true && dropEvent.__stoppedPropagation === true, { prevented: dropEvent.__prevented, stopped: dropEvent.__stoppedPropagation })
check('a capture listener handled the drop, not a bubble one',
  ranForDrop.length === 1 && ranForDrop[0].phase === 'capture', ranForDrop.map((row) => row.phase))
const dropped = calls.bailed.at(-1)
check('the drop produced exactly one reference insert', calls.bailed.length === bailCountBeforeDrop + 1, calls.bailed.length)
check('the dropped row goes through the reference-insert channel',
  dropped?.event === 'slash/input-insert-reference', dropped?.event)
check('the chip carries a path-only reference for the dropped file',
  dropped?.payload.reference.ref.path === 'a.js'
  && dropped.payload.reference.ref.pathOnly === true
  && dropped.payload.reference.ref.directory === false
  && dropped.payload.reference.label === 'a.js', dropped?.payload.reference)
check('the drop reuses the captured draft span', dropped?.payload.span?.draftRev === 1, dropped?.payload.span)
check('status reports the dropped file', allText().includes('已添加到对话：a.js'), allText().slice(-80))

// A directory drop carries the trailing-slash label so the chip reads as a folder.
const folderDrop = makeEvent('drop', { dataTransfer: makeDataTransfer([[dragMime, 'dsub']]), target: composerInput })
await act(async () => { dispatchDocument('drop', folderDrop) })
const droppedDir = calls.bailed.at(-1)
check('a dropped directory lands as a directory reference',
  droppedDir?.payload.reference.ref.directory === true && droppedDir.payload.reference.label === 'sub/',
  droppedDir?.payload.reference)

// Narrowness: the interceptor must never swallow gestures that are not ours.
const outsideDrop = makeEvent('drop', { dataTransfer: makeDataTransfer([[dragMime, 'fa.js']]), target: outsideInput })
await act(async () => { dispatchDocument('drop', outsideDrop) })
check('a drop outside the composer is left alone', outsideDrop.__prevented === false && outsideDrop.__stoppedPropagation === false)

const fileDrop = makeDataTransfer([['Files', ''], [dragMime, 'fa.js']])
const fileDropEvent = makeEvent('drop', { dataTransfer: fileDrop, target: composerInput })
await act(async () => { dispatchDocument('drop', fileDropEvent) })
check('a real OS file drop is left to the attachment pipeline',
  fileDropEvent.__prevented === false && fileDropEvent.__stoppedPropagation === false)

const foreignEvent = makeEvent('drop', { dataTransfer: makeDataTransfer([['text/plain', 'hello']]), target: composerInput })
await act(async () => { dispatchDocument('drop', foreignEvent) })
check('an unrelated same-shape text drag is left to Lexical', foreignEvent.__prevented === false)

const bailCountBeforeBusy = calls.bailed.length
const originalScope = props['sessions.scope']
const insertCountBeforeBusy = calls.bailed.length
await act(async () => {
  // A composer still accepting events but with no resolvable scope: the drop
  // must degrade with a message, not throw and not insert.
  fakeActx.bail = () => false
})
const busyDrop = makeEvent('drop', { dataTransfer: makeDataTransfer([[dragMime, 'fa.js']]), target: composerInput })
await act(async () => { dispatchDocument('drop', busyDrop) })
check('a busy composer reports the failure instead of throwing',
  allText().includes('添加失败'), allText().slice(-80))
fakeActx.bail = (self, event, payload) => { calls.bailed.push({ event, payload }); return true }
check('the busy path did not append a chip', calls.bailed.length === insertCountBeforeBusy, calls.bailed.length)
props['sessions.scope'] = originalScope
void bailCountBeforeBusy

console.log('\ncompact sent reference')
const Chat = registered.slots.find((row) => row.options.name === 'conversation.chat.node' && row.options.key === 'user')?.component
let chatRenderer
await act(async () => {
  chatRenderer = create(h(Chat, { node: { data: { content: [{ type: 'text', text: `请解释${expanded}谢谢` }] } } }))
})
const chatTree = chatRenderer.toJSON()
const disclosure = findAll(chatTree, (node) => node.type === 'details')[0]
check('sent code is collapsed by default', disclosure !== undefined && !disclosure.props.open)
check('sent reference has a compact filename and line summary', textOf(findAll(chatTree, (node) => node.type === 'summary')[0]).includes('a.js:3-5'))
check('original bubble retains the question without expanded code', textOf(findAll(chatTree, (node) => node.props?.['data-original-chat'])[0]).includes('请解释') && !textOf(findAll(chatTree, (node) => node.props?.['data-original-chat'])[0]).includes('const needle'))
check('expanded disclosure retains the exact submitted code', textOf(findAll(chatTree, (node) => node.type === 'code')[0]).includes('const needle'))
check('reference parser tolerates normalized line endings', splitSnippets(expanded.replaceAll('\n', '\r\n')).some((part) => part.anchor === 'a.js:3-5'))
await act(async () => { chatRenderer.unmount() })

console.log('\nhistory mode')
const historyButton = findAll(tree(), (n) => n.type === 'button' && n.props['aria-label'] === '历史')[0]
await act(async () => {
  historyButton.props.onClick()
})
await act(async () => {})
check('history posted for the open file', calls.fetch.at(-1)?.url.includes('/history') && calls.fetch.at(-1)?.body.path === 'C:\\repo\\a.js', calls.fetch.at(-1))
check('empty history renders honestly', allText().includes('还没有保存记录'), allText().slice(-60))

console.log('\nplugin settings and automatic save')
let settingsRenderer
await act(async () => {
  settingsRenderer = create(h(SettingsPanel, { form: settingsForm }))
})
await act(async () => {
  findAll(settingsRenderer.toJSON(), (node) => node.props?.role === 'switch')[0].props.onClick()
})
check('automatic save preference is persisted through the Host form', settingsWrites.some((write) => write.field === 'autoSave' && write.value === true))
const previousWrites = calls.fetch.filter((call) => call.url.includes('/write')).length
await act(async () => {
  currentModel.setValue(currentModel.getValue() + '// automatically saved\n')
})
await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1050)) })
check('automatic save writes the edited buffer after a pause', calls.fetch.filter((call) => call.url.includes('/write')).length > previousWrites)
await act(async () => {
  const inputs = findAll(settingsRenderer.toJSON(), (node) => node.type === 'input' && node.props.placeholder)
  inputs.find((node) => node.props.placeholder === '例如 deepseek').props.onChange({ target: { value: 'fast-provider' } })
  inputs.find((node) => node.props.placeholder === '例如 deepseek-chat').props.onChange({ target: { value: 'fast-model' } })
})
await act(async () => {
  findAll(settingsRenderer.toJSON(), (node) => node.type === 'button' && textOf(node) === '保存补全模型')[0].props.onClick()
})
check('dedicated provider and model are persisted together', settingsSnapshot.value.completionProvider === 'fast-provider' && settingsSnapshot.value.completionModel === 'fast-model')
await act(async () => {
  findAll(settingsRenderer.toJSON(), (node) => node.type === 'input' && node.props.type === 'checkbox')[0].props.onChange({ target: { checked: true } })
})
await act(async () => {
  const inputs = findAll(settingsRenderer.toJSON(), (node) => node.type === 'input')
  inputs.find((node) => node.props.placeholder === 'https://api.example.com/v1').props.onChange({ target: { value: 'https://example.com/v1' } })
  inputs.find((node) => node.props.placeholder === '接口提供的模型 ID').props.onChange({ target: { value: 'api-model' } })
  inputs.find((node) => node.props.type === 'password').props.onChange({ target: { value: 'test-secret' } })
})
await act(async () => {
  findAll(settingsRenderer.toJSON(), (node) => node.type === 'button' && textOf(node) === '保存补全模型')[0].props.onClick()
})
check('independent API preferences are saved', settingsSnapshot.value.completionApiEnabled === true && settingsSnapshot.value.completionApiModel === 'api-model' && settingsSnapshot.value.completionApiKey === 'test-secret')
check('saved API key is cleared from the input', findAll(settingsRenderer.toJSON(), (node) => node.props?.type === 'password')[0].props.value === '')
await act(async () => { settingsRenderer.unmount() })

console.log('\nshortcut rows published')
check('editor shortcuts are in the shell catalog', registered.shortcuts.length >= 3, registered.shortcuts.map((row) => row.id))

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
await act(async () => { renderer.unmount() })
process.exit(failures === 0 ? 0 : 1)
