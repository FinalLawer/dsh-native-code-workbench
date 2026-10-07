/**
 * Host-half write-route test.
 *
 * Runs the real `apply` from `dsh-code-workbench/index.js` against recording stubs
 * and pushes requests through the registered Fetch route, pinning the two facts
 * that break silently at runtime:
 *
 *  1. the write is stamped with the SESSION's standing sandbox policy
 *     (`sandboxPolicy.resolve({ session })` as `writeText`'s 5th argument) —
 *     omitting it falls back to the deployment policy and every save dies with
 *     FS_SANDBOX_DENIED;
 *  2. the version intent and the workspace containment guard survive the trip.
 *
 *   node tools/test-host-write.mjs
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
 * Build the recording service scope the plugin sees.
 * @param options - configurable stub behavior.
 * @returns the scope plus its recorded calls.
 */
function makeScope(options = {}) {
  const calls = { write: [], resolvePolicy: [], remarks: [], routes: [] }
  const session = { header: { cwd: options.cwd ?? 'C:\\work\\repo' } }
  const policy = {
    resolve(request) {
      calls.resolvePolicy.push(request)
      return { mode: options.mode ?? 'workspace-write', workspaceRoot: session.header.cwd }
    },
  }
  const scope = {
    effect(callback, label) {
      return callback()
    },
    llm: {
      async *stream() { /* unused in write tests */ },
    },
    tools: {
      register(definition) {
        calls.tool = definition
        return () => {}
      },
    },
    connection: {
      admit: () => (options.unauthorized ? { rejection: 401 } : { peer: {} }),
      fetch: {
        register(route) {
          calls.routes.push(route)
          return () => {}
        },
      },
    },
    sessions: {
      get: (id) => (options.unknownSession ? undefined : session),
    },
    fs: {
      resolve: async (path) => ({ displayPath: path }),
      contains: (root, target) => !(options.outside ?? false),
      stat: async () => (options.statVersion === undefined ? undefined : { version: options.statVersion }),
      writeText: async (...args) => {
        calls.write.push(args)
        if (options.writeError) throw options.writeError
        return { operation: options.operation ?? 'update', version: options.newVersion ?? { mtimeMs: 2 }, before: '', after: '' }
      },
    },
    get(name) {
      if (name === 'sandboxPolicy') return policy
      if (name === 'sessionFeedback') return { record: (request) => { calls.remarks.push(request) } }
      return undefined
    },
  }
  return { scope, calls, session }
}

/** Build one JSON POST request carrying the standard body. */
function makeRequest(body, extra = {}) {
  return new Request('http://127.0.0.1/api/code-workbench/write', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(extra.headers ?? {}) },
    body: JSON.stringify(body),
  })
}

const SAMPLE = { sessionId: 'session-1', path: 'src/a.js', text: 'hello\nworld\n', expectedVersion: { mtimeMs: 1 } }

/**
 * Mount the plugin against a stub context and return the registered route.
 * @param options - stub behavior.
 * @returns route, calls, session.
 */
function mount(options = {}) {
  const { scope, calls, session } = makeScope(options)
  let injectNames = null
  const ctx = {
    inject(names, callback) {
      injectNames = names
      callback(scope)
    },
  }
  apply(ctx)
  calls.injectNames = injectNames
  return { route: calls.routes.find((r) => r.path === '/api/code-workbench/write'), calls, session }
}

console.log('wiring')
{
  const { route, calls } = mount()
  check('injects connection, fs, sessions, llm, tools',
    JSON.stringify(calls.injectNames) === JSON.stringify(['connection', 'fs', 'sessions', 'llm', 'tools']), calls.injectNames)
  check('registers every route', ['/api/code-workbench/write', '/api/code-workbench/file-operation', '/api/code-workbench/search',
    '/api/code-workbench/complete', '/api/code-workbench/history', '/api/code-workbench/rollback']
    .every((p) => calls.routes.some((r) => r.path === p)), calls.routes.map((r) => r.path))
  check('removed inline editing route is not registered',
    !calls.routes.some((r) => r.path === '/api/code-workbench/rewrite'), calls.routes.map((r) => r.path))
  check('route path is the write endpoint', route?.path === '/api/code-workbench/write', route?.path)
  check('route accepts POST buffered', route?.methods?.[0] === 'POST' && route?.requestBody === 'buffered')
}

