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
import { COMPLETION_PREFIX_CHARS, COMPLETION_SUFFIX_CHARS } from '../dsh-code-workbench/src/completion-window.mjs'

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
/**
 * Tree row nodes, so the keyboard-navigation path can be observed.
 *
 * `react-test-renderer` has no DOM: `createNodeMock` decides what a host element
 * is, and it only ever receives `{ ref, className, children }` — React strips
 * every other prop first. The tree therefore files each row node into its own
 * path→node map through a callback ref, and `focusRow` is the only code that
 * reaches for a node. This mock records what `focusRow` did to it.
 */
const treeRowNodes = []
let lastFocusedTreeRow = null
/** The last selection range an in-tree name field was given, so the test can
 *  assert *which part* of a filename is preselected on rename. */
let lastFieldSelection = null
function createMockNode(element) {
  const { ref, className, type } = element.props ?? {}
  if (type === 'text' && className === 'code-workbench-tree-editor-input') {
    // The rename field preselects the stem before the extension. A real input
    // would apply this itself; the mock records the request instead.
    return {
      value: element.props.value ?? '',
      focus() {},
      setSelectionRange(start, end) { lastFieldSelection = { start, end, value: this.value } },
    }
  }
  if (className === 'code-workbench-tree-row') {
    // Stand in for the real element and hand it back to the tree through the
    // same callback ref React would call. `title` carries the absolute path and
    // is what the assertions use to say *which* row took focus.
    const node = {
      path: element.props?.title,
      focused: false,
      scrolled: null,
      focus() { this.focused = true; lastFocusedTreeRow = node.path },
      scrollIntoView(options) { this.scrolled = options },
    }
    treeRowNodes.push(node)
    ref?.(node)
    return node
  }
  return {}
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
  stat: 0,
  fetch: [],
  changes: [],
  watchSpecs: [],
  inserted: [],
  bailed: [],
  previewOpens: [],
}
const fakeActx = {
  bail(self, event, payload) {
    calls.bailed.push({ event, payload })
    return true
  },
}
// A controllable fake for `remote.stream`: the test pushes watch frames.
const watchState = { queue: [], notify: null, disposed: 0, ends: false }
function fakeWatchStream(spec) {
  calls.watchSpecs.push(spec)
  spec.open(new AbortController().signal)
  return {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (watchState.queue.length > 0) yield watchState.queue.shift()
        if (watchState.ends) throw new Error('watch ended')
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
/** End the stream the way a dropped connection does: with an error. */
function endWatch() {
  watchState.ends = true
  watchState.notify?.()
  watchState.notify = null
}
let currentModel = null
let selectionEmpty = true
let modelText = 'const needle = 1\nconst b = 2\n'
// The caret offset, movable so the completion window can be driven to its caps.
let fakeOffset = 16

const fakeModel = {
  getOffsetAt: () => fakeOffset,
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
      calls.inlineCompletionProvider = provider
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
let settingsSnapshot = { status: 'ready', writable: true, revision: 1, value: { autoSave: false, completionEnabled: true, completionBaseUrl: 'https://api.deepseek.com/beta', completionApiModel: 'deepseek-flash' } }
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
  stat: async () => { calls.stat++; return { ok: true, value: { version: { v: 1 } } } },
  list: async (sessionId, dir) => {
    calls.list.push(dir)
    return { ok: true, value: { entries: [{ name: 'a.js', type: 'file' }, { name: 'b.js', type: 'file' }, { name: 'sub', type: 'directory' }], truncated: false } }
  },
  read: async (sessionId, path) => {
    calls.read.push(path)
    // The Host's text channel refuses anything that is not UTF-8 text: the exact
    // failure a PDF, a spreadsheet or an Office container produces. The panel has
    // to react to the code, so the stub answers with the real one.
    if (path.endsWith('.xlsx')) {
      return { ok: false, error: { code: 'workspace-file/not-text', message: 'file is not UTF-8 text' } }
    }
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
      : url.includes('/completion-status')
        ? { ok: true, mode: 'fim', endpoint: 'https://api.deepseek.com/beta/completions', addressValid: true, model: 'deepseek-flash', source: 'store' }
        : url.includes('/complete')
          ? { ok: true, text: '' }
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

// The right-sidebar navigation controller the body is handed. The panel calls
// exactly one method on it, so the recorder is the whole fake.
const previewController = {
  openResource: (address) => {
    calls.previewOpens.push(address)
  },
}
const props = {
  sessionId: 's1',
  sidebarRight: previewController,
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
  // instance, so the panel's hostRef behaves as it does in a browser. Tree rows
  // and the tree scroller get richer stand-ins so keyboard focus is observable.
  renderer = create(h(CodePanel, props), { createNodeMock: createMockNode })
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
files.stat = async () => { calls.stat++; return { ok: true, value: { version: { v: 3 } } } }
await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1600)) })
check('changed disk version refreshes without a watch notification', calls.read.length > readsBeforePolling)
files.stat = async () => { calls.stat++; return { ok: true, value: { version: { v: 1 } } } }

console.log('\nAI completion provider')
const originalFetch = globalThis.fetch
const completionToken = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }
globalThis.fetch = async (url, options) => {
  calls.fetch.push({ url, body: JSON.parse(options.body) })
  return new Response(JSON.stringify({ ok: true, text: ' + 1' }), { headers: { 'content-type': 'application/json' } })
}
let suggestions
await act(async () => {
  suggestions = await calls.inlineCompletionProvider.provideInlineCompletions(currentModel, { lineNumber: 1, column: 17 }, {}, completionToken)
})
check('provider implements the installed Monaco disposal API', typeof calls.inlineCompletionProvider.disposeInlineCompletions === 'function')
check('the provider debounces long enough to skip mid-word requests, but no more', calls.inlineCompletionProvider.debounceDelayMs === 180, calls.inlineCompletionProvider.debounceDelayMs)
check('provider sends caret context to the completion route', calls.fetch.at(-1)?.url === '/api/code-workbench/complete' && calls.fetch.at(-1)?.body.prefix.length === 16)
check('the completion becomes an insertion suggestion', suggestions?.items?.[0]?.insertText === ' + 1', suggestions)
check('completion status is visible', allText().includes('Tab 接受 AI 建议'))
// The Host answers an empty completion instead of an error when it declines to
// try, so an empty result must read as "no suggestion", not as a failure.
globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, text: '' }), { headers: { 'content-type': 'application/json' } })
await act(async () => { currentModel.setValue(currentModel.getValue() + '\n// force a distinct completion context\n') })
await act(async () => {
  suggestions = await calls.inlineCompletionProvider.provideInlineCompletions(currentModel, { lineNumber: 1, column: 17 }, {}, completionToken)
})
check('an empty completion yields no suggestion and no error', suggestions?.items?.length === 0 && allText().includes('AI 未返回补全'), allText().slice(-200))
// A transport failure is the one path that still surfaces in the editor.
globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'model unavailable' } }), { status: 409 })
await act(async () => { currentModel.setValue(currentModel.getValue() + '\n// force another distinct completion context\n') })
await act(async () => {
  suggestions = await calls.inlineCompletionProvider.provideInlineCompletions(currentModel, { lineNumber: 1, column: 17 }, {}, completionToken)
})
check('failed completion returns no suggestion and exposes the failure', suggestions?.items?.length === 0 && allText().includes('AI 补全失败'))
// Two asks for the same caret are one round trip, and the second one has to
// receive the answer rather than "no suggestion". Monaco stores an empty answer
// as a verdict against that model version and then refuses to ask again for it
// (`UpdateRequest.satisfies` short-circuits the retry), so answering empty while
// a request was already in flight left the caret with no ghost text until the
// next keystroke — the "I have to press space or backspace to wake it up"
// report. A slow fetch makes the overlap deterministic instead of a race.
let slowFetches = 0
globalThis.fetch = async (url, options) => {
  calls.fetch.push({ url, body: JSON.parse(options.body) })
  slowFetches++
  await new Promise((resolve) => setTimeout(resolve, 20))
  return new Response(JSON.stringify({ ok: true, text: ' + 1' }), { headers: { 'content-type': 'application/json' } })
}
await act(async () => { currentModel.setValue(currentModel.getValue() + '\n// concurrent context\n') })
const concurrentToken = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }
const fetchesBeforeAsk = slowFetches
const firstAsk = calls.inlineCompletionProvider.provideInlineCompletions(currentModel, { lineNumber: 1, column: 17 }, {}, concurrentToken)
const fetchesAfterFirst = slowFetches
const secondAsk = calls.inlineCompletionProvider.provideInlineCompletions(currentModel, { lineNumber: 1, column: 17 }, {}, concurrentToken)
const fetchesAfterSecond = slowFetches
let joined = null
await act(async () => { joined = await Promise.all([firstAsk, secondAsk]) })
check('the first ask actually leaves a request in flight',
  fetchesAfterFirst === fetchesBeforeAsk + 1, { fetchesBeforeAsk, fetchesAfterFirst })
