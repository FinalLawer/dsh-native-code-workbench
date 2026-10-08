/**
 * Host-half completion-route test (`POST /api/code-workbench/complete`).
 *
 * Tab-completion ghost text rides on one short fill-in-the-middle call per
 * typing pause. This pins the wire shape, the credential preference order, the
 * deliberately silent failure mode, and the read-only status route that reports
 * which credential a completion would use.
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

console.log('config')
for (const field of ['autoSave', 'completionEnabled', 'completionBaseUrl', 'completionApiKey', 'completionApiModel']) {
  check(`${field} is editable through Host settings`, Config.dict[field].meta.volatile === true)
}
check('the completion credential stays a secret field', Config.dict.completionApiKey.meta.role === 'secret')
check('the FIM endpoint is the default base URL', Config.dict.completionBaseUrl.meta.default === 'https://api.deepseek.com/beta')
check('deepseek-flash is the default model', Config.dict.completionApiModel.meta.default === 'deepseek-flash')
// The chat shape and the Agent-route fallback are gone, so their settings must
// not survive as orphan keys the settings form would still try to render.
for (const gone of ['completionProvider', 'completionModel', 'completionApiEnabled', 'completionApiStyle']) {
  check(`${gone} is no longer a setting`, Config.dict[gone] === undefined)
}

/**
 * Build the recording service scope.
 * @param options - stub behaviour: `unauthorized`, `store`, `account`, `storeMissing`.
 * @returns the scope plus the recorded calls.
 */
function makeScope(options = {}) {
  const calls = { routes: [], logs: [] }
  const scope = {
    effect: (callback) => callback(),
    logger: { warn: (...args) => calls.logs.push(args) },
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
      if (name === 'credentials' && options.store !== undefined) {
        return {
          resolve: async () => (options.store === null ? undefined : { value: options.store, source: 'file' }),
        }
      }
      if (name === 'deepseekAccount' && options.account !== undefined) {
        return { resolveToken: async () => options.account }
      }
      return undefined
    },
  }
  return { scope, calls }
}

/** Mount the plugin and return every registered route. */
function mount(options = {}) {
  const { scope, calls } = makeScope(options)
  apply({ inject: (names, callback) => callback(scope) }, options.config)
  return { calls, route: calls.routes.find((r) => r.path === '/api/code-workbench/complete'), statusRoute: calls.routes.find((r) => r.path === '/api/code-workbench/completion-status') }
}