console.log('\nrequest gating')
{
  const { route } = mount({ unauthorized: true })
  const response = await route.fetch(makeRequest(SAMPLE))
  check('an unauthenticated request is rejected with 401', response.status === 401, response.status)
}
{
  const { route } = mount()
  const bad = new Request('http://127.0.0.1/api/code-workbench/write', { method: 'POST', body: 'not json' })
  const response = await route.fetch(bad)
  check('a non-JSON body is rejected with 400', response.status === 400, response.status)
  const missing = await route.fetch(makeRequest({ sessionId: 's' }))
  check('a missing path is rejected with 400', missing.status === 400, missing.status)
}
{
  const { route } = mount({ unknownSession: true })
  const response = await route.fetch(makeRequest(SAMPLE))
  check('an unknown session is rejected with 404', response.status === 404, response.status)
}
{
  const { route } = mount({ outside: true })
  const response = await route.fetch(makeRequest(SAMPLE))
  check('a path outside the workspace is rejected with 403', response.status === 403, response.status)
}

console.log('\nthe sandbox policy stamp (the FS_SANDBOX_DENIED regression)')
{
  const { route, calls, session } = mount()
  const response = await route.fetch(makeRequest(SAMPLE))
  const body = await response.json()
  check('the happy path returns ok', response.status === 200 && body.ok === true, body)
  check('sandboxPolicy.resolve was asked for the SESSION', calls.resolvePolicy.length === 1
    && calls.resolvePolicy[0]?.session === session, calls.resolvePolicy)
  const args = calls.write[0]
  check('writeText received 5 arguments', args?.length === 5, args?.length)
  check('the 5th argument is the resolved standing policy',
    args?.[4]?.mode === 'workspace-write' && args?.[4]?.workspaceRoot === session.header.cwd, args?.[4])
  check('the version intent guards the observed version',
    args?.[2]?.kind === 'replaceIfVersion'
    && JSON.stringify(args?.[2]?.version) === JSON.stringify(SAMPLE.expectedVersion), args?.[2])
  check('the new version is returned to the editor', body.version !== undefined, body.version)
  check('one session remark records the manual save', calls.remarks.length === 1, calls.remarks)
  await route.fetch(makeRequest({ ...SAMPLE, note: '手动编辑: 加注释' }))
  check('the note travels into the session remark',
    calls.remarks.at(-1)?.text.includes('手动编辑: 加注释'), calls.remarks.at(-1))
}

console.log('\nversion and sandbox failures map to honest statuses')
{
  const error = Object.assign(new Error('stale'), { code: 'FS_STALE_VERSION' })
  const { route } = mount({ writeError: error })
  const response = await route.fetch(makeRequest(SAMPLE))
  check('a stale version is 409 with FS_STALE_VERSION', response.status === 409 && (await response.json()).error?.code === 'FS_STALE_VERSION')
}
{
  const error = Object.assign(new Error('denied'), { code: 'FS_SANDBOX_DENIED' })
  const { route } = mount({ writeError: error })
  const response = await route.fetch(makeRequest(SAMPLE))
  check('a sandbox denial is 403 with FS_SANDBOX_DENIED', response.status === 403 && (await response.json()).error?.code === 'FS_SANDBOX_DENIED')
}

console.log('\ncreate when the file is absent')
{
  const { route, calls } = mount({ statVersion: undefined })
  await route.fetch(makeRequest({ ...SAMPLE, expectedVersion: null }))
  check('an unversioned save of a missing file uses createIfAbsent',
    calls.write[0]?.[2]?.kind === 'createIfAbsent', calls.write[0]?.[2])
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