check('a second ask for the same caret joins the round trip instead of starting one',
  fetchesAfterSecond === fetchesAfterFirst, { fetchesAfterFirst, fetchesAfterSecond })
check('the joined ask receives the answer instead of "no suggestion"',
  joined?.[1]?.items?.[0]?.insertText === ' + 1', joined?.[1])
globalThis.fetch = originalFetch

console.log('\nedit + save with the version guard')
await act(async () => {
  currentModel.setValue(currentModel.getValue() + '// edited\n')
  await new Promise((resolve) => setTimeout(resolve, 720))
})
check('the dirty indicator appears', allText().includes('● 未保存'))
// Monaco asks on its own for every typed character, for backspace and delete
// (they sit in its `triggerCommands` list precisely because they never reach
// `onDidType`), and for Tab and paste. Nudging it from here arrives as an
// *Explicit* trigger, which never satisfies the automatic request already on the
// wire — Monaco drops that one and starts over. So each completion paid a second
// round trip plus a fixed 400ms of extra wait, and each extra keystroke pushed
// the ghost text another 400ms away. Asserting the count is zero pins that the
// plugin leaves the driving to Monaco.
check('editing never makes the plugin drive the editor itself', (calls.inlineTriggers ?? 0) === 0, calls.inlineTriggers ?? 0)
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
/**
 * Type a name into the in-tree field and commit it with Enter.
 *
 * Creating and renaming happen *inside* the tree — the field is a row-shaped
 * `<input>` in the row list, not a modal — so this drives the real element the
 * user types into, including the Enter keydown that commits it.
 */
const inlineInput = () => findAll(tree(), (node) => node.type === 'input' && node.props?.className === 'code-workbench-tree-editor-input')[0]
const submitName = async (name) => {
  await act(async () => { inlineInput().props.onChange({ target: { value: name } }) })
  await act(async () => { inlineInput().props.onKeyDown({ key: 'Enter', preventDefault() {}, stopPropagation() {} }) })
  await act(async () => {})
}
await contextMenuFor('C:\\repo\\b.js')
check('removed context actions are absent', !allText().includes('打开工作区终端') && !allText().includes('在文件夹中查找'))
await menuAction('新建文件…')
// The field lives in the tree, so the files around it stay visible. It must
// NOT be a modal — that is the whole point of editing in place.
check('new file uses an in-tree field, not a dialog',
  inlineInput() !== undefined && findAll(tree(), (node) => node.props?.role === 'dialog').length === 0,
  { hasInput: inlineInput() !== undefined, dialogs: findAll(tree(), (node) => node.props?.role === 'dialog').length })
check('the create field sits in the row list at the destination depth',
  inlineInput().props.placeholder === '文件名' && inlineInput().props.value === '')
await submitName('new.js')
check('new file submits the selected parent directory', calls.fetch.some((call) => call.body.operation === 'createFile' && call.body.path === 'C:\\repo\\new.js'))
await contextMenuFor('C:\\repo\\b.js')
await menuAction('新建文件夹…')
await submitName('new-folder')
check('new folder submits its name', calls.fetch.some((call) => call.body.operation === 'createDirectory' && call.body.path === 'C:\\repo\\new-folder'))

console.log('\nin-tree field: cancelling, empty names, and rejected names')
// The field must never trap the user. Escape abandons the edit, clicking away
// abandons an *empty* edit, and a rejected name keeps the input alive.
const createCalls = () => calls.fetch.filter((call) => call.body?.operation === 'createFile' || call.body?.operation === 'createDirectory')
await contextMenuFor('C:\\repo\\b.js')
await menuAction('新建文件…')
const beforeEscape = createCalls().length
await act(async () => { inlineInput().props.onChange({ target: { value: 'typed-then-abandoned.js' } }) })
await act(async () => { inlineInput().props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() {} }) })
await act(async () => {})
check('Escape closes an open create field', inlineInput() === undefined)
check('Escape creates nothing', createCalls().length === beforeEscape, createCalls().map((call) => call.body.path))

await contextMenuFor('C:\\repo\\b.js')
await menuAction('新建文件…')
await act(async () => { inlineInput().props.onBlur() })
await act(async () => {})
check('blurring an untouched field closes it without creating anything',
  inlineInput() === undefined && createCalls().length === beforeEscape,
  createCalls().map((call) => call.body.path))

await contextMenuFor('C:\\repo\\b.js')
await menuAction('新建文件…')
await act(async () => { inlineInput().props.onChange({ target: { value: 'has/slash.js' } }) })
await act(async () => { inlineInput().props.onKeyDown({ key: 'Enter', preventDefault() {}, stopPropagation() {} }) })
await act(async () => {})
check('a name with a path separator is rejected', createCalls().length === beforeEscape)
check('a rejected name keeps the field open so the input is not lost',
  inlineInput() !== undefined && inlineInput().props.value === 'has/slash.js',
  { open: inlineInput() !== undefined, value: inlineInput()?.props.value })
check('the rejection is explained to the user', allText().includes('不能包含路径分隔符'), allText().slice(-90))
check('the field is marked invalid for assistive tech', inlineInput().props['aria-invalid'] === true)
// Correcting the name clears the complaint and commits normally.
await act(async () => { inlineInput().props.onChange({ target: { value: 'corrected.js' } }) })
await act(async () => {})
check('editing clears the previous error', inlineInput().props['aria-invalid'] === false && !allText().includes('不能包含路径分隔符'))
await act(async () => { inlineInput().props.onKeyDown({ key: 'Enter', preventDefault() {}, stopPropagation() {} }) })
await act(async () => {})
check('the corrected name commits', calls.fetch.some((call) => call.body.operation === 'createFile' && call.body.path === 'C:\\repo\\corrected.js'))
check('the field closes after a successful commit', inlineInput() === undefined)

// --- Committing must happen exactly once. Enter both submits the name and
// unmounts the field, which fires blur; if blur submitted too, every file would
// be created twice.
await contextMenuFor('C:\\repo\\b.js')
await menuAction('新建文件…')
const beforeSingleSubmit = createCalls().length
await act(async () => { inlineInput().props.onChange({ target: { value: 'exactly-once.js' } }) })
// Capture the handlers before the field unmounts, since the input is gone after.
const committingProps = inlineInput().props
await act(async () => { committingProps.onKeyDown({ key: 'Enter', preventDefault() {}, stopPropagation() {} }) })
await act(async () => {})
check('Enter creates the file once',
  createCalls().length === beforeSingleSubmit + 1, createCalls().slice(beforeSingleSubmit).map((call) => call.body.path))
