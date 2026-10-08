/**
 * The one wire shape this plugin speaks: fill-in-the-middle completion.
 *
 * `POST {base}/completions` with `prompt` + `suffix` — the provider receives
 * the caret's two sides and returns what belongs between them. Because the FIM
 * convention belongs to the model rather than to us, no framing and no
 * instruction prompt are needed: the answer is already code.
 *
 * Both halves must be *present* on the wire. An empty `suffix` still travels as
 * `suffix: ""`; omitting the key entirely silently downgrades the request to
 * plain continuation and the model answers with training-data prose instead of
 * code. See the note in {@link completeFim} for the measurement.
 *
 * The call is **not streamed**, deliberately. Ghost text is only ever shown as
 * a finished suggestion — Monaco's inline-completions provider answers once and
 * cannot revise an item it has already returned — so streaming would buy
 * nothing while costing an SSE parser and a frame protocol. Measured against
 * the live endpoint, the two are indistinguishable inside network jitter.
 * What actually dominates the wait is time-to-first-token (400–800 ms of
 * network and server queueing), not the length of the generated text.
 *
 * FIM providers disagree on the response field: OpenAI and DeepSeek legacy
 * completions answer with `choices[0].text`, chat-shaped replies carry
 * `choices[0].message.content`, and a few proxies still answer with the
 * streaming shape `choices[0].delta.content`. The reader accepts all three, so
 * one code path serves every documented provider.
 *
 * Authentication has two shapes. A DeepSeek platform key travels as
 * `Authorization: Bearer`, which is what the public FIM endpoint documents. A
 * DSH account grant travels as the private `x-dsh-auth-token` header instead:
 * it is a platform grant rather than an API key, and the account service only
 * releases one for the inference origin it trusts.
 */

/** Refuse a base URL that is not an HTTP(S) address without embedded credentials. */
function parseEndpoint(baseUrl) {
  const endpoint = new URL(baseUrl)
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error('API 地址必须是 HTTP 或 HTTPS 地址，且不能包含用户名或密码')
  return endpoint
}

/**
 * Append one endpoint suffix to a base path, tolerating a bare origin.
 *
 * The path is normalised in a local variable rather than by writing back to
 * `url.pathname`. Assigning an empty string to that setter is silently undone
 * by the WHATWG URL parser, which stores it as `/` — so a read-modify-write
 * (`url.pathname += suffix`) would reintroduce the slash and yield
 * `//completions` for a base URL that carries no path at all.
 * @param endpoint - the parsed base URL, mutated in place.
 * @param suffix - the endpoint suffix to guarantee, e.g. `/completions`.
 */
function appendEndpoint(endpoint, suffix) {
  let path = endpoint.pathname.replace(/\/+$/, '')
  if (!path.endsWith(suffix)) path += suffix
  endpoint.pathname = path
}

/**
 * The fill-in-the-middle endpoint for one base URL. A path already ending in
 * `/completions` is kept as typed — that covers the plain OpenAI shape
 * (`…/v1/completions`), DeepSeek's `…/beta/completions`, and Mistral's
 * distinct `…/fim/completions`, which no suffix rule could derive from the
 * host alone. Anything else gains `/completions`, so entering just the service
 * root (`https://api.deepseek.com/beta`) is enough.
 * @param baseUrl - the configured address, root or full endpoint.
 * @returns the absolute FIM endpoint URL.
 * @throws For a non-HTTP(S) address, or one carrying user credentials.
 */
export function fimEndpoint(baseUrl) {
  const endpoint = parseEndpoint(baseUrl)
  appendEndpoint(endpoint, '/completions')
  return endpoint.toString()
}

/** How long one completion may take before it is abandoned. */
const COMPLETION_TIMEOUT_MS = 10_000

/** Sampling temperature for completion: predicting code is not a creative task. */
const FIM_TEMPERATURE = 0.2

/**
 * The header carrying a DSH account grant. The account service issues a
 * platform grant rather than a DeepSeek platform key, and the official
 * provider sends it under this private header instead of `Authorization`.
 */
