/**
 * Client-half plugin-contract test.
 *
 * Loads the real bundle, runs its `apply` against a recording context, and asserts
 * the contracts the sidebar-right guide, the slot system, and the module runtime
 * actually enforce.
 *
 * The guide contract is the important one: `GuideBody` calls `entry.title()` and
 * `entry.description?.()`, so a guide entry carrying plain strings throws inside
 * the guide's render and the renderer's error boundary blanks the whole page with
 * no visible diagnostic. That regression is invisible in a diff and cost real
 * debugging time, so it is pinned here.
 *
 * v2 adds two bundle-level pins: the injected Monaco stylesheet must reach
 * `document.head`, and the whole thing must evaluate in a DOM-less harness (the
 * module body is lazy — Monaco must not initialize until the panel mounts).
 *
 *   node tools/test-client-contract.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

let factory
// Captured while the bundle's module body runs, so the asset assertions can read
// the real stylesheet instead of scanning source text for it.
let capturedCss = ''
globalThis.window = {
  __ModuleLoader__: {
    load(registration) { factory = registration.factory },
  },
}
// Deliberately minimal DOM: no `getElementById`, no layout. The bundle's asset
// prelude must tolerate this, and Monaco must not touch the DOM at factory time.
globalThis.document = {
  head: {
    appendChild(node) {
      if (typeof node?.textContent === 'string') capturedCss = node.textContent
    },
  },
  createElement: () => ({ dataset: {}, style: {}, remove() {} }),
}

const source = fs.readFileSync(new URL('../dsh-code-workbench/client.js', import.meta.url), 'utf8')
// eslint-disable-next-line no-new-func
new Function(source)()
if (typeof factory !== 'function') throw new Error('client.js did not register a factory')

class StubComponent {}

/** Minimal React surface the bundle's module body touches. */
const reactStub = {
  createElement: () => undefined,
  Component: StubComponent,
  useCallback: (fn) => fn,
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: () => ({ current: null }),
  useState: (initial) => [initial, () => {}],
}

const module = factory((specifier) => {
  if (specifier === 'react') return reactStub
  throw new Error(`unexpected external require("${specifier}")`)
})

let failures = 0
/** Assert one expectation. */
function check(label, condition, detail) {
  if (condition) console.log(`  ok   ${label}`)
  else {
    failures++
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  }
}

console.log('bundle assets')
check('factory evaluated with a DOM-less stub (Monaco stays lazy)', typeof module === 'object' && module !== null)
check('the monaco stylesheet was injected into document.head',
  capturedCss.includes('.monaco-editor'), capturedCss.length)
check('the bundle wires a Blob-based monaco worker environment',
  source.includes('MonacoEnvironment') && source.includes('createObjectURL'))
check('monaco is bundled inline, not require()d from the module table',
  !source.includes('require("monaco') && !source.includes("require('monaco"))

const existingStyle = { textContent: 'previous revision' }
globalThis.document.getElementById = () => existingStyle
factory((specifier) => {
  if (specifier === 'react') return reactStub
  throw new Error(`unexpected external require("${specifier}")`)
})
check('hot reload updates the existing stylesheet including tree hover rules',
  existingStyle.textContent.includes('.code-workbench-tree-row:hover')
  && existingStyle.textContent !== 'previous revision')
delete globalThis.document.getElementById

console.log('\nmodule face')
check('exports apply', typeof module.apply === 'function')
check('exports inject as a service-name array', Array.isArray(module.inject), module.inject)
check('every inject entry is a bare service name',
  module.inject.every((name) => typeof name === 'string' && !name.includes('/') && !name.startsWith('@')),
  module.inject)
// The gateway registers each Remote namespace under the service key
// `remote.<namespace>` (`remoteServiceKey`), and there is NO bare `remote` service.
// Declaring the right keys is not enough: the body must also destructure each injected
// key verbatim. Reading `remote.workspaceFiles` off a bare `remote` prop is exactly the
// defect that reached the page once ("Cannot read properties of undefined").
check('injects the official workspaceFiles and session Remote namespaces',
  module.inject.includes('remote.workspaceFiles') && module.inject.includes('remote.session'),
  module.inject)
check('declares no private namespace of its own',
  !module.inject.some((name) => /code-workbench/i.test(name)), module.inject)
check('declares no bare "remote" service',
  !module.inject.includes('remote'), module.inject)

const registeredTabs = []
const registeredSlots = []
const registeredShortcuts = []
const registeredInjects = []
const registeredSources = []
const effects = []
// The right-sidebar navigation controller. The panel reaches the official
// document preview through it, so the inject face has to carry the real object.
const sidebarRightController = { openResource() {} }

