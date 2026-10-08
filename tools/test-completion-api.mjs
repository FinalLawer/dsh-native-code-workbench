import assert from 'node:assert/strict'
import { completionEndpoint, fimEndpoint, streamCompletionApi, streamCompletionFim } from '../dsh-code-workbench/completion-api.mjs'
import { Config, apply } from '../dsh-code-workbench/index.js'

assert.equal(completionEndpoint('https://example.com/v1/'), 'https://example.com/v1/chat/completions')
assert.equal(completionEndpoint('https://example.com/v1/chat/completions'), 'https://example.com/v1/chat/completions')
assert.throws(() => completionEndpoint('file:///tmp/key'))
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
for (const field of ['completionEnabled', 'completionApiKey', 'completionApiEnabled', 'completionApiStyle', 'completionBaseUrl', 'completionApiModel']) assert.equal(Config.dict[field].meta.volatile, true)
assert.equal(Config.dict.completionApiStyle.meta.default, 'chat')
const originalFetch = globalThis.fetch
let requested
const options = { model: 'fast-model', system: 'Complete code', maxTokens: 128, messages: [{ role: 'user', content: [{ type: 'text', text: 'const x =' }] }] }
try {
  globalThis.fetch = async (url, init) => {
    requested = { url, init }
    const encoder = new TextEncoder()
    const frames = 'data: {"choices":[{"delta":{"content":"你好"}}]}\r\n\r\ndata: [DONE]\r\n\r\n'
    const bytes = encoder.encode(frames)
    return new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close() } }))
  }
  const chunks = []
  for await (const chunk of streamCompletionApi({ baseUrl: 'https://example.com/v1', apiKey: 'test-key' }, options)) chunks.push(chunk)
  assert.equal(chunks[0].text, '你好')
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.equal(requested.init.headers.authorization, 'Bearer test-key')
  assert.equal(JSON.parse(requested.init.body).model, 'fast-model')
  const routes = []
  const settings = { configure: () => () => {}, describe: () => [{ ns: 'code-workbench', value: { completionApiEnabled: true, completionBaseUrl: 'https://example.com/v1', completionApiModel: 'dedicated', completionApiKey: 'host-key' } }] }
  const scope = { effect: (callback) => callback(), settings, connection: { admit: () => ({}), fetch: { register: (route) => { routes.push(route); return () => {} } } }, tools: { register: () => () => {} }, get: () => undefined }
  apply({ fiber: {}, inject: (names, callback) => callback(scope) }, {})
  const result = await routes.find((route) => route.path.endsWith('/complete')).fetch(new Request('http://localhost/api/code-workbench/complete', { method: 'POST', body: JSON.stringify({ sessionId: 's1', path: 'a.js', prefix: 'const x =' }) }))
  assert.match(await result.text(), /你好/)
  assert.equal(JSON.parse(requested.init.body).model, 'dedicated')
  assert.equal(requested.init.headers.authorization, 'Bearer host-key')
  globalThis.fetch = async () => new Response('secret-provider-details', { status: 401 })
  await assert.rejects(async () => { for await (const chunk of streamCompletionApi({ baseUrl: 'https://example.com/v1' }, options)) {} }, /401.*API Key/)

  // --- FIM shape ---------------------------------------------------------
  let fimRequest
  globalThis.fetch = async (url, init) => {
    fimRequest = { url, init }
    const encoder = new TextEncoder()
    // The legacy completions shape: the text rides `choices[0].text`.
    const frames = 'data: {"choices":[{"text":"middle","index":0}]}\n\ndata: {"choices":[{"text":"-part","index":0}]}\n\ndata: [DONE]\n\n'
    const bytes = encoder.encode(frames)
    return new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close() } }))
  }
  const fimChunks = []
  for await (const chunk of streamCompletionFim({ baseUrl: 'https://api.deepseek.com/beta', apiKey: 'fim-key' },
    { model: 'deepseek-v4-pro', prompt: 'def fib(a):', suffix: '\n return fib(a-1)', maxTokens: 128 })) fimChunks.push(chunk)
  assert.equal(fimChunks.map((chunk) => chunk.text ?? '').join(''), 'middle-part')
  assert.equal(fimChunks.at(-1).reason.kind, 'stop')
  assert.equal(fimRequest.url, 'https://api.deepseek.com/beta/completions')
  assert.equal(fimRequest.init.headers.authorization, 'Bearer fim-key')
  const fimBody = JSON.parse(fimRequest.init.body)
  assert.equal(fimBody.model, 'deepseek-v4-pro')
  assert.equal(fimBody.prompt, 'def fib(a):')
  assert.equal(fimBody.suffix, '\n return fib(a-1)')
  assert.equal(fimBody.stream, true)
  assert.equal(fimBody.temperature, 0.2)
  assert.equal(fimBody.messages, undefined, 'the FIM shape must not send a messages array')

  // A chat-shaped stream (Mistral documents `message.content`) reads too.
  globalThis.fetch = async () => {
    const bytes = new TextEncoder().encode('data: {"choices":[{"message":{"content":"shaped"}}]}\n\ndata: [DONE]\n\n')
    return new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close() } }))
  }
  const shaped = []
  for await (const chunk of streamCompletionFim({ baseUrl: 'https://api.mistral.ai/v1/fim' }, { model: 'codestral-latest', prompt: 'x', maxTokens: 64 })) shaped.push(chunk)
  assert.equal(shaped.map((chunk) => chunk.text ?? '').join(''), 'shaped')
  // An omitted suffix must not be sent as an empty string.
  globalThis.fetch = async (url, init) => {
    fimRequest = { url, init }
    return new Response(new ReadableStream({ start(controller) { controller.close() } }))
  }
  for await (const chunk of streamCompletionFim({ baseUrl: 'https://api.mistral.ai/v1/fim' }, { model: 'codestral-latest', prompt: 'x', suffix: '', maxTokens: 64 })) void chunk
  assert.equal(JSON.parse(fimRequest.init.body).suffix, undefined)

  // The Host routes to FIM when the style says so and hands it the two sides.
  globalThis.fetch = async (url, init) => {
    fimRequest = { url, init }
    const bytes = new TextEncoder().encode('data: {"choices":[{"text":"filled"}]}\n\ndata: [DONE]\n\n')
    return new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close() } }))
  }
  const fimRoutes = []
  const fimSettings = { configure: () => () => {}, describe: () => [{ ns: 'code-workbench', value: { completionApiEnabled: true, completionApiStyle: 'fim', completionBaseUrl: 'https://api.deepseek.com/beta', completionApiModel: 'deepseek-v4-pro', completionApiKey: 'fim-host-key' } }] }
  const fimScope = { effect: (callback) => callback(), settings: fimSettings, connection: { admit: () => ({}), fetch: { register: (route) => { fimRoutes.push(route); return () => {} } } }, tools: { register: () => () => {} }, get: () => undefined }
  apply({ fiber: {}, inject: (names, callback) => callback(fimScope) }, {})
  const fimResult = await fimRoutes.find((route) => route.path.endsWith('/complete')).fetch(new Request('http://localhost/api/code-workbench/complete', { method: 'POST', body: JSON.stringify({ sessionId: 's1', path: 'a.js', prefix: 'const double = xs', suffix: '\nconsole.log(double)' }) }))
  assert.match(await fimResult.text(), /filled/)
  assert.equal(fimRequest.url, 'https://api.deepseek.com/beta/completions')
  assert.equal(fimRequest.init.headers.authorization, 'Bearer fim-host-key')
  const hostFimBody = JSON.parse(fimRequest.init.body)
  assert.equal(hostFimBody.prompt, 'const double = xs')
  assert.equal(hostFimBody.suffix, '\nconsole.log(double)')
  assert.equal(hostFimBody.messages, undefined)
} finally { globalThis.fetch = originalFetch }
console.log('Independent completion API: ALL PASS')