// The blur that React fires while unmounting must be a no-op, not a second write.
await act(async () => { committingProps.onBlur() })
await act(async () => {})
check('the blur that follows a commit does not submit again',
  createCalls().length === beforeSingleSubmit + 1, createCalls().slice(beforeSingleSubmit).map((call) => call.body.path))

console.log('\ntoolbar create targets the selected row, not the workspace root')
const toolbarButton = (label) => findAll(tree(), (node) => node.type === 'button' && node.props['aria-label'] === label)[0]
const rowFor = (title) => findAll(tree(), (node) => node.props?.className === 'code-workbench-tree-row' && node.props.title === title)[0]
const submittedCreate = (operation, path) => calls.fetch.some((call) => call.body.operation === operation && call.body.path === path)
const createViaToolbar = async (label, name) => {
  await act(async () => { toolbarButton(label).props.onClick() })
  await submitName(name)
}

// Baseline: nothing selected yet in this tree, so the root remains the fallback.
await createViaToolbar('新建文件夹', 'at-root')
check('with no selection the toolbar falls back to the workspace root',
  submittedCreate('createDirectory', 'C:\\repo\\at-root'))

// Selecting a directory targets that directory itself.
await act(async () => { rowFor('C:\\repo\\sub').props.onClick() })
await act(async () => {})
check('clicking a directory row marks it selected',
  rowFor('C:\\repo\\sub').props['data-selected'] === true, rowFor('C:\\repo\\sub').props['data-selected'])
check('the toolbar names the selected directory as its target',
  toolbarButton('新建文件夹').props.title.includes('sub'), toolbarButton('新建文件夹').props.title)
await createViaToolbar('新建文件夹', 'inside-sub')
check('the new folder lands inside the selected directory, not the root',
  submittedCreate('createDirectory', 'C:\\repo\\sub\\inside-sub')
  && !submittedCreate('createDirectory', 'C:\\repo\\inside-sub'))

// Selecting a file targets its sibling directory instead of the file itself.
await act(async () => { rowFor('C:\\repo\\a.js').props.onClick() })
await act(async () => {})
check('selecting a file moves the selection off the directory',
  rowFor('C:\\repo\\a.js').props['data-selected'] === true
  && rowFor('C:\\repo\\sub').props['data-selected'] !== true)
await createViaToolbar('新建文件', 'sibling.js')
check('a file selection creates alongside it, not inside it',
  submittedCreate('createFile', 'C:\\repo\\sibling.js'),
  calls.fetch.filter((call) => call.body.operation === 'createFile').map((call) => call.body.path))

// The right-click path must keep its own independent targeting.
await contextMenuFor('C:\\repo\\sub')
const contextSelectedTitle = toolbarButton('新建文件').props.title
await menuAction('新建文件夹…')
await submitName('via-menu')
check('the context menu still creates in the right-clicked directory',
  submittedCreate('createDirectory', 'C:\\repo\\sub\\via-menu'))
check('the context menu does not disturb the toolbar target', contextSelectedTitle === toolbarButton('新建文件').props.title)
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

console.log('\nrenaming to a name the host would refuse')
// --- Committing an unchanged name must not reach the host.
//
// The host rejects any rename whose destination sits inside its source, and
// `contains` is reflexive — so `destination === source` is refused with
// "目标必须在工作区内且不能位于源目录内". Re-submitting the prefilled name is a
// no-op, not an error: the field should just close. This runs after the toolbar
// suite because opening a rename marks its row selected, which that suite reads.
const renameCallsSoFar = () => calls.fetch.filter((call) => call.body?.operation === 'rename')
await contextMenuFor('C:\\repo\\a.js')
await menuAction('重命名…')
const beforeNoopRename = renameCallsSoFar().length
// Exactly what the field is prefilled with — the user pressed Enter unchanged.
check('the no-op rename field is prefilled with the unchanged name',
  inlineInput().props.value === 'a.js', inlineInput().props.value)
await act(async () => { inlineInput().props.onKeyDown({ key: 'Enter', preventDefault() {}, stopPropagation() {} }) })
await act(async () => {})
check('an unchanged name issues no rename operation',
  renameCallsSoFar().length === beforeNoopRename, renameCallsSoFar().slice(beforeNoopRename).map((call) => call.body))
check('an unchanged name closes the field instead of erroring',
  inlineInput() === undefined, inlineInput()?.props.value)
check('an unchanged name reports honestly instead of failing',
  allText().includes('名称未改变') && !allText().includes('操作失败'), allText().slice(-90))

// The guard must not over-trigger: a sibling that merely shares the folder-name
// prefix is a perfectly legal rename and must stay submittable.
await contextMenuFor('C:\\repo\\sub')
await menuAction('重命名…')
await act(async () => { inlineInput().props.onChange({ target: { value: 'sub.inner' } }) })
await act(async () => {})
check('a sibling sharing the folder name prefix is not refused',
  inlineInput().props['aria-invalid'] === false, inlineInput().props['aria-invalid'])
await act(async () => { inlineInput().props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() {} }) })
await act(async () => {})

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
// The drag serves two drop targets: the composer (a copy into the chat) and the
// tree itself (a move into a folder). So it advertises both effects and lets
// each target pick; advertising only `copy` would make the tree refuse a move.
check('the drag advertises both copy and move', dragTransfer.effectAllowed === 'copyMove', dragTransfer.effectAllowed)
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

// What a submission carries decides two things at once: the transcript's
// projector only decorates a `@token` (start of text or after whitespace) into
// the same capsule the composer showed, and the standing `@` guidance in the
// system prompt already tells the model how to read one. A self-authored
// instruction block satisfies neither — it lands in the log as a paragraph,
// which is what a dropped file used to read as.
const dropCodec = registered.sources.find((source) => source.name === 'code-workbench')?.codec
const mentionOf = (ref) => dropCodec?.serialize(ref)
const fileMention = await mentionOf(dropped?.payload.reference.ref)
check('a dropped file expands to the shared @path mention', fileMention === ' @a.js', fileMention)
const dirMention = await mentionOf(droppedDir?.payload.reference.ref)
check('a dropped directory keeps the trailing slash that marks it a folder', dirMention === ' @sub/', dirMention)
check('the chip clipboard text matches its submit-time expansion verbatim',
  dropped?.payload.reference.clipboardText === fileMention, dropped?.payload.reference.clipboardText)
const spacedMention = await mentionOf({ path: 'my file.js', pathOnly: true, directory: false })
check('a spaced path takes the quoted mention spelling', spacedMention === ' @"my file.js"', spacedMention)
const unquotableMention = await mentionOf({ path: 'we"ird.js', pathOnly: true, directory: false })
check('a path the grammar cannot quote degrades to a bare path',
  unquotableMention === 'we"ird.js', unquotableMention)
const selectionRef = { path: 'a.js', startLine: 3, endLine: 5, language: 'javascript', code: 'const needle = 1' }
check('a code selection still expands to its anchored snippet, not a mention',
  (await mentionOf(selectionRef))?.includes('```javascript'), await mentionOf(selectionRef))

// The transcript decorates the logged text itself: `projectUserText` in
// `@deepseek-ai/dsh-client-ui-primitives` scans it with this grammar and turns
// each hit into the chip. Asserting against the same grammar is what keeps a
// future spelling from silently degrading back into an undecorated run.
const USER_TEXT_TOKEN_RE = /(^|\s)(\/[\w-]+(?=\s|$)|@"[^"\n]+"|@[^\s]+)/u
const decoratedTokenOf = (text) => USER_TEXT_TOKEN_RE.exec(text)?.[2]
check('the file mention is a token the transcript decorates',
  decoratedTokenOf(`${fileMention} tail`) === '@a.js', fileMention)
