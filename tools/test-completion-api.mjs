/**
 * The FIM transport and the Host route that drives it.
 *
 * Two things are pinned here that a mock cannot show: the exact wire shape
 * (endpoint, body fields, authentication header) and the behaviour of the
 * transport against a real socket, where the response body arrives in pieces.
 *
 *   node tools/test-completion-api.mjs
 */
import assert from 'node:assert/strict'
import { ACCOUNT_TOKEN_HEADER, fimEndpoint, completeFim } from '../dsh-code-workbench/completion-api.mjs'
import { Config, apply } from '../dsh-code-workbench/index.js'

// A bare origin carries no path, and the WHATWG URL setter turns an empty
// pathname back into `/`. Deriving the endpoint by read-modify-write on that
// setter therefore used to emit `//completions`. Guard both spellings.
for (const [bare, host] of [['http://127.0.0.1:11434', 'http://127.0.0.1:11434/'], ['https://api.deepseek.com', 'https://api.deepseek.com/']]) {
  assert.equal(fimEndpoint(bare), `${bare}/completions`, `${bare} must not gain a double slash`)
  assert.equal(fimEndpoint(host), `${bare}/completions`, `${host} must not gain a double slash`)
}
// The FIM endpoint derives `/completions` from a service root, keeps a full
// endpoint as typed, and leaves Mistral's distinct `/fim/completions` alone.
assert.equal(fimEndpoint('https://api.deepseek.com/beta'), 'https://api.deepseek.com/beta/completions')
assert.equal(fimEndpoint('https://api.deepseek.com/beta/'), 'https://api.deepseek.com/beta/completions')
assert.equal(fimEndpoint('http://127.0.0.1:11434/v1'), 'http://127.0.0.1:11434/v1/completions')
assert.equal(fimEndpoint('https://api.mistral.ai/v1/fim/completions'), 'https://api.mistral.ai/v1/fim/completions')
assert.equal(fimEndpoint('https://example.com/v1/completions'), 'https://example.com/v1/completions')
assert.throws(() => fimEndpoint('file:///tmp/key'))
assert.throws(() => fimEndpoint('https://user:pass@example.com/v1'))

assert.equal(Config.dict.completionApiKey.meta.role, 'secret')
for (const field of ['completionEnabled', 'completionApiKey', 'completionBaseUrl', 'completionApiModel']) assert.equal(Config.dict[field].meta.volatile, true)
assert.equal(Config.dict.completionBaseUrl.meta.default, 'https://api.deepseek.com/beta')
assert.equal(Config.dict.completionApiModel.meta.default, 'deepseek-flash')

const originalFetch = globalThis.fetch
/** The response body one provider would send for a single completion. */
const reply = (text) => ({ choices: [{ text, index: 0 }] })
/** Replace the global fetch with one that answers `payload` as JSON and records the call. */
function stubFetch(payload) {
  const seen = {}
  globalThis.fetch = async (url, init) => {
    seen.url = url
    seen.init = init
    return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } })
  }
  return seen
}

/** Mount the plugin against a stub Host scope. */
function mountHost(value, overrides = {}) {
  const routes = []
  const scope = {
    effect: (callback) => callback(),
    settings: { configure: () => () => {}, describe: () => [{ ns: 'code-workbench', value }] },
    connection: { admit: () => ({}), fetch: { register: (route) => { routes.push(route); return () => {} } } },
    tools: { register: () => () => {} },
    get: (name) => overrides[name],
  }
  apply({ fiber: {}, inject: (names, callback) => callback(scope) }, {})
  return { route: routes.find((r) => r.path.endsWith('/complete')), statusRoute: routes.find((r) => r.path.endsWith('/completion-status')) }
}

/** POST one completion and return the parsed response body. */
function complete(route, body) {
  return route.fetch(new Request('http://localhost/api/code-workbench/complete', { method: 'POST', body: JSON.stringify(body) })).then((response) => response.json())
}

