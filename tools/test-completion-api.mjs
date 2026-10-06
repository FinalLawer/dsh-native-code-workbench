import assert from 'node:assert/strict'
import { completionEndpoint, streamCompletionApi } from '../dsh-cursor-code/completion-api.mjs'
import { Config, apply } from '../dsh-cursor-code/index.js'

assert.equal(completionEndpoint('https://example.com/v1/'), 'https://example.com/v1/chat/completions')
assert.equal(completionEndpoint('https://example.com/v1/chat/completions'), 'https://example.com/v1/chat/completions')
assert.throws(() => completionEndpoint('file:///tmp/key'))
assert.equal(Config.dict.completionApiKey.meta.role, 'secret')
for (const field of ['completionEnabled', 'completionApiKey', 'completionApiEnabled', 'completionBaseUrl', 'completionApiModel']) assert.equal(Config.dict[field].meta.volatile, true)
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
  const settings = { configure: () => () => {}, describe: () => [{ ns: 'cursor-code', value: { completionApiEnabled: true, completionBaseUrl: 'https://example.com/v1', completionApiModel: 'dedicated', completionApiKey: 'host-key' } }] }
  const scope = { effect: (callback) => callback(), settings, connection: { admit: () => ({}), fetch: { register: (route) => { routes.push(route); return () => {} } } }, tools: { register: () => () => {} }, get: () => undefined }
  apply({ fiber: {}, inject: (names, callback) => callback(scope) }, {})
  const result = await routes.find((route) => route.path.endsWith('/complete')).fetch(new Request('http://localhost/api/cursor-code/complete', { method: 'POST', body: JSON.stringify({ sessionId: 's1', path: 'a.js', prefix: 'const x =' }) }))
  assert.match(await result.text(), /你好/)
  assert.equal(JSON.parse(requested.init.body).model, 'dedicated')
  assert.equal(requested.init.headers.authorization, 'Bearer host-key')
  globalThis.fetch = async () => new Response('secret-provider-details', { status: 401 })
  await assert.rejects(async () => { for await (const chunk of streamCompletionApi({ baseUrl: 'https://example.com/v1' }, options)) {} }, /401.*API Key/)
} finally { globalThis.fetch = originalFetch }
console.log('Independent completion API: ALL PASS')
