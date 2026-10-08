/**
 * dsh-code-workbench — Host half.
 *
 * The one mutation path of the plugin: `POST /api/code-workbench/write`, a
 * version-guarded workspace file write. Everything else the panel does is
 * read-only through the shipped `ctx.remote.workspaceFiles`.
 *
 * Every mechanism here is the shipped one:
 *  - routing + authentication → `ctx.connection.fetch.register` — the same seam
 *    `/api/file` (`dsh-api-session-controller`) and the session-log export use;
 *    the Connection service supplies the Host/Origin fence and the signed
 *    browser cookie, and this handler re-checks admission defensively.
 *  - the write itself → `ctx.fs.writeText(target, text, intent)` with a
 *    `{ kind: 'replaceIfVersion', version }` intent, so a concurrent change on
 *    disk fails with `FS_STALE_VERSION` instead of silently clobbering it.
 *  - the workspace root → the Session header (`sessions.get(id).header.cwd`),
 *    the same scope derivation `dsh-api-workspace-files` uses; writes are
 *    confined to that root with `fs.contains`.
 *  - traceability → each accepted write records a Session remark through
 *    `sessionFeedback.record`, so the edit is visible in the session record
 *    even though a human (not the agent) performed it.
 *
 * @module dsh-code-workbench
 */

// Vendored: @deepseek-ai/schemastery 3.18.4 (+ @deepseek-ai/cosmokit), both MIT.
// Bundled by esbuild so the installed package has zero runtime dependencies —
// no registry fetch can fail behind a restrictive network.
import z from './vendor/schemastery.mjs'
import * as disk from 'node:fs/promises'
import { completionEndpoint, fimEndpoint, streamCompletionApi, streamCompletionFim } from './completion-api.mjs'

export const Config = z.object({
  autoSave: z.boolean().default(false).volatile(),
  completionEnabled: z.boolean().default(true).volatile(),
  completionProvider: z.string().default('').volatile(),
  completionModel: z.string().default('').volatile(),
  completionApiEnabled: z.boolean().default(false).volatile(),
  completionApiStyle: z.string().default('chat').volatile(),
  completionBaseUrl: z.string().default('').volatile(),
  completionApiKey: z.string().default('').role('secret').volatile(),
  completionApiModel: z.string().default('').volatile(),
})

/** Refuse absurd payloads early; the editor sends ordinary source files. */
const MAX_TEXT_CHARS = 8 * 1024 * 1024
/** Route this half owns. The client half posts to the exact same string. */
const WRITE_PATH = '/api/code-workbench/write'
/** The codebase search route (@codebase retrieval). */
const SEARCH_PATH = '/api/code-workbench/search'
/** The save journal (save checkpoints): list and roll back saves. */
const HISTORY_PATH = '/api/code-workbench/history'
const ROLLBACK_PATH = '/api/code-workbench/rollback'
/** Journal caps: entries retained per file and bytes retained per side. */
const JOURNAL_CAPS = { perFile: 20, sideChars: 200_000 }
/** In-memory save journal: every accepted write keeps its before/after for rollback. */
const journal = new Map() // `${sessionId}\0${path}` -> entries, newest first

/** Record one accepted write in the journal. */
function journalWrite(sessionId, path, note, outcome, text) {
  const key = `${sessionId}\u0000${path}`
  const entries = journal.get(key) ?? []
  const before = outcome.before === null || outcome.before === undefined
    ? null
    : String(outcome.before).slice(0, JOURNAL_CAPS.sideChars)
  entries.unshift({
    id: `${Date.now()}-${entries.length}-${Math.random().toString(36).slice(2, 8)}`,
    at: Date.now(),
    operation: outcome.operation,
    note: typeof note === 'string' ? note.slice(0, 300) : '',
    version: outcome.version,
    before,
    beforeTruncated: before !== null && String(outcome.before).length > JOURNAL_CAPS.sideChars,
    lines: text.split('\n').length,
  })
  while (entries.length > JOURNAL_CAPS.perFile) entries.pop()
  journal.set(key, entries)
}
/** The Tab-completion route: short ghost-text continuations at the caret. */
const COMPLETE_PATH = '/api/code-workbench/complete'
/** Caps on one completion request. */
const COMPLETE_CAPS = { prefix: 3200, suffix: 900, maxTokens: 128 }

/**
 * The Tab-completion contract: a minimal continuation at the caret, never a
 * restatement of what is already there.
 */