try {
  // --- the wire shape ----------------------------------------------------
  let request = stubFetch(reply('middle-part'))
  const text = await completeFim({ baseUrl: 'https://api.deepseek.com/beta', apiKey: 'fim-key' },
    { model: 'deepseek-flash', prompt: 'def fib(a):', suffix: '\n return fib(a-1)', maxTokens: 128 })
  assert.equal(text, 'middle-part')
  assert.equal(request.url, 'https://api.deepseek.com/beta/completions')
  assert.equal(request.init.headers.authorization, 'Bearer fim-key')
  const body = JSON.parse(request.init.body)
  assert.equal(body.model, 'deepseek-flash')
  assert.equal(body.prompt, 'def fib(a):')
  assert.equal(body.suffix, '\n return fib(a-1)')
  assert.equal(body.stream, false, 'the transport must not ask for a stream — nothing renders progressively')
  assert.equal(body.temperature, 0.2)
  assert.equal(body.messages, undefined, 'the FIM shape must not send a messages array')

  // The account grant travels under its own header, never as a bearer token.
  request = stubFetch(reply('ok'))
  await completeFim({ baseUrl: 'https://api.deepseek.com/beta', accountToken: 'grant-token' },
    { model: 'deepseek-flash', prompt: 'x', maxTokens: 64 })
  // Assert the absence first: if a grant ever leaked into the bearer slot, that
  // is the dangerous half, so it must be the assertion that reports the failure.
  assert.equal(request.init.headers.authorization, undefined, 'an account grant must not masquerade as a bearer key')
  assert.equal(request.init.headers[ACCOUNT_TOKEN_HEADER], 'grant-token')
  // A bearer key wins when both are somehow supplied.
  request = stubFetch(reply('ok'))
  await completeFim({ baseUrl: 'https://api.deepseek.com/beta', apiKey: 'bearer-key', accountToken: 'grant-token' },
    { model: 'deepseek-flash', prompt: 'x', maxTokens: 64 })
  assert.equal(request.init.headers.authorization, 'Bearer bearer-key')
  assert.equal(request.init.headers[ACCOUNT_TOKEN_HEADER], undefined)

  // Providers disagree on the field: `text`, `message.content` and the
  // streaming-shaped `delta.content` all have to read.
  for (const [label, payload, expected] of [
    ['text', { choices: [{ text: 'from-text', index: 0 }] }, 'from-text'],
    ['message.content', { choices: [{ message: { content: 'from-message' } }] }, 'from-message'],
    ['delta.content', { choices: [{ delta: { content: 'from-delta' } }] }, 'from-delta'],
  ]) {
    stubFetch(payload)
    assert.equal(
      await completeFim({ baseUrl: 'https://api.deepseek.com/beta' }, { model: 'm', prompt: 'x', maxTokens: 8 }),
      expected,
      `a ${label} reply must read`,
    )
  }
  // A body with no usable choice yields empty text rather than failing: "no
  // suggestion" is an ordinary outcome, not an error.
  stubFetch({ choices: [] })
  assert.equal(await completeFim({ baseUrl: 'https://api.deepseek.com/beta' }, { model: 'm', prompt: 'x', maxTokens: 8 }), '')
  stubFetch({ choices: [{ text: '' }] })
  assert.equal(await completeFim({ baseUrl: 'https://api.deepseek.com/beta' }, { model: 'm', prompt: 'x', maxTokens: 8 }), '')

  // The `suffix` key must survive even when empty. Dropping it makes DeepSeek
  // stop treating the body as fill-in-the-middle, and a one-comment file then
  // comes back as training-data prose instead of code — measured 0/4 clean
  // omitted against 8/8 clean as an explicit empty string.
  request = stubFetch(reply('ok'))
  await completeFim({ baseUrl: 'https://api.mistral.ai/v1/fim' }, { model: 'codestral-latest', prompt: 'x', suffix: '', maxTokens: 64 })
  const emptySuffix = JSON.parse(request.init.body)
  assert.ok('suffix' in emptySuffix, 'an empty suffix must still be sent as a key')
  assert.equal(emptySuffix.suffix, '', 'an empty suffix must travel as an empty string')
  // …and a caller that passes no suffix at all gets the same treatment.
  request = stubFetch(reply('ok'))
  await completeFim({ baseUrl: 'https://api.mistral.ai/v1/fim' }, { model: 'codestral-latest', prompt: 'x', maxTokens: 64 })
  assert.equal(JSON.parse(request.init.body).suffix, '', 'a missing suffix must still be sent as an empty string')

  // Cancellation has to reach the socket: the editor aborts the request the
  // moment typing invalidates the suggestion, and a leaked request would keep
  // generating tokens nobody reads.
  {
    const controller = new AbortController()
    let seenSignal
    globalThis.fetch = async (url, init) => { seenSignal = init.signal; return new Response(JSON.stringify(reply('x'))) }
    await completeFim({ baseUrl: 'https://api.deepseek.com/beta' }, { model: 'm', prompt: 'x', maxTokens: 8, signal: controller.signal })
    assert.ok(seenSignal instanceof AbortSignal, 'a request must always carry an abort signal')
    assert.equal(seenSignal.aborted, false)
    controller.abort()
    assert.equal(seenSignal.aborted, true, 'cancelling the caller must abort the in-flight request')
    // With no caller signal the transport still supplies one, so a stalled
    // provider can never hang the route forever.
    globalThis.fetch = async (url, init) => { seenSignal = init.signal; return new Response(JSON.stringify(reply('x'))) }
    await completeFim({ baseUrl: 'https://api.deepseek.com/beta' }, { model: 'm', prompt: 'x', maxTokens: 8 })
    assert.ok(seenSignal instanceof AbortSignal, 'a missing caller signal must not mean no signal at all')
  }

  // A provider-side error object is surfaced, not silently read as empty text.
  stubFetch({ error: { message: 'model not found' } })
  await assert.rejects(
    completeFim({ baseUrl: 'https://api.deepseek.com/beta' }, { model: 'nope', prompt: 'x', maxTokens: 8 }),
    /model not found/,
  )

  // A rejected credential names the reason without leaking the provider body.
  globalThis.fetch = async () => new Response('secret-provider-details', { status: 401 })
  await assert.rejects(
    completeFim({ baseUrl: 'https://api.deepseek.com/beta', apiKey: 'bad' }, { model: 'm', prompt: 'x', maxTokens: 8 }),
    (error) => /401/.test(error.message) && /API Key/.test(error.message) && !/secret-provider-details/.test(error.message),
  )

  // --- the Host route drives it ------------------------------------------
  request = stubFetch(reply('filled'))
  const { route } = mountHost(
    { completionBaseUrl: 'https://api.deepseek.com/beta', completionApiModel: 'deepseek-v4-pro', completionApiKey: 'fim-host-key' },
  )
  assert.deepEqual(await complete(route, { sessionId: 's1', path: 'a.js', prefix: 'const double = xs', suffix: '\nconsole.log(double)' }), { ok: true, text: 'filled' })
  assert.equal(request.url, 'https://api.deepseek.com/beta/completions')
  assert.equal(request.init.headers.authorization, 'Bearer fim-host-key')
  const hostBody = JSON.parse(request.init.body)
  assert.equal(hostBody.prompt, 'const double = xs')
  assert.equal(hostBody.suffix, '\nconsole.log(double)')
  assert.equal(hostBody.messages, undefined)

  // The Host falls back to the credential store when no key is typed.
  request = stubFetch(reply('from store'))
  const stored = mountHost({ completionBaseUrl: 'https://api.deepseek.com/beta' }, {
    credentials: { resolve: async () => ({ value: 'sk-stored', source: 'file' }) },
  })
  assert.equal((await complete(stored.route, { sessionId: 's1', path: 'a.js', prefix: 'const x =' })).text, 'from store')
  assert.equal(request.init.headers.authorization, 'Bearer sk-stored')

  // …and to the signed-in account when the store has nothing.
  request = stubFetch(reply('from account'))
  const accounted = mountHost({ completionBaseUrl: 'https://api.deepseek.com/beta' }, {
    credentials: { resolve: async () => undefined },
    deepseekAccount: { resolveToken: async (url) => (url.startsWith('https://api.deepseek.com') ? 'grant-token' : undefined) },
  })
  assert.equal((await complete(accounted.route, { sessionId: 's1', path: 'a.js', prefix: 'const x =' })).text, 'from account')
  assert.equal(request.init.headers[ACCOUNT_TOKEN_HEADER], 'grant-token')

  // With no credential the route still answers — and answers nothing.
  const empty = mountHost({ completionBaseUrl: 'https://api.deepseek.com/beta' }, { credentials: { resolve: async () => undefined } })
  assert.deepEqual(await complete(empty.route, { sessionId: 's1', path: 'a.js', prefix: 'const x =' }), { ok: true, text: '' })

  // A provider failure answers the same empty body as "no credential", because
  // the person typing cannot act on either. Only the Host log records which.
  globalThis.fetch = async () => { throw new Error('socket hang up') }
  assert.deepEqual(await complete(empty.route, { sessionId: 's1', path: 'a.js', prefix: 'const x =' }), { ok: true, text: '' })

  // A malformed request is the one case that stays an error: it means our own
  // client half is broken, and silence would hide that.
  const badRequest = await route.fetch(new Request('http://localhost/api/code-workbench/complete', { method: 'POST', body: '{"sessionId":"s1","path":"a.js"}' }))
  assert.equal(badRequest.status, 400, 'a missing prefix is our bug, so it must not be silent')

  // The status route names the source and never the value.
  globalThis.fetch = originalFetch
  const statusPayload = await (await mountHost({ completionBaseUrl: 'https://api.deepseek.com/beta' }, {
    credentials: { resolve: async () => ({ value: 'sk-must-not-leak', source: 'file' }) },
  }).statusRoute.fetch(new Request('http://localhost/api/code-workbench/completion-status', { method: 'POST' }))).json()
  assert.equal(statusPayload.mode, 'fim')
  assert.equal(statusPayload.endpoint, 'https://api.deepseek.com/beta/completions')
  assert.equal(statusPayload.source, 'store')
  assert.ok(!JSON.stringify(statusPayload).includes('sk-must-not-leak'), 'the status payload must never carry the credential')
} finally { globalThis.fetch = originalFetch }
console.log('FIM completion API: ALL PASS')

