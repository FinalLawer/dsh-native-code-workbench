/**
 * Host-half completion-route test (`POST /api/code-workbench/complete`).
 *
 * The Tab-completion ghost text rides on one short auxiliary call per typing
 * pause; this pins its framing (before/after JSON around the caret), its
 * small token budget, and the NDJSON stream contract.
 *
 *   node tools/test-host-complete.mjs
 */
import { apply, Config } from '../dsh-code-workbench/index.js'

let failures = 0
/** Assert one expectation. */
function check(label, condition, detail) {
  if (condition) console.log(`  ok   ${label}`)
  else {
    failures++
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  }
}

for (const field of ['autoSave', 'completionProvider', 'completionModel', 'completionApiStyle']) {
  check(`${field} is editable through Host settings`, Config.dict[field].meta.volatile === true)
}
check('the independent route defaults to the chat shape', Config.dict.completionApiStyle.meta.default === 'chat')

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
        for (const text of options.deltas ?? ['.map(x => x']) yield { type: 'text-delta', index: 0, text }
        if (options.throwError) throw options.throwError
        yield { type: 'finish', reason: options.finishReason ?? { kind: 'stop' } }
      },
    },
    tools: { register: () => () => {} },
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

/** Mount the plugin and return the completion route. */
function mount(options = {}) {
  const { scope, calls } = makeScope(options)
  apply({ inject: (names, callback) => callback(scope) }, options.config)
  return { route: calls.routes.find((r) => r.path === '/api/code-workbench/complete'), calls }
}

/** Build one completion POST request. */
function makeRequest(body) {
  return new Request('http://127.0.0.1/api/code-workbench/complete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
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
  prefix: 'const xs = [1, 2, 3]\nconst doubled = xs',
  suffix: '\nconsole.log(doubled)',
}

console.log('wiring')
{
  const { route, calls } = mount()
  check('registers the completion route', route !== undefined)
  check('every route is mounted', ['/api/code-workbench/write', '/api/code-workbench/file-operation', '/api/code-workbench/search',
    '/api/code-workbench/complete', '/api/code-workbench/history', '/api/code-workbench/rollback']
    .every((p) => calls.routes.some((r) => r.path === p)), calls.routes.map((r) => r.path))
  check('accepts POST buffered', route?.methods?.[0] === 'POST' && route?.requestBody === 'buffered')
}

console.log('\nrequest gating')
{
  const { route } = mount({ unauthorized: true })
  check('unauthenticated is 401', (await route.fetch(makeRequest(SAMPLE))).status === 401)
  const { route: r2 } = mount()
  check('missing prefix is 400', (await r2.fetch(makeRequest({ ...SAMPLE, prefix: '   ' }))).status === 400)
  const { route: r3 } = mount({ selection: { provider: '', model: '' } })
  check('no default model is 409', (await r3.fetch(makeRequest(SAMPLE))).status === 409)
}

console.log('\nthe auxiliary call (framing and budget)')
{
  const { route, calls } = mount()
  const got = await frames(await route.fetch(makeRequest(SAMPLE)))
  check('streams the continuation and a done frame',
    JSON.stringify(got.map((f) => f.t)) === JSON.stringify(['delta', 'done']), got)
  const generate = calls.stream[0]
  check('provider/model come from agentDefaultModel',
    generate?.provider === 'deepseek' && generate?.model === 'deepseek-chat')
  check('keeps the token budget small', generate?.maxTokens === 128, generate?.maxTokens)
  check('uses the completion system instruction',
    typeof generate?.system === 'string' && generate.system.includes('insert exactly at the caret'))
  const framed = generate?.messages?.[0]?.content?.[0]?.text ?? ''
  const contextLine = framed.split('\n').at(-1)
  check('frames before/after the caret as JSON',
    contextLine === JSON.stringify({ before: SAMPLE.prefix, after: SAMPLE.suffix }), contextLine)
  check('plain RequestMessage input', generate?.messages?.[0]?.role === 'user' && generate?.messages?.[0]?.id === undefined)
}

console.log('\nstream failures')
{
  for (const kind of ['error', 'max-tokens', 'aborted']) {
    const { route } = mount({ finishReason: { kind } })
    const got = await frames(await route.fetch(makeRequest(SAMPLE)))
    check(`${kind} finish returns an error frame rather than success`,
      got.at(-1)?.t === 'error' && !got.some((frame) => frame.t === 'done'), got)
  }
  const { route } = mount({ throwError: new Error('provider unavailable') })
  const got = await frames(await route.fetch(makeRequest(SAMPLE)))
  check('thrown provider failure returns an error frame',
    got.at(-1)?.t === 'error' && got.at(-1)?.message === 'provider unavailable', got)
}

console.log('\ncaps hold')
{
  const { route, calls } = mount({ config: { completionProvider: 'fast-provider', completionModel: 'fast-model' } })
  await frames(await route.fetch(makeRequest(SAMPLE)))
  check('dedicated completion configuration overrides the Agent route', calls.stream[0]?.provider === 'fast-provider' && calls.stream[0]?.model === 'fast-model')
}
{
  const { route, calls } = mount()
  await route.fetch(makeRequest({ ...SAMPLE, prefix: 'x'.repeat(9000), suffix: 'y'.repeat(5000) }))
  const framed = calls.stream.at(-1)?.messages?.[0]?.content?.[0]?.text ?? ''
  const contextLine = framed.split('\n').at(-1)
  const parsed = JSON.parse(contextLine)
  check('prefix is capped at 3200', parsed.before.length === 3200, parsed.before.length)
  check('suffix is capped at 900', parsed.after.length === 900, parsed.after.length)
}

console.log('\nthe independent route: chat shape (default)')
{
  const originalFetch = globalThis.fetch
  let sent
  try {
    globalThis.fetch = async (url, init) => {
      sent = { url, init }
      const bytes = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n')
      return new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close() } }))
    }
    const { route } = mount({ config: { completionApiEnabled: true, completionBaseUrl: 'https://example.com/v1', completionApiModel: 'm', completionApiKey: 'k' } })
    const got = await frames(await route.fetch(makeRequest(SAMPLE)))
    check('an enabled independent API still uses /chat/completions by default',
      sent.url === 'https://example.com/v1/chat/completions', sent.url)
    check('the chat body carries a messages array', Array.isArray(JSON.parse(sent.init.body).messages))
    check('the chat shape streams delta then done',
      JSON.stringify(got.map((f) => f.t)) === JSON.stringify(['delta', 'done']), got)
  } finally { globalThis.fetch = originalFetch }
}