const ctx = {
  effect(callback, label) {
    effects.push(label)
    return callback()
  },
  inject(names, callback) {
    registeredInjects.push(names)
    callback({
      effect: (inner, label) => {
        effects.push(label)
        return inner()
      },
      inputTriggers: {
        registerSource(source) {
          registeredSources.push(source)
          return () => {}
        },
      },
    })
  },
  slots: {
    inject(key, callback) {
      callback()
    },
    register(options, component) {
      registeredSlots.push({ options, component })
      return () => {}
    },
  },
  sidebarRightTabs: {
    register(definition) {
      registeredTabs.push(definition)
      return () => {}
    },
  },
  sidebarRight: sidebarRightController,
  shortcuts: {
    registerFixed(command) {
      registeredShortcuts.push(command)
      return () => {}
    },
  },
}

console.log('\napply')
check('apply runs without throwing', (() => {
  try {
    module.apply(ctx)
    return true
  } catch (error) {
    console.log(`       threw: ${error.message}`)
    return false
  }
})())
check('registered exactly one tab type', registeredTabs.length === 1, registeredTabs.length)
check('every effect carried a label', effects.every((label) => typeof label === 'string' && label.length > 0), effects)

console.log('\nshortcut rows (the shell shortcut settings)')
check('published fixed shortcut rows', registeredShortcuts.length >= 3, registeredShortcuts.length)
check('shortcut ids are unique', new Set(registeredShortcuts.map((row) => row.id)).size === registeredShortcuts.length)
check('every fixed row has a callable label returning a string',
  registeredShortcuts.every((row) => typeof row.label === 'function' && typeof row.label() === 'string'))
check('bindings are physical codes with modifier arrays',
  registeredShortcuts.every((row) => Array.isArray(row.bindings) && row.bindings.every(
    (binding) => typeof binding.code === 'string' && Array.isArray(binding.modifiers))))
check('rows are grouped under code-workbench',
  registeredShortcuts.every((row) => row.group === 'code-workbench'), registeredShortcuts.map((row) => row.group))
check('save and Tab completion are among the rows',
  registeredShortcuts.some((row) => row.id === 'code-workbench.save')
  && registeredShortcuts.some((row) => row.id === 'code-workbench.tabCompletion'),
  registeredShortcuts.map((row) => row.id))

console.log('\nchat-chip reference codec')
const codec = registeredSources.find((source) => source.name === 'code-workbench')?.codec
check('registers the code-workbench reference source', codec !== undefined, registeredSources.map((s) => s.name))
check('the codec serializes to a promise of text', typeof codec?.serialize === 'function')
const codecText = typeof codec?.serialize === 'function'
  ? await codec.serialize({ path: 'a.js', startLine: 3, endLine: 5, language: 'javascript', code: 'x\ny' })
  : ''
check('a chip expands to the anchored fenced code',
  typeof codecText === 'string' && codecText.includes('a.js:3-5') && codecText.includes('```javascript') && codecText.includes('x\ny'),
  codecText)

const definition = registeredTabs[0]
console.log('\ntab definition')
check('has a string id', typeof definition?.id === 'string' && definition.id.length > 0, definition?.id)
check('has a string kind', typeof definition?.kind === 'string' && definition.kind.length > 0, definition?.kind)
check('title is callable and returns a string', (() => {
  try {
    return typeof definition.title() === 'string'
  } catch {
    return false
  }
})(), typeof definition?.title)

console.log('\nguide entries (the guide calls these)')
const guide = definition?.guide ?? []
check('contributes at least one guide entry', guide.length > 0, guide.length)
for (const [index, entry] of guide.entries()) {
  const where = `entry[${index}]`
  check(`${where} has a string id`, typeof entry.id === 'string' && entry.id.length > 0, entry.id)
  check(`${where} has a numeric order`, Number.isFinite(entry.order), entry.order)
  check(`${where} title is a FUNCTION returning a string`,
    typeof entry.title === 'function' && typeof entry.title() === 'string',
    typeof entry.title)
  if (entry.description !== undefined) {
    check(`${where} description is a FUNCTION returning a string`,
      typeof entry.description === 'function' && typeof entry.description() === 'string',
      typeof entry.description)
  }
  check(`${where} does not re-declare kind`, entry.kind === undefined, entry.kind)
}

console.log('\nslot registrations')
check('registered a tab body', registeredSlots.length >= 1, registeredSlots.length)
const body = registeredSlots.find((row) => row.options?.name === 'sidebar.right.pane.tab')
check('body targets sidebar.right.pane.tab', body !== undefined)
check('body key equals the tab id', body?.options?.key === definition?.id,
  { key: body?.options?.key, id: definition?.id })
check('body component is a function', typeof body?.component === 'function')