/** Build one completion POST request. */
function makeRequest(body) {
  return new Request('http://127.0.0.1/api/code-workbench/complete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** Read one completion response into its JSON body. */
async function payload(response) {
  return response.json()
}

/** A JSON response carrying one completion payload. */
function reply(frame) {
  return new Response(JSON.stringify(frame), { headers: { 'content-type': 'application/json' } })
}

/**
 * Run `work` with the global fetch stubbed, recording what was sent.
 * @param reply - builds the response (or throws).
 * @param work - the async body to run.
 * @returns `{sent, result}`.
 */
async function withFetch(reply, work) {
  const originalFetch = globalThis.fetch
  const sent = []
  globalThis.fetch = async (url, init) => {
    sent.push({ url, init })
    return reply()
  }
  try {
    return { sent, result: await work() }
  } finally {
    globalThis.fetch = originalFetch
  }
}

const SAMPLE = {
  sessionId: 'session-1',
  path: 'src/a.js',
  language: 'javascript',
  prefix: 'const xs = [1, 2, 3]\nconst doubled = xs',
  suffix: '\nconsole.log(doubled)',
}

console.log('\nwiring')
{
  const { calls, route, statusRoute } = mount()
  check('registers the completion route', route !== undefined)
  check('registers the completion-status route', statusRoute !== undefined)
  check('every route is mounted', ['/api/code-workbench/write', '/api/code-workbench/file-operation', '/api/code-workbench/search',
    '/api/code-workbench/complete', '/api/code-workbench/completion-status', '/api/code-workbench/history', '/api/code-workbench/rollback']
    .every((p) => calls.routes.some((r) => r.path === p)), calls.routes.map((r) => r.path))
  check('accepts POST buffered', route?.methods?.[0] === 'POST' && route?.requestBody === 'buffered')
}

console.log('\nrequest gating')
{
  const { route } = mount({ unauthorized: true })
  check('unauthenticated is 401', (await route.fetch(makeRequest(SAMPLE))).status === 401)
  const { route: r2 } = mount({ store: 'sk-x' })
  check('missing prefix is 400', (await r2.fetch(makeRequest({ ...SAMPLE, prefix: '   ' }))).status === 400)
  const { route: r3 } = mount({ store: 'sk-x' })
  check('a non-JSON body is 400', (await r3.fetch(new Request('http://127.0.0.1/api/code-workbench/complete', { method: 'POST', body: 'not json' }))).status === 400)
}

console.log('\nthe FIM call')
{
  const { sent, result } = await withFetch(() => reply({ choices: [{ text: 'filled' }] }), async () => {
    const { route } = mount({ store: 'sk-test-key' })
    return { got: await payload(await route.fetch(makeRequest(SAMPLE))) }
  })
  const { got } = result
  check('posts to the /completions endpoint', sent[0]?.url === 'https://api.deepseek.com/beta/completions', sent[0]?.url)
  const body = JSON.parse(sent[0].init.body)
  check('the caret sides travel as prompt and suffix', body.prompt === SAMPLE.prefix && body.suffix === SAMPLE.suffix, { prompt: body.prompt, suffix: body.suffix })
  check('the body carries no messages array', body.messages === undefined, body.messages)
  check('the default model is deepseek-flash', body.model === 'deepseek-flash', body.model)
  check('keeps the token budget small', body.max_tokens === 128, body.max_tokens)
  check('predicts code at a low temperature', body.temperature === 0.2, body.temperature)
  check('asks for one complete response, not a stream', body.stream === false, body.stream)
  check('the answer is one JSON body', got.ok === true, got)
  check('the returned text is the provider text', got.text === 'filled', got)
}
{
  const { sent } = await withFetch(() => reply({ choices: [{ text: 'x' }] }), async () => {
    const { route } = mount({ store: 'sk-test-key', config: { completionBaseUrl: 'https://api.deepseek.com/beta', completionApiModel: 'deepseek-v4-pro' } })
    return route.fetch(makeRequest(SAMPLE))
  })
  const body = JSON.parse(sent[0].init.body)
  check('the configured model and model ID win over the defaults', body.model === 'deepseek-v4-pro', body.model)
}
{
  const { sent } = await withFetch(() => reply({ choices: [{ text: 'x' }] }), async () => {
    const { route } = mount({ store: 'sk-test-key' })
    return route.fetch(makeRequest({ ...SAMPLE, prefix: 'x'.repeat(9000), suffix: 'y'.repeat(5000) }))
  })
  const body = JSON.parse(sent[0].init.body)
  check('caps the prefix at 3200', body.prompt.length === 3200, body.prompt.length)
  check('caps the suffix at 900', body.suffix.length === 900, body.suffix.length)
}
{
  const { sent } = await withFetch(() => reply({ choices: [{ text: 'x' }] }), async () => {
    const { route } = mount({ store: 'sk-test-key' })
    return route.fetch(makeRequest({ ...SAMPLE, suffix: '' }))
  })
  const body = JSON.parse(sent[0].init.body)
  // The key has to be there even when it is blank: dropping it downgrades the
  // request from fill-in-the-middle to plain continuation on DeepSeek's side,
  // and a one-comment file then completes as training-data prose.
  check('an empty suffix is still sent as a key', Object.hasOwn(body, 'suffix'), Object.keys(body))
  check('an empty suffix travels as an empty string', body.suffix === '', body.suffix)
}

console.log('\ncredential preference')
{
  const { sent } = await withFetch(() => reply({ choices: [{ text: 'x' }] }), async () => {
    const { route } = mount({ store: 'sk-from-store', account: 'grant-token', config: { completionApiKey: 'sk-typed' } })
    return route.fetch(makeRequest(SAMPLE))
  })
  check('a typed key outranks the store',
    sent.length === 1 && sent[0].init.headers.authorization === 'Bearer sk-typed', sent.map((one) => one.init.headers))
}
{
  const { sent } = await withFetch(() => reply({ choices: [{ text: 'x' }] }), async () => {
    const { route } = mount({ store: 'sk-from-store', account: 'grant-token' })
    return route.fetch(makeRequest(SAMPLE))
  })
  check('the store outranks the account',
    sent.length === 1 && sent[0].init.headers.authorization === 'Bearer sk-from-store', sent.map((one) => one.init.headers))
  check('no account header rides along', sent[0]?.init.headers['x-dsh-auth-token'] === undefined)
}
{
  const { sent } = await withFetch(() => reply({ choices: [{ text: 'x' }] }), async () => {
    const { route } = mount({ store: null, account: 'grant-token' })
    return route.fetch(makeRequest(SAMPLE))
  })
  check('an empty store falls through to the account',
    sent.length === 1 && sent[0].init.headers['x-dsh-auth-token'] === 'grant-token', sent.map((one) => one.init.headers))
  check('the account route sends no bearer header', sent[0]?.init.headers.authorization === undefined)
}
{
  const { sent } = await withFetch(() => reply({ choices: [{ text: 'x' }] }), async () => {
    const { route } = mount({})
    return route.fetch(makeRequest(SAMPLE))
  })
  check('without any credential no request is sent', sent.length === 0, sent.length)
}

console.log('\nsilent failure')
{
  const { route, calls } = mount({})
  const response = await route.fetch(makeRequest(SAMPLE))
  const got = await payload(response)
  check('a missing credential still answers 200, not an error status', response.status === 200, response.status)
  check('a missing credential answers with empty text and no error',
    JSON.stringify(got) === JSON.stringify({ ok: true, text: '' }), got)
  check('a missing credential reaches the Host log',
    calls.logs.some((args) => String(args[1]).includes('no completion credential')), calls.logs)
  const { route: r2 } = mount({ store: 'sk-x' })
  const badAddress = await r2.fetch(makeRequest(SAMPLE))
  check('an invalid base URL is not a 400 — it is silence', badAddress.status === 200, badAddress.status)
  check('an invalid base URL still answers an empty completion', JSON.stringify(await badAddress.json()) === '{"ok":true,"text":""}')
}
{
  const { sent, result } = await withFetch(() => new Response('nope', { status: 500 }), async () => {
    const { route, calls } = mount({ store: 'sk-x' })
    return { got: await payload(await route.fetch(makeRequest(SAMPLE))), calls }
  })
  check('a provider failure carries no error to the editor', result.got.text === '' && result.got.ok === true, result.got)
  check('a provider failure still answers 200', result.got.ok === true, result.got)
  check('the provider failure reaches the Host log', result.calls.logs.some((args) => String(args[1]).includes('provider request failed')), result.calls.logs)
  check('the HTTP status reaches the Host log', result.calls.logs.some((args) => String(args[2]).includes('HTTP 500')), result.calls.logs)
  check('the log names which credential was tried', result.calls.logs.some((args) => String(args[1]).includes('凭据 store')), result.calls.logs)
  check('exactly one request was attempted', sent.length === 1, sent.length)
}
{
  const { result } = await withFetch(() => { throw new Error('socket hang up') }, async () => {
    const { route, calls } = mount({ store: 'sk-x' })
    return { got: await payload(await route.fetch(makeRequest(SAMPLE))), calls }
  })
  check('a transport failure is silent too', result.got.ok === true && result.got.text === '', result.got)
}

console.log('\ncompletion status route')
{
  const { statusRoute } = mount({ store: 'sk-secret-value' })
  const payload = await (await statusRoute.fetch(new Request('http://127.0.0.1/api/code-workbench/completion-status', { method: 'POST' }))).json()
  check('reports FIM mode', payload.mode === 'fim', payload.mode)
  check('reports the endpoint it would use', payload.endpoint === 'https://api.deepseek.com/beta/completions', payload.endpoint)
  check('reports the model', payload.model === 'deepseek-flash', payload.model)
  check('names the credential source', payload.source === 'store', payload.source)
  check('never echoes the credential value', !JSON.stringify(payload).includes('sk-secret-value'), payload)
}
{
  const { statusRoute } = mount({ store: null, account: 'grant' })
  const payload = await (await statusRoute.fetch(new Request('http://127.0.0.1/api/code-workbench/completion-status', { method: 'POST' }))).json()
  check('names the account as the source', payload.source === 'account', payload.source)
}
{
  const { statusRoute } = mount({})
  const payload = await (await statusRoute.fetch(new Request('http://127.0.0.1/api/code-workbench/completion-status', { method: 'POST' }))).json()
  check('reports none when nothing is available', payload.source === 'none', payload.source)
}
{
  const { statusRoute } = mount({ store: 'sk-x', config: { completionBaseUrl: 'not-a-url' } })
  const payload = await (await statusRoute.fetch(new Request('http://127.0.0.1/api/code-workbench/completion-status', { method: 'POST' }))).json()
  check('flags an unusable address', payload.addressValid === false, payload)
}
{
  const { statusRoute } = mount({ unauthorized: true, store: 'sk-x' })
  check('status is authenticated like every other route',
    (await statusRoute.fetch(new Request('http://127.0.0.1/api/code-workbench/completion-status', { method: 'POST' }))).status === 401)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