console.log('\nthe independent route: FIM shape')
{
  const originalFetch = globalThis.fetch
  let sent
  try {
    globalThis.fetch = async (url, init) => {
      sent = { url, init }
      const bytes = new TextEncoder().encode('data: {"choices":[{"text":"filled"}]}\n\ndata: [DONE]\n\n')
      return new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close() } }))
    }
    const { route } = mount({ config: { completionApiEnabled: true, completionApiStyle: 'fim', completionBaseUrl: 'https://api.deepseek.com/beta', completionApiModel: 'deepseek-v4-pro', completionApiKey: 'k' } })
    const got = await frames(await route.fetch(makeRequest(SAMPLE)))
    check('the style selects the /completions endpoint',
      sent.url === 'https://api.deepseek.com/beta/completions', sent.url)
    const body = JSON.parse(sent.init.body)
    check('the caret sides travel as prompt and suffix',
      body.prompt === SAMPLE.prefix && body.suffix === SAMPLE.suffix, { prompt: body.prompt, suffix: body.suffix })
    check('the FIM body carries no messages array', body.messages === undefined, body.messages)
    check('the FIM shape streams delta then done',
      JSON.stringify(got.map((f) => f.t)) === JSON.stringify(['delta', 'done']), got)
  } finally { globalThis.fetch = originalFetch }
}
{
  const originalFetch = globalThis.fetch
  let sent
  try {
    globalThis.fetch = async (url, init) => {
      sent = { url, init }
      return new Response(new ReadableStream({ start(controller) { controller.close() } }))
    }
    const { route } = mount({ config: { completionApiEnabled: true, completionApiStyle: 'fim', completionBaseUrl: 'https://api.deepseek.com/beta', completionApiModel: 'deepseek-v4-pro' } })
    await route.fetch(makeRequest({ ...SAMPLE, prefix: 'x'.repeat(9000), suffix: 'y'.repeat(5000) }))
    const body = JSON.parse(sent.init.body)
    check('FIM caps the prefix at 3200', body.prompt.length === 3200, body.prompt.length)
    check('FIM caps the suffix at 900', body.suffix.length === 900, body.suffix.length)
    check('FIM keeps the small token budget', body.max_tokens === 128, body.max_tokens)
  } finally { globalThis.fetch = originalFetch }
}
{
  const { route } = mount({ config: { completionApiEnabled: true, completionApiStyle: 'fim', completionBaseUrl: 'not-a-url', completionApiModel: 'm' } })
  check('an invalid FIM base URL is 400', (await route.fetch(makeRequest(SAMPLE))).status === 400)
}
{
  const { route, calls } = mount({ config: { completionApiStyle: 'fim' } })
  await frames(await route.fetch(makeRequest(SAMPLE)))
  check('a FIM style without the independent toggle stays on the Agent route',
    calls.stream[0]?.provider === 'deepseek' && calls.stream[0]?.model === 'deepseek-chat', calls.stream[0])
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