// ── Real-socket round trip ─────────────────────────────────────────────────
// The suite above stubs `fetch`, so it never exercises real HTTP. Two things
// only a socket can show: that a bare origin really produces a single-slash
// request line, and that a response body split across TCP reads still parses.
// The server writes the JSON in deliberately awkward pieces — mid-key, mid-
// value, and one byte at a time — which is the only way to prove that.
{
  const http = await import('node:http')
  const payload = JSON.stringify({ choices: [{ text: '  const sum = 1', index: 0 }] })
  const pieces = [...payload.slice(0, 12), ...payload.slice(12, 30), ...payload.slice(30)]
  const received = []
  let seenBody = ''

  const server = http.createServer((request, response) => {
    received.push(request.url)
    request.on('data', (chunk) => { seenBody += chunk })
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' })
      let index = 0
      const tick = () => {
        if (index >= pieces.length) { response.end(); return }
        response.write(pieces[index++])
        setTimeout(tick, 1)
      }
      tick()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`

  try {
    const text = await completeFim({ baseUrl: base, apiKey: 'k' }, { model: 'm', prompt: 'p', suffix: 's', maxTokens: 8 })
    assert.equal(text, '  const sum = 1', 'a JSON body split across socket writes must reassemble')
    // A bare origin must have produced `/completions`, not `//completions`.
    assert.deepEqual(received, ['/completions'], 'the bare origin must derive a single-slash path')
    const sent = JSON.parse(seenBody)
    assert.equal(sent.prompt, 'p', 'the caret context must survive the real socket')
    assert.equal(sent.suffix, 's')
    assert.equal(sent.stream, false)
  } finally {
    server.close()
  }
  console.log('Real-socket round trip: ALL PASS')
}
