/**
 * Host-half rewrite-route test (`POST /api/cursor-code/rewrite`).
 *
 * Runs the real `apply` against recording stubs and consumes the NDJSON stream,
 * pinning the auxiliary-call contract this route is built on:
 *
 *  1. the model route comes from `agentDefaultModel.currentSelection()`;
 *  2. `ctx.llm.stream` receives a plain `RequestMessage` user message, the
 *     rewrite system instruction, the session id, and the request's signal;
 *  3. text-delta chunks become `{"t":"delta"}` frames, a `stop` finish becomes
 *     `{"t":"done"}`, and every failure (finish reason or thrown error) becomes
 *     one `{"t":"error"}` frame the editor can show.
 *
 *   node tools/test-host-rewrite.mjs
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

/**
 * Build the recording service scope.
 * @param options - configurable stub behavior.
 * @returns the scope plus recorded calls.
 */
function makeScope(options = {}) {
  const calls = { stream: [], routes: [] }
  const scope = {
    effect: (callback) => callback(),
    llm: {
      async *stream(generate) {
        calls.stream.push(generate)
        if (options.streamThrows) throw Object.assign(new Error('provider exploded'), { code: 'LLM_BOOM' })
        for (const text of options.deltas ?? ['he', 'llo']) yield { type: 'text-delta', index: 0, text }
        yield { type: 'finish', reason: options.finish ?? { kind: 'stop' } }
      },
    },
    tools: {
      register() {
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
    sessions: { get: () => ({ header: { cwd: 'C:\\work\\repo' } }) },
    fs: {
      resolve: async (path) => ({ displayPath: path }),
      contains: () => true,
      stat: async () => undefined,
      writeText: async () => ({ operation: 'update', version: {}, before: '', after: '' }),
    },
    get(name) {
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => options.selection ?? { provider: 'deepseek', model: 'deepseek-chat' } }
      }
      return undefined
    },
  }
  return { scope, calls }
}

/** Mount the plugin and return the rewrite route. */
function mount(options = {}) {
  const { scope, calls } = makeScope(options)
  const ctx = { inject: (names, callback) => callback(scope) }
  apply(ctx)
  return { route: calls.routes.find((r) => r.path === '/api/cursor-code/rewrite'), calls }
}

/** Read one streamed response into its NDJSON frames. */
async function frames(response) {
  const text = await response.text()
  return text.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line))
}

const SAMPLE = {
  sessionId: 'session-1',
  path: 'src/a.js',
  language: 'javascript',
  instruction: '用 const 重写',
  selectedText: 'var x = 1',
  contextBefore: 'function f() {',
  contextAfter: '}',
}

console.log('wiring')
{
  const { route } = mount()
  check('registers the rewrite route', route !== undefined)
  check('accepts POST buffered', route?.methods?.[0] === 'POST' && route?.requestBody === 'buffered')
}

console.log('\nrequest gating')
{
  const { route } = mount({ unauthorized: true })
  check('unauthenticated is 401', (await route.fetch(makeRequest(SAMPLE))).status === 401)
  const { route: r2 } = mount()
  check('missing instruction is 400', (await r2.fetch(makeRequest({ ...SAMPLE, instruction: '  ' }))).status === 400)
  check('missing selectedText is 400', (await r2.fetch(makeRequest({ ...SAMPLE, selectedText: undefined }))).status === 400)
}
{
  const { route } = mount({ selection: { provider: '', model: '' } })
  const response = await route.fetch(makeRequest(SAMPLE))
  check('no default model is 409 MODEL_UNAVAILABLE',
    response.status === 409 && (await response.json()).error?.code === 'MODEL_UNAVAILABLE')
}

/** Build one rewrite POST request. */
function makeRequest(body) {
  return new Request('http://127.0.0.1/api/cursor-code/rewrite', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

console.log('\nthe auxiliary call (the pinned GenerateOptions)')
{
  const { route, calls } = mount()
  const response = await route.fetch(makeRequest(SAMPLE))
  const got = await frames(response)
  check('streams the deltas and a done frame',
    JSON.stringify(got.map((f) => f.t)) === JSON.stringify(['delta', 'delta', 'done']), got)
  check('deltas concatenate to the proposal',
    got.filter((f) => f.t === 'delta').map((f) => f.text).join('') === 'hello')
  const generate = calls.stream[0]
  check('provider/model come from agentDefaultModel',
    generate?.provider === 'deepseek' && generate?.model === 'deepseek-chat', generate)
  check('carries the session id and the request signal',
    generate?.sessionId === 'session-1' && generate?.signal instanceof AbortSignal, generate?.sessionId)
  check('has the rewrite system instruction', typeof generate?.system === 'string' && generate.system.includes('replacement code'), generate?.system?.slice(0, 40))
  const userText = generate?.messages?.[0]?.content?.[0]?.text ?? ''
  check('the user message frames the instruction', userText.includes('用 const 重写'), userText.slice(0, 60))
  check('the code parts travel as JSON context',
    userText.includes(JSON.stringify({ before: SAMPLE.contextBefore, selected: SAMPLE.selectedText, after: SAMPLE.contextAfter })))
  check('the message is a plain RequestMessage (role/content only)',
    generate?.messages?.[0]?.role === 'user' && generate?.messages?.[0]?.id === undefined, Object.keys(generate?.messages?.[0] ?? {}))
}

console.log('\nfailures surface as error frames')
{
  const { route } = mount({ finish: { kind: 'error', failure: { message: 'quota', code: 'QUOTA' } } })
  const got = await frames(await route.fetch(makeRequest(SAMPLE)))
  check('an error finish becomes an error frame',
    got.at(-1)?.t === 'error' && got.at(-1)?.message === 'quota', got.at(-1))
}
{
  const { route } = mount({ finish: { kind: 'max-tokens' } })
  const got = await frames(await route.fetch(makeRequest(SAMPLE)))
  check('a max-tokens finish is reported', got.at(-1)?.t === 'error' && got.at(-1)?.code === 'LLM_MAX_TOKENS', got.at(-1))
}
{
  const { route } = mount({ streamThrows: true })
  const got = await frames(await route.fetch(makeRequest(SAMPLE)))
  check('a thrown provider error becomes an error frame',
    got.at(-1)?.t === 'error' && got.at(-1)?.code === 'LLM_BOOM', got.at(-1))
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