check('a spaced path stays one quoted token instead of splitting at the space',
  decoratedTokenOf(`${spacedMention} tail`) === '@"my file.js"', spacedMention)
check('the mention carries its own opening whitespace, so it decorates even behind a typed word',
  decoratedTokenOf(`word${fileMention}`) === '@a.js', `word${fileMention}`)

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

console.log('\nfile-tree keyboard navigation')
// The tree is a flat `role="tree"` scroller holding `role="button"` rows. Keys
// are delivered to the container, exactly as a browser does when a focused row
// lets the event bubble, so these assertions exercise the real handler.
const treeBody = () => findAll(tree(), (node) => node.props?.className === 'code-workbench-tree-body')[0]
const rowNode = (title) => treeRowFor(title)
const selectedTitle = () => findAll(tree(), (node) => node.props?.['data-selected'] === true).map((node) => node.props.title)
/** Deliver a key to the tree container and let React flush. */
const pressTreeKey = async (key, extra = {}) => {
  let prevented = false
  await act(async () => {
    treeBody().props.onKeyDown({ key, preventDefault() { prevented = true }, ...extra })
  })
  await act(async () => {})
  return prevented
}
// A keypress on a row bubbles to the container in a browser; assert the rows
// themselves stay out of the way of movement keys so that bubbling is possible.
// The status bar is deliberately excluded: the drag suite above leaves a
// message there, and this assertion is about the *document*, not the chrome.
const editorBeforeKeys = currentModel?.getValue()
const dirtyBeforeKeys = allText().includes('未保存')
check('the tree exposes a single flat tree container', treeBody() !== undefined, Boolean(treeBody()))
const ajsKeys = rowNode('C:\\repo\\a.js').props.onKeyDown
let rowPrevented = false
ajsKeys({ key: 'ArrowDown', preventDefault() { rowPrevented = true } })
check('a row ignores movement keys so they bubble to the tree',
  rowPrevented === false, rowPrevented)
let enterPrevented = false
ajsKeys({ key: 'Enter', preventDefault() { enterPrevented = true } })
await act(async () => {})
check('a row still claims Enter for itself', enterPrevented === true)

// --- ↓ moves down, ↑ moves back, and both stop at the ends.
await act(async () => { rowNode('C:\\repo\\a.js').props.onClick() })
await act(async () => {})
check('a click still selects its row', selectedTitle().includes('C:\\repo\\a.js'), selectedTitle())
// The selection is announced, not just painted: rows are treeitems and carry
// aria-selected, so a screen reader follows the caret the same way the eye does.
check('the selected row is announced to assistive tech',
  rowNode('C:\\repo\\a.js').props['aria-selected'] === true
  && rowNode('C:\\repo\\b.js').props['aria-selected'] === false)
check('rows identify themselves as tree items at their depth',
  rowNode('C:\\repo\\a.js').props.role === 'treeitem' && rowNode('C:\\repo\\a.js').props['aria-level'] === 1)
// The selection effect focuses the selected row, so this is the row that took
// DOM focus — which is what makes the next keypress reach the tree at all.
check('the selected row is the one holding focus', lastFocusedTreeRow === 'C:\\repo\\a.js', lastFocusedTreeRow)
await pressTreeKey('ArrowDown')
check('↓ moves the selection to the next visible row', selectedTitle().includes('C:\\repo\\b.js'), selectedTitle())
check('↓ moves DOM focus onto the row it selected', lastFocusedTreeRow === 'C:\\repo\\b.js', lastFocusedTreeRow)
await pressTreeKey('ArrowUp')
check('↑ moves the selection back up', selectedTitle().includes('C:\\repo\\a.js'), selectedTitle())
const topRowTitle = rowNode('C:\\repo\\a.js').props.title
await pressTreeKey('ArrowUp')
check('↑ stops at the first row instead of wrapping', selectedTitle().includes(topRowTitle), selectedTitle())

// --- Movement must not count as typing over the open document: the buffer and
// the dirty flag are untouched, and no key was swallowed into the file.
check('tree navigation leaves the editor buffer untouched',
  currentModel.getValue() === editorBeforeKeys,
  { before: editorBeforeKeys.slice(0, 60), now: currentModel.getValue().slice(0, 60) })
check('tree navigation does not mark the open file dirty',
  allText().includes('未保存') === dirtyBeforeKeys)

// --- A collapsed folder is a boundary: its children are simply not in the
// tree, so ↓ can never skip into them. → is what opens the door.
const subRow = () => rowNode('C:\\repo\\sub')
const subChild = 'C:\\repo\\sub\\a.js'
check('the folder starts collapsed', subRow().props['aria-expanded'] === false)
check('a collapsed folder keeps its children out of the tree', rowNode(subChild) === undefined)
// a.js → b.js → sub, so ↓ from b.js selects the folder without expanding it.
await act(async () => { rowNode('C:\\repo\\b.js').props.onClick() })
await act(async () => {})
await pressTreeKey('ArrowDown')
check('↓ stops on a collapsed folder instead of entering it', selectedTitle().includes('C:\\repo\\sub'), selectedTitle())
check('landing on a collapsed folder did not expand it', rowNode('C:\\repo\\sub').props['aria-expanded'] === false)
check('↓ never skipped past the folder into its children', rowNode(subChild) === undefined)
await pressTreeKey('ArrowRight')
check('→ expands the folder the selection is on', rowNode('C:\\repo\\sub').props['aria-expanded'] === true)
check('→ reveals the first child', rowNode(subChild) !== undefined, rowNode(subChild)?.props.title)
await pressTreeKey('ArrowRight')
check('→ again steps onto the first child', selectedTitle().includes(subChild), selectedTitle())
await pressTreeKey('ArrowLeft')
check('← on a child steps up to its parent folder', selectedTitle().includes('C:\\repo\\sub') && !selectedTitle().includes(subChild), selectedTitle())
await pressTreeKey('ArrowLeft')
check('← on an expanded folder collapses it', rowNode('C:\\repo\\sub').props['aria-expanded'] === false)
// Collapsed again, so the folder is the last row and ↓ has nowhere to go.
await pressTreeKey('ArrowDown')
check('↓ at the last row stays put instead of wrapping', selectedTitle().includes('C:\\repo\\sub'), selectedTitle())

// --- F2 opens the in-tree rename field on the selected row.
const dialogTitle = () => findAll(tree(), (node) => node.props?.className === 'code-workbench-dialog-title').map(textOf)[0]
await act(async () => { rowNode('C:\\repo\\a.js').props.onClick() })
await act(async () => {})
check('no editor is open before the shortcut is used', inlineInput() === undefined)
await pressTreeKey('F2')
check('F2 opens a rename field in the tree, not a dialog',
  inlineInput() !== undefined && dialogTitle() === undefined, { input: inlineInput() !== undefined, dialog: dialogTitle() })
check('the rename field is pre-filled with the current name',
  inlineInput().props.value === 'a.js', inlineInput().props.value)
// The field replaces the row it renames, so the old name is not shown twice.
check('the renamed row is replaced by the field',
  rowNode('C:\\repo\\a.js') === undefined, Boolean(rowNode('C:\\repo\\a.js')))
// The extension is left out of the selection: renaming usually means changing
// the stem, not the type. `a.js` should select "a", not "a.js".
check('the rename field selects only the stem, not the extension',
  lastFieldSelection?.value === 'a.js' && lastFieldSelection.start === 0 && lastFieldSelection.end === 1,
  lastFieldSelection)
await act(async () => { inlineInput().props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() {} }) })
await act(async () => {})
check('Escape closes the rename field and restores the row',
  inlineInput() === undefined && rowNode('C:\\repo\\a.js') !== undefined)
