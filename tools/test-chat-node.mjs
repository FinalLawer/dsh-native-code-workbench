/**
 * Chat-node take-over test — the seat this plugin shadows, and the renderer it
 * has to find inside it.
 *
 * The plugin replaces the shipped `user` / `steering` renderer so a code
 * reference can collapse into a card. Replacing a *keyed* seat means the
 * shipped renderer is no longer drawn by the shell, so the plugin has to draw
 * it itself — and that is where it shipped a bug: the renderer was looked up
 * once, inside `slots.inject`'s callback, which the contract in
 * `types/dsh-client.d.ts` says runs *inside the declaring `register()` call*.
 * Whoever reaches the seat first therefore reads an empty entry list, and when
 * this plugin was first every user message came back as a bare block of text,
 * left-aligned, with no bubble — "my message jumped to the left", only some of
 * the time, because load order decided it.
 *
 * This pins the two halves of the fix:
 *
 *  - the shipped renderer is resolved per render, so an entry committed *after*
 *    this plugin still gets drawn (the transcript heals without a reload);
 *  - with no shipped renderer at all, a message still draws as a bubble hugging
 *    the edge the platform puts it on, instead of a stray block of text.
 *
 *   node tools/test-chat-node.mjs
 */
import fs from 'node:fs'
import { createRequire } from 'node:module'

const requireFrom = createRequire(new URL('../dsh-code-workbench/package.json', import.meta.url))
const React = requireFrom('react')
const { act, create } = requireFrom('react-test-renderer')
const h = React.createElement

let failures = 0
globalThis.IS_REACT_ACT_ENVIRONMENT = true
/** Assert one expectation. */
function check(label, condition, detail) {
  if (condition) console.log(`  ok   ${label}`)
  else {
    failures++
    console.log(`  FAIL ${label}${details(detail)}`)
  }
}
/** Render a detail payload compactly, including when it is a whole tree. */
function details(value) {
  if (value === undefined) return ''
  try {
    return ` — ${JSON.stringify(value)}`
  } catch {
    return ' — <unserialisable>'
  }
}

// ---------------------------------------------------------------------------
// Environment: only what the bundle prelude touches (the CSS injection), plus
// the loader the classic script registers itself with.
// ---------------------------------------------------------------------------
globalThis.document = {
  head: { appendChild() {} },
  createElement: () => ({ id: '', textContent: '' }),
  getElementById: () => null,
  body: { hasAttribute: () => false, appendChild() {} },
  addEventListener() {},
  removeEventListener() {},
}
globalThis.window = {
  __ModuleLoader__: {
    load(registration) {
      globalThis.__factory = registration.factory
    },
  },
}

const source = fs.readFileSync(new URL('../dsh-code-workbench/client.js', import.meta.url), 'utf8')
// eslint-disable-next-line no-new-func
new Function(source)()

/** The baseline module table the factory may `require`; only `react` matters here. */
const primitives = {
  FileTypeIcon: () => null,
  IconFolderCloseRegular: () => null,
  IconFolderOpenRegular: () => null,
  classifyFileType: () => 'file',
}
const module = globalThis.__factory((id) => {
  if (id === 'react') return React
  if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives
  throw new Error(`unexpected require: ${id}`)
})

