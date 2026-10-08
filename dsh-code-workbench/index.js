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
import { fimEndpoint, completeFim } from './completion-api.mjs'

/** The endpoint DeepSeek documents for fill-in-the-middle completion. */
const DEFAULT_COMPLETION_BASE_URL = 'https://api.deepseek.com/beta'
/** One of the two models that endpoint accepts. */
const DEFAULT_COMPLETION_MODEL = 'deepseek-flash'

export const Config = z.object({
  autoSave: z.boolean().default(false).volatile(),
  completionEnabled: z.boolean().default(true).volatile(),
  completionBaseUrl: z.string().default(DEFAULT_COMPLETION_BASE_URL).volatile(),
  completionApiKey: z.string().default('').role('secret').volatile(),
  completionApiModel: z.string().default(DEFAULT_COMPLETION_MODEL).volatile(),
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
/** The read-only route reporting which credential the completion route would use. */
const COMPLETION_STATUS_PATH = '/api/code-workbench/completion-status'
/** Caps on one completion request. */
const COMPLETE_CAPS = { prefix: 3200, suffix: 900, maxTokens: 128 }

/**
 * The credential-store reference holding a DeepSeek platform key.
 *
 * `credentialRef` from `@deepseek-ai/dsh-credentials` is an identity function at
 * runtime — it validates the name and returns the same string — so passing the
 * literal keeps this package free of a runtime dependency on that package.
 */
const DEEPSEEK_API_KEY_REF = 'DEEPSEEK_API_KEY'
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
 * Record one skipped or failed completion in the Host log, never in the editor.
 * @param scope - injected Host services.
 * @param reason - why the attempt was skipped.
 * @param error - the underlying failure, when there is one.
 */
function logCompletionFailure(scope, reason, error) {
  const logger = scope?.logger
  if (logger === undefined || typeof logger.warn !== 'function') return
  if (error === undefined) logger.warn('code-workbench: completion skipped — %s', reason)
  else logger.warn('code-workbench: completion skipped — %s (%s)', reason, error?.message ?? String(error))
}

/**
 * The response for a completion this Host declines to attempt: an ordinary
 * success carrying no text, so the editor shows no suggestion and no error.
 *
 * Deliberately the same shape as a real answer rather than an error. This
 * plugin speaks only FIM, so a failure here has no alternative route to fall
 * back to — it is a configuration state rather than something the person
 * typing can act on. The reason goes to the Host log and the settings page
 * instead of into the editor.
 * @param scope - injected Host services, used for the Host-side record.
 * @param reason - why the attempt was skipped.
 * @param error - the underlying failure, when there is one.
 * @returns an empty completion response.
 */
function silentCompletion(scope, reason, error) {
  logCompletionFailure(scope, reason, error)
  return json(200, { ok: true, text: '' })
}

/**
 * Handle one Tab-completion request: the ghost-text continuation at the caret,
 * answered in a single response.
 *
 * Only a malformed request is rejected with JSON, because only that means our
 * own client half is broken. Everything that depends on configuration — an
 * unusable address, no usable credential, the provider refusing — answers with
 * {@link silentCompletion}, leaving the editor quiet.
 * @param scope - injected Host services.
 * @param request - the buffered Fetch request the Connection dispatched.
 * @returns the completion text, or a JSON rejection.
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
  const { sessionId, path, prefix, suffix } = body ?? {}
  if (typeof sessionId !== 'string' || sessionId === '') return json(400, { ok: false, error: { code: 'BAD_REQUEST', message: 'sessionId is required' } })
  if (typeof path !== 'string' || path === '') return json(400, { ok: false, error: { code: 'BAD_REQUEST', message: 'path is required' } })
  if (typeof prefix !== 'string' || prefix.trim() === '') return json(400, { ok: false, error: { code: 'BAD_REQUEST', message: 'prefix is required' } })

  const liveSettings = settings?.describe?.({ redactSecrets: false })
    ?.find((entry) => entry.ns === 'code-workbench')?.value
  const preference = (field) => liveSettings?.[field] ?? config?.[field]?.get?.() ?? config?.[field]
  const baseUrl = preference('completionBaseUrl') || DEFAULT_COMPLETION_BASE_URL
  const model = preference('completionApiModel') || DEFAULT_COMPLETION_MODEL

  let endpoint
  try {
    endpoint = fimEndpoint(baseUrl)
  } catch (error) {
    return silentCompletion(scope, 'the configured base URL is not a usable HTTP(S) address', error)
  }

  const credential = await resolveCompletionCredential(scope, preference, baseUrl)
  if (credential === undefined) return silentCompletion(scope, 'no completion credential is available')

  const upstream = credential.apiKey === undefined
    ? { baseUrl, accountToken: credential.accountToken }
    : { baseUrl, apiKey: credential.apiKey }
  const describe = `${endpoint} · ${model} · 凭据 ${credential.source}`
  try {
    const text = await completeFim(upstream, {
      model,
      prompt: prefix.slice(-COMPLETE_CAPS.prefix),
      suffix: typeof suffix === 'string' ? suffix.slice(0, COMPLETE_CAPS.suffix) : '',
      maxTokens: COMPLETE_CAPS.maxTokens,
      signal: request.signal,
    })
    return json(200, { ok: true, text })
  } catch (error) {
    return silentCompletion(scope, `the provider request failed [${describe}]`, error)
  }
}

/**
 * Resolve the credential for one FIM call, in preference order: the key the
 * person pasted into the settings form, then `DEEPSEEK_API_KEY` in the DSH
 * credential store, then the signed-in account's grant.
 *
 * Every source is optional and none of them is an error — a machine with none
 * simply gets no suggestion. The account half is the interesting one: that
 * service is Host-only, and `resolveToken` returns a value only for the
 * inference origin it trusts, so passing the configured base URL is what
 * performs that check.
 * @param scope - injected Host services.
 * @param preference - reads one live setting.
 * @param baseUrl - the configured endpoint, used for the account origin check.
 * @returns `{source, apiKey}` or `{source, accountToken}`, or undefined.
 */
async function resolveCompletionCredential(scope, preference, baseUrl) {
  const manual = preference('completionApiKey')
  if (typeof manual === 'string' && manual.trim() !== '') return { source: 'manual', apiKey: manual.trim() }

  const credentials = scope.get('credentials')
  if (credentials !== undefined) {
    try {
      const resolved = await credentials.resolve(DEEPSEEK_API_KEY_REF)
      if (typeof resolved?.value === 'string' && resolved.value !== '') return { source: 'store', apiKey: resolved.value }
    } catch { /* an unreadable store must not block the account route */ }
  }

  const account = scope.get('deepseekAccount')
  if (account !== undefined) {
    try {
      const token = await account.resolveToken(baseUrl)
      if (typeof token === 'string' && token !== '') return { source: 'account', accountToken: token }
    } catch { /* signed out, or a destination the account service does not trust */ }
  }

  return undefined
}

/**
 * Where a completion would be sent, and with which credential. The value is
 * never included — only which source it came from — so the settings page can
 * explain a quiet editor without ever handling a secret.
 * @param scope - injected Host services.
 * @param preference - reads one live setting.
 * @returns the status payload the client half renders.
 */
async function completionStatus(scope, preference) {
  const baseUrl = preference('completionBaseUrl') || DEFAULT_COMPLETION_BASE_URL
  const model = preference('completionApiModel') || DEFAULT_COMPLETION_MODEL
  let endpoint = ''
  try {
    endpoint = fimEndpoint(baseUrl)
  } catch {
    return { mode: 'fim', endpoint: '', addressValid: false, model, source: 'none' }
  }
  const credential = await resolveCompletionCredential(scope, preference, baseUrl)
  return { mode: 'fim', endpoint, addressValid: true, model, source: credential?.source ?? 'none' }
}

/**
 * Answer one completion-status read. Read-only: it resolves a credential in
 * order to name its source, and never returns the value.
 * @param scope - injected Host services.
 * @param request - the buffered Fetch request the Connection dispatched.
 * @returns the status payload as JSON.
 */
async function handleCompletionStatus(scope, request, config, settings) {
  const admission = scope.connection.admit(request)
  if ('rejection' in admission) return json(admission.rejection, { ok: false, error: { code: 'UNAUTHORIZED' } })
  const liveSettings = settings?.describe?.({ redactSecrets: false })
    ?.find((entry) => entry.ns === 'code-workbench')?.value
  const preference = (field) => liveSettings?.[field] ?? config?.[field]?.get?.() ?? config?.[field]
  return json(200, { ok: true, ...await completionStatus(scope, preference) })
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
  ctx.inject(['connection', 'fs', 'sessions', 'tools'], (scope) => {
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
      path: COMPLETION_STATUS_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request) => handleCompletionStatus(scope, request, config, runtime.settings),
    }), 'code-workbench: POST /api/code-workbench/completion-status')
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