check('Escape issues no rename', calls.fetch.filter((call) => call.body?.operation === 'rename' && call.body.path === 'C:\\repo\\a.js').length === 0)

// --- Delete routes to the delete confirmation, and the dialog guards it.
// Re-anchor the selection on a row with no unsaved buffer: the guard below
// deliberately refuses to delete a file that is still dirty, and `a.js` has
// been edited by earlier suites.
const deleteTarget = 'C:\\repo\\b.js'
await act(async () => { rowNode(deleteTarget).props.onClick() })
await act(async () => {})
const deleteCalls = () => calls.fetch.filter((call) => call.body?.operation === 'delete')
const deletesBefore = deleteCalls().length
/** Deletes issued from here on, so the pre-existing `b.js` delete above is not counted. */
const newDeletes = () => deleteCalls().slice(deletesBefore)
await pressTreeKey('Delete')
check('Delete opens a confirmation instead of acting immediately',
  (dialogTitle() ?? '').includes(deleteTarget), dialogTitle())
check('Delete names the selected row, not a neighbour',
  dialogTitle() === `确定删除 ${deleteTarget}？此操作无法撤销。`, dialogTitle())
check('Delete performs no file operation until it is confirmed',
  newDeletes().length === 0, newDeletes().map((call) => call.body.path))
const destructiveCallsBeforeConfirm = calls.fetch.length
await act(async () => { findAll(tree(), (node) => node.type === 'button' && textOf(node) === '取消')[0].props.onClick() })
check('cancelling the delete leaves the file alone', calls.fetch.length === destructiveCallsBeforeConfirm)
check('cancelling the delete issues no delete operation',
  newDeletes().length === 0, newDeletes().map((call) => call.body.path))

// --- Confirming is what actually commits, and the field closes on commit.
// `rename` is used for the commit step rather than `delete`: the tree fixture
// is shared with the suites that follow, and a real delete would change what
// they see. The rename targets `b.js`, which no later suite opens.
const renamesBefore = calls.fetch.filter((call) => call.body?.operation === 'rename').length
await pressTreeKey('F2')
await act(async () => { inlineInput().props.onChange({ target: { value: 'b-during-keyboard-test.js' } }) })
await act(async () => {})
check('the field shows the name being typed', inlineInput().props.value === 'b-during-keyboard-test.js', inlineInput().props.value)
await act(async () => { inlineInput().props.onKeyDown({ key: 'Enter', preventDefault() {}, stopPropagation() {} }) })
await act(async () => {})
const renameCalls = calls.fetch.filter((call) => call.body?.operation === 'rename')
check('confirming a rename issues exactly one new rename operation',
  renameCalls.length === renamesBefore + 1, renameCalls.map((call) => call.body))
check('the rename carries the name typed into the field',
  renameCalls.at(-1)?.body?.destination === 'C:\\repo\\b-during-keyboard-test.js', renameCalls.at(-1)?.body)
check('the rename is sourced from the selected row, not its neighbour',
  renameCalls.at(-1)?.body?.path === 'C:\\repo\\b.js', renameCalls.at(-1)?.body)
check('the field closes once the rename is committed', inlineInput() === undefined)
// The rename moved the open tab onto the new name; hand the editor back to
// a.js so the history suite below still has the file it expects.
await act(async () => { tabFor('a.js').props.onClick() })
await act(async () => {})
const activeTabText = textOf(findAll(tree(), (node) => node.props?.className?.includes('code-workbench-tab') && node.props.className.includes('active'))[0])
check('the open file is handed back after the rename',
  activeTabText.includes('a.js') && !activeTabText.includes('b-during'), activeTabText)

console.log('\ncreating inside a collapsed folder')
// Runs last among the tree suites: creating a file opens it, which moves the
// active editor, so nothing may depend on the buffer after this point.
const dirRow = (title) => findAll(tree(), (node) => node.props?.className === 'code-workbench-tree-row' && node.props.title === title)[0]
const clickDir = async (title) => { await act(async () => { dirRow(title).props.onClick() }); await act(async () => {}) }
if (dirRow('C:\\repo\\sub').props['aria-expanded'] === true) await clickDir('C:\\repo\\sub')
check('the target folder starts collapsed', dirRow('C:\\repo\\sub').props['aria-expanded'] === false)
await contextMenuFor('C:\\repo\\sub')
await menuAction('新建文件…')
// The field renders inside the folder's entry list, so the folder has to open
// or the user would be typing into something they cannot see.
check('creating inside a collapsed folder expands it so the field is visible',
  dirRow('C:\\repo\\sub').props['aria-expanded'] === true)
check('the field is present once the folder opens', inlineInput() !== undefined)
await act(async () => { inlineInput().props.onChange({ target: { value: 'in-sub.js' } }) })
await act(async () => { inlineInput().props.onKeyDown({ key: 'Enter', preventDefault() {}, stopPropagation() {} }) })
await act(async () => {})
check('the file lands inside the folder, not beside it',
  calls.fetch.some((call) => call.body.operation === 'createFile' && call.body.path === 'C:\\repo\\sub\\in-sub.js'))
// Creating a file opens it, so hand the editor back to the file the history
// suite below queries.
await act(async () => { tabFor('a.js').props.onClick() })
await act(async () => {})

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
check('the settings page asks the Host which credential is in play',
  calls.fetch.some((call) => call.url.includes('/completion-status')), calls.fetch.map((call) => call.url).slice(-3))
check('the settings page reports the live completion chain',
  textOf(settingsRenderer.toJSON()).includes('https://api.deepseek.com/beta/completions')
  && textOf(settingsRenderer.toJSON()).includes('DSH 凭据库'), textOf(settingsRenderer.toJSON()).slice(0, 240))
await act(async () => {
  const inputs = findAll(settingsRenderer.toJSON(), (node) => node.type === 'input')
  inputs.find((node) => node.props.placeholder === 'https://api.deepseek.com/beta').props.onChange({ target: { value: 'https://example.com/beta' } })
  inputs.find((node) => node.props.placeholder === 'deepseek-flash').props.onChange({ target: { value: 'api-model' } })
  inputs.find((node) => node.props.type === 'password').props.onChange({ target: { value: 'test-secret' } })
})
await act(async () => {
  findAll(settingsRenderer.toJSON(), (node) => node.type === 'button' && textOf(node) === '保存补全设置')[0].props.onClick()
})
check('the FIM endpoint, model and key are persisted together',
  settingsSnapshot.value.completionBaseUrl === 'https://example.com/beta'
  && settingsSnapshot.value.completionApiModel === 'api-model'
  && settingsSnapshot.value.completionApiKey === 'test-secret', settingsSnapshot.value)
check('saved API key is cleared from the input', findAll(settingsRenderer.toJSON(), (node) => node.props?.type === 'password')[0].props.value === '')
await act(async () => { settingsRenderer.unmount() })

console.log('\nshortcut rows published')
check('editor shortcuts are in the shell catalog', registered.shortcuts.length >= 3, registered.shortcuts.map((row) => row.id))

console.log('\nmulti-select')
// The settings suite above left the left pane on its own view; every block from
// here on drives tree rows, so bring the file tree back first.
await act(async () => { findAll(tree(), (n) => n.type === 'button' && n.props['aria-label'] === '文件')[0].props.onClick() })
await act(async () => {})
// The tree's primary selection lives in `selected`, with the *additional* rows in
// a separate set, so a plain click keeps meaning exactly what it always did.
const treeBodyEl = () => findAll(tree(), (node) => node.props?.className === 'code-workbench-tree-body')[0]
const rowNodeFor = (title) => findAll(tree(), (node) => node.props?.className === 'code-workbench-tree-row' && node.props.title === title)[0]
const selectedTitles = () => findAll(tree(), (node) => node.props?.className === 'code-workbench-tree-row' && node.props['aria-selected'] === true).map((node) => node.props.title)
await act(async () => { rowNodeFor('C:\\repo\\a.js').props.onClick({}) })
await act(async () => {})
await act(async () => { rowNodeFor('C:\\repo\\b.js').props.onClick({ ctrlKey: true }) })
await act(async () => {})
check('Ctrl-click adds a row to the selection',
  selectedTitles().length === 2 && selectedTitles().includes('C:\\repo\\a.js') && selectedTitles().includes('C:\\repo\\b.js'),
  selectedTitles())