// ---------------------------------------------------------------------------
// The seat: a registry whose entry list can grow *after* the plugin registered.
//
// `entries()` hands back the live array rather than a copy — that is what the
// real registry does between mutations (the `SlotCore.entries` snapshot is a
// cached reference), and it is what makes "registered later, still found" a
// property of the plugin rather than of the harness.
// ---------------------------------------------------------------------------
const entries = []
const registered = []
const ctx = {
  effect: (callback) => callback(),
  inject: (names, callback) => callback({
    effect: (inner) => inner(),
    inputTriggers: { registerSource: () => () => {} },
  }),
  slots: {
    inject: (key, callback) => callback(),
    register: (options, component) => {
      registered.push({ options, component })
      return () => {}
    },
    entries: (key) => (key === 'conversation.chat.node' ? entries : []),
  },
  sidebarRightTabs: { register: () => () => {} },
  shortcuts: { registerFixed: () => () => {} },
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

const occupants = registered.filter((row) => row.options.name === 'conversation.chat.node')
check('takes over the user and steering node kinds', occupants.length === 2
  && occupants.every((row) => ['user', 'steering'].includes(row.options.key)), occupants.map((row) => row.options.key))
check('wins the shadowing ledger (lowest priority renders)',
  occupants.every((row) => row.options.priority === -10), occupants.map((row) => row.options.priority))
check('nothing was committed to the seat when it registered', entries.length === 0, entries.length)

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------
const userNode = occupants.find((row) => row.options.key === 'user').component

/** Render one occupant with a node of the given shape, and hand back its tree. */
function render(content) {
  let tree = null
  act(() => { tree = create(h(userNode, { node: { data: { content } }, nodeKey: 'n1' })) })
  return tree
}
/** The props of a rendered host element, or undefined when it is not one. */
function propsOf(node) {
  return node === null || typeof node !== 'object' ? undefined : node.props
}

/** A stand-in for the shipped renderer: echoes what it was handed. */
const shippedCalls = []
function ShippedUserRow(props) {
  const parts = props.node?.data?.content
  shippedCalls.push(parts)
  return h('div', { className: 'fake-shipped-row' },
    Array.isArray(parts) ? parts.map((part) => part.text ?? '').join('') : String(parts))
}

const SNIPPET = '\n<!-- code-workbench-snippet {"anchor":"src/a.ts:3-4","language":"ts"} -->\n```ts\nconst a = 1\nconst b = 2\n```\n<!-- /code-workbench-snippet -->\n'

console.log('\nthe shipped renderer arrives after this plugin (the shipped bug)')
// The pre-fix build captured the entry list here, found nothing, and drew every
// user message as bare text on the left. Rendering again must now find it.
entries.push({ options: { name: 'conversation.chat.node', key: 'user', priority: 0 }, component: ShippedUserRow })
{
  const tree = render([{ type: 'text', text: '你好' }])
  const root = tree.toJSON()
  check('the message is drawn by the shipped renderer', propsOf(root)?.className === 'fake-shipped-row', root)
  check('and it received the message unchanged', shippedCalls.at(-1)?.[0]?.text === '你好', shippedCalls.at(-1))
}

console.log('\nwith no shipped renderer at all, the message keeps its bubble and its edge')
{
  // A fresh occupant list: this is the seat answering with nothing, which is
  // what an API change would look like. The message must not lose its place.
  const saved = entries.splice(0, entries.length)
  const tree = render([{ type: 'text', text: '只有文本' }])
  const root = tree.toJSON()
  check('a bubble is drawn rather than a bare block', propsOf(root)?.className === 'code-workbench-chat-bubble', root)
  check('carrying the message text', JSON.stringify(root).includes('只有文本'), root)
  entries.push(...saved)
}

console.log('\na code reference collapses, and the message itself is still the shipped row')
{
  const tree = render([{ type: 'text', text: `看这里${SNIPPET}` }])
  const root = tree.toJSON()
  check('the wrapper is a layout-neutral container', propsOf(root)?.className === 'code-workbench-chat-reference', root)
  const children = root?.children ?? []
  check('first child is the shipped row', propsOf(children[0])?.className === 'fake-shipped-row', children[0])
  const handed = shippedCalls.at(-1)
  check('the snippet is removed from what the shipped row is asked to draw',
    JSON.stringify(handed).includes('看这里') && !JSON.stringify(handed).includes('code-workbench-snippet'), handed)
  check('the snippet becomes one card', propsOf(children[1])?.className === 'code-workbench-chat-snippet', children[1])
  check('named by path and line range', JSON.stringify(children[1]).includes('src/a.ts:3-4'), children[1])
}

console.log('\na node that is not a parts array is handed through untouched')
{
  const before = shippedCalls.length
  let tree = null
  act(() => { tree = create(h(userNode, { node: { data: { content: 'a plain string' } }, nodeKey: 'n2' })) })
  const root = tree.toJSON()
  check('the shipped renderer still draws it', propsOf(root)?.className === 'fake-shipped-row', root)
  check('and its content was not rewritten', shippedCalls.length === before + 1
    && shippedCalls.at(-1) === 'a plain string', shippedCalls.at(-1))
}

console.log('\nstylesheet: the wrapper adds no box, the fallback hugs the message edge')
{
  const css = fs.readFileSync(new URL('../dsh-code-workbench/src/workbench.css', import.meta.url), 'utf8')
  check('the reference wrapper is layout-transparent',
    /\.code-workbench-chat-reference\s*\{[^}]*display:\s*contents/.test(css))
  check('the fallback bubble is pushed to the same edge as the message',
    /\.code-workbench-chat-bubble\s*\{[^}]*margin-inline-start:\s*auto/.test(css))
  check('and capped at the shipped bubble width',
    /\.code-workbench-chat-bubble\s*\{[^}]*max-width:\s*min\(calc\(var\(--dsh-chat-content-width, 748px\) \* \.702\), 82%\)/.test(css))
}

if (failures > 0) {
  console.log(`\n${failures} FAILED`)
  process.exit(1)
}
console.log('\nALL PASS')