export const ACCOUNT_TOKEN_HEADER = 'x-dsh-auth-token'

/**
 * The completion text inside one successful response, read from whichever
 * field the provider uses.
 * @param frame - the parsed response body.
 * @returns the text, or undefined when the body carries none.
 */
function completionText(frame) {
  const choice = frame?.choices?.[0]
  if (choice === undefined || choice === null) return undefined
  if (typeof choice.text === 'string') return choice.text
  const message = choice.message?.content
  if (typeof message === 'string') return message
  const delta = choice.delta?.content
  return typeof delta === 'string' ? delta : undefined
}

/** The status-specific guidance on a non-OK response. */
function httpFailure(response) {
  const hint = response.status === 429 ? '：请求被限流，请稍后重试'
    : response.status === 401 ? '：请检查 API Key'
      : response.status === 403 ? '：凭据被拒绝，请确认它有权访问补全接口'
        : response.status === 404 ? '：请检查 API 地址（需要该服务的补全端点）'
          : '：请检查 API 地址、模型 ID 和接口参数'
  return new Error(`补全 API 返回 HTTP ${response.status}${hint}`)
}

/**
 * The authentication headers for one call, preferring an explicit key.
 * @param config - `apiKey` (bearer) or `accountToken` (private header).
 * @returns the header fragment, empty when neither is present.
 */
function authHeaders(config) {
  if (typeof config.apiKey === 'string' && config.apiKey !== '') return { authorization: `Bearer ${config.apiKey}` }
  if (typeof config.accountToken === 'string' && config.accountToken !== '') return { [ACCOUNT_TOKEN_HEADER]: config.accountToken }
  return {}
}

/**
 * One fill-in-the-middle completion, answered in a single response. The prefix
 * and suffix reach the provider as-is — no framing, which is the whole point of
 * the FIM shape.
 *
 * The caller's `signal` is combined with a hard timeout: a completion is a
 * short auxiliary call, so one that has not answered in {@link
 * COMPLETION_TIMEOUT_MS} is not going to be useful even if it eventually does.
 * @param config - `baseUrl`, plus exactly one of `apiKey` or `accountToken`.
 * @param options - `model`, `prompt` (code before the caret), optional
 *   `suffix` (code after it), `maxTokens`, `signal`.
 * @returns the completion text, possibly empty.
 * @throws When the address is unusable, the request fails, or the provider
 *   answers with an error.
 */
export async function completeFim(config, options) {
  const body = {
    model: options.model,
    prompt: options.prompt,
    // The `suffix` key must ALWAYS be present, even when it is empty. DeepSeek
    // routes on the shape of the body: drop the key and the request stops
    // reading as fill-in-the-middle and degrades to plain continuation, so a
    // prompt like `# 写一个函数，判断一个数是否是素数` comes back as the Chinese
    // tutorial page the model was trained on ("时间: … 浏览: …", markdown
    // fences, the lot) instead of Python. Measured 0/4 clean with the key
    // omitted against 8/8 clean with an explicit empty string.
    suffix: typeof options.suffix === 'string' ? options.suffix : '',
    max_tokens: options.maxTokens,
    temperature: FIM_TEMPERATURE,
    stream: false,
  }

  const signal = options.signal === undefined
    ? AbortSignal.timeout(COMPLETION_TIMEOUT_MS)
    : AbortSignal.any([options.signal, AbortSignal.timeout(COMPLETION_TIMEOUT_MS)])

  const response = await fetch(fimEndpoint(config.baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(config) },
    body: JSON.stringify(body),
    signal,
  })
  if (!response.ok) throw httpFailure(response)

  const payload = await response.json().catch(() => undefined)
  if (payload === undefined) throw new Error('补全 API 返回的不是 JSON')
  if (payload.error) throw new Error(`补全 API 返回错误：${payload.error.message ?? '请检查模型和接口配置'}`)
  return completionText(payload) ?? ''
}