check('Ctrl-click keeps the primary selection on the first row',
  rowNodeFor('C:\\repo\\a.js').props['data-selected'] === true && rowNodeFor('C:\\repo\\b.js').props['data-selected'] === false)
await act(async () => { rowNodeFor('C:\\repo\\b.js').props.onClick({ ctrlKey: true }) })
await act(async () => {})
check('Ctrl-clicking a selected row removes it again',
  selectedTitles().length === 1 && selectedTitles().includes('C:\\repo\\a.js'), selectedTitles())
// Shift-click takes the visual range between the anchor and the clicked row.
await act(async () => { rowNodeFor('C:\\repo\\a.js').props.onClick({}) })
await act(async () => { rowNodeFor('C:\\repo\\sub').props.onClick({ shiftKey: true }) })
await act(async () => {})
check('Shift-click selects the whole range between the two rows',
  selectedTitles().length === 3, selectedTitles())
await act(async () => { rowNodeFor('C:\\repo\\b.js').props.onClick({}) })
await act(async () => {})
check('a plain click collapses back to a single row',
  selectedTitles().length === 1 && selectedTitles().includes('C:\\repo\\b.js'), selectedTitles())
// A modifier-click builds a selection; it must not also open the file or toggle
// a folder, which is what a plain click does.
await act(async () => { rowNodeFor('C:\\repo\\a.js').props.onClick({}) })
await act(async () => {})
const activeBeforeModifier = textOf(findAll(tree(), (node) => node.props?.className?.includes('code-workbench-tab') && node.props.className.includes('active'))[0])
await act(async () => { rowNodeFor('C:\\repo\\sub').props.onClick({ ctrlKey: true }) })
await act(async () => {})
check('a modifier-click does not open a file or expand a folder',
  rowNodeFor('C:\\repo\\sub').props['aria-expanded'] === false
  && textOf(findAll(tree(), (node) => node.props?.className?.includes('code-workbench-tab') && node.props.className.includes('active'))[0]) === activeBeforeModifier,
  { expanded: rowNodeFor('C:\\repo\\sub').props['aria-expanded'], before: activeBeforeModifier })

// Deleting a multi-selection is one confirmation for the whole batch, and the
// dialog names what is about to go so the user can still back out.
await act(async () => { rowNodeFor('C:\\repo\\a.js').props.onClick({}) })
await act(async () => {})
await act(async () => { rowNodeFor('C:\\repo\\sub').props.onClick({ ctrlKey: true }) })
await act(async () => {})
check('the batch to delete is two rows', selectedTitles().length === 2, selectedTitles())
const deletesBeforeBatch = calls.fetch.filter((call) => call.body?.operation === 'delete').length
await act(async () => { treeBodyEl().props.onKeyDown({ key: 'Delete', preventDefault() {}, stopPropagation() {} }) })
await act(async () => {})
const batchDialog = textOf(findAll(tree(), (node) => node.props?.className === 'code-workbench-dialog-title')[0])
check('a multi-delete asks once and names how many',
  batchDialog.includes('2 个项目'), batchDialog)
check('a multi-delete issues nothing before it is confirmed',
  calls.fetch.filter((call) => call.body?.operation === 'delete').length === deletesBeforeBatch)

console.log('\nindent guides show the selection ancestry')
const railsOn = (title) => findAll(rowNodeFor(title), (node) => node.props?.className === 'code-workbench-tree-rail' && node.props['data-on'] === 'true').length
const railsTotal = (title) => findAll(rowNodeFor(title), (node) => node.props?.className === 'code-workbench-tree-rail').length
// A root-level row has no rails at all: there is no ancestry to draw.
check('a root row has no indent rails', railsTotal('C:\\repo\\a.js') === 0, railsTotal('C:\\repo\\a.js'))
// Open the folder so a depth-1 row exists to inspect.
if (rowNodeFor('C:\\repo\\sub').props['aria-expanded'] !== true) {
  await act(async () => { rowNodeFor('C:\\repo\\sub').props.onClick({}) })
  await act(async () => {})
}
check('the child row exists once its folder is open', rowNodeFor('C:\\repo\\sub\\a.js') !== undefined)
await act(async () => { treeBodyEl().props.onMouseEnter() })
await act(async () => {})
check('while the pointer is over the list a child row lights all its rails',
  railsOn('C:\\repo\\sub\\a.js') === railsTotal('C:\\repo\\sub\\a.js') && railsTotal('C:\\repo\\sub\\a.js') === 1,
  { on: railsOn('C:\\repo\\sub\\a.js'), total: railsTotal('C:\\repo\\sub\\a.js') })
// Leaving the list keeps only the primary selection's ancestry lit.
// Select the child directly: clicking the folder row would collapse it and take
// the very row under test off screen.
await act(async () => { rowNodeFor('C:\\repo\\sub\\a.js').props.onClick({}) })
await act(async () => {})
check('the child row survives the selection', rowNodeFor('C:\\repo\\sub\\a.js') !== undefined)
await act(async () => { treeBodyEl().props.onMouseLeave() })
await act(async () => {})
check('a child of the selection keeps its ancestor rail lit after the pointer leaves',
  railsOn('C:\\repo\\sub\\a.js') === 1, { on: railsOn('C:\\repo\\sub\\a.js'), total: railsTotal('C:\\repo\\sub\\a.js') })
check('an unrelated sibling loses its rails once the pointer leaves',
  railsOn('C:\\repo\\sub\\b.js') === 0, { on: railsOn('C:\\repo\\sub\\b.js'), total: railsTotal('C:\\repo\\sub\\b.js') })
// Put the pointer back inside for the drag block, which expects the full tree.
await act(async () => { treeBodyEl().props.onMouseEnter() })
await act(async () => {})

console.log('\ndrag a tree row onto a folder to move it')
const moveTransfer = (entries = []) => makeDataTransfer(entries)
await act(async () => { rowNodeFor('C:\\repo\\a.js').props.onClick({}) })
await act(async () => {})
const moveDrag = moveTransfer()
await act(async () => { rowNodeFor('C:\\repo\\a.js').props.onDragStart({ dataTransfer: moveDrag }) })
check('starting a drag on a selected row records the move',
  moveDrag.effectAllowed === 'copyMove', moveDrag.effectAllowed)
// A folder accepts the drop and issues a rename into itself.
const overEvent = () => ({ dataTransfer: { dropEffect: 'unset' }, __prevented: false, preventDefault() { this.__prevented = true }, stopPropagation() {} })
const over = overEvent()
await act(async () => { rowNodeFor('C:\\repo\\sub').props.onDragOver(over) })
check('a folder accepts a hovered drop', over.__prevented === true)
const movesBefore = calls.fetch.filter((call) => call.body?.operation === 'rename').length
const drop = overEvent()
await act(async () => { rowNodeFor('C:\\repo\\sub').props.onDrop(drop) })
await act(async () => {})
const moveCalls = calls.fetch.filter((call) => call.body?.operation === 'rename').slice(movesBefore)
check('dropping onto a folder moves the file into it',
  moveCalls.length === 1 && moveCalls[0].body.path === 'C:\\repo\\a.js' && moveCalls[0].body.destination === 'C:\\repo\\sub\\a.js',
  moveCalls.map((call) => call.body))