const COMPLETE_SYSTEM = [
  'The user is typing code in an editor. Given the code before the caret and the code after it, output ONLY the code to insert exactly at the caret to continue naturally.',
  'Usually finish the current line or a small block — a few lines at most. Match the surrounding style and indentation.',
  'Output no explanations, no Markdown fences, and never repeat code that is already present before or after the caret.',
].join('\n')
/** Caps keeping one search bounded on a pathological tree. */
const SEARCH_CAPS = {
  files: 4000,
  depth: 12,
  fileBytes: 1_000_000,
  matches: 300,
  lineChars: 4000,
  budgetMs: 4000,
  queryChars: 500,
}

/** Directory names never worth walking into. */
const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', '.cache', '.next', '.nuxt', '.output',
  'dist', 'build', 'out', 'target', 'coverage', '__pycache__', '.venv', 'venv',
  '.idea', '.vscode', '.turbo', '.pnpm-store',
])

/** File extensions that are never text source. */
const IGNORED_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.pdf', '.zip',
  '.gz', '.tar', '.7z', '.rar', '.exe', '.dll', '.so', '.dylib', '.node',
  '.woff', '.woff2', '.ttf', '.eot', '.otf', '.mp3', '.mp4', '.mov', '.avi',
  '.class', '.jar', '.pyc', '.pyo', '.obj', '.o', '.a', '.lib', '.wasm',
  '.db', '.sqlite', '.lock',
])

