/**
 * The two wire shapes this plugin's independent completion route can speak.
 *
 * Both are OpenAI-compatible; they differ in what they ask the model for:
 *
 *   - `chat`: `/chat/completions` with a framed `messages` array. The caret
 *     context travels as JSON inside one user message and the model answers
 *     with prose, so the Host has to instruct it to emit code only.
 *   - `fim`: `/completions` with `prompt` + `suffix` — fill-in-the-middle.
 *     The provider itself knows the prefix/suffix convention, so no framing
 *     and no instruction are needed; the model returns the missing middle.
 *
 * FIM providers disagree on the response field: OpenAI and DeepSeek legacy
 * completions answer with `choices[0].text`, chat-shaped streams carry
 * `choices[0].delta.content`, and Mistral's FIM endpoint documents a
 * chat-shaped `choices[0].message.content`. The reader accepts all three, so
 * one code path serves every documented provider.
 */

/** Refuse a base URL that is not an HTTP(S) address without embedded credentials. */
function parseEndpoint(baseUrl) {
  const endpoint = new URL(baseUrl)
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error('API 地址必须是 HTTP 或 HTTPS 地址，且不能包含用户名或密码')
  return endpoint
}

/** The `/chat/completions` endpoint for one base URL; a full endpoint is kept as typed. */
export function completionEndpoint(baseUrl) {
  const endpoint = parseEndpoint(baseUrl)
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, '')
  if (!endpoint.pathname.endsWith('/chat/completions')) endpoint.pathname += '/chat/completions'
  return endpoint.toString()
}

/**
 * The fill-in-the-middle endpoint for one base URL. A path already ending in
 * `/completions` is kept as typed — that covers the plain OpenAI shape
 * (`…/v1/completions`), DeepSeek's `…/beta/completions`, and Mistral's
 * distinct `…/fim/completions`, which no suffix rule could derive from the
 * host alone. Anything else gains `/completions`, so entering just the
 * service root (`https://api.deepseek.com/beta`) is enough.
 * @param baseUrl - the configured address, root or full endpoint.
 * @returns the absolute FIM endpoint URL.
 * @throws For a non-HTTP(S) address, or one carrying user credentials.
 */
export function fimEndpoint(baseUrl) {
  const endpoint = parseEndpoint(baseUrl)
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, '')
  if (!endpoint.pathname.endsWith('/completions')) endpoint.pathname += '/completions'
  return endpoint.toString()
}

/** The text of one streamed frame, read from whichever field the provider uses. */
function frameText(frame) {
  const choice = frame?.choices?.[0]
  if (choice === undefined || choice === null) return undefined
  if (typeof choice.text === 'string') return choice.text
  const delta = choice.delta?.content
  if (typeof delta === 'string') return delta
  const message = choice.message?.content
  return typeof message === 'string' ? message : undefined
}

/**
 * Split one response body into the payloads of its SSE `data:` events.
 * Comments, other fields and the `[DONE]` sentinel are dropped here, so each
 * caller only has to read frames.
 * @param body - the response body stream.
 * @yields each non-empty data payload, in order.
 */
async function* ssePayloads(body) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let eventData = []
  try {
    for (;;) {
      const { done, value } = await reader.read()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      if (done) buffer += '\n\n'
      let newline
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '')
        buffer = buffer.slice(newline + 1)
        if (line.startsWith('data:')) eventData.push(line.slice(5).trimStart())
        else if (line === '') {
          const data = eventData.join('\n')
          eventData = []
          if (data !== '' && data !== '[DONE]') yield data
        }
      }
      if (done) break
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/** The status-specific guidance on a non-OK response, shared by both shapes. */
function httpFailure(response) {
  const hint = response.status === 429 ? '：请求被限流，请稍后重试'
    : response.status === 401 ? '：请检查 API Key'
      : response.status === 404 ? '：请检查 API 地址（FIM 模式需要该服务的补全端点）'
        : '：请检查 API 地址、模型 ID 和接口参数'
  return new Error(`独立补全 API 返回 HTTP ${response.status}${hint}`)
}

/**
 * Stream one Chat Completions call as text deltas.
 * @param config - `baseUrl` and optional `apiKey`.
 * @param options - `model`, `messages` (one user message carrying the framed
 *   context), `system`, `maxTokens`, `signal`.
 * @yields `{type:'text-delta',text}` frames, then one `{type:'finish'}`.
 */
export async function* streamCompletionApi(config, options) {
  const response = await fetch(completionEndpoint(config.baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}) },
    body: JSON.stringify({ model: options.model, messages: [{ role: 'system', content: options.system }, { role: 'user', content: options.messages[0].content[0].text }], stream: true, max_tokens: options.maxTokens }),
    signal: options.signal,
  })
  if (!response.ok) throw httpFailure(response)
  if (!response.body) throw new Error('独立补全 API 返回空响应')
  for await (const data of ssePayloads(response.body)) {
    const frame = JSON.parse(data)
    if (frame.error) throw new Error('独立补全 API 返回错误，请检查模型和接口配置')
    const text = frame.choices?.[0]?.delta?.content
    if (typeof text === 'string' && text !== '') yield { type: 'text-delta', text }
  }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

/** Sampling temperature for completion: predicting code is not a creative task. */
const FIM_TEMPERATURE = 0.2

/**
 * Stream one fill-in-the-middle completion as text deltas. The prefix and
 * suffix reach the provider as-is — no framing, which is the whole point of
 * the FIM shape.
 * @param config - `baseUrl` and optional `apiKey`.
 * @param options - `model`, `prompt` (code before the caret), optional
 *   `suffix` (code after it), `maxTokens`, `signal`.
 * @yields `{type:'text-delta',text}` frames, then one `{type:'finish'}`.
 */
export async function* streamCompletionFim(config, options) {
  const body = {
    model: options.model,
    prompt: options.prompt,
    max_tokens: options.maxTokens,
    temperature: FIM_TEMPERATURE,
    stream: true,
  }
  if (typeof options.suffix === 'string' && options.suffix !== '') body.suffix = options.suffix
  const response = await fetch(fimEndpoint(config.baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}) },
    body: JSON.stringify(body),
    signal: options.signal,
  })
  if (!response.ok) throw httpFailure(response)
  if (!response.body) throw new Error('独立补全 API 返回空响应')
  for await (const data of ssePayloads(response.body)) {
    const frame = JSON.parse(data)
    if (frame.error) throw new Error('独立补全 API 返回错误，请检查模型和接口配置')
    const text = frameText(frame)
    if (typeof text === 'string' && text !== '') yield { type: 'text-delta', text }
  }
  yield { type: 'finish', reason: { kind: 'stop' } }
}