// The move rewrites the open tabs to their new homes, and `sub/a.js` was opened
// further up — so the incoming `a.js` lands on a path that already has a tab.
// A plain rewrite appended a second tab on the same path, which React reports
// only as a duplicate-key warning buried in the console, and which the user
// sees as two identical tabs where closing one does not close the other. Read
// the real paths off the tab spans (the close button's title is a basename, so
// the separator is what tells the two apart) and require exactly one each.
const tabPaths = () => findAll(tree(), (node) => node.props?.className?.split(' ').includes('code-workbench-tab'))
  .flatMap((tab) => findAll(tab, (node) => typeof node.props?.title === 'string' && /[\\/]/.test(node.props.title)).map((node) => node.props.title))
const movedTabPaths = tabPaths()
check('a move leaves one tab per path', new Set(movedTabPaths).size === movedTabPaths.length, movedTabPaths)
check('the moved file is open at its new path',
  movedTabPaths.filter((path_) => path_ === 'C:\\repo\\sub\\a.js').length === 1, movedTabPaths)
// A file is not a drop target: it has no children to move into. The drop lands
// on a FILE row here, so nothing should be issued.
const fileDrag = moveTransfer()
await act(async () => { rowNodeFor('C:\\repo\\b.js').props.onDragStart({ dataTransfer: fileDrag }) })
const beforeFileDrop = calls.fetch.filter((call) => call.body?.operation === 'rename').length
const fileDropEvent2 = overEvent()
await act(async () => { rowNodeFor('C:\\repo\\a.js').props.onDrop(fileDropEvent2) })
await act(async () => {})
check('dropping a file onto another file does nothing',
  calls.fetch.filter((call) => call.body?.operation === 'rename').length === beforeFileDrop
  && fileDropEvent2.__prevented === false,
  { prevented: fileDropEvent2.__prevented })
// A folder cannot be dropped into itself or into its own descendants.
const selfDrag = moveTransfer()
await act(async () => { rowNodeFor('C:\\repo\\sub').props.onDragStart({ dataTransfer: selfDrag }) })
const beforeSelf = calls.fetch.filter((call) => call.body?.operation === 'rename').length
const selfDrop = overEvent()
await act(async () => { rowNodeFor('C:\\repo\\sub').props.onDrop(selfDrop) })
await act(async () => {})
check('a folder refuses to drop into itself',
  calls.fetch.filter((call) => call.body?.operation === 'rename').length === beforeSelf)

console.log('\nrefreshing keeps the tree open and the user in place')
// Collapse everything, then reopen a folder, then refresh: the open folder must
// stay open. A refresh that collapsed the tree would make the button unusable.
await act(async () => { findAll(tree(), (node) => node.type === 'button' && node.props['aria-label'] === '全部折叠')[0].props.onClick() })
await act(async () => {})
check('collapse-all closes every folder', rowNodeFor('C:\\repo\\sub').props['aria-expanded'] === false)
await act(async () => { rowNodeFor('C:\\repo\\sub').props.onClick({}) })
await act(async () => {})
check('the folder is open again before the refresh', rowNodeFor('C:\\repo\\sub').props['aria-expanded'] === true)
await act(async () => { findAll(tree(), (node) => node.type === 'button' && node.props['aria-label'] === '刷新文件树')[0].props.onClick() })
await act(async () => {})
check('refreshing keeps the folder open instead of collapsing it',
  rowNodeFor('C:\\repo\\sub').props['aria-expanded'] === true)

console.log('\nthe version poll yields to the change stream')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
// No block above has pushed a `ready` frame, so through the whole suite so far
// the fallback was the only signal there was — which is exactly what the earlier
// "version check fallback" block depends on. It must still be asking every tick.
const beforeReady = calls.stat
await act(async () => { await sleep(1700) })
check('with no ready frame the poll asks on every tick', calls.stat > beforeReady, { before: beforeReady, after: calls.stat })
// Now the stream says it is delivering. The fallback keeps its timer but stops
// spending requests on it.
await act(async () => { pushWatch({ kind: 'ready' }) })
await act(async () => {})
const afterReady = calls.stat
await act(async () => { await sleep(1700) })
check('a ready stream throttles the poll to a net', calls.stat === afterReady, { ready: afterReady, later: calls.stat })
// And when the stream dies the next tick is a real request again. This is what
// throttling the request rather than the timer buys: no long interval to wait out,
// so a dropped connection cannot leave the editor showing a stale file.
await act(async () => { endWatch() })
await act(async () => {})
await act(async () => { await sleep(1700) })
check('a stream that ends puts the poll back on every tick', calls.stat > afterReady, { ready: afterReady, later: calls.stat })

console.log('\nthe caret window the client ships')
// This belongs with the completion block above, but driving it needs a buffer
// large enough to hit the caps, and re-setting the model marks it dirty — which
// the external-change block depends on not having happened. So it runs here,
// where nothing is left to disturb. The Host half pins the same two numbers from
// the other side, by trimming an over-long prefix down to the shared window.
globalThis.fetch = async (url, options) => {
  calls.fetch.push({ url, body: JSON.parse(options.body) })
  return new Response(JSON.stringify({ ok: true, text: '' }), { headers: { 'content-type': 'application/json' } })
}
// Position-encoded on purpose: a run of one repeated character makes the text at
// the caret identical to the text elsewhere in the buffer, so an assertion that
// compares content would pass no matter which end the slice kept.
const caretBuffer = Array.from({ length: 5000 }, (_, index) => String.fromCharCode(97 + (index % 26))).join('')
await act(async () => { currentModel.setValue(caretBuffer) })
// Park the caret 4000 characters in, so both slices are cut by the caps: 4000 is
// more than the prefix window and 1000 characters are left after it, more than
// the suffix window. A shorter buffer would only prove the slice works.
fakeOffset = 4000
await act(async () => {
  await calls.inlineCompletionProvider.provideInlineCompletions(currentModel, { lineNumber: 1, column: 1 }, {}, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) })
})
const shipped = calls.fetch.at(-1)?.body
// Compared against the exact expected slice, not its length: a length check
// cannot tell the text at the caret from the text 4000 characters above it.
check('the context before the caret is shipped exactly, anchored at the caret',
  shipped?.prefix === caretBuffer.slice(fakeOffset - COMPLETION_PREFIX_CHARS, fakeOffset),
  { sent: shipped?.prefix?.length, window: COMPLETION_PREFIX_CHARS })
check('the context after the caret is shipped exactly, anchored at the caret',
  shipped?.suffix === caretBuffer.slice(fakeOffset, fakeOffset + COMPLETION_SUFFIX_CHARS),
  { sent: shipped?.suffix?.length, window: COMPLETION_SUFFIX_CHARS })

console.log('\na file that is not text is handed to the official document preview')
// Mounted fresh, and last on purpose. Fresh, because the blocks above leave a dirty
// buffer behind and `openFile` autosaves it on the way in: that save's "已保存 …"
// status resolves after the handoff's, so the status line below would race the save
// instead of the handoff. Last, because this block re-points the directory listing,
// and the selection and batch assertions above count rows in the shared one.
files.list = async (sessionId, dir) => {
  calls.list.push(dir)
  return { ok: true, value: { entries: [{ name: 'a.js', type: 'file' }, { name: 'book.xlsx', type: 'file' }], truncated: false } }
}
await act(async () => { renderer.unmount() })
await act(async () => { renderer = create(h(CodePanel, props), { createNodeMock: createMockNode }) })
await act(async () => {})
const panelTabTitles = () => findAll(tree(), (node) => typeof node.props?.className === 'string'
  && node.props.className.split(' ')[0] === 'code-workbench-tab').map((node) => textOf(node))
