/**
 * Host-half search-route test (`POST /api/code-workbench/search`).
 *
 * Pins the retrieval contract behind `@codebase`:
 * the bounded walk (ignored directories and extensions never scanned),
 * literal vs regex matching, the case toggle, and the caps that keep one
 * query from stalling the Host.
 *
 *   node tools/test-host-search.mjs
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

const ROOT = 'C:\\work\\repo'

/** A tiny in-memory tree: dir path -> entries; file path -> text. */
const TREE = {
  [`${ROOT}`]: [
    { name: 'a.js', type: 'file', size: 100 },
    { name: 'image.png', type: 'file', size: 100 },
    { name: 'sub', type: 'directory' },
    { name: 'node_modules', type: 'directory' },
    { name: 'docs', type: 'directory' },
  ],
  [`${ROOT}\\sub`]: [
    { name: 'b.ts', type: 'file', size: 100 },
    { name: 'deep', type: 'directory' },
  ],
  [`${ROOT}\\sub\\deep`]: [{ name: 'c.md', type: 'file', size: 100 }],
  [`${ROOT}\\node_modules`]: [{ name: 'x.js', type: 'file', size: 100 }],
  [`${ROOT}\\docs`]: [{ name: 'readme.md', type: 'file', size: 100 }],
}
const FILES = {
  [`${ROOT}\\a.js`]: 'Hello world\nconst x = 1\n',
  [`${ROOT}\\sub\\b.ts`]: 'hello there\nHELLO again\nnothing\n',
  [`${ROOT}\\sub\\deep\\c.md`]: 'say hello in markdown\n',
  [`${ROOT}\\node_modules\\x.js`]: 'hello from a dependency\n',
  [`${ROOT}\\docs\\readme.md`]: 'hello docs\n',
}

/**
 * Build the stub scope over TREE/FILES.
 * @param options - configurable stub behavior.
 * @returns the scope plus recorded calls.
 */
function makeScope(options = {}) {
  const calls = { routes: [] }
  const tree = options.tree ?? TREE
  const texts = options.files ?? FILES
  const scope = {
    effect: (callback) => callback(),
    llm: { async *stream() { /* unused in search tests */ } },
    tools: { register() { return () => {} } },
    connection: {
      admit: () => (options.unauthorized ? { rejection: 401 } : { peer: {} }),
      fetch: {
        register(route) {
          calls.routes.push(route)
          return () => {}
        },
      },
    },
    sessions: { get: () => ({ header: { cwd: ROOT } }) },
    fs: {
      resolve: async (path) => ({ displayPath: path, targetKey: path }),
      contains: () => true,
      stat: async () => undefined,
      writeText: async () => ({ operation: 'update', version: {}, before: '', after: '' }),
      listDir: async (target) => (tree[target.displayPath] ?? []).map((entry) => ({
        ...entry,
        target: { displayPath: `${target.displayPath}\\${entry.name}`, targetKey: `${target.displayPath}\\${entry.name}` },
      })),
      readText: async (target) => {
        if (options.readFail === target.displayPath) throw new Error('unreadable')
        return texts[target.displayPath] ?? ''
      },
    },
    get(name) {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
      return undefined
    },
  }
  return { scope, calls }
}

/** Mount the plugin and return the search route. */
function mount(options = {}) {
  const { scope, calls } = makeScope(options)
  apply({ inject: (names, callback) => callback(scope) })
  return { route: calls.routes.find((r) => r.path === '/api/code-workbench/search'), calls }
}

