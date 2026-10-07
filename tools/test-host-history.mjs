/**
 * Host-half save-journal test (`/api/code-workbench/history` + `/rollback`).
 *
 * Every accepted write keeps its before/after in the journal (save
 * checkpoints); this pins that a save journals, the listing hides contents but
 * says what is rollbackable, and a rollback restores the exact before content
 * — and is itself journaled, so it is reversible too.
 *
 *   node tools/test-host-history.mjs
 */
import { apply } from '../dsh-code-workbench/index.js'

let failures = 0
/** Assert one expectation. */
function check(label, condition, detail) {
  if (condition) console.log(`  ok   ${label}`)
  else {
    failures++
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  }
}

/**
 * Build the stub scope; `writeText` records calls and returns a canned outcome.
 * @param options - configurable stub behavior.
 * @returns the scope plus recorded calls.
 */
function makeScope(options = {}) {
  const calls = { write: [], routes: [] }
  const scope = {
    effect: (callback) => callback(),
    llm: { async *stream() { /* unused in history tests */ } },
    tools: { register: () => () => {} },
    connection: {
      admit: () => ({ peer: {} }),
      fetch: {
        register(route) {
          calls.routes.push(route)
          return () => {}
        },
      },
    },
    sessions: { get: () => ({ header: { cwd: 'C:\\work\\repo' } }) },
    fs: {
      resolve: async (path) => ({ displayPath: path }),
      contains: () => true,
      stat: async () => ({ version: { v: calls.write.length } }),
      writeText: async (...args) => {
        calls.write.push(args)
        return {
          operation: 'update',
          version: { v: calls.write.length },
          before: calls.write.length === 1 && options.firstBefore === null ? null : `before-${calls.write.length}`,
          after: '',
        }
      },
    },
    get(name) {
      if (name === 'sandboxPolicy') return { resolve: () => ({ mode: 'workspace-write', workspaceRoot: 'C:\\work\\repo' }) }
      if (name === 'sessionFeedback') return { record: () => {} }
      return undefined
    },
  }
  apply({ inject: (names, callback) => callback(scope) })
  return {
    route: (path) => calls.routes.find((r) => r.path === path),
    calls,
  }
}

/** Build one JSON POST request. */
function makeRequest(path, body) {
  return new Request(`http://127.0.0.1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

console.log('journal flow')
{
  const { route } = makeScope()
  const write = route('/api/code-workbench/write')
  const history = route('/api/code-workbench/history')
  const rollback = route('/api/code-workbench/rollback')
  const sessionId = 'session-j1'
  const file = 'src\\journal.js'

  await write.fetch(makeRequest('/api/code-workbench/write', { sessionId, path: file, text: 'v1\n', note: '第一次' }))
  await write.fetch(makeRequest('/api/code-workbench/write', { sessionId, path: file, text: 'v2\n', note: '手动编辑: 加注释' }))

  const listed = await (await history.fetch(makeRequest('/api/code-workbench/history', { sessionId, path: file }))).json()
  check('both saves are listed, newest first', listed.entries?.length === 2 && listed.entries[0]?.note === '手动编辑: 加注释', listed.entries)
  check('listing carries metadata but no contents',
    listed.entries.every((e) => e.before === undefined && e.after === undefined && Number.isFinite(e.at)))
  check('entries are rollbackable', listed.entries.every((e) => e.rollbackable === true))

  const target = listed.entries[0]
  const result = await (await rollback.fetch(makeRequest('/api/code-workbench/rollback', { sessionId, path: file, id: target.id }))).json()
  check('rollback succeeds', result.ok === true, result)
  const after = await (await history.fetch(makeRequest('/api/code-workbench/history', { sessionId, path: file }))).json()
  check('the rollback is itself journaled', after.entries?.length === 3 && after.entries[0]?.note.startsWith('回滚'), after.entries?.[0])
}

console.log('\nrollback restores the exact before content')
{
  const { route, calls } = makeScope()
  const write = route('/api/code-workbench/write')
  const history = route('/api/code-workbench/history')
  const rollback = route('/api/code-workbench/rollback')
  const sessionId = 'session-j2'
  const file = 'src\\restore.js'

  await write.fetch(makeRequest('/api/code-workbench/write', { sessionId, path: file, text: 'new\n' }))
  const listed = await (await history.fetch(makeRequest('/api/code-workbench/history', { sessionId, path: file }))).json()
  await rollback.fetch(makeRequest('/api/code-workbench/rollback', { sessionId, path: file, id: listed.entries[0].id }))
  check('writeText received the journaled before content', calls.write.at(-1)?.[1] === 'before-1', calls.write.at(-1)?.[1])
  check('with a version intent', calls.write.at(-1)?.[2]?.kind === 'replaceIfVersion', calls.write.at(-1)?.[2])
  check('and the sandbox policy', calls.write.at(-1)?.[4]?.mode === 'workspace-write', calls.write.at(-1)?.[4])
}

console.log('\nhonest failures')
{
  const { route } = makeScope()
  const write = route('/api/code-workbench/write')
  const history = route('/api/code-workbench/history')
  const rollback = route('/api/code-workbench/rollback')
  const sessionId = 'session-j3'
  const file = 'src\\fail.js'

  const missing = await rollback.fetch(makeRequest('/api/code-workbench/rollback', { sessionId, path: file, id: 'nope' }))
  check('unknown entry id is 404', missing.status === 404 && (await missing.json()).error?.code === 'ENTRY_NOT_FOUND')

  await write.fetch(makeRequest('/api/code-workbench/write', { sessionId, path: file, text: 'x\n' }))
  const listed = await (await history.fetch(makeRequest('/api/code-workbench/history', { sessionId, path: file }))).json()
  check('the journal is per file', listed.entries?.length === 1, listed.entries?.length)
  const other = await (await history.fetch(makeRequest('/api/code-workbench/history', { sessionId, path: 'src\\other.js' }))).json()
  check('another file has its own (empty) journal', other.entries?.length === 0, other.entries)
}

console.log('\na save without retained before content is not rollbackable')
{
  const { route } = makeScope({ firstBefore: null })
  const write = route('/api/code-workbench/write')
  const history = route('/api/code-workbench/history')
  const rollback = route('/api/code-workbench/rollback')
  const sessionId = 'session-j4'
  const file = 'src\\nobefore.js'

  await write.fetch(makeRequest('/api/code-workbench/write', { sessionId, path: file, text: 'x\n' }))
  const listed = await (await history.fetch(makeRequest('/api/code-workbench/history', { sessionId, path: file }))).json()
  check('the entry reports itself not rollbackable', listed.entries[0]?.rollbackable === false, listed.entries[0])
  const denied = await rollback.fetch(makeRequest('/api/code-workbench/rollback', { sessionId, path: file, id: listed.entries[0].id }))
  check('rolling it back is 409 NOT_ROLLBACKABLE',
    denied.status === 409 && (await denied.json()).error?.code === 'NOT_ROLLBACKABLE')
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
