#!/usr/bin/env node
/**
 * FIM 形态验证镜像（本地）。
 *
 * 用途：确证插件实际发出的请求**确实是 FIM**，而不是别的形态。
 * 它不转发到任何上游 —— 收到请求只做三件事：
 *   1. 打印请求的**真实形状**（路径、体内字段、认证头、是否要求流式）；
 *   2. 判定 FIM / chat，并给出判据；
 *   3. 回一段合法的 JSON，让编辑器真的弹出幽灵补全。
 *
 * 这样即使没有有效 API Key、也不联外网，也能端到端确证走的是哪条路。
 * chat 形态的代码已经删掉了，所以这里出现 CHAT 判定就说明有东西被改回去了。
 *
 * 用法：
 *   node tools/fim-mock-server.mjs            # 默认 127.0.0.1:8788
 *   PORT=9000 node tools/fim-mock-server.mjs  # 换端口
 *
 * 然后把插件设置（DSH 设置 → 代码工作台）改为：
 *   启用 Tab 补全        ✅
 *   补全接口地址         http://127.0.0.1:8788
 *   补全模型            任意（例如 deepseek-flash）
 *   补全 API Key        留空也能跑（镜像只看有没有认证头）
 */

import http from 'node:http'

const PORT = Number(process.env.PORT ?? 8788)
const HOST = '127.0.0.1'

const ESC = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
}

const paint = (color, text) => `${color}${text}${ESC.reset}`
const line = (char = '─', width = 62) => char.repeat(width)

/** Mask a bearer token down to something safe to print. */
function maskAuth(header) {
  if (typeof header !== 'string' || header === '') return '（无认证头）'
  const token = header.replace(/^Bearer\s+/i, '')
  if (token === header) return `${header.slice(0, 12)}…`
  if (token.length <= 12) return `Bearer ${token.slice(0, 4)}…`
  return `Bearer ${token.slice(0, 6)}…${token.slice(-4)}`
}

/** How the call authenticated: a bearer key, a DSH account grant, or nothing. */
function describeAuth(headers) {
  if (typeof headers.authorization === 'string' && headers.authorization !== '') {
    return `${maskAuth(headers.authorization)} ${paint(ESC.dim, '（Authorization: Bearer —— API Key 路）')}`
  }
  const grant = headers['x-dsh-auth-token']
  if (typeof grant === 'string' && grant !== '') {
    return `${paint(ESC.dim, `x-dsh-auth-token ${grant.slice(0, 4)}…（DSH 账号授权路）`)}`
  }
  return paint(ESC.dim, '（无认证头 —— 本地服务可以不带）')
}

/**
 * Decide which wire shape this body is, with the reason.
 * @param body - parsed request body, or null when it was not JSON.
 */
function classify(body) {
  if (body === null) return { shape: 'unknown', why: '请求体不是合法 JSON' }
  const hasMessages = Array.isArray(body.messages)
  const hasPrompt = typeof body.prompt === 'string'
  if (hasMessages && hasPrompt) return { shape: 'ambiguous', why: '同时出现 messages 和 prompt' }
  if (hasPrompt) return { shape: 'fim', why: '体内有 prompt 字段（FIM 形态）' }
  if (hasMessages) return { shape: 'chat', why: '体内有 messages 数组（chat 形态）' }
  return { shape: 'unknown', why: '既无 prompt 也无 messages' }
}

let count = 0

const server = http.createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')

  let body = null
  try {
    body = JSON.parse(raw)
  } catch {
    /* keep null — classify() reports it */
  }

  const { shape, why } = classify(body)
  count += 1

  const fields = body === null ? [] : Object.keys(body)
  const isFim = shape === 'fim'
  const verdict = isFim
    ? paint(ESC.green + ESC.bold, '✅  FIM 形态')
    : shape === 'chat'
      ? paint(ESC.red + ESC.bold, '❌  CHAT 形态（不是 FIM —— chat 通道已删除，这说明有东西被改回去了）')
      : paint(ESC.yellow + ESC.bold, `⚠️  无法判定（${shape}）`)

  console.log()
  console.log(paint(ESC.cyan, `┌─ 第 ${count} 次请求 ${line('─', 62 - `┌─ 第 ${count} 次请求 `.length)}`))
  console.log(`│ ${paint(ESC.bold, `${request.method} ${request.url}`)}`)
  console.log(`│ 判定     ${verdict}`)
  console.log(`│ 判据     ${why}`)
  console.log(`│ 体内字段 ${fields.length > 0 ? fields.join(', ') : paint(ESC.dim, '（空）')}`)
  console.log(`│ 模型     ${body?.model ?? paint(ESC.dim, '—')}`)
  console.log(`│ 认证     ${describeAuth(request.headers)}`)
  if (isFim) {
    const suffix = typeof body.suffix === 'string' ? `有（${body.suffix.length} 字符）` : '无（已省略该字段）'
    console.log(`│ prompt   ${String(body.prompt ?? '').length} 字符`)
    console.log(`│ suffix   ${suffix}`)
    console.log(`│ 温度     ${body.temperature ?? '—'}`)
    // The plugin never streams. A `true` here means the transport regressed,
    // and it is worth saying so loudly rather than printing a bare value.
    console.log(`│ 流式     ${body.stream === false
      ? paint(ESC.green, 'false ✅（一次响应，符合预期）')
      : paint(ESC.yellow + ESC.bold, `${body.stream} ⚠️（预期 false）`)}`)
  }
  console.log(`│ ${paint(ESC.dim, '对照：FIM → /completions + prompt/suffix；chat → /chat/completions + messages')}`)
  console.log(paint(ESC.cyan, `└${line('─', 63)}`))

  // One JSON body, not a stream — that is the shape the plugin now reads.
  const placeholder = '  // ← 这条补全由本地镜像返回，证明请求确实走的是 FIM 端点'
  const payload = {
    id: `mock-${count}`,
    object: 'text_completion',
    model: body?.model ?? 'mock',
    choices: [{ index: 0, text: placeholder, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  }

  response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(payload))
})

server.listen(PORT, HOST, () => {
  console.log(paint(ESC.cyan, line('═')))
  console.log(paint(ESC.bold, '  FIM 形态验证镜像'))
  console.log(paint(ESC.cyan, line('═')))
  console.log()
  console.log(`  监听        ${paint(ESC.bold, `http://${HOST}:${PORT}`)}`)
  console.log(`  上游转发    ${paint(ESC.yellow, '无（纯本地，不需要有效 Key，不联网）')}`)
  console.log()
  console.log('  请在 DSH 设置 → 代码工作台里填：')
  console.log(`    ${paint(ESC.green, '✅')} 启用 Tab 补全`)
  console.log(`    补全接口地址   ${paint(ESC.bold, `http://${HOST}:${PORT}`)}   ${paint(ESC.dim, '（会自动补 /completions）')}`)
  console.log(`    补全模型       任意（例如 deepseek-flash）`)
  console.log(`    补全 API Key   ${paint(ESC.dim, '可留空')}`)
  console.log()
  console.log('  然后到代码里敲一下触发补全，这里就会打印真实请求形状。')
  console.log(paint(ESC.dim, '  Ctrl+C 退出。'))
  console.log()
})