/** Build one search POST request. */
function makeRequest(body) {
  return new Request('http://127.0.0.1/api/code-workbench/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** Run one search and return `{ status, body }`. */
async function search(options, query) {
  const { route } = mount(options)
  const response = await route.fetch(makeRequest({ sessionId: 'session-1', ...query }))
  return { status: response.status, body: await response.json() }
}

console.log('wiring')
{
  const { route, calls } = mount()
  check('registers the search route', route !== undefined)
  check('every route is mounted', ['/api/code-workbench/write', '/api/code-workbench/file-operation', '/api/code-workbench/search',
    '/api/code-workbench/complete', '/api/code-workbench/history', '/api/code-workbench/rollback']
    .every((p) => calls.routes.some((r) => r.path === p)), calls.routes.map((r) => r.path))
  check('accepts POST buffered', route?.methods?.[0] === 'POST' && route?.requestBody === 'buffered')
}

console.log('\nrequest gating')
{
  const { route } = mount({ unauthorized: true })
  check('unauthenticated is 401', (await route.fetch(makeRequest({ sessionId: 's', query: 'x' }))).status === 401)
}
{
  const { status, body } = await search({}, { query: '  ' })
  check('an empty query is 400', status === 400 && body.error?.code === 'BAD_REQUEST', body)
}
{
  const { status, body } = await search({}, { query: '(unclosed', regex: true })
  check('an invalid regex is 400 REGEX_INVALID', status === 400 && body.error?.code === 'REGEX_INVALID', body)
}

console.log('\na pattern that would stall the Host is refused, not run')
{
  // A quantified group whose body is itself unbounded grows exponentially: the
  // engine cannot be interrupted once it is inside `exec`, so no budget check
  // can help and the only safe moment to refuse it is before the first match.
  for (const pattern of ['(a+)+$', '(.*)*', '(\\w+\\s?)*', '(a+){2,}', '((a+))+', '(\\w+ )+\\w+']) {
    const { status, body } = await search({}, { query: pattern, regex: true })
    check(`${pattern} is 400 REGEX_UNSAFE`, status === 400 && body.error?.code === 'REGEX_UNSAFE', { status, ...body })
  }
  // The guard must not cost anyone a legitimate pattern.
  for (const pattern of ['a+', '(a+)', '(?:a|b)+', '(a|b)+', '[+*]+', '(a{1,2})+', '(\\d{1,3}\\.){3}', 'function\\s+\\w+\\(']) {
    const { status, body } = await search({}, { query: pattern, regex: true })
    check(`${pattern} is still allowed`, status === 200, { status, ...body })
  }
}
{
  // Escaped parentheses are literals, and a class is not a group: neither can
  // form the nested-quantifier shape, so neither may be refused.
  const { status } = await search({}, { query: '\\(a+\\)+', regex: true })
  check('an escaped group is not mistaken for a group', status === 200, status)
}

console.log('\nthe time budget is enforced inside a file, not only between files')
{
  // One long file, one match past the point where the budget expires. A stub
  // clock lets the walk overrun deterministically instead of sleeping 4s: the
  // first three reads (start, the pre-file check, the i=0 check) stay at T, so
  // only the in-loop check at i=64 can stop the scan. Without that check the
  // whole file is scanned and the match at line 100 is reported.
  const longFile = `${ROOT}\\long.js`
  const body = Array.from({ length: 200 }, (_, i) => (i === 99 ? 'needle here' : `line ${i + 1}`)).join('\n')
  const options = {
    tree: { [ROOT]: [{ name: 'long.js', type: 'file', size: 100 }] },
    files: { [longFile]: `${body}\n` },
  }
  const realNow = Date.now
  let reads = 0
  Date.now = () => (++reads > 3 ? realNow() + 10_000 : realNow())
  let result
  try {
    result = await search(options, { query: 'needle' })
  } finally {
    Date.now = realNow
  }
  check('the walk reports truncation rather than running on', result.body.truncated === true, result.body)
  check('the match past the budget is not reported', result.body.matches.length === 0, result.body.matches)
  check('the search still answers 200', result.status === 200, result.status)
}

console.log('\nmatching')
{
  const { status, body } = await search({}, { query: 'hello' })
  check('literal matching works', status === 200 && body.ok === true, body)
  const hits = body.matches.map((m) => `${m.path}:${m.line}`).sort()
  check('case-insensitive by default', JSON.stringify(hits) === JSON.stringify([
    `${ROOT}\\a.js:1`,
    `${ROOT}\\docs\\readme.md:1`,
    `${ROOT}\\sub\\b.ts:1`,
    `${ROOT}\\sub\\b.ts:2`,
    `${ROOT}\\sub\\deep\\c.md:1`,
  ].sort()), hits)
  check('reports the match column and length', body.matches.every((m) => m.column >= 1 && m.length >= 1))
}
{
  const { body } = await search({}, { query: 'hello', caseSensitive: true })
  const hits = body.matches.map((m) => `${m.path}:${m.line}`)
  check('case-sensitive matching narrows the result', JSON.stringify(hits) === JSON.stringify([
    `${ROOT}\\sub\\b.ts:1`,
    `${ROOT}\\docs\\readme.md:1`,
    `${ROOT}\\sub\\deep\\c.md:1`,
  ]), hits)
}
{
  const { body } = await search({}, { query: 'h.llo', regex: true })
  check('regex mode matches', body.matches.length === 5, body.matches.length)
}

console.log('\nthe walk stays bounded and polite')
{
  const { body } = await search({}, { query: 'hello' })
  check('node_modules is never scanned', !body.matches.some((m) => m.path.includes('node_modules')))
  check('binary extensions are never scanned', !body.matches.some((m) => m.path.endsWith('.png')))
  check('counts the files it read', body.filesScanned === 4, body.filesScanned)
}
{
  const { body } = await search({}, { query: 'hello', maxMatches: 2 })
  check('the match cap reports truncation', body.matches.length === 2 && body.truncated === true, body)
}

console.log('\nfailures surface honestly')
{
  const { status, body } = await search({ readFail: `${ROOT}\\a.js` }, { query: 'hello' })
  check('an unreadable file is skipped, not fatal', status === 200 && !body.matches.some((m) => m.path.endsWith('a.js')))
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