const spreadsheetRow = findAll(tree(), (node) => node.type === 'div' && node.props.title === 'C:\\repo\\book.xlsx')[0]
check('the tree lists the spreadsheet', spreadsheetRow !== undefined)
const tabsBefore = panelTabTitles().length
const modelsBefore = calls.models.length
check('a fresh panel has nothing open', tabsBefore === 0, panelTabTitles())

await act(async () => { spreadsheetRow?.props?.onClick?.() })
await act(async () => {})

check('the panel opened the official preview for it, exactly once',
  calls.previewOpens.length === 1, calls.previewOpens)
// Pinned as a literal: the address grammar belongs to the official builder, and a
// test that rebuilt the expectation with the same package could not notice it
// changing shape under the panel.
check('the address is the shared session file address the official preview claims',
  calls.previewOpens[0] === 'dsh-resource://file/session/s1/book.xlsx', calls.previewOpens)
check('no Monaco model was built for a file the panel cannot render',
  calls.models.length === modelsBefore, { before: modelsBefore, after: calls.models.length })
check('the plugin kept its own tab strip clean',
  panelTabTitles().length === tabsBefore, panelTabTitles())
check('the status says where the file went',
  allText().includes('已在右栏「文档预览」中打开'), { tail: allText().slice(-160) })

console.log('\nthe handoff degrades when nothing claims the file')
// A build without the preview package: `openResource` throws because no registered
// type claims the address. The panel must keep its own error rather than report a
// file it never managed to show.
await act(async () => { renderer.unmount() })
await act(async () => {
  renderer = create(h(CodePanel, {
    ...props,
    sidebarRight: { openResource() { throw new Error('sidebarRight: no type claims the address') } },
  }), { createNodeMock: createMockNode })
})
await act(async () => {})
const lonelyRow = findAll(tree(), (node) => node.type === 'div' && node.props.title === 'C:\\repo\\book.xlsx')[0]
await act(async () => { lonelyRow?.props?.onClick?.() })
await act(async () => {})
check('the panel did not claim to have opened anything',
  !allText().includes('已在右栏「文档预览」中打开'), allText().slice(0, 140))
check('and it names the panel that can show the file',
  allText().includes('读取失败') && allText().includes('此类文件需在右栏「文档预览」中打开'), allText().slice(0, 200))

console.log('\na published update is offered, and taking it is one click')
// The panel is opened constantly and a release is rare, so the whole point of
// this pair is that it costs one read per mount and nothing at all when there is
// nothing to say. Every case mounts fresh, because the check is a mount effect.
const baseFetch = globalThis.fetch
const updateCalls = { check: [], apply: [] }
const answers = { check: { ok: true, hasUpdate: false }, apply: { ok: true, applied: true, version: '0.4.5', needsRestart: false } }
globalThis.fetch = async (url, options) => {
  const text = String(url)
  if (!text.includes('/update-check') && !text.includes('/update-apply')) return baseFetch(url, options)
  const kind = text.includes('/update-check') ? 'check' : 'apply'
  calls.fetch.push({ url: text, body: JSON.parse(options.body) })
  updateCalls[kind].push({ url: text, body: JSON.parse(options.body), signal: options.signal })
  if (answers[`${kind}Throws`] === true) throw new TypeError('fetch failed')
  return { ok: true, status: 200, json: async () => answers[kind] }
}
const unmount = async () => { await act(async () => { renderer.unmount() }) }
const mount = async () => {
  await act(async () => { renderer = create(h(CodePanel, props), { createNodeMock: createMockNode }) })
  await act(async () => {})
}
const remount = async () => { await unmount(); await mount() }
const bannerButton = (label) => findAll(tree(), (node) => node.type === 'button' && textOf(node) === label)[0]

await remount()
check('a panel with nothing to update says nothing about updating',
  !allText().includes('有新版本') && !allText().includes('升级'), allText().slice(0, 120))
check('and it asked the host exactly once', updateCalls.check.length === 1, updateCalls.check.length)
check('asking carries the request body the host ignores', JSON.stringify(updateCalls.check[0]?.body) === '{}', updateCalls.check[0]?.body)
const firstCheck = updateCalls.check[0]?.signal
await unmount()
check('a panel that closed takes its question with it', firstCheck?.aborted === true)

// Case: a client-only release — the kind the shipped module registry reloads by
// itself, so the banner must not ask anyone to restart anything.
answers.check = { ok: true, current: '0.4.4', latest: '0.4.5', hasUpdate: true, changed: ['client.js'], needsRestart: false }
await mount()
check('the banner names the version that is published',
  allText().includes('有新版本 0.4.5'), allText().slice(0, 160))
check('and a client-only release does not ask for a restart',
  !allText().includes('需要重启'), allText().slice(0, 160))
const upgrade = bannerButton('升级')
check('with a button that takes it', upgrade !== undefined, allText().slice(0, 160))
await act(async () => { upgrade?.props.onClick() })
await act(async () => {})
check('one click posts one apply, and the body names no files',
  updateCalls.apply.length === 1 && JSON.stringify(updateCalls.apply[0]?.body) === '{}', updateCalls.apply)
check('the panel reports the version that landed and that it is reloading',
  allText().includes('已更新到 0.4.5，正在重新加载'), allText().slice(0, 200))
check('and the offer is gone', !allText().includes('有新版本'), allText().slice(0, 200))

// Case: a release that also replaced something the running Host already loaded.
answers.check = { ok: true, current: '0.4.4', latest: '0.4.5', hasUpdate: true, changed: ['index.js'], needsRestart: true }
answers.apply = { ok: true, applied: true, version: '0.4.5', changed: ['index.js'], needsRestart: true }
await remount()
check('a host-half release says a restart is coming',
  allText().includes('有新版本 0.4.5（需要重启 DSH）'), allText().slice(0, 160))
await act(async () => { bannerButton('升级')?.props.onClick() })
await act(async () => {})
check('and the panel does not pretend it is already in effect',
  allText().includes('已更新到 0.4.5，重启 DSH 后生效'), allText().slice(0, 240))

// Case: the host refuses the release, and says why.
answers.apply = { ok: false, error: { code: 'UPDATE_DIGEST', message: 'client.js 的摘要与清单不符' } }
await remount()
await act(async () => { bannerButton('升级')?.props.onClick() })
await act(async () => {})
check('a refusal is shown with the reason the host gave',
  allText().includes('client.js 的摘要与清单不符'), allText().slice(0, 260))
check('and the offer is still there to retry', allText().includes('有新版本 0.4.5'), allText().slice(0, 200))

// Case: no network at all. The button must come back rather than stick on
// "更新中…" and leave the panel unable to try again.
answers.applyThrows = true
await remount()
await act(async () => { bannerButton('升级')?.props.onClick() })
await act(async () => {})
check('an unreachable host is reported as a network failure',
  allText().includes('更新失败，请检查网络后重试'), allText().slice(0, 260))
check('and the button is usable again', bannerButton('升级') !== undefined)
delete answers.applyThrows

// Case: the check itself fails. Silence is the entire fallback — nobody opened
// the panel to hear about GitHub.
answers.checkThrows = true
await remount()
check('a check that cannot run shows no banner and breaks nothing',
  !allText().includes('有新版本') && !allText().includes('更新'), allText().slice(0, 120))
delete answers.checkThrows
answers.check = { ok: false, error: { code: 'UPDATE_UNAVAILABLE' } }
await remount()
check('and a check the host cannot answer is equally quiet',
  !allText().includes('有新版本'), allText().slice(0, 120))

globalThis.fetch = baseFetch

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
await act(async () => { renderer.unmount() })
process.exit(failures === 0 ? 0 : 1)