/** JSON response helper. */
function json(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * Handle one write request.
 * @param scope - injected Host services (`connection`, `fs`, `sessions`).
 * @param request - the buffered Fetch request the Connection dispatched.
 * @returns the JSON outcome.
 */
async function handleWrite(scope, request) {
  // Defense in depth: the shared /api channel already admitted the request, but
  // a mutation endpoint re-checks rather than assumes.
  const admission = scope.connection.admit(request)
  if ('rejection' in admission) return json(admission.rejection, { ok: false, error: { code: 'UNAUTHORIZED' } })

  let body
  try {
    body = await request.json()
  } catch {
    return json(400, { ok: false, error: { code: 'BAD_REQUEST', message: 'body must be JSON' } })
  }
  const { sessionId, path, text, expectedVersion } = body ?? {}
  if (typeof sessionId !== 'string' || sessionId === '') return json(400, { ok: false, error: { code: 'BAD_REQUEST', message: 'sessionId is required' } })
  if (typeof path !== 'string' || path === '') return json(400, { ok: false, error: { code: 'BAD_REQUEST', message: 'path is required' } })
  if (typeof text !== 'string') return json(400, { ok: false, error: { code: 'BAD_REQUEST', message: 'text is required' } })
  if (text.length > MAX_TEXT_CHARS) return json(413, { ok: false, error: { code: 'TOO_LARGE', message: `text exceeds ${MAX_TEXT_CHARS} chars` } })

  // Scope: the Session's workspace root, exactly as workspace-files derives it.
  const session = scope.sessions.get(sessionId)
  const header = session?.header
  const workspaceRoot = header?.cwd ?? scope.get('sandboxPolicy')?.workspaceRoot
  if (typeof workspaceRoot !== 'string' || workspaceRoot === '') {
    return json(404, { ok: false, error: { code: 'UNKNOWN_SESSION', message: 'session has no workspace root' } })
  }

  try {
    const rootTarget = await scope.fs.resolve(workspaceRoot)
    const target = await scope.fs.resolve(path, { cwd: workspaceRoot })
    if (!scope.fs.contains(rootTarget, target)) {
      return json(403, { ok: false, error: { code: 'OUTSIDE_WORKSPACE', message: 'path is outside the session workspace' } })
    }

    // Version guard. The editor hands back the version its read observed; a
    // write with no observed version is guarded against whatever is on disk now
    // (or created when the file is absent).
    let intent
    if (expectedVersion !== undefined && expectedVersion !== null) {
      intent = { kind: 'replaceIfVersion', version: expectedVersion }
    } else {
      const info = await scope.fs.stat(target)
      intent = info === undefined ? { kind: 'createIfAbsent' } : { kind: 'replaceIfVersion', version: info.version }
    }

    // The sandbox fence. `dsh-tool-fs` stamps every mutation with the session's
    // standing policy (`sandboxPolicy.resolve({ session })` — mode plus the
    // session cwd as workspace root); without it `ctx.fs.writeText` falls back
    // to the deployment policy and denies with FS_SANDBOX_DENIED.
    const sandboxPolicy = scope.get('sandboxPolicy')?.resolve({ session })

    const outcome = await scope.fs.writeText(target, text, intent, undefined, sandboxPolicy)

    // Traceability: the session record shows the edit even though the agent did
    // not perform it. Fire-and-forget; a remark failure must not fail the save.
    const note = typeof body?.note === 'string' && body.note !== '' ? body.note.slice(0, 300) : ''
    journalWrite(sessionId, path, note, outcome, text)
    try {
      scope.get('sessionFeedback')?.record({
        sessionId,
        text: `[code-workbench] 手动保存 ${path}（${outcome.operation}，${text.split('\n').length} 行）${note === '' ? '' : ` — ${note}`}`,
      })
    } catch { /* remark is best-effort */ }

    return json(200, { ok: true, version: outcome.version, operation: outcome.operation })
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : 'FS_IO_ERROR'
    const status = code === 'FS_STALE_VERSION' ? 409
      : code === 'FS_SANDBOX_DENIED' ? 403
        : code === 'FS_NOT_FOUND' ? 404
          : code === 'FS_TOO_LARGE' || code === 'FS_NOT_TEXT' ? 413
            : 500
    return json(status, { ok: false, error: { code, message: error?.message ?? String(error) } })
  }
}

/**
 * Stream one auxiliary LLM call as NDJSON frames the client half consumes:
 * `{"t":"delta","text":…}`, `{"t":"done"}`, `{"t":"error","code","message"}`.
 * @param llm - the Host LLM service.
 * @param options - the GenerateOptions to stream.
 * @param label - subject used in abort messages.
 * @returns the streaming response.
 */
function llmNdjsonStream(llm, options, label) {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      let settled = false
      const send = (frame) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`))
        } catch { /* consumer went away */ }
      }
      try {
        for await (const chunk of llm.stream(options)) {
          if (chunk?.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text !== '') {
            send({ t: 'delta', text: chunk.text })
          } else if (chunk?.type === 'finish') {
            settled = true
            const kind = chunk.reason?.kind
            if (kind === 'stop') send({ t: 'done' })
            else if (kind === 'aborted') send({ t: 'error', code: 'ABORTED', message: `${label} aborted` })
            else send({ t: 'error', code: `LLM_${String(kind ?? 'error').toUpperCase().replace(/-/g, '_')}`, message: chunk.reason?.failure?.message ?? String(kind), model: options.model, provider: options.provider })
          }
        }
        if (!settled) send({ t: 'done' })
      } catch (error) {
        send({ t: 'error', code: typeof error?.code === 'string' ? error.code : 'LLM_ERROR', message: error?.message ?? String(error), model: options.model, provider: options.provider })
      } finally {
        try {
          controller.close()
        } catch { /* already closed */ }
      }
    },
  })

  return new Response(stream, { status: 200, headers: { 'content-type': 'application/x-ndjson; charset=utf-8' } })
}

/**
 * Handle one Tab-completion request: the ghost-text continuation at the
 * caret, streamed as NDJSON frames. One short auxiliary call per user pause,
 * cancelled the moment the user keeps typing.
 * @param scope - injected Host services.
 * @param request - the buffered Fetch request the Connection dispatched.
 * @returns the streaming response, or a JSON rejection.
 */
async function handleComplete(scope, request, config, settings) {
  const admission = scope.connection.admit(request)
  if ('rejection' in admission) return json(admission.rejection, { ok: false, error: { code: 'UNAUTHORIZED' } })

  let body
  try {
    body = await request.json()
  } catch {
    return json(400, { ok: false, error: { code: 'BAD_REQUEST', message: 'body must be JSON' } })
  }
  const { sessionId, path, language, prefix, suffix } = body ?? {}
  if (typeof sessionId !== 'string' || sessionId === '') return json(400, { ok: false, error: { code: 'BAD_REQUEST', message: 'sessionId is required' } })
  if (typeof path !== 'string' || path === '') return json(400, { ok: false, error: { code: 'BAD_REQUEST', message: 'path is required' } })
  if (typeof prefix !== 'string' || prefix.trim() === '') return json(400, { ok: false, error: { code: 'BAD_REQUEST', message: 'prefix is required' } })

  const liveSettings = settings?.describe?.({ redactSecrets: false })
    ?.find((entry) => entry.ns === 'code-workbench')?.value
  const preference = (field) => liveSettings?.[field] ?? config?.[field]?.get?.() ?? config?.[field]
  const completionProvider = liveSettings?.completionProvider ?? config?.completionProvider?.get?.() ?? config?.completionProvider
  const completionModel = liveSettings?.completionModel ?? config?.completionModel?.get?.() ?? config?.completionModel
  const selected = scope.get('agentDefaultModel')?.currentSelection()
  const independentApi = preference('completionApiEnabled') === true
  // The independent route has two wire shapes: the framed chat call this
  // plugin started with, and a fill-in-the-middle call that hands the
  // provider the caret's two sides directly. `chat` stays the default so an
  // existing configuration keeps behaving exactly as before.
  const useFim = independentApi && preference('completionApiStyle') === 'fim'
  const route = independentApi
    ? { provider: useFim ? '独立 FIM API' : '独立 API', model: preference('completionApiModel') }
    : completionProvider && completionModel
    ? { provider: completionProvider, model: completionModel }
    : selected
  if (typeof route?.provider !== 'string' || route.provider === '' || typeof route?.model !== 'string' || route.model === '') {
    return json(409, { ok: false, error: { code: 'MODEL_UNAVAILABLE', message: 'no default model is configured' } })
  }

  if (independentApi) {
    try { (useFim ? fimEndpoint : completionEndpoint)(preference('completionBaseUrl')) }
    catch { return json(400, { ok: false, error: { code: 'INVALID_API_URL', message: '请在插件设置中填写有效的补全 API Base URL' } }) }
  }
  const before = prefix.slice(-COMPLETE_CAPS.prefix)
  const after = typeof suffix === 'string' ? suffix.slice(0, COMPLETE_CAPS.suffix) : ''
  // A fill-in-the-middle call needs neither the framing nor the instruction:
  // the provider receives the caret's two sides and returns what belongs
  // between them. The chat shape still frames them as JSON for a model that
  // only understands messages.
  const framed = [
    `File: ${path}${typeof language === 'string' && language !== '' ? ` (${language})` : ''}`,
    '',
    'Context JSON: { before, after }. "before" ends at the caret and "after" starts at it. Output the code to insert between them.',
    JSON.stringify({ before, after }),
  ].join('\n')

  const options = useFim
    ? {
        provider: route.provider,
        model: route.model,
        prompt: before,
        suffix: after,
        maxTokens: COMPLETE_CAPS.maxTokens,
        sessionId,
        signal: request.signal,
      }
    : {
        provider: route.provider,
        model: route.model,
        messages: [{ role: 'user', content: [{ type: 'text', text: framed }] }],
        system: COMPLETE_SYSTEM,
        reasoningEffort: 'off',
        maxTokens: COMPLETE_CAPS.maxTokens,
        sessionId,
        signal: request.signal,
      }

  const llm = useFim
    ? { stream: (requestOptions) => streamCompletionFim({ baseUrl: preference('completionBaseUrl'), apiKey: preference('completionApiKey') }, requestOptions) }
    : independentApi
    ? { stream: (requestOptions) => streamCompletionApi({ baseUrl: preference('completionBaseUrl'), apiKey: preference('completionApiKey') }, requestOptions) }
    : scope.llm
  return llmNdjsonStream(llm, options, `补全模型 ${route.provider} / ${route.model}`)
}

/**
 * Build the line matcher for one search request.
 * @param query - user query text.
 * @param regex - whether `query` is a regular expression.
 * @param caseSensitive - matching case-sensitively.
 * @returns a global RegExp over single lines.
 * @throws SyntaxError when a user regex does not compile.
 */
function buildMatcher(query, regex, caseSensitive) {
  const source = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(source, caseSensitive ? 'g' : 'gi')
}

/**
 * Walk the workspace collecting candidate text files, bounded by the caps so a
 * pathological tree cannot stall the Host.
 * @param scope - injected Host services.
 * @param rootTarget - the workspace root.
 * @param signal - cancellation.
 * @returns the candidate file targets.
 */
async function collectFiles(scope, rootTarget, signal) {
  const files = []
  const queue = [{ target: rootTarget, depth: 0 }]
  while (queue.length > 0 && files.length < SEARCH_CAPS.files) {
    const { target, depth } = queue.shift()
    let entries
    try {
      entries = await scope.fs.listDir(target, signal)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.type === 'directory') {
        if (depth >= SEARCH_CAPS.depth || IGNORED_DIRS.has(entry.name)) continue
        queue.push({ target: entry.target, depth: depth + 1 })
      } else if (entry.type === 'file') {
        const dot = entry.name.lastIndexOf('.')
        if (dot >= 0 && IGNORED_EXT.has(entry.name.slice(dot).toLowerCase())) continue
        if (typeof entry.size === 'number' && entry.size > SEARCH_CAPS.fileBytes) continue
        files.push(entry.target)
      }
    }
  }
  return files
}

/**
 * Run one bounded workspace search.
 * @param scope - injected Host services.
 * @param workspaceRoot - the session workspace root.
 * @param params - `{ query, regex, caseSensitive, limit, mode }`; `mode: 'terms'`
 *   matches lines containing ANY whitespace-separated term (retrieval-style),
 *   the default matches the query as one literal/regex.
 * @param signal - cancellation.
 * @returns the match report.
 */
async function searchWorkspace(scope, workspaceRoot, params, signal) {
  const matchers = params.mode === 'terms'
    ? params.query.split(/\s+/).filter((term) => term !== '').map((term) => buildMatcher(term, false, false))
    : [buildMatcher(params.query, params.regex === true, params.caseSensitive === true)]
  const limit = params.limit
  const started = Date.now()
  const matches = []
  let filesScanned = 0
  let truncated = false
  const rootTarget = await scope.fs.resolve(workspaceRoot)
  const files = await collectFiles(scope, rootTarget, signal)
  for (const target of files) {
    if (Date.now() - started > SEARCH_CAPS.budgetMs) {
      truncated = true
      break
    }
    let text
    try {
      text = await scope.fs.readText(target, signal)
    } catch {
      continue
    }
    filesScanned++
    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line.length > SEARCH_CAPS.lineChars) continue
      let hit = null
      for (const matcher of matchers) {
        matcher.lastIndex = 0
        const candidate = matcher.exec(line)
        if (candidate !== null && (hit === null || candidate.index < hit.index)) hit = candidate
      }
      if (hit === null) continue
      matches.push({
        path: target.displayPath,
        line: i + 1,
        column: hit.index + 1,
        length: hit[0].length,
        text: line.length > 400 ? `${line.slice(0, 400)}…` : line,
      })
      if (matches.length >= limit) {
        truncated = true
        break
      }
    }
    if (truncated) break
  }
  return { matches, truncated, filesScanned, elapsedMs: Date.now() - started }
}

/**
 * Handle one codebase search: bounded walk + line matching. This is the
 * retrieval behind `@codebase`; results are plain
 * `{ path, line, column, length, text }` rows the editor can jump to.
 * @param scope - injected Host services.
 * @param request - the buffered Fetch request the Connection dispatched.
 * @returns the JSON match report.
 */
async function handleSearch(scope, request) {
  const admission = scope.connection.admit(request)
  if ('rejection' in admission) return json(admission.rejection, { ok: false, error: { code: 'UNAUTHORIZED' } })

  let body
  try {
    body = await request.json()
  } catch {
    return json(400, { ok: false, error: { code: 'BAD_REQUEST', message: 'body must be JSON' } })
  }
  const { sessionId, query, regex, caseSensitive, maxMatches } = body ?? {}
  if (typeof sessionId !== 'string' || sessionId === '') return json(400, { ok: false, error: { code: 'BAD_REQUEST', message: 'sessionId is required' } })
  if (typeof query !== 'string' || query.trim() === '') return json(400, { ok: false, error: { code: 'BAD_REQUEST', message: 'query is required' } })
  if (query.length > SEARCH_CAPS.queryChars) return json(413, { ok: false, error: { code: 'TOO_LARGE', message: `query exceeds ${SEARCH_CAPS.queryChars} chars` } })

  try {
    buildMatcher(query, regex === true, caseSensitive === true)
  } catch (error) {
    return json(400, { ok: false, error: { code: 'REGEX_INVALID', message: error?.message ?? 'invalid regular expression' } })
  }

  const session = scope.sessions.get(sessionId)
  const workspaceRoot = session?.header?.cwd ?? scope.get('sandboxPolicy')?.workspaceRoot
  if (typeof workspaceRoot !== 'string' || workspaceRoot === '') {
    return json(404, { ok: false, error: { code: 'UNKNOWN_SESSION', message: 'session has no workspace root' } })
  }

  const limit = typeof maxMatches === 'number' && Number.isInteger(maxMatches) && maxMatches > 0
    ? Math.min(maxMatches, SEARCH_CAPS.matches)
    : SEARCH_CAPS.matches

  try {
    let searchRoot = workspaceRoot
    if (typeof body.directory === 'string' && body.directory !== '') {
      const root = await scope.fs.resolve(workspaceRoot)
      const directory = await scope.fs.resolve(body.directory, { cwd: workspaceRoot })
      if (!scope.fs.contains(root, directory)) return json(403, { ok: false, error: { message: '搜索目录必须位于工作区内' } })
      searchRoot = directory.displayPath
    }
    const report = await searchWorkspace(scope, searchRoot, { query, regex, caseSensitive, limit }, request.signal)
    return json(200, { ok: true, ...report })
  } catch (error) {
    return json(500, { ok: false, error: { code: typeof error?.code === 'string' ? error.code : 'FS_IO_ERROR', message: error?.message ?? String(error) } })
  }
}

/** Rank one search's matches for retrieval: multi-term coverage first. */
function rankMatches(query, matches) {
  const terms = query.toLowerCase().split(/\s+/).filter((term) => term !== '')
  const scored = matches.map((match) => {
    const haystack = `${match.path} ${match.text}`.toLowerCase()
    const score = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0)
    return { ...match, score }
  })
  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line)
  return scored
}

/**
 * The Agent-facing retrieval tool (the `@codebase` tool): ranked snippets for a
 * natural query, complementary to the shipped `grep` (exact regex lines).
 * @param scope - injected Host services.
 * @returns the registry-ready tool definition.
 */
function codebaseSearchTool(scope) {
  return {
    name: 'codebase_search',
    description: 'Ranked codebase retrieval: find the code most relevant to a natural query (e.g. "where is the retry backoff implemented"). Multi-term queries rank snippets that cover more terms higher. Complementary to grep: use this to FIND relevant code, grep for exact patterns.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: {
          type: 'string',
          description: 'What to look for, as words or a phrase. Every term contributes to the ranking.',
        },
        maxResults: {
          type: 'number',
          description: 'Maximum snippets to return (default 8, capped at 30).',
        },
      },
      required: ['query'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          results: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string' },
                line: { type: 'number' },
                score: { type: 'number' },
                text: { type: 'string' },
              },
              required: ['path', 'line', 'text'],
            },
          },
          truncated: { type: 'boolean' },
        },
        required: ['results'],
      },
      render: (args, value) => [{
        type: 'text',
        text: value.results.length === 0
          ? 'No matches.'
          : value.results.map((row) => `${row.path}:${row.line}: ${row.text}`).join('\n'),
      }],
    },
    timeoutMs: 15000,
    async execute(args, exec) {
      const query = typeof args?.query === 'string' ? args.query.trim() : ''
      if (query === '') throw new Error('codebase_search: query is required')
      const limit = typeof args?.maxResults === 'number' && Number.isFinite(args.maxResults)
        ? Math.max(1, Math.min(30, Math.floor(args.maxResults)))
        : 8
      const workspaceRoot = exec.agent?.session?.header?.cwd ?? scope.get('sandboxPolicy')?.workspaceRoot
      if (typeof workspaceRoot !== 'string' || workspaceRoot === '') {
        throw new Error('codebase_search: the session has no workspace root')
      }
      const report = await searchWorkspace(scope, workspaceRoot, {
        query,
        mode: 'terms',
        limit: SEARCH_CAPS.matches,
      }, exec.signal)
      const ranked = rankMatches(query, report.matches).slice(0, limit)
      const prefix = `${workspaceRoot.replace(/[\\/]+$/, '')}`
      return {
        results: ranked.map((row) => ({
          path: row.path.startsWith(prefix) ? row.path.slice(prefix.length).replace(/^[\\/]+/, '') : row.path,
          line: row.line,
          score: row.score,
          text: row.text.trim(),
        })),
        truncated: report.truncated,
      }
    },
  }
}

/**
 * Handle one journal listing: the saves of one file, newest first.
 * @param scope - injected Host services.
 * @param request - the buffered Fetch request the Connection dispatched.
 * @returns the JSON entry list (no file contents).
 */
async function handleHistory(scope, request) {
  const admission = scope.connection.admit(request)
  if ('rejection' in admission) return json(admission.rejection, { ok: false, error: { code: 'UNAUTHORIZED' } })

  let body
  try {
    body = await request.json()
  } catch {
    return json(400, { ok: false, error: { code: 'BAD_REQUEST', message: 'body must be JSON' } })
  }
  const { sessionId, path } = body ?? {}
  if (typeof sessionId !== 'string' || sessionId === '') return json(400, { ok: false, error: { code: 'BAD_REQUEST', message: 'sessionId is required' } })
  if (typeof path !== 'string' || path === '') return json(400, { ok: false, error: { code: 'BAD_REQUEST', message: 'path is required' } })

  const entries = journal.get(`${sessionId}\u0000${path}`) ?? []
  return json(200, {
    ok: true,
    entries: entries.map((entry) => ({
      id: entry.id,
      at: entry.at,
      operation: entry.operation,
      note: entry.note,
      lines: entry.lines,
      rollbackable: entry.before !== null && !entry.beforeTruncated,
    })),
  })
}

/**
 * Handle one rollback: restore the content one save replaced. The rollback is
 * itself journaled, so it is reversible like any other save.
 * @param scope - injected Host services.
 * @param request - the buffered Fetch request the Connection dispatched.
 * @returns the JSON outcome.
 */
async function handleRollback(scope, request) {
  const admission = scope.connection.admit(request)
  if ('rejection' in admission) return json(admission.rejection, { ok: false, error: { code: 'UNAUTHORIZED' } })

  let body
  try {
    body = await request.json()
  } catch {
    return json(400, { ok: false, error: { code: 'BAD_REQUEST', message: 'body must be JSON' } })
  }
  const { sessionId, path, id } = body ?? {}
  if (typeof sessionId !== 'string' || sessionId === '') return json(400, { ok: false, error: { code: 'BAD_REQUEST', message: 'sessionId is required' } })
  if (typeof path !== 'string' || path === '') return json(400, { ok: false, error: { code: 'BAD_REQUEST', message: 'path is required' } })
  if (typeof id !== 'string' || id === '') return json(400, { ok: false, error: { code: 'BAD_REQUEST', message: 'id is required' } })

  const entries = journal.get(`${sessionId}\u0000${path}`) ?? []
  const entry = entries.find((candidate) => candidate.id === id)
  if (entry === undefined) return json(404, { ok: false, error: { code: 'ENTRY_NOT_FOUND', message: 'no such journal entry' } })
  if (entry.before === null || entry.beforeTruncated) {
    return json(409, { ok: false, error: { code: 'NOT_ROLLBACKABLE', message: 'this save has no retained before content' } })
  }

  const session = scope.sessions.get(sessionId)
  const workspaceRoot = session?.header?.cwd ?? scope.get('sandboxPolicy')?.workspaceRoot
  if (typeof workspaceRoot !== 'string' || workspaceRoot === '') {
    return json(404, { ok: false, error: { code: 'UNKNOWN_SESSION', message: 'session has no workspace root' } })
  }

  try {
    const rootTarget = await scope.fs.resolve(workspaceRoot)
    const target = await scope.fs.resolve(path, { cwd: workspaceRoot })
    if (!scope.fs.contains(rootTarget, target)) {
      return json(403, { ok: false, error: { code: 'OUTSIDE_WORKSPACE', message: 'path is outside the session workspace' } })
    }
    const info = await scope.fs.stat(target)
    const intent = info === undefined ? { kind: 'createIfAbsent' } : { kind: 'replaceIfVersion', version: info.version }
    const sandboxPolicy = scope.get('sandboxPolicy')?.resolve({ session })
    const outcome = await scope.fs.writeText(target, entry.before, intent, undefined, sandboxPolicy)
    const note = `回滚：恢复到 ${new Date(entry.at).toISOString()} 保存前的内容`
    journalWrite(sessionId, path, note, outcome, entry.before)
    try {
      scope.get('sessionFeedback')?.record({ sessionId, text: `[code-workbench] ${note}（${path}）` })
    } catch { /* remark is best-effort */ }
    return json(200, { ok: true, version: outcome.version, operation: outcome.operation })
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : 'FS_IO_ERROR'
    const status = code === 'FS_STALE_VERSION' ? 409 : code === 'FS_SANDBOX_DENIED' ? 403 : 500
    return json(status, { ok: false, error: { code, message: error?.message ?? String(error) } })
  }
}

/** Host plugin body: mount the routes and the retrieval tool for the plugin's lifetime. */
async function handleFileOperation(scope, request) {
  const admission = scope.connection.admit(request)
  if ('rejection' in admission) return json(admission.rejection, { ok: false })
  try {
    const body = await request.json()
    if (!['createFile', 'createDirectory', 'rename', 'copy', 'delete'].includes(body.operation) || typeof body.path !== 'string' || typeof body.sessionId !== 'string') return json(400, { ok: false, error: { message: '无效的文件操作' } })
    const session = scope.sessions.get(body.sessionId)
    const cwd = session?.header?.cwd
    if (!cwd) throw new Error('会话没有工作区')
    const policy = scope.get('sandboxPolicy')?.resolve({ session })
    if (!['workspace-write', 'danger-full-access'].includes(policy?.mode)) return json(403, { ok: false, error: { message: '当前会话为只读，无法修改文件；请在对话区将文件权限切换为允许工作区写入后重试' } })
    const root = await scope.fs.resolve(cwd)
    const target = await scope.fs.resolve(body.path, { cwd })
    if (!scope.fs.contains(root, target) || target.targetKey === root.targetKey || target.displayPath === root.displayPath) throw new Error('不允许操作工作区外路径或工作区根目录')
    if (body.operation === 'createFile') await scope.fs.writeText(target, '', { kind: 'createIfAbsent' }, request.signal, policy)
    else if (body.operation === 'createDirectory') await disk.mkdir(target.displayPath)
    else if (body.operation === 'delete') await disk.rm(target.displayPath, { recursive: true })
    else {
      if (typeof body.destination !== 'string') throw new Error('缺少目标路径')
      const destination = await scope.fs.resolve(body.destination, { cwd })
      if (!scope.fs.contains(root, destination) || scope.fs.contains(target, destination)) throw new Error('目标必须在工作区内且不能位于源目录内')
      try { await disk.lstat(destination.displayPath); throw new Error('目标已存在，禁止覆盖') }
      catch (error) { if (error.code !== 'ENOENT') throw error }
      if (body.operation === 'rename') await disk.rename(target.displayPath, destination.displayPath)
      else await disk.cp(target.displayPath, destination.displayPath, { recursive: true, force: false, errorOnExist: true, dereference: false })
    }
    return json(200, { ok: true })
  } catch (error) { return json(400, { ok: false, error: { message: error.message ?? String(error) } }) }
}

export function apply(ctx, config) {
  const runtime = { settings: undefined }
  if (ctx.fiber) {
    ctx.inject(['settings'], (scope) => {
      runtime.settings = scope.settings
      scope.effect(() => scope.settings.configure({ auto: false }, ctx.fiber), 'code-workbench: settings')
    })
  }
  ctx.inject(['connection', 'fs', 'sessions', 'llm', 'tools'], (scope) => {
    scope.effect(() => scope.connection.fetch.register({
      path: '/api/code-workbench/file-operation', methods: ['POST'], requestBody: 'buffered',
      fetch: (request) => handleFileOperation(scope, request),
    }), 'code-workbench: file operations')
    scope.effect(() => scope.connection.fetch.register({
      path: WRITE_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request) => handleWrite(scope, request),
    }), 'code-workbench: POST /api/code-workbench/write')
    scope.effect(() => scope.connection.fetch.register({
      path: COMPLETE_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request) => handleComplete(scope, request, config, runtime.settings),
    }), 'code-workbench: POST /api/code-workbench/complete')
    scope.effect(() => scope.connection.fetch.register({
      path: SEARCH_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request) => handleSearch(scope, request),
    }), 'code-workbench: POST /api/code-workbench/search')
    scope.effect(() => scope.connection.fetch.register({
      path: HISTORY_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request) => handleHistory(scope, request),
    }), 'code-workbench: POST /api/code-workbench/history')
    scope.effect(() => scope.connection.fetch.register({
      path: ROLLBACK_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request) => handleRollback(scope, request),
    }), 'code-workbench: POST /api/code-workbench/rollback')
    scope.effect(() => scope.tools.register(codebaseSearchTool(scope)), 'code-workbench: codebase_search tool')
  })
}