// The renderer's `runInject` does `return bindInjectSources(inject(...args))`, so a
// non-function `inject` throws "inject is not a function" at render time and the
// slot's error boundary blanks the tab. This is the exact defect that reached the
// page once; the shape is pinned here.
console.log('\ninject contract (renderer runInject)')
check('body inject is a FUNCTION', typeof body?.options?.inject === 'function', typeof body?.options?.inject)
const face = typeof body?.options?.inject === 'function' ? body.options.inject('session-1', {}) : undefined
check('inject returns a face object', face !== null && typeof face === 'object', face)
// This is the whole prop-delivery contract: `runInject` uses the returned face as the
// body's props, while the `const inject` declaration array only decides *when* the
// plugin activates. A face that omits an injected namespace leaves the body reading
// `undefined` — the defect that reached the page twice, so it is pinned here.
for (const key of module.inject.filter((name) => name.includes('.'))) {
  check(`the inject face hands over "${key}"`,
    face !== undefined && Object.hasOwn(face, key), Object.keys(face ?? {}))
}
check('declares no extra hooks (the panel uses the standard kit)',
  face?.hooks === undefined, face?.hooks)
// Same class of defect as the dotted keys above, but this service carries no dot:
// the body's only route to the official document preview is this object, and a
// face that dropped it would leave a non-text file failing with a bare code.
check('the inject face hands over the right-sidebar navigation controller',
  face?.sidebarRight === sidebarRightController, Object.keys(face ?? {}))

console.log('\nstandard-kit contract')
// Source-level facts about the component. Prose is stripped, because the component's own
// JSDoc names the same namespaces the assertions below scan for.
const bodySource = typeof body?.component === 'function' ? body.component.toString() : ''
const bodyCode = bodySource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1')

check('the body takes a single props object',
  typeof body?.component === 'function' && body.component.length === 1, body?.component?.length)

// The Host's `inspect` rejects an empty path (`gateway/bad-request` "path is required"),
// and read/list/stat all go through it — so no call may pass `''`. The workspace root is
// named by the Session cwd. This reached the page once as a bare "path is required".
check('never calls a Remote with an empty path',
  !/\b(files|remote)\s*\.\s*(list|read|stat)\s*\(\s*[^,)]+,\s*''/.test(bodySource)
  && !bodySource.includes("browse('')"), 'empty-path call found')
check('the body resolves the workspace root through useSessions and passes cwd down',
  /useSessions/.test(bodySource) && /cwd/.test(bodySource), 'cwd wiring missing')

// Every injected namespace must be destructured VERBATIM from props. `remoteServiceKey`
// names them `remote.<namespace>`, and no bare `remote` exists to read them off — the
// defect this assertion exists for.
for (const key of module.inject.filter((name) => name.includes('.'))) {
  check(`body destructures its injected key "${key}" from props`,
    bodySource.includes(`'${key}'`) || bodySource.includes(`"${key}"`),
    bodySource.slice(0, 120))
}
/**
 * Report whether the code reads a property off a bare `remote` binding.
 *
 * A quick scanner rather than a regex, because the legitimate destructuring spells the
 * key quoted (`'remote.workspaceFiles': files`) and a regex cannot tell that string from
 * a `remote.workspaceFiles` property access. Skipping string literals separates them.
 * @param code - the body source with comments already stripped.
 * @returns the offending snippet, or undefined when the code is clean.
 */
function findBareRemoteRead(code) {
  for (let i = 0; i < code.length; i++) {
    const c = code[i]
    if (c === "'" || c === '"' || c === '`') {
      const quote = c
      i++
      while (i < code.length && code[i] !== quote) {
        if (code[i] === '\\') i++
        i++
      }
      continue
    }
    if (c !== 'r' || !/^remote\b/.test(code.slice(i, i + 7))) continue
    const before = code[i - 1]
    if (before !== undefined && /[\w$.]/.test(before)) continue
    const rest = code.slice(i + 6)
    const after = rest.match(/^\s*([.[\w])/)
    if (after === null) continue
    // `remote["ns"]` is unambiguously a read: destructuring spells its key quoted
    // (`{ 'remote.session': session }`), so bracket access never appears there.
    if (after[1] === '[') return rest.slice(0, 60)
    // `remote.ns` is ambiguous — a bare read, or the tail of a quoted destructuring
    // key. Only the unquoted form is a defect.
    if (after[1] === '.') {
      if (/^\s*[.]\s*['"]/.test(rest)) continue
      return rest.slice(0, 60)
    }
  }
  return undefined
}

const bareRemote = findBareRemoteRead(bodyCode)
check('body never reads namespaces off a bare `remote` prop', bareRemote === undefined, bareRemote)

// Self-test the scanner: it must flag the defect that reached the page and must NOT
// flag the legitimate quoted-key destructuring it now ships with.
check('scanner flags a bare `remote.workspaceFiles` read',
  findBareRemoteRead('const x = remote.workspaceFiles.list(a, b)') !== undefined)
check('scanner flags a bare `remote["session"]` read',
  findBareRemoteRead('const y = remote["session"].prompt(r)') !== undefined)
check('scanner ignores quoted-key destructuring',
  findBareRemoteRead("function B({ 'remote.workspaceFiles': files }) { return files }") === undefined)
check('scanner ignores the namespace named inside a string',
  findBareRemoteRead("const label = 'remote.workspaceFiles'") === undefined)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
