export function completionEndpoint(baseUrl) {
  const endpoint = new URL(baseUrl)
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error('API 地址必须是 HTTP 或 HTTPS 地址，且不能包含用户名或密码')
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, '')
  if (!endpoint.pathname.endsWith('/chat/completions')) endpoint.pathname += '/chat/completions'
  return endpoint.toString()
}

export async function* streamCompletionApi(config, options) {
  const response = await fetch(completionEndpoint(config.baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}) },
    body: JSON.stringify({ model: options.model, messages: [{ role: 'system', content: options.system }, { role: 'user', content: options.messages[0].content[0].text }], stream: true, max_tokens: options.maxTokens }),
    signal: options.signal,
  })
  if (!response.ok) throw new Error(`独立补全 API 返回 HTTP ${response.status}${response.status === 429 ? '：请求被限流，请稍后重试' : response.status === 401 ? '：请检查 API Key' : '：请检查 API 地址、模型 ID 和接口参数'}`)
  if (!response.body) throw new Error('独立补全 API 返回空响应')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let eventData = []
  const parseEvent = () => {
    const data = eventData.join('\n')
    eventData = []
    if (!data || data === '[DONE]') return null
    const frame = JSON.parse(data)
    if (frame.error) throw new Error('独立补全 API 返回错误，请检查模型和接口配置')
    return frame.choices?.[0]?.delta?.content
  }
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
          const text = parseEvent()
          if (typeof text === 'string' && text !== '') yield { type: 'text-delta', text }
        }
      }
      if (done) break
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
