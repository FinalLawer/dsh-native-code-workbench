/**
 * Host-half retrieval-tool test (`codebase_search`, the Cursor-style
 * `@codebase` for the chat Agent).
 *
 * Pins the registration shape the Tool Runtime consumes (JSON-Schema
 * parameters, output schema + render) and the ranking behaviour that makes the
 * tool worth having over the shipped `grep`: multi-term coverage ranks first,
 * results are workspace-relative, and the caps hold.
 *
 *   node tools/test-host-tool.mjs
 */
import { apply } from '../dsh-cursor-code/index.js'

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
const TREE = {
  [ROOT]: [
    { name: 'a.js', type: 'file', size: 10 },
    { name: 'b.js', type: 'file', size: 10 },
    { name: 'c.js', type: 'file', size: 10 },
    { name: 'node_modules', type: 'directory' },
  ],
  [`${ROOT}\\node_modules`]: [{ name: 'dep.js', type: 'file', size: 10 }],
}
const FILES = {
  [`${ROOT}\\a.js`]: 'function retryBackoff() { /* retry with backoff */ }\nconst cache = new Map()\n',
  [`${ROOT}\\b.js`]: 'const delay = computeBackoff(attempt)\n',
  [`${ROOT}\\c.js`]: 'export const unrelated = 1\n',
  [`${ROOT}\\node_modules\\dep.js`]: 'retry backoff in a dependency\n',
}

/** Build the stub scope over TREE/FILES. */
function makeScope() {
  const calls = { tool: null }
  const scope = {
    effect: (callback) => callback(),
    llm: { async *stream() { /* rewrites only */ } },
    tools: {
      register(definition) {
        calls.tool = definition
        return () => {}
      },
    },
    connection: { admit: () => ({ peer: {} }), fetch: { register: () => () => {} } },
    sessions: { get: () => ({ header: { cwd: ROOT } }) },
    fs: {
      resolve: async (path) => ({ displayPath: path, targetKey: path }),
      contains: () => true,
      stat: async () => undefined,
      writeText: async () => ({ operation: 'update', version: {}, before: '', after: '' }),
      listDir: async (target) => (TREE[target.displayPath] ?? []).map((entry) => ({
        ...entry,
        target: { displayPath: `${target.displayPath}\\${entry.name}` },
      })),
      readText: async (target) => FILES[target.displayPath] ?? '',
    },
    get: (name) => (name === 'sandboxPolicy' ? { workspaceRoot: ROOT } : undefined),
  }
  apply({ inject: (names, callback) => callback(scope) })
  return { tool: calls.tool }
}

const exec = { agent: { session: { header: { cwd: ROOT } } }, signal: new AbortController().signal }

console.log('registration shape')
const { tool } = makeScope()
check('registers the tool', tool !== undefined)
check('named codebase_search', tool?.name === 'codebase_search', tool?.name)
check('has a description', typeof tool?.description === 'string' && tool.description.length > 20)
check('parameters is a JSON Schema object', tool?.parameters?.type === 'object', tool?.parameters)
check('query is required', Array.isArray(tool?.parameters?.required) && tool.parameters.required.includes('query'), tool?.parameters?.required)
check('timeoutMs is positive', typeof tool?.timeoutMs === 'number' && tool.timeoutMs > 0, tool?.timeoutMs)
check('output declares a schema and a render', typeof tool?.output?.schema === 'object' && typeof tool?.output?.render === 'function')

console.log('\nretrieval and ranking')
{
  const value = await tool.execute({ query: 'retry backoff' }, exec)
  check('returns results', Array.isArray(value.results) && value.results.length > 0, value.results?.length)
  check('multi-term coverage ranks first', value.results[0]?.path === 'a.js', value.results.map((r) => `${r.path}:${r.score}`))
  check('the one-term file ranks second', value.results[1]?.path === 'b.js', value.results)
  check('paths are workspace-relative', value.results.every((r) => !r.path.includes(':')), value.results[0]?.path)
  check('rows carry line numbers and text', value.results.every((r) => Number.isInteger(r.line) && typeof r.text === 'string' && r.text !== ''))
  check('node_modules is invisible to the tool', !value.results.some((r) => r.path.includes('node_modules')))
}
{
  const value = await tool.execute({ query: 'backoff', maxResults: 1 }, exec)
  check('maxResults caps the list', value.results.length === 1, value.results.length)
}
{
  const value = await tool.execute({ query: 'zzz-no-such-term' }, exec)
  check('no matches is an empty result, not an error', value.results.length === 0)
  const rendered = tool.output.render({}, value)
  check('render says so', rendered[0]?.type === 'text' && rendered[0].text.includes('No matches'), rendered[0])
}
{
  const value = await tool.execute({ query: 'retry backoff' }, exec)
  const rendered = tool.output.render({}, value)
  check('render lists path:line rows', rendered[0]?.text.includes('a.js:1:'), rendered[0]?.text.slice(0, 60))
}
{
  let threw = false
  try {
    await tool.execute({ query: '  ' }, exec)
  } catch {
    threw = true
  }
  check('an empty query throws', threw)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
